// Port of dmd/root/region.d — Region storage allocator → TRIVIAL under GC.
// Contract: docs/porting/08-runtime-lib.md §13 ("rmem.d + region.d — allocators → NO-OP").
// Read it before changing this file.
//
// Copyright (C) 2019-2025 by The D Language Foundation, All Rights Reserved (region.d).
//
// WHY this is a hand-written runtime replacement, not a 1:1 structural mirror
// (00-how-to-use §0.1 — the root-runtime exemption):
//   region.d is a bump-pointer slab allocator: it grabs 4 MiB chunks of raw memory
//   (`Mem.check(.malloc(ChunkSize))`), hands out 16-byte-aligned cursors into the current
//   chunk (`available.ptr`), and "recycles" memory on `release()` by rewinding the cursor —
//   on the explicit promise that "There better not be any live pointers to it" (region.d:94).
//   That whole machinery exists ONLY because the frontend's D build has no GC-by-default.
//   JS HAS a GC. So we DROP the slab/chunk/cursor internals (08 §0.1 auditable deletions
//   below) and implement the OBSERVABLE CONTRACT — malloc / savePos / release / contains /
//   size — over plain JS allocations the GC reclaims.
//
// Observable contract preserved (verified against ldc2-1.42.0, region.d unittest + a probe):
//   - malloc(0)            → null; contains(null) → false; does not count toward size().
//   - malloc(n>0)          → a fresh, DISTINCT byte block of (n+15)&~15 bytes.
//   - contains(p)          → true iff p is a block this region returned and has not released.
//   - size()               → sum of the ROUNDED sizes of the live blocks (224 after 2×100).
//   - savePos()/release()  → checkpoint/rollback: release(pos) drops every block allocated
//                            after savePos() returned pos, so size()/contains() observe the
//                            rewind exactly as the slab allocator did (probe: size 224 → 0,
//                            contains(p1) true → false). This is the one place 08 §13 says to
//                            "verify the call site does not rely on release INVALIDATING still-
//                            referenced objects" — it does not (region.d:94 promise); the GC
//                            keeps any block a caller still references alive regardless.
//
// Dropped raw-memory internals (08 §0.1 — each mapped to its region.d line):
//   - dropped: `Array!(void*) array` + `int used` + `void[] available` (region.d:29-31) —
//     chunk/cursor bookkeeping; JS allocates per-block and the GC frees.
//   - dropped: `enum ChunkSize = 4096*1024` (region.d:33) — 4 MiB slab size; no slabs.
//   - dropped: the chunk-grow path `Mem.check(.malloc(ChunkSize)); array.push(h)` and the
//     cursor arithmetic `available = (p + nbytes)[0 .. available.length - nbytes]`
//     (region.d:60-71) — pointer arithmetic over a raw slab; replaced by `new Uint8Array`.
//   - dropped: the `version(all)` recycle vs `else` stomp-0xFF branch in release()
//     (region.d:92-108) — `version(all)` is ON (07/_config §3), the `else` is dead; and the
//     recycle is itself slab-cursor rewind, modeled here as list truncation.

import { assert } from "../../assert.js";

// region.d:34 — kept as the boundary limit malloc() asserts against. region.d:33 ChunkSize is
// dropped (no slabs), but MaxAllocSize === ChunkSize there, so we keep the value for the
// `assert(nbytes <= MaxAllocSize)` check the frontend relies on.
const MaxAllocSize = 4096 * 1024;

/**
 * One live allocation handed out by `Region.malloc`. `ptr` is the exact object returned to
 * the caller (identity is what `contains` tests); `roundedSize` is the 16-byte-aligned size
 * that `size()` sums — matching the slab allocator, which advanced its cursor by the rounded
 * amount, not the requested `nbytes`.
 */
interface Allocation {
    ptr: Uint8Array;
    roundedSize: number;
}

/**
 * `RegionPos` (region.d:36) — the opaque checkpoint token returned by `savePos()` and consumed
 * by `release()`. In the slab allocator it carried `{ used, available }` (the chunk index +
 * cursor slice to rewind to); under GC the only observable state is the SET of live blocks, so
 * the token carries the block count at checkpoint time. `release(pos)` truncates back to it.
 *
 * Opaque by contract: callers must treat it as a token to pass back to `release()`, never read
 * `mark`. Kept as a class (not a bare number) to mirror D's named struct and stay diff-able.
 */
export class RegionPos {
    constructor(readonly mark: number) {}
}

/**
 * `Region` (region.d:24) — a simple region/arena allocator.
 *
 * D `struct` → TS `class` (02§2). In D it is a value type zero-initialized as a local
 * (`Region reg;`); in the port the equivalent is `new Region()`, which starts empty. The
 * frontend uses one Region per logical scope and never COPIES a Region by value (it is passed
 * by `ref`/pointer), so no `.copy()` discipline applies here; if a by-value Region copy ever
 * appears, STOP (03-value-semantics) — copying an allocator's live-block set is almost
 * certainly a bug, exactly as copying the slab cursor would be.
 *
 * Lifetime/ownership: blocks returned by `malloc` are owned by the CALLER for as long as the
 * caller holds them; `release` only forgets them from THIS region's bookkeeping (so `contains`/
 * `size` reflect the rewind) — it does not and cannot free a block a caller still references
 * (the GC governs actual liberation). Not thread-safe (neither is the D original).
 */
export class Region {
    // The live blocks, in allocation order. savePos() snapshots `.length`; release() truncates.
    // Replaces region.d's `array`/`used`/`available` slab+cursor state.
    private allocations: Allocation[] = [];

    /**
     * Allocate `nbytes`. Aborts on failure. (region.d:51)
     *
     * Preconditions: `nbytes <= MaxAllocSize` (asserted, as in region.d:59).
     * Returns: a fresh byte block of `(nbytes + 15) & ~15` bytes, or `null` for `nbytes == 0`
     * (region.d:53 — null for the zero request). Each block is DISTINCT (the slab allocator
     * never returned overlapping cursors for live allocations within a savePos window).
     * Cost: one `Uint8Array` allocation; the GC frees it once both caller and region drop it.
     */
    malloc(nbytes: number): Uint8Array | null {
        if (!nbytes)
            return null;

        nbytes = (nbytes + 15) & ~15;
        assert(nbytes <= MaxAllocSize);

        const ptr = new Uint8Array(nbytes);
        this.allocations.push({ ptr, roundedSize: nbytes });
        return ptr;
    }

    /**
     * Return the checkpoint for allocations in this region. (region.d:80)
     * Returns: an opaque `RegionPos` to be passed to `release()`. Cost: O(1).
     */
    savePos(): RegionPos {
        return new RegionPos(this.allocations.length);
    }

    /**
     * Release the memory that was allocated after the matching `savePos()`. (region.d:90)
     *
     * Forgets every block allocated after `pos` was taken, so `size()` and `contains()` observe
     * the rewind exactly as the slab cursor did. Per region.d:94 the contract is "there better
     * not be any live pointers to it" — under GC a still-referenced block stays alive anyway,
     * so this rollback is safe regardless. `version(all)` recycle branch only (region.d:92); the
     * `else` 0xFF-stomp branch is dead (07/_config §3 — `version(all)` ON) and dropped.
     */
    release(pos: RegionPos): void {
        // truncate back to the checkpoint — drops blocks allocated after savePos().
        this.allocations.length = pos.mark;
    }

    /**
     * Whether `p` points into this region. (region.d:118)
     * Returns: true iff `p` is one of the blocks this region currently holds (identity match).
     * `contains(null)` and `contains(any-foreign-object)` → false, as in the D original (a
     * pointer outside every live chunk fails the `h <= p && p < h + ChunkSize` range test).
     */
    contains(p: unknown): boolean {
        for (const a of this.allocations) {
            if (a.ptr === p)
                return true;
        }
        return false;
    }

    /**
     * Size of the Region. (region.d:131)
     * Returns: the total ROUNDED bytes of the live blocks (the slab allocator reported
     * `used * MaxAllocSize - available.length`, i.e. exactly the bytes its cursor had consumed,
     * which equals the sum of the rounded request sizes). 0 when empty.
     */
    size(): number {
        let total = 0;
        for (const a of this.allocations)
            total += a.roundedSize;
        return total;
    }
}
