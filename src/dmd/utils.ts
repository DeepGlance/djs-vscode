// Ported from dmd/utils.d (module dmd.utils).
//
// Cycle C member: utils ↔ errors (uses `error(...)`) ↔ … . `error` is a value import used only
// inside function bodies (readFile/writeFile/ensurePathToNameExists), which run after module load
// (01 §4.3) — safe across the cycle.

import { ds, type DString } from "../dstring.js";
import { assertUnreachable } from "../assert.js";
import { error } from "./errors.js";
import { Loc } from "./location.js";
import { File } from "./root/file.js";
import { FileName } from "./root/filename.js";
import { OutBuffer } from "./common/outbuffer.js";

// nothrow: (utils.d:22) — ERASE (04 §8).

/**
 * Normalize path by turning forward slashes into backslashes (utils.d:33).
 *
 * Params:
 *   src = Source path, using unix-style ('/') path separators (`const(char)*` -> DString | null)
 * Returns:
 *   A newly-allocated DString with '/' (0x2f) turned into backslashes (0x5c). The `strdup`/`*p`
 *   pointer walk -> a byte-buffer copy with an in-place replace (no embedded NUL in the DString
 *   model; the `while (*p != '\0')` is a full-buffer scan).
 */
export function toWinPath(src: DString | null): DString | null {
    if (src === null) return null;
    const result = src.slice(); // strdup(src)
    for (let i = 0; i < result.length; i++) {
        if (result[i] === 0x2f) result[i] = 0x5c; // '/' -> '\\'
    }
    return result;
}

/**
 * Reads a file, terminate the program on error (utils.d:59).
 * The `if (File.read(...))` polarity is INVERTED (true == failure) — a classic D-IO trap (08).
 * On failure, emit the byte-identical diagnostic and return true.
 * Params:
 *   loc = The line number information from where the call originates
 *   filename = Path to file (`const(char)[]` -> DString)
 *   buf = append contents of file to (ref OutBuffer -> alias, no copy, 03 §3.2)
 * Returns: true on failure.
 */
export function readFile(loc: Loc, filename: DString, buf: OutBuffer): boolean {
    if (File.read(filename, buf)) {
        // `cast(int)filename.length, filename.ptr` — the `%.*s` length+ptr pair. In the DString model
        // the slice IS the pointer; pass it straight through (10 §3.5). The %.*s arg pair is
        // [length, slice]; dmdformat's `%.*s` reads them from the args (10 §3.5).
        error(loc, ds("error reading file `%.*s`"), filename.length, filename);
        return true;
    }
    return false;
}

/**
 * Writes a file, terminate the program on error (utils.d:80). `extern (D)` erases (04 §8).
 * Params:
 *   loc = The line number information from where the call originates
 *   filename = Path to file
 *   data = Full content of the file to be written (`const void[]` -> a byte buffer)
 * Returns: false on error.
 */
export function writeFile(loc: Loc, filename: DString, data: DString): boolean {
    if (!ensurePathToNameExists(Loc.initial, filename)) return false;
    if (!File.update(filename, data)) {
        error(loc, ds("error writing file '%.*s'"), filename.length, filename);
        return false;
    }
    return true;
}

/**
 * Ensure the root path (the path minus the name) of the provided path exists, and terminate the
 * process if it doesn't (utils.d:103).
 * Params:
 *   loc = The line number information from where the call originates
 *   name = a path to check (the name is stripped)
 * Returns: false on error.
 */
export function ensurePathToNameExists(loc: Loc, name: DString): boolean {
    const pt = FileName.path(name);
    if (pt.length) {
        if (!FileName.ensurePathExists(pt)) {
            // NOTE (faithful to upstream): the format string is `"cannot create directory %*.s"` —
            // a malformed specifier (`%*.s`, not `%.*s`). Reproduced byte-for-byte (10 §3.5: the
            // message string is the contract; do not "fix" it). dmdformat handles `%*.s` per its
            // width/precision rules.
            error(loc, ds("cannot create directory %*.s"), pt.length, pt);
            FileName.free(pt);
            return false;
        }
    }
    FileName.free(pt);
    return true;
}

/**
 * Takes a path, and escapes '(', ')' and backslashes (utils.d:127).
 * Params:
 *   buf = Buffer to write the escaped path to (`OutBuffer*` -> OutBuffer ref, 02 §10)
 *   fname = Path to escape (`const(char)*` C-string -> DString; the `*fname` walk stops at NUL)
 */
export function escapePath(buf: OutBuffer, fname: DString): void {
    let i = 0;
    for (;;) {
        const c = i < fname.length ? fname[i] : 0; // `*fname`; past end reads the NUL terminator
        switch (c) {
            case 0:
                return;
            case 0x28: // '('
            case 0x29: // ')'
            case 0x5c: // '\\'
                buf.writeByte(0x5c); // '\\'
                buf.writeByte(c); // goto default (write the char too)
                break;
            default:
                buf.writeByte(c);
                break;
        }
        i++;
    }
}

/**
 * The compile-time numeric type of `parseDigits!T` (utils.d:160). D resolves three things about
 * `T` at instantiation: the accumulator width/domain, signedness, and `T.max`. Since TS cannot fold
 * a generic at translation time (07 "Compile-time dispatch on a generic type parameter"), the
 * caller passes the concrete `T` as a tag; the body branches on it exactly as D's `static if` does.
 *
 * Domain split (09 §1): byte/ubyte/short/ushort/int/uint accumulate in the 32-bit `number` domain
 * (D uses an `int` accumulator for sub-int types, the type itself for int/uint); long/ulong/`time_t`
 * accumulate in the 64-bit `bigint` domain.
 */
export type ParseDigitsType = "byte" | "ubyte" | "short" | "ushort" | "int" | "uint" | "long" | "ulong";

interface ParseDigitsInfo {
    bigint: boolean; // 64-bit (bigint) accumulator vs 32-bit (number)
    signed: boolean; // signed-checked arithmetic (adds/muls) vs unsigned (addu/mulu)
    min: bigint; // T.min
    max: bigint; // T.max (default for the `max` parameter)
}

// T.sizeof < int.sizeof for byte/ubyte/short/ushort -> D accumulates in a signed `int` (adds/muls)
// regardless of T's own signedness (utils.d:166-171). int/uint/long/ulong use the type itself.
const PARSE_DIGITS_INFO: Record<ParseDigitsType, ParseDigitsInfo> = {
    byte: { bigint: false, signed: true, min: -0x80n, max: 0x7fn },
    ubyte: { bigint: false, signed: true, min: 0n, max: 0xffn },
    short: { bigint: false, signed: true, min: -0x8000n, max: 0x7fffn },
    ushort: { bigint: false, signed: true, min: 0n, max: 0xffffn },
    int: { bigint: false, signed: true, min: -0x8000_0000n, max: 0x7fff_ffffn },
    uint: { bigint: false, signed: false, min: 0n, max: 0xffff_ffffn },
    long: { bigint: true, signed: true, min: -0x8000_0000_0000_0000n, max: 0x7fff_ffff_ffff_ffffn },
    ulong: { bigint: true, signed: false, min: 0n, max: 0xffff_ffff_ffff_ffffn },
};

/** A mutable out/ref box for the `ref T val` parameter (03 §3.2/§3.3). `value` carries the parsed
 * result in the accumulator's domain (number for ≤32-bit T, bigint for 64-bit T). */
export interface ParseDigitsBox {
    value: number | bigint;
}

/**
 * Convert string to integer (utils.d:160). `@safe pure @nogc nothrow` erase (04 §8).
 *
 * Params:
 *  val = box receiving the result (`ref T val`, 03 §3.2). On overflow/non-digit input D still
 *        writes `cast(T)value`; the box ends with the wrapped/truncated value.
 *  p   = slice of digit characters (`const(char)[]` -> DString)
 *  T   = the concrete numeric type tag (replaces D's compile-time `T`)
 *  max = max allowable value (inclusive), defaults to `T.max` (utils.d:160)
 *
 * Returns: false on error (non-digit, overflow, or value > max), true on success.
 *
 * The checked-int semantics (core.checkedint adds/muls/addu/mulu, utils.d:163) are reproduced: the
 * op still yields the WRAPPED result on overflow and sets the overflow flag (verified ldc2:
 * `muls(int.max,10)` -> -10 + overflow; `mulu(ulong.max,10)` -> wraps + overflow). The final
 * `!overflow && value <= max` decides success.
 */
export function parseDigits(box: ParseDigitsBox, p: DString, T: ParseDigitsType, max?: bigint): boolean {
    const info = PARSE_DIGITS_INFO[T];
    const cap = max ?? info.max;

    if (info.bigint) {
        let value = 0n;
        let overflow = false;
        const min = info.min;
        const m = info.max;
        for (let i = 0; i < p.length; i++) {
            const c = p[i];
            if (c > 0x39 || c < 0x30) return false; // not a digit
            // mul(value, 10): bigint mul, then check/wrap to T's width (mulu vs muls semantics).
            value = value * 10n;
            value = value + BigInt(c - 0x30); // add(value, uint(c - '0'))
            const wrapped = wrapBigInt(value, info.signed, min, m);
            if (wrapped !== value) overflow = true;
            value = wrapped;
        }
        box.value = value; // val = cast(T) value (already wrapped to T's width)
        return !overflow && value <= cap;
    } else {
        // 32-bit accumulator. For byte/ubyte/short/ushort the accumulator is a signed `int`
        // (utils.d:166-171: `T.sizeof < int.sizeof` => `int value`, adds/muls), so use the 32-bit
        // SIGNED range. For uint the accumulator is `uint` (unsigned, addu/mulu). For int it is int.
        const subInt = T === "byte" || T === "ubyte" || T === "short" || T === "ushort";
        const signed = subInt ? true : info.signed; // sub-int -> int (signed)
        const min = signed ? -0x8000_0000n : 0n;
        const m = signed ? 0x7fff_ffffn : 0xffff_ffffn;
        let value = 0n; // accumulate in bigint then clamp to 32-bit, mirroring the i32/u32 checked op
        let overflow = false;
        for (let i = 0; i < p.length; i++) {
            const c = p[i];
            if (c > 0x39 || c < 0x30) return false; // not a digit
            value = value * 10n;
            value = value + BigInt(c - 0x30);
            const wrapped = wrapBigInt(value, signed, min, m);
            if (wrapped !== value) overflow = true;
            value = wrapped;
        }
        // val = cast(T) value — truncate the 32-bit accumulator to T's own width.
        box.value = Number(truncateToType(value, info));
        // the `value <= max` test is on the ACCUMULATOR value (the int/uint value), not cast(T).
        return !overflow && value <= cap;
    }
}

/// Wrap `v` to a width's two's-complement range [min, max] (the checked-int op's wrapped result).
function wrapBigInt(v: bigint, signed: boolean, min: bigint, max: bigint): bigint {
    if (v >= min && v <= max) return v;
    const bits = max === 0x7fffn || max === 0xffffn ? 16 : max === 0x7fff_ffffn || max === 0xffff_ffffn ? 32 : 64;
    return signed ? BigInt.asIntN(bits, v) : BigInt.asUintN(bits, v);
}

/// `cast(T) value` — truncate the accumulator to T's storage width (08 / 09 §2).
function truncateToType(value: bigint, info: ParseDigitsInfo): bigint {
    if (info.min === 0n) {
        // unsigned T
        if (info.max === 0xffn) return BigInt.asUintN(8, value);
        if (info.max === 0xffffn) return BigInt.asUintN(16, value);
        return BigInt.asUintN(32, value);
    }
    // signed T
    if (info.max === 0x7fn) return BigInt.asIntN(8, value);
    if (info.max === 0x7fffn) return BigInt.asIntN(16, value);
    return BigInt.asIntN(32, value);
}

/**
 * Cast a `ubyte[]` to an array of larger integers as if we are on a big endian architecture
 * (utils.d:240). `@safe` erases (04 §8).
 * Params:
 *   data = array with big endian data (a byte buffer -> DString)
 *   size = 1 for ubyte[], 2 for ushort[], 4 for uint[], 8 for ulong[]
 * Returns: copy of `data`, with bytes shuffled. resolved: version(LittleEndian) -> ON (target is
 * LE, _config.md §6), so the byte-shuffle ALWAYS runs (the `data.dup` size==1 case is the identity).
 *
 * The D `impl!T` template builds a `T[]` then casts it back to `ubyte[]` (the big-endian re-pack).
 * In the LE port we emit the resulting little-endian byte ordering directly: read `size` big-endian
 * bytes per element, store them little-endian (low byte first) — equivalent to D's
 * `cast(ubyte[]) (T[] built from BE bytes)` on an LE machine.
 */
export function arrayCastBigEndian(data: DString, size: number): DString {
    switch (size) {
        case 1:
            return data.slice(); // data.dup
        case 2:
            return impl(data, 2);
        case 4:
            return impl(data, 4);
        case 8:
            return impl(data, 8);
        default:
            return assertUnreachable("arrayCastBigEndian: size must be 1, 2, 4 or 8");
    }
}

/// The `impl!T` body (utils.d:242-253): for each `T`-sized group, assemble the value from big-endian
/// bytes (`data[i*sz + j] << ((sz-1-j)*8)`), then re-emit as the LE byte layout of that value.
function impl(data: DString, sz: number): DString {
    const count = Math.floor(data.length / sz);
    const out = new Uint8Array(count * sz);
    for (let i = 0; i < count; i++) {
        // result[i] = sum over j of T(data[i*sz + j]) << ((sz-1-j)*8)  -- big-endian assembly
        let val = 0n;
        for (let j = 0; j < sz; j++) {
            val |= BigInt(data[i * sz + j]) << BigInt((sz - 1 - j) * 8);
        }
        // cast(ubyte[]) result on an LE machine -> store `val` little-endian (low byte first)
        for (let j = 0; j < sz; j++) {
            out[i * sz + j] = Number((val >> BigInt(j * 8)) & 0xffn);
        }
    }
    return out;
}
