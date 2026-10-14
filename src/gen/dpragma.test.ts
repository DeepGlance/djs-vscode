// Co-located tests for src/gen/dpragma.ts (gen/dpragma.d, bodies from gen/pragma.cpp).
//
// gen/dpragma.d and gen/pragma.cpp carry no unittests (10 §1.6b), so this file holds one module-load smoke
// test plus behaviour pins: each pin is a whole D module driven through lex -> parse -> runSemantic, with the
// expected diagnostics and values taken from ldc2 1.43.0 (arm64-apple-darwin) on the same source.

import { afterEach, beforeEach, describe, expect, test } from "vitest";
// First on purpose (01 §4.8): the module under test is the entry of its import graph here, so the smoke
// test below catches a load-order regression on the dpragma -> expressionsem -> builtin/pragmasem cycle.
import { DtoCheckPragma, DtoCheckProfileInstrPragma, DtoGetPragma, DtoIsIntrinsic, LDCPragma, LDCPragmaCpp }
    from "./dpragma.js";
import { initSemaHarness, sourceMembers } from "../sema-harness.js";
import { Parser } from "../dmd/parse.js";
import { ErrorSinkNull } from "../dmd/errorsink.js";
import { global } from "../dmd/globals.js";
import { moduleFromParse, type Module } from "../dmd/dmodule.js";
import { runSemantic } from "../dmd/dsymbolsem.js";
import {
    ErrorSinkCompiler, FatalError, setDiagnosticHandler, setFatalErrorHandler, throwFatalError,
} from "../dmd/errors.js";
import { dmdformat } from "../dmd/root/dmdformat.js";
import { EXP } from "../dmd/tokens.js";
import { initDtemplate } from "../dmd/dtemplate.js";
import { dsToJs } from "../dstring.js";
import type { Dsymbols } from "../dmd/arraytypes.js";
import type { Expression, IntegerExp, RealExp } from "../dmd/expression.js";

let messages: string[] = [];

beforeEach(() => {
    initSemaHarness();
    initDtemplate(); // `new TypeDeduced(…)` (template argument deduction) needs it (dtemplate.ts:512)
    messages = [];
    setDiagnosticHandler((loc, _color, header, messageFormat, args) => {
        const text = dsToJs(dmdformat(messageFormat, [...args]));
        messages.push(`(${loc.linnum},${loc.charnum}): ${dsToJs(header)}${text}`);
        return true;
    });
    setFatalErrorHandler(throwFatalError);
});

afterEach(() => {
    setDiagnosticHandler(null);
    setFatalErrorHandler(null);
});

/** NUL-terminated source buffer (the lexer scans to the NUL). */
function srcBuf(s: string): Uint8Array {
    const b = new Uint8Array(s.length + 1);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    return b;
}

/** Lex, parse and run semantic over `src`; a `fatal()` surfaces as `FatalError`. */
function sema(src: string): Module {
    const p = new Parser(null, null, srcBuf(src), false, new ErrorSinkNull(), null, false);
    p.nextToken();
    const members: Dsymbols = p.parseModule();
    const m = moduleFromParse(members, p.md);
    runSemantic(m);
    return m;
}

/** The folded initializer of the manifest constant `name`. */
function enumValue(m: Module, name: string): Expression {
    for (const s of sourceMembers(m)) {
        const vd = s.isVarDeclaration();
        if (vd !== null && dsToJs(vd.ident!.toString()) === name)
            return vd._init!.isExpInitializer()!.exp!;
    }
    throw new Error(`no enum ${name}`);
}

/**
 * Runs `src` on fresh compiler state and returns its diagnostics, with "FATAL" appended when semantic stopped in
 * `fatal()`. `compilerSink` routes `sc.eSink` reports (chkformat) to the diagnostic handler, as in ldc2.
 */
function diagnose(src: string, compilerSink = false): string[] {
    initSemaHarness();
    initDtemplate();
    messages = [];
    if (compilerSink)
        global.errorSink = new ErrorSinkCompiler();
    try {
        sema(src);
    } catch (ex) {
        if (!(ex instanceof FatalError))
            throw ex;
        messages.push("FATAL");
    }
    return messages;
}

/** The 64-bit pattern of a double, as 16 hex digits. */
function bits(x: number): string {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, x);
    return dv.getBigUint64(0).toString(16).padStart(16, "0");
}

// Every source below starts with `module m; ` (10 columns), so ldc2 and the port agree on module name and column.
describe("gen/dpragma — module surface", () => {
    test("loads first and exports the gen/dpragma.d functions (dpragma.d:50-53)", () => {
        // Smoke test (10 §1.6b): importing the module executes its top level before anything else in this file.
        expect(typeof DtoGetPragma).toBe("function");
        expect(typeof DtoCheckPragma).toBe("function");
        expect(typeof DtoCheckProfileInstrPragma).toBe("function");
        expect(typeof DtoIsIntrinsic).toBe("function");
    });
});

describe("DtoGetPragma / DtoCheckPragma diagnostics (gen/pragma.cpp), byte-exact against ldc2", () => {
    test.each([
        ["module m; pragma(LDC_intrinsic) double f(double);",
            ["(1,11): Error: `pragma(LDC_intrinsic)` requires exactly 1 string literal parameter", "FATAL"]],
        ["module m; pragma(LDC_intrinsic, 3) double f(double);",
            ["(1,11): Error: `pragma(LDC_intrinsic)` requires exactly 1 string literal parameter", "FATAL"]],
        ['module m; pragma(LDC_intrinsic, "llvm.sqrt.f64") int x;',
            ["(1,54): Error: the `LDC_intrinsic` pragma doesn't affect exactly 1 function/template declaration",
                "FATAL"]],
        ["module m; pragma(LDC_no_typeinfo, 1) struct S {}",
            ["(1,11): Error: `pragma(LDC_no_typeinfo)` takes no parameters", "FATAL"]],
        ["module m; pragma(LDC_no_moduleinfo, 1);",
            ["(1,11): Error: `pragma(LDC_no_moduleinfo)` takes no parameters", "FATAL"]],
        // A priority above 65535 is reported and clamped, not fatal (pragma.cpp:174-177).
        ["module m; pragma(LDC_global_crt_ctor, 70000) void f() {}",
            ["(1,11): Error: `pragma(LDC_global_crt_ctor)` may not have a priority greater than 65535"]],
        ['module m; pragma(LDC_global_crt_dtor, "x") void f() {}',
            ["(1,11): Error: `pragma(LDC_global_crt_dtor)` requires at most 1 integer literal parameter", "FATAL"]],
        ["module m; pragma(LDC_global_crt_ctor) int f() { return 0; }",
            ["(1,43): Error: function `m.f` must return `void` for `pragma(LDC_global_crt_ctor)`"]],
        ["module m; pragma(LDC_global_crt_ctor) void f(int) {}",
            ["(1,44): Error: function `m.f` must not take any parameters for `pragma(LDC_global_crt_ctor)`"]],
        ["module m; struct S { pragma(LDC_global_crt_ctor) void f() {} }",
            ["(1,55): Error: function `m.S.f` cannot be a non-static member function for "
                + "`pragma(LDC_global_crt_ctor)`"]],
        // dmd's own crt_constructor arm (pragmasem.d:200) is dead in LDC: DtoGetPragma claims the ident first,
        // so the argument is a priority and the check is LDC's (pragma.cpp:166).
        ["module m; pragma(crt_constructor) void f() {} pragma(crt_constructor, 5) void g(int) {}",
            ["(1,79): Error: function `m.g` must not take any parameters for `pragma(crt_constructor)`"]],
        ['module m; pragma(LDC_intrinsic, "llvm.sqrt.f64") { pragma(LDC_alloca) void* f(ulong); }',
            ["(1,77): Error: multiple LDC specific pragmas are not allowed", "FATAL"]],
        ["module m; pragma(LDC_extern_weak) int x;",
            ["(1,39): Error: `LDC_extern_weak` requires storage class `extern`", "FATAL"]],
        ["module m; pragma(LDC_extern_weak) extern int x;",
            ["(1,46): Error: `LDC_extern_weak` cannot be applied to thread-local variable `m.x`", "FATAL"]],
        ["module m; pragma(LDC_extern_weak) void f() {}",
            ["(1,40): Error: `LDC_extern_weak` cannot be applied to function definitions", "FATAL"]],
        ["module m; pragma(LDC_va_start) void f(T, U)(T t, U u);",
            ["(1,37): Error: the `LDC_va_start` pragma template must have exactly one template parameter", "FATAL"]],
        ["module m; pragma(LDC_va_arg) T f(T)(); pragma(LDC_va_arg) T f(T)(int);",
            ["(1,32): Error: the `LDC_va_arg` pragma template must not be overloaded", "FATAL"]],
        ["module m; pragma(LDC_atomic_rmw) T f(T)(T x);",
            ["(1,11): Error: `pragma(LDC_atomic_rmw)` requires exactly 1 string literal parameter", "FATAL"]],
        ["module m; pragma(LDC_inline_asm) R f(A, B)();",
            ["(1,36): Error: the `LDC_inline_asm` pragma template must have exactly zero or one template parameters",
                "FATAL"]],
        ["module m; pragma(LDC_inline_ir) void f();",
            ["(1,38): Error: the `LDC_inline_ir` pragma is only allowed on template declarations", "FATAL"]],
        ["module m; pragma(LDC_inline_ir) R f(int s, R)();",
            ["(1,35): Error: the `LDC_inline_ir` pragma template must have three (string, type and type tuple) or five "
                + "(string, string, string, type and type tuple) parameters", "FATAL"]],
    ])("%s", (src, expected) => {
        expect(diagnose(src)).toEqual(expected);
    });

    test("accepted shapes: one pragma over two functions, an empty block, LDC_fence on two functions", () => {
        // DtoCheckPragma runs once per member of the pragma's block (pragmasem.d:82), so each count is 1.
        expect(diagnose('module m; pragma(LDC_intrinsic, "llvm.sqrt.f64") { double f(double); double g(double); }'))
            .toEqual([]);
        expect(diagnose("module m; pragma(LDC_extern_weak) { }")).toEqual([]);
        expect(diagnose("module m; pragma(LDC_fence) { void f(); void g(); }")).toEqual([]);
    });

    test("pragma(LDC_profile_instr) statement: a non-bool argument is rejected (DtoCheckProfileInstrPragma)", () => {
        expect(diagnose("module m; void f() { pragma(LDC_profile_instr, 2); }"))
            .toEqual(["(1,22): Error: pragma(LDC_profile_instr, true or false) expected"]);
        expect(diagnose("module m; void f() { pragma(LDC_profile_instr, false); }")).toEqual([]);
    });

    test("taking the address of an intrinsic is an error (expressionsem.d:10380)", () => {
        const src = 'module m; pragma(LDC_intrinsic, "llvm.sqrt.f64") double sq(double); void g(){ auto p = &sq; }';
        expect(diagnose(src))
            .toEqual(["(1,88): Error: cannot take the address of intrinsic function `sq`"]);
    });

    test("pragma(LDC_profile_instr) on declarations: checked at every scope setup (dsymbolsem.d:9092-9111)", () => {
        // ldc2 reports the declaration form three times, once per setScope pass over the pragma.
        const e = "(1,11): Error: pragma(LDC_profile_instr, true or false) expected";
        expect(diagnose("module m; pragma(LDC_profile_instr, 1) void f() {}")).toEqual([e, e, e]);
        expect(diagnose("module m; pragma(LDC_profile_instr, false) void f() {}")).toEqual([]);
    });

    test("unknown pragmas are ignored by default (globals.d:210 ignoreUnsupportedPragmas = true)", () => {
        expect(diagnose("module m; pragma(LDC_bogus) void f(); pragma(bogus) void g();")).toEqual([]);
    });
});

describe("the state DtoGetPragma / DtoCheckPragma leave on declarations", () => {
    test("LDC_intrinsic: llvmInternal and mangleOverride on the function (pragma.cpp:356-357)", () => {
        const m = sema('module m; pragma(LDC_intrinsic, "llvm.sqrt.f64") double sq(double);');
        const fd = sourceMembers(m)[0]!.isAttribDeclaration()!.decl!.opIndex(0)!.isFuncDeclaration()!;
        expect(fd.llvmInternal).toBe(LDCPragmaCpp.LLVMintrinsic);
        expect(dsToJs(fd.mangleOverride!)).toBe("llvm.sqrt.f64");
        expect(DtoIsIntrinsic(fd)).toBe(true);
    });

    test("an `ldc.` name selects LDC's own intrinsic by binary search (pragma.cpp:141-158)", () => {
        const m = sema('module m; pragma(LDC_intrinsic, "ldc.bitop.bts") int bts(ulong* p, ulong bitnum);');
        const fd = sourceMembers(m)[0]!.isAttribDeclaration()!.decl!.opIndex(0)!.isFuncDeclaration()!;
        expect(fd.llvmInternal).toBe(LDCPragmaCpp.LLVMbitop_bts);
        expect(DtoIsIntrinsic(fd)).toBe(true); // a magic intrinsic (pragma.cpp:597)
    });

    test("LDC_intrinsic on a template: llvmInternal and intrinsicName on the TemplateDeclaration", () => {
        const m = sema('module m; pragma(LDC_intrinsic, "llvm.sqrt.f#") T sqrt(T)(T x);');
        const td = sourceMembers(m)[0]!.isAttribDeclaration()!.decl!.opIndex(0)!.isTemplateDeclaration()!;
        expect(td.llvmInternal).toBe(LDCPragmaCpp.LLVMintrinsic);
        expect(dsToJs(td.intrinsicName!)).toBe("llvm.sqrt.f#\0"); // the C string, terminator included
    });

    test("crt pragmas: the flag and the priority (pragma.cpp:401-406); the default priority is 65535", () => {
        const m = sema("module m; pragma(LDC_global_crt_ctor, 123) void f() {} pragma(crt_destructor) void g() {}");
        const [pf, pg] = sourceMembers(m);
        const f = pf!.isAttribDeclaration()!.decl!.opIndex(0)!.isFuncDeclaration()!;
        const g = pg!.isAttribDeclaration()!.decl!.opIndex(0)!.isFuncDeclaration()!;
        expect([f.isCrtCtor, f.isCrtDtor, f.priority]).toEqual([true, false, 123]);
        expect([g.isCrtCtor, g.isCrtDtor, g.priority]).toEqual([false, true, 65535]);
    });

    test("LDC_no_moduleinfo / LDC_verbose set their Module flags and are otherwise ignored (LLVMignore)", () => {
        const m = sema("module m; pragma(LDC_no_moduleinfo); pragma(LDC_verbose);");
        expect(m.noModuleInfo).toBe(true);
        expect(m.llvmForceLogging).toBe(true);
        expect(messages).toEqual([]);
    });

    test("the D binding and the C++ enum disagree from LLVMconvertvector on (dpragma.d:22 vs pragma.h:25)", () => {
        expect(LDCPragma.LLVMintrinsic).toBe(LDCPragmaCpp.LLVMintrinsic);
        expect(LDCPragma.LLVMbitop_vst).toBe(LDCPragmaCpp.LLVMbitop_vst);
        expect(LDCPragma.LLVMextern_weak).toBe(24);
        expect(LDCPragmaCpp.LLVMconvertvector).toBe(24);
        expect(LDCPragmaCpp.LLVMextern_weak).toBe(25);
        // ldc2 consequence: the weak-symbol test at expression.d:333 compares the stored 25 against 24, so a weak
        // extern's address still folds to true: `static if (&x)` takes the true branch.
        const m = sema("module m; pragma(LDC_extern_weak) extern __gshared int x; enum b = cast(bool)&x;");
        expect(messages).toEqual([]);
        expect((enumValue(m, "b") as IntegerExp).value).toBe(1n);
    });
});

describe("CTFE through pragma(LDC_intrinsic) (builtin.d:93-127)", () => {
    test("llvm.sqrt / sin / exp / fabs / floor / lround fold to ldc2's values", () => {
        const m = sema('module m;\n'
            + 'pragma(LDC_intrinsic, "llvm.sqrt.f64") double sq(double);\n'
            + 'pragma(LDC_intrinsic, "llvm.sin.f64") double sn(double);\n'
            + 'pragma(LDC_intrinsic, "llvm.exp.f64") double ex(double);\n'
            + 'pragma(LDC_intrinsic, "llvm.fabs.f64") double fa(double);\n'
            + 'pragma(LDC_intrinsic, "llvm.floor.f32") float fl(float);\n'
            + 'pragma(LDC_intrinsic, "llvm.lround.i64.f64") long lr(double);\n'
            + "enum a = sq(2.0); enum b = sn(1.0); enum d = ex(1.0); enum g = fa(-3.0); enum f = fl(-2.5f);\n"
            + "enum h = lr(2.5);\n");
        expect(messages).toEqual([]);
        // ldc2 -run printing the enums with %a: 0x1.6a09e667f3bcdp+0 0x1.aed548f090ceep-1 0x1.5bf0a8b145769p+1
        expect(bits((enumValue(m, "a") as RealExp).value)).toBe("3ff6a09e667f3bcd");
        expect(bits((enumValue(m, "b") as RealExp).value)).toBe("3feaed548f090cee");
        expect(bits((enumValue(m, "d") as RealExp).value)).toBe("4005bf0a8b145769");
        expect((enumValue(m, "g") as RealExp).value).toBe(3);
        expect((enumValue(m, "f") as RealExp).value).toBe(-3);
        expect((enumValue(m, "h") as IntegerExp).value).toBe(3n);
    });

    test("llvm.cos / llvm.log: the port's value, 1 ULP from ldc2's libm (the ruled known gap)", () => {
        const m = sema('module m; pragma(LDC_intrinsic, "llvm.cos.f64") double cs(double);'
            + ' pragma(LDC_intrinsic, "llvm.log.f64") double lg(double); enum c = cs(0.1); enum e = lg(3.0);');
        expect(messages).toEqual([]);
        // KNOWN GAP (V8 vs libm, 1 ULP): ldc2 folds cos(0.1) to 3fefd712f9a817c1 and log(3.0) to 3ff193ea7aad030b.
        expect(bits((enumValue(m, "c") as RealExp).value)).toBe("3fefd712f9a817c0");
        expect(bits((enumValue(m, "e") as RealExp).value)).toBe("3ff193ea7aad030a");
    });

    test("bitop-style intrinsics: bswap, ctpop, ctlz, cttz", () => {
        const m = sema('module m;\n'
            + 'pragma(LDC_intrinsic, "llvm.bswap.i32") uint bswap32(uint);\n'
            + 'pragma(LDC_intrinsic, "llvm.ctpop.i64") ulong ctpop64(ulong);\n'
            + 'pragma(LDC_intrinsic, "llvm.ctlz.i32") uint ctlz32(uint, bool);\n'
            + 'pragma(LDC_intrinsic, "llvm.cttz.i32") uint cttz32(uint, bool);\n'
            + "enum a = bswap32(0x12345678u); enum b = ctpop64(0xF0F0uL); enum c = ctlz32(1u, false);\n"
            + "enum d = cttz32(8u, true);\n");
        expect(messages).toEqual([]);
        // ldc2 `pragma(msg, a, " ", b, " ", c, " ", d)`: 2018915346u 8LU 31u 3u
        expect((enumValue(m, "a") as IntegerExp).value).toBe(2018915346n);
        expect((enumValue(m, "b") as IntegerExp).value).toBe(8n);
        expect((enumValue(m, "c") as IntegerExp).value).toBe(31n);
        expect((enumValue(m, "d") as IntegerExp).value).toBe(3n);
        expect(enumValue(m, "a").op).toBe(EXP.int64);
    });

    test("the template form (LDC druntime's `llvm_sqrt(T)`): the instance's name resolves `f#` / `i#`", () => {
        // ldc2 `pragma(msg, r, " ", s, " ", t, " ", a, " ", c)`: 2.0 1.41421F 3.0L 2018915346u 8LU
        // (real is double here).
        const m = sema('module m; pragma(LDC_intrinsic, "llvm.sqrt.f#") T sqrt(T)(T x);'
            + ' enum r = sqrt(4.0); enum s = sqrt(2.0f); enum t = sqrt(9.0L);'
            + ' pragma(LDC_intrinsic, "llvm.bswap.i#") T bswap(T)(T x); enum a = bswap(0x12345678u);'
            + ' pragma(LDC_intrinsic, "llvm.ctpop.i#") T ctpop(T)(T x); enum c = ctpop(0xF0F0uL);');
        expect(messages).toEqual([]);
        expect((enumValue(m, "r") as RealExp).value).toBe(2);
        // eval_llvmsqrt builds the RealExp from the real_t result (builtin.d:597): typed float, value not rounded.
        expect((enumValue(m, "s") as RealExp).value).toBe(Math.SQRT2);
        expect((enumValue(m, "t") as RealExp).value).toBe(3);
        expect((enumValue(m, "a") as IntegerExp).value).toBe(2018915346n);
        expect((enumValue(m, "c") as IntegerExp).value).toBe(8n);
    });

    test("druntime's shape: core.math aliases an instance of an ldc.intrinsics template (core/math.d:81)", () => {
        // ldc2 on `import core.math, core.bitop;` folds sin(1.0) to 0.841471 and bswap(0x12345678u) to 2018915346u;
        // druntime declares them as `alias sin = llvm_sin!double;` and `alias bswap = llvm_bswap!uint;`.
        const m = sema('module m; pragma(LDC_intrinsic, "llvm.sin.f#") T llvm_sin(T)(T val);'
            + ' alias sin = llvm_sin!double;'
            + ' pragma(LDC_intrinsic, "llvm.bswap.i#") T llvm_bswap(T)(T val); alias bswap = llvm_bswap!uint;'
            + ' enum a = sin(1.0); enum b = bswap(0x12345678u);');
        expect(messages).toEqual([]);
        expect((enumValue(m, "a") as RealExp).value).toBe(0.8414709848078965); // ldc2 -run %a: 0x3feaed548f090cee
        expect((enumValue(m, "b") as IntegerExp).value).toBe(2018915346n);
    });

    test("a non-intrinsic LDC pragma on a template leaves the instance's name alone (llvmhelpers.cpp:1298)", () => {
        // ldc2 compiles both clean; the instance mangles as D (`_D1m__T5aloadTiZQjFKOxiZi`).
        expect(diagnose("module m; pragma(LDC_atomic_load) T atomicLoad(T)(in shared T* ptr); shared int x;"
            + " void f() { auto v = atomicLoad(&x); }")).toEqual([]);
        expect(diagnose("module m; pragma(LDC_atomic_load) T aload(T)(ref const shared T val); alias I = aload!int;"))
            .toEqual([]);
    });

    test.each([
        ['module m; pragma(LDC_intrinsic, "llvm.sqrt.f#") T sqrt(T)(T x); enum r = sqrt(4);',
            ["(1,78): Error: template instance `m.sqrt!int` has invalid parameter type for intrinsic `llvm.sqrt.f#`: "
                + "`int` is not a floating-point type", "FATAL"]],
        ['module m; struct S {} pragma(LDC_intrinsic, "llvm.sqrt.f#") T sqrt(T)(T x); alias q = sqrt!S;',
            ["(1,87): Error: template instance `m.sqrt!(S)` has invalid template parameter for intrinsic: `S`",
                "FATAL"]],
        ['module m; pragma(LDC_intrinsic, "llvm.sqrt.#") T sqrt(T)(T x); enum r = sqrt(4.0);',
            ["(1,50): Error: template `m.sqrt(T)(T x)` has an invalid intrinsic name: `llvm.sqrt.#`", "FATAL"]],
    ])("template-form diagnostics: %s", (src, expected) => {
        expect(diagnose(src)).toEqual(expected);
    });

    test("an unknown llvm name, and a wide string cut at its first zero byte, are not builtins", () => {
        const noSource = "Error: `b` cannot be interpreted at compile time, because it has no available source code";
        expect(diagnose('module m; pragma(LDC_intrinsic, "llvm.bogus.f64") double b(double); enum x = b(1.0);'))
            .toEqual([`(1,79): ${noSource}`]);
        // parseStringExp copies the UTF-16 bytes and C reads them as a `char*`: the name is "l" (pragma.cpp:34-37).
        expect(diagnose('module m; pragma(LDC_intrinsic, "llvm.sqrt.f64"w) double b(double); enum x = b(4.0);'))
            .toEqual([`(1,79): ${noSource}`]);
    });
});

describe("pragma(printf) reaches chkformat once DtoGetPragma answers LLVMnone", () => {
    test("a mismatched argument is the ldc2 deprecation", () => {
        // chkformat reports through `sc.eSink` (expressionsem.d:4716), the global sink: the compiler's, as in ldc2.
        const src = 'module m; pragma(printf) extern(C) int printf(const char*, ...); void f() { printf("%s\\n", 1); }';
        expect(diagnose(src, true))
            .toEqual(["(1,92): Deprecation: argument `1` for format specification `\"%s\"` must be `char*`, "
                + "not `int`"]);
    });
});
