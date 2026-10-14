// Port of dmd/root/port.d — platform helpers (the "portable routines" grab-bag).
// Contract: docs/porting/08-runtime-lib.md §16. Read it before changing this file.
//
// D's `Port` is `extern(C++) struct Port` with all-`static` members, called `Port.memicmp(…)`.
// The faithful 1:1 translation is a TS class with all-static methods, same name, same call
// syntax. There is no instance state — it is a namespace of pure functions.
//
// THE GOVERNING TRANSLATIONS (08 §0, §16):
//   - D `char` is UNSIGNED (verified: `cast(int)cast(char)0x80 == 128`, not -128). A
//     `const char*` argument is a DString (Uint8Array) byte view; bytes are 0..255.
//   - C `toupper` (default C locale, which the compiler uses) maps ONLY a..z → A..Z; every
//     other byte — digits, punctuation, and all high bytes >= 0x80 — passes through unchanged
//     (verified full-range against ldc2-1.42.0). So byte-level `toUpperAscii` reproduces it
//     EXACTLY. Never use JS `.toUpperCase()` (locale/Unicode aware → wrong, 08 §8/§16).
//   - The `version(CRuntime_DigitalMars|Microsoft)` externs (port.d:23-35, :98-112, :131-145)
//     are OFF on this target → DROPPED. `isFloat*LiteralOutOfRange` take the `version(IN_LLVM)`
//     branch → pure forwarders to CTFloat (resolved: version(IN_LLVM) -> CTFloat delegate).
//   - Endian helpers operate on a `Uint8Array` + byte offset; no raw pointers (08 §0 inv.1).
//   - `valcpy`'s `uint64_t val` lives in the bigint domain (09-numerics.md); it is split into
//     `size` little-endian bytes. The D alignment assert `(cast(size_t)dst) % size == 0`
//     (port.d:204) has NO analogue (there are no addresses) → DROPPED.

import type { DString } from "../../dstring.js";
import { assertUnreachable } from "../../assert.js";
import { CTFloat } from "./ctfloat.js";
// §8/§16 both mandate the SAME byte-level C-locale `toupper` (a..z → A..Z, every other byte
// unchanged). `string.ts` is its canonical public home (§8); import it here rather than keep a
// second private copy — one definition, no drift between the §8 and §16 spellings.
import { toUpperAscii } from "./string.js";

export class Port {
    /// Case-insensitive byte compare of the first `n` bytes (C `memicmp`), port.d:41.
    ///
    /// Algorithm, verbatim: for each byte, `result = c1 - c2` (raw UNSIGNED-byte difference,
    /// −255..255). If non-zero, recompute `result = toupper(c1) - toupper(c2)`; if THAT is
    /// non-zero, stop and return it — otherwise the bytes are case-insensitively equal and the
    /// scan continues. Returns 0 iff the two `n`-byte runs are equal ignoring ASCII case; else
    /// the case-folded difference at the first differing position (C `memcmp`-style sign).
    ///
    /// Preconditions (boundary-validation.md): `n <= a.length` and `n <= b.length` — the caller
    /// (e.g. filename.d:109 passes `name1.length`) guarantees the bound; not re-checked here.
    /// Cost: O(n), early-out at the first case-insensitive difference.
    static memicmp(a: DString, b: DString, n: number): number {
        let result = 0;
        for (let i = 0; i < n; i++) {
            const c1 = a[i];
            const c2 = b[i];
            result = c1 - c2;
            if (result) {
                result = toUpperAscii(c1) - toUpperAscii(c2);
                if (result) break;
            }
        }
        return result;
    }

    /// Uppercase every byte of `s` IN PLACE (ASCII a..z only) and return the same `s`, port.d:61.
    ///
    /// D's `strupr(char* s)` walks to the NUL and returns the original pointer. A `DString` has
    /// no embedded NUL and carries its own length, so the port uppercases the whole slice and
    /// returns the SAME object (mutation is visible through every alias — matches the in-place
    /// C contract). Note: no frontend module calls it (doc.d does not either, despite the old claim);
    /// kept for §16 surface fidelity. Cost: O(length), in place (no allocation).
    static strupr(s: DString): DString {
        for (let i = 0; i < s.length; i++) s[i] = toUpperAscii(s[i]);
        return s;
    }

    /// True iff the float32 literal `s` is out of `float` range, port.d:88.
    /// resolved: version(IN_LLVM) -> CTFloat delegate (08 §16, _config.md IN_LLVM ON).
    static isFloat32LiteralOutOfRange(s: DString): boolean {
        return CTFloat.isFloat32LiteralOutOfRange(s);
    }

    /// True iff the float64 literal `s` is out of `double` range, port.d:121.
    /// resolved: version(IN_LLVM) -> CTFloat delegate (08 §16, _config.md IN_LLVM ON).
    static isFloat64LiteralOutOfRange(s: DString): boolean {
        return CTFloat.isFloat64LiteralOutOfRange(s);
    }

    /// Write the low 32 bits of `value` little-endian into `buf[off .. off+4)`, port.d:155.
    /// `value` is a 32-bit `number` domain quantity (D `uint`); only its low 4 bytes are used.
    static writeLongLE(buf: DString, off: number, value: number): void {
        buf[off + 0] = value & 0xff;
        buf[off + 1] = (value >>> 8) & 0xff;
        buf[off + 2] = (value >>> 16) & 0xff;
        buf[off + 3] = (value >>> 24) & 0xff;
    }

    /// Read 4 little-endian bytes at `buf[off …]` as an unsigned 32-bit `number`, port.d:165.
    /// `>>> 0` keeps the result in 0 .. 2^32-1 (the D `uint` domain).
    static readLongLE(buf: DString, off: number): number {
        return ((buf[off + 3] << 24) | (buf[off + 2] << 16) | (buf[off + 1] << 8) | buf[off]) >>> 0;
    }

    /// Write the low 32 bits of `value` big-endian into `buf[off .. off+4)`, port.d:172.
    static writeLongBE(buf: DString, off: number, value: number): void {
        buf[off + 0] = (value >>> 24) & 0xff;
        buf[off + 1] = (value >>> 16) & 0xff;
        buf[off + 2] = (value >>> 8) & 0xff;
        buf[off + 3] = value & 0xff;
    }

    /// Read 4 big-endian bytes at `buf[off …]` as an unsigned 32-bit `number`, port.d:182.
    static readLongBE(buf: DString, off: number): number {
        return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
    }

    /// Read 2 little-endian bytes at `buf[off …]` as an unsigned 16-bit `number`, port.d:189.
    static readWordLE(buf: DString, off: number): number {
        return ((buf[off + 1] << 8) | buf[off]) >>> 0;
    }

    /// Read 2 big-endian bytes at `buf[off …]` as an unsigned 16-bit `number`, port.d:196.
    static readWordBE(buf: DString, off: number): number {
        return ((buf[off] << 8) | buf[off + 1]) >>> 0;
    }

    /// Write the low `size` bytes of `val` little-endian into `buf[off …]`, port.d:202.
    ///
    /// `size` is one of 1/2/4/8. `val` is a 64-bit value (D `uint64_t`) → bigint domain
    /// (09-numerics.md); only its low `size` bytes are stored (higher bytes are truncated away,
    /// matching the C `cast(ubyte|ushort|uint|ulong)val`). The D alignment assert is dropped
    /// (no addresses in JS). A `size` outside {1,2,4,8} hits the D `default: assert(0)` →
    /// `assertUnreachable()` (08 §12). Used by CTFE string/array fold (constfold.d, ctfeexpr.d).
    static valcpy(buf: DString, off: number, val: bigint, size: number): void {
        if (size !== 1 && size !== 2 && size !== 4 && size !== 8) assertUnreachable();
        let v = val;
        for (let i = 0; i < size; i++) {
            buf[off + i] = Number(v & 0xffn);
            v >>= 8n;
        }
    }
}
