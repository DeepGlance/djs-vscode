// Ported from dmd/common/charactertables.d (module dmd.common.charactertables).
//
// Character tables related to identifiers. Supports UAX31, C99, C11 and least restrictive (All).
// Used by the lexer/identifier code to classify identifier-start/continue characters and the
// number/string lexing character maps (octal/hex/idchar/...).
//
// Copyright: Copyright (C) 1999-2025 by The D Language Foundation, All Rights Reserved.
// License:   Boost License 1.0.
//
// D module attributes erased per 04-functions.md §8:
//   `@safe nothrow @nogc pure:` and `extern(C++):` carry no observable contract in TS.
//
// Numeric domain (09-numerics.md): `dchar` and `char` are code points / code units in the
// `number` domain. The `cmtable` is a `ubyte[256]` -> Uint8Array(256), indexed by a 0..255 char.
//
// VERIFIED against ldc2-1.42.0 (DMD v2.112.1) via /tmp/probe_chartab.d and /tmp/probe_range2.d:
//   - 'ğ' == code point 287; isAnyIdentifierCharacter/isAnyStart/isAnyContinue('ğ') == true.
//   - cmtable sample bytes: '0'=0x3f, '8'=0x3e, 'a'=0x26, 'x'=0x2c, '_'=0x3c, '.'=0x38,
//     0=0x00, '\\'=0x00, 0x80=0x00, ' '=0x20, 'A'=0x26.
//   - UAX31 isStart: ASCII letters/digits NOT in the table (returns false); 0xAA returns true.

import type { CharRangeTable } from "./identifiertables.js";
import {
    UAX31_Start,
    UAX31_Continue,
    FixedTable_C99_Start,
    FixedTable_C99_Continue,
    FixedTable_C11_Start,
    FixedTable_C11_Continue,
    LeastRestrictive_Start,
    LeastRestrictive_Continue,
    LeastRestrictive_OfAll,
} from "./identifiertables.js";
import { assert, SwitchError } from "../../assert.js";

///
export enum IdentifierTable {
    UAX31, ///
    C99, ///
    C11, ///
    LR, /// Least Restrictive aka All
}

///
export class IdentifierCharLookup {
    // D `struct IdentifierCharLookup` -> TS class (value type, 02-types.md §2). Its two members
    // are `bool function(dchar)` code pointers (no `this` capture, 04-functions.md §4.4) ->
    // `(c: number) => boolean`. The original lambdas close over a fixed range table; here they
    // call `isInRange(table, c)` with the table passed as a runtime argument (the D `alias Ranges`
    // template parameter, monomorphized away — see note on `isInRange` below).

    ///
    isStart: (c: number) => boolean;
    ///
    isContinue: (c: number) => boolean;

    constructor(isStart: (c: number) => boolean, isContinue: (c: number) => boolean) {
        this.isStart = isStart;
        this.isContinue = isContinue;
    }

    // Value-struct copy (03-value-semantics.md §2): both fields are immutable function values
    // (code pointers); copy shares the reference like a class-ref/pointer field.
    copy(): IdentifierCharLookup {
        return new IdentifierCharLookup(this.isStart, this.isContinue);
    }

    /// Lookup the table given the table name
    static forTable(table: IdentifierTable): IdentifierCharLookup {
        // resolved: import dmd.common.identifiertables -> top-level import (tables are module data)
        //
        // Awful solution to require these lambdas.
        // However without them the extern(C++) ABI issues crop up for isInRange,
        //  and then it can't access the tables.
        // (The extern(C++) ABI rationale is moot in TS; the lambdas are kept faithfully.)
        switch (table) {
            case IdentifierTable.UAX31:
                return new IdentifierCharLookup(
                    (c) => isInRange(UAX31_Start, c),
                    (c) => isInRange(UAX31_Continue, c));
            case IdentifierTable.C99:
                return new IdentifierCharLookup(
                    (c) => isInRange(FixedTable_C99_Start, c),
                    (c) => isInRange(FixedTable_C99_Continue, c));
            case IdentifierTable.C11:
                return new IdentifierCharLookup(
                    (c) => isInRange(FixedTable_C11_Start, c),
                    (c) => isInRange(FixedTable_C11_Continue, c));
            case IdentifierTable.LR:
                return new IdentifierCharLookup(
                    (c) => isInRange(LeastRestrictive_Start, c),
                    (c) => isInRange(LeastRestrictive_Continue, c));
            default: {
                // D `final switch` exhaustiveness (06-control-flow.md §3.2).
                const _e: never = table;
                throw new SwitchError(_e);
            }
        }
    }
}

/**
Convenience function for use in places where we just don't care,
what the identifier ranges are, or if it is start/continue.

Returns: is character a member of least restrictive of all.
*/
export function isAnyIdentifierCharacter(c: number): boolean {
    return isInRange(LeastRestrictive_OfAll, c);
}

/**
Convenience function for use in places where we just don't care,
what the identifier ranges are.

Returns: is character a member of restrictive Start
*/
export function isAnyStart(c: number): boolean {
    return isInRange(LeastRestrictive_Start, c);
}

/**
Convenience function for use in places where we just don't care,
what the identifier ranges are.

Returns: is character a member of least restrictive Continue
*/
export function isAnyContinue(c: number): boolean {
    return isInRange(LeastRestrictive_Continue, c);
}

/// UTF line separator
export const LS = 0x2028;
/// UTF paragraph separator
export const PS = 0x2029;

// private { ... } manifest enums -> module-private const bit flags (02-types.md §4.1).
const CMoctal = 0x1;
const CMhex = 0x2;
const CMidchar = 0x4;
const CMzerosecond = 0x8;
const CMdigitsecond = 0x10;
const CMsinglechar = 0x20;

///
export function isoctal(c: number): boolean {
    return (cmtable[c] & CMoctal) !== 0;
}

///
export function ishex(c: number): boolean {
    return (cmtable[c] & CMhex) !== 0;
}

///
export function isidchar(c: number): boolean {
    return (cmtable[c] & CMidchar) !== 0;
}

///
export function isZeroSecond(c: number): boolean {
    return (cmtable[c] & CMzerosecond) !== 0;
}

///
export function isDigitSecond(c: number): boolean {
    return (cmtable[c] & CMdigitsecond) !== 0;
}

///
export function issinglechar(c: number): boolean {
    return (cmtable[c] & CMsinglechar) !== 0;
}

///
export function c_isxdigit(c: number): boolean {
    return ((c >= /*'0'*/ 0x30 && c <= /*'9'*/ 0x39) ||
        (c >= /*'a'*/ 0x61 && c <= /*'f'*/ 0x66) ||
        (c >= /*'A'*/ 0x41 && c <= /*'F'*/ 0x46));
}

///
export function c_isalnum(c: number): boolean {
    return ((c >= /*'0'*/ 0x30 && c <= /*'9'*/ 0x39) ||
        (c >= /*'a'*/ 0x61 && c <= /*'z'*/ 0x7a) ||
        (c >= /*'A'*/ 0x41 && c <= /*'Z'*/ 0x5a));
}

///
export function isAlphaASCII(c: number): boolean {
    return ((c >= /*'a'*/ 0x61 && c <= /*'z'*/ 0x7a) ||
        (c >= /*'A'*/ 0x41 && c <= /*'Z'*/ 0x5a));
}

// extern(D) private: — the binary-search helper + the char-map table below are module-private.

// originally from dmd.root.utf
//
// D template `bool isInRange(alias Ranges)(dchar c)`: the `alias Ranges` is a compile-time
// table selector. There are 9 instantiations across this module (UAX31_Start/Continue, the two
// Fixed tables, LeastRestrictive_*). Rather than monomorphize into 9 functions, the table is
// passed as an ordinary parameter `Ranges: CharRangeTable` — the call sites are the only
// consumers and each supplies its concrete table (02-types.md §5.1 the alias is data, not type).
//
// Domain (09-numerics.md): `high`/`low`/`mid` are `size_t` indices in the `number` domain. The
// `mid - 1` / `high + 1` arithmetic stays within array index range (the loop terminates before
// underflow is observed, matching D's unsigned `size_t` loop). `c` is a `dchar` (number).
function isInRange(Ranges: CharRangeTable, c: number): boolean {
    let high: number = Ranges.length - 1;
    // Shortcut search if c is out of range
    let low: number = (c < Ranges[0][0] || Ranges[high][1] < c) ? high + 1 : 0;
    // Binary search
    while (low <= high) {
        const mid: number = low + ((high - low) >> 1);
        if (c < Ranges[mid][0])
            high = mid - 1;
        else if (Ranges[mid][1] < c)
            low = mid + 1;
        else {
            assert(Ranges[mid][0] <= c && c <= Ranges[mid][1]);
            return true;
        }
    }
    return false;
}

/********************************************
 * Do our own char maps
 */
// originally from dmd.lexer (was private)
//
// D: `static immutable cmtable = () { ubyte[256] table; ...; return table; }();`
// A module-load-time CTFE-built table. Ported as an IIFE producing a Uint8Array(256), mirroring
// the D initializer's loop and switch statements faithfully. `table[c] |= flag` accumulates bits.
// VERIFIED byte-for-byte against ldc2 (/tmp/probe_chartab.d) for the sampled indices.
const cmtable: Uint8Array = (() => {
    const table = new Uint8Array(256);
    for (let c = 0; c < table.length; c++) {
        if (/*'0'*/ 0x30 <= c && c <= /*'7'*/ 0x37)
            table[c] |= CMoctal;
        if (c_isxdigit(c))
            table[c] |= CMhex;
        if (c_isalnum(c) || c === /*'_'*/ 0x5f)
            table[c] |= CMidchar;

        switch (c) {
            case /*'x'*/ 0x78: case /*'X'*/ 0x58:
            case /*'b'*/ 0x62: case /*'B'*/ 0x42:
                table[c] |= CMzerosecond;
                break;

            // case '0': .. case '9': — D inclusive case range (06-control-flow.md §3.5)
            case 0x30: case 0x31: case 0x32: case 0x33: case 0x34:
            case 0x35: case 0x36: case 0x37: case 0x38: case 0x39:
            case /*'e'*/ 0x65: case /*'E'*/ 0x45:
            case /*'f'*/ 0x66: case /*'F'*/ 0x46:
            case /*'l'*/ 0x6c: case /*'L'*/ 0x4c:
            case /*'p'*/ 0x70: case /*'P'*/ 0x50:
            case /*'u'*/ 0x75: case /*'U'*/ 0x55:
            case /*'i'*/ 0x69:
            case /*'.'*/ 0x2e:
            case /*'_'*/ 0x5f:
                table[c] |= CMzerosecond | CMdigitsecond;
                break;

            default:
                break;
        }

        switch (c) {
            case /*'\\'*/ 0x5c:
            case /*'\n'*/ 0x0a:
            case /*'\r'*/ 0x0d:
            case 0:
            case 0x1A:
            case /*'\''*/ 0x27:
                break;
            default:
                if (!(c & 0x80))
                    table[c] |= CMsinglechar;
                break;
        }
    }
    return table;
})();
