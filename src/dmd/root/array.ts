// Port of dmd/root/array.d — the growable container `Array!T`.
// Contract: docs/porting/08-runtime-lib.md §2 (2.0 … 2.9). Read that section before editing.
//
// The single most-used runtime type in the frontend (123 `Array!` instantiations,
// _ground-truth.md §4). Ported as ONE TS-native generic class backed by a plain JS array
// (`private data: T[]`) — NOT monomorphized, NO runtime type-witness (08 §2.0).
//
// Governing invariants (08 §0):
//   - No raw pointers / no manual allocation: values live in a JS array; `reserve`/`tdata`
//     allocation tuning collapses to a no-op / backing-array accessor.
//   - `length` is the JS array's own length — the array IS the source of truth, there is no
//     separate count field. Growing leaves new slots UNINITIALIZED (no generic `T.init`,
//     08 §2.0a); the asserted invariant is that ported code writes every slot before reading it.
//   - `find`/`contains` use identity (`===`) and return `SIZE_MAX` (a pure sentinel, 09 §1.3)
//     when absent — never `-1`-as-an-index.

import { assert, assertUnreachable } from "../../assert.js";
import { dsConcat, ds } from "../../dstring.js";
import type { DString } from "../../dstring.js";
import type { RootObject } from "../rootobject.js";
import type { ArgumentLabel, Expression } from "../expression.js";
import { SIZE_MAX } from "../../numeric.js";

/**
 * `Array<T>` — faithful port of D's `extern(C++) struct Array(T)` (array.d:29).
 *
 * Representation: a single backing `T[]`. `length` is that array's length (read AND write —
 * D `Array.length` is a public mutable field, array.d:31). Element types `T` are class
 * references (`Dsymbol`, `Expression`, …) or value types; the container body never inspects `T`.
 *
 * Value semantics: D's `Array` is a *struct* with `@disable this(this)` (array.d:48) — it does
 * not copy on plain assignment, callers use `.copy()` (2.3) for an explicit clone. In the port
 * the class is already a reference; `.copy()` is the explicit shallow clone (03-value-semantics.md
 * keeps the deep/value-element copy discipline separate from this container clone).
 *
 * Grow-without-prefill (08 §2.0a): there is NO generic `T.init`. Growing `length`/`setDim`/`zero`
 * leaves new slots as JS holes (`undefined`). A call site that reads a grown slot as a default is a
 * genuine default-dependence → escalate (11), do NOT guess a default.
 */
export class Array<T> {
    // The backing store. Its `.length` IS the logical length — no separate count field, so the two
    // can never drift (a class of D `Array` bugs from `length` vs `data.length` disagreement is gone).
    private data: T[] = [];

    /**
     * Construct empty, or pre-sized to `dim` (array.d:43 `this(size_t dim)`).
     * Pre-sizing grows WITHOUT pre-fill (08 §2.0a): slots [0..dim) are holes until written.
     * Precondition (asserted): `dim >= 0`.
     */
    constructor(dim?: number) {
        if (dim !== undefined) {
            assert(dim >= 0, "Array: negative dim");
            this.data.length = dim;
        }
    }

    /**
     * Typesafe-variadic factory (was `this(U)(U[] args...)` if struct/class, array.d:60).
     * Per 08 §2.9 the `is(U==struct)||is(U==class)` capability constraint is DROPPED — every
     * frontend call satisfies it. Declares its own `<U>` so the call site keeps its element type.
     */
    static from<U>(...args: U[]): Array<U> {
        const a = new Array<U>();
        for (const v of args) a.push(v);
        return a;
    }

    // ── length / opDollar ──────────────────────────────────────────────────────────────────────

    /** Element count (D `.length` read, array.d:31). */
    get length(): number {
        return this.data.length;
    }

    /**
     * Resize (D `.length` write). Grow leaves new slots UNINITIALIZED (no `T.init`, 08 §2.0a);
     * shrink truncates. Setting a JS array's `.length` does exactly this — no per-slot fill.
     * Precondition (asserted): `n >= 0`.
     */
    set length(n: number) {
        assert(n >= 0, "Array.length: negative");
        this.data.length = n;
    }

    /**
     * `$` inside an index/slice expression (D `alias opDollar = length`, array.d:393). Same value
     * as `length`; kept as a distinct accessor so call-site `arr[$-1]` translations read literally.
     */
    opDollar(): number {
        return this.data.length;
    }

    /** D `setDim(n)` (array.d:281) — set length to `n`, grow WITHOUT pre-fill (08 §2.0a). */
    setDim(n: number): void {
        this.length = n;
    }

    /**
     * Capacity hint (D `reserve`, array.d:160). A JS array grows on demand, so this is a NO-OP —
     * the inline `smallarray`/`xmalloc`/`xrealloc` tuning has no analogue in a GC'd port (08 §2.0).
     */
    reserve(_nentries: number): void {}

    /**
     * Raw-memory zero-init (D `zero()`, array.d:323 `data[0..length] = T.init`). With NO generic
     * `T.init` (08 §2.0a) this CANNOT fill slots. It is a no-op kept for diff-fidelity. If a call
     * site relied on `zero()` to make slots READABLE as defaults that is a real default-dependence
     * → escalate (11) or special-case at the single known `T`; never synthesize a generic default.
     */
    zero(): void {
        // intentionally empty: see method doc — no generic T.init in the port (08 §2.0a)
    }

    // ── element access (opIndex / opIndexAssign) ───────────────────────────────────────────────

    /**
     * D `arr[i]` read — `ref inout(T) opIndex(size_t i)` (array.d:300). The ref-ness is invisible
     * in JS for a read; the call-site rewrite for a WRITE is `opIndexAssign` (08 §2.0c).
     * Precondition (asserted): `0 <= i < length`.
     */
    opIndex(i: number): T {
        assert(i >= 0 && i < this.data.length, "Array.opIndex: index out of range");
        return this.data[i];
    }

    /**
     * D `arr[i] = v` write through the ref-returning `opIndex` (08 §2.0c). NOTE arg order is
     * VALUE-FIRST (`opIndexAssign(v, i)`), per 05-operators.md §7's canonical rewrite.
     * Precondition (asserted): `0 <= i < length`.
     */
    opIndexAssign(v: T, i: number): void {
        assert(i >= 0 && i < this.data.length, "Array.opIndexAssign: index out of range");
        this.data[i] = v;
    }

    // ── append / push ──────────────────────────────────────────────────────────────────────────

    /** D `push(v)` (array.d:140) — append; RETURNS `this` for chaining (`a.push(x).push(y)`). */
    push(v: T): this {
        this.data.push(v);
        return this;
    }

    /** D `pushSlice(a)` (array.d:147) — append every element of a plain slice; returns `this`. */
    pushSlice(a: readonly T[]): this {
        for (const v of a) this.data.push(v);
        return this;
    }

    /**
     * D `append(a)` (array.d:155) — append another `Array` (or null = no-op); returns `this`.
     * D took a `typeof(this)*` (pointer, hence nullable); in the port classes are refs so the
     * parameter is `Array<T> | null`.
     */
    append(a: Array<T> | null): this {
        if (a) this.insertArray(this.data.length, a);
        return this;
    }

    /** D `shift(v)` (array.d:318) — prepend at index 0. */
    shift(v: T): void {
        this.data.unshift(v);
    }

    // ── remove / pop ───────────────────────────────────────────────────────────────────────────

    /**
     * D `remove(i)` (array.d:225) — delete the element at `i`, shifting the tail left.
     * Precondition (asserted): `0 <= i < length`.
     */
    remove(i: number): void {
        assert(i >= 0 && i < this.data.length, "Array.remove: index out of range");
        this.data.splice(i, 1);
    }

    /**
     * D `pop()` (array.d:329) — remove and return the last element. Asserts non-empty (D's
     * `data[--length]` would read out of bounds on an empty array — boundary-validation.md: loud).
     */
    pop(): T {
        assert(this.data.length > 0, "Array.pop: empty");
        return this.data.pop() as T;
    }

    // ── insert — four overloads (08 §2.2, array.d:235-276) ──────────────────────────────────────
    //
    // The agent disambiguates by the D static type at the call site, then calls the matching
    // named method below. The public `insert` overload set mirrors the D arities so the four
    // call shapes resolve; the (index, Array) vs (index, T) collision when T is number-ish is
    // resolved by the explicit method name when needed (insertArray vs insertOne).

    /** insert(index, a: Array|null) — array.d:235 (pointer overload). */
    insert(index: number, a: Array<T> | null): void;
    /** insert(index, a: T[]) — array.d:248 (slice overload). */
    insert(index: number, a: readonly T[]): void;
    /** insert(index, v: T) — array.d:258 (single element). */
    insert(index: number, v: T): void;
    /** insert(index, count, value) — array.d:267 (count copies of value). */
    insert(index: number, count: number, value: T): void;
    insert(index: number, b: Array<T> | null | readonly T[] | number | T, value?: T): void {
        assert(index >= 0 && index <= this.data.length, "Array.insert: index out of range");
        if (value !== undefined) {
            // (index, count, value): b is the count. array.d:267
            this.insertCopies(index, b as number, value);
            return;
        }
        if (b === null) return; // (index, Array|null) with null → no-op (array.d:236 `if (a)`)
        if (b instanceof Array) {
            this.insertArray(index, b);
            return;
        }
        if (globalThis.Array.isArray(b)) {
            this.insertSlice(index, b as readonly T[]);
            return;
        }
        this.insertOne(index, b as T);
    }

    /** insert(index, Array) — array.d:235. Splice another Array's elements in (shallow). */
    insertArray(index: number, a: Array<T>): void {
        this.data.splice(index, 0, ...a.data);
    }

    /** insert(index, T[]) — array.d:248. Splice a plain slice in. */
    insertSlice(index: number, a: readonly T[]): void {
        this.data.splice(index, 0, ...a);
    }

    /** insert(index, T) — array.d:258. Splice one element in. */
    insertOne(index: number, v: T): void {
        this.data.splice(index, 0, v);
    }

    /** insert(index, count, value) — array.d:267. Splice `count` copies of `value` in. */
    insertCopies(index: number, count: number, value: T): void {
        if (count === 0) return; // array.d:269
        assert(count > 0, "Array.insert: negative count");
        const fill = new globalThis.Array<T>(count).fill(value);
        this.data.splice(index, 0, ...fill);
    }

    // ── copy (08 §2.3, array.d:314) ────────────────────────────────────────────────────────────

    /**
     * Shallow clone into a FRESH `Array` (D's `memcpy` of element slots). For `T` = class ref it
     * copies the REFERENCES, not the pointees — do NOT deep-clone (08 §2.3). Distinct from the
     * struct `.copy()` of 03-value-semantics.md (that copies value-type elements). D returns a
     * pointer `Array!T*`; in the port a class is already a reference, so we return `Array<T>` and
     * call sites drop the deref.
     */
    copy(): Array<T> {
        const a = new Array<T>();
        a.data = this.data.slice();
        return a;
    }

    // ── find / contains — identity, SIZE_MAX sentinel (08 §2.4, array.d:287-298) ────────────────

    /**
     * D `find(v)` (array.d:287) — identity (`is` → `===`) search. Returns the index, or `SIZE_MAX`
     * (09 §1.3 sentinel) when absent. Overwhelmingly used on `Dsymbol`/`Expression` references.
     * STOP (escalate) if you meet `find` on a struct-VALUE `Array`: `is` on a value type is by-bits
     * and needs a decision (08 §2.4) — `===` would compare object identity, not bits.
     */
    find(v: T): number {
        for (let i = 0; i < this.data.length; i++) {
            if (this.data[i] === v) return i;
        }
        return SIZE_MAX;
    }

    /** D `contains(v)` (array.d:296) — `find(v) != size_t.max`. */
    contains(v: T): boolean {
        return this.find(v) !== SIZE_MAX;
    }

    // ── slicing / backing data ─────────────────────────────────────────────────────────────────

    /**
     * D `opSlice()` / `opSlice(a, b)` (array.d:339/344) — a VIEW `[0..length)` or `[a..b)`. D
     * returns `data[0..length]`, an alias onto the backing memory. In the port we return a plain
     * slice (copy); call sites use it read-only (range comparison, formatting). If a call site
     * MUTATES through the slice expecting it to alias the backing store, STOP — that aliasing is
     * not preserved.
     * Precondition for the 2-arg form (asserted): `0 <= a <= b <= length` (array.d:346).
     */
    opSlice(): T[];
    opSlice(a: number, b: number): T[];
    opSlice(a?: number, b?: number): T[] {
        if (a === undefined) return this.data.slice();
        assert(a <= b! && b! <= this.data.length, "Array.opSlice: range out of bounds");
        return this.data.slice(a, b);
    }

    /**
     * D `tdata()` (array.d:308) — the backing data pointer. In the port: the backing JS array
     * itself (a live reference, NOT a copy — matches D returning `data.ptr`). Mutations through it
     * are visible on the `Array`. Use `opSlice()` when an independent copy is wanted.
     */
    tdata(): T[] {
        return this.data;
    }

    // ── sort (08 §2.5, array.d:374-387) ────────────────────────────────────────────────────────

    /**
     * In-place sort; returns `this` (D returns `ref typeof(this)`). Two forms:
     *   - `sort(pred)`: explicit comparator (C qsort convention `<0 / 0 / >0`). D passes element
     *     POINTERS and the predicate derefs immediately; in the port the predicate receives the
     *     ELEMENTS directly (refs for classes, values for value types) — translate the deref away.
     *   - `sort()`: default — uses each element's `opCmp` (operators are methods in the port,
     *     05-operators.md). Routed via `(a as { opCmp(o: T): number }).opCmp(b)`.
     *
     * UNVERIFIED (08 §2.5): C `qsort` is NOT stable, JS `Array.sort` IS. If a tie-break ever
     * changes a `fail_compilation` diagnostic ORDER, STOP and probe that call site.
     */
    sort(pred?: (a: T, b: T) => number): this {
        if (this.data.length < 2) return this; // array.d:375
        const cmp = pred ?? ((a: T, b: T) => (a as { opCmp(o: T): number }).opCmp(b));
        this.data.sort(cmp);
        return this;
    }

    // ── each! — expansion-safe iteration (08 §2.6, array.d:680-788) ─────────────────────────────

    /**
     * D `each!(callable)` — iterate, RE-READING `length` each step so callers may append DURING
     * iteration (array.d:732 unittest). Two forms by callback return type:
     *   - void form (array.d:683): iterate all.
     *   - int form (array.d:772): stop at the first non-zero result and return it; else return 0.
     *
     * This is the ONE case where the §2.0b `[Symbol.iterator]` / `for…of` path is INVALID — a
     * `for…of` snapshots the iterator and would miss appended elements (08 §2.6). `each` call
     * sites stay `each`; do NOT collapse them to `for…of`.
     */
    // Int overload FIRST: TS resolves overloads in order and a number-returning callback is
    // assignable to a void-returning parameter, so with the void form first the int form was
    // unselectable and `return arr.each(cb)` did not type-check (reproduced on attribsem.d:72).
    each(cb: (e: T) => number): number;
    each(cb: (e: T) => void): void;
    each(cb: (e: T) => void | number): void | number {
        for (let i = 0; i < this.data.length; ++i) {
            // re-read this.data.length each iteration (NOT a cached bound) — expansion-safe
            const r = cb(this.data[i]);
            if (typeof r === "number" && r !== 0) return r;
        }
        return 0;
    }

    // ── iteration — foreach over an Array value (08 §2.0b) ──────────────────────────────────────

    /**
     * D `foreach (e; arr)` over an `Array` VALUE lowers to `for (const e of arr)`. Delegates to the
     * backing array's iterator (06-control-flow.md owns the loop-form rewrite). NOTE: not valid for
     * the expansion-during-iteration case — use `each` there (08 §2.6).
     */
    [Symbol.iterator](): Iterator<T> {
        return this.data[Symbol.iterator]();
    }
}

// ── Free functions in array.d (module-scope, not methods) — 08 §2.8 ─────────────────────────────

/**
 * D `peekSlice(Array!T* a)` (array.d:515) — expose an `Array` (or null) as a plain slice.
 * `a ? a.opSlice() : []` (null → empty, matching D's `null` return).
 */
export function peekSlice<T>(a: Array<T> | null): T[] {
    return a ? a.opSlice() : [];
}

/**
 * D `split(ref Array!T, index, length)` (array.d:513) — grow by `length` and shift everything at
 * and past `index` to the right, making room for `length` new (UNINITIALIZED, 08 §2.0a) slots.
 * Mutates `a` in place. Precondition (asserted): `index <= a.length`.
 */
export function split<T>(a: Array<T>, index: number, length: number): void {
    if (length <= 0) return; // array.d:515 `if (length > 0)`
    assert(index <= a.length, "split: index out of range");
    const previousDim = a.length;
    a.setDim(a.length + length);
    // Shift [index..previousDim) right by `length`, high-to-low (array.d:519 loop).
    for (let i = previousDim; i > index; ) {
        --i;
        a.opIndexAssign(a.opIndex(i), i + length);
    }
}

/**
 * D `reverse(T[] a)` (array.d:559) — in-place reverse of a PLAIN slice (not an `Array`); returns it.
 */
export function reverse<T>(a: T[]): T[] {
    a.reverse();
    return a;
}

// ── Array!T.toString / toChars (array.d:74-140) — per-T variants, 07 §3.5(b) ────────────────────
//
// D selects the element renderer at compile time on T (`is(typeof(T.init.toString()))`, else
// `toDString`, else `assert(0)`, array.d:125-136). `Array<T>` stays one generic class, so the
// divergent method is split per element type, and only at the types the frontend instantiates it
// for: `Objects` (traits.d:2238), `Expressions` and `ArgumentLabels` (expressionsem.d:354).
// No generic default exists for other element types.

/// Shared body of array.d `toStringImpl` for the `toString` leg: `[e0,e1,...]`, a null element
/// (`is(typeof(a.data[u] is null))` holds for class elements) rendering as `null`. Fresh buffer.
function toStringImplObjects(a: Array<RootObject | null>): DString {
    const parts: DString[] = [ds("[")];
    for (let u = 0; u < a.length; ++u) {
        if (u !== 0)
            parts.push(ds(","));
        const e = a.opIndex(u);
        parts.push(e === null ? ds("null") : e.toString());
    }
    parts.push(ds("]"));
    return dsConcat(...parts);
}

/// D `Array!RootObject.toString` (array.d:75): `[a,b]`, elements through `RootObject.toString`,
/// null elements as `null`. The returned DString excludes D's terminating NUL (`str[0 .. $-1]`).
export function toStringObjects(a: Array<RootObject | null>): DString {
    return toStringImplObjects(a);
}

/// D `Array!RootObject.toChars` (array.d:139, `toString.ptr`): the same bytes; the DString stops
/// where D's NUL-terminated `const(char)*` would.
export function toCharsObjects(a: Array<RootObject | null>): DString {
    return toStringObjects(a);
}

/// D `Array!Expression.toString` (array.d:75): as `toStringObjects`; `Expression` inherits
/// `RootObject.toString`, and `Expression is null` holds, so null elements render as `null`.
export function toStringExpressions(a: Array<Expression | null>): DString {
    return toStringImplObjects(a);
}

/// D `Array!Expression.toChars` (array.d:139): the same bytes as `toStringExpressions`.
export function toCharsExpressions(a: Array<Expression | null>): DString {
    return toStringExpressions(a);
}

/// D `Array!ArgumentLabel.toString`: `ArgumentLabel` is a struct with neither `toString` nor
/// `toDString`, so D's `static else` leg (array.d:135) is `assert(0)` whenever it is called.
export function toStringArgumentLabels(_a: Array<ArgumentLabel>): never {
    return assertUnreachable("Array!ArgumentLabel.toString: element has no toString/toDString (array.d:135)");
}

/// D `Array!ArgumentLabel.toChars` (array.d:139): reaches `toString`, hence the same `assert(0)`.
export function toCharsArgumentLabels(a: Array<ArgumentLabel>): never {
    return toStringArgumentLabels(a);
}
