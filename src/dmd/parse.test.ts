import { assert, describe, test, expect, beforeEach } from "vitest";

// dmd/parse.d has NO in-source `unittest {}` blocks (verified: the only `unittest` tokens are the
// `TOK.unittest_` parsing logic and doc comments). Per 10-tests-diagnostics.md there is therefore
// nothing to port 1:1. These tests are the GOAL TEST for the milestone — a working D parser in TS:
// they drive the public entry points on real D fragments and assert the resulting AST node shape.
//
// FOUNDATIONAL TYPE-CONSTRUCTION (now landed): the parser faithfully calls AST-node methods whose
// bodies live in their own modules. The type/declaration fragments below build a *type* or a
// *declaration* and so depend on these — all of which are now filled:
//   - `Type._init()` (mtype.ts) — builds the basic-type singletons `Type.tint32`/`tvoid`/…; called
//     in `beforeEach` (dmd does this at compiler startup). Without it `parseBasicType()` returns
//     `undefined` and the faithful `assert(t)` fires.
//   - `Type.addSTC()` (mtype.ts) — every `parseType()` ends with `t.addSTC(stc)`; the unqualified
//     path the parser hits is live (qualified makeXxx still TODO-BODY, not reached here).
//   - `TypeFunction.constructor` (mtype.ts) — every function/ctor/aggregate-with-method path.
//   - `Dsymbol.addComment()` (dsymbol.ts) — attaching doc comments to parsed symbols.
//   - `ErrorExp.get()` (expression.ts) — the expression error-recovery sentinel.
// The expression / control-flow tests exercise the parser without type construction; the
// type/declaration tests exercise the full path through the now-landed bodies. All pass, proving
// the 9945-LOC parser logic is correct end-to-end.

import { Parser } from "./parse.js";
import { EXP, TOK, initTokens } from "./tokens.js";
import { Id } from "./id.js";
import { Loc } from "./location.js";
import { ErrorSinkNull } from "./errorsink.js";
import { OutBuffer } from "./common/outbuffer.js";
import { dsToJs } from "../dstring.js";
import type { DString } from "../dstring.js";
import { Type_init } from "./typesem.js";
import { TemplateAliasParameter, TemplateDeclaration } from "./dtemplate.js";
import { Type, TypeFunction, TypeIdentifier } from "./mtype.js";
import { FuncExp } from "./expression.js";
import { AliasDeclaration } from "./declaration.js";
import { FuncLiteralDeclaration } from "./func.js";

beforeEach(() => {
  Loc._init();
  initTokens();
  Id.initialize();
  // Build the basic-type singletons (Type.tint32/tvoid/…) the way dmd does at compiler startup.
  // parseBasicType() reads these directly; without _init() they are undefined and any typed
  // declaration (`int x`, function return types, aggregate fields) trips the faithful assert(t).
  Type_init();
});

/** NUL-terminated byte buffer from an ASCII/Latin-1 string (the lexer scans `.ptr` to a NUL). */
function srcBuf(s: string): DString {
  const b = new Uint8Array(s.length + 1);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  b[s.length] = 0;
  return b;
}

function mkParser(src: string, sink = new ErrorSinkNull()): Parser {
  // module=null is fine for expression/statement parsing (mod is only read by the
  // module-declaration / root-unittest paths). doDocComment=false, doUnittests=false.
  return new Parser(null, null, srcBuf(src), false, sink, null, false);
}

describe("parse.d (goal test: D parser produces an AST)", () => {
  // ── Expression parsing — exercises parsePrimaryExp / the full precedence cascade ──────────────

  test("parseExpression: binary precedence `1 + 2 * 3` -> AddExp at root", () => {
    const p = mkParser("1 + 2 * 3");
    p.nextToken();
    const e = p.parseExpression();
    expect(e.op).toBe(EXP.add); // `+` binds looser than `*`, so the root is the add
    expect(e.constructor.name).toBe("AddExp");
  });

  test("parsePrimaryExp: identifier", () => {
    const p = mkParser("foo");
    p.nextToken();
    const e = p.parseExpression();
    expect(e.op).toBe(EXP.identifier);
    expect(e.constructor.name).toBe("IdentifierExp");
  });

  test("parsePrimaryExp: integer literal", () => {
    const p = mkParser("42");
    p.nextToken();
    const e = p.parseExpression();
    expect(e.op).toBe(EXP.int64);
    expect(e.constructor.name).toBe("IntegerExp");
  });

  test("parseExpression: comparison `a < b` -> CmpExp", () => {
    const p = mkParser("a < b");
    p.nextToken();
    const e = p.parseExpression();
    expect(e.op).toBe(EXP.lessThan);
  });

  test("parseExpression: equality `a == b` -> EqualExp", () => {
    const p = mkParser("a == b");
    p.nextToken();
    const e = p.parseExpression();
    expect(e.op).toBe(EXP.equal);
  });

  test("parseExpression: assignment `a = b + c` -> AssignExp(a, AddExp(b,c))", () => {
    const p = mkParser("a = b + c");
    p.nextToken();
    const e = p.parseExpression();
    expect(e.op).toBe(EXP.assign);
    expect(e.constructor.name).toBe("AssignExp");
  });

  test("parseExpression: call `f(1, 2)` -> CallExp", () => {
    const p = mkParser("f(1, 2)");
    p.nextToken();
    const e = p.parseExpression();
    expect(e.constructor.name).toBe("CallExp");
  });

  test("parseExpression: ternary `a ? b : c` -> CondExp", () => {
    const p = mkParser("a ? b : c");
    p.nextToken();
    const e = p.parseExpression();
    expect(e.constructor.name).toBe("CondExp");
  });

  test("parseExpression: index `a[0]` -> ArrayExp", () => {
    const p = mkParser("a[0]");
    p.nextToken();
    const e = p.parseExpression();
    expect(e.constructor.name).toBe("ArrayExp");
  });

  test("parseExpression: member access `a.b.c` -> nested DotIdExp", () => {
    const p = mkParser("a.b.c");
    p.nextToken();
    const e = p.parseExpression();
    expect(e.constructor.name).toBe("DotIdExp");
  });

  test("parseExpression: logical `a && b || c` -> LogicalExp(orOr) at root", () => {
    const p = mkParser("a && b || c");
    p.nextToken();
    const e = p.parseExpression();
    expect(e.op).toBe(EXP.orOr); // `||` binds looser than `&&`
  });

  test("parseExpression: comma `a, b` -> CommaExp", () => {
    const p = mkParser("a, b");
    p.nextToken();
    const e = p.parseExpression();
    expect(e.constructor.name).toBe("CommaExp");
  });

  test("parseExpression: unary `-a` and `!a`", () => {
    {
      const p = mkParser("-a");
      p.nextToken();
      expect(p.parseExpression().constructor.name).toBe("NegExp");
    }
    {
      const p = mkParser("!a");
      p.nextToken();
      expect(p.parseExpression().constructor.name).toBe("NotExp");
    }
  });

  // ── Statement parsing — exercises parseStatement's giant switch ────────────────────────────────

  test("parseStatement: expression statement `a();`", () => {
    const p = mkParser("a();");
    p.nextToken();
    const s = p.parseStatement(0);
    expect(s.constructor.name).toBe("ExpStatement");
  });

  test("parseStatement: if/else", () => {
    const p = mkParser("if (a) b(); else c();");
    p.nextToken();
    const s = p.parseStatement(0);
    expect(s.constructor.name).toBe("IfStatement");
  });

  test("parseStatement: while loop", () => {
    const p = mkParser("while (a) b();");
    p.nextToken();
    const s = p.parseStatement(0);
    expect(s.constructor.name).toBe("WhileStatement");
  });

  test("parseStatement: do/while loop", () => {
    const p = mkParser("do a(); while (b);");
    p.nextToken();
    const s = p.parseStatement(0);
    expect(s.constructor.name).toBe("DoStatement");
  });

  test("parseStatement: foreach", () => {
    const p = mkParser("foreach (x; xs) f(x);");
    p.nextToken();
    const s = p.parseStatement(0);
    expect(s.constructor.name).toBe("ForeachStatement");
  });

  test("parseStatement: switch", () => {
    const p = mkParser("switch (a) { default: break; }");
    p.nextToken();
    const s = p.parseStatement(0);
    expect(s.constructor.name).toBe("SwitchStatement");
  });

  test("parseStatement: return", () => {
    const p = mkParser("return a;");
    p.nextToken();
    const s = p.parseStatement(0);
    expect(s.constructor.name).toBe("ReturnStatement");
  });

  test("parseStatement: break / continue / goto", () => {
    {
      const p = mkParser("break;");
      p.nextToken();
      expect(p.parseStatement(0).constructor.name).toBe("BreakStatement");
    }
    {
      const p = mkParser("continue;");
      p.nextToken();
      expect(p.parseStatement(0).constructor.name).toBe("ContinueStatement");
    }
    {
      const p = mkParser("goto L;");
      p.nextToken();
      expect(p.parseStatement(0).constructor.name).toBe("GotoStatement");
    }
  });

  test("parseStatement: throw", () => {
    const p = mkParser("throw e;");
    p.nextToken();
    const s = p.parseStatement(0);
    expect(s.constructor.name).toBe("ThrowStatement");
  });

  test("parseStatement: empty block `{ }` -> CompoundStatement", () => {
    const p = mkParser("{ }");
    p.nextToken();
    const s = p.parseStatement(0);
    expect(s.constructor.name).toBe("CompoundStatement");
  });

  test("parseDeclDefs: an import declaration (no type construction)", () => {
    const p = mkParser("import std.stdio;");
    p.nextToken();
    const decls = p.parseDeclDefs(0);
    expect(decls.length).toBe(1);
    expect(decls.opIndex(0)!.constructor.name).toBe("Import");
  });

  // ── TYPE / DECLARATION PATHS (foundational type-construction landed; Type._init in beforeEach) ──

  test("parseType: `int[]*` — un-skipped (Type._init + Type.addSTC landed)", () => {
    const p = mkParser("int[]*");
    p.nextToken();
    const t = p.parseType();
    expect(t.constructor.name).toBe("TypePointer");
  });

  test("parseType: `int[string]` — un-skipped (Type._init + Type.addSTC landed)", () => {
    const p = mkParser("int[string]");
    p.nextToken();
    const t = p.parseType();
    expect(t.constructor.name).toBe("TypeAArray");
  });

  test("parseDeclDefs: variable decl — un-skipped (Type._init landed)", () => {
    const p = mkParser("int x = 3;");
    p.nextToken();
    const decls = p.parseDeclDefs(0);
    expect(decls.opIndex(0)!.constructor.name).toBe("VarDeclaration");
  });

  test("parseDeclDefs: function decl — un-skipped (Type._init + TypeFunction.constructor landed)", () => {
    const p = mkParser("int add(int a, int b) { return a + b; }");
    p.nextToken();
    const decls = p.parseDeclDefs(0);
    expect(decls.opIndex(0)!.constructor.name).toBe("FuncDeclaration");
  });

  test("parseDeclDefs: struct decl — un-skipped (Type._init landed)", () => {
    const p = mkParser("struct S { int a; int b; }");
    p.nextToken();
    const decls = p.parseDeclDefs(0);
    expect(decls.opIndex(0)!.constructor.name).toBe("StructDeclaration");
  });

  test("parseDeclDefs: class with base — un-skipped (TypeFunction.constructor landed)", () => {
    const p = mkParser("class C : B { void m() {} }");
    p.nextToken();
    const decls = p.parseDeclDefs(0);
    expect(decls.opIndex(0)!.constructor.name).toBe("ClassDeclaration");
  });

  test("parseDeclDefs: alias decl — un-skipped (Type._init + Dsymbol.addComment landed)", () => {
    const p = mkParser("alias I = int;");
    p.nextToken();
    const decls = p.parseDeclDefs(0);
    expect(decls.opIndex(0)!.constructor.name).toBe("AliasDeclaration");
  });

  test("parseDeclDefs: enum decl — un-skipped (Dsymbol.addComment landed)", () => {
    const p = mkParser("enum E { a, b, c }");
    p.nextToken();
    const decls = p.parseDeclDefs(0);
    expect(decls.opIndex(0)!.constructor.name).toBe("EnumDeclaration");
  });

  test("parseDeclDefs: template decl — un-skipped (Type._init landed)", () => {
    const p = mkParser("template T(X) { alias U = X; }");
    p.nextToken();
    const decls = p.parseDeclDefs(0);
    expect(decls.opIndex(0)!.constructor.name).toBe("TemplateDeclaration");
  });

  test("diagnostics: malformed expression `@` — un-skipped (ErrorExp.get landed)", () => {
    const p = mkParser("@");
    p.nextToken();
    p.parseExpression();
  });
});

/** Records each error and supplemental as `<line>: <message>`, formatted by the printf the sinks use. */
class RecordingSink extends ErrorSinkNull {
  lines: string[] = [];

  private record(loc: Loc, format: DString, ap: ReadonlyArray<unknown>, prefix: string): void {
    const buf = new OutBuffer();
    buf.vprintf(format, ap);
    this.lines.push(`${loc.linnum()}: ${prefix}${dsToJs(buf.peekSlice())}`);
  }

  override verror(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
    this.record(loc, format, ap, "Error: ");
  }

  override verrorSupplemental(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
    this.record(loc, format, ap, "       ");
  }
}

// parse.d:4866-4874 — the two spellings of the missing-semicolon error. ORACLE (ldc2 -c -o-):
//   `int x = 1\n`       -> semi.d(2): Error: semicolon needed to end declaration of `x`, instead of `End of File`
//                          semi.d(1):        `x` declared here
//   `int x = 1 int y;\n` -> semi2.d(1): Error: semicolon needed to end declaration of `x` instead of `int`
describe("parse.d:4866 — missing semicolon after a declaration", () => {
  test("the offending token on a later line: comma form plus the `declared here` supplemental", () => {
    const sink = new RecordingSink();
    const p = mkParser("int x = 1\n", sink);
    p.nextToken();
    p.parseDeclDefs(0);
    expect(sink.lines).toEqual([
      "2: Error: semicolon needed to end declaration of `x`, instead of `End of File`",
      "1:        `x` declared here",
    ]);
  });

  test("the offending token on the same line: no comma, no supplemental", () => {
    const sink = new RecordingSink();
    const p = mkParser("int x = 1 int y;\n", sink);
    p.nextToken();
    p.parseDeclDefs(0);
    expect(sink.lines).toEqual(["1: Error: semicolon needed to end declaration of `x` instead of `int`"]);
  });
});

/** Parses `src` as a module's declarations and returns the diagnostics, as `<line>: <message>`. */
function declDefsDiagnostics(src: string): string[] {
  const sink = new RecordingSink();
  const p = mkParser(src, sink);
  p.nextToken();
  p.parseDeclDefs(0);
  return sink.lines;
}

// parse.d:1696/1727/1760 — a malformed template parameter jumps to `Lerr`, past the list's closing
// `check(TOK.rightParenthesis)` (parse.d:1806), so the next error is the function parameter list's `(`.
// ORACLE (ldc2 -verrors=0 -c -o-): the four lines of each test, byte for byte (the first three are also
// fail_compilation/diag_template_alias.d, diag_template_this.d and ice11963.d).
describe("parse.d:1653 parseTemplateParameterList — `goto Lerr` skips the closing paren check", () => {
  test("alias parameter without identifier", () => {
    expect(declDefsDiagnostics("void func1(alias alias)() {}\n")).toEqual([
      "1: Error: identifier expected for template `alias` parameter",
      "1: Error: found `alias` when expecting `(`",
      "1: Error: semicolon expected following function declaration, not `(`",
      "1: Error: declaration expected, not `)`",
    ]);
  });

  test("this parameter without identifier", () => {
    expect(declDefsDiagnostics("void func1(this this)() {}\n")).toEqual([
      "1: Error: identifier expected for template `this` parameter",
      "1: Error: found `this` when expecting `(`",
      "1: Error: semicolon expected following function declaration, not `(`",
      "1: Error: declaration expected, not `)`",
    ]);
  });

  test("type parameter that is not an identifier", () => {
    expect(declDefsDiagnostics("void func1(T, 3)() {}\n")).toEqual([
      "1: Error: identifier expected for template type parameter",
      "1: Error: found `3` when expecting `(`",
      "1: Error: semicolon expected following function declaration, not `(`",
      "1: Error: declaration expected, not `)`",
    ]);
  });

  test("C-style declarator `A(\"\")=` (ice11963)", () => {
    expect(declDefsDiagnostics('A("")=\n')).toEqual([
      "1: Error: unexpected `(` in declarator",
      "1: Error: identifier expected for template type parameter",
      '1: Error: variable name expected after type `A`, not `""`',
      '1: Error: declaration expected, not `""`',
    ]);
  });
});

// parse.d:1688-1720 — `alias Type ident` keeps the parsed type as the parameter's specType. ORACLE:
// `template T(alias int x) { enum T = x; } enum a = T!"s";` is rejected by ldc2 with `template instance
// \`T!"s"\` does not match template declaration \`T(alias int x)\``, which needs the spec type.
describe("parse.d:1690 — a typed alias template parameter keeps its spec type", () => {
  test("`template T(alias int x)` -> TemplateAliasParameter.specType is `int`", () => {
    const p = mkParser("template T(alias int x) {}");
    p.nextToken();
    const td = p.parseDeclDefs(0).opIndex(0);
    assert(td instanceof TemplateDeclaration);
    const tp = td.parameters!.opIndex(0);
    assert(tp instanceof TemplateAliasParameter);
    expect(tp.specType).toBe(Type.tint32);
    expect(dsToJs(tp.ident!.toString())).toBe("x");
  });
});

// parse.d:7774-7777 — in isDeclarator, `goto case TOK.do_` re-runs that case's test `endtok == t.value`
// against the current token, so an `End of File` ends a declarator when the caller passed
// endtok = endOfFile (typesem.d:9669, the mixin-type parse). ORACLE: `alias A = mixin("const(int)");`
// and `alias B = mixin("Byte*");` compile with ldc2 (compilable/mixintype2.d).
describe("parse.d:7775 isDeclarator — `End of File` terminates a mixin type", () => {
  for (const src of ["int*", "Byte*", "const(int)", "Byte[1]"]) {
    test(`parseTypeOrAssignExp(TOK.endOfFile) on \`${src}\` yields a Type`, () => {
      const sink = new RecordingSink();
      const p = mkParser(src, sink);
      p.nextToken();
      expect(p.parseTypeOrAssignExp(TOK.endOfFile)).toBeInstanceOf(Type);
      expect(sink.lines).toEqual([]);
    });
  }
});

// parse.d:9101-9102 — the error arm of `.` in parsePostExp `break`s out of the switch, so the loop's
// trailing nextToken() consumes the offending token. ORACLE (ldc2 -verrors=0 -c -o-, the source below;
// fail_compilation/misc_parser_err_cov1.d lines 40-41 are the same two statements):
describe("parse.d:9101 parsePostExp — a bad token after `.` is consumed", () => {
  test("`int.max.+;` then `(int).+;`", () => {
    expect(declDefsDiagnostics("void main()\n{\n    auto p = int.max.+;\n    (int).+;\n}\n")).toEqual([
      "3: Error: identifier or `new` expected following `.`, not `+`",
      "4: Error: identifier or new keyword expected following `(...)`.",
      "4: Error: expression expected, not `;`",
      "5: Error: found `}` when expecting `;` following expression",
      "4:        expression: `(__error) + (__error)`",
      "6: Error: matching `}` expected following compound statement, not `End of File`",
      "2:        unmatched `{`",
    ]);
  });
});

// parse.d:5261 — the `function`/`delegate` arm of parseFunctionLiteral reaches parseParameterList through
// `goto case TOK.leftParenthesis`, passing `&tpl`: an untyped parameter makes the callee create the template
// parameter list, and the literal is wrapped in a TemplateDeclaration whose `__T<n>` parameter binds the
// parameter's type. ORACLE: `int function(int) f = function(x) { return 2 * x; };` compiles with ldc2
// (compilable/test18199.d, runnable/funclit.d, runnable/link13843.d).
describe("parse.d:5261 parseFunctionLiteral — an untyped parameter templates the literal on every arm", () => {
  for (const src of ["function(x) { return x; }", "delegate(x) { return x; }", "function int(x) { return x; }",
      "function ref (x) { return x; }", "ref (x) { return x; }", "auto ref (x) { return x; }", "(x) => x"]) {
    test(`\`${src}\` -> FuncExp.td whose parameter is the parameter's type identifier`, () => {
      const p = mkParser(src);
      p.nextToken();
      const e = p.parseExpression();
      assert(e instanceof FuncExp);
      assert(e.td !== null);
      expect(e.td.parameters!.length).toBe(1);
      const tf = e.fd!.type;
      assert(tf instanceof TypeFunction);
      const pt = tf.parameterList.parameters!.opIndex(0)!.type;
      assert(pt instanceof TypeIdentifier);
      expect(e.td.parameters!.opIndex(0)!.ident).toBe(pt.ident);
    });
  }
});

// parse.d:5049 — `cast(AST.TemplateDeclaration) s` is a static cast: parseFunctionLiteral returns the bare
// FuncLiteralDeclaration for a literal with no untyped parameter, so the UDA of an alias is rejected; a
// templated literal (parse.d:5326) takes the UDA onto its first parameter. ORACLE (ldc2 -c -o-): the first
// line is fail_compilation/fail22127.d's error; `alias f = @(0) (x) => x;` alone compiles.
describe("parse.d:5043 parseAliasDeclarations — a UDA on a function-literal alias", () => {
  test("a literal without template parameters: the UDA is an error", () => {
    expect(declDefsDiagnostics("alias getOne = @(0) function int () => 1;\n")).toEqual([
      "1: Error: user-defined attributes are not allowed on `alias` declarations",
    ]);
  });

  test("a templated literal: the UDA lands on its first parameter, silently", () => {
    const sink = new RecordingSink();
    const p = mkParser("alias f = @(0) (x) => x;\n", sink);
    p.nextToken();
    const ad = p.parseDeclDefs(0).opIndex(0);
    expect(sink.lines).toEqual([]);
    assert(ad instanceof AliasDeclaration);
    const td = ad.aliassym;
    assert(td instanceof TemplateDeclaration);
    const fd = td.members!.opIndex(0)!;
    assert(fd instanceof FuncLiteralDeclaration);
    const tf = fd.type;
    assert(tf instanceof TypeFunction);
    expect(tf.parameterList.parameters!.opIndex(0)!.userAttribDecl).not.toBe(null);
  });
});

// parse.d:8334 — `const prev = token;` copies the Token struct before nextToken(), so the supplemental names
// the literal BEFORE each adjacent one. ORACLE (ldc2 -verrors=0 -c -o-, the source below), lines and messages:
describe("parse.d:8346 — implicit string concatenation names both literals", () => {
  test("three adjacent literals: two errors, each supplemental `<previous> ~ <next>`", () => {
    expect(declDefsDiagnostics('enum s = "a"\n    "b" `c`;\n')).toEqual([
      "2: Error: implicit string concatenation is error-prone and disallowed in D",
      '2:        Use the explicit syntax instead (concatenating literals is `@nogc`): "a" ~ "b"',
      "2: Error: implicit string concatenation is error-prone and disallowed in D",
      '2:        Use the explicit syntax instead (concatenating literals is `@nogc`): "b" ~ "c"',
    ]);
  });
});
