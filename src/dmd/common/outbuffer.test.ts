import { describe, test, expect, vi } from "vitest";
import { OutBuffer, unsignedToTempString } from "./outbuffer.js";
import { ds, dsEquals } from "../../dstring.js";
import type { DString } from "../../dstring.js";

// Port of the in-source unittest{} blocks of dmd/common/outbuffer.d (10 §1.2, bare blocks ->
// "unittest#N", 1-based source order). D `==` on byte slices -> dsEquals (10 §1.4 + 08 §11:
// a D `string` is a Uint8Array, never compared with `===`).
//
// All expected byte sequences for the multibyte-UTF literals were verified against ldc2-1.42.0:
//   "\x11\U00000111\U00001111\U00011111\U00100000" -> 11 c4 91 e1 84 91 f0 91 84 91 f4 80 80 80
//   cast(string)"\U0010FFFF"w               -> 11 00 ff db ff df

const UTF8_EXPECTED = Uint8Array.from([0x11, 0xc4, 0x91, 0xe1, 0x84, 0x91, 0xf0, 0x91, 0x84, 0x91, 0xf4, 0x80, 0x80, 0x80]);
const UTF16_EXPECTED = Uint8Array.from([0x11, 0x00, 0xff, 0xdb, 0xff, 0xdf]);

// Helper: D `strcmp(q, "s") == 0` on a NUL-terminated C-string view -> compare the bytes up to
// the first NUL with the expected text.
function cstr(d: DString): DString {
    let len = 0;
    while (len < d.length && d[len] !== 0) len++;
    return d.subarray(0, len);
}

describe("common/outbuffer.d", () => {
    // outbuffer.d:881 — printf + insert + remove + bracket
    test("unittest#1", () => {
        const buf = new OutBuffer();
        buf.printf(ds("betty"));
        buf.insert(1, ds("xx")); // buf.insert(1, "xx".ptr, 2)
        buf.insert(3, ds("yy"));
        buf.remove(4, 1);
        buf.bracketChars(0x28 /* '(' */, 0x29 /* ')' */);
        const s = buf.opSliceAll(); // const char[] s = buf[];
        expect(dsEquals(s, ds("(bxxyetty)"))).toBe(true);
        buf.destroy();
    });

    // outbuffer.d:894 — writestring / prependstring / prependbyte / write(OutBuffer)
    test("unittest#2", () => {
        const buf = new OutBuffer();
        buf.writestring(ds("abc")); // buf.writestring("abc".ptr)
        buf.prependstring(ds("def"));
        buf.prependbyte(0x78 /* 'x' */);
        const buf2 = new OutBuffer();
        buf2.writestring(ds("mmm"));
        buf.writeBuffer(buf2); // buf.put(&buf2)
        const s = buf.extractSlice();
        expect(dsEquals(s, ds("xdefabcmmm"))).toBe(true);
    });

    // outbuffer.d:907 — extractSlice empties the buffer between calls
    test("unittest#3", () => {
        const buf = new OutBuffer();
        buf.writeByte(0x61 /* 'a' */);
        const s = buf.extractSlice();
        expect(dsEquals(s, ds("a"))).toBe(true);

        buf.writeByte(0x62 /* 'b' */);
        const t = buf.extractSlice();
        expect(dsEquals(t, ds("b"))).toBe(true);
    });

    // outbuffer.d:919 — peekChars NUL-terminates a view
    test("unittest#4", () => {
        const buf = new OutBuffer();
        const p = buf.peekChars();
        expect(p[0]).toBe(0); // assert(*p == 0)

        buf.writeByte(0x73 /* 's' */);
        const q = buf.peekChars();
        expect(dsEquals(cstr(q), ds("s"))).toBe(true); // strcmp(q, "s") == 0
    });

    // outbuffer.d:930 — unsignedToTempString in several radices
    test("unittest#5", () => {
        expect(dsEquals(unsignedToTempString(278n, 10), ds("278"))).toBe(true);
        expect(dsEquals(unsignedToTempString(1n, 10), ds("1"))).toBe(true);
        expect(dsEquals(unsignedToTempString(8n, 2), ds("1000"))).toBe(true);
        expect(dsEquals(unsignedToTempString(29n, 16), ds("1d"))).toBe(true);
    });

    // outbuffer.d:946 — writeUTF8 / writeUTF16
    test("unittest#6", () => {
        const buf = new OutBuffer();
        buf.writeUTF8(0x0000_0011);
        buf.writeUTF8(0x0000_0111);
        buf.writeUTF8(0x0000_1111);
        buf.writeUTF8(0x0001_1111);
        buf.writeUTF8(0x0010_0000);
        expect(dsEquals(buf.opSliceAll(), UTF8_EXPECTED)).toBe(true);

        buf.reset();
        buf.writeUTF16(0x0000_0011);
        buf.writeUTF16(0x0010_ffff);
        expect(dsEquals(buf.opSliceAll(), UTF16_EXPECTED)).toBe(true);
    });

    // outbuffer.d:962 — indent (tabs) + setsize/length
    test("unittest#7", () => {
        const buf = new OutBuffer();
        buf.doindent = true;

        const s = ds("abc");
        buf.writestring(s);
        buf.level += 1;
        buf.indent(); // D unittest calls the module-private indent() directly (outbuffer.d:970)
        buf.writestring(ds("abs"));

        expect(dsEquals(buf.opSliceAll(), ds("abc\tabs"))).toBe(true);

        buf.setsize(4);
        expect(buf.length()).toBe(4);
    });

    // outbuffer.d:979 — writenl strips trailing whitespace; POSIX newline is '\n'
    test("unittest#8", () => {
        const buf = new OutBuffer();

        buf.writenl();
        buf.writestring(ds("abc \t "));
        buf.writenl(); // strips trailing whitespace
        buf.writenl(); // doesn't strip previous newline

        // resolved: version(Windows) -> false; POSIX expects "\nabc\n\n".
        expect(dsEquals(buf.opSliceAll(), ds("\nabc\n\n"))).toBe(true);
    });

    // outbuffer.d:994 — writeHexString lower/upper case
    test("unittest#9", () => {
        const buf = new OutBuffer();
        buf.writeHexString(Uint8Array.from([0xaa, 0xbb]), false);
        buf.writeHexString(Uint8Array.from([0xcc]), true);
        expect(dsEquals(buf.opSliceAll(), ds("aabbCC"))).toBe(true);
    });
});

describe("OutBuffer.reserve — D's size_t growth formula (outbuffer.d:169)", () => {
    // `((minSize * 3 + 30) / 2) & ~15` is size_t arithmetic in D. Past a 1.43 GB minimum the old `& ~15` on a JS
    // number truncated to int32 and asked for a negative length (std/traits.d under -unittest -vcg-ast threw
    // `RangeError: Invalid typed array length: -2098501648`). The store's constructor is stubbed to record each
    // non-zero length requested (the empty initial store and `subarray` views pass 0 or a buffer), so no gigabyte
    // is allocated.
    test("the requested capacity is D's, below and above 2^31", () => {
        const sizes: number[] = [];
        const RealU8 = Uint8Array;
        vi.stubGlobal("Uint8Array", class extends RealU8 {
            constructor(n: unknown) {
                if (typeof n === "number" && n !== 0)
                    sizes.push(n);
                super(0);
            }
        });
        try {
            new OutBuffer().reserve(100);
            new OutBuffer().reserve(1_500_000_000);
        } finally {
            vi.unstubAllGlobals();
        }
        expect(sizes).toEqual([160, 2_250_000_000]);
    });
});
