// Behavioral / goal test for dmd/visitor/strict.ts.
//
// strict.d has NO `unittest` block (10-tests-diagnostics.md). This protects the load-bearing
// achievement: StrictVisitor overrides EVERY node visit method with `assertUnreachable()` so a
// missed visit fails at the PRECISE node (13-visitor.md §6). Updated to the canonical named-method
// visitor form (13-visitor.md §1/§8): one named method per node, no generic `<AST>` parameter.

import { describe, test, expect } from "vitest";
import { ParseTimeVisitor } from "./parsetime.js";
import { StrictVisitor } from "./strict.js";
import { AssertError } from "../../assert.js";

const dummy = {} as never;

describe("StrictVisitor", () => {
  test("is-a ParseTimeVisitor", () => {
    expect(new StrictVisitor()).toBeInstanceOf(ParseTimeVisitor);
  });

  test("a leaf node visit asserts at the exact node", () => {
    const v = new StrictVisitor();
    expect(() => v.visitVarDeclaration(dummy)).toThrow(AssertError);
    expect(() => v.visitVarDeclaration(dummy)).toThrow("Assertion failure");
  });

  test("a root node visit asserts", () => {
    const v = new StrictVisitor();
    expect(() => v.visitDsymbol(dummy)).toThrow(AssertError);
  });
});
