import { describe, it, expect, beforeEach } from "vitest";

// SEMA RUNG-3 SINGLE-FUNCTION CALL-RESOLUTION GOAL TESTS.
//
// Protects the Rung-3 deliverable that runs END-TO-END for the SINGLE-FUNCTION case: the callee of a
// `CallExp` that names a plain module-level free `FuncDeclaration` (e.g. `f` in `f(2)`) is resolved all
// the way to `exp.f` (the called FuncDeclaration) and to a `VarExp` callee typed as the function's
// `TypeFunction`. The argument-match / return-type-set TAIL (`callMatch` typesem.d:881 + `functionParameters`
// expressionsem.d:3236) is a deep unported sibling graph (escape/optimize/shared-access/copy-ctor run
// UNCONDITIONALLY before `exp.type` is set), so `visitCallExp` halts LOUDLY at the documented `callMatch`
// boundary rather than fabricating a reduced path around those siblings (00-how-to-use §5 / 11-escalate.md).
//
// GROUND-TRUTH pinned to ldc2-1.42.0 (`<ldc2-1.42.0>/bin/ldc2 -run`):
//   int f(int a){return a;}
//     typeof(f).mangleof    == "FiZi"   // the resolved callee VarExp's type deco (TypeFunction key)
//     typeof(f(2)).stringof == "int"    // the call RESULT type — the Rung-3+ target for functionParameters
//
// What RUNS LIVE this rung (asserted below):
//   - `f` (a name) resolves via symbolToExp's FuncDeclaration branch to a `VarExp` naming the function.
//   - that VarExp's own type is the function's `TypeFunction` (deco "FiZi", ty Tfunction) — set at VarExp
//     construction (dmd/expression.d:2364 `this.type = var.type`).
//   - `visitCallExp` runs the callee-resolution spine (unaSemantic → callee VarExp typed Tfunction), the
//     argument semantic + pre-pass, and resolves `exp.f` to the single FuncDeclaration `f`.
//
// What is DEFERRED (asserted to halt at the documented boundary, NOT silently):
//   - `callMatch` (argument/parameter match) — `visitCallExp` throws an auditable TODO-BODY at exactly
//     that point with `exp.f` already resolved. `functionParameters` (which sets `exp.type` = return type)
//     is the next gate. Both land in a later rung; the "int" result target is recorded here.

import { Parser } from "./parse.js";
import { Loc } from "./location.js";
import { ErrorSinkNull } from "./errorsink.js";
import { Type } from "./mtype.js";
import { TY } from "./astenums.js";
import { global } from "./globals.js";
import { Module, moduleFromParse } from "./dmodule.js";
import { Scope } from "./dscope.js";
import { runSemantic, scopeCreateGlobal } from "./dsymbolsem.js";
import { Identifier } from "./identifier.js";
import { ds, dsToJs } from "../dstring.js";
import { IdentifierExp, IntegerExp, CallExp } from "./expression.js";
import { Array as DArray } from "./root/array.js";
import { expressionSemantic } from "./expressionsem.js";
import type { Expression } from "./expression.js";
import type { Expressions } from "./arraytypes.js";
import type { Statement } from "./statement.js";
import type { FuncDeclaration } from "./func.js";
import { FatalError, setDiagnosticHandler, setFatalErrorHandler, throwFatalError } from "./errors.js";
import { dmdformat } from "./root/dmdformat.js";
import { initSemaHarness } from "../sema-harness.js";

beforeEach(() => {
  initSemaHarness();
});

function srcBuf(s: string): Uint8Array {
  const b = new Uint8Array(s.length + 1);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  b[s.length] = 0;
  return b;
}

/** Lex+parse `src` into a Module, run the `runSemantic` driver (passes 0-3), build the global Scope. */
function semaModule(src: string): { module: Module; sc: Scope } {
  const p = new Parser(null, null, srcBuf(src), false, new ErrorSinkNull(), null, false);
  p.nextToken();
  const m = moduleFromParse(p.parseModule(), p.md);
  runSemantic(m);
  expect(global.errors).toBe(0);
  return { module: m, sc: scopeCreateGlobal(m, global.errorSink!) };
}

function ident(name: string): IdentifierExp {
  return new IdentifierExp(Loc.initial, Identifier.idPool(ds(name)));
}

function args(...exps: Expression[]): Expressions {
  const a = new DArray<Expression | null>();
  for (const e of exps) a.push(e);
  return a as unknown as Expressions;
}

describe("CallExp single-function resolution — callee resolves to a Tfunction-typed VarExp (live)", () => {
  it("`f` (the callee name) resolves to a VarExp typed `FiZi` (the function's TypeFunction)", () => {
    // The callee-resolution spine. A bare `f` name, looked up in the module scope, resolves through
    // symbolToExp's FuncDeclaration branch to a `VarExp` naming the function. Its type is the function's
    // `TypeFunction` (deco "FiZi", ty Tfunction) — ldc2: typeof(f).mangleof == "FiZi".
    const { sc } = semaModule("int f(int a) { return a; }");
    const callee = expressionSemantic(ident("f"), sc);

    const ve = callee.isVarExp();
    expect(ve).not.toBeNull();
    expect(ve!.var_!.isFuncDeclaration()).not.toBeNull();         // the VarExp names the function
    expect(dsToJs(ve!.var_!.ident!.toString())).toBe("f");
    expect(ve!.type).not.toBeNull();
    expect(ve!.type!.ty).toBe(TY.Tfunction);                     // typed as a function
    expect(ve!.type!.deco).toBe("FiZi");                         // ldc2 ground-truth
  });
});

describe("CallExp single-function resolution — `f(2)` matches its argument and the call result type is set", () => {
  it("`f(2)` (module scope) passes callMatch + the attribute/access checks and sets the call result type to `int`", () => {
    // The single-function call spine, now END-TO-END at MODULE scope: callee resolved to a Tfunction-typed
    // VarExp, the argument semantic'd and pre-processed, `exp.f` set to the one FuncDeclaration, `callMatch`
    // accepts (the single `int` arg matches the single `int` parameter), then `checkFunctionAttributes`
    // (purity/safety/nogc each early-return on `sc.func == null`; `f` is not @disable/@deprecated) and
    // `checkAccess(loc, sc, null, f)` (receiver-less → false) are NO-OPS, and `functionParameters` sets
    // `exp.type = tf.next == int`. ACCEPT, no throw.
    //   ldc2 ground-truth: `int f(int a){return a;} pragma(msg, typeof(f(2)).stringof);` → prints `int`.
    const { sc } = semaModule("int f(int a) { return a; }");
    const call = new CallExp(Loc.initial, ident("f"), args(new IntegerExp(Loc.initial, 2n, Type.tint32)));

    // No throw: the call analysis completes at module scope.
    expect(() => expressionSemantic(call, sc)).not.toThrow();

    // `exp.f` is resolved to the single function `f` (typed FiZi) AND the argument matched.
    expect(call.f).not.toBeNull();
    expect(dsToJs(call.f!.ident!.toString())).toBe("f");
    expect(call.f!.type!.deco).toBe("FiZi");

    // the callee `exp.e1` is the Tfunction-typed VarExp the match consumed.
    const ve = call.e1!.isVarExp();
    expect(ve).not.toBeNull();
    expect(call.e1!.type!.ty).toBe(TY.Tfunction);
    expect(call.e1!.type!.deco).toBe("FiZi");

    // THE RESULT TYPE IS SET — `functionParameters` set `exp.type = tf.next` (the return type).
    //   ldc2: typeof(f(2)).stringof == "int"  →  ty Tint32, deco "i".
    expect(call.type).not.toBeNull();
    expect(call.type!.ty).toBe(TY.Tint32);
    expect(call.type!.deco).toBe("i");
  });

  it("a void-returning single function `v(3)` (module scope) likewise sets the call result type to `void`", () => {
    //   ldc2 ground-truth: `void v(int a){} pragma(msg, typeof(v(3)).stringof);` → prints `void`.
    const { sc } = semaModule("void v(int a) { }");
    const call = new CallExp(Loc.initial, ident("v"), args(new IntegerExp(Loc.initial, 3n, Type.tint32)));

    expect(() => expressionSemantic(call, sc)).not.toThrow();
    expect(call.f).not.toBeNull();
    expect(call.f!.type!.deco).toBe("FiZv");
    expect(call.e1!.type!.ty).toBe(TY.Tfunction);

    // THE RESULT TYPE IS SET — `functionParameters` set `exp.type = tf.next == void`.
    expect(call.type).not.toBeNull();
    expect(call.type).toBe(Type.tvoid);
    expect(call.type!.ty).toBe(TY.Tvoid);
  });
});

describe("CallExp callee-resolution boundary — an unresolved callee routes through the callee spine", () => {
  it("calling an UNDEFINED name runs the callee through `unaSemantic` → name lookup (not a false resolution)", () => {
    // The callee `unaSemantic` runs `expressionSemantic` on the IdentifierExp `nope`, which misses the
    // module-scope lookup.
    //
    // CONVERTED FROM A PINNED WALL TO A BEHAVIOUR PIN (10 §1.8 rule 7 / rule 2). This test used to pin
    // `TODO-BODY: visitIdentifierExp not-found tail hasThis gate` (the unported `hasThis` alias-this
    // fallback, dmd/expressionsem.d:4639). That wall is GONE from the tree (grep: zero hits for the
    // message in src/ outside this file), so the not-found tail now runs to completion and produces what
    // D produces for an unresolved name:
    //   ldc2 GROUND-TRUTH: `void g(){ nope(2); }` → Error: undefined identifier `nope` (REJECT, 1 error),
    //   and the erroring expression is replaced by an ErrorExp (dmd/expressionsem.d visitIdentifierExp's
    //   not-found tail → `ErrorExp.get()`), which `visitCallExp` propagates without resolving a callee.
    // So the assertion is now about the live result: ONE error, an ErrorExp back, and — the point this
    // test has always been about — NO fabricated function resolution on the CallExp itself.
    const { sc } = semaModule("int f(int a) { return a; }");
    const errorsBefore = global.errors;
    const call = new CallExp(Loc.initial, ident("nope"), args(new IntegerExp(Loc.initial, 2n, Type.tint32)));

    const res = expressionSemantic(call, sc);

    expect(global.errors - errorsBefore).toBe(1); // exactly the one `undefined identifier` D emits
    expect(res.isErrorExp()).not.toBeNull(); // the not-found tail returns ErrorExp, not a typed call
    expect(call.f).toBeNull(); // no function resolved for an unresolved callee
  });
});

// ── arrayExpressionSemantic's write-back (dmd/expressionsem.d:1923) ─────────────────────────────────────────
//
// D hands `container.peekSlice()` to `arrayExpressionSemantic`, a LIVE slice, and `foreach (ref e; exps)`
// stores each analysed expression back into the container. Each case below routes an unanalysed
// `IdentifierExp` through one caller of it; when the write-back is lost, the container keeps the raw
// IdentifierExp and the next reader fails with `cannot resolve type for <name>`. ldc2 accepts every
// clean-accept source here: `ldc2-1.43.0 -c -o- <file>` exits 0 with empty stderr.
//
// Not pinned: the struct-literal elements site (expressionsem.d:6174). Every source that reaches it today
// hands over elements already analysed as call arguments at :7822, so its write-back changes nothing
// observable. The AA-literal sites (:6131-6132) have no clean accept: the literal always lowers through
// `_d_assocarrayliteralTX` (:6087), which this harness's empty `object` lacks. They are pinned instead on the
// diagnostics ldc2 gives against an empty object.d.

/** The first statement of `fd`'s analysed body; a one-statement body may or may not be wrapped (10 §1.8). */
function firstStatement(m: Module, fname: string): Statement {
  let fd: FuncDeclaration | null = null;
  for (const s of m.members!) {
    const f = s!.isFuncDeclaration();
    if (f !== null && dsToJs(f.ident!.toString()) === fname) fd = f;
  }
  const body = fd!.fbody!;
  const cs = body.isCompoundStatement();
  return cs !== null ? cs.statements!.opIndex(0)! : body;
}

describe("arrayExpressionSemantic write-back — the analysed arguments/elements land in their container", () => {
  it("call arguments (expressionsem.d:7822): `run(argc)` keeps the analysed `argc`, typed int", () => {
    const { module } = semaModule("void run(int a); void g(int argc){ run(argc); }");   // errors 0, as ldc2
    const ce = firstStatement(module, "g").isExpStatement()!.exp!.isCallExp()!;
    const arg = ce.arguments_!.opIndex(0)!;
    expect(arg.isVarExp()).not.toBeNull();
    expect(dsToJs(arg.isVarExp()!.var_!.ident!.toString())).toBe("argc");
    expect(arg.type!.deco).toBe("i");
  });

  it("a function-literal call's arguments (expressionsem.d:7593): `(int x){}(a)`", () => {
    const { module } = semaModule("void g(int a){ (int x){}(a); }");   // errors 0, as ldc2
    const ce = firstStatement(module, "g").isExpStatement()!.exp!.isCallExp()!;
    const arg = ce.arguments_!.opIndex(0)!;
    expect(arg.isVarExp()).not.toBeNull();
    expect(arg.type!.deco).toBe("i");
  });

  it("NewExp arguments (expressionsem.d:6621): `new C(a)` compiles as ldc2 does", () => {
    semaModule("class C { this(int y){} } void g(int a){ auto c = new C(a); }");   // errors 0, as ldc2
  });

  it("array literal elements (expressionsem.d:6057): `int[2] x = [a, a];` compiles as ldc2 does", () => {
    semaModule("void g(int a){ int[2] x = [a, a]; }");   // errors 0, as ldc2
  });

  it("struct literal `S(a)`: its arguments at expressionsem.d:7822 compile as ldc2 does", () => {
    semaModule("struct S { int x; } void g(int a){ auto s = S(a); }");   // errors 0, as ldc2
  });

  it("AA literal keys and values (expressionsem.d:6131-6132): `f([a: a])` reaches the hook, as ldc2 does", () => {
    // Oracle: `ldc2-1.43.0 -conf= -c -o- -Ieo aa.d`, eo/object.d = `module object;`, rc 1, these two errors.
    // The second ends in `fatal()` (typinf.d:68); the fatal handler turns the exit into `FatalError`. With
    // either write-back lost the port stops earlier, at `cannot resolve type for a`.
    // The literal sits in a call, not an initializer: `auto aa = [a: a];` parses as an ArrayInitializer,
    // whose values inferType analyses before it builds the literal (initsem.d:1279, `iz = iz.inferType(sc);`),
    // which would hide a lost write-back at :6132.
    const messages: string[] = [];
    setDiagnosticHandler((_loc, _color, _header, messageFormat, args) => {
      messages.push(dsToJs(dmdformat(messageFormat, [...args])));
      return true;
    });
    setFatalErrorHandler(throwFatalError);
    try {
      const src = srcBuf("void f(int[int] x); void g(int a){ f([a: a]); }");
      const p = new Parser(null, null, src, false, new ErrorSinkNull(), null, false);
      p.nextToken();
      const m = moduleFromParse(p.parseModule(), p.md);
      expect(() => runSemantic(m)).toThrow(FatalError);
    } finally {
      setDiagnosticHandler(null);
      setFatalErrorHandler(null);
    }
    expect(global.errors).toBe(2);
    expect(messages).toEqual([
      "`object._d_assocarrayliteralTX` not found. The current runtime does not support initializing associative "
        + "arrays, or the runtime is corrupt.",
      "`object.TypeInfo` could not be found, but is implicitly used",
    ]);
  });
});

// ── IsExp `dedtypes` (dmd/expressionsem.d:9225) ────────────────────────────────────────────────────────────
//
// D's `dedtypes.zero()` sets every slot to `T.init`, null for Objects; the port's `Array.zero()` does not
// fill, so the site fills with null itself (08 §2.0a). Without it `deduceType` reads an `undefined` slot.
describe("IsExp deduction starts from null `dedtypes` slots", () => {
  it("`is(S!int == S!X, X)` deduces X, as ldc2 does", () => {
    semaModule("struct S(T){} enum b = is(S!int == S!X, X); static assert(b);");   // errors 0, as ldc2
  });
});

describe("the sema harness installs TypeDeduced (initDtemplate) for template deduction", () => {
  it("a call with partially explicit template arguments, `f!int(1)`, compiles as ldc2 does", () => {
    semaModule("void f(T, U)(U u){} void g(){ f!int(1); }");   // errors 0, as ldc2
  });
});
