// Ported from dmd/escape.d (module dmd.escape).
//
// Functions for `@safe` scope-escape analysis: detecting when a pointer to the stack escapes via an
// assignment, a parameter pass, or a return. This file ports every declaration of escape.d (2278 D lines);
// what each entry point is, and the debug lines deliberately dropped, are enumerated here.
//
// PORTED LIVE (whole bodies, faithful 1:1):
//   - `checkAssignEscape`            (escape.d:609)  — the AssignExp/CatAssignExp escape check.
//   - `checkThrowEscape`             (escape.d:928)  — pointers to the stack escaping via `throw e`.
//   - `checkNewEscape`               (escape.d:969)  — ... via being placed into GC-allocated memory.
//   - `checkReturnEscape`            (escape.d:1106) — ... via returning `e` BY VALUE.
//   - `checkReturnEscapeRef`         (escape.d:1124) — ... via returning `e` BY `ref`.
//   - `checkReturnEscapeImpl`        (escape.d:1146) — the shared implementation of the two above.
//   - `printScopeReason`             (escape.d:297)  — monomorphized (one instantiation shape in the
//     tree); needed by `checkReturnEscapeImpl` at escape.d:1223 and exported because
//     `expressionsem.d:3240` imports it.
//   - `finishScopeParamInference`    (escape.d:2042) — post-body `scope`/`return` parameter inference.
//   - `checkParamArgumentEscape`     (escape.d:344)  — ... via passing `arg` to a function parameter.
//   - `checkMutableArguments`        (escape.d:80)   — DIP1021 argument ownership: one mutable ref or
//     pointer per memory object among a call's arguments, `this` and outer variables. Its private
//     callees `isReferenceToMutable` (:2093) and `isReferenceToMutableParameter` (the `Parameter`
//     overload, :2153, renamed per 04 §1 Form B) are ported with it.
//   - the private dependency closure they need, in D order. VISIBILITY: escape.d:45 is a
//     MODULE-WIDE `private:` label, so every module-scope declaration below it is D-private unless
//     it carries an explicit `public` / `package(dmd)` — which is why the entry points above each
//     spell `public` (escape.d:927/:968/:1105/:1123/:1496) and why `escapeByRef` (:1917),
//     `escapeExp` (:1508) and friends are correctly emitted NON-exported despite carrying no
//     `private` keyword of their own:
//       `EscapeState` (:48), `inferScope` (:1404), `inferReturn` (:1429), `escapeByValue` (:1497),
//       `escapeExp` (:1508), `getThisStorageClass` (:1884), `escapeByRef` (:1917),
//       `EscapeByResults` (:1926), `findAllOuterAccessedVariables` (:1988), `doNotInferScope` (:2022),
//       `EnclosedBy` (:2169), `enclosesLifetimeOf` (:2187), `setUnsafeDIP1000` (:2211) and its private
//       `scopeVar` overload `setUnsafeDIP1000ScopeVar` (:2219), `checkScopeVarAddr` (:2239),
//       `isTypesafeVariadicArray` (:2269).
//   - `ReturnParamDest` (:554) / `returnParamDest` (:576) — already here; cites re-anchored to 1.43.0.
//   - `checkArrayLiteralEscape` (:246) — whole body, now fully live: its only callee `checkNewEscape`
//     (:969) is filled in this file, so the wall that used to darken both of its working legs
//     (escape.d:250 and :254) is SWEPT.
//   - `checkAssocArrayLiteralEscape` (:270) — keys then values through `checkNewEscape`.
//   - `checkParamArgumentReturn` (:476) — `checkAssignEscape` over a synthesized `firstArg = arg`.
//   - `checkConstructorEscape` (:512) — `checkParamArgumentReturn` per `return` argument of `s.this(args)`.
//
// NO WALL IN THIS FILE, and every escape.d function is ported. Every ported body calls live code only.
//
// UFCS: `sc.setUnsafeDIP1000(…)`, `va.enclosesLifetimeOf(v)`, `tf.parameterStorageClass(…)` are D free
// functions invoked UFCS-style; they are ported as free functions taking the receiver first (04 §6).
//
// dropped: `enum log = false;` + every `if (log) printf(...)` line in the ported bodies — a
// translation-time-false debug switch (07 §"resolved" convention); the printf machinery has no port.
//   - `checkParamArgumentEscape`: escape.d:346 (`enum log`), :347-349 (the wrapped printf call), :389/:403.
//   - `checkAssignEscape`:        escape.d:611 (`enum log`), :612/:672/:678/:700/:705/:764/:788/:845/:886.
//   - `checkNewEscape`:           escape.d:975 (`enum log`), :976/:981/:1013/:1080; plus escape.d:971/:972,
//     the function-local `import dmd.globals: FeatureState; import dmd.errors: previewErrorFunc;`, which
//     this module's own import clause expresses.
//   - `checkReturnEscapeImpl`:    escape.d:1148 (`enum log`), :1149/:1154/:1239-1242/:1370 — the :1241
//     line is the sole use of `ScopeRefToChars`, so nothing else needs it.
//   - `checkReturnEscapeRef`:     escape.d:1126-1131, a `version (none)` printf block, resolved OFF (07).
//   - `checkMutableArguments`:    escape.d:83 (`enum log`), :84/:85/:178/:210-214 (named in its doc comment).
//   - `checkParamArgumentReturn`: escape.d:478 (`enum log`), :479-480; `checkConstructorEscape`: :514/:515.
// NOT in that list, because they are ALREADY comments in the D source and so nothing is dropped —
// and this enumeration is deliberately NOT exhaustive, it only names the ones a reader is most
// likely to look for: escape.d:813 (`//if (log) printf(...)`) inside `checkAssignEscape`,
// escape.d:1510 (`//printf(...)`) at the top of `escapeExp`, escape.d:1990 (`//printf(...)`) in
// `findAllOuterAccessedVariables`, plus escape.d:930/:936 (`checkThrowEscape`), :1006/:1045/:1046
// (`checkNewEscape`) and :1232/:1338/:1339 (`checkReturnEscapeImpl`). An absent D comment line is
// never a drop; only live D code can be dropped.
//
// LOAD ORDER. The value imports below (`./globals.js`, `./errors.js`, `./funcsem.js`, `./hdrgen.js`,
// `./id.js`, `./safe.js`, `./typesem.js`, `./expressionsem.js`) are read only inside function bodies;
// the `./expressionsem.js` edge is a real ESM cycle edge and is safe under 01 Rule 4.3 (no top-level
// value reads on either side). The full suite collects with them.

import type { Scope } from "./dscope.js";
import type { TypeFunction } from "./mtype.js";
import type { Type, Parameter } from "./mtype.js";
import type { Expression } from "./expression.js";
import type {
    AddrExp, SymOffExp, VarExp, ThisExp, PtrExp, DotVarExp, DelegateExp, FuncExp, TupleExp,
    ArrayLiteralExp, AssocArrayLiteralExp, StructLiteralExp, NewExp, CastExp, SliceExp, IndexExp, BinExp,
    BinAssignExp, CommaExp, CondExp, CallExp,
} from "./expression.js";
import type { FuncDeclaration, CtorDeclaration } from "./func.js";
import type { VarDeclaration } from "./declaration.js";
import type { Identifier } from "./identifier.js";
import type { Dsymbol } from "./dsymbol.js";
import type { RootObject } from "./rootobject.js";
import { DYNCAST } from "./rootobject.js";
import type { Loc } from "./location.js";
import type { DString } from "../dstring.js";
import type { Expressions, VarDeclarations } from "./arraytypes.js";

import { STC, TY, isRefReturnScope } from "./astenums.js";
import { EXP, TOK } from "./tokens.js";
import { ScopeRef, buildScopeRef } from "./mtype.js";
import { hasPointers, nextOf, toBasetype, baseElemOf, parameterStorageClass } from "./typesem.js";
import { expToVariable, calledFunctionType } from "./expressionsem.js";
import { lastComma, ThrowExp, AssignExp } from "./expression.js";
import { FeatureState } from "./globals.js";
import { previewErrorFunc, previewSupplementalFunc } from "./errors.js";
import { getLevel } from "./funcsem.js";
import { toErrMsg, dsymbolToErrMsg } from "./hdrgen.js";
import { Id } from "./id.js";
import { setFunctionToUnsafe, setUnsafePreview, setUnsafePreviewScopeVar, isSafeBypassingInference } from "./safe.js";
import { Array as DArray } from "./root/array.js";
import { assert, assertUnreachable, SwitchError } from "../assert.js";
import { ds } from "../dstring.js";

/**
 * A D `ref`/`out` parameter over a value the callee REASSIGNS becomes a one-slot box (03 §3.2/§3.3).
 * Exported because `finishScopeParamInference`'s `ref TypeFunction f` is part of this module's public
 * signature — the caller (`semantic3.d:1383`) must be able to build the box.
 */
export interface Ref<T> {
    value: T;
}

/**
 * dmd/escape.d:48 — `package(dmd) struct EscapeState`. Groups global state for escape checking.
 *
 * `private __gshared RootObject[int] scopeInferReason` (escape.d:53) — maps a `VarDeclaration`'s
 * `sequenceNumber` to the object that explains why `scope` was (or was not) inferred, for the
 * supplemental error message of https://issues.dlang.org/show_bug.cgi?id=23295. Module-global by design.
 * KEYED BY THE VARIABLE OBJECT, not its number: the number is set by the variable's semantic
 * (`global.varSequenceNumber++`, dmd/dsymbolsem.d:2168), unique among the variables analysed in one compile, and
 * the table's only uses are the lookup at dmd/escape.d:303 and the two inserts at :1412 and :2028, all on analysed
 * variables (`sequenceNumber`'s only other use, the ordering at dmd/escape.d:2203, asserts both numbers set at
 * :2201-2202), so in a compile the object and its number name the same entry. Across compiles a number names no
 * one variable: the kept-module engine (src/keep.ts) keeps a library variable's reason for later compiles, and
 * only the object says whose it is. A WeakMap also lets the variables of a dropped AST go.
 *
 * `private` here is D module-scope visibility, so the field stays reachable from this file's other
 * functions and is NOT emitted as TS `private` (01 §2.5). The struct is `package(dmd)`; nothing outside
 * escape.d reads it in the 1.43.0 tree, and the export serves the djs driver's call of `reset`.
 */
export class EscapeState {
    static scopeInferReason: WeakMap<VarDeclaration, RootObject> = new WeakMap<VarDeclaration, RootObject>();

    /// dmd/escape.d:56 — `static void reset()`. Called by `initDMD` / `deinitializeDMD` to reset
    /// global state. The 1.43.0 tree has no caller (upstream dmd's frontend.d is not in LDC's tree); the djs
    /// driver calls it between two compiles in one process (src/djs.ts `deinitializeFrontend`).
    static reset(): void {
        EscapeState.scopeInferReason = new WeakMap<VarDeclaration, RootObject>();
    }
}

/**
 * dmd/escape.d:80 — `bool checkMutableArguments(ref Scope sc, FuncDeclaration fd, TypeFunction tf,` (D `public`,
 * escape.d:79; continued `Expression ethis, Expressions* arguments, bool gag)`).
 *
 * Checks memory objects passed to a function (DIP 1021): if a memory object is passed by ref or by
 * pointer, all of the refs or pointers are const, or there is only one mutable ref or pointer to it.
 *
 * Params (D doc-comment, escape.d:69-75):
 *   sc        = used to determine current function and module
 *   fd        = function being called; null for a call through a function pointer or delegate
 *   tf        = fd's type
 *   ethis     = if not null, the `this` pointer
 *   arguments = actual arguments to function (D `Expressions*`, dereferenced unguarded: non-null)
 *   gag       = do not print error messages
 * Returns: `true` if error.
 *
 * Preconditions: every argument has a type (post-semantic); `ethis !== null` implies `fd !== null`
 * and `fd.isThis()` is a class or struct (D asserts both, escape.d:137/:146).
 * Side effects: reports through `sc.eSink` unless `gag`; may commit `sc.func` to `@system` through
 * `setFunctionToUnsafe` (safe.d:422) when `-preview=dip1000` is on and the callee is not `@live`.
 * The one D caller (expressionsem.d:4902) passes `gag = false`, so the gagged leg is unreachable
 * from the frontend today (the `if (!gag)` at escape.d:188).
 *
 * INDEX HAZARD (faithful, not repaired): `(*arguments)[i].loc` is read for `i >= arguments.length`
 * whenever `ethis` is set and `fd.outerVars` is non-empty. The `else if (ethis)` arm (escape.d:129) also
 * claims every outer-variable slot, so the outer-variable arm is dead, `ethis` is duplicated into those
 * slots, pairs with its own copy, and `checkOnePair` fires with `i == arguments.length`. D's release
 * `opIndex` reads past the end (the debug build bounds-checks only against capacity, root/array.d:35,
 * :317); the port's `opIndex` asserts. Reached by any call, even with no arguments, to a `@safe` member
 * of a function-local mutable struct or class that reads an outer variable:
 * `void f() @safe { int x; struct S { void m() @safe { x++; } } S s; s.m(); }` segfaults ldc2 1.43.0
 * inside this function and trips the port's `opIndex` assert. Both are crashes; there is no diagnostic
 * to match.
 *
 * dropped: escape.d:83 `enum log = false;` and every `if (log) printf(...)` (:84, :85, :178, :210-214),
 * a translation-time-false debug switch (07).
 */
export function checkMutableArguments(sc: Scope, fd: FuncDeclaration | null, tf: TypeFunction,
    ethis: Expression | null, arguments_: Expressions, gag: boolean): boolean {
    let errors = false;

    /* Outer variable references are treated as if they are extra arguments
     * passed by ref to the function (which they essentially are via the static link).
     */
    // dmd/escape.d:91 — `VarDeclaration[] outerVars = fd ? fd.outerVars[] : null;`: a D null slice
    // reads as length 0, which the empty array reproduces.
    const outerVars: (VarDeclaration | null)[] = fd !== null ? fd.outerVars.opSlice() : [];

    // dmd/escape.d:93.
    const len = arguments_.length + (ethis !== null ? 1 : 0) + outerVars.length;
    if (len <= 1)
        return errors;

    // dmd/escape.d:97 — a function-local D struct. Every access below is by `ref` (the `foreach (ref …)`
    // loops and the `ref EscapeBy` parameters), so no copy point exists and no `copy()` is emitted.
    class EscapeBy {
        byref: VarDeclarations = new DArray<VarDeclaration | null>();
        byvalue: VarDeclarations = new DArray<VarDeclaration | null>();
        param: Parameter | null = null; // null if no Parameter for this argument
        isMutable = false;              // true if reference to mutable
    }

    // dmd/escape.d:105 — `auto escapeBy = new EscapeBy[len];`, each element default-initialised.
    const escapeBy: EscapeBy[] = [];
    for (let k = 0; k < len; k++)
        escapeBy.push(new EscapeBy());
    const paramLength = tf.parameterList.length();

    // Fill in escapeBy[] with arguments[], ethis, and outerVars[]
    for (let i = 0; i < len; i++) {
        const eb = escapeBy[i];
        let refs: boolean;
        let arg: Expression;
        if (i < arguments_.length) {
            arg = arguments_.opIndex(i)!;
            if (i < paramLength) {
                // `tf.parameterList[i]` is non-null for `i < paramLength`.
                eb.param = tf.parameterList.opIndex(i)!;
                refs = eb.param.isReference();
                eb.isMutable = isReferenceToMutableParameter(eb.param, arg.type!);
            } else {
                eb.param = null;
                refs = false;
                eb.isMutable = isReferenceToMutable(arg.type!);
            }
        } else if (ethis !== null) {
            /* ethis is passed by value if a class reference,
             * by ref if a struct value
             */
            eb.param = null;
            arg = ethis;
            // dmd/escape.d:136 — `fd.isThis()`: `ethis` is only passed for a member call, so `fd` is set.
            const ad = fd!.isThis();
            assert(ad !== null);
            assert(ethis !== null);
            if (ad!.isClassDeclaration() !== null) {
                refs = false;
                eb.isMutable = isReferenceToMutable(arg.type!);
            } else {
                assert(ad!.isStructDeclaration() !== null);
                refs = true;
                eb.isMutable = arg.type!.isMutable();
            }
        } else {
            // outer variables are passed by ref
            eb.param = null;
            refs = true;
            const var_ = outerVars[i - (len - outerVars.length)]!;
            eb.isMutable = var_.type!.isMutable();
            eb.byref.push(var_);
            continue;
        }

        // dmd/escape.d:162-165 — the four nested callbacks; only `onRef` / `onValue` do work.
        const onRef = (v: VarDeclaration, _transition: boolean): void => { eb.byref.push(v); };
        const onValue = (v: VarDeclaration): void => { eb.byvalue.push(v); };
        const onFunc = (_fd: FuncDeclaration, _called: boolean): void => {};
        const onExp = (_e: Expression, _transition: boolean): void => {};

        const er = new EscapeByResults(onRef, onValue, onFunc, onExp);

        // dmd/escape.d:169.
        if (refs)
            escapeByRef(arg, er);
        else
            escapeByValue(arg, er);
    }

    // dmd/escape.d:175 — nested `void checkOnePair(size_t i, ref EscapeBy eb, ref EscapeBy eb2,` (with
    // `VarDeclaration v, VarDeclaration v2, bool of`).
    const checkOnePair = (i: number, eb: EscapeBy, eb2: EscapeBy, v: VarDeclaration, v2: VarDeclaration,
        of: boolean): void => {
        if (v2 !== v)
            return;
        if (!(eb.isMutable || eb2.isMutable))
            return;

        // dmd/escape.d:185 — `&&` short-circuits, so `setFunctionToUnsafe` runs only on the dip1000 leg.
        if (!tf.isLive && !(sc.useDIP1000() === FeatureState.enabled && sc.func !== null &&
            setFunctionToUnsafe(sc.func)))
            return;

        if (!gag) {
            // int i; funcThatEscapes(ref int i);
            // funcThatEscapes(i); // error escaping reference _to_ `i`
            // int* j; funcThatEscapes2(int* j);
            // funcThatEscapes2(j); // error escaping reference _of_ `i`
            const referenceVerb: DString = of ? ds("of") : ds("to");
            const msg: DString = eb.isMutable && eb2.isMutable
                ? ds("more than one mutable reference %s `%s` in arguments to `%s()`")
                : ds("mutable and const references %s `%s` in arguments to `%s()`");
            sc.eSink!.error(arguments_.opIndex(i)!.loc, msg,
                referenceVerb,
                v.toChars(),
                fd !== null ? fd.toPrettyChars() : ds("indirectly"));
        }
        errors = true;
    };

    // dmd/escape.d:206 — nested `void escape(size_t i, ref EscapeBy eb, bool byval)`.
    const escape = (i: number, eb: EscapeBy, byval: boolean): void => {
        for (const vElem of byval ? eb.byvalue : eb.byref) {
            const v = vElem!;
            if (byval && !hasPointers(v.type!))
                continue;
            // dmd/escape.d:217 — `foreach (ref eb2; escapeBy[i + 1 .. $])`.
            for (let j = i + 1; j < len; j++) {
                const eb2 = escapeBy[j];
                for (const v2 of byval ? eb2.byvalue : eb2.byref) {
                    checkOnePair(i, eb, eb2, v, v2!, byval);
                }
            }
        }
    };
    // dmd/escape.d:226 — `foreach (const i, ref eb; escapeBy[0 .. $ - 1])`.
    for (let i = 0; i < len - 1; i++) {
        const eb = escapeBy[i];
        escape(i, eb, true);
        escape(i, eb, false);
    }

    return errors;
}

/**
 * dmd/escape.d:246 — `bool checkArrayLiteralEscape(ref Scope sc, ArrayLiteralExp ae, bool gag)`. An
 * array literal is going to be allocated on the GC heap; check its elements to see if any would escape
 * by going on the heap.
 *
 * Params (D doc-comment, escape.d:238-243): `sc` determines the current function and module, `ae` is the
 * array literal, `gag` suppresses the error messages. Returns `true` if any element escaped.
 *
 * `*ae.elements` (escape.d:251) is a pointer dereference D performs unguarded, so a null `elements` is
 * a caller-side precondition, not a case this function handles: the port keeps that precondition with
 * `ae.elements!` — the shape `escapeByValue`'s `visitArrayLiteral` already uses on the same field
 * (escape.d:1629). The one D caller in this tree, `nogc.d:158`, reaches it only for `dim != 0`.
 *
 * WALL SWEPT (11 §2.5, "sweeping a wall cites the D line that AUTHORISES the now-live callee"): the
 * former wall over `checkNewEscape` stood on both statements that do work — escape.d:250 (the `basis`)
 * and escape.d:254 (each non-null element). `checkNewEscape` is now ported in full at its own D
 * position (escape.d:969) in this file, so both call sites are live and this entry point no longer
 * darkens anything.
 *
 * The two `false` returns are LIVE but UNREACHABLE from the one D caller (nogc.d:158), so they are
 * leg-preservation legs only. This function never consults `hasPointers()`: its `false` paths are
 * "nothing to check", not "pointer-free". `nogc.d:152-154` returns before the call whenever
 * `dim == 0`, so `elements` is non-empty here; and `elements` may hold nulls only when `basis !is null`
 * (the field's own contract, expression.d:1346-1349, which `opIndex` at expression.d:1403 relies on).
 */
export function checkArrayLiteralEscape(sc: Scope, ae: ArrayLiteralExp, gag: boolean): boolean {
    // dmd/escape.d:248 — `bool errors;`, D-default-initialised to false.
    let errors = false;

    // dmd/escape.d:249. WALL SWEPT: `checkNewEscape` (escape.d:969) is now filled in this file, below
    // `checkThrowEscape` at its own D position, so both call sites here are live again.
    if (ae.basis !== null)
        errors = checkNewEscape(sc, ae.basis, gag);

    // dmd/escape.d:251.
    for (const ex of ae.elements!) {
        // dmd/escape.d:253.
        if (ex !== null) {
            // dmd/escape.d:254 — `errors |= checkNewEscape(sc, ex, gag)`: D's `|=` always evaluates its
            // right operand, and this callee emits diagnostics, so the call is sequenced BEFORE the or
            // (06 §2.5), exactly as at escape.d:773 below.
            const elemErr = checkNewEscape(sc, ex, gag);
            errors = errors || elemErr;
        }
    }

    // dmd/escape.d:256.
    return errors;
}

/**
 * dmd/escape.d:270 — `bool checkAssocArrayLiteralEscape(ref Scope sc, AssocArrayLiteralExp ae, bool gag)`.
 *
 * An associative array literal is going to be allocated on the GC heap: check its keys, then its values,
 * to see if any would escape by going on the heap. Params (D doc-comment, escape.d:262-267): `sc`
 * determines the current function and module, `ae` is the literal, `gag` suppresses the error messages.
 * Returns `true` if any key or value escaped.
 *
 * Preconditions: `ae.keys` and `ae.values` are non-null — D dereferences both unguarded (escape.d:273
 * and :278), and the `AssocArrayLiteralExp` constructor asserts they have equal length
 * (expression.d:1427). The one D caller, expressionsem.d:6156, reaches it after
 * semantic has typed the literal. Every key is checked before any value, so with both escaping the
 * key diagnostics print first.
 *
 * Cost: one `checkNewEscape` per non-null element; each may mutate scope-inference state on the
 * variables it reaches (see `checkNewEscape`).
 */
export function checkAssocArrayLiteralEscape(sc: Scope, ae: AssocArrayLiteralExp, gag: boolean): boolean {
    // dmd/escape.d:272 — `bool errors;`, D-default-initialised to false.
    let errors = false;

    // dmd/escape.d:273.
    for (const ex of ae.keys!) {
        // dmd/escape.d:276 — `errors |= checkNewEscape(sc, ex, gag)`: D's `|=` always evaluates its
        // right operand, and this callee emits diagnostics, so the call is sequenced before the or (06 §2.5).
        if (ex !== null) {
            const keyErr = checkNewEscape(sc, ex, gag);
            errors = errors || keyErr;
        }
    }

    // dmd/escape.d:278.
    for (const ex of ae.values!) {
        // dmd/escape.d:280-281 — same `|=` sequencing as :276.
        if (ex !== null) {
            const valueErr = checkNewEscape(sc, ex, gag);
            errors = errors || valueErr;
        }
    }

    // dmd/escape.d:283.
    return errors;
}

/**
 * dmd/escape.d:297 — `public void printScopeReason(E)(E printFunc, VarDeclaration v, int recursionLimit,
 * bool positive)`.
 *
 * Print the reason why a variable was (or was not) inferred `scope`, as a supplemental diagnostic.
 * Params (D doc-comment, escape.d:289-294): `printFunc` = error/deprecation print function to use,
 * `v` = parameter that was not inferred, `recursionLimit` = recursion limit for printing the reason,
 * `positive` = true for telling why `v` IS `scope`, false for telling why it is NOT.
 *
 * MONOMORPHIZED (07): `E` has exactly ONE instantiation shape in the 1.43.0 tree — the return type of
 * `previewSupplementalFunc` / `previewErrorFunc` (`errors.ts:150`/`:175`), i.e.
 * `(loc, format, ...args) => void`. The four call sites are escape.d:382, :383, :1223 (all
 * `previewSupplementalFunc(...)`) and expressionsem.d:3240 (a local `errorFunc` of the same shape), so
 * no overload set is needed.
 *
 * `v` is nullable: D's own `!v` guard below is the whole reason (expressionsem.d:3240 passes
 * `s.scopeVar`, and the recursive call at escape.d:318 passes a value D never null-checks).
 */
export function printScopeReason(printFunc: (loc: Loc, format: DString, ...args: unknown[]) => void,
                                 v: VarDeclaration | null, recursionLimit: number, positive: boolean): void {
    // dmd/escape.d:299 — the decrement precedes the guard, so a caller's `10` permits 10 levels.
    recursionLimit--;
    if (recursionLimit < 0 || !v)
        return;

    // dmd/escape.d:303 — `if (RootObject* o = v.sequenceNumber in EscapeState.scopeInferReason)`. D's
    // `in` on an associative array yields a pointer, null when the key is absent (02 §9); the WeakMap
    // lookup (keyed by the variable, see EscapeState) plus an `undefined` test is that same test, and `*o`
    // below is the mapped value.
    const o = EscapeState.scopeInferReason.get(v);
    if (o !== undefined) {
        // dmd/escape.d:305 — a plain `switch` in D (not `final`), with an `assert(0)` default.
        switch (o.dyncast()) {
            case DYNCAST.expression: {
                // dmd/escape.d:307 — `Expression e = cast(Expression) *o;`, proved by the `dyncast()`
                // tag just matched (02 §11.5c(1)).
                const e = o as unknown as Expression;
                if (positive)
                    printFunc(e.loc, ds("`%s` inferred `scope` because of `%s`"), dsymbolToErrMsg(v), toErrMsg(e));
                else
                    printFunc(e.loc, ds("`%s` is not `scope` because of `%s`"), dsymbolToErrMsg(v), toErrMsg(e));
                break;
            }
            case DYNCAST.dsymbol: {
                // dmd/escape.d:314 — `VarDeclaration v1 = cast(VarDeclaration) *o;`. D narrows further
                // than the tag proves (`DYNCAST.dsymbol` admits any `Dsymbol`); the narrowing is sound
                // because the only writer of a Dsymbol into `scopeInferReason` is `doNotInferScope`
                // (escape.d:2022), and its one Dsymbol-passing call site passes the `VarDeclaration`
                // `vPar` (escape.d:393). Recorded here per 02 §11.5c, since the tag alone is
                // weaker than the cast.
                const v1 = o as unknown as VarDeclaration;
                assert(!positive);
                printFunc(v1.loc, ds("`%s` is assigned to non-scope parameter `%s`"),
                    dsymbolToErrMsg(v), dsymbolToErrMsg(v1));
                printScopeReason(printFunc, v1, recursionLimit, positive);
                break;
            }
            default:
                // dmd/escape.d:322 — `assert(0)`: no other `dyncast` tag is ever stored in
                // `scopeInferReason`. A faithful port of D's `assert(0)`, not a wall (11 §2.5).
                assertUnreachable();
        }
    }
}

/**
 * dmd/escape.d:344 — `bool checkParamArgumentEscape(ref Scope sc, FuncDeclaration fdc, Identifier parId,
 * VarDeclaration vPar, STC parStc, Expression arg, bool assertmsg, bool gag)`. Function parameter `par`
 * is being initialized to `arg`, and `par` may escape: detect whether scoped values can escape this way
 * and report them.
 *
 * Params:
 *   sc        = used to determine current function and module
 *   fdc       = function being called, `null` if called indirectly
 *   parId     = name of function parameter for error messages (null for an anonymous parameter)
 *   vPar      = `VarDeclaration` corresponding to `par`
 *   parStc    = storage classes of function parameter (may have added `scope` from `pure`)
 *   arg       = initializer for param
 *   assertmsg = true if the parameter is the msg argument to assert(bool, msg).
 *   gag       = do not print error messages
 * Returns: `true` if pointers to the stack can escape via assignment.
 */
export function checkParamArgumentEscape(
    sc: Scope, fdc: FuncDeclaration | null, parId: Identifier | null, vPar: VarDeclaration | null,
    parStc: STC, arg: Expression, assertmsg: boolean, gag: boolean,
): boolean {
    // dmd/escape.d:352 — no pointers in the argument type → nothing can escape.
    if (!hasPointers(arg.type!))
        return false;

    let result = false;

    /* 'v' is assigned unsafely to 'par'
     */
    // dmd/escape.d:359 — `void unsafeAssign(string desc)(VarDeclaration v)`: a nested function template
    // whose only template parameter is the message fragment `desc`, spliced into the format strings at
    // compile time. Ported as a closure taking `desc` first; `ds(...)` of the spliced JS string builds
    // the same format bytes.
    const unsafeAssign = (desc: string, v: VarDeclaration): void => {
        if (assertmsg) {
            // dmd/escape.d:363 — `result |= …`: evaluated unconditionally, then or-ed (no short circuit).
            // "assigning" + desc has no space between them: verbatim from dmd (10 §3).
            const assertErr = setUnsafeDIP1000(sc, gag, arg.loc,
                ds("assigning" + desc + " `%s` to non-scope parameter calling `assert()`"), v);
            result = result || assertErr;
            return;
        }

        // dmd/escape.d:368.
        // implicit `this` parameter to member function
        const isThis = fdc !== null && fdc.needThis() && fdc.vthis === vPar;

        // dmd/escape.d:370.
        const msg: DString =
            (isThis) ?
                ds(desc + " `%s` calling non-scope member function `%s.%s()`") :
            (fdc !== null && parId !== null) ?
                ds("assigning " + desc + " `%s` to non-scope parameter `%s` calling `%s`") :
            (fdc !== null && parId === null) ?
                ds("assigning " + desc + " `%s` to non-scope anonymous parameter calling `%s`") :
            (fdc === null && parId !== null) ?
                ds("assigning " + desc + " `%s` to non-scope parameter `%s`") :
                ds(desc + " `%s` assigned to non-scope anonymous parameter");

        // dmd/escape.d:377. `fdc!` in the isThis arm: `isThis` is false for a null `fdc`.
        if (isThis ?
            setUnsafeDIP1000ScopeVar(sc, gag, arg.loc, vPar, msg, arg, fdc!.toParent2(), fdc) :
            setUnsafeDIP1000ScopeVar(sc, gag, arg.loc, vPar, msg, v, parId !== null ? parId : fdc, fdc)) {
            result = true;
            printScopeReason(previewSupplementalFunc(sc.isDeprecated(), sc.useDIP1000()), vPar, 10, false);
            printScopeReason(previewSupplementalFunc(sc.isDeprecated(), sc.useDIP1000()), v, 10, true);
        }
    };

    // dmd/escape.d:387 — `void onValue(VarDeclaration v)`.
    const onValue = (v: VarDeclaration): void => {
        if ((parStc & STC.scope_) !== 0n)
            return;

        doNotInferScope(v, vPar);

        if (v.isScope()) {
            unsafeAssign("scope variable", v);
        }
    };

    // dmd/escape.d:401 — `void onRef(VarDeclaration v, bool retRefTransition)`. `retRefTransition` unused.
    const onRef = (v: VarDeclaration, _retRefTransition: boolean): void => {
        const p: Dsymbol | null = v.toParent2();

        doNotInferScope(v, arg);
        if (checkScopeVarAddr(v, arg, sc, gag)) {
            result = true;
            return;
        }

        // dmd/escape.d:414.
        if (p === sc.func && (parStc & STC.scope_) === 0n) {
            unsafeAssign("reference to local variable", v);
            return;
        }
    };

    // dmd/escape.d:421 — `void onFunc(FuncDeclaration fd, bool called)`. `called` is unused here.
    const onFunc = (fd: FuncDeclaration, _called: boolean): void => {
        //printf("fd = %s, %d\n", fd.toChars(), fd.tookAddressOf);
        if ((parStc & STC.scope_) !== 0n)
            return;
        // `VarDeclarations vars;` is a stack-local Array VALUE; `&vars` is the out-parameter (03 §3.2).
        const vars: VarDeclarations = new DArray<VarDeclaration | null>();
        findAllOuterAccessedVariables(fd, vars);

        // dmd/escape.d:429.
        for (const vElem of vars) {
            const v = vElem!;
            //printf("v = %s\n", v.toChars());
            assert(!v.isDataseg()); // these are not put in the closureVars[]

            const p: Dsymbol | null = v.toParent2();

            doNotInferScope(v, arg);

            // dmd/escape.d:438 — D's `return` here leaves onFunc, not just the loop.
            if ((v.isReference() || v.isScope()) && p === sc.func) {
                unsafeAssign("reference to local", v);
                return;
            }
        }
    };

    // dmd/escape.d:446 — `void onExp(Expression ee, bool retRefTransition)`. `retRefTransition` unused.
    const onExp = (ee: Expression, _retRefTransition: boolean): void => {
        if ((parStc & STC.scope_) !== 0n)
            return;
        const msg: DString = parId !== null
            ? ds("assigning reference to stack allocated value returned by `%s` to non-scope parameter `%s`")
            : ds("assigning reference to stack allocated value returned by `%s` to non-scope anonymous parameter");

        // dmd/escape.d:454 — `result |= …`; `parId` may be null (D's `RootObject[] args...` admits it).
        const expErr = setUnsafeDIP1000(sc, gag, ee.loc, msg, ee, parId);
        result = result || expErr;
    };

    // dmd/escape.d:457.
    const er = new EscapeByResults(onRef, onValue, onFunc, onExp);
    escapeByValue(arg, er);
    return result;
}

/**
 * dmd/escape.d:476 — `bool checkParamArgumentReturn(ref Scope sc, Expression firstArg, Expression arg,` (the
 * signature continues `Parameter param, bool gag)` on the same D line).
 *
 * A function argument initializes a `return` parameter, and that parameter gets assigned to `firstArg`:
 * the check is `checkAssignEscape` over a synthesized `firstArg = arg;`. Params (D doc-comment,
 * escape.d:466-471): `sc` determines the current function and module, `firstArg` is the `ref` argument
 * (or the constructed `this`) through which `arg` may be assigned, `arg` initializes the parameter,
 * `param` is its declaration, `gag` suppresses the error messages. Returns `true` if the assignment to
 * `firstArg` would cause an error.
 *
 * Preconditions: `arg.type` is non-null (D reads `arg.type.hasPointers()` unguarded, escape.d:486; both D
 * callers pass semantically-analysed arguments). The synthesized `AssignExp` is never attached to the AST:
 * it exists only for `checkAssignEscape`, which may still infer `scope` on variables it reaches.
 *
 * Callers: `functionParameters` (expressionsem.d:4544) and `checkConstructorEscape` (escape.d:544).
 */
export function checkParamArgumentReturn(sc: Scope, firstArg: Expression, arg: Expression, param: Parameter,
                                         gag: boolean): boolean {
    // dropped: escape.d:478-480 — `enum log = false;` and its wrapped printf, a translation-time-false debug
    // switch (the same convention as the other entry points, listed in the header).

    // dmd/escape.d:483.
    if ((param.storageClass & STC.return_) === 0n)
        return false;

    // dmd/escape.d:486.
    if (!hasPointers(arg.type!) && !param.isReference())
        return false;

    // dmd/escape.d:489-494 — `byRef` needed for `assign(ref int* x, ref int i) {x = &i};`. Taking the
    // address of a scope pointer is not allowed (`assign(ref int** x, return ref scope int* i) {x = &i};`),
    // so there is no return ref / return scope ambiguity here. D's own fixme (:494): `returnScope` could be
    // inferred without `scope` via `vaIsFirstRef`.
    const byRef = param.isReference() && (param.storageClass & STC.scope_) === 0n
        && (param.storageClass & STC.returnScope) === 0n;

    // dmd/escape.d:496.
    const e = new AssignExp(arg.loc, firstArg, arg);
    return checkAssignEscape(sc, e, gag, byRef);
}

/**
 * dmd/escape.d:512 — `bool checkConstructorEscape(ref Scope sc, CallExp ce, bool gag)`.
 *
 * Check a struct constructor call of the form `s.this(args)` by checking each `return` parameter to see
 * whether it gets assigned to `s`. Params (D doc-comment, escape.d:504-507): `sc` determines the current
 * function and module, `ce` is the constructor call, `gag` suppresses the error messages. Returns `true` if
 * construction would cause an escaping reference error; stops at the first argument that does.
 *
 * Preconditions, each a D unguarded dereference kept with `!` at the site where D would fault: `ce.type`
 * is a struct type (asserted, escape.d:517), `ce.e1` is a `DotVarExp` whose `var` is a `CtorDeclaration`
 * with a `TypeFunction` type (escape.d:524-526), and `ce.arguments` is non-null. The one D caller,
 * expressionsem.d:12453, builds `ce` as exactly that shape (`cx.e1 = dvx`).
 */
export function checkConstructorEscape(sc: Scope, ce: CallExp, gag: boolean): boolean {
    // dropped: escape.d:514-515 — `enum log = false;` and its printf.

    // dmd/escape.d:516-517.
    const tthis: Type = toBasetype(ce.type!);
    assert(tthis.ty === TY.Tstruct);
    // dmd/escape.d:518.
    if (!hasPointers(tthis))
        return false;

    // dmd/escape.d:521 — D's condition is never true: a null `arguments` faults on the right operand, and a
    // non-null one fails the left. Kept verbatim; the `!` sits where D would fault.
    if (!ce.arguments_ && ce.arguments_!.length)
        return false;

    // dmd/escape.d:524-526.
    const dve: DotVarExp = ce.e1!.isDotVarExp()!;
    const ctor: CtorDeclaration = dve.var_.isCtorDeclaration()!;
    const tf: TypeFunction = ctor.type!.isTypeFunction()!;

    // dmd/escape.d:528-529.
    const nparams = tf.parameterList.length();
    const n = ce.arguments_!.length;

    // dmd/escape.d:532 — j=1 if _arguments[] is first argument. D's `bool` promotes to an integer in the
    // arithmetic below. That comment describes dmd: under IN_LLVM no `_arguments` is prepended
    // (expressionsem.d:4905 `if (!IN_LLVM && tf.isDstyleVariadic())`), yet `j` is still 1, so ldc2 never checks
    // argument 0 of a D-style variadic constructor and checks each later argument against the parameter
    // before its own. Kept as D has it; escape.test.ts pins ldc2's silence on that case.
    const j = tf.isDstyleVariadic() ? 1 : 0;

    // dmd/escape.d:536 — attempt to assign each `return` arg to the `this` reference.
    for (let i = 0; i < n; i++) {
        // dmd/escape.d:538.
        const arg: Expression = ce.arguments_!.opIndex(i)!;

        // dmd/escape.d:541 — D's `i - j` is `size_t` and wraps at i=0, j=1 where the TS difference is -1;
        // the `i >= j` conjunct is false there in both, so the verdict is the same.
        if (i - j < nparams && i >= j) {
            // dmd/escape.d:543-545.
            const p: Parameter = tf.parameterList.opIndex(i - j)!;
            if (checkParamArgumentReturn(sc, dve.e1!, arg, p, gag))
                return true;
        }
    }

    // dmd/escape.d:549.
    return false;
}

/**
 * dmd/escape.d:554 — `enum ReturnParamDest`. Where, instead of returning a `return` parameter via a
 * `return` statement, the lifetime is transferred to.
 */
export enum ReturnParamDest {
    returnVal, /// through return statement: `return x`
    this_,     /// assigned to a struct instance: `this.x = x`
    firstArg,  /// assigned to first argument: `firstArg = x`
}

/**
 * dmd/escape.d:576 — `ReturnParamDest returnParamDest(TypeFunction tf, Type tthis)`. Find out whether a
 * `return` parameter transfers the lifetime of its argument to the return value, to `this`, or to the
 * first argument.
 *
 * FULL faithful body (it is small). For the CallExp success path of a NON-`void`-returning free function
 * (`int f(int)`), `tf.nextOf()` is `int` (not `void`), so the second guard returns `ReturnParamDest.returnVal`
 * immediately — `firstArg` stays null in `functionParameters`. A `void`-returning free function (`void v(int)`)
 * with no `ref` first parameter also returns `returnVal` (the `tthis`/first-`ref`-param arms are not taken).
 *
 * Preconditions: `tf` is non-null (asserted in dmd). `tthis` is null for a free function.
 */
export function returnParamDest(tf: TypeFunction, tthis: Type | null): ReturnParamDest {
    // dmd/escape.d:579 — a constructor transfers to the constructed `this`.
    if (tf.isCtor)
        return ReturnParamDest.this_;

    // dmd/escape.d:582 — a non-`void` return type transfers through the return statement.
    const tn = nextOf(tf);
    if (!tn || tn.ty !== TY.Tvoid)
        return ReturnParamDest.returnVal;

    // dmd/escape.d:585 — a `void`-returning method on a struct `this` (passed by value) transfers to `this`.
    if (tthis && toBasetype(tthis).ty === TY.Tstruct)
        return ReturnParamDest.this_;

    // dmd/escape.d:588 — a `void`-returning free function with a `ref` first parameter transfers to it.
    const p0 = tf.parameterList.length() > 0 ? tf.parameterList.opIndex(0) : null;
    if (p0 && p0.isReference())
        return ReturnParamDest.firstArg;

    // dmd/escape.d:591 — otherwise (e.g. `void v(int)`): through the return statement.
    return ReturnParamDest.returnVal;
}

/**
 * dmd/escape.d:609 — `bool checkAssignEscape(ref Scope sc, Expression e, bool gag, bool byRef)`.
 *
 * Given an `AssignExp`, determine if the lvalue will cause the contents of the rvalue to escape.
 * Print error messages when these are detected. Infer `scope` attribute for the lvalue where possible,
 * in order to eliminate the error.
 *
 * Params:
 *   sc    = used to determine current function and module
 *   e     = `AssignExp` or `CatAssignExp` to check for any pointers to the stack
 *   gag   = do not print error messages
 *   byRef = set to `true` if `e1` of `e` gets assigned a reference to `e2`
 * Returns: `true` if pointers to the stack can escape via assignment.
 *
 * Cost model: walks `e2` once through `escapeExp` and may MUTATE `storage_class` / `maybeScope` /
 * `doNotInferReturn` on the variables it reaches (scope/return inference is a side effect, not a query).
 *
 * The four `onXxx` nested functions are D nested functions capturing `va`/`fd`/`vaIsRef`/`vaIsFirstRef`/
 * `result`/`e`/`e1`/`ae`/`sc`/`gag` by reference -> TS arrows (04 §5). `result` is the captured `bool`
 * they or-into; the closures are installed in `EscapeByResults` and called back from `escapeExp`.
 */
export function checkAssignEscape(sc: Scope, e: Expression, gag: boolean, byRef: boolean): boolean {
    // dmd/escape.d:613 — only the six assignment-shaped operators participate.
    if (e.op !== EXP.assign && e.op !== EXP.blit && e.op !== EXP.construct &&
        e.op !== EXP.concatenateAssign && e.op !== EXP.concatenateElemAssign && e.op !== EXP.concatenateDcharAssign)
        return false;

    // dmd/escape.d:616 — `auto ae = cast(BinExp)e;`. Tag-proved downcast (02 §11.5c(3), the "SET of
    // tags" form): the guard above admits exactly EXP.assign / blit / construct / concatenateAssign /
    // concatenateElemAssign / concatenateDcharAssign, and every one of those is a `BinExp` subclass, so
    // no single `isXxx()` expresses the target class.
    const ae = e as BinExp;
    const e1: Expression = ae.e1!;
    const e2: Expression = ae.e2!;

    // dmd/escape.d:621 — nothing to escape if the destination type carries no pointers.
    if (!hasPointers(e1.type!))
        return false;

    /* The struct literal case can arise from the S(e2) constructor call:
     *    return S(e2);
     * and appears in this function as:
     *    structLiteral = e2;
     * Such an assignment does not necessarily remove scope-ness.
     */
    // dmd/escape.d:631.
    if (e1.isStructLiteralExp() !== null)
        return false;

    // dmd/escape.d:634 — `int deref; VarDeclaration va = expToVariable(e1, deref);`. `out int deref`
    // -> a one-slot box, RESET by the callee on entry (03 §3.3).
    const derefBox: { value: number } = { value: 0 };
    let va: VarDeclaration | null = expToVariable(e1, derefBox);
    const deref = derefBox.value;
    // transitive scope not implemented, so can't assign scope pointers to a dereferenced variable
    if (deref > 0)
        va = null;

    // dmd/escape.d:640.
    if (e1.isSliceExp() !== null) {
        // slice-copy is not assigning a pointer, but copying array content
        if (va !== null) {
            if (toBasetype(va.type!).isTypeSArray() === null || // treat static array slice same as a variable
                !hasPointers(va.type!))
                return false;
        } else
            return false;
    }

    // dmd/escape.d:653.
    if (va !== null && e.op === EXP.concatenateElemAssign) {
        /* https://issues.dlang.org/show_bug.cgi?id=17842
         * Draw an equivalence between:
         *   *q = p;
         * and:
         *   va ~= e;
         * since we are not assigning to va, but are assigning indirectly through va.
         */
        va = null;
    }

    // dmd/escape.d:665.
    if (e.op === EXP.construct && va !== null && (va.storage_class & STC.temp) !== 0n && va._init !== null) {
        // Initializing a temporary is safe, `escapeExp` will forward such vars
        // to their `va._init` if needed.
        return false;
    }

    // dmd/escape.d:674.
    const fd: FuncDeclaration | null = sc.func;

    // Determine if va is a `ref` parameter, so it has a lifetime exceding the function scope
    // dmd/escape.d:677.
    const vaIsRef: boolean = va !== null && va.isParameter() && va.isReference();

    // Determine if va is the first parameter, through which other 'return' parameters
    // can be assigned.
    // dmd/escape.d:682.
    let vaIsFirstRef = false;
    if (fd !== null && fd.type !== null) {
        // dmd/escape.d:685 — `final switch (returnParamDest(...))`; the `default` arm carries the
        // `final switch` exhaustiveness contract (06 §3.2). The discriminant is bound to a local so the
        // mandatory `never` check has something to name — D evaluates the call once here too.
        const dest = returnParamDest(fd.type.isTypeFunction()!, fd.vthis !== null ? fd.vthis.type : null);
        switch (dest) {
            case ReturnParamDest.this_:
                vaIsFirstRef = va === fd.vthis;
                break;
            case ReturnParamDest.firstArg:
                // While you'd expect fd.parameters[0] to exist in this case, the compiler-generated
                // expression that initializes an `out int* p = null` is analyzed before fd.parameters
                // is created, so we still do a null and length check
                vaIsFirstRef = fd.parameters !== null && 0 < fd.parameters.length &&
                    fd.parameters.opIndex(0) === va;
                break;
            case ReturnParamDest.returnVal:
                break;
            default: {
                const _exhaustive: never = dest; void _exhaustive;   // static exhaustiveness check
                throw new SwitchError();   // D default message: "No appropriate switch clause found"
            }
        }
    }

    // dmd/escape.d:702.
    let result = false;

    // dmd/escape.d:703 — `void onValue(VarDeclaration v)`.
    const onValue = (v: VarDeclaration): void => {
        if (v === va)
            return;

        const p: Dsymbol | null = v.toParent2();

        // dmd/escape.d:712. `fd!`: `vaIsFirstRef` is only ever set inside the `fd !== null` block
        // above (escape.d:683), so a true `vaIsFirstRef` proves `fd` is non-null.
        if (vaIsFirstRef && p === fd) {
            inferReturn(fd!, v, /*returnScope:*/ true);
        }

        // dmd/escape.d:717.
        if (!(va !== null && va.isScope()) || vaIsRef)
            doNotInferScope(v, e);

        // dmd/escape.d:720.
        if (v.isScope()) {
            if (vaIsFirstRef && v.isParameter() && v.isReturn()) {
                // va=v, where v is `return scope`
                if (inferScope(va, e))
                    return;
            }

            // If va's lifetime encloses v's, then error
            // dmd/escape.d:730 — `if (EnclosedBy eb = va.enclosesLifetimeOf(v))`: declaration-in-
            // condition hoisted to a const, then tested (06 §2.6). `EnclosedBy.none == 0` is D's
            // falsey value here.
            const eb = enclosesLifetimeOf(va, v);
            if (eb !== EnclosedBy.none) {
                let msg: DString;
                // dmd/escape.d:733 — `final switch (eb)`, translated per 06 §3.2. D's
                // `case EnclosedBy.none: assert(0);` (escape.d:735) cannot be spelled as a `case`
                // label here: the guard above narrows `none` out of `eb`'s type, so tsc rejects the
                // label (TS2678). D's own `none` arm is unreachable for the same reason the guard
                // exists — `enclosesLifetimeOf` returned non-`none` — so the only value that can
                // reach the `default` is one outside the enum, which is exactly D's `SwitchError`.
                switch (eb) {
                    case EnclosedBy.returnScope:
                        msg = ds("assigning scope variable `%s` to return scope `%s`");
                        break;
                    case EnclosedBy.longerScope:
                        msg = ds("assigning scope variable `%s` to `%s` with longer lifetime");
                        break;
                    case EnclosedBy.refVar:
                        msg = ds("assigning scope variable `%s` to `ref` variable `%s` with longer lifetime");
                        break;
                    case EnclosedBy.global:
                        msg = ds("assigning scope variable `%s` to global variable `%s`");
                        break;
                    default: {
                        const _exhaustive: never = eb; void _exhaustive;   // static exhaustiveness check
                        throw new SwitchError();   // D default message: "No appropriate switch clause found"
                    }
                }

                // dmd/escape.d:750. `va!`: `enclosesLifetimeOf` returns `none` for a null `va`
                // (escape.d:2189), so a non-`none` result proves `va !== null`.
                if (setUnsafeDIP1000(sc, gag, ae.loc, msg, v, va!)) {
                    result = true;
                    return;
                }
            }

            // v = scope, va should be scope as well
            // dmd/escape.d:758.
            const vaWasScope = va !== null && va.isScope();
            if (inferScope(va, e)) {
                // In case of `scope local = returnScopeParam`, do not infer return scope for `x`
                // dmd/escape.d:762. `va!`: `inferScope` returns false for a null `va` (escape.d:1406).
                if (!vaWasScope && v.isReturn() && !va!.isReturn()) {
                    va!.storage_class = (va!.storage_class | STC.return_ | STC.returninferred) as STC;

                    // Added "return scope" so don't confuse it with "return ref"
                    if (isRefReturnScope(va!.storage_class))
                        va!.storage_class = (va!.storage_class | STC.returnScope) as STC;
                }
                return;
            }
            // dmd/escape.d:773 — `result |= …`: D's `|=` always evaluates its right operand, and this
            // callee emits diagnostics, so the call is sequenced BEFORE the or (06 §2.5).
            const nonScopeErr = setUnsafeDIP1000(sc, gag, ae.loc,
                ds("assigning scope variable `%s` to non-scope `%s`"), v, e1);
            result = result || nonScopeErr;
        } else {
            /* v is not 'scope', and we didn't check the scope of where we assigned it to.
             * It may escape via that assignment, therefore, v can never be 'scope'.
             */
            // dmd/escape.d:781 — `if (!v.isParameter)`: D property-call syntax on a method (04 §9).
            if (!v.isParameter())
                doNotInferScope(v, e);
        }
    };

    // dmd/escape.d:786 — `void onRef(VarDeclaration v, bool retRefTransition)`. `retRefTransition` is
    // unused in this body (it is read only by the `checkReturnEscape` family), hence the `_` prefix.
    const onRef = (v: VarDeclaration, _retRefTransition: boolean): void => {
        // dmd/escape.d:790.
        if (checkScopeVarAddr(v, ae, sc, gag)) {
            result = true;
            return;
        }

        // dmd/escape.d:796.
        if (va !== null && va.isScope() && !v.isReference()) {
            if (!va.isReturn()) {
                va.doNotInferReturn = true;
            } else {
                const retScopeErr = setUnsafeDIP1000(sc, gag, ae.loc,
                    ds("assigning address of local variable `%s` to return scope `%s`"), v, va);
                result = result || retScopeErr;
            }
        }

        // dmd/escape.d:809.
        const p: Dsymbol | null = v.toParent2();

        // dmd/escape.d:811. `fd!`: same proof as in `onValue` — `vaIsFirstRef` implies `fd !== null`.
        if (vaIsFirstRef && p === fd) {
            inferReturn(fd!, v, /*returnScope:*/ false);
        }

        // If va's lifetime encloses v's, then error
        // dmd/escape.d:818 — truthiness of the `EnclosedBy` enum (06 §2.5): `none` is the falsey value.
        if (va !== null && !(vaIsFirstRef && v.isReturn()) && enclosesLifetimeOf(va, v) !== EnclosedBy.none) {
            if (setUnsafeDIP1000(sc, gag, ae.loc,
                ds("assigning address of variable `%s` to `%s` with longer lifetime"), v, va)) {
                result = true;
                return;
            }
        }

        // dmd/escape.d:827.
        if (!(va !== null && va.isScope()))
            doNotInferScope(v, e);

        if (p !== sc.func)
            return;

        // dmd/escape.d:833.
        if (inferScope(va, e)) {
            // `va!`: `inferScope` returns false for a null `va` (escape.d:1406).
            if (v.isReturn() && !va!.isReturn())
                va!.storage_class = (va!.storage_class | STC.return_ | STC.returninferred) as STC;
            return;
        }

        // dmd/escape.d:840.
        const nonScopeRefErr = setUnsafeDIP1000(sc, gag, ae.loc,
            ds("assigning reference to local variable `%s` to non-scope `%s`"), v, e1);
        result = result || nonScopeRefErr;
    };

    // dmd/escape.d:843 — `void onFunc(FuncDeclaration func, bool called)`. `called` is unused here.
    const onFunc = (func: FuncDeclaration, _called: boolean): void => {
        // dmd/escape.d:846 — `VarDeclarations vars;` is a stack-local Array VALUE; `&vars` is the
        // by-reference out-parameter of `findAllOuterAccessedVariables` (03 §3.2).
        const vars: VarDeclarations = new DArray<VarDeclaration | null>();
        findAllOuterAccessedVariables(func, vars);

        /* https://issues.dlang.org/show_bug.cgi?id=16037
         * If assigning the address of a delegate to a scope variable,
         * then uncount that address of. This is so it won't cause a
         * closure to be allocated.
         */
        // dmd/escape.d:854 — `func.tookAddressOf` is an `int` counter -> `!== 0` (09 §9).
        if (va !== null && va.isScope() && !va.isReturn() && func.tookAddressOf !== 0)
            --func.tookAddressOf;

        // dmd/escape.d:857.
        for (const vElem of vars) {
            const v = vElem!;
            assert(!v.isDataseg()); // these are not put in the closureVars[]

            const p: Dsymbol | null = v.toParent2();

            if (!(va !== null && va.isScope()))
                doNotInferScope(v, e);

            // dmd/escape.d:867 — D's `return` here leaves onFunc, not just the loop.
            if (!(v.isReference() || v.isScope()) || p !== fd)
                return;

            // dmd/escape.d:870.
            if (va !== null && !va.isDataseg() && (va.isScope() || va.maybeScope)) {
                /* Don't infer STC.scope_ for va, because then a closure
                 * won't be generated for fd.
                 */
                //if (!va.isScope())
                    //va.storage_class |= STC.scope_ | STC.scopeinferred;
                return;
            }
            const nestedErr = setUnsafeDIP1000(sc, gag, ae.loc,
                ds("assigning reference to local `%s` to non-scope `%s`"), v, e1);
            result = result || nestedErr;
        }
    };

    // dmd/escape.d:884 — `void onExp(Expression ee, bool retRefTransition)`. `retRefTransition` unused.
    const onExp = (ee: Expression, _retRefTransition: boolean): void => {
        /* Do not allow slicing of a static array returned by a function
         */
        // dmd/escape.d:890.
        if (ee.op === EXP.call && toBasetype(ee.type!).isTypeSArray() !== null &&
            toBasetype(e1.type!).isTypeDArray() !== null) {
            if (!gag)
                sc.eSink!.deprecation(ee.loc,
                    ds("slice of static array temporary returned by `%s` assigned to longer lived variable `%s`"),
                    ee.toChars(), e1.toChars());
            //result = true;
            return;
        }

        // dmd/escape.d:899 — the double space after the first `%s` is verbatim from dmd (10 §3).
        const msg: DString = (ee.op === EXP.structLiteral)
            ? ds("assigning address of struct literal `%s`  to `%s` with longer lifetime")
            : ds("assigning address of expression temporary returned by `%s` to `%s` with longer lifetime");

        const expErr = setUnsafeDIP1000(sc, gag, ee.loc, msg, ee, e1);
        result = result || expErr;
    };

    // dmd/escape.d:906 — `scope EscapeByResults er = EscapeByResults(&onRef, &onValue, &onFunc, &onExp);`
    // (positional struct literal, D field order byRef/byValue/byFunc/byExp).
    const er = new EscapeByResults(onRef, onValue, onFunc, onExp);

    // dmd/escape.d:908.
    if (byRef)
        escapeByRef(e2, er);
    else
        escapeByValue(e2, er);

    return result;
}

/**
 * dmd/escape.d:928 — `bool checkThrowEscape(ref Scope sc, Expression e, bool gag)`.
 *
 * Detect cases where pointers to the stack can escape the lifetime of the stack frame when throwing
 * `e`. Print error messages when these are detected.
 *
 * Params: `sc` = used to determine current function and module, `e` = expression to check for any
 * pointers to the stack, `gag` = do not print error messages.
 * Returns: `true` if pointers to the stack can escape.
 *
 * Cost model: one `escapeByValue` walk of `e`; MUTATES `maybeScope` on the variables it reaches
 * (`doNotInferScope`), so it is a side-effecting check, not a query.
 *
 * Three of the four `EscapeByResults` callbacks are EMPTY in D (escape.d:933/:949/:950) — throwing is
 * by value only. They are ported as empty arrows, not dropped: `EscapeByResults` requires all four and
 * `escapeExp` calls them unconditionally.
 */
export function checkThrowEscape(sc: Scope, e: Expression, gag: boolean): boolean {
    // dmd/escape.d:932.
    let result = false;

    // dmd/escape.d:933 — `void onRef(VarDeclaration v, bool retRefTransition) {}`.
    const onRef = (_v: VarDeclaration, _retRefTransition: boolean): void => {};

    // dmd/escape.d:934 — `void onValue(VarDeclaration v)`.
    const onValue = (v: VarDeclaration): void => {
        // dmd/escape.d:937 — special case: allow a catch var to be rethrown despite being `scope`.
        if (v.isScope() && !v.iscatchvar) {
            // https://issues.dlang.org/show_bug.cgi?id=17029
            // dmd/escape.d:941 — `result |= …`: D's `|=` always evaluates its right operand, and this
            // callee emits diagnostics, so the call is sequenced BEFORE the or (06 §2.5).
            const throwErr = setUnsafeDIP1000(sc, gag, e.loc, ds("throwing scope variable `%s`"), v);
            result = result || throwErr;
            return;
        } else {
            // dmd/escape.d:946 — the `ThrowExp` is built purely as the inference REASON recorded in
            // `EscapeState.scopeInferReason`; it is never inserted into the AST.
            doNotInferScope(v, new ThrowExp(e.loc, e));
        }
    };

    // dmd/escape.d:949 — `void onFunc(FuncDeclaration fd, bool called) {}`.
    const onFunc = (_fd: FuncDeclaration, _called: boolean): void => {};
    // dmd/escape.d:950 — `void onExp(Expression exp, bool retRefTransition) {}`.
    const onExp = (_exp: Expression, _retRefTransition: boolean): void => {};

    // dmd/escape.d:952 — positional struct literal, D field order byRef/byValue/byFunc/byExp.
    const er = new EscapeByResults(onRef, onValue, onFunc, onExp);
    // dmd/escape.d:953.
    escapeByValue(e, er);
    return result;
}

/**
 * dmd/escape.d:969 — `bool checkNewEscape(ref Scope sc, Expression e, bool gag)`.
 *
 * Detect cases where pointers to the stack can escape the lifetime of the stack frame by being placed
 * into a GC-allocated object. Print error messages when these are detected.
 *
 * Params: `sc` = used to determine current function and module, `e` = expression to check for any
 * pointers to the stack, `gag` = do not print error messages.
 * Returns: `true` if pointers to the stack can escape.
 *
 * Cost model: one `escapeByValue` walk of `e`; MUTATES `maybeScope` via `doNotInferScope`.
 *
 * dropped: escape.d:971/:972 (`import dmd.globals: FeatureState; import dmd.errors: previewErrorFunc;`
 * — function-local imports, expressed by this module's own import clause) and escape.d:975/:976,
 * :981, :1013, :1080 (`enum log = false;` plus every `if (log) printf(...)`, a translation-time-false
 * debug switch — 07 "resolved" convention; the printf machinery has no port).
 */
export function checkNewEscape(sc: Scope, e: Expression, gag: boolean): boolean {
    // dmd/escape.d:978.
    let result = false;

    // dmd/escape.d:979 — `void onValue(VarDeclaration v)`.
    const onValue = (v: VarDeclaration): void => {
        // dmd/escape.d:983 — `p` is dereferenced at :997 with no null check; the precondition travels
        // with `!` (`toParent2()` is null only for a module-level symbol, which no `escapeByValue`
        // result is).
        const p: Dsymbol | null = v.toParent2();

        // dmd/escape.d:985.
        if (v.isScope()) {
            /* This case comes up when the ReturnStatement of a __foreachbody is
             * checked for escapes by the caller of __foreachbody. Skip it.
             *
             * struct S { static int opApply(int delegate(S*) dg); }
             * S* foo() {
             *    foreach (S* s; S) // create __foreachbody for body of foreach
             *        return s;     // s is inferred as 'scope' but incorrectly tested in foo()
             *    return null; }
             */
            // dmd/escape.d:997.
            if (!(p!.parent === sc.func)) {
                // https://issues.dlang.org/show_bug.cgi?id=20868
                // dmd/escape.d:1000 — `result |= …`, sequenced before the or (06 §2.5).
                const copyErr = setUnsafeDIP1000(sc, gag, e.loc,
                    ds("copying scope variable `%s` into allocated memory"), v);
                result = result || copyErr;
                return;
            }
        } else {
            // dmd/escape.d:1007.
            doNotInferScope(v, e);
        }
    };

    // dmd/escape.d:1011 — `void onRef(VarDeclaration v, bool retRefTransition)`. `retRefTransition` is
    // unused in this body (only the `checkReturnEscape` family reads it), hence the `_` prefix.
    const onRef = (v: VarDeclaration, _retRefTransition: boolean): void => {
        // 'featureState' tells us whether to emit an error or a deprecation,
        // depending on the flag passed to the CLI for DIP25 / DIP1000
        // dmd/escape.d:1017 — D nested function `bool escapingRef(VarDeclaration v, FeatureState fs)`,
        // capturing `sc`/`gag`/`e` -> a TS arrow (04 §5). Its parameter `v` SHADOWS the enclosing `v`,
        // exactly as in D; the name is kept verbatim (01 §2).
        const escapingRef = (v: VarDeclaration, fs: FeatureState): boolean => {
            const msg: DString = v.isParameter()
                ? ds("escaping a reference to parameter `%s` by copying `%s` into allocated memory")
                : ds("escaping a reference to local variable `%s` by copying `%s` into allocated memory");
            // dmd/escape.d:1022 — `setUnsafePreview(&sc, ...)`: D takes the address of the `ref Scope`
            // parameter; `Scope` is a class in the port, so the reference is passed directly.
            return setUnsafePreview(sc, fs, gag, e.loc, msg, v, e);
        };

        // dmd/escape.d:1025.
        const p: Dsymbol | null = v.toParent2();

        // dmd/escape.d:1027.
        if (!v.isReference()) {
            if (p === sc.func) {
                const localErr = escapingRef(v, sc.useDIP1000());
                result = result || localErr;
                return;
            }
        }

        /* Check for returning a ref variable by 'ref', but should be 'return ref'
         * Infer the addition of 'return', or set result to be the offending expression.
         */
        // dmd/escape.d:1039.
        if (!v.isReference())
            return;

        // https://dlang.org/spec/function.html#return-ref-parameters
        // dmd/escape.d:1043.
        if (p === sc.func) {
            const refErr = escapingRef(v, sc.useDIP25());
            result = result || refErr;
            return;
        }
        // Don't need to be concerned if v's parent does not return a ref
        // dmd/escape.d:1051.
        const func: FuncDeclaration | null = p!.isFuncDeclaration();
        if (!func || !func.type)
            return;
        // dmd/escape.d:1054 — `if (auto tf = func.type.isTypeFunction())` (06 §2.6 hoist).
        const tf = func.type.isTypeFunction();
        if (tf !== null) {
            if (!tf.isRef)
                return;

            // dmd/escape.d:1059.
            const msg = ds("storing reference to outer local variable `%s` into allocated memory causes it to escape");
            if (!gag) {
                previewErrorFunc(sc.isDeprecated(), sc.useDIP25())(e.loc, msg, v.toChars());
            }

            // If -preview=dip25 is used, the user wants an error
            // Otherwise, issue a deprecation
            // dmd/escape.d:1067 — `result |= (sc.useDIP25 == FeatureState.enabled)`; the right operand
            // is a pure query, so the plain `||` is faithful here (06 §2.5).
            result = result || (sc.useDIP25() === FeatureState.enabled);
        }
    };

    // dmd/escape.d:1071 — `void onFunc(FuncDeclaration fd, bool called)`.
    const onFunc = (fd: FuncDeclaration, called: boolean): void => {
        // dmd/escape.d:1073.
        if (called) {
            const nestedErr = setUnsafeDIP1000(sc, gag, e.loc,
                ds("escaping a `scope` value returned from nested function `%s` into allocated memory"), fd);
            result = result || nestedErr;
        }
    };

    // dmd/escape.d:1078 — `void onExp(Expression ee, bool retRefTransition)`. `retRefTransition` unused.
    const onExp = (ee: Expression, _retRefTransition: boolean): void => {
        // dmd/escape.d:1081.
        if (!gag)
            sc.eSink!.error(ee.loc,
                ds("escaping reference to stack allocated value returned by `%s` into allocated memory"),
                ee.toChars());
        result = true;
    };

    // dmd/escape.d:1087.
    const er = new EscapeByResults(onRef, onValue, onFunc, onExp);
    // dmd/escape.d:1088.
    escapeByValue(e, er);

    return result;
}

/**
 * dmd/escape.d:1106 — `bool checkReturnEscape(ref Scope sc, Expression e, bool gag)`.
 *
 * Detect cases where pointers to the stack can escape the lifetime of the stack frame by returning `e`
 * BY VALUE. Print error messages when these are detected.
 *
 * Params: `sc` = used to determine current function and module, `e` = expression to check for any
 * pointers to the stack, `gag` = do not print error messages.
 * Returns: `true` if pointers to the stack can escape.
 */
export function checkReturnEscape(sc: Scope, e: Expression, gag: boolean): boolean {
    // dmd/escape.d:1109.
    return checkReturnEscapeImpl(sc, e, false, gag);
}

/**
 * dmd/escape.d:1124 — `bool checkReturnEscapeRef(ref Scope sc, Expression e, bool gag)`.
 *
 * Detect cases where returning `e` BY `ref` can result in a reference to the stack being returned.
 * Print error messages when these are detected.
 *
 * Params: `sc` = used to determine current function and module, `e` = expression to check,
 * `gag` = do not print error messages.
 * Returns: `true` if references to the stack can escape.
 *
 * dropped: escape.d:1126-1131 — a `version (none)` printf block, resolved OFF at translation time
 * (07 / `_config.md`); the printf machinery has no port.
 */
export function checkReturnEscapeRef(sc: Scope, e: Expression, gag: boolean): boolean {
    // dmd/escape.d:1133.
    return checkReturnEscapeImpl(sc, e, true, gag);
}

/**
 * dmd/escape.d:1146 — `private bool checkReturnEscapeImpl(ref Scope sc, Expression e, bool refs,
 * bool gag)`. Implementation of checking for escapes in return expressions.
 *
 * Params: `sc` = used to determine current function and module, `e` = expression to check,
 * `refs` = D's own doc-comment says "`true`: escape by value, `false`: escape by `ref`" and is WRONG —
 * the code at escape.d:1387 walks `escapeByRef` when `refs` is true. The parameter means "the return
 * is by `ref`"; `checkReturnEscapeRef` passes true (escape.d:1133), `checkReturnEscape` false (:1109).
 * The doc text is carried as D wrote it above and corrected here so no future reader inverts the flag.
 * `gag` = do not print error messages.
 * Returns: `true` if references to the stack can escape.
 *
 * `refs` is D's own flag-parameter shape (the two public entry points above are the two functions it
 * stands for); it is kept because the port mirrors D's structure (00 §1 Step 2), not because the design
 * is preferred.
 *
 * dropped: escape.d:1148/:1149, :1154, :1239-1242, :1370 (`enum log = false;` plus every
 * `if (log) printf(...)` — translation-time-false debug switch, 07; this also drops the sole use of
 * `ScopeRefToChars`, escape.d:1241).
 */
function checkReturnEscapeImpl(sc: Scope, e: Expression, refs: boolean, gag: boolean): boolean {
    // dmd/escape.d:1151.
    let result = false;

    // dmd/escape.d:1152 — `void onValue(VarDeclaration v)`.
    const onValue = (v: VarDeclaration): void => {
        // dmd/escape.d:1156.
        const vsr: ScopeRef = buildScopeRef(v.storage_class);

        // dmd/escape.d:1158 — dereferenced at :1181/:1192 with no null check; precondition via `!`.
        const p: Dsymbol | null = v.toParent2();

        // dmd/escape.d:1160. `sc.func!`: D dereferences `sc.func` throughout this body (:1200, :1201,
        // :1232) with no null check — the precondition is the caller's (both entry points are reached
        // only from inside a function body).
        if (p === sc.func && inferReturn(sc.func!, v, /*returnScope:*/ true)) {
            return;
        }

        // dmd/escape.d:1165 — `v.isTypesafeVariadicArray` is D property-call syntax on the UFCS free
        // function at escape.d:2269 (04 §6/§9).
        if (isTypesafeVariadicArray(v) && p === sc.func) {
            if (!gag)
                sc.eSink!.error(e.loc, ds("returning `%s` escapes a reference to variadic parameter `%s`"),
                    e.toChars(), v.toChars());
            // dmd/escape.d:1169 — `result = false`, NOT `true`: D clears the flag here deliberately
            // (the diagnostic is emitted but the caller is told nothing escaped). Carried verbatim.
            result = false;
        } else if (v.isScope()) {
            /* If `return scope` applies to v.
             */
            // dmd/escape.d:1175.
            if (vsr === ScopeRef.ReturnScope || vsr === ScopeRef.Ref_ReturnScope) {
                return;
            }

            // dmd/escape.d:1181.
            const pfunc = p!.isFuncDeclaration();
            /* This case comes up when the ReturnStatement of a __foreachbody is
             * checked for escapes by the caller of __foreachbody. Skip it.
             *
             * struct S { static int opApply(int delegate(S*) dg); }
             * S* foo() {
             *    foreach (S* s; S) // create __foreachbody for body of foreach
             *        return s;     // s is inferred as 'scope' but incorrectly tested in foo()
             *    return null; }
             */
            // dmd/escape.d:1182-1193 — `pfunc.fes` is a `ForeachStatement*` tested for truthiness.
            if (pfunc !== null && !(!refs && p!.parent === sc.func && pfunc.fes !== null)) {
                /*
                 *  auto p(scope string s) {
                 *      string scfunc() { return s; }
                 *  }
                 */
                // dmd/escape.d:1200 — `sc.func.isFuncDeclaration().getLevel(pfunc, sc.intypeof)` is D
                // property/UFCS syntax on the free function at funcsem.d:3361 (04 §6/§9).
                // `sc.func!.vthis!`: D passes it into `inferReturn`, which dereferences it at
                // escape.d:1431 with no null check — the precondition travels with `!`, and a null
                // there fails as loudly here as it would in D.
                if (getLevel(sc.func!.isFuncDeclaration()!, pfunc, sc.intypeof) > 0 &&
                    inferReturn(sc.func!, sc.func!.vthis!, /*returnScope*/ !refs)) {
                    return;
                }

                // dmd/escape.d:1206.
                if (v.isParameter() && !v.isReturn()) {
                    // https://issues.dlang.org/show_bug.cgi?id=23191
                    if (!gag) {
                        previewErrorFunc(sc.isDeprecated(), sc.useDIP1000())(e.loc,
                            ds("scope parameter `%s` may not be returned"), v.toChars());
                        result = true;
                        return;
                    }
                } else {
                    // https://issues.dlang.org/show_bug.cgi?id=17029
                    // dmd/escape.d:1221.
                    if (setUnsafeDIP1000(sc, gag, e.loc, ds("returning scope variable `%s`"), v)) {
                        printScopeReason(previewSupplementalFunc(sc.isDeprecated(), sc.useDIP1000()), v, 10, true);
                        result = true;
                        return;
                    }
                }
            }
        } else if (p === sc.func || !v.isParameter()) {
            // dmd/escape.d:1233.
            doNotInferScope(v, e);
        }
    };

    // dmd/escape.d:1237 — `void onRef(VarDeclaration v, bool retRefTransition)`.
    const onRef = (v: VarDeclaration, retRefTransition: boolean): void => {
        // 'featureState' tells us whether to emit an error or a deprecation,
        // depending on the flag passed to the CLI for DIP25
        // dmd/escape.d:1246 — D nested function `void escapingRef(VarDeclaration v,
        // FeatureState featureState)`, capturing `sc`/`gag`/`e`/`result`/`retRefTransition` -> a TS
        // arrow (04 §5). Its parameter `v` SHADOWS the enclosing `v`, exactly as in D.
        const escapingRef = (v: VarDeclaration, featureState: FeatureState): void => {
            // dmd/escape.d:1248 — the trailing space inside the second literal is verbatim from dmd
            // (10 §3): "... by returning `%s` " really does end with a space.
            const safeMsg: DString = v.isParameter()
                ? ds("escaping a reference to parameter `%s` by returning `%s`")
                : ds("escaping a reference to local variable `%s` by returning `%s` ");
            // dmd/escape.d:1251.
            if (v.isParameter() && v.isReference()) {
                // dmd/escape.d:1253-1254 — `setUnsafePreview(&sc, featureState, gag, e.loc, safeMsg, v, e)
                // || sc.func.isSafeBypassingInference()` (callee: dmd/safe.d:348).
                if (setUnsafePreview(sc, featureState, gag, e.loc, safeMsg, v, e) ||
                    isSafeBypassingInference(sc.func!)) {
                    result = true;
                    // dmd/escape.d:1257.
                    if ((v.storage_class & STC.returnScope) !== 0n) {
                        previewSupplementalFunc(sc.isDeprecated(), featureState)(v.loc,
                            ds("perhaps change the `return scope` into `scope return`"));
                    } else {
                        // dmd/escape.d:1264.
                        const annotateKind: DString = (v.ident === Id.This) ? ds("function") : ds("parameter");
                        previewSupplementalFunc(sc.isDeprecated(), featureState)(v.loc,
                            ds("perhaps annotate the %s with `return`"), annotateKind);
                    }
                }
            } else {
                // dmd/escape.d:1272.
                if (retRefTransition) {
                    const retRefErr = setUnsafeDIP1000(sc, gag, e.loc, safeMsg, v, e);
                    result = result || retRefErr;
                } else {
                    // dmd/escape.d:1278.
                    const msg: DString = v.isParameter()
                        ? ds("returning `%s` escapes a reference to parameter `%s`")
                        : ds("returning `%s` escapes a reference to local variable `%s`");
                    if (!gag)
                        previewErrorFunc(sc.isDeprecated(), featureState)(e.loc, msg, e.toChars(), v.toChars());
                    result = true;
                }
            }
        };

        // dmd/escape.d:1288.
        const vsr: ScopeRef = buildScopeRef(v.storage_class);

        // dmd/escape.d:1290.
        const p: Dsymbol | null = v.toParent2();

        // https://issues.dlang.org/show_bug.cgi?id=19965
        // dmd/escape.d:1293.
        if (!refs && checkScopeVarAddr(v, e, sc, gag)) {
            result = true;
            return;
        }

        // dmd/escape.d:1299.
        if (!v.isReference()) {
            if (p === sc.func) {
                escapingRef(v, FeatureState.enabled);
                return;
            }
            const fd: FuncDeclaration | null = p!.isFuncDeclaration();
            if (fd !== null && sc.func!.scopeInprocess) {
                /* Code like:
                 *   int x;
                 *   auto dg = () { return &x; }
                 * Making it:
                 *   auto dg = () return { return &x; }
                 * Because dg.ptr points to x, this is returning dt.ptr+offset
                 */
                // dmd/escape.d:1316.
                sc.func!.storage_class = (sc.func!.storage_class | STC.return_ | STC.returninferred) as STC;
            }
        }

        /* Check for returning a ref variable by 'ref', but should be 'return ref'
         * Infer the addition of 'return', or set result to be the offending expression.
         */
        // dmd/escape.d:1323.
        if (vsr === ScopeRef.Ref || vsr === ScopeRef.RefScope || vsr === ScopeRef.Ref_ReturnScope) {
            // dmd/escape.d:1327.
            if (p === sc.func && (vsr === ScopeRef.Ref || vsr === ScopeRef.RefScope) &&
                inferReturn(sc.func!, v, /*returnScope:*/ false)) {
                return;
            } else {
                // https://dlang.org/spec/function.html#return-ref-parameters
                // Only look for errors if in module listed on command line
                // dmd/escape.d:1336.
                if (p === sc.func) {
                    escapingRef(v, sc.useDIP25());
                    return;
                }
                // Don't need to be concerned if v's parent does not return a ref
                // dmd/escape.d:1344.
                const fd: FuncDeclaration | null = p!.isFuncDeclaration();
                if (fd !== null && fd.type !== null && fd.type.ty === TY.Tfunction) {
                    const tf: TypeFunction = fd.type.isTypeFunction()!;
                    if (tf.isRef) {
                        const msg = ds("escaping reference to outer local variable `%s`");
                        if (!gag)
                            previewErrorFunc(sc.isDeprecated(), sc.useDIP25())(e.loc, msg, v.toChars());
                        result = true;
                        return;
                    }
                }
            }
        }
    };

    // dmd/escape.d:1362 — `void onFunc(FuncDeclaration fd, bool called)`.
    const onFunc = (fd: FuncDeclaration, called: boolean): void => {
        // dmd/escape.d:1364.
        if (called && fd.isNested()) {
            const nestedErr = setUnsafeDIP1000(sc, gag, e.loc,
                ds("escaping local variable through nested function `%s`"), fd);
            result = result || nestedErr;
        }
    };

    // dmd/escape.d:1368 — `void onExp(Expression ee, bool retRefTransition)`.
    const onExp = (ee: Expression, retRefTransition: boolean): void => {
        // dmd/escape.d:1371.
        if (retRefTransition) {
            const expErr = setUnsafeDIP1000(sc, gag, ee.loc,
                ds("escaping reference to stack allocated value returned by `%s`"), ee);
            result = result || expErr;
        } else {
            // dmd/escape.d:1378 — the SAME message text as the `retRefTransition` arm above; only the
            // reporting channel differs (gagged preview check vs. a hard eSink error).
            if (!gag)
                sc.eSink!.error(ee.loc, ds("escaping reference to stack allocated value returned by `%s`"),
                    ee.toChars());
            result = true;
        }
    };

    // dmd/escape.d:1385.
    const er = new EscapeByResults(onRef, onValue, onFunc, onExp);

    // dmd/escape.d:1387 — `refs` selects the walk: by `ref` return -> `escapeByRef`.
    if (refs)
        escapeByRef(e, er);
    else
        escapeByValue(e, er);

    return result;
}

/**
 * dmd/escape.d:1404 — `private bool inferScope(VarDeclaration va, RootObject reason)`.
 *
 * Infer `scope` for a variable.
 * Params:
 *   va     = variable to infer scope for (may be null — every caller passes a possibly-null `va`)
 *   reason = optional Expression that causes `va` to infer scope, used for supplemental error message
 * Returns: `true` if successful or already `scope`.
 */
function inferScope(va: VarDeclaration | null, reason: RootObject | null): boolean {
    // dmd/escape.d:1406.
    if (va === null)
        return false;
    if (!va.isDataseg() && va.maybeScope && !va.isScope()) {
        if (reason !== null)
            EscapeState.scopeInferReason.set(va, reason);
        va.maybeScope = false;
        va.storage_class = (va.storage_class | STC.scope_ | STC.scopeinferred) as STC;
        return true;
    }
    return va.isScope();
}

/**
 * dmd/escape.d:1429 — `private bool inferReturn(FuncDeclaration fd, VarDeclaration v, bool returnScope)`.
 *
 * Variable `v` needs to have 'return' inferred for it.
 * Params:
 *   fd          = function that v is a parameter to
 *   v           = parameter that needs to be STC.return_
 *   returnScope = infer `return scope` instead of `return ref`
 * Returns: whether the inference on `v` was successful, or `v` already was `return`.
 */
function inferReturn(fd: FuncDeclaration, v: VarDeclaration, returnScope: boolean): boolean {
    // dmd/escape.d:1431.
    if (v.isReturn())
        return ((v.storage_class & STC.returnScope) !== 0n) === returnScope;

    // dmd/escape.d:1434 — `v.isTypesafeVariadicArray` is D property-call syntax on the UFCS free
    // function at escape.d:2269 (04 §6/§9).
    if (!v.isParameter() || isTypesafeVariadicArray(v) || (returnScope && v.doNotInferReturn))
        return false;

    if (!fd.scopeInprocess)
        return false;

    if (returnScope && !(v.isScope() || v.maybeScope))
        return false;

    // dmd/escape.d:1444.
    const newStcs: STC = (STC.return_ | STC.returninferred | (returnScope ? STC.returnScope : STC.none)) as STC;
    v.storage_class = (v.storage_class | newStcs) as STC;

    if (v === fd.vthis) {
        /* v is the 'this' reference, so mark the function
         */
        fd.storage_class = (fd.storage_class | newStcs) as STC;
        // dmd/escape.d:1452 — `if (auto tf = fd.type.isTypeFunction())` (06 §2.6 hoist).
        const tf = fd.type!.isTypeFunction();
        if (tf !== null) {
            tf.isReturnScope = returnScope;
            tf.isReturn = true;
            tf.isReturnInferred = true;
        }
    } else {
        // Perform 'return' inference on parameter
        // dmd/escape.d:1463.
        const tf = fd.type!.isTypeFunction();
        if (tf !== null) {
            // D `foreach (i, p; tf.parameterList)` -> `opApply` with D's control-code protocol
            // (05 §11): the callback returns 0 to continue, non-zero to `break`.
            tf.parameterList.opApply((_i: number, p: Parameter): number => {
                if (p.ident === v.ident) {
                    p.storageClass = (p.storageClass | newStcs) as STC;
                    return 1; // D `break` — there can be only one
                }
                return 0;
            });
        }
    }
    return true;
}

/**
 * dmd/escape.d:1497 — `public void escapeByValue(Expression e, ref scope EscapeByResults er)`.
 *
 * `e` is an expression to be returned by value, and that value contains pointers. Walk `e` to determine
 * which variables are possibly being returned by value, such as `int* function(int* p) { return p; }`.
 * If `e` is a form of `&p`, determine which variables have content which is being returned as ref, such
 * as `int* function(int i) { return &i; }`.
 *
 * No side effects (on the expression; `er`'s callbacks may have their own).
 */
export function escapeByValue(e: Expression, er: EscapeByResults): void {
    escapeExp(e, er, 0);
}

/**
 * dmd/escape.d:1508 — `void escapeExp(Expression e, ref scope EscapeByResults er, int deref)`.
 *
 * Unified implementation of `escapeByValue` and `escapeByRef`.
 * `deref` = dereference level: if `p` has deref 0, then `*p` has deref 1, `&p` has -1, `**p` has 2, etc.
 * For `escapeByValue`, deref = 0. For `escapeByRef`, deref = -1.
 * Currently, `scope` is not transitive, so deref > 0 means no escaping, but `@live` does do transitive
 * checking, and future enhancements might add some form of transitive scope.
 *
 * The `visitXxx` nested functions are D nested functions capturing `er` and `deref` -> TS arrows
 * (04 §5); the trailing `switch (e.op)` is D's own dispatch, reproduced verbatim (13 §7.5 Idiom B).
 * `deref` is a small dereference count, so it stays in the `number` domain (09 §1).
 */
function escapeExp(e: Expression, er: EscapeByResults, deref: number): void {
    // dmd/escape.d:1512 — `void visit(Expression e) {}`, the empty default arm.
    const visit = (_e: Expression): void => {
    };

    // dmd/escape.d:1516.
    const visitAddr = (e: AddrExp): void => {
        /* Taking the address of struct literal is normally not
         * allowed, but CTFE can generate one out of a new expression,
         * but it'll be placed in static data so no need to check it.
         */
        if (deref === 0 && e.e1!.op !== EXP.structLiteral)
            escapeExp(e.e1!, er, deref - 1);
    };

    // dmd/escape.d:1526.
    const visitSymOff = (e: SymOffExp): void => {
        const v = e.var_.isVarDeclaration();
        if (v !== null)
            er.varDeref(v, deref - 1);
    };

    // dmd/escape.d:1532.
    const visitVar = (e: VarExp): void => {
        const v = e.var_.isVarDeclaration();
        if (v !== null) {
            // dmd/escape.d:1536 — `&` binds tighter than `&&` in D, so the STC mask is the second
            // operand of the `&&`; the ulong result is then a boolean truthiness test (09 §9).
            const refAddr = deref < 0 && (v.storage_class & STC.ref_) !== 0n;
            const tempVar = deref === 0 && (v.storage_class & STC.temp) !== 0n;
            if ((refAddr || tempVar) && v._init !== null && v !== er.lastTemp) {
                // If compiler generated ref temporary
                //   (ref v = ex; ex)
                // e.g. to extract side effects of `Tuple!(int, int).modify().expand[0]`
                // look at the initializer instead
                // dmd/escape.d:1544 — `if (ExpInitializer ez = v._init.isExpInitializer())` (06 §2.6).
                const ez = v._init.isExpInitializer();
                if (ez !== null) {
                    // Prevent endless loops. Consider:
                    // `__field0 = (S __tup1 = S(x, y);) , __field0 = __tup1.__fields_field_0`
                    // escapeExp would recurse on the lhs of the last assignment, which is __field0
                    // again. In this case, we want the rhs.
                    // Also consider appending a struct with a `return scope` constructor:
                    // __appendtmp34 = __appendtmp34.this(null)
                    // In that case we just break the cycle using `lastTemp`.
                    const lc = lastComma(ez.exp!);
                    const restoreLastTemp = er.lastTemp;
                    er.lastTemp = v;
                    // PAIRED STATE (11 §2.5, rules (b) and (d)): same argument as the two
                    // `er.inRetRefTransition` pairs in `visitCall` below — the recursive `escapeExp`
                    // calls reach `er.byValue`/`byRef`/`byExp`, whose `checkAssignEscape` closures call
                    // `setUnsafeDIP1000` -> safe.ts's `setUnsafePreview`, whose diagnostics format their
                    // arguments through hdrgen.ts, which still carries §2.5 walls (the typeToBuffer arms).
                    // Those are exit paths D does not have, and `er` outlives the
                    // throw (it is the caller's, `escapeByValue` being a public export), so the restore
                    // moves into a `finally`. D releases once on the normal path and consumes no return
                    // value, so the plain `finally` is the correct shape (not capture-in-finally).
                    try {
                        // dmd/escape.d:1557 — D property-call syntax on the `isXxx()` methods (04 §9).
                        if (lc.isAssignExp() !== null || lc.isConstructExp() !== null || lc.isBlitExp() !== null)
                            escapeExp(lc.isBinExp()!.e2!, er, deref);
                        else
                            escapeExp(ez.exp!, er, deref);
                    } finally {
                        er.lastTemp = restoreLastTemp;
                    }
                    return;
                }
            }

            // dmd/escape.d:1567.
            if (deref < 0 || hasPointers(e.type!))
                er.varDeref(v, deref);
        }
    };

    // dmd/escape.d:1572.
    const visitThis = (e: ThisExp): void => {
        // Special case because `__this2` isn't `ref` internally
        if (deref === -1 && e.var_ !== null && e.var_.toParent2()!.isFuncDeclaration()!.hasDualContext) {
            escapeByValue(e, er);
            return;
        }

        if (e.var_ !== null)
            er.varDeref(e.var_, deref);
    };

    // dmd/escape.d:1585.
    const visitPtr = (e: PtrExp): void => {
        if (deref < 0 || (er.live && hasPointers(e.type!)))
            escapeExp(e.e1!, er, deref + 1);
    };

    // dmd/escape.d:1591.
    const visitDotVar = (e: DotVarExp): void => {
        const t1b = toBasetype(e.e1!.type!);
        // Accessing a class field dereferences the `this` pointer
        if (t1b.isTypeClass() !== null)
            escapeExp(e.e1!, er, deref + 1);
        else if (deref < 0 || hasPointers(e.type!))
            escapeExp(e.e1!, er, deref);
    };

    // dmd/escape.d:1601.
    const visitDelegate = (e: DelegateExp): void => {
        const t = toBasetype(e.e1!.type!);
        if (t.isTypeClass() !== null || t.isTypePointer() !== null)
            escapeByValue(e.e1!, er);
        else
            escapeByRef(e.e1!, er);
        er.byFunc(e.func!, false);
    };

    // dmd/escape.d:1611.
    const visitFunc = (e: FuncExp): void => {
        if (e.fd!.tok === TOK.delegate_)
            er.byFunc(e.fd!, false);
    };

    // dmd/escape.d:1617.
    const visitTuple = (_e: TupleExp): void => {
        // dmd/escape.d:1619 — `assert(0); // should have been lowered by now`. A faithful D
        // `assert(0)` (11 §2.5: NOT a wall).
        assertUnreachable();
    };

    // dmd/escape.d:1622.
    const visitArrayLiteral = (e: ArrayLiteralExp): void => {
        const tb = toBasetype(e.type!);
        if (tb.isStaticOrDynamicArray()) {
            if (e.basis !== null)
                escapeExp(e.basis, er, deref);
            for (const el of e.elements!) {
                if (el !== null)
                    escapeExp(el, er, deref);
            }
        }
    };

    // dmd/escape.d:1637.
    const visitStructLiteral = (e: StructLiteralExp): void => {
        if (e.elements !== null) {
            for (const ex of e.elements) {
                if (ex !== null)
                    escapeExp(ex, er, deref);
            }
        }
        if (deref === -1) {
            er.byExp(e, er.inRetRefTransition > 0); //
        }
    };

    // dmd/escape.d:1653.
    const visitNew = (e: NewExp): void => {
        if (e.placement !== null)
            escapeExp(e.placement, er, deref);

        const tb = toBasetype(e.newtype!);
        if (tb.isTypeStruct() !== null && e.member === null && e.arguments_ !== null) {
            for (const ex of e.arguments_) {
                if (ex !== null)
                    escapeExp(ex, er, deref);
            }
        }
    };

    // dmd/escape.d:1669.
    const visitCast = (e: CastExp): void => {
        if (deref < 0 || !hasPointers(e.type!))
            return;
        const tb = toBasetype(e.type!);
        if (tb.isTypeDArray() !== null && toBasetype(e.e1!.type!).isTypeSArray() !== null)
            escapeExp(e.e1!, er, deref - 1);
        else
            escapeExp(e.e1!, er, deref);
    };

    // dmd/escape.d:1680.
    const visitSlice = (e: SliceExp): void => {
        // Usually: slicing a static array escapes by ref, slicing a dynamic array escapes by value.
        // However, slices with compile-time known length can implicitly converted to static arrays:
        // int*[3] b = sa[0 .. 3];
        // So we need to compare the type before slicing and after slicing
        const staticBefore: boolean = toBasetype(e.e1!.type!).isTypeSArray() !== null;
        const staticAfter: boolean = toBasetype(e.type!).isTypeSArray() !== null;
        // dmd/escape.d:1688 — `deref + staticAfter - staticBefore`: D promotes each bool to 0/1.
        escapeExp(e.e1!, er, deref + (staticAfter ? 1 : 0) - (staticBefore ? 1 : 0));
    };

    // dmd/escape.d:1691.
    const visitIndex = (e: IndexExp): void => {
        const tb = toBasetype(e.e1!.type!);

        if (tb.isTypeSArray() !== null) {
            escapeExp(e.e1!, er, deref);
        } else if (tb.isTypeDArray() !== null) {
            escapeExp(e.e1!, er, deref + 1);
        }
    };

    // dmd/escape.d:1705.
    const visitBin = (e: BinExp): void => {
        if (toBasetype(e.type!).isTypePointer() !== null) {
            // The expression must be pointer arithmetic, e.g. `p + 1` or `1 + p`
            escapeExp(e.e1!, er, deref);
            escapeExp(e.e2!, er, deref);
        }
    };

    // dmd/escape.d:1715.
    const visitBinAssign = (e: BinAssignExp): void => {
        escapeExp(e.e1!, er, deref);
    };

    // dmd/escape.d:1720.
    const visitAssign = (e: AssignExp): void => {
        escapeExp(e.e1!, er, deref);
    };

    // dmd/escape.d:1725.
    const visitComma = (e: CommaExp): void => {
        escapeExp(e.e2!, er, deref);
    };

    // dmd/escape.d:1730.
    const visitCond = (e: CondExp): void => {
        escapeExp(e.e1!, er, deref);
        escapeExp(e.e2!, er, deref);
    };

    // dmd/escape.d:1736.
    const visitCall = (e: CallExp): void => {
        // Check each argument that is passed as 'return scope'.
        const tf = calledFunctionType(e);
        if (tf === null)
            return;

        if (deref < 0 && !tf.isRef) {
            er.byExp(e, er.inRetRefTransition > 0);
            return;
        }

        // A function may have a return scope struct parameter, but only return an `int` field of that struct
        if (deref >= 0 && !hasPointers(e.type!))
            return;

        /// Given a `scope` / `return scope` / `return ref` annotation,
        /// get the corresponding pointer dereference level
        // dmd/escape.d:1756 — `static int paramDeref(ScopeRef psr)`, a nested static function.
        const paramDeref = (psr: ScopeRef): number => {
            return (psr === ScopeRef.ReturnRef || psr === ScopeRef.ReturnRef_Scope) ? -1 :
                (psr === ScopeRef.ReturnScope || psr === ScopeRef.Ref_ReturnScope) ? 0 :
                    +1;
        };

        // dmd/escape.d:1764.
        if (e.arguments_ !== null && e.arguments_.length !== 0) {
            // j=1 if _arguments[] is first argument,
            // skip it because it is not passed by ref
            // dmd/escape.d:1768 — `int j = tf.isDstyleVariadic();`: D's `bool` -> `int` promotion.
            const j = tf.isDstyleVariadic() ? 1 : 0;
            for (let i = j; i < e.arguments_.length; ++i) {
                const arg = e.arguments_.opIndex(i)!;
                const nparams = tf.parameterList.length();
                if (i - j < nparams && i >= j) {
                    const p = tf.parameterList.opIndex(i - j)!;
                    const stc = parameterStorageClass(tf, null, p);
                    const psr = buildScopeRef(stc);

                    // For struct constructors, `tf.isRef` is true, but for escape analysis,
                    // it's as if they return `void` and escape through the first (`this`) parameter:
                    // void assign(ref S this, return scope constructorArgs...)
                    // If you then return the constructed result by value, it doesn't count
                    // as dereferencing the scope arguments, they're still escaped.
                    const isRef = tf.isRef && !(tf.isCtor && paramDeref(psr) === 0);
                    const maybeInaccurate = deref === 0 && paramDeref(psr) === 0;
                    er.inRetRefTransition += maybeInaccurate ? 1 : 0;
                    // PAIRED STATE (11 §2.5): `escapeExp` reaches `er.byValue`/`byRef`/`byExp`, whose
                    // checkAssignEscape closures call `setUnsafeDIP1000` -> safe.ts's `setUnsafePreview`,
                    // whose diagnostics format their arguments through hdrgen.ts, which still carries §2.5
                    // walls (the typeToBuffer arms). Those are exit paths D does not have, so the
                    // decrement moves into a `finally`. D releases
                    // once on the normal path and consumes no return value, so a plain `finally` is the
                    // correct shape here (not the capture-in-finally form).
                    try {
                        if (paramDeref(psr) <= 0)
                            escapeExp(arg, er, deref + paramDeref(psr) + (isRef ? 1 : 0));
                    } finally {
                        er.inRetRefTransition -= maybeInaccurate ? 1 : 0;
                    }
                }
            }
        }

        // If 'this' is returned, check it too
        // dmd/escape.d:1795.
        const t1 = toBasetype(e.e1!.type!);
        const dve = e.e1!.isDotVarExp();
        if (dve !== null && t1.ty === TY.Tfunction) {
            const fd = dve.var_.isFuncDeclaration();
            if (fd === null)
                return;

            // https://issues.dlang.org/show_bug.cgi?id=20149#c10
            if (deref < 0 && dve.var_.isCtorDeclaration() !== null) {
                er.byExp(e, false);
                return;
            }

            // Calling a non-static member function dve.var, which is returning `this`, and with
            // dve.e1 representing `this`
            // dmd/escape.d:1811.
            const psr = buildScopeRef(getThisStorageClass(fd));
            er.inRetRefTransition += (psr === ScopeRef.ReturnRef_Scope) ? 1 : 0;
            // PAIRED STATE (11 §2.5), second pair — protection is per-PAIR, not per-region.
            try {
                if (paramDeref(psr) <= 0)
                    escapeExp(dve.e1!, er, deref + paramDeref(psr) + ((tf.isRef && !tf.isCtor) ? 1 : 0));
            } finally {
                er.inRetRefTransition -= (psr === ScopeRef.ReturnRef_Scope) ? 1 : 0;
            }
        }

        // The return value of a delegate call with return (scope) may point to a closure variable,
        // so escape the delegate in case it's `scope` / stack allocated.
        // dmd/escape.d:1820.
        if (t1.isTypeDelegate() !== null && tf.isReturn) {
            escapeExp(e.e1!, er, deref + (tf.isRef ? 1 : 0));
        }

        // If `fd` is a nested function that's return ref / return scope, check that
        // it doesn't escape closure vars
        // dmd/escape.d:1827 — `if (auto ve = e.e1.isVarExp())` (06 §2.6 hoist).
        const ve = e.e1!.isVarExp();
        if (ve !== null) {
            const fd = ve.var_.isFuncDeclaration();
            if (fd !== null) {
                if (fd.isNested() && tf.isReturn) {
                    er.byFunc(fd, true);
                }
            }
        }
    };

    // dmd/escape.d:1839.
    if (deref > 0 && !er.live)
        return; // scope is not transitive currently, so dereferencing expressions don't escape

    // dmd/escape.d:1842.
    if (deref >= 0 && er.live && !hasPointers(e.type!))
        return; // can't escape non-pointer values by value

    // dmd/escape.d:1845 — D's own dispatch switch, emitted in full (13 §7.5).
    switch (e.op) {
        case EXP.address: return visitAddr(e.isAddrExp()!);
        case EXP.symbolOffset: return visitSymOff(e.isSymOffExp()!);
        case EXP.variable: return visitVar(e.isVarExp()!);
        case EXP.this_: return visitThis(e.isThisExp()!);
        case EXP.star: return visitPtr(e.isPtrExp()!);
        case EXP.dotVariable: return visitDotVar(e.isDotVarExp()!);
        case EXP.delegate_: return visitDelegate(e.isDelegateExp()!);
        case EXP.function_: return visitFunc(e.isFuncExp()!);
        case EXP.tuple: return visitTuple(e.isTupleExp()!);
        case EXP.arrayLiteral: return visitArrayLiteral(e.isArrayLiteralExp()!);
        case EXP.structLiteral: return visitStructLiteral(e.isStructLiteralExp()!);
        case EXP.new_: return visitNew(e.isNewExp()!);
        case EXP.cast_: return visitCast(e.isCastExp()!);
        case EXP.slice: return visitSlice(e.isSliceExp()!);
        case EXP.index: return visitIndex(e.isIndexExp()!);
        case EXP.blit: return visitAssign(e.isBlitExp()!);
        case EXP.construct: return visitAssign(e.isConstructExp()!);
        case EXP.assign: return visitAssign(e.isAssignExp()!);
        case EXP.comma: return visitComma(e.isCommaExp()!);
        case EXP.question: return visitCond(e.isCondExp()!);
        case EXP.call: return visitCall(e.isCallExp()!);
        default: {
            const ba = e.isBinAssignExp();
            if (ba !== null)
                return visitBinAssign(ba);
            const b = e.isBinExp();
            if (b !== null)
                return visitBin(b);
            return visit(e);
        }
    }
}

/**
 * dmd/escape.d:1884 — `STC getThisStorageClass(FuncDeclaration fd)`.
 * Concoct storage class for member function's implicit `this` parameter.
 * Params: fd = member function
 * Returns: storage class for fd's `this`.
 */
function getThisStorageClass(fd: FuncDeclaration): STC {
    let stc: STC = STC.none;
    const tf = toBasetype(fd.type!).isTypeFunction()!;
    if (tf.isReturn)
        stc = (stc | STC.return_) as STC;
    if (tf.isReturnScope)
        stc = (stc | STC.returnScope | STC.scope_) as STC;
    const ad = fd.isThis();
    if ((ad !== null && ad.isClassDeclaration() !== null) || tf.isScopeQual)
        stc = (stc | STC.scope_) as STC;
    if (ad !== null && ad.isStructDeclaration() !== null)
        stc = (stc | STC.ref_) as STC; // `this` for a struct member function is passed by `ref`
    return stc;
}

/**
 * dmd/escape.d:1917 — `void escapeByRef(Expression e, ref scope EscapeByResults er)`.
 *
 * `e` is an expression to be returned by 'ref'. Walk `e` to determine which variables are possibly being
 * returned by ref, such as `ref int function(int i) { return i; }`. If `e` is a form of `*p`, determine
 * which variables have content which is being returned as ref, such as
 * `ref int function(int* p) { return *p; }`.
 *
 * Module-private in D (no `public` marker at escape.d:1900-1917) -> not exported (01 §2.5).
 */
function escapeByRef(e: Expression, er: EscapeByResults): void {
    escapeExp(e, er, -1);
}

/**
 * dmd/escape.d:1926 — `public struct EscapeByResults`. Aggregate the data collected by the
 * `escapeBy??()` functions.
 *
 * `retRefTransition` = whether the variable / expression went through a `return (ref) scope` function
 * call. This is needed for the dip1000-by-default transition, since the rules for disambiguating
 * `return scope ref` have changed: functions in legacy code can be mistakenly treated as `return ref`,
 * making the compiler believe stack variables are being escaped, which is an error even in `@system`
 * code. By keeping track of this information, variables escaped through `return ref` can be treated as
 * a deprecation instead of an error (test/fail_compilation/dip1000_deprecation.d). Additionally,
 * `return scope` can be inferred wrongly instead of `scope`, in which case the code could give false
 * positives even without `@safe` or dip1000 (issue 23657).
 *
 * A D `struct` -> a TS class holding the same fields (02 §2). Every D use passes it as `ref scope`, so
 * no call site copies it; `copy()` is provided because the value-struct contract requires it (03 §2) —
 * the four delegate fields and `lastTemp` are reference-shared, per 03 §2.1.
 *
 * `varDeref`, `inRetRefTransition` and `lastTemp` are D `private` = MODULE-scoped, and `escapeExp`
 * (same module) reads and writes all three, so they are NOT emitted as TS `private` (01 §2.5).
 */
export class EscapeByResults {
    /// called on variables being returned by ref / address
    byRef: (v: VarDeclaration, retRefTransition: boolean) => void;
    /// called on variables with values containing pointers
    byValue: (v: VarDeclaration) => void;
    /// called on nested functions that are turned into delegates.
    /// When `called` is true, it means the delegate escapes variables from the closure through a call
    /// to it, while `false` means the delegate itself escapes.
    byFunc: (fd: FuncDeclaration, called: boolean) => void;
    /// called when expression temporaries are being returned by ref / address
    byExp: (e: Expression, retRefTransition: boolean) => void;

    /// if @live semantics apply, i.e. expressions `p`, `*p`, `**p`, etc., all return `p`.
    live = false;

    /// Incremented / decremented every time an ambiguous return ref/scope parameter is checked.
    /// See retRefTransition above. D `private`, module-scoped (01 §2.5).
    inRetRefTransition = 0;

    /// When forwarding a temp var to its initializer, keep track of the temp var to break endless
    /// loops. D `private`, module-scoped (01 §2.5).
    lastTemp: VarDeclaration | null = null;

    /// D constructs this with a positional struct literal
    /// `EscapeByResults(&onRef, &onValue, &onFunc, &onExp)` (escape.d:906) — field declaration order.
    constructor(byRef: (v: VarDeclaration, retRefTransition: boolean) => void,
                byValue: (v: VarDeclaration) => void,
                byFunc: (fd: FuncDeclaration, called: boolean) => void,
                byExp: (e: Expression, retRefTransition: boolean) => void) {
        this.byRef = byRef;
        this.byValue = byValue;
        this.byFunc = byFunc;
        this.byExp = byExp;
    }

    /**
     * dmd/escape.d:1949 — `private void varDeref(VarDeclaration var, int deref)`.
     * Switch over `byValue` and `byRef` based on `deref` level
     * (-1 = by ref, 0 = by value, 1 = only for live currently).
     */
    varDeref(var_: VarDeclaration, deref: number): void {
        if (var_.isDataseg())
            return;
        if (deref === -1)
            this.byRef(var_, this.inRetRefTransition > 0);
        else if (deref === 0)
            this.byValue(var_);
        else if (deref > 0 && this.live)
            this.byValue(var_);
    }

    /// Value-struct copy contract (03 §2). No D call site copies this struct — every use is
    /// `ref scope` — but the contract requires the method. Delegates and `lastTemp` are references,
    /// so they are shared, not cloned (03 §2.1).
    copy(): EscapeByResults {
        const c = new EscapeByResults(this.byRef, this.byValue, this.byFunc, this.byExp);
        c.live = this.live;
        c.inRetRefTransition = this.inRetRefTransition;
        c.lastTemp = this.lastTemp;
        return c;
    }
}

/**
 * dmd/escape.d:1988 — `public void findAllOuterAccessedVariables(FuncDeclaration fd, VarDeclarations* vars)`.
 * Find all variables accessed by this delegate that are in functions enclosing it.
 * Params:
 *   fd   = function
 *   vars = array to append found variables to (D `VarDeclarations*`, an out-parameter by pointer ->
 *          the TS `Array` reference, mutated in place — 03 §3.2)
 */
export function findAllOuterAccessedVariables(fd: FuncDeclaration, vars: VarDeclarations): void {
    // dmd/escape.d:1991 — `for (auto p = fd.parent; p; p = p.parent)`.
    for (let p: Dsymbol | null = fd.parent; p !== null; p = p.parent) {
        const fdp = p.isFuncDeclaration();
        if (fdp === null)
            continue;

        for (const vElem of fdp.closureVars) {
            const v = vElem!;
            for (const fdv of v.nestedrefs) {
                if (fdv === fd) {
                    vars.push(v);
                }
            }
        }
    }
}

/**
 * dmd/escape.d:2022 — `private void doNotInferScope(VarDeclaration v, RootObject o)`.
 * Turn off `maybeScope` for variable `v`. This exists in order to find where `maybeScope` is getting
 * turned off.
 * Params:
 *   v = variable
 *   o = reason for it being turned off:
 *       - `Expression` such as `throw e` or `&e`
 *       - `VarDeclaration` of a non-scope parameter it was assigned to
 *       - `null` for no reason
 */
function doNotInferScope(v: VarDeclaration, o: RootObject | null): void {
    if (v.maybeScope) {
        v.maybeScope = false;
        if (o !== null && v.isParameter())
            EscapeState.scopeInferReason.set(v, o);
    }
}

/**
 * dmd/escape.d:2042 — `public void finishScopeParamInference(FuncDeclaration funcdecl, ref TypeFunction f)`.
 *
 * After semantic analysis of the function body, try to infer `scope` / `return` on the parameters.
 *
 * Params:
 *   funcdecl = function declaration that was analyzed
 *   f = final function type. `funcdecl.type` started as the 'premature type' before attribute
 *       inference, then its inferred attributes are copied over to final type `f`.
 *
 * `ref TypeFunction f` REASSIGNS the caller's variable (escape.d:2051 `f = cast(TypeFunction)f.copy()`),
 * so it is a one-slot box (03 §3.2), not a bare `TypeFunction`. The caller at `semantic3.d:1383` keeps
 * using its own `f` afterwards (`if (f != funcdecl.type) f.deco = null;`), so dropping the box would
 * silently discard the copy.
 */
export function finishScopeParamInference(funcdecl: FuncDeclaration, f: Ref<TypeFunction>): void {
    if (!funcdecl.scopeInprocess)
        return;
    funcdecl.scopeInprocess = false;

    // dmd/escape.d:2048.
    if ((funcdecl.storage_class & STC.return_) !== 0n) {
        if (funcdecl.type === f.value)
            f.value = f.value.copy().isTypeFunction()!; // D `cast(TypeFunction)f.copy()` (02 §11.5c(3))
        f.value.isReturn = true;
        f.value.isReturnScope = (funcdecl.storage_class & STC.returnScope) !== 0n;
        if ((funcdecl.storage_class & STC.returninferred) !== 0n)
            f.value.isReturnInferred = true;
    }

    // Infer STC.scope_
    // dmd/escape.d:2060.
    if (funcdecl.parameters !== null && !funcdecl.errors) {
        assert(f.value.parameterList.length() === funcdecl.parameters.length);
        // D `foreach (u, p; f.parameterList)` -> `opApply` (05 §11): 0 continues the loop.
        f.value.parameterList.opApply((u: number, p: Parameter): number => {
            const v = funcdecl.parameters!.opIndex(u)!;
            if (!v.isScope() && hasPointers(v.type!) && inferScope(v, null))
                p.storageClass = (p.storageClass | STC.scope_ | STC.scopeinferred) as STC;
            return 0;
        });
    }

    // dmd/escape.d:2074.
    if (funcdecl.vthis !== null) {
        inferScope(funcdecl.vthis, null);
        f.value.isScopeQual = funcdecl.vthis.isScope();
        f.value.isScopeInferred = (funcdecl.vthis.storage_class & STC.scopeinferred) !== 0n;
    }
}

/**
 * dmd/escape.d:2093 — `bool isReferenceToMutable(Type t)` (D `private`, escape.d:2092). Overload pair
 * with the `Parameter` form (escape.d:2153), split on the first parameter (04 §1 Form B rule 2): this
 * `Type` form keeps the bare name (three D calls against one), the other is
 * `isReferenceToMutableParameter`.
 *
 * Is type a reference to a mutable value? Used to determine if an argument that does not have a
 * corresponding Parameter, i.e. a variadic argument, is a pointer to mutable data.
 * Returns: true if it's a pointer (or reference) to mutable data.
 */
function isReferenceToMutable(t: Type): boolean {
    t = baseElemOf(t);

    if (!t.isMutable() || !hasPointers(t))
        return false;

    switch (t.ty) {
        case TY.Tpointer:
            if (nextOf(t)!.isTypeFunction() !== null)
                break;
            // goto case; (dmd/escape.d:2106) -> fall through to the next case (06 §3.6(a))

        case TY.Tarray:
        case TY.Taarray:
        case TY.Tdelegate:
            if (nextOf(t)!.isMutable())
                return true;
            break;

        case TY.Tclass:
            return true;        // even if the class fields are not mutable

        case TY.Tstruct:
            // Have to look at each field
            for (const vElem of t.isTypeStruct()!.sym!.fields) {
                const v = vElem!;
                if ((v.storage_class & STC.ref_) !== 0n) {
                    if (v.type!.isMutable())
                        return true;
                } else if (isReferenceToMutable(v.type!))
                    return true;
            }
            break;

        case TY.Tnull:
            return false;

        default:
            // dmd/escape.d:2136 — `assert(0)`, ported faithfully (not a wall).
            assertUnreachable();
    }
    return false;
}

/**
 * dmd/escape.d:2153 — `bool isReferenceToMutable(Parameter p, Type t)` (D `private`), renamed per 04 §1
 * Form B rule 2 (receiver-type suffix; the `Type` form above keeps the bare name).
 *
 * Is parameter a reference to a mutable value? Used if an argument has a corresponding Parameter.
 * The argument type `t` is necessary if the Parameter is inout.
 * Returns: true if it's a pointer (or reference) to mutable data.
 */
function isReferenceToMutableParameter(p: Parameter, t: Type): boolean {
    if (p.isReference()) {
        if (p.type!.isConst() || p.type!.isImmutable())
            return false;
        if (p.type!.isWild()) {
            return t.isMutable();
        }
        return p.type!.isMutable();
    }
    return isReferenceToMutable(p.type!);
}

/**
 * dmd/escape.d:2169 — `private enum EnclosedBy`.
 * When checking lifetime for assignment `va=v`, the way `va` encloses `v`.
 */
enum EnclosedBy {
    none = 0,
    refVar,      // `va` is a `ref` variable, which may link to a global variable
    global,      // `va` is a global variable
    returnScope, // `va` is a scope variable that may be returned
    longerScope, // `va` is another scope variable declared earlier than `v`
}

/**
 * dmd/escape.d:2187 — `private EnclosedBy enclosesLifetimeOf(VarDeclaration va, VarDeclaration v)`.
 * Determine if `va` has a lifetime that lasts past the destruction of `v`.
 * Params:
 *   va = variable assigned to (may be null; every call site passes a possibly-null `va`)
 *   v  = variable being assigned
 * Returns: the way `va` encloses `v` (if any).
 */
function enclosesLifetimeOf(va: VarDeclaration | null, v: VarDeclaration): EnclosedBy {
    // dmd/escape.d:2189.
    if (va === null)
        return EnclosedBy.none;

    if (va.isDataseg())
        return EnclosedBy.global;

    if (va.isScope() && va.isReturn() && !v.isReturn())
        return EnclosedBy.returnScope;

    if (va.isReference() && va.isParameter())
        return EnclosedBy.refVar;

    // dmd/escape.d:2201 — `assert(va.sequenceNumber != va.sequenceNumber.init)`: `.init` of `uint`
    // is 0, so both asserts read "the sequence number has been assigned" (09 §1.0).
    assert(va.sequenceNumber !== 0);
    assert(v.sequenceNumber !== 0);
    if (va.sequenceNumber < v.sequenceNumber)
        return EnclosedBy.longerScope;

    return EnclosedBy.none;
}

/**
 * dmd/escape.d:2211 — `public bool setUnsafeDIP1000(ref Scope sc, bool gag, Loc loc, const(char)* msg,
 * RootObject[] args...)`. `setUnsafePreview` partially evaluated for dip1000.
 *
 * D's `RootObject[] args...` is a typesafe variadic (04 §3.2) -> a TS rest parameter. An element may be
 * null (`checkParamArgumentEscape` passes an absent `parId`, escape.d:454), as in safe.ts's variadics.
 */
export function setUnsafeDIP1000(sc: Scope, gag: boolean, loc: Loc, msg: DString,
                                 ...args: (RootObject | null)[]): boolean {
    return setUnsafePreview(sc, sc.useDIP1000(), gag, loc, msg, ...args);
}

/**
 * dmd/escape.d:2219 — `private bool setUnsafeDIP1000(ref Scope sc, bool gag, Loc loc, VarDeclaration
 * scopeVar, const(char)* msg, RootObject[] args...)`. Overload for scope violations that also stores the
 * variable whose scope status caused the issue. Form B name (04 §1): the middle `scopeVar` parameter
 * becomes the `ScopeVar` suffix, as safe.ts's `setUnsafePreviewScopeVar` (safe.d:553).
 */
function setUnsafeDIP1000ScopeVar(sc: Scope, gag: boolean, loc: Loc, scopeVar: VarDeclaration | null,
                                  msg: DString, ...args: (RootObject | null)[]): boolean {
    return setUnsafePreviewScopeVar(sc, sc.useDIP1000(), gag, loc, scopeVar, msg, ...args);
}

/**
 * dmd/escape.d:2239 — `private bool checkScopeVarAddr(VarDeclaration v, Expression e, ref Scope sc, bool gag)`.
 *
 * Check that taking the address of `v` is `@safe`. It's not possible to take the address of a scope
 * variable, because `scope` only applies to the top level indirection.
 *
 * Params:
 *   v   = variable that a reference is created to
 *   e   = expression that takes the reference
 *   sc  = used to obtain function / deprecated status
 *   gag = don't print errors
 * Returns: true if taking the address of `v` is problematic because of the lack of transitive `scope`.
 */
function checkScopeVarAddr(v: VarDeclaration, e: Expression, sc: Scope, gag: boolean): boolean {
    if (!v.isScope()) {
        doNotInferScope(v, e);
        return false;
    }

    if (e.type === null)
        return false;

    // When the type after dereferencing has no pointers, it's okay.
    // Comes up when escaping `&someStruct.intMember` of a `scope` struct:
    // scope does not apply to the `int`
    // dmd/escape.d:2253.
    const t = baseElemOf(e.type);
    if ((t.ty === TY.Tarray || t.ty === TY.Tpointer) && !hasPointers(toBasetype(nextOf(t)!)))
        return false;

    // take address of `scope` variable not allowed, requires transitive scope
    // dmd/escape.d:2258.
    return setUnsafeDIP1000(sc, gag, e.loc,
        ds("taking address of `scope` variable `%s` with pointers"), v);
}

/**
 * dmd/escape.d:2269 — `private bool isTypesafeVariadicArray(VarDeclaration v)`.
 * Determine if `v` is a typesafe variadic array, which is implicitly `scope`.
 * Params: v = variable to check
 * Returns: true if `v` is a variadic parameter.
 */
function isTypesafeVariadicArray(v: VarDeclaration): boolean {
    if ((v.storage_class & STC.variadic) !== 0n) {
        const tb = toBasetype(v.type!);
        if (tb.isStaticOrDynamicArray())
            return true;
    }
    return false;
}
