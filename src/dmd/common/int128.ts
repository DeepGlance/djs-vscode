// Port of dmd/common/int128.d — 128-bit integer arithmetic. Not optimized for speed.
//
// FAITHFUL 1:1 frontend module (NOT a root-runtime container — 00 §0.1 exemption does not apply):
// the algorithms (`mul` partial-product, `udivmod` Hacker's-Delight long division, the shifts and
// rotates) are mirrored line-for-line so the port stays diff-able against upstream.
//
// NUMERIC DOMAIN (09 §1, §8): `Cent` is two 64-bit `ulong` limbs (`lo`, `hi`). Each limb is the
// §0 carrier and decides a compile outcome (128-bit constant folding), so each limb is `bigint`,
// never `number` (09 §8 "128-bit folding"). All `U`-domain (`ulong`) arithmetic wraps mod 2^64;
// JS `bigint` is unbounded, so every `U` op re-truncates with `toUint64` (09 §3, §4.2). A `cast(I)`
// reads the same bits as signed `long` (`toInt64`); a signed `>>` on a `cast(I)` value is an
// ARITHMETIC shift (BigInt `>>` is arithmetic — 09 §4.2), an unsigned `U` `>>` is LOGICAL (the value
// is already masked non-negative by `toUint64`, so BigInt `>>` reproduces zero-fill — 09 §4.2).
//
// VALUE SEMANTICS (03 §2): `Cent` is a D `struct` -> `class Cent` with `.copy()`. Every D free
// function takes `Cent` BY VALUE (03 §1 #2). Functions that MUTATE their parameter (`com`, `neg`,
// the shifts/rotates, `udivmod`, `divmod`) take the by-value copy AT THE TOP OF THE BODY
// (`c = c.copy()`) — semantically identical to a call-site copy for a by-value param (03 §3.1),
// and it keeps internal call sites clean and the module constants `One`/`Zero`/`MinusOne` safe from
// mutation. Functions that only READ their params (`tst`, `add`, `mul`, the comparisons, …)
// construct fresh `Cent`s and never mutate the inputs, so no copy is needed.
//
// GOVERNING TRANSLATIONS / RESOLUTIONS:
//   - `nothrow @safe @nogc pure` (module-level + per-function) -> ERASE (04 §8).
//   - `alias I = long; alias U = ulong;` -> the `bigint` carrier; `enum Ubits = uint(U.sizeof*8)`
//     folds to the fixed target width literal `64` (a `number`, used only as a shift/compare
//     count) (09 §1.4).
//   - `align(16)` on the struct -> dropped (layout/alignment is meaningless in JS, 02/cheatsheet).
//   - `import core.bitop;` (for `bsr`) -> a local `bsr64` helper (core.* is a runtime shim, 01 §3.7).
//   - `out Cent modulus` -> a `Ref<Cent>` box, reset-on-entry then filled (03 §3.3).
//   - `version(unittest){ version(none){ print } }` -> dropped (the `version(none)` debug printer is
//     dead code; the live `unittest{}` block ports to int128.test.ts, 10 §1).

import { toInt64, toUint64 } from "../../numeric.js";

// D `alias I = long;` (the signed read of the 64-bit carrier) has no TS TYPE form — every
// `cast(I)` site reads the carrier via `toInt64(...)` inline (09 §3.1), so no `type I` is emitted.
/// 64-bit unsigned read of the carrier — D `alias U = ulong`. The limb storage domain.
type U = bigint;

/// `enum Ubits = uint(U.sizeof * 8)` (int128.d:21). Folds to the fixed 64-bit target width
/// (09 §1.4: `ulong.sizeof == 8`). A `number`: it is only ever a shift / comparison COUNT, never a
/// limb value, so it stays in the `number` domain (the BigInt shift `<<`/`>>` count is a `bigint`,
/// so a per-use `BigInt(...)` widen is applied where Ubits drives a shift).
export const Ubits = 64;

/// `align(16) struct Cent { U lo; U hi; }` (int128.d:23-27). A 128-bit value as two 64-bit `ulong`
/// limbs. VALUE TYPE: `.copy()` at every D copy point (03 §1). `align(16)` dropped (no JS analogue).
///
/// Both fields are normalized to the 64-bit unsigned carrier (`toUint64`) on construction, exactly
/// as a D `ulong` field holds a wrapped-mod-2^64 bit pattern; downstream code therefore never sees
/// an out-of-range limb. Default-init `Cent()` yields `lo == 0n, hi == 0n` (D `U.init == 0`).
export class Cent {
    lo: U; // low 64 bits (int128.d:25)
    hi: U; // high 64 bits (int128.d:26)

    /// `Cent(lo, hi)` with both limbs defaulting to `0` (D field `.init` for `ulong`). `Cent(2)`
    /// is `Cent(2, 0)`; `Cent(1, 3)` is `lo=1, hi=3` (verified with ldc2: argument order is
    /// `lo` then `hi`). Each limb is truncated to 64-bit unsigned on store (the `ulong` carrier).
    constructor(lo: U = 0n, hi: U = 0n) {
        this.lo = toUint64(lo);
        this.hi = toUint64(hi);
    }

    /// `.copy()` (03 §2): two-field clone of the value struct. Both limbs are `bigint` primitives.
    copy(): Cent {
        return new Cent(this.lo, this.hi);
    }

    /// `Cent` declares no `opEquals` in D, so `==` is the DEFAULT struct comparison: field-by-field
    /// (`lo` and `hi`). Modeled as `opEquals` per the struct-`==` rule (05 §2): two distinct `Cent`
    /// objects are equal iff both limbs match. Used at every `==`/`!=` call site (the unittest).
    opEquals(o: Cent): boolean {
        return this.lo === o.lo && this.hi === o.hi;
    }
}

/// `enum One = Cent(1);` (int128.d:29). A module constant — NEVER mutate it (mutating functions
/// copy their by-value param, so `One` is safe to pass directly).
export const One: Cent = new Cent(1n);
/// `enum Zero = Cent();` (int128.d:30) — the all-zero 128-bit value.
export const Zero: Cent = new Cent();
/// `enum MinusOne = neg(One);` (int128.d:31) — `neg(One)` folded at module load (all 1 bits).
export const MinusOne: Cent = neg(One);

/// The single-slot box for a D `out`/`ref` parameter (03 §3.3). `udivmod`/`divmod` take an
/// `out Cent modulus`; the call site passes `{ value: <fresh Cent> }`, the callee resets it on
/// entry and writes the remainder.
export interface Ref<T> {
    value: T;
}

/*****************************
 * Test against 0
 * Params:
 *      c = Cent to test
 * Returns:
 *      true if != 0
 */
export function tst(c: Cent): boolean {
    // `c.hi || c.lo` is numeric truthiness on two `ulong` limbs (09 §9): expand to `!= 0n`.
    return c.hi !== 0n || c.lo !== 0n;
}

/*****************************
 * Complement
 * Params:
 *      c = Cent to complement
 * Returns:
 *      complemented value
 */
export function com(c: Cent): Cent {
    c = c.copy(); // by-value param (03 §3.1) — mutate a private copy, leave the caller's untouched
    c.lo = toUint64(~c.lo); // `~` on a `ulong` -> re-truncate to 64-bit unsigned (09 §4.2)
    c.hi = toUint64(~c.hi);
    return c;
}

/*****************************
 * Negate
 * Params:
 *      c = Cent to negate
 * Returns:
 *      negated value
 */
export function neg(c: Cent): Cent {
    c = c.copy(); // by-value param (03 §3.1)
    if (c.lo === 0n) {
        c.hi = toUint64(-c.hi); // unary `-` on `ulong` wraps mod 2^64 (verified: -10UL == 0xff..f6)
    } else {
        c.lo = toUint64(-c.lo);
        c.hi = toUint64(~c.hi);
    }
    return c;
}

/*****************************
 * Increment
 * Params:
 *      c = Cent to increment
 * Returns:
 *      incremented value
 */
export function inc(c: Cent): Cent {
    return add(c, One);
}

/*****************************
 * Decrement
 * Params:
 *      c = Cent to decrement
 * Returns:
 *      incremented value
 */
export function dec(c: Cent): Cent {
    return sub(c, One);
}

/*****************************
 * Shift left one bit
 * Params:
 *      c = Cent to shift
 * Returns:
 *      shifted value
 */
export function shl1(c: Cent): Cent {
    c = c.copy(); // by-value param (03 §3.1)
    // `(c.hi << 1) | (cast(I)c.lo < 0)`: the bool `(cast(I)c.lo < 0)` promotes to int 1/0 when
    // OR'd (verified with ldc2), here it is the carry bit out of the low limb's MSB.
    c.hi = toUint64((c.hi << 1n) | (toInt64(c.lo) < 0n ? 1n : 0n));
    c.lo = toUint64(c.lo << 1n);
    return c;
}

/*****************************
 * Unsigned shift right one bit
 * Params:
 *      c = Cent to shift
 * Returns:
 *      shifted value
 */
export function shr1(c: Cent): Cent {
    c = c.copy(); // by-value param (03 §3.1)
    // `c.lo = (c.lo >> 1) | ((c.hi & 1) << (Ubits - 1))`: logical right shift of the unsigned low
    // limb, OR'd with the low bit of `hi` shifted into the top — all `U` (unsigned) arithmetic.
    c.lo = toUint64((c.lo >> 1n) | ((c.hi & 1n) << BigInt(Ubits - 1)));
    c.hi = c.hi >> 1n; // `ulong >> 1` is logical; `c.hi` is already non-negative, no re-truncate needed
    return c;
}

/*****************************
 * Arithmetic shift right one bit
 * Params:
 *      c = Cent to shift
 * Returns:
 *      shifted value
 */
export function sar1(c: Cent): Cent {
    c = c.copy(); // by-value param (03 §3.1)
    c.lo = toUint64((c.lo >> 1n) | ((c.hi & 1n) << BigInt(Ubits - 1)));
    // `cast(I)c.hi >> 1`: ARITHMETIC shift of the signed high limb (sign-replicating). Read the
    // carrier as signed (`toInt64`), shift (BigInt `>>` is arithmetic), re-truncate to `U`.
    c.hi = toUint64(toInt64(c.hi) >> 1n);
    return c;
}

/*****************************
 * Shift left n bits
 * Params:
 *      c = Cent to shift
 *      n = number of bits to shift
 * Returns:
 *      shifted value
 */
export function shl(c: Cent, n: number): Cent {
    c = c.copy(); // by-value param (03 §3.1)
    if (n >= Ubits * 2) {
        return Zero.copy(); // return-by-value (03 §1 #3): D copies `Zero` out; the caller may mutate it
    }

    if (n >= Ubits) {
        c.hi = toUint64(c.lo << BigInt(n - Ubits));
        c.lo = 0n;
    } else {
        // `(c.hi << n) | (c.lo >> (Ubits - n - 1) >> 1)`: the double `>> ... >> 1` avoids a
        // shift-by-64 when n==0 (verified: lo>>63>>1 == 0). All `U` (unsigned) shifts.
        c.hi = toUint64((c.hi << BigInt(n)) | (c.lo >> BigInt(Ubits - n - 1) >> 1n));
        c.lo = toUint64(c.lo << BigInt(n));
    }
    return c;
}

/*****************************
 * Unsigned shift right n bits
 * Params:
 *      c = Cent to shift
 *      n = number of bits to shift
 * Returns:
 *      shifted value
 */
export function shr(c: Cent, n: number): Cent {
    c = c.copy(); // by-value param (03 §3.1)
    if (n >= Ubits * 2) {
        return Zero.copy(); // return-by-value (03 §1 #3): D copies `Zero` out; the caller may mutate it
    }

    if (n >= Ubits) {
        c.lo = c.hi >> BigInt(n - Ubits); // logical right shift of unsigned `hi`; stays non-negative
        c.hi = 0n;
    } else {
        // `(c.lo >> n) | (c.hi << (Ubits - n - 1) << 1)`: the double `<< ... << 1` avoids a
        // shift-by-64 when n==0 (verified: hi<<63<<1 == 0). Re-truncate the `<<` to `U`.
        c.lo = toUint64((c.lo >> BigInt(n)) | (c.hi << BigInt(Ubits - n - 1) << 1n));
        c.hi = c.hi >> BigInt(n);
    }
    return c;
}

/*****************************
 * Arithmetic shift right n bits
 * Params:
 *      c = Cent to shift
 *      n = number of bits to shift
 * Returns:
 *      shifted value
 */
export function sar(c: Cent, n: number): Cent {
    c = c.copy(); // by-value param (03 §3.1)
    // `signmask = -(c.hi >> (Ubits - 1))`: 0 if `hi` is non-negative, all-ones if negative (verified).
    const signmask: U = toUint64(-(c.hi >> BigInt(Ubits - 1)));
    const signshift = Ubits * 2 - n; // a `number` count (09 §1.1)
    c = shr(c, n);

    // Sign extend all bits beyond the precision of Cent.
    if (n >= Ubits * 2) {
        c.hi = signmask;
        c.lo = signmask;
    } else if (signshift >= Ubits * 2) {
        // nothing — the shift already cleared everything inside Cent's precision
    } else if (signshift >= Ubits) {
        // `c.hi &= ~(U.max << (signshift - Ubits))` then `|= signmask << (signshift - Ubits)`.
        // `U.max` is `0xFFFF_FFFF_FFFF_FFFFn`; all `U` ops re-truncate to 64-bit.
        c.hi = toUint64(c.hi & toUint64(~(0xffffffffffffffffn << BigInt(signshift - Ubits))));
        c.hi = toUint64(c.hi | (signmask << BigInt(signshift - Ubits)));
    } else {
        c.hi = signmask;
        c.lo = toUint64(c.lo & toUint64(~(0xffffffffffffffffn << BigInt(signshift))));
        c.lo = toUint64(c.lo | (signmask << BigInt(signshift)));
    }
    return c;
}

/*****************************
 * Rotate left one bit
 * Params:
 *      c = Cent to rotate
 * Returns:
 *      rotated value
 */
export function rol1(c: Cent): Cent {
    c = c.copy(); // by-value param (03 §3.1)
    // `int carry = cast(I)c.hi < 0`: the bit rotating out of the high limb's MSB (a 0/1 int).
    const carry = toInt64(c.hi) < 0n ? 1n : 0n;

    c.hi = toUint64((c.hi << 1n) | (toInt64(c.lo) < 0n ? 1n : 0n));
    c.lo = toUint64((c.lo << 1n) | carry);
    return c;
}

/*****************************
 * Rotate right one bit
 * Params:
 *      c = Cent to rotate
 * Returns:
 *      rotated value
 */
export function ror1(c: Cent): Cent {
    c = c.copy(); // by-value param (03 §3.1)
    const carry: U = c.lo & 1n; // `int carry = c.lo & 1` — the bit rotating out of the low limb
    // `cast(U)(c.hi & 1) << (Ubits - 1)`: the explicit `cast(U)` keeps the shift in the unsigned
    // domain (already `bigint` here); the bit of `hi` rotates into the top of `lo`.
    c.lo = toUint64((c.lo >> 1n) | ((c.hi & 1n) << BigInt(Ubits - 1)));
    c.hi = toUint64((c.hi >> 1n) | (carry << BigInt(Ubits - 1)));
    return c;
}

/*****************************
 * Rotate left n bits
 * Params:
 *      c = Cent to rotate
 *      n = number of bits to rotate
 * Returns:
 *      rotated value
 */
export function rol(c: Cent, n: number): Cent {
    n &= Ubits * 2 - 1; // mask the rotate count to 0..127 (a `number` count)
    const l: Cent = shl(c, n);
    const r: Cent = shr(c, Ubits * 2 - n);
    return or(l, r);
}

/*****************************
 * Rotate right n bits
 * Params:
 *      c = Cent to rotate
 *      n = number of bits to rotate
 * Returns:
 *      rotated value
 */
export function ror(c: Cent, n: number): Cent {
    n &= Ubits * 2 - 1;
    const r: Cent = shr(c, n);
    const l: Cent = shl(c, Ubits * 2 - n);
    return or(r, l);
}

/****************************
 * And c1 & c2.
 * Params:
 *      c1 = operand 1
 *      c2 = operand 2
 * Returns:
 *      c1 & c2
 */
export function and(c1: Cent, c2: Cent): Cent {
    return new Cent(c1.lo & c2.lo, c1.hi & c2.hi);
}

/****************************
 * Or c1 | c2.
 * Params:
 *      c1 = operand 1
 *      c2 = operand 2
 * Returns:
 *      c1 | c2
 */
export function or(c1: Cent, c2: Cent): Cent {
    return new Cent(c1.lo | c2.lo, c1.hi | c2.hi);
}

/****************************
 * Xor c1 ^ c2.
 * Params:
 *      c1 = operand 1
 *      c2 = operand 2
 * Returns:
 *      c1 ^ c2
 */
export function xor(c1: Cent, c2: Cent): Cent {
    return new Cent(c1.lo ^ c2.lo, c1.hi ^ c2.hi);
}

/****************************
 * Add c1 to c2.
 * Params:
 *      c1 = operand 1
 *      c2 = operand 2
 * Returns:
 *      c1 + c2
 */
export function add(c1: Cent, c2: Cent): Cent {
    const r: U = toUint64(c1.lo + c2.lo); // low-limb add wraps mod 2^64
    // carry-out of the low limb is `(r < c1.lo)` (a 0/1 bool promoted to int); add it into the high.
    return new Cent(r, toUint64(c1.hi + c2.hi + (r < c1.lo ? 1n : 0n)));
}

/****************************
 * Subtract c2 from c1.
 * Params:
 *      c1 = operand 1
 *      c2 = operand 2
 * Returns:
 *      c1 - c2
 */
export function sub(c1: Cent, c2: Cent): Cent {
    return add(c1, neg(c2));
}

/****************************
 * Multiply c1 * c2.
 * Params:
 *      c1 = operand 1
 *      c2 = operand 2
 * Returns:
 *      c1 * c2
 */
export function mul(c1: Cent, c2: Cent): Cent {
    const mulmask: U = (1n << BigInt(Ubits / 2)) - 1n; // 0xFFFF_FFFF — low half mask
    const mulshift = Ubits / 2; // 32 — half-limb shift (a `number` count)

    // This algorithm splits the operands into 4 words, then computes and sums
    // the partial products of each part. Each `U` accumulation wraps mod 2^64 (`toUint64`).
    const c2l0: U = c2.lo & mulmask;
    const c2l1: U = c2.lo >> BigInt(mulshift);
    const c2h0: U = c2.hi & mulmask;
    const c2h1: U = c2.hi >> BigInt(mulshift);

    const c1l0: U = c1.lo & mulmask;
    const r0: U = toUint64(c1l0 * c2l0);
    let r1: U = toUint64(c1l0 * c2l1 + (r0 >> BigInt(mulshift)));
    let r2: U = toUint64(c1l0 * c2h0 + (r1 >> BigInt(mulshift)));
    let r3: U = toUint64(c1l0 * c2h1 + (r2 >> BigInt(mulshift)));

    const c1l1: U = c1.lo >> BigInt(mulshift);
    r1 = toUint64(c1l1 * c2l0 + (r1 & mulmask));
    r2 = toUint64(c1l1 * c2l1 + (r2 & mulmask) + (r1 >> BigInt(mulshift)));
    r3 = toUint64(c1l1 * c2h0 + (r3 & mulmask) + (r2 >> BigInt(mulshift)));

    const c1h0: U = c1.hi & mulmask;
    r2 = toUint64(c1h0 * c2l0 + (r2 & mulmask));
    r3 = toUint64(c1h0 * c2l1 + (r3 & mulmask) + (r2 >> BigInt(mulshift)));

    const c1h1: U = c1.hi >> BigInt(mulshift);
    r3 = toUint64(c1h1 * c2l0 + (r3 & mulmask));

    return new Cent(
        toUint64((r0 & mulmask) + (r1 & mulmask) * (mulmask + 1n)),
        toUint64((r2 & mulmask) + (r3 & mulmask) * (mulmask + 1n)),
    );
}

/// `core.bitop.bsr` (int128.d:459) — Bit Scan Reverse: the 0-based index of the highest set bit.
/// Precondition: `v != 0` (the frontend guarantees it at every call site — boundary-validation).
/// `core.*` is a runtime shim, not a translated module (01 §3.7); ported as a local helper.
function bsr64(v: U): number {
    let n = 0;
    let x = toUint64(v);
    while (x > 1n) {
        x >>= 1n;
        n++;
    }
    return n;
}

/****************************
 * Unsigned divide c1 / c2.
 * Params:
 *      c1 = dividend
 *      c2 = divisor
 * Returns:
 *      quotient c1 / c2
 */
export function udiv(c1: Cent, c2: Cent): Cent {
    const modulus: Ref<Cent> = { value: new Cent() };
    return udivmod(c1, c2, modulus);
}

/****************************
 * Unsigned divide c1 / c2. The remainder after division is stored to modulus.
 * Params:
 *      c1 = dividend
 *      c2 = divisor
 *      modulus = set to c1 % c2
 * Returns:
 *      quotient c1 / c2
 */
export function udivmod(c1: Cent, c2: Cent, modulus: Ref<Cent>): Cent {
    // Based on "Unsigned Doubleword Division" in Hacker's Delight

    // Divides a 128-bit dividend by a 64-bit divisor. The result must fit in 64 bits.
    // `out U modulus` -> a `Ref<U>` box (03 §3.3). `c1` is by-value (03 §3.1).
    function udivmod128_64(c1: Cent, c2: U, modulusBox: Ref<U>): U {
        c1 = c1.copy(); // by-value param (03 §3.1) — mutated below (c2 <<= shift; c1.lo <<= shift)
        // We work in base 2^^32
        const base: U = 1n << 32n;
        const divmask: U = (1n << BigInt(Ubits / 2)) - 1n;
        const divshift = Ubits / 2; // 32 — a `number` count

        // Check for overflow and divide by 0
        if (c1.hi >= c2) {
            modulusBox.value = 0n;
            return toUint64(~0n); // ~0UL — all-ones 64-bit
        }

        // Computes [num1 num0] / den
        function udiv96_64(num1: U, num0: U, den: U): U {
            // Extract both digits of the denominator. `cast(uint)` keeps the 32-bit half (mask).
            const den1: U = (den >> BigInt(divshift)) & divmask;
            const den0: U = den & divmask;
            // Estimate ret as num1 / den1, and then correct it. BigInt `/` truncates toward zero.
            let ret: U = num1 / den1;
            const t2: U = (num1 % den1) * base + num0;
            const t1: U = ret * den0;
            if (t1 > t2) {
                ret -= t1 - t2 > den ? 2n : 1n;
            }
            return ret & divmask; // cast(uint)ret
        }

        // Determine the normalization factor (shift the divisor so its MSB is set), and shift the
        // numerator by the same amount. `c1.hi < c2` guarantees no overflow.
        const shift = Ubits - 1 - bsr64(c2); // a `number` in 0..63
        c2 <<= BigInt(shift);
        c2 = toUint64(c2);
        let num2: U = c1.hi;
        num2 <<= BigInt(shift);
        num2 = toUint64(num2);
        // `(c1.lo >> (-shift & 63)) & (-cast(I)shift >> 63)`: when shift==0 the right mask is 0
        // (no contribution); when shift>0 it is all-ones (verified with ldc2). `-shift & 63` and
        // `-cast(I)shift >> 63` are computed in the 64-bit signed/unsigned carrier.
        const negShiftLo: U = c1.lo >> (toUint64(BigInt(-shift)) & 63n);
        const allOnesMask: U = toUint64(toInt64(BigInt(-shift)) >> 63n);
        num2 = toUint64(num2 | (negShiftLo & allOnesMask));
        c1.lo = toUint64(c1.lo << BigInt(shift));

        // Extract the low digits of the numerator (after normalizing)
        const num1: U = (c1.lo >> BigInt(divshift)) & divmask; // cast(uint)
        const num0: U = c1.lo & divmask; // cast(uint)

        // Compute q1 = [num2 num1] / c2
        const q1: U = udiv96_64(num2, num1, c2);
        // Compute the true (partial) remainder
        const rem: U = toUint64(num2 * base + num1 - q1 * c2);
        // Compute q0 = [rem num0] / c2
        const q0: U = udiv96_64(rem, num0, c2);

        modulusBox.value = toUint64(rem * base + num0 - q0 * c2) >> BigInt(shift);
        return toUint64((q1 << BigInt(divshift)) | q0);
    }

    // Special cases
    if (!tst(c2)) {
        // Divide by zero
        modulus.value = Zero.copy(); // store-into the out box (03 §1 #5): D copies `Zero` in
        return com(modulus.value);
    }
    if (c1.hi === 0n && c2.hi === 0n) {
        // Single precision divide. Both limbs are unsigned -> BigInt `/` and `%` over `toUint64`.
        modulus.value = new Cent(c1.lo % c2.lo);
        return new Cent(c1.lo / c2.lo);
    }
    if (c1.hi === 0n) {
        // Numerator is smaller than the divisor
        modulus.value = c1.copy(); // store-into the out box: copy the value struct (03 §1 #5)
        return Zero.copy(); // return-by-value (03 §1 #3): D copies `Zero` out; the caller may mutate it
    }
    if (c2.hi === 0n) {
        // Divisor is a 64-bit value, so we just need one 128/64 division.
        // If c1 / c2 would overflow, break c1 up into two halves.
        const q1: U = c1.hi < c2.lo ? 0n : c1.hi / c2.lo;
        if (q1 !== 0n) {
            // `c1.hi = c1.hi % c2.lo` mutates a private copy — take it before udivmod128_64 reads c1.
            c1 = c1.copy();
            c1.hi = c1.hi % c2.lo;
        }
        const remBox: Ref<U> = { value: 0n };
        const q0: U = udivmod128_64(c1, c2.lo, remBox);
        modulus.value = new Cent(remBox.value);
        return new Cent(q0, q1);
    }

    // Full cent precision division.
    // Here c2 >= 2^^64. We know that c2.hi != 0, so count leading zeros is OK. 0 <= shift <= 63
    const shift = Ubits - 1 - bsr64(c2.hi);

    // Normalize the divisor so its MSB is 1.  v1 = (c2 << shift) >> 64
    const v1: U = shl(c2, shift).hi;

    // To ensure no overflow.
    const u1: Cent = shr1(c1);

    // Get quotient from divide unsigned operation.
    const remIgnoredBox: Ref<U> = { value: 0n };
    const q1: U = udivmod128_64(u1, v1, remIgnoredBox);

    // Undo normalization and division of c1 by 2.
    let quotient: Cent = shr(shl(new Cent(q1), shift), 63);

    // Make quotient correct or too small by 1
    if (tst(quotient)) {
        quotient = dec(quotient);
    }

    // Now quotient is correct.
    // Compute rem = c1 - (quotient * c2);
    let rem: Cent = sub(c1, mul(quotient, c2));

    // Check if remainder is larger than the divisor
    if (uge(rem, c2)) {
        // Increment quotient
        quotient = inc(quotient);
        // Subtract c2 from remainder
        rem = sub(rem, c2);
    }
    modulus.value = rem;
    return quotient;
}

/****************************
 * Signed divide c1 / c2.
 * Params:
 *      c1 = dividend
 *      c2 = divisor
 * Returns:
 *      quotient c1 / c2
 */
export function div(c1: Cent, c2: Cent): Cent {
    const modulus: Ref<Cent> = { value: new Cent() };
    return divmod(c1, c2, modulus);
}

/****************************
 * Signed divide c1 / c2. The remainder after division is stored to modulus.
 * Params:
 *      c1 = dividend
 *      c2 = divisor
 *      modulus = set to c1 % c2
 * Returns:
 *      quotient c1 / c2
 */
export function divmod(c1: Cent, c2: Cent, modulus: Ref<Cent>): Cent {
    // Muck about with the signs so we can use the unsigned divide. `cast(I)c.hi < 0` reads the
    // high limb as a signed `long` to test the 128-bit sign (09 §3.1).
    if (toInt64(c1.hi) < 0n) {
        if (toInt64(c2.hi) < 0n) {
            const r: Cent = udivmod(neg(c1), neg(c2), modulus);
            modulus.value = neg(modulus.value);
            return r;
        }
        const r: Cent = neg(udivmod(neg(c1), c2, modulus));
        modulus.value = neg(modulus.value);
        return r;
    } else if (toInt64(c2.hi) < 0n) {
        return neg(udivmod(c1, neg(c2), modulus));
    } else {
        return udivmod(c1, c2, modulus);
    }
}

/****************************
 * If c1 > c2 unsigned
 * Params:
 *      c1 = operand 1
 *      c2 = operand 2
 * Returns:
 *      true if c1 > c2
 */
export function ugt(c1: Cent, c2: Cent): boolean {
    // Both limbs read unsigned (the limb carrier is already non-negative `toUint64`).
    return c1.hi === c2.hi ? c1.lo > c2.lo : c1.hi > c2.hi;
}

/****************************
 * If c1 >= c2 unsigned
 * Params:
 *      c1 = operand 1
 *      c2 = operand 2
 * Returns:
 *      true if c1 >= c2
 */
export function uge(c1: Cent, c2: Cent): boolean {
    return !ugt(c2, c1);
}

/****************************
 * If c1 < c2 unsigned
 * Params:
 *      c1 = operand 1
 *      c2 = operand 2
 * Returns:
 *      true if c1 < c2
 */
export function ult(c1: Cent, c2: Cent): boolean {
    return ugt(c2, c1);
}

/****************************
 * If c1 <= c2 unsigned
 * Params:
 *      c1 = operand 1
 *      c2 = operand 2
 * Returns:
 *      true if c1 <= c2
 */
export function ule(c1: Cent, c2: Cent): boolean {
    return !ugt(c1, c2);
}

/****************************
 * If c1 > c2 signed
 * Params:
 *      c1 = operand 1
 *      c2 = operand 2
 * Returns:
 *      true if c1 > c2
 */
export function gt(c1: Cent, c2: Cent): boolean {
    // High-limb comparison reads the carrier as SIGNED (`cast(I)`); low-limb stays unsigned.
    return c1.hi === c2.hi ? c1.lo > c2.lo : toInt64(c1.hi) > toInt64(c2.hi);
}

/****************************
 * If c1 >= c2 signed
 * Params:
 *      c1 = operand 1
 *      c2 = operand 2
 * Returns:
 *      true if c1 >= c2
 */
export function ge(c1: Cent, c2: Cent): boolean {
    return !gt(c2, c1);
}

/****************************
 * If c1 < c2 signed
 * Params:
 *      c1 = operand 1
 *      c2 = operand 2
 * Returns:
 *      true if c1 < c2
 */
export function lt(c1: Cent, c2: Cent): boolean {
    return gt(c2, c1);
}

/****************************
 * If c1 <= c2 signed
 * Params:
 *      c1 = operand 1
 *      c2 = operand 2
 * Returns:
 *      true if c1 <= c2
 */
export function le(c1: Cent, c2: Cent): boolean {
    return !gt(c1, c2);
}
