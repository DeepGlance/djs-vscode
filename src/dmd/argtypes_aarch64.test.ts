// Co-located tests for src/dmd/argtypes_aarch64.ts (ported from dmd/argtypes_aarch64.d, LDC 1.43.0).
//
// dmd/argtypes_aarch64.d carries no in-source `unittest{}` block, so this file is the test file of
// 10-tests-diagnostics.md §1.6b: one module-load smoke test plus one pin per risky construct. Expected
// values are ldc2's (10 §1.8 rule 8), probed on arm64-apple-darwin with
//   template AT(T) { static if (is(T A == __argTypes)) enum AT = A.stringof; else enum AT = "NO"; }
//   pragma(msg, AT!T);
// (`ldc2 -c -o- probe.d`; `__argTypes` is `target.toArgTypes`, expressionsem.d:9147, i.e. this module).
// The struct types are declared in D source and run through `runSemantic`, so their sizes, field
// lists and POD-ness are the port's own semantic results, as they are for the frontend.
//
// The pinned CONCERNS:
//   1. module load (this file enters the module graph through argtypes_aarch64.js).
//   2. non-aggregates pass as themselves; zero-sized types answer null; `Type.terror` is its own tuple.
//   3. HFA/HVA structs rewrite to `fundamental[N]` for N <= 4 (float, double, `real` == double,
//      nested arrays, unions, zero-length members); five elements or mixed fundamentals do not.
//   4. the remaining POD aggregates of at most 16 bytes go to `byte`/`short`/`int`/`long`/`long[n]`;
//      larger ones, and non-PODs, answer the empty tuple.
//   5. static and dynamic arrays, delegates, complex numbers.
//   6. `isHFVA`'s `rewriteType` box and `maxNumElements` bound.

import { describe, it, expect, beforeEach } from "vitest";

// FIRST on purpose — the load-order SMOKE test of 01 §4.8: argtypes_aarch64 has value edges into
// typesem, dsymbolsem and expressionsem, and this import makes it the module that ENTERS the graph.
import { toArgTypes_aarch64, isHFVA } from "./argtypes_aarch64.js";
import type { Ref } from "./argtypes_aarch64.js";
import { Parser } from "./parse.js";
import { Identifier } from "./identifier.js";
import { ErrorSinkNull } from "./errorsink.js";
import { Type, TypeTuple } from "./mtype.js";
import { global } from "./globals.js";
import { moduleFromParse } from "./dmodule.js";
import type { Module } from "./dmodule.js";
import { runSemantic } from "./dsymbolsem.js";
import { typeToChars } from "./hdrgen.js";
import { pointerTo } from "./typesem.js";
import type { StructDeclaration } from "./dstruct.js";
import { cstr, ds, dsToJs } from "../dstring.js";
import { initSemaHarness } from "../sema-harness.js";

beforeEach(() => {
    initSemaHarness();
});

function srcBuf(s: string): Uint8Array {
    const b = new Uint8Array(s.length + 1);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    b[s.length] = 0;
    return b;
}

/** lex + parse + `runSemantic` `src`; the test fails if semantic reports an error. */
function sema(src: string): Module {
    const p = new Parser(null, null, srcBuf(src), false, new ErrorSinkNull(), null, false);
    p.nextToken();
    const m = moduleFromParse(p.parseModule(), p.md);
    runSemantic(m);
    expect(global.errors).toBe(0);
    return m;
}

function findStruct(m: Module, name: string): StructDeclaration {
    const sd = m.symtab!.lookup(Identifier.idPool(ds(name)))!.isStructDeclaration();
    expect(sd).not.toBeNull();
    return sd!;
}

/** The tuple as ldc2's `A.stringof` prints it: `(float[2])`, `()`, or `NO` for null. */
function show(tt: TypeTuple | null): string {
    if (tt === null)
        return "NO";
    const parts: string[] = [];
    for (let i = 0; i < tt.arguments!.length; i++)
        parts.push(dsToJs(cstr(typeToChars(tt.arguments!.opIndex(i)!.type!))));
    return `(${parts.join(", ")})`;
}

/** `toArgTypes_aarch64` of each named struct of `m`, as `show` prints it. */
function structArgTypes(m: Module, names: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const n of names)
        out[n] = show(toArgTypes_aarch64(findStruct(m, n).type!));
    return out;
}

/** `toArgTypes_aarch64` of each field type of `struct H`, keyed by field name. */
function fieldArgTypes(fields: string): Record<string, string> {
    const m = sema(`struct H { ${fields} }`);
    const sd = findStruct(m, "H");
    const out: Record<string, string> = {};
    for (let i = 0; i < sd.fields.length; i++) {
        const v = sd.fields.opIndex(i)!;
        out[dsToJs(v.ident!.toString())] = show(toArgTypes_aarch64(v.type!));
    }
    return out;
}

describe("argtypes_aarch64.ts", () => {
    // CONCERN 1.
    it("loads as the entry of the module graph", () => {
        expect(typeof Type).toBe("function");
        expect(typeof TypeTuple).toBe("function");
        expect(typeof toArgTypes_aarch64).toBe("function");
    });

    // CONCERN 2. ldc2: `int` (int), `float` (float), `real` (real), `ifloat` (ifloat), `int*` (int*),
    // `void` (void) — `void.sizeof` is 1, so it is not the null answer —, `int[0]` NO.
    it("passes non-aggregates as themselves, answers null for a zero-sized type", () => {
        expect(show(toArgTypes_aarch64(Type.tint32))).toBe("(int)");
        expect(show(toArgTypes_aarch64(Type.tfloat32))).toBe("(float)");
        expect(show(toArgTypes_aarch64(Type.tfloat80))).toBe("(real)");
        expect(show(toArgTypes_aarch64(Type.timaginary32))).toBe("(ifloat)");
        expect(show(toArgTypes_aarch64(Type.tvoid))).toBe("(void)");
        expect(show(toArgTypes_aarch64(pointerTo(Type.tint32)))).toBe("(int*)");
        expect(fieldArgTypes("int[0] z;")).toEqual({ z: "NO" });
        const terr = toArgTypes_aarch64(Type.terror)!;
        expect(terr.arguments!.length).toBe(1);
        expect(terr.arguments!.opIndex(0)!.type).toBe(Type.terror);
    });

    // CONCERN 3. ldc2: F1 (float[1]), F2 (float[2]), F3 (float[3]), F4 (float[4]), F5 (), D4 (double[4]),
    // D5 (), R2 (double[2]) — `real` is `double` here —, MFD (long[2]) — mixed float/double is not an
    // HFA —, HFA2 (float[3]) — `{F1[2] vals; float weight;}` —, U (float[2]) — the union's SIZE sets N —,
    // F0x (float[2]) — a zero-length member consumes nothing —, FL (long) — float + int is not an HFA.
    it("rewrites HFA structs to fundamental[N], N <= 4, and rejects mixed or longer ones", () => {
        const src = `
            struct F1 { float a; }
            struct F2 { float a, b; }
            struct F3 { float a, b, c; }
            struct F4 { float a, b, c, d; }
            struct F5 { float a, b, c, d, e; }
            struct D4 { double a, b, c, d; }
            struct D5 { double a, b, c, d, e; }
            struct R2 { real a, b; }
            struct MFD { float a; double b; }
            struct HFA2 { F1[2] vals; float weight; }
            union U { float a; float[2] b; }
            struct F0x { float a; float[0] z; float b; }
            struct FL { float a; int b; }
        `;
        const m = sema(src);
        expect(structArgTypes(m, ["F1", "F2", "F3", "F4", "F5", "D4", "D5", "R2", "MFD", "HFA2", "F0x", "FL"]))
            .toEqual({
                F1: "(float[1])", F2: "(float[2])", F3: "(float[3])", F4: "(float[4])", F5: "()",
                D4: "(double[4])", D5: "()", R2: "(double[2])", MFD: "(long[2])", HFA2: "(float[3])",
                F0x: "(float[2])", FL: "(long)",
            });
        const u = m.symtab!.lookup(Identifier.idPool(ds("U")))!.isUnionDeclaration()!;
        expect(show(toArgTypes_aarch64(u.type!))).toBe("(float[2])");
    });

    // CONCERN 4. ldc2: I1 (int), B1 (byte), S2 (short), B3 (long[1]) — 3 bytes round up to one
    // register —, L1 (long), IL (long[2]), I3 (long[2]), L2 (long[2]), L3 (), L5 () — over 16 bytes —,
    // E (byte) — the empty struct is one undefined byte, not an HFA —, EA (int) — `{float[0] a;}` has
    // size 4 and no HFA element —, NP () / NPD () — a postblit or a destructor makes it a non-POD.
    it("passes other POD aggregates of at most 16 bytes in GP registers, the rest indirectly", () => {
        const src = `
            struct I1 { int a; }
            struct B1 { byte a; }
            struct S2 { short a; }
            struct B3 { byte a, b, c; }
            struct L1 { long a; }
            struct IL { int a; long b; }
            struct I3 { int a, b, c; }
            struct L2 { long a, b; }
            struct L3 { long a, b, c; }
            struct L5 { long[5] a; }
            struct E {}
            struct EA { float[0] a; }
            struct NP { int a; this(this) {} }
            struct NPD { int a; ~this() {} }
        `;
        const names = ["I1", "B1", "S2", "B3", "L1", "IL", "I3", "L2", "L3", "L5", "E", "EA", "NP", "NPD"];
        expect(structArgTypes(sema(src), names))
            .toEqual({
                I1: "(int)", B1: "(byte)", S2: "(short)", B3: "(long[1])", L1: "(long)", IL: "(long[2])",
                I3: "(long[2])", L2: "(long[2])", L3: "()", L5: "()", E: "(byte)", EA: "(int)", NP: "()",
                NPD: "()",
            });
    });

    // CONCERN 5. ldc2: int[3] (long[2]), int[5] (), float[4] (float[4]), float[5] (), double[2]
    // (double[2]), byte[3] (long[1]), byte[5] (long[1]), byte[7] (long[1]), byte[9] (long[2]),
    // byte[16] (long[2]), byte[17] (), ulong[2] (long[2]), int[] (long[2]), string (long[2]),
    // `void delegate()` (long[2]), `void function()` (void function()), cfloat (float[2]),
    // cdouble (double[2]), creal (double[2]).
    it("classifies static and dynamic arrays, delegates and complex numbers", () => {
        expect(fieldArgTypes(`
            int[3] i3; int[5] i5; float[4] f4; float[5] f5; double[2] d2; byte[3] b3; byte[5] b5;
            byte[7] b7; byte[9] b9; byte[16] b16; byte[17] b17; ulong[2] ul2; int[] da; immutable(char)[] s;
            void delegate() dg; void function() fp;
        `)).toEqual({
            i3: "(long[2])", i5: "()", f4: "(float[4])", f5: "()", d2: "(double[2])", b3: "(long[1])",
            b5: "(long[1])", b7: "(long[1])", b9: "(long[2])", b16: "(long[2])", b17: "()", ul2: "(long[2])",
            da: "(long[2])", s: "(long[2])", dg: "(long[2])", fp: "(void function())",
        });
        expect(show(toArgTypes_aarch64(Type.tcomplex32))).toBe("(float[2])");
        expect(show(toArgTypes_aarch64(Type.tcomplex64))).toBe("(double[2])");
        expect(show(toArgTypes_aarch64(Type.tcomplex80))).toBe("(double[2])");
    });

    // CONCERN 3, vector leg. ldc2: `__vector(float[4])` (__vector(float[4])) — a non-aggregate —,
    // `__vector(float[4])[2]` (__vector(float[4])[2]), V1 (__vector(float[4])[1]), V2 (__vector(float[4])[2]).
    it("rewrites HVA aggregates of __vector elements to vector[N]", () => {
        const m = sema("struct V1 { __vector(float[4]) v; } struct V2 { __vector(float[4]) v, w; }");
        expect(structArgTypes(m, ["V1", "V2"]))
            .toEqual({ V1: "(__vector(float[4])[1])", V2: "(__vector(float[4])[2])" });
        expect(fieldArgTypes("__vector(float[4]) v; __vector(float[4])[2] va;"))
            .toEqual({ v: "(__vector(float[4]))", va: "(__vector(float[4])[2])" });
    });

    // CONCERN 6. The public `isHFVA` (argtypes_aarch64.d:92, also exported to LDC's C++ through
    // cxxfrontend.d:1230): the box is written only on success; `maxNumElements` bounds N. Values
    // follow from the ldc2 answers above (F4 is `float[4]`, F5 is not an HFA).
    it("isHFVA writes rewriteType only for an HFVA within maxNumElements", () => {
        const m = sema("struct F4 { float a, b, c, d; } struct I1 { int a; }");
        const f4 = findStruct(m, "F4").type!;
        const box: Ref<Type | null> = { value: null };
        expect(isHFVA(f4, 4, box)).toBe(true);
        expect(dsToJs(cstr(typeToChars(box.value!)))).toBe("float[4]");
        expect(isHFVA(f4)).toBe(true);
        const untouched: Ref<Type | null> = { value: null };
        expect(isHFVA(f4, 3, untouched)).toBe(false);
        expect(untouched.value).toBeNull();
        expect(isHFVA(findStruct(m, "I1").type!, 4, untouched)).toBe(false);
        expect(untouched.value).toBeNull();
        expect(isHFVA(Type.tfloat32)).toBe(false);
    });
});
