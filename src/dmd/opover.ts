// Ported from dmd/opover.d (module dmd.opover) — 1613 D lines, 27 top-level declarations, 0 structs,
// 0 classes, 0 unittests, 0 mixins, 0 `static if`.
//
// Handles operator overloading: the rewrite pass that turns `-a`, `a[i]`, `a[i] = v`, `a op b`,
// `a op= b`, `a == b`, `a < b`, `cast(T)a` and `foreach (…; aggr)` into the calls to the user's
// `opUnary` / `opIndex` / `opSlice` / `opBinary` / `opOpAssign` / `opEquals` / `opCmp` / `opCast` /
// `opApply` members, with `alias this` forwarding when no overload is found.
//
// IDIOM CHECK (13 §7, mandatory precondition): `grep -c 'class .*Visitor' dmd/opover.d` = 0 — and
// opover.d declares NO aggregates at all. It is neither Idiom A (visitor classes) nor Idiom B
// (nested-function visitor + trailing dispatch switch): it is a flat set of free functions with an
// ordinary nested helper (`suggestOverloading` in `compare_overload`, 04 §5) and one nested delegate
// literal (`findBestOpApplyMatch`'s `overloadApply` callback, 04 §4.1). No dispatch switch to emit.
//
// FREE FUNCTIONS STAY FREE (04 §6). Every D free function here is emitted here as a free function.
// In particular `search_function` (opover.d:1183) is D-homed in THIS module; clone.ts and typesem.ts
// import it from here. Nothing is re-homed OUT of this file.
//
// GOTO (06 §4). One label, `Lfallback` (opover.d:225 / :371 / :960), with three jump sites
// (:210, :354, :939). Shape = SKIP-FLAG: the label is reached by fall-through on most paths and by
// `goto` from inside the preceding `if (search_function(…))` block, which skips the rest of that
// block. Canonical form applied at all three sites: `let gotoLfallback = false;` set at the jump,
// every statement between the jump and the label gated by `!gotoLfallback`, the tail at the label
// left un-gated and shared.
//
// WALLS: NONE. This file has ZERO `TODO-BODY` walls and ZERO `DJS-ESCALATE` markers — every callee
// opover.d reaches is live in the tree and is called for real. It got there in two 14 §8 sweeps:
//   * the fifteen `EXPtoString` calls (hdrgen.d:4602 — opover.d:129, :295, :297, :606, :607, :618,
//     :619, :641, :645, :646, :658, :660, :694, :695, :1156), swept when hdrgen.ts landed;
//   * the twenty-five remaining walls, swept when their owners landed: resolveOpDollar
//     (expressionsem.d:1792 / :1875, ported under the 04 §1B `<name>From<Type>` rename pair
//     `resolveOpDollarFromArrayExp` / `resolveOpDollarFromIntervalExp`), trySemanticAliasThis
//     (expressionsem.d:15605), rewriteIndexAssign (:20105), markArrayExpModifiable (:19798),
//     isRecursiveAliasThis (typesem.d:9214), isIndexableNonAggregate (typesem.d:156), covariant
//     (typesem.d:8044), substWildTo (typesem.d:8926), functionResolve (templatesem.d:5672) and
//     overloadApply (funcsem.d:4084).
// Two deformations the walls had forced are gone with them: five of the six short-circuit
// conditions (`ad.aliasthis && !isRecursiveAliasThis(…)`, opover.d:243/:278/:409/:989 plus :1279's
// bare call) are single `if`s again rather than the nested-`if` split a wall needs — opOverloadCast
// (:452) keeps the split, because the `ref` box has to be built between the two operands, and the
// note there says why the short-circuit must survive; and `trySemantic` / `expandTuples` /
// `binSemanticProp` — once escalated as "ported but not callable" — are plain selective imports,
// expressionsem.ts exporting all three with their D-faithful signatures.
//
// `ref Type att` (isRecursiveAliasThis) is the one adaptation still visible at the call sites: TS
// cannot alias a local or an array element, so `att` travels in the one-slot box (03 §3.3/§7.2)
// where D declares a local, and is boxed-then-copied-back where D passes `aliasThisStop[0]` /
// `aliasThisStop[1]` or the by-value `att` parameter of opOverloadCast.
//
// `Type[2] aliasThisStop` is a static array — a VALUE (02 §7). It is modelled as a fixed-2
// `(Type | null)[]` exactly as expressionsem.ts:167 already does, and copied (`.slice()`) at every
// by-value pass. Its elements are handed to `isRecursiveAliasThis` by `ref`, so the callee writes
// them back — see the box note above.

import { assert, assertUnreachable } from "../assert.js";
import { ds } from "../dstring.js";
import type { DString } from "../dstring.js";

import { MATCH, MODFlags, STC, TY, VarArg } from "./astenums.js";
import type { MOD } from "./astenums.js";
import type { AggregateDeclaration } from "./aggregate.js";
import { ClassKind } from "./aggregate.js";
import type { Expressions, Objects, Parameters } from "./arraytypes.js";
import { ClassDeclaration } from "./dclass.js";
import { MatchAccumulator } from "./declaration.js";
import type { Declaration } from "./declaration.js";
import type { Scope } from "./dscope.js";
import type { StructDeclaration } from "./dstruct.js";
import type { Dsymbol, ScopeDsymbol } from "./dsymbol.js";
import { getType, resolveAliasThis, search, toAlias } from "./dsymbolsem.js";
import { error, errorSupplemental } from "./errors.js";
import {
    ArgumentList,
    ArrayExp, AssignExp, BinAssignExp, BinExp, CallExp, CastExp, CmpExp, DotIdExp,
    DotTemplateInstanceExp, DotVarExp, EqualExp, Expression, ErrorExp, IdentifierExp, IdentityExp,
    IndexExp, IntegerExp, IntervalExp, LogicalExp, NotExp, SliceExp, StringExp, UnaExp, WANTvalue,
    lastComma,
} from "./expression.js";
import {
    expressionSemantic, isLvalue, resolveProperties, trySemantic, binSemanticProp, expandTuples,
    revertIndexAssignToRvalues, trySemanticAliasThis, markArrayExpModifiable, rewriteIndexAssign,
    resolveOpDollarFromArrayExp, resolveOpDollarFromIntervalExp,
} from "./expressionsem.js";
import type { FuncDeclaration } from "./func.js";
import { overloadApply } from "./funcsem.js";
import { EXPtoString } from "./hdrgen.js";
import { Id } from "./id.js";
import type { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { Covariant, MODimplicitConv, Parameter, Type } from "./mtype.js";
import type { TypeAArray, TypeFunction } from "./mtype.js";
import { optimize } from "./optimize.js";
import { functionResolve } from "./templatesem.js";
import { Array as DArray } from "./root/array.js";
import { fTuple } from "./root/string.js";
import type { RootObject } from "./rootobject.js";
import type { ForeachStatement } from "./statement.js";
import { EXP, TOK } from "./tokens.js";
import {
    addStorageClass, typeSemantic, toBasetype, constOf, isScalar, addMod, nextOf, isAggregate,
    isRecursiveAliasThis, isIndexableNonAggregate, covariant, substWildTo,
} from "./typesem.js";
// D keeps `import dmd.clone : needOpEquals;` FUNCTION-LOCAL at opover.d:777. Emitted as a
// module-level selective import (01 §3.2), but placed LAST: clone.ts's own import chain
// (clone -> func -> declaration) is only cycle-safe once those modules are already evaluating,
// and an earlier position here makes clone.ts the entry point of that chain and breaks it.
import { needOpEquals } from "./clone.js";

/***********************************
 * dmd/opover.d:49 — `bool isCommutative(EXP op)`.
 * Determine if operands of binary op can be reversed
 * to fit operator overload.
 */
export function isCommutative(op: EXP): boolean {
    switch (op) {
        case EXP.add:
        case EXP.mul:
        case EXP.and:
        case EXP.or:
        case EXP.xor:
        // EqualExp
        case EXP.equal:
        case EXP.notEqual:
        // CmpExp
        case EXP.lessThan:
        case EXP.lessOrEqual:
        case EXP.greaterThan:
        case EXP.greaterOrEqual:
            return true;
        default:
            break;
    }
    return false;
}

/// dmd/opover.d:74 — `private bool hasOpBinary(EXP op)`.
/// Returns: whether `op` can be overloaded with `opBinary`
/// D module-private (touched by opover.test.ts) — emitted without TS `private`/module-locality per
/// the module-private convention (01-conventions, 10 §1.7).
export function hasOpBinary(op: EXP): boolean {
    switch (op) {
        case EXP.add: return true;
        case EXP.min: return true;
        case EXP.mul: return true;
        case EXP.div: return true;
        case EXP.mod: return true;
        case EXP.and: return true;
        case EXP.or: return true;
        case EXP.xor: return true;
        case EXP.leftShift: return true;
        case EXP.rightShift: return true;
        case EXP.unsignedRightShift: return true;
        case EXP.concatenate: return true;
        case EXP.pow: return true;
        case EXP.in_: return true;
        default: return false;
    }
}

/**
 * dmd/opover.d:103 — `private EXP stripAssignOp(EXP op)`.
 * Remove the = from op=, e.g. += becomes +
 *
 * Params:
 *     op = tag for a binary assign operator
 * Returns: the corresponding binary operator, or `op` if it wasn't an assign operator
 *
 * D module-private (touched by opover.test.ts).
 */
export function stripAssignOp(op: EXP): EXP {
    switch (op) {
        case EXP.addAssign: return EXP.add;
        case EXP.minAssign: return EXP.min;
        case EXP.mulAssign: return EXP.mul;
        case EXP.divAssign: return EXP.div;
        case EXP.modAssign: return EXP.mod;
        case EXP.andAssign: return EXP.and;
        case EXP.orAssign: return EXP.or;
        case EXP.xorAssign: return EXP.xor;
        case EXP.leftShiftAssign: return EXP.leftShift;
        case EXP.rightShiftAssign: return EXP.rightShift;
        case EXP.unsignedRightShiftAssign: return EXP.unsignedRightShift;
        case EXP.concatenateAssign: return EXP.concatenate;
        case EXP.powAssign: return EXP.pow;
        default: return op;
    }
}

/*******************************************
 * dmd/opover.d:127 — `Objects* opToArg(Scope* sc, EXP op)`.
 * Helper function to turn operator into template argument list
 *
 * Cost: builds one `StringExp` and runs `expressionSemantic` on it, per call.
 */
export function opToArg(sc: Scope, op: EXP): Objects {
    // opover.d:129 — `new StringExp(Loc.initial, EXPtoString(stripAssignOp(op)))`. `EXPtoString`
    // (hdrgen.d:4602) is live in hdrgen.ts and returns the shared table slice as a `DString`; the
    // port's StringExp payload is `number[]` (expression.ts:1030), so the slice is spread exactly
    // as every other construction from a `DString` does — arrayop.ts:354 spreads this very
    // function's result, typesem.ts:5386 does the same for `ds(mt.deco)`. The spread copies where
    // D aliases the `immutable` table entry — inert, because a StringExp payload with
    // `ownedByCtfe == OwnedBy.code` is const on D's side too and nothing on this path writes it.
    let e: Expression = new StringExp(Loc.initial, [...EXPtoString(stripAssignOp(op))]);
    e = expressionSemantic(e, sc);
    const tiargs: Objects = DArray.from<RootObject | null>(e);
    return tiargs;
}

/**
 * dmd/opover.d:136 — `Expression checkAliasThisForLhs(AggregateDeclaration ad, Scope* sc, BinExp e,
 * Type[2] aliasThisStop)`. Try alias this on first operand.
 *
 * `ad` is null-tested by the body, so it is `AggregateDeclaration | null` (02 §10.1).
 * `aliasThisStop` is D's by-value `Type[2]`; `aliasThisStop[0]` is passed BY REF to
 * `isRecursiveAliasThis`, which writes the cycle-stop type back into it.
 */
export function checkAliasThisForLhs(ad: AggregateDeclaration | null, sc: Scope, e: BinExp,
                                     aliasThisStop: (Type | null)[]): Expression | null {
    if (ad === null || ad.aliasthis === null)
        return null;

    /* Rewrite (e1 op e2) as:
     *      (e1.aliasthis op e2)
     */
    // opover.d:144 — `isRecursiveAliasThis(aliasThisStop[0], e.e1.type)` (typesem.d:9214).
    // `ref Type att` ALIASES the slot `aliasThisStop[0]`: the callee reads it and writes the first
    // cyclic `alias this` type back into it. A TS call cannot alias an array element, so the slot
    // travels in a one-cell box and is copied back immediately (03 §3.2/§7.2) — the same idiom
    // expressionsem.ts:14577 already uses for this callee and this very pair.
    {
        const attBox: { value: Type | null } = { value: aliasThisStop[0] };
        const recursive = isRecursiveAliasThis(attBox, e.e1!.type!);
        aliasThisStop[0] = attBox.value;
        if (recursive)
            return null;
    }
    //printf("att %s e1 = %s\n", Token.toChars(e.op), e.e1.type.toChars());
    const be = e.copy().isBinExp()!; // D: `cast(BinExp)e.copy()` — tag-proved RTTI downcast (02 §11.5c #3)
    // Resolve 'alias this' but in case of assigment don't resolve properties yet
    // because 'e1 = e2' could mean 'e1(e2)' or 'e1() = e2'
    const findOnly = e.isAssignExp() !== null;
    be.e1 = resolveAliasThis(sc, e.e1!, true, findOnly);
    if (be.e1 === null)
        return null;

    // opover.d:155 — `be.trySemanticAliasThis(sc, aliasThisStop)` (expressionsem.d:15605). The
    // callee's `Type[2] aliasThisStop` is BY VALUE (02 §7), so the pair is cloned at the call.
    return trySemanticAliasThis(be, sc, aliasThisStop.slice());
}

/**
 * dmd/opover.d:159 — `Expression checkAliasThisForRhs(AggregateDeclaration ad, Scope* sc, BinExp e,
 * Type[2] aliasThisStop)`. Try alias this on second operand.
 */
export function checkAliasThisForRhs(ad: AggregateDeclaration | null, sc: Scope, e: BinExp,
                                     aliasThisStop: (Type | null)[]): Expression | null {
    if (ad === null || ad.aliasthis === null)
        return null;
    /* Rewrite (e1 op e2) as:
     *      (e1 op e2.aliasthis)
     */
    // opover.d:166 — `isRecursiveAliasThis(aliasThisStop[1], e.e2.type)` (typesem.d:9214); the
    // aliased slot is `aliasThisStop[1]` here. Box-and-copy-back as in checkAliasThisForLhs.
    {
        const attBox: { value: Type | null } = { value: aliasThisStop[1] };
        const recursive = isRecursiveAliasThis(attBox, e.e2!.type!);
        aliasThisStop[1] = attBox.value;
        if (recursive)
            return null;
    }
    //printf("att %s e2 = %s\n", Token.toChars(e.op), e.e2.type.toChars());
    const be = e.copy().isBinExp()!; // D: `cast(BinExp)e.copy()` — tag-proved RTTI downcast (02 §11.5c #3)
    be.e2 = resolveAliasThis(sc, e.e2!, true);
    if (be.e2 === null)
        return null;

    // opover.d:174 — `be.trySemanticAliasThis(sc, aliasThisStop)` (expressionsem.d:15605); the
    // `Type[2]` parameter is BY VALUE, hence the clone.
    return trySemanticAliasThis(be, sc, aliasThisStop.slice());
}

/// dmd/opover.d:177 — `Expression opOverloadUnary(UnaExp e, Scope* sc)`.
/// Rewrite a unary operator application on an aggregate to the matching `opUnary` /
/// `opIndexUnary` / `opSliceUnary` call, forwarding through `alias this` when nothing matches.
/// Returns: the lowering, `ErrorExp` on a diagnosed error, or `null` when no overload applies
/// (the caller then reports, or — for `++`/`--` — retries as `+=`/`-=`).
export function opOverloadUnary(e: UnaExp, sc: Scope): Expression | null {
    const ae = e.e1!.isArrayExp(); // 06 §2.6 hoist of `if (auto ae = e.e1.isArrayExp())`
    if (ae !== null) {
        ae.e1 = expressionSemantic(ae.e1!, sc);
        ae.e1 = resolveProperties(sc, ae.e1!);
        const ae1old = ae.e1;
        const maybeSlice: boolean = (ae.arguments_!.length === 0
            || ae.arguments_!.length === 1 && ae.arguments_!.opIndex(0)!.isIntervalExp() !== null);
        let ie: IntervalExp | null = null;
        if (maybeSlice && ae.arguments_!.length !== 0) {
            ie = ae.arguments_!.opIndex(0)!.isIntervalExp();
        }
        const att: { value: Type | null } = { value: null }; // first cyclic `alias this` type;
        // D `Type att = null;` is handed to `isRecursiveAliasThis(ref Type att, …)` by `ref`, so
        // it lives in the one-slot box (03 §3.3/§7.2), as expressionsem.ts:20968 already does.
        for (;;) {
            if (ae.e1!.isErrorExp() !== null) {
                return ae.e1;
            }
            const ae1save = ae.e1;
            ae.lengthVar = null;

            const ad = isAggregate(ae.e1!.type!);
            if (ad === null)
                break;

            let gotoLfallback = false; // models dmd/opover.d:210 `goto Lfallback;` (06 §4 SKIP-FLAG)
            // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool) — 02 §11.5
            if (search_function(ad as unknown as ScopeDsymbol, Id.opIndexUnary!) !== null) {
                // D `Expression e0;` — resolveOpDollar's `out` slot, so a one-cell box (03 §3.3);
                // the callee resets it on entry and writes the pending side effects back here.
                const e0: { value: Expression | null } = { value: null };
                // Deal with $
                // opover.d:208 — `resolveOpDollar(sc, ae, e0)` (expressionsem.d:1792, the
                // 3-parameter ArrayExp overload -> `<name>From<Type>` rename, 04 §1B).
                // `out Expression pe0` is the one-slot box `e0`, reset by the callee on entry.
                const ae2 = resolveOpDollarFromArrayExp(sc, ae, e0);
                if (ae2 === null) // op(a[i..j]) might be: a.opSliceUnary!(op)(i, j)
                    gotoLfallback = true; // goto Lfallback (dmd/opover.d:210)
                if (!gotoLfallback) {
                    if (ae2!.isErrorExp() !== null)
                        return ae2;
                    /* Rewrite op(a[arguments]) as:
                     *      a.opIndexUnary!(op)(arguments)
                     */
                    let result: Expression | null = dotTemplateCall(ae.e1!, Id.opIndexUnary!,
                        opToArg(sc, e.op), ...ae.arguments_!.opSlice());
                    if (maybeSlice) {
                        // op(a[]) might be: a.opSliceUnary!(op)()
                        result = trySemantic(result!, sc);
                    } else
                        result = expressionSemantic(result!, sc);

                    if (result !== null)
                        return Expression.combine(e0.value, result);
                }
            }
            // Lfallback: (dmd/opover.d:225) — reached by fall-through AND by the goto above
            // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool) — 02 §11.5
            if (maybeSlice && search_function(ad as unknown as ScopeDsymbol, Id.opSliceUnary!) !== null) {
                // Deal with $
                // D `Expression e0;` — resolveOpDollar's `ref` slot, so a one-cell box (03 §3.3).
                const e0: { value: Expression | null } = { value: null };
                // opover.d:230 — `resolveOpDollar(sc, ae, ie, e0)` (expressionsem.d:1875, the
                // 4-parameter IntervalExp overload, 04 §1B). `ref Expression pe0` is the box `e0`,
                // NOT reset on entry. D dereferences the result immediately; the callee returns
                // `ae`, the combined `ex` or `ErrorExp.get()` on every path, never null.
                const ae2 = resolveOpDollarFromIntervalExp(sc, ae, ie, e0)!;
                if (ae2.isErrorExp() !== null)
                    return ae2;
                /* Rewrite op(a[i..j]) as:
                 *      a.opSliceUnary!(op)(i, j)
                 */
                const result: Expression = ie !== null
                    ? dotTemplateCall(ae.e1!, Id.opSliceUnary!, opToArg(sc, e.op), ie.lwr, ie.upr)
                    : dotTemplateCall(ae.e1!, Id.opSliceUnary!, opToArg(sc, e.op));

                return Expression.combine(e0.value, expressionSemantic(result, sc));
            }
            // Didn't find it. Forward to aliasthis
            // opover.d:243 — `if (ad.aliasthis && !isRecursiveAliasThis(att, ae.e1.type))`.
            if (ad.aliasthis !== null && !isRecursiveAliasThis(att, ae.e1!.type!)) {
                /* Rewrite op(a[arguments]) as:
                 *      op(a.aliasthis[arguments])
                 */
                ae.e1 = resolveAliasThis(sc, ae1save!, true);
                if (ae.e1 !== null)
                    continue;
            }
            break;
        }
        ae.e1 = ae1old; // recovery
        ae.lengthVar = null;
    }
    e.e1 = expressionSemantic(e.e1!, sc);
    e.e1 = resolveProperties(sc, e.e1!);
    const att: { value: Type | null } = { value: null }; // first cyclic `alias this` type;
    // D `Type att = null;` is handed to `isRecursiveAliasThis(ref Type att, …)` by `ref` -> the
    // one-slot box (03 §3.3/§7.2).
    for (;;) {
        if (e.e1!.isErrorExp() !== null) {
            return e.e1;
        }

        const ad = isAggregate(e.e1!.type!);
        if (ad === null)
            break;

        /* Rewrite as:
         *      e1.opUnary!(op)()
         */
        // 06 §2.6 hoist of `if (Dsymbol fd = search_function(ad, Id.opUnary))`.
        // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool) — 02 §11.5
        const fd = search_function(ad as unknown as ScopeDsymbol, Id.opUnary!);
        if (fd !== null)
            return expressionSemantic(dotTemplateCall(e.e1!, Id.opUnary!, opToArg(sc, e.op)), sc);

        // Didn't find it. Forward to aliasthis
        // opover.d:278 — `if (ad.aliasthis && !isRecursiveAliasThis(att, e.e1.type))`.
        if (ad.aliasthis !== null && !isRecursiveAliasThis(att, e.e1!.type!)) {
            /* Rewrite op(e1) as:
             *      op(e1.aliasthis)
             */
            //printf("att una %s e1 = %s\n", EXPtoString(op).ptr, this.e1.type.toChars());
            const e1 = resolveAliasThis(sc, e.e1!, true); // 06 §2.6 hoist
            if (e1 !== null) {
                e.e1 = e1;
                continue;
            }
            break;
        }

        // For ++ and --, rewrites to += and -= are also tried, so don't error yet
        if (e.isPreExp() === null) {
            // opover.d:295 / :297 — `EXPtoString(e.op).ptr` behind a `%s`. `EXPtoString`
            // (hdrgen.d:4602) is live in hdrgen.ts. D's `.ptr` re-reads the table slice as a
            // C string; the port's `%s` is NUL-aware over the same bytes (10 §3.5) and no table
            // entry carries a NUL, so the `DString` is passed through unchanged and the rendered
            // diagnostic is byte-identical.
            error(e.loc, ds("operator `%s` is not defined for `%s`"), EXPtoString(e.op), ad.toChars());
            errorSupplemental(ad.loc,
                ds("perhaps overload the operator with `auto opUnary(string op : \"%s\")() {}`"),
                EXPtoString(e.op));
            return ErrorExp.get();
        }

        break;
    }
    return null;
}

/// dmd/opover.d:306 — `Expression opOverloadArray(ArrayExp ae, Scope* sc)`.
/// Rewrite `a[arguments]` on an aggregate to `a.opIndex(arguments)` / `a.opSlice(i, j)`, or to the
/// concrete `IndexExp`/`SliceExp` for an indexable non-aggregate, forwarding through `alias this`.
export function opOverloadArray(ae: ArrayExp, sc: Scope): Expression | null {
    ae.e1 = expressionSemantic(ae.e1!, sc);
    ae.e1 = resolveProperties(sc, ae.e1!);
    const ae1old = ae.e1;
    const maybeSlice: boolean = (ae.arguments_!.length === 0
        || ae.arguments_!.length === 1 && ae.arguments_!.opIndex(0)!.isIntervalExp() !== null);
    let ie: IntervalExp | null = null;
    if (maybeSlice && ae.arguments_!.length !== 0) {
        ie = ae.arguments_!.opIndex(0)!.isIntervalExp();
    }
    const att: { value: Type | null } = { value: null }; // first cyclic `alias this` type;
    // D `Type att = null;` is handed to `isRecursiveAliasThis(ref Type att, …)` by `ref` -> the
    // one-slot box (03 §3.3/§7.2).
    for (;;) {
        if (ae.e1!.isErrorExp() !== null) {
            return ae.e1;
        }
        // D `Expression e0 = null;` — the `out`/`ref` slot of both resolveOpDollar overloads below,
        // so a one-cell box (03 §3.3); read again after the Lfallback label.
        const e0: { value: Expression | null } = { value: null };
        const ae1save = ae.e1;
        ae.lengthVar = null;
        const t1b = toBasetype(ae.e1!.type!);
        const ad = isAggregate(t1b);
        if (ad === null) {
            // If the non-aggregate expression ae.e1 is indexable or sliceable,
            // convert it to the corresponding concrete expression.
            // opover.d:333 — `if (isIndexableNonAggregate(t1b) || ae.e1.isTypeExp())`
            // (typesem.d:156).
            if (isIndexableNonAggregate(t1b) || ae.e1!.isTypeExp() !== null) {
                // Convert to SliceExp
                if (maybeSlice)
                    return expressionSemantic(SliceExp.fromInterval(ae.loc, ae.e1, ie), sc);

                // Convert to IndexExp
                if (ae.arguments_!.length === 1) {
                    const idxexp = new IndexExp(ae.loc, ae.e1, ae.arguments_!.opIndex(0));
                    idxexp.modifiable = ae.modifiable;
                    return expressionSemantic(idxexp, sc);
                }
            }
            break;
        }
        let gotoLfallback = false; // models dmd/opover.d:354 `goto Lfallback;` (06 §4 SKIP-FLAG)
        // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool) — 02 §11.5
        if (search_function(ad as unknown as ScopeDsymbol, Id.opIndex!) !== null) {
            // Deal with $
            // opover.d:352 — `resolveOpDollar(sc, ae, e0)` (expressionsem.d:1792, the
            // 3-parameter ArrayExp overload -> `<name>From<Type>` rename, 04 §1B).
            // `out Expression pe0` is the one-slot box `e0`, reset by the callee on entry.
            const ae2 = resolveOpDollarFromArrayExp(sc, ae, e0);
            if (ae2 === null) // a[i..j] might be: a.opSlice(i, j)
                gotoLfallback = true; // goto Lfallback (dmd/opover.d:354)
            if (!gotoLfallback) {
                if (ae2!.isErrorExp() !== null)
                    return ae2;

                const ie1 = ae.e1!.isIndexExp();
                if (ie1 !== null)
                    ae.e1 = revertIndexAssignToRvalues(ie1, sc);

                /* Rewrite e1[arguments] as:
                 *      e1.opIndex(arguments)
                 */
                const a: Expressions = ae.arguments_!.copy();
                let result: Expression | null = new DotIdExp(ae.loc, ae.e1, Id.opIndex!);
                result = new CallExp(ae.loc, result, a);
                if (maybeSlice) {
                    // a[] might be: a.opSlice()
                    result = trySemantic(result, sc);
                } else
                    result = expressionSemantic(result, sc);

                if (result !== null)
                    return Expression.combine(e0.value, result);
            }
        }
        // Lfallback: (dmd/opover.d:371) — reached by fall-through AND by the goto above
        if (maybeSlice && ae.e1!.isTypeExp() !== null) {
            let result: Expression = SliceExp.fromInterval(ae.loc, ae.e1, ie);
            result = expressionSemantic(result, sc);
            return Expression.combine(e0.value, result);
        }
        // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool) — 02 §11.5
        if (maybeSlice && search_function(ad as unknown as ScopeDsymbol, Id.opSlice!) !== null) {
            // Deal with $
            // opover.d:385 — `resolveOpDollar(sc, ae, ie, e0)` (expressionsem.d:1875, the
            // 4-parameter IntervalExp overload, 04 §1B). `ref Expression pe0` is the box `e0`,
            // NOT reset on entry. D dereferences the result immediately; the callee returns
            // `ae`, the combined `ex` or `ErrorExp.get()` on every path, never null.
            const ae2 = resolveOpDollarFromIntervalExp(sc, ae, ie, e0)!;

            if (ae2.isErrorExp() !== null) {
                // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool) — 02 §11.5
                if (e0.value === null && search_function(ad as unknown as ScopeDsymbol, Id.dollar!) === null)
                    errorSupplemental(ad.loc, ds("perhaps define `opDollar` for `%s`"), ad.toChars());

                return ae2;
            }
            /* Rewrite a[i..j] as:
             *      a.opSlice(i, j)
             */
            const a: Expressions = new DArray<Expression | null>();
            if (ie !== null) {
                a.push(ie.lwr);
                a.push(ie.upr);
            }
            let result: Expression = new DotIdExp(ae.loc, ae.e1, Id.opSlice!);
            result = new CallExp(ae.loc, result, a);
            result = expressionSemantic(result, sc);
            return Expression.combine(e0.value, result);
        }
        // Didn't find it. Forward to aliasthis
        // opover.d:409 — `if (ad.aliasthis && !isRecursiveAliasThis(att, ae.e1.type))`.
        if (ad.aliasthis !== null && !isRecursiveAliasThis(att, ae.e1!.type!)) {
            //printf("att arr e1 = %s\n", this.e1.type.toChars());
            /* Rewrite op(a[arguments]) as:
             *      op(a.aliasthis[arguments])
             */
            ae.e1 = resolveAliasThis(sc, ae1save!, true);
            if (ae.e1 !== null)
                continue;
        }
        break;
    }
    ae.e1 = ae1old; // recovery
    ae.lengthVar = null;
    return null;
}

/***********************************************
 * dmd/opover.d:430 — `Expression opOverloadCast(CastExp e, Scope* sc, Type att = null)`.
 * This is mostly the same as opOverloadUnary but has
 * a different rewrite.
 */
export function opOverloadCast(e: CastExp, sc: Scope, att: Type | null = null): Expression | null {
    const ad = isAggregate(e.e1!.type!);
    if (ad === null)
        return null;

    // Rewrite as: e1.opCast!(T)()
    // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool) — 02 §11.5
    const fd = search_function(ad as unknown as ScopeDsymbol, Id.opCast!); // 06 §2.6 hoist of `if (Dsymbol fd = …)`
    if (fd !== null) {
        // resolved: version (all) { … } -> the guarded block is always taken (07 §1).
        // Backwards compatibility with D1 if opCast is a function, not a template
        if (fd.isFuncDeclaration() !== null) {
            // Rewrite as:  e1.opCast()
            return build_overload(e.loc, sc, e.e1!, null, fd);
        }
        const tiargs: Objects = DArray.from<RootObject | null>(e.to);
        return expressionSemantic(dotTemplateCall(e.e1!, Id.opCast!, tiargs), sc);
    }
    // Didn't find it. Forward to aliasthis
    // opover.d:452 — `if (ad.aliasthis && !isRecursiveAliasThis(att, e.e1.type))`. Here `att` is
    // D's BY-VALUE parameter (opover.d:430 `Type att = null`), which the `ref` callee writes into
    // this frame's copy; the box carries that write back, and the recursive call below passes the
    // updated value on exactly as D does. The `&&` is SPLIT into nested `if`s (the `if` has no
    // `else`, so the split is exact) because the box has to be built between the two operands —
    // and D's short-circuit is not decoration here: `isRecursiveAliasThis` WRITES `att`, so
    // evaluating it when `ad.aliasthis` is null would diverge.
    if (ad.aliasthis !== null) {
        const attBox: { value: Type | null } = { value: att };
        const recursive = isRecursiveAliasThis(attBox, e.e1!.type!);
        att = attBox.value;
        if (!recursive) {
            // Rewrite `e1.opCast()` as `e1.aliasthis.opCast()`
            const e1 = resolveAliasThis(sc, e.e1!, true); // 06 §2.6 hoist
            if (e1 !== null) {
                const result = e.copy().isCastExp()!; // tag-proved RTTI downcast (02 §11.5c #3)
                result.e1 = e1;
                return opOverloadCast(result, sc, att); // UFCS: `result.opOverloadCast(sc, att)`
            }
        }
    }
    return null;
}

/// dmd/opover.d:467 — `Expression binAliasThis(BinExp e, Scope* sc, Type[2] aliasThisStop)`.
/// When no operator overload functions are found for `e`, recursively try with `alias this`
/// Returns: `null` when still no overload found, otherwise resolved lowering
export function binAliasThis(e: BinExp, sc: Scope, aliasThisStop: (Type | null)[]): Expression | null {
    const ad1 = isAggregate(e.e1!.type!);
    const ad2 = isAggregate(e.e2!.type!);
    let rewrittenLhs: Expression | null = null;
    if (!(e.isAssignExp() !== null && ad2 !== null && ad1 === ad2)) { // https://issues.dlang.org/show_bug.cgi?id=2943
        const result = checkAliasThisForLhs(ad1, sc, e, aliasThisStop.slice()); // 03 §1#2 by-value copy
        if (result !== null) {
            /* https://issues.dlang.org/show_bug.cgi?id=19441
             *
             * alias this may not be used for partial assignment.
             * If a struct has a single member which is aliased this
             * directly or aliased to a ref getter function that returns
             * the mentioned member, then alias this may be
             * used since the object will be fully initialised.
             * If the struct is nested, the context pointer is considered
             * one of the members, hence the `ad1.fields.length == 2 && ad1.vthis`
             * condition.
             */
            const ae = result.isAssignExp();
            if (ae === null)
                return result;     // i.e: Rewrote `e1 = e2` -> `e1(e2)`

            const dve = ae.e1!.isDotVarExp();
            if (dve === null)
                return result;     // i.e: Rewrote `e1 = e2` -> `e1() = e2`

            const ad = dve.var_.isMember2(); // 06 §2.6 hoist of `if (auto ad = dve.var.isMember2())`
            if (ad !== null) {
                // i.e: Rewrote `e1 = e2` -> `e1.some.var = e2`
                // Ensure that `var` is the only field member in `ad`
                if (ad.fields.length === 1 || (ad.fields.length === 2 && ad.vthis !== null)) {
                    if (dve.var_ === ad.aliasthis!.sym)
                        return result;
                }
            }
            rewrittenLhs = ae.e1;
        }
    }
    if (!(e.isAssignExp() !== null && ad1 !== null && ad1 === ad2)) { // https://issues.dlang.org/show_bug.cgi?id=2943
        const result = checkAliasThisForRhs(ad2, sc, e, aliasThisStop.slice()); // 03 §1#2 by-value copy
        if (result !== null)
            return result;
    }
    if (rewrittenLhs !== null) {
        error(e.loc, ds("cannot use `alias this` to partially initialize variable `%s` of type `%s`. Use `%s`"),
            e.e1!.toChars(), ad1!.toChars(), rewrittenLhs.toChars());
        return ErrorExp.get();
    }
    return null;
}

/// dmd/opover.d:522 — `Expression opOverloadAssign(AssignExp e, Scope* sc, Type[2] aliasThisStop)`.
/// Rewrite `e1 = e2` to `e1.opAssign(e2)`, or return `null` to let the caller emit a bitwise blit.
export function opOverloadAssign(e: AssignExp, sc: Scope,
                                 aliasThisStop: (Type | null)[]): Expression | null {
    const ad1 = isAggregate(e.e1!.type!);
    const ad2 = isAggregate(e.e2!.type!);
    if (ad1 === ad2) {
        const sd: StructDeclaration | null = ad1!.isStructDeclaration();
        if (sd !== null &&
            (!sd.hasIdentityAssign ||
                /* Do a blit if we can and the rvalue is something like .init,
                 * where a postblit is not necessary.
                 */
                (sd.hasBlitAssign && !isLvalue(e.e2!)))) {
            /* This is bitwise struct assignment. */
            return null;
        }
    }
    // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool) — 02 §11.5
    const s = search_function(ad1 as unknown as ScopeDsymbol, Id.opAssign!);

    const choseReverse: { value: boolean } = { value: false }; // D `bool choseReverse;` + `out`
    const result = pickBestBinaryOverload(sc, null, s, null, e, choseReverse);
    if (result !== null)
        return result;

    return binAliasThis(e, sc, aliasThisStop.slice()); // 03 §1#2 by-value copy
}

/// dmd/opover.d:549 — `Expression opOverloadBinary(BinExp e, Scope* sc, Type[2] aliasThisStop)`.
/// Rewrite `e1 op e2` to `e1.opBinary!"op"(e2)` or `e2.opBinaryRight!"op"(e1)`, whichever matches
/// better; falls back to `alias this` forwarding.
export function opOverloadBinary(e: BinExp, sc: Scope, aliasThisStop: (Type | null)[]): Expression | null {
    const err = binSemanticProp(e, sc); // 06 §2.6 hoist of `if (Expression err = …)`
    if (err !== null)
        return err;

    const ad1 = isAggregate(e.e1!.type!);
    const ad2 = isAggregate(e.e2!.type!);

    // Try opBinary and opBinaryRight
    // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool) — 02 §11.5
    const s = search_function(ad1 as unknown as ScopeDsymbol, Id.opBinary!);

    if (s !== null && !(s.isTemplateDeclaration() !== null || s.isOverloadSet() !== null)) {
        error(e.e1!.loc, ds("`%s.opBinary` isn't a template"), e.e1!.toChars());
        return ErrorExp.get();
    }

    // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool) — 02 §11.5
    let s_r = search_function(ad2 as unknown as ScopeDsymbol, Id.opBinaryRight!);
    if (s_r !== null && !(s_r.isTemplateDeclaration() !== null || s_r.isOverloadSet() !== null)) {
        error(e.e2!.loc, ds("`%s.opBinaryRight` isn't a template"), e.e2!.toChars());
        return ErrorExp.get();
    }
    if (s_r !== null && s_r === s) // https://issues.dlang.org/show_bug.cgi?id=12778
        s_r = null;

    const choseReverse: { value: boolean } = { value: false }; // D `bool choseReverse;` + `out`
    const result = pickBestBinaryOverload(sc, opToArg(sc, e.op), s, s_r, e, choseReverse);
    if (result !== null)
        return result;

    return binAliasThis(e, sc, aliasThisStop.slice()); // 03 §1#2 by-value copy
}

/**
 * dmd/opover.d:589 — `bool suggestBinaryOverloads(BinExp e, Scope* sc)`.
 * If applicable, print an error relating to implementing / fixing `opBinary` functions.
 * Params:
 *   e = binary operation
 *   sc = scope to try `opBinary!""` semantic in for error messages
 * Returns: `true` when an error related to `opBinary` was printed
 */
export function suggestBinaryOverloads(e: BinExp, sc: Scope): boolean {
    if (!hasOpBinary(e.op)) // UFCS: `e.op.hasOpBinary`
        return false;

    const ad1 = isAggregate(e.e1!.type!);
    const ad2 = isAggregate(e.e2!.type!);

    if (ad1 !== null) {
        // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool) — 02 §11.5
        const s = search_function(ad1 as unknown as ScopeDsymbol, Id.opBinary!); // 06 §2.6 hoist
        if (s !== null) {
            // This expressionSemantic will fail, otherwise operator overloading would have succeeded before
            expressionSemantic(dotTemplateCall(e.e1!, Id.opBinary!, opToArg(sc, e.op), e.e2), sc);
            errorSupplemental(s.loc, ds("`opBinary` defined here"));
            return true;
        }
        // opover.d:606 / :607 — `EXPtoString(e.op).ptr`, live per hdrgen.d:4602 (see opOverloadUnary
        // above for why the `DString` goes straight behind the `%s`).
        error(e.loc, ds("operator `%s` is not defined for type `%s`"),
            EXPtoString(e.op), e.e1!.type!.toChars());
        errorSupplemental(ad1.loc,
            ds("perhaps overload the operator with `auto opBinary(string op : \"%s\")(%s rhs) {}`"),
            EXPtoString(e.op), e.e2!.type!.toChars());
        return true;
    } else if (ad2 !== null) {
        // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool) — 02 §11.5
        // NOTE: D really passes `ad1` here (opover.d:608), inside the `else if (ad2)` arm.
        const s_r = search_function(ad1 as unknown as ScopeDsymbol, Id.opBinaryRight!);
        if (s_r !== null) {
            expressionSemantic(dotTemplateCall(e.e2!, Id.opBinaryRight!, opToArg(sc, e.op), e.e1), sc);
            errorSupplemental(s_r.loc, ds("`opBinaryRight` defined here"));
            return true;
        }
        // opover.d:618 / :619 — `EXPtoString(e.op).ptr`, live per hdrgen.d:4602.
        error(e.loc, ds("operator `%s` is not defined for type `%s`"),
            EXPtoString(e.op), e.e2!.type!.toChars());
        errorSupplemental(ad2.loc,
            ds("perhaps overload the operator with `auto opBinaryRight(string op : \"%s\")(%s lhs) {}`"),
            EXPtoString(e.op), e.e1!.type!.toChars());
        return true;
    }
    return false;
}

/**
 * dmd/opover.d:633 — `bool suggestOpOpAssign(BinAssignExp exp, Scope* sc, Expression parent)`.
 * If applicable, print an error relating to implementing / fixing `opOpAssign` or `opUnary` functions.
 * Params:
 *   exp = binary operation
 *   sc = scope to try `opOpAssign!""` semantic in for error messages
 *   parent = if `exp` was lowered from this `PreExp` or `PostExp`, mention `opUnary` as well
 * Returns: `true` when an error related to `opOpAssign` was printed
 */
export function suggestOpOpAssign(exp: BinAssignExp, sc: Scope, parent: Expression | null): boolean {
    const ad = isAggregate(exp.e1!.type!);
    if (ad === null)
        return false;

    if (parent !== null && (parent.isPreExp() !== null || parent.isPostExp() !== null)) {
        // opover.d:641 / :645 / :646 — `EXPtoString(...).ptr`, live per hdrgen.d:4602. The two
        // arguments of the `errorSupplemental` keep D's own order and each strips the assign form
        // first, so the `%s` pair still renders `opUnary` op then `opOpAssign` op.
        error(exp.loc, ds("operator `%s` not supported for `%s` of type `%s`"),
            EXPtoString(parent.op), exp.e1!.toChars(), ad.toChars());
        errorSupplemental(ad.loc,
            ds("perhaps implement `auto opUnary(string op : \"%s\")() {}`"
                + " or `auto opOpAssign(string op : \"%s\")(int) {}`"),
            EXPtoString(stripAssignOp(parent.op)),
            EXPtoString(stripAssignOp(exp.op)));
        return true;
    }

    // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool) — 02 §11.5
    const s = search_function(ad as unknown as ScopeDsymbol, Id.opOpAssign!); // 06 §2.6 hoist of `if (const s = …)`
    if (s !== null) {
        // This expressionSemantic will fail, otherwise operator overloading would have succeeded before
        expressionSemantic(dotTemplateCall(exp.e1!, Id.opOpAssign!, opToArg(sc, exp.op), exp.e2), sc);
    } else {
        // opover.d:658 / :660 — `EXPtoString(exp.op).ptr` and the stripped form, live per
        // hdrgen.d:4602.
        error(exp.loc, ds("operator `%s` not supported for `%s` of type `%s`"),
            EXPtoString(exp.op), exp.e1!.toChars(), ad.toChars());
        errorSupplemental(ad.loc, ds("perhaps implement `auto opOpAssign(string op : \"%s\")(%s) {}`"),
            EXPtoString(stripAssignOp(exp.op)), exp.e2!.type!.toChars());
    }
    return true;
}

/// dmd/opover.d:666 — `private Expression dotTemplateCall(Expression e, Identifier id,
/// Objects* tiargs, Expression[] args...)`.
/// Helper to construct e.id!tiargs(args), e.g. `lhs.opBinary!"+"(rhs)`.
/// `Expression[] args...` is a typesafe variadic (04 §3.2) → `...args`, spread at call sites.
function dotTemplateCall(e: Expression, id: Identifier, tiargs: Objects | null,
                         ...args: (Expression | null)[]): Expression {
    const ti = DotTemplateInstanceExp.fromName(e.loc, e, id, tiargs);
    const expressions: Expressions = new DArray<Expression | null>();
    expressions.pushSlice(args);
    return new CallExp(e.loc, ti, expressions);
}

/// dmd/opover.d:674 — `Expression opOverloadEqual(EqualExp e, Scope* sc, Type[2] aliasThisStop)`.
/// Rewrite `e1 == e2` / `e1 != e2` for classes (`object.opEquals`), pointers (`is`), structs
/// (`opEquals`, memberwise `.tupleof`, or bitwise identity) and tuples (element-wise `&&`/`||`).
export function opOverloadEqual(e: EqualExp, sc: Scope, aliasThisStop: (Type | null)[]): Expression | null {
    const t1 = toBasetype(e.e1!.type!);
    const t2 = toBasetype(e.e2!.type!);

    /* Array equality is handled by expressionSemantic() potentially
     * lowering to object.__equals(), which takes care of overloaded
     * operators for the element types.
     */
    if (t1.isStaticOrDynamicArray() && t2.isStaticOrDynamicArray()) {
        return null;
    }

    /* Check for class equality with null literal or typeof(null).
     */
    if (t1.isTypeClass() !== null && e.e2!.isNullExp() !== null ||
        t2.isTypeClass() !== null && e.e1!.isNullExp() !== null) {
        // opover.d:694 / :695 — `EXPtoString(...).ptr`, live per hdrgen.d:4602. The first `%s` is
        // the SUGGESTED operator (`is` / `!is`, selected from `e.op`), the second the one written.
        error(e.loc, ds("use `%s` instead of `%s` when comparing with `null`"),
            EXPtoString(e.op === EXP.equal ? EXP.identity : EXP.notIdentity),
            EXPtoString(e.op));
        return ErrorExp.get();
    }
    if (t1.isTypeClass() !== null && t2.isTypeNull() !== null ||
        t1.isTypeNull() !== null && t2.isTypeClass() !== null) {
        // Comparing a class with typeof(null) should not call opEquals
        return null;
    }

    /* Check for class equality.
     */
    if (t1.isTypeClass() !== null && t2.isTypeClass() !== null) {
        const cd1 = t1.isClassHandle();
        const cd2 = t2.isClassHandle();
        if (!(cd1!.classKind === ClassKind.cpp || cd2!.classKind === ClassKind.cpp)) {
            /* Rewrite as:
             *      .object.opEquals(e1, e2)
             */
            if (ClassDeclaration.object === null) {
                error(e.loc, ds("cannot compare classes for equality because `object.Object` was not declared"));
                return null;
            }

            let e1x = e.e1;
            let e2x = e.e2;

            /* The explicit cast is necessary for interfaces
             * https://issues.dlang.org/show_bug.cgi?id=4088
             */
            // D: `dmd.dsymbolsem.getType(ClassDeclaration.object)` — explicitly module-qualified
            // there to pick the dsymbolsem family over dtemplate's `getType(RootObject)` (04 §6.1).
            // upcast cascade: ClassDeclaration widens to Dsymbol; AggregateDeclaration.deferred
            // (Dsymbol) shadows Dsymbol.deferred (bool) — 02 §11.5.
            const to = getType(ClassDeclaration.object as unknown as Dsymbol);
            if (cd1!.isInterfaceDeclaration() !== null)
                e1x = new CastExp(e.loc, e.e1, t1.isMutable() ? to : constOf(to!));
            if (cd2!.isInterfaceDeclaration() !== null)
                e2x = new CastExp(e.loc, e.e2, t2.isMutable() ? to : constOf(to!));

            let result: Expression = new IdentifierExp(e.loc, Id.empty!);
            result = new DotIdExp(e.loc, result, Id.object!);
            result = new DotIdExp(e.loc, result, Id.opEquals!);
            result = CallExp.fromArgs(e.loc, result, e1x, e2x);
            if (e.op === EXP.notEqual)
                result = new NotExp(e.loc, result);
            result = expressionSemantic(result, sc);
            return result;
        }
    }

    const cmpOp: { value: EXP } = { value: EXP.reserved }; // D `EXP cmpOp;` — `ref` param slot
    {
        const result0 = compare_overload(e, sc, Id.opEquals!, cmpOp, aliasThisStop.slice());
        if (result0 !== null) {
            let result = result0;
            if (lastComma(result).isCallExp() !== null && e.op === EXP.notEqual) {
                result = new NotExp(result.loc, result);
                result = expressionSemantic(result, sc);
            }
            return result;
        }
    }

    /* Check for pointer equality.
     */
    if (t1.isTypePointer() !== null || t2.isTypePointer() !== null) {
        /* Rewrite:
         *      ptr1 == ptr2
         * as:
         *      ptr1 is ptr2
         *
         * This is just a rewriting for deterministic AST representation
         * as the backend input.
         */
        const op2 = e.op === EXP.equal ? EXP.identity : EXP.notIdentity;
        const r: Expression = new IdentityExp(op2, e.loc, e.e1, e.e2);
        return expressionSemantic(r, sc);
    }

    /* Check for struct equality without opEquals.
     */
    if (t1.isTypeStruct() !== null && t2.isTypeStruct() !== null) {
        const sd = t1.isTypeStruct()!.sym;
        if (sd !== t2.isTypeStruct()!.sym)
            return null;

        // D: function-local selective `import dmd.clone : needOpEquals;` (opover.d:777) — the
        // import is module-level here (01 §3.2); `needOpEquals` is D-homed in clone.d and ported
        // there (clone.ts:441), so this is an ordinary call, not a wall.
        if (!sc.previews.fieldwise && !needOpEquals(sd!)) {
            // Use bitwise equality.
            const op2 = e.op === EXP.equal ? EXP.identity : EXP.notIdentity;
            const r: Expression = new IdentityExp(op2, e.loc, e.e1, e.e2);
            return expressionSemantic(r, sc);
        }

        /* Do memberwise equality.
         * https://dlang.org/spec/expression.html#equality_expressions
         * Rewrite:
         *      e1 == e2
         * as:
         *      e1.tupleof == e2.tupleof
         *
         * If sd is a nested struct, and if it's nested in a class, it will
         * also compare the parent class's equality. Otherwise, compares
         * the identity of parent context through void*.
         */
        e = e.copy().isEqualExp()!; // tag-proved RTTI downcast (02 §11.5c #3)
        e.e1 = new DotIdExp(e.loc, e.e1, Id._tupleof!);
        e.e2 = new DotIdExp(e.loc, e.e2, Id._tupleof!);

        const sc2 = sc.push();
        sc2.noAccessCheck = true;
        const r = expressionSemantic(e, sc2);
        sc2.pop();
        return r;
    }

    /* Check for tuple equality.
     */
    const tup1 = e.e1!.isTupleExp();
    const tup2 = e.e2!.isTupleExp();
    if (tup1 !== null && tup2 !== null) {
        const dim = tup1.exps!.length;
        if (dim !== tup2.exps!.length) {
            error(e.loc, ds("mismatched sequence lengths, `%d` and `%d`"),
                dim, tup2.exps!.length); // D `cast(int)dim` — index domain, `number` (09 §1.1)
            return ErrorExp.get();
        }

        let result: Expression | null = null;
        if (dim === 0) {
            // zero-length tuple comparison should always return true or false.
            result = IntegerExp.createBool(e.op === EXP.equal);
        } else {
            for (let i = 0; i < dim; i++) {
                const ex1 = tup1.exps!.opIndex(i);
                const ex2 = tup2.exps!.opIndex(i);
                const eeq = new EqualExp(e.op, e.loc, ex1, ex2);

                if (result === null)
                    result = eeq;
                else if (e.op === EXP.equal)
                    result = new LogicalExp(e.loc, EXP.andAnd, result, eeq);
                else
                    result = new LogicalExp(e.loc, EXP.orOr, result, eeq);
            }
            assert(result !== null);
        }
        result = Expression.combine(tup1.e0, tup2.e0, result);
        result = expressionSemantic(result!, sc);

        return result;
    }
    return null;
}

/// dmd/opover.d:857 — `Expression opOverloadCmp(CmpExp exp, Scope* sc, Type[2] aliasThisStop)`.
/// Rewrite `e1 < e2` (and friends) to `e1.opCmp(e2) < 0`, or to `object.__cmp(e1, e2) < 0` for
/// class operands. `cmpOp` carries the (possibly reversed) relation when `opCmp` matched on `e2`.
export function opOverloadCmp(exp: CmpExp, sc: Scope, aliasThisStop: (Type | null)[]): Expression | null {
    //printf("CmpExp:: () (%s)\n", e.toChars());
    const cmpOp: { value: EXP } = { value: exp.op }; // D `EXP cmpOp = exp.op;` — `ref` param slot
    const e = compare_overload(exp, sc, Id.opCmp!, cmpOp, aliasThisStop.slice());
    if (e === null)
        return null;

    if (!isScalar(e.type!) && e.type!.equals(exp.e1!.type)) {
        error(e.loc, ds("recursive `opCmp` expansion"));
        return ErrorExp.get();
    }
    if (e.isCallExp() === null)
        return e;

    const t1 = toBasetype(exp.e1!.type!);
    const t2 = toBasetype(exp.e2!.type!);
    if (t1.isTypeClass() === null || t2.isTypeClass() === null) {
        return expressionSemantic(new CmpExp(cmpOp.value, exp.loc, e, IntegerExp.literal(0)), sc);
    }

    // Lower to object.__cmp(e1, e2)
    let cl: Expression = new IdentifierExp(exp.loc, Id.empty!);
    cl = new DotIdExp(exp.loc, cl, Id.object!);
    cl = new DotIdExp(exp.loc, cl, Id.__cmp!);
    cl = expressionSemantic(cl, sc);

    const arguments_: Expressions = new DArray<Expression | null>();
    // Check if op_overload found a better match by calling e2.opCmp(e1)
    // If the operands were swapped, then the result must be reversed
    // e1.opCmp(e2) == -e2.opCmp(e1)
    // cmpop takes care of this
    if (exp.op === cmpOp.value) {
        arguments_.push(exp.e1);
        arguments_.push(exp.e2);
    } else {
        // Use better match found by op_overload
        arguments_.push(exp.e2);
        arguments_.push(exp.e1);
    }

    cl = new CallExp(e.loc, cl, arguments_);
    cl = new CmpExp(cmpOp.value, exp.loc, cl, IntegerExp.fromValue(0n));
    return expressionSemantic(cl, sc);
}

/*********************************
 * dmd/opover.d:911 — `Expression opOverloadBinaryAssign(BinAssignExp e, Scope* sc,
 * Type[2] aliasThisStop)`.
 * Operator overloading for op=
 */
export function opOverloadBinaryAssign(e: BinAssignExp, sc: Scope,
                                       aliasThisStop: (Type | null)[]): Expression | null {
    const ae = e.e1!.isArrayExp(); // 06 §2.6 hoist of `if (auto ae = e.e1.isArrayExp())`
    if (ae !== null) {
        // opover.d:915 — `markArrayExpModifiable(ae)` (expressionsem.d:19798).
        markArrayExpModifiable(ae);

        ae.e1 = expressionSemantic(ae.e1!, sc);
        ae.e1 = resolveProperties(sc, ae.e1!);
        const ae1old = ae.e1;
        const maybeSlice: boolean = (ae.arguments_!.length === 0
            || ae.arguments_!.length === 1 && ae.arguments_!.opIndex(0)!.isIntervalExp() !== null);
        let ie: IntervalExp | null = null;
        if (maybeSlice && ae.arguments_!.length !== 0) {
            ie = ae.arguments_!.opIndex(0)!.isIntervalExp();
        }
        const att: { value: Type | null } = { value: null }; // first cyclic `alias this` type;
        // D `Type att = null;` is handed to `isRecursiveAliasThis(ref Type att, …)` by `ref`, so
        // it lives in the one-slot box (03 §3.3/§7.2), as expressionsem.ts:20968 already does.
        for (;;) {
            if (ae.e1!.isErrorExp() !== null)
                return ae.e1;

            // D `Expression e0 = null;` — the `out`/`ref` slot of both resolveOpDollar overloads
            // below, so a one-cell box (03 §3.3); read again after the Lfallback label.
            const e0: { value: Expression | null } = { value: null };
            const ae1save = ae.e1;
            ae.lengthVar = null;
            const ad = isAggregate(ae.e1!.type!);
            if (ad === null)
                break;
            let gotoLfallback = false; // models dmd/opover.d:939 `goto Lfallback;` (06 §4 SKIP-FLAG)
            // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool) — 02 §11.5
            if (search_function(ad as unknown as ScopeDsymbol, Id.opIndexOpAssign!) !== null) {
                // Deal with $
                // opover.d:941 — `resolveOpDollar(sc, ae, e0)` (expressionsem.d:1792, the
                // 3-parameter ArrayExp overload -> `<name>From<Type>` rename, 04 §1B).
                // `out Expression pe0` is the one-slot box `e0`, reset by the callee on entry.
                const ae2 = resolveOpDollarFromArrayExp(sc, ae, e0);
                if (ae2 === null) // (a[i..j] op= e2) might be: a.opSliceOpAssign!(op)(e2, i, j)
                    gotoLfallback = true; // goto Lfallback (dmd/opover.d:939)
                if (!gotoLfallback) {
                    if (ae2!.isErrorExp() !== null)
                        return ae2;
                    e.e2 = expressionSemantic(e.e2!, sc);
                    if (e.e2.isErrorExp() !== null)
                        return e.e2;

                    const ie1 = ae.e1!.isIndexExp();
                    if (ie1 !== null)
                        ae.e1 = revertIndexAssignToRvalues(ie1, sc);

                    /* Rewrite a[arguments] op= e2 as:
                     *      a.opIndexOpAssign!(op)(e2, arguments)
                     */
                    const a: Expressions = ae.arguments_!.copy();
                    a.insert(0, e.e2);
                    let result: Expression | null = dotTemplateCall(ae.e1!, Id.opIndexOpAssign!,
                        opToArg(sc, e.op), ...a.opSlice());
                    if (maybeSlice) {
                        // (a[] op= e2) might be: a.opSliceOpAssign!(op)(e2)
                        result = trySemantic(result, sc);
                    } else
                        result = expressionSemantic(result, sc);

                    if (result !== null)
                        return Expression.combine(e0.value, result);
                }
            }
            // Lfallback: (dmd/opover.d:960) — reached by fall-through AND by the goto above
            // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool) — 02 §11.5
            if (maybeSlice && search_function(ad as unknown as ScopeDsymbol, Id.opSliceOpAssign!) !== null) {
                // Deal with $
                // opover.d:971 — `resolveOpDollar(sc, ae, ie, e0)` (expressionsem.d:1875, the
                // 4-parameter IntervalExp overload, 04 §1B). `ref Expression pe0` is the box `e0`,
                // NOT reset on entry. D dereferences the result immediately; the callee returns
                // `ae`, the combined `ex` or `ErrorExp.get()` on every path, never null.
                const ae2 = resolveOpDollarFromIntervalExp(sc, ae, ie, e0)!;
                if (ae2.isErrorExp() !== null)
                    return ae2;

                e.e2 = expressionSemantic(e.e2!, sc);
                if (e.e2.isErrorExp() !== null)
                    return e.e2;

                /* Rewrite (a[i..j] op= e2) as:
                 *      a.opSliceOpAssign!(op)(e2, i, j)
                 */
                const result: Expression = ie !== null
                    ? dotTemplateCall(ae.e1!, Id.opSliceOpAssign!, opToArg(sc, e.op), e.e2, ie.lwr, ie.upr)
                    : dotTemplateCall(ae.e1!, Id.opSliceOpAssign!, opToArg(sc, e.op), e.e2);

                return Expression.combine(e0.value, expressionSemantic(result, sc));
            }
            // Didn't find it. Forward to aliasthis
            // opover.d:989 — `if (ad.aliasthis && !isRecursiveAliasThis(att, ae.e1.type))`.
            if (ad.aliasthis !== null && !isRecursiveAliasThis(att, ae.e1!.type!)) {
                /* Rewrite (a[arguments] op= e2) as:
                 *      a.aliasthis[arguments] op= e2
                 */
                ae.e1 = resolveAliasThis(sc, ae1save!, true);
                if (ae.e1 !== null)
                    continue;
            }
            break;
        }
        ae.e1 = ae1old; // recovery
        ae.lengthVar = null;
    }

    {
        const result = binSemanticProp(e, sc); // UFCS: `e.binSemanticProp(sc)`
        if (result !== null)
            return result;
    }

    // opover.d:1007 — `if (auto result = rewriteIndexAssign(e, sc, aliasThisStop))`
    // (expressionsem.d:20105). The callee's `Type[2] aliasThisStop` is BY VALUE (02 §7).
    {
        const result = rewriteIndexAssign(e, sc, aliasThisStop.slice());
        if (result !== null)
            return result;
    }

    // Don't attempt 'alias this' if an error occurred
    if (e.e1!.type!.isTypeError() !== null || e.e2!.type!.isTypeError() !== null)
        return ErrorExp.get();

    const ad1 = isAggregate(e.e1!.type!);
    // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool) — 02 §11.5
    const s = search_function(ad1 as unknown as ScopeDsymbol, Id.opOpAssign!);
    if (s !== null && !(s.isTemplateDeclaration() !== null || s.isOverloadSet() !== null)) {
        error(e.loc, ds("`%s.opOpAssign` isn't a template"), e.e1!.toChars());
        return ErrorExp.get();
    }

    const choseReverse: { value: boolean } = { value: false }; // D `bool choseReverse;` + `out`
    const res = pickBestBinaryOverload(sc, opToArg(sc, e.op), s, null, e, choseReverse);
    if (res !== null)
        return res;

    const result = checkAliasThisForLhs(ad1, sc, e, aliasThisStop.slice()); // 03 §1#2 by-value copy
    if (result !== null || s === null) // no point in trying Rhs alias-this if there's no overload of any kind in lhs
        return result;

    return checkAliasThisForRhs(isAggregate(e.e2!.type!), sc, e, aliasThisStop.slice());
}

/**
dmd/opover.d:1047 — `private Expression pickBestBinaryOverload(Scope* sc, Objects* tiargs,
Dsymbol s, Dsymbol s_r, BinExp e, out bool choseReverse)`.

Given symbols `s` and `s_r`, try to instantiate `e.e1.s!tiargs(e.e2)` and `e.e2.s_r!tiargs(e.e1)`,
and return the one with the best match level.

Params:
    sc = scope
    tiargs = (optional) template arguments to instantiate symbols with
    s = (optional) symbol of straightforward template (e.g. opBinary)
    s_r = (optional) symbol of reversed template (e.g. opBinaryRight)
    e = binary expression being overloaded, supplying arguments to the function calls
    choseReverse = set to true when `s_r` was chosen instead of `s`
Returns:
    Resulting operator overload function call, or `null` if neither symbol worked
*/
function pickBestBinaryOverload(sc: Scope, tiargs: Objects | null, s: Dsymbol | null,
                                s_r: Dsymbol | null, e: BinExp,
                                choseReverse: { value: boolean }): Expression | null {
    choseReverse.value = false; // D resets the `out` param to `bool.init` on entry (03 §3.3)
    if (s === null && s_r === null)
        return null;

    const args1: Expressions = new DArray<Expression | null>(1);
    args1.opIndexAssign(e.e1, 0);
    expandTuples(args1);
    const args2: Expressions = new DArray<Expression | null>(1);
    args2.opIndexAssign(e.e2, 0);
    expandTuples(args2);
    const m = new MatchAccumulator(); // D `MatchAccumulator m;` — struct default init (09 §1.0)

    if (s !== null) {
        // opover.d:1062 — `functionResolve(m, s, e.loc, sc, tiargs, e.e1.type,
        // ArgumentList(args2), null)` (templatesem.d:5672). `ref MatchAccumulator m` is mutated
        // in place by the callee (03 §3.2 — the object IS the alias, no copy).
        functionResolve(m, s, e.loc, sc, tiargs, e.e1!.type, new ArgumentList(args2), null);
        if (m.lastf !== null && (m.lastf.errors || m.lastf.hasSemantic3Errors))
            return ErrorExp.get();
    }
    const lastf = m.lastf;
    const count = m.count;
    if (s_r !== null) {
        // opover.d:1070 — the REVERSED call: same `m`, but `s_r` / `e.e2.type` / `args1`.
        functionResolve(m, s_r, e.loc, sc, tiargs, e.e2!.type, new ArgumentList(args1), null);
        if (m.lastf !== null && (m.lastf.errors || m.lastf.hasSemantic3Errors))
            return ErrorExp.get();
    }
    if (m.count > 1) {
        /* The following if says "not ambiguous" if there's one match
         * from s and one from s_r, in which case we pick s.
         * This doesn't follow the spec, but is a workaround for the case
         * where opEquals was generated from templates and we cannot figure
         * out if both s and s_r came from the same declaration or not.
         * The test case is:
         *   import std.typecons;
         *   void main() {
         *    assert(tuple("has a", 2u) == tuple("has a", 1));
         *   }
         */
        if (!(m.lastf === lastf && m.count === 2 && count === 1)) {
            // Error, ambiguous
            error(e.loc, ds("overloads `%s` and `%s` both match argument list for `%s`"),
                m.lastf!.type!.toChars(), m.nextf!.type!.toChars(), m.lastf!.toChars());
        }
    } else if (m.last === MATCH.nomatch) {
        if (tiargs !== null)
            return null;
        m.lastf = null;
    }

    if (lastf !== null && m.lastf === lastf || s_r === null && m.last === MATCH.nomatch) {
        choseReverse.value = false;
        // Rewrite (e1 op e2) as e1.opfunc(e2)
        return build_overload(e.loc, sc, e.e1!, e.e2, m.lastf !== null ? m.lastf : s!);
    } else {
        choseReverse.value = true;
        // Rewrite (e1 op e2) as e2.opfunc_r(e1)
        return build_overload(e.loc, sc, e.e2!, e.e1, m.lastf !== null ? m.lastf : s_r!);
    }
}

/******************************************
 * dmd/opover.d:1117 — `private Expression compare_overload(BinExp e, Scope* sc, Identifier id,
 * ref EXP cmpOp, Type[2] aliasThisStop)`.
 * Common code for overloading of EqualExp and CmpExp.
 * `ref EXP cmpOp` is a rebinding write-back, so it is the `{ value }` box (03 §3.3/§7.2).
 */
function compare_overload(e: BinExp, sc: Scope, id: Identifier, cmpOp: { value: EXP },
                          aliasThisStop: (Type | null)[]): Expression | null {
    //printf("BinExp::compare_overload(id = %s) %s\n", id.toChars(), e.toChars());
    const ad1 = isAggregate(e.e1!.type!);
    const ad2 = isAggregate(e.e2!.type!);
    // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool) — 02 §11.5
    const s = search_function(ad1 as unknown as ScopeDsymbol, id);
    // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool) — 02 §11.5
    let s_r = search_function(ad2 as unknown as ScopeDsymbol, id);

    if (s === s_r)
        s_r = null;

    const choseReverse: { value: boolean } = { value: false }; // D `bool choseReverse;` + `out`
    const res = pickBestBinaryOverload(sc, null, s, s_r, e, choseReverse);
    if (res !== null) {
        if (choseReverse.value)
            cmpOp.value = reverseRelation(e.op);
        return res;
    }

    /*
     * https://issues.dlang.org/show_bug.cgi?id=16657
     * at this point, no matching opEquals was found for structs,
     * so we should not follow the alias this comparison code.
     */
    if (e.isEqualExp() !== null && ad1 === ad2)
        return null;
    let result = checkAliasThisForLhs(ad1, sc, e, aliasThisStop.slice()); // 03 §1#2 by-value copy
    if (result !== null)
        return result;

    result = checkAliasThisForRhs(isAggregate(e.e2!.type!), sc, e, aliasThisStop.slice());
    if (result !== null)
        return result;

    if (s !== null || s_r !== null)
        return null;

    // D nested function (04 §5) — inner `const` arrow, declared before its two uses below.
    const suggestOverloading = (other: Expression, ad: AggregateDeclaration): Expression => {
        // opover.d:1156 — `EXPtoString(e.op).ptr`, live per hdrgen.d:4602.
        error(e.loc, ds("no operator `%s` for type `%s`"), EXPtoString(e.op), ad.toChars());
        const op: DString = e.isEqualExp() !== null ? ds("bool") : ds("int");
        errorSupplemental(ad.loc, ds("perhaps overload it with `%.*s %s(%s other) const {}`"),
            ...fTuple(op), id.toChars(), other.type!.toChars());
        return ErrorExp.get();
    };

    // Classes have opCmp and opEquals defined in `Object` to fall back on already
    if (ad1 !== null && ad1.isStructDeclaration() !== null)
        return suggestOverloading(e.e2!, ad1);
    if (ad2 !== null && ad2.isStructDeclaration() !== null)
        return suggestOverloading(e.e1!, ad2);

    return null;
}

/***********************************
 * dmd/opover.d:1174 — `Expression build_overload(Loc loc, Scope* sc, Expression ethis,
 * Expression earg, Dsymbol d)`.
 * Utility to build a function call out of this reference and argument.
 * `earg` is null at the `opCast` call site (opover.d:441), so it is `Expression | null`.
 */
export function build_overload(loc: Loc, sc: Scope, ethis: Expression, earg: Expression | null,
                               d: Dsymbol | null): Expression {
    assert(d !== null);
    let e: Expression;
    const decl: Declaration | null = d.isDeclaration(); // 06 §2.6 hoist
    if (decl !== null)
        e = new DotVarExp(loc, ethis, decl, false);
    else
        e = new DotIdExp(loc, ethis, d.ident);
    e = CallExp.fromArg(loc, e, earg);
    e = expressionSemantic(e, sc);
    return e;
}

/***************************************
 * dmd/opover.d:1190 — `Dsymbol search_function(ScopeDsymbol ad, Identifier funcid)`.
 * Search for function funcid in aggregate ad.
 *
 * D-HOMED HERE. clone.ts and typesem.ts import it from here; this file is the
 * pick-up.
 *
 * Preconditions: none — a null `ad` is the documented POD/no-aggregate case and returns null.
 * Returns: the member resolved to a function / template / overload set, else null.
 */
export function search_function(ad: ScopeDsymbol | null, funcid: Identifier): Dsymbol | null {
    if (ad === null)
        return null;
    const s = search(ad, Loc.initial, funcid); // UFCS: `ad.search(Loc.initial, funcid)`
    if (s !== null) {
        //printf("search_function: s = '%s'\n", s.kind());
        const s2 = toAlias(s); // UFCS: `s.toAlias()`
        //printf("search_function: s2 = '%s'\n", s2.kind());
        const fd = s2.isFuncDeclaration();
        if (fd !== null && fd.type!.isTypeFunction() !== null)
            return fd;
        const td = s2.isTemplateDeclaration(); // 06 §2.6 hoist
        if (td !== null)
            return td;
        const os = s2.isOverloadSet(); // 06 §2.6 hoist
        if (os !== null)
            return os;
    }
    return null;
}

/**************************************
 * dmd/opover.d:1222 — `bool inferForeachAggregate(Scope* sc, bool isForeach, ref Expression feaggr,
 * out Dsymbol sapply)`.
 * Figure out what is being foreach'd over by looking at the ForeachAggregate.
 * Params:
 *      sc = context
 *      isForeach = true for foreach, false for foreach_reverse
 *      feaggr = ForeachAggregate — a `ref` parameter that is REBOUND by the body, so it is the
 *               `{ value }` box (03 §3.2/§7.2), not a bare reference
 *      sapply = set to function opApply/opApplyReverse, or delegate, or null.
 *               Overload resolution is not done. (`out` → box, reset on entry, 03 §3.3)
 * Returns:
 *      true if successfully figured it out; feaggr updated with semantic analysis.
 *      false for failed, which is an error.
 */
export function inferForeachAggregate(sc: Scope, isForeach: boolean, feaggr: { value: Expression },
                                      sapply: { value: Dsymbol | null }): boolean {
    sapply.value = null; // D resets the `out` param to its `.init` on entry (03 §3.3)
    //printf("inferForeachAggregate(%s)\n", feaggr.toChars());
    let sliced = false;
    // D `Type att = null;` is handed to `isRecursiveAliasThis(ref Type att, …)` by `ref` -> the
    // one-slot box (03 §3.3/§7.2).
    const att: { value: Type | null } = { value: null };
    let aggr = feaggr.value;
    for (;;) {
        aggr = expressionSemantic(aggr, sc);
        aggr = resolveProperties(sc, aggr);
        aggr = optimize(aggr, WANTvalue); // UFCS: `aggr.optimize(WANTvalue)`
        if (aggr.type === null || aggr.isErrorExp() !== null)
            return false;
        const tab = toBasetype(aggr.type);
        switch (tab.ty) {
            case TY.Tarray:            // https://dlang.org/spec/statement.html#foreach_over_arrays
            case TY.Tsarray:           // https://dlang.org/spec/statement.html#foreach_over_arrays
            case TY.Ttuple:            // https://dlang.org/spec/statement.html#foreach_over_tuples
            case TY.Taarray:           // https://dlang.org/spec/statement.html#foreach_over_associative_arrays
                break;

            case TY.Tclass:
            case TY.Tstruct: {
                const ad = isAggregate(tab);
                if (!sliced) {
                    // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows
                    // Dsymbol.deferred (bool) — 02 §11.5
                    sapply.value = search_function(ad as unknown as ScopeDsymbol,
                        isForeach ? Id.apply! : Id.applyReverse!);
                    if (sapply.value !== null) {
                        // https://dlang.org/spec/statement.html#foreach_over_struct_and_classes
                        // opApply aggregate
                        break;
                    }
                    if (feaggr.value.op !== EXP.type) {
                        /* See if rewriting `aggr` to `aggr[]` will work
                         */
                        const rinit0: Expression = new ArrayExp(aggr.loc, feaggr.value);
                        const rinit = trySemantic(rinit0, sc);
                        if (rinit !== null) { // if it worked
                            aggr = rinit;
                            sliced = true;  // only try it once
                            continue;
                        }
                    }
                }
                // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows
                // Dsymbol.deferred (bool) — 02 §11.5
                if (search(ad as unknown as Dsymbol, Loc.initial,
                        isForeach ? Id.Ffront! : Id.Fback!) !== null) {
                    // https://dlang.org/spec/statement.html#foreach-with-ranges
                    // range aggregate
                    break;
                }
                if (ad!.aliasthis !== null) {
                    // opover.d:1279 — `isRecursiveAliasThis(att, tab)` (typesem.d:9214).
                    if (isRecursiveAliasThis(att, tab))     // error, circular alias this
                        return false;
                    aggr = resolveAliasThis(sc, aggr)!;
                    continue;
                }
                return false;
            }

            case TY.Tdelegate: {       // https://dlang.org/spec/statement.html#foreach_over_delegates
                const de = aggr.isDelegateExp(); // 06 §2.6 hoist
                if (de !== null) {
                    sapply.value = de.func;
                }
                break;
            }

            case TY.Terror:
                break;

            default:
                return false;
        }
        feaggr.value = aggr;
        return true;
    }
    // dmd/opover.d:1303 — `assert(0);` (unreachable: the `for(;;)` above never falls out).
    // Faithful `assert(0)`, NOT a wall (11 §2.5 accounting rule).
    assertUnreachable();
}

/*****************************************
 * dmd/opover.d:1319 — `bool inferApplyArgTypes(ForeachStatement fes, Scope* sc, ref Dsymbol sapply)`.
 * Given array of foreach parameters and an aggregate type,
 * find best opApply overload,
 * if any of the parameter types are missing, attempt to infer
 * them from the aggregate type.
 * Params:
 *      fes = the foreach statement
 *      sc = context
 *      sapply = null or opApply or delegate, overload resolution has not been done.
 *               Do overload resolution on sapply. (`ref` rebinding → `{ value }` box, 03 §3.2/§7.2)
 * Returns:
 *      false for errors
 */
export function inferApplyArgTypes(fes: ForeachStatement, sc: Scope,
                                   sapply: { value: Dsymbol | null }): boolean {
    if (fes.parameters === null || fes.parameters.length === 0)
        return false;
    if (sapply.value !== null) { // prefer opApply
        for (const p of fes.parameters) {
            if (p!.type !== null) {
                p!.type = typeSemantic(p!.type, fes.loc, sc);        // UFCS (typesem.d:3213)
                p!.type = addStorageClass(p!.type, p!.storageClass); // UFCS (typesem.d:7881)
            }
        }

        // Determine ethis for sapply
        let ethis: Expression;
        const tab = toBasetype(fes.aggr!.type!);
        if (tab.isTypeClass() !== null || tab.isTypeStruct() !== null)
            ethis = fes.aggr!;
        else {
            assert(tab.isTypeDelegate() !== null && fes.aggr!.isDelegateExp() !== null);
            ethis = fes.aggr!.isDelegateExp()!.e1!;
        }

        /* Look for like an
         *  int opApply(int delegate(ref Type [, ...]) dg);
         * overload
         */
        const fd = sapply.value.isFuncDeclaration(); // 06 §2.6 hoist
        if (fd !== null) {
            const fdapply = findBestOpApplyMatch(ethis, fd, fes.parameters); // 06 §2.6 hoist
            if (fdapply !== null) {
                // Fill in any missing types on foreach parameters[]
                matchParamsToOpApply(fdapply.type!.isTypeFunction()!, fes.parameters, true);
                sapply.value = fdapply;
                return true;
            }
            return false;
        }
        return true;   // shouldn't this be false?
    }

    let p: Parameter = fes.parameters.opIndex(0)!;
    const taggr = fes.aggr!.type;
    assert(taggr !== null);
    const tab = toBasetype(taggr);
    switch (tab.ty) {
        case TY.Tarray:
        case TY.Tsarray:
        case TY.Ttuple:
            if (fes.parameters.length === 2) {
                if (p.type === null) {
                    p.type = Type.tsize_t; // key type
                    p.type = addStorageClass(p.type, p.storageClass);
                }
                p = fes.parameters.opIndex(1)!;
            }
            if (p.type === null && tab.isTypeTuple() === null) {
                p.type = nextOf(tab); // value type
                p.type = addStorageClass(p.type!, p.storageClass);
            }
            break;

        case TY.Taarray: {
            const taa: TypeAArray = tab.isTypeAArray()!;
            if (fes.parameters.length === 2) {
                if (p.type === null) {
                    p.type = taa.index; // key type
                    p.type = addStorageClass(p.type!, p.storageClass);
                    if ((p.storageClass & STC.ref_) !== 0n) // key must not be mutated via ref
                        p.type = addMod(p.type!, MODFlags.const_);
                }
                p = fes.parameters.opIndex(1)!;
            }
            if (p.type === null) {
                p.type = taa.next; // value type
                p.type = addStorageClass(p.type!, p.storageClass);
            }
            break;
        }

        case TY.Tclass:
        case TY.Tstruct: {
            const ad = isAggregate(tab);
            if (fes.parameters.length === 1) {
                if (p.type === null) {
                    /* Look for a front() or back() overload
                     */
                    const id = (fes.op === TOK.foreach_) ? Id.Ffront! : Id.Fback!;
                    // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows
                    // Dsymbol.deferred (bool) — 02 §11.5
                    const s = search(ad as unknown as Dsymbol, Loc.initial, id);
                    const fd = s !== null ? s.isFuncDeclaration() : null;
                    if (fd !== null) {
                        // Resolve inout qualifier of front type
                        p.type = nextOf(fd.type!);
                        if (p.type !== null) {
                            // opover.d:1429 — `p.type = p.type.substWildTo(tab.mod)`
                            // (typesem.d:8926).
                            p.type = substWildTo(p.type, tab.mod);
                            p.type = addStorageClass(p.type, p.storageClass);
                        }
                    } else if (s !== null && s.isTemplateDeclaration() !== null) {
                    } else if (s !== null && s.isDeclaration() !== null)
                        p.type = s.isDeclaration()!.type;
                    else
                        break;
                }
                break;
            }
            break;
        }

        case TY.Tdelegate: {
            const td = tab.isTypeDelegate()!;
            if (!matchParamsToOpApply(td.next!.isTypeFunction()!, fes.parameters, true))
                return false;
            break;
        }

        default:
            break; // ignore error, caught later
    }
    return true;
}

/*********************************************
 * dmd/opover.d:1469 — `private FuncDeclaration findBestOpApplyMatch(Expression ethis,
 * FuncDeclaration fstart, Parameters* parameters)`.
 * Find best overload match on fstart given ethis and parameters[].
 * Params:
 *      ethis = expression to use for `this`
 *      fstart = opApply or foreach delegate
 *      parameters = ForeachTypeList (i.e. foreach parameters)
 * Returns:
 *      best match if there is one, null if error
 */
function findBestOpApplyMatch(ethis: Expression, fstart: FuncDeclaration,
                              parameters: Parameters): FuncDeclaration | null {
    const mod: MOD = ethis.type!.mod;
    let match: MATCH = MATCH.nomatch;
    // D `FuncDeclaration fd_best; FuncDeclaration fd_ambig;` — both captured BY REFERENCE by the
    // delegate below and written there. TS's control-flow analysis does not account for a nested
    // closure's writes, so a plain `let` reads back as its stale `null` initializer after the
    // call; the two slots therefore live in one named state object whose property reads keep the
    // declared type (02 §11.4's re-read remedy in its state-object form, 06 §4). `match` needs no
    // box: it is only ever compared, never read for identity after the call.
    const fd: { best: FuncDeclaration | null; ambig: FuncDeclaration | null } =
        { best: null, ambig: null };

    // The `scope int delegate(Dsymbol)` literal passed to overloadApply (04 §4.1/§4.2): an arrow
    // capturing `mod`, `match`, `fd.best`, `fd.ambig`, `parameters` by reference, as D does.
    const overloadApplyDg = (s: Dsymbol): number => {
        const f = s.isFuncDeclaration();
        if (f === null)
            return 0;           // continue
        const tf: TypeFunction = f.type!.isTypeFunction()!;
        let m: MATCH = MATCH.exact;
        if (f.isThis() !== null) {
            if (!MODimplicitConv(mod, tf.mod))
                m = MATCH.nomatch;
            else if (mod !== tf.mod)
                m = MATCH.constant;
        }
        if (!matchParamsToOpApply(tf, parameters, false))
            m = MATCH.nomatch;
        if (m > match) {
            fd.best = f;
            fd.ambig = null;
            match = m;
        } else if (m === match && m > MATCH.nomatch) {
            assert(fd.best !== null);
            const bestTf = fd.best.type!.isTypeFunction();
            assert(bestTf !== null);

            // Found another overload with different attributes?
            // e.g. @system vs. @safe opApply
            // @@@DEPRECATED_2.112@@@
            // See semantic2.d Semantic2Visitor.visit(FuncDeclaration):
            // Remove `false` after deprecation period is over.
            let ambig = tf.attributesEqual(bestTf, false);

            // opApplies with identical attributes could still accept
            // different function bodies as delegate
            // => different parameters or attributes
            if (ambig) {
                // Fetch the delegates that receive the function body
                const tfBody = tf.parameterList.opIndex(0)!.type!.isTypeDelegate()!.next;
                assert(tfBody !== null);

                const bestBody = bestTf.parameterList.opIndex(0)!.type!.isTypeDelegate()!.next;
                assert(bestBody !== null);

                // Ignore covariant matches, as later on it can be redone
                // after the opApply delegate has its attributes inferred.
                // opover.d:1525 — `ambig = !(tfBody.covariant(bestBody) == Covariant.yes ||
                // bestBody.covariant(tfBody) == Covariant.yes)` (typesem.d:8044). D's `STC* pstc`
                // and `bool cppCovariant` are both defaulted at this call site.
                ambig = !(covariant(tfBody, bestBody) === Covariant.yes
                    || covariant(bestBody, tfBody) === Covariant.yes);
            }

            if (ambig)
                fd.ambig = f;                           // not covariant, so ambiguous
        }
        return 0;               // continue
    };
    // opover.d:1476 — `overloadApply(fstart, (Dsymbol s) { … })` (funcsem.d:4084). D leaves the
    // third parameter (`Scope* sc = null`) at its default here; the return value is discarded.
    overloadApply(fstart, overloadApplyDg);

    if (fd.ambig !== null) {
        error(ethis.loc, ds("`%s.%s` matches more than one declaration:"),
            ethis.toChars(), fstart.ident!.toChars());
        errorSupplemental(fd.best!.loc, ds("`%s`\nand:"), fd.best!.type!.toChars());
        errorSupplemental(fd.ambig.loc, ds("`%s`"), fd.ambig.type!.toChars());
        return null;
    }

    return fd.best;
}

/******************************
 * dmd/opover.d:1557 — `private bool matchParamsToOpApply(TypeFunction tf, Parameters* parameters,
 * bool infer)`.
 * Determine if foreach parameters match opApply parameters.
 * Infer missing foreach parameter types from type of opApply delegate.
 * Params:
 *      tf = type of opApply or delegate
 *      parameters = foreach parameters
 *      infer = infer missing parameter types
 * Returns:
 *      true for match for this function
 *      false for no match for this function
 */
function matchParamsToOpApply(tf: TypeFunction, parameters: Parameters, infer: boolean): boolean {
    const nomatch = false; // D `enum nomatch = false;` — manifest constant (02 §4.1, 07 §9)

    /* opApply/delegate has exactly one parameter, and that parameter
     * is a delegate that looks like:
     *     int opApply(int delegate(ref Type [, ...]) dg);
     */
    if (tf.parameterList.length() !== 1)
        return nomatch;

    /* Get the type of opApply's dg parameter
     */
    const p0: Parameter = tf.parameterList.opIndex(0)!;
    const de = p0.type!.isTypeDelegate();
    if (de === null)
        return nomatch;
    const tdg: TypeFunction = de.next!.isTypeFunction()!;

    /* We now have tdg, the type of the delegate.
     * tdg's parameters must match that of the foreach arglist (i.e. parameters).
     * Fill in missing types in parameters.
     */
    const nparams = tdg.parameterList.length();
    if (nparams === 0 || nparams !== parameters.length || tdg.parameterList.varargs !== VarArg.none)
        return nomatch; // parameter mismatch

    for (const [u, p] of parameters.opSlice().entries()) {
        const param: Parameter = tdg.parameterList.opIndex(u)!;
        if (p!.type !== null) {
            if (!p!.type.equals(param.type))
                return nomatch;
        } else if (infer) {
            p!.type = param.type;
            p!.type = addStorageClass(p!.type!, p!.storageClass);
        }
    }
    return true;
}

/**
 * dmd/opover.d:1609 — `private EXP reverseRelation(EXP op)`.
 * Reverse relational operator, eg >= becomes <=
 * Note this is not negation.
 * Params:
 *      op = comparison operator to reverse
 * Returns:
 *      reverse of op
 *
 * D module-private (touched by opover.test.ts).
 */
export function reverseRelation(op: EXP): EXP {
    switch (op) {
        case EXP.greaterOrEqual:  op = EXP.lessOrEqual;    break;
        case EXP.greaterThan:     op = EXP.lessThan;       break;
        case EXP.lessOrEqual:     op = EXP.greaterOrEqual; break;
        case EXP.lessThan:        op = EXP.greaterThan;    break;
        default:                  break;
    }
    return op;
}
