import { describe, it, expect, beforeEach } from "vitest";

// SEMA RUNG-3 FUNCTION SIGNATURE + BODY GOAL TESTS.
//
// These protect the Rung-3 deliverable that runs END-TO-END: a MODULE-LEVEL FREE FUNCTION gets its
// SIGNATURE resolved by `funcDeclarationSemantic` (pass 1) AND its BODY analyzed by `semantic3` (pass 3,
// now wired into `runSemantic`). Pass 1 resolves the `TypeFunction` (parameter + return types via
// `typeSemantic`), folds the storage classes / linkage / visibility, and sets `parent`. Pass 3 sets up
// the body scope (parameters visible via `declareThis` + parameter declaration), runs
// `statementSemantic` on the body, and type-checks each `return` against the declared return type. After
// pass 3 the function's `semanticRun` is `semantic3done`.
//
// GROUND-TRUTH pinned to ldc2-1.42.0 (`typeof(f).mangleof`, i.e. the interned TypeFunction `deco`):
//   int  f(int a) -> "FiZi"   (F = D-linkage function, i = int param, Z = end args, i = int return)
//   int  g()      -> "FZi"
//   void v(int a) -> "FiZv"
// The TS port reproduces each `deco` byte-for-byte (the mangle ABI is the type's interned key).
//
// SCOPE NOTE: these bodies (`return a;`, `return 0;`, empty) exercise the value-return / void path. A
// body that DECLARES a local var (`int x = 1;`) reaches the STOP-escalated `visit(AssignExp)` boundary
// (ConstructExp.semantic), which is a later rung; the function REFERENCE / CALL resolution to a CallExp
// is covered by sema.callexp.test.ts.

import { Parser } from "./parse.js";
import { Loc } from "./location.js";
import { ErrorSinkNull } from "./errorsink.js";
import { Type } from "./mtype.js";
import { TY } from "./astenums.js";
import { LINK } from "./astenums.js";
import { PASS } from "./dsymbol.js";
import { global } from "./globals.js";
import { Module, moduleFromParse } from "./dmodule.js";
import { search } from "./dsymbolsem.js";
import { runSemantic } from "./dsymbolsem.js";
import { Identifier } from "./identifier.js";
import { ds, dsToJs } from "../dstring.js";
import type { Dsymbol } from "./dsymbol.js";
import type { FuncDeclaration } from "./func.js";
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

/** Lex+parse `src` into a Module, run the `runSemantic` driver (passes 0-3), return the module + error count. */
function sema(src: string): { module: Module; errors: number } {
  const p = new Parser(null, null, srcBuf(src), false, new ErrorSinkNull(), null, false);
  p.nextToken();
  const m = moduleFromParse(p.parseModule(), p.md);
  runSemantic(m);
  return { module: m, errors: global.errors };
}

function firstFunc(m: Module): FuncDeclaration {
  const fd = sourceMembers(m)[0]!.isFuncDeclaration();
  expect(fd).not.toBeNull();
  return fd!;
}

describe("funcDeclarationSemantic — module-level free function signature (full body, common case)", () => {
  it("ACCEPT `int f(int a){...}`: errors === 0, deco FiZi, ret int, one int param `a`, semanticdone", () => {
    // The GOAL case. Pass-1 resolves the TypeFunction: the return type and the parameter type are
    // `typeSemantic`'d to `int`, the parameter `a` keeps its identifier, and the function type interns
    // to deco `FiZi` (ldc2 ground-truth). Pass-3 then analyzes the body `{ return a; }` (the parameter
    // `a` resolves; `return a` type-checks int→int) and the function reaches `semantic3done`.
    const { module, errors } = sema("int f(int a) { return a; }");
    expect(errors).toBe(0);

    const fd = firstFunc(module);
    expect(dsToJs(fd.ident!.toString())).toBe("f");
    expect(fd.semanticRun).toBe(PASS.semantic3done);
    expect(fd.parent).toBe(module);                 // parent set to the enclosing module
    expect(fd._linkage).toBe(LINK.d);               // D linkage picked up from the scope

    const tf = fd.type!.isTypeFunction();
    expect(tf).not.toBeNull();
    expect(fd.type!.deco).toBe("FiZi");             // interned TypeFunction key (ldc2: typeof(f).mangleof)

    expect(tf!.next).toBe(Type.tint32);             // return type resolved to int
    expect(tf!.next!.ty).toBe(TY.Tint32);

    expect(tf!.parameterList.length()).toBe(1);     // one parameter
    const p0 = tf!.parameterList.opIndex(0)!;
    expect(p0.type).toBe(Type.tint32);              // parameter type resolved to int
    expect(p0.ident).not.toBeNull();                // the parameter identifier `a` is preserved
    expect(dsToJs(p0.ident!.toString())).toBe("a");
  });

  it("ACCEPT `int g(){...}`: zero parameters, return int, deco FZi", () => {
    // A no-parameter function. The empty parameter list resolves to arity 0; the return int interns the
    // type to deco `FZi` (ldc2 ground-truth).
    const { module, errors } = sema("int g() { return 0; }");
    expect(errors).toBe(0);

    const fd = firstFunc(module);
    expect(fd.semanticRun).toBe(PASS.semantic3done);
    const tf = fd.type!.isTypeFunction()!;
    expect(fd.type!.deco).toBe("FZi");
    expect(tf.next).toBe(Type.tint32);
    expect(tf.parameterList.length()).toBe(0);
  });

  it("ACCEPT `void v(int a){...}`: void return, one int param, deco FiZv", () => {
    // A void-returning function with one parameter. The return type resolves to `void`; deco `FiZv`.
    const { module, errors } = sema("void v(int a) { }");
    expect(errors).toBe(0);

    const fd = firstFunc(module);
    expect(fd.semanticRun).toBe(PASS.semantic3done);
    const tf = fd.type!.isTypeFunction()!;
    expect(fd.type!.deco).toBe("FiZv");
    expect(tf.next!.ty).toBe(TY.Tvoid);
    expect(tf.parameterList.length()).toBe(1);
    expect(tf.parameterList.opIndex(0)!.type).toBe(Type.tint32);
  });

  it("the function is inserted into the module symbol table (add-member pre-pass), findable by name", () => {
    // The add-member pre-pass plants `f` into the module symtab BEFORE per-member sema, so a name lookup
    // resolves it. (The task's "the func is inserted into the parent symtab by the add-member pre-pass".)
    const { module, errors } = sema("int f(int a) { return a; }");
    expect(errors).toBe(0);
    const found = search(module as unknown as Dsymbol, Loc.initial, Identifier.idPool(ds("f")));
    expect(found).not.toBeNull();
    expect(found!.isFuncDeclaration()).not.toBeNull();
    expect(found!.isFuncDeclaration()).toBe(firstFunc(module));
  });

  it("two independent functions both resolve their signatures (driver runs both)", () => {
    const { module, errors } = sema("int f(int a) { return a; } void v(int a) { }");
    expect(errors).toBe(0);
    const members = sourceMembers(module);
    expect(members.length).toBe(2);
    const f = members[0]!.isFuncDeclaration()!;
    const v = members[1]!.isFuncDeclaration()!;
    expect(f.type!.deco).toBe("FiZi");
    expect(v.type!.deco).toBe("FiZv");
    expect(f.semanticRun).toBe(PASS.semantic3done);
    expect(v.semanticRun).toBe(PASS.semantic3done);
  });
});
