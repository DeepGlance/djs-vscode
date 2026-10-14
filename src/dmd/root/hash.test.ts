import { describe, it, expect } from "vitest";
import { calcHash, mixHash, hashOf } from "./hash.js";
import { ds } from "../../dstring.js";

// Every expected value below was VERIFIED bit-for-bit against ldc2-1.42.0 (the local DMD-2.112.1
// frontend), by running the literal hash.d bodies and printing the results. See 08 §9. Treat these
// numbers as ground truth — a divergence here is a real parity break, not a flaky test.

describe("calcHash — 32-bit MurmurHash2 (hash.d:23, 08 §9)", () => {
    it("matches all four hash.d:67-70 unittest values", () => {
        // char[10] data = "0123456789"; assert(calcHash(data[i..$]) == ...)
        expect(calcHash(ds("0123456789"))).toBe(439272720); // hash.d:67
        expect(calcHash(ds("123456789"))).toBe(3704291687); // hash.d:68
        expect(calcHash(ds("23456789"))).toBe(2125368748); // hash.d:69
        expect(calcHash(ds("3456789"))).toBe(3631432225); // hash.d:70
    });

    it("matches the 08 §9 probed values", () => {
        expect(calcHash(ds("foo"))).toBe(2414502773);
        expect(calcHash(ds(""))).toBe(0);
    });

    it("covers every tail length 0..3 and the 4-byte body loop (ldc2-probed)", () => {
        // Each input exercises a distinct tail case after the 4-byte body: lengths 1..7 hit tail
        // 1/2/3 with and without a full body iteration; values pinned from ldc2.
        expect(calcHash(ds("a"))).toBe(2456313694); // tail 1, no body
        expect(calcHash(ds("ab"))).toBe(446775395); // tail 2, no body
        expect(calcHash(ds("abc"))).toBe(324500635); // tail 3, no body
        expect(calcHash(ds("abcd"))).toBe(646393889); // one body iter, tail 0
        expect(calcHash(ds("abcde"))).toBe(1594468574); // one body iter, tail 1
        expect(calcHash(ds("abcdefg"))).toBe(4188131059); // one body iter, tail 3
    });

    it("reads bytes (not chars) — length is byte count, value depends on raw bytes", () => {
        // A non-ASCII byte must NOT be decoded; calcHash sees the byte values directly.
        const bytes = new Uint8Array([0xc3, 0xa9, 0x00, 0xff]); // arbitrary 4 bytes incl NUL and 0xFF
        const h = calcHash(bytes);
        expect(h).toBe(calcHash(bytes.slice())); // deterministic on an independent copy
        expect(h >>> 0).toBe(h); // unsigned 32-bit
    });

    it("returns an unsigned 32-bit integer for any input", () => {
        for (let n = 0; n <= 12; n++) {
            const bytes = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 0xff);
            const h = calcHash(bytes);
            expect(Number.isInteger(h)).toBe(true);
            expect(h).toBeGreaterThanOrEqual(0);
            expect(h).toBeLessThanOrEqual(0xffffffff);
            expect(h >>> 0).toBe(h);
        }
    });

    it("does not mutate or consume its input", () => {
        const bytes = ds("0123456789");
        const before = bytes.slice();
        calcHash(bytes);
        expect(Array.from(bytes)).toEqual(Array.from(before));
    });
});

describe("mixHash — 64-bit boost::hash_combine in the bigint domain (hash.d:74, 08 §9)", () => {
    it("reproduces the 08 §9 probed value (full 64-bit; target size_t is 64-bit)", () => {
        // ldc2: mixHash(0xDE001540, 0xF5711A47) full size_t == 247315954704.
        expect(mixHash(0xde001540n, 0xf5711a47n)).toBe(247315954704n);
    });

    it("is consistent with the hash.d:82 unittest (low 32 bits == 0x952DFC10)", () => {
        // The hash.d unittest masks to uint.max because it targets 32-bit size_t; our 64-bit full
        // value's low 32 bits must equal that constant. (0x952DFC10 == 2502556688.)
        const full = mixHash(0xde001540n, 0xf5711a47n);
        expect(full & 0xffffffffn).toBe(0x952dfc10n);
    });

    it("handles high bits / 64-bit shift overflow (ldc2-probed)", () => {
        // h has bit 63 set, so `h << 6` overflows out of 64 bits and the `& M` drop is load-bearing.
        // ldc2: mixHash(0x8000000000001234, 0x100000000000ABCD) == 12682136553330091303.
        expect(mixHash(0x8000000000001234n, 0x100000000000abcdn)).toBe(12682136553330091303n);
    });

    it("mixHash(0, 0) == 0x9e3779b9 (the golden-ratio constant alone)", () => {
        // ldc2: mixHash(0,0) == 2654435769 == 0x9e3779b9.
        expect(mixHash(0n, 0n)).toBe(2654435769n);
    });

    it("always stays within 64 bits (masked result)", () => {
        const samples: Array<[bigint, bigint]> = [
            [0n, 0n],
            [(1n << 64n) - 1n, (1n << 64n) - 1n],
            [(1n << 63n) | 0x1234n, (1n << 60n) | 0xabcdn],
            [0xdeadbeefcafef00dn, 0x0123456789abcdefn],
        ];
        for (const [h, k] of samples) {
            const r = mixHash(h, k);
            expect(r).toBeGreaterThanOrEqual(0n);
            expect(r).toBeLessThanOrEqual((1n << 64n) - 1n);
        }
    });
});

// The values below are NOT druntime `hashOf` outputs — `hashOf`/the 32-bit `mixHash` are djs runtime
// helpers built on the verified `calcHash` (resolution #1, 08 §9). They are pinned as STABLE outputs
// of that construction (regenerated from the same `calcHash`), so a divergence here means the helper
// or `calcHash` changed — a real parity break for any AA keyed by an emitted `toHash`.

describe("mixHash (32-bit number overload) — combine two hashes (resolution #1, 08 §9)", () => {
    it("returns an unsigned 32-bit number, distinct from the bigint overload", () => {
        const r = mixHash(1, 2);
        expect(typeof r).toBe("number");
        expect(r).toBe(2370273378); // pinned stable value of the MurmurHash2 word-mix + avalanche
        expect(r >>> 0).toBe(r);
    });

    it("mixHash(0, 0) == 0 (zero word stays zero through imul/xor)", () => {
        expect(mixHash(0, 0)).toBe(0);
    });

    it("is deterministic and order-sensitive", () => {
        expect(mixHash(0xdeadbeef, 0xcafef00d)).toBe(460869430); // pinned
        expect(mixHash(0xdeadbeef, 0xcafef00d)).toBe(mixHash(0xdeadbeef, 0xcafef00d));
        // combining is not commutative — order of sub-hashes matters
        expect(mixHash(0xdeadbeef, 0xcafef00d)).not.toBe(mixHash(0xcafef00d, 0xdeadbeef));
    });

    it("coerces operands to unsigned 32-bit (>>> 0 at the boundary)", () => {
        // -1 and 0xFFFFFFFF are the same 32-bit word; the overload's `>>> 0` makes them agree.
        expect(mixHash(-1, -1)).toBe(mixHash(0xffffffff, 0xffffffff));
    });

    it("folds two calcHash outputs (composite-key combine)", () => {
        // mixHash(calcHash("0123456789"), calcHash("foo")) — pinned.
        expect(mixHash(439272720, 2414502773)).toBe(4246144042);
    });
});

describe("hashOf — djs runtime hash for emitted toHash (resolution #1, 08 §9)", () => {
    it("hashes a number as 4 little-endian bytes via calcHash (stable)", () => {
        expect(hashOf(42)).toBe(1483788722); // pinned
        expect(hashOf(0)).toBe(3026825932); // pinned
        expect(hashOf(0x12345678)).toBe(2615855736); // pinned
        expect(hashOf(42)).toBe(hashOf(42)); // deterministic
        expect(hashOf(42) >>> 0).toBe(hashOf(42)); // unsigned 32-bit
    });

    it("hashes a bigint as 8 little-endian bytes via calcHash (stable)", () => {
        expect(hashOf(42n)).toBe(3219936211); // pinned
        expect(hashOf(0xdeadbeefcafef00dn)).toBe(1503990213); // pinned
        // masks to unsigned 64-bit: -1n and 2^64-1 are the same size_t word
        expect(hashOf(-1n)).toBe(hashOf((1n << 64n) - 1n));
    });

    it("hashes a DString directly, equal to calcHash when seed is 0", () => {
        expect(hashOf(ds("0123456789"))).toBe(439272720); // == calcHash, pinned
        expect(hashOf(ds("foo"))).toBe(2414502773);
        expect(hashOf(ds(""))).toBe(0);
        expect(hashOf(ds("0123456789"))).toBe(calcHash(ds("0123456789")));
        expect(hashOf(ds("foo"))).toBe(calcHash(ds("foo")));
    });

    it("folds a non-zero seed via the 32-bit mixHash (chaining sub-hashes)", () => {
        expect(hashOf(42, 7)).toBe(4017942904); // pinned
        expect(hashOf(ds("foo"), 5)).toBe(1724636090); // pinned
        // seed == 0 is the identity (bare calcHash); a non-zero seed must change the result
        expect(hashOf(ds("foo"), 5)).not.toBe(hashOf(ds("foo")));
        // hashOf(x, seed) == mixHash(seed, hashOf(x, 0)) — the documented seeding contract
        expect(hashOf(ds("foo"), 5)).toBe(mixHash(5, hashOf(ds("foo"))));
    });

    it("the number and bigint domains are distinct (4-byte vs 8-byte word)", () => {
        // Same numeric value 42, different byte width → different hash. Confirms hashOf does NOT
        // collapse the two domains (09-numerics.md: number is uint, bigint is size_t).
        expect(hashOf(42)).not.toBe(hashOf(42n));
    });

    it("does not mutate a DString input", () => {
        const bytes = ds("0123456789");
        const before = bytes.slice();
        hashOf(bytes);
        hashOf(bytes, 9);
        expect(Array.from(bytes)).toEqual(Array.from(before));
    });
});
