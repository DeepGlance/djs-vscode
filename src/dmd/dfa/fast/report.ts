// Ported from dmd/dfa/fast/report.d (module dmd.dfa.fast.report).
//
// Reporting mechanism for the fast Data Flow Analysis engine: turns the abstract DFA state into compiler errors
// (null dereferences, `out` contracts on parameters, asserts provably false, reads of uninitialized variables).
//
// TRANSLATION DECISIONS:
//   - DFAReporter is a stack local of dfaEntry (entry.d:118) reached through `DFAReporter*` by the analyzer and the
//     walkers: a class reference (03 §0, 02 §10), like DFACommon. It is copyable in D (two pointers), so it exports
//     a field-wise copy() by the 03 §6.3 emission checklist (every copyable D struct, called or not); no D site
//     copies it.
//   - `alias Fact = ParameterDFAInfo.Fact;` (report.d:26) names an enum, so it is both a type and a value in D. The
//     TS type alias carries the type. A value rebinding (`const Fact = ParameterDFAInfo.Fact`) would be a
//     top-level read of a core-SCC binding (01 Rule 4.5), and G4 puts this module inside that SCC (semantic3 ->
//     entry -> fast/*), so value uses spell the member through `ParameterDFAInfo.Fact` inside function bodies.
//   - `dfaCommon.debugUnknownAST` is the manifest constant hoisted by structure.ts (`debugUnknownAST`, false).
//   - `int fail; fail = __LINE__;` in onDereference (report.d:58-71) is written and never read: the local is
//     dropped (TS noUnusedLocals) and each assignment's branch is kept empty with a comment, so the if-chain and
//     its evaluation order are D's.
//   - The `version (none)` debug printers (report.d:125/136/186/268) are dropped; parameters that only they read
//     take the `_` prefix (TS noUnusedParameters).

import { assert } from "../../../assert.js";
import { ds } from "../../../dstring.js";
import { STC } from "../../astenums.js";
import type { ErrorSink } from "../../errorsink.js";
import type { FuncDeclaration } from "../../func.js";
import type { Loc } from "../../location.js";
import type { DFACommon, DFAConsequence, DFALatticeRef, DFAScopeVar, DFAVar } from "./structure.js";
import { Nullable, debugUnknownAST } from "./structure.js";
// last: func.ts is in the core SCC; structure.js above has already loaded it through typesem (01 §4.8).
import { ParameterDFAInfo } from "../../func.js";

/// dmd/dfa/fast/report.d:26 — `alias Fact = ParameterDFAInfo.Fact;` (type side; values: file header).
export type Fact = ParameterDFAInfo.Fact;

/***********************************************************
 * The interface for reporting DFA errors and warnings.
 *
 * This struct acts as the sink for all findings. It checks if a specific
 * violation (like a null dereference) should be reported based on the
 * variable's modellability and depth, then sends it to the global `ErrorSink`.
 *
 * dmd/dfa/fast/report.d:35 — `struct DFAReporter`. Both fields are set by dfaEntry before the walk starts; every
 * method dereferences them (and `dfaCommon.lastLoopyLabel` / `currentDFAScope` where D does).
 */
export class DFAReporter {
    dfaCommon: DFACommon | null = null;
    errorSink: ErrorSink | null = null;

    /***********************************************************
     * Reports an error if a variable is dereferenced while known to be null.
     *
     * This is triggered by expressions like `*ptr` or `ptr.field` when the DFA
     * determines `ptr` has a `Nullable.Null` state.
     *
     * dmd/dfa/fast/report.d:50 — `void onDereference(DFAConsequence* on, ref Loc loc)`. Emits "Dereference on null
     * variable `<name>`" at `loc` when the variable is modellable and declared at or below the innermost loopy
     * label's depth. Preconditions: `on` is non-null and not known NonNull (asserted).
     *
     * Params:
     *      on = The consequence containing the variable state (must be Nullable).
     *      loc = The source location of the dereference.
     */
    onDereference(on: DFAConsequence | null, loc: Loc): void {
        if (!debugUnknownAST && on === null)
            return;
        assert(on !== null);
        if (on.var === null)
            return;

        assert(on.nullable !== Nullable.NonNull);

        if (on.var === null || on.var.var === null) {
            // D: `fail = __LINE__;` (report.d:62), never read (file header)
        }
        else if (!on.var.isModellable()) {
            // D: `fail = __LINE__;` (report.d:64), never read (file header)
        }
        else {
            if (on.var.declaredAtDepth >= this.dfaCommon!.lastLoopyLabel!.depth)
                this.errorSink!.error(loc, ds("Dereference on null variable `%s`"),
                        on.var.var.ident!.toChars());
            else {
                // D: `fail = __LINE__;` (report.d:71), never read (file header)
            }
        }
    }

    /**
     * dmd/dfa/fast/report.d:75 — `void onLoopyLabelLessNullThan(DFAVar* var, ref const Loc loc)`. Emits "Variable
     * `<name>` was required to be non-null and has become null" at `loc` unless `var` is unmodellable. A null `var`
     * faults, as in D.
     */
    onLoopyLabelLessNullThan(var_: DFAVar | null, loc: Loc): void {
        if (var_ !== null && !var_.isModellable())
            return;

        this.errorSink!.error(loc, ds("Variable `%s` was required to be non-null and has become null"),
                var_!.var!.ident!.toChars());
    }

    /***********************************************************
     * Validates constraints at the end of a scope.
     *
     * This checks if output parameters (like `out` or `ref` parameters) meet their
     * guaranteed post-conditions. For example, if a function parameter is marked
     * to guarantee a non-null output, this ensures the variable is actually non-null
     * when the scope exits.
     *
     * dmd/dfa/fast/report.d:92 — `void onEndOfScope(FuncDeclaration fd, ref const Loc loc)`. Only after the current
     * scope has returned: for `this`, the return value and each parameter with DFA info, downgrades an inferred
     * `notNullOut` of Guaranteed that no longer holds and upgrades an Unspecified one that does. No diagnostic.
     */
    onEndOfScope(fd: FuncDeclaration, _loc: Loc): void {
        // this is where we validate escapes, for a specific location

        if (!this.dfaCommon!.currentDFAScope!.haveReturned)
            return;

        // validate/infer on to function
        foreachFunctionVariable(this.dfaCommon!, fd, (scv: DFAScopeVar | null): void => {
            const param = scv!.var!.param;

            if (scv!.var!.unmodellable || param === null)
                return;

            const cctx = scv!.lr.getContext();

            assert(cctx !== null);
            assert(cctx.var === scv!.var);

            let suggestedNotNullOut = param.notNullOut;

            if (suggestedNotNullOut === ParameterDFAInfo.Fact.Guaranteed && cctx.nullable !== Nullable.NonNull)
                suggestedNotNullOut = ParameterDFAInfo.Fact.NotGuaranteed;
            else if (suggestedNotNullOut === ParameterDFAInfo.Fact.Unspecified && cctx.nullable === Nullable.NonNull)
                suggestedNotNullOut = ParameterDFAInfo.Fact.Guaranteed;

            assert(!param.specifiedByUser);
            param.notNullOut = suggestedNotNullOut;
        });
    }

    /**
     * dmd/dfa/fast/report.d:123 — `void onEndOfFunction(FuncDeclaration fd, ref Loc loc)`. Infers the DFA facts of
     * `this`, the return value and each parameter not specified by the user: an unmodellable nullable one is reset
     * to Unspecified; a modellable nullable one gets `notNullIn` NotGuaranteed when unspecified, and `notNullOut`
     * from its by-ref write count (NotGuaranteed after more than one write, else `notNullIn`) or Unspecified when
     * not by ref. No diagnostic.
     */
    onEndOfFunction(fd: FuncDeclaration, _loc: Loc): void {
        // dropped: version (none) trace (report.d:125)

        // validate/infer on to function
        foreachFunctionVariable(this.dfaCommon!, fd, (scv: DFAScopeVar | null): void => {
            const param = scv!.var!.param;
            if (param === null)
                return;

            // dropped: version (none) trace (report.d:136)

            if (scv!.var!.unmodellable) {
                if (!param.specifiedByUser) {
                    param.specifiedByUser = false;

                    if (scv!.var!.isNullable) {
                        param.notNullIn = ParameterDFAInfo.Fact.Unspecified;
                        param.notNullOut = ParameterDFAInfo.Fact.Unspecified;
                    }
                }
            }
            else if (!param.specifiedByUser) {
                if (scv!.var!.isNullable) {
                    if (param.notNullIn === ParameterDFAInfo.Fact.Unspecified)
                        param.notNullIn = ParameterDFAInfo.Fact.NotGuaranteed;

                    if (scv!.var!.isByRef) {
                        if (scv!.var!.writeCount > 1) {
                            if (param.notNullOut === ParameterDFAInfo.Fact.Unspecified)
                                param.notNullOut = ParameterDFAInfo.Fact.NotGuaranteed;
                        }
                        else
                            param.notNullOut = param.notNullIn;
                    }
                    else {
                        param.notNullOut = ParameterDFAInfo.Fact.Unspecified;
                    }
                }
            }

            // dropped: version (none) trace (report.d:186)
        });
    }

    /***********************************************************
     * Reports an error if an assertion is statically provable to be false.
     *
     * If the DFA determines that the condition `x` in `assert(x)` is definitively false
     * (e.g., `assert(null)` or `assert(0)` after analysis), it reports this logic error.
     *
     * dmd/dfa/fast/report.d:200 — `void onAssertIsFalse(ref DFALatticeRef lr, ref Loc loc)`. Emits "Assert can be
     * proven to be false" at `loc` unless the lattice is unmodellable or is a bare literal (no consequence besides
     * the context, and a context with no variable). `lr` is by ref: not moved, not destroyed.
     */
    onAssertIsFalse(lr: DFALatticeRef, loc: Loc): void {
        // D stores `cctx = lr.getContext` inside the condition and never reads it: the local is dropped
        // (noUnusedLocals); the null context D would dereference faults the same way.
        if (!(lr.isModellable() && (lr.haveNonContext() || lr.getContext()!.var !== null)))
            return; // ignore literals, too false positive heavy

        this.errorSink!.error(loc, ds("Assert can be proven to be false"));
    }

    /***********************************************************
     * Reports an error if a function argument violates the callee's expectations.
     *
     * Example: Passing `null` to a function parameter marked as requiring non-null.
     *
     * dmd/dfa/fast/report.d:214 — `void onFunctionCallArgumentLessThan(DFAConsequence* c,`. Emits "Argument is
     * expected to be non-null but was null" at `loc` (unless `c`'s variable is unmodellable), then a supplemental
     * at the parameter naming it and its argument index (counting a hidden `this` as argument 0), or at `calling`
     * for the `this` parameter (`parameterId` -1).
     */
    onFunctionCallArgumentLessThan(c: DFAConsequence, paramInfo: ParameterDFAInfo, calling: FuncDeclaration,
            loc: Loc): void {
        if (c.var !== null && !c.var.isModellable())
            return;

        this.errorSink!.error(loc, ds("Argument is expected to be non-null but was null"));

        if (paramInfo.parameterId >= 0) {
            const param = calling.parameters!.opIndex(paramInfo.parameterId)!;
            const argId = paramInfo.parameterId + (calling.needThis() ? 1 : 0); // int + bool
            this.errorSink!.errorSupplemental(param.loc,
                    ds("For parameter `%s` in argument %d"), param.ident!.toChars(), argId);
        }
        else
            this.errorSink!.errorSupplemental(calling.loc, ds("For parameter `this` in called function"));
    }

    /**
     * dmd/dfa/fast/report.d:233 — `void onReadOfUninitialized(DFAVar* var, ref DFALatticeRef lr, ref Loc loc, bool`.
     * Emits the uninitialized-read error at `loc` with a supplemental at the variable's declaration, or, for a
     * default-initialized floating point variable, the NaN error with three supplementals. Silent for variables
     * that are unmodellable, depth 0, compiler temporaries, declared outside the innermost loopy label, without
     * a declaration, or floating point outside a math operation. `lr` is only read by a dropped trace.
     */
    onReadOfUninitialized(var_: DFAVar, _lr: DFALatticeRef, loc: Loc, forMathOp: boolean): void {
        if (!var_.isModellable() || var_.declaredAtDepth === 0 || (!forMathOp
                && var_.isFloatingPoint) || var_.var === null)
            return;
        else if ((var_.var.storage_class & STC.temp) !== 0n)
            return; // Compiler generated, likely to be "fine"
        else if (var_.declaredAtDepth < this.dfaCommon!.lastLoopyLabel!.depth)
            return; // Can we really know what state the variable is in? I don't think so.

        // The reason floating point is special cased here, is to allow catching of mathematical operations,
        //  on a floating point typed variable, that was default initialized.
        // The NaN will propagate on that operation, which is basically never wanted.
        // It is essentially a special case of uninitialized variables,
        //  where the default could never be what someone wants, even if it was zero.
        const floatingPointDefaultInit = var_.isFloatingPoint && var_.wasDefaultInitialized;

        if (floatingPointDefaultInit) {
            this.errorSink!.error(loc,
                    ds("Expression reads a default initialized variable that is a floating point type"));
            this.errorSink!.errorSupplemental(loc,
                    ds("It will have the value of Not Any Number(nan), " +
                        "it will be propagated with mathematical operations"));

            this.errorSink!.errorSupplemental(var_.var.loc, ds("For variable `%s`"), var_.var.ident!.toChars());
            this.errorSink!.errorSupplemental(var_.var.loc,
                    ds("Initialize to %s.nan or 0 explicitly to disable this error"), var_.var.type!.kind());
        }
        else {
            this.errorSink!.error(loc,
                    ds("Expression reads from an uninitialized variable, " +
                        "it must be written to at least once before reading"));
            this.errorSink!.errorSupplemental(var_.var.loc, ds("For variable `%s`"), var_.var.ident!.toChars());
        }

        // dropped: version (none) trace (report.d:268)
    }

    /** 03 §6.3: D's implicit field-wise copy (both pointers shared). */
    copy(): DFAReporter {
        const c = new DFAReporter();
        c.dfaCommon = this.dfaCommon;
        c.errorSink = this.errorSink;
        return c;
    }
}

// D `private:` (report.d:287) — module-private free functions.

/**
 * dmd/dfa/fast/report.d:289 — `void foreachFunctionVariable(DFACommon* dfaCommon, FuncDeclaration fd,`. Calls `del`
 * on the current-scope variable of `this` (when the function has one), of the return value, then of each parameter
 * in order. Each call first finds (creating) the DFAVar and acquires its scope variable, which may be null when the
 * variable is declared deeper than the current scope; `del` receives it as is.
 */
function foreachFunctionVariable(dfaCommon: DFACommon, fd: FuncDeclaration,
        del: (scv: DFAScopeVar | null) => void): void {
    let var_: DFAVar | null;
    let scv: DFAScopeVar | null;

    if (fd.vthis !== null) {
        var_ = dfaCommon.findVariable(fd.vthis);
        scv = dfaCommon.acquireScopeVar(var_);
        del(scv);
    }

    var_ = dfaCommon.getReturnVariable();
    scv = dfaCommon.acquireScopeVar(var_);
    del(scv);

    if (fd.parameters !== null) {
        for (const param of fd.parameters) {
            var_ = dfaCommon.findVariable(param);
            scv = dfaCommon.acquireScopeVar(var_);
            del(scv);
        }
    }
}
