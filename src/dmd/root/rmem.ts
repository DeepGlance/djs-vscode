// Port of dmd/root/rmem.d (+ dmd/root/region.d) — manual allocators → NO-OP under GC.
// Contract: docs/porting/08-runtime-lib.md §13. Read it before changing this file.
//
// Why this module is almost empty of real work:
//   DMD manages memory by hand (`Mem` struct, bump-pointer `Region`, `allocmemoryNoFree`).
//   Every `mem.xmalloc`/`xfree`/`memcpy` in `root/` exists ONLY because the frontend's D
//   build has no GC-by-default. JS HAS a GC. So (08 §0 invariant 1) the runtime stores
//   VALUES in JS arrays / typed arrays and never indexes raw byte blobs by offset. The
//   canonical resolution of a `mem.xmalloc`/`xfree`/`Region` call is therefore to DELETE it
//   at the translation site (the block it allocated is now a JS object / typed array).
//
// This file keeps the SURFACE (names + signatures) so any not-yet-rewritten call site still
// compiles, and so the small set of calls that carry real meaning (a semantic COPY, GC
// tuning that is simply inert) have a faithful home. The split:
//   - allocating raw `void*` blocks (`xmalloc`/`xcalloc`/`xrealloc` + `_noscan`): there is
//     no meaningful JS value to return — a LIVE call is a translation artifact that should
//     have been deleted, so it throws `assertUnreachable()` (loud, per boundary-validation.md /
//     assert(0) discipline) rather than silently returning a fake pointer.
//   - `xfree` / GC tuning (`isGCEnabled`/`disableGC`/`addRange`/`removeRange`): genuine
//     no-ops — the GC already does (or makes irrelevant) what they did in D.
//   - `xstrdup`/`xarraydup`/`arraydup`: SEMANTIC copies (the copied buffer is mutated
//     independently of the source, rmem.d:335/:368 unittests) → real `slice()` with the
//     exact null-vs-empty guard the D source has (verified against ldc2-1.42.0).
//   - `Region`: lives in its own dmd-path module `./region.ts` and is re-exported below.
//     It is a TRIVIAL GC-backed allocator (malloc → fresh byte block, savePos/release →
//     checkpoint/rollback of the live-block set), faithful to the region.d observable contract.
//
// Dropped entirely (08 §13): the `OVERRIDE_MEMALLOC` block, `_d_allocmemory`/`_d_newclass`/
// `_d_newitem*`, `allocmemoryNoFree`/`allocmemory`, the pure-libc `malloc`/`free` aliases,
// and the `~this` debug-stomping. They are druntime-override / codegen-adjacent and have no
// analog in a GC'd port.

import { assertUnreachable } from "../../assert.js";
import type { DString } from "../../dstring.js";

/**
 * `Mem` — DMD's allocator façade (`rmem.d:24`). In the port it is inert: JS allocates via
 * `new` / array literals and the GC frees. Exposed only so residual call sites compile and
 * so the genuinely-meaningful members (`xstrdup`, the GC-tuning no-ops) have a home.
 *
 * Lifetime/ownership: stateless. The single shared instance is `mem` (below), mirroring D's
 * `extern (C++) const __gshared Mem mem` (`rmem.d:157`). Thread-safety: irrelevant (no state).
 */
export class Mem {
    /**
     * Duplicate a C-string onto fresh memory (`rmem.d:26`). In the port a `DString` already
     * carries its own length (no embedded NUL), so this is just an INDEPENDENT byte copy.
     * Preserve the D null-guard: `xstrdup(null)` → `null` (verified: D returns null for a
     * null source, an empty NON-null source for ""). Cost: one allocation + copy.
     */
    xstrdup(s: DString | null): DString | null {
        return s ? s.slice() : null;
    }

    /**
     * Free a block (`rmem.d:34`). NO-OP: the JS GC reclaims unreferenced objects. Kept so
     * `mem.xfree(p)` call sites that were not deleted still compile and do nothing.
     */
    xfree(_p: unknown): void {
        // GC frees — intentionally empty.
    }

    /**
     * Allocate `size` raw bytes (`rmem.d:42`). NOT live in a correct port: a raw `void*`
     * block has no faithful JS value — the call site should have been rewritten to a `new`
     * of the concrete JS type. A live call is a translation bug → throw (loud, not a silent
     * fake pointer). Same for the variants below.
     */
    xmalloc(_size: number): never {
        return assertUnreachable("mem.xmalloc: raw allocation has no analog under GC — rewrite the call site (08 §13)");
    }

    /** `rmem.d:50` — GC carries no pointers in a typed array, so `_noscan` collapses to `xmalloc`. */
    xmalloc_noscan(_size: number): never {
        return assertUnreachable("mem.xmalloc_noscan: raw allocation has no analog under GC — rewrite the call site (08 §13)");
    }

    /** `rmem.d:58` — zero-filled raw block; see `xmalloc`. */
    xcalloc(_size: number, _n: number): never {
        return assertUnreachable("mem.xcalloc: raw allocation has no analog under GC — rewrite the call site (08 §13)");
    }

    /** `rmem.d:66` — see `xcalloc` / `xmalloc_noscan`. */
    xcalloc_noscan(_size: number, _n: number): never {
        return assertUnreachable("mem.xcalloc_noscan: raw allocation has no analog under GC — rewrite the call site (08 §13)");
    }

    /** `rmem.d:74` — grow a raw block; see `xmalloc`. The grow-and-copy form for a typed array
     * is done at the call site (`const g = new Uint8Array(n); g.set(old); old = g;`, 08 §13). */
    xrealloc(_p: unknown, _size: number): never {
        return assertUnreachable("mem.xrealloc: raw allocation has no analog under GC — rewrite the call site (08 §13)");
    }

    /** `rmem.d:88` — see `xrealloc` / `xmalloc_noscan`. */
    xrealloc_noscan(_p: unknown, _size: number): never {
        return assertUnreachable("mem.xrealloc_noscan: raw allocation has no analog under GC — rewrite the call site (08 §13)");
    }

    /**
     * GC enabled? (`rmem.d:126`) Always `true`: the port runs under Node's GC. Kept because a
     * few D sites branch on it; with GC on, those branches pick the GC path (which is the
     * no-op / `new` path here).
     */
    isGCEnabled(): boolean {
        return true;
    }

    /** `rmem.d:131` — disable the GC. NO-OP: there is no GC to disable under Node. */
    disableGC(): void {
        // no GC to disable — intentionally empty.
    }

    /** `rmem.d:144` — register a root range with the GC. NO-OP: JS GC scans all live refs. */
    addRange(_p: unknown, _size: number): void {
        // intentionally empty.
    }

    /** `rmem.d:150` — unregister a root range. NO-OP (see `addRange`). */
    removeRange(_p: unknown): void {
        // intentionally empty.
    }
}

/** The single shared allocator façade — D's `extern (C++) const __gshared Mem mem` (`rmem.d:157`). */
export const mem: Mem = new Mem();

/**
 * Null-terminated COPY of a char-slice (`rmem.d:335`). This is a SEMANTIC copy, not alloc
 * plumbing: the rmem.d:348 unittest mutates the result and asserts the source is unchanged,
 * so the port MUST return an independent buffer (`03-value-semantics.md`).
 *
 * Null-vs-empty (verified, ldc2-1.42.0): a NULL source → `null`; an empty non-null source
 * ("") → an empty non-null `DString`. The D source's trailing NUL lives PAST `.length`
 * (`a = p[0 .. s.length]`, the `0` is at `p[s.length]`), so it is not part of the returned
 * slice — in the port the returned `DString` likewise excludes any terminator and has length
 * == the source length. Cost: one allocation + copy.
 */
export function xarraydup(s: DString | null): DString | null {
    return s ? s.slice() : null;
}

/**
 * Copy of an arbitrary array onto fresh memory (`rmem.d:368`). SEMANTIC copy (the rmem.d:380
 * unittest mutates the copy and asserts the original is unchanged) → `slice()` (shallow:
 * element references for class `T`, values for value `T`, matching D's `p[] = s` memcpy).
 *
 * Null-vs-empty (verified, ldc2-1.42.0): both a null source AND an empty array literal `[]`
 * return `null` in D — D's `if (!s)` is true for a null-pointer'd slice, which `[]` is. The
 * port cannot distinguish a JS "null slice" from an empty array, so it preserves only the
 * explicit `null` → `null` guard and copies everything else (an empty `[]` → empty copy).
 * If a call site relies on `arraydup([])` returning null specifically, STOP (08 §13).
 */
export function arraydup<T>(s: readonly T[] | null): T[] | null {
    return s ? s.slice() : null;
}

// `Region`/`RegionPos` (`region.d:24/36`) live in their canonical dmd-path module now
// (`src/dmd/root/region.ts`, per the `dmd/root/X.d → src/dmd/root/X.ts` rule). 08 §13 groups
// `rmem` and `region` because both are allocators turned trivial under GC, but they are two
// separate D source files, so each gets its own TS module. Re-export here so the historical
// `import { Region, RegionPos } from "./rmem.js"` call sites keep resolving — a single source
// of truth, no divergent duplicate.
export { Region, RegionPos } from "./region.js";
