import { describe, test, expect, beforeEach } from "vitest";

// MILESTONE SMOKE TEST — prove the full pipeline lexer -> parser -> AST works on REAL D source.
//
// Unlike parse.test.ts (which drives parseExpression/parseStatement/parseDeclDefs directly), this
// suite drives the public top-level entry point `Parser.parseModule()` on whole-file snippets and
// asserts the resulting AST node shape via the node classes' isXxx()/fields. This is the end-to-end
// goal: a NUL-terminated source buffer in, a structured `Dsymbols` AST out.
//
// SCOPE NOTE (foundational type-construction now landed):
//   The parser is complete, and the AST *type-construction* paths it depends on are now filled:
//     - `Type._init()` (mtype.ts) builds the basic-type singletons `Type.tint32`/`tvoid`/…; called in
//       `beforeEach` (dmd does this at compiler startup). parseBasicType() reads these directly.
//     - `TypeFunction` constructor (mtype.ts) — every function/method declaration return-type path.
//     - `Type.addSTC()` (mtype.ts) — the unqualified path every `parseType()` ends on.
//     - `Dsymbol.addComment` (dsymbol.ts) — parseModule attaches doc comments to every parsed symbol.
//   The two literal task snippets are now asserted directly, end-to-end via parseModule:
//     * "int x = 1 + 2;"    -> a VarDeclaration whose `.type` is the basic int singleton and whose
//                              `._init` is an ExpInitializer wrapping an AddExp.
//     * "void f(){return;}" -> a FuncDeclaration whose `.type` is a TypeFunction and whose `.fbody`
//                              is a CompoundStatement containing a ReturnStatement.
//   (Qualified type construction — const/immutable makeXxx, deco/merge — remains TODO-BODY but is not
//    reached by these snippets.)

import { Parser } from "./parse.js";
import { EXP, initTokens } from "./tokens.js";
import { Id } from "./id.js";
import { Loc } from "./location.js";
import { ErrorSinkNull } from "./errorsink.js";
import { Type } from "./mtype.js";
import { TY } from "./astenums.js";
import { dsToJs } from "../dstring.js";
import type { DString } from "../dstring.js";

import type { EnumDeclaration, EnumMember } from "./denum.js";
import type { Import } from "./dimport.js";
import type { StaticAssert } from "./staticassert.js";
import type { CallExp } from "./expression.js";
import type { WithStatement } from "./statement.js";
import { Type_init } from "./typesem.js";

beforeEach(() => {
  Loc._init();
  initTokens();
  Id.initialize();
  // Build the basic-type singletons (Type.tint32/tvoid/…) as dmd does at compiler startup; the
  // declarator/return-type paths read these directly. (Foundational type-construction now landed.)
  Type_init();
});

/** NUL-terminated byte buffer from an ASCII/Latin-1 string (the lexer scans `.ptr` to a NUL),
 *  built exactly as lexer.test.ts / parse.test.ts do. */
function srcBuf(s: string): DString {
  const b = new Uint8Array(s.length + 1);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  b[s.length] = 0;
  return b;
}

/** A Parser over `src`, primed (nextToken) and ready for parseModule()/parseStatement()/… */
function mkParser(src: string): Parser {
  const p = new Parser(null, null, srcBuf(src), false, new ErrorSinkNull(), null, false);
  p.nextToken();
  return p;
}

describe("parse.smoke (milestone: lexer -> parser -> AST on real D source)", () => {
  // ── Snippet 3 (verbatim from the task): enum with two members, end-to-end via parseModule ──────
  test('"enum E { a, b }" -> Module-level EnumDeclaration with 2 members', () => {
    const decls = mkParser("enum E { a, b }").parseModule();

    expect(decls.length).toBe(1);
    const ed = decls.opIndex(0) as EnumDeclaration;
    expect(ed.constructor.name).toBe("EnumDeclaration");
    expect(dsToJs(ed.ident!.toString())).toBe("E");

    expect(ed.members!.length).toBe(2);
    const a = ed.members!.opIndex(0) as EnumMember;
    const b = ed.members!.opIndex(1) as EnumMember;
    expect(a.constructor.name).toBe("EnumMember");
    expect(b.constructor.name).toBe("EnumMember");
    expect(dsToJs(a.ident!.toString())).toBe("a");
    expect(dsToJs(b.ident!.toString())).toBe("b");
    // bare members carry no initializer value
    expect(a.value).toBeNull();
    expect(b.value).toBeNull();
  });

  // ── Snippet 1 (verbatim from the task): "int x = 1 + 2;" -> a VarDeclaration whose type is the
  //    basic int singleton and whose initializer is an ExpInitializer wrapping an AddExp. ───────────
  test('"int x = 1 + 2;" -> VarDeclaration(type=int, init=ExpInitializer(AddExp))', () => {
    const decls = mkParser("int x = 1 + 2;").parseModule();

    expect(decls.length).toBe(1);
    const vd = decls.opIndex(0)!.isVarDeclaration();
    expect(vd).not.toBeNull();
    expect(dsToJs(vd!.ident!.toString())).toBe("x");

    // type is the basic `int` singleton built by Type._init (no qualifier/merge involved)
    expect(vd!.type).toBe(Type.tint32);
    expect(vd!.type!.ty).toBe(TY.Tint32);
    expect(vd!.type!.constructor.name).toBe("TypeBasic");

    // initializer: `= 1 + 2` -> ExpInitializer holding the AddExp
    const ei = vd!._init!.isExpInitializer();
    expect(ei).not.toBeNull();
    expect(ei!.exp!.op).toBe(EXP.add);
    expect(ei!.exp!.constructor.name).toBe("AddExp");
  });

  // Direct proof of the same `1 + 2` -> AddExp at the expression entry point (no type construction).
  test('"1 + 2" -> AddExp (parseExpression)', () => {
    const e = mkParser("1 + 2").parseExpression();
    expect(e.op).toBe(EXP.add);
    expect(e.constructor.name).toBe("AddExp");
  });

  // ── Snippet 2 (verbatim from the task): "void f() { return; }" -> a FuncDeclaration whose type is a
  //    TypeFunction and whose body is a CompoundStatement containing a ReturnStatement. ─────────────
  test('"void f() { return; }" -> FuncDeclaration(type=TypeFunction, body={ return; })', () => {
    const decls = mkParser("void f() { return; }").parseModule();

    expect(decls.length).toBe(1);
    const fd = decls.opIndex(0)!.isFuncDeclaration();
    expect(fd).not.toBeNull();
    expect(dsToJs(fd!.ident!.toString())).toBe("f");

    // signature type is a TypeFunction (return type `void`). Param count is not asserted: counting
    // routes through Parameter._foreach, still TODO-BODY — unrelated to the milestone, not forced.
    const tf = fd!.type!.isTypeFunction();
    expect(tf).not.toBeNull();
    expect(tf!.next).toBe(Type.tvoid); // return type

    // body: `{ return; }` -> CompoundStatement with a single ReturnStatement
    const cs = fd!.fbody!.isCompoundStatement();
    expect(cs).not.toBeNull();
    expect(cs!.statements!.length).toBe(1);
    const ret = cs!.statements!.opIndex(0)!.isReturnStatement();
    expect(ret).not.toBeNull();
    expect(ret!.constructor.name).toBe("ReturnStatement");
  });

  // ── Module declaration + content, end-to-end (exercises the parseModuleDeclaration path, which
  //    attaches a doc comment to the Module symbol via the now-filled Dsymbol.addComment). ─────────
  test('"module m; enum E { a, b }" -> module decl parsed, EnumDeclaration follows', () => {
    const p = mkParser("module m; enum E { a, b }");
    const decls = p.parseModule();

    expect(p.md).not.toBeNull(); // ModuleDeclaration captured
    expect(dsToJs(p.md!.id!.toString())).toBe("m");

    expect(decls.length).toBe(1);
    expect(decls.opIndex(0)!.constructor.name).toBe("EnumDeclaration");
  });

  // ── Import declaration, end-to-end via parseModule. ────────────────────────────────────────────
  test('"import std.stdio;" -> Module-level Import (packages=[std], id=stdio)', () => {
    const decls = mkParser("import std.stdio;").parseModule();

    expect(decls.length).toBe(1);
    const imp = decls.opIndex(0) as Import;
    expect(imp.constructor.name).toBe("Import");
    // reconciled to faithful surface (W2): dimport.ts types `packages` as `Identifier[] | null`
    // (dmd/dimport.d:36 `Identifier[] packages`, null for an unqualified import).
    expect(imp.packages!.length).toBe(1);
    expect(dsToJs(imp.packages![0]!.toString())).toBe("std");
    expect(dsToJs(imp.id!.toString())).toBe("stdio");
  });

  // ── static assert, end-to-end via parseModule (no type construction). ──────────────────────────
  test('"static assert(1 == 1);" -> Module-level StaticAssert with an EqualExp', () => {
    const decls = mkParser("static assert(1 == 1);").parseModule();

    expect(decls.length).toBe(1);
    const sa = decls.opIndex(0) as StaticAssert;
    expect(sa.constructor.name).toBe("StaticAssert");
    expect(sa.exp!.op).toBe(EXP.equal);
  });

  // ── 1.42 -> 1.43 GRAMMAR DRIFT (wave W0) ───────────────────────────────────────────────────────
  // Three parse-visible changes in dmd 2.113's parse.d, driven end-to-end through parseModule.
  // Two node classes still carry their 1.42 ctor: BitFieldDeclaration (its `_init` parameter — the
  // parser compensates with a post-construction store, so the accept test below holds) and
  // WithStatement (its `prm` slot — no compensation is possible, so parse.ts walls and the test
  // below is a pinned wall, 10 §1.8). Both are `dependency signature` escalations.

  // parse.d:4816 — a bitfield may now carry an initializer; the 1.42 diagnostic
  // "initializer not allowed for bitfield declaration" is gone and `_init` reaches the declaration.
  test('"struct S { int a : 3 = 5; }" -> BitFieldDeclaration keeps its initializer (1.43)', () => {
    const decls = mkParser("struct S { int a : 3 = 5; }").parseModule();

    const sd = decls.opIndex(0)!.isStructDeclaration();
    expect(sd).not.toBeNull();
    const bf = sd!.members!.opIndex(0)!.isBitFieldDeclaration();
    expect(bf).not.toBeNull();
    expect(dsToJs(bf!.ident!.toString())).toBe("a");
    expect(bf!.width!.constructor.name).toBe("IntegerExp");
    // 1.43: the initializer is kept (1.42 rejected it outright)
    expect(bf!._init!.isExpInitializer()).not.toBeNull();
  });

  // parse.d:8912 — `immutable(T)(args)` goes through parseNamedArguments, so the call carries
  // argument LABELS (1.42 used parseArguments and had no `names`). Driven end-to-end through
  // parseModule (this suite's entry point) by putting the expression in a variable initializer.
  test('"immutable(int)(a: 1)" -> CallExp with one named argument', () => {
    const decls = mkParser("auto v = immutable(int)(a: 1);").parseModule();

    const vd = decls.opIndex(0)!.isVarDeclaration();
    expect(vd).not.toBeNull();
    const e = vd!._init!.isExpInitializer()!.exp as CallExp;

    expect(e.constructor.name).toBe("CallExp");
    expect(e.arguments_!.length).toBe(1);
    expect(e.names!.length).toBe(1);
    expect(dsToJs(e.names!.opIndex(0)!.name!.toString())).toBe("a");
  });

  // RE-PINNED (10 §1.8 rule 5) — the wall this test pinned is GONE, so the pin is retired for the
  // accept assertion its own comment prescribed. statement.ts now carries the 1.43 `Parameter prm`
  // slot and the 5-param ctor (dmd/statement.d:1476/:1482), and parse.d:6683 builds
  // `new AST.WithStatement(loc, param, exp, _body, endloc)` with the `param` returned by
  // `parseAssignCondition(true)` (dmd/parse.d:6681) — the D dispatch line proving this input takes
  // the binding path, not the plain `with (e)` one.
  test('"with (auto x = 3) { }" -> WithStatement carrying the prm pattern binding', () => {
    const decls = mkParser("void f() { with (auto x = 3) { } }").parseModule();

    const fd = decls.opIndex(0)!.isFuncDeclaration();
    expect(fd).not.toBeNull();
    const s = fd!.fbody!.isCompoundStatement()!.statements!.opIndex(0) as WithStatement;
    expect(s.constructor.name).toBe("WithStatement");
    expect(s.prm).not.toBeNull();
    expect(dsToJs(s.prm!.ident!.toString())).toBe("x");
    expect(s.exp!.constructor.name).toBe("IntegerExp");
  });

  // Fall-through proof that the wall above sits ONLY on the path D takes into the missing slot:
  // the plain `with (exp)` form (param == null) parses identically in 1.42 and 1.43.
  test('"with (3) { }" -> WithStatement (no pattern binding, unwalled)', () => {
    const decls = mkParser("void f() { with (3) { } }").parseModule();

    const fd = decls.opIndex(0)!.isFuncDeclaration();
    expect(fd).not.toBeNull();
    const s = fd!.fbody!.isCompoundStatement()!.statements!.opIndex(0) as WithStatement;
    expect(s.constructor.name).toBe("WithStatement");
    expect(s.exp!.constructor.name).toBe("IntegerExp");
    expect(s._body!.constructor.name).toBe("ScopeStatement");
  });
});
