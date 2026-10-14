// Ported from dmd/hdrgen.d (module dmd.hdrgen).
//
// A core-SCC module (76-module core, translation-order.md): every top-level declaration of the D module
// is ported (DECLARATION INVENTORY below). astcodegen re-exports this module (`export * from
// "./hdrgen.js"`, astcodegen.d). Cross-core type references use `import type` to break the ESM load
// cycle (01-conventions.md §4.5).
//
// The file as a whole is not in D order (earlier rungs placed `typeToBufferx` and `expressionPrettyPrint`
// next to their callers); each declaration sits in D order relative to its neighbours.
//   - `HdrGenState` (:54), `TEST_EMIT_ALL` (:79) and the `.di` entry `genhdrfile` (:88) — the driver loop
//     that writes the file (main.d:670-691) is the shim's concern;
//   - the `toErrMsg` set (hdrgen.d:112/:126/:138) and `truncateForError` (:162);
//   - the public `toChars` set (04 §6.1 names): `statementToChars` (:195), `expressionToChars` (:204),
//     `initializerToChars` (:212), `typeToChars` (:220), `dsymbolToChars` (:231); and
//     `toString(Initializer)` (:267) as `initializerToString`, a name the §6.1 table does not (yet)
//     list — see NAMES below;
//   - the module dump `moduleToBuffer` / `moduleToBuffer2` (:282/:290, the `-vcg-ast` entry);
//   - the statement printer `statementToBuffer` (:324): nested visitors + the `VisitStatement` mixin
//     dispatch inlined in full (13 §7.6);
//   - the Dsymbol printer `dsymbolToBuffer` / `dsymbolToCBuffer` (:975/:980): nested visitors + the
//     function-local `DsymbolPrettyPrintVisitor` class (13 §7 Idiom A);
//   - the template-declaration printers (:2067/:2109/:3218/:3224), `visitVarDecl` (:2125) /
//     `isSpecialCName` (:2190);
//   - the expression printer `expressionPrettyPrint` (:2207) with every nested visitor of D, and the
//     module-level `floatToBuffer` (:3172);
//   - the condition printer `conditionToBuffer` / `ConditionPrettyPrintVisitor` (:3299/:3305) and
//     `statementToCBuffer` (:3344);
//   - the type printer `typeToBufferx` (:4314) with every nested visitor, `visitWithMask` (:3922),
//     `typeToBuffer` (:3906) and the two function-type printers (:4088/:4134);
//   - the initializer printer `initializerToBuffer` (:4220) and `initializerToCBuffer` (:3364);
//   - the argument / parameter / template-argument layer (:3586-:4083), `toCBufferInstance` (:3355),
//     `stcToBuffer` / `stcToString` (:3369/:3435), the linkage and visibility spellings (:3494-:3560,
//     `visibilityToBuffer` :3527 included), and `EXPtoString` (:4602) with its full 124-entry table.
// VISITOR CENSUS (13 §7): hdrgen.d declares three visitor classes — `DsymbolPrettyPrintVisitor` (:2011,
// nested in `toCBuffer(Dsymbol)`), `TemplateParameterPrettyPrintVisitor` (:3224) and
// `ConditionPrettyPrintVisitor` (:3305) — each emitted as a class (Idiom A). The statement, expression,
// type and initializer printers are nested-function visitors with a trailing dispatch (13 §7.5/§7.6).
// The expression printer's three Ddoc legs (visitInteger, visitString, visitInterpolation under `hgs.ddoc`,
// hdrgen.d:2251/:2411/:2441) call doc.d's `escapeDdocString`. `precedence` (dmd.parse), `optimize`
// (dmd.optimize) and `escapeDdocString` (dmd.doc) reach this module through registration slots, not
// imports — see the registration-slot block under the imports.
// PROVIDER (01 §4.4, the other direction): this module fills dsymbol.ts's `Dsymbol.toChars` slot with
// `dsymbolToChars` (hdrgen.d:231) — `registerDsymbolToChars(dsymbolToChars);` at the end of this file —
// because D's `import dmd.hdrgen : toChars` there is function-local (dsymbol.d:455) and dsymbol.ts
// cannot value-import this module. dsymbol.ts carries the ORDER CONTRACT.
//
// DECLARED DIVERGENCES (11 §2.6), two:
//   - `contractsToBuffer`'s expression-contract condition (hdrgen.d:1362-1364, :1385-1392). After semantic3 under
//     -checkaction=context the contract's ExpStatement can hold the CommaExp that lowers the assert; D's assert on
//     `EXP.assert_` fails there, ldc2's release build drops it and reads `CommaExp.e1` through the cast.
//     `contractCondition` reproduces the binary; its comment carries the proof.
//   - `expToBuffer`'s `assert(prec != PREC.zero)` (hdrgen.d:3884). parse.d's precedence table has no entry for
//     `EXP.interpolated`, so an `i"..."` operand (a default argument printed by -X, -D or `pragma(msg)`) has
//     precedence zero; ldc2's release build drops the assert and, zero being below every `pr`, parenthesises it.
//     The port admits exactly that op.
//
// DECLARATION INVENTORY (self-gate item 2). The D module has 64 top-level declarations; all 64 are
// translated here, none walled, none dropped.
//
// NAMES (04 §6.1 table). D's `toChars`, `toErrMsg` and `toCBuffer` are each one name over several
// first-parameter types; the TS names are the receiver-prefixed spellings of that table. The two
// families are different functions: `toErrMsg(Expression)` sets `hgs.errorMsg` and truncates at 60
// characters, `expressionToChars` (D's `toChars(Expression)`) does neither. `toString(Initializer)`,
// a one-member set the table does not list, takes the same prefix convention: `initializerToString`
// (ruled KEEP; the §6.1 row is the integrator's to fold).

import type { DString } from "../dstring.js";
import { cstr, cstrlen, ds, dsEmpty, dsToJs } from "../dstring.js";
// values: the printer tables + dispatches; `STMT` drives the statement-printer dispatch (hdrgen.d:971),
// `CPPMANGLE` visitCPPMangleDeclaration's switch (hdrgen.d:1139), `FileType` genhdrfile's ImportC test.
import { CPPMANGLE, FileType, InitKind, LINK, MODFlags, STC, STMT, TY, VarArg } from "./astenums.js";
// values: Visibility.Kind, read by the visibility printers (body-only); `registerDsymbolToChars`, called
// once at the end of this module (the dsymbol.ts-owned slot, see the header); `PASS`, the
// `semanticRun` comparand of visitFuncLiteralDeclaration (hdrgen.d:1887, body-only).
import { PASS, Visibility, registerDsymbolToChars } from "./dsymbol.js";
import { OutBuffer } from "./common/outbuffer.js"; // value: the printers allocate their own buffers
// Load-time value read: `TemplateParameterPrettyPrintVisitor extends Visitor` at top level (hdrgen.d:3224).
// `./visitor/index.js` is a LOAD-ORDER ROOT (01 §4.7) and evaluates before the SCC, so this is the
// sanctioned top-level edge, the same one expressionsem.ts and templatesem.ts take.
import { Visitor } from "./visitor/index.js";
// Body-fill (Rule 4.3 — value imports read post-load, only inside function bodies): visitWithMask
// writes the mod qualifiers through `MODtoBuffer`, `stcToBuffer` classifies through `buildScopeRef`;
// `mtype.ts` value-imports `typeToChars` from this module the same way (Type.toChars body), so
// neither side reads the other at load time.
// `attributesApply` (mtype.d:2632) is the free function the two function-type printers hand their
// attribute callback to (hdrgen.d:4129/:4163); `Type` is a value import for the `Type.tstring` /
// `Type.tsize_t` singletons that `tiargsToBuffer` / `sizeToBuffer` compare against (body-only).
// `ParameterList` is a value import for `visitTuple`'s `ParameterList(t.arguments, VarArg.none)`
// (hdrgen.d:4530); `toBaseTypeNonSemantic` / `isImaginaryNonSemantic` (mtype.d:65/:57) are the free
// functions `floatToBuffer` classifies its literal type through. All body-only.
import {
    attributesApply,
    buildScopeRef,
    isImaginaryNonSemantic,
    MODtoBuffer,
    ParameterList,
    ScopeRef,
    toBaseTypeNonSemantic,
    Type,
} from "./mtype.js";
import type {
    Parameter,
    TypeAArray,
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
// Body-fill (Rule 4.3): visitString escapes each code unit through the lexer-side `writeCharLiteral`
// (DEFINED at tokens.d:1156; hdrgen.d:2408 already calls it in free-function form, so no 04 §6
// UFCS rewrite happens here); visitInteger prints a character literal through
// `writeSingleCharLiteral` (tokens.d:1200), the same way.
import { writeCharLiteral, writeSingleCharLiteral } from "./tokens.js";
// Load-time value reads (see `EXPtoStringTable` / `stcToStringTable` below): `EXP` indexes the
// expression dispatch and the EXPtoString table; `Token`/`TOK` supply the storage-class spellings.
import { EXP, TOK, Token } from "./tokens.js";
import type {
    ArrayExp,
    ArrayLengthExp,
    ArrayLiteralExp,
    AssertExp,
    AssignExp,
    AssocArrayLiteralExp,
    BinExp,
    CallExp,
    CastExp,
    CatAssignExp,
    CatExp,
    ClassReferenceExp,
    CommaExp,
    ComplexExp,
    CompoundLiteralExp,
    CondExp,
    DeclarationExp,
    DefaultInitExp,
    DelegateExp,
    DelegateFuncptrExp,
    DelegatePtrExp,
    DeleteExp,
    DotExp,
    DotIdExp,
    DotTemplateExp,
    DotTemplateInstanceExp,
    DotTypeExp,
    DotVarExp,
    DsymbolExp,
    ErrorExp,
    Expression,
    FuncExp,
    HaltExp,
    IdentifierExp,
    ImportExp,
    IndexExp,
    IntegerExp,
    InterpExp,
    IntervalExp,
    IsExp,
    LoweredAssignExp,
    MixinExp,
    NewAnonClassExp,
    NewExp,
    NotExp,
    NullExp,
    OverExp,
    PostExp,
    PreExp,
    PtrExp,
    RealExp,
    RemoveExp,
    ScopeExp,
    SliceExp,
    StringExp,
    StructLiteralExp,
    SuperExp,
    SymOffExp,
    TemplateExp,
    ThisExp,
    ThrowExp,
    TraitsExp,
    TupleExp,
    TypeExp,
    TypeidExp,
    UnaExp,
    VarExp,
    VectorArrayExp,
    VectorExp,
    VoidInitExp,
} from "./expression.js";
import type { ArgumentLabels, Expressions, Objects, TemplateParameters } from "./arraytypes.js";
import type { RootObject } from "./rootobject.js";
// Body-only value read: `id.dyncast()` is switched on in visitTypeQualifiedHelper (hdrgen.d:4413).
// rootobject.ts is a leaf module (its only imports are dstring/assert), so no load edge into the SCC.
import { DYNCAST } from "./rootobject.js";
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
import type { VarDeclaration } from "./declaration.js";
// Body-only values: `CTFloat` formats a float literal (hdrgen.d:3180); `creall`/`cimagl` split a
// complex literal (hdrgen.d:2345). Both modules are leaves outside the SCC.
import { CTFloat } from "./root/ctfloat.js";
import type { real_t } from "./root/ctfloat.js";
import { cimagl, creall } from "./root/complex.js";
import type { Identifier } from "./identifier.js";
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
import type { EnumDeclaration } from "./denum.js";
import type { AliasAssign, Dsymbol } from "./dsymbol.js";
// Types of the statement / Dsymbol / condition printers (hdrgen.d:324-2062, :3299-3342).
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
    ForeachRangeStatement,
    ForeachStatement,
    ForStatement,
    ForwardingStatement,
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
import type {
    AlignDeclaration,
    AnonDeclaration,
    AttribDeclaration,
    ConditionalDeclaration,
    CPPMangleDeclaration,
    DeprecatedDeclaration,
    LinkDeclaration,
    MixinDeclaration,
    PragmaDeclaration,
    StaticForeachDeclaration,
    StorageClassDeclaration,
    UserAttributeDeclaration,
    VisibilityDeclaration,
} from "./attrib.js";
import type { Condition, DebugCondition, StaticIfCondition, VersionCondition } from "./cond.js";
import type { AliasDeclaration, BitFieldDeclaration } from "./declaration.js";
import type {
    DtorDeclaration,
    FuncDeclaration,
    FuncLiteralDeclaration,
    InvariantDeclaration,
    NewDeclaration,
    PostBlitDeclaration,
    StaticCtorDeclaration,
    StaticDtorDeclaration,
    UnitTestDeclaration,
} from "./func.js";
import type { EnumMember } from "./denum.js";
import type { ClassDeclaration } from "./dclass.js";
import type { StructDeclaration } from "./dstruct.js";
import type { Module } from "./dmodule.js";
import type { Import } from "./dimport.js";
import type { AliasThis } from "./aliasthis.js";
import type { StaticAssert } from "./staticassert.js";
import type { DebugSymbol, VersionSymbol } from "./dversion.js";
import type { Nspace } from "./nspace.js";
import { startsWith } from "./root/string.js"; // value: dsymbolToErrMsg's `__`-prefix gate (hdrgen.d:142)
import { dmdformat } from "./root/dmdformat.js"; // value: EXPtoString's no-string stdout line (hdrgen.d:4752)
import { assert, assertUnreachable, SwitchError } from "../assert.js";
// LAST (01 §4.8): value imports into SCC modules, read only inside function bodies (Rule 4.3).
// Each was measured alone against the full collect (none reaches expressionsem at load):
//   id.js         `Id.ctor` — the ctor tests at hdrgen.d:2069/:4157;
//   expression.js `WANTvalue` — the optimize() mode of objectToBuffer / sizeToBuffer (:4049/:3825);
//   dtemplate.js  `isType`/`isExpression`/`isDsymbol`/`isTuple`/`isParameter`/`isIdentifier`
//                 (dtemplate.d:78-118), the free functions objectToBuffer / tiargsToBuffer /
//                 rootObjectToErrMsg classify through (04 §6.1).
// D's `import dmd.parse;` / `import dmd.optimize;` (hdrgen.d:43/:42) are NOT value imports here: see
// the registration-slot block below. `PREC` is used as a TYPE only.
//   expression.js `StructLiteralExpStageFlags` — the recursion guard of visitStructLiteral (:2483).
import { Id } from "./id.js";
import { StructLiteralExpStageFlags, WANTvalue } from "./expression.js";
import { isDsymbol, isExpression, isIdentifier, isParameter, isTuple, isType } from "./dtemplate.js";
import type { PREC } from "./parse.js";
import type { optimize } from "./optimize.js";

// ── `dmd.parse` / `dmd.optimize` THROUGH REGISTRATION SLOTS (01 §4.4 registration-slot inversion) ──
// D imports both modules at module level (hdrgen.d:42/:43). A top-level value import of parse.js or
// of optimize.js breaks the suite at collect, even in last position (measured: 14 test files,
// `TypeError: Class extends value undefined` at func.ts:353). The chain: mtype.ts value-imports
// this module while declaration.ts is still evaluating (dscope → dmodule → declaration → dtemplate →
// mtype → hdrgen), and both modules reach expressionsem → access → dsymbolsem → clone → func,
// whose `FuncDeclaration extends Declaration` then reads an undefined base. The shape is
// declaration.ts's `dmd.mangle` edge: each PROVIDER hands its value over from its own module body
// through the hoisted registrars below (parse.ts `registerPrecedence(precedence);`, optimize.ts
// `registerOptimize(optimize);`), and each consuming site fails LOUDLY while its slot is empty,
// never with a fallback.
//
// ORDER CONTRACT: only an entry whose module graph contains parse.js fills the precedence slot, and
// only one containing optimize.js fills the optimize slot. With a slot empty, its readers raise the
// load-order error:
//   - precedence: `expPrecedence` (so `expToBuffer`, on EVERY call), and the expression-printer arms
//     visitUna, visitBin, visitCall, visitPtr, visitDelete, visitCast, visitVector, visitSlice,
//     visitPost and visitPre (each a D `precedence[e.op]` read, through `precedenceAt`);
//   - optimize: `sizeToBuffer` (a `size_t`-typed operand) and the `EXP.variable` arm of
//     `objectToBuffer`.
// The registrars are hoisted function declarations and the slots are `var` with NO initializer, so a
// provider whose body runs before this module's body neither hits a TDZ nor has its registration
// reset.
var precedenceSlot: readonly PREC[] | undefined; // parse.d:9763 `immutable PREC[EXP.max + 1] precedence`
var optimizeSlot: typeof optimize | undefined; // optimize.d:274 `Expression optimize(...)`
var escapeDdocStringSlot: ((buf: OutBuffer, start: number) => void) | undefined; // doc.d:178 `escapeDdocString`

/// Registration point for the `dmd.parse` edge described above: parse.ts hands over its
/// `precedence` table (parse.d:9763). Not a D symbol.
export function registerPrecedence(table: readonly PREC[]): void {
    precedenceSlot = table;
}

/// Registration point for the `dmd.optimize` edge described above: optimize.ts hands over
/// `optimize` (optimize.d:274). Not a D symbol.
export function registerOptimize(fn: typeof optimize): void {
    optimizeSlot = fn;
}

/// djs, not D: how visitInteger reads an enum member's value while it looks for the member a literal names
/// (hdrgen.d:2231). The default is D's read, which faults on a member whose value is not an integer literal: a null
/// value, an unanalysed one, an `ErrorInitializer` (`EnumMember.value`), each left by an error in that member's own
/// initializer. ldc2 1.43 segfaults there (`enum E { A = int.max, B }` then `pragma(msg, cast(E)5)`), so the compile
/// keeps the crash, as every crash faithful to LDC (10 §4.7, "Known non-returns"). The queries print after such an
/// error: src/query.ts `printing` installs a reader answering null for those members, which then name no literal, and
/// restores this one.
export function faithfulEnumMemberInteger(em: EnumMember): IntegerExp | null {
    return em.value!.isIntegerExp()!;
}

let enumMemberIntegerSlot: (em: EnumMember) => IntegerExp | null = faithfulEnumMemberInteger;

/// djs, not D: a hook around each symbol's print by the Dsymbol printer, at its one dispatch (`dsymbolToCBuffer`'s
/// `s.accept(v)`, hdrgen.d:2061): `print` prints `s` into `buf`, which the hook calls once. Null, the default, prints
/// directly. src/query.ts installs one for a print (the AST view's ranges, the guard of an instance's dump against
/// itself) and removes it in `finally`.
let dsymbolPrintHook: ((s: Dsymbol, buf: OutBuffer, print: () => void) => void) | null = null;

/// Installs the hook `dsymbolToCBuffer` calls around each symbol's print (the contract above); null removes it. Not a
/// D symbol.
export function registerDsymbolPrintHook(fn: ((s: Dsymbol, buf: OutBuffer, print: () => void) => void) | null): void {
    dsymbolPrintHook = fn;
}

/// Installs the reader visitInteger calls (the contract above). Not a D symbol.
export function registerEnumMemberInteger(fn: (em: EnumMember) => IntegerExp | null): void {
    enumMemberIntegerSlot = fn;
}

/// Registration point for the `dmd.doc` edge (D's module-level `import dmd.doc;`, hdrgen.d:30): doc.ts hands
/// over `escapeDdocString` (doc.d:178) from its module body. Not a D symbol. The edge needs the slot for the
/// same reason as the two above: `import { escapeDdocString } from "./doc.js"` in LAST position failed 56
/// rows of loadorder.test.ts (28 entries on each loader: `TypeError: Class extends value undefined` under
/// vitest, `ReferenceError: Cannot access 'VarDeclaration' before initialization` at denum.js under native
/// ESM), because doc.ts value-imports dsymbolsem / templatesem / typesem while declaration.ts is still
/// evaluating. ORDER CONTRACT: the slot is filled by every entry whose graph contains doc.ts; its readers
/// run only under `hgs.ddoc`, which only doc.ts sets (doc.d:1651/:1700/:1712), so a reader never meets an
/// empty slot through a D path.
export function registerEscapeDdocString(fn: (buf: OutBuffer, start: number) => void): void {
    escapeDdocStringSlot = fn;
}

/// Every D call of `escapeDdocString(buf, o)` (doc.d:178) in this module, through the `dmd.doc` slot above.
/// Not a D symbol: the slot's one reader; `site` is the D function making the call.
function escapeDdocStringAt(site: string, buf: OutBuffer, start: number): void {
    if (escapeDdocStringSlot === undefined)
        throw new Error(`hdrgen.${site}: registerEscapeDdocString not called (dmd/doc.d:178)`);
    escapeDdocStringSlot(buf, start);
}

/// Every D read of `precedence[op]` (parse.d:9763) in this module, through the `dmd.parse` slot above.
/// Not a D symbol: the slot's one reader. `site` is the D function doing the read; an empty slot (the
/// load-order contract, not a D branch) raises `hdrgen.<site>: registerPrecedence not called …`, the
/// same per-site shape as the optimize-slot reads in `sizeToBuffer` / `objectToBuffer` (01 §4.4).
function precedenceAt(site: string, op: EXP): PREC {
    if (precedenceSlot === undefined)
        throw new Error(`hdrgen.${site}: registerPrecedence not called (dmd/parse.d:9763)`);
    return precedenceSlot[op];
}

// The PREC members D names in this module (parse.d:9737 `enum PREC : int` — zero, expr, assign,
// cond, oror, andand, or, xor, and, equal, rel, …; parse.ts:9422 mirrors it as a `const enum`).
// `PREC` is a type-only import here (the value import is the cycle above), so the members D names
// are spelled as constants of that type; tsc rejects any literal that is not a PREC member value.
const PREC_zero: PREC = 0;
const PREC_expr: PREC = 1;
const PREC_assign: PREC = 2;
const PREC_cond: PREC = 3;
const PREC_oror: PREC = 4;
const PREC_or: PREC = 6;
const PREC_and: PREC = 8;
const PREC_rel: PREC = 10;
const PREC_unary: PREC = 15;
const PREC_primary: PREC = 16;

/**
 * A one-slot box standing in for a D `ref` parameter of a VALUE type (02 §11 / the `Ref<T>` shape
 * already used by clone.ts, ctorflow.ts, escape.ts). `stcToString(ref STC stc)` REDUCES its
 * argument, and a branded `bigint` cannot be aliased any other way.
 */
export interface Ref<T> {
    value: T;
}

/**
 * dmd/hdrgen.d:54 — `struct HdrGenState`. The pretty-printer mode flags (header generation, Ddoc,
 * AST dump, error-message formatting, …). VALUE TYPE in D; every printer entry point here constructs
 * a fresh one, so no copy plumbing is needed yet.
 *
 * All 19 D members are present, in D's own order (verified against hdrgen.d:56-77), so a later
 * printer fill extends behavior without reshaping the struct.
 */
export class HdrGenState {
    hdrgen = false;        /// true if generating header file
    ddoc = false;          /// true if generating Ddoc file
    fullDump = false;      /// true if generating a full AST dump file
    importcHdr = false;    /// true if generating a .di file from an ImportC file
    inCAlias = false;      /// Set to prevent ImportC translating typedefs as `alias X = X`
    inFuncReturn = false;  /// Set when printing function return type to avoid typedef name
    doFuncBodies = false;  /// include function bodies in output
    vcg_ast = false;       /// write out codegen-ast
    skipConstraints = false; // skip constraints when doing templates
    showOneMember = true;
    errorMsg = false;      /// true if formatting for inside an error message
    fullQual = false;      /// fully qualify types when printing
    tpltMember = 0;
    autoMember = 0;
    forStmtInit = 0;
    insideFuncBody = 0;
    insideAggregate = 0;
    declstring = false; // set while declaring alias for string,wstring or dstring
    inEnumDecl: EnumDeclaration | null = null;
}

/// dmd/hdrgen.d:79 — `enum TEST_EMIT_ALL = 0;`. A public manifest constant (02 §4.1) with no reader in
/// the frontend; its only other appearance is the C++ mirror in frontend.h.
export const TEST_EMIT_ALL = 0;

/****************************************
 * dmd/hdrgen.d:88 — `void genhdrfile(Module m, bool doFuncBodies, ref OutBuffer buf)`.
 * Generate a header (.di) file for Module m: the `// D import file generated from '<src>'` banner
 * line, then the whole module through the Dsymbol printer in header mode, indenting with tabs
 * (`buf.doindent`).
 * Params:
 *      m = Module to generate header for
 *      doFuncBodies = generate function definitions rather than just declarations
 *      buf = buffer to write the data to
 *
 * The driver side (main.d:684, the `-H` loop that writes the `.di` file) is the shim's concern; this
 * is the printer entry it calls.
 */
export function genhdrfile(m: Module, doFuncBodies: boolean, buf: OutBuffer): void {
    // resolved: version(IN_LLVM) -> ON (_config.md §1). Its block (hdrgen.d:90-94) holds only a FIXME
    // and a commented-out `m.checkAndAddOutputFile(m.hdrfile);`, so nothing is emitted.

    buf.doindent = true; // hdrgen.d:96 — `buf.doindent = 1;` (a `bool` field)
    // hdrgen.d:97 — `%s` of `FileName.toChars()`, through the one format shim (10 §3.5).
    buf.printf(ds("// D import file generated from '%s'"), m.srcfile.toChars());
    buf.writenl();
    const hgs = new HdrGenState(); // hdrgen.d:99
    hgs.hdrgen = true;
    hgs.importcHdr = m.filetype === FileType.c; // hdrgen.d:101
    hgs.doFuncBodies = doFuncBodies;
    // hdrgen.d:103 — `toCBuffer(m, buf, hgs)`, the Dsymbol overload. `as unknown as Dsymbol`: audited
    // upcast cascade (02 §11.5) of the `errors` field shadow — Module.errors (uint) over Dsymbol.errors
    // (bool); nothing is reinterpreted.
    dsymbolToCBuffer(m as unknown as Dsymbol, buf, hgs);
}

/**
 * dmd/hdrgen.d:112 — `const(char)* toErrMsg(const RootObject o)` (the RootObject overload of D's
 * `toErrMsg` set; Form B split named for its first-parameter type, beside `dsymbolToErrMsg`).
 * Convert `o` to a string for error messages: an Expression or a Dsymbol through its own
 * `toErrMsg` overload, a Type through `toChars()`, an Identifier through `toChars()`.
 *
 * Preconditions: `o` is one of those four kinds. Any other RootObject, and a null `o` (each
 * classifier returns null for it), reaches D's `assert(0)`.
 * Returns: the rendered text; the Expression / Type forms come from `extractChars()` and carry the
 * NUL terminator (02 §11.2), which a `%s` consumer stops at.
 */
export function rootObjectToErrMsg(o: RootObject | null): DString {
    // hdrgen.d:114-121 — `o.isExpression()` etc. are the dtemplate.d:78-118 free functions reached by
    // UFCS (04 §6.1: rootobject.d declares none of them).
    const e = isExpression(o);
    if (e) // hdrgen.d:114
        return toErrMsg(e);
    const d = isDsymbol(o);
    if (d) // hdrgen.d:116
        return dsymbolToErrMsg(d);
    const t = isType(o);
    if (t) // hdrgen.d:118
        return t.toChars();
    const id = isIdentifier(o);
    if (id) // hdrgen.d:120
        return id.toChars();
    assertUnreachable(); // hdrgen.d:122 — D's own `assert(0)`, ordinary translated code
}

/**
 * dmd/hdrgen.d:126 — `const(char)* toErrMsg(const Expression e)`. Render `e` for inclusion inside an
 * error message: errorMsg-mode pretty-print, then `truncateForError` (newline scrub, backtick
 * doubling, 60-char cap).
 *
 * NOT D's `toChars(const Expression)` (hdrgen.d:204): that one is `expressionToChars` below (04 §6.1
 * table), which neither sets `hgs.errorMsg` nor truncates. A consumer that wants D's `e.toChars()`
 * must not call this.
 */
export function toErrMsg(e: Expression): DString {
    const hgs = new HdrGenState();
    hgs.errorMsg = true;
    const buf = new OutBuffer();
    expToCBuffer(e, buf, hgs);
    truncateForError(buf, 60);
    return buf.extractChars();
}

/**
 * dmd/hdrgen.d:138 — `const(char)* toErrMsg(const Dsymbol d)` (the Dsymbol overload of the D
 * `toErrMsg` overload set, split by operand type in TS — same convention as `typeToCBuffer` /
 * `expToCBuffer`). Render a symbol for inclusion inside an error message: the COMMON case is the
 * plain name (`d.toChars()` — e.g. `S` for a struct in the "defined here" supplemental,
 * typesem.d:5164). A `__`-prefixed function or template instance that is not a constructor (a
 * function literal `__lambda…`, a generated instance) is instead printed in full through the Dsymbol
 * printer in errorMsg mode and cut at 80 characters (hdrgen.d:144-149): `(int a) => a + x`.
 */
export function dsymbolToErrMsg(d: Dsymbol): DString {
    if (d.isFuncDeclaration() !== null || d.isTemplateInstance() !== null) {
        if (d.ident && startsWith(d.ident.toString(), ds("__")) && d.isCtorDeclaration() === null) {
            const hgs = new HdrGenState(); // hdrgen.d:144
            hgs.errorMsg = true;
            const buf = new OutBuffer(); // hdrgen.d:146
            // D's `cast() d` only drops const.
            dsymbolToCBuffer(d, buf, hgs); // hdrgen.d:147 — `toCBuffer(cast() d, buf, hgs)`
            truncateForError(buf, 80); // hdrgen.d:148
            return buf.extractChars(); // hdrgen.d:149
        }
    }
    return d.toChars(); // hdrgen.d:153
}

/**
 * dmd/hdrgen.d:162 — `private void truncateForError(ref OutBuffer buf, size_t maxLength)`. Make the
 * buffer content fit inline in an error message: drop `\r`, flatten `\n` to a space, double every
 * backtick (the message is rendered between backticks), strip trailing spaces, cap at `maxLength`
 * with a `...` tail. Fully live (pure OutBuffer surgery).
 */
function truncateForError(buf: OutBuffer, maxLength: number): void {
    // hdrgen.d:164 — Remove newlines, escape backticks ` by doubling them
    for (let i = 0; i < buf.length(); i++) {
        if (buf.opIndex(i) === 0x0d) // '\r'
            buf.remove(i, 1);
        if (buf.opIndex(i) === 0x0a) // '\n'
            buf.peekSlice()[i] = 0x20; // ' '
        if (buf.opIndex(i) === 0x60) // '`'
            i = buf.insert(i, ds("`"));
    }
    // hdrgen.d:175 — Strip trailing whitespace
    while (buf.length() && buf.opIndex(buf.length() - 1) === 0x20)
        buf.setsize(buf.length() - 1);
    // hdrgen.d:179 — Truncate
    if (buf.length() > maxLength) {
        buf.setsize(maxLength - 3);
        buf.writestring(ds("..."));
    }
}

/***************************************
 * dmd/hdrgen.d:195 — `public const(char)* toChars(const Statement s)`, the Statement overload of D's
 * `toChars` set (04 §6.1 name). Turn a Statement into a string suitable for printf. Leaks memory.
 *
 * Returns: 0-terminated string. D appends the NUL itself (`buf.put(cast(ubyte)0)`) and returns the
 * slice's `.ptr`, so the DString carries its terminator exactly as an `extractChars()` result does
 * (02 §11.2): a `%s` consumer stops at it, a byte-slice consumer passes it through `cstr`.
 * Cost: one `OutBuffer` + one `HdrGenState`; the whole statement tree is printed (default mode, no
 * header / vcg flags).
 */
export function statementToChars(s: Statement): DString {
    const hgs = new HdrGenState(); // hdrgen.d:197
    const buf = new OutBuffer(); // hdrgen.d:198
    statementToCBuffer(s, buf, hgs); // hdrgen.d:199 — `toCBuffer(s, buf, hgs)`, the Statement overload
    buf.writeByte(0); // hdrgen.d:200 — `buf.put(cast(ubyte)0)`
    // hdrgen.d:201 — `buf.extractSlice().ptr`: CONSUME (08 §13a.2), the local buffer is dead after.
    return buf.extractSlice();
}

/**
 * dmd/hdrgen.d:204 — `public const(char)* toChars(const Expression e)`, the Expression overload of D's
 * `toChars` set (04 §6.1 name). The plain pretty-print that D's `Expression.toChars()` returns
 * (expression.d:216): default `HdrGenState`, no errorMsg mode, no truncation — unlike `toErrMsg`.
 *
 * Returns: the rendered text from `extractChars()`, NUL-terminated (02 §11.2).
 * Cost: one `OutBuffer` + one `HdrGenState`. Every operand print goes through `expToBuffer`, which
 * reads the `precedence` registration slot on EVERY call (not only when it parenthesises), so parse.js
 * must be in the entry's module graph for any expression with operands.
 */
export function expressionToChars(e: Expression): DString {
    const hgs = new HdrGenState(); // hdrgen.d:206
    const buf = new OutBuffer(); // hdrgen.d:207
    expToCBuffer(e, buf, hgs); // hdrgen.d:208 — `toCBuffer(e, buf, hgs)`, the Expression overload
    return buf.extractChars(); // hdrgen.d:209
}

/**
 * dmd/hdrgen.d:212 — `public const(char)* toChars(const Initializer i)`, the Initializer overload of
 * D's `toChars` set (04 §6.1 name). Pretty-print an initializer the way diagnostics quote it
 * (`{a:1, b:2}`, `[1, 2]`, `void`), e.g. initsem.d:65's "invalid value `%s` in initializer".
 *
 * Returns: the rendered text from `extractChars()`, NUL-terminated (02 §11.2).
 */
export function initializerToChars(i: Initializer): DString {
    const buf = new OutBuffer(); // hdrgen.d:214
    const hgs = new HdrGenState(); // hdrgen.d:215
    initializerToCBuffer(i, buf, hgs); // hdrgen.d:216 — `toCBuffer(i, buf, hgs)`, the Initializer overload
    return buf.extractChars(); // hdrgen.d:217
}

/**
 * dmd/hdrgen.d:220 — `public const(char)* toChars(const Type t)` (the Type overload of the D
 * `toChars` overload set, split by operand type in TS). Pretty-print a type the way diagnostics
 * spell it (`int`, `string`, `int[]`, …). `Type.toChars` (mtype.ts) forwards here, mirroring
 * mtype.d:611's `return dmd.hdrgen.toChars(this);`.
 */
export function typeToChars(t: Type): DString {
    const buf = new OutBuffer();
    buf.reserve(16);
    const hgs = new HdrGenState();
    hgs.fullQual = t.ty === TY.Tclass && !t.mod;
    typeToCBuffer(t, buf, null, hgs);
    return buf.extractChars();
}

/**
 * dmd/hdrgen.d:231 — `public const(char)* toChars(const Dsymbol d)`, the Dsymbol overload of D's
 * `toChars` set (04 §6.1 name) and the whole body of `Dsymbol.toChars()` (dsymbol.d:453). A template
 * declaration prints its signature (`foo(T)(int x)`), an instance or mixin its `name!(args)`, a
 * TypeInfo declaration `typeid(<type>)`; anything else its identifier through `toHChars2()` (so a
 * ctor is `this`), or `__anonymous` when it has none.
 *
 * Returns: a fresh `extractChars()` buffer (NUL-terminated) on the first four arms; on the last,
 * `toHChars2()`'s own string or the literal, shared and not to be mutated.
 * Registration (01 §4.4): this module registers this function into the dsymbol.ts-owned slot that
 * `Dsymbol.toChars` (dsymbol.d:453) reads (`registerDsymbolToChars`, at this module's end), because
 * dsymbol.ts cannot value-import this module (measured load break).
 */
export function dsymbolToChars(d: Dsymbol): DString {
    const td = d.isTemplateDeclaration();
    if (td) { // hdrgen.d:233
        const hgs = new HdrGenState(); // hdrgen.d:235
        const buf = new OutBuffer(); // hdrgen.d:236
        toCharsMaybeConstraints(td, buf, hgs); // hdrgen.d:237
        return buf.extractChars(); // hdrgen.d:238
    }

    const ti = d.isTemplateInstance();
    if (ti) { // hdrgen.d:241
        const buf = new OutBuffer(); // hdrgen.d:243
        toCBufferInstance(ti, buf); // hdrgen.d:244
        return buf.extractChars(); // hdrgen.d:245
    }

    const tm = d.isTemplateMixin();
    if (tm) { // hdrgen.d:248
        const buf = new OutBuffer(); // hdrgen.d:250
        toCBufferInstance(tm, buf); // hdrgen.d:251 — a TemplateMixin IS a TemplateInstance (upcast)
        return buf.extractChars(); // hdrgen.d:252
    }

    const tid = d.isTypeInfoDeclaration();
    if (tid) { // hdrgen.d:255
        const buf = new OutBuffer(); // hdrgen.d:257
        buf.writestring(ds("typeid(")); // hdrgen.d:258
        // hdrgen.d:259: `buf.put(const(char)*)` writes up to the NUL, and `toChars()` returns an
        // `extractChars()` result that carries it, hence `cstr` (02 §11.2).
        buf.writestring(cstr(tid.tinfo.toChars()));
        buf.writeByte(0x29); // ')' — hdrgen.d:260
        return buf.extractChars(); // hdrgen.d:261
    }

    return d.ident ? d.ident.toHChars2() : ds("__anonymous"); // hdrgen.d:264
}

/**
 * dmd/hdrgen.d:267 — `public const(char)[] toString(const Initializer i)`. Same text as
 * `initializerToChars`, returned as a SLICE (`extractSlice()`, no NUL terminator) instead of a C
 * string. D's name is a one-member `toString` set that 04 §6.1's table does not list; it takes the
 * table's receiver-prefix spelling, `initializerToString`.
 */
export function initializerToString(i: Initializer): DString {
    const buf = new OutBuffer(); // hdrgen.d:269
    const hgs = new HdrGenState(); // hdrgen.d:270
    initializerToCBuffer(i, buf, hgs); // hdrgen.d:271
    return buf.extractSlice(); // hdrgen.d:272
}

/**
 * dmd/hdrgen.d:282 — `void moduleToBuffer(ref OutBuffer buf, bool vcg_ast, Module m)`.
 * Dumps the full contents of module `m` to `buf` (the `-vcg-ast` / full-dump entry, main.d:864).
 * Params:
 *   buf = buffer to write to.
 *   vcg_ast = write out codegen ast
 *   m = module to visit all members of.
 *
 * The caller owns `buf.doindent` (main.d:863 sets it before the call); this function does not.
 */
export function moduleToBuffer(buf: OutBuffer, vcg_ast: boolean, m: Module): void {
    const hgs = new HdrGenState(); // hdrgen.d:284
    hgs.fullDump = true;
    hgs.vcg_ast = vcg_ast;
    // hdrgen.d:287 — `toCBuffer(m, buf, hgs)`, the Dsymbol overload. `as unknown as Dsymbol`: audited
    // upcast cascade (02 §11.5) of the `errors` field shadow — Module.errors (uint) over
    // Dsymbol.errors (bool); nothing is reinterpreted.
    dsymbolToCBuffer(m as unknown as Dsymbol, buf, hgs);
}

/**
 * dmd/hdrgen.d:290 — `void moduleToBuffer2(Module m, ref OutBuffer buf, ref HdrGenState hgs)`. The
 * body of the Dsymbol printer's `visitModule`: the module declaration (with its UDAs and
 * `deprecated(...)` prefix) when there is one, then every member through the Dsymbol printer.
 *
 * Preconditions: `m.members` is non-null (D iterates it untested, 02 §10.1 `!`).
 */
export function moduleToBuffer2(m: Module, buf: OutBuffer, hgs: HdrGenState): void {
    if (m.md) { // hdrgen.d:292
        // hdrgen.d:294 — `m.userAttribDecl` is the Dsymbol accessor (dsymbol.d), a method call here;
        // D evaluates it twice, and so does the port.
        if (m.userAttribDecl()) {
            buf.writestring(ds("@("));
            argsToBuffer(m.userAttribDecl()!.attsUda, buf, hgs); // hdrgen.d:297
            buf.writeByte(0x29); // ')'
            buf.writenl();
        }
        if (m.md.isdeprecated) { // hdrgen.d:301
            if (m.md.msg) {
                buf.writestring(ds("deprecated("));
                expressionToBuffer(m.md.msg, buf, hgs); // hdrgen.d:306 — UFCS (04 §6)
                buf.writestring(ds(") "));
            } else
                buf.writestring(ds("deprecated "));
        }
        buf.writestring(ds("module ")); // hdrgen.d:312
        // hdrgen.d:313 — `buf.put(m.md.toChars());`: `put(const(char)*)` writes up to the NUL that
        // `ModuleDeclaration.toChars()`'s `extractChars()` result carries, hence `cstr` (02 §11.2).
        buf.writestring(cstr(m.md.toChars()));
        buf.writeByte(0x3B); // ';'
        buf.writenl();
    }

    // hdrgen.d:318 — `foreach (s; *m.members)`; D calls through each slot untested (02 §10.1 `!`).
    const members = m.members!;
    for (let i = 0; i < members.length; i++) {
        dsymbolToBuffer(members.opIndex(i)!, buf, hgs); // hdrgen.d:320 — UFCS `s.dsymbolToBuffer(buf, hgs)`
    }
}

/**
 * dmd/hdrgen.d:324 — `private void statementToBuffer(Statement s, ref OutBuffer buf, ref HdrGenState`
 * `hgs)`. The per-statement printer: one nested visitor per statement kind, driven by the
 * `VisitStatement` mixin's dispatch (13 §7.6), inlined at the end of the function.
 *
 * Paired state (11 §2.5): every `buf.level++` … `buf.level--` region, and visitFor's
 * `hgs.forStmtInit` counter, is on the CALLER's objects and outlives a throw. D releases each with a
 * plain statement at region end and has no other exit, so that one statement moves into `finally` —
 * released once on the normal path, and also on a throw from a printer below (a wall in a callee).
 */
function statementToBuffer(s: Statement, buf: OutBuffer, hgs: HdrGenState): void {
    // The nested visitors keep D's own names and parameter names (`s`), which SHADOW this function's
    // `s` exactly as D's nested functions do (01 §2 identifier fidelity; 13 §7.6 rule 4).

    // hdrgen.d:326-330 — visitDefaultCase: D's "unrecognized statement" halt (a Peel statement lands
    // here, see the dispatch).
    const visitDefaultCase = (s: Statement): void => {
        // hdrgen.d:328 — `printf("Statement::toCBuffer() %d\n", s.stmt);` — C stdout, via the one format
        // shim (10 §3.5) and a single `process.stdout.write` (10 §4.4).
        process.stdout.write(dsToJs(dmdformat(ds("Statement::toCBuffer() %d\n"), [s.stmt])));
        assertUnreachable("unrecognized statement in statementToBuffer()"); // hdrgen.d:329 — D's own assert(0, …)
    };

    // hdrgen.d:332-336 — visitError
    const visitError = (_s: ErrorStatement): void => {
        buf.writestring(ds("__error__"));
        buf.writenl();
    };

    // hdrgen.d:338-352 — visitExp
    const visitExp = (s: ExpStatement): void => {
        // hdrgen.d:341 — `(cast(DeclarationExp)s.exp).declaration` under `s.exp.op == EXP.declaration`:
        // `isDeclarationExp()` tests that same op, so each `!` on it is the proven downcast.
        if (s.exp && s.exp.op === EXP.declaration &&
            s.exp.isDeclarationExp()!.declaration) {
            // bypass visit(DeclarationExp)
            dsymbolToBuffer(s.exp.isDeclarationExp()!.declaration!, buf, hgs); // hdrgen.d:344 — UFCS (04 §6)
            return;
        }
        if (s.exp) // hdrgen.d:347
            expressionToBuffer(s.exp, buf, hgs);
        buf.writeByte(0x3B); // ';'
        if (!hgs.forStmtInit) // hdrgen.d:350
            buf.writenl();
    };

    // hdrgen.d:354-357 — visitDtorExp: a DtorExpStatement IS an ExpStatement (upcast).
    const visitDtorExp = (s: DtorExpStatement): void => {
        visitExp(s);
    };

    // hdrgen.d:359-366 — visitMixin
    const visitMixin = (s: MixinStatement): void => {
        buf.writestring(ds("mixin("));
        argsToBuffer(s.exps, buf, hgs, null); // hdrgen.d:362
        buf.writestring(ds(");"));
        if (!hgs.forStmtInit) // hdrgen.d:364
            buf.writenl();
    };

    // hdrgen.d:368-375 — visitCompound; D iterates `*s.statements` untested (02 §10.1 `!`).
    const visitCompound = (s: CompoundStatement): void => {
        const statements = s.statements!;
        for (let i = 0; i < statements.length; i++) {
            const sx = statements.opIndex(i);
            if (sx) // hdrgen.d:372
                statementToBuffer(sx, buf, hgs); // UFCS `sx.statementToBuffer(buf, hgs)` (04 §6)
        }
    };

    // hdrgen.d:377-380 — visitCompoundAsm: a CompoundAsmStatement IS a CompoundStatement (upcast).
    const visitCompoundAsm = (s: CompoundAsmStatement): void => {
        visitCompound(s);
    };

    // hdrgen.d:382-403 — visitCompoundDeclaration: `T a = 1, b;` — the first variable in full, the
    // rest as `, name` (visitVarDecl's `anywritten`), then one `;`.
    const visitCompoundDeclaration = (s: CompoundDeclarationStatement): void => {
        let anywritten = false; // hdrgen.d:384
        const statements = s.statements!;
        for (let i = 0; i < statements.length; i++) {
            const sx = statements.opIndex(i);
            // ported: D local `ds` -> ds_ (01 §2: collides with the file-wide `ds` helper import)
            const ds_ = sx ? sx.isExpStatement() : null; // hdrgen.d:387
            if (ds_ && ds_.exp!.isDeclarationExp()) { // hdrgen.d:388 — D derefs `ds.exp` untested
                const d = ds_.exp!.isDeclarationExp()!.declaration!; // hdrgen.d:390
                const v = d.isVarDeclaration();
                if (v) { // hdrgen.d:391
                    visitVarDecl(v, anywritten, buf, hgs);
                } else
                    dsymbolToBuffer(d, buf, hgs); // hdrgen.d:396 — UFCS (04 §6)
                anywritten = true;
            }
        }
        buf.writeByte(0x3B); // ';' — hdrgen.d:400
        if (!hgs.forStmtInit)
            buf.writenl();
    };

    // hdrgen.d:405-418 — visitUnrolledLoop
    const visitUnrolledLoop = (s: UnrolledLoopStatement): void => {
        buf.writestring(ds("/*unrolled*/ {"));
        buf.writenl();
        buf.level++; // hdrgen.d:409
        try {
            const statements = s.statements!; // D iterates `*s.statements` untested
            for (let i = 0; i < statements.length; i++) {
                const sx = statements.opIndex(i);
                if (sx) // hdrgen.d:412
                    statementToBuffer(sx, buf, hgs);
            }
        } finally {
            buf.level--; // hdrgen.d:415
        }
        buf.writeByte(0x7D); // '}'
        buf.writenl();
    };

    // hdrgen.d:420-430 — visitScope
    const visitScope = (s: ScopeStatement): void => {
        buf.writeByte(0x7B); // '{'
        buf.writenl();
        buf.level++; // hdrgen.d:424
        try {
            if (s.statement)
                statementToBuffer(s.statement, buf, hgs); // hdrgen.d:426
        } finally {
            buf.level--; // hdrgen.d:427
        }
        buf.writeByte(0x7D); // '}'
        buf.writenl();
    };

    // hdrgen.d:432-449 — printConditionAssignment: the `auto x = ` / `T x = ` prefix of an
    // `if (auto x = …)`-style condition, then the condition.
    const printConditionAssignment = (p: Parameter | null, condition: Expression): void => {
        if (p) { // hdrgen.d:434
            // Print condition assignment
            let stc: STC = p.storageClass; // hdrgen.d:437
            if (!p.type && stc === STC.none) // hdrgen.d:438 — `!stc`, bigint-domain test (09 §9)
                stc = STC.auto_;
            if (stcToBuffer(buf, stc)) // hdrgen.d:440
                buf.writeByte(0x20); // ' '
            if (p.type) // hdrgen.d:442
                typeToBuffer(p.type, p.ident, buf, hgs);
            else
                buf.writestring(p.ident!.toString()); // hdrgen.d:445 — D derefs `ident` untested
            buf.writestring(ds(" = "));
        }
        expressionToBuffer(condition, buf, hgs); // hdrgen.d:448 — UFCS (04 §6)
    };

    // hdrgen.d:451-459 — visitWhile. D derefs `s.condition` untested (02 §10.1 `!`).
    const visitWhile = (s: WhileStatement): void => {
        buf.writestring(ds("while ("));
        printConditionAssignment(s.param, s.condition!); // hdrgen.d:454
        buf.writeByte(0x29); // ')'
        buf.writenl();
        if (s._body) // hdrgen.d:457
            statementToBuffer(s._body, buf, hgs);
    };

    // hdrgen.d:461-471 — visitDo
    const visitDo = (s: DoStatement): void => {
        buf.writestring(ds("do"));
        buf.writenl();
        if (s._body) // hdrgen.d:465
            statementToBuffer(s._body, buf, hgs);
        buf.writestring(ds("while ("));
        expressionToBuffer(s.condition!, buf, hgs); // hdrgen.d:468 — D derefs `condition` untested
        buf.writestring(ds(");"));
        buf.writenl();
    };

    // hdrgen.d:473-505 — visitFor. `hgs.forStmtInit` and `buf.level` are two paired regions, each
    // protected on its own (11 §2.5 rule (b)).
    const visitFor = (s: ForStatement): void => {
        buf.writestring(ds("for ("));
        if (s._init) { // hdrgen.d:476
            hgs.forStmtInit++; // hdrgen.d:478
            try {
                statementToBuffer(s._init, buf, hgs); // hdrgen.d:479
            } finally {
                hgs.forStmtInit--; // hdrgen.d:480
            }
        } else
            buf.writeByte(0x3B); // ';' — hdrgen.d:483
        if (s.condition) { // hdrgen.d:484
            buf.writeByte(0x20); // ' '
            expressionToBuffer(s.condition, buf, hgs);
        }
        buf.writeByte(0x3B); // ';' — hdrgen.d:489
        if (s.increment) { // hdrgen.d:490
            buf.writeByte(0x20); // ' '
            expressionToBuffer(s.increment, buf, hgs);
        }
        buf.writeByte(0x29); // ')' — hdrgen.d:495
        buf.writenl();
        buf.writeByte(0x7B); // '{'
        buf.writenl();
        buf.level++; // hdrgen.d:499
        try {
            if (s._body)
                statementToBuffer(s._body, buf, hgs); // hdrgen.d:501
        } finally {
            buf.level--; // hdrgen.d:502
        }
        buf.writeByte(0x7D); // '}'
        buf.writenl();
    };

    // hdrgen.d:507-526 — foreachWithoutBody: `foreach (<params>; <aggr>)`. D iterates
    // `*s.parameters` and derefs `s.aggr` untested (02 §10.1 `!`).
    const foreachWithoutBody = (s: ForeachStatement): void => {
        buf.writestring(Token.toStringValue(s.op)); // hdrgen.d:509 — `Token.toString(s.op)`
        buf.writestring(ds(" ("));
        const parameters = s.parameters!;
        for (let i = 0; i < parameters.length; i++) { // hdrgen.d:511 — `foreach (i, p; *s.parameters)`
            const p = parameters.opIndex(i)!;
            if (i) // hdrgen.d:513
                buf.writestring(ds(", "));
            if (stcToBuffer(buf, p.storageClass)) // hdrgen.d:515
                buf.writeByte(0x20); // ' '
            if (p.type) // hdrgen.d:517
                typeToBuffer(p.type, p.ident, buf, hgs);
            else
                buf.writestring(p.ident!.toString()); // hdrgen.d:520
        }
        buf.writestring(ds("; "));
        expressionToBuffer(s.aggr!, buf, hgs); // hdrgen.d:523
        buf.writeByte(0x29); // ')'
        buf.writenl();
    };

    // hdrgen.d:528-539 — visitForeach
    const visitForeach = (s: ForeachStatement): void => {
        foreachWithoutBody(s);
        buf.writeByte(0x7B); // '{'
        buf.writenl();
        buf.level++; // hdrgen.d:533
        try {
            if (s._body)
                statementToBuffer(s._body, buf, hgs); // hdrgen.d:535
        } finally {
            buf.level--; // hdrgen.d:536
        }
        buf.writeByte(0x7D); // '}'
        buf.writenl();
    };

    // hdrgen.d:541-555 — foreachRangeWithoutBody: `foreach (<param>; <lwr> .. <upr>)`. D derefs
    // `s.param`, `s.lwr` and `s.upr` untested (02 §10.1 `!`).
    const foreachRangeWithoutBody = (s: ForeachRangeStatement): void => {
        buf.writestring(Token.toStringValue(s.op)); // hdrgen.d:543
        buf.writestring(ds(" ("));
        const param = s.param!;
        if (param.type) // hdrgen.d:545
            typeToBuffer(param.type, param.ident, buf, hgs);
        else
            buf.writestring(param.ident!.toString()); // hdrgen.d:548
        buf.writestring(ds("; "));
        expressionToBuffer(s.lwr!, buf, hgs); // hdrgen.d:550
        buf.writestring(ds(" .. "));
        expressionToBuffer(s.upr!, buf, hgs); // hdrgen.d:552
        buf.writeByte(0x29); // ')'
        buf.writenl();
    };

    // hdrgen.d:557-568 — visitForeachRange
    const visitForeachRange = (s: ForeachRangeStatement): void => {
        foreachRangeWithoutBody(s);
        buf.writeByte(0x7B); // '{'
        buf.writenl();
        buf.level++; // hdrgen.d:562
        try {
            if (s._body)
                statementToBuffer(s._body, buf, hgs); // hdrgen.d:564
        } finally {
            buf.level--; // hdrgen.d:565
        }
        buf.writeByte(0x7D); // '}'
        buf.writenl();
    };

    // hdrgen.d:570-582 — visitStaticForeach: `static ` then the aggregate or range foreach, body
    // included. D derefs `s.sfe` untested (02 §10.1 `!`).
    const visitStaticForeach = (s: StaticForeachStatement): void => {
        buf.writestring(ds("static "));
        const sfe = s.sfe!;
        if (sfe.aggrfe) { // hdrgen.d:573
            visitForeach(sfe.aggrfe);
        } else {
            assert(sfe.rangefe !== null); // hdrgen.d:579 — D's own `assert(s.sfe.rangefe)`
            visitForeachRange(sfe.rangefe);
        }
    };

    // hdrgen.d:584-587 — visitForwarding
    const visitForwarding = (s: ForwardingStatement): void => {
        statementToBuffer(s.statement, buf, hgs); // hdrgen.d:586
    };

    // hdrgen.d:589-627 — visitIf. A scope-statement body prints at the current level (it brings its
    // own braces); any other body is indented one level. `else if` stays on one line. D derefs
    // `s.ifbody` and `s.condition` untested (02 §10.1 `!`).
    const visitIf = (s: IfStatement): void => {
        buf.writestring(ds("if ("));
        printConditionAssignment(s.param, s.condition!); // hdrgen.d:592
        buf.writeByte(0x29); // ')'
        buf.writenl();
        const ifbody = s.ifbody!;
        if (ifbody.isScopeStatement()) { // hdrgen.d:595
            statementToBuffer(ifbody, buf, hgs);
        } else {
            buf.level++; // hdrgen.d:601
            try {
                statementToBuffer(ifbody, buf, hgs); // hdrgen.d:602
            } finally {
                buf.level--; // hdrgen.d:603
            }
        }
        if (s.elsebody) { // hdrgen.d:605
            buf.writestring(ds("else"));
            if (!s.elsebody.isIfStatement()) { // hdrgen.d:608
                buf.writenl();
            } else {
                buf.writeByte(0x20); // ' '
            }
            if (s.elsebody.isScopeStatement() || s.elsebody.isIfStatement()) { // hdrgen.d:616
                statementToBuffer(s.elsebody, buf, hgs);
            } else {
                buf.level++; // hdrgen.d:622
                try {
                    statementToBuffer(s.elsebody, buf, hgs); // hdrgen.d:623
                } finally {
                    buf.level--; // hdrgen.d:624
                }
            }
        }
    };

    // hdrgen.d:629-653 — visitConditional: `version (X)` / `debug` / `static if (…)` inside a body.
    // D derefs `s.condition` untested (02 §10.1 `!`).
    const visitConditional = (s: ConditionalStatement): void => {
        conditionToBuffer(s.condition!, buf, hgs); // hdrgen.d:631 — UFCS (04 §6)
        buf.writenl();
        buf.writeByte(0x7B); // '{'
        buf.writenl();
        buf.level++; // hdrgen.d:635
        try {
            if (s.ifbody)
                statementToBuffer(s.ifbody, buf, hgs); // hdrgen.d:637
        } finally {
            buf.level--; // hdrgen.d:638
        }
        buf.writeByte(0x7D); // '}'
        buf.writenl();
        if (s.elsebody) { // hdrgen.d:641
            buf.writestring(ds("else"));
            buf.writenl();
            buf.writeByte(0x7B); // '{'
            buf.level++; // hdrgen.d:646 — D raises the level BEFORE the newline here
            try {
                buf.writenl();
                statementToBuffer(s.elsebody, buf, hgs); // hdrgen.d:648
            } finally {
                buf.level--; // hdrgen.d:649
            }
            buf.writeByte(0x7D); // '}'
        }
        buf.writenl(); // hdrgen.d:652
    };

    // hdrgen.d:655-681 — visitPragma. D derefs `s.ident` untested (02 §10.1 `!`).
    const visitPragma = (s: PragmaStatement): void => {
        buf.writestring(ds("pragma ("));
        buf.writestring(s.ident!.toString()); // hdrgen.d:658
        if (s.args && s.args.length) { // hdrgen.d:659
            buf.writestring(ds(", "));
            argsToBuffer(s.args, buf, hgs); // hdrgen.d:662
        }
        buf.writeByte(0x29); // ')'
        if (s._body) { // hdrgen.d:665
            buf.writenl();
            buf.writeByte(0x7B); // '{'
            buf.writenl();
            buf.level++; // hdrgen.d:670
            try {
                statementToBuffer(s._body, buf, hgs); // hdrgen.d:671
            } finally {
                buf.level--; // hdrgen.d:672
            }
            buf.writeByte(0x7D); // '}'
            buf.writenl();
        } else {
            buf.writeByte(0x3B); // ';' — hdrgen.d:678
            buf.writenl();
        }
    };

    // hdrgen.d:683-686 — visitStaticAssert; D derefs `s.sa` untested (02 §10.1 `!`).
    const visitStaticAssert = (s: StaticAssertStatement): void => {
        dsymbolToBuffer(s.sa!, buf, hgs); // hdrgen.d:685 — UFCS `s.sa.dsymbolToBuffer(buf, hgs)` (04 §6)
    };

    // hdrgen.d:688-711 — visitSwitch: a non-scope body is wrapped in braces here.
    const visitSwitch = (s: SwitchStatement): void => {
        buf.writestring(s.isFinal ? ds("final switch (") : ds("switch ("));
        printConditionAssignment(s.param, s.condition!); // hdrgen.d:691 — D derefs `condition` untested
        buf.writeByte(0x29); // ')'
        buf.writenl();
        if (s._body) { // hdrgen.d:694
            if (!s._body.isScopeStatement()) { // hdrgen.d:696
                buf.writeByte(0x7B); // '{'
                buf.writenl();
                buf.level++; // hdrgen.d:700
                try {
                    statementToBuffer(s._body, buf, hgs); // hdrgen.d:701
                } finally {
                    buf.level--; // hdrgen.d:702
                }
                buf.writeByte(0x7D); // '}'
                buf.writenl();
            } else {
                statementToBuffer(s._body, buf, hgs); // hdrgen.d:708
            }
        }
    };

    // hdrgen.d:713-720 — visitCase. D derefs `s.exp` and `s.statement` untested (02 §10.1 `!`).
    const visitCase = (s: CaseStatement): void => {
        buf.writestring(ds("case "));
        expressionToBuffer(s.exp!, buf, hgs); // hdrgen.d:716
        buf.writeByte(0x3A); // ':'
        buf.writenl();
        statementToBuffer(s.statement!, buf, hgs); // hdrgen.d:719
    };

    // hdrgen.d:722-731 — visitCaseRange. D's `last` field is `last_` in the port (statement.ts).
    const visitCaseRange = (s: CaseRangeStatement): void => {
        buf.writestring(ds("case "));
        expressionToBuffer(s.first!, buf, hgs); // hdrgen.d:725
        buf.writestring(ds(": .. case "));
        expressionToBuffer(s.last_!, buf, hgs); // hdrgen.d:727
        buf.writeByte(0x3A); // ':'
        buf.writenl();
        statementToBuffer(s.statement!, buf, hgs); // hdrgen.d:730
    };

    // hdrgen.d:733-738 — visitDefault
    const visitDefault = (s: DefaultStatement): void => {
        buf.writestring(ds("default:"));
        buf.writenl();
        statementToBuffer(s.statement!, buf, hgs); // hdrgen.d:737 — D derefs `statement` untested
    };

    // hdrgen.d:740-744 — visitGotoDefault
    const visitGotoDefault = (_s: GotoDefaultStatement): void => {
        buf.writestring(ds("goto default;"));
        buf.writenl();
    };

    // hdrgen.d:746-756 — visitGotoCase
    const visitGotoCase = (s: GotoCaseStatement): void => {
        buf.writestring(ds("goto case"));
        if (s.exp) { // hdrgen.d:749
            buf.writeByte(0x20); // ' '
            expressionToBuffer(s.exp, buf, hgs);
        }
        buf.writeByte(0x3B); // ';'
        buf.writenl();
    };

    // hdrgen.d:758-762 — visitSwitchError
    const visitSwitchError = (_s: SwitchErrorStatement): void => {
        buf.writestring(ds("SwitchErrorStatement::toCBuffer()"));
        buf.writenl();
    };

    // hdrgen.d:764-771 — visitReturn
    const visitReturn = (s: ReturnStatement): void => {
        buf.writestring(ds("return "));
        if (s.exp) // hdrgen.d:767
            expressionToBuffer(s.exp, buf, hgs);
        buf.writeByte(0x3B); // ';'
        buf.writenl();
    };

    // hdrgen.d:773-783 — visitBreak
    const visitBreak = (s: BreakStatement): void => {
        buf.writestring(ds("break"));
        if (s.ident) { // hdrgen.d:776
            buf.writeByte(0x20); // ' '
            buf.writestring(s.ident.toString());
        }
        buf.writeByte(0x3B); // ';'
        buf.writenl();
    };

    // hdrgen.d:785-795 — visitContinue
    const visitContinue = (s: ContinueStatement): void => {
        buf.writestring(ds("continue"));
        if (s.ident) { // hdrgen.d:788
            buf.writeByte(0x20); // ' '
            buf.writestring(s.ident.toString());
        }
        buf.writeByte(0x3B); // ';'
        buf.writenl();
    };

    // hdrgen.d:797-811 — visitSynchronized
    const visitSynchronized = (s: SynchronizedStatement): void => {
        buf.writestring(ds("synchronized"));
        if (s.exp) { // hdrgen.d:800
            buf.writeByte(0x28); // '('
            expressionToBuffer(s.exp, buf, hgs);
            buf.writeByte(0x29); // ')'
        }
        if (s._body) { // hdrgen.d:806
            buf.writeByte(0x20); // ' '
            statementToBuffer(s._body, buf, hgs);
        }
    };

    // hdrgen.d:813-821 — visitWith. D derefs `s.exp` untested (02 §10.1 `!`).
    const visitWith = (s: WithStatement): void => {
        buf.writestring(ds("with ("));
        expressionToBuffer(s.exp!, buf, hgs); // hdrgen.d:816
        buf.writestring(ds(")"));
        buf.writenl();
        if (s._body) // hdrgen.d:819
            statementToBuffer(s._body, buf, hgs);
    };

    // hdrgen.d:823-859 — visitTryCatch. D iterates `*s.catches` untested (02 §10.1 `!`).
    const visitTryCatch = (s: TryCatchStatement): void => {
        buf.writestring(ds("try"));
        buf.writenl();
        if (s._body) { // hdrgen.d:827
            if (s._body.isScopeStatement()) { // hdrgen.d:829
                statementToBuffer(s._body, buf, hgs);
            } else {
                buf.level++; // hdrgen.d:835
                try {
                    statementToBuffer(s._body, buf, hgs); // hdrgen.d:836
                } finally {
                    buf.level--; // hdrgen.d:837
                }
            }
        }
        // hdrgen.d:840 — `foreach (c; *s.catches)`; `Catch` is a class, each slot called through.
        const catches = s.catches!;
        for (let i = 0; i < catches.length; i++) {
            const c = catches.opIndex(i)!;
            buf.writestring(ds("catch"));
            if (c.type) { // hdrgen.d:843
                buf.writeByte(0x28); // '('
                typeToBuffer(c.type, c.ident, buf, hgs); // hdrgen.d:846
                buf.writeByte(0x29); // ')'
            }
            buf.writenl();
            buf.writeByte(0x7B); // '{'
            buf.writenl();
            buf.level++; // hdrgen.d:852
            try {
                if (c.handler)
                    statementToBuffer(c.handler, buf, hgs); // hdrgen.d:854
            } finally {
                buf.level--; // hdrgen.d:855
            }
            buf.writeByte(0x7D); // '}'
            buf.writenl();
        }
    };

    // hdrgen.d:861-884 — visitTryFinally. D derefs `s._body` and `s.finalbody` untested (02 §10.1 `!`).
    const visitTryFinally = (s: TryFinallyStatement): void => {
        buf.writestring(ds("try"));
        buf.writenl();
        buf.writeByte(0x7B); // '{'
        buf.writenl();
        buf.level++; // hdrgen.d:867
        try {
            statementToBuffer(s._body!, buf, hgs); // hdrgen.d:868
        } finally {
            buf.level--; // hdrgen.d:869
        }
        buf.writeByte(0x7D); // '}'
        buf.writenl();
        buf.writestring(ds("finally"));
        buf.writenl();
        const finalbody = s.finalbody!;
        if (finalbody.isScopeStatement()) { // hdrgen.d:874
            statementToBuffer(finalbody, buf, hgs);
        } else {
            buf.level++; // hdrgen.d:880
            try {
                statementToBuffer(finalbody, buf, hgs); // hdrgen.d:881
            } finally {
                buf.level--; // hdrgen.d:882
            }
        }
    };

    // hdrgen.d:886-892 — visitScopeGuard: `scope(exit)` / `scope(failure)` / `scope(success)` — the
    // token spelling, then the guarded statement on the same line.
    const visitScopeGuard = (s: ScopeGuardStatement): void => {
        buf.writestring(Token.toStringValue(s.tok)); // hdrgen.d:888 — `Token.toString(s.tok)`
        buf.writeByte(0x20); // ' '
        if (s.statement) // hdrgen.d:890
            statementToBuffer(s.statement, buf, hgs);
    };

    // hdrgen.d:894-900 — visitThrow. D derefs `s.exp` untested (02 §10.1 `!`).
    const visitThrow = (s: ThrowStatement): void => {
        buf.writestring(ds("throw "));
        expressionToBuffer(s.exp!, buf, hgs); // hdrgen.d:897
        buf.writeByte(0x3B); // ';'
        buf.writenl();
    };

    // hdrgen.d:902-908 — visitDebug
    const visitDebug = (s: DebugStatement): void => {
        if (s.statement) { // hdrgen.d:904
            statementToBuffer(s.statement, buf, hgs);
        }
    };

    // hdrgen.d:910-916 — visitGoto. D derefs `s.ident` untested (02 §10.1 `!`).
    const visitGoto = (s: GotoStatement): void => {
        buf.writestring(ds("goto "));
        buf.writestring(s.ident!.toString()); // hdrgen.d:913
        buf.writeByte(0x3B); // ';'
        buf.writenl();
    };

    // hdrgen.d:918-925 — visitLabel
    const visitLabel = (s: LabelStatement): void => {
        buf.writestring(s.ident!.toString()); // hdrgen.d:920 — D derefs `ident` untested
        buf.writeByte(0x3A); // ':'
        buf.writenl();
        if (s.statement) // hdrgen.d:923
            statementToBuffer(s.statement, buf, hgs);
    };

    // hdrgen.d:927-951 — visitAsm: the token list, space-separated except around `-`, `,`, `[`, `]`,
    // `(`, `)` and `.`.
    const visitAsm = (s: AsmStatement): void => {
        buf.writestring(ds("asm { "));
        let t: Token | null = s.tokens; // hdrgen.d:930
        buf.level++; // hdrgen.d:931
        try {
            while (t) { // hdrgen.d:932
                buf.writestring(t.toString()); // hdrgen.d:934
                if (t.next &&
                    t.value !== TOK.min &&
                    t.value !== TOK.comma && t.next.value !== TOK.comma &&
                    t.value !== TOK.leftBracket && t.next.value !== TOK.leftBracket &&
                    t.next.value !== TOK.rightBracket &&
                    t.value !== TOK.leftParenthesis && t.next.value !== TOK.leftParenthesis &&
                    t.next.value !== TOK.rightParenthesis &&
                    t.value !== TOK.dot && t.next.value !== TOK.dot) { // hdrgen.d:935-942
                    buf.writeByte(0x20); // ' '
                }
                t = t.next; // hdrgen.d:946
            }
        } finally {
            buf.level--; // hdrgen.d:948
        }
        buf.writestring(ds("; }"));
        buf.writenl();
    };

    // hdrgen.d:953-956 — visitInlineAsm: an InlineAsmStatement IS an AsmStatement (upcast).
    const visitInlineAsm = (s: InlineAsmStatement): void => {
        visitAsm(s);
    };

    // hdrgen.d:958-961 — visitGccAsm: a GccAsmStatement IS an AsmStatement (upcast).
    const visitGccAsm = (s: GccAsmStatement): void => {
        visitAsm(s);
    };

    // hdrgen.d:963-969 — visitImport. D iterates `*s.imports` untested (02 §10.1 `!`).
    const visitImport = (s: ImportStatement): void => {
        const imports = s.imports!;
        for (let i = 0; i < imports.length; i++) {
            dsymbolToBuffer(imports.opIndex(i)!, buf, hgs); // hdrgen.d:967 — UFCS `imp.dsymbolToBuffer(buf, hgs)`
        }
    };

    // hdrgen.d:971-972 — `mixin VisitStatement!void visit;` + `visit.VisitStatement(s);`.
    // resolved: mixin VisitStatement!void + visitStmtCase (dmd/statement.d:1981) -> inlined dispatch
    // switch, ALL 44 arms (13 §7.6). The generator's `__traits(compiles, visitXxx(sx))` probe selects
    // the handler NAMED for the arm; an arm with no such handler here routes to visitDefaultCase —
    // exactly one: STMT.Peel (no `visitPeel` in this function). Every other arm has its own handler,
    // including CompoundDeclaration, CompoundAsm, InlineAsm and GccAsm.
    switch (s.stmt) {
        case STMT.Error:               visitError(s.isErrorStatement()!); break;
        case STMT.Scope:               visitScope(s.isScopeStatement()!); break;
        case STMT.Exp:                 visitExp(s.isExpStatement()!); break;
        case STMT.Compound:            visitCompound(s.isCompoundStatement()!); break;
        case STMT.Return:              visitReturn(s.isReturnStatement()!); break;
        case STMT.If:                  visitIf(s.isIfStatement()!); break;
        case STMT.Conditional:         visitConditional(s.isConditionalStatement()!); break;
        case STMT.StaticForeach:       visitStaticForeach(s.isStaticForeachStatement()!); break;
        case STMT.Case:                visitCase(s.isCaseStatement()!); break;
        case STMT.Default:             visitDefault(s.isDefaultStatement()!); break;
        case STMT.Label:               visitLabel(s.isLabelStatement()!); break;
        case STMT.Goto:                visitGoto(s.isGotoStatement()!); break;
        case STMT.GotoDefault:         visitGotoDefault(s.isGotoDefaultStatement()!); break;
        case STMT.GotoCase:            visitGotoCase(s.isGotoCaseStatement()!); break;
        case STMT.Break:               visitBreak(s.isBreakStatement()!); break;
        case STMT.DtorExp:             visitDtorExp(s.isDtorExpStatement()!); break;
        case STMT.Mixin:               visitMixin(s.isMixinStatement()!); break;
        case STMT.Forwarding:          visitForwarding(s.isForwardingStatement()!); break;
        case STMT.Do:                  visitDo(s.isDoStatement()!); break;
        case STMT.While:               visitWhile(s.isWhileStatement()!); break;
        case STMT.For:                 visitFor(s.isForStatement()!); break;
        case STMT.Foreach:             visitForeach(s.isForeachStatement()!); break;
        case STMT.Switch:              visitSwitch(s.isSwitchStatement()!); break;
        case STMT.Continue:            visitContinue(s.isContinueStatement()!); break;
        case STMT.With:                visitWith(s.isWithStatement()!); break;
        case STMT.TryCatch:            visitTryCatch(s.isTryCatchStatement()!); break;
        case STMT.Throw:               visitThrow(s.isThrowStatement()!); break;
        case STMT.Debug:               visitDebug(s.isDebugStatement()!); break;
        case STMT.TryFinally:          visitTryFinally(s.isTryFinallyStatement()!); break;
        case STMT.ScopeGuard:          visitScopeGuard(s.isScopeGuardStatement()!); break;
        case STMT.SwitchError:         visitSwitchError(s.isSwitchErrorStatement()!); break;
        case STMT.UnrolledLoop:        visitUnrolledLoop(s.isUnrolledLoopStatement()!); break;
        case STMT.ForeachRange:        visitForeachRange(s.isForeachRangeStatement()!); break;
        case STMT.CompoundDeclaration: visitCompoundDeclaration(s.isCompoundDeclarationStatement()!); break;
        case STMT.Peel:                visitDefaultCase(s.isPeelStatement()!); break;
        case STMT.CompoundAsm:         visitCompoundAsm(s.isCompoundAsmStatement()!); break;
        case STMT.Pragma:              visitPragma(s.isPragmaStatement()!); break;
        case STMT.StaticAssert:        visitStaticAssert(s.isStaticAssertStatement()!); break;
        case STMT.CaseRange:           visitCaseRange(s.isCaseRangeStatement()!); break;
        case STMT.Synchronized:        visitSynchronized(s.isSynchronizedStatement()!); break;
        case STMT.Asm:                 visitAsm(s.isAsmStatement()!); break;
        case STMT.InlineAsm:           visitInlineAsm(s.isInlineAsmStatement()!); break;
        case STMT.GccAsm:              visitGccAsm(s.isGccAsmStatement()!); break;
        case STMT.Import:              visitImport(s.isImportStatement()!); break;
        default: { const _e: never = s.stmt; throw new SwitchError(_e); }   // D `final switch` (06 §3.2)
    }
}

/**
 * dmd/hdrgen.d:975 — `private void dsymbolToBuffer(Dsymbol s, ref OutBuffer buf, ref HdrGenState hgs)`.
 * The module-private name the printers call a Dsymbol through (by UFCS, `s.dsymbolToBuffer(buf, hgs)`);
 * a thin forward to `dsymbolToCBuffer`.
 */
function dsymbolToBuffer(s: Dsymbol, buf: OutBuffer, hgs: HdrGenState): void {
    dsymbolToCBuffer(s, buf, hgs); // hdrgen.d:977 — `toCBuffer(s, buf, hgs)`, the Dsymbol overload
}

/**
 * dmd/hdrgen.d:980 — `void toCBuffer(Dsymbol s, ref OutBuffer buf, ref HdrGenState hgs)`, the Dsymbol
 * overload of D's `toCBuffer` set (04 §6.1 name). The Dsymbol printer: declarations, aggregates,
 * templates, attribute blocks, functions (with contracts and bodies through the statement printer)
 * and whole modules, as D source. Header mode (`hgs.hdrgen`), full-dump / `-vcg-ast` mode
 * (`hgs.fullDump` / `hgs.vcg_ast`), Ddoc and error-message mode each steer the output.
 *
 * IDIOM A (13 §7): D declares nested functions `visitXxx` and a nested `extern (C++) final class
 * DsymbolPrettyPrintVisitor : Visitor` whose 41 `visit` overrides forward to them; the class is emitted
 * as a function-local TS class (it closes over `buf` / `hgs` through the nested functions, as D's
 * does), each `visit(X)` renamed `visitX` (13 §1) and dispatched by the symbol's own `accept` (13 §2).
 * Inside a method the bare name `visitX` is the enclosing nested function, never the method itself
 * (TS class members are not in lexical scope), which is D's own resolution.
 *
 * Paired state (11 §2.5): `buf.level`, the `hgs` counters `tpltMember` / `autoMember` /
 * `insideFuncBody` / `insideAggregate`, the saved-and-restored `hgs.doFuncBodies` and
 * `hgs.inEnumDecl`, and the set-then-reset `hgs.declstring` / `hgs.inCAlias` all live on the
 * caller's objects. D releases each with a plain statement at region end (or a `scope(exit)`), so
 * the release moves into (or already is) a `finally`, each pair protected on its own.
 */
export function dsymbolToCBuffer(s: Dsymbol, buf: OutBuffer, hgs: HdrGenState): void {
    // The nested visitors keep D's own names and parameter names, which SHADOW this function's `s`
    // exactly as D's nested functions do (01 §2 identifier fidelity). A parameter the body never
    // reads takes the `_` prefix (`noUnusedParameters`). D's recursive `toCBuffer(x, buf, hgs)` calls
    // resolve by the argument's static type: a Dsymbol to this function, an Expression to `expToCBuffer`.

    // hdrgen.d:982-985 — visitDsymbol. `put(const(char)*)` stops at the NUL that `toChars()`'s
    // `extractChars()` result may carry (02 §11.2), hence `cstr`.
    const visitDsymbol = (s: Dsymbol): void => {
        buf.writestring(cstr(s.toChars()));
    };

    // hdrgen.d:987-1002 — visitStaticAssert: `static assert(<exp>, <msgs>…);`. D derefs `s.exp`
    // untested (02 §10.1 `!`).
    const visitStaticAssert = (s: StaticAssert): void => {
        buf.writestring(s.kind()); // hdrgen.d:989
        buf.writeByte(0x28); // '('
        expressionToBuffer(s.exp!, buf, hgs); // hdrgen.d:991 — UFCS (04 §6)
        if (s.msgs) { // hdrgen.d:992
            // hdrgen.d:994 — `foreach (m; (*s.msgs)[])`; each element is called through (02 §10.1 `!`).
            for (let i = 0; i < s.msgs.length; i++) {
                buf.writestring(ds(", "));
                expressionToBuffer(s.msgs.opIndex(i)!, buf, hgs); // hdrgen.d:997
            }
        }
        buf.writestring(ds(");"));
        buf.writenl();
    };

    // hdrgen.d:1004-1010 — visitDebugSymbol. D derefs `s.ident` untested (02 §10.1 `!`).
    const visitDebugSymbol = (s: DebugSymbol): void => {
        buf.writestring(ds("debug = "));
        buf.writestring(s.ident!.toString()); // hdrgen.d:1007
        buf.writeByte(0x3B); // ';'
        buf.writenl();
    };

    // hdrgen.d:1012-1018 — visitVersionSymbol
    const visitVersionSymbol = (s: VersionSymbol): void => {
        buf.writestring(ds("version = "));
        buf.writestring(s.ident!.toString()); // hdrgen.d:1015
        buf.writeByte(0x3B); // ';'
        buf.writenl();
    };

    // hdrgen.d:1020-1031 — visitEnumMember: `[T ]name[ = value]`, no trailing separator (the enum
    // printer adds `,`).
    const visitEnumMember = (em: EnumMember): void => {
        if (em.type) // hdrgen.d:1022
            typeToBuffer(em.type, em.ident, buf, hgs);
        else
            buf.writestring(em.ident!.toString()); // hdrgen.d:1025 — D derefs `ident` untested
        if (em.value) { // hdrgen.d:1026
            buf.writestring(ds(" = "));
            expressionToBuffer(em.value, buf, hgs); // hdrgen.d:1029
        }
    };

    // hdrgen.d:1033-1066 — visitImport: `[static ]import [alias = ]pkg.mod[ : a, b = c];`. In header
    // mode the implicit `import object;` is skipped.
    const visitImport = (imp: Import): void => {
        if (hgs.hdrgen && imp.id === Id.object) // hdrgen.d:1035 — Identifier `==` is identity
            return; // object is imported by default
        if (imp.isstatic) // hdrgen.d:1037
            buf.writestring(ds("static "));
        buf.writestring(ds("import "));
        if (imp.aliasId) { // hdrgen.d:1040
            buf.printf(ds("%s = "), imp.aliasId.toChars()); // hdrgen.d:1042
        }
        // hdrgen.d:1044 — `foreach (const pid; imp.packages)`: a D slice, empty when null.
        const packages = imp.packages ?? [];
        for (const pid of packages) {
            buf.write(pid.toString()); // hdrgen.d:1046
            buf.writeByte(0x2E); // '.'
        }
        buf.writestring(imp.id!.toString()); // hdrgen.d:1049 — D derefs `id` untested
        if (imp.names.length) { // hdrgen.d:1050
            buf.writestring(ds(" : "));
            // hdrgen.d:1053 — `foreach (const i, const name; imp.names)`
            for (let i = 0; i < imp.names.length; i++) {
                const name = imp.names.opIndex(i)!;
                if (i) // hdrgen.d:1055
                    buf.writestring(ds(", "));
                const _alias = imp.aliases.opIndex(i); // hdrgen.d:1057
                if (_alias)
                    buf.printf(ds("%s = %s"), _alias.toChars(), name.toChars()); // hdrgen.d:1059
                else
                    buf.writestring(name.toChars()); // hdrgen.d:1061 — Identifier.toChars carries no NUL
            }
        }
        buf.writeByte(0x3B); // ';' — hdrgen.d:1064
        buf.writenl();
    };

    // hdrgen.d:1068-1073 — visitAliasThis: note the literal `\n`, not `writenl()`.
    const visitAliasThis = (d: AliasThis): void => {
        buf.writestring(ds("alias "));
        // hdrgen.d:1071 — `d.ident` through an AliasThis reference: the DERIVED slot (02 §11.5b), deref untested
        buf.writestring(d.identAlias!.toString());
        buf.writestring(ds(" this;\n"));
    };

    // hdrgen.d:1075-1113 — visitAttribDeclaration: the storage classes (for a
    // StorageClassDeclaration), then `;`, `{}`, the single member inline, or a braced block.
    const visitAttribDeclaration = (d: AttribDeclaration): void => {
        let hasSTC = false; // hdrgen.d:1077 — `bool hasSTC;` (`.init` false)
        const stcd = d.isStorageClassDeclaration();
        if (stcd) { // hdrgen.d:1078
            hasSTC = stcToBuffer(buf, stcd.stc);
        }

        if (!d.decl) { // hdrgen.d:1083
            buf.writeByte(0x3B); // ';'
            buf.writenl();
            return;
        }
        // hdrgen.d:1089 — a member slot is called through untested (02 §10.1 `!`).
        if (d.decl.length === 0 || (hgs.hdrgen && d.decl.length === 1 && d.decl.opIndex(0)!.isUnitTestDeclaration())) {
            // hack for https://issues.dlang.org/show_bug.cgi?id=8081
            if (hasSTC) buf.writeByte(0x20); // ' '
            buf.writestring(ds("{}"));
        } else if (d.decl.length === 1) { // hdrgen.d:1095
            if (hasSTC) buf.writeByte(0x20); // ' '
            dsymbolToCBuffer(d.decl.opIndex(0)!, buf, hgs); // hdrgen.d:1098
            return;
        } else {
            buf.writenl();
            buf.writeByte(0x7B); // '{'
            buf.writenl();
            buf.level++; // hdrgen.d:1106
            try {
                // hdrgen.d:1107 — `foreach (de; *d.decl)`
                for (let i = 0; i < d.decl.length; i++)
                    dsymbolToCBuffer(d.decl.opIndex(i)!, buf, hgs);
            } finally {
                buf.level--; // hdrgen.d:1109
            }
            buf.writeByte(0x7D); // '}'
        }
        buf.writenl(); // hdrgen.d:1112
    };

    // hdrgen.d:1115-1118 — visitStorageClassDeclaration (upcast to the attribute printer).
    const visitStorageClassDeclaration = (d: StorageClassDeclaration): void => {
        visitAttribDeclaration(d);
    };

    // hdrgen.d:1120-1126 — visitDeprecatedDeclaration. D derefs `d.msg` untested (02 §10.1 `!`).
    const visitDeprecatedDeclaration = (d: DeprecatedDeclaration): void => {
        buf.writestring(ds("deprecated("));
        expressionToBuffer(d.msg!, buf, hgs); // hdrgen.d:1123
        buf.writestring(ds(") "));
        visitAttribDeclaration(d);
    };

    // hdrgen.d:1128-1134 — visitLinkDeclaration
    const visitLinkDeclaration = (d: LinkDeclaration): void => {
        buf.writestring(ds("extern ("));
        buf.writestring(linkageToString(d.linkage)); // hdrgen.d:1131
        buf.writestring(ds(") "));
        visitAttribDeclaration(d);
    };

    // hdrgen.d:1136-1154 — visitCPPMangleDeclaration. `final switch` emitted in full with a
    // SwitchError default (06 §3.2); D's `string s;` starts null, which `put` writes as nothing.
    const visitCPPMangleDeclaration = (d: CPPMangleDeclaration): void => {
        let s: DString = dsEmpty; // hdrgen.d:1138
        switch (d.cppmangle) {
            case CPPMANGLE.asClass: // hdrgen.d:1141
                s = ds("class");
                break;
            case CPPMANGLE.asStruct: // hdrgen.d:1144
                s = ds("struct");
                break;
            case CPPMANGLE.def: // hdrgen.d:1147
                break;
            default: { const _e: never = d.cppmangle; throw new SwitchError(_e); } // D `final switch`
        }
        buf.writestring(ds("extern (C++, "));
        buf.writestring(s); // hdrgen.d:1151
        buf.writestring(ds(") "));
        visitAttribDeclaration(d);
    };

    // hdrgen.d:1156-1166 — visitVisibilityDeclaration. A single nested visibility declaration is
    // printed through the ATTRIBUTE printer (so its own keyword is not repeated). D reads
    // `ad.decl.length` untested (02 §10.1 `!`).
    const visitVisibilityDeclaration = (d: VisibilityDeclaration): void => {
        visibilityToBuffer(buf, d.visibility); // hdrgen.d:1158
        const ad: AttribDeclaration = d; // hdrgen.d:1159 — `cast(AttribDeclaration)d`, an upcast
        if (ad.decl!.length <= 1) // hdrgen.d:1160
            buf.writeByte(0x20); // ' '
        if (ad.decl!.length === 1 && ad.decl!.opIndex(0)!.isVisibilityDeclaration()) // hdrgen.d:1162
            visitAttribDeclaration(ad.decl!.opIndex(0)!.isVisibilityDeclaration()!);
        else
            visitAttribDeclaration(d); // hdrgen.d:1165
    };

    // hdrgen.d:1168-1187 — visitAlignDeclaration
    const visitAlignDeclaration = (d: AlignDeclaration): void => {
        if (d.exps) { // hdrgen.d:1170
            // hdrgen.d:1172 — `foreach (i, exp; (*d.exps)[])`
            for (let i = 0; i < d.exps.length; i++) {
                const exp = d.exps.opIndex(i);
                if (i) // hdrgen.d:1174
                    buf.writeByte(0x20); // ' '
                buf.writestring(ds("align ("));
                expToCBuffer(exp!, buf, hgs); // hdrgen.d:1177 — `toCBuffer(exp, buf, hgs)`, the Expression overload
                buf.writeByte(0x29); // ')'
            }
            if (d.decl && d.decl.length < 2) // hdrgen.d:1180
                buf.writeByte(0x20); // ' '
        } else
            buf.writestring(ds("align ")); // hdrgen.d:1184

        visitAttribDeclaration(d.isAttribDeclaration()!); // hdrgen.d:1186 — `d.isAttribDeclaration()` is `d`
    };

    // hdrgen.d:1189-1204 — visitAnonDeclaration
    const visitAnonDeclaration = (d: AnonDeclaration): void => {
        buf.writestring(d.isunion ? ds("union") : ds("struct"));
        buf.writenl();
        buf.writestring(ds("{"));
        buf.writenl();
        buf.level++; // hdrgen.d:1195
        try {
            if (d.decl) { // hdrgen.d:1196
                for (let i = 0; i < d.decl.length; i++)
                    dsymbolToCBuffer(d.decl.opIndex(i)!, buf, hgs); // hdrgen.d:1199
            }
        } finally {
            buf.level--; // hdrgen.d:1201
        }
        buf.writestring(ds("}"));
        buf.writenl();
    };

    // hdrgen.d:1206-1227 — visitPragmaDeclaration. `hgs.doFuncBodies` is saved and restored around
    // the attribute printer: a restore is a release (11 §2.5), so it moves into `finally`.
    const visitPragmaDeclaration = (d: PragmaDeclaration): void => {
        buf.writestring(ds("pragma ("));
        buf.writestring(d.ident!.toString()); // hdrgen.d:1209 — D derefs `ident` untested
        if (d.args && d.args.length) { // hdrgen.d:1210
            buf.writestring(ds(", "));
            argsToBuffer(d.args, buf, hgs); // hdrgen.d:1213
        }

        buf.writeByte(0x29); // ')' — hdrgen.d:1216

        // https://issues.dlang.org/show_bug.cgi?id=14690
        // Unconditionally perform a full output dump
        // for `pragma(inline)` declarations.
        const saved = hgs.doFuncBodies; // hdrgen.d:1221
        try {
            if (d.ident === Id.Pinline) // hdrgen.d:1222 — Identifier `==` is identity
                hgs.doFuncBodies = true;

            visitAttribDeclaration(d); // hdrgen.d:1225
        } finally {
            hgs.doFuncBodies = saved; // hdrgen.d:1226
        }
    };

    // hdrgen.d:1229-1262 — visitConditionalDeclaration: `<condition>` then `{ … }[ else { … }]`, or
    // `<condition>:` for the colon form with no members.
    const visitConditionalDeclaration = (d: ConditionalDeclaration): void => {
        conditionToBuffer(d.condition, buf, hgs); // hdrgen.d:1231 — UFCS (04 §6)
        if (d.decl || d.elsedecl) { // hdrgen.d:1232
            buf.writenl();
            buf.writeByte(0x7B); // '{'
            buf.writenl();
            buf.level++; // hdrgen.d:1237
            try {
                if (d.decl) { // hdrgen.d:1238
                    for (let i = 0; i < d.decl.length; i++)
                        dsymbolToCBuffer(d.decl.opIndex(i)!, buf, hgs); // hdrgen.d:1241
                }
            } finally {
                buf.level--; // hdrgen.d:1243
            }
            buf.writeByte(0x7D); // '}'
            if (d.elsedecl) { // hdrgen.d:1245
                buf.writenl();
                buf.writestring(ds("else"));
                buf.writenl();
                buf.writeByte(0x7B); // '{'
                buf.writenl();
                buf.level++; // hdrgen.d:1252
                try {
                    for (let i = 0; i < d.elsedecl.length; i++)
                        dsymbolToCBuffer(d.elsedecl.opIndex(i)!, buf, hgs); // hdrgen.d:1254
                } finally {
                    buf.level--; // hdrgen.d:1255
                }
                buf.writeByte(0x7D); // '}'
            }
        } else
            buf.writeByte(0x3A); // ':' — hdrgen.d:1260
        buf.writenl();
    };

    // hdrgen.d:1264-1323 — visitStaticForeachDeclaration, with its OWN two nested helpers (the same
    // text as the statement printer's, but a separate D declaration pair — ported where D puts them).
    const visitStaticForeachDeclaration = (s: StaticForeachDeclaration): void => {
        // hdrgen.d:1266-1285 — foreachWithoutBody. D iterates `*s.parameters` and derefs `s.aggr`
        // untested (02 §10.1 `!`).
        const foreachWithoutBody = (s: ForeachStatement): void => {
            buf.writestring(Token.toStringValue(s.op)); // hdrgen.d:1268 — `Token.toString(s.op)`
            buf.writestring(ds(" ("));
            const parameters = s.parameters!;
            for (let i = 0; i < parameters.length; i++) { // hdrgen.d:1270
                const p = parameters.opIndex(i)!;
                if (i) // hdrgen.d:1272
                    buf.writestring(ds(", "));
                if (stcToBuffer(buf, p.storageClass)) // hdrgen.d:1274
                    buf.writeByte(0x20); // ' '
                if (p.type) // hdrgen.d:1276
                    typeToBuffer(p.type, p.ident, buf, hgs);
                else
                    buf.writestring(p.ident!.toString()); // hdrgen.d:1279
            }
            buf.writestring(ds("; "));
            expressionToBuffer(s.aggr!, buf, hgs); // hdrgen.d:1282
            buf.writeByte(0x29); // ')'
            buf.writenl();
        };

        // hdrgen.d:1287-1303 — foreachRangeWithoutBody
        const foreachRangeWithoutBody = (s: ForeachRangeStatement): void => {
            /* s.op ( param ; lwr .. upr )
             */
            buf.writestring(Token.toStringValue(s.op)); // hdrgen.d:1291
            buf.writestring(ds(" ("));
            const param = s.param!;
            if (param.type) // hdrgen.d:1293
                typeToBuffer(param.type, param.ident, buf, hgs);
            else
                buf.writestring(param.ident!.toString()); // hdrgen.d:1296
            buf.writestring(ds("; "));
            expressionToBuffer(s.lwr!, buf, hgs); // hdrgen.d:1298
            buf.writestring(ds(" .. "));
            expressionToBuffer(s.upr!, buf, hgs); // hdrgen.d:1300
            buf.writeByte(0x29); // ')'
            buf.writenl();
        };

        buf.writestring(ds("static ")); // hdrgen.d:1305
        if (s.sfe.aggrfe) { // hdrgen.d:1306
            foreachWithoutBody(s.sfe.aggrfe);
        } else {
            assert(s.sfe.rangefe !== null); // hdrgen.d:1312 — D's own `assert(s.sfe.rangefe)`
            foreachRangeWithoutBody(s.sfe.rangefe);
        }
        buf.writeByte(0x7B); // '{' — hdrgen.d:1315
        buf.writenl();
        buf.level++; // hdrgen.d:1317
        try {
            visitAttribDeclaration(s); // hdrgen.d:1318
        } finally {
            buf.level--; // hdrgen.d:1319
        }
        buf.writeByte(0x7D); // '}'
        buf.writenl();
    };

    // hdrgen.d:1325-1331 — visitMixinDeclaration
    const visitMixinDeclaration = (d: MixinDeclaration): void => {
        buf.writestring(ds("mixin("));
        argsToBuffer(d.exps, buf, hgs, null); // hdrgen.d:1328
        buf.writestring(ds(");"));
        buf.writenl();
    };

    // hdrgen.d:1333-1339 — visitUserAttributeDeclaration
    const visitUserAttributeDeclaration = (d: UserAttributeDeclaration): void => {
        buf.writestring(ds("@("));
        argsToBuffer(d.attsUda, buf, hgs); // hdrgen.d:1336
        buf.writeByte(0x29); // ')'
        // hdrgen.d:1338 — an upcast in D.
        visitAttribDeclaration(d);
    };

    // hdrgen.d:1341-1348 — visitTemplateConstraint: ` if (<constraint>)`, nothing when null.
    const visitTemplateConstraint = (constraint: Expression | null): void => {
        if (!constraint) // hdrgen.d:1343
            return;
        buf.writestring(ds(" if ("));
        expressionToBuffer(constraint, buf, hgs); // hdrgen.d:1346
        buf.writeByte(0x29); // ')'
    };

    /// The condition `contractsToBuffer` prints for an expression contract: D's `(cast(AssertExp)es.exp).e1`
    /// (hdrgen.d:1364/:1392). DECLARED DIVERGENCE FROM THE D SOURCE (11 §2.6), reproducing ldc2's binary.
    /// D asserts `es.exp.op == EXP.assert_` first (hdrgen.d:1362/:1385), but semantic3 runs on these same
    /// statements (funcsem.d:2946 wraps each `frequires` element, :2972/:2976 push each `ensure`, no copy), and
    /// statementsem.d:222 replaces the ExpStatement's `exp` by its semantic result. Under -checkaction=context an
    /// assert whose operand has side effects returns `Expression.combine(temporariesPrefix, exp)`
    /// (expressionsem.d:9833): a CommaExp whose rightmost operand is the AssertExp. ldc2's release build drops
    /// the assert and the cast reinterprets the CommaExp; `.offsetof` on dmd.expression gives UnaExp.e1 and
    /// BinExp.e1 both at offset 24, so ldc2 prints `CommaExp.e1`, the temporaries' declarations
    /// (`in ((bool __assertOp3 = g(x);))`). The port reads that field by name. Any other class, or a CommaExp
    /// that is not the lowering's shape, fails the assert as D's does.
    const contractCondition = (e: Expression): Expression => {
        const ae = e.isAssertExp();
        if (ae)
            return ae.e1!;
        const ce = e.isCommaExp();
        assert(ce !== null && ce.e2!.op === EXP.assert_, "contract statement is neither an assert nor its lowering");
        return ce.e1!;
    };

    /// hdrgen.d:1350-1412 — contractsToBuffer.
    /// Returns: whether `do` is needed to write the function body
    const contractsToBuffer = (f: FuncDeclaration): boolean => {
        let requireDo = false; // hdrgen.d:1353
        // in{}
        const frequires = f.frequires(); // `f.frequires` is an accessor method in the port (func.ts)
        if (frequires) { // hdrgen.d:1355
            // hdrgen.d:1357 — `foreach (frequire; *f.frequires)`; each slot is called through (02 §10.1 `!`).
            for (let i = 0; i < frequires.length; i++) {
                const frequire = frequires.opIndex(i)!;
                buf.writestring(ds("in"));
                const es = frequire.isExpStatement();
                if (es) { // hdrgen.d:1360
                    // hdrgen.d:1362 — D's assert, which ldc2's release build drops: `contractCondition`
                    // keeps its null half here and states the class it admits.
                    assert(es.exp !== null);
                    buf.writestring(ds(" ("));
                    expressionToBuffer(contractCondition(es.exp), buf, hgs); // hdrgen.d:1364
                    buf.writeByte(0x29); // ')'
                    buf.writenl();
                    requireDo = false;
                } else {
                    buf.writenl();
                    statementToBuffer(frequire, buf, hgs); // hdrgen.d:1372 — UFCS (04 §6)
                    requireDo = true;
                }
            }
        }
        // out{}
        const fensures = f.fensures(); // accessor method, as above
        if (fensures) { // hdrgen.d:1378
            // hdrgen.d:1380 — `foreach (fensure; *f.fensures)`: `Ensure` is a struct and D iterates by
            // value; the body only reads the copy's fields, so the copy is unobservable and elided
            // (03 §4 foreach copy note).
            for (let i = 0; i < fensures.length; i++) {
                const fensure = fensures.opIndex(i);
                buf.writestring(ds("out"));
                const es = fensure.ensure!.isExpStatement(); // hdrgen.d:1383 — D derefs `ensure` untested
                if (es) {
                    assert(es.exp !== null); // hdrgen.d:1385 — as above
                    buf.writestring(ds(" ("));
                    if (fensure.id) { // hdrgen.d:1387
                        buf.writestring(fensure.id.toString());
                    }
                    buf.writestring(ds("; "));
                    expressionToBuffer(contractCondition(es.exp), buf, hgs); // hdrgen.d:1392
                    buf.writeByte(0x29); // ')'
                    buf.writenl();
                    requireDo = false;
                } else {
                    if (fensure.id) { // hdrgen.d:1399
                        buf.writeByte(0x28); // '('
                        buf.writestring(fensure.id.toString());
                        buf.writeByte(0x29); // ')'
                    }
                    buf.writenl();
                    statementToBuffer(fensure.ensure!, buf, hgs); // hdrgen.d:1406 — UFCS (04 §6)
                    requireDo = true;
                }
            }
        }
        return requireDo; // hdrgen.d:1411
    };

    // hdrgen.d:1414-1460 — bodyToBuffer: `;` (with any contracts) when there is no body or the header
    // omits it; otherwise contracts, `do` when needed, and the braced body.
    const bodyToBuffer = (f: FuncDeclaration): void => {
        if (!f.fbody ||
            (hgs.hdrgen && hgs.doFuncBodies === false && !hgs.autoMember && !hgs.tpltMember && !hgs.insideFuncBody)) {
            if (!f.fbody && (f.fensures() || f.frequires())) { // hdrgen.d:1418
                buf.writenl();
                contractsToBuffer(f);
            }
            buf.writeByte(0x3B); // ';' — hdrgen.d:1423
            buf.writenl();
            return;
        }

        // there is no way to know if a function is nested
        // or not after parsing. We need scope information
        // for that, which is avaible during semantic
        // analysis. To overcome that, a simple mechanism
        // is implemented: everytime we print a function
        // body (templated or not) we increment a counter.
        // We decredement the counter when we stop
        // printing the function body.
        ++hgs.insideFuncBody; // hdrgen.d:1436
        try {
            const savetlpt = hgs.tpltMember; // hdrgen.d:1439
            const saveauto = hgs.autoMember;
            hgs.tpltMember = 0; // hdrgen.d:1441
            hgs.autoMember = 0;
            // Paired state: the save/restore of `tpltMember` / `autoMember` is released at region end
            // (hdrgen.d:1458-1459) with no other exit, so the restore moves into `finally` (11 §2.5).
            try {
                buf.writenl();
                const requireDo = contractsToBuffer(f); // hdrgen.d:1444

                if (requireDo) { // hdrgen.d:1446
                    buf.writestring(ds("do"));
                    buf.writenl();
                }
                buf.writeByte(0x7B); // '{' — hdrgen.d:1451
                buf.writenl();
                buf.level++; // hdrgen.d:1453
                try {
                    statementToBuffer(f.fbody, buf, hgs); // hdrgen.d:1454 — UFCS (04 §6)
                } finally {
                    buf.level--; // hdrgen.d:1455
                }
                buf.writeByte(0x7D); // '}'
                buf.writenl();
            } finally {
                hgs.tpltMember = savetlpt; // hdrgen.d:1458
                hgs.autoMember = saveauto;
            }
        } finally {
            --hgs.insideFuncBody; // hdrgen.d:1437 — `scope(exit) { --hgs.insideFuncBody; }`
        }
    };

    // hdrgen.d:1462-1474 — visitBaseClasses: ` : Base, I1, …` (no ` : ` for an anonymous class).
    const visitBaseClasses = (d: ClassDeclaration | null): void => {
        if (!d || !d.baseclasses.length) // hdrgen.d:1464
            return;
        if (!d.isAnonymous()) // hdrgen.d:1466
            buf.writestring(ds(" : "));
        // hdrgen.d:1468 — `foreach (i, b; *d.baseclasses)`; D reads `b.type` through each slot untested.
        for (let i = 0; i < d.baseclasses.length; i++) {
            const b = d.baseclasses.opIndex(i)!;
            if (i) // hdrgen.d:1470
                buf.writestring(ds(", "));
            typeToBuffer(b.type!, null, buf, hgs); // hdrgen.d:1472
        }
    };

    // hdrgen.d:1476-1550 — visitEponymousMember: the short form of an eponymous template
    // (`T f(T)(T a) {…}`, `struct S(T) {…}`, `enum x(T) = …;`). Returns whether it printed.
    const visitEponymousMember = (d: TemplateDeclaration): boolean => {
        if (!d.members || d.members.length !== 1) // hdrgen.d:1478
            return false;
        const onemember = d.members.opIndex(0)!; // hdrgen.d:1480 — D calls through the slot untested
        if (onemember.ident !== d.ident) // hdrgen.d:1481 — Identifier `!=` is identity
            return false;
        const fd = onemember.isFuncDeclaration();
        if (fd) { // hdrgen.d:1483
            assert(fd.type !== null); // hdrgen.d:1485 — D's own `assert(fd.type)`
            if (stcToBuffer(buf, fd.storage_class)) // hdrgen.d:1486
                buf.writeByte(0x20); // ' '
            // hdrgen.d:1488 — `cast(TypeFunction)fd.type`: a class downcast; a function's type is its
            // TypeFunction, and `isTypeFunction()` performs the same test (null otherwise), so `!`
            // marks D's untested use of the cast result.
            functionToBufferFull(fd.type.isTypeFunction()!, buf, d.ident, hgs, d);
            visitTemplateConstraint(d.constraint); // hdrgen.d:1489
            hgs.tpltMember++; // hdrgen.d:1490
            try {
                bodyToBuffer(fd);
            } finally {
                hgs.tpltMember--; // hdrgen.d:1492
            }
            return true;
        }
        const ad = onemember.isAggregateDeclaration();
        if (ad) { // hdrgen.d:1495
            buf.writestring(ad.kind()); // hdrgen.d:1497
            buf.writeByte(0x20); // ' '
            buf.writestring(ad.ident!.toString()); // hdrgen.d:1499 — D derefs `ident` untested
            buf.writeByte(0x28); // '('
            visitTemplateParameters(hgs.ddoc ? d.origParameters : d.parameters, buf, hgs); // hdrgen.d:1501
            buf.writeByte(0x29); // ')'
            visitTemplateConstraint(d.constraint); // hdrgen.d:1503
            visitBaseClasses(ad.isClassDeclaration()); // hdrgen.d:1504
            hgs.tpltMember++; // hdrgen.d:1505
            try {
                if (ad.members) { // hdrgen.d:1506
                    buf.writenl();
                    buf.writeByte(0x7B); // '{'
                    buf.writenl();
                    buf.level++; // hdrgen.d:1511
                    try {
                        for (let i = 0; i < ad.members.length; i++)
                            dsymbolToCBuffer(ad.members.opIndex(i)!, buf, hgs); // hdrgen.d:1513
                    } finally {
                        buf.level--; // hdrgen.d:1514
                    }
                    buf.writeByte(0x7D); // '}'
                } else
                    buf.writeByte(0x3B); // ';' — hdrgen.d:1518
                buf.writenl();
            } finally {
                hgs.tpltMember--; // hdrgen.d:1520
            }
            return true;
        }
        const vd = onemember.isVarDeclaration();
        if (vd) { // hdrgen.d:1523
            if (d.constraint) // hdrgen.d:1525
                return false;
            if (stcToBuffer(buf, vd.storage_class)) // hdrgen.d:1527
                buf.writeByte(0x20); // ' '
            if (vd.type) // hdrgen.d:1529
                typeToBuffer(vd.type, vd.ident, buf, hgs);
            else
                buf.writestring(vd.ident!.toString()); // hdrgen.d:1532
            buf.writeByte(0x28); // '('
            visitTemplateParameters(hgs.ddoc ? d.origParameters : d.parameters, buf, hgs); // hdrgen.d:1534
            buf.writeByte(0x29); // ')'
            if (vd._init) { // hdrgen.d:1536
                buf.writestring(ds(" = "));
                const ie = vd._init.isExpInitializer(); // hdrgen.d:1539
                if (ie && (ie.exp!.op === EXP.construct || ie.exp!.op === EXP.blit))
                    // hdrgen.d:1541 — `(cast(AssignExp)ie.exp).e2`: tag-proved downcast, the adjacent
                    // `construct || blit` test proves an AssignExp subclass that `isAssignExp()`
                    // (EXP.assign alone) cannot express (02 §11.5c item 3). UFCS (04 §6).
                    expressionToBuffer((ie.exp as unknown as AssignExp).e2!, buf, hgs);
                else
                    initializerToBuffer(vd._init, buf, hgs); // hdrgen.d:1543 — UFCS (04 §6)
            }
            buf.writeByte(0x3B); // ';' — hdrgen.d:1545
            buf.writenl();
            return true;
        }
        return false; // hdrgen.d:1549
    };

    // hdrgen.d:1552-1586 — visitTemplateDeclaration
    const visitTemplateDeclaration = (d: TemplateDeclaration): void => {
        // resolved: version(none) -> false (hdrgen.d:1554-1559, the "template functions for doc
        // generation" sketch); never compiled, not emitted.
        if ((hgs.hdrgen || hgs.fullDump) && visitEponymousMember(d)) // hdrgen.d:1560
            return;
        if (hgs.ddoc) // hdrgen.d:1562
            buf.writestring(d.kind());
        else
            buf.writestring(ds("template"));
        buf.writeByte(0x20); // ' '
        buf.writestring(d.ident!.toString()); // hdrgen.d:1567 — D derefs `ident` untested
        buf.writeByte(0x28); // '('
        visitTemplateParameters(hgs.ddoc ? d.origParameters : d.parameters, buf, hgs); // hdrgen.d:1569
        buf.writeByte(0x29); // ')'
        visitTemplateConstraint(d.constraint); // hdrgen.d:1571
        if (hgs.hdrgen || hgs.fullDump) { // hdrgen.d:1572
            hgs.tpltMember++; // hdrgen.d:1574
            try {
                buf.writenl();
                buf.writeByte(0x7B); // '{'
                buf.writenl();
                buf.level++; // hdrgen.d:1578
                try {
                    // hdrgen.d:1579 — `foreach (s; *d.members)`; D iterates it untested (02 §10.1 `!`).
                    const members = d.members!;
                    for (let i = 0; i < members.length; i++)
                        dsymbolToCBuffer(members.opIndex(i)!, buf, hgs);
                } finally {
                    buf.level--; // hdrgen.d:1581
                }
                buf.writeByte(0x7D); // '}'
                buf.writenl();
            } finally {
                hgs.tpltMember--; // hdrgen.d:1584
            }
        }
    };

    // hdrgen.d:1588-1598 — visitTemplateInstance: `name!args`, then in a full dump the instance body.
    const visitTemplateInstance = (ti: TemplateInstance): void => {
        buf.writestring(ti.name!.toChars()); // hdrgen.d:1590 — Identifier.toChars carries no NUL
        tiargsToBuffer(ti, buf, hgs); // hdrgen.d:1591

        if (hgs.fullDump) { // hdrgen.d:1593
            buf.writenl();
            dumpTemplateInstance(ti, buf, hgs); // hdrgen.d:1596
        }
    };

    // hdrgen.d:1600-1614 — visitTemplateMixin: `mixin Q!args[ name];`
    const visitTemplateMixin = (tm: TemplateMixin): void => {
        buf.writestring(ds("mixin "));
        typeToBuffer(tm.tqual!, null, buf, hgs); // hdrgen.d:1603 — D derefs `tqual` untested
        tiargsToBuffer(tm, buf, hgs); // hdrgen.d:1604
        // hdrgen.d:1605 — `memcmp(tm.ident.toString().ptr, cast(const(char)*) "__mixin", 7) != 0`: the
        // first 7 bytes differ from `__mixin`. The identifier's bytes are NUL-terminated in D's string
        // pool, so a shorter name differs at its terminator at the latest; a prefix test over the slice is
        // the same answer.
        if (tm.ident && !startsWith(tm.ident.toString(), ds("__mixin"))) {
            buf.writeByte(0x20); // ' '
            buf.writestring(tm.ident.toString()); // hdrgen.d:1608
        }
        buf.writeByte(0x3B); // ';'
        buf.writenl();
        if (hgs.fullDump) // hdrgen.d:1612
            dumpTemplateInstance(tm, buf, hgs);
    };

    // hdrgen.d:1616-1674 — visitEnumDeclaration. `hgs.inEnumDecl` is saved and restored by
    // `scope(exit)` (a plain `try`/`finally`, 11 §2.5); `buf.level` is a second pair.
    const visitEnumDeclaration = (d: EnumDeclaration): void => {
        const oldInEnumDecl = hgs.inEnumDecl; // hdrgen.d:1618
        try {
            hgs.inEnumDecl = d; // hdrgen.d:1620
            buf.writestring(ds("enum "));
            if (d.ident) { // hdrgen.d:1622
                buf.writestring(d.ident.toString());
            }
            if (d.memtype) { // hdrgen.d:1626
                buf.writestring(ds(" : "));
                typeToBuffer(d.memtype, null, buf, hgs);
            }
            if (!d.members) { // hdrgen.d:1631
                buf.writeByte(0x3B); // ';'
                buf.writenl();
                return;
            }
            buf.writenl();
            buf.writeByte(0x7B); // '{'
            buf.writenl();
            buf.level++; // hdrgen.d:1640
            try {
                // hdrgen.d:1641 — `foreach (em; *d.members)`
                for (let i = 0; i < d.members.length; i++) {
                    const em = d.members.opIndex(i);
                    if (!em) // hdrgen.d:1643
                        continue;
                    dsymbolToCBuffer(em, buf, hgs); // hdrgen.d:1645
                    buf.writeByte(0x2C); // ','
                    buf.writenl();
                }
            } finally {
                buf.level--; // hdrgen.d:1649
            }
            buf.writeByte(0x7D); // '}'
            buf.writenl();

            if (!hgs.importcHdr || !d.ident) // hdrgen.d:1653
                return;

            /* C enums get their members inserted into the symbol table of the enum declaration.
             * This is accomplished in addEnumMembersToSymtab().
             * But when generating D code from ImportC code, D rulez are followed.
             * Accomplish this by generating an alias declaration for each member
             */
            for (let i = 0; i < d.members.length; i++) { // hdrgen.d:1661
                const em = d.members.opIndex(i);
                if (!em) // hdrgen.d:1663
                    continue;
                buf.writestring(ds("alias "));
                buf.writestring(em.ident!.toString()); // hdrgen.d:1666
                buf.writestring(ds(" = "));
                buf.writestring(d.ident.toString());
                buf.writeByte(0x2E); // '.'
                buf.writestring(em.ident!.toString()); // hdrgen.d:1670
                buf.writeByte(0x3B); // ';'
                buf.writenl();
            }
        } finally {
            hgs.inEnumDecl = oldInEnumDecl; // hdrgen.d:1619 — `scope(exit) hgs.inEnumDecl = oldInEnumDecl;`
        }
    };

    // hdrgen.d:1676-1690 — visitNspace: `extern (C++, ns)` then the braced members. D iterates
    // `*d.members` untested (02 §10.1 `!`).
    const visitNspace = (d: Nspace): void => {
        buf.writestring(ds("extern (C++, "));
        buf.writestring(d.ident!.toString()); // hdrgen.d:1679
        buf.writeByte(0x29); // ')'
        buf.writenl();
        buf.writeByte(0x7B); // '{'
        buf.writenl();
        buf.level++; // hdrgen.d:1684
        try {
            const members = d.members!;
            for (let i = 0; i < members.length; i++)
                dsymbolToCBuffer(members.opIndex(i)!, buf, hgs); // hdrgen.d:1686
        } finally {
            buf.level--; // hdrgen.d:1687
        }
        buf.writeByte(0x7D); // '}'
        buf.writenl();
    };

    // hdrgen.d:1692-1716 — visitStructDeclaration (struct and union). `insideAggregate` and
    // `buf.level` are two pairs, each protected on its own (11 §2.5 rule (b)).
    const visitStructDeclaration = (d: StructDeclaration): void => {
        //printf("visitStructDeclaration() %s\n", d.ident.toChars());   (commented out upstream, hdrgen.d:1694)
        buf.writestring(d.kind()); // hdrgen.d:1695
        buf.writeByte(0x20); // ' '
        if (!d.isAnonymous()) // hdrgen.d:1697
            // `put(const(char)*)` stops at the NUL `toChars()`'s `extractChars()` result may carry (02 §11.2).
            buf.writestring(cstr(d.toChars()));
        if (!d.members) { // hdrgen.d:1699
            buf.writeByte(0x3B); // ';'
            buf.writenl();
            return;
        }
        buf.writenl();
        buf.writeByte(0x7B); // '{'
        buf.writenl();
        buf.level++; // hdrgen.d:1708
        try {
            hgs.insideAggregate++; // hdrgen.d:1709
            try {
                for (let i = 0; i < d.members.length; i++)
                    dsymbolToCBuffer(d.members.opIndex(i)!, buf, hgs); // hdrgen.d:1711
            } finally {
                hgs.insideAggregate--; // hdrgen.d:1712
            }
        } finally {
            buf.level--; // hdrgen.d:1713
        }
        buf.writeByte(0x7D); // '}'
        buf.writenl();
    };

    // hdrgen.d:1718-1743 — visitClassDeclaration (class and interface)
    const visitClassDeclaration = (d: ClassDeclaration): void => {
        if (!d.isAnonymous()) { // hdrgen.d:1720
            buf.writestring(d.kind());
            buf.writeByte(0x20); // ' '
            buf.writestring(d.ident!.toString()); // hdrgen.d:1724
        }
        visitBaseClasses(d); // hdrgen.d:1726
        if (d.members) { // hdrgen.d:1727
            buf.writenl();
            buf.writeByte(0x7B); // '{'
            buf.writenl();
            buf.level++; // hdrgen.d:1732
            try {
                hgs.insideAggregate++; // hdrgen.d:1733
                try {
                    for (let i = 0; i < d.members.length; i++)
                        dsymbolToCBuffer(d.members.opIndex(i)!, buf, hgs); // hdrgen.d:1735
                } finally {
                    hgs.insideAggregate--; // hdrgen.d:1736
                }
            } finally {
                buf.level--; // hdrgen.d:1737
            }
            buf.writeByte(0x7D); // '}'
        } else
            buf.writeByte(0x3B); // ';' — hdrgen.d:1741
        buf.writenl();
    };

    // hdrgen.d:1745-1792 — visitAliasDeclaration
    const visitAliasDeclaration = (d: AliasDeclaration): void => {
        if ((d.storage_class & STC.local) !== 0n) // hdrgen.d:1747
            return;
        if (d.hidden) // hdrgen.d:1749
            return;
        buf.writestring(ds("alias "));
        if (d.aliassym) { // hdrgen.d:1752
            buf.writestring(d.ident!.toString()); // hdrgen.d:1754 — D derefs `ident` untested
            buf.writestring(ds(" = "));
            if (stcToBuffer(buf, d.storage_class)) // hdrgen.d:1756
                buf.writeByte(0x20); // ' '
            /*
                https://issues.dlang.org/show_bug.cgi?id=23223
                https://issues.dlang.org/show_bug.cgi?id=23222
                https://github.com/dlang/dmd/issues/21707
                For named symbols (modules, functions, templates, aggregates),
                print just the name to avoid segfaults, infinite recursion,
                and for nicer -vcg-ast output. Anonymous symbols (function
                literals) are printed in full.
            */
            if (!d.aliassym.isFuncLiteralDeclaration() && d.aliassym.ident) // hdrgen.d:1767
                buf.writestring(d.aliassym.ident.toString());
            else
                dsymbolToCBuffer(d.aliassym, buf, hgs); // hdrgen.d:1770
        } else if (d.type!.ty === TY.Tfunction) { // hdrgen.d:1772 — D derefs `type` untested
            if (stcToBuffer(buf, d.storage_class)) // hdrgen.d:1774
                buf.writeByte(0x20); // ' '
            typeToBuffer(d.type!, d.ident, buf, hgs); // hdrgen.d:1776
        } else if (d.ident) { // hdrgen.d:1778
            // Paired state: `declstring` and `inCAlias` are set here and reset at hdrgen.d:1787-1788 with
            // no other exit, so the resets move into `finally` (11 §2.5); each is its own pair.
            // hdrgen.d:1780 — Identifier `==` is identity.
            hgs.declstring = (d.ident === Id.string || d.ident === Id.wstring || d.ident === Id.dstring);
            try {
                buf.writestring(d.ident.toString()); // hdrgen.d:1781
                buf.writestring(ds(" = "));
                if (stcToBuffer(buf, d.storage_class)) // hdrgen.d:1783
                    buf.writeByte(0x20); // ' '
                hgs.inCAlias = hgs.importcHdr; // hdrgen.d:1785
                try {
                    typeToBuffer(d.type!, null, buf, hgs); // hdrgen.d:1786
                } finally {
                    hgs.inCAlias = false; // hdrgen.d:1787
                }
            } finally {
                hgs.declstring = false; // hdrgen.d:1788
            }
        }
        buf.writeByte(0x3B); // ';' — hdrgen.d:1790
        buf.writenl();
    };

    // hdrgen.d:1794-1804 — visitAliasAssign. D reads the derived slot here through a static
    // `AliasAssign` (`identAssign`, 02 §11.5b registry).
    const visitAliasAssign = (d: AliasAssign): void => {
        buf.writestring(d.identAssign!.toString()); // hdrgen.d:1796
        buf.writestring(ds(" = "));
        if (d.aliassym) // hdrgen.d:1798
            dsymbolToCBuffer(d.aliassym, buf, hgs);
        else // d.type
            typeToBuffer(d.type!, null, buf, hgs); // hdrgen.d:1801
        buf.writeByte(0x3B); // ';'
        buf.writenl();
    };

    // hdrgen.d:1806-1813 — visitVarDeclaration
    const visitVarDeclaration = (d: VarDeclaration): void => {
        if ((d.storage_class & STC.local) !== 0n) // hdrgen.d:1808
            return;
        visitVarDecl(d, false, buf, hgs); // hdrgen.d:1810
        buf.writeByte(0x3B); // ';'
        buf.writenl();
    };

    // hdrgen.d:1815-1855 — visitFuncDeclaration. D derefs `f.type` untested (02 §10.1 `!`).
    const visitFuncDeclaration = (f: FuncDeclaration): void => {
        //printf("FuncDeclaration::toCBuffer() '%s'\n", f.toChars());   (commented out upstream, hdrgen.d:1817)

        // https://issues.dlang.org/show_bug.cgi?id=24891
        // return/scope storage classes are printed as part of function type
        // hdrgen.d:1821 — branded STC re-cast after `&~` (02 §11.5c.4).
        if (stcToBuffer(buf, (f.storage_class & ~(STC.scope_ | STC.return_ | STC.returnScope | STC.returnRef)) as STC))
            buf.writeByte(0x20); // ' '
        typeToBuffer(f.type!, f.ident, buf, hgs); // hdrgen.d:1823
        const tf = f.type!.isTypeFunction(); // hdrgen.d:1824

        if (hgs.hdrgen && tf) { // hdrgen.d:1826
            // if the return type is missing (e.g. ref functions or auto)
            // https://issues.dlang.org/show_bug.cgi?id=20090
            // constructors are an exception: they don't have an explicit return
            // type but we still don't output the body.
            if ((!f.isCtorDeclaration() && !tf.next) || (f.storage_class & STC.auto_) !== 0n) { // hdrgen.d:1832
                hgs.autoMember++; // hdrgen.d:1834
                try {
                    bodyToBuffer(f);
                } finally {
                    hgs.autoMember--; // hdrgen.d:1836
                }
            } else if (hgs.tpltMember === 0 && hgs.doFuncBodies === false && !hgs.insideFuncBody) { // hdrgen.d:1838
                if (!f.fbody) { // hdrgen.d:1840
                    // this can happen on interfaces / abstract functions, see `allowsContractWithoutBody`
                    if (f.fensures() || f.frequires()) // hdrgen.d:1843
                        buf.writenl();
                    contractsToBuffer(f); // hdrgen.d:1845
                }
                buf.writeByte(0x3B); // ';' — hdrgen.d:1847
                buf.writenl();
            } else
                bodyToBuffer(f); // hdrgen.d:1851
        } else
            bodyToBuffer(f); // hdrgen.d:1854
    };

    // hdrgen.d:1857-1905 — visitFuncLiteralDeclaration: `function`/`delegate` keyword (outside error
    // messages), return type unless inferred, parameters, attributes, then `=> <exp>` when the body
    // is a single return of an expression, else the full body.
    const visitFuncLiteralDeclaration = (f: FuncLiteralDeclaration): void => {
        if (f.type!.ty === TY.Terror) { // hdrgen.d:1859 — D derefs `type` untested
            buf.writestring(ds("__error"));
            return;
        }
        if (f.tok !== TOK.reserved && !hgs.errorMsg) { // hdrgen.d:1864
            buf.writestring(f.kind());
            buf.writeByte(0x20); // ' '
        }
        // hdrgen.d:1869 — `cast(TypeFunction)f.type`: a class downcast whose result D uses untested; a
        // function literal's type is its TypeFunction, and `isTypeFunction()` performs the same test.
        const tf = f.type!.isTypeFunction()!;

        if (!f.inferRetType && tf.next) // hdrgen.d:1871
            typeToBuffer(tf.next, null, buf, hgs);
        parametersToBuffer(tf.parameterList.copy(), buf, hgs); // hdrgen.d:1873 — by-value struct (03 §1)

        // https://issues.dlang.org/show_bug.cgi?id=20074
        // hdrgen.d:1876 — nested `void printAttribute(string str)`, handed to `attributesApply` as `&printAttribute`.
        const printAttribute = (str: string): void => {
            buf.writeByte(0x20); // ' '
            buf.writestring(ds(str));
        };

        if (!hgs.errorMsg) // hdrgen.d:1882
            // hdrgen.d:1883 — `tf.attributesApply(&printAttribute)`, UFCS (04 §6)
            attributesApply(tf, printAttribute);

        const cs = f.fbody!.isCompoundStatement(); // hdrgen.d:1885 — D derefs `fbody` untested
        let s1: Statement | null; // hdrgen.d:1886
        if (f.semanticRun >= PASS.semantic3done && cs) { // hdrgen.d:1887
            // hdrgen.d:1889 — `(*cs.statements)[cs.statements.length - 1]`; D indexes untested.
            s1 = cs.statements!.opIndex(cs.statements!.length - 1);
        } else
            s1 = !cs ? f.fbody : null; // hdrgen.d:1892
        const rs = s1 ? s1.endsWithReturnStatement() : null; // hdrgen.d:1893
        if (rs && rs.exp) { // hdrgen.d:1894
            buf.writestring(ds(" => "));
            expressionToBuffer(rs.exp, buf, hgs); // hdrgen.d:1897
        } else {
            hgs.tpltMember++; // hdrgen.d:1901
            try {
                bodyToBuffer(f);
            } finally {
                hgs.tpltMember--; // hdrgen.d:1903
            }
        }
    };

    // hdrgen.d:1907-1913 — visitPostBlitDeclaration
    const visitPostBlitDeclaration = (d: PostBlitDeclaration): void => {
        if (stcToBuffer(buf, d.storage_class)) // hdrgen.d:1909
            buf.writeByte(0x20); // ' '
        buf.writestring(ds("this(this)"));
        bodyToBuffer(d); // hdrgen.d:1912
    };

    // hdrgen.d:1915-1921 — visitDtorDeclaration
    const visitDtorDeclaration = (d: DtorDeclaration): void => {
        if (stcToBuffer(buf, d.storage_class)) // hdrgen.d:1917
            buf.writeByte(0x20); // ' '
        buf.writestring(ds("~this()"));
        bodyToBuffer(d); // hdrgen.d:1920
    };

    // hdrgen.d:1923-1937 — visitStaticCtorDeclaration. `static` is dropped from the storage classes
    // (the keyword is printed explicitly); a header outside a template omits the body.
    const visitStaticCtorDeclaration = (d: StaticCtorDeclaration): void => {
        // hdrgen.d:1925 — branded STC re-cast after `&~` (02 §11.5c.4)
        if (stcToBuffer(buf, (d.storage_class & ~STC.static_) as STC))
            buf.writeByte(0x20); // ' '
        if (d.isSharedStaticCtorDeclaration()) // hdrgen.d:1927
            buf.writestring(ds("shared "));
        buf.writestring(ds("static this()"));
        if (hgs.hdrgen && !hgs.tpltMember) { // hdrgen.d:1930
            buf.writeByte(0x3B); // ';'
            buf.writenl();
        } else
            bodyToBuffer(d); // hdrgen.d:1936
    };

    // hdrgen.d:1939-1953 — visitStaticDtorDeclaration
    const visitStaticDtorDeclaration = (d: StaticDtorDeclaration): void => {
        // hdrgen.d:1941 — branded STC re-cast after `&~` (02 §11.5c.4)
        if (stcToBuffer(buf, (d.storage_class & ~STC.static_) as STC))
            buf.writeByte(0x20); // ' '
        if (d.isSharedStaticDtorDeclaration()) // hdrgen.d:1943
            buf.writestring(ds("shared "));
        buf.writestring(ds("static ~this()"));
        if (hgs.hdrgen && !hgs.tpltMember) { // hdrgen.d:1946
            buf.writeByte(0x3B); // ';'
            buf.writenl();
        } else
            bodyToBuffer(d); // hdrgen.d:1952
    };

    // hdrgen.d:1955-1974 — visitInvariantDeclaration: `invariant (<exp>);` for the expression form,
    // else the full body; nothing in a header.
    const visitInvariantDeclaration = (d: InvariantDeclaration): void => {
        if (hgs.hdrgen) // hdrgen.d:1957
            return;
        if (stcToBuffer(buf, d.storage_class)) // hdrgen.d:1959
            buf.writeByte(0x20); // ' '
        buf.writestring(ds("invariant"));
        const es = d.fbody!.isExpStatement(); // hdrgen.d:1962 — D derefs `fbody` untested
        if (es && es.exp && es.exp.op === EXP.assert_) { // hdrgen.d:1963
            buf.writestring(ds(" ("));
            // hdrgen.d:1966 — `(cast(AssertExp)es.exp).e1` under `op == EXP.assert_`: `isAssertExp()`
            // tests that same op, so `!` is the proven downcast.
            expressionToBuffer(es.exp.isAssertExp()!.e1!, buf, hgs);
            buf.writestring(ds(");"));
            buf.writenl();
        } else {
            bodyToBuffer(d); // hdrgen.d:1972
        }
    };

    // hdrgen.d:1976-1984 — visitUnitTestDeclaration; nothing in a header.
    const visitUnitTestDeclaration = (d: UnitTestDeclaration): void => {
        if (hgs.hdrgen) // hdrgen.d:1978
            return;
        if (stcToBuffer(buf, d.storage_class)) // hdrgen.d:1980
            buf.writeByte(0x20); // ' '
        buf.writestring(ds("unittest"));
        bodyToBuffer(d); // hdrgen.d:1983
    };

    // hdrgen.d:1986-1996 — visitBitFieldDeclaration: `T name : width;` (no name when anonymous).
    const visitBitFieldDeclaration = (d: BitFieldDeclaration): void => {
        if (stcToBuffer(buf, d.storage_class)) // hdrgen.d:1988
            buf.writeByte(0x20); // ' '
        const id: Identifier | null = d.isAnonymous() ? null : d.ident; // hdrgen.d:1990
        typeToBuffer(d.type!, id, buf, hgs); // hdrgen.d:1991 — D derefs `type` untested
        buf.writestring(ds(" : "));
        expressionToBuffer(d.width!, buf, hgs); // hdrgen.d:1993 — D derefs `width` untested
        buf.writeByte(0x3B); // ';'
        buf.writenl();
    };

    // hdrgen.d:1998-2003 — visitNewDeclaration (no newline, as in D).
    const visitNewDeclaration = (d: NewDeclaration): void => {
        // hdrgen.d:2000 — branded STC re-cast after `&~` (02 §11.5c.4)
        if (stcToBuffer(buf, (d.storage_class & ~STC.static_) as STC))
            buf.writeByte(0x20); // ' '
        buf.writestring(ds("new();"));
    };

    // hdrgen.d:2005-2008 — visitModule
    const visitModule = (m: Module): void => {
        moduleToBuffer2(m, buf, hgs); // hdrgen.d:2007
    };

    /**
     * hdrgen.d:2011 — `final class DsymbolPrettyPrintVisitor : Visitor` (under `extern (C++)`, :2010),
     * nested in this function. IDIOM A (13 §7): each `visit(X)` override -> `visitX` (13 §1), 41 of them, each
     * forwarding to the enclosing nested function of the same name (D's own resolution: the class
     * body's unqualified `visitX(…)` names the enclosing function, since the class member is `visit`).
     */
    class DsymbolPrettyPrintVisitor extends Visitor {
        // dropped: alias visit = Visitor.visit — no overload hiding in TS (13 §1)
        override visitDsymbol(s: Dsymbol): void                  { visitDsymbol(s); }
        override visitStaticAssert(s: StaticAssert): void        { visitStaticAssert(s); }
        override visitDebugSymbol(s: DebugSymbol): void          { visitDebugSymbol(s); }
        override visitVersionSymbol(s: VersionSymbol): void      { visitVersionSymbol(s); }
        override visitEnumMember(em: EnumMember): void           { visitEnumMember(em); }
        override visitImport(imp: Import): void                  { visitImport(imp); }
        override visitAliasThis(d: AliasThis): void              { visitAliasThis(d); }
        override visitAttribDeclaration(d: AttribDeclaration): void { visitAttribDeclaration(d); }
        override visitStorageClassDeclaration(d: StorageClassDeclaration): void { visitStorageClassDeclaration(d); }
        override visitDeprecatedDeclaration(d: DeprecatedDeclaration): void { visitDeprecatedDeclaration(d); }
        override visitLinkDeclaration(d: LinkDeclaration): void  { visitLinkDeclaration(d); }
        override visitCPPMangleDeclaration(d: CPPMangleDeclaration): void { visitCPPMangleDeclaration(d); }
        override visitVisibilityDeclaration(d: VisibilityDeclaration): void { visitVisibilityDeclaration(d); }
        override visitAlignDeclaration(d: AlignDeclaration): void { visitAlignDeclaration(d); }
        override visitAnonDeclaration(d: AnonDeclaration): void  { visitAnonDeclaration(d); }
        override visitPragmaDeclaration(d: PragmaDeclaration): void { visitPragmaDeclaration(d); }
        override visitConditionalDeclaration(d: ConditionalDeclaration): void { visitConditionalDeclaration(d); }
        override visitStaticForeachDeclaration(s: StaticForeachDeclaration): void { visitStaticForeachDeclaration(s); }
        override visitMixinDeclaration(d: MixinDeclaration): void { visitMixinDeclaration(d); }
        override visitUserAttributeDeclaration(d: UserAttributeDeclaration): void { visitUserAttributeDeclaration(d); }
        override visitTemplateDeclaration(d: TemplateDeclaration): void { visitTemplateDeclaration(d); }
        override visitTemplateInstance(ti: TemplateInstance): void { visitTemplateInstance(ti); }
        override visitTemplateMixin(tm: TemplateMixin): void     { visitTemplateMixin(tm); }
        override visitEnumDeclaration(d: EnumDeclaration): void  { visitEnumDeclaration(d); }
        override visitNspace(d: Nspace): void                    { visitNspace(d); }
        override visitStructDeclaration(d: StructDeclaration): void { visitStructDeclaration(d); }
        override visitClassDeclaration(d: ClassDeclaration): void { visitClassDeclaration(d); }
        override visitAliasDeclaration(d: AliasDeclaration): void { visitAliasDeclaration(d); }
        override visitAliasAssign(d: AliasAssign): void          { visitAliasAssign(d); }
        override visitVarDeclaration(d: VarDeclaration): void    { visitVarDeclaration(d); }
        override visitFuncDeclaration(f: FuncDeclaration): void { visitFuncDeclaration(f); }
        override visitFuncLiteralDeclaration(f: FuncLiteralDeclaration): void { visitFuncLiteralDeclaration(f); }
        override visitPostBlitDeclaration(d: PostBlitDeclaration): void { visitPostBlitDeclaration(d); }
        override visitDtorDeclaration(d: DtorDeclaration): void  { visitDtorDeclaration(d); }
        override visitStaticCtorDeclaration(d: StaticCtorDeclaration): void { visitStaticCtorDeclaration(d); }
        override visitStaticDtorDeclaration(d: StaticDtorDeclaration): void { visitStaticDtorDeclaration(d); }
        override visitInvariantDeclaration(d: InvariantDeclaration): void { visitInvariantDeclaration(d); }
        override visitUnitTestDeclaration(d: UnitTestDeclaration): void { visitUnitTestDeclaration(d); }
        override visitBitFieldDeclaration(d: BitFieldDeclaration): void { visitBitFieldDeclaration(d); }
        override visitNewDeclaration(d: NewDeclaration): void    { visitNewDeclaration(d); }
        override visitModule(m: Module): void                    { visitModule(m); }
    }

    const v = new DsymbolPrettyPrintVisitor(); // hdrgen.d:2060 — `scope` erased (04 §8)
    if (dsymbolPrintHook !== null)
        dsymbolPrintHook(s, buf, () => s.accept(v)); // djs: the print hook (registerDsymbolPrintHook)
    else
        s.accept(v); // hdrgen.d:2061
}

/**
 * dmd/hdrgen.d:3349 — `void toCBuffer(const Type t, ref OutBuffer buf, const Identifier ident,`
 * `ref HdrGenState hgs)` (the Type overload). Thin forward to `typeToBuffer`.
 */
export function typeToCBuffer(t: Type, buf: OutBuffer, ident: Identifier | null, hgs: HdrGenState): void {
    typeToBuffer(t, ident, buf, hgs);
}

/**
 * dmd/hdrgen.d:3355 — `void toCBufferInstance(const TemplateInstance ti, ref OutBuffer buf, bool`
 * `qualifyTypes = false)`. Used from TemplateInstance::toChars() and TemplateMixin::toChars(): the
 * instance name (`this` for a constructor template) followed by its `!…` argument suffix, with the
 * argument types fully qualified when `qualifyTypes`.
 *
 * Preconditions: `ti.name` is non-null (D dereferences it untested, 02 §10.1).
 * Cost: `tiargsToBuffer` bumps and restores `ti`'s nest counter; an argument that is an expression
 * prints through `expToBuffer`, i.e. through the `precedence` registration slot.
 */
export function toCBufferInstance(ti: TemplateInstance, buf: OutBuffer, qualifyTypes = false): void {
    const hgs = new HdrGenState(); // hdrgen.d:3357
    hgs.fullQual = qualifyTypes; // hdrgen.d:3358

    // hdrgen.d:3360 — Identifier `==` is identity; Identifier.toChars carries no NUL.
    buf.writestring(ti.name === Id.ctor ? ds("this") : ti.name!.toChars());
    tiargsToBuffer(ti, buf, hgs); // hdrgen.d:3361 — `cast()` only drops const
}

/**
 * dmd/hdrgen.d:3364 — `void toCBuffer(const Initializer iz, ref OutBuffer buf, ref HdrGenState hgs)`,
 * the Initializer overload of D's `toCBuffer` set (04 §6.1 name). Thin forward to
 * `initializerToBuffer`.
 */
export function initializerToCBuffer(iz: Initializer, buf: OutBuffer, hgs: HdrGenState): void {
    initializerToBuffer(iz, buf, hgs); // hdrgen.d:3366 — `cast()` only drops const
}

/**
 * dmd/hdrgen.d:3565 — `void functionToBufferFull(TypeFunction tf, ref OutBuffer buf, const Identifier`
 * `ident, ref HdrGenState hgs, TemplateDeclaration td)`. Print the full function signature with
 * correct ident, attributes and template args, in the PREFIX ("storage class") attribute style:
 * `const nothrow @safe int mod.C.foo(ref int x)` — the form funcsem.d's "does not override any
 * function" diagnostics quote.
 *
 * `ident` is printed through `toHChars2()`, so a ctor/dtor/unittest identifier prints as
 * `this`/`~this`/… with no return type; `td`, when non-null, adds its ORIGINAL template parameter
 * list before the function parameters. `hgs` is caller state: its mode flags (`ddoc`, `hdrgen`,
 * `fullQual`, …) steer the output, and `inFuncReturn` is restored on every exit.
 * Recursion: a TypeFunction already being printed is skipped and flagged (`tf.inuse = 2`).
 */
export function functionToBufferFull(tf: TypeFunction, buf: OutBuffer, ident: Identifier | null, hgs: HdrGenState,
    td: TemplateDeclaration | null): void {
    //printf("TypeFunction::toCBuffer() this = %p\n", this);   (commented out upstream, hdrgen.d:3567)
    visitFuncIdentWithPrefix(tf, ident, td, buf, hgs); // hdrgen.d:3568
}

/**
 * dmd/hdrgen.d:3572 — `void functionToBufferWithIdent(TypeFunction tf, ref OutBuffer buf, const(char)*`
 * `ident, bool isStatic)`. Print `tf` in the POSTFIX attribute style, with `ident` inserted before the
 * argument list: `int mod.foo(int a) nothrow @safe` for `__PRETTY_FUNCTION__` / `toFullSignature`,
 * or `int function(int)` when `ident` is the keyword a pointer/delegate type prints.
 *
 * `ident` is D's `const(char)*`: null prints no name, and D reads it through `toDString()`, i.e. the
 * bytes before the first NUL — `cstr` here (02 §11.2), because a caller may hand in an
 * `extractChars()` result that still carries its terminator. `isStatic` only matters for
 * `extern (Objective-C)` (hdrgen.d:4101). Uses a fresh default `HdrGenState`.
 */
export function functionToBufferWithIdent(tf: TypeFunction, buf: OutBuffer, ident: DString | null,
    isStatic: boolean): void {
    const hgs = new HdrGenState(); // hdrgen.d:3574
    // hdrgen.d:3575 — `ident.toDString()`, whose body is `return s ? s[0 .. strlen(s)] : null;` (root/string.d:22).
    visitFuncIdentWithPostfix(tf, ident !== null ? cstr(ident) : null, buf, hgs, isStatic);
}

/**
 * dmd/hdrgen.d:3578 — `void toCBuffer(const Expression e, ref OutBuffer buf, ref HdrGenState hgs)`
 * (the Expression overload). Thin forward to `expressionPrettyPrint`.
 */
export function expToCBuffer(e: Expression, buf: OutBuffer, hgs: HdrGenState): void {
    expressionPrettyPrint(e, buf, hgs);
}

/**
 * dmd/hdrgen.d:3586 — `void argExpTypesToCBuffer(ref OutBuffer buf, Expressions* arguments)`.
 * Write out the argument TYPES to `buf`, comma-separated, WITHOUT enclosing parens — the caller
 * supplies them (`expressionsem.d`'s "none of the overloads ... are callable using argument
 * types `(...)`" diagnostic).
 *
 * Preconditions: every element of `arguments` is non-null and carries a non-null `type` — D
 * dereferences `arg.type` unconditionally at the hdrgen.d:3595 call site, and the deref that
 * actually faults is `t.isTypeFunction()` at hdrgen.d:3909 inside `typeToBuffer` (declared
 * :3906), so `!` marks the D fault site (02 §10.1).
 * Postconditions: nothing is written for a null or empty list.
 *
 * D's parameter is named `arguments`, a JS-reserved binding name -> `arguments_` (01 §2.2).
 */
export function argExpTypesToCBuffer(buf: OutBuffer, arguments_: Expressions | null): void {
    // hdrgen.d:3588
    if (!arguments_ || arguments_.length === 0)
        return;
    const hgs = new HdrGenState(); // hdrgen.d:3590
    // hdrgen.d:3591 — `foreach (i, arg; *arguments)`
    for (let i = 0; i < arguments_.length; i++) {
        const arg = arguments_.opIndex(i);
        if (i !== 0) // hdrgen.d:3593
            buf.writestring(ds(", "));
        typeToBuffer(arg!.type!, null, buf, hgs); // hdrgen.d:3595
    }
}

/**
 * dmd/hdrgen.d:3599 — `void arrayObjectsToBuffer(ref OutBuffer buf, Objects* objects)`. Write out a
 * template-argument list (types, expressions, symbols, tuples, parameters), comma-separated,
 * WITHOUT enclosing parens.
 *
 * Postconditions: nothing is written for a null or empty list.
 * Cost: one `HdrGenState` per call; `objectToBuffer` folds an `EXP.variable` argument through
 * `optimize(WANTvalue)` (hdrgen.d:4049), so this is not a pure printer.
 */
export function arrayObjectsToBuffer(buf: OutBuffer, objects: Objects | null): void {
    // hdrgen.d:3601
    if (!objects || objects.length === 0)
        return;
    const hgs = new HdrGenState(); // hdrgen.d:3603
    // hdrgen.d:3604 — `foreach (i, o; *objects)`
    for (let i = 0; i < objects.length; i++) {
        const o = objects.opIndex(i);
        if (i !== 0) // hdrgen.d:3606
            buf.writestring(ds(", "));
        objectToBuffer(o, buf, hgs); // hdrgen.d:3608
    }
}

/**
 * dmd/hdrgen.d:3618 — `const(char)* parametersTypeToChars(ParameterList pl)`. Pretty print a
 * function's parameter list, parens included.
 *
 * Returns: the rendered parameter list, e.g. `(int, string)`. `const(char)*` from `extractChars()`
 * is a `DString` here (08 §13a.2 — CONSUME, the buffer is dead after the call).
 * Cost: one `OutBuffer` + one `HdrGenState` per call; `pl.length()` is O(N) (tuple folding).
 */
export function parametersTypeToChars(pl: ParameterList): DString {
    const buf = new OutBuffer(); // hdrgen.d:3620
    const hgs = new HdrGenState(); // hdrgen.d:3621
    parametersToBuffer(pl, buf, hgs); // hdrgen.d:3622
    return buf.extractChars(); // hdrgen.d:3623
}

/**
 * dmd/hdrgen.d:3634 — `const(char)* parameterToChars(Parameter parameter, TypeFunction tf, bool`
 * `fullQual)`. Pretty print ONE parameter of `tf`, with no enclosing parens, appending `...` when it
 * is the last parameter of a typesafe-variadic list.
 *
 * Preconditions: `tf.parameterList.parameters` is non-null — D indexes `parameters.length` with no
 * null test at hdrgen.d:3642, so `!` marks that fault site (02 §10.1). `parameter` may be null only
 * as far as `parameterToBuffer` tolerates it (it does not: hdrgen.d:3698 derefs it), so callers pass
 * a real parameter; the port keeps D's own nullable `Parameter` slot type and marks the deref.
 * Equality, NOT identity: D's `parameter == tf.parameterList[...]` on this `extern (C++)` class calls
 * `Parameter.opEquals` (mtype.d:2581 — same storage class and same type object). So a parameter that
 * merely LOOKS like the variadic tail gets the `...` too: for `void f(int a, int b...)` ldc2 1.43
 * reports "cannot pass argument ... to parameter `int a...`" (probed; pinned in hdrgen.test.ts).
 * Returns: the rendered parameter. `extractChars()` is CONSUME — the local buffer is dead after
 * (08 §13a.2).
 * Cost: one `OutBuffer` + one `HdrGenState`; the typesafe leg indexes the RAW `parameters` array
 * (not the tuple-expanded length), exactly as D does.
 */
export function parameterToChars(parameter: Parameter | null, tf: TypeFunction, fullQual: boolean): DString {
    const buf = new OutBuffer(); // hdrgen.d:3636
    const hgs = new HdrGenState(); // hdrgen.d:3637
    hgs.fullQual = fullQual; // hdrgen.d:3638

    parameterToBuffer(parameter!, buf, hgs); // hdrgen.d:3640

    // hdrgen.d:3642 — last parameter of a typesafe-variadic list gets the `...` tail.
    // `==` -> `Parameter.opEquals` (mtype.d:2581, 05 §2); D calls it on `parameter` with no null test.
    if (tf.parameterList.varargs === VarArg.typesafe
        && parameter!.opEquals(tf.parameterList.opIndex(tf.parameterList.parameters!.length - 1)!)) {
        buf.writestring(ds("...")); // hdrgen.d:3644
    }
    return buf.extractChars(); // hdrgen.d:3646
}

/**
 * dmd/hdrgen.d:3658 — `private void parametersToBuffer(ParameterList pl, ref OutBuffer buf, ref`
 * `HdrGenState hgs)`. Write the parenthesised parameter list, including the `...` variadic tail.
 *
 * `final switch (pl.varargs)` is emitted in full with a `SwitchError` default (06 §3); the
 * `goto case VarArg.typesafe` out of the `variadic` arm is a SHARED-ARM fallthrough, reproduced by
 * TS case-fallthrough, which is what `goto case <the next case>` means (06 §3.6).
 */
function parametersToBuffer(pl: ParameterList, buf: OutBuffer, hgs: HdrGenState): void {
    buf.writeByte(0x28); // '(' — hdrgen.d:3660
    // hdrgen.d:3661 — `foreach (i; 0 .. pl.length)`: the bound is evaluated ONCE in D.
    const plLength = pl.length();
    for (let i = 0; i < plLength; i++) {
        if (i !== 0) // hdrgen.d:3663
            buf.writestring(ds(", "));
        // hdrgen.d:3665 — `pl[i].parameterToBuffer(buf, hgs)`: UFCS on a module-private free
        // function, rewritten to the free-call form (04 §6). `pl[i]` is non-null for i < length.
        parameterToBuffer(pl.opIndex(i)!, buf, hgs);
    }
    // hdrgen.d:3667 — `final switch (pl.varargs)`
    switch (pl.varargs) {
        case VarArg.none: // hdrgen.d:3669
        case VarArg.KRvariadic: // hdrgen.d:3670
            break;

        case VarArg.variadic: // hdrgen.d:3673
            if (pl.length() !== 0) // hdrgen.d:3674 — D re-reads `pl.length` here
                buf.writestring(ds(", "));

            if (stcToBuffer(buf, pl.stc)) // hdrgen.d:3677
                buf.writeByte(0x20); // ' '
            // hdrgen.d:3679 — `goto case VarArg.typesafe;`: the jump target is the very next case,
            // so TS's own case-fallthrough reproduces it exactly (06 §3.6) — no `break` here.
        // falls through
        case VarArg.typesafe: // hdrgen.d:3681
            buf.writestring(ds("...")); // hdrgen.d:3682
            break;

        default:
            throw new SwitchError(); // `final switch` exhaustiveness (06 §3)
    }
    buf.writeByte(0x29); // ')' — hdrgen.d:3686
}

/**
 * dmd/hdrgen.d:3696 — `private void parameterToBuffer(Parameter p, ref OutBuffer buf, ref`
 * `HdrGenState hgs)`. Write one parameter: UDAs, storage classes, type (or the parameter name for a
 * `__T`-named undetermined template type parameter), default argument.
 *
 * Preconditions: `p.type` is non-null on the non-`alias` paths — D dereferences it at
 * hdrgen.d:3740/:3749 with no null test (02 §10.1); likewise `p.ident` on the `__T` path (:3745).
 * The UDA leg (`argsToBuffer`, hdrgen.d:3769) and the default-argument leg (`expToBuffer`, :3871)
 * are live; each argument still halts in `expressionPrettyPrint` if its expression kind's arm is.
 */
function parameterToBuffer(p: Parameter, buf: OutBuffer, hgs: HdrGenState): void {
    if (p.userAttribDecl) { // hdrgen.d:3698
        buf.writeByte(0x40); // '@' — hdrgen.d:3700

        // hdrgen.d:3702 — `p.userAttribDecl.atts.length > 0 && !(*p.userAttribDecl.atts)[0].isCallExp()`.
        // `atts` is D's `UserAttributeDeclaration.atts` slot (attrib.d:706), an `Expressions*` that D dereferences
        // here with NO null test (it tests `atts is null` explicitly elsewhere, attrib.d:789, so the
        // absence is deliberate): `!` marks the D fault site, never a silent guard (02 §10.1).
        const atts = p.userAttribDecl.attsUda;
        const isAnonymous = atts!.length > 0 && atts!.opIndex(0)!.isCallExp() === null;
        if (isAnonymous) // hdrgen.d:3703
            buf.writeByte(0x28); // '('

        argsToBuffer(atts, buf, hgs); // hdrgen.d:3706

        if (isAnonymous) // hdrgen.d:3708
            buf.writeByte(0x29); // ')'
        buf.writeByte(0x20); // ' ' — hdrgen.d:3710
    }
    if (p.storageClass & STC.auto_) // hdrgen.d:3712
        buf.writestring(ds("auto "));

    let stc: STC = p.storageClass; // hdrgen.d:3715
    if (p.storageClass & STC.in_) { // hdrgen.d:3716
        buf.writestring(ds("in ")); // hdrgen.d:3718
        // hdrgen.d:3719: an `in` that means `const scope ref` drops the redundant `ref`.
        if ((p.storageClass & (STC.constscoperef | STC.ref_)) === (STC.constscoperef | STC.ref_))
            stc = (stc & ~STC.ref_) as STC; // branded STC re-cast after `&~` (02 §11.5c.4)
    } else if (p.storageClass & STC.lazy_) { // hdrgen.d:3722
        buf.writestring(ds("lazy "));
    } else if (p.storageClass & STC.alias_) { // hdrgen.d:3724
        buf.writestring(ds("alias "));
    }

    if (p.type && p.type.mod & MODFlags.shared_) // hdrgen.d:3727
        stc = (stc & ~STC.shared_) as STC; // branded STC re-cast after `&~` (02 §11.5c.4)

    // hdrgen.d:3730
    if (stcToBuffer(buf, (stc & (STC.const_ | STC.immutable_ | STC.wild | STC.shared_
        | STC.return_ | STC.returninferred | STC.scope_ | STC.scopeinferred | STC.out_ | STC.ref_
        | STC.returnScope)) as STC)) // branded STC re-cast after `&` (02 §11.5c.4)
        buf.writeByte(0x20); // ' '

    // hdrgen.d:3734 — `const(char)[] s;` declared ahead of the `else if` chain because D assigns
    // it INSIDE the condition (:3741) and reads it in the same condition (:3742).
    let s: DString;
    if (p.storageClass & STC.alias_) { // hdrgen.d:3735
        if (p.ident) // hdrgen.d:3737
            buf.writestring(p.ident.toString());
    } else if (p.type!.isTypeIdentifier() !== null // hdrgen.d:3740
               && (s = p.type!.isTypeIdentifier()!.ident!.toString()).length > 3 // hdrgen.d:3741
               && startsWith(s, ds("__T"))) { // hdrgen.d:3742 — `s[0..3] == "__T"`
        // hdrgen.d:3744 — print parameter name, instead of undetermined type parameter
        buf.writestring(p.ident!.toString()); // hdrgen.d:3745
    } else {
        // hdrgen.d:3749
        typeToBuffer(p.type!, p.ident, buf, hgs, (stc & STC.in_) ? MODFlags.const_ : 0);
    }

    if (p.defaultArg) { // hdrgen.d:3752
        buf.writestring(ds(" = ")); // hdrgen.d:3754
        // hdrgen.d:3755 — `p.defaultArg.expToBuffer(PREC.assign, buf, hgs)`: UFCS on a
        // module-private free function -> free-call form (04 §6). Swept: expToBuffer is live below
        // (dmd/hdrgen.d:3871).
        expToBuffer(p.defaultArg, PREC_assign, buf, hgs);
    }
}

/**************************************************
 * dmd/hdrgen.d:3769 — `private void argsToBuffer(Expressions* expressions, ref OutBuffer buf, ref`
 * `HdrGenState hgs, Expression basis = null, ArgumentLabels* names = null)`. Write out argument list
 * to buf.
 * Params:
 *     expressions = argument list
 *     buf = buffer to write to
 *     hgs = context
 *     basis = replace `null`s in argument list with this expression (for sparse array literals)
 *     names = if non-null, use these as the argument Labels for the arguments
 *
 * Postconditions: nothing is written for a null or empty list; a null element with a null `basis`
 * writes nothing but its separator. Each element prints at `PREC.assign`, so a comma expression
 * among the arguments is parenthesised.
 */
function argsToBuffer(expressions: Expressions | null, buf: OutBuffer, hgs: HdrGenState,
    basis: Expression | null = null, names: ArgumentLabels | null = null): void {
    if (!expressions || !expressions.length) // hdrgen.d:3771
        return;
    // resolved: version(all) -> always on (hdrgen.d:3773). The `else` arm (hdrgen.d:3791-3817, the
    // "sparse style formatting, for debug use only") is never compiled and is not emitted.
    // hdrgen.d:3775 — `foreach (i, el; *expressions)`: `el` is a by-value loop copy of a class
    // reference, so the `el = basis` rebind below never touches the array.
    for (let i = 0; i < expressions.length; i++) {
        let el = expressions.opIndex(i);
        if (i) // hdrgen.d:3777
            buf.writestring(ds(", "));

        // hdrgen.d:3780 — `(*names)[i].name` reads a field of the by-value `ArgumentLabel` element in
        // place (no copy is taken, so no `.copy()`, 03 §1).
        if (names && i < names.length && names.opIndex(i).name) {
            buf.writestring(names.opIndex(i).name!.toString()); // hdrgen.d:3782
            buf.writestring(ds(": "));
        }
        if (!el) // hdrgen.d:3785
            el = basis;
        if (el) // hdrgen.d:3787
            expToBuffer(el, PREC_assign, buf, hgs);
    }
}

/**
 * dmd/hdrgen.d:3820 — `private void sizeToBuffer(Expression e, ref OutBuffer buf, ref HdrGenState`
 * `hgs)`. Print an array dimension / allocation size: a `size_t`-typed value that folds to an
 * integer constant prints as a bare decimal up to 0xFFFF and as `cast(size_t)<n>` up to `long.max`;
 * anything else prints as an ordinary expression at `PREC.assign`.
 *
 * Cost: runs `optimize(WANTvalue)` on the (uncast) operand, which may allocate a folded copy.
 */
function sizeToBuffer(e: Expression, buf: OutBuffer, hgs: HdrGenState): void {
    if (e.type === Type.tsize_t) { // hdrgen.d:3822 — class `==` without opEquals is identity (05 §2)
        // hdrgen.d:3824 — `(cast(CastExp)e).e1` under `e.op == EXP.cast_`: `isCastExp()` tests the same
        // op, so the first `!` is the proven downcast; the second marks D's untested use of `e1`
        // (optimize dereferences it on the next line, 02 §10.1).
        let ex: Expression = e.op === EXP.cast_ ? e.isCastExp()!.e1! : e;
        // hdrgen.d:3825 — `ex.optimize(WANTvalue)`, UFCS (04 §6), through the `dmd.optimize` slot (see
        // the block under the imports): an empty slot is the load-order contract, not a D branch.
        if (optimizeSlot === undefined)
            throw new Error("hdrgen.sizeToBuffer: registerOptimize not called (dmd/optimize.d:274)");
        ex = optimizeSlot(ex, WANTvalue);
        // hdrgen.d:3826 — `ulong` -> bigint (09 §1); `cast(ulong)-1` is 2^64 - 1.
        const uval: bigint = ex.op === EXP.int64 ? ex.isIntegerExp()!.value : 0xFFFF_FFFF_FFFF_FFFFn;
        if (BigInt.asIntN(64, uval) >= 0n) { // hdrgen.d:3827 — `cast(long)uval >= 0` (09 §4)
            if (uval <= 0xFFFFn) { // hdrgen.d:3829
                buf.print(uval);
                return;
            }
            if (uval <= 0x7FFF_FFFF_FFFF_FFFFn) { // hdrgen.d:3834
                buf.writestring(ds("cast(size_t)"));
                buf.print(uval);
                return;
            }
        }
    }
    expToBuffer(e, PREC_assign, buf, hgs); // hdrgen.d:3842
}

/**
 * dmd/hdrgen.d:3845 — `private void expressionToBuffer(Expression e, ref OutBuffer buf, ref`
 * `HdrGenState hgs)`. Thin forward to `expressionPrettyPrint`, WITHOUT precedence parentheses.
 */
function expressionToBuffer(e: Expression, buf: OutBuffer, hgs: HdrGenState): void {
    expressionPrettyPrint(e, buf, hgs);
}

/**
 * dmd/hdrgen.d:3851 — `private PREC expPrecedence(ref HdrGenState hgs, Expression e)`.
 * to be called if e could be loweredFrom another expression instead of acessing precedence[e.op]
 * directly: outside `-vcg-ast`, a lowered call or `!` takes the precedence of the source expression
 * it was lowered from.
 */
function expPrecedence(hgs: HdrGenState, e: Expression): PREC {
    if (!hgs.vcg_ast) { // hdrgen.d:3853
        const ce = e.isCallExp();
        if (ce) { // hdrgen.d:3855
            if (ce.loweredFrom)
                e = ce.loweredFrom;
        } else {
            const ne = e.isNotExp();
            if (ne) // hdrgen.d:3860
                if (ne.loweredFrom)
                    e = ne.loweredFrom;
        }
    }
    return precedenceAt("expPrecedence", e.op); // hdrgen.d:3864 — `precedence[e.op]`, through the `dmd.parse` slot
}

/**************************************************
 * dmd/hdrgen.d:3871 — `private void expToBuffer(Expression e, PREC pr, ref OutBuffer buf, ref`
 * `HdrGenState hgs)`. Write expression out to buf, but wrap it in ( ) if its precedence is less than
 * pr.
 *
 * Preconditions: `pr` and the precedence of `e` are both non-zero — D asserts both (hdrgen.d:3884),
 * so an EXP with no precedence entry is a loud failure, not a silent unparenthesised print. The one
 * exception is `EXP.interpolated`, parenthesised as release ldc2 does (declared divergence, file header).
 */
function expToBuffer(e: Expression, pr: PREC, buf: OutBuffer, hgs: HdrGenState): void {
    const prec = expPrecedence(hgs, e); // hdrgen.d:3873
    // dropped: debug block (hdrgen.d:3874-3878, non-debug build — _config.md §3): the
    // "precedence not defined" printf that precedes the assert below.
    // hdrgen.d:3879 — `e.op == 0xFF`. EXP is a `ubyte` enum with no 0xFF member, so the test reads the
    // op through its `number` carrier (a plain widening assignment, no cast); the test itself is D's.
    const op: number = e.op;
    if (op === 0xFF) {
        buf.writestring(ds("<FF>"));
        return;
    }
    // hdrgen.d:3884, declared divergence (file header): release ldc2 drops this assert, and an InterpExp, which
    // parse.d's precedence table leaves at zero, takes the `prec < pr` arm below. Probe: `auto g(T)(T t =
    // i"val $(1 + 2) end")` under `-X` prints `(T t = (i\"val $(1 + 2) end\"))`.
    assert(prec !== PREC_zero || e.op === EXP.interpolated);
    assert(pr !== PREC_zero); // hdrgen.d:3885
    /* Despite precedence, we don't allow a<b<c expressions.
     * They must be parenthesized.
     */
    if (prec < pr || (pr === PREC_rel && prec === pr)
        || (pr >= PREC_or && pr <= PREC_and && prec === PREC_rel)) { // hdrgen.d:3889
        buf.writeByte(0x28); // '('
        expressionToBuffer(e, buf, hgs); // hdrgen.d:3893 — UFCS `e.expressionToBuffer(...)` (04 §6)
        buf.writeByte(0x29); // ')'
    } else {
        expressionToBuffer(e, buf, hgs); // hdrgen.d:3898
    }
}

/**
 * dmd/hdrgen.d:3906 — `private void typeToBuffer(Type t, const Identifier ident, ref OutBuffer buf,`
 * `ref HdrGenState hgs, ubyte modMask = 0)`. An entry point to pretty-print type: `t` (and a trailing
 * ` ident` for declarations). A TypeFunction prints in the prefix declaration form
 * (`int f(args)`), through `visitFuncIdentWithPrefix`.
 */
function typeToBuffer(t: Type, ident: Identifier | null, buf: OutBuffer, hgs: HdrGenState, modMask = 0): void {
    const tf = t.isTypeFunction();
    if (tf) { // hdrgen.d:3909
        visitFuncIdentWithPrefix(tf, ident, null, buf, hgs);
        return;
    }
    visitWithMask(t, modMask, buf, hgs);
    if (ident !== null) {
        buf.writeByte(0x20); // ' '
        buf.writestring(ident.toString());
    }
}

/**
 * dmd/hdrgen.d:3922 — `private void visitWithMask(Type t, ubyte modMask, ref OutBuffer buf, ref`
 * `HdrGenState hgs)`. Print `t`, wrapping the mod bits NOT already covered by `modMask` as
 * `shared(…)`/`inout(…)`/`const(…)`/`immutable(…)`. Fully live.
 */
function visitWithMask(t: Type, modMask: number, buf: OutBuffer, hgs: HdrGenState): void {
    // hdrgen.d:3924 — Tuples and functions don't use the type constructor syntax
    if (modMask === t.mod || t.ty === TY.Tfunction || t.ty === TY.Ttuple) {
        typeToBufferx(t, buf, hgs);
    } else {
        const m = t.mod & ~(t.mod & modMask); // hdrgen.d:3931
        if (m & MODFlags.shared_) {
            MODtoBuffer(buf, MODFlags.shared_);
            buf.writeByte(0x28); // '('
        }
        if (m & MODFlags.wild) {
            MODtoBuffer(buf, MODFlags.wild);
            buf.writeByte(0x28); // '('
        }
        if (m & (MODFlags.const_ | MODFlags.immutable_)) {
            MODtoBuffer(buf, m & (MODFlags.const_ | MODFlags.immutable_));
            buf.writeByte(0x28); // '('
        }
        typeToBufferx(t, buf, hgs);
        if (m & (MODFlags.const_ | MODFlags.immutable_))
            buf.writeByte(0x29); // ')'
        if (m & MODFlags.wild)
            buf.writeByte(0x29); // ')'
        if (m & MODFlags.shared_)
            buf.writeByte(0x29); // ')'
    }
}

/**
 * dmd/hdrgen.d:3958 — `private void dumpTemplateInstance(TemplateInstance ti, ref OutBuffer buf, ref`
 * `HdrGenState hgs)`. The `-vcg-ast` dump of an instance's body: `{`, then the alias declaration or
 * every member through the Dsymbol printer, one indent level deeper, then `}`.
 *
 * `buf.level` is paired state on the CALLER's buffer (11 §2.5 rule (d)): the decrement is kept on
 * every exit, including a throw out of a printer below it (a wall in a callee).
 */
function dumpTemplateInstance(ti: TemplateInstance, buf: OutBuffer, hgs: HdrGenState): void {
    buf.writeByte(0x7B); // '{' — hdrgen.d:3960
    buf.writenl();
    buf.level++; // hdrgen.d:3962
    // Paired state: D releases with a plain `buf.level--;` at region end (hdrgen.d:3975) and has no
    // other exit, so that one statement moves into `finally` — released once on the normal path, and
    // also on a throw from a printer below.
    try {
        // D reaches dsymbolToBuffer by UFCS (`ti.aliasdecl.dsymbolToBuffer(buf, hgs)`), rewritten to the
        // free-call form (04 §6).
        if (ti.aliasdecl) { // hdrgen.d:3964
            dsymbolToBuffer(ti.aliasdecl, buf, hgs); // hdrgen.d:3966
            buf.writenl();
        } else if (ti.members) { // hdrgen.d:3969
            // hdrgen.d:3971 — `foreach(m;*ti.members)`; a member slot is non-null (D calls through it).
            for (let i = 0; i < ti.members.length; i++)
                dsymbolToBuffer(ti.members.opIndex(i)!, buf, hgs); // hdrgen.d:3972
        }
    } finally {
        buf.level--; // hdrgen.d:3975
    }
    buf.writeByte(0x7D); // '}' — hdrgen.d:3976
    buf.writenl();
}

/**
 * dmd/hdrgen.d:3981 — `private void tiargsToBuffer(TemplateInstance ti, ref OutBuffer buf, ref`
 * `HdrGenState hgs)`. Print the `!…` template-argument suffix of an instance: `!(...)` while the
 * instance is already being printed (recursion), `!()` with no arguments, the bare `!arg` form for
 * a single simple type or literal, else `!(a, b, …)`.
 *
 * `ti`'s nest counter is paired state on the instance (11 §2.5): `nestDown` runs on every exit
 * after `nestUp`, including a throw out of a walled printer below.
 */
function tiargsToBuffer(ti: TemplateInstance, buf: OutBuffer, hgs: HdrGenState): void {
    buf.writeByte(0x21); // '!' — hdrgen.d:3983
    if (ti.nest) { // hdrgen.d:3984
        buf.writestring(ds("(...)"));
        return;
    }
    if (!ti.tiargs) { // hdrgen.d:3989
        buf.writestring(ds("()"));
        return;
    }
    if (ti.tiargs.length === 1) { // hdrgen.d:3994
        const oarg = ti.tiargs.opIndex(0); // hdrgen.d:3996
        const t = isType(oarg);
        if (t) { // hdrgen.d:3997
            // hdrgen.d:3999 — `(cast(TypeIdentifier)t).idents` under `t.ty == Tident`: the
            // `isTypeIdentifier()` family tests that same ty, so `!` is the proven downcast.
            if (t.equals(Type.tstring) || t.equals(Type.twstring) || t.equals(Type.tdstring)
                || t.mod === 0 && (t.isTypeBasic() !== null
                    || t.ty === TY.Tident && t.isTypeIdentifier()!.idents.length === 0)) {
                const hgs2 = new HdrGenState(); // re-examine need for new hgs — hdrgen.d:4001
                hgs2.fullQual = (t.ty === TY.Tclass && !t.mod); // hdrgen.d:4002
                // hdrgen.d:4003 — `toCBuffer(t, buf, null, hgs2)`, the Type overload
                typeToCBuffer(t, buf, null, hgs2);
                return;
            }
        } else {
            const e = isExpression(oarg);
            if (e) { // hdrgen.d:4007
                // hdrgen.d:4009 — D's precedence kept: `&&` binds the first two operands only.
                if (!(e.type && e.type.isTypeEnum() !== null) && e.op === EXP.int64 || e.op === EXP.float64
                    || e.op === EXP.null_ || e.op === EXP.string_ || e.op === EXP.this_) {
                    expToCBuffer(e, buf, hgs); // hdrgen.d:4012 — `toCBuffer(e, buf, hgs)`, the Expression overload
                    return;
                }
            }
        }
    }
    buf.writeByte(0x28); // '(' — hdrgen.d:4017
    ti.nestUp(); // hdrgen.d:4018
    // Paired state: D releases with a plain `ti.nestDown();` at region end (hdrgen.d:4025) and has no
    // other exit, so that one statement moves into `finally` (same shape as dumpTemplateInstance).
    try {
        const tiargs = ti.tiargs;
        // hdrgen.d:4019 — `foreach (i, arg; *ti.tiargs)`
        for (let i = 0; i < tiargs.length; i++) {
            const arg = tiargs.opIndex(i);
            if (i) // hdrgen.d:4021
                buf.writestring(ds(", "));
            objectToBuffer(arg, buf, hgs); // hdrgen.d:4023
        }
    } finally {
        ti.nestDown(); // hdrgen.d:4025
    }
    buf.writeByte(0x29); // ')' — hdrgen.d:4026
}

/****************************************
 * dmd/hdrgen.d:4033 — `private void objectToBuffer(RootObject oarg, ref OutBuffer buf, ref`
 * `HdrGenState hgs)`. This makes a 'pretty' version of the template arguments. It's analogous to
 * genIdent() which makes a mangled version.
 *
 * Dispatch order is D's: type, expression (a variable is first folded by `optimize(WANTvalue)`),
 * symbol (its identifier, else `toChars()`), tuple (elements comma-separated, recursively),
 * parameter, `null` -> `NULL`. Any other RootObject is D's `assert(0)`.
 */
function objectToBuffer(oarg: RootObject | null, buf: OutBuffer, hgs: HdrGenState): void {
    //printf("objectToBuffer()\n");   (commented out upstream, hdrgen.d:4035)
    /* The logic of this should match what genIdent() does. The _dynamic_cast()
     * function relies on all the pretty strings to be unique for different classes
     * See https://issues.dlang.org/show_bug.cgi?id=7375
     * Perhaps it would be better to demangle what genIdent() does.
     */
    // The if/else-if chain declares each classified local in its own `if (auto x = …)` in D; the
    // port evaluates the classifiers in the same order, each only when the previous one failed.
    const t = isType(oarg);
    if (t) { // hdrgen.d:4041
        typeToBuffer(t, null, buf, hgs); // hdrgen.d:4044
        return;
    }
    let e = isExpression(oarg);
    if (e) { // hdrgen.d:4046
        if (e.op === EXP.variable) {
            // hdrgen.d:4049 — `e.optimize(WANTvalue)` through the `dmd.optimize` slot (see the block
            // under the imports); an empty slot raises instead of printing the unfolded variable.
            if (optimizeSlot === undefined)
                throw new Error("hdrgen.objectToBuffer: registerOptimize not called (dmd/optimize.d:274)");
            e = optimizeSlot(e, WANTvalue); // added to fix https://issues.dlang.org/show_bug.cgi?id=7375
        }
        expToBuffer(e, PREC_assign, buf, hgs); // hdrgen.d:4050
        return;
    }
    const s = isDsymbol(oarg);
    if (s) { // hdrgen.d:4052
        if (s.ident) {
            buf.writestring(s.ident.toString());
        } else {
            // hdrgen.d:4057: `buf.put(const(char)*)` writes up to the first NUL; `toChars()` may hand
            // back an `extractChars()` result that carries it, hence `cstr` (02 §11.2).
            buf.writestring(cstr(s.toChars()));
        }
        return;
    }
    const v = isTuple(oarg);
    if (v) { // hdrgen.d:4059
        const args = v.objects; // hdrgen.d:4061 — `&v.objects`: a pointer to the field, no copy
        for (let i = 0; i < args.length; i++) {
            const arg = args.opIndex(i);
            if (i) // hdrgen.d:4064
                buf.writestring(ds(", "));
            objectToBuffer(arg, buf, hgs); // hdrgen.d:4066
        }
        return;
    }
    const p = isParameter(oarg);
    if (p) { // hdrgen.d:4069
        parameterToBuffer(p, buf, hgs); // hdrgen.d:4071
        return;
    }
    if (!oarg) { // hdrgen.d:4073
        buf.writestring(ds("NULL"));
        return;
    }
    // dropped: debug block (hdrgen.d:4079-4082, non-debug build — _config.md §3): `printf("bad
    // Object = %p\n", oarg);`.
    assertUnreachable(); // hdrgen.d:4083 — D's own `assert(0)`, ordinary translated code
}

/**
 * dmd/hdrgen.d:4088 — `private void visitFuncIdentWithPostfix(TypeFunction t, const char[] ident, ref`
 * `OutBuffer buf, ref HdrGenState hgs, bool isStatic)`. The POSTFIX-attribute function printer:
 * `[extern (L) ][static ]<ret> <ident>(<params>)[ <mod>][ <attr>…]`. `ident` null prints no name
 * (D tests the slice's pointer, not its length: an empty non-null name still gets the space).
 *
 * Recursion guard: a `t` already being printed is skipped, and `t.inuse = 2` flags it to the caller.
 * `t.inuse` and `hgs.inFuncReturn` are paired state that outlives this call (11 §2.5): both are
 * restored on every exit, including a throw out of a walled type printer.
 */
function visitFuncIdentWithPostfix(t: TypeFunction, ident: DString | null, buf: OutBuffer, hgs: HdrGenState,
    isStatic: boolean): void {
    if (t.inuse) { // hdrgen.d:4090
        t.inuse = 2; // flag error to caller
        return;
    }
    t.inuse++; // hdrgen.d:4095
    // Paired state: D releases with a plain `t.inuse--;` at region end (hdrgen.d:4131) and has no
    // other exit, so that one statement moves into `finally`.
    try {
        // hdrgen.d:4096 — `hgs.ddoc != 1`: a `bool` promoted to int, so it is `!hgs.ddoc`.
        if (t.linkage > LINK.d && !hgs.ddoc && !hgs.hdrgen) {
            linkageToBuffer(buf, t.linkage); // hdrgen.d:4098
            buf.writeByte(0x20); // ' '
        }
        if (t.linkage === LINK.objc && isStatic) // hdrgen.d:4101
            buf.write(ds("static "));
        if (t.next) { // hdrgen.d:4103
            hgs.inFuncReturn = true;
            // Paired state on the caller's `hgs`: D resets it with a plain statement right after the
            // call (hdrgen.d:4107) — moved into `finally`, protected per pair (11 §2.5 rule (b)).
            try {
                typeToBuffer(t.next, null, buf, hgs); // hdrgen.d:4106
            } finally {
                hgs.inFuncReturn = false; // hdrgen.d:4107
            }
            if (ident !== null) // hdrgen.d:4108
                buf.writeByte(0x20); // ' '
        } else if (hgs.ddoc) // hdrgen.d:4111
            buf.writestring(ds("auto "));
        if (ident !== null) // hdrgen.d:4113
            buf.writestring(ident);
        parametersToBuffer(t.parameterList.copy(), buf, hgs); // hdrgen.d:4115 — by-value struct (03 §1)
        /* Use postfix style for attributes
         */
        if (t.mod) { // hdrgen.d:4118
            buf.writeByte(0x20); // ' '
            MODtoBuffer(buf, t.mod);
        }

        // hdrgen.d:4124 — nested `void dg(string str)`, handed to `attributesApply` as `&dg`.
        const dg = (str: string): void => {
            buf.writeByte(0x20); // ' '
            buf.writestring(ds(str));
        };
        attributesApply(t, dg); // hdrgen.d:4129 — `t.attributesApply(&dg)`, UFCS (04 §6)
    } finally {
        t.inuse--; // hdrgen.d:4131
    }
}

/**
 * dmd/hdrgen.d:4134 — `private void visitFuncIdentWithPrefix(TypeFunction t, const Identifier ident,`
 * `TemplateDeclaration td, ref OutBuffer buf, ref HdrGenState hgs)`. The PREFIX-attribute function
 * printer, and the one every TypeFunction reaches through `typeToBuffer`:
 * `[<mod> ][<attr> …][extern (L) ]<ret> <ident>[(<template params>)](<params>)[ <mod>][ return scope]`.
 *
 * `ident` prints through `toHChars2()`; when that differs from `toChars()` (a ctor, dtor, unittest,
 * invariant, …) no return type is printed, and for a ctor the `ref` attribute is dropped. `return`
 * and `scope` never print in the prefix position; they come last, from the TypeFunction's own flags.
 * The mod prints as a prefix, except under `ddoc`/`hdrgen`, where it prints after the parameters.
 * Recursion guard and paired state exactly as in `visitFuncIdentWithPostfix`.
 */
function visitFuncIdentWithPrefix(t: TypeFunction, ident: Identifier | null, td: TemplateDeclaration | null,
    buf: OutBuffer, hgs: HdrGenState): void {
    if (t.inuse) { // hdrgen.d:4137
        t.inuse = 2; // flag error to caller
        return;
    }
    t.inuse++; // hdrgen.d:4142
    // Paired state: D releases with a plain `t.inuse--;` at region end (hdrgen.d:4216) and has no
    // other exit, so that one statement moves into `finally`.
    try {
        /* Use 'storage class' (prefix) style for attributes
         */
        if (t.mod && !(hgs.ddoc || hgs.hdrgen)) { // hdrgen.d:4146
            MODtoBuffer(buf, t.mod);
            buf.writeByte(0x20); // ' '
        }

        // hdrgen.d:4152 — nested `void dg(string str)`, handed to `attributesApply` as `&dg`.
        const dg = (str: string): void => {
            if (str !== "return" && str !== "scope") {
                // don't write 'ref' for ctors
                if ((ident === Id.ctor) && str === "ref") // hdrgen.d:4157 — Identifier `==` is identity
                    return;
                buf.writestring(ds(str));
                buf.writeByte(0x20); // ' '
            }
        };
        attributesApply(t, dg); // hdrgen.d:4163 — `t.attributesApply(&dg)`, UFCS (04 §6)

        // hdrgen.d:4165 — `hgs.ddoc != 1`: a `bool` promoted to int, so it is `!hgs.ddoc`.
        if (t.linkage > LINK.d && !hgs.ddoc && !hgs.hdrgen) {
            linkageToBuffer(buf, t.linkage); // hdrgen.d:4167
            buf.writeByte(0x20); // ' '
        }
        // hdrgen.d:4170 — `ident.toHChars2() != ident.toChars()` compares two `const(char)*` POINTERS:
        // toHChars2 returns either a literal ("this", "~this", …) or `toChars()` itself, so this asks
        // "is this a special name?". identifier.ts keeps that identity (toHChars2's fall-through
        // returns the same `name` object `toChars()` does), so `!==` is the faithful compare.
        if (ident && ident.toHChars2() !== ident.toChars()) {
            // Don't print return type for ctor, dtor, unittest, etc
        } else if (t.next) { // hdrgen.d:4174
            hgs.inFuncReturn = true;
            // Paired state on the caller's `hgs` (hdrgen.d:4178), protected per pair (11 §2.5 (b)).
            try {
                typeToBuffer(t.next, null, buf, hgs); // hdrgen.d:4177
            } finally {
                hgs.inFuncReturn = false; // hdrgen.d:4178
            }
            if (ident) // hdrgen.d:4179
                buf.writeByte(0x20); // ' '
        } else if (hgs.ddoc) // hdrgen.d:4182
            buf.writestring(ds("auto "));
        if (ident) // hdrgen.d:4184
            buf.writestring(ident.toHChars2()); // hdrgen.d:4185 — no NUL: name or literal
        if (td) { // hdrgen.d:4186
            buf.writeByte(0x28); // '('
            // hdrgen.d:4189 — `foreach (i, p; *td.origParameters)`: D dereferences `origParameters`
            // with no null test, and calls through each slot, so `!` marks both fault sites (02 §10.1).
            const origParameters = td.origParameters!;
            for (let i = 0; i < origParameters.length; i++) {
                const p = origParameters.opIndex(i);
                if (i) // hdrgen.d:4191
                    buf.writestring(ds(", "));
                templateParameterToCBuffer(p!, buf, hgs); // hdrgen.d:4193 — `toCBuffer(p, buf, hgs)`
            }
            buf.writeByte(0x29); // ')'
        }
        parametersToBuffer(t.parameterList.copy(), buf, hgs); // hdrgen.d:4197 — by-value struct (03 §1)
        // postfix this attributes are more readable
        if (t.mod && (hgs.ddoc || hgs.hdrgen)) { // hdrgen.d:4199
            buf.writeByte(0x20); // ' '
            MODtoBuffer(buf, t.mod);
        }
        if (t.isReturnScope && !t.isReturnInferred) { // hdrgen.d:4204
            buf.writestring(ds(" return scope"));
        } else if (t.isScopeQual && !t.isScopeInferred) { // hdrgen.d:4208
            buf.writestring(ds(" scope"));
        }
        if (t.isReturn && !t.isReturnScope && !t.isReturnInferred) { // hdrgen.d:4212
            buf.writestring(ds(" return"));
        }
    } finally {
        t.inuse--; // hdrgen.d:4216
    }
}

/**
 * dmd/hdrgen.d:4220 — `private void initializerToBuffer(Initializer inx, ref OutBuffer buf, ref`
 * `HdrGenState hgs)`. The per-kind initializer printer: `void`, `{ }`, `__error__`, the struct form
 * `{a:1, 2}`, the array form `[0:x, y]`, a plain expression, and the C form `{[0]=x, .f=y}`.
 *
 * Preconditions: each slot D prints through is non-null where D dereferences it untested
 * (`ei.exp`, `di.initializer`, a designator's `ident` when it has no `exp`) — `!` marks those D
 * fault sites (02 §10.1). Null `value[i]` slots of the struct / array forms are skipped, as in D.
 */
function initializerToBuffer(inx: Initializer, buf: OutBuffer, hgs: HdrGenState): void {
    // The nested visitors keep D's own names and parameter names (13 §7.5 rule 3); an unused one takes
    // the `_` prefix for `noUnusedParameters`, as `typeToBufferx`'s `visitType` does.
    // hdrgen.d:4222-4225 — visitError
    const visitError = (_iz: ErrorInitializer): void => {
        buf.writestring(ds("__error__"));
    };

    // hdrgen.d:4227-4230 — visitVoid
    const visitVoid = (_iz: VoidInitializer): void => {
        buf.writestring(ds("void"));
    };

    // hdrgen.d:4232-4235 — visitDefault
    const visitDefault = (_iz: DefaultInitializer): void => {
        buf.writestring(ds("{ }"));
    };

    // hdrgen.d:4237-4254 — visitStruct: `field[i]:` then `value[i]`, comma-separated, in braces.
    const visitStruct = (si: StructInitializer): void => {
        //printf("StructInitializer::toCBuffer()\n");   (commented out upstream, hdrgen.d:4239)
        buf.writeByte(0x7B); // '{' — hdrgen.d:4240
        // hdrgen.d:4241 — `foreach (i, const id; si.field)`
        for (let i = 0; i < si.field.length; i++) {
            const id = si.field.opIndex(i);
            if (i) // hdrgen.d:4243
                buf.writestring(ds(", "));
            if (id) { // hdrgen.d:4245
                buf.writestring(id.toString());
                buf.writeByte(0x3A); // ':'
            }
            const iz = si.value.opIndex(i);
            if (iz) // hdrgen.d:4250
                initializerToBuffer(iz, buf, hgs);
        }
        buf.writeByte(0x7D); // '}' — hdrgen.d:4253
    };

    // hdrgen.d:4256-4272 — visitArray: `index[i]:` then `value[i]`, comma-separated, in brackets.
    const visitArray = (ai: ArrayInitializer): void => {
        buf.writeByte(0x5B); // '[' — hdrgen.d:4258
        // hdrgen.d:4259 — `foreach (i, ex; ai.index)`
        for (let i = 0; i < ai.index.length; i++) {
            const ex = ai.index.opIndex(i);
            if (i) // hdrgen.d:4261
                buf.writestring(ds(", "));
            if (ex) { // hdrgen.d:4263
                expressionToBuffer(ex, buf, hgs); // hdrgen.d:4265 — UFCS `ex.expressionToBuffer(...)` (04 §6)
                buf.writeByte(0x3A); // ':'
            }
            const iz = ai.value.opIndex(i);
            if (iz) // hdrgen.d:4268
                initializerToBuffer(iz, buf, hgs);
        }
        buf.writeByte(0x5D); // ']' — hdrgen.d:4271
    };

    // hdrgen.d:4274-4277 — visitExp
    const visitExp = (ei: ExpInitializer): void => {
        expressionToBuffer(ei.exp!, buf, hgs); // hdrgen.d:4276 — UFCS (04 §6); D derefs `exp` untested
    };

    // hdrgen.d:4279-4307 — visitC: the C initializer list, each element with its designators.
    const visitC = (ci: CInitializer): void => {
        buf.writeByte(0x7B); // '{' — hdrgen.d:4281
        // hdrgen.d:4282 — `foreach (i, ref DesigInit di; ci.initializerList)`: by `ref`, so the element
        // object itself, no `.copy()` (03 §4).
        for (let i = 0; i < ci.initializerList.length; i++) {
            const di = ci.initializerList.opIndex(i);
            if (i) // hdrgen.d:4284
                buf.writestring(ds(", "));
            if (di.designatorList) { // hdrgen.d:4286
                // hdrgen.d:4288 — `foreach (ref Designator d; (*di.designatorList)[])`: by `ref` over the
                // live elements, so each `d` is the stored object (03 §4).
                const designatorList = di.designatorList;
                for (let j = 0; j < designatorList.length; j++) {
                    const d = designatorList.opIndex(j);
                    if (d.exp) { // hdrgen.d:4290
                        buf.writeByte(0x5B); // '['
                        expToCBuffer(d.exp, buf, hgs); // hdrgen.d:4293 — `toCBuffer(d.exp, buf, hgs)`
                        buf.writeByte(0x5D); // ']'
                    } else {
                        buf.writeByte(0x2E); // '.' — hdrgen.d:4298
                        buf.writestring(d.ident!.toString()); // hdrgen.d:4299 — D derefs `ident` untested
                    }
                }
                buf.writeByte(0x3D); // '=' — hdrgen.d:4302
            }
            initializerToBuffer(di.initializer!, buf, hgs); // hdrgen.d:4304
        }
        buf.writeByte(0x7D); // '}' — hdrgen.d:4306
    };

    // hdrgen.d:4309 — `mixin VisitInitializer!void visit;` + hdrgen.d:4310 `visit.VisitInitializer(inx);`.
    // resolved: mixin VisitInitializer!void + visitCase -> inlined dispatch switch (07 §6.2, 13 §7.6
    // rule 1: the generated switch is emitted INLINE, in FULL). With `Result = void` each generated
    // case is `auto ix = init.isXInitializer(); visitX(ix);` (init.d:396-403's `static if (is(Result ==
    // void))` arm), and init.d:383's trailing `return Result.init;` resolves away. `ix!`: the tag test
    // inside `isXInitializer()` has matched on each arm, the non-null guarantee D's `auto ix` carries.
    switch (inx.kind) {
        case InitKind.void_: {
            const ix = inx.isVoidInitializer();
            visitVoid(ix!);
            break;
        }
        case InitKind.default_: {
            const ix = inx.isDefaultInitializer();
            visitDefault(ix!);
            break;
        }
        case InitKind.error: {
            const ix = inx.isErrorInitializer();
            visitError(ix!);
            break;
        }
        case InitKind.struct_: {
            const ix = inx.isStructInitializer();
            visitStruct(ix!);
            break;
        }
        case InitKind.array: {
            const ix = inx.isArrayInitializer();
            visitArray(ix!);
            break;
        }
        case InitKind.exp: {
            const ix = inx.isExpInitializer();
            visitExp(ix!);
            break;
        }
        case InitKind.C_: {
            const ix = inx.isCInitializer();
            visitC(ix!);
            break;
        }
        default: {
            // final switch: D throws SwitchError on an unhandled value (06 §3.2)
            const _exhaustive: never = inx.kind;
            void _exhaustive;
            throw new SwitchError();
        }
    }
}

/**
 * dmd/hdrgen.d:4314 — `private void typeToBufferx(Type t, ref OutBuffer buf, ref HdrGenState hgs)`.
 * The per-`ty` type printer: every nested visitor of D is ported, and the dispatch (hdrgen.d:4566)
 * is emitted IN FULL (13 §7.5 rule 1). A `TypeInstance` and a template-instance component of a
 * qualified type name print through the Dsymbol printer (`dsymbolToBuffer`, hdrgen.d:975).
 */
function typeToBufferx(t: Type, buf: OutBuffer, hgs: HdrGenState): void {
    // The nested visitors keep D's own parameter names (`t`), which SHADOW this function's `t`
    // exactly as D's nested functions do (01 §2 identifier fidelity; 13 §7.5 rule 3). An unused one
    // takes the `_` prefix for `noUnusedParameters`.

    // hdrgen.d:4316-4320 — visitType: D's "should never get here" arm.
    const visitType = (_t: Type): void => {
        // dropped: `printf("t = %p, ty = %d\n", t, t.ty);` (hdrgen.d:4318) — `%p` prints a raw
        // address, which has no JS counterpart; the assert(0) below is the observable behaviour.
        // (`_t` is the underscore escape for an otherwise-unused parameter, `noUnusedParameters`.)
        assertUnreachable(); // hdrgen.d:4319 — D's own `assert(0)`, ordinary translated code
    };

    // hdrgen.d:4322-4325 — visitError
    const visitError = (_t: TypeError): void => {
        buf.writestring(ds("_error_"));
    };

    // hdrgen.d:4327-4331 — visitBasic: `buf.put(t.dstring);` (the token spelling set by the ctor).
    const visitBasic = (t: TypeBasic): void => {
        buf.writestring(ds(t.dstring!));
    };

    // hdrgen.d:4333-4337 — visitTraits: the `__traits(...)` expression itself.
    const visitTraits = (t: TypeTraits): void => {
        //printf("TypeBasic::toCBuffer2(t.mod = %d)\n", t.mod);   (commented out upstream, hdrgen.d:4335)
        expressionToBuffer(t.exp!, buf, hgs); // hdrgen.d:4336 — UFCS (04 §6); D derefs `exp` untested
    };

    // hdrgen.d:4339-4345 — visitVector: `__vector(<basetype>)`, the basetype under this type's mod.
    const visitVector = (t: TypeVector): void => {
        //printf("TypeVector::toCBuffer2(t.mod = %d)\n", t.mod);   (commented out upstream, hdrgen.d:4341)
        buf.writestring(ds("__vector("));
        visitWithMask(t.basetype, t.mod, buf, hgs); // hdrgen.d:4343
        buf.writestring(ds(")"));
    };

    // hdrgen.d:4347-4353 — visitSArray: `T[dim]`, the dimension through sizeToBuffer.
    const visitSArray = (t: TypeSArray): void => {
        visitWithMask(t.next!, t.mod, buf, hgs); // hdrgen.d:4349 — D derefs `next` untested
        buf.writeByte(0x5B); // '['
        sizeToBuffer(t.dim!, buf, hgs); // hdrgen.d:4351 — D derefs `dim` untested
        buf.writeByte(0x5D); // ']'
    };

    // hdrgen.d:4355-4372 — visitDArray. The 1.43 body tests the ELEMENT type's `ty` + `isImmutable`
    // (upstream 386341c581 removed the older `castMod(0)` + `Type.tstring` compare, which broke
    // hdrgen's semantic dependency on typesem — so no `castMod` call exists here to defer).
    const visitDArray = (t: TypeDArray): void => {
        const basetype = t.next!; // hdrgen.d:4357
        // hdrgen.d:4358-4359 — `if (hgs.declstring) goto L1;` (06 §4 SHARED-ARM: `L1:` is the else
        // arm's body, so the jump is expressed by gating the three alias tests on `!hgs.declstring`
        // — every route that skips them lands on the same shared tail below).
        if (!hgs.declstring && basetype.ty === TY.Tchar && basetype.isImmutable())
            buf.writestring(ds("string"));
        else if (!hgs.declstring && basetype.ty === TY.Twchar && basetype.isImmutable())
            buf.writestring(ds("wstring"));
        else if (!hgs.declstring && basetype.ty === TY.Tdchar && basetype.isImmutable())
            buf.writestring(ds("dstring"));
        else {
            // hdrgen.d:4368 — `L1:` the general form: element type (this array's mod as the mask),
            // then `[]`. D writes the FIELD (`t.next`, :4369).
            visitWithMask(t.next!, t.mod, buf, hgs);
            buf.writestring(ds("[]"));
        }
    };

    // hdrgen.d:4374-4380 — visitAArray: `V[K]`; the key prints with NO mask (all its mods shown).
    const visitAArray = (t: TypeAArray): void => {
        visitWithMask(t.next!, t.mod, buf, hgs); // hdrgen.d:4376 — D derefs `next` untested
        buf.writeByte(0x5B); // '['
        visitWithMask(t.index!, 0, buf, hgs); // hdrgen.d:4378 — D derefs `index` untested
        buf.writeByte(0x5D); // ']'
    };

    // hdrgen.d:4382-4392 — visitPointer: a pointer to a function prints as the `function` type; any
    // other pointer prints its target (this pointer's mod as the mask), then `*`.
    const visitPointer = (t: TypePointer): void => {
        //printf("TypePointer::toCBuffer2() next = %d\n", t.next.ty);   (commented out upstream)
        if (t.next!.ty === TY.Tfunction) { // hdrgen.d:4385 — D derefs `next` untested (02 §10.1)
            // hdrgen.d:4386 — `cast(TypeFunction)t.next` under `ty == Tfunction`: `isTypeFunction()`
            // tests the same ty, so `!` is the proven downcast.
            visitFuncIdentWithPostfix(t.next!.isTypeFunction()!, ds("function"), buf, hgs, false);
        } else {
            visitWithMask(t.next!, t.mod, buf, hgs); // hdrgen.d:4389
            buf.writeByte(0x2A); // '*'
        }
    };

    // hdrgen.d:4394-4398 — visitReference: the target, then `&`.
    const visitReference = (t: TypeReference): void => {
        visitWithMask(t.next!, t.mod, buf, hgs);
        buf.writeByte(0x26); // '&'
    };

    // hdrgen.d:4400-4404 — visitFunction: the postfix form with no name.
    const visitFunction = (t: TypeFunction): void => {
        //printf("TypeFunction::toCBuffer2() t = %p, ref = %d\n", t, t.isRef);   (commented out upstream)
        visitFuncIdentWithPostfix(t, null, buf, hgs, false);
    };

    // hdrgen.d:4406-4409 — visitDelegate: the postfix form with `delegate` as the name. A delegate's
    // `next` is always its TypeFunction (the TypeDelegate ctor takes one), so `!` marks D's cast.
    const visitDelegate = (t: TypeDelegate): void => {
        visitFuncIdentWithPostfix(t.next!.isTypeFunction()!, ds("delegate"), buf, hgs, false);
    };

    // hdrgen.d:4411-4437 — visitTypeQualifiedHelper: the `.a`, `.b!(...)`, `[e]`, `[T]` tail of a
    // qualified type name, one component per entry of `t.idents`.
    const visitTypeQualifiedHelper = (t: TypeQualified): void => {
        // hdrgen.d:4413 — `foreach (id; t.idents)`; D calls `dyncast()` on each slot (02 §10.1 `!`).
        for (let i = 0; i < t.idents.length; i++) {
            const id = t.idents.opIndex(i)!;
            // hdrgen.d:4415 — `switch (id.dyncast()) with (DYNCAST)`: the `with` re-qualifies the case
            // labels (06 §3.3). Each D `cast(X)id` is a class downcast under its own `case` label; the
            // dtemplate.d:78-118 classifiers test that same `dyncast()` tag, so each `!` is the proof.
            switch (id.dyncast()) {
                case DYNCAST.dsymbol: {
                    buf.writeByte(0x2E); // '.' — hdrgen.d:4418
                    // hdrgen.d:4419 — `TemplateInstance ti = cast(TemplateInstance)id;`: a DYNAMIC class
                    // cast in D (null for a non-instance), which `isTemplateInstance()` reproduces.
                    const ti = isDsymbol(id)!.isTemplateInstance();
                    // hdrgen.d:4420 — UFCS `ti.dsymbolToBuffer(buf, hgs)` (04 §6); D calls through `ti`
                    // untested.
                    dsymbolToBuffer(ti!, buf, hgs);
                    break;
                }
                case DYNCAST.expression:
                    buf.writeByte(0x5B); // '[' — hdrgen.d:4423
                    expressionToBuffer(isExpression(id)!, buf, hgs); // hdrgen.d:4424 — UFCS (04 §6)
                    buf.writeByte(0x5D); // ']'
                    break;
                case DYNCAST.type:
                    buf.writeByte(0x5B); // '[' — hdrgen.d:4428
                    typeToBufferx(isType(id)!, buf, hgs); // hdrgen.d:4429
                    buf.writeByte(0x5D); // ']'
                    break;
                default:
                    buf.writeByte(0x2E); // '.' — hdrgen.d:4433
                    buf.writestring(id.toString()); // hdrgen.d:4434
            }
        }
    };

    // hdrgen.d:4439-4444 — visitIdentifier: the head identifier, then the qualified tail.
    const visitIdentifier = (t: TypeIdentifier): void => {
        //printf("visitTypeIdentifier() %s\n", t.ident.toChars());   (commented out upstream, hdrgen.d:4441)
        buf.writestring(t.ident!.toString()); // hdrgen.d:4442 — D derefs `ident` untested
        visitTypeQualifiedHelper(t);
    };

    // hdrgen.d:4446-4450 — visitInstance: the instance through the Dsymbol printer, then the tail.
    const visitInstance = (t: TypeInstance): void => {
        // hdrgen.d:4448 — UFCS `t.tempinst.dsymbolToBuffer(...)`.
        dsymbolToBuffer(t.tempinst!, buf, hgs);
        visitTypeQualifiedHelper(t);
    };

    // hdrgen.d:4452-4458 — visitTypeof: `typeof(<exp>)`, then the tail.
    const visitTypeof = (t: TypeTypeof): void => {
        buf.writestring(ds("typeof("));
        expressionToBuffer(t.exp!, buf, hgs); // hdrgen.d:4455 — UFCS (04 §6); D derefs `exp` untested
        buf.writeByte(0x29); // ')'
        visitTypeQualifiedHelper(t);
    };

    // hdrgen.d:4460-4464 — visitReturn: `typeof(return)`, then the tail.
    const visitReturn = (t: TypeReturn): void => {
        buf.writestring(ds("typeof(return)"));
        visitTypeQualifiedHelper(t);
    };

    // hdrgen.d:4466-4470 — visitEnum: the symbol's (optionally fully-qualified) name. `put(const(char)*)`
    // stops at the NUL (02 §11.2), hence `cstr`.
    const visitEnum = (t: TypeEnum): void => {
        //printf("visitEnum: %s\n", t.sym.toChars());   (commented out upstream, hdrgen.d:4468)
        buf.writestring(cstr(hgs.fullQual ? t.sym!.toPrettyChars() : t.sym!.toChars())); // hdrgen.d:4469
    };

    // hdrgen.d:4472-4484 — visitStruct: the symbol's (optionally fully-qualified) name, or the
    // enclosing template instance's when the struct IS that instance's aliasdecl (issue 13776:
    // print `ti`, WITHOUT ti.toAlias(), to avoid forward-reference errors while printing).
    // Both legs are live: `TemplateInstance` overrides neither `toChars` nor `toPrettyChars`
    // (dtemplate.d:764-1057 overrides only syntaxCopy/kind/toPrettyCharsHelper/getIdent/accept),
    // so both resolve to `Dsymbol`'s; the `fullQual` route's halt — dtemplate.ts's wall on
    // `toPrettyCharsHelper` — belongs to that file, not to a wall here.
    const visitStruct = (t: TypeStruct): void => {
        const ti = t.sym!.parent ? t.sym!.parent.isTemplateInstance() : null; // hdrgen.d:4479
        if (ti !== null && ti.aliasdecl === t.sym)
            // hdrgen.d:4481: `put(const(char)*)` stops at the first NUL (02 §11.2), hence `cstr`.
            buf.writestring(cstr(hgs.fullQual ? ti.toPrettyChars() : ti.toChars()));
        else
            // hdrgen.d:4483 — Dsymbol.toPrettyChars walks the parent chain → `<module>.S`.
            buf.writestring(cstr(hgs.fullQual ? t.sym!.toPrettyChars() : t.sym!.toChars()));
    };

    // hdrgen.d:4486-4496 — visitClass: the same two legs as visitStruct (issue 13776).
    const visitClass = (t: TypeClass): void => {
        const ti = t.sym!.parent ? t.sym!.parent.isTemplateInstance() : null; // hdrgen.d:4491
        if (ti !== null && ti.aliasdecl === t.sym)
            buf.writestring(cstr(hgs.fullQual ? ti.toPrettyChars() : ti.toChars())); // hdrgen.d:4493
        else
            buf.writestring(cstr(hgs.fullQual ? t.sym!.toPrettyChars() : t.sym!.toChars())); // hdrgen.d:4495
    };

    // hdrgen.d:4498-4526 — visitTag: an ImportC `struct`/`union`/`enum` tag type. Every `t.mod` here reads
    // through a TypeTag-typed reference, so it is TypeTag's own slot, `modTag` (mtype.d:2145, 02 §11.5b);
    // Type.mod of the same object was already printed by visitWithMask (hdrgen.d:3924).
    const visitTag = (t: TypeTag): void => {
        if (hgs.importcHdr && t.id) { // hdrgen.d:4500
            // https://issues.dlang.org/show_bug.cgi?id=24670
            // `const` must be parenthesized because it can be a return type
            if (t.modTag & MODFlags.const_) // hdrgen.d:4504
                buf.writestring(ds("const("));

            // For C to D translation, `struct S` or `enum S` simply becomes `S`
            buf.writestring(t.id.toString()); // hdrgen.d:4508

            if (t.modTag & MODFlags.const_) // hdrgen.d:4510
                buf.writestring(ds(")"));
            return;
        }
        // The following produces something like "const enum E : short"
        if (t.modTag & MODFlags.const_) // hdrgen.d:4515
            buf.writestring(ds("const "));
        buf.writestring(Token.toStringValue(t.tok)); // hdrgen.d:4517 — `Token.toString(t.tok)`
        buf.writeByte(0x20); // ' '
        if (t.id) // hdrgen.d:4519
            buf.writestring(t.id.toString());
        if (t.tok === TOK.enum_ && t.base && t.base.ty !== TY.Tint32) { // hdrgen.d:4521
            buf.writestring(ds(" : "));
            visitWithMask(t.base, t.modTag, buf, hgs); // hdrgen.d:4524
        }
    };

    // hdrgen.d:4528-4531 — visitTuple: the element list, parenthesised, as a parameter list.
    const visitTuple = (t: TypeTuple): void => {
        // hdrgen.d:4530 — `ParameterList(t.arguments, VarArg.none)`: a fresh by-value struct, so no copy.
        parametersToBuffer(new ParameterList(t.arguments, VarArg.none), buf, hgs);
    };

    // hdrgen.d:4533-4541 — visitSlice: `T[lwr .. upr]`.
    const visitSlice = (t: TypeSlice): void => {
        visitWithMask(t.next!, t.mod, buf, hgs); // hdrgen.d:4535 — D derefs `next` untested
        buf.writeByte(0x5B); // '['
        sizeToBuffer(t.lwr!, buf, hgs); // hdrgen.d:4537
        buf.writestring(ds(" .. "));
        sizeToBuffer(t.upr!, buf, hgs); // hdrgen.d:4539
        buf.writeByte(0x5D); // ']'
    };

    // hdrgen.d:4543-4546 — visitNull
    const visitNull = (_t: TypeNull): void => {
        buf.writestring(ds("typeof(null)"));
    };

    // hdrgen.d:4548-4553 — visitMixin: `mixin(<args>)`.
    const visitMixin = (t: TypeMixin): void => {
        buf.writestring(ds("mixin("));
        argsToBuffer(t.exps, buf, hgs, null); // hdrgen.d:4551
        buf.writeByte(0x29); // ')'
    };

    // hdrgen.d:4555-4558 — visitNoreturn
    const visitNoreturn = (_t: TypeNoreturn): void => {
        buf.writestring(ds("noreturn"));
    };

    // hdrgen.d:4560-4564 — the pre-dispatch ImportC typedef arm.
    if (hgs.importcHdr && !hgs.inCAlias && !hgs.inFuncReturn && t.mcache && t.mcache.typedefIdent) {
        buf.writestring(t.mcache.typedefIdent.toString());
        return;
    }

    // hdrgen.d:4566-4595 — the dispatch, emitted in full (13 §7.5 rule 1). Each D `cast(TypeX)t` is a
    // class downcast under its own `case Tx`; the `isTypeX()` family tests that same `ty`, so each `!`
    // is the proven downcast.
    switch (t.ty) {
        default: { // hdrgen.d:4568-4570
            const tb = t.isTypeBasic();
            return tb !== null ? visitBasic(tb) : visitType(t);
        }
        case TY.Terror:     return visitError(t.isTypeError()!);
        case TY.Ttraits:    return visitTraits(t.isTypeTraits()!);
        case TY.Tvector:    return visitVector(t.isTypeVector()!);
        case TY.Tsarray:    return visitSArray(t.isTypeSArray()!);
        case TY.Tarray:     return visitDArray(t.isTypeDArray()!);
        case TY.Taarray:    return visitAArray(t.isTypeAArray()!);
        case TY.Tpointer:   return visitPointer(t.isTypePointer()!);
        case TY.Treference: return visitReference(t.isTypeReference()!);
        case TY.Tfunction:  return visitFunction(t.isTypeFunction()!);
        case TY.Tdelegate:  return visitDelegate(t.isTypeDelegate()!);
        case TY.Tident:     return visitIdentifier(t.isTypeIdentifier()!);
        case TY.Tinstance:  return visitInstance(t.isTypeInstance()!);
        case TY.Ttypeof:    return visitTypeof(t.isTypeTypeof()!);
        case TY.Treturn:    return visitReturn(t.isTypeReturn()!);
        case TY.Tenum:      return visitEnum(t.isTypeEnum()!);
        case TY.Tstruct:    return visitStruct(t.isTypeStruct()!);
        case TY.Tclass:     return visitClass(t.isTypeClass()!);
        case TY.Ttuple:     return visitTuple(t.isTypeTuple()!);
        case TY.Tslice:     return visitSlice(t.isTypeSlice()!);
        case TY.Tnull:      return visitNull(t.isTypeNull()!);
        case TY.Tmixin:     return visitMixin(t.isTypeMixin()!);
        case TY.Tnoreturn:  return visitNoreturn(t.isTypeNoreturn()!);
        case TY.Ttag:       return visitTag(t.isTypeTag()!);
    }
}

/**
 * dmd/hdrgen.d:2067 — `void toCharsMaybeConstraints(const TemplateDeclaration td, ref OutBuffer`
 * `buf, ref HdrGenState hgs)`. Print a template declaration's signature for diagnostics:
 * `name(<template params>)`, then — when `hgs.showOneMember` and the template's one member is a
 * function — that function's parameter list and mod (`foo(T)(int x)`), then ` if (<constraint>)`
 * unless `hgs.skipConstraints`. A constructor template prints as `this(...)`.
 *
 * Note: this function is not actually `const`, because iterating the
 * function parameter list may run dsymbolsemantic on enum types
 *
 * Preconditions: `td.parameters` is non-null and `td.ident` is non-null — D dereferences both with no
 * test (02 §10.1 `!`); a one-member FuncDeclaration has a non-null `type`.
 * Callers: the "Candidate is" / "does not match template declaration" diagnostics (funcsem.d:2330,
 * dtemplate.d:343/:1262, templatesem.d:3852).
 */
export function toCharsMaybeConstraints(td: TemplateDeclaration, buf: OutBuffer, hgs: HdrGenState): void {
    // hdrgen.d:2069 — Identifier `==` is identity.
    buf.writestring(td.ident === Id.ctor ? ds("this") : td.ident!.toString());
    buf.writeByte(0x28); // '(' — hdrgen.d:2070
    // hdrgen.d:2071 — `foreach (i, const tp; *td.parameters)`
    const parameters = td.parameters!;
    for (let i = 0; i < parameters.length; i++) {
        const tp = parameters.opIndex(i);
        if (i) // hdrgen.d:2073
            buf.writestring(ds(", "));
        templateParameterToCBuffer(tp!, buf, hgs); // hdrgen.d:2075 — `toCBuffer(tp, buf, hgs)`
    }
    buf.writeByte(0x29); // ')' — hdrgen.d:2077

    if (hgs.showOneMember && td.onemember) { // hdrgen.d:2079
        const fd = td.onemember.isFuncDeclaration();
        if (fd) { // hdrgen.d:2081
            const tf = fd.type!.isTypeFunction(); // hdrgen.d:2083 — `cast(TypeFunction)` only drops const
            if (tf) {
                // !! Casted away const
                // hdrgen.d:2086 — `buf.put(parametersTypeToChars(tf.parameterList))`: `put(const(char)*)`
                // writes up to the NUL, and parametersTypeToChars
                // returns an `extractChars()` result that carries it, hence `cstr` (02 §11.2). By-value
                // `ParameterList` argument -> `.copy()` (03 §1).
                buf.writestring(cstr(parametersTypeToChars(tf.parameterList.copy())));
                if (tf.mod) { // hdrgen.d:2087
                    buf.writeByte(0x20); // ' '
                    MODtoBuffer(buf, tf.mod); // hdrgen.d:2090 — `buf.MODtoBuffer(tf.mod)`, UFCS (04 §6)
                }
            }
        }
    }

    if (!hgs.skipConstraints &&
        td.constraint) { // hdrgen.d:2096
        buf.writestring(ds(" if ("));
        expToCBuffer(td.constraint, buf, hgs); // hdrgen.d:2100 — `toCBuffer(td.constraint, buf, hgs)`
        buf.writeByte(0x29); // ')'
    }
}

/*****************************************
 * dmd/hdrgen.d:2109 — `private void visitTemplateParameters(TemplateParameters* parameters, ref`
 * `OutBuffer buf, ref HdrGenState hgs)`. Pretty-print a template parameter list to a buffer,
 * comma-separated, without parentheses; nothing for a null list.
 */
function visitTemplateParameters(parameters: TemplateParameters | null, buf: OutBuffer, hgs: HdrGenState): void {
    if (!parameters) // hdrgen.d:2111
        return;
    // hdrgen.d:2113 — `foreach (i, p; *parameters)`; D calls through each slot (02 §10.1 `!`).
    for (let i = 0; i < parameters.length; i++) {
        const p = parameters.opIndex(i);
        if (i) // hdrgen.d:2115
            buf.writestring(ds(", "));
        templateParameterToCBuffer(p!, buf, hgs); // hdrgen.d:2117 — `toCBuffer(p, buf, hgs)`
    }
}

/*******************************************
 * dmd/hdrgen.d:2125 — `private void visitVarDecl(VarDeclaration v, bool anywritten, ref OutBuffer buf,`
 * `ref HdrGenState hgs)`. Pretty-print a VarDeclaration to buf: `, name` when a previous declarator of
 * the same declaration was already written (`anywritten`), else storage classes, type and name; then
 * ` = <init>` unless it is an `extern` header declaration. In `-H` mode a variable with no type is
 * spelled `typeof(<init>) name`; an ImportC variable named like a D lexer special
 * (`__DATE__`, …) is commented out with `/+ … +/`.
 *
 * Preconditions: `v.ident` is non-null — D dereferences it untested on every path (02 §10.1 `!`).
 * Callers: the expression printer's `visitDeclaration` (hdrgen.d:2650), the statement printer's
 * `visitCompoundDeclaration` (:393) and the Dsymbol printer's `visitVarDeclaration` (:1810).
 */
function visitVarDecl(v: VarDeclaration, anywritten: boolean, buf: OutBuffer, hgs: HdrGenState): void {
    // hdrgen.d:2127: `insideFuncBody` / `tpltMember` / `insideAggregate` are D `int`s (09 §9: plain
    // integral truthiness); the STC test is a bigint mask (09 §9 / 02 §4.2).
    const isextern = hgs.hdrgen &&
        !hgs.insideFuncBody &&
        !hgs.tpltMember &&
        !hgs.insideAggregate &&
        (v.storage_class & STC.manifest) === 0n;

    // hdrgen.d:2133 — nested `void vinit(VarDeclaration v)`; its parameter SHADOWS the outer `v`,
    // exactly as in D (13 §7.5 rule 3). D derefs `v._init` untested (02 §10.1 `!`): both call sites
    // sit behind a `v._init` test.
    const vinit = (v: VarDeclaration): void => {
        const ie = v._init!.isExpInitializer(); // hdrgen.d:2135
        if (ie && (ie.exp!.op === EXP.construct || ie.exp!.op === EXP.blit))
            // hdrgen.d:2137 — `(cast(AssignExp)ie.exp).e2`: tag-proved downcast, the adjacent
            // `construct || blit` test proves an AssignExp subclass that `isAssignExp()` (EXP.assign
            // alone) cannot express (02 §11.5c item 3). UFCS `expressionToBuffer` (04 §6).
            expressionToBuffer((ie.exp as unknown as AssignExp).e2!, buf, hgs);
        else
            initializerToBuffer(v._init!, buf, hgs); // hdrgen.d:2139 — UFCS (04 §6)
    };

    const commentIt = hgs.importcHdr && isSpecialCName(v.ident!); // hdrgen.d:2142
    if (commentIt)
        buf.writestring(ds("/+"));

    if (anywritten) { // hdrgen.d:2146
        buf.writestring(ds(", "));
        buf.writestring(v.ident!.toString());
    } else {
        const useTypeof = isextern && v._init !== null && !v.type; // hdrgen.d:2153
        let stc: STC = v.storage_class; // hdrgen.d:2154
        if (isextern)
            stc = (stc | STC.extern_) as STC; // branded STC re-cast after `|` (02 §11.5c.4)
        if (useTypeof)
            stc = (stc & ~STC.auto_) as STC; // branded STC re-cast after `&~` (02 §11.5c.4)
        if (stcToBuffer(buf, stc)) // hdrgen.d:2159
            buf.writeByte(0x20); // ' '
        if (v.type) { // hdrgen.d:2161
            typeToBuffer(v.type, v.ident, buf, hgs);
        } else if (useTypeof) { // hdrgen.d:2163
            buf.writestring(ds("typeof("));
            vinit(v);
            buf.writestring(ds(") "));
            buf.writestring(v.ident!.toString());
        } else {
            buf.writestring(v.ident!.toString()); // hdrgen.d:2171
        }
    }
    if (v._init && !isextern) { // hdrgen.d:2173
        buf.writestring(ds(" = "));
        vinit(v);
    }
    if (commentIt) // hdrgen.d:2178
        buf.writestring(ds("+/"));
}

/*************************************
 * dmd/hdrgen.d:2190 — `private bool isSpecialCName(Identifier id)`.
 * The names __DATE__, __TIME__,__EOF__, __VENDOR__, __TIMESTAMP__, __VERSION__
 * are special to the D lexer and cannot be used as D source variable names.
 * Params:
 *      id = name to check
 * Returns:
 *      true if special C name
 */
function isSpecialCName(id: Identifier): boolean {
    const s = id.toString(); // hdrgen.d:2192
    // hdrgen.d:2193 — Identifier `==` is identity (the Id table interns each name once).
    if (s.length >= 7 && s[0] === 0x5F && s[1] === 0x5F && // '_' '_'
        (id === Id.DATE ||
         id === Id.TIME ||
         id === Id.EOFX ||
         id === Id.VENDOR ||
         id === Id.TIMESTAMP ||
         id === Id.VERSIONX))
        return true;
    return false;
}

/*********************************************
 * dmd/hdrgen.d:2207 — `private void expressionPrettyPrint(Expression e, ref OutBuffer buf, ref`
 * `HdrGenState hgs)`. Print expression to buffer: the per-`op` expression printer.
 *
 * Every nested visitor of D is ported, and the dispatch (hdrgen.d:3079) is emitted IN FULL (13 §7.5
 * rule 1). Five nested visitors print through the Dsymbol printer (`dsymbolToBuffer`, hdrgen.d:975):
 * a template instance in `visitScope`, the class body of `visitNewAnonClass`, the function literal of
 * `visitFunc`, a non-variable declaration in `visitDeclaration`, and the instance of
 * `visitDotTemplateInstance`. Under `hgs.ddoc`, visitInteger / visitString / visitInterpolation escape
 * what they printed through doc.d's `escapeDdocString`.
 * Operand parenthesisation reads the `precedence` registration slot; the `__rvalue(` … `)` wrapper
 * and a struct literal's recursion flag are paired state, restored on every exit.
 */
function expressionPrettyPrint(e: Expression, buf: OutBuffer, hgs: HdrGenState): void {
    // The nested visitors keep D's own names and parameter names (`e`/`s`/`type`), which SHADOW this
    // function's `e` exactly as D's nested functions do (01 §2 identifier fidelity; 13 §7.5 rule 3). A
    // parameter the body never reads takes the `_` prefix (`noUnusedParameters`).

    // hdrgen.d:2209-2212 — visit: the base arm, the operator's display string.
    const visit = (e: Expression): void => {
        buf.writestring(EXPtoString(e.op));
    };

    // hdrgen.d:2214-2318 — visitInteger: an integer literal spelled for its type.
    const visitInteger = (e: IntegerExp): void => {
        // hdrgen.d:2216 — `const ulong v = e.value;`. The carrier holds the value NORMALIZED to its
        // type, sign-extended for the signed kinds (IntegerExp.normalize); D's `ulong` is its 64-bit
        // unsigned reading (09 §3.1), which every test below then reinterprets exactly as D does.
        const v: bigint = BigInt.asUintN(64, e.value);
        if (e.type) { // hdrgen.d:2217
            let t: Type = e.type;
            // Three jump targets inside the switch below, each classified per 06 §3.6 / §4:
            //  - `goto L1` (hdrgen.d:2242) re-enters the switch on the enum's base type: RETRY, the
            //    labeled loop `L1`, re-entered with `continue L1`;
            //  - `goto L2` (hdrgen.d:2256/:2259) jumps to the body of `case Tint32`, and
            //    `goto case Tuns32` (:2266/:2269) / `goto case Tuns64` (:2300) to theirs: SHARED-ARM
            //    targets, each arm body a named local called at every jump site. The targets are
            //    TERMINAL — their D `break` leaves the switch, which is the last statement of
            //    visitInteger — so a jump site calls the arm, then leaves with the same `break L1`.
            //    Every D `break;` of this switch is `break L1;` (the loop wraps the switch).
            // hdrgen.d:2261-2263 — `L2: buf.printf("%d", cast(int)v);` — `cast(int)` is a 32-bit
            // sign-extending truncation (09 §2).
            const L2 = (): void => {
                buf.printf(ds("%d"), BigInt.asIntN(32, v));
            };
            // hdrgen.d:2270-2272 — `case Tuns32: buf.printf("%uu", cast(uint)v);`
            const caseTuns32 = (): void => {
                buf.printf(ds("%uu"), BigInt.asUintN(32, v));
            };
            // hdrgen.d:2286-2288 — `case Tuns64: buf.printf("%lluLU", v);`
            const caseTuns64 = (): void => {
                buf.printf(ds("%lluLU"), v);
            };
            L1: for (;;) {
                switch (t.ty) { // hdrgen.d:2221
                    case TY.Tenum: {
                        // hdrgen.d:2225 — `cast(TypeEnum)t` under `case Tenum`: `isTypeEnum()` tests
                        // the same ty, so `!` is the proven downcast.
                        const te = t.isTypeEnum()!;
                        const sym = te.sym; // hdrgen.d:2226
                        // hdrgen.d:2227 — class `!=` without opEquals is identity (05 §2).
                        if (sym && sym.members && (!hgs.inEnumDecl || hgs.inEnumDecl !== sym)) {
                            // hdrgen.d:2229 — `foreach (em; *sym.members)`
                            const members = sym.members;
                            for (let i = 0; i < members.length; i++) {
                                const em = members.opIndex(i)!;
                                // hdrgen.d:2231 — `(cast(EnumMember)em).value.isIntegerExp().value == v`:
                                // D calls through the dynamic cast and through `isIntegerExp()`
                                // untested (02 §10.1 `!`; the slot's default keeps both faults), and
                                // compares the two `ulong` readings.
                                const value = enumMemberIntegerSlot(em.isEnumMember()!);
                                if (value !== null && BigInt.asUintN(64, value.value) === v) {
                                    const id = em.ident!.toString(); // hdrgen.d:2233
                                    // hdrgen.d:2234 — `cast(int)id.length`: a length, number domain.
                                    buf.printf(ds("%s.%.*s"), sym.toChars(), id.length, id);
                                    return;
                                }
                            }
                        }

                        buf.printf(ds("cast(%s)"), te.sym!.toChars()); // hdrgen.d:2240
                        t = te.sym!.memtype!; // hdrgen.d:2241
                        continue L1; // goto L1 (dmd/hdrgen.d:2242)
                    }
                    case TY.Tchar:
                    case TY.Twchar:
                    case TY.Tdchar: {
                        const o = buf.length(); // hdrgen.d:2248
                        // hdrgen.d:2249 — `cast(dchar) v`: a 32-bit truncation into the `dchar` (number)
                        // domain; the masked value is < 2^32, so the narrowing is exact (09 §1.3.1).
                        writeSingleCharLiteral(buf, Number(BigInt.asUintN(32, v)));
                        if (hgs.ddoc)
                            escapeDdocStringAt("visitInteger", buf, o); // hdrgen.d:2251
                        break L1;
                    }
                    case TY.Tint8:
                        buf.writestring(ds("cast(byte)")); // hdrgen.d:2255
                        L2(); // goto L2 (dmd/hdrgen.d:2256)
                        break L1;
                    case TY.Tint16:
                        buf.writestring(ds("cast(short)")); // hdrgen.d:2258
                        L2(); // goto L2 (dmd/hdrgen.d:2259)
                        break L1;
                    case TY.Tint32:
                        L2(); // hdrgen.d:2261 — `L2:` falls into its own body here
                        break L1;
                    case TY.Tuns8:
                        buf.writestring(ds("cast(ubyte)")); // hdrgen.d:2265
                        caseTuns32(); // goto case Tuns32 (dmd/hdrgen.d:2266)
                        break L1;
                    case TY.Tuns16:
                        buf.writestring(ds("cast(ushort)")); // hdrgen.d:2268
                        caseTuns32(); // goto case Tuns32 (dmd/hdrgen.d:2269)
                        break L1;
                    case TY.Tuns32:
                        caseTuns32(); // hdrgen.d:2271
                        break L1;
                    case TY.Tint64:
                        // hdrgen.d:2274 — `v == long.min`: the `long` operand converts to `ulong`, so
                        // the compare is against 2^63.
                        if (v === 0x8000_0000_0000_0000n) {
                            // https://issues.dlang.org/show_bug.cgi?id=23173
                            // This is a special case because - is not part of the
                            // integer literal and 9223372036854775808L overflows a long
                            buf.writestring(ds("cast(long)-9223372036854775808"));
                        } else {
                            // hdrgen.d:2283 — `%lld` reads the `ulong` vararg as a signed `long`.
                            buf.printf(ds("%lldL"), BigInt.asIntN(64, v));
                        }
                        break L1;
                    case TY.Tuns64:
                        caseTuns64(); // hdrgen.d:2287
                        break L1;
                    case TY.Tbool:
                        buf.writestring(ds(v !== 0n ? "true" : "false")); // hdrgen.d:2290
                        break L1;
                    case TY.Tpointer: {
                        buf.writestring(ds("cast(")); // hdrgen.d:2293

                        const hgs2 = new HdrGenState(); // should re-examine need for new hgs — hdrgen.d:2295
                        // hdrgen.d:2296 — `t.ty == Tclass`, which can never hold under `case Tpointer` (D
                        // copied the line from `toChars(Type)`). `isTypeClass()` tests that same tag;
                        // spelling it as the raw compare trips TS's narrowing of `t.ty` to `Tpointer`.
                        hgs2.fullQual = (t.isTypeClass() !== null && !t.mod);
                        typeToCBuffer(t, buf, null, hgs2); // hdrgen.d:2297 — `toCBuffer(t, buf, null, hgs2)`

                        buf.writestring(ds(")cast(size_t)")); // hdrgen.d:2299
                        caseTuns64(); // goto case Tuns64 (dmd/hdrgen.d:2300)
                        break L1;
                    }
                    case TY.Tvoid:
                        buf.writestring(ds("cast(void)0")); // hdrgen.d:2303
                        break L1;

                    default:
                        /* This can happen if errors, such as
                         * the type is painted on like in fromConstInitializer().
                         * Just ignore
                         */
                        break L1;
                }
            }
        } else if ((v & 0x8000_0000_0000_0000n) !== 0n) { // hdrgen.d:2314
            buf.printf(ds("0x%llx"), v);
        } else {
            buf.print(v); // hdrgen.d:2317
        }
    };

    // hdrgen.d:2320-2323 — visitError
    const visitError = (_e: ErrorExp): void => {
        buf.writestring(ds("__error"));
    };

    // hdrgen.d:2325-2328 — visitVoidInit
    const visitVoidInit = (_e: VoidInitExp): void => {
        buf.writestring(ds("void"));
    };

    // hdrgen.d:2330-2333 — nested `void floatToBuffer(Type type, real_t value)`, which calls the
    // module-level `.floatToBuffer` (hdrgen.d:3172). ported: the nested name takes the `_` escape
    // (01 §2.3) — TS has no `.name` module-scope operator, and the unescaped local would shadow the
    // module function it forwards to.
    const floatToBuffer_ = (type: Type | null, value: real_t): void => {
        floatToBuffer(type, value, buf, hgs.hdrgen); // hdrgen.d:2332
    };

    // hdrgen.d:2335-2338 — visitReal
    const visitReal = (e: RealExp): void => {
        floatToBuffer_(e.type, e.value);
    };

    // hdrgen.d:2340-2350 — visitComplex
    const visitComplex = (e: ComplexExp): void => {
        /* Print as:
         *  (re+imi)
         */
        buf.writeByte(0x28); // '(' — hdrgen.d:2345
        floatToBuffer_(e.type, creall(e.value)); // hdrgen.d:2346
        buf.writeByte(0x2B); // '+'
        floatToBuffer_(e.type, cimagl(e.value)); // hdrgen.d:2348
        buf.writestring(ds("i)"));
    };

    // hdrgen.d:2352-2358 — visitIdentifier: the header spelling (`this`, `~this`, …) under -H / Ddoc.
    const visitIdentifier = (e: IdentifierExp): void => {
        if (hgs.hdrgen || hgs.ddoc) // hdrgen.d:2354
            // `put(const(char)*)` stops at the NUL (02 §11.2), hence `cstr`; D derefs `ident` untested.
            buf.writestring(cstr(e.ident!.toHChars2()));
        else
            buf.writestring(e.ident!.toString()); // hdrgen.d:2357
    };

    // hdrgen.d:2360-2369 — visitDsymbol (the shared symbol-name emitter of the expression printer).
    // NOT D's visitDsymbolExp (that is the EXP.dSymbol dispatch arm, hdrgen.d:2371).
    const visitDsymbol = (s: Dsymbol): void => {
        // For -vcg-ast, print internal names such as __invariant, __ctor etc.
        // This condition is a bit kludge, and can be cleaned up if the
        // mutual dependency `AST.toChars <> hdrgen.d` gets refactored
        if (hgs.vcg_ast && s.ident && s.isTemplateInstance() === null && s.isTemplateDeclaration() === null)
            buf.writestring(s.ident.toChars()); // hdrgen.d:2366 — Identifier.toChars carries no NUL
        else
            buf.writestring(cstr(s.toChars())); // hdrgen.d:2368: `put(const(char)*)` stops at the NUL (02 §11.2)
    };

    // hdrgen.d:2371-2374 — visitDsymbolExp
    const visitDsymbolExp = (e: DsymbolExp): void => {
        visitDsymbol(e.s!); // D calls through `s` untested (02 §10.1)
    };

    // hdrgen.d:2376-2379 — visitThis
    const visitThis = (_e: ThisExp): void => {
        buf.writestring(ds("this"));
    };

    // hdrgen.d:2381-2384 — visitSuper
    const visitSuper = (_e: SuperExp): void => {
        buf.writestring(ds("super"));
    };

    // hdrgen.d:2386-2389 — visitNull
    const visitNull = (_e: NullExp): void => {
        buf.writestring(ds("null"));
    };

    // hdrgen.d:2391-2415 — visitString.
    const visitString = (e: StringExp): void => {
        if (e.hexString || e.sz === 8) { // hdrgen.d:2393
            buf.writeByte(0x78); // 'x' — hdrgen.d:2395
            buf.writeByte(0x22); // '"'
            // hdrgen.d:2397 — `foreach (i; 0 .. e.len)`; `%0*llX` takes the code-unit width `e.sz`
            // (an `int`) as its `*` field width and the `dinteger_t` value as the `ll` conversion.
            for (let i = 0; i < e.len; i++)
                buf.printf(ds("%0*llX"), e.sz, e.getIndex(i));
            buf.writeByte(0x22); // '"' — hdrgen.d:2399
            if (e.postfix)
                buf.writeByte(e.postfix);
            return;
        }
        buf.writeByte(0x22); // '"' — hdrgen.d:2404
        const o = buf.length();
        for (let i = 0; i < e.len; i++) // hdrgen.d:2406
            writeCharLiteral(buf, e.getCodeUnit(i));
        if (hgs.ddoc)
            escapeDdocStringAt("visitString", buf, o); // hdrgen.d:2411
        buf.writeByte(0x22); // '"'
        if (e.postfix)
            buf.writeByte(e.postfix);
    };

    // hdrgen.d:2417-2446 — visitInterpolation: `i"…$(expr)…"`; even parts are literal text, odd parts
    // the interpolated expressions' source text.
    const visitInterpolation = (e: InterpExp): void => {
        buf.writeByte(0x69); // 'i' — hdrgen.d:2419
        buf.writeByte(0x22); // '"'
        const o = buf.length(); // hdrgen.d:2421

        // hdrgen.d:2423 — `foreach (idx, str; e.interpolatedSet.parts)`; D derefs the set untested.
        const parts = e.interpolatedSet!.parts;
        for (let idx = 0; idx < parts.length; idx++) {
            const str = parts[idx];
            if (idx % 2 === 0) { // hdrgen.d:2425
                // hdrgen.d:2427 — `foreach(ch; str)`: `char` elements, one byte each (06 §1.4).
                for (const ch of str)
                    writeCharLiteral(buf, ch);
            } else {
                buf.writeByte(0x24); // '$' — hdrgen.d:2432
                buf.writeByte(0x28); // '('
                for (const ch of str) // hdrgen.d:2434
                    buf.writeByte(ch);
                buf.writeByte(0x29); // ')'
            }
        }

        if (hgs.ddoc)
            escapeDdocStringAt("visitInterpolation", buf, o); // hdrgen.d:2441
        buf.writeByte(0x22); // '"' — hdrgen.d:2442
        if (e.postfix)
            buf.writeByte(e.postfix);
    };

    // hdrgen.d:2448-2453 — visitArrayLiteral: `[a, b]`, a null element printing as `basis`.
    const visitArrayLiteral = (e: ArrayLiteralExp): void => {
        buf.writeByte(0x5B); // '['
        argsToBuffer(e.elements, buf, hgs, e.basis); // hdrgen.d:2451
        buf.writeByte(0x5D); // ']'
    };

    // hdrgen.d:2455-2473 — visitAssocArrayLiteral: `[k:v, …]`, or its lowering under -vcg-ast.
    const visitAssocArrayLiteral = (e: AssocArrayLiteralExp): void => {
        if (hgs.vcg_ast && e.lowering) { // hdrgen.d:2457
            expToBuffer(e.lowering, PREC_assign, buf, hgs);
            return;
        }
        buf.writeByte(0x5B); // '[' — hdrgen.d:2462
        // hdrgen.d:2463 — `foreach (i, key; *e.keys)`; D derefs `keys`, `values` and each slot untested.
        const keys = e.keys!;
        for (let i = 0; i < keys.length; i++) {
            const key = keys.opIndex(i);
            if (i) // hdrgen.d:2465
                buf.writestring(ds(", "));
            expToBuffer(key!, PREC_assign, buf, hgs); // hdrgen.d:2467
            buf.writeByte(0x3A); // ':'
            const value = e.values!.opIndex(i); // hdrgen.d:2469
            expToBuffer(value!, PREC_assign, buf, hgs);
        }
        buf.writeByte(0x5D); // ']' — hdrgen.d:2472
    };

    // hdrgen.d:2475-2493 — visitStructLiteral: `S(a, b)`, guarded against self-reference.
    const visitStructLiteral = (e: StructLiteralExp): void => {
        buf.writestring(cstr(e.sd!.toChars())); // hdrgen.d:2477: `put(const(char)*)`, NUL-stop (02 §11.2)
        buf.writeByte(0x28); // '('
        // CTFE can generate struct literals that contain an AddrExp pointing
        // to themselves, need to avoid infinite recursion:
        // struct S { this(int){ this.s = &this; } S* s; }
        // const foo = new S(0);
        if (e.stageflags & StructLiteralExpStageFlags.toCBuffer) { // hdrgen.d:2483
            buf.writestring(ds("<recursion>"));
        } else {
            const old = e.stageflags; // hdrgen.d:2487
            e.stageflags |= StructLiteralExpStageFlags.toCBuffer;
            // Paired state on the expression node (11 §2.5 rule (d)): D restores with a plain
            // `e.stageflags = old;` at region end (hdrgen.d:2490) and has no other exit, so that one
            // statement moves into `finally` — restored once on the normal path, and also on a throw
            // from a walled printer under the elements.
            try {
                argsToBuffer(e.elements, buf, hgs); // hdrgen.d:2489
            } finally {
                e.stageflags = old; // hdrgen.d:2490
            }
        }
        buf.writeByte(0x29); // ')' — hdrgen.d:2492
    };

    // hdrgen.d:2495-2501 — visitCompoundLiteral: `(T)<initializer>`.
    const visitCompoundLiteral = (e: CompoundLiteralExp): void => {
        buf.writeByte(0x28); // '('
        typeToBuffer(e.type!, null, buf, hgs); // hdrgen.d:2498 — D derefs `type` untested
        buf.writeByte(0x29); // ')'
        initializerToBuffer(e.initializer!, buf, hgs); // hdrgen.d:2500 — UFCS (04 §6)
    };

    // hdrgen.d:2503-2506 — visitType
    const visitType = (e: TypeExp): void => {
        typeToBuffer(e.type!, null, buf, hgs); // hdrgen.d:2505 — D derefs `type` untested
    };

    // hdrgen.d:2508-2528 — visitScope: an instance through the Dsymbol printer; under Ddoc the name
    // (a module's full dotted name); otherwise `<kind> <name>` (e.g. `module std`, `package core`).
    const visitScope = (e: ScopeExp): void => {
        const sds = e.sds!; // D derefs `sds` untested (02 §10.1)
        if (sds.isTemplateInstance()) { // hdrgen.d:2510
            dsymbolToBuffer(sds, buf, hgs); // hdrgen.d:2512 — UFCS `e.sds.dsymbolToBuffer(buf, hgs)`
        } else if (hgs.ddoc) { // hdrgen.d:2514
            // fixes bug 6491
            const m = sds.isModule();
            if (m)
                buf.writestring(cstr(m.md!.toChars())); // hdrgen.d:2518 — D derefs `md` untested
            else
                buf.writestring(cstr(sds.toChars())); // hdrgen.d:2520
        } else {
            buf.writestring(cstr(sds.kind())); // hdrgen.d:2524: `put(const(char)*)`, NUL-stop
            buf.writeByte(0x20); // ' '
            buf.writestring(cstr(sds.toChars())); // hdrgen.d:2526
        }
    };

    // hdrgen.d:2530-2533 — visitTemplate
    const visitTemplate = (e: TemplateExp): void => {
        buf.writestring(cstr(e.td!.toChars())); // hdrgen.d:2532
    };

    // hdrgen.d:2535-2562 — visitNew: `[outer.]new [(placement) ]T[(args)]`, or its lowering under
    // -vcg-ast.
    const visitNew = (e: NewExp): void => {
        if (hgs.vcg_ast && e.lowering) { // hdrgen.d:2537
            expToBuffer(e.lowering, PREC_primary, buf, hgs);
            return;
        }
        if (e.thisexp) { // hdrgen.d:2542
            expToBuffer(e.thisexp, PREC_primary, buf, hgs);
            buf.writeByte(0x2E); // '.'
        }
        buf.writestring(ds("new ")); // hdrgen.d:2547
        if (e.placement) { // hdrgen.d:2548
            buf.writeByte(0x28); // '('
            expToBuffer(e.placement, PREC_assign, buf, hgs);
            buf.writeByte(0x29); // ')'
            buf.writeByte(0x20); // ' '
        }
        typeToBuffer(e.newtype!, null, buf, hgs); // hdrgen.d:2555 — D derefs `newtype` untested
        if (e.arguments_ && e.arguments_.length) { // hdrgen.d:2556
            buf.writeByte(0x28); // '('
            argsToBuffer(e.arguments_, buf, hgs, null, e.names); // hdrgen.d:2559
            buf.writeByte(0x29); // ')'
        }
    };

    // hdrgen.d:2564-2588 — visitNewAnonClass: `[outer.]new[ (placement)] class [(args)]<body>`.
    const visitNewAnonClass = (e: NewAnonClassExp): void => {
        if (e.thisexp) { // hdrgen.d:2566
            expToBuffer(e.thisexp, PREC_primary, buf, hgs);
            buf.writeByte(0x2E); // '.'
        }
        buf.writestring(ds("new")); // hdrgen.d:2571
        if (e.placement) { // hdrgen.d:2572
            buf.writeByte(0x20); // ' '
            buf.writeByte(0x28); // '('
            expToBuffer(e.placement, PREC_assign, buf, hgs);
            buf.writeByte(0x29); // ')'
        }
        buf.writestring(ds(" class ")); // hdrgen.d:2579
        if (e.arguments_ && e.arguments_.length) { // hdrgen.d:2580
            buf.writeByte(0x28); // '('
            argsToBuffer(e.arguments_, buf, hgs); // hdrgen.d:2583
            buf.writeByte(0x29); // ')'
        }
        // hdrgen.d:2587 — UFCS `e.cd.dsymbolToBuffer(buf, hgs)`.
        if (e.cd) // hdrgen.d:2586
            dsymbolToBuffer(e.cd, buf, hgs);
    };

    // hdrgen.d:2590-2598 — visitSymOff: `(& sym + off)`, a TypeInfo's name, or `& sym`.
    const visitSymOff = (e: SymOffExp): void => {
        if (e.offset !== 0n) // hdrgen.d:2592: `ulong` truthiness on the bigint carrier (09 §9)
            buf.printf(ds("(& %s + %llu)"), e.var_.toChars(), e.offset);
        else if (e.var_.isTypeInfoDeclaration()) // hdrgen.d:2594
            buf.writestring(cstr(e.var_.toChars()));
        else
            buf.printf(ds("& %s"), e.var_.toChars()); // hdrgen.d:2597
    };

    // hdrgen.d:2600-2603 — visitVar: a variable reference prints as its symbol name.
    const visitVar = (e: VarExp): void => {
        visitDsymbol(e.var_);
    };

    // hdrgen.d:2605-2608 — visitOver
    const visitOver = (e: OverExp): void => {
        buf.writestring(e.vars!.ident!.toString()); // hdrgen.d:2607 — D derefs both untested
    };

    // hdrgen.d:2610-2626 — visitTuple: `AliasSeq!(…)`, preceded by its side effect `e0` when there
    // is one.
    const visitTuple = (e: TupleExp): void => {
        if (e.e0) { // hdrgen.d:2612
            buf.writeByte(0x28); // '('
            expressionPrettyPrint(e.e0, buf, hgs); // hdrgen.d:2615 — UFCS on the enclosing function
            buf.writestring(ds(", AliasSeq!("));
            argsToBuffer(e.exps, buf, hgs); // hdrgen.d:2617
            buf.writestring(ds("))"));
        } else {
            buf.writestring(ds("AliasSeq!(")); // hdrgen.d:2622
            argsToBuffer(e.exps, buf, hgs);
            buf.writeByte(0x29); // ')'
        }
    };

    // hdrgen.d:2628-2632 — visitFunc: the function literal, through the Dsymbol printer.
    const visitFunc = (e: FuncExp): void => {
        dsymbolToBuffer(e.fd!, buf, hgs); // hdrgen.d:2630 — UFCS `e.fd.dsymbolToBuffer(buf, hgs)`
        //buf.put(e.fd.toChars());   (commented out upstream, hdrgen.d:2631)
    };

    // hdrgen.d:2634-2657 — visitDeclaration.
    const visitDeclaration = (e: DeclarationExp): void => {
        /* Normal dmd execution won't reach here - regular variable declarations
         * are handled in visit(ExpStatement), so here would be used only when
         * we'll directly call Expression.toChars() for debugging.
         */
        if (e.declaration) { // hdrgen.d:2640
            const var_ = e.declaration.isVarDeclaration(); // ported: D local `var` -> var_ (01 §2.3)
            if (var_) { // hdrgen.d:2642
                // For debugging use:
                // - Avoid printing newline.
                // - Intentionally use the format (Type var;)
                //   which isn't correct as regular D code.
                buf.writeByte(0x28); // '(' — hdrgen.d:2648

                visitVarDecl(var_, false, buf, hgs); // hdrgen.d:2650

                buf.writeByte(0x3B); // ';'
                buf.writeByte(0x29); // ')'
            } else {
                dsymbolToBuffer(e.declaration, buf, hgs); // hdrgen.d:2655 — UFCS
            }
        }
    };

    // hdrgen.d:2659-2664 — visitTypeid
    const visitTypeid = (e: TypeidExp): void => {
        buf.writestring(ds("typeid("));
        objectToBuffer(e.obj, buf, hgs); // hdrgen.d:2662
        buf.writeByte(0x29); // ')'
    };

    // hdrgen.d:2666-2680 — visitTraits: `__traits(ident, args…)`.
    const visitTraits = (e: TraitsExp): void => {
        buf.writestring(ds("__traits(")); // hdrgen.d:2668
        if (e.ident)
            buf.writestring(e.ident.toString());
        if (e.args) { // hdrgen.d:2671
            // hdrgen.d:2673 — `foreach (arg; *e.args)`
            for (let i = 0; i < e.args.length; i++) {
                const arg = e.args.opIndex(i);
                buf.writestring(ds(", "));
                objectToBuffer(arg, buf, hgs); // hdrgen.d:2676
            }
        }
        buf.writeByte(0x29); // ')' — hdrgen.d:2679
    };

    // hdrgen.d:2682-2685 — visitHalt
    const visitHalt = (_e: HaltExp): void => {
        buf.writestring(ds("halt"));
    };

    // hdrgen.d:2687-2712 — visitIs: `is(T id <tok> <tok2>)`, `is(T id : spec)`, `is(T id == spec)`,
    // then the template parameter list.
    const visitIs = (e: IsExp): void => {
        buf.writestring(ds("is(")); // hdrgen.d:2689
        typeToBuffer(e.targ!, e.id, buf, hgs); // hdrgen.d:2690 — D derefs `targ` untested
        if (e.tok2 !== TOK.reserved) { // hdrgen.d:2691
            buf.writeByte(0x20); // ' '
            buf.writestring(Token.toStringValue(e.tok)); // hdrgen.d:2694 — `Token.toString(e.tok)`
            buf.writeByte(0x20); // ' '
            buf.writestring(Token.toStringValue(e.tok2)); // hdrgen.d:2696
        } else if (e.tspec) { // hdrgen.d:2698
            if (e.tok === TOK.colon)
                buf.writestring(ds(" : "));
            else
                buf.writestring(ds(" == "));
            typeToBuffer(e.tspec, null, buf, hgs); // hdrgen.d:2704
        }
        if (e.parameters && e.parameters.length) { // hdrgen.d:2706
            buf.writestring(ds(", "));
            visitTemplateParameters(e.parameters, buf, hgs); // hdrgen.d:2709
        }
        buf.writeByte(0x29); // ')' — hdrgen.d:2711
    };

    // hdrgen.d:2714-2718 — visitUna: the operator, then the operand at the operator's precedence.
    const visitUna = (e: UnaExp): void => {
        buf.writestring(EXPtoString(e.op)); // hdrgen.d:2716
        expToBuffer(e.e1!, precedenceAt("visitUna", e.op), buf, hgs); // hdrgen.d:2717 — `precedence[e.op]`
    };

    // hdrgen.d:2720-2729 — visitLoweredAssignExp: the lowering under -vcg-ast, else the base arm.
    const visitLoweredAssignExp = (e: LoweredAssignExp): void => {
        if (hgs.vcg_ast) { // hdrgen.d:2722
            expressionToBuffer(e.lowering!, buf, hgs); // hdrgen.d:2724 — D derefs `lowering` untested
            return;
        }

        // hdrgen.d:2728 — `visit(cast(BinExp)e);`. D nested functions do not overload, so the one
        // nested `visit` in scope is the BASE arm `visit(Expression e)` (hdrgen.d:2209), and the
        // `BinExp` upcast only selects the argument type: this prints the operator string, NOT
        // `visitBin`'s `a = b`. Faithful as written.
        visit(e);
    };

    // hdrgen.d:2730-2737 — visitBin: `a <op> b`; the right operand binds one level tighter.
    const visitBin = (e: BinExp): void => {
        expToBuffer(e.e1!, precedenceAt("visitBin", e.op), buf, hgs); // hdrgen.d:2732 — `precedence[e.op]`
        buf.writeByte(0x20); // ' '
        buf.writestring(EXPtoString(e.op)); // hdrgen.d:2734
        buf.writeByte(0x20); // ' '
        // hdrgen.d:2736 — `cast(PREC)(precedence[e.op] + 1)`: an `int` sum re-typed as the enum;
        // `PREC` is a numeric enum, so the sum assigns to it with no narrowing.
        const pr: PREC = precedenceAt("visitBin", e.op) + 1;
        expToBuffer(e.e2!, pr, buf, hgs);
    };

    // hdrgen.d:2739-2790 — visitComma: the original expression when the comma is a rewrite; a
    // `copyToTemp` temporary prints as its initializer; anything else as `a, b`.
    const visitComma = (e: CommaExp): void => {
        if (e.originalExp !== null) { // hdrgen.d:2741
            expressionPrettyPrint(e.originalExp, buf, hgs); // hdrgen.d:2743 — UFCS on the enclosing function
            return;
        }

        // CommaExp is generated by the compiler so it shouldn't
        // appear in error messages or header files.
        // For now, this treats the case where the compiler
        // generates CommaExp for temporaries by calling
        // the `sideeffect.copyToTemp` function.
        const ve = e.e2!.isVarExp(); // hdrgen.d:2752

        // Not a CommaExp introduced for temporaries, or -vcg-ast,
        // print the full comma
        if (!ve || (ve.var_.storage_class & STC.temp) === 0n || hgs.vcg_ast) { // hdrgen.d:2756
            visitBin(e); // hdrgen.d:2758 — `visitBin(cast(BinExp)e)`: an upcast, no cast needed
            return;
        }

        // CommaExp that contain temporaries inserted via
        // `copyToTemp` are usually of the form
        // ((T __temp = exp), __tmp).
        // Asserts are here to easily spot
        // missing cases where CommaExp
        // are used for other constructs
        const vd = ve.var_.isVarDeclaration(); // hdrgen.d:2768
        assert(vd !== null && vd._init !== null); // hdrgen.d:2769

        const ei = vd!._init!.isExpInitializer();
        if (ei) { // hdrgen.d:2771
            let commaExtract: Expression | null = null; // hdrgen.d:2773
            const exp = ei.exp!; // hdrgen.d:2774 — D derefs `exp` untested (via `isConstructExp()`)
            const ce = exp.isConstructExp();
            if (ce) { // hdrgen.d:2775
                commaExtract = ce.e2;
            } else {
                const se = exp.isStructLiteralExp();
                if (se) // hdrgen.d:2777
                    commaExtract = se;
            }

            if (commaExtract) { // hdrgen.d:2780
                expToBuffer(commaExtract, expPrecedence(hgs, exp), buf, hgs); // hdrgen.d:2782
                return;
            }
        }

        // not one of the known cases, go on the old path
        visitBin(e); // hdrgen.d:2788
        return;
    };

    // hdrgen.d:2792-2797 — visitMixin
    const visitMixin = (e: MixinExp): void => {
        buf.writestring(ds("mixin("));
        argsToBuffer(e.exps, buf, hgs, null); // hdrgen.d:2795
        buf.writeByte(0x29); // ')'
    };

    // hdrgen.d:2799-2804 — visitImport
    const visitImport = (e: ImportExp): void => {
        buf.writestring(ds("import("));
        expToBuffer(e.e1!, PREC_assign, buf, hgs); // hdrgen.d:2802
        buf.writeByte(0x29); // ')'
    };

    // hdrgen.d:2806-2819 — visitAssert: the source form it was lowered from, else `assert(e[, msg])`.
    const visitAssert = (e: AssertExp): void => {
        if (e.loweredFrom) // hdrgen.d:2808
            return expressionPrettyPrint(e.loweredFrom, buf, hgs); // hdrgen.d:2809 — UFCS on the enclosing function

        buf.writestring(ds("assert(")); // hdrgen.d:2811
        expToBuffer(e.e1!, PREC_assign, buf, hgs);
        if (e.msg) { // hdrgen.d:2813
            buf.writestring(ds(", "));
            expToBuffer(e.msg, PREC_assign, buf, hgs);
        }
        buf.writeByte(0x29); // ')' — hdrgen.d:2818
    };

    // hdrgen.d:2821-2825 — visitThrow
    const visitThrow = (e: ThrowExp): void => {
        buf.writestring(ds("throw "));
        expToBuffer(e.e1!, PREC_unary, buf, hgs); // hdrgen.d:2824
    };

    // hdrgen.d:2827-2832 — visitDotId
    const visitDotId = (e: DotIdExp): void => {
        expToBuffer(e.e1!, PREC_primary, buf, hgs); // hdrgen.d:2829
        buf.writeByte(0x2E); // '.'
        buf.writestring(e.ident!.toString()); // hdrgen.d:2831 — D derefs `ident` untested
    };

    // hdrgen.d:2834-2839 — visitDotTemplate
    const visitDotTemplate = (e: DotTemplateExp): void => {
        expToBuffer(e.e1!, PREC_primary, buf, hgs); // hdrgen.d:2836
        buf.writeByte(0x2E); // '.'
        buf.writestring(cstr(e.td!.toChars())); // hdrgen.d:2838
    };

    // hdrgen.d:2841-2846 — visitDotVar
    const visitDotVar = (e: DotVarExp): void => {
        expToBuffer(e.e1!, PREC_primary, buf, hgs); // hdrgen.d:2843
        buf.writeByte(0x2E); // '.'
        visitDsymbol(e.var_); // hdrgen.d:2845
    };

    // hdrgen.d:2848-2853 — visitDotTemplateInstance: `e1.` then the instance through the Dsymbol printer.
    const visitDotTemplateInstance = (e: DotTemplateInstanceExp): void => {
        expToBuffer(e.e1!, PREC_primary, buf, hgs); // hdrgen.d:2850
        buf.writeByte(0x2E); // '.'
        // hdrgen.d:2852 — UFCS `e.ti.dsymbolToBuffer(buf, hgs)`.
        dsymbolToBuffer(e.ti!, buf, hgs);
    };

    // hdrgen.d:2855-2864 — visitDelegate: `&e1.f`, or `&f` for a nested function with no `this`.
    const visitDelegate = (e: DelegateExp): void => {
        buf.writeByte(0x26); // '&' — hdrgen.d:2857
        const func = e.func!; // D derefs `func` untested (02 §10.1)
        if (!func.isNested() || func.needThis()) { // hdrgen.d:2858
            expToBuffer(e.e1!, PREC_primary, buf, hgs);
            buf.writeByte(0x2E); // '.'
        }
        buf.writestring(cstr(func.toChars())); // hdrgen.d:2863
    };

    // hdrgen.d:2866-2871 — visitDotType
    const visitDotType = (e: DotTypeExp): void => {
        expToBuffer(e.e1!, PREC_primary, buf, hgs); // hdrgen.d:2868
        buf.writeByte(0x2E); // '.'
        buf.writestring(cstr(e.sym!.toChars())); // hdrgen.d:2870
    };

    // hdrgen.d:2873-2897 — visitCall: `f(args)`, restoring the source form of a lowered call outside
    // -vcg-ast.
    const visitCall = (e: CallExp): void => {
        if (e.e1!.op === EXP.type) { // hdrgen.d:2875
            /* Avoid parens around type to prevent forbidden cast syntax:
             *   (sometype)(arg1)
             * This is ok since types in constructor calls
             * can never depend on parens anyway
             */
            expressionPrettyPrint(e.e1!, buf, hgs); // hdrgen.d:2882 — UFCS on the enclosing function
        } else {
            if (!hgs.vcg_ast && e.loweredFrom) { // hdrgen.d:2886
                // restore original syntax for expressions lowered to calls
                expressionToBuffer(e.loweredFrom, buf, hgs); // hdrgen.d:2889
                return;
            }
            expToBuffer(e.e1!, precedenceAt("visitCall", e.op), buf, hgs); // hdrgen.d:2892 — `precedence[e.op]`
        }
        buf.writeByte(0x28); // '(' — hdrgen.d:2894
        argsToBuffer(e.arguments_, buf, hgs, null, e.names); // hdrgen.d:2895
        buf.writeByte(0x29); // ')'
    };

    // hdrgen.d:2899-2904 — visitNot: the source form a `!` was lowered from, outside -vcg-ast.
    const visitNot = (e: NotExp): void => {
        if (!hgs.vcg_ast && e.loweredFrom) // hdrgen.d:2901
            return expressionToBuffer(e.loweredFrom, buf, hgs);
        return visitUna(e); // hdrgen.d:2903
    };

    // hdrgen.d:2906-2910 — visitPtr
    const visitPtr = (e: PtrExp): void => {
        buf.writeByte(0x2A); // '*'
        expToBuffer(e.e1!, precedenceAt("visitPtr", e.op), buf, hgs); // hdrgen.d:2909 — `precedence[e.op]`
    };

    // hdrgen.d:2912-2916 — visitDelete
    const visitDelete = (e: DeleteExp): void => {
        buf.writestring(ds("delete "));
        expToBuffer(e.e1!, precedenceAt("visitDelete", e.op), buf, hgs); // hdrgen.d:2915 — `precedence[e.op]`
    };

    // hdrgen.d:2918-2929 — visitCast: `cast(T)e`, or `cast(<mod>)e` for a mod-only cast.
    const visitCast = (e: CastExp): void => {
        buf.writestring(ds("cast(")); // hdrgen.d:2920
        if (e.to) {
            typeToBuffer(e.to, null, buf, hgs); // hdrgen.d:2922
        } else {
            MODtoBuffer(buf, e.mod); // hdrgen.d:2925
        }
        buf.writeByte(0x29); // ')'
        expToBuffer(e.e1!, precedenceAt("visitCast", e.op), buf, hgs); // hdrgen.d:2928 — `precedence[e.op]`
    };

    // hdrgen.d:2931-2937 — visitVector
    const visitVector = (e: VectorExp): void => {
        buf.writestring(ds("cast(")); // hdrgen.d:2933
        typeToBuffer(e.to!, null, buf, hgs); // hdrgen.d:2934 — D derefs `to` untested
        buf.writeByte(0x29); // ')'
        expToBuffer(e.e1!, precedenceAt("visitVector", e.op), buf, hgs); // hdrgen.d:2936 — `precedence[e.op]`
    };

    // hdrgen.d:2939-2943 — visitVectorArray
    const visitVectorArray = (e: VectorArrayExp): void => {
        expToBuffer(e.e1!, PREC_primary, buf, hgs); // hdrgen.d:2941
        buf.writestring(ds(".array"));
    };

    // hdrgen.d:2945-2962 — visitSlice: `a[]`, `a[lwr..upr]`, with `0` / `$` for a missing bound.
    const visitSlice = (e: SliceExp): void => {
        expToBuffer(e.e1!, precedenceAt("visitSlice", e.op), buf, hgs); // hdrgen.d:2947 — `precedence[e.op]`
        buf.writeByte(0x5B); // '['
        if (e.upr || e.lwr) { // hdrgen.d:2949
            if (e.lwr)
                sizeToBuffer(e.lwr, buf, hgs); // hdrgen.d:2952
            else
                buf.writeByte(0x30); // '0'
            buf.writestring(ds("..")); // hdrgen.d:2955
            if (e.upr)
                sizeToBuffer(e.upr, buf, hgs); // hdrgen.d:2957
            else
                buf.writeByte(0x24); // '$'
        }
        buf.writeByte(0x5D); // ']' — hdrgen.d:2961
    };

    // hdrgen.d:2964-2968 — visitArrayLength
    const visitArrayLength = (e: ArrayLengthExp): void => {
        expToBuffer(e.e1!, PREC_primary, buf, hgs); // hdrgen.d:2966
        buf.writestring(ds(".length"));
    };

    // hdrgen.d:2970-2975 — visitInterval
    const visitInterval = (e: IntervalExp): void => {
        expToBuffer(e.lwr!, PREC_assign, buf, hgs); // hdrgen.d:2972 — D derefs `lwr`/`upr` untested
        buf.writestring(ds(".."));
        expToBuffer(e.upr!, PREC_assign, buf, hgs); // hdrgen.d:2974
    };

    // hdrgen.d:2977-2981 — visitDelegatePtr
    const visitDelegatePtr = (e: DelegatePtrExp): void => {
        expToBuffer(e.e1!, PREC_primary, buf, hgs); // hdrgen.d:2979
        buf.writestring(ds(".ptr"));
    };

    // hdrgen.d:2983-2987 — visitDelegateFuncptr
    const visitDelegateFuncptr = (e: DelegateFuncptrExp): void => {
        expToBuffer(e.e1!, PREC_primary, buf, hgs); // hdrgen.d:2985
        buf.writestring(ds(".funcptr"));
    };

    // hdrgen.d:2989-2995 — visitArray: `a[args]`.
    const visitArray = (e: ArrayExp): void => {
        expToBuffer(e.e1!, PREC_primary, buf, hgs); // hdrgen.d:2991
        buf.writeByte(0x5B); // '['
        argsToBuffer(e.arguments_, buf, hgs); // hdrgen.d:2993
        buf.writeByte(0x5D); // ']'
    };

    // hdrgen.d:2997-3002 — visitDot
    const visitDot = (e: DotExp): void => {
        expToBuffer(e.e1!, PREC_primary, buf, hgs); // hdrgen.d:2999
        buf.writeByte(0x2E); // '.'
        expToBuffer(e.e2!, PREC_primary, buf, hgs); // hdrgen.d:3001
    };

    // hdrgen.d:3004-3010 — visitCat: the druntime lowering under -vcg-ast, else `a ~ b`.
    const visitCat = (e: CatExp): void => {
        if (hgs.vcg_ast && e.lowering) // hdrgen.d:3006
            expressionToBuffer(e.lowering, buf, hgs);
        else
            visitBin(e); // hdrgen.d:3009
    };

    // hdrgen.d:3012-3018 — visitCatAssign: the druntime lowering under -vcg-ast, else `a ~= b`.
    const visitCatAssign = (e: CatAssignExp): void => {
        if (hgs.vcg_ast && e.lowering) // hdrgen.d:3014
            expressionToBuffer(e.lowering, buf, hgs);
        else
            visitBin(e); // hdrgen.d:3017
    };

    // hdrgen.d:3020-3031 — visitIndex: `a[i]`, restoring the source form of a lowered AA access
    // outside -vcg-ast.
    const visitIndex = (e: IndexExp): void => {
        if (!hgs.vcg_ast && e.loweredFrom) { // hdrgen.d:3022
            expressionToBuffer(e.loweredFrom, buf, hgs); // hdrgen.d:3024
            return;
        }
        expToBuffer(e.e1!, PREC_primary, buf, hgs); // hdrgen.d:3027
        buf.writeByte(0x5B); // '['
        sizeToBuffer(e.e2!, buf, hgs); // hdrgen.d:3029
        buf.writeByte(0x5D); // ']'
    };

    // hdrgen.d:3033-3037 — visitPost
    const visitPost = (e: PostExp): void => {
        expToBuffer(e.e1!, precedenceAt("visitPost", e.op), buf, hgs); // hdrgen.d:3035 — `precedence[e.op]`
        buf.writestring(EXPtoString(e.op)); // hdrgen.d:3036
    };

    // hdrgen.d:3039-3043 — visitPre
    const visitPre = (e: PreExp): void => {
        buf.writestring(EXPtoString(e.op)); // hdrgen.d:3041
        expToBuffer(e.e1!, precedenceAt("visitPre", e.op), buf, hgs); // hdrgen.d:3042 — `precedence[e.op]`
    };

    // hdrgen.d:3045-3051 — visitRemove: `aa.remove(key)`.
    const visitRemove = (e: RemoveExp): void => {
        expToBuffer(e.e1!, PREC_primary, buf, hgs); // hdrgen.d:3047
        buf.writestring(ds(".remove("));
        expToBuffer(e.e2!, PREC_assign, buf, hgs); // hdrgen.d:3049
        buf.writeByte(0x29); // ')'
    };

    // hdrgen.d:3053-3060 — visitCond: `c ? a : b`.
    const visitCond = (e: CondExp): void => {
        expToBuffer(e.econd!, PREC_oror, buf, hgs); // hdrgen.d:3055
        buf.writestring(ds(" ? "));
        expToBuffer(e.e1!, PREC_expr, buf, hgs); // hdrgen.d:3057
        buf.writestring(ds(" : "));
        expToBuffer(e.e2!, PREC_cond, buf, hgs); // hdrgen.d:3059
    };

    // hdrgen.d:3062-3065 — visitDefaultInit: `__FILE__`, `__LINE__`, …
    const visitDefaultInit = (e: DefaultInitExp): void => {
        buf.writestring(EXPtoString(e.op)); // hdrgen.d:3064
    };

    // hdrgen.d:3067-3070 — visitClassReference
    const visitClassReference = (e: ClassReferenceExp): void => {
        buf.writestring(cstr(e.value!.toChars())); // hdrgen.d:3069
    };

    if (e.rvalue) // hdrgen.d:3072
        buf.writestring(ds("__rvalue(")); // hdrgen.d:3073

    // hdrgen.d:3075-3077 — `scope (exit) if (e.rvalue) buf.put(')');` -> try/finally (06 §7.1). The
    // guarded region is exactly the dispatch below, D's own scope of the statement.
    try {
        // hdrgen.d:3079-3159 — the dispatch, emitted in full (13 §7.5 rule 1). Each `e.isXxxExp()`
        // tests the same op as its `case`, so each `!` is the proven downcast D's call carries.
        switch (e.op) {
            default: { // hdrgen.d:3081-3088
                const be = e.isBinExp();
                if (be)
                    return visitBin(be);
                const ue = e.isUnaExp();
                if (ue)
                    return visitUna(ue);
                const de = e.isDefaultInitExp();
                if (de)
                    return visitDefaultInit(e.isDefaultInitExp()!); // hdrgen.d:3087 — D re-tests, as here
                return visit(e);
            }

            case EXP.int64:         return visitInteger(e.isIntegerExp()!);
            case EXP.error:         return visitError(e.isErrorExp()!);
            case EXP.void_:         return visitVoidInit(e.isVoidInitExp()!);
            case EXP.float64:       return visitReal(e.isRealExp()!);
            case EXP.complex80:     return visitComplex(e.isComplexExp()!);
            case EXP.identifier:    return visitIdentifier(e.isIdentifierExp()!);
            case EXP.dSymbol:       return visitDsymbolExp(e.isDsymbolExp()!);
            case EXP.this_:         return visitThis(e.isThisExp()!);
            case EXP.super_:        return visitSuper(e.isSuperExp()!);
            case EXP.null_:         return visitNull(e.isNullExp()!);
            case EXP.string_:       return visitString(e.isStringExp()!);
            case EXP.interpolated:  return visitInterpolation(e.isInterpExp()!);
            case EXP.arrayLiteral:  return visitArrayLiteral(e.isArrayLiteralExp()!);
            case EXP.assocArrayLiteral:     return visitAssocArrayLiteral(e.isAssocArrayLiteralExp()!);
            case EXP.structLiteral: return visitStructLiteral(e.isStructLiteralExp()!);
            case EXP.compoundLiteral:       return visitCompoundLiteral(e.isCompoundLiteralExp()!);
            case EXP.type:          return visitType(e.isTypeExp()!);
            case EXP.scope_:        return visitScope(e.isScopeExp()!);
            case EXP.template_:     return visitTemplate(e.isTemplateExp()!);
            case EXP.new_:          return visitNew(e.isNewExp()!);
            case EXP.newAnonymousClass:     return visitNewAnonClass(e.isNewAnonClassExp()!);
            case EXP.symbolOffset:  return visitSymOff(e.isSymOffExp()!);
            case EXP.variable:      return visitVar(e.isVarExp()!);
            case EXP.overloadSet:   return visitOver(e.isOverExp()!);
            case EXP.tuple:         return visitTuple(e.isTupleExp()!);
            case EXP.function_:     return visitFunc(e.isFuncExp()!);
            case EXP.declaration:   return visitDeclaration(e.isDeclarationExp()!);
            case EXP.typeid_:       return visitTypeid(e.isTypeidExp()!);
            case EXP.traits:        return visitTraits(e.isTraitsExp()!);
            case EXP.halt:          return visitHalt(e.isHaltExp()!);
            case EXP.is_:           return visitIs(e.isIsExp()!);
            case EXP.comma:         return visitComma(e.isCommaExp()!);
            case EXP.mixin_:        return visitMixin(e.isMixinExp()!);
            case EXP.import_:       return visitImport(e.isImportExp()!);
            case EXP.assert_:       return visitAssert(e.isAssertExp()!);
            case EXP.throw_:        return visitThrow(e.isThrowExp()!);
            case EXP.dotIdentifier: return visitDotId(e.isDotIdExp()!);
            case EXP.dotTemplateDeclaration:        return visitDotTemplate(e.isDotTemplateExp()!);
            case EXP.dotVariable:   return visitDotVar(e.isDotVarExp()!);
            case EXP.dotTemplateInstance:   return visitDotTemplateInstance(e.isDotTemplateInstanceExp()!);
            case EXP.delegate_:     return visitDelegate(e.isDelegateExp()!);
            case EXP.dotType:       return visitDotType(e.isDotTypeExp()!);
            case EXP.call:          return visitCall(e.isCallExp()!);
            case EXP.not:           return visitNot(e.isNotExp()!);
            case EXP.star:          return visitPtr(e.isPtrExp()!);
            case EXP.delete_:       return visitDelete(e.isDeleteExp()!);
            case EXP.cast_:         return visitCast(e.isCastExp()!);
            case EXP.vector:        return visitVector(e.isVectorExp()!);
            case EXP.vectorArray:   return visitVectorArray(e.isVectorArrayExp()!);
            case EXP.slice:         return visitSlice(e.isSliceExp()!);
            case EXP.arrayLength:   return visitArrayLength(e.isArrayLengthExp()!);
            case EXP.interval:      return visitInterval(e.isIntervalExp()!);
            case EXP.delegatePointer:       return visitDelegatePtr(e.isDelegatePtrExp()!);
            case EXP.delegateFunctionPointer:       return visitDelegateFuncptr(e.isDelegateFuncptrExp()!);
            case EXP.array:         return visitArray(e.isArrayExp()!);
            case EXP.dot:           return visitDot(e.isDotExp()!);
            case EXP.index:         return visitIndex(e.isIndexExp()!);
            case EXP.concatenate:   return visitCat(e.isCatExp()!);
            case EXP.concatenateAssign:     return visitCatAssign(e.isCatAssignExp()!);
            case EXP.concatenateElemAssign: return visitCatAssign(e.isCatElemAssignExp()!);
            case EXP.concatenateDcharAssign:        return visitCatAssign(e.isCatDcharAssignExp()!);
            case EXP.minusMinus:
            case EXP.plusPlus:      return visitPost(e.isPostExp()!);
            case EXP.preMinusMinus:
            case EXP.prePlusPlus:   return visitPre(e.isPreExp()!);
            case EXP.remove:        return visitRemove(e.isRemoveExp()!);
            case EXP.question:      return visitCond(e.isCondExp()!);
            case EXP.classReference:        return visitClassReference(e.isClassReferenceExp()!);
            case EXP.loweredAssignExp:      return visitLoweredAssignExp(e.isLoweredAssignExp()!);
        }
    } finally {
        if (e.rvalue) // hdrgen.d:3076
            buf.writeByte(0x29); // ')' — hdrgen.d:3077
    }
}

/**
 * dmd/hdrgen.d:3172 — `void floatToBuffer(Type type, const real_t value, ref OutBuffer buf, const bool`
 * `allowHex)`. Formats `value` as a literal of type `type` into `buf`.
 *
 * Params:
 *   type     = literal type (e.g. Tfloat)
 *   value    = value to print
 *   buf      = target buffer
 *   allowHex = whether hex floating point literals may be used
 *              for greater accuracy
 *
 * `%g` form, trailing `.` dropped; with `allowHex`, the `%a` hex form whenever the `%g` text does not
 * read back to the same value. Then the `F` / `L` / `i` suffix of the literal's base type.
 * Consumers: printast.d:74 (the only other in-scope D caller).
 */
export function floatToBuffer(type: Type | null, value: real_t, buf: OutBuffer, allowHex: boolean): void {
    /** sizeof(value)*3 is because each byte of mantissa is max
        of 256 (3 characters). The string will be "-M.MMMMe-4932".
        (ie, 8 chars more than mantissa). Plus one for trailing \0.
        Plus one for rounding. */
    // hdrgen.d:3178 — `value.sizeof`: `real_t` is the 8-byte `double` on this target (_config.md §1),
    // so the C scratch buffer is 8*3 + 8 + 1 + 1 = 34 bytes. D's `char[BUFFER_LEN] buffer = void` is
    // that scratch; `CTFloat.sprint` returns the formatted bytes instead of filling it (ctfloat.ts).
    const BUFFER_LEN = 8 * 3 + 8 + 1 + 1;
    let buffer: DString = CTFloat.sprint("g", value); // hdrgen.d:3180
    assert(cstrlen(buffer) < BUFFER_LEN); // hdrgen.d:3181
    if (allowHex) { // hdrgen.d:3182
        // hdrgen.d:3185 — `CTFloat.parse(buffer.ptr, isOutOfRange)`: the `out bool` comes back as a
        // field of the result (ctfloat.ts), unread here as in D.
        const r: real_t = CTFloat.parse(cstr(buffer)).value;
        //assert(!isOutOfRange); // test/compilable/test22725.c asserts here
        if (r !== value) // if exact duplication — hdrgen.d:3187
            buffer = CTFloat.sprint("a", value);
    }
    buf.writestring(cstr(buffer)); // hdrgen.d:3190 — `buf.put(buffer.ptr)`, up to the NUL
    if (buffer[cstrlen(buffer) - 1] === 0x2E) // '.' — hdrgen.d:3191
        buf.remove(buf.length() - 1, 1);

    if (type) { // hdrgen.d:3194
        const t = toBaseTypeNonSemantic(type); // hdrgen.d:3196 — UFCS (04 §6)

        switch (t.ty) { // hdrgen.d:3198
            case TY.Tfloat32:
            case TY.Timaginary32:
            case TY.Tcomplex32:
                buf.writeByte(0x46); // 'F'
                break;
            case TY.Tfloat80:
            case TY.Timaginary80:
            case TY.Tcomplex80:
                buf.writeByte(0x4C); // 'L'
                break;
            default:
                break;
        }
        if (isImaginaryNonSemantic(t)) // hdrgen.d:3213 — UFCS (04 §6)
            buf.writeByte(0x69); // 'i'
    }
}

/**
 * dmd/hdrgen.d:3218 — `void toCBuffer(const TemplateParameter tp, ref OutBuffer buf, ref HdrGenState`
 * `hgs)` (the TemplateParameter overload of D's `toCBuffer` set). Print one template parameter as it
 * is declared: `T : spec = default`, `this T`, `alias A : spec = default`, `int N : spec = default`,
 * `Args...`.
 *
 * Form B split (04 §1): named for its first-parameter type after the `typeToCBuffer` /
 * `expToCBuffer` precedent already exported here. Its only caller outside this module is doc.d.
 */
export function templateParameterToCBuffer(tp: TemplateParameter, buf: OutBuffer, hgs: HdrGenState): void {
    const v = new TemplateParameterPrettyPrintVisitor(buf, hgs); // hdrgen.d:3220 — `scope` erased (04 §8)
    tp.accept(v); // hdrgen.d:3221 — `(cast() tp)` only drops const
}

/**
 * dmd/hdrgen.d:3224 — `private extern (C++) final class TemplateParameterPrettyPrintVisitor : Visitor`.
 * IDIOM A (13 §7): a real visitor class; `visit(X)` -> `visitX` (13 §1), dispatched by each
 * TemplateParameter's own `accept` (13 §2). D module-private, kept module-private.
 *
 * D stores `OutBuffer*` / `HdrGenState*` pointers to the caller's objects; both are reference types
 * here, so the fields hold the caller's objects themselves and every write lands in them.
 */
class TemplateParameterPrettyPrintVisitor extends Visitor {
    // dropped: alias visit = Visitor.visit — no overload hiding in TS (13 §1)
    buf: OutBuffer; // hdrgen.d:3228
    hgs: HdrGenState; // hdrgen.d:3229

    // hdrgen.d:3231 — `extern (D) this(OutBuffer* buf, HdrGenState* hgs) scope @safe`
    constructor(buf: OutBuffer, hgs: HdrGenState) {
        super();
        this.buf = buf;
        this.hgs = hgs;
    }

    // hdrgen.d:3237 — `override void visit(TemplateTypeParameter tp)`
    override visitTemplateTypeParameter(tp: TemplateTypeParameter): void {
        this.buf.writestring(tp.ident!.toString()); // hdrgen.d:3239 — D derefs `ident` untested
        if (tp.specType) { // hdrgen.d:3240
            this.buf.writestring(ds(" : "));
            typeToBuffer(tp.specType, null, this.buf, this.hgs); // hdrgen.d:3243
        }
        if (tp.defaultType) { // hdrgen.d:3245
            this.buf.writestring(ds(" = "));
            typeToBuffer(tp.defaultType, null, this.buf, this.hgs); // hdrgen.d:3248
        }
    }

    // hdrgen.d:3252 — `override void visit(TemplateThisParameter tp)`
    override visitTemplateThisParameter(tp: TemplateThisParameter): void {
        this.buf.writestring(ds("this "));
        // hdrgen.d:3255 — `visit(cast(TemplateTypeParameter)tp)`: an upcast, so the overload D selects
        // statically is this class's TemplateTypeParameter method (13 §4).
        this.visitTemplateTypeParameter(tp);
    }

    // hdrgen.d:3258 — `override void visit(TemplateAliasParameter tp)`
    override visitTemplateAliasParameter(tp: TemplateAliasParameter): void {
        this.buf.writestring(ds("alias "));
        if (tp.specType) // hdrgen.d:3261
            typeToBuffer(tp.specType, tp.ident, this.buf, this.hgs);
        else
            this.buf.writestring(tp.ident!.toString()); // hdrgen.d:3264
        if (tp.specAlias) { // hdrgen.d:3265
            this.buf.writestring(ds(" : "));
            objectToBuffer(tp.specAlias, this.buf, this.hgs); // hdrgen.d:3268
        }
        if (tp.defaultAlias) { // hdrgen.d:3270
            this.buf.writestring(ds(" = "));
            objectToBuffer(tp.defaultAlias, this.buf, this.hgs); // hdrgen.d:3273
        }
    }

    // hdrgen.d:3277 — `override void visit(TemplateValueParameter tp)`
    override visitTemplateValueParameter(tp: TemplateValueParameter): void {
        typeToBuffer(tp.valType!, tp.ident, this.buf, this.hgs); // hdrgen.d:3279 — D derefs `valType` untested
        if (tp.specValue) { // hdrgen.d:3280
            this.buf.writestring(ds(" : "));
            expressionToBuffer(tp.specValue, this.buf, this.hgs); // hdrgen.d:3283 — UFCS (04 §6)
        }
        if (tp.defaultValue) { // hdrgen.d:3285
            this.buf.writestring(ds(" = "));
            expressionToBuffer(tp.defaultValue, this.buf, this.hgs); // hdrgen.d:3288 — UFCS (04 §6)
        }
    }

    // hdrgen.d:3292 — `override void visit(TemplateTupleParameter tp)`
    override visitTemplateTupleParameter(tp: TemplateTupleParameter): void {
        this.buf.writestring(tp.ident!.toString()); // hdrgen.d:3294
        this.buf.writestring(ds("..."));
    }
}

/**
 * dmd/hdrgen.d:3299 — `private void conditionToBuffer(Condition c, ref OutBuffer buf, ref HdrGenState`
 * `hgs)`. Print the head of a conditional-compilation construct: `debug`, `debug (X)`, `version (X)`
 * or `static if (<exp>)`, through the condition's own `accept`.
 */
function conditionToBuffer(c: Condition, buf: OutBuffer, hgs: HdrGenState): void {
    const v = new ConditionPrettyPrintVisitor(buf, hgs); // hdrgen.d:3301 — `scope` erased (04 §8)
    c.accept(v); // hdrgen.d:3302
}

/**
 * dmd/hdrgen.d:3305 — `private extern (C++) final class ConditionPrettyPrintVisitor : Visitor`.
 * IDIOM A (13 §7): a real visitor class; `visit(X)` -> `visitX` (13 §1), dispatched by each
 * Condition's own `accept` (13 §2). D module-private, kept module-private.
 *
 * D stores `OutBuffer*` / `HdrGenState*` pointers to the caller's objects; both are reference types
 * here, so the fields hold the caller's objects themselves and every write lands in them.
 */
class ConditionPrettyPrintVisitor extends Visitor {
    // dropped: alias visit = Visitor.visit — no overload hiding in TS (13 §1)
    buf: OutBuffer; // hdrgen.d:3309
    hgs: HdrGenState; // hdrgen.d:3310

    // hdrgen.d:3312 — `extern (D) this(OutBuffer* buf, HdrGenState* hgs) scope @safe`
    constructor(buf: OutBuffer, hgs: HdrGenState) {
        super();
        this.buf = buf;
        this.hgs = hgs;
    }

    // hdrgen.d:3318 — `override void visit(DebugCondition c)`
    override visitDebugCondition(c: DebugCondition): void {
        this.buf.writestring(ds("debug"));
        if (c.ident) { // hdrgen.d:3321
            this.buf.writestring(ds(" ("));
            this.buf.writestring(c.ident.toString()); // hdrgen.d:3324
            this.buf.writeByte(0x29); // ')'
        }
    }

    // hdrgen.d:3329 — `override void visit(VersionCondition c)`. D derefs `c.ident` untested (02 §10.1 `!`).
    override visitVersionCondition(c: VersionCondition): void {
        this.buf.writestring(ds("version ("));
        this.buf.writestring(c.ident!.toString()); // hdrgen.d:3332
        this.buf.writeByte(0x29); // ')'
    }

    // hdrgen.d:3336 — `override void visit(StaticIfCondition c)`. D derefs `c.exp` untested (02 §10.1 `!`).
    override visitStaticIfCondition(c: StaticIfCondition): void {
        this.buf.writestring(ds("static if ("));
        expressionToBuffer(c.exp!, this.buf, this.hgs); // hdrgen.d:3339 — UFCS (04 §6)
        this.buf.writeByte(0x29); // ')'
    }
}

/**
 * dmd/hdrgen.d:3344 — `void toCBuffer(const Statement s, ref OutBuffer buf, ref HdrGenState hgs)`,
 * the Statement overload of D's `toCBuffer` set (04 §6.1 name). Thin forward to the statement
 * printer; D's `cast()` only drops const.
 */
export function statementToCBuffer(s: Statement, buf: OutBuffer, hgs: HdrGenState): void {
    statementToBuffer(s, buf, hgs); // hdrgen.d:3346 — UFCS `(cast()s).statementToBuffer(buf, hgs)`
}

/****************************************
 * dmd/hdrgen.d:3445 — `static immutable SCstring[] table` inside `stcToString`. A function-local
 * `static immutable` is a once-per-program constant, which a module-level `const` reproduces
 * exactly (same reading, and same load-order verification, as `EXPtoStringTable` below).
 *
 * D's `SCstring` pairs an `STC` flag with its keyword spelling; the port carries the pair as a
 * two-element tuple. The comment D puts above the table ("the identifier needs to be `\0`
 * terminated as some code assumes it") is about the C-string tail of a D literal; `DString`s from
 * `Token.toString` carry no NUL and are read as byte slices, so nothing here depends on it.
 */
const stcToStringTable: ReadonlyArray<readonly [STC, DString]> = [
    [STC.auto_, Token.toStringValue(TOK.auto_)],
    [STC.scope_, Token.toStringValue(TOK.scope_)],
    [STC.static_, Token.toStringValue(TOK.static_)],
    [STC.extern_, Token.toStringValue(TOK.extern_)],
    [STC.const_, Token.toStringValue(TOK.const_)],
    [STC.final_, Token.toStringValue(TOK.final_)],
    [STC.abstract_, Token.toStringValue(TOK.abstract_)],
    [STC.synchronized_, Token.toStringValue(TOK.synchronized_)],
    [STC.deprecated_, Token.toStringValue(TOK.deprecated_)],
    [STC.override_, Token.toStringValue(TOK.override_)],
    [STC.lazy_, Token.toStringValue(TOK.lazy_)],
    [STC.alias_, Token.toStringValue(TOK.alias_)],
    [STC.out_, Token.toStringValue(TOK.out_)],
    [STC.in_, Token.toStringValue(TOK.in_)],
    [STC.manifest, Token.toStringValue(TOK.enum_)],
    [STC.immutable_, Token.toStringValue(TOK.immutable_)],
    [STC.shared_, Token.toStringValue(TOK.shared_)],
    [STC.nothrow_, Token.toStringValue(TOK.nothrow_)],
    [STC.wild, Token.toStringValue(TOK.inout_)],
    [STC.pure_, Token.toStringValue(TOK.pure_)],
    [STC.ref_, Token.toStringValue(TOK.ref_)],
    [STC.return_, Token.toStringValue(TOK.return_)],
    [STC.gshared, Token.toStringValue(TOK.gshared)],
    [STC.nogc, ds("@nogc")],
    [STC.live, ds("@live")],
    [STC.property, ds("@property")],
    [STC.safe, ds("@safe")],
    [STC.trusted, ds("@trusted")],
    [STC.system, ds("@system")],
    [STC.disable, ds("@disable")],
    [STC.future, ds("@__future")],
    [STC.local, ds("__local")],
];

/**
 * dmd/hdrgen.d:3369 — `bool stcToBuffer(ref OutBuffer buf, STC stc) @safe`. Write the storage-class
 * keywords of `stc` into `buf`, in D's canonical order (`auto` first, then the scope/ref/return
 * group as one phrase, then the flat table), separated by single spaces.
 *
 * Returns: whether anything was written (the caller uses it to decide on a separating space).
 * `stc` is by value in D too, so the local reduction is invisible to the caller.
 */
export function stcToBuffer(buf: OutBuffer, stc: STC): boolean {
    let result = false;

    if (stc & STC.scopeinferred) {
        // hdrgen.d:3376 — `//buf.put("scope-inferred ");` stays commented out upstream.
        stc = (stc & ~(STC.scope_ | STC.scopeinferred)) as STC; // branded STC re-cast after `&~` (02 §11.5c.4)
    }
    if (stc & STC.returninferred) {
        // hdrgen.d:3381 — likewise commented out upstream.
        stc = (stc & ~(STC.return_ | STC.returninferred)) as STC; // branded STC re-cast after `&~` (02 §11.5c.4)
    }

    // hdrgen.d:3385 — ensure `auto ref` keywords are (almost) adjacent
    if (stc & STC.auto_) {
        buf.writestring(ds("auto "));
        stc = (stc & ~STC.auto_) as STC; // branded STC re-cast after `&~` (02 §11.5c.4)
    }
    // hdrgen.d:3391 — Put scope ref return into a standard order
    let rrs: DString = dsEmpty;
    const isout = (stc & STC.out_) !== 0n;
    // hdrgen.d:3409-3413 — `L1:` the shared arm the six assigning cases `goto` into (06 §4
    // SHARED-ARM: the arm body becomes a named local, called at each jump site).
    const L1 = (): void => {
        buf.writestring(rrs);
        result = true;
        stc = (stc & ~(STC.out_ | STC.scope_ | STC.ref_ | STC.return_)) as STC; // branded STC re-cast (02 §11.5c.4)
    };
    // D's `final switch (buildScopeRef(stc))` evaluates its head once; the port names the result so
    // the `default` arm can carry the 06 §3.2 `never` exhaustiveness check.
    const sr = buildScopeRef(stc);
    switch (sr) { // hdrgen.d:3396 — `final switch`
        case ScopeRef.None:
        case ScopeRef.Scope:
        case ScopeRef.Return:
            break;

        // goto L1 (dmd/hdrgen.d:3403-3408) — each of the six assigning cases sets `rrs` and jumps
        // to the shared arm; the `L1()` call on each line IS that jump.
        case ScopeRef.ReturnScope:     rrs = ds("return scope"); L1(); break;
        case ScopeRef.ReturnRef:       rrs = ds(isout ? "return out" : "return ref"); L1(); break;
        case ScopeRef.Ref:             rrs = ds(isout ? "out" : "ref"); L1(); break;
        case ScopeRef.RefScope:        rrs = ds(isout ? "out scope" : "ref scope"); L1(); break;
        case ScopeRef.ReturnRef_Scope: rrs = ds(isout ? "return out scope" : "return ref scope"); L1(); break;
        case ScopeRef.Ref_ReturnScope: rrs = ds(isout ? "out return scope" : "ref return scope"); L1(); break;
        default: {
            // final switch: D throws SwitchError on an unhandled value
            const _exhaustive: never = sr; void _exhaustive; // static exhaustiveness check
            throw new SwitchError();
        }
    }

    const stcBox: Ref<STC> = { value: stc }; // D's `ref STC stc` argument to stcToString
    while (stcBox.value) { // hdrgen.d:3416
        const s = stcToString(stcBox);
        if (!s.length)
            break;
        if (result)
            buf.writeByte(0x20); // ' '
        result = true;
        buf.writestring(s);
    }

    return result;
}

/**
 * dmd/hdrgen.d:3435 — `string stcToString(ref STC stc) @safe`. Pick off one of the storage classes
 * from `stc` and return its keyword spelling; `stc` is reduced by the one picked.
 *
 * The `ref` parameter is a `Ref<STC>` box (see `Ref`): a branded `bigint` cannot be aliased.
 * Returns an EMPTY slice when no visible storage class remains — D returns `null`, whose `.length`
 * is 0, and every caller tests exactly that.
 */
export function stcToString(stc: Ref<STC>): DString {
    for (const entry of stcToStringTable) { // hdrgen.d:3480
        const tbl = entry[0];
        assert(tbl & STC.visibleStorageClasses); // hdrgen.d:3483
        if (stc.value & tbl) {
            stc.value = (stc.value & ~tbl) as STC; // branded STC re-cast (02 §11.5c.4)
            return entry[1];
        }
    }
    // hdrgen.d:3490 — `//printf("stc = %llx\n", stc);` stays commented out upstream.
    return dsEmpty; // hdrgen.d:3491 — D's `return null;`
}

/**
 * dmd/hdrgen.d:3494 — `private void linkageToBuffer(ref OutBuffer buf, LINK linkage) @safe`. Write
 * `extern (<linkage>)`; nothing for `LINK.default_`, whose spelling is empty.
 */
function linkageToBuffer(buf: OutBuffer, linkage: LINK): void {
    const s = linkageToString(linkage); // hdrgen.d:3496
    if (s.length) { // hdrgen.d:3497
        buf.writestring(ds("extern ("));
        buf.writestring(s);
        buf.writeByte(0x29); // ')'
    }
}

/**
 * dmd/hdrgen.d:3505 — `const(char)* linkageToChars(LINK linkage)`. The `extern(...)` spelling of a
 * linkage. D returns `linkageToString(linkage).ptr`, which works "because we return a literal".
 */
export function linkageToChars(linkage: LINK): DString {
    /// Works because we return a literal
    return linkageToString(linkage);
}

/**
 * dmd/hdrgen.d:3511 — `string linkageToString(LINK linkage) pure nothrow @safe`.
 *
 * `LINK.default_` has NO spelling: D's designated initializer leaves that slot `null`, and the one
 * in-module consumer (`linkageToBuffer`, hdrgen.d:3494) gates on `s.length`. The port stores an
 * EMPTY slice, which has the same length and the same behaviour at every call site; the difference
 * from D (a null `char*` vs an empty one) is observable only by a `%s` on `LINK.default_`, which no
 * caller performs — every one of them formats a linkage the parser has already resolved.
 */
export function linkageToString(linkage: LINK): DString {
    // hdrgen.d:3513-3523 — `with (LINK) { immutable string[7] a = [default_ : null, d : "D", …]; }`.
    // A FUNCTION-LOCAL table in D, so it is built here rather than hoisted; the designated indices
    // are kept (03 §6 / 06 §3.3 `with`-qualification) so a reordering of `LINK` cannot silently
    // shift a spelling.
    const a: DString[] = new Array<DString>(7).fill(dsEmpty);
    a[LINK.default_] = dsEmpty; // D: `null`
    a[LINK.d] = ds("D");
    a[LINK.c] = ds("C");
    a[LINK.cpp] = ds("C++");
    a[LINK.windows] = ds("Windows");
    a[LINK.objc] = ds("Objective-C");
    a[LINK.system] = ds("System");
    return a[linkage];
}

/**
 * dmd/hdrgen.d:3527 — `void visibilityToBuffer(ref OutBuffer buf, Visibility vis)`. Write the
 * visibility keyword, and for `package(pkg)` the fully-qualified package in parentheses.
 *
 * `vis` is a by-value struct in D; it is only read here, so the caller's `.copy()` (03 §1) is the
 * whole of the value semantics. `Dsymbol.toPrettyChars(true)` may reach dtemplate.ts's wall on
 * `toPrettyCharsHelper` for a package nested in a template instance; that halt belongs to that file.
 */
export function visibilityToBuffer(buf: OutBuffer, vis: Visibility): void {
    buf.writestring(visibilityToString(vis.kind) ?? dsEmpty); // hdrgen.d:3529; `put(null)` writes nothing
    if (vis.kind === Visibility.Kind.package_ && vis.pkg) { // hdrgen.d:3530
        buf.writeByte(0x28); // '('
        // hdrgen.d:3533: `put(const(char)*)` stops at the NUL (02 §11.2), hence `cstr`.
        buf.writestring(cstr(vis.pkg.toPrettyChars(true)));
        buf.writeByte(0x29); // ')'
    }
}

/**
 * dmd/hdrgen.d:3542 — `const(char)* visibilityToChars(Visibility.Kind kind)`.
 * Returns: a human readable representation of `kind`.
 */
export function visibilityToChars(kind: Visibility.Kind): DString {
    // Null terminated because we return a literal
    return visibilityToString(kind) ?? dsEmpty;
}

/**
 * dmd/hdrgen.d:3549 — `extern (D) string visibilityToString(Visibility.Kind kind) nothrow pure`
 * `@safe`. `Visibility.Kind.undefined` (index 0) is unnamed in D's initializer, so its slot is `null`, and
 * the port returns `null` there: json.d:439 skips the `protection` property of a null name, and traits.d's
 * `assert(protName)` tests it. `visibilityToChars` hands its callers an empty C string instead.
 */
export function visibilityToString(kind: Visibility.Kind): DString | null {
    // hdrgen.d:3551-3560 — `with (Visibility.Kind) { immutable string[7] a = [none : "none", …]; }`.
    // Function-local in D; the designated indices are kept, and `Kind.undefined` (index 0) keeps
    // D's unnamed `null` slot.
    const a: (DString | null)[] = new Array<DString | null>(7).fill(null);
    a[Visibility.Kind.none] = ds("none");
    a[Visibility.Kind.private_] = ds("private");
    a[Visibility.Kind.package_] = ds("package");
    a[Visibility.Kind.protected_] = ds("protected");
    a[Visibility.Kind.public_] = ds("public");
    a[Visibility.Kind.export_] = ds("export");
    return a[kind];
}

/****************************************
 * dmd/hdrgen.d:4604 — `static immutable char*[EXP.max + 1] strings =`, the function-local
 * static table of `EXPtoString`. Hoisted to module scope: D's function-local `static immutable` is
 * a CTFE-built, once-per-program constant, which a module-level `const` reproduces exactly.
 *
 * `EXP.max` is the LAST member of the (purely auto-incrementing) `EXP` enum — `EXP.rvalue` (same
 * reading as `exptab` at expression.d:4088, and as `precedence` at parse.d:9763 — note that
 * parse.ts's own comment cites :9732 for it, which is stale on the 1.43.0 tree).
 *
 * SPARSE BY CONSTRUCTION, and the sparseness is load-bearing. The D initializer names 124 of the
 * 129 `EXP` members; D leaves the remaining five slots at the `char*` default, `null`. Those five
 * are `EXP.reserved`, `EXP.throw_`, `EXP.dollar`, `EXP.interpolated` and `EXP.rvalue` — for them D
 * takes the `if (!p)` leg (hdrgen.d:4750): an `error: EXP %d has no string` line on stdout and the
 * literal `"XXXXX"`. `undefined` is the JS spelling of that empty slot, so the leg fires on exactly
 * the same five inputs and on no others (an empty `Uint8Array` would be falsy-safe but is never
 * stored here — every named slot holds a non-empty byte string).
 *
 * Entries are transcribed one-for-one from hdrgen.d:4606-4747, in D order, blank-line grouping and
 * the `// post` banner included, so the two tables stay diffable line by line. Several EXP members
 * legitimately share a spelling (`assign`/`construct`/`blit`/`loweredAssignExp` → `=`;
 * `plusPlus`/`prePlusPlus` → `++`; `is_`/`identity` → `is`; `star`/`mul` → `*`; `negate`/`min` → `-`;
 * `uadd`/`add` → `+`; `tilde`/`concatenate` → `~`; the three `~=` concat-assign forms) — that is D's
 * own table, not a transcription slip.
 *
 * Load order: this is a module-top-level read of `EXP` (tokens.ts), unlike the body-only value reads
 * the header describes. Verified acyclic — tokens.ts's transitive VALUE-import closure is 19 modules
 * and does not contain hdrgen.ts, so tokens.ts is fully evaluated before this initializer runs
 * (01 §4.5). Identical shape to parse.ts's `precedence` table. `stcToStringTable` above reads
 * `Token.tochars` from the same module at the same moment, under the same verification.
 */
const EXPtoStringTable: readonly (DString | undefined)[] = (() => {
    const t: (DString | undefined)[] = new Array<DString | undefined>(EXP.rvalue + 1).fill(undefined);
    t[EXP.type] = ds("type");
    t[EXP.error] = ds("error");
    t[EXP.objcClassReference] = ds("class");

    t[EXP.mixin_] = ds("mixin");

    t[EXP.import_] = ds("import");
    t[EXP.dotVariable] = ds("dotvar");
    t[EXP.scope_] = ds("scope");
    t[EXP.identifier] = ds("identifier");
    t[EXP.this_] = ds("this");
    t[EXP.super_] = ds("super");
    t[EXP.int64] = ds("long");
    t[EXP.float64] = ds("double");
    t[EXP.complex80] = ds("creal");
    t[EXP.null_] = ds("null");
    t[EXP.string_] = ds("string");
    t[EXP.arrayLiteral] = ds("arrayliteral");
    t[EXP.assocArrayLiteral] = ds("assocarrayliteral");
    t[EXP.classReference] = ds("classreference");
    t[EXP.file] = ds("__FILE__");
    t[EXP.fileFullPath] = ds("__FILE_FULL_PATH__");
    t[EXP.line] = ds("__LINE__");
    t[EXP.moduleString] = ds("__MODULE__");
    t[EXP.functionString] = ds("__FUNCTION__");
    t[EXP.prettyFunction] = ds("__PRETTY_FUNCTION__");
    t[EXP.typeid_] = ds("typeid");
    t[EXP.is_] = ds("is");
    t[EXP.assert_] = ds("assert");
    t[EXP.halt] = ds("halt");
    t[EXP.template_] = ds("template");
    t[EXP.dSymbol] = ds("symbol");
    t[EXP.function_] = ds("function");
    t[EXP.variable] = ds("var");
    t[EXP.symbolOffset] = ds("symoff");
    t[EXP.structLiteral] = ds("structLiteral");
    t[EXP.compoundLiteral] = ds("compoundliteral");
    t[EXP.arrayLength] = ds("arraylength");
    t[EXP.delegatePointer] = ds("delegateptr");
    t[EXP.delegateFunctionPointer] = ds("delegatefuncptr");
    t[EXP.remove] = ds("remove");
    t[EXP.tuple] = ds("sequence");
    t[EXP.traits] = ds("__traits");
    t[EXP.overloadSet] = ds("__overloadset");
    t[EXP.void_] = ds("void");
    t[EXP.vectorArray] = ds("vectorarray");
    t[EXP._Generic] = ds("_Generic");

    // post
    t[EXP.dotTemplateInstance] = ds("dotti");
    t[EXP.dotIdentifier] = ds("dotid");
    t[EXP.dotTemplateDeclaration] = ds("dottd");
    t[EXP.dot] = ds(".");
    t[EXP.dotType] = ds("dottype");
    t[EXP.plusPlus] = ds("++");
    t[EXP.minusMinus] = ds("--");
    t[EXP.prePlusPlus] = ds("++");
    t[EXP.preMinusMinus] = ds("--");
    t[EXP.call] = ds("call");
    t[EXP.slice] = ds("..");
    t[EXP.array] = ds("[]");
    t[EXP.index] = ds("[i]");

    t[EXP.delegate_] = ds("delegate");
    t[EXP.address] = ds("&");
    t[EXP.star] = ds("*");
    t[EXP.negate] = ds("-");
    t[EXP.uadd] = ds("+");
    t[EXP.not] = ds("!");
    t[EXP.tilde] = ds("~");
    t[EXP.delete_] = ds("delete");
    t[EXP.new_] = ds("new");
    t[EXP.newAnonymousClass] = ds("newanonclass");
    t[EXP.cast_] = ds("cast");

    t[EXP.vector] = ds("__vector");
    t[EXP.pow] = ds("^^");

    t[EXP.mul] = ds("*");
    t[EXP.div] = ds("/");
    t[EXP.mod] = ds("%");

    t[EXP.add] = ds("+");
    t[EXP.min] = ds("-");
    t[EXP.concatenate] = ds("~");

    t[EXP.leftShift] = ds("<<");
    t[EXP.rightShift] = ds(">>");
    t[EXP.unsignedRightShift] = ds(">>>");

    t[EXP.lessThan] = ds("<");
    t[EXP.lessOrEqual] = ds("<=");
    t[EXP.greaterThan] = ds(">");
    t[EXP.greaterOrEqual] = ds(">=");
    t[EXP.in_] = ds("in");

    t[EXP.equal] = ds("==");
    t[EXP.notEqual] = ds("!=");
    t[EXP.identity] = ds("is");
    t[EXP.notIdentity] = ds("!is");

    t[EXP.and] = ds("&");
    t[EXP.xor] = ds("^");
    t[EXP.or] = ds("|");

    t[EXP.andAnd] = ds("&&");
    t[EXP.orOr] = ds("||");

    t[EXP.question] = ds("?");

    t[EXP.assign] = ds("=");
    t[EXP.construct] = ds("=");
    t[EXP.blit] = ds("=");
    t[EXP.addAssign] = ds("+=");
    t[EXP.minAssign] = ds("-=");
    t[EXP.concatenateAssign] = ds("~=");
    t[EXP.concatenateElemAssign] = ds("~=");
    t[EXP.concatenateDcharAssign] = ds("~=");
    t[EXP.mulAssign] = ds("*=");
    t[EXP.divAssign] = ds("/=");
    t[EXP.modAssign] = ds("%=");
    t[EXP.powAssign] = ds("^^=");
    t[EXP.leftShiftAssign] = ds("<<=");
    t[EXP.rightShiftAssign] = ds(">>=");
    t[EXP.unsignedRightShiftAssign] = ds(">>>=");
    t[EXP.andAssign] = ds("&=");
    t[EXP.orAssign] = ds("|=");
    t[EXP.xorAssign] = ds("^=");

    t[EXP.comma] = ds(",");
    t[EXP.declaration] = ds("declaration");

    t[EXP.interval] = ds("interval");
    t[EXP.loweredAssignExp] = ds("=");

    t[EXP.thrownException] = ds("CTFE ThrownException");
    t[EXP.cantExpression] = ds("<cant>");
    t[EXP.voidExpression] = ds("cast(void)0");
    t[EXP.showCtfeContext] = ds("<error>");
    t[EXP.break_] = ds("<break>");
    t[EXP.continue_] = ds("<continue>");
    t[EXP.goto_] = ds("<goto>");
    return t;
})();

/****************************************
 * dmd/hdrgen.d:4602 — `string EXPtoString(EXP op)`. Convert EXP to char*.
 *
 * Returns the display spelling of `op` — what diagnostics and the `-vcg-ast`/debug printers put
 * behind a `%s` (`opover.d:295` `EXPtoString(e.op).ptr`, `expressionsem.d:1468`, …). D's `string`
 * is a byte slice, so the port returns `DString`.
 *
 * Contract: the returned slice is the SHARED table entry, not a copy — D returns a slice of an
 * `immutable` literal, so no caller may mutate it. (Same discipline as `Token.toStringValue`,
 * tokens.ts.) Cost: one array index; no allocation on the found path.
 *
 * Unknown `op` (the five slots D never fills): prints `error: EXP %d has no string` to stdout and
 * returns `"XXXXX"` — D does NOT assert there (hdrgen.d:4754 keeps `//assert(0);` commented out),
 * so neither do we.
 */
export function EXPtoString(op: EXP): DString {
    const p = EXPtoStringTable[op]; // hdrgen.d:4749
    if (!p) {
        // hdrgen.d:4752 — `printf("error: EXP %d has no string\n", op);` — C stdout, via the one
        // format shim (10 §3.5) and a single `process.stdout.write` (10 §4.4).
        process.stdout.write(dsToJs(dmdformat(ds("error: EXP %d has no string\n"), [op])));
        return ds("XXXXX"); // hdrgen.d:4753
        // hdrgen.d:4754 — `//assert(0);` is commented out upstream; not emitted.
    }
    assert(p); // hdrgen.d:4756 — D's own `assert(p)`, ordinary translated code (11 §2.5)
    // hdrgen.d:4757 — `return p[0 .. strlen(p)];`. The table entries are `DString`s carrying no
    // NUL, so their `.length` IS `strlen(p)` and the slice is the whole entry.
    return p;
}

// Provider side of dsymbol.ts's registration slot for `Dsymbol.toChars` (dsymbol.d:455, a
// function-local `import dmd.hdrgen : toChars`; 01 §4.4 inversion). Not a D statement.
registerDsymbolToChars(dsymbolToChars);
