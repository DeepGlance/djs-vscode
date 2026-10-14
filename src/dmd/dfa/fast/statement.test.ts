// Tests for src/dmd/dfa/fast/statement.ts (ported from dmd/dfa/fast/statement.d, LDC 1.43.0).
//
// dmd/dfa/fast/statement.d ships no `unittest{}` block (10 §1). These pin, at unit level and without an
// ExpressionWalker (the statements used here never reach it; end-to-end parity is the G4 corpus):
//   1. endScope's label popping, and the ownership protocol around it: a popped label scope is converged (and
//      freed) before the next pop, and the scope a caller destroys goes back on top of the free list;
//   2. the `goto`-reachability search of isBranchTaken (first decisive statement wins, only case bodies of a
//      switch, a try with catches is decisive) and isBranchTakenIf's constant conditions with its `out` reset;
//   3. break / continue: an early exit when the target has no control statement, the jump flag when an inner
//      control statement differs, and the jump recorded on the target;
//   4. a label consuming the state its forward gotos recorded, and runFinalizersUntilScope's inclusive walk;
//   5. start() on small functions: the ParameterDFAInfo slots (slice resize, `.init` overwrite, ids), `out`
//      parameters, and the implicit return that frees the root scope.

import { beforeEach, describe, expect, test } from "vitest";

// FIRST on purpose: this import makes statement.ts the module that enters the graph (01 §4.8).
import { StatementWalker } from "./statement.js";
import { DFAAnalyzer } from "./analysis.js";
import { DFAReporter } from "./report.js";
import { DFACommon, DFAScopeRef, Nullable, Truthiness } from "./structure.js";
import type { DFALatticeRef, DFAScope, Ref } from "./structure.js";
import { Type, TypeFunction, ParameterList } from "../../mtype.js";
import { LINK, STC } from "../../astenums.js";
import { VarDeclaration } from "../../declaration.js";
import { DeclarationExp } from "../../expression.js";
import { FuncDeclaration, ParameterDFAInfo, ParametersDFAInfo } from "../../func.js";
import { Identifier } from "../../identifier.js";
import { Loc } from "../../location.js";
import {
    AsmStatement, BreakStatement, CaseStatement, Catch, CompoundStatement, ContinueStatement, DoStatement,
    ExpStatement, GotoStatement, IfStatement, LabelStatement, ReturnStatement, SwitchStatement, TryCatchStatement,
    TryFinallyStatement,
} from "../../statement.js";
import type { Statement } from "../../statement.js";
import { ErrorSinkNull } from "../../errorsink.js";
import { Array as DArray } from "../../root/array.js";
import { ds } from "../../../dstring.js";
import { initSemaHarness } from "../../../sema-harness.js";

beforeEach(() => {
    initSemaHarness();
});

const id = (name: string): Identifier => Identifier.idPool(ds(name));

function fn(): FuncDeclaration {
    return new FuncDeclaration(Loc.initial, Loc.initial, id("f"), STC.none, null);
}

/** A DFACommon whose function scope (depth 1) is the innermost loopy label, and a walker wired as dfaEntry does. */
function setup(): { c: DFACommon; w: StatementWalker } {
    const c = new DFACommon();
    c.allocator.dfaCommon = c; // entry.d:120
    c.currentFunction = fn();
    c.pushScope();
    c.setScopeAsLoopyLabel();
    const reporter = new DFAReporter();
    reporter.dfaCommon = c;
    reporter.errorSink = new ErrorSinkNull();
    const an = new DFAAnalyzer();
    an.dfaCommon = c;
    an.reporter = reporter;
    const w = new StatementWalker();
    w.dfaCommon = c;
    w.analyzer = an;
    return { c, w };
}

function stmts(...list: Statement[]): DArray<Statement | null> {
    const a = new DArray<Statement | null>();
    for (const s of list)
        a.push(s);
    return a;
}

/** Records forward-goto state for `label`, as a `goto label;` seen before the label does. */
function targetForward(c: DFACommon, label: Identifier): void {
    c.swapForwardLabelScope(label, (old: DFAScopeRef): DFAScopeRef => {
        old.__dtor();
        return new DFAScopeRef();
    });
}

/** A lattice whose context is a constant of the given truthiness. */
function constant(c: DFACommon, truthiness: Truthiness): DFALatticeRef {
    const lr = c.makeLatticeRef();
    lr.acquireConstantAsContextTruthiness(truthiness, Nullable.Unknown, null);
    return lr;
}

describe("endScope (statement.d:80)", () => {
    test("pops label scopes, converging each into its parent, until a non-label scope comes off", () => {
        const { c, w } = setup();
        const root = c.currentDFAScope;
        w.startScope();
        const C = c.currentDFAScope;
        w.startScope();
        const L = c.currentDFAScope!;
        L.label = new LabelStatement(Loc.initial, id("L"), null);
        c.setScopeAsLoopyLabel();
        w.inLoopyLabel = 1;
        expect(c.sdepth).toBe(2);

        const ret = w.endScope();
        expect(ret.sc).toBe(C);
        expect(w.inLoopyLabel).toBe(0);
        expect(c.sdepth).toBe(0);
        expect(c.currentDFAScope).toBe(root);
        expect(c.lastLoopyLabel).toBe(root);

        // The handle the caller destroys puts C on top of the scope free list; L went there before it.
        ret.__dtor();
        c.pushScope();
        expect(c.currentDFAScope).toBe(C);
        c.pushScope();
        expect(c.currentDFAScope).toBe(L);
    });

    test("without label popping the label scope itself is answered", () => {
        const { c, w } = setup();
        w.startScope();
        const L = c.currentDFAScope!;
        L.label = new LabelStatement(Loc.initial, id("L"), null);
        w.inLoopyLabel = 1;

        const ret = w.endScope(Loc.initial, false);
        expect(ret.sc).toBe(L);
        expect(w.inLoopyLabel).toBe(1);
        ret.__dtor();
    });
});

describe("isBranchTaken: can a goto enter the statement (statement.d:1513, :1526)", () => {
    const declares = (): ExpStatement => new ExpStatement(Loc.initial, new DeclarationExp(Loc.initial,
            new VarDeclaration(Loc.initial, Type.tint32, id("v"), null, STC.none)));
    const label = (name: string): LabelStatement => new LabelStatement(Loc.initial, id(name), null);

    test("the first decisive statement answers; a targeted label is the only true answer", () => {
        const { c, w } = setup();
        targetForward(c, id("hit"));

        expect(w.isBranchTakenNoCondition(null)).toBe(false);
        expect(w.isBranchTakenNoCondition(new ExpStatement(Loc.initial, null))).toBe(false);
        expect(w.isBranchTakenNoCondition(label("hit"))).toBe(true);
        expect(w.isBranchTakenNoCondition(label("miss"))).toBe(false);
        // An empty statement is not decisive, the label after it is.
        expect(w.isBranchTakenNoCondition(new CompoundStatement(Loc.initial,
                stmts(new ExpStatement(Loc.initial, null), label("hit"))))).toBe(true);
        // A declaration, or an untargeted label, decides before a later targeted label is seen.
        expect(w.isBranchTakenNoCondition(new CompoundStatement(Loc.initial, stmts(declares(), label("hit")))))
            .toBe(false);
        expect(w.isBranchTakenNoCondition(new CompoundStatement(Loc.initial, stmts(label("miss"), label("hit")))))
            .toBe(false);
    });

    test("a try with catches is decisive after its body; a switch searches only its case bodies", () => {
        const { c, w } = setup();
        targetForward(c, id("hit"));
        const catches = new DArray<Catch | null>();
        catches.push(new Catch(Loc.initial, null, null, null));

        const tryEmpty = new TryCatchStatement(Loc.initial, new ExpStatement(Loc.initial, null), catches);
        expect(w.isBranchTakenNoCondition(tryEmpty)).toBe(false);
        const tryLabel = new TryCatchStatement(Loc.initial, label("hit"), catches);
        expect(w.isBranchTakenNoCondition(tryLabel)).toBe(true);

        const sw = new SwitchStatement(Loc.initial, null, null, label("hit"), false, Loc.initial);
        expect(w.isBranchTakenNoCondition(sw)).toBe(false); // the body itself is not searched
        const cases = new DArray<CaseStatement | null>();
        cases.push(new CaseStatement(Loc.initial, null, label("hit")));
        sw.cases = cases;
        expect(w.isBranchTakenNoCondition(sw)).toBe(true);
    });

    test("with a condition: only a condition known False defers to the goto search", () => {
        const { c, w } = setup();
        targetForward(c, id("hit"));

        expect(w.isBranchTaken(constant(c, Truthiness.False), label("miss"))).toBe(false);
        expect(w.isBranchTaken(constant(c, Truthiness.False), label("hit"))).toBe(true);
        expect(w.isBranchTaken(constant(c, Truthiness.Unknown), label("miss"))).toBe(true);
        expect(w.isBranchTaken(constant(c, Truthiness.True), null)).toBe(false);
    });

    test("isBranchTakenIf resets both out flags; a constant condition takes one branch only", () => {
        const { c, w } = setup();
        targetForward(c, id("hit"));
        const ifs = new IfStatement(Loc.initial, null, null, label("miss"), label("hit"), Loc.initial);
        const forTrue: Ref<boolean> = { value: true };
        const forFalse: Ref<boolean> = { value: true };

        // True: the else body is skipped although a goto targets its label.
        w.isBranchTakenIf(constant(c, Truthiness.True), constant(c, Truthiness.False), ifs, forTrue, forFalse);
        expect([forTrue.value, forFalse.value]).toEqual([true, false]);

        w.isBranchTakenIf(constant(c, Truthiness.False), constant(c, Truthiness.True), ifs, forTrue, forFalse);
        expect([forTrue.value, forFalse.value]).toEqual([false, true]);

        // Unknown: the true branch is taken; the false branch only through the goto search when known False.
        const unknownIfs = new IfStatement(Loc.initial, null, null, label("miss"), label("miss"), Loc.initial);
        w.isBranchTakenIf(constant(c, Truthiness.Unknown), constant(c, Truthiness.False), unknownIfs, forTrue,
                forFalse);
        expect([forTrue.value, forFalse.value]).toEqual([true, false]);
        w.isBranchTakenIf(constant(c, Truthiness.Unknown), constant(c, Truthiness.Maybe), unknownIfs, forTrue,
                forFalse);
        expect([forTrue.value, forFalse.value]).toEqual([true, true]);
    });
});

describe("break and continue (statement.d:1185, :1231)", () => {
    test("a labelled break whose label has no control statement leaves at once", () => {
        const { c, w } = setup();
        w.startScope();
        c.currentDFAScope!.label = new LabelStatement(Loc.initial, id("L"), null);
        const target = c.currentDFAScope!;
        w.startScope();

        w.visitStatement(new BreakStatement(Loc.initial, id("L")));
        expect(c.currentDFAScope!.haveJumped).toBe(false);
        expect(target.beforeScopeState.isNull()).toBe(true);
        expect(c.sdepth).toBe(2); // visitStatement restored it
    });

    test("a different control statement between the jump and its label marks the jump; the target records it", () => {
        const { c, w } = setup();
        w.startScope();
        c.currentDFAScope!.label = new LabelStatement(Loc.initial, id("L"), null);
        c.currentDFAScope!.controlStatement = new DoStatement(Loc.initial, null, null, Loc.initial);
        c.setScopeAsLoopyLabel();
        const target = c.currentDFAScope!;
        w.startScope();
        c.currentDFAScope!.controlStatement = new CaseStatement(Loc.initial, null, null);

        w.visitStatement(new ContinueStatement(Loc.initial, id("L")));
        expect(c.currentDFAScope!.haveJumped).toBe(true);
        expect(target.beforeScopeState.isNull()).toBe(false);
    });

    test("no inner control statement: the jump flag stays clear", () => {
        const { c, w } = setup();
        w.startScope();
        c.currentDFAScope!.controlStatement = new DoStatement(Loc.initial, null, null, Loc.initial);
        c.setScopeAsLoopyLabel();
        const target = c.currentDFAScope!;
        w.startScope();

        w.visitStatement(new BreakStatement(Loc.initial, null));
        expect(c.currentDFAScope!.haveJumped).toBe(false);
        expect(target.beforeScopeState.isNull()).toBe(false);
    });
});

describe("labels, gotos and finalizers (statement.d:828, :1328, :1449)", () => {
    test("a label consumes the state its forward gotos recorded and opens a loopy label scope", () => {
        const { c, w } = setup();
        const L = id("L");
        w.startScope();
        w.visitStatement(new GotoStatement(Loc.initial, L));
        expect(c.currentDFAScope!.haveJumped).toBe(true);
        expect(c.haveForwardLabelState(L)).toBe(true);

        const ls = new LabelStatement(Loc.initial, L, null);
        w.visitStatement(ls);
        expect(w.inLoopyLabel).toBe(1);
        expect(c.currentDFAScope!.label).toBe(ls);
        expect(c.lastLoopyLabel).toBe(c.currentDFAScope);
        expect(c.currentDFAScope!.isLoopyLabelKnownToHaveRun).toBe(true);

        let recorded: boolean | null = null;
        c.swapForwardLabelScope(L, (old: DFAScopeRef): DFAScopeRef => {
            recorded = !old.isNull();
            old.__dtor();
            return new DFAScopeRef();
        });
        expect(recorded).toBe(false); // the label's delegate returned `DFAScopeRef.init`

        // A later backwards goto finds the label scope and records the jump on it.
        w.visitStatement(new GotoStatement(Loc.initial, L));
        expect(c.currentDFAScope!.beforeScopeState.isNull()).toBe(false);
    });

    test("runFinalizersUntilScope walks the finally bodies innermost first, up to and including the target", () => {
        const run = (untilOuter: boolean): string[] => {
            const { c, w } = setup();
            const names = ["outerFinally", "innerFinally"];
            const scopes: DFAScope[] = [];
            for (const name of names) {
                w.startScope();
                c.currentDFAScope!.tryFinallyStatement = new TryFinallyStatement(Loc.initial, null,
                        new GotoStatement(Loc.initial, id(name)));
                scopes.push(c.currentDFAScope!);
            }
            w.startScope();

            w.runFinalizersUntilScope(untilOuter ? scopes[0] : scopes[1]);
            return names.filter((n) => c.haveForwardLabelState(id(n)));
        };

        expect(run(true)).toEqual(["outerFinally", "innerFinally"]);
        expect(run(false)).toEqual(["innerFinally"]);
    });

    test("after a return the rest of the scope is ignored", () => {
        const { c, w } = setup();
        const vd = new VarDeclaration(Loc.initial, Type.tint32, id("x"), null, STC.none);
        vd.parent = c.currentFunction; // a function's local: modellable
        const x = c.findVariable(vd)!;
        expect(x.unmodellable).toBe(false);
        w.startScope();

        w.visitStatement(new ReturnStatement(Loc.initial, null));
        expect(c.currentDFAScope!.haveReturned).toBe(true);
        w.visitStatement(new AsmStatement(Loc.initial, null));
        expect(x.unmodellable).toBe(false);
        expect(c.sdepth).toBe(1);

        c.currentDFAScope!.haveReturned = false;
        w.visitStatement(new AsmStatement(Loc.initial, null));
        expect(x.unmodellable).toBe(true);
    });
});

describe("start (statement.d:373)", () => {
    function walk(fd: FuncDeclaration): { c: DFACommon; w: StatementWalker } {
        const c = new DFACommon();
        c.allocator.dfaCommon = c;
        const reporter = new DFAReporter();
        reporter.dfaCommon = c;
        reporter.errorSink = new ErrorSinkNull();
        const an = new DFAAnalyzer();
        an.dfaCommon = c;
        an.reporter = reporter;
        const w = new StatementWalker();
        w.dfaCommon = c;
        w.analyzer = an;
        w.start(fd);
        return { c, w };
    }

    function func(params: VarDeclaration[]): FuncDeclaration {
        const fd = fn();
        fd.type = new TypeFunction(new ParameterList(null), Type.tvoid, LINK.d);
        fd.fbody = new CompoundStatement(Loc.initial, stmts(new ReturnStatement(Loc.initial, null)));
        if (params.length > 0) {
            fd.parameters = new DArray<VarDeclaration | null>();
            for (const p of params)
                fd.parameters.push(p);
        }
        return fd;
    }

    test("an empty function: the info is created, the root scope is freed, the counters are back to zero", () => {
        const fd = func([]);
        const { c, w } = walk(fd);
        expect(fd.parametersDFAInfo).not.toBeNull();
        expect(fd.parametersDFAInfo!.returnValue.parameterId).toBe(-2);
        expect(fd.parametersDFAInfo!.parameters).toBeNull(); // no parameters: the slice is never touched
        expect(c.currentDFAScope).toBeNull();
        expect(c.sdepth).toBe(0);
        expect(w.inLoopyLabel).toBe(0);
        expect(c.getReturnVariable().isNullable).toBe(false); // void, not by ref
    });

    test("parameters: the slice is resized to the parameter count and each slot is reset to `.init`", () => {
        const p = (name: string, stc: STC): VarDeclaration =>
            new VarDeclaration(Loc.initial, Type.tint32, id(name), null, stc);
        const a = p("a", STC.none), b = p("b", STC.out_);
        const fd = func([a, b]);
        a.parent = fd;
        b.parent = fd;
        const stale: ParameterDFAInfo[] = [];
        for (let i = 0; i < 3; i++) {
            const s = new ParameterDFAInfo();
            s.parameterId = 7;
            s.specifiedByUser = true;
            s.notNullIn = ParameterDFAInfo.Fact.Guaranteed;
            stale.push(s);
        }
        fd.parametersDFAInfo = new ParametersDFAInfo();
        fd.parametersDFAInfo.parameters = stale;

        const { c } = walk(fd);

        const slots = fd.parametersDFAInfo!.parameters!;
        expect(slots.length).toBe(2);
        expect(slots[0]).toBe(stale[0]); // overwritten in place, not replaced
        expect(slots.map((s) => [s.parameterId, s.specifiedByUser, s.notNullIn])).toEqual([
            [0, false, ParameterDFAInfo.Fact.Unspecified], // an int is not nullable: nothing is inferred
            [1, false, ParameterDFAInfo.Fact.Unspecified],
        ]);
        expect(c.findVariable(a)!.isByRef).toBe(false);
        expect(c.findVariable(b)!.isByRef).toBe(true);
        expect(c.findVariable(b)!.param).toBe(slots[1]);
    });
});
