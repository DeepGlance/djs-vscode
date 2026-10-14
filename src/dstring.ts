// Hand-written djs runtime helper (not derived from a single dmd/root module).
// Owns the byte-string model the whole port references — see docs/porting/08-runtime-lib.md §11.

import { DError } from "./assert.js";

/**
 * `DString` is the runtime model of a D char-slice.
 *
 * D's `string` / `const(char)[]` / `char[]` / `immutable(char)[]` are all UTF-8
 * **byte arrays** (_probes.md §5, 02-types.md §1.3), NOT JS strings. So:
 *   - `.length` is the BYTE count (a 4-byte UTF-8 code point counts as 4, not 1).
 *   - `s[i]` is a single byte in `0..255` (NOT a UTF-16 code unit).
 *   - a `dchar` is a decoded code point (`number`), produced by `root/utf.ts` on demand.
 *
 * Backing it with `Uint8Array` reproduces D's byte semantics exactly. Never back a
 * `DString` with a JS `string`: that would re-introduce JS's UTF-16 `.length`/index
 * mismatch and silently break the byte-oriented lexer.
 *
 * Lifetime/ownership: a `DString` is a view onto a `Uint8Array` buffer. `slice` returns
 * an INDEPENDENT copy (own buffer); `subarray` returns a VIEW that shares the buffer
 * (mutations are visible through both). Callers that need to retain bytes past a transient
 * buffer's lifetime must copy (`08 §5` StringTable, `13` xstrdup).
 *
 * Equality: NEVER compare two `DString`s with `===` — that is reference identity on the
 * `Uint8Array` object, not byte content. Use `dsEquals` (this module) or `dstrcmp`
 * (`root/string.ts`). `05-operators.md`: D `s1 == s2` on char-slices lowers to `dsEquals`.
 */
export type DString = Uint8Array;

/**
 * Build a `DString` from an ASCII/Latin-1 JS string literal — the fast path for the
 * frontend's pervasive ASCII string literals (`"foo"` → `ds("foo")`).
 *
 * Contract: EACH JS char code is taken as ONE byte (Latin-1 / `charCodeAt`). So
 * `ds("A")` → `[0x41]` and `ds("é")` → `[0xE9]` (one byte), NOT the UTF-8 `[0xC3,0xA9]`.
 * A genuinely multi-byte string literal in the D source is already its UTF-8 bytes; port it
 * either by writing those bytes as Latin-1 escapes (`ds("\xc3\xa9")`) or via `dsUtf8`.
 *
 * Boundary validation (boundary-validation.md): a char code > 255 cannot be one byte and is
 * a contract violation — reject it LOUDLY (throw `DError`) at this boundary rather than
 * silently masking to 8 bits. Callers with non-Latin-1 text must use `dsUtf8`.
 *
 * Cost: one allocation + one pass over the string. Safe to call at module top level.
 */
export function ds(literal: string): DString {
    const n = literal.length;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const code = literal.charCodeAt(i);
        if (code > 0xff) {
            throw new DError(`ds: char code 0x${code.toString(16)} at index ${i} exceeds one byte; use dsUtf8`);
        }
        out[i] = code;
    }
    return out;
}

/**
 * Build a `DString` by UTF-8-encoding a JS string. Use for diagnostic strings or any
 * source text carrying non-ASCII code points: `dsUtf8("é")` → `[0xC3, 0xA9]`.
 * (`ds` is the one-byte-per-char-code form; `dsUtf8` is the multi-byte UTF-8 form.)
 */
export function dsUtf8(s: string): DString {
    return new TextEncoder().encode(s);
}

/**
 * Decode a `DString`'s UTF-8 bytes back to a JS string. DISPLAY / Node-API boundary ONLY
 * (printing diagnostics, fs paths). Never call inside lexer/parser/CTFE logic — decoding to
 * a JS string re-introduces the UTF-16 length mismatch the byte model exists to avoid (08 §11).
 */
export function dsToJs(s: DString): string {
    return new TextDecoder().decode(s);
}

/**
 * Byte-wise equality of two char-slices (D `s1 == s2` on `const(char)[]`).
 * Equal iff same length AND same bytes. This is the canonical comparison for `DString`;
 * `===` would only test `Uint8Array` reference identity. Cost: O(min length), early-out on
 * length mismatch.
 */
export function dsEquals(a: DString, b: DString): boolean {
    if (a === b) return true;            // same object: trivially equal (fast path)
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/**
 * Byte count of a char-slice (D `s.length`). Identity wrapper for `08 §11`'s
 * "`.length` = byte count" invariant, so call sites translating `s.length` on a D
 * char-slice can name the contract explicitly.
 */
export function dsLength(s: DString): number {
    return s.length;
}

/**
 * Independent copy of `[start, end)` (D `s[start .. end]`). Defaults span the whole slice.
 * Returns a NEW buffer (does not alias `s`), matching `Uint8Array.prototype.slice`. Use
 * `dsSubslice` for a shared view. Out-of-range indices clamp per `Uint8Array.slice`.
 */
export function dsSlice(s: DString, start = 0, end: number = s.length): DString {
    return s.slice(start, end);
}

/**
 * Shared VIEW of `[start, end)` onto the same buffer (no copy). Mutating the view mutates
 * `s` and vice versa. Use where D took a sub-slice without `.dup` (a view, the common lexer
 * case); use `dsSlice` when an independent copy is required.
 */
export function dsSubslice(s: DString, start = 0, end: number = s.length): DString {
    return s.subarray(start, end);
}

/**
 * Concatenate char-slices into one fresh `DString` (D `s1 ~ s2 ~ …`). Returns a new buffer;
 * inputs are unchanged. Empty input list yields an empty `DString`.
 */
export function dsConcat(...parts: DString[]): DString {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}

/** The empty char-slice — a shared zero-length `DString` (immutable in practice; never written). */
export const dsEmpty: DString = new Uint8Array(0);

/**
 * `cstrlen(p)` — the LOGICAL length of a C-string held in a `DString` (resolution #4, doc home
 * 02 §11): the number of bytes BEFORE the first NUL (`0x00`). C's `strlen`.
 *
 * The byte model: a NUL-terminated `DString` (e.g. `OutBuffer.extractChars`/`peekChars`,
 * `Loc.toChars`) carries the trailing `0x00` as part of its `.length`, but the logical C-string is
 * only the bytes up to that terminator. A `DString` with no embedded NUL (the common slice case)
 * has `cstrlen == .length`. Cost: O(length-until-NUL), one scan.
 *
 * Idioms this supports (02 §11): `"if (*p)"` → `p.length > 0 && p[0] !== 0` (or `cstrlen(p) > 0`);
 * `"*p == 0"` → `p[0] === 0` (or `cstrlen(p) === 0`).
 */
export function cstrlen(p: DString): number {
    let n = 0;
    while (n < p.length && p[n] !== 0) n++;
    return n;
}

/**
 * `cstr(p)` — the LOGICAL C-string VIEW of a NUL-terminated `DString` (resolution #4, doc home
 * 02 §11): the bytes before the first NUL, as a `subarray` (shared view, no copy). This is the
 * value a C `%s`/`fprintf` would print from a `char*`, which stops at the terminator.
 *
 * Use at the `const(char)*` → `%s`-argument boundary (errorsink's `loc.toChars()` is NUL-terminated;
 * `%s` must see only the bytes before the NUL). If `p` has no NUL the view spans all of `p`.
 * Shares `p`'s backing store; mutating either is visible through both. Cost: O(1) after one
 * `cstrlen` scan; no allocation.
 */
export function cstr(p: DString): DString {
    return p.subarray(0, cstrlen(p));
}
