import { describe, it, expect, beforeEach } from "vitest";

// SEMA PHASE-4b STRUCT-TYPED-LOCAL GOAL TESTS.
//
// These protect the deliverable: a no-initializer struct-typed LOCAL (`struct S{ int x; } void f(){ S s; }`)
// ACCEPTS end-to-end through runSemantic. Three fills compose: (1) TypeIdentifier resolution — the `S` in
// f's body runs typeSemantic(visitIdentifier) -> resolve -> resolveHelper -> getType -> merge and lands on
// the SAME interned TypeStruct the declaration produced; (2) visitVarDeclaration drives the local through
// pass-3; (3) default-initializer synthesis (dmd/dsymbolsem.d:2202-2214): for a zeroInit struct the init is
// a hand-painted BlitExp(VarExp(s), IntegerExp.literal!0) with `e.type = dsym.type` force-set ("don't type
// check this, it would fail") and a `goto Ldtor` that skips the ENTIRE init-analysis block (no
// expressionSemantic, no implicitCastTo); the Ldtor tail leaves edtor null for a POD (callScopeDtor
// early-out, dmd/dsymbolsem.d:8457-8458) and propagates endlinnum from the function-body scope.
//
// GROUND-TRUTH (ldc2-1.42.0 = DMD v2.112.1 on arm64, `-c -o-` / `-vcg-ast`; probes p1-p9 in /tmp/djs4b):
//   p1 `struct S{ int x; } void f(){ S s; }`         -> ACCEPT; lowered body exactly `S s = 0;`
//   p2 `struct E{ } void f(){ E e; }`                -> ACCEPT; `E e = 0;` (E.sizeof==1, size!=0 guard passes)
//   p3 `struct M{ int a; long b; } void f(){ M m; }` -> ACCEPT; `M m = 0;`
//   p4 `struct S{ int x; } void f(){ S a; S b; }`    -> ACCEPT; `S a = 0; S b = 0;` (two independent inits)
//   p6/p9 `typeof(s).mangleof == S.mangleof` (e.g. `S2p91S`) and `is(typeof(s) == S)` is true
//         -> s.type IS the same merged TypeStruct as S.type; S.zeroInit selects the `= 0` blit path.
// All pinned below.

import { Parser } from "./parse.js";
import { Identifier } from "./identifier.js";
import { ds, dsToJs } from "../dstring.js";
import { Loc } from "./location.js";
import { ErrorSinkNull } from "./errorsink.js";
import { Type } from "./mtype.js";
import { EXP } from "./tokens.js";
import { PASS } from "./dsymbol.js";
import { global } from "./globals.js";
import { Module, moduleFromParse } from "./dmodule.js";
import { runSemantic } from "./dsymbolsem.js";
import { IntegerExp, BlitExp, VarExp } from "./expression.js";
import { ExpStatement } from "./statement.js";
import type { CompoundStatement } from "./statement.js";
import type { DeclarationExp } from "./expression.js";
import type { FuncDeclaration } from "./func.js";
import type { VarDeclaration } from "./declaration.js";
import type { StructDeclaration } from "./dstruct.js";
import type { Dsymbol } from "./dsymbol.js";
import { initSemaHarness, sourceMembers, userBody } from "../sema-harness.js";

beforeEach(() => {
  initSemaHarness();
});

function srcBuf(s: string): Uint8Array {
  const b = new Uint8Array(s.length + 1);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  b[s.length] = 0;
  return b;
}

/** Parse-only build of a Module (no sema). */
function parseModule(src: string): Module {
  const p = new Parser(null, null, srcBuf(src), false, new ErrorSinkNull(), null, false);
  p.nextToken();
  const members = p.parseModule();
  return moduleFromParse(members, p.md);
}

/** lex+parse `src` into a Module, run the `runSemantic` driver (passes 0-3), return the module + error count. */
function sema(src: string): { module: Module; errors: number } {
  const m = parseModule(src);
  runSemantic(m);
  return { module: m, errors: global.errors };
}

/** Find a top-level StructDeclaration by name in the semantic'd module's symbol table. The symtab is
 * keyed by interned Identifiers, so we look up the SAME interned identifier the parser produced. */
function findStruct(m: Module, name: string): StructDeclaration {
  const sym: Dsymbol | null = m.symtab ? m.symtab.lookup(Identifier.idPool(ds(name))) : null;
  expect(sym).not.toBeNull();
  const sd = sym!.isStructDeclaration();
  expect(sd).not.toBeNull();
  return sd!;
}

/** The i-th top-level member as a FuncDeclaration (in `struct S{...} void f(){...}` the func is index 1). */
function nthFunc(m: Module, i: number): FuncDeclaration {
  const fd = sourceMembers(m)[i]!.isFuncDeclaration();
  expect(fd).not.toBeNull();
  return fd!;
}

/** Locate the i-th local of `fd`: userBody -> statements[i] (ExpStatement) -> .exp (DeclarationExp) ->
 * .declaration.isVarDeclaration(). Post-sema a ONE-statement body IS its lone statement — DMD's
 * compoundStatementSemantic returns `(*cs.statements)[0]` instead of the CompoundStatement wrapper
 * (dmd/statementsem.d:452-456) — so `void f(){ S s; }` has userBody === the ExpStatement directly. */
function localVar(fd: FuncDeclaration, i: number): VarDeclaration {
  const body = userBody(fd);
  const stmt = body instanceof ExpStatement ? body : (body as unknown as CompoundStatement).statements!.opIndex(i);
  if (body instanceof ExpStatement) expect(i).toBe(0); // flattened body: only statement 0 exists
  const es = stmt as ExpStatement;
  expect(es).toBeInstanceOf(ExpStatement);
  const de = es.exp as unknown as DeclarationExp;
  const vd = de.declaration!.isVarDeclaration();
  expect(vd).not.toBeNull();
  return vd!;
}

describe("Phase 4b — synthesized init shape for `struct S{ int x; } void f(){ S s; }`", () => {
  it("vd._init is ExpInitializer(BlitExp(VarExp(s), literal!0)) painted S, no sema run (ldc2 p1: `S s = 0;`)", () => {
    const { module: m, errors } = sema("struct S{ int x; } void f(){ S s; }");
    expect(errors).toBe(0);
    const sd = findStruct(m, "S");
    const fd = nthFunc(m, 1);
    const vd = localVar(fd, 0);
    expect(dsToJs(vd.ident!.toString())).toBe("s");

    // GOAL: _init is an ExpInitializer built at dsym.loc (dmd:2213 `new ExpInitializer(dsym.loc, e)`).
    const ei = vd._init!.isExpInitializer();
    expect(ei).not.toBeNull();
    expect(ei!.loc).toBe(vd.loc);

    // GOAL: its exp is the BlitExp built at dmd:2211, op EXP.blit, at dsym.loc.
    const blit = ei!.exp as BlitExp;
    expect(blit).toBeInstanceOf(BlitExp);
    expect(blit.op).toBe(EXP.blit);
    expect(blit.loc).toBe(vd.loc);

    // GOAL: blit.type was painted BY HAND to the struct type (dmd:2212 `e.type = dsym.type` — "don't
    // type check this, it would fail"). Pointer identity with the merged TypeStruct, both ways.
    expect(blit.type).toBe(sd.type);
    expect(blit.type).toBe(vd.type);

    // GOAL: e1 is VarExp(s) at dsym.loc — var IS the VarDeclaration; typed S by the VarExp ctor
    // (expression.d:2364) with hasOverloads forced false for a VarDeclaration (expression.d:2357-2358).
    const e1 = blit.e1 as VarExp;
    expect(e1).toBeInstanceOf(VarExp);
    expect(e1.var_).toBe(vd);
    expect(e1.type).toBe(sd.type);
    expect(e1.loc).toBe(vd.loc);
    expect(e1.hasOverloads).toBe(false);

    // GOAL: e2 is the cached IntegerExp.literal!0 singleton (expression.d:904): value 0, typed Tint32,
    // loc Loc.initial — the singleton's own properties, NEVER repainted by the synthesis.
    const e2 = blit.e2 as IntegerExp;
    expect(e2).toBeInstanceOf(IntegerExp);
    expect(e2).toBe(IntegerExp.literal(0));
    expect(e2.value).toBe(0n);
    expect(e2.type).toBe(Type.tint32); // identity — sound because beforeEach resets the literal cache
    expect(e2.loc).toBe(Loc.initial);
  });
});

describe("Phase 4b — ACCEPT `struct S{ int x; } void f(){ S s; }` (ldc2 p1: exit 0, no diagnostics)", () => {
  it("errors 0; f reaches semantic3done; the local is reachable via userBody->ExpStatement->DeclarationExp", () => {
    const { module: m, errors } = sema("struct S{ int x; } void f(){ S s; }");
    expect(errors).toBe(0);

    const fd = nthFunc(m, 1);
    expect(fd.semanticRun).toBe(PASS.semantic3done);

    const vd = localVar(fd, 0);
    expect(dsToJs(vd.ident!.toString())).toBe("s");
  });
});

describe("Phase 4b — type identity: s.type IS the merged TypeStruct (ldc2 p6/p9)", () => {
  it("s.type === S.type (pointer equality; ldc2: typeof(s).mangleof == S.mangleof, is(typeof(s)==S))", () => {
    const { module: m, errors } = sema("struct S{ int x; } void f(){ S s; }");
    expect(errors).toBe(0);
    const sd = findStruct(m, "S");
    const vd = localVar(nthFunc(m, 1), 0);

    // GOAL (the heart of fill1): TypeIdentifier `S` resolved to the SAME interned TypeStruct object the
    // struct declaration produced — not a structurally-equal copy.
    expect(vd.type).toBe(sd.type);
    expect(vd.type!.isTypeStruct()!.sym).toBe(sd);
    expect(vd.type!.deco).not.toBeNull(); // interned (merge set the deco)
  });
});

describe("Phase 4b — singleton sharing across two locals `struct S{ int x; } void f(){ S a; S b; }`", () => {
  it("distinct ExpInitializer/BlitExp per local, but ONE shared IntegerExp.literal!0 (ldc2 p4: two `= 0`)", () => {
    const { module: m, errors } = sema("struct S{ int x; } void f(){ S a; S b; }");
    expect(errors).toBe(0);
    const fd = nthFunc(m, 1);
    expect(fd.semanticRun).toBe(PASS.semantic3done);

    const va = localVar(fd, 0);
    const vb = localVar(fd, 1);
    expect(dsToJs(va.ident!.toString())).toBe("a");
    expect(dsToJs(vb.ident!.toString())).toBe("b");

    // Each local got its OWN synthesized init (ldc2 p4: independent `S a = 0;` / `S b = 0;`).
    const ia = va._init!.isExpInitializer()!;
    const ib = vb._init!.isExpInitializer()!;
    expect(ia).not.toBeNull();
    expect(ib).not.toBeNull();
    expect(ia).not.toBe(ib);

    const ba = ia.exp as BlitExp;
    const bb = ib.exp as BlitExp;
    expect(ba).toBeInstanceOf(BlitExp);
    expect(bb).toBeInstanceOf(BlitExp);
    expect(ba).not.toBe(bb);

    // ... but the blit RHS is the SAME cached singleton (expression.d:904 `__gshared` per-value cache).
    expect(ba.e2).toBe(bb.e2);
    expect(ba.e2).toBe(IntegerExp.literal(0));
  });
});

describe("Phase 4b — Ldtor tail: POD local has no dtor (ldc2 p1: no scope-exit in the .cg)", () => {
  it("vd.edtor null (callScopeDtor early-out, dmd:8457); semanticdone; endlinnum propagated (dmd:2556)", () => {
    const { module: m, errors } = sema("struct S{ int x; } void f(){ S s; }");
    expect(errors).toBe(0);
    const vd = localVar(nthFunc(m, 1), 0);

    // GOAL: edtor stays null — sd.dtor is null for the POD (buildDtors `case 0: break;`, clone.d:1025),
    // so callScopeDtor returns null (dmd/dsymbolsem.d:8457-8458).
    expect(vd.edtor).toBeNull();
    // dsymbolSemantic set semanticdone (dmd:2551), then DeclarationExp semantic ran the declaration's
    // semantic2 (dmd/expressionsem.d:7867-7871) whose tail sets semantic2done (dmd/semantic2.d:320).
    // For a FUNC-LOCAL var semantic2 skips initializerSemantic (`!vd.toParent().isFuncDeclaration()`,
    // semantic2.d:233), so the hand-painted blit is never type-checked — the shape test above proves it.
    expect(vd.semanticRun).toBe(PASS.semantic2done);
    // endlinnum was copied from the function-body ScopeDsymbol (dmd:2556-2561; = funcdecl.endloc.linnum,
    // which is 1 for this one-line source — pinning the exact value protects the propagation SOURCE).
    expect(vd.endlinnum).toBe(1);
  });
});

describe("Phase 4b — empty struct local `struct E{ } void f(){ E e; }` (ldc2 p2: `E e = 0;`)", () => {
  it("ACCEPTS: errors 0 (E.sizeof==1, so the size!=0 synthesis guard passes); f semantic3done", () => {
    const { module: m, errors } = sema("struct E{ } void f(){ E e; }");
    expect(errors).toBe(0);
    const fd = nthFunc(m, 1);
    expect(fd.semanticRun).toBe(PASS.semantic3done);
    const vd = localVar(fd, 0);
    expect(vd._init!.isExpInitializer()).not.toBeNull(); // blit-0 path taken (E.zeroInit true)
  });
});

describe("Phase 4b — mixed-width struct local `struct M{ int a; long b; } void f(){ M m; }` (ldc2 p3)", () => {
  it("ACCEPTS: errors 0 (lowered `M m = 0;`); f semantic3done", () => {
    const { module: m, errors } = sema("struct M{ int a; long b; } void f(){ M m; }");
    expect(errors).toBe(0);
    const fd = nthFunc(m, 1);
    expect(fd.semanticRun).toBe(PASS.semantic3done);
    const vd = localVar(fd, 0);
    expect(vd._init!.isExpInitializer()).not.toBeNull(); // blit-0 path taken (M.zeroInit true)
  });
});

describe("Phase 4b — zeroInit precondition (dmd/dsymbolsem.d:9396-9430)", () => {
  it("S.zeroInit === true after sema — it is what selects the blit-0 path over defaultInitLiteral", () => {
    const { module: m, errors } = sema("struct S{ int x; } void f(){ S s; }");
    expect(errors).toBe(0);
    // ldc2 pin: all probe structs are zeroInit (an int field with no init keeps zeroInit true).
    expect(findStruct(m, "S").zeroInit).toBe(true);
  });
});
