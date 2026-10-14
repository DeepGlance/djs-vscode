// Hand-written numeric helpers for the djs frontend port.
//
// SPEC: docs/porting/09-numerics.md. There is no single D source file behind this module —
// it is the canonical, auditable home for the truncation / wrap rules that the frontend
// expresses inline as `cast(IntType)` and as `IntegerExp.normalize` (dmd/expression.d:829).
//
// THE ONE RULE (09 §2): an integer cast / store-into-a-narrower-type is mask-then-sign-extend:
//   1. mask the source to the target width's low N bits (N in {8,16,32,64})
//   2. reinterpret per signedness — unsigned: raw masked value; signed: sign-extend from bit N-1
// Width changes never throw and never saturate; they truncate/wrap silently.
//
// DOMAIN SPLIT (09 §0,§1): values <= 32-bit live in the `number` domain; 64-bit `long`/`ulong`
// and every CTFE constant-folding carrier live in the `bigint` domain. The two never mix in one
// expression (09 §5) — that is both a TS type error and a runtime TypeError.
//
// CALL THE HELPER, NEVER INLINE `& 0xff` etc. at the use site (09 §2.1): one source of truth,
// auditable against `IntegerExp.normalize`.

import { TY } from "./dmd/astenums.js";

// =============================================================================================
// SIZE_MAX / NOT_FOUND sentinel (09 §1.3)
// =============================================================================================

/// The not-found sentinel returned where the frontend returns `size_t.max` from a search
/// (e.g. `Array.find`, `FileName` "no extension" searches). `size_t.max` (2^64-1) is NOT
/// exactly representable as a JS `number`, so the port uses `-1`: never a valid index, exactly
/// representable, single `=== SIZE_MAX` / `!== SIZE_MAX` test reads cleanly.
///
/// INVARIANT: this is a SENTINEL, not an arithmetic value. It exists only to be returned and
/// compared for equality (`===`/`!==`). NEVER let it enter arithmetic, ordering (`<`,`>=`), or
/// an index expression — `-1` would silently corrupt any such use. The OTHER D use of
/// `size_t.max` — a `2^64-1` overflow bound on a raw malloc — has no JS analogue and is DROPPED
/// at its site (09 §1.3); do NOT reach for SIZE_MAX to translate that guard.
export const SIZE_MAX = -1;

/// Alias of SIZE_MAX with the search-result spelling. Same constant; use whichever reads better
/// at the site (`return NOT_FOUND;` for a search, `i !== SIZE_MAX` for the test).
export const NOT_FOUND = SIZE_MAX;

// =============================================================================================
// number-domain truncation (<= 32-bit) — mask then sign-extend, mirrors normalize() (09 §2.1)
// =============================================================================================

/// cast(byte): low 8 bits, sign-extended. e.g. toInt8(200) === -56, toInt8(0x1FF) === -1.
export function toInt8(x: number): number {
    return (x << 24) >> 24;
}

/// cast(ubyte)/cast(char): low 8 bits, unsigned. e.g. toUint8(-1) === 255, toUint8(256) === 0.
export function toUint8(x: number): number {
    return x & 0xff;
}

/// cast(short): low 16 bits, sign-extended. e.g. toInt16(40000) === -25536.
export function toInt16(x: number): number {
    return (x << 16) >> 16;
}

/// cast(ushort)/cast(wchar): low 16 bits, unsigned.
export function toUint16(x: number): number {
    return x & 0xffff;
}

/// cast(int): low 32 bits, sign-extended. e.g. toInt32(0xFFFFFFFF) === -1.
export function toInt32(x: number): number {
    return x | 0;
}

/// cast(uint)/cast(dchar): low 32 bits, unsigned (0 .. 2^32-1). e.g. toUint32(-1) === 4294967295.
export function toUint32(x: number): number {
    return x >>> 0;
}

// =============================================================================================
// bigint-domain truncation (64-bit) — BigInt.asIntN/asUintN ARE mask+sign-extend (09 §2.1)
// =============================================================================================

/// cast(long): the 64-bit two's-complement carrier truncation.
/// e.g. toInt64(0xFFFFFFFFFFFFFFFFn) === -1n; toInt64(0xffffffff80000000n) === -2147483648n.
export function toInt64(x: bigint): bigint {
    return BigInt.asIntN(64, x);
}

/// cast(ulong): the full 64-bit unsigned carrier (0 .. 2^64-1).
/// e.g. toUint64(-1n) === 18446744073709551615n.
export function toUint64(x: bigint): bigint {
    return BigInt.asUintN(64, x);
}

/// Generic signed truncation to `bits` width in the bigint carrier — the engine behind the
/// `normalize` port for any width. `BigInt.asIntN` IS mask + sign-extend.
export function maskSignedN(bits: number, x: bigint): bigint {
    return BigInt.asIntN(bits, x);
}

/// Generic unsigned truncation to `bits` width in the bigint carrier.
export function maskUnsignedN(bits: number, x: bigint): bigint {
    return BigInt.asUintN(bits, x);
}

// =============================================================================================
// number-domain (int32) wrapping arithmetic (09 §2.1, §3)
// JS `number` does NOT wrap (2147483647 + 1 === 2147483648, wrong for a D int) — re-truncate.
// =============================================================================================

/// signed 32-bit add with two's-complement wrap. e.g. wrapAddI32(2147483647, 1) === -2147483648.
export function wrapAddI32(a: number, b: number): number {
    return (a + b) | 0;
}

/// unsigned 32-bit add with wrap. e.g. wrapAddU32(0xFFFFFFFF, 1) === 0.
export function wrapAddU32(a: number, b: number): number {
    return (a + b) >>> 0;
}

/// signed 32-bit multiply with wrap. `Math.imul` is the ONLY correct form — `(a*b)|0` loses
/// precision when a*b exceeds 2^53. e.g. wrapMulI32(100000, 100000) === 1410065408.
export function wrapMulI32(a: number, b: number): number {
    return Math.imul(a, b);
}

/// unsigned 32-bit multiply with wrap (result in 0 .. 2^32-1).
export function wrapMulU32(a: number, b: number): number {
    return Math.imul(a, b) >>> 0;
}

// =============================================================================================
// The canonical normalize port — the single truncation gate for every folded integer (09 §2.2)
// =============================================================================================

/// Faithful port of dmd/expression.d:829 `IntegerExp.normalize`. Carrier is the 64-bit bigint;
/// the result is the normalized bit pattern for `ty` (masked to width, sign-extended if signed).
///
/// INVARIANT (09 §2.2, §3): the ported `IntegerExp` constructor runs this internally, so fold
/// call sites pass the RAW carrier result and do NOT re-wrap it here — normalize once, in the
/// ctor. `Tpointer` normalizes as `ulong` on our fixed 64-bit target (target.ptrsize == 8).
/// Non-integral `ty` values (arrays, classes, floats, ...) are passed through unchanged, exactly
/// as the D `default:` branch does.
export function normalizeInteger(ty: TY, value: bigint): bigint {
    switch (ty) {
        case TY.Tbool:
            return value !== 0n ? 1n : 0n;
        case TY.Tint8:
            return maskSignedN(8, value);
        case TY.Tchar:
        case TY.Tuns8:
            return maskUnsignedN(8, value);
        case TY.Tint16:
            return maskSignedN(16, value);
        case TY.Twchar:
        case TY.Tuns16:
            return maskUnsignedN(16, value);
        case TY.Tint32:
            return maskSignedN(32, value);
        case TY.Tdchar:
        case TY.Tuns32:
            return maskUnsignedN(32, value);
        case TY.Tint64:
            return maskSignedN(64, value);
        case TY.Tuns64:
            return maskUnsignedN(64, value);
        case TY.Tpointer:
            return maskUnsignedN(64, value); // target.ptrsize == 8 -> ulong (09 §1.2)
        default:
            return value;
    }
}
