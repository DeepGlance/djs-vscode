// Port of dmd/root/string.d — D byte-string helpers.
// Contract: docs/porting/08-runtime-lib.md §8. Read it (and §11 DString, §0 invariants) before
// changing this file.
//
// THE GOVERNING INVARIANTS (08 §0, §8):
//   - EVERYTHING here is byte-level. A D `const(char)[]` / `string` is a DString (Uint8Array);
//     `.length` is a byte count and `s[i]` is a byte 0..255. There is NO UTF-8 decoding anywhere
//     in this module — the doc comments in string.d:46/:214 stress "no decoding". `iequals`,
//     `dstrcmp`, `findSplit`, `splitLines` all match raw bytes.
//   - C ASCII `toupper` (default C locale) maps ONLY a..z → A..Z; every other byte (digits,
//     punctuation, all high bytes >= 0x80) passes through unchanged (verified full-range against
//     ldc2-1.42.0 in port.ts). So `toUpperAscii` reproduces it EXACTLY. NEVER use JS
//     `.toUpperCase()` (locale/Unicode-aware → wrong).
//   - DString equality is byte content, never `===` (which is Uint8Array reference identity).
//     Internal byte compares are open-coded; call sites comparing two char-slices use this
//     module's `dstrcmp` / dstring's `dsEquals`.

import { cstrlen } from "../../dstring.js";
import type { DString } from "../../dstring.js";

/// C `toupper` in the default C locale, at the byte level: a..z (0x61..0x7A) → A..Z (b-0x20),
/// every other byte unchanged. The canonical ASCII-uppercase helper for byte-string code (§8:
/// "Use a byte-level `toUpperAscii`, NOT JS `.toUpperCase()`"); `port.ts` (§16) imports it from
/// here so there is one definition. Cost: O(1), no allocation.
export function toUpperAscii(b: number): number {
    return b >= 0x61 && b <= 0x7a ? b - 0x20 : b;
}

/// Slice a C-string to its NUL terminator, excluding it (string.d:17).
///
/// In D this walks `strlen(s)` over a `char*`. A DString carries its own length, but every
/// `extractChars()` result (toChars, toErrMsg, …) also carries D's trailing NUL (02 §11.2), so this
/// stops at the first NUL as D does. `null` → `null` (D returns `null` for a null pointer, string.d:20).
/// Cost: O(n) scan; returns `s` itself when it holds no NUL, else a view (`subarray`) that shares its
/// storage — no copy either way.
export function toDString(s: DString | null): DString | null {
    if (s === null)
        return null;
    const n = cstrlen(s);
    return n === s.length ? s : s.subarray(0, n);
}

/// Returns: a `(length, ptr)` tuple for passing a D string to `printf`-style functions with the
/// format string `%.*s` (string.d:29, `fTuple`). In D `FTuple!(int, const(char)*)` is `.expand`-ed
/// into the variadic arg list; in the DString model a `%.*s` argument is the pair `[length, slice]`
/// (10 §3.5: `%.*s` reads `cast(int)len, ptr` from the args), so the tuple is a 2-element array the
/// call site spreads with `...str.fTuple()`. Cost: O(1), no copy (the slice is the same object).
export function fTuple(str: DString): [number, DString] {
    return [str.length, str];
}

/// Case-insensitive byte equality of two char-slices (string.d:57).
///
/// Comparison is per-`char` with ASCII `toupper`; it does NOT decode UTF-8, so it is only truly
/// accurate for ASCII (string.d:46). Equal iff same length AND each byte equal after ASCII
/// case-folding. Cost: O(length), early-out on length mismatch then on the first non-equal byte.
export function iequals(s1: DString, s2: DString): boolean {
    if (s1.length !== s2.length) return false;
    for (let idx = 0; idx < s1.length; idx++) {
        const c1 = s1[idx];
        const c2 = s2[idx];
        if (c1 !== c2 && toUpperAscii(c1) !== toUpperAscii(c2)) return false;
    }
    return true;
}

/// Copy `s` into a fresh NUL-terminated buffer and return the slice EXCLUDING the NUL
/// (string.d:122).
///
/// D allocates `length+1` bytes, copies `s`, writes `\0` at `[length]`, and returns `p[0 ..
/// length]` — i.e. the returned slice's `.length` is `s.length` and the NUL sits ONE PAST the
/// end, inside the backing buffer but outside the slice (08 §8 invariant: "the NUL is NOT in the
/// slice length"). Reproduced with a subarray view over an over-allocated buffer.
///
/// In djs most C-bridging call sites disappear (file/filename use Node APIs). Keep this where a
/// frontend file still builds an indexable NUL-terminated buffer. Cost: one allocation + copy.
export function toCString(s: DString): DString {
    const length = s.length;
    const buf = new Uint8Array(length + 1);
    buf.set(s, 0);
    buf[length] = 0;
    return buf.subarray(0, length);
}

/// NUL-terminate a copy of `src` then call `dg` with it; return `dg`'s result (string.d:93).
///
/// D's allocation-less bridge to C functions. The buffer handed to `dg` has length
/// `src.length + 1` and INCLUDES the trailing NUL (verified against ldc2: `"Hello world"` → a
/// 12-byte slice ending in `0`; `""` → a 1-byte slice `[0]`). This differs from `toCString`,
/// whose returned slice EXCLUDES the NUL — preserve the distinction.
///
/// The `dg` argument is `scope` in D (the buffer must not outlive the call); in djs the buffer is
/// GC-managed, so retention is safe, but callers should still treat it as transient for fidelity.
/// Cost: one allocation + copy, then `dg`.
export function toCStringThen<R>(src: DString, dg: (z: DString) => R): R {
    const buf = new Uint8Array(src.length + 1);
    buf.set(src, 0);
    buf[src.length] = 0; // NUL terminator, INSIDE the slice passed to dg (length = src.length+1)
    return dg(buf);
}

// Unicode line terminators that span more than one byte (string.d:150-152). Single-byte
// terminators (\n \v \f \r) are matched inline; these are the multibyte UTF-8 encodings.
const NEXT_LINE_B0 = 0xc2; // NEL  = C2 85       (U+0085)
const NEXT_LINE_B1 = 0x85;
const SEP_B0 = 0xe2; //        LS = E2 80 A8, PS = E2 80 A9  (U+2028 / U+2029)
const SEP_B1 = 0x80;
const LINE_SEP_B2 = 0xa8;
const PARA_SEP_B2 = 0xa9;

/// Strip ONE leading line terminator from `str`, returning the remainder (string.d:148).
///
/// Recognized terminators (Unicode standard): `\n` `\v` `\f` `\r`, `\r\n` (two bytes), NEL
/// (C2 85), LS (E2 80 A8), PS (E2 80 A9). At most one is removed; if `str` does not begin with a
/// terminator it is returned unchanged. Byte-pattern matching only — no UTF-8 decoding.
///
/// Returns a VIEW (subarray) into `str` (D returns a slice, not a copy). Cost: O(1).
export function stripLeadingLineTerminator(str: DString): DString {
    if (str.length === 0) return str;
    switch (str[0]) {
        case 0x0d: // '\r'
            if (str.length >= 2 && str[1] === 0x0a /* '\n' */) return str.subarray(2);
            return str.subarray(1); // goto case: fall through to the single-char strip
        case 0x0b: // '\v'
        case 0x0c: // '\f'
        case 0x0a: // '\n'
            return str.subarray(1);
        case NEXT_LINE_B0:
            if (str.length >= 2 && str[1] === NEXT_LINE_B1) return str.subarray(2);
            return str;
        case SEP_B0:
            if (str.length >= 3 && str[1] === SEP_B1 && (str[2] === LINE_SEP_B2 || str[2] === PARA_SEP_B2)) {
                return str.subarray(3);
            }
            return str;
        default:
            return str;
    }
}

/// `strcmp`-style byte comparison of two char-slices (string.d:219).
///
/// Returns <0, 0, or >0. Bytes are compared UNSIGNED (D `char` is unsigned; verified: at the
/// first differing position the result is the raw `memcmp` byte difference, e.g. `0x80` vs `0x7f`
/// → positive). When one slice is a prefix of the other, the shorter compares LESS:
/// `-1` if `s1` shorter, `0` if equal length, `1` if `s1` longer (the D `(s1.length > s2.length)`
/// bool coerces to 0/1 — preserve this exact 0/1/-1 shape; it feeds `qsort`/`opCmp`).
///
/// The D `__ctfe` branch (string.d:222) is byte-equal to the runtime `memcmp` branch for our
/// purposes — collapsed to one byte compare (resolved: __ctfe vs runtime → identical byte
/// compare). NO UTF-8 decoding (string.d:214). Cost: O(min length).
export function dstrcmp(s1: DString, s2: DString): number {
    const len = s1.length <= s2.length ? s1.length : s2.length;
    for (let u = 0; u < len; u++) {
        const d = s1[u] - s2[u]; // unsigned bytes; raw memcmp-style difference
        if (d !== 0) return d;
    }
    return s1.length < s2.length ? -1 : s1.length > s2.length ? 1 : 0;
}

/// Append a NUL to `literal` and return the result (string.d:268, `toStaticArray!(N)`).
///
/// In D this is a compile-time helper coercing a string literal to a `char[N+1]` static array
/// (the trailing `0` is part of the array). The runtime-observable contract is unambiguous and
/// pinned by string.d:280 (`"123".toStaticArray == "123\0"`, length N+1, `""` → length 1): a
/// fresh buffer of `literal.length + 1` bytes, the bytes of `literal`, then a `0`. Unlike
/// `toCString`, the returned slice INCLUDES the NUL (it is `[N+1]`, not `[0 .. N]`).
/// Cost: one allocation + copy.
export function toStaticArray(literal: DString): DString {
    const out = new Uint8Array(literal.length + 1);
    out.set(literal, 0);
    out[literal.length] = 0;
    return out;
}

/// True iff `s` begins with `prefix`, byte-for-byte (string.d:320, the slice overload).
///
/// (string.d also has a `char*` overload, string.d:304; §8 specifies only the slice form.)
/// `false` if `s` is shorter than `prefix`; the empty prefix always matches. Cost: O(prefix
/// length), early-out on the first mismatch.
export function startsWith(s: DString, prefix: DString): boolean {
    if (s.length < prefix.length) return false;
    return matchesAt(s, 0, prefix);
}

/// Iterate `text` as a sequence of line slices (string.d:350), reproducing `std.string.splitLines`
/// EOL handling exactly.
///
/// Yields VIEWS (subarrays) into `text`, one per line, with the terminator stripped. A trailing
/// terminator does NOT produce a trailing empty line (verified: `"a\nb\n"` → `["a","b"]`); an
/// empty `text` yields nothing; `"\n"` yields one empty line; `"\n\n"` yields two empty lines.
/// Recognized terminators: `\v` `\f` `\n`, `\r`, `\r\n`, NEL (C2 85), LS (E2 80 A8), PS
/// (E2 80 A9) — byte-pattern matched, no decoding. Lazy: a `function*` mirroring D's InputRange.
/// Cost: O(text length) total across the full iteration.
export function* splitLines(text: DString): IterableIterator<DString> {
    let index = 0;
    const n = text.length;
    while (index < n) {
        let eolIndex = n; // end of line content (before the terminator)
        let nextIndex = n; // start of the next line (past the terminator)
        for (let i = index; i < n; ++i) {
            const c = text[i];
            if (c === 0x0b || c === 0x0c || c === 0x0a) {
                // '\v' '\f' '\n'
                eolIndex = i;
                nextIndex = i + 1;
                break;
            }
            if (c === 0x0d) {
                // '\r', with optional '\n' (CRLF)
                if (i + 1 < n && text[i + 1] === 0x0a) {
                    eolIndex = i;
                    nextIndex = i + 2;
                } else {
                    eolIndex = i;
                    nextIndex = i + 1;
                }
                break;
            }
            if (c === NEXT_LINE_B0 && i + 1 < n && text[i + 1] === NEXT_LINE_B1) {
                eolIndex = i;
                nextIndex = i + 2;
                break;
            }
            if (
                c === SEP_B0 &&
                i + 2 < n &&
                text[i + 1] === SEP_B1 &&
                (text[i + 2] === LINE_SEP_B2 || text[i + 2] === PARA_SEP_B2)
            ) {
                eolIndex = i;
                nextIndex = i + 3;
                break;
            }
        }
        yield text.subarray(index, eolIndex);
        index = nextIndex;
    }
}

/// 3-part split of `s` around the first occurrence of `needle` (string.d:453/:471).
///
/// `elem[0]` is the text before the match, `elem[1]` is the matched `needle`, `elem[2]` is the
/// text after. `found()` is the D `opCast(bool)` (string.d:459): true iff `elem[1]` is non-empty,
/// i.e. the needle was actually found. All three are VIEWS into `s`.
///
/// 05-operators.md owns the call-site rewrite of D's `if (auto s = findSplit(...))` →
/// `const s = findSplit(...); if (s.found())`.
export class FindSplit {
    readonly elem: [DString, DString, DString];
    constructor(elem: [DString, DString, DString]) {
        this.elem = elem;
    }
    /// opCast(bool) (string.d:459): truthy iff the needle was found (middle slice non-empty).
    found(): boolean {
        return this.elem[1].length > 0;
    }
    /// opIndex(i) (string.d:458): the i-th part (0 before, 1 needle, 2 after).
    opIndex(i: number): DString {
        return this.elem[i];
    }
}

/// Find the first occurrence of `needle` in `s` and split into before/needle/after (string.d:471).
///
/// Returns a `FindSplit`; `.found()` is true iff `needle` was located. When not found (including
/// when `needle` is longer than `s`), returns `[s, empty, empty]` — note `.found()` is false and
/// `[0]` is the WHOLE string. EDGE CASE (verified against ldc2): an EMPTY `needle` matches at
/// index 0, yielding `[empty, empty, s]` whose `.found()` is FALSE (middle slice is empty) — the
/// "before" part is empty and the "after" part is the whole string. Byte match, no decoding.
/// Cost: O(s.length × needle.length) worst case.
export function findSplit(s: DString, needle: DString): FindSplit {
    const empty = s.subarray(0, 0);
    if (needle.length > s.length) return new FindSplit([s, empty, empty]);
    for (let i = 0; i <= s.length - needle.length; i++) {
        if (matchesAt(s, i, needle)) {
            return new FindSplit([s.subarray(0, i), s.subarray(i, i + needle.length), s.subarray(i + needle.length)]);
        }
    }
    return new FindSplit([s, empty, empty]);
}

/// Return the substring of `s` between the first occurrence of `l` and the first subsequent
/// occurrence of `r`, or `null` if either is absent (string.d:507).
///
/// Faithful translation of D's nested `if (auto s0 = str.findSplit(l)) if (auto s1 =
/// s0[2].findSplit(r))` — both `findSplit`s must report `.found()` true. Returns a VIEW into `s`.
/// Cost: two `findSplit` scans.
export function findBetween(s: DString, l: DString, r: DString): DString | null {
    const s0 = findSplit(s, l);
    if (s0.found()) {
        const s1 = findSplit(s0.opIndex(2), r);
        if (s1.found()) return s1.opIndex(0);
    }
    return null;
}

// True iff `needle` appears in `s` starting exactly at `i`. Caller guarantees
// `i + needle.length <= s.length`. Byte compare, no decoding.
function matchesAt(s: DString, i: number, needle: DString): boolean {
    for (let j = 0; j < needle.length; j++) {
        if (s[i + j] !== needle[j]) return false;
    }
    return true;
}
