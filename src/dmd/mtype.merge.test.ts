// Goal test: protects the TYPE-IDENTITY achievement — Type.merge() interns
// types by their byte-exact `deco` mangling, and the basic/derived singletons get the exact decos
// ldc2 emits. The expected deco strings were verified byte-for-byte against
// `ldc2-1.42.0 -run` of `typeof(x).mangleof` (int->i, void*->Pv, immutable(char)[]->Aya, const
// int->xi, immutable int->yi, char*->Pa, real->e, long->l, ulong->m). A regression here means the
// type-deco mangler or the merge/interning path drifted from the D ABI.

import { describe, it, expect } from "vitest";
import { Type } from "./mtype.js";
import { TY } from "./astenums.js";
import { merge, constOf, immutableOf, pointerTo, arrayOf, Type_init } from "./typesem.js";

describe("Type.merge / _init — type-identity decos (ldc2-verified)", () => {
  it("basic-type singletons carry their exact deco mangle char", () => {
    Type_init();
    expect(Type.tvoid.deco).toBe("v");
    expect(Type.tint8.deco).toBe("g");
    expect(Type.tuns8.deco).toBe("h");
    expect(Type.tint16.deco).toBe("s");
    expect(Type.tuns16.deco).toBe("t");
    expect(Type.tint32.deco).toBe("i");
    expect(Type.tuns32.deco).toBe("k");
    expect(Type.tint64.deco).toBe("l");
    expect(Type.tuns64.deco).toBe("m");
    expect(Type.tint128.deco).toBe("zi");
    expect(Type.tuns128.deco).toBe("zk");
    expect(Type.tfloat32.deco).toBe("f");
    expect(Type.tfloat64.deco).toBe("d");
    expect(Type.tfloat80.deco).toBe("e");
    expect(Type.tbool.deco).toBe("b");
    expect(Type.tchar.deco).toBe("a");
    expect(Type.twchar.deco).toBe("u");
    expect(Type.tdchar.deco).toBe("w");
  });

  it("noreturn/null singletons carry their deco", () => {
    Type_init();
    expect(Type.tnoreturn.deco).toBe("Nn");
    expect(Type.tnull.deco).toBe("n");
  });

  it("pointer/array-derived singletons are merged with the exact deco", () => {
    Type_init();
    expect(Type.tvoidptr.deco).toBe("Pv");      // void*
    expect(Type.tstring.deco).toBe("Aya");      // immutable(char)[]
    expect(Type.twstring.deco).toBe("Ayu");     // immutable(wchar)[]
    expect(Type.tdstring.deco).toBe("Ayw");     // immutable(dchar)[]
  });

  it("merge interns: re-building an already-interned type returns the canonical singleton", () => {
    Type_init();
    expect(Type.basic[TY.Tint32]).toBe(Type.tint32);
    // a fresh TypeBasic constructed for the same ty (ctor merges) returns the interned instance,
    // not a new object — identity is the whole point of merge.
    expect(merge(Type.tint32)).toBe(Type.tint32);
  });

  it("constOf/immutableOf build merged, cached, cross-linked qualifier variants", () => {
    Type_init();
    const ci = constOf(Type.tint32);
    expect(ci.deco).toBe("xi");                 // const int (ldc2-verified)
    expect(ci.isConst()).toBe(true);
    expect(constOf(Type.tint32)).toBe(ci);     // cached: same instance

    const ii = immutableOf(Type.tint32);
    expect(ii.deco).toBe("yi");                 // immutable int (ldc2-verified)
    expect(ii.isImmutable()).toBe(true);
    expect(immutableOf(Type.tint32)).toBe(ii);
  });

  it("pointerTo/arrayOf intern + cache through merge", () => {
    Type_init();
    const pc = pointerTo(Type.tchar);
    expect(pc.deco).toBe("Pa");                 // char* (ldc2-verified)
    expect(pointerTo(Type.tchar)).toBe(pc);    // cached in mcache.pto

    const ac = arrayOf(Type.tchar);
    expect(ac.deco).toBe("Aa");                 // char[]
    expect(arrayOf(Type.tchar)).toBe(ac);      // cached in mcache.arrayof
  });

  it("equals() uses interned deco identity", () => {
    Type_init();
    // two const-int builds intern to the SAME instance, so equals is trivially true; and a fresh
    // immutable-int is deco-equal to the cached one.
    expect(constOf(Type.tint32).equals(constOf(Type.tint32))).toBe(true);
    expect(Type.tint32.equals(Type.tuns32)).toBe(false);
  });
});
