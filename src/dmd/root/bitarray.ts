// Ported from dmd/root/bitarray.d (module dmd.root.bitarray).
//
// A dynamic bit vector. Used by flow analysis (escape.d, ob.d, statementsem.d, func.d).
// Contract: 08-runtime-lib.md §4. Operator method names (opIndex/opIndexAssign/opEquals/
// opAssign) are owned by 05-operators.md §1 — they match its canonical table verbatim.
//
// Representation decision (08 §4): backed by a Uint32Array of 32-bit WORDS, with the length
// tracked separately IN BITS. D uses 64-bit `size_t` chunks; the chunk width is an
// implementation detail, and 32-bit words let us use JS's native 32-bit bit operators
// directly (no BigInt). Bit positions are indices, so they live in the `number` domain
// (09-numerics.md). The masking semantics (08 §4) depend only on the bit length `nlen`, not
// on the chunk width — VERIFIED against ldc2-1.42.0 that a 32-bit-word port reproduces the
// 64-bit-chunk behavior bit-for-bit (the tail mask is keyed on `nlen & 31`, never on a
// chunk boundary the caller can observe).
//
// druntime intrinsic → arithmetic map (08 §4, replacing `import core.bitop : bt, bts, btc`):
//   bt(ptr, i)  → (words[i>>>5] & (1 << (i & 31))) !== 0     test bit
//   bts(ptr, i) → words[w] |= mask                            set bit
//   btc(ptr, i) → words[w] &= ~mask                           clear bit
// Stores into a Uint32Array coerce to unsigned 32-bit (ToUint32), so `1 << 31` (which is the
// negative -2147483648 as a JS number) round-trips as 0x80000000 in a word slot — VERIFIED.
//
// The D destructor (~this, bitarray.d:120) is GC cleanup + debug memory-stomping → DROPPED
// (01-conventions.md §5.3 / 08 §4: no deterministic cleanup needed under JS GC).

import { assert } from "../../assert.js";

const BITS_PER_WORD = 32;

/// Number of 32-bit words needed to store `len` bits (ceil(len / 32)). Mirrors
/// `bitarray.d:chunks` but in the 32-bit-word domain.
function words_for(len: number): number {
    return (len + BITS_PER_WORD - 1) >>> 5; // (len + 31) / 32, exact for the non-negative bit counts we hold
}

export class BitArray {
    private len = 0; // length IN BITS (bitarray.d:141 `size_t len`)
    private words = new Uint32Array(0); // bit storage (bitarray.d:142 `size_t *ptr`)

    /// Length in bits. Public mutable in D (`length`/`length(nlen)`); a getter/setter pair here.
    get length(): number {
        return this.len;
    }

    /// Resize to `nlen` bits (bitarray.d:31). Growth zeroes the new words; on any change the
    /// tail word is masked so bits beyond `nlen` read as 0 — the frontend relies on `isZero`/
    /// `opEquals` never seeing stray high bits (bitarray.d:42). Shrink truncates the storage.
    set length(nlen: number) {
        const ochunks = words_for(this.len);
        const nchunks = words_for(nlen);
        if (ochunks !== nchunks) {
            // xrealloc preserves old bytes then the caller zeroes the tail; reproduce by copying
            // the surviving prefix into a fresh (zero-initialized) Uint32Array.
            const next = new Uint32Array(nchunks);
            next.set(this.words.subarray(0, Math.min(ochunks, nchunks)));
            this.words = next;
        }
        // New chunks are already zero (fresh Uint32Array); nothing else to zero (bitarray.d:40).
        const tail = nlen & (BITS_PER_WORD - 1);
        if (tail) {
            // Keep only the low `tail` bits of the last word (bitarray.d:42). `0xFFFFFFFF >>>
            // (32 - tail)` is the low-`tail`-bits mask; it avoids the `(1 << 32)` / sign-bit
            // traps that the literal `(1 << tail) - 1` would risk in JS for tail near 32.
            this.words[nchunks - 1] &= 0xffffffff >>> (BITS_PER_WORD - tail);
        }
        this.len = nlen;
    }

    /// `a = b` on a BitArray (bitarray.d:46). Quirk preserved: assigning into an EMPTY BitArray
    /// adopts `b`'s length first; otherwise the lengths must already match. Copies the bits.
    /// 05-operators.md §1: bare `a = b` on a BitArray rewrites to `a.opAssign(b)`.
    opAssign(b: BitArray): void {
        if (!this.len) this.length = b.len; // "size to b if empty" (bitarray.d:48)
        assert(this.len === b.len);
        this.words.set(b.words.subarray(0, words_for(this.len)));
    }

    /// `ba[idx]` read (bitarray.d:54). `bt(ptr, idx)`. Precondition: idx < len.
    opIndex(idx: number): boolean {
        assert(idx < this.len);
        return (this.words[idx >>> 5] & (1 << (idx & 31))) !== 0;
    }

    /// `ba[idx] = val` write (bitarray.d:62). `val ? bts : btc`. Precondition: idx < len.
    /// 05-operators.md §7: arg order is (value, index) — value first, matching D's opIndexAssign.
    opIndexAssign(val: boolean, idx: number): void {
        assert(idx < this.len);
        const w = idx >>> 5;
        const mask = 1 << (idx & 31);
        if (val) this.words[w] |= mask;
        else this.words[w] &= ~mask;
    }

    /// `a == b` (bitarray.d:73): equal length AND equal bits. 05-operators.md §1: `a == b`
    /// rewrites to `a.opEquals(b)`, `a != b` to `!a.opEquals(b)`. The tail-word masking on
    /// resize guarantees a word-wise compare is correct (no stray high bits to differ on).
    opEquals(b: BitArray): boolean {
        if (this.len !== b.len) return false;
        const n = words_for(this.len);
        for (let i = 0; i < n; i++) if (this.words[i] !== b.words[i]) return false;
        return true;
    }

    /// Clear every bit (bitarray.d:78 `memset(ptr, 0, ...)`).
    zero(): void {
        this.words.fill(0);
    }

    /// True if no bit is set (bitarray.d:87).
    isZero(): boolean {
        const n = words_for(this.len);
        for (let i = 0; i < n; i++) if (this.words[i] !== 0) return false;
        return true;
    }

    /// In-place bitwise OR with `b` (bitarray.d:98). Precondition: same length.
    or(b: BitArray): void {
        assert(this.len === b.len);
        const n = words_for(this.len);
        for (let i = 0; i < n; i++) this.words[i] |= b.words[i];
    }

    /// Swap the bit contents of `this` and `b` (bitarray.d:108). Precondition: same length.
    swap(b: BitArray): void {
        assert(this.len === b.len);
        const n = words_for(this.len);
        for (let i = 0; i < n; i++) {
            const chunk = this.words[i];
            this.words[i] = b.words[i];
            b.words[i] = chunk;
        }
    }
}
