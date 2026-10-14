// Goal tests for src/dmd/constfold.ts.
//
// dmd/constfold.d has ZERO in-source `unittest{}` blocks (`grep -c unittest dmd/constfold.d` = 0), so this file
// takes the 10 §1.6b shape: one module-load smoke test plus behaviour pins, one `test()` per concern. Every
// expected value is ldc2 1.43.0 output (arm64-apple-darwin): the folded constant of `enum x = <expr>;` printed by
// `ldc2 -c -o- -vcg-ast`, or the diagnostic ldc2 prints on stderr. The folds are called directly on literal
// operands whose types are the ones D's semantic pass hands them.

import { initSemaHarness } from "../sema-harness.js"; // imports ./dmd/parse.js first: the module-graph root (10 §1.5)
import { beforeEach, describe, expect, test } from "vitest";
import {
    cantExp, Neg, Com, Not, Add, Min, Mul, Div, Mod, Pow, Shl, Shr, Ushr, And, Or, Xor, Equal, Identity, Cmp, Cast,
    ArrayLength, Index, Slice, sliceBoundsCheck, Cat,
} from "./constfold.js";
import { UnionExp } from "./ctfeexpr.js";
import {
    Expression, IntegerExp, RealExp, StringExp, ArrayLiteralExp, NullExp, ErrorExp, CTFEExp,
} from "./expression.js";
import { Type } from "./mtype.js";
import { arrayOf, sarrayOf, immutableOf } from "./typesem.js";
import { Loc } from "./location.js";
import { EXP } from "./tokens.js";
import { global } from "./globals.js";
import { Array as DArray } from "./root/array.js";
import { setDiagnosticHandler } from "./errors.js";
import { dmdformat } from "./root/dmdformat.js";
import { ds, dsToJs } from "../dstring.js";
import { EnumDeclaration } from "./denum.js";
import { Identifier } from "./identifier.js";

const loc = Loc.initial;

function int(v: number | bigint, t: Type = Type.tint32): IntegerExp {
    return new IntegerExp(loc, BigInt(v), t);
}

function real(v: number, t: Type = Type.tfloat64): RealExp {
    return new RealExp(loc, v, t);
}

/** An array literal of int elements, typed `int[]` (or the given type). */
function intArray(vals: number[], t: Type = arrayOf(Type.tint32)): ArrayLiteralExp {
    const elems = new DArray<Expression | null>();
    for (const v of vals)
        elems.push(int(v));
    return new ArrayLiteralExp(loc, t, elems);
}

/** The folded integer carrier, after asserting the fold produced an IntegerExp. */
function ival(ue: UnionExp): bigint {
    const e = ue.exp();
    expect(e.op).toBe(EXP.int64);
    return e.isIntegerExp()!.value;
}

function rval(ue: UnionExp): number {
    const e = ue.exp();
    expect(e.op).toBe(EXP.float64);
    return e.isRealExp()!.value;
}

/** The int elements of a folded array literal. */
function elems(ue: UnionExp): bigint[] {
    const ale = ue.exp().isArrayLiteralExp()!;
    const out: bigint[] = [];
    for (let i = 0; i < ale.elements!.length; i++)
        out.push(ale.opIndex(i)!.isIntegerExp()!.value);
    return out;
}

/** Runs `fn` with diagnostics captured as `<header><message>` strings (the safe.test.ts convention). */
function captureDiags<T>(fn: () => T): { value: T; diags: string[] } {
    const diags: string[] = [];
    setDiagnosticHandler((_loc, _color, header, messageFormat, args) => {
        diags.push(dsToJs(header) + dsToJs(dmdformat(messageFormat, [...args])));
        return true;
    });
    try {
        return { value: fn(), diags };
    } finally {
        setDiagnosticHandler(null);
    }
}

describe("constfold.ts", () => {
    beforeEach(() => {
        initSemaHarness();
    });

    test("SMOKE: the module loads and cantExp writes an EXP.cantExpression node", () => {
        expect(typeof Expression).toBe("function");
        const ue = new UnionExp();
        cantExp(ue);
        expect(CTFEExp.isCantExp(ue.exp())).toBe(true);
        expect(ue.copy()).toBeInstanceOf(CTFEExp);
        expect(ue.copy()).toBe(CTFEExp.cantexp);
    });

    test("integer + - * wrap per the result type (int.max + 1, uint.max + 1u, long.max + 1L, 100000 * 100000)", () => {
        expect(ival(Add(loc, Type.tint32, int(2147483647), int(1)))).toBe(-2147483648n);
        expect(ival(Add(loc, Type.tuns32, int(4294967295, Type.tuns32), int(1, Type.tuns32)))).toBe(0n);
        expect(ival(Add(loc, Type.tint64, int(9223372036854775807n, Type.tint64), int(1, Type.tint64))))
            .toBe(-9223372036854775808n);
        expect(ival(Mul(loc, Type.tint32, int(100000), int(100000)))).toBe(1410065408n);
        // `10 - 15u` -> 4294967291u (Min is Add of the negation)
        expect(ival(Min(loc, Type.tuns32, int(10, Type.tuns32), int(15, Type.tuns32)))).toBe(4294967291n);
    });

    test("Div / Mod read the carrier signed or unsigned by operand type: -7 / 2, -8 / 3u, ulong.max / 2", () => {
        expect(ival(Div(loc, Type.tint32, int(-7), int(2)))).toBe(-3n);
        // D: `-8 / 3u` — sema paints the int operand uint (4294967288u), so the division is unsigned
        expect(ival(Div(loc, Type.tuns32, int(-8, Type.tuns32), int(3, Type.tuns32)))).toBe(1431655762n);
        expect(ival(Div(loc, Type.tuns64, int(18446744073709551615n, Type.tuns64), int(2, Type.tuns64))))
            .toBe(9223372036854775807n);
        expect(ival(Mod(loc, Type.tint32, int(-7), int(2)))).toBe(-1n);
        // `int.min % -1L` is long arithmetic: not the long.min pattern, and the type IS long -> 0L, no error
        expect(ival(Mod(loc, Type.tint64, int(-2147483648, Type.tint64), int(-1, Type.tint64)))).toBe(0n);
        expect(global.errors).toBe(0);
    });

    test("Div / Mod diagnostics: divide by 0, int.min / -1, long.min % -1L (ldc2 stderr)", () => {
        const d1 = captureDiags(() => Div(loc, Type.tint32, int(1), int(0)));
        expect(d1.diags).toEqual(["Error: divide by 0"]);
        expect(d1.value.exp()).toBeInstanceOf(ErrorExp);
        const d2 = captureDiags(() => Mod(loc, Type.tint32, int(5), int(0)));
        expect(d2.diags).toEqual(["Error: divide by 0"]);
        const d3 = captureDiags(() => Div(loc, Type.tint32, int(-2147483648), int(-1)));
        expect(d3.diags).toEqual(["Error: integer overflow: `int.min / -1`"]);
        const lmin = int(-9223372036854775808n, Type.tint64);
        const d4 = captureDiags(() => Mod(loc, Type.tint64, lmin, int(-1, Type.tint64)));
        expect(d4.diags).toEqual(["Error: integer overflow: `long.min % -1L`"]);
        expect(d4.value.exp().op).toBe(EXP.error);
        const d5 = captureDiags(() => Div(loc, Type.tint64, lmin, int(-1, Type.tint64)));
        expect(d5.diags).toEqual(["Error: integer overflow: `long.min / -1L`"]);
    });

    test("shifts: 1 << 31, 1L << 40, -8 >> 1, -8 >>> 1, -1L >>> 60, cast(ubyte)0xF0 >> 4", () => {
        expect(ival(Shl(loc, Type.tint32, int(1), int(31)))).toBe(-2147483648n);
        expect(ival(Shl(loc, Type.tint64, int(1, Type.tint64), int(40)))).toBe(1099511627776n);
        expect(ival(Shr(loc, Type.tint32, int(-8), int(1)))).toBe(-4n);
        expect(ival(Ushr(loc, Type.tint32, int(-8), int(1)))).toBe(2147483644n);
        expect(ival(Ushr(loc, Type.tint64, int(-1, Type.tint64), int(60)))).toBe(15n);
        // the ubyte operand is promoted by sema; Shr's Tuns8 arm still reads the low 8 bits
        expect(ival(Shr(loc, Type.tint32, int(0xF0, Type.tuns8), int(4)))).toBe(15n);
    });

    test("bitwise, negation, complement, not: 7 & 3 | 8 ^ 1, -int.min, ~0u, !0", () => {
        expect(ival(Or(loc, Type.tint32, And(loc, Type.tint32, int(7), int(3)).exp(),
            Xor(loc, Type.tint32, int(8), int(1)).exp()))).toBe(11n);
        expect(ival(Neg(Type.tint32, int(-2147483648)))).toBe(-2147483648n);
        expect(ival(Com(Type.tuns32, int(0, Type.tuns32)))).toBe(4294967295n);
        expect(ival(Not(Type.tbool, int(0)))).toBe(1n);
        expect(rval(Neg(Type.tfloat64, real(-2.5)))).toBe(2.5);
    });

    test("floating folds keep double precision: 0.1 + 0.2, 2.0 * 3.5, 7.5 % 2.0, -7.5 % 2.0, 1.0 / 0.0", () => {
        expect(rval(Add(loc, Type.tfloat64, real(0.1), real(0.2)))).toBe(0.30000000000000004);
        expect(rval(Mul(loc, Type.tfloat64, real(2.0), real(3.5)))).toBe(7);
        expect(rval(Mod(loc, Type.tfloat64, real(7.5), real(2.0)))).toBe(1.5);
        expect(rval(Mod(loc, Type.tfloat64, real(-7.5), real(2.0)))).toBe(-1.5);
        expect(rval(Div(loc, Type.tfloat64, real(1.0), real(0.0)))).toBe(Infinity);
    });

    test("Pow: 2 ^^ 10, (-2) ^^ 3, 3L ^^ 40 wraps, 2.0 ^^ -2; integral base, negative exponent is cantexp", () => {
        expect(ival(Pow(loc, Type.tint32, int(2), int(10)))).toBe(1024n);
        expect(ival(Pow(loc, Type.tint32, int(-2), int(3)))).toBe(-8n);
        expect(ival(Pow(loc, Type.tint64, int(3, Type.tint64), int(40, Type.tint64)))).toBe(-6289078614652622815n);
        expect(rval(Pow(loc, Type.tfloat64, real(2.0), int(-2)))).toBe(0.25);
        expect(CTFEExp.isCantExp(Pow(loc, Type.tint32, int(2), int(-1)).exp())).toBe(true);
        // a non-negative base with a floating exponent is left to the runtime `pow` (constfold.d:486)
        expect(CTFEExp.isCantExp(Pow(loc, Type.tfloat64, real(2.0), real(0.5)).exp())).toBe(true);
    });

    test("Pow: a negative base with a floating exponent folds to target.RealProperties.nan (constfold.d:483)", () => {
        // RE-PIN (10 §1.8): the Target.RealProperties wall is gone. ldc2: `enum x = (-8.0) ^^ 0.5;` folds to nan.
        expect(Number.isNaN(rval(Pow(loc, Type.tfloat64, real(-8.0), real(0.5))))).toBe(true);
    });

    test("Cmp: -1 < 1u is unsigned (false), -1 < 1 (true), nan < 1.0 (false), uint.max > 0u (true)", () => {
        expect(ival(Cmp(EXP.lessThan, loc, Type.tbool, int(-1), int(1, Type.tuns32)))).toBe(0n);
        expect(ival(Cmp(EXP.lessThan, loc, Type.tbool, int(-1), int(1)))).toBe(1n);
        expect(ival(Cmp(EXP.lessThan, loc, Type.tbool, real(NaN), real(1.0)))).toBe(0n);
        expect(ival(Cmp(EXP.greaterThan, loc, Type.tbool, int(4294967295, Type.tuns32), int(0, Type.tuns32))))
            .toBe(1n);
        expect(ival(Cmp(EXP.lessThan, loc, Type.tbool, real(1.5), real(2.5)))).toBe(1n);
    });

    test("Equal / Identity: [1, 2] == [1, 2], [1, 2] != [1, 3], nan == nan, 0.0 is -0.0, nan is nan", () => {
        expect(ival(Equal(EXP.equal, loc, Type.tbool, intArray([1, 2]), intArray([1, 2])))).toBe(1n);
        expect(ival(Equal(EXP.notEqual, loc, Type.tbool, intArray([1, 2]), intArray([1, 3])))).toBe(1n);
        expect(ival(Equal(EXP.equal, loc, Type.tbool, real(1.0), real(1.0)))).toBe(1n);
        expect(ival(Equal(EXP.equal, loc, Type.tbool, real(NaN), real(NaN)))).toBe(0n);
        expect(ival(Identity(EXP.identity, loc, Type.tbool, real(0.0), real(-0.0)))).toBe(0n);
        expect(ival(Identity(EXP.identity, loc, Type.tbool, real(NaN), real(NaN)))).toBe(1n);
        // a null against an empty array literal is equal (constfold.d:628)
        expect(ival(Equal(EXP.equal, loc, Type.tbool, new NullExp(loc, arrayOf(Type.tint32)), intArray([]))))
            .toBe(1n);
    });

    test("Cast between integers truncates: cast(int)0x1_0000_0001L, cast(long)7, cast(byte)-129, cast(bool)2", () => {
        expect(ival(Cast(loc, Type.tint32, Type.tint32, int(0x100000001n, Type.tint64)))).toBe(1n);
        const l = Cast(loc, Type.tint64, Type.tint64, int(7)).exp();
        expect(l.isIntegerExp()!.value).toBe(7n);
        expect(l.type).toBe(Type.tint64);
        expect(ival(Cast(loc, Type.tint8, Type.tint8, int(-129)))).toBe(127n);
        expect(ival(Cast(loc, Type.tuns8, Type.tuns8, int(-1)))).toBe(255n);
        expect(ival(Cast(loc, Type.tint16, Type.tint16, int(40000)))).toBe(-25536n);
        expect(ival(Cast(loc, Type.tbool, Type.tbool, int(2)))).toBe(1n);
    });

    test("Cast of an enum-typed constant to its base type folds a CLONE: the operand keeps its type", () => {
        // `cast(int)E.a` with `enum E : int` — constfold.d:935-938 paints the int type on what
        // `emplaceExp!(UnionExp)` copied in (ctfeexpr.d:114-117 is a memcpy), never on the operand (02 §11.1).
        const ed = new EnumDeclaration(loc, Identifier.idPool(ds("E")), Type.tint32);
        const operand = int(3, ed.type!);
        const r = Cast(loc, Type.tint32, Type.tint32, operand).exp();
        expect(r).not.toBe(operand);
        expect(r.type).toBe(Type.tint32);
        expect(r.isIntegerExp()!.value).toBe(3n);
        expect(operand.type).toBe(ed.type);
    });

    test("Cast floating -> integer saturates like the target's fcvtzs/fcvtzu (ldc2 -vcg-ast table)", () => {
        const c = (t: Type, v: number): bigint => ival(Cast(loc, t, t, real(v)));
        expect(c(Type.tint32, 3e9)).toBe(2147483647n);
        expect(c(Type.tint32, -3e9)).toBe(-2147483648n);
        expect(c(Type.tint32, -1e10)).toBe(-2147483648n);
        expect(c(Type.tint32, NaN)).toBe(0n);
        expect(c(Type.tint32, Infinity)).toBe(2147483647n);
        expect(c(Type.tint32, -2.9)).toBe(-2n);
        expect(c(Type.tuns32, 5e9)).toBe(4294967295n);
        expect(c(Type.tuns32, -1.5)).toBe(0n);
        expect(c(Type.tint8, 300.7)).toBe(44n);
        expect(c(Type.tint8, 1e19)).toBe(-1n);
        expect(c(Type.tuns8, -1.5)).toBe(0n);
        expect(c(Type.tuns8, 1e20)).toBe(255n);
        expect(c(Type.tuns8, 1e19)).toBe(0n);
        expect(c(Type.tint16, -40000.2)).toBe(25536n);
        expect(c(Type.tuns16, 70000.9)).toBe(4464n);
        expect(c(Type.tint64, 1e19)).toBe(9223372036854775807n);
        expect(c(Type.tuns64, -3.0)).toBe(0n);
        expect(c(Type.tchar, 300.0)).toBe(44n);
        expect(c(Type.tdchar, 5e9)).toBe(4294967295n);
    });

    test("ArrayLength / Index / Slice on literals: [1, 2, 3].length, [10, 20, 30][1], [1, 2, 3, 4][1 .. 3]", () => {
        expect(ival(ArrayLength(Type.tsize_t, intArray([1, 2, 3])))).toBe(3n);
        expect(ival(ArrayLength(Type.tsize_t, new StringExp(loc, [0x61, 0x62, 0x63])))).toBe(3n);
        expect(ival(ArrayLength(Type.tsize_t, new NullExp(loc, arrayOf(Type.tint32))))).toBe(0n);
        expect(ival(Index(Type.tint32, intArray([10, 20, 30]), int(1, Type.tsize_t), false))).toBe(20n);
        const s = new StringExp(loc, [0x61, 0x62, 0x63, 0x64]);
        s.type = arrayOf(Type.tchar);
        expect(ival(Index(Type.tchar, s, int(1, Type.tsize_t), false))).toBe(0x62n);
        expect(elems(Slice(arrayOf(Type.tint32), intArray([1, 2, 3, 4]), int(1, Type.tsize_t), int(3, Type.tsize_t))))
            .toEqual([2n, 3n]);
        // out-of-range slice bounds answer cantexp, silently (constfold.d:1264-1265)
        const oob = Slice(arrayOf(Type.tint32), intArray([1, 2]), int(1, Type.tsize_t), int(3, Type.tsize_t));
        expect(CTFEExp.isCantExp(oob.exp())).toBe(true);
    });

    test("Index out of bounds: the array and string diagnostics (ldc2 stderr, constfold.d:1129/:1145)", () => {
        const a = captureDiags(() => Index(Type.tint32, intArray([1, 2, 3], sarrayOf(Type.tint32, 3n)),
            int(5, Type.tsize_t), false));
        expect(a.diags).toEqual(["Error: array index 5 is out of bounds `[1, 2, 3][0 .. 3]`"]);
        expect(a.value.exp()).toBeInstanceOf(ErrorExp);
        const s = new StringExp(loc, [0x61, 0x62, 0x63]);
        s.type = arrayOf(Type.tchar);
        const b = captureDiags(() => Index(Type.tchar, s, int(5, Type.tsize_t), false));
        expect(b.diags).toEqual(["Error: string index 5 is out of bounds `[0 .. 3]`"]);
    });

    test("sliceBoundsCheck: true when [newlwr .. newupr] leaves [lwr .. upr] (constfold.d:1280)", () => {
        expect(sliceBoundsCheck(0n, 4n, 1n, 3n)).toBe(false);
        expect(sliceBoundsCheck(0n, 4n, 0n, 4n)).toBe(false);
        expect(sliceBoundsCheck(0n, 4n, 3n, 1n)).toBe(true);
        expect(sliceBoundsCheck(0n, 4n, 2n, 5n)).toBe(true);
        // a negative bound read as ulong (0xFFFF...) is out of range
        expect(sliceBoundsCheck(0n, 4n, 18446744073709551615n, 2n)).toBe(true);
    });

    test("Cat of a null string and a dchar UTF-8-encodes the character (catNull, constfold.d:1412-1441)", () => {
        // A null `string` and a dchar U+00E9: the element type is char (sz 1), so catNull encodes the character
        // through utf_encode's sz == 1 arm (utf_encodeChar). ldc2 CTFE agrees: `string s; dchar d = 0xE9; s ~= d;`
        // yields the two bytes C3 A9 (static assert). Sema rejects the literal form, so the fold is called directly.
        const nul = new NullExp(loc, Type.tstring);
        const r = Cat(loc, Type.tstring, nul, int(0xE9, Type.tdchar)).exp().isStringExp()!;
        expect(r.len).toBe(2);
        expect(r.sz).toBe(1);
        expect([r.getIndex(0), r.getIndex(1)]).toEqual([0xC3n, 0xA9n]);
        expect(r.committed).toBe(true);
        expect(r.type).toBe(Type.tstring);
    });

    test("Cat on array literals: [1, 2] ~ [3], [1, 2] ~ 3, [1, 2] ~ null", () => {
        const ti = arrayOf(Type.tint32);
        const r1 = Cat(loc, ti, intArray([1, 2]), intArray([3]));
        expect(elems(r1)).toEqual([1n, 2n, 3n]);
        expect(r1.exp().type).toBe(ti);
        expect(elems(Cat(loc, ti, intArray([1, 2]), int(3)))).toEqual([1n, 2n, 3n]);
        expect(elems(Cat(loc, ti, intArray([1, 2]), new NullExp(loc, ti)))).toEqual([1n, 2n]);
    });

    test("Cat on two string literals: \"a\" ~ \"b\" (test12567e.d) and the wchar / dchar forms", () => {
        // ldc2: `enum w = "ab"w ~ "cd"w;` prints abcd; `"é€"w ~ "\U0001F600"w` prints é€😀 with length 4, the dchar
        // form length 3 (w1_fold.d in the translation report). The payload is little-endian bytes at width sz.
        const a = new StringExp(loc, [0x61]);
        a.type = arrayOf(immutableOf(Type.tchar));
        const b = new StringExp(loc, [0x62]);
        b.type = arrayOf(immutableOf(Type.tchar));
        const r = Cat(loc, Type.tstring, a, b).exp().isStringExp()!;
        expect(dsToJs(r.peekString())).toBe("ab");
        expect(r.type).toBe(Type.tstring);

        const tw = arrayOf(immutableOf(Type.twchar));
        const w1 = new StringExp(loc, [0xe9, 0x00, 0xac, 0x20], 2, 2);
        w1.type = tw;
        const w2 = new StringExp(loc, [0x3d, 0xd8, 0x00, 0xde], 2, 2);
        w2.type = tw;
        const rw = Cat(loc, tw, w1, w2).exp().isStringExp()!;
        expect(rw.sz).toBe(2);
        expect(rw.len).toBe(4);
        expect([...rw.peekWstring()]).toEqual([0xe9, 0x20ac, 0xd83d, 0xde00]);

        const td = arrayOf(immutableOf(Type.tdchar));
        const d1 = new StringExp(loc, [0xe9, 0, 0, 0], 1, 4);
        d1.type = td;
        const d2 = new StringExp(loc, [0x00, 0xf6, 0x01, 0x00], 1, 4);
        d2.type = td;
        const rd = Cat(loc, td, d1, d2).exp().isStringExp()!;
        expect([...rd.peekDstring()]).toEqual([0xe9, 0x1f600]);
    });

    test("Cat of a null wstring and a dchar re-encodes it as UTF-16 (constfold.d:1427, utf.d:110)", () => {
        // catNull re-encodes a dchar into the wchar element type through utf_encode's sz == 2 arm: U+1F600 is the
        // surrogate pair D83D DE00, little-endian in the payload. Sema rejects the literal form, so the fold is
        // called directly; ldc2 CTFE agrees: `wstring s; s ~= cast(dchar)0x1F600;` is [0xD83D, 0xDE00], and
        // `wstring s = "a"; s ~= cast(dchar)0x1F600;` is ['a', 0xD83D, 0xDE00].
        const tw = arrayOf(immutableOf(Type.twchar));
        const r = Cat(loc, tw, new NullExp(loc, tw), int(0x1f600, Type.tdchar)).exp().isStringExp()!;
        expect(r.sz).toBe(2);
        expect(r.len).toBe(2);
        expect([...r.peekData()]).toEqual([0x3d, 0xd8, 0x00, 0xde]);
    });

    test("Cat of a wstring and a dchar appends its UTF-16 encoding (constfold.d:1559, utf.d:110)", () => {
        const tw = arrayOf(immutableOf(Type.twchar));
        const w = new StringExp(loc, [0x61, 0x00], 1, 2); // "a"w
        w.type = tw;
        const r = Cat(loc, tw, w, int(0x1f600, Type.tdchar)).exp().isStringExp()!;
        expect(r.len).toBe(3);
        expect([...r.peekData()]).toEqual([0x61, 0x00, 0x3d, 0xd8, 0x00, 0xde]);
    });
});
