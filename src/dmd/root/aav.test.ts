// Ported from dmd/root/aav.d unittests (aav.d:263, aav.d:328). 10-tests-diagnostics.md §1.
// Covers the §6 contract:
//   - empty: get() -> null, length 0;
//   - getOrSet (the getLvalue rewrite target) inserts on miss, length grows, get() sees it;
//   - identity keys (two distinct objects with equal shape are distinct keys);
//   - set overwrites, getOrSet is lazy + no-op when present;
//   - asRange yields all [key,value] pairs (membership, not order — aav.d builds a found-set).
import { describe, it, expect } from "vitest";
import { AssocArray } from "./aav.js";

describe("aav / AssocArray", () => {
  // Faithful port of the documented D `unittest` (aav.d:328-343) over AssocArray!(Object, Object).
  it("getLvalue + opIndex roundtrip (D unittest port, aav.d:328)", () => {
    const foo = {}; // `auto foo = new Object();`
    const bar = {}; // `auto bar = new Object();`
    const aa = new AssocArray<object, object>(); // `AssocArray!(Object, Object) aa;`

    expect(aa.get(foo)).toBe(null); // `assert(aa[foo] is null);` — read does NOT insert
    expect(aa.length).toBe(0); // `assert(aa.length == 0);`

    // `auto fooValuePtr = aa.getLvalue(foo); *fooValuePtr = bar;` collapses to getOrSet/set (08 §6).
    aa.getOrSet(foo, () => bar);

    expect(aa.get(foo)).toBe(bar); // `assert(aa[foo] is bar);` — identity, not equality
    expect(aa.length).toBe(1); // `assert(aa.length == 1);`
  });

  // Faithful port of the D `unittest` at aav.d:263-273 (the null-key / aaGet-then-aaGetRvalue path).
  // D uses `key == null` (a void* zero); the JS analogue of "a distinguished single key" is one
  // shared sentinel object reference reused across calls (identity is what matters, not the value).
  it("get-then-set roundtrip on a single key (D unittest port, aav.d:263)", () => {
    const key = {}; // stands in for D's `null` void* key: one identity reused below
    const aa = new AssocArray<object, number>();

    expect(aa.get(key)).toBe(null); // `Value v = dmd_aaGetRvalue(aa, null); assert(!v);`

    // `Value* pv = dmd_aaGet(&aa, null); assert(pv); *pv = cast(void*)3;` -> getOrSet inserts 3.
    aa.getOrSet(key, () => 3);

    // `v = dmd_aaGetRvalue(aa, null); assert(v == cast(void*)3);`
    expect(aa.get(key)).toBe(3);
  });

  it("get on a missing key returns null without inserting", () => {
    const aa = new AssocArray<object, number>();
    const k = {};
    expect(aa.get(k)).toBe(null);
    expect(aa.has(k)).toBe(false);
    expect(aa.length).toBe(0); // read did not add the key (opIndex via dmd_aaGetRvalue, aav.d:132)
  });

  it("set inserts then overwrites the same slot", () => {
    const aa = new AssocArray<object, number>();
    const k = {};
    aa.set(k, 1); // *getLvalue(k) = 1
    expect(aa.get(k)).toBe(1);
    expect(aa.length).toBe(1);
    aa.set(k, 2); // same identity key -> same slot, value replaced
    expect(aa.get(k)).toBe(2);
    expect(aa.length).toBe(1); // overwrite, not a new entry
  });

  it("getOrSet is lazy and a no-op when the key is already present", () => {
    const aa = new AssocArray<object, number>();
    const k = {};
    let calls = 0;
    const made = aa.getOrSet(k, () => {
      calls++;
      return 10;
    });
    expect(made).toBe(10);
    expect(calls).toBe(1); // makeDefault ran on the miss

    const again = aa.getOrSet(k, () => {
      calls++;
      return 99; // must NOT be used: key already present
    });
    expect(again).toBe(10); // returns the existing value
    expect(calls).toBe(1); // makeDefault NOT called on a hit (lazy)
    expect(aa.length).toBe(1);
  });

  it("keys are identity, not structural — two distinct objects are distinct keys", () => {
    const aa = new AssocArray<object, number>();
    const a = { id: 1 };
    const b = { id: 1 }; // structurally equal to `a`, but a different reference
    aa.set(a, 100);
    aa.set(b, 200);
    expect(aa.length).toBe(2); // identity keys: a !== b, so two entries (D void* ==)
    expect(aa.get(a)).toBe(100);
    expect(aa.get(b)).toBe(200);
  });

  it("has reflects presence", () => {
    const aa = new AssocArray<object, string>();
    const k = {};
    expect(aa.has(k)).toBe(false);
    aa.set(k, "v");
    expect(aa.has(k)).toBe(true);
  });

  it("getOrSet distinguishes a stored falsy value from absent", () => {
    // A present-with-falsy-value entry (value 0) must be returned as-is, NOT re-created. This is the
    // reason getOrSet probes with `=== undefined` (a Map miss), never a truthiness test on the value.
    const aa = new AssocArray<object, number>();
    const k = {};
    aa.set(k, 0); // falsy but present
    let calls = 0;
    const v = aa.getOrSet(k, () => {
      calls++;
      return 5;
    });
    expect(v).toBe(0); // returns the stored 0, not the default
    expect(calls).toBe(0); // makeDefault NOT called — key was present
    expect(aa.get(k)).toBe(0);
  });

  it("asRange yields all [key, value] pairs (membership; D builds a found-set, aav.d:213)", () => {
    const aa = new AssocArray<object, number>();
    const keys: object[] = [];
    for (let i = 1; i <= 50; i++) {
      // mirrors the aav.d:196 unittest loop (50 distinct keys)
      const key = {};
      keys.push(key);
      aa.set(key, i);
    }
    expect(aa.length).toBe(50);

    // Membership check via a found-set, exactly like the D unittest (aav.d:211-221) — order unspecified.
    const found = new Map<object, number>();
    let rangeCount = 0;
    for (const [k, v] of aa.asRange()) {
      expect(found.has(k)).toBe(false); // each key appears at most once
      found.set(k, v);
      rangeCount++;
    }
    expect(rangeCount).toBe(50); // `assert(rangeCount == i);` at the final iteration
    for (let i = 0; i < keys.length; i++) {
      expect(found.get(keys[i]!)).toBe(i + 1); // key -> its stored value, all present
    }
  });

  it("asRange over an empty array yields nothing (D: `foreach(kv; aa.asRange) assert(0);`, aav.d:198)", () => {
    const aa = new AssocArray<object, number>();
    let count = 0;
    for (const _kv of aa.asRange()) {
      void _kv;
      count++;
    }
    expect(count).toBe(0);
  });
});
