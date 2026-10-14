// GOAL TEST — protects the three Rung-1 `castTo` prerequisites unblocked in this step:
//   1. `isAggregate` (mtype.d:4060) — now type-checks and returns the AggregateDeclaration|null
//      downcast (basic type -> null) without throwing.
//   2. `optimize` (optimize.d:274) — the driver-loop literal/identity path: a constant folds to
//      itself (same object, value unchanged) in a single iteration.
//   3. `implicitConvTo` (dcast.d:271) — the Expression-level MATCH, basic/numeric path: optimize +
//      `Type.implicitConvTo`. int->int exact, int->long convert (widening). long->int is a narrowing
//      of two integral basic types, so it enters the value-range branch (`getIntRange` /
//      `intRangeFromType` / `IntRange.contains`); this test pins that the branch resolves.
//
// These are exactly the facts `castTo`/`implicitCastTo` lean on for constant-literal conversion.
// Verified to mirror dmd-2.112.1 semantics via /tmp/verify_rung1.d (ldc2 -run).

import { describe, it, expect, beforeEach } from "vitest";
import { Type } from "./mtype.js";
import { isAggregate } from "./typesem.js";
import { IntegerExp } from "./expression.js";
import { optimize } from "./optimize.js";
import { implicitConvTo } from "./dcast.js";
import { WANTvalue } from "./expression.js";
import { MATCH } from "./astenums.js";
import { Loc } from "./location.js";
import { global } from "./globals.js";
import { ErrorSinkNull } from "./errorsink.js";
import { Type_init } from "./typesem.js";

describe("dcast/optimize/mtype — Rung-1 castTo prerequisites", () => {
  beforeEach(() => {
    Loc._init();
    Type_init();
    global.errorSink = new ErrorSinkNull();
    global.errors = 0;
  });

  it("isAggregate(basic) returns null without throwing", () => {
    // A basic type (int) is not a class/struct -> the `return null` arm. The point of this assertion
    // is that the function now type-checks and runs (it previously threw TODO-BODY).
    expect(isAggregate(Type.tint32)).toBeNull();
    expect(isAggregate(Type.tint64)).toBeNull();
  });

  it("optimize(literal) is the identity fixed-point (single iteration, unchanged)", () => {
    const lit = new IntegerExp(Loc.initial, 42n, Type.tint32);
    const folded = optimize(lit, WANTvalue);
    expect(folded).toBe(lit); // same object: the `default: visitExp` no-op leaves `ret == e`
    expect((folded as IntegerExp).value).toBe(42n);
    expect(global.errors).toBe(0);
  });

  it("implicitConvTo int->int is exact", () => {
    const e = new IntegerExp(Loc.initial, 7n, Type.tint32);
    expect(implicitConvTo(e, Type.tint32)).toBe(MATCH.exact);
  });

  it("implicitConvTo int->long is convert (widening)", () => {
    const e = new IntegerExp(Loc.initial, 7n, Type.tint32);
    expect(implicitConvTo(e, Type.tint64)).toBe(MATCH.convert);
  });

  it("implicitConvTo long->int takes the value-range branch: 7L fits in int, so MATCH.convert", () => {
    // long->int is a narrowing of two integral basic types, so after the type table returns nomatch
    // dmd's `visit(Expression)` enters the value-range branch — `getIntRange(e)` /
    // `intRangeFromType(t)` / `IntRange.contains` (dcast.d:350-352). The literal's range is [7,7],
    // which `int` contains, so the answer is `convert`.
    const e = new IntegerExp(Loc.initial, 7n, Type.tint64);
    expect(implicitConvTo(e, Type.tint32)).toBe(MATCH.convert);
  });
});
