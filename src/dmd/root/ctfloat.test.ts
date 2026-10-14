import { describe, it, expect } from "vitest";
import { CTFloat } from "./ctfloat.js";
import { ds, dsToJs } from "../../dstring.js";
import { DError } from "../../assert.js";

// Expected values are ldc2 ground truth or follow directly from the verified `real == double` mapping
// (_probes.md §6); see 08 §15.1. The literal-conversion and formatting blocks (isFloat*LiteralOutOfRange,
// parse, sprint) are pinned against ldc2 1.43.0 and say how; the other blocks were probed on ldc2 1.42.0.

describe("CTFloat constants (ctfloat.d:280-289, gen/ctfloat.cpp:65-71)", () => {
    it("zero / one / minusone / half are the literal values initialize() assigns", () => {
        expect(CTFloat.zero).toBe(0);
        expect(CTFloat.one).toBe(1);
        expect(CTFloat.minusone).toBe(-1);
        expect(CTFloat.half).toBe(0.5);
    });

    it("nan is a NaN and infinity is +Infinity (IN_LLVM __gshared constants)", () => {
        expect(Number.isNaN(CTFloat.nan)).toBe(true);
        expect(CTFloat.infinity).toBe(Infinity);
        expect(-CTFloat.infinity).toBe(-Infinity);
    });

    it("nan carries the canonical qNaN bit image (0x7ff8000000000000), matching real_t.nan", () => {
        const dv = new DataView(new ArrayBuffer(8));
        dv.setFloat64(0, CTFloat.nan, true);
        // hi 32 bits = 0x7ff80000, lo = 0 — verified against ldc2 (/tmp/probe3)
        expect(dv.getUint32(4, true) >>> 0).toBe(0x7ff80000);
        expect(dv.getUint32(0, true) >>> 0).toBe(0);
    });

    it("initialize() is a no-op (eager static constants) and is callable", () => {
        expect(() => CTFloat.initialize()).not.toThrow();
        expect(CTFloat.zero).toBe(0); // still intact
    });
});

describe("CTFloat math fns → direct Math.* (resolved: real_t == real, ctfloat.d:108+ else branch)", () => {
    it("trig / sqrt / fabs", () => {
        expect(CTFloat.sin(0)).toBe(0);
        expect(CTFloat.cos(0)).toBe(1);
        expect(CTFloat.tan(0)).toBe(0);
        expect(CTFloat.sqrt(4)).toBe(2);
        expect(CTFloat.fabs(-3)).toBe(3);
        expect(CTFloat.fabs(3)).toBe(3);
    });

    it("ldexp(n, exp) = n * 2^exp (verified ldc2: ldexp(3,4)=48)", () => {
        expect(CTFloat.ldexp(1, 3)).toBe(8);
        expect(CTFloat.ldexp(3, 4)).toBe(48);
        expect(CTFloat.ldexp(1.5, 2)).toBe(6);
    });

    it("logs / pow / exp / exp2 (verified ldc2: pow(2,10)=1024, exp2(0.5)=1.4142135623730951)", () => {
        expect(CTFloat.log2(8)).toBe(3);
        expect(CTFloat.log(1)).toBe(0);
        expect(CTFloat.log10(1000)).toBe(3);
        expect(CTFloat.pow(2, 10)).toBe(1024);
        expect(CTFloat.exp(0)).toBe(1);
        expect(CTFloat.exp2(3)).toBe(8);
        expect(CTFloat.exp2(0.5)).toBe(1.4142135623730951);
        expect(CTFloat.expm1(0)).toBe(0);
    });

    it("floor / ceil / trunc", () => {
        expect(CTFloat.floor(2.7)).toBe(2);
        expect(CTFloat.floor(-2.1)).toBe(-3);
        expect(CTFloat.ceil(2.1)).toBe(3);
        expect(CTFloat.ceil(-2.7)).toBe(-2);
        expect(CTFloat.trunc(-2.7)).toBe(-2);
        expect(CTFloat.trunc(2.7)).toBe(2);
    });

    it("round rounds half AWAY from zero (C roundl), NOT toward +inf like Math.round", () => {
        // ldc2 ground truth: round(2.5)=3, round(-2.5)=-3, round(0.5)=1, round(1.5)=2
        expect(CTFloat.round(2.5)).toBe(3);
        expect(CTFloat.round(-2.5)).toBe(-3); // Math.round(-2.5) would be -2 — wrong for D
        expect(CTFloat.round(0.5)).toBe(1);
        expect(CTFloat.round(1.5)).toBe(2);
        expect(CTFloat.round(2.4)).toBe(2);
        expect(CTFloat.round(-2.4)).toBe(-2);
    });

    it("copysign(x, s) = |x| with sign of s, sign-bit aware incl. ±0", () => {
        // ldc2 ground truth: copysign(3,-1)=-3, copysign(3,1)=3, copysign(-3,1)=3
        expect(CTFloat.copysign(3, -1)).toBe(-3);
        expect(CTFloat.copysign(3, 1)).toBe(3);
        expect(CTFloat.copysign(-3, 1)).toBe(3);
        expect(CTFloat.copysign(-3, -1)).toBe(-3);
        // sign of -0 must be read from the SIGN BIT, not magnitude
        expect(Object.is(CTFloat.copysign(5, -0), -5)).toBe(true);
        expect(Object.is(CTFloat.copysign(5, 0), 5)).toBe(true);
    });
});

describe("CTFloat fmin/fmax/fma — VERBATIM x<y?x:y / x>y?x:y / (x*y)+z (ctfloat.d:125-130)", () => {
    it("fmin/fmax pick by `<`/`>`, NOT Math.min/Math.max", () => {
        expect(CTFloat.fmin(1, 2)).toBe(1);
        expect(CTFloat.fmin(2, 1)).toBe(1);
        expect(CTFloat.fmax(1, 2)).toBe(2);
        expect(CTFloat.fmax(2, 1)).toBe(2);
    });

    it("fmin/fmax with NaN are ASYMMETRIC — verbatim x<y?x:y propagates the false branch (ldc2)", () => {
        // verified ldc2: the result depends on OPERAND ORDER (this is why we keep it verbatim).
        //   fmin(NaN, 1): `NaN < 1` false → returns y (=1).   fmax(NaN, 1): `NaN > 1` false → y (=1).
        //   fmin(1, NaN): `1 < NaN` false → returns y (=NaN). fmax(1, NaN): `1 > NaN` false → NaN.
        // Math.min/Math.max would return NaN for BOTH orders — the substitution would diverge.
        expect(CTFloat.fmin(NaN, 1)).toBe(1);
        expect(CTFloat.fmax(NaN, 1)).toBe(1);
        expect(Number.isNaN(CTFloat.fmin(1, NaN))).toBe(true);
        expect(Number.isNaN(CTFloat.fmax(1, NaN))).toBe(true);
    });

    it("fma is the two-rounding (x*y)+z, NOT a fused single-rounding FMA", () => {
        expect(CTFloat.fma(2, 3, 4)).toBe(10);
        expect(CTFloat.fma(0.5, 0.5, 1)).toBe(1.25);
    });
});

describe("CTFloat.yl2x / yl2xp1 — IN_LLVM generic fallback y*log2(x) (ctfloat.d:53-71)", () => {
    it("support flags are true (x87 OFF, generic log2 fallback ON)", () => {
        expect(CTFloat.yl2x_supported).toBe(true);
        expect(CTFloat.yl2xp1_supported).toBe(true);
    });

    it("yl2x(x,y) = y*log2(x); yl2xp1(x,y) = y*log2(x+1) (verified ldc2: yl2x(8,2)=6, yl2x(4,3)=6)", () => {
        expect(CTFloat.yl2x(8, 2)).toBe(6); // 2 * log2(8) = 2*3
        expect(CTFloat.yl2x(4, 3)).toBe(6); // 3 * log2(4) = 3*2
        expect(CTFloat.yl2xp1(7, 2)).toBe(6); // 2 * log2(8)
        expect(CTFloat.yl2x(2, 1)).toBe(1); // 1 * log2(2)
    });
});

describe("CTFloat.rint/nearbyint — round-to-nearest, ties-to-EVEN (ctfloat.d:143-148)", () => {
    it("matches ldc2 rintl: 2.5→2, 3.5→4, 0.5→0, -2.5→-2, 2.4→2 (banker's rounding)", () => {
        expect(CTFloat.rint(2.5)).toBe(2);
        expect(CTFloat.rint(3.5)).toBe(4);
        expect(CTFloat.rint(0.5)).toBe(0);
        expect(CTFloat.rint(-2.5)).toBe(-2);
        expect(CTFloat.rint(2.4)).toBe(2);
        expect(CTFloat.nearbyint(2.5)).toBe(2);
        expect(CTFloat.nearbyint(1.5)).toBe(2);
    });

    it("llround (half away) and llrint (ties-to-even) return bigint (int64 domain, 09 §1)", () => {
        expect(CTFloat.llround(2.5)).toBe(3n); // round half away from zero
        expect(CTFloat.llround(-2.5)).toBe(-3n);
        expect(CTFloat.llrint(2.5)).toBe(2n); // ties to even
        expect(CTFloat.llrint(3.5)).toBe(4n);
        // arm64 saturation and NaN, pinned against ldc2 1.43.0 CTFE (`pragma(msg, llvm_llround(v), llvm_llrint(v))`).
        const max = (1n << 63n) - 1n, min = -(1n << 63n);
        expect([NaN, Infinity, -Infinity, 1e19, -1e19, 9.3e18].map((v) => CTFloat.llround(v)))
            .toEqual([0n, max, min, max, min, max]);
        expect([NaN, Infinity, -Infinity, 1e19, -1e19, -9.3e18].map((v) => CTFloat.llrint(v)))
            .toEqual([min, max, min, max, min, min]);
    });
});

describe("CTFloat.isNaN / isInfinity (ctfloat.d:175/:204)", () => {
    it("isNaN", () => {
        expect(CTFloat.isNaN(NaN)).toBe(true);
        expect(CTFloat.isNaN(0 / 0)).toBe(true);
        expect(CTFloat.isNaN(1.0)).toBe(false);
        expect(CTFloat.isNaN(Infinity)).toBe(false);
    });

    it("isInfinity is true for BOTH ±inf (fabs strips sign), false for NaN/finite", () => {
        // verified ldc2: isInfinity(+inf)=isInfinity(-inf)=1, isInfinity(1.0)=isInfinity(nan)=0
        expect(CTFloat.isInfinity(Infinity)).toBe(true);
        expect(CTFloat.isInfinity(-Infinity)).toBe(true);
        expect(CTFloat.isInfinity(1.0)).toBe(false);
        expect(CTFloat.isInfinity(NaN)).toBe(false);
        expect(CTFloat.isInfinity(0)).toBe(false);
    });
});

describe("CTFloat.isIdentical — BITWISE identity, NOT == (ctfloat.d:155, memcmp of 8 bytes)", () => {
    it("same bits are identical (incl. NaN-with-same-bits) — verified ldc2", () => {
        expect(CTFloat.isIdentical(1.0, 1.0)).toBe(true);
        expect(CTFloat.isIdentical(0.0, 0.0)).toBe(true);
        expect(CTFloat.isIdentical(NaN, NaN)).toBe(true); // same bits → identical (unlike ==)
    });

    it("+0.0 and -0.0 are NOT identical (sign bit differs) — verified ldc2 (=0)", () => {
        expect(CTFloat.isIdentical(0.0, -0.0)).toBe(false);
        expect(CTFloat.isIdentical(-0.0, 0.0)).toBe(false);
    });

    it("differs from == on the two trap cases", () => {
        const eq = (a: number, b: number): boolean => a === b; // avoid TS const-folding the compare
        // 0.0 == -0.0 is true, but isIdentical is false (bitwise)
        expect(eq(0.0, -0.0)).toBe(true);
        expect(CTFloat.isIdentical(0.0, -0.0)).toBe(false);
        // NaN == NaN is false, but isIdentical(NaN,NaN) is true (same bits)
        expect(eq(NaN, NaN)).toBe(false);
        expect(CTFloat.isIdentical(NaN, NaN)).toBe(true);
    });

    it("distinct finite values are not identical", () => {
        expect(CTFloat.isIdentical(1.0, 2.0)).toBe(false);
        expect(CTFloat.isIdentical(Infinity, -Infinity)).toBe(false);
    });
});

describe("CTFloat.hash — MurmurHash2 of the 8 raw bytes, NaN-canonicalized (ctfloat.d:163)", () => {
    it("reproduces ldc2 hash values bit-for-bit (verified /tmp/probe3 + /tmp/jsverify.mjs)", () => {
        expect(CTFloat.hash(1.0)).toBe(2015398733);
        expect(CTFloat.hash(2.0)).toBe(3262971025);
        expect(CTFloat.hash(0.0)).toBe(2477863612);
        expect(CTFloat.hash(-0.0)).toBe(986614415); // distinct from +0.0 (different sign bit)
    });

    it("+0.0 and -0.0 hash DIFFERENTLY (bitwise hash, like isIdentical)", () => {
        expect(CTFloat.hash(0.0)).not.toBe(CTFloat.hash(-0.0));
    });

    it("all NaNs hash EQUALLY (canonicalized to qNaN before hashing) — verified 1272885895", () => {
        expect(CTFloat.hash(NaN)).toBe(1272885895);
        expect(CTFloat.hash(-NaN)).toBe(1272885895);
        expect(CTFloat.hash(0 / 0)).toBe(1272885895);
        expect(CTFloat.hash(NaN)).toBe(CTFloat.hash(-NaN));
    });

    it("returns an unsigned 32-bit number", () => {
        const h = CTFloat.hash(123.456);
        expect(Number.isInteger(h)).toBe(true);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(0xffffffff);
    });
});

/// The bit image of a double, as a 16-digit hex string (the `%016llx` the ldc2 probes print).
function bitsOf(x: number): string {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, x, true);
    return dv.getBigUint64(0, true).toString(16).padStart(16, "0");
}

const sprint = (fmt: "g" | "a" | "A", x: number): string => dsToJs(CTFloat.sprint(fmt, x));

// Ground truth for the three blocks below: ldc2 1.43.0 (arm64-apple-darwin). Range verdicts are the lexer's
// "number `…` is not representable as a `double`/`float`" errors on `enum a = <literal>;`; values are the bit
// images `ldc2 -run` prints for the literals; `g` strings are `pragma(msg, <literal>)` output (hdrgen's
// floatToBuffer, which prints `sprint('g')`); positive `A` strings are read back from `S!(<value>).mangleof`
// for `struct S(real d) {}` (realToMangleBuffer, mangle/package.d:1290, drops the first two characters, `.`
// and `+`). -0.0 is the one negative value mangling formats with its sign: `-0X0P+0` loses `-0`, so
// `S!(-0.0)` mangles as `X0P0`. Other negative `A`/`a` strings cannot be observed in ldc2 output, because
// realToMangleBuffer negates before formatting and hdrgen prints negatives as `-(…)` or decimal; they follow
// LLVM `convertToHexString`, which writes `-` before the magnitude.

describe("CTFloat.isFloat32/64LiteralOutOfRange — APFloat overflow|underflow (gen/ctfloat.cpp:118-128)", () => {
    const f64 = (s: string): boolean => CTFloat.isFloat64LiteralOutOfRange(ds(s));
    const f32 = (s: string): boolean => CTFloat.isFloat32LiteralOutOfRange(ds(s));

    it("double overflow: past the largest double after half-even rounding, decimal and hex", () => {
        expect(f64("1e308")).toBe(false);
        expect(f64("1e309")).toBe(true);
        expect(f64("1.7976931348623158e308")).toBe(false);
        expect(f64("1.7976931348623159e308")).toBe(true);
        expect(f64("0x1p2000")).toBe(true);
        expect(f64("0x1p1024")).toBe(true);
        expect(f64("0x1.fffffffffffff8p1023")).toBe(true); // tie, rounds to even = up
        expect(f64("0x1.fffffffffffff7p1023")).toBe(false);
        expect(f64("1e99999999999")).toBe(true);
    });

    it("double underflow: any inexact result that is subnormal or zero after rounding", () => {
        expect(f64("1e-400")).toBe(true);
        expect(f64("1e-320")).toBe(true); // inexact subnormal
        expect(f64("0x1p-1074")).toBe(false); // exact subnormal
        expect(f64("0x1p-1075")).toBe(true);
        expect(f64("0x1.8p-1075")).toBe(true);
        expect(f64("2.2250738585072011e-308")).toBe(true);
        expect(f64("2.2250738585072012e-308")).toBe(false); // rounds up to double.min_normal
        expect(f64("0x0.fffffffffffff8p-1022")).toBe(false); // likewise
        expect(f64("1e-99999999999")).toBe(true);
    });

    it("APFloat's exponent limits: out of range whenever a hex exponent saturates, whatever the digits", () => {
        // hex: |written| > 32767, or the digit adjustment (which depends on the precision) or the sum leaves
        // [-32768, 32767]; the exponent becomes 32767 or -32768 by the written sign alone.
        const z = (n: number): string => "0".repeat(n);
        expect(f64(`0x0.${z(8200)}1p32800`)).toBe(true); // true value 2^-4
        expect(f64(`0x1${z(8200)}p-32800`)).toBe(true); // true value 1
        expect(f64(`0x1${z(8199)}p-32767`)).toBe(true); // adjustment 32788: 0, true value 2^33
        expect(f64(`0x0.${z(8189)}1p32767`)).toBe(false); // adjustment -32768, sum -1: exact 128
        expect(f32(`0x0.${z(8189)}1p32767`)).toBe(true); // at single precision the adjustment is -32797
        expect(f64(`0x0.${z(8189)}1p32768`)).toBe(true);
        expect(f64(`0x0.${z(8190)}1p32767`)).toBe(true); // adjustment -32772: inf, true value 8
        // decimal: the written exponent is read up to ±24000 only, the digits then adjust it
        expect(f64(`0.${z(24010)}1e24020`)).toBe(false);
        expect(f64(`1${z(24010)}e-24020`)).toBe(false);
    });

    it("float: the same rules at IEEE single, rounded directly from the literal", () => {
        expect(f32("3.4e38")).toBe(false);
        expect(f32("3.4028235e38")).toBe(false);
        expect(f32("3.4028236e38")).toBe(true);
        expect(f32("3.5e38")).toBe(true);
        expect(f32("0x1.ffffffp127")).toBe(true);
        expect(f32("0x1.fffffe8p127")).toBe(false);
        expect(f32("1e-50")).toBe(true);
        expect(f32("1e-40")).toBe(true);
        expect(f32("1.1754942e-38")).toBe(true);
        expect(f32("0x1p-126")).toBe(false);
        expect(f32("0x1p-149")).toBe(false);
        expect(f32("0x1p-150")).toBe(true);
        expect(f32("0x1.000001p0")).toBe(false); // inexact but normal
        expect(f32("1e-320")).toBe(true);
    });

    it("zero is never out of range, whatever its exponent", () => {
        expect(f32("0")).toBe(false);
        expect(f64("0.0")).toBe(false);
        expect(f64("0x0p99999999999")).toBe(false);
        expect(f64("0e99999999999")).toBe(false);
    });
});

describe("CTFloat.parse — correctly rounded decimal and hex-float literals (gen/ctfloat.cpp:113-116)", () => {
    const bits = (s: string): string => bitsOf(CTFloat.parse(ds(s)).value);

    it("decimal literals", () => {
        expect(CTFloat.parse(ds("1.5"))).toEqual({ value: 1.5, isOutOfRange: false });
        expect(CTFloat.parse(ds("100.0"))).toEqual({ value: 100, isOutOfRange: false });
        expect(bits("0.1")).toBe("3fb999999999999a");
        expect(bits("1e23")).toBe("44b52d02c7e14af6");
        expect(bits("1000.5e-2")).toBe("4024028f5c28f5c3"); // `1_000.5e-2` once the lexer drops `_`
        expect(bits("8.98846567431158e307")).toBe("7fe0000000000000");
        expect(bits("9007199254740993.0")).toBe("4340000000000000"); // 2^53 + 1: tie to even, down
        expect(bits("9007199254740995.0")).toBe("4340000000000002"); // 2^53 + 3: tie to even, up
        expect(bits("2.4703282292062327e-324")).toBe("0000000000000000");
        expect(bits("2.4703282292062328e-324")).toBe("0000000000000001");
        const z = (n: number): string => "0".repeat(n);
        expect(bits(`0.${z(24010)}1e24020`)).toBe("3da5fd7fe1796495"); // exponent read as 24000: 1e-11
        expect(bits(`1${z(24010)}e-24020`)).toBe("4202a05f20000000"); // exponent read as -24000: 1e10
        expect(bits(`0.${z(23999)}1e24001`)).toBe("3ff0000000000000"); // 1, as `e24000`, not 10
        expect(bits(`0.${z(23999)}1e23999`)).toBe("3fb999999999999a");
        expect(bits(".5")).toBe(bitsOf(0.5));
        expect(bits("5.")).toBe(bitsOf(5));
    });

    it("hex-float literals, built from the exact mantissa, never through a decimal string", () => {
        expect(CTFloat.parse(ds("0x1p-1"))).toEqual({ value: 0.5, isOutOfRange: false });
        expect(bits("0x1.00000000000008p0")).toBe("3ff0000000000000"); // tie, even: down
        expect(bits("0x1.00000000000018p0")).toBe("3ff0000000000002"); // tie, odd: up
        expect(bits("0x1.000000000000081p0")).toBe("3ff0000000000001"); // just above the tie
        expect(bits("0x1.8p-1074")).toBe("0000000000000002");
        expect(bits("0x1p-1075")).toBe("0000000000000000");
        expect(bits("0x1.0000000000000000000000001p-1075")).toBe("0000000000000001");
        expect(bits("0x.8p1")).toBe("3ff0000000000000");
        expect(bits("0xA.Bp0")).toBe("4025600000000000");
        expect(bits("0x1P+3")).toBe("4020000000000000");
        expect(bits("0x10p0")).toBe("4030000000000000");
        expect(bits("0x1.fffffffffffff7ffffp1023")).toBe("7fefffffffffffff");
        const z = (n: number): string => "0".repeat(n);
        expect(bits(`0x0.${z(8189)}1p32767`)).toBe("4060000000000000"); // 128, under APFloat's exponent limit
        expect(bits(`0x0.${z(8189)}1p32768`)).toBe("7ff0000000000000"); // saturated: inf, not 256
        expect(bits(`0x1${z(8200)}p-32800`)).toBe("0000000000000000"); // saturated: 0, not 1
        expect(bits(`-0x0.${z(8200)}1p32800`)).toBe("fff0000000000000");
        const big = CTFloat.parse(ds("-0X1P2000"));
        expect(big.value).toBe(-Infinity);
        expect(big.isOutOfRange).toBe(true);
    });

    it("reads back hdrgen's own sprint('g') output, signs and specials included", () => {
        expect(CTFloat.parse(ds("-0.0")).value).toBe(-0);
        expect(Object.is(CTFloat.parse(ds("-0.0")).value, -0)).toBe(true);
        expect(CTFloat.parse(ds("1e+06")).value).toBe(1e6);
        expect(CTFloat.parse(ds("inf"))).toEqual({ value: Infinity, isOutOfRange: false });
        expect(CTFloat.parse(ds("-inf")).value).toBe(-Infinity);
        expect(Number.isNaN(CTFloat.parse(ds("nan")).value)).toBe(true);
        expect(bitsOf(CTFloat.parse(ds("-nan")).value)).toBe("fff8000000000000");
    });

    it("refuses what APFloat would abort on (llvm::cantFail), loudly", () => {
        expect(() => CTFloat.parse(ds("0x1.8"))).toThrow(DError); // hex float without exponent
        expect(() => CTFloat.parse(ds("1e"))).toThrow(DError);
        expect(() => CTFloat.parse(ds("snan"))).toThrow(DError);
    });
});

describe("CTFloat.sprint — ldc2's C %Lg and LLVM hex-float output (gen/ctfloat.cpp:132-228)", () => {
    it("'g': six significant digits, %g layout, `.0` on an all-digit result", () => {
        const cases: [number, string][] = [
            [1.0, "1.0"], [-0.0, "-0.0"], [0.0, "0.0"], [0.1, "0.1"], [2.5, "2.5"], [3.0, "3.0"],
            [100000.0, "100000.0"], [123456.0, "123456.0"], [999999.0, "999999.0"], [1000000.0, "1e+06"],
            [1234567.0, "1.23457e+06"], [0.0001, "0.0001"], [0.00001, "1e-05"], [0.000123456789, "0.000123457"],
            [1 / 3, "0.333333"], [123.456, "123.456"], [1e-300, "1e-300"], [1e10, "1e+10"], [1e16, "1e+16"],
            [1e22, "1e+22"], [1e23, "1e+23"], [1e100, "1e+100"], [9.5e-5, "9.5e-05"], [0.00009999995, "0.0001"],
            [Number.MAX_VALUE, "1.79769e+308"], [2.2250738585072014e-308, "2.22507e-308"],
            [5e-324, "4.94066e-324"], [1e-320, "9.99989e-321"], [-1.5, "-1.5"],
        ];
        for (const [x, s] of cases)
            expect(sprint("g", x), String(x)).toBe(s);
    });

    it("'g': exact half-even rounding of the binary value", () => {
        const cases: [number, string][] = [
            [1234565.0, "1.23456e+06"], [1234575.0, "1.23458e+06"], [1999995.0, "2e+06"], [9999995.0, "1e+07"],
            [9999994.0, "9.99999e+06"], [9999996.0, "1e+07"], [999999.5, "1e+06"], [999998.5, "999998.0"],
            [1024.125, "1024.12"], [1024.375, "1024.38"], [1000000.5, "1e+06"], [12345678.0, "1.23457e+07"],
        ];
        for (const [x, s] of cases)
            expect(sprint("g", x), String(x)).toBe(s);
    });

    it("'g': macOS dtoa keeps trailing zeros when an integer below 1e15 ties and rounds down", () => {
        const cases: [number, string][] = [
            [1000005.0, "1.00000e+06"], [3000005.0, "3.00000e+06"], [1000005000.0, "1.00000e+09"],
            [100000500000000.0, "1.00000e+14"], [1000015.0, "1.00002e+06"],
            // not a tie, or not in dtoa's small-integer path: trimmed
            [1000001.0, "1e+06"], [1200001.0, "1.2e+06"], [-1000001.0, "-1e+06"], [10000001.0, "1e+07"],
            [1234560.0, "1.23456e+06"], [12345600.0, "1.23456e+07"], [100000000000001.0, "1e+14"],
            [1000005000000000.0, "1e+15"], [10000050000000000.0, "1e+16"], [1e21, "1e+21"],
        ];
        for (const [x, s] of cases)
            expect(sprint("g", x), String(x)).toBe(s);
    });

    it("nan and inf, with their sign (lowercase for 'g' and 'a', uppercase for 'A')", () => {
        expect(sprint("g", Infinity)).toBe("inf");
        expect(sprint("g", -Infinity)).toBe("-inf");
        expect(sprint("g", NaN)).toBe("nan");
        expect(sprint("g", CTFloat.parse(ds("-nan")).value)).toBe("-nan");
        expect(sprint("a", -Infinity)).toBe("-inf");
        expect(sprint("A", Infinity)).toBe("INF");
        expect(sprint("A", NaN)).toBe("NAN");
    });

    it("'A': APFloat hex digits with LDC's `+` exponent (read back from template mangling)", () => {
        const cases: [number, string][] = [
            [1.5, "0X1.8P+0"], [-1.5, "-0X1.8P+0"], [0.0, "0X0P+0"], [-0.0, "-0X0P+0"], [1.0, "0X1P+0"],
            [0.1, "0X1.999999999999AP-4"], [Number.MAX_VALUE, "0X1.FFFFFFFFFFFFFP+1023"],
            [5e-324, "0X0.0000000000001P-1022"], [CTFloat.parse(ds("0x1.8p-1070")).value, "0X0.0000000000018P-1022"],
            [2.2250738585072014e-308, "0X1P-1022"], [1024.0, "0X1P+10"], [0.5, "0X1P-1"], [255.0, "0X1.FEP+7"],
        ];
        for (const [x, s] of cases)
            expect(sprint("A", x), String(x)).toBe(s);
    });

    it("'a': the same digits in lowercase", () => {
        expect(sprint("a", 3.0)).toBe("0x1.8p+1");
        expect(sprint("a", 1 / 3)).toBe("0x1.5555555555555p-2");
        expect(sprint("a", -0.1)).toBe("-0x1.999999999999ap-4");
        expect(sprint("a", 5e-324)).toBe("0x0.0000000000001p-1022");
        expect(sprint("a", 1000005.0)).toBe("0x1.e848ap+19"); // ldc2 -H: `enum g = 1000005.0;`
    });
});

describe("CTFloat precision invariant (09-numerics.md §6.1) — NO f32 rounding", () => {
    it("keeps full double precision; never f32-rounds (Math.fround must NOT appear)", () => {
        // 16777217 is not representable in f32 (would round to 16777216). The folder keeps it.
        expect(CTFloat.fabs(16777217)).toBe(16777217);
        // 0.1 + 0.2 folds to the exact double result, bit-identical to runtime (_probes.md §6)
        expect(0.1 + 0.2).toBe(0.30000000000000004);
    });
});
