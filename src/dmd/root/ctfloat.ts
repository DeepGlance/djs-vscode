// Port of dmd/root/ctfloat.d — compile-time floating-point helper.
// Contract: docs/porting/08-runtime-lib.md §15.1; the numeric mapping (real == double on this
// target) is owned by 09-numerics.md / _probes.md §6. This file is the canonical, complete home
// of CTFloat for the port — `port.ts` (08 §16) forwards its float-literal range checks here.
//
// real_t = number (double) on this target.
//   _ground-truth.md §3 / _probes.md §6 (verified `ldc2 -run`): `real.sizeof == 8`,
//   `real.mant_dig == 53` — `real == double`, NOT x86's 80-bit extended. JS `number`
//   (IEEE-754 double) therefore maps EXACTLY onto the `real`/CTFloat precision the local
//   compiler folds with; no extended-precision emulation is needed (09-numerics.md §6).
//
// Resolved config (_config.md, cited inline by 08 §15.1):
//   - version(IN_LLVM) is ON  → the generic-libm yl2x/yl2xp1 path is live (NOT x87 `yl2x` asm),
//     and the IN_LLVM-only members (rint/nearbyint/llround/llrint, parse/sprint, isFloat*) apply.
//   - is(real_t == real) is TRUE → the `static if (!is(real_t == real))` soft-double wrappers
//     (ctfloat.d:76-110) are the DEAD branch; we take the `else` (ctfloat.d:111+, direct libm)
//     and map each math fn to `Math.*`. (// resolved: real_t == real -> direct Math.* path.)
//
// Literal conversion and formatting are exact, not deferred: with real == IEEE double both are fully
// determined by what ldc2 1.43.0 does on arm64-apple-darwin. `parse` and `isFloat*LiteralOutOfRange` are
// LLVM APFloat's correctly rounded (half-even) conversion of a decimal or C99 hex-float literal, rebuilt on
// the literal's exact BigInt value (never through JS Number() or a decimal string), with APFloat's
// overflow/underflow status. `sprint` reproduces the bytes ldc2 prints: macOS `snprintf("%Lg")` for 'g'
// (built on the exact decimal expansion, including one gdtoa trailing-zero quirk) and LLVM
// `convertToHexString` for 'a'/'A', with gen/ctfloat.cpp's `.0` and `+` fixups. Pins: ctfloat.test.ts.
//
// dropped: `import dmd.root.port;` (ctfloat.d:25, NEW in 2.113) — no symbol of `Port` is referenced
//   by ctfloat.d; the dependency runs the other way (port.d:88/:121 `Port.isFloat*` FORWARD to
//   CTFloat). Mirroring it in TS would only add an import cycle with `port.ts` for nothing.
// dropped: the 2.113 rewrite of the private `version(CRuntime_Microsoft)` import block
//   (ctfloat.d:27-36: `public import` → `import`, and `import dmd.root.strtold` → the selective
//   `strtold = strtold_ms`) — CRuntime_Microsoft is OFF (_config.md), so the block is dead. 2.113
//   also deleted the `version(CRuntime_DigitalMars) __locale_decpoint` declaration and its two use
//   sites in `parse` — dead here either way (CRuntime_DigitalMars OFF), never ported.

import type { DString } from "../../dstring.js";
import { ds, dsToJs } from "../../dstring.js";
import { DError } from "../../assert.js";
import { calcHash } from "./hash.js";

/// real_t — the front-end's compile-time real. `double` on this target (see file header).
/// D: `public import dmd.root.longdouble : real_t = longdouble;` (ctfloat.d:24), longdouble == double here.
export type real_t = number;

/// The 8-byte little-endian image of a `double`, reused by `isIdentical`/`hash`. A single
/// shared scratch DataView avoids per-call allocation in these hot CTFE paths (they run during
/// template-argument hashing and constant comparison). NOT thread-shared — the port is
/// single-threaded under Node; `isIdentical`/`hash` read the bytes back synchronously before
/// any re-entry, so the scratch is never observed mid-write.
const scratch = new DataView(new ArrayBuffer(8));

/// An integral-valued double converted to D `long` the way arm64 converts it: out-of-range values
/// saturate to long.min / long.max, NaN becomes `nan` (which differs between llround and llrint).
function saturateToLong(r: real_t, nan: bigint): bigint {
    if (Number.isNaN(r))
        return nan;
    if (r >= 9223372036854775808) // 2^63, the first double above long.max
        return (1n << 63n) - 1n;
    if (r < -9223372036854775808)
        return -(1n << 63n);
    return BigInt(r);
}

// --- Float literal conversion and formatting (the bodies of CTFloat.parse / isFloat* / sprint) -------------

/// An IEEE-754 binary format as LLVM's `fltSemantics` describes it: `precision` significand bits (the
/// integer bit included) and the unbiased exponent range of normal numbers.
interface BinaryFormat {
    readonly precision: number;
    readonly minExponent: number;
    readonly maxExponent: number;
}
const IEEE_SINGLE: BinaryFormat = { precision: 24, minExponent: -126, maxExponent: 127 };
const IEEE_DOUBLE: BinaryFormat = { precision: 53, minExponent: -1022, maxExponent: 1023 };

/// A literal converted to a format: the rounded value (a single-format value is exact in the double
/// carrier) and APFloat's `opOverflow | opUnderflow` status (gen/ctfloat.cpp:32).
interface ParsedLiteral {
    value: real_t;
    isOutOfRange: boolean;
}

/// APFloat `readExponent` stops reading a decimal literal's written exponent at this magnitude
/// (`overlargeExponent`) and uses ±24000 in its place, before the adjustment for the digits.
const DECIMAL_EXPONENT_LIMIT = 24000n;

function bitLength(n: bigint): number {
    return n === 0n ? 0 : n.toString(2).length;
}

function signed(negative: boolean, v: real_t): real_t {
    return negative ? -v : v;
}

/// The NaN whose sign bit is `negative` (APFloat `makeNaN(false, negative)`), built from its bit image
/// because JS arithmetic does not promise to keep a NaN's sign.
function quietNaN(negative: boolean): real_t {
    scratch.setBigUint64(0, negative ? 0xFFF8000000000000n : 0x7FF8000000000000n, true);
    return scratch.getFloat64(0, true);
}

/**
 * APFloat `convertFromStringSpecials` (the spellings without a NaN payload): the value, or null when
 * `text` is not a special spelling. Signaling NaNs and payloads are refused loudly: nothing in the frontend
 * produces them, and a JS number cannot promise to carry a signaling NaN.
 */
function parseSpecial(text: string): real_t | null {
    if (text === "inf" || text === "INFINITY" || text === "+Inf")
        return Infinity;
    if (text === "-inf" || text === "-INFINITY" || text === "-Inf")
        return -Infinity;
    const m = /^(-?)(s|S)?(nan|NaN)(.*)$/.exec(text);
    if (m === null)
        return null;
    if (m[2] !== undefined || m[4] !== "")
        throw new DError(`CTFloat.parse: \`${text}\`: signaling NaN and NaN payload literals are not supported`);
    return quietNaN(m[1] === "-");
}

/**
 * The value `num * 2^shift / den` (num, den > 0) rounded half-even to format `f`, with APFloat's status:
 * overflow when the rounded value exceeds the largest finite number (the result is then ±inf, as in
 * round-to-nearest), underflow when the rounding was inexact and the result is subnormal or zero.
 */
function roundToFormat(negative: boolean, num: bigint, den: bigint, shift: number, f: BinaryFormat): ParsedLiteral {
    const p = f.precision;
    const atLeast = (e: number): boolean => { // value >= 2^e
        const k = shift - e;
        return k >= 0 ? num << BigInt(k) >= den : num >= den << BigInt(-k);
    };
    let e = bitLength(num) - bitLength(den) + shift; // floor(log2(value)) is e or e - 1
    if (!atLeast(e))
        e -= 1;
    let q = Math.max(e, f.minExponent) - (p - 1); // exponent of the result's last significand bit
    const k = shift - q;
    const n2 = k >= 0 ? num << BigInt(k) : num;
    const d2 = k >= 0 ? den : den << BigInt(-k);
    let m = n2 / d2;
    const r = n2 - m * d2;
    const inexact = r !== 0n;
    if (2n * r > d2 || (2n * r === d2 && (m & 1n) === 1n))
        m += 1n;
    if (m === 1n << BigInt(p)) {
        m >>= 1n;
        q += 1;
    }
    if (q + p - 1 > f.maxExponent)
        return { value: signed(negative, Infinity), isOutOfRange: true };
    const tiny = m < 1n << BigInt(p - 1);
    return { value: signed(negative, Number(m) * Math.pow(2, q)), isOutOfRange: inexact && tiny };
}

/**
 * `N * radix^exponent` (radix 10 or 2) rounded to `f`. Magnitudes far outside the format are decided from
 * the bit length alone, as APFloat's quick checks do, so `1e-24000` builds no 80000-bit power of ten.
 * Precondition: `exponent` is already bounded by APFloat's exponent limits (see `parseLiteral`).
 */
function convertExact(negative: boolean, n: bigint, exponent: bigint, radix: 2 | 10, f: BinaryFormat): ParsedLiteral {
    if (n === 0n)
        return { value: signed(negative, 0), isOutOfRange: false };
    const x = Number(exponent);
    const log2Radix = radix === 10 ? Math.log2(10) : 1;
    const bl = bitLength(n); // value in [2^(bl-1), 2^bl) * radix^x
    if (bl - 1 + x * log2Radix > f.maxExponent + 2)
        return { value: signed(negative, Infinity), isOutOfRange: true };
    if (bl + x * log2Radix < f.minExponent - f.precision - 2)
        return { value: signed(negative, 0), isOutOfRange: true };
    if (radix === 2)
        return roundToFormat(negative, n, 1n, x, f);
    return x >= 0
        ? roundToFormat(negative, n * 10n ** BigInt(x), 1n, 0, f)
        : roundToFormat(negative, n, 10n ** BigInt(-x), 0, f);
}

/**
 * APFloat `totalExponent` overflow for a hex literal with a nonzero significand: the written exponent's
 * magnitude exceeds 32767, or the adjustment for the digit positions, or its sum with the written exponent,
 * leaves [-32768, 32767]. APFloat then sets the exponent to -32768 or 32767 by the written exponent's sign
 * alone, whatever the digits say, so the literal becomes ±0 or ±inf and is out of range either way
 * (ldc2 1.43.0: `0x0.<8200 zeros>1p32800` is inf, `0x1<8199 zeros>p-32767` is 0).
 * The adjustment is APFloat's: 4 bits per significant digit before the point, less one, plus the precision,
 * less the 64 bits of the one integerPart both formats are stored in.
 */
function hexExponentSaturates(intDigits: string, frac: string, written: bigint, f: BinaryFormat): boolean {
    const lead = intDigits.search(/[1-9a-fA-F]/);
    const digitsBeforePoint = lead >= 0 ? intDigits.length - lead : -frac.search(/[1-9a-fA-F]/);
    const adjustment = BigInt(4 * digitsBeforePoint - 1 + f.precision - 64);
    const inRange = (e: bigint): boolean => e >= -32768n && e <= 32767n;
    return written > 32767n || written < -32767n || !inRange(adjustment) || !inRange(written + adjustment);
}

/**
 * APFloat `convertFromString(text, rmNearestTiesToEven)` at format `f` (gen/ctfloat.cpp:26-35): the exact
 * value of the literal rounded half-even, after APFloat's exponent limits (`DECIMAL_EXPONENT_LIMIT`,
 * `hexExponentSaturates`), which change the value only for literals thousands of digits long.
 */
function parseLiteral(text: string, f: BinaryFormat): ParsedLiteral {
    const special = parseSpecial(text);
    if (special !== null)
        return { value: special, isOutOfRange: false };
    const negative = text.startsWith("-");
    const body = text.startsWith("-") || text.startsWith("+") ? text.slice(1) : text;
    const hex = /^0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?[pP]([+-]?[0-9]+)$/.exec(body);
    if (hex !== null && (hex[1] + (hex[2] ?? "")).length > 0) {
        const frac = hex[2] ?? "";
        const n = BigInt("0x" + hex[1] + frac);
        const written = BigInt(hex[3]);
        if (n !== 0n && hexExponentSaturates(hex[1], frac, written, f)) {
            const toZero = hex[3].startsWith("-");
            return { value: signed(negative, toZero ? 0 : Infinity), isOutOfRange: true };
        }
        return convertExact(negative, n, written - BigInt(4 * frac.length), 2, f);
    }
    const dec = /^([0-9]*)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?$/.exec(body);
    if (dec !== null && (dec[1] + (dec[2] ?? "")).length > 0) {
        const frac = dec[2] ?? "";
        const n = BigInt(dec[1] + frac);
        const written = BigInt(dec[3] ?? "0");
        const limited = written > DECIMAL_EXPONENT_LIMIT ? DECIMAL_EXPONENT_LIMIT
            : written < -DECIMAL_EXPONENT_LIMIT ? -DECIMAL_EXPONENT_LIMIT : written;
        return convertExact(negative, n, limited - BigInt(frac.length), 10, f);
    }
    throw new DError(`CTFloat.parse: \`${text}\` is not a decimal or hex-float literal`);
}

/// The stored fraction field and biased exponent field of a double's bit image.
function decompose(bits: bigint): { fraction: bigint; biased: number } {
    return { fraction: bits & 0xFFFFFFFFFFFFFn, biased: Number((bits >> 52n) & 0x7FFn) };
}

/// LLVM `IEEEFloat::convertToHexString(str, 0, uppercase, …)` of a finite double, with LDC's `+` before a
/// non-negative exponent (gen/ctfloat.cpp:171-199, the `+` at :182-195).
function formatHex(bits: bigint, uppercase: boolean): string {
    const sign = bits >> 63n === 1n ? "-" : "";
    const x = uppercase ? "X" : "x";
    const p = uppercase ? "P" : "p";
    const { fraction, biased } = decompose(bits);
    if (biased === 0 && fraction === 0n)
        return `${sign}0${x}0${p}+0`;
    // APFloat keeps a subnormal at exponent minExponent with a zero integer bit.
    const sig = biased === 0 ? fraction : fraction | (1n << 52n);
    const exponent = biased === 0 ? -1022 : biased - 1023;
    let lsb = 0;
    while (((sig >> BigInt(lsb)) & 1n) === 0n)
        lsb++;
    // 53 significand bits + 3 virtual leading zeros = 14 hex digits; trailing zero digits are not written.
    const outputDigits = Math.floor((56 - lsb + 3) / 4);
    let digits = sig.toString(16).padStart(14, "0").slice(0, outputDigits);
    if (uppercase)
        digits = digits.toUpperCase();
    const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}0${x}${mantissa}${p}${exponent >= 0 ? "+" : ""}${exponent}`;
}

/**
 * C `snprintf("%Lg", x)` of a finite double as macOS libc writes it (see `CTFloat.sprint`): six significant
 * digits from the exact decimal expansion, rounded half-even, then the %g layout (fixed notation when the
 * decimal exponent X satisfies -4 <= X < 6, otherwise `d.ddddde±XX`, trailing zeros removed).
 */
function formatG(bits: bigint): string {
    const sign = bits >> 63n === 1n ? "-" : "";
    const { fraction, biased } = decompose(bits);
    let digits: string;
    let decpt: number; // value = 0.digits * 10^decpt
    if (biased === 0 && fraction === 0n) {
        digits = "0";
        decpt = 1;
    } else {
        const m = biased === 0 ? fraction : fraction | (1n << 52n);
        const e = (biased === 0 ? 1 : biased) - 1075;
        const exact = e >= 0 ? (m << BigInt(e)).toString() : (m * 5n ** BigInt(-e)).toString();
        const exactDecpt = exact.length + Math.min(e, 0);
        const all = exact.replace(/0+$/, "");
        ({ digits, decpt } = roundSixDigits(all, exactDecpt, all.length <= exactDecpt));
    }
    if (decpt > -4 && decpt <= 6) {
        const intPart = decpt <= 0 ? "0" : digits.slice(0, decpt).padEnd(decpt, "0");
        const frac = decpt < 0 ? "0".repeat(-decpt) + digits : digits.slice(decpt);
        return sign + intPart + (frac.length > 0 ? "." + frac : "");
    }
    const x = decpt - 1;
    const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${mantissa}e${x < 0 ? "-" : "+"}${String(Math.abs(x)).padStart(2, "0")}`;
}

/**
 * gdtoa `dtoa(mode 2, ndigits 6)` on an exact digit string (no leading or trailing zeros): the rounded
 * digits and decimal point. Half-even on the exact tail; trailing zeros trimmed, except in dtoa's
 * "small integer" path (an integer value with decpt <= 15), which leaves them when an exact tie rounds
 * down (ldc2 1.43.0: 1000005.0 → `1.00000e+06`, 100000500000000.0 → `1.00000e+14`, but
 * 1000005000000000.0 → `1e+15` and 1000001.0 → `1e+06`).
 */
function roundSixDigits(all: string, decpt: number, integer: boolean): { digits: string; decpt: number } {
    if (all.length <= 6)
        return { digits: all, decpt };
    const head = all.slice(0, 6);
    const tail = all.slice(6);
    const cmp = tail[0] > "5" ? 1 : tail[0] < "5" ? -1 : tail.length > 1 ? 1 : 0; // the tail has no trailing 0
    if (cmp > 0 || (cmp === 0 && (head.charCodeAt(5) & 1) === 1)) {
        const kept = head.replace(/9+$/, "");
        if (kept.length === 0)
            return { digits: "1", decpt: decpt + 1 };
        return { digits: kept.slice(0, -1) + String.fromCharCode(kept.charCodeAt(kept.length - 1) + 1), decpt };
    }
    const smallIntegerTie = cmp === 0 && integer && decpt <= 15;
    return { digits: smallIntegerTie ? head : head.replace(/0+$/, ""), decpt };
}

/**
 * `CTFloat` — DMD's compile-time floating-point helper (`ctfloat.d:40`, an `extern (C++) struct`
 * of static members). Ported as a class of `static` members; it carries no instance state.
 *
 * Numeric domain: every member operates in the `number` (IEEE-754 double) domain. Float values
 * are NEVER `bigint` (09-numerics.md §6). `hash` returns a 32-bit MurmurHash2 (`number`, 08 §9).
 *
 * Precision invariant (decisive, 09-numerics.md §6.1): the constant folder keeps DOUBLE precision
 * for `float`/`double`/`real` alike — it does NOT f32-round. So `CTFloat` math is plain `Math.*`;
 * never insert `Math.fround`. Adding it would make the port DIVERGE from the compiler we match.
 */
export class CTFloat {
    // --- yl2x support flags (ctfloat.d:46-54) -------------------------------------------------
    // 2.113 narrowed the D-side condition to
    //   version (GNU)        enum yl2x_supported = false;
    //   else version (AArch64) enum yl2x_supported = false;  // no x87 FPU
    //   else                 enum yl2x_supported = is(real_t == real) &&
    //                                              __traits(compiles, core.math.yl2x(1.0L, 2.0L));
    // resolved: version(GNU) OFF, version(AArch64) OFF (self-config, _config.md) → the `else` arm;
    // `is(real_t == real)` is TRUE here (real == double, file header).
    //
    // The flag is kept TRUE, as in the 1.42 translation: under version(IN_LLVM) — which is ON —
    // NOTHING reads it outside CTFloat itself. builtin.d:181-182 (the IN_LLVM arm) returns
    // BUILTIN.yl2x/yl2xp1 unconditionally *because* CTFloat falls back to the generic
    // `*y * log2(*x)` path; only the non-IN_LLVM arm (builtin.d:186-187) gates on the flag. In the
    // port, yl2x/yl2xp1 ARE implemented (below), which is what `true` states.
    // FLAG (escalated, `ambiguous mapping`): read strictly as a host-druntime question, the new
    // `__traits(compiles, core.math.yl2x)` conjunct is FALSE on a non-x87 host — the very case the
    // new `version(AArch64) … // no x87 FPU` arm spells out — so a literal resolution would emit
    // `false`. The two readings are indistinguishable in behavior while IN_LLVM is ON (no live
    // reader), so the value is left as it was rather than churned; adjudicate before any consumer
    // of these flags is ported.
    static readonly yl2x_supported = true;
    static readonly yl2xp1_supported = true;

    // --- Constant real values (ctfloat.d:274-281, initialized in gen/ctfloat.cpp:65-71) -------
    // D declares these as __gshared mutables filled by `initialize()`; in the port they are eager
    // immutable constants (JS has no init-order hazard for literals). Values verified against
    // gen/ctfloat.cpp `initialize()`: zero=0, one=1, minusone=-1, half=0.5; nan = APFloat::getQNaN,
    // infinity = APFloat::getInf. JS `NaN`/`Infinity` carry the IDENTICAL bit images on this target
    // (verified /tmp/probe3: real_t.nan bits 0x7ff8000000000000 == JS NaN; inf 0x7ff0000000000000).
    static readonly zero: real_t = 0;
    static readonly one: real_t = 1;
    static readonly minusone: real_t = -1;
    static readonly half: real_t = 0.5;
    static readonly nan: real_t = NaN; // version(IN_LLVM) __gshared real_t nan (ctfloat.d:280)
    static readonly infinity: real_t = Infinity; // version(IN_LLVM) __gshared real_t infinity (:281)

    /**
     * `initialize()` (ctfloat.d:288 / gen/ctfloat.cpp:41) — fills the __gshared constants and the
     * LLVM `apSemantics`. NO-OP in the port: the constants above are eager `static readonly`, and
     * there is no LLVM `fltSemantics` to choose (real_t is fixed to double). Kept so the handful of
     * `CTFloat.initialize()` call sites (e.g. the ctfloat.d:314 unittest, driver startup) compile.
     */
    static initialize(): void {
        // constants are eager `static readonly` — nothing to initialize.
    }

    // --- log2-based pseudo-ops (ctfloat.d:56-74) ---------------------------------------------
    // D passes pointers (`const real_t* x, *y, real_t* res`) because the x87 path returned via a
    // pointer; the IN_LLVM fallback is a pure expression. The port returns the value directly —
    // the pointer plumbing is a calling-convention artifact with no semantic weight here. Call
    // sites (builtin.d:478/:491) read `*res` immediately; the deref is translated away.
    //
    // resolved: version(IN_LLVM) -> `*y * log2(*x)` fallback (ctfloat.d:61/:71). Verified parity
    // with ldc2: yl2x(8,2)=6, yl2xp1(7,2)=6, yl2x(4,3)=6 (== JS 2*log2(8) etc.).
    //
    // FLAG (_config.md #5): bit-exact parity of `Math.log2` vs hardware x87 `yl2x` for CTFE
    // constant-folding is UNVERIFIED at the ULP level. Both this port and the target frontend use
    // the SAME generic `log2` fallback (x87 is OFF), so they should agree; but if a frontend file
    // constant-folds yl2x/yl2xp1 and a fail_compilation/compilable test diverges, STOP and probe.
    static yl2x(x: real_t, y: real_t): real_t {
        return y * Math.log2(x);
    }
    static yl2xp1(x: real_t, y: real_t): real_t {
        return y * Math.log2(x + 1);
    }

    // --- Trig / roots / abs / ldexp (ctfloat.d:88-93, live `else` branch) ---------------------
    static sin(x: real_t): real_t {
        return Math.sin(x);
    }
    static cos(x: real_t): real_t {
        return Math.cos(x);
    }
    static tan(x: real_t): real_t {
        return Math.tan(x);
    }
    static sqrt(x: real_t): real_t {
        return Math.sqrt(x);
    }
    static fabs(x: real_t): real_t {
        return Math.abs(x);
    }
    /**
     * `ldexp(n, exp)` = n * 2^exp (ctfloat.d:93 — `pure static real_t ldexp(real_t n, int exp)`, which returns
     * `core.math.ldexp(n, exp)`). `exp` is a 32-bit `int` (`number`).
     *
     * On this target `core.math.ldexp(real, int)` is LDC druntime's `ldexpImpl`
     * (core/math.d:336 — `real ldexp(real n, int exp) { return ldexpImpl(n, exp); }`), the non-x87 arm:
     * a bit-level implementation taken from libmir, NOT C `ldexp`:
     * (core/math.d:151 — `private T ldexpImpl(T)(const T n, int exp)`).
     * It is reproduced here for `double` (`U = ulong`, `exp_shft = 52`, `T.sizeof == U.sizeof`, so the
     * `MANTISSA_LSB` arms are dead). Two of its behaviours differ from C and are load-bearing for parity:
     *   - a subnormal result is TRUNCATED toward zero, not rounded (ldc2 1.43.0: ldexp(3.0, -1075) = 0x…01,
     *     ldexp(3.0, -1076) = 0, ldexp(0x1.fffffffffffffp-1, -1022) = 0x000fffffffffffff);
     *   - a zero input takes the subnormal-input path and comes back as a non-zero subnormal
     *     (ldc2 1.43.0: ldexp(-0.0, 5) = 0x8000000000000010).
     * Also ldc2 1.43.0: ldexp(0.5, 1024) = 0x7fe0000000000000 (no intermediate overflow).
     */
    static ldexp(n: real_t, exp: number): real_t {
        const sig_mask = 0x8000000000000000n;
        const exp_shft = 52n;
        const man_mask = (1n << exp_shft) - 1n;
        const exp_mask = 0x7FF0000000000000n;
        const exp_msh = 0x7FF;
        const intPartMask = man_mask + 1n;
        const norm_factor = 4503599627370496; // `1 / T.epsilon` = 2^52

        let vf = n;
        scratch.setFloat64(0, vf, true);
        let u = scratch.getBigUint64(0, true);
        let e = Number((u & exp_mask) >> exp_shft); // an 11-bit field, int-domain
        if (e !== exp_msh) {
            if (e === 0) { // subnormals input
                vf *= norm_factor;
                scratch.setFloat64(0, vf, true);
                u = scratch.getBigUint64(0, true);
                e = Number((u & exp_mask) >> exp_shft) - (53 - 1); // `T.mant_dig - 1`
            }
            // `exp = adds(exp, e, overflow);` — int addition with overflow detection (core.checkedint)
            const sum = exp + e;
            const overflow = sum > 0x7FFFFFFF || sum < -0x80000000;
            exp = sum | 0;
            if (overflow || exp >= exp_msh) { // infs
                u &= sig_mask;
                u ^= exp_mask;
            } else if (exp > 0) { // normal
                u = (u & ~exp_mask) ^ (BigInt(exp) << exp_shft);
            } else { // subnormal output
                exp = 1 - exp;
                let m = u & man_mask;
                if (exp > 53) // `T.mant_dig`
                    exp = 53;
                u &= sig_mask;
                m ^= intPartMask;
                m >>= BigInt(exp);
                u ^= m;
            }
            scratch.setBigUint64(0, u, true);
            vf = scratch.getFloat64(0, true);
        }
        return vf;
    }

    // --- Rounding (ctfloat.d:113-116, live `else` branch) -------------------------------------
    /**
     * `round(x)` (ctfloat.d:113 — `static real_t round(real_t x) { return core.stdc.math.roundl(x); }`): C
     * `roundl`, half AWAY FROM ZERO. JS `Math.round` rounds half toward +Infinity (Math.round(-2.5) === -2), and
     * `floor(x + 0.5)` double-rounds in the addition. `x - trunc(x)` is exact for every finite double, so the
     * comparison with 0.5 decides without rounding error. NaN and ±inf are returned unchanged (sign bits kept).
     * Verified ldc2 1.43.0: round(2.5)=3, round(-2.5)=-3, round(0.49999999999999994)=0,
     * round(4503599627370497.0)=0x4330000000000001, round(-0.4)=-0.0, round(-0.5)=-1, round(-0.0)=-0.0.
     */
    static round(x: real_t): real_t {
        if (!Number.isFinite(x)) return x;
        let t = Math.trunc(x); // keeps the sign of a zero result: trunc(-0.4) is -0
        if (Math.abs(x - t) >= 0.5)
            t += Math.sign(x);
        return t;
    }
    static floor(x: real_t): real_t {
        return Math.floor(x);
    }
    static ceil(x: real_t): real_t {
        return Math.ceil(x);
    }
    static trunc(x: real_t): real_t {
        return Math.trunc(x);
    }

    // --- Logs / power / exp / copysign (ctfloat.d:117-124, live `else` branch) -----------------
    static log(x: real_t): real_t {
        return Math.log(x);
    }
    static log2(x: real_t): real_t {
        return Math.log2(x);
    }
    static log10(x: real_t): real_t {
        return Math.log10(x);
    }
    static pow(x: real_t, y: real_t): real_t {
        return Math.pow(x, y);
    }
    static exp(x: real_t): real_t {
        return Math.exp(x);
    }
    static expm1(x: real_t): real_t {
        return Math.expm1(x);
    }
    static exp2(x: real_t): real_t {
        return Math.pow(2, x);
    }
    /// `copysign(x, s)` — magnitude of `x` with the sign of `s` (C `copysignl`, ctfloat.d:124).
    /// `Math.sign` is wrong for ±0 (it returns ±0, and `sign(-0)` is -0, but `Math.sign(0)` is 0
    /// while we need the sign BIT). Use `Object.is(-0)` / negative test to read the sign of `s`.
    static copysign(x: real_t, s: real_t): real_t {
        const mag = Math.abs(x);
        const negative = s < 0 || Object.is(s, -0);
        return negative ? -mag : mag;
    }

    // --- fmin / fmax / fma (ctfloat.d:128-133, `pure` block, NOT version-gated) ---------------
    // VERBATIM translation: D's fmin/fmax are `x < y ? x : y` / `x > y ? x : y` — NOT C `fminl`
    // and NOT `Math.min`/`Math.max`. On NaN they propagate the FALSE branch's operand (because any
    // comparison with NaN is false): fmin(NaN, 1) → 1, fmax(NaN, 1) → 1 (verified ldc2). `Math.min`
    // would return NaN — do not substitute it.
    static fmin(x: real_t, y: real_t): real_t {
        return x < y ? x : y;
    }
    static fmax(x: real_t, y: real_t): real_t {
        return x > y ? x : y;
    }
    /// `fma(x, y, z) = (x * y) + z` (ctfloat.d:133). VERBATIM: this is NOT a fused single-rounding
    /// multiply-add — D's CTFloat.fma is literally `(x * y) + z` (two roundings), so the port is
    /// the same `(x * y) + z`. Do NOT reach for a true FMA primitive; it would diverge.
    static fma(x: real_t, y: real_t, z: real_t): real_t {
        return x * y + z;
    }

    // --- IN_LLVM rounding-to-integral members (ctfloat.d:146-151, version(IN_LLVM) block) ------
    // `rint`/`nearbyint` round to nearest, ties-to-even (banker's rounding) under the default FP
    // env — JS has no banker's-rounding primitive, so reproduce it. `llround`/`llrint` return an
    // int64; on this target they fit a JS-safe range for any realistic CTFE operand, but the
    // RETURN TYPE is a 64-bit int → see the FLAG below.
    static rint(x: real_t): real_t {
        return CTFloat.roundTiesToEven(x);
    }
    static nearbyint(x: real_t): real_t {
        return CTFloat.roundTiesToEven(x);
    }

    /// `llround`/`llrint` return D `int64_t` (a 64-bit integer → `bigint` per 09-numerics.md §1); their
    /// one frontend consumer is builtin.ts (`llvm_llround`/`llvm_llrint`). Rounding modes (half away /
    /// ties-to-even), arm64 saturation and NaN results are pinned against ldc2 CTFE in ctfloat.test.ts
    /// and builtin.test.ts.
    static llround(x: real_t): bigint {
        // C `rndtol` / `llround`: round half AWAY from zero, then to integer (ctfloat.d:143/:150).
        // arm64-apple-darwin (the host CTFE runs on, whatever the triple): `fcvtas` saturates and maps NaN to 0
        // (ldc2 CTFE: `llvm_llround(double.nan)` = 0L, `(1e19)` = long.max, `(-inf)` = long.min).
        return saturateToLong(CTFloat.round(x), 0n);
    }
    static llrint(x: real_t): bigint {
        // C `llrint`: round to nearest, ties-to-even (ctfloat.d:144/:151).
        // arm64-apple-darwin libm saturates and maps NaN to long.min (ldc2 CTFE: `llvm_llrint(double.nan)`
        // = long.min, `(inf)` = long.max).
        return saturateToLong(CTFloat.roundTiesToEven(x), -(1n << 63n));
    }

    // --- Predicates (ctfloat.d:158-210) ------------------------------------------------------

    /// `isNaN(r) = !(r == r)` (ctfloat.d:178). JS `NaN !== NaN`, so the literal translation works;
    /// `Number.isNaN` is the canonical spelling (09-numerics.md §6.2). Used pervasively by CTFE
    /// comparison/fold paths (e.g. expressionsem.d:262 RealExp equality, ctfeexpr realCmp).
    static isNaN(r: real_t): boolean {
        return Number.isNaN(r);
    }

    /// `isInfinity(r) = isIdentical(fabs(r), real_t.infinity)` (ctfloat.d:207). True for BOTH +inf
    /// and -inf (fabs strips the sign), false for NaN and finite values. Verified ldc2:
    /// isInfinity(+inf)=isInfinity(-inf)=1, isInfinity(1.0)=isInfinity(nan)=0.
    static isInfinity(r: real_t): boolean {
        return CTFloat.isIdentical(CTFloat.fabs(r), CTFloat.infinity);
    }

    /// `isIdentical(a, b)` — BITWISE identity over the value's bytes (ctfloat.d:159, `memcmp`).
    /// On this target real_t.mant_dig == 53, so it compares all 8 bytes of the double (the
    /// `mant_dig == 64` 10-byte x87 case is dead — _config.md). Bitwise, so:
    ///   - `+0.0` and `-0.0` are NOT identical (different sign bit) — verified ldc2 (=0).
    ///   - any two values with the SAME bits ARE identical, incl. NaN-with-same-bits — verified (=1).
    /// This is DISTINCT from `==`: `0.0 == -0.0` is true but `isIdentical(0.0, -0.0)` is false; and
    /// `NaN == NaN` is false but `isIdentical(NaN, NaN)` (same bits) is true. The frontend uses it
    /// to compare RealExp constants for exact identity (expressionsem.d:269/:278).
    static isIdentical(a: real_t, b: real_t): boolean {
        scratch.setFloat64(0, a, true);
        const aLo = scratch.getUint32(0, true);
        const aHi = scratch.getUint32(4, true);
        scratch.setFloat64(0, b, true);
        return aLo === scratch.getUint32(0, true) && aHi === scratch.getUint32(4, true);
    }

    /// `hash(a)` — 32-bit MurmurHash2 of the value's raw bytes, with NaN canonicalization
    /// (ctfloat.d:167). Any NaN is first replaced by `real_t.nan` so all NaNs hash equally, then
    /// the 8 little-endian bytes of the double are hashed via `calcHash` (08 §9, the canonical
    /// MurmurHash2 home). Returns a 32-bit `number` (size_t in D, but calcHash is the 32-bit form).
    ///
    /// VERIFIED bit-for-bit against ldc2-1.42.0 (/tmp/probe3 + /tmp/jsverify.mjs):
    ///   hash(1.0)=2015398733, hash(2.0)=3262971025, hash(0.0)=2477863612, hash(-0.0)=986614415,
    ///   hash(NaN)=hash(-NaN)=hash(0.0/0.0)=1272885895 (NaN canonicalized → all equal).
    /// Used by templatesem.d:108/:112 for RealExp/ComplexExp template-argument hashing — exactness
    /// is load-bearing (a wrong hash collides → wrong symbol identity, 09-numerics.md §8).
    static hash(a: real_t): number {
        if (Number.isNaN(a)) a = NaN; // canonicalize any NaN to the single qNaN (ctfloat.d:171)
        scratch.setFloat64(0, a, true); // 8 little-endian bytes of the double (real_t.sizeof == 8)
        return calcHash(new Uint8Array(scratch.buffer.slice(0)));
    }

    // --- Float literals: parse and range checks (ctfloat.d:154-155/:217, gen/ctfloat.cpp:113-128) ------------
    // All three members are LLVM `APFloat::convertFromString(literal, rmNearestTiesToEven)` in LDC
    // (gen/ctfloat.cpp:26-35 `parseLiteral`), at real_t (= IEEE double), IEEE double and IEEE single semantics.
    // The port reproduces that conversion exactly with `parseLiteral` (module scope, above): the literal's
    // exact rational value rounded half-even to the format, and LLVM's status bits. `isOutOfRange` is
    // `opOverflow | opUnderflow`, where APFloat raises opUnderflow for every INEXACT result that is subnormal
    // or zero AFTER rounding (tininess after rounding), so an inexact subnormal literal is out of range too.
    // ldc2 1.43.0: `1e-320` and `0x1.8p-1075` are "not representable as a `double`", `0x1p-1074` and
    // `2.2250738585072012e-308` (rounds up to double.min_normal) are not; `0x1.fffffffffffff8p1023` (a tie
    // that rounds to even, upward) overflows; `1.1754942e-38f` underflows as a float. APFloat's exponent limits
    // (`DECIMAL_EXPONENT_LIMIT`, `hexExponentSaturates`) are reproduced too; they only bite on literals
    // thousands of digits long.

    /// True iff the float literal `s` (decimal or hex, no suffix, no `_`) overflows or underflows as an
    /// IEEE single (gen/ctfloat.cpp:118-122). The lexer calls it for an `f`-suffixed literal (lexer.d:3040).
    static isFloat32LiteralOutOfRange(s: DString): boolean {
        return parseLiteral(dsToJs(s), IEEE_SINGLE).isOutOfRange;
    }

    /// True iff the float literal `s` overflows or underflows as an IEEE double (gen/ctfloat.cpp:124-128). The
    /// lexer calls it for an unsuffixed literal (lexer.d:3046).
    static isFloat64LiteralOutOfRange(s: DString): boolean {
        return parseLiteral(dsToJs(s), IEEE_DOUBLE).isOutOfRange;
    }

    /**
     * `parse(literal, out isOutOfRange)` (ctfloat.d:217, gen/ctfloat.cpp:113-116) — the correctly rounded
     * (round-half-even) `real_t` value of a float literal, and whether it overflowed or underflowed (see the
     * block comment above). The `out bool` comes back as a field of the result.
     *
     * Accepted input is what APFloat accepts: an optional `+`/`-`, then a decimal literal (`digits[.digits]
     * [e[+-]digits]`) or a C99 hex-float literal (`0x hexdigits[.hexdigits] p[+-]digits`), or one of the
     * special spellings `inf`, `INFINITY`, `+Inf`, `-inf`, `-INFINITY`, `-Inf`, `nan`, `NaN`, `-nan`, `-NaN`.
     * Callers: the lexer (lexer.d:3026, a cleaned literal without `_` or suffix) and hdrgen's
     * `floatToBuffer` (hdrgen.d:3185, which reads back `sprint('g')` output, `inf`/`nan` included).
     * Anything else would abort LDC in `llvm::cantFail`; here it throws `DError`.
     * Cost: BigInt arithmetic on the literal's exact value, a few microseconds for ordinary literals.
     *
     * dropped: 2.113 simplified the NON-IN_LLVM `parse` body (ctfloat.d:224-230); that body is the dead
     * `else` of `version(IN_LLVM)`, so the change does not reach the port.
     */
    static parse(literal: DString): { value: real_t; isOutOfRange: boolean } {
        return parseLiteral(dsToJs(literal), IEEE_DOUBLE);
    }

    /**
     * `sprint(str, size, fmt, x)` (ctfloat.d:219, gen/ctfloat.cpp:132-228) — `x` formatted the way ldc2 1.43.0
     * on arm64-apple-darwin formats it, returned as the bytes D writes into `str` (no NUL). The buffer size
     * is dropped: every D caller passes at least 28 bytes (tokens.d:1007, hdrgen.d:3178, mangle 36), longer
     * than any output, so the C truncation never happens.
     *
     *  - NaN: `nan` / `NAN`, `-` first when the sign bit is set (ctfloat.cpp:143-155). ±inf: `inf` / `INF`
     *    (:157-169).
     *  - 'a' / 'A': LLVM `APFloat::convertToHexString(str, 0, uppercase, …)` plus LDC's `+` on a non-negative
     *    exponent (ctfloat.cpp:171-199, the `+` at :182-195): `0x1.8p+1`, `0X1.999999999999AP-4`, `-0x0p+0`; a
     *    subnormal keeps the exponent -1022 and a leading 0 digit (`0x0.0000000000001p-1022`); trailing zero
     *    digits dropped.
     *  - 'g': the host C runtime's `snprintf("%Lg")` (long double == double on this host), plus `.0` when
     *    the result is all digits (ctfloat.cpp:201-224, the `.0` at :213-224): `1.0`, `-0.0`, `0.1`, `1e+06`,
     *    `2.22507e-308`.
     *    macOS formats through gdtoa's `dtoa(mode 2, 6 digits)`, correctly rounded half-even, with one
     *    quirk reproduced here: for an integer value below 1e15 whose seventh digit onward is an exact tie
     *    that rounds down, the six digits keep their trailing zeros (`1000005.0` prints `1.00000e+06`, while
     *    `1000001.0` prints `1e+06` and `1000000000000005.0`-sized values print trimmed).
     */
    static sprint(fmt: "g" | "a" | "A", x: real_t): DString {
        const uppercase = fmt === "A";
        scratch.setFloat64(0, x, true);
        const bits = scratch.getBigUint64(0, true);
        const negative = bits >> 63n === 1n;
        if (Number.isNaN(x))
            return ds((negative ? "-" : "") + (uppercase ? "NAN" : "nan"));
        if (!Number.isFinite(x))
            return ds((negative ? "-" : "") + (uppercase ? "INF" : "inf"));
        if (fmt !== "g")
            return ds(formatHex(bits, uppercase));
        const s = formatG(bits);
        return ds(/^-?[0-9]*$/.test(s) ? s + ".0" : s); // "1 => 1.0 to distinguish from integers"
    }

    // --- internal helpers --------------------------------------------------------------------

    /// Round to nearest integer, ties to EVEN (banker's rounding) — the default IEEE rounding mode
    /// used by C `rint`/`nearbyint`/`llrint`. JS lacks a primitive: round to nearest, and on an
    /// exact .5 tie pick the even neighbour. Preserves sign of zero and passes NaN/±inf through.
    private static roundTiesToEven(x: real_t): real_t {
        if (!Number.isFinite(x)) return x; // NaN, ±inf pass through
        const r = Math.round(x); // rounds half toward +inf
        if (Math.abs(x - Math.trunc(x)) === 0.5) {
            // exact tie: choose the even of {r-1, r}; Math.round gave the +inf-ward neighbour
            return r % 2 === 0 ? r : r - 1;
        }
        return r;
    }
}
