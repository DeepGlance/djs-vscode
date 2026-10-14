// Ported from dmd/visitor/parsetime.d (module dmd.visitor.parsetime).
//
// "Basic and dumb visitor which implements a visit method for each AST node implemented in AST.
//  This visitor is the parent of strict, transitive and permissive visitors."
//
// CANONICAL VISITOR TRANSLATION (13-visitor.md — supersedes the earlier GAP-A/GAP-B holding
// pattern that this file used to carry):
//   - The `(AST)` namespace-template parameter is MONOMORPHIZED away (§3): the frontend's live
//     visitor stack is instantiated at exactly one `AST = ASTCodegen`, so each `AST.X` becomes the
//     concrete ported node class `X` referenced directly. NO generic, NO `ParseTimeAST` interface.
//   - D's single overloaded `void visit(X)` becomes ONE distinctly-named method per node:
//     `visit` + the node class name (§1). `visit(IntegerExp)` -> `visitIntegerExp(e: IntegerExp)`.
//   - The 8 ROOT overloads `assert(0)` -> `assertUnreachable()` (§4/§6).
//   - Each forwarding overload `void visit(Derived d){ visit(cast(Base)d); }` ->
//     `visitDerived(d: Derived): void { this.visitBase(d); }` — the cast vanishes (TS upcast is
//     implicit); what matters is the BASE's named method we forward to (§4).
//   - `alias visit = …` lines are DROPPED (§1: no overload hiding in TS).
//
// PHASE NOTE (stub-first type graph): the node param types are imported with `import type` from
// their (Bucket-7) defining modules to break the load cycle (01-conventions.md §4.2/§4.5). The
// method BODIES here are real and final (forward-to-base / assertUnreachable) — they carry no
// node-field logic, so there is nothing deferred to a later phase for ParseTimeVisitor itself.

import { assertUnreachable } from "../../assert.js";

import type { AliasThis } from "../aliasthis.js";
import type { AggregateDeclaration } from "../aggregate.js";
import type {
  StructDeclaration,
  UnionDeclaration,
} from "../dstruct.js";
import type {
  AlignDeclaration,
  AnonDeclaration,
  AttribDeclaration,
  CPPMangleDeclaration,
  CPPNamespaceDeclaration,
  ConditionalDeclaration,
  DeprecatedDeclaration,
  LinkDeclaration,
  MixinDeclaration,
  PragmaDeclaration,
  StaticForeachDeclaration,
  StaticIfDeclaration,
  StorageClassDeclaration,
  UserAttributeDeclaration,
  VisibilityDeclaration,
} from "../attrib.js";
import type {
  Condition,
  DVCondition,
  DebugCondition,
  StaticIfCondition,
  VersionCondition,
} from "../cond.js";
import type {
  ClassDeclaration,
  InterfaceDeclaration,
} from "../dclass.js";
import type {
  AliasDeclaration,
  BitFieldDeclaration,
  Declaration,
  TupleDeclaration,
  VarDeclaration,
} from "../declaration.js";
import type {
  EnumDeclaration,
  EnumMember,
} from "../denum.js";
import type { Import } from "../dimport.js";
import type {
  Module,
  Package,
} from "../dmodule.js";
import type {
  AliasAssign,
  CAsmDeclaration,
  Dsymbol,
  ScopeDsymbol,
} from "../dsymbol.js";
import type {
  TemplateAliasParameter,
  TemplateDeclaration,
  TemplateInstance,
  TemplateMixin,
  TemplateParameter,
  TemplateThisParameter,
  TemplateTupleParameter,
  TemplateTypeParameter,
  TemplateValueParameter,
} from "../dtemplate.js";
import type {
  DebugSymbol,
  VersionSymbol,
} from "../dversion.js";
import type {
  AddAssignExp,
  AddExp,
  AddrExp,
  AndAssignExp,
  AndExp,
  ArrayExp,
  ArrayLiteralExp,
  AssertExp,
  AssignExp,
  AssocArrayLiteralExp,
  BinAssignExp,
  BinExp,
  CallExp,
  CastExp,
  CatAssignExp,
  CatDcharAssignExp,
  CatElemAssignExp,
  CatExp,
  CmpExp,
  ComExp,
  CommaExp,
  CondExp,
  DeclarationExp,
  DefaultInitExp,
  DeleteExp,
  DivAssignExp,
  DivExp,
  DollarExp,
  DotIdExp,
  DotTemplateInstanceExp,
  DsymbolExp,
  EqualExp,
  Expression,
  FileInitExp,
  FuncExp,
  FuncInitExp,
  GenericExp,
  IdentifierExp,
  IdentityExp,
  ImportExp,
  InExp,
  IntegerExp,
  InterpExp,
  IntervalExp,
  IsExp,
  LineInitExp,
  LogicalExp,
  MinAssignExp,
  MinExp,
  MixinExp,
  ModAssignExp,
  ModExp,
  ModuleInitExp,
  MulAssignExp,
  MulExp,
  NegExp,
  NewAnonClassExp,
  NewExp,
  NotExp,
  NullExp,
  OrAssignExp,
  OrExp,
  PostExp,
  PowAssignExp,
  PowExp,
  PreExp,
  PrettyFuncInitExp,
  PtrExp,
  RealExp,
  ScopeExp,
  ShlAssignExp,
  ShlExp,
  ShrAssignExp,
  ShrExp,
  StringExp,
  SuperExp,
  SymbolExp,
  TemplateExp,
  ThisExp,
  ThrowExp,
  TraitsExp,
  TupleExp,
  TypeExp,
  TypeidExp,
  UAddExp,
  UnaExp,
  UshrAssignExp,
  UshrExp,
  VarExp,
  XorAssignExp,
  XorExp,
} from "../expression.js";
import type {
  CtorDeclaration,
  DtorDeclaration,
  FuncDeclaration,
  FuncLiteralDeclaration,
  InvariantDeclaration,
  NewDeclaration,
  PostBlitDeclaration,
  SharedStaticCtorDeclaration,
  SharedStaticDtorDeclaration,
  StaticCtorDeclaration,
  StaticDtorDeclaration,
  UnitTestDeclaration,
} from "../func.js";
import type {
  ArrayInitializer,
  CInitializer,
  DefaultInitializer,
  ExpInitializer,
  Initializer,
  StructInitializer,
  VoidInitializer,
} from "../init.js";
import type {
  Parameter,
  Type,
  TypeAArray,
  TypeArray,
  TypeBasic,
  TypeClass,
  TypeDArray,
  TypeDelegate,
  TypeEnum,
  TypeError,
  TypeFunction,
  TypeIdentifier,
  TypeInstance,
  TypeMixin,
  TypeNext,
  TypeNoreturn,
  TypeNull,
  TypePointer,
  TypeQualified,
  TypeReference,
  TypeReturn,
  TypeSArray,
  TypeSlice,
  TypeStruct,
  TypeTag,
  TypeTraits,
  TypeTuple,
  TypeTypeof,
  TypeVector,
} from "../mtype.js";
import type { Nspace } from "../nspace.js";
import type { StaticAssert } from "../staticassert.js";
import type {
  AsmStatement,
  BreakStatement,
  CaseRangeStatement,
  CaseStatement,
  CompoundAsmStatement,
  CompoundDeclarationStatement,
  CompoundStatement,
  ConditionalStatement,
  ContinueStatement,
  DefaultStatement,
  DoStatement,
  ExpStatement,
  ForStatement,
  ForeachRangeStatement,
  ForeachStatement,
  GccAsmStatement,
  GotoCaseStatement,
  GotoDefaultStatement,
  GotoStatement,
  IfStatement,
  ImportStatement,
  InlineAsmStatement,
  LabelStatement,
  MixinStatement,
  PragmaStatement,
  ReturnStatement,
  ScopeGuardStatement,
  ScopeStatement,
  Statement,
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

/**
 * Basic and dumb visitor which implements a visit method for each AST node implemented in AST.
 * This visitor is the parent of strict, transitive and permissive visitors.
 *
 * Ported from dmd/visitor/parsetime.d `extern(C++) class ParseTimeVisitor(AST)`, monomorphized to
 * `AST = ASTCodegen` (13-visitor.md §3) so the class is non-generic and references the concrete
 * node classes directly.
 *
 * The 8 ROOT visit methods `assertUnreachable()` (an un-dispatched root means a node type with no
 * `accept` override reached the visitor — a bug). Every other method forwards to its base's named
 * method, preserving D's fall-through routing exactly.
 *
 * SCOPE: this base declares ONLY the parse-time node set (parsetime.d). The semantic-time nodes
 * (ErrorStatement, ComplexExp, TypeInfo*, …) are added by the full `Visitor` in visitor/index.ts
 * (DMD: visitor/package.d:30-90) — faithful to DMD's split.
 */
export class ParseTimeVisitor {
  // ── 8 ROOT overloads — `void visit(AST.Root) { assert(0); }` (parsetime.d:19-26) ──
  visitDsymbol(_s: Dsymbol): void { assertUnreachable(); }
  visitParameter(_p: Parameter): void { assertUnreachable(); }
  visitStatement(_s: Statement): void { assertUnreachable(); }
  visitType(_t: Type): void { assertUnreachable(); }
  visitExpression(_e: Expression): void { assertUnreachable(); }
  visitTemplateParameter(_tp: TemplateParameter): void { assertUnreachable(); }
  visitCondition(_c: Condition): void { assertUnreachable(); }
  visitInitializer(_i: Initializer): void { assertUnreachable(); }

  // ── Dsymbols (parsetime.d:30-39) — forward to visitDsymbol ──
  visitAliasThis(s: AliasThis): void { this.visitDsymbol(s); }
  visitDeclaration(s: Declaration): void { this.visitDsymbol(s); }
  visitScopeDsymbol(s: ScopeDsymbol): void { this.visitDsymbol(s); }
  visitImport(s: Import): void { this.visitDsymbol(s); }
  visitAttribDeclaration(s: AttribDeclaration): void { this.visitDsymbol(s); }
  visitStaticAssert(s: StaticAssert): void { this.visitDsymbol(s); }
  visitDebugSymbol(s: DebugSymbol): void { this.visitDsymbol(s); }
  visitVersionSymbol(s: VersionSymbol): void { this.visitDsymbol(s); }
  visitAliasAssign(s: AliasAssign): void { this.visitDsymbol(s); }
  visitCAsmDeclaration(s: CAsmDeclaration): void { this.visitDsymbol(s); }

  // ScopeDsymbols (parsetime.d:42-47) — forward to visitScopeDsymbol
  visitPackage(s: Package): void { this.visitScopeDsymbol(s); }
  visitEnumDeclaration(s: EnumDeclaration): void { this.visitScopeDsymbol(s); }
  // D writes `visit(cast(AST.ScopeDsymbol)s)` (parsetime.d:44,:46): a plain upcast, no TS cast needed.
  visitAggregateDeclaration(s: AggregateDeclaration): void { this.visitScopeDsymbol(s); }
  visitTemplateDeclaration(s: TemplateDeclaration): void { this.visitScopeDsymbol(s); }
  visitTemplateInstance(s: TemplateInstance): void { this.visitScopeDsymbol(s); }
  visitNspace(s: Nspace): void { this.visitScopeDsymbol(s); }

  // ── Declarations (parsetime.d:51-54) — forward to visitDeclaration ──
  visitVarDeclaration(s: VarDeclaration): void { this.visitDeclaration(s); }
  visitFuncDeclaration(s: FuncDeclaration): void { this.visitDeclaration(s); }
  visitAliasDeclaration(s: AliasDeclaration): void { this.visitDeclaration(s); }
  visitTupleDeclaration(s: TupleDeclaration): void { this.visitDeclaration(s); }

  // FuncDeclarations (parsetime.d:57-67)
  visitFuncLiteralDeclaration(s: FuncLiteralDeclaration): void { this.visitFuncDeclaration(s); }
  visitPostBlitDeclaration(s: PostBlitDeclaration): void { this.visitFuncDeclaration(s); }
  visitCtorDeclaration(s: CtorDeclaration): void { this.visitFuncDeclaration(s); }
  visitDtorDeclaration(s: DtorDeclaration): void { this.visitFuncDeclaration(s); }
  visitInvariantDeclaration(s: InvariantDeclaration): void { this.visitFuncDeclaration(s); }
  visitUnitTestDeclaration(s: UnitTestDeclaration): void { this.visitFuncDeclaration(s); }
  visitNewDeclaration(s: NewDeclaration): void { this.visitFuncDeclaration(s); }
  visitStaticCtorDeclaration(s: StaticCtorDeclaration): void { this.visitFuncDeclaration(s); }
  visitStaticDtorDeclaration(s: StaticDtorDeclaration): void { this.visitFuncDeclaration(s); }
  visitSharedStaticCtorDeclaration(s: SharedStaticCtorDeclaration): void { this.visitStaticCtorDeclaration(s); }
  visitSharedStaticDtorDeclaration(s: SharedStaticDtorDeclaration): void { this.visitStaticDtorDeclaration(s); }

  // AttribDeclarations (parsetime.d:70-81) — forward to visitAttribDeclaration
  visitMixinDeclaration(s: MixinDeclaration): void { this.visitAttribDeclaration(s); }
  // D writes `visit(cast(AST.AttribDeclaration)s)` (parsetime.d:71).
  visitUserAttributeDeclaration(s: UserAttributeDeclaration): void { this.visitAttribDeclaration(s); }
  visitLinkDeclaration(s: LinkDeclaration): void { this.visitAttribDeclaration(s); }
  visitAnonDeclaration(s: AnonDeclaration): void { this.visitAttribDeclaration(s); }
  visitAlignDeclaration(s: AlignDeclaration): void { this.visitAttribDeclaration(s); }
  visitCPPMangleDeclaration(s: CPPMangleDeclaration): void { this.visitAttribDeclaration(s); }
  visitCPPNamespaceDeclaration(s: CPPNamespaceDeclaration): void { this.visitAttribDeclaration(s); }
  visitVisibilityDeclaration(s: VisibilityDeclaration): void { this.visitAttribDeclaration(s); }
  visitPragmaDeclaration(s: PragmaDeclaration): void { this.visitAttribDeclaration(s); }
  visitStorageClassDeclaration(s: StorageClassDeclaration): void { this.visitAttribDeclaration(s); }
  visitConditionalDeclaration(s: ConditionalDeclaration): void { this.visitAttribDeclaration(s); }
  visitStaticForeachDeclaration(s: StaticForeachDeclaration): void { this.visitAttribDeclaration(s); }

  // Miscellaneous declarations (parsetime.d:85-94)
  visitDeprecatedDeclaration(s: DeprecatedDeclaration): void { this.visitStorageClassDeclaration(s); }
  visitStaticIfDeclaration(s: StaticIfDeclaration): void { this.visitConditionalDeclaration(s); }
  visitEnumMember(s: EnumMember): void { this.visitVarDeclaration(s); }
  // D writes explicit upcasts here (parsetime.d:88,:89,:91). Module.errors (uint) shadows Dsymbol.errors
  // (bool) (dmodule.ts), so the Module upcast keeps the 02 §11.5 cascade; the aggregate ones need no cast.
  visitModule(s: Module): void { this.visitPackage(s as unknown as Package); }
  visitStructDeclaration(s: StructDeclaration): void { this.visitAggregateDeclaration(s); }
  visitUnionDeclaration(s: UnionDeclaration): void { this.visitStructDeclaration(s); }
  visitClassDeclaration(s: ClassDeclaration): void { this.visitAggregateDeclaration(s); }
  visitInterfaceDeclaration(s: InterfaceDeclaration): void { this.visitClassDeclaration(s); }
  visitTemplateMixin(s: TemplateMixin): void { this.visitTemplateInstance(s); }
  visitBitFieldDeclaration(s: BitFieldDeclaration): void { this.visitVarDeclaration(s); }

  // ── Statements (parsetime.d:98-130) — forward to visitStatement ──
  visitImportStatement(s: ImportStatement): void { this.visitStatement(s); }
  visitScopeStatement(s: ScopeStatement): void { this.visitStatement(s); }
  visitReturnStatement(s: ReturnStatement): void { this.visitStatement(s); }
  visitLabelStatement(s: LabelStatement): void { this.visitStatement(s); }
  visitStaticAssertStatement(s: StaticAssertStatement): void { this.visitStatement(s); }
  visitMixinStatement(s: MixinStatement): void { this.visitStatement(s); }
  visitWhileStatement(s: WhileStatement): void { this.visitStatement(s); }
  visitForStatement(s: ForStatement): void { this.visitStatement(s); }
  visitDoStatement(s: DoStatement): void { this.visitStatement(s); }
  visitForeachRangeStatement(s: ForeachRangeStatement): void { this.visitStatement(s); }
  visitForeachStatement(s: ForeachStatement): void { this.visitStatement(s); }
  visitIfStatement(s: IfStatement): void { this.visitStatement(s); }
  visitScopeGuardStatement(s: ScopeGuardStatement): void { this.visitStatement(s); }
  visitConditionalStatement(s: ConditionalStatement): void { this.visitStatement(s); }
  visitStaticForeachStatement(s: StaticForeachStatement): void { this.visitStatement(s); }
  visitPragmaStatement(s: PragmaStatement): void { this.visitStatement(s); }
  visitSwitchStatement(s: SwitchStatement): void { this.visitStatement(s); }
  visitCaseRangeStatement(s: CaseRangeStatement): void { this.visitStatement(s); }
  visitCaseStatement(s: CaseStatement): void { this.visitStatement(s); }
  visitDefaultStatement(s: DefaultStatement): void { this.visitStatement(s); }
  visitBreakStatement(s: BreakStatement): void { this.visitStatement(s); }
  visitContinueStatement(s: ContinueStatement): void { this.visitStatement(s); }
  visitGotoDefaultStatement(s: GotoDefaultStatement): void { this.visitStatement(s); }
  visitGotoCaseStatement(s: GotoCaseStatement): void { this.visitStatement(s); }
  visitGotoStatement(s: GotoStatement): void { this.visitStatement(s); }
  visitSynchronizedStatement(s: SynchronizedStatement): void { this.visitStatement(s); }
  visitWithStatement(s: WithStatement): void { this.visitStatement(s); }
  visitTryCatchStatement(s: TryCatchStatement): void { this.visitStatement(s); }
  visitTryFinallyStatement(s: TryFinallyStatement): void { this.visitStatement(s); }
  visitThrowStatement(s: ThrowStatement): void { this.visitStatement(s); }
  visitAsmStatement(s: AsmStatement): void { this.visitStatement(s); }
  visitExpStatement(s: ExpStatement): void { this.visitStatement(s); }
  visitCompoundStatement(s: CompoundStatement): void { this.visitStatement(s); }

  // CompoundStatements (parsetime.d:133-134)
  visitCompoundDeclarationStatement(s: CompoundDeclarationStatement): void { this.visitCompoundStatement(s); }
  visitCompoundAsmStatement(s: CompoundAsmStatement): void { this.visitCompoundStatement(s); }

  // AsmStatements (parsetime.d:137-138)
  visitInlineAsmStatement(s: InlineAsmStatement): void { this.visitAsmStatement(s); }
  visitGccAsmStatement(s: GccAsmStatement): void { this.visitAsmStatement(s); }

  // ── Types (parsetime.d:142-155) — forward to visitType ──
  visitTypeBasic(t: TypeBasic): void { this.visitType(t); }
  visitTypeError(t: TypeError): void { this.visitType(t); }
  visitTypeNull(t: TypeNull): void { this.visitType(t); }
  visitTypeNoreturn(t: TypeNoreturn): void { this.visitType(t); }
  visitTypeVector(t: TypeVector): void { this.visitType(t); }
  visitTypeEnum(t: TypeEnum): void { this.visitType(t); }
  visitTypeTuple(t: TypeTuple): void { this.visitType(t); }
  visitTypeClass(t: TypeClass): void { this.visitType(t); }
  visitTypeStruct(t: TypeStruct): void { this.visitType(t); }
  visitTypeNext(t: TypeNext): void { this.visitType(t); }
  visitTypeQualified(t: TypeQualified): void { this.visitType(t); }
  visitTypeTraits(t: TypeTraits): void { this.visitType(t); }
  visitTypeMixin(t: TypeMixin): void { this.visitType(t); }
  visitTypeTag(t: TypeTag): void { this.visitType(t); }

  // TypeNext (parsetime.d:158-163)
  visitTypeReference(t: TypeReference): void { this.visitTypeNext(t); }
  visitTypeSlice(t: TypeSlice): void { this.visitTypeNext(t); }
  visitTypeDelegate(t: TypeDelegate): void { this.visitTypeNext(t); }
  visitTypePointer(t: TypePointer): void { this.visitTypeNext(t); }
  visitTypeFunction(t: TypeFunction): void { this.visitTypeNext(t); }
  visitTypeArray(t: TypeArray): void { this.visitTypeNext(t); }

  // TypeArray (parsetime.d:166-168)
  visitTypeDArray(t: TypeDArray): void { this.visitTypeArray(t); }
  visitTypeAArray(t: TypeAArray): void { this.visitTypeArray(t); }
  visitTypeSArray(t: TypeSArray): void { this.visitTypeArray(t); }

  // TypeQualified (parsetime.d:171-174)
  visitTypeIdentifier(t: TypeIdentifier): void { this.visitTypeQualified(t); }
  visitTypeReturn(t: TypeReturn): void { this.visitTypeQualified(t); }
  visitTypeTypeof(t: TypeTypeof): void { this.visitTypeQualified(t); }
  visitTypeInstance(t: TypeInstance): void { this.visitTypeQualified(t); }

  // ── Expressions (parsetime.d:178-205) — forward to visitExpression ──
  visitDeclarationExp(e: DeclarationExp): void { this.visitExpression(e); }
  visitIntegerExp(e: IntegerExp): void { this.visitExpression(e); }
  visitNewAnonClassExp(e: NewAnonClassExp): void { this.visitExpression(e); }
  visitIsExp(e: IsExp): void { this.visitExpression(e); }
  visitRealExp(e: RealExp): void { this.visitExpression(e); }
  visitNullExp(e: NullExp): void { this.visitExpression(e); }
  visitTypeidExp(e: TypeidExp): void { this.visitExpression(e); }
  visitTraitsExp(e: TraitsExp): void { this.visitExpression(e); }
  visitStringExp(e: StringExp): void { this.visitExpression(e); }
  visitInterpExp(e: InterpExp): void { this.visitExpression(e); }
  visitNewExp(e: NewExp): void { this.visitExpression(e); }
  visitAssocArrayLiteralExp(e: AssocArrayLiteralExp): void { this.visitExpression(e); }
  visitArrayLiteralExp(e: ArrayLiteralExp): void { this.visitExpression(e); }
  visitMixinExp(e: MixinExp): void { this.visitExpression(e); }
  visitFuncExp(e: FuncExp): void { this.visitExpression(e); }
  visitIntervalExp(e: IntervalExp): void { this.visitExpression(e); }
  visitTypeExp(e: TypeExp): void { this.visitExpression(e); }
  visitScopeExp(e: ScopeExp): void { this.visitExpression(e); }
  visitIdentifierExp(e: IdentifierExp): void { this.visitExpression(e); }
  visitUnaExp(e: UnaExp): void { this.visitExpression(e); }
  visitDefaultInitExp(e: DefaultInitExp): void { this.visitExpression(e); }
  visitBinExp(e: BinExp): void { this.visitExpression(e); }
  visitDsymbolExp(e: DsymbolExp): void { this.visitExpression(e); }
  visitTemplateExp(e: TemplateExp): void { this.visitExpression(e); }
  visitSymbolExp(e: SymbolExp): void { this.visitExpression(e); }
  visitTupleExp(e: TupleExp): void { this.visitExpression(e); }
  visitThisExp(e: ThisExp): void { this.visitExpression(e); }
  visitGenericExp(e: GenericExp): void { this.visitExpression(e); }

  // Miscellaneous expressions (parsetime.d:208-210)
  visitVarExp(e: VarExp): void { this.visitSymbolExp(e); }
  visitDollarExp(e: DollarExp): void { this.visitIdentifierExp(e); }
  visitSuperExp(e: SuperExp): void { this.visitThisExp(e); }

  // UnaExp (parsetime.d:213-228)
  visitAddrExp(e: AddrExp): void { this.visitUnaExp(e); }
  visitPreExp(e: PreExp): void { this.visitUnaExp(e); }
  visitPtrExp(e: PtrExp): void { this.visitUnaExp(e); }
  visitNegExp(e: NegExp): void { this.visitUnaExp(e); }
  visitUAddExp(e: UAddExp): void { this.visitUnaExp(e); }
  visitNotExp(e: NotExp): void { this.visitUnaExp(e); }
  visitComExp(e: ComExp): void { this.visitUnaExp(e); }
  visitDeleteExp(e: DeleteExp): void { this.visitUnaExp(e); }
  visitCastExp(e: CastExp): void { this.visitUnaExp(e); }
  visitCallExp(e: CallExp): void { this.visitUnaExp(e); }
  visitDotIdExp(e: DotIdExp): void { this.visitUnaExp(e); }
  visitAssertExp(e: AssertExp): void { this.visitUnaExp(e); }
  visitThrowExp(e: ThrowExp): void { this.visitUnaExp(e); }
  visitImportExp(e: ImportExp): void { this.visitUnaExp(e); }
  visitDotTemplateInstanceExp(e: DotTemplateInstanceExp): void { this.visitUnaExp(e); }
  visitArrayExp(e: ArrayExp): void { this.visitUnaExp(e); }

  // DefaultInitExp (parsetime.d:231-235)
  visitFuncInitExp(e: FuncInitExp): void { this.visitDefaultInitExp(e); }
  visitPrettyFuncInitExp(e: PrettyFuncInitExp): void { this.visitDefaultInitExp(e); }
  visitFileInitExp(e: FileInitExp): void { this.visitDefaultInitExp(e); }
  visitLineInitExp(e: LineInitExp): void { this.visitDefaultInitExp(e); }
  visitModuleInitExp(e: ModuleInitExp): void { this.visitDefaultInitExp(e); }

  // BinExp (parsetime.d:238-260)
  visitCommaExp(e: CommaExp): void { this.visitBinExp(e); }
  visitPostExp(e: PostExp): void { this.visitBinExp(e); }
  visitPowExp(e: PowExp): void { this.visitBinExp(e); }
  visitMulExp(e: MulExp): void { this.visitBinExp(e); }
  visitDivExp(e: DivExp): void { this.visitBinExp(e); }
  visitModExp(e: ModExp): void { this.visitBinExp(e); }
  visitAddExp(e: AddExp): void { this.visitBinExp(e); }
  visitMinExp(e: MinExp): void { this.visitBinExp(e); }
  visitCatExp(e: CatExp): void { this.visitBinExp(e); }
  visitShlExp(e: ShlExp): void { this.visitBinExp(e); }
  visitShrExp(e: ShrExp): void { this.visitBinExp(e); }
  visitUshrExp(e: UshrExp): void { this.visitBinExp(e); }
  visitEqualExp(e: EqualExp): void { this.visitBinExp(e); }
  visitInExp(e: InExp): void { this.visitBinExp(e); }
  visitIdentityExp(e: IdentityExp): void { this.visitBinExp(e); }
  visitCmpExp(e: CmpExp): void { this.visitBinExp(e); }
  visitAndExp(e: AndExp): void { this.visitBinExp(e); }
  visitXorExp(e: XorExp): void { this.visitBinExp(e); }
  visitOrExp(e: OrExp): void { this.visitBinExp(e); }
  visitLogicalExp(e: LogicalExp): void { this.visitBinExp(e); }
  visitCondExp(e: CondExp): void { this.visitBinExp(e); }
  visitAssignExp(e: AssignExp): void { this.visitBinExp(e); }
  visitBinAssignExp(e: BinAssignExp): void { this.visitBinExp(e); }

  // BinAssignExp (parsetime.d:263-275)
  visitAddAssignExp(e: AddAssignExp): void { this.visitBinAssignExp(e); }
  visitMinAssignExp(e: MinAssignExp): void { this.visitBinAssignExp(e); }
  visitMulAssignExp(e: MulAssignExp): void { this.visitBinAssignExp(e); }
  visitDivAssignExp(e: DivAssignExp): void { this.visitBinAssignExp(e); }
  visitModAssignExp(e: ModAssignExp): void { this.visitBinAssignExp(e); }
  visitPowAssignExp(e: PowAssignExp): void { this.visitBinAssignExp(e); }
  visitAndAssignExp(e: AndAssignExp): void { this.visitBinAssignExp(e); }
  visitOrAssignExp(e: OrAssignExp): void { this.visitBinAssignExp(e); }
  visitXorAssignExp(e: XorAssignExp): void { this.visitBinAssignExp(e); }
  visitShlAssignExp(e: ShlAssignExp): void { this.visitBinAssignExp(e); }
  visitShrAssignExp(e: ShrAssignExp): void { this.visitBinAssignExp(e); }
  visitUshrAssignExp(e: UshrAssignExp): void { this.visitBinAssignExp(e); }
  visitCatAssignExp(e: CatAssignExp): void { this.visitBinAssignExp(e); }

  // CatAssignExp (parsetime.d:278-279)
  visitCatElemAssignExp(e: CatElemAssignExp): void { this.visitCatAssignExp(e); }
  visitCatDcharAssignExp(e: CatDcharAssignExp): void { this.visitCatAssignExp(e); }

  // ── TemplateParameter (parsetime.d:283-288) — forward to visitTemplateParameter ──
  visitTemplateAliasParameter(tp: TemplateAliasParameter): void { this.visitTemplateParameter(tp); }
  visitTemplateTypeParameter(tp: TemplateTypeParameter): void { this.visitTemplateParameter(tp); }
  visitTemplateTupleParameter(tp: TemplateTupleParameter): void { this.visitTemplateParameter(tp); }
  visitTemplateValueParameter(tp: TemplateValueParameter): void { this.visitTemplateParameter(tp); }
  visitTemplateThisParameter(tp: TemplateThisParameter): void { this.visitTemplateTypeParameter(tp); }

  // ── Condition (parsetime.d:292-295) — forward to visitCondition ──
  visitStaticIfCondition(c: StaticIfCondition): void { this.visitCondition(c); }
  visitDVCondition(c: DVCondition): void { this.visitCondition(c); }
  visitDebugCondition(c: DebugCondition): void { this.visitDVCondition(c); }
  visitVersionCondition(c: VersionCondition): void { this.visitDVCondition(c); }

  // ── Initializer (parsetime.d:299-304) — forward to visitInitializer ──
  visitExpInitializer(i: ExpInitializer): void { this.visitInitializer(i); }
  visitStructInitializer(i: StructInitializer): void { this.visitInitializer(i); }
  visitArrayInitializer(i: ArrayInitializer): void { this.visitInitializer(i); }
  visitVoidInitializer(i: VoidInitializer): void { this.visitInitializer(i); }
  visitDefaultInitializer(i: DefaultInitializer): void { this.visitInitializer(i); }
  // DJS-ESCALATE: visit(AST.CInitializer) self-cast recursion (dmd/visitor/parsetime.d:304)
  // `visit(cast(AST.CInitializer)i)` casts to the SAME type, not to a base. 13-visitor.md §4 only
  // covers `visit(cast(Base)d)`; this site is not a base-forward, so the doc's rule does not
  // literally apply and there are two plausible translations (reproduce D's self-call, or route to
  // the semantically-intended `Initializer`).
  // VERIFIED with ldc2 1.43.0-beta1: D overload resolution picks the EXACT match, i.e. this same
  // overload — upstream DMD self-recurses here without bound. No guess is emitted (11-escalate.md
  // §2: never emit the guessed translation alongside the escalation).
  visitCInitializer(_i: CInitializer): void {
    throw new Error("DJS-ESCALATE: visit(AST.CInitializer) self-cast recursion (dmd/visitor/parsetime.d:304)");
  }
}
