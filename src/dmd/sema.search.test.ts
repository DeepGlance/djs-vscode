import { describe, test, expect, beforeEach } from "vitest";

// SEMA SYMBOL-TABLE TEST — prove the Rung-2 name-lookup machinery works:
//   1. the ADD-MEMBER pre-pass (addMember → ScopeDsymbol.symtabInsert) populates a module's symbol
//      table with its members — exactly the loop DsymbolSemanticVisitor.visitModule runs BEFORE the
//      per-member dsymbolSemantic pass;
//   2. Scope.search (dscope.ts) walks the enclosing-scope chain and dispatches the free `search()`
//      (dsymbolsem.ts → SearchVisitor.visitModule → visitScopeDsymbol → symtab.lookup);
//   3. a planted module-level VarDeclaration is found by an unqualified Scope.search for its name.
//
// This drives the add-member + search machinery in ISOLATION from the per-member VarDeclaration
// dsymbolSemantic analysis (DsymbolSemanticVisitor.visitVarDeclaration), which is a LATER rung — at
// this rung the per-member pass would hit the unported base `visit(Dsymbol)` ("has no semantic
// routine"). The add-member pre-pass and Scope.search are the Rung-2 deliverables under test here.
//
// GOAL TEST (task): a planted VarDeclaration is found by Scope.search.

import { initTokens } from "./tokens.js";
import { Id } from "./id.js";
import { Loc } from "./location.js";
import { ErrorSinkNull } from "./errorsink.js";
import { Type } from "./mtype.js";
import { global } from "./globals.js";
import { Module } from "./dmodule.js";
import { addMember, search, scopeCreateGlobal, searchScope } from "./dsymbolsem.js";
import { Scope } from "./dscope.js";
import { DsymbolTable } from "./dsymbol.js";
import { Identifier } from "./identifier.js";
import { VarDeclaration } from "./declaration.js";
import { Array as DArray } from "./root/array.js";
import { ds } from "../dstring.js";
import type { Dsymbol } from "./dsymbol.js";
import { Type_init } from "./typesem.js";
import { initImphint } from "./imphint.js";

beforeEach(() => {
  // Compiler-startup state the sema paths read directly (mirrors dmd at startup).
  Loc._init();
  initTokens();
  Id.initialize();
  Type_init();
  initImphint(); // imphint.d's `shared static this()` (01 §5.1) — the not-found tail reads its table
  global.errorSink = new ErrorSinkNull();
  global.errors = 0;
  Module.deferred.setDim(0);
  Module.deferred2.setDim(0);
  Module.deferred3.setDim(0);
});

/**
 * Build a bare Module holding one planted module-level `VarDeclaration` (no parser/per-member sema),
 * give it a root scope via `Scope.createGlobal`, and run the ADD-MEMBER pre-pass exactly as
 * `DsymbolSemanticVisitor.visitModule` does: `m.symtab = new DsymbolTable()` then `addMember(member,
 * sc, sc.scopesym)` for each member (here `sc.scopesym === m`, the Module createGlobal pushed).
 *
 * Returns the module scope `sc` (its `scopesym` is the Module) and the planted variable, ready for an
 * unqualified `Scope.search`.
 */
function plantVar(name: string): { sc: Scope; varDecl: VarDeclaration; ident: Identifier } {
  const m = new Module(Loc.initial, ds("m.d"), Identifier.idPool(ds("m")), 0, 0);
  const ident = Identifier.idPool(ds(name));
  // `int <name>;` as a planted node — `tint32` type, no initializer (type alone satisfies the ctor).
  const varDecl = new VarDeclaration(Loc.initial, Type.tint32, ident, null);
  const members = new DArray<Dsymbol | null>();
  members.push(varDecl as unknown as Dsymbol);
  m.members = members;

  const sc = scopeCreateGlobal(m, global.errorSink!);
  // ADD-MEMBER PRE-PASS (mirror of visitModule's symtab build + addMember loop).
  m.symtab = new DsymbolTable();
  for (let i = 0; i < m.members.length; i++) {
    addMember(m.members.opIndex(i)!, sc, sc.scopesym!);
  }
  return { sc, varDecl, ident };
}

describe("Scope.search finds a planted module-level VarDeclaration", () => {
  test("add-member pre-pass inserts the variable into the module symtab", () => {
    const { sc, varDecl, ident } = plantVar("x");
    const m = sc.scopesym as unknown as Module;
    expect(m.symtab).not.toBeNull();
    const found = m.symtab!.lookup(ident);
    expect(found).toBe(varDecl as unknown as Dsymbol);
    // Parent was recorded by addMember.
    expect(varDecl.parent).toBe(m as unknown as Dsymbol);
  });

  test("free search() finds the variable via the Module → ScopeDsymbol symtab lookup", () => {
    const { sc, varDecl, ident } = plantVar("x");
    const m = sc.scopesym as unknown as Dsymbol;
    const found = search(m, Loc.initial, ident);
    expect(found).toBe(varDecl as unknown as Dsymbol);
  });

  test("Scope.search resolves the unqualified name to the planted VarDeclaration", () => {
    const { sc, varDecl, ident } = plantVar("x");
    const pscopesym: { value: Dsymbol | null } = { value: null };
    const found = searchScope(sc, Loc.initial, ident, pscopesym);

    expect(found).toBe(varDecl as unknown as Dsymbol);
    expect(found!.isVarDeclaration()).not.toBeNull();
    // The out-param reports the scopesym that owned the hit (the Module).
    expect(pscopesym.value).toBe(sc.scopesym as unknown as Dsymbol);
  });

  test("Scope.search returns null for a name that was never planted", () => {
    const { sc } = plantVar("x");
    const missing = Identifier.idPool(ds("nope"));
    const pscopesym: { value: Dsymbol | null } = { value: null };
    const found = searchScope(sc, Loc.initial, missing, pscopesym);
    expect(found).toBeNull();
    expect(pscopesym.value).toBeNull();
  });

  test("the search cache is consulted on a repeat lookup (no errors emitted)", () => {
    const { sc, varDecl, ident } = plantVar("x");
    const box: { value: Dsymbol | null } = { value: null };
    const first = searchScope(sc, Loc.initial, ident, box);
    const second = searchScope(sc, Loc.initial, ident, box);
    expect(first).toBe(varDecl as unknown as Dsymbol);
    expect(second).toBe(varDecl as unknown as Dsymbol);
    expect(global.errors).toBe(0);
  });
});
