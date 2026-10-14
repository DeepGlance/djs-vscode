// Co-located tests for src/dmd/target.ts (ported from dmd/target.d as LDC 1.43.0 builds it).
//
// dmd/target.d carries no in-source `unittest{}` block, so this file is the test file of
// 10-tests-diagnostics.md §1.6b: one module-load smoke test plus one BEHAVIOUR pin per risky
// resolved construct, one `it()` per concern so a red gate names the right pin. Expected values are
// ldc2's, probed on the fixed target, never the port's own expression re-evaluated (10 §1.8 rule 8) —
// EXCEPT the pins marked "C++-sourced": values no probe can observe, pinned to the literal LDC assigns
// in gen/target.cpp (c.boolsize/shortsize/intsize/long_longsize, crtDestructorsSupported,
// classinfosize, cpp.reverseOverloads/splitVBasetable/wrapDtorInExternD, preferPassByRef(long/real)).
//
// THE ORACLE. `<ldc2-1.43.0>/bin/ldc2 -c -o- probe.d` on
// arm64-apple-darwin (Apple M2), the target `_ground-truth.md` §6 fixes. The probe text and its
// observed output are quoted on each pin. They matter because most of this file's answers come from
// LDC's C++ (gen/target.cpp, gen/abi/aarch64.cpp) with the triple const-folded, not from the D source:
// the probe is the only independent witness that the fold is right.
//
// The pinned CONCERNS:
//   1. module load + the module-global `target` singleton, and the `Target::_init` fold for the
//      triple (pointer/real layout, extensions, maxStaticDataSize, architecture name).
//   2. `TargetC` / `TargetCPP` / `TargetObjC` values filled by `_init`.
//   3. the three `FPTypeProperties` instantiations (float/double/real), bit-exact.
//   4. `alignsize` against ldc2's `.alignof` for every basic type; `fieldalign` = LDC's
//      `DtoAlignment`, including the case where it differs from the `!IN_LLVM` D body.
//   5. `isVectorTypeSupported`'s IN_LLVM element-type table.
//   6. `isVectorOpSupported` (the wave-3 pins: non-vector short circuit, IN_LLVM arms, element-type
//      gate, `!`/`^^`, `is`, `t2` unread).
//   7. `systemLinkage`, `supportsLinkerDirective`, `libraryObjectMonitors`, `va_listType`.
//   8. `getTargetInfo` for every key LDC answers, and `null` for an unknown key.
//   9. the `TargetCPP` mangling hooks and `derivedClassOffset`; `contributesToAggregateAlignment`.
//  10. `toArgTypes` (-> argtypes_aarch64.ts, whose own file pins the classification), the live and
//      aggregate legs of `isReturnOnStack` / `preferPassByRef` through `getArgTypes`, and the
//      routing of `toMangle`/`typeInfoMangle` to mangle/cpp.ts.
//  11. the `-mtriple` targets (10 §4.8): `parseTargetTriple`, `_init` per triple, and one probe module run through
//      `djsMain` per triple against ldmd2's output with the same `-mtriple` (predefined versions, sizes, `real`'s
//      properties with the host's CTFE `real_t`, va_list, objectFormat, CPU, C++ mangling, bit-field and C ABI
//      answers), plus the `-m64` conflict and a refused triple.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// FIRST on purpose — the load-order SMOKE test rule 4.8 (01-conventions.md) asks for, and it only
// tests anything if `target.js` is the module that ENTERS the graph. target.ts has value edges into
// mtype, expression, typesem, hdrgen, declaration and argtypes_aarch64 (which reaches dsymbolsem and
// expressionsem); if one were placed so that target became the entry of the core SCC, this file would
// die at collect with `TypeError: Class extends value undefined`.
import {
    OS, Target, target, CPU, TargetObjectFormat, TargetCBitFieldStyle, TargetCRuntime, TargetCPPRuntime,
    TargetFPTypeProperties_float, defaultTargetOS, defaultTargetOSMajor, RealKind, hostTriple, hostTripleOf,
    parseTargetTriple,
} from "./target.js";
import { EXP } from "./tokens.js";
import { LINK, TY } from "./astenums.js";
import { Loc } from "./location.js";
import { global } from "./globals.js";
import { Identifier } from "./identifier.js";
import { IntegerExp } from "./expression.js";
import { BitFieldDeclaration } from "./declaration.js";
import { ClassDeclaration } from "./dclass.js";
import { Type, TypeSArray, TypeVector, TypeFunction, ParameterList, TypeStruct } from "./mtype.js";
import { StructDeclaration } from "./dstruct.js";
import { ds, dsToJs, cstr } from "../dstring.js";
import { AssertError } from "../assert.js";
import { Parser } from "./parse.js";
import { ErrorSinkNull } from "./errorsink.js";
import { moduleFromParse } from "./dmodule.js";
import type { Module } from "./dmodule.js";
import { runSemantic } from "./dsymbolsem.js";
import { initSemaHarness } from "../sema-harness.js";

const loc = Loc.initial;

/** `__vector(T[n])`, built the way the parser does: a `TypeVector` over a `T[n]` static array. */
function vec(elem: Type, n: bigint): TypeVector {
    return new TypeVector(new TypeSArray(elem, new IntegerExp(loc, n, Type.tint32)));
}

/** A plain `TypeFunction` returning `tret`, `extern(D)`, no parameters. */
function fnType(tret: Type): TypeFunction {
    return new TypeFunction(new ParameterList(null), tret, LINK.d);
}

/** `elem[n]`, built without semantic the way `sarrayOf` does. */
function sarray(elem: Type, n: bigint): TypeSArray {
    return new TypeSArray(elem, new IntegerExp(loc, n, Type.tint32));
}

/** lex + parse + `runSemantic` `src`; the test fails if semantic reports an error. */
function semaModule(src: string): Module {
    const buf = new Uint8Array(src.length + 1);
    for (let i = 0; i < src.length; i++) buf[i] = src.charCodeAt(i) & 0xff;
    const p = new Parser(null, null, buf, false, new ErrorSinkNull(), null, false);
    p.nextToken();
    const m = moduleFromParse(p.parseModule(), p.md);
    runSemantic(m);
    expect(global.errors).toBe(0);
    return m;
}

describe("target.ts", () => {
    beforeEach(() => {
        initSemaHarness();
        target._resetVaListCache();
    });

    // CONCERN 1, and the load-order smoke assertion rule 4.8 names: `./target.js` is imported FIRST
    // in this file, so the class checks fail (at collect, as a TypeError) if entering the module
    // graph through target.ts leaves a class it transitively depends on undefined.
    it("exports a single module-global `target`, initialised for the host arm64-apple-darwin", () => {
        expect(typeof Type).toBe("function");
        expect(typeof TypeVector).toBe("function");
        expect(typeof IntegerExp).toBe("function");
        expect(target).toBeInstanceOf(Target);
        expect(target.isX86).toBe(false);
        expect(target.os).toBe(OS.OSX);
        expect(target.os & OS.Posix).toBeTruthy();
        expect(defaultTargetOS()).toBe(OS.OSX);
        expect(defaultTargetOSMajor()).toBe(0);
        // The nested enums keep D's member order (their numeric values are the ordinal).
        expect(CPU.native).toBe(12);
        expect(TargetObjectFormat.macho).toBe(1);
        expect(TargetCRuntime.WASI).toBe(7);
        expect(TargetCPPRuntime.Sun).toBe(4);
    });

    // CONCERN 1. gen/target.cpp:156-205 folded for the triple. ldc2 probes:
    //   pragma(msg, size_t.sizeof)                -> 8LU
    //   pragma(msg, real.sizeof, real.alignof)    -> 8LU 8LU
    //   int[0x4000_0000_0000_0001] big;           -> Error: `int[cast(size_t)4611686018427387905]` size
    //       4 * 4611686018427387905 exceeds 0xffffffffffffffff size limit for static array
    //   ldc2 -c -X (json)                         -> "architectures" : ["arm64"]
    it("the Target::_init fold: pointer/real layout, maxStaticDataSize, extensions, architecture", () => {
        // `_init` (target.d:456) re-run by a driver (main.d:440 `target._init(params);`) is idempotent.
        const rerun = new Target();
        rerun._init(global.params);
        for (const t of [target, new Target(), rerun]) {
            expect(t.ptrsize).toBe(8);
            expect(t.isLP64).toBe(true);
            expect(t.realsize).toBe(8);
            expect(t.realpad).toBe(0);
            expect(t.realalignsize).toBe(8);
            expect(t.classinfosize).toBe(0); // C++-sourced: gen/target.cpp:163 `classinfosize = 0; // unused`
            expect(t.maxStaticDataSize).toBe(0xFFFF_FFFF_FFFF_FFFFn);
            expect(dsToJs(t.architectureName)).toBe("arm64");
            expect(dsToJs(t.obj_ext)).toBe("o");
            expect(dsToJs(t.lib_ext)).toBe("a");
            expect(dsToJs(t.dll_ext)).toBe("dylib");
            expect(t.run_noext).toBe(true);
        }
    });

    // CONCERN 2. gen/target.cpp:166-183. ldc2 probes (core.stdc.config / stddef):
    //   c_long.sizeof 8, c_ulong.sizeof 8, c_long_double.sizeof 8 (alignof 8, mant_dig 53),
    //   wchar_t.sizeof 4 (`wchar_t` is `dchar`), cpp_long.sizeof 8.
    //   `extern(C++) class CppExc {} void f() { try {} catch (CppExc e) {} }` compiles (C++ catch).
    //   `extern(C++) class C { ~this(); void foo(); }`: getVirtualIndex(foo) == 2, against 0 without
    //   the dtor — the destructor takes TWO vtable slots (twoDtorInVtable).
    //   `extern(Objective-C) extern class NSObject {...}` compiles (objc supported).
    //   `-preview=bitfields`: `struct { char a; int : 4; }` alignof 1, `struct { char a; int b : 4; }`
    //   alignof 4 (Gcc_Clang style; the Apple anonymous-bitfield rule is concern 9).
    it("fills TargetC / TargetCPP / TargetObjC as LDC does for the triple", () => {
        const c = target.c;
        // C++-sourced (gen/target.cpp:166-171): crtDestructorsSupported, boolsize, shortsize, intsize,
        // long_longsize.
        expect(c.crtDestructorsSupported).toBe(true);
        expect(c.boolsize).toBe(1);
        expect(c.shortsize).toBe(2);
        expect(c.intsize).toBe(4);
        expect(c.longsize).toBe(8);
        expect(c.long_longsize).toBe(8);
        expect(c.long_doublesize).toBe(8);
        expect(c.wchar_tsize).toBe(4);
        expect(c.bitFieldStyle).toBe(TargetCBitFieldStyle.Gcc_Clang);

        const cpp = target.cpp;
        expect(cpp.exceptions).toBe(true);
        expect(cpp.twoDtorInVtable).toBe(true);
        // C++-sourced (gen/target.cpp:177/180/181): reverseOverloads, splitVBasetable, wrapDtorInExternD.
        expect(cpp.reverseOverloads).toBe(false);
        expect(cpp.splitVBasetable).toBe(false);
        expect(cpp.wrapDtorInExternD).toBe(false);

        expect(target.objc.supported).toBe(true);
    });

    // CONCERN 3. ldc2 probe, all `static assert`s PASS:
    //   float.max == 0x1.fffffep+127, float.min_normal == 0x1p-126, float.epsilon == 0x1p-23
    //   double.max == real.max == 0x1.fffffffffffffp+1023, min_normal == 0x1p-1022, epsilon == 0x1p-52
    //   real.nan != real.nan, real.infinity == double.infinity
    // and pragma(msg):
    //   float  mant_dig=24 dig=6  max_exp=128  min_exp=-125  max_10=38  min_10=-37
    //   double mant_dig=53 dig=15 max_exp=1024 min_exp=-1021 max_10=308 min_10=-307
    //   real   mant_dig=53 dig=15 max_exp=1024 min_exp=-1021 max_10_exp=308 min_10_exp=-307
    // The expected values are the hex-float constants spelled as exact powers of two.
    it("FloatProperties / DoubleProperties / RealProperties are bit-exact", () => {
        const f = target.FloatProperties;
        expect(f.max).toBe((2 - 2 ** -23) * 2 ** 127);
        expect(f.min_normal).toBe(2 ** -126);
        expect(f.epsilon).toBe(2 ** -23);
        expect(Number.isNaN(f.nan)).toBe(true);
        expect(f.infinity).toBe(Infinity);
        expect([f.dig, f.mant_dig, f.max_exp, f.min_exp, f.max_10_exp, f.min_10_exp])
            .toEqual([6n, 24n, 128n, -125n, 38n, -37n]);

        for (const d of [target.DoubleProperties, target.RealProperties]) {
            expect(d.max).toBe((2 - 2 ** -52) * 2 ** 1023);
            expect(d.min_normal).toBe(2 ** -1022);
            expect(d.epsilon).toBe(2 ** -52);
            expect(Number.isNaN(d.nan)).toBe(true);
            expect(d.infinity).toBe(Infinity);
            expect([d.dig, d.mant_dig, d.max_exp, d.min_exp, d.max_10_exp, d.min_10_exp])
                .toEqual([15n, 53n, 1024n, -1021n, 308n, -307n]);
        }

        // D's `.init` before `initialize()`: real_t fields NaN, long fields 0.
        const fresh = new TargetFPTypeProperties_float();
        expect(Number.isNaN(fresh.max)).toBe(true);
        expect(fresh.dig).toBe(0n);
    });

    // CONCERN 4. ldc2 probe, `pragma(msg, T.alignof)` for every basic type:
    //   void 1, bool 1, byte 1, ubyte 1, short 2, ushort 2, int 4, uint 4, long 8, ulong 8, char 1,
    //   wchar 2, dchar 4, float 4, double 8, real 8, ifloat 4, idouble 8, ireal 8, cfloat 4,
    //   cdouble 8, creal 8.
    it("alignsize matches ldc2's .alignof for every basic type", () => {
        const table: [Type, number][] = [
            [Type.tvoid, 1], [Type.tbool, 1], [Type.tint8, 1], [Type.tuns8, 1], [Type.tint16, 2],
            [Type.tuns16, 2], [Type.tint32, 4], [Type.tuns32, 4], [Type.tint64, 8], [Type.tuns64, 8],
            [Type.tchar, 1], [Type.twchar, 2], [Type.tdchar, 4], [Type.tfloat32, 4],
            [Type.tfloat64, 8], [Type.tfloat80, 8], [Type.timaginary32, 4], [Type.timaginary64, 8],
            [Type.timaginary80, 8], [Type.tcomplex32, 4], [Type.tcomplex64, 8], [Type.tcomplex80, 8],
        ];
        for (const [t, a] of table)
            expect(target.alignsize(t), `${TY[t.ty]}`).toBe(a);
    });

    // CONCERN 4. fieldalign is LDC's DtoAlignment (gen/llvmhelpers.cpp:142), not the `!IN_LLVM` D body
    // that clamps anything but 16/32 to 8. ldc2 probe:
    //   struct W { char c; __vector(float[16]) v; }  -> v.offsetof 64, W.alignof 64 (D body: 8)
    //   struct W8 { char c; __vector(float[4]) v; }  -> v.offsetof 16
    //   align(2) struct P { int x; }    struct W2 { char c; P p; }  -> P.alignof 2,   W2.p.offsetof 2
    //   align(128) struct R2 { int x; } struct W6 { char c; R2 r; } -> R2.alignof 128, W6.r.offsetof 128
    // Built directly, not through sema: an `align(N)` attribute needs `ctfeInterpret` (dsymbolsem.d:1357),
    // which is walled until dinterpret lands, and a `__vector` declaration needs the typesem wall on
    // `isVectorTypeSupported`. The explicit alignments are set on the StructDeclaration the way
    // `align(N) struct` semantic sets them.
    it("fieldalign follows DtoAlignment: explicit alignment wins, no clamp to 8", () => {
        expect(target.fieldalign(vec(Type.tfloat32, 16n))).toBe(64);
        expect(target.fieldalign(vec(Type.tfloat32, 4n))).toBe(16);

        for (const n of [2, 128]) {
            const sd = new StructDeclaration(loc, Identifier.idPool(ds(`P${n}`)), false);
            sd.alignment.set(n);
            expect(target.fieldalign(new TypeStruct(sd)), `align(${n})`).toBe(n);
        }

        // Basic types fall through to alignsize.
        expect(target.fieldalign(Type.tint32)).toBe(4);
        expect(target.fieldalign(Type.tint64)).toBe(8);
        expect(target.fieldalign(Type.tfloat80)).toBe(8);
    });

    // CONCERN 5. ldc2 probe `alias V = __vector(T); pragma(msg, V.sizeof);`:
    //   ACCEPTED: int[3] (12), int[64] (256), void[16], ubyte[2], double[1], ulong[2], ushort[8]
    //   REJECTED "vector type `__vector(...)` is not supported on this platform": real[2], bool[16],
    //   char[16], wchar[8], dchar[4], cfloat[2]
    // No size check under IN_LLVM (12 and 256 bytes pass); only the element type is tested.
    it("isVectorTypeSupported accepts the IN_LLVM element types at any size", () => {
        const accepted: [number, Type][] = [
            [12, Type.tint32], [256, Type.tint32], [16, Type.tvoid], [2, Type.tuns8], [8, Type.tfloat64],
            [16, Type.tuns64], [16, Type.tuns16], [16, Type.tint8], [16, Type.tint16], [16, Type.tfloat32],
            [16, Type.tint64],
        ];
        for (const [sz, t] of accepted)
            expect(target.isVectorTypeSupported(sz, t), `${TY[t.ty]}`).toBe(0);
        for (const t of [Type.tfloat80, Type.tbool, Type.tchar, Type.twchar, Type.tdchar, Type.tcomplex32])
            expect(target.isVectorTypeSupported(16, t), `${TY[t.ty]}`).toBe(2);
    });

    // CONCERN 6. dmd/target.d:820 — `auto tvec = type.isTypeVector();` then `if (tvec is null) return
    // true;` (target.d:821-822). This is the statement every scalar call site in expressionsem.ts lands on, so it is
    // pinned across the whole op range, including the two ops that are false for any vector.
    it("isVectorOpSupported returns true for a NON-vector type, whatever the op", () => {
        const ops = [EXP.uadd, EXP.negate, EXP.add, EXP.min, EXP.mul, EXP.div, EXP.mod, EXP.pow,
                     EXP.and, EXP.or, EXP.xor, EXP.tilde, EXP.not, EXP.leftShift, EXP.rightShift,
                     EXP.unsignedRightShift, EXP.lessThan, EXP.equal, EXP.identity];
        for (const op of ops) {
            expect(target.isVectorOpSupported(Type.tint32, op)).toBe(true);
            expect(target.isVectorOpSupported(Type.tfloat64, op, Type.tint32)).toBe(true);
        }
    });

    // CONCERN 6, the crux of the IN_LLVM resolution. ldc2 probe on arm64-apple-darwin, all
    // ACCEPTED (`-c -o-`, exit 0, no diagnostic):
    //     void f() { __vector(int[4]) a, b;    auto c = a / b; auto d = a % b; }
    //     void f() { __vector(float[4]) a, b;  auto c = a / b; auto d = a % b; }
    //     void f() { __vector(byte[16]) a, b;  auto c = a * b; auto d = a / b; auto e = a % b; }
    //     void f() { __vector(float[8]) a, b;  auto c = a + b; }              // 32 bytes
    //     void f() { __vector(long[4]) a, b;   auto c = a * b; auto d = a & b; auto e = a << 1; }
    // dmd's `!IN_LLVM` body would answer `false` to every one of these without SSE4.1/AVX2, and has
    // no integer-divide entry at all — which is exactly why this is pinned rather than assumed.
    it("accepts the vector ops LDC lowers but the x86 ladder would reject", () => {
        const int4 = vec(Type.tint32, 4n);
        expect(target.isVectorOpSupported(int4, EXP.div)).toBe(true);
        expect(target.isVectorOpSupported(int4, EXP.mod)).toBe(true);
        expect(target.isVectorOpSupported(int4, EXP.mul)).toBe(true);

        const byte16 = vec(Type.tint8, 16n);
        expect(target.isVectorOpSupported(byte16, EXP.mul)).toBe(true);
        expect(target.isVectorOpSupported(byte16, EXP.div)).toBe(true);

        const float8 = vec(Type.tfloat32, 8n);   // 32 bytes
        expect(target.isVectorOpSupported(float8, EXP.add)).toBe(true);
        const long4 = vec(Type.tint64, 4n);      // 32 bytes
        expect(target.isVectorOpSupported(long4, EXP.mul)).toBe(true);
        expect(target.isVectorOpSupported(long4, EXP.and)).toBe(true);
        expect(target.isVectorOpSupported(long4, EXP.leftShift)).toBe(true);
    });

    // CONCERN 6. ldc2 probe, REJECTED with these exact diagnostics (the error text comes from the
    // expressionsem call site, which is what a `false` here produces):
    //     __vector(float[4]) a, b; auto c = a & b;
    //         Error: incompatible types for `(a) & (b)`: both operands are of type `__vector(float[4])`
    //     __vector(float[4]) a;    auto c = ~a;
    //         Error: incompatible type for `~(a)`: `__vector(float[4])`
    //     __vector(float[4]) a, b; auto c = a << b;
    //         Error: `a` is not of integral type, it is a `__vector(float[4])`
    // ACCEPTED on the integral counterpart:
    //     __vector(int[4]) a, b; auto c = a & b; auto d = a | b; auto e = a ^ b; auto f = ~a;
    //                            auto g = a << 2; auto h = a >> 2; auto i = a >>> 2;
    it("gates vector bitwise / shift / ~ on an INTEGRAL element type", () => {
        const int4 = vec(Type.tint32, 4n);
        const float4 = vec(Type.tfloat32, 4n);
        const bitwise = [EXP.and, EXP.andAssign, EXP.or, EXP.orAssign, EXP.xor, EXP.xorAssign,
                         EXP.tilde, EXP.leftShift, EXP.leftShiftAssign, EXP.rightShift,
                         EXP.rightShiftAssign, EXP.unsignedRightShift, EXP.unsignedRightShiftAssign];
        for (const op of bitwise) {
            expect(target.isVectorOpSupported(int4, op)).toBe(true);
            expect(target.isVectorOpSupported(float4, op)).toBe(false);
        }
        // Arithmetic and comparison, by contrast, ask only for a SCALAR element — both pass.
        for (const op of [EXP.add, EXP.min, EXP.mul, EXP.div, EXP.mod, EXP.negate, EXP.uadd,
                          EXP.lessThan, EXP.greaterOrEqual, EXP.equal, EXP.notEqual]) {
            expect(target.isVectorOpSupported(int4, op)).toBe(true);
            expect(target.isVectorOpSupported(float4, op)).toBe(true);
        }
    });

    // CONCERN 6. target.d:1033 (`case EXP.not:`) and :1056 (`case EXP.pow, EXP.powAssign:`) return
    // `false` unconditionally — the ONLY two ops for which a well-formed vector is rejected on this
    // target. ldc2 probe, REJECTED:
    //     __vector(float[4]) a, b; auto c = a ^^ b;
    //         Error: incompatible types for `(a) ^^ (b)`: both operands are of type `__vector(float[4])`
    //     __vector(float[4]) a;    auto c = !a;
    //         Error: expression `a` of type `__vector(float[4])` does not have a boolean value
    //     (the `!` diagnostic comes from `toBoolean` BEFORE the predicate — expressionsem.d:10653 —
    //      so it pins the predicate's answer, not the message.)
    it("rejects `!` and `^^` on every vector, integral or floating", () => {
        for (const t of [vec(Type.tint32, 4n), vec(Type.tfloat32, 4n), vec(Type.tint64, 4n)]) {
            expect(target.isVectorOpSupported(t, EXP.not)).toBe(false);
            expect(target.isVectorOpSupported(t, EXP.pow)).toBe(false);
            expect(target.isVectorOpSupported(t, EXP.powAssign)).toBe(false);
        }
    });

    // CONCERN 6. target.d:868 `return IN_LLVM;` — no element-type test at all. ldc2 probe,
    // ACCEPTED: `void f() { __vector(float[4]) a, b; bool c = a is b; }`.
    it("supports `is` / `!is` on any vector", () => {
        for (const t of [vec(Type.tint32, 4n), vec(Type.tfloat32, 4n)]) {
            expect(target.isVectorOpSupported(t, EXP.identity)).toBe(true);
            expect(target.isVectorOpSupported(t, EXP.notIdentity)).toBe(true);
        }
    });

    // CONCERN 6. `t2` is in D's signature (target.d:816) and read nowhere in the body. Pinned
    // because the natural mistake — folding the second operand into the answer — compiles silently.
    it("isVectorOpSupported ignores `t2` entirely", () => {
        const float4 = vec(Type.tfloat32, 4n);
        for (const t2 of [null, Type.tint32, float4, vec(Type.tint32, 4n)]) {
            expect(target.isVectorOpSupported(float4, EXP.and, t2)).toBe(false);
            expect(target.isVectorOpSupported(float4, EXP.add, t2)).toBe(true);
        }
    });

    // CONCERN 7. ldc2 probes:
    //   extern(System) void sysf(); pragma(msg, typeof(&sysf))  -> extern (C) void function()
    //   pragma(linkerDirective, "-framework", "Foundation");    -> accepted (Mach-O)
    //   pragma(msg, va_list) (core.stdc.stdarg)                  -> char*
    // `libraryObjectMonitors` is `{ return true; }` in D itself (target.d:1085).
    it("systemLinkage, supportsLinkerDirective, libraryObjectMonitors, va_listType", () => {
        expect(target.systemLinkage()).toBe(LINK.c);
        expect(target.supportsLinkerDirective()).toBe(true);
        expect(target.libraryObjectMonitors(null!, null!)).toBe(true); // parameters unread (target.d:1085)

        const tv = target.va_listType(loc, null);
        expect(tv.ty).toBe(TY.Tpointer);
        expect(tv.isTypePointer()!.next).toBe(Type.tchar);
        // Cached like D's `tvalist`: the second call returns the same object.
        expect(target.va_listType(loc, null)).toBe(tv);
    });

    // CONCERN 8. ldc2 probe `pragma(msg, __traits(getTargetInfo, key))`:
    //   objectFormat -> macho; floatAbi -> hard; cppRuntimeLibrary -> (empty string);
    //   cppStd -> 201103 (typeof: int); CET -> 0 (typeof: int);
    //   dcomputeTargets -> AliasSeq!(); dcomputeFilePrefix -> kernels;
    //   bogus -> Error: `getTargetInfo` key `"bogus"` not supported by this implementation (the
    //   caller's diagnostic for a null return).
    it("getTargetInfo answers every LDC key for the triple, null otherwise", () => {
        const str = (key: string): string => {
            const se = target.getTargetInfo(ds(key), loc)!.isStringExp();
            expect(se).not.toBeNull();
            return String.fromCharCode(...se!.string!);
        };
        expect(str("objectFormat")).toBe("macho");
        expect(str("floatAbi")).toBe("hard");
        expect(str("cppRuntimeLibrary")).toBe("");
        expect(str("dcomputeFilePrefix")).toBe("kernels");

        const ints: [string, bigint][] = [["cppStd", 201103n], ["CET", 0n]];
        for (const [key, v] of ints) {
            const ie = target.getTargetInfo(ds(key), loc)!.isIntegerExp();
            expect(ie).not.toBeNull();
            expect(ie!.getInteger()).toBe(v);
            expect(ie!.type).toBe(Type.tint32);
        }

        const te = target.getTargetInfo(ds("dcomputeTargets"), loc)!.isTupleExp();
        expect(te).not.toBeNull();
        expect(te!.exps!.length).toBe(0);

        expect(target.getTargetInfo(ds("bogus"), loc)).toBeNull();
        // A NUL-terminated C string names the same key (`llvm::StringRef name(name_)`).
        expect(target.getTargetInfo(ds("floatAbi\0"), loc)).not.toBeNull();
    });

    // CONCERN 9. ldc2 probes:
    //   extern(C++) void cf2(real x); pragma(msg, cf2.mangleof)       -> _Z3cf2e
    //   extern(C++) class B { int x; char c; void v() {} }  extern(C++) class D : B { char d; }
    //       -> classInstanceSize(B) 13, D.d.offsetof 13 (no MSVC padding)
    //   -preview=bitfields: struct { char a; int : 4; } alignof 1; struct { char a; int b : 4; }
    //       alignof 4 — on Apple arm64 an anonymous bitfield does not contribute to alignment.
    it("TargetCPP hooks, derivedClassOffset and contributesToAggregateAlignment", () => {
        const cpp = target.cpp;
        expect(dsToJs(cpp.typeMangle(Type.tfloat80)!)).toBe("e");
        expect(cpp.typeMangle(Type.tfloat64)).toBeNull();
        expect(cpp.typeMangle(Type.tint32)).toBeNull();
        expect(cpp.parameterType(Type.tint32)).toBeNull();
        const isFundamental = { value: false };
        expect(cpp.fundamentalType(Type.tint32, isFundamental)).toBe(false);
        expect(isFundamental.value).toBe(false);

        const base = new ClassDeclaration(loc, Identifier.idPool(ds("B")), null, null, false);
        base.structsize = 13;
        base.alignsize = 8;
        expect(cpp.derivedClassOffset(base)).toBe(13);

        const width = new IntegerExp(loc, 4n, Type.tint32);
        const named = new BitFieldDeclaration(loc, Type.tint32, Identifier.idPool(ds("b")), width);
        const anon = new BitFieldDeclaration(loc, Type.tint32, Identifier.generateAnonymousId(ds("")), width);
        expect(target.c.contributesToAggregateAlignment(named)).toBe(true);
        expect(target.c.contributesToAggregateAlignment(anon)).toBe(false);
    });

    // CONCERN 10. ldc2 probes, arm64-apple-darwin:
    //   `static if (is(T A == __argTypes)) A.stringof`: `int` (int), `int[0]` no match (null).
    //   `T f(); __traits(isReturnOnStack, f)`: `int` false, `real` false, `ref int[5]` false,
    //   `int[4]` false, `float[4]` false, `byte[16]` false, `int[5]` true, `byte[17]` true, `int[0]` true.
    //   `-preview=in`, `void f(in T x) { pragma(msg, __traits(isRef, x)); }`: `long` false, `int[5]`
    //   true, `int[0]` false.
    it("toArgTypes, and the static-array and scalar legs of isReturnOnStack / preferPassByRef", () => {
        const tt = target.toArgTypes(Type.tint32)!;
        expect(tt.arguments!.length).toBe(1);
        expect(tt.arguments!.opIndex(0)!.type).toBe(Type.tint32);
        expect(target.toArgTypes(sarray(Type.tint32, 0n))).toBeNull();

        expect(target.isReturnOnStack(fnType(Type.tint32), false)).toBe(false);
        expect(target.isReturnOnStack(fnType(Type.tfloat80), true)).toBe(false);
        const refFn = fnType(sarray(Type.tint32, 5n));
        refFn.isRef = true;
        expect(target.isReturnOnStack(refFn, false)).toBe(false);
        expect(target.isReturnOnStack(fnType(sarray(Type.tint32, 4n)), false)).toBe(false);
        expect(target.isReturnOnStack(fnType(sarray(Type.tfloat32, 4n)), false)).toBe(false);
        expect(target.isReturnOnStack(fnType(sarray(Type.tint8, 16n)), false)).toBe(false);
        expect(target.isReturnOnStack(fnType(sarray(Type.tint32, 5n)), false)).toBe(true);
        expect(target.isReturnOnStack(fnType(sarray(Type.tint8, 17n)), false)).toBe(true);
        expect(target.isReturnOnStack(fnType(sarray(Type.tint32, 0n)), false)).toBe(true);

        // C++-sourced: gen/abi/aarch64.cpp:81-82, the non-aggregate early-out; ldc2 agrees for `long`.
        expect(target.preferPassByRef(Type.tint64)).toBe(false);
        expect(target.preferPassByRef(Type.tfloat80)).toBe(false);
        expect(target.preferPassByRef(sarray(Type.tint32, 5n))).toBe(true);
        expect(target.preferPassByRef(sarray(Type.tint32, 0n))).toBe(false);
    });

    // CONCERN 10, struct legs: `getArgTypes` (gen/abi/abi.cpp:78) answers a sized struct from
    // `sd.argTypes`, which dsymbolsem.d:10290 stores at the end of the struct's size finalization.
    //   `__traits(isReturnOnStack, f)`: `struct{int}` false, `struct{float x4}` false, `struct{}` false,
    //   `struct{long x3}` true, `struct{long[5]}` true, `struct{int; this(this){}}` true.
    //   `-preview=in` `__traits(isRef, x)`: `struct{long x2}` false, `struct{double x4}` false,
    //   `struct{}` false, `struct{long x3}` true.
    it("isReturnOnStack / preferPassByRef read a sized struct's argTypes", () => {
        const m = semaModule(`
            struct I1 { int a; }
            struct F4 { float a, b, c, d; }
            struct E {}
            struct L2 { long a, b; }
            struct L3 { long a, b, c; }
            struct D4 { double a, b, c, d; }
            struct L5 { long[5] a; }
            struct NP { int a; this(this) {} }
        `);
        const st = (name: string): TypeStruct => {
            const sd = m.symtab!.lookup(Identifier.idPool(ds(name)))!.isStructDeclaration()!;
            return sd.type!.isTypeStruct()!;
        };
        expect(target.isReturnOnStack(fnType(st("I1")), false)).toBe(false);
        expect(target.isReturnOnStack(fnType(st("F4")), false)).toBe(false);
        expect(target.isReturnOnStack(fnType(st("E")), false)).toBe(false);
        expect(target.isReturnOnStack(fnType(st("L3")), false)).toBe(true);
        expect(target.isReturnOnStack(fnType(st("L5")), false)).toBe(true);
        expect(target.isReturnOnStack(fnType(st("NP")), false)).toBe(true);

        expect(target.preferPassByRef(st("L2"))).toBe(false);
        expect(target.preferPassByRef(st("D4"))).toBe(false);
        expect(target.preferPassByRef(st("E"))).toBe(false);
        expect(target.preferPassByRef(st("L3"))).toBe(true);
    });

    it("routes the C++ manglers to mangle/cpp.ts (isTargetWindowsMSVC() is false)", () => {
        const cd = new ClassDeclaration(loc, Identifier.idPool(ds("C")), null, null, false);
        // target.d:1737 -> toCppMangleItanium: its `mangleOf` (mangle/cpp.d:214) is `assert(0)` for a symbol that is
        // neither a variable nor a function; mangle/cpp.test.ts pins the manglings through the driver.
        expect(() => target.cpp.toMangle(cd)).toThrow(AssertError);
        // target.d:1767 -> cppTypeInfoMangleItanium: ldc2 names the typeinfo of a top-level `extern(C++) class C`
        // `_ZTI1C` (the NUL-terminated `const(char)*`).
        expect(dsToJs(cstr(target.cpp.typeInfoMangle(cd)))).toBe("_ZTI1C");
        expect(target.cpp.thunkMangle(null!, 0)).toBeNull();
    });
});

/**
 * The probe module of CONCERN 11, and ldmd2's stderr for it per triple (`ldmd2 [-mtriple=<t>] -c -o- tprobe.d`,
 * ldc2 1.43.0). The `-sse2` line is LLVM's warning for a feature the AArch64 backend does not know (gen/ldctraits.ts).
 */
const TPROBE = `module tprobe;
import core.stdc.config, core.stdc.stdarg;
pragma(msg, real.sizeof, " ", real.alignof, " ", c_long_double.sizeof, " ", va_list.stringof, " ", va_list.sizeof);
pragma(msg, real.mant_dig, " ", real.max, " ", real.min_normal, " ", real.epsilon, " ", real.max_exp, " ",
    real.min_10_exp);
pragma(msg, __traits(getTargetInfo, "objectFormat"), " ", __traits(targetCPU), " ", __traits(targetHasFeature, "sse2"));
extern(C++) void cppva(va_list x);
pragma(msg, cppva.mangleof);
version (D_ObjectiveC) pragma(msg, "objc"); else pragma(msg, "no objc");
struct BF2 { char a; int : 0; char c; }
struct D4 { double a, b, c, d; }
struct RR { char c; real r; }
template AT(T) { static if (is(T A == __argTypes)) enum AT = A.stringof; else enum AT = "null"; }
pragma(msg, BF2.sizeof, " ", RR.sizeof, " ", AT!D4, " ", AT!(float[4]), " ",
    __traits(isReturnOnStack, () { D4 x; return x; }));
pragma(msg, 1.0L / 3, " ", cast(real) 0.1);
`;

/** The oracle's install; the probe runs pass it as `--djs-ldc=`, so `-v` names its ldc2.conf as ldmd2 does. */
// ORACLE CONSTANT: an LDC 1.43.0 install (what --djs-ldc names); set it to yours to run the oracle tests.
const LDC_ROOT = "/Users/pinver/Projects/Prefix/tools/mac_a64/ldc2-1.43.0";
const LDC_CONF = `${LDC_ROOT}/etc/ldc2.conf`;
const PREDEFS_COMMON = "predefs  LDC all D_Version2 assert D_PreConditions D_PostConditions D_Invariants D_ModuleInfo "
    + "D_Exceptions D_TypeInfo ";

const TRIPLE_PROBES: { triple: string | null; stderr: string[]; config: string; predefs: string }[] = [
    {
        triple: null,
        stderr: [
            "8LU 8LU 8LU char* 8LU", "53 1.79769e+308L 2.22507e-308L 2.22045e-16L 1024 -307",
            "'-sse2' is not a recognized feature for this target (ignoring feature)", "macho generic false",
            "_Z5cppvaPc", "objc", "5LU 16LU (double[4]) (float[4]) false", "0.333333L 0.1L",
        ],
        config: hostTriple().getTriple(),
        predefs: "AArch64 ARM_HardFloat D_HardFloat LittleEndian D_LP64 D_PIC OSX Apple darwin Posix CppRuntime_LLVM "
            + "CppRuntime_Clang LDC_LLVM_22 D_ObjectiveC",
    },
    {
        triple: "aarch64-linux-gnu",
        stderr: [
            "16LU 16LU 16LU __va_list 32LU", "113 infL 0.0L 1.92593e-34L 16384 -4931",
            "'-sse2' is not a recognized feature for this target (ignoring feature)", "elf generic false",
            "_Z5cppvaSt9__va_list", "no objc", "8LU 32LU (double[4]) (float[4]) false", "0.333333L 0.1L",
        ],
        config: "aarch64-unknown-linux-gnu",
        predefs: "AArch64 ARM_HardFloat D_HardFloat LittleEndian ELFv1 D_LP64 D_PIC linux Posix CRuntime_Glibc "
            + "CppRuntime_GNU CppRuntime_Gcc LDC_LLVM_22",
    },
    {
        triple: "x86_64-linux-gnu",
        stderr: [
            "16LU 16LU 16LU __va_list_tag* 8LU", "64 infL 0.0L 1.0842e-19L 16384 -4931", "elf x86-64 true",
            "_Z5cppvaP13__va_list_tag", "no objc", "5LU 32LU () (double, double) true", "0.333333L 0.1L",
        ],
        config: "x86_64-unknown-linux-gnu",
        predefs: "X86_64 D_InlineAsm_X86_64 D_HardFloat LittleEndian ELFv1 D_LP64 D_PIC linux Posix CRuntime_Glibc "
            + "CppRuntime_GNU CppRuntime_Gcc LDC_LLVM_22",
    },
    // An explicit Mac triple: the host's output, the triple as spelled in `-v` (ldmd2 probe, both spellings).
    ...["arm64-apple-darwin24.0.0", "aarch64-apple-macos"].map((triple) => ({
        triple,
        stderr: [
            "8LU 8LU 8LU char* 8LU", "53 1.79769e+308L 2.22507e-308L 2.22045e-16L 1024 -307",
            "'-sse2' is not a recognized feature for this target (ignoring feature)", "macho generic false",
            "_Z5cppvaPc", "objc", "5LU 16LU (double[4]) (float[4]) false", "0.333333L 0.1L",
        ],
        config: triple,
        predefs: "AArch64 ARM_HardFloat D_HardFloat LittleEndian D_LP64 D_PIC OSX Apple darwin Posix CppRuntime_LLVM "
            + "CppRuntime_Clang LDC_LLVM_22 D_ObjectiveC",
    })),
];

interface Run {
    code: number;
    stdout: string;
    stderr: string;
}

/** One `djsMain` per argument list, from `cwd`, in one fresh module registry; streams captured apart. */
async function djsRuns(calls: string[][], cwd: string): Promise<Run[]> {
    vi.resetModules();
    const { djsMain } = await import("../djs.js");
    const runs: Run[] = [];
    const here = process.cwd();
    process.chdir(cwd);
    try {
        for (const args of calls) {
            const out: string[] = [];
            const err: string[] = [];
            const tap = (into: string[]) => (c: string | Uint8Array): boolean => {
                into.push(typeof c === "string" ? c : new TextDecoder().decode(c));
                return true;
            };
            const o = vi.spyOn(process.stdout, "write").mockImplementation(tap(out));
            const e = vi.spyOn(process.stderr, "write").mockImplementation(tap(err));
            try {
                runs.push({ code: djsMain(args), stdout: out.join(""), stderr: err.join("") });
            } finally {
                o.mockRestore();
                e.mockRestore();
            }
        }
    } finally {
        process.chdir(here);
    }
    return runs;
}

describe("target.ts — the -mtriple targets (10 §4.8)", () => {
    afterEach(() => {
        global.params.targetTriple = null;
        target._init(global.params);
    });

    // CONCERN 11. driver/targetmachine.cpp:480 normalizes the spelling; the arch name is the triple's own
    // component (`getArchName()`), the OS major its version (none on a Linux triple).
    it("parseTargetTriple accepts the two Linux triples in both spellings, the arm64 Mac, and nothing else", () => {
        for (const sp of ["aarch64-linux-gnu", "aarch64-unknown-linux-gnu"]) {
            const t = parseTargetTriple(sp)!;
            expect([t.arch, t.archName, t.os, t.getTriple(), t.osMajor, t.explicit])
                .toEqual(["aarch64", "aarch64", "linux", "aarch64-unknown-linux-gnu", 0, sp]);
        }
        for (const sp of ["x86_64-linux-gnu", "x86_64-unknown-linux-gnu"]) {
            const t = parseTargetTriple(sp)!;
            expect([t.arch, t.archName, t.os, t.getTriple(), t.osMajor, t.explicit])
                .toEqual(["x86_64", "x86_64", "linux", "x86_64-unknown-linux-gnu", 0, sp]);
        }
        // the Mac: kept as spelled, the OS major the version's first number, 0 without one
        const macs = [
            ["arm64-apple-darwin", "arm64", 0], ["arm64-apple-darwin24.0.0", "arm64", 24],
            ["aarch64-apple-macos", "aarch64", 0], ["arm64-apple-macos14.2", "arm64", 14],
            ["arm64-apple-macosx15", "arm64", 15],
        ] as const;
        for (const [sp, archName, osMajor] of macs) {
            const t = parseTargetTriple(sp)!;
            expect([t.arch, t.archName, t.os, t.getTriple(), t.osMajor, t.explicit])
                .toEqual(["aarch64", archName, "darwin", sp, osMajor, sp]);
        }
        for (const sp of ["armv6kz-linux-gnueabihf", "x86_64-apple-darwin", "arm64-apple-ios", "arm64-apple-darwin-x",
            "", "linux"])
            expect(parseTargetTriple(sp)).toBeNull();
        const host = hostTriple();
        expect([host.arch, host.archName, host.os, host.explicit]).toEqual(["aarch64", "arm64", "darwin", null]);
    });

    // The host's triple from Node's platform and arch: the arm64 Mac with its Darwin release, Linux on aarch64 and
    // x86_64 as LLVM's default triples, nothing for an Intel Mac or Windows (refused by the driver without -mtriple).
    it("hostTripleOf maps the three supported hosts and refuses the others", () => {
        const mac = hostTripleOf("darwin", "arm64", "27.0.0")!;
        expect([mac.arch, mac.archName, mac.os, mac.getTriple(), mac.osMajor, mac.explicit])
            .toEqual(["aarch64", "arm64", "darwin", "arm64-apple-darwin27.0.0", 27, null]);
        const a64 = hostTripleOf("linux", "arm64", "6.12.0")!;
        expect([a64.arch, a64.archName, a64.os, a64.getTriple(), a64.osMajor, a64.explicit])
            .toEqual(["aarch64", "aarch64", "linux", "aarch64-unknown-linux-gnu", 0, null]);
        const x64 = hostTripleOf("linux", "x64", "6.12.0")!;
        expect([x64.arch, x64.archName, x64.os, x64.getTriple(), x64.osMajor, x64.explicit])
            .toEqual(["x86_64", "x86_64", "linux", "x86_64-unknown-linux-gnu", 0, null]);
        for (const [platform, arch] of [["darwin", "x64"], ["win32", "x64"], ["win32", "arm64"], ["freebsd", "x64"]])
            expect(hostTripleOf(platform!, arch!, "1.0")).toBeNull();
    });

    // CONCERN 11. gen/target.cpp:129-271 per triple; values are ldc2's (`real.sizeof`/`.alignof`, `real.max`,
    // `D_ObjectiveC`, `-X` architectures, objectFormat) except the C++-sourced dll_ext and realpad (x86_fp80's
    // alloc size 16 minus store size 10).
    it("_init per triple: real layout and properties, OS, Objective-C, names", () => {
        const cases = [
            ["aarch64-linux-gnu", OS.linux, RealKind.quad, 16, 0, 113n, Infinity, 0, 1.925929944387236e-34, "aarch64",
                "so", "elf", false],
            ["x86_64-linux-gnu", OS.linux, RealKind.x87, 16, 6, 64n, Infinity, 0, 1.0842021724855044e-19, "x86_64",
                "so", "elf", false],
        ] as const;
        for (const [sp, os, kind, size, pad, mant, max, minNormal, eps, arch, dll, fmt, objc] of cases) {
            global.params.targetTriple = parseTargetTriple(sp);
            target._init(global.params);
            expect([target.os, target.realKind, target.realsize, target.realpad, target.realalignsize])
                .toEqual([os, kind, size, pad, size]);
            expect(target.c.long_doublesize).toBe(size);
            expect([target.RealProperties.mant_dig, target.RealProperties.max, target.RealProperties.min_normal,
                target.RealProperties.epsilon]).toEqual([mant, max, minNormal, eps]);
            expect([target.RealProperties.max_exp, target.RealProperties.min_exp, target.RealProperties.max_10_exp,
                target.RealProperties.min_10_exp]).toEqual([16384n, -16381n, 4932n, -4931n]);
            expect([dsToJs(target.architectureName), dsToJs(target.dll_ext), target.objc.supported])
                .toEqual([arch, dll, objc]);
            const fmtExp = target.getTargetInfo(ds("objectFormat\0"), loc)!.isStringExp()!;
            expect(dsToJs(fmtExp.peekString())).toBe(fmt);
            expect(target.supportsLinkerDirective()).toBe(false);
        }
        global.params.targetTriple = null;
        target._init(global.params);
        expect([target.os, target.realKind, target.realsize, target.objc.supported, target.supportsLinkerDirective()])
            .toEqual([OS.OSX, RealKind.double_, 8, true, true]);
    });

    // CONCERN 11, end to end: what ldmd2 prints for TPROBE per triple, and its `-v` config and predefs lines. One
    // registry for the two calls: each `djsMain` starts from `deinitializeFrontend` (10 §4.7).
    for (const p of TRIPLE_PROBES) {
        it(`compiles the probe module as ldmd2 does: ${p.triple ?? "host"}`, async () => {
            const dir = mkdtempSync(join(tmpdir(), "djs-tprobe-"));
            try {
                writeFileSync(join(dir, "tprobe.d"), TPROBE);
                const mt = [`--djs-ldc=${LDC_ROOT}`, ...(p.triple === null ? [] : [`-mtriple=${p.triple}`])];
                const [r, v] = await djsRuns([[...mt, "-c", "-o-", "tprobe.d"], [...mt, "-v", "-c", "-o-", "tprobe.d"]],
                    dir);
                expect([r!.code, r!.stdout, r!.stderr]).toEqual([0, "", p.stderr.join("\n") + "\n"]);
                const lines = v!.stdout.split("\n");
                expect(lines.find((l) => l.startsWith("config"))).toBe(`config    ${LDC_CONF} (${p.config})`);
                expect(lines.find((l) => l.startsWith("predefs"))).toBe(PREDEFS_COMMON + p.predefs);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        }, 120_000);
    }

    // CONCERN 11. driver/main.cpp:1205-1207 then the fatal at :1216; a triple outside the model stops the run
    // (10 §4.2).
    it("refuses -m64 with -mtriple as ldc2 does, and a triple the shim does not model", async () => {
        const dir = mkdtempSync(join(tmpdir(), "djs-tprobe-"));
        try {
            writeFileSync(join(dir, "e.d"), "module e;\n");
            const [both, other] = await djsRuns([["-m64", "-mtriple=x86_64-linux-gnu", "-c", "-o-", "e.d"],
                ["-mtriple=armv6kz-linux-gnueabihf", "-c", "-o-", "e.d"]], dir);
            expect(both!.code).toBe(1);
            expect(both!.stderr)
                .toBe("Error: -m32 and -m64 switches cannot be used together with -march and -mtriple switches\n");
            expect(other!.code).toBe(2);
            expect(other!.stderr).toMatch(/^djs: unsupported flag `-mtriple=armv6kz-linux-gnueabihf`/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 120_000);
});
