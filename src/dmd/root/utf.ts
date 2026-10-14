// Ported from dmd/root/utf.d (module dmd.root.utf).
// Contract: docs/porting/08-runtime-lib.md §7 (API §7.1, the ref/out decode contract §7.2).
//
// UTF-8/16/32 conversion kernel for the byte-oriented lexer. Everything here operates on the
// runtime byte model: a D `const(char)[]` is a `DString` (Uint8Array, see dstring.ts / 08 §11),
// a `dchar` is a decoded code point (`number`), a UTF-16 unit slice is a `Uint16Array`. NOTHING
// here is a JS string. This is the highest-risk runtime module for correctness — a wrong cursor
// or error string breaks many lexer diagnostics, which `fail_compilation` tests assert verbatim.
//
// VERIFIED against ldc2-1.42.0 (DMD v2.112.1) via /tmp/probe_utf*.d. Key probed facts:
//   - On EVERY decode error path, the cursor advances by exactly 1 (the `ridx++` ran) and the
//     decoded value is the raw lead unit — even when the error is detected deep in a multi-byte
//     sequence. DMD only writes `ridx = i; rresult = c;` on the success path, so an error return
//     leaves them at their pre-staged values. Confirmed: a bad trailer at byte 3 of a 3-byte
//     sequence still yields nextIdx = startIdx+1, dchar = s[startIdx].
//   - The six UTF-8 / five UTF-16 error strings match DMD byte-for-byte (the lexer prints them).

import type { DString } from "../../dstring.js";
import { ds } from "../../dstring.js";
import { assertUnreachable } from "../../assert.js";

/// The Unicode code space is the range of code points [0x000000, 0x10FFFF]
/// except the UTF-16 surrogate pairs in the range [0xD800, 0xDFFF] (utf.d:18).
/// A `dchar` is a `number`; callers may pass any non-negative integer (e.g. an over-max
/// candidate from a 4-byte decode) and this returns false for it.
export function utf_isValidDchar(c: number): boolean {
    if (c < 0xd800) return true; // almost all characters in a typical document
    if (c > 0xdfff && c <= 0x10ffff) return true;
    return false;
}

/// Code length (in code units) of `c` when UTF-8 encoded: 1/2/3/4 by range (utf.d:33).
/// `assert(false)` for c > 0x10FFFF — a code point above the Unicode max is a contract
/// violation, not a recoverable input (the caller validates the candidate first).
export function utf_codeLengthChar(c: number): number {
    if (c <= 0x7f) return 1;
    if (c <= 0x7ff) return 2;
    if (c <= 0xffff) return 3;
    if (c <= 0x10ffff) return 4;
    return assertUnreachable(); // utf.d:43 assert(false)
}

/// Code length (in code units) of `c` when UTF-16 encoded: 1 for BMP, 2 for a surrogate
/// pair (utf.d:46). No validity check — mirrors DMD (it only inspects the magnitude).
export function utf_codeLengthWchar(c: number): number {
    return c <= 0xffff ? 1 : 2;
}

/// Code length of `c` for the encoding selected by `sz`: 1 = UTF-8, 2 = UTF-16, 4 = UTF-32
/// (utf.d:55). `assert(sz == 4)` for the UTF-32 fall-through — any other `sz` is a contract
/// violation. UTF-32 is always one code unit.
export function utf_codeLength(sz: number, c: number): number {
    if (sz === 1) return utf_codeLengthChar(c);
    if (sz === 2) return utf_codeLengthWchar(c);
    if (sz !== 4) assertUnreachable(`utf_codeLength: sz must be 1, 2, or 4 (got ${sz})`); // utf.d:61
    return 1; // UTF-32 is always one code unit (utf.d:62)
}

/// Write the UTF-8 encoding of `c` into `s` starting at byte offset `off` (utf.d:65).
/// Preconditions (asserted in DMD): `c` is a valid dchar. Writes 1–4 bytes; the caller MUST
/// have reserved `utf_codeLengthChar(c)` bytes at `s[off..]`. Cost: O(1), no allocation.
export function utf_encodeChar(s: Uint8Array, off: number, c: number): void {
    // assert(utf_isValidDchar(c)) — DMD utf.d:68; the caller guarantees a valid code point.
    if (c <= 0x7f) {
        s[off] = c;
    } else if (c <= 0x07ff) {
        s[off] = 0xc0 | (c >> 6);
        s[off + 1] = 0x80 | (c & 0x3f);
    } else if (c <= 0xffff) {
        s[off] = 0xe0 | (c >> 12);
        s[off + 1] = 0x80 | ((c >> 6) & 0x3f);
        s[off + 2] = 0x80 | (c & 0x3f);
    } else if (c <= 0x10ffff) {
        s[off] = 0xf0 | (c >> 18);
        s[off + 1] = 0x80 | ((c >> 12) & 0x3f);
        s[off + 2] = 0x80 | ((c >> 6) & 0x3f);
        s[off + 3] = 0x80 | (c & 0x3f);
    } else {
        assertUnreachable(); // utf.d:92 assert(0)
    }
}

/// Write the UTF-16 encoding of `c` into `s` starting at unit offset `off` (utf.d:95).
/// Writes 1 unit for the BMP, 2 (a surrogate pair) above it. The caller MUST have reserved
/// `utf_codeLengthWchar(c)` units. Cost: O(1).
export function utf_encodeWchar(s: Uint16Array, off: number, c: number): void {
    // assert(utf_isValidDchar(c)) — DMD utf.d:98.
    if (c <= 0xffff) {
        s[off] = c;
    } else {
        s[off] = (((c - 0x010000) >> 10) & 0x03ff) + 0xd800;
        s[off + 1] = ((c - 0x010000) & 0x03ff) + 0xdc00;
    }
}

/// Write the encoding of `c` at code-unit width `sz` into the byte buffer `s` at byte offset `off`
/// (utf.d:110, whose `void* s` is the buffer plus offset here): UTF-8 for sz 1, UTF-16 for sz 2,
/// one UTF-32 unit for sz 4, the wider units in host order, which is little-endian as the
/// StringExp payload assumes. Preconditions: `sz` is 1, 2 or 4 (asserted, utf.d:117); the caller
/// reserved `utf_codeLength(sz, c)` units at `s[off..]`, and `s.byteOffset + off` is a multiple
/// of `sz` (typed-array views need an aligned offset; every caller passes a fresh buffer and an
/// offset of whole units). Cost: O(1), one view allocated for sz 2 and 4.
export function utf_encode(sz: number, s: Uint8Array, off: number, c: number): void {
    if (sz === 1)
        utf_encodeChar(s, off, c);
    else if (sz === 2)
        utf_encodeWchar(new Uint16Array(s.buffer, s.byteOffset + off, utf_codeLengthWchar(c)), 0, c);
    else {
        if (sz !== 4) assertUnreachable(`utf_encode: sz must be 1, 2, or 4 (got ${sz})`); // utf.d:117
        new Uint32Array(s.buffer, s.byteOffset + off, 1)[0] = c;
    }
}

/// Whether `c` is a Unicode bidirectional control character (utf.d:127).
/// Source: https://www.unicode.org/versions/Unicode15.0.0, table 23-3. The two `..` case
/// ranges in DMD's switch are expanded to inclusive range tests here.
export function isBidiControl(c: number): boolean {
    if (c === 0x061c) return true; // ARABIC LETTER MARK
    if (c === 0x200e) return true; // LEFT-TO-RIGHT MARK
    if (c === 0x200f) return true; // RIGHT-TO-LEFT MARK
    if (c >= 0x202a && c <= 0x202e) return true; // LRE..RLO (DMD: case '‪': .. case '‮':)
    if (c >= 0x2066 && c <= 0x2069) return true; // LRI..PDI (DMD: case '⁦': .. case '⁩':)
    return false;
}

/**
 * The result of decoding ONE code point — the §7.2 replacement for D's `ref size_t ridx`
 * (in/out cursor) + `out dchar rresult` (decoded point) + the `string` return (error or null).
 *
 * - `nextIdx`: the updated cursor (D's `ridx` after the call). On success it is the start index
 *   plus the number of code units consumed; on EVERY error it is start index + 1 (DMD's `ridx++`
 *   runs unconditionally before any error return — VERIFIED, see file header).
 * - `dchar`: the decoded code point (D's `rresult`). On success the decoded value; on error the
 *   raw lead code unit `s[startIdx]` (DMD pre-stages `rresult = u` and only overwrites it on
 *   success — VERIFIED).
 * - `error`: `null` on success, otherwise the EXACT diagnostic message bytes (a `DString`).
 */
export interface DecodeResult {
    nextIdx: number; // was: ref size_t ridx
    dchar: number; // was: out dchar rresult
    error: DString | null; // null on success; else the exact error-message bytes
}

// ---- UTF-8 decode error messages (utf.d:155-160). MUST match DMD byte-for-byte: the lexer
// prints them into `fail_compilation` diagnostics. Carried as DString constants. Built once.
const UTF8_DECODE_OK: null = null; // no error
const UTF8_DECODE_OUTSIDE_CODE_SPACE: DString = ds("Outside Unicode code space");
const UTF8_DECODE_TRUNCATED_SEQUENCE: DString = ds("Truncated UTF-8 sequence");
const UTF8_DECODE_OVERLONG: DString = ds("Overlong UTF-8 sequence");
const UTF8_DECODE_INVALID_TRAILER: DString = ds("Invalid trailing code unit");
const UTF8_DECODE_INVALID_CODE_POINT: DString = ds("Invalid code point decoded");

// ---- UTF-16 decode error messages (utf.d:277-281).
const UTF16_DECODE_OK: null = null;
const UTF16_DECODE_TRUNCATED_SEQUENCE: DString = ds("Truncated UTF-16 sequence");
const UTF16_DECODE_INVALID_SURROGATE: DString = ds("Invalid low surrogate");
const UTF16_DECODE_UNPAIRED_SURROGATE: DString = ds("Unpaired surrogate");
const UTF16_DECODE_INVALID_CODE_POINT: DString = ds("Invalid code point decoded");

/**
 * Expected UTF-8 sequence length keyed by lead byte (utf.d:171-210). Data table, copied
 * byte-for-byte: 1 for ASCII (0x00-0x7F), 0xFF for a continuation/invalid lead (0x80-0xBF
 * and the two invalid 7-bit leads 0xFE/0xFF), then 2/3/4/5/6 for the multibyte leads. A 0xFF
 * (or a 5/6) entry routes to the "Outside Unicode code space" error. Frozen so callers cannot
 * corrupt the shared table.
 */
const UTF8_STRIDE: ReadonlyArray<number> = Object.freeze([
    // 0x00-0x7F: 128 ASCII (stride 1)
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    // 0x80-0xBF: 64 continuation bytes (invalid as lead, stride 0xFF)
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    // 0xC0-0xDF: 32 two-byte leads (stride 2)
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    // 0xE0-0xEF: 16 three-byte leads (stride 3)
    3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
    // 0xF0-0xF7: 8 four-byte leads (stride 4)
    4, 4, 4, 4, 4, 4, 4, 4,
    // 0xF8-0xFB: 5-byte leads; 0xFC-0xFD: 6-byte leads; 0xFE-0xFF: invalid
    5, 5, 5, 5, 6, 6, 0xff, 0xff,
]);

/**
 * Decode a UTF-8 sequence as a single UTF-32 code point (utf.d:152, §7.2).
 *
 * @param s   the source bytes (a DString); MUST be non-null (DMD asserts s !is null).
 * @param idx the starting byte index in `s` (D's incoming `ridx`).
 * @returns   `{ nextIdx, dchar, error }` — see {@link DecodeResult}. `error` is `null` on success,
 *            else the exact diagnostic message bytes. On error, `nextIdx === idx + 1` and
 *            `dchar === s[idx]` (the lead byte); on success `nextIdx === idx + n`.
 *
 * Cursor/value contract is VERIFIED against ldc2 (see file header): the lexer uses `nextIdx` to
 * resync after a bad byte, so the +1-on-error advance is load-bearing — do not "fix" it.
 */
export function utf_decodeChar(s: DString, idx: number): DecodeResult {
    // size_t i = ridx++  (utf.d:213). The post-increment is the +1 cursor on every error path.
    let i = idx;
    const startIdx = idx;

    const u = s[i]; // const char u = s[i]  (utf.d:215)
    // Pre-stage results for ASCII and error cases: rresult = u  (utf.d:217).
    let rresult = u;

    const n = UTF8_STRIDE[u]; // expected sequence length (utf.d:220)
    switch (n) {
        case 1:
            // ASCII (utf.d:223)
            return { nextIdx: startIdx + 1, dchar: rresult, error: UTF8_DECODE_OK };
        case 2:
        case 3:
        case 4:
            break; // multi-byte UTF-8 (utf.d:226-230)
        default:
            // 5- or 6-byte sequence, or an invalid lead (stride 0xFF) (utf.d:231-233)
            return { nextIdx: startIdx + 1, dchar: rresult, error: UTF8_DECODE_OUTSIDE_CODE_SPACE };
    }

    if (s.length < i + n) {
        // source too short (utf.d:235-236)
        return { nextIdx: startIdx + 1, dchar: rresult, error: UTF8_DECODE_TRUNCATED_SEQUENCE };
    }

    // Pick off 7 - n low bits from the first code unit (utf.d:238).
    let c = u & ((1 << (7 - n)) - 1);

    const u2 = s[++i]; // const char u2 = s[++i]  (utf.d:246)
    // Overlong combinations (utf.d:248) — these would encode a code point in fewer bytes.
    if (
        (u & 0xfe) === 0xc0 ||
        (u === 0xe0 && (u2 & 0xe0) === 0x80) ||
        (u === 0xf0 && (u2 & 0xf0) === 0x80) ||
        (u === 0xf8 && (u2 & 0xf8) === 0x80) ||
        (u === 0xfc && (u2 & 0xfc) === 0x80)
    ) {
        return { nextIdx: startIdx + 1, dchar: rresult, error: UTF8_DECODE_OVERLONG };
    }

    // Decode remaining bits (utf.d:251). `i` already points at the first trailing byte (u2);
    // the loop bound `m = n + i - 1` is computed AFTER the `++i` above (matches DMD exactly).
    const m = n + i - 1;
    for (; i !== m; ++i) {
        const u3 = s[i];
        if ((u3 & 0xc0) !== 0x80) {
            // trailing bytes must be 10xxxxxx (utf.d:254-255)
            return { nextIdx: startIdx + 1, dchar: rresult, error: UTF8_DECODE_INVALID_TRAILER };
        }
        c = (c << 6) | (u3 & 0x3f);
    }

    if (!utf_isValidDchar(c)) {
        // surrogate or above-max code point (utf.d:258-259). NOTE: rresult stays the lead byte.
        return { nextIdx: startIdx + 1, dchar: rresult, error: UTF8_DECODE_INVALID_CODE_POINT };
    }

    // Success path — ONLY here does DMD write `ridx = i; rresult = c;` (utf.d:260-262).
    rresult = c;
    return { nextIdx: i, dchar: rresult, error: UTF8_DECODE_OK };
}

/**
 * Decode a UTF-16 sequence as a single UTF-32 code point (utf.d:274, §7.2).
 *
 * @param s   the source UTF-16 units (a `Uint16Array`); MUST be non-null (DMD asserts).
 * @param idx the starting unit index (D's incoming `ridx`).
 * @returns   `{ nextIdx, dchar, error }` — see {@link DecodeResult}.
 *
 * Rarely hit (the frontend is UTF-8) but ported for completeness. Same cursor discipline as the
 * UTF-8 path: `ridx++` runs first (so the truncated/unpaired/invalid error paths leave
 * `nextIdx === idx + 1` and `dchar === s[idx]`); the surrogate-pair success consumes 2 units.
 *
 * VERBATIM QUIRK: the invalid-low-surrogate test is `u2 < 0xDC00 || 0xDFFF < u` (utf.d:295). The
 * `0xDFFF < u` disjunct is dead — at that point `u` is a high surrogate in [0xD800, 0xDBFF], never
 * > 0xDFFF — so only `u2 < 0xDC00` ever fires. Reproduced literally to match the compiler; do not
 * "correct" it to `0xDFFF < u2`. VERIFIED: `[0xD800, 0x0041]` -> "Invalid low surrogate".
 */
export function utf_decodeWchar(s: Uint16Array, idx: number): DecodeResult {
    // size_t i = ridx++  (utf.d:284). `i` is the read cursor; `nextIdx` is the returned ridx.
    const i = idx;
    let nextIdx = idx + 1;

    // dchar u = rresult = s[i]  (utf.d:287). Pre-stage rresult to the first unit.
    let u = s[i];
    let rresult = u;

    if (u < 0xd800) {
        // single-wchar codepoint (utf.d:288-289)
        return { nextIdx, dchar: rresult, error: UTF16_DECODE_OK };
    }
    if (u >= 0xd800 && u <= 0xdbff) {
        // surrogate pair (utf.d:290-299)
        if (s.length <= i + 1) {
            return { nextIdx, dchar: rresult, error: UTF16_DECODE_TRUNCATED_SEQUENCE };
        }
        const u2 = s[i + 1];
        // utf.d:295 — see VERBATIM QUIRK in the doc comment above.
        if (u2 < 0xdc00 || 0xdfff < u) {
            return { nextIdx, dchar: rresult, error: UTF16_DECODE_INVALID_SURROGATE };
        }
        u = ((u - 0xd7c0) << 10) + (u2 - 0xdc00);
        ++nextIdx; // ++ridx  (utf.d:298)
    } else if (u >= 0xdc00 && u <= 0xdfff) {
        // lone low surrogate (utf.d:300-301)
        return { nextIdx, dchar: rresult, error: UTF16_DECODE_UNPAIRED_SURROGATE };
    }

    if (!utf_isValidDchar(u)) {
        // utf.d:302-303
        return { nextIdx, dchar: rresult, error: UTF16_DECODE_INVALID_CODE_POINT };
    }

    // Success — rresult = u  (utf.d:304).
    rresult = u;
    return { nextIdx, dchar: rresult, error: UTF16_DECODE_OK };
}
