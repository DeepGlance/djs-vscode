// Ported from dmd/arraytypes.d (module dmd.arraytypes).
//
// "Provide aliases for arrays of certain declarations or statements." Every alias here is a
// `alias Name = Array!(T);` — a TYPE ALIAS over the runtime growable container `Array!T`
// (02-types.md §5.1: RHS is a type -> `type Name = Array<T>;`). The container itself is the
// hand-written runtime port `src/dmd/root/array.ts` (08-runtime-lib.md); these are only the
// named aliases over it.
//
// CYCLE HANDLING (01-conventions.md §4): every element type (`Expression`, `Dsymbol`, …) is a
// core-SCC class. All references here are TYPE-ONLY, so they are imported with `import type`
// (Rule 4.2) and contribute ZERO to the ESM load cycle — `type` aliases erase entirely from the
// emitted JS. `Array` itself is a real runtime value class but is used here only as a type
// constructor, so it too is `import type`.
//
// ELEMENT NULLABILITY (08-runtime-lib.md §3, DECIDED): every reference-element alias here is
// `Array<T | null>`, uniformly. A D class reference is always nullable and DMD genuinely stores
// null slots (blockexit.d:124/:164 exist only to skip them; `arraySyntaxCopy` fills with nulls),
// so the element type says so. Call sites where D dereferences unconditionally use `!` at exactly
// the site where D would fault (the same discipline 02-types.md §10.1 applies to parameters);
// slot-null tests are the ordinary explicit `=== null` of 06-control-flow.md §2.7. No alias is
// special-cased as "surely never null here": uniformity is what keeps parallel agents
// deterministic.
//
// Element-type domain notes:
//   - `Strings = Array!(const(char)*)`  -> the element is a C string (NUL-terminated byte
//     buffer). Per 02-types.md §11.2 / 10-tests-diagnostics.md a `const(char)*` maps to the
//     `DString` byte view, so `Strings = Array<DString>` — a byte buffer, not a reference:
//     it stays non-nullable (08-runtime-lib.md §3).
//   - `BaseClasses = Array!(BaseClass*)` -> `BaseClass` is a D struct, but the element is a
//     POINTER to it: an intentional alias to a value (02-types.md §10 / 03§7), and a pointer
//     is nullable, so `BaseClasses = Array<BaseClass | null>` (08-runtime-lib.md §3).
//   - `Objects = Array!(RootObject)`     -> `RootObject` is the runtime root class.
//   - `ArgumentLabels`, `Ensures`, `Designators`, `DesigInits` hold D STRUCTS BY VALUE
//     (expression.d:2373, func.d:165, init.d:233/:245) — value elements, not references, so
//     no `| null`.

import type { Array } from "./root/array.js";
import type { DString } from "../dstring.js";

import type { ClassDeclaration, BaseClass } from "./dclass.js";
import type {
  VarDeclaration,
  AliasDeclaration,
} from "./declaration.js";
import type { Module } from "./dmodule.js";
import type { Dsymbol } from "./dsymbol.js";
import type {
  TemplateParameter,
  TemplateInstance,
} from "./dtemplate.js";
import type {
  Expression,
  ArgumentLabel,
} from "./expression.js";
import type {
  DtorDeclaration,
  FuncDeclaration,
  StaticDtorDeclaration,
  SharedStaticDtorDeclaration,
  Ensure,
} from "./func.js";
import type { Identifier } from "./identifier.js";
import type {
  Initializer,
  Designator,
  DesigInit,
} from "./init.js";
import type { Parameter, Type } from "./mtype.js";
import type { RootObject } from "./rootobject.js";
import type {
  Statement,
  Catch,
  CaseStatement,
  ScopeStatement,
  GotoCaseStatement,
  ReturnStatement,
  GotoStatement,
} from "./statement.js";

// const(char)* -> C-string byte view (02-types.md §11.2). Declaration order mirrors the D source.
export type Strings = Array<DString>;
export type Identifiers = Array<Identifier | null>;
export type TemplateParameters = Array<TemplateParameter | null>;
export type Expressions = Array<Expression | null>;
export type ArgumentLabels = Array<ArgumentLabel>;
export type Statements = Array<Statement | null>;
// BaseClass* -> the class reference (02-types.md §10).
export type BaseClasses = Array<BaseClass | null>;
export type ClassDeclarations = Array<ClassDeclaration | null>;
export type Dsymbols = Array<Dsymbol | null>;
export type Objects = Array<RootObject | null>;
export type DtorDeclarations = Array<DtorDeclaration | null>;
export type FuncDeclarations = Array<FuncDeclaration | null>;
export type Parameters = Array<Parameter | null>;
export type Initializers = Array<Initializer | null>;
export type VarDeclarations = Array<VarDeclaration | null>;
export type Types = Array<Type | null>;
export type Catches = Array<Catch | null>;
export type StaticDtorDeclarations = Array<StaticDtorDeclaration | null>;
export type SharedStaticDtorDeclarations = Array<SharedStaticDtorDeclaration | null>;
export type AliasDeclarations = Array<AliasDeclaration | null>;
export type Modules = Array<Module | null>;
export type CaseStatements = Array<CaseStatement | null>;
export type ScopeStatements = Array<ScopeStatement | null>;
export type GotoCaseStatements = Array<GotoCaseStatement | null>;
export type ReturnStatements = Array<ReturnStatement | null>;
export type GotoStatements = Array<GotoStatement | null>;
export type TemplateInstances = Array<TemplateInstance | null>;
export type Ensures = Array<Ensure>;
export type Designators = Array<Designator>;
export type DesigInits = Array<DesigInit>;
