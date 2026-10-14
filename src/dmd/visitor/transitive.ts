// Ported from dmd/visitor/transitive.d (module dmd.visitor.transitive).
//
// "Visitor that implements the AST traversal logic. The nodes just accept their children."
// Two parts in D:
//   (1) `extern(C++) class ParseTimeTransitiveVisitor(AST) : PermissiveVisitor!AST` (transitive.d:17)
//       — a thin class whose body is `mixin ParseVisitMethods!AST __methods;` (transitive.d:21) plus
//       two `alias visit = …` lines.
//   (2) `package(dmd.visitor) mixin template ParseVisitMethods(AST)` (transitive.d:29) — 121
//       traversal `override void visit(AST.X)` bodies + 14 helper methods (visitVarDecl, visitArgs,
//       visitType, visitFunctionType, visitParameters, visitTypeQualified, visitAttribDeclaration,
//       visitFuncBody, visitBaseClasses, visitEponymousMember, visitTemplateParameters, visitObject,
//       visitTiargs, and the non-override `visit(AST.Catch)`).
//
// SETTLED (13-visitor.md §3/§1): `(AST)` is MONOMORPHIZED to ASTCodegen -> non-generic
// `class ParseTimeTransitiveVisitor extends PermissiveVisitor`; both `alias visit = …` lines are
// dropped: alias visit = PermissiveVisitor!AST.visit / __methods.visit — no overload hiding in TS.
//
// RESOLVED — the visitType helper-name collision. The escalation this file used to carry (which of
// the mixin helper `visitType` and the §1 virtual slot `visitType` keeps the bare name) is
// ADJUDICATED by 13-visitor.md §5: the §1 slot fabric is inviolable, so the colliding HELPERS take
// the `Helper` suffix (`visitTypeHelper`, `visitTypeQualifiedHelper`) while `visitAttribDeclaration`
// keeps its bare name (helper and slot are the same routing target there — benign). That rule is
// applied in full in the mixin's OTHER instantiation, `SemanticTimeTransitiveVisitor`
// (visitor/index.ts), which carries the complete 121-override + 14-helper expansion.
//
// STILL BLOCKED — a DIFFERENT, newly identified construct: this class cannot exist under the §3
// monomorphization. VERIFIED, not inferred (ldc2 1.43.0-beta1, minimal reproduction of the
// hierarchy):
//
//     Error: function `Expression.accept(Visitor v)` is not callable using argument types
//     `(ParseTimeTransitiveVisitor!(ASTCodegen))`
//     cannot pass argument `this` of type `ParseTimeTransitiveVisitor!(ASTCodegen)` to parameter
//     `Visitor v`     [in the mixin body `e.e1.accept(this)`]
//
// The mixin's traversal bodies all call `child.accept(this)`. On the ASTCodegen node set, `accept`
// takes the SEMANTIC-time `Visitor` (package.d:26 — `class Visitor : ParseTimeVisitor!ASTCodegen`,
// so `Visitor` is a SUBtype of what this class is). `ParseTimeTransitiveVisitor` is a
// `PermissiveVisitor!AST`, i.e. a plain `ParseTimeVisitor!ASTCodegen` — a SUPERtype of `Visitor` —
// so the call is contravariance-illegal. D never notices because the class is a TEMPLATE that is
// only type-checked on instantiation, and the frontend NEVER instantiates it with `ASTCodegen`: the
// only users in the 1.43.0-beta1 tree are the external dub tests
// `tests/dmd/dub_package/{impvisitor,avg}.d`, which instantiate it with `dmd.astbase.ASTBase` — a
// parse-only AST whose nodes' `accept` takes `ParseTimeVisitor!ASTBase`, and whose module
// `dmd/astbase.d` is not even present in this tree. tsc reports the identical defect on the emitted
// expansion (200+ `TS2345: Argument of type 'this' is not assignable to parameter of type Visitor`).
//
// This is precisely 13-visitor.md §3's STOP clause ("STOP only if you encounter a visitor
// instantiated with an AST that is not ASTCodegen and whose node set differs … escalate rather than
// introduce a second monomorphization") and it is a §2 ESCALATION, not a §2.5 wall: no amount of
// further porting resolves it (11-escalate.md §2.5 decision test). Adjudicating it is a model
// decision — drop the class as dead under one AST, widen `ASTNode.accept`, or introduce the second
// monomorphization §3 forbids — and it binds files this task does not own (14 §2.4).
//
// HOW THE BLOCK IS RECORDED (11-escalate.md §2, "Blocked CLASS-BODY expansion"): every one of the
// 121 `override void visit(AST.X)` methods the mixin generates is emitted below as a §2 STOP stub
// (one marker line each), so the port cannot silently compile past the unresolved construct and every blocked
// site is greppable. The stub SET is not a guess — which nodes the mixin overrides, and each one's
// TS name (`"visit" + X`, 13-visitor.md §1), are mechanical; only the BODIES are withheld. The class
// CONSTRUCTOR stays clean: inherited (verified) behavior must not be falsified by a ctor throw.
// The 14 helpers are likewise not emitted — every one of them either calls `accept(this)` itself or
// exists only to be called by a blocked body.
//
// 7 of the 8 ROOT methods (visitDsymbol/visitStatement/visitType/visitExpression/
// visitTemplateParameter/visitCondition/visitInitializer) are deliberately NOT stubbed: in D this
// class inherits PermissiveVisitor's verified EMPTY root bodies (permissive.d:19-26) for every node
// the mixin does not override, and throwing there would falsify a path D takes successfully
// (10-tests-diagnostics.md §1.8 rule 5). The 8th root, `visit(AST.Parameter)`, IS overridden by the
// mixin with a real traversal body (transitive.d:1230) and therefore IS stubbed like the rest.
//
// NOT blocked with it: `SemanticTimeTransitiveVisitor` (dmd/visitor/package.d:118) instantiates the
// same mixin from a class that IS a `Visitor`, so `accept(this)` type-checks there. Its expansion is
// complete in visitor/index.ts; this file's blocker is specific to the parse-time instantiation.

import { PermissiveVisitor } from "./permissive.js";

import type {
  CaseRangeStatement,
  CaseStatement,
  CompoundDeclarationStatement,
  CompoundStatement,
  ConditionalStatement,
  DefaultStatement,
  DoStatement,
  ExpStatement,
  ForStatement,
  ForeachRangeStatement,
  ForeachStatement,
  GotoCaseStatement,
  IfStatement,
  ImportStatement,
  LabelStatement,
  MixinStatement,
  PragmaStatement,
  ReturnStatement,
  ScopeGuardStatement,
  ScopeStatement,
  StaticAssertStatement,
  StaticForeachStatement,
  SwitchStatement,
  SynchronizedStatement,
  ThrowStatement,
  TryCatchStatement,
  TryFinallyStatement,
  WhileStatement,
  WithStatement,
} from "../statement.js";
import type {
  Parameter,
  TypeAArray,
  TypeDArray,
  TypeDelegate,
  TypeFunction,
  TypeIdentifier,
  TypeInstance,
  TypeMixin,
  TypePointer,
  TypeReference,
  TypeReturn,
  TypeSArray,
  TypeSlice,
  TypeTraits,
  TypeTuple,
  TypeTypeof,
  TypeVector,
} from "../mtype.js";
import type { StaticAssert } from "../staticassert.js";
import type { EnumDeclaration, EnumMember } from "../denum.js";
import type {
  AlignDeclaration,
  AnonDeclaration,
  AttribDeclaration,
  CPPMangleDeclaration,
  ConditionalDeclaration,
  DeprecatedDeclaration,
  LinkDeclaration,
  MixinDeclaration,
  PragmaDeclaration,
  StorageClassDeclaration,
  UserAttributeDeclaration,
  VisibilityDeclaration,
} from "../attrib.js";
import type {
  TemplateAliasParameter,
  TemplateDeclaration,
  TemplateInstance,
  TemplateMixin,
  TemplateThisParameter,
  TemplateTypeParameter,
  TemplateValueParameter,
} from "../dtemplate.js";
import type { Nspace } from "../nspace.js";
import type { StructDeclaration, UnionDeclaration } from "../dstruct.js";
import type { ClassDeclaration, InterfaceDeclaration } from "../dclass.js";
import type { AliasDeclaration, VarDeclaration } from "../declaration.js";
import type { AliasAssign } from "../dsymbol.js";
import type {
  CtorDeclaration,
  DtorDeclaration,
  FuncDeclaration,
  FuncLiteralDeclaration,
  InvariantDeclaration,
  NewDeclaration,
  PostBlitDeclaration,
  StaticCtorDeclaration,
  StaticDtorDeclaration,
  UnitTestDeclaration,
} from "../func.js";
import type { ArrayInitializer, CInitializer, ExpInitializer, StructInitializer } from "../init.js";
import type {
  ArrayExp,
  ArrayLiteralExp,
  AssertExp,
  AssocArrayLiteralExp,
  BinExp,
  CallExp,
  CastExp,
  CondExp,
  DeclarationExp,
  DeleteExp,
  DotIdExp,
  DotTemplateInstanceExp,
  FuncExp,
  GenericExp,
  ImportExp,
  IntervalExp,
  IsExp,
  MixinExp,
  NewAnonClassExp,
  NewExp,
  PostExp,
  PtrExp,
  ScopeExp,
  ThrowExp,
  TraitsExp,
  TupleExp,
  TypeExp,
  TypeidExp,
  UnaExp,
} from "../expression.js";
import type { StaticIfCondition } from "../cond.js";
import type { Module } from "../dmodule.js";

/**
 * Visitor that implements the AST traversal logic. The nodes just accept their children.
 *
 * Ported from dmd/visitor/transitive.d `extern(C++) class ParseTimeTransitiveVisitor(AST) :
 * PermissiveVisitor!AST`, monomorphized to ASTCodegen (13-visitor.md §3).
 *
 * INCOMPLETE BY ESCALATION, not by phase: the class body in D is solely the
 * `mixin ParseVisitMethods!AST` traversal expansion (transitive.d:21), and under the §3
 * monomorphization that expansion cannot be expressed at all — the mixin's `child.accept(this)`
 * requires `this` to be a semantic-time `Visitor`, which this class (a `ParseTimeVisitor`) is a
 * SUPERtype of. Verified with an ldc2 probe: D rejects `ParseTimeTransitiveVisitor!ASTCodegen` for
 * exactly this reason; the class is only instantiable over a parse-only AST (`ASTBase`), which this
 * port does not have. Full record in this file's header (escalated,
 * dmd/visitor/transitive.d:21).
 *
 * Until the model decision is ratified, every method the mixin generates is an 11 §2 STOP
 * stub: an instance of this class HALTS on any node D would traverse, instead of silently
 * traversing nothing. The working expansion of the SAME mixin lives on
 * `SemanticTimeTransitiveVisitor` (visitor/index.ts), whose `this` IS a `Visitor`.
 */
export class ParseTimeTransitiveVisitor extends PermissiveVisitor {
  override visitExpStatement(_s: ExpStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.ExpStatement)  (dmd/visitor/transitive.d:35)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.ExpStatement) (dmd/visitor/transitive.d:35)");
  }
  override visitMixinStatement(_s: MixinStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.MixinStatement)  (dmd/visitor/transitive.d:47)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.MixinStatement) (dmd/visitor/transitive.d:47)");
  }
  override visitCompoundStatement(_s: CompoundStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.CompoundStatement)  (dmd/visitor/transitive.d:53)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.CompoundStatement) (dmd/visitor/transitive.d:53)");
  }
  override visitCompoundDeclarationStatement(_s: CompoundDeclarationStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.CompoundDeclarationStatement)  (dmd/visitor/transitive.d:84)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.CompoundDeclarationStatement) (dmd/visitor/transitive.d:84)");
  }
  override visitScopeStatement(_s: ScopeStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.ScopeStatement)  (dmd/visitor/transitive.d:106)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.ScopeStatement) (dmd/visitor/transitive.d:106)");
  }
  override visitWhileStatement(_s: WhileStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.WhileStatement)  (dmd/visitor/transitive.d:113)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.WhileStatement) (dmd/visitor/transitive.d:113)");
  }
  override visitDoStatement(_s: DoStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.DoStatement)  (dmd/visitor/transitive.d:121)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.DoStatement) (dmd/visitor/transitive.d:121)");
  }
  override visitForStatement(_s: ForStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.ForStatement)  (dmd/visitor/transitive.d:129)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.ForStatement) (dmd/visitor/transitive.d:129)");
  }
  override visitForeachStatement(_s: ForeachStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.ForeachStatement)  (dmd/visitor/transitive.d:142)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.ForeachStatement) (dmd/visitor/transitive.d:142)");
  }
  override visitForeachRangeStatement(_s: ForeachRangeStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.ForeachRangeStatement)  (dmd/visitor/transitive.d:153)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.ForeachRangeStatement) (dmd/visitor/transitive.d:153)");
  }
  override visitStaticForeachStatement(_s: StaticForeachStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.StaticForeachStatement)  (dmd/visitor/transitive.d:164)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.StaticForeachStatement) (dmd/visitor/transitive.d:164)");
  }
  override visitIfStatement(_s: IfStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.IfStatement)  (dmd/visitor/transitive.d:174)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.IfStatement) (dmd/visitor/transitive.d:174)");
  }
  override visitConditionalStatement(_s: ConditionalStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.ConditionalStatement)  (dmd/visitor/transitive.d:185)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.ConditionalStatement) (dmd/visitor/transitive.d:185)");
  }
  override visitPragmaStatement(_s: PragmaStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.PragmaStatement)  (dmd/visitor/transitive.d:206)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.PragmaStatement) (dmd/visitor/transitive.d:206)");
  }
  override visitStaticAssertStatement(_s: StaticAssertStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.StaticAssertStatement)  (dmd/visitor/transitive.d:214)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.StaticAssertStatement) (dmd/visitor/transitive.d:214)");
  }
  override visitSwitchStatement(_s: SwitchStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.SwitchStatement)  (dmd/visitor/transitive.d:220)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.SwitchStatement) (dmd/visitor/transitive.d:220)");
  }
  override visitCaseStatement(_s: CaseStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.CaseStatement)  (dmd/visitor/transitive.d:228)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.CaseStatement) (dmd/visitor/transitive.d:228)");
  }
  override visitCaseRangeStatement(_s: CaseRangeStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.CaseRangeStatement)  (dmd/visitor/transitive.d:235)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.CaseRangeStatement) (dmd/visitor/transitive.d:235)");
  }
  override visitDefaultStatement(_s: DefaultStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.DefaultStatement)  (dmd/visitor/transitive.d:243)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.DefaultStatement) (dmd/visitor/transitive.d:243)");
  }
  override visitGotoCaseStatement(_s: GotoCaseStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.GotoCaseStatement)  (dmd/visitor/transitive.d:249)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.GotoCaseStatement) (dmd/visitor/transitive.d:249)");
  }
  override visitReturnStatement(_s: ReturnStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.ReturnStatement)  (dmd/visitor/transitive.d:256)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.ReturnStatement) (dmd/visitor/transitive.d:256)");
  }
  override visitSynchronizedStatement(_s: SynchronizedStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.SynchronizedStatement)  (dmd/visitor/transitive.d:263)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.SynchronizedStatement) (dmd/visitor/transitive.d:263)");
  }
  override visitWithStatement(_s: WithStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.WithStatement)  (dmd/visitor/transitive.d:272)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.WithStatement) (dmd/visitor/transitive.d:272)");
  }
  override visitTryCatchStatement(_s: TryCatchStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TryCatchStatement)  (dmd/visitor/transitive.d:280)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TryCatchStatement) (dmd/visitor/transitive.d:280)");
  }
  override visitTryFinallyStatement(_s: TryFinallyStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TryFinallyStatement)  (dmd/visitor/transitive.d:289)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TryFinallyStatement) (dmd/visitor/transitive.d:289)");
  }
  override visitScopeGuardStatement(_s: ScopeGuardStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.ScopeGuardStatement)  (dmd/visitor/transitive.d:296)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.ScopeGuardStatement) (dmd/visitor/transitive.d:296)");
  }
  override visitThrowStatement(_s: ThrowStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.ThrowStatement)  (dmd/visitor/transitive.d:302)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.ThrowStatement) (dmd/visitor/transitive.d:302)");
  }
  override visitLabelStatement(_s: LabelStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.LabelStatement)  (dmd/visitor/transitive.d:308)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.LabelStatement) (dmd/visitor/transitive.d:308)");
  }
  override visitImportStatement(_s: ImportStatement): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.ImportStatement)  (dmd/visitor/transitive.d:315)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.ImportStatement) (dmd/visitor/transitive.d:315)");
  }
  override visitTypeVector(_t: TypeVector): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TypeVector)  (dmd/visitor/transitive.d:368)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TypeVector) (dmd/visitor/transitive.d:368)");
  }
  override visitTypeSArray(_t: TypeSArray): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TypeSArray)  (dmd/visitor/transitive.d:376)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TypeSArray) (dmd/visitor/transitive.d:376)");
  }
  override visitTypeDArray(_t: TypeDArray): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TypeDArray)  (dmd/visitor/transitive.d:382)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TypeDArray) (dmd/visitor/transitive.d:382)");
  }
  override visitTypeAArray(_t: TypeAArray): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TypeAArray)  (dmd/visitor/transitive.d:388)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TypeAArray) (dmd/visitor/transitive.d:388)");
  }
  override visitTypePointer(_t: TypePointer): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TypePointer)  (dmd/visitor/transitive.d:395)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TypePointer) (dmd/visitor/transitive.d:395)");
  }
  override visitTypeReference(_t: TypeReference): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TypeReference)  (dmd/visitor/transitive.d:406)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TypeReference) (dmd/visitor/transitive.d:406)");
  }
  override visitTypeFunction(_t: TypeFunction): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TypeFunction)  (dmd/visitor/transitive.d:412)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TypeFunction) (dmd/visitor/transitive.d:412)");
  }
  override visitTypeDelegate(_t: TypeDelegate): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TypeDelegate)  (dmd/visitor/transitive.d:418)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TypeDelegate) (dmd/visitor/transitive.d:418)");
  }
  override visitTypeIdentifier(_t: TypeIdentifier): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TypeIdentifier)  (dmd/visitor/transitive.d:446)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TypeIdentifier) (dmd/visitor/transitive.d:446)");
  }
  override visitTypeInstance(_t: TypeInstance): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TypeInstance)  (dmd/visitor/transitive.d:452)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TypeInstance) (dmd/visitor/transitive.d:452)");
  }
  override visitTypeTypeof(_t: TypeTypeof): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TypeTypeof)  (dmd/visitor/transitive.d:459)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TypeTypeof) (dmd/visitor/transitive.d:459)");
  }
  override visitTypeReturn(_t: TypeReturn): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TypeReturn)  (dmd/visitor/transitive.d:466)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TypeReturn) (dmd/visitor/transitive.d:466)");
  }
  override visitTypeTuple(_t: TypeTuple): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TypeTuple)  (dmd/visitor/transitive.d:472)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TypeTuple) (dmd/visitor/transitive.d:472)");
  }
  override visitTypeSlice(_t: TypeSlice): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TypeSlice)  (dmd/visitor/transitive.d:478)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TypeSlice) (dmd/visitor/transitive.d:478)");
  }
  override visitTypeTraits(_t: TypeTraits): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TypeTraits)  (dmd/visitor/transitive.d:486)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TypeTraits) (dmd/visitor/transitive.d:486)");
  }
  override visitTypeMixin(_t: TypeMixin): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TypeMixin)  (dmd/visitor/transitive.d:491)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TypeMixin) (dmd/visitor/transitive.d:491)");
  }
  override visitStaticAssert(_s: StaticAssert): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.StaticAssert)  (dmd/visitor/transitive.d:499)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.StaticAssert) (dmd/visitor/transitive.d:499)");
  }
  override visitEnumMember(_em: EnumMember): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.EnumMember)  (dmd/visitor/transitive.d:508)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.EnumMember) (dmd/visitor/transitive.d:508)");
  }
  override visitAttribDeclaration(_d: AttribDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.AttribDeclaration)  (dmd/visitor/transitive.d:526)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.AttribDeclaration) (dmd/visitor/transitive.d:526)");
  }
  override visitStorageClassDeclaration(_d: StorageClassDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.StorageClassDeclaration)  (dmd/visitor/transitive.d:532)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.StorageClassDeclaration) (dmd/visitor/transitive.d:532)");
  }
  override visitDeprecatedDeclaration(_d: DeprecatedDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.DeprecatedDeclaration)  (dmd/visitor/transitive.d:538)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.DeprecatedDeclaration) (dmd/visitor/transitive.d:538)");
  }
  override visitLinkDeclaration(_d: LinkDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.LinkDeclaration)  (dmd/visitor/transitive.d:545)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.LinkDeclaration) (dmd/visitor/transitive.d:545)");
  }
  override visitCPPMangleDeclaration(_d: CPPMangleDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.CPPMangleDeclaration)  (dmd/visitor/transitive.d:551)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.CPPMangleDeclaration) (dmd/visitor/transitive.d:551)");
  }
  override visitVisibilityDeclaration(_d: VisibilityDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.VisibilityDeclaration)  (dmd/visitor/transitive.d:557)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.VisibilityDeclaration) (dmd/visitor/transitive.d:557)");
  }
  override visitAlignDeclaration(_d: AlignDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.AlignDeclaration)  (dmd/visitor/transitive.d:563)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.AlignDeclaration) (dmd/visitor/transitive.d:563)");
  }
  override visitAnonDeclaration(_d: AnonDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.AnonDeclaration)  (dmd/visitor/transitive.d:569)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.AnonDeclaration) (dmd/visitor/transitive.d:569)");
  }
  override visitPragmaDeclaration(_d: PragmaDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.PragmaDeclaration)  (dmd/visitor/transitive.d:575)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.PragmaDeclaration) (dmd/visitor/transitive.d:575)");
  }
  override visitConditionalDeclaration(_d: ConditionalDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.ConditionalDeclaration)  (dmd/visitor/transitive.d:582)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.ConditionalDeclaration) (dmd/visitor/transitive.d:582)");
  }
  override visitMixinDeclaration(_d: MixinDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.MixinDeclaration)  (dmd/visitor/transitive.d:592)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.MixinDeclaration) (dmd/visitor/transitive.d:592)");
  }
  override visitUserAttributeDeclaration(_d: UserAttributeDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.UserAttributeDeclaration)  (dmd/visitor/transitive.d:598)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.UserAttributeDeclaration) (dmd/visitor/transitive.d:598)");
  }
  override visitTemplateDeclaration(_d: TemplateDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TemplateDeclaration)  (dmd/visitor/transitive.d:708)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TemplateDeclaration) (dmd/visitor/transitive.d:708)");
  }
  override visitTemplateInstance(_ti: TemplateInstance): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TemplateInstance)  (dmd/visitor/transitive.d:751)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TemplateInstance) (dmd/visitor/transitive.d:751)");
  }
  override visitTemplateMixin(_tm: TemplateMixin): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TemplateMixin)  (dmd/visitor/transitive.d:757)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TemplateMixin) (dmd/visitor/transitive.d:757)");
  }
  override visitEnumDeclaration(_d: EnumDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.EnumDeclaration)  (dmd/visitor/transitive.d:764)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.EnumDeclaration) (dmd/visitor/transitive.d:764)");
  }
  override visitNspace(_d: Nspace): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.Nspace)  (dmd/visitor/transitive.d:779)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.Nspace) (dmd/visitor/transitive.d:779)");
  }
  override visitStructDeclaration(_d: StructDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.StructDeclaration)  (dmd/visitor/transitive.d:786)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.StructDeclaration) (dmd/visitor/transitive.d:786)");
  }
  override visitUnionDeclaration(_d: UnionDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.UnionDeclaration)  (dmd/visitor/transitive.d:795)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.UnionDeclaration) (dmd/visitor/transitive.d:795)");
  }
  override visitClassDeclaration(_d: ClassDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.ClassDeclaration)  (dmd/visitor/transitive.d:804)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.ClassDeclaration) (dmd/visitor/transitive.d:804)");
  }
  override visitInterfaceDeclaration(_d: InterfaceDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.InterfaceDeclaration)  (dmd/visitor/transitive.d:813)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.InterfaceDeclaration) (dmd/visitor/transitive.d:813)");
  }
  override visitAliasDeclaration(_d: AliasDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.AliasDeclaration)  (dmd/visitor/transitive.d:822)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.AliasDeclaration) (dmd/visitor/transitive.d:822)");
  }
  override visitAliasAssign(_d: AliasAssign): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.AliasAssign)  (dmd/visitor/transitive.d:831)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.AliasAssign) (dmd/visitor/transitive.d:831)");
  }
  override visitVarDeclaration(_d: VarDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.VarDeclaration)  (dmd/visitor/transitive.d:840)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.VarDeclaration) (dmd/visitor/transitive.d:840)");
  }
  override visitFuncDeclaration(_f: FuncDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.FuncDeclaration)  (dmd/visitor/transitive.d:846)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.FuncDeclaration) (dmd/visitor/transitive.d:846)");
  }
  override visitFuncLiteralDeclaration(_f: FuncLiteralDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.FuncLiteralDeclaration)  (dmd/visitor/transitive.d:854)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.FuncLiteralDeclaration) (dmd/visitor/transitive.d:854)");
  }
  override visitPostBlitDeclaration(_d: PostBlitDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.PostBlitDeclaration)  (dmd/visitor/transitive.d:872)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.PostBlitDeclaration) (dmd/visitor/transitive.d:872)");
  }
  override visitDtorDeclaration(_d: DtorDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.DtorDeclaration)  (dmd/visitor/transitive.d:878)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.DtorDeclaration) (dmd/visitor/transitive.d:878)");
  }
  override visitCtorDeclaration(_d: CtorDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.CtorDeclaration)  (dmd/visitor/transitive.d:884)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.CtorDeclaration) (dmd/visitor/transitive.d:884)");
  }
  override visitStaticCtorDeclaration(_d: StaticCtorDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.StaticCtorDeclaration)  (dmd/visitor/transitive.d:890)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.StaticCtorDeclaration) (dmd/visitor/transitive.d:890)");
  }
  override visitStaticDtorDeclaration(_d: StaticDtorDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.StaticDtorDeclaration)  (dmd/visitor/transitive.d:896)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.StaticDtorDeclaration) (dmd/visitor/transitive.d:896)");
  }
  override visitInvariantDeclaration(_d: InvariantDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.InvariantDeclaration)  (dmd/visitor/transitive.d:902)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.InvariantDeclaration) (dmd/visitor/transitive.d:902)");
  }
  override visitUnitTestDeclaration(_d: UnitTestDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.UnitTestDeclaration)  (dmd/visitor/transitive.d:908)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.UnitTestDeclaration) (dmd/visitor/transitive.d:908)");
  }
  override visitNewDeclaration(_d: NewDeclaration): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.NewDeclaration)  (dmd/visitor/transitive.d:914)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.NewDeclaration) (dmd/visitor/transitive.d:914)");
  }
  override visitStructInitializer(_si: StructInitializer): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.StructInitializer)  (dmd/visitor/transitive.d:922)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.StructInitializer) (dmd/visitor/transitive.d:922)");
  }
  override visitArrayInitializer(_ai: ArrayInitializer): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.ArrayInitializer)  (dmd/visitor/transitive.d:930)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.ArrayInitializer) (dmd/visitor/transitive.d:930)");
  }
  override visitExpInitializer(_ei: ExpInitializer): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.ExpInitializer)  (dmd/visitor/transitive.d:942)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.ExpInitializer) (dmd/visitor/transitive.d:942)");
  }
  override visitCInitializer(_ci: CInitializer): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.CInitializer)  (dmd/visitor/transitive.d:948)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.CInitializer) (dmd/visitor/transitive.d:948)");
  }
  override visitArrayLiteralExp(_e: ArrayLiteralExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.ArrayLiteralExp)  (dmd/visitor/transitive.d:965)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.ArrayLiteralExp) (dmd/visitor/transitive.d:965)");
  }
  override visitAssocArrayLiteralExp(_e: AssocArrayLiteralExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.AssocArrayLiteralExp)  (dmd/visitor/transitive.d:971)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.AssocArrayLiteralExp) (dmd/visitor/transitive.d:971)");
  }
  override visitTypeExp(_e: TypeExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TypeExp)  (dmd/visitor/transitive.d:981)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TypeExp) (dmd/visitor/transitive.d:981)");
  }
  override visitScopeExp(_e: ScopeExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.ScopeExp)  (dmd/visitor/transitive.d:987)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.ScopeExp) (dmd/visitor/transitive.d:987)");
  }
  override visitNewExp(_e: NewExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.NewExp)  (dmd/visitor/transitive.d:994)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.NewExp) (dmd/visitor/transitive.d:994)");
  }
  override visitNewAnonClassExp(_e: NewAnonClassExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.NewAnonClassExp)  (dmd/visitor/transitive.d:1005)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.NewAnonClassExp) (dmd/visitor/transitive.d:1005)");
  }
  override visitTupleExp(_e: TupleExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TupleExp)  (dmd/visitor/transitive.d:1017)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TupleExp) (dmd/visitor/transitive.d:1017)");
  }
  override visitFuncExp(_e: FuncExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.FuncExp)  (dmd/visitor/transitive.d:1025)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.FuncExp) (dmd/visitor/transitive.d:1025)");
  }
  override visitDeclarationExp(_e: DeclarationExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.DeclarationExp)  (dmd/visitor/transitive.d:1031)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.DeclarationExp) (dmd/visitor/transitive.d:1031)");
  }
  override visitTypeidExp(_e: TypeidExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TypeidExp)  (dmd/visitor/transitive.d:1040)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TypeidExp) (dmd/visitor/transitive.d:1040)");
  }
  override visitTraitsExp(_e: TraitsExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TraitsExp)  (dmd/visitor/transitive.d:1046)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TraitsExp) (dmd/visitor/transitive.d:1046)");
  }
  override visitIsExp(_e: IsExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.IsExp)  (dmd/visitor/transitive.d:1054)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.IsExp) (dmd/visitor/transitive.d:1054)");
  }
  override visitUnaExp(_e: UnaExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.UnaExp)  (dmd/visitor/transitive.d:1064)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.UnaExp) (dmd/visitor/transitive.d:1064)");
  }
  override visitBinExp(_e: BinExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.BinExp)  (dmd/visitor/transitive.d:1070)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.BinExp) (dmd/visitor/transitive.d:1070)");
  }
  override visitMixinExp(_e: MixinExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.MixinExp)  (dmd/visitor/transitive.d:1077)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.MixinExp) (dmd/visitor/transitive.d:1077)");
  }
  override visitImportExp(_e: ImportExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.ImportExp)  (dmd/visitor/transitive.d:1083)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.ImportExp) (dmd/visitor/transitive.d:1083)");
  }
  override visitAssertExp(_e: AssertExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.AssertExp)  (dmd/visitor/transitive.d:1089)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.AssertExp) (dmd/visitor/transitive.d:1089)");
  }
  override visitDotIdExp(_e: DotIdExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.DotIdExp)  (dmd/visitor/transitive.d:1097)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.DotIdExp) (dmd/visitor/transitive.d:1097)");
  }
  override visitDotTemplateInstanceExp(_e: DotTemplateInstanceExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.DotTemplateInstanceExp)  (dmd/visitor/transitive.d:1103)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.DotTemplateInstanceExp) (dmd/visitor/transitive.d:1103)");
  }
  override visitCallExp(_e: CallExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.CallExp)  (dmd/visitor/transitive.d:1110)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.CallExp) (dmd/visitor/transitive.d:1110)");
  }
  override visitPtrExp(_e: PtrExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.PtrExp)  (dmd/visitor/transitive.d:1117)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.PtrExp) (dmd/visitor/transitive.d:1117)");
  }
  override visitDeleteExp(_e: DeleteExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.DeleteExp)  (dmd/visitor/transitive.d:1123)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.DeleteExp) (dmd/visitor/transitive.d:1123)");
  }
  override visitCastExp(_e: CastExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.CastExp)  (dmd/visitor/transitive.d:1129)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.CastExp) (dmd/visitor/transitive.d:1129)");
  }
  override visitIntervalExp(_e: IntervalExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.IntervalExp)  (dmd/visitor/transitive.d:1137)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.IntervalExp) (dmd/visitor/transitive.d:1137)");
  }
  override visitArrayExp(_e: ArrayExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.ArrayExp)  (dmd/visitor/transitive.d:1144)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.ArrayExp) (dmd/visitor/transitive.d:1144)");
  }
  override visitPostExp(_e: PostExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.PostExp)  (dmd/visitor/transitive.d:1151)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.PostExp) (dmd/visitor/transitive.d:1151)");
  }
  override visitCondExp(_e: CondExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.CondExp)  (dmd/visitor/transitive.d:1157)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.CondExp) (dmd/visitor/transitive.d:1157)");
  }
  override visitGenericExp(_e: GenericExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.GenericExp)  (dmd/visitor/transitive.d:1165)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.GenericExp) (dmd/visitor/transitive.d:1165)");
  }
  override visitThrowExp(_e: ThrowExp): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.ThrowExp)  (dmd/visitor/transitive.d:1177)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.ThrowExp) (dmd/visitor/transitive.d:1177)");
  }
  override visitTemplateTypeParameter(_tp: TemplateTypeParameter): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TemplateTypeParameter)  (dmd/visitor/transitive.d:1186)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TemplateTypeParameter) (dmd/visitor/transitive.d:1186)");
  }
  override visitTemplateThisParameter(_tp: TemplateThisParameter): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TemplateThisParameter)  (dmd/visitor/transitive.d:1195)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TemplateThisParameter) (dmd/visitor/transitive.d:1195)");
  }
  override visitTemplateAliasParameter(_tp: TemplateAliasParameter): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TemplateAliasParameter)  (dmd/visitor/transitive.d:1201)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TemplateAliasParameter) (dmd/visitor/transitive.d:1201)");
  }
  override visitTemplateValueParameter(_tp: TemplateValueParameter): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.TemplateValueParameter)  (dmd/visitor/transitive.d:1212)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.TemplateValueParameter) (dmd/visitor/transitive.d:1212)");
  }
  override visitStaticIfCondition(_c: StaticIfCondition): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.StaticIfCondition)  (dmd/visitor/transitive.d:1224)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.StaticIfCondition) (dmd/visitor/transitive.d:1224)");
  }
  override visitParameter(_p: Parameter): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.Parameter)  (dmd/visitor/transitive.d:1230)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.Parameter) (dmd/visitor/transitive.d:1230)");
  }
  override visitModule(_m: Module): void {
    // DJS-ESCALATE: mixin expansion of visit(AST.Module)  (dmd/visitor/transitive.d:1238)
    throw new Error("DJS-ESCALATE: mixin expansion of visit(AST.Module) (dmd/visitor/transitive.d:1238)");
  }
}
