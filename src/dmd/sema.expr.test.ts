import { describe, it, expect, beforeEach } from "vitest";

// RUNG-1 EXPRESSION-SEMANTIC GOAL TEST — drive the WHOLE expression spine on REAL D source:
//   `Parser(src)` -> `parseExpression()` -> bare `Module` + `Scope.createGlobal` -> `expressionSemantic`.
//
// Unlike `expressionsem.rung1.test.ts` (which hand-builds AST nodes with chosen operand types to probe
// individual visit methods), this suite parses the literal source string and runs the full pass. It is
// the end-to-end goal: a source string in, a TYPED expression node out (or an auditable TODO-BODY for a
// path still gated behind a later-rung sibling).
//
// EXPECTED VALUES ARE GROUND-TRUTHED VIA ldc2 (NOT guessed). The D program (run with
//   <ldc2-1.42.0>/bin/ldc2 -run)
//     writeln(typeof(EXPR).stringof)
// reports the final D type of each expression. Captured ground-truth:
//
//     1+2   => int      1+2.0 => double    1L+2  => long     1u+1  => uint
//     1<2   => bool     1==2  => bool       -5    => int      ~5    => int
//     !0    => bool     1<<2  => int        1&&0  => bool     1||0  => bool
//
// These ldc2 stringof results are the ACHIEVEMENT TARGET for each expression. With `castTo`,
// `resolveProperties` (the `binSemanticProp` pass-through) AND now `toBoolean` ported, this rung's
// pass reaches the target for TEN of the twelve expressions — every case whose final type is fixed
// by typeCombine / typeMerge / castTo / toBoolean over basic numeric operands:
//
//     1+2   -> Type.tint32     (typeCombine equal-types fast path: both int -> int, no castTo)
//     -5    -> Type.tint32     (NegExp keeps the int operand type)
//     ~5    -> Type.tint32     (ComExp keeps the int operand type)
//     1<2   -> Type.tbool      (Cmp: binSemanticProp pass-through, typeCombine equal int -> tbool)
//     1==2  -> Type.tbool      (Equal: binSemanticProp pass-through, scalar branch -> tbool)
//     1+2.0 -> Type.tfloat64   (typeMerge: int operand cast up to double via castTo)
//     1L+2  -> Type.tint64     (typeMerge: int operand cast up to long via castTo)
//     1u+1  -> Type.tuns32     (typeMerge: impcnv common type uint; int operand cast via castTo)
//     1<<2  -> Type.tint32     (shift: type = promoted LEFT operand; e2 cast to tshiftcnt via castTo)
//     !0    -> Type.tbool      (Not: unaSemantic + resolveProperties + toBoolean pass-through, then tbool)
//
// `castTo` for the BASIC-NUMERIC path is runtime-live end-to-end (dcast.ts), and `toBoolean`
// (dmd/expressionsem.d:17339) is now ported, so `!0` reaches its ldc2 target (tbool). For a SCALAR
// operand `toBoolean` is a pass-through: the type is already a valid boolean condition
// (`Type.isBoolean()` == `isScalar()` is true), so it falls through to `return e`. The values below
// were RE-CONFIRMED against the actual ported pass (and they match the ldc2 ground-truth above exactly).
//
// TWO targets remain genuinely deferred — NOT a toBoolean blocker, a DEEPER sibling:
//
//     1&&0 -> Type.tbool (ldc2)  — `1||0` likewise. visitLogicalExp is ported faithfully (operand
//     1||0 -> Type.tbool (ldc2)    semantics + resolveProperties + toBoolean both land tbool), but the
//                                  1:1 dmd flow calls `sc.merge(exp.loc, ctorflow)` unconditionally
//                                  (dmd/expressionsem.d:13634) to merge constructor-flow across the
//                                  short-circuit. `Scope.merge` (dscope.d:395) is an UNPORTED deeper
//                                  sibling — it pulls in `mergeCallSuper`/`mergeFieldInit` (ctorflow.d),
//                                  `FuncDeclaration.isMemberDecl`, `Type.needsNested`. The pass throws an
//                                  AUDITABLE `TODO-BODY: Scope.merge` at exactly that call. `toBoolean`
//                                  itself is DONE (it is what unblocked `!0`); the logical-BINARY block is
//                                  Scope.merge, not toBoolean. We PIN this deferral honestly and record
//                                  the ldc2 target (tbool). We do NOT stub Scope.merge to a no-op to force
//                                  it green — that would skip real ctorflow merging and silently miscompile
//                                  a `&&`/`||` inside a constructor. Land these once Scope.merge is ported.

import { Parser } from "./parse.js";
import { initTokens } from "./tokens.js";
import { Id } from "./id.js";
import { Loc } from "./location.js";
import { ErrorSinkNull } from "./errorsink.js";
import { Type } from "./mtype.js";
import { TY } from "./astenums.js";
import { EXP } from "./tokens.js";
import { global } from "./globals.js";
import { Module, moduleFromParse } from "./dmodule.js";
import { expressionSemantic } from "./expressionsem.js";
import { Array as DArray } from "./root/array.js";
import type { Dsymbol } from "./dsymbol.js";
import type { Dsymbols } from "./arraytypes.js";
import type { Expression } from "./expression.js";
import { Type_init } from "./typesem.js";
import { initImphint } from "./imphint.js";
import { scopeCreateGlobal } from "./dsymbolsem.js";

beforeEach(() => {
  // Compiler-startup state the lex/parse/sema paths read directly. Mirrors the `beforeEach` of
  // sema.smoke.test.ts exactly (Loc._init / Id.initialize / initTokens / Type._init / errorSink),
  // plus the process-static deferred-semantic queue reset so one case cannot leak into the next.
  Loc._init();
  initTokens();
  Id.initialize();
  Type_init();
  initImphint(); // imphint.d's `shared static this()` (01 §5.1) — the not-found tail reads its table
  // `Scope.createGlobal` asserts `global.errorSink` is non-null (it stores it as the scope's eSink).
  // ErrorSinkNull is the hermetic choice; `global.errors` stays the running diagnostic counter.
  global.errorSink = new ErrorSinkNull();
  global.errors = 0;
  Module.deferred.setDim(0);
  Module.deferred2.setDim(0);
  Module.deferred3.setDim(0);
});

/** NUL-terminated byte buffer from an ASCII/Latin-1 string (the lexer scans `.ptr` to a NUL),
 *  built exactly as the lexer/parse/sema smoke tests do. */
function srcBuf(s: string): Uint8Array {
  const b = new Uint8Array(s.length + 1);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  b[s.length] = 0;
  return b;
}

/**
 * Parse `src` as a single EXPRESSION and run the full expression-semantic pass over it.
 *
 * Pipeline (the rung's observable spine): construct a `Parser` over `src` (null Module/ModuleDeclaration
 * — an in-memory buffer needs no on-disk srcfile, same as parse.smoke.test.ts); prime with `nextToken()`;
 * `parseExpression()` to get the expression tree; attach an empty members list to a bare `Module` via
 * `moduleFromParse`; build the global `Scope` with `Scope.createGlobal`; then `expressionSemantic(e, sc)`.
 *
 * Returns the (now typed, or about-to-throw) expression node. Throws verbatim if the pass reaches a
 * deferred sibling — the caller pins that with `.toThrow("TODO-BODY: …")`.
 */
function semaExpr(src: string): Expression {
  const p = new Parser(null, null, srcBuf(src), false, new ErrorSinkNull(), null, false);
  p.nextToken();
  const e = p.parseExpression();
  const members: Dsymbols = new DArray<Dsymbol | null>(); // bare module: no top-level members
  const m = moduleFromParse(members, p.md);
  const sc = scopeCreateGlobal(m, global.errorSink!);
  return expressionSemantic(e, sc);
}

describe("sema.expr Rung-1 (source -> parseExpression -> Module/createGlobal -> expressionSemantic)", () => {
  // ── REACHED TARGETS: the pass produces the ldc2-confirmed type, as the basic-type singleton. ────
  // The task asks to assert via `e.type === the singleton` and `e.type.ty`.

  it("1+2 -> int (Type.tint32) — typeCombine equal-types fast path, no castTo", () => {
    // ldc2: typeof(1+2).stringof == "int".
    const e = semaExpr("1+2");
    expect(e.op).toBe(EXP.add);              // parsed as AddExp
    expect(e.type).toBe(Type.tint32);        // singleton identity
    expect(e.type!.ty).toBe(TY.Tint32);
  });

  it("-5 -> int (Type.tint32) — NegExp keeps the int operand type", () => {
    // ldc2: typeof(-5).stringof == "int".
    const e = semaExpr("-5");
    expect(e.op).toBe(EXP.negate);
    expect(e.type).toBe(Type.tint32);
    expect(e.type!.ty).toBe(TY.Tint32);
  });

  it("~5 -> int (Type.tint32) — ComExp keeps the int operand type", () => {
    // ldc2: typeof(~5).stringof == "int".
    const e = semaExpr("~5");
    expect(e.op).toBe(EXP.tilde);
    expect(e.type).toBe(Type.tint32);
    expect(e.type!.ty).toBe(TY.Tint32);
  });

  // ── REACHED via castTo: typeMerge / shift now cast basic-numeric operands; ldc2 target landed. ──
  // `castTo` (dcast.ts) is ported for the basic-numeric path, so these four reach their ldc2 type.

  it("1+2.0 -> double (Type.tfloat64) — typeMerge casts int up to double via castTo", () => {
    // ldc2: typeof(1+2.0).stringof == "double" (Type.tfloat64). typeMerge brings the int operand up to
    // double through castTo (now runtime-live). REACHED.
    const e = semaExpr("1+2.0");
    expect(e.op).toBe(EXP.add);              // parsed as AddExp
    expect(e.type).toBe(Type.tfloat64);      // singleton identity
    expect(e.type!.ty).toBe(TY.Tfloat64);
  });

  it("1L+2 -> long (Type.tint64) — typeMerge casts the int operand to long via castTo", () => {
    // ldc2: typeof(1L+2).stringof == "long" (Type.tint64). typeMerge casts the int operand to long. REACHED.
    const e = semaExpr("1L+2");
    expect(e.op).toBe(EXP.add);
    expect(e.type).toBe(Type.tint64);
    expect(e.type!.ty).toBe(TY.Tint64);
  });

  it("1u+1 -> uint (Type.tuns32) — impcnv common type uint; typeMerge casts via castTo", () => {
    // ldc2: typeof(1u+1).stringof == "uint" (Type.tuns32). impcnv common type is uint; typeMerge casts
    // the int operand to uint via castTo. REACHED.
    const e = semaExpr("1u+1");
    expect(e.op).toBe(EXP.add);
    expect(e.type).toBe(Type.tuns32);
    expect(e.type!.ty).toBe(TY.Tuns32);
  });

  it("1<<2 -> int (Type.tint32) — shift: type = promoted LEFT operand; e2 cast via castTo", () => {
    // ldc2: typeof(1<<2).stringof == "int" (Type.tint32 — the promoted LEFT operand). The visit sets
    // exp.type = exp.e1.type; e2.castTo(tshiftcnt) is now runtime-live. REACHED.
    const e = semaExpr("1<<2");
    expect(e.op).toBe(EXP.leftShift);        // parsed as ShlExp
    expect(e.type).toBe(Type.tint32);
    expect(e.type!.ty).toBe(TY.Tint32);
  });

  it("1<2 -> bool (Type.tbool) — Cmp: binSemanticProp/resolveProperties pass-through, then tbool", () => {
    // ldc2: typeof(1<2).stringof == "bool" (Type.tbool). binSemanticProp -> resolveProperties is now
    // ported (a no-op pass-through for the int operands); typeCombine succeeds on equal int types and
    // visitCmpExp sets exp.type = tbool (non-C scope). REACHED, no castTo needed.
    const e = semaExpr("1<2");
    expect(e.op).toBe(EXP.lessThan);         // parsed as CmpExp
    expect(e.type).toBe(Type.tbool);         // singleton identity
    expect(e.type!.ty).toBe(TY.Tbool);
  });

  it("1==2 -> bool (Type.tbool) — Equal: binSemanticProp/resolveProperties pass-through, then tbool", () => {
    // ldc2: typeof(1==2).stringof == "bool" (Type.tbool). Same binSemanticProp pass-through as Cmp;
    // the scalar (non-array) branch runs typeCombine on equal int types and sets exp.type = tbool.
    const e = semaExpr("1==2");
    expect(e.op).toBe(EXP.equal);            // parsed as EqualExp
    expect(e.type).toBe(Type.tbool);         // singleton identity
    expect(e.type!.ty).toBe(TY.Tbool);
  });

  // ── REACHED via toBoolean: visitNotExp now lands the ldc2 target. ───────────────────────────────
  it("!0 -> bool (Type.tbool) — Not: unaSemantic + resolveProperties + toBoolean pass-through", () => {
    // ldc2: typeof(!0).stringof == "bool" (Type.tbool) — the ACHIEVEMENT TARGET, now REACHED. With
    // `toBoolean` (dmd/expressionsem.d:17339) ported, visitNotExp runs end-to-end: unaSemantic on the
    // int operand, resolveProperties (pass-through), toBoolean (pass-through — an int is already a valid
    // boolean condition since `Type.isBoolean()` == `isScalar()` is true), then `e.type = tbool`
    // (non-C scope). No fake: the int IS boolean-convertible, exactly as ldc2 reports.
    const e = semaExpr("!0");
    expect(e.op).toBe(EXP.not);              // parsed as NotExp
    expect(e.type).toBe(Type.tbool);         // singleton identity
    expect(e.type!.ty).toBe(TY.Tbool);
  });

  // ── ACHIEVEMENT TARGET REACHED: visitLogicalExp now completes (Scope.merge ported). ─────────────
  it("1&&0 -> bool (Type.tbool) — Logical: operand sema + toBoolean + Scope.merge short-circuit join", () => {
    // ldc2: typeof(1 && 0).stringof == "bool" (Type.tbool) — the ACHIEVEMENT TARGET, now REACHED.
    // visitLogicalExp runs both operands -> expressionSemantic + resolveProperties + toBoolean, then
    // the `sc.merge(exp.loc, ctorflow)` short-circuit join (dmd/expressionsem.d:13634). `Scope.merge`
    // (dscope.d:395) is now ported: outside a constructor the fieldinit is empty, so merge reduces to
    // the callSuper join, and `exp.type = tbool` (non-C scope) per dmd/expressionsem.d:13668-13672.
    const e = semaExpr("1 && 0");
    expect(e.op).toBe(EXP.andAnd);
    expect(e.type).toBe(Type.tbool);
    expect(e.type!.ty).toBe(TY.Tbool);
  });

  it("1||0 -> bool (Type.tbool) — Logical: same as `&&` (EXP.orOr), Scope.merge join then tbool", () => {
    // ldc2: typeof(1 || 0).stringof == "bool" (Type.tbool). Same faithful visitLogicalExp as `&&`
    // (distinguished only by `op`, EXP.orOr); Scope.merge join completes, result type lands tbool.
    const e = semaExpr("1 || 0");
    expect(e.op).toBe(EXP.orOr);
    expect(e.type).toBe(Type.tbool);
    expect(e.type!.ty).toBe(TY.Tbool);
  });
});
