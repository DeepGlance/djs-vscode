// GOAL TEST — protects the runtime-live parts of the numeric conversion core (dcast.ts) for the
// literals-&-arithmetic rung.
//
// What is live this rung: `integralPromotions` (dcast.d:4203). Its `default` arm (int/uint/long/
// floating) returns the operand UNCHANGED without touching `castTo`; this is the path the literals
// `1` (int) and `2L` (long) take inside `typeMerge`. The small-integer arms (byte/short/char/dchar)
// cast through `castTo` — now RUNTIME-LIVE for the basic-numeric path (dcast.ts): the narrow operand
// is wrapped in a fresh `CastExp` painted with the target basic type (`int`), no error raised. We pin
// BOTH facts (default-arm identity; small-int arm -> CastExp(tint32)).
//
// `typeMerge`/`typeCombine`/`castTo`/`implicitCastTo` basic-numeric execution is now live end-to-end;
// their common-TYPE *logic* is additionally verified against ldc2 in mtype.identity.test.ts (impcnvtab).

import { describe, it, expect, beforeEach } from "vitest";
import { Type } from "./mtype.js";
import { IntegerExp } from "./expression.js";
import { integralPromotions } from "./dcast.js";
import { Loc } from "./location.js";
import { global } from "./globals.js";
import { ErrorSinkNull } from "./errorsink.js";
import { TY } from "./astenums.js";
import type { Expression } from "./expression.js";
import type { CastExp } from "./expression.js";
import { Type_init } from "./typesem.js";

const noScope = null; // `integralPromotions` takes a nullable `Scope*`; the `default` arm never reads it

describe("dcast — integralPromotions (literals rung)", () => {
  beforeEach(() => {
    Loc._init();
    Type_init();
    global.errorSink = new ErrorSinkNull();
    global.errors = 0;
  });

  it("int and long fall through the default arm UNCHANGED (no castTo)", () => {
    const ei: Expression = new IntegerExp(Loc.initial, 1n, Type.tint32);
    const el: Expression = new IntegerExp(Loc.initial, 2n, Type.tint64);
    // identity return: same object, no cast wrapper, no error.
    expect(integralPromotions(ei, noScope)).toBe(ei);
    expect(integralPromotions(el, noScope)).toBe(el);
    expect(global.errors).toBe(0);
  });

  it("uint also falls through unchanged", () => {
    const eu: Expression = new IntegerExp(Loc.initial, 3n, Type.tuns32);
    expect(integralPromotions(eu, noScope)).toBe(eu);
  });

  it("small-integer arms (short) route through castTo -> CastExp painted tint32 (now live)", () => {
    const es: Expression = new IntegerExp(Loc.initial, 4n, Type.tint16);
    // byte/short/char/wchar -> int via castTo, now runtime-live (basic-numeric path). The narrow
    // operand is wrapped in a fresh CastExp whose .type is the int singleton; the wrapped operand
    // keeps its original tint16 type. No error is raised (the arithmetic-vs-arithmetic cast is `ok`).
    const r = integralPromotions(es, noScope) as CastExp;
    expect(r.isCastExp()).not.toBeNull();    // a CastExp wrapper, not the bare operand
    expect(r.type).toBe(Type.tint32);        // painted with the int singleton
    expect(r.type!.ty).toBe(TY.Tint32);
    expect(r.e1).toBe(es);                   // wraps the original short operand
    expect(r.e1!.type).toBe(Type.tint16);    // operand type unchanged inside the cast
    expect(global.errors).toBe(0);
  });
});
