// Ported from dmd/impcnvtab.d (module dmd.impcnvtab).
//
// Provides an implicit conversion table for BASIC types, used to determine integer promotions and
// common types (D spec: Integer Promotions / Usual Arithmetic Conversions).
//
// SCOPE (bounded — task: "keep it bounded to the table + lookup"): this module owns ONLY the two
// `TY[TMAX][TMAX]` tables (`impcnvResultTab`, `impcnvType1Tab`) and the two lookups over them
// (`implicitConvCommonTy`, `implicitConvTy1`). The D source builds the tables at compile time via the
// CTFE function `generateImpCnvTab()`; we run the same construction once at module load (the table is
// `__gshared` immutable data — building it eagerly is the faithful, side-effect-free equivalent).
//
// NOTE ON `TypeBasic.implicitConvTo`: the task asked to "wire TypeBasic.implicitConvTo to use it".
// On verification (dcast.d:1528 `implicitConvTo`'s `visitBasic`), the real `TypeBasic.implicitConvTo`
// does NOT consult these tables — it is a `TFlags`/`size()`-based algorithm in dcast.d (a free
// function, not a Type method), and it depends on `Type.size()` which is out of scope this phase.
// These impcnvtab tables are consumed by the COMMON-TYPE computation (`typeMerge`, dcast.d:3453),
// not by the per-pair `implicitConvTo` MATCH. So this module ports the table + lookups faithfully;
// `TypeBasic.implicitConvTo` is left to the dcast.d port (it needs `size()`), and is NOT wired to a
// table it does not in fact use. (Wiring it to this table would be a wrong-but-plausible miscompile.)

import { TY, TMAX } from "./astenums.js";

/*************************************************
 * dmd/impcnvtab.d:33 — If ty1 and ty2 are basic types, return the TY that both can be implicitly
 * converted to. Returns `Terror` if there is no common basic type.
 */
export function implicitConvCommonTy(ty1: TY, ty2: TY): TY {
  return impcnvResultTab[ty1][ty2];
}

/*************************************************
 * dmd/impcnvtab.d:50 — If ty1 and ty2 are basic types, return the TY that ty1 should be converted to
 * to bring both to a common ty. Symmetric (operands may be swapped). Returns `Terror` if none.
 */
export function implicitConvTy1(ty1: TY, ty2: TY): TY {
  return impcnvType1Tab[ty1][ty2];
}

/******************************************************************************/

// dmd/impcnvtab.d:60 — `struct ImpCnvTab { TY[TMAX][TMAX] impcnvResultTab; TY[TMAX][TMAX]
// impcnvType1Tab; }`. The two `TMAX×TMAX` matrices, built once below (the D `enum impCnvTab =
// generateImpCnvTab()` CTFE constant). Module-private; only the two exported lookups read them.
const impcnvResultTab: TY[][] = makeTable();
const impcnvType1Tab: TY[][] = makeTable();

// allocate a TMAX×TMAX matrix pre-filled with Terror (dmd/impcnvtab.d:115-122 initializer loop).
function makeTable(): TY[][] {
  const tab: TY[][] = new Array<TY[]>(TMAX);
  for (let i = 0; i < TMAX; i++)
    tab[i] = new Array<TY>(TMAX).fill(TY.Terror);
  return tab;
}

// dmd/impcnvtab.d:124 — `void X(TY t1, TY t2, TY nt1, TY nt2, TY rt)`: set the symmetric result and
// the per-operand type-1 entries for the (t1,t2) pair (and its transpose).
function X(t1: TY, t2: TY, nt1: TY, nt2: TY, rt: TY): void {
  impcnvResultTab[t1][t2] = rt;
  impcnvResultTab[t2][t1] = rt;

  impcnvType1Tab[t1][t2] = nt1;
  impcnvType1Tab[t2][t1] = nt2;
}

// dmd/impcnvtab.d:64 — `ImpCnvTab generateImpCnvTab()`. The body below mirrors the D function 1:1
// (each `X(...)` row in declaration order). Wrapped in an IIFE-style block so the table is filled at
// load before the first lookup. `typeTYs` (the full TY list) is needed only for the final
// noreturn fan-out (dmd/impcnvtab.d:339).
{
  const typeTYs: TY[] = [
    TY.Tarray, TY.Tsarray, TY.Taarray, TY.Tpointer, TY.Treference, TY.Tfunction, TY.Tident,
    TY.Tclass, TY.Tstruct, TY.Tenum, TY.Tdelegate, TY.Tnone, TY.Tvoid, TY.Tint8, TY.Tuns8,
    TY.Tint16, TY.Tuns16, TY.Tint32, TY.Tuns32, TY.Tint64, TY.Tuns64, TY.Tfloat32, TY.Tfloat64,
    TY.Tfloat80, TY.Timaginary32, TY.Timaginary64, TY.Timaginary80, TY.Tcomplex32, TY.Tcomplex64,
    TY.Tcomplex80, TY.Tbool, TY.Tchar, TY.Twchar, TY.Tdchar, TY.Terror, TY.Tinstance, TY.Ttypeof,
    TY.Ttuple, TY.Tslice, TY.Treturn, TY.Tnull, TY.Tvector, TY.Tint128, TY.Tuns128, TY.Ttraits,
    TY.Tmixin, TY.Tnoreturn, TY.Ttag,
  ];

  /* ======================= */

  X(TY.Tbool, TY.Tbool,   TY.Tbool, TY.Tbool,    TY.Tbool);
  X(TY.Tbool, TY.Tint8,   TY.Tint32, TY.Tint32,  TY.Tint32);
  X(TY.Tbool, TY.Tuns8,   TY.Tint32, TY.Tint32,  TY.Tint32);
  X(TY.Tbool, TY.Tint16,  TY.Tint32, TY.Tint32,  TY.Tint32);
  X(TY.Tbool, TY.Tuns16,  TY.Tint32, TY.Tint32,  TY.Tint32);
  X(TY.Tbool, TY.Tint32,  TY.Tint32, TY.Tint32,  TY.Tint32);
  X(TY.Tbool, TY.Tuns32,  TY.Tuns32, TY.Tuns32,  TY.Tuns32);
  X(TY.Tbool, TY.Tint64,  TY.Tint64, TY.Tint64,  TY.Tint64);
  X(TY.Tbool, TY.Tuns64,  TY.Tuns64, TY.Tuns64,  TY.Tuns64);
  X(TY.Tbool, TY.Tint128, TY.Tint128, TY.Tint128, TY.Tint128);
  X(TY.Tbool, TY.Tuns128, TY.Tuns128, TY.Tuns128, TY.Tuns128);

  X(TY.Tbool, TY.Tfloat32,     TY.Tfloat32, TY.Tfloat32,     TY.Tfloat32);
  X(TY.Tbool, TY.Tfloat64,     TY.Tfloat64, TY.Tfloat64,     TY.Tfloat64);
  X(TY.Tbool, TY.Tfloat80,     TY.Tfloat80, TY.Tfloat80,     TY.Tfloat80);
  X(TY.Tbool, TY.Timaginary32, TY.Tfloat32, TY.Timaginary32, TY.Tfloat32);
  X(TY.Tbool, TY.Timaginary64, TY.Tfloat64, TY.Timaginary64, TY.Tfloat64);
  X(TY.Tbool, TY.Timaginary80, TY.Tfloat80, TY.Timaginary80, TY.Tfloat80);
  X(TY.Tbool, TY.Tcomplex32,   TY.Tfloat32, TY.Tcomplex32,   TY.Tcomplex32);
  X(TY.Tbool, TY.Tcomplex64,   TY.Tfloat64, TY.Tcomplex64,   TY.Tcomplex64);
  X(TY.Tbool, TY.Tcomplex80,   TY.Tfloat80, TY.Tcomplex80,   TY.Tcomplex80);

  /* ======================= */

  X(TY.Tint8, TY.Tint8,   TY.Tint32, TY.Tint32,  TY.Tint32);
  X(TY.Tint8, TY.Tuns8,   TY.Tint32, TY.Tint32,  TY.Tint32);
  X(TY.Tint8, TY.Tint16,  TY.Tint32, TY.Tint32,  TY.Tint32);
  X(TY.Tint8, TY.Tuns16,  TY.Tint32, TY.Tint32,  TY.Tint32);
  X(TY.Tint8, TY.Tint32,  TY.Tint32, TY.Tint32,  TY.Tint32);
  X(TY.Tint8, TY.Tuns32,  TY.Tuns32, TY.Tuns32,  TY.Tuns32);
  X(TY.Tint8, TY.Tint64,  TY.Tint64, TY.Tint64,  TY.Tint64);
  X(TY.Tint8, TY.Tuns64,  TY.Tuns64, TY.Tuns64,  TY.Tuns64);
  X(TY.Tint8, TY.Tint128, TY.Tint128, TY.Tint128, TY.Tint128);
  X(TY.Tint8, TY.Tuns128, TY.Tuns128, TY.Tuns128, TY.Tuns128);

  X(TY.Tint8, TY.Tfloat32,     TY.Tfloat32, TY.Tfloat32,     TY.Tfloat32);
  X(TY.Tint8, TY.Tfloat64,     TY.Tfloat64, TY.Tfloat64,     TY.Tfloat64);
  X(TY.Tint8, TY.Tfloat80,     TY.Tfloat80, TY.Tfloat80,     TY.Tfloat80);
  X(TY.Tint8, TY.Timaginary32, TY.Tfloat32, TY.Timaginary32, TY.Tfloat32);
  X(TY.Tint8, TY.Timaginary64, TY.Tfloat64, TY.Timaginary64, TY.Tfloat64);
  X(TY.Tint8, TY.Timaginary80, TY.Tfloat80, TY.Timaginary80, TY.Tfloat80);
  X(TY.Tint8, TY.Tcomplex32,   TY.Tfloat32, TY.Tcomplex32,   TY.Tcomplex32);
  X(TY.Tint8, TY.Tcomplex64,   TY.Tfloat64, TY.Tcomplex64,   TY.Tcomplex64);
  X(TY.Tint8, TY.Tcomplex80,   TY.Tfloat80, TY.Tcomplex80,   TY.Tcomplex80);

  /* ======================= */

  X(TY.Tuns8, TY.Tuns8,   TY.Tint32, TY.Tint32,  TY.Tint32);
  X(TY.Tuns8, TY.Tint16,  TY.Tint32, TY.Tint32,  TY.Tint32);
  X(TY.Tuns8, TY.Tuns16,  TY.Tint32, TY.Tint32,  TY.Tint32);
  X(TY.Tuns8, TY.Tint32,  TY.Tint32, TY.Tint32,  TY.Tint32);
  X(TY.Tuns8, TY.Tuns32,  TY.Tuns32, TY.Tuns32,  TY.Tuns32);
  X(TY.Tuns8, TY.Tint64,  TY.Tint64, TY.Tint64,  TY.Tint64);
  X(TY.Tuns8, TY.Tuns64,  TY.Tuns64, TY.Tuns64,  TY.Tuns64);
  X(TY.Tuns8, TY.Tint128, TY.Tint128, TY.Tint128, TY.Tint128);
  X(TY.Tuns8, TY.Tuns128, TY.Tuns128, TY.Tuns128, TY.Tuns128);

  X(TY.Tuns8, TY.Tfloat32,     TY.Tfloat32, TY.Tfloat32,     TY.Tfloat32);
  X(TY.Tuns8, TY.Tfloat64,     TY.Tfloat64, TY.Tfloat64,     TY.Tfloat64);
  X(TY.Tuns8, TY.Tfloat80,     TY.Tfloat80, TY.Tfloat80,     TY.Tfloat80);
  X(TY.Tuns8, TY.Timaginary32, TY.Tfloat32, TY.Timaginary32, TY.Tfloat32);
  X(TY.Tuns8, TY.Timaginary64, TY.Tfloat64, TY.Timaginary64, TY.Tfloat64);
  X(TY.Tuns8, TY.Timaginary80, TY.Tfloat80, TY.Timaginary80, TY.Tfloat80);
  X(TY.Tuns8, TY.Tcomplex32,   TY.Tfloat32, TY.Tcomplex32,   TY.Tcomplex32);
  X(TY.Tuns8, TY.Tcomplex64,   TY.Tfloat64, TY.Tcomplex64,   TY.Tcomplex64);
  X(TY.Tuns8, TY.Tcomplex80,   TY.Tfloat80, TY.Tcomplex80,   TY.Tcomplex80);

  /* ======================= */

  X(TY.Tint16, TY.Tint16,  TY.Tint32, TY.Tint32,  TY.Tint32);
  X(TY.Tint16, TY.Tuns16,  TY.Tint32, TY.Tint32,  TY.Tint32);
  X(TY.Tint16, TY.Tint32,  TY.Tint32, TY.Tint32,  TY.Tint32);
  X(TY.Tint16, TY.Tuns32,  TY.Tuns32, TY.Tuns32,  TY.Tuns32);
  X(TY.Tint16, TY.Tint64,  TY.Tint64, TY.Tint64,  TY.Tint64);
  X(TY.Tint16, TY.Tuns64,  TY.Tuns64, TY.Tuns64,  TY.Tuns64);
  X(TY.Tint16, TY.Tint128, TY.Tint128, TY.Tint128, TY.Tint128);
  X(TY.Tint16, TY.Tuns128, TY.Tuns128, TY.Tuns128, TY.Tuns128);

  X(TY.Tint16, TY.Tfloat32,     TY.Tfloat32, TY.Tfloat32,     TY.Tfloat32);
  X(TY.Tint16, TY.Tfloat64,     TY.Tfloat64, TY.Tfloat64,     TY.Tfloat64);
  X(TY.Tint16, TY.Tfloat80,     TY.Tfloat80, TY.Tfloat80,     TY.Tfloat80);
  X(TY.Tint16, TY.Timaginary32, TY.Tfloat32, TY.Timaginary32, TY.Tfloat32);
  X(TY.Tint16, TY.Timaginary64, TY.Tfloat64, TY.Timaginary64, TY.Tfloat64);
  X(TY.Tint16, TY.Timaginary80, TY.Tfloat80, TY.Timaginary80, TY.Tfloat80);
  X(TY.Tint16, TY.Tcomplex32,   TY.Tfloat32, TY.Tcomplex32,   TY.Tcomplex32);
  X(TY.Tint16, TY.Tcomplex64,   TY.Tfloat64, TY.Tcomplex64,   TY.Tcomplex64);
  X(TY.Tint16, TY.Tcomplex80,   TY.Tfloat80, TY.Tcomplex80,   TY.Tcomplex80);

  /* ======================= */

  X(TY.Tuns16, TY.Tuns16,  TY.Tint32, TY.Tint32,  TY.Tint32);
  X(TY.Tuns16, TY.Tint32,  TY.Tint32, TY.Tint32,  TY.Tint32);
  X(TY.Tuns16, TY.Tuns32,  TY.Tuns32, TY.Tuns32,  TY.Tuns32);
  X(TY.Tuns16, TY.Tint64,  TY.Tint64, TY.Tint64,  TY.Tint64);
  X(TY.Tuns16, TY.Tuns64,  TY.Tuns64, TY.Tuns64,  TY.Tuns64);
  X(TY.Tuns16, TY.Tint128, TY.Tint128, TY.Tint128, TY.Tint128);
  X(TY.Tuns16, TY.Tuns128, TY.Tuns128, TY.Tuns128, TY.Tuns128);

  X(TY.Tuns16, TY.Tfloat32,     TY.Tfloat32, TY.Tfloat32,     TY.Tfloat32);
  X(TY.Tuns16, TY.Tfloat64,     TY.Tfloat64, TY.Tfloat64,     TY.Tfloat64);
  X(TY.Tuns16, TY.Tfloat80,     TY.Tfloat80, TY.Tfloat80,     TY.Tfloat80);
  X(TY.Tuns16, TY.Timaginary32, TY.Tfloat32, TY.Timaginary32, TY.Tfloat32);
  X(TY.Tuns16, TY.Timaginary64, TY.Tfloat64, TY.Timaginary64, TY.Tfloat64);
  X(TY.Tuns16, TY.Timaginary80, TY.Tfloat80, TY.Timaginary80, TY.Tfloat80);
  X(TY.Tuns16, TY.Tcomplex32,   TY.Tfloat32, TY.Tcomplex32,   TY.Tcomplex32);
  X(TY.Tuns16, TY.Tcomplex64,   TY.Tfloat64, TY.Tcomplex64,   TY.Tcomplex64);
  X(TY.Tuns16, TY.Tcomplex80,   TY.Tfloat80, TY.Tcomplex80,   TY.Tcomplex80);

  /* ======================= */

  X(TY.Tint32, TY.Tint32,  TY.Tint32, TY.Tint32,  TY.Tint32);
  X(TY.Tint32, TY.Tuns32,  TY.Tuns32, TY.Tuns32,  TY.Tuns32);
  X(TY.Tint32, TY.Tint64,  TY.Tint64, TY.Tint64,  TY.Tint64);
  X(TY.Tint32, TY.Tuns64,  TY.Tuns64, TY.Tuns64,  TY.Tuns64);
  X(TY.Tint32, TY.Tint128, TY.Tint128, TY.Tint128, TY.Tint128);
  X(TY.Tint32, TY.Tuns128, TY.Tuns128, TY.Tuns128, TY.Tuns128);

  X(TY.Tint32, TY.Tfloat32,     TY.Tfloat32, TY.Tfloat32,     TY.Tfloat32);
  X(TY.Tint32, TY.Tfloat64,     TY.Tfloat64, TY.Tfloat64,     TY.Tfloat64);
  X(TY.Tint32, TY.Tfloat80,     TY.Tfloat80, TY.Tfloat80,     TY.Tfloat80);
  X(TY.Tint32, TY.Timaginary32, TY.Tfloat32, TY.Timaginary32, TY.Tfloat32);
  X(TY.Tint32, TY.Timaginary64, TY.Tfloat64, TY.Timaginary64, TY.Tfloat64);
  X(TY.Tint32, TY.Timaginary80, TY.Tfloat80, TY.Timaginary80, TY.Tfloat80);
  X(TY.Tint32, TY.Tcomplex32,   TY.Tfloat32, TY.Tcomplex32,   TY.Tcomplex32);
  X(TY.Tint32, TY.Tcomplex64,   TY.Tfloat64, TY.Tcomplex64,   TY.Tcomplex64);
  X(TY.Tint32, TY.Tcomplex80,   TY.Tfloat80, TY.Tcomplex80,   TY.Tcomplex80);

  /* ======================= */

  X(TY.Tuns32, TY.Tuns32,  TY.Tuns32, TY.Tuns32,  TY.Tuns32);
  X(TY.Tuns32, TY.Tint64,  TY.Tint64, TY.Tint64,  TY.Tint64);
  X(TY.Tuns32, TY.Tuns64,  TY.Tuns64, TY.Tuns64,  TY.Tuns64);
  X(TY.Tuns32, TY.Tint128, TY.Tint128, TY.Tint128, TY.Tint128);
  X(TY.Tuns32, TY.Tuns128, TY.Tuns128, TY.Tuns128, TY.Tuns128);

  X(TY.Tuns32, TY.Tfloat32,     TY.Tfloat32, TY.Tfloat32,     TY.Tfloat32);
  X(TY.Tuns32, TY.Tfloat64,     TY.Tfloat64, TY.Tfloat64,     TY.Tfloat64);
  X(TY.Tuns32, TY.Tfloat80,     TY.Tfloat80, TY.Tfloat80,     TY.Tfloat80);
  X(TY.Tuns32, TY.Timaginary32, TY.Tfloat32, TY.Timaginary32, TY.Tfloat32);
  X(TY.Tuns32, TY.Timaginary64, TY.Tfloat64, TY.Timaginary64, TY.Tfloat64);
  X(TY.Tuns32, TY.Timaginary80, TY.Tfloat80, TY.Timaginary80, TY.Tfloat80);
  X(TY.Tuns32, TY.Tcomplex32,   TY.Tfloat32, TY.Tcomplex32,   TY.Tcomplex32);
  X(TY.Tuns32, TY.Tcomplex64,   TY.Tfloat64, TY.Tcomplex64,   TY.Tcomplex64);
  X(TY.Tuns32, TY.Tcomplex80,   TY.Tfloat80, TY.Tcomplex80,   TY.Tcomplex80);

  /* ======================= */

  X(TY.Tint64, TY.Tint64,  TY.Tint64, TY.Tint64,  TY.Tint64);
  X(TY.Tint64, TY.Tuns64,  TY.Tuns64, TY.Tuns64,  TY.Tuns64);
  X(TY.Tint64, TY.Tint128, TY.Tint128, TY.Tint128, TY.Tint128);
  X(TY.Tint64, TY.Tuns128, TY.Tuns128, TY.Tuns128, TY.Tuns128);

  X(TY.Tint64, TY.Tfloat32,     TY.Tfloat32, TY.Tfloat32,     TY.Tfloat32);
  X(TY.Tint64, TY.Tfloat64,     TY.Tfloat64, TY.Tfloat64,     TY.Tfloat64);
  X(TY.Tint64, TY.Tfloat80,     TY.Tfloat80, TY.Tfloat80,     TY.Tfloat80);
  X(TY.Tint64, TY.Timaginary32, TY.Tfloat32, TY.Timaginary32, TY.Tfloat32);
  X(TY.Tint64, TY.Timaginary64, TY.Tfloat64, TY.Timaginary64, TY.Tfloat64);
  X(TY.Tint64, TY.Timaginary80, TY.Tfloat80, TY.Timaginary80, TY.Tfloat80);
  X(TY.Tint64, TY.Tcomplex32,   TY.Tfloat32, TY.Tcomplex32,   TY.Tcomplex32);
  X(TY.Tint64, TY.Tcomplex64,   TY.Tfloat64, TY.Tcomplex64,   TY.Tcomplex64);
  X(TY.Tint64, TY.Tcomplex80,   TY.Tfloat80, TY.Tcomplex80,   TY.Tcomplex80);

  /* ======================= */

  X(TY.Tuns64, TY.Tuns64,  TY.Tuns64, TY.Tuns64,  TY.Tuns64);
  X(TY.Tuns64, TY.Tint128, TY.Tint128, TY.Tint128, TY.Tint128);
  X(TY.Tuns64, TY.Tuns128, TY.Tuns128, TY.Tuns128, TY.Tuns128);

  X(TY.Tuns64, TY.Tfloat32,     TY.Tfloat32, TY.Tfloat32,     TY.Tfloat32);
  X(TY.Tuns64, TY.Tfloat64,     TY.Tfloat64, TY.Tfloat64,     TY.Tfloat64);
  X(TY.Tuns64, TY.Tfloat80,     TY.Tfloat80, TY.Tfloat80,     TY.Tfloat80);
  X(TY.Tuns64, TY.Timaginary32, TY.Tfloat32, TY.Timaginary32, TY.Tfloat32);
  X(TY.Tuns64, TY.Timaginary64, TY.Tfloat64, TY.Timaginary64, TY.Tfloat64);
  X(TY.Tuns64, TY.Timaginary80, TY.Tfloat80, TY.Timaginary80, TY.Tfloat80);
  X(TY.Tuns64, TY.Tcomplex32,   TY.Tfloat32, TY.Tcomplex32,   TY.Tcomplex32);
  X(TY.Tuns64, TY.Tcomplex64,   TY.Tfloat64, TY.Tcomplex64,   TY.Tcomplex64);
  X(TY.Tuns64, TY.Tcomplex80,   TY.Tfloat80, TY.Tcomplex80,   TY.Tcomplex80);

  /* ======================= */

  X(TY.Tint128, TY.Tint128, TY.Tint128, TY.Tint128, TY.Tint128);
  X(TY.Tint128, TY.Tuns128, TY.Tuns128, TY.Tuns128, TY.Tuns128);

  X(TY.Tint128, TY.Tfloat32,     TY.Tfloat32, TY.Tfloat32,     TY.Tfloat32);
  X(TY.Tint128, TY.Tfloat64,     TY.Tfloat64, TY.Tfloat64,     TY.Tfloat64);
  X(TY.Tint128, TY.Tfloat80,     TY.Tfloat80, TY.Tfloat80,     TY.Tfloat80);
  X(TY.Tint128, TY.Timaginary32, TY.Tfloat32, TY.Timaginary32, TY.Tfloat32);
  X(TY.Tint128, TY.Timaginary64, TY.Tfloat64, TY.Timaginary64, TY.Tfloat64);
  X(TY.Tint128, TY.Timaginary80, TY.Tfloat80, TY.Timaginary80, TY.Tfloat80);
  X(TY.Tint128, TY.Tcomplex32,   TY.Tfloat32, TY.Tcomplex32,   TY.Tcomplex32);
  X(TY.Tint128, TY.Tcomplex64,   TY.Tfloat64, TY.Tcomplex64,   TY.Tcomplex64);
  X(TY.Tint128, TY.Tcomplex80,   TY.Tfloat80, TY.Tcomplex80,   TY.Tcomplex80);

  /* ======================= */

  X(TY.Tuns128, TY.Tuns128, TY.Tuns128, TY.Tuns128, TY.Tuns128);

  X(TY.Tuns128, TY.Tfloat32,     TY.Tfloat32, TY.Tfloat32,     TY.Tfloat32);
  X(TY.Tuns128, TY.Tfloat64,     TY.Tfloat64, TY.Tfloat64,     TY.Tfloat64);
  X(TY.Tuns128, TY.Tfloat80,     TY.Tfloat80, TY.Tfloat80,     TY.Tfloat80);
  X(TY.Tuns128, TY.Timaginary32, TY.Tfloat32, TY.Timaginary32, TY.Tfloat32);
  X(TY.Tuns128, TY.Timaginary64, TY.Tfloat64, TY.Timaginary64, TY.Tfloat64);
  X(TY.Tuns128, TY.Timaginary80, TY.Tfloat80, TY.Timaginary80, TY.Tfloat80);
  X(TY.Tuns128, TY.Tcomplex32,   TY.Tfloat32, TY.Tcomplex32,   TY.Tcomplex32);
  X(TY.Tuns128, TY.Tcomplex64,   TY.Tfloat64, TY.Tcomplex64,   TY.Tcomplex64);
  X(TY.Tuns128, TY.Tcomplex80,   TY.Tfloat80, TY.Tcomplex80,   TY.Tcomplex80);

  /* ======================= */

  X(TY.Tfloat32, TY.Tfloat32, TY.Tfloat32, TY.Tfloat32, TY.Tfloat32);
  X(TY.Tfloat32, TY.Tfloat64, TY.Tfloat64, TY.Tfloat64, TY.Tfloat64);
  X(TY.Tfloat32, TY.Tfloat80, TY.Tfloat80, TY.Tfloat80, TY.Tfloat80);

  X(TY.Tfloat32, TY.Timaginary32, TY.Tfloat32, TY.Timaginary32, TY.Tfloat32);
  X(TY.Tfloat32, TY.Timaginary64, TY.Tfloat64, TY.Timaginary64, TY.Tfloat64);
  X(TY.Tfloat32, TY.Timaginary80, TY.Tfloat80, TY.Timaginary80, TY.Tfloat80);

  X(TY.Tfloat32, TY.Tcomplex32, TY.Tfloat32, TY.Tcomplex32, TY.Tcomplex32);
  X(TY.Tfloat32, TY.Tcomplex64, TY.Tfloat64, TY.Tcomplex64, TY.Tcomplex64);
  X(TY.Tfloat32, TY.Tcomplex80, TY.Tfloat80, TY.Tcomplex80, TY.Tcomplex80);

  /* ======================= */

  X(TY.Tfloat64, TY.Tfloat64, TY.Tfloat64, TY.Tfloat64, TY.Tfloat64);
  X(TY.Tfloat64, TY.Tfloat80, TY.Tfloat80, TY.Tfloat80, TY.Tfloat80);

  X(TY.Tfloat64, TY.Timaginary32, TY.Tfloat64, TY.Timaginary64, TY.Tfloat64);
  X(TY.Tfloat64, TY.Timaginary64, TY.Tfloat64, TY.Timaginary64, TY.Tfloat64);
  X(TY.Tfloat64, TY.Timaginary80, TY.Tfloat80, TY.Timaginary80, TY.Tfloat80);

  X(TY.Tfloat64, TY.Tcomplex32, TY.Tfloat64, TY.Tcomplex64, TY.Tcomplex64);
  X(TY.Tfloat64, TY.Tcomplex64, TY.Tfloat64, TY.Tcomplex64, TY.Tcomplex64);
  X(TY.Tfloat64, TY.Tcomplex80, TY.Tfloat80, TY.Tcomplex80, TY.Tcomplex80);

  /* ======================= */

  X(TY.Tfloat80, TY.Tfloat80, TY.Tfloat80, TY.Tfloat80, TY.Tfloat80);

  X(TY.Tfloat80, TY.Timaginary32, TY.Tfloat80, TY.Timaginary80, TY.Tfloat80);
  X(TY.Tfloat80, TY.Timaginary64, TY.Tfloat80, TY.Timaginary80, TY.Tfloat80);
  X(TY.Tfloat80, TY.Timaginary80, TY.Tfloat80, TY.Timaginary80, TY.Tfloat80);

  X(TY.Tfloat80, TY.Tcomplex32, TY.Tfloat80, TY.Tcomplex80, TY.Tcomplex80);
  X(TY.Tfloat80, TY.Tcomplex64, TY.Tfloat80, TY.Tcomplex80, TY.Tcomplex80);
  X(TY.Tfloat80, TY.Tcomplex80, TY.Tfloat80, TY.Tcomplex80, TY.Tcomplex80);

  /* ======================= */

  X(TY.Timaginary32, TY.Timaginary32, TY.Timaginary32, TY.Timaginary32, TY.Timaginary32);
  X(TY.Timaginary32, TY.Timaginary64, TY.Timaginary64, TY.Timaginary64, TY.Timaginary64);
  X(TY.Timaginary32, TY.Timaginary80, TY.Timaginary80, TY.Timaginary80, TY.Timaginary80);

  X(TY.Timaginary32, TY.Tcomplex32, TY.Timaginary32, TY.Tcomplex32, TY.Tcomplex32);
  X(TY.Timaginary32, TY.Tcomplex64, TY.Timaginary64, TY.Tcomplex64, TY.Tcomplex64);
  X(TY.Timaginary32, TY.Tcomplex80, TY.Timaginary80, TY.Tcomplex80, TY.Tcomplex80);

  /* ======================= */

  X(TY.Timaginary64, TY.Timaginary64, TY.Timaginary64, TY.Timaginary64, TY.Timaginary64);
  X(TY.Timaginary64, TY.Timaginary80, TY.Timaginary80, TY.Timaginary80, TY.Timaginary80);

  X(TY.Timaginary64, TY.Tcomplex32, TY.Timaginary64, TY.Tcomplex64, TY.Tcomplex64);
  X(TY.Timaginary64, TY.Tcomplex64, TY.Timaginary64, TY.Tcomplex64, TY.Tcomplex64);
  X(TY.Timaginary64, TY.Tcomplex80, TY.Timaginary80, TY.Tcomplex80, TY.Tcomplex80);

  /* ======================= */

  X(TY.Timaginary80, TY.Timaginary80, TY.Timaginary80, TY.Timaginary80, TY.Timaginary80);

  X(TY.Timaginary80, TY.Tcomplex32, TY.Timaginary80, TY.Tcomplex80, TY.Tcomplex80);
  X(TY.Timaginary80, TY.Tcomplex64, TY.Timaginary80, TY.Tcomplex80, TY.Tcomplex80);
  X(TY.Timaginary80, TY.Tcomplex80, TY.Timaginary80, TY.Tcomplex80, TY.Tcomplex80);

  /* ======================= */

  X(TY.Tcomplex32, TY.Tcomplex32, TY.Tcomplex32, TY.Tcomplex32, TY.Tcomplex32);
  X(TY.Tcomplex32, TY.Tcomplex64, TY.Tcomplex64, TY.Tcomplex64, TY.Tcomplex64);
  X(TY.Tcomplex32, TY.Tcomplex80, TY.Tcomplex80, TY.Tcomplex80, TY.Tcomplex80);

  /* ======================= */

  X(TY.Tcomplex64, TY.Tcomplex64, TY.Tcomplex64, TY.Tcomplex64, TY.Tcomplex64);
  X(TY.Tcomplex64, TY.Tcomplex80, TY.Tcomplex80, TY.Tcomplex80, TY.Tcomplex80);

  /* ======================= */

  X(TY.Tcomplex80, TY.Tcomplex80, TY.Tcomplex80, TY.Tcomplex80, TY.Tcomplex80);

  // dmd/impcnvtab.d:338 — "No type is implicitly convertible to noreturn, but noreturn is implicitly
  // convertible to every other type".
  for (const convertToTy of typeTYs)
    X(TY.Tnoreturn, convertToTy, convertToTy, convertToTy, convertToTy);
}
