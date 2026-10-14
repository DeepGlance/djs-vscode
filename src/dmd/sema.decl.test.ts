import { describe, test, expect, beforeEach } from "vitest";

// SEMA RUNG-2 DECLARATION GOAL TEST — drive module-scope variable declarations through the whole
// `sema(src)` MODULE driver (the helper from sema.smoke.test.ts: lex -> parse -> moduleFromParse ->
// runSemantic, passes 0-3) and assert the driver outcome, ground-truthed against ldc2-1.43.0.
//
// THE TASK'S BUCKETS (verbatim), each pinned to its ldc2 ground-truth
// (<ldc2-1.43.0>/bin/ldc2 -c -o- <file.d>; "compiles" == no Error):
//
//   ACCEPT  `int x = 5;`            -> ldc2 VALID (no Error). Through the djs driver: errors === 0, the
//           module's VarDeclaration `x` is typed `Type.tint32`, and its initializer is a folded
//           `IntegerExp` of value 5 typed `tint32`. Asserted END-TO-END below. REAL accept.
//   ACCEPT  `int x = 5; int y = 7;` -> ldc2 VALID (no Error). djs driver: errors === 0, both vars typed
//           `tint32`. REAL accept.
//   REJECT  `int x = "s";`          -> ldc2 REJECTED: `cannot implicitly convert expression "s" of type
//           string to int`. The implicit-cast that raises it lives in the var-decl INIT analysis, which at
//           MODULE scope dmd runs in `semantic2` via `initializerSemantic(sc, type, INITinterpret)`
//           (semantic2.d:249), NOT in pass-1. `runSemantic` runs pass 2, so the driver reports it with
//           ldc2's text; PART B also drives that one init call directly.
//   REJECT  `int x = 1; int y = x + 2;` at MODULE scope -> ldc2 REJECTED: `static variable x cannot be read
//           at compile time` (a CTFE read of a RUNTIME static inside another module-scope initializer). Like
//           the mismatch above, this reject lives in semantic2's `initializerSemantic(INITinterpret)`, and
//           the driver reports it with ldc2's text; the typed AddExp-over-VarExp SHAPE (the function-scope
//           accept form) is demonstrated at the unit level in sema.var.test.ts.
//   REJECT  `int x=1; int x=2;`     -> ldc2 REJECTED: `variable redef.x conflicts with variable redef.x`.
//           REAL reject reached END-TO-END: `multiplyDefined` emits in the ADD-MEMBER PRE-PASS (the symtab
//           build `visitModule` runs FIRST, dsymbolsem.ts), so the driver returns errors > 0 with no throw.
//
// Every expected outcome is the ldc2 one. Where a reject lives in a later pass, the test says which pass.

import { Parser } from "./parse.js";
import { ErrorSinkNull } from "./errorsink.js";
import { Type } from "./mtype.js";
import { EXP } from "./tokens.js";
import { PASS } from "./dsymbol.js";
import { global } from "./globals.js";
import { Module, moduleFromParse } from "./dmodule.js";
import { runSemantic, addMember, scopeCreateGlobal } from "./dsymbolsem.js";
import { DsymbolTable } from "./dsymbol.js";
import { initializerSemantic } from "./initsem.js";
import { INITinterpret } from "./init.js";
import { setDiagnosticHandler } from "./errors.js";
import { dmdformat } from "./root/dmdformat.js";
import { dsToJs } from "../dstring.js";
import type { Dsymbols } from "./arraytypes.js";
import type { VarDeclaration } from "./declaration.js";
import type { IntegerExp } from "./expression.js";
import type { ExpInitializer } from "./init.js";
import { initSemaHarness, sourceMembers } from "../sema-harness.js";

beforeEach(() => {
  initSemaHarness();
});

/** NUL-terminated byte buffer (the lexer scans `.ptr` to a NUL), built exactly as sema.smoke.test.ts. */
function srcBuf(s: string): Uint8Array {
  const b = new Uint8Array(s.length + 1);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  b[s.length] = 0;
  return b;
}

/**
 * The `sema(src)` MODULE helper, verbatim from sema.smoke.test.ts: lex+parse `src` into a Module, run the
 * `runSemantic` driver (passes 0-3) over it, and return the module together with the resulting global error count.
 * Throws verbatim if the pass reaches a deferred sibling (the caller pins that with `.toThrow`).
 */
function sema(src: string): { module: Module; errors: number } {
  const p = new Parser(null, null, srcBuf(src), false, new ErrorSinkNull(), null, false);
  p.nextToken();
  const members: Dsymbols = p.parseModule();
  const m = moduleFromParse(members, p.md);
  runSemantic(m);
  return { module: m, errors: global.errors };
}

/** `sema(src)` with every diagnostic rendered through dmdformat and captured instead of printed. */
function semaDiagnostics(src: string): { module: Module; errors: number; messages: string[] } {
  const messages: string[] = [];
  setDiagnosticHandler((_loc, _color, _header, messageFormat, args) => {
    messages.push(dsToJs(dmdformat(messageFormat, [...args])));
    return true;
  });
  try {
    return { ...sema(src), messages };
  } finally {
    setDiagnosticHandler(null);
  }
}

/** Parse-only build of a Module (no sema), to inspect the reachable parsed AST / plant a symtab. */
function parseModule(src: string): Module {
  const p = new Parser(null, null, srcBuf(src), false, new ErrorSinkNull(), null, false);
  p.nextToken();
  const members: Dsymbols = p.parseModule();
  return moduleFromParse(members, p.md);
}

/**
 * Drive ONLY the add-member pre-pass that `visitModule` runs FIRST (dsymbolsem.ts, faithful to dmd's
 * ImportAllVisitor symtab build): lex+parse `src` to a Module, build its symtab, and `addMember` each
 * top-level member. A name collision in that pre-pass routes the second symbol through
 * `ScopeDsymbol.multiplyDefined`, which EMITS the redefinition diagnostic (errors++) and returns — it does
 * NOT throw. This is the exact prefix the full `runSemantic` driver executes before any per-member
 * `dsymbolSemantic`; it reaches the redefinition REJECT WITHOUT crossing any unported deeper sibling.
 * Returns the resulting `global.errors`; captures the stderr the diagnostic emits so the message can be
 * ground-truthed against ldc2.
 */
function addMemberPrepass(src: string): { errors: number; stderr: string } {
  const m = parseModule(src);
  const sc = scopeCreateGlobal(m, global.errorSink!);
  m.symtab = new DsymbolTable();
  let captured = "";
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: (s: string) => boolean }).write = (s: string): boolean => {
    captured += s;
    return true;
  };
  try {
    for (let i = 0; i < m.members!.length; i++) addMember(m.members!.opIndex(i)!, sc, sc.scopesym!);
  } finally {
    (process.stderr as { write: typeof orig }).write = orig;
  }
  return { errors: global.errors, stderr: captured };
}

describe("sema.decl (module driver: lex -> parse -> moduleFromParse -> runSemantic)", () => {
  // ── ACCEPT 1: `int x = 5;` — REAL accept, ldc2 VALID ───────────────────────────────────────────────
  // ldc2 ground-truth: `int x = 5;` compiles (no Error). Through the djs driver the var-decl body past the
  // type runs to COMPLETION for a plainly-typed, plain-mutable, module-level var (checkDeprecatedType /
  // alignment defaulting / checkComplexTransition / validity+placement checks / addStorageClass / the init
  // block / callScopeDtor / `semanticRun = semanticdone`). The `inferType` pushdown leaves the IntegerExp
  // unchanged; faithful to dmd at module scope none of the three init arms fire for a plain mutable var, so
  // pass 1 leaves the initializer as the parsed IntegerExp and pass 2 analyses it (semantic2.d:249).
  // RESULT: errors === 0, x typed `tint32`, init a folded IntegerExp(5) typed `tint32`.
  test("ACCEPT `int x = 5;`: errors === 0; VarDeclaration x typed tint32, init folded IntegerExp(5)", () => {
    const { module, errors } = sema("int x = 5;");
    expect(errors).toBe(0); // ldc2 VALID; the driver completes clean

    const members = sourceMembers(module);
    expect(members.length).toBe(1);
    const vx = members[0]!.isVarDeclaration() as VarDeclaration;
    expect(vx).not.toBeNull();
    expect(dsToJs(vx.ident!.toString())).toBe("x");
    expect(vx.type).toBe(Type.tint32);                 // declared type resolved (typeSemantic, deco'd)
    // RE-PIN: was `PASS.semanticdone` while the driver skipped pass 2; semantic2's var arm ends at
    // `vd.semanticRun = PASS.semantic2done` (semantic2.d:320) now that it runs.
    expect(vx.semanticRun).toBe(PASS.semantic2done);

    const ei = vx._init!.isExpInitializer() as ExpInitializer;
    expect(ei).not.toBeNull();
    expect(ei.exp!.op).toBe(EXP.int64);                // a folded IntegerExp literal
    expect((ei.exp as unknown as IntegerExp).value).toBe(5n); // value 5
    expect(ei.exp!.type).toBe(Type.tint32);            // typed `int`
  });

  // ── ACCEPT 2: `int x = 5; int y = 7;` — REAL accept, ldc2 VALID ────────────────────────────────────
  // ldc2 ground-truth: compiles (no Error). Two independent plain-mutable module vars, each constant-
  // initialized; the driver runs both var-decl bodies to completion with errors === 0.
  test("ACCEPT `int x = 5; int y = 7;`: errors === 0; both vars typed tint32", () => {
    const { module, errors } = sema("int x = 5; int y = 7;");
    expect(errors).toBe(0); // ldc2 VALID; the driver completes clean

    const members = sourceMembers(module);
    expect(members.length).toBe(2);
    const vx = members[0]!.isVarDeclaration() as VarDeclaration;
    const vy = members[1]!.isVarDeclaration() as VarDeclaration;
    expect(dsToJs(vx.ident!.toString())).toBe("x");
    expect(dsToJs(vy.ident!.toString())).toBe("y");
    expect(vx.type).toBe(Type.tint32);
    expect(vy.type).toBe(Type.tint32);
    expect(vx.semanticRun).toBe(PASS.semantic2done);   // RE-PIN: pass 2 runs (semantic2.d:320)
    expect(vy.semanticRun).toBe(PASS.semantic2done);

    const eiy = vy._init!.isExpInitializer() as ExpInitializer;
    expect((eiy.exp as unknown as IntegerExp).value).toBe(7n);
    expect(eiy.exp!.type).toBe(Type.tint32);
  });

  // ── REJECT 1: type mismatch `int x = "s";` — ldc2 REJECT in semantic2 ──────────────────────────────
  // ldc2 1.43 `-c -o-` on `int x = "s";`:
  //     Error: cannot implicitly convert expression `"s"` of type `string` to `int`
  // The implicit-cast that raises it runs in the var-decl INIT analysis. At MODULE scope dmd defers that to
  // `semantic2` (semantic2.d:249, `initializerSemantic(sc, type, INITinterpret)` for a non-function parent).
  // RE-PIN: PART A asserted `errors === 0` while the driver skipped pass 2; with pass 2 wired the driver
  // reports ldc2's error. PART B drives the one semantic2 init call directly.
  test("REJECT `int x = \"s\";` PART A: the driver rejects in pass 2 with ldc2's message", () => {
    const { module, errors, messages } = semaDiagnostics('int x = "s";');
    expect(messages).toEqual(["cannot implicitly convert expression `\"s\"` of type `string` to `int`"]);
    expect(errors).toBe(1);
    const vx = sourceMembers(module)[0]!.isVarDeclaration() as VarDeclaration;
    expect(vx._init!.isExpInitializer()!.exp!.op).toBe(EXP.error);
    expect(vx.semanticRun).toBe(PASS.semantic2done); // semantic2.d:320 runs after the failed init too
  });

  test("REJECT `int x = \"s\";` PART B: the semantic2 init call (INITinterpret) rejects, as ldc2 does", () => {
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

  // ── REJECT 2: `int x = 1; int y = x + 2;` at MODULE scope — ldc2 REJECT (CTFE static read) ──────────
  // ldc2 ground-truth (run through ldc2-1.43.0 `-c -o-`):
  //     Error: static variable `x` cannot be read at compile time
  // A module-/static-scope initializer must be a compile-time constant; reading the *static* var `x` inside
  // `y`'s initializer is a CTFE read of a RUNTIME variable — not allowed. That reject lives in semantic2's
  // `initializerSemantic(INITinterpret)` (the CTFE interpret of `y`'s init), NOT in pass-1. So at MODULE
  // scope this snippet is a REJECT in real D — the AddExp-over-VarExp-resolving-to-x typed shape the batch
  // describes is the FUNCTION-scope form `void f(){ int x=1; int y=x+2; }` (which ldc2 compiles cleanly).
  //
  // PART A — the REACHABLE half: inspect the parsed module AST. moduleFromParse must yield exactly the
  // shape described (modulo the parse-time IdentifierExp vs post-sema VarExp distinction).
  test("REJECT 2 PART A (parse-only AST): VarDeclaration y, init AddExp over (IdentifierExp x, IntegerExp 2)", () => {
    const m = parseModule("int x = 1; int y = x + 2;");
    const mem = m.members!;
    expect(mem.length).toBe(2);

    const vx = mem.opIndex(0)!.isVarDeclaration() as VarDeclaration;
    const vy = mem.opIndex(1)!.isVarDeclaration() as VarDeclaration;
    expect(vx).not.toBeNull();
    expect(vy).not.toBeNull();
    expect(dsToJs(vx.ident!.toString())).toBe("x");
    expect(dsToJs(vy.ident!.toString())).toBe("y");

    // y's initializer: ExpInitializer holding an AddExp.
    const ei = vy._init!.isExpInitializer() as ExpInitializer;
    expect(ei).not.toBeNull();
    const add = ei.exp!.isAddExp();
    expect(add).not.toBeNull();
    expect(add!.op).toBe(EXP.add);

    // AddExp.e1 is the reference to x. At PARSE time it is an IdentifierExp(`x`); sema would rewrite it to a
    // VarExp resolving to the VarDeclaration x — that rewrite (and the AddExp's Type.tint32 typing) is the
    // DEFERRED semantic2/CTFE target. The parse-time form is real and complete.
    const e1 = add!.e1!.isIdentifierExp();
    expect(e1).not.toBeNull();
    expect(e1!.ident).toBe(vx.ident); // same pooled Identifier instance as VarDeclaration x — resolves to x
    expect(dsToJs(e1!.ident!.toString())).toBe("x");

    // AddExp.e2 is the integer literal 2.
    const e2 = add!.e2!.isIntegerExp();
    expect(e2).not.toBeNull();
    expect((e2 as unknown as IntegerExp).value).toBe(2n);

    // Pre-sema the AddExp is untyped (typing is what semantic2/CTFE gates downstream).
    expect(add!.type).toBeNull();
  });

  // PART B — the FULL-MODULE driver. The initializer of `y` is NOT analyzed in pass-1 (a mutable module
  // var's init is deferred to semantic2, semantic2.d:249); pass 2 interprets it and rejects the static read.
  // ldc2 1.43 `-c -o-`:
  //     Error: static variable `x` cannot be read at compile time
  // RE-PIN: this asserted `errors === 0` while the driver skipped pass 2.
  test("REJECT 2 `int x = 1; int y = x + 2;` PART B: the driver rejects the static read in pass 2, as ldc2", () => {
    const { module, errors, messages } = semaDiagnostics("int x = 1; int y = x + 2;");
    expect(messages).toEqual(["static variable `x` cannot be read at compile time"]);
    expect(errors).toBe(1);
    const vy = sourceMembers(module)[1]!.isVarDeclaration() as VarDeclaration;
    expect(vy._init!.isExpInitializer()!.exp!.op).toBe(EXP.error);
    expect(vy.semanticRun).toBe(PASS.semantic2done); // semantic2.d:320 runs after the failed init too
  });

  test(
      "REJECT 2 `int x = 1; int y = x + 2;` PART C: semantic2's INITinterpret call rejects the static read, as ldc2",
      () => {
    // semantic2's `initializerSemantic(sc, type, INITinterpret)` for `y` runs ctfeInterpret on `x + 2`. ldc2:
    // "static variable `x` cannot be read at compile time" (one error); the init expression becomes an ErrorExp.
    const m = parseModule("int x = 1; int y = x + 2;");
    const vy = m.members!.opIndex(1)!.isVarDeclaration() as VarDeclaration;
    const sc = scopeCreateGlobal(m, global.errorSink!);
    m.symtab = new DsymbolTable();
    for (let i = 0; i < m.members!.length; i++) addMember(m.members!.opIndex(i)!, sc, sc.scopesym!);
    const ei = vy._init!.isExpInitializer() as ExpInitializer;
    const r = initializerSemantic(ei, sc, { value: vy.type! }, INITinterpret);
    expect(r.isExpInitializer()!.exp!.op).toBe(EXP.error);
    expect(global.errors).toBe(1);
  });

  // ── REJECT 3: redefinition `int x=1; int x=2;` — REAL reject (errors > 0, no throw) ────────────────
  // ldc2 GROUND-TRUTH (file `redef.d`, run through ldc2-1.43.0 `-c -o-`):
  //     Error: variable `redef.x` conflicts with variable `redef.x` at redef.d(1)
  // The reject is detected in the ADD-MEMBER PRE-PASS — the symtab-population step `visitModule` runs BEFORE
  // any per-member `dsymbolSemantic`, faithful to dmd's ImportAllVisitor. The second `x` collides on insert;
  // `overloadInsert` returns false for a plain VarDeclaration, so the path reaches `ScopeDsymbol.
  // multiplyDefined`, which EMITS the verbatim dmd "conflicts with" diagnostic (errors++) and RETURNS — no
  // throw. We drive that pre-pass and assert the REAL outcome: errors > 0, no exception.
  test("REJECT redefinition `int x=1; int x=2;` -> errors > 0, no throw (multiplyDefined emits in add-member)", () => {
    const { errors, stderr } = addMemberPrepass("int x=1; int x=2;");
    expect(errors).toBeGreaterThan(0);

    // MESSAGE GROUND-TRUTH + HONEST DIVERGENCE NOTE: the dmd MESSAGE FORMAT is reproduced verbatim
    // ("variable `…` conflicts with variable `…` at …"). The qualifier DIVERGES from ldc2 ONLY in the module
    // name and trailing loc, fully explained by the fixture, NOT a port defect:
    //   ldc2 (file redef.d, real srcfile):   variable `redef.x` conflicts with variable `redef.x` at redef.d(1)
    //   djs  (in-memory buf, no module decl): variable `__anonymous.x` conflicts with variable `__anonymous.x` at
    // — `__anonymous` because this Module is parsed from an in-memory buffer with NO `module …;` declaration
    //   and a null srcfile, so `Module.toPrettyChars` has no name to qualify with; ldc2 derives `redef` from
    //   the on-disk filename. The trailing location is empty for the same reason (no srcfile). The PER-SYMBOL
    //   text is byte-for-byte the dmd format; only the qualifier/loc fixture data differs. NOT faked.
    expect(stderr).toContain("conflicts with variable");
    expect(stderr).toContain("`__anonymous.x`"); // the honest, fixture-explained qualifier divergence
    expect(stderr).toMatch(/variable `__anonymous\.x` conflicts with variable `__anonymous\.x` at/);

    // And confirm the FULL `runSemantic` driver records this same reject with no throw: the redefinition
    // error is emitted in pass 0's add-member step, and the driver stops there as main.d:707 does.
    const full = sema("int x=1; int x=2;");
    // ldc2 reports one error. `global.errors` still holds the pre-pass's one from above, so the driver's own
    // contribution is the delta; it stops after pass 0 (main.d:707).
    expect(full.errors - errors).toBe(1);
  });
});

describe("`.stringof` built through RootObject.toString is NUL-free (rootobject.d:50-51)", () => {
  test("module-scope static asserts on `x.stringof`, `(1+2).stringof` and `int.stringof` hold (ldc2: rc 0)", () => {
    // toString slices toChars() at strlen; before it did, `x.stringof` carried the extractChars NUL ("x\0").
    const { errors, messages } = semaDiagnostics(
      'int x; static assert(x.stringof == "x"); static assert((1+2).stringof.length == 5);' +
      ' static assert(int.stringof == "int");');
    expect(messages).toEqual([]);
    expect(errors).toBe(0);
  });
});
