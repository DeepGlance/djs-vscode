import { initSemaHarness } from "../../sema-harness.js"; // module-graph root first (10 §1.5)
import { describe, test, expect, beforeEach, afterAll, vi } from "vitest";

// Tests for mangle/cpp.ts (dmd/mangle/cpp.d): the ported D unittest (cpp.d:2525) and ldc2 pins of the Itanium C++
// mangler.
//
// GROUND TRUTH: ldc2 1.43.0 (arm64-apple-darwin). Two kinds of pins:
//   - DRIVER PINS: each CASES entry is one source file. ldc2 `-c -o-` on it printed `stderr` byte for byte (with the
//     file name where `@F@` stands) and exited with `code`; the test compiles the same text through the shim
//     (src/djs.ts `djsMain`, druntime from the shim's ldc2.conf import directory) in a fresh module registry and
//     compares both. `pragma(msg, X.mangleof)` reaches the mangler through mangleExact -> target.cpp.toMangle ->
//     toCppMangleItanium, and each `e_*` case ends in the mangler's own diagnostic and `fatal()`.
//   - HARNESS PINS: the two entry points no `.mangleof` reaches (`cppTypeInfoMangleItanium`, only LDC's C++ EH glue
//     calls it; `cppThunkMangleItanium`, only LDC's C++ vtable glue). Their expected names are the symbols ldc2 `-c`
//     writes into the object file for the same declarations (`nm`: `U __ZTI1E`, `T __ZThn8_N2MI1aEv`; Mach-O adds
//     the leading underscore).
//
// Constructs the CASES cover, by file: `basic` — every basic type, `long`/`ulong` on an LP64 target, the special
// enums `__c_long` and friends, pointers and const (`PK`, `K` before substitution), references, `out`, function
// pointers (`F..E`, `Y` for extern(C)), substitutions `S_` to `SE_`, class types (`P`, the extra slot of a const
// class), `__vector` (`Dv4_i`), `typeof(null)` (`Dn`), `noreturn`, C variadics (`z`), `ref` return, member
// functions and const members (`NK`), constructors (`C1`, copy constructor `C2`), destructors (`D1`), the
// non-template operators (`aS`, `eq`, `ix`, `cl`), static members, `__gshared` and `extern` variables;
// `ns` — `extern(C++, ns)` (Nspace) and `extern(C++, "ns")` (CPPNamespaceDeclaration), nested and mixed,
// substitution of namespaces, `std` (`St`) and its abbreviations `Sa`, `Sb`, `Ss`, `Si`, `So`, `Sd`;
// `tmpl` — function templates with type, value (`L..E`, negative `n`), alias (`XadL..EE` for a function, `L..E`
// for a variable) and variadic (`J..E`, `Dp`) arguments, template parameter references (`T_`, `T0_`), template
// structs as arguments, template template parameters, `auto` return, member templates and the templated
// operators (`ng`, `pl`, `ls`, `mL`, conversion `cv`); `abitag` — `@gnuAbiTag` on structs, functions,
// variables, templates and namespaced structs, with the leftover tags of the return type (`B4tag..`), pinned from
// a function body (semantic3, after semantic2 has evaluated the UDAs); `vfield` — the fake mangling of fields;
// `e_*` — every mangler diagnostic a source can reach: static array parameter, `immutable`/`shared` types, types
// with no C++ counterpart, unsupported template value and alias parameters, a TLS variable as an alias argument
// (`mangle_variable`'s "static non-`__gshared` non-`extern`" error, cpp.d:1035, reached through `template_arg`).
//
// NOT PINNED, with the reason: the "template this parameter" error (cpp.d:549) — no source reaches it on the -o-
// path (probe `void tf(this T)()`: the instance is D-mangled).
//
// `abiub*` — `.mangleof` of an abi-tagged function at module scope (semantic1, the UDA still the constructor CallExp)
// and from a function body (semantic3), for the four argument forms: the cases pin the declared divergence at
// cpp.d:2439, where the port reproduces ldc2's binary (it reads CallExp.arguments where D reads through null), so a
// `("x")` call (a typesafe-variadic slice) yields no tags at module scope and an `(["x"])` call yields its tags.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Parser } from "../parse.js";
import { Identifier } from "../identifier.js";
import { ds, dsToJs, dsUtf8, cstr } from "../../dstring.js";
import { ErrorSinkNull } from "../errorsink.js";
import { global } from "../globals.js";
import { moduleFromParse } from "../dmodule.js";
import type { Module } from "../dmodule.js";
import { runSemantic } from "../dsymbolsem.js";
import { Loc } from "../location.js";
import { StringExp } from "../expression.js";
import { Id } from "../id.js";
import type { Dsymbol, ScopeDsymbol } from "../dsymbol.js";
import { target } from "../target.js";
import { CppOperator, closestIndex, cppThunkMangleItanium, isCppOperator } from "./cpp.js";

// ── D unittest (cpp.d:2525) ───────────────────────────────────────────────────────────────────────────────────

describe("closestIndex (cpp.d unittest)", () => {
    beforeEach(() => {
        initSemaHarness();
    });

    test("unittest#1: binary search over sorted StringExps, found and not found, odd and even sizes", () => {
        const match = { value: false };
        const se = (s: string): StringExp => new StringExp(Loc.initial, [...ds(s)]);
        const s1 = se("Amande");
        const s2 = se("Baguette");
        const s3 = se("Croissant");
        const s4 = se("Framboises");
        const s5 = se("Proscuitto");

        // Found, odd size
        expect([closestIndex([s1, s2, s3, s4, s5], s1, match), match.value]).toEqual([0, true]);
        expect([closestIndex([s1, s2, s3, s4, s5], s2, match), match.value]).toEqual([1, true]);
        expect([closestIndex([s1, s2, s3, s4, s5], s3, match), match.value]).toEqual([2, true]);
        expect([closestIndex([s1, s2, s3, s4, s5], s4, match), match.value]).toEqual([3, true]);
        expect([closestIndex([s1, s2, s3, s4, s5], s5, match), match.value]).toEqual([4, true]);

        // Not found, even size
        expect([closestIndex([s2, s3, s4, s5], s1, match), match.value]).toEqual([0, false]);
        expect([closestIndex([s1, s3, s4, s5], s2, match), match.value]).toEqual([1, false]);
        expect([closestIndex([s1, s2, s4, s5], s3, match), match.value]).toEqual([2, false]);
        expect([closestIndex([s1, s2, s3, s5], s4, match), match.value]).toEqual([3, false]);
        expect([closestIndex([s1, s2, s3, s4], s5, match), match.value]).toEqual([4, false]);

        // Found, even size
        expect([closestIndex([s1, s2, s3, s4], s1, match), match.value]).toEqual([0, true]);
        expect([closestIndex([s1, s2, s3, s4], s2, match), match.value]).toEqual([1, true]);
        expect([closestIndex([s1, s2, s3, s4], s3, match), match.value]).toEqual([2, true]);
        expect([closestIndex([s1, s2, s3, s4], s4, match), match.value]).toEqual([3, true]);
        expect([closestIndex([s1, s3, s4, s5], s5, match), match.value]).toEqual([3, true]);

        // Not found, odd size
        expect([closestIndex([s2, s4, s5], s1, match), match.value]).toEqual([0, false]);
        expect([closestIndex([s1, s4, s5], s2, match), match.value]).toEqual([1, false]);
        expect([closestIndex([s1, s2, s4], s3, match), match.value]).toEqual([2, false]);
        expect([closestIndex([s1, s3, s5], s4, match), match.value]).toEqual([2, false]);
        expect([closestIndex([s1, s2, s4], s5, match), match.value]).toEqual([3, false]);
    });

    test("an empty slice answers 0, not found (cpp.d:2506)", () => {
        const match = { value: true };
        expect(closestIndex([], new StringExp(Loc.initial, [...ds("x")]), match)).toBe(0);
        expect(match.value).toBe(false);
    });
});

describe("isCppOperator", () => {
    beforeEach(() => {
        initSemaHarness();
    });

    test("the eight operator identifiers, and Unknown otherwise (cpp.d:61)", () => {
        expect(isCppOperator(Id.opCast)).toBe(CppOperator.Cast);
        expect(isCppOperator(Id.opAssign)).toBe(CppOperator.Assign);
        expect(isCppOperator(Id.opEquals)).toBe(CppOperator.Eq);
        expect(isCppOperator(Id.opIndex)).toBe(CppOperator.Index);
        expect(isCppOperator(Id.opCall)).toBe(CppOperator.Call);
        expect(isCppOperator(Id.opUnary)).toBe(CppOperator.Unary);
        expect(isCppOperator(Id.opBinary)).toBe(CppOperator.Binary);
        expect(isCppOperator(Id.opOpAssign)).toBe(CppOperator.OpAssign);
        expect(isCppOperator(Id.opCmp)).toBe(CppOperator.Unknown);
        expect(isCppOperator(Identifier.idPool(ds("foo")))).toBe(CppOperator.Unknown);
    });
});

// ── harness pins: typeinfo and thunk names ───────────────────────────────────────────────────────────────────

/// UTF-8 source bytes plus the NUL terminator the lexer expects.
function srcBuf(s: string): Uint8Array {
    const u = dsUtf8(s);
    const b = new Uint8Array(u.length + 1);
    b.set(u);
    return b;
}

function sema(src: string): Module {
    const p = new Parser(null, null, srcBuf(src), false, new ErrorSinkNull(), null, false);
    p.nextToken();
    const m = moduleFromParse(p.parseModule(), p.md);
    runSemantic(m);
    return m;
}

/// `sd` is structural: Module and AggregateDeclaration shadow Dsymbol fields with other types, so neither is
/// assignable to ScopeDsymbol by name (as mangle/index.test.ts).
function lookup(sd: Pick<ScopeDsymbol, "symtab">, name: string): Dsymbol {
    const s = sd.symtab ? sd.symtab.lookup(Identifier.idPool(ds(name))) : null;
    expect(s, name).not.toBeNull();
    return s!;
}

/// The entry points return D's `const(char)*`: the NUL-terminated bytes; the pin compares the text.
function text(p: Uint8Array): string {
    expect(p[p.length - 1]).toBe(0);
    return dsToJs(cstr(p));
}

const CLASSES = `module ti;
extern(C++) class E { void v() {} }
extern(C++, ns) class E2 { void v() {} }
extern(C++, "sns") class E3 { void v() {} }
extern(C++) struct Outer { extern(C++) class Inner { void v() {} } }
extern(C++) interface I1 { void a(); }
extern(C++) interface I2 { void b(); }
extern(C++) class MI : I1, I2 { override void a() {} override void b() {} }
`;

describe("typeinfo and thunk manglings (ldc2 object-file symbols)", () => {
    let m: Module;

    beforeEach(() => {
        initSemaHarness();
        m = sema(CLASSES);
    });

    test("sema of the class module is clean", () => {
        expect(global.errors).toBe(0);
    });

    test("target.cpp.typeInfoMangle: `_ZTI` + the class name, nested and namespaced (cpp.d:90)", () => {
        const cls = (s: Dsymbol) => s.isClassDeclaration()!;
        expect(text(target.cpp.typeInfoMangle(cls(lookup(m, "E"))))).toBe("_ZTI1E");
        expect(text(target.cpp.typeInfoMangle(cls(lookup(lookup(m, "ns").isNspace()!, "E2"))))).toBe("_ZTIN2ns2E2E");
        expect(text(target.cpp.typeInfoMangle(cls(lookup(m, "E3"))))).toBe("_ZTIN3sns2E3E");
        const outer = lookup(m, "Outer").isStructDeclaration()!;
        expect(text(target.cpp.typeInfoMangle(cls(lookup(outer, "Inner"))))).toBe("_ZTIN5Outer5InnerE");
    });

    test("cppThunkMangleItanium: `_ZThn<offset>_` + the function's encoding (cpp.d:103)", () => {
        const mi = lookup(m, "MI").isClassDeclaration()!;
        expect(text(cppThunkMangleItanium(lookup(mi, "a").isFuncDeclaration()!, 8))).toBe("_ZThn8_N2MI1aEv");
        expect(text(cppThunkMangleItanium(lookup(mi, "b").isFuncDeclaration()!, 16))).toBe("_ZThn16_N2MI1bEv");
    });
});

// ── driver pins: `pragma(msg, X.mangleof)` and the mangler's diagnostics, against ldc2 byte for byte ─────────

interface Case {
    name: string;
    code: number;
    src: string[];
    stderr: string[];
}

const CASES: Case[] = [
    {
        name: "basic",
        code: 0,
        src: [
            "module basic;",
            "enum __c_long : long;",
            "enum __c_ulong : ulong;",
            "enum __c_longlong : long;",
            "enum __c_ulonglong : ulong;",
            "enum __c_char : char;",
            "enum __c_wchar_t : dchar;",
            "extern(C++) struct S { int x; }",
            "extern(C++) struct T { int y; }",
            "extern(C++) class C { void v() {} }",
            "extern(C++) enum E : int { a }",
            "alias CFP = extern(C) void function();",
            "extern(C++):",
            "void f0();",
            "void f1(bool, byte, ubyte, short, ushort, int, uint, long, ulong, float, double, real, char, wchar,"
            + " dchar);",
            "void f2(const(char)*, const(char*), char**, const(int)**);",
            "void f3(ref int, ref const int, out S, int*);",
            "void f4(S*, S*, T*, T*, const(S)*, const(S)*);",
            "void f5(void function(int), CFP, int function(S*, S*));",
            "void f6(E, C, const C, __c_long, __c_ulong, __c_longlong, __c_ulonglong, __c_char, __c_wchar_t);",
            "void f7(__vector(int[4]), typeof(null), int[3]*, int, ...);",
            "noreturn f8(noreturn*);",
            "void f9(S, T, S*, T*, int*, int**, S**, T**, const(int)*, const(int)**, const(S)*, const(T)*, C, co"
            + "nst(C)*);",
            "ref int f10();",
            "struct M",
            "{",
            "    void m();",
            "    void mc() const;",
            "    ~this();",
            "    bool opEquals(ref const M) const;",
            "    int opIndex(int);",
            "    int opCall(int);",
            "    static void sm(M*);",
            "}",
            "struct M1 { this(int) {} }",
            "struct M2 { this(ref M2) {} }",
            "struct MA { void opAssign(int); }",
            "class K { this() {} ~this() {} void vk() {} }",
            "__gshared int gv;",
            "extern __gshared int ev;",
            "struct WithStatic { __gshared int sv; }",
            "extern(D):",
            "pragma(msg, \"f0 \", f0.mangleof);",
            "pragma(msg, \"f1 \", f1.mangleof);",
            "pragma(msg, \"f2 \", f2.mangleof);",
            "pragma(msg, \"f3 \", f3.mangleof);",
            "pragma(msg, \"f4 \", f4.mangleof);",
            "pragma(msg, \"f5 \", f5.mangleof);",
            "pragma(msg, \"f6 \", f6.mangleof);",
            "pragma(msg, \"f7 \", f7.mangleof);",
            "pragma(msg, \"f8 \", f8.mangleof);",
            "pragma(msg, \"f9 \", f9.mangleof);",
            "pragma(msg, \"f10 \", f10.mangleof);",
            "pragma(msg, \"m \", M.m.mangleof);",
            "pragma(msg, \"mc \", M.mc.mangleof);",
            "pragma(msg, \"ctor \", M1.__ctor.mangleof);",
            "pragma(msg, \"cpctor \", M2.__ctor.mangleof);",
            "pragma(msg, \"dtor \", M.__dtor.mangleof);",
            "pragma(msg, \"opAssign \", MA.opAssign.mangleof);",
            "pragma(msg, \"opEquals \", M.opEquals.mangleof);",
            "pragma(msg, \"opIndex \", M.opIndex.mangleof);",
            "pragma(msg, \"opCall \", M.opCall.mangleof);",
            "pragma(msg, \"sm \", M.sm.mangleof);",
            "pragma(msg, \"kctor \", K.__ctor.mangleof);",
            "pragma(msg, \"kdtor \", K.__dtor.mangleof);",
            "pragma(msg, \"vk \", K.vk.mangleof);",
            "pragma(msg, \"gv \", gv.mangleof);",
            "pragma(msg, \"ev \", ev.mangleof);",
            "pragma(msg, \"sv \", WithStatic.sv.mangleof);",
        ],
        stderr: [
            "f0 _Z2f0v",
            "f1 _Z2f1bahstijlmfdecDsDi",
            "f2 _Z2f2PKcS0_PPcPPKi",
            "f3 _Z2f3RiRKiR1SPi",
            "f4 _Z2f4P1SS0_P1TS2_PKS_S4_",
            "f5 _Z2f5PFviEPFYvvEPFiP1SS4_E",
            "f6 _Z2f61EP1CPKS0_lmxycw",
            "f7 _Z2f7Dv4_iDnPA3_iiz",
            "f8 _Z2f8Pv",
            "f9 _Z2f91S1TPS_PS0_PiPS3_PS1_PS2_PKiPS8_PKS_PKS0_P1CPKPKSE_",
            "f10 _Z3f10v",
            "m _ZN1M1mEv",
            "mc _ZNK1M2mcEv",
            "ctor _ZN2M1C1Ei",
            "cpctor _ZN2M2C2ERS_",
            "dtor _ZN1MD1Ev",
            "opAssign _ZN2MAaSEi",
            "opEquals _ZNK1MeqERKS_",
            "opIndex _ZN1MixEi",
            "opCall _ZN1MclEi",
            "sm _ZN1M2smEPS_",
            "kctor _ZN1KC1Ev",
            "kdtor _ZN1KD1Ev",
            "vk _ZN1K2vkEv",
            "gv gv",
            "ev ev",
            "sv _ZN10WithStatic2svE",
        ],
    },
    {
        name: "ns",
        code: 0,
        src: [
            "module ns;",
            "extern(C++, nsA)",
            "{",
            "    struct SA { int x; } void fa(SA*, SA*); __gshared int va;",
            "    extern(C++, nsB) { void fb(int); struct SB { void m(); } }",
            "    void fmix(SS, SA, SS, SA, SB*, SB*);",
            "}",
            "extern(C++, \"strns\") { struct SS { int x; } void fs(SS*, SS*); __gshared int vs; }",
            "extern(C++, \"outer\", \"inner\") { void fi(SS*); struct SI {} void fi2(SI*, SI*); }",
            "extern(C++, \"strns\") void fs2(SS, SA);",
            "extern(C++, std)",
            "{",
            "    struct char_traits(T) {}",
            "    struct allocator(T) {}",
            "    struct basic_string(T, Traits = char_traits!T, Alloc = allocator!T) {}",
            "    struct basic_istream(T, Traits = char_traits!T) {}",
            "    struct basic_ostream(T, Traits = char_traits!T) {}",
            "    struct basic_iostream(T, Traits = char_traits!T) {}",
            "    struct vector(T, A = allocator!T) {}",
            "    void fstd(int);",
            "    struct Plain { void m(); }",
            "}",
            "extern(C++, \"std\") { struct sv(T) {} void fstd2(int); }",
            "extern(C++):",
            "void g1(ref basic_string!char);",
            "void g2(ref basic_string!wchar);",
            "void g3(ref basic_istream!char, ref basic_ostream!char, ref basic_iostream!char);",
            "void g4(allocator!int*, vector!int*, vector!int*);",
            "void g5(ref basic_istream!wchar);",
            "void g6(sv!int*, sv!int*, std.Plain*);",
            "extern(D):",
            "pragma(msg, \"fa \", fa.mangleof);",
            "pragma(msg, \"va \", va.mangleof);",
            "pragma(msg, \"fb \", nsA.nsB.fb.mangleof);",
            "pragma(msg, \"SB.m \", nsA.nsB.SB.m.mangleof);",
            "pragma(msg, \"fs \", fs.mangleof);",
            "pragma(msg, \"vs \", vs.mangleof);",
            "pragma(msg, \"fi \", fi.mangleof);",
            "pragma(msg, \"fi2 \", fi2.mangleof);",
            "pragma(msg, \"fs2 \", fs2.mangleof);",
            "pragma(msg, \"fmix \", fmix.mangleof);",
            "pragma(msg, \"fstd \", fstd.mangleof);",
            "pragma(msg, \"Plain.m \", std.Plain.m.mangleof);",
            "pragma(msg, \"fstd2 \", fstd2.mangleof);",
            "pragma(msg, \"g1 \", g1.mangleof);",
            "pragma(msg, \"g2 \", g2.mangleof);",
            "pragma(msg, \"g3 \", g3.mangleof);",
            "pragma(msg, \"g4 \", g4.mangleof);",
            "pragma(msg, \"g5 \", g5.mangleof);",
            "pragma(msg, \"g6 \", g6.mangleof);",
        ],
        stderr: [
            "fa _ZN3nsA2faEPNS_2SAES1_",
            "va _ZN3nsA2vaE",
            "fb _ZN3nsA3nsB2fbEi",
            "SB.m _ZN3nsA3nsB2SB1mEv",
            "fs _ZN5strns2fsEPNS_2SSES1_",
            "vs _ZN5strns2vsE",
            "fi _ZN5outer5inner2fiEPN5strns2SSE",
            "fi2 _ZN5outer5inner3fi2EPNS0_2SIES2_",
            "fs2 _ZN5strns3fs2ENS_2SSEN3nsA2SAE",
            "fmix _ZN3nsA4fmixEN5strns2SSENS_2SAES1_S2_PNS_3nsB2SBES5_",
            "fstd _ZNSt4fstdEi",
            "Plain.m _ZNSt5Plain1mEv",
            "fstd2 _ZSt5fstd2i",
            "g1 _Z2g1RSs",
            "g2 _Z2g2RSbIDsSt11char_traitsIDsESaIDsEE",
            "g3 _Z2g3RSiRSoRSd",
            "g4 _Z2g4PSaIiEPSt6vectorIiS_ES3_",
            "g5 _Z2g5RSt13basic_istreamIDsSt11char_traitsIDsEE",
            "g6 _Z2g6PSt2svIiES1_PSt5Plain",
        ],
    },
    {
        name: "tmpl",
        code: 0,
        src: [
            "module tmpl;",
            "extern(C++):",
            "struct S { int x; }",
            "struct Tp(T, int N) { T[N] a; }",
            "struct Box(T) { T v; }",
            "T id(T)(T a) { return a; }",
            "void two(T, U)(T a, U b, T c, U d) {}",
            "void val(int N, uint U, long L)() {}",
            "void neg(int N)() {}",
            "void pk(T...)(T args) {}",
            "void pkr(T...)(ref T args) {}",
            "void tq(T)(const(T)* a, T* b, ref T c) {}",
            "Box!T boxed(T)(Box!T* a) { return *a; }",
            "void tpl(Tp!(int, 3)* a, Tp!(S, 2)* b, Tp!(int, 3)* c) {}",
            "int gfun() { return 1; }",
            "__gshared int gvar;",
            "void al(alias F)() {}",
            "struct Ops",
            "{",
            "    int opUnary(string op)() if (op == \"-\");",
            "    int opBinary(string op)(int b) if (op == \"+\");",
            "    int opBinary(string op)(S b) if (op == \"<<\");",
            "    void opOpAssign(string op)(int b) if (op == \"*\");",
            "    T opCast(T)() const;",
            "    void tm(T)(T a);",
            "",
            "}",
            "template Cont(T) { struct Cont { T v; } }",
            "void contf(alias C, T, int V)(C!(T)* p) {}",
            "auto autor(T)(T a) { return a; }",
            "extern(D):",
            "pragma(msg, \"id \", id!int.mangleof);",
            "pragma(msg, \"idS \", id!S.mangleof);",
            "pragma(msg, \"two \", two!(int, S).mangleof);",
            "pragma(msg, \"val \", val!(5, 7u, -3L).mangleof);",
            "pragma(msg, \"neg \", neg!(-2).mangleof);",
            "pragma(msg, \"pk \", pk!(int, S, int).mangleof);",
            "pragma(msg, \"pkr \", pkr!(int, char).mangleof);",
            "pragma(msg, \"tq \", tq!S.mangleof);",
            "pragma(msg, \"boxed \", boxed!int.mangleof);",
            "pragma(msg, \"tpl \", tpl.mangleof);",
            "pragma(msg, \"alf \", al!gfun.mangleof);",
            "pragma(msg, \"alv \", al!gvar.mangleof);",
            "pragma(msg, \"opUnary \", Ops.opUnary!\"-\".mangleof);",
            "pragma(msg, \"opBinary+ \", Ops.opBinary!\"+\".mangleof);",
            "pragma(msg, \"opBinary<< \", Ops.opBinary!\"<<\".mangleof);",
            "pragma(msg, \"opOpAssign \", Ops.opOpAssign!\"*\".mangleof);",
            "pragma(msg, \"opCast \", Ops.opCast!int.mangleof);",
            "pragma(msg, \"tm \", Ops.tm!S.mangleof);",
            "pragma(msg, \"contf \", contf!(Cont, int, 4).mangleof);",
            "pragma(msg, \"autor \", autor!int.mangleof);",
        ],
        stderr: [
            "id _Z2idIiET_S0_",
            "idS _Z2idI1SET_S1_",
            "two _Z3twoIi1SEvT_T0_S1_S2_",
            "val _Z3valILi5ELj7ELln3EEvv",
            "neg _Z3negILin2EEvv",
            "pk _Z2pkIJi1SiEEvDpT_",
            "pkr _Z3pkrIJicEEvDpRT_",
            "tq _Z2tqI1SEvPKT_S2_RS1_",
            "boxed _Z5boxedIiE3BoxIT_EP3BoxIS1_E",
            "tpl _Z3tplP2TpIiLi3EEPS_I1SLi2EES1_",
            "alf _Z2alIXadL_Z4gfunvEEEvv",
            "alv _Z2alIL_Z4gvarEEvv",
            "opUnary _ZN3OpsngEv",
            "opBinary+ _ZN3OpsplEi",
            "opBinary<< _ZN3OpslsE1S",
            "opOpAssign _ZN3OpsmLEi",
            "opCast _ZNK3OpscviEv",
            "tm _ZN3Ops2tmI1SEEvS1_",
            "contf _Z5contfI4ContiLi4EEvPT_IT0_E",
            "autor _Z5autorIiEiT_",
        ],
    },
    {
        name: "abitag",
        code: 0,
        src: [
            "module abitag;",
            "import core.attribute : gnuAbiTag;",
            "extern(C++):",
            "@gnuAbiTag(\"tag1\") struct S1 {}",
            "@gnuAbiTag(\"tag2\") struct S2 {}",
            "@gnuAbiTag(\"tag2\", \"tag1\") struct S3 {}",
            "S3 func1(S1);",
            "S3 func2(S2);",
            "S3 func3(S2, S1);",
            "S1 func4();",
            "@gnuAbiTag(\"ftag\") void func5();",
            "@gnuAbiTag(\"vtag\") __gshared int var1;",
            "__gshared S3 var2;",
            "S3* func6(S1*);",
            "@gnuAbiTag(\"ctag\") struct T(X) { X x; }",
            "T!int func7(T!int*);",
            "extern(C++, \"nsx\") { @gnuAbiTag(\"ntag\") struct NS {} NS func8(NS); }",
            "extern(D) void probe()",
            "{",
            "pragma(msg, \"func1 \", func1.mangleof);",
            "pragma(msg, \"func2 \", func2.mangleof);",
            "pragma(msg, \"func3 \", func3.mangleof);",
            "pragma(msg, \"func4 \", func4.mangleof);",
            "pragma(msg, \"func5 \", func5.mangleof);",
            "pragma(msg, \"var1 \", var1.mangleof);",
            "pragma(msg, \"var2 \", var2.mangleof);",
            "pragma(msg, \"func6 \", func6.mangleof);",
            "pragma(msg, \"func7 \", func7.mangleof);",
            "pragma(msg, \"func8 \", func8.mangleof);",
            "}",
        ],
        stderr: [
            "func1 _Z5func1B4tag22S1B4tag1",
            "func2 _Z5func2B4tag12S2B4tag2",
            "func3 _Z5func32S2B4tag22S1B4tag1",
            "func4 _Z5func4B4tag1v",
            "func5 _Z5func5B4ftagv",
            "var1 _Z4var1B4vtag",
            "var2 _Z4var2B4tag1B4tag2",
            "func6 _Z5func6B4tag2P2S1B4tag1",
            "func7 _Z5func7P1TB4ctagIiE",
            "func8 _ZN3nsx5func8ENS_2NSB4ntagE",
        ],
    },
    {
        name: "abiub1",
        code: 0,
        src: [
            "module abiub1;",
            "import core.attribute : gnuAbiTag;",
            "@gnuAbiTag(\"x\") extern(C++) void f();",
            "pragma(msg, \"mod \", f.mangleof);",
            "void g() { pragma(msg, \"fn \", f.mangleof); }",
        ],
        stderr: [
            "mod _Z1fv",
            "fn _Z1fB1xv",
        ],
    },
    {
        name: "abiub2",
        code: 0,
        src: [
            "module abiub2;",
            "import core.attribute : gnuAbiTag;",
            "@gnuAbiTag(\"x\", \"y\") extern(C++) void f();",
            "pragma(msg, \"mod \", f.mangleof);",
            "void g() { pragma(msg, \"fn \", f.mangleof); }",
        ],
        stderr: [
            "mod _Z1fv",
            "fn _Z1fB1xB1yv",
        ],
    },
    {
        name: "abiub3",
        code: 0,
        src: [
            "module abiub3;",
            "import core.attribute : gnuAbiTag;",
            "@gnuAbiTag([\"x\", \"y\"]) extern(C++) void f();",
            "pragma(msg, \"mod \", f.mangleof);",
            "void g() { pragma(msg, \"fn \", f.mangleof); }",
        ],
        stderr: [
            "mod _Z1fB1xB1yv",
            "fn _Z1fB1xB1yv",
        ],
    },
    {
        name: "abiub4",
        code: 0,
        src: [
            "module abiub4;",
            "import core.attribute : gnuAbiTag;",
            "@gnuAbiTag([\"x\"]) extern(C++) void f();",
            "pragma(msg, \"mod \", f.mangleof);",
            "void g() { pragma(msg, \"fn \", f.mangleof); }",
        ],
        stderr: [
            "mod _Z1fB1xv",
            "fn _Z1fB1xv",
        ],
    },
    {
        name: "vfield",
        code: 0,
        src: [
            "module vfield;",
            "extern(C++) struct S { int field; }",
            "pragma(msg, S.field.mangleof);",
            "extern(C++, ns) struct N { int nf; }",
            "pragma(msg, N.nf.mangleof);",
        ],
        stderr: [
            "_ZN1S5fieldE",
            "_ZN2ns1N2nfE",
        ],
    },
    {
        name: "e_sarray",
        code: 1,
        src: [
            "module e_sarray;",
            "extern(C++) void f(int[3] a);",
            "pragma(msg, f.mangleof);",
        ],
        stderr: [
            "@F@(2): Error: internal compiler error: unable to pass static array `int[3]` to extern(C++) functio"
            + "n, use pointer instead",
            "extern(C++) void f(int[3] a);",
            "                 ^",
        ],
    },
    {
        name: "e_immutable",
        code: 1,
        src: [
            "module e_immutable;",
            "extern(C++) void f(immutable(int)* a);",
            "pragma(msg, f.mangleof);",
        ],
        stderr: [
            "@F@(2): Error: internal compiler error: `immutable` type `immutable(int)` cannot be mapped to C++",
            "",
            "extern(C++) void f(immutable(int)* a);",
            "                 ^",
        ],
    },
    {
        name: "e_shared",
        code: 1,
        src: [
            "module e_shared;",
            "extern(C++) struct S {}",
            "extern(C++) void f(shared(S)* a);",
            "pragma(msg, f.mangleof);",
        ],
        stderr: [
            "@F@(3): Error: internal compiler error: `shared` type `shared(S)` cannot be mapped to C++",
            "",
            "extern(C++) void f(shared(S)* a);",
            "                 ^",
        ],
    },
    {
        name: "e_sharedclass",
        code: 1,
        src: [
            "module e_sharedclass;",
            "extern(C++) class C {}",
            "extern(C++) void f(shared(C) a);",
            "pragma(msg, f.mangleof);",
        ],
        stderr: [
            "@F@(3): Error: internal compiler error: `shared` type `shared(C)` cannot be mapped to C++",
            "",
            "extern(C++) void f(shared(C) a);",
            "                 ^",
        ],
    },
    {
        name: "e_darray",
        code: 1,
        src: [
            "module e_darray;",
            "extern(C++) void f(int[] x);",
            "pragma(msg, f.mangleof);",
        ],
        stderr: [
            "@F@(2): Error: internal compiler error: type `int[]` cannot be mapped to C++",
            "",
            "extern(C++) void f(int[] x);",
            "                 ^",
        ],
    },
    {
        name: "e_delegate",
        code: 1,
        src: [
            "module e_delegate;",
            "extern(C++) void f(int delegate() dg);",
            "pragma(msg, f.mangleof);",
        ],
        stderr: [
            "@F@(2): Error: internal compiler error: type `extern (C++) int delegate()` cannot be mapped to C++",
            "",
            "extern(C++) void f(int delegate() dg);",
            "                 ^",
        ],
    },
    {
        name: "e_lazy",
        code: 1,
        src: [
            "module e_lazy;",
            "extern(C++) void f(lazy int x);",
            "pragma(msg, f.mangleof);",
        ],
        stderr: [
            "@F@(2): Error: internal compiler error: type `int delegate()` cannot be mapped to C++",
            "",
            "extern(C++) void f(lazy int x);",
            "                 ^",
        ],
    },
    {
        name: "e_valparam",
        code: 1,
        src: [
            "module e_valparam;",
            "extern(C++) void f(double D)() {}",
            "pragma(msg, f!(1.5).mangleof);",
        ],
        stderr: [
            "@F@(3): Error: template instance `e_valparam.f!1.5` internal compiler error: C++ `double` template "
            + "value parameter is not supported",
            "pragma(msg, f!(1.5).mangleof);",
            "            ^",
        ],
    },
    {
        name: "e_strop",
        code: 1,
        src: [
            "module e_strop;",
            "extern(C++) struct Ops { int opUnary(string op)() if (op == \"!\"); }",
            "pragma(msg, Ops.opUnary!\"!\".mangleof);",
        ],
        stderr: [
            "@F@(3): Error: template instance `e_strop.Ops.opUnary!\"!\"` internal compiler error: C++ `string` "
            + "template value parameter is not supported",
            "pragma(msg, Ops.opUnary!\"!\".mangleof);",
            "               ^",
        ],
    },
    {
        name: "e_alias",
        code: 1,
        src: [
            "module e_alias;",
            "extern(C++) void al(alias A)() {}",
            "pragma(msg, al!(int).mangleof);",
        ],
        stderr: [
            "@F@(3): Error: template instance `e_alias.al!int` internal compiler error: C++ `int` template alias"
            + " parameter is not supported",
            "pragma(msg, al!(int).mangleof);",
            "            ^",
        ],
    },
    {
        name: "e_tuplev",
        code: 1,
        src: [
            "module e_tuplev;",
            "extern(C++) void pk(T...)() {}",
            "pragma(msg, pk!(int, 3).mangleof);",
        ],
        stderr: [
            "@F@(3): Error: template instance `e_tuplev.pk!(int, 3)` internal compiler error: C++ `3` template v"
            + "alue parameter is not supported",
            "pragma(msg, pk!(int, 3).mangleof);",
            "            ^",
        ],
    },
    {
        name: "e_tlsalias",
        code: 1,
        src: [
            "module e_tlsalias;",
            "int tls;",
            "extern(C++) void al(alias A)() {}",
            "pragma(msg, al!tls.mangleof);",
        ],
        stderr: [
            "@F@(2): Error: variable `e_tlsalias.tls` internal compiler error: C++ static non-`__gshared` non-`extern`"
            + " variables not supported",
            "int tls;",
            "    ^",
        ],
    },
];

describe("C++ mangling on the driver path (ldc2 -c -o-)", () => {
    const dir = mkdtempSync(join(tmpdir(), "djs-cppmangle-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    async function shim(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        vi.resetModules();
        const { djsMain } = await import("../../djs.js");
        const out: string[] = [];
        const err: string[] = [];
        const tap = (into: string[]) => (c: string | Uint8Array): boolean => {
            into.push(typeof c === "string" ? c : new TextDecoder().decode(c));
            return true;
        };
        const o = vi.spyOn(process.stdout, "write").mockImplementation(tap(out));
        const e = vi.spyOn(process.stderr, "write").mockImplementation(tap(err));
        try {
            return { code: djsMain(args), stdout: out.join(""), stderr: err.join("") };
        } finally {
            o.mockRestore();
            e.mockRestore();
        }
    }

    for (const c of CASES) {
        test(c.name, async () => {
            const f = join(dir, c.name + ".d");
            writeFileSync(f, c.src.map((l) => l + "\n").join(""));
            const expected = c.stderr.map((l) => l.replaceAll("@F@", f) + "\n").join("");
            expect(await shim(["-c", "-o-", f])).toEqual({ code: c.code, stdout: "", stderr: expected });
        }, 60_000);
    }
});
