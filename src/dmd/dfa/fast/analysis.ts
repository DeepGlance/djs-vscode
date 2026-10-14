// Ported from dmd/dfa/fast/analysis.d (module dmd.dfa.fast.analysis).
//
// Analysis engine for the fast Data Flow Analysis engine: the transfer functions (how an assignment, a math
// operation, an equality... transforms the lattice), the convergence of scopes (merging the states of the branches
// of a control-flow split), and the O(1) loop approximation.
//
// TRANSLATION DECISIONS (the structure.ts header holds the struct, allocator and ownership decisions this file
// builds on):
//   - DFAAnalyzer is a stack local of dfaEntry (entry.d:117) reached through `DFAAnalyzer*` by the walkers: a class
//     reference (03 §0, 02 §10), like DFACommon. It is copyable in D (two pointers), so it exports a field-wise
//     copy() by the 03 §6.3 emission checklist (every copyable D struct, called or not); no D site copies it.
//   - D `private:` members (analysis.d:2293: meetScope, joinScope, meet, join, checkPAVar, seeWrite) are class-local
//     (analysis.d has no unittest and no sibling module-level function): TS `private` (10 §1.7).
//   - OWNERSHIP (03 §6.6 and the structure.ts OWNERSHIP PROTOCOL). Every DFALatticeRef / DFAScopeRef site:
//       * a by-value handle parameter is destroyed BY THE CALLEE at its exit, left to right after the locals
//         (probed: locals in reverse declaration order, then parameters left to right): a `try`/`finally` around
//         the body. This holds for the by-value parameter of every delegate handed to swapLattice /
//         swapForwardLabelScope (`lattice`, `old`).
//       * an lvalue argument to a by-value parameter is `new X(lvalue)` (the move), evaluated left to right with
//         the other arguments; an rvalue argument (a call result) is passed as is.
//       * `x = v` is `x.opAssign(v)` (`v` = `new X(lvalue)` or the rvalue); a handle field (`scv.lr`,
//         `sc.beforeScopeState`) is readonly and only ever assigned through opAssign.
//       * `return local;` of the function's own local is NRVO: neither copied nor destroyed. `return param;` and
//         `return captured;` (a delegate returning its by-value parameter or the enclosing function's local)
//         copy-construct, so they are `return new X(...)` and the source is left null (probed).
//       * a local handle is destroyed at its scope exit: a plain `__dtor()` at the end of a single-exit block, a
//         `try`/`finally` where the scope has several exits.
//       * D's nested convergeStatement delegate declares `DFALatticeRef lr = ... join(lattice, lr, ...)`: a D
//         variable is not in scope in its own initializer, so that `lr` is the enclosing function's local
//         (probed). TS would read the new binding in its TDZ, so the delegate's local is renamed `lrMerged`.
//   - `ref DFAVar*` / `ref bool` parameters: seeWrite never writes `assignTo` (plain parameter); checkPAVar writes
//     `couldBeUnknown` (a `Ref<boolean>` box, 03 §3.2). D `out DFAVar*` / `out DFAScopeVarMergable` arguments of
//     getContext / consumeNext / consumeVar are named `Ref` boxes read back after the call (03 §3.3).
//   - `DFAVar** lastMaybe = &firstMaybe;` (analysis.d:1948) walks and writes through a pointer slot: the 03 §7.3
//     accessor pair (`Slot`).
//   - DFAPAValue is a value struct: every D copy point takes `.copy()` (assignment, by-value argument of the
//     math ops and of merge); the `ref` parameters of compareEqual / greaterThan... get the value bare (aliased,
//     greaterThan writes through it as D does); `DFAPAValue.Unknown` is `Unknown.copy()`. D `!=` on two
//     DFAPAValues (analysis.d:193/:762) is member-wise (DFAPAValue has opCmp and no opEquals, 05 §3): `kind` and
//     `value` field by field, never opCmp.
//   - int / uint mixes (09 §3.1): `writeOnVarAtThisPoint` is uint, the counts and depths are int; a mixed
//     comparison converts the int side with toUint32, a mixed store converts with toUint32 / toInt32, as
//     structure.ts does.
//   - `alias Fact` (report.ts) values are spelled `ParameterDFAInfo.Fact.<member>` (see the report.ts header).
//   - DEBUG MACHINERY: the `version (DebugJoinMeetOp)` blocks (_config.md, OFF) and the `version (none)` traces are
//     dropped. `dfaCommon.printState(...)` (analysis.d:1619/:1712) is dropped with its delegate: printState only
//     calls it under `static if (debugIt)`, resolved false (structure.ts), and its body prints raw `%p` addresses.
//     `if (dfaCommon.debugIt) printf(...)` (analysis.d:1577) is dropped for the same reason.

import { assert, assertUnreachable, SwitchError } from "../../../assert.js";
import { toInt32, toUint32 } from "../../../numeric.js";
import { STC } from "../../astenums.js";
import type { FuncDeclaration } from "../../func.js";
import type { Identifier } from "../../identifier.js";
import type { Loc } from "../../location.js";
import type { Type } from "../../mtype.js";
import type {
    DFACommon, DFAConsequence, DFALattice, DFAObject, DFAScope, DFAScopeVar, DFAVar, Ref,
} from "./structure.js";
import {
    DFALatticeRef, DFAPAValue, DFAScopeRef, DFAScopeVarMergable, Nullable, PAMathOp, Truthiness, Unknown,
} from "./structure.js";
import type { DFAReporter } from "./report.js";
import { EqualityArgType } from "../utils.js";
// last: func.ts is in the core SCC; structure.js above has already loaded it through typesem (01 §4.8).
import { ParameterDFAInfo } from "../../func.js";

/** The 03 §7.3 accessor pair: a D `T**` slot a walk writes through. */
interface Slot<T> { get(): T; set(v: T): void; }

/// dmd/dfa/fast/analysis.d:36 — `//version = DebugJoinMeetOp;` stays unset (_config.md `DebugJoinMeetOp`).

/***********************************************************
 * The core analyzer that manipulates the Lattice state.
 *
 * This struct provides the overarching join/meet logic, while the specific
 * merge logic is handled in `DFAConsequence`.
 *
 * It is responsible for:
 * - Orchestrating the convergence of scopes (calculating the final state after a block exits).
 * - Managing high-level state transfers between the AST walkers and the internal lattice.
 *
 * dmd/dfa/fast/analysis.d:48 — `struct DFAAnalyzer`. Both fields are set by dfaEntry before the walk starts and
 * every method dereferences them. Every handle a method takes by value is consumed: the method destroys it at its
 * exit unless it moved it on (file header, OWNERSHIP).
 */
export class DFAAnalyzer {
    dfaCommon: DFACommon | null = null;
    reporter: DFAReporter | null = null;

    /**
     * dmd/dfa/fast/analysis.d:53 — `DFAScopeVar* convergeExpression(DFALatticeRef lr, bool isSideEffect = false)`.
     * Folds the effects of an expression's lattice `lr` into the current scope (or, for a side effect, the
     * innermost scope that may hold side effects) and every scope below it: a Maybe context joins `lr` into its
     * variable's lattice, otherwise each non-maybe-top consequence on a base-less variable is joined into that
     * variable's context. Answers the scope variable of `lr`'s context in the first of those scopes (null for a
     * null `lr` or a variable-less context). Consumes `lr`.
     */
    convergeExpression(lr: DFALatticeRef, isSideEffect = false): DFAScopeVar | null {
        try {
            if (lr.isNull())
                return null;

            const ctxVar: Ref<DFAVar | null> = { value: null };
            const ctx = lr.getContext(ctxVar);
            assert(ctx !== null);

            lr.cleanupConstant(ctxVar.value);

            // dropped: version (DebugJoinMeetOp) trace (analysis.d:64), OFF (_config.md)

            let sc: DFAScope | null = isSideEffect ? this.dfaCommon!.getSideEffectScope()
                : this.dfaCommon!.currentDFAScope;
            const ret = sc!.getScopeVar(ctxVar.value);

            while (sc !== null) {
                // dropped: version (DebugJoinMeetOp) trace (analysis.d:76), OFF (_config.md)

                let scv: DFAScopeVar | null = null;

                if (ctx.truthiness === Truthiness.Maybe) {
                    scv = sc.getScopeVar(ctxVar.value);

                    if (!ctx.maybeTopSeen && ctxVar.value !== null && !ctxVar.value.haveBase()) {
                        scv!.lr.opAssign(this.join(new DFALatticeRef(scv!.lr), lr.copy(), 0, null, false, true));
                        assert(scv!.lr.getContextVar() === ctxVar.value);
                    }
                }
                else {
                    const scCurrent = sc;
                    lr.opApply((c: DFAConsequence): number => {
                        if (!c.maybeTopSeen && c.var !== null && !c.var.haveBase()) {
                            scv = scCurrent.getScopeVar(c.var);

                            const oldC = scv!.lr.getContext();
                            assert(oldC !== null);

                            oldC.joinConsequence(oldC, c, null, false, false, true);
                            assert(scv!.lr.getContextVar() === c.var);
                        }
                        return 0;
                    });
                }

                sc = sc.child;
            }

            return ret;
        } finally {
            lr.__dtor(); // by-value parameter, destroyed by the callee
        }
    }

    /***********************************************************
     * Merges the states from the True and False branches of an If statement.
     *
     * This handles the "Diamond" control flow pattern.
     * 1. It compares the state at the end of the "True" block vs the "False" block.
     * 2. It identifies "Gates" (variables used in the condition, e.g., `if (ptr)`).
     * 3. It calculates the union (Join) of the states to determine the state
     * after the If statement completes.
     *
     * dmd/dfa/fast/analysis.d:134 — `void convergeStatementIf(DFALatticeRef condition, DFAScopeRef scrTrue,`.
     * Consumes the three handles. Precondition: `scrFalse` is non-null (asserted).
     *
     * Params:
     * condition = The lattice state of the condition expression.
     * scrTrue = The final state of the True scope.
     * scrFalse = The final state of the False scope.
     * haveFalseBody = True if the if-statement has an `else` block.
     * unknownBranchTaken = True if the condition result is not statically known (Maybe).
     * predicateNegation = State of the predicate negation (0: unknown, 1: negated, 2: not negated).
     */
    convergeStatementIf(condition: DFALatticeRef, scrTrue: DFAScopeRef, scrFalse: DFAScopeRef,
            haveFalseBody: boolean, _unknownBranchTaken: boolean, predicateNegation: number): void {
        try {
            const lastLoopyLabelDepth = this.dfaCommon!.lastLoopyLabel!.depth;
            let bothJumped = false, bothReturned = false;

            // False body should never be null.
            assert(!scrFalse.isNull());

            // dropped: version (none) trace (analysis.d:144)

            const protectLoopAgainst = (scr: DFAScopeRef): void => {
                if (this.dfaCommon!.lastLoopyLabel === null)
                    return;

                /*
                    We have whats looks like:

                    for(;condition1;) {
                        if (condition2) {
                            ???
                        } else {
                            ???
                        }
                    }

                    Where either true or false branch could alter a variable outside of itself.
                */

                scr.opApply_DFAVar_DFALattice_DFAScopeVar(
                        (contextVar: DFAVar | null, l: DFALattice, _scv: DFAScopeVar): number => {
                    // Ignore any variables declared within the loop
                    if (contextVar!.declaredAtDepth >= lastLoopyLabelDepth)
                        return 0;

                    const scvParent = this.dfaCommon!.acquireScopeVar(contextVar);
                    if (scvParent === null)
                        return 0;

                    const c = l.context;
                    assert(c !== null);

                    const cParent = scvParent.lr.getContext();
                    assert(cParent !== null);

                    if (c.truthiness !== cParent.truthiness)
                        c.truthiness = Truthiness.Unknown;
                    if (c.nullable !== cParent.nullable)
                        c.nullable = Nullable.Unknown;
                    if (c.pa.kind !== cParent.pa.kind || c.pa.value !== cParent.pa.value) // D `!=`: member-wise
                        c.pa = Unknown.copy();
                    return 0;
                });
            };

            /*
            Gates look like:

            bool gate;
            if(gate) {
                ???
            } else {
                ???
            }

            Not:

            bool gate1, gate2;
            if (gate1 && gate2) {
                ???
            } else {
                ???
            }
            */
            const gateConsequence = condition.getGateConsequence();

            /*
            Given a gate, store any output state of a if statement branch into it.
            Ignoring the nature of consequences, and instead look limitedly at the maybe tops.
            */
            const storeGateState = (onto: DFALatticeRef, scr: DFAScopeRef): void => {
                scr.opApply_DFAVar_DFALattice((_contextVar: DFAVar | null, l: DFALattice): number => {
                    l.walkMaybeTops((branchC: DFAConsequence): boolean => {
                        // Do no change the state of the gate. Causes bugs.
                        // Stuff like a null checked if statement results in a dereference on null.

                        if (gateConsequence!.var !== branchC.var
                            && branchC.var !== null && !branchC.var.haveBase()) {
                            const into = onto.findConsequence(branchC.var);

                            if (into !== null) {
                                if (into.writeOnVarAtThisPoint < branchC.writeOnVarAtThisPoint)
                                    into.meetConsequence(into, branchC);
                            }
                            else if ((branchC.var.isTruthy && branchC.truthiness > Truthiness.Maybe)
                                || (branchC.var.isNullable && branchC.nullable !== Nullable.Unknown)) {
                                onto.addConsequence(branchC.var, branchC);
                            }
                        }

                        return true;
                    });
                    return 0;
                });
            };

            if (gateConsequence !== null && !gateConsequence.var!.haveBase()) {
                const gateScv = this.dfaCommon!.lastLoopyLabel!.getScopeVar(gateConsequence.var);

                if (gateScv !== null) {
                    // int vs uint: D compares in uint (09 §3.1)
                    if (gateScv.gatePredicateWriteCount === 0
                            || toUint32(gateScv.gatePredicateWriteCount) !== gateConsequence.writeOnVarAtThisPoint) {
                        gateScv.lrGatePredicate.opAssign(this.dfaCommon!.makeLatticeRef());
                        gateScv.lrGateNegatedPredicate.opAssign(this.dfaCommon!.makeLatticeRef());
                        gateScv.gatePredicateWriteCount = toInt32(gateConsequence.writeOnVarAtThisPoint); // uint -> int
                    }

                    if (predicateNegation === 1) {
                        storeGateState(gateScv.lrGateNegatedPredicate, scrTrue);
                        if (haveFalseBody)
                            storeGateState(gateScv.lrGatePredicate, scrFalse);
                    }
                    else if (predicateNegation === 2) {
                        storeGateState(gateScv.lrGatePredicate, scrTrue);
                        if (haveFalseBody)
                            storeGateState(gateScv.lrGateNegatedPredicate, scrFalse);
                    }
                }
            }

            const protectGate = (): void => {
                if (gateConsequence === null)
                    return;

                scrTrue.opApply_DFAVar_DFALattice_DFAScopeVar(
                        (contextVar: DFAVar | null, lTrue: DFALattice, _scvTrue: DFAScopeVar): number => {
                    const scvParent = this.dfaCommon!.acquireScopeVar(contextVar);
                    if (scvParent === null)
                        return 0;

                    const cTrue = lTrue.context;
                    assert(cTrue !== null);

                    const cParent = scvParent.lr.getContext();
                    assert(cParent !== null);

                    const scvFalse = scrFalse.findScopeVar(contextVar);
                    const cFalse = scvFalse !== null ? scvFalse.lr.getContext() : null;

                    if (cFalse !== null) {
                        // If true and false branches disagree on state, and if either of them are above parent, set as
                        // unknown.

                        if ((cTrue.truthiness !== cFalse.truthiness
                                && (cTrue.truthiness > cParent.truthiness
                                || cFalse.truthiness > cParent.truthiness))) {
                            cTrue.truthiness = Truthiness.Unknown;
                            cFalse.truthiness = Truthiness.Unknown;
                        }
                        else if (haveFalseBody && cParent.truthiness !== Truthiness.Unknown
                                && (cTrue.truthiness === Truthiness.Unknown
                                    || cFalse.truthiness === Truthiness.Unknown)) {
                            // D's arm is empty (analysis.d:316)
                        }
                        else if (cTrue.nullable !== cFalse.nullable
                                && (cTrue.nullable > cParent.nullable
                                    || cFalse.nullable > cParent.nullable)) {
                            cTrue.nullable = Nullable.Unknown;
                            cFalse.nullable = Nullable.Unknown;
                        }
                        else if (haveFalseBody && cParent.nullable !== Nullable.Unknown
                                && (cTrue.nullable === Nullable.Unknown
                                    || cFalse.nullable === Nullable.Unknown)) {
                            // D's arm is empty (analysis.d:328)
                        }
                    }
                    else {
                        if (cTrue.truthiness > cParent.truthiness)
                            cTrue.truthiness = Truthiness.Unknown;
                        else if (cParent.truthiness !== Truthiness.Unknown
                                && cTrue.truthiness === Truthiness.Unknown) {
                            // D's arm is empty (analysis.d:337)
                        }

                        if (cTrue.nullable > cParent.nullable)
                            cTrue.nullable = Nullable.Unknown;
                        else if (cParent.nullable !== Nullable.Unknown
                                && cTrue.nullable === Nullable.Unknown) {
                            // D's arm is empty (analysis.d:344)
                        }
                    }
                    return 0;
                });

                scrFalse.opApply_DFAVar_DFALattice_DFAScopeVar(
                        (contextVar: DFAVar | null, lFalse: DFALattice, _scvFalse: DFAScopeVar): number => {
                    const scvParent = this.dfaCommon!.acquireScopeVar(contextVar);
                    if (scvParent === null)
                        return 0;

                    const cFalse = lFalse.context;
                    assert(cFalse !== null);

                    const cParent = scvParent.lr.getContext();
                    assert(cParent !== null);

                    if (!scrTrue.isNull() && scrTrue.findScopeVar(contextVar) !== null)
                        return 0; // handled already

                    if (cFalse.truthiness > cParent.truthiness
                            || (cParent.truthiness !== Truthiness.Unknown
                                && cFalse.truthiness === Truthiness.Unknown)) {
                        contextVar!.unmodellable = true;
                        cFalse.truthiness = Truthiness.Unknown;
                    }

                    if (cFalse.nullable > cParent.nullable
                            || (cParent.nullable !== Nullable.Unknown
                                && cFalse.nullable === Nullable.Unknown)) {
                        contextVar!.unmodellable = true;
                        cFalse.nullable = Nullable.Unknown;
                    }
                    return 0;
                });
            };

            protectGate();

            /*
            We have a true body which means we could be in one of the following cases:
            Where ... means user code.
            1.
                if (condition)
                else {
                    ???
                }
            2.
                if (condition) {
                    ...
                } else {
                    ...
                }
            3.
                if (condition) {
                    ...
                } else {
                }
            */

            if (scrTrue.isNull()) {
                // If the true body is missing, that means it could not have executed.
                // Converge the false branch assuming that it will always have executed.
                // This covers scenario 1.

                bothJumped = scrFalse.isNull() ? false : scrFalse.sc!.haveJumped;
                bothReturned = scrFalse.isNull() ? false : scrFalse.sc!.haveReturned;

                protectLoopAgainst(scrFalse);
                this.convergeScope(new DFAScopeRef(scrFalse));
            }
            else if (haveFalseBody) {
                // We have both a true branch and a false branch with user code.
                // This is scenario 2, except it isn't the full scenario.
                // One of these branches or both may jump.

                /*
                a.
                    if (condition) {
                        condition
                        ...
                    } else {
                        !condition
                        ...
                    }
                b.
                    if (condition) {
                        condition
                        ...
                        jump;
                    } else {
                        !condition
                        ...
                    }
                c.
                    if (condition) {
                        condition
                        ...
                    } else {
                        !condition
                        ...
                        jump;
                    }
                d.
                    if (condition) {
                        condition
                        ...
                        jump;
                    } else {
                        !condition
                        ...
                        jump;
                    }
                */

                bothJumped = scrTrue.sc!.haveJumped && scrFalse.sc!.haveJumped;
                bothReturned = scrTrue.sc!.haveReturned && scrFalse.sc!.haveReturned;

                if (scrTrue.sc!.haveJumped === scrFalse.sc!.haveJumped) {
                    // In scenario d we've both jumped, any effects at that time were already copied to the jump point.
                    // Nothing for us to do in that scenario.

                    if (scrTrue.sc!.haveJumped) {
                        // Both jumped, no state to converge.
                    }
                    // D has no `else` here (analysis.d:474): the block below runs in both cases.
                    {
                        // In scenario a, neither has jumped, any effects at the end of their bodies should be meet'd.
                        // Then we can converge that into parent scope.
                        protectGate();
                        const meeted = this.meetScope(new DFAScopeRef(scrTrue), new DFAScopeRef(scrFalse), true);
                        assert(!meeted.isNull());
                        protectLoopAgainst(meeted);
                        this.convergeScope(new DFAScopeRef(meeted));
                        meeted.__dtor(); // D destroys the block-local `meeted` (moved, so a no-op)
                    }
                }
                else if (scrTrue.sc!.haveJumped) {
                    // In scenario b the true branch has jumped, but not the false.
                    // Any effects seen at the true branch have been already copied to the jump point.
                    protectLoopAgainst(scrFalse);
                    this.convergeScope(new DFAScopeRef(scrFalse));
                }
                else if (scrFalse.sc!.haveJumped) {
                    // In scenario c, the false branch has jumped, but not the true.
                    // Any effects seen at the false branch have been already copied to the jump point.
                    protectLoopAgainst(scrTrue);
                    this.convergeScope(new DFAScopeRef(scrTrue));
                }
                else
                    assertUnreachable();
            }
            else {
                // In scenario 3.
                // We have a true branch with user code, but not a false branch.
                // The false branch contains the effects of the negated condition.

                if (scrTrue.sc!.haveJumped) {
                    /*
                    The true branch jumped, which means only the false branch matters.
                    if (condition) {
                        condition
                        ...
                        jumped;
                    } else {
                        !condition
                    }
                    */
                    protectLoopAgainst(scrFalse);
                    this.convergeScope(new DFAScopeRef(scrFalse));
                }
                else {
                    /*
                    The false branch will modify the condition by negating it from within it.
                    We really are not interested in it.

                    if (condition) {
                        condition
                        ...
                    } else {
                        !condition
                    }

                    Consider:
                    if (var !is null) {
                        assert(var !is null);
                    } else {
                        assert(var is null);
                    }
                    Which behavior is correct? That would be the parent.
                    */

                    protectLoopAgainst(scrTrue);

                    // I spent over a month trying to get this to be convergeScope (join instead of meet). ~Rikki
                    // It is a giant ball of false positives, that cannot be unraveled.
                    // It may appear to be a great idea to change this, but I can assure you,
                    //  without accepting a false positive or two or three you will not be changing it from this.
                    // LEAVE THIS ALONE!
                    this.convergeStatement(new DFAScopeRef(scrTrue), false, true);
                }
            }

            if (bothJumped)
                this.dfaCommon!.currentDFAScope!.haveJumped = true;
            if (bothReturned)
                this.dfaCommon!.currentDFAScope!.haveReturned = true;
        } finally {
            // by-value parameters, destroyed by the callee left to right
            condition.__dtor();
            scrTrue.__dtor();
            scrFalse.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/analysis.d:561 — `void applyGateOnBranch(DFAVar* gateVar, int predicateNegation, bool branch)`.
     * When the innermost loopy label recorded gate predicates for `gateVar` at its current write count, joins the
     * predicate matching `branch` (swapped when the predicate is negated) into the current state of every variable
     * it names whose recorded write is still current. No-op for a null gate or predicateNegation 0.
     */
    applyGateOnBranch(gateVar: DFAVar | null, predicateNegation: number, branch: boolean): void {
        if (gateVar === null || predicateNegation === 0)
            return;

        const scv = this.dfaCommon!.lastLoopyLabel!.findScopeVar(gateVar);
        if (scv === null || scv.gatePredicateWriteCount !== gateVar.writeCount)
            return;

        const handle = (lr: DFALatticeRef): void => {
            lr.opApply((cGate: DFAConsequence): number => {
                if (cGate.writeOnVarAtThisPoint < toUint32(cGate.var!.writeCount)) // uint vs int (09 §3.1)
                    return 0;

                const scv2 = this.dfaCommon!.acquireScopeVar(cGate.var);
                if (scv2 === null)
                    return 0;

                const cCurrent = scv2.lr.getContext();
                assert(cCurrent !== null);

                cCurrent.joinConsequence(cCurrent, cGate, null, false);
                return 0;
            });
        };

        if (branch) {
            if (predicateNegation === 1)
                handle(scv.lrGateNegatedPredicate);
            else
                handle(scv.lrGatePredicate);
        }
        else {
            if (predicateNegation === 1)
                handle(scv.lrGatePredicate);
            else
                handle(scv.lrGateNegatedPredicate);
        }
    }

    /***********************************************************
     * Converges a loop or labelled block.
     *
     * Fast-DFA Optimization:
     * Unlike traditional "Slow DFAs" which iterate a loop until the state settles
     * (Fixed Point Iteration), this engine visits the loop body once.
     *
     * To ensure safety without iteration:
     * 1. It checks if variables modified in the loop are used inconsistently.
     * 2. If a variable is modified in a way that creates uncertainty (e.g., incrementing),
     *    it assumes the "Worst Case" (Unknown state) for that variable after the loop.
     *
     * dmd/dfa/fast/analysis.d:615 — `void convergeStatementLoopyLabels(DFAScopeRef containing, ref Loc loc)`.
     * Takes the scope's after- and before-states out of it (the before-state is checked against `containing`), then
     * converges `containing` (joined when the loop is known to have run, met otherwise) and the after-state
     * (met) into the current scope. Consumes `containing`, which must be non-null.
     */
    convergeStatementLoopyLabels(containing: DFAScopeRef, loc: Loc): void {
        try {
            const scopeHaveRun = containing.sc!.isLoopyLabelKnownToHaveRun;

            /*
                A loopy label when scope is known to have ran (once):

                Label: {
                    ...
                    if (condition) {
                        increment;
                        goto Label;
                    }
                }

                When it isn't known to ran once:

                if (condition) {
                    Label: {
                        ...
                        if (condition) {
                            increment;
                            goto Label;
                        }
                    }
                }

            */

            const afterScopeState = new DFAScopeRef(containing.sc!.afterScopeState);

            this.loopyLabelBeforeContainingCheck(containing, new DFAScopeRef(containing.sc!.beforeScopeState), loc);
            if (scopeHaveRun)
                this.convergeScope(new DFAScopeRef(containing));
            else {
                if (containing.sc!.haveReturned)
                    this.dfaCommon!.currentDFAScope!.haveReturned = true;
                this.convergeStatement(new DFAScopeRef(containing), false, true);
            }

            this.convergeStatement(new DFAScopeRef(afterScopeState), false);
            afterScopeState.__dtor(); // D destroys the local at exit (moved, so a no-op)
        } finally {
            containing.__dtor(); // by-value parameter, destroyed by the callee
        }
    }

    /**
     * dmd/dfa/fast/analysis.d:659 — `void loopyLabelBeforeContainingCheck(ref DFAScopeRef containing,`. For each
     * variable of the loop's before-state and then of `containing` that the current scope also tracks: drops the
     * object and the point value that changed across the loop, reports a variable asserted non-null that became
     * null after a dereference ("was required to be non-null", at `loc`), and makes truthiness / nullability
     * Unknown where an assignment follows the assert that fixed them. `containing` is by ref; consumes
     * `beforeScopeState`.
     */
    loopyLabelBeforeContainingCheck(containing: DFAScopeRef, beforeScopeState: DFAScopeRef, loc: Loc): void {
        try {
            const checkForNull = (assertedVar: DFAScopeVar, oldC: DFAConsequence | null,
                    newC: DFAConsequence | null): void => {
                // dropped: version (none) trace (analysis.d:664)

                if (assertedVar.var!.var === null || oldC === null || newC === null
                        || oldC.nullable !== Nullable.NonNull
                        || newC.nullable !== Nullable.Null || assertedVar.derefDepth === 0)
                    return;

                // dropped: version (none) trace (analysis.d:676)

                if (assertedVar.derefAssertedDepth > 0
                        && assertedVar.derefDepth < assertedVar.derefAssertedDepth)
                    this.reporter!.onLoopyLabelLessNullThan(assertedVar.var, loc);
                else if (assertedVar.derefAssertedDepth === 0)
                    this.reporter!.onLoopyLabelLessNullThan(assertedVar.var, loc);
            };

            const checkForAssignAfterAssert = (toProcessScope: DFAScopeRef, assertedVar: DFAScopeVar,
                    assertedLattice: DFALattice): void => {
                if (assertedVar.var === null || assertedVar.var.var === null)
                    return;

                // dropped: version (none) trace (analysis.d:694)

                const assertedLatticeRef = new DFALatticeRef();
                assertedLatticeRef.lattice = assertedLattice;
                try {
                    assertedLatticeRef.opApply((c: DFAConsequence): number => {
                        if (c.var === null || c.var.var === null)
                            return 0;

                        const newSCV = toProcessScope.findScopeVar(c.var);
                        let newC: DFAConsequence | null = null;
                        if (newSCV === null || (newC = newSCV.lr.findConsequence(c.var)) === null)
                            return 0;

                        const currentSCV = this.dfaCommon!.acquireScopeVar(c.var);
                        let currentC: DFAConsequence | null = null;
                        if (currentSCV === null || (currentC = currentSCV.lr.findConsequence(c.var)) === null)
                            return 0;

                        // dropped: version (none) trace (analysis.d:721)

                        const truthinessNotEqual = currentC.truthiness !== Truthiness.Unknown
                            && currentC.truthiness !== newC.truthiness;
                        const nullableNotEqual = currentC.nullable !== Nullable.Unknown
                            && currentC.nullable !== newC.nullable;
                        const assertLessThanAssign = assertedVar.assertDepth <= newSCV.assignDepth;

                        if (!assertLessThanAssign || !(truthinessNotEqual || nullableNotEqual))
                            return 0;
                        else if (nullableNotEqual) {
                            // If the nullability is changing, that means its not predictable
                            newC.nullable = Nullable.Unknown;
                            newC.truthiness = Truthiness.Unknown;
                        }
                        else if (truthinessNotEqual) {
                            // If the truthiness is changing, that means its not predictable
                            newC.truthiness = Truthiness.Unknown;
                        }
                        return 0;
                    });
                } finally {
                    assertedLatticeRef.lattice = null; // scope (exit): the handle never owned the lattice
                    assertedLatticeRef.__dtor(); // D destroys the local (null by now, so a no-op)
                }
            };

            const checkForDifferentObjects = (oldC: DFAConsequence | null, newC: DFAConsequence | null): void => {
                if (oldC!.obj !== newC!.obj)
                    newC!.obj = null;
            };

            const checkForPA = (oldC: DFAConsequence | null, newC: DFAConsequence | null): void => {
                if (oldC!.pa.kind !== newC!.pa.kind || oldC!.pa.value !== newC!.pa.value) // D `!=`: member-wise
                    newC!.pa = Unknown.copy();
            };

            beforeScopeState.opApply_DFAVar_DFALattice((var_: DFAVar | null, l2: DFALattice): number => {
                const oldState = this.dfaCommon!.acquireScopeVar(var_);
                const newState = containing.findScopeVar(var_);
                if (oldState === null || newState === null)
                    return 0;

                checkForDifferentObjects(oldState.lr.lattice!.context, l2.context);
                checkForPA(oldState.lr.lattice!.context, l2.context);
                checkForNull(newState, oldState.lr.lattice!.context, l2.context);
                checkForAssignAfterAssert(beforeScopeState, newState, l2);
                return 0;
            });

            containing.opApply_DFAVar_DFALattice_DFAScopeVar(
                    (var_: DFAVar | null, l2: DFALattice, newState: DFAScopeVar): number => {
                if (var_!.var === null)
                    return 0;

                const oldState = this.dfaCommon!.acquireScopeVar(var_);
                if (oldState === null || newState === null)
                    return 0;

                checkForDifferentObjects(oldState.lr.lattice!.context, l2.context);
                checkForPA(oldState.lr.lattice!.context, l2.context);
                checkForNull(newState, oldState.lr.lattice!.context, l2.context);
                checkForAssignAfterAssert(containing, newState, l2);
                return 0;
            });
        } finally {
            beforeScopeState.__dtor(); // by-value parameter, destroyed by the callee
        }
    }

    /**
     * dmd/dfa/fast/analysis.d:795 — `void convergeScope(DFAScopeRef scr)`. Moves every variable's lattice out of
     * `scr` (in bucket order) and makes it the variable's lattice in the current scope, replacing (not merging) the
     * old one; the mergable counts are merged. Propagates `scr`'s jumped / returned flags. Consumes `scr`; a null
     * `scr` is a no-op.
     */
    convergeScope(scr: DFAScopeRef): void {
        try {
            if (scr.isNull())
                return;

            const jumped = scr.sc!.haveJumped, returned = scr.sc!.haveReturned;

            const lr = new DFALatticeRef();
            const mergable: Ref<DFAScopeVarMergable> = { value: new DFAScopeVarMergable() };
            const var_: Ref<DFAVar | null> = { value: null };

            try {
                for (;;) {
                    lr.opAssign(scr.consumeNext(var_, mergable));
                    if (lr.isNull())
                        break;

                    lr.cleanupConstant(var_.value);

                    this.dfaCommon!.check();
                    this.dfaCommon!.acquireScopeVar(var_.value);

                    const scv = this.dfaCommon!.swapLattice(var_.value, (lattice: DFALatticeRef): DFALatticeRef => {
                        try {
                            assert(!lattice.isNull());
                            lattice.check();

                            const lrCtx = lr.getContextVar();
                            assert(lrCtx === var_.value);
                            assert(!lr.isNull());
                            lr.check();
                            return new DFALatticeRef(lr); // `return lr;` of the enclosing local: copy ctor (moves)
                        } finally {
                            lattice.__dtor(); // by-value delegate parameter, destroyed by the callee
                        }
                    });

                    if (scv !== null)
                        scv.mergable.merge(mergable.value.copy());
                    this.dfaCommon!.check();
                }

                if (jumped)
                    this.dfaCommon!.currentDFAScope!.haveJumped = true;
                if (returned)
                    this.dfaCommon!.currentDFAScope!.haveReturned = true;
            } finally {
                lr.__dtor(); // D destroys the local at exit
            }
        } finally {
            scr.__dtor(); // by-value parameter, destroyed by the callee
        }
    }

    /**
     * dmd/dfa/fast/analysis.d:839 — `void convergeStatement(DFAScopeRef scr, bool allBranchesTaken = true,`. Moves
     * every variable's lattice out of `scr` (in bucket order) and merges it into the variable's lattice in the
     * current scope: JOIN when all branches were taken (`couldScopeNotHaveRan || ignoreWriteCount` ignores write
     * counts), MEET otherwise; variables declared deeper than the current scope are filtered out. The mergable
     * counts are merged. Consumes `scr`.
     */
    convergeStatement(scr: DFAScopeRef, allBranchesTaken = true, couldScopeNotHaveRan = false,
            ignoreWriteCount = false, unknownAware = false): void {
        try {
            const depth = this.dfaCommon!.currentDFAScope!.depth;

            const lr = new DFALatticeRef();
            const mergable: Ref<DFAScopeVarMergable> = { value: new DFAScopeVarMergable() };
            const var_: Ref<DFAVar | null> = { value: null };

            try {
                for (;;) {
                    this.dfaCommon!.check();

                    lr.opAssign(scr.consumeNext(var_, mergable));
                    if (var_.value === null)
                        break;

                    lr.cleanupConstant(var_.value);

                    const scv = this.dfaCommon!.swapLattice(var_.value, (lattice: DFALatticeRef): DFALatticeRef => {
                        try {
                            assert(!lattice.isNull());
                            lattice.check();

                            const lrCtx = lr.getContextVar();
                            assert(lrCtx === var_.value);

                            // make sure it exists in parent
                            // D: `DFALatticeRef lr = ...` (renamed, file header: its initializer reads the ENCLOSING
                            // `lr`, not itself).
                            const lrMerged = allBranchesTaken ? this.join(new DFALatticeRef(lattice),
                                new DFALatticeRef(lr), depth, null, couldScopeNotHaveRan || ignoreWriteCount,
                                unknownAware) : this.meet(new DFALatticeRef(lattice), new DFALatticeRef(lr), depth,
                                couldScopeNotHaveRan);

                            assert(!lrMerged.isNull());
                            lrMerged.check();
                            return lrMerged; // NRVO: the delegate's own local
                        } finally {
                            lattice.__dtor(); // by-value delegate parameter, destroyed by the callee
                        }
                    });

                    if (scv !== null)
                        scv.mergable.merge(mergable.value.copy());
                    this.dfaCommon!.check();
                }
            } finally {
                lr.__dtor(); // D destroys the local at exit
            }
        } finally {
            scr.__dtor(); // by-value parameter, destroyed by the callee
        }
    }

    /**
     * dmd/dfa/fast/analysis.d:882 — `void convergeFunctionCallArgument(DFALatticeRef lr,`.
     * Reads the argument `lr` (an initializing read for a by-ref parameter or `this`), reports a null argument for a
     * parameter known non-null on input, and for a pointer that a by-ref parameter or a base-having variable reaches
     * resets the roots to unknown (unmodellable when the parameter may escape), then converges `lr` as a side
     * effect. Consumes `lr`. `paramStorageClass` is the parameter's STC. `calling` is null for an argument of an
     * unknown callee (expression.d:1342, :1830, :2507), and then `paramInfo` is null too.
     */
    convergeFunctionCallArgument(lr: DFALatticeRef, paramInfo: ParameterDFAInfo | null, paramStorageClass: STC,
            calling: FuncDeclaration | null, loc: Loc): void {
        try {
            const isByRef = (paramStorageClass & (STC.ref_ | STC.out_)) !== 0n;
            const couldEscape = (paramStorageClass & STC.scope_) === 0n
                || (paramStorageClass & (STC.return_ | STC.returnScope | STC.returnRef)) !== 0n;

            // A function call argument, may initialize the parameter if its by-ref or if its the this pointer.
            this.onRead(lr, loc, paramInfo === null || paramInfo.parameterId === -1 || isByRef, isByRef);

            const ctx: Ref<DFAVar | null> = { value: null };
            const cctx = lr.getContext(ctx);

            if (paramInfo !== null && cctx !== null) {
                // ok we have a context variable, check it against paramInfo
                if (paramInfo.notNullIn === ParameterDFAInfo.Fact.Guaranteed && cctx.nullable === Nullable.Null)
                    this.reporter!.onFunctionCallArgumentLessThan(cctx, paramInfo, calling!, loc); // known callee
            }

            const seePointer = (var_: DFAVar): boolean => {
                let handledVar = false;

                // If the variable can point to something we can model (i.e. symbol offset) to its base variable
                // Or if the parameter is by-ref, then we must consider the output state of the parameter.
                if (isByRef || var_.haveBase()) {
                    var_.walkRoots((root: DFAVar): void => {
                        // If the var could be escaped out, forget about reporting on it ever again
                        // If we had escape analysis we could temporarily disable it, but that isn't implemented.
                        if (couldEscape)
                            root.unmodellable = true;

                        const rootCctx = lr.findConsequence(root);

                        // Put the state of the var into an unknown state,
                        //  this prevents it from infesting other variables.
                        const temp = this.dfaCommon!.makeLatticeRef();
                        const newCctx = temp.setContextFromDFAVar(root);

                        if (isByRef && root.isNullable && (cctx!.nullable !== Nullable.Null
                            || paramInfo === null || paramInfo.notNullOut !== ParameterDFAInfo.Fact.NotGuaranteed)) {
                            // Object could've changed.
                            newCctx!.obj = this.dfaCommon!.makeObject(rootCctx !== null ? rootCctx.obj : null);
                        }

                        this.seeWrite(root, temp);
                        this.convergeExpression(new DFALatticeRef(temp), true);

                        // now its all set to unknown

                        if (root !== var_) {
                            if (rootCctx !== null)
                                rootCctx.maybeTopSeen = true;
                        }
                        else
                            handledVar = true;

                        temp.__dtor(); // D destroys the delegate-local `temp` (moved, so a no-op)
                    });
                }

                return handledVar;
            };

            const seeObject = (obj: DFAObject): void => {
                obj.walkRoots((root: DFAObject): void => {
                    if (root.storageFor !== null) {
                        const sideEffectScope = this.dfaCommon!.getSideEffectScope();
                        const scv = sideEffectScope.getScopeVar(root.storageFor);
                        this.seeWrite(root.storageFor, scv!.lr);
                    }
                });
            };

            if (ctx.value === null) {
                lr.walkMaybeTops((c: DFAConsequence): boolean => {
                    if (c.var === null)
                        return true;

                    seePointer(c.var);
                    if (c.obj !== null)
                        seeObject(c.obj);
                    return true;
                });
            }
            else {
                if (seePointer(ctx.value))
                    cctx!.maybeTopSeen = true;
                if (cctx !== null && cctx.obj !== null)
                    seeObject(cctx.obj);
            }

            this.convergeExpression(new DFALatticeRef(lr), true);
        } finally {
            lr.__dtor(); // by-value parameter, destroyed by the callee
        }
    }

    /**
     * dmd/dfa/fast/analysis.d:984 — `void transferAssert(DFALatticeRef lr, ref Loc loc, bool ignoreWriteCount,`.
     * Applies `assert(lr)`: reads `lr`; a length known positive makes its slice non-null; reports "Assert can be
     * proven to be false" when the modellable context is False outside a conditional and no gate state excuses it;
     * records the assert depths of the gate variable in the innermost loopy label; and joins each current
     * consequence into its variable's lattice in the current scope. Consumes `lr`; a null `lr` is a no-op.
     */
    transferAssert(lr: DFALatticeRef, loc: Loc, ignoreWriteCount: boolean, dueToConditional = false): void {
        try {
            if (lr.isNull())
                return;
            this.onRead(lr, loc);

            const currentDepth = this.dfaCommon!.currentDFAScope!.depth;
            let modellable = true;

            lr.walkMaybeTops((c: DFAConsequence): boolean => {
                if (c.var === null)
                    return true;
                else if (!c.var.isModellable()) {
                    modellable = false;
                    return false;
                }

                if (c.var.isLength) {
                    const bCctx = lr.addConsequence(c.var.base1)!;
                    bCctx.pa = c.pa.copy();

                    if ((c.pa.kind === DFAPAValue.Kind.Concrete
                        || c.pa.kind === DFAPAValue.Kind.Lower) && c.pa.value > 0n) {
                        bCctx.truthiness = Truthiness.True;
                        bCctx.nullable = Nullable.NonNull;
                    }
                }

                return true;
            });

            const handle = (c: DFAConsequence): void => {
                if (c.var === null || c.var.haveBase())
                    return;
                let scv = this.dfaCommon!.acquireScopeVar(c.var);
                c.var.assertedCount++;

                // dropped: version (none) trace (analysis.d:1026)

                // int vs uint: D compares in uint (09 §3.1)
                if (currentDepth < c.var.declaredAtDepth || (!ignoreWriteCount
                        && toUint32(c.var.writeCount) > c.writeOnVarAtThisPoint))
                    return;

                if ((scv = this.dfaCommon!.lastLoopyLabel!.findScopeVar(c.var)) !== null) {
                    if (c.nullable === Nullable.NonNull && (scv.derefAssertedDepth === 0
                            || scv.derefAssertedDepth > currentDepth)) {
                        scv.derefAssertedDepth = currentDepth;
                    }
                }

                this.dfaCommon!.swapLattice(c.var, (lattice: DFALatticeRef): DFALatticeRef => {
                    try {
                        const old = lattice.addConsequence(c.var)!;

                        // dropped: version (none) trace (analysis.d:1052)

                        old.joinConsequence(old, c, null, false, ignoreWriteCount, false);

                        // dropped: version (none) trace (analysis.d:1060)

                        return new DFALatticeRef(lattice); // `return lattice;` of a by-value parameter: copy ctor
                    } finally {
                        lattice.__dtor(); // by-value delegate parameter, destroyed by the callee
                    }
                });
            };

            // We want the constant context if it exists, to handle equality.
            {
                const cctx = lr.getContext();
                if (cctx !== null) {
                    if (modellable && !dueToConditional && cctx.truthiness === Truthiness.False
                            && loc.isValid()) {
                        let disable = false;

                        /*
                        Supports:
                            if (gate)
                                assert(!gate);
                        and
                            if (!gate)
                                assert(gate);
                        We also have to consider if its the same value based upon write count.
                        Note: we don't care what the truthiness value actually is for the gate consequence,
                            we're interested in its inversion status.
                        However we don't need the actual predicate integer (see ExpressionWalker.walkCondition).
                        The flag in the consequence is enough, as !!gate should set the lr to unknown not false.
                        */

                        const gateCctx = lr.getGateConsequence();
                        if (gateCctx !== null) {
                            const gateSCV = this.dfaCommon!.lastLoopyLabel!.findScopeVar(gateCctx.var);
                            if (gateSCV !== null) {
                                // dropped: version (none) trace (analysis.d:1095)

                                // uint - int is uint, compared with the int count in uint (09 §3.1)
                                if (toUint32(gateSCV.gatePredicateWriteCount) !== toUint32(
                                        gateCctx.writeOnVarAtThisPoint - (gateCctx.var!.param !== null ? 1 : 0))) {
                                    // D's arm is empty (analysis.d:1107)
                                }
                                else if (!gateCctx.invertedOnce) {
                                    disable = gateSCV.assertTrueDepth !== 0
                                        && gateSCV.assertTrueDepth > gateSCV.assertFalseDepth;
                                }
                                else
                                    disable = gateSCV.assertFalseDepth <= currentDepth;
                            }
                        }

                        if (!disable)
                            this.reporter!.onAssertIsFalse(lr, loc);
                    }
                }
            }

            // We want the gate consequence, not the constant context.
            // Not interested in an equality. It is about any variable state.
            // Update the depths, to give future asserts information needed.
            {
                const gateCctx = lr.getGateConsequence();
                if (gateCctx !== null) {
                    const gateSCV = this.dfaCommon!.lastLoopyLabel!.getScopeVar(gateCctx.var);
                    if (gateSCV !== null) {
                        // dropped: version (none) trace (analysis.d:1131)

                        if (gateSCV.assignDepth === 0 || gateSCV.assertDepth > currentDepth) {
                            gateSCV.assertDepth = currentDepth;

                            /*
                                Set the depth of assert when not unknown to true/false values.
                                This should not be normalized onto the actual state of the variable,
                                 but the resulting expression value.

                                Given:
                                if (gate)
                                    assert(!gate);
                                Regardless of gate being known as true/maybe/false,
                                 this will allow us to do a primitivate variation of VRP and effectively make the
                                 argument false.
                                */
                            if (gateCctx.truthiness === Truthiness.False
                                    && (gateSCV.assertFalseDepth === 0
                                        || gateSCV.assertFalseDepth > currentDepth))
                                gateSCV.assertFalseDepth = currentDepth;
                            else if (gateCctx.truthiness >= Truthiness.Maybe
                                    && (gateSCV.assertTrueDepth === 0
                                        || gateSCV.assertTrueDepth > currentDepth)) {
                                gateSCV.assertTrueDepth = currentDepth;
                                gateSCV.assertFalseDepth = 0;
                            }
                        }
                    }
                }
            }

            lr.opApply((c: DFAConsequence): number => {
                handle(c);
                return 0;
            });
        } finally {
            lr.__dtor(); // by-value parameter, destroyed by the callee
        }
    }

    /***********************************************************
     * Updates the state of a variable after an assignment (`a = b`).
     *
     * This moves the state from the RHS (Right Hand Side) lattice to the
     * LHS (Left Hand Side) variable.
     *
     * Logic:
     * - Direct Assignment: `a = 5` (a becomes 5).
     * - Pointer Assignment: `*p = 5` (We don't change `p`, we assume memory at `p` changed).
     * - Construct: `int a = 5` (Initialization).
     *
     * dmd/dfa/fast/analysis.d:1186 — `DFALatticeRef transferAssign(DFALatticeRef assignTo, bool construct,`.
     * `alteredState` forces the result: 1 True, 2 NonNull, 3 True and NonNull, 4 False and Null, 5 Unknown. Records
     * the write on the assigned variable's roots, converges a copy of the result as a side effect, and answers the
     * result lattice (context: the assigned variable). Consumes `assignTo`, `lr` and `indexLR`.
     */
    transferAssign(assignTo: DFALatticeRef, construct: boolean, isBlit: boolean, lr: DFALatticeRef,
            alteredState: number, loc: Loc, indexLR: DFALatticeRef = new DFALatticeRef()): DFALatticeRef {
        try {
            const assignToCtx = assignTo.getContextVar();
            const lrCtx: Ref<DFAVar | null> = { value: null };
            const lrCctx = lr.getContext(lrCtx);
            const noLR = lrCctx === null;
            const lrIsTruthy = !noLR ? lrCctx!.truthiness === Truthiness.True : false;
            const unmodellable = lrCtx.value !== null && !lrCtx.value.isModellable();
            const ret = new DFALatticeRef();

            this.onRead(assignTo, loc, true);
            // Explicitly allow returns of uninitialized variables.
            this.onRead(lr, loc, assignToCtx !== null && assignToCtx === this.dfaCommon!.getReturnVariable());

            if (assignToCtx !== null) {
                // *var = expr;
                // is very different from:
                // var = expr;

                let wasDereferenced = false;

                assignToCtx.visitIfReferenceToAnotherVar((contextVar: DFAVar): void => {
                    wasDereferenced = true;

                    // This is a dereference: *contextVar = expr;
                    // Which means the effects of lr don't really apply to the lhs.

                    if (contextVar.isTruthy || contextVar.isNullable) {
                        // The only thing we know for 100% certainty is that contextVar at this point is going to be
                        // non-null.

                        const temp = this.dfaCommon!.makeLatticeRef();
                        const cctx = temp.addConsequence(contextVar)!;
                        temp.setContext(cctx);

                        if (contextVar.isTruthy)
                            cctx.truthiness = Truthiness.True;
                        if (contextVar.isNullable)
                            cctx.nullable = Nullable.NonNull;

                        ret.opAssign(this.join(new DFALatticeRef(ret), new DFALatticeRef(temp), 0, null));
                        temp.__dtor(); // D destroys the block-local `temp` (moved, so a no-op)
                    }
                });

                if (!wasDereferenced) {
                    // We're in a direct assignment
                    // Any effects from the lr directly apply to our lhs variable.

                    ret.opAssign(this.dfaCommon!.makeLatticeRef());
                    const cctx = ret.addConsequence(assignToCtx, lrCctx)!;
                    ret.setContext(cctx);

                    if (!construct && noLR)
                        assignToCtx.unmodellable = true;
                }
            }
            else {
                ret.opAssign(this.join(new DFALatticeRef(assignTo), lr.copyWithoutInfiniteLifetime(), 0, null));
                const c = ret.addConsequence(null)!;
                ret.setContext(c);

                if (lrCtx.value !== null && lrCtx.value.haveInfiniteLifetime) {
                    c.truthiness = Truthiness.True;
                    c.nullable = Nullable.NonNull;
                }

                if (construct && isBlit) {
                    if (noLR) {
                        c.truthiness = Truthiness.False;
                        c.nullable = Nullable.Unknown;
                    }
                }
            }

            if (ret.isNull())
                ret.opAssign(this.dfaCommon!.makeLatticeRef());

            if (!indexLR.isNull())
                ret.opAssign(this.transferLogicalAnd(new DFALatticeRef(ret), new DFALatticeRef(indexLR)));
            const retCctx = ret.addConsequence(assignToCtx)!;
            ret.setContext(retCctx);

            if (alteredState === 1) {
                // True
                retCctx.truthiness = Truthiness.True;
            }
            else if (alteredState === 2) {
                // NonNull
                retCctx.nullable = Nullable.NonNull;
            }
            else if (alteredState === 3) {
                // True & NonNull
                retCctx.truthiness = Truthiness.True;
                retCctx.nullable = Nullable.NonNull;
            }
            else if (alteredState === 4) {
                // False & Null
                retCctx.truthiness = Truthiness.False;
                retCctx.nullable = Nullable.Null;
            }
            else if (alteredState === 5) {
                retCctx.truthiness = Truthiness.Unknown;
                retCctx.nullable = Nullable.Unknown;
            }

            if (lrIsTruthy && assignToCtx !== null && assignToCtx.isNullable)
                retCctx.nullable = Nullable.NonNull;

            if (retCctx.truthiness === Truthiness.Maybe)
                retCctx.truthiness = Truthiness.Unknown;

            if (assignToCtx !== null) {
                let exactlyOneRoot = false;

                assignToCtx.visitIfReadOfReferenceToAnotherVar((root: DFAVar): void => {
                    const c = assignTo.findConsequence(root);

                    if (c !== null && c.obj !== null) {
                        let firstRoot: DFAVar | null = null;
                        let rootCount = 0;

                        c.obj.walkRoots((objRoot: DFAObject): void => {
                            if (objRoot.storageFor !== null && !objRoot.storageFor.haveBase()) {
                                if (firstRoot !== null) {
                                    objRoot.storageFor.unmodellable = true;
                                    const cUnk = ret.addConsequence(objRoot.storageFor)!;
                                    cUnk.truthiness = Truthiness.Unknown;
                                    cUnk.nullable = Nullable.Unknown;
                                }
                                else
                                    firstRoot = objRoot.storageFor;

                                rootCount++;
                            }
                        });

                        if (rootCount === 1) {
                            exactlyOneRoot = true;
                            this.seeWrite(firstRoot, ret);

                            const c2 = ret.addConsequence(firstRoot)!;
                            c2.truthiness = retCctx.truthiness;
                            c2.nullable = retCctx.nullable;
                            c2.pa = retCctx.pa.copy();
                        }
                        else if (rootCount > 1) {
                            firstRoot!.unmodellable = true;
                            const cUnk = ret.addConsequence(firstRoot)!;
                            cUnk.truthiness = Truthiness.Unknown;
                            cUnk.nullable = Nullable.Unknown;
                        }
                    }
                });

                if ((!assignToCtx.haveBase() && assignToCtx.var === null)
                        || (assignToCtx.haveBase() && !exactlyOneRoot)) {
                    if (lrCctx !== null && lrCctx.obj !== null) {
                        lrCctx.obj.walkRoots((objRoot: DFAObject): void => {
                            if (objRoot.storageFor !== null && !objRoot.storageFor.haveBase()) {
                                objRoot.storageFor.unmodellable = true;
                                const cUnk = ret.addConsequence(objRoot.storageFor)!;
                                cUnk.truthiness = Truthiness.Unknown;
                                cUnk.nullable = Nullable.Unknown;
                            }
                        });
                    }
                }

                this.seeWrite(assignToCtx, ret);

                ret.setContextFromDFAVar(assignToCtx);
                const scv = this.convergeExpression(ret.copy(), true);
                assert(scv !== null);

                if (assignToCtx.isNullable && retCctx.nullable === Nullable.Null) {
                    scv.mergable.nullAssignWriteCount = assignToCtx.writeCount;
                    scv.mergable.nullAssignAssertedCount = assignToCtx.assertedCount;
                }

                if (unmodellable)
                    assignToCtx.unmodellable = true;
            }

            return ret; // NRVO: the function's own local
        } finally {
            // by-value parameters, destroyed by the callee left to right
            assignTo.__dtor();
            lr.__dtor();
            indexLR.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/analysis.d:1396 — `DFALatticeRef transferNegate(DFALatticeRef lr, Type type,`. Negates `lr` in
     * place and answers it: the context alone for a constant context or under `limitToContext`, every maybe-top
     * otherwise. A consequence is negated once (a second negation, or one `protectElseNegate` forbids, makes it
     * Unknown); a boolean variable's negated truthiness turns the context into a Maybe constant naming it.
     */
    transferNegate(lr: DFALatticeRef, type: Type | null, protectElseNegate = false,
            limitToContext = false): DFALatticeRef {
        try {
            let requireMaybeContext = false;

            const negate = (c: DFAConsequence): boolean => {
                c.pa.negate(type);

                if (c.invertedOnce || (protectElseNegate && c.protectElseNegate)) {
                    c.truthiness = Truthiness.Unknown;
                    c.nullable = Nullable.Unknown;
                }
                else if (c.var !== null && c.var.haveInfiniteLifetime) {
                    // nothing can invert this
                }
                else {
                    c.invertedOnce = true;

                    if (c.var !== null && c.var.isBoolean) {
                        /*
                        Handle the case where:
                        assert(!condition);

                        You don't want the condition variable to effect the output lattice truthiness,
                         but you do want the variable to alter.
                        */
                        requireMaybeContext = c.truthiness <= Truthiness.Maybe;
                        c.truthiness = c.truthiness === Truthiness.False
                            ? Truthiness.True : Truthiness.False;
                    }
                    else if (c.truthiness > Truthiness.Maybe) {
                        c.truthiness = c.truthiness === Truthiness.True
                            ? Truthiness.Unknown : Truthiness.True;
                    }

                    if (c.nullable !== Nullable.Unknown)
                        c.nullable = c.nullable === Nullable.NonNull ? Nullable.Unknown
                            : Nullable.NonNull;
                }

                return true;
            };

            const cctx = lr.getContext();
            if (cctx !== null) {
                // !(a && b) only negate the outer expression
                // !(a) want to negate the inner condition
                if (cctx.var === null || limitToContext)
                    negate(cctx);
                else
                    lr.walkMaybeTops(negate);

                if (requireMaybeContext) {
                    const newCctx = lr.acquireConstantAsContextTruthiness(Truthiness.Maybe,
                            Nullable.Unknown, null);
                    // Don't forget to patch the maybe's, impacts asserts.
                    newCctx.maybe = cctx.var;
                }
            }

            return new DFALatticeRef(lr); // `return lr;` of a by-value parameter: copy ctor
        } finally {
            lr.__dtor(); // by-value parameter, destroyed by the callee (moved, so a no-op)
        }
    }

    /**
     * dmd/dfa/fast/analysis.d:1466 — `DFALatticeRef transferMathOp(DFALatticeRef lhs, DFALatticeRef rhs, Type type,`.
     * Answers `lhs op rhs`: the logical AND of both lattices whose constant context carries the computed point
     * value; objects taking part may no longer be exact pointers. Preconditions: both contexts exist (asserted),
     * `op` is not postInc / postDec. Consumes `lhs` and `rhs`.
     */
    transferMathOp(lhs: DFALatticeRef, rhs: DFALatticeRef, type: Type, op: PAMathOp): DFALatticeRef {
        try {
            const lhsCctx = lhs.getContext();
            const rhsCctx = rhs.getContext();

            assert(lhsCctx !== null);
            assert(rhsCctx !== null);

            if (lhsCctx.obj !== null)
                lhsCctx.obj.mayNotBeExactPointer = true;
            if (rhsCctx.obj !== null)
                rhsCctx.obj.mayNotBeExactPointer = true;

            const newValue = lhsCctx.pa.copy();
            switch (op) {
            case PAMathOp.add:
                newValue.addFrom(rhsCctx.pa.copy(), type);
                break;
            case PAMathOp.sub:
                newValue.subtractFrom(rhsCctx.pa.copy(), type);
                break;
            case PAMathOp.mul:
                newValue.multiplyFrom(rhsCctx.pa.copy(), type);
                break;
            case PAMathOp.div:
                newValue.divideFrom(rhsCctx.pa.copy(), type);
                break;
            case PAMathOp.mod:
                newValue.modulasFrom(rhsCctx.pa.copy(), type);
                break;
            case PAMathOp.and:
                newValue.bitwiseAndBy(rhsCctx.pa.copy(), type);
                break;
            case PAMathOp.or:
                newValue.bitwiseOrBy(rhsCctx.pa.copy(), type);
                break;
            case PAMathOp.xor:
                newValue.bitwiseXorBy(rhsCctx.pa.copy(), type);
                break;
            case PAMathOp.pow:
                newValue.powerBy(rhsCctx.pa.copy(), type);
                break;
            case PAMathOp.leftShift:
                newValue.leftShiftBy(rhsCctx.pa.copy(), type);
                break;
            case PAMathOp.rightShiftSigned:
                newValue.rightShiftSignedBy(rhsCctx.pa.copy(), type);
                break;
            case PAMathOp.rightShiftUnsigned:
                newValue.rightShiftUnsignedBy(rhsCctx.pa.copy(), type);
                break;

            case PAMathOp.postInc:
            case PAMathOp.postDec:
                assertUnreachable();

            default:
                // final switch: D throws SwitchError on an unhandled value
                throw new SwitchError();
            }

            const ret = this.transferLogicalAnd(new DFALatticeRef(lhs), new DFALatticeRef(rhs));
            ret.check();

            if (ret.isNull())
                ret.opAssign(this.dfaCommon!.makeLatticeRef());
            const cctx = ret.acquireConstantAsContext();
            cctx.pa = newValue.copy();

            ret.check();
            return ret; // NRVO: the function's own local
        } finally {
            // by-value parameters, destroyed by the callee left to right
            lhs.__dtor();
            rhs.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/analysis.d:1536 — `DFALatticeRef transferDereference(DFALatticeRef lr, ref Loc loc)`. Answers
     * `*lr` (context: the dereference variable of `lr`'s context variable), recording the dereference depth in the
     * innermost loopy label. Reports "Dereference on null variable" when the context is known null, or unknown right
     * after a null assignment nothing has asserted since; infers a first-written parameter as non-null on input
     * otherwise. Consumes `lr`.
     */
    transferDereference(lr: DFALatticeRef, loc: Loc): DFALatticeRef {
        try {
            const ctx = lr.getContext();
            let couldBeNull = false;

            if (ctx !== null) {
                let var_ = ctx.var;

                if (var_ !== null) {
                    let scv: DFAScopeVar | null;

                    if ((scv = this.dfaCommon!.lastLoopyLabel!.findScopeVar(var_)) !== null) {
                        if (scv.derefDepth === 0 || scv.derefDepth > this.dfaCommon!.currentDFAScope!.depth)
                            scv.derefDepth = this.dfaCommon!.currentDFAScope!.depth;
                    }

                    if ((scv = this.dfaCommon!.currentDFAScope!.findScopeVar(var_)) !== null) {
                        if (var_.writeCount > 0 && scv.mergable.nullAssignAssertedCount === var_.assertedCount
                                && scv.mergable.nullAssignWriteCount === var_.writeCount
                                && var_.var !== null)
                            couldBeNull = true;
                    }

                    var_ = this.dfaCommon!.findDereferenceVar(var_);
                    lr.setContextFromDFAVar(var_);
                }

                if (ctx.nullable === Nullable.Unknown) {
                    // Infer input nullability

                    if (couldBeNull)
                        this.reporter!.onDereference(ctx, loc);
                    else if (ctx.var !== null && ctx.var.param !== null
                            && !ctx.var.param.specifiedByUser && !this.dfaCommon!.currentDFAScope!.inConditional
                            && ctx.writeOnVarAtThisPoint === 1 && ctx.var.assertedCount === 0) {
                        // dropped: `if (dfaCommon.debugIt) printf(...)` (analysis.d:1577), debugIt false (header)

                        ctx.nullable = Nullable.NonNull;
                        if (!ctx.var.doNotInferNonNull)
                            ctx.var.param.notNullIn = ParameterDFAInfo.Fact.Guaranteed;
                    }
                }
                else if (ctx.nullable === Nullable.Null)
                    this.reporter!.onDereference(ctx, loc);
            }

            return new DFALatticeRef(lr); // `return lr;` of a by-value parameter: copy ctor
        } finally {
            lr.__dtor(); // by-value parameter, destroyed by the callee (moved, so a no-op)
        }
    }

    /**
     * See_Also: equalityArgTypes
     *
     * dmd/dfa/fast/analysis.d:1594 — `DFALatticeRef transferEqual(DFALatticeRef lhs, DFALatticeRef rhs,`. Answers
     * `lhs == rhs` (`!=` when `equalityIsTrue` is false; `is` / `!is` under `isIdentity`): the logical AND of both
     * lattices with a constant context carrying the expected truthiness (pointers by nullability and object
     * identity, integers by point value), copying a constant side's facts onto the variable side when the result
     * is Maybe. A null handle when either context is missing. Consumes `lhs` and `rhs`.
     */
    transferEqual(lhs: DFALatticeRef, rhs: DFALatticeRef, equalityIsTrue: boolean, equalityType: EqualityArgType,
            isIdentity: boolean): DFALatticeRef {
        try {
            // struct
            // floating point
            // lhs && rhs    static or dynamic array
            // cpu op

            const lhsCctx = lhs.getContext(), rhsCctx = rhs.getContext();
            if (lhsCctx === null || rhsCctx === null)
                return new DFALatticeRef();

            const lhsVar = lhsCctx.var, rhsVar = rhsCctx.var;
            let expectedTruthiness: Truthiness = Truthiness.Unknown;

            const couldBeUnknown: Ref<boolean> = { value: false };

            this.checkPAVar(lhsVar, couldBeUnknown);
            this.checkPAVar(rhsVar, couldBeUnknown);

            const treatAsInteger = equalityType === EqualityArgType.Unknown;
            const treatAsPointer = equalityType === EqualityArgType.DynamicArray
                || equalityType === EqualityArgType.AssociativeArray
                || equalityType === EqualityArgType.Nullable;

            // dropped: `dfaCommon.printState(...)` (analysis.d:1619), debug dump (file header)

            if ((lhsVar === null || lhsVar.isModellable()) && (rhsVar === null || rhsVar.isModellable())) {
                expectedTruthiness = Truthiness.Maybe;

                if (equalityIsTrue) {
                    if (treatAsPointer) {
                        if (lhsCctx.nullable === Nullable.NonNull && rhsCctx.nullable === Nullable.NonNull
                                && lhsCctx.obj !== null && lhsCctx.obj === rhsCctx.obj
                                && !lhsCctx.obj.mayNotBeExactPointer)
                            expectedTruthiness = isIdentity ? Truthiness.True : Truthiness.Maybe;
                        else if (lhsCctx.nullable === Nullable.Null
                                && lhsCctx.nullable === rhsCctx.nullable)
                            expectedTruthiness = Truthiness.True;
                        else if (lhsCctx.truthiness === Truthiness.False
                                && lhsCctx.truthiness === rhsCctx.truthiness)
                            expectedTruthiness = Truthiness.True;
                        else if (lhsCctx.truthiness !== rhsCctx.truthiness && (lhsCctx.truthiness === Truthiness.False
                                || rhsCctx.truthiness === Truthiness.False)
                                && (lhsCctx.truthiness === Truthiness.True
                                    || rhsCctx.truthiness === Truthiness.True))
                            expectedTruthiness = Truthiness.False;
                    }
                    else {
                        expectedTruthiness = lhsCctx.pa.compareEqual(rhsCctx.pa);

                        if (expectedTruthiness < Truthiness.False) {
                            if (lhsCctx.truthiness === Truthiness.False
                                    && lhsCctx.truthiness === rhsCctx.truthiness)
                                expectedTruthiness = Truthiness.True;
                            else if (!treatAsInteger && lhsCctx.truthiness !== rhsCctx.truthiness
                                    && (lhsCctx.truthiness === Truthiness.False
                                        || rhsCctx.truthiness === Truthiness.False)
                                    && (lhsCctx.truthiness === Truthiness.True
                                        || rhsCctx.truthiness === Truthiness.True))
                                expectedTruthiness = Truthiness.False;
                            else
                                expectedTruthiness = Truthiness.Maybe;
                        }
                        else if (couldBeUnknown.value || !treatAsInteger)
                            expectedTruthiness = Truthiness.Maybe;
                    }
                }
                else {
                    if (treatAsPointer) {
                        if ((lhsCctx.nullable === Nullable.NonNull
                                || rhsCctx.nullable === Nullable.NonNull)
                                && lhsCctx.nullable !== rhsCctx.nullable)
                            expectedTruthiness = Truthiness.True;
                        else if (lhsCctx.nullable === Nullable.NonNull
                                && lhsCctx.nullable === rhsCctx.nullable) {
                            if (lhsCctx.obj !== null && lhsCctx.obj === rhsCctx.obj
                                    && !lhsCctx.obj.mayNotBeExactPointer)
                                expectedTruthiness = isIdentity ? Truthiness.False : Truthiness.Maybe;
                            else
                                expectedTruthiness = Truthiness.Maybe;
                        }
                        else if (lhsCctx.nullable === Nullable.Null
                                && lhsCctx.nullable === rhsCctx.nullable)
                            expectedTruthiness = Truthiness.False;
                    }
                    else {
                        expectedTruthiness = lhsCctx.pa.compareNotEqual(rhsCctx.pa);

                        if (expectedTruthiness >= Truthiness.False) {
                            if (couldBeUnknown.value || !treatAsInteger)
                                expectedTruthiness = Truthiness.Maybe;
                        }
                        else
                            expectedTruthiness = Truthiness.Maybe;
                    }
                }
            }

            // dropped: `dfaCommon.printState(...)` (analysis.d:1712), debug dump (file header)

            if (expectedTruthiness === Truthiness.Maybe) {
                // Copy over the effects from a constant to non-constant with variable.
                // Allows for a == non-null to make a non-null.
                let toEffectCctx: DFAConsequence | null = null, fromEffectCctx: DFAConsequence | null = null;

                if (lhsVar === null) {
                    fromEffectCctx = lhsCctx;
                    toEffectCctx = rhsCctx;
                }
                else if (rhsVar === null) {
                    toEffectCctx = lhsCctx;
                    fromEffectCctx = rhsCctx;
                }

                if (toEffectCctx !== null && toEffectCctx.var !== null) {
                    const copy = (toEffectCctx.var.isTruthy
                            && toEffectCctx.truthiness === Truthiness.Unknown)
                        || (toEffectCctx.var.isNullable && toEffectCctx.nullable === Nullable.Unknown);

                    if (copy) {
                        if (equalityIsTrue) {
                            if (toEffectCctx.var.isTruthy)
                                toEffectCctx.truthiness = fromEffectCctx!.truthiness;
                            if (toEffectCctx.var.isNullable)
                                toEffectCctx.nullable = fromEffectCctx!.nullable;
                        }
                        else {
                            if (toEffectCctx.var.isTruthy)
                                toEffectCctx.truthiness = fromEffectCctx!.truthiness === Truthiness.True
                                    ? Truthiness.False : (fromEffectCctx!.truthiness === Truthiness.False
                                        ? Truthiness.True : Truthiness.Unknown);
                            if (toEffectCctx.var.isNullable)
                                toEffectCctx.nullable = fromEffectCctx!.nullable === Nullable.NonNull
                                    ? Nullable.Null : (fromEffectCctx!.nullable === Nullable.Null
                                        ? Nullable.NonNull : Nullable.Unknown);
                        }
                    }
                }
            }

            const expectedInvertedOnce = lhsCctx.invertedOnce || rhsCctx.invertedOnce;
            const ret = this.transferLogicalAnd(new DFALatticeRef(lhs), new DFALatticeRef(rhs));

            {
                const c = ret.acquireConstantAsContextTruthiness(expectedTruthiness, Nullable.Unknown, null);
                c.invertedOnce = expectedInvertedOnce;

                const c2 = ret.findConsequence(rhsVar);
                if (c2 !== null) {
                    c.maybe = rhsVar;
                    c2.maybe = lhsVar;
                }
                else
                    c.maybe = lhsVar;
            }

            // From here on lhsCctx / rhsCctx name nodes of the lattices transferLogicalAnd consumed and freed: D
            // writes into those free-list nodes too (they are re-initialized when handed out again).
            if (treatAsPointer) {
                if (equalityIsTrue) {
                    // var is !null -> var non-null
                    // !null is var -> var non-null

                    // if lhs or rhs is constant
                    //     if lhs or rhs is non-constant && lhs or rhs !is null
                    //         upgrade the non-constant to !is null

                    if (lhsVar === null && rhsVar !== null && lhsCctx.nullable === Nullable.Null) {
                        if (rhsCctx.nullable === Nullable.NonNull)
                            rhsCctx.nullable = Nullable.NonNull;
                    }
                    else if (lhsVar !== null && rhsVar === null && rhsCctx.nullable === Nullable.Null) {
                        if (lhsCctx.nullable === Nullable.NonNull)
                            lhsCctx.nullable = Nullable.NonNull;
                    }

                    ret.walkMaybeTops((c: DFAConsequence): boolean => (c.protectElseNegate = true));
                }
                else {
                    // var !is null -> var non-null
                    // null !is var -> var non-null

                    // if lhs or rhs is constant
                    //     if lhs or rhs is non-constant && lhs or rhs is null
                    //         upgrade the non-constant to !is null

                    if (lhsVar === null && rhsVar !== null && lhsCctx.nullable === Nullable.Null) {
                        if (rhsCctx.nullable === Nullable.Null)
                            rhsCctx.nullable = Nullable.NonNull;
                    }
                    else if (lhsVar !== null && rhsVar === null && rhsCctx.nullable === Nullable.Null) {
                        if (lhsCctx.nullable === Nullable.Null)
                            lhsCctx.nullable = Nullable.NonNull;
                    }
                }
            }

            if (equalityIsTrue)
                ret.walkMaybeTops((c: DFAConsequence): boolean => (c.protectElseNegate = true));
            else
                ret.walkMaybeTops((c: DFAConsequence): boolean => (c.invertedOnce = true));

            return ret; // NRVO: the function's own local
        } finally {
            // by-value parameters, destroyed by the callee left to right
            lhs.__dtor();
            rhs.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/analysis.d:1835 — `DFALatticeRef transferGreaterThan(bool orEqualTo,`.
     * Answers `lhs > rhs` (`>=` under `orEqualTo`): the logical AND of both lattices with a constant context
     * carrying the point-value comparison (Maybe for a variable declared outside the innermost loopy label). A
     * comparison against a positive constant makes the left variable and its roots true and non-null; the right
     * variable's roots are never inferred non-null afterwards. Preconditions: both contexts exist (asserted).
     * Consumes `lhs` and `rhs`.
     */
    transferGreaterThan(orEqualTo: boolean, lhs: DFALatticeRef, rhs: DFALatticeRef): DFALatticeRef {
        try {
            const lhsVar: Ref<DFAVar | null> = { value: null }, rhsVar: Ref<DFAVar | null> = { value: null };
            const lhsCctx = lhs.getContext(lhsVar);
            const rhsCctx = rhs.getContext(rhsVar);

            assert(lhsCctx !== null);
            assert(rhsCctx !== null);

            const couldBeUnknown: Ref<boolean> = { value: false };
            this.checkPAVar(lhsCctx.var, couldBeUnknown);
            this.checkPAVar(rhsCctx.var, couldBeUnknown);

            let expectedTruthiness: Truthiness = Truthiness.Unknown;

            if ((lhsVar.value === null || lhsVar.value.isModellable())
                    && (rhsVar.value === null || rhsVar.value.isModellable())) {
                expectedTruthiness = orEqualTo ? lhsCctx.pa.greaterThanOrEqual(
                        rhsCctx.pa) : lhsCctx.pa.greaterThan(rhsCctx.pa);

                if (couldBeUnknown.value)
                    expectedTruthiness = Truthiness.Maybe;

                if (lhsVar.value !== null) {
                    if (rhsCctx.pa.kind === DFAPAValue.Kind.Concrete
                            && (rhsCctx.pa.value > 0n || (!orEqualTo && rhsCctx.pa.value === 0n))) {
                        // ok clearly non-null

                        if (lhsVar.value.isTruthy)
                            lhsCctx.truthiness = Truthiness.True;
                        if (lhsVar.value.isNullable)
                            lhsCctx.nullable = Nullable.NonNull;
                    }

                    lhsVar.value.walkRoots((var_: DFAVar): void => {
                        if (var_ === lhsVar.value)
                            return;

                        const cctx = lhs.findConsequence(var_);
                        if (cctx === null)
                            return;

                        cctx.truthiness = lhsCctx.truthiness;
                        cctx.nullable = lhsCctx.nullable;
                        cctx.pa = lhsCctx.pa.copy();
                    });
                }

                if (rhsVar.value !== null) {
                    rhsVar.value.walkRoots((var_: DFAVar): void => { var_.doNotInferNonNull = true; });
                }
            }

            const ret = this.transferLogicalAnd(new DFALatticeRef(lhs), new DFALatticeRef(rhs));
            ret.acquireConstantAsContextTruthiness(expectedTruthiness, Nullable.Unknown, null);
            return ret; // NRVO: the function's own local
        } finally {
            // by-value parameters, destroyed by the callee left to right
            lhs.__dtor();
            rhs.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/analysis.d:1896 — `void transferGoto(DFAScope* toSc, bool isAfter)`. Records a jump to `toSc`:
     * a copy of the current scope, joined with `toSc`'s after-state (`isAfter`) or before-state when it has one,
     * becomes `toSc`'s before-state (the joined state is moved out of `toSc` first).
     */
    transferGoto(toSc: DFAScope, isAfter: boolean): void {
        const temp = this.dfaCommon!.currentDFAScope!.copy();

        if (isAfter) {
            if (!toSc.afterScopeState.isNull())
                temp.opAssign(this.joinScope(new DFAScopeRef(toSc.afterScopeState), new DFAScopeRef(temp)));
        }
        else {
            if (!toSc.beforeScopeState.isNull())
                temp.opAssign(this.joinScope(new DFAScopeRef(toSc.beforeScopeState), new DFAScopeRef(temp)));
        }

        toSc.beforeScopeState.opAssign(new DFAScopeRef(temp));
        temp.__dtor(); // D destroys the local at exit (moved, so a no-op)
    }

    /**
     * dmd/dfa/fast/analysis.d:1914 — `void transferForwardsGoto(Identifier ident)`. Records a forward jump to the
     * label `ident`: a copy of the current scope, joined with the state already recorded for `ident` if any.
     */
    transferForwardsGoto(ident: Identifier | null): void {
        const temp = this.dfaCommon!.currentDFAScope!.copy();

        this.dfaCommon!.swapForwardLabelScope(ident, (old: DFAScopeRef): DFAScopeRef => {
            try {
                if (old.isNull())
                    return new DFAScopeRef(temp); // `return temp;` of the enclosing local: copy ctor (moves)
                return this.joinScope(new DFAScopeRef(old), new DFAScopeRef(temp));
            } finally {
                old.__dtor(); // by-value delegate parameter, destroyed by the callee
            }
        });

        temp.__dtor(); // D destroys the local at exit
    }

    /**
     * dmd/dfa/fast/analysis.d:1925 — `DFALatticeRef transferLogicalAnd(DFALatticeRef lhs, DFALatticeRef rhs)`.
     * Answers `lhs && rhs`: a new lattice whose constant context chains (through `maybe`) the maybe-tops of `lhs`
     * then of `rhs` (a variable on both sides is joined), plus every other consequence of both; its truthiness is
     * the common one, False when `lhs` is False, Maybe when either side is, else Unknown. A Maybe `lhs` context is
     * made True first. Consumes `lhs` and `rhs` (so their lattices are freed).
     */
    transferLogicalAnd(lhs: DFALatticeRef, rhs: DFALatticeRef): DFALatticeRef {
        try {
            const cctxLHS = lhs.getContext();
            const cctxRHS = rhs.getContext();
            const lhsCctxMaybe = cctxLHS !== null && cctxLHS.truthiness === Truthiness.Maybe;

            if (lhsCctxMaybe)
                cctxLHS!.truthiness = Truthiness.True;

            /*
            We have two trees that look like:
                 constant
                /        \
               leaf      leaf

            And need to recombine them into this form, where the constants are discarded from the origin.
            */

            const ret = this.dfaCommon!.makeLatticeRef();
            const cctx = ret.acquireConstantAsContext();
            ret.check();

            let firstMaybe: DFAVar | null = null;
            let lastMaybe: Slot<DFAVar | null> = { get: () => firstMaybe, set: (v) => { firstMaybe = v; } };

            lhs.walkMaybeTops((oldC: DFAConsequence): boolean => {
                if (oldC.var === null)
                    return true;

                const newC = ret.addConsequence(oldC.var, oldC)!;

                lastMaybe.set(newC.var);
                lastMaybe = maybeSlot(newC);

                ret.check();
                return true;
            });

            rhs.walkMaybeTops((oldC: DFAConsequence): boolean => {
                if (oldC.var === null)
                    return true;

                const result = ret.findConsequence(oldC.var);

                if (result === null) {
                    const newC = ret.addConsequence(oldC.var, oldC)!;

                    lastMaybe.set(newC.var);
                    lastMaybe = maybeSlot(newC);
                }
                else
                    result.joinConsequence(result, oldC, null, false, false, true);

                ret.check();
                return true;
            });

            lhs.opApply((oldC: DFAConsequence): number => {
                if (oldC.var === null)
                    return 0;

                if (!oldC.maybeTopSeen) {
                    ret.addConsequence(oldC.var, oldC);
                    ret.check();
                }
                return 0;
            });

            rhs.opApply((oldC: DFAConsequence): number => {
                if (oldC.var === null)
                    return 0;

                if (!oldC.maybeTopSeen) {
                    ret.addConsequence(oldC.var, oldC);
                    ret.check();
                }
                return 0;
            });

            cctx.maybe = firstMaybe;

            if (cctxLHS !== null && cctxRHS !== null) {
                if (cctxLHS.truthiness === cctxRHS.truthiness)
                    cctx.truthiness = cctxLHS.truthiness;
                else if (cctxLHS.truthiness === Truthiness.False)
                    cctx.truthiness = Truthiness.False;
                else if (lhsCctxMaybe || cctxRHS.truthiness === Truthiness.Maybe)
                    cctx.truthiness = Truthiness.Maybe;
                else
                    cctx.truthiness = Truthiness.Unknown;
            }
            else
                cctx.truthiness = Truthiness.Unknown;

            ret.check();
            return ret; // NRVO: the function's own local
        } finally {
            // by-value parameters, destroyed by the callee left to right
            lhs.__dtor();
            rhs.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/analysis.d:2027 — `DFALatticeRef transferLogicalOr(DFALatticeRef lhs, DFALatticeRef rhs)`.
     * Answers `lhs || rhs`: every variable of `lhs` (the maybe-tops chained through `maybe`), met with its `rhs`
     * consequence where `rhs` has one; the context is the variable pair of both contexts, True when either side is
     * True, Maybe when neither is Unknown. Consumes `lhs` and `rhs`.
     */
    transferLogicalOr(lhs: DFALatticeRef, rhs: DFALatticeRef): DFALatticeRef {
        try {
            const lhsCctx = lhs.getContext();
            const rhsCctx = rhs.getContext();
            const lhsCtx = lhsCctx !== null ? lhsCctx.var : null,
                rhsCtx = rhsCctx !== null ? rhsCctx.var : null;

            /*
            We have two trees that look like:
                 constant
                /        \
               leaf      leaf

            And need to recombine them into this form, where the constants are discarded from the origin.

            (a && b && e) || (c && d && e) -> (e) || (e) -> e

            We are not interested in a, b, c, or d.
            This is due to us having no knowledge if the effect is in effect.
            */

            const ret = this.dfaCommon!.makeLatticeRef();
            let lastMaybe: DFAVar | null = null;

            // Add maybe tops, that are in both
            lhs.walkMaybeTops((oldC: DFAConsequence): boolean => {
                if (oldC.var === null)
                    return true;

                const result = ret.addConsequence(oldC.var)!;
                const oldC2 = rhs.findConsequence(oldC.var);

                if (oldC2 === null)
                    return true;

                result.meetConsequence(oldC, oldC2, true);

                result.maybe = lastMaybe;
                lastMaybe = result.var;
                return true;
            });

            // Now add the consequences that are both in lhs and rhs,
            //  that are not maybe tops.

            lhs.opApply((oldC: DFAConsequence): number => {
                if (oldC.var === null || oldC.maybeTopSeen)
                    return 0;

                const result = ret.addConsequence(oldC.var)!;
                const oldC2 = rhs.findConsequence(oldC.var);
                if (oldC2 === null)
                    return 0;

                result.meetConsequence(oldC, oldC2, true);
                return 0;
            });

            const newCtx = this.dfaCommon!.findVariablePair(lhsCtx, rhsCtx);
            const cctx = ret.addConsequence(newCtx)!;
            ret.setContext(cctx);
            cctx.maybe = lastMaybe;

            if (lhsCctx !== null && rhsCctx !== null) {
                if (lhsCctx.truthiness === Truthiness.True || rhsCctx.truthiness === Truthiness.True)
                    cctx.truthiness = Truthiness.True;
                else if (lhsCctx.truthiness !== Truthiness.Unknown
                        && rhsCctx.truthiness !== Truthiness.Unknown)
                    cctx.truthiness = Truthiness.Maybe;
            }

            return ret; // NRVO: the function's own local
        } finally {
            // by-value parameters, destroyed by the callee left to right
            lhs.__dtor();
            rhs.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/analysis.d:2102 — `DFALatticeRef transferConditional(DFALatticeRef condition,`.
     * Answers `condition ? lrTrue : lrFalse`: converges the two branch scopes as an if without an else body, then
     * meets the two value lattices; the context is the variable pair of both contexts with an object derived from
     * both. Consumes all five handles.
     */
    transferConditional(condition: DFALatticeRef, scrTrue: DFAScopeRef, lrTrue: DFALatticeRef,
            scrFalse: DFAScopeRef, lrFalse: DFALatticeRef, unknownBranchTaken: boolean,
            predicateNegation: number): DFALatticeRef {
        try {
            this.convergeStatementIf(new DFALatticeRef(condition), new DFAScopeRef(scrTrue),
                    new DFAScopeRef(scrFalse), false, unknownBranchTaken, predicateNegation);

            const trueVar: Ref<DFAVar | null> = { value: null }, falseVar: Ref<DFAVar | null> = { value: null };
            const trueCctx = lrTrue.getContext(trueVar),
                falseCctx = lrFalse.getContext(falseVar);

            const trueObj = trueCctx !== null ? trueCctx.obj : null;
            const falseObj = falseCctx !== null ? falseCctx.obj : null;

            const asContext = this.dfaCommon!.findVariablePair(trueVar.value, falseVar.value);

            const ret = this.meet(new DFALatticeRef(lrTrue), new DFALatticeRef(lrFalse), 0, true);

            const cctx = ret.setContextFromDFAVar(asContext);
            cctx!.obj = this.dfaCommon!.makeObject(trueObj, falseObj);
            return ret; // NRVO: the function's own local
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
     * dmd/dfa/fast/analysis.d:2126 — `DFAScopeRef transferLoopyLabelAwareStage(DFAScopeRef previous,`.
     * Accumulates the states of the stages of a loopy label (a switch's cases): a stage that jumped or returned
     * contributes nothing (`previous` is answered), the first stage is answered as is, later ones are met with
     * `previous` (jumped / returned only when both did). Consumes both handles; `next` must be non-null.
     */
    transferLoopyLabelAwareStage(previous: DFAScopeRef, next: DFAScopeRef): DFAScopeRef {
        try {
            assert(!next.isNull());

            if (next.sc!.haveJumped || next.sc!.haveReturned) {
                /*
                    Handles the case where you have:

                    int* ptr;
                    switch(thing) {
                        case 0:
                            ptr = new int;
                            break;
                        default:
                            return;
                    }
                */
                return new DFAScopeRef(previous); // `return previous;` of a by-value parameter: copy ctor
            }

            if (previous.isNull())
                return new DFAScopeRef(next); // `return next;` of a by-value parameter: copy ctor

            const allJumped = previous.sc!.haveJumped && next.sc!.haveJumped,
                allReturned = previous.sc!.haveReturned && next.sc!.haveReturned;

            const ret = this.meetScope(new DFAScopeRef(previous), new DFAScopeRef(next), true, true);
            assert(!ret.isNull());

            if (allJumped)
                ret.sc!.haveJumped = true;
            if (allReturned)
                ret.sc!.haveReturned = true;

            return ret; // NRVO: the function's own local
        } finally {
            // by-value parameters, destroyed by the callee left to right
            previous.__dtor();
            next.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/analysis.d:2164 — `void onRead(ref DFALatticeRef lr, ref Loc loc, bool willInit = false,`. The
     * read of `lr`'s context variable: reports reads of uninitialized variables (for an initializing write only
     * the variables read to compute the address; for a by-ref argument the variables it refers to; otherwise the
     * variable and what its indirections read), and for a plain read copies the met state of the objects the
     * indirections reach onto the context. No-op for a variable-less context. `lr` is by ref (not consumed).
     */
    onRead(lr: DFALatticeRef, loc: Loc, willInit = false, isByRef = false, forMathOp = false): void {
        // dropped: version (none) trace (analysis.d:2167)

        // Called by statement, expressions and analysis.
        const contextVar: Ref<DFAVar | null> = { value: null };
        const cctx = lr.getContext(contextVar);

        if (contextVar.value === null)
            return;
        assert(cctx !== null);

        const toStore = new DFALatticeRef();
        try {
            const seeRootObject = (root: DFAObject): void => {
                // dropped: version (none) trace (analysis.d:2185)

                // Don't apply effects from a variable that isn't actually modelled i.e. indirection.

                if (root.storageFor !== null && !root.storageFor.haveBase()) {
                    const lr = this.dfaCommon!.acquireLattice(root.storageFor);
                    const cctx = lr.getContext();

                    if (cctx !== null && cctx.writeOnVarAtThisPoint === 0)
                        this.reporter!.onReadOfUninitialized(root.storageFor, lr, loc, forMathOp);

                    if (toStore.isNull())
                        toStore.opAssign(new DFALatticeRef(lr));
                    else
                        toStore.opAssign(this.meet(new DFALatticeRef(toStore), new DFALatticeRef(lr)));

                    lr.__dtor(); // D destroys the block-local `lr` (moved, so a no-op)
                }
            };

            if (willInit) {
                // We differentiate if it is some form of initialize either lhs or rhs and isByRef because
                // initialization of a struct member does not necessarily read the struct itself (offsets are fine),
                // whereas ref parameters likely imply a read or dependency that requires initialization.

                // When initializing (writing), we only care if we are reading a variable to determine the address.
                // e.g. `*ptr = 2` reads `ptr`. `struct.field = 2` does NOT read `struct`.
                // `visitIfReadOfReferenceToAnotherVar` implements this logic (dereferences read base, offsets do
                // not).

                contextVar.value.visitIfReadOfReferenceToAnotherVar((root: DFAVar): void => {
                    if (root.var === null || root === contextVar.value || root.unmodellable
                        || root.haveInfiniteLifetime)
                        return;

                    const c = lr.findConsequence(root);
                    if (c === null)
                        return;

                    if (c.writeOnVarAtThisPoint === 0)
                        this.reporter!.onReadOfUninitialized(root, lr, loc, forMathOp);
                });
            }
            else if (isByRef) {
                // For ref params, we generally require initialization unless it's 'out', but 'out' should be handled
                // elsewhere/differently?
                // Existing logic assumes 'ref' requires init.

                contextVar.value.visitIfReferenceToAnotherVar((root: DFAVar): void => {
                    if (root.var === null || root === contextVar.value || root.unmodellable
                        || root.haveInfiniteLifetime)
                        return;

                    const c = lr.findConsequence(root);
                    if (c === null)
                        return;

                    if (c.writeOnVarAtThisPoint === 0)
                        this.reporter!.onReadOfUninitialized(root, lr, loc, forMathOp);
                    else if (c.obj !== null)
                        c.obj.walkRoots(seeRootObject);
                });
            }
            else {
                // We don't care about the case where indirection is involved.
                // int val1 = void;
                // int* ptr = &val1;
                // int val2 = *ptr; // no error

                if (!contextVar.value.haveBase()) {
                    if (contextVar.value.var !== null && cctx.writeOnVarAtThisPoint === 0)
                        this.reporter!.onReadOfUninitialized(contextVar.value, lr, loc, forMathOp);
                }

                contextVar.value.visitIfReadOfReferenceToAnotherVar((root: DFAVar): void => {
                    // dropped: version (none) trace (analysis.d:2264)

                    if (root.haveBase() || root.unmodellable || root.haveInfiniteLifetime)
                        return;

                    const c = lr.findConsequence(root);
                    if (c === null)
                        return;

                    // dropped: version (none) trace (analysis.d:2278)

                    if (root.var !== null && c.writeOnVarAtThisPoint === 0)
                        this.reporter!.onReadOfUninitialized(root, lr, loc, forMathOp);
                    else if (c.obj !== null)
                        c.obj.walkRoots(seeRootObject);
                });

                cctx.copyFrom(toStore.getContext());
            }
        } finally {
            toStore.__dtor(); // D destroys the local at exit
        }
    }

    // D `private:` (analysis.d:2293) — class-local: TS `private` (file header).

    /**
     * dmd/dfa/fast/analysis.d:2295 — `DFAScopeRef meetScope(DFAScopeRef scr1, DFAScopeRef scr2, bool copyAll,`.
     * A new child scope of the current one (same depth) holding, for each variable of `scr1` (bucket order), the
     * MEET of its lattices in both scopes; with `copyAll` also the variables only one side has (`scr2`'s moved
     * over after). Jumped / returned only when both scopes did. Consumes both handles, which must be non-null.
     */
    private meetScope(scr1: DFAScopeRef, scr2: DFAScopeRef, copyAll: boolean,
            couldScopeNotHaveRan = false): DFAScopeRef {
        try {
            scr1.check();
            scr2.check();

            const depth = this.dfaCommon!.currentDFAScope!.depth;

            const ret = new DFAScopeRef();
            ret.sc = this.dfaCommon!.allocator.makeScope(this.dfaCommon!, this.dfaCommon!.currentDFAScope);
            ret.sc.depth = depth;
            ret.sc.haveJumped = scr1.sc!.haveJumped && scr2.sc!.haveJumped;
            ret.sc.haveReturned = scr1.sc!.haveReturned && scr2.sc!.haveReturned;

            const lr1 = new DFALatticeRef(), lr2 = new DFALatticeRef();
            const mergable1: Ref<DFAScopeVarMergable> = { value: new DFAScopeVarMergable() },
                mergable2: Ref<DFAScopeVarMergable> = { value: new DFAScopeVarMergable() };
            const var_: Ref<DFAVar | null> = { value: null };

            try {
                for (;;) {
                    lr1.opAssign(scr1.consumeNext(var_, mergable1));
                    if (lr1.isNull())
                        break;

                    lr2.opAssign(scr2.consumeVar(var_.value, mergable2));

                    if (!copyAll && lr2.isNull())
                        continue;

                    lr1.check();
                    lr2.check();

                    const meeted = this.meet(new DFALatticeRef(lr1), new DFALatticeRef(lr2), depth,
                            couldScopeNotHaveRan);
                    assert(!meeted.isNull());
                    meeted.check();

                    const scv = ret.assignLattice(var_.value, new DFALatticeRef(meeted));
                    scv!.mergable.merge(mergable1.value.copy());
                    scv!.mergable.merge(mergable2.value.copy());
                    meeted.__dtor(); // D destroys the loop-body local (moved, so a no-op)
                }

                if (copyAll) {
                    for (;;) {
                        lr2.opAssign(scr2.consumeNext(var_, mergable2));
                        if (lr2.isNull())
                            break;

                        lr2.check();
                        const scv = ret.assignLattice(var_.value, new DFALatticeRef(lr2));
                        scv!.mergable.merge(mergable2.value.copy());
                    }
                }

                ret.check();
                return ret; // NRVO: the function's own local
            } finally {
                // D destroys the locals at exit, in reverse declaration order
                lr2.__dtor();
                lr1.__dtor();
            }
        } finally {
            // by-value parameters, destroyed by the callee left to right
            scr1.__dtor();
            scr2.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/analysis.d:2354 — `DFAScopeRef joinScope(DFAScopeRef scr1, DFAScopeRef scr2)`. A new child scope
     * of the current one (same depth) holding, for each variable of `scr1` (bucket order), the JOIN of its lattices
     * in both scopes; `scr2`'s other variables are dropped. Jumped / returned only when both scopes did. Consumes
     * both handles, which must be non-null.
     */
    private joinScope(scr1: DFAScopeRef, scr2: DFAScopeRef): DFAScopeRef {
        try {
            scr1.check();
            scr2.check();

            const depth = this.dfaCommon!.currentDFAScope!.depth;

            const ret = new DFAScopeRef();
            ret.sc = this.dfaCommon!.allocator.makeScope(this.dfaCommon!, this.dfaCommon!.currentDFAScope);
            ret.sc.depth = depth;
            ret.sc.haveJumped = scr1.sc!.haveJumped && scr2.sc!.haveJumped;
            ret.sc.haveReturned = scr1.sc!.haveReturned && scr2.sc!.haveReturned;

            const lr1 = new DFALatticeRef(), lr2 = new DFALatticeRef();
            const mergable1: Ref<DFAScopeVarMergable> = { value: new DFAScopeVarMergable() },
                mergable2: Ref<DFAScopeVarMergable> = { value: new DFAScopeVarMergable() };
            const var_: Ref<DFAVar | null> = { value: null };

            try {
                for (;;) {
                    lr1.opAssign(scr1.consumeNext(var_, mergable1));
                    if (lr1.isNull())
                        break;

                    lr2.opAssign(scr2.consumeVar(var_.value, mergable2));

                    lr1.check();
                    lr2.check();

                    const joined = this.join(new DFALatticeRef(lr1), new DFALatticeRef(lr2), depth);
                    assert(!joined.isNull());
                    joined.check();

                    const scv = ret.assignLattice(var_.value, new DFALatticeRef(joined));
                    scv!.mergable.merge(mergable1.value.copy());
                    scv!.mergable.merge(mergable2.value.copy());
                    joined.__dtor(); // D destroys the loop-body local (moved, so a no-op)
                }

                ret.check();
                return ret; // NRVO: the function's own local
            } finally {
                // D destroys the locals at exit, in reverse declaration order
                lr2.__dtor();
                lr1.__dtor();
            }
        } finally {
            // by-value parameters, destroyed by the callee left to right
            scr1.__dtor();
            scr2.__dtor();
        }
    }

    /***********************************************************
     * The Lattice 'Meet' operation (Intersection / Lower Bound).
     *
     * Used when we are combining facts that MUST be true.
     * Example: If `x` is NonNull in path A AND `x` is NonNull in path B,
     * then `x` is NonNull.
     *
     * dmd/dfa/fast/analysis.d:2402 — `DFALatticeRef meet(DFALatticeRef lhs, DFALatticeRef rhs,`. A new lattice with
     * the meet (DFAConsequence.meetConsequence) of every variable of `lhs` with its `rhs` consequence (and the lhs
     * context also with `rhs`'s constant), then every variable only `rhs` has; a positive `filterDepthOfVariable`
     * drops variables declared deeper. The context is `lhs`'s context variable. Consumes `lhs` and `rhs`.
     */
    private meet(lhs: DFALatticeRef, rhs: DFALatticeRef, filterDepthOfVariable = 0,
            couldScopeNotHaveRan = false): DFALatticeRef {
        try {
            const ret = this.dfaCommon!.makeLatticeRef();
            const constantRHS = rhs.findConsequence(null);
            const lhsVar = lhs.getContextVar();

            // dropped: version (DebugJoinMeetOp) trace (analysis.d:2409), OFF (_config.md)

            lhs.opApply((c1: DFAConsequence): number => {
                if (c1.var === null)
                    return 0;

                // dropped: version (DebugJoinMeetOp) trace (analysis.d:2420), OFF (_config.md)

                if (filterDepthOfVariable < c1.var.declaredAtDepth && filterDepthOfVariable > 0)
                    return 0;

                const result = ret.addConsequence(c1.var)!;
                const c2 = rhs.findConsequence(c1.var);

                result.meetConsequence(c1, c2, couldScopeNotHaveRan);

                if (c1.var === lhsVar && constantRHS !== null) {
                    result.meetConsequence(c1, constantRHS, couldScopeNotHaveRan);
                }
                return 0;
            });

            rhs.opApply((c2: DFAConsequence): number => {
                if (c2.var === null || lhs.findConsequence(c2.var) !== null)
                    return 0;

                // dropped: version (DebugJoinMeetOp) trace (analysis.d:2445), OFF (_config.md)

                if (filterDepthOfVariable < c2.var.declaredAtDepth && filterDepthOfVariable > 0)
                    return 0;

                const result = ret.addConsequence(c2.var)!;
                result.meetConsequence(c2, null, couldScopeNotHaveRan);
                return 0;
            });

            ret.setContextFromDFAVar(lhsVar);
            ret.check();
            return ret; // NRVO: the function's own local
        } finally {
            // by-value parameters, destroyed by the callee left to right
            lhs.__dtor();
            rhs.__dtor();
        }
    }

    /***********************************************************
     * The Lattice 'Join' operation (Union / Upper Bound).
     *
     * Used when merging diverging paths where EITHER could have happened.
     * Example: If `x` is 5 in path A, and `x` is 6 in path B.
     * Join(A, B) -> `x` is "Unknown Integer" (because it could be either).
     *
     * dmd/dfa/fast/analysis.d:2470 — `DFALatticeRef join(DFALatticeRef lhs, DFALatticeRef rhs,`.
     * A new lattice with the join (DFAConsequence.joinConsequence) of every variable of `lhs` with its `rhs`
     * consequence (the lhs context also with `rhs`'s constant) — or, when `lhs`'s context is `ignoreLHSCtx`, only
     * of the chain from its first base to the root — then every variable only `rhs` has; a constant `rhs` context
     * is joined onto the lhs context variable. A positive `filterDepthOfVariable` drops variables declared deeper.
     * The context is `lhs`'s context variable. Consumes `lhs` and `rhs`.
     */
    private join(lhs: DFALatticeRef, rhs: DFALatticeRef, filterDepthOfVariable = 0,
            ignoreLHSCtx: DFAVar | null = null, ignoreWriteCount = false, unknownAware = false): DFALatticeRef {
        try {
            const ret = this.dfaCommon!.makeLatticeRef();
            const constantRHS = rhs.findConsequence(null);

            const lhsVar: Ref<DFAVar | null> = { value: null }, rhsVar: Ref<DFAVar | null> = { value: null };
            const lhsCtx = lhs.getContext(lhsVar), rhsCtx = rhs.getContext(rhsVar);

            // dropped: version (DebugJoinMeetOp) trace (analysis.d:2479), OFF (_config.md)

            const processLHSVar = (c1: DFAConsequence | null): void => {
                // dropped: version (DebugJoinMeetOp) trace (analysis.d:2489), OFF (_config.md)

                if (filterDepthOfVariable < c1!.var!.declaredAtDepth && filterDepthOfVariable > 0)
                    return;

                const result = ret.addConsequence(c1!.var)!;
                const c2 = rhs.findConsequence(c1!.var);

                const isC1LHSCtx = lhsVar.value === c1!.var;
                result.joinConsequence(c1, c2, null, isC1LHSCtx, ignoreWriteCount, unknownAware);

                if (isC1LHSCtx && constantRHS !== null)
                    result.joinConsequence(c1, constantRHS, rhsCtx, true,
                            ignoreWriteCount, unknownAware);
            };

            // dropped: version (DebugJoinMeetOp) trace (analysis.d:2509), OFF (_config.md)

            if (ignoreLHSCtx === null || lhsVar.value !== ignoreLHSCtx) {
                lhs.opApply((c1: DFAConsequence): number => {
                    if (c1.var === null)
                        return 0;

                    processLHSVar(c1);
                    return 0;
                });
            }
            else if (lhsVar.value !== null && lhsVar.value.haveBase()) {
                lhsVar.value.visitFirstBase((firstBase: DFAVar): void => {
                    firstBase.walkToRoot((var_: DFAVar): void => {
                        processLHSVar(lhs.findConsequence(var_));
                    });
                });
            }

            // dropped: version (DebugJoinMeetOp) trace (analysis.d:2534), OFF (_config.md)

            rhs.opApply((c2: DFAConsequence): number => {
                // dropped: version (DebugJoinMeetOp) trace (analysis.d:2542), OFF (_config.md)

                if (c2.var === null || ret.findConsequence(c2.var) !== null)
                    return 0;

                if (filterDepthOfVariable < c2.var.declaredAtDepth && filterDepthOfVariable > 0)
                    return 0;

                const result = ret.addConsequence(c2.var)!;
                result.joinConsequence(c2, null, rhsCtx, false, ignoreWriteCount, unknownAware);
                return 0;
            });

            // dropped: version (DebugJoinMeetOp) trace (analysis.d:2558), OFF (_config.md)

            if (rhsCtx !== null && rhsVar.value === null && lhsVar.value !== null) {
                // dropped: version (DebugJoinMeetOp) trace (analysis.d:2566), OFF (_config.md)

                const result = ret.addConsequence(lhsVar.value)!;
                result.joinConsequence(rhsCtx, null, null, false, false, unknownAware);
                if (result.writeOnVarAtThisPoint < lhsCtx!.writeOnVarAtThisPoint)
                    result.writeOnVarAtThisPoint = lhsCtx!.writeOnVarAtThisPoint;
            }

            ret.setContextFromDFAVar(lhsVar.value);
            ret.check();

            // dropped: version (DebugJoinMeetOp) trace (analysis.d:2581), OFF (_config.md)

            return ret; // NRVO: the function's own local
        } finally {
            // by-value parameters, destroyed by the callee left to right
            lhs.__dtor();
            rhs.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/analysis.d:2590 — `void checkPAVar(DFAVar* var, ref bool couldBeUnknown)`. Sets `couldBeUnknown`
     * when `var` is declared (below the function level) outside the innermost loopy label, whose iterations may
     * have changed its point value. A null `var` is a no-op.
     */
    private checkPAVar(var_: DFAVar | null, couldBeUnknown: Ref<boolean>): void {
        if (var_ === null)
            return;

        if (var_.declaredAtDepth > 0 && this.dfaCommon!.lastLoopyLabel!.depth > var_.declaredAtDepth)
            couldBeUnknown.value = true;
    }

    /**
     * dmd/dfa/fast/analysis.d:2599 — `void seeWrite(ref DFAVar* assignTo, ref DFALatticeRef from)`. Records a write
     * to `assignTo`: every root's write count goes up, its scope variable is acquired in the current scope, the
     * innermost loopy label notes the shallowest assign depth, and `from` gets a consequence on the root stamped
     * with the new write count. D's `ref DFAVar*` is never written (a plain parameter); `from` is by ref.
     * Preconditions: `assignTo` non-null (asserted), `from` non-null.
     */
    private seeWrite(assignTo: DFAVar | null, from: DFALatticeRef): void {
        assert(assignTo !== null);
        const currentDepth = this.dfaCommon!.currentDFAScope!.depth;

        assignTo.walkRoots((root: DFAVar): void => {
            root.writeCount++;

            this.dfaCommon!.acquireScopeVar(root);

            const scv = this.dfaCommon!.lastLoopyLabel!.findScopeVar(root);
            if (scv !== null) {
                if (scv.assignDepth === 0 || scv.assignDepth > currentDepth)
                    scv.assignDepth = currentDepth;
            }

            const c = from.addConsequence(root)!;
            c.writeOnVarAtThisPoint = toUint32(root.writeCount); // int -> uint (09 §2)
        });
    }

    /** 03 §6.3: D's implicit field-wise copy (both pointers shared). */
    copy(): DFAAnalyzer {
        const c = new DFAAnalyzer();
        c.dfaCommon = this.dfaCommon;
        c.reporter = this.reporter;
        return c;
    }
}

/** The slot `&c.maybe` (analysis.d:1957/:1974), written by transferLogicalAnd's maybe chain. */
function maybeSlot(c: DFAConsequence): Slot<DFAVar | null> {
    return { get: () => c.maybe, set: (v: DFAVar | null) => { c.maybe = v; } };
}
