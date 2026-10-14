// GOAL TEST — Rung 1 of the expression semantic pass: literals + ALL numeric operators
// (src/dmd/expressionsem.ts). Protects the achievement that `expressionSemantic` correctly types a
// basic-numeric expression tree per dmd/expressionsem.d, verified against ldc2 (/tmp/rung1probe.d):
//
//   - literals confirm/normalize their parser-set type (IntegerExp/char-as-IntegerExp/RealExp);
//   - arithmetic (+ - * / %) and bitwise (& | ^) over SAME-type operands set `.type` to the common
//     type via typeCombine's equal-types fast path; MIXED-type operands (int+long) bring the narrower
//     operand up via typeMerge→castTo (now runtime-live) and set `.type` to the wider common type;
//   - shift (<< >> >>>) sets `.type` to the promoted LEFT operand and casts the count operand to
//     tshiftcnt via castTo (now runtime-live);
//   - unary `-x`/`~x` keep the operand type (a NARROW operand integral-promotes via fix16997→castTo,
//     now runtime-live: -(short) -> int); unary `+x` unwraps to the operand;
//   - Logical/Not are LIVE since arrayop.ts landed: `checkNonAssignmentArrayOp` (dmd/arrayop.d:90)
//     now returns `false` for a scalar operand, and both visits run through to `tbool`. Their three
//     pinned walls were CONVERTED to behaviour pins (10 §1.8 rule 7).
//   - Cmp/Equal/Identity are LIVE since target.ts landed `Target.isVectorOpSupported`
//     (dmd/target.d:816): for two `int` operands the callee returns `true` on its first statement
//     (`type.isTypeVector()` is null, target.d:820-822), the `!` branch is not taken, and each
//     visit reaches `result = exp` carrying the `Type.tbool` it had already been given further up.
//     Their three pinned walls were CONVERTED to behaviour pins (10 §1.8 rule 7).
//   - the arithmetic/bitwise/shift groups were RED for the same reason and are now GREEN, with
//     their TYPE assertions intact — the 13 entries the previous wave deliberately refused to
//     convert into wall pins precisely so this moment would prove the rung, not just the wall.
//
// These assert the TYPE the pass produces (the rung's observable achievement), not folding (later rung).

import { describe, it, expect, beforeEach } from "vitest";
import { Loc } from "./location.js";
import { Type } from "./mtype.js";
import { TY } from "./astenums.js";
import { global } from "./globals.js";
import { ErrorSinkNull } from "./errorsink.js";
import { Id } from "./id.js";
import { initTokens } from "./tokens.js";
import { Scope } from "./dscope.js";
import {
  IntegerExp,
  RealExp,
  AddExp,
  MinExp,
  MulExp,
  DivExp,
  ModExp,
  AndExp,
  OrExp,
  XorExp,
  ShlExp,
  ShrExp,
  UshrExp,
  CmpExp,
  EqualExp,
  IdentityExp,
  LogicalExp,
  NotExp,
  NegExp,
  ComExp,
  UAddExp,
} from "./expression.js";
import { EXP } from "./tokens.js";
import { expressionSemantic } from "./expressionsem.js";
import { Type_init } from "./typesem.js";

const loc = Loc.initial;

/** A fresh global Scope with C-semantics off (`inCfile === false`), the only Scope field the numeric
 *  visit paths read. `Scope.alloc()` returns a `new Scope()` at init (dscope.d:226). */
function newScope(): Scope {
  return Scope.alloc();
}

function intLit(v: bigint, t: Type): IntegerExp {
  return new IntegerExp(loc, v, t);
}

beforeEach(() => {
  Loc._init();
  initTokens();
  Id.initialize();
  Type_init();
  global.errorSink = new ErrorSinkNull();
  global.errors = 0;
});

describe("expressionSemantic Rung 1 — literals", () => {
  it("IntegerExp confirms its parser-set int type and returns itself", () => {
    const e = intLit(7n, Type.tint32);
    const r = expressionSemantic(e, newScope());
    expect(r).toBe(e);
    expect(r.type).toBe(Type.tint32);
    expect(r.type!.ty).toBe(TY.Tint32);
  });

  it("char literal is an IntegerExp typed tchar (dmd has no CharExp); value re-normalized", () => {
    // 'A' == 0x41; char is an 8-bit unsigned carrier, normalize keeps 0x41.
    const e = intLit(0x41n, Type.tchar);
    const r = expressionSemantic(e, newScope());
    expect(r).toBe(e);
    expect(r.type).toBe(Type.tchar);
    expect((r as IntegerExp).value).toBe(0x41n);
  });

  it("long literal confirms its tint64 type", () => {
    const e = intLit(2n, Type.tint64);
    const r = expressionSemantic(e, newScope());
    expect(r.type).toBe(Type.tint64);
    expect(r.type!.ty).toBe(TY.Tint64);
  });

  it("RealExp with a parser-set type runs typeSemantic and returns itself (tfloat64)", () => {
    const e = new RealExp(loc, 1.5, Type.tfloat64);
    const r = expressionSemantic(e, newScope());
    expect(r).toBe(e);
    expect(r.type).toBe(Type.tfloat64);
  });

  it("untyped RealExp defaults to tfloat64 and returns itself", () => {
    // RE-PINNED (10 §1.8 rule 2): the rung-era pin asserted a `TODO-BODY: visitRealExp` wall for an
    // imaginary-conversion fall-through. The faithful 1.43 `visit(RealExp)`
    // (dmd/expressionsem.d:5404-5412) has no such block at all — it is five lines:
    // `if (!e.type) e.type = Type.tfloat64; e.type = e.type.typeSemantic(e.loc, sc); result = e;`.
    // The wall did not MOVE; it never existed in this version, so the pin becomes a behavior pin.
    const e = new RealExp(loc, 2.5, null);
    const r = expressionSemantic(e, newScope());
    expect(r).toBe(e);
    expect(r.type).toBe(Type.tfloat64);
  });
});

describe("expressionSemantic Rung 1 — arithmetic (same-type operands, typeCombine fast path)", () => {
  // ldc2: typeof(1+1)==int, typeof(2L+3L)==long, *,/,% all == int for int operands (/tmp/rung1probe.d).
  const cases: ReadonlyArray<readonly [string, (a: IntegerExp, b: IntegerExp) => unknown, TY]> = [
    ["int + int -> int", (a, b) => new AddExp(loc, a, b), TY.Tint32],
    ["int - int -> int", (a, b) => new MinExp(loc, a, b), TY.Tint32],
    ["int * int -> int", (a, b) => new MulExp(loc, a, b), TY.Tint32],
    ["int / int -> int", (a, b) => new DivExp(loc, a, b), TY.Tint32],
    ["int % int -> int", (a, b) => new ModExp(loc, a, b), TY.Tint32],
  ];
  for (const [name, mk, ty] of cases) {
    it(name, () => {
      const e = mk(intLit(7n, Type.tint32), intLit(2n, Type.tint32)) as AddExp;
      const r = expressionSemantic(e, newScope());
      expect(r).toBe(e);
      expect(r.type!.ty).toBe(ty);
      expect(global.errors).toBe(0);
    });
  }

  it("long + long -> long (64-bit common type)", () => {
    const e = new AddExp(loc, intLit(2n, Type.tint64), intLit(3n, Type.tint64));
    const r = expressionSemantic(e, newScope());
    expect(r.type!.ty).toBe(TY.Tint64);
  });

  it("mixed int + long -> long (typeMerge casts the int operand up via castTo, now live)", () => {
    // ldc2: typeof(1 + 2L) == long (Type.tint64). typeMerge casts the int operand to long via castTo
    // (now runtime-live, dcast.ts); the common type is long. REACHED.
    const e = new AddExp(loc, intLit(1n, Type.tint32), intLit(2n, Type.tint64));
    const r = expressionSemantic(e, newScope());
    expect(r).toBe(e);
    expect(r.type).toBe(Type.tint64);
    expect(r.type!.ty).toBe(TY.Tint64);
    expect(global.errors).toBe(0);
  });
});

describe("expressionSemantic Rung 1 — bitwise (& | ^), same-type operands", () => {
  // ldc2: typeof(0xF0 & 0x0F)==int, | and ^ likewise (/tmp/rung1probe.d).
  const cases: ReadonlyArray<readonly [string, (a: IntegerExp, b: IntegerExp) => unknown]> = [
    ["int & int -> int", (a, b) => new AndExp(loc, a, b)],
    ["int | int -> int", (a, b) => new OrExp(loc, a, b)],
    ["int ^ int -> int", (a, b) => new XorExp(loc, a, b)],
  ];
  for (const [name, mk] of cases) {
    it(name, () => {
      const e = mk(intLit(0xf0n, Type.tint32), intLit(0x0fn, Type.tint32)) as AndExp;
      const r = expressionSemantic(e, newScope());
      expect(r).toBe(e);
      expect(r.type!.ty).toBe(TY.Tint32);
    });
  }

  it("bool & bool keeps the bool operand type (no typeCombine)", () => {
    const e = new AndExp(loc, intLit(1n, Type.tbool), intLit(0n, Type.tbool));
    const r = expressionSemantic(e, newScope());
    expect(r.type).toBe(Type.tbool);
    expect(r.type!.ty).toBe(TY.Tbool);
  });
});

describe("expressionSemantic Rung 1 — shift (<< >> >>>): type = promoted LEFT operand (castTo live)", () => {
  // ldc2: typeof(1<<n)==int, typeof(1L<<n)==long (result type = promoted LEFT operand). The visit sets
  // exp.type = exp.e1.type; e2.castTo(tshiftcnt) is now runtime-live (dcast.ts). REACHED.
  const cases: ReadonlyArray<readonly [string, (a: IntegerExp, b: IntegerExp) => unknown]> = [
    ["int << int", (a, b) => new ShlExp(loc, a, b)],
    ["int >> int", (a, b) => new ShrExp(loc, a, b)],
    ["int >>> int", (a, b) => new UshrExp(loc, a, b)],
  ];
  for (const [name, mk] of cases) {
    it(`${name} -> int (Type.tint32, the promoted left operand)`, () => {
      const e = mk(intLit(1n, Type.tint32), intLit(4n, Type.tint32)) as ShlExp;
      const r = expressionSemantic(e, newScope());
      expect(r).toBe(e);
      expect(r.type).toBe(Type.tint32);
      expect(r.type!.ty).toBe(TY.Tint32);
      expect(global.errors).toBe(0);
    });
  }
});

describe("expressionSemantic Rung 1 — comparison/identity: type is bool", () => {
  // CONVERTED from a pinned wall to a BEHAVIOUR pin (10 §1.8 rule 7). These three were pinned twice
  // before: first on `checkNonAssignmentArrayOp` (swept when arrayop.ts landed), then on
  // `!target.isVectorOpSupported(...)` (dmd/target.d:816). target.ts has now landed that callee,
  // and for two `int` operands it returns `true` on its FIRST statement — `type.isTypeVector()` is
  // null, so target.d:820-822 short-circuits before the op switch is ever consulted. The `!` branch
  // is therefore not taken and each visit runs to completion. Nothing further down these paths
  // walls; the arms were verified one by one in the 1.43.0 source and every one is false for two
  // `int` operands:
  // In all three visits `exp.type` is assigned BEFORE the predicate is consulted, so what the
  // predicate decides is whether the visit REACHES `result = exp` or is replaced by
  // `exp.incompatibleTypes()` — which returns `ErrorExp.get()`, flipping both `r.op` and `r.type`.
  // That is what makes these pins discriminate.
  //   visit(CmpExp)      calls at dmd/expressionsem.d:14657/:14658 -> `exp.type = (sc &&
  //                      sc.inCfile) ? Type.tint32 : Type.tbool` (:14662) -> intervening arms
  //                      :14668 (array/pointer), :14699 (class/class), :14704 (complex), :14709
  //                      (function types), :14714 (Taarray) -> the live test at :14719 -> the
  //                      `else` arm at :14724 (checkValue/checkSharedAccess) -> `result = exp`
  //                      (:14743). The vector re-type at :14740-:14741 does not fire: `t1` is `int`.
  //   visit(EqualExp)    calls at :15073/:15074 -> `exp.type = … Type.tbool` (:15078) ->
  //                      intervening arms :15080 (float/float recast, inner test false), :15091 and
  //                      :15174 (isArrayComparison), :15190 (Taarray) -> the live test at :15197,
  //                      the function-type reject at :15203 (false), then `result = exp` (:15212).
  //   visit(IdentityExp) calls at :15232/:15233 -> intervening arms :15237 (EXP.type operand),
  //                      :15243 `exp.type = Type.tbool`, :15245 (float/float recast) -> the live
  //                      test at :15254, and `result = exp` follows it.
  // The expected values are ldc2's, not the port's own expression (10 §1.8 rule 8). On
  // ldc2-1.43.0 / arm64-apple-darwin, `pragma(msg, typeof(1 < 2)); pragma(msg, typeof(1 == 2));
  // pragma(msg, typeof(1 is 2));` prints `bool` three times.
  it("CmpExp (<) -> bool", () => {
    const e = new CmpExp(EXP.lessThan, loc, intLit(1n, Type.tint32), intLit(2n, Type.tint32));
    const r = expressionSemantic(e, newScope());
    expect(r.op).toBe(EXP.lessThan);
    expect(r.type!.ty).toBe(TY.Tbool);
    expect(global.errors).toBe(0);
  });
  it("EqualExp (==) -> bool", () => {
    const e = new EqualExp(EXP.equal, loc, intLit(1n, Type.tint32), intLit(2n, Type.tint32));
    const r = expressionSemantic(e, newScope());
    expect(r.op).toBe(EXP.equal);
    expect(r.type!.ty).toBe(TY.Tbool);
    expect(global.errors).toBe(0);
  });
  it("IdentityExp (is) -> bool", () => {
    const e = new IdentityExp(EXP.identity, loc, intLit(1n, Type.tint32), intLit(2n, Type.tint32));
    const r = expressionSemantic(e, newScope());
    expect(r.op).toBe(EXP.identity);
    expect(r.type!.ty).toBe(TY.Tbool);
    expect(global.errors).toBe(0);
  });
});

describe("expressionSemantic Rung 1 — logical (&& ||) and !: type is bool", () => {
  // CONVERTED from a pinned wall to a BEHAVIOUR pin (10 §1.8 rule 7). `arrayop.ts` landed, so
  // `checkNonAssignmentArrayOp` (dmd/arrayop.d:90) — the wall these three used to halt on, at
  // dmd/expressionsem.d:14586/:14587 for LogicalExp and :10666 for NotExp — is a live call that
  // returns `false` for a scalar operand. Nothing downstream of it walls on this path:
  //   visit(LogicalExp) runs to `exp.type = tbool` (dmd/expressionsem.d:14615) and `result = exp`
  //                     (:14619). There is no isVectorOpSupported test in this visit.
  //   visit(NotExp)     the `!target.isVectorOpSupported(e.e1.type.toBasetype(), e.op)` test at
  //                     dmd/expressionsem.d:10660 is now a LIVE call (target.ts landed the callee;
  //                     the wall that used to stand here is swept). For an `int` operand the callee
  //                     returns `true` on its first statement (target.d:820-822), so the `!` branch
  //                     is not taken; the visit then runs `checkNonAssignmentArrayOp` (:10666,
  //                     false) and reaches `e.type = tbool` (:10669) and `result = e` (:10670).
  //                     Note D does NOT return from the predicate arm here — it assigns `result`
  //                     and falls through — which is why the port must not return either.
  // The expected values are ldc2's, not the port's own expression (10 §1.8 rule 8):
  //   `typeof(1 && 2)`, `typeof(1 || 2)` and `typeof(!1)` all print `bool`
  //   (ldc2 -run, LDC 1.43.0). D returns the SAME node (`result = exp` / `result = e`) —
  //   constant folding of `&&`/`||`/`!` belongs to `optimize`, not to semantic.
  it("LogicalExp (&&) is live: type bool, same node", () => {
    const e = new LogicalExp(loc, EXP.andAnd, intLit(1n, Type.tint32), intLit(2n, Type.tint32));
    const r = expressionSemantic(e, newScope());
    expect(r).toBe(e);
    expect(r.type).toBe(Type.tbool);
    expect(r.type!.ty).toBe(TY.Tbool);
  });
  it("LogicalExp (||) is live: type bool, same node", () => {
    const e = new LogicalExp(loc, EXP.orOr, intLit(1n, Type.tint32), intLit(2n, Type.tint32));
    const r = expressionSemantic(e, newScope());
    expect(r).toBe(e);
    expect(r.type).toBe(Type.tbool);
    expect(r.type!.ty).toBe(TY.Tbool);
  });
  it("NotExp (!) is live: type bool, same node", () => {
    const e = new NotExp(loc, intLit(1n, Type.tint32));
    const r = expressionSemantic(e, newScope());
    expect(r).toBe(e);
    expect(r.type).toBe(Type.tbool);
    expect(r.type!.ty).toBe(TY.Tbool);
  });
});

describe("expressionSemantic Rung 1 — unary (-x ~x +x): operand type / unwrap", () => {
  // ldc2: typeof(-1)==int, typeof(~1)==int, typeof(+1)==int (/tmp/rung1probe.d).
  it("NegExp (-x) keeps the operand type", () => {
    const inner = intLit(1n, Type.tint32);
    const e = new NegExp(loc, inner);
    const r = expressionSemantic(e, newScope());
    expect(r).toBe(e);
    expect(r.type).toBe(Type.tint32);
  });

  it("ComExp (~x) keeps the operand type", () => {
    const e = new ComExp(loc, intLit(1n, Type.tint32));
    const r = expressionSemantic(e, newScope());
    expect(r).toBe(e);
    expect(r.type).toBe(Type.tint32);
  });

  it("UAddExp (+x) unwraps to the operand (dmd: result = exp.e1)", () => {
    const inner = intLit(5n, Type.tint32);
    const e = new UAddExp(loc, inner);
    const r = expressionSemantic(e, newScope());
    // unary plus is value-identity: the result IS the operand, not the UAddExp node.
    expect(r).toBe(inner);
    expect(r.type).toBe(Type.tint32);
  });

  it("NegExp on a long operand keeps tint64", () => {
    const e = new NegExp(loc, intLit(9n, Type.tint64));
    const r = expressionSemantic(e, newScope());
    expect(r.type!.ty).toBe(TY.Tint64);
  });

  it("NegExp on a narrow operand (short) integral-promotes to int via fix16997→castTo (now live)", () => {
    // ldc2: typeof(-(short)1) == int (Type.tint32). fix16997 (params.fix16997 default true) runs
    // integralPromotions, which casts short→int through castTo (now runtime-live); NegExp then keeps the
    // promoted operand type. The result is the NegExp node typed tint32. REACHED.
    const e = new NegExp(loc, intLit(1n, Type.tint16));
    const r = expressionSemantic(e, newScope());
    expect(r).toBe(e);
    expect(r.type).toBe(Type.tint32);
    expect(r.type!.ty).toBe(TY.Tint32);
    expect(global.errors).toBe(0);
  });
});
