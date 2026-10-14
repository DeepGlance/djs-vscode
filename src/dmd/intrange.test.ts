// Tests for the intrange.ts port (dmd/intrange.d — Value Range Propagation arithmetic).
//
// dmd/intrange.d carries ZERO `unittest` blocks (10 §1.6b): nothing to port. The oracle here is
// ldc2 1.43.0 itself: intrange.d compiled STANDALONE (its three dmd imports replaced by
// `alias uinteger_t = ulong;` — Tdchar and Type are unused in the module) and driven by probe
// programs. Every expected value below was printed by that D build, never computed by the port.
// The tables write each 65-bit SignExtendedNumber as a signed literal (`-5n` is
// (0xFFFF_FFFF_FFFF_FFFB, true); MIN65 = (0, true); MAX65 = (ulong.max, false)) and each IntRange as
// `[imin, imax]`.

import { describe, expect, test, vi } from "vitest";
import { IntRange, SignExtendedNumber } from "./intrange.js";
import { ds } from "../dstring.js";
import { toUint64 } from "../numeric.js";
import { AssertError } from "../assert.js";

const TWO64 = 1n << 64n;
const MIN65 = -TWO64;       // SignExtendedNumber(0, true)
const MAX65 = TWO64 - 1n;   // SignExtendedNumber(ulong.max, false)

/// A 65-bit signed value -> its SignExtendedNumber (value = low 64 bits, negative = sign).
function N(x: bigint): SignExtendedNumber {
    return new SignExtendedNumber(toUint64(x), x < 0n);
}
/// SignExtendedNumber -> 65-bit signed value (inverse of N).
function V(s: SignExtendedNumber): bigint {
    return s.negative ? s.value - TWO64 : s.value;
}
function R(p: bigint[]): IntRange {
    return new IntRange(N(p[0]), N(p[1]));
}
function RV(r: IntRange): bigint[] {
    return [V(r.imin), V(r.imax)];
}

type SenBin = "opAdd" | "opSub" | "opMul" | "opDiv" | "opMod" | "opShl" | "opShr" | "opAnd" | "opOr" | "opXor";
type RangeBin = "opAnd" | "opOr" | "opXor" | "opAdd" | "opSub" | "opMod" | "opDiv" | "opShl" | "opShr" | "opUShr";

test("module loads and exports the two value structs", () => {
    expect(typeof SignExtendedNumber).toBe("function");
    expect(typeof IntRange).toBe("function");
});

describe("SignExtendedNumber", () => {
    test("static factories (intrange.d:31-49)", () => {
        expect(V(SignExtendedNumber.fromInteger(0xFFFF_FFFF_FFFF_FFFBn))).toBe(-5n);
        expect(V(SignExtendedNumber.fromInteger(0x7FFF_FFFF_FFFF_FFFFn))).toBe(0x7FFF_FFFF_FFFF_FFFFn);
        expect(V(SignExtendedNumber.extreme(true))).toBe(MIN65);
        expect(V(SignExtendedNumber.extreme(false))).toBe(MAX65);
        expect(V(SignExtendedNumber.max())).toBe(MAX65);
        expect(V(SignExtendedNumber.min())).toBe(MIN65);
        expect(SignExtendedNumber.min().isMinimum()).toBe(true);
        expect(N(0n).isMinimum()).toBe(false);
    });

    test("opCmp / opEquals order the 65-bit values (intrange.d:56/:61)", () => {
        const xs = [MIN65, -0x8000_0000_0000_0000n, -1n, 0n, 1n, 0x8000_0000_0000_0000n, MAX65];
        for (let i = 0; i < xs.length; i++)
            for (let j = 0; j < xs.length; j++) {
                expect(N(xs[i]).opCmp(N(xs[j]))).toBe(i < j ? -1 : i > j ? 1 : 0);
                expect(N(xs[i]).opEquals(N(xs[j]))).toBe(i === j);
            }
    });

    // ldc2 output: [op, lhs, rhs, result].
    const binary: [SenBin, bigint, bigint, bigint][] = [
        ["opAdd", MAX65, 1n, MAX65],
        ["opAdd", MIN65, -1n, MIN65],
        ["opAdd", MAX65, MAX65, MAX65],
        ["opAdd", -5n, 3n, -2n],
        ["opAdd", 5n, -3n, 2n],
        ["opSub", 0n, MIN65, MAX65],
        ["opSub", -3n, MIN65, 0xfffffffffffffffdn],
        ["opSub", 3n, 5n, -2n],
        ["opSub", MIN65, 1n, MIN65],
        ["opMul", 16n, 16n, 256n],
        ["opMul", 0x100000000n, 0x100000000n, MAX65],
        ["opMul", MIN65, 0n, 0n],
        ["opMul", MIN65, 2n, MIN65],
        ["opMul", MIN65, -1n, MAX65],
        ["opMul", -3n, 7n, -21n],
        ["opMul", -3n, -7n, 21n],
        ["opMul", 0n, -7n, 0n],
        ["opDiv", MIN65, MIN65, 1n],
        ["opDiv", 7n, MIN65, 0n],
        ["opDiv", 7n, 0n, MAX65],
        ["opDiv", -7n, 0n, MIN65],
        ["opDiv", MIN65, 4n, -0x4000000000000000n],
        ["opDiv", MIN65, 3n, -0x5555555555555555n],
        ["opDiv", MIN65, 1n, MIN65],
        ["opDiv", MIN65, -1n, MAX65],
        ["opDiv", -7n, 2n, -3n],
        ["opDiv", 7n, -2n, -3n],
        ["opMod", -7n, 3n, -1n],
        ["opMod", 7n, -3n, 1n],
        ["opMod", MIN65, 3n, -1n],
        ["opMod", MIN65, 8n, 0n],
        ["opMod", 7n, 0n, 0n],
        ["opMod", 7n, MIN65, 7n],
        ["opMod", MIN65, MIN65, 0n],
        ["opShl", 1n, 63n, 0x8000000000000000n],
        ["opShl", 1n, 64n, MAX65],
        ["opShl", 3n, 63n, MAX65],
        ["opShl", -1n, 3n, -8n],
        ["opShl", -1n, 64n, MIN65],
        ["opShl", 5n, -1n, MAX65],
        ["opShl", 0n, 100n, 0n],
        ["opShr", -8n, 1n, -4n],
        ["opShr", MIN65, 1n, -0x8000000000000000n],
        ["opShr", MIN65, 0n, MIN65],
        ["opShr", -8n, 64n, -1n],
        ["opShr", 8n, 64n, 0n],
        ["opShr", MAX65, 63n, 1n],
        ["opAnd", -1n, 240n, 240n],
        ["opOr", -2n, 1n, MAX65],
        ["opXor", -1n, 255n, 0xffffffffffffff00n],
    ];
    test.each(binary)("%s(%s, %s) saturates/wraps as ldc2 does", (op, a, b, r) => {
        const lhs = N(a), rhs = N(b);
        expect(V(lhs[op](rhs))).toBe(r);
        // neither operand is mutated (the file elides call-site copies on this basis, 03 §9)
        expect(V(lhs)).toBe(a);
        expect(V(rhs)).toBe(b);
    });

    // ldc2 output: [x, -x, ~x, ++x].
    const unary: bigint[][] = [
        [0n, 0n, -1n, 1n],
        [MIN65, MAX65, MAX65, -0xffffffffffffffffn],
        [MAX65, -0xffffffffffffffffn, 0n, MAX65],
        [-1n, 1n, 0n, 0n],
        [1n, -1n, -2n, 2n],
        [-5n, 5n, 4n, -4n],
    ];
    test.each(unary)("opNeg / opCom / opInc of %s", (x, neg, com, inc) => {
        expect(V(N(x).opNeg())).toBe(neg);
        expect(V(N(x).opCom())).toBe(com);
        const t = N(x);
        const r = t.opInc();
        expect(V(r)).toBe(inc);
        expect(V(t)).toBe(inc);        // ++ mutates the receiver ...
        expect(r).not.toBe(t);         // ... and returns it BY VALUE (a copy)
    });

    test("opPow is D's assert(0) (intrange.d:288)", () => {
        expect(() => N(2n).opPow(N(3n))).toThrow(AssertError);
    });
});

describe("IntRange", () => {
    test("constructor forms: default init, this(a), this(lower, upper), this(IntRange)", () => {
        const d = new IntRange();
        expect(RV(d)).toEqual([0n, 0n]);
        expect(d.imin.negative || d.imax.negative).toBe(false);

        const a = N(-3n);
        const one = new IntRange(a);
        expect(RV(one)).toEqual([-3n, -3n]);
        expect(one.imin).not.toBe(one.imax);   // two independent copies of `a`
        expect(one.imin).not.toBe(a);

        const lo = N(1n), hi = N(9n);
        const two = new IntRange(lo, hi);
        lo.value = 5n;                          // the ctor copied on field store (03 §1 #5)
        expect(RV(two)).toEqual([1n, 9n]);

        const c = IntRange.fromIntRange(two);
        c.imin.value = 7n;
        expect(RV(two)).toEqual([1n, 9n]);
        expect(RV(c)).toEqual([7n, 9n]);

        expect(RV(IntRange.widest())).toEqual([MIN65, MAX65]);
    });

    // ldc2 output: [op, lhs, rhs, result].
    const binary: [RangeBin, bigint[], bigint[], bigint[]][] = [
        ["opAnd", [-1n, 0n], [-1n, 0n], [-1n, 0n]],
        ["opAnd", [0n, 5n], [8n, 9n], [0n, 1n]],
        ["opAnd", [-3n, 5n], [4n, 12n], [0n, 12n]],
        ["opAnd", [4n, 12n], [-3n, 5n], [0n, 12n]],
        ["opAnd", [-8n, -2n], [-5n, -1n], [-8n, -2n]],
        ["opOr", [-1n, 0n], [-1n, 0n], [-1n, 0n]],
        ["opOr", [0n, 5n], [8n, 9n], [8n, 13n]],
        ["opOr", [-3n, 5n], [4n, 12n], [-3n, MAX65]],
        ["opOr", [4n, 12n], [-3n, 5n], [-3n, MAX65]],
        ["opOr", [-8n, -2n], [-5n, -1n], [-5n, -1n]],
        ["opXor", [0n, 5n], [8n, 9n], [8n, 13n]],
        ["opXor", [-3n, 5n], [4n, 12n], [-15n, MAX65]],
        ["opAdd", [1n, 2n], [10n, 20n], [11n, 22n]],
        ["opAdd", [0x7fffffffffffffffn, 0x7fffffffffffffffn], [0x7fffffffffffffffn, 0x7fffffffffffffffn],
            [0xfffffffffffffffen, 0xfffffffffffffffen]],
        ["opSub", [1n, 2n], [10n, 20n], [-19n, -8n]],
        ["opMod", [500n, 1700n], [7n, 23n], [0n, 22n]],
        ["opMod", [-500n, 1700n], [7n, 23n], [-22n, 22n]],
        ["opMod", [-1700n, -500n], [7n, 23n], [-22n, 0n]],
        ["opMod", [-1700n, -500n], [-23n, -7n], [-22n, 0n]],
        ["opDiv", [10n, 20n], [0n, 5n], [2n, 20n]],
        ["opDiv", [10n, 20n], [0n, 0n], [MIN65, MAX65]],
        ["opDiv", [10n, 20n], [2n, 5n], [2n, 10n]],
        ["opShl", [1n, 3n], [2n, 4n], [4n, 48n]],
        ["opShl", [-3n, 1n], [2n, 4n], [-48n, 16n]],
        ["opShl", [1n, 3n], [-1n, 4n], [1n, MAX65]],
        ["opShr", [-16n, 16n], [1n, 2n], [-8n, 8n]],
        ["opShr", [1n, 3n], [-1n, 4n], [0n, 3n]],
        ["opUShr", [-16n, 16n], [1n, 2n], [-4n, 8n]],
    ];
    test.each(binary)("%s(%s, %s) matches ldc2", (op, a, b, r) => {
        const lhs = R(a);
        expect(RV(lhs[op](R(b)))).toEqual(r);
        expect(RV(lhs)).toEqual(a);     // the receiver is never mutated by a binary operator
    });

    test("opDiv mutates its by-value rhs (intrange.d:624/:628): callers owe the copy", () => {
        const rhs = R([0n, 5n]);
        expect(RV(R([10n, 20n]).opDiv(rhs))).toEqual([2n, 20n]);
        expect(RV(rhs)).toEqual([1n, 5n]); // D's callee copy took `rhs.imin.value++`
        const rhs2 = R([-5n, 0n]);         // imax.value == 0 -> `rhs.imax.value--` wraps to ulong.max
        expect(RV(R([10n, 20n]).opDiv(rhs2))).toEqual([-20n, 20n]);   // ldc2
        expect(RV(rhs2)).toEqual([-5n, MAX65]);
    });

    // ldc2 output: [r, -r, ~r, r.absNeg(), r.containsZero()].
    const unary: [bigint[], bigint[], bigint[], bigint[], boolean][] = [
        [[-5n, 7n], [-7n, 5n], [-8n, 4n], [-7n, 0n], true],
        [[-9n, -2n], [2n, 9n], [1n, 8n], [-9n, -2n], false],
        [[3n, 8n], [-8n, -3n], [-9n, -4n], [-8n, -3n], false],
        [[0n, 0n], [0n, 0n], [-1n, -1n], [0n, 0n], true],
        [[MIN65, MAX65], [-0xffffffffffffffffn, MAX65], [0n, MAX65], [MIN65, 0n], true],
    ];
    test.each(unary)("opNeg / opCom / absNeg / containsZero of %s", (r, neg, com, absNeg, zero) => {
        expect(RV(R(r).opNeg())).toEqual(neg);
        expect(RV(R(r).opCom())).toEqual(com);
        const x = R(r);
        const an = x.absNeg();
        expect(RV(an)).toEqual(absNeg);
        an.imin.value = 1234n;                  // absNeg returns a copy even when it returns `this`
        expect(RV(x)).toEqual(r);
        expect(R(r).containsZero()).toBe(zero);
    });

    // ldc2 output: [r, mask, r.castSigned(mask), r.castUnsigned(mask)].
    const casts: [bigint[], bigint, bigint[], bigint[]][] = [
        [[127n, 128n], 0xffn, [-128n, 127n], [127n, 128n]],
        [[384n, 511n], 0xffn, [-128n, -1n], [128n, 255n]],
        [[261n, 263n], 0xffn, [5n, 7n], [5n, 7n]],
        [[261n, 519n], 0xffn, [-128n, 127n], [0n, 255n]],
        [[-1n, 1n], 0xffn, [-1n, 1n], [0n, 255n]],
        [[-1n, 1n], 0xffffffffffffffffn, [-1n, 1n], [0n, MAX65]],
        [[0x7fffffffn, 0x80000000n], 0xffffffffn, [-0x80000000n, 0x7fffffffn], [0x7fffffffn, 0x80000000n]],
        [[-129n, -128n], 0xffn, [-128n, 127n], [127n, 128n]],
        [[0x8000000000000000n, 0x8000000000000001n], 0xffffffffffffffffn,
            [-0x8000000000000000n, -0x7fffffffffffffffn], [0x8000000000000000n, 0x8000000000000001n]],
        [[MIN65, MAX65], 0xffffffffffffffffn, [-0x8000000000000000n, 0x7fffffffffffffffn], [0n, MAX65]],
    ];
    test.each(casts)("castSigned / castUnsigned of %s by mask %s", (r, mask, signed, unsigned) => {
        const a = R(r);
        const ra = a.castSigned(mask);
        expect(RV(ra)).toEqual(signed);
        expect(RV(a)).toEqual(signed);          // mutates the receiver ...
        expect(ra).not.toBe(a);                 // ... and returns it BY VALUE
        const b = R(r);
        const rb = b.castUnsigned(mask);
        expect(RV(rb)).toEqual(unsigned);
        expect(RV(b)).toEqual(unsigned);
        expect(rb).not.toBe(b);
    });

    // ldc2 output: [r, r.castDchar()].
    const dchars: bigint[][][] = [
        [[0x10fffen, 0x110005n], [0x10fffen, 0x10ffffn]],
        [[0x110000n, 0x110001n], [0x10ffffn, 0x10ffffn]],
        [[-1n, 0n], [0n, 0x10ffffn]],
        [[5n, 9n], [5n, 9n]],
    ];
    test.each(dchars)("castDchar of %s", (r, out) => {
        const a = R(r);
        expect(RV(a.castDchar())).toEqual(out);
        expect(RV(a)).toEqual(out);
    });

    // ldc2 output: [r, hasNeg, negRange, hasNonNeg, nonNegRange] (untouched ranges stay default).
    const splits: [bigint[], boolean, bigint[], boolean, bigint[]][] = [
        [[-5n, 7n], true, [-5n, -1n], true, [0n, 7n]],
        [[-9n, -2n], true, [-9n, -2n], false, [0n, 0n]],
        [[3n, 8n], false, [0n, 0n], true, [3n, 8n]],
    ];
    test.each(splits)("splitBySign of %s", (r, hn, n, hnn, nn) => {
        const neg = new IntRange(), nonNeg = new IntRange();
        const hasNeg = { value: !hn }, hasNonNeg = { value: !hnn };  // D writes both flags
        R(r).splitBySign(neg, hasNeg, nonNeg, hasNonNeg);
        expect(hasNeg.value).toBe(hn);
        expect(RV(neg)).toEqual(n);
        expect(hasNonNeg.value).toBe(hnn);
        expect(RV(nonNeg)).toEqual(nn);
    });

    test("contains / unionWith / unionOrAssign", () => {
        expect(R([-5n, 7n]).contains(R([-5n, 7n]))).toBe(true);
        expect(R([-5n, 7n]).contains(R([-6n, 0n]))).toBe(false);
        expect(R([-5n, 7n]).contains(R([0n, 8n]))).toBe(false);
        expect(IntRange.widest().contains(R([MIN65, MAX65]))).toBe(true);
        expect(RV(R([-5n, 1n]).unionWith(R([3n, 9n])))).toEqual([-5n, 9n]);

        const u = new IntRange();
        const flag = { value: false };
        u.unionOrAssign(R([10n, 12n]), flag);   // first call: assigns outright
        expect(flag.value).toBe(true);
        expect(RV(u)).toEqual([10n, 12n]);
        u.unionOrAssign(R([-3n, 11n]), flag);   // then widens
        expect(RV(u)).toEqual([-3n, 12n]);
        const src = R([100n, 200n]);
        u.unionOrAssign(src, flag);
        src.imax.value = 0n;                    // stored bounds are copies
        expect(RV(u)).toEqual([-3n, 200n]);
    });

    test("opPow is D's assert(0) (intrange.d:731)", () => {
        expect(() => R([1n, 2n]).opPow(R([1n, 2n]))).toThrow(AssertError);
    });

    test("dump prints D's printf line (intrange.d:457)", () => {
        const out: string[] = [];
        const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown): boolean => {
            out.push(String(chunk));
            return true;
        });
        const e = { toChars: () => ds("a + b") };
        try {
            const r = R([-5n, 7n]);
            expect(r.dump(ds("fn"), e)).toBe(r);    // `ref` return: the same struct, no copy
            IntRange.widest().dump(ds("widest"), e);
        } finally {
            spy.mockRestore();
        }
        // ldc2 output, byte for byte (`%#018llx` of 0 carries no `0x` prefix, as in C)
        expect(out).toEqual([
            "[(-)0xfffffffffffffffb, (+)0x0000000000000007] @ fn ::: a + b\n",
            "[(-)000000000000000000, (+)0xffffffffffffffff] @ widest ::: a + b\n",
        ]);
    });
});

// ldc2 output: [op, lhs, rhs, result]. These operators go through IntRange.fromNumbers2/4
// (intrange.d:317/:325: D's `SignExtendedNumber*` ported as array + offset).
describe("IntRange opMul and signed opDiv (via fromNumbers4)", () => {
    const rows: ["opMul" | "opDiv", bigint[], bigint[], bigint[]][] = [
        ["opMul", [1n, 2n], [3n, 4n], [3n, 8n]],
        ["opMul", [-3n, 2n], [-5n, 4n], [-12n, 15n]],
        ["opMul", [-8n, -2n], [-5n, -1n], [2n, 40n]],
        ["opMul", [0x100000000n, 0x100000000n], [-0x100000000n, 0x100000000n], [MIN65, MAX65]],
        ["opMul", [MIN65, MAX65], [0n, 0n], [0n, 0n]],
        ["opDiv", [1n, 2n], [-3n, 4n], [-2n, 2n]],          // divisor spans [-1, 0, 1] (intrange.d:635)
        ["opDiv", [-2n, 2n], [3n, 4n], [0n, 0n]],           // negative dividend (intrange.d:641)
        ["opDiv", [-100n, -10n], [-5n, -2n], [2n, 50n]],
        ["opDiv", [10n, 20n], [-5n, 0n], [-20n, 20n]],      // imax == 0 end adjusted, then spanning
        ["opDiv", [-7n, 9n], [-3n, -1n], [-9n, 7n]],
        ["opDiv", [MIN65, 5n], [-1n, -1n], [-5n, MAX65]],
    ];
    test.each(rows)("%s(%s, %s) matches ldc2", (op, a, b, r) => {
        const lhs = R(a);
        expect(RV(lhs[op](R(b)))).toEqual(r);
        expect(RV(lhs)).toEqual(a);
    });

    test("fromNumbers2 reads (numbers[off], numbers[off + 1]); fromNumbers4 spans all four", () => {
        const xs = [N(9n), N(-4n), N(7n), N(-2n)];
        expect(RV(IntRange.fromNumbers2(xs))).toEqual([-4n, 9n]);
        expect(RV(IntRange.fromNumbers2(xs, 2))).toEqual([-2n, 7n]);
        expect(RV(IntRange.fromNumbers4(xs))).toEqual([-4n, 9n]);
        const r = IntRange.fromNumbers4(xs);
        r.imin.value = 0n;                               // the result holds copies, not the elements
        expect(V(xs[1])).toBe(-4n);
    });
});
