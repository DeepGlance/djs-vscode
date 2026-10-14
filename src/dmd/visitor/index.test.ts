// Behavioral / goal test for `SemanticTimeTransitiveVisitor` (dmd/visitor/package.d:114).
//
// package.d has NO `unittest` block (10-tests-diagnostics.md §1), so this suite pins the ACHIEVEMENT
// of the resolved `mixin ParseVisitMethods!ASTCodegen` expansion (13-visitor.md §5): the visitor
// actually WALKS an AST, reaching the leaves through each node's `accept` double-dispatch
// (13-visitor.md §2), and TERMINATES. Before the §5 adjudication every mixin-generated method was an
// 11 §2 STOP stub, so any walk threw at the first node D traverses.
//
// The termination assertion is the point of that adjudication: the mixin helper `visitType` was
// renamed `visitTypeHelper` precisely because merging it with the §1 virtual slot `visitType` (the
// EMPTY terminating sink, package.d:104) turns the helper's `t.accept(this)` else-arm into unbounded
// recursion for every Type subclass the mixin does not override. A merged-name port blows the JS
// stack here; this port must not.
//
// The AST is built by hand (node constructors only) rather than parsed: `Type._init()` currently
// throws inside mtype.ts (`stripDefaultArgs` is referenced but never defined there — a defect in a
// file this task does not own), so a parser-driven fixture would pin someone else's breakage instead
// of this file's behavior.

import { describe, test, expect } from "vitest";

// Import an SCC member FIRST: the 76-module core SCC only loads cleanly when the entry is inside it,
// never when `visitor/index.js` is (01-conventions.md §4.5 — the load-order invariant recorded in
// index.ts's header).
import {
  AddExp,
  IdentifierExp,
  StructLiteralExp,
  StructLiteralExpStageFlags,
} from "../expression.js";
import type { Expression } from "../expression.js";
import { Tuple } from "../dtemplate.js";
import { CompoundStatement, ExpStatement } from "../statement.js";
// `Statement` spells the container's element type at the construction site (08 §3: a container
// declared as an alias is CONSTRUCTED as that alias).
import type { Statement } from "../statement.js";
import { TypeError as DTypeError } from "../mtype.js";
import { Identifier } from "../identifier.js";
import { TOK } from "../tokens.js";
import { ds, dsToJs } from "../../dstring.js";
import { Loc } from "../location.js";
import { Array as DArray } from "../root/array.js";
import type { Expressions, Statements } from "../arraytypes.js";

import { SemanticTimePermissiveVisitor, SemanticTimeTransitiveVisitor, Visitor } from "./index.js";
import { ParseTimeVisitor } from "./parsetime.js";

/**
 * A traversal recorder: it customizes only LEAF slots (which the transitive visitor forwards to an
 * empty root) and leaves every interior slot to the ported traversal, so the recorded sequence is
 * produced by the expansion under test, not by the test.
 */
class Recorder extends SemanticTimeTransitiveVisitor {
  seen: string[] = [];

  override visitIdentifierExp(e: IdentifierExp): void {
    this.seen.push(`Ident:${dsToJs(e.ident!.toString())}`);
  }

  override visitTypeError(t: DTypeError): void {
    this.seen.push(`Type:${t.kind()}`);
    super.visitTypeError(t);
  }
}

/**
 * A named expression LEAF, distinguishable in the recorded sequence.
 *
 * `IntegerExp` cannot serve here: its constructor asserts a non-null, roughly-scalar `Type`
 * (expression.ts, dmd/expression.d:520) and the only source of one is `Type.tint32`, which needs
 * `Type._init()` — and that currently throws inside mtype.ts (`stripDefaultArgs` is referenced but
 * never defined there — a defect in a file this task does not own; REPRODUCED: `ReferenceError:
 * stripDefaultArgs is not defined`). `IdentifierExp` needs no `Type`, so the fixture stays a real
 * node graph built through real constructors — no placeholder arguments (10 §1.9).
 */
function leaf(name: string): IdentifierExp {
  return new IdentifierExp(Loc.initial, new Identifier(ds(name), TOK.identifier));
}

/** `{ a + b; c; }` as a CompoundStatement of two ExpStatements. */
function fixture(): CompoundStatement {
  const loc = Loc.initial;
  const sum = new AddExp(loc, leaf("a"), leaf("b"));
  const stmts: Statements = new DArray<Statement | null>();
  stmts.push(new ExpStatement(loc, sum));
  stmts.push(new ExpStatement(loc, leaf("c")));
  return new CompoundStatement(loc, stmts);
}

describe("SemanticTimeTransitiveVisitor", () => {
  test("is a SemanticTimePermissiveVisitor / Visitor / ParseTimeVisitor subclass", () => {
    const v = new SemanticTimeTransitiveVisitor();
    expect(v).toBeInstanceOf(SemanticTimePermissiveVisitor);
    expect(v).toBeInstanceOf(Visitor);
    expect(v).toBeInstanceOf(ParseTimeVisitor);
  });

  test("walks a CompoundStatement down to every leaf, in source order", () => {
    const v = new Recorder();

    // CompoundStatement -> ExpStatement -> AddExp -> visitBinExp -> e1, e2; then the second
    // ExpStatement's leaf. Every hop is a mixin-generated method (transitive.d:53/:35/:1070).
    fixture().accept(v);

    expect(v.seen).toEqual(["Ident:a", "Ident:b", "Ident:c"]);
  });

  test("a null child is skipped, not dereferenced (transitive.d:38 `if (s.exp)`)", () => {
    const v = new Recorder();
    new ExpStatement(Loc.initial, null).accept(v);
    expect(v.seen).toEqual([]);
  });

  test("visitTypeHelper TERMINATES on a leaf type (the §5 collision hazard)", () => {
    const v = new Recorder();
    // The helper's else-arm is `t.accept(this)`, which lands on the EMPTY §1 slot `visitType`
    // (package.d:104) through parsetime.d's `visit(cast(AST.Type)t)` forward. If the helper and the
    // slot shared one name this would recurse until the stack blew.
    expect(() => v.visitTypeHelper(new DTypeError())).not.toThrow();
    expect(v.seen).toEqual(["Type:error"]);

    expect(() => v.visitTypeHelper(null)).not.toThrow();   // D's `if (!t) return;` guard
  });

  // RE-PINNED (10 §1.8 rule 2): these two sites used to be STOP stubs, and the escalations for them
  // are withdrawn. `visitObject` is now a full in-file translation of D's isType/isExpression/isTuple
  // dispatch (dtemplate.d:78-107 are each a DYNCAST tag test plus a downcast, both expressible here),
  // and `visitStructLiteralExp` is the verbatim package.d:148 body with the guard constant folded.
  // So the pins move from "throws" to the D behavior they replaced.
  test("visitObject(null) is a silent no-op, as in D (transitive.d:722)", () => {
    const v = new Recorder();
    // D: `isType(null)`/`isExpression(null)`/`isTuple(null)` all short-circuit on `!o`
    // (dmd/dtemplate.d:78/94/102), so the if/else-if chain falls through with no `else`.
    expect(() => v.visitObject(null)).not.toThrow();
    expect(v.seen).toEqual([]);
  });

  test("visitObject dispatches on the DYNCAST tag: type / expression / tuple (transitive.d:722)", () => {
    const v = new Recorder();

    v.visitObject(leaf("e"));                  // DYNCAST.expression -> e.accept(this)
    v.visitObject(new DTypeError());           // DYNCAST.type       -> visitType(t)

    // DYNCAST.tuple -> recurse over v.objects, in order.
    const tup = new Tuple();
    tup.objects.push(leaf("t0"));
    tup.objects.push(leaf("t1"));
    v.visitObject(tup);

    expect(v.seen).toEqual(["Ident:e", "Type:error", "Ident:t0", "Ident:t1"]);
  });

  test("visitStructLiteralExp walks the elements and restores stageflags (package.d:148)", () => {
    const v = new Recorder();
    const els: Expressions = new DArray<Expression | null>();
    els.push(leaf("f0"));
    els.push(null);                            // D `if (el)` — a null element is skipped
    els.push(leaf("f1"));

    const sle = new StructLiteralExp(Loc.initial, null, els, null);
    sle.stageflags = StructLiteralExpStageFlags.optimize;   // an unrelated bit must survive the walk

    sle.accept(v);
    expect(v.seen).toEqual(["Ident:f0", "Ident:f1"]);
    expect(sle.stageflags).toBe(StructLiteralExpStageFlags.optimize);   // `e.stageflags = old`

    // The recursion guard: re-entering while toCBuffer is set walks nothing (package.d:151).
    v.seen = [];
    sle.stageflags = StructLiteralExpStageFlags.toCBuffer;
    sle.accept(v);
    expect(v.seen).toEqual([]);
  });
});
