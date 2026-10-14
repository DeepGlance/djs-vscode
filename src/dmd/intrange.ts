// Ported from dmd/intrange.d (module dmd.intrange) — Value Range Propagation arithmetic.
//
// Two VALUE structs (02 §2 / 03): `SignExtendedNumber` (a 65-bit signed number: a 64-bit
// `uinteger_t` magnitude pattern plus a sign bit) and `IntRange` (a closed interval of two of them).
//
// NUMERIC DOMAIN (09): `SignExtendedNumber.value` is `uinteger_t` (ulong) -> `bigint`. CONTRACT: `value` is always in
// the UNSIGNED carrier [0, 2^64); a caller holding a signed-normalized carrier converts it with `toUint64` before
// constructing (getIntRange's visitInteger does, dcast.d:4408). Every ulong operation that can leave that range (`-`,
// `~`, `+`, `*`, `<<`) is re-truncated with `toUint64`; `&`, `|`, `^`, `>>`, `/` and `%` on two in-range operands stay
// in range. `size_t`/`int` locals that only feed ulong comparisons stay `bigint` (09 §5: no boundary).
//
// OPERATORS (05 §1): every `opBinary!"op"` / `opUnary!"op"` is monomorphized to its canonical
// method (`opAdd` `opSub` `opMul` `opDiv` `opMod` `opShl` `opShr` `opUShr` `opPow` `opAnd` `opOr`
// `opXor`; `opInc` `opCom` `opNeg`), and every operator applied to these structs inside this file is
// rewritten to the method call (`a < b` -> `a.opCmp(b) < 0`, `-x` -> `x.opNeg()`, ...).
//
// COPY DISCIPLINE (03): struct returns by value copy (`return this.copy()`); the `IntRange`
// constructor copies both bounds on field store (03 §1 #5), so a `new IntRange(a, b)` argument needs
// no call-site copy. By-value `rhs` parameters: every method EXCEPT `IntRange.opDiv` neither mutates
// nor returns its `rhs` un-copied, so the call-site copy is unobservable and is elided in this file
// (03 §9: destination never mutated). `IntRange.opDiv` MUTATES `rhs` (intrange.d:624/:628): its
// callers pass `.copy()`.
//
// dropped: `import core.stdc.stdio;` (intrange.d:14) — its one user, `printf` in `dump`, maps to
// `dmdformat` + `process.stdout.write` (10 §3.5 / §4.4).
// dropped: `import dmd.astenums : Tdchar;` and `import dmd.mtype : Type;` (intrange.d:16-17) — neither
// name is referenced anywhere in intrange.d (01 §3 strict-mode imports).

import type { DString } from "../dstring.js";
import { dsToJs } from "../dstring.js";
import { assertUnreachable } from "../assert.js";
import { toUint64 } from "../numeric.js";
import { dmdformat } from "./root/dmdformat.js"; // value: IntRange.dump printf (10 §3.5)
import type { uinteger_t } from "./globals.js";

/// `ulong.max` — the all-ones 64-bit pattern (2^64 - 1) of the unsigned carrier.
const ULONG_MAX = 0xFFFF_FFFF_FFFF_FFFFn;

/// A single mutable cell standing in for a D `ref bool` parameter (03 §7.2 box pattern).
interface Ref<T> {
    value: T;
}

/***********************************************************
 * dmd/intrange.d:20 — `private uinteger_t copySign(uinteger_t x, bool sign)`: `sign ? -x : x` in the
 * 64-bit unsigned carrier. D module-private: not exported (no D unittest reaches it, 10 §1.7).
 */
function copySign(x: uinteger_t, sign: boolean): uinteger_t {
    // return sign ? -x : x;
    const s: uinteger_t = sign ? 1n : 0n; // cast(uinteger_t)sign
    return toUint64(x - s) ^ toUint64(-s);
}

/***********************************************************
 * dmd/intrange.d:26 — `struct SignExtendedNumber` (VALUE type). A 65-bit two's-complement number:
 * `negative` is the sign bit, `value` the low 64 bits. The minimum (INT65_MIN) is `(0, true)`, the
 * maximum `(ulong.max, false)`.
 *
 * D declares no constructor: `SignExtendedNumber()` / `(v)` / `(v, neg)` are struct literals, which
 * this single constructor with D's field defaults reproduces. Callers pass `value` already in the
 * unsigned carrier (a D literal `-1` converted to the ulong field is `ULONG_MAX` here).
 */
export class SignExtendedNumber {
    value: uinteger_t = 0n;   // uinteger_t -> bigint
    negative = false;

    constructor(value: uinteger_t = 0n, negative = false) {
        this.value = value;
        this.negative = negative;
    }

    copy(): SignExtendedNumber {
        return new SignExtendedNumber(this.value, this.negative);
    }

    /// dmd/intrange.d:31 — `static SignExtendedNumber fromInteger(uinteger_t value_)`: sign-extend a
    /// 64-bit pattern (bit 63 becomes the sign).
    static fromInteger(value_: uinteger_t): SignExtendedNumber {
        // `value_ >> 63` is 0 or 1, converted to the bool field.
        return new SignExtendedNumber(value_, (value_ >> 63n) !== 0n);
    }

    /// dmd/intrange.d:36 — `static SignExtendedNumber extreme(bool minimum)`: INT65_MIN when `minimum`,
    /// else INT65_MAX.
    static extreme(minimum: boolean): SignExtendedNumber {
        // `minimum - 1` is an int (0 or -1) converted to the ulong field.
        return new SignExtendedNumber(toUint64((minimum ? 1n : 0n) - 1n), minimum);
    }

    /// dmd/intrange.d:41 — `static SignExtendedNumber max()`.
    static max(): SignExtendedNumber {
        return new SignExtendedNumber(ULONG_MAX, false);
    }

    /// dmd/intrange.d:46 — `static SignExtendedNumber min()`.
    static min(): SignExtendedNumber {
        return new SignExtendedNumber(0n, true);
    }

    /// dmd/intrange.d:51 — `bool isMinimum() const`.
    isMinimum(): boolean {
        return this.negative && this.value === 0n;
    }

    /// dmd/intrange.d:56 — `bool opEquals(const ref SignExtendedNumber a) const`: D `==` / `!=`.
    opEquals(a: SignExtendedNumber): boolean {
        return this.value === a.value && this.negative === a.negative;
    }

    /// dmd/intrange.d:61 — `int opCmp(const ref SignExtendedNumber a) const`: D `<` `<=` `>` `>=`
    /// (`a < b` -> `a.opCmp(b) < 0`, 05 §3). Returns -1, 0 or 1.
    opCmp(a: SignExtendedNumber): number {
        if (this.negative !== a.negative) {
            if (this.negative)
                return -1;
            else
                return 1;
        }
        if (this.value < a.value)
            return -1;
        if (this.value > a.value)
            return 1;
        else
            return 0;
    }

    /// dmd/intrange.d:78 — `opUnary(string op : "++")`: saturating pre-increment. MUTATES `this`, then returns
    /// it BY VALUE (a copy, 03 §1 #3).
    opInc(): SignExtendedNumber {
        if (this.value !== ULONG_MAX)
            ++this.value; // no wrap: value < ulong.max here
        else if (this.negative) {
            this.value = 0n;
            this.negative = false;
        }
        return this.copy();
    }

    /// dmd/intrange.d:90 — `opUnary(string op : "~")` (bitwise complement of the 65-bit number).
    opCom(): SignExtendedNumber {
        if (toUint64(~this.value) === 0n)
            return new SignExtendedNumber(toUint64(~this.value));
        else
            return new SignExtendedNumber(toUint64(~this.value), !this.negative);
    }

    /// dmd/intrange.d:98 — `opUnary(string op : "-")` (negation of the 65-bit number).
    opNeg(): SignExtendedNumber {
        if (this.value === 0n)
            return new SignExtendedNumber(toUint64(-(this.negative ? 1n : 0n))); // -cast(ulong)negative
        else
            return new SignExtendedNumber(toUint64(-this.value), !this.negative);
    }

    /// dmd/intrange.d:106 — `opBinary(string op : "&")`: the low 64 bits only; the result is non-negative.
    opAnd(rhs: SignExtendedNumber): SignExtendedNumber {
        return new SignExtendedNumber(this.value & rhs.value);
    }

    /// dmd/intrange.d:111 — `opBinary(string op : "|")`: the low 64 bits only; the result is non-negative.
    opOr(rhs: SignExtendedNumber): SignExtendedNumber {
        return new SignExtendedNumber(this.value | rhs.value);
    }

    /// dmd/intrange.d:116 — `opBinary(string op : "^")`: the low 64 bits only; the result is non-negative.
    opXor(rhs: SignExtendedNumber): SignExtendedNumber {
        return new SignExtendedNumber(this.value ^ rhs.value);
    }

    /// dmd/intrange.d:121 — `opBinary(string op : "+")`: saturating 65-bit addition.
    opAdd(rhs: SignExtendedNumber): SignExtendedNumber {
        const sum: uinteger_t = toUint64(this.value + rhs.value);
        const carry = sum < this.value && sum < rhs.value;
        if (this.negative !== rhs.negative)
            return new SignExtendedNumber(sum, !carry);
        if (this.negative)
            return new SignExtendedNumber(carry ? sum : 0n, true);
        else
            return new SignExtendedNumber(carry ? ULONG_MAX : sum, false);
    }

    /// dmd/intrange.d:134 — `opBinary(string op : "-")`: saturating 65-bit subtraction (`this + (-rhs)`).
    opSub(rhs: SignExtendedNumber): SignExtendedNumber {
        if (rhs.isMinimum())
            return this.negative ? new SignExtendedNumber(this.value, false) : SignExtendedNumber.max();
        else
            return this.opAdd(rhs.opNeg()); // arg is a fresh rvalue: copy elided (03 §9)
    }

    /// dmd/intrange.d:142 — `opBinary(string op : "*")`: saturating 65-bit multiplication.
    opMul(rhs: SignExtendedNumber): SignExtendedNumber {
        // perform* saturated* multiplication, otherwise we may get bogus ranges
        //  like 0x10 * 0x10 == 0x100 == 0.

        /* Special handling for zeros:
            INT65_MIN * 0 = 0
            INT65_MIN * + = INT65_MIN
            INT65_MIN * - = INT65_MAX
            0 * anything = 0
        */
        if (this.value === 0n) {
            if (!this.negative)
                return this.copy();
            if (rhs.negative)
                return SignExtendedNumber.max();
            else
                return rhs.value === 0n ? rhs.copy() : this.copy();
        } else if (rhs.value === 0n)
            return rhs.opMul(this); // don't duplicate the symmetric case. (`this` by value: opMul never
                                    // mutates its rhs, copy elided — 03 §9)

        const rv = new SignExtendedNumber();
        // these are != 0 now surely.
        const tAbs: uinteger_t = copySign(this.value, this.negative);
        const aAbs: uinteger_t = copySign(rhs.value, rhs.negative);
        rv.negative = this.negative !== rhs.negative;
        if (ULONG_MAX / tAbs < aAbs)
            rv.value = toUint64((rv.negative ? 1n : 0n) - 1n); // rv.negative - 1: int 0 or -1 -> ulong
        else
            rv.value = copySign(toUint64(tAbs * aAbs), rv.negative);
        return rv;
    }

    /// dmd/intrange.d:177 — `opBinary(string op : "/")`: 65-bit division (truncating toward zero), with D's
    /// special cases for a zero divisor and for INT65_MIN.
    opDiv(rhs: SignExtendedNumber): SignExtendedNumber {
        /* special handling for zeros:
            INT65_MIN / INT65_MIN = 1
            anything / INT65_MIN = 0
            + / 0 = INT65_MAX  (eh?)
            - / 0 = INT65_MIN  (eh?)
        */
        if (rhs.value === 0n) {
            if (rhs.negative)
                return new SignExtendedNumber(this.value === 0n && this.negative ? 1n : 0n); // bool -> ulong
            else
                return SignExtendedNumber.extreme(this.negative);
        }

        let aAbs: uinteger_t = copySign(rhs.value, rhs.negative);
        let rvVal: uinteger_t;

        if (!this.isMinimum())
            rvVal = copySign(this.value, this.negative) / aAbs;
        // Special handling for INT65_MIN
        //  if the denominator is not a power of 2, it is same as ulong.max / x.
        else if ((aAbs & toUint64(aAbs - 1n)) !== 0n)
            rvVal = ULONG_MAX / aAbs;
        // otherwise, it's the same as reversing the bits of x.
        else {
            if (aAbs === 1n)
                return SignExtendedNumber.extreme(!rhs.negative);
            rvVal = 1n << 63n;
            aAbs >>= 1n;
            if ((aAbs & 0xAAAAAAAAAAAAAAAAn) !== 0n) rvVal >>= 1n;
            if ((aAbs & 0xCCCCCCCCCCCCCCCCn) !== 0n) rvVal >>= 2n;
            if ((aAbs & 0xF0F0F0F0F0F0F0F0n) !== 0n) rvVal >>= 4n;
            if ((aAbs & 0xFF00FF00FF00FF00n) !== 0n) rvVal >>= 8n;
            if ((aAbs & 0xFFFF0000FFFF0000n) !== 0n) rvVal >>= 16n;
            if ((aAbs & 0xFFFFFFFF00000000n) !== 0n) rvVal >>= 32n;
        }
        const rvNeg = this.negative !== rhs.negative;
        rvVal = copySign(rvVal, rvNeg);

        return new SignExtendedNumber(rvVal, rvVal !== 0n && rvNeg);
    }

    /// dmd/intrange.d:222 — `opBinary(string op : "%")`: 65-bit remainder (sign follows the dividend).
    opMod(rhs: SignExtendedNumber): SignExtendedNumber {
        if (rhs.value === 0n)
            return !rhs.negative ? rhs.copy() : this.isMinimum() ? new SignExtendedNumber(0n) : this.copy();

        const aAbs: uinteger_t = copySign(rhs.value, rhs.negative);
        let rvVal: uinteger_t;

        // a % b == sgn(a) * abs(a) % abs(b).
        if (!this.isMinimum())
            rvVal = copySign(this.value, this.negative) % aAbs;
        // Special handling for INT65_MIN
        //  if the denominator is not a power of 2, it is same as ulong.max % x + 1.
        else if ((aAbs & toUint64(aAbs - 1n)) !== 0n)
            rvVal = ULONG_MAX % aAbs + 1n; // no wrap: ulong.max % aAbs < aAbs
        //  otherwise, the modulus is trivially zero.
        else
            rvVal = 0n;

        rvVal = copySign(rvVal, this.negative);
        return new SignExtendedNumber(rvVal, rvVal !== 0n && this.negative);
    }

    /// dmd/intrange.d:245 — `opBinary(string op : "<<")`: left shift, saturating to INT65_MIN/MAX on overflow.
    opShl(rhs: SignExtendedNumber): SignExtendedNumber {
        // assume left-shift the shift-amount is always unsigned. Thus negative
        //  shifts will give huge result.
        if (this.value === 0n)
            return this.copy();
        if (rhs.negative)
            return SignExtendedNumber.extreme(this.negative);

        let v: uinteger_t = copySign(this.value, this.negative);

        // compute base-2 log of 'v' to determine the maximum allowed bits to shift.
        // Ref: https://graphics.stanford.edu/~seander/bithacks.html#IntegerLog

        // Why is this a size_t? Looks like a bug.
        // `size_t r, s` stay in the bigint carrier: they only feed `63 - r`, compared with the ulong
        // `rhs.value` (09 §5 — no number/bigint boundary; values are 0 .. 63).
        let r: bigint, s: bigint;

        r = (v > 0xFFFFFFFFn ? 1n : 0n) << 5n; v >>= r;
        s = (v > 0xFFFFn     ? 1n : 0n) << 4n; v >>= s; r |= s;
        s = (v > 0xFFn       ? 1n : 0n) << 3n; v >>= s; r |= s;
        s = (v > 0xFn        ? 1n : 0n) << 2n; v >>= s; r |= s;
        s = (v > 0x3n        ? 1n : 0n) << 1n; v >>= s; r |= s;
                                                        r |= (v >> 1n);

        const allowableShift: uinteger_t = 63n - r; // r <= 63: no wrap
        if (rhs.value > allowableShift)
            return SignExtendedNumber.extreme(this.negative);
        else
            return new SignExtendedNumber(toUint64(this.value << rhs.value), this.negative);
    }

    /// dmd/intrange.d:276 — `opBinary(string op : ">>")`: arithmetic right shift of the 65-bit number.
    opShr(rhs: SignExtendedNumber): SignExtendedNumber {
        if (rhs.negative || rhs.value > 63n)
            return this.negative ? new SignExtendedNumber(ULONG_MAX, true) : new SignExtendedNumber(0n);
        if (this.isMinimum())
            return rhs.value === 0n
                ? this.copy()
                : new SignExtendedNumber(toUint64(ULONG_MAX << (64n - rhs.value)), true); // -1UL << (64 - rhs.value)

        // `-cast(int)negative` is an int 0 or -1, sign-extended to the ulong operand of `^`.
        let x: uinteger_t = this.value ^ (this.negative ? ULONG_MAX : 0n);
        x >>= rhs.value;
        return new SignExtendedNumber(x ^ (this.negative ? ULONG_MAX : 0n), this.negative);
    }

    /// dmd/intrange.d:288 — `opBinary(string op : "^^")`: not implemented upstream (`assert(0)`).
    opPow(rhs: SignExtendedNumber): SignExtendedNumber {
        void rhs; // D never reads it before the assert(0)
        // Not yet implemented
        return assertUnreachable();
    }
}

/***********************************************************
 * dmd/intrange.d:295 — `struct IntRange` (VALUE type): the closed interval `[imin, imax]`.
 *
 * Constructors (04 §1): D's `this()` (default init), `this(SignExtendedNumber a)` (:305) and
 * `this(SignExtendedNumber lower, SignExtendedNumber upper)` (:311) are one arity-dispatched
 * constructor (03 §6.4: `arguments.length` decides); `this(IntRange another)` (:299) has the same
 * arity as `this(SignExtendedNumber)`, so it is the static factory `IntRange.fromIntRange` (04 §1.1(c)).
 * The constructor copies every bound it stores (03 §1 #5): callers need no call-site copy.
 */
export class IntRange {
    imin: SignExtendedNumber = new SignExtendedNumber();
    imax: SignExtendedNumber = new SignExtendedNumber();

    constructor(lower?: SignExtendedNumber, upper?: SignExtendedNumber) {
        if (arguments.length === 0) {
            // default init (D `IntRange r;`): both bounds are `SignExtendedNumber.init` = (0, false).
        } else if (arguments.length === 1) {
            // dmd/intrange.d:305 — `this(SignExtendedNumber a)`
            this.imin = lower!.copy();
            this.imax = lower!.copy();
        } else {
            // dmd/intrange.d:311 — `this(SignExtendedNumber lower, SignExtendedNumber upper)`
            this.imin = lower!.copy();
            this.imax = upper!.copy();
        }
    }

    copy(): IntRange {
        return new IntRange(this.imin, this.imax);
    }

    /// dmd/intrange.d:299 — `this(IntRange another)`: rewrite D `IntRange(ir)` to
    /// `IntRange.fromIntRange(ir)` (same-arity constructor overload, 04 §1.1(c)).
    static fromIntRange(another: IntRange): IntRange {
        const r = new IntRange();
        r.imin = another.imin.copy();
        r.imax = another.imax.copy();
        return r;
    }

    /// dmd/intrange.d:317 — `static IntRange fromNumbers2(SignExtendedNumber* numbers)`: the interval
    /// spanned by `numbers[0]` and `numbers[1]`.
    /// POINTER MAPPING (integrator ruling on the wave-8 pointer-arithmetic escalation): D's
    /// `SignExtendedNumber*` points into a caller's static array; it is ported as that array plus an
    /// element offset (`numbers + k` -> `(numbers, off + k)`). Faithful because the elements are only
    /// read here, and the IntRange constructor copies what it stores.
    static fromNumbers2(numbers: SignExtendedNumber[], off = 0): IntRange {
        if (numbers[off].opCmp(numbers[off + 1]) < 0)
            return new IntRange(numbers[off], numbers[off + 1]);
        else
            return new IntRange(numbers[off + 1], numbers[off]);
    }

    /// dmd/intrange.d:325 — `static IntRange fromNumbers4(SignExtendedNumber* numbers)`: the interval
    /// spanned by `numbers[0 .. 4]`. Same pointer mapping as `fromNumbers2` (offset 0 here).
    static fromNumbers4(numbers: SignExtendedNumber[]): IntRange {
        const ab = IntRange.fromNumbers2(numbers, 0);
        const cd = IntRange.fromNumbers2(numbers, 2); // D: fromNumbers2(numbers + 2)
        if (cd.imin.opCmp(ab.imin) < 0)
            ab.imin = cd.imin.copy();
        if (cd.imax.opCmp(ab.imax) > 0)
            ab.imax = cd.imax.copy();
        return ab;
    }

    /// dmd/intrange.d:336 — `static IntRange widest()`: [INT65_MIN, INT65_MAX].
    static widest(): IntRange {
        return new IntRange(SignExtendedNumber.min(), SignExtendedNumber.max());
    }

    /// dmd/intrange.d:341 — `IntRange castSigned(uinteger_t mask)`: wrap the range into the signed type
    /// whose value mask is `mask`. MUTATES `this`, then returns it BY VALUE (a copy).
    castSigned(mask: uinteger_t): IntRange {
        // .... 0x1e7f ] [0x1e80 .. 0x1f7f] [0x1f80 .. 0x7f] [0x80 .. 0x17f] [0x180 ....
        //
        // regular signed type. We use a technique similar to the unsigned version,
        //  but the chunk has to be offset by 1/2 of the range.
        let halfChunkMask: uinteger_t = mask >> 1n;
        let minHalfChunk: uinteger_t = this.imin.value & toUint64(~halfChunkMask);
        let maxHalfChunk: uinteger_t = this.imax.value & toUint64(~halfChunkMask);
        // 1 = neg, 0 = nonneg, -1 = chunk containing ::max
        let minHalfChunkNegativity: number = this.imin.negative ? 1 : 0;
        let maxHalfChunkNegativity: number = this.imax.negative ? 1 : 0;
        if ((minHalfChunk & mask) !== 0n) {
            minHalfChunk = toUint64(minHalfChunk + halfChunkMask + 1n);
            if (minHalfChunk === 0n)
                --minHalfChunkNegativity;
        }
        if ((maxHalfChunk & mask) !== 0n) {
            maxHalfChunk = toUint64(maxHalfChunk + halfChunkMask + 1n);
            if (maxHalfChunk === 0n)
                --maxHalfChunkNegativity;
        }
        if (minHalfChunk === maxHalfChunk && minHalfChunkNegativity === maxHalfChunkNegativity) {
            this.imin.value &= mask;
            this.imax.value &= mask;
            // sign extend if necessary.
            this.imin.negative = (this.imin.value & toUint64(~halfChunkMask)) !== 0n;
            this.imax.negative = (this.imax.value & toUint64(~halfChunkMask)) !== 0n;
            halfChunkMask = toUint64(halfChunkMask + 1n);
            this.imin.value = toUint64((this.imin.value ^ halfChunkMask) - halfChunkMask);
            this.imax.value = toUint64((this.imax.value ^ halfChunkMask) - halfChunkMask);
        } else {
            this.imin = new SignExtendedNumber(toUint64(~halfChunkMask), true);
            this.imax = new SignExtendedNumber(halfChunkMask, false);
        }
        return this.copy();
    }

    /// dmd/intrange.d:383 — `IntRange castUnsigned(uinteger_t mask)`: wrap the range into the unsigned
    /// type whose value mask is `mask`. MUTATES `this`, then returns it BY VALUE (a copy).
    castUnsigned(mask: uinteger_t): IntRange {
        // .... 0x1eff ] [0x1f00 .. 0x1fff] [0 .. 0xff] [0x100 .. 0x1ff] [0x200 ....
        //
        // regular unsigned type. We just need to see if ir steps across the
        //  boundary of validRange. If yes, ir will represent the whole validRange,
        //  otherwise, we just take the modulus.
        // e.g. [0x105, 0x107] & 0xff == [5, 7]
        //      [0x105, 0x207] & 0xff == [0, 0xff]
        const minChunk: uinteger_t = this.imin.value & toUint64(~mask);
        const maxChunk: uinteger_t = this.imax.value & toUint64(~mask);
        if (minChunk === maxChunk && this.imin.negative === this.imax.negative) {
            this.imin.value &= mask;
            this.imax.value &= mask;
        } else {
            this.imin.value = 0n;
            this.imax.value = mask;
        }
        this.imin.negative = this.imax.negative = false;
        return this.copy();
    }

    /// dmd/intrange.d:408 — `IntRange castDchar()`: `castUnsigned(uint.max)` clamped to 0x10FFFF.
    /// MUTATES `this`, then returns it BY VALUE (a copy).
    castDchar(): IntRange {
        // special case for dchar. Casting to dchar means "I'll ignore all
        //  invalid characters."
        this.castUnsigned(0xFFFFFFFFn);
        if (this.imin.value > 0x10FFFFn) // ??
            this.imin.value = 0x10FFFFn; // ??
        if (this.imax.value > 0x10FFFFn)
            this.imax.value = 0x10FFFFn;
        return this.copy();
    }

    /// dmd/intrange.d:420 — `bool contains(IntRange a)`: `a` lies inside this range. Does not mutate
    /// `a`, so a caller may elide the by-value copy (03 §9).
    contains(a: IntRange): boolean {
        return this.imin.opCmp(a.imin) <= 0 && this.imax.opCmp(a.imax) >= 0;
    }

    /// dmd/intrange.d:425 — `bool containsZero() const`.
    containsZero(): boolean {
        return (this.imin.negative && !this.imax.negative)
            || (!this.imin.negative && this.imin.value === 0n);
    }

    /// dmd/intrange.d:431 — `IntRange absNeg() const`: the range of `-abs(x)` for x in this range.
    absNeg(): IntRange {
        if (this.imax.negative)
            return this.copy();
        if (!this.imin.negative)
            return new IntRange(this.imax.opNeg(), this.imin.opNeg());
        const imaxAbsNeg = this.imax.opNeg();
        return new IntRange(imaxAbsNeg.opCmp(this.imin) < 0 ? imaxAbsNeg : this.imin,
                            new SignExtendedNumber(0n));
    }

    /// dmd/intrange.d:442 — `IntRange unionWith(const ref IntRange other) const`: the hull of both.
    unionWith(other: IntRange): IntRange {
        return new IntRange(this.imin.opCmp(other.imin) < 0 ? this.imin : other.imin,
                            this.imax.opCmp(other.imax) > 0 ? this.imax : other.imax);
    }

    /// dmd/intrange.d:448 — `void unionOrAssign(IntRange other, ref bool union_)`: widen this range
    /// to cover `other`, or take `other` outright while `union_` is still false; sets `union_`.
    unionOrAssign(other: IntRange, union_: Ref<boolean>): void {
        if (!union_.value || this.imin.opCmp(other.imin) > 0)
            this.imin = other.imin.copy();
        if (!union_.value || this.imax.opCmp(other.imax) < 0)
            this.imax = other.imax.copy();
        union_.value = true;
    }

    /// dmd/intrange.d:457 — `ref const(IntRange) dump(Exp)(const(char)* funcName, Exp e) const return`:
    /// debug print to stdout; returns `this` by reference (no copy). `Exp` is any `toChars()` carrier.
    dump(funcName: DString, e: { toChars(): DString }): IntRange {
        process.stdout.write(dsToJs(dmdformat("[(%c)%#018llx, (%c)%#018llx] @ %s ::: %s\n", [
               this.imin.negative ? 0x2D : 0x2B, this.imin.value,
               this.imax.negative ? 0x2D : 0x2B, this.imax.value,
               funcName, e.toChars()])));
        return this;
    }

    /// dmd/intrange.d:466 — `void splitBySign(ref IntRange negRange, ref bool hasNegRange,
    /// ref IntRange nonNegRange, ref bool hasNonNegRange) const`: the negative and the non-negative
    /// parts of this range. `negRange`/`nonNegRange` are D `ref` structs: written in place.
    splitBySign(negRange: IntRange, hasNegRange: Ref<boolean>, nonNegRange: IntRange,
                hasNonNegRange: Ref<boolean>): void {
        hasNegRange.value = this.imin.negative;
        if (hasNegRange.value) {
            negRange.imin = this.imin.copy();
            negRange.imax = this.imax.negative ? this.imax.copy() : new SignExtendedNumber(ULONG_MAX, true);
        }
        hasNonNegRange.value = !this.imax.negative;
        if (hasNonNegRange.value) {
            nonNegRange.imin = this.imin.negative ? new SignExtendedNumber(0n) : this.imin.copy();
            nonNegRange.imax = this.imax.copy();
        }
    }

    /// dmd/intrange.d:482 — `opUnary(string op:"~")`.
    opCom(): IntRange {
        return new IntRange(this.imax.opCom(), this.imin.opCom());
    }

    /// dmd/intrange.d:487 — `opUnary(string op : "-")`.
    opNeg(): IntRange {
        return new IntRange(this.imax.opNeg(), this.imin.opNeg());
    }

    // D `bool ^ bool` is a bool (the operands differ); in `opAnd`/`opOr` it is compared with the int
    // 1 or 0, so `(a ^ b) == 1` is `a !== b` and `(a ^ b) != 1` / `== 0` is `a === b`.

    /// dmd/intrange.d:494 — `opBinary(string op : "&")`.
    // Credits to Timon Gehr for the algorithms for &, |
    // https://github.com/tgehr/d-compiler/blob/master/vrange.d
    opAnd(rhs: IntRange): IntRange {
        // unsigned or identical sign bits
        if (this.imin.negative === this.imax.negative && rhs.imin.negative === rhs.imax.negative) {
            return new IntRange(IntRange.minAnd(this, rhs), IntRange.maxAnd(this, rhs));
        }

        const l = IntRange.fromIntRange(this);
        const r = IntRange.fromIntRange(rhs);

        // both intervals span [-1,0]
        if (this.imin.negative !== this.imax.negative && rhs.imin.negative !== rhs.imax.negative) {
            // cannot be larger than either l.max or r.max, set the other one to -1
            const max = (l.imax.value > r.imax.value ? l.imax : r.imax).copy();

            // only negative numbers for minimum
            l.imax.value = ULONG_MAX; // -1
            l.imax.negative = true;
            r.imax.value = ULONG_MAX; // -1
            r.imax.negative = true;

            return new IntRange(IntRange.minAnd(l, r), max);
        } else {
            // only one interval spans [-1,0]
            if (l.imin.negative !== l.imax.negative) {
                IntRange.swap(l, r); // r spans [-1,0]
            }

            const minAndNeg = IntRange.minAnd(l, new IntRange(r.imin, new SignExtendedNumber(ULONG_MAX)));
            const minAndPos = IntRange.minAnd(l, new IntRange(new SignExtendedNumber(0n), r.imax));
            const maxAndNeg = IntRange.maxAnd(l, new IntRange(r.imin, new SignExtendedNumber(ULONG_MAX)));
            const maxAndPos = IntRange.maxAnd(l, new IntRange(new SignExtendedNumber(0n), r.imax));

            const min = minAndNeg.opCmp(minAndPos) < 0 ? minAndNeg : minAndPos;
            const max = maxAndNeg.opCmp(maxAndPos) > 0 ? maxAndNeg : maxAndPos;

            const range = new IntRange(min, max);
            return range;
        }
    }

    /// dmd/intrange.d:542 — `opBinary(string op : "|")`.
    // Credits to Timon Gehr for the algorithms for &, |
    // https://github.com/tgehr/d-compiler/blob/master/vrange.d
    opOr(rhs: IntRange): IntRange {
        // unsigned or identical sign bits:
        if (this.imin.negative === this.imax.negative && rhs.imin.negative === rhs.imax.negative) {
            return new IntRange(IntRange.minOr(this, rhs), IntRange.maxOr(this, rhs));
        }

        const l = IntRange.fromIntRange(this);
        const r = IntRange.fromIntRange(rhs);

        // both intervals span [-1,0]
        if (this.imin.negative !== this.imax.negative && rhs.imin.negative !== rhs.imax.negative) {
            // cannot be smaller than either l.min or r.min, set the other one to 0
            const min = (l.imin.value < r.imin.value ? l.imin : r.imin).copy();

            // only negative numbers for minimum
            l.imin.value = 0n;
            l.imin.negative = false;
            r.imin.value = 0n;
            r.imin.negative = false;

            return new IntRange(min, IntRange.maxOr(l, r));
        } else {
            // only one interval spans [-1,0]
            if (this.imin.negative !== this.imax.negative) {
                IntRange.swap(l, r); // r spans [-1,0]
            }

            const minOrNeg = IntRange.minOr(l, new IntRange(r.imin, new SignExtendedNumber(ULONG_MAX)));
            const minOrPos = IntRange.minOr(l, new IntRange(new SignExtendedNumber(0n), r.imax));
            const maxOrNeg = IntRange.maxOr(l, new IntRange(r.imin, new SignExtendedNumber(ULONG_MAX)));
            const maxOrPos = IntRange.maxOr(l, new IntRange(new SignExtendedNumber(0n), r.imax));

            const min = minOrNeg.opCmp(minOrPos) < 0 ? minOrNeg : minOrPos;
            const max = maxOrNeg.opCmp(maxOrPos) > 0 ? maxOrNeg : maxOrPos;

            const range = new IntRange(min, max);
            return range;
        }
    }

    /// dmd/intrange.d:588 — `opBinary(string op : "^")`: `this & ~rhs | ~this & rhs`.
    opXor(rhs: IntRange): IntRange {
        return this.opAnd(rhs.opCom()).opOr(this.opCom().opAnd(rhs));
    }

    /// dmd/intrange.d:593 — `opBinary(string op : "+")`.
    opAdd(rhs: IntRange): IntRange {
        return new IntRange(this.imin.opAdd(rhs.imin), this.imax.opAdd(rhs.imax));
    }

    /// dmd/intrange.d:598 — `opBinary(string op : "-")`.
    opSub(rhs: IntRange): IntRange {
        return new IntRange(this.imin.opSub(rhs.imax), this.imax.opSub(rhs.imin));
    }

    /// dmd/intrange.d:603 — `opBinary(string op : "*")`.
    opMul(rhs: IntRange): IntRange {
        // [a,b] * [c,d] = [min (ac, ad, bc, bd), max (ac, ad, bc, bd)]
        const bdy: SignExtendedNumber[] = [
            new SignExtendedNumber(), new SignExtendedNumber(), new SignExtendedNumber(), new SignExtendedNumber(),
        ]; // SignExtendedNumber[4] bdy;
        bdy[0] = this.imin.opMul(rhs.imin);
        bdy[1] = this.imin.opMul(rhs.imax);
        bdy[2] = this.imax.opMul(rhs.imin);
        bdy[3] = this.imax.opMul(rhs.imax);
        return IntRange.fromNumbers4(bdy); // D: bdy.ptr
    }

    /// dmd/intrange.d:614 — `opBinary(string op : "/")`. MUTATES its by-value `rhs` (:624/:628): callers pass
    /// `rhs.copy()` (03 §1 #2).
    opDiv(rhs: IntRange): IntRange {
        // Handle divide by 0
        if (rhs.imax.value === 0n && rhs.imin.value === 0n)
            return IntRange.widest();

        // Don't treat the whole range as divide by 0 if only one end of a range is 0.
        // https://issues.dlang.org/show_bug.cgi?id=15289
        if (rhs.imax.value === 0n) {
            rhs.imax.value = toUint64(rhs.imax.value - 1n);
        } else if (rhs.imin.value === 0n) {
            rhs.imin.value++; // 0 -> 1: no wrap
        }

        if (!this.imin.negative && !this.imax.negative && !rhs.imin.negative && !rhs.imax.negative) {
            return new IntRange(this.imin.opDiv(rhs.imax), this.imax.opDiv(rhs.imin));
        }
        if (rhs.imin.negative && !rhs.imax.negative) { // divisor spans [-1, 0, 1]
            const bdy: SignExtendedNumber[] = [
                this.imin.opNeg(), this.imin.copy(), this.imax.opNeg(), this.imax.copy(),
            ]; // SignExtendedNumber[4] bdy = [-imin, imin, -imax, imax];
            return IntRange.fromNumbers4(bdy); // D: bdy.ptr
        }
        // [a,b] / [c,d] = [min (a/c, a/d, b/c, b/d), max (a/c, a/d, b/c, b/d)]
        const bdy: SignExtendedNumber[] = [
            new SignExtendedNumber(), new SignExtendedNumber(), new SignExtendedNumber(), new SignExtendedNumber(),
        ]; // SignExtendedNumber[4] bdy;
        bdy[0] = this.imin.opDiv(rhs.imin);
        bdy[1] = this.imin.opDiv(rhs.imax);
        bdy[2] = this.imax.opDiv(rhs.imin);
        bdy[3] = this.imax.opDiv(rhs.imax);

        return IntRange.fromNumbers4(bdy); // D: bdy.ptr
    }

    /// dmd/intrange.d:650 — `opBinary(string op : "%")`.
    opMod(rhs: IntRange): IntRange {
        const irNum = this.copy();
        const irDen = rhs.absNeg();

        /*
         due to the rules of D (C)'s % operator, we need to consider the cases
         separately in different range of signs.

             case 1. [500, 1700] % [7, 23] (numerator is always positive)
                 = [0, 22]
             case 2. [-500, 1700] % [7, 23] (numerator can be negative)
                 = [-22, 22]
             case 3. [-1700, -500] % [7, 23] (numerator is always negative)
                 = [-22, 0]

         the number 22 is the maximum absolute value in the denomator's range. We
         don't care about divide by zero.
         */

        irDen.imin = irDen.imin.opAdd(new SignExtendedNumber(1n));
        irDen.imax = irDen.imin.opNeg();

        if (!irNum.imin.negative) {
            irNum.imin.value = 0n;
        } else if (irNum.imin.opCmp(irDen.imin) < 0) {
            irNum.imin = irDen.imin.copy();
        }

        if (irNum.imax.negative) {
            irNum.imax.negative = false;
            irNum.imax.value = 0n;
        } else if (irNum.imax.opCmp(irDen.imax) > 0) {
            irNum.imax = irDen.imax.copy();
        }

        return irNum;
    }

    /// dmd/intrange.d:695 — `opBinary(string op : "<<")`.
    opShl(rhs: IntRange): IntRange {
        if (rhs.imin.negative) {
            rhs = new IntRange(new SignExtendedNumber(0n), new SignExtendedNumber(64n));
        }

        const lower = this.imin.opShl(this.imin.negative ? rhs.imax : rhs.imin);
        const upper = this.imax.opShl(this.imax.negative ? rhs.imin : rhs.imax);

        return new IntRange(lower, upper);
    }

    /// dmd/intrange.d:708 — `opBinary(string op : ">>")`.
    opShr(rhs: IntRange): IntRange {
        if (rhs.imin.negative) {
            rhs = new IntRange(new SignExtendedNumber(0n), new SignExtendedNumber(64n));
        }

        const lower = this.imin.opShr(this.imin.negative ? rhs.imin : rhs.imax);
        const upper = this.imax.opShr(this.imax.negative ? rhs.imax : rhs.imin);

        return new IntRange(lower, upper);
    }

    /// dmd/intrange.d:721 — `opBinary(string op : ">>>")` (uses `SignExtendedNumber`'s `>>`).
    opUShr(rhs: IntRange): IntRange {
        if (rhs.imin.negative) {
            rhs = new IntRange(new SignExtendedNumber(0n), new SignExtendedNumber(64n));
        }

        return new IntRange(this.imin.opShr(rhs.imax), this.imax.opShr(rhs.imin));
    }

    /// dmd/intrange.d:731 — `opBinary(string op : "^^")`: not implemented upstream (`assert(0)`).
    opPow(rhs: IntRange): IntRange {
        void rhs; // D never reads it before the assert(0)
        // Not yet implemented
        return assertUnreachable();
    }

    // private: (dmd/intrange.d:737) — the four bound algorithms and `swap`. D-private, reached only from
    // this struct's own methods.

    /// dmd/intrange.d:740 — `static SignExtendedNumber maxOr(const IntRange lhs, const IntRange rhs)`:
    /// the maximum of `x | y` over both ranges. `lhs`/`rhs` are const by-value: never mutated.
    // Credits to Timon Gehr maxOr, minOr, maxAnd, minAnd
    // https://github.com/tgehr/d-compiler/blob/master/vrange.d
    private static maxOr(lhs: IntRange, rhs: IntRange): SignExtendedNumber {
        let x: uinteger_t = 0n;
        let sign = false;
        const xor: uinteger_t = lhs.imax.value ^ rhs.imax.value;
        const and: uinteger_t = lhs.imax.value & rhs.imax.value;
        const lhsc = IntRange.fromIntRange(lhs);
        const rhsc = IntRange.fromIntRange(rhs);

        // Sign bit not part of the .value so we need an extra iteration
        if (lhsc.imax.negative !== rhsc.imax.negative) { // bool ^ bool
            sign = true;
            if (lhsc.imax.negative) {
                if (!lhsc.imin.negative) {
                    lhsc.imin.value = 0n;
                }
                if (!rhsc.imin.negative) {
                    rhsc.imin.value = 0n;
                }
            }
        } else if (lhsc.imin.negative && rhsc.imin.negative) { // bool & bool
            sign = true;
        } else if (lhsc.imax.negative && rhsc.imax.negative) { // bool & bool
            return new SignExtendedNumber(ULONG_MAX, false); // SignExtendedNumber(-1, false)
        }

        for (let d: uinteger_t = 1n << 63n; d !== 0n; d >>= 1n) { // 1LU << (8 * uinteger_t.sizeof - 1)
            if ((xor & d) !== 0n) {
                x |= d;
                if ((lhsc.imax.value & d) !== 0n) {
                    if ((toUint64(~lhsc.imin.value) & d) !== 0n) {
                        lhsc.imin.value = 0n;
                    }
                } else {
                    if ((toUint64(~rhsc.imin.value) & d) !== 0n) {
                        rhsc.imin.value = 0n;
                    }
                }
            } else if ((lhsc.imin.value & rhsc.imin.value & d) !== 0n) {
                x |= d;
            } else if ((and & d) !== 0n) {
                x |= toUint64(toUint64(d << 1n) - 1n);
                break;
            }
        }

        const range = new SignExtendedNumber(x, sign);
        return range;
    }

    /// dmd/intrange.d:811 — `static SignExtendedNumber minOr(const IntRange lhs, const IntRange rhs)`.
    // Credits to Timon Gehr maxOr, minOr, maxAnd, minAnd
    // https://github.com/tgehr/d-compiler/blob/master/vrange.d
    private static minOr(lhs: IntRange, rhs: IntRange): SignExtendedNumber {
        return IntRange.maxAnd(lhs.opCom(), rhs.opCom()).opCom();
    }

    /// dmd/intrange.d:818 — `static SignExtendedNumber maxAnd(const IntRange lhs, const IntRange rhs)`:
    /// the maximum of `x & y` over both ranges. `lhs`/`rhs` are const by-value: never mutated.
    // Credits to Timon Gehr maxOr, minOr, maxAnd, minAnd
    // https://github.com/tgehr/d-compiler/blob/master/vrange.d
    private static maxAnd(lhs: IntRange, rhs: IntRange): SignExtendedNumber {
        let x: uinteger_t = 0n;
        let sign = false;
        const lhsc = IntRange.fromIntRange(lhs);
        const rhsc = IntRange.fromIntRange(rhs);

        if (lhsc.imax.negative && rhsc.imax.negative) { // bool & bool
            sign = true;
        }

        for (let d: uinteger_t = 1n << 63n; d !== 0n; d >>= 1n) { // 1LU << (8 * uinteger_t.sizeof - 1)
            if ((lhsc.imax.value & rhsc.imax.value & d) !== 0n) {
                x |= d;
                if ((toUint64(~lhsc.imin.value) & d) !== 0n) {
                    lhsc.imin.value = 0n;
                }
                if ((toUint64(~rhsc.imin.value) & d) !== 0n) {
                    rhsc.imin.value = 0n;
                }
            } else if ((toUint64(~lhsc.imin.value) & d) !== 0n && (lhsc.imax.value & d) !== 0n) {
                lhsc.imax.value |= d - 1n; // d >= 1: no wrap
            } else if ((toUint64(~rhsc.imin.value) & d) !== 0n && (rhsc.imax.value & d) !== 0n) {
                rhsc.imax.value |= d - 1n;
            }
        }

        const range = new SignExtendedNumber(x, sign);
        return range;
    }

    /// dmd/intrange.d:860 — `static SignExtendedNumber minAnd(const IntRange lhs, const IntRange rhs)`.
    // Credits to Timon Gehr maxOr, minOr, maxAnd, minAnd
    // https://github.com/tgehr/d-compiler/blob/master/vrange.d
    private static minAnd(lhs: IntRange, rhs: IntRange): SignExtendedNumber {
        return IntRange.maxOr(lhs.opCom(), rhs.opCom()).opCom();
    }

    /// dmd/intrange.d:865 — `static swap(ref IntRange a, ref IntRange b)`: exchanges the CONTENTS of two
    /// `ref` slots. TS cannot rebind the caller's variables, so each struct assignment overwrites the
    /// fields in place (03 §1.1).
    private static swap(a: IntRange, b: IntRange): void {
        const aux = a.copy();
        a.imin = b.imin.copy(); // a = b;
        a.imax = b.imax.copy();
        b.imin = aux.imin.copy(); // b = aux;
        b.imax = aux.imax.copy();
    }
}
