import { describe, it, expect } from "vitest";
import {
    toUpperAscii,
    toDString,
    iequals,
    toCString,
    toCStringThen,
    stripLeadingLineTerminator,
    dstrcmp,
    toStaticArray,
    startsWith,
    splitLines,
    findSplit,
    findBetween,
    FindSplit,
} from "./string.js";
import { ds, dsToJs, dsEquals } from "../../dstring.js";
import type { DString } from "../../dstring.js";

// All cases verified against ldc2-1.42.0 (the D unittests in string.d + dedicated probes).
// Everything is byte-level: no UTF-8 decoding anywhere (08 §8, string.d:46/:214).

function jsLines(text: DString): string[] {
    return [...splitLines(text)].map(dsToJs);
}

describe("toUpperAscii — C ASCII toupper at the byte level (08 §8)", () => {
    it("maps only a..z → A..Z", () => {
        expect(toUpperAscii(0x61)).toBe(0x41); // 'a' -> 'A'
        expect(toUpperAscii(0x7a)).toBe(0x5a); // 'z' -> 'Z'
    });

    it("passes every other byte through unchanged (digits, punctuation, high bytes)", () => {
        expect(toUpperAscii(0x41)).toBe(0x41); // 'A' already upper
        expect(toUpperAscii(0x30)).toBe(0x30); // '0'
        expect(toUpperAscii(0x60)).toBe(0x60); // '`' (just below 'a')
        expect(toUpperAscii(0x7b)).toBe(0x7b); // '{' (just above 'z')
        expect(toUpperAscii(0x80)).toBe(0x80); // high byte
        expect(toUpperAscii(0xff)).toBe(0xff);
    });
});

describe("toDString — slice a C-string to its NUL (string.d:17)", () => {
    it("returns the same DString when it holds no NUL", () => {
        const s = ds("foo");
        expect(toDString(s)).toBe(s);
    });

    it("stops at the NUL an extractChars() buffer carries (string.d:23 `strlen`)", () => {
        expect(dsToJs(toDString(ds("foo\0"))!)).toBe("foo");
        expect(dsToJs(toDString(ds("a\0b"))!)).toBe("a");
    });

    it("returns null for null (string.d:20)", () => {
        expect(toDString(null)).toBeNull();
    });
});

describe("iequals — ASCII case-insensitive byte equality (string.d:57)", () => {
    it("equal regardless of ASCII case", () => {
        expect(iequals(ds("Hello"), ds("hello"))).toBe(true);
        expect(iequals(ds("HELLO"), ds("hello"))).toBe(true);
        expect(iequals(ds(""), ds(""))).toBe(true);
    });

    it("different length is never equal", () => {
        expect(iequals(ds("hello"), ds("hell"))).toBe(false);
    });

    it("differs on a non-letter byte (no case-folding applies)", () => {
        expect(iequals(ds("a1"), ds("a2"))).toBe(false);
    });

    it("does NOT fold high bytes (byte-level, not Unicode)", () => {
        // 0xE9 ('é' Latin-1) has no ASCII uppercase; only equal to itself.
        expect(iequals(ds("\xe9"), ds("\xc9"))).toBe(false);
        expect(iequals(ds("\xe9"), ds("\xe9"))).toBe(true);
    });
});

describe("toCString — copy + NUL, slice EXCLUDES the NUL (string.d:122)", () => {
    it("returned slice has the original length and the same bytes", () => {
        const z = toCString(ds("abc"));
        expect(z.length).toBe(3);
        expect(dsEquals(z, ds("abc"))).toBe(true);
    });

    it("the NUL sits one past the slice end, inside the backing buffer", () => {
        const z = toCString(ds("abc"));
        // z is a subarray of a length-4 buffer; the NUL is at backing index 3 (z.length).
        const backing = new Uint8Array(z.buffer, z.byteOffset, z.length + 1);
        expect(backing[3]).toBe(0);
    });

    it("empty string → empty slice (NUL still in the buffer)", () => {
        const z = toCString(ds(""));
        expect(z.length).toBe(0);
    });
});

describe("toCStringThen — NUL-terminate then call dg; slice INCLUDES the NUL (string.d:93)", () => {
    it("dg sees a slice of length src.length+1 ending in NUL (verified)", () => {
        const result = toCStringThen(ds("Hello world"), (v) => {
            expect(v.length).toBe(12);
            expect(v[v.length - 1]).toBe(0);
            return dsEquals(v, ds("Hello world\x00"));
        });
        expect(result).toBe(true);
    });

    it("D unittest: 'Hello world\\0' → adds a SECOND NUL", () => {
        // string.d:110 — input already ends in NUL, output appends another.
        const result = toCStringThen(ds("Hello world\x00"), (v) => dsEquals(v, ds("Hello world\x00\x00")));
        expect(result).toBe(true);
    });

    it("empty string → a 1-byte slice [0] (verified)", () => {
        const result = toCStringThen(ds(""), (v) => {
            expect(v.length).toBe(1);
            return dsEquals(v, ds("\x00"));
        });
        expect(result).toBe(true);
    });

    it("returns dg's value (generic R)", () => {
        const n = toCStringThen(ds("ab"), (v) => v.length);
        expect(n).toBe(3);
    });
});

describe("stripLeadingLineTerminator — strip ONE leading EOL (string.d:148, D unittest)", () => {
    it("matches the string.d:194-209 unittest", () => {
        expect(dsToJs(stripLeadingLineTerminator(ds("")))).toBe("");
        expect(dsToJs(stripLeadingLineTerminator(ds("foo")))).toBe("foo");
        expect(dsToJs(stripLeadingLineTerminator(ds("\nfoo")))).toBe("foo");
        expect(dsToJs(stripLeadingLineTerminator(ds("\vfoo")))).toBe("foo");
        expect(dsToJs(stripLeadingLineTerminator(ds("\ffoo")))).toBe("foo");
        expect(dsToJs(stripLeadingLineTerminator(ds("\rfoo")))).toBe("foo");
        expect(dsToJs(stripLeadingLineTerminator(ds("\r\nfoo")))).toBe("foo");
    });

    it("strips only ONE terminator (\\n\\rfoo → \\rfoo)", () => {
        expect(dsEquals(stripLeadingLineTerminator(ds("\n\rfoo")), ds("\rfoo"))).toBe(true);
    });

    it("multibyte terminators: NEL (C2 85), LS (E2 80 A8), PS (E2 80 A9)", () => {
        expect(dsToJs(stripLeadingLineTerminator(dsUtf8u("foo")))).toBe("foo"); // NEL
        expect(dsToJs(stripLeadingLineTerminator(dsUtf8u(" foo")))).toBe("foo"); // LS
        expect(dsToJs(stripLeadingLineTerminator(dsUtf8u(" foo")))).toBe("foo"); // PS
    });

    it("lone lead byte of a multibyte EOL is NOT stripped (string.d:198-199)", () => {
        // "\xC2foo" / "\xE2foo" — first byte matches a multibyte lead but the rest doesn't follow.
        expect(dsEquals(stripLeadingLineTerminator(ds("\xc2foo")), ds("\xc2foo"))).toBe(true);
        expect(dsEquals(stripLeadingLineTerminator(ds("\xe2foo")), ds("\xe2foo"))).toBe(true);
    });

    it("returns a view (subarray) into the input, not a copy", () => {
        const src = ds("\nfoo");
        const out = stripLeadingLineTerminator(src);
        expect(out.buffer).toBe(src.buffer);
    });
});

describe("dstrcmp — strcmp-style byte compare (string.d:219, D unittest + probes)", () => {
    it("matches the string.d:244-246 unittest", () => {
        expect(dstrcmp(ds("Fraise"), ds("Fraise"))).toBe(0);
        expect(dstrcmp(ds("Baguette"), ds("Croissant"))).toBeLessThan(0);
        expect(dstrcmp(ds("Croissant"), ds("Baguette"))).toBeGreaterThan(0);
    });

    it("equal prefix → shorter compares LESS, with exact -1/0/1 shape (verified)", () => {
        expect(dstrcmp(ds("ab"), ds("abc"))).toBe(-1);
        expect(dstrcmp(ds("abc"), ds("ab"))).toBe(1);
        expect(dstrcmp(ds("ab"), ds("ab"))).toBe(0);
        expect(dstrcmp(ds(""), ds(""))).toBe(0);
        expect(dstrcmp(ds(""), ds("a"))).toBe(-1);
    });

    it("first-differing byte returns the raw (signed) byte difference", () => {
        expect(dstrcmp(ds("A"), ds("B"))).toBe(-1); // 0x41 - 0x42
        expect(dstrcmp(ds("B"), ds("A"))).toBe(1); // 0x42 - 0x41
    });

    it("bytes compare UNSIGNED (0x80 > 0x7f), verified against ldc2 memcmp", () => {
        const hi = Uint8Array.from([0x80]);
        const lo = Uint8Array.from([0x7f]);
        expect(dstrcmp(hi, lo)).toBeGreaterThan(0);
        expect(dstrcmp(lo, hi)).toBeLessThan(0);
    });
});

describe("toStaticArray — append NUL, slice INCLUDES it (string.d:268, D unittest)", () => {
    it("matches the string.d:280-292 unittest", () => {
        expect(dsEquals(toStaticArray(ds("123")), ds("123\x00"))).toBe(true);
        const empty = toStaticArray(ds(""));
        expect(empty.length).toBe(1);
        expect(empty[0]).toBe(0);
    });
});

describe("startsWith — byte prefix test, slice overload (string.d:320, D unittest)", () => {
    it("matches the string.d:328-337 unittest behavior", () => {
        const s = ds("123");
        expect(startsWith(s, ds(""))).toBe(true);
        expect(startsWith(s, ds("1"))).toBe(true);
        expect(startsWith(s, ds("12"))).toBe(true);
        expect(startsWith(s, ds("123"))).toBe(true);
        expect(startsWith(s, ds("1234"))).toBe(false);
    });

    it("prefix longer than string → false", () => {
        expect(startsWith(ds("ab"), ds("abc"))).toBe(false);
    });
});

describe("splitLines — line iterator, all Unicode EOLs (string.d:350, verified)", () => {
    it("simple multi-line, no trailing terminator", () => {
        expect(jsLines(ds("a\nb\nc"))).toEqual(["a", "b", "c"]);
    });

    it("trailing terminator does NOT yield a trailing empty line (verified)", () => {
        expect(jsLines(ds("a\nb\n"))).toEqual(["a", "b"]);
    });

    it("empty text yields no lines (verified)", () => {
        expect(jsLines(ds(""))).toEqual([]);
    });

    it("a lone terminator yields one empty line; two yield two (verified)", () => {
        expect(jsLines(ds("\n"))).toEqual([""]);
        expect(jsLines(ds("\n\n"))).toEqual(["", ""]);
    });

    it("CRLF is one terminator, lone CR is one terminator (verified)", () => {
        expect(jsLines(ds("a\r\nb"))).toEqual(["a", "b"]);
        expect(jsLines(ds("a\rb"))).toEqual(["a", "b"]);
    });

    it("\\v and \\f are terminators (verified)", () => {
        expect(jsLines(ds("a\x0bb"))).toEqual(["a", "b"]);
        expect(jsLines(ds("a\x0cb"))).toEqual(["a", "b"]);
    });

    it("no terminator → single line", () => {
        expect(jsLines(ds("ab"))).toEqual(["ab"]);
    });

    it("multibyte terminators NEL/LS/PS split lines", () => {
        expect(jsLines(dsUtf8u("ab"))).toEqual(["a", "b"]);
        expect(jsLines(dsUtf8u("a b"))).toEqual(["a", "b"]);
        expect(jsLines(dsUtf8u("a b"))).toEqual(["a", "b"]);
    });

    it("a lone lead byte (C2 not followed by 85) is NOT a terminator", () => {
        // "\xC2x" — C2 then 'x'; no split.
        expect([...splitLines(ds("\xc2x"))].length).toBe(1);
    });

    it("yields views into the input (no copy)", () => {
        const src = ds("a\nb");
        const first = [...splitLines(src)][0];
        expect(first.buffer).toBe(src.buffer);
    });
});

describe("findSplit — 3-part split around first match (string.d:471, D unittest + probes)", () => {
    it("matches the string.d:484-495 unittest", () => {
        const s = findSplit(ds("a b c"), ds("c"));
        expect(dsToJs(s.opIndex(0))).toBe("a b ");
        expect(dsToJs(s.opIndex(1))).toBe("c");
        expect(dsToJs(s.opIndex(2))).toBe("");
        expect(s.found()).toBe(true);

        const s1 = findSplit(ds("a b c"), ds("b"));
        expect(dsToJs(s1.opIndex(0))).toBe("a ");
        expect(dsToJs(s1.opIndex(1))).toBe("b");
        expect(dsToJs(s1.opIndex(2))).toBe(" c");
        expect(s1.found()).toBe(true);

        expect(findSplit(ds("a b c"), ds("d")).found()).toBe(false);
        expect(findSplit(ds(""), ds("d")).found()).toBe(false);
    });

    it("not found → [whole, empty, empty], .found() false", () => {
        const s = findSplit(ds("abc"), ds("z"));
        expect(s.found()).toBe(false);
        expect(dsToJs(s.opIndex(0))).toBe("abc");
        expect(s.opIndex(1).length).toBe(0);
        expect(s.opIndex(2).length).toBe(0);
    });

    it("needle longer than string → not found, [whole, empty, empty]", () => {
        const s = findSplit(ds("ab"), ds("abc"));
        expect(s.found()).toBe(false);
        expect(dsToJs(s.opIndex(0))).toBe("ab");
    });

    it("EMPTY needle matches at 0 → [empty, empty, whole], .found() FALSE (verified)", () => {
        const s = findSplit(ds("abc"), ds(""));
        expect(s.found()).toBe(false); // middle slice is empty
        expect(s.opIndex(0).length).toBe(0); // before = empty
        expect(s.opIndex(1).length).toBe(0); // needle = empty
        expect(dsToJs(s.opIndex(2))).toBe("abc"); // after = whole string
    });

    it("found at the very start", () => {
        const s = findSplit(ds("a b c"), ds("a"));
        expect(dsToJs(s.opIndex(0))).toBe("");
        expect(dsToJs(s.opIndex(1))).toBe("a");
        expect(dsToJs(s.opIndex(2))).toBe(" b c");
    });

    it("FindSplit views point into the source", () => {
        const src = ds("a b c");
        const s = findSplit(src, ds("b"));
        expect(s.opIndex(0).buffer).toBe(src.buffer);
        expect(s instanceof FindSplit).toBe(true);
    });
});

describe("findBetween — substring between two needles (string.d:507, D unittest)", () => {
    it("matches the string.d:515-518 unittest", () => {
        const got = findBetween(ds("a b c"), ds("a "), ds(" c"));
        expect(got).not.toBeNull();
        expect(dsToJs(got!)).toBe("b");
        expect(findBetween(ds("a b c"), ds("a "), ds(" d"))).toBeNull();
    });

    it("returns null when the left needle is absent", () => {
        expect(findBetween(ds("a b c"), ds("z"), ds("c"))).toBeNull();
    });

    it("returns a view into the source", () => {
        const src = ds("a b c");
        const got = findBetween(src, ds("a "), ds(" c"));
        expect(got!.buffer).toBe(src.buffer);
    });
});

// UTF-8 byte builder for genuinely multibyte test inputs (NEL/LS/PS). `ds` is Latin-1 (one byte
// per char code) and would reject code points > 0xff, so multibyte EOLs come through here.
function dsUtf8u(s: string): DString {
    return new TextEncoder().encode(s);
}
