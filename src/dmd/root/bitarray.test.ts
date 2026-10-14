import { describe, it, expect } from "vitest";
import { BitArray } from "./bitarray.js";
import { DError } from "../../assert.js";

// Behavior VERIFIED against ldc2-1.42.0 (DMD v2.112.1) via /tmp probes (08 §4). The cases
// below mirror the bitarray.d:157-189 unittest plus the 32-bit-word boundary cases that the
// Uint32Array representation must get right (D uses 64-bit chunks; we must match bit-for-bit).

describe("BitArray — bitarray.d:157 unittest (set / get / length)", () => {
    it("reads a fresh bit as 0, sets it, clears it; length is stable", () => {
        const array = new BitArray();
        array.length = 20;
        expect(array.opIndex(19)).toBe(false); // array[19] == 0
        array.opIndexAssign(true, 10); // array[10] = 1
        expect(array.opIndex(10)).toBe(true);
        array.opIndexAssign(false, 10); // array[10] = 0
        expect(array.opIndex(10)).toBe(false);
        expect(array.length).toBe(20);
    });

    it("reproduces the full equals / isZero / swap / opAssign unittest flow", () => {
        const array = new BitArray();
        array.length = 20;

        const a = new BitArray();
        const b = new BitArray();
        expect(a.opEquals(array)).toBe(false); // a != array (0 vs 20 bits)
        a.length = 200;
        expect(a.opEquals(array)).toBe(false); // a != array (200 vs 20)
        expect(a.isZero()).toBe(true);
        a.opIndexAssign(true, 100); // a[100] = true
        b.length = 200;
        b.opIndexAssign(true, 100); // b[100] = true
        expect(a.opEquals(b)).toBe(true); // a == b

        a.length = 300;
        b.length = 300;
        expect(a.opEquals(b)).toBe(true);
        b.opIndexAssign(true, 299); // b[299] = true
        expect(a.opEquals(b)).toBe(false); // a != b
        expect(a.isZero()).toBe(false); // a still has bit 100

        a.swap(b);
        expect(a.opIndex(299)).toBe(true); // a now holds b's bit 299
        expect(b.opIndex(299)).toBe(false);

        a.opAssign(b); // a = b
        expect(a.opEquals(b)).toBe(true);
    });
});

describe("BitArray — opEquals contract", () => {
    it("differing lengths are never equal even when all bits are zero", () => {
        const a = new BitArray();
        const b = new BitArray();
        a.length = 64;
        b.length = 96;
        expect(a.opEquals(b)).toBe(false);
        expect(b.opEquals(a)).toBe(false);
    });

    it("two empty BitArrays are equal", () => {
        expect(new BitArray().opEquals(new BitArray())).toBe(true);
    });

    it("equal length, equal bits → equal; one differing bit → not equal", () => {
        const a = new BitArray();
        const b = new BitArray();
        a.length = 70;
        b.length = 70;
        a.opIndexAssign(true, 3);
        a.opIndexAssign(true, 64);
        b.opIndexAssign(true, 3);
        b.opIndexAssign(true, 64);
        expect(a.opEquals(b)).toBe(true);
        b.opIndexAssign(true, 65);
        expect(a.opEquals(b)).toBe(false);
    });
});

describe("BitArray — 32-bit word boundaries (Uint32Array representation)", () => {
    it("sets and reads bits straddling word boundaries (31, 32, 63)", () => {
        const b = new BitArray();
        b.length = 64;
        b.opIndexAssign(true, 31);
        b.opIndexAssign(true, 32);
        b.opIndexAssign(true, 63);
        expect(b.opIndex(31)).toBe(true);
        expect(b.opIndex(32)).toBe(true);
        expect(b.opIndex(63)).toBe(true);
        expect(b.isZero()).toBe(false);
    });

    it("handles bit 31 (the 1<<31 sign-bit slot) correctly", () => {
        const b = new BitArray();
        b.length = 32;
        b.opIndexAssign(true, 31);
        expect(b.opIndex(31)).toBe(true);
        expect(b.isZero()).toBe(false);
        b.opIndexAssign(false, 31);
        expect(b.opIndex(31)).toBe(false);
        expect(b.isZero()).toBe(true);
    });
});

describe("BitArray — length setter: tail masking on shrink (08 §4, bitarray.d:42)", () => {
    it("shrinking masks away bits beyond the new length (probe c: 64→33)", () => {
        const c = new BitArray();
        c.length = 64;
        c.opIndexAssign(true, 40); // bit 40 lives in word 1
        c.length = 33; // bit 40 now out of range; tail word keeps only bit 32
        expect(c.length).toBe(33);
        expect(c.isZero()).toBe(true); // VERIFIED: ldc2 isZero=1
    });

    it("the masked-away bit reads 0 after regrow (new words are zeroed)", () => {
        const c = new BitArray();
        c.length = 64;
        c.opIndexAssign(true, 40);
        c.length = 33;
        c.length = 64;
        expect(c.opIndex(40)).toBe(false); // VERIFIED: ldc2 c[40] after regrow = 0
    });

    it("bit exactly at the new boundary (index 31, shrink to 31) is masked away", () => {
        const a = new BitArray();
        a.length = 64;
        a.opIndexAssign(true, 31);
        a.length = 31; // keeps bits [0,31); index 31 excluded
        expect(a.isZero()).toBe(true); // VERIFIED: ldc2 isZero=1
    });

    it("bit just inside the new boundary (index 30, shrink to 31) is kept", () => {
        const b = new BitArray();
        b.length = 64;
        b.opIndexAssign(true, 30);
        b.length = 31;
        expect(b.isZero()).toBe(false);
        expect(b.opIndex(30)).toBe(true); // VERIFIED: ldc2 b[30]=1
    });

    it("shrink to an exact word multiple keeps the highest in-range bit (index 31, shrink to 32)", () => {
        const c = new BitArray();
        c.length = 64;
        c.opIndexAssign(true, 31);
        c.length = 32;
        expect(c.isZero()).toBe(false);
        expect(c.opIndex(31)).toBe(true); // VERIFIED: ldc2 c[31]=1
    });
});

describe("BitArray — length setter: growth zeroes new bits (bitarray.d:40)", () => {
    it("growing leaves all newly added bits at 0 while preserving old bits (probe d: 8→40)", () => {
        const d = new BitArray();
        d.length = 8;
        d.opIndexAssign(true, 5);
        d.length = 40;
        expect(d.opIndex(5)).toBe(true);
        for (let k = 8; k < 40; k++) expect(d.opIndex(k)).toBe(false); // VERIFIED: anyNew=0
    });
});

describe("BitArray — opAssign (bitarray.d:46, the size-to-b-if-empty quirk)", () => {
    it("assigning into an EMPTY BitArray adopts b's length and copies its bits (probe d)", () => {
        const d = new BitArray();
        const e = new BitArray();
        e.length = 10;
        e.opIndexAssign(true, 5);
        d.opAssign(e); // d empty → adopts len 10, copies bits
        expect(d.length).toBe(10);
        expect(d.opIndex(5)).toBe(true); // VERIFIED: d[5]=1
        expect(d.opEquals(e)).toBe(true); // VERIFIED: eq=1
    });

    it("assigning into a same-length BitArray copies bits", () => {
        const a = new BitArray();
        const b = new BitArray();
        a.length = 64;
        b.length = 64;
        b.opIndexAssign(true, 7);
        b.opIndexAssign(true, 33);
        a.opAssign(b);
        expect(a.opEquals(b)).toBe(true);
        expect(a.opIndex(7)).toBe(true);
        expect(a.opIndex(33)).toBe(true);
    });

    it("assigning a non-empty BitArray of a different length asserts (length mismatch)", () => {
        const a = new BitArray();
        const b = new BitArray();
        a.length = 32;
        b.length = 64;
        expect(() => a.opAssign(b)).toThrow(DError);
    });
});

describe("BitArray — zero / isZero / or / swap", () => {
    it("zero() clears every set bit (probe z: 100 bits, bit 50)", () => {
        const z = new BitArray();
        z.length = 100;
        z.opIndexAssign(true, 50);
        z.zero();
        expect(z.opIndex(50)).toBe(false); // VERIFIED: z[50]=0
        expect(z.isZero()).toBe(true); // VERIFIED: isZero=1
    });

    it("or() unions bits in place (probe f/g)", () => {
        const f = new BitArray();
        const g = new BitArray();
        f.length = 64;
        g.length = 64;
        f.opIndexAssign(true, 1);
        g.opIndexAssign(true, 2);
        f.or(g);
        expect(f.opIndex(1)).toBe(true); // VERIFIED: f1=1
        expect(f.opIndex(2)).toBe(true); // VERIFIED: f2=1
    });

    it("or() asserts on a length mismatch", () => {
        const f = new BitArray();
        const g = new BitArray();
        f.length = 32;
        g.length = 64;
        expect(() => f.or(g)).toThrow(DError);
    });

    it("swap() exchanges contents in place (probe h/i: 8 bits)", () => {
        const h = new BitArray();
        const i = new BitArray();
        h.length = 8;
        i.length = 8;
        h.opIndexAssign(true, 0);
        i.opIndexAssign(true, 7);
        h.swap(i);
        expect(h.opIndex(0)).toBe(false); // VERIFIED: h0=0
        expect(h.opIndex(7)).toBe(true); // VERIFIED: h7=1
        expect(i.opIndex(0)).toBe(true); // VERIFIED: i0=1
        expect(i.opIndex(7)).toBe(false); // VERIFIED: i7=0
    });

    it("swap() asserts on a length mismatch", () => {
        const h = new BitArray();
        const i = new BitArray();
        h.length = 8;
        i.length = 16;
        expect(() => h.swap(i)).toThrow(DError);
    });
});

describe("BitArray — opIndex / opIndexAssign bounds asserts (bitarray.d:58, :66)", () => {
    it("opIndex out of range asserts (idx >= len)", () => {
        const a = new BitArray();
        a.length = 20;
        expect(() => a.opIndex(20)).toThrow(DError);
    });

    it("opIndexAssign out of range asserts (idx >= len)", () => {
        const a = new BitArray();
        a.length = 20;
        expect(() => a.opIndexAssign(true, 20)).toThrow(DError);
    });

    it("any index into an empty BitArray asserts", () => {
        const a = new BitArray();
        expect(() => a.opIndex(0)).toThrow(DError);
    });
});
