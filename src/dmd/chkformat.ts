// Ported from dmd/chkformat.d (module dmd.chkformat) — LDC 1.43.0 final.
//
// Check the arguments to `printf` and `scanf` against the `format` string.
//
// WHOLE-FILE faithful structural translation. chkformat.d declares EIGHT top-level declarations, emitted here in
// D source order: `isFormatSafe` (chkformat.d:37), `checkPrintfFormat` (:99), `checkScanfFormat` (:375),
// `parseScanfFormatSpecifier` (:582), `parsePrintfFormatSpecifier` (:734), `enum Modifier` (:905),
// `enum Format` (:926), `parseGenericFormatSpecifier` (:979), plus the three `unittest` blocks
// (:1125, :1146, :1254), which live in chkformat.test.ts (10 §1). Nothing is walled or dropped.
//
// VISIBILITY (01 §2.5 / 10 §1.7). Everything after `private:` (chkformat.d:566) is module-private in D;
// the ported unittests reach the three parsers and both enums, so they are exported, each carrying the
// `// D module-private` marker on the line above its declaration.
//
// IMPORTS. `core.stdc.ctype : isdigit` (chkformat.d:14) becomes the local C-locale byte predicate below
// (dmacro.ts precedent). The whole-module imports at :16-25 become the named imports listing exactly the
// symbols used (01 §3.1); `dmd.astenums` (TY constants), `dmd.cond` (`findCondition`), `dmd.errorsink`,
// `dmd.expression`, `dmd.globals`, `dmd.identifier`, `dmd.location`, `dmd.mtype`, `dmd.typesem` and
// `dmd.target` all contribute a symbol.
//
// TYPE MODEL. `const char[]` format strings are `DString` byte views (08 §0); D `char` comparisons are
// byte comparisons against the ASCII code, written `0x25 /* '%' */`. `size_t` indices are `number`.
// `ref size_t idx` / `out bool` / `out char` parameters are `Ref<T>` boxes (03 §3.3): the `out` ones are
// reset to `T.init` on entry (`false`, and `char.init` = 0xFF).
//
// TARGET. The widths come from the live `target`, the same on every supported triple: `target.c.longsize` 8,
// `target.ptrsize` 8, `target.c.wchar_tsize` 4. `typesem.size` returns a `bigint`, so the D comparisons
// `t.size() == c_longsize` compare against `BigInt(c_longsize)`.

import { SwitchError, assert, assertUnreachable } from "../assert.js";
import { ds } from "../dstring.js";
import type { DString } from "../dstring.js";
import {
    Taarray, Tchar, Tclass, Tdelegate, Tfloat32, Tfloat64, Tfloat80, Timaginary64, Timaginary80, Tint16,
    Tint32, Tint64, Tint8, Tnull, Tpointer, Tuns16, Tuns32, Tuns64, Tuns8,
} from "./astenums.js";
import { findCondition } from "./cond.js";
import type { ErrorSink } from "./errorsink.js";
import type { Expression } from "./expression.js";
import { global } from "./globals.js";
import { Identifier } from "./identifier.js";
import type { Loc } from "./location.js";
import { isSomeChar } from "./mtype.js";
import type { Type } from "./mtype.js";
import { target } from "./target.js";
import { isIntegral, isUnsigned, nextOf, size, toBasetype } from "./typesem.js";

/** Single-slot box for a D `ref` / `out` scalar parameter (03 §3.3). */
interface Ref<T> {
    value: T;
}

/// C `isdigit` (core.stdc.ctype, C locale): ASCII '0'..'9'.
function isdigit(c: number): boolean {
    return c >= 0x30 && c <= 0x39;
}

/**********************************************
 * dmd/chkformat.d:37 — `bool isFormatSafe(scope const char[] format)`.
 *
 * While in general printf is not @safe (and should be marked @system), many uses of printf are safe.
 * This function determines if a particular call of printf is safe.
 * Params:
 *      format = printf format string
 * Returns:
 *      true if @safe (no `%s`, `%ls`, or invalid specifier in `format`)
 */
export function isFormatSafe(format: DString): boolean {
    //printf("isFormatSafe('%.*s')\n", cast(int)format.length, format.ptr);
    /* Only need to check the format string, any other errors are checked
     * for later with checkPrintfFormat()
     */
    for (let i = 0; i < format.length;) {
        if (format[i] !== 0x25 /* '%' */) {
            ++i;
            continue;
        }
        const widthStar: Ref<boolean> = { value: false };
        const precisionStar: Ref<boolean> = { value: false };
        const j: Ref<number> = { value: i };
        const fmt = parsePrintfFormatSpecifier(format, j, widthStar, precisionStar);
        i = j.value;
        if (fmt === Format.s || fmt === Format.ls || fmt === Format.error)
            return false;
    }
    return true;
}

/******************************************
 * dmd/chkformat.d:99 — `bool checkPrintfFormat(Loc loc, scope const char[] format, scope Expression[] args,`.
 *
 * Check that arguments to a printf format string are compatible
 * with that string. Issue errors for incompatibilities.
 *
 * Follows the C99 specification for printf.
 *
 * Takes a generous, rather than strict, view of compatiblity.
 * For example, an unsigned value can be formatted with a signed specifier.
 *
 * Diagnosed incompatibilities are:
 *
 * 1. incompatible sizes which will cause argument misalignment
 * 2. deferencing arguments that are not pointers
 * 3. insufficient number of arguments
 * 4. struct arguments
 * 5. array and slice arguments
 * 6. non-pointer arguments to `s` specifier
 * 7. non-standard formats
 * 8. undefined behavior per C99
 *
 * Per the C Standard, extra arguments are ignored.
 *
 * No attempt is made to fix the arguments or the format string.
 *
 * All diagnostics are DEPRECATIONS (plus one `errorSupplemental`) sent to `eSink`.
 *
 * Params:
 *      loc = location for error messages
 *      format = format string
 *      args = arguments to match with format string (each must carry a semantic `type`)
 *      isVa_list = if a "v" function (format check only)
 *      eSink = where the error messages go (non-null)
 *
 * Returns:
 *      `true` if errors occurred (more specifiers than arguments, or a null argument)
 * References:
 * C99 7.19.6.1
 * https://www.cplusplus.com/reference/cstdio/printf/
 */
export function checkPrintfFormat(loc: Loc, format: DString, args: ReadonlyArray<Expression | null>,
                                  isVa_list: boolean, eSink: ErrorSink | null): boolean {
    //printf("checkPrintfFormat('%.*s')\n", cast(int)format.length, format.ptr);
    let n = 0;    // index in args
    for (let i = 0; i < format.length;) {
        if (format[i] !== 0x25 /* '%' */) {
            ++i;
            continue;
        }
        const widthStar: Ref<boolean> = { value: false };
        const precisionStar: Ref<boolean> = { value: false };
        const j: Ref<number> = { value: i };
        const fmt = parsePrintfFormatSpecifier(format, j, widthStar, precisionStar);
        const slice = format.subarray(i, j.value);
        i = j.value;

        if (fmt === Format.percent)
            continue;                   // "%%", no arguments
        if (fmt === Format.GNU_m)
            continue;                   // "%m", no arguments

        if (isVa_list) {
            // format check only
            if (fmt === Format.error)
                eSink!.deprecation(loc, ds("format specifier `\"%.*s\"` is invalid"), slice.length, slice);
            continue;
        }

        // dmd/chkformat.d:130 — `Expression getNextArg(ref bool skip)` (nested; captures `n`, `args`).
        const getNextArg = (skip: Ref<boolean>): Expression | null => {
            if (n === args.length) {
                if (args.length < (n + 1))
                    eSink!.deprecation(loc, ds("more format specifiers than %d arguments"), n);
                else
                    skip.value = true;
                return null;
            }
            return args[n++];
        };

        // dmd/chkformat.d:143 — `void errorMsg(const char* prefix, Expression arg, const char* texpect,`
        const errorMsg = (prefix: DString | null, arg: Expression, texpect: DString, tactual: Type): void => {
            eSink!.deprecation(arg.loc,
                ds("%sargument `%s` for format specification `\"%.*s\"` must be `%s`, not `%s`"),
                prefix !== null ? prefix : ds(""), arg.toChars(), slice.length, slice, texpect, tactual.toChars());
        };

        if (widthStar.value) {
            const skip: Ref<boolean> = { value: false };
            const e = getNextArg(skip);
            if (skip.value)
                continue;
            if (e === null)
                return true;
            const t = toBasetype(e.type!);
            if (t.ty !== Tint32 && t.ty !== Tuns32)
                errorMsg(ds("width "), e, ds("int"), t);
        }

        if (precisionStar.value) {
            const skip: Ref<boolean> = { value: false };
            const e = getNextArg(skip);
            if (skip.value)
                continue;
            if (e === null)
                return true;
            const t = toBasetype(e.type!);
            if (t.ty !== Tint32 && t.ty !== Tuns32)
                errorMsg(ds("precision "), e, ds("int"), t);
        }

        const skip: Ref<boolean> = { value: false };
        const e = getNextArg(skip);
        if (skip.value)
            continue;
        if (e === null)
            return true;
        const t = toBasetype(e.type!);
        const tnext = nextOf(t);
        const c_longsize = target.c.longsize;
        const ptrsize = target.ptrsize;

        // Types which are promoted to int are allowed.
        // Spec: C99 6.5.2.2.7
        switch (fmt) {
            case Format.u:      // unsigned int
            case Format.d:      // int
                if (t.ty !== Tint32 && t.ty !== Tuns32)
                    errorMsg(null, e, fmt === Format.u ? ds("uint") : ds("int"), t);
                break;

            case Format.hhu:    // unsigned char
            case Format.hhd:    // signed char
                if (t.ty !== Tint32 && t.ty !== Tuns32 && t.ty !== Tint8 && t.ty !== Tuns8)
                    errorMsg(null, e, fmt === Format.hhu ? ds("ubyte") : ds("byte"), t);
                break;

            case Format.hu:     // unsigned short int
            case Format.hd:     // short int
                if (t.ty !== Tint32 && t.ty !== Tuns32 && t.ty !== Tint16 && t.ty !== Tuns16)
                    errorMsg(null, e, fmt === Format.hu ? ds("ushort") : ds("short"), t);
                break;

            case Format.lu:     // unsigned long int
            case Format.ld:     // long int
                if (!(isIntegral(t) && size(t) === BigInt(c_longsize))) {
                    if (fmt === Format.lu)
                        errorMsg(null, e, (c_longsize === 4 ? ds("uint") : ds("ulong")), t);
                    else
                        errorMsg(null, e, (c_longsize === 4 ? ds("int") : ds("long")), t);
                    if (isIntegral(t) && size(t) !== BigInt(c_longsize))
                        eSink!.errorSupplemental(e.loc, ds("C `long` is %d bytes on your system"), c_longsize);
                }
                break;

            case Format.llu:    // unsigned long long int
            case Format.lld:    // long long int
                if (t.ty !== Tint64 && t.ty !== Tuns64)
                    errorMsg(null, e, fmt === Format.llu ? ds("ulong") : ds("long"), t);
                break;

            case Format.ju:     // uintmax_t
            case Format.jd:     // intmax_t
                if (t.ty !== Tint64 && t.ty !== Tuns64) {
                    if (fmt === Format.ju)
                        errorMsg(null, e, ds("core.stdc.stdint.uintmax_t"), t);
                    else
                        errorMsg(null, e, ds("core.stdc.stdint.intmax_t"), t);
                }
                break;

            case Format.zd:     // size_t
                if (!(isIntegral(t) && size(t) === BigInt(ptrsize)))
                    errorMsg(null, e, ds("size_t"), t);
                break;

            case Format.td:     // ptrdiff_t
                if (!(isIntegral(t) && size(t) === BigInt(ptrsize)))
                    errorMsg(null, e, ds("ptrdiff_t"), t);
                break;

            case Format.lg:
            case Format.g:      // double
                if (t.ty !== Tfloat64 && t.ty !== Timaginary64)
                    errorMsg(null, e, ds("double"), t);
                break;

            case Format.Lg:     // long double
                if (t.ty !== Tfloat80 && t.ty !== Timaginary80)
                    errorMsg(null, e, ds("real"), t);
                break;

            case Format.p:      // pointer
                if (t.ty !== Tpointer && t.ty !== Tnull && t.ty !== Tclass && t.ty !== Tdelegate && t.ty !== Taarray)
                    errorMsg(null, e, ds("void*"), t);
                break;

            case Format.n:      // pointer to int
                if (!(t.ty === Tpointer && tnext!.ty === Tint32 && tnext!.isMutable()))
                    errorMsg(null, e, ds("int*"), t);
                break;

            case Format.ln:     // pointer to long int
                if (!(t.ty === Tpointer && isIntegral(tnext!) && size(tnext!) === BigInt(c_longsize)))
                    errorMsg(null, e, (c_longsize === 4 ? ds("int*") : ds("long*")), t);
                break;

            case Format.lln:    // pointer to long long int
                if (!(t.ty === Tpointer && tnext!.ty === Tint64))
                    errorMsg(null, e, ds("long*"), t);
                break;

            case Format.hn:     // pointer to short
                if (!(t.ty === Tpointer && tnext!.ty === Tint16))
                    errorMsg(null, e, ds("short*"), t);
                break;

            case Format.hhn:    // pointer to signed char
                // D checks `Tint16` here (not `Tint8`), verbatim (chkformat.d:285).
                if (!(t.ty === Tpointer && tnext!.ty === Tint16))
                    errorMsg(null, e, ds("byte*"), t);
                break;

            case Format.jn:     // pointer to intmax_t
                if (!(t.ty === Tpointer && tnext!.ty === Tint64))
                    errorMsg(null, e, ds("core.stdc.stdint.intmax_t*"), t);
                break;

            case Format.zn:     // pointer to size_t
                if (!(t.ty === Tpointer && isIntegral(tnext!) && isUnsigned(tnext!)
                        && size(tnext!) === BigInt(ptrsize)))
                    errorMsg(null, e, ds("size_t*"), t);
                break;

            case Format.tn:     // pointer to ptrdiff_t
                if (!(t.ty === Tpointer && isIntegral(tnext!) && !isUnsigned(tnext!)
                        && size(tnext!) === BigInt(ptrsize)))
                    errorMsg(null, e, ds("ptrdiff_t*"), t);
                break;

            case Format.c:      // char
                if (t.ty !== Tint32 && t.ty !== Tuns32)
                    errorMsg(null, e, ds("char"), t);
                break;

            case Format.lc:     // wint_t
                if (t.ty !== Tint32 && t.ty !== Tuns32)
                    errorMsg(null, e, ds("wchar_t"), t);
                break;

            case Format.s:      // pointer to char string
                if (!(t.ty === Tpointer && (tnext!.ty === Tchar || tnext!.ty === Tint8 || tnext!.ty === Tuns8)))
                    errorMsg(null, e, ds("char*"), t);
                break;

            case Format.ls:     // pointer to wchar_t string
                if (!(t.ty === Tpointer && isSomeChar(tnext!.ty) && size(tnext!) === BigInt(target.c.wchar_tsize)))
                    errorMsg(null, e, ds("wchar_t*"), t);
                break;

            case Format.error:
                eSink!.deprecation(loc, ds("format specifier `\"%.*s\"` is invalid"), slice.length, slice);
                break;

            // D lists `Format.GNU_m` and `Format.percent` in this `assert(0)` arm too (chkformat.d:328-331); both are
            // excluded by the `continue`s above, TS narrows `fmt` accordingly and rejects their case labels
            // (TS2678), so only the two arms TS still considers reachable are spelled here.
            case Format.POSIX_ms:
            case Format.POSIX_mls:
                assertUnreachable();

            default: {
                // final switch: D throws SwitchError on an unhandled value (06 §3.2)
                const _exhaustive: never = fmt; void _exhaustive;
                throw new SwitchError();
            }
        }
    }
    return false;
}

/******************************************
 * dmd/chkformat.d:375 — `bool checkScanfFormat(Loc loc, scope const char[] format, scope Expression[] args,`.
 *
 * Check that arguments to a scanf format string are compatible
 * with that string. Issue errors for incompatibilities.
 *
 * Follows the C99 specification for scanf.
 *
 * Takes a generous, rather than strict, view of compatiblity.
 * For example, an unsigned value can be formatted with a signed specifier.
 *
 * Diagnosed incompatibilities are:
 *
 * 1. incompatible sizes which will cause argument misalignment
 * 2. deferencing arguments that are not pointers
 * 3. insufficient number of arguments
 * 4. struct arguments
 * 5. array and slice arguments
 * 6. non-standard formats
 * 7. undefined behavior per C99
 *
 * Per the C Standard, extra arguments are ignored.
 *
 * No attempt is made to fix the arguments or the format string.
 *
 * All diagnostics are DEPRECATIONS sent to `eSink`.
 *
 * Params:
 *      loc = location for error messages
 *      format = format string
 *      args = arguments to match with format string (each must carry a semantic `type`)
 *      isVa_list = if a "v" function (format check only)
 *      eSink = where the error messages go (non-null)
 *
 * Returns:
 *      `true` if errors occurred (more specifiers than arguments, or a null argument)
 * References:
 * C99 7.19.6.2
 * https://www.cplusplus.com/reference/cstdio/scanf/
 */
export function checkScanfFormat(loc: Loc, format: DString, args: ReadonlyArray<Expression | null>,
                                 isVa_list: boolean, eSink: ErrorSink | null): boolean {
    let n = 0;
    for (let i = 0; i < format.length;) {
        if (format[i] !== 0x25 /* '%' */) {
            ++i;
            continue;
        }
        const asterisk: Ref<boolean> = { value: false };
        const j: Ref<number> = { value: i };
        const fmt = parseScanfFormatSpecifier(format, j, asterisk);
        const slice = format.subarray(i, j.value);
        i = j.value;

        if (fmt === Format.percent || asterisk.value)
            continue;   // "%%", "%*": no arguments

        if (isVa_list) {
            // format check only
            if (fmt === Format.error)
                eSink!.deprecation(loc, ds("format specifier `\"%.*s\"` is invalid"), slice.length, slice);
            continue;
        }

        // dmd/chkformat.d:402 — `Expression getNextArg()` (nested; captures `n`, `args`, `asterisk`).
        const getNextArg = (): Expression | null => {
            if (n === args.length) {
                if (!asterisk.value)
                    eSink!.deprecation(loc, ds("more format specifiers than %d arguments"), n);
                return null;
            }
            return args[n++];
        };

        // dmd/chkformat.d:413 — `void errorMsg(const char* prefix, Expression arg, const char* texpect,`
        const errorMsg = (prefix: DString | null, arg: Expression, texpect: DString, tactual: Type): void => {
            eSink!.deprecation(arg.loc,
                ds("%sargument `%s` for format specification `\"%.*s\"` must be `%s`, not `%s`"),
                prefix !== null ? prefix : ds(""), arg.toChars(), slice.length, slice, texpect, tactual.toChars());
        };

        const e = getNextArg();
        if (e === null)
            return true;

        const t = toBasetype(e.type!);
        const tnext = nextOf(t);
        const c_longsize = target.c.longsize;
        const ptrsize = target.ptrsize;

        switch (fmt) {
            case Format.n:
            case Format.d:      // pointer to int
                if (!(t.ty === Tpointer && tnext!.ty === Tint32))
                    errorMsg(null, e, ds("int*"), t);
                break;

            case Format.hhn:
            case Format.hhd:    // pointer to signed char
                // D checks `Tint16` here (not `Tint8`), verbatim (chkformat.d:438).
                if (!(t.ty === Tpointer && tnext!.ty === Tint16))
                    errorMsg(null, e, ds("byte*"), t);
                break;

            case Format.hn:
            case Format.hd:     // pointer to short
                if (!(t.ty === Tpointer && tnext!.ty === Tint16))
                    errorMsg(null, e, ds("short*"), t);
                break;

            case Format.ln:
            case Format.ld:     // pointer to long int
                if (!(t.ty === Tpointer && isIntegral(tnext!) && !isUnsigned(tnext!)
                        && size(tnext!) === BigInt(c_longsize)))
                    errorMsg(null, e, (c_longsize === 4 ? ds("int*") : ds("long*")), t);
                break;

            case Format.lln:
            case Format.lld:    // pointer to long long int
                if (!(t.ty === Tpointer && tnext!.ty === Tint64))
                    errorMsg(null, e, ds("long*"), t);
                break;

            case Format.jn:
            case Format.jd:     // pointer to intmax_t
                if (!(t.ty === Tpointer && tnext!.ty === Tint64))
                    errorMsg(null, e, ds("core.stdc.stdint.intmax_t*"), t);
                break;

            case Format.zn:
            case Format.zd:     // pointer to size_t
                if (!(t.ty === Tpointer && isIntegral(tnext!) && isUnsigned(tnext!)
                        && size(tnext!) === BigInt(ptrsize)))
                    errorMsg(null, e, ds("size_t*"), t);
                break;

            case Format.tn:
            case Format.td:     // pointer to ptrdiff_t
                if (!(t.ty === Tpointer && isIntegral(tnext!) && !isUnsigned(tnext!)
                        && size(tnext!) === BigInt(ptrsize)))
                    errorMsg(null, e, ds("ptrdiff_t*"), t);
                break;

            case Format.u:      // pointer to unsigned int
                if (!(t.ty === Tpointer && tnext!.ty === Tuns32))
                    errorMsg(null, e, ds("uint*"), t);
                break;

            case Format.hhu:    // pointer to unsigned char
                if (!(t.ty === Tpointer && tnext!.ty === Tuns8))
                    errorMsg(null, e, ds("ubyte*"), t);
                break;

            case Format.hu:     // pointer to unsigned short int
                if (!(t.ty === Tpointer && tnext!.ty === Tuns16))
                    errorMsg(null, e, ds("ushort*"), t);
                break;

            case Format.lu:     // pointer to unsigned long int
                if (!(t.ty === Tpointer && isIntegral(tnext!) && isUnsigned(tnext!)
                        && size(tnext!) === BigInt(c_longsize)))
                    errorMsg(null, e, (c_longsize === 4 ? ds("uint*") : ds("ulong*")), t);
                break;

            case Format.llu:    // pointer to unsigned long long int
                if (!(t.ty === Tpointer && tnext!.ty === Tuns64))
                    errorMsg(null, e, ds("ulong*"), t);
                break;

            case Format.ju:     // pointer to uintmax_t
                if (!(t.ty === Tpointer && tnext!.ty === Tuns64))
                    errorMsg(null, e, ds("core.stdc.stdint.uintmax_t*"), t);
                break;

            case Format.g:      // pointer to float
                if (!(t.ty === Tpointer && tnext!.ty === Tfloat32))
                    errorMsg(null, e, ds("float*"), t);
                break;

            case Format.lg:     // pointer to double
                if (!(t.ty === Tpointer && tnext!.ty === Tfloat64))
                    errorMsg(null, e, ds("double*"), t);
                break;

            case Format.Lg:     // pointer to long double
                if (!(t.ty === Tpointer && tnext!.ty === Tfloat80))
                    errorMsg(null, e, ds("real*"), t);
                break;

            case Format.c:
            case Format.s:      // pointer to char string
                if (!(t.ty === Tpointer && (tnext!.ty === Tchar || tnext!.ty === Tint8 || tnext!.ty === Tuns8)))
                    errorMsg(null, e, ds("char*"), t);
                break;

            case Format.lc:
            case Format.ls:     // pointer to wchar_t string
                if (!(t.ty === Tpointer && isSomeChar(tnext!.ty) && size(tnext!) === BigInt(target.c.wchar_tsize)))
                    errorMsg(null, e, ds("wchar_t*"), t);
                break;

            case Format.p:      // double pointer
                if (!(t.ty === Tpointer && tnext!.ty === Tpointer))
                    errorMsg(null, e, ds("void**"), t);
                break;

            case Format.POSIX_ms: { // pointer to pointer to char string
                const tnext2: Type | null = tnext !== null ? nextOf(tnext) : null;
                if (!(t.ty === Tpointer && tnext!.ty === Tpointer
                        && (tnext2!.ty === Tchar || tnext2!.ty === Tint8 || tnext2!.ty === Tuns8)))
                    errorMsg(null, e, ds("char**"), t);
                break;
            }

            case Format.POSIX_mls: { // pointer to pointer to wchar_t string
                const tnext2: Type | null = tnext !== null ? nextOf(tnext) : null;
                if (!(t.ty === Tpointer && tnext!.ty === Tpointer && isSomeChar(tnext2!.ty)
                        && size(tnext2!) === BigInt(target.c.wchar_tsize)))
                    errorMsg(null, e, ds("wchar_t**"), t);
                break;
            }

            case Format.error:
                eSink!.deprecation(loc, ds("format specifier `\"%.*s\"` is invalid"), slice.length, slice);
                break;

            // D lists `Format.percent` in this `assert(0)` arm too (chkformat.d:557); the `continue` above excludes
            // it, TS narrows `fmt` accordingly and rejects its case label (TS2678).
            case Format.GNU_m:
                assertUnreachable();

            default: {
                // final switch: D throws SwitchError on an unhandled value (06 §3.2)
                const _exhaustive: never = fmt; void _exhaustive;
                throw new SwitchError();
            }
        }
    }
    return false;
}

/*****************************************************************************************************/

// dmd/chkformat.d:566 — `private:` — every declaration below is module-private in D.

/**************************************
 * dmd/chkformat.d:582 — `Format parseScanfFormatSpecifier(scope const char[] format, ref size_t idx,`.
 *
 * Parse the *format specifier* which is of the form:
 *
 * `%[*][width][length]specifier`
 *
 * Params:
 *      format = format string
 *      idx = index of `%` of start of format specifier,
 *          which gets updated to index past the end of it,
 *          even if `Format.error` is returned
 *      asterisk = (out) set if there is a `*` sub-specifier
 * Returns:
 *      Format
 *
 * Control flow: the `'m'` and `'l'` arms jump into the NON-adjacent `'['` arm (chkformat.d:651, :664),
 * which is also entered directly and either returns `error()` or breaks — the SHARED-ARM with a VALUED
 * tail shape (06 §4): `scansetArm` returns `{ returned, value }` and every entry tests it. The `'l'` arm
 * also jumps (:666) to the non-adjacent `default:` arm, which can return too — same shape, `defaultArm`.
 */
// D module-private
export function parseScanfFormatSpecifier(format: DString, idx: Ref<number>, asterisk: Ref<boolean>): Format {
    asterisk.value = false;     // `out bool` reset on entry (03 §3.3)
    let i = idx.value;
    assert(format[i] === 0x25 /* '%' */);
    const length = format.length;

    // dmd/chkformat.d:589 — `Format error()`
    const error = (): Format => {
        idx.value = i;
        return Format.error;
    };

    ++i;
    if (i === length)
        return error();

    if (format[i] === 0x25 /* '%' */) {
        idx.value = i + 1;
        return Format.percent;
    }

    // * sub-specifier
    if (format[i] === 0x2a /* '*' */) {
        ++i;
        if (i === length)
            return error();
        asterisk.value = true;
    }

    // fieldWidth
    while (isdigit(format[i])) {
        i++;
        if (i === length)
            return error();
    }

    /* Read the specifier
     */
    let specifier: Format = Format.d;   // `Format specifier;` — Format.init is the first member
    let flags: Modifier = Modifier.none;

    // dmd/chkformat.d:668 — `case '[':` body (the scanset). `returned` = the arm executed `return error()`.
    const scansetArm = (): { returned: boolean; value: Format } => {
        // Read the scanset
        i++;
        if (i === length)
            return { returned: true, value: error() };
        // If the conversion specifier begins with `[]` or `[^]`, the right
        // bracket character is not the terminator, but in the scanlist.
        if (format[i] === 0x5e /* '^' */) {
            i++;
            if (i === length)
                return { returned: true, value: error() };
        }
        if (format[i] === 0x5d /* ']' */) {
            i++;
            if (i === length)
                return { returned: true, value: error() };
        }
        // A scanset can be anything, so we just check that it is paired
        while (i < length) {
            if (format[i] === 0x5d /* ']' */)
                break;
            ++i;
        }
        // no `]` found
        if (i === length)
            return { returned: true, value: error() };

        specifier = flags === Modifier.none ? Format.s         :
                    flags === Modifier.l    ? Format.ls        :
                    flags === Modifier.m    ? Format.POSIX_ms  :
                    flags === Modifier.ml   ? Format.POSIX_mls :
                                              Format.error;
        ++i;
        return { returned: false, value: specifier };
    };

    // dmd/chkformat.d:706 — `default:` body.
    const defaultArm = (): { returned: boolean; value: Format } => {
        const genSpec: Ref<number> = { value: 0xff };
        const iBox: Ref<number> = { value: i };
        specifier = parseGenericFormatSpecifier(format, iBox, genSpec);
        i = iBox.value;
        if (specifier === Format.error)
            return { returned: true, value: error() };
        return { returned: false, value: specifier };
    };

    switch (format[i]) {
        case 0x6d /* 'm' */: {
            // https://pubs.opengroup.org/onlinepubs/9699919799/functions/scanf.html
            // POSIX.1-2017 C Extension (CX)
            flags = Modifier.m;
            ++i;
            if (i === length)
                return error();
            if (format[i] === 0x6c /* 'l' */) {
                ++i;
                if (i === length)
                    return error();
                flags = Modifier.ml;
            }

            // Check valid conversion types for %m.
            if (format[i] === 0x63 /* 'c' */ || format[i] === 0x73 /* 's' */)
                specifier = flags === Modifier.ml ? Format.POSIX_mls :
                                                    Format.POSIX_ms;
            else if (format[i] === 0x43 /* 'C' */ || format[i] === 0x53 /* 'S' */)
                specifier = flags === Modifier.m ? Format.POSIX_mls :
                                                   Format.error;
            else if (format[i] === 0x5b /* '[' */) {
                // goto case '['; (dmd/chkformat.d:651)
                const r = scansetArm();
                if (r.returned)
                    return r.value;
                break;
            }
            else
                specifier = Format.error;
            ++i;
            break;
        }

        case 0x6c /* 'l' */: {
            // Look for wchar_t scanset %l[..]
            const j = i + 1;
            if (j < length && format[j] === 0x5b /* '[' */) {
                i = j;
                flags = Modifier.l;
                // goto case '['; (dmd/chkformat.d:664)
                const r = scansetArm();
                if (r.returned)
                    return r.value;
                break;
            }
            // goto default; (dmd/chkformat.d:666)
            const r = defaultArm();
            if (r.returned)
                return r.value;
            break;
        }

        case 0x5b /* '[' */: {
            const r = scansetArm();
            if (r.returned)
                return r.value;
            break;
        }

        default: {
            const r = defaultArm();
            if (r.returned)
                return r.value;
            break;
        }
    }

    idx.value = i;
    return specifier;  // success
}

/**************************************
 * dmd/chkformat.d:734 — `Format parsePrintfFormatSpecifier(scope const char[] format, ref size_t idx,`.
 *
 * Parse the *format specifier* which is of the form:
 *
 * `%[flags][field width][.precision][length modifier]specifier`
 *
 * Params:
 *      format = format string
 *      idx = index of `%` of start of format specifier,
 *          which gets updated to index past the end of it,
 *          even if `Format.error` is returned
 *      widthStar = (out) set if * for width
 *      precisionStar = (out) set if * for precision
 *      useGNUExts = true if parsing GNU format extensions; the default (evaluated per call, 04 §2) is
 *          whether the `CRuntime_Glibc` version identifier is set — false on arm64-apple-darwin, true on the
 *          Linux triples
 * Returns:
 *      Format
 */
// D module-private
export function parsePrintfFormatSpecifier(format: DString, idx: Ref<number>, widthStar: Ref<boolean>,
        precisionStar: Ref<boolean>,
        useGNUExts: boolean = findCondition(global.versionids, Identifier.idPool(ds("CRuntime_Glibc")))): Format {
    widthStar.value = false;        // `out bool` reset on entry (03 §3.3)
    precisionStar.value = false;
    let i = idx.value;
    assert(format[i] === 0x25 /* '%' */);
    const length = format.length;
    let hash = false;
    let zero = false;
    let flags = false;
    let width = false;
    let precision = false;

    // dmd/chkformat.d:747 — `Format error()`
    const error = (): Format => {
        idx.value = i;
        return Format.error;
    };

    ++i;
    if (i === length)
        return error();

    if (format[i] === 0x25 /* '%' */) {
        idx.value = i + 1;
        return Format.percent;
    }

    /* Read the `flags`
     */
    while (1) {
        const c = format[i];
        if (c === 0x2d /* '-' */ ||
            c === 0x2b /* '+' */ ||
            c === 0x20 /* ' ' */) {
            flags = true;
        }
        else if (c === 0x23 /* '#' */) {
            hash = true;
        }
        else if (c === 0x30 /* '0' */) {
            zero = true;
        }
        else
            break;
        ++i;
        if (i === length)
            return error();
    }

    /* Read the `field width`
     */
    {
        const c = format[i];
        if (c === 0x2a /* '*' */) {
            width = true;
            widthStar.value = true;
            ++i;
            if (i === length)
                return error();
        }
        else if (0x31 /* '1' */ <= c && c <= 0x39 /* '9' */) {
            width = true;
            ++i;
            if (i === length)
                return error();
            while (0x30 /* '0' */ <= format[i] && format[i] <= 0x39 /* '9' */) {
                ++i;
                if (i === length)
                    return error();
            }
        }
    }

    /* Read the `precision`
     */
    if (format[i] === 0x2e /* '.' */) {
        precision = true;
        ++i;
        if (i === length)
            return error();
        const c = format[i];
        if (c === 0x2a /* '*' */) {
            precisionStar.value = true;
            ++i;
            if (i === length)
                return error();
        }
        else if (0x30 /* '0' */ <= c && c <= 0x39 /* '9' */) {
            ++i;
            if (i === length)
                return error();
            while (0x30 /* '0' */ <= format[i] && format[i] <= 0x39 /* '9' */) {
                ++i;
                if (i === length)
                    return error();
            }
        }
    }

    /* Read the specifier
     */
    const genSpec: Ref<number> = { value: 0xff };   // `char genSpec;` — char.init is 0xFF
    let specifier: Format;
    switch (format[i]) {
        case 0x6d /* 'm' */:
            // https://www.gnu.org/software/libc/manual/html_node/Other-Output-Conversions.html
            if (useGNUExts) {
                specifier = Format.GNU_m;
                genSpec.value = format[i];
                ++i;
                break;
            }
            // goto default; -> the TEXTUALLY NEXT arm, JS no-break fallthrough (06 §3.6)

        default: {
            const iBox: Ref<number> = { value: i };
            specifier = parseGenericFormatSpecifier(format, iBox, genSpec);
            i = iBox.value;
            if (specifier === Format.error)
                return error();
            break;
        }
    }

    switch (genSpec.value) {
        case 0x63 /* 'c' */:
        case 0x73 /* 's' */:
        case 0x43 /* 'C' */:
        case 0x53 /* 'S' */:
            if (hash || zero)
                return error();
            break;

        case 0x64 /* 'd' */:
        case 0x69 /* 'i' */:
            if (hash)
                return error();
            break;

        case 0x6d /* 'm' */:
            if (hash || zero || flags)
                return error();
            break;

        case 0x6e /* 'n' */:
            if (hash || zero || precision || width || flags)
                return error();
            break;

        default:
            break;
    }

    idx.value = i;
    return specifier;  // success
}

/* dmd/chkformat.d:905 — `enum Modifier`. Different kinds of conversion modifiers. */
// D module-private
export enum Modifier {
    none,
    h,          // short
    hh,         // char
    j,          // intmax_t
    l,          // wint_t/wchar_t
    ll,         // long long int
    L,          // long double
    m,          // char**
    ml,         // wchar_t**
    t,          // ptrdiff_t
    z,          // size_t
}

/* dmd/chkformat.d:926 — `enum Format`.
 * Different kinds of formatting specifications, variations we don't
 * care about are merged. (Like we don't care about the difference between
 * f, e, g, a, etc.)
 *
 * For `scanf`, every format is a pointer.
 */
// D module-private
export enum Format {
    d,          // int
    hhd,        // signed char
    hd,         // short int
    ld,         // long int
    lld,        // long long int
    jd,         // intmax_t
    zd,         // size_t
    td,         // ptrdiff_t
    u,          // unsigned int
    hhu,        // unsigned char
    hu,         // unsigned short int
    lu,         // unsigned long int
    llu,        // unsigned long long int
    ju,         // uintmax_t
    g,          // float (scanf) / double (printf)
    lg,         // double (scanf)
    Lg,         // long double (both)
    s,          // char string (both)
    ls,         // wchar_t string (both)
    c,          // char (printf)
    lc,         // wint_t (printf)
    p,          // pointer
    n,          // pointer to int
    hhn,        // pointer to signed char
    hn,         // pointer to short
    ln,         // pointer to long int
    lln,        // pointer to long long int
    jn,         // pointer to intmax_t
    zn,         // pointer to size_t
    tn,         // pointer to ptrdiff_t
    GNU_m,      // GNU ext. : string corresponding to the error code in errno (printf)
    POSIX_ms,   // POSIX ext. : dynamically allocated char string  (scanf)
    POSIX_mls,  // POSIX ext. : dynamically allocated wchar_t string (scanf)
    percent,    // %% (i.e. no argument)
    error,      // invalid format specification
}

/**************************************
 * dmd/chkformat.d:979 — `Format parseGenericFormatSpecifier(scope const char[] format,`.
 *
 * Parse the *length specifier* and the *specifier* of the following form:
 * `[length]specifier`
 *
 * Params:
 *      format = format string
 *      idx = index of of start of format specifier,
 *          which gets updated to index past the end of it,
 *          even if `Format.error` is returned
 *      genSpecifier = (out) Generic specifier. For instance, it will be set to `d` if the
 *           format is `hdd`.
 * Returns:
 *      Format
 */
// D module-private
export function parseGenericFormatSpecifier(format: DString, idx: Ref<number>, genSpecifier: Ref<number>): Format {
    genSpecifier.value = 0xff;      // `out char` reset to char.init on entry (03 §3.3)
    const length = format.length;

    /* Read the `length modifier`
     */
    const lm = format[idx.value];
    let flags: Modifier;
    switch (lm) {
        case 0x6a /* 'j' */:
        case 0x7a /* 'z' */:
        case 0x74 /* 't' */:
        case 0x4c /* 'L' */:
            flags = lm === 0x6a /* 'j' */ ? Modifier.j :
                    lm === 0x7a /* 'z' */ ? Modifier.z :
                    lm === 0x74 /* 't' */ ? Modifier.t :
                                            Modifier.L;
            ++idx.value;
            if (idx.value === length)
                return Format.error;
            break;

        case 0x68 /* 'h' */:
        case 0x6c /* 'l' */:
            ++idx.value;
            if (idx.value === length)
                return Format.error;
            if (lm === format[idx.value]) {
                flags = lm === 0x68 /* 'h' */ ? Modifier.hh : Modifier.ll;
                ++idx.value;
                if (idx.value === length)
                    return Format.error;
            }
            else
                flags = lm === 0x68 /* 'h' */ ? Modifier.h : Modifier.l;
            break;

        default:
            flags = Modifier.none;
            break;
    }

    /* Read the `specifier`
     */
    let specifier: Format;
    const sc = format[idx.value];
    genSpecifier.value = sc;
    switch (sc) {
        case 0x64 /* 'd' */:
        case 0x69 /* 'i' */:
            specifier = flags === Modifier.none ? Format.d   :
                        flags === Modifier.hh   ? Format.hhd :
                        flags === Modifier.h    ? Format.hd  :
                        flags === Modifier.ll   ? Format.lld :
                        flags === Modifier.l    ? Format.ld  :
                        flags === Modifier.j    ? Format.jd  :
                        flags === Modifier.z    ? Format.zd  :
                        flags === Modifier.t    ? Format.td  :
                                                  Format.error;
            break;

        case 0x75 /* 'u' */:
        case 0x6f /* 'o' */:
        case 0x78 /* 'x' */:
        case 0x58 /* 'X' */:
            specifier = flags === Modifier.none ? Format.u   :
                        flags === Modifier.hh   ? Format.hhu :
                        flags === Modifier.h    ? Format.hu  :
                        flags === Modifier.ll   ? Format.llu :
                        flags === Modifier.l    ? Format.lu  :
                        flags === Modifier.j    ? Format.ju  :
                        flags === Modifier.z    ? Format.zd  :
                        flags === Modifier.t    ? Format.td  :
                                                  Format.error;
            break;

        case 0x66 /* 'f' */:
        case 0x46 /* 'F' */:
        case 0x65 /* 'e' */:
        case 0x45 /* 'E' */:
        case 0x67 /* 'g' */:
        case 0x47 /* 'G' */:
        case 0x61 /* 'a' */:
        case 0x41 /* 'A' */:
            specifier = flags === Modifier.none ? Format.g  :
                        flags === Modifier.L    ? Format.Lg :
                        flags === Modifier.l    ? Format.lg :
                                                  Format.error;
            break;

        case 0x63 /* 'c' */:
            specifier = flags === Modifier.none ? Format.c       :
                        flags === Modifier.l    ? Format.lc      :
                                                  Format.error;
            break;

        case 0x73 /* 's' */:
            specifier = flags === Modifier.none ? Format.s       :
                        flags === Modifier.l    ? Format.ls      :
                                                  Format.error;
            break;

        case 0x70 /* 'p' */:
            specifier = flags === Modifier.none ? Format.p :
                                                  Format.error;
            break;

        case 0x6e /* 'n' */:
            specifier = flags === Modifier.none ? Format.n   :
                        flags === Modifier.ll   ? Format.lln :
                        flags === Modifier.l    ? Format.ln  :
                        flags === Modifier.hh   ? Format.hhn :
                        flags === Modifier.h    ? Format.hn  :
                        flags === Modifier.j    ? Format.jn  :
                        flags === Modifier.z    ? Format.zn  :
                        flags === Modifier.t    ? Format.tn  :
                                                  Format.error;
            break;

        case 0x43 /* 'C' */:
            // POSIX.1-2017 X/Open System Interfaces (XSI)
            // %C format is equivalent to %lc
            specifier = flags === Modifier.none ? Format.lc :
                                                  Format.error;
            break;

        case 0x53 /* 'S' */:
            // POSIX.1-2017 X/Open System Interfaces (XSI)
            // %S format is equivalent to %ls
            specifier = flags === Modifier.none ? Format.ls :
                                                  Format.error;
            break;

        default:
            specifier = Format.error;
            break;
    }

    ++idx.value;
    return specifier; // success
}
