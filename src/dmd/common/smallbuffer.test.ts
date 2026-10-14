// Ported from dmd/common/smallbuffer.d unittest (smallbuffer.d:97-107). 10-tests-diagnostics.md §1.
//
// The D unittest asserts on SLICE IDENTITY (`is` / `!is`): `a[] is buf[0 .. 10]` means the
// SmallBuffer's slice SHARES the caller's backing store; `b[] !is buf[]` means b allocated its
// own. With the `Uint8Array` model (08 §11) a D slice is a (buffer, byteOffset, length) triple;
// `subarray` shares the backing `ArrayBuffer`, a freshly `new Uint8Array(n)` does not. So D `is`
// on two slices ⟺ same `.buffer` AND same `.byteOffset` AND same `.length` — `sliceIs` below.
// (Verified with node: `buf.subarray(0,10).buffer === buf.buffer`; a fresh array's buffer differs.)
import { describe, it, expect } from "vitest";
import { SmallBuffer } from "./smallbuffer.js";
import type { DString } from "../../dstring.js";

/**
 * D `s1 is s2` on two char-slices: the SAME slice (same backing store, same offset, same length).
 * For `Uint8Array` views this is buffer identity + offset + length — NOT byte-content equality
 * (that would be `dsEquals`) and NOT object `===` (`subarray` returns a fresh view object even
 * when it aliases the same bytes).
 */
function sliceIs(a: DString, b: DString): boolean {
    return a.buffer === b.buffer && a.byteOffset === b.byteOffset && a.length === b.length;
}

describe("smallbuffer", () => {
    // Faithful port of the in-source D `unittest` (smallbuffer.d:97-107) over SmallBuffer!char.
    it("SmallBuffer!char (D unittest port)", () => {
        // D `char[230] buf = void;` — an uninitialized 230-byte backing store (02 §7, 08 §11).
        const buf = new Uint8Array(230);

        // D `auto a = SmallBuffer!char(10, buf);` — 10 <= 230, so `a` slices INTO `buf`.
        const a = new SmallBuffer(10, buf);
        // D `assert(a[] is buf[0 .. 10]);` — a's slice shares buf's backing store at [0,10).
        // `a[]` (via `alias this`) -> opSliceAll(); `buf[0 .. 10]` -> buf.subarray(0, 10).
        expect(sliceIs(a.opSliceAll(), buf.subarray(0, 10))).toBe(true);

        // D `auto b = SmallBuffer!char(1000, buf);` — 1000 > 230, so `b` ALLOCATES fresh storage.
        const b = new SmallBuffer(1000, buf);
        // D `assert(b[] !is buf[]);` — b's slice does NOT share buf's backing store.
        expect(sliceIs(b.opSliceAll(), buf.subarray(0, buf.length))).toBe(false);

        // D `b.create(1000);` — already 1000; 1000 <= 1000 takes the reuse path (no realloc).
        b.create(1000);
        // D `assert(b.length == 1000);` — `b.length` (via `alias this`) -> b.length getter.
        expect(b.length).toBe(1000);
        // D `assert(b[] !is buf[]);` — still on b's own storage, not buf's.
        expect(sliceIs(b.opSliceAll(), buf.subarray(0, buf.length))).toBe(false);
    });

    // The `@disable this()` contract: no default construction. `new SmallBuffer()` is a TS type
    // error (the ctor params are required) — the faithful analogue of D rejecting the default ctor
    // (03 §6.5). Asserted at the type level; a runtime no-op test documents the intent.
    it("requires len + buffer (no default construction)", () => {
        const sb = new SmallBuffer(3, new Uint8Array(8)); // 3 <= 8: slices into the buffer
        expect(sb.length).toBe(3);
        // @ts-expect-error — `@disable this()`: SmallBuffer has no zero-argument constructor.
        const bad = () => new SmallBuffer();
        void bad; // referenced so noUnusedLocals is satisfied; not invoked (it is a type assertion)
    });

    // create() grows from a small reused slice: 3 <= 5? no, allocate; then shrink 5 -> 2 reuses.
    // Mirrors the ldc2 probe (/tmp/sbprobe.d): create(len) reuses when len <= _extent.length.
    it("create() reuses on shrink, reallocates on grow", () => {
        const back = new Uint8Array(5);
        const c = new SmallBuffer(3, back); // 3 <= 5: slices into `back`
        expect(c.length).toBe(3);
        expect(sliceIs(c.opSliceAll(), back.subarray(0, 3))).toBe(true);

        c.create(5); // 5 > 3 (current _extent.length): allocate fresh storage, leave `back`
        expect(c.length).toBe(5);
        expect(sliceIs(c.opSliceAll(), back.subarray(0, 5))).toBe(false);

        c.create(2); // 2 <= 5: reuse (shrink) the allocated storage in place
        expect(c.length).toBe(2);
    });

    // `alias extent this;` forwarding of element write: `sb[i] = v` mutates the SHARED backing
    // store when the SmallBuffer slices into the caller's buffer (smallbuffer.d:93). Mirrors the
    // ldc2 probe: `d[0] = 'A'` makes `buf3[0] == 'A'`.
    it("opIndexAssign through a shared slice mutates the caller's buffer", () => {
        const back = new Uint8Array([0x78, 0x79, 0x7a, 0x77]); // 'x','y','z','w'
        const d = new SmallBuffer(4, back); // 4 <= 4: shares `back`
        d.opIndexAssign(0x41, 0); // d[0] = 'A'
        expect(back[0]).toBe(0x41); // write forwarded to the shared backing store
        // D `d[$ - 1]` -> d.opIndex(d.opDollar() - 1) (05 §7): the last byte, 'w'.
        expect(d.opIndex(d.opDollar() - 1)).toBe(0x77);
    });

    // toCStringThen usage shape (root/string.d:100): fill a SmallBuffer slice, NUL-terminate.
    // Confirms opSlice (sub-range) and element writes interoperate over the shared store.
    it("fill-and-terminate usage (root/string.d toCStringThen shape)", () => {
        const small = new Uint8Array(512);
        const src = new Uint8Array([0x48, 0x69]); // "Hi"
        const len = src.length + 1; // +1 for the NUL, as in toCStringThen
        const sb = new SmallBuffer(len, small); // 3 <= 512: shares `small`
        const ptr = sb.opSliceAll(); // `scope ptr = sb[];`
        ptr.set(src, 0); // `ptr[0 .. src.length] = src[];`
        ptr[src.length] = 0; // `ptr[src.length] = '\0';`
        expect(Array.from(ptr)).toEqual([0x48, 0x69, 0x00]);
        expect(small[0]).toBe(0x48); // shared with the caller's buffer
    });
});
