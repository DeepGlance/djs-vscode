import { describe, it, expect, beforeEach, afterEach } from "vitest";

// SEMA PHASE-4c FIELD-ACCESS GOAL TESTS — F1 (the READ path) + F2 (the WRITE path) + F3 (the
// member-miss REJECT funnel).
//
// F1 protects the field READ `struct S { int x; } void f() { S s; int y = s.x; }` (probe p2)
// ACCEPTING end-to-end through runSemantic. The composed fills: visit(DotIdExp)
// (expressionsem.d:8909) -> dotIdSemanticProp/dotIdSemanticPropX (14904/14776, gag=1, identity-return
// protocol) -> dotExp dispatcher + TypeStruct visitStruct (typesem.d:4856/5409: symtab search, field
// checks, `new DotVarExp(...).expressionSemantic`) -> visit(DotVarExp) (expressionsem.d:8976: type =
// var.type + addMod, getRightThis identity, checkAccess no-op) -> optimize's EXP.dotVariable arm
// (optimize.d:720, no-fold for a mutable receiver) -> checkUnsafeAccess (safe.d:58, readonly exit).
//
// F2 protects the field WRITE `s.x = 1;` (p1, plus p8/p11 compositions) ACCEPTING and `s.x = "str"`
// (p3) REJECTING with the ldc2-exact dcast.d:184 message. The composed fills: visit(AssignExp)'s
// DotIdExp-e1 arm (expressionsem.d:11204: gagged dotIdSemanticProp, UFCS-setter fallback site) ->
// checkModifiable's dotVariable recursion (16652/16728) -> modifiableLvalue via D's dispatch default
// (16914) -> toLvalue's visitDotVar (16450) + DotVarExp.isLvalue (expression.d:2881) -> the
// implicitCastTo int fast path (dcast.d:2040, same node) / reject tail (dcast.d:150+184 with the live
// toErrMsg + toAutoQualChars printers: hdrgen.d:127/221, mtype.d:3970).
//
// GROUND-TRUTH (ldc2-1.42.0 `-c -o-` / `-vcg-ast`; /tmp/djs4c-map/ground-truth.md + pNN.d.cg):
//   p2 `struct S { int x; } void f() { S s; int y = s.x; }` -> ACCEPT exit 0; lowered body verbatim
//      `S s = 0; int y = s.x;` — the DotVarExp is typed `int`, initializes `y` DIRECTLY, no cast, no
//      temporary (the int->int exact match returns the SAME node through implicitCastTo/castTo).
//   p1 `s.x = 1;` -> ACCEPT exit 0; lowered body verbatim `S s = 0; s.x = 1;` — no cast, no temp, the
//      IntegerExp literal survives sema unchanged.
//   p8 (two fields: `s.y = 2; int z = s.y;`) / p11 (`s.x = 5; return s.x;`) -> ACCEPT exit 0, bodies
//      verbatim (statement order preserved, no casts; `return s.x` needs no conversion).
//   p3 `s.x = "str";` -> REJECT exit 1, exactly ONE error:
//      cannot implicitly convert expression `"str"` of type `string` to `int`
//   p4/p5 `s.nonexistent` -> REJECT exit 1, exactly ONE counted error + ONE supplemental (F3):
//      no property `nonexistent` for `s` of type `<module>.S`        (type FULLY qualified)
//      struct `S` defined here                                       (supplemental, at the decl)
//      ldc2 spells the module from the file name (`p4.S`); the harness module has no module
//      declaration and no file, so Dsymbol.toChars renders the null-ident module as `__anonymous`
//      (dsymbol.ts:416, hdrgen.d:265) -> `__anonymous.S`. Composed F3 fills: noMember
//      (typesem.d:5290, gagged null via getProperty's typesem.d:3781 exit) -> resolveUFCSProperties
//      (expressionsem.d:1640) -> searchUFCS two-pass scope walk misses (expressionsem.d:1322/1326)
//      -> UNGAGGED getProperty(flag=0, src) emits the pair (typesem.d:3813 + 3856) -> ErrorExp
//      propagates through CallExp sema's errored-callee short-circuit (unaSemantic, dmd:6809).
//   p9 `s.x = 1L;` -> ldc2 ACCEPTS via VRP (the long literal is REWRITTEN to int-typed `1`). NOT
//      goal-tested this slice: in djs it halts at implicitConvTo's integral-narrowing guard
//      (dcast.d:307 — getIntRange/IntRange unported), already pinned by dcast.rung1.test.ts.

import { Parser } from "./parse.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { ds, dsToJs } from "../dstring.js";
import { ErrorSinkNull } from "./errorsink.js";
import { Type } from "./mtype.js";
import { EXP } from "./tokens.js";
import { PASS } from "./dsymbol.js";
import { global } from "./globals.js";
import { Module, moduleFromParse } from "./dmodule.js";
import { runSemantic } from "./dsymbolsem.js";
import { IntegerExp, VarExp, DotVarExp, ConstructExp } from "./expression.js";
import { ExpStatement, ReturnStatement, ErrorStatement } from "./statement.js";
import type { CompoundStatement } from "./statement.js";
import type { DeclarationExp, AssignExp } from "./expression.js";
import { setDiagnosticHandler } from "./errors.js";
import { dmdformat } from "./root/dmdformat.js";
import type { FuncDeclaration } from "./func.js";
import type { VarDeclaration } from "./declaration.js";
import type { StructDeclaration } from "./dstruct.js";
import type { Dsymbol } from "./dsymbol.js";
import { initSemaHarness, sourceMembers, userBody } from "../sema-harness.js";

// Rendered diagnostic text captured for the current `sema(...)` run (the R1/R2 exact-message goals).
let capturedDiagnostics: string[] = [];
// Per-diagnostic header + loc, parallel to capturedDiagnostics: the header distinguishes a counted
// "Error: " line from its 7-space supplemental (errors.d:656); line/col pin the reported positions.
let capturedHeaders: string[] = [];
let capturedLocs: { line: number; col: number }[] = [];

beforeEach(() => {
  initSemaHarness();
  capturedDiagnostics = [];
  capturedHeaders = [];
  capturedLocs = [];
  // Intercept every diagnostic, render its format+args with the same dmdformat the printer uses, and
  // suppress the default stderr write (return true) — the sema.assign.test.ts capture pattern.
  setDiagnosticHandler((loc, _color, header, messageFormat, args) => {
    capturedDiagnostics.push(dsToJs(dmdformat(messageFormat, [...args])));
    capturedHeaders.push(dsToJs(header));
    capturedLocs.push({ line: loc.linnum, col: loc.charnum });
    return true;
  });
});

afterEach(() => {
  setDiagnosticHandler(null);
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

/** Find a top-level StructDeclaration by name (symtab keyed by interned Identifiers). */
function findStruct(m: Module, name: string): StructDeclaration {
  const sym: Dsymbol | null = m.symtab ? m.symtab.lookup(Identifier.idPool(ds(name))) : null;
  expect(sym).not.toBeNull();
  const sd = sym!.isStructDeclaration();
  expect(sd).not.toBeNull();
  return sd!;
}

/** The i-th top-level member as a FuncDeclaration. */
function nthFunc(m: Module, i: number): FuncDeclaration {
  const fd = sourceMembers(m)[i]!.isFuncDeclaration();
  expect(fd).not.toBeNull();
  return fd!;
}

/** Locate the i-th local of `fd` (a one-statement body is that lone statement: dmd/statementsem.d:452-456). */
function localVar(fd: FuncDeclaration, i: number): VarDeclaration {
  const body = userBody(fd);
  const stmt = body instanceof ExpStatement ? body : (body as unknown as CompoundStatement).statements!.opIndex(i);
  if (body instanceof ExpStatement) expect(i).toBe(0);
  const es = stmt as ExpStatement;
  expect(es).toBeInstanceOf(ExpStatement);
  const de = es.exp as unknown as DeclarationExp;
  const vd = de.declaration!.isVarDeclaration();
  expect(vd).not.toBeNull();
  return vd!;
}

const A2 = "struct S { int x; } void f() { S s; int y = s.x; }";

describe("harness init order keeps Id.* identity live", () => {
  // initTokens()'s Identifier.initTable() re-creates the interning table; run AFTER Id.initialize()
  // it orphans every Id.* singleton, and all `ident === Id.x` compares silently go dead — the
  // special-ident filters in noMember/dotExpVisitType/getProperty would then mis-route `s.stringof`
  // into a fabricated counted "no property" reject instead of its loud TODO wall. Order contract
  // documented at tokens.ts initTokens; this pin catches a regression in ANY harness cloned from here.
  it("a freshly interned identifier IS the Id singleton (initTokens BEFORE Id.initialize)", () => {
    expect(Identifier.idPool(ds("stringof"))).toBe(Id.stringof);
    expect(Identifier.idPool(ds("opDispatch"))).toBe(Id.opDispatch);
  });
});

describe("Phase 4c F1 — ACCEPT `int y = s.x;` (ldc2 p2: exit 0, body lowered verbatim)", () => {
  it("errors 0; f reaches semantic3done; both locals reachable", () => {
    const { module: m, errors } = sema(A2);
    expect(errors).toBe(0);

    const fd = nthFunc(m, 1);
    expect(fd.semanticRun).toBe(PASS.semantic3done);

    const vs = localVar(fd, 0);
    const vy = localVar(fd, 1);
    expect(dsToJs(vs.ident!.toString())).toBe("s");
    expect(dsToJs(vy.ident!.toString())).toBe("y");
  });

  it("4b invariant intact: s.type IS the merged TypeStruct (vd.type === sd.type, pointer identity)", () => {
    const { module: m, errors } = sema(A2);
    expect(errors).toBe(0);
    const sd = findStruct(m, "S");
    const vs = localVar(nthFunc(m, 1), 0);
    expect(vs.type).toBe(sd.type);
    expect(vs.type!.isTypeStruct()!.sym).toBe(sd);
    // This identity is LOAD-BEARING for 4c: getRightThis's struct-match clause
    // (expressionsem.d:2096-2098) compares `t.isTypeStruct().sym === ad` by reference — a re-created
    // (non-interned) TypeStruct would land in the wrong-`this` error arm (map trap 10).
  });

  it("y's init is ConstructExp(VarExp(y), DotVarExp(VarExp(s), field x)) typed int — p2.d.cg: `int y = s.x;` no cast", () => {
    const { module: m, errors } = sema(A2);
    expect(errors).toBe(0);
    const sd = findStruct(m, "S");
    const fd = nthFunc(m, 1);
    const vs = localVar(fd, 0);
    const vy = localVar(fd, 1);

    // GOAL: the init survives sema as the plain ConstructExp — dsymbolsem's constructInit built it,
    // visit(AssignExp)'s construct tail returned it (expressionsem.d:12226-12230), optimize kept it.
    const ei = vy._init!.isExpInitializer();
    expect(ei).not.toBeNull();
    const ce = ei!.exp as ConstructExp;
    expect(ce).toBeInstanceOf(ConstructExp);
    expect(ce.op).toBe(EXP.construct);
    expect(ce.type).toBe(Type.tint32); // expressionsem.d:12220 `exp.type = exp.e1.type` — the merged int

    // GOAL: e1 is the VarExp naming y.
    const e1 = ce.e1 as VarExp;
    expect(e1).toBeInstanceOf(VarExp);
    expect(e1.var_).toBe(vy);

    // GOAL (the heart of F1): e2 is the DotVarExp built by dotExp.visitStruct (typesem.d:5667) and
    // typed by visit(DotVarExp) (expressionsem.d:9083/9091): over VarExp(s), resolving field x of S,
    // typed tint32. p2.d.cg shows `int y = s.x;` VERBATIM — no cast node, no temporary, so e2 must BE
    // the DotVarExp itself (int->int exact match returns the same node, dcast.d:2040).
    const dve = ce.e2 as DotVarExp;
    expect(dve).toBeInstanceOf(DotVarExp);
    expect(dve.op).toBe(EXP.dotVariable);
    expect(dve.type).toBe(Type.tint32);            // field type, addMod(0) identity (dmd:9083/9091)
    expect(dve.hasOverloads).toBe(false);          // VarDeclaration member (expression.d:2871-2872)

    // receiver: VarExp(s), still typed with the SAME interned TypeStruct.
    const recv = dve.e1 as VarExp;
    expect(recv).toBeInstanceOf(VarExp);
    expect(recv.var_).toBe(vs);
    expect(recv.type).toBe(sd.type);

    // member: THE field VarDeclaration x of S (rung-4a layout: STC.field set, offset 0, type int).
    const xfield = dve.var_!.isVarDeclaration();
    expect(xfield).not.toBeNull();
    expect(dsToJs(xfield!.ident!.toString())).toBe("x");
    expect(xfield).toBe(sd.fields.opIndex(0));
    expect(xfield!.isField()).toBe(true);          // needThis() gate — map trap T4 (dmd:9127 skipped)
    expect(xfield!.offset).toBe(0);
    expect(xfield!.type).toBe(Type.tint32);
  });
});

const A1 = "struct S { int x; } void f() { S s; s.x = 1; }";

describe("Phase 4c F2 — ACCEPT `s.x = 1;` (ldc2 p1: exit 0, body lowered verbatim)", () => {
  it("errors 0; f reaches semantic3done", () => {
    const { module: m, errors } = sema(A1);
    expect(errors).toBe(0);
    expect(nthFunc(m, 1).semanticRun).toBe(PASS.semantic3done);
  });

  it("statement is AssignExp(DotVarExp(VarExp s, x), IntegerExp 1) typed int — p1.d.cg: `s.x = 1;` no cast", () => {
    const { module: m, errors } = sema(A1);
    expect(errors).toBe(0);
    const sd = findStruct(m, "S");
    const fd = nthFunc(m, 1);
    const vs = localVar(fd, 0);

    const stmts = userBody(fd).isCompoundStatement()!.statements!;
    const es = stmts.opIndex(1) as ExpStatement;
    expect(es).toBeInstanceOf(ExpStatement);

    // GOAL: the typed AssignExp — expressionsem.d:12220 `exp.type = exp.e1.type` (the merged int).
    const ae = es.exp as unknown as AssignExp;
    expect(ae.op).toBe(EXP.assign);
    expect(ae.type).toBe(Type.tint32);

    // GOAL (the heart of F2): e1 is the DotVarExp the gagged dotIdSemanticProp resolved through
    // visit(AssignExp)'s DotIdExp arm (expressionsem.d:11204-11229), kept by modifiableLvalue/toLvalue
    // (Modifiable.yes for a mutable local receiver → no ConstructExp rewrite at dmd:11378).
    const dve = ae.e1 as DotVarExp;
    expect(dve).toBeInstanceOf(DotVarExp);
    expect(dve.op).toBe(EXP.dotVariable);
    expect(dve.type).toBe(Type.tint32);
    expect(dve.hasOverloads).toBe(false);
    const recv = dve.e1 as VarExp;
    expect(recv).toBeInstanceOf(VarExp);
    expect(recv.var_).toBe(vs);
    expect(recv.type).toBe(sd.type);
    expect(dve.var_).toBe(sd.fields.opIndex(0));

    // GOAL: e2 is the SAME IntegerExp literal — int->int exact match, castTo's dcast.d:2040 identity
    // return; p1.d.cg shows `s.x = 1;` VERBATIM (no CastExp node, no `L` rewrite).
    const rhs = ae.e2 as IntegerExp;
    expect(rhs).toBeInstanceOf(IntegerExp);
    expect(rhs.op).toBe(EXP.int64);
    expect(rhs.value).toBe(1n);
    expect(rhs.type).toBe(Type.tint32);
  });
});

describe("Phase 4c F2 — ACCEPT compositions p8/p11 (second field; assign + return)", () => {
  it("p8 `s.y = 2; int z = s.y;` — second field behaves identically (p8.d.cg verbatim, offset 4)", () => {
    const { module: m, errors } = sema("struct S { int x; int y; } void f() { S s; s.y = 2; int z = s.y; }");
    expect(errors).toBe(0);
    const sd = findStruct(m, "S");
    const fd = nthFunc(m, 1);
    const stmts = userBody(fd).isCompoundStatement()!.statements!;

    // [1] the write: AssignExp typed int over field y (rung-4a layout: second int field at offset 4).
    const ae = (stmts.opIndex(1) as ExpStatement).exp as unknown as AssignExp;
    expect(ae.op).toBe(EXP.assign);
    expect(ae.type).toBe(Type.tint32);
    const yfield = sd.fields.opIndex(1) as VarDeclaration;
    expect(ae.e1).toBeInstanceOf(DotVarExp); // NOT the dmd:9105 VarExp fallback (which also has var_)
    expect((ae.e1 as DotVarExp).var_).toBe(yfield);
    expect(yfield.offset).toBe(4);

    // [2] the read-back: `int z = s.y` — the F1 shape over the SAME field VarDeclaration.
    const vz = localVar(fd, 2);
    expect(dsToJs(vz.ident!.toString())).toBe("z");
    const ce = vz._init!.isExpInitializer()!.exp as ConstructExp;
    expect(ce).toBeInstanceOf(ConstructExp);
    expect(ce.type).toBe(Type.tint32);
    expect((ce.e2 as DotVarExp).var_).toBe(yfield);
  });

  it("p11 `s.x = 5; return s.x;` — write then return of the field (p11.d.cg: `return s.x;` no conversion)", () => {
    const { module: m, errors } = sema("struct S { int x; } int g() { S s; s.x = 5; return s.x; }");
    expect(errors).toBe(0);
    const sd = findStruct(m, "S");
    const fd = nthFunc(m, 1);
    expect(fd.semanticRun).toBe(PASS.semantic3done);
    const stmts = userBody(fd).isCompoundStatement()!.statements!;

    const ae = (stmts.opIndex(1) as ExpStatement).exp as unknown as AssignExp;
    expect(ae.type).toBe(Type.tint32);
    expect((ae.e2 as IntegerExp).value).toBe(5n);

    // GOAL: `return s.x` carries the DotVarExp itself, typed int — field type == return type, so no
    // conversion node appears (p11.d.cg body verbatim).
    const rs = stmts.opIndex(2) as ReturnStatement;
    expect(rs).toBeInstanceOf(ReturnStatement);
    const rexp = rs.exp as DotVarExp;
    expect(rexp).toBeInstanceOf(DotVarExp);
    expect(rexp.type).toBe(Type.tint32);
    expect(rexp.var_).toBe(sd.fields.opIndex(0));
  });
});

describe("Phase 4c F2 — REJECT `s.x = \"str\";` (ldc2 p3: exit 1, exact message)", () => {
  it("errors 1; dcast.d:184 message byte-matches ldc2 (toErrMsg quoting + `string`/`int` spellings)", () => {
    const { errors } = sema('struct S { int x; } void f() { S s; s.x = "str"; }');
    // dcast.d:184 emits ONE error (the e1 side never sees e2's type — trace-assign.md §2); the
    // ErrorExp exits visit(AssignExp) at dmd:12167 and ExpStatement becomes an ErrorStatement.
    expect(errors).toBe(1);
    // ldc2-1.42.0 p3 verbatim (ground-truth.md): the StringExp renders through toErrMsg (hdrgen.d:127
    // visitString → `"str"`), the types through toAutoQualChars (mtype.d:3970 → `string`, `int`).
    expect(capturedDiagnostics).toContain('cannot implicitly convert expression `"str"` of type `string` to `int`');
    expect(capturedDiagnostics.length).toBe(1);
    // ldc2 -vcolumns p3: `p3.d(1,43)` — col 43 is the `=` assign-exp loc; one counted "Error: " line.
    expect(capturedHeaders).toEqual(["Error: "]);
    expect(capturedLocs).toEqual([{ line: 1, col: 43 }]);
  });
});

// The exact diagnostic pair both R2 forms must emit (ldc2 p4/p5 shape; module name from the harness:
// the null-ident module prints `__anonymous`, so the FQN operand of toPrettyChars(true) is
// `__anonymous.S` where ldc2 — naming modules from file names — prints `p4.S`/`p5.S`).
const R2_MAIN = "no property `nonexistent` for `s` of type `__anonymous.S`";
const R2_SUPPL = "struct `S` defined here";

describe("Phase 4c F3 — REJECT `s.nonexistent` (ldc2 p4/p5: exit 1, one error + one supplemental)", () => {
  // WALL FLIP (F3, 10 §1.8): both forms previously pinned `TODO-BODY: Type.noMember miss funnel
  // (typesem.d:5290 — opDispatch/aliasthis/getProperty unported; F3)` (grep-swept: pinned only in
  // this file). noMember/getProperty/searchUFCS/resolveUFCSProperties are now live and the snippets
  // REJECT for real — these goal tests pin the ldc2-verified outcome instead.

  it("R2a `s.nonexistent = 1;` — errors 1, exact pair via the AssignExp UFCS SETTER form (dmd:11227)", () => {
    const { module: m, errors } = sema("struct S { int x; } void f() { S s; s.nonexistent = 1; }");

    // ONE counted error (the supplemental goes through errorSupplemental, errors.d:241 — no bump).
    expect(errors).toBe(1);
    expect(capturedDiagnostics).toEqual([R2_MAIN, R2_SUPPL]);
    expect(capturedHeaders).toEqual(["Error: ", "       "]); // errors.d:529 / :656 (supplemental)

    // Locs: the main error at the DotIdExp (line 1, col of the `.` — ldc2 p4 caret position); the
    // supplemental at the struct DECLARATION (line 1, col 1). Observed; col 38 = `.` of `s.nonexistent`.
    expect(capturedLocs).toEqual([{ line: 1, col: 38 }, { line: 1, col: 1 }]);

    // The searchUFCS ErrorExp propagated through visit(AssignExp)'s setter-form return: the whole
    // statement sema fails and `f`'s body collapses to an ErrorStatement (same downstream shape the
    // R1 reject produces); sema still COMPLETES (no throw) and f reaches semantic3done.
    const fd = nthFunc(m, 1);
    expect(fd.semanticRun).toBe(PASS.semantic3done);
    expect(fd.fbody).toBeInstanceOf(ErrorStatement);
  });

  it("R2b `int y = s.nonexistent;` — errors 1, identical pair via visit(DotIdExp)'s UFCS getter form (dmd:8959)", () => {
    const { module: m, errors } = sema("struct S { int x; } void f() { S s; int y = s.nonexistent; }");

    expect(errors).toBe(1);
    expect(capturedDiagnostics).toEqual([R2_MAIN, R2_SUPPL]); // IDENTICAL pair to R2a — both funnels
    expect(capturedHeaders).toEqual(["Error: ", "       "]);  // converge on getProperty (typesem.d:3813)
    expect(capturedLocs).toEqual([{ line: 1, col: 46 }, { line: 1, col: 1 }]); // col 46 = the `.`

    // The ErrorExp surfaces as y's initializer failing: dsymbolsem's var-init error path replaces
    // the ExpInitializer with an ErrorInitializer (observed; the function still completes).
    const fd = nthFunc(m, 1);
    expect(fd.semanticRun).toBe(PASS.semantic3done);
    const vy = localVar(fd, 1);
    expect(dsToJs(vy.ident!.toString())).toBe("y");
    expect(vy._init!.isErrorInitializer()).not.toBeNull();
    expect(vy._init!.isExpInitializer()).toBeNull();
  });
});
