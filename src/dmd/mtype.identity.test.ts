// GOAL TEST — protects the TYPE-IDENTITY KEYSTONE.
//
// The achievement under protection: a `Type` has exactly ONE canonical, interned instance per
// distinct byte-exact `deco` mangling, and that `deco` is byte-for-byte the string the real D ABI
// emits. This is the foundation the whole frontend leans on — `equals`, template matching, and the
// backend symbol mangler all assume "same type <=> same interned object <=> same deco bytes".
//
// This is an INTEGRATION test: it drives the live path
//     Type._init()  ->  Type.merge()  ->  mangleToBuffer (mangle/index.ts)  ->  tyToDecoBuffer
// across mtype.ts + mangle/index.ts + the IntegerExp dim carrier (expression.ts), exactly as the
// compiler does when it interns a type. It is NOT a unit test of any single function.
//
// GROUND TRUTH: every expected `deco` and every MATCH/common-type expectation below was produced by
// `ldc2-1.42.0 -run` of a tiny D program printing `.mangleof` / `typeof(?:).stringof` / `is(T:U)`
// — NOT guessed. Reproduce with:
//   <ldc2-1.42.0>/bin/ldc2 -run prog.d
// Verified outputs (the literal expected values asserted here):
//   int.mangleof              = "i"      (int*).mangleof          = "Pi"    (int**).mangleof = "PPi"
//   (const(int)).mangleof     = "xi"     (immutable(int)).mangleof= "yi"    (shared(int))    = "Oi"
//   (int[]).mangleof          = "Ai"     (int[4]).mangleof        = "G4i"   (const(int*))    = "xPi"
//   long.mangleof = "l"   char.mangleof = "a"   (char*).mangleof = "Pa"
//   is(int:long)=true & !is(int==long)  -> "convert"   ;  is(int==int) -> "exact"
//   is(int:short)=false                 -> "nomatch"   (narrowing not implicit)
//   typeof(true?int:long)  = long   typeof(true?int:uint) = uint   typeof(true?int:double) = double
//
// A regression in ANY of mtype.ts / mangle/index.ts / impcnvtab.ts (deco mangler, merge/interning,
// qualifier cross-linking, or the basic-type conversion table) trips one of these.

import { describe, it, expect } from "vitest";
import { Type, TypeBasic } from "./mtype.js";
import { TY, MATCH } from "./astenums.js";
import { implicitConvCommonTy, implicitConvTy1 } from "./impcnvtab.js";
import {
    merge, pointerTo, constOf, immutableOf, sharedOf, arrayOf, sarrayOf, makeConst, size, Type_init
} from "./typesem.js";
import { implicitConvToType } from "./dcast.js";

describe("type-identity keystone (ldc2-verified integration)", () => {
  // (a) DECO BYTE-EXACTNESS — the interned bytes equal the D ABI mangle, end-to-end through merge +
  // the mangler. Each `.deco` here is computed live (merge -> mangleToBuffer), not pre-stored.
  describe("(a) deco byte-exactness vs ldc2 .mangleof", () => {
    it("the basic int singleton and its merge() carry deco 'i'", () => {
      Type_init();
      expect(Type.tint32.deco).toBe("i"); // int.mangleof
      // merge() of an already-interned type is idempotent and returns the SAME bytes.
      expect(merge(Type.tint32).deco).toBe("i");
    });

    it("pointer/qualifier/array derivations mangle byte-exactly", () => {
      Type_init();
      expect(pointerTo(Type.tint32).deco).toBe("Pi");                 // (int*)        = "Pi"
      expect(pointerTo(pointerTo(Type.tint32)).deco).toBe("PPi");    // (int**)       = "PPi"
      expect(constOf(Type.tint32).deco).toBe("xi");                  // const(int)    = "xi"
      expect(immutableOf(Type.tint32).deco).toBe("yi");             // immutable(int) = "yi"
      expect(sharedOf(Type.tint32).deco).toBe("Oi");               // shared(int)    = "Oi"
      expect(arrayOf(Type.tint32).deco).toBe("Ai");               // (int[])        = "Ai"
      expect(sarrayOf(Type.tint32, 4n).deco).toBe("G4i");          // (int[4])       = "G4i"
      expect(constOf(pointerTo(Type.tint32)).deco).toBe("xPi"); // const(int*)    = "xPi"
    });

    it("other basic types mangle byte-exactly (long/char and char*)", () => {
      Type_init();
      expect(Type.tint64.deco).toBe("l");          // long.mangleof  = "l"
      expect(Type.tchar.deco).toBe("a");          // char.mangleof  = "a"
      expect(pointerTo(Type.tchar).deco).toBe("Pa"); // (char*)    = "Pa"
    });
  });

  // (b) MERGE INTERNING — identity is the whole point. The SAME logical type is the SAME object.
  describe("(b) merge interns: one canonical object per deco", () => {
    it("constOf()/pointerTo() called twice return the identical instance (cached)", () => {
      Type_init();
      const c1 = constOf(Type.tint32);
      const c2 = constOf(Type.tint32);
      expect(c2).toBe(c1); // cached in mcache.cto — Object.is identity, not just deco-equality

      const p1 = pointerTo(Type.tint32);
      const p2 = pointerTo(Type.tint32);
      expect(p2).toBe(p1); // cached in mcache.pto
    });

    it("two INDEPENDENTLY built const(int) types merge to the one canonical instance", () => {
      Type_init();
      // Build const(int) from scratch (a fresh TypeBasic, not the singleton), then intern via merge.
      // The interning table must collapse it onto the SAME object the singleton's constOf() yields —
      // that collapse IS the type-identity guarantee.
      const freshConstInt = merge(makeConst(new TypeBasic(TY.Tint32)));
      expect(freshConstInt.deco).toBe("xi");                  // same bytes as ldc2 const(int)
      expect(freshConstInt).toBe(constOf(Type.tint32));      // SAME interned object (identity)
      expect(freshConstInt.equals(constOf(Type.tint32))).toBe(true);
    });

    it("distinct types do NOT collapse (int != uint, int != const int)", () => {
      Type_init();
      expect(Type.tint32.equals(Type.tuns32)).toBe(false);
      expect(Type.tint32.equals(constOf(Type.tint32))).toBe(false);
      expect(Type.tint32).not.toBe(constOf(Type.tint32));
    });
  });

  // (c) IMPLICIT CONVERSION (basic types) — verified against ldc2.
  //
  // SCOPE NOTE (verified, not assumed): the per-pair `TypeBasic.implicitConvTo` MATCH (dcast.d:1528
  // `visitBasic`, a `TFlags`/`Type.size()` algorithm) is now PORTED — as a `Type.implicitConvTo(to)`
  // method (base = dcast.d:1517 visitType identity rule, override on TypeBasic) backed by a faithful
  // `TypeBasic.size()` (typesem.d:1616 visitBasic, `real`=64-bit so the 80-bit arms resolve to 8/16).
  // The `impcnvtab` table still feeds the COMMON-TYPE computation (typeMerge), a SEPARATE concern from
  // the per-pair MATCH — both are tested below against the same ldc2 ground truth.
  describe("(c) basic-type conversion table (impcnvtab) vs ldc2", () => {
    it("implicitConvCommonTy mirrors ldc2's ?: common type", () => {
      // typeof(true ? int : int)    = int    (exact, same type)
      expect(implicitConvCommonTy(TY.Tint32, TY.Tint32)).toBe(TY.Tint32);
      // typeof(true ? int : long)   = long   (int widens to long)
      expect(implicitConvCommonTy(TY.Tint32, TY.Tint64)).toBe(TY.Tint64);
      // typeof(true ? int : uint)   = uint
      expect(implicitConvCommonTy(TY.Tint32, TY.Tuns32)).toBe(TY.Tuns32);
      // typeof(true ? int : double) = double
      expect(implicitConvCommonTy(TY.Tint32, TY.Tfloat64)).toBe(TY.Tfloat64);
    });

    it("implicitConvTy1: which type operand-1 (int) converts to, to reach the common type", () => {
      // int paired with long -> int's operand becomes long.
      expect(implicitConvTy1(TY.Tint32, TY.Tint64)).toBe(TY.Tint64);
      // int paired with int -> stays int.
      expect(implicitConvTy1(TY.Tint32, TY.Tint32)).toBe(TY.Tint32);
    });

    // GUARD (now live): the per-pair `TypeBasic.implicitConvTo` MATCH, asserted directly against
    // ldc2 ground truth (`__traits(compiles, {T x = u;})` probes, all run on this target). Note the
    // asymmetry: integral->integral REJECTS narrowing (size-checked), but floating->floating NEVER
    // rejects (double->float is `convert`, matching `float x = someDouble;` compiling) — the dcast.d
    // floating arm checks only real/imaginary/complex class, not size.
    it("TypeBasic.implicitConvTo: per-pair MATCH mirrors ldc2", () => {
      Type_init();
      const tb = (ty: TY): TypeBasic => Type.basic[ty] as TypeBasic;
      // exact: identical singleton
      expect(implicitConvToType(tb(TY.Tint32), tb(TY.Tint32))).toBe(MATCH.exact);
      // convert: widening / same-size signedness change / int->float / any real<->real
      expect(implicitConvToType(tb(TY.Tint32), tb(TY.Tint64))).toBe(MATCH.convert); // int   -> long
      expect(implicitConvToType(tb(TY.Tint32), tb(TY.Tuns32))).toBe(MATCH.convert); // int   -> uint (same size)
      expect(implicitConvToType(tb(TY.Tint16), tb(TY.Tint32))).toBe(MATCH.convert); // short -> int
      expect(implicitConvToType(tb(TY.Tint32), tb(TY.Tfloat32))).toBe(MATCH.convert); // int  -> float
      expect(implicitConvToType(tb(TY.Tfloat32), tb(TY.Tfloat64))).toBe(MATCH.convert); // float  -> double
      expect(implicitConvToType(tb(TY.Tfloat64), tb(TY.Tfloat32))).toBe(MATCH.convert); // double -> float (no narrow-reject)
      expect(implicitConvToType(tb(TY.Tint32), tb(TY.Tfloat64))).toBe(MATCH.convert); // int  -> double
      // nomatch: narrowing integral, float->int, anything->bool, real<->imaginary
      expect(implicitConvToType(tb(TY.Tint32), tb(TY.Tint16))).toBe(MATCH.nomatch); // int   -> short
      expect(implicitConvToType(tb(TY.Tint64), tb(TY.Tint32))).toBe(MATCH.nomatch); // long  -> int
      expect(implicitConvToType(tb(TY.Tfloat32), tb(TY.Tint32))).toBe(MATCH.nomatch); // float -> int
      expect(implicitConvToType(tb(TY.Tint32), tb(TY.Tbool))).toBe(MATCH.nomatch);  // int   -> bool
      expect(implicitConvToType(tb(TY.Tfloat32), tb(TY.Timaginary32))).toBe(MATCH.nomatch); // float -> ifloat
    });

    // GUARD: TypeBasic.size() — the byte sizes the MATCH rule compares (ldc2: int=4, long=8, short=2,
    // byte=1, real=8 on this 64-bit-real target, cent/creal=16).
    it("TypeBasic.size(): byte sizes match ldc2 (.sizeof) on this target", () => {
      Type_init();
      const tb = (ty: TY): TypeBasic => Type.basic[ty] as TypeBasic;
      expect(size(tb(TY.Tint8))).toBe(1n);
      expect(size(tb(TY.Tint16))).toBe(2n);
      expect(size(tb(TY.Tint32))).toBe(4n);
      expect(size(tb(TY.Tint64))).toBe(8n);
      expect(size(tb(TY.Tfloat80))).toBe(8n);  // real is 64-bit on this target
      expect(size(tb(TY.Tint128))).toBe(16n);
      expect(size(tb(TY.Tcomplex80))).toBe(16n);
    });

    it("MATCH ordinals match the D frontend enum (exact > constant > convert > nomatch)", () => {
      // dcast.d MATCH: nomatch=0, convert=1, constant=2, exact=3. The future implicitConvTo guard
      // depends on these ordinals; pin them here so a reorder is caught immediately.
      expect(MATCH.nomatch).toBe(0);
      expect(MATCH.convert).toBe(1);
      expect(MATCH.constant).toBe(2);
      expect(MATCH.exact).toBe(3);
    });
  });
});
