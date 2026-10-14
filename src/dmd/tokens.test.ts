import { describe, test, expect } from "vitest";
import { OutBuffer } from "./common/outbuffer.js";
import { writeCharLiteral, writeSingleCharLiteral } from "./tokens.js";
import { ds, dsEquals } from "../dstring.js";

// Port of the in-source unittest{} blocks of dmd/tokens.d (10 §1.2: bare blocks -> "unittest#N",
// 1-based source order). D `assert(byteSlice == "literal")` on char-slices -> dsEquals (10 §1.4,
// 08 §11). The D `foreach (dchar d; "..."d)` iterates code POINTS over a dstring literal; here we
// drive the same code points directly into `writeCharLiteral` (06 §1.4 dchar foreach).

describe("tokens.d", () => {
    // tokens.d:1198 — writeCharLiteral over each dchar of "a\n\r\t\b\f\0\x11爳\U00017233"d
    test("unittest#1", () => {
        const buf = new OutBuffer();
        // the dchar code points of the D dstring literal, in order
        const codePoints = [
            0x61, // 'a'
            0x0a, // '\n'
            0x0d, // '\r'
            0x09, // '\t'
            0x08, // '\b'
            0x0c, // '\f'
            0x00, // '\0'
            0x11, // '\x11'
            0x7233, // '爳'
            0x17233, // '\U00017233'
        ];
        for (const d of codePoints) {
            writeCharLiteral(buf, d);
        }
        // D: assert(buf[] == `a\n\r\t\b\f\0\x11爳\U00017233`);  (a WYSIWYG/backtick string: the
        // literal characters of the escapes, not the control bytes).
        expect(dsEquals(buf.extractData(), ds("a\\n\\r\\t\\b\\f\\0\\x11\\u7233\\U00017233"))).toBe(true);
    });

    // tokens.d:1232 — writeSingleCharLiteral for '\'', '"', '\n'
    test("unittest#2", () => {
        const buf = new OutBuffer();
        writeSingleCharLiteral(buf, 0x27 /* '\'' */);
        expect(dsEquals(buf.extractData(), ds("'\\''"))).toBe(true); // `'\''`
        buf.reset();
        writeSingleCharLiteral(buf, 0x22 /* '"' */);
        expect(dsEquals(buf.extractData(), ds("'\"'"))).toBe(true); // `'"'`
        buf.reset();
        writeSingleCharLiteral(buf, 0x0a /* '\n' */);
        expect(dsEquals(buf.extractData(), ds("'\\n'"))).toBe(true); // `'\n'`
    });
});
