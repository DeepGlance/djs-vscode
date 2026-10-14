import { describe, it, expect, beforeEach } from "vitest";

// SEMA RUNG-2 VARIABLE / INITIALIZER / LOOKUP GOAL TESTS.
//
// These protect the Rung-2 deliverables that run END-TO-END, and HONESTLY PIN the ones that halt at
// an unported deeper sibling (STOP/escalate — 00-how-to-use §5 / 11-escalate.md). The split mirrors
// the established sema.expr.test.ts discipline: assert reached contracts, `.toThrow("TODO-BODY: …")`
// the deferred ones.
//
// REACHED:
//   - initsem.ts `initializerSemantic` ExpInitializer arm (non-interpret): a plain `ExpInitializer`
//     holding an `IntegerExp` is type-analyzed (expressionSemantic), constant-folded (optimize), and
//     implicit-cast to the declared type — returning the SAME ExpInitializer with a typed `exp` and
//     `semanticDone == true`. This is the task's "run the ExpInitializer (initsem) → expressionSemantic
//     on the init expr; implicitCastTo the init to the var's type".
//   - expressionsem.ts `visitIdentifierExp` MISS-then-error and HIT-then-symbolToExp dispatch.
//   - `visitIdentifierExp` HIT routes to `symbolToExp`, whose pre-amble (checkDeprecated/checkDisabled/
//     toAlias/isSystem→setUnsafePreview — now ported as no-ops for a plain var) runs clean, and the
//     VarDeclaration branch builds `new VarExp(loc, v)` + re-runs expressionSemantic → a typed VarExp.
//   - `visitVarExp` runs its type spine (var.type → typeSemantic) and the now-ported
//     `checkNestedReference` (a no-op for a module-level var) end-to-end → a typed VarExp.
//
// NOW REACHED (this rung — the var-decl body past the type is ported):
//   - `visitVarDeclaration` runs a plainly-typed, plain-mutable, module-level var to COMPLETION:
//     checkDeprecatedType / alignment defaulting / checkComplexTransition / the validity+placement checks /
//     addStorageClass / the init block / callScopeDtor / `semanticRun = semanticdone`. For `int z;` and
//     `int x = 5;` the body completes with errors === 0 (a mutable module var's init analysis is deferred
//     to semantic2, faithful to dmd — see sema.decl.test.ts header).
//
// GROUND-TRUTH FLIPS through the FULL `sema()` MODULE DRIVER (lex -> parse -> moduleFromParse -> runSemantic),
// pinned to ldc2-1.43.0 (<ldc2-1.43.0>/bin/ldc2 -c -o-):
//   ACCEPT `int x = 5;`            -> ldc2 VALID; driver errors === 0, x typed tint32, init folded IntegerExp(5).
//   ACCEPT `int x = 5; int y = 7;` -> ldc2 VALID; driver errors === 0, both vars typed tint32.
//   REJECT `int x = "s";`          -> ldc2 REJECTED (string -> int). The reject lives in semantic2's
//          `initializerSemantic(INITinterpret)` (semantic2.d:249), which `runSemantic` runs as pass 2; the
//          driver reports one error. (sema.decl.test.ts pins the message text; this file carries the
//          matching ground-truth at the var-decl level.)

import { Parser } from "./parse.js";
import { Loc } from "./location.js";
import { ErrorSinkNull } from "./errorsink.js";
import { Type } from "./mtype.js";
import { TY } from "./astenums.js";
import { EXP } from "./tokens.js";
import { PASS } from "./dsymbol.js";
import { global } from "./globals.js";
import { Module, moduleFromParse } from "./dmodule.js";
import { Scope } from "./dscope.js";
import { DsymbolTable } from "./dsymbol.js";
import { Identifier } from "./identifier.js";
import { VarDeclaration } from "./declaration.js";
import { IntegerExp, VarExp } from "./expression.js";
import { ExpInitializer, INITnointerpret, INITinterpret } from "./init.js";
import { initializerSemantic } from "./initsem.js";
import { expressionSemantic } from "./expressionsem.js";
import { dsymbolSemantic, addMember, runSemantic, scopeCreateGlobal } from "./dsymbolsem.js";
import { Array as DArray } from "./root/array.js";
import { ds, dsToJs } from "../dstring.js";
import type { Dsymbol } from "./dsymbol.js";
import type { Dsymbols } from "./arraytypes.js";
import type { Expression } from "./expression.js";
import { initSemaHarness, sourceMembers } from "../sema-harness.js";

beforeEach(() => {
  initSemaHarness();
});

function srcBuf(s: string): Uint8Array {
  const b = new Uint8Array(s.length + 1);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  b[s.length] = 0;
  return b;
}

/** Build a global Scope over a bare module (no top-level members), like sema.expr.test.ts. */
function globalScope(): Scope {
  const members: Dsymbols = new DArray<Dsymbol | null>();
  const m = moduleFromParse(members, null);
  return scopeCreateGlobal(m, global.errorSink!);
}

/** Parse `src` as an expression and run the full expression-semantic pass over it. */
function semaExpr(src: string, sc: Scope): Expression {
  const p = new Parser(null, null, srcBuf(src), false, new ErrorSinkNull(), null, false);
  p.nextToken();
  const e = p.parseExpression();
  return expressionSemantic(e, sc);
}

/** Parse-only build of a Module (no sema), to inspect the parsed AST / plant a symtab. */
function parseModule(src: string): Module {
  const p = new Parser(null, null, srcBuf(src), false, new ErrorSinkNull(), null, false);
  p.nextToken();
  const members: Dsymbols = p.parseModule();
  return moduleFromParse(members, p.md);
}

/**
 * The `sema(src)` MODULE helper (verbatim from sema.smoke.test.ts / sema.decl.test.ts): lex+parse `src` into
 * a Module, run the `runSemantic` driver (passes 0-3) over it, and return the module plus the resulting global error
 * count. Throws verbatim if the pass reaches a deferred sibling (the caller pins that with `.toThrow`).
 */
function sema(src: string): { module: Module; errors: number } {
  const m = parseModule(src);
  runSemantic(m);
  return { module: m, errors: global.errors };
}

describe("initializerSemantic — ExpInitializer arm (non-interpret), the Rung-2 init path", () => {
  it("types + folds + implicit-casts a plain integer initializer to the declared type", () => {
    const sc = globalScope();
    // `int x = 5;` modelled as an ExpInitializer over IntegerExp(5). The 3-arg IntegerExp ctor sets the
    // literal's parser type (tint32), as the parser would; initializerSemantic re-runs expressionSemantic.
    const init = new ExpInitializer(Loc.initial, new IntegerExp(Loc.initial, 5n, Type.tint32));
    const tx = { value: Type.tint32 };
    const out = initializerSemantic(init, sc, tx, INITnointerpret);

    // Same ExpInitializer node, now semantic-done, with a typed (int) folded expression.
    expect(out).toBe(init);
    expect(out.semanticDone).toBe(true);
    const ei = out.isExpInitializer();
    expect(ei).not.toBeNull();
    expect(ei!.exp!.type).toBe(Type.tint32);    // implicitCastTo(t) landed the declared type
    expect(ei!.exp!.type!.ty).toBe(TY.Tint32);
    expect(ei!.exp!.op).toBe(EXP.int64);         // an IntegerExp (folded literal)
    expect(global.errors).toBe(0);
  });

  it("widening an int literal to a long declared type folds the cast to a long literal", () => {
    // ldc2 ground-truth: `long y = 5;` types the initializer `long` (-vcg-ast prints `long y = 5L;`). The visitExp
    // arm's `implicitConvTo(t) ? implicitCastTo(t)` produces a `CastExp` over the int literal, and the trailing
    // `optimize(WANTvalue)` folds it through constfold's `Cast` (optimize.d:918 -> constfold.d:917).
    const sc = globalScope();
    const init = new ExpInitializer(Loc.initial, new IntegerExp(Loc.initial, 5n, Type.tint32));
    const tx = { value: Type.tint64 };
    const r = initializerSemantic(init, sc, tx, INITnointerpret);
    const ei = r.isExpInitializer();
    expect(ei).not.toBeNull();
    expect(ei!.exp!.op).toBe(EXP.int64);
    expect(ei!.exp!.type!.ty).toBe(TY.Tint64);
    expect(ei!.exp!.isIntegerExp()!.getInteger()).toBe(5n);
    expect(global.errors).toBe(0);
  });

  it("a second call is idempotent (semanticDone short-circuits, returns the node unchanged)", () => {
    const sc = globalScope();
    const init = new ExpInitializer(Loc.initial, new IntegerExp(Loc.initial, 7n, Type.tint32));
    const tx = { value: Type.tint32 };
    const first = initializerSemantic(init, sc, tx, INITnointerpret);
    const second = initializerSemantic(first, sc, tx, INITnointerpret);
    expect(second).toBe(first);
    expect(global.errors).toBe(0);
  });
});

describe("visitIdentifierExp — unqualified name resolution", () => {
  it("a name that resolves nowhere emits `undefined identifier` and yields ErrorExp", () => {
    // dmd/expressionsem.d:5635-5646 — the non-C not-found tail: `importHint` misses, `search_correct`
    // misses, `search_correct_C` misses, the ident is not `$`, so D reaches the plain
    // `undefined identifier \`%s\`` and sets `result = ErrorExp.get()` (d:5658).
    const sc = globalScope();
    const e = semaExpr("nope", sc);
    expect(e.op).toBe(EXP.error);
    expect(global.errors).toBeGreaterThan(0);
  });

  it("a name that resolves to a planted module variable resolves to a typed VarExp via symbolToExp", () => {
    // Plant `int x;` into the module symtab (the add-member pre-pass), then resolve the bare name `x`.
    // Scope.search HITS, visitIdentifierExp routes the hit to symbolToExp, whose pre-amble runs clean
    // for a plain (non-deprecated/non-@disable/non-@system/non-alias) var, and the VarDeclaration branch
    // builds `new VarExp(loc, x)` and re-runs expressionSemantic — a typed (int) VarExp, end-to-end.
    const m = new Module(Loc.initial, ds("m.d"), Identifier.idPool(ds("m")), 0, 0);
    const ident = Identifier.idPool(ds("x"));
    const varDecl = new VarDeclaration(Loc.initial, Type.tint32, ident, null);
    const members = new DArray<Dsymbol | null>();
    members.push(varDecl as unknown as Dsymbol);
    m.members = members;
    const sc = scopeCreateGlobal(m, global.errorSink!);
    m.symtab = new DsymbolTable();
    for (let i = 0; i < m.members.length; i++) addMember(m.members.opIndex(i)!, sc, sc.scopesym!);

    const out = semaExpr("x", sc);
    const ve = out.isVarExp();
    expect(ve).not.toBeNull();                    // resolved to a VarExp
    expect(ve!.var_).toBe(varDecl as unknown);    // pointing at the planted `x`
    expect(out.type).toBe(Type.tint32);           // typed `int` (taken from var.type, deco'd)
    expect(out.type!.ty).toBe(TY.Tint32);
    expect(global.errors).toBe(0);
  });

  it("the `x` in `x + 2` resolves to a typed VarExp inside the binary expression (the task's named case)", () => {
    // The batch's stated goal: a module-level var REFERENCE (the `x` in `int y = x + 2;`). Plant `int x;`,
    // then parse + sema the full expression `x + 2`. The `x` operand routes IdentifierExp → symbolToExp →
    // VarExp (the preamble chain this batch fills); `+ 2` is the Rung-1 equal-int arithmetic. The whole
    // AddExp lands `int`, with its left operand a typed VarExp pointing at the planted `x`.
    const m = new Module(Loc.initial, ds("m.d"), Identifier.idPool(ds("m")), 0, 0);
    const xDecl = new VarDeclaration(Loc.initial, Type.tint32, Identifier.idPool(ds("x")), null);
    const members = new DArray<Dsymbol | null>();
    members.push(xDecl as unknown as Dsymbol);
    m.members = members;
    const sc = scopeCreateGlobal(m, global.errorSink!);
    m.symtab = new DsymbolTable();
    for (let i = 0; i < m.members.length; i++) addMember(m.members.opIndex(i)!, sc, sc.scopesym!);

    const out = semaExpr("x + 2", sc);
    const add = out.isAddExp();
    expect(add).not.toBeNull();
    expect(out.type).toBe(Type.tint32);           // `x + 2` is `int` (ldc2 ground-truth: equal-int add)
    const lhs = add!.e1!.isVarExp();
    expect(lhs).not.toBeNull();                    // the `x` operand resolved to a VarExp
    expect(lhs!.var_).toBe(xDecl as unknown);      // pointing at the planted `x`
    expect(add!.e1!.type).toBe(Type.tint32);       // and is typed `int`
    expect(global.errors).toBe(0);
  });
});

describe("visitVarExp — variable-reference type spine", () => {
  it("takes the type from var.type and resolves to a typed VarExp end-to-end", () => {
    // A VarExp over a VarDeclaration with a deco'd `tint32` type: visitVarExp sets e.type = var.type
    // (already deco'd, so typeSemantic is skipped), then `checkNestedReference` (now ported, funcsem.ts)
    // is a no-op for the module-level var (no enclosing function frame) and the VarExp resolves clean.
    const sc = globalScope();
    const v = new VarDeclaration(Loc.initial, Type.tint32, Identifier.idPool(ds("y")), null);
    const ve = new VarExp(Loc.initial, v);
    const out = expressionSemantic(ve, sc);
    expect(out).toBe(ve);                     // same VarExp node, now typed
    expect(out.op).toBe(EXP.variable);
    expect(out.type).toBe(Type.tint32);       // the type was taken from var.type (already deco'd)
    expect(out.type!.ty).toBe(TY.Tint32);
    expect(global.errors).toBe(0);
  });
});

describe("visitVarDeclaration — pass-1 variable semantic (full body, common case)", () => {
  it("runs a plainly-typed module-level var to COMPLETION (errors === 0, semanticdone, no edtor)", () => {
    // dsymbolSemantic on `int z;` at module scope (no initializer): the WHOLE body now runs — head
    // (semanticRun guard / sequenceNumber / maybeScope), storage-class pickup (`sc.alignment()`),
    // `typeSemantic`, `checkDeprecatedType` (no-op for `int`), alignment defaulting, `checkComplexTransition`
    // (no-op), the validity/placement checks (none fire; parent is the Module), `addStorageClass` (stc==0 ->
    // unchanged), the no-init-non-fd `setInCtorOnly`, `callScopeDtor` (null for a scalar), and finally
    // `semanticRun = PASS.semanticdone`. No deeper sibling is reached on this path — it completes clean.
    const m = new Module(Loc.initial, ds("m.d"), Identifier.idPool(ds("m")), 0, 0);
    const sc = scopeCreateGlobal(m, global.errorSink!);
    const v = new VarDeclaration(Loc.initial, Type.tint32, Identifier.idPool(ds("z")), null);
    dsymbolSemantic(v as unknown as Dsymbol, sc);
    expect(global.errors).toBe(0);
    expect(v.sequenceNumber).toBeGreaterThan(0);   // the head ran (sequence number assigned)
    expect(v.type).toBe(Type.tint32);              // the declared type resolved (typeSemantic, deco'd)
    expect(v.semanticRun).toBe(PASS.semanticdone); // the body ran to completion
    expect(v.edtor).toBeNull();                    // callScopeDtor: no destructor for a scalar
    expect(v.setInCtorOnly).toBe(true);            // no-init non-function-scope var -> ctor-only
  });

  it("runs `int x = 5;` to completion: errors === 0, type tint32, init a folded IntegerExp(5)", () => {
    // The GOAL case: a plainly-typed, plain-mutable, module-level var WITH a constant initializer. The body
    // runs to completion; the `inferType` pushdown leaves the IntegerExp unchanged, and (faithful to dmd at
    // module scope) none of the three init-analysis arms fire for a plain mutable var — the initializer is
    // left as parsed (its full analysis is deferred to semantic2). RESULT: x typed `int`, init IntegerExp(5).
    const m = new Module(Loc.initial, ds("m.d"), Identifier.idPool(ds("m")), 0, 0);
    const sc = scopeCreateGlobal(m, global.errorSink!);
    const init = new ExpInitializer(Loc.initial, new IntegerExp(Loc.initial, 5n, Type.tint32));
    const v = new VarDeclaration(Loc.initial, Type.tint32, Identifier.idPool(ds("x")), init);
    dsymbolSemantic(v as unknown as Dsymbol, sc);
    expect(global.errors).toBe(0);
    expect(v.type).toBe(Type.tint32);
    expect(v.semanticRun).toBe(PASS.semanticdone);
    const ei = v._init!.isExpInitializer();
    expect(ei).not.toBeNull();
    expect(ei!.exp!.op).toBe(EXP.int64);           // an IntegerExp
    expect((ei!.exp as unknown as IntegerExp).value).toBe(5n); // value 5
    expect(ei!.exp!.type).toBe(Type.tint32);       // typed `int` (the parser/inferType type)
  });
});

describe("var-decl through the full `sema()` MODULE driver — ground-truth flips vs ldc2", () => {
  // The same ACCEPT/REJECT flips as sema.decl.test.ts, asserted here at the var-decl level so this file
  // carries the matching ldc2 ground-truth. The two ACCEPTs are REAL (ldc2 VALID, driver errors === 0); the
  // mismatch REJECT is reported by pass 2, as ldc2 reports it.

  it("ACCEPT `int x = 5;`: driver errors === 0, x typed tint32, init folded IntegerExp(5)", () => {
    // ldc2 VALID. End-to-end through runSemantic: pass 1 leaves the init as the parsed IntegerExp (a mutable
    // module var's init analysis is deferred to semantic2, faithful to dmd) and pass 2 analyses it.
    // RE-PIN: `semanticRun` was `PASS.semanticdone` while the driver skipped pass 2; semantic2's var arm
    // ends at `vd.semanticRun = PASS.semantic2done` (semantic2.d:320).
    const { module, errors } = sema("int x = 5;");
    expect(errors).toBe(0);
    const vx = sourceMembers(module)[0]!.isVarDeclaration() as VarDeclaration;
    expect(dsToJs(vx.ident!.toString())).toBe("x");
    expect(vx.type).toBe(Type.tint32);
    expect(vx.semanticRun).toBe(PASS.semantic2done);
    const ei = vx._init!.isExpInitializer();
    expect(ei).not.toBeNull();
    expect(ei!.exp!.op).toBe(EXP.int64);
    expect((ei!.exp as unknown as IntegerExp).value).toBe(5n);
    expect(ei!.exp!.type).toBe(Type.tint32);
  });

  it("ACCEPT `int x = 5; int y = 7;`: driver errors === 0, both vars typed tint32", () => {
    // ldc2 VALID. Two independent plain-mutable module vars; the driver runs both bodies to completion.
    const { module, errors } = sema("int x = 5; int y = 7;");
    expect(errors).toBe(0);
    const members = sourceMembers(module);
    expect(members.length).toBe(2);
    const vx = members[0]!.isVarDeclaration() as VarDeclaration;
    const vy = members[1]!.isVarDeclaration() as VarDeclaration;
    expect(vx.type).toBe(Type.tint32);
    expect(vy.type).toBe(Type.tint32);
    expect(vx.semanticRun).toBe(PASS.semantic2done);   // RE-PIN: pass 2 runs (semantic2.d:320)
    expect(vy.semanticRun).toBe(PASS.semantic2done);
    const eiy = vy._init!.isExpInitializer();
    expect((eiy!.exp as unknown as IntegerExp).value).toBe(7n);
  });

  it("REJECT `int x = \"s\";` PART A: the driver rejects in pass 2, one error, as ldc2", () => {
    // ldc2 REJECTED: `cannot implicitly convert expression "s" of type string to int`. The implicit-cast that
    // raises it runs in the var-decl INIT analysis, which at MODULE scope dmd defers to semantic2
    // (semantic2.d:249). RE-PIN: this asserted `errors === 0` while the driver skipped pass 2.
    const { module, errors } = sema('int x = "s";');
    expect(errors).toBe(1);
    const vx = sourceMembers(module)[0]!.isVarDeclaration() as VarDeclaration;
    expect(vx._init!.isExpInitializer()!.exp!.op).toBe(EXP.error);
    expect(vx.semanticRun).toBe(PASS.semantic2done); // semantic2.d:320 runs after the failed init too
  });

  it("REJECT `int x = \"s\";` PART B: the semantic2 init call (INITinterpret) rejects, as ldc2 does", () => {
    // The EXACT call dmd's semantic2 makes for a module-scope mutable var: `initializerSemantic(sc, type,
    // INITinterpret)` (semantic2.d:249). ldc2: "cannot implicitly convert expression `"s"` of type `string` to
    // `int`" (one error); the init expression becomes an ErrorExp.
    const m = parseModule('int x = "s";');
    const vx = m.members!.opIndex(0)!.isVarDeclaration() as VarDeclaration;
    const sc = scopeCreateGlobal(m, global.errorSink!);
    m.symtab = new DsymbolTable();
    for (let i = 0; i < m.members!.length; i++) addMember(m.members!.opIndex(i)!, sc, sc.scopesym!);
    const ei = vx._init!.isExpInitializer() as ExpInitializer;
    const r = initializerSemantic(ei, sc, { value: vx.type! }, INITinterpret);
    expect(r.isExpInitializer()!.exp!.op).toBe(EXP.error);
    expect(global.errors).toBe(1);
  });
});
