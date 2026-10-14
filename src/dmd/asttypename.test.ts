// Vitest port of the in-source `unittest` of dmd/asttypename.d (10-tests-diagnostics.md §1).
//
// asttypename.d carries exactly ONE `unittest` block (asttypename.d:114-123), ported below as
// `unittest#1` (§1.2). The two extra cases are SUPPLEMENTAL behavior pins on the parts of the
// module the upstream block does not reach: the `DYNCAST.object` arm of the hand-written
// dispatcher, and a second root overload (`Statement`) of the resolved `mixin(mixin_string)`
// expansion — enough to show the 291-override visitor routes by the node's own `accept`, not by one
// lucky path. They borrow the SHAPE §1.6b prescribes (1-3 behavior pins, no new harness machinery)
// but are not mandated by it: that section governs files with ZERO upstream `unittest` blocks,
// which this file is not. Both pins exercise real, reachable behavior through the existing harness
// conventions, and nothing in the module was adapted to make them pass (§1.9).
//
// Import order note (01-conventions.md §4.5, the invariant recorded in visitor/index.ts): an SCC
// member is imported FIRST so the 76-module core SCC is entered from inside it. `asttypename.js`
// itself only value-imports SCC-external leaves (visitor/index.js, rootobject.js, dstring.js,
// assert.js) — every node class there is `import type` — so importing it never starts an SCC load.

import { describe, test, expect } from "vitest";

import { TypeidExp } from "./expression.js";
import type { Expression } from "./expression.js";
import { ExpStatement } from "./statement.js";
import { TemplateTypeParameter, Tuple } from "./dtemplate.js";
import { RootObject } from "./rootobject.js";
import { Loc } from "./location.js";
import { ds, dsEquals, dsToJs } from "../dstring.js";
import type { DString } from "../dstring.js";

import {
  astTypeName,
  astTypeNameExpression,
  astTypeNameStatement,
  astTypeNameTemplateParameter,
} from "./asttypename.js";

/**
 * D `astTypeName(x) == "Want"`. The operands are D `string`s (byte slices), so equality goes
 * through the runtime-lib helper, not `toBe` (10 §1.4). `got` is nullable because D `string` is
 * (09 §1.0: a slice's `.init` is `null`); the rendered form is passed as the Vitest message so a
 * failure reports the name actually produced instead of a bare `false`.
 */
function expectName(got: DString | null, want: string): void {
  expect(got !== null && dsEquals(got, ds(want)), got === null ? "<null slice>" : dsToJs(got)).toBe(true);
}

describe("asttypename.d", () => {
  // dmd/asttypename.d:114-123. `import dmd.location;` is function-local in D; here it is the
  // module-level `Loc` import above.
  test("unittest#1", () => {
    const e: Expression = new TypeidExp(Loc.initial, null);
    const t: Tuple = new Tuple();
    const tp: TemplateTypeParameter = new TemplateTypeParameter(Loc.initial, null, null, null);

    // `e.astTypeName` — UFCS on a static `Expression`, so D picks the generated
    // `astTypeName(Expression)` overload -> `astTypeNameExpression` (04 §1B rename).
    expectName(astTypeNameExpression(e), "TypeidExp");
    // `t.astTypeName` — `Tuple` derives from RootObject (not ASTNode), so D picks the
    // hand-written `astTypeName(RootObject)`, which answers from the DYNCAST tag alone.
    expectName(astTypeName(t), "Tuple");
    // `tp.astTypeName` — `TemplateTypeParameter` implicitly upcasts to the generated
    // `astTypeName(TemplateParameter)` overload; the visitor still reports the CONCRETE class.
    expectName(astTypeNameTemplateParameter(tp), "TemplateTypeParameter");
  });

  // Pin: the `DYNCAST.object` arm of the dispatcher (asttypename.d:46-47) — the one case that
  // returns a literal for the base class itself and never builds a visitor.
  test("astTypeName(RootObject) reports the base class from its DYNCAST tag", () => {
    expectName(astTypeName(new RootObject()), "RootObject");
  });

  // Pin: a second root overload of the resolved expansion. `ExpStatement.accept` calls
  // `v.visitExpStatement` (13-visitor.md §2), which must hit the generated override rather than
  // the inherited `visitStatement` sink — i.e. the 291-slot expansion really is per-node.
  test("astTypeName(Statement) reports the concrete statement class", () => {
    expectName(astTypeNameStatement(new ExpStatement(Loc.initial, null)), "ExpStatement");
  });
});
