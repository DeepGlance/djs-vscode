// Ported from dmd/dfa/fast/expression.d (module dmd.dfa.fast.expression).
//
// Expression walker for the fast Data Flow Analysis engine: how values flow through expressions (assignments,
// facts learned from conditions, function calls, the point analysis of arithmetic).
//
// TRANSLATION DECISIONS (the structure.ts header holds the struct, allocator and ownership decisions this file
// builds on; analysis.ts's header holds the analyzer's):
//   - ExpressionWalker is a stack local of dfaEntry (entry.d:116) reached through `ExpressionWalker*` by the
//     statement walker: a class reference (03 §0, 02 §10), like DFAAnalyzer. It is copyable in D (three pointers),
//     so it exports a field-wise copy() by the 03 §6.3 emission checklist; no D site copies it.
//   - `__gshared immutable(string[]) AllExprOpNames` (expression.d:53) is dropped: its only readers are the
//     `dfaCommon.printStructure(...)` delegates, dropped below.
//   - `dfaCommon` is read through a method-local alias `const dfaCommon = this.dfaCommon!;` (D spells it the same
//     way); dfaEntry sets the field once, before the walk.
//   - OVERLOAD SETS (04 §1 Form B, rule 1: a cross-module D caller outranks an in-module one; first-parameter splits
//     of a method take `From<Type>`, as structure.ts does for setContext / makeObject / free):
//       * seeAssign: the `DFAVar*` form keeps the bare name (statement.d:369/:643 call it); the `DFALatticeRef`
//         form is `seeAssignFromDFALatticeRef`.
//       * adaptConditionForBranch: the `(DFALatticeRef, Type, bool)` form keeps the bare name (statement.d:724/:726/
//         :951/:1002 call it); the `(Expression, bool)` form is `adaptConditionForBranchFromExpression`.
//       * walkMathAssignOp: the `(BinExp, PAMathOp)` form (fourteen in-module callers, against two) keeps the bare
//         name; the `(UnaExp, DFALatticeRef, PAMathOp)` form is `walkMathAssignOpFromUnaExp`.
//     Sibling names used (statement.ts, 04 §1 Form A): StatementWalker's `endScope()` / `endScope(ref Loc, bool)`
//     collapse by arity to one `endScope(_endLoc = Loc.initial, handleLabelPopping = true)`; `startScope()` and
//     `applyGateOnBranch(...)` keep their names.
//   - OWNERSHIP (03 §6.6 and the structure.ts OWNERSHIP PROTOCOL), every DFALatticeRef / DFAScopeRef site:
//       * a by-value handle parameter is destroyed BY THE CALLEE at its exit, after its locals, left to right: a
//         `try`/`finally` around the body. `seeRead` / `seeReadMathOp` take `ref DFALatticeRef`: no destructor.
//       * an lvalue argument to a by-value parameter is `new X(lvalue)` (the move), evaluated left to right with the
//         other arguments; an rvalue argument (a call result, `lr.copy()`) is passed as is.
//       * `x = v` is `x.opAssign(v)`. In `x = f(x, ...)` the argument moves out of `x` first, then the result is
//         assigned into the now-null `x` (`x.opAssign(this.f(new X(x), ...))`).
//       * `return local;` of the function's own local is not copied and not destroyed (NRVO, or D's move of a
//         returned local: the same observable effect). `return param;` copy-constructs: `return new X(param)`.
//       * a local handle is destroyed at its scope exit: a plain `__dtor()` at a single-exit block end, a
//         `try`/`finally` where the scope has several exits. A local still in its default-null state at an exit
//         (declared, never assigned yet) gets no call there: D's destructor early-outs on null.
//       * a handle returned by a call and discarded (`stmtWalker.endScope;`, `seeAssign(...);` as a statement) is an
//         rvalue temporary destroyed at the end of its full expression: `f(...).__dtor()`.
//       * `cond ? lr : f(lr)` copy-constructs the lvalue branch: `cond ? new X(lr) : f(new X(lr))`.
//   - `out int predicateNegation` (walkCondition) is a `Ref<number>` box reset to 0 on entry (03 §3.3), set by the
//     scope(exit) at every exit; the nested seeExp's `ref bool negated` is a `Ref<boolean>` box (03 §3.2); the `out`
//     argument of DFALatticeRef.getContext is a named `Ref` box read back after the call.
//   - DFAPAValue is a value struct (structure.ts): `.copy()` at every D copy point (assignment, by-value argument of
//     addFrom / subtractFrom); `DFAPAValue(n)` is `DFAPAValue.fromLong(n)` (an rvalue, no copy); `DFAPAValue.Unknown`
//     is `Unknown.copy()`.
//   - The integer literal casts (expression.d:1937-1975) store `cast(T) value` of a `dinteger_t` into the `long`
//     `pa.value`: signed widths mask and sign-extend, unsigned widths mask (09 §2); `cast(ulong)` stored into a long
//     is `toInt64`; `value > long.max` compares the ulong bit pattern (`toUint64`).
//   - goto shapes (06 §3.6, §4):
//       * `goto case InitKind.void_;` (expression.d:631), non-adjacent, target arm = two stores then `break`: the
//         target body is a local arrow; the jump site calls it and breaks (the §3.6 `goto default` lowering). A §2
//         record goes with the wave report (a non-adjacent `goto case` whose target is not terminal).
//       * `goto BlitAssignRet;` (expression.d:744): SKIP-FLAG (§4.1), flag `gotoBlitAssignRet`.
//       * seeExpInOr's `goto LessThan / LessThanEqual / GreaterThan / GreaterThanEqual` (expression.d:2154-2190):
//         each label starts a terminal tail (it returns): BAIL, a zero-parameter arrow per label, declared before the
//         switch; every jump site and the arm itself `return <Label>Tail()`.
//         Two of the four (:2178, :2189) jump backward into an earlier arm, which 06 §4 lists as STOP; BAIL still
//         applies because each tail is terminal and reads only captured state (a §2 record goes with the wave report).
//   - `cast(AssignExp) e` after `e.op == EXP.construct || e.op == EXP.blit` (expression.d:2080): `e2` is a BinExp
//     field, read through `e.isBinExp()!` (14 §3 item 4, read through the base).
//   - A D null slice is an empty array: `allParameters`, `allParameterVars`, `allInfos` in callFunction.
//   - Renamed identifiers (01 §2.3): the D locals `var` -> `var_`, the parameter `arguments` -> `arguments_`.
//   - `alias Fact` (report.ts) values are spelled `ParameterDFAInfo.Fact.<member>` (see the report.ts header).
//   - DEBUG MACHINERY: `dfaCommon.printState(...)` and `dfaCommon.printStructure(...)` taking a delegate are dropped
//     with the delegate (each with a `// dropped:` line): they call it only under `static if (debugIt)` /
//     `static if (debugStructure)`, resolved false (structure.ts), and the bodies print raw `%p` addresses. The
//     text forms (`printStateln`, `printStructureln`) and the handles' `printState` / `printStructure` are kept as
//     calls to the no-op methods structure.ts exports, as are the `check()` self-checks (debugVerify OFF).

import { assert, assertUnreachable, SwitchError } from "../../../assert.js";
import { maskSignedN, maskUnsignedN, toInt64, toUint64 } from "../../../numeric.js";
import { ds, dsToJs } from "../../../dstring.js";
import { dmdformat } from "../../root/dmdformat.js";
import { InitKind, STC, TY } from "../../astenums.js";
import { EXP } from "../../tokens.js";
import { Id } from "../../id.js";
import { Loc } from "../../location.js";
import type { Expressions } from "../../arraytypes.js";
import type { VarDeclaration } from "../../declaration.js";
import type { Dsymbol } from "../../dsymbol.js";
import type { BinExp, Expression, UnaExp } from "../../expression.js";
import type { FuncDeclaration, ParametersDFAInfo } from "../../func.js";
import type { Parameter, TypeFunction } from "../../mtype.js";
import type { RootObject } from "../../rootobject.js";
import type { DFAAnalyzer } from "./analysis.js";
import type { StatementWalker } from "./statement.js";
import type { DFACommon, DFAConsequence, DFAObject, DFAVar, Ref } from "./structure.js";
import {
    debugUnknownAST, DFALatticeRef, DFAPAValue, DFAScopeRef, Nullable, PAMathOp, Truthiness, Unknown,
} from "./structure.js";
import { concatNullableResult, equalityArgTypes, isIndexContextAA, isTypeNullable } from "../utils.js";
// last: the core-SCC modules; structure.js above has already loaded them through typesem (01 §4.8).
import { Type } from "../../mtype.js";
import { toBasetype } from "../../typesem.js";
import { toBool } from "../../expressionsem.js";
import { isExpression, isTuple } from "../../dtemplate.js";
import { ParameterDFAInfo } from "../../func.js";

/***********************************************************
 * Visits Expression nodes to track data flow.
 *
 * This struct implements the logic for how expressions affect the DFA state.
 * It translates AST operations (like `+`, `=`, `==`) into `DFALatticeRef` updates.
 *
 * dmd/dfa/fast/expression.d:47 — `struct ExpressionWalker`. The three fields are set by dfaEntry before the walk
 * starts and every method dereferences them. Every handle a method takes by value is consumed: the method destroys
 * it at its exit unless it moved it on (file header, OWNERSHIP).
 */
export class ExpressionWalker {
    dfaCommon: DFACommon | null = null;
    stmtWalker: StatementWalker | null = null;
    analyzer: DFAAnalyzer | null = null;

    // dropped: `__gshared immutable(string[]) AllExprOpNames` (expression.d:53), read only by dropped debug delegates

    /**
     * dmd/dfa/fast/expression.d:55 — `void seeConvergeExpression(DFALatticeRef lr, bool isSideEffect = false)`.
     * Folds the effects of the expression lattice `lr` into the current scope (analyzer.convergeExpression).
     * Consumes `lr`.
     */
    seeConvergeExpression(lr: DFALatticeRef, isSideEffect = false): void {
        try {
            const dfaCommon = this.dfaCommon!;
            dfaCommon.printStateln(ds("Converging expression:"));
            lr.printState(ds(""), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);
            lr.check();

            dfaCommon.check();
            this.analyzer!.convergeExpression(new DFALatticeRef(lr), isSideEffect);
            dfaCommon.check();

            dfaCommon.currentDFAScope!.printState(ds("so far"), dfaCommon.sdepth,
                    dfaCommon.currentFunction, dfaCommon.edepth);
            dfaCommon.currentDFAScope!.check();
        } finally {
            lr.__dtor(); // by-value parameter, destroyed by the callee
        }
    }

    /**
     * dmd/dfa/fast/expression.d:70 — `void seeConvergeFunctionCallArgument(DFALatticeRef lr, ParameterDFAInfo*`.
     * Converges the lattice of one call argument (analyzer.convergeFunctionCallArgument): `paramInfo` is the
     * parameter's DFA info (null when unknown), `paramStorageClass` its storage class, `calling` the called function
     * (null when unknown; non-null whenever `paramInfo` is). Consumes `lr`.
     */
    seeConvergeFunctionCallArgument(lr: DFALatticeRef, paramInfo: ParameterDFAInfo | null,
            paramStorageClass: STC, calling: FuncDeclaration | null, loc: Loc): void {
        try {
            const dfaCommon = this.dfaCommon!;
            dfaCommon.printStateln(ds("Converging argument:"));
            lr.printState(ds(""), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);
            lr.check();

            dfaCommon.check();
            this.analyzer!.convergeFunctionCallArgument(new DFALatticeRef(lr), paramInfo, paramStorageClass, calling,
                    loc);
            dfaCommon.check();

            dfaCommon.currentDFAScope!.printState(ds("so far"), dfaCommon.sdepth,
                    dfaCommon.currentFunction, dfaCommon.edepth);
            dfaCommon.currentDFAScope!.check();
        } finally {
            lr.__dtor(); // by-value parameter, destroyed by the callee
        }
    }

    /***********************************************************
     * Handles variable assignment (e.g., `x = y`).
     *
     * This function updates the `assignTo` variable in the current scope
     * to reflect the new state derived from `lr` (the right-hand side).
     *
     * Params:
     *      assignTo = The variable being written to.
     *      construct = True if this is an initialization (e.g., `int x = 5;`), false if reassignment.
     *      lr = The lattice state of the value being assigned.
     *      loc = Source file location of the assignment.
     *      isBlit = True if the assignment is a bitwise copy (blit).
     *      alteredState = An integer representing a specific state alteration or flag.
     *
     * dmd/dfa/fast/expression.d:100 — `DFALatticeRef seeAssign(DFAVar* assignTo, bool construct, DFALatticeRef lr,`.
     * Wraps `assignTo` in a fresh lattice and forwards to seeAssignFromDFALatticeRef. D does NOT forward
     * `alteredState` (it passes only up to `isBlit`), so the parameter has no effect: kept as `_alteredState`.
     * Consumes `lr`.
     */
    seeAssign(assignTo: DFAVar | null, construct: boolean, lr: DFALatticeRef, loc: Loc, isBlit = false,
            _alteredState = 0): DFALatticeRef {
        try {
            const dfaCommon = this.dfaCommon!;
            const assignTo2 = dfaCommon.makeLatticeRef();
            assignTo2.setContextFromDFAVar(assignTo);

            dfaCommon.check();
            const ret = this.seeAssignFromDFALatticeRef(new DFALatticeRef(assignTo2), construct,
                    new DFALatticeRef(lr), loc, isBlit);
            dfaCommon.check();

            assignTo2.__dtor(); // D destroys the local at exit (moved, so a no-op)
            return ret;
        } finally {
            lr.__dtor(); // by-value parameter, destroyed by the callee (moved, so a no-op)
        }
    }

    /**
     * dmd/dfa/fast/expression.d:113 — `DFALatticeRef seeAssign(DFALatticeRef assignTo, bool construct,` (renamed,
     * 04 §1 Form B). The assignment of `lr` to the context of `assignTo` (analyzer.transferAssign); `indexLR` is the
     * index lattice of an associative-array store, `alteredState` forces the result's facts (see transferAssign).
     * Answers the result lattice. Consumes `assignTo`, `lr` and `indexLR`.
     */
    seeAssignFromDFALatticeRef(assignTo: DFALatticeRef, construct: boolean, lr: DFALatticeRef, loc: Loc,
            isBlit = false, alteredState = 0, indexLR: DFALatticeRef = new DFALatticeRef()): DFALatticeRef {
        try {
            const dfaCommon = this.dfaCommon!;
            // dropped: `dfaCommon.printState(...)` (expression.d:116), debug dump (file header)
            assignTo.printState(ds("to"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);
            assignTo.check();
            lr.printState(ds("from"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);
            lr.check();
            indexLR.printState(ds("index"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);
            indexLR.check();

            assert(this.analyzer !== null);
            dfaCommon.check();
            const ret = this.analyzer.transferAssign(new DFALatticeRef(assignTo), construct,
                    isBlit, new DFALatticeRef(lr), alteredState, loc, new DFALatticeRef(indexLR));
            dfaCommon.check();

            ret.check();
            ret.printState(ds("result"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);

            dfaCommon.currentDFAScope!.printState(ds("so far"), dfaCommon.sdepth,
                    dfaCommon.currentFunction, dfaCommon.edepth);
            dfaCommon.currentDFAScope!.check();
            return ret;
        } finally {
            // by-value parameters, destroyed by the callee left to right
            assignTo.__dtor();
            lr.__dtor();
            indexLR.__dtor();
        }
    }

    /***********************************************************
     * Handles equality checks (e.g., `x == y`).
     *
     * This is critical for control flow. If the DFA sees `if (x == null)`,
     * this function records that relationship so the `StatementWalker` can
     * create a scope where `x` is known to be null.
     *
     * dmd/dfa/fast/expression.d:147 — `DFALatticeRef seeEqual(DFALatticeRef lhs, DFALatticeRef rhs,`.
     * `lhs == rhs` (or `!=` when `truthiness` is false) through analyzer.transferEqual, the equality kind derived
     * from the operand types. Consumes `lhs` and `rhs`.
     */
    seeEqual(lhs: DFALatticeRef, rhs: DFALatticeRef, truthiness: boolean, lhsType: Type,
            rhsType: Type | null): DFALatticeRef {
        try {
            const dfaCommon = this.dfaCommon!;
            const equalityType = equalityArgTypes(lhsType, rhsType);

            // dropped: `dfaCommon.printState(...)` (expression.d:152), debug dump (file header)

            lhs.printState(ds("lhs"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);
            rhs.printState(ds("rhs"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);

            dfaCommon.check();
            const ret = this.analyzer!.transferEqual(new DFALatticeRef(lhs), new DFALatticeRef(rhs), truthiness,
                    equalityType, false);
            dfaCommon.check();

            ret.printState(ds("result"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);
            return ret;
        } finally {
            lhs.__dtor();
            rhs.__dtor();
        }
    }

    /***********************************************************
     * Handles equality checks (e.g., `x is y`).
     *
     * This is critical for control flow. If the DFA sees `if (x == null)`,
     * this function records that relationship so the `StatementWalker` can
     * create a scope where `x` is known to be null.
     *
     * dmd/dfa/fast/expression.d:176 — `DFALatticeRef seeEqualIdentity(DFALatticeRef lhs, DFALatticeRef rhs,`.
     * seeEqual for `is` / `!is` (identity equality). Consumes `lhs` and `rhs`.
     */
    seeEqualIdentity(lhs: DFALatticeRef, rhs: DFALatticeRef, truthiness: boolean, lhsType: Type,
            rhsType: Type | null): DFALatticeRef {
        try {
            const dfaCommon = this.dfaCommon!;
            const equalityType = equalityArgTypes(lhsType, rhsType);

            // dropped: `dfaCommon.printState(...)` (expression.d:181), debug dump (file header)

            lhs.printState(ds("lhs"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);
            rhs.printState(ds("rhs"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);

            dfaCommon.check();
            const ret = this.analyzer!.transferEqual(new DFALatticeRef(lhs), new DFALatticeRef(rhs), truthiness,
                    equalityType, true);
            dfaCommon.check();

            ret.printState(ds("result"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);
            return ret;
        } finally {
            lhs.__dtor();
            rhs.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/expression.d:198 — `DFALatticeRef seeNegate(DFALatticeRef lr, Type type,`. The negation of `lr`
     * (analyzer.transferNegate). Consumes `lr`.
     */
    seeNegate(lr: DFALatticeRef, type: Type | null, protectElseNegate = false, limitToContext = false): DFALatticeRef {
        try {
            const dfaCommon = this.dfaCommon!;
            lr.printState(ds("Negate"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);

            dfaCommon.check();
            const ret = this.analyzer!.transferNegate(new DFALatticeRef(lr), type, protectElseNegate, limitToContext);
            dfaCommon.check();

            ret.printState(ds("result"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);
            return ret;
        } finally {
            lr.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/expression.d:211 — `DFALatticeRef seeMathOp(DFALatticeRef lhs, DFALatticeRef rhs, Type type,`.
     * `lhs op rhs` in the point analysis (analyzer.transferMathOp), computed in `type`. Consumes `lhs` and `rhs`.
     */
    seeMathOp(lhs: DFALatticeRef, rhs: DFALatticeRef, type: Type, op: PAMathOp): DFALatticeRef {
        try {
            const dfaCommon = this.dfaCommon!;
            // dropped: `dfaCommon.printState(...)` (expression.d:213), debug dump (file header)
            lhs.printState(ds("lhs"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);
            rhs.printState(ds("rhs"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);

            dfaCommon.check();
            const ret = this.analyzer!.transferMathOp(new DFALatticeRef(lhs), new DFALatticeRef(rhs), type, op);
            dfaCommon.check();

            ret.printState(ds("result"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);
            return ret;
        } finally {
            lhs.__dtor();
            rhs.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/expression.d:228 — `DFALatticeRef seeDereference(ref Loc loc, DFALatticeRef lr)`. `*lr`
     * (analyzer.transferDereference, which reports a null dereference at `loc`). Consumes `lr`.
     */
    seeDereference(loc: Loc, lr: DFALatticeRef): DFALatticeRef {
        try {
            const dfaCommon = this.dfaCommon!;
            dfaCommon.printStateln(ds("Dereferencing"));
            lr.printState(ds("Dereference"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);

            dfaCommon.check();
            const ret = this.analyzer!.transferDereference(new DFALatticeRef(lr), loc);
            dfaCommon.check();

            ret.printState(ds("result"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);
            return ret;
        } finally {
            lr.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/expression.d:242 — `void seeAssert(DFALatticeRef lr, ref Loc loc, bool dueToConditional = false)`.
     * A user assertion of `lr` at `loc` (analyzer.transferAssert, which reports an assert proven false). Consumes
     * `lr`.
     */
    seeAssert(lr: DFALatticeRef, loc: Loc, dueToConditional = false): void {
        try {
            const dfaCommon = this.dfaCommon!;
            lr.printState(ds("Assert"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);

            dfaCommon.currentDFAScope!.printState(ds("scope"), dfaCommon.sdepth,
                    dfaCommon.currentFunction, dfaCommon.edepth);
            dfaCommon.currentDFAScope!.check();

            dfaCommon.check();
            this.analyzer!.transferAssert(new DFALatticeRef(lr), loc, false, dueToConditional);
            dfaCommon.check();

            dfaCommon.currentDFAScope!.printState(ds("so far"), dfaCommon.sdepth,
                    dfaCommon.currentFunction, dfaCommon.edepth);
            dfaCommon.currentDFAScope!.check();
        } finally {
            lr.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/expression.d:259 — `void seeSilentAssert(DFALatticeRef lr, bool ignoreWriteCount = false,`. An
     * assertion the engine makes itself (a branch condition): transferAssert at the invalid location, so it never
     * reports. Consumes `lr`.
     */
    seeSilentAssert(lr: DFALatticeRef, ignoreWriteCount = false, dueToConditional = false): void {
        try {
            const dfaCommon = this.dfaCommon!;
            lr.printState(ds("Assert silent"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);

            dfaCommon.currentDFAScope!.printState(ds("scope"), dfaCommon.sdepth,
                    dfaCommon.currentFunction, dfaCommon.edepth);
            dfaCommon.currentDFAScope!.check();

            const loc = new Loc();
            dfaCommon.check();
            this.analyzer!.transferAssert(new DFALatticeRef(lr), loc, ignoreWriteCount, dueToConditional);
            dfaCommon.check();

            dfaCommon.currentDFAScope!.printState(ds("so far"), dfaCommon.sdepth,
                    dfaCommon.currentFunction, dfaCommon.edepth);
            dfaCommon.currentDFAScope!.check();
        } finally {
            lr.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/expression.d:279 — `DFALatticeRef seeLogicalAnd(DFALatticeRef lhs, DFALatticeRef rhs)`.
     * `lhs && rhs` (analyzer.transferLogicalAnd). Consumes `lhs` and `rhs`.
     */
    seeLogicalAnd(lhs: DFALatticeRef, rhs: DFALatticeRef): DFALatticeRef {
        try {
            const dfaCommon = this.dfaCommon!;
            dfaCommon.printStateln(ds("Logical and:"));
            lhs.printState(ds("lhs"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);
            lhs.check();
            rhs.printState(ds("rhs"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);
            rhs.check();

            dfaCommon.check();
            const ret = this.analyzer!.transferLogicalAnd(new DFALatticeRef(lhs), new DFALatticeRef(rhs));
            dfaCommon.check();

            ret.printState(ds("result"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);
            ret.check();
            return ret;
        } finally {
            lhs.__dtor();
            rhs.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/expression.d:296 — `DFALatticeRef seeLogicalOr(DFALatticeRef lhs, DFALatticeRef rhs)`.
     * `lhs || rhs` (analyzer.transferLogicalOr). Consumes `lhs` and `rhs`.
     */
    seeLogicalOr(lhs: DFALatticeRef, rhs: DFALatticeRef): DFALatticeRef {
        try {
            const dfaCommon = this.dfaCommon!;
            dfaCommon.printStateln(ds("Logical or:"));
            lhs.printState(ds("lhs"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);
            rhs.printState(ds("rhs"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);

            dfaCommon.check();
            const ret = this.analyzer!.transferLogicalOr(new DFALatticeRef(lhs), new DFALatticeRef(rhs));
            dfaCommon.check();

            ret.printState(ds("result"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);
            return ret;
        } finally {
            lhs.__dtor();
            rhs.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/expression.d:310 — `DFALatticeRef seeConditional(DFALatticeRef condition, DFAScopeRef scrTrue,`.
     * `condition ? lrTrue : lrFalse` with the two branch scopes (analyzer.transferConditional). Consumes all five
     * handles.
     */
    seeConditional(condition: DFALatticeRef, scrTrue: DFAScopeRef, lrTrue: DFALatticeRef, scrFalse: DFAScopeRef,
            lrFalse: DFALatticeRef, unknownBranchTaken: boolean, predicateNegation: number): DFALatticeRef {
        try {
            const dfaCommon = this.dfaCommon!;
            dfaCommon.printStateln(ds("Condition:"));
            condition.printState(ds("condition"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);
            scrTrue.printState(ds("true sc"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);
            lrTrue.printState(ds("true lr"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);
            scrFalse.printState(ds("false sc"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);
            lrFalse.printState(ds("false lr"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);

            dfaCommon.check();
            const ret = this.analyzer!.transferConditional(new DFALatticeRef(condition), new DFAScopeRef(scrTrue),
                    new DFALatticeRef(lrTrue), new DFAScopeRef(scrFalse), new DFALatticeRef(lrFalse),
                    unknownBranchTaken, predicateNegation);
            dfaCommon.check();

            ret.printState(ds("result"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);
            dfaCommon.currentDFAScope!.printState(ds("so far"), dfaCommon.sdepth,
                    dfaCommon.currentFunction, dfaCommon.edepth);

            ret.check();
            dfaCommon.currentDFAScope!.check();
            return ret;
        } finally {
            // by-value parameters, destroyed by the callee left to right
            condition.__dtor();
            scrTrue.__dtor();
            lrTrue.__dtor();
            scrFalse.__dtor();
            lrFalse.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/expression.d:340 — `DFALatticeRef seeGreaterThan(bool orEqualTo, DFALatticeRef lhs,`.
     * `lhs > rhs` (`>=` under `orEqualTo`) through analyzer.transferGreaterThan. Consumes `lhs` and `rhs`.
     */
    seeGreaterThan(orEqualTo: boolean, lhs: DFALatticeRef, rhs: DFALatticeRef): DFALatticeRef {
        try {
            const dfaCommon = this.dfaCommon!;
            dfaCommon.printStateln(orEqualTo ? ds("Greater than or equal to:") : ds("Greater than:"));
            lhs.printState(ds("lhs"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);
            rhs.printState(ds("rhs"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);

            dfaCommon.check();
            const ret = this.analyzer!.transferGreaterThan(orEqualTo, new DFALatticeRef(lhs), new DFALatticeRef(rhs));
            dfaCommon.check();

            ret.printState(ds("result"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);
            return ret;
        } finally {
            lhs.__dtor();
            rhs.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/expression.d:354 — `void seeRead(ref DFALatticeRef lr, ref Loc loc)`. The read of `lr`'s context
     * variable at `loc` (analyzer.onRead: reports an uninitialized read). `lr` is by ref: not consumed.
     */
    seeRead(lr: DFALatticeRef, loc: Loc): void {
        const dfaCommon = this.dfaCommon!;
        dfaCommon.printStateln(ds("Seeing read of lr"));
        lr.printState(ds("read lr"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);

        this.analyzer!.onRead(lr, loc);
    }

    /**
     * dmd/dfa/fast/expression.d:362 — `void seeReadMathOp(ref DFALatticeRef lr, ref Loc loc)`. seeRead for an
     * operand of a math operation (onRead's `forMathOp`). `lr` is by ref: not consumed.
     */
    seeReadMathOp(lr: DFALatticeRef, loc: Loc): void {
        const dfaCommon = this.dfaCommon!;
        dfaCommon.printStateln(ds("Seeing read of math op lr"));
        lr.printState(ds("read lr"), dfaCommon.sdepth, dfaCommon.currentFunction, dfaCommon.edepth);

        this.analyzer!.onRead(lr, loc, false, false, true);
    }

    /**
     * dmd/dfa/fast/expression.d:370 — `DFALatticeRef adaptConditionForBranch(Expression expr, bool truthiness)`
     * (renamed, 04 §1 Form B). Walks `expr` and adapts it as the condition of the `truthiness` branch; a null handle
     * for a null `expr`.
     */
    adaptConditionForBranchFromExpression(expr: Expression | null, truthiness: boolean): DFALatticeRef {
        if (expr === null)
            return new DFALatticeRef();

        return this.adaptConditionForBranch(this.walk(expr), expr.type, truthiness);
    }

    /**
     * dmd/dfa/fast/expression.d:378 — `DFALatticeRef adaptConditionForBranch(DFALatticeRef ret, Type type, bool`.
     * The condition lattice `ret` as it holds on entry to the `truthiness` branch: a null handle becomes an unknown
     * constant; a nullable context of unknown truthiness becomes `ctx == non-null constant` (`== null` for the
     * false branch); otherwise, for the false branch, the gate consequence is negated, and without one the result is
     * a fresh unknown constant (the old lattice is freed). Consumes `ret` and answers the adapted lattice.
     */
    adaptConditionForBranch(ret: DFALatticeRef, type: Type | null, truthiness: boolean): DFALatticeRef {
        try {
            const dfaCommon = this.dfaCommon!;
            if (ret.isNull()) {
                ret.opAssign(dfaCommon.makeLatticeRef());
                ret.acquireConstantAsContext();
            }

            const ctx: Ref<DFAVar | null> = { value: null };
            let cctx = ret.getContext(ctx);
            assert(cctx !== null);

            if (ctx.value !== null && ctx.value.isNullable && cctx.truthiness === Truthiness.Unknown) {
                const against = dfaCommon.makeLatticeRef();

                if (truthiness)
                    against.acquireConstantAsContextTruthiness(Truthiness.True, Nullable.NonNull, null);
                else
                    against.acquireConstantAsContextTruthiness(Truthiness.False, Nullable.Null, null);

                ret.opAssign(this.seeEqual(new DFALatticeRef(ret), new DFALatticeRef(against), truthiness, type!,
                        null));
                against.__dtor(); // D destroys the block-local `against` (moved, so a no-op)
            }
            else if (!truthiness) {
                if ((cctx = ret.getGateConsequence()) !== null) {
                    ret.setContext(cctx);
                    ret.opAssign(this.seeNegate(new DFALatticeRef(ret), type));
                }
                else {
                    // Unfortunately negation is a bit overactive for else bodies.
                    ret.opAssign(dfaCommon.makeLatticeRef());
                    ret.acquireConstantAsContext();
                }
            }

            return new DFALatticeRef(ret); // `return param;` copy-constructs
        } finally {
            ret.__dtor(); // by-value parameter, destroyed by the callee (moved, so a no-op)
        }
    }

    /***********************************************************
     * The main dispatch loop for expressions.
     *
     * Visits an expression node and returns the resulting Lattice state.
     * This handles the recursion for complex expressions like `(a + b) * c`.
     *
     * Returns:
     * A `DFALatticeRef` representing the computed value/state of the expression.
     *
     * dmd/dfa/fast/expression.d:428 — `DFALatticeRef walk(Expression expr)`. A null handle for a null `expr` and
     * for the expressions the engine does not model. `dfaCommon.edepth` counts the nesting for the whole call.
     */
    walk(expr: Expression | null): DFALatticeRef {
        if (expr === null)
            return new DFALatticeRef();

        const dfaCommon = this.dfaCommon!;
        dfaCommon.edepth++;
        dfaCommon.check();

        // dropped: `dfaCommon.printStructure(...)` (expression.d:436), debug dump (file header)

        try {
            switch (expr.op) {
                case EXP.not: // !x
                case EXP.equal:
                case EXP.notEqual:
                case EXP.identity: // is
                case EXP.notIdentity: // !is
                case EXP.string_:
                case EXP.typeid_:
                case EXP.arrayLiteral:
                case EXP.assocArrayLiteral:
                case EXP.arrayLength:
                case EXP.int64:
                case EXP.null_:
                case EXP.cast_:
                case EXP.variable: {
                    const predicateNegation: Ref<number> = { value: 0 };
                    return this.walkCondition(expr, predicateNegation);
                }

                case EXP.this_: {
                    let vd = expr.isThisExp()!.var_;

                    if (vd === null)
                        vd = dfaCommon.currentFunction!.vthis;

                    if (!debugUnknownAST && vd === null)
                        return new DFALatticeRef();
                    else if (vd === null)
                        assertUnreachable();

                    const var_ = dfaCommon.findVariable(vd);
                    return dfaCommon.acquireLattice(var_);
                }

                case EXP.dotVariable: {
                    const dve = expr.isDotVarExp()!;

                    dfaCommon.printStateln(ds("Dot var lhs"));
                    const ret = this.walk(dve.e1);
                    if (ret.isNull())
                        ret.opAssign(dfaCommon.makeLatticeRef());

                    const context = ret.getContext();
                    let var_: DFAVar | null = null;

                    // for indirection we start with a clean slate on each access
                    const vd = dve.var_.isVarDeclaration();
                    if (vd !== null) {
                        if (context === null || context.var === null)
                            var_ = dfaCommon.findVariable(vd);
                        else
                            var_ = dfaCommon.findVariable(vd, context.var);
                    }

                    const c = ret.addConsequence(var_);
                    ret.setContext(c);
                    return ret;
                }

                case EXP.symbolOffset: {
                    // similar to address except has a variable offset
                    const soe = expr.isSymOffExp()!;
                    const ret = new DFALatticeRef();
                    let varBase: DFAVar | null = null, varOffset: DFAVar | null = null;

                    const vd = soe.var_.isVarDeclaration();
                    const fd = vd === null ? soe.var_.isFuncDeclaration() : null;
                    if (vd !== null) {
                        varBase = dfaCommon.findVariable(vd);
                        if (varBase === null)
                            return new DFALatticeRef();

                        ret.opAssign(dfaCommon.acquireLattice(varBase));
                        if (ret.isNull())
                            ret.opAssign(dfaCommon.makeLatticeRef());

                        varOffset = dfaCommon.findOffsetVar(soe.offset, varBase);
                        assert(varOffset === null || varOffset.haveBase());

                        const c = ret.addConsequence(varOffset)!;
                        ret.setContext(c);

                        c.obj = dfaCommon.makeObjectFromDFAVar(varBase);

                        if (varBase.declaredAtDepth > 0) {
                            c.truthiness = Truthiness.True;
                            c.nullable = Nullable.NonNull;
                        }

                        if (soe.offset !== 0n)
                            c.obj!.mayNotBeExactPointer = true;
                    }
                    else if (fd !== null) {
                        // For some reason, sometimes people like to do an offset that isn't zero for functions.
                        // So we'll ignore that and assume the offset is "right",
                        //  even if it probably doesn't make sense to be doing it.

                        ret.opAssign(dfaCommon.makeLatticeRef());
                        ret.acquireConstantAsContextTruthiness(Truthiness.True, Nullable.NonNull,
                                dfaCommon.makeObject());
                    }
                    else {
                        if (!debugUnknownAST)
                            return new DFALatticeRef();
                        else
                            assertUnreachable();
                    }

                    return ret;
                }

                case EXP.address: {
                    // Similar to symbolOffset except is always at offset 0
                    const ae = expr.isAddrExp()!;

                    const ret = this.walk(ae.e1);

                    if (!ret.isNull()) {
                        const ctx = ret.getContextVar();

                        if (ctx !== null) {
                            const varOffset = dfaCommon.findOffsetVar(0n, ctx);
                            const cctx = ret.setContextFromDFAVar(varOffset)!;

                            cctx.obj = dfaCommon.makeObjectFromDFAVar(ctx);

                            if (ctx.declaredAtDepth > 0) {
                                cctx.truthiness = Truthiness.True;
                                cctx.nullable = Nullable.NonNull;
                            }
                        }
                    }

                    return ret;
                }

                case EXP.declaration: {
                    const symbol = expr.isDeclarationExp()!.declaration;

                    const eachDeclarationSymbol = (symbol: Dsymbol): void => {
                        const var_ = symbol.isVarDeclaration();
                        if (var_ !== null) {
                            // dropped: `dfaCommon.printStructure(...)` (expression.d:595), debug dump (file header)

                            const dfaVar = dfaCommon.findVariable(var_)!;
                            dfaVar.declaredAtDepth = dfaCommon.currentDFAScope!.depth;
                            const scv = dfaCommon.acquireScopeVar(dfaVar)!;
                            const cctx = scv.lr.getContext()!;

                            // ImportC supports syntax as: Type var = var;
                            // Bit of a problem that...
                            // Due to the construct expression on rhs, is going to see var as being uninitialized.
                            // What we'll do instead, is init ALL VARIABLES, and based upon the init expression,
                            // uninitialize it.

                            {
                                dfaVar.writeCount = 1;
                                cctx.writeOnVarAtThisPoint = 1;
                            }

                            if (var_._init !== null) {
                                // the `InitKind.void_` arm, shared with the `goto case InitKind.void_;` of the
                                // exp arm (06 §3.6: the target body, called at the jump site, which then breaks)
                                const voidArm = (): void => {
                                    dfaVar.writeCount = 0;
                                    cctx.writeOnVarAtThisPoint = 0;
                                };

                                switch (var_._init.kind) {
                                    case InitKind.exp: {
                                        const ei = var_._init.isExpInitializer()!;

                                        if (ei.loc.opEquals(var_.loc) && (var_.storage_class & STC.foreach_) === 0n) {
                                            // This is default initialization

                                            if (dfaVar.isFloatingPoint) {
                                                // Floating point initializes to NaN which is NOT a good default.
                                                // Allow explicit, but not default initialization.
                                                dfaVar.wasDefaultInitialized = true;
                                                voidArm(); // goto case InitKind.void_ (dmd/dfa/fast/expression.d:631)
                                                break;
                                            }
                                        }

                                        // does this var escape another? Can't model that.
                                        if ((var_.storage_class & STC.ref_) === STC.ref_)
                                            this.markUnmodellable(ei.exp!);

                                        const lr = this.walk(ei.exp);

                                        if (!(ei.exp!.isConstructExp() !== null || ei.exp!.isBlitExp() !== null)) {
                                            // the discarded result is a temporary, destroyed at once
                                            this.seeAssign(dfaVar, true, new DFALatticeRef(lr), ei.exp!.loc).__dtor();
                                        }
                                        lr.__dtor(); // D destroys the arm-local `lr` (frees it when not moved)
                                        break;
                                    }

                                    case InitKind.array: {
                                        const ai = var_._init.isArrayInitializer()!;
                                        const lr = dfaCommon.makeLatticeRef();
                                        const c = lr.addConsequence(dfaVar);
                                        lr.setContext(c);

                                        // the discarded result is a temporary, destroyed at once
                                        this.seeAssign(dfaVar, true, new DFALatticeRef(lr), ai.loc, false,
                                                ai.value.length > 0 ? 3 : 2).__dtor();
                                        lr.__dtor(); // D destroys the arm-local `lr` (moved, so a no-op)
                                        break;
                                    }

                                    case InitKind.void_:
                                        voidArm();
                                        break;

                                    case InitKind.error:
                                    case InitKind.struct_:
                                    case InitKind.C_:
                                    case InitKind.default_:
                                        break;

                                    default: {
                                        // final switch: D throws SwitchError on an unhandled value
                                        const _exhaustive: never = var_._init.kind;
                                        void _exhaustive;
                                        throw new SwitchError();
                                    }
                                }
                            }
                        }
                    };

                    const ad = symbol!.isAttribDeclaration();
                    if (ad !== null) {
                        // ImportC wraps their declarations

                        if (ad.decl !== null) {
                            for (const symbol2 of ad.decl) {
                                eachDeclarationSymbol(symbol2!);
                            }
                        }
                    }
                    else
                        eachDeclarationSymbol(symbol!);

                    return new DFALatticeRef();
                }

                case EXP.construct: {
                    const ce = expr.isConstructExp()!;

                    dfaCommon.printStateln(ds("construct lhs"));
                    const lhs = this.walk(ce.e1);

                    dfaCommon.printStateln(ds("construct rhs"));
                    const rhs = this.walk(ce.e2);

                    const ret = this.seeAssignFromDFALatticeRef(new DFALatticeRef(lhs), true, new DFALatticeRef(rhs),
                            ce.loc);
                    rhs.__dtor(); // D destroys the arm locals (moved, so no-ops)
                    lhs.__dtor();
                    return ret;
                }

                case EXP.negate: { // -x
                    const ue = expr.isUnaExp()!;
                    const ret = this.walk(ue.e1);
                    const r = this.seeNegate(new DFALatticeRef(ret), ue.type, false, true);
                    ret.__dtor(); // D destroys the arm local (moved, so a no-op)
                    return r;
                }

                    // Basic types
                case EXP.void_:
                case EXP.float64:
                case EXP.complex80: {
                    const ret = dfaCommon.makeLatticeRef();
                    ret.acquireConstantAsContext();
                    return ret;
                }

                case EXP.call: {
                    const ce = expr.isCallExp();
                    assert(ce !== null);
                    assert(ce.e1 !== null);
                    return this.callFunction(ce.f, ce.e1, null, ce.arguments_, ce.loc);
                }

                case EXP.blit: {
                    const be = expr.isBlitExp()!;

                    dfaCommon.printStateln(ds("blit lhs"));
                    const lhs = new DFALatticeRef(), rhs = new DFALatticeRef();
                    let gotoBlitAssignRet = false; // models expression.d:744 `goto BlitAssignRet;`

                    const se = be.e1!.isSliceExp();
                    if (se !== null) {
                        // if we're bliting to a static array, let's ignore the empty slice.
                        assert(se.upr === null);
                        assert(se.lwr === null);
                        lhs.opAssign(this.walk(se.e1));
                    }
                    else
                        lhs.opAssign(this.walk(be.e1));

                    const e2ve = be.e2!.isVarExp();
                    if (e2ve !== null) {
                        const sd = e2ve.var_.isSymbolDeclaration();
                        if (sd !== null) {
                            // this evaluates out to a type

                            rhs.opAssign(dfaCommon.makeLatticeRef());
                            rhs.acquireConstantAsContextTruthiness(Truthiness.True,
                                    Nullable.NonNull, dfaCommon.makeObject());

                            gotoBlitAssignRet = true; // goto BlitAssignRet (dmd/dfa/fast/expression.d:744)
                        }
                    }

                    if (!gotoBlitAssignRet)
                        dfaCommon.printStateln(ds("blit rhs"));
                    if (!gotoBlitAssignRet)
                        rhs.opAssign(this.walk(be.e2));

                    // BlitAssignRet: SKIP-FLAG tail, reached by both routes
                    const ret = this.seeAssignFromDFALatticeRef(new DFALatticeRef(lhs), true, new DFALatticeRef(rhs),
                            be.loc, true);
                    rhs.__dtor(); // D destroys the arm locals (moved, so no-ops)
                    lhs.__dtor();
                    return ret;
                }

                case EXP.assign: {
                    const ae = expr.isAssignExp()!;

                    let lhsContext: Expression | null = ae.e1, lhsIndex: Expression | null = null;

                    const ie = ae.e1!.isIndexExp();
                    if (ie !== null) {
                        // Is this AA assignment?

                        if (isIndexContextAA(ie)) {
                            // ae.e1 resolves to a ctx[idx]
                            // ie.e1 is ctx, and ie.e2 is idx

                            lhsContext = ie.e1;
                            lhsIndex = ie.e2;
                        }
                    }

                    dfaCommon.printStateln(ds("assign lhs"));
                    const lhs = this.walk(lhsContext);
                    const indexLR = new DFALatticeRef();

                    if (lhsIndex !== null) {
                        dfaCommon.printStateln(ds("assign lhs index"));
                        indexLR.opAssign(this.walk(lhsIndex));
                    }

                    dfaCommon.printStateln(ds("assign rhs"));
                    const rhs = this.walk(ae.e2);
                    const ret = this.seeAssignFromDFALatticeRef(new DFALatticeRef(lhs), false, new DFALatticeRef(rhs),
                            ae.loc, false, lhsIndex !== null ? 3 : 0, new DFALatticeRef(indexLR));

                    if (ret.isNull()) {
                        ret.opAssign(dfaCommon.makeLatticeRef());
                        ret.acquireConstantAsContext();
                    }

                    rhs.__dtor(); // D destroys the arm locals (moved, so no-ops)
                    indexLR.__dtor();
                    lhs.__dtor();
                    return ret;
                }

                case EXP.star: {
                    const pe = expr.isPtrExp()!;
                    dfaCommon.printStateln(ds("Derefencing exp"));
                    const lr = this.walk(pe.e1);
                    const r = this.seeDereference(pe.loc, new DFALatticeRef(lr));
                    lr.__dtor(); // D destroys the arm local (moved, so a no-op)
                    return r;
                }

                case EXP.index: {
                    // See Slice
                    const ie = expr.isIndexExp()!;

                    dfaCommon.printStateln(ds("index lhs"));
                    const lhs = this.walk(ie.e1);
                    dfaCommon.printStateln(ds("index rhs"));
                    const index = this.walk(ie.e2);

                    const lhsCtx: Ref<DFAVar | null> = { value: null };
                    const lhsCctx = lhs.getContext(lhsCtx);

                    // D `DFAObject* lhsObject;` (expression.d:816) is written at :843 and never read: the local is
                    // dropped (noUnusedLocals), its one write goes straight to `lhsCctx.obj`.

                    const lhsType = ie.e1!.type!;
                    let resultHasEffect = false;

                    if (lhsCctx !== null) {
                        // Apply effects that this operation will have on to the lhs

                        let effectIndexBase = ie.indexIsInBounds;

                        if (lhsType.isTypeAArray() !== null) {
                            if (ie.modifiable)
                                effectIndexBase = true;
                        }
                        else
                            resultHasEffect = true;

                        if (effectIndexBase) {
                            lhsCctx.truthiness = Truthiness.True;
                            lhsCctx.nullable = Nullable.NonNull;
                        }

                        if (lhsCctx.obj !== null)
                            lhsCctx.obj.mayNotBeExactPointer = true;
                    }

                    if (lhsCtx.value !== null && lhsCtx.value.isNullable) {
                        // Dereference the lhs if its a pointer,
                        //  this really should be the case, but it prevents unnecessary work for static arrays.
                        lhs.opAssign(this.seeDereference(ie.loc, new DFALatticeRef(lhs)));
                    }

                    const indexVar = dfaCommon.findIndexVar(lhsCtx.value);
                    const combined = this.seeLogicalAnd(new DFALatticeRef(lhs), new DFALatticeRef(index));
                    const newCctx = combined.addConsequence(indexVar)!;
                    combined.setContext(newCctx);

                    if (resultHasEffect && indexVar !== null) {
                        if (indexVar.isTruthy)
                            newCctx.truthiness = Truthiness.True;
                        if (indexVar.isNullable)
                            newCctx.nullable = Nullable.NonNull;
                    }

                    index.__dtor(); // D destroys the arm locals (moved, so no-ops)
                    lhs.__dtor();
                    return combined;
                }

                case EXP.slice: {
                    // See index
                    const se = expr.isSliceExp()!;

                    dfaCommon.printStateln(ds("Slice base"));
                    const base = this.walk(se.e1);
                    const baseCtx: Ref<DFAVar | null> = { value: null };
                    const baseCctx = base.getContext(baseCtx);

                    if (se.lwr === null && se.upr === null) {
                        // Equivalent to doing slice[]
                        const asSliceVar = dfaCommon.findAsSliceVar(baseCtx.value);
                        const newCctx = base.addConsequence(asSliceVar)!;
                        base.setContext(newCctx);

                        if (baseCctx !== null && baseCctx.obj !== null)
                            newCctx.obj = baseCctx.obj;
                        else
                            newCctx.obj = dfaCommon.makeObjectFromDFAVar(baseCtx.value);
                        return base;
                    }

                    let expectedTruthiness = Truthiness.Unknown;
                    const ret = new DFALatticeRef(base); // `DFALatticeRef ret = base;` steals `base`

                    {
                        dfaCommon.printStateln(ds("Slice [lwr"));
                        const lower = this.walk(se.lwr);
                        dfaCommon.printStateln(ds("Slice upr]"));
                        const upper = this.walk(se.upr);

                        const lowerCctx = lower.getContext(), upperCctx = upper.getContext();
                        let newPA = new DFAPAValue();

                        if (lowerCctx !== null && upperCctx !== null) {
                            newPA = upperCctx.pa.copy();
                            newPA.subtractFrom(lowerCctx.pa.copy(), Type.tuns64);
                        }

                        const together = this.seeLogicalAnd(new DFALatticeRef(lower), new DFALatticeRef(upper));
                        ret.opAssign(this.seeLogicalAnd(new DFALatticeRef(ret), new DFALatticeRef(together)));

                        const cctx = ret.addConsequence(baseCtx.value)!;
                        cctx.pa = newPA.copy();

                        if (se.upperIsInBounds
                                || (newPA.kind === DFAPAValue.Kind.Concrete && newPA.value > 0n)) {
                            expectedTruthiness = Truthiness.True;
                            cctx.truthiness = Truthiness.True;
                            cctx.nullable = Nullable.NonNull;
                        }

                        together.__dtor(); // D destroys the block locals (moved, so no-ops)
                        upper.__dtor();
                        lower.__dtor();
                    }

                    if (baseCtx.value !== null && baseCtx.value.isNullable) {
                        // Dereference if its a pointer,
                        //  this really should be the case, but it prevents unnecessary work for static arrays.
                        ret.opAssign(this.seeDereference(se.loc, new DFALatticeRef(ret)));
                    }

                    const indexVar = dfaCommon.findIndexVar(baseCtx.value);
                    const newCctx = ret.addConsequence(indexVar)!;
                    ret.setContext(newCctx);

                    if (indexVar !== null) {
                        if (indexVar.isTruthy)
                            newCctx.truthiness = expectedTruthiness;

                        // If this expression were to succeed, the resulting slice will be non-null.
                        // Thanks to the read barrier for bounds checking.
                        if (indexVar.isNullable)
                            newCctx.nullable = Nullable.NonNull;
                    }

                    base.__dtor(); // D destroys the arm local `base` (moved into `ret`, so a no-op)
                    return ret;
                }

                case EXP.assert_: {
                    // User assertions act as facts for the DFA.
                    // `assert(x != null)` tells the engine that `x` is NonNull
                    // for all subsequent code in this scope.
                    const ae = expr.isAssertExp()!;
                    const lr = this.walk(ae.e1);
                    this.seeAssert(new DFALatticeRef(lr), ae.e1!.loc);
                    lr.__dtor(); // D destroys the arm local (moved, so a no-op)
                    return new DFALatticeRef();
                }

                case EXP.halt: {
                    const lr = dfaCommon.makeLatticeRef();
                    lr.acquireConstantAsContextTruthiness(Truthiness.False, Nullable.Unknown, null);

                    this.seeAssert(new DFALatticeRef(lr), expr.loc);
                    lr.__dtor(); // D destroys the arm local (moved, so a no-op)
                    // Evaluates to void
                    return new DFALatticeRef();
                }

                case EXP.new_: {
                    const ne = expr.isNewExp()!;

                    const ret = this.callFunction(ne.member, ne.thisexp, ne.argprefix, ne.arguments_, ne.loc);

                    if (ne.placement !== null)
                        this.markUnmodellable(ne.placement);

                    if (ret.isNull())
                        ret.opAssign(dfaCommon.makeLatticeRef());

                    const var_ = dfaCommon.getInfiniteLifetimeVariable();
                    const c = ret.addConsequence(var_)!;
                    ret.setContext(c);

                    c.truthiness = Truthiness.True;
                    c.nullable = Nullable.NonNull;
                    c.obj = dfaCommon.makeObject();
                    return ret;
                }

                case EXP.andAnd: {
                    let be = expr.isBinExp();

                    this.stmtWalker!.startScope();
                    dfaCommon.currentDFAScope!.sideEffectFree = true;
                    const inProgress = new DFALatticeRef();

                    // if lhs is false, so will the andAnd

                    // assume rhs could be andAnd
                    while (be !== null) {
                        const lhs = this.walk(be.e1);
                        try {
                            this.seeRead(lhs, be.e1!.loc);

                            {
                                lhs.opAssign(this.adaptConditionForBranch(new DFALatticeRef(lhs), be.e1!.type, true));
                                const c = lhs.getContext();

                                if (c !== null && c.truthiness === Truthiness.False) {
                                    inProgress.opAssign(dfaCommon.makeLatticeRef());
                                    inProgress.acquireConstantAsContextTruthiness(Truthiness.False,
                                            Nullable.Unknown, null);
                                    break; // `lhs` (still holding its lattice) is destroyed on the way out
                                }
                            }

                            this.seeSilentAssert(lhs.copy());

                            if (inProgress.isNull())
                                inProgress.opAssign(new DFALatticeRef(lhs));
                            else
                                inProgress.opAssign(this.seeLogicalAnd(new DFALatticeRef(inProgress),
                                        new DFALatticeRef(lhs)));

                            if (be.e2!.op === EXP.andAnd) {
                                be = be.e2!.isBinExp();
                                continue;
                            }
                            else {
                                const rhs = this.walk(be.e2);
                                try {
                                    this.seeRead(rhs, be.e2!.loc);
                                    rhs.opAssign(this.adaptConditionForBranch(new DFALatticeRef(rhs), be.e2!.type,
                                            true));

                                    {
                                        rhs.opAssign(this.adaptConditionForBranch(new DFALatticeRef(rhs),
                                                be.e1!.type, true));
                                        const c = rhs.getContext();

                                        if (c !== null && c.truthiness === Truthiness.False) {
                                            inProgress.opAssign(dfaCommon.makeLatticeRef());
                                            inProgress.acquireConstantAsContextTruthiness(Truthiness.False,
                                                    Nullable.Unknown, null);
                                            break; // `rhs` then `lhs` are destroyed on the way out
                                        }
                                    }

                                    inProgress.opAssign(this.seeLogicalAnd(new DFALatticeRef(inProgress),
                                            new DFALatticeRef(rhs)));
                                    break;
                                } finally {
                                    rhs.__dtor(); // D destroys the block local at its exit
                                }
                            }
                        } finally {
                            lhs.__dtor(); // D destroys the loop-body local at its exit
                        }
                    }

                    // the popped scope is a discarded temporary, destroyed at once
                    this.stmtWalker!.endScope().__dtor();
                    return inProgress;
                }

                case EXP.orOr: {
                    const predicateNegation: Ref<number> = { value: 0 };
                    return this.walkCondition(expr.isLogicalExp(), predicateNegation);
                }

                case EXP.lessThan: {
                    // < becomes >
                    const be = expr.isBinExp()!;
                    const lhs = this.walk(be.e2);
                    const rhs = this.walk(be.e1);
                    const ret = this.seeGreaterThan(false, new DFALatticeRef(lhs), new DFALatticeRef(rhs));
                    rhs.__dtor(); // D destroys the arm locals (moved, so no-ops)
                    lhs.__dtor();
                    return ret;
                }

                case EXP.lessOrEqual: {
                    // <= becomes >=
                    const be = expr.isBinExp()!;
                    const lhs = this.walk(be.e2);
                    const rhs = this.walk(be.e1);
                    const ret = this.seeGreaterThan(true, new DFALatticeRef(lhs), new DFALatticeRef(rhs));
                    rhs.__dtor(); // D destroys the arm locals (moved, so no-ops)
                    lhs.__dtor();
                    return ret;
                }

                case EXP.greaterThan: {
                    const be = expr.isBinExp()!;
                    const lhs = this.walk(be.e1);
                    const rhs = this.walk(be.e2);
                    const ret = this.seeGreaterThan(false, new DFALatticeRef(lhs), new DFALatticeRef(rhs));
                    rhs.__dtor(); // D destroys the arm locals (moved, so no-ops)
                    lhs.__dtor();
                    return ret;
                }

                case EXP.greaterOrEqual: {
                    const be = expr.isBinExp()!;
                    const lhs = this.walk(be.e1);
                    const rhs = this.walk(be.e2);
                    const ret = this.seeGreaterThan(true, new DFALatticeRef(lhs), new DFALatticeRef(rhs));
                    rhs.__dtor(); // D destroys the arm locals (moved, so no-ops)
                    lhs.__dtor();
                    return ret;
                }

                case EXP.in_: {
                    const be = expr.isBinExp()!;

                    const lhs = this.walk(be.e1);
                    lhs.check();

                    const rhs = this.walk(be.e2);
                    rhs.check();

                    const rhsVar = rhs.getContextVar();

                    // change comparison to: lhs in rhs[...]
                    if (rhsVar !== null)
                        rhs.setContextFromDFAVar(dfaCommon.findIndexVar(rhsVar));

                    const ret = this.seeEqual(new DFALatticeRef(lhs), new DFALatticeRef(rhs), true, be.e1!.type!,
                            be.e2!.type);
                    rhs.__dtor(); // D destroys the arm locals (moved, so no-ops)
                    lhs.__dtor();
                    return ret;
                }

                case EXP.addAssign:
                    return this.walkMathAssignOp(expr.isBinExp()!, PAMathOp.add);
                case EXP.minAssign:
                    return this.walkMathAssignOp(expr.isBinExp()!, PAMathOp.sub);
                case EXP.mulAssign:
                    return this.walkMathAssignOp(expr.isBinExp()!, PAMathOp.mul);
                case EXP.divAssign:
                    return this.walkMathAssignOp(expr.isBinExp()!, PAMathOp.div);
                case EXP.modAssign:
                    return this.walkMathAssignOp(expr.isBinExp()!, PAMathOp.mod);
                case EXP.andAssign:
                    return this.walkMathAssignOp(expr.isBinExp()!, PAMathOp.and);
                case EXP.orAssign:
                    return this.walkMathAssignOp(expr.isBinExp()!, PAMathOp.or);
                case EXP.xorAssign:
                    return this.walkMathAssignOp(expr.isBinExp()!, PAMathOp.xor);
                case EXP.powAssign:
                    return this.walkMathAssignOp(expr.isBinExp()!, PAMathOp.pow);
                case EXP.leftShiftAssign:
                    return this.walkMathAssignOp(expr.isBinExp()!, PAMathOp.leftShift);
                case EXP.rightShiftAssign:
                    return this.walkMathAssignOp(expr.isBinExp()!, PAMathOp.rightShiftSigned);
                case EXP.unsignedRightShiftAssign:
                    return this.walkMathAssignOp(expr.isBinExp()!, PAMathOp.rightShiftUnsigned);

                case EXP.concatenateAssign: // ~=
                    return this.concatenateTwo(expr.isBinExp()!, 0, true);
                case EXP.concatenateElemAssign:
                    return this.concatenateTwo(expr.isBinExp()!, 1, true);
                case EXP.concatenateDcharAssign:
                    return this.concatenateTwo(expr.isBinExp()!, 2, true);

                case EXP.loweredAssignExp: {
                    // Used for changing the length of lhs.
                    // While we can just walk the lowering and it'll "work",
                    //  it won't be good enough.
                    const be = expr.isLoweredAssignExp()!;

                    const ale = be.e1!.isArrayLengthExp();
                    if (ale !== null) {
                        // See: slice.length = rhs
                        dfaCommon.printStateln(ds("length assign lhs"));
                        const lhs = this.walk(ale.e1);
                        dfaCommon.printStateln(ds("length assign rhs"));
                        const rhs = this.walk(be.e2);

                        const lhsCctx = lhs.getContext();
                        let rhsCctx = rhs.getContext();
                        assert(lhsCctx !== null);
                        assert(rhsCctx !== null);

                        {
                            // remove anything that added to the calculation of the point analysis value
                            const rhsPA = rhsCctx.pa.copy();

                            rhs.opAssign(dfaCommon.makeLatticeRef());
                            rhsCctx = rhs.acquireConstantAsContext();
                            rhsCctx.pa = rhsPA.copy();
                        }

                        // We use the rhs truthiness to model the new length
                        // If it is false, the new length is zero, and therefore null.
                        // If it is true, the new length is greater than zero, and therefore non-null.
                        let alteredState = 0;

                        if (rhsCctx === null || rhsCctx.truthiness === Truthiness.Unknown
                                || rhsCctx.truthiness === Truthiness.Maybe) {
                            alteredState = 5;
                        }
                        else {
                            if (rhsCctx.truthiness === Truthiness.True)
                                alteredState = 3;
                            else
                                alteredState = 4;
                        }

                        {
                            const lhsLengthVar = dfaCommon.findSliceLengthVar(lhsCctx.var);
                            lhs.addConsequence(lhsLengthVar, lhsCctx);
                        }

                        const ret = this.seeAssignFromDFALatticeRef(new DFALatticeRef(lhs), false,
                                new DFALatticeRef(rhs), be.loc, false, alteredState);
                        rhs.__dtor(); // D destroys the block locals (moved, so no-ops)
                        lhs.__dtor();
                        return ret;
                    }
                    else {
                        // unknown lowered assign exp, use the lowering.
                        return this.walk(be.lowering);
                    }
                }

                case EXP.add:
                    return this.walkMathOp(expr.isBinExp()!, PAMathOp.add);
                case EXP.min:
                    return this.walkMathOp(expr.isBinExp()!, PAMathOp.sub);
                case EXP.mul:
                    return this.walkMathOp(expr.isBinExp()!, PAMathOp.mul);
                case EXP.div:
                    return this.walkMathOp(expr.isBinExp()!, PAMathOp.div);
                case EXP.mod:
                    return this.walkMathOp(expr.isBinExp()!, PAMathOp.mod);
                case EXP.and:
                    return this.walkMathOp(expr.isBinExp()!, PAMathOp.and);
                case EXP.or:
                    return this.walkMathOp(expr.isBinExp()!, PAMathOp.or);
                case EXP.xor:
                    return this.walkMathOp(expr.isBinExp()!, PAMathOp.xor);
                case EXP.pow:
                    return this.walkMathOp(expr.isBinExp()!, PAMathOp.pow);
                case EXP.leftShift:
                    return this.walkMathOp(expr.isBinExp()!, PAMathOp.leftShift);
                case EXP.rightShift:
                    return this.walkMathOp(expr.isBinExp()!, PAMathOp.rightShiftSigned);
                case EXP.unsignedRightShift:
                    return this.walkMathOp(expr.isBinExp()!, PAMathOp.rightShiftUnsigned);

                case EXP.plusPlus:
                    return this.walkMathAssignOp(expr.isBinExp()!, PAMathOp.postInc);
                case EXP.minusMinus:
                    return this.walkMathAssignOp(expr.isBinExp()!, PAMathOp.postDec);

                case EXP.prePlusPlus: {
                    const effect = dfaCommon.makeLatticeRef();
                    const cctx = effect.acquireConstantAsContext();
                    cctx.pa = DFAPAValue.fromLong(1n);

                    const ret = this.walkMathAssignOpFromUnaExp(expr.isUnaExp()!, new DFALatticeRef(effect),
                            PAMathOp.add);
                    effect.__dtor(); // D destroys the arm local (moved, so a no-op)
                    return ret;
                }
                case EXP.preMinusMinus: {
                    const effect = dfaCommon.makeLatticeRef();
                    const cctx = effect.acquireConstantAsContext();
                    cctx.pa = DFAPAValue.fromLong(1n);

                    const ret = this.walkMathAssignOpFromUnaExp(expr.isUnaExp()!, new DFALatticeRef(effect),
                            PAMathOp.sub);
                    effect.__dtor(); // D destroys the arm local (moved, so a no-op)
                    return ret;
                }

                case EXP.tilde: {
                    const ue = expr.isUnaExp()!;

                    const ret = this.walk(ue.e1);

                    if (ret.isNull()) {
                        ret.opAssign(dfaCommon.makeLatticeRef());
                        ret.acquireConstantAsContext();
                    }
                    else {
                        const cctx = ret.getContext()!;
                        cctx.pa.bitwiseInvert(ue.type!);
                    }

                    return ret;
                }

                case EXP.comma: {
                    const ce = expr.isCommaExp()!;

                    {
                        // We need to recognize the following AST:
                        // (((declaration), (loweredAssignExp)), (var))
                        //                   arrayLengthExp

                        const ce2 = ce.e1!.isCommaExp();
                        const var_ = ce.e2!.isVarExp();

                        if (ce2 !== null && var_ !== null) {
                            const de = ce2.e1!.isDeclarationExp();
                            const lae = ce2.e2!.isLoweredAssignExp();

                            if (de !== null && lae !== null) {
                                const vd = de.declaration!.isVarDeclaration();
                                const laeLength = lae.e1!.isArrayLengthExp();

                                if (var_.var_.isVarDeclaration() === vd && laeLength !== null) {
                                    // (((vd), (lae)), (var))
                                    //          laeLength

                                    // ce.e1 can now be walked just fine, its ce.e2 that is the problem.

                                    dfaCommon.printStateln(ds("comma lhs"));
                                    const lhs = this.walk(ce.e1);
                                    dfaCommon.printStateln(ds("comma rhs"));
                                    const rhs = this.walk(ce.e2);

                                    const rhsCctx = rhs.getContext()!;
                                    const cctx = lhs.acquireConstantAsContext();

                                    cctx.truthiness = rhsCctx.truthiness;
                                    cctx.nullable = rhsCctx.nullable;
                                    cctx.pa = rhsCctx.pa.copy();

                                    rhs.__dtor(); // D destroys the block-local `rhs` here: this frees its lattice
                                    return lhs;
                                }
                            }
                        }
                    }

                    dfaCommon.printStateln(ds("comma lhs"));
                    const lhs = this.walk(ce.e1);
                    dfaCommon.printStateln(ds("comma rhs"));
                    const rhs = this.walk(ce.e2);

                    const rhsVar = rhs.getContextVar();
                    const ret = this.seeLogicalAnd(new DFALatticeRef(lhs), new DFALatticeRef(rhs));

                    if (rhsVar !== null)
                        ret.setContextFromDFAVar(rhsVar);

                    rhs.__dtor(); // D destroys the arm locals (moved, so no-ops)
                    lhs.__dtor();
                    return ret;
                }

                case EXP.structLiteral: {
                    const sle = expr.isStructLiteralExp()!;

                    if (sle.elements !== null) {
                        for (const ele of sle.elements) {
                            if (ele === null)
                                continue;

                            const ae = ele.isAddrExp();
                            if (ae !== null) {
                                const sle2 = ae.e1!.isStructLiteralExp();
                                if (sle2 !== null) {
                                    if (sle.origin === sle2.origin)
                                        continue;
                                }
                            }

                            const temp = this.walk(ele);
                            this.seeConvergeFunctionCallArgument(new DFALatticeRef(temp), null, STC.none, null,
                                    sle.loc);
                            temp.__dtor(); // D destroys the loop-body local (moved, so a no-op)
                        }
                    }

                    const ret = dfaCommon.makeLatticeRef();
                    ret.acquireConstantAsContext();
                    return ret;
                }

                case EXP.tuple: {
                    const te = expr.isTupleExp()!;

                    let expectedContext: DFAVar | null = null;
                    const inProgress = new DFALatticeRef();

                    if (te.e0 !== null) {
                        inProgress.opAssign(this.walk(te.e0));
                        expectedContext = inProgress.getContextVar();
                    }

                    if (inProgress.isNull())
                        inProgress.opAssign(dfaCommon.makeLatticeRef());

                    if (te.exps !== null) {
                        for (const exp of te.exps) {
                            inProgress.opAssign(this.seeLogicalAnd(new DFALatticeRef(inProgress), this.walk(exp)));
                        }
                    }

                    if (inProgress.isNull())
                        inProgress.opAssign(dfaCommon.makeLatticeRef());

                    const c = inProgress.addConsequence(expectedContext)!;
                    inProgress.setContext(c);

                    if (expectedContext === null) {
                        c.nullable = Nullable.Unknown;
                        c.truthiness = Truthiness.Unknown;
                    }

                    return inProgress;
                }

                case EXP.question: {
                    const qe = expr.isCondExp()!;

                    const origScope = dfaCommon.currentDFAScope;
                    // dropped: `dfaCommon.printState(...)` (expression.d:1395), debug dump (file header)

                    let ignoreTrueBranch = false, ignoreFalseBranch = false;
                    let unknownBranchTaken = false;
                    const predicateNegation: Ref<number> = { value: 0 };
                    const conditionLR = new DFALatticeRef();
                    let conditionVar: DFAVar | null = null;

                    {
                        this.stmtWalker!.startScope();
                        dfaCommon.currentDFAScope!.sideEffectFree = true;

                        dfaCommon.printStateln(ds("Question condition:"));
                        conditionLR.opAssign(this.walkCondition(qe.econd, predicateNegation));
                        conditionVar = conditionLR.getGateConsequenceVariable();

                        this.stmtWalker!.endScope().__dtor(); // the popped scope is a discarded temporary
                    }

                    {
                        dfaCommon.printStateln(ds("Question true branch:"));
                        this.stmtWalker!.startScope();
                        dfaCommon.currentDFAScope!.inConditional = true;

                        const c = conditionLR.getContext();
                        if (c !== null) {
                            if (c.truthiness === Truthiness.False)
                                ignoreTrueBranch = true;
                            else if (c.truthiness === Truthiness.True)
                                ignoreFalseBranch = true;
                            else
                                unknownBranchTaken = true;
                        }
                        else
                            unknownBranchTaken = true;

                        const trueCondition = this.adaptConditionForBranch(conditionLR.copy(), qe.econd!.type, true);
                        this.seeSilentAssert(new DFALatticeRef(trueCondition), true, true);
                        this.stmtWalker!.applyGateOnBranch(conditionVar, predicateNegation.value, true);
                        trueCondition.__dtor(); // D destroys the block local (moved, so a no-op)
                    }

                    const scrTrue = new DFAScopeRef(), scrFalse = new DFAScopeRef();
                    const lrTrue = new DFALatticeRef(), lrFalse = new DFALatticeRef();

                    if (!ignoreTrueBranch) {
                        lrTrue.opAssign(this.walk(qe.e1));
                        assert(dfaCommon.currentDFAScope !== origScope);
                    }

                    scrTrue.opAssign(this.stmtWalker!.endScope());
                    scrTrue.check();

                    assert(dfaCommon.currentDFAScope === origScope);

                    {
                        dfaCommon.printStateln(ds("Question false branch:"));
                        this.stmtWalker!.startScope();
                        dfaCommon.currentDFAScope!.inConditional = true;

                        if (!ignoreTrueBranch) {
                            const falseCondition = this.adaptConditionForBranch(conditionLR.copy(),
                                    qe.econd!.type, false);
                            this.seeSilentAssert(new DFALatticeRef(falseCondition), true, true);
                            falseCondition.__dtor(); // D destroys the block local (moved, so a no-op)
                        }

                        this.stmtWalker!.applyGateOnBranch(conditionVar, predicateNegation.value, false);

                        if (!ignoreFalseBranch)
                            lrFalse.opAssign(this.walk(qe.e2));

                        scrFalse.opAssign(this.stmtWalker!.endScope());
                        scrFalse.check();
                    }

                    const ret = this.seeConditional(new DFALatticeRef(conditionLR), new DFAScopeRef(scrTrue),
                            new DFALatticeRef(lrTrue), new DFAScopeRef(scrFalse), new DFALatticeRef(lrFalse),
                            unknownBranchTaken, predicateNegation.value);
                    // D destroys the arm locals in reverse declaration order (all moved, so no-ops)
                    lrFalse.__dtor();
                    lrTrue.__dtor();
                    scrFalse.__dtor();
                    scrTrue.__dtor();
                    conditionLR.__dtor();
                    return ret;
                }

                case EXP.delegate_:
                case EXP.function_:
                    // known no-op
                    return new DFALatticeRef();

                case EXP.concatenate: {
                    const be = expr.isBinExp()!;
                    const beTypeBT = toBasetype(be.type!);
                    const lhsIsArray = toBasetype(be.e1!.type!).equals(beTypeBT);
                    const rhsIsArray = toBasetype(be.e2!.type!).equals(beTypeBT);
                    // D indexes with `lhsIsArray + (rhsIsArray * 2)`, bools promoted to int
                    const op = [3, 1, 4, 0][(lhsIsArray ? 1 : 0) + ((rhsIsArray ? 1 : 0) * 2)];

                    return this.concatenateTwo(be, op);
                }

                case EXP.vector:
                case EXP.vectorArray:
                case EXP.delegatePointer:
                case EXP.delegateFunctionPointer: {
                    const ue = expr.isUnaExp()!;
                    return this.walk(ue.e1);
                }

                case EXP.throw_: {
                    const te = expr.isThrowExp()!;
                    dfaCommon.currentDFAScope!.haveJumped = true;
                    dfaCommon.currentDFAScope!.haveReturned = true;
                    return this.walk(te.e1);
                }

                case EXP.type:
                    // holds a type, known no-op
                    return new DFALatticeRef();

                case EXP.reserved:

                    // Other
                case EXP.is_: //is()
                case EXP.array:
                case EXP.delete_:
                case EXP.dotIdentifier:
                case EXP.dotTemplateInstance:
                case EXP.dotType:
                case EXP.dollar:
                case EXP.template_:
                case EXP.dotTemplateDeclaration:
                case EXP.dSymbol:
                case EXP.uadd:
                case EXP.remove:
                case EXP.newAnonymousClass:
                case EXP.classReference:
                case EXP.thrownException:

                    // Operators

                case EXP.dot:

                    // Leaf operators
                case EXP.identifier:
                case EXP.interpolated:
                case EXP.super_:
                case EXP.error:

                case EXP.import_:
                case EXP.mixin_:
                case EXP.break_:
                case EXP.continue_:
                case EXP.goto_:
                case EXP.scope_:

                case EXP.traits:
                case EXP.overloadSet:
                case EXP.line:
                case EXP.file:
                case EXP.fileFullPath:
                case EXP.moduleString: // __MODULE__
                case EXP.functionString: // __FUNCTION__
                case EXP.prettyFunction: // __PRETTY_FUNCTION__

                case EXP.voidExpression:
                case EXP.cantExpression:
                case EXP.showCtfeContext:
                case EXP.objcClassReference:
                case EXP.compoundLiteral: // ( type-name ) { initializer-list }
                case EXP._Generic:
                case EXP.interval:

                case EXP.rvalue:
                    if (debugUnknownAST) {
                        // fprintf(stderr, ...): one assembled stderr write (10 §4.4)
                        process.stderr.write(dsToJs(dmdformat(ds("Unknown DFA walk expression %d at %s\n"),
                                [expr.op, expr.loc.toChars()])));
                        assertUnreachable();
                    }
                    else
                        return new DFALatticeRef();

                default: {
                    // final switch: D throws SwitchError on an unhandled value
                    const _exhaustive: never = expr.op;
                    void _exhaustive;
                    throw new SwitchError();
                }
            }
        } finally {
            dfaCommon.check();
            dfaCommon.edepth--;
        }
    }

    /// Walks an expression that is used for a condition i.e. and if statement.
    /// Tells you if the expression for the gate variable, will be exact, vs negated state.
    /// Applying by test is for when (expr) > 0, use 0 for unknown, 1 is <= 0 and 2 is > 0
    /// Returns: 0 for unknown negation, 1 or has been negated from gate variable or 2 if it hasn't been.
    ///
    /// dmd/dfa/fast/expression.d:1583 — `DFALatticeRef walkCondition(Expression expr, out int predicateNegation)`.
    /// `predicateNegation` is an `out` box (reset on entry, written at every exit): 0 when some sub-expression is not
    /// a gate conditional, else 1 when the outcome was negated an odd number of times, 2 otherwise. `a || b || ...`
    /// chains are walked in a side-effect-free scope, each operand in its own.
    walkCondition(expr: Expression | null, predicateNegation: Ref<number>): DFALatticeRef {
        predicateNegation.value = 0; // `out` parameter reset on entry (03 §3.3)
        let allGateConditional = true;
        const outComeNegated: Ref<boolean> = { value: false };

        const dfaCommon = this.dfaCommon!;
        dfaCommon.edepth++;

        try {
            // dropped: `dfaCommon.printStructure(...)` (expression.d:1600), debug dump (file header)

            const negateApplyByTest = (val: number): number => {
                if (val === 1)
                    return 2;
                else if (val === 2)
                    return 1;
                else
                    return 0;
            };

            const canBeInverted = (expr: Expression): boolean => {
                switch (expr.op) {

                    case EXP.typeid_:
                    case EXP.arrayLiteral:
                    case EXP.assocArrayLiteral:
                    case EXP.arrayLength:
                    case EXP.null_:
                    case EXP.cast_:
                    case EXP.variable:
                    default:
                        return false;

                    case EXP.int64:
                    case EXP.string_:
                        return true;

                    case EXP.not: { // !x
                        const ue = expr.isUnaExp()!;
                        if (ue.e1!.isInExp() !== null)
                            return false;
                        return canBeInverted(ue.e1!);
                    }

                    case EXP.orOr:
                    case EXP.notEqual: // !=
                    case EXP.notIdentity: // !is
                    case EXP.equal: // ==
                    case EXP.identity: // is
                    case EXP.lessThan:
                    case EXP.lessOrEqual:
                    case EXP.greaterThan:
                    case EXP.greaterOrEqual: {
                        const be = expr.isBinExp()!;
                        return canBeInverted(be.e1!) && canBeInverted(be.e2!);
                    }
                }
            };

            const seeExp = (expr: Expression, negated: Ref<boolean>, applyByTest: number): DFALatticeRef => {
                dfaCommon.check();
                dfaCommon.edepth++;
                try {
                    // dropped: `dfaCommon.printStructure(...)` (expression.d:1666), debug dump (file header)

                    switch (expr.op) {
                        case EXP.not: { // !x
                            negated.value = !negated.value; // !!x
                            const ue = expr.isUnaExp()!;

                            const ie = ue.e1!.isInExp();
                            if (ie !== null) {
                                allGateConditional = false;

                                const lhs = seeExp(ie.e1!, negated, 0);
                                lhs.check();

                                const rhs = seeExp(ie.e2!, negated, 0);
                                rhs.check();

                                const rhsVar = rhs.getContextVar();

                                // change comparison to: lhs in rhs[...]
                                if (rhsVar !== null)
                                    rhs.setContextFromDFAVar(dfaCommon.findIndexVar(rhsVar));

                                const ret = this.seeEqual(new DFALatticeRef(lhs), new DFALatticeRef(rhs), false,
                                        ie.e1!.type!, ie.e2!.type);
                                rhs.__dtor(); // D destroys the block locals (moved, so no-ops)
                                lhs.__dtor();
                                return ret;
                            }
                            else {
                                const lr = seeExp(ue.e1!, negated, negateApplyByTest(applyByTest));
                                // the lvalue branch of `?:` is copy-constructed
                                const ret = (applyByTest !== 0) ? new DFALatticeRef(lr)
                                    : this.seeNegate(new DFALatticeRef(lr), ue.type);
                                lr.__dtor(); // D destroys the block local (moved, so a no-op)
                                return ret;
                            }
                        }

                        case EXP.notEqual: { // !=
                            negated.value = !negated.value;
                            const be = expr.isBinExp()!;

                            const negated2: Ref<boolean> = { value: false };

                            dfaCommon.printStateln(ds("!equal lhs"));
                            const lhs = seeExp(be.e1!, negated2, 0);
                            dfaCommon.printStateln(ds("!equal rhs"));
                            const rhs = seeExp(be.e2!, negated2, 0);

                            const ret = this.seeEqual(new DFALatticeRef(lhs), new DFALatticeRef(rhs), applyByTest === 2,
                                    be.e1!.type!, be.e2!.type);
                            rhs.__dtor(); // D destroys the arm locals (moved, so no-ops)
                            lhs.__dtor();
                            return ret;
                        }

                        case EXP.notIdentity: { // !is
                            negated.value = !negated.value;
                            const be = expr.isBinExp()!;

                            const negated2: Ref<boolean> = { value: false };

                            dfaCommon.printStateln(ds("!is lhs"));
                            const lhs = seeExp(be.e1!, negated2, 0);
                            dfaCommon.printStateln(ds("!is rhs"));
                            const rhs = seeExp(be.e2!, negated2, 0);

                            const ret = this.seeEqualIdentity(new DFALatticeRef(lhs), new DFALatticeRef(rhs),
                                    applyByTest === 2, be.e1!.type!, be.e2!.type);
                            rhs.__dtor(); // D destroys the arm locals (moved, so no-ops)
                            lhs.__dtor();
                            return ret;
                        }

                        case EXP.equal: { // ==
                            const be = expr.isBinExp()!;
                            const negated2: Ref<boolean> = { value: false };

                            dfaCommon.printStateln(ds("equal lhs"));
                            const lhs = seeExp(be.e1!, negated2, 0);
                            dfaCommon.printStateln(ds("equal rhs"));
                            const rhs = seeExp(be.e2!, negated2, 0);

                            const ret = this.seeEqual(new DFALatticeRef(lhs), new DFALatticeRef(rhs), applyByTest !== 1,
                                    be.e1!.type!, be.e2!.type);
                            rhs.__dtor(); // D destroys the arm locals (moved, so no-ops)
                            lhs.__dtor();
                            return ret;
                        }

                        case EXP.identity: { // is
                            const be = expr.isBinExp()!;
                            const negated2: Ref<boolean> = { value: false };

                            dfaCommon.printStateln(ds("is lhs"));
                            const lhs = seeExp(be.e1!, negated2, 0);
                            dfaCommon.printStateln(ds("is rhs"));
                            const rhs = seeExp(be.e2!, negated2, 0);

                            const ret = this.seeEqualIdentity(new DFALatticeRef(lhs), new DFALatticeRef(rhs),
                                    applyByTest !== 1, be.e1!.type!, be.e2!.type);
                            rhs.__dtor(); // D destroys the arm locals (moved, so no-ops)
                            lhs.__dtor();
                            return ret;
                        }

                        case EXP.string_: {
                            const se = expr.isStringExp()!;

                            // A string literal even when empty will be non-null and true.
                            const ret = dfaCommon.makeLatticeRef();

                            const var_ = dfaCommon.getInfiniteLifetimeVariable();
                            const cctx = ret.addConsequence(var_)!;
                            ret.setContext(cctx);

                            cctx.truthiness = se.len > 0 ? Truthiness.True : Truthiness.Maybe;
                            cctx.nullable = Nullable.NonNull;
                            cctx.obj = dfaCommon.makeObject();
                            cctx.pa = DFAPAValue.fromLong(BigInt(se.len));
                            return ret;
                        }

                        case EXP.typeid_: {
                            const te = expr.isTypeidExp()!;
                            const ret = new DFALatticeRef();

                            // D tests `te.obj` at every level, never `ro`: a tuple object recurses on itself
                            // (faithful), so `ro` is unused.
                            const seeTypeIdObject = (_ro: RootObject | null): void => {
                                const e = isExpression(te.obj);
                                const v = e === null ? isTuple(te.obj) : null;
                                if (e !== null) {
                                    // [!val] does not effect the literal, gate capabilitiy
                                    const temp = seeExp(e, negated, 0);

                                    if (!ret.isNull())
                                        ret.opAssign(this.seeLogicalAnd(new DFALatticeRef(ret),
                                                new DFALatticeRef(temp)));
                                    else
                                        ret.opAssign(new DFALatticeRef(temp));
                                    temp.__dtor(); // D destroys the block local (moved, so a no-op)
                                }
                                else if (v !== null) {
                                    for (const obj of v.objects) {
                                        seeTypeIdObject(obj);
                                    }
                                }
                            };

                            seeTypeIdObject(te.obj);

                            if (ret.isNull())
                                ret.opAssign(dfaCommon.makeLatticeRef());

                            const var_ = dfaCommon.getInfiniteLifetimeVariable();
                            const cctx = ret.addConsequence(var_)!;
                            ret.setContext(cctx);

                            cctx.truthiness = Truthiness.True;
                            cctx.nullable = Nullable.NonNull;
                            cctx.obj = dfaCommon.makeObject();
                            return ret;
                        }

                        case EXP.arrayLiteral: {
                            const ale = expr.isArrayLiteralExp()!;
                            const ret = dfaCommon.makeLatticeRef();

                            if (ale.elements !== null && ale.elements.length > 0) {
                                for (const ele of ale.elements) {
                                    if (ele !== null)
                                        this.seeConvergeFunctionCallArgument(seeExp(ele, negated, 0), null, STC.none,
                                                null, ele.loc);
                                }

                                const var_ = dfaCommon.getInfiniteLifetimeVariable();
                                const cctx = ret.addConsequence(var_)!;
                                ret.setContext(cctx);

                                cctx.truthiness = Truthiness.True;
                                cctx.nullable = Nullable.NonNull;
                                cctx.pa = DFAPAValue.fromLong(BigInt(ale.elements.length));
                                cctx.obj = dfaCommon.makeObject();
                            }
                            else
                                ret.acquireConstantAsContextTruthiness(Truthiness.Maybe, Nullable.Null, null);

                            return ret;
                        }

                        case EXP.assocArrayLiteral: {
                            const aale = expr.isAssocArrayLiteralExp()!;
                            const ret = dfaCommon.makeLatticeRef();

                            if (aale.keys !== null && aale.keys.length > 0) {
                                const var_ = dfaCommon.getInfiniteLifetimeVariable();
                                const cctx = ret.addConsequence(var_)!;
                                ret.setContext(cctx);

                                cctx.truthiness = Truthiness.True;
                                cctx.nullable = Nullable.NonNull;
                                cctx.obj = dfaCommon.makeObject();
                            }
                            else
                                ret.acquireConstantAsContextTruthiness(Truthiness.False, Nullable.Null, null);

                            return ret;
                        }

                        case EXP.arrayLength: {
                            // This is supposed to be a read only,
                            // Lowered assign expression will handle the write version.

                            const ue = expr.isUnaExp()!;

                            const ret = seeExp(ue.e1!, negated, 0);
                            const cctx = ret.getContext();

                            if (ret.isNull()) {
                                ret.opAssign(dfaCommon.makeLatticeRef());
                                ret.acquireConstantAsContext();
                            }
                            else if (cctx === null || cctx.var === null)
                                ret.acquireConstantAsContext();
                            else {
                                const ctx = dfaCommon.findSliceLengthVar(cctx.var);

                                const newCctx = ret.addConsequence(ctx)!;
                                newCctx.truthiness = cctx.truthiness;
                                newCctx.pa = cctx.pa.copy();
                                newCctx.maybe = cctx.var;

                                ret.setContext(newCctx);
                            }

                            return ret;
                        }

                        case EXP.null_: {
                            const ret = dfaCommon.makeLatticeRef();

                            const c = ret.addConsequence(null)!;
                            ret.setContext(c);

                            c.truthiness = Truthiness.False;
                            c.nullable = Nullable.Null;
                            c.pa = DFAPAValue.fromLong(0n);

                            return ret;
                        }

                        case EXP.int64: {
                            const ie = expr.isIntegerExp()!;

                            const b = toBool(ie);
                            if (!b.isPresent())
                                return new DFALatticeRef();

                            const ret = dfaCommon.makeLatticeRef();
                            const c = ret.addConsequence(null)!;
                            ret.setContext(c);

                            const ty = toBasetype(ie.type!).ty;

                            if (ty !== TY.Tpointer) {
                                c.pa = DFAPAValue.fromLong(0n);
                                const value = ie.getInteger();

                                switch (ty) {
                                    case TY.Tbool:
                                        c.pa.value = value !== 0n ? 1n : 0n;
                                        break;

                                    case TY.Tint8:
                                        c.pa.value = maskSignedN(8, value);
                                        break;

                                    case TY.Tchar:
                                    case TY.Tuns8:
                                        c.pa.value = maskUnsignedN(8, value);
                                        break;

                                    case TY.Tint16:
                                        c.pa.value = maskSignedN(16, value);
                                        break;

                                    case TY.Twchar:
                                    case TY.Tuns16:
                                        c.pa.value = maskUnsignedN(16, value);
                                        break;

                                    case TY.Tint32:
                                        c.pa.value = maskSignedN(32, value);
                                        break;

                                    case TY.Tdchar:
                                    case TY.Tuns32:
                                        c.pa.value = maskUnsignedN(32, value);
                                        break;

                                    case TY.Tint64:
                                        c.pa.value = toInt64(value);
                                        break;

                                    case TY.Tuns64:
                                        c.pa.value = toInt64(value); // `cast(ulong) value` stored into the long field

                                        if (toUint64(value) > 0x7FFF_FFFF_FFFF_FFFFn) // value > long.max, as a ulong
                                            c.pa.kind = DFAPAValue.Kind.UnknownUpperPositive;
                                        break;

                                    default:
                                        // printf: one assembled stdout write (10 §4.4)
                                        process.stdout.write(dsToJs(dmdformat(ds("integer type %d\n"), [ty])));
                                        assertUnreachable("Unknown integer type");
                                }

                                c.truthiness = c.pa.value > 0n ? Truthiness.True : Truthiness.False;
                            }

                            return ret;
                        }

                        case EXP.cast_: {
                            const ce = expr.isCastExp()!;

                            // dropped: `dfaCommon.printState(...)` (expression.d:1994), debug dump (file header)

                            const ret = seeExp(ce.e1!, negated, 0);
                            ret.check();

                            if (ce.to === null || ce.to.isTypeClass() !== null || ce.to === Type.tvoid) {
                                // For classes: ideally we'd model up casts, and only disallow down casts
                                // For void: no side effects wrt. convergance

                                ret.opAssign(dfaCommon.makeLatticeRef());
                                ret.acquireConstantAsContextTruthiness(Truthiness.Unknown, Nullable.Unknown, null);
                            }
                            else {
                                if (ret.isNull())
                                    ret.opAssign(dfaCommon.makeLatticeRef());

                                const paHandled = false; // D declares it and never sets it

                                const baseVar: Ref<DFAVar | null> = { value: null };
                                let cctx = ret.getContext(baseVar);
                                if (cctx === null)
                                    cctx = ret.acquireConstantAsContext();

                                if (baseVar.value !== null) {
                                    if (baseVar.value.isNullable && !isTypeNullable(ce.to)) {
                                        // This prevents pointer integer checks from infecting pointers

                                        cctx = ret.acquireConstantAsContextTruthiness(cctx.truthiness,
                                                cctx.nullable, null);
                                    }
                                    else if (baseVar.value.isStaticArray && ce.to.isTypeDArray() !== null) {
                                        const asSliceVar = dfaCommon.findAsSliceVar(baseVar.value);

                                        const truthiness = cctx.truthiness;
                                        const oldPA = cctx.pa.copy();
                                        const newObj: DFAObject | null = cctx.obj !== null ? cctx.obj
                                            : dfaCommon.makeObjectFromDFAVar(baseVar.value);

                                        cctx = ret.addConsequence(asSliceVar)!;
                                        ret.setContext(cctx);

                                        cctx.nullable = Nullable.NonNull;
                                        cctx.truthiness = truthiness;
                                        cctx.pa = oldPA.copy();
                                        cctx.obj = newObj;
                                    }
                                }

                                // If we're doing any kind of cast to anything that is not an integer,
                                //  we have no idea if VRP is going to still be accurate.
                                if (!paHandled && !cctx.pa.canFitIn(ce.to))
                                    cctx.pa = Unknown.copy();
                            }

                            return ret;
                        }

                        case EXP.variable: {
                            const ve = expr.isVarExp();
                            assert(ve !== null);

                            const ret = new DFALatticeRef();

                            if (ve.var_ !== null) {
                                const vd = ve.var_.isVarDeclaration();
                                if (vd !== null) {
                                    if (vd.ident === Id.withSym) {
                                        // Copied from function semantic analysis checkNestedReference function.
                                        // With statements sometimes have temporaries that do get written out,
                                        //  pretend we're the initializer instead.

                                        const ez = vd._init!.isExpInitializer();
                                        assert(ez !== null);

                                        let e = ez.exp!;
                                        if (e.op === EXP.construct || e.op === EXP.blit)
                                            e = e.isBinExp()!.e2!; // D `(cast(AssignExp) e).e2` (file header)

                                        return this.walk(e);
                                    }

                                    const var_ = dfaCommon.findVariable(vd);

                                    if (var_ !== null) {
                                        ret.opAssign(dfaCommon.acquireLattice(var_));
                                        ret.check();
                                        assert(!ret.isNull());

                                        if (applyByTest !== 0) {
                                            const cctx = ret.getContext();
                                            assert(cctx !== null);

                                            if (var_.isNullable && cctx.nullable === Nullable.Unknown)
                                                cctx.nullable = applyByTest === 2 ? Nullable.NonNull : Nullable.Null;

                                            if (var_.isTruthy && cctx.truthiness === Truthiness.Unknown)
                                                cctx.truthiness = applyByTest === 2
                                                    ? Truthiness.True : Truthiness.False;
                                        }

                                        return ret;
                                    }
                                }
                            }

                            // no other declarations really apply for the DFA
                            ret.opAssign(dfaCommon.makeLatticeRef());
                            ret.setContextFromDFAVar(dfaCommon.getUnknownVar());

                            return ret;
                        }

                        default:
                            allGateConditional = false;
                            return this.walk(expr);
                    }
                } finally {
                    dfaCommon.check();
                    dfaCommon.edepth--;
                }
            };

            const seeExpInOr = (expr: Expression, invert: boolean): DFALatticeRef => {
                dfaCommon.check();
                dfaCommon.edepth++;
                try {
                    // dropped: `dfaCommon.printStructure(...)` (expression.d:2135), debug dump (file header)

                    // The four labelled tails of the switch below (BAIL, 06 §4): each builds its result and returns.
                    // LessThan: < becomes >
                    const LessThanTail = (): DFALatticeRef => {
                        const be = expr.isBinExp()!;
                        const negated: Ref<boolean> = { value: false };

                        const lhs = seeExp(be.e2!, negated, 0);
                        const rhs = seeExp(be.e1!, negated, 0);
                        const ret = this.seeGreaterThan(false, new DFALatticeRef(lhs), new DFALatticeRef(rhs));
                        rhs.__dtor(); // D destroys the arm locals (moved, so no-ops)
                        lhs.__dtor();
                        return ret;
                    };
                    // LessThanEqual: <= becomes >=
                    const LessThanEqualTail = (): DFALatticeRef => {
                        const be = expr.isBinExp()!;
                        const negated: Ref<boolean> = { value: false };

                        const lhs = seeExp(be.e2!, negated, 0);
                        const rhs = seeExp(be.e1!, negated, 0);
                        const ret = this.seeGreaterThan(true, new DFALatticeRef(lhs), new DFALatticeRef(rhs));
                        rhs.__dtor(); // D destroys the arm locals (moved, so no-ops)
                        lhs.__dtor();
                        return ret;
                    };
                    // GreaterThan:
                    const GreaterThanTail = (): DFALatticeRef => {
                        const be = expr.isBinExp()!;
                        const negated: Ref<boolean> = { value: false };

                        const lhs = seeExp(be.e1!, negated, 0);
                        const rhs = seeExp(be.e2!, negated, 0);
                        const ret = this.seeGreaterThan(false, new DFALatticeRef(lhs), new DFALatticeRef(rhs));
                        rhs.__dtor(); // D destroys the arm locals (moved, so no-ops)
                        lhs.__dtor();
                        return ret;
                    };
                    // GreaterThanEqual:
                    const GreaterThanEqualTail = (): DFALatticeRef => {
                        const be = expr.isBinExp()!;
                        const negated: Ref<boolean> = { value: false };

                        const lhs = seeExp(be.e1!, negated, 0);
                        const rhs = seeExp(be.e2!, negated, 0);
                        const ret = this.seeGreaterThan(true, new DFALatticeRef(lhs), new DFALatticeRef(rhs));
                        rhs.__dtor(); // D destroys the arm locals (moved, so no-ops)
                        lhs.__dtor();
                        return ret;
                    };

                    switch (expr.op) {
                        case EXP.orOr: {
                            const predicateNegation: Ref<number> = { value: 0 };
                            const ret = this.walkCondition(expr.isLogicalExp(), predicateNegation);
                            if (invert) {
                                const r = this.seeNegate(new DFALatticeRef(ret), expr.type);
                                ret.__dtor(); // D destroys the arm local (moved, so a no-op)
                                return r;
                            }
                            else
                                return ret;
                        }

                        case EXP.lessThan:
                            if (invert)
                                return GreaterThanTail(); // goto GreaterThan (dmd/dfa/fast/expression.d:2154)
                            return LessThanTail();

                        case EXP.lessOrEqual:
                            if (invert)
                                return GreaterThanEqualTail(); // goto GreaterThanEqual (dmd/dfa/fast/expression.d:2166)
                            return LessThanEqualTail();

                        case EXP.greaterThan:
                            if (invert)
                                return LessThanTail(); // goto LessThan (dmd/dfa/fast/expression.d:2178)
                            return GreaterThanTail();

                        case EXP.greaterOrEqual:
                            if (invert)
                                return LessThanEqualTail(); // goto LessThanEqual (dmd/dfa/fast/expression.d:2189)
                            return GreaterThanEqualTail();

                        default: {
                            const negated: Ref<boolean> = { value: false };
                            return seeExp(expr, negated, invert ? 1 : 2);
                        }
                    }
                } finally {
                    dfaCommon.check();
                    dfaCommon.edepth--;
                }
            };

            // In theory a gate condition can support more expressions, but to be on the safe side, let's call this
            // good.
            switch (expr!.op) {
                case EXP.not: // !x
                case EXP.variable:
                case EXP.cast_:
                case EXP.null_:
                case EXP.int64:
                case EXP.arrayLength:
                case EXP.string_:
                case EXP.typeid_:
                case EXP.arrayLiteral:
                case EXP.assocArrayLiteral:
                case EXP.equal: // ==
                case EXP.identity: // is
                case EXP.notEqual: // !=
                case EXP.notIdentity: // !is
                    return seeExp(expr!, outComeNegated, 0);

                case EXP.orOr: {
                    const canThisBeInverted = canBeInverted(expr!);
                    let oe = expr!.isLogicalExp();
                    const inProgress = new DFALatticeRef();

                    this.stmtWalker!.startScope();
                    dfaCommon.currentDFAScope!.sideEffectFree = true;
                    try {
                        while (oe !== null) {
                            const lhs = new DFALatticeRef();
                            const toNegate = new DFALatticeRef();
                            try {
                                {
                                    // Make sure any effects converged into the scope by and expressions ext. don't
                                    // effect rhs
                                    this.stmtWalker!.startScope();
                                    dfaCommon.currentDFAScope!.sideEffectFree = true;

                                    if (canThisBeInverted) {
                                        dfaCommon.printStructureln(ds("Or expression lhs:"));

                                        lhs.opAssign(seeExpInOr(oe.e1!, false));
                                    }
                                    else {
                                        dfaCommon.printStructureln(ds("Or expression lhs walk-adapt:"));
                                        lhs.opAssign(this.walk(oe.e1));
                                        toNegate.opAssign(this.adaptConditionForBranch(lhs.copy(), oe.e1!.type, false));
                                    }

                                    this.seeRead(lhs, oe.e1!.loc);
                                    lhs.printState(ds("or lhs"), dfaCommon.sdepth,
                                            dfaCommon.currentFunction, dfaCommon.edepth);

                                    this.stmtWalker!.endScope().__dtor(); // a discarded temporary

                                    if (inProgress.isNull())
                                        inProgress.opAssign(new DFALatticeRef(lhs));
                                    else
                                        inProgress.opAssign(this.seeLogicalOr(new DFALatticeRef(inProgress),
                                                new DFALatticeRef(lhs)));
                                }

                                if (toNegate.isNull()) {
                                    dfaCommon.printStructureln(ds("Or expression lhs inverted:"));
                                    this.seeSilentAssert(seeExpInOr(oe.e1!, true));
                                }
                                else {
                                    this.seeSilentAssert(new DFALatticeRef(toNegate), false, true);
                                }

                                if (oe.e2!.op === EXP.orOr) {
                                    oe = oe.e2!.isLogicalExp();
                                    continue;
                                }
                                else {
                                    // Make sure any effects converged into the scope by and expressions ext. don't
                                    // effect rhs or return
                                    this.stmtWalker!.startScope();
                                    dfaCommon.currentDFAScope!.sideEffectFree = true;

                                    // e2 is the right most or expression in chain (a || b || c) where it is c
                                    dfaCommon.printStructureln(ds("Or expression rhs:"));
                                    // don't care about seeExpInOr here, can just do a normal walk
                                    const rhs = this.walk(oe.e2);
                                    rhs.printState(ds("or rhs"), dfaCommon.sdepth,
                                            dfaCommon.currentFunction, dfaCommon.edepth);
                                    this.seeRead(rhs, oe.e2!.loc);

                                    this.stmtWalker!.endScope().__dtor(); // a discarded temporary

                                    inProgress.opAssign(this.seeLogicalOr(new DFALatticeRef(inProgress),
                                            new DFALatticeRef(rhs)));
                                    rhs.__dtor(); // D destroys the block local (moved, so a no-op)
                                    break;
                                }
                            } finally {
                                // D destroys the loop-body locals in reverse declaration order (moved: no-ops)
                                toNegate.__dtor();
                                lhs.__dtor();
                            }
                        }

                        return inProgress;
                    } finally {
                        // scope (exit) stmtWalker.endScope; — its result is a discarded temporary
                        this.stmtWalker!.endScope().__dtor();
                    }
                }

                default:
                    return this.walk(expr);
            }
        } finally {
            dfaCommon.edepth--;

            if (!allGateConditional)
                predicateNegation.value = 0;
            else
                predicateNegation.value = outComeNegated.value ? 1 : 2;
        }
    }

    /**
     * dmd/dfa/fast/expression.d:2313 — `DFALatticeRef walkMathOp(BinExp be, PAMathOp op)`. `be.e1 op be.e2`: both
     * operands walked and read (a read of an uninitialized operand reports), then seeMathOp in `be.type`.
     */
    walkMathOp(be: BinExp, op: PAMathOp): DFALatticeRef {
        const dfaCommon = this.dfaCommon!;
        dfaCommon.printStateln(ds("math op lhs"));
        const lhs = this.walk(be.e1);
        this.seeReadMathOp(lhs, be.e1!.loc);
        lhs.check();

        dfaCommon.printStateln(ds("math op rhs"));
        const rhs = this.walk(be.e2);
        this.seeReadMathOp(rhs, be.e2!.loc);
        rhs.check();

        const ret = this.seeMathOp(new DFALatticeRef(lhs), new DFALatticeRef(rhs), be.type!, op);
        ret.check();
        rhs.__dtor(); // D destroys the locals (moved, so no-ops)
        lhs.__dtor();
        return ret;
    }

    /**
     * dmd/dfa/fast/expression.d:2330 — `DFALatticeRef walkMathAssignOp(BinExp be, PAMathOp op)`. `be.e1 op= be.e2`:
     * the math op on a copy of the left-hand lattice, assigned back to it. A post-increment / post-decrement
     * (`postInc` / `postDec`) computes `+ 1` / `- 1` but answers a constant carrying the OLD point-analysis value.
     * The result's object is the left-hand one, marked as possibly not an exact pointer.
     */
    walkMathAssignOp(be: BinExp, op: PAMathOp): DFALatticeRef {
        const dfaCommon = this.dfaCommon!;
        dfaCommon.printStateln(ds("math assign1 op lhs"));
        const lhs = this.walk(be.e1);
        assert(!lhs.isNull());
        lhs.check();

        const lhsCctx = lhs.getContext();
        assert(lhsCctx !== null);

        dfaCommon.printStateln(ds("math assign1 op rhs"));
        const rhs = this.walk(be.e2);
        rhs.check();
        this.seeReadMathOp(rhs, be.e2!.loc);

        let oldPA = new DFAPAValue();
        let useOldPA = false;

        if (op === PAMathOp.postInc) {
            op = PAMathOp.add;
            useOldPA = true;
            oldPA = lhsCctx.pa.copy();
        }
        else if (op === PAMathOp.postDec) {
            op = PAMathOp.sub;
            useOldPA = true;
            oldPA = lhsCctx.pa.copy();
        }

        const lhsObject = lhsCctx.obj;
        const ret = this.seeMathOp(lhs.copy(), new DFALatticeRef(rhs), be.type!, op);
        ret.check();

        ret.opAssign(this.seeAssignFromDFALatticeRef(new DFALatticeRef(lhs), false, new DFALatticeRef(ret), be.loc));
        ret.check();

        {
            let cctx: DFAConsequence;

            if (useOldPA) {
                cctx = ret.acquireConstantAsContext();
                cctx.pa = oldPA.copy();
            }
            else
                cctx = ret.getContext()!;

            cctx.obj = lhsObject;

            if (lhsObject !== null)
                lhsObject.mayNotBeExactPointer = true;
        }

        rhs.__dtor(); // D destroys the locals (moved, so no-ops)
        lhs.__dtor();
        return ret;
    }

    /**
     * dmd/dfa/fast/expression.d:2388 — `DFALatticeRef walkMathAssignOp(UnaExp ue, DFALatticeRef rhs, PAMathOp op)`
     * (renamed, 04 §1 Form B). `ue.e1 op= rhs` for `++x` / `--x` (`rhs` the constant 1). D reads `rhs` (seeReadMathOp)
     * after moving it into seeMathOp, so that read sees a null handle (faithful). Consumes `rhs`.
     */
    walkMathAssignOpFromUnaExp(ue: UnaExp, rhs: DFALatticeRef, op: PAMathOp): DFALatticeRef {
        try {
            const dfaCommon = this.dfaCommon!;
            dfaCommon.printStateln(ds("math assign2 op lhs"));
            const lhs = this.walk(ue.e1);
            assert(!lhs.isNull());
            lhs.check();

            const lhsCctx = lhs.getContext();
            assert(lhsCctx !== null);
            const lhsObject = lhsCctx.obj;

            const ret = this.seeMathOp(lhs.copy(), new DFALatticeRef(rhs), ue.type!, op);
            ret.check();
            this.seeReadMathOp(rhs, ue.loc);

            ret.opAssign(this.seeAssignFromDFALatticeRef(new DFALatticeRef(lhs), false, new DFALatticeRef(ret),
                    ue.loc));
            ret.check();

            const cctx = ret.getContext()!;
            cctx.obj = lhsObject;

            if (lhsObject !== null)
                lhsObject.mayNotBeExactPointer = true;

            ret.printStructure(ds("math assign2 ret"));
            lhs.__dtor(); // D destroys the local (moved, so a no-op)
            return ret;
        } finally {
            rhs.__dtor(); // by-value parameter, destroyed by the callee (moved, so a no-op)
        }
    }

    /**
     * dmd/dfa/fast/expression.d:2416 — `DFALatticeRef callFunction(FuncDeclaration toCallFunction, Expression`.
     * A call of `toCallFunction` (null when only the callee expression is known): a method called through
     * `thisPointer` (`e1.method()`) takes its function from it; the `this` argument (dereferenced when nullable),
     * `argPrefix` and every argument are walked and converged in a side-effect-free scope against the callee's
     * parameter DFA info and storage classes, stopping after an argument that jumps. Answers a constant: non-null
     * when the callee guarantees a non-null return, unknown otherwise. A noreturn callee marks the scope as
     * jumped and returned.
     */
    callFunction(toCallFunction: FuncDeclaration | null, thisPointer: Expression | null,
            argPrefix: Expression | null, arguments_: Expressions | null, loc: Loc): DFALatticeRef {
        const dfaCommon = this.dfaCommon!;
        let toCallFunctionType: TypeFunction | null = toCallFunction !== null
            ? toCallFunction.type!.isFunction_Delegate_PtrToFunction() : null;

        if (thisPointer !== null) {
            // Extract from the this pointer expression the function to call.

            const dve = thisPointer.isDotVarExp();
            const ve = dve === null ? thisPointer.isVarExp() : null;
            if (dve !== null) {
                const fd = dve.var_.isFuncDeclaration();
                if (fd !== null) {
                    // e1.method()
                    thisPointer = dve.e1;
                    toCallFunction = fd;
                    toCallFunctionType = toCallFunction.type!.isFunction_Delegate_PtrToFunction();
                }
            }
            else if (ve !== null) {
                // method()
                thisPointer = null;
                toCallFunctionType = ve.var_.type!.isFunction_Delegate_PtrToFunction();
            }
        }

        if (toCallFunction !== null && toCallFunction.ident !== null) {
            // dropped: `dfaCommon.printState(...)` (expression.d:2446), debug dump (file header)
        }
        else if (loc.isValid()) {
            // dropped: `dfaCommon.printState(...)` (expression.d:2456), debug dump (file header)
        }
        else
            dfaCommon.printStateln(ds("Calling function"));

        const functionIsNoReturn = (toCallFunction !== null && toCallFunction.noreturn)
            || (toCallFunctionType !== null
                && toCallFunctionType.next !== null
                && toCallFunctionType.next.isTypeNoreturn() !== null);

        {
            let calledFunctionInfo: ParametersDFAInfo | null = null;
            let thisPointerInfo: ParameterDFAInfo | null = null;
            let returnInfo: ParameterDFAInfo | null = null;

            if (toCallFunction !== null && toCallFunction.parametersDFAInfo !== null) {
                calledFunctionInfo = toCallFunction.parametersDFAInfo;
                thisPointerInfo = calledFunctionInfo.thisPointer; // `&calledFunctionInfo.thisPointer`
                returnInfo = calledFunctionInfo.returnValue; // `&calledFunctionInfo.returnValue`
            }

            this.stmtWalker!.startScope();
            dfaCommon.currentDFAScope!.sideEffectFree = true;

            if (thisPointer !== null) {
                dfaCommon.printStateln(ds("This:"));
                const thisExp = this.walk(thisPointer);

                if (isTypeNullable(thisPointer.type))
                    thisExp.opAssign(this.seeDereference(thisPointer.loc, new DFALatticeRef(thisExp)));

                this.seeConvergeFunctionCallArgument(new DFALatticeRef(thisExp), thisPointerInfo,
                        STC.none, toCallFunction, thisPointer.loc);
                thisExp.__dtor(); // D destroys the block local (moved, so a no-op)
            }

            if (argPrefix !== null) {
                dfaCommon.printStateln(ds("Argument prefix:"));
                const argPrefixLR = this.walk(argPrefix);
                this.seeConvergeFunctionCallArgument(new DFALatticeRef(argPrefixLR), null, STC.none,
                        toCallFunction, argPrefix.loc);
                argPrefixLR.__dtor(); // D destroys the block local (moved, so a no-op)
            }

            if (arguments_ !== null && arguments_.length > 0) {
                // D null slices are empty arrays here (file header)
                let allParameters: (Parameter | null)[] = [];
                let allParameterVars: (VarDeclaration | null)[] = [];
                const allInfos: ParameterDFAInfo[] = calledFunctionInfo !== null
                    && calledFunctionInfo.parameters !== null ? calledFunctionInfo.parameters : [];

                if (toCallFunctionType !== null) {
                    const functionType = toCallFunctionType.toTypeFunction();

                    if (functionType.parameterList.parameters !== null
                            && functionType.parameterList.parameters.length !== 0) {
                        allParameters = functionType.parameterList.parameters.opSlice();
                    }
                }

                if (toCallFunction !== null) {
                    if (toCallFunction.parameters !== null && toCallFunction.parameters.length !== 0) {
                        allParameterVars = toCallFunction.parameters.opSlice();
                    }
                }

                // dropped: `dfaCommon.printState(...)` (expression.d:2537), debug dump (file header)

                for (let i = 0; i < arguments_.length; i++) {
                    const arg = arguments_.opIndex(i);
                    const param = i < allParameters.length ? allParameters[i] : null;
                    const paramVar = i < allParameterVars.length ? allParameterVars[i] : null;
                    // branded flag-enum re-cast after `|` (02 §4.2)
                    const storageClass = ((param !== null ? param.storageClass : STC.none)
                            | (paramVar !== null ? paramVar.storage_class : STC.none)) as STC;
                    const info = i < allInfos.length ? allInfos[i] : null; // `&allInfos.ptr[i]`

                    // dropped: `dfaCommon.printState(...)` (expression.d:2558), debug dump (file header)

                    const argExp = this.walk(arg);
                    this.seeConvergeFunctionCallArgument(new DFALatticeRef(argExp), info,
                            storageClass, toCallFunction, loc);
                    argExp.__dtor(); // D destroys the loop-body local (moved, so a no-op)

                    if (dfaCommon.currentDFAScope!.haveJumped)
                        break;
                }
            }

            this.stmtWalker!.endScope().__dtor(); // the popped scope is a discarded temporary

            {
                const ret = dfaCommon.makeLatticeRef();

                if (returnInfo !== null && returnInfo.notNullOut === ParameterDFAInfo.Fact.Guaranteed)
                    ret.acquireConstantAsContextTruthiness(Truthiness.True, Nullable.NonNull, dfaCommon.makeObject());
                else
                    ret.acquireConstantAsContext();

                // If the function is no return, or it hasn't been semantically analysed yet,
                //  we'll assume it can't return.
                // Otherwise we get false positives.
                if (functionIsNoReturn) {
                    dfaCommon.currentDFAScope!.haveJumped = true;
                    dfaCommon.currentDFAScope!.haveReturned = true;
                }

                return ret;
            }
        }
    }

    /**
     * dmd/dfa/fast/expression.d:2603 — `DFALatticeRef concatenateTwo(BinExp be, int op, bool assign = false)`. A
     * concatenation (`~`, or `~=` under `assign`); `op` is the operand shape: 0 `T[] ~ T[]`, 1 `T[] ~ T`,
     * 2 `T[] ~ dchar`, 3 `T ~ T`, 4 `T ~ T[]`, which sets the result length. A null handle when either operand has
     * no context. The appending form assigns to the left-hand side (non-null when the result type says so); the
     * other answers a constant whose nullability follows concatNullableResult.
     */
    concatenateTwo(be: BinExp, op: number, assign = false): DFALatticeRef {
        // Whatever lhs started out as, it'll be non-null once we're done with it.
        const dfaCommon = this.dfaCommon!;

        const nullableResult = concatNullableResult(be.e1!.type!, be.e2!.type!);
        // dropped: `dfaCommon.printState(...)` (expression.d:2608), debug dump (file header)

        dfaCommon.printStateln(ds("concat lhs"));
        const lhs = this.walk(be.e1);
        dfaCommon.printStateln(ds("concat rhs"));
        const rhs = this.walk(be.e2);
        try {
            const lhsCctx = lhs.getContext(), rhsCctx = rhs.getContext();

            if (lhsCctx === null || rhsCctx === null) {
                // We can't analyse this.
                return new DFALatticeRef();
            }

            let pa = new DFAPAValue();

            if (op === 0) {
                // T[] ~ T[]
                pa = rhsCctx.pa.copy();
                pa.addFrom(lhsCctx.pa.copy(), Type.tuns64);
            }
            else if (op === 1) {
                // T[] ~ T
                pa = lhsCctx.pa.copy();
                pa.addFrom(DFAPAValue.fromLong(1n), Type.tuns64);
            }
            else if (op === 2) {
                // T[] ~ dchar
                // We have no idea how many code units the dchar will encode as
                pa = Unknown.copy();
            }
            else if (op === 3) {
                // T ~ T
                pa = DFAPAValue.fromLong(2n);
            }
            else if (op === 4) {
                // T ~ T[]
                pa = rhsCctx.pa.copy();
                pa.addFrom(DFAPAValue.fromLong(1n), Type.tuns64);
            }

            const ret = new DFALatticeRef();

            if (assign) {
                rhsCctx.pa = pa.copy();
                ret.opAssign(this.seeAssignFromDFALatticeRef(new DFALatticeRef(lhs), false, new DFALatticeRef(rhs),
                        be.loc, false, nullableResult === 1 || nullableResult === 2 ? 3 : 0));
            }
            else {

                let expectedTruthiness = Truthiness.Unknown;
                let expectedNullable = Nullable.Unknown;

                if (nullableResult === 2) {
                    expectedTruthiness = Truthiness.True;
                    expectedNullable = Nullable.NonNull;
                }
                else if (nullableResult === 1) {
                    expectedNullable = lhsCctx.nullable;
                    if (expectedNullable < rhsCctx.nullable)
                        expectedNullable = rhsCctx.nullable;

                    if (expectedNullable === Nullable.NonNull)
                        expectedTruthiness = Truthiness.True;
                }

                ret.opAssign(this.seeLogicalAnd(new DFALatticeRef(lhs), new DFALatticeRef(rhs)));
                const cctx = ret.acquireConstantAsContext();

                cctx.truthiness = expectedTruthiness;
                cctx.nullable = expectedNullable;
                cctx.pa = pa.copy();
            }

            return ret;
        } finally {
            // D destroys the locals at every exit: they still hold their lattices on the early return
            rhs.__dtor();
            lhs.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/expression.d:2696 — `void markUnmodellable(Expression e)`. Marks unmodellable every variable `e`
     * names directly or through the operands of its binary / unary sub-expressions (a `ref` initializer, a
     * placement `new`): the engine cannot follow the aliasing those create.
     */
    markUnmodellable(e: Expression): void {
        const dfaCommon = this.dfaCommon!;

        const perVar = (vd: VarDeclaration): void => {
            const var_ = dfaCommon.findVariable(vd);
            if (var_ !== null)
                var_.unmodellable = true;
        };

        const perExpr = (expr: Expression): void => {
            const ve = expr.isVarExp();
            const be = ve === null ? expr.isBinExp() : null;
            const ue = ve === null && be === null ? expr.isUnaExp() : null;
            if (ve !== null) {
                const vd = ve.var_.isVarDeclaration();
                if (vd !== null)
                    perVar(vd);
            }
            else if (be !== null) {
                perExpr(be.e1!);
                perExpr(be.e2!);
            }
            else if (ue !== null) {
                perExpr(ue.e1!);
            }
        };

        perExpr(e);
    }

    /** 03 §6.3: D's implicit field-wise copy (the three pointers shared). */
    copy(): ExpressionWalker {
        const c = new ExpressionWalker();
        c.dfaCommon = this.dfaCommon;
        c.stmtWalker = this.stmtWalker;
        c.analyzer = this.analyzer;
        return c;
    }
}
