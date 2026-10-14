// Ported from dmd/sideeffect.d (module dmd.sideeffect).
//
// "Find side-effects of expressions."
//
// Eight top-level D declarations (manifest §1), in source order: `isTrivialExp` (:38) with its
// nested `IsTrivialExp` visitor class (:40), `hasSideEffect` (:76) with its nested
// `LambdaHasSideEffect` visitor class (:78), the two `callSideEffectLevel` overloads (:105, :130),
// the module-private `lambdaHasSideEffect` (:160), `discardValue` (:242), `copyToTemp` (:410) and
// `extractSideEffect` (:435). No `version`/`debug`/`static if` sites, no structs, no unions, no
// `goto`, no unittest blocks (manifest §2/§4/§5/§6/§8) — so nothing here is resolved away.
//
// VISITOR CENSUS (13-visitor.md §0(a) — recorded, as required, on a CODE-FREE header line): the D
// module declares NO type whose name ends in the visitor word; what it has is two `extern (C++)
// final class` declarations extending `StoppableVisitor`, nested INSIDE the function bodies that
// drive them (sideeffect.d:40, :78). They are real class declarations, so 13 §1's named-method
// rename applies (Idiom A), NOT 13 §7.5's nested-function idiom: each `override void
// visit(Expression e)` becomes `visitExpression`, and each `alias visit = typeof(super).visit;`
// (sideeffect.d:42, :80) is DROPPED (no overload hiding in TS).
//
// The classes stay NESTED inside their functions, exactly as in D. That is not a stylistic choice:
// `LambdaHasSideEffect.visitExpression` (sideeffect.d:89) reads `assumeImpureCalls`, the enclosing
// function's parameter, so the class body is a closure over it. Hoisting it to module scope would
// need a fabricated constructor parameter D does not have. The `extends StoppableVisitor` is
// therefore evaluated at CALL time rather than module-load time, which also keeps this module out
// of the load-order hazard of a class-extends-value edge into the core SCC (01 §4.1).
//
// OVERLOAD SET — one Form-B rename (04-functions.md §1 Form B). `callSideEffectLevel` has two
// same-arity overloads differing only in the parameter TYPE (`FuncDeclaration` at sideeffect.d:105,
// `Type` at :130), so arity dispatch is impossible and a runtime type test is forbidden (D already
// picked one statically at the single call site, :214). Rule 1's tie-breaks are ALL exhausted here:
// no TS dependent imports either form (the tree's 48 deferrals over this module name only
// `copyToTemp`/`discardValue`/`extractSideEffect`/`hasSideEffect`/`isTrivialExp`), and neither form
// has a cross-module D caller or a higher in-module call count — both are called exactly once, in
// the two arms of the same ternary at :214. Falling through to rule 2 (a FIRST-parameter receiver
// split takes the bare receiver-type suffix): the `FuncDeclaration` form keeps the BARE name — it is
// the form D prefers whenever it is available (`ce.f ? callSideEffectLevel(ce.f) : …`), and it is
// the richer one (it handles the ctor/invariant special cases) — and the `Type` form becomes
// `callSideEffectLevelType`. The in-tree PRECEDENT for that split is `walkPostorder` /
// `walkPostorderStatement` (postorder.ts:140, :152), where the first-declared form keeps the bare
// name and the second takes the receiver suffix; this file follows it. Reported as a naming
// decision for the integrator to register, since rule 1 decided nothing.
//
// `toChars`: the struct-rvalue diagnostic (sideeffect.d:269-275) prints through `Expression.toChars`
// (sideeffect.d:271-272) and `Dsymbol.toChars` (:274), both live over hdrgen.d:204/:231.
// `toErrMsg` is NOT a substitute: it is D's separate errorMsg-mode printer, truncated at 60 chars
// (hdrgen.ts file header). The three `toErrMsg` sites below (:383, :389, :397) are D's OWN
// `toErrMsg` calls and are fully live.
//
// CONSUMER SWEEP WORKLIST (cross-file; NOT this file's to fix — single writer, 14 §2 rule 1). Every
// symbol this module exports is now LIVE, so every wall over it whose text says the module is
// "unported"/"not ported" is FALSE at its site. The census, taken with
//   grep -nE 'TODO-BODY: (discardValue|copyToTemp|extractSideEffect|hasSideEffect|isTrivialExp)' src/dmd/*.ts
// is 48 sites: copyToTemp 25, extractSideEffect 11, discardValue 10, hasSideEffect 1 (D:76),
// isTrivialExp 1 (D:38) — in statementsem.ts, expressionsem.ts, dsymbolsem.ts and typesem.ts, plus
// the sema.*.test.ts files that PIN those wall messages (10 §1.8 rule 7: those pins get CONVERTED
// to the live behaviour, never deleted). No TS line numbers are recorded here on purpose: they
// drift with every wave, and the grep above is exact at any commit.
//   - `discardValue` at statementsem.d:234 stands behind the tree's largest red signature
//     (23 tests): that wall is what this port exists to unblock.
//   - ONE site is invisible to a cite-driven sweep: the `copyToTemp` wall in dsymbolsem.ts (call at
//     dsymbolsem.d:2596) mis-cites the D module as `dmd/expressionsem.d`, so a tree grep for
//     `sideeffect.d` does not print it. It must be found with the bare TODO-BODY grep above, and
//     the cite corrected to sideeffect.d:410 by whoever owns that file.
//   - Expect part of the discardValue reds to move to a HDRGEN wall rather than to green: the three
//     diagnostic legs (:383, :389, :397) call `toErrMsg`, still walled at `visitInteger`
//     (hdrgen.d:2214) and `visitBin` (hdrgen.d:2730). What the sema tests actually pin is the
//     FALSE-returning legs (sideeffect.d:244-278), which the sweep does make live.

import { assert, SwitchError } from "../assert.js";
import type { DString } from "../dstring.js";
import { ds } from "../dstring.js";
import { PURE, STC, Tclass, Tdelegate, Tfunction, Tnoreturn } from "./astenums.js";
import { VarDeclaration } from "./declaration.js";
import type { Scope } from "./dscope.js";
import { error, errorSupplemental } from "./errors.js";
import { DeclarationExp, EqualExp, Expression, VarExp } from "./expression.js";
import type { BinExp, CallExp, CastExp, CommaExp, CondExp, LogicalExp } from "./expression.js";
// Body-fill value imports (01 §4.3 — read only inside function bodies, never at load time). This
// applies to EVERY value import in this file, not just the line below: `PURE`/`STC`/the `T*` tags,
// `VarDeclaration`, `error`/`errorSupplemental`, the four `expression.js` classes, `isPure`,
// `toErrMsg`, `Id`, `Identifier`, `ExpInitializer`, `Type`, `EXP`, the three `typesem` functions,
// `walkPostorder` — and `StoppableVisitor`, the only load-order-critical one, since it is the
// `extends` operand at :88 and :131. It is read at CALL time because both visitor classes stay
// nested inside their functions, so this module opens no class-extends-value edge (01 §4.1).
import { expressionSemantic, isLvalue } from "./expressionsem.js";
import type { FuncDeclaration } from "./func.js";
import { isPure } from "./funcsem.js";
import { toErrMsg } from "./hdrgen.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { ExpInitializer } from "./init.js";
import { Type } from "./mtype.js";
import type { TypeFunction } from "./mtype.js";
import { EXP } from "./tokens.js";
import { mutabilityOfType, purityLevel, toBasetype } from "./typesem.js";
import { StoppableVisitor } from "./visitor/index.js";
import { walkPostorder } from "./visitor/postorder.js";

/**
 * dmd/sideeffect.d:38 — `bool isTrivialExp(Expression e)`.
 *
 * Front-end expression rewriting should create temporary variables for non trivial sub-expressions
 * in order to:
 *  1. save evaluation order
 *  2. prevent sharing of sub-expression in AST
 *
 * Postcondition: `true` iff the postorder walk completed without any node setting `stop` — i.e. no
 * sub-expression is a `CallExp` and none has a shallow side effect.
 */
export function isTrivialExp(e: Expression): boolean {
    // sideeffect.d:40 — `extern (C++) final class IsTrivialExp : StoppableVisitor`. Nested in D and
    // nested here (see the file header). `alias visit = typeof(super).visit;` (:42) is DROPPED —
    // no overload hiding in TS (13 §1).
    class IsTrivialExp extends StoppableVisitor {
        // sideeffect.d:44 — `extern (D) this() scope @safe {}`. `scope` on a local/`this` is a
        // lifetime hint with no value effect (03 §3.4/§8); the empty body is mirrored so `stop`
        // is initialized by the base ctor.
        constructor() {
            super();
        }

        // sideeffect.d:48 — `override void visit(Expression e)` -> `visitExpression` (13 §1).
        override visitExpression(e: Expression): void {
            /* https://issues.dlang.org/show_bug.cgi?id=11201
             * CallExp is always non trivial expression,
             * especially for inlining.
             */
            if (e.op === EXP.call) {
                this.stop = true;
                return;
            }
            // stop walking if we determine this expression has side effects
            this.stop = lambdaHasSideEffect(e);
        }
    }

    // sideeffect.d:64 — `scope IsTrivialExp v = new IsTrivialExp();` (`scope` erased, 03 §3.4).
    const v: IsTrivialExp = new IsTrivialExp();
    return walkPostorder(e, v) === false; // sideeffect.d:65
}

/**
 * dmd/sideeffect.d:76 — `bool hasSideEffect(Expression e, bool assumeImpureCalls = false)`.
 * Determine if Expression has any side effects.
 *
 * Params:
 *   e = the expression
 *   assumeImpureCalls = whether function calls should always be assumed to be impure (e.g. debug
 *                       is allowed to violate purity)
 *
 * The D default argument maps 1:1 to a TS default parameter (04 §3).
 */
export function hasSideEffect(e: Expression, assumeImpureCalls = false): boolean {
    // sideeffect.d:78 — `extern (C++) final class LambdaHasSideEffect : StoppableVisitor`. MUST stay
    // nested: its `visitExpression` closes over `assumeImpureCalls` (see the file header).
    // `alias visit = typeof(super).visit;` (:80) DROPPED — no overload hiding in TS (13 §1).
    class LambdaHasSideEffect extends StoppableVisitor {
        // sideeffect.d:82 — `extern (D) this() scope @safe {}`.
        constructor() {
            super();
        }

        // sideeffect.d:86 — `override void visit(Expression e)` -> `visitExpression` (13 §1).
        override visitExpression(e: Expression): void {
            // stop walking if we determine this expression has side effects
            this.stop = lambdaHasSideEffect(e, assumeImpureCalls);
        }
    }

    // sideeffect.d:93 — `scope LambdaHasSideEffect v = new LambdaHasSideEffect();`.
    const v: LambdaHasSideEffect = new LambdaHasSideEffect();
    return walkPostorder(e, v); // sideeffect.d:94
}

/**
 * dmd/sideeffect.d:105 — `int callSideEffectLevel(FuncDeclaration f)`. Determine if the call of `f`
 * has any side effects. Keeps the BARE name of the overload pair (04 §1 Form B — see the file
 * header for the tie-break trail).
 *
 * Returns:
 *      0   has any side effects
 *      1   nothrow + strongly pure
 *      2   nothrow + strongly pure + only immutable indirections in the return type
 */
export function callSideEffectLevel(f: FuncDeclaration): number {
    /* https://issues.dlang.org/show_bug.cgi?id=12760
     * https://issues.dlang.org/show_bug.cgi?id=16384
     *
     * ctor calls and invariant calls always have side effects
     */
    if (f.isCtorDeclaration() !== null || f.isInvariantDeclaration() !== null) // sideeffect.d:112
        return 0;
    assert(f.type!.ty === Tfunction); // sideeffect.d:114
    // sideeffect.d:115 — D's `cast(TypeFunction)f.type` becomes the tag-proved `isTypeFunction()`
    // downcast (mtype.ts:1018's own convention); the assert immediately above IS the proof.
    const tf: TypeFunction = f.type!.isTypeFunction()!;
    if (!tf.isNothrow) // sideeffect.d:116
        return 0;
    // sideeffect.d:118 — `final switch (f.isPure())`. The operand is hoisted to a local because the
    // `never` exhaustiveness arm below needs a NAMED binding to narrow (a bare `switch (isPure(f))`
    // gives TS nothing to assign to `_exhaustive`). `isPure` is the funcsem free function (04 §6).
    const purity: PURE = isPure(f);
    switch (purity) {
        case PURE.impure:
        case PURE.fwdref:
        case PURE.weak:
            return 0;

        case PURE.const_:
            return mutabilityOfType(tf.isRef, tf.next!) === 2 ? 2 : 1; // sideeffect.d:126

        default: {
            // final switch: D throws SwitchError on an unhandled value (06 §3.2). All four PURE
            // members are covered above, so this is unreachable by construction.
            const _exhaustive: never = purity;
            throw new SwitchError(_exhaustive);
        }
    }
}

/**
 * dmd/sideeffect.d:130 — `int callSideEffectLevel(Type t)`. Determine if the call of function type
 * or delegate type `t` has any side effects. Same return encoding as the `FuncDeclaration` form.
 * Form-B rename: `<name><ReceiverType>` (04 §1 Form B suffix rule 2).
 */
export function callSideEffectLevelType(t: Type): number {
    t = toBasetype(t); // sideeffect.d:132
    let tf: TypeFunction;
    if (t.ty === Tdelegate) // sideeffect.d:134
        // sideeffect.d:135 — `cast(TypeFunction)(cast(TypeDelegate)t).next`; both D casts become the
        // tag-proved downcasts, the `ty == Tdelegate` test above being the proof for the first and
        // a delegate's `next` being a TypeFunction by construction for the second.
        tf = t.isTypeDelegate()!.next!.isTypeFunction()!;
    else {
        assert(t.ty === Tfunction); // sideeffect.d:138
        tf = t.isTypeFunction()!; // sideeffect.d:139
    }
    if (!tf.isNothrow) // sideeffect.d:141 — function can throw
        return 0;

    purityLevel(tf); // sideeffect.d:144
    let purity: PURE = tf.purity; // sideeffect.d:145
    if (t.ty === Tdelegate && purity > PURE.weak) { // sideeffect.d:146
        if (tf.isMutable()) // sideeffect.d:148
            purity = PURE.weak;
        else if (!tf.isImmutable()) // sideeffect.d:150
            purity = PURE.const_;
    }

    if (purity === PURE.const_) // sideeffect.d:154
        return mutabilityOfType(tf.isRef, tf.next!) === 2 ? 2 : 1; // sideeffect.d:155

    return 0; // sideeffect.d:157
}

/**
 * dmd/sideeffect.d:160 — `private bool lambdaHasSideEffect(Expression e, bool assumeImpureCalls =
 * false)`. The SHALLOW (one-node) side-effect test the two visitors above and `discardValue` share.
 *
 * Kept module-private, as in D: nothing outside this module calls it (verified by grep over the D
 * tree — the only callers are sideeffect.d:60, :89, :244, :348 ×2).
 */
function lambdaHasSideEffect(e: Expression, assumeImpureCalls = false): boolean {
    switch (e.op) {
        // Sort the cases by most frequently used first
        case EXP.assign: // sideeffect.d:165
        case EXP.plusPlus:
        case EXP.minusMinus:
        case EXP.declaration:
        case EXP.construct:
        case EXP.blit:
        case EXP.addAssign:
        case EXP.minAssign:
        case EXP.concatenateAssign:
        case EXP.concatenateElemAssign:
        case EXP.concatenateDcharAssign:
        case EXP.mulAssign:
        case EXP.divAssign:
        case EXP.modAssign:
        case EXP.leftShiftAssign:
        case EXP.rightShiftAssign:
        case EXP.unsignedRightShiftAssign:
        case EXP.andAssign:
        case EXP.orAssign:
        case EXP.xorAssign:
        case EXP.powAssign:
        case EXP.in_:
        case EXP.remove:
        case EXP.assert_:
        case EXP.halt:
        case EXP.throw_:
        case EXP.delete_:
        case EXP.new_:
        case EXP.newAnonymousClass:
        case EXP.loweredAssignExp: // sideeffect.d:194
            return true;
        case EXP.call: { // sideeffect.d:196
            if (assumeImpureCalls)
                return true;

            if (e.type !== null && e.type.ty === Tnoreturn) // sideeffect.d:201
                return true;

            // sideeffect.d:204 — `CallExp ce = cast(CallExp)e`; the `case EXP.call` label is the tag
            // proof for the downcast.
            const ce: CallExp = e.isCallExp()!;
            /* Calling a function or delegate that is pure nothrow
             * has no side effects.
             */
            if (ce.e1!.type !== null) { // sideeffect.d:208
                let t: Type = toBasetype(ce.e1!.type!); // sideeffect.d:210
                if (t.ty === Tdelegate) // sideeffect.d:211
                    t = t.isTypeDelegate()!.next!; // sideeffect.d:212 — `(cast(TypeDelegate)t).next`
                // sideeffect.d:214 — the D compiler picked the FuncDeclaration overload for `ce.f`
                // and the Type overload for `ce.e1.type` statically; both call sites are rewritten
                // to their renamed targets (04 §1 Form B invariant). `&&` keeps D's short-circuit,
                // so `callSideEffectLevel*` is not called when `t.ty != Tfunction`.
                //
                // DOMAIN: despite its name, D's `level` here is a **bool**, not an int — in D
                // (unlike C) `LogicalAndExpression` has type `bool`, so `t.ty == Tfunction && <int>`
                // collapses the 0/1/2 level to `<int> != 0`. The `if (level == 0)` on the next D line
                // is therefore `if (!level)`. Keeping a `number` here would read as a faithful port
                // of the level while quietly inventing a third domain, so the bool is explicit.
                const level: boolean =
                    t.ty === Tfunction &&
                    (ce.f !== null ? callSideEffectLevel(ce.f) : callSideEffectLevelType(ce.e1!.type!)) !== 0;
                if (!level) // sideeffect.d:215 — 0 means the function has a side effect
                    return true;
            }
            break;
        }
        case EXP.cast_: { // sideeffect.d:220
            // sideeffect.d:222 — `CastExp ce = cast(CastExp)e`; the case label is the tag proof.
            const ce: CastExp = e.isCastExp()!;
            /* if:
             *  cast(classtype)func()  // because it may throw
             */
            if (ce.to!.ty === Tclass && ce.e1!.op === EXP.call && ce.e1!.type!.ty === Tclass) // sideeffect.d:226
                return true;
            break;
        }
        default:
            break;
    }
    return false; // sideeffect.d:233
}

/**
 * dmd/sideeffect.d:242 — `bool discardValue(Expression e)`.
 *
 * The result of this expression will be discarded. Print error messages if the operation has no
 * side effects (and hence is meaningless).
 *
 * Returns:
 *      true if expression has no side effects
 *
 * Diagnostics: six messages, byte-exact against the D literals (10 §3) —
 * "discarded assignment to indexed array literal" (:258),
 * "assignment to struct rvalue `%s` is discarded" (:271) + its supplemental (:273),
 * "the result of the equality expression `%s` is discarded" (:383) + its supplemental (:389),
 * "`%s` has no effect" (:397).
 */
export function discardValue(e: Expression): boolean {
    if (lambdaHasSideEffect(e)) { // sideeffect.d:244 — check side-effect shallowly
        // check for e.g. `arrayLiteral[index] = expr;`
        if (e.isAssignExp() !== null || e.isBinAssignExp() !== null || e.isPostExp() !== null) { // sideeffect.d:247
            let e1: Expression | null = null; // sideeffect.d:249 — `Expression e1;` (.init = null)
            // sideeffect.d:250 — `if (auto be = e.isBinExp())` includes PostExp; the declaration is
            // hoisted above the `if` (06 §2.6) and the `else if` chain nested so the short-circuit
            // is preserved (06 §2.6's nesting rule).
            const be: BinExp | null = e.isBinExp();
            if (be !== null)
                e1 = be.e1;
            else {
                const ce = e.isPreExp(); // sideeffect.d:252
                if (ce !== null)
                    e1 = ce.e1;
            }

            // sideeffect.d:255 — `if (auto ie = e1 ? e1.isIndexExp() : null)`.
            const ie = e1 !== null ? e1.isIndexExp() : null;
            if (ie !== null) {
                if (ie.e1!.isArrayLiteralExp() !== null) // sideeffect.d:257
                    error(e.loc, ds("discarded assignment to indexed array literal")); // sideeffect.d:258
            }
        }
        // check assignment to struct rvalue
        const ce = e.isCallExp(); // sideeffect.d:262
        if (ce !== null && ce.fromOpAssignment) { // sideeffect.d:263
            const dve = ce.e1!.isDotVarExp(); // sideeffect.d:265
            if (dve !== null) {
                const lhs: Expression = dve.e1!; // sideeffect.d:267
                const ts = lhs.type!.isTypeStruct(); // sideeffect.d:268
                // sideeffect.d:269 — Don't disallow writing to data through a pointer field.
                // `lhs.isLvalue()` is the free function in expressionsem (moved out of expression.d
                // in 2.113); `hasPointerField` is the StructDeclaration bitfield getter.
                if (ts !== null && !isLvalue(lhs) && !ts.sym!.hasPointerField) {
                    // sideeffect.d:271
                    error(lhs.loc, ds("assignment to struct rvalue `%s` is discarded"),
                        lhs.toChars());
                    errorSupplemental(e.loc,
                        ds("if the assignment is needed to modify a global, call `%s` directly or use an lvalue"),
                        dve.var_.toChars()); // sideeffect.d:273-274
                }
            }
        }
        return false; // sideeffect.d:278
    }
    switch (e.op) { // sideeffect.d:280
        case EXP.cast_: { // sideeffect.d:282
            const ce: CastExp = e.isCastExp()!; // sideeffect.d:284 — case label is the tag proof
            if (ce.to!.equals(Type.tvoid)) { // sideeffect.d:285
                /*
                 * Don't complain about an expression with no effect if it was cast to void
                 */
                return false;
            }
            break; // complain
        }
        // Assumption that error => no side effect
        case EXP.error: // sideeffect.d:295
            return true;
        case EXP.variable: { // sideeffect.d:297
            // sideeffect.d:299 — `(cast(VarExp)e).var.isVarDeclaration()`; the case label proves the
            // VarExp downcast.
            const v: VarDeclaration | null = e.isVarExp()!.var_.isVarDeclaration();
            if (v !== null && (v.storage_class & STC.temp) !== 0n) { // sideeffect.d:300
                // https://issues.dlang.org/show_bug.cgi?id=5810
                // Don't complain about an internal generated variable.
                return false;
            }
            break;
        }
        case EXP.call: { // sideeffect.d:308
            // https://issues.dlang.org/show_bug.cgi?id=24359
            const ce: CallExp = e.isCallExp()!; // sideeffect.d:310
            const f = ce.f; // sideeffect.d:311 — `if (const f = ce.f)`, hoisted (06 §2.6)
            if (f !== null) {
                // sideeffect.d:313
                if (f.ident === Id.__equals && ce.arguments_ !== null && ce.arguments_.length === 2) {
                    // sideeffect.d:315 — `(*ce.arguments)[0]` / `[1]`.
                    const a0 = ce.arguments_.opIndex(0);
                    const a1 = ce.arguments_.opIndex(1);
                    return discardValue(new EqualExp(EXP.equal, e.loc, a0, a1));
                }
            }
            return false; // sideeffect.d:318
        }
        case EXP.andAnd: // sideeffect.d:319
        case EXP.orOr: {
            const aae: LogicalExp = e.isLogicalExp()!; // sideeffect.d:322 — case labels are the proof
            return discardValue(aae.e2!); // sideeffect.d:323
        }
        case EXP.question: { // sideeffect.d:325
            const ce: CondExp = e.isCondExp()!; // sideeffect.d:327
            /* https://issues.dlang.org/show_bug.cgi?id=6178
             * https://issues.dlang.org/show_bug.cgi?id=14089
             * Either CondExp::e1 or e2 may have
             * redundant expression to make those types common. For example:
             *
             *  struct S { this(int n); int v; alias v this; }
             *  S[int] aa;
             *  aa[1] = 0;
             *
             * The last assignment statement will be rewitten to:
             *
             *  1 in aa ? aa[1].value = 0 : (aa[1] = 0, aa[1].this(0)).value;
             *
             * The last DotVarExp is necessary to take assigned value.
             *
             *  int value = (aa[1] = 0);    // value = aa[1].value
             *
             * To avoid false error, discardValue() should be called only when
             * the both tops of e1 and e2 have actually no side effects.
             */
            if (!lambdaHasSideEffect(ce.e1!) && !lambdaHasSideEffect(ce.e2!)) { // sideeffect.d:348
                // sideeffect.d:350 — `discardValue(ce.e1) | discardValue(ce.e2)`: D's `|` on bools
                // ALWAYS evaluates both operands, and both emit diagnostics, so the calls are
                // sequenced and only then or-ed (06 §2.x — the `||` spelling would drop the second
                // message once the first returned true).
                const d1 = discardValue(ce.e1!);
                const d2 = discardValue(ce.e2!);
                return d1 || d2;
            }
            return false; // sideeffect.d:353
        }
        case EXP.comma: { // sideeffect.d:355
            const ce: CommaExp = e.isCommaExp()!; // sideeffect.d:357
            // Don't complain about compiler-generated comma expressions
            if (ce.isGenerated) // sideeffect.d:359
                return false;

            // Don't check e1 until we cast(void) the a,b code generation.
            // This is concretely done in expressionSemantic, if a CommaExp has Tvoid as type
            return discardValue(ce.e2!); // sideeffect.d:364
        }
        case EXP.tuple: // sideeffect.d:366
            /* Pass without complaint if any of the tuple elements have side effects.
             * Ideally any tuple elements with no side effects should raise an error,
             * this needs more investigation as to what is the right thing to do.
             */
            if (!hasSideEffect(e)) // sideeffect.d:371
                break;
            return false; // sideeffect.d:373
        case EXP.identity: // sideeffect.d:374 — D: `case EXP.identity, EXP.notIdentity:`
        case EXP.notIdentity:
        case EXP.equal: // sideeffect.d:375 — D: `case EXP.equal, EXP.notEqual:`
        case EXP.notEqual: {
            /*
                `[side effect] == 0`
                Technically has a side effect but is clearly wrong;
            */
            const tmp: BinExp | null = e.isBinExp(); // sideeffect.d:380
            assert(tmp !== null); // sideeffect.d:381

            // sideeffect.d:383
            error(e.loc, ds("the result of the equality expression `%s` is discarded"), toErrMsg(e));
            let seenSideEffect = false; // sideeffect.d:384
            for (const expr of [tmp!.e1!, tmp!.e2!]) { // sideeffect.d:385
                if (hasSideEffect(expr)) { // sideeffect.d:387
                    // sideeffect.d:389
                    errorSupplemental(expr.loc, ds("note that `%s` may have a side effect"), toErrMsg(expr));
                    // sideeffect.d:390 — `seenSideEffect |= true;`. On a bool with the literal `true`
                    // as the right operand this is `= true`; there is no operand to sequence.
                    seenSideEffect = true;
                }
            }
            return !seenSideEffect; // sideeffect.d:393
        }
        default:
            break;
    }
    error(e.loc, ds("`%s` has no effect"), toErrMsg(e)); // sideeffect.d:397
    return true; // sideeffect.d:398
}

/**
 * dmd/sideeffect.d:410 — `VarDeclaration copyToTemp(STC stc, const char[] name, Expression e)`.
 * Build a temporary variable to copy the value of `e` into.
 *
 * Params:
 *  stc = storage classes will be added to the made temporary variable
 *  name = name for temporary variable
 *  e = original expression
 * Returns:
 *  Newly created temporary variable.
 *
 * Precondition (D's own leading assert, :412): `name` starts with `__`.
 */
export function copyToTemp(stc: STC, name: DString, e: Expression): VarDeclaration {
    // sideeffect.d:412 — `assert(name[0] == '_' && name[1] == '_')`. A DString element is a BYTE
    // (08 §11), so the char literals are their ASCII codes: '_' == 0x5f.
    assert(name[0] === 0x5f && name[1] === 0x5f);
    const vd = new VarDeclaration(e.loc, e.type, // sideeffect.d:413
        Identifier.generateId(name), // sideeffect.d:414
        new ExpInitializer(e.loc, e)); // sideeffect.d:415
    // sideeffect.d:416 — temporary is always CTFEable. STC is the bigint flag carrier, so the
    // bitwise-or result is re-branded per 02 §11.5c whitelist item 4 (D's own `cast(STC)` idiom).
    vd.storage_class = (stc | STC.temp | STC.ctfe) as STC;
    return vd; // sideeffect.d:417
}

/**
 * dmd/sideeffect.d:435 — `Expression extractSideEffect(Scope* sc, const char[] name,
 * ref Expression e0, Expression e, bool alwaysCopy = false, STC stc = STC.exptemp)`.
 * Build a temporary variable to extract `e`'s evaluation, if `e` is not trivial.
 *
 * Params:
 *  sc = scope
 *  name = name for temporary variable
 *  e0 = a new side effect part will be appended to it.
 *  e = original expression
 *  alwaysCopy = if true, build new temporary variable even if e is trivial.
 *  stc = storage class flags to add to new temporary variable
 * Returns:
 *  When e is trivial and alwaysCopy == false, e itself is returned.
 *  Otherwise, a new VarExp is returned.
 * Note:
 *  e's lvalue-ness will be handled well by STC.ref_ or STC.rvalue.
 *
 * `ref Expression e0` is a by-reference parameter over a nullable class reference: translated as the
 * one-slot box of 03 §3.3/§7, spelled inline `{ value: Expression | null }` to match the tree's own
 * e0-accumulator precedents (`Expression.extractLast`, expression.ts:304; the call-site cell at
 * expressionsem.ts:2036). `Scope*` is pointer-to-class, i.e. the nullable reference (03 §7.1) — but
 * D dereferences it unconditionally at :447/:454/:457, so the parameter is non-null here, exactly as
 * every other ported `Scope*` parameter in the tree.
 */
export function extractSideEffect(sc: Scope, name: DString,
    e0: { value: Expression | null }, e: Expression, alwaysCopy = false, stc: STC = STC.exptemp): Expression {
    //printf("extractSideEffect(e: %s)\n", e.toChars());

    /* The trouble here is that if CTFE is running, extracting the side effect
     * results in an assignment, and then the interpreter says it cannot evaluate the
     * side effect assignment variable. But we don't have to worry about side
     * effects in function calls anyway, because then they won't CTFE.
     * https://issues.dlang.org/show_bug.cgi?id=17145
     */
    if (!alwaysCopy && // sideeffect.d:446
        (sc.ctfe ? !hasSideEffect(e) : isTrivialExp(e))) // sideeffect.d:447
        return e;

    // sideeffect.d:450 — `stc |= (e.isLvalue() ? STC.ref_ : STC.rvalue)`; `isLvalue` is the
    // expressionsem free function (04 §6). Re-branded per 02 §11.5c item 4.
    stc = (stc | (isLvalue(e) ? STC.ref_ : STC.rvalue)) as STC;
    const vd = copyToTemp(stc, name, e); // sideeffect.d:451

    // sideeffect.d:453 — `Expression.combine(e0, new DeclarationExp(vd.loc, vd).expressionSemantic(sc))`;
    // the UFCS `.expressionSemantic(sc)` is the expressionsem free function (04 §6).
    e0.value = Expression.combine(e0.value, expressionSemantic(new DeclarationExp(vd.loc, vd), sc));

    return expressionSemantic(new VarExp(vd.loc, vd), sc); // sideeffect.d:456
}
