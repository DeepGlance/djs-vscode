// Tests for host/position.ts: dmd's byte columns to VS Code's UTF-16 characters.

import { describe, expect, test } from "vitest";
import { tokenRange } from "./position.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("tokenRange", () => {
    test("non-ASCII before the location: the character counts UTF-16 units, not bytes", () => {
        const text = "// x\nauto s = \"perché 😀\"; foo(1);\n";
        const content = enc(text);
        const offset = content.indexOf(0x66, 5);   // the `f` of foo, after 2-byte é and 4-byte emoji
        const r = tokenRange(content, offset, 2, offset - 5 + 1);
        expect(r.start).toEqual({ line: 1, character: text.split("\n")[1]!.indexOf("foo") });
        expect(r.end.character - r.start.character).toBe(3);
    });

    test("a non-identifier at the location is one character wide; an identifier spans its bytes", () => {
        const content = enc("a = é;\n");
        expect(tokenRange(content, 2, 1, 3)).toEqual({ start: { line: 0, character: 2 }, end: { line: 0, character: 3 } });
        expect(tokenRange(content, 4, 1, 5)).toEqual({ start: { line: 0, character: 4 }, end: { line: 0, character: 5 } });
    });

    test("no content: the column is taken as characters; no line: the file start, zero width", () => {
        expect(tokenRange(new Uint8Array(0), 10, 3, 7)).toEqual({
            start: { line: 2, character: 6 }, end: { line: 2, character: 7 } });
        expect(tokenRange(new Uint8Array(0), 0, 0, 0)).toEqual({
            start: { line: 0, character: 0 }, end: { line: 0, character: 0 } });
    });
});
