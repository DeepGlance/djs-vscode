// Co-located tests for src/dmd/argtypes_sysv_x64.ts (ported from dmd/argtypes_sysv_x64.d, LDC 1.43.0).
//
// dmd/argtypes_sysv_x64.d carries no in-source `unittest{}` block, so this file is the test file of
// 10-tests-diagnostics.md §1.6b: one module-load smoke test plus one pin per risky construct. Expected values are
// ldc2's (10 §1.8 rule 8), probed with
//   template AT(T) { static if (is(T A == __argTypes)) enum AT = A.stringof; else enum AT = "null"; }
//   pragma(msg, AT!T);
// (`ldc2 -mtriple=x86_64-linux-gnu -c -o- probe.d`; `__argTypes` is `target.toArgTypes`, expressionsem.d:9147,
// i.e. this module on that triple). Every test runs with the x86_64-linux-gnu triple installed in
// `global.params.targetTriple` and `target` re-initialised for it, so `real` is the 16-byte x87 type the
// classification sees on that target; the host triple is restored after each test.
//
// The pinned CONCERNS:
//   1. module load (this file enters the module graph through argtypes_sysv_x64.js).
//   2. scalars: integer and SSE classes, `real` x87, `void` as one integer byte, zero size null, `Type.terror`.
//   3. structs of one and two eightbytes, merged per eightbyte (integer wins over SSE), a misaligned or
//      oversized aggregate in memory, a non-POD in memory, the empty struct in memory.
//   4. x87 members: `real` alone in registers, two `real`s or a `creal` member in memory (finalizeAggregate).
//   5. vectors and static arrays over two eightbytes (sseUp), dynamic arrays and delegates.

import { describe, it, expect, beforeEach, afterEach } from "vitest";

// FIRST on purpose — the load-order SMOKE test of 01 §4.8: argtypes_sysv_x64 has value edges into typesem,
// dsymbolsem, expressionsem, target and the visitor, and this import makes it the module that ENTERS the graph.
import { toArgTypes_sysv_x64 } from "./argtypes_sysv_x64.js";
import { Parser } from "./parse.js";
import { Identifier } from "./identifier.js";
import { ErrorSinkNull } from "./errorsink.js";
import { Type, TypeTuple } from "./mtype.js";
import { DiagnosticReporting, global } from "./globals.js";
import { moduleFromParse } from "./dmodule.js";
import type { Module } from "./dmodule.js";
import { runSemantic } from "./dsymbolsem.js";
import { typeToChars } from "./hdrgen.js";
import { pointerTo } from "./typesem.js";
import { parseTargetTriple, target } from "./target.js";
import type { StructDeclaration } from "./dstruct.js";
import { cstr, ds, dsToJs } from "../dstring.js";
import { initSemaHarness } from "../sema-harness.js";

beforeEach(() => {
    initSemaHarness();
    global.params.targetTriple = parseTargetTriple("x86_64-linux-gnu");
    target._init(global.params);
    global.params.useDeprecated = DiagnosticReporting.off;   // the `cfloat`/`creal` members of CONCERN 4
});

afterEach(() => {
    global.params.useDeprecated = DiagnosticReporting.inform;
    global.params.targetTriple = null;
    target._init(global.params);
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

/** The tuple as ldc2's `A.stringof` prints it: `(double, float)`, `()`, or `null`. */
function show(tt: TypeTuple | null): string {
    if (tt === null)
        return "null";
    const parts: string[] = [];
    for (let i = 0; i < tt.arguments!.length; i++)
        parts.push(dsToJs(cstr(typeToChars(tt.arguments!.opIndex(i)!.type!))));
    return `(${parts.join(", ")})`;
}

/** `toArgTypes_sysv_x64` of each named struct of `m`, as `show` prints it. */
function structArgTypes(m: Module, names: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const n of names)
        out[n] = show(toArgTypes_sysv_x64(findStruct(m, n).type!));
    return out;
}

/** `toArgTypes_sysv_x64` of each field type of `struct H`, keyed by field name. */
function fieldArgTypes(fields: string): Record<string, string> {
    const m = sema(`struct H { ${fields} }`);
    const sd = findStruct(m, "H");
    const out: Record<string, string> = {};
    for (let i = 0; i < sd.fields.length; i++) {
        const v = sd.fields.opIndex(i)!;
        out[dsToJs(v.ident!.toString())] = show(toArgTypes_sysv_x64(v.type!));
    }
    return out;
}

describe("argtypes_sysv_x64.ts", () => {
    // CONCERN 1.
    it("loads as the entry of the module graph", () => {
        expect(typeof Type).toBe("function");
        expect(typeof toArgTypes_sysv_x64).toBe("function");
        expect(target.realsize).toBe(16);
    });

    // CONCERN 2. ldc2: int (int), long (long), double (double), float (float), real (real), void (byte),
    // void* (long), int[0] null, cfloat (double), cdouble (double, double), creal (real, real).
    it("classifies scalars: integer, SSE, x87; zero size is null", () => {
        expect(show(toArgTypes_sysv_x64(Type.tint32))).toBe("(int)");
        expect(show(toArgTypes_sysv_x64(Type.tint64))).toBe("(long)");
        expect(show(toArgTypes_sysv_x64(Type.tfloat64))).toBe("(double)");
        expect(show(toArgTypes_sysv_x64(Type.tfloat32))).toBe("(float)");
        expect(show(toArgTypes_sysv_x64(Type.tfloat80))).toBe("(real)");
        expect(show(toArgTypes_sysv_x64(Type.tvoid))).toBe("(byte)");
        expect(show(toArgTypes_sysv_x64(pointerTo(Type.tint32)))).toBe("(long)");
        expect(show(toArgTypes_sysv_x64(Type.tcomplex32))).toBe("(double)");
        expect(show(toArgTypes_sysv_x64(Type.tcomplex64))).toBe("(double, double)");
        expect(show(toArgTypes_sysv_x64(Type.tcomplex80))).toBe("(real, real)");
        expect(fieldArgTypes("int[0] z;")).toEqual({ z: "null" });
        const terr = toArgTypes_sysv_x64(Type.terror)!;
        expect(terr.arguments!.length).toBe(1);
        expect(terr.arguments!.opIndex(0)!.type).toBe(Type.terror);
    });

    // CONCERN 3. ldc2: I1 (int), L2 (long, long), L3 (), F2 (double), F3 (double, float), D2 (double, double),
    // D4 (), M1 (long, double), M2 (long, long), B9 (long, byte), B17 (), U (int), E (), P ().
    it("merges each eightbyte's fields; oversized, non-POD and empty structs go in memory", () => {
        const src = `
            struct I1 { int a; }
            struct L2 { long a, b; }
            struct L3 { long a, b, c; }
            struct F2 { float a, b; }
            struct F3 { float a, b, c; }
            struct D2 { double a, b; }
            struct D4 { double a, b, c, d; }
            struct M1 { int a; double b; }
            struct M2 { char c; float f; long l; }
            struct B9 { byte[9] b; }
            struct B17 { byte[17] b; }
            struct U { union { int i; float f; } }
            struct E { }
            struct P { int a; this(this) {} }
        `;
        const names = ["I1", "L2", "L3", "F2", "F3", "D2", "D4", "M1", "M2", "B9", "B17", "U", "E", "P"];
        expect(structArgTypes(sema(src), names)).toEqual({
            I1: "(int)", L2: "(long, long)", L3: "()", F2: "(double)", F3: "(double, float)",
            D2: "(double, double)", D4: "()", M1: "(long, double)", M2: "(long, long)", B9: "(long, byte)",
            B17: "()", U: "(int)", E: "()", P: "()",
        });
    });

    // CONCERN 4. ldc2: R1 (real), R2 () — two x87 eightbyte pairs are memory —, C1 (double) — a cfloat
    // member is one SSE eightbyte —, CR () — a creal member is complexX87 in an aggregate.
    it("keeps one x87 real in registers and puts larger x87 aggregates in memory", () => {
        const m = sema("struct R1 { real r; } struct R2 { real r, s; } struct C1 { cfloat c; } struct CR { creal c; }");
        expect(structArgTypes(m, ["R1", "R2", "C1", "CR"]))
            .toEqual({ R1: "(real)", R2: "()", C1: "(double)", CR: "()" });
    });

    // CONCERN 5. ldc2: __vector(int[4]) (__vector(double[2])), V (__vector(double[2])), float[4]
    // (double, double), int[2] (long), int[5] (), int[] (long, long), `int delegate()` (long, long).
    it("classifies vectors as sse + sseUp, static arrays as structs, slices and delegates as two integers", () => {
        const m = sema("struct V { __vector(float[4]) v; }");
        expect(structArgTypes(m, ["V"])).toEqual({ V: "(__vector(double[2]))" });
        expect(fieldArgTypes("__vector(int[4]) vi; float[4] f4; int[2] i2; int[5] i5; int[] da; int delegate() dg;"))
            .toEqual({
                vi: "(__vector(double[2]))", f4: "(double, double)", i2: "(long)", i5: "()", da: "(long, long)",
                dg: "(long, long)",
            });
    });
});
