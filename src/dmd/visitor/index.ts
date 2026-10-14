// Ported from dmd/visitor/package.d (module dmd.visitor).
//
// `package.d` maps to the ESM package entry point `index.ts` (01-conventions.md Rule 1.1: a D
// `package.d` declares the package module `dmd.visitor` and maps to `src/dmd/visitor/index.ts`,
// NOT `package.ts`). Sibling AST node modules import the visitor as
// `import type { Visitor } from "./visitor/index.js"` — this is that module.
//
// "Provides a visitor class visiting all AST nodes present in the compiler." Four classes:
//   - `Visitor`                     : ParseTimeVisitor + the SEMANTIC-TIME node forwards.
//   - `SemanticTimePermissiveVisitor`: empties the 8 ROOT methods (no-op traversal subset).
//   - `SemanticTimeTransitiveVisitor`: the AST-traversal visitor (mixin ParseVisitMethods).
//   - `StoppableVisitor`            : Visitor + a `stop` flag.
//
// VISITOR TRANSLATION (13-visitor.md):
//   §3 — the `(AST)` namespace-template is MONOMORPHIZED to `ASTCodegen`; `ParseTimeVisitor!
//        ASTCodegen` becomes plain `ParseTimeVisitor` and every `ASTCodegen.X` is the concrete
//        node class `X` referenced directly.
//   §1 — each `void visit(X)` overload becomes a distinctly-named `visit` + X method.
//   §4 — `visit(cast(Base)x)` forwards become `this.visit<Base>(x)`.
//   §1 — every `alias visit = …` line is DROPPED (no overload hiding in TS).
//   §5 — `mixin ParseVisitMethods!ASTCodegen` (package.d:118) is RESOLVED at translation time and
//        emitted as concrete named methods: the 121 traversal overrides + the 14 helper methods.
//
// HELPER-NAME COLLISION — ADJUDICATED (13-visitor.md §5). The mixin's `visitType` (transitive.d:334)
// and `visitTypeQualified` (transitive.d:424) helpers collide with the §1 virtual slots of the same
// names; the §1 slot fabric is inviolable, so the HELPERS take the `Helper` suffix
// (`visitTypeHelper`, `visitTypeQualifiedHelper`) and every internal call is routed to the suffixed
// name. `visitAttribDeclaration` also collides but is BENIGN (helper and slot are the same routing
// target) and keeps the bare name. Full rationale in visitor/transitive.ts's header. The escalation
// this file previously carried on that collision is RESOLVED and removed.
//
// Node param types are imported with `import type` (breaks the load cycle, 01-conventions.md
// §4.2/§4.5). `Visitor`, `SemanticTimePermissiveVisitor` and `StoppableVisitor` are COMPLETE and
// final — each verified 1:1 against package.d:26-91 / :97-109 / :256-265.

import { ParseTimeVisitor } from "./parsetime.js";
import { assert } from "../../assert.js";
import { DYNCAST } from "../rootobject.js";
import { peekSlice } from "../root/array.js";

// dropped: import dmd.astcodegen (the AST namespace) — monomorphized away (13-visitor.md §3); the
//          concrete node classes are imported directly below.
// dropped: import dmd.tokens — the mixin traversal bodies reference no TOK constant.
// `import dmd.rootobject` survives as the `DYNCAST` tag `visitTypeQualifiedHelper` dispatches on.
//
// LOAD-ORDER INVARIANT (01-conventions.md §4, VERIFIED by reproducer — it shapes the two sites
// `visitObject` and `visitStructLiteralExp` below, each translated in full): this module is a load-order ROOT of the
// 76-module core SCC. `dsymbol.ts` (AddCommentVisitor), `mangle/index.ts` (Mangler), `typesem.ts`,
// `dsymbolsem.ts`, `expressionsem.ts` and `semantic3.ts` all `class X extends Visitor` at TOP LEVEL
// from here, so any runtime (non-`import type`) edge from this file INTO the SCC makes the graph
// unloadable in every entry order: `TypeError: Class extends value undefined`. Only SCC-external
// leaves may be value-imported here — `assert.ts`, `rootobject.ts`, `root/array.ts` (each probed
// loading clean).

import type {
  DebugStatement,
  DtorExpStatement,
  ErrorStatement,
  ForwardingStatement,
  LabelDsymbol,
  PeelStatement,
  SwitchErrorStatement,
  UnrolledLoopStatement,
} from "../statement.js";
import type {
  ArrayScopeSymbol,
  Dsymbol,
  OverloadSet,
  WithScopeSymbol,
} from "../dsymbol.js";
import type { Condition } from "../cond.js";
import type { Parameter, Type } from "../mtype.js";
import type { Statement } from "../statement.js";
import type { TemplateParameter } from "../dtemplate.js";
import type {
  OverDeclaration,
  SymbolDeclaration,
  ThisDeclaration,
  TypeInfoArrayDeclaration,
  TypeInfoAssociativeArrayDeclaration,
  TypeInfoClassDeclaration,
  TypeInfoConstDeclaration,
  TypeInfoDeclaration,
  TypeInfoDelegateDeclaration,
  TypeInfoEnumDeclaration,
  TypeInfoFunctionDeclaration,
  TypeInfoInterfaceDeclaration,
  TypeInfoInvariantDeclaration,
  TypeInfoPointerDeclaration,
  TypeInfoSharedDeclaration,
  TypeInfoStaticArrayDeclaration,
  TypeInfoStructDeclaration,
  TypeInfoTupleDeclaration,
  TypeInfoVectorDeclaration,
  TypeInfoWildDeclaration,
} from "../declaration.js";
import type { ForwardingAttribDeclaration } from "../attrib.js";
import type { FuncAliasDeclaration } from "../func.js";
import type { ErrorInitializer, Initializer } from "../init.js";
import type {
  ArrayLengthExp,
  BlitExp,
  ClassReferenceExp,
  ComplexExp,
  CompoundLiteralExp,
  ConstructExp,
  DelegateExp,
  DelegateFuncptrExp,
  DelegatePtrExp,
  DotExp,
  DotTemplateExp,
  DotTypeExp,
  DotVarExp,
  ErrorExp,
  Expression,
  HaltExp,
  IndexExp,
  LoweredAssignExp,
  ObjcClassReferenceExp,
  OverExp,
  RemoveExp,
  SliceExp,
  StructLiteralExp,
  // TYPE-ONLY (erased): `StructLiteralExp.StageFlags` as a TS enum TYPE, so `stageflags` keeps its
  // declared type through the `|`/`as` round-trip in visitStructLiteralExp. The enum's VALUE is
  // NOT imported — that would be a load-time value edge into the SCC (header invariant); the one
  // member the body needs is folded to its literal at the site.
  StructLiteralExpStageFlags,
  SymOffExp,
  ThrownExceptionExp,
  VectorArrayExp,
  VectorExp,
  VoidInitExp,
} from "../expression.js";

// Node types referenced by the resolved `mixin ParseVisitMethods!ASTCodegen` expansion
// (package.d:118) below.
import type { RootObject } from "../rootobject.js";
import type { TemplateParameters } from "../arraytypes.js";
import type {
  CaseRangeStatement,
  CaseStatement,
  Catch,
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
  TypeAArray,
  TypeDArray,
  TypeDelegate,
  TypeFunction,
  TypeIdentifier,
  TypeInstance,
  TypeMixin,
  TypePointer,
  TypeQualified,
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
  Tuple,
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
 * Classic Visitor class which implements visit methods for all the AST nodes present in the
 * compiler. The visit methods for AST nodes created at parse time are INHERITED (from
 * ParseTimeVisitor); the visit methods for AST nodes created at SEMANTIC time are implemented here.
 *
 * Ported from dmd/visitor/package.d `extern(C++) class Visitor : ParseTimeVisitor!ASTCodegen`,
 * monomorphized to `ASTCodegen` (13-visitor.md §3). The `alias visit = ParseTimeVisitor!ASTCodegen
 * .visit;` is DROPPED (13-visitor.md §1 — no TS overload hiding).
 *
 * Each method here is a default-forward to the node's base (13-visitor.md §4): an un-overridden
 * semantic node is routed to its nearest parse-time base, exactly as DMD's overload resolution did.
 */
export class Visitor extends ParseTimeVisitor {
  // Semantic-time Statements (package.d:30-36) — forward to the inherited base methods.
  visitErrorStatement(s: ErrorStatement): void { this.visitStatement(s); }
  visitPeelStatement(s: PeelStatement): void { this.visitStatement(s); }
  visitUnrolledLoopStatement(s: UnrolledLoopStatement): void { this.visitStatement(s); }
  visitSwitchErrorStatement(s: SwitchErrorStatement): void { this.visitStatement(s); }
  visitDebugStatement(s: DebugStatement): void { this.visitStatement(s); }
  visitDtorExpStatement(s: DtorExpStatement): void { this.visitExpStatement(s); }
  visitForwardingStatement(s: ForwardingStatement): void { this.visitStatement(s); }

  // Semantic-time Dsymbols (package.d:37-43)
  visitOverloadSet(s: OverloadSet): void { this.visitDsymbol(s); }
  visitLabelDsymbol(s: LabelDsymbol): void { this.visitDsymbol(s); }
  visitWithScopeSymbol(s: WithScopeSymbol): void { this.visitScopeDsymbol(s); }
  visitArrayScopeSymbol(s: ArrayScopeSymbol): void { this.visitScopeDsymbol(s); }
  visitOverDeclaration(s: OverDeclaration): void { this.visitDeclaration(s); }
  visitSymbolDeclaration(s: SymbolDeclaration): void { this.visitDeclaration(s); }
  visitForwardingAttribDeclaration(s: ForwardingAttribDeclaration): void { this.visitAttribDeclaration(s); }

  // Semantic-time Declarations: TypeInfo family (package.d:44-62)
  visitThisDeclaration(s: ThisDeclaration): void { this.visitVarDeclaration(s); }
  visitTypeInfoDeclaration(s: TypeInfoDeclaration): void { this.visitVarDeclaration(s); }
  visitTypeInfoStructDeclaration(s: TypeInfoStructDeclaration): void { this.visitTypeInfoDeclaration(s); }
  visitTypeInfoClassDeclaration(s: TypeInfoClassDeclaration): void { this.visitTypeInfoDeclaration(s); }
  visitTypeInfoInterfaceDeclaration(s: TypeInfoInterfaceDeclaration): void { this.visitTypeInfoDeclaration(s); }
  visitTypeInfoPointerDeclaration(s: TypeInfoPointerDeclaration): void { this.visitTypeInfoDeclaration(s); }
  visitTypeInfoArrayDeclaration(s: TypeInfoArrayDeclaration): void { this.visitTypeInfoDeclaration(s); }
  visitTypeInfoStaticArrayDeclaration(s: TypeInfoStaticArrayDeclaration): void { this.visitTypeInfoDeclaration(s); }
  visitTypeInfoAssociativeArrayDeclaration(s: TypeInfoAssociativeArrayDeclaration): void { this.visitTypeInfoDeclaration(s); }
  visitTypeInfoEnumDeclaration(s: TypeInfoEnumDeclaration): void { this.visitTypeInfoDeclaration(s); }
  visitTypeInfoFunctionDeclaration(s: TypeInfoFunctionDeclaration): void { this.visitTypeInfoDeclaration(s); }
  visitTypeInfoDelegateDeclaration(s: TypeInfoDelegateDeclaration): void { this.visitTypeInfoDeclaration(s); }
  visitTypeInfoTupleDeclaration(s: TypeInfoTupleDeclaration): void { this.visitTypeInfoDeclaration(s); }
  visitTypeInfoConstDeclaration(s: TypeInfoConstDeclaration): void { this.visitTypeInfoDeclaration(s); }
  visitTypeInfoInvariantDeclaration(s: TypeInfoInvariantDeclaration): void { this.visitTypeInfoDeclaration(s); }
  visitTypeInfoSharedDeclaration(s: TypeInfoSharedDeclaration): void { this.visitTypeInfoDeclaration(s); }
  visitTypeInfoWildDeclaration(s: TypeInfoWildDeclaration): void { this.visitTypeInfoDeclaration(s); }
  visitTypeInfoVectorDeclaration(s: TypeInfoVectorDeclaration): void { this.visitTypeInfoDeclaration(s); }
  visitFuncAliasDeclaration(s: FuncAliasDeclaration): void { this.visitFuncDeclaration(s); }

  // Semantic-time Initializer (package.d:63)
  visitErrorInitializer(i: ErrorInitializer): void { this.visitInitializer(i); }

  // Semantic-time Expressions (package.d:64-90)
  visitErrorExp(e: ErrorExp): void { this.visitExpression(e); }
  visitComplexExp(e: ComplexExp): void { this.visitExpression(e); }
  visitStructLiteralExp(e: StructLiteralExp): void { this.visitExpression(e); }
  visitCompoundLiteralExp(e: CompoundLiteralExp): void { this.visitExpression(e); }
  visitObjcClassReferenceExp(e: ObjcClassReferenceExp): void { this.visitExpression(e); }
  visitSymOffExp(e: SymOffExp): void { this.visitSymbolExp(e); }
  visitOverExp(e: OverExp): void { this.visitExpression(e); }
  visitHaltExp(e: HaltExp): void { this.visitExpression(e); }
  visitDotTemplateExp(e: DotTemplateExp): void { this.visitUnaExp(e); }
  visitDotVarExp(e: DotVarExp): void { this.visitUnaExp(e); }
  visitDelegateExp(e: DelegateExp): void { this.visitUnaExp(e); }
  visitDotTypeExp(e: DotTypeExp): void { this.visitUnaExp(e); }
  visitVectorExp(e: VectorExp): void { this.visitUnaExp(e); }
  visitVectorArrayExp(e: VectorArrayExp): void { this.visitUnaExp(e); }
  visitSliceExp(e: SliceExp): void { this.visitUnaExp(e); }
  visitArrayLengthExp(e: ArrayLengthExp): void { this.visitUnaExp(e); }
  visitDelegatePtrExp(e: DelegatePtrExp): void { this.visitUnaExp(e); }
  visitDelegateFuncptrExp(e: DelegateFuncptrExp): void { this.visitUnaExp(e); }
  visitDotExp(e: DotExp): void { this.visitBinExp(e); }
  visitIndexExp(e: IndexExp): void { this.visitBinExp(e); }
  visitConstructExp(e: ConstructExp): void { this.visitAssignExp(e); }
  visitBlitExp(e: BlitExp): void { this.visitAssignExp(e); }
  visitRemoveExp(e: RemoveExp): void { this.visitBinExp(e); }
  visitClassReferenceExp(e: ClassReferenceExp): void { this.visitExpression(e); }
  visitVoidInitExp(e: VoidInitExp): void { this.visitExpression(e); }
  visitThrownExceptionExp(e: ThrownExceptionExp): void { this.visitExpression(e); }
  visitLoweredAssignExp(e: LoweredAssignExp): void { this.visitAssignExp(e); }
}

/**
 * The PermissiveVisitor overrides the root AST nodes with empty visiting methods.
 *
 * Ported from dmd/visitor/package.d `extern(C++) class SemanticTimePermissiveVisitor : Visitor`.
 * Overrides the 8 ROOT methods (inherited from ParseTimeVisitor via Visitor) with EMPTY bodies
 * (13-visitor.md §6) so a subset traversal never aborts on an unhandled root. The
 * `alias visit = Visitor.visit;` is DROPPED (13-visitor.md §1).
 */
export class SemanticTimePermissiveVisitor extends Visitor {
  override visitDsymbol(_s: Dsymbol): void {}
  override visitParameter(_p: Parameter): void {}
  override visitStatement(_s: Statement): void {}
  override visitType(_t: Type): void {}
  override visitExpression(_e: Expression): void {}
  override visitTemplateParameter(_tp: TemplateParameter): void {}
  override visitCondition(_c: Condition): void {}
  override visitInitializer(_i: Initializer): void {}
}

/**
 * The TransitiveVisitor implements the AST traversal logic for all AST nodes.
 *
 * Ported from dmd/visitor/package.d
 * `extern(C++) class SemanticTimeTransitiveVisitor : SemanticTimePermissiveVisitor`.
 *
 * Both `alias visit = …` lines of the D class are DROPPED (13-visitor.md §1 — no TS overload
 * hiding): dropped: alias visit = SemanticTimePermissiveVisitor.visit (package.d:116);
 * dropped: alias visit = __methods.visit (package.d:119, the mixin's un-hiding alias).
 *
 * The bulk of this class is `mixin ParseVisitMethods!ASTCodegen` (package.d:118) — RESOLVED at
 * translation time per 13-visitor.md §5 and emitted below as concrete named methods: the 121
 * traversal overrides plus the 14 helpers, followed by the explicit semantic-time overrides at
 * package.d:121-253. Per 07-compile-time.md §6 this instantiation expands independently of
 * transitive.d's; the two expansions are textually identical because the D mixin is shared.
 *
 * Traversal contract: each method walks the node's children by `child.accept(this)` (the
 * double-dispatch of 13-visitor.md §2) or by a helper; it never revisits the node itself. Roots the
 * mixin does not override keep SemanticTimePermissiveVisitor's empty bodies, so the walk terminates
 * exactly where D's does. Cost: linear in the subtree.
 */
export class SemanticTimeTransitiveVisitor extends SemanticTimePermissiveVisitor {
  // ── mixin ParseVisitMethods!ASTCodegen (package.d:118) — resolved expansion of transitive.d:29 ──

  //   Statement Nodes
  //===========================================================
  override visitExpStatement(s: ExpStatement): void {
    if (s.exp !== null) {
      const de = s.exp.isDeclarationExp();
      if (de !== null)
        de.declaration!.accept(this);
      else
        s.exp.accept(this);
    }
  }

  override visitMixinStatement(s: MixinStatement): void {
    this.visitArgs(peekSlice(s.exps));
  }

  override visitCompoundStatement(s: CompoundStatement): void {
    for (const sx of s.statements!) {
      if (sx !== null)
        sx.accept(this);
    }
  }

  /// transitive.d:63 — walk a VarDeclaration's type and initializer. A construct/blit initializer is
  /// walked through its RHS only (`ce.e2`), never as an Initializer node.
  visitVarDecl(v: VarDeclaration): void {
    if (v.type !== null)
      this.visitTypeHelper(v.type);
    if (v._init !== null) {
      const ie = v._init.isExpInitializer();
      if (ie !== null) {
        const ce = ie.exp!.isConstructExp();
        if (ce !== null) {
          ce.e2!.accept(this);
        } else {
          const be = ie.exp!.isBlitExp();
          if (be !== null)
            be.e2!.accept(this);
          else
            v._init.accept(this);
        }
      } else {
        v._init.accept(this);
      }
    }
  }

  override visitCompoundDeclarationStatement(s: CompoundDeclarationStatement): void {
    for (const sx of s.statements!) {
      if (sx === null)
        continue;
      const ds = sx.isExpStatement();
      if (ds !== null) {
        const de = ds.exp!.isDeclarationExp();
        if (de !== null) {
          const d = de.declaration!;   // D dereferences unconditionally (02 §10.1)
          assert(d.isDeclaration() !== null);
          const v = d.isVarDeclaration();
          if (v !== null)
            this.visitVarDecl(v);
          else
            d.accept(this);
        }
      }
    }
  }

  override visitScopeStatement(s: ScopeStatement): void {
    if (s.statement !== null)
      s.statement.accept(this);
  }

  override visitWhileStatement(s: WhileStatement): void {
    s.condition!.accept(this);
    if (s._body !== null)
      s._body.accept(this);
  }

  override visitDoStatement(s: DoStatement): void {
    if (s._body !== null)
      s._body.accept(this);
    s.condition!.accept(this);
  }

  override visitForStatement(s: ForStatement): void {
    if (s._init !== null)
      s._init.accept(this);
    if (s.condition !== null)
      s.condition.accept(this);
    if (s.increment !== null)
      s.increment.accept(this);
    if (s._body !== null)
      s._body.accept(this);
  }

  override visitForeachStatement(s: ForeachStatement): void {
    for (const p of s.parameters!)
      if (p!.type !== null)
        this.visitTypeHelper(p!.type);
    s.aggr!.accept(this);
    if (s._body !== null)
      s._body.accept(this);
  }

  override visitForeachRangeStatement(s: ForeachRangeStatement): void {
    if (s.param!.type !== null)
      this.visitTypeHelper(s.param!.type);
    s.lwr!.accept(this);
    s.upr!.accept(this);
    if (s._body !== null)
      s._body.accept(this);
  }

  override visitStaticForeachStatement(s: StaticForeachStatement): void {
    if (s.sfe!.aggrfe !== null)
      s.sfe!.aggrfe.accept(this);

    if (s.sfe!.rangefe !== null)
      s.sfe!.rangefe.accept(this);
  }

  override visitIfStatement(s: IfStatement): void {
    if (s.param !== null && s.param.type !== null)
      this.visitTypeHelper(s.param.type);
    s.condition!.accept(this);
    s.ifbody!.accept(this);
    if (s.elsebody !== null)
      s.elsebody.accept(this);
  }

  override visitConditionalStatement(s: ConditionalStatement): void {
    s.condition!.accept(this);
    if (s.ifbody !== null)
      s.ifbody.accept(this);
    if (s.elsebody !== null)
      s.elsebody.accept(this);
  }

  /// transitive.d:195 — walk an argument slice; a null slot falls back to `basis` (the sparse
  /// array-literal default element) and is skipped when `basis` is null too.
  visitArgs(expressions: (Expression | null)[], basis: Expression | null = null): void {
    for (let el of expressions) {
      if (el === null)
        el = basis;
      if (el !== null)
        el.accept(this);
    }
  }

  override visitPragmaStatement(s: PragmaStatement): void {
    this.visitArgs(peekSlice(s.args));
    if (s._body !== null)
      s._body.accept(this);
  }

  override visitStaticAssertStatement(s: StaticAssertStatement): void {
    s.sa!.accept(this);
  }

  override visitSwitchStatement(s: SwitchStatement): void {
    s.condition!.accept(this);
    if (s._body !== null)
      s._body.accept(this);
  }

  override visitCaseStatement(s: CaseStatement): void {
    s.exp!.accept(this);
    s.statement!.accept(this);
  }

  override visitCaseRangeStatement(s: CaseRangeStatement): void {
    s.first!.accept(this);
    s.last_!.accept(this);   // ported: D field `last` -> `last_` (statement.ts)
    s.statement!.accept(this);
  }

  override visitDefaultStatement(s: DefaultStatement): void {
    s.statement!.accept(this);
  }

  override visitGotoCaseStatement(s: GotoCaseStatement): void {
    if (s.exp !== null)
      s.exp.accept(this);
  }

  override visitReturnStatement(s: ReturnStatement): void {
    if (s.exp !== null)
      s.exp.accept(this);
  }

  override visitSynchronizedStatement(s: SynchronizedStatement): void {
    if (s.exp !== null)
      s.exp.accept(this);
    if (s._body !== null)
      s._body.accept(this);
  }

  override visitWithStatement(s: WithStatement): void {
    s.exp!.accept(this);
    if (s._body !== null)
      s._body.accept(this);
  }

  override visitTryCatchStatement(s: TryCatchStatement): void {
    if (s._body !== null)
      s._body.accept(this);
    for (const c of s.catches!)
      this.visitCatch(c!);
  }

  override visitTryFinallyStatement(s: TryFinallyStatement): void {
    s._body!.accept(this);
    s.finalbody!.accept(this);
  }

  override visitScopeGuardStatement(s: ScopeGuardStatement): void {
    s.statement!.accept(this);
  }

  override visitThrowStatement(s: ThrowStatement): void {
    s.exp!.accept(this);
  }

  override visitLabelStatement(s: LabelStatement): void {
    if (s.statement !== null)
      s.statement.accept(this);
  }

  override visitImportStatement(s: ImportStatement): void {
    for (const imp of s.imports!)
      imp!.accept(this);
  }

  /// transitive.d:322 — `void visit(AST.Catch c)`, a NON-override overload (Catch is a RootObject
  /// with no `accept`, so it is never reached through double-dispatch; TryCatchStatement calls it
  /// directly). Named per 13-visitor.md §1: "visit" + the node class name.
  visitCatch(c: Catch): void {
    if (c.type !== null)
      this.visitTypeHelper(c.type);
    if (c.handler !== null)
      c.handler.accept(this);
  }

  //   Type Nodes
  //============================================================

  /// transitive.d:334 — the type DISPATCHER helper.
  ///
  /// renamed: D helper visitType (transitive.d:334) — collides with the §1 virtual slot
  /// `visitType` (the rename of `visit(AST.Type)`, emptied at package.d:104 and the TERMINATING
  /// sink of every Type subclass the mixin does not override). 13-visitor.md §5: the slot keeps the
  /// bare name, the helper takes the `Helper` suffix. Merging the two is unbounded recursion.
  ///
  /// Accepts null (D's `if (!t) return;` guard). A TypeFunction is routed to `visitFunctionType`
  /// rather than through `accept`, so the template-declaration parameter can be threaded.
  visitTypeHelper(t: Type | null): void {
    if (t === null)
      return;
    const tf = t.isTypeFunction();
    if (tf !== null) {
      this.visitFunctionType(tf, null);
      return;
    } else
      t.accept(this);
  }

  /// transitive.d:348 — walk a function type: return type, the template declaration's ORIGINAL
  /// parameters when one is supplied (eponymous-member case), then the formal parameter list.
  visitFunctionType(t: TypeFunction, td: TemplateDeclaration | null): void {
    if (t.next !== null)
      this.visitTypeHelper(t.next);
    if (td !== null) {
      for (const p of td.origParameters!)
        p!.accept(this);
    }
    this.visitParameters(peekSlice(t.parameterList.parameters));
  }

  /// transitive.d:360 — walk a parameter slice in declaration order.
  visitParameters(parameters: (Parameter | null)[]): void {
    for (let i = 0; i < parameters.length; i++) {
      parameters[i]!.accept(this);
    }
  }

  override visitTypeVector(t: TypeVector): void {
    if (t.basetype === null)   // D `if (!t.basetype) return;` — field is non-nullable in the port
      return;
    t.basetype.accept(this);
  }

  override visitTypeSArray(t: TypeSArray): void {
    t.next!.accept(this);
  }

  override visitTypeDArray(t: TypeDArray): void {
    t.next!.accept(this);
  }

  override visitTypeAArray(t: TypeAArray): void {
    t.next!.accept(this);
    t.index!.accept(this);
  }

  override visitTypePointer(t: TypePointer): void {
    const tf = t.next!.isTypeFunction();
    if (tf !== null) {
      this.visitFunctionType(tf, null);
    } else
      t.next!.accept(this);
  }

  override visitTypeReference(t: TypeReference): void {
    t.next!.accept(this);
  }

  override visitTypeFunction(t: TypeFunction): void {
    this.visitFunctionType(t, null);
  }

  override visitTypeDelegate(t: TypeDelegate): void {
    this.visitFunctionType(t.next!.isTypeFunction()!, null);
  }

  /// transitive.d:424 — walk the `ident.ident!tiargs.ident…` qualifier components of a qualified
  /// type, dispatching each component on its `dyncast()` tag.
  ///
  /// renamed: D helper visitTypeQualified (transitive.d:424) — collides with the §1 virtual slot
  /// `visitTypeQualified` (parsetime.d:152). 13-visitor.md §5: the slot keeps the bare name, the
  /// helper takes the `Helper` suffix.
  ///
  /// Fidelity note on the three casts: D writes `(cast(AST.TemplateInstance)id).accept(this)`
  /// (transitive.d:432/435/438) — a CHECKED class cast, so a tag/class mismatch yields null and the
  /// following `.accept` faults. TS `as` is erased, so a mismatch would traverse instead of faulting.
  /// The cheatsheet's `cast(ClassDecl)sym` row routes to `instanceof`/`isXxx()`, but every candidate
  /// class here (TemplateInstance, Expression, Type) lives in the core SCC, and naming one as a VALUE
  /// breaks the load-order invariant in this file's header; an added null-test would be a silent skip
  /// where D faults (boundary-validation). The DYNCAST tags are exclusive in-tree, so `as` is the
  /// closest expressible form. Same reasoning applies to the casts in `visitObject` below.
  visitTypeQualifiedHelper(t: TypeQualified): void {
    for (const id of t.idents) {
      switch (id!.dyncast()) {   // resolved: with(DYNCAST) -> case labels re-qualified (06 §3.3)
        case DYNCAST.dsymbol:
          (id as TemplateInstance).accept(this);
          break;
        case DYNCAST.expression:
          (id as Expression).accept(this);
          break;
        case DYNCAST.type:
          (id as Type).accept(this);
          break;
        default:
          break;
      }
    }
  }

  override visitTypeIdentifier(t: TypeIdentifier): void {
    this.visitTypeQualifiedHelper(t);
  }

  override visitTypeInstance(t: TypeInstance): void {
    t.tempinst!.accept(this);
    this.visitTypeQualifiedHelper(t);
  }

  override visitTypeTypeof(t: TypeTypeof): void {
    t.exp!.accept(this);
    this.visitTypeQualifiedHelper(t);
  }

  override visitTypeReturn(t: TypeReturn): void {
    this.visitTypeQualifiedHelper(t);
  }

  override visitTypeTuple(t: TypeTuple): void {
    this.visitParameters(peekSlice(t.arguments));
  }

  override visitTypeSlice(t: TypeSlice): void {
    t.next!.accept(this);
    t.lwr!.accept(this);
    t.upr!.accept(this);
  }

  override visitTypeTraits(t: TypeTraits): void {
    t.exp!.accept(this);
  }

  override visitTypeMixin(t: TypeMixin): void {
    this.visitArgs(peekSlice(t.exps));
  }

  //      Miscellaneous
  //========================================================

  override visitStaticAssert(s: StaticAssert): void {
    s.exp!.accept(this);
    if (s.msgs !== null)
      for (const m of s.msgs.opSlice())
        m!.accept(this);
  }

  override visitEnumMember(em: EnumMember): void {
    if (em.type !== null)
      this.visitTypeHelper(em.type);
    if (em.value !== null)
      em.value.accept(this);
  }

  //      Declarations
  //=========================================================

  /// transitive.d:519 — walk an attribute declaration's affected members.
  ///
  /// collision NOTE (13-visitor.md §5): this name is BOTH the mixin helper `visitAttribDeclaration`
  /// (transitive.d:519) and the §1 slot for `visit(AST.AttribDeclaration)` (transitive.d:526, whose
  /// body is exactly `visitAttribDeclaration(d)`). The two are the same routing target, so the
  /// collision is benign and the bare name is kept; one method serves both roles.
  override visitAttribDeclaration(d: AttribDeclaration): void {
    if (d.decl !== null)
      for (const de of d.decl)
        de!.accept(this);
  }

  override visitStorageClassDeclaration(d: StorageClassDeclaration): void {
    this.visitAttribDeclaration(d);
  }

  override visitDeprecatedDeclaration(d: DeprecatedDeclaration): void {
    d.msg!.accept(this);
    this.visitAttribDeclaration(d);
  }

  override visitLinkDeclaration(d: LinkDeclaration): void {
    this.visitAttribDeclaration(d);
  }

  override visitCPPMangleDeclaration(d: CPPMangleDeclaration): void {
    this.visitAttribDeclaration(d);
  }

  override visitVisibilityDeclaration(d: VisibilityDeclaration): void {
    this.visitAttribDeclaration(d);
  }

  override visitAlignDeclaration(d: AlignDeclaration): void {
    this.visitAttribDeclaration(d);
  }

  override visitAnonDeclaration(d: AnonDeclaration): void {
    this.visitAttribDeclaration(d);
  }

  override visitPragmaDeclaration(d: PragmaDeclaration): void {
    this.visitArgs(peekSlice(d.args));
    this.visitAttribDeclaration(d);
  }

  override visitConditionalDeclaration(d: ConditionalDeclaration): void {
    d.condition!.accept(this);
    for (const de of peekSlice(d.decl))
      de!.accept(this);
    for (const de of peekSlice(d.elsedecl))
      de!.accept(this);
  }

  override visitMixinDeclaration(d: MixinDeclaration): void {
    this.visitArgs(peekSlice(d.exps));
  }

  override visitUserAttributeDeclaration(d: UserAttributeDeclaration): void {
    this.visitArgs(peekSlice(d.attsUda));
    // D writes `visitAttribDeclaration(cast(AST.AttribDeclaration)d)` (transitive.d:602).
    this.visitAttribDeclaration(d);
  }

  /// transitive.d:605 — walk a function's in/out contracts and its body.
  visitFuncBody(f: FuncDeclaration): void {
    if (f.frequires() !== null) {
      for (const frequire of f.frequires()!) {
        frequire!.accept(this);
      }
    }
    if (f.fensures() !== null) {
      for (const fensure of f.fensures()!) {
        fensure.ensure!.accept(this);
      }
    }
    if (f.fbody !== null) {
      f.fbody.accept(this);
    }
  }

  /// transitive.d:628 — walk the base-class type list of a class declaration. Accepts null (the
  /// eponymous-member path passes `ad.isClassDeclaration()`, which is null for structs).
  visitBaseClasses(d: ClassDeclaration | null): void {
    if (d === null || d.baseclasses.length === 0)
      return;
    for (const b of d.baseclasses)
      this.visitTypeHelper(b!.type);
  }

  /// transitive.d:637 — if the template declares exactly one member named like the template itself
  /// (the eponymous form), walk THAT member's shape instead of the generic template body and return
  /// true; otherwise return false and let the caller walk the members.
  visitEponymousMember(d: TemplateDeclaration): boolean {
    if (d.members === null || d.members.length !== 1)
      return false;
    const onemember = d.members.opIndex(0);
    if (onemember!.ident !== d.ident)
      return false;

    const fd = onemember!.isFuncDeclaration();
    if (fd !== null) {
      assert(fd.type !== null);
      this.visitFunctionType(fd.type.isTypeFunction()!, d);
      if (d.constraint !== null)
        d.constraint.accept(this);
      this.visitFuncBody(fd);

      return true;
    }

    const ad = onemember!.isAggregateDeclaration();
    if (ad !== null) {
      this.visitTemplateParameters(d.parameters);
      if (d.constraint !== null)
        d.constraint.accept(this);
      this.visitBaseClasses(ad.isClassDeclaration());

      if (ad.members !== null)
        for (const s of ad.members)
          s!.accept(this);

      return true;
    }

    const vd = onemember!.isVarDeclaration();
    if (vd !== null) {
      if (d.constraint !== null)
        return false;
      if (vd.type !== null)
        this.visitTypeHelper(vd.type);
      this.visitTemplateParameters(d.parameters);
      if (vd._init !== null) {
        // note similarity of this code with visitVarDecl()
        const ie = vd._init.isExpInitializer();
        if (ie !== null) {
          const ce = ie.exp!.isConstructExp();
          if (ce !== null) {
            ce.e2!.accept(this);
          } else {
            const be = ie.exp!.isBlitExp();
            if (be !== null)
              be.e2!.accept(this);
            else
              vd._init.accept(this);
          }
        } else {
          vd._init.accept(this);
        }

        return true;
      }
    }

    return false;
  }

  /// transitive.d:700 — walk a template parameter list; a null or empty list is a no-op.
  visitTemplateParameters(parameters: TemplateParameters | null): void {
    if (parameters === null || parameters.length === 0)
      return;
    for (const p of parameters)
      p!.accept(this);
  }

  override visitTemplateDeclaration(d: TemplateDeclaration): void {
    if (this.visitEponymousMember(d))
      return;

    this.visitTemplateParameters(d.parameters);
    if (d.constraint !== null)
      d.constraint.accept(this);

    for (const s of d.members!)
      s!.accept(this);
  }

  /// transitive.d:722 — walk one template argument, dispatching on its RootObject flavour
  /// (type / expression / tuple); anything else is ignored, as in D. A null argument is a no-op.
  ///
  /// D dispatches through `AST.isType` / `AST.isExpression` / `AST.isTuple`, which `dtemplate.ts`
  /// homes INSIDE the core SCC this module is the load-order root of (header invariant), so they
  /// cannot be value-imported here. They are not opaque callees: dtemplate.d:78-107 defines each as
  /// exactly `if (!o || o.dyncast() != DYNCAST.x) return null; return cast(X)o;` — a DYNCAST tag test
  /// plus a downcast. Both halves are expressible in-file: `DYNCAST` is already value-imported from
  /// `rootobject.ts` (an SCC-external leaf, see the header) and `Tuple` is needed only in type
  /// position. So the three tag tests are emitted INLINE, in the same shape
  /// `visitTypeQualifiedHelper` (transitive.d:424) already uses — no stand-in, no value edge.
  /// The tags are mutually exclusive, so D's if/else-if chain is a `switch` (order is immaterial).
  visitObject(oarg: RootObject | null): void {
    if (oarg === null)
      return;   // D: all three isXxx() short-circuit on `!o`, so the chain falls through — a no-op
    switch (oarg.dyncast()) {   // resolved: AST.isType/isExpression/isTuple (dmd/dtemplate.d:78-107)
      case DYNCAST.type:
        this.visitTypeHelper(oarg as Type);
        break;
      case DYNCAST.expression:
        (oarg as Expression).accept(this);
        break;
      case DYNCAST.tuple: {
        const v = oarg as Tuple;
        for (const arg of v.objects)   // D `auto args = &v.objects; foreach (arg; *args)` (03 §7.2)
          this.visitObject(arg);
        break;
      }
      default:
        break;   // D: no cast matched — the if/else-if chain ends with no `else`
    }
  }

  /// transitive.d:740 — walk a template instance's argument list.
  visitTiargs(ti: TemplateInstance): void {
    if (ti.tiargs === null)
      return;
    for (const arg of ti.tiargs) {
      this.visitObject(arg);
    }
  }

  override visitTemplateInstance(ti: TemplateInstance): void {
    this.visitTiargs(ti);
  }

  override visitTemplateMixin(tm: TemplateMixin): void {
    this.visitTypeHelper(tm.tqual);
    this.visitTiargs(tm);
  }

  override visitEnumDeclaration(d: EnumDeclaration): void {
    if (d.memtype !== null)
      this.visitTypeHelper(d.memtype);
    if (d.members === null)
      return;
    for (const em of d.members) {
      if (em === null)
        continue;
      em.accept(this);
    }
  }

  override visitNspace(d: Nspace): void {
    for (const s of d.members!)
      s!.accept(this);
  }

  override visitStructDeclaration(d: StructDeclaration): void {
    if (d.members === null)
      return;
    for (const s of d.members)
      s!.accept(this);
  }

  override visitUnionDeclaration(d: UnionDeclaration): void {
    if (d.members === null)
      return;
    for (const s of d.members)
      s!.accept(this);
  }

  override visitClassDeclaration(d: ClassDeclaration): void {
    this.visitBaseClasses(d);
    if (d.members !== null)
      for (const s of d.members)
        s!.accept(this);
  }

  override visitInterfaceDeclaration(d: InterfaceDeclaration): void {
    this.visitBaseClasses(d);
    if (d.members !== null)
      for (const s of d.members)
        s!.accept(this);
  }

  override visitAliasDeclaration(d: AliasDeclaration): void {
    if (d.aliassym !== null)
      d.aliassym.accept(this);
    else
      this.visitTypeHelper(d.type);
  }

  override visitAliasAssign(d: AliasAssign): void {
    if (d.aliassym !== null)
      d.aliassym.accept(this);
    else
      this.visitTypeHelper(d.type);
  }

  override visitVarDeclaration(d: VarDeclaration): void {
    this.visitVarDecl(d);
  }

  override visitFuncDeclaration(f: FuncDeclaration): void {
    const tf = f.type!.isTypeFunction();
    this.visitTypeHelper(tf);
    this.visitFuncBody(f);
  }

  override visitFuncLiteralDeclaration(f: FuncLiteralDeclaration): void {
    if (f.type!.isTypeError() !== null)
      return;
    const tf = f.type!.isTypeFunction()!;
    if (!f.inferRetType && tf.next !== null)
      this.visitTypeHelper(tf.next);
    this.visitParameters(peekSlice(tf.parameterList.parameters));
    const cs = f.fbody!.isCompoundStatement();
    const s: Statement | null = cs === null ? f.fbody : null;
    const rs = s !== null ? s.isReturnStatement() : null;
    if (rs !== null && rs.exp !== null)
      rs.exp.accept(this);
    else
      this.visitFuncBody(f);
  }

  override visitPostBlitDeclaration(d: PostBlitDeclaration): void {
    this.visitFuncBody(d);
  }

  override visitDtorDeclaration(d: DtorDeclaration): void {
    this.visitFuncBody(d);
  }

  override visitCtorDeclaration(d: CtorDeclaration): void {
    this.visitFuncBody(d);
  }

  override visitStaticCtorDeclaration(d: StaticCtorDeclaration): void {
    this.visitFuncBody(d);
  }

  override visitStaticDtorDeclaration(d: StaticDtorDeclaration): void {
    this.visitFuncBody(d);
  }

  override visitInvariantDeclaration(d: InvariantDeclaration): void {
    this.visitFuncBody(d);
  }

  override visitUnitTestDeclaration(d: UnitTestDeclaration): void {
    this.visitFuncBody(d);
  }

  override visitNewDeclaration(_d: NewDeclaration): void {
    // transitive.d:914 — empty body (the D source has only a commented-out printf).
  }

  //   Initializers
  //============================================================

  override visitStructInitializer(si: StructInitializer): void {
    // D `foreach (i, const id; si.field)` — `id` is unused in the body; only the index is needed.
    for (const [i] of si.field.opSlice().entries()) {
      const iz = si.value.opIndex(i);
      if (iz !== null)
        iz.accept(this);
    }
  }

  override visitArrayInitializer(ai: ArrayInitializer): void {
    for (const [i, ex] of ai.index.opSlice().entries()) {
      if (ex !== null)
        ex.accept(this);
      const iz = ai.value.opIndex(i);
      if (iz !== null)
        iz.accept(this);
    }
  }

  override visitExpInitializer(ei: ExpInitializer): void {
    ei.exp!.accept(this);
  }

  override visitCInitializer(ci: CInitializer): void {
    for (const di of ci.initializerList) {
      for (const des of di.designatorList!.opSlice()) {
        if (des.exp !== null)
          des.exp.accept(this);
      }
      di.initializer!.accept(this);
    }
  }

  //      Expressions
  //===================================================

  override visitArrayLiteralExp(e: ArrayLiteralExp): void {
    this.visitArgs(peekSlice(e.elements), e.basis);
  }

  override visitAssocArrayLiteralExp(e: AssocArrayLiteralExp): void {
    for (const [i, key] of e.keys!.opSlice().entries()) {
      key!.accept(this);
      (e.values!.opIndex(i))!.accept(this);
    }
  }

  override visitTypeExp(e: TypeExp): void {
    this.visitTypeHelper(e.type);
  }

  override visitScopeExp(e: ScopeExp): void {
    if (e.sds!.isTemplateInstance() !== null)
      e.sds!.accept(this);
  }

  override visitNewExp(e: NewExp): void {
    if (e.placement !== null)
      e.placement.accept(this);
    if (e.thisexp !== null)
      e.thisexp.accept(this);
    this.visitTypeHelper(e.newtype);
    this.visitArgs(peekSlice(e.arguments_));
  }

  override visitNewAnonClassExp(e: NewAnonClassExp): void {
    if (e.placement !== null)
      e.placement.accept(this);
    if (e.thisexp !== null)
      e.thisexp.accept(this);
    this.visitArgs(peekSlice(e.arguments_));
    if (e.cd !== null)
      e.cd.accept(this);
  }

  override visitTupleExp(e: TupleExp): void {
    if (e.e0 !== null)
      e.e0.accept(this);
    this.visitArgs(peekSlice(e.exps));
  }

  override visitFuncExp(e: FuncExp): void {
    e.fd!.accept(this);
  }

  override visitDeclarationExp(e: DeclarationExp): void {
    const v = e.declaration!.isVarDeclaration();
    if (v !== null)
      this.visitVarDecl(v);
    else
      e.declaration!.accept(this);
  }

  override visitTypeidExp(e: TypeidExp): void {
    this.visitObject(e.obj);
  }

  override visitTraitsExp(e: TraitsExp): void {
    if (e.args !== null)
      for (const arg of e.args)
        this.visitObject(arg);
  }

  override visitIsExp(e: IsExp): void {
    this.visitTypeHelper(e.targ);
    if (e.tspec !== null)
      this.visitTypeHelper(e.tspec);
    if (e.parameters !== null && e.parameters.length !== 0)
      this.visitTemplateParameters(e.parameters);
  }

  override visitUnaExp(e: UnaExp): void {
    e.e1!.accept(this);
  }

  override visitBinExp(e: BinExp): void {
    e.e1!.accept(this);
    e.e2!.accept(this);
  }

  override visitMixinExp(e: MixinExp): void {
    this.visitArgs(peekSlice(e.exps));
  }

  override visitImportExp(e: ImportExp): void {
    e.e1!.accept(this);
  }

  override visitAssertExp(e: AssertExp): void {
    e.e1!.accept(this);
    if (e.msg !== null)
      e.msg.accept(this);
  }

  override visitDotIdExp(e: DotIdExp): void {
    e.e1!.accept(this);
  }

  override visitDotTemplateInstanceExp(e: DotTemplateInstanceExp): void {
    e.e1!.accept(this);
    e.ti!.accept(this);
  }

  override visitCallExp(e: CallExp): void {
    e.e1!.accept(this);
    this.visitArgs(peekSlice(e.arguments_));
  }

  override visitPtrExp(e: PtrExp): void {
    e.e1!.accept(this);
  }

  override visitDeleteExp(e: DeleteExp): void {
    e.e1!.accept(this);
  }

  override visitCastExp(e: CastExp): void {
    if (e.to !== null)
      this.visitTypeHelper(e.to);
    e.e1!.accept(this);
  }

  override visitIntervalExp(e: IntervalExp): void {
    e.lwr!.accept(this);
    e.upr!.accept(this);
  }

  override visitArrayExp(e: ArrayExp): void {
    e.e1!.accept(this);
    this.visitArgs(peekSlice(e.arguments_));
  }

  override visitPostExp(e: PostExp): void {
    e.e1!.accept(this);
  }

  override visitCondExp(e: CondExp): void {
    e.econd!.accept(this);
    e.e1!.accept(this);
    e.e2!.accept(this);
  }

  override visitGenericExp(e: GenericExp): void {
    e.cntlExp!.accept(this);
    const _n = e.types!.length;   // D evaluates the range bound once at loop entry (06 §1.3)
    for (let i = 0; i < _n; i++) {
      const t = e.types!.opIndex(i);
      if (t !== null)  // null means default case
        t.accept(this);
      (e.exps!.opIndex(i))!.accept(this);
    }
  }

  override visitThrowExp(e: ThrowExp): void {
    e.e1!.accept(this);
  }

  // Template Parameter
  //===========================================================

  override visitTemplateTypeParameter(tp: TemplateTypeParameter): void {
    if (tp.specType !== null)
      this.visitTypeHelper(tp.specType);
    if (tp.defaultType !== null)
      this.visitTypeHelper(tp.defaultType);
  }

  override visitTemplateThisParameter(tp: TemplateThisParameter): void {
    this.visitTemplateTypeParameter(tp);
  }

  override visitTemplateAliasParameter(tp: TemplateAliasParameter): void {
    if (tp.specType !== null)
      this.visitTypeHelper(tp.specType);
    if (tp.specAlias !== null)
      this.visitObject(tp.specAlias);
    if (tp.defaultAlias !== null)
      this.visitObject(tp.defaultAlias);
  }

  override visitTemplateValueParameter(tp: TemplateValueParameter): void {
    this.visitTypeHelper(tp.valType);
    if (tp.specValue !== null)
      tp.specValue.accept(this);
    if (tp.defaultValue !== null)
      tp.defaultValue.accept(this);
  }

  //===========================================================

  override visitStaticIfCondition(c: StaticIfCondition): void {
    c.exp!.accept(this);
  }

  override visitParameter(p: Parameter): void {
    this.visitTypeHelper(p.type);
    if (p.defaultArg !== null)
      p.defaultArg.accept(this);
  }

  override visitModule(m: Module): void {
    for (const s of m.members!) {
      s!.accept(this);
    }
  }

  // ── the class's OWN overrides (package.d:121-253), after the mixin expansion ──────────────────

  override visitPeelStatement(s: PeelStatement): void {
    if (s.s !== null)   // D `if (s.s)` — field is non-nullable in the port (statement.ts)
      s.s.accept(this);
  }

  override visitUnrolledLoopStatement(s: UnrolledLoopStatement): void {
    for (const sx of s.statements!) {
      if (sx !== null)
        sx.accept(this);
    }
  }

  override visitDebugStatement(s: DebugStatement): void {
    if (s.statement !== null)
      s.statement.accept(this);
  }

  override visitForwardingStatement(s: ForwardingStatement): void {
    if (s.statement !== null)   // D `if (s.statement)` — field is non-nullable in the port
      s.statement.accept(this);
  }

  /// package.d:148 — CTFE can generate struct literals that contain an AddrExp pointing to
  /// themselves, so the walk is guarded by the `StageFlags.toCBuffer` recursion bit.
  ///
  /// DEPENDENCY DEFECT — the guard CONSTANT is folded; the body is verbatim. D's `alias flag =
  /// StructLiteralExp.StageFlags.toCBuffer` reads a TS `enum` MEMBER VALUE out of `expression.ts`,
  /// INSIDE the core SCC this module is the load-order root of (header invariant): a value import
  /// of the enum reorders the SCC and the graph stops loading (`Mangler extends Visitor` with
  /// `Visitor` undefined). Unlike the three `dyncast` dispatchers in `visitObject` above, an enum
  /// member value has no SCC-external source, so 11 §1's dependency-signature row applies: emit the
  /// CLOSEST EXPRESSIBLE FORM with an audited comment — here the constant folded to its literal
  /// (07 §9), with the enum imported TYPE-ONLY so `stageflags` keeps its declared type. Filed as
  /// `category: dependency signature`; it sweeps when the flag constant gets an SCC-external home.
  override visitStructLiteralExp(e: StructLiteralExp): void {
    // resolved: alias flag = StructLiteralExp.StageFlags.toCBuffer -> 0x20
    //           (dmd/expression.d:1506; ported as StructLiteralExpStageFlags.toCBuffer,
    //           src/dmd/expression.ts:1410). FOLDED, not imported — see the doc-comment above.
    const flag = 0x20;
    if ((e.stageflags & flag) === 0) {   // D `!(e.stageflags & flag)` — enum truthiness expanded (09 §9)
      const old = e.stageflags;
      // `|=` on an enum-typed slot: the OR yields `number`, read back into the enum domain
      // unchecked (02 §4.2 `int -> enum`).
      e.stageflags = (e.stageflags | flag) as StructLiteralExpStageFlags;
      // 11 §2.5 (paired state): D needs no `finally` — the port does. `el.accept(this)` re-enters the
      // visitor, where a wall throws on exit paths D does not have; without the restore the guard bit
      // would stay set on this NODE and silently suppress every later walk of it.
      try {
        for (const el of e.elements!)   // D `foreach (el; *e.elements)` — unguarded deref, as in D
          if (el !== null)
            el.accept(this);
      } finally {
        e.stageflags = old;
      }
    }
  }

  override visitClassReferenceExp(e: ClassReferenceExp): void {
    e.value!.accept(this);
  }

  override visitCompoundLiteralExp(e: CompoundLiteralExp): void {
    if (e.initializer !== null)
      e.initializer.accept(this);
  }

  override visitDotTemplateExp(e: DotTemplateExp): void {
    e.e1!.accept(this);
  }

  override visitDotVarExp(e: DotVarExp): void {
    e.e1!.accept(this);
  }

  override visitDelegateExp(e: DelegateExp): void {
    if (!e.func!.isNested() || e.func!.needThis())
      e.e1!.accept(this);
  }

  override visitDotTypeExp(e: DotTypeExp): void {
    e.e1!.accept(this);
  }

  override visitVectorExp(e: VectorExp): void {
    this.visitTypeHelper(e.to);
    e.e1!.accept(this);
  }

  override visitVectorArrayExp(e: VectorArrayExp): void {
    e.e1!.accept(this);
  }

  override visitSliceExp(e: SliceExp): void {
    e.e1!.accept(this);
    if (e.upr !== null)
      e.upr.accept(this);
    if (e.lwr !== null)
      e.lwr.accept(this);
  }

  override visitArrayLengthExp(e: ArrayLengthExp): void {
    e.e1!.accept(this);
  }

  override visitDelegatePtrExp(e: DelegatePtrExp): void {
    e.e1!.accept(this);
  }

  override visitDelegateFuncptrExp(e: DelegateFuncptrExp): void {
    e.e1!.accept(this);
  }

  override visitDotExp(e: DotExp): void {
    e.e1!.accept(this);
    e.e2!.accept(this);
  }

  override visitIndexExp(e: IndexExp): void {
    e.e1!.accept(this);
    e.e2!.accept(this);
  }

  override visitRemoveExp(e: RemoveExp): void {
    e.e1!.accept(this);
    e.e2!.accept(this);
  }

  override visitLoweredAssignExp(e: LoweredAssignExp): void {
    e.lowering!.accept(this);
    this.visitAssignExp(e);   // package.d:252 `visit(cast(ASTCodegen.AssignExp)e)` (13 §4)
  }
}

/**
 * Ported from dmd/visitor/package.d `extern(C++) class StoppableVisitor : Visitor`.
 *
 * Adds a `stop` flag (the only member). The `alias visit = Visitor.visit;` is DROPPED
 * (13-visitor.md §1). The `final extern(D) this() scope @safe {}` empty ctor is the implicit
 * no-arg constructor in TS — emitted explicitly to mirror the source and initialize `stop`.
 */
export class StoppableVisitor extends Visitor {
  stop = false;

  constructor() {
    super();
  }
}
