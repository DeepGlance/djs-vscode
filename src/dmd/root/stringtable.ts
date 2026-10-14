// Hand-written djs replacement for dmd/root/stringtable.d — the frontend's string-keyed hash map.
// Contract: docs/porting/08-runtime-lib.md §5 (the contract-critical invariants live there).
//
// ROOT-RUNTIME EXEMPTION (00-how-to-use.md §0.1): this is NOT a 1:1 structural port. DMD's
// StringTable is an open-addressing engine (nextpow2/findSlot/grow over hand-allocated pools,
// stringtable.d:84-313) whose entire purpose is to manage memory that JS's GC manages for us.
// Per the exemption we DROP that engine wholesale and implement the OBSERVABLE CONTRACT over a
// JS `Map`. Auditable deletions:
//   - dropped: nextpow2/loadFactor/StringEntry/pools/nfill/count/countTrigger (stringtable.d:24-93)
//     — capacity + open-addressing bookkeeping; a JS Map grows itself.
//   - dropped: findSlot/grow/allocValue/getValue/freeMem (stringtable.d:264-313) — slot probing
//     and pool allocation; replaced by Map get/has/set.
//   - dropped: ~this destructor (stringtable.d:111) — GC reclaims the Map.
//   - dropped: calcHash-based bucketing — keying is by raw bytes via a Latin-1 key string (below),
//     so hash.ts is NOT imported here (its calcHash survives only for direct frontend callers, 08 §9).
//
// Governing invariants kept exactly (08 §0 + §5):
//   - Key is the RAW BYTE SEQUENCE, compared by bytes+length (stringtable.d:292 memcmp), never by
//     decoded text. `keyOf` is an injective Latin-1 encoding of the bytes (one byte -> one BMP code
//     unit), so equal byte sequences ⇒ equal Map keys and distinct byte sequences never collide.
//   - StringValue stores a COPY of the key bytes (stringtable.d allocValue copies; the caller's
//     buffer is transient — 08 §5, 13 xstrdup).
//   - insert is NO-CLOBBER (returns null if present); update is INSERT-OR-GET (never null).
//   - Iteration order is INSERTION order (JS Map). DMD's is hash-bucket order, explicitly
//     "not specified" (stringtable.d:407 unittest). See the apply() note for the FLAG.

import type { DString } from "../../dstring.js";

/**
 * Compute the Map key for a byte slice (the internal keying primitive — not part of the D API).
 *
 * Contract (08 §5, contract-critical): the key MUST be injective over byte sequences so that
 * `keyOf(a) === keyOf(b)` IFF `a` and `b` have identical length AND bytes — exactly D's
 * `memcmp(a, b, a.length) == 0 && a.length == b.length`. We use a LATIN-1 encoding: each byte
 * (0..255) becomes one BMP code unit via `String.fromCharCode`, so the string is a faithful 1:1
 * image of the bytes and length is preserved. Do NOT UTF-8-decode here: a UTF-8 decode is not
 * injective on arbitrary byte sequences (invalid sequences fold to U+FFFD), which would collide
 * two distinct identifier byte-strings — a silent symbol-table corruption.
 *
 * Cost: O(length), one pass + one string allocation. Called on every lookup/insert/update.
 */
function keyOf(str: DString): string {
    // String.fromCharCode.apply is the fast bulk path, but blows the call-stack arg limit on very
    // long keys; identifiers are short, yet for safety we fall back to a loop above a threshold.
    if (str.length <= 4096) {
        return String.fromCharCode.apply(null, str as unknown as number[]);
    }
    let s = "";
    for (let i = 0; i < str.length; i++) s += String.fromCharCode(str[i]);
    return s;
}

/**
 * An independent copy of the key bytes (stringtable.d allocValue: "a copy is made of str").
 * The caller's `DString` is a transient view (often a slice of the lexer's source buffer); the
 * interned entry MUST own its bytes so later mutation/aliasing of the source cannot corrupt it.
 */
function copyBytes(str: DString): DString {
    return str.slice();
}

/**
 * One interned entry — port of `struct StringValue(T)` (stringtable.d:53).
 *
 * In DMD this is a variable-length struct with the key chars stored in memory immediately after
 * the struct; here the bytes are an ordinary owned `Uint8Array`. The accessors reproduce the D
 * surface the frontend uses: `len()`, `toDchars()`, `toString()` — all returning the entry's own
 * key bytes (08 §5).
 *
 * `value` is a PUBLIC MUTABLE field: callers mutate it in place via `sv.value = …` (08 §5, e.g.
 * `update` then writing the slot). Keep it public and writable — do not hide it behind a setter.
 */
export class StringValue<T> {
    value: T;
    private readonly bytes: DString; // the interned key bytes (an owned copy)

    constructor(bytes: DString, value: T) {
        this.bytes = bytes;
        this.value = value;
    }

    /** D `size_t len()` (stringtable.d:67) — byte length of the key. */
    len(): number {
        return this.bytes.length;
    }

    /** D `const(char)* toDchars()` (stringtable.d:72) — the key chars. In djs the DString IS the chars. */
    toDchars(): DString {
        return this.bytes;
    }

    /** D `const(char)[] toString()` (stringtable.d:78) — the key as a D char-slice (its own bytes). */
    toString(): DString {
        return this.bytes;
    }
}

/**
 * `StringTable<T>` — string-keyed map, the frontend's primary symbol-name table (Identifier
 * interning, module/Dsymbol symbol tables). Port of `struct StringTable(T)` (stringtable.d:84).
 *
 * Canonical model (08 §5): a JS `Map<string, StringValue<T>>` keyed by `keyOf(bytes)`. The Map
 * replaces DMD's open-addressing engine entirely; all capacity/pool machinery is gone.
 *
 * Instantiated over a small fixed set of `T` in the frontend (verified grep of dmd/*.d):
 * `const(char)*`/`char*`/`const(ubyte)*` (→ DString|null, default null), `Type`/`Identifier`/
 * `ObjcSelector*` (class refs, default null), `bool` (default false), `int` (default 0),
 * `void*` (default null). The per-`T` default matters only to `update` — see its doc.
 *
 * Value-struct note: D's StringTable is a struct, but its only construction idiom is
 * default-init followed by `_init`. In the port, construction is `new StringTable<T>()`; `_init`
 * is a kept-for-fidelity no-op (08 §5). It is a reference type here; it is never copied by value.
 */
export class StringTable<T> {
    private map = new Map<string, StringValue<T>>();

    /**
     * D `void _init(size_t size = 0)` (stringtable.d:95). The `size` is a capacity hint for the
     * open-addressing table — a JS Map grows itself, so this is a NO-OP kept only for diff-fidelity
     * (277 `._init` call sites, 08 §5; in djs construction is `new StringTable<T>()`).
     */
    _init(_size = 0): void {
        // dropped: nextpow2 capacity math + xcalloc of the slot table (stringtable.d:95-107) — no-op.
    }

    /**
     * D `void reset(size_t size = 0)` (stringtable.d:109). Clears every entry; the `size` hint is
     * ignored (capacity is the Map's concern). After reset the table is empty (lookup → null).
     */
    reset(_size = 0): void {
        this.map.clear();
    }

    /**
     * D `inout(StringValue!T)* lookup(scope const(char)[] str)` (stringtable.d:130).
     *
     * Returns the entry for `str`, or `null` if absent (D returns a null pointer). Keying is by
     * raw bytes (08 §5) — a different `DString` object with identical bytes finds the same entry,
     * exactly D's `memcmp`-based lookup. Cost: one `keyOf` (O(len)) + Map get.
     */
    lookup(str: DString): StringValue<T> | null {
        return this.map.get(keyOf(str)) ?? null;
    }

    /**
     * D `StringValue!(T)* insert(scope const(char)[] str, T value)` (stringtable.d:157).
     *
     * NO-CLOBBER (contract-critical, 08 §5): if `str` is ALREADY interned, returns `null` and
     * leaves the existing entry untouched — the frontend relies on the null return to detect
     * "already interned" (stringtable.d:162). Otherwise interns a COPY of the key bytes with
     * `value`, and returns the new entry. Cost: one `keyOf` + Map has/set + one byte copy.
     */
    insert(str: DString, value: T): StringValue<T> | null {
        const k = keyOf(str);
        if (this.map.has(k)) return null; // already in table — do NOT overwrite (stringtable.d:160)
        const sv = new StringValue<T>(copyBytes(str), value);
        this.map.set(k, sv);
        return sv;
    }

    /**
     * D `StringValue!(T)* update(scope const(char)[] str)` (stringtable.d:181) — insert-or-get.
     *
     * NEVER returns null: if `str` is present, returns its entry; otherwise interns a new entry
     * whose value is `T.init` and returns it. D synthesizes `T.init`; the port FORBIDS a generic
     * default (08 §2.0 / §5 — "never by guessing a generic default"). Per the §5 decision we
     * resolve this by SPECIAL-CASING AT THE KNOWN `T`: the call site (which knows the concrete
     * `T`) passes the verified default as `init`. This is not a guess — it is the known-T default
     * supplied by the caller (ldc2-verified: pointer/class-ref `T.init` = null, `int` = 0,
     * `bool` = false). The value is only consulted when a NEW entry is created; on a hit `init`
     * is ignored (so callers may pass any value on a hit).
     *
     * If a future instantiation has an ambiguous default the caller cannot supply, STOP and
     * escalate (11) — do not widen this to a synthesized generic default.
     */
    update(str: DString, init: T): StringValue<T> {
        const k = keyOf(str);
        let sv = this.map.get(k);
        if (sv === undefined) {
            sv = new StringValue<T>(copyBytes(str), init); // allocValue(str, T.init) — T.init supplied by caller
            this.map.set(k, sv);
        }
        return sv;
    }

    /**
     * D `int apply(int function(const(StringValue!T)*) fp)` (stringtable.d:212).
     *
     * Walks every entry, calling `cb` on each; STOPS and returns `cb`'s value the moment it is
     * non-zero (and returns 0 if it never is). Mirrors D's `if (result) return result;`.
     *
     * ITERATION ORDER (FLAG, 08 §5): JS `Map` iterates in INSERTION order; DMD's table iterates
     * in hash-bucket order. The stringtable.d:407 unittest states the order "is not specified",
     * so this difference is contract-permitted. IF a `fail_compilation`/`compilable` test ever
     * asserts a specific multi-symbol order that depends on string-table iteration, STOP and
     * escalate — we would then need to reproduce bucket order.
     */
    apply(cb: (sv: StringValue<T>) => number): number {
        for (const sv of this.map.values()) {
            const result = cb(sv);
            if (result) return result;
        }
        return 0;
    }

    /**
     * D `int opApply(scope int delegate(const(StringValue!T)*) dg)` (stringtable.d:226) — `ditto`
     * of `apply`. Same body; kept as a distinct method because the frontend calls both forms
     * (function-pointer vs delegate). 05-operators.md owns the `foreach (sv; tab)` → `opApply`
     * rewrite, if any call site uses the foreach form.
     */
    opApply(cb: (sv: StringValue<T>) => number): number {
        return this.apply(cb);
    }
}
