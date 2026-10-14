// Ported from dmd/asttypename.d (module dmd.asttypename) — 1:1 structural translation.
//
// "Development utility for printing AST nodes by their internal name, instead of as D source
// code." Two D declarations: the hand-written `astTypeName(RootObject)` dispatcher
// (asttypename.d:42) and the manifest `enum mixin_string` (asttypename.d:72) — a CTFE code
// GENERATOR whose expansion is spliced in by `mixin(mixin_string)` (asttypename.d:112).
//
// COMPILE-TIME RESOLUTION (07-compile-time.md §5.3 — this file is one of the two named
// code-generator mixins). `mixin_string` walks `__traits(getOverloads, Visitor, "visit")` and
// concatenates two source blocks:
//   1. one `string astTypeName(P) { scope tsv = new AstTypeNameVisitor; node.accept(tsv);
//      return tsv.typeName; }` per overload whose parameter's DIRECT base is `ASTNode`
//      (the `static if (is(P[0] S == super) && is(S[0] == ASTNode))` filter, asttypename.d:81);
//   2. one `override void visit(P) { typeName = "P"; }` per overload, wrapped in
//      `private extern(C++) final class AstTypeNameVisitor : Visitor`.
// Both blocks are RESOLVED HERE and emitted concretely — no `mixin` token reaches the TS
// (07 §11). The overload set is `ParseTimeVisitor!ASTCodegen`'s 230 (pulled in by
// `alias visit = ParseTimeVisitor!ASTCodegen.visit;`, dmd/visitor/package.d:28) plus `Visitor`'s
// own 61 = 291 slots, so block 2 expands to 291 overrides. That the INHERITED overloads are in
// the set is proved by upstream's own unittest (asttypename.d:120): it expects "TypeidExp", and
// `TypeidExp` is a PARSE-TIME overload (dmd/visitor/parsetime.d:184) — without it in the generated
// class the node would fall through `visit(Expression)` to the root `assert(0)`. Block 1's
// `ASTNode`-direct-base
// filter selects exactly the 8 ROOT overloads (verified: `Dsymbol` dmd/dsymbol.d:373,
// `Parameter` dmd/mtype.d:2286, `Statement` dmd/statement.d:40, `Type` dmd/mtype.d:390,
// `Expression` dmd/expression.d:119, `TemplateParameter` dmd/dtemplate.d:417, `Condition`
// dmd/cond.d:49, `Initializer` dmd/init.d:37 are the only `: ASTNode` classes in the frontend),
// so block 1 expands to 8 functions.
//
// dropped: `extern(D) enum mixin_string = ({...}());` (asttypename.d:72-109) — the generator
//          itself, a CT-only manifest constant. Its sole consumers are `mixin(mixin_string)`
//          (asttypename.d:112, resolved above) and the commented-out
//          `// pragma(msg, mixin_string);` (asttypename.d:111, a developer trace). Emitting the
//          generated D source as a TS string constant would be dead weight, and the mixin that
//          consumed it no longer exists.
//
// OVERLOAD SET -> DISTINCT NAMES (04-functions.md §1, Form B). The nine `astTypeName` functions
// are a same-arity/different-type overload set, which TS cannot express. §1B rule 1 picks the
// bare-name holder as "the one existing TS dependents already import; absent any dependent, the
// most-called D form". Its FIRST leg is vacuous here — grepped: the port has no `astTypeName` call
// site outside this module — and its fallback leg does NOT select `RootObject`: counting call
// sites in the D tree, the hand-written `astTypeName(RootObject)` is reached exactly once
// (`t.astTypeName`, asttypename.d:121, since `Tuple : RootObject`, dmd/dtemplate.d:195), while the
// `Dsymbol` form has two (asttypename.d:56 and the UFCS `s.astTypeName()` at dtoh.d:584) and the
// `Expression`/`TemplateParameter` forms two each (their switch arm plus asttypename.d:120/:122).
// The bare name goes to `astTypeName(RootObject)` on the ground the tie-break leaves standing: it
// is the module's hand-written PUBLIC ENTRY POINT and generic dispatcher, the one form the other
// eight (all mixin-generated) are reached from; and the single extra `Dsymbol` call that would
// otherwise out-vote it sits in `dtoh.d`, an EXCLUDED module (11 §3.1) whose call site is not
// ported. The eight generated forms take the §1B rule-2 bare receiver-type suffix
// (`astTypeNameExpression`, `astTypeNameDsymbol`, …), the UFCS-family shape. No call site in the
// port needed rewriting.
//
// VISITOR (13-visitor.md). `AstTypeNameVisitor` is Idiom A: each `void visit(X)` override becomes
// the distinctly-named `visitX` slot (§1), and the dispatch is each node's own `accept` calling
// its own `visitX` (§2) — already in place in the ported node classes. `alias visit =
// Visitor.visit;` (asttypename.d:105) is DROPPED: no overload hiding exists in TS (§1).
//
// The class is D `private` — module-scoped, and nothing outside this module (the file's own
// unittest included) touches it — so it stays unexported here rather than TS-`private`
// (01-conventions.md / 10 §1.7).
//
// IMPORTS. asttypename.d imports 25 modules at module level (asttypename.d:14-38) plus a
// function-local `import dmd.location;` in the unittest (asttypename.d:116, which moves to
// asttypename.test.ts). 20 of the 25 survive as the `import type` blocks below — they carry the
// node classes the 291 visit slots name. Five do not:
//   dropped: import dmd.ast_node (asttypename.d:14) — `ASTNode` appears ONLY inside the CT filter
//            `is(S[0] == ASTNode)` (asttypename.d:81), which is resolved at translation time.
//   dropped: import dmd.identifier (asttypename.d:31) — `DYNCAST.identifier` answers with a string
//            literal (asttypename.d:48-49); the `Identifier` type itself is never named.
//   dropped: import dmd.root.complex (asttypename.d:33) — `complex_t` is never named here
//            (`ComplexExp` comes from dmd.expression).
//   `import dmd.rootobject` (asttypename.d:34) and `import dmd.visitor` (asttypename.d:38) become
//            the two VALUE imports below (`DYNCAST`/`RootObject`, `Visitor`).
//
// LOAD ORDER (01-conventions.md §4.5): the only runtime edges out of this module are
// `visitor/index.js` (a load-order ROOT of the 76-module core SCC — it has no runtime edge back
// into the SCC), `rootobject.js`, `dstring.js` and `assert.js`, all SCC-external. Every node
// class is `import type` (erased), so importing this module pulls in no AST node module.

import { ds } from "../dstring.js";
import type { DString } from "../dstring.js";
import { SwitchError } from "../assert.js";
import { DYNCAST } from "./rootobject.js";
import type { RootObject } from "./rootobject.js";
import { Visitor } from "./visitor/index.js";

import type { AggregateDeclaration } from "./aggregate.js";
import type { AliasThis } from "./aliasthis.js";
import type {
    AlignDeclaration,
    AnonDeclaration,
    AttribDeclaration,
    CPPMangleDeclaration,
    CPPNamespaceDeclaration,
    ConditionalDeclaration,
    DeprecatedDeclaration,
    ForwardingAttribDeclaration,
    LinkDeclaration,
    MixinDeclaration,
    PragmaDeclaration,
    StaticForeachDeclaration,
    StaticIfDeclaration,
    StorageClassDeclaration,
    UserAttributeDeclaration,
    VisibilityDeclaration,
} from "./attrib.js";
import type {
    Condition,
    DVCondition,
    DebugCondition,
    StaticIfCondition,
    VersionCondition,
} from "./cond.js";
import type { ClassDeclaration, InterfaceDeclaration } from "./dclass.js";
import type {
    AliasDeclaration,
    BitFieldDeclaration,
    Declaration,
    OverDeclaration,
    SymbolDeclaration,
    ThisDeclaration,
    TupleDeclaration,
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
    VarDeclaration,
} from "./declaration.js";
import type { EnumDeclaration, EnumMember } from "./denum.js";
import type { Import } from "./dimport.js";
import type { Module, Package } from "./dmodule.js";
import type { StructDeclaration, UnionDeclaration } from "./dstruct.js";
import type {
    AliasAssign,
    ArrayScopeSymbol,
    CAsmDeclaration,
    Dsymbol,
    OverloadSet,
    ScopeDsymbol,
    WithScopeSymbol,
} from "./dsymbol.js";
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
} from "./dtemplate.js";
import type { DebugSymbol, VersionSymbol } from "./dversion.js";
import type {
    AddAssignExp,
    AddExp,
    AddrExp,
    AndAssignExp,
    AndExp,
    ArrayExp,
    ArrayLengthExp,
    ArrayLiteralExp,
    AssertExp,
    AssignExp,
    AssocArrayLiteralExp,
    BinAssignExp,
    BinExp,
    BlitExp,
    CallExp,
    CastExp,
    CatAssignExp,
    CatDcharAssignExp,
    CatElemAssignExp,
    CatExp,
    ClassReferenceExp,
    CmpExp,
    ComExp,
    CommaExp,
    ComplexExp,
    CompoundLiteralExp,
    CondExp,
    ConstructExp,
    DeclarationExp,
    DefaultInitExp,
    DelegateExp,
    DelegateFuncptrExp,
    DelegatePtrExp,
    DeleteExp,
    DivAssignExp,
    DivExp,
    DollarExp,
    DotExp,
    DotIdExp,
    DotTemplateExp,
    DotTemplateInstanceExp,
    DotTypeExp,
    DotVarExp,
    DsymbolExp,
    EqualExp,
    ErrorExp,
    Expression,
    FileInitExp,
    FuncExp,
    FuncInitExp,
    GenericExp,
    HaltExp,
    IdentifierExp,
    IdentityExp,
    ImportExp,
    InExp,
    IndexExp,
    IntegerExp,
    InterpExp,
    IntervalExp,
    IsExp,
    LineInitExp,
    LogicalExp,
    LoweredAssignExp,
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
    ObjcClassReferenceExp,
    OrAssignExp,
    OrExp,
    OverExp,
    PostExp,
    PowAssignExp,
    PowExp,
    PreExp,
    PrettyFuncInitExp,
    PtrExp,
    RealExp,
    RemoveExp,
    ScopeExp,
    ShlAssignExp,
    ShlExp,
    ShrAssignExp,
    ShrExp,
    SliceExp,
    StringExp,
    StructLiteralExp,
    SuperExp,
    SymOffExp,
    SymbolExp,
    TemplateExp,
    ThisExp,
    ThrowExp,
    ThrownExceptionExp,
    TraitsExp,
    TupleExp,
    TypeExp,
    TypeidExp,
    UAddExp,
    UnaExp,
    UshrAssignExp,
    UshrExp,
    VarExp,
    VectorArrayExp,
    VectorExp,
    VoidInitExp,
    XorAssignExp,
    XorExp,
} from "./expression.js";
import type {
    CtorDeclaration,
    DtorDeclaration,
    FuncAliasDeclaration,
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
} from "./func.js";
import type {
    ArrayInitializer,
    CInitializer,
    DefaultInitializer,
    ErrorInitializer,
    ExpInitializer,
    Initializer,
    StructInitializer,
    VoidInitializer,
} from "./init.js";
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
} from "./mtype.js";
import type { Nspace } from "./nspace.js";
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
    DebugStatement,
    DefaultStatement,
    DoStatement,
    DtorExpStatement,
    ErrorStatement,
    ExpStatement,
    ForStatement,
    ForeachRangeStatement,
    ForeachStatement,
    ForwardingStatement,
    GccAsmStatement,
    GotoCaseStatement,
    GotoDefaultStatement,
    GotoStatement,
    IfStatement,
    ImportStatement,
    InlineAsmStatement,
    LabelDsymbol,
    LabelStatement,
    MixinStatement,
    PeelStatement,
    PragmaStatement,
    ReturnStatement,
    ScopeGuardStatement,
    ScopeStatement,
    Statement,
    StaticAssertStatement,
    StaticForeachStatement,
    SwitchErrorStatement,
    SwitchStatement,
    SynchronizedStatement,
    ThrowStatement,
    TryCatchStatement,
    TryFinallyStatement,
    UnrolledLoopStatement,
    WhileStatement,
    WithStatement,
} from "./statement.js";
import type { StaticAssert } from "./staticassert.js";

/**
 * Returns: the typename of the dynamic ast-node-type
 * (this is a development tool, do not use in actual code)
 *
 * dmd/asttypename.d:42. The `final switch` over the 11 `DYNCAST` tags is total by construction;
 * D throws `SwitchError` on an unmatched value (06 §3.2), reproduced by the `default` arm.
 *
 * Returns `DString | null` because D `string` is a nullable slice (09 §1.0: `T[]`.init is `null`)
 * and the eight generated overloads return the visitor's `typeName` field verbatim; the port does
 * not narrow what the D return type admits.
 */
export function astTypeName(node: RootObject): DString | null {
    // D `final switch (node.dyncast())` evaluates the subject ONCE; the local keeps that (and is
    // what the `never` exhaustiveness check reads — a second `node.dyncast()` call would not be
    // narrowed).
    const tag = node.dyncast();
    switch (tag) {
        case DYNCAST.object:
            return ds("RootObject");
        case DYNCAST.identifier:
            return ds("Identifier");
        case DYNCAST.tuple:
            return ds("Tuple");

        // The eight forwarding arms below each carry a D `cast(T) node` (asttypename.d:54-68): a
        // DYNCAST-GATED DOWNCAST, i.e. the dynamic_cast substitute of the extern(C++) subset, whose
        // success is guaranteed by the very tag the arm was selected on. Same shape and same
        // justification as the `isExpression`/`isType`/… helpers (dtemplate.ts:66-95, D
        // dmd/dtemplate.d:92+); nothing is reinterpreted — the runtime object already IS the
        // subclass. TS accepts the plain assertion here (no shadowed field is in the way, so the
        // 02 §11.5 `as unknown as` cascade is not needed).
        case DYNCAST.expression:
            return astTypeNameExpression(node as Expression);
        case DYNCAST.dsymbol:
            return astTypeNameDsymbol(node as Dsymbol);
        case DYNCAST.type:
            return astTypeNameType(node as Type);
        case DYNCAST.parameter:
            return astTypeNameParameter(node as Parameter);
        case DYNCAST.statement:
            return astTypeNameStatement(node as Statement);
        case DYNCAST.condition:
            return astTypeNameCondition(node as Condition);
        case DYNCAST.templateparameter:
            return astTypeNameTemplateParameter(node as TemplateParameter);
        case DYNCAST.initializer:
            return astTypeNameInitializer(node as Initializer);
        default: {
            // final switch: D throws SwitchError on an unhandled value
            const _exhaustive: never = tag; void _exhaustive;   // static exhaustiveness check
            throw new SwitchError();
        }
    }
}

// resolved: mixin(mixin_string) block 1 (asttypename.d:83-90) -> the 8 `astTypeName` overloads the
// `is(S[0] == ASTNode)` filter selects, one per ROOT visit overload, in overload-set order. Every
// body is the generated one verbatim: build a scope visitor, dispatch through the node's own
// `accept`, hand back the name the matching `visitX` slot stored.

/// Generated overload for `Dsymbol` (dmd/visitor/parsetime.d:19).
export function astTypeNameDsymbol(node: Dsymbol): DString | null {
    const tsv = new AstTypeNameVisitor();   // D `scope` storage class — erased (04 §8, 03 §8)
    node.accept(tsv);
    return tsv.typeName;
}

/// Generated overload for `Parameter` (dmd/visitor/parsetime.d:20).
export function astTypeNameParameter(node: Parameter): DString | null {
    const tsv = new AstTypeNameVisitor();
    node.accept(tsv);
    return tsv.typeName;
}

/// Generated overload for `Statement` (dmd/visitor/parsetime.d:21).
export function astTypeNameStatement(node: Statement): DString | null {
    const tsv = new AstTypeNameVisitor();
    node.accept(tsv);
    return tsv.typeName;
}

/// Generated overload for `Type` (dmd/visitor/parsetime.d:22).
export function astTypeNameType(node: Type): DString | null {
    const tsv = new AstTypeNameVisitor();
    node.accept(tsv);
    return tsv.typeName;
}

/// Generated overload for `Expression` (dmd/visitor/parsetime.d:23).
export function astTypeNameExpression(node: Expression): DString | null {
    const tsv = new AstTypeNameVisitor();
    node.accept(tsv);
    return tsv.typeName;
}

/// Generated overload for `TemplateParameter` (dmd/visitor/parsetime.d:24).
export function astTypeNameTemplateParameter(node: TemplateParameter): DString | null {
    const tsv = new AstTypeNameVisitor();
    node.accept(tsv);
    return tsv.typeName;
}

/// Generated overload for `Condition` (dmd/visitor/parsetime.d:25).
export function astTypeNameCondition(node: Condition): DString | null {
    const tsv = new AstTypeNameVisitor();
    node.accept(tsv);
    return tsv.typeName;
}

/// Generated overload for `Initializer` (dmd/visitor/parsetime.d:26).
export function astTypeNameInitializer(node: Initializer): DString | null {
    const tsv = new AstTypeNameVisitor();
    node.accept(tsv);
    return tsv.typeName;
}

/**
 * resolved: mixin(mixin_string) block 2 (asttypename.d:93-108) ->
 * `private extern(C++) final class AstTypeNameVisitor : Visitor` with one
 * `override void visit(X _) { typeName = "X"; }` per overload of the `Visitor.visit` set.
 * 291 overrides: the 230 inherited through `alias visit = ParseTimeVisitor!ASTCodegen.visit;`
 * (dmd/visitor/package.d:28 -> dmd/visitor/parsetime.d:19-304) followed by `Visitor`'s own 61
 * (dmd/visitor/package.d:30-90). `extern(C++)`/`final` erased (04 §8); D `private` is
 * module-scoped, so the class is simply not exported.
 *
 * dropped: alias visit = Visitor.visit (asttypename.d:105) — no overload hiding in TS
 * (13-visitor.md §1).
 */
class AstTypeNameVisitor extends Visitor {
    /// D `string typeName;` — `.init` of a slice is `null`, not an empty slice (09 §1.0). Set by
    /// whichever slot the node's `accept` dispatches to, before any caller reads it.
    typeName: DString | null = null;

    // --- overloads inherited through `alias visit = ParseTimeVisitor!ASTCodegen.visit;`
    //     (dmd/visitor/package.d:28), i.e. dmd/visitor/parsetime.d:19-304 ---
    override visitDsymbol(_: Dsymbol): void { this.typeName = ds("Dsymbol"); }
    override visitParameter(_: Parameter): void { this.typeName = ds("Parameter"); }
    override visitStatement(_: Statement): void { this.typeName = ds("Statement"); }
    override visitType(_: Type): void { this.typeName = ds("Type"); }
    override visitExpression(_: Expression): void { this.typeName = ds("Expression"); }
    override visitTemplateParameter(_: TemplateParameter): void { this.typeName = ds("TemplateParameter"); }
    override visitCondition(_: Condition): void { this.typeName = ds("Condition"); }
    override visitInitializer(_: Initializer): void { this.typeName = ds("Initializer"); }
    override visitAliasThis(_: AliasThis): void { this.typeName = ds("AliasThis"); }
    override visitDeclaration(_: Declaration): void { this.typeName = ds("Declaration"); }
    override visitScopeDsymbol(_: ScopeDsymbol): void { this.typeName = ds("ScopeDsymbol"); }
    override visitImport(_: Import): void { this.typeName = ds("Import"); }
    override visitAttribDeclaration(_: AttribDeclaration): void { this.typeName = ds("AttribDeclaration"); }
    override visitStaticAssert(_: StaticAssert): void { this.typeName = ds("StaticAssert"); }
    override visitDebugSymbol(_: DebugSymbol): void { this.typeName = ds("DebugSymbol"); }
    override visitVersionSymbol(_: VersionSymbol): void { this.typeName = ds("VersionSymbol"); }
    override visitAliasAssign(_: AliasAssign): void { this.typeName = ds("AliasAssign"); }
    override visitCAsmDeclaration(_: CAsmDeclaration): void { this.typeName = ds("CAsmDeclaration"); }
    override visitPackage(_: Package): void { this.typeName = ds("Package"); }
    override visitEnumDeclaration(_: EnumDeclaration): void { this.typeName = ds("EnumDeclaration"); }
    override visitAggregateDeclaration(_: AggregateDeclaration): void { this.typeName = ds("AggregateDeclaration"); }
    override visitTemplateDeclaration(_: TemplateDeclaration): void { this.typeName = ds("TemplateDeclaration"); }
    override visitTemplateInstance(_: TemplateInstance): void { this.typeName = ds("TemplateInstance"); }
    override visitNspace(_: Nspace): void { this.typeName = ds("Nspace"); }
    override visitVarDeclaration(_: VarDeclaration): void { this.typeName = ds("VarDeclaration"); }
    override visitFuncDeclaration(_: FuncDeclaration): void { this.typeName = ds("FuncDeclaration"); }
    override visitAliasDeclaration(_: AliasDeclaration): void { this.typeName = ds("AliasDeclaration"); }
    override visitTupleDeclaration(_: TupleDeclaration): void { this.typeName = ds("TupleDeclaration"); }
    override visitFuncLiteralDeclaration(_: FuncLiteralDeclaration): void {
        this.typeName = ds("FuncLiteralDeclaration");
    }
    override visitPostBlitDeclaration(_: PostBlitDeclaration): void { this.typeName = ds("PostBlitDeclaration"); }
    override visitCtorDeclaration(_: CtorDeclaration): void { this.typeName = ds("CtorDeclaration"); }
    override visitDtorDeclaration(_: DtorDeclaration): void { this.typeName = ds("DtorDeclaration"); }
    override visitInvariantDeclaration(_: InvariantDeclaration): void { this.typeName = ds("InvariantDeclaration"); }
    override visitUnitTestDeclaration(_: UnitTestDeclaration): void { this.typeName = ds("UnitTestDeclaration"); }
    override visitNewDeclaration(_: NewDeclaration): void { this.typeName = ds("NewDeclaration"); }
    override visitStaticCtorDeclaration(_: StaticCtorDeclaration): void { this.typeName = ds("StaticCtorDeclaration"); }
    override visitStaticDtorDeclaration(_: StaticDtorDeclaration): void { this.typeName = ds("StaticDtorDeclaration"); }
    override visitSharedStaticCtorDeclaration(_: SharedStaticCtorDeclaration): void {
        this.typeName = ds("SharedStaticCtorDeclaration");
    }
    override visitSharedStaticDtorDeclaration(_: SharedStaticDtorDeclaration): void {
        this.typeName = ds("SharedStaticDtorDeclaration");
    }
    override visitMixinDeclaration(_: MixinDeclaration): void { this.typeName = ds("MixinDeclaration"); }
    override visitUserAttributeDeclaration(_: UserAttributeDeclaration): void {
        this.typeName = ds("UserAttributeDeclaration");
    }
    override visitLinkDeclaration(_: LinkDeclaration): void { this.typeName = ds("LinkDeclaration"); }
    override visitAnonDeclaration(_: AnonDeclaration): void { this.typeName = ds("AnonDeclaration"); }
    override visitAlignDeclaration(_: AlignDeclaration): void { this.typeName = ds("AlignDeclaration"); }
    override visitCPPMangleDeclaration(_: CPPMangleDeclaration): void { this.typeName = ds("CPPMangleDeclaration"); }
    override visitCPPNamespaceDeclaration(_: CPPNamespaceDeclaration): void {
        this.typeName = ds("CPPNamespaceDeclaration");
    }
    override visitVisibilityDeclaration(_: VisibilityDeclaration): void { this.typeName = ds("VisibilityDeclaration"); }
    override visitPragmaDeclaration(_: PragmaDeclaration): void { this.typeName = ds("PragmaDeclaration"); }
    override visitStorageClassDeclaration(_: StorageClassDeclaration): void {
        this.typeName = ds("StorageClassDeclaration");
    }
    override visitConditionalDeclaration(_: ConditionalDeclaration): void {
        this.typeName = ds("ConditionalDeclaration");
    }
    override visitStaticForeachDeclaration(_: StaticForeachDeclaration): void {
        this.typeName = ds("StaticForeachDeclaration");
    }
    override visitDeprecatedDeclaration(_: DeprecatedDeclaration): void { this.typeName = ds("DeprecatedDeclaration"); }
    override visitStaticIfDeclaration(_: StaticIfDeclaration): void { this.typeName = ds("StaticIfDeclaration"); }
    override visitEnumMember(_: EnumMember): void { this.typeName = ds("EnumMember"); }
    override visitModule(_: Module): void { this.typeName = ds("Module"); }
    override visitStructDeclaration(_: StructDeclaration): void { this.typeName = ds("StructDeclaration"); }
    override visitUnionDeclaration(_: UnionDeclaration): void { this.typeName = ds("UnionDeclaration"); }
    override visitClassDeclaration(_: ClassDeclaration): void { this.typeName = ds("ClassDeclaration"); }
    override visitInterfaceDeclaration(_: InterfaceDeclaration): void { this.typeName = ds("InterfaceDeclaration"); }
    override visitTemplateMixin(_: TemplateMixin): void { this.typeName = ds("TemplateMixin"); }
    override visitBitFieldDeclaration(_: BitFieldDeclaration): void { this.typeName = ds("BitFieldDeclaration"); }
    override visitImportStatement(_: ImportStatement): void { this.typeName = ds("ImportStatement"); }
    override visitScopeStatement(_: ScopeStatement): void { this.typeName = ds("ScopeStatement"); }
    override visitReturnStatement(_: ReturnStatement): void { this.typeName = ds("ReturnStatement"); }
    override visitLabelStatement(_: LabelStatement): void { this.typeName = ds("LabelStatement"); }
    override visitStaticAssertStatement(_: StaticAssertStatement): void { this.typeName = ds("StaticAssertStatement"); }
    override visitMixinStatement(_: MixinStatement): void { this.typeName = ds("MixinStatement"); }
    override visitWhileStatement(_: WhileStatement): void { this.typeName = ds("WhileStatement"); }
    override visitForStatement(_: ForStatement): void { this.typeName = ds("ForStatement"); }
    override visitDoStatement(_: DoStatement): void { this.typeName = ds("DoStatement"); }
    override visitForeachRangeStatement(_: ForeachRangeStatement): void { this.typeName = ds("ForeachRangeStatement"); }
    override visitForeachStatement(_: ForeachStatement): void { this.typeName = ds("ForeachStatement"); }
    override visitIfStatement(_: IfStatement): void { this.typeName = ds("IfStatement"); }
    override visitScopeGuardStatement(_: ScopeGuardStatement): void { this.typeName = ds("ScopeGuardStatement"); }
    override visitConditionalStatement(_: ConditionalStatement): void { this.typeName = ds("ConditionalStatement"); }
    override visitStaticForeachStatement(_: StaticForeachStatement): void {
        this.typeName = ds("StaticForeachStatement");
    }
    override visitPragmaStatement(_: PragmaStatement): void { this.typeName = ds("PragmaStatement"); }
    override visitSwitchStatement(_: SwitchStatement): void { this.typeName = ds("SwitchStatement"); }
    override visitCaseRangeStatement(_: CaseRangeStatement): void { this.typeName = ds("CaseRangeStatement"); }
    override visitCaseStatement(_: CaseStatement): void { this.typeName = ds("CaseStatement"); }
    override visitDefaultStatement(_: DefaultStatement): void { this.typeName = ds("DefaultStatement"); }
    override visitBreakStatement(_: BreakStatement): void { this.typeName = ds("BreakStatement"); }
    override visitContinueStatement(_: ContinueStatement): void { this.typeName = ds("ContinueStatement"); }
    override visitGotoDefaultStatement(_: GotoDefaultStatement): void { this.typeName = ds("GotoDefaultStatement"); }
    override visitGotoCaseStatement(_: GotoCaseStatement): void { this.typeName = ds("GotoCaseStatement"); }
    override visitGotoStatement(_: GotoStatement): void { this.typeName = ds("GotoStatement"); }
    override visitSynchronizedStatement(_: SynchronizedStatement): void { this.typeName = ds("SynchronizedStatement"); }
    override visitWithStatement(_: WithStatement): void { this.typeName = ds("WithStatement"); }
    override visitTryCatchStatement(_: TryCatchStatement): void { this.typeName = ds("TryCatchStatement"); }
    override visitTryFinallyStatement(_: TryFinallyStatement): void { this.typeName = ds("TryFinallyStatement"); }
    override visitThrowStatement(_: ThrowStatement): void { this.typeName = ds("ThrowStatement"); }
    override visitAsmStatement(_: AsmStatement): void { this.typeName = ds("AsmStatement"); }
    override visitExpStatement(_: ExpStatement): void { this.typeName = ds("ExpStatement"); }
    override visitCompoundStatement(_: CompoundStatement): void { this.typeName = ds("CompoundStatement"); }
    override visitCompoundDeclarationStatement(_: CompoundDeclarationStatement): void {
        this.typeName = ds("CompoundDeclarationStatement");
    }
    override visitCompoundAsmStatement(_: CompoundAsmStatement): void { this.typeName = ds("CompoundAsmStatement"); }
    override visitInlineAsmStatement(_: InlineAsmStatement): void { this.typeName = ds("InlineAsmStatement"); }
    override visitGccAsmStatement(_: GccAsmStatement): void { this.typeName = ds("GccAsmStatement"); }
    override visitTypeBasic(_: TypeBasic): void { this.typeName = ds("TypeBasic"); }
    override visitTypeError(_: TypeError): void { this.typeName = ds("TypeError"); }
    override visitTypeNull(_: TypeNull): void { this.typeName = ds("TypeNull"); }
    override visitTypeNoreturn(_: TypeNoreturn): void { this.typeName = ds("TypeNoreturn"); }
    override visitTypeVector(_: TypeVector): void { this.typeName = ds("TypeVector"); }
    override visitTypeEnum(_: TypeEnum): void { this.typeName = ds("TypeEnum"); }
    override visitTypeTuple(_: TypeTuple): void { this.typeName = ds("TypeTuple"); }
    override visitTypeClass(_: TypeClass): void { this.typeName = ds("TypeClass"); }
    override visitTypeStruct(_: TypeStruct): void { this.typeName = ds("TypeStruct"); }
    override visitTypeNext(_: TypeNext): void { this.typeName = ds("TypeNext"); }
    override visitTypeQualified(_: TypeQualified): void { this.typeName = ds("TypeQualified"); }
    override visitTypeTraits(_: TypeTraits): void { this.typeName = ds("TypeTraits"); }
    override visitTypeMixin(_: TypeMixin): void { this.typeName = ds("TypeMixin"); }
    override visitTypeTag(_: TypeTag): void { this.typeName = ds("TypeTag"); }
    override visitTypeReference(_: TypeReference): void { this.typeName = ds("TypeReference"); }
    override visitTypeSlice(_: TypeSlice): void { this.typeName = ds("TypeSlice"); }
    override visitTypeDelegate(_: TypeDelegate): void { this.typeName = ds("TypeDelegate"); }
    override visitTypePointer(_: TypePointer): void { this.typeName = ds("TypePointer"); }
    override visitTypeFunction(_: TypeFunction): void { this.typeName = ds("TypeFunction"); }
    override visitTypeArray(_: TypeArray): void { this.typeName = ds("TypeArray"); }
    override visitTypeDArray(_: TypeDArray): void { this.typeName = ds("TypeDArray"); }
    override visitTypeAArray(_: TypeAArray): void { this.typeName = ds("TypeAArray"); }
    override visitTypeSArray(_: TypeSArray): void { this.typeName = ds("TypeSArray"); }
    override visitTypeIdentifier(_: TypeIdentifier): void { this.typeName = ds("TypeIdentifier"); }
    override visitTypeReturn(_: TypeReturn): void { this.typeName = ds("TypeReturn"); }
    override visitTypeTypeof(_: TypeTypeof): void { this.typeName = ds("TypeTypeof"); }
    override visitTypeInstance(_: TypeInstance): void { this.typeName = ds("TypeInstance"); }
    override visitDeclarationExp(_: DeclarationExp): void { this.typeName = ds("DeclarationExp"); }
    override visitIntegerExp(_: IntegerExp): void { this.typeName = ds("IntegerExp"); }
    override visitNewAnonClassExp(_: NewAnonClassExp): void { this.typeName = ds("NewAnonClassExp"); }
    override visitIsExp(_: IsExp): void { this.typeName = ds("IsExp"); }
    override visitRealExp(_: RealExp): void { this.typeName = ds("RealExp"); }
    override visitNullExp(_: NullExp): void { this.typeName = ds("NullExp"); }
    override visitTypeidExp(_: TypeidExp): void { this.typeName = ds("TypeidExp"); }
    override visitTraitsExp(_: TraitsExp): void { this.typeName = ds("TraitsExp"); }
    override visitStringExp(_: StringExp): void { this.typeName = ds("StringExp"); }
    override visitInterpExp(_: InterpExp): void { this.typeName = ds("InterpExp"); }
    override visitNewExp(_: NewExp): void { this.typeName = ds("NewExp"); }
    override visitAssocArrayLiteralExp(_: AssocArrayLiteralExp): void { this.typeName = ds("AssocArrayLiteralExp"); }
    override visitArrayLiteralExp(_: ArrayLiteralExp): void { this.typeName = ds("ArrayLiteralExp"); }
    override visitMixinExp(_: MixinExp): void { this.typeName = ds("MixinExp"); }
    override visitFuncExp(_: FuncExp): void { this.typeName = ds("FuncExp"); }
    override visitIntervalExp(_: IntervalExp): void { this.typeName = ds("IntervalExp"); }
    override visitTypeExp(_: TypeExp): void { this.typeName = ds("TypeExp"); }
    override visitScopeExp(_: ScopeExp): void { this.typeName = ds("ScopeExp"); }
    override visitIdentifierExp(_: IdentifierExp): void { this.typeName = ds("IdentifierExp"); }
    override visitUnaExp(_: UnaExp): void { this.typeName = ds("UnaExp"); }
    override visitDefaultInitExp(_: DefaultInitExp): void { this.typeName = ds("DefaultInitExp"); }
    override visitBinExp(_: BinExp): void { this.typeName = ds("BinExp"); }
    override visitDsymbolExp(_: DsymbolExp): void { this.typeName = ds("DsymbolExp"); }
    override visitTemplateExp(_: TemplateExp): void { this.typeName = ds("TemplateExp"); }
    override visitSymbolExp(_: SymbolExp): void { this.typeName = ds("SymbolExp"); }
    override visitTupleExp(_: TupleExp): void { this.typeName = ds("TupleExp"); }
    override visitThisExp(_: ThisExp): void { this.typeName = ds("ThisExp"); }
    override visitGenericExp(_: GenericExp): void { this.typeName = ds("GenericExp"); }
    override visitVarExp(_: VarExp): void { this.typeName = ds("VarExp"); }
    override visitDollarExp(_: DollarExp): void { this.typeName = ds("DollarExp"); }
    override visitSuperExp(_: SuperExp): void { this.typeName = ds("SuperExp"); }
    override visitAddrExp(_: AddrExp): void { this.typeName = ds("AddrExp"); }
    override visitPreExp(_: PreExp): void { this.typeName = ds("PreExp"); }
    override visitPtrExp(_: PtrExp): void { this.typeName = ds("PtrExp"); }
    override visitNegExp(_: NegExp): void { this.typeName = ds("NegExp"); }
    override visitUAddExp(_: UAddExp): void { this.typeName = ds("UAddExp"); }
    override visitNotExp(_: NotExp): void { this.typeName = ds("NotExp"); }
    override visitComExp(_: ComExp): void { this.typeName = ds("ComExp"); }
    override visitDeleteExp(_: DeleteExp): void { this.typeName = ds("DeleteExp"); }
    override visitCastExp(_: CastExp): void { this.typeName = ds("CastExp"); }
    override visitCallExp(_: CallExp): void { this.typeName = ds("CallExp"); }
    override visitDotIdExp(_: DotIdExp): void { this.typeName = ds("DotIdExp"); }
    override visitAssertExp(_: AssertExp): void { this.typeName = ds("AssertExp"); }
    override visitThrowExp(_: ThrowExp): void { this.typeName = ds("ThrowExp"); }
    override visitImportExp(_: ImportExp): void { this.typeName = ds("ImportExp"); }
    override visitDotTemplateInstanceExp(_: DotTemplateInstanceExp): void {
        this.typeName = ds("DotTemplateInstanceExp");
    }
    override visitArrayExp(_: ArrayExp): void { this.typeName = ds("ArrayExp"); }
    override visitFuncInitExp(_: FuncInitExp): void { this.typeName = ds("FuncInitExp"); }
    override visitPrettyFuncInitExp(_: PrettyFuncInitExp): void { this.typeName = ds("PrettyFuncInitExp"); }
    override visitFileInitExp(_: FileInitExp): void { this.typeName = ds("FileInitExp"); }
    override visitLineInitExp(_: LineInitExp): void { this.typeName = ds("LineInitExp"); }
    override visitModuleInitExp(_: ModuleInitExp): void { this.typeName = ds("ModuleInitExp"); }
    override visitCommaExp(_: CommaExp): void { this.typeName = ds("CommaExp"); }
    override visitPostExp(_: PostExp): void { this.typeName = ds("PostExp"); }
    override visitPowExp(_: PowExp): void { this.typeName = ds("PowExp"); }
    override visitMulExp(_: MulExp): void { this.typeName = ds("MulExp"); }
    override visitDivExp(_: DivExp): void { this.typeName = ds("DivExp"); }
    override visitModExp(_: ModExp): void { this.typeName = ds("ModExp"); }
    override visitAddExp(_: AddExp): void { this.typeName = ds("AddExp"); }
    override visitMinExp(_: MinExp): void { this.typeName = ds("MinExp"); }
    override visitCatExp(_: CatExp): void { this.typeName = ds("CatExp"); }
    override visitShlExp(_: ShlExp): void { this.typeName = ds("ShlExp"); }
    override visitShrExp(_: ShrExp): void { this.typeName = ds("ShrExp"); }
    override visitUshrExp(_: UshrExp): void { this.typeName = ds("UshrExp"); }
    override visitEqualExp(_: EqualExp): void { this.typeName = ds("EqualExp"); }
    override visitInExp(_: InExp): void { this.typeName = ds("InExp"); }
    override visitIdentityExp(_: IdentityExp): void { this.typeName = ds("IdentityExp"); }
    override visitCmpExp(_: CmpExp): void { this.typeName = ds("CmpExp"); }
    override visitAndExp(_: AndExp): void { this.typeName = ds("AndExp"); }
    override visitXorExp(_: XorExp): void { this.typeName = ds("XorExp"); }
    override visitOrExp(_: OrExp): void { this.typeName = ds("OrExp"); }
    override visitLogicalExp(_: LogicalExp): void { this.typeName = ds("LogicalExp"); }
    override visitCondExp(_: CondExp): void { this.typeName = ds("CondExp"); }
    override visitAssignExp(_: AssignExp): void { this.typeName = ds("AssignExp"); }
    override visitBinAssignExp(_: BinAssignExp): void { this.typeName = ds("BinAssignExp"); }
    override visitAddAssignExp(_: AddAssignExp): void { this.typeName = ds("AddAssignExp"); }
    override visitMinAssignExp(_: MinAssignExp): void { this.typeName = ds("MinAssignExp"); }
    override visitMulAssignExp(_: MulAssignExp): void { this.typeName = ds("MulAssignExp"); }
    override visitDivAssignExp(_: DivAssignExp): void { this.typeName = ds("DivAssignExp"); }
    override visitModAssignExp(_: ModAssignExp): void { this.typeName = ds("ModAssignExp"); }
    override visitPowAssignExp(_: PowAssignExp): void { this.typeName = ds("PowAssignExp"); }
    override visitAndAssignExp(_: AndAssignExp): void { this.typeName = ds("AndAssignExp"); }
    override visitOrAssignExp(_: OrAssignExp): void { this.typeName = ds("OrAssignExp"); }
    override visitXorAssignExp(_: XorAssignExp): void { this.typeName = ds("XorAssignExp"); }
    override visitShlAssignExp(_: ShlAssignExp): void { this.typeName = ds("ShlAssignExp"); }
    override visitShrAssignExp(_: ShrAssignExp): void { this.typeName = ds("ShrAssignExp"); }
    override visitUshrAssignExp(_: UshrAssignExp): void { this.typeName = ds("UshrAssignExp"); }
    override visitCatAssignExp(_: CatAssignExp): void { this.typeName = ds("CatAssignExp"); }
    override visitCatElemAssignExp(_: CatElemAssignExp): void { this.typeName = ds("CatElemAssignExp"); }
    override visitCatDcharAssignExp(_: CatDcharAssignExp): void { this.typeName = ds("CatDcharAssignExp"); }
    override visitTemplateAliasParameter(_: TemplateAliasParameter): void {
        this.typeName = ds("TemplateAliasParameter");
    }
    override visitTemplateTypeParameter(_: TemplateTypeParameter): void { this.typeName = ds("TemplateTypeParameter"); }
    override visitTemplateTupleParameter(_: TemplateTupleParameter): void {
        this.typeName = ds("TemplateTupleParameter");
    }
    override visitTemplateValueParameter(_: TemplateValueParameter): void {
        this.typeName = ds("TemplateValueParameter");
    }
    override visitTemplateThisParameter(_: TemplateThisParameter): void { this.typeName = ds("TemplateThisParameter"); }
    override visitStaticIfCondition(_: StaticIfCondition): void { this.typeName = ds("StaticIfCondition"); }
    override visitDVCondition(_: DVCondition): void { this.typeName = ds("DVCondition"); }
    override visitDebugCondition(_: DebugCondition): void { this.typeName = ds("DebugCondition"); }
    override visitVersionCondition(_: VersionCondition): void { this.typeName = ds("VersionCondition"); }
    override visitExpInitializer(_: ExpInitializer): void { this.typeName = ds("ExpInitializer"); }
    override visitStructInitializer(_: StructInitializer): void { this.typeName = ds("StructInitializer"); }
    override visitArrayInitializer(_: ArrayInitializer): void { this.typeName = ds("ArrayInitializer"); }
    override visitVoidInitializer(_: VoidInitializer): void { this.typeName = ds("VoidInitializer"); }
    override visitDefaultInitializer(_: DefaultInitializer): void { this.typeName = ds("DefaultInitializer"); }
    override visitCInitializer(_: CInitializer): void { this.typeName = ds("CInitializer"); }

    // --- Visitor's own overloads (dmd/visitor/package.d:30-90) ---
    override visitErrorStatement(_: ErrorStatement): void { this.typeName = ds("ErrorStatement"); }
    override visitPeelStatement(_: PeelStatement): void { this.typeName = ds("PeelStatement"); }
    override visitUnrolledLoopStatement(_: UnrolledLoopStatement): void { this.typeName = ds("UnrolledLoopStatement"); }
    override visitSwitchErrorStatement(_: SwitchErrorStatement): void { this.typeName = ds("SwitchErrorStatement"); }
    override visitDebugStatement(_: DebugStatement): void { this.typeName = ds("DebugStatement"); }
    override visitDtorExpStatement(_: DtorExpStatement): void { this.typeName = ds("DtorExpStatement"); }
    override visitForwardingStatement(_: ForwardingStatement): void { this.typeName = ds("ForwardingStatement"); }
    override visitOverloadSet(_: OverloadSet): void { this.typeName = ds("OverloadSet"); }
    override visitLabelDsymbol(_: LabelDsymbol): void { this.typeName = ds("LabelDsymbol"); }
    override visitWithScopeSymbol(_: WithScopeSymbol): void { this.typeName = ds("WithScopeSymbol"); }
    override visitArrayScopeSymbol(_: ArrayScopeSymbol): void { this.typeName = ds("ArrayScopeSymbol"); }
    override visitOverDeclaration(_: OverDeclaration): void { this.typeName = ds("OverDeclaration"); }
    override visitSymbolDeclaration(_: SymbolDeclaration): void { this.typeName = ds("SymbolDeclaration"); }
    override visitForwardingAttribDeclaration(_: ForwardingAttribDeclaration): void {
        this.typeName = ds("ForwardingAttribDeclaration");
    }
    override visitThisDeclaration(_: ThisDeclaration): void { this.typeName = ds("ThisDeclaration"); }
    override visitTypeInfoDeclaration(_: TypeInfoDeclaration): void { this.typeName = ds("TypeInfoDeclaration"); }
    override visitTypeInfoStructDeclaration(_: TypeInfoStructDeclaration): void {
        this.typeName = ds("TypeInfoStructDeclaration");
    }
    override visitTypeInfoClassDeclaration(_: TypeInfoClassDeclaration): void {
        this.typeName = ds("TypeInfoClassDeclaration");
    }
    override visitTypeInfoInterfaceDeclaration(_: TypeInfoInterfaceDeclaration): void {
        this.typeName = ds("TypeInfoInterfaceDeclaration");
    }
    override visitTypeInfoPointerDeclaration(_: TypeInfoPointerDeclaration): void {
        this.typeName = ds("TypeInfoPointerDeclaration");
    }
    override visitTypeInfoArrayDeclaration(_: TypeInfoArrayDeclaration): void {
        this.typeName = ds("TypeInfoArrayDeclaration");
    }
    override visitTypeInfoStaticArrayDeclaration(_: TypeInfoStaticArrayDeclaration): void {
        this.typeName = ds("TypeInfoStaticArrayDeclaration");
    }
    override visitTypeInfoAssociativeArrayDeclaration(_: TypeInfoAssociativeArrayDeclaration): void {
        this.typeName = ds("TypeInfoAssociativeArrayDeclaration");
    }
    override visitTypeInfoEnumDeclaration(_: TypeInfoEnumDeclaration): void {
        this.typeName = ds("TypeInfoEnumDeclaration");
    }
    override visitTypeInfoFunctionDeclaration(_: TypeInfoFunctionDeclaration): void {
        this.typeName = ds("TypeInfoFunctionDeclaration");
    }
    override visitTypeInfoDelegateDeclaration(_: TypeInfoDelegateDeclaration): void {
        this.typeName = ds("TypeInfoDelegateDeclaration");
    }
    override visitTypeInfoTupleDeclaration(_: TypeInfoTupleDeclaration): void {
        this.typeName = ds("TypeInfoTupleDeclaration");
    }
    override visitTypeInfoConstDeclaration(_: TypeInfoConstDeclaration): void {
        this.typeName = ds("TypeInfoConstDeclaration");
    }
    override visitTypeInfoInvariantDeclaration(_: TypeInfoInvariantDeclaration): void {
        this.typeName = ds("TypeInfoInvariantDeclaration");
    }
    override visitTypeInfoSharedDeclaration(_: TypeInfoSharedDeclaration): void {
        this.typeName = ds("TypeInfoSharedDeclaration");
    }
    override visitTypeInfoWildDeclaration(_: TypeInfoWildDeclaration): void {
        this.typeName = ds("TypeInfoWildDeclaration");
    }
    override visitTypeInfoVectorDeclaration(_: TypeInfoVectorDeclaration): void {
        this.typeName = ds("TypeInfoVectorDeclaration");
    }
    override visitFuncAliasDeclaration(_: FuncAliasDeclaration): void { this.typeName = ds("FuncAliasDeclaration"); }
    override visitErrorInitializer(_: ErrorInitializer): void { this.typeName = ds("ErrorInitializer"); }
    override visitErrorExp(_: ErrorExp): void { this.typeName = ds("ErrorExp"); }
    override visitComplexExp(_: ComplexExp): void { this.typeName = ds("ComplexExp"); }
    override visitStructLiteralExp(_: StructLiteralExp): void { this.typeName = ds("StructLiteralExp"); }
    override visitCompoundLiteralExp(_: CompoundLiteralExp): void { this.typeName = ds("CompoundLiteralExp"); }
    override visitObjcClassReferenceExp(_: ObjcClassReferenceExp): void { this.typeName = ds("ObjcClassReferenceExp"); }
    override visitSymOffExp(_: SymOffExp): void { this.typeName = ds("SymOffExp"); }
    override visitOverExp(_: OverExp): void { this.typeName = ds("OverExp"); }
    override visitHaltExp(_: HaltExp): void { this.typeName = ds("HaltExp"); }
    override visitDotTemplateExp(_: DotTemplateExp): void { this.typeName = ds("DotTemplateExp"); }
    override visitDotVarExp(_: DotVarExp): void { this.typeName = ds("DotVarExp"); }
    override visitDelegateExp(_: DelegateExp): void { this.typeName = ds("DelegateExp"); }
    override visitDotTypeExp(_: DotTypeExp): void { this.typeName = ds("DotTypeExp"); }
    override visitVectorExp(_: VectorExp): void { this.typeName = ds("VectorExp"); }
    override visitVectorArrayExp(_: VectorArrayExp): void { this.typeName = ds("VectorArrayExp"); }
    override visitSliceExp(_: SliceExp): void { this.typeName = ds("SliceExp"); }
    override visitArrayLengthExp(_: ArrayLengthExp): void { this.typeName = ds("ArrayLengthExp"); }
    override visitDelegatePtrExp(_: DelegatePtrExp): void { this.typeName = ds("DelegatePtrExp"); }
    override visitDelegateFuncptrExp(_: DelegateFuncptrExp): void { this.typeName = ds("DelegateFuncptrExp"); }
    override visitDotExp(_: DotExp): void { this.typeName = ds("DotExp"); }
    override visitIndexExp(_: IndexExp): void { this.typeName = ds("IndexExp"); }
    override visitConstructExp(_: ConstructExp): void { this.typeName = ds("ConstructExp"); }
    override visitBlitExp(_: BlitExp): void { this.typeName = ds("BlitExp"); }
    override visitRemoveExp(_: RemoveExp): void { this.typeName = ds("RemoveExp"); }
    override visitClassReferenceExp(_: ClassReferenceExp): void { this.typeName = ds("ClassReferenceExp"); }
    override visitVoidInitExp(_: VoidInitExp): void { this.typeName = ds("VoidInitExp"); }
    override visitThrownExceptionExp(_: ThrownExceptionExp): void { this.typeName = ds("ThrownExceptionExp"); }
    override visitLoweredAssignExp(_: LoweredAssignExp): void { this.typeName = ds("LoweredAssignExp"); }
}
