// Tests for src/dmd/dfa/fast/analysis.ts (ported from dmd/dfa/fast/analysis.d, LDC 1.43.0).
//
// dmd/dfa/fast/analysis.d ships no `unittest{}` block (10 §1). These pin, on small hand-built scopes and lattices:
//   1. meet / join of lattices (which fact wins, write counts), reached through convergeStatement, their caller that
//      selects one or the other (meet and join are D `private`, class-local: 10 §1.7), and the ownership protocol
//      around them: both operands are consumed and freed by the callee, left to right, so the next allocation
//      reuses the right-hand lattice first (probed with ldc2: parameters are destroyed left to right);
//   2. the convergence of a popped scope into its parent: convergeScope moves the lattice, and the consumed scope
//      goes back to the free list;
//   3. convergeStatementIf's loop protection, whose DFAPAValue `!=` is member-wise (DFAPAValue has no opEquals);
//   4. the transfer functions whose results are not obvious from the text: `&&`'s maybe chain, `is null` on a
//      known-null pointer, `!` on a boolean, and an assert proven false reaching the reporter.

import { beforeEach, describe, expect, test } from "vitest";

// FIRST on purpose: this import makes analysis.ts the module that enters the graph (01 §4.8).
import { DFAAnalyzer } from "./analysis.js";
import { DFAReporter } from "./report.js";
import { DFACommon, DFALatticeRef, DFAPAValue, DFAScopeRef, Nullable, Truthiness } from "./structure.js";
import type { DFAVar } from "./structure.js";
import { EqualityArgType } from "../utils.js";
import { Type } from "../../mtype.js";
import { STC } from "../../astenums.js";
import { VarDeclaration } from "../../declaration.js";
import { FuncDeclaration } from "../../func.js";
import { Identifier } from "../../identifier.js";
import { Loc } from "../../location.js";
import { ErrorSinkNull } from "../../errorsink.js";
import { dmdformat } from "../../root/dmdformat.js";
import { pointerTo } from "../../typesem.js";
import { cstr, ds, dsToJs } from "../../../dstring.js";
import type { DString } from "../../../dstring.js";
import { initSemaHarness } from "../../../sema-harness.js";

beforeEach(() => {
    initSemaHarness();
});

class Collect extends ErrorSinkNull {
    texts: string[] = [];
    override verror(_loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
        this.texts.push(dsToJs(cstr(dmdformat(format, [...ap]))));
    }
}

/** A DFACommon whose function scope (depth 1) is the innermost loopy label, with an analyzer and a reporter. */
function setup(): { c: DFACommon; an: DFAAnalyzer; sink: Collect } {
    const c = new DFACommon();
    c.allocator.dfaCommon = c; // entry.d:120
    c.pushScope();
    c.setScopeAsLoopyLabel();
    const sink = new Collect();
    const reporter = new DFAReporter();
    reporter.dfaCommon = c;
    reporter.errorSink = sink;
    const an = new DFAAnalyzer();
    an.dfaCommon = c;
    an.reporter = reporter;
    return { c, an, sink };
}

function declared(c: DFACommon, name: string, type: Type, depth = 1): DFAVar {
    const vd = new VarDeclaration(Loc.initial, type, Identifier.idPool(ds(name)), null, STC.none);
    vd.parent = new FuncDeclaration(Loc.initial, Loc.initial, Identifier.idPool(ds("f")), STC.none, null);
    const v = c.findVariable(vd)!;
    v.declaredAtDepth = depth;
    return v;
}

/** A fresh lattice whose context is `v`, with the given nullability. */
function onVar(c: DFACommon, v: DFAVar, nullable: Nullable): DFALatticeRef {
    const lr = c.makeLatticeRef();
    lr.setContextFromDFAVar(v)!.nullable = nullable;
    return lr;
}

/** x declared in the function scope with `parent` nullability, then a child scope where x is `child`; popped. */
function childScope(parent = Nullable.NonNull, child = Nullable.Null):
        { c: DFACommon; an: DFAAnalyzer; x: DFAVar; scr: DFAScopeRef } {
    const { c, an } = setup();
    const x = declared(c, "x", pointerTo(Type.tint32));
    c.acquireScopeVar(x)!.lr.getContext()!.nullable = parent;
    c.pushScope();
    c.acquireScopeVar(x)!.lr.getContext()!.nullable = child;
    return { c, an, x, scr: c.popScope() };
}

describe("meet and join of lattices, through convergeStatement (analysis.d:2402, :2470)", () => {
    test("meet (not all branches taken) takes the lower fact; both operands consumed, the right one freed last", () => {
        const { c, an, x, scr } = childScope();
        const L = c.acquireScopeVar(x)!.lr.lattice, R = scr.findScopeVar(x)!.lr.lattice;

        an.convergeStatement(new DFAScopeRef(scr), false);
        expect(c.acquireScopeVar(x)!.lr.getContext()!.nullable).toBe(Nullable.Null);
        expect(c.allocator.makeLattice(c)).toBe(R); // meet destroys lhs then rhs: rhs is on top of the free list
        expect(c.allocator.makeLattice(c)).toBe(L);
    });

    test("meet of a scope that may not have run makes differing facts Unknown", () => {
        const { c, an, x, scr } = childScope();
        an.convergeStatement(new DFAScopeRef(scr), false, true);
        expect(c.acquireScopeVar(x)!.lr.getContext()!.nullable).toBe(Nullable.Unknown);
    });

    test("join (all branches taken) takes the current right-hand fact, the higher one when write counts are ignored",
        () => {
            const current = childScope();
            current.an.convergeStatement(new DFAScopeRef(current.scr), true);
            expect(current.c.acquireScopeVar(current.x)!.lr.getContext()!.nullable).toBe(Nullable.Null);

            const forced = childScope();
            forced.an.convergeStatement(new DFAScopeRef(forced.scr), true, false, true);
            expect(forced.c.acquireScopeVar(forced.x)!.lr.getContext()!.nullable).toBe(Nullable.NonNull);

            const unknown = childScope(Nullable.NonNull, Nullable.Unknown);
            unknown.an.convergeStatement(new DFAScopeRef(unknown.scr), true, false, true);
            expect(unknown.c.acquireScopeVar(unknown.x)!.lr.getContext()!.nullable).toBe(Nullable.Unknown);
        });
});

describe("convergence of a popped scope (analysis.d:795)", () => {
    test("convergeScope moves the child's lattice into the parent and frees the parent's old one", () => {
        const { c, an, x, scr } = childScope();
        const child = scr.findScopeVar(x)!.lr.lattice;
        const old = c.acquireScopeVar(x)!.lr.lattice;
        const sc = scr.sc;

        an.convergeScope(new DFAScopeRef(scr));
        expect(c.acquireScopeVar(x)!.lr.lattice).toBe(child);
        expect(c.acquireScopeVar(x)!.lr.getContext()!.nullable).toBe(Nullable.Null);
        expect(c.allocator.makeLattice(c)).toBe(old);
        c.pushScope();
        expect(c.currentDFAScope).toBe(sc); // the consumed scope was freed
    });
});

describe("convergeStatementIf (analysis.d:134)", () => {
    /**
     * x (point value 5) declared in the function scope, a loop scope, and a popped else-branch where x's point
     * value is `value`; then `if (cond) {} else {...}` with no true body converges the branch.
     */
    function afterIf(value: bigint): DFAPAValue {
        const { c, an } = setup();
        const x = declared(c, "x", Type.tint32);
        c.acquireScopeVar(x)!.lr.getContext()!.pa = DFAPAValue.fromLong(5n);
        c.pushScope();
        c.setScopeAsLoopyLabel();
        c.pushScope();
        c.acquireScopeVar(x)!.lr.getContext()!.pa = DFAPAValue.fromLong(value);
        const scrFalse = c.popScope();

        an.convergeStatementIf(c.makeLatticeRef(), new DFAScopeRef(), new DFAScopeRef(scrFalse), false, false, 0);
        expect(scrFalse.isNull()).toBe(true); // moved into the callee by the copy constructor (03 §6.6)
        return c.acquireScopeVar(x)!.lr.getContext()!.pa;
    }

    test("inside a loop, a point value the branch changed becomes Unknown (member-wise `!=`, analysis.d:193)", () => {
        const changed = afterIf(6n);
        expect(changed.kind).toBe(DFAPAValue.Kind.Unknown);
        const kept = afterIf(5n);
        expect([kept.kind, kept.value]).toEqual([DFAPAValue.Kind.Concrete, 5n]);
    });
});

describe("transfer functions", () => {
    test("`&&`: a Maybe left side becomes True; the constant chains the maybe-tops, left first", () => {
        const { c, an } = setup();
        const x = declared(c, "x", Type.tbool), y = declared(c, "y", Type.tbool);
        const lhs = c.makeLatticeRef();
        const cx = lhs.setContextFromDFAVar(x)!;
        cx.truthiness = Truthiness.Maybe;
        const rhs = c.makeLatticeRef();
        rhs.setContextFromDFAVar(y)!.truthiness = Truthiness.True;
        const R = rhs.lattice;

        const ret = an.transferLogicalAnd(new DFALatticeRef(lhs), new DFALatticeRef(rhs));
        expect(cx.truthiness).toBe(Truthiness.True); // D writes into the operand before it is consumed
        const k = ret.getContext()!;
        expect([k.var, k.maybe, k.truthiness]).toEqual([null, x, Truthiness.True]);
        expect(ret.findConsequence(x)!.maybe).toBe(y);
        expect(c.allocator.makeLattice(c)).toBe(R);
    });

    test("`x is null` on a known-null pointer is True, and its constant names x as the maybe", () => {
        const { c, an } = setup();
        const x = declared(c, "x", pointerTo(Type.tint32));
        const rhs = c.makeLatticeRef();
        rhs.acquireConstantAsContextTruthiness(Truthiness.False, Nullable.Null, null);

        const ret = an.transferEqual(onVar(c, x, Nullable.Null), new DFALatticeRef(rhs), true, EqualityArgType.Nullable,
            true);
        const k = ret.getContext()!;
        expect([k.var, k.truthiness, k.maybe]).toEqual([null, Truthiness.True, x]);
        expect(ret.findConsequence(x)!.protectElseNegate).toBe(true);
    });

    test("`!b` on a boolean flips it once and hands the context to a Maybe constant naming b", () => {
        const { c, an } = setup();
        const b = declared(c, "b", Type.tbool);
        const lr = c.makeLatticeRef();
        lr.setContextFromDFAVar(b);
        const lattice = lr.lattice;

        const ret = an.transferNegate(new DFALatticeRef(lr), Type.tbool);
        expect(ret.lattice).toBe(lattice); // `return lr;` moves the same lattice out
        const cb = ret.findConsequence(b)!;
        expect([cb.truthiness, cb.invertedOnce]).toEqual([Truthiness.False, true]);
        const k = ret.getContext()!;
        expect([k.var, k.truthiness, k.maybe]).toEqual([null, Truthiness.Maybe, b]);
    });

    test("an assert on a variable known false is reported and records the gate's assert depths", () => {
        const { c, an, sink } = setup();
        const v = declared(c, "c", Type.tint32);
        v.writeCount = 1;
        const lr = c.acquireLattice(v);
        const cv = lr.getContext()!;
        cv.writeOnVarAtThisPoint = 1;
        cv.truthiness = Truthiness.False;

        an.transferAssert(new DFALatticeRef(lr), Loc.singleFilename(ds("fastdfa.d")), false);
        expect(sink.texts).toEqual(["Assert can be proven to be false"]); // fastdfa.d(63)
        const scv = c.acquireScopeVar(v)!;
        expect([scv.assertDepth, scv.assertFalseDepth, v.assertedCount]).toEqual([1, 1, 1]);
        expect(scv.lr.getContext()!.truthiness).toBe(Truthiness.False);
    });
});
