// Ported from dmd/visitor/strict.d (module dmd.visitor.strict).
//
// "The StrictVisitor asserts 0 on all visiting functions in order to make sure that all the nodes
//  are visited."
//
// CANONICAL VISITOR FORM (13-visitor.md §8 — supersedes the earlier GAP-A generic holding pattern):
//   `extern(C++) class StrictVisitor(AST) : ParseTimeVisitor!AST`
//     -> non-generic `class StrictVisitor extends ParseTimeVisitor` (monomorphized, 13-visitor.md §3).
//   EVERY node `visitX` is overridden with `assertUnreachable()` so a MISSED visit fails at the
//   PRECISE node, not at its base (the load-bearing difference vs the inherited forward-to-base —
//   13-visitor.md §6). `alias visit = ParseTimeVisitor!AST.visit;` is DROPPED (13-visitor.md §1).
//
// The override set mirrors strict.d 1:1 (the parse-time node set; the semantic-time nodes are not
// in strict.d), and so does the DECLARATION ORDER — the members below appear in strict.d's own
// source order so an upstream `git diff` of strict.d maps line-for-line onto this file
// (00-how-to-use.md: do not reorganize, do not "improve" the structure). Each `_x` param is unused
// (the body only asserts) — prefixed `_` per noUnusedParameters.

import { assertUnreachable } from "../../assert.js";
import { ParseTimeVisitor } from "./parsetime.js";

import type { AggregateDeclaration } from "../aggregate.js";
import type {
  StructDeclaration,
  UnionDeclaration,
} from "../dstruct.js";
import type { AliasThis } from "../aliasthis.js";
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
  TypeTraits,
  TypeTuple,
  TypeTypeof,
  TypeVector,
} from "../mtype.js";
import type { Nspace } from "../nspace.js";
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
  SwitchStatement,
  SynchronizedStatement,
  ThrowStatement,
  TryCatchStatement,
  TryFinallyStatement,
  WhileStatement,
  WithStatement,
} from "../statement.js";
import type { StaticAssert } from "../staticassert.js";

/**
 * The StrictVisitor `assertUnreachable()`s on every visiting function so a missed visit fails at the
 * exact node. Ported from dmd/visitor/strict.d, monomorphized to ASTCodegen (13-visitor.md §3/§6).
 */
export class StrictVisitor extends ParseTimeVisitor {
  override visitDsymbol(_x: Dsymbol): void { assertUnreachable(); }
  override visitAliasThis(_x: AliasThis): void { assertUnreachable(); }
  override visitDeclaration(_x: Declaration): void { assertUnreachable(); }
  override visitScopeDsymbol(_x: ScopeDsymbol): void { assertUnreachable(); }
  override visitImport(_x: Import): void { assertUnreachable(); }
  override visitAttribDeclaration(_x: AttribDeclaration): void { assertUnreachable(); }
  override visitStaticAssert(_x: StaticAssert): void { assertUnreachable(); }
  override visitDebugSymbol(_x: DebugSymbol): void { assertUnreachable(); }
  override visitVersionSymbol(_x: VersionSymbol): void { assertUnreachable(); }
  override visitVarDeclaration(_x: VarDeclaration): void { assertUnreachable(); }
  override visitFuncDeclaration(_x: FuncDeclaration): void { assertUnreachable(); }
  override visitAliasDeclaration(_x: AliasDeclaration): void { assertUnreachable(); }
  override visitAliasAssign(_x: AliasAssign): void { assertUnreachable(); }
  override visitTupleDeclaration(_x: TupleDeclaration): void { assertUnreachable(); }
  override visitFuncLiteralDeclaration(_x: FuncLiteralDeclaration): void { assertUnreachable(); }
  override visitPostBlitDeclaration(_x: PostBlitDeclaration): void { assertUnreachable(); }
  override visitCtorDeclaration(_x: CtorDeclaration): void { assertUnreachable(); }
  override visitDtorDeclaration(_x: DtorDeclaration): void { assertUnreachable(); }
  override visitInvariantDeclaration(_x: InvariantDeclaration): void { assertUnreachable(); }
  override visitUnitTestDeclaration(_x: UnitTestDeclaration): void { assertUnreachable(); }
  override visitNewDeclaration(_x: NewDeclaration): void { assertUnreachable(); }
  override visitStaticCtorDeclaration(_x: StaticCtorDeclaration): void { assertUnreachable(); }
  override visitStaticDtorDeclaration(_x: StaticDtorDeclaration): void { assertUnreachable(); }
  override visitSharedStaticCtorDeclaration(_x: SharedStaticCtorDeclaration): void { assertUnreachable(); }
  override visitSharedStaticDtorDeclaration(_x: SharedStaticDtorDeclaration): void { assertUnreachable(); }
  override visitPackage(_x: Package): void { assertUnreachable(); }
  override visitEnumDeclaration(_x: EnumDeclaration): void { assertUnreachable(); }
  override visitAggregateDeclaration(_x: AggregateDeclaration): void { assertUnreachable(); }
  override visitTemplateDeclaration(_x: TemplateDeclaration): void { assertUnreachable(); }
  override visitTemplateInstance(_x: TemplateInstance): void { assertUnreachable(); }
  override visitNspace(_x: Nspace): void { assertUnreachable(); }
  override visitMixinDeclaration(_x: MixinDeclaration): void { assertUnreachable(); }
  override visitUserAttributeDeclaration(_x: UserAttributeDeclaration): void { assertUnreachable(); }
  override visitLinkDeclaration(_x: LinkDeclaration): void { assertUnreachable(); }
  override visitAnonDeclaration(_x: AnonDeclaration): void { assertUnreachable(); }
  override visitAlignDeclaration(_x: AlignDeclaration): void { assertUnreachable(); }
  override visitCPPMangleDeclaration(_x: CPPMangleDeclaration): void { assertUnreachable(); }
  override visitVisibilityDeclaration(_x: VisibilityDeclaration): void { assertUnreachable(); }
  override visitPragmaDeclaration(_x: PragmaDeclaration): void { assertUnreachable(); }
  override visitStorageClassDeclaration(_x: StorageClassDeclaration): void { assertUnreachable(); }
  override visitConditionalDeclaration(_x: ConditionalDeclaration): void { assertUnreachable(); }
  override visitDeprecatedDeclaration(_x: DeprecatedDeclaration): void { assertUnreachable(); }
  override visitStaticIfDeclaration(_x: StaticIfDeclaration): void { assertUnreachable(); }
  override visitEnumMember(_x: EnumMember): void { assertUnreachable(); }
  override visitModule(_x: Module): void { assertUnreachable(); }
  override visitStructDeclaration(_x: StructDeclaration): void { assertUnreachable(); }
  override visitUnionDeclaration(_x: UnionDeclaration): void { assertUnreachable(); }
  override visitClassDeclaration(_x: ClassDeclaration): void { assertUnreachable(); }
  override visitInterfaceDeclaration(_x: InterfaceDeclaration): void { assertUnreachable(); }
  override visitTemplateMixin(_x: TemplateMixin): void { assertUnreachable(); }
  override visitParameter(_x: Parameter): void { assertUnreachable(); }
  override visitStatement(_x: Statement): void { assertUnreachable(); }
  override visitImportStatement(_x: ImportStatement): void { assertUnreachable(); }
  override visitScopeStatement(_x: ScopeStatement): void { assertUnreachable(); }
  override visitReturnStatement(_x: ReturnStatement): void { assertUnreachable(); }
  override visitLabelStatement(_x: LabelStatement): void { assertUnreachable(); }
  override visitStaticAssertStatement(_x: StaticAssertStatement): void { assertUnreachable(); }
  override visitMixinStatement(_x: MixinStatement): void { assertUnreachable(); }
  override visitWhileStatement(_x: WhileStatement): void { assertUnreachable(); }
  override visitForStatement(_x: ForStatement): void { assertUnreachable(); }
  override visitDoStatement(_x: DoStatement): void { assertUnreachable(); }
  override visitForeachRangeStatement(_x: ForeachRangeStatement): void { assertUnreachable(); }
  override visitForeachStatement(_x: ForeachStatement): void { assertUnreachable(); }
  override visitIfStatement(_x: IfStatement): void { assertUnreachable(); }
  override visitScopeGuardStatement(_x: ScopeGuardStatement): void { assertUnreachable(); }
  override visitConditionalStatement(_x: ConditionalStatement): void { assertUnreachable(); }
  override visitPragmaStatement(_x: PragmaStatement): void { assertUnreachable(); }
  override visitSwitchStatement(_x: SwitchStatement): void { assertUnreachable(); }
  override visitCaseRangeStatement(_x: CaseRangeStatement): void { assertUnreachable(); }
  override visitCaseStatement(_x: CaseStatement): void { assertUnreachable(); }
  override visitDefaultStatement(_x: DefaultStatement): void { assertUnreachable(); }
  override visitBreakStatement(_x: BreakStatement): void { assertUnreachable(); }
  override visitContinueStatement(_x: ContinueStatement): void { assertUnreachable(); }
  override visitGotoDefaultStatement(_x: GotoDefaultStatement): void { assertUnreachable(); }
  override visitGotoCaseStatement(_x: GotoCaseStatement): void { assertUnreachable(); }
  override visitGotoStatement(_x: GotoStatement): void { assertUnreachable(); }
  override visitSynchronizedStatement(_x: SynchronizedStatement): void { assertUnreachable(); }
  override visitWithStatement(_x: WithStatement): void { assertUnreachable(); }
  override visitTryCatchStatement(_x: TryCatchStatement): void { assertUnreachable(); }
  override visitTryFinallyStatement(_x: TryFinallyStatement): void { assertUnreachable(); }
  override visitThrowStatement(_x: ThrowStatement): void { assertUnreachable(); }
  override visitAsmStatement(_x: AsmStatement): void { assertUnreachable(); }
  override visitExpStatement(_x: ExpStatement): void { assertUnreachable(); }
  override visitCompoundStatement(_x: CompoundStatement): void { assertUnreachable(); }
  override visitCompoundDeclarationStatement(_x: CompoundDeclarationStatement): void { assertUnreachable(); }
  override visitCompoundAsmStatement(_x: CompoundAsmStatement): void { assertUnreachable(); }
  override visitInlineAsmStatement(_x: InlineAsmStatement): void { assertUnreachable(); }
  override visitType(_x: Type): void { assertUnreachable(); }
  override visitTypeBasic(_x: TypeBasic): void { assertUnreachable(); }
  override visitTypeError(_x: TypeError): void { assertUnreachable(); }
  override visitTypeNull(_x: TypeNull): void { assertUnreachable(); }
  override visitTypeNoreturn(_x: TypeNoreturn): void { assertUnreachable(); }
  override visitTypeVector(_x: TypeVector): void { assertUnreachable(); }
  override visitTypeEnum(_x: TypeEnum): void { assertUnreachable(); }
  override visitTypeTuple(_x: TypeTuple): void { assertUnreachable(); }
  override visitTypeClass(_x: TypeClass): void { assertUnreachable(); }
  override visitTypeStruct(_x: TypeStruct): void { assertUnreachable(); }
  override visitTypeNext(_x: TypeNext): void { assertUnreachable(); }
  override visitTypeReference(_x: TypeReference): void { assertUnreachable(); }
  override visitTypeSlice(_x: TypeSlice): void { assertUnreachable(); }
  override visitTypeDelegate(_x: TypeDelegate): void { assertUnreachable(); }
  override visitTypePointer(_x: TypePointer): void { assertUnreachable(); }
  override visitTypeFunction(_x: TypeFunction): void { assertUnreachable(); }
  override visitTypeArray(_x: TypeArray): void { assertUnreachable(); }
  override visitTypeDArray(_x: TypeDArray): void { assertUnreachable(); }
  override visitTypeAArray(_x: TypeAArray): void { assertUnreachable(); }
  override visitTypeSArray(_x: TypeSArray): void { assertUnreachable(); }
  override visitTypeQualified(_x: TypeQualified): void { assertUnreachable(); }
  override visitTypeTraits(_x: TypeTraits): void { assertUnreachable(); }
  override visitTypeMixin(_x: TypeMixin): void { assertUnreachable(); }
  override visitTypeIdentifier(_x: TypeIdentifier): void { assertUnreachable(); }
  override visitTypeReturn(_x: TypeReturn): void { assertUnreachable(); }
  override visitTypeTypeof(_x: TypeTypeof): void { assertUnreachable(); }
  override visitTypeInstance(_x: TypeInstance): void { assertUnreachable(); }
  override visitExpression(_x: Expression): void { assertUnreachable(); }
  override visitDeclarationExp(_x: DeclarationExp): void { assertUnreachable(); }
  override visitIntegerExp(_x: IntegerExp): void { assertUnreachable(); }
  override visitNewAnonClassExp(_x: NewAnonClassExp): void { assertUnreachable(); }
  override visitIsExp(_x: IsExp): void { assertUnreachable(); }
  override visitRealExp(_x: RealExp): void { assertUnreachable(); }
  override visitNullExp(_x: NullExp): void { assertUnreachable(); }
  override visitTypeidExp(_x: TypeidExp): void { assertUnreachable(); }
  override visitTraitsExp(_x: TraitsExp): void { assertUnreachable(); }
  override visitStringExp(_x: StringExp): void { assertUnreachable(); }
  override visitInterpExp(_x: InterpExp): void { assertUnreachable(); }
  override visitNewExp(_x: NewExp): void { assertUnreachable(); }
  override visitAssocArrayLiteralExp(_x: AssocArrayLiteralExp): void { assertUnreachable(); }
  override visitArrayLiteralExp(_x: ArrayLiteralExp): void { assertUnreachable(); }
  override visitFuncExp(_x: FuncExp): void { assertUnreachable(); }
  override visitIntervalExp(_x: IntervalExp): void { assertUnreachable(); }
  override visitTypeExp(_x: TypeExp): void { assertUnreachable(); }
  override visitScopeExp(_x: ScopeExp): void { assertUnreachable(); }
  override visitIdentifierExp(_x: IdentifierExp): void { assertUnreachable(); }
  override visitUnaExp(_x: UnaExp): void { assertUnreachable(); }
  override visitDefaultInitExp(_x: DefaultInitExp): void { assertUnreachable(); }
  override visitBinExp(_x: BinExp): void { assertUnreachable(); }
  override visitDsymbolExp(_x: DsymbolExp): void { assertUnreachable(); }
  override visitTemplateExp(_x: TemplateExp): void { assertUnreachable(); }
  override visitSymbolExp(_x: SymbolExp): void { assertUnreachable(); }
  override visitVarExp(_x: VarExp): void { assertUnreachable(); }
  override visitTupleExp(_x: TupleExp): void { assertUnreachable(); }
  override visitDollarExp(_x: DollarExp): void { assertUnreachable(); }
  override visitThisExp(_x: ThisExp): void { assertUnreachable(); }
  override visitSuperExp(_x: SuperExp): void { assertUnreachable(); }
  override visitAddrExp(_x: AddrExp): void { assertUnreachable(); }
  override visitPreExp(_x: PreExp): void { assertUnreachable(); }
  override visitPtrExp(_x: PtrExp): void { assertUnreachable(); }
  override visitNegExp(_x: NegExp): void { assertUnreachable(); }
  override visitUAddExp(_x: UAddExp): void { assertUnreachable(); }
  override visitNotExp(_x: NotExp): void { assertUnreachable(); }
  override visitComExp(_x: ComExp): void { assertUnreachable(); }
  override visitDeleteExp(_x: DeleteExp): void { assertUnreachable(); }
  override visitCastExp(_x: CastExp): void { assertUnreachable(); }
  override visitCallExp(_x: CallExp): void { assertUnreachable(); }
  override visitDotIdExp(_x: DotIdExp): void { assertUnreachable(); }
  override visitAssertExp(_x: AssertExp): void { assertUnreachable(); }
  override visitThrowExp(_x: ThrowExp): void { assertUnreachable(); }
  override visitMixinExp(_x: MixinExp): void { assertUnreachable(); }
  override visitImportExp(_x: ImportExp): void { assertUnreachable(); }
  override visitDotTemplateInstanceExp(_x: DotTemplateInstanceExp): void { assertUnreachable(); }
  override visitArrayExp(_x: ArrayExp): void { assertUnreachable(); }
  override visitFuncInitExp(_x: FuncInitExp): void { assertUnreachable(); }
  override visitPrettyFuncInitExp(_x: PrettyFuncInitExp): void { assertUnreachable(); }
  override visitFileInitExp(_x: FileInitExp): void { assertUnreachable(); }
  override visitLineInitExp(_x: LineInitExp): void { assertUnreachable(); }
  override visitModuleInitExp(_x: ModuleInitExp): void { assertUnreachable(); }
  override visitCommaExp(_x: CommaExp): void { assertUnreachable(); }
  override visitPostExp(_x: PostExp): void { assertUnreachable(); }
  override visitPowExp(_x: PowExp): void { assertUnreachable(); }
  override visitMulExp(_x: MulExp): void { assertUnreachable(); }
  override visitDivExp(_x: DivExp): void { assertUnreachable(); }
  override visitModExp(_x: ModExp): void { assertUnreachable(); }
  override visitAddExp(_x: AddExp): void { assertUnreachable(); }
  override visitMinExp(_x: MinExp): void { assertUnreachable(); }
  override visitCatExp(_x: CatExp): void { assertUnreachable(); }
  override visitShlExp(_x: ShlExp): void { assertUnreachable(); }
  override visitShrExp(_x: ShrExp): void { assertUnreachable(); }
  override visitUshrExp(_x: UshrExp): void { assertUnreachable(); }
  override visitEqualExp(_x: EqualExp): void { assertUnreachable(); }
  override visitInExp(_x: InExp): void { assertUnreachable(); }
  override visitIdentityExp(_x: IdentityExp): void { assertUnreachable(); }
  override visitCmpExp(_x: CmpExp): void { assertUnreachable(); }
  override visitAndExp(_x: AndExp): void { assertUnreachable(); }
  override visitXorExp(_x: XorExp): void { assertUnreachable(); }
  override visitOrExp(_x: OrExp): void { assertUnreachable(); }
  override visitLogicalExp(_x: LogicalExp): void { assertUnreachable(); }
  override visitCondExp(_x: CondExp): void { assertUnreachable(); }
  override visitAssignExp(_x: AssignExp): void { assertUnreachable(); }
  override visitBinAssignExp(_x: BinAssignExp): void { assertUnreachable(); }
  override visitAddAssignExp(_x: AddAssignExp): void { assertUnreachable(); }
  override visitMinAssignExp(_x: MinAssignExp): void { assertUnreachable(); }
  override visitMulAssignExp(_x: MulAssignExp): void { assertUnreachable(); }
  override visitDivAssignExp(_x: DivAssignExp): void { assertUnreachable(); }
  override visitModAssignExp(_x: ModAssignExp): void { assertUnreachable(); }
  override visitPowAssignExp(_x: PowAssignExp): void { assertUnreachable(); }
  override visitAndAssignExp(_x: AndAssignExp): void { assertUnreachable(); }
  override visitOrAssignExp(_x: OrAssignExp): void { assertUnreachable(); }
  override visitXorAssignExp(_x: XorAssignExp): void { assertUnreachable(); }
  override visitShlAssignExp(_x: ShlAssignExp): void { assertUnreachable(); }
  override visitShrAssignExp(_x: ShrAssignExp): void { assertUnreachable(); }
  override visitUshrAssignExp(_x: UshrAssignExp): void { assertUnreachable(); }
  override visitCatAssignExp(_x: CatAssignExp): void { assertUnreachable(); }
  override visitCatElemAssignExp(_x: CatElemAssignExp): void { assertUnreachable(); }
  override visitCatDcharAssignExp(_x: CatDcharAssignExp): void { assertUnreachable(); }
  override visitGenericExp(_x: GenericExp): void { assertUnreachable(); }
  override visitTemplateParameter(_x: TemplateParameter): void { assertUnreachable(); }
  override visitTemplateAliasParameter(_x: TemplateAliasParameter): void { assertUnreachable(); }
  override visitTemplateTypeParameter(_x: TemplateTypeParameter): void { assertUnreachable(); }
  override visitTemplateTupleParameter(_x: TemplateTupleParameter): void { assertUnreachable(); }
  override visitTemplateValueParameter(_x: TemplateValueParameter): void { assertUnreachable(); }
  override visitTemplateThisParameter(_x: TemplateThisParameter): void { assertUnreachable(); }
  override visitCondition(_x: Condition): void { assertUnreachable(); }
  override visitStaticIfCondition(_x: StaticIfCondition): void { assertUnreachable(); }
  override visitDVCondition(_x: DVCondition): void { assertUnreachable(); }
  override visitDebugCondition(_x: DebugCondition): void { assertUnreachable(); }
  override visitVersionCondition(_x: VersionCondition): void { assertUnreachable(); }
  override visitInitializer(_x: Initializer): void { assertUnreachable(); }
  override visitExpInitializer(_x: ExpInitializer): void { assertUnreachable(); }
  override visitStructInitializer(_x: StructInitializer): void { assertUnreachable(); }
  override visitArrayInitializer(_x: ArrayInitializer): void { assertUnreachable(); }
  override visitVoidInitializer(_x: VoidInitializer): void { assertUnreachable(); }
  override visitDefaultInitializer(_x: DefaultInitializer): void { assertUnreachable(); }
  override visitCInitializer(_x: CInitializer): void { assertUnreachable(); }
}
