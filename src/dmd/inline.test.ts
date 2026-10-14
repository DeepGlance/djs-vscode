// Co-located tests for src/dmd/inline.ts (dmd/inline.d).
//
// dmd/inline.d carries NO `unittest` block, so these are 10 §1.6b behaviour pins, on the one entry point
// ldc2 runs: `inlineCopy` (inline.d:92), which `functionParameters` calls on every default argument it
// supplies (expressionsem.d:4253). Each test runs sema over a declaration WITHOUT the call (the call site's
// own wall in expressionsem.ts is the integrator's to sweep), takes the analysed default argument from the
// function type, and calls `inlineCopy` on it in the module's global scope, as the call would.
//
// ORACLE PROBES (ldc2 1.43.0, `-c -o-`; the D files carry the call `g() { f(); }`):
//   p4.d  `int k() { return 1; } void f(int x = k() + (() => 2)()) {}`  -> exit 1,
//         p4.d(2): Error: cannot inline default argument `k() + (*function () pure nothrow @nogc @safe => 2)()`
//   p3.d  `void f(int[] a = [1, 2, 3], int[int] aa = [1: 2]) {}`       -> exit 0
//   p6.d  `int[] gArr; void f(int x = gArr[$ - 1], int[] s = gArr[1 .. $]) {}` -> exit 0; `-vcg-ast` prints
//         the call as `f(gArr[__dollar - 1LU], gArr[1..__dollar]);`
//   q9.d  `void outer() { int w; void nested() {} void f(void delegate() d = &nested) {} f();
//         struct N { int q; void m() { w++; } } void f2(N n = N(1)) {} f2(); }` -> exit 1, only
//         q9.d(8): Error: cannot inline default argument `N(1)`  (the delegate default draws nothing)
// NOT PINNED: the AA-literal default argument of p3.d (`int[int] aa = [1: 2]`) and compilable/test22632.d.
// In this sema harness the AA literal needs the AA TypeInfo from druntime, and the harness's empty `object`
// makes typinf.d:68 `fatal()`. On the driver path (dmodule.test.ts `compile()`, real druntime) test22632.d
// does reach inlineCopy (five default-argument copies in core.internal); with inlineCopy and
// checkAssocArrayLiteralEscape (escape.d:270) both live, test22632.d can join dmodule.test.ts's clean-accept
// list. The copy legs the AA literal would exercise (`visitAssocArrayLiteralExp`, inline.d:1053) are the
// same shape as the array-literal pin.
// The scan half of inline.d is not run by ldc2 (the file header of inline.ts): ldc2 rejects `-inline`
// ("Unknown command line argument"), and `pragma(inline, true)` on a variadic function or one with a
// nested `return` draws no "cannot inline function" warning under `-wi`, `-w` or `-O -wi`.

import "./parse.js"; // module-graph ROOT for a core-SCC test file (10 §1.5)

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { inlineCopy } from "./inline.js";
import { Parser } from "./parse.js";
import { global } from "./globals.js";
import { ErrorSinkCompiler, setDiagnosticHandler } from "./errors.js";
import { moduleFromParse } from "./dmodule.js";
import { runSemantic, scopeCreateGlobal } from "./dsymbolsem.js";
import { dmdformat } from "./root/dmdformat.js";
import { initSemaHarness, sourceMembers, userBody } from "../sema-harness.js";
import { dsToJs } from "../dstring.js";
import { EXP } from "./tokens.js";

import type { Module } from "./dmodule.js";
import type { Scope } from "./dscope.js";
import type { Expression } from "./expression.js";
import type { FuncDeclaration } from "./func.js";

let diags: string[] = [];

beforeEach(() => {
    initSemaHarness();
    global.errorSink = new ErrorSinkCompiler();
    diags = [];
    setDiagnosticHandler((loc, _color, header, messageFormat, args) => {
        diags.push(`(${loc.linnum},${loc.charnum}) ` + dsToJs(header) + dsToJs(dmdformat(messageFormat, [...args])));
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

/** lex + parse + runSemantic over `text` (a clean accept), and the module's global scope. */
function sema(text: string): { m: Module; sc: Scope } {
    const p = new Parser(null, null, srcBuf(text), false, global.errorSink!, null, false);
    p.nextToken();
    const m = moduleFromParse(p.parseModule(), p.md);
    runSemantic(m);
    expect(global.errors).toBe(0);
    return { m, sc: scopeCreateGlobal(m, global.errorSink!) };
}

function func(m: Module, name: string): FuncDeclaration {
    for (const s of sourceMembers(m)) {
        const fd = s.isFuncDeclaration();
        if (fd !== null && dsToJs(fd.ident!.toString()) === name)
            return fd;
    }
    throw new Error(`no function ${name}`);
}

/** The analysed default argument of parameter `i` of module-level function `name`. */
function defaultArg(m: Module, name: string, i: number): Expression {
    return func(m, name).type!.isTypeFunction()!.parameterList.opIndex(i)!.defaultArg!;
}

/** The analysed default argument of parameter `i` of function `name`, declared in the body of `outer`. */
function localDefaultArg(m: Module, outer: string, name: string, i: number): Expression {
    const body = userBody(func(m, outer)).isCompoundStatement()!;
    for (let k = 0; k < body.statements!.length; k++) {
        const de = body.statements!.opIndex(k)?.isExpStatement()?.exp?.isDeclarationExp() ?? null;
        const fd = de === null ? null : de.declaration!.isFuncDeclaration();
        if (fd !== null && dsToJs(fd.ident!.toString()) === name)
            return fd.type!.isTypeFunction()!.parameterList.opIndex(i)!.defaultArg!;
    }
    throw new Error(`no function ${name} in ${outer}`);
}

describe("inline.d:92 — inlineCopy", () => {
    test("a default argument costing COST_MAX is rejected with ldc2's diagnostic (p4.d)", () => {
        const { m, sc } = sema("module p4;\nint k() { return 1; }\nvoid f(int x = k() + (() => 2)()) {}\n");
        const arg = defaultArg(m, "f", 0);
        const r = inlineCopy(arg, sc);
        expect(r.op).toBe(EXP.error);
        expect(global.errors).toBe(1);
        expect(diags).toEqual([
            // ldc2 -vcolumns: p4.d(2,20), caret at `+`; the test source adds `module p4;` as line 1.
            "(3,20) Error: cannot inline default argument `k() + (*function () pure nothrow @nogc @safe => 2)()`",
        ]);
    });

    test("an array literal is copied node by node, never shared (p3.d)", () => {
        const { m, sc } = sema("module p3;\nvoid f(int[] a = [1, 2, 3]) {}\n");
        const arg = defaultArg(m, "f", 0);
        const r = inlineCopy(arg, sc);
        expect(diags).toEqual([]);
        const ale = r.isArrayLiteralExp()!;
        const src = arg.isArrayLiteralExp()!;
        expect(ale).not.toBeNull();
        expect(ale).not.toBe(src);
        expect(ale.elements).not.toBe(src.elements);
        expect(ale.elements!.length).toBe(3);
        for (let i = 0; i < 3; i++) {
            expect(ale.elements!.opIndex(i)).not.toBe(src.elements!.opIndex(i));
            expect(ale.elements!.opIndex(i)!.isIntegerExp()!.getInteger())
                .toBe(src.elements!.opIndex(i)!.isIntegerExp()!.getInteger());
        }
    });

    test("an IndexExp's `$` variable is cloned into the new parent and its uses renamed (p6.d)", () => {
        const { m, sc } = sema("module p6;\nint[] gArr;\nvoid f(int x = gArr[$ - 1]) {}\n");
        const arg = defaultArg(m, "f", 0);
        const src = arg.isIndexExp()!;
        expect(src.lengthVar).not.toBeNull();
        const r = inlineCopy(arg, sc).isIndexExp()!;
        expect(diags).toEqual([]);
        expect(r).not.toBe(src);
        const vto = r.lengthVar!;
        expect(vto).not.toBe(src.lengthVar);
        expect(vto.ident).toBe(src.lengthVar!.ident);          // `__dollar`: the memcpy clone keeps every field
        expect(vto.type).toBe(src.lengthVar!.type);
        expect(vto.parent).toBe(sc.parent);                     // … except the parent (inline.d:981)
        expect(vto.nestedrefs).not.toBe(src.lengthVar!.nestedrefs); // inline value structs are not aliased
        // `$ - 1`: the VarExp of `__dollar` now names the clone (the from/to rename, inline.d:555-563).
        const min = r.e2!.isMinExp()!;
        expect(min.e1!.isVarExp()!.var_).toBe(vto);
        expect(src.e2!.isMinExp()!.e1!.isVarExp()!.var_).toBe(src.lengthVar);
    });

    test("a SliceExp's `$` variable is cloned the same way (p6.d)", () => {
        const { m, sc } = sema("module p6;\nint[] gArr;\nvoid f(int[] s = gArr[1 .. $]) {}\n");
        const arg = defaultArg(m, "f", 0);
        const src = arg.isSliceExp()!;
        expect(src.lengthVar).not.toBeNull();
        const r = inlineCopy(arg, sc).isSliceExp()!;
        expect(diags).toEqual([]);
        expect(r.lengthVar).not.toBe(src.lengthVar);
        expect(r.upr!.isVarExp()!.var_).toBe(r.lengthVar);
    });

    // q10.d (ldc2 1.43.0, `-c -o- -vcolumns`, with `f(); f2();` appended inside `outer`): exit 1, only
    // q10.d(7,20): Error: cannot inline default argument `N(1)`; without the calls, exit 0.
    const q10 = "module q10;\nvoid outer() {\n    int w;\n    void nested() {}\n"
        + "    void f(void delegate() d = &nested) {}\n    struct N { int q; void m() { w++; } }\n"
        + "    void f2(N n = N(1)) {}\n}\n";

    test("a nested struct literal costs COST_MAX and is rejected (q10.d, inlinecost.d:407)", () => {
        const { m, sc } = sema(q10);
        const arg = localDefaultArg(m, "outer", "f2", 0);
        expect(arg.isStructLiteralExp()).not.toBeNull();
        const r = inlineCopy(arg, sc);
        expect(r.op).toBe(EXP.error);
        expect(diags).toEqual(["(7,20) Error: cannot inline default argument `N(1)`"]);
    });

    test("a delegate to a nested function is copied without a cost check (q10.d, inline.d:99-107)", () => {
        const { m, sc } = sema(q10);
        const arg = localDefaultArg(m, "outer", "f", 0);
        const r = inlineCopy(arg, sc);
        expect(diags).toEqual([]);
        expect(r.isDelegateExp()).not.toBeNull();
        expect(r).not.toBe(arg);
        expect(r.isDelegateExp()!.func).toBe(arg.isDelegateExp()!.func);
    });
});
