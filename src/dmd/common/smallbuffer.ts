// Port of dmd/common/smallbuffer.d — a small-size-optimized temporary array.
//
// RUNTIME MODULE (root-runtime exemption, 00 §0.1 + 08 intro): SmallBuffer is a low-level
// allocation/slice container whose entire D body is raw-memory machinery (malloc/free, a
// `~this` destructor, a byte-size overflow guard) that exists only because D has no GC here.
// So the faithful-1:1 rule is RELAXED: we implement the OBSERVABLE CONTRACT — the public API
// and its slice-sharing behavior — over a JS `Uint8Array`, and DROP the raw-memory plumbing.
// Every dropped D construct carries a one-line `// dropped:` comment mapping it to its dmd line.
//
// WHAT SmallBuffer DOES: it wraps an `Element[]` slice (`_extent`). If the requested `len`
// fits in the caller's fixed-length backing `buffer`, it slices into that buffer (no
// allocation, shared backing). Otherwise it allocates fresh storage. It is meant to be used
// exclusively as an automatic variable — not default-constructible, not copyable.
//
// MONOMORPHIZED to Element = char (03 §2b, 08 "Container representation"). The D struct is
// generic `SmallBuffer(Element)`, but its slice-identity semantics (D `is`/`!is` over a slice
// that SHARES the caller's backing store) can only be reproduced for a byte slice via
// `Uint8Array.subarray` (a shared view onto the same ArrayBuffer). The live POSIX
// instantiations are ALL `SmallBuffer!char` (root/string.d:100 toCStringThen, root/speller.d:67,161);
// the two `SmallBuffer!wchar` uses (vsoptions.d:596, root/filename.d:1217) are inside
// `version(Windows)` paths (Windows OFF, _config.md). So `char` (a `DString`/`Uint8Array`
// byte slice, 08 §11) is the only element type the port needs, and it is exactly the type
// whose slice identity `Uint8Array` reproduces. If a non-`char` instantiation ever becomes
// live, this must be revisited (escalate per 03 §2b) — a generic JS array cannot reproduce
// D slice-share identity.
//
// VERSION RESOLUTIONS (_config.md):
//   - dropped: `version(Windows) wchar[] toWStringz(...)` (smallbuffer.d:116) — Windows OFF.
//   - dropped: `version(Windows) auto extendedPathThen(alias F)(...)` (smallbuffer.d:157) — Windows OFF.
//     Both are Win32-path helpers (MultiByteToWideChar / GetFullPathNameW); no POSIX use.

import { assert } from "../../assert.js";
import type { DString } from "../../dstring.js";

// dropped: `nothrow:` / `@nogc:` attribute blocks (smallbuffer.d:13,31,32) — 04 §8 ERASE.
// dropped: `import core.stdc.stdlib : malloc, free;` (smallbuffer.d:26) — JS GC, no manual alloc.

/**
 * `SmallBuffer` — faithful port of D's `struct SmallBuffer(Element)` (smallbuffer.d:24),
 * monomorphized to `Element = char` (a `DString` = `Uint8Array` byte slice; see module header).
 *
 * Defines a temporary array of bytes using a fixed-length buffer as back store. If the
 * requested length fits the caller's buffer it slices into it (shared backing, no copy);
 * otherwise it allocates a fresh `Uint8Array`.
 *
 * Value-vs-reference / copy discipline (03):
 *   - D `@disable this()` (smallbuffer.d:34): NO default ctor. Enforced here by making the
 *     `len`/`buffer` ctor parameters REQUIRED — `new SmallBuffer()` is a TS type error,
 *     the faithful analogue of D rejecting a default-constructed SmallBuffer (03 §6.5).
 *   - D `@disable this(ref const SmallBuffer!Element)` (smallbuffer.d:35): NON-COPYABLE,
 *     non-assignable. So NO `.copy()` is emitted (03 §6.2/§6.5). The frontend only ever uses
 *     it as an automatic variable passed by ref — as a TS class it is already a reference,
 *     and there is no copy point to honor.
 *
 * `_extent` is a SHARED VIEW (`subarray`) when it points into the caller's buffer: writing
 * through the buffer (`opIndexAssign`, the `[]` slice) mutates the caller's backing store,
 * exactly as D's slice-into-the-buffer does. When storage is freshly allocated, `_extent` is
 * its own independent buffer.
 */
export class SmallBuffer {
    // D `private Element[] _extent;` (smallbuffer.d:28) — the live byte slice. A `Uint8Array`
    // view: `subarray` when it shares the caller's buffer, an owned buffer when allocated.
    // D module-private; kept TS-private (no sibling/unittest reads `_extent` directly).
    private _extent: DString;
    // dropped: `private bool needsFree;` (smallbuffer.d:29) — its ONLY reader is the `~this`
    // destructor's `if (needsFree) free(_extent.ptr);` (smallbuffer.d:61), which is itself
    // dropped (JS GC, 03 §8). With the destructor gone the flag has no observable effect, so
    // carrying it would be a write-only field. Dropped together with the free machinery.

    /**
     * Construct a SmallBuffer (smallbuffer.d:43 `this(size_t len, return scope Element[] buffer)`).
     *
     * @param len    number of elements (bytes) in the array.
     * @param buffer the caller's fixed-length backing store; used in place if `len` fits.
     *
     * If `len <= buffer.length`, `_extent` is a SHARED view of `buffer[0 .. len]` (no copy,
     * no allocation) — mutations are visible through `buffer`. Otherwise a fresh `Uint8Array`
     * of `len` bytes is allocated (D `malloc`; here `new Uint8Array(len)`).
     *
     * Postcondition (D `assert(this.length == len)`, smallbuffer.d:56): reproduced.
     */
    constructor(len: number, buffer: DString) {
        if (len <= buffer.length) {
            // D `_extent = buffer[0 .. len];` (smallbuffer.d:47) — a slice that SHARES the
            // caller's backing store. `subarray` (08, dstring.ts) is the shared-view form.
            this._extent = buffer.subarray(0, len);
        } else {
            // dropped: `assert(len < size_t.max / (2 * Element.sizeof));` (smallbuffer.d:51) —
            // overflow guard for the raw `malloc(len * Element.sizeof)` byte multiply. N/A in a
            // GC'd JS port: there is no manual byte-size multiply, and `new Uint8Array` grows on
            // demand (09 §1.3 — drop the guard, never emit `-1`/SIZE_MAX into the arithmetic).
            // D `_extent = (cast(...) malloc(len * Element.sizeof))[0 .. len];` (smallbuffer.d:52)
            this._extent = new Uint8Array(len);
            // dropped: `_extent.ptr || assert(0, "Out of memory.");` (smallbuffer.d:53) —
            // `new Uint8Array` throws RangeError on OOM; there is no null pointer to check.
            // dropped: `needsFree = true;` (smallbuffer.d:54) — gated only the dropped destructor.
        }
        assert(this.length === len); // D `assert(this.length == len);` (smallbuffer.d:56)
    }

    // dropped: `~this()` (smallbuffer.d:59-63) — `if (needsFree) free(_extent.ptr);`. JS GC
    // reclaims the buffer; there is no deterministic free to reproduce (03 §8).

    /**
     * Resize an existing SmallBuffer (smallbuffer.d:70 `scope void create(size_t len)`).
     *
     * If `len <= _extent.length`, reuse the existing storage (shrink/keep the view). Otherwise
     * allocate fresh storage of `len` bytes (the old storage is dropped — D frees it via
     * `__dtor()`; here the JS GC reclaims it).
     *
     * Postcondition (D `assert(this.length == len)`, smallbuffer.d:84): reproduced.
     */
    create(len: number): void {
        if (len <= this._extent.length) {
            // D `_extent = _extent[0 .. len];` (smallbuffer.d:74) — reuse existing storage. A
            // `subarray` of the current view stays on the SAME backing buffer (shrink in place).
            this._extent = this._extent.subarray(0, len);
        } else {
            // D `__dtor();` (smallbuffer.d:78) — free the old storage. Erased: JS GC reclaims the
            // old `_extent` once it is no longer referenced (the reassignment below drops it).
            // dropped: `assert(len < size_t.max / Element.sizeof);` (smallbuffer.d:79) — same
            // overflow guard as the ctor; N/A in a GC'd port (09 §1.3).
            // D `_extent = (cast(...) malloc(len * Element.sizeof))[0 .. len];` (smallbuffer.d:80)
            this._extent = new Uint8Array(len);
            // dropped: `_extent.ptr || assert(0, "Out of memory.");` (smallbuffer.d:81) — see ctor.
            // dropped: `needsFree = true;` (smallbuffer.d:82) — gated only the dropped destructor.
        }
        assert(this.length === len); // D `assert(this.length == len);` (smallbuffer.d:84)
    }

    /**
     * The backing slice (smallbuffer.d:88 `scope inout extent() { return _extent; }`).
     *
     * D forwards member access on the SmallBuffer to this slice via `alias extent this;`
     * (smallbuffer.d:93). TS has no `alias this`, so the forwarding is reproduced explicitly:
     * `extent()` is the accessor, and `opSliceAll`/`length`/`opIndex`/`opIndexAssign`/`opDollar`
     * below forward the `[]`/`[i]`/`.length`/`$` operations onto `_extent` (05 §7).
     *
     * Returns the slice itself (a shared view onto the backing store) — NOT a copy — so the D
     * slice-identity semantics (`sb[] is buffer[0 .. len]`) are preserved.
     */
    extent(): DString {
        return this._extent;
    }

    // ── `alias extent this;` forwarding (smallbuffer.d:93) ──────────────────────────────────────
    // D's `alias extent this;` makes every `Element[]` operation on a SmallBuffer forward to
    // `_extent`. The frontend uses `sb[]` (the whole slice), `sb.length`, `sb[i]`, `sb[i] = v`,
    // `sb[$ - 1]`. Each is rewritten to the corresponding method below (05 §7). GUIDE GAP:
    // 02 §5.3 states `alias this` "does not occur as a live construct in the frontend's portable
    // subset; if you meet one, STOP and escalate" — but it IS live here (and smallbuffer.d is an
    // in-scope Bucket-3 module). Resolved by reproducing the member-forwarding explicitly; flagged
    // as a gap in the escalation report rather than halting (the forwarding target is unambiguous:
    // it is the `_extent` slice).

    /** D `sb[]` (whole slice, via `alias this` → `_extent[]`) → `opSliceAll()` (05 §7). */
    opSliceAll(): DString {
        return this._extent;
    }

    /** D `sb[lo .. hi]` (sub-slice, via `alias this`) → `opSlice(lo, hi)` (05 §7). Shared view. */
    opSlice(lo: number, hi: number): DString {
        return this._extent.subarray(lo, hi);
    }

    /** D `sb.length` (via `alias this` → `_extent.length`). Byte count of the slice. */
    get length(): number {
        return this._extent.length;
    }

    /** D `sb[i]` read (via `alias this`) → `opIndex(i)` (05 §7). One byte (0–255). */
    opIndex(i: number): number {
        return this._extent[i];
    }

    /** D `sb[i] = v` write (via `alias this`) → `opIndexAssign(v, i)` — (value, index) order (05 §7). */
    opIndexAssign(v: number, i: number): void {
        this._extent[i] = v;
    }

    /** D `$` inside `sb[ … $ … ]` (via `alias this` → `_extent.length`) → `opDollar()` (05 §7). */
    opDollar(): number {
        return this._extent.length;
    }
}

// dropped: `version(Windows) wchar[] toWStringz(scope const(char)[] narrow, ref SmallBuffer!wchar buffer)`
//   (smallbuffer.d:116-141) — Windows-only narrow→wide conversion (MultiByteToWideChar). Windows OFF
//   (_config.md). No POSIX caller. Upstream 2.113 reworked this body (CP_ACP/IN_LLVM CodePage → a
//   flat CP_UTF8; the "buffer too small" retry now reads GetLastError()==ERROR_INSUFFICIENT_BUFFER
//   and re-measures with an empty destination) — still entirely Win32, so still dropped.
// dropped: `version(Windows) auto extendedPathThen(alias F)(const(char)[] path)`
//   (smallbuffer.d:157-211) — Windows long-path (`\\?\`) helper (GetFullPathNameW). Windows OFF.
