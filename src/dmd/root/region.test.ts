// Ported from the `unittest` block at dmd/root/region.d:138 (10-tests-diagnostics §1).
//
// The D test exercises the OBSERVABLE contract of Region — exactly what the trivial GC-backed
// port keeps: malloc(0)→null, malloc(n)→a distinct writable block, contains() membership,
// size()>0 after allocation, contains() false for a foreign pointer (`&reg` in D), and a
// release(savePos) round-trip. The slab/chunk internals the D unittest does NOT assert on are
// dropped in the port (08 §0.1), so nothing here references them.

import { describe, it, expect } from "vitest";

import { Region } from "./region.js";

describe("Region — region.d:138 unittest (observable contract under GC)", () => {
    it("malloc/contains/size/release round-trip", () => {
        const reg = new Region();
        const rgnpos = reg.savePos();

        // void* p = reg.malloc(0); assert(p == null); assert(!reg.contains(p));
        let p = reg.malloc(0);
        expect(p).toBeNull();
        expect(reg.contains(p)).toBe(false);

        // p = reg.malloc(100); assert(p !is null); assert(reg.contains(p)); memset(p, 0, 100);
        p = reg.malloc(100);
        expect(p).not.toBeNull();
        expect(reg.contains(p)).toBe(true);
        p!.fill(0); // memset(p, 0, 100) — the returned block is a real, writable buffer.

        // p = reg.malloc(100); assert(p !is null); assert(reg.contains(p)); memset(p, 0, 100);
        const pFirst = p; // keep the first block to check it is distinct + still contained.
        p = reg.malloc(100);
        expect(p).not.toBeNull();
        expect(reg.contains(p)).toBe(true);
        expect(p).not.toBe(pFirst); // distinct allocations (not overlapping cursors).
        expect(reg.contains(pFirst)).toBe(true);
        p!.fill(0);

        // assert(reg.size() > 0);  — 2×((100+15)&~15) = 2×112 = 224 (verified against ldc2).
        expect(reg.size()).toBeGreaterThan(0);
        expect(reg.size()).toBe(224);

        // assert(!reg.contains(&reg)); — a pointer to a foreign object is not in the region.
        expect(reg.contains(reg)).toBe(false);
        expect(reg.contains({})).toBe(false);

        // reg.release(rgnpos); — rewinds to the empty checkpoint taken before any malloc.
        reg.release(rgnpos);
        expect(reg.size()).toBe(0);
        expect(reg.contains(pFirst)).toBe(false); // released blocks no longer counted/contained.
    });

    it("malloc rounds the request up to a 16-byte boundary (region.d:56)", () => {
        const reg = new Region();
        // (1+15)&~15 = 16, (16+15)&~15 = 16, (17+15)&~15 = 32.
        expect(reg.malloc(1)!.length).toBe(16);
        expect(reg.malloc(16)!.length).toBe(16);
        expect(reg.malloc(17)!.length).toBe(32);
        expect(reg.size()).toBe(16 + 16 + 32);
    });

    it("savePos/release checkpoints only the allocations made after the save", () => {
        const reg = new Region();
        const a = reg.malloc(48); // before the checkpoint — survives the release.
        const pos = reg.savePos();
        reg.malloc(64); // after the checkpoint — dropped by the release.
        expect(reg.size()).toBe(48 + 64);

        reg.release(pos);
        expect(reg.size()).toBe(48);
        expect(reg.contains(a)).toBe(true);
    });
});
