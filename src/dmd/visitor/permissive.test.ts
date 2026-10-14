// Behavioral / goal test for dmd/visitor/permissive.ts.
//
// permissive.d has NO `unittest` block (10-tests-diagnostics.md). This protects the load-bearing
// achievement: PermissiveVisitor overrides the parent's 8 ROOT visit methods — which
// `assertUnreachable()` in ParseTimeVisitor — with empty no-op bodies, so traversing a subset of
// the AST never aborts. Updated to the canonical named-method visitor form (13-visitor.md §1/§8):
// the single overloaded `visit` is now one named method per root (`visitDsymbol`, …).
//
// Node classes are Bucket-7 (not yet defined); the root methods read nothing off the node, so a
// cast dummy exercises the routing faithfully.

import { describe, test, expect } from "vitest";
import { ParseTimeVisitor } from "./parsetime.js";
import { PermissiveVisitor } from "./permissive.js";
import { AssertError } from "../../assert.js";

const dummy = {} as never;

describe("PermissiveVisitor", () => {
  test("root visits are no-ops (parent would assertUnreachable)", () => {
    const v = new PermissiveVisitor();
    expect(v.visitDsymbol(dummy)).toBeUndefined();
    expect(() => v.visitDsymbol(dummy)).not.toThrow();
    expect(() => v.visitParameter(dummy)).not.toThrow();
    expect(() => v.visitStatement(dummy)).not.toThrow();
    expect(() => v.visitType(dummy)).not.toThrow();
    expect(() => v.visitExpression(dummy)).not.toThrow();
    expect(() => v.visitTemplateParameter(dummy)).not.toThrow();
    expect(() => v.visitCondition(dummy)).not.toThrow();
    expect(() => v.visitInitializer(dummy)).not.toThrow();
  });

  test("the parent ParseTimeVisitor root visit asserts (contrast)", () => {
    const parent = new ParseTimeVisitor();
    expect(() => parent.visitDsymbol(dummy)).toThrow(AssertError);
  });

  test("PermissiveVisitor is-a ParseTimeVisitor", () => {
    expect(new PermissiveVisitor()).toBeInstanceOf(ParseTimeVisitor);
  });
});
