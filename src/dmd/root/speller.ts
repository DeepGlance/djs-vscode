/**
 * Spell checker
 *
 * Does not have any dependencies on the rest of DMD.
 *
 * Copyright: Copyright (C) 1999-2025 by The D Language Foundation, All Rights Reserved
 * Authors:   Walter Bright, https://www.digitalmars.com
 * License:   $(LINK2 https://www.boost.org/LICENSE_1_0.txt, Boost License 1.0)
 * Source:    $(LINK2 https://github.com/dlang/dmd/blob/master/compiler/src/dmd/root/speller.d, root/_speller.d)
 * Documentation:  https://dlang.org/phobos/dmd_root_speller.html
 * Coverage:    https://codecov.io/gh/dlang/dmd/src/master/compiler/src/dmd/root/speller.d
 *
 * Faithful port of dmd/root/speller.d (NOT a runtime-lib module — full structural mirror).
 */

// module dmd.root.speller;

import type { DString } from "../../dstring.js";
import { ds } from "../../dstring.js";

/**
 * A single-slot box for a D `out`/`ref` parameter (03-value-semantics.md §3.3).
 * The search delegate's `out int cost` becomes `cost: Ref<number>`; the delegate writes
 * `cost.value`. Also used to carry `combineSpellerResult`'s `ref T p, ref int cost` pair.
 */
export interface Ref<T> {
    value: T;
}

/**
 * The "did you mean" search delegate.
 *
 * D type: `T delegate(const(char)[] p, out int cost)` — the `alias dg` template parameter of
 * `speller`. The `const(char)[] p` is a trial spelling (a view into the speller's scratch
 * buffer — read it immediately, do NOT retain it past the call). `out int cost` is the match
 * cost, written by the delegate (`cost.value = …`). Returns the dictionary value `T` for a
 * match, or `null` (D `T.init`) for no match.
 *
 * `T` is always a reference/pointer type at the frontend's call sites, so `null` is its `.init`.
 */
export type SearchFn<T> = (p: DString, cost: Ref<number>) => T | null;

/**************************************************
 * Looks for correct spelling.
 * Looks a distance of up to two.
 * This does an exhaustive search, so can potentially be very slow.
 *
 * `alias dg` (the compile-time search delegate) is reproduced as a runtime parameter `dg`:
 * D instantiates `speller!dg` per call site with a fixed delegate; passing it explicitly is the
 * faithful monomorphic-per-call-site form. The `if (isSearchFunction!dg)` template constraint
 * (just "dg is callable as `dg(const(char)[], out int) -> T`") is carried by the `SearchFn<T>`
 * type — the `isSearchFunction`/`searchFunctionType` template machinery resolves away here.
 *
 * Params:
 *      seed = wrongly spelled word
 *      dg = search delegate of the form `T delegate(const(char)[] p, out int cost)`
 * Returns:
 *      null = no correct spellings found,
 *      otherwise the value returned by dg() for first possible correct spelling
 */
export function speller<T>(seed: DString, dg: SearchFn<T>): T | null {
    const maxdist: number = seed.length < 4 ? Math.floor(seed.length / 2) : 2;
    for (let distance = 0; distance < maxdist; distance++) {
        const p = spellerX<T>(seed, dg, distance !== 0);
        if (p !== null)
            return p;
        //      if (seedlen > 10)
        //          break;
    }
    return null; // didn't find it
}

// D `private:` — the following are module-private (faithful to the source). They are emitted
// WITHOUT TS `private` (those apply to class members, not module symbols) and left
// un-exported so they stay file-local, matching D's `private:` visibility.

// resolved: `enum isSearchFunction(alias fun) = is(searchFunctionType!fun);` — template
//           constraint; carried by the `SearchFn<T>` type (see `speller` above). Dropped.
// resolved: `alias searchFunctionType(alias fun) = typeof(...)` — extracts the delegate's
//           return type `T`; modeled as the generic `T` parameter. Dropped.

/*************************************
 * Spell check level 1.
 * Params:
 *      dg = delegate that looks up string in dictionary AA and returns value found
 *      seed = starting string
 *      flag = if true, do 2 level lookup otherwise 1 level
 * Returns:
 *      whatever dg returns, null if no match
 */
function spellerX<T>(seed: DString, dg: SearchFn<T>, flag: boolean): T | null {
    if (!seed.length)
        return null;

    /* Need buffer to store trial strings in.
     * D used a SmallBuffer!char (stack `char[30]` backing, heap fallback) sized `seed.length + 1`;
     * under GC the allocation strategy is irrelevant — a plain byte buffer of the same length
     * reproduces every `buf[a .. b]` slice the algorithm reads/writes.
     */
    const buf: DString = new Uint8Array(seed.length + 1);

    // ref-pair holder for the running best result: D `int cost = int.max; <T> p = null;`
    // (`ref T p, ref int cost` are threaded through `combineSpellerResult`).
    const best: Ref2<T> = { p: null, cost: INT_MAX };

    /* Deletions */
    bufWrite(buf, 0, dsSub(seed, 1, seed.length)); // buf[0 .. seed.length - 1] = seed[1 .. $];
    for (let i = 0; i < seed.length; i++) {
        //printf("del buf = '%s'\n", buf);
        const ncost: Ref<number> = { value: 0 };
        const np = flag
            ? spellerY<T>(dsSub(buf, 0, seed.length - 1), dg, i, ncost)
            : dg(dsSub(buf, 0, seed.length - 1), ncost);
        if (combineSpellerResult<T>(best, np, ncost.value))
            return best.p;
        buf[i] = seed[i];
    }

    /* Transpositions */
    if (!flag) {
        bufWrite(buf, 0, dsSub(seed, 0, seed.length)); // buf[0 .. seed.length] = seed;
        for (let i = 0; i + 1 < seed.length; i++) {
            // swap [i] and [i + 1]
            buf[i] = seed[i + 1];
            buf[i + 1] = seed[i];
            //printf("tra buf = '%s'\n", buf);
            const ncost: Ref<number> = { value: 0 };
            const np = dg(dsSub(buf, 0, seed.length), ncost);
            if (combineSpellerResult<T>(best, np, ncost.value))
                return best.p;
            buf[i] = seed[i];
        }
    }

    /* Substitutions */
    bufWrite(buf, 0, dsSub(seed, 0, seed.length)); // buf[0 .. seed.length] = seed;
    for (let i = 0; i < seed.length; i++) {
        for (const s of idchars) {
            buf[i] = s;
            //printf("sub buf = '%s'\n", buf);
            const ncost: Ref<number> = { value: 0 };
            const np = flag
                ? spellerY<T>(dsSub(buf, 0, seed.length), dg, i + 1, ncost)
                : dg(dsSub(buf, 0, seed.length), ncost);
            if (combineSpellerResult<T>(best, np, ncost.value))
                return best.p;
        }
        buf[i] = seed[i];
    }

    /* Insertions */
    bufWrite(buf, 1, dsSub(seed, 0, seed.length)); // buf[1 .. seed.length + 1] = seed;
    for (let i = 0; i < seed.length + 1; i++) {
        // yes, do seed.length+1 iterations
        for (const s of idchars) {
            buf[i] = s;
            //printf("ins buf = '%s'\n", buf);
            const ncost: Ref<number> = { value: 0 };
            const np = flag
                ? spellerY<T>(dsSub(buf, 0, seed.length + 1), dg, i + 1, ncost)
                : dg(dsSub(buf, 0, seed.length + 1), ncost);
            if (combineSpellerResult<T>(best, np, ncost.value))
                return best.p;
        }
        if (i < seed.length)
            buf[i] = seed[i];
    }

    return best.p; // return "best" result
}

/**********************************************
 * Do second level of spell matching.
 * Params:
 *      dg = delegate that looks up string in dictionary AA and returns value found
 *      seed = starting string
 *      index = index into seed[] that is where we will mutate it
 *      cost = set to cost of match
 * Returns:
 *      whatever dg returns, null if no match
 */
function spellerY<T>(seed: DString, dg: SearchFn<T>, index: number, cost: Ref<number>): T | null {
    if (!seed.length)
        return null;

    /* Allocate a buf to store the new string to play with, needs
     * space for an extra char for insertions
     */
    const buf: DString = new Uint8Array(seed.length + 1);
    bufWrite(buf, 0, dsSub(seed, 0, index)); // buf[0 .. index] = seed[0 .. index];

    cost.value = INT_MAX; // start with worst possible match
    const best: Ref2<T> = { p: null, cost: cost.value };

    /* Delete character at seed[index] */
    if (index < seed.length) {
        // buf[index .. seed.length - 1] = seed[index + 1 .. $]; // seed[] with deleted character
        bufWrite(buf, index, dsSub(seed, index + 1, seed.length));
        const ncost: Ref<number> = { value: 0 };
        const np = dg(dsSub(buf, 0, seed.length - 1), ncost); // look it up
        if (combineSpellerResult<T>(best, np, ncost.value)) {
            // compare with prev match
            cost.value = best.cost;
            return best.p; // cannot get any better
        }
    }

    /* Substitute character at seed[index] */
    if (index < seed.length) {
        bufWrite(buf, 0, dsSub(seed, 0, seed.length)); // buf[0 .. seed.length] = seed;
        for (const s of idchars) {
            buf[index] = s; // seed[] with substituted character
            //printf("sub buf = '%s'\n", buf);
            const ncost: Ref<number> = { value: 0 };
            const np = dg(dsSub(buf, 0, seed.length), ncost);
            if (combineSpellerResult<T>(best, np, ncost.value)) {
                cost.value = best.cost;
                return best.p;
            }
        }
    }

    /* Insert character at seed[index] */
    bufWrite(buf, index + 1, dsSub(seed, index, seed.length)); // buf[index + 1 .. seed.length + 1] = seed[index .. $];
    for (const s of idchars) {
        buf[index] = s;
        //printf("ins buf = '%s'\n", buf);
        const ncost: Ref<number> = { value: 0 };
        const np = dg(dsSub(buf, 0, seed.length + 1), ncost);
        if (combineSpellerResult<T>(best, np, ncost.value)) {
            cost.value = best.cost;
            return best.p;
        }
    }
    cost.value = best.cost;
    return best.p; // return "best" result
}

/* Characters used to substitute ones in the string we're checking
 * the spelling on.
 */
const idchars: DString = ds("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_");

/**
 * The `ref T p, ref int cost` pair threaded through `combineSpellerResult` (the running best
 * result). D passes the two locals by `ref`; here one mutable holder carries both.
 */
interface Ref2<T> {
    p: T | null;
    cost: number;
}

// D `int.max` — the initial worst-possible cost. `int` is the `number` domain (09 §1).
const INT_MAX = 0x7fffffff;

/**************************************************
 * Combine a new result from the spell checker to
 * find the one with the closest symbol with
 * respect to the cost defined by the search function
 *
 * D signature: `bool combineSpellerResult(T)(ref T p, ref int cost, T np, int ncost)`.
 * The `ref T p, ref int cost` pair is carried by the `best` holder (mutated in place).
 *
 * Params:
 *      best = best found spelling so far (`best.p` = T.init/null if none yet; `best.cost` =
 *          int.max if none yet). If np is better, both fields are replaced.
 *      np = current spelling to check against best.p, null if none
 *      ncost = cost of np if np is not null
 * Returns:
 *      true    if the cost is less or equal 0, meaning we can stop looking
 *      false   otherwise
 */
function combineSpellerResult<T>(best: Ref2<T>, np: T | null, ncost: number): boolean {
    if (np && ncost < best.cost) {
        // if np is better
        best.p = np; // np is new best match
        best.cost = ncost;
        if (best.cost <= 0)
            return true; // meaning we can stop looking
    }
    return false;
}

// ---------------------------------------------------------------------------------------------
// Buffer-slice helpers — make the D `buf[a .. b] = …` / `buf[a .. b]` idioms explicit over the
// Uint8Array scratch buffer. The byte semantics match D char-slices exactly (08-runtime-lib.md).
// ---------------------------------------------------------------------------------------------

/** D `dest[off .. off + src.length] = src;` — copy `src`'s bytes into `dest` starting at `off`. */
function bufWrite(dest: DString, off: number, src: DString): void {
    dest.set(src, off);
}

/**
 * D `s[start .. end]` — a shared VIEW (no copy), matching D's slice-of-a-mutable-buffer.
 * The delegate reads it immediately and never retains it, so the view (vs an independent copy)
 * is both faithful and correct (08-runtime-lib.md: sub-slice without `.dup` is a view).
 */
function dsSub(s: DString, start: number, end: number): DString {
    return s.subarray(start, end);
}
