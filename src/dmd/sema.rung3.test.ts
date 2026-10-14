import { describe, it, expect, beforeEach } from "vitest";

// SEMA RUNG-3 END-TO-END GOAL TESTS — function bodies that DECLARE LOCALS, do ARITHMETIC, and CALL
// other functions, driven through the `sema(src)` MODULE driver (lex -> parse -> moduleFromParse ->
// runSemantic, the same helper every sema.*.test.ts uses). These protect the Rung-3 deliverable that the
// pass-1 signature resolution + pass-3 body analysis now run end-to-end for:
//   - a function-LOCAL variable with a scalar initializer (`int x = 5;`) — VarDeclaration dsymbolSemantic
//     builds a `ConstructExp(VarExp(x), init)` and runs it through `visitAssignExp`'s scalar construct path
//     (modifiableLvalue + implicitCastTo + checkAssignEscape), the same mechanism dmd uses for every
//     assignment shape;
//   - a local whose initializer READS a prior local (`int y = x + 2;`) — `x` resolves to its VarExp, the
//     `+` is an AddExp typed int (no CTFE inside a function body), and `y` is typed int;
//   - a single-function CALL (`f(2)`) — the callee resolves to the function's TypeFunction VarExp, the
//     argument is matched against the parameter list (`callMatch`), and `functionParameters` sets the
//     CallExp's type to the function's return type (`int`).
//
// GROUND-TRUTH pinned to ldc2-1.42.0 (`<ldc2-1.42.0>/bin/ldc2`):
//   ACCEPT (compiles clean, errors === 0):
//     void f(){ int x = 5; return; }                                   -- local var + bare return
//     void h(){ int x = 1; int y = x + 2; }                            -- y's init reads local x
//     int f(int a){ return a + 1; } int g(){ return f(2); }            -- f(2) is an int-typed CallExp
//   REJECT (ldc2 emits an Error, errors > 0):
//     int f(){ return "s"; }                                           -- return value `"s"` of type `string`
//                                                                         does not match return type `int`
//     int f(int a){ return a; } int g(){ return f(2, 3); }             -- expected 1 argument(s), not 2
//     int f(int a){ return a; } int g(){ return f("s"); }              -- cannot pass `"s"` of type `string`
//                                                                         to parameter `int a`

import { Parser } from "./parse.js";
import { ErrorSinkNull } from "./errorsink.js";
import { Type } from "./mtype.js";
import { PASS } from "./dsymbol.js";
import { global } from "./globals.js";
import { Module, moduleFromParse } from "./dmodule.js";
import { runSemantic } from "./dsymbolsem.js";
import { dsToJs } from "../dstring.js";
import type { FuncDeclaration } from "./func.js";
import { ExpStatement } from "./statement.js";
import type { VarDeclaration } from "./declaration.js";
import type { DeclarationExp, CallExp } from "./expression.js";
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

describe("Rung-3 ACCEPT — function bodies with locals / arithmetic / calls (errors === 0)", () => {
  it("`void f(){ int x = 5; return; }` — local scalar var + bare return; compiles clean", () => {
    const { module, errors } = sema("void f(){ int x = 5; return; }");
    expect(errors).toBe(0);
    const fd = nthFunc(module, 0);
    expect(fd.semanticRun).toBe(PASS.semantic3done);
  });

  it("`void h(){ int x = 1; int y = x + 2; }` — y's init reads local x; y typed int", () => {
    const { module, errors } = sema("void h(){ int x = 1; int y = x + 2; }");
    expect(errors).toBe(0);
    const fd = nthFunc(module, 0);
    expect(fd.semanticRun).toBe(PASS.semantic3done);

    // The body is a CompoundStatement of two ExpStatements, each wrapping a DeclarationExp of a
    // VarDeclaration. Assert `y` (the second local) resolved its declared type to int.
    const body = userBody(fd).isCompoundStatement()!;
    const stmts = body.statements!;
    const es = stmts.opIndex(1) as ExpStatement;
    expect(es).toBeInstanceOf(ExpStatement);
    const de = es.exp as unknown as DeclarationExp;
    const vy = de.declaration!.isVarDeclaration() as VarDeclaration;
    expect(dsToJs(vy.ident!.toString())).toBe("y");
    expect(vy.type).toBe(Type.tint32);
  });

  // ldc2 GROUND-TRUTH: `int f(int a){ return a + 1; } int g(){ return f(2); }` is VALID (f(2) -> int).
  //
  // REAL ACCEPT (the milestone). The in-function call `return f(2);` now type-checks end-to-end:
  //   - LEVEL B (attribute inference): checkImpure/checkSafety/checkNogc each take their non-inprocess
  //     tail (g/f are plain named free functions) and report NO violation for the impure/@system/non-@nogc
  //     caller `g`; the call f(2) resolves to `int`;
  //   - canThrow(CallExp): the nothrow-analysis arm (calledFunctionType + checkFuncThrows + setThrowCall)
  //     now runs. f is not nothrow → CT.exception; g is not nothrow so it is NOT a violation; setThrowCall
  //     is a faithful no-op (g.nothrowInprocess false);
  //   - optimize(CallExp) (const-fold inside implicitConvTo): folds the callee + each argument — a faithful
  //     no-op for f(2) (callee VarExp(f) and IntegerExp 2 fold to themselves);
  //   - CallExp.isLvalue (inside doCopyOrMove during checkReturnExp): f returns int by VALUE (not `ref`),
  //     so the call is an rvalue → false → doCopyOrMove passes it through unchanged.
  // g reaches semantic3done with errors === 0; the body `ReturnStatement`'s exp (the CallExp f(2)) is typed
  // `int`. ldc2: VALID, f(2) -> int.
  it("`int f(int a){ return a + 1; } int g(){ return f(2); }` — REAL ACCEPT: g type-checks, f(2) typed int (ldc2: int)", () => {
    const { module, errors } = sema("int f(int a){ return a + 1; } int g(){ return f(2); }");
    expect(errors).toBe(0);
    const g = nthFunc(module, 1);
    expect(g.semanticRun).toBe(PASS.semantic3done);
    // g's body is a single ReturnStatement; its exp is the CallExp f(2), typed int (Type.tint32).
    const retExp = g.returns!.opIndex(0)!.exp as unknown as CallExp;
    expect(retExp.type).toBe(Type.tint32);
  });
});

describe("Rung-3 REJECT — return / argument mismatches (errors > 0, no throw)", () => {
  it("`int f(){ return \"s\"; }` — return value of type string does not match return type int", () => {
    const { errors } = sema('int f(){ return "s"; }');
    expect(errors).toBeGreaterThan(0);
  });

  it("`int f(int a){ return a; } int g(){ return f(2, 3); }` — too many arguments (expected 1, got 2)", () => {
    const { errors } = sema("int f(int a){ return a; } int g(){ return f(2, 3); }");
    expect(errors).toBeGreaterThan(0);
  });

  it("`int f(int a){ return a; } int g(){ return f(\"s\"); }` — cannot pass string to int parameter", () => {
    const { errors } = sema('int f(int a){ return a; } int g(){ return f("s"); }');
    expect(errors).toBeGreaterThan(0);
  });

  // ATTRIBUTE-INFERENCE VIOLATION (purity). ldc2 GROUND-TRUTH:
  //   `int f(int a){return a+1;} pure int g(){ return f(2); }`
  //   → Error: `pure` function `g` cannot call impure function `f` (REJECT, errors > 0).
  // CONVERTED FROM A PINNED WALL TO A BEHAVIOUR PIN (10 §1.8 rule 7 / rule 2). This test used to pin
  // `TODO-BODY: isPure purityLevel resolve`: the pure caller `g` has `tf.purity == PURE.fwdref` here, so
  // checkImpure -> setImpure(g) -> isPure(g) had to resolve the fwdref level (`tf.purityLevel()`), which
  // was unported. That wall is GONE (grep: zero hits for the message in src/; `purityLevel` is live and
  // called at funcsem.ts:3827), the path now runs to completion, and the port emits D's own diagnostic:
  //   `pure` function `__anonymous.g` cannot call impure function `__anonymous.f`
  // (the `__anonymous.` qualification is this harness's unnamed module, not a message divergence). So the
  // case is now the plain REJECT ldc2 reports, asserted the same way as its three siblings above —
  // `errors > 0`, no throw. NOTE: the @safe / @nogc violation analogues (`@safe int g(){ return f(2); }`,
  // `@nogc int g(){ return f(2); }`) halt EARLIER at the `UserAttributeDeclaration.concat` boundary (any
  // `@system`/`@safe`/`@nogc` function declaration hits it before its body is analyzed), so they cannot
  // meaningfully pin at the safety/nogc inference guards yet.
  it("`int f(int a){return a+1;} pure int g(){ return f(2); }` — pure caller cannot call impure `f` (ldc2: REJECT)", () => {
    const { errors } = sema("int f(int a){return a+1;} pure int g(){ return f(2); }");
    expect(errors).toBeGreaterThan(0);
  });
});
