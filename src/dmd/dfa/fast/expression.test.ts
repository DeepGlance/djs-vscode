// Tests for src/dmd/dfa/fast/expression.ts (ported from dmd/dfa/fast/expression.d, LDC 1.43.0).
//
// dmd/dfa/fast/expression.d ships no `unittest{}` block (10 §1). These pin, at unit level on hand-built expressions
// (end-to-end parity is the G4 corpus):
//   1. the ownership protocol at the see* layer: a by-value handle is consumed (null afterwards), and
//      adaptConditionForBranch's replacement lattice is allocated before the old one is freed;
//   2. seeAssign's DFAVar form does not forward `alteredState` (D passes only up to `isBlit`);
//   3. literal facts: an integer's point-analysis value is the literal cast to its type and it is truthy only when
//      > 0 (a negative literal is False, a ulong above long.max is UnknownUpperPositive); `null`;
//   4. walkCondition's `out` predicateNegation: 2 for a plain gate, 1 under `!`, 0 when a sub-expression is not a
//      gate conditional, and 2 for a top-level non-gate expression (the top switch never clears the flag);
//   5. the post-increment keeping the OLD value as the result while the variable takes the new one;
//   6. the scope bracket of `&&` / `||` / `?:` (scopes and edepth come back balanced), a false `&&` operand
//      short-circuiting the right-hand side, and markUnmodellable reaching the operands of a binary expression.
//   7. the `goto case InitKind.void_` of a default-initialized float (expression.d:631): the variable ends unwritten
//      and flagged wasDefaultInitialized, while an explicit initializer is walked and assigned.

import { beforeEach, describe, expect, test } from "vitest";

// FIRST on purpose: this import makes expression.ts the module that enters the graph (01 §4.8).
import { ExpressionWalker } from "./expression.js";
import { StatementWalker } from "./statement.js";
import { DFAAnalyzer } from "./analysis.js";
import { DFAReporter } from "./report.js";
import { DFACommon, DFALatticeRef, DFAPAValue, Nullable, Truthiness } from "./structure.js";
import type { DFAVar, Ref } from "./structure.js";
import { Type } from "../../mtype.js";
import { STC } from "../../astenums.js";
import { EXP } from "../../tokens.js";
import { VarDeclaration } from "../../declaration.js";
import {
    AddExp, CmpExp, CondExp, DeclarationExp, IntegerExp, LogicalExp, NotExp, NullExp, PostExp, RealExp, VarExp,
} from "../../expression.js";
import { ExpInitializer } from "../../init.js";
import type { Expression } from "../../expression.js";
import { FuncDeclaration } from "../../func.js";
import { Identifier } from "../../identifier.js";
import { Loc } from "../../location.js";
import { ErrorSinkNull } from "../../errorsink.js";
import { pointerTo } from "../../typesem.js";
import { ds } from "../../../dstring.js";
import { initSemaHarness } from "../../../sema-harness.js";

beforeEach(() => {
    initSemaHarness();
});

/** A DFACommon with a function scope (depth 1, the innermost loopy label) and the walkers wired as dfaEntry does. */
function setup(): { c: DFACommon; an: DFAAnalyzer; w: ExpressionWalker } {
    const c = new DFACommon();
    c.allocator.dfaCommon = c; // entry.d:120
    c.currentFunction = new FuncDeclaration(Loc.initial, Loc.initial, Identifier.idPool(ds("f")), STC.none, null);
    c.pushScope();
    c.setScopeAsLoopyLabel();
    const reporter = new DFAReporter();
    reporter.dfaCommon = c;
    reporter.errorSink = new ErrorSinkNull();
    const an = new DFAAnalyzer();
    an.dfaCommon = c;
    an.reporter = reporter;
    const sw = new StatementWalker();
    const w = new ExpressionWalker();
    sw.dfaCommon = c;
    w.dfaCommon = c;
    sw.expWalker = w;
    w.stmtWalker = sw;
    sw.analyzer = an;
    w.analyzer = an;
    return { c, an, w };
}

/** A variable of `type` declared in the function scope, initialized (write count 1). */
function declared(c: DFACommon, name: string, type: Type): { vd: VarDeclaration; v: DFAVar } {
    const vd = new VarDeclaration(Loc.initial, type, Identifier.idPool(ds(name)), null, STC.none);
    vd.parent = c.currentFunction;
    const v = c.findVariable(vd)!;
    v.declaredAtDepth = 1;
    v.writeCount = 1;
    return { vd, v };
}

function int(value: bigint, type: Type = Type.tint32): IntegerExp {
    return new IntegerExp(Loc.initial, value, type);
}

function typed<E extends Expression>(e: E, type: Type): E {
    e.type = type;
    return e;
}

/** A lattice whose context is a variable-less constant with the given facts. */
function constant(c: DFACommon, truthiness: Truthiness, nullable = Nullable.Unknown): DFALatticeRef {
    const lr = c.makeLatticeRef();
    lr.acquireConstantAsContextTruthiness(truthiness, nullable, null);
    return lr;
}

describe("ownership at the see* layer", () => {
    test("a by-value handle is consumed by the callee", () => {
        const { c, w } = setup();
        const lhs = constant(c, Truthiness.True);
        const rhs = constant(c, Truthiness.True);
        const r = w.seeLogicalAnd(lhs, rhs);
        expect(lhs.isNull()).toBe(true);
        expect(rhs.isNull()).toBe(true);
        expect(r.isNull()).toBe(false);
    });

    test("adaptConditionForBranch: a null handle becomes an unknown constant", () => {
        const { w } = setup();
        const r = w.adaptConditionForBranch(new DFALatticeRef(), null, true);
        const cctx = r.getContext()!;
        expect(cctx.var).toBe(null);
        expect(cctx.truthiness).toBe(Truthiness.Unknown);
    });

    test("adaptConditionForBranch (false branch, no gate): a fresh constant, the old lattice freed after", () => {
        const { c, w } = setup();
        const lr = constant(c, Truthiness.True);
        const old = lr.lattice;
        const r = w.adaptConditionForBranch(lr, null, false);
        expect(lr.isNull()).toBe(true);
        expect(r.lattice).not.toBe(old);
        expect(r.getContext()!.truthiness).toBe(Truthiness.Unknown);
        // the replacement was allocated before the old lattice was destroyed, so the old one is next on the list
        expect(c.makeLatticeRef().lattice).toBe(old);
    });

    test("adaptConditionForBranch: a nullable context of unknown truthiness is compared with non-null", () => {
        const { c, w } = setup();
        const { v: p } = declared(c, "p", pointerTo(Type.tint32));
        const lr = c.makeLatticeRef();
        lr.setContextFromDFAVar(p);
        const r = w.adaptConditionForBranch(lr, pointerTo(Type.tint32), true);
        expect(r.findConsequence(p)!.nullable).toBe(Nullable.NonNull);
    });
});

describe("seeAssign", () => {
    test("the DFAVar form drops alteredState; the lattice form applies it", () => {
        const { c, w } = setup();
        const { v: p } = declared(c, "p", pointerTo(Type.tint32));

        const viaVar = w.seeAssign(p, false, constant(c, Truthiness.Unknown), Loc.initial, false, 3);
        expect(viaVar.getContext()!.nullable).toBe(Nullable.Unknown);
        expect(viaVar.getContext()!.truthiness).toBe(Truthiness.Unknown);

        const to = c.makeLatticeRef();
        to.setContextFromDFAVar(p);
        const viaLattice = w.seeAssignFromDFALatticeRef(to, false, constant(c, Truthiness.Unknown), Loc.initial,
                false, 3);
        expect(viaLattice.getContext()!.nullable).toBe(Nullable.NonNull);
        expect(viaLattice.getContext()!.truthiness).toBe(Truthiness.True);
    });
});

describe("declaration", () => {
    /** Walks `double <name> = 1.0` declared at `varLoc`, its ExpInitializer at `initLoc`. */
    function declareDouble(c: DFACommon, w: ExpressionWalker, name: string, varLoc: Loc, initLoc: Loc): DFAVar {
        const ei = new ExpInitializer(initLoc, new RealExp(initLoc, 1.0, Type.tfloat64));
        const vd = new VarDeclaration(varLoc, Type.tfloat64, Identifier.idPool(ds(name)), ei, STC.none);
        vd.parent = c.currentFunction;
        w.walk(new DeclarationExp(varLoc, vd)).__dtor();
        return c.findVariable(vd)!;
    }

    function atIndex(index: number): Loc {
        const loc = new Loc();
        loc.index_ = index;
        return loc;
    }

    test("a default-initialized float takes the InitKind.void_ arm: never written, NaN default recorded", () => {
        const { c, w } = setup();
        const loc = atIndex(7);
        const v = declareDouble(c, w, "d", loc, loc); // ExpInitializer loc == var loc (expression.d:622)
        expect(v.wasDefaultInitialized).toBe(true);
        expect(v.writeCount).toBe(0);
        expect(c.acquireScopeVar(v)!.lr.getContext()!.writeOnVarAtThisPoint).toBe(0);
    });

    test("an explicit float initializer is walked and assigned: the write count goes past the declaration's 1", () => {
        const { c, w } = setup();
        const v = declareDouble(c, w, "e", atIndex(7), atIndex(9));
        expect(v.wasDefaultInitialized).toBe(false);
        expect(v.writeCount).toBe(2); // 1 set at the declaration (expression.d:611), +1 by seeWrite
        expect(c.acquireScopeVar(v)!.lr.getContext()!.writeOnVarAtThisPoint).toBe(2);
    });
});

describe("literal facts", () => {
    function literal(e: Expression): { truthiness: Truthiness; pa: DFAPAValue; hasVar: boolean } {
        const { w } = setup();
        const cctx = w.walk(e).getContext()!;
        return { truthiness: cctx.truthiness, pa: cctx.pa, hasVar: cctx.var !== null };
    }

    test("a negative int is False, its value kept signed", () => {
        const r = literal(int(-1n));
        expect(r.truthiness).toBe(Truthiness.False);
        expect(r.pa.kind).toBe(DFAPAValue.Kind.Concrete);
        expect(r.pa.value).toBe(-1n);
        expect(r.hasVar).toBe(false);
    });

    test("a ulong above long.max is UnknownUpperPositive, its value the long bit pattern", () => {
        const r = literal(int(0xFFFF_FFFF_FFFF_FFFFn, Type.tuns64));
        expect(r.pa.kind).toBe(DFAPAValue.Kind.UnknownUpperPositive);
        expect(r.pa.value).toBe(-1n);
        expect(r.truthiness).toBe(Truthiness.False);
    });

    test("bool and char literals", () => {
        const t = literal(int(1n, Type.tbool));
        expect(t.pa.value).toBe(1n);
        expect(t.truthiness).toBe(Truthiness.True);
        const a = literal(int(65n, Type.tchar));
        expect(a.pa.value).toBe(65n);
        expect(a.truthiness).toBe(Truthiness.True);
        expect(literal(int(0n)).truthiness).toBe(Truthiness.False);
    });

    test("null is False, Null, zero", () => {
        const { w } = setup();
        const cctx = w.walk(new NullExp(Loc.initial, Type.tnull)).getContext()!;
        expect(cctx.truthiness).toBe(Truthiness.False);
        expect(cctx.nullable).toBe(Nullable.Null);
        expect(cctx.pa.kind).toBe(DFAPAValue.Kind.Concrete);
        expect(cctx.pa.value).toBe(0n);
    });
});

describe("walkCondition predicateNegation", () => {
    function negation(make: (c: DFACommon) => Expression): number {
        const { c, w } = setup();
        const e = make(c);
        const box: Ref<number> = { value: -1 };
        w.walkCondition(e, box);
        expect(c.edepth).toBe(0);
        return box.value;
    }

    test("a plain gate is 2, under `!` it is 1", () => {
        expect(negation((c) => new VarExp(Loc.initial, declared(c, "b", Type.tbool).vd))).toBe(2);
        expect(negation((c) => typed(new NotExp(Loc.initial, new VarExp(Loc.initial, declared(c, "b", Type.tbool).vd)),
                Type.tbool))).toBe(1);
    });

    test("a non-gate sub-expression makes it 0, but a top-level non-gate expression stays 2", () => {
        const sum = (): Expression => typed(new AddExp(Loc.initial, int(1n), int(2n)), Type.tint32);
        expect(negation(() => typed(new NotExp(Loc.initial, sum()), Type.tbool))).toBe(0);
        expect(negation(() => sum())).toBe(2);
    });
});

describe("math assign", () => {
    test("x++ answers the old value while x takes the new one", () => {
        const { c, w } = setup();
        const { vd, v: x } = declared(c, "x", Type.tint32);
        const five = c.makeLatticeRef();
        five.acquireConstantAsContext().pa = DFAPAValue.fromLong(5n);
        w.seeAssign(x, true, five, Loc.initial).__dtor();

        const r = w.walk(typed(new PostExp(EXP.plusPlus, Loc.initial, new VarExp(Loc.initial, vd)), Type.tint32));
        const cctx = r.getContext()!;
        expect(cctx.var).toBe(null);
        expect(cctx.pa.value).toBe(5n);
        expect(c.acquireLattice(x).getContext()!.pa.value).toBe(6n);
    });
});

describe("scoped expressions", () => {
    test("`0 && b` is False, the right-hand side never walked, scopes balanced", () => {
        const { c, w } = setup();
        const { v: b } = declared(c, "b", Type.tbool);
        const scope = c.currentDFAScope;
        const e = typed(new LogicalExp(Loc.initial, EXP.andAnd, int(0n, Type.tbool),
                new VarExp(Loc.initial, b.var!)), Type.tbool);
        const r = w.walk(e);
        expect(r.getContext()!.truthiness).toBe(Truthiness.False);
        expect(c.currentDFAScope).toBe(scope);
        expect(c.sdepth).toBe(0);
        expect(c.edepth).toBe(0);
    });

    test("`a < 1 || b` and `b ? a : 1` leave scopes and depths balanced", () => {
        const { c, w } = setup();
        const { vd: a } = declared(c, "a", Type.tint32);
        const { vd: b } = declared(c, "b", Type.tbool);
        const scope = c.currentDFAScope;

        const or = typed(new LogicalExp(Loc.initial, EXP.orOr,
                typed(new CmpExp(EXP.lessThan, Loc.initial, new VarExp(Loc.initial, a), int(1n)), Type.tbool),
                new VarExp(Loc.initial, b)), Type.tbool);
        const box: Ref<number> = { value: -1 };
        expect(w.walkCondition(or, box).isNull()).toBe(false);
        expect(box.value).toBe(2);

        const q = typed(new CondExp(Loc.initial, new VarExp(Loc.initial, b), new VarExp(Loc.initial, a), int(1n)),
                Type.tint32);
        expect(w.walk(q).isNull()).toBe(false);

        expect(c.currentDFAScope).toBe(scope);
        expect(c.sdepth).toBe(0);
        expect(c.edepth).toBe(0);
    });

    test("markUnmodellable reaches both operands of a binary expression", () => {
        const { c, w } = setup();
        const { vd: a, v: va } = declared(c, "a", Type.tint32);
        const { vd: b, v: vb } = declared(c, "b", Type.tint32);
        w.markUnmodellable(new AddExp(Loc.initial, new VarExp(Loc.initial, a), new VarExp(Loc.initial, b)));
        expect(va.unmodellable).toBe(true);
        expect(vb.unmodellable).toBe(true);
    });
});
