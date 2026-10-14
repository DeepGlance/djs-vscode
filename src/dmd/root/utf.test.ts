import { describe, it, expect } from "vitest";
import { ds, dsToJs, dsEquals } from "../../dstring.js";
import { DError } from "../../assert.js";
import {
    utf_isValidDchar,
    utf_codeLengthChar,
    utf_codeLengthWchar,
    utf_codeLength,
    utf_encodeChar,
    utf_encodeWchar,
    isBidiControl,
    utf_decodeChar,
    utf_decodeWchar,
    type DecodeResult,
} from "./utf.js";

// All ground-truth expectations below were VERIFIED against ldc2-1.42.0 (DMD v2.112.1) via
// /tmp/probe_utf.d and /tmp/probe_utf2.d — see utf.ts file header for the probe output.

const b = (...bytes: number[]): Uint8Array => Uint8Array.from(bytes);
const w = (...units: number[]): Uint16Array => Uint16Array.from(units);

describe("utf_isValidDchar", () => {
    it("accepts the BMP up to the surrogate gap", () => {
        expect(utf_isValidDchar(0)).toBe(true);
        expect(utf_isValidDchar(0xd7ff)).toBe(true);
    });
    it("rejects the UTF-16 surrogate range [D800, DFFF]", () => {
        expect(utf_isValidDchar(0xd800)).toBe(false);
        expect(utf_isValidDchar(0xdc00)).toBe(false);
        expect(utf_isValidDchar(0xdfff)).toBe(false);
    });
    it("accepts above the surrogate gap up to the Unicode max", () => {
        expect(utf_isValidDchar(0xe000)).toBe(true);
        expect(utf_isValidDchar(0x10ffff)).toBe(true);
    });
    it("rejects above the Unicode max", () => {
        expect(utf_isValidDchar(0x110000)).toBe(false);
    });
});

describe("utf_codeLengthChar", () => {
    it("maps each range to its UTF-8 byte count (probed)", () => {
        expect(utf_codeLengthChar(0x7f)).toBe(1);
        expect(utf_codeLengthChar(0x80)).toBe(2);
        expect(utf_codeLengthChar(0x7ff)).toBe(2);
        expect(utf_codeLengthChar(0x800)).toBe(3);
        expect(utf_codeLengthChar(0xffff)).toBe(3);
        expect(utf_codeLengthChar(0x10000)).toBe(4);
        expect(utf_codeLengthChar(0x10ffff)).toBe(4);
    });
    it("throws (assert(false)) above the Unicode max", () => {
        expect(() => utf_codeLengthChar(0x110000)).toThrow(DError);
    });
});

describe("utf_codeLengthWchar", () => {
    it("is 1 for the BMP and 2 above it", () => {
        expect(utf_codeLengthWchar(0)).toBe(1);
        expect(utf_codeLengthWchar(0xffff)).toBe(1);
        expect(utf_codeLengthWchar(0x10000)).toBe(2);
        expect(utf_codeLengthWchar(0x10ffff)).toBe(2);
    });
});

describe("utf_codeLength", () => {
    it("dispatches on the encoding size", () => {
        expect(utf_codeLength(1, 0x20ac)).toBe(3); // UTF-8 -> codeLengthChar
        expect(utf_codeLength(2, 0x10000)).toBe(2); // UTF-16 -> codeLengthWchar
        expect(utf_codeLength(4, 0x10ffff)).toBe(1); // UTF-32 -> always 1
    });
    it("throws on an unsupported size (assert(sz == 4))", () => {
        expect(() => utf_codeLength(3, 0x41)).toThrow(DError);
    });
});

describe("utf_encodeChar", () => {
    it("encodes 1-byte ASCII", () => {
        const out = new Uint8Array(4);
        utf_encodeChar(out, 0, 0x41);
        expect(out[0]).toBe(0x41);
    });
    it("encodes 2-byte (U+00E9 -> C3 A9)", () => {
        const out = new Uint8Array(4);
        utf_encodeChar(out, 0, 0xe9);
        expect(Array.from(out.subarray(0, 2))).toEqual([0xc3, 0xa9]);
    });
    it("encodes 3-byte (U+20AC -> E2 82 AC), verified by probe", () => {
        const out = new Uint8Array(4);
        utf_encodeChar(out, 0, 0x20ac);
        expect(Array.from(out.subarray(0, 3))).toEqual([0xe2, 0x82, 0xac]);
    });
    it("encodes 4-byte (U+1F600 -> F0 9F 98 80), verified by probe", () => {
        const out = new Uint8Array(4);
        utf_encodeChar(out, 0, 0x1f600);
        expect(Array.from(out)).toEqual([0xf0, 0x9f, 0x98, 0x80]);
    });
    it("encodes U+10FFFF (the max) -> F4 8F BF BF", () => {
        const out = new Uint8Array(4);
        utf_encodeChar(out, 0, 0x10ffff);
        expect(Array.from(out)).toEqual([0xf4, 0x8f, 0xbf, 0xbf]);
    });
    it("writes at a non-zero offset", () => {
        const out = new Uint8Array(8);
        out[0] = 0x2a;
        utf_encodeChar(out, 1, 0x20ac);
        expect(Array.from(out.subarray(0, 4))).toEqual([0x2a, 0xe2, 0x82, 0xac]);
    });
    it("throws on a code point above the Unicode max (assert(0))", () => {
        expect(() => utf_encodeChar(new Uint8Array(4), 0, 0x110000)).toThrow(DError);
    });
});

describe("utf_encodeWchar", () => {
    it("encodes a BMP code point as one unit", () => {
        const out = new Uint16Array(2);
        utf_encodeWchar(out, 0, 0x20ac);
        expect(out[0]).toBe(0x20ac);
    });
    it("encodes an astral code point as a surrogate pair (U+1F600 -> D83D DE00)", () => {
        const out = new Uint16Array(2);
        utf_encodeWchar(out, 0, 0x1f600);
        expect(Array.from(out)).toEqual([0xd83d, 0xde00]);
    });
});

describe("isBidiControl", () => {
    it("matches the bidi control set (verified by probe)", () => {
        expect(isBidiControl(0x061c)).toBe(true);
        expect(isBidiControl(0x200e)).toBe(true);
        expect(isBidiControl(0x200f)).toBe(true);
        expect(isBidiControl(0x202a)).toBe(true); // range start
        expect(isBidiControl(0x202e)).toBe(true); // range end
        expect(isBidiControl(0x2066)).toBe(true); // range start
        expect(isBidiControl(0x2069)).toBe(true); // range end
    });
    it("rejects code points just outside the ranges (verified by probe)", () => {
        expect(isBidiControl(0x2065)).toBe(false); // just below 2066
        expect(isBidiControl(0x206a)).toBe(false); // just above 2069
        expect(isBidiControl(0x41)).toBe(false);
    });
});

// Helper: assert a successful decode of the exact code point, consuming exactly `n` units.
function expectOk(r: DecodeResult, startIdx: number, dchar: number, n: number): void {
    expect(r.error).toBeNull();
    expect(r.dchar).toBe(dchar);
    expect(r.nextIdx).toBe(startIdx + n);
}

// Helper: assert an error decode — the message matches, the cursor advanced by exactly 1, and
// the decoded value is the raw lead unit `s[startIdx]` (the §7.2 contract, VERIFIED by probe).
function expectErr(r: DecodeResult, s: Uint8Array | Uint16Array, startIdx: number, msg: string): void {
    expect(r.error).not.toBeNull();
    expect(dsToJs(r.error!)).toBe(msg);
    expect(dsEquals(r.error!, ds(msg))).toBe(true); // exact byte-identity, not just JS-string equality
    expect(r.nextIdx).toBe(startIdx + 1);
    expect(r.dchar).toBe(s[startIdx]);
}

describe("utf_decodeChar — success paths (multibyte round-trips)", () => {
    it("decodes 1-byte ASCII, consuming 1 byte", () => {
        expectOk(utf_decodeChar(b(0x41), 0), 0, 0x41, 1);
    });
    it("decodes 2-byte (C3 A9 -> U+00E9), consuming 2 bytes", () => {
        expectOk(utf_decodeChar(b(0xc3, 0xa9), 0), 0, 0xe9, 2);
    });
    it("decodes 3-byte (E2 82 AC -> U+20AC), consuming 3 bytes — byte-length != code-point count", () => {
        const s = b(0xe2, 0x82, 0xac);
        const r = utf_decodeChar(s, 0);
        expectOk(r, 0, 0x20ac, 3);
        expect(s.length).toBe(3); // 3 bytes...
        // ...but exactly ONE code point: re-decoding from nextIdx is at end-of-input.
        expect(r.nextIdx).toBe(3);
    });
    it("decodes 4-byte (F0 9F 98 80 -> U+1F600), consuming 4 bytes", () => {
        expectOk(utf_decodeChar(b(0xf0, 0x9f, 0x98, 0x80), 0), 0, 0x1f600, 4);
    });
    it("decodes the max code point (F4 8F BF BF -> U+10FFFF)", () => {
        expectOk(utf_decodeChar(b(0xf4, 0x8f, 0xbf, 0xbf), 0), 0, 0x10ffff, 4);
    });
    it("decodes from a non-zero start index in a longer buffer (41 C3 A9 at idx 1)", () => {
        // probe: decodeChar len=3 start=1 -> idx=3 result=U+00E9
        expectOk(utf_decodeChar(b(0x41, 0xc3, 0xa9), 1), 1, 0xe9, 2);
    });

    it("round-trips encode->decode for a 3-byte char", () => {
        const buf = new Uint8Array(8);
        utf_encodeChar(buf, 0, 0x20ac);
        const r = utf_decodeChar(buf, 0);
        expect(r.error).toBeNull();
        expect(r.dchar).toBe(0x20ac);
        expect(r.nextIdx).toBe(3);
    });

    it("decodes a multi-char byte string code point by code point", () => {
        // "A€" = 0x41, then E2 82 AC. 4 bytes total, 2 code points.
        const s = b(0x41, 0xe2, 0x82, 0xac);
        const first = utf_decodeChar(s, 0);
        expectOk(first, 0, 0x41, 1);
        const second = utf_decodeChar(s, first.nextIdx);
        expectOk(second, 1, 0x20ac, 3);
        expect(second.nextIdx).toBe(4); // consumed the whole 4-byte buffer in 2 decodes
    });
});

describe("utf_decodeChar — error paths (exact messages + cursor contract, all probed)", () => {
    it("continuation byte as lead (0x80) -> Outside Unicode code space", () => {
        expectErr(utf_decodeChar(b(0x80), 0), b(0x80), 0, "Outside Unicode code space");
    });
    it("5-byte lead (0xF8) -> Outside Unicode code space", () => {
        const s = b(0xf8, 0x80, 0x80, 0x80, 0x80);
        expectErr(utf_decodeChar(s, 0), s, 0, "Outside Unicode code space");
    });
    it("6-byte lead (0xFC) -> Outside Unicode code space (stride table: 0xFC -> 6)", () => {
        const s = b(0xfc, 0x80, 0x80, 0x80, 0x80, 0x80);
        expectErr(utf_decodeChar(s, 0), s, 0, "Outside Unicode code space");
    });
    it("invalid 7-bit lead (0xFE / 0xFF, stride 0xFF) -> Outside Unicode code space", () => {
        expectErr(utf_decodeChar(b(0xfe), 0), b(0xfe), 0, "Outside Unicode code space");
        expectErr(utf_decodeChar(b(0xff), 0), b(0xff), 0, "Outside Unicode code space");
    });
    it("truncated 2-byte (C3 alone) -> Truncated UTF-8 sequence", () => {
        expectErr(utf_decodeChar(b(0xc3), 0), b(0xc3), 0, "Truncated UTF-8 sequence");
    });
    it("truncated 4-byte (F0 9F 98, len 3) -> Truncated UTF-8 sequence", () => {
        const s = b(0xf0, 0x9f, 0x98);
        expectErr(utf_decodeChar(s, 0), s, 0, "Truncated UTF-8 sequence");
    });
    it("overlong 2-byte (C0 80) -> Overlong UTF-8 sequence", () => {
        expectErr(utf_decodeChar(b(0xc0, 0x80), 0), b(0xc0, 0x80), 0, "Overlong UTF-8 sequence");
    });
    it("overlong 3-byte (E0 80 80) -> Overlong UTF-8 sequence", () => {
        const s = b(0xe0, 0x80, 0x80);
        expectErr(utf_decodeChar(s, 0), s, 0, "Overlong UTF-8 sequence");
    });
    it("overlong 4-byte (F0 80 80 80) -> Overlong UTF-8 sequence", () => {
        const s = b(0xf0, 0x80, 0x80, 0x80);
        expectErr(utf_decodeChar(s, 0), s, 0, "Overlong UTF-8 sequence");
    });
    it("invalid trailer at byte 2 (C3 41) -> Invalid trailing code unit", () => {
        expectErr(utf_decodeChar(b(0xc3, 0x41), 0), b(0xc3, 0x41), 0, "Invalid trailing code unit");
    });
    it("invalid trailer deep in a 3-byte seq (E2 82 41) still advances cursor by ONLY 1", () => {
        // probe: bad trailer at the 3rd byte -> idx=1 (not 2), result=U+00E2 (lead byte)
        const s = b(0xe2, 0x82, 0x41);
        expectErr(utf_decodeChar(s, 0), s, 0, "Invalid trailing code unit");
    });
    it("invalid trailer at byte 2 of a 3-byte seq (E2 41 82) -> Invalid trailing code unit", () => {
        const s = b(0xe2, 0x41, 0x82);
        expectErr(utf_decodeChar(s, 0), s, 0, "Invalid trailing code unit");
    });
    it("encoded surrogate (ED A0 80 = U+D800) -> Invalid code point decoded", () => {
        const s = b(0xed, 0xa0, 0x80);
        expectErr(utf_decodeChar(s, 0), s, 0, "Invalid code point decoded");
    });
    it("above-max (F4 90 80 80 = U+110000) -> Invalid code point decoded", () => {
        const s = b(0xf4, 0x90, 0x80, 0x80);
        expectErr(utf_decodeChar(s, 0), s, 0, "Invalid code point decoded");
    });
});

describe("utf_decodeWchar", () => {
    it("decodes a single BMP unit (0x0041), consuming 1 unit", () => {
        expectOk(utf_decodeWchar(w(0x0041), 0), 0, 0x41, 1);
    });
    it("decodes a surrogate pair (D83D DE00 -> U+1F600), consuming 2 units (probed)", () => {
        expectOk(utf_decodeWchar(w(0xd83d, 0xde00), 0), 0, 0x1f600, 2);
    });
    it("truncated high surrogate (D800 alone) -> Truncated UTF-16 sequence", () => {
        expectErr(utf_decodeWchar(w(0xd800), 0), w(0xd800), 0, "Truncated UTF-16 sequence");
    });
    it("invalid low surrogate (D800 0041) -> Invalid low surrogate (probed)", () => {
        const s = w(0xd800, 0x0041);
        expectErr(utf_decodeWchar(s, 0), s, 0, "Invalid low surrogate");
    });
    it("unpaired low surrogate (DC00) -> Unpaired surrogate", () => {
        expectErr(utf_decodeWchar(w(0xdc00), 0), w(0xdc00), 0, "Unpaired surrogate");
    });
});
