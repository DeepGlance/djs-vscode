// GOAL TEST — protects the basic-type arm of `typeSemantic` (typesem.d:1919, the `default ->
// visitType` path). The achievement: running semantic on an already-canonical basic type returns the
// SAME interned singleton (idempotent), with its `deco` set; and the obsolete `cent`/`ucent` types
// are rejected to `Type.terror` with the verbatim DMD diagnostic.
//
// GROUND TRUTH (ldc2): `int.mangleof == "i"`, `long.mangleof == "l"`; `cent`/`ucent` are a hard error
// ("`cent` and `ucent` types are obsolete, use `core.int128.Cent` instead", dmd/typesem.d:1934). The
// basic path ignores `sc` (no resolution needed), so a placeholder scope is passed.

import { describe, it, expect, beforeEach } from "vitest";
import { Type } from "./mtype.js";
import { typeSemantic, Type_init } from "./typesem.js";
import { TY } from "./astenums.js";
import { Loc } from "./location.js";
import { global } from "./globals.js";
import { ErrorSinkNull } from "./errorsink.js";
import type { Scope } from "./dscope.js";

const noScope = null as unknown as Scope; // the basic-type arm never reads `sc`

describe("typeSemantic — basic-type arm (typesem.d default -> visitType)", () => {
  beforeEach(() => {
    Loc._init();
    Type_init();
    // `error(...)` (the cent/ucent diagnostic) reads global.errorSink + bumps global.errors.
    global.errorSink = new ErrorSinkNull();
    global.errors = 0;
  });

  it("returns the SAME interned singleton for a canonical basic type (idempotent)", () => {
    // typeSemantic(int) === int (merge() of an already-merged type returns the interned instance).
    expect(typeSemantic(Type.tint32, Loc.initial, noScope)).toBe(Type.tint32);
    expect(typeSemantic(Type.tint64, Loc.initial, noScope)).toBe(Type.tint64);
    expect(typeSemantic(Type.tfloat64, Loc.initial, noScope)).toBe(Type.tfloat64);
    // the resolved type carries its interned deco (ldc2: int.mangleof == "i", long == "l").
    expect(typeSemantic(Type.tint32, Loc.initial, noScope).deco).toBe("i");
    expect(typeSemantic(Type.tint64, Loc.initial, noScope).deco).toBe("l");
    expect(global.errors).toBe(0);
  });

  it("rejects obsolete cent/ucent to Type.terror with a diagnostic", () => {
    // gag the (verbatim, byte-exact) diagnostic print; `global.errors` is still bumped per emission so
    // we assert the count, not the stderr text.
    global.gag = 1;
    try {
      expect(typeSemantic(Type.tint128, Loc.initial, noScope)).toBe(Type.terror); // cent
      expect(typeSemantic(Type.tuns128, Loc.initial, noScope)).toBe(Type.terror); // ucent
      expect(global.errors).toBe(2); // one diagnostic per rejected type
    } finally {
      global.gag = 0;
    }
  });

  it("a freshly-merged basic type still resolves to the canonical singleton", () => {
    // resolving the canonical instance is the contract; identity is by interned `deco`.
    const r = typeSemantic(Type.tchar, Loc.initial, noScope);
    expect(r.ty).toBe(TY.Tchar);
    expect(r).toBe(Type.tchar);
  });
});
