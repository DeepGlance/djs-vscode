// Contract tests for the rmem/region port (docs/porting/08-runtime-lib.md §13).
// Verified edge cases probed against ldc2-1.42.0 (/tmp/probe_rmem.d):
//   xarraydup(null) -> null ; xarraydup("") -> empty non-null ; mutating the copy leaves
//   the source unchanged. arraydup(null) -> null ; arraydup([]) -> null in D (the port keeps
//   only the explicit-null guard). arraydup copies and the copy is independent.

import { describe, it, expect } from "vitest";

import { DError } from "../../assert.js";
import { ds } from "../../dstring.js";
import { Mem, mem, xarraydup, arraydup, Region, RegionPos } from "./rmem.js";

describe("mem singleton + Mem class", () => {
    it("exports a shared Mem instance", () => {
        expect(mem).toBeInstanceOf(Mem);
    });

    it("isGCEnabled is always true (port runs under Node's GC)", () => {
        expect(mem.isGCEnabled()).toBe(true);
    });

    it("GC-tuning members are inert no-ops", () => {
        // None of these should throw or have any observable effect.
        expect(() => mem.disableGC()).not.toThrow();
        expect(() => mem.addRange({}, 16)).not.toThrow();
        expect(() => mem.removeRange({})).not.toThrow();
        // disableGC does NOT actually disable anything in the port.
        mem.disableGC();
        expect(mem.isGCEnabled()).toBe(true);
    });

    it("xfree is a no-op (GC frees)", () => {
        expect(() => mem.xfree({})).not.toThrow();
        expect(mem.xfree({} as unknown)).toBeUndefined();
    });
});

describe("Mem.xstrdup — semantic copy with null guard", () => {
    it("returns null for a null source", () => {
        expect(mem.xstrdup(null)).toBeNull();
    });

    it("copies the bytes of a non-empty source", () => {
        const src = ds("foo");
        const dup = mem.xstrdup(src);
        expect(dup).not.toBeNull();
        expect(Array.from(dup!)).toEqual([0x66, 0x6f, 0x6f]);
    });

    it("the copy is independent of the source (mutation isolation)", () => {
        const src = ds("foo");
        const dup = mem.xstrdup(src)!;
        dup[0] = 0x62; // 'b'
        expect(Array.from(src)).toEqual([0x66, 0x6f, 0x6f]); // source unchanged
        expect(Array.from(dup)).toEqual([0x62, 0x6f, 0x6f]); // "boo"
    });

    it('returns an empty non-null DString for an empty non-null source (D: "" -> empty)', () => {
        const dup = mem.xstrdup(ds(""));
        expect(dup).not.toBeNull();
        expect(dup!.length).toBe(0);
    });
});

describe("Mem raw allocators throw (no analog under GC, 08 §13)", () => {
    it("xmalloc throws DError", () => {
        expect(() => mem.xmalloc(8)).toThrow(DError);
    });
    it("xmalloc_noscan throws DError", () => {
        expect(() => mem.xmalloc_noscan(8)).toThrow(DError);
    });
    it("xcalloc throws DError", () => {
        expect(() => mem.xcalloc(8, 2)).toThrow(DError);
    });
    it("xcalloc_noscan throws DError", () => {
        expect(() => mem.xcalloc_noscan(8, 2)).toThrow(DError);
    });
    it("xrealloc throws DError", () => {
        expect(() => mem.xrealloc(null, 8)).toThrow(DError);
    });
    it("xrealloc_noscan throws DError", () => {
        expect(() => mem.xrealloc_noscan(null, 8)).toThrow(DError);
    });
});

describe("xarraydup — null-terminated semantic copy (rmem.d:335)", () => {
    it("returns null for a null source (verified: ldc2 xarraydup(null) is null)", () => {
        expect(xarraydup(null)).toBeNull();
    });

    it("returns an empty non-null copy for an empty source (verified: ldc2 \"\" -> non-null len 0)", () => {
        const dup = xarraydup(ds(""));
        expect(dup).not.toBeNull();
        expect(dup!.length).toBe(0);
    });

    it("copies bytes and the copy is independent (rmem.d:348 unittest)", () => {
        const src = ds("foo");
        const dup = xarraydup(src)!;
        dup[0] = 0x62; // 'b'
        expect(Array.from(src)).toEqual([0x66, 0x6f, 0x6f]); // s1 == "foo"
        expect(Array.from(dup)).toEqual([0x62, 0x6f, 0x6f]); // s2 == "boo"
    });

    it("returned slice length equals source length (NUL lives past .length, not in the slice)", () => {
        const dup = xarraydup(ds("abcd"))!;
        expect(dup.length).toBe(4);
    });
});

describe("arraydup — shallow array copy (rmem.d:368)", () => {
    it("returns null for a null source", () => {
        expect(arraydup<number>(null)).toBeNull();
    });

    it("copies elements and the copy is independent (rmem.d:380 unittest)", () => {
        const s1 = [0, 1, 2];
        const s2 = arraydup(s1)!;
        s2[0] = 4;
        expect(s1).toEqual([0, 1, 2]); // original unchanged
        expect(s2).toEqual([4, 1, 2]);
    });

    it("is a SHALLOW copy: element references are shared (class T)", () => {
        const obj = { tag: 1 };
        const src = [obj];
        const dup = arraydup(src)!;
        expect(dup[0]).toBe(obj); // same reference, not a clone
        dup[0].tag = 9;
        expect(obj.tag).toBe(9); // mutation through the shared reference is visible
    });

    it("copies an empty array to an empty copy (port keeps only the explicit-null guard)", () => {
        // D returns null for [] too, but the port cannot distinguish JS [] from a null slice;
        // it preserves only the explicit null -> null guard. An empty [] copies to empty.
        const dup = arraydup<number>([]);
        expect(dup).not.toBeNull();
        expect(dup!.length).toBe(0);
    });
});

// Region/RegionPos are re-exported from ./region.ts (their canonical dmd-path home); the full
// observable-contract tests (incl. the ported region.d:138 unittest) live in region.test.ts.
// Here we only confirm the re-export resolves to a usable trivial GC-backed allocator.
describe("Region — re-exported from ./region.ts (trivial GC allocator)", () => {
    it("malloc(0) returns null (region.d:53)", () => {
        expect(new Region().malloc(0)).toBeNull();
    });

    it("malloc(n>0) returns a fresh, contained byte block (region.d:51)", () => {
        const reg = new Region();
        const p = reg.malloc(100);
        expect(p).not.toBeNull();
        expect(reg.contains(p)).toBe(true);
        expect(reg.size()).toBeGreaterThan(0);
    });

    it("savePos returns an opaque RegionPos token", () => {
        expect(new Region().savePos()).toBeInstanceOf(RegionPos);
    });

    it("release rolls back to the checkpoint", () => {
        const reg = new Region();
        const pos = reg.savePos();
        reg.malloc(64);
        reg.release(pos);
        expect(reg.size()).toBe(0);
    });
});
