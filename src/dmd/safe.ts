// Ported from dmd/safe.d (module dmd.safe).
//
// Checks whether member access or array casting is allowed in `@safe` code.
// Specification: https://dlang.org/spec/function.html#function-safety
//
// WHOLE-FILE TRANSLATION (P5.0 wave 8) of LDC 1.43.0's dmd/safe.d, replacing the rung-era partial.
// Every top-level D declaration is translated here, in D source order; this file carries no wall of
// its own. Deferred work it reaches lives in OTHER files and throws from there — chiefly
// `AttributeViolation.fromFormat` (func.ts), whose non-null format arguments go through the unported
// `toErrMsg(RootObject)` (dmd/hdrgen.d:112). Every `setUnsafe`/`setUnsafePreview` call that builds
// an attribute violation from a format WITH arguments therefore stops there today; a format without
// arguments (`"pointer arithmetic"`) runs end to end.
//
// UFCS (04 §6): every D call `sc.setUnsafe(…)`, `fd.isSafe()`, `sc.func.isSafeBypassingInference()`
// is a free function of this module taking its receiver first. None is a method in D.
//
// Overload pairs (04 §1 Form B). D declares two `setUnsafe` and two `setUnsafePreview` overloads that
// differ only by a `VarDeclaration scopeVar` inserted before the format; with the typesafe variadic
// tail, arity cannot tell them apart. The `scopeVar`-less form keeps the bare name — it is the one the
// tree already imports (`setUnsafePreview`) and the one every consumer wall names (`setUnsafe`,
// safe.d:469). The `scopeVar` form takes the `ScopeVar` suffix, the spelling func.ts already gives
// the same D overload shape (`AttributeViolation.fromFormatScopeVar`, func.d:1277).
//
// Variadic tail: D `RootObject[] args...` admits null elements (`setUnsafeCall` passes `f, null`,
// safe.d:451), so the rest parameter is `(RootObject | null)[]`, the element type `AttributeViolation`
// already takes (func.ts, func.d:1263).
//
// Imports: `core.stdc.stdio` dropped (runtime, 01 Rule 3.7; used only by commented-out printf).
// Every value binding below is read only inside function bodies (01 Rule 4.3). The *sem value
// imports sit LAST (01 Rule 4.8): entering the core SCC through a semantic pass fails at load.

import type { Scope } from "./dscope.js";
import type { Loc } from "./location.js";
import type { Expression } from "./expression.js";
import type { RootObject } from "./rootobject.js";
import type { DString } from "../dstring.js";
import type { FuncDeclaration } from "./func.js";
import type { Type } from "./mtype.js";
import type { VarDeclaration } from "./declaration.js";
import type { Identifier } from "./identifier.js";
import type { ErrorSink } from "./errorsink.js";
import { FeatureState, global } from "./globals.js";
import { assert, SwitchError } from "../assert.js";
import { TRUST, TY, Sizeok, STC, MATCH } from "./astenums.js";
import { EXP } from "./tokens.js";
import { ds } from "../dstring.js";
import { MODimplicitConv, DotExpFlag } from "./mtype.js";
import { AttributeViolation } from "./func.js";
import { Id } from "./id.js";
import { target } from "./target.js";
import { SwitchPrefix } from "./targetcompiler.js";
import { error, deprecation } from "./errors.js";
import { OutBuffer } from "./common/outbuffer.js";
import { fTuple } from "./root/string.js";
import { isDsymbol } from "./dtemplate.js";
import { ClassKind } from "./aggregate.js";
// last (01 Rule 4.8): *sem modules — entering the SCC through them makes this file its entry point.
import {
    alignment, arrayOf, hasInvariant, hasPointers, hasUnsafeBitpatterns, nextOf, size, toBasetype,
} from "./typesem.js";
import { implicitConvToType } from "./dcast.js";
import { determineSize } from "./dsymbolsem.js";
import { isRootTraitsCompilesScope } from "./funcsem.js";

/// The canonical box / ref-cell (03 §7.2) for D's `ref string msg` of `isSafeCast`.
interface Ref<T> { value: T; }

/*************************************************************
 * dmd/safe.d:59 — `bool checkUnsafeAccess(Scope* sc, Expression e, bool readonly, bool printmsg)`.
 *
 * Check for unsafe access in @safe code:
 * 1. read overlapped pointers
 * 2. write misaligned pointers
 * 3. write overlapped storage classes
 * Print error if unsafe.
 * Params:
 *      sc = scope
 *      e = expression to check
 *      readonly = if access is read-only
 *      printmsg = print error message if true
 * Returns:
 *      true if error
 *
 * Side effect: may run `determineSize` on the member's aggregate (safe.d:88), and through
 * `setUnsafe` may commit an inferring function to `@system`.
 */
export function checkUnsafeAccess(sc: Scope, e: Expression, readonly: boolean, printmsg: boolean): boolean {
    //printf("checkUnsafeAccess(e: '%s', readonly: %d, printmsg: %d)\n", e.toChars(), readonly, printmsg);
    if (e.op !== EXP.dotVariable)
        return false;
    const dve = e.isDotVarExp()!;   // D `cast(DotVarExp)e` — the op test above proves it
    const v = dve.var_.isVarDeclaration();
    if (v === null)
        return false;
    if (sc.func === null)
        return false;
    const ad = v.isMember2();
    if (ad === null)
        return false;

    if (v.isSystem()) {
        if (setUnsafePreview(sc, sc.previews.systemVariables, !printmsg, e.loc,
            ds("accessing `@system` field `%s.%s`"), ad, v))
            return true;
    }

    // This branch shouldn't be here, but unfortunately calling `ad.determineSize`
    // breaks code with circular reference errors. Specifically, test23589.d fails
    if (ad.sizeok !== Sizeok.done && !isSafeBypassingInference(sc.func))
        return false;

    // needed to set v.overlapped and v.overlapUnsafe
    if (ad.sizeok !== Sizeok.done)
        determineSize(ad, ad.loc);

    // ported: D local `hasPointers` -> hasPointers_ (collides with the typesem import, 01 Rule 2.3)
    const hasPointers_ = hasPointers(v.type!);
    if (hasPointers_) {
        if (v.overlapped) {
            if (isSafeBypassingInference(sc.func) && setUnsafe(sc, !printmsg, e.loc,
                ds("accessing overlapped field `%s.%s` with pointers"), ad, v)) {
                return true;
            } else {
                // @@@DEPRECATED_2.116@@@
                // https://issues.dlang.org/show_bug.cgi?id=20655
                // Inferring `@system` because of union access breaks code,
                // so make it a deprecation safety violation as of 2.106
                // To turn into an error, remove `isSafeBypassingInference` check in the
                // above if statement and remove the else branch
                setUnsafePreview(sc, FeatureState.default_, !printmsg, e.loc,
                    ds("accessing overlapped field `%s.%s` with pointers"), ad, v);
            }
        }
    }

    if (hasInvariant(v.type!)) {
        if (v.overlapped) {
            if (setUnsafe(sc, !printmsg, e.loc,
                ds("accessing overlapped field `%s.%s` with a structs invariant"),
                ad, v))
                return true;
        }
    }

    // @@@DEPRECATED_2.119@@@
    // https://issues.dlang.org/show_bug.cgi?id=24477
    // Should probably be turned into an error in a new edition
    if (hasUnsafeBitpatterns(v.type!) && v.overlapped && setUnsafePreview(
        sc, FeatureState.default_, !printmsg, e.loc,
        ds("accessing overlapped field `%s.%s` with unsafe bit patterns"), ad, v)
    ) {
        return true;
    }

    if (readonly || !e.type!.isMutable())
        return false;

    if (hasPointers_ && toBasetype(v.type!).ty !== TY.Tstruct) {
        // D `ad.type.alignment` is the typesem free function (typesem.d:1348), evaluated twice as in D.
        if ((!alignment(ad.type!).isDefault() && alignment(ad.type!).get() < target.ptrsize) ||
             (v.offset & (target.ptrsize - 1)) !== 0) {
            if (setUnsafe(sc, !printmsg, e.loc,
                ds("modifying misaligned pointers through field `%s.%s`"), ad, v))
                return true;
        }
    }

    if (v.overlapUnsafe) {
        if (setUnsafe(sc, !printmsg, e.loc,
            ds("modifying field `%s.%s` which overlaps with fields with other storage classes"),
            ad, v)) {
            return true;
        }
    }

    return false;
}


/**********************************************
 * dmd/safe.d:174 — `bool isSafeCast(Expression e, Type tfrom, Type tto, ref string msg)`.
 *
 * Determine if it is @safe to cast e from tfrom to tto.
 * Params:
 *      e = expression to be cast
 *      tfrom = type of e
 *      tto = type to cast e to
 *      msg = reason why cast is unsafe or deprecated (D `ref string`: the caller's box; written only
 *            on the paths below that assign it, left untouched otherwise)
 * Returns:
 *      true if @safe or deprecated (a deprecated cast returns true AND leaves a reason in `msg`)
 */
export function isSafeCast(e: Expression, tfrom: Type, tto: Type, msg: Ref<DString>): boolean {
    // Implicit conversions are always safe
    if (implicitConvToType(tfrom, tto) !== MATCH.nomatch)
        return true;
    if (!hasPointers(tto)) {
        // casting to bool is safe as it's a special op
        // casting to struct with non-pointer @system field is not @safe
        if (tto.ty !== TY.Tbool && hasUnsafeBitpatterns(tto)) {
            msg.value = ds("Target element type has unsafe bit patterns");
            return false;
        }
        return true;
    }
    let tfromb = toBasetype(tfrom);
    const ttob = toBasetype(tto);

    // Casting to void* is always safe, https://github.com/dlang/dmd/issues/20514
    if (ttob.isTypePointer() !== null && toBasetype(nextOf(ttob)!).ty === TY.Tvoid)
        return true;

    if (ttob.ty === TY.Tclass && tfromb.ty === TY.Tclass) {
        const cdfrom = tfromb.isClassHandle()!;   // Tclass: TypeClass.isClassHandle is its `sym`
        const cdto = ttob.isClassHandle()!;
        const offset: Ref<number> = { value: 0 };   // D `int offset;`, passed as `&offset`

        // SKIP-FLAG (06 §4.1): the jump to label Lsame skips the three checks below to the shared tail.
        let gotoLsame = false;
        if (cdfrom === cdto)
            gotoLsame = true;   // goto Lsame (dmd/safe.d:204)

        if (!gotoLsame && !cdfrom.isBaseOf(cdto, offset) &&
            !((cdfrom.isInterfaceDeclaration() !== null || cdto.isInterfaceDeclaration() !== null)
                && cdfrom.classKind === ClassKind.d && cdto.classKind === ClassKind.d)) {
            msg.value = ds("Source object type is incompatible with target type");
            return false;
        }

        // no RTTI
        if (!gotoLsame && (cdfrom.isCPPinterface() || cdto.isCPPinterface())) {
            msg.value = ds("No dynamic type information for extern(C++) classes");
            return false;
        }
        if (!gotoLsame && (cdfrom.classKind === ClassKind.cpp || cdto.classKind === ClassKind.cpp))
            msg.value = ds("No dynamic type information for extern(C++) classes");

        // SKIP-FLAG target Lsame: shared tail, reached by the jump and by fall-through alike (not gated).
        if (!MODimplicitConv(tfromb.mod, ttob.mod)) {
            msg.value = ds("Incompatible type qualifier");
            return false;
        }
        return true;
    }

    if (ttob.ty === TY.Tarray && tfromb.ty === TY.Tsarray) // https://issues.dlang.org/show_bug.cgi?id=12502
        tfromb = arrayOf(nextOf(tfromb)!);

    if (ttob.ty === TY.Tarray   && tfromb.ty === TY.Tarray ||
        ttob.ty === TY.Tpointer && tfromb.ty === TY.Tpointer) {
        const ttobn = toBasetype(nextOf(ttob)!);
        const tfromn = toBasetype(nextOf(tfromb)!);

        /* From void[] to anything mutable is unsafe because:
         *  int*[] api;
         *  void[] av = api;
         *  int[] ai = cast(int[]) av;
         *  ai[0] = 7;
         *  *api[0] crash!
         */
        if (tfromn.ty === TY.Tvoid && ttobn.isMutable()) {
            if (ttob.ty === TY.Tarray && e.op === EXP.arrayLiteral)
                return true;
            msg.value = ds("`void` data may contain pointers and target element type is mutable");
            return false;
        }

        // If the struct is opaque we don't know about the struct members then the cast becomes unsafe
        if (ttobn.ty === TY.Tstruct && ttobn.isTypeStruct()!.sym!.members === null) {
            msg.value = ds("Target element type is opaque");
            return false;
        }
        if (tfromn.ty === TY.Tstruct && tfromn.isTypeStruct()!.sym!.members === null) {
            msg.value = ds("Source element type is opaque");
            return false;
        }

        if (e.op !== EXP.arrayLiteral) {
            // For bool, only 0 and 1 are safe values
            // Runtime array cast reinterprets data
            if (ttobn.ty === TY.Tbool && tfromn.ty !== TY.Tbool)
                msg.value = ds("Source element may have bytes which are not 0 or 1");
            else if (hasUnsafeBitpatterns(ttobn))
                msg.value = ds("Target element type has unsafe bit patterns");

            // Can't alias a bool pointer with a non-bool pointer
            if (ttobn.ty !== TY.Tbool && tfromn.ty === TY.Tbool && ttobn.isMutable())
                msg.value = ds("Target element could be assigned a byte which is not 0 or 1");
            else if (hasUnsafeBitpatterns(tfromn) && ttobn.isMutable())
                msg.value = ds("Source element type has unsafe bit patterns and target element type is mutable");
        }

        const frompointers = hasPointers(tfromn);
        const topointers = hasPointers(ttobn);

        if (frompointers && !topointers && ttobn.isMutable()) {
            msg.value = ds("Target element type is mutable and source element type contains a pointer");
            return false;
        }

        if (!frompointers && topointers) {
            msg.value = ds("Target element type contains a pointer");
            return false;
        }

        if (!topointers &&
            ttobn.ty !== TY.Tfunction && tfromn.ty !== TY.Tfunction &&
            (ttob.ty === TY.Tarray || size(ttobn) <= size(tfromn)) &&
            MODimplicitConv(tfromn.mod, ttobn.mod)) {
            return true;
        }
    }
    msg.value = ds("Source type is incompatible with target type containing a pointer");
    return false;
}

/*************************************************
 * dmd/safe.d:321 — `bool checkUnsafeDotExp(Scope* sc, Expression e, Identifier id, int flag)`.
 *
 * Check for unsafe use of `.ptr` or `.funcptr`
 * Params:
 *      sc = context
 *      e = expression for error messages
 *      id = `ptr` or `funcptr`
 *      flag = DotExpFlag
 * Returns:
 *      true if error
 */
export function checkUnsafeDotExp(sc: Scope, e: Expression, id: Identifier, flag: number): boolean {
    if ((flag & DotExpFlag.noDeref) === 0) { // this use is attempting a dereference
        if (id === Id.ptr)
            return setUnsafe(sc, false, e.loc, ds("using `%s.ptr` (instead of `&%s[0])`"), e, e);
        return setUnsafe(sc, false, e.loc, ds("using `%s.%s`"), e, id);
    }
    return false;
}

/**************************************
 * dmd/safe.d:336 — `bool isSaferD(FuncDeclaration fd)`.
 *
 * Safer D adds safety checks to functions with the default
 * trust setting. Pure read: `tf.trust == TRUST.default_ && fd.saferD`, no inference side effect.
 */
export function isSaferD(fd: FuncDeclaration): boolean {
    return fd.type!.toTypeFunction().trust === TRUST.default_ && fd.saferD;
}

/**
 * dmd/safe.d:341 — `bool isSafe(FuncDeclaration fd)`. Whether `fd` is `@safe`.
 *
 * NOT a pure read: when `fd`'s safety is still being inferred (`safetyInprocess`), asking the
 * question commits it to `@system` first (`setFunctionToUnsafe`), so the answer is then false.
 * Use `isSafeBypassingInference` to ask without that side effect.
 */
export function isSafe(fd: FuncDeclaration): boolean {
    if (fd.safetyInprocess)
        setFunctionToUnsafe(fd);
    return fd.type!.toTypeFunction().trust === TRUST.safe;
}

/**
 * dmd/safe.d:348 — `extern (D) bool isSafeBypassingInference(FuncDeclaration fd)`.
 *
 * Whether `fd` is `@safe` WITHOUT forcing an in-progress inference: false while `safetyInprocess`,
 * otherwise `isSafe(fd)` (whose inference head the `&&` has then excluded, so no side effect).
 */
export function isSafeBypassingInference(fd: FuncDeclaration): boolean {
    return !(fd.safetyInprocess) && isSafe(fd);
}

/**
 * dmd/safe.d:353 — `bool isTrusted(FuncDeclaration fd)`. Whether `fd` is `@trusted`.
 * Same inference side effect as `isSafe`: an in-progress inference is committed to `@system`.
 */
export function isTrusted(fd: FuncDeclaration): boolean {
    if (fd.safetyInprocess)
        setFunctionToUnsafe(fd);
    return fd.type!.toTypeFunction().trust === TRUST.trusted;
}

/*****************************************************
 * dmd/safe.d:374 — `void reportSafeError(FuncDeclaration fd, bool gag, Loc loc,`
 * D `private` (safe.d:373); the parameter list continues with scopeVar, format and the variadic args.
 *
 * D module-private: not exported (10 §1.7 — no unittest reaches it; its siblings do).
 *
 * Report safety violation for function `fd`, or squirrel away
 * error message in fd.safetyViolation if needed later.
 * Call when `fd` was just inferred to be @system OR
 * `fd` was @safe and an tried something unsafe.
 * Params:
 *   fd    = function we are gonna rat on
 *   gag   = suppress error message (used in escape.d)
 *   loc   = location of error
 *   scopeVar = if not null, is the variable whose scope status caused the violation
 *   format = printf-style format string
 *   args  = arguments for %s format specifier
 */
function reportSafeError(fd: FuncDeclaration, gag: boolean, loc: Loc,
    scopeVar: VarDeclaration | null, format: DString | null, ...args: (RootObject | null)[]): void {
    const eSink: ErrorSink = global.errorSink!;
    if (fd.type!.toTypeFunction().trust === TRUST.system) { // function was just inferred to be @system
        if (format !== null) {
            if (scopeVar !== null)
                fd.safetyViolation = AttributeViolation.fromFormatScopeVar(loc, format, scopeVar, args);
            else
                fd.safetyViolation = AttributeViolation.fromFormat(loc, format, args);
        } else if (args.length > 0) {
            // D `(cast(Dsymbol) args[0]).isFuncDeclaration()`: the class cast is `isDsymbol` (dtemplate.d:86);
            // a non-Dsymbol or null `args[0]` dereferences null in D, and throws here.
            const fd2 = isDsymbol(args[0])!.isFuncDeclaration();
            if (fd2 !== null) {
                fd.safetyViolation = AttributeViolation.fromFuncDeclaration(loc, fd2); // call to non-@nogc function
            }
        }
    } else if (isSafe(fd) || isSaferD(fd)) {
        if (!gag && format !== null) {
            const buf = new OutBuffer();
            buf.writestring(AttributeViolation.fromFormat(loc, format, args).action!);
            if (isSafe(fd))
                buf.writestring(ds(" is not allowed in a `@safe` function"));
            else {
                buf.printf(ds(" is not allowed in a function with default safety with `-%spreview=safer`"),
                    SwitchPrefix);
            }
            eSink.error(loc, ds("%s"), buf.extractChars());
        }
    }
}


/**********************************************
 * dmd/safe.d:422 — `extern (D) bool setFunctionToUnsafe(FuncDeclaration fd)`.
 *
 * Function is doing something unsafe. If inference
 * is in process, commit the function to be @system.
 * Params:
 *      fd = the naughty function
 * Returns:
 *      true if this is a safe function and so an error OR is inferred to be @system,
 *      false otherwise.
 *
 * Side effect (inference head): clears `safetyInprocess`, sets the function type's `trust` to
 * `TRUST.system`, and recurses into the enclosing function of a foreach body (`fd.fes.func`).
 */
export function setFunctionToUnsafe(fd: FuncDeclaration): boolean {
    if (fd.safetyInprocess) {
        fd.safetyInprocess = false;
        fd.type!.toTypeFunction().trust = TRUST.system;

        if (fd.fes !== null)
            setFunctionToUnsafe(fd.fes.func!);
        return true;
    } else if (isSafe(fd) || isSaferD(fd))
        return true;
    return false;
}


/**************************************
 * dmd/safe.d:447 — `extern (D) bool setUnsafeCall(FuncDeclaration fd, FuncDeclaration f)`.
 *
 * The function is calling `@system` function `f`, so mark it as unsafe.
 *
 * Params:
 *   fd = caller
 *   f = function being called (needed for diagnostic of inferred functions)
 * Returns: whether there's a safe error
 *
 * Emits no diagnostic itself (the format is null); an inferring caller records
 * `AttributeViolation(f.loc, f)` as its `safetyViolation`.
 */
export function setUnsafeCall(fd: FuncDeclaration, f: FuncDeclaration): boolean {
    if (setFunctionToUnsafe(fd)) {
        reportSafeError(fd, false, f.loc, null, null, f, null);
        return isSafe(fd);
    }
    return false;
}

/**************************************
 * dmd/safe.d:469 — `bool setUnsafe(Scope* sc, bool gag, Loc loc, const(char)* format, RootObject[] args...)`
 * The `scopeVar`-less overload (bare name, see file header); forwards
 * to `setUnsafeScopeVar` with a null `scopeVar`.
 *
 * A statement / expression in this scope is not `@safe`,
 * so mark the enclosing function as `@system`
 *
 * Params:
 *   sc = scope that the unsafe statement / expression is in
 *   gag = surpress error message (used in escape.d)
 *   loc = location of error
 *   format = printf-style format string (may be null: then only inference is affected)
 *   args  = arguments for format string
 * Returns: whether there is a safe error
 */
export function setUnsafe(sc: Scope, gag: boolean, loc: Loc, format: DString | null,
    ...args: (RootObject | null)[]): boolean {
    return setUnsafeScopeVar(sc, gag, loc, null, format, ...args);
}

/**
 * dmd/safe.d:475 — `bool setUnsafe(Scope* sc, bool gag, Loc loc, VarDeclaration scopeVar,`
 * The `scopeVar` overload (04 §1 Form B, inserted-parameter suffix); the format and args follow.
 *
 * Overload that also stores the variable whose scope status caused the violation.
 *
 * Outcomes, in D's order: permissive in `typeof(…)` and `debug` scopes; outside a function, a
 * `@safe` variable initializer is an error and any other non-`@trusted` variable is inferred
 * `@system`; inside the root `__traits(compiles)` scope only a `@safe` function errors (the
 * message is gagged but counted); otherwise the function is committed to `@system` if inferring,
 * a violation is reported or recorded, and the result is true only for a `@safe` function.
 */
export function setUnsafeScopeVar(sc: Scope, gag: boolean, loc: Loc, scopeVar: VarDeclaration | null,
    format: DString | null, ...args: (RootObject | null)[]): boolean {
    if (sc.intypeof !== 0)
        return false; // typeof(cast(int*)0) is safe

    if (sc.debug_) // debug {} scopes are permissive
        return false;

    if (sc.func === null) {
        if (sc.varDecl !== null) {
            if ((sc.varDecl.storage_class & STC.safe) !== 0n) {
                // D hands `format` to `AttributeViolation`'s printf unchecked (a null format is UB there);
                // `format!` makes the port throw where D would pass null to vsnprintf.
                const action: DString = AttributeViolation.fromFormat(loc, format!, args).action!;
                error(loc, ds("%.*s can't initialize `@safe` variable `%s`"), ...fTuple(action), sc.varDecl.toChars());
                return true;
            } else if ((sc.varDecl.storage_class & STC.trusted) === 0n) {
                // branded STC: re-cast after | (02 §4.2)
                sc.varDecl.storage_class = (sc.varDecl.storage_class | STC.system) as STC;
                sc.varDecl.systemInferred = true;
            }
        }
        return false;
    }


    if (isRootTraitsCompilesScope(sc)) { // __traits(compiles, x)
        if (isSafeBypassingInference(sc.func)) {
            // Message wil be gagged, but still call error() to update global.errors and for
            // -verrors=spec
            // NULL FORMAT: D hands `format` to `AttributeViolation`'s printf unchecked. typesem.d:2429
            // (`sc.setUnsafe(false, arg.loc, null)`, isCopyConstructorCallable) reaches this arm with a null
            // format under `__traits(compiles)` in a `@safe` function, and ldc2 1.43.0 itself SEGFAULTS there
            // (exit 139; stack: vsnprintf <- OutBuffer::printf <- AttributeViolation.__ctor <- safe.setUnsafe
            // <- typesem.isCopyConstructorCallable). `format!` makes the port throw instead. The oracle crashes
            // on this path, so it cannot be pinned against ldc2 (see the escalation record for this site).
            const action: DString = AttributeViolation.fromFormat(loc, format!, args).action!;
            error(loc, ds("%.*s is not allowed in a `@safe` function"), ...fTuple(action));
            return true;
        }
        return false;
    }

    if (setFunctionToUnsafe(sc.func)) {
        if (format !== null || args.length > 0) {
            reportSafeError(sc.func, gag, loc, scopeVar, format, ...args);
        }
        return isSafe(sc.func); // it is only an error if in an @safe function
    }
    return false;
}

/***************************************
 * dmd/safe.d:547 — `bool setUnsafePreview(Scope* sc, FeatureState fs, bool gag, Loc loc, const(char)* format,`
 * The `scopeVar`-less overload (the variadic args follow); forwards to
 * `setUnsafePreviewScopeVar` with a null `scopeVar`.
 *
 * Like `setUnsafe`, but for safety errors still behind preview switches
 *
 * Given a `FeatureState fs`, for example dip1000 / dip25 / systemVariables,
 * the behavior changes based on the setting:
 *
 * - In case of `-revert=fs`, it does nothing.
 * - In case of `-preview=fs`, it's the same as `setUnsafe`
 * - By default, print a deprecation in `@safe` functions, or store an attribute violation in inferred functions.
 *
 * Params:
 *   sc = used to find affected function/variable, and for checking whether we are in a deprecated / speculative scope
 *   fs = feature state from the preview flag
 *   gag = surpress error message
 *   loc = location of error
 *   format = printf-style format string
 *   args  = arguments for format string
 * Returns: whether an actual safe error (not deprecation) occured
 */
export function setUnsafePreview(sc: Scope, fs: FeatureState, gag: boolean, loc: Loc, format: DString,
    ...args: (RootObject | null)[]): boolean {
    return setUnsafePreviewScopeVar(sc, fs, gag, loc, null, format, ...args);
}

/**
 * dmd/safe.d:553 — `bool setUnsafePreview(Scope* sc, FeatureState fs, bool gag, Loc loc, VarDeclaration scopeVar,`
 * The `scopeVar` overload (04 §1 Form B, inserted-parameter suffix); the format and args follow.
 * Its only D caller outside this file is escape.d:2222.
 *
 * Overload for scope violations that also stores the variable whose scope status caused the issue.
 * Precondition: `format` is non-null (D `assert(format)`). In the `default_` state the first
 * violation recorded on an inferring function wins; later ones are dropped.
 */
export function setUnsafePreviewScopeVar(sc: Scope, fs: FeatureState, gag: boolean, loc: Loc,
    scopeVar: VarDeclaration | null, format: DString, ...args: (RootObject | null)[]): boolean {
    //printf("setUnsafePreview() fs:%d %s\n", fs, fmt);
    assert(format !== null);
    // resolved: with(FeatureState) -> labels re-qualified (06 §3.3)
    switch (fs) {
        case FeatureState.disabled:
            return false;

        case FeatureState.enabled:
            return setUnsafeScopeVar(sc, gag, loc, scopeVar, format, ...args);

        case FeatureState.default_:
            if (sc.func === null)
                return false;
            if (isSafeBypassingInference(sc.func)) {
                if (!gag && !sc.isDeprecated()) {
                    const action: DString = AttributeViolation.fromFormat(loc, format, args).action!;
                    deprecation(loc, ds("%.*s will become `@system` in a future release"), ...fTuple(action));
                }
            } else if (sc.func.safetyViolation === null) {
                // resolved: function-local `import dmd.func : AttributeViolation;` hoisted to the top (01 Rule 4.4)
                if (scopeVar !== null)
                    sc.func.safetyViolation = AttributeViolation.fromFormatScopeVar(loc, format, scopeVar, args);
                else
                    sc.func.safetyViolation = AttributeViolation.fromFormat(loc, format, args);
            }
            return false;

        default: {
            // final switch: D throws SwitchError on an unhandled value
            const _exhaustive: never = fs; void _exhaustive;
            throw new SwitchError();
        }
    }
}

