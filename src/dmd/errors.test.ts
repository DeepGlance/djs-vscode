// Tests for dmd/errors.ts.
//
// Ports the two in-source `unittest{}` blocks of errors.d (10 §1.2, numbered in source order):
//   #1 — errors.d:794: printErrorLineContext caret placement for `int ɷ = 3;` (the display-column vs
//        byte-column distinction, 10 §3.6). This is the test the guide explicitly calls out to keep.
//   #2 — errors.d:901: unescapeBackticks + colorSyntaxHighlight collapse `` `` `` -> `` ` ``.
//
// `printErrorLineContext`/`unescapeBackticks`/`colorSyntaxHighlight` are module-private in D but
// reached by these unittests, so the port emits them non-private (01 §2.5 / 10 §1.7).

import { describe, test, expect } from "vitest";
import { dsUtf8, dsToJs } from "../dstring.js";
import { OutBuffer } from "./common/outbuffer.js";
import { printErrorLineContext, unescapeBackticks, colorSyntaxHighlight } from "./errors.js";

/** Decode an OutBuffer's logical content (peekSlice = bytes without a NUL terminator) as UTF-8 for
 * comparison against the expected display string. The unittest source compares byte-slices via D
 * `==`; here we decode to JS strings since the expected literals contain a multi-byte code point. */
function bufText(buf: OutBuffer): string {
    return dsToJs(buf.peekSlice());
}

describe("errors.d", () => {
    // errors.d:794 — printErrorLineContext(buf, "int ɷ = 3;", 9) should produce the source line then
    // a caret at display column 8. `ɷ` (U+0277) is 2 UTF-8 bytes, so the byte offset 9 lands after
    // `= ` and the caret column (display) differs from the byte column.
    test("unittest#1", () => {
        const buf = new OutBuffer();
        printErrorLineContext(buf, dsUtf8("int ɷ = 3;"), 9);
        expect(bufText(buf)).toBe("int ɷ = 3;\n" + "        ^\n");
    });

    // errors.d:901 — both unescapeBackticks and colorSyntaxHighlight collapse `` `` `` to `` ` ``.
    test("unittest#2", () => {
        const buf = new OutBuffer();
        buf.writestring(dsUtf8("x````"));
        unescapeBackticks(buf);
        expect(dsToJs(buf.extractSlice())).toBe("x``");

        buf.writestring(dsUtf8("x````"));
        colorSyntaxHighlight(buf);
        expect(dsToJs(buf.extractSlice())).toBe("x``");
    });
});

// errors.d:508 `goto case ErrorKind.error;` — under `-de` a deprecation takes the error arm (counted in
// `global.errors`) but keeps its own kind, so it prints with the `Deprecation: ` header.
// ORACLE: ldmd2 -c -o- -de on `void main() { auto a = __traits(isVirtualFunction, A.fun); }` (class A { void
// fun() {} }) prints `x.d(…): Deprecation: \`traits(isVirtualFunction)\` is deprecated. …` and exits 1;
// fail_compilation/deprecate_getVirtualFunctions.d pins the same header.
describe("vreportDiagnostic — a deprecation under -de (errors.d:508)", () => {
    test("counts as an error and prints the Deprecation header", async () => {
        const { vi } = await import("vitest");
        vi.resetModules();
        const { global, DiagnosticReporting } = await import("./globals.js");
        const { deprecation } = await import("./errors.js");
        const { Loc } = await import("./location.js");
        const { ds } = await import("../dstring.js");
        global._init();
        global.params.useDeprecated = DiagnosticReporting.error;
        const err: string[] = [];
        const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => {
            err.push(typeof c === "string" ? c : new TextDecoder().decode(c));
            return true;
        });
        try {
            deprecation(Loc.initial, ds("`%s` is deprecated"), ds("x"));
        } finally {
            spy.mockRestore();
        }
        expect(global.errors).toBe(1);
        expect(err.join("")).toBe("Deprecation: `x` is deprecated\n");
    });
});
