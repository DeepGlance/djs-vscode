// Co-located tests for src/dmd/canthrow.ts (dmd/canthrow.d).
//
// dmd/canthrow.d carries NO `unittest` block, so these are 10 §1.6b behaviour pins. Each drives a D source
// through the sema module driver (lex -> parse -> moduleFromParse -> runSemantic) with the compiler error
// sink and a capturing diagnostic handler, and pins the messages against ldc2 1.43.0 (`ldc2 -c -o- x.d`,
// outputs quoted per test). The `nothrow` caller makes semantic3 pass `global.errorSink` to `blockExit`,
// which hands it to `canThrow` — the eSink leg of `checkFuncThrows` and of the function-pointer arm.
// Each source declares the module name of its ldc2 probe file, so the qualified names match byte for byte.

import "./parse.js"; // module-graph ROOT for a core-SCC test file (10 §1.5)

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { CT } from "./canthrow.js";
import { BE } from "./blockexit.js";
import { Parser } from "./parse.js";
import { global } from "./globals.js";
import { ErrorSinkCompiler, setDiagnosticHandler } from "./errors.js";
import { moduleFromParse } from "./dmodule.js";
import { runSemantic } from "./dsymbolsem.js";
import { dmdformat } from "./root/dmdformat.js";
import { initSemaHarness } from "../sema-harness.js";
import { dsToJs } from "../dstring.js";

import type { Dsymbols } from "./arraytypes.js";

let diags: string[] = [];

beforeEach(() => {
    initSemaHarness();
    global.errorSink = new ErrorSinkCompiler();
    diags = [];
    setDiagnosticHandler((_loc, _color, header, messageFormat, args) => {
        diags.push(dsToJs(header) + dsToJs(dmdformat(messageFormat, [...args])));
        return true;
    });
});

afterEach(() => {
    setDiagnosticHandler(null);
});

/** NUL-terminated byte buffer (the lexer scans to the NUL sentinel). */
function srcBuf(text: string): Uint8Array {
    const b = new Uint8Array(text.length + 1);
    for (let i = 0; i < text.length; i++) b[i] = text.charCodeAt(i) & 0xff;
    b[text.length] = 0;
    return b;
}

/** lex + parse + runSemantic over `text`; returns `global.errors`. */
function sema(text: string): number {
    const p = new Parser(null, null, srcBuf(text), false, global.errorSink!, null, false);
    p.nextToken();
    const members: Dsymbols = p.parseModule();
    runSemantic(moduleFromParse(members, p.md));
    return global.errors;
}

describe("canthrow.d:37 — enum CT : BE", () => {
    test("CT's inline values are the BE bits it names", () => {
        expect(CT.none).toBe(BE.none);
        expect(CT.exception).toBe(BE.throw_);
        expect(CT.error).toBe(BE.errthrow);
    });
});

describe("canthrow.d:57 — canThrow, the eSink (nothrow caller) leg", () => {
    test("a call to a non-nothrow function: checkFuncThrows reports it (ldc2: p1.d)", () => {
        // ldc2: Error: function `p1.f` is not `nothrow`
        //       Error: function `p1.g` may throw but is marked as `nothrow`
        expect(sema("module p1;\nvoid f() {}\nvoid g() nothrow { f(); }\n")).toBe(2);
        expect(diags).toEqual([
            "Error: function `p1.f` is not `nothrow`",
            "Error: function `p1.g` may throw but is marked as `nothrow`",
        ]);
    });

    test("the call inside a variable initializer is reached through visitDeclarationExp (ldc2: p2.d)", () => {
        // ldc2: Error: function `p2.h` is not `nothrow`
        expect(sema("module p2;\nint h(int x) { return x; }\nvoid g() nothrow { int y = h(1); }\n")).toBe(2);
        expect(diags[0]).toBe("Error: function `p2.h` is not `nothrow`");
        expect(diags[1]).toBe("Error: function `p2.g` may throw but is marked as `nothrow`");
    });

    test("a call through a function pointer prints the pointer, `(*fp)` stripped (ldc2: p3.d)", () => {
        // ldc2: Error: `fp` is not `nothrow`
        expect(sema("module p3;\nvoid function() fp;\nvoid g() nothrow { fp(); }\n")).toBe(2);
        expect(diags[0]).toBe("Error: `fp` is not `nothrow`");
        expect(diags[1]).toBe("Error: function `p3.g` may throw but is marked as `nothrow`");
    });

    test("a call inside a `debug` statement is exempt (ldc2: p4.d compiles clean)", () => {
        expect(sema("module p4;\nvoid f() {}\nvoid g() nothrow { debug f(); }\n")).toBe(0);
        expect(diags).toEqual([]);
    });

    test("visitAssignExp: a static-array copy runs the element postblit (ldc2: p9.d)", () => {
        // ldc2: Error: function `p9.S.this(this)` is not `nothrow`
        //       Error: function `p9.g` may throw but is marked as `nothrow`
        // The port reports one extra error FIRST, a harness artefact: the hermetic `object` module is empty,
        // so the `_d_arrayassign_l` lowering finds no druntime hook. The canThrow lines that follow are ldc2's.
        expect(sema("module p9;\nstruct S { this(this) {} }\nvoid g() nothrow { S[2] a; S[2] b; a = b; }\n")).toBe(3);
        expect(diags).toEqual([
            "Error: undefined identifier `_d_arrayassign_l` in module `object`",
            "Error: function `p9.S.this(this)` is not `nothrow`",
            "Error: function `p9.g` may throw but is marked as `nothrow`",
        ]);
    });

    test("an inferred callee adds the `which calls` supplemental (ldc2: p5.d)", () => {
        // ldc2: Error: function `p5.t!().t` is not `nothrow`
        //       p5.d(3):        which calls `f`
        //       Error: function `p5.g` may throw but is marked as `nothrow`
        expect(sema("module p5;\nvoid f() {}\nvoid t()() { f(); }\nvoid g() nothrow { t(); }\n")).toBe(2);
        // The supplemental comes from canthrow.d:80, through errorSupplementalInferredAttr.
        expect(diags).toEqual([
            "Error: function `p5.t!().t` is not `nothrow`",
            "       which calls `f`",
            "Error: function `p5.g` may throw but is marked as `nothrow`",
        ]);
    });
});

describe("canthrow.d:57 — canThrow, the inference (eSink null) leg", () => {
    test("a nothrow-clean body calling only nothrow functions compiles clean", () => {
        expect(sema("module p7;\nvoid f() nothrow {}\nvoid g() nothrow { int a = 1; a += 2; f(); }\n")).toBe(0);
        expect(diags).toEqual([]);
    });
});
