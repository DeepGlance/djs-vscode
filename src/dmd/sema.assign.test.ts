import { describe, it, expect, beforeEach, afterEach } from "vitest";

// SEMA — LVALUE / ASSIGNMENT-REASSIGNMENT GOAL TESTS. These protect the cluster that opens the
// `op == assign` (reassignment) arm of `visitAssignExp`: the destination of an `x = …` reassignment must
// be a modifiable lvalue, so it routes through the freshly-ported `modifiableLvalue → checkModifiable →
// checkModify → toLvalue` chain (dmd/expressionsem.d:16788 / 16641 / 17611 / 16352) plus `Type.isAssignable`
// (dmd/typesem.d:487). The CONSTRUCT path (`int x = …;`) was already ported (Rung-3) and must keep working;
// these cases exercise the *reassignment* arm specifically.
//
// GROUND-TRUTH pinned to ldc2-1.42.0 (`<ldc2-1.42.0>/bin/ldc2`):
//   ACCEPT (compiles clean, errors === 0):
//     void f(){ int x = 0; x = 5; }             -- reassign a mutable local; typeof(x = 5) is `int`
//   REJECT (ldc2 emits `Error: cannot modify ` + backtick-const-backtick + ` expression ` + backtick-x):
//     void f(const int x){ x = 2; }             -- reassign a `const` parameter; the const-mutability error
//                                                  fires (checkModify returns yes → !type.isMutable())
//
// The step map's two literal GOAL inputs were long blocked by unported siblings OUTSIDE this cluster (the
// `visitVarDeclaration` default-initializer synthesis for `int x;`, and the `implicitCastTo` MATCH.constant
// const-conversion shortcut for `const int x = 1`). Both are live now, and so is `discardValue`
// (dmd/sideeffect.d:242, `src/dmd/sideeffect.ts`), so the two cases run end-to-end and are pinned on their
// ldc2 outcomes in the last describe of this file — no `toThrow` wall pin remains here. The const PARAMETER
// test is kept beside them rather than replaced: a parameter has
// no initializer, so it reaches the same `modifiableLvalue` const-reject this cluster ports, and ldc2 emits
// the identical wording for both shapes.
//
// The reject WORDING is produced by the documented VarExp-narrow substitute in modifiableLvalue
// (MODtoString(type.mod) → "const", exp.var_.toChars() → "x"), NOT the unported hdrgen MODtoChars/toErrMsg.
// We assert a stable substring of the actual emitted text (captured via setDiagnosticHandler).

import { Parser } from "./parse.js";
import { ErrorSinkNull } from "./errorsink.js";
import { Type } from "./mtype.js";
import { PASS } from "./dsymbol.js";
import { global } from "./globals.js";
import { Module, moduleFromParse } from "./dmodule.js";
import { runSemantic } from "./dsymbolsem.js";
import { setDiagnosticHandler } from "./errors.js";
import { dmdformat } from "./root/dmdformat.js";
import { dsToJs } from "../dstring.js";
import type { FuncDeclaration } from "./func.js";
import { ExpStatement } from "./statement.js";
import type { AssignExp } from "./expression.js";
import { initSemaHarness, sourceMembers, userBody } from "../sema-harness.js";

// Captured rendered diagnostic text for the current `sema(...)` run. Set by the handler below.
let capturedDiagnostics: string[] = [];

beforeEach(() => {
  initSemaHarness();
  capturedDiagnostics = [];
  // Intercept every diagnostic, render its format+args with the same dmdformat the printer uses, and
  // suppress the default stderr write (return true). This lets the reject test assert the actual wording.
  setDiagnosticHandler((_loc, _color, _header, messageFormat, args) => {
    capturedDiagnostics.push(dsToJs(dmdformat(messageFormat, [...args])));
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

/** Lex+parse `src` into a Module, run the `runSemantic` driver (passes 0-3), return module + error count. */
function sema(src: string): { module: Module; errors: number } {
  const p = new Parser(null, null, srcBuf(src), false, new ErrorSinkNull(), null, false);
  p.nextToken();
  const m = moduleFromParse(p.parseModule(), p.md);
  runSemantic(m);
  return { module: m, errors: global.errors };
}

function nthFunc(m: Module, i: number): FuncDeclaration {
  const fd = sourceMembers(m)[i]!.isFuncDeclaration();
  expect(fd).not.toBeNull();
  return fd!;
}

describe("ASSIGN ACCEPT — reassign a mutable local (errors === 0)", () => {
  it("`void f(){ int x = 0; x = 5; }` — reassign mutable local; compiles clean, assign typed int", () => {
    const { module, errors } = sema("void f(){ int x = 0; x = 5; }");
    expect(errors).toBe(0);
    const fd = nthFunc(module, 0);
    expect(fd.semanticRun).toBe(PASS.semantic3done);

    // Body: CompoundStatement of two ExpStatements — [0] the `int x = 0;` declaration, [1] the `x = 5;`
    // assign. Assert the assignment resolved its type to `int` (dmd: `exp.type = exp.e1.type`).
    const body = userBody(fd).isCompoundStatement()!;
    const stmts = body.statements!;
    const es = stmts.opIndex(1) as ExpStatement;
    expect(es).toBeInstanceOf(ExpStatement);
    const ae = es.exp as unknown as AssignExp;
    expect(ae.isAssignExp()).not.toBeNull();
    expect(ae.type).toBe(Type.tint32);
  });
});

describe("ASSIGN REJECT — reassign a const lvalue (errors > 0, no throw)", () => {
  it("`void f(const int x){ x = 2; }` — cannot modify `const` expression `x`", () => {
    const { errors } = sema("void f(const int x){ x = 2; }");
    expect(errors).toBeGreaterThan(0);
    // Stable substring of the ACTUAL emitted text (VarExp-narrow substitute: MODtoString + var.toChars).
    // ldc2-1.42.0 emits: `Error: cannot modify ` + `\`const\`` + ` expression ` + `\`x\``.
    const all = capturedDiagnostics.join("\n");
    expect(all).toContain("cannot modify `const` expression `x`");
  });
});

describe("ASSIGN — the two step-map literal cases, CONVERTED from wall pins to behaviour pins", () => {
  // CONVERTED, both cases (10 §1.8 rule 7). Until wave 6 each of these was
  //   expect(() => sema(...)).toThrow("TODO-BODY: discardValue (dmd/sideeffect.d:242 — module unported;
  //                                   call at dmd/statementsem.d:234)")
  // Three walls have gone live underneath them in turn: the `visitVarDeclaration` scalar `defaultInit` arm,
  // the `implicitCastTo` MATCH.constant const-conversion shortcut, and now `discardValue` itself —
  // `src/dmd/sideeffect.ts` exists and statementsem.ts:313 calls it (dmd/sideeffect.d:242). `sema()` no
  // longer throws for either snippet, so there is no next wall to re-point to (rule 2 does not apply) and
  // deleting the tests would silently drop the coverage the escalation bought (rule 7). Each is therefore
  // pinned on the outcome ldc2-1.43.0 produces for it, probed for this conversion, never on an expression
  // the port re-evaluates (rule 8):
  //   $ ldc2 -o- 'void f(){ int x; x = 5; }'                 -> exit 0, no diagnostic
  //   $ ldc2 -o- 'void f(){ const int x = 1; x = 2; }'       -> exit 1,
  //       Error: cannot modify `const` expression `x`        (pointing at the SECOND statement, `x = 2`)
  // The wording is the same VarExp-narrow substitute the REJECT test above asserts (MODtoString(type.mod)
  // + var_.toChars()), so no unported hdrgen path is required to render it.
  it("`void f(){ int x; x = 5; }` — default-initialized local then reassigned; ldc2 ACCEPTs (errors === 0)", () => {
    const { errors } = sema("void f(){ int x; x = 5; }");
    expect(errors).toBe(0);
  });

  it("`void f(){ const int x = 1; x = 2; }` — reassign a const local; ldc2 REJECTs with one error", () => {
    const { errors } = sema("void f(){ const int x = 1; x = 2; }");
    expect(errors).toBe(1);
    const all = capturedDiagnostics.join("\n");
    expect(all).toContain("cannot modify `const` expression `x`");
  });
});
