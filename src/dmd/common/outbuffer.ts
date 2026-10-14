// Port of dmd/common/outbuffer.d — an expandable byte buffer / string builder.
//
// RUNTIME MODULE (root-runtime exemption, 00 §0.1 + 08 intro): OutBuffer is a low-level
// IO/buffer container, so the faithful-1:1 rule is RELAXED. We implement the OBSERVABLE
// CONTRACT — the public methods and their byte-level behavior — over a JS `Uint8Array`, and
// DROP the raw-memory machinery that exists only because D has no GC here. Every dropped D
// construct carries a one-line `// dropped:` comment mapping it to its dmd line.
//
// CANONICAL MODEL: a `Uint8Array data` (the backing store) plus an `offset` (logical length,
// = D's `offset`). Unlike `Array!T` (08 §2), OutBuffer's whole contract IS byte manipulation
// (memmove/memset, little-endian 16/32-bit stores), so we keep `data`/`offset` and a real
// `reserve` that grows the typed array — that is the observable semantics, not droppable
// allocation tuning. `notlinehead`/`doindent`/`spaces`/`level` are the indent state, kept.
//
// GOVERNING TRANSLATIONS / RESOLUTIONS:
//   - resolved: version(Windows) -> false (_config.md). `writenl`/`writewchar`/`writeword`/
//     `write4` Windows (CR,LF / 0x0A0D) branches dropped; POSIX `'\n'` branch kept.
//   - dropped: malloc/realloc/free, debug(stomp) memset stomping, the `~this`/`dtor`/`destroy`
//     free machinery — JS GC reclaims `data`. `destroy()`/`reset()` keep their OBSERVABLE
//     effect (empty the buffer) without freeing.
//   - dropped (STOP-stub): the FileMapping store — the file-mapping ctor, `moveToFile`, and the
//     `fileMapping` branches of reserve/destroy. `common/file.ts` STOP-stubs `FileMapping`
//     (mmap/pointer layout, no faithful JS model); OutBuffer's RAM store is the only live path.
//   - dropped: `buf()`/`bufptr()` raw `ubyte*`/`ubyte**` accessors (porting aids for the C++
//     backend Outbuffer; pointer-into-store has no JS analogue, not used by the frontend).
//   - dropped: `extractData()`/`extractChars()`/`peekChars()` C-`char*` returns are reshaped to
//     return a DString (08 §11: a C-string is a DString, no embedded NUL needed by callers).
//   - A D `const(char)[]` / `string` / `ubyte[]` is a DString (Uint8Array); a `const(void)[]`
//     payload is a Uint8Array.

import { assert, assertUnreachable } from "../../assert.js";
import { dmdformat } from "../root/dmdformat.js";
import type { DString } from "../../dstring.js";

// dropped: `nothrow:` / `extern (C++)` / `pure` / `@safe` / `@trusted` / `@nogc` / `scope`
// attributes (04 §8 — ERASE all). dropped: pureMalloc/pureRealloc/pureFree extern(C) decls
// (outbuffer.d:23-28) and `debug = stomp` (outbuffer.d:30-33) — raw alloc + GC-stomp, JS GC.

/**
 * `OutBuffer` is a write-only output stream of untyped bytes, backed by a contiguous
 * `Uint8Array`. (D backs it by a contiguous array OR a memory-mapped file; the file-mapping
 * store is STOP-stubbed — see module header — so only the RAM store is live here.)
 *
 * Value-vs-reference: D's `OutBuffer` is a `struct` (value type), but the frontend always
 * passes it by `ref`/pointer (`write(OutBuffer*)`, `error(..., OutBuffer*)`); it is never
 * copied by value. So it is ported as a `class` (reference) — there is no `.copy()` discipline
 * to apply (03 §7: a `Struct*` used as an alias is the class ref). Carries no `opAssign`/
 * `this(this)`, so this is faithful.
 */
export class OutBuffer {
    // state { — KEEP STATE IN SYNC WITH ./outbuffer.h per the upstream comment (informational).
    private data: Uint8Array = new Uint8Array(0); // private ubyte[] data;
    private offset = 0; // private size_t offset;  (logical length)
    private notlinehead = false; // private bool notlinehead;
    // dropped: `private FileMapping!ubyte* fileMapping;` (outbuffer.d:50) — file-mapping store
    // STOP-stubbed (common/file.ts). The RAM `data` store is the only live store.
    doindent = false; // bool doindent;   — whether to indent
    spaces = false; // bool spaces;        — indent by 4 spaces (true) or by tabs (false)
    level = 0; // int level;               — current indent level
    // state }

    /**
     * Construct, optionally reserving `initialSize` bytes up front (outbuffer.d:64).
     * The file-mapping ctor `this(const(char)* filename)` (outbuffer.d:76) is DROPPED — it maps
     * a file via the STOP-stubbed FileMapping; not reachable in the lex→sema→CTFE pipeline.
     */
    constructor(initialSize = 0) {
        if (initialSize) this.reserve(initialSize);
    }

    // dropped: `dtor()` (outbuffer.d:89) / `~this()` (outbuffer.d:106) — free the store / stomp
    // memory. JS GC reclaims `data`; there is no deterministic-cleanup contract to preserve
    // (11 §3.7: an order/timing-free dtor is erasable).

    // dropped: `buf()` (outbuffer.d:112) / `bufptr()` (outbuffer.d:117) — raw `ubyte*`/`ubyte**`
    // accessors for porting the C++ backend Outbuffer. Pointer-into-store has no JS analogue and
    // the frontend does not use them.

    /** Logical length of the buffer in bytes (outbuffer.d:124, `extern (C++) length`). */
    length(): number {
        return this.offset;
    }

    /**
     * Transfer ownership of the data to the caller and reset to empty (outbuffer.d:131).
     * D returns the raw `char*`; here it returns the DString view of the live contents
     * `[0 .. offset]` (a COPY, since we then clear our own reference). Cost: one O(n) copy.
     */
    extractData(): DString {
        const p = this.data.slice(0, this.offset);
        this.data = new Uint8Array(0); // data = null;
        this.offset = 0;
        return p;
    }

    /**
     * Release the contents and reset to an empty RAM buffer (outbuffer.d:144). The config
     * flags (`notlinehead`/`doindent`/…) are NOT changed. dropped: `dtor()` + `fileMapping=null`
     * (no file store, JS GC) — the observable effect is "buffer is now empty".
     */
    destroy(): void {
        this.data = new Uint8Array(0); // data = null;
        this.offset = 0;
    }

    /**
     * Reserve `nbytes` of additional capacity so the store can hold `offset + nbytes` bytes
     * (outbuffer.d:159). Grows the `Uint8Array` by the same 1.5x-rounded-to-16 formula D uses,
     * so capacity growth is observable-identical. dropped: the fileMapping.resize branch
     * (no file store) and the debug(stomp)/realloc raw-alloc plumbing — a new typed array +
     * `.set` copy reproduces realloc.
     *
     * Cost: O(offset) on a grow (copies the live bytes), O(1) when capacity already suffices.
     */
    reserve(nbytes: number): void {
        const minSize = this.offset + nbytes;
        if (this.data.length >= minSize) return;

        // Increase by factor of 1.5; round up to 16 bytes (outbuffer.d:169). D computes in size_t: the
        // division truncates and `& ~15` clears the low bits of a 64-bit value. A JS `&` would truncate to
        // int32 and go negative past 2^31 (a 1.4 GB buffer threw RangeError), so the low bits are cleared
        // arithmetically, exact up to 2^53.
        const half = Math.floor((minSize * 3 + 30) / 2);
        const size = half - (half % 16);

        const p = new Uint8Array(size);
        p.set(this.data.subarray(0, this.offset)); // memcpy live bytes (realloc preserves them)
        this.data = p;
    }

    /**
     * Shrink the logical length to `size` (outbuffer.d:202). Precondition: `size <= capacity`.
     * The boundary is the caller; inside we assert the documented invariant (boundary-validation:
     * a loud `assert`, never a silent clamp).
     */
    setsize(size: number): void {
        assert(size <= this.data.length);
        this.offset = size;
    }

    /** Reset the logical length to 0, keeping the allocated store (outbuffer.d:208). */
    reset(): void {
        this.offset = 0;
    }

    // indent() (outbuffer.d:213) — emit the current indent (tabs or 4-space stops). D declares it
    // `private`, but `private` in D is MODULE-private: the in-module unittest (outbuffer.d:970)
    // calls `buf.indent()` directly. TS `private` blocks the co-located .test.ts, so it is kept
    // public to preserve that observable test path; the frontend itself only calls it internally.
    indent(): void {
        if (this.level) {
            const indentLevel = this.spaces ? this.level * 4 : this.level;
            this.reserve(indentLevel);
            // data[offset .. offset+indentLevel] = (spaces ? ' ' : '\t');
            this.data.fill(this.spaces ? 0x20 /* ' ' */ : 0x09 /* '\t' */, this.offset, this.offset + indentLevel);
            this.offset += indentLevel;
        }
        this.notlinehead = true;
    }

    // dropped: `writen(const void*, len)` (outbuffer.d:227) — no-reserve raw-pointer copy. The
    // pointer overload is unused by the frontend; the byte/slice writers below cover the contract.

    // `alias put = write;` (outbuffer.d:233): D's output-range `put`. The overload set of
    // `write` is named explicitly here (TS has no overload-by-static-type), so `put` becomes the
    // dispatcher below; call sites of `put`/`write` pick the typed method.

    /**
     * D `put`/`write` output-range entry point: append `buf`'s bytes (outbuffer.d:240,
     * the `const(void)[]`/`string` overloads — identical bodies). Honors indent state.
     * `buf` is a DString / byte slice. Cost: reserve (amortized O(1)) + O(buf.length) copy.
     */
    write(buf: DString): void {
        if (this.doindent && !this.notlinehead) this.indent();
        this.reserve(buf.length);
        this.data.set(buf, this.offset); // memcpy(data.ptr + offset, buf.ptr, buf.length)
        this.offset += buf.length;
    }

    // dropped overloads of `write`: `write(const(void)*, nbytes)` (outbuffer.d:235),
    // `write(const(char)* s)` (outbuffer.d:258), `write(const OutBuffer*)` (outbuffer.d:530) —
    // raw-pointer / C-string forms. TRAP: D's `write(const(char)*)`, and `writestring(const(char)*)` that
    // forwards to it, return on a null pointer (outbuffer.d:260 `if (!s) return;`); a call site that passes a
    // `const(char)*` D may leave null (getParamError under a gag) ports that null test at the site. The
    // frontend's `write(OutBuffer)` (the by-ref overload, outbuffer.d:536) is provided as `writeBuffer` below;
    // the single-byte `write(ubyte)` (outbuffer.d:415) is identical to `writeByte` (outbuffer.d:406) — fold to
    // `writeByte`.

    /** Append another OutBuffer's contents (outbuffer.d:536, `write(ref const OutBuffer)`). */
    writeBuffer(buf: OutBuffer): void {
        this.reserve(buf.offset);
        this.data.set(buf.data.subarray(0, buf.offset), this.offset);
        this.offset += buf.offset;
    }

    /** Write a 16-bit value, NO reserve check (outbuffer.d:270). Caller must have reserved. */
    write16n(v: number): void {
        const x = v & 0xffff; // cast(ushort) v
        this.data[this.offset] = x & 0x00ff;
        this.data[this.offset + 1] = x >> 8;
        this.offset += 2;
    }

    /** Write a 16-bit value, little-endian (outbuffer.d:281). */
    write16(v: number): void {
        const u = v & 0xffff; // cast(ushort) v
        this.reserve(2);
        this.data[this.offset] = u & 0x00ff; // little-endian store (put(&u, u.sizeof))
        this.data[this.offset + 1] = (u >> 8) & 0xff;
        this.offset += 2;
    }

    /** Write a 32-bit int, little-endian (outbuffer.d:290). */
    write32(v: number): void {
        this.reserve(4);
        const u = v >>> 0; // bit pattern of the int (put(&v, v.sizeof))
        this.data[this.offset] = u & 0xff;
        this.data[this.offset + 1] = (u >>> 8) & 0xff;
        this.data[this.offset + 2] = (u >>> 16) & 0xff;
        this.data[this.offset + 3] = (u >>> 24) & 0xff;
        this.offset += 4;
    }

    /**
     * Write a 64-bit int, little-endian (outbuffer.d:298, `write64(long v)`). The value is a
     * 64-bit `long` → bigint domain (09 §1). Cost: O(1).
     */
    write64(v: bigint): void {
        this.reserve(8);
        let u = BigInt.asUintN(64, v); // bit pattern of the long
        for (let i = 0; i < 8; i++) {
            this.data[this.offset + i] = Number(u & 0xffn);
            u >>= 8n;
        }
        this.offset += 8;
    }

    /** Append `s`'s bytes; buffer is NOT zero-terminated (outbuffer.d:304/310/316). */
    writestring(s: DString): void {
        this.write(s);
    }

    /** Append `s`'s bytes followed by a newline (outbuffer.d:322). */
    writestringln(s: DString): void {
        this.write(s);
        this.writenl();
    }

    /**
     * Append `s`'s bytes AND a terminating NUL byte (outbuffer.d:330/336/343). In djs a DString
     * has no embedded NUL, so the `const(char)*` strlen+1 form and the `const(char)[]`/`string`
     * forms collapse to: write the bytes, then write a `0`.
     */
    writeStringz(s: DString): void {
        this.write(s);
        this.writeByte(0);
    }

    /** Prepend `string`'s bytes at the front of the buffer (outbuffer.d:348). */
    prependstring(string_: DString): void {
        const len = string_.length;
        this.reserve(len);
        // memmove(data.ptr + len, data.ptr, offset): shift existing right, then copy in front.
        this.data.copyWithin(len, 0, this.offset);
        this.data.set(string_, 0);
        this.offset += len;
    }

    /**
     * Strip trailing tabs/spaces, then write a newline (outbuffer.d:358).
     * resolved: version(Windows) writeword(0x0A0D) -> false; POSIX `writeByte('\n')` kept.
     */
    writenl(): void {
        while (this.offset > 0 && (this.data[this.offset - 1] === 0x20 || this.data[this.offset - 1] === 0x09)) {
            this.offset--;
        }
        this.writeByte(0x0a); // '\n'  (POSIX; the Windows CR,LF branch is dropped)
        if (this.doindent) this.notlinehead = false;
    }

    /** Write `n` zero bytes (outbuffer.d:377, `writezeros`). D returns the start pointer; the
     * frontend does not use that return for this RAM path, so it returns void here. */
    writezeros(n: number): void {
        this.reserve(n);
        this.data.fill(0, this.offset, this.offset + n); // memset(.., 0, n)
        this.offset += n;
    }

    /** Position the buffer to accept `nbytes` at `where`, growing if needed (outbuffer.d:386). */
    position(where: number, nbytes: number): void {
        if (where + nbytes > this.data.length) {
            this.reserve(where + nbytes - this.offset);
        }
        this.offset = where;
        assert(this.offset + nbytes <= this.data.length); // debug assert (outbuffer.d:394)
    }

    /** Write one byte, NO reserve check (outbuffer.d:401, `writeByten`). Caller must reserve. */
    writeByten(b: number): void {
        this.data[this.offset++] = b & 0xff;
    }

    /**
     * Write one byte, honoring indent state (outbuffer.d:406, `writeByte`). The `write(ubyte)`
     * overload (outbuffer.d:415) has an identical body — folded here. `b` is a `ubyte`.
     */
    writeByte(b: number): void {
        if (this.doindent && !this.notlinehead && b !== 0x0a /* '\n' */) this.indent();
        this.reserve(1);
        this.data[this.offset] = b & 0xff;
        this.offset++;
    }

    /** Encode the code point `b` as 1-4 UTF-8 bytes and append (outbuffer.d:424, `writeUTF8`). */
    writeUTF8(b: number): void {
        this.reserve(6);
        if (b <= 0x7f) {
            this.data[this.offset] = b;
            this.offset++;
        } else if (b <= 0x7ff) {
            this.data[this.offset + 0] = (b >> 6) | 0xc0;
            this.data[this.offset + 1] = (b & 0x3f) | 0x80;
            this.offset += 2;
        } else if (b <= 0xffff) {
            this.data[this.offset + 0] = (b >> 12) | 0xe0;
            this.data[this.offset + 1] = ((b >> 6) & 0x3f) | 0x80;
            this.data[this.offset + 2] = (b & 0x3f) | 0x80;
            this.offset += 3;
        } else if (b <= 0x1fffff) {
            this.data[this.offset + 0] = (b >> 18) | 0xf0;
            this.data[this.offset + 1] = ((b >> 12) & 0x3f) | 0x80;
            this.data[this.offset + 2] = ((b >> 6) & 0x3f) | 0x80;
            this.data[this.offset + 3] = (b & 0x3f) | 0x80;
            this.offset += 4;
        } else {
            assertUnreachable(); // assert(0)
        }
    }

    /** Prepend a single byte at the front of the buffer (outbuffer.d:457, `prependbyte`). */
    prependbyte(b: number): void {
        this.reserve(1);
        this.data.copyWithin(1, 0, this.offset); // memmove(data.ptr + 1, data.ptr, offset)
        this.data[0] = b & 0xff;
        this.offset++;
    }

    /**
     * Write a wide char (outbuffer.d:465, `writewchar`).
     * resolved: version(Windows) writeword(w) -> false; POSIX `write4(w)` kept.
     */
    writewchar(w: number): void {
        this.write4(w);
    }

    /**
     * Write a 16-bit word, little-endian, honoring indent state (outbuffer.d:477, `writeword`).
     * resolved: version(Windows) newline=0x0A0D -> false; POSIX `newline='\n'`. `w` is a `uint`.
     */
    writeword(w: number): void {
        const newline = 0x0a; // '\n'  (POSIX; the Windows 0x0A0D branch is dropped)
        if (this.doindent && !this.notlinehead && w !== newline) this.indent();
        this.reserve(2);
        // *cast(ushort*)(data.ptr + offset) = cast(ushort)w  — little-endian store
        this.data[this.offset] = w & 0xff;
        this.data[this.offset + 1] = (w >> 8) & 0xff;
        this.offset += 2;
    }

    /** Encode the code point `w` as UTF-16 (1 or 2 LE units) and append (outbuffer.d:495). */
    writeUTF16(w: number): void {
        this.reserve(4);
        if (w <= 0xffff) {
            this.data[this.offset] = w & 0xff;
            this.data[this.offset + 1] = (w >> 8) & 0xff;
            this.offset += 2;
        } else if (w <= 0x10ffff) {
            const hi = ((w >> 10) + 0xd7c0) & 0xffff;
            const lo = ((w & 0x3ff) | 0xdc00) & 0xffff;
            this.data[this.offset] = hi & 0xff;
            this.data[this.offset + 1] = (hi >> 8) & 0xff;
            this.data[this.offset + 2] = lo & 0xff;
            this.data[this.offset + 3] = (lo >> 8) & 0xff;
            this.offset += 4;
        } else {
            assertUnreachable(); // assert(0)
        }
    }

    /**
     * Write a 32-bit word, little-endian, honoring indent state (outbuffer.d:513, `write4`).
     * resolved: version(Windows) notnewline = (w != 0x000A000D) -> false; POSIX notnewline=true.
     */
    write4(w: number): void {
        const notnewline = true; // POSIX (the Windows 0x000A000D check is dropped)
        if (this.doindent && !this.notlinehead && notnewline) this.indent();
        this.reserve(4);
        const u = w >>> 0;
        this.data[this.offset] = u & 0xff;
        this.data[this.offset + 1] = (u >>> 8) & 0xff;
        this.data[this.offset + 2] = (u >>> 16) & 0xff;
        this.data[this.offset + 3] = (u >>> 24) & 0xff;
        this.offset += 4;
    }

    /** Append `nbytes` zero bytes (outbuffer.d:543, `fill0`). */
    fill0(nbytes: number): void {
        this.reserve(nbytes);
        this.data.fill(0, this.offset, this.offset + nbytes);
        this.offset += nbytes;
    }

    /**
     * Allocate `nbytes` of space and return a writable VIEW of it (outbuffer.d:557, `allocate`).
     * The returned slice aliases the backing store, so the caller fills it in place (used by
     * `writeHexString`). It is a `subarray` (shared view) — NOT a copy — matching D's
     * `data[offset-nbytes .. offset]`. Cost: reserve + O(1).
     */
    allocate(nbytes: number): DString {
        this.reserve(nbytes);
        this.offset += nbytes;
        return this.data.subarray(this.offset - nbytes, this.offset);
    }

    /**
     * printf-style append (outbuffer.d:564 `vprintf` / :600/:610 `printf`). Appends the result
     * of formatting `format` with `args` (C `vsnprintf` semantics), honoring indent state.
     *
     * resolved: static if (__VERSION__ < 2092) -> false (__VERSION__ == 2112, 07 §3.2 / cheatsheet);
     * the `pragma(printf)` branch is kept and the pre-2092 branch dropped. `pragma(printf)` and
     * the `va_list`/`va_start`/`va_end` ABI plumbing erase (04 §3.1) — `args` IS the va_list.
     *
     * The format-string interpretation is the printf subset DMD diagnostics use (10 §3.5). It is
     * delegated to `root/dmdformat.ts` — the CANONICAL owner of printf formatting (resolution #2,
     * doc home 10 §3.5). `dmdformat` reproduces C `vsnprintf` byte-for-byte for the supported
     * specifier table (`%s %.*s %d %i %u %lld %llu %x %X %o %llo %c %zu %%`, with width/precision/
     * flags); `%f/%g/%e` throw loudly (C's float conversions are a documented deferral, resolution
     * #2). `args` IS the va_list (04 §3.1). `dmdformat`
     * accepts a `readonly unknown[]`-compatible array; we pass `args` as a mutable copy since its
     * signature takes `unknown[]` (it never mutates the array — read-only consumption).
     */
    vprintf(format: DString, args: ReadonlyArray<unknown>): void {
        if (this.doindent && !this.notlinehead) this.indent();
        this.writestring(dmdformat(format, args.slice()));
    }

    /** ditto (outbuffer.d:610). `pragma(printf)` erases (04 §8). */
    printf(format: DString, ...args: unknown[]): void {
        this.vprintf(format, args);
    }

    /** Convert `u` to its decimal text and append it (outbuffer.d:624, `print(ulong u)`). `u`
     * is a 64-bit `ulong` → bigint domain (09 §1). */
    print(u: bigint): void {
        this.writestring(unsignedToTempString(u));
    }

    /** Wrap the whole buffer with `left` at the front and `right` at the end (outbuffer.d:630,
     * `bracket(char left, char right)`). `left`/`right` are bytes. */
    bracketChars(left: number, right: number): void {
        this.reserve(2);
        this.data.copyWithin(1, 0, this.offset); // memmove(data.ptr + 1, data.ptr, offset)
        this.data[0] = left & 0xff;
        this.data[this.offset + 1] = right & 0xff;
        this.offset += 2;
    }

    /**
     * Insert `left` at index `i` and `right` at index `j`; return the index just past `right`
     * (outbuffer.d:643, `bracket(size_t, const(char)*, size_t, const(char)*)`).
     */
    bracket(i: number, left: DString, j: number, right: DString): number {
        const leftlen = left.length;
        const rightlen = right.length;
        this.reserve(leftlen + rightlen);
        this.insert(i, left);
        this.insert(j + leftlen, right);
        return j + leftlen + rightlen;
    }

    /** Spread the buffer open at `offset` to make room for `nbytes` (outbuffer.d:653, `spread`). */
    spread(offset: number, nbytes: number): void {
        this.reserve(nbytes);
        // memmove(data.ptr + offset + nbytes, data.ptr + offset, this.offset - offset)
        this.data.copyWithin(offset + nbytes, offset, this.offset);
        this.offset += nbytes;
    }

    /**
     * Insert `s`'s bytes at `offset`; return `offset + s.length` (outbuffer.d:663/670, `insert`).
     * D has a `(offset, const(void)* p, nbytes)` and a `(offset, const(char)[] s)` overload with
     * identical effect — folded to the slice form. Cost: spread (O(offset..end)) + O(s.length).
     */
    insert(offset: number, s: DString): number {
        const nbytes = s.length;
        this.spread(offset, nbytes);
        this.data.set(s, offset); // memmove(data.ptr + offset, p, nbytes)
        return offset + nbytes;
    }

    /** Delete `nbytes` bytes starting at `offset`, shifting the tail left (outbuffer.d:675). */
    remove(offset: number, nbytes: number): void {
        // memmove(data.ptr + offset, data.ptr + offset + nbytes, this.offset - (offset + nbytes))
        this.data.copyWithin(offset, offset + nbytes, this.offset);
        this.offset -= nbytes;
    }

    /**
     * `buf[]` — a non-owning const VIEW of `[0 .. offset]` (outbuffer.d:685, `opSlice()`).
     * `05-operators.md` §7: D `buf[]` (no args) lowers to `opSliceAll()`. Shared view, no copy.
     */
    opSliceAll(): DString {
        return this.data.subarray(0, this.offset);
    }

    /** `buf[lwr..upr]` — a non-owning const VIEW (outbuffer.d:690, `opSlice(lwr, upr)`). */
    opSlice(lwr: number, upr: number): DString {
        return this.data.subarray(lwr, upr);
    }

    /** `buf[i]` — the byte at `i` (outbuffer.d:695, `opIndex`). Returns a `char` (byte). */
    opIndex(i: number): number {
        return this.data[i];
    }

    /** `$` inside `buf[...]` — `alias opDollar = length` (outbuffer.d:700). */
    opDollar(): number {
        return this.length();
    }

    /**
     * Extract the data as a DString and take ownership of it (outbuffer.d:713, `extractSlice`).
     * With `nullTerminate=false` (default) returns the live `[0 .. length]`. With `true`, ensures
     * a trailing NUL: if the last byte is already `'\0'`, returns `[0 .. length-1]` (the NUL is
     * past the returned slice), else appends a `0` and returns `[0 .. length]`. After extraction
     * the buffer is emptied (extractData semantics).
     */
    extractSlice(nullTerminate = false): DString {
        const length = this.offset;
        if (!nullTerminate) return this.extractData().subarray(0, length);
        // There's already a terminating '\0'.
        if (length && this.data[length - 1] === 0) return this.extractData().subarray(0, length - 1);
        this.writeByte(0);
        return this.extractData().subarray(0, length);
    }

    // dropped: `extractUbyteSlice` (outbuffer.d:725) — `cast(byte[]) extractSlice`; a DString is
    // already a byte view, so a separate signed-byte reinterpretation is a no-op for our model.

    /**
     * Ensure a trailing NUL then return a VIEW of the internal buffer (outbuffer.d:731,
     * `peekChars`). D returns a `char*`; here a DString view of `[0 .. offset]` (the NUL sits at
     * `data[offset]`, one past the view — appended then `offset--`'d back, like D). Cost: O(1)
     * amortized.
     */
    peekChars(): DString {
        if (!this.offset || this.data[this.offset - 1] !== 0) {
            this.writeByte(0);
            this.offset--; // allow appending more (the NUL stays in the store, past offset)
        }
        // D returns `data.ptr` (a C-string pointer): the bytes from 0, NUL-terminated. The view
        // therefore spans `[0 .. offset+1]` so the terminating NUL at `data[offset]` is readable
        // (the empty-buffer case: offset==0, the NUL sits at data[0], so `p[0] == 0`).
        return this.data.subarray(0, this.offset + 1);
    }

    /** Peek at the contents without taking ownership (outbuffer.d:742, `peekSlice`). Shared view. */
    peekSlice(): DString {
        return this.data.subarray(0, this.offset);
    }

    /**
     * Ensure a trailing NUL then take ownership of the data (outbuffer.d:748, `extractChars`).
     * D returns a `char*` including the NUL in the buffer; here the extracted DString includes
     * the NUL byte (its `.length` is `offset` AFTER the NUL was appended).
     */
    extractChars(): DString {
        if (!this.offset || this.data[this.offset - 1] !== 0) this.writeByte(0);
        return this.extractData();
    }

    /** Write `value` as signed LEB128 (outbuffer.d:755, `writesLEB128`). `value` is a 32-bit int. */
    writesLEB128(value: number): void {
        while (true) {
            let b = value & 0x7f; // ubyte b
            value >>= 7; // arithmetic right shift (signed)
            if ((value === 0 && !(b & 0x40)) || (value === -1 && b & 0x40)) {
                this.writeByte(b);
                break;
            }
            this.writeByte((b |= 0x80));
        }
    }

    /** Write `value` as unsigned LEB128 (outbuffer.d:772, `writeuLEB128`). `value` is a uint. */
    writeuLEB128(value: number): void {
        value >>>= 0; // ensure unsigned 32-bit
        do {
            let b = value & 0x7f; // ubyte b
            value >>>= 7; // logical right shift (unsigned)
            if (value) b |= 0x80;
            this.writeByte(b);
        } while (value);
    }

    /**
     * Write `data` as a string of hexadecimal digits (outbuffer.d:791, `writeHexString`).
     * Each input byte becomes two hex chars; `upperCase` selects `A-F` vs `a-f`. Writes through
     * the `allocate`d view in place. `data` is the bytes to render.
     */
    writeHexString(data: DString, upperCase: boolean): void {
        const slice = this.allocate(2 * data.length);
        const a = upperCase ? 0x41 /* 'A' */ : 0x61; /* 'a' */
        for (let i = 0; i < data.length; i++) {
            const c = data[i];
            const hi = (c >> 4) & 0xf;
            slice[i * 2] = hi < 10 ? hi + 0x30 /* '0' */ : hi - 10 + a;
            const lo = c & 0xf;
            slice[i * 2 + 1] = lo < 10 ? lo + 0x30 : lo - 10 + a;
        }
    }

    // dropped (STOP-stub): `moveToFile(const char[] filename)` (outbuffer.d:816) — destructively
    // writes the buffer to a file, using the STOP-stubbed FileMapping for the identical-content
    // optimization. Not on the lex→sema→CTFE path. See gap report.
}

/* ****** copied from core.internal.string ************* */

// alias UnsignedStringBuf = char[20];  (outbuffer.d:856) — the scratch buffer is internal to
// `unsignedToTempString` here; no fixed-size static array is needed in the JS port.

/**
 * Convert `value` to a string in the given `radix` (outbuffer.d:858, `unsignedToTempString`).
 * `value` is a 64-bit `ulong` → bigint domain (09 §1); digits beyond 9 use lowercase `a..`.
 * D writes into a caller-provided fixed buffer back-to-front and returns the used tail; the JS
 * port builds the digit bytes directly (the fixed-buffer/`return scope` plumbing is dropped —
 * raw-memory artifact). `radix` defaults to 10.
 */
export function unsignedToTempString(value: bigint, radix = 10): DString {
    const r = BigInt(radix);
    const digits: number[] = [];
    do {
        const x = Number(value % r); // value < 2^64; x in 0..radix-1
        digits.push(x < 10 ? x + 0x30 /* '0' */ : x - 10 + 0x61 /* 'a' */);
        value /= r;
    } while (value);
    digits.reverse(); // D fills back-to-front; reverse the forward-built list
    return Uint8Array.from(digits);
}
