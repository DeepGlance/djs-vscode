// Tests for chkformat.ts (dmd/chkformat.d).
//
// Section 1 ports the three D unittests verbatim (10 §1): `parseGenericFormatSpecifier` (chkformat.d:1125),
// `parsePrintfFormatSpecifier` (:1146), `parseScanfFormatSpecifier` (:1254). They are the primary oracle.
//
// Section 2 pins `isFormatSafe`, `checkPrintfFormat` and `checkScanfFormat` diagnostics byte-exact against
// ldc2 1.43.0 (arm64-apple-darwin). The probe was:
//
//   pragma(printf) extern(C) int printf(const char*, ...);
//   pragma(scanf) extern(C) int scanf(const char*, ...);
//   printf("%d\n", 1L);  printf("%ld\n", 1);  printf("%s\n", 1);  printf("%*d\n", 1L, 2); ...
//   double d = 1; printf("%lu\n", d);  printf("%hhn\n", cast(byte*)null);  scanf("%hhd", cast(short*)null); ...
//
// and every expected string below is copied from its stderr (message text only, after "Deprecation: ").

import { beforeEach, describe, expect, test } from "vitest";
import "./parse.js"; // module-graph ROOT for a core-SCC test file (10 §1.5)
import { ds, dsToJs } from "../dstring.js";
import type { DString } from "../dstring.js";
import {
    Format, checkPrintfFormat, checkScanfFormat, isFormatSafe, parseGenericFormatSpecifier,
    parsePrintfFormatSpecifier, parseScanfFormatSpecifier,
} from "./chkformat.js";
import { ErrorSink, ErrorSinkNull } from "./errorsink.js";
import { VarDeclaration } from "./declaration.js";
import { IntegerExp, NullExp, VarExp } from "./expression.js";
import type { Expression } from "./expression.js";
import { global } from "./globals.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { Type } from "./mtype.js";
import { dmdformat } from "./root/dmdformat.js";
import { initTokens } from "./tokens.js";
import { Type_init, pointerTo } from "./typesem.js";

beforeEach(() => {
    // The 10 §1.5 canonical order: Loc, then initTokens, then Id, then the basic types.
    Loc._init();
    initTokens(); // also runs Identifier.initTable
    Id.initialize();
    Type_init();
    global.errorSink = new ErrorSinkNull();
    global.errors = 0;
    global.gag = 0;
});

// ---------------------------------------------------------------------------------------------------
// Section 1 — the D unittests
// ---------------------------------------------------------------------------------------------------

test("parseGenericFormatSpecifier", () => {
    const genSpecifier = { value: 0 };
    const idx = { value: 0 };

    const testG = (fmtStr: string, expectedFormat: Format, expectedGenSpecifier: string): void => {
        idx.value = 0;
        expect(parseGenericFormatSpecifier(ds(fmtStr), idx, genSpecifier)).toBe(expectedFormat);
        expect(genSpecifier.value).toBe(expectedGenSpecifier.charCodeAt(0));
    };

    testG("hhd", Format.hhd, "d");
    testG("hn", Format.hn, "n");
    testG("ji", Format.jd, "i");
    testG("lu", Format.lu, "u");

    idx.value = 0;
    expect(parseGenericFormatSpecifier(ds("k"), idx, genSpecifier)).toBe(Format.error);
});

test("parsePrintfFormatSpecifier", () => {
    let useGNUExts = false;

    const idx = { value: 0 };
    const widthStar = { value: false };
    const precisionStar = { value: false };

    const testP = (fmtStr: string, expectedFormat: Format, expectedIdx: number): void => {
        idx.value = 0;
        expect(parsePrintfFormatSpecifier(ds(fmtStr), idx, widthStar, precisionStar, useGNUExts),
            fmtStr).toBe(expectedFormat);
        expect(idx.value, fmtStr).toBe(expectedIdx);
    };

    // one for each Format
    testP("%d", Format.d, 2);
    expect(!widthStar.value && !precisionStar.value).toBe(true);

    testP("%ld", Format.ld, 3);
    testP("%lld", Format.lld, 4);
    testP("%jd", Format.jd, 3);
    testP("%zd", Format.zd, 3);
    testP("%td", Format.td, 3);
    testP("%g", Format.g, 2);
    testP("%Lg", Format.Lg, 3);
    testP("%p", Format.p, 2);
    testP("%n", Format.n, 2);
    testP("%ln", Format.ln, 3);
    testP("%lln", Format.lln, 4);
    testP("%hn", Format.hn, 3);
    testP("%hhn", Format.hhn, 4);
    testP("%jn", Format.jn, 3);
    testP("%zn", Format.zn, 3);
    testP("%tn", Format.tn, 3);
    testP("%c", Format.c, 2);
    testP("%lc", Format.lc, 3);
    testP("%s", Format.s, 2);
    testP("%ls", Format.ls, 3);
    testP("%%", Format.percent, 2);

    // Synonyms
    testP("%i", Format.d, 2);
    testP("%u", Format.u, 2);
    testP("%o", Format.u, 2);
    testP("%x", Format.u, 2);
    testP("%X", Format.u, 2);
    testP("%f", Format.g, 2);
    testP("%F", Format.g, 2);
    testP("%G", Format.g, 2);
    testP("%a", Format.g, 2);
    testP("%La", Format.Lg, 3);
    testP("%A", Format.g, 2);
    testP("%lg", Format.lg, 3);

    // width, precision
    testP("%*d", Format.d, 3);
    expect(widthStar.value && !precisionStar.value).toBe(true);

    testP("%.*d", Format.d, 4);
    expect(!widthStar.value && precisionStar.value).toBe(true);

    testP("%*.*d", Format.d, 5);
    expect(widthStar.value && precisionStar.value).toBe(true);

    // Too short formats
    for (const s of ["%", "%-", "%+", "% ", "%#", "%0", "%*", "%1", "%19", "%.", "%.*", "%.1", "%.12",
                     "%j", "%z", "%t", "%l", "%h", "%ll", "%hh"]) {
        testP(s, Format.error, s.length);
    }

    // Undefined format combinations
    for (const s of ["%#d", "%llg", "%jg", "%zg", "%tg", "%hg", "%hhg",
                     "%#c", "%0c", "%jc", "%zc", "%tc", "%Lc", "%hc", "%hhc", "%llc",
                     "%#s", "%0s", "%js", "%zs", "%ts", "%Ls", "%hs", "%hhs", "%lls",
                     "%jp", "%zp", "%tp", "%Lp", "%hp", "%lp", "%hhp", "%llp",
                     "%-n", "%+n", "% n", "%#n", "%0n", "%*n", "%1n", "%19n", "%.n", "%.*n", "%.1n", "%.12n",
                     "%Ln", "%K"]) {
        testP(s, Format.error, s.length);
    }

    testP("%C", Format.lc, 2);
    testP("%S", Format.ls, 2);

    // GNU extensions: explicitly toggle ISO/GNU flag.
    for (const s of ["%jm", "%zm", "%tm", "%Lm", "%hm", "%hhm", "%lm", "%llm",
                     "%#m", "%+m", "%-m", "% m", "%0m"]) {
        useGNUExts = false;
        testP(s, Format.error, s.length);
        useGNUExts = true;
        testP(s, Format.error, s.length);
    }

    for (const s of ["%m", "%md", "%mz", "%mc", "%mm", "%msyz", "%ml", "%mlz", "%mlc", "%mlm"]) {
        // valid cases, all parsed as `%m`
        // GNU printf()
        useGNUExts = true;
        testP(s, Format.GNU_m, 2);

        // ISO printf()
        useGNUExts = false;
        testP(s, Format.error, 2);
    }
});

test("parseScanfFormatSpecifier", () => {
    const idx = { value: 0 };
    const asterisk = { value: false };

    const testS = (fmtStr: string, expectedFormat: Format, expectedIdx: number): void => {
        idx.value = 0;
        expect(parseScanfFormatSpecifier(ds(fmtStr), idx, asterisk), fmtStr).toBe(expectedFormat);
        expect(idx.value, fmtStr).toBe(expectedIdx);
    };

    // one for each Format
    testS("%d", Format.d, 2);
    testS("%hhd", Format.hhd, 4);
    testS("%hd", Format.hd, 3);
    testS("%ld", Format.ld, 3);
    testS("%lld", Format.lld, 4);
    testS("%jd", Format.jd, 3);
    testS("%zd", Format.zd, 3);
    testS("%td", Format.td, 3);
    testS("%u", Format.u, 2);
    testS("%hhu", Format.hhu, 4);
    testS("%hu", Format.hu, 3);
    testS("%lu", Format.lu, 3);
    testS("%llu", Format.llu, 4);
    testS("%ju", Format.ju, 3);
    testS("%g", Format.g, 2);
    testS("%lg", Format.lg, 3);
    testS("%Lg", Format.Lg, 3);
    testS("%p", Format.p, 2);
    testS("%s", Format.s, 2);
    testS("%ls", Format.ls, 3);
    testS("%%", Format.percent, 2);

    // Synonyms
    testS("%i", Format.d, 2);
    testS("%n", Format.n, 2);

    testS("%o", Format.u, 2);
    testS("%x", Format.u, 2);
    testS("%f", Format.g, 2);
    testS("%e", Format.g, 2);
    testS("%a", Format.g, 2);
    testS("%c", Format.c, 2);

    // asterisk
    testS("%*d", Format.d, 3);
    expect(asterisk.value).toBe(true);

    testS("%9ld", Format.ld, 4);
    expect(asterisk.value).toBe(false);

    testS("%*25984hhd", Format.hhd, 10);
    expect(asterisk.value).toBe(true);

    // scansets
    testS("%[a-zA-Z]", Format.s, 9);
    expect(asterisk.value).toBe(false);

    testS("%*25l[a-z]", Format.ls, 10);
    expect(asterisk.value).toBe(true);

    testS("%[]]", Format.s, 4);
    expect(asterisk.value).toBe(false);

    testS("%[^]]", Format.s, 5);
    expect(asterisk.value).toBe(false);

    // Too short formats
    for (const s of ["%", "% ", "%#", "%0", "%*", "%1", "%19",
                     "%j", "%z", "%t", "%l", "%h", "%ll", "%hh", "%K"]) {
        testS(s, Format.error, s.length);
    }

    // Undefined format combinations
    for (const s of ["%Ld", "%llg", "%jg", "%zg", "%tg", "%hg", "%hhg",
                     "%jc", "%zc", "%tc", "%Lc", "%hc", "%hhc", "%llc",
                     "%jp", "%zp", "%tp", "%Lp", "%hp", "%lp", "%hhp", "%llp",
                     "%-", "%+", "%#", "%0", "%.", "%Ln"]) {
        testS(s, Format.error, s.length);
    }

    // Invalid scansets
    for (const s of ["%[]", "%[^", "%[^]", "%[s", "%[0-9lld", "%[", "%l[^]"]) {
        testS(s, Format.error, s.length);
    }

    // Posix extensions
    for (const s of ["%jm", "%zm", "%tm", "%Lm", "%hm", "%hhm", "%lm", "%llm",
                     "%m", "%ma", "%md", "%ml", "%mm", "%mlb", "%mlj", "%mlr", "%mlz",
                     "%LC", "%lC", "%llC", "%jC", "%tC", "%hC", "%hhC", "%zC",
                     "%LS", "%lS", "%llS", "%jS", "%tS", "%hS", "%hhS", "%zS"]) {
        testS(s, Format.error, s.length);
    }

    testS("%mc", Format.POSIX_ms, 3);
    testS("%ms", Format.POSIX_ms, 3);
    testS("%m[0-9]", Format.POSIX_ms, 7);
    testS("%mlc", Format.POSIX_mls, 4);
    testS("%mls", Format.POSIX_mls, 4);
    testS("%ml[^0-9]", Format.POSIX_mls, 9);
    testS("%mC", Format.POSIX_mls, 3);
    testS("%mS", Format.POSIX_mls, 3);

    testS("%C", Format.lc, 2);
    testS("%S", Format.ls, 2);
});

// ---------------------------------------------------------------------------------------------------
// Section 2 — diagnostics pinned against ldc2 1.43.0
// ---------------------------------------------------------------------------------------------------

/// Records every diagnostic as `<kind>: <formatted text>`, formatted by the one printf owner (10 §3.5).
class ErrorSinkRecorder extends ErrorSink {
    readonly lines: string[] = [];
    private rec(kind: string, format: DString, ap: ReadonlyArray<unknown>): void {
        this.lines.push(kind + ": " + dsToJs(dmdformat(format, [...ap])));
    }
    override verror(_loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void { this.rec("error", format, ap); }
    override verrorSupplemental(_loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
        this.rec("errorSupplemental", format, ap);
    }
    override vwarning(_loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void { this.rec("warning", format, ap); }
    override vwarningSupplemental(_loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
        this.rec("warningSupplemental", format, ap);
    }
    override vmessage(_loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void { this.rec("message", format, ap); }
    override vdeprecation(_loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
        this.rec("deprecation", format, ap);
    }
    override vdeprecationSupplemental(_loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
        this.rec("deprecationSupplemental", format, ap);
    }
}

const int1 = (): Expression => new IntegerExp(Loc.initial, 1n, Type.tint32);
const long1 = (): Expression => new IntegerExp(Loc.initial, 1n, Type.tint64);
// A `double d` variable read (`VarExp`), as in the oracle probe: `double d = 1; printf("%lu\n", d);`.
const doubleVar = (): Expression => {
    const v = new VarDeclaration(Loc.initial, Type.tfloat64, Identifier.idPool(ds("d")), null);
    const e = new VarExp(Loc.initial, v);
    e.type = Type.tfloat64;
    return e;
};

function printfDiag(format: string, args: Expression[], isVa_list = false): { ret: boolean; lines: string[] } {
    const sink = new ErrorSinkRecorder();
    const ret = checkPrintfFormat(Loc.initial, ds(format), args, isVa_list, sink);
    return { ret, lines: sink.lines };
}

function scanfDiag(format: string, args: Expression[], isVa_list = false): { ret: boolean; lines: string[] } {
    const sink = new ErrorSinkRecorder();
    const ret = checkScanfFormat(Loc.initial, ds(format), args, isVa_list, sink);
    return { ret, lines: sink.lines };
}

describe("isFormatSafe", () => {
    test("formats without %s / %ls / invalid specifiers are safe", () => {
        expect(isFormatSafe(ds("hello %d %x %5.2f %p %%\n"))).toBe(true);
        expect(isFormatSafe(ds(""))).toBe(true);
    });
    test("%s, %ls and an invalid specifier are unsafe", () => {
        expect(isFormatSafe(ds("%s"))).toBe(false);
        expect(isFormatSafe(ds("x %ls"))).toBe(false);
        expect(isFormatSafe(ds("%k"))).toBe(false);
        expect(isFormatSafe(ds("%"))).toBe(false);
    });
});

describe("checkPrintfFormat (ldc2 1.43.0 oracle)", () => {
    test("size mismatch on %d: `1L`", () => {
        expect(printfDiag("%d\n", [long1()])).toEqual({ ret: false, lines: [
            "deprecation: argument `1L` for format specification `\"%d\"` must be `int`, not `long`"] });
    });
    test("%ld with an int adds the C `long` supplemental (8 bytes on darwin arm64)", () => {
        expect(printfDiag("%ld\n", [int1()])).toEqual({ ret: false, lines: [
            "deprecation: argument `1` for format specification `\"%ld\"` must be `long`, not `int`",
            "errorSupplemental: C `long` is 8 bytes on your system"] });
    });
    test("%lu with a double: no supplemental (not integral)", () => {
        expect(printfDiag("%lu\n", [doubleVar()]).lines).toEqual([
            "deprecation: argument `d` for format specification `\"%lu\"` must be `ulong`, not `double`"]);
    });
    test("%s, %p, %zd, %Lg, %jd, %ls mismatches", () => {
        expect(printfDiag("%s\n", [int1()]).lines).toEqual([
            "deprecation: argument `1` for format specification `\"%s\"` must be `char*`, not `int`"]);
        expect(printfDiag("%p\n", [int1()]).lines).toEqual([
            "deprecation: argument `1` for format specification `\"%p\"` must be `void*`, not `int`"]);
        expect(printfDiag("%zd\n", [int1()]).lines).toEqual([
            "deprecation: argument `1` for format specification `\"%zd\"` must be `size_t`, not `int`"]);
        expect(printfDiag("%Lg\n", [doubleVar()]).lines).toEqual([
            "deprecation: argument `d` for format specification `\"%Lg\"` must be `real`, not `double`"]);
        expect(printfDiag("%jd\n", [int1()]).lines).toEqual(["deprecation: argument `1` for format specification "
            + "`\"%jd\"` must be `core.stdc.stdint.intmax_t`, not `int`"]);
        expect(printfDiag("%ls\n", [int1()]).lines).toEqual([
            "deprecation: argument `1` for format specification `\"%ls\"` must be `wchar_t*`, not `int`"]);
    });
    test("width and precision stars", () => {
        expect(printfDiag("%*d\n", [long1(), int1()]).lines).toEqual([
            "deprecation: width argument `1L` for format specification `\"%*d\"` must be `int`, not `long`"]);
        expect(printfDiag("%.*d\n", [long1(), int1()]).lines).toEqual([
            "deprecation: precision argument `1L` for format specification `\"%.*d\"` must be `int`, not `long`"]);
    });
    test("more specifiers than arguments returns true", () => {
        expect(printfDiag("%d %d\n", [int1()])).toEqual({ ret: true, lines: [
            "deprecation: more format specifiers than 1 arguments"] });
        // %m is not a GNU extension on darwin (no CRuntime_Glibc): parsed as an error, then no argument.
        expect(printfDiag("%m\n", [])).toEqual({ ret: true, lines: [
            "deprecation: more format specifiers than 0 arguments"] });
    });
    test("invalid specifier", () => {
        expect(printfDiag("%k\n", [int1()])).toEqual({ ret: false, lines: [
            "deprecation: format specifier `\"%k\"` is invalid"] });
    });
    test("matching arguments and %% produce nothing", () => {
        const pint = new NullExp(Loc.initial, pointerTo(Type.tint32));
        expect(printfDiag("%% %d %ld %lld %g %n %p\n", [int1(), long1(), long1(), doubleVar(), pint, pint]))
            .toEqual({ ret: false, lines: [] });
    });
    test("%hhn checks `Tint16` verbatim (chkformat.d:285): a `byte*` is rejected as not `byte*`", () => {
        expect(printfDiag("%hhn\n", [new NullExp(Loc.initial, pointerTo(Type.tint8))]).lines).toEqual([
            "deprecation: argument `null` for format specification `\"%hhn\"` must be `byte*`, not `byte*`"]);
    });
    test("isVa_list: format check only", () => {
        expect(printfDiag("%d %k", [], true)).toEqual({ ret: false, lines: [
            "deprecation: format specifier `\"%k\"` is invalid"] });
    });
});

describe("checkScanfFormat (ldc2 1.43.0 oracle)", () => {
    test("non-pointer arguments", () => {
        expect(scanfDiag("%ld", [int1()]).lines).toEqual([
            "deprecation: argument `1` for format specification `\"%ld\"` must be `long*`, not `int`"]);
        expect(scanfDiag("%d", [int1()]).lines).toEqual([
            "deprecation: argument `1` for format specification `\"%d\"` must be `int*`, not `int`"]);
        expect(scanfDiag("%ms", [int1()]).lines).toEqual([
            "deprecation: argument `1` for format specification `\"%ms\"` must be `char**`, not `int`"]);
    });
    test("%hhd checks `Tint16` verbatim (chkformat.d:438): `byte*` rejected, `short*` accepted", () => {
        expect(scanfDiag("%hhd", [new NullExp(Loc.initial, pointerTo(Type.tint8))]).lines).toEqual([
            "deprecation: argument `null` for format specification `\"%hhd\"` must be `byte*`, not `byte*`"]);
        expect(scanfDiag("%hhd", [new NullExp(Loc.initial, pointerTo(Type.tint16))]).lines).toEqual([]);
    });
    test("null argument then too few arguments", () => {
        expect(scanfDiag("%d %d", [new NullExp(Loc.initial, Type.tnull)])).toEqual({ ret: true, lines: [
            "deprecation: argument `null` for format specification `\"%d\"` must be `int*`, not `typeof(null)`",
            "deprecation: more format specifiers than 1 arguments"] });
    });
    test("%*d consumes no argument; an invalid specifier still asks for one", () => {
        expect(scanfDiag("%*d %k", [])).toEqual({ ret: true, lines: [
            "deprecation: more format specifiers than 0 arguments"] });
    });
    test("matching pointer arguments produce nothing", () => {
        const pint = new NullExp(Loc.initial, pointerTo(Type.tint32));
        const pchar = new NullExp(Loc.initial, pointerTo(Type.tchar));
        const pdouble = new NullExp(Loc.initial, pointerTo(Type.tfloat64));
        expect(scanfDiag("%d %s %lg %% %*d", [pint, pchar, pdouble])).toEqual({ ret: false, lines: [] });
    });
});
