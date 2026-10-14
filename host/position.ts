// dmd locations to VS Code positions.
//
// dmd's SourceLoc carries the line from 1, the column as a UTF-8 byte index from 1, and the byte offset into the
// file's content (dmd/location.d:242-248). VS Code counts lines from 0 and characters in UTF-16 code units from 0.
// dmd records start positions only, so the range is the token at the start: an identifier's extent when one starts
// there, else one character.

import type { Position } from "./protocol.js";

const decoder = new TextDecoder();

/** An identifier byte in D source: ASCII letter, digit, `_`, or any byte of a multi-byte UTF-8 sequence. */
function isIdentByte(b: number): boolean {
    return (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x5f
        || b >= 0x80;
}

/** The byte length of the UTF-8 sequence that starts with `b` (1 for a stray continuation byte). */
function sequenceLength(b: number): number {
    return b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
}

/**
 * The range of the token at `offset` in `content`. `line` and `column` are dmd's (from 1); they are used alone when
 * `content` does not reach `offset` (a location without file content: a mixin, the command line), with the column
 * taken as characters. A location with no line (0) maps to the start of the file, zero width.
 */
export function tokenRange(content: Uint8Array, offset: number, line: number, column: number)
    : { start: Position; end: Position } {
    if (line === 0) {
        const p = { line: 0, character: 0 };
        return { start: p, end: p };
    }
    if (offset > content.length || column === 0) {
        const character = Math.max(column - 1, 0);
        return { start: { line: line - 1, character }, end: { line: line - 1, character: character + 1 } };
    }
    let lineStart = offset;
    while (lineStart > 0 && content[lineStart - 1] !== 0x0a)
        lineStart--;
    const character = decoder.decode(content.subarray(lineStart, offset)).length;

    let end = offset;
    while (end < content.length && isIdentByte(content[end]!))
        end++;
    if (end === offset && offset < content.length && content[offset] !== 0x0a && content[offset] !== 0x0d)
        end = Math.min(offset + sequenceLength(content[offset]!), content.length);
    const width = decoder.decode(content.subarray(offset, end)).length;
    return { start: { line: line - 1, character }, end: { line: line - 1, character: character + width } };
}
