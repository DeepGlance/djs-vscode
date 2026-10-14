import { describe, it, expect } from "vitest";
import { dmdformat } from "./dmdformat.js";
import { ds, dsToJs } from "../../dstring.js";
import { DError } from "../../assert.js";

// Every expected value below was VERIFIED against ldc2-1.42.0's C library `snprintf` (the same C
// printf DMD's OutBuffer.vprintf / fprintf(stderr) delegate to). The probe is /tmp/probe_fmt.d;
// treat these as ground truth — a divergence is a real parity break against the local toolchain.
// See docs/porting/10-tests-diagnostics.md §3.5.

/** Format and decode to a JS string for readable assertions (display boundary only). */
function fmt(f: string, ...args: unknown[]): string {
    return dsToJs(dmdformat(f, args));
}

describe("dmdformat — %s and NUL handling (02 §11, CANON#4)", () => {
    it("the VERIFIED %.*s NUL-stop: snprintf('&%.*s;', 5, 'quot\\0xxxx') -> '&quot;'", () => {
        // The 5-byte precision window covers "quot\0", but %s stops at the first NUL inside it.
        const arg = Uint8Array.from([0x71, 0x75, 0x6f, 0x74, 0x00, 0x78, 0x78, 0x78, 0x78]); // "quot\0xxxx"
        expect(fmt("&%.*s;", 5, arg)).toBe("&quot;");
    });

    it("%.*s with precision smaller than the string truncates (no NUL): %.3s of 'abcdef' -> 'abc'", () => {
        expect(fmt("[%.*s]", 3, ds("abcdef"))).toBe("[abc]");
    });

    it("%.*s with precision larger than the string prints the whole string", () => {
        expect(fmt("[%.*s]", 10, ds("abc"))).toBe("[abc]");
    });

    it("plain %s of a DString prints all bytes up to the first NUL", () => {
        expect(fmt("<%s>", ds("hello"))).toBe("<hello>");
        const withNul = Uint8Array.from([0x61, 0x62, 0x00, 0x63]); // "ab\0c"
        expect(fmt("<%s>", withNul)).toBe("<ab>");
    });

    it("%s accepts a JS string arg (coerced to bytes)", () => {
        expect(fmt("%s!", "world")).toBe("world!");
    });

    it("%.3s as a fixed precision truncates a string arg", () => {
        expect(fmt("%.3s", ds("abcdef"))).toBe("abc");
    });
});

describe("dmdformat — string width / justification (verified)", () => {
    it("%-10s| left-justifies and right-pads with spaces", () => {
        expect(fmt("%-10s|", ds("hi"))).toBe("hi        |");
    });
    it("%10s| right-justifies and left-pads with spaces", () => {
        expect(fmt("%10s|", ds("hi"))).toBe("        hi|");
    });
    it("%5.3s| applies precision then width", () => {
        expect(fmt("%5.3s|", ds("abcdef"))).toBe("  abc|");
    });
});

describe("dmdformat — octal %o / %llo / %03o / %#o (verified)", () => {
    it("%03o of 9 -> '011' (zero-padded to width 3)", () => {
        expect(fmt("%03o", 9)).toBe("011");
    });
    it("%o of 64 -> '100'", () => {
        expect(fmt("%o", 64)).toBe("100");
    });
    it("%#o of 64 -> '0100' (alternate form adds a leading 0)", () => {
        expect(fmt("%#o", 64)).toBe("0100");
    });
    it("%llo of a 64-bit bigint -> '100000000000'", () => {
        expect(fmt("%llo", 8589934592n)).toBe("100000000000");
    });
});

describe("dmdformat — 64-bit decimal %lld / %llu (verified)", () => {
    it("%llu of the max u64 -> '18446744073709551615'", () => {
        expect(fmt("%llu", 18446744073709551615n)).toBe("18446744073709551615");
    });
    it("%lld of -1 -> '-1'", () => {
        expect(fmt("%lld", -1n)).toBe("-1");
    });
    it("%lld of the max i64 -> '9223372036854775807'", () => {
        expect(fmt("%lld", 9223372036854775807n)).toBe("9223372036854775807");
    });
    it("%llu of a negative bigint wraps to unsigned 64-bit", () => {
        expect(fmt("%llu", -1n)).toBe("18446744073709551615");
    });
});

describe("dmdformat — hex %x / %X / %#x / %08x (verified)", () => {
    it("%x of 255 -> 'ff'", () => {
        expect(fmt("%x", 255)).toBe("ff");
    });
    it("%X of 255 -> 'FF'", () => {
        expect(fmt("%X", 255)).toBe("FF");
    });
    it("%#x of 255 -> '0xff' (alternate form prefix)", () => {
        expect(fmt("%#x", 255)).toBe("0xff");
    });
    it("%08x of 255 -> '000000ff' (zero-padded to width 8)", () => {
        expect(fmt("%08x", 255)).toBe("000000ff");
    });
    it("%#08x of 255 -> '0x0000ff' (zero-fill between prefix and digits)", () => {
        expect(fmt("%#08x", 255)).toBe("0x0000ff");
    });
    it("%#x of 0 omits the prefix but still prints the digit '0' (verified)", () => {
        expect(fmt("%#x", 0)).toBe("0");
    });
    it("%x / %d / %o of 0 -> '0' (no precision: absent != explicit .0)", () => {
        expect(fmt("%x", 0)).toBe("0");
        expect(fmt("%d", 0)).toBe("0");
        expect(fmt("%o", 0)).toBe("0");
    });
    it("%.0x / %.0d of 0 -> '' (explicit precision 0 of value 0)", () => {
        expect(fmt("[%.0x]", 0)).toBe("[]");
        expect(fmt("[%.0d]", 0)).toBe("[]");
    });
    it("%#.0o of 0 -> '0' (alternate octal form forces a lone 0; verified)", () => {
        expect(fmt("%#.0o", 0)).toBe("0");
    });
});

describe("dmdformat — signed/unsigned decimal width/precision/flags (verified)", () => {
    it("%5d of 42 -> '   42'", () => {
        expect(fmt("%5d", 42)).toBe("   42");
    });
    it("%-5d| of 42 -> '42   |'", () => {
        expect(fmt("%-5d|", 42)).toBe("42   |");
    });
    it("%05d of 42 -> '00042'", () => {
        expect(fmt("%05d", 42)).toBe("00042");
    });
    it("%+d of 42 -> '+42'", () => {
        expect(fmt("%+d", 42)).toBe("+42");
    });
    it("% d of 42 -> ' 42' (space flag)", () => {
        expect(fmt("% d", 42)).toBe(" 42");
    });
    it("%.5d of 42 -> '00042' (precision = min digits)", () => {
        expect(fmt("%.5d", 42)).toBe("00042");
    });
    it("%8.5d| of 42 -> '   00042|' (precision then width; 0 flag ignored with precision)", () => {
        expect(fmt("%8.5d|", 42)).toBe("   00042|");
    });
    it("%.0d of 0 -> '' (precision 0 of value 0 is empty)", () => {
        expect(fmt("[%.0d]", 0)).toBe("[]");
    });
    it("%05d of -42 -> '-0042' (sign before zero-fill)", () => {
        expect(fmt("%05d", -42)).toBe("-0042");
    });
    it("%+05d of 42 -> '+0042'", () => {
        expect(fmt("%+05d", 42)).toBe("+0042");
    });
    it("%u of u32-max -> '4294967295'", () => {
        expect(fmt("%u", 4294967295)).toBe("4294967295");
    });
    it("%i of -7 -> '-7'", () => {
        expect(fmt("%i", -7)).toBe("-7");
    });
    it("%zu of a size_t value -> '123456789'", () => {
        expect(fmt("%zu", 123456789)).toBe("123456789");
    });
});

describe("dmdformat — %c, %%, plain text (verified)", () => {
    it("%c%c of 65, 66 -> 'AB'", () => {
        expect(fmt("%c%c", 65, 66)).toBe("AB");
    });
    it("'100%%done' -> '100%done'", () => {
        expect(fmt("100%%done")).toBe("100%done");
    });
    it("a format with no specifiers is copied verbatim", () => {
        expect(fmt("just text")).toBe("just text");
    });
    it("%c honors width padding", () => {
        expect(fmt("[%3c]", 65)).toBe("[  A]");
        expect(fmt("[%-3c]", 65)).toBe("[A  ]");
    });
});

describe("dmdformat — `*` width/precision args consume from the va_list", () => {
    it("%*d takes the width from an arg", () => {
        expect(fmt("%*d", 5, 42)).toBe("   42");
    });
    it("a negative `*` width left-justifies", () => {
        expect(fmt("%*d|", -5, 42)).toBe("42   |");
    });
    it("%-*.*s| takes width and precision from args", () => {
        expect(fmt("%-*.*s|", 6, 3, ds("abcdef"))).toBe("abc   |");
    });
});

describe("dmdformat — return type and byte-level fidelity", () => {
    it("returns a Uint8Array of the raw bytes (not NUL-terminated)", () => {
        const r = dmdformat("hi", []);
        expect(r).toBeInstanceOf(Uint8Array);
        expect(Array.from(r)).toEqual([0x68, 0x69]);
    });
    it("accepts a Uint8Array format string", () => {
        expect(dsToJs(dmdformat(ds("x=%d"), [7]))).toBe("x=7");
    });
    it("emits a literal byte stream for non-ASCII format bytes", () => {
        const f = Uint8Array.from([0xc3, 0xa9, 0x25, 0x64]); // "é%d" as UTF-8 bytes + %d
        expect(Array.from(dmdformat(f, [5]))).toEqual([0xc3, 0xa9, 0x35]);
    });
});

describe("dmdformat — boundary failures (boundary-validation.md, 10 §3.5)", () => {
    it("throws DError on an unsupported conversion", () => {
        expect(() => dmdformat("%q", [1])).toThrow(DError);
    });
    it("throws DError on %f/%g/%e — C float conversions are a deferral", () => {
        expect(() => dmdformat("%f", [1.5])).toThrow(DError);
        expect(() => dmdformat("%g", [1.5])).toThrow(DError);
        expect(() => dmdformat("%e", [1.5])).toThrow(DError);
        expect(() => dmdformat("%f", [1.5])).toThrow(/CTFloat/);
    });
    it("throws DError when there are not enough arguments", () => {
        expect(() => dmdformat("%d %d", [1])).toThrow(DError);
    });
    it("throws DError on a non-integral number for an integer conversion", () => {
        expect(() => dmdformat("%d", [1.5])).toThrow(DError);
    });
});
