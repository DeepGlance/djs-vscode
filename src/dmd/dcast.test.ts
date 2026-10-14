// Co-located tests for src/dmd/dcast.ts.
//
// dmd/dcast.d carries ZERO upstream `unittest` blocks (verified: `grep -c '^unittest' dcast.d` -> 0),
// so this file is the thin test file of 10 §1.6b: one module-load smoke test plus one behavior
// pin per risky RESOLVED CONSTRUCT — not a port of upstream tests.
//
// Concerns pinned here (one `test()` each, so a red gate names the right one):
//   1. module load (import executes the top level; catches load-order/cycle regressions)
//   2. the IDIOM-B DISPATCH SWITCH of `implicitConvTo` actually routes (13 §7.5 rule 1) — the
//      rung-era file dropped this switch, silently collapsing every node kind onto the base `visit`
//   3. `implicitConvToType`, the freshly re-derived Type-receiver overload (04 §1B rename)
//   4. `integralPromotions` — the identity default arm and the small-integer `castTo` arm
//   5. `castTo`'s arithmetic-vs-arithmetic `ok()` path (the CastExp painted with the target type)
//   6. `intRangeFromType` — the signed/unsigned bound computation, live end-to-end
//   7. `cimplicitConvTo` — the C11-permissive cascade
//   8. `inferType` with a null target — the `if (t)` gate
//   9. `getIntRange` on an IntegerExp routes to `visitInteger` and narrows through `_cast`
//  10. a negative literal's range: the signed-normalized IntegerExp value in the unsigned carrier
//  11. `typeMerge`'s array-operation arms (dcast.d:4119 `T[] op T`, :4163 `T op T[]`), ldc2-pinned
//  12. `visitSlice`'s zero divisor (dcast.d:1483): arm64 `udiv`'s zero quotient, no diagnostic (09 §3.1)

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    _cast,
    castTo,
    cimplicitConvTo,
    getIntRange,
    implicitCastTo,
    implicitConvTo,
    implicitConvToType,
    inferType,
    integralPromotions,
    intRangeFromType,
    typeMerge,
} from "./dcast.js";
import { Type } from "./mtype.js";
import { ArrayLiteralExp, IntegerExp, SliceExp, VarExp } from "./expression.js";
import type { CastExp, Expression } from "./expression.js";
import { MATCH } from "./astenums.js";
import { Loc } from "./location.js";
import { global } from "./globals.js";
import { ErrorSinkNull } from "./errorsink.js";
import { Type_init, arrayOf, immutableOf, sarrayOf } from "./typesem.js";
import { EXP } from "./tokens.js";
import { VarDeclaration } from "./declaration.js";
import { Identifier } from "./identifier.js";
import { ds, dsToJs } from "../dstring.js";
import { setDiagnosticHandler } from "./errors.js";
import { dmdformat } from "./root/dmdformat.js";
import { Array as DArray } from "./root/array.js";

const noScope = null; // the pinned paths take the non-C-file branch, where `sc` is only forwarded

describe("dcast", () => {
    beforeEach(() => {
        Loc._init();
        Type_init();
        global.errorSink = new ErrorSinkNull();
        global.errors = 0;
    });

    it("module loads and exposes the D free-function surface", () => {
        // Concern 1 — the smoke test. dcast.d declares free functions only; importing the module
        // must execute its top level without touching a not-yet-initialised singleton.
        expect(typeof implicitConvTo).toBe("function");
        expect(typeof implicitConvToType).toBe("function");
        expect(typeof castTo).toBe("function");
        expect(typeof _cast).toBe("function");
    });

    it("implicitConvTo dispatches EXP.int64 to visitInteger, not to the base visit", () => {
        // Concern 2 — the load-bearing dispatch switch (13 §7.5 rule 1). A dchar surrogate to wchar tells the
        // two paths apart: visitInteger rejects the surrogate range (dmd/dcast.d:574-576), while the base
        // `visit`'s value-range branch (dmd/dcast.d:348) would accept 0xD800 because it lies inside wchar's
        // range. So nomatch here proves D's `case EXP.int64` (dmd/dcast.d:1528) selects visitInteger.
        const surrogate = new IntegerExp(Loc.initial, 0xD800n, Type.tdchar);
        expect(implicitConvTo(surrogate, Type.twchar)).toBe(MATCH.nomatch);
        const below = new IntegerExp(Loc.initial, 0xD7FFn, Type.tdchar);
        expect(implicitConvTo(below, Type.twchar)).toBe(MATCH.convert);
    });

    it("implicitConvTo on an int literal: exact to int, convert to long", () => {
        // Concern 2 (companion) — visitInteger's early `m >= MATCH.constant` exit and its fall to
        // the base `visit` through the `default:` arm of the `toty` switch (dmd/dcast.d:630).
        const e = new IntegerExp(Loc.initial, 7n, Type.tint32);
        expect(implicitConvTo(e, Type.tint32)).toBe(MATCH.exact);
        expect(implicitConvTo(e, Type.tint64)).toBe(MATCH.convert);
    });

    it("visitInteger's Tdchar range test reads the carrier UNSIGNED (dmd/dcast.d:598)", () => {
        // Concern 2b — the `dinteger_t` domain of `case Tdchar: if (value > 0x10FFFFU)` (09 §3.1).
        // D's `value` is `e.toInteger()`, a ulong: for an `int` literal -1 the carrier is
        // 0xFFFF_FFFF_FFFF_FFFF, which is > 0x10FFFF, so the conversion is REJECTED.
        // ORACLE (ldc2 1.43.0-beta1, `dchar d = -1;`):
        //   "Error: cannot implicitly convert expression `-1` of type `int` to `dchar`"
        // The port's carrier is sign-normalized (-1n), so a naive signed compare would ACCEPT it.
        const neg = new IntegerExp(Loc.initial, -1n, Type.tint32);
        expect(implicitConvTo(neg, Type.tdchar)).toBe(MATCH.nomatch);

        // The boundary itself still behaves: the last code point converts, one past it does not.
        expect(implicitConvTo(new IntegerExp(Loc.initial, 0x10FFFFn, Type.tint32), Type.tdchar))
            .toBe(MATCH.convert);
        expect(implicitConvTo(new IntegerExp(Loc.initial, 0x110000n, Type.tint32), Type.tdchar))
            .toBe(MATCH.nomatch);
    });

    it("implicitConvToType is the Type-receiver overload (04 §1B rename)", () => {
        // Concern 3 — the fresh re-derivation of dmd/dcast.d:1558. `visitBasic` (dcast.d:1571):
        // same type + same mod -> exact; widening int -> long -> convert; narrowing long -> int is
        // rejected by the `sz > tosz` size test (dcast.d:1631).
        expect(implicitConvToType(Type.tint32, Type.tint32)).toBe(MATCH.exact);
        expect(implicitConvToType(Type.tint32, Type.tint64)).toBe(MATCH.convert);
        expect(implicitConvToType(Type.tint64, Type.tint32)).toBe(MATCH.nomatch);
        // to void / from void / to bool are hard rejects (dcast.d:1592-1595)
        expect(implicitConvToType(Type.tint32, Type.tbool)).toBe(MATCH.nomatch);
        expect(implicitConvToType(Type.tint32, Type.tvoid)).toBe(MATCH.nomatch);
        // floating -> integral is rejected; integral -> floating converts (dcast.d:1637-1646)
        expect(implicitConvToType(Type.tfloat64, Type.tint32)).toBe(MATCH.nomatch);
        expect(implicitConvToType(Type.tint32, Type.tfloat64)).toBe(MATCH.convert);
    });

    it("integralPromotions: default arm is the identity, small integers route through castTo", () => {
        // Concern 4 — dmd/dcast.d:4302. int/uint/long take the `default:` arm and are returned
        // UNCHANGED (no CastExp); byte/short/char/wchar/bool are cast to int.
        const ei: Expression = new IntegerExp(Loc.initial, 1n, Type.tint32);
        const el: Expression = new IntegerExp(Loc.initial, 2n, Type.tint64);
        const eu: Expression = new IntegerExp(Loc.initial, 3n, Type.tuns32);
        expect(integralPromotions(ei, noScope)).toBe(ei);
        expect(integralPromotions(el, noScope)).toBe(el);
        expect(integralPromotions(eu, noScope)).toBe(eu);

        const es: Expression = new IntegerExp(Loc.initial, 4n, Type.tint16);
        const r = integralPromotions(es, noScope) as CastExp;
        expect(r.isCastExp()).not.toBeNull();
        expect(r.type).toBe(Type.tint32);
        expect(r.e1).toBe(es);
        expect(r.e1!.type).toBe(Type.tint16); // the wrapped operand keeps its own type
        expect(global.errors).toBe(0);
    });

    it("castTo paints a CastExp for an arithmetic-to-arithmetic cast", () => {
        // Concern 5 — the base `visit`'s `ok()` (dmd/dcast.d:2139) reached through the
        // "arithmetic values vs. other arithmetic values" test (dmd/dcast.d:2229).
        const e: Expression = new IntegerExp(Loc.initial, 5n, Type.tint32);
        const r = castTo(e, noScope, Type.tint64) as CastExp;
        expect(r.isCastExp()).not.toBeNull();
        expect(r.type).toBe(Type.tint64);
        expect(r.e1).toBe(e);
        expect(global.errors).toBe(0);

        // Same type in and out: D returns the expression itself, no wrapper (dmd/dcast.d:2084).
        expect(castTo(e, noScope, Type.tint32)).toBe(e);
    });

    it("intRangeFromType computes the signed and unsigned bounds", () => {
        // Concern 6 — dmd/dcast.d:78, live end-to-end (only the non-integral arm walls on
        // `IntRange.widest`). int: [~0x7FFFFFFF (negative), 0x7FFFFFFF]; uint: [0, 0xFFFFFFFF].
        const ri = intRangeFromType(Type.tint32);
        expect(ri.imin.negative).toBe(true);
        // D stores `~(mask >> 1)` in a `uinteger_t` slot, so the value is the 64-bit UNSIGNED
        // pattern 0xFFFF_FFFF_8000_0000 — NOT the bare BigInt complement -2147483648n. Spelling the
        // literal (rather than re-using the implementation's expression) keeps the pin honest.
        expect(ri.imin.value).toBe(0xFFFFFFFF80000000n);
        expect(ri.imax.negative).toBe(false);
        expect(ri.imax.value).toBe(0x7FFFFFFFn);

        const ru = intRangeFromType(Type.tuns32);
        expect(ru.imin.value).toBe(0n);
        expect(ru.imin.negative).toBe(false);
        expect(ru.imax.value).toBe(0xFFFFFFFFn);

        // dchar clamps the upper bound to the last code point (dmd/dcast.d:87).
        const rd = intRangeFromType(Type.tdchar);
        expect(rd.imax.value).toBe(0x10FFFFn);

        // The explicit-`isUnsigned` overload (arity Form A) overrides the type's own signedness.
        const rf = intRangeFromType(Type.tint32, true);
        expect(rf.imin.value).toBe(0n);
        expect(rf.imax.value).toBe(0xFFFFFFFFn);
    });

    it("cimplicitConvTo applies the permissive C11 cascade", () => {
        // Concern 7 — dmd/dcast.d:2019. Identical basetypes are exact; any integral/floating pair
        // converts, which is exactly where C11 is looser than D (float -> int is nomatch in D).
        const ei: Expression = new IntegerExp(Loc.initial, 1n, Type.tint32);
        expect(cimplicitConvTo(ei, Type.tint32)).toBe(MATCH.exact);
        expect(cimplicitConvTo(ei, Type.tfloat64)).toBe(MATCH.convert);

        const ef: Expression = new IntegerExp(Loc.initial, 1n, Type.tfloat64);
        expect(cimplicitConvTo(ef, Type.tint32)).toBe(MATCH.convert);
        // ... while plain D rejects it:
        expect(implicitConvToType(Type.tfloat64, Type.tint32)).toBe(MATCH.nomatch);
    });

    it("inferType with a null target returns the expression untouched", () => {
        // Concern 8 — dmd/dcast.d:3283's `if (t) switch (e.op)` gate: with no target type the whole
        // dispatch is skipped and `e` falls through to the trailing `return e`.
        const e: Expression = new IntegerExp(Loc.initial, 1n, Type.tint32);
        expect(inferType(e, null)).toBe(e);
        // An EXP not in the dispatch set hits the (empty) `default:` and also falls through.
        expect(inferType(e, Type.tint32)).toBe(e);
    });

    it("getIntRange(IntegerExp) routes to visitInteger and narrows through _cast", () => {
        // Concern 9. D's dispatch (dmd/dcast.d:4557 `case EXP.int64`) selects `visitInteger`, whose
        // body is `IntRange(SignExtendedNumber(e.getInteger()))._cast(e.type)`; for a signed type
        // `_cast` takes `IntRange.castSigned` (dmd/dcast.d:58). A literal's range is the point [7, 7].
        const e: Expression = new IntegerExp(Loc.initial, 7n, Type.tint32);
        const r = getIntRange(e);
        expect([r.imin.value, r.imin.negative, r.imax.value, r.imax.negative]).toEqual([7n, false, 7n, false]);
    });

    it("a negative literal's range is sign-extended in the unsigned 64-bit carrier", () => {
        // Concern 10. The TS IntegerExp value is signed-normalized (-5n) while D's `dinteger_t` is a
        // ulong, so `visitInteger` converts with `toUint64` before building the SignExtendedNumber.
        // ldc2 1.43 (scratch probe): `byte b = -5;` compiles; `ubyte u = -1;` fails with
        // "cannot implicitly convert expression `-1` of type `int` to `ubyte`".
        const m5: Expression = new IntegerExp(Loc.initial, -5n, Type.tint32);
        const r = getIntRange(m5);
        expect([r.imin.value, r.imin.negative]).toEqual([0xFFFF_FFFF_FFFF_FFFBn, true]);
        expect([r.imax.value, r.imax.negative]).toEqual([0xFFFF_FFFF_FFFF_FFFBn, true]);
        expect(implicitConvTo(m5, Type.tint8)).toBe(MATCH.convert);

        const m1: Expression = new IntegerExp(Loc.initial, -1n, Type.tint32);
        expect(implicitConvTo(m1, Type.tuns8)).toBe(MATCH.nomatch);
        // The reject is the ldc2 diagnostic above (dcast.d:184), counted once; the result is an ErrorExp.
        expect(implicitCastTo(m1, noScope, Type.tuns8).isErrorExp()).not.toBeNull();
        expect(global.errors).toBe(1);
    });
});

// Concern 11 — the two array-operation arms of `typeMerge`. Ground truth (ldc2 1.43.0, `-c -o- -vcg-ast`
// on `void f(int[] a, int[] b, long[] c, double[] d, long x)`):
//     typeof(a[] + 1) -> int[]      b[] = a[] + 1;   -> arrayOp(b[], a[], 1)
//     typeof(2 * a[]) -> int[]      b[] = 2 * a[];   -> arrayOp(b[], a[], 2)    (commutative, e1 const: swap)
//                                   b[] = 2 - a[];   -> arrayOp(b[], 2, a[])    (not commutative: no swap)
//     typeof(a[] + x) -> long[]     c[] = x + a[];   -> arrayOp(c[], x, a[])    (e1 not const: no swap)
//     typeof(a[] + d[]) -> double[] d[] = a[] + d[]; -> arrayOp(d[], a[], d[])  (int->double left to arrayOp)
describe("dcast typeMerge array-operation arms", () => {
    beforeEach(() => {
        Loc._init();
        Type_init();
        global.errorSink = new ErrorSinkNull();
        global.errors = 0;
    });

    const slice = (name: string, elem: Type): Expression => {
        const v = new VarDeclaration(Loc.initial, arrayOf(elem), Identifier.idPool(ds(name)), null);
        const ve = new VarExp(Loc.initial, v);
        ve.type = arrayOf(elem);
        const se = new SliceExp(Loc.initial, ve, null, null);
        se.type = arrayOf(elem);
        return se;
    };
    const scalarVar = (name: string, t: Type): Expression => {
        const v = new VarDeclaration(Loc.initial, t, Identifier.idPool(ds(name)), null);
        const ve = new VarExp(Loc.initial, v);
        ve.type = t;
        return ve;
    };
    const merge = (op: EXP, e1: Expression, e2: Expression) => {
        const pe1 = { value: e1 };
        const pe2 = { value: e2 };
        const t = typeMerge(noScope, op, pe1, pe2);
        return { t, e1: pe1.value, e2: pe2.value };
    };

    it("T[] op T: a[] + 1 -> int[], operands kept in order", () => {
        const a = slice("a", Type.tint32);
        const one = new IntegerExp(Loc.initial, 1n, Type.tint32);
        const r = merge(EXP.add, a, one);
        expect(r.t!.equals(arrayOf(Type.tint32))).toBe(true);
        expect(r.e1).toBe(a);
        expect(r.e2.type!.equals(Type.tint32)).toBe(true);
    });

    it("(cast(T)U)[] op T: a[] + x (long) -> long[], e1 left as int[] for arrayOp", () => {
        const a = slice("a", Type.tint32);
        const r = merge(EXP.add, a, scalarVar("x", Type.tint64));
        expect(r.t!.equals(arrayOf(Type.tint64))).toBe(true);
        expect(r.e1).toBe(a);
    });

    it("T[] op (cast)U[]: a[] + d[] -> double[], the int->double cast left to arrayOp", () => {
        const a = slice("a", Type.tint32);
        const d = slice("d", Type.tfloat64);
        const r = merge(EXP.add, a, d);
        expect(r.t!.equals(arrayOf(Type.tfloat64))).toBe(true);
        expect(r.e1).toBe(a);
        expect(r.e2).toBe(d);
    });

    it("T op T[]: 2 * a[] -> int[], commutative with a constant e1, so the operands swap", () => {
        const a = slice("a", Type.tint32);
        const r = merge(EXP.mul, new IntegerExp(Loc.initial, 2n, Type.tint32), a);
        expect(r.t!.equals(arrayOf(Type.tint32))).toBe(true);
        expect(r.e1).toBe(a);
        expect(r.e2.isIntegerExp()).not.toBeNull();
    });

    it("T op T[]: 2 - a[] -> int[], not commutative, no swap", () => {
        const a = slice("a", Type.tint32);
        const r = merge(EXP.min, new IntegerExp(Loc.initial, 2n, Type.tint32), a);
        expect(r.t!.equals(arrayOf(Type.tint32))).toBe(true);
        expect(r.e1.isIntegerExp()).not.toBeNull();
        expect(r.e2).toBe(a);
    });

    it("T op (cast(T)U)[]: x + a[] (long) -> long[], e1 not constant, no swap", () => {
        const a = slice("a", Type.tint32);
        const x = scalarVar("x", Type.tint64);
        const r = merge(EXP.add, x, a);
        expect(r.t!.equals(arrayOf(Type.tint64))).toBe(true);
        expect(r.e2).toBe(a);
        expect(r.e1.type!.equals(Type.tint64)).toBe(true);
    });
});

// Concern 12 — the zero divisor of `visitSlice` (dcast.d:1483, `t1b.size() / tbn.size()`), 09 §3.1: a zero-size
// element makes the divisor 0. This is a match query, not constant folding, so the port takes arm64 `udiv`'s zero
// quotient as ldc2 does and emits nothing. ldc2 (`int[0][2] h(); void f() { immutable(int[0])[] s = h()[]; }`)
// prints only the caller's `cannot implicitly convert`, and compiles the overload set
// `int foo(immutable(int[0])[]); int foo(const(int[0])[]); foo(h()[]);`.
describe("dcast visitSlice zero divisor", () => {
    beforeEach(() => {
        Loc._init();
        Type_init();
        global.errorSink = new ErrorSinkNull();
        global.errors = 0;
    });

    it("an rvalue int[0][2] sliced to immutable(int[0])[]: MATCH.nomatch, no diagnostic, no RangeError", () => {
        const int0 = sarrayOf(Type.tint32, 0n);
        const elem = (): ArrayLiteralExp => new ArrayLiteralExp(Loc.initial, int0, new DArray<Expression | null>());
        // an rvalue static array: `[[], []]` typed int[0][2]
        const elems = DArray.from<Expression | null>(elem(), elem());
        const lit = new ArrayLiteralExp(Loc.initial, sarrayOf(int0, 2n), elems);
        const se = new SliceExp(Loc.initial, lit, null, null);
        se.type = arrayOf(int0);
        const diags: string[] = [];
        setDiagnosticHandler((_loc, _color, header, messageFormat, args) => {
            diags.push(dsToJs(header) + dsToJs(dmdformat(messageFormat, [...args])));
            return true;
        });
        let m: MATCH;
        try {
            m = implicitConvTo(se, arrayOf(immutableOf(int0)));
        } finally {
            setDiagnosticHandler(null);
        }
        expect(m).toBe(MATCH.nomatch);
        expect(diags).toEqual([]);
    });
});

/** One ldc2-shaped `-c -o-` compile through the shim in a fresh module registry (a new ldmd2 process starts from
 * load-time globals, djs.test.ts); returns the exit code and everything written to stderr. */
async function shimCompile(file: string): Promise<{ code: number; stderr: string }> {
    vi.resetModules();
    const { djsMain } = await import("../djs.js");
    const err: string[] = [];
    const e = vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array): boolean => {
        err.push(typeof c === "string" ? c : new TextDecoder().decode(c));
        return true;
    });
    try {
        return { code: djsMain(["-c", "-o-", file]), stderr: err.join("") };
    } finally {
        e.mockRestore();
    }
}

// dmd/dcast.d:3401-3402 run `arrayFuncConv` (importc.d:83) on both operands whenever `sc` is non-null; outside a
// C file it is the identity, so `int[2]` does not decay to `int*` and the merge fails.
// Expected: ldc2 1.43.0 `-c -o-` on the same file, byte for byte.
describe("typeMerge — arrayFuncConv outside ImportC (dcast.d:3401)", () => {
    it("`c ? a : p` with `int[2] a` and `int* p` stays incompatible", async () => {
        const dir = mkdtempSync(join(tmpdir(), "djs-mergeafc-"));
        try {
            const f = join(dir, "ta.d");
            const line = "void f(bool c) { int[2] a; int* p; auto x = c ? a : p; }";
            writeFileSync(f, `module ta;\n${line}\n`);
            expect(await shimCompile(f)).toEqual({
                code: 1,
                stderr: `${f}(2): Error: incompatible types for \`(a) : (p)\`: \`int[2]\` and \`int*\`\n`
                    + `${line}\n${" ".repeat(46)}^\n`,
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);
});
