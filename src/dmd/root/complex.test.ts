// Tests for the complex_t port (dmd/root/complex.d). Contract: 08-runtime-lib.md §15.2,
// canonical method set from 12-worked-examples.md (c) / 05-operators.md.
//
// All expected values are ldc2-1.42.0 ground truth, probed in /tmp/probe_complex2.d with
// CTFloat.initialize() run first (standalone probes leave the __gshared CTFloat.zero == NaN —
// see ctfloat.d:302/321; the port fixes CTFloat.zero === 0 at 08 §15.1). The precision-sensitive
// division results are bit-exact doubles because `real == double` on this target (_probes.md §6),
// so JS `number` reproduces them exactly. `expect(...).toBe(...)` uses Object.is -> exact bits.

import { describe, it, expect } from "vitest";
import { complex_t, creall, cimagl } from "./complex.js";
import { CTFloat } from "./ctfloat.js";

describe("complex_t construction", () => {
    it("two-arg ctor sets both components", () => {
        const c = new complex_t(3, 4);
        expect(c.re).toBe(3);
        expect(c.im).toBe(4);
    });

    // this(real_t re) (complex.d:27): im defaults to CTFloat.zero. In the port CTFloat.zero === 0
    // (08 §15.1), so complex_t(7) is (7, 0). Verified vs ldc2 (initialize() run): ctor1=(7,0).
    it("single-arg ctor defaults im to CTFloat.zero (== 0)", () => {
        expect(CTFloat.zero).toBe(0); // guards the default-param contract
        const c = new complex_t(7);
        expect(c.re).toBe(7);
        expect(c.im).toBe(0);
    });
});

describe("complex_t arithmetic (ldc2 ground truth, a=(3,4) b=(1,2))", () => {
    const a = new complex_t(3, 4);
    const b = new complex_t(1, 2);

    it("opAdd: a + b = (4, 6)", () => {
        const r = a.opAdd(b);
        expect(r.re).toBe(4);
        expect(r.im).toBe(6);
    });

    it("opSub: a - b = (2, 2)", () => {
        const r = a.opSub(b);
        expect(r.re).toBe(2);
        expect(r.im).toBe(2);
    });

    it("opNeg: -a = (-3, -4)", () => {
        const r = a.opNeg();
        expect(r.re).toBe(-3);
        expect(r.im).toBe(-4);
    });

    it("opMul: a * b = (-5, 10)  [(re*y.re - im*y.im, im*y.re + re*y.im)]", () => {
        const r = a.opMul(b);
        expect(r.re).toBe(-5); // 3*1 - 4*2
        expect(r.im).toBe(10); // 4*1 + 3*2
    });

    // |b.re|=1 < |b.im|=2 -> the FIRST branch of opDiv (complex.d:83). Bit-exact doubles.
    it("opDiv: a / b = (2.2000000000000002, -0.40000000000000002) [|y.re| < |y.im| branch]", () => {
        const r = a.opDiv(b);
        expect(r.re).toBe(2.2000000000000002);
        expect(r.im).toBe(-0.40000000000000002);
    });

    // |b2.re|=3 >= |b2.im|=1 -> the ELSE branch of opDiv (complex.d:89). Exercises the other path.
    it("opDiv: a / (3,1) = (1.2999999999999998, 0.8999999999999999) [|y.re| >= |y.im| branch]", () => {
        const b2 = new complex_t(3, 1);
        const r = a.opDiv(b2);
        expect(r.re).toBe(1.2999999999999998);
        expect(r.im).toBe(0.8999999999999999);
    });
});

describe("complex_t real_t overloads (ldc2 ground truth, a=(3,4))", () => {
    const a = new complex_t(3, 4);

    // opBinary!"*"(real_t) (complex.d:68): complex * real. a * 2 = (6, 8).
    it("opMul_real_t: a * 2 = (6, 8)", () => {
        const r = a.opMul_real_t(2);
        expect(r.re).toBe(6);
        expect(r.im).toBe(8);
    });

    // opBinaryRight!"*"(real_t) (complex.d:62): real * complex (reversed). 2 * a = (6, 8).
    // DISTINCT method from opMul_real_t but the scalar product is identical here.
    it("opMul_r: 2 * a = (6, 8)  (reversed, called on the right operand)", () => {
        const r = a.opMul_r(2);
        expect(r.re).toBe(6);
        expect(r.im).toBe(8);
    });

    // opBinary!"/"(real_t) (complex.d:74): complex / real. a / 2 = (1.5, 2). The real divisor
    // becomes complex_t(2,0); |2| >= |0| -> opDiv ELSE branch, which yields exact (1.5, 2).
    it("opDiv_real_t: a / 2 = (1.5, 2)", () => {
        const r = a.opDiv_real_t(2);
        expect(r.re).toBe(1.5);
        expect(r.im).toBe(2);
    });
});

describe("complex_t opEquals (value equality, NOT reference identity)", () => {
    it("equal components -> true even for distinct instances", () => {
        const a = new complex_t(3, 4);
        expect(a.opEquals(new complex_t(3, 4))).toBe(true);
    });

    it("unequal components -> false", () => {
        const a = new complex_t(3, 4);
        expect(a.opEquals(new complex_t(1, 2))).toBe(false); // eq_other=0 in ldc2 probe
        expect(a.opEquals(new complex_t(3, 5))).toBe(false); // im differs
        expect(a.opEquals(new complex_t(2, 4))).toBe(false); // re differs
    });

    // Bitwise float equality matches D's `==`: NaN != NaN, and +0 == -0.
    it("NaN component -> not equal to itself; +0 equals -0", () => {
        const nanC = new complex_t(NaN, 0);
        expect(nanC.opEquals(new complex_t(NaN, 0))).toBe(false);
        expect(new complex_t(0, 0).opEquals(new complex_t(-0, -0))).toBe(true);
    });
});

describe("complex_t opCastBool (opCast(T:bool), numeric truthiness)", () => {
    // Verified vs ldc2: bool_a=1, bool_zero=0, bool_im=1, bool_re=1.
    it("non-zero either component -> true", () => {
        expect(new complex_t(3, 4).opCastBool()).toBe(true);
        expect(new complex_t(0, 5).opCastBool()).toBe(true); // im-only
        expect(new complex_t(5, 0).opCastBool()).toBe(true); // re-only
    });

    it("both components zero -> false (incl. -0)", () => {
        expect(new complex_t(0, 0).opCastBool()).toBe(false);
        expect(new complex_t(-0, -0).opCastBool()).toBe(false); // -0 !== 0 is false in JS too
    });
});

describe("complex_t copy (value-struct semantics)", () => {
    it("copy() produces an independent equal instance", () => {
        const a = new complex_t(3, 4);
        const c = a.copy();
        expect(c).not.toBe(a); // distinct object
        expect(c.opEquals(a)).toBe(true);
        c.re = 99; // mutating the copy must not touch the original (value semantics)
        expect(a.re).toBe(3);
        expect(c.re).toBe(99);
    });
});

describe("creall / cimagl (free functions, complex.d:108/:113)", () => {
    it("return the real and imaginary parts", () => {
        const a = new complex_t(3, 4);
        expect(creall(a)).toBe(3);
        expect(cimagl(a)).toBe(4);
    });
});
