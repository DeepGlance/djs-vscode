/**
 * Defines the building blocks for creating the mangled names for basic types.
 *
 * Copyright:   Copyright (C) 1999-2025 by The D Language Foundation, All Rights Reserved
 * License:     $(LINK2 https://www.boost.org/LICENSE_1_0.txt, Boost License 1.0)
 * Source:      $(LINK2 https://github.com/dlang/dmd/blob/master/compiler/src/dmd/mangle/basic.d, _basicmangle.d)
 * Documentation:  https://dlang.org/phobos/dmd_basicmangle.html
 * Coverage:    https://codecov.io/gh/dlang/dmd/src/master/compiler/src/dmd/mangle/basic.d
 */
// module dmd.mangle.basic;

import {
    TMAX,
    Tchar,
    Tbool,
    Tcomplex80,
    Tfloat64,
    Tfloat80,
    Tfloat32,
    Tint8,
    Tuns8,
    Tint32,
    Timaginary80,
    Tuns32,
    Tint64,
    Tuns64,
    Tnull,
    Timaginary32,
    Timaginary64,
    Tcomplex32,
    Tcomplex64,
    Tint16,
    Tuns16,
    Twchar,
    Tvoid,
    Tdchar,
    Tint128,
    Tuns128,
    Tarray,
    Ttuple,
    Tclass,
    Tdelegate,
    Tenum,
    Tfunction,
    Tsarray,
    Taarray,
    Tpointer,
    Treference,
    Tstruct,
    Tnone,
    Tident,
    Tinstance,
    Terror,
    Ttypeof,
    Tslice,
    Treturn,
    Tvector,
    Ttraits,
    Tmixin,
    Ttag,
    Tnoreturn,
} from "../astenums.js";
import type { OutBuffer } from "../common/outbuffer.js";

// `immutable char[TMAX] mangleChar` (basic.d:16) is a fixed-length VALUE byte array
// (02-types.md §7), indexed by the TY enum value (`int ty`). D's designated initializer
// fills each slot by enum index; any slot left unassigned would default to `char.init`
// (0xFF, verified ldc2 /tmp/probe_charinit.d) — the unittest below exists precisely to
// assert no slot is left unfilled. We build the array length TMAX (pre-filled 0xFF =
// char.init so an accidentally-missing slot reproduces D's char.init, not `undefined`),
// then assign by enum-indexed symbol exactly as the D literal does.
/// Type mangling mapping for basic, derived and user defined types
export const mangleChar: number[] = new Array(TMAX).fill(0xff);
mangleChar[Tchar] = "a".charCodeAt(0);
mangleChar[Tbool] = "b".charCodeAt(0);
mangleChar[Tcomplex80] = "c".charCodeAt(0);
mangleChar[Tfloat64] = "d".charCodeAt(0);
mangleChar[Tfloat80] = "e".charCodeAt(0);
mangleChar[Tfloat32] = "f".charCodeAt(0);
mangleChar[Tint8] = "g".charCodeAt(0);
mangleChar[Tuns8] = "h".charCodeAt(0);
mangleChar[Tint32] = "i".charCodeAt(0);
mangleChar[Timaginary80] = "j".charCodeAt(0);
mangleChar[Tuns32] = "k".charCodeAt(0);
mangleChar[Tint64] = "l".charCodeAt(0);
mangleChar[Tuns64] = "m".charCodeAt(0);
mangleChar[Tnull] = "n".charCodeAt(0);
mangleChar[Timaginary32] = "o".charCodeAt(0);
mangleChar[Timaginary64] = "p".charCodeAt(0);
mangleChar[Tcomplex32] = "q".charCodeAt(0);
mangleChar[Tcomplex64] = "r".charCodeAt(0);
mangleChar[Tint16] = "s".charCodeAt(0);
mangleChar[Tuns16] = "t".charCodeAt(0);
mangleChar[Twchar] = "u".charCodeAt(0);
mangleChar[Tvoid] = "v".charCodeAt(0);
mangleChar[Tdchar] = "w".charCodeAt(0);
//                  x   // const
//                  y   // immutable
mangleChar[Tint128] = "z".charCodeAt(0); // zi
mangleChar[Tuns128] = "z".charCodeAt(0); // zk

mangleChar[Tarray] = "A".charCodeAt(0);
mangleChar[Ttuple] = "B".charCodeAt(0);
mangleChar[Tclass] = "C".charCodeAt(0);
mangleChar[Tdelegate] = "D".charCodeAt(0);
mangleChar[Tenum] = "E".charCodeAt(0);
mangleChar[Tfunction] = "F".charCodeAt(0); // D function
mangleChar[Tsarray] = "G".charCodeAt(0);
mangleChar[Taarray] = "H".charCodeAt(0);
//                  I   // in
//                  J   // out
//                  K   // ref
//                  L   // lazy
//                  M   // has this, or scope
//                  N   // Nh:vector Ng:wild Nn:noreturn
//                  O   // shared
mangleChar[Tpointer] = "P".charCodeAt(0);
//                  Q   // Type/symbol/identifier backward reference
mangleChar[Treference] = "R".charCodeAt(0);
mangleChar[Tstruct] = "S".charCodeAt(0);
//                  T   // Ttypedef
//                  U   // C function
//                  W   // Windows function
//                  X   // variadic T t...)
//                  Y   // variadic T t,...)
//                  Z   // not variadic, end of parameters

// '@' shouldn't appear anywhere in the deco'd names
mangleChar[Tnone] = "@".charCodeAt(0);
mangleChar[Tident] = "@".charCodeAt(0);
mangleChar[Tinstance] = "@".charCodeAt(0);
mangleChar[Terror] = "@".charCodeAt(0);
mangleChar[Ttypeof] = "@".charCodeAt(0);
mangleChar[Tslice] = "@".charCodeAt(0);
mangleChar[Treturn] = "@".charCodeAt(0);
mangleChar[Tvector] = "@".charCodeAt(0);
mangleChar[Ttraits] = "@".charCodeAt(0);
mangleChar[Tmixin] = "@".charCodeAt(0);
mangleChar[Ttag] = "@".charCodeAt(0);
mangleChar[Tnoreturn] = "@".charCodeAt(0); // becomes 'Nn'

/***********************
 * Mangle basic type ty to buf.
 */
export function tyToDecoBuffer(buf: OutBuffer, ty: number): void {
    const c = mangleChar[ty];
    buf.writeByte(c);
    if (c === "z".charCodeAt(0))
        buf.writeByte(ty === Tint128 ? "i".charCodeAt(0) : "k".charCodeAt(0));
}
