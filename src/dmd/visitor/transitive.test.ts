// Behavioral / goal test for dmd/visitor/transitive.ts.
//
// transitive.d has NO `unittest` block (10-tests-diagnostics.md). This protects the class-shell
// achievement: `ParseTimeTransitiveVisitor` is a subclass of the visitor family
// (PermissiveVisitor -> ParseTimeVisitor) and, for the roots the mixin does NOT override, inherits
// the permissive root no-ops so a subset traversal never aborts.
//
// RE-PINNED (10 §1.8): the 121 `mixin ParseVisitMethods!ASTCodegen` traversal overrides are still
// 11 §2 STOP stubs, but for a DIFFERENT reason than when this file was first written. The
// `visitType` helper-vs-slot name collision is RESOLVED (13-visitor.md §5) and the full expansion
// now lives on `SemanticTimeTransitiveVisitor` (visitor/index.ts, pinned by index.test.ts). What
// blocks THIS class is that it cannot exist at all under 13-visitor.md §3's monomorphization to
// ASTCodegen: the mixin bodies call `child.accept(this)`, and on the ASTCodegen node set `accept`
// takes the SEMANTIC-time `Visitor` — a SUBtype of this class. Verified with an ldc2 1.43.0-beta1
// probe: D itself rejects `ParseTimeTransitiveVisitor!ASTCodegen` with
//   "cannot pass argument `this` of type `ParseTimeTransitiveVisitor!(ASTCodegen)` to parameter
//    `Visitor v`".
// D never notices in-tree because the class is a template only instantiated over the parse-only
// `dmd.astbase.ASTBase` (external dub tests; that module is not even in this tree). Full record in
// transitive.ts's header.
//
// These remain 11 §2 escalation sites, NOT §2.5 walls — do not re-pin them as deferred-callee walls
// (11-escalate.md §2.5 decision test: no amount of further porting resolves a model decision).
// The pins below sit on paths D DOES take into the mixin (10-tests-diagnostics.md §1.8 rule 5):
// D's ParseTimeTransitiveVisitor routes ExpStatement to transitive.d:35 and Parameter to
// transitive.d:1230, both real mixin overrides.

import { describe, test, expect } from "vitest";
import { ParseTimeTransitiveVisitor } from "./transitive.js";
import { PermissiveVisitor } from "./permissive.js";
import { ParseTimeVisitor } from "./parsetime.js";

const dummy = {} as never;

describe("ParseTimeTransitiveVisitor", () => {
  test("is a PermissiveVisitor / ParseTimeVisitor subclass", () => {
    const v = new ParseTimeTransitiveVisitor();
    expect(v).toBeInstanceOf(PermissiveVisitor);
    expect(v).toBeInstanceOf(ParseTimeVisitor);
  });

  test("inherits the permissive root-visit no-op for roots the mixin does not override", () => {
    const v = new ParseTimeTransitiveVisitor();
    expect(v.visitDsymbol(dummy)).toBeUndefined();
    expect(() => v.visitStatement(dummy)).not.toThrow();
  });

  test("the blocked mixin expansion HALTS instead of silently traversing nothing", () => {
    const v = new ParseTimeTransitiveVisitor();
    // transitive.d:35 — `override void visit(AST.ExpStatement s)` walks `s.exp`.
    expect(() => v.visitExpStatement(dummy)).toThrow(
      "DJS-ESCALATE: mixin expansion of visit(AST.ExpStatement) (dmd/visitor/transitive.d:35)",
    );
    // transitive.d:1230 — the one ROOT the mixin overrides with a real traversal body.
    expect(() => v.visitParameter(dummy)).toThrow(
      "DJS-ESCALATE: mixin expansion of visit(AST.Parameter) (dmd/visitor/transitive.d:1230)",
    );
  });
});
