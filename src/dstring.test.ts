import { describe, it, expect } from "vitest";
import { DError } from "./assert.js";
import {
    ds,
    dsUtf8,
    dsToJs,
    dsEquals,
    dsLength,
    dsSlice,
    dsSubslice,
    dsConcat,
    dsEmpty,
    cstrlen,
    cstr,
    type DString,
} from "./dstring.js";

describe("DString type", () => {
    it("is a Uint8Array: byte-count length and byte (0-255) indexing", () => {
        const s: DString = ds("foo");
        expect(s).toBeInstanceOf(Uint8Array);
        expect(s.length).toBe(3);
        expect(s[0]).toBe(0x66); // 'f'
        expect(s[1]).toBe(0x6f); // 'o'
        expect(s[2]).toBe(0x6f); // 'o'
    });

    it("length is the BYTE count, not the code-point count", () => {
        // "€" is one code point but 3 UTF-8 bytes (E2 82 AC); D string .length == 3.
        const euro = dsUtf8("€");
        expect(euro.length).toBe(3);
        expect(Array.from(euro)).toEqual([0xe2, 0x82, 0xac]);
    });
});

describe("ds — ASCII/Latin-1 fast path (one byte per char code)", () => {
    it("maps ASCII chars to their byte values", () => {
        expect(Array.from(ds("A"))).toEqual([0x41]);
        expect(Array.from(ds("abc"))).toEqual([0x61, 0x62, 0x63]);
    });

    it("maps a Latin-1 char to a SINGLE byte (charCodeAt), NOT UTF-8", () => {
        // 'é' is U+00E9; ds() takes the char code as one byte -> 0xE9.
        // (dsUtf8 would produce the two-byte UTF-8 form.)
        expect(Array.from(ds("é"))).toEqual([0xe9]);
    });

    it("produces an empty DString for an empty literal", () => {
        const e = ds("");
        expect(e.length).toBe(0);
        expect(e).toBeInstanceOf(Uint8Array);
    });

    it("REJECTS a char code > 255 at the boundary (throws DError, no silent truncation)", () => {
        // '€' is U+20AC (> 0xFF): not representable as one byte -> loud failure.
        expect(() => ds("€")).toThrow(DError);
        expect(() => ds("a€b")).toThrow(/exceeds one byte/);
    });

    it("a Latin-1 escape literal round-trips the two UTF-8 bytes of 'é'", () => {
        // The canonical way to write a multi-byte D literal via ds(): the UTF-8 bytes as
        // Latin-1 chars. "\xc3\xa9" == ds(...) -> [0xC3, 0xA9] == dsUtf8("é").
        expect(Array.from(ds("\xc3\xa9"))).toEqual([0xc3, 0xa9]);
        expect(dsEquals(ds("\xc3\xa9"), dsUtf8("é"))).toBe(true);
    });
});

describe("dsUtf8 — UTF-8 encoding", () => {
    it("ASCII encodes one byte per char (agrees with ds for ASCII)", () => {
        expect(Array.from(dsUtf8("foo"))).toEqual([0x66, 0x6f, 0x6f]);
        expect(dsEquals(dsUtf8("foo"), ds("foo"))).toBe(true);
    });

    it("non-ASCII encodes to multiple bytes (DIFFERS from ds)", () => {
        expect(Array.from(dsUtf8("é"))).toEqual([0xc3, 0xa9]);
        expect(dsEquals(dsUtf8("é"), ds("é"))).toBe(false); // ds("é") is one byte [0xE9]
    });

    it("empty string encodes to empty DString", () => {
        expect(dsUtf8("").length).toBe(0);
    });
});

describe("dsToJs — display boundary only", () => {
    it("UTF-8-decodes bytes back to a JS string", () => {
        expect(dsToJs(dsUtf8("héllo"))).toBe("héllo");
        expect(dsToJs(ds("plain ascii"))).toBe("plain ascii");
    });

    it("round-trips dsUtf8 -> dsToJs for non-ASCII", () => {
        const original = "€ and é";
        expect(dsToJs(dsUtf8(original))).toBe(original);
    });
});

describe("dsEquals — byte equality, NOT reference equality", () => {
    it("equal bytes from distinct buffers are equal", () => {
        const a = ds("hello");
        const b = ds("hello");
        expect(a === b).toBe(false); // distinct Uint8Array objects
        expect(dsEquals(a, b)).toBe(true);
    });

    it("same object fast-path", () => {
        const a = ds("x");
        expect(dsEquals(a, a)).toBe(true);
    });

    it("different length -> not equal", () => {
        expect(dsEquals(ds("ab"), ds("abc"))).toBe(false);
    });

    it("same length, different bytes -> not equal", () => {
        expect(dsEquals(ds("abc"), ds("abd"))).toBe(false);
    });

    it("two empty DStrings are equal", () => {
        expect(dsEquals(ds(""), dsEmpty)).toBe(true);
    });

    it("a Uint8Array subarray view compares by content", () => {
        const buf = ds("xxhelloyy");
        const view = dsSubslice(buf, 2, 7); // "hello"
        expect(dsEquals(view, ds("hello"))).toBe(true);
    });
});

describe("dsLength", () => {
    it("returns the byte count", () => {
        expect(dsLength(ds("abcd"))).toBe(4);
        expect(dsLength(dsUtf8("€"))).toBe(3);
        expect(dsLength(dsEmpty)).toBe(0);
    });
});

describe("dsSlice — independent copy", () => {
    it("slices [start, end)", () => {
        const s = ds("abcdef");
        expect(Array.from(dsSlice(s, 1, 4))).toEqual([0x62, 0x63, 0x64]); // "bcd"
    });

    it("defaults span the whole slice", () => {
        const s = ds("abc");
        expect(dsEquals(dsSlice(s), s)).toBe(true);
    });

    it("returns an INDEPENDENT buffer (mutation does not affect the source)", () => {
        const s = ds("abc");
        const copy = dsSlice(s);
        copy[0] = 0x7a; // 'z'
        expect(s[0]).toBe(0x61); // source 'a' unchanged
        expect(copy[0]).toBe(0x7a);
    });
});

describe("dsSubslice — shared view", () => {
    it("returns a VIEW sharing the buffer (mutation IS visible through the source)", () => {
        const s = ds("abc");
        const view = dsSubslice(s, 0, 2);
        view[0] = 0x7a; // 'z'
        expect(s[0]).toBe(0x7a); // shared backing store
    });

    it("views [start, end)", () => {
        const s = ds("abcdef");
        expect(Array.from(dsSubslice(s, 2, 4))).toEqual([0x63, 0x64]); // "cd"
    });
});

describe("dsConcat", () => {
    it("concatenates into one fresh DString", () => {
        expect(dsEquals(dsConcat(ds("foo"), ds("bar")), ds("foobar"))).toBe(true);
    });

    it("handles three+ parts and preserves byte order", () => {
        const r = dsConcat(ds("a"), dsUtf8("é"), ds("b"));
        expect(Array.from(r)).toEqual([0x61, 0xc3, 0xa9, 0x62]);
    });

    it("empty input yields an empty DString", () => {
        expect(dsConcat().length).toBe(0);
    });

    it("does not mutate inputs", () => {
        const a = ds("xy");
        const b = ds("z");
        dsConcat(a, b);
        expect(Array.from(a)).toEqual([0x78, 0x79]);
        expect(Array.from(b)).toEqual([0x7a]);
    });
});

describe("dsEmpty", () => {
    it("is a zero-length DString", () => {
        expect(dsEmpty).toBeInstanceOf(Uint8Array);
        expect(dsEmpty.length).toBe(0);
    });
});

// cstrlen / cstr — the C-string NUL view over a DString (resolution #4, 02 §11). The LOGICAL
// C-string is the bytes BEFORE the first NUL; a NUL-terminated DString carries the trailing 0x00
// in its .length but the C-string excludes it.
describe("cstrlen — logical C-string length (bytes before the first NUL)", () => {
    it("a DString with no NUL: cstrlen == .length", () => {
        expect(cstrlen(ds("abc"))).toBe(3);
        expect(cstrlen(dsEmpty)).toBe(0);
    });

    it("a NUL-terminated DString: length up to (not including) the terminator", () => {
        // "abc\0" — the trailing NUL is the terminator, the C-string is "abc".
        const p = Uint8Array.from([0x61, 0x62, 0x63, 0x00]);
        expect(cstrlen(p)).toBe(3);
    });

    it("a lone NUL is the empty C-string (the `*p == 0` idiom)", () => {
        const p = Uint8Array.from([0x00]);
        expect(cstrlen(p)).toBe(0); // cstrlen(p) === 0  <=> *p == 0
        expect(cstrlen(p) > 0).toBe(false); // cstrlen(p) > 0  <=> if (*p)
    });

    it("stops at the FIRST NUL, ignoring bytes after it", () => {
        const p = Uint8Array.from([0x71, 0x75, 0x6f, 0x74, 0x00, 0x78, 0x78]); // "quot\0xx"
        expect(cstrlen(p)).toBe(4);
    });
});

describe("cstr — the C-string VIEW (bytes before the first NUL)", () => {
    it("returns the bytes before the first NUL", () => {
        const p = Uint8Array.from([0x61, 0x62, 0x63, 0x00]); // "abc\0"
        expect(dsEquals(cstr(p), ds("abc"))).toBe(true);
    });

    it("no NUL -> the whole slice", () => {
        expect(dsEquals(cstr(ds("hello")), ds("hello"))).toBe(true);
    });

    it("a lone NUL -> the empty C-string", () => {
        expect(cstr(Uint8Array.from([0x00])).length).toBe(0);
    });

    it("is a SHARED view (subarray), not a copy", () => {
        const p = Uint8Array.from([0x61, 0x62, 0x00]); // "ab\0"
        const v = cstr(p);
        v[0] = 0x7a; // 'z' — mutating the view mutates the source
        expect(p[0]).toBe(0x7a);
    });
});
