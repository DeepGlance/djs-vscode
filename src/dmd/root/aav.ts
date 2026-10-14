// Port of dmd/root/aav.d — the void*-keyed associative array `AssocArray!(K,V)` (aav.d:275).
// Contract: docs/porting/08-runtime-lib.md §6. Read that section before editing.
//
// Why this is a thin wrapper over JS `Map`: DMD's aav is a hand-rolled open-addressing hash table
// (the `AA`/`aaA`/`hash`/`dmd_aaRehash` machinery, aav.d:19-261) that exists ONLY because D has no
// GC-by-default here and keys are raw `void*`. JS has a GC, and a `Map` keyed by object reference
// uses SameValueZero — which IS object identity for references, exactly D's `void*` key `==`
// (08 §6 invariant). So the whole table ENGINE is replaced by `Map`; we do NOT port `aav.hash`,
// `dmd_aaGet`, `dmd_aaGetRvalue`, `dmd_aaRehash`, `AA`, or `aaA` — they are implementation detail.
//
// Governing invariants (08 §0):
//   - No raw pointers / no manual allocation: keys are JS object references stored directly in a
//     `Map`, never `cast(void*)`-stringified or indexed by offset. Do NOT stringify keys (08 §6).
//   - Identity keys: a `Map` with object keys compares by reference — matches D's `void*` `==`.
//
// THE TRAP (08 §6): D's `getLvalue` returns the ADDRESS of the value slot, so callers write
// `*p = v` through it. JS has no pointer-to-slot. Each `getLvalue` call site is rewritten by the
// translation agent into a get/set or get-or-create pair (see `getOrSet` doc). This file provides
// the destinations of that rewrite (`set`, `getOrSet`); it does NOT expose a slot pointer.

/**
 * `AssocArray<K, V>` — faithful port of D's `extern(C++) struct AssocArray(K,V)` (aav.d:275).
 *
 * Representation: a single `Map<K, V>` keyed by object identity. In the frontend `K` is an object
 * reference (`Dsymbol`, `Type`, `RootObject`, …) used as a dedup/cache key (template-instance cache
 * in dtemplate.d, CTFE caches in dinterpret.d, type caches in typesem.d). `V` is the cached value.
 *
 * Value semantics: D's `AssocArray` is a *struct* holding one pointer (`AA* aa`). In the port the
 * class is already a reference; default construction (`AssocArray!(K,V) aa;` in D) is `new AssocArray()`.
 * There is no `.copy()` for it — call sites never copy the struct (it is only ever passed by ref or
 * lives as a field); if one ever does, STOP and escalate (the pointer-sharing semantics of the D
 * struct copy would need a decision).
 *
 * Iteration order: a `Map` iterates in INSERTION order; DMD's table iterates in hash-bucket order
 * (aav.d:140 `asRange` walks `aa.b[0..b_length]`). This is an observable difference ONLY if a
 * diagnostic lists aav contents in order. The aav.d:196 unittest checks membership, not order
 * (it builds a `found[]` set). Decision (08 §6, FLAG): djs uses insertion order. If any test
 * asserts a specific aav iteration order, STOP and escalate.
 */
export class AssocArray<K, V> {
    // The backing store. `Map.size` IS the count — no separate `nodes` field to drift (the D `AA`
    // tracked `nodes` by hand, aav.d:49; here the Map owns it).
    private readonly map = new Map<K, V>();

    /**
     * Number of key/value pairs (aav.d:282, `dmd_aaLen`).
     *
     * Returns the live count. D's `length` returns 0 for a never-touched array (`aa is null`);
     * here a fresh `AssocArray` has an empty `Map`, so `length === 0` — same observable result.
     */
    get length(): number {
        return this.map.size;
    }

    /**
     * Lookup the value for `key`, or `null` if absent (aav.d:311, `opIndex` via `dmd_aaGetRvalue`).
     *
     * READ-ONLY: unlike `getLvalue`, this does NOT add the key on a miss (`dmd_aaGetRvalue` returns
     * `null` without inserting, aav.d:132). The D method is named `opIndex` (`aa[key]`); the call-site
     * rewrite `aa[key]` → `aa.get(key)` is owned by 05-operators.md. Keep the `=== null` /
     * `!== null` comparisons at call sites (D tests `is null` / `!is null`, e.g. aav.d:335).
     *
     * Cost: O(1) average. No allocation, no mutation.
     */
    get(key: K): V | null {
        // `?? null` collapses the `Map`'s `undefined`-on-miss to D's `null`-on-miss. A stored value
        // is never `undefined` (callers store object refs / values), so this cannot mask a real entry.
        return this.map.get(key) ?? null;
    }

    /**
     * Whether `key` is present (no D direct analogue — extracted from the `dmd_aaGet` "while found"
     * loop, aav.d:88-92, for call sites that test presence without needing the value).
     *
     * Cost: O(1) average. No mutation.
     */
    has(key: K): boolean {
        return this.map.has(key);
    }

    /**
     * Set the value for `key`, inserting if absent (the rewrite target of `*aa.getLvalue(k) = v`).
     *
     * D has no plain "set" — a write goes through `getLvalue` (add-if-absent, returns the slot
     * address) followed by `*p = v` (aav.d:338-339). The translation agent collapses that pair to a
     * single `aa.set(k, v)` (08 §6 invariant). Overwrites an existing value (the slot is the same).
     *
     * Cost: O(1) average.
     */
    set(key: K, value: V): void {
        this.map.set(key, value);
    }

    /**
     * Get the value for `key`, creating it from `makeDefault()` if absent (the rewrite target of the
     * `getLvalue` "read-or-conditionally-init" idiom).
     *
     * D's `getLvalue` is add-if-absent and the newly created slot holds `null` (aav.d:101 `e.value =
     * null`); call sites then do `auto p = aa.getLvalue(k); if (!*p) *p = make();` — i.e. lazily fill
     * a freshly-`null` slot. That whole pattern collapses here to `aa.getOrSet(k, make)` (08 §6).
     * `makeDefault` is called ONLY on a miss (lazy), so it is safe to allocate inside it.
     *
     * Precondition (caller's contract, not enforced): the stored value is never `undefined` — a
     * present-but-`undefined` entry cannot be distinguished from absent here. Frontend values are
     * object refs / defined values, so this holds (boundary-validation.md: no silent downstream guard).
     *
     * Cost: O(1) average; one `makeDefault()` call on a miss only.
     */
    getOrSet(key: K, makeDefault: () => V): V {
        let v = this.map.get(key);
        if (v === undefined) {
            v = makeDefault();
            this.map.set(key, v);
        }
        return v;
    }

    /**
     * A range of `[key, value]` pairs (aav.d:321, `asRange` → `AARange`).
     *
     * The D `AARange` walks the bucket array; here we delegate to `Map.entries()` (insertion order —
     * see the class doc on iteration order). Each yielded tuple mirrors D's `KeyValue { key, value }`
     * as `[K, V]`; a call site reading `kv.key` / `kv.value` rewrites to `kv[0]` / `kv[1]`.
     *
     * The tuples reference the live keys/values (no copy) — same as D's `front` returning the node's
     * `keyValue` by value over `void*`s (identities), so mutation of a value object is visible.
     */
    *asRange(): IterableIterator<[K, V]> {
        yield* this.map.entries();
    }
}
