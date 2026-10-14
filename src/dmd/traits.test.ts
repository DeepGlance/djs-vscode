// Co-located tests for src/dmd/traits.ts (ported from dmd/traits.d), with the LDC leg it reaches
// through dmd/hooks.d and gen/ldctraits.d.
//
// dmd/traits.d carries ZERO in-source `unittest{}` blocks (10 §1.6b), so this file pins behaviour: each
// source below is run through lex -> parse -> runSemantic as a module of its own, and what `pragma(msg)`
// writes to stderr plus the diagnostics raised are compared with ldc2 1.43.0 (arm64-apple-darwin,
// `ldc2 -c -o- <file>`) on the same source, byte for byte. The ldc2 output is quoted at each pin.
import { initSemaHarness } from "../sema-harness.js"; // imports ./dmd/parse.js first: the module-graph root (10 §1.5)
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Parser } from "./parse.js";
import { ErrorSinkNull } from "./errorsink.js";
import { moduleFromParse } from "./dmodule.js";
import { runSemantic } from "./dsymbolsem.js";
import { setDiagnosticHandler } from "./errors.js";
import { dmdformat } from "./root/dmdformat.js";
import { dsToJs } from "../dstring.js";
import * as traits from "./traits.js";
import { getTypePointerBitmap } from "./traits.js";
import { Array as DArray } from "./root/array.js";
import { Type } from "./mtype.js";
import { sarrayOf } from "./typesem.js";
import { Loc } from "./location.js";
import { global } from "./globals.js";

/** lex + parse + runSemantic over `src` (UTF-8) as a module of its own; returns the captured diagnostics
 *  (`<line>: <header><message>`) and the text `pragma(msg)` wrote to stderr. */
function runModule(src: string): { diags: string[]; msgs: string } {
    const bytes = new TextEncoder().encode(src);
    const buf = new Uint8Array(bytes.length + 1); // NUL-terminated: the lexer scans to the NUL
    buf.set(bytes, 0);
    const msgs: string[] = [];
    const diags: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
        msgs.push(chunk instanceof Uint8Array ? dsToJs(chunk) : String(chunk)); // LLVM's warning is written as bytes
        return true;
    });
    setDiagnosticHandler((loc, _color, header, messageFormat, args) => {
        diags.push(`${loc.linnum}: ` + dsToJs(header) + dsToJs(dmdformat(messageFormat, [...args])));
        return true;
    });
    try {
        const p = new Parser(null, null, buf, false, new ErrorSinkNull(), null, false);
        p.nextToken();
        runSemantic(moduleFromParse(p.parseModule(), p.md));
    } finally {
        setDiagnosticHandler(null);
        spy.mockRestore();
    }
    return { diags, msgs: msgs.join("") };
}

describe("traits.ts — module surface", () => {
    beforeEach(() => {
        initSemaHarness();
    });

    test("SMOKE: the module loads and exports D's two public functions", () => {
        expect(typeof traits.semanticTraits).toBe("function");
        expect(typeof traits.getTypePointerBitmap).toBe("function");
    });

    test("D module-private functions stay off the export surface (traits.d:81, :293, :2279, :2410)", () => {
        for (const name of ["getDsymbolWithoutExpCtx", "pointerBitmap", "isSame", "traitNotFound"])
            expect(name in traits, name).toBe(false);
    });

    test("getTypePointerBitmap sizes the bitmap and zero-fills it for a pointer-free type", () => {
        // ldc2: `pragma(msg, __traits(getPointerBitmap, int[5]));` -> [20LU, 0LU]: 20 bytes, one word of bits.
        const data = new DArray<bigint>();
        const sz = getTypePointerBitmap(Loc.initial, sarrayOf(Type.tint32, 5n), data, global.errorSink!);
        expect(sz).toBe(20n);
        expect(data.length).toBe(1);
        expect(data.opIndex(0)).toBe(0n);
    });
});

describe("traits.ts — __traits end to end (ldc2-pinned)", () => {
    beforeEach(() => {
        initSemaHarness();
    });

    test("type predicates and struct queries", () => {
        const r = runModule(`module p1;
struct S { int x; void f() {} static int sf; }
struct P { this(this) {} }
struct C { this(ref C) {} }
struct D { ~this() {} int[] a; }
enum E { a, b }
int gi;
void fn(ref int a, out int b, lazy int c, int d) {}
pragma(msg, __traits(isArithmetic, int, double));
pragma(msg, __traits(isArithmetic, int, S));
pragma(msg, __traits(isArithmetic));
pragma(msg, __traits(isFloating, float, real));
pragma(msg, __traits(isFloating, int));
pragma(msg, __traits(isIntegral, byte, char, bool));
pragma(msg, __traits(isScalar, int*, double));
pragma(msg, __traits(isScalar, S));
pragma(msg, __traits(isUnsigned, uint, int));
pragma(msg, __traits(isStaticArray, int[3]));
pragma(msg, __traits(isStaticArray, int[]));
pragma(msg, __traits(isAssociativeArray, int[int]));
pragma(msg, __traits(isPOD, S));
pragma(msg, __traits(isPOD, P));
pragma(msg, __traits(isPOD, int));
pragma(msg, __traits(hasPostblit, P));
pragma(msg, __traits(hasPostblit, S));
pragma(msg, __traits(hasCopyConstructor, C));
pragma(msg, __traits(hasCopyConstructor, S));
pragma(msg, __traits(isCopyable, S));
pragma(msg, __traits(needsDestruction, D));
pragma(msg, __traits(needsDestruction, S));
pragma(msg, __traits(isZeroInit, S));
pragma(msg, __traits(isZeroInit, float));
pragma(msg, __traits(isZeroInit, E));
pragma(msg, __traits(isNested, S));
pragma(msg, __traits(isRef, fn));
pragma(msg, __traits(hasMember, S, "x"));
pragma(msg, __traits(hasMember, S, "y"));
pragma(msg, __traits(identifier, S));
pragma(msg, __traits(identifier, S.x));
pragma(msg, __traits(fullyQualifiedName, S));
pragma(msg, __traits(fullyQualifiedName, S.f));
pragma(msg, __traits(allMembers, S));
pragma(msg, __traits(derivedMembers, E));
pragma(msg, __traits(isSame, int, int));
pragma(msg, __traits(isSame, S, E));
pragma(msg, __traits(isSame, gi, gi));
pragma(msg, __traits(compiles, 1 + 1));
pragma(msg, __traits(compiles, undefined_x));
pragma(msg, __traits(getLinkage, fn));
pragma(msg, __traits(getLinkage, S));
pragma(msg, __traits(getVisibility, S));
pragma(msg, __traits(getFunctionAttributes, fn));
pragma(msg, __traits(getParameterStorageClasses, fn, 0));
pragma(msg, __traits(getParameterStorageClasses, fn, 1));
pragma(msg, __traits(getParameterStorageClasses, fn, 2));
pragma(msg, __traits(getPointerBitmap, S));
pragma(msg, __traits(getPointerBitmap, D));
pragma(msg, __traits(getTargetInfo, "objectFormat"));
pragma(msg, __traits(getLocation, S)[1 .. 3]);
pragma(msg, __traits(getFunctionVariadicStyle, fn));
pragma(msg, __traits(isReturnOnStack, fn));
pragma(msg, __traits(getAliasThis, S));
pragma(msg, __traits(isTemplate, S));
pragma(msg, __traits(isDeprecated, S));
pragma(msg, __traits(isFuture, S));
pragma(msg, __traits(isDisabled, S.f));
pragma(msg, __traits(getMember, S, "sf"));
pragma(msg, __traits(isStaticFunction, fn));
`);
        // ldc2 prints the same, and the one error with its supplemental (the static variable read by
        // `pragma(msg)` itself, not by the trait).
        expect(r.diags).toEqual([
            "67: Error: static variable `sf` cannot be read at compile time",
            "67:        while evaluating `pragma(msg, __traits(getMember, S, \"sf\"))`",
        ]);
        expect(r.msgs).toBe("true\nfalse\nfalse\ntrue\nfalse\ntrue\ntrue\nfalse\nfalse\ntrue\nfalse\ntrue\n"
            + "true\nfalse\ntrue\ntrue\nfalse\ntrue\nfalse\ntrue\ntrue\nfalse\ntrue\nfalse\ntrue\nfalse\nfalse\n"
            + "true\nfalse\nS\nx\np1.S\np1.S.f\nAliasSeq!(\"x\", \"f\", \"sf\")\nAliasSeq!(\"a\", \"b\")\ntrue\nfalse\n"
            + "true\ntrue\nfalse\nD\nD\npublic\nAliasSeq!(\"@system\")\nAliasSeq!(\"ref\")\nAliasSeq!(\"out\")\n"
            + "AliasSeq!(\"lazy\")\n[4LU, 0LU]\n[16LU, 2LU]\nmacho\nAliasSeq!(2, 1)\nnone\nfalse\nAliasSeq!()\n"
            + "false\nfalse\nfalse\nfalse\ntrue\n");
    });

    test("classes, overloads, attributes, linkage, pointer bitmaps", () => {
        // extern(C++) classes: they need no `Object`, which the hermetic harness has no druntime for.
        const r = runModule(`module p2;
extern(C++) class A { int x; void v() {} void v(int) {} final void fv() {} }
extern(C++) abstract class B : A { abstract void w(); override void v() {} }
extern(C++) final class F : B { override void w() {} }
struct S { int x; @(1, "u") int y; void f() {} void f(int) {} int g(T)(T t) { return 0; } }
deprecated struct Dep {}
template Tm(int n) { enum Tm = n; }
void fn(ref int a, out int b, lazy int c, scope int* d, return ref int e) {}
extern(C) int cfn(int, ...);
void dfn(...);
void tfn(int[] a...) {}
pragma(msg, __traits(isAbstractClass, B), " ", __traits(isAbstractClass, A), " ", __traits(isFinalClass, F));
pragma(msg, __traits(classInstanceSize, A), " ", __traits(classInstanceSize, B), " ",
    __traits(classInstanceAlignment, A));
pragma(msg, __traits(getVirtualIndex, A.fv), " ", __traits(getVirtualIndex, B.w));
pragma(msg, __traits(isVirtualMethod, A.v), " ", __traits(isFinalFunction, A.fv), " ",
    __traits(isAbstractFunction, B.w));
pragma(msg, __traits(isOverrideFunction, F.w), " ", __traits(isStaticFunction, fn));
pragma(msg, __traits(getOverloads, S, "f").length);
pragma(msg, __traits(getOverloads, S, "g").length, " ", __traits(getOverloads, S, "g", true).length);
pragma(msg, __traits(getVirtualMethods, A, "v").length);
pragma(msg, __traits(getAttributes, S.y));
pragma(msg, __traits(isDeprecated, Dep), " ", __traits(isTemplate, Tm), " ", __traits(isTemplate, S));
pragma(msg, __traits(identifier, Tm), " ", __traits(parent, S.f).stringof, " ", __traits(parent, S).stringof);
pragma(msg, __traits(getParameterStorageClasses, fn, 3), " ", __traits(getParameterStorageClasses, fn, 4));
pragma(msg, __traits(getFunctionVariadicStyle, cfn), " ", __traits(getFunctionVariadicStyle, dfn), " ",
    __traits(getFunctionVariadicStyle, tfn));
pragma(msg, __traits(getLinkage, cfn), " ", __traits(getLinkage, A));
pragma(msg, __traits(getPointerBitmap, A));
pragma(msg, __traits(getPointerBitmap, int*[3]));
pragma(msg, __traits(getPointerBitmap, void delegate()));
pragma(msg, __traits(child, S.init, S.x));
pragma(msg, __traits(isSame, Tm, Tm), " ", __traits(isSame, S.f, S.x), " ", __traits(isSame, 1, 1));
pragma(msg, __traits(compiles, int), " ", __traits(compiles, S.init.zz), " ", __traits(compiles));
pragma(msg, __traits(hasMember, A, "fv"), " ", __traits(hasMember, int, "max"));
pragma(msg, __traits(getTargetInfo, "floatAbi"), " ", __traits(getTargetInfo, "cppStd"));
pragma(msg, __traits(isNested, fn), " ", __traits(isModule, p2));
`);
        expect(r.diags).toEqual([]);
        expect(r.msgs).toBe("true false true\n12LU 12LU 8LU\n-1L 2L\ntrue true true\ntrue true\n2LU\n0LU 1LU\n"
            + "2LU\nAliasSeq!(1, \"u\")\ntrue true false\nTm S module p2\n"
            + "AliasSeq!(\"scope\") AliasSeq!(\"return\", \"ref\")\n"
            + "stdarg argptr typesafe\nC C++\n[12LU, 0LU]\n[24LU, 7LU]\n[16LU, 1LU]\n0\ntrue false true\n"
            + "true false false\ntrue true\nhard 201103\nfalse true\n");
    });

    test("parameters, parents and templates inside function bodies", () => {
        const r = runModule(`module p4;
void gn(ref int p, out int q, lazy int r, int s) {
    pragma(msg, __traits(isRef, p), " ", __traits(isOut, q), " ", __traits(isLazy, r), " ", __traits(isRef, s));
    pragma(msg, __traits(parameters).length);
    pragma(msg, __traits(identifier, __traits(parent, p)));
}
struct U { void m() { pragma(msg, __traits(isNested, U), " ", __traits(identifier, __traits(parent, m))); } }
auto lam = (int x) => x;
pragma(msg, __traits(isSame, lam, lam));
int k(T)(T t) { return 0; }
pragma(msg, __traits(isTemplate, k), " ", __traits(fullyQualifiedName, k!int));
`);
        expect(r.diags).toEqual([]);
        expect(r.msgs).toBe("true\ntrue p4.k!int.k\ntrue true true false\n4LU\ngn\nfalse U\n");
    });

    test("namespaces, bitfields, visibility, deprecated traits, LDC traits", () => {
        const r = runModule(`module p6;
extern(C++, "ns1", "ns2") struct N { int z; }
extern(C++) interface I { void im(); }
extern(C++) class A { void v() {} }
union Un { int a; float b; }
struct BF { int x; uint f : 3; uint g : 5; }
struct S { int x; private int p; }
pragma(msg, __traits(getCppNamespaces, N));
pragma(msg, __traits(isCOMClass, A));
pragma(msg, __traits(toType, "i").stringof);
pragma(msg, __traits(getBitfieldOffset, BF.g), " ", __traits(getBitfieldWidth, BF.g), " ",
    __traits(getBitfieldWidth, BF.x));
pragma(msg, __traits(isOverlapped, Un.a), " ", __traits(isOverlapped, S.x), " ", __traits(isBitfield, BF.f));
pragma(msg, __traits(getVisibility, S.p), " ", __traits(getProtection, S.x));
pragma(msg, __traits(getUnitTests, S).length);
pragma(msg, __traits(isVirtualFunction, A.v));
pragma(msg, __traits(getVirtualFunctions, A, "v").length);
pragma(msg, __traits(targetCPU, 1));
pragma(msg, __traits(targetHasFeature, "fp-armv8"), " ", __traits(targetHasFeature, "fuse-aes"), " ",
    __traits(targetHasFeature, "avx"));
pragma(msg, __traits(isPackage, p6), " ", __traits(isModule, p6));
pragma(msg, __traits(getOverloads, I, "im").length);
pragma(msg, __traits(isFloating, cfloat));
pragma(msg, __traits(isDeprecated, cfloat));
`);
        // ldc2 writes LLVM's `'-avx'` warning to stderr between the pragma lines; the ignored-arguments
        // warning of `targetCPU, 1` is not shown (warnings are off by default).
        expect(r.diags).toEqual([
            "16: Deprecation: `traits(isVirtualFunction)` is deprecated. Use `traits(isVirtualMethod)` instead",
            "17: Deprecation: `traits(getVirtualFunctions)` is deprecated. Use `traits(getVirtualMethods)` instead",
        ]);
        expect(r.msgs).toBe("AliasSeq!(\"ns1\", \"ns2\")\nfalse\nint\n0u 5u 32u\nfalse false true\nprivate public\n"
            + "0LU\n"
            + "true\n1LU\ngeneric\n'-avx' is not a recognized feature for this target (ignoring feature)\n"
            + "true true false\nfalse true\n1LU\ntrue\ntrue\n");
    });

    test("error paths: wrong argument count, unknown trait with the speller, non-type and non-symbol arguments", () => {
        const r = runModule(`module p3;
struct S { int x; }
void gn(ref int p, out int q, int r) {
    pragma(msg, __traits(isRef, p));
}
enum a = __traits(isPOD, 1);
enum b = __traits(isPOD, int, int);
enum c = __traits(isArithmetc, int);
enum d = __traits(fooBarBaz, int);
enum e = __traits(hasMember, S);
enum f = __traits(allMembers, 3);
enum g = __traits(targetHasFeature);
enum h = __traits(targetHasFeature, 3);
enum i = __traits(targetHasFeature, "");
enum j = __traits(targetHasFeature, "sse2");
enum k = __traits(getTargetInfo, "nope");
enum l = __traits(isNested, 3);
enum m = __traits(classInstanceSize, S);
enum n = __traits(identifier, 1);
enum o = __traits(getLinkage, 1);
enum p = __traits(child, S, 3);
enum q = __traits(parameters);
enum r = __traits(getPointerBitmap, 3);
enum s = __traits(getVirtualIndex, S);
enum t = __traits(initSymbol, int);
enum u = __traits(getLocation, p3);
`);
        expect(r.diags).toEqual([
            "6: Error: type expected as second argument of __traits `isPOD` instead of `1`",
            "7: Error: expected 1 arguments for `isPOD` but had 2",
            "8: Error: unrecognized trait `isArithmetc`, did you mean `isArithmetic`?",
            "9: Error: unrecognized trait `fooBarBaz`",
            "10: Error: expected 2 arguments for `hasMember` but had 1",
            "11: Error: in expression `__traits(allMembers, 3)` `3` can't have members",
            "11:        `3` must evaluate to either a module, a struct, an union, a class, an interface or a "
                + "template instantiation",
            "12: Error: __traits targetHasFeature expects one argument, not 0",
            "13: Error: string expected as argument of __traits targetHasFeature instead of 3",
            "14: Error: string expected as argument of __traits targetHasFeature instead of \"\"",
            "16: Error: `getTargetInfo` key `\"nope\"` not supported by this implementation",
            "17: Error: aggregate or function expected instead of `3`",
            "18: Error: first argument is not a class",
            "19: Error: argument `1` has no identifier",
            "20: Error: argument to `__traits(getLinkage, 1)` is not a declaration",
            "21: Error: symbol expected as second argument of __traits `child` instead of `3`",
            "22: Error: `__traits(parameters)` may only be used inside a function",
            "24: Error: first argument to __traits(getVirtualIndex) must be a function",
            "25: Error: struct / class type expected as argument to __traits(initSymbol) instead of `int`",
            "26: Error: can only get the location of a symbol, not `p3`",
        ]);
        // The one stderr line is LLVM's (ldctraits.cpp's `ApplyFeatureFlag` on `-sse2`); the function-body
        // pragma is not reached, because ldc2 skips semantic3 after errors.
        expect(r.msgs).toBe("'-sse2' is not a recognized feature for this target (ignoring feature)\n");
    });
});

describe("traits.ts — overload tuples and unittests (ldc2-pinned)", () => {
    beforeEach(() => {
        initSemaHarness();
    });

    const SRC = `module p7;
extern(C++) interface F1 { int visit(int); }
extern(C++) interface F2 { int visit(int); void visit(); }
extern(C++) interface F3 : F2, F1 {}
struct S {
    void t(T)(T x) {}
    void t(T, U)(T x, U y) {}
    void t(int x) {}
}
pragma(msg, __traits(getOverloads, F3, "visit").length);
pragma(msg, __traits(getOverloads, S, "t").length, " ", __traits(getOverloads, S, "t", true).length);
pragma(msg, __traits(getOverloads, S, "t", 1));
alias Ov = __traits(getOverloads, S, "t", true);
pragma(msg, __traits(isTemplate, Ov[1]), " ", __traits(isTemplate, Ov[0]));
struct U { unittest {} unittest {} }
pragma(msg, __traits(getUnitTests, U).length);
enum en = __traits(getAttributes, 1);
`;
    // Interface signatures deduplicated across inherited interfaces (traits.d:1294), template overloads
    // copied out of their overload set (traits.d:1256-1271), the getOverloads third-argument check,
    // and getUnitTests, whose tuple is filled only under -unittest (traits.d:1984).
    const DIAGS = [
        "12: Error: `bool` expected as third argument of `__traits(getOverloads)`, not `1` of type `int`",
        "12:        while evaluating `pragma(msg, __traits(getOverloads, S, \"t\", 1))`",
        "17: Error: first argument is not a symbol",
    ];

    test("without -unittest: ldc2 prints 2LU / 1LU 3LU / true false / 0LU", () => {
        const r = runModule(SRC);
        expect(r.diags).toEqual(DIAGS);
        expect(r.msgs).toBe("2LU\n1LU 3LU\ntrue false\n0LU\n");
    });

    test("with -unittest: getUnitTests finds both blocks (ldc2 -unittest: 2LU)", () => {
        global.params.useUnitTests = true;
        try {
            const r = runModule(SRC);
            expect(r.diags).toEqual(DIAGS);
            expect(r.msgs).toBe("2LU\n1LU 3LU\ntrue false\n2LU\n");
        } finally {
            global.params.useUnitTests = false;
        }
    });
});

describe("traits.ts — __traits(isSame) over function literals (lambdacomp.d)", () => {
    beforeEach(() => {
        initSemaHarness();
    });

    // Every pin below was checked against ldc2 1.43.0 (`ldc2 -c -o-`) as a `static assert`. A true pin is
    // a `static assert(__traits(isSame, ...))`, a false one the same with `!`; the module must be silent.
    const prelude = [
        "enum E { a = 3, b = 4 }",
        "enum int K = 7;",
        "enum int K1 = -1;",
        "enum ulong K2 = ulong.max;",
        "int f(int x) { return x; }",
        "int g(int x) { return x; }",
        "struct S { int m; }",
    ].join("\n") + "\n";
    test.each([
        ["parameter names do not matter", "__traits(isSame, x => x, y => y)"],
        ["the same body over renamed parameters", "__traits(isSame, x => x + 1, y => y + 1)"],
        ["different literals differ", "!__traits(isSame, x => x + 1, x => x + 2)"],
        ["different operators differ", "!__traits(isSame, x => x + 1, x => x - 1)"],
        ["parameter types are part of the serialization", "!__traits(isSame, (int a) => a, (long a) => a)"],
        ["equal parameter types", "__traits(isSame, (int a) => a, (int b) => b)"],
        ["the same enum member", "__traits(isSame, x => E.a + x, y => E.a + y)"],
        ["different enum members", "!__traits(isSame, x => E.a + x, y => E.b + y)"],
        ["the same manifest constant", "__traits(isSame, x => K + x, y => K + y)"],
        ["a negative constant equals its ulong image", "__traits(isSame, x => K1 + x, y => K2 + y)"],
        ["a call to the same function", "__traits(isSame, x => f(x), y => f(y))"],
        ["calls to different functions", "!__traits(isSame, x => f(x), y => g(y))"],
        ["a field of a struct argument", "__traits(isSame, (S s) => s.m, (S t) => t.m)"],
        ["unary operators", "__traits(isSame, x => -x, y => -y)"],
        ["different unary operators", "!__traits(isSame, x => -x, y => ~y)"],
        ["an array literal is not serializable, so never the same", "!__traits(isSame, x => [x], x => [x])"],
        ["a string literal is not serializable", "!__traits(isSame, x => \"s\", y => \"s\")"],
    ])("%s", (_what, cond) => {
        expect(runModule(prelude + `static assert(${cond});\n`).diags).toEqual([]);
    });
});

describe("traits.ts — diagnostics", () => {
    beforeEach(() => {
        initSemaHarness();
    });

    // ldc2 1.43.0 (`ldc2 -c -o-`), byte for byte: `Array.toString` renders `[a,b]` and traits.d:2238 cuts the brackets.
    // One test per shape: a diagnostic is not repeated within one process for the same location.
    test.each([
        ["1", "1"],
        ["1, 2", "1,2"],
        ["int", "int"],
        ["a, \"s\"", "a,\"s\""],
        ["1, int, [1,2]", "1,int,[1, 2]"],
        ["3, null, true", "3,null,true"],
        ["int[], f", "int[],f"],
        ["\"x\", \"y\\n\"", "\"x\",\"y\\n\""],
    ])("`__traits(parameters, %s)` lists its arguments through Array.toString (traits.d:2238)", (args, shown) => {
        const { diags } = runModule(`void f(int a) { enum x = __traits(parameters, ${args}); }\n`);
        expect(diags).toEqual([
            `1: Error: \`__traits(parameters)\` cannot have arguments, but \`${shown}\` was supplied`,
        ]);
    });
});
