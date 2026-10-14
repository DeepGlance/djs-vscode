// Ported from dmd/visitor/permissive.d (module dmd.visitor.permissive).
//
// "PermissiveVisitor overrides all the visit methods in the parent class that assert(0) in order
//  to facilitate the traversal of subsets of the AST. It does not implement any visiting logic."
//
// CANONICAL VISITOR FORM (13-visitor.md §8 — supersedes the earlier GAP-A generic holding pattern):
//   `extern(C++) class PermissiveVisitor(AST) : ParseTimeVisitor!AST`
//     -> non-generic `class PermissiveVisitor extends ParseTimeVisitor` (the `(AST)` template is
//        monomorphized to ASTCodegen, 13-visitor.md §3).
//   The 8 ROOT methods are overridden with EMPTY bodies `{}` (13-visitor.md §6), turning the
//   parent's `assertUnreachable()` roots into no-ops so a subset traversal never aborts.
//   `alias visit = ParseTimeVisitor!AST.visit;` is DROPPED (13-visitor.md §1 — no overload hiding).

import { ParseTimeVisitor } from "./parsetime.js";

import type { Dsymbol } from "../dsymbol.js";
import type { Parameter, Type } from "../mtype.js";
import type { Statement } from "../statement.js";
import type { Expression } from "../expression.js";
import type { TemplateParameter } from "../dtemplate.js";
import type { Condition } from "../cond.js";
import type { Initializer } from "../init.js";

/**
 * PermissiveVisitor overrides all the visit methods in the parent class that `assert(0)` in order
 * to facilitate the traversal of subsets of the AST. It does not implement any visiting logic.
 *
 * Ported from dmd/visitor/permissive.d, monomorphized to ASTCodegen (13-visitor.md §3). The 8 root
 * methods are overridden with empty bodies (13-visitor.md §6).
 */
export class PermissiveVisitor extends ParseTimeVisitor {
  override visitDsymbol(_s: Dsymbol): void {}
  override visitParameter(_p: Parameter): void {}
  override visitStatement(_s: Statement): void {}
  override visitType(_t: Type): void {}
  override visitExpression(_e: Expression): void {}
  override visitTemplateParameter(_tp: TemplateParameter): void {}
  override visitCondition(_c: Condition): void {}
  override visitInitializer(_i: Initializer): void {}
}
