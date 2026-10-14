// Contract tests for the Port platform-helper port (docs/porting/08-runtime-lib.md §16).
// Every numeric expectation below was probed against ldc2-1.42.0 (DMD 2.112.1) before being
// asserted here (/tmp/probe_port.d, /tmp/probe_memicmp2.d, /tmp/probe_valcpy.d,
// /tmp/probe_float_range.d). Where a value is non-obvious, the probe result is cited inline.

import { describe, it, expect } from "vitest";

import { DError } from "../../assert.js";
import { ds } from "../../dstring.js";
import { Port } from "./port.js";

describe("Port.memicmp — case-insensitive byte compare", () => {
    it("equal ignoring ASCII case → 0", () => {
        expect(Port.memicmp(ds("ABC"), ds("abc"), 3)).toBe(0); // probe: 0
        expect(Port.memicmp(ds("aB"), ds("Ab"), 2)).toBe(0); // probe: 0 (each pos case-equal)
        expect(Port.memicmp(ds("5"), ds("5"), 1)).toBe(0); // digit, no case
    });

    it("returns the case-folded difference at the first differing position", () => {
        expect(Port.memicmp(ds("abc"), ds("ABD"), 3)).toBe(-1); // probe: -1 ('c'-'d' folded)
        expect(Port.memicmp(ds("abc"), ds("ABB"), 3)).toBe(1); // probe:  1 ('c'-'b' folded)
        expect(Port.memicmp(ds("a"), ds("C"), 1)).toBe(-2); // probe: -2 (toupper('a')=65, 'C'=67)
        expect(Port.memicmp(ds("Z"), ds("a"), 1)).toBe(25); // probe: 25 ('Z'=90, toupper('a')=65)
        expect(Port.memicmp(ds("xY"), ds("Xz"), 2)).toBe(-1); // probe: -1 (pos1 'Y'-'Z')
    });

    it("n=0 compares nothing → 0", () => {
        expect(Port.memicmp(ds("a"), ds("b"), 0)).toBe(0); // probe: 0
    });

    it("high bytes (>= 0x80) use unsigned byte difference; toupper leaves them unchanged", () => {
        // D char is UNSIGNED: 0x80 - 0x20 == 96 (probe: 96). toupper does not touch high bytes.
        expect(Port.memicmp(Uint8Array.of(0x80), Uint8Array.of(0x20), 1)).toBe(96);
        // 0xC0 - 0xE0 == -32 (probe: -32) — both high bytes pass through toupper unchanged.
        expect(Port.memicmp(Uint8Array.of(0xc0), Uint8Array.of(0xe0), 1)).toBe(-32);
    });

    it("matches the filename.d:109 usage (compare exactly name.length bytes)", () => {
        const a = ds("Foo.D");
        const b = ds("foo.d");
        expect(Port.memicmp(a, b, a.length)).toBe(0);
    });
});

describe("Port.strupr — in-place ASCII uppercase", () => {
    it("uppercases a..z, leaves everything else, returns the SAME object", () => {
        const s = ds("aZ9_é"); // "é" (U+00E9) is one Latin-1 byte 0xE9 via ds()
        const r = Port.strupr(s);
        expect(r).toBe(s); // same reference (in place)
        expect(Array.from(s)).toEqual([0x41, 0x5a, 0x39, 0x5f, 0xe9]); // 'A','Z','9','_',0xE9 (high byte unchanged)
    });

    it("empty slice is a no-op", () => {
        const s = ds("");
        expect(Array.from(Port.strupr(s))).toEqual([]);
    });
});

describe("Port endian read/write helpers", () => {
    it("readLongLE / readLongBE on [01 02 03 04]", () => {
        const b = Uint8Array.of(0x01, 0x02, 0x03, 0x04);
        expect(Port.readLongLE(b, 0)).toBe(0x04030201); // probe: 04030201
        expect(Port.readLongBE(b, 0)).toBe(0x01020304); // probe: 01020304
    });

    it("readWordLE / readWordBE on [01 02 …]", () => {
        const b = Uint8Array.of(0x01, 0x02, 0x03, 0x04);
        expect(Port.readWordLE(b, 0)).toBe(0x0201); // probe: 0201
        expect(Port.readWordBE(b, 0)).toBe(0x0102); // probe: 0102
    });

    it("readLongLE returns an unsigned 32-bit value (high bit set → no negative)", () => {
        const b = Uint8Array.of(0xef, 0xbe, 0xad, 0xde); // LE of 0xDEADBEEF
        expect(Port.readLongLE(b, 0)).toBe(0xdeadbeef);
        expect(Port.readLongLE(b, 0)).toBeGreaterThan(0);
    });

    it("writeLongLE / writeLongBE round-trip and store the documented byte order", () => {
        const le = new Uint8Array(4);
        Port.writeLongLE(le, 0, 0xdeadbeef);
        expect(Array.from(le)).toEqual([0xef, 0xbe, 0xad, 0xde]); // little-endian
        expect(Port.readLongLE(le, 0)).toBe(0xdeadbeef);

        const be = new Uint8Array(4);
        Port.writeLongBE(be, 0, 0xdeadbeef);
        expect(Array.from(be)).toEqual([0xde, 0xad, 0xbe, 0xef]); // big-endian
        expect(Port.readLongBE(be, 0)).toBe(0xdeadbeef);
    });

    it("honours the byte offset", () => {
        const b = new Uint8Array(8);
        Port.writeLongLE(b, 2, 0x11223344);
        expect(Array.from(b)).toEqual([0, 0, 0x44, 0x33, 0x22, 0x11, 0, 0]);
        expect(Port.readLongLE(b, 2)).toBe(0x11223344);
    });
});

describe("Port.valcpy — little-endian write of the low `size` bytes", () => {
    it("size 1/2/4", () => {
        const b = new Uint8Array(8);
        b.fill(0);
        Port.valcpy(b, 0, 0x41n, 1);
        expect(Array.from(b.subarray(0, 1))).toEqual([0x41]); // probe: 41
        b.fill(0);
        Port.valcpy(b, 0, 0x1234n, 2);
        expect(Array.from(b.subarray(0, 2))).toEqual([0x34, 0x12]); // probe: 34 12
        b.fill(0);
        Port.valcpy(b, 0, 0xdeadbeefn, 4);
        expect(Array.from(b.subarray(0, 4))).toEqual([0xef, 0xbe, 0xad, 0xde]); // probe: ef be ad de
    });

    it("size 8 (64-bit, bigint domain)", () => {
        const b = new Uint8Array(8);
        Port.valcpy(b, 0, 0x1122334455667788n, 8);
        // probe: 88 77 66 55 44 33 22 11
        expect(Array.from(b)).toEqual([0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11]);
    });

    it("truncates to the low `size` bytes (size 2 of 0x12345 → 45 23)", () => {
        const b = new Uint8Array(2);
        Port.valcpy(b, 0, 0x12345n, 2);
        expect(Array.from(b)).toEqual([0x45, 0x23]); // probe: 45 23
    });

    it("respects the byte offset", () => {
        const b = new Uint8Array(6);
        Port.valcpy(b, 2, 0xabcdn, 2);
        expect(Array.from(b)).toEqual([0, 0, 0xcd, 0xab, 0, 0]);
    });

    it("a size outside {1,2,4,8} hits assert(0) → throws DError", () => {
        const b = new Uint8Array(8);
        expect(() => Port.valcpy(b, 0, 0n, 3)).toThrow(DError);
        expect(() => Port.valcpy(b, 0, 0n, 0)).toThrow(DError);
    });
});

describe("Port.isFloat32/64LiteralOutOfRange — forwards to CTFloat", () => {
    // Port.isFloat* is a pure forwarder (resolved: version(IN_LLVM) -> CTFloat delegate).
    // The authoritative range contract lives in ctfloat.ts (§15/§09); these spot-checks confirm
    // the forwarding wires through and the documented edge values (probed against ldc2) hold.
    it("float32 range (probe: 3.4e38→false, 3.5e38→true, 1e-50→true, 1.0→false)", () => {
        expect(Port.isFloat32LiteralOutOfRange(ds("3.4e38"))).toBe(false);
        expect(Port.isFloat32LiteralOutOfRange(ds("3.5e38"))).toBe(true);
        expect(Port.isFloat32LiteralOutOfRange(ds("1e-50"))).toBe(true);
        expect(Port.isFloat32LiteralOutOfRange(ds("1.0"))).toBe(false);
    });

    it("float64 range (probe: 1e308→false, 1e309→true, 1e-400→true)", () => {
        expect(Port.isFloat64LiteralOutOfRange(ds("1e308"))).toBe(false);
        expect(Port.isFloat64LiteralOutOfRange(ds("1e309"))).toBe(true);
        expect(Port.isFloat64LiteralOutOfRange(ds("1e-400"))).toBe(true);
    });
});
