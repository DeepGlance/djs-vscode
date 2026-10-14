// Ported from dmd/dfa/fast/statement.d (module dmd.dfa.fast.statement).
//
// Statement walker for the fast Data Flow Analysis engine: the AST visitor that handles control flow. It pushes and
// pops DFAScopes as it enters and leaves blocks, splits the state for `if` and `switch`, runs loops once and lets the
// analyzer's loopy-label convergence approximate their fixed point, and resolves `break`, `continue`, `goto` and
// `return`.
//
// TRANSLATION DECISIONS (the structure.ts header holds the struct, allocator and ownership decisions this file
// builds on; analysis.ts's header the analyzer's):
//   - StatementWalker is an `extern (D) class : SemanticTimeTransitiveVisitor` (statement.d:50): a TS class extending
//     the visitor/index.ts class. visitor/index.ts is a load-order root (01 Rule 4.7), so the top-level `extends` is
//     safe in every entry order. `alias visit = SemanticTimeTransitiveVisitor.visit;` is dropped (13 §1) and
//     `override void visit(Statement)` is `visitStatement` (13 §0); every `this.visit(x)` in the file has a
//     `Statement`-typed argument, so each binds visitStatement (13 §4). `final:` and `extern (C++)` are erased.
//   - The three pointer fields (`DFACommon*`, `ExpressionWalker*`, `DFAAnalyzer*`) are class references set by
//     dfaEntry (entry.d:122-130) before `start` and never reassigned; a method reads each one it uses once into a
//     local of the D name (`const dfaCommon = this.dfaCommon!;`), so the body reads as D does. `currentDFAScope` is
//     NOT cached: every D read of `dfaCommon.currentDFAScope` stays a read of the field.
//   - Overload sets inside the class (04 §1): `endScope()` / `endScope(ref Loc, bool = true)` and
//     `seeConvergeStatementLoopyLabels(scr)` / `(scr, ref Loc)` collapse by arity (Form A): each shorter form only
//     calls the longer with a default `Loc` (`Loc.initial`, never mutated: Loc is in the 03 §9.1 register).
//     `isBranchTaken(ref DFALatticeRef, Statement)` / `isBranchTaken(Statement)` are Form B (the one-argument body is
//     not a prefix of the other): the two D forms are called twice each, both in-module, so rule 1 ties; the first
//     declared keeps the bare name, as structure.ts does for opApply, and the other form, which lacks the inserted
//     `condition` parameter, is `isBranchTakenNoCondition` (rule 3).
//   - OWNERSHIP (03 §6.6 and the structure.ts OWNERSHIP PROTOCOL), every DFALatticeRef / DFAScopeRef site:
//       * a by-value handle parameter is destroyed BY THE CALLEE at its exit, after its locals, parameters left to
//         right: a `try`/`finally` around the body. This holds for the by-value `old` of the delegate handed to
//         swapForwardLabelScope (statement.d:858).
//       * an lvalue argument to a by-value parameter is `new X(lvalue)` (the move), evaluated left to right with the
//         other arguments, including the moves out of the DFACaseState fields `jumpedTo` / `containing`; an rvalue
//         argument (a call result, a domain `copy()`) is passed as is. `ref` parameters (seeRead, onRead,
//         isBranchTaken*, seeCheckForCaseBefore's `containing`) get the handle bare.
//       * `x = v` is `x.opAssign(v)` (`caState.containing = this.endScope;` included: the field is readonly).
//       * a call whose handle result D discards (`this.endScope;`, `this.endScopeAndReport(...)` in start) destroys
//         the temporary at the end of the statement: `.__dtor()` on the result. It frees the popped scope, and the
//         free list hands that node to the next pushScope.
//       * `return local;` of the function's own local is NRVO (neither copied nor destroyed); `return
//         DFAScopeRef.init;` is `new DFAScopeRef()`.
//       * a local handle is destroyed at its scope exit, in reverse declaration order: a plain `__dtor()` at the end
//         of a single-exit block, a `try`/`finally` where the scope has several exits (the per-iteration `scr` of
//         UnrolledLoop). A D `case` body is its own scope, so a case's locals die at its `break`. Where the case
//         also has a `scope (exit)` (For, Do, UnrolledLoop: `inLoopyLabel--`), the locals, declared after it, are
//         destroyed first: the `finally` holding the decrement encloses them.
//   - `out` parameters (03 §3.3): `walkCondition`'s `out int` and findSwitchGivenCase's `out DFAScope*` are named
//     `Ref` boxes read back after the call; isBranchTakenIf's two `out bool` are `Ref<boolean>` boxes it resets on
//     entry.
//   - `Loc` (03 §9.1 register) is shared, never copied: `*cast(Loc*)&x.loc` (a const cast) is `x.loc`, and D's
//     `Loc loc;` is `Loc.initial`.
//   - `ref` of a field through a possibly-null class reference: `seeRead(lr, exp.loc)` for an ExpStatement whose
//     `exp` is null (the empty statement) and `seeRead(lrIncrement, fs.increment.loc)` for a `for` without an
//     increment. D forms the reference without loading through the null pointer, and nothing reads it: `walk(null)`
//     answers a null handle and onRead returns before reading `loc` when the handle has no context variable
//     (analysis.d:2164). The TS passes `Loc.initial` when the expression is null (escalation record in the report,
//     for ratification: no guide covers the shape).
//   - `ParameterDFAInfo[] parameters` (func.d) is resized with D slice `length =` semantics: new elements are
//     `ParameterDFAInfo.init`, a shrink truncates. ParametersDFAInfo is reached only through
//     `FuncDeclaration.parametersDFAInfo` (a pointer, never copied), so nothing shares the slice and an in-place
//     resize is observably D's. `*var.param = ParameterDFAInfo.init;` overwrites the element in place (03 §1.1).
//   - `dfaCommon.debugUnknownAST` is the manifest constant hoisted by structure.ts (`debugUnknownAST`, false).
//   - Renamed identifiers (01 §2.3): the D locals `var` -> `var_`, `ds` -> `ds_` (the ds() helper).
//   - DEBUG MACHINERY: `dfaCommon.printStructure(<delegate>)` and `dfaCommon.printIfStructure(<delegate>)` calls are
//     dropped with their delegates (a `// dropped:` line at each site): both run the delegate only under `static if
//     (debugStructure)`, resolved false (structure.ts), and the bodies print raw `%p` addresses; this is the
//     analysis.ts disposition of `dfaCommon.printState`. With them go the `if (fd.parametersDFAInfo !is null)` dump
//     block of start (statement.d:549-566) and `AllStmtOpNames` (statement.d:571), read only by those delegates.
//     The delegate-free debug calls the merged files export (`printStructureln`, the handles' and DFAScope's
//     `printStructure` / `printState`, every `check`) are kept as D writes them: no-ops, resolved in structure.ts.
//     The `version (none)` blocks are dropped. `timeTraceBeginEvent` / `scope (exit) timeTraceEndEvent`
//     (statement.d:383-385) are dropped as at the tree's other timetrace sites (semantic3.ts header): profiling,
//     no semantic effect, no port.

import { assert, assertUnreachable, SwitchError } from "../../../assert.js";
import { ds, dsToJs } from "../../../dstring.js";
import { STC, STMT } from "../../astenums.js";
import { Loc } from "../../location.js";
import { dmdformat } from "../../root/dmdformat.js";
import type { VarDeclaration } from "../../declaration.js";
import type { Expression } from "../../expression.js";
import type { FuncDeclaration } from "../../func.js";
import type { Identifier } from "../../identifier.js";
import type { IfStatement, Statement } from "../../statement.js";
import { SemanticTimeTransitiveVisitor } from "../../visitor/index.js";
import type { DFAAnalyzer } from "./analysis.js";
import type { ExpressionWalker } from "./expression.js";
import type { DFACommon, DFAScope, DFAScopeVar, DFAVar, Ref } from "./structure.js";
import { DFALatticeRef, DFAScopeRef, Nullable, Truthiness, debugUnknownAST } from "./structure.js";
import { isTypeNullable } from "../utils.js";
// last: foreachvar, mtype, typesem and func are in (or enter) the core SCC; structure.js above has already loaded
// it through typesem (01 §4.8).
import { foreachExpAndVar } from "../../visitor/foreachvar.js";
import { Type } from "../../mtype.js";
import { toBasetype } from "../../typesem.js";
import { ParameterDFAInfo, ParametersDFAInfo } from "../../func.js";

/***********************************************************
 * Visits Statement nodes to drive the Data Flow Analysis.
 *
 * This class navigates the structure of the function. When it encounters
 * control flow (like an `if` statement), it acts as a traffic director:
 * 1. It creates a new Scope for the "True" branch.
 * 2. It analyzes that branch.
 * 3. It creates a new Scope for the "False" branch.
 * 4. It analyzes that branch.
 * 5. It calls `analyzer.converge...` to merge the results back together.
 *
 * dmd/dfa/fast/statement.d:50 — `extern (D) class StatementWalker : SemanticTimeTransitiveVisitor`. dfaEntry sets
 * the three pointer fields before calling `start`, and every method dereferences them. `inLoopyLabel` counts the
 * loopy-label scopes (labels and loops) the walk is inside.
 */
export class StatementWalker extends SemanticTimeTransitiveVisitor {
    // dropped: alias visit = SemanticTimeTransitiveVisitor.visit — no overload hiding in TS (13 §1)

    dfaCommon: DFACommon | null = null;
    expWalker: ExpressionWalker | null = null;
    analyzer: DFAAnalyzer | null = null;
    inLoopyLabel = 0;

    /** dmd/dfa/fast/statement.d:61 — `void startScope()`: pushes a child of the current scope, `sdepth + 1`. */
    startScope(): void {
        const dfaCommon = this.dfaCommon!;

        const scr = new DFAScopeRef();
        scr.sc = dfaCommon.currentDFAScope;
        scr.check();
        scr.sc = null;

        dfaCommon.pushScope();
        // dropped: dfaCommon.printStructure (statement.d:69), debug dump (file header)
        dfaCommon.sdepth++;
        scr.__dtor();
    }

    /**
     * dmd/dfa/fast/statement.d:80 — `DFAScopeRef endScope(ref Loc endLoc, bool handleLabelPopping = true)`, with
     * `endScope()` (statement.d:74) collapsed onto it by arity (file header). Pops the current scope and answers it
     * as an owning handle (the caller converges or destroys it), `sdepth - 1`. With `handleLabelPopping`, a popped
     * label scope is first converged into its parent as a loopy label (`inLoopyLabel - 1`) and the next scope is
     * popped, until a non-label scope comes off. `endLoc` is read only by the dropped debug dump.
     */
    endScope(_endLoc: Loc = Loc.initial, handleLabelPopping = true): DFAScopeRef {
        const dfaCommon = this.dfaCommon!;

        const ret = dfaCommon.popScope();
        dfaCommon.sdepth--;

        if (handleLabelPopping) {
            while (ret.sc!.label !== null) {
                const loc = ret.sc!.label!.loc;

                // dropped: dfaCommon.printStructure (statement.d:91), debug dump (file header)

                ret.printStructure(ds("*="), dfaCommon.sdepth, dfaCommon.currentFunction);
                ret.check();

                this.seeConvergeStatementLoopyLabels(new DFAScopeRef(ret), loc);
                this.inLoopyLabel--;

                ret.opAssign(dfaCommon.popScope());
                dfaCommon.sdepth--;
            }
        }

        // dropped: dfaCommon.printStructure (statement.d:110), debug dump (file header)

        ret.printStructure(ds("*="), dfaCommon.sdepth, dfaCommon.currentFunction);
        ret.check();

        dfaCommon.currentDFAScope!.printStructure(ds("parent"), dfaCommon.sdepth, dfaCommon.currentFunction);
        dfaCommon.currentDFAScope!.check();
        return ret;
    }

    /**
     * dmd/dfa/fast/statement.d:126 — `DFAScopeRef endScopeAndReport(ref Loc endLoc, bool endFunction = false)`.
     * Reports the end of the current scope (and, with `endFunction`, of the function) at `endLoc`, then pops like
     * `endScope` with label popping; unlike it, the popped scope may be the function's root (no parent left).
     */
    endScopeAndReport(endLoc: Loc, endFunction = false): DFAScopeRef {
        const dfaCommon = this.dfaCommon!;

        this.analyzer!.reporter!.onEndOfScope(dfaCommon.currentFunction!, endLoc);
        if (endFunction)
            this.analyzer!.reporter!.onEndOfFunction(dfaCommon.currentFunction!, endLoc);

        const ret = dfaCommon.popScope();
        dfaCommon.sdepth--;

        while (ret.sc!.label !== null) {
            const loc = ret.sc!.label!.loc;

            // dropped: dfaCommon.printStructure (statement.d:139), debug dump (file header)

            ret.printStructure(ds("*="), dfaCommon.sdepth, dfaCommon.currentFunction);
            ret.check();

            this.seeConvergeStatementLoopyLabels(new DFAScopeRef(ret), loc);
            this.inLoopyLabel--;

            ret.opAssign(dfaCommon.popScope());
            dfaCommon.sdepth--;
        }

        // dropped: dfaCommon.printStructure (statement.d:157), debug dump (file header)

        ret.printStructure(ds("*="), dfaCommon.sdepth, dfaCommon.currentFunction);
        ret.check();

        if (dfaCommon.currentDFAScope !== null) {
            dfaCommon.currentDFAScope.printStructure(ds("parent"), dfaCommon.sdepth, dfaCommon.currentFunction);
            dfaCommon.currentDFAScope.check();
        }
        return ret;
    }

    /**
     * dmd/dfa/fast/statement.d:176 — `void seeConvergeStatement(DFAScopeRef scr, bool ignoreWriteCount = false,`.
     * Converges `scr` into the current scope as a statement whose branches were all taken. Consumes `scr`.
     */
    seeConvergeStatement(scr: DFAScopeRef, ignoreWriteCount = false, unknownAware = false): void {
        try {
            const dfaCommon = this.dfaCommon!;

            // dropped: dfaCommon.printStructure (statement.d:179), debug dump (file header)
            scr.printStructure(ds("input"), dfaCommon.sdepth, dfaCommon.currentFunction);
            scr.check();

            dfaCommon.check();
            dfaCommon.currentDFAScope!.printStructure(ds("scope"), dfaCommon.sdepth, dfaCommon.currentFunction);
            dfaCommon.check();

            this.analyzer!.convergeStatement(new DFAScopeRef(scr), true, false, ignoreWriteCount, unknownAware);

            dfaCommon.currentDFAScope!.printStructure(ds("so far"), dfaCommon.sdepth, dfaCommon.currentFunction);
            dfaCommon.currentDFAScope!.check();
        } finally {
            scr.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/statement.d:197 — `void seeConvergeScope(DFAScopeRef scr)`: folds the popped child scope `scr`
     * into the current scope (analyzer.convergeScope). Consumes `scr`.
     */
    seeConvergeScope(scr: DFAScopeRef): void {
        try {
            const dfaCommon = this.dfaCommon!;

            // dropped: dfaCommon.printStructure (statement.d:199), debug dump (file header)
            scr.printStructure(ds("input"), dfaCommon.sdepth, dfaCommon.currentFunction);
            scr.check();

            dfaCommon.check();
            dfaCommon.currentDFAScope!.printStructure(ds("scope"), dfaCommon.sdepth, dfaCommon.currentFunction);
            dfaCommon.check();

            this.analyzer!.convergeScope(new DFAScopeRef(scr));

            dfaCommon.currentDFAScope!.printStructure(ds("so far"), dfaCommon.sdepth, dfaCommon.currentFunction);
            dfaCommon.currentDFAScope!.check();
        } finally {
            scr.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/statement.d:216 — `void seeConvergeStatementIf(DFALatticeRef condition, DFAScopeRef scrTrue,`.
     * Merges the two branch scopes of an `if` into the current scope (analyzer.convergeStatementIf). Consumes
     * `condition`, `scrTrue` and `scrFalse`.
     */
    seeConvergeStatementIf(condition: DFALatticeRef, scrTrue: DFAScopeRef, scrFalse: DFAScopeRef,
            haveFalseBody: boolean, unknownBranchTaken: boolean, predicateNegation: number): void {
        try {
            const dfaCommon = this.dfaCommon!;

            // dropped: dfaCommon.printStructure (statement.d:220), debug dump (file header)
            condition.printState(ds("condition"), dfaCommon.sdepth, dfaCommon.currentFunction);
            scrTrue.printStructure(ds("true"), dfaCommon.sdepth, dfaCommon.currentFunction);
            scrFalse.printStructure(ds("false"), dfaCommon.sdepth, dfaCommon.currentFunction);

            dfaCommon.currentDFAScope!.printStructure(ds("scope"), dfaCommon.sdepth, dfaCommon.currentFunction);
            dfaCommon.currentDFAScope!.check();

            dfaCommon.check();
            this.analyzer!.convergeStatementIf(new DFALatticeRef(condition), new DFAScopeRef(scrTrue),
                    new DFAScopeRef(scrFalse), haveFalseBody, unknownBranchTaken, predicateNegation);
            dfaCommon.check();

            dfaCommon.currentDFAScope!.printStructure(ds("so far"), dfaCommon.sdepth, dfaCommon.currentFunction);
            dfaCommon.currentDFAScope!.check();
        } finally {
            condition.__dtor();
            scrTrue.__dtor();
            scrFalse.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/statement.d:241 — `void applyGateOnBranch(DFAVar* gateVar, int predicateNegation, bool branch)`:
     * applies the gate variable's condition to the branch being entered (analyzer.applyGateOnBranch).
     */
    applyGateOnBranch(gateVar: DFAVar | null, predicateNegation: number, branch: boolean): void {
        const dfaCommon = this.dfaCommon!;

        // dropped: dfaCommon.printStructure (statement.d:243), debug dump (file header)

        this.analyzer!.applyGateOnBranch(gateVar, predicateNegation, branch);
        dfaCommon.currentDFAScope!.check();
    }

    /**
     * dmd/dfa/fast/statement.d:257 — `void seeConvergeStatementLoopyLabels(DFAScopeRef scr, ref Loc loc)`, with
     * the one-argument form (statement.d:251) collapsed onto it by arity (file header). Converges the popped loopy
     * label (loop or label) scope `scr` into the current scope (analyzer.convergeStatementLoopyLabels). Consumes
     * `scr`.
     */
    seeConvergeStatementLoopyLabels(scr: DFAScopeRef, loc: Loc = Loc.initial): void {
        try {
            const dfaCommon = this.dfaCommon!;

            // dropped: dfaCommon.printStructure (statement.d:259), debug dump (file header)
            scr.printStructure(ds("input"), dfaCommon.sdepth, dfaCommon.currentFunction);
            scr.check();

            dfaCommon.currentDFAScope!.printStructure(ds("scope"), dfaCommon.sdepth, dfaCommon.currentFunction);
            dfaCommon.currentDFAScope!.check();

            dfaCommon.check();
            this.analyzer!.convergeStatementLoopyLabels(new DFAScopeRef(scr), loc);
            dfaCommon.check();

            dfaCommon.currentDFAScope!.printStructure(ds("so far"), dfaCommon.sdepth, dfaCommon.currentFunction);
            dfaCommon.currentDFAScope!.check();
        } finally {
            scr.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/statement.d:278 — `void seeCheckForCaseBefore(ref DFAScopeRef containing, DFAScopeRef jumpedTo,`.
     * Checks a case's recorded state against the state `goto case` jumps brought to it
     * (analyzer.loopyLabelBeforeContainingCheck). `containing` is by ref; consumes `jumpedTo`.
     */
    seeCheckForCaseBefore(containing: DFAScopeRef, jumpedTo: DFAScopeRef, loc: Loc): void {
        try {
            const dfaCommon = this.dfaCommon!;

            // dropped: dfaCommon.printStructure (statement.d:280), debug dump (file header)

            containing.printStructure(ds("containing"));
            containing.check();

            jumpedTo.printStructure(ds("jumpedTo"));
            jumpedTo.check();

            dfaCommon.check();
            this.analyzer!.loopyLabelBeforeContainingCheck(containing, new DFAScopeRef(jumpedTo), loc);
            dfaCommon.check();
        } finally {
            jumpedTo.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/statement.d:295 — `void seeConvergeForwardGoto(DFAScopeRef scr)`: converges the state forward
     * `goto`s recorded for a label into the current scope, as a statement not all of whose branches were taken.
     * Consumes `scr`.
     */
    seeConvergeForwardGoto(scr: DFAScopeRef): void {
        try {
            const dfaCommon = this.dfaCommon!;

            // dropped: dfaCommon.printStructure (statement.d:297), debug dump (file header)
            scr.printStructure(ds("input"), dfaCommon.sdepth, dfaCommon.currentFunction);
            scr.check();

            dfaCommon.currentDFAScope!.printStructure(ds("scope"), dfaCommon.sdepth, dfaCommon.currentFunction);
            dfaCommon.currentDFAScope!.check();

            dfaCommon.check();
            this.analyzer!.convergeStatement(new DFAScopeRef(scr), false);
            dfaCommon.check();

            dfaCommon.currentDFAScope!.printStructure(ds("so far"), dfaCommon.sdepth, dfaCommon.currentFunction);
            dfaCommon.currentDFAScope!.check();
        } finally {
            scr.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/statement.d:315 — `DFAScopeRef seeLoopyLabelAwareStage(DFAScopeRef previous, DFAScopeRef next)`:
     * merges one more stage (`next`) into the running state `previous` (analyzer.transferLoopyLabelAwareStage) and
     * answers the result. Consumes both.
     */
    seeLoopyLabelAwareStage(previous: DFAScopeRef, next: DFAScopeRef): DFAScopeRef {
        try {
            const dfaCommon = this.dfaCommon!;

            // dropped: dfaCommon.printStructure (statement.d:317), debug dump (file header)
            previous.printStructure(ds("previous"), dfaCommon.sdepth, dfaCommon.currentFunction);
            next.printStructure(ds("next"), dfaCommon.sdepth, dfaCommon.currentFunction);

            dfaCommon.check();
            const ret = this.analyzer!.transferLoopyLabelAwareStage(new DFAScopeRef(previous), new DFAScopeRef(next));
            dfaCommon.check();

            ret.printStructure(ds("result"), dfaCommon.sdepth, dfaCommon.currentFunction);
            return ret;
        } finally {
            previous.__dtor();
            next.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/statement.d:330 — `void seeGoto(DFAScope* toSc, bool isAfter)`: records the current state as a
     * jump to `toSc` (its after-state for a `break`, its before-state otherwise; analyzer.transferGoto).
     */
    seeGoto(toSc: DFAScope, isAfter: boolean): void {
        const dfaCommon = this.dfaCommon!;

        // dropped: dfaCommon.printStructure (statement.d:332), debug dump (file header)

        dfaCommon.check();
        this.analyzer!.transferGoto(toSc, isAfter);
        dfaCommon.check();
    }

    /**
     * dmd/dfa/fast/statement.d:341 — `void seeForwardsGoto(Identifier ident)`: records the current state as a
     * forward jump to the label `ident` (analyzer.transferForwardsGoto).
     */
    seeForwardsGoto(ident: Identifier | null): void {
        const dfaCommon = this.dfaCommon!;

        // dropped: dfaCommon.printStructure (statement.d:343), debug dump (file header)

        dfaCommon.check();
        this.analyzer!.transferForwardsGoto(ident);
        dfaCommon.check();
    }

    /**
     * dmd/dfa/fast/statement.d:351 — `void seeRead(ref DFALatticeRef lr, ref Loc loc)`: the read of `lr`'s context
     * at `loc` (analyzer.onRead). `lr` is by ref (not consumed).
     */
    seeRead(lr: DFALatticeRef, loc: Loc): void {
        const dfaCommon = this.dfaCommon!;

        dfaCommon.printStructureln(ds("Seeing read of lr"));
        lr.printState(ds("read lr"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);

        this.analyzer!.onRead(lr, loc);
    }

    /**
     * dmd/dfa/fast/statement.d:359 — `void constructVariable(VarDeclaration vd, bool isNonNull)`: models the
     * construction of `vd` with a null or non-null value (an initializing assignment converged into the current
     * scope). No D caller.
     */
    constructVariable(vd: VarDeclaration, isNonNull: boolean): void {
        const dfaCommon = this.dfaCommon!;
        const expWalker = this.expWalker!;

        const var_ = dfaCommon.findVariable(vd);

        const lr = dfaCommon.makeLatticeRef();
        const c = lr.addConsequence(var_);
        lr.setContext(c);
        c!.nullable = isNonNull ? Nullable.NonNull : Nullable.Null;

        dfaCommon.check();
        expWalker.seeConvergeExpression(expWalker.seeAssign(var_, true, new DFALatticeRef(lr), vd.loc));
        dfaCommon.check();
        lr.__dtor();
    }

    /**
     * dmd/dfa/fast/statement.d:373 — `void start(FuncDeclaration fd)`: the walk of one function. Opens the
     * function's root scope (a loopy label), declares `this`, the parameters (each bound to its
     * `fd.parametersDFAInfo` slot, created or resized here) and the return variable, marks the variables shared with
     * nested functions and the C / D vararg variables unmodellable, walks the body, then ends the root scope as an
     * implicit return, which reports the end of scope and of function.
     * Preconditions: the three fields are set; no scope is open; `fd` has a body and a TypeFunction type.
     */
    start(fd: FuncDeclaration): void {
        const dfaCommon = this.dfaCommon!;

        dfaCommon.currentFunction = fd;

        // dropped: dfaCommon.printStructure (statement.d:377), debug dump (file header)

        // dropped: `timeTraceBeginEvent(TimeTraceEventType.dfa);` + `scope (exit)
        //          timeTraceEndEvent(TimeTraceEventType.dfa, fd);` (statement.d:383-385), profiling (file header)

        this.startScope();
        dfaCommon.setScopeAsLoopyLabel();

        dfaCommon.check();
        let scv: DFAScopeVar | null = null;

        {
            if (fd.parametersDFAInfo === null)
                fd.parametersDFAInfo = new ParametersDFAInfo();

            if (fd.vthis !== null) {
                const var_ = dfaCommon.findVariable(fd.vthis)!;
                var_.declaredAtDepth = dfaCommon.currentDFAScope!.depth;
                var_.writeCount = 1;
                var_.param = fd.parametersDFAInfo!.thisPointer;
                var_.param.parameterId = -1;
                scv = dfaCommon.acquireScopeVar(var_);

                // dropped: dfaCommon.printStructure (statement.d:406), debug dump (file header)
                assert(scv!.var === var_);

                const scv2 = dfaCommon.currentDFAScope!.findScopeVar(var_);
                assert(scv === scv2);

                dfaCommon.check();
            }

            if (fd.parameters !== null) {
                // D `parameters.length = n` on a slice (file header): grow with `.init` elements, shrink truncates;
                // a null slice has length 0.
                const dfaParams = fd.parametersDFAInfo!.parameters;
                if ((dfaParams === null ? 0 : dfaParams.length) !== fd.parameters.length) {
                    const resized = dfaParams === null ? [] : dfaParams;
                    if (resized.length > fd.parameters.length)
                        resized.length = fd.parameters.length;
                    while (resized.length < fd.parameters.length)
                        resized.push(new ParameterDFAInfo());
                    fd.parametersDFAInfo!.parameters = resized;
                }

                const params = fd.parameters.opSlice();
                for (let i = 0; i < params.length; i++) {
                    const param = params[i]!;
                    const var_ = dfaCommon.findVariable(param)!;
                    var_.declaredAtDepth = dfaCommon.currentDFAScope!.depth;
                    var_.writeCount = 1;
                    var_.param = fd.parametersDFAInfo!.parameters![i];
                    {
                        // `*var.param = ParameterDFAInfo.init;` — overwrites the element in place (03 §1.1)
                        const init = new ParameterDFAInfo(); // Array won't initialize it
                        var_.param.parameterId = init.parameterId;
                        var_.param.notNullIn = init.notNullIn;
                        var_.param.notNullOut = init.notNullOut;
                        var_.param.specifiedByUser = init.specifiedByUser;
                    }
                    var_.param.parameterId = i;
                    scv = dfaCommon.acquireScopeVar(var_);

                    // dropped: dfaCommon.printStructure (statement.d:432), debug dump (file header)
                    assert(scv!.var === var_);

                    const scv2 = dfaCommon.currentDFAScope!.findScopeVar(var_);
                    assert(scv === scv2);

                    var_.isByRef = (param.storage_class & STC.ref_) === STC.ref_;

                    if ((param.storage_class & STC.out_) === STC.out_) {
                        var_.isByRef = true;

                        // blit is effectively a write
                        var_.writeCount = 1;
                    }

                    dfaCommon.check();
                }
            }

            if (fd.v_argptr !== null) {
                // C vararg _argptr
                const var_ = dfaCommon.findVariable(fd.v_argptr)!;
                var_.unmodellable = true;
            }

            if (fd.v_arguments !== null) {
                // D vararg _arguments
                const var_ = dfaCommon.findVariable(fd.v_arguments)!;
                var_.unmodellable = true;
            }
        }

        {
            const var_ = dfaCommon.getReturnVariable();
            var_.declaredAtDepth = dfaCommon.currentDFAScope!.depth;
            var_.writeCount = 1;
            var_.param = fd.parametersDFAInfo!.returnValue;
            var_.param.parameterId = -2;

            const tf = fd.type!.isTypeFunction();
            assert(tf !== null);

            var_.isNullable = tf.isRef || isTypeNullable(tf.next);
            scv = dfaCommon.acquireScopeVar(var_);

            // dropped: dfaCommon.printStructure (statement.d:483), debug dump (file header)
            assert(scv!.var === var_);

            const scv2 = dfaCommon.currentDFAScope!.findScopeVar(var_);
            assert(scv === scv2);

            dfaCommon.check();
        }

        {
            // make any variables that cross the function boundary for nested function unmodelled

            for (const vd of fd.closureVars.opSlice()) {
                const var_ = dfaCommon.findVariable(vd)!;
                var_.unmodellable = true;
                // dropped: dfaCommon.printStructure (statement.d:501), debug dump (file header)
            }

            for (const vd of fd.outerVars.opSlice()) {
                const var_ = dfaCommon.findVariable(vd)!;
                var_.unmodellable = true;

                // dropped: dfaCommon.printStructure (statement.d:513), debug dump (file header)
            }
        }

        this.visitStatement(fd.fbody);

        // implicit return
        // endScope call automatically infers/validates scope on to function.
        dfaCommon.currentDFAScope!.haveJumped = true;
        dfaCommon.currentDFAScope!.haveReturned = true;
        this.endScopeAndReport(fd.endloc, true).__dtor(); // the discarded handle frees the root scope

        // dropped: dfaCommon.printIfStructure (statement.d:529-547), debug dump (file header)
        // dropped: `if (fd.parametersDFAInfo !is null)` + its dfaCommon.printStructure (statement.d:549-566), debug
        //          dump (file header)
    }

    /**
     * dmd/dfa/fast/statement.d:569 — `extern (C++) override void visit(Statement st)`. Walks one statement: the
     * per-kind control-flow model of the file header. A null statement, and any statement reached after the
     * current scope has returned, are ignored. `sdepth` is raised for the walk and restored on every exit.
     */
    override visitStatement(st: Statement | null): void {
        // dropped: `__gshared immutable(string[]) AllStmtOpNames` (statement.d:571), read only by debug dumps

        if (st === null)
            return;

        const dfaCommon = this.dfaCommon!;
        const expWalker = this.expWalker!;
        const analyzer = this.analyzer!;

        dfaCommon.sdepth++;
        dfaCommon.check();

        try {
            if (dfaCommon.currentDFAScope!.haveReturned) {
                // dropped: dfaCommon.printStructure (statement.d:589), debug dump (file header)
                return;
            }

            // dropped: dfaCommon.printStructure (statement.d:597), debug dump (file header)

            // dropped: version (none) state dump (statement.d:609)

            switch (st.stmt) {
                case STMT.DtorExp:
                    expWalker.seeConvergeExpression(expWalker.walk(st.isDtorExpStatement()!.exp));
                    break;

                case STMT.Exp: {
                    const exp = st.isExpStatement()!.exp;

                    const lr = expWalker.walk(exp);
                    this.seeRead(lr, exp !== null ? exp.loc : Loc.initial); // null `exp`: file header
                    expWalker.seeConvergeExpression(new DFALatticeRef(lr));
                    lr.__dtor();
                    break;
                }
                case STMT.Return: {
                    const exp = st.isReturnStatement()!.exp;

                    if (exp !== null) {
                        const lr = expWalker.seeAssign(dfaCommon.getReturnVariable(), true, expWalker.walk(exp),
                                exp.loc);
                        expWalker.seeConvergeExpression(new DFALatticeRef(lr));
                        lr.__dtor();
                    }

                    // Mark the current scope as having returned.
                    // This signals that no code after this point in the current block is reachable.
                    dfaCommon.currentDFAScope!.haveJumped = true;
                    dfaCommon.currentDFAScope!.haveReturned = true;
                    analyzer.reporter!.onEndOfScope(dfaCommon.currentFunction!, st.loc);
                    break;
                }

                case STMT.Compound: {
                    const cs = st.isCompoundStatement()!;
                    if (cs.statements === null)
                        break;

                    // We need to know which statement we are in and what the next ones are
                    // so that we can find labels and run finally statements

                    dfaCommon.printStructureln(ds("Compound statements:"));
                    this.startScope();
                    dfaCommon.currentDFAScope!.compoundStatement = cs;

                    const statements = cs.statements.opSlice();
                    for (let i = 0; i < statements.length; i++) {
                        const st2 = statements[i];
                        dfaCommon.printStructureln(ds("Compound statement:"));
                        dfaCommon.currentDFAScope!.inProgressCompoundStatement = i;
                        this.visitStatement(st2);

                        if (dfaCommon.currentDFAScope!.haveReturned) {
                            dfaCommon.printStructureln(ds("Compound returned"));
                            break;
                        }
                    }

                    const scr = this.endScope();

                    dfaCommon.printStructureln(ds("Compound converge:"));
                    this.seeConvergeScope(new DFAScopeRef(scr));
                    scr.__dtor();
                    break;
                }

                case STMT.If: {
                    const ifs = st.isIfStatement()!;
                    const origScope = dfaCommon.currentDFAScope;

                    // dropped: dfaCommon.printStructure (statement.d:690), debug dump (file header)

                    // CRITICAL: We split the analysis here.
                    // 1. We analyze the condition to see if it implies anything about variables
                    //    (e.g., `if (ptr)` implies `ptr` is NonNull in the true branch).
                    // 2. We visit the `ifbody` with that knowledge.
                    // 3. We visit the `elsebody` (if it exists).
                    // 4. We merge the resulting states from both branches.

                    const takeTrueBranch: Ref<boolean> = { value: false };
                    const takeFalseBranch: Ref<boolean> = { value: false };
                    let unknownBranchTaken = false;

                    dfaCommon.printStructureln(ds("If condition:"));
                    const predicateNegation: Ref<number> = { value: 0 };
                    const conditionLR = new DFALatticeRef();
                    const trueCondition = new DFALatticeRef(), falseCondition = new DFALatticeRef();
                    let conditionVar: DFAVar | null = null;

                    {
                        this.startScope();
                        dfaCommon.currentDFAScope!.sideEffectFree = true;

                        conditionLR.opAssign(expWalker.walkCondition(ifs.condition, predicateNegation));
                        conditionVar = conditionLR.getGateConsequenceVariable();

                        this.seeRead(conditionLR, ifs.condition!.loc);
                        this.endScope().__dtor();
                    }

                    {
                        trueCondition.opAssign(expWalker.adaptConditionForBranch(conditionLR.copy(),
                                ifs.condition!.type, true));
                        falseCondition.opAssign(expWalker.adaptConditionForBranch(conditionLR.copy(),
                                ifs.condition!.type, false));

                        this.isBranchTakenIf(trueCondition, falseCondition, ifs, takeTrueBranch, takeFalseBranch);

                        const cctx = conditionLR.getContext();
                        if (cctx === null || cctx.truthiness <= Truthiness.Maybe)
                            unknownBranchTaken = true;

                        // dropped: version (none) trace (statement.d:736)
                    }

                    {
                        dfaCommon.printStructureln(ds("If true branch:"));
                        this.startScope();
                        dfaCommon.currentDFAScope!.inConditional = true;

                        expWalker.seeSilentAssert(new DFALatticeRef(trueCondition), true, true);
                        this.applyGateOnBranch(conditionVar, predicateNegation.value, true);
                    }

                    const ifbody = new DFAScopeRef(), elsebody = new DFAScopeRef();

                    if (takeTrueBranch.value) {
                        const scs = ifs.ifbody!.isScopeStatement();
                        if (scs !== null)
                            this.visitStatement(scs.statement);
                        else
                            this.visitStatement(ifs.ifbody);

                        assert(dfaCommon.currentDFAScope !== origScope);

                        ifbody.opAssign(this.endScope());
                        ifbody.check();
                    }
                    else {
                        this.endScope().__dtor();
                        // dropped: dfaCommon.printStructure (statement.d:771), debug dump (file header)
                    }

                    assert(dfaCommon.currentDFAScope === origScope);

                    {
                        dfaCommon.printStructureln(ds("If false branch:"));

                        this.startScope();
                        dfaCommon.currentDFAScope!.inConditional = true;

                        // If the true branch can be taken, the false branch needs the condition inverted.
                        // But if it won't be taken, its clearly false already no need to invert.
                        if (takeTrueBranch.value)
                            expWalker.seeSilentAssert(new DFALatticeRef(falseCondition), true, true);

                        this.applyGateOnBranch(conditionVar, predicateNegation.value, false);

                        if (takeFalseBranch.value) {
                            const scs = ifs.elsebody!.isScopeStatement();
                            if (scs !== null)
                                this.visitStatement(scs.statement);
                            else
                                this.visitStatement(ifs.elsebody);
                        }

                        elsebody.opAssign(this.endScope());
                        elsebody.check();
                    }

                    this.seeConvergeStatementIf(new DFALatticeRef(conditionLR), new DFAScopeRef(ifbody),
                            new DFAScopeRef(elsebody), takeFalseBranch.value, unknownBranchTaken,
                            predicateNegation.value);
                    elsebody.__dtor();
                    ifbody.__dtor();
                    falseCondition.__dtor(); // still owns its lattice when the true branch was not taken
                    trueCondition.__dtor();
                    conditionLR.__dtor();
                    break;
                }

                case STMT.Scope: {
                    const sc = st.isScopeStatement()!;

                    // dropped: dfaCommon.printStructure (statement.d:809), debug dump (file header)

                    this.startScope();
                    this.visitStatement(sc.statement);

                    // dropped: dfaCommon.printStructure (statement.d:818), debug dump (file header)

                    const scbody = this.endScope();
                    this.seeConvergeScope(new DFAScopeRef(scbody));
                    scbody.__dtor();
                    break;
                }

                case STMT.Label: {
                    // Note: it is the responsibility of endScope to handle poping these scopes off
                    const ls = st.isLabelStatement()!;
                    // dropped: dfaCommon.printStructure (statement.d:831), debug dump (file header)

                    this.inLoopyLabel++;

                    this.startScope();
                    dfaCommon.currentDFAScope!.label = ls;
                    dfaCommon.setScopeAsLoopyLabel();
                    dfaCommon.currentDFAScope!.isLoopyLabelKnownToHaveRun = true;

                    {
                        // sometimes we can by-pass needing to look up the for loop
                        dfaCommon.currentDFAScope!.controlStatement = ls.gotoTarget !== null
                            ? ls.gotoTarget.isForStatement() : null;

                        if (dfaCommon.currentDFAScope!.controlStatement === null && ls.statement !== null) {
                            if (dfaCommon.currentDFAScope!.controlStatement === null)
                                dfaCommon.currentDFAScope!.controlStatement = ls.statement.isForStatement();
                            if (dfaCommon.currentDFAScope!.controlStatement === null)
                                dfaCommon.currentDFAScope!.controlStatement = ls.statement.isDoStatement();
                            if (dfaCommon.currentDFAScope!.controlStatement === null)
                                dfaCommon.currentDFAScope!.controlStatement = ls.statement.isSwitchStatement();
                        }
                    }

                    dfaCommon.swapForwardLabelScope(ls.ident, (old: DFAScopeRef): DFAScopeRef => {
                        try {
                            if (!old.isNull())
                                this.seeConvergeForwardGoto(new DFAScopeRef(old));
                            return new DFAScopeRef();
                        } finally {
                            old.__dtor(); // the delegate's by-value parameter (file header)
                        }
                    });

                    const scr = new DFAScopeRef();

                    // by-pass scope statement processing with a dedicated variation here.
                    if (ls.statement === null) {
                        // D: an empty branch
                    }
                    else {
                        const scs = ls.statement.isScopeStatement();
                        if (scs !== null) {
                            this.visitStatement(scs.statement);
                            scr.opAssign(this.endScope(ls.loc, false));
                            this.inLoopyLabel--;
                        }
                        else {
                            this.visitStatement(ls.statement);
                        }
                    }

                    if (!scr.isNull())
                        this.seeConvergeStatementLoopyLabels(new DFAScopeRef(scr), ls.loc);
                    scr.__dtor();
                    break;
                }

                case STMT.For: {
                    const fs = st.isForStatement()!;
                    // fs._init should be handled already

                    // dropped: dfaCommon.printStructure (statement.d:889), debug dump (file header)

                    // Loops are handled by creating a "LoopyLabel" scope.
                    // This allows `break` and `continue` statements inside the loop
                    // to find this scope and update the state accordingly.
                    //
                    // Since this is a single-pass engine, we do not iterate until convergence.
                    // Instead, we analyze the body once, and then use `convergeStatementLoopyLabels`
                    // to assume the worst-case scenario for variables modified in the loop.

                    this.inLoopyLabel++;
                    try {
                        let theCondition = fs.condition;
                        let theBody = fs._body;

                        /*
                        Check to see if the for statement is a while loop.
                        for(;true;) {
                            if (condition) {
                                ...
                            } else {
                                break;
                            }
                        }
                        May also be:
                        for(;condition;) {
                            ...
                        }
                        */
                        if (theCondition !== null) {
                            const ie = theCondition.isIntegerExp();

                            if (ie !== null && ie.type === Type.tbool && ie.getInteger() === 1n) {
                                const ifs = theBody!.isIfStatement();

                                if (ifs !== null && ifs.elsebody !== null && ifs.elsebody.isBreakStatement() !== null) {
                                    // Okay this is actually a while loop

                                    theCondition = ifs.condition;
                                    theBody = ifs.ifbody;
                                }
                            }
                        }

                        const lrCondition = new DFALatticeRef();
                        const lrConditionTrue = new DFALatticeRef();

                        if (theCondition !== null) {
                            lrCondition.opAssign(expWalker.walk(theCondition));
                            this.seeRead(lrCondition, theCondition.loc);
                            lrCondition.printStructure(ds("lrCondition"));

                            lrConditionTrue.opAssign(expWalker.adaptConditionForBranch(lrCondition.copy(),
                                    theCondition.type, true));
                            lrConditionTrue.printStructure(ds("lrConditionTrue"));
                        }

                        if (theCondition === null || this.isBranchTaken(lrConditionTrue, theBody)) {
                            this.startScope();
                            dfaCommon.currentDFAScope!.controlStatement = st;
                            dfaCommon.currentDFAScope!.inConditional = true;
                            dfaCommon.setScopeAsLoopyLabel();

                            if (theCondition !== null) {
                                // dropped: dfaCommon.printStructure (statement.d:965), debug dump (file header)

                                const c = lrConditionTrue.getContext();
                                if (c !== null) {
                                    dfaCommon.currentDFAScope!.isLoopyLabelKnownToHaveRun
                                        = c.truthiness === Truthiness.True;
                                }

                                expWalker.seeAssert(new DFALatticeRef(lrConditionTrue), theCondition.loc, true);
                            }
                            else
                                dfaCommon.currentDFAScope!.isLoopyLabelKnownToHaveRun = true;

                            // dropped: dfaCommon.printStructure (statement.d:979), debug dump (file header)
                            this.visitStatement(theBody);

                            if (!dfaCommon.currentDFAScope!.haveJumped) {
                                // dropped: dfaCommon.printStructure (statement.d:985), debug dump (file header)
                                const lrIncrement = expWalker.walk(fs.increment);
                                // null `increment`: file header
                                this.seeRead(lrIncrement, fs.increment !== null ? fs.increment.loc : Loc.initial);
                                expWalker.seeConvergeExpression(new DFALatticeRef(lrIncrement));
                                lrIncrement.__dtor();
                            }

                            const scr = this.endScopeAndReport(fs.endloc);
                            assert(!scr.isNull());
                            this.seeConvergeStatementLoopyLabels(new DFAScopeRef(scr), fs.loc);

                            // dropped: dfaCommon.printStructure (statement.d:996), debug dump (file header)

                            if (theCondition !== null) {
                                const lrConditionFalse = expWalker.adaptConditionForBranch(
                                        new DFALatticeRef(lrCondition), theCondition.type, false);
                                expWalker.seeSilentAssert(new DFALatticeRef(lrConditionFalse), true, true);
                                lrConditionFalse.__dtor();
                            }

                            // dropped: dfaCommon.printStructure (statement.d:1007), debug dump (file header)
                            scr.__dtor();
                        }

                        lrConditionTrue.__dtor();
                        lrCondition.__dtor();
                        break;
                    } finally {
                        this.inLoopyLabel--; // scope (exit)
                    }
                }

                case STMT.Do: {
                    const ds_ = st.isDoStatement()!; // ported: D local `ds` -> ds_ (01 §2.3)

                    this.inLoopyLabel++;
                    try {
                        this.startScope();
                        dfaCommon.currentDFAScope!.controlStatement = st;
                        dfaCommon.setScopeAsLoopyLabel();
                        dfaCommon.currentDFAScope!.isLoopyLabelKnownToHaveRun = true;
                        dfaCommon.currentDFAScope!.inConditional = true;

                        this.visitStatement(ds_._body);

                        const lrCondition = expWalker.walk(ds_.condition);
                        this.seeRead(lrCondition, ds_.condition!.loc);
                        expWalker.seeSilentAssert(new DFALatticeRef(lrCondition), false, true);

                        const scr = this.endScope(ds_.endloc);
                        this.seeConvergeStatementLoopyLabels(new DFAScopeRef(scr), ds_.loc);
                        scr.__dtor();
                        lrCondition.__dtor();
                        break;
                    } finally {
                        this.inLoopyLabel--; // scope (exit)
                    }
                }

                case STMT.UnrolledLoop: {
                    const uls = st.isUnrolledLoopStatement()!;

                    this.inLoopyLabel++;
                    try {
                        if (uls.statements !== null && uls.statements.length > 0) {
                            this.startScope();

                            dfaCommon.currentDFAScope!.controlStatement = st;
                            dfaCommon.setScopeAsLoopyLabel();

                            for (const stmt of uls.statements.opSlice()) {
                                this.startScope();
                                this.visitStatement(stmt);

                                const scr = this.endScope();
                                try {
                                    if (scr.sc!.haveReturned) {
                                        this.seeConvergeScope(new DFAScopeRef(scr));
                                        break;
                                    }
                                    else
                                        this.seeConvergeScope(new DFAScopeRef(scr));
                                } finally {
                                    scr.__dtor();
                                }
                            }

                            const scr = this.endScope();
                            this.seeConvergeStatementLoopyLabels(new DFAScopeRef(scr));
                            scr.__dtor();
                        }

                        break;
                    } finally {
                        this.inLoopyLabel--; // scope (exit)
                    }
                }

                case STMT.Switch: {
                    const ss = st.isSwitchStatement()!;

                    this.startScope();
                    dfaCommon.currentDFAScope!.controlStatement = ss;
                    dfaCommon.currentDFAScope!.inConditional = true;

                    const lrCondition = expWalker.walk(ss.condition);
                    lrCondition.check();
                    this.seeRead(lrCondition, ss.condition!.loc);

                    const oldScope = dfaCommon.currentDFAScope;

                    {
                        // initial pass over the case bodies

                        if (ss.sdefault !== null) {
                            const caState = dfaCommon.acquireCaseState(ss.sdefault);

                            this.startScope();
                            dfaCommon.currentDFAScope!.controlStatement = ss.sdefault;
                            dfaCommon.setScopeAsLoopyLabel();

                            lrCondition.check();
                            const lrCondition2 = lrCondition.copy();
                            lrCondition2.check();
                            expWalker.seeConvergeExpression(new DFALatticeRef(lrCondition2));

                            if (ss.sdefault.statement !== null) {
                                const scs = ss.sdefault.statement.isScopeStatement();
                                if (scs !== null)
                                    this.visitStatement(scs.statement);
                                else
                                    this.visitStatement(ss.sdefault.statement);
                            }

                            caState.containing.opAssign(this.endScope());
                            assert(dfaCommon.currentDFAScope === oldScope);
                            lrCondition2.__dtor();
                        }

                        if (ss.cases !== null) {
                            for (const cs of ss.cases.opSlice()) {
                                const caState = dfaCommon.acquireCaseState(cs);
                                this.startScope();

                                dfaCommon.currentDFAScope!.controlStatement = cs;
                                dfaCommon.setScopeAsLoopyLabel();

                                const equalTo = expWalker.walk(cs!.exp);
                                lrCondition.check();
                                const lrCondition2 = lrCondition.copy();
                                lrCondition2.check();

                                expWalker.seeConvergeExpression(expWalker.seeEqual(new DFALatticeRef(lrCondition2),
                                        new DFALatticeRef(equalTo), true, toBasetype(ss.condition!.type!),
                                        toBasetype(cs!.exp!.type!)));

                                const scs = cs!.statement!.isScopeStatement();
                                if (scs !== null)
                                    this.visitStatement(scs.statement);
                                else
                                    this.visitStatement(cs!.statement);

                                caState.containing.opAssign(this.endScope());
                                assert(dfaCommon.currentDFAScope === oldScope);
                                lrCondition2.__dtor();
                                equalTo.__dtor();
                            }
                        }
                    }

                    {
                        const inProgress = new DFAScopeRef();

                        // now let's make sure that nobody has done something bad wrt. input state

                        if (ss.sdefault !== null) {
                            const caState = dfaCommon.acquireCaseState(ss.sdefault);

                            if (!caState.jumpedTo.isNull()) {
                                this.seeCheckForCaseBefore(caState.containing, new DFAScopeRef(caState.jumpedTo),
                                        ss.sdefault.loc);
                            }

                            inProgress.opAssign(this.seeLoopyLabelAwareStage(new DFAScopeRef(inProgress),
                                    new DFAScopeRef(caState.containing)));
                        }

                        if (ss.cases !== null) {
                            for (const cs of ss.cases.opSlice()) {
                                const caState = dfaCommon.acquireCaseState(cs);

                                if (!caState.jumpedTo.isNull()) {
                                    this.seeCheckForCaseBefore(caState.containing,
                                            new DFAScopeRef(caState.jumpedTo), cs!.loc);
                                }

                                inProgress.opAssign(this.seeLoopyLabelAwareStage(new DFAScopeRef(inProgress),
                                        new DFAScopeRef(caState.containing)));
                            }
                        }

                        if (!inProgress.isNull()) {
                            this.seeConvergeScope(new DFAScopeRef(inProgress));
                        }
                        inProgress.__dtor();
                    }

                    const scr = this.endScope(ss.endloc);
                    this.seeConvergeScope(new DFAScopeRef(scr));
                    scr.__dtor();
                    lrCondition.__dtor(); // never moved: only domain copies were taken of it
                    break;
                }

                case STMT.Continue: {
                    const cs = st.isContinueStatement()!;
                    // dropped: dfaCommon.printStructure (statement.d:1187), debug dump (file header)

                    const sc = dfaCommon.findScopeGivenLabel(cs.ident);
                    assert(sc !== null);

                    if (!debugUnknownAST && sc.controlStatement === null)
                        break;
                    else
                        assert(sc.controlStatement !== null);

                    {
                        // Look for control statements in the scope stack,
                        //  specifically for a control statement that does not match the one for the continue.
                        // This covers things like if statements.
                        let haveParentControlStatement = false;
                        let parentScope = dfaCommon.currentDFAScope!;

                        while (parentScope !== sc) {
                            if (parentScope.controlStatement !== null
                                    && parentScope.controlStatement !== sc.controlStatement) {
                                haveParentControlStatement = true;
                                break;
                            }

                            parentScope = parentScope.parent!;
                        }

                        if (haveParentControlStatement)
                            dfaCommon.currentDFAScope!.haveJumped = true;
                    }

                    const forLoop = sc.controlStatement!.isForStatement();
                    if (forLoop !== null) {
                        const lr = expWalker.walk(forLoop.increment);
                        expWalker.seeConvergeExpression(new DFALatticeRef(lr));
                        lr.__dtor();
                    }

                    this.seeGoto(sc, false);
                    this.runFinalizersUntilScope(sc);
                    break;
                }

                case STMT.Break: {
                    const bs = st.isBreakStatement()!;
                    // dropped: dfaCommon.printStructure (statement.d:1233), debug dump (file header)

                    const sc = dfaCommon.findScopeGivenLabel(bs.ident);
                    assert(sc !== null);

                    if (!debugUnknownAST && sc.controlStatement === null)
                        break;
                    else
                        assert(sc.controlStatement !== null);

                    {
                        // Look for control statements in the scope stack,
                        //  specifically for a control statement that does not match the one for the break.
                        // This covers things like if statements.
                        let haveParentControlStatement = false;
                        let parentScope = dfaCommon.currentDFAScope!;

                        while (parentScope !== sc) {
                            if (parentScope.controlStatement !== null
                                    && parentScope.controlStatement !== sc.controlStatement) {
                                haveParentControlStatement = true;
                                break;
                            }

                            parentScope = parentScope.parent!;
                        }

                        if (haveParentControlStatement)
                            dfaCommon.currentDFAScope!.haveJumped = true;
                    }

                    this.seeGoto(sc, true);
                    this.runFinalizersUntilScope(sc);
                    break;
                }

                case STMT.Case:
                    break; // do nothing, already handled in switch statement

                case STMT.GotoDefault: {
                    const gds = st.isGotoDefaultStatement()!;

                    let targetScope = dfaCommon.findScopeForControlStatement(gds.sw);
                    assert(targetScope !== null);

                    targetScope = targetScope.child; // into the case statement
                    assert(targetScope !== null);
                    assert(targetScope.controlStatement!.isCaseStatement() !== null
                            || targetScope.controlStatement!.isDefaultStatement() !== null);

                    this.runFinalizersUntilScope(targetScope);

                    const caState = dfaCommon.acquireCaseState(gds.sw!.sdefault);
                    caState.jumpedTo.opAssign(this.seeLoopyLabelAwareStage(new DFAScopeRef(caState.jumpedTo),
                            targetScope.copy()));
                    break;
                }

                case STMT.GotoCase: {
                    const gcs = st.isGotoCaseStatement()!;
                    // dropped: dfaCommon.printStructure (statement.d:1294), debug dump (file header)

                    const targetScope: Ref<DFAScope | null> = { value: null };
                    const sw = dfaCommon.findSwitchGivenCase(gcs.cs, targetScope);
                    assert(sw !== null);
                    assert(targetScope.value !== null);

                    this.runFinalizersUntilScope(targetScope.value);

                    const caState = dfaCommon.acquireCaseState(gcs.cs);
                    caState.jumpedTo.opAssign(this.seeLoopyLabelAwareStage(new DFAScopeRef(caState.jumpedTo),
                            targetScope.value.copy()));
                    break;
                }

                case STMT.TryFinally: {
                    const tfs = st.isTryFinallyStatement()!;
                    // dropped: dfaCommon.printStructure (statement.d:1311), debug dump (file header)

                    this.startScope();
                    dfaCommon.currentDFAScope!.tryFinallyStatement = tfs;

                    // normal path execute both
                    this.visitStatement(tfs._body);
                    this.visitStatement(tfs.finalbody);

                    dfaCommon.currentDFAScope!.tryFinallyStatement = null;

                    const scr = this.endScope();
                    this.seeConvergeScope(new DFAScopeRef(scr));
                    scr.__dtor();
                    break;
                }

                case STMT.Goto: {
                    const gs = st.isGotoStatement()!;
                    dfaCommon.currentDFAScope!.haveJumped = true;

                    const sc = dfaCommon.findScopeGivenLabel(gs.ident);

                    if (sc !== null) {
                        // backwards goto
                        this.seeGoto(sc, false);
                    }
                    else
                        this.seeForwardsGoto(gs.ident);
                    break;
                }

                case STMT.Import:
                    break; // do nothing

                case STMT.With: {
                    const ws = st.isWithStatement()!;

                    this.startScope();

                    const lr = expWalker.walk(ws.exp);
                    this.seeRead(lr, ws.exp!.loc);
                    expWalker.seeConvergeExpression(new DFALatticeRef(lr));

                    const ss = ws._body!.isScopeStatement();
                    if (ss !== null)
                        this.visitStatement(ss.statement);
                    else
                        this.visitStatement(ws._body);

                    const scr = this.endScope(ws.endloc);
                    this.seeConvergeScope(new DFAScopeRef(scr));
                    scr.__dtor();
                    lr.__dtor();
                    break;
                }

                case STMT.TryCatch: {
                    // For the initial version we'll visit and then foreach var as unmodellable.
                    const tc = st.isTryCatchStatement()!;

                    this.startScope();
                    this.visitStatement(tc._body);
                    const inProgress = this.endScope();

                    if (tc.catches !== null) {
                        // Mark everything as unmodellable as we have no idea how it effects anything outside the
                        // catch.
                        for (const cat of tc.catches.opSlice()) {
                            this.markUnmodellable(cat!.handler);
                        }
                    }

                    this.seeConvergeScope(new DFAScopeRef(inProgress));
                    inProgress.__dtor();
                    break;
                }

                case STMT.Throw: {
                    const ts = st.isThrowStatement()!;
                    const lr = expWalker.walk(ts.exp);
                    expWalker.seeConvergeExpression(new DFALatticeRef(lr));

                    dfaCommon.currentDFAScope!.haveJumped = true;
                    dfaCommon.currentDFAScope!.haveReturned = true;
                    lr.__dtor();
                    break;
                }

                case STMT.Asm:
                case STMT.InlineAsm:
                case STMT.GccAsm:
                case STMT.CompoundAsm:
                    // All variables that we've seen so far are now unmodellable
                    // no way to know what state they actually are in :(
                    dfaCommon.allocatedVariablesAllUnmodellable();
                    break;

                case STMT.SwitchError:
                case STMT.Pragma:
                case STMT.Error:
                    break; // ignore these

                case STMT.Default:
                case STMT.CompoundDeclaration:
                case STMT.ScopeGuard:
                case STMT.Foreach:
                case STMT.ForeachRange:
                case STMT.Debug:
                case STMT.CaseRange:
                case STMT.StaticForeach:
                case STMT.StaticAssert:
                case STMT.Conditional:
                case STMT.While:
                case STMT.Forwarding:
                case STMT.Mixin:
                case STMT.Peel:
                case STMT.Synchronized:
                    if (debugUnknownAST) {
                        // fprintf(stderr, ...): one assembled stderr write (10 §4.4)
                        process.stderr.write(dsToJs(dmdformat(ds("Unknown DFA walk statement %d\n"), [st.stmt])));
                        assertUnreachable();
                    }
                    else
                        break;

                default: {
                    // final switch: D throws SwitchError on an unhandled value
                    const _exhaustive: never = st.stmt;
                    void _exhaustive;
                    throw new SwitchError();
                }
            }
        } finally {
            dfaCommon.check();
            dfaCommon.sdepth--;
        }
    }

    /**
     * dmd/dfa/fast/statement.d:1432 — `void runFinalizersUntilLabel(Identifier target)`: runs the `finally` bodies
     * between the current scope and the head scope of the label `target` (runFinalizersUntilScope). No D caller.
     */
    runFinalizersUntilLabel(target: Identifier | null): void {
        const targetHeadScope = this.dfaCommon!.findScopeHeadOfLabelStatement(target);

        // dropped: version (none) trace (statement.d:1436)

        this.runFinalizersUntilScope(targetHeadScope);
    }

    /**
     * dmd/dfa/fast/statement.d:1449 — `void runFinalizersUntilScope(DFAScope* targetScope)`: walks the `finally`
     * body of every enclosing try-finally scope, innermost first, from the current scope up to and including
     * `targetScope` (to the root when `targetScope` is not on the chain).
     */
    runFinalizersUntilScope(targetScope: DFAScope | null): void {
        let scv = this.dfaCommon!.currentDFAScope;

        while (scv !== null) {
            if (scv.tryFinallyStatement !== null && scv.tryFinallyStatement.finalbody !== null) {
                this.visitStatement(scv.tryFinallyStatement.finalbody);
            }

            if (scv === targetScope)
                break;
            scv = scv.parent;
        }
    }

    /**
     * dmd/dfa/fast/statement.d:1466 — `void markUnmodellable(Statement s)`: marks every variable `s` declares or
     * whose expressions name it directly unmodellable (a catch handler: its effect outside the catch is unknown).
     */
    markUnmodellable(s: Statement | null): void {
        const perVar = (vd: VarDeclaration): void => {
            const var_ = this.dfaCommon!.findVariable(vd);
            if (var_ !== null)
                var_.unmodellable = true;
        };

        // `&expWalker.markUnmodellable`: a delegate bound to the walker the field points at now.
        const expWalker = this.expWalker!;
        foreachExpAndVar(s, (e: Expression): void => expWalker.markUnmodellable(e), perVar);
    }

    /**
     * Check if a if statement will be branched into by a goto or by the condition
     *
     * dmd/dfa/fast/statement.d:1479 — `void isBranchTakenIf(ref DFALatticeRef trueLR, ref DFALatticeRef falseLR,`.
     * Sets `forTrue` / `forFalse` (D `out bool`, reset on entry): a condition known True takes only the true
     * branch, one known False only the false branch; otherwise each branch is taken unless its condition is known
     * False and no `goto` can enter it (isBranchTaken). A missing body is never taken. Neither lattice is consumed.
     */
    isBranchTakenIf(trueLR: DFALatticeRef, falseLR: DFALatticeRef, ifs: IfStatement, forTrue: Ref<boolean>,
            forFalse: Ref<boolean>): void {
        forTrue.value = false; // `out` parameters reset on entry (03 §3.3)
        forFalse.value = false;

        let cctx = trueLR.getContext();

        if (cctx !== null) {
            if (cctx.truthiness === Truthiness.True) {
                forTrue.value = ifs.ifbody !== null;
                return;
            }
            else if (cctx.truthiness === Truthiness.False) {
                forFalse.value = ifs.elsebody !== null;
                return;
            }
        }

        forTrue.value = this.isBranchTaken(trueLR, ifs.ifbody);

        {
            cctx = falseLR.getContext();

            if (ifs.elsebody === null)
                forFalse.value = false;
            else if (cctx === null || cctx.truthiness !== Truthiness.False)
                forFalse.value = true;
            else
                forFalse.value = this.isBranchTakenNoCondition(ifs.elsebody);
        }
    }

    /**
     * Check if a statement will be branched into either by a goto or by the condition.
     *
     * dmd/dfa/fast/statement.d:1513 — `bool isBranchTaken(ref DFALatticeRef condition, Statement stmt)` (keeps the
     * bare name, file header). False for a null `stmt`; true unless `condition` is known False; otherwise whether a
     * `goto` can enter `stmt` (isBranchTakenNoCondition). `condition` is by ref (not consumed).
     */
    isBranchTaken(condition: DFALatticeRef, stmt: Statement | null): boolean {
        const cctx = condition.getContext();

        if (stmt === null)
            return false;
        else if (cctx === null || cctx.truthiness !== Truthiness.False)
            return true;
        else
            return this.isBranchTakenNoCondition(stmt);
    }

    /**
     * Check if a statement will be branched into either by a goto.
     *
     * dmd/dfa/fast/statement.d:1526 — `bool isBranchTaken(Statement stmt)` (renamed, 04 §1 rule 3: the form without
     * the `condition` parameter). Searches `stmt` in statement order for the first decisive statement: a label some
     * forward `goto` already targets answers true, a label none does, a variable (or attribute) declaration, or a
     * try with catches answers false; nothing decisive answers false. Only the statements of `case`s are searched in
     * a switch, and loop, `with`, try and scope bodies are entered.
     */
    isBranchTakenNoCondition(stmt: Statement | null): boolean {
        if (stmt === null)
            return false;

        const walkExpression = (e: Expression): boolean => {
            const de = e.isDeclarationExp();
            if (de !== null) {
                return de.declaration!.isVarDeclaration() !== null || de.declaration!.isAttribDeclaration() !== null;
            }
            else {
                const be = e.isBinExp();
                if (be !== null)
                    return walkExpression(be.e1!) || walkExpression(be.e2!);
                else {
                    const ue = e.isUnaExp();
                    if (ue !== null)
                        return walkExpression(ue.e1!);
                    else
                        return false;
                }
            }
        };

        const check = (stmt: Statement): number => {
            let ret = -1;

            const attempt = (stmt2: Statement | null): void => {
                if (ret !== -1 || stmt2 === null)
                    return;

                ret = check(stmt2);
            };

            switch (stmt.stmt) {
                case STMT.Exp: {
                    const es = stmt.isExpStatement()!;
                    if (es.exp !== null && walkExpression(es.exp))
                        return 0;
                    return ret;
                }

                case STMT.Compound: {
                    const cs = stmt.isCompoundStatement()!;

                    if (cs.statements !== null) {
                        for (const s of cs.statements.opSlice()) {
                            attempt(s);
                        }
                    }

                    return ret;
                }

                case STMT.UnrolledLoop: {
                    const uls = stmt.isUnrolledLoopStatement()!;

                    if (uls.statements !== null) {
                        for (const s of uls.statements.opSlice()) {
                            attempt(s);
                        }
                    }

                    return ret;
                }

                case STMT.Scope: {
                    const ss = stmt.isScopeStatement()!;
                    attempt(ss.statement);
                    return ret;
                }

                case STMT.Do: {
                    const ds_ = stmt.isDoStatement()!; // ported: D local `ds` -> ds_ (01 §2.3)
                    attempt(ds_._body);
                    return ret;
                }

                case STMT.For: {
                    const fs = stmt.isForStatement()!;
                    attempt(fs._body);
                    return ret;
                }

                case STMT.If: {
                    const ifs = stmt.isIfStatement()!;
                    attempt(ifs.ifbody);
                    attempt(ifs.elsebody);
                    return ret;
                }

                case STMT.Switch: {
                    const ss = stmt.isSwitchStatement()!;

                    if (ss.cases !== null) {
                        for (const c of ss.cases.opSlice()) {
                            attempt(c!.statement);

                            if (ret !== -1)
                                return ret;
                        }
                    }

                    return ret;
                }

                case STMT.With: {
                    const ws = stmt.isWithStatement()!;
                    attempt(ws._body);
                    return ret;
                }

                case STMT.TryCatch: {
                    const tcs = stmt.isTryCatchStatement()!;
                    attempt(tcs._body);

                    if (ret === -1 && tcs.catches !== null && tcs.catches.length > 0)
                        ret = 0; // catch statements have a var declaration
                    return ret;
                }

                case STMT.TryFinally: {
                    const tfs = stmt.isTryFinallyStatement()!;
                    attempt(tfs._body);
                    attempt(tfs.finalbody);
                    return ret;
                }

                case STMT.Label: {
                    const ls = stmt.isLabelStatement()!;
                    return this.dfaCommon!.haveForwardLabelState(ls.ident) ? 1 : 0;
                }

                default:
                    return ret;
            }
        };

        const got = check(stmt);
        if (got === -1)
            return false;
        else
            return got !== 0;
    }
}
