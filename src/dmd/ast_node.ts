// Ported from dmd/ast_node.d (module dmd.ast_node).
//
// "Defines the base class for all nodes which are part of the AST." A single abstract class
// `ASTNode : RootObject` declaring the pure-virtual `accept(Visitor)` — the root of the visitor
// double-dispatch (13-visitor.md §2). Every AST node class ultimately extends `ASTNode` and
// overrides `accept` to call its OWN named visit method on the visitor.
//
// `RootObject` is a real runtime base class -> normal value import.
// `Visitor` is referenced ONLY in the `accept` signature (a type position), and it lives in the
// visitor package which transitively imports the node classes — a load cycle. Imported with
// `import type` (01-conventions.md §4.2) so it is erased from the emitted JS and contributes
// nothing to the ESM evaluation cycle.

import { RootObject } from "./rootobject.js";
import type { Visitor } from "./visitor/index.js";

/// The base class of all AST nodes.
export abstract class ASTNode extends RootObject {
  /**
   * Visits this AST node using the given visitor.
   *
   * Pure-virtual in D (`abstract void accept(Visitor v)`, ast_node.d:25) -> TS `abstract` method
   * (02-types.md §2: a bodyless decl in an abstract class). Every concrete node MUST override it
   * with `v.visit<ConcreteNodeClass>(this)` (13-visitor.md §2) — never call the base's method.
   *
   * Params:
   *   v = the visitor to use when visiting this node
   */
  abstract accept(v: Visitor): void;
}
