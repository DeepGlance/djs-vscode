// Hand-written djs runtime helper (not a 1:1 port of a single dmd/root file).
// Contract: docs/porting/10-tests-diagnostics.md §3.5 (the canonical home of printf formatting).
//
// WHY THIS MODULE EXISTS: DMD's `OutBuffer.vprintf` (dmd/common/outbuffer.d:564) and every
// `fprintf(stderr, …)` diagnostic delegate to the C library's `vsnprintf`. There is NO D-side
// format engine to port 1:1 — the canonical behavior IS C printf. This module re-implements the
// printf SUBSET the DMD frontend uses, byte-for-byte against the C library (verified `ldc2 -run`,
// /tmp/probe_fmt.d — every expected value in dmdformat.test.ts is pinned to that probe).
//
// BOUNDARY (CANON#2 / boundary-validation.md): callers pass a format `Uint8Array|string` and an
// `args: unknown[]`. The format string is the va_list contract; `args` ARE the variadic arguments
// (the C `va_list`/`va_start`/`va_end` plumbing erases — 04 §3.1). A specifier outside the
// supported table is a LOUD failure (`DError`), never a silent mis-format (10 §3.5).
//
// NUMERIC DOMAINS (09-numerics.md): %d/%i/%u/%x/%X/%o/%c/%zu consume a 32-/size_t-width value as a
// JS `number` OR `bigint`; %lld/%llu/%llo consume a 64-bit value as a `bigint` (but a `number` is
// accepted and widened). Internally every integer conversion runs in the `bigint` domain so the
// 64-bit forms and the unsigned wrap are exact. %f/%g/%e delegate to CTFloat (currently a
// STOP-stub) — guarded so every non-float specifier works regardless.
//
// NUL MODEL (CANON#4 / 02 §11): a DString C-string is the bytes BEFORE the first NUL. %s stops at
// the first NUL; %.*s prints up to `precision` bytes BUT stops at the first NUL inside that window
// (VERIFIED ldc2: snprintf("&%.*s;", 5, "quot\0xxxx") -> "&quot;").

import { DError } from "../../assert.js";
import { ds } from "../../dstring.js";
import type { DString } from "../../dstring.js";

// --- byte constants (ASCII) -----------------------------------------------------------------
const PERCENT = 0x25; // '%'
const STAR = 0x2a; // '*'
const DOT = 0x2e; // '.'
const ZERO = 0x30; // '0'
const NINE = 0x39; // '9'
const MINUS = 0x2d; // '-'
const PLUS = 0x2b; // '+'
const SPACE = 0x20; // ' '
const HASH = 0x23; // '#'
const NUL = 0x00; // '\0'

/**
 * A single parsed conversion's flags (C printf flag characters).
 *  - `minus`: left-justify within `width` (the `-` flag). Overrides `zero`.
 *  - `plus`:  always print a sign for signed conversions (the `+` flag). Overrides `space`.
 *  - `space`: print a leading space for non-negative signed conversions (the ` ` flag).
 *  - `zero`:  pad with `0` instead of spaces (the `0` flag). Ignored when `minus`, or when a
 *             precision is given to an integer conversion (C rule, verified).
 *  - `hash`:  alternate form (the `#` flag): `0x`/`0X` prefix for hex, leading `0` for octal.
 */
interface Flags {
    minus: boolean;
    plus: boolean;
    space: boolean;
    zero: boolean;
    hash: boolean;
}

/** Append the bytes of `s` to `out`. */
function emitBytes(out: number[], s: DString): void {
    for (let i = 0; i < s.length; i++) out.push(s[i]);
}

/** Append a Latin-1 JS string's bytes (digits/sign/prefix the formatter builds itself). */
function emitAscii(out: number[], s: string): void {
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff);
}

/**
 * Coerce a printf integer argument into the `bigint` domain. Accepts `number` (32-/size_t-width
 * args), `bigint` (the `%ll*` 64-bit args), or `boolean`. A non-integral `number` is a contract
 * violation — the format string promised an integer conversion (boundary-validation.md: fail loud).
 */
function toBig(v: unknown): bigint {
    if (typeof v === "bigint") return v;
    if (typeof v === "boolean") return v ? 1n : 0n;
    if (typeof v === "number") {
        if (!Number.isInteger(v)) {
            throw new DError(`dmdformat: integer specifier got a non-integral number ${v}`);
        }
        return BigInt(v);
    }
    throw new DError(`dmdformat: integer specifier got ${typeof v} (expected number|bigint)`);
}

/**
 * Render an unsigned integer `mag` (already non-negative) in `base`. `precision` is the explicit
 * conversion precision: a minimum digit count (zero-padded), or `-1` when ABSENT. Lowercase digits
 * unless `upper`.
 *
 * The one C special case (verified ldc2): an EXPLICIT precision of 0 applied to the value 0 yields
 * the EMPTY string (`%.0d`/`%.0x` of 0 -> ""). With NO precision (`-1`), the value 0 renders as the
 * single digit "0" (`%x`/`%#x`/`%d` of 0 -> "0") — so the absent/explicit-zero distinction is
 * load-bearing and `precision` MUST be threaded, not pre-collapsed to a default 0.
 */
function digitsOf(mag: bigint, base: bigint, upper: boolean, precision: number): string {
    let s = mag.toString(Number(base));
    if (upper) s = s.toUpperCase();
    if (precision === 0 && mag === 0n) return ""; // explicit `.0` of value 0 -> no digits
    if (precision > s.length) s = "0".repeat(precision - s.length) + s; // min-digits zero-pad
    return s;
}

/**
 * Pad `body` (already includes sign + alternate-prefix + digits) to `width` honoring the flags.
 * Left-justify (`-`) pads on the right with spaces. Otherwise pad on the left: with `0` between the
 * sign/prefix and the digits when the `0` flag is active, else with spaces before everything.
 *
 * `signLen` is the number of leading bytes (sign + `0x`/`0X` prefix) that must stay in front of any
 * zero-fill — so `%#08x` of 255 is `0x0000ff` (verified), not `00000xff`.
 */
function pad(out: number[], body: string, width: number, flags: Flags, signLen: number, zeroOk: boolean): void {
    const padCount = width - body.length;
    if (padCount <= 0) {
        emitAscii(out, body);
        return;
    }
    if (flags.minus) {
        emitAscii(out, body);
        for (let i = 0; i < padCount; i++) out.push(SPACE);
    } else if (flags.zero && zeroOk) {
        emitAscii(out, body.slice(0, signLen));
        for (let i = 0; i < padCount; i++) out.push(ZERO);
        emitAscii(out, body.slice(signLen));
    } else {
        for (let i = 0; i < padCount; i++) out.push(SPACE);
        emitAscii(out, body);
    }
}

/**
 * Space-only width padding for the conversions where the `0` flag never applies (`%s`, `%c` —
 * verified). Emits `width - contentLen` spaces before `emit()` (right-justify) or after it
 * (left-justify, the `-` flag). `emit` writes the already-truncated content bytes to `out`.
 */
function padSpaces(out: number[], contentLen: number, width: number, minus: boolean, emit: () => void): void {
    const n = width - contentLen;
    if (n > 0 && !minus) for (let k = 0; k < n; k++) out.push(SPACE);
    emit();
    if (n > 0 && minus) for (let k = 0; k < n; k++) out.push(SPACE);
}

/** Build the leading sign/space byte(s) for a signed conversion of `negative`/non-negative value. */
function signPrefix(negative: boolean, flags: Flags): string {
    if (negative) return "-";
    if (flags.plus) return "+";
    if (flags.space) return " ";
    return "";
}

/**
 * `dmdformat(fmt, args)` — format `fmt` with `args` using the C printf subset the DMD frontend
 * uses, returning the result as a `DString` (its raw bytes; NOT NUL-terminated).
 *
 * Supported specifiers (all verified `ldc2 -run`): `%s` (DString/string/C-string, NUL-aware),
 * `%.*s` (precision-bounded, NUL-stop), `%d %i %u %lld %llu` (decimal), `%x %X` (hex),
 * `%o %llo` (octal), `%c`, `%zu`, `%%`, with width / precision / flags (`-` `+` ` ` `0` `#`) and
 * the `%.*s` precision-arg form. `%f %g %e` delegate to CTFloat (a current STOP-stub) — they throw
 * `DError` rather than mis-render, and the guard means no other specifier is affected.
 *
 * Argument consumption is LEFT-TO-RIGHT in `args` (the va_list order): `*` width/precision and the
 * value each take the next arg. Cost: O(format length + output length), one final `Uint8Array`.
 */
export function dmdformat(fmt: Uint8Array | string, args: unknown[]): DString {
    const f: DString = typeof fmt === "string" ? ds(fmt) : fmt;
    const out: number[] = [];
    let ai = 0; // next-argument cursor (the va_list position)
    const n = f.length;
    let i = 0;

    const nextArg = (): unknown => {
        if (ai >= args.length) throw new DError(`dmdformat: not enough arguments for format`);
        return args[ai++];
    };

    while (i < n) {
        const c = f[i++];
        if (c !== PERCENT) {
            out.push(c);
            continue;
        }

        // --- parse flags -----------------------------------------------------------------
        const flags: Flags = { minus: false, plus: false, space: false, zero: false, hash: false };
        for (;;) {
            const d = f[i];
            if (d === MINUS) flags.minus = true;
            else if (d === PLUS) flags.plus = true;
            else if (d === SPACE) flags.space = true;
            else if (d === ZERO) flags.zero = true;
            else if (d === HASH) flags.hash = true;
            else break;
            i++;
        }

        // --- parse width (number or `*`) -------------------------------------------------
        let width = 0;
        if (f[i] === STAR) {
            i++;
            width = Number(toBig(nextArg()));
            if (width < 0) {
                // A negative `*` width means left-justify with |width| (C rule).
                flags.minus = true;
                width = -width;
            }
        } else {
            while (f[i] >= ZERO && f[i] <= NINE) {
                width = width * 10 + (f[i] - ZERO);
                i++;
            }
        }

        // --- parse precision (`.` then number or `*`); `-1` means "absent" ----------------
        let precision = -1;
        if (f[i] === DOT) {
            i++;
            precision = 0; // a bare `.` means precision 0
            if (f[i] === STAR) {
                i++;
                precision = Number(toBig(nextArg()));
                if (precision < 0) precision = -1; // a negative `*` precision is treated as absent (C)
            } else {
                while (f[i] >= ZERO && f[i] <= NINE) {
                    precision = precision * 10 + (f[i] - ZERO);
                    i++;
                }
            }
        }

        // --- skip length modifiers (l, ll, h, hh, z, j, t, L) — width is carried by the JS
        //     value's domain (number vs bigint), not by the modifier. We only NOTE whether a
        //     modifier was present; it does not change the JS-side conversion.
        while (
            f[i] === 0x6c /* l */ ||
            f[i] === 0x68 /* h */ ||
            f[i] === 0x7a /* z */ ||
            f[i] === 0x6a /* j */ ||
            f[i] === 0x74 /* t */ ||
            f[i] === 0x4c /* L */
        ) {
            i++;
        }

        if (i >= n) throw new DError(`dmdformat: truncated conversion at end of format`);
        const conv = f[i++]; // the conversion specifier letter (or '%')

        switch (conv) {
            case PERCENT:
                out.push(PERCENT);
                break;

            case 0x73 /* s */: {
                const v = nextArg();
                const bytes: DString = v instanceof Uint8Array ? v : ds(String(v));
                // C-string semantics: the logical string ends at the first NUL (CANON#4 / 02 §11).
                // %s ALWAYS stops at the first NUL; a precision bounds it further (max bytes), and
                // the NUL-stop applies WITHIN the precision window (%.*s verified: "quot\0" -> quot).
                const cap = precision >= 0 ? Math.min(precision, bytes.length) : bytes.length;
                let end = 0;
                while (end < cap && bytes[end] !== NUL) end++;
                const sBytes = bytes.subarray(0, end);
                // width padding (spaces only — the `0` flag does not apply to %s; verified %-10s/%10s).
                padSpaces(out, sBytes.length, width, flags.minus, () => emitBytes(out, sBytes));
                break;
            }

            case 0x63 /* c */: {
                // %c emits one byte. width padding applies (spaces); `0` flag does not (verified).
                const b = Number(toBig(nextArg())) & 0xff;
                padSpaces(out, 1, width, flags.minus, () => out.push(b));
                break;
            }

            case 0x64 /* d */:
            case 0x69 /* i */: {
                // signed decimal. precision = min digits; the `0` flag is ignored when a precision
                // is present (C rule, verified: `%8.5d` of 42 -> "   00042").
                const v = toBig(nextArg());
                const negative = v < 0n;
                const mag = negative ? -v : v;
                const body = signPrefix(negative, flags) + digitsOf(mag, 10n, false, precision);
                const signLen = negative || flags.plus || flags.space ? 1 : 0;
                pad(out, body, width, flags, signLen, precision < 0);
                break;
            }

            case 0x75 /* u */: {
                const v = toBig(nextArg());
                const body = digitsOf(v < 0n ? BigInt.asUintN(64, v) : v, 10n, false, precision);
                pad(out, body, width, flags, 0, precision < 0);
                break;
            }

            case 0x78 /* x */:
            case 0x58 /* X */: {
                const upper = conv === 0x58;
                const v = toBig(nextArg());
                const mag = v < 0n ? BigInt.asUintN(64, v) : v;
                let prefix = "";
                if (flags.hash && mag !== 0n) prefix = upper ? "0X" : "0x"; // alternate form (verified)
                const body = prefix + digitsOf(mag, 16n, upper, precision);
                pad(out, body, width, flags, prefix.length, precision < 0);
                break;
            }

            case 0x6f /* o */: {
                const v = toBig(nextArg());
                const mag = v < 0n ? BigInt.asUintN(64, v) : v;
                let digits = digitsOf(mag, 8n, false, precision);
                // alternate form: ensure the octal value starts with a leading '0' (verified %#o;
                // and %#.0o of 0 -> "0", where digitsOf returned "" and `#` supplies the lone 0).
                if (flags.hash && (digits.length === 0 || digits[0] !== "0")) digits = "0" + digits;
                pad(out, digits, width, flags, 0, precision < 0);
                break;
            }

            case 0x66 /* f */:
            case 0x46 /* F */:
            case 0x67 /* g */:
            case 0x47 /* G */:
            case 0x65 /* e */:
            case 0x45 /* E */:
            case 0x61 /* a */:
            case 0x41 /* A */:
                // %f/%g/%e/%a are C's own float conversions, a deferral (CANON#2). `CTFloat.sprint`
                // does not cover them: it is LDC's float-literal text ('g'/'a'/'A' with gen/ctfloat.cpp's
                // `.0` and `+` fixups), not vsnprintf. Throw here so the gap is loud — and so NO
                // non-float specifier is affected by the deferral (the guard is this isolated case).
                throw new DError(
                    `dmdformat: %${String.fromCharCode(conv)} float conversion is not ported (CTFloat.sprint ` +
                        `formats D float literals, not C vsnprintf). Documented deferral (CANON#2 / ` +
                        `08 §15.1). STOP and escalate (11-escalate.md).`,
                );

            default:
                // boundary-validation.md: a specifier outside the supported subset is a LOUD failure,
                // never a silent mis-format (10 §3.5). The byte may be non-printable, so show hex too.
                throw new DError(
                    `dmdformat: unsupported conversion %${String.fromCharCode(conv)} ` +
                        `(0x${conv.toString(16)}) — see 10 §3.5 / 11-escalate.md`,
                );
        }
    }

    return Uint8Array.from(out);
}
