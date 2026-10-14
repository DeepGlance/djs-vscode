// Port of dmd/root/hash.d — MurmurHash2 (32-bit) + mixHash (64-bit boost::hash_combine) — plus the
// djs runtime hash helpers `hashOf` and the 32-bit `mixHash`/`mixHash32` overload (resolution #1).
// Contract: docs/porting/08-runtime-lib.md §9. Numeric domains: docs/porting/09-numerics.md.
//
// Why this module exists in a GC'd port: StringTable/aav are re-implemented over JS `Map`
// (08 §5/§6), so the hash ENGINE that drove DMD's open-addressing tables is gone. calcHash and
// mixHash survive only for the handful of frontend sites that call them DIRECTLY (e.g.
// CTFloat.hash, dtemplate instance hashing, mtype type hashing). Where they are called, the
// result feeds symbol identity / type identity, so parity must be EXACT — a single wrong bit
// collides a symbol or names it differently (09-numerics.md §8: hashes decide a compile outcome).
//
// Both bodies are reproduced bit-for-bit from hash.d and VERIFIED against ldc2-1.42.0 (the probe
// outputs are pinned in the co-located test). They are intentionally NOT unified: calcHash is the
// 32-bit `number` form, mixHash is the 64-bit `bigint` form (08 §9, the two live in different
// numeric domains — see each function's doc).

import type { DString } from "../../dstring.js";

/**
 * `calcHash(data)` — 32-bit MurmurHash2 over a byte slice (`hash.d:23`).
 *
 * Domain: the **32-bit `number`** form (09-numerics.md §1). Returns an unsigned 32-bit integer
 * in `0 … 2^32−1`. Distinct from `mixHash` (64-bit/bigint) — do NOT unify the two.
 *
 * Operand model: `data` is a `DString` (`Uint8Array`) — D's `const(char)[]`/`const(ubyte)[]`
 * is a byte array (08 §0 invariant 2), and `hash.d`'s `char[]` overload forwards to the `ubyte[]`
 * body unchanged. So `data[i]` is a byte in `0…255`; nothing here decodes UTF-8.
 *
 * Bit-for-bit fidelity (the load-bearing details):
 * - `h` starts at `data.length` read as `uint` (`hash.d:30`): `data.length >>> 0`.
 * - The 4-byte body reads LITTLE-ENDIAN (`data[3]<<24 | data[2]<<16 | data[1]<<8 | data[0]`,
 *   `hash.d:34`). `>>> 0` after the OR keeps it an unsigned 32-bit word (JS `|` yields signed).
 * - Every D `uint *` multiply is `Math.imul(_, m) >>> 0` — `Math.imul` is the ONLY correct
 *   32-bit multiply (`(a*b)|0` loses precision above 2^53; 09-numerics.md §2.1).
 * - `k >> r` is a LOGICAL shift (`k` is `uint` in D): JS `>>> r`.
 * - The tail `switch` uses D `goto case`/`goto default` FALL-THROUGH (`hash.d:43-54`): the omitted
 *   `break` in cases 3/2/1 is the literal translation, NOT a bug. Do not "fix" it by adding breaks.
 *
 * Cost: O(length), single pass, no allocation. Safe in hot hashing paths.
 *
 * VERIFIED (ldc2-1.42.0): calcHash("0123456789")=439272720 (matches the hash.d:67 unittest),
 * calcHash("foo")=2414502773, calcHash("")=0. Full pinned set in the co-located test.
 */
export function calcHash(data: DString): number {
    // 'm' and 'r' are MurmurHash2's mixing constants (hash.d:27-28) — not magic, just chosen to mix well.
    const m = 0x5bd1e995;
    const r = 24;
    let h = data.length >>> 0; // initialize to the length, read as uint (hash.d:30)
    let i = 0;
    const n = data.length;
    // Mix 4 bytes at a time. D slices `data = data[4..$]`; we advance an index instead (no alloc).
    while (n - i >= 4) {
        let k = ((data[i + 3] << 24) | (data[i + 2] << 16) | (data[i + 1] << 8) | data[i]) >>> 0;
        k = Math.imul(k, m) >>> 0;
        k = (k ^ (k >>> r)) >>> 0; // k ^= k >> r — logical shift (k is uint)
        h = (Math.imul(h, m) ^ Math.imul(k, m)) >>> 0;
        i += 4;
    }
    // Tail bytes — D `goto case`/`goto default` fall-through (hash.d:43-54). Missing `break`s are
    // intentional (the literal translation); each case folds in one more tail byte.
    switch ((n - i) & 3) {
        case 3:
            h = (h ^ (data[i + 2] << 16)) >>> 0;
        // fall through
        case 2:
            h = (h ^ (data[i + 1] << 8)) >>> 0;
        // fall through
        case 1:
            h = (h ^ data[i]) >>> 0;
            h = Math.imul(h, m) >>> 0;
        // fall through
        default:
            break;
    }
    // Final avalanche mixes (hash.d:58-60) so the last bytes are well-incorporated.
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, m) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0;
    return h >>> 0;
}

/**
 * `mixHash` — combine two hashes. OVERLOADED across two numeric domains (resolution #1):
 *   - `mixHash(a: number, b: number): number` — 32-bit `number` combine (delegates to `mixHash32`),
 *     the djs runtime helper used by emitted `toHash` methods to fold sub-hashes. See `mixHash32`.
 *   - `mixHash(h: bigint, k: bigint): bigint` — the 64-bit `boost::hash_combine` (`hash.d:74`) port,
 *     documented below. Mixed-type calls are forbidden by the overload signatures.
 *
 * --- the 64-bit `bigint` overload (`boost::hash_combine`, `hash.d:74`) ---
 *
 * Domain: the **64-bit `bigint`** form (09-numerics.md §8). On this target `size_t` is 64-bit
 * (`size_t.sizeof == 8`, probed; _ground-truth.md §6), so both operands and the result are
 * `bigint` masked to 64 bits. Distinct from `calcHash` (32-bit `number`) — do NOT unify.
 *
 * Fidelity: D computes `h ^ (k + 0x9e3779b9 + (h << 6) + (h >> 2))` in WRAPPING unsigned
 * `size_t`. Reproduce the wrap by masking to 64 bits. The `& M` on `(h << 6)` is load-bearing:
 * BigInt `<<` is unbounded, so the bits that shift past bit 63 must be dropped (e.g. with bit 63
 * set, `h << 6` overflows out of 64 bits — verified). `h >> 2` needs no special handling: `h` is
 * a non-negative `bigint`, so BigInt arithmetic `>>` coincides with D's logical `>>` on `size_t`.
 *
 * Precondition (NOT enforced — caller's contract, mirrors `hash.d`): `h`, `k` are unsigned
 * 64-bit values (`0 … 2^64−1`). The result is masked to that range regardless. `hash.d` adds no
 * guard; neither do we (boundary-validation.md: no silent downstream guards — the values come
 * from the carrier, already 64-bit, 09-numerics.md §0).
 *
 * NOTE on the hash.d:82 unittest: it checks `mixHash(...) & uint.max == 0x952DFC10` because on a
 * 32-bit target `size_t` is 32-bit and the output is truncated. OUR target is 64-bit, so the full
 * value is `247315954704` (its low 32 bits ARE 0x952DFC10 — consistent). VERIFIED against ldc2.
 *
 * Consumers: e.g. templatesem combining the re/im sub-hashes of a ComplexExp.
 */
export function mixHash(a: number, b: number): number;
export function mixHash(h: bigint, k: bigint): bigint;
export function mixHash(a: number | bigint, b: number | bigint): number | bigint {
    if (typeof a === "bigint") {
        // 64-bit boost::hash_combine — the literal `hash.d:74` port (see the JSDoc above this
        // overload set). `b` is `bigint` too: the overload signatures forbid a mixed call, and the
        // public signatures (not this impl) are what callers see (boundary-validation.md).
        const k = b as bigint;
        const M = (1n << 64n) - 1n; // 64-bit mask — wraps each subexpression to size_t width
        return (a ^ ((k + 0x9e3779b9n + ((a << 6n) & M) + (a >> 2n)) & M)) & M;
    }
    return mixHash32(a >>> 0, (b as number) >>> 0);
}

/**
 * `mixHash32(a, b)` — combine two 32-bit hashes into one, in the **32-bit `number`** domain
 * (resolution #1; doc home 08 §9). This is the combiner `toHash`/`hashOf` use to fold sub-hashes
 * together (e.g. mixing a seed into a base hash, or two member hashes of a value struct).
 *
 * Distinct from the 64-bit `mixHash(bigint,bigint)` boost combine above: that one is the literal
 * `hash.d:74` port for the frontend sites that call `mixHash` directly; THIS one is the djs runtime
 * helper for the port's emitted `toHash` methods. They share the public `mixHash` name (TS overload)
 * but are different algorithms in different numeric domains — do NOT unify.
 *
 * Construction: one MurmurHash2 word-mix of `b` into `a` (the same `m`/`r` constants and the same
 * `k*m; k^=k>>r; k*=m; h = h*m ^ k` step `calcHash` uses per 4-byte word), followed by MurmurHash2's
 * final avalanche so the result is well-distributed even for tiny inputs. Built on the verified
 * `calcHash` constants — not a clone of druntime `hashOf` (which uses a different SMHasher path).
 *
 * Preconditions (NOT enforced — caller contract): `a`, `b` are unsigned 32-bit (`0 … 2^32−1`).
 * The `>>> 0` in the public `mixHash` overload coerces them defensively at that single boundary;
 * here we assume the contract holds. Returns an unsigned 32-bit integer.
 *
 * Cost: O(1), no allocation. Deterministic and stable (pinned in the co-located test).
 */
function mixHash32(a: number, b: number): number {
    const m = 0x5bd1e995;
    const r = 24;
    let k = Math.imul(b, m) >>> 0;
    k = (k ^ (k >>> r)) >>> 0; // k ^= k >> r — logical shift (k is uint)
    k = Math.imul(k, m) >>> 0;
    let h = (Math.imul(a, m) ^ k) >>> 0; // fold the mixed word into the accumulator (calcHash's step)
    // Final avalanche (hash.d:58-60) so even a one-word combine is well-mixed.
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, m) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0;
    return h >>> 0;
}

/**
 * `hashOf(x, seed=0)` — the djs runtime hash used by emitted `toHash` methods (resolution #1;
 * doc home 08 §9). Hashes a number, a 64-bit `bigint`, or a byte slice (`DString`) to an unsigned
 * 32-bit `number`, optionally folding in a `seed` (to chain sub-hashes of a composite key).
 *
 * Domain & purpose: this is the **port's own** hash helper, NOT a faithful clone of druntime's
 * `hashOf` (verified: druntime `hashOf("0123456789") == 1891213601`, a different SMHasher path;
 * druntime `hashOf(uint)` is the IDENTITY). `Loc.toHash` and friends in the original D call
 * druntime `hashOf`; where the port already pins a site to the identity (e.g. `Loc.toHash` returns
 * `index` directly, location.ts:204) it does NOT route through here. This helper exists for the
 * sites that need a real content hash of a key, built on the verified `calcHash` (MurmurHash2).
 *
 * Operand model:
 * - `number`: a `uint`/`int`-domain value (09-numerics.md §1). Hashed as its 4 LITTLE-ENDIAN bytes
 *   (matching how `calcHash` reads a 4-byte word) via `calcHash`. Coerced with `>>> 0` first.
 * - `bigint`: a 64-bit `size_t`/`ulong`-domain value (09-numerics.md §8; target `size_t` is 8 bytes).
 *   Hashed as its 8 LITTLE-ENDIAN bytes (`BigInt.asUintN(64)` masks to range) via `calcHash`.
 * - `Uint8Array` (`DString`): hashed directly by `calcHash` — D `const(char)[]`/`const(ubyte)[]`
 *   is a byte array (08 §0); nothing decodes UTF-8. With `seed == 0` this equals `calcHash(x)`.
 *
 * Seeding: `seed == 0` returns the bare `calcHash` of the content (the common case, so a bare
 * `hashOf(key)` is just `calcHash(bytes-of-key)`). A non-zero `seed` is combined via `mixHash32`
 * (`mixHash(seed, base)`), letting a composite `toHash` chain `h = hashOf(field2, hashOf(field1))`.
 *
 * Preconditions (NOT enforced — caller contract): a `number` argument is an integer in the unsigned
 * 32-bit range (it is coerced with `>>> 0`); a `bigint` is an unsigned 64-bit value (masked). Returns
 * an unsigned 32-bit integer. Cost: O(1) for number/bigint, O(length) for a byte slice; the
 * number/bigint paths allocate one small fixed-size buffer.
 *
 * VERIFIED deterministic (pinned in the co-located test): `hashOf("0123456789") == 439272720`
 * (== `calcHash`), `hashOf(42) == 1483788722`, `hashOf(42n) == 3219936211`.
 */
export function hashOf(x: number | bigint | DString, seed = 0): number {
    let base: number;
    if (typeof x === "number") {
        base = calcHash(u32le(x >>> 0));
    } else if (typeof x === "bigint") {
        base = calcHash(u64le(x));
    } else {
        base = calcHash(x);
    }
    return seed === 0 ? base : mixHash32(seed >>> 0, base);
}

/** 4 little-endian bytes of a 32-bit value — `hashOf(number)` hashes a `uint` as a 4-byte word. */
function u32le(x: number): Uint8Array {
    const v = x >>> 0;
    return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
}

/** 8 little-endian bytes of a 64-bit value — `hashOf(bigint)` hashes a `size_t` as an 8-byte word. */
function u64le(x: bigint): Uint8Array {
    const out = new Uint8Array(8);
    let v = BigInt.asUintN(64, x); // mask to the unsigned 64-bit range (target size_t width)
    for (let i = 0; i < 8; i++) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    return out;
}
