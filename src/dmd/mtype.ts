// Ported from dmd/mtype.d (module dmd.mtype) — LDC 1.43.0-beta1 / DMD 2.113.
//
// FAITHFUL 1:1 TRANSLATION of the whole of dmd/mtype.d: every one of its 63 top-level
// declarations (plus the two nested aggregates `Type.Mcache` and `TypeFunction.BitFields`) is
// translated, dropped-with-comment (07-compile-time.md), or walled (11-escalate.md §2.5).
// Two of the 63 are CT-only and emit nothing at their declaration site — the `mixin template
// VisitType(Result)` (mtype.d:2817) and its CTFE string helper `visitTYCase` (mtype.d:2881);
// both are recorded with a `// resolved:` drop note at the position they occupy in the D file
// (below `toBooleanVector`), per 07-compile-time.md §5/§6.
//
// Cross-core type references use `import type` (01-conventions.md §3-strict-mode / §4.2): erased
// at emit, so they contribute zero to the ESM load cycle of the core SCC. The concrete classes
// (Expression, ClassDeclaration, ...) are batch siblings whose headers are being stubbed in
// parallel; integration wires the value edges once all headers exist.

// ── Cross-core imports ─────────────────────────────────────────────────────────────────────
// `ASTNode` is the faithful base of both `Type` and `Parameter` (dmd/mtype.d:390, :2286). It is a
// VALUE import (not `import type`): `class Type extends ASTNode` needs the runtime class. `extends`
// across the core SCC cycle is verified load-safe (01-conventions.md §4.1) — the class object is
// read at `extends`-eval, which runs after ast_node.ts has finished evaluating in the batch.
// Body-fill (this phase) re-adds the VALUE imports the structural bodies need (01-conventions.md
// Rule 4.3 — a value import referenced only inside constructor/method bodies is load-safe, since it
// is read post-load, not at module top level):
//   - `IntegerExp` / `Expression`: `IntegerExp.fromValue(0)` — D `new IntegerExp(0)`, the TypeSArray
//     incomplete-type ctor (mtype.d:1133) — and
//     `Expression.arraySyntaxCopy(exps)` (TypeMixin.syntaxCopy, mtype.d:1598).
//   - `Loc`: `Loc.initial` for the TypeTuple convenience ctors (mtype.d:1992, :1998).
//   - `Array` (the runtime container): `new Parameters(...)` / `new Objects()` constructions.
import { assert, assertUnreachable } from "../assert.js";
import { ASTNode } from "./ast_node.js";
import type { Visitor } from "./visitor/index.js";
import type { Identifier } from "./identifier.js";
import type { RootObject } from "./rootobject.js";
import type { DString } from "../dstring.js";
// Body-fill (Rule 4.3 — value import referenced only inside function bodies, read post-load):
// `ds` builds the NUL-terminated `toChars()` returns; `dsToJs` backs `MODmerge`'s deco comparison
// and the `Type.syntaxCopy` base-arm stderr diagnostic.
import { dsToJs, ds } from "../dstring.js";
import { Loc } from "./location.js";
import { Expression, IntegerExp } from "./expression.js";
// Body-fill (Rule 4.3 — value imports read post-load, only inside `typeToExpression*` bodies):
// the expression node kinds a mistakenly-parsed type is rebuilt as (mtype.d:79-177).
import { DotIdExp, DotTemplateInstanceExp, ArrayExp, TypeExp, IdentifierExp, ScopeExp } from "./expression.js";
import type { TraitsExp } from "./expression.js";
import type { Dsymbol, ScopeDsymbol } from "./dsymbol.js";
// Body-fill (Rule 4.3 — value import read post-load, only inside getThrowable/getException):
// the predefined-identifier singletons `object`/`Throwable`/`Exception`/`empty` (mtype.d:2929).
import { Id } from "./id.js";
// Body-fill (Rule 4.3 — value import read post-load): the printf engine (10 §3.5) used by the
// `Type.syntaxCopy` base-arm stderr diagnostic (mtype.d:548).
import { dmdformat } from "./root/dmdformat.js";
// Value import (load-safe — `Expression`/`IntegerExp` above already value-import from this module):
// the TypeFunction ctor default-constructs `inferenceArguments` to an empty ArgumentList (D's inline
// value-struct member starts empty). Read/constructed only inside method bodies (post-load).
import { ArgumentList } from "./expression.js";
import { Array as Array_ } from "./root/array.js";
import type { TypeInfoDeclaration } from "./declaration.js";
import type { ClassDeclaration } from "./dclass.js";
import type { StructDeclaration } from "./dstruct.js";
import type { EnumDeclaration } from "./denum.js";
import type { TemplateDeclaration } from "./dtemplate.js";
import type { TemplateInstance } from "./dtemplate.js";
import type { UserAttributeDeclaration } from "./attrib.js";
// Array!T aliases (arraytypes.d) — also batch siblings; type-only here.
import type { Types } from "./arraytypes.js";
import type { Objects } from "./arraytypes.js";
import type { Expressions } from "./arraytypes.js";
import type { Dsymbols } from "./arraytypes.js";
import type { Parameters } from "./arraytypes.js";
// StringTable!Type stores Type values; type-only at header stage.
// Body-fill: `StringTable` becomes a VALUE import — `_init` constructs `new StringTable<Type | null>()`
// (the deco-interning table). Runtime module, low bucket — value import is load-safe.
import { StringTable } from "./root/stringtable.js";
// Body-fill (Rule 4.3 — value imports read post-load, only inside `Type.toChars`/`toPrettyChars`):
// hdrgen's Type printer (hdrgen.d:221) and the buffer form + mode flags it is built on
// (`toPrettyChars` sets `hgs.fullQual`, mtype.d:619). hdrgen.ts value-imports `Type` from this
// module the same body-phase way — the mtype↔hdrgen cycle has no load-time reads on either side.
import { typeToChars, typeToCBuffer, HdrGenState } from "./hdrgen.js";

// ── Value imports: enums/consts/runtime used in field types & signatures ───────────────────
// These are lower-bucket (astenums Bucket-0, outbuffer runtime) — value imports are load-safe.
import { TY, TMAX } from "./astenums.js";
import type { MOD } from "./astenums.js";
import { STC } from "./astenums.js";
import { TRUST, PURE, VarArg, AliasThisRec, CPPMANGLE, LINK } from "./astenums.js";
// Body-fill: `MODFlags`/`MATCH`/`TFlags`/`structalign_t` become VALUE imports — the structural
// bodies read their members (MOD bit logic, MATCH results, TFlags bit tests, `new structalign_t()`).
import { MODFlags, MATCH, TFlags, structalign_t } from "./astenums.js";
import { DYNCAST } from "./rootobject.js";
// Body-fill: `OutBuffer` becomes a VALUE import — `merge()` constructs `new OutBuffer()` to mangle
// this type's deco. The runtime module is a low bucket; the value import is load-safe.
import { OutBuffer } from "./common/outbuffer.js";
// Body-fill (Rule 4.3 — value import read post-load, only inside `merge()`): the type-deco mangler.
// `mangle/index.ts` VALUE-imports `Type` from this module, so this is a value-import cycle; it is

// ── Module-private state backing `Type.getUniqueID` (dmd/mtype.d:593) ──────────────────────
// D returns `cast(size_t) deco` — the ADDRESS of the interned deco string. JS has no addresses,
// so the port substitutes a module-private id table keyed by the interned deco (see the interface
// comment on `Type.getUniqueID` for why the substitution is exact for the one live consumer).
// `// D module-private` (01-conventions.md): module scope, touched only by that method.
const decoUniqueIDs = new Map<string, number>();
let decoUniqueIDCounter = 0;

/**
 * No D counterpart: the djs driver's reset between two compiles in one process (src/djs.ts
 * `deinitializeFrontend`), next to `Type.deinitialize` (dmd/mtype.d:632), which clears only the type table. Puts
 * back the load-time value of the `__gshared` slots object.d's declarations fill (`dtypeinfo` ... `rtinfoImpl`,
 * dmd/mtype.d:473-494: unassigned, which every reader tests with `!`), of `TypeTuple.empty` (its deco is interned
 * in the finished compile's type table), and of the `getUniqueID` numbering.
 */
export function resetTypeGlobals(): void {
    Type.dtypeinfo = Type.typeinfoclass = Type.typeinfointerface = Type.typeinfostruct = undefined!;
    Type.typeinfopointer = Type.typeinfoarray = Type.typeinfostaticarray = undefined!;
    Type.typeinfoassociativearray = Type.typeinfovector = Type.typeinfoenum = Type.typeinfofunction = undefined!;
    Type.typeinfodelegate = Type.typeinfotypelist = Type.typeinfoconst = Type.typeinfoinvariant = undefined!;
    Type.typeinfoshared = Type.typeinfowild = undefined!;
    Type.rtinfo = Type.rtinfoImpl = undefined!;
    TypeTuple.empty = new TypeTuple();
    decoUniqueIDs.clear();
    decoUniqueIDCounter = 0;
}

// ── Manifest constants (02-types.md §4.1) ──────────────────────────────────────────────────
// dmd/mtype.d:41 — `enum LOGDOTEXP = 0;` (log ::dotExp()). Module-private debug toggle.
const LOGDOTEXP = 0;
void LOGDOTEXP; // referenced only in bodies (LOG ::dotExp); silence noUnusedLocals at header stage
// dmd/mtype.d:43 — `enum SIZE_INVALID = (~cast(ulong)0);` error return from size(). ulong -> bigint.
export const SIZE_INVALID: bigint = ~0n & 0xFFFFFFFFFFFFFFFFn;

// resolved: dmd/mtype.d:45-50 `static if (__VERSION__ < 2095)` is FALSE (__VERSION__ == 2113,
// 07-compile-time.md §3.2) — the `private alias StringValueType = StringValue!Type;` linker
// workaround for pre-2.095 host compilers is not emitted.

// ── Named enumerations (02-types.md §4.2) ──────────────────────────────────────────────────

/// dmd/mtype.d:371 — dotExp() bit flags.
export enum DotExpFlag {
  none = 0,
  gag = 1,         // don't report "not a property" error and just return null
  noDeref = 2,     // the use of the expression will not attempt a dereference
  noAliasThis = 4, // don't do 'alias this' resolution
}

/// dmd/mtype.d:380 — Result of a check whether two types are covariant.
export enum Covariant {
  distinct = 0, /// types are distinct
  yes = 1,      /// types are covariant
  no = 2,       /// arguments match as far as overloading goes, but types are not covariant
  fwdref = 3,   /// cannot determine covariance because of forward references
}

/// dmd/mtype.d:1307 — function return-style classification.
export enum RET {
  regs = 1,  // returned in registers
  stack = 2, // returned on stack
}

/// dmd/mtype.d:1313 — controls whether @system is emitted for TRUST.default_.
export enum TRUSTformat {
  TRUSTformatDefault, // do not emit @system when trust == TRUST.default_
  TRUSTformatSystem,  // emit @system when trust == TRUST.default_
}
// dmd/mtype.d:1319-1320 — `alias TRUSTformatDefault = TRUSTformat.TRUSTformatDefault;` etc.
// (symbol aliases of enum members, 02 §5.3 -> const rebind for local use).
export const TRUSTformatDefault = TRUSTformat.TRUSTformatDefault;
export const TRUSTformatSystem = TRUSTformat.TRUSTformatSystem;

/// dmd/mtype.d:2726 — Classification of 'scope-return-ref' possibilities.
export enum ScopeRef {
  None,
  Scope,
  ReturnScope,
  Ref,
  ReturnRef,
  RefScope,
  ReturnRef_Scope,
  Ref_ReturnScope,
  Return,
}

// ── Module-level free functions (signatures only; bodies later) ────────────────────────────

// dmd/mtype.d:52 — `private auto X(T, U)(T m, U n) { return (m << 4) | n; }`. Packs two MOD bytes
// into a switch key. MOD is the `number` domain (09 §1) — plain JS `<<`/`|` (no truncation needed,
// the operands are <=5-bit mod-flag values).
function X(m: number, n: number): number {
  return (m << 4) | n;
}

/// dmd/mtype.d:57 — `bool isImaginaryNonSemantic(Type _this)`. True when `_this` is one of the
/// `ifloat`/`idouble`/`ireal` basic types, WITHOUT running semantic (hence "NonSemantic": the caller
/// guarantees `_this` is not a `TypeEnum`, which would need its member type resolved first).
///
/// Precondition (D `assert`): `_this.isTypeEnum() is null`. UFCS free function in D — kept free here.
export function isImaginaryNonSemantic(_this: Type): boolean {
  assert(_this.isTypeEnum() === null);
  const tb = _this.isTypeBasic();
  if (tb)
    return (tb.flags & TFlags.imaginary) !== 0;
  return false;
}

/// dmd/mtype.d:65 — `Type toBaseTypeNonSemantic(Type _this)`. Walk an enum type down to its member
/// type WITHOUT running semantic: an enum with neither members nor an explicit `memtype` is a forward
/// reference and is returned as-is; otherwise recurse through `memtype`. Non-enum types are the
/// identity. UFCS free function in D (`te.sym.memtype.toBaseTypeNonSemantic()`) — kept free here.
export function toBaseTypeNonSemantic(_this: Type): Type {
  const te = _this.isTypeEnum();
  if (te) {
    // 06 §2.7 — nullable-reference truthiness made explicit.
    if (te.sym!.members === null && te.sym!.memtype === null)
      return te;
    // UFCS: `te.sym.memtype.toBaseTypeNonSemantic()` -> receiver first (04 §6).
    return toBaseTypeNonSemantic(te.sym!.memtype!);
  }
  return _this;
}

/// dmd/mtype.d:79 — helper for `typeToExpression`; shared by the `TypeQualified` derived classes.
///
/// Walks the qualifier chain `t.idents[i .. $]` and wraps `e` once per component: an `Identifier`
/// becomes `e.ident`, a `TemplateInstance` becomes `e.name!(tiargs)`, and a type/expression index
/// becomes `e[…]` (dlang issue 1215). The remaining `DYNCAST` kinds cannot occur in a qualifier
/// chain — D `assert(0)`, reproduced as `assertUnreachable()`.
export function typeToExpressionHelper(t: TypeQualified, e: Expression, i = 0): Expression {
  // D: `foreach (id; t.idents[i .. t.idents.length])` — a slice walk over the qualifier components.
  for (let k = i; k < t.idents.length; k++) {
    const id = t.idents.opIndex(k);
    // D `final switch` over DYNCAST; the no-default form is reproduced with assertUnreachable.
    switch (id!.dyncast()) {
      // ... '. ident'
      case DYNCAST.identifier:
        e = new DotIdExp(e.loc, e, id as unknown as Identifier);
        break;

      // ... '. name!(tiargs)'
      case DYNCAST.dsymbol: {
        const ti = (id as unknown as Dsymbol).isTemplateInstance();
        assert(ti !== null);
        // mtype.d:97 — `new DotTemplateInstanceExp(e.loc, e, ti.name, ti.tiargs)` selects D's
        // `(Loc, Expression, Identifier, Objects*)` ctor, which expression.ts promoted to the named
        // factory `fromName` (04 §1.1(c)); the call site is rewritten to the target D chose. The
        // factory is LIVE (the dtemplate load cycle was resolved by the 01 §4.1 lazy-class shape).
        e = DotTemplateInstanceExp.fromName(e.loc, e, ti!.name, ti!.tiargs);
        break;
      }

      // ... '[type]'  (https://issues.dlang.org/show_bug.cgi?id=1215)
      case DYNCAST.type:
        e = new ArrayExp(t.loc, e, new TypeExp(t.loc, id as unknown as Type));
        break;

      // ... '[expr]'  (https://issues.dlang.org/show_bug.cgi?id=1215)
      case DYNCAST.expression:
        e = new ArrayExp(t.loc, e, id as unknown as Expression);
        break;

      case DYNCAST.object:
      case DYNCAST.tuple:
      case DYNCAST.parameter:
      case DYNCAST.statement:
      case DYNCAST.condition:
      case DYNCAST.templateparameter:
      case DYNCAST.initializer:
        return assertUnreachable(); // D `assert(0)` (mtype.d:117)
      default:
        return assertUnreachable(); // D final switch has no default arm
    }
  }
  return e;
}

/// dmd/mtype.d:131 — `Expression typeToExpression(Type t)`. We've mistakenly parsed `t` as a type;
/// redo it as an Expression, but ONLY when there are no type modifiers.
///
/// Returns: `t` redone as an Expression, or null if it cannot be. The D body's five `static`
/// nested functions become inner `const` arrows (04 §5); the trailing `switch (t.ty)` dispatch is
/// reproduced verbatim, including the `default: return null` arm.
export function typeToExpression(t: Type): Expression | null {
  const visitSArray = (t: TypeSArray): Expression | null => {
    // UFCS: `t.next.typeToExpression()` -> this same free function (04 §6). Declaration-in-condition
    // hoisted to a const (06 §2.6) and null-tested (06 §2.7).
    const e = typeToExpression(t.next!);
    if (e !== null)
      return new ArrayExp(t.dim!.loc, e, t.dim);
    return null;
  };

  const visitAArray = (t: TypeAArray): Expression | null => {
    const e = typeToExpression(t.next!);
    if (e !== null) {
      const ei = typeToExpression(t.index!);
      if (ei !== null)
        return new ArrayExp(t.loc, e, ei);
    }
    return null;
  };

  const visitIdentifier = (t: TypeIdentifier): Expression | null =>
    typeToExpressionHelper(t, new IdentifierExp(t.loc, t.ident));

  // mtype.d:157 — `new ScopeExp(t.loc, t.tempinst)`. D reads `tempinst` with no null test, so the
  // `!` marks D's own fault point; the cascade is the 02 §11.5 audited upcast —
  // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool), which
  // is what makes TS reject TemplateInstance (IS-A ScopeDsymbol at runtime) structurally here.
  const visitInstance = (t: TypeInstance): Expression | null =>
    typeToExpressionHelper(t, new ScopeExp(t.loc, t.tempinst! as unknown as ScopeDsymbol));

  // easy way to enable 'auto v = new int[mixin("exp")];' in 2.088+
  const visitMixin = (t: TypeMixin): Expression | null => new TypeExp(t.loc, t);

  if (t.mod !== 0) // 09 §9 — `if (t.mod)` over the number-domain MOD mask
    return null;
  switch (t.ty) {
    case TY.Tsarray:   return visitSArray(t.isTypeSArray()!);
    case TY.Taarray:   return visitAArray(t.isTypeAArray()!);
    case TY.Tident:    return visitIdentifier(t.isTypeIdentifier()!);
    case TY.Tinstance: return visitInstance(t.isTypeInstance()!);
    case TY.Tmixin:    return visitMixin(t.isTypeMixin()!);
    default:           return null;
  }
}

/// dmd/mtype.d:182 — Return !=0 if modfrom can be implicitly converted to modto.
export function MODimplicitConv(modfrom: MOD, modto: MOD): boolean {
  if (modfrom === modto)
    return true;

  switch (X(modfrom & ~MODFlags.shared_, modto & ~MODFlags.shared_)) {
    case X(0, MODFlags.const_):
    case X(MODFlags.wild, MODFlags.const_):
    case X(MODFlags.wild, MODFlags.wildconst):
    case X(MODFlags.wildconst, MODFlags.const_):
      return (modfrom & MODFlags.shared_) === (modto & MODFlags.shared_);

    case X(MODFlags.immutable_, MODFlags.const_):
    case X(MODFlags.immutable_, MODFlags.wildconst):
      return true;
    default:
      return false;
  }
}

/// dmd/mtype.d:208 — MATCH.exact/constant if a `() modfrom` method can call a `() modto` method.
export function MODmethodConv(modfrom: MOD, modto: MOD): MATCH {
  if (modfrom === modto)
    return MATCH.exact;
  if (MODimplicitConv(modfrom, modto))
    return MATCH.constant;

  switch (X(modfrom, modto)) {
    case X(0, MODFlags.wild):
    case X(MODFlags.immutable_, MODFlags.wild):
    case X(MODFlags.const_, MODFlags.wild):
    case X(MODFlags.wildconst, MODFlags.wild):
    case X(MODFlags.shared_, MODFlags.shared_ | MODFlags.wild):
    case X(MODFlags.shared_ | MODFlags.immutable_, MODFlags.shared_ | MODFlags.wild):
    case X(MODFlags.shared_ | MODFlags.const_, MODFlags.shared_ | MODFlags.wild):
    case X(MODFlags.shared_ | MODFlags.wildconst, MODFlags.shared_ | MODFlags.wild):
      return MATCH.constant;

    default:
      return MATCH.nomatch;
  }
}

/// dmd/mtype.d:235 — Merge mod bits to form common mod.
export function MODmerge(mod1: MOD, mod2: MOD): MOD {
  if (mod1 === mod2)
    return mod1;

  let result = 0;
  if ((mod1 | mod2) & MODFlags.shared_) {
    // If either type is shared, the result will be shared
    result |= MODFlags.shared_;
    mod1 &= ~MODFlags.shared_;
    mod2 &= ~MODFlags.shared_;
  }
  if (mod1 === 0 || mod1 === MODFlags.mutable || mod1 === MODFlags.const_ ||
      mod2 === 0 || mod2 === MODFlags.mutable || mod2 === MODFlags.const_) {
    // If either type is mutable or const, the result will be const.
    result |= MODFlags.const_;
  } else {
    // MODFlags.immutable_ vs MODFlags.wild / wildconst, or wild vs wildconst
    assert((mod1 & MODFlags.wild) !== 0 || (mod2 & MODFlags.wild) !== 0);
    result |= MODFlags.wildconst;
  }
  return result;
}

/// dmd/mtype.d:268 — Store modifier name into buf. D's `ref OutBuffer buf` is an alias, not a copy
/// (03 §3.2) — pass the object, never `.copy()`.
export function MODtoBuffer(buf: OutBuffer, mod: MOD): void {
  buf.writestring(ds(MODtoString(mod)));
}

/// dmd/mtype.d:278 — human-readable representation of `mod` as a C string (`const(char)*`).
///
/// D returns `MODtoString(mod).ptr` and the comment at mtype.d:280 states why that is legal:
/// "Works because we return a literal" — a D string literal's static data carries a trailing NUL,
/// so the returned `char*` is a valid C string. The port must reproduce that: the C-string view
/// (02 §11) requires `toChars()`-shaped returns to be NUL-TERMINATED `DString`s, and `ds()` alone
/// allocates exactly `literal.length` bytes with no terminator — `cstrlen`/`cstr`/`%s` would then
/// read past the buffer. Hence the explicit trailing `\0`.
export function MODtoChars(mod: MOD): DString {
  return ds(MODtoString(mod) + "\0");
}

/// dmd/mtype.d:285 — human-readable representation of `mod`. The D `final switch (mod)` enumerates
/// every valid MOD combination; an out-of-range value is unreachable (assertUnreachable mirrors the
/// no-default final switch). The return is a JS `string` literal — these are literal tokens, not a
/// C-string buffer, so the `string` signature is faithful (08-runtime-lib.md applies only to the
/// `const(char)*` return of `MODtoChars`, which is where the NUL-termination is added).
export function MODtoString(mod: MOD): string {
  switch (mod) {
    case 0:
      return "";
    case MODFlags.immutable_:
      return "immutable";
    case MODFlags.shared_:
      return "shared";
    case MODFlags.shared_ | MODFlags.const_:
      return "shared const";
    case MODFlags.const_:
      return "const";
    case MODFlags.shared_ | MODFlags.wild:
      return "shared inout";
    case MODFlags.wild:
      return "inout";
    case MODFlags.shared_ | MODFlags.wildconst:
      return "shared inout const";
    case MODFlags.wildconst:
      return "inout const";
    default:
      return assertUnreachable();
  }
}

/// dmd/mtype.d:322 — string representation of a single trust flag. D returns `null` for
/// TRUST.default_ — kept as the JS empty string is WRONG (the unittest asserts `== ""` only because
/// D's `null` string compares equal to `""`); faithful port returns `""` for default_ (D `null`
/// string == "" is true, and the call sites treat it as empty). Final switch over the 4 TRUST values.
export function trustToString(trust: TRUST): string {
  switch (trust) {
    case TRUST.default_:
      return "";
    case TRUST.system:
      return "@system";
    case TRUST.trusted:
      return "@trusted";
    case TRUST.safe:
      return "@safe";
    default:
      return assertUnreachable();
  }
}

/// dmd/mtype.d:348 — Convert MODxxxx to STCxxx. `mod` is a `uint` mask (number domain); the result
/// is an STC flag set (branded bigint, 02 §4.2) — members OR with BigInt `|`.
export function ModToStc(mod: number): STC {
  let stc = STC.none;
  if (mod & MODFlags.immutable_)
    stc = (stc | STC.immutable_) as STC;
  if (mod & MODFlags.const_)
    stc = (stc | STC.const_) as STC;
  if (mod & MODFlags.wild)
    stc = (stc | STC.wild) as STC;
  if (mod & MODFlags.shared_)
    stc = (stc | STC.shared_) as STC;
  return stc;
}

/// dmd/mtype.d:363 — Returns true if ty is char, wchar, or dchar.
export function isSomeChar(ty: TY): boolean {
  return ty === TY.Tchar || ty === TY.Twchar || ty === TY.Tdchar;
}

/// dmd/mtype.d:2597 — names of both types for a two-type diagnostic: the plain `toChars` spellings,
/// upgraded to fully-qualified (`toPrettyChars(true)`) ONLY when two DIFFERENT types share a spelling
/// (e.g. two structs named `S` from different modules). Fully live: the collision arm rides the
/// rung-4c `toPrettyChars` port (exercised ungagged by getProperty's "no property" operand).
export function toAutoQualChars(t1: Type, t2: Type): [DString, DString] {
  let s1 = t1.toChars();
  let s2 = t2.toChars();
  // mtype.d:2602-2606 — show qualification only if it's different.
  if (!t1.equals(t2) && dsToJs(s1) === dsToJs(s2)) {
    s1 = t1.toPrettyChars(true);
    s2 = t2.toPrettyChars(true);
  }
  return [s1, s2];
}

/// dmd/mtype.d:2615 — for each active modifier (const/immutable/inout/shared) call `dg` with its
/// string representation. `modsArr` is D's `immutable ubyte[4]` static array (02 §7) — a fixed
/// module-local literal here, never mutated.
export function modifiersApply(tf: TypeFunction, dg: (s: string) => void): void {
  const modsArr: number[] = [MODFlags.const_, MODFlags.immutable_, MODFlags.wild, MODFlags.shared_];

  for (const modsarr of modsArr) {
    if (tf.mod & modsarr) // 09 §9 — number-domain mask test
      dg(MODtoString(modsarr));
  }
}

/// dmd/mtype.d:2632 — for each active attribute (pure/nothrow/@nogc/@property/scope-ref-return/@live/
/// trust) call `dg` with its string representation, in dmd's canonical ordering.
///
/// The scope/ref/return group is collapsed through `buildScopeRef` so the emitted order matches
/// `dmd.hdrgen.stcToBuffer`. `trustFormat == TRUSTformatSystem` forces `@system` to be emitted even
/// when the trust level is `default_` (which otherwise emits nothing).
export function attributesApply(
  tf: TypeFunction,
  dg: (s: string) => void,
  trustFormat: TRUSTformat = TRUSTformatDefault,
): void {
  if (tf.purity !== PURE.impure) // 09 §9.1 — enum-typed value in a boolean context; PURE.impure == 0
    dg("pure");
  if (tf.isNothrow)
    dg("nothrow");
  if (tf.isNogc)
    dg("@nogc");
  if (tf.isProperty)
    dg("@property");

  /* The following is more or less like dmd.hdrgen.stcToBuffer(), in the future
   * it should be merged. The idea is consistent ordering
   */
  let stc: STC = STC.none;
  if (tf.isRef)
    stc = (stc | STC.ref_) as STC;
  if (tf.isReturn && !tf.isReturnInferred)
    stc = (stc | STC.return_) as STC;
  if (tf.isScopeQual && !tf.isScopeInferred)
    stc = (stc | STC.scope_) as STC;
  if (tf.isReturnScope)
    stc = (stc | STC.returnScope) as STC;
  switch (buildScopeRef(stc)) {
    case ScopeRef.None:                                                      break;
    case ScopeRef.Scope:            dg("scope");                             break;
    case ScopeRef.Return:           dg("return");                            break;
    case ScopeRef.ReturnScope:      dg("return"); dg("scope");               break;
    case ScopeRef.ReturnRef:        dg("return"); dg("ref");                 break;
    case ScopeRef.Ref:              dg("ref");                               break;
    case ScopeRef.RefScope:         dg("ref");    dg("scope");               break;
    case ScopeRef.ReturnRef_Scope:  dg("return"); dg("ref");    dg("scope"); break;
    case ScopeRef.Ref_ReturnScope:  dg("ref");    dg("return"); dg("scope"); break;
    default:                        return assertUnreachable(); // D final switch, no default arm
  }

  if (tf.isLive)
    dg("@live");

  let trustAttrib: TRUST = tf.trust;

  if (trustAttrib === TRUST.default_) {
    if (trustFormat !== TRUSTformatSystem)
      return;
    trustAttrib = TRUST.system; // avoid calling with an empty string
  }

  dg(trustToString(trustAttrib));
}

/// dmd/mtype.d:2691 — compute how a parameter may be returned (ScopeRef classification). `stc` is
/// an STC flag set (branded bigint); the switch key is the masked bigint, compared against the
/// STC member-combination bigints.
export function buildScopeRef(stc: STC): ScopeRef {
  let s: bigint = stc;
  if (s & STC.out_)
    s = s | STC.ref_; // treat `out` and `ref` the same

  let result: ScopeRef;
  switch (s & (STC.ref_ | STC.scope_ | STC.return_)) {
    case STC.none:
      result = ScopeRef.None;
      break;

    // can occur where `inout` adds `return` without `scope` or `ref`
    case STC.return_:
      result = ScopeRef.Return;
      break;

    case STC.ref_:
      result = ScopeRef.Ref;
      break;
    case STC.scope_:
      result = ScopeRef.Scope;
      break;
    case STC.return_ | STC.ref_:
      result = ScopeRef.ReturnRef;
      break;
    case STC.return_ | STC.scope_:
      result = ScopeRef.ReturnScope;
      break;
    case STC.ref_ | STC.scope_:
      result = ScopeRef.RefScope;
      break;

    case STC.return_ | STC.ref_ | STC.scope_:
      result = (s & STC.returnScope) ? ScopeRef.Ref_ReturnScope : ScopeRef.ReturnRef_Scope;
      break;
    default:
      return assertUnreachable();
  }
  return result;
}

/// dmd/mtype.d:2746 — debug string for a ScopeRef value. D returns the `const(char)*` from a
/// `char*[]` table indexed by `sr`; the port returns the JS string literal directly (a debug name,
/// not a C-string buffer — the `string` signature is faithful here).
export function ScopeRefToChars(sr: ScopeRef): string {
  switch (sr) {
    case ScopeRef.None:            return "None";
    case ScopeRef.Scope:           return "Scope";
    case ScopeRef.ReturnScope:     return "ReturnScope";
    case ScopeRef.Ref:             return "Ref";
    case ScopeRef.ReturnRef:       return "ReturnRef";
    case ScopeRef.RefScope:        return "RefScope";
    case ScopeRef.ReturnRef_Scope: return "ReturnRef_Scope";
    case ScopeRef.Ref_ReturnScope: return "Ref_ReturnScope";
    case ScopeRef.Return:          return "Return";
    default:                       return assertUnreachable();
  }
}

/// dmd/mtype.d:2779 — create the vector type that holds one boolean result per element of `tv`.
///
/// A SIMD comparison yields an all-1s / all-0s mask per lane; D has no mask type, so the closest
/// equivalent is an INTEGER vector of the same unit size and length. Integral (and void) element
/// types already are that — `tv` is returned unchanged; float/double element types are remapped to
/// `uint`/`ulong`. Any other element type is unreachable (D `assert(0)`).
export function toBooleanVector(tv: TypeVector): TypeVector {
  let telem: Type = tv.elementType();
  switch (telem.ty) {
    case TY.Tvoid:
    case TY.Tint8:
    case TY.Tuns8:
    case TY.Tint16:
    case TY.Tuns16:
    case TY.Tint32:
    case TY.Tuns32:
    case TY.Tint64:
    case TY.Tuns64:
      // No need to build an equivalent mask type.
      return tv;

    case TY.Tfloat32:
      telem = Type.tuns32;
      break;

    case TY.Tfloat64:
      telem = Type.tuns64;
      break;

    default:
      return assertUnreachable(); // D `assert(0)` (mtype.d:2805)
  }

  const tsa = tv.basetype.isTypeSArray();
  assert(tsa !== null);

  return new TypeVector(new TypeSArray(telem, tsa!.dim));
}

// resolved: dmd/mtype.d:2817 `mixin template VisitType(Result)` and dmd/mtype.d:2881
// `pure string visitTYCase(string handler)` emit NOTHING at their declaration site.
// `VisitType` is a MIXIN TEMPLATE: 07 §6 expands a `mixin Name!(args)` into the mixing-in scope,
// so the code belongs to each consumer (typesem.d and friends `mixin VisitType!(Result)` inside
// their own dispatch functions), not to this module — and its body is itself built from
// `mixin(visitTYCase("Xxx"))`, a CTFE string generator (07 §5) that is `assert(0)` at runtime
// (`if (__ctfe)`, mtype.d:2883/2921) and therefore has no runtime form to port at all.
// Emitting either one here would put a `mixin`/`__traits` token into TS, which 07 §11 calls a bug.
// Both rows of the 63-declaration manifest are accounted for by this note.

/// dmd/mtype.d:2929 — `TypeIdentifier` corresponding to `object.Throwable`.
export function getThrowable(): TypeIdentifier {
  const tid = new TypeIdentifier(Loc.initial, Id.empty);
  tid.addIdent(Id.object!);
  tid.addIdent(Id.Throwable!);
  return tid;
}

/// dmd/mtype.d:2941 — `TypeIdentifier` corresponding to `object.Exception`.
export function getException(): TypeIdentifier {
  const tid = new TypeIdentifier(Loc.initial, Id.empty);
  tid.addIdent(Id.object!);
  tid.addIdent(Id.Exception!);
  return tid;
}

// ───────────────────────────────────────────────────────────────────────────────────────────
// dmd/mtype.d:390 — `extern (C++) abstract class Type : ASTNode`
//
// The root of the type hierarchy. VALUE-vs-REFERENCE: a Type is a `class` (reference type, 02 §2).
// Interface contract (filled later): `kind()` is abstract-ish (asserts in base, overridden by each
// leaf); `syntaxCopy()` clones for parse-time; the `makeXxx`/`xxxOf` family lazily builds qualified
// variants cached in `mcache`. The `__gshared` static `Type` singletons (tvoid, tint32, ...) are
// declared here but CONSTRUCTED in `_init()` (Rule 4.5: no top-level `new` across the core cycle).
// ───────────────────────────────────────────────────────────────────────────────────────────
export abstract class Type extends ASTNode {
  // dmd/mtype.d:390 — `extern (C++) abstract class Type : ASTNode`. Faithful single-inheritance
  // chain Type -> ASTNode -> RootObject.

  ty: TY;
  mod: MOD = 0;                 // modifiers MODxxxx
  deco: string | null = null;   // `char* deco` -> C-string byte buffer (08); null until merged

  mcache: Mcache | null = null;            // `Mcache*` -> reference to the value-struct cache (02 §10)
  vtinfo: TypeInfoDeclaration | null = null; // TypeInfo object for this Type
  ctype: unknown = null;                   // `void* ctype` for back end -> opaque (02 §10)

  // dmd/mtype.d:434-467 — `__gshared Type` basic-type singletons. Declared, not constructed at
  // load (Rule 4.5); `_init()` fills them. `!:` = definite-assignment-in-_init.
  static tvoid: Type;
  static tint8: Type;
  static tuns8: Type;
  static tint16: Type;
  static tuns16: Type;
  static tint32: Type;
  static tuns32: Type;
  static tint64: Type;
  static tuns64: Type;
  static tint128: Type;
  static tuns128: Type;
  static tfloat32: Type;
  static tfloat64: Type;
  static tfloat80: Type;
  static timaginary32: Type;
  static timaginary64: Type;
  static timaginary80: Type;
  static tcomplex32: Type;
  static tcomplex64: Type;
  static tcomplex80: Type;
  static tbool: Type;
  static tchar: Type;
  static twchar: Type;
  static tdchar: Type;

  static tshiftcnt: Type;
  static tvoidptr: Type;    // void*
  static tstring: Type;     // immutable(char)[]
  static twstring: Type;    // immutable(wchar)[]
  static tdstring: Type;    // immutable(dchar)[]
  static terror: Type;      // for error recovery
  static tnull: Type;       // for null type
  static tnoreturn: Type;   // for bottom type typeof(*null)

  static tsize_t: Type;     // matches size_t alias
  static tptrdiff_t: Type;  // matches ptrdiff_t alias
  static thash_t: Type;     // matches hash_t alias

  static dtypeinfo: ClassDeclaration;
  static typeinfoclass: ClassDeclaration;
  static typeinfointerface: ClassDeclaration;
  static typeinfostruct: ClassDeclaration;
  static typeinfopointer: ClassDeclaration;
  static typeinfoarray: ClassDeclaration;
  static typeinfostaticarray: ClassDeclaration;
  static typeinfoassociativearray: ClassDeclaration;
  static typeinfovector: ClassDeclaration;
  static typeinfoenum: ClassDeclaration;
  static typeinfofunction: ClassDeclaration;
  static typeinfodelegate: ClassDeclaration;
  static typeinfotypelist: ClassDeclaration;
  static typeinfoconst: ClassDeclaration;
  static typeinfoinvariant: ClassDeclaration;
  static typeinfoshared: ClassDeclaration;
  static typeinfowild: ClassDeclaration;

  static rtinfo: TemplateDeclaration;
  // resolved: version(IN_LLVM) -> ON (_config.md). LDC-only second rtinfo template.
  static rtinfoImpl: TemplateDeclaration;

  // dmd/mtype.d:497 — `__gshared Type[TMAX] basic;` static array sized by TMAX (astenums.ts:251,
  // resolved CT: `TY.max + 1` == 48). Every slot is pre-filled with the `Type.init` a D static
  // array of class references starts from — `null` (09 §1.0) — so an unassigned TY tag reads
  // `null`, exactly as in D. Sizing it `TY.Tnone + 1` (== 12) left tags 12..47 as `undefined`
  // holes, which is NOT `Type.init` and defeats every `basic[ty] === null` test.
  static basic: (Type | null)[] = new Array<Type | null>(TMAX).fill(null);

  // dmd/mtype.d:499 — `__gshared StringTable!Type stringtable;`. Declared; `_init` constructs +
  // initializes it. Typed `StringTable<Type | null>` (NOT `<Type>`): D's `StringTable!Type` slot init
  // is `T.init == null` for a class `T`, and `merge`'s `update(...).value` IS null on a fresh slot —
  // so the honest element type is nullable (08-runtime-lib §5: no synthesized generic default; the
  // null is the real `T.init`). Consumers (`merge`, `decoToType`) already null-check `sv.value`.
  static stringtable: StringTable<Type | null>;

  // dmd/mtype.d:500 — `private static immutable ubyte[TMAX] sizeTy = (){...}();` per-TY instance
  // size, used by `copy()`/`nullAttributes()` to xmalloc the right number of bytes. Under GC this
  // sizing is moot, but the table is faithful data; built in the body phase (CTFE lambda).
  // dropped at body phase: the `mem.xmalloc(sizeTy[ty])` raw-allocation use vanishes (GC).

  // dmd/mtype.d:529 — `final extern (D) this(TY ty)`. super() = ASTNode/RootObject default ctor.
  constructor(ty: TY) {
    super();
    this.ty = ty;
  }

  /// dmd/mtype.d:534 — name of the type kind ("pointer", "function", ...). The base body is D's
  /// `assert(false); // should be overridden` — every leaf overrides it with its literal, so reaching
  /// the base is a bug. Faithful `assert(0)` -> `assertUnreachable()` (11 §2.5: NOT a wall).
  kind(): string {
    return assertUnreachable(); // should be overridden
  }

  /// dmd/mtype.d:539 — `final Type copy()` raw byte-copy of this type instance.
  ///
  /// D does `mem.xmalloc(sizeTy[ty]); memcpy(t, this, sizeTy[ty])` — a flat byte copy that
  /// (a) preserves the concrete runtime class, (b) SHARES every pointer/class-reference field
  /// (`next`, `sym`, `mcache` — `Mcache*` is a pointer), and (c) gives the new instance its OWN
  /// BITS of every INLINE VALUE STRUCT (`ParameterList`, `ArgumentList`, `Loc`, `structalign_t`,
  /// `Objects`). `Object.create` of this prototype reproduces (a) and `Object.assign` reproduces
  /// (b) — but `Object.assign` copies a value struct's *reference*, so it gets (c) exactly
  /// BACKWARDS: the clone would ALIAS the original's inline structs.
  ///
  /// That aliasing is not theoretical. `stripDefaultArgs` (typesem.d:9500, carried below) does
  /// `TypeFunction tr = tf.copy().isTypeFunction(); tr.parameterList.parameters = params;` —
  /// a write through the CLONE's `parameterList`, whose whole purpose is to leave `tf` untouched.
  /// Same shape at typesem.d:9509 (`tr.arguments = args` on a TypeTuple copy, a plain field so
  /// safe) and at cparse.d:2182/2186 (`ft.parameterList.hasIdentifierList = true`).
  ///
  /// So the copy re-clones each inline value struct per its own `.copy()` (03 §1.1 / §2). The
  /// per-kind branch list below is the COMPLETE set of inline value-struct fields in the mtype.d
  /// hierarchy; a new one added to any Type subclass must be added here too.
  /// The allocator (08 §8) is erased — the JS GC owns the new object.
  copy(): Type {
    const t = Object.assign(Object.create(Object.getPrototypeOf(this) as object) as Type, this);

    // TypeFunction: `ParameterList parameterList` (mtype.d:1328) + `ArgumentList inferenceArguments`
    // (mtype.d:1358) are inline value structs.
    const tf = t.isTypeFunction();
    if (tf !== null) {
      tf.parameterList = tf.parameterList.copy();
      tf.inferenceArguments = tf.inferenceArguments.copy();
    }
    // TypeQualified: `Loc loc` (mtype.d:1611) + `Objects idents` (mtype.d:1615).
    if (t.ty === TY.Tident || t.ty === TY.Tinstance || t.ty === TY.Ttypeof || t.ty === TY.Treturn) {
      const tq = t as unknown as TypeQualified;
      tq.loc = tq.loc.copy();
      tq.idents = tq.idents.copy();
    }
    // TypeAArray.loc (mtype.d:1203), TypeTraits.loc (:1541), TypeMixin.loc (:1580).
    const taa = t.isTypeAArray();
    if (taa !== null) taa.loc = taa.loc.copy();
    const ttr = t.isTypeTraits();
    if (ttr !== null) ttr.loc = ttr.loc.copy();
    const tmx = t.isTypeMixin();
    if (tmx !== null) tmx.loc = tmx.loc.copy();
    // TypeTag: `Loc loc` (mtype.d:2134) + `structalign_t packalign` (:2136).
    const ttg = t.isTypeTag();
    if (ttg !== null) {
      ttg.loc = ttg.loc.copy();
      ttg.packalign = ttg.packalign.copy();
    }
    return t;
  }

  /// dmd/mtype.d:546 — clone for parse-time. Overridden by every leaf; the base prints the offending
  /// type to stderr and asserts. Diagnostic assembled via `dmdformat` and written in ONE
  /// `process.stderr.write` (10 §4), then D's `assert(0)` -> `assertUnreachable()`.
  syntaxCopy(): Type {
    process.stderr.write(dsToJs(dmdformat(ds("this = %s, ty = %d\n"), [this.toChars(), this.ty])));
    return assertUnreachable();
  }

  /// dmd/mtype.d:552 — structural type equality. Identity short-circuit; tuples compare element
  /// types pairwise; otherwise two semantic'd types are equal iff their (interned) `deco` strings
  /// match. `this == t` (class ref) -> `===` identity (Type defines no opEquals); the per-element
  /// `arg1.type.equals(...)` recurses through this same method.
  ///
  /// `t` is `Type | null` (02 §10.1 — the BODY decides): mtype.d:576 null-tests it explicitly
  /// (`if ((t && deco == t.deco) && deco !is null)`), so D ANSWERS `false` for a null argument on
  /// the non-tuple path instead of faulting; typing the parameter non-null and dropping the guard
  /// would turn that answer into a TypeError. The tuple path (mtype.d:559 `t.ty != Ttuple`) DOES
  /// dereference with no test, so a null `t` faults there in D too — the `!` marks that same point.
  equals(t: Type | null): boolean {
    if ((this as Type) === (t as Type))
      return true;
    if (this.ty === TY.Ttuple) {
      // mtype.d:559 — `if (t.ty != Ttuple) return false;` reads `t.ty` with no null test.
      const t2 = t!.isTypeTuple();
      if (!t2)
        return false;
      const t1 = this.isTypeTuple()!;
      if (t1.arguments!.length !== t2.arguments!.length)
        return false;
      for (let i = 0; i < t1.arguments!.length; i++) {
        // slots are `Parameter | null` (08 §3); mtype.d:567-569 reads `.type` off both with no null
        // test. `arg1.type` is the RECEIVER of `equals` (faults in D if null) -> `!`; `arg2.type` is
        // the ARGUMENT, and `equals` accepts null (see the interface comment) -> no `!`.
        const arg1 = t1.arguments!.opIndex(i);
        const arg2 = t2.arguments!.opIndex(i);
        if (!arg1!.type!.equals(arg2!.type))
          return false;
      }
      return true;
    }
    // deco strings are unique and semantic() has been run
    // mtype.d:576 — the leading `t &&` is D's explicit null test; keep it.
    if (t !== null && this.deco === t.deco && this.deco !== null)
      return true;
    return false;
  }

  /// dmd/mtype.d:586 — kludge for template.isType(): a Type always dyncasts to DYNCAST.type.
  /// `override final DYNCAST dyncast()` — overrides RootObject.dyncast (via ASTNode).
  override dyncast(): DYNCAST {
    return DYNCAST.type;
  }

  /// dmd/mtype.d:593 — a non-zero unique ID for this Type, or 0 if the Type does not (yet) have one
  /// (i.e. `semantic()` has not run, so `deco` is null).
  ///
  /// D returns `cast(size_t) deco` — the ADDRESS of the interned deco string, which is unique per
  /// distinct deco precisely because `Type.stringtable` interns it. JS has no addresses, so the port
  /// reproduces the OBSERVABLE contract (stable, non-zero, one id per distinct deco, 0 when absent)
  /// with a module-private id table keyed by the interned deco string. The only consumer is
  /// `funcsem.d:3948`, which uses the value solely as a `bool[size_t]` cache key — never as an
  /// address, never in arithmetic — so the substitution is exact for every live use.
  getUniqueID(): number {
    if (this.deco === null)
      return 0;
    let id = decoUniqueIDs.get(this.deco);
    if (id === undefined) {
      id = ++decoUniqueIDCounter; // non-zero by construction (0 is reserved for "no deco")
      decoUniqueIDs.set(this.deco, id);
    }
    return id;
  }

  /// dmd/mtype.d:598 — lazily allocate and return the Mcache. D `mem.xcalloc(Mcache.sizeof, 1)`
  /// (zero-initialized) -> `new Mcache()` (all fields default to null, 08 §8 erases the allocator).
  getMcache(): Mcache {
    if (!this.mcache)
      this.mcache = new Mcache();
    return this.mcache;
  }

  /// dmd/mtype.d:609 — pretty-print this type. D `final override const(char)* toChars()` overrides
  /// RootObject.toChars (via ASTNode) -> returns a DString (the djs C-string model, 02 §11.2).
  /// Body: `return dmd.hdrgen.toChars(this);` — forwards to hdrgen's Type printer (hdrgen.d:221),
  /// live this rung for basic + dynamic-array types (other kinds halt in its guarded dispatch).
  override toChars(): DString {
    return typeToChars(this);
  }

  /// dmd/mtype.d:615 — pretty C string, optionally fully-qualified: same printer as `toChars` but
  /// with `hgs.fullQual = QualifyTypes`, so an aggregate spells as `<module>.S` when qualified
  /// (the `no property` diagnostic operand, typesem.d:3814 `mt.toPrettyChars(true)`).
  toPrettyChars(QualifyTypes = false): DString {
    const buf = new OutBuffer();
    buf.reserve(16);
    const hgs = new HdrGenState();
    hgs.fullQual = QualifyTypes;
    typeToCBuffer(this, buf, null, hgs);
    return buf.extractChars();
  }

  /// dmd/mtype.d:632 — deinitialize the global state of the compiler: restore the state `_init` set
  /// to its original state. D: `stringtable = stringtable.init;` — the struct's `.init` value, i.e. a
  /// default-constructed (empty, un-`_init`-ed) table. Port: a fresh `StringTable` instance; the
  /// allocation the D table owned is the GC's business (08 §13).
  static deinitialize(): void {
    Type.stringtable = new StringTable<Type | null>();
  }

  /// dmd/mtype.d:640 — store this type's modifier name into `buf`, prefixed by one space. A naked
  /// type (`mod == 0`) writes nothing. `ref OutBuffer buf` is an alias — pass the object (03 §3.2).
  modToBuffer(buf: OutBuffer): void {
    if (this.mod !== 0) { // 09 §9 — number-domain MOD mask
      buf.writeByte(0x20); // ' '
      MODtoBuffer(buf, this.mod);
    }
  }

  /// dmd/mtype.d:652 — this type's modifier name as a C string (`char*`, 02 §11.2 -> DString).
  /// `OutBuffer buf;` is a local value struct; `extractChars()` CONSUMES it (08 §13a.2) and returns
  /// the NUL-terminated bytes — that is exactly D's `buf.extractChars()`.
  modToChars(): DString {
    const buf = new OutBuffer();
    buf.reserve(16);
    this.modToBuffer(buf);
    return buf.extractChars();
  }

  isScopeClass(): boolean { return false; } // dmd/mtype.d:660

  // dmd/mtype.d:665-708 — pure bit tests over `mod` (final in D; cheap, implemented now).
  isConst(): boolean { return (this.mod & MODFlagsConst) !== 0; }
  isImmutable(): boolean { return (this.mod & MODFlagsImmutable) !== 0; }
  isMutable(): boolean { return (this.mod & (MODFlagsConst | MODFlagsImmutable | MODFlagsWild)) === 0; }
  isShared(): boolean { return (this.mod & MODFlagsShared) !== 0; }
  isSharedConst(): boolean {
    return (this.mod & (MODFlagsShared | MODFlagsConst)) === (MODFlagsShared | MODFlagsConst);
  }
  isWild(): boolean { return (this.mod & MODFlagsWild) !== 0; }
  isWildConst(): boolean { return (this.mod & MODFlagsWildconst) === MODFlagsWildconst; }
  isSharedWild(): boolean {
    return (this.mod & (MODFlagsShared | MODFlagsWild)) === (MODFlagsShared | MODFlagsWild);
  }
  isNaked(): boolean { return this.mod === 0; }

  /// dmd/mtype.d:714 — copy of this type with all cached attributes null-initialized, ready to be
  /// re-merged under a new `mod`.
  ///
  /// D: `xmalloc(sizeTy[ty]); memcpy(t, this, sizeTy[ty])` then null `deco`/`vtinfo`/`ctype`/`mcache`
  /// and reset `att` to `fwdref` for struct/class. The byte-copy is our `copy()` (same prototype +
  /// shallow field copy, 08 §8 erases the allocator); the nulling makes the clone a fresh,
  /// un-interned type whose `mod` the caller (the `makeXxx` family) then sets and `merge()` interns.
  /// `mod` is intentionally LEFT UNCHANGED (D comment "leave mod unchanged").
  nullAttributes(): Type {
    const t = this.copy();
    // t.mod = NULL;  // leave mod unchanged (faithful: D keeps the source mod)
    t.deco = null;
    t.vtinfo = null;
    t.ctype = null;
    t.mcache = null;
    if (t.ty === TY.Tstruct)
      (t as unknown as TypeStruct).att = AliasThisRec.fwdref;
    if (t.ty === TY.Tclass)
      (t as unknown as TypeClass).att = AliasThisRec.fwdref;
    return t;
  }

  // ── TYPE INTERNING / QUALIFIER ACCESSORS ───────────────────────────────────────────────────

  /// dmd/mtype.d:731 — the ClassDeclaration if this is a class handle, else null.
  isClassHandle(): ClassDeclaration | null { return null; }

  /// dmd/mtype.d:739 — !=0 if the type or any subtype is wild.
  hasWild(): number { return this.mod & MODFlagsWild; }

  // dmd/mtype.d:745 — For eliminating dynamic_cast: base returns null, TypeBasic overrides.
  isTypeBasic(): TypeBasic | null { return null; }

  /// dmd/mtype.d:757 — the function type if this is a pointer-to-function, else null. Pure ty-tag +
  /// `next` navigation; the D `cast(TypeFunction)` becomes the `isTypeFunction()` downcast.
  isPtrToFunction(): TypeFunction | null {
    return (this.ty === TY.Tpointer && (this as unknown as TypePointer).next!.ty === TY.Tfunction)
      ? (this as unknown as TypePointer).next as unknown as TypeFunction
      : null;
  }

  /// dmd/mtype.d:769 — the function type if this is a function/delegate/ptr-to-function, else null.
  isFunction_Delegate_PtrToFunction(): TypeFunction | null {
    return this.ty === TY.Tfunction ? (this as unknown as TypeFunction) :
      this.ty === TY.Tdelegate ? ((this as unknown as TypePointer).next as unknown as TypeFunction) :
      (this.ty === TY.Tpointer && (this as unknown as TypePointer).next!.ty === TY.Tfunction)
        ? ((this as unknown as TypePointer).next as unknown as TypeFunction)
        : null;
  }

  // dmd/mtype.d:784-806 — the `isTypeXxx()` downcast family. Each returns `this` cast to the leaf
  // when `ty` matches, else null. Implemented now: the type graph leans on these everywhere (and
  // 13-visitor.md §5 traversal bodies call them). Pure `ty`-tag checks; no algorithm.
  isTypeError(): TypeError | null { return this.ty === TY.Terror ? (this as unknown as TypeError) : null; }
  isTypeVector(): TypeVector | null { return this.ty === TY.Tvector ? (this as unknown as TypeVector) : null; }
  isTypeSArray(): TypeSArray | null { return this.ty === TY.Tsarray ? (this as unknown as TypeSArray) : null; }
  isTypeDArray(): TypeDArray | null { return this.ty === TY.Tarray ? (this as unknown as TypeDArray) : null; }
  isTypeAArray(): TypeAArray | null { return this.ty === TY.Taarray ? (this as unknown as TypeAArray) : null; }
  isTypePointer(): TypePointer | null { return this.ty === TY.Tpointer ? (this as unknown as TypePointer) : null; }
  isTypeReference(): TypeReference | null {
    return this.ty === TY.Treference ? (this as unknown as TypeReference) : null;
  }
  isTypeFunction(): TypeFunction | null {
    return this.ty === TY.Tfunction ? (this as unknown as TypeFunction) : null;
  }
  isTypeDelegate(): TypeDelegate | null {
    return this.ty === TY.Tdelegate ? (this as unknown as TypeDelegate) : null;
  }
  isTypeIdentifier(): TypeIdentifier | null {
    return this.ty === TY.Tident ? (this as unknown as TypeIdentifier) : null;
  }
  isTypeInstance(): TypeInstance | null {
    return this.ty === TY.Tinstance ? (this as unknown as TypeInstance) : null;
  }
  isTypeTypeof(): TypeTypeof | null { return this.ty === TY.Ttypeof ? (this as unknown as TypeTypeof) : null; }
  isTypeReturn(): TypeReturn | null { return this.ty === TY.Treturn ? (this as unknown as TypeReturn) : null; }
  isTypeStruct(): TypeStruct | null { return this.ty === TY.Tstruct ? (this as unknown as TypeStruct) : null; }
  isTypeEnum(): TypeEnum | null { return this.ty === TY.Tenum ? (this as unknown as TypeEnum) : null; }
  isTypeClass(): TypeClass | null { return this.ty === TY.Tclass ? (this as unknown as TypeClass) : null; }
  isTypeTuple(): TypeTuple | null { return this.ty === TY.Ttuple ? (this as unknown as TypeTuple) : null; }
  isTypeSlice(): TypeSlice | null { return this.ty === TY.Tslice ? (this as unknown as TypeSlice) : null; }
  isTypeNull(): TypeNull | null { return this.ty === TY.Tnull ? (this as unknown as TypeNull) : null; }
  isTypeMixin(): TypeMixin | null { return this.ty === TY.Tmixin ? (this as unknown as TypeMixin) : null; }
  isTypeTraits(): TypeTraits | null { return this.ty === TY.Ttraits ? (this as unknown as TypeTraits) : null; }
  isTypeNoreturn(): TypeNoreturn | null {
    return this.ty === TY.Tnoreturn ? (this as unknown as TypeNoreturn) : null;
  }
  isTypeTag(): TypeTag | null { return this.ty === TY.Ttag ? (this as unknown as TypeTag) : null; }

  /// dmd/mtype.d:808 — true if static or dynamic array.
  isStaticOrDynamicArray(): boolean { return this.ty === TY.Tarray || this.ty === TY.Tsarray; }

  // dmd/mtype.d:811 — 13-visitor.md §2: dispatch to this node's own named method. Overrides
  // ASTNode.accept (abstract).
  override accept(v: Visitor): void { v.visitType(this); }

  /// dmd/mtype.d:816 — `this` as a TypeFunction (asserts if not Tfunction).
  toTypeFunction(): TypeFunction {
    if (this.ty !== TY.Tfunction)
      assertUnreachable();
    return this as unknown as TypeFunction;
  }

  /// dmd/mtype.d:823 — `static Types* arraySyntaxCopy(Types* types)`. Deep node copy of an
  /// `Array!Type`, storing null for a null slot (`(*a)[i] = t ? t.syntaxCopy() : null`).
  /// A null `types` yields a null result (D allocates nothing). `Types = Array<Type | null>`
  /// (08 §3) represents the null store directly, so the D body ports 1:1.
  static arraySyntaxCopy(types: Types | null): Types | null {
    let a: Types | null = null;
    if (types) {
      a = new Array_<Type | null>(types.length); // mtype.d:828
      for (let i = 0; i < types.length; i++) {
        // mtype.d:831 — `(*a)[i] = t ? t.syntaxCopy() : null;` (06 §2.7 truthiness made explicit).
        const t = types.opIndex(i);
        a.opIndexAssign(t !== null ? t.syntaxCopy() : null, i);
      }
    }
    return a;
  }
}

// dmd/mtype.d:397 — `static struct Mcache` nested in Type. A VALUE-type struct (02 §2) of cached
// lazily-evaluated qualified variants. Hoisted to module scope (TS has no nested struct decl).
// All fields are `Type` references (nullable). `copy()` is a shallow field clone (03 §2).
export class Mcache {
  cto: Type | null = null;   // MODFlags.const_
  ito: Type | null = null;   // MODFlags.immutable_
  sto: Type | null = null;   // MODFlags.shared_
  scto: Type | null = null;  // MODFlags.shared_ | MODFlags.const_
  wto: Type | null = null;   // MODFlags.wild
  wcto: Type | null = null;  // MODFlags.wildconst
  swto: Type | null = null;  // MODFlags.shared_ | MODFlags.wild
  swcto: Type | null = null; // MODFlags.shared_ | MODFlags.wildconst
  pto: Type | null = null;   // merged pointer to this type
  rto: Type | null = null;   // reference to this type
  arrayof: Type | null = null; // array of this type
  // ImportC: store the name of the typedef resolving to this type.
  typedefIdent: Identifier | null = null;

  copy(): Mcache {
    const c = new Mcache();
    c.cto = this.cto; c.ito = this.ito; c.sto = this.sto; c.scto = this.scto;
    c.wto = this.wto; c.wcto = this.wcto; c.swto = this.swto; c.swcto = this.swcto;
    c.pto = this.pto; c.rto = this.rto; c.arrayof = this.arrayof;
    c.typedefIdent = this.typedefIdent;
    return c;
  }
}

// dmd/mtype.d:840 — `extern (C++) final class TypeError : Type`.
export class TypeError extends Type {
  constructor() {
    super(TY.Terror);
  }

  override kind(): string { return "error"; }

  override syntaxCopy(): TypeError {
    // No semantic analysis done, no need to copy.
    return this;
  }

  override accept(v: Visitor): void { v.visitTypeError(this); }
}

// dmd/mtype.d:866 — `extern (C++) abstract class TypeNext : Type`. Adds `next` (the element/return
// type) and overrides the makeXxx/deduceWild family to thread modifiers transitively into `next`.
export abstract class TypeNext extends Type {
  next: Type | null;

  constructor(ty: TY, next: Type | null) {
    super(ty);
    this.next = next;
  }

  /// dmd/mtype.d:876 — !=0 if this type or any subtype is wild. Function has no wild; delegate
  /// threads `wild` through `next`. `Type.hasWild()` is the base (mod-bit) version.
  ///
  /// NUMERIC DOMAIN (09 §9): mtype.d:882 is `return mod & MODFlags.wild || (next && next.hasWild());`
  /// — a D `||` expression, whose result is `bool`, implicitly converted to this `int` return. So D
  /// yields 0 or 1 here, NOT the raw mask (the base `Type.hasWild`, mtype.d:741, genuinely does
  /// return the mask — the two overrides really do differ, and the port must not flatten that).
  /// JS `||` returns the left operand's VALUE, so the expression is narrowed to bool then to 0/1.
  override hasWild(): number {
    if (this.ty === TY.Tfunction)
      return 0;
    if (this.ty === TY.Tdelegate)
      return super.hasWild();
    return ((this.mod & MODFlags.wild) !== 0 || (this.next !== null && this.next.hasWild() !== 0)) ? 1 : 0;
  }

  override accept(v: Visitor): void { v.visitTypeNext(this); }
}

// dmd/mtype.d:893 — `extern (C++) final class TypeBasic : Type`. void/bool/int/float/char/... .
export class TypeBasic extends Type {
  // `const(char)* dstring` — the token spelling. NON-NULL: the ctor either assigns it or hits
  // D's `assert(0)` (mtype.d:1025), so `kind()` can return it bare, exactly as D does
  // (mtype.d:1033 `return dstring;`) — no `?? ""` fallback on a path D cannot take.
  dstring!: string;
  flags = 0;                      // TFlags bit set (integral/unsigned/floating/...)

  // dmd/mtype.d:898 — `this(TY ty)`. Sets the token spelling (`dstring`) and the TFlags bit set,
  // per the per-ty switch. `dstring` is modeled as a JS `string` (the debug-name role, matching the
  // `kind()`-returns-`string` convention in this file): each `d = Token.toChars(TOK.xxx)` is the
  // ASCII token spelling, so we assign the literal directly (byte-identical to `tokens.ts`'s tochars
  // table). The D ctor ENDS at `this.dstring = d; this.flags = flags;` (mtype.d:1027-1028) — it does
  // NOT merge. The interning of a basic type is `Type_init`'s job (typesem.d:1281-1282, carried into
  // `Type._init` below); a `merge()` here would give `new TypeBasic(...)` a global side effect D's
  // ctor does not have, and would make constructing one before `Type.stringtable` exists throw from
  // a constructor where D happily builds the object.
  constructor(ty: TY) {
    super(ty);
    let d: string;
    let flags = 0;
    switch (ty) {
      case TY.Tvoid:
        d = "void"; // Token.toChars(TOK.void_)
        break;
      case TY.Tint8:
        d = "byte"; // Token.toChars(TOK.int8)
        flags |= TFlags.integral;
        break;
      case TY.Tuns8:
        d = "ubyte"; // Token.toChars(TOK.uns8)
        flags |= TFlags.integral | TFlags.unsigned;
        break;
      case TY.Tint16:
        d = "short"; // Token.toChars(TOK.int16)
        flags |= TFlags.integral;
        break;
      case TY.Tuns16:
        d = "ushort"; // Token.toChars(TOK.uns16)
        flags |= TFlags.integral | TFlags.unsigned;
        break;
      case TY.Tint32:
        d = "int"; // Token.toChars(TOK.int32)
        flags |= TFlags.integral;
        break;
      case TY.Tuns32:
        d = "uint"; // Token.toChars(TOK.uns32)
        flags |= TFlags.integral | TFlags.unsigned;
        break;
      case TY.Tfloat32:
        d = "float"; // Token.toChars(TOK.float32)
        flags |= TFlags.floating | TFlags.real_;
        break;
      case TY.Tint64:
        d = "long"; // Token.toChars(TOK.int64)
        flags |= TFlags.integral;
        break;
      case TY.Tuns64:
        d = "ulong"; // Token.toChars(TOK.uns64)
        flags |= TFlags.integral | TFlags.unsigned;
        break;
      case TY.Tint128:
        d = "cent"; // Token.toChars(TOK.int128)
        flags |= TFlags.integral;
        break;
      case TY.Tuns128:
        d = "ucent"; // Token.toChars(TOK.uns128)
        flags |= TFlags.integral | TFlags.unsigned;
        break;
      case TY.Tfloat64:
        d = "double"; // Token.toChars(TOK.float64)
        flags |= TFlags.floating | TFlags.real_;
        break;
      case TY.Tfloat80:
        d = "real"; // Token.toChars(TOK.float80)
        flags |= TFlags.floating | TFlags.real_;
        break;
      case TY.Timaginary32:
        d = "ifloat"; // Token.toChars(TOK.imaginary32)
        flags |= TFlags.floating | TFlags.imaginary;
        break;
      case TY.Timaginary64:
        d = "idouble"; // Token.toChars(TOK.imaginary64)
        flags |= TFlags.floating | TFlags.imaginary;
        break;
      case TY.Timaginary80:
        d = "ireal"; // Token.toChars(TOK.imaginary80)
        flags |= TFlags.floating | TFlags.imaginary;
        break;
      case TY.Tcomplex32:
        d = "cfloat"; // Token.toChars(TOK.complex32)
        flags |= TFlags.floating | TFlags.complex;
        break;
      case TY.Tcomplex64:
        d = "cdouble"; // Token.toChars(TOK.complex64)
        flags |= TFlags.floating | TFlags.complex;
        break;
      case TY.Tcomplex80:
        d = "creal"; // Token.toChars(TOK.complex80)
        flags |= TFlags.floating | TFlags.complex;
        break;
      case TY.Tbool:
        d = "bool"; // dmd/mtype.d:1005 — literal "bool"
        flags |= TFlags.integral | TFlags.unsigned;
        break;
      case TY.Tchar:
        d = "char"; // Token.toChars(TOK.char_)
        flags |= TFlags.integral | TFlags.unsigned;
        break;
      case TY.Twchar:
        d = "wchar"; // Token.toChars(TOK.wchar_)
        flags |= TFlags.integral | TFlags.unsigned;
        break;
      case TY.Tdchar:
        d = "dchar"; // Token.toChars(TOK.dchar_)
        flags |= TFlags.integral | TFlags.unsigned;
        break;
      default:
        return assertUnreachable(); // dmd/mtype.d:1025 — `assert(0)`
    }
    this.dstring = d;   // dmd/mtype.d:1027
    this.flags = flags; // dmd/mtype.d:1028 — last statement of the D ctor
  }

  override kind(): string { return this.dstring; } // dmd/mtype.d:1031

  override syntaxCopy(): TypeBasic {
    // No semantic analysis done on basic types, no need to copy.
    return this;
  }

  // dmd/mtype.d:1043 — For eliminating dynamic_cast: a TypeBasic is its own isTypeBasic().
  override isTypeBasic(): TypeBasic { return this; }

  override accept(v: Visitor): void { v.visitTypeBasic(this); }
}

// dmd/mtype.d:1060 — `extern (C++) final class TypeVector : Type`. SIMD vector over a basetype.
export class TypeVector extends Type {
  basetype: Type;

  constructor(basetype: Type) {
    super(TY.Tvector);
    this.basetype = basetype;
  }

  static create(basetype: Type): TypeVector { return new TypeVector(basetype); }

  override kind(): string { return "vector"; }
  override syntaxCopy(): TypeVector { return new TypeVector(this.basetype.syntaxCopy()); }

  /// dmd/mtype.d:1085 — element TypeBasic of the underlying static-array basetype.
  elementType(): TypeBasic {
    assert(this.basetype.ty === TY.Tsarray);
    const t = this.basetype as unknown as TypeSArray;
    const tb = t.next!.isTypeBasic();
    assert(tb !== null);
    return tb;
  }

  override accept(v: Visitor): void { v.visitTypeVector(this); }
}

// dmd/mtype.d:1102 — `extern (C++) abstract class TypeArray : TypeNext`. Base of S/D arrays.
export abstract class TypeArray extends TypeNext {
  constructor(ty: TY, next: Type | null) {
    super(ty, next);
  }

  override accept(v: Visitor): void { v.visitTypeArray(this); }
}

// dmd/mtype.d:1118 — `extern (C++) final class TypeSArray : TypeArray`. Static array (fixed dim).
export class TypeSArray extends TypeArray {
  dim: Expression | null;

  // dmd/mtype.d:1122 `this(Type t, Expression dim)` + :1129 `this(Type t)` (incomplete type, dim
  // defaults to `new IntegerExp(0)`). The two D ctors are ARITY-distinct prefixes, so 04 §1 Form A
  // collapses them into one TS ctor with an optional trailing `dim`.
  //
  // The absence marker is `undefined` ONLY — the parameter is `Expression | null` because every
  // holder of a dim in this tree is `Expression | null` (`TypeSArray.dim`, mtype.d:1120), and D's
  // 2-arg ctor accepts a null `dim` without rewriting it. Testing `dim !== undefined` (not `??`)
  // keeps an EXPLICIT null on the 2-arg path: `?? new IntegerExp(0)` would silently reroute it to
  // the incomplete-array form, a transition D's two-ctor set cannot make.
  constructor(t: Type | null, dim?: Expression | null) {
    super(TY.Tsarray, t);
    // dmd/mtype.d:1133 — `this.dim = new IntegerExp(0);` (the incomplete-type ctor). `0` is a
    // `dinteger_t` (ulong -> bigint); `IntegerExp.fromValue` is the TS name of D's value-only
    // `IntegerExp` ctor (expression.d:536, promoted to a factory per 04 §1.1(c)).
    this.dim = dim !== undefined ? dim : IntegerExp.fromValue(0n);
  }

  override kind(): string { return "sarray"; }

  // dmd/mtype.d:1141 — deep node copy: clone `next` and `dim`, carry `mod` (a number, value-copied).
  override syntaxCopy(): TypeSArray {
    const t = this.next!.syntaxCopy();
    const e = this.dim!.syntaxCopy();
    const result = new TypeSArray(t, e);
    result.mod = this.mod;
    return result;
  }

  /// dmd/mtype.d:1154 — C11 incomplete array type (dim is an integer literal == 0).
  isIncomplete(): boolean {
    const ie = this.dim!.isIntegerExp();
    return ie !== null && ie.getInteger() === 0n;
  }

  override accept(v: Visitor): void { v.visitTypeSArray(this); }
}

// dmd/mtype.d:1168 — `extern (C++) final class TypeDArray : TypeArray`. Dynamic array (T[]).
export class TypeDArray extends TypeArray {
  constructor(t: Type | null) {
    super(TY.Tarray, t);
  }

  override kind(): string { return "darray"; }

  // dmd/mtype.d:1181 — deep node copy; identity short-circuit when `next` syntaxCopy is itself.
  override syntaxCopy(): TypeDArray {
    const t = this.next!.syntaxCopy();
    if (t === this.next)
      return this;
    const result = new TypeDArray(t);
    result.mod = this.mod;
    return result;
  }

  override accept(v: Visitor): void { v.visitTypeDArray(this); }
}

// dmd/mtype.d:1200 — `extern (C++) final class TypeAArray : TypeArray`. Associative array (V[K]).
export class TypeAArray extends TypeArray {
  index: Type | null; // key type
  loc: Loc = Loc.initial;

  constructor(t: Type | null, index: Type | null) {
    super(TY.Taarray, t);
    this.index = index;
  }

  static create(t: Type | null, index: Type | null): TypeAArray { return new TypeAArray(t, index); }

  override kind(): string { return "aarray"; }

  // dmd/mtype.d:1221 — deep node copy of element + key types; identity short-circuit if both unchanged.
  override syntaxCopy(): TypeAArray {
    const t = this.next!.syntaxCopy();
    const ti = this.index!.syntaxCopy();
    if (t === this.next && ti === this.index)
      return this;
    const result = new TypeAArray(t, ti);
    result.mod = this.mod;
    return result;
  }

  override accept(v: Visitor): void { v.visitTypeAArray(this); }
}

// dmd/mtype.d:1241 — `extern (C++) final class TypePointer : TypeNext`.
export class TypePointer extends TypeNext {
  constructor(t: Type | null) {
    super(TY.Tpointer, t);
  }

  static create(t: Type | null): TypePointer { return new TypePointer(t); }

  override kind(): string { return "pointer"; }

  // dmd/mtype.d:1258 — deep node copy; identity short-circuit when `next` syntaxCopy is itself.
  override syntaxCopy(): TypePointer {
    const t = this.next!.syntaxCopy();
    if (t === this.next)
      return this;
    const result = new TypePointer(t);
    result.mod = this.mod;
    return result;
  }

  override accept(v: Visitor): void { v.visitTypePointer(this); }
}

// dmd/mtype.d:1277 — `extern (C++) final class TypeReference : TypeNext`.
export class TypeReference extends TypeNext {
  constructor(t: Type | null) {
    super(TY.Treference, t);
  }

  override kind(): string { return "reference"; }

  // dmd/mtype.d:1290 — deep node copy; identity short-circuit when `next` syntaxCopy is itself.
  override syntaxCopy(): TypeReference {
    const t = this.next!.syntaxCopy();
    if (t === this.next)
      return this;
    const result = new TypeReference(t);
    result.mod = this.mod;
    return result;
  }

  override accept(v: Visitor): void { v.visitTypeReference(this); }
}

// dmd/mtype.d:1324 — `extern (C++) final class TypeFunction : TypeNext`. `.next` is the return type.
export class TypeFunction extends TypeNext {
  parameterList: ParameterList; // function parameters (value-struct)

  // dmd/mtype.d:1332-1352 — `private static struct BitFields { bool ...; }` + `mixin(generateBitFields
  // !(BitFields, ushort))`. _config.md: `Has_Bitfields` OFF -> the mixin's shift/mask getter/setter
  // form is used, but the OBSERVABLE interface is `bool` properties. At header stage we carry plain
  // boolean fields with the faithful names; the body phase decides packed-storage vs plain fields.
  isNothrow = false;        /// nothrow
  isNogc = false;           /// is @nogc
  isProperty = false;       /// can be called without parentheses
  isRef = false;            /// returns a reference
  isReturn = false;         /// 'this' is returned by ref
  isScopeQual = false;      /// 'this' is scope
  isReturnInferred = false; /// 'this' is return from inference
  isScopeInferred = false;  /// 'this' is scope from inference
  isLive = false;           /// is @live
  incomplete = false;       /// return type or default arguments removed
  isInOutParam = false;     /// inout on the parameters
  isInOutQual = false;      /// inout on the qualifier
  isCtor = false;           /// the function is a constructor
  isReturnScope = false;    /// `this` is returned by value
  isRvalue = false;         /// returned reference should be treated as rvalue

  linkage: LINK;              // calling convention
  trust: TRUST = TRUST.default_;
  purity: PURE = PURE.impure;
  inuse = 0;                  // `byte inuse`
  inferenceArguments!: ArgumentList; // function args to determine `auto ref` in type semantic (value-struct)

  // dmd/mtype.d:1360 — `this(ParameterList pl, Type treturn, LINK linkage, STC stc = STC.none)`.
  // `.next` (TypeNext) is the return type. The body decodes the storage-class flag set into the
  // BitFields-backed boolean properties, the linkage, the purity, and the trust level. `stc` is the
  // 64-bit STC flag set (`bigint`, 02 §4.2 / 09 §1): each D `stc & STC.xxx` predicate becomes
  // `(stc & STC.xxx) !== 0n`.
  constructor(pl: ParameterList, treturn: Type | null, linkage: LINK, stc: STC = STC.none) {
    super(TY.Tfunction, treturn);
    // dmd/mtype.d:1365 — `assert(VarArg.none <= pl.varargs && pl.varargs <= VarArg.max)`. VarArg is a
    // ≤32-bit enum (number domain); D's `VarArg.max` is the highest member. resolved: VarArg.max ->
    // VarArg.KRvariadic (the last/largest member, value 3).
    assert(VarArg.none <= pl.varargs && pl.varargs <= VarArg.KRvariadic);
    // dmd/mtype.d:1366 — `this.parameterList = pl;`. `ParameterList` is a VALUE struct and `pl` is
    // a BY-VALUE parameter, so in D the field gets its OWN copy of the caller's list; a later
    // `parameterList.parameters = …` on either side is invisible to the other (parse.d:5261/:5283
    // does exactly that). 03 §1 #5 — store into a field whose type is a struct emits `.copy()`.
    this.parameterList = pl.copy();
    this.linkage = linkage;
    // dmd/mtype.d:1358 — `ArgumentList inferenceArguments;` inline value-struct member starts empty.
    // The `!`-declared field is not auto-constructed in JS, so build the empty default here.
    this.inferenceArguments = new ArgumentList();

    if ((stc & STC.pure_) !== 0n)
      this.purity = PURE.fwdref;
    if ((stc & STC.nothrow_) !== 0n)
      this.isNothrow = true;
    if ((stc & STC.nogc) !== 0n)
      this.isNogc = true;
    if ((stc & STC.property) !== 0n)
      this.isProperty = true;
    if ((stc & STC.live) !== 0n)
      this.isLive = true;

    if ((stc & STC.ref_) !== 0n)
      this.isRef = true;
    if ((stc & STC.return_) !== 0n)
      this.isReturn = true;
    if ((stc & STC.returnScope) !== 0n)
      this.isReturnScope = true;
    if ((stc & STC.returninferred) !== 0n)
      this.isReturnInferred = true;
    if ((stc & STC.scope_) !== 0n)
      this.isScopeQual = true;
    if ((stc & STC.scopeinferred) !== 0n)
      this.isScopeInferred = true;
    if ((stc & STC.rvalue) !== 0n)
      this.isRvalue = true;

    this.trust = TRUST.default_;
    if ((stc & STC.safe) !== 0n)
      this.trust = TRUST.safe;
    else if ((stc & STC.system) !== 0n)
      this.trust = TRUST.system;
    else if ((stc & STC.trusted) !== 0n)
      this.trust = TRUST.trusted;
  }

  /// dmd/mtype.d:1404 — factory from raw parameters + varargs byte. Structural: build the
  /// ParameterList value-struct and forward to the ctor. `varargs` is a `ubyte` reinterpreted as
  /// `VarArg` (D `cast(VarArg)varargs`), `stc` a `StorageClass` reinterpreted as `STC`.
  static create(
    parameters: Parameters | null, treturn: Type | null, varargs: number,
    linkage: LINK, stc: STC = STC.none,
  ): TypeFunction {
    // D `ParameterList(parameters, cast(VarArg)varargs)` — stc is NOT threaded into the ParameterList
    // (its `stc` defaults to STC.none); the storage class goes to the TypeFunction ctor only.
    return new TypeFunction(new ParameterList(parameters, varargs as VarArg), treturn, linkage, stc);
  }

  override kind(): string { return "function"; }

  /// dmd/mtype.d:1414 — deep parse-time clone: syntaxCopy the return type and parameter list, then
  /// carry the mod / attribute-flag set / linkage / purity / trust / inferenceArguments. The boolean
  /// attribute flags (BitFields, mtype.d:1332) are copied one-for-one; `inferenceArguments` is a
  /// value-struct (`.copy()` — 03 §2). `linkage` is passed to the ctor; `mod` is set after.
  override syntaxCopy(): TypeFunction {
    const treturn = this.next ? this.next.syntaxCopy() : null;
    const t = new TypeFunction(this.parameterList.syntaxCopy(), treturn, this.linkage);
    t.mod = this.mod;
    t.isNothrow = this.isNothrow;
    t.isNogc = this.isNogc;
    t.isLive = this.isLive;
    t.purity = this.purity;
    t.isProperty = this.isProperty;
    t.isRef = this.isRef;
    t.isReturn = this.isReturn;
    t.isReturnScope = this.isReturnScope;
    t.isScopeQual = this.isScopeQual;
    t.isReturnInferred = this.isReturnInferred;
    t.isScopeInferred = this.isScopeInferred;
    t.isRvalue = this.isRvalue;
    t.isInOutParam = this.isInOutParam;
    t.isInOutQual = this.isInOutQual;
    t.trust = this.trust;
    t.inferenceArguments = this.inferenceArguments.copy();
    t.isCtor = this.isCtor;
    return t;
  }

  /// dmd/mtype.d:1442 — true if there are lazy parameters. `foreach (i, fparam; parameterList)`
  /// iterates via `ParameterList.opApply` (05 §11); D's `return true` out of the loop body is
  /// control code 1 plus the captured flag.
  hasLazyParameters(): boolean {
    let found = false;
    this.parameterList.opApply((_i: number, fparam: Parameter): number => {
      if (fparam.isLazy()) {
        found = true;
        return 1;
      }
      return 0;
    });
    return found;
  }

  /// dmd/mtype.d:1458 — true if `extern(D) U f(T t, ...)` D-style variadic. Pure 2-field read
  /// (`linkage == LINK.d && parameterList.varargs == VarArg.variadic`). Consulted by
  /// `functionParameters` to decide whether to insert the hidden `_arguments[]` first argument.
  isDstyleVariadic(): boolean {
    return this.linkage === LINK.d && this.parameterList.varargs === VarArg.variadic;
  }

  /// dmd/mtype.d:1464 — true if the function type is `isInOutQual` or `isInOutParam`.
  iswild(): boolean { return this.isInOutParam || this.isInOutQual; } // mtype.d:1466

  /// dmd/mtype.d:1470 — whether `this` function type has the same attributes (`@safe`, ...) as
  /// `other`.
  ///
  /// `trustSystemEqualsDefault` (default true) treats `@system` and the unannotated default as the
  /// same trust level; the deprecation note at mtype.d:1472-1479 explains that the false-passing
  /// call sites exist only until the "cannot overload extern(...) function" errors become dead.
  /// `other` is `const scope` — a read-only alias, so no `.copy()` at the call site (03 §3.4).
  attributesEqual(other: TypeFunction, trustSystemEqualsDefault = true): boolean {
    return (this.trust === other.trust ||
            (trustSystemEqualsDefault && this.trust <= TRUST.system && other.trust <= TRUST.system)) &&
            this.purity === other.purity &&
            this.isNothrow === other.isNothrow &&
            this.isNogc === other.isNogc &&
            this.isLive === other.isLive;
  }

  override accept(v: Visitor): void { v.visitTypeFunction(this); }
}

// dmd/mtype.d:1496 — `extern (C++) final class TypeDelegate : TypeNext`. `.next` is a TypeFunction.
export class TypeDelegate extends TypeNext {
  constructor(t: TypeFunction) {
    super(TY.Tfunction, t);
    this.ty = TY.Tdelegate; // dmd/mtype.d:1503 — ctor super's with Tfunction then flips to Tdelegate
  }

  static create(t: TypeFunction): TypeDelegate { return new TypeDelegate(t); }

  override kind(): string { return "delegate"; }

  // dmd/mtype.d:1516 — deep node copy; `next` is a TypeFunction (non-null for a delegate).
  override syntaxCopy(): TypeDelegate {
    const tf = this.next!.syntaxCopy().isTypeFunction()!;
    if ((tf as Type) === this.next)
      return this;
    const result = new TypeDelegate(tf);
    result.mod = this.mod;
    return result;
  }

  override accept(v: Visitor): void { v.visitTypeDelegate(this); }
}

// dmd/mtype.d:1539 — `extern (C++) final class TypeTraits : Type`. Shell around a TraitsExp.
export class TypeTraits extends Type {
  loc: Loc;
  exp: TraitsExp | null;        // expression to resolve as type or symbol
  obj: RootObject | null = null; // cached type/symbol after semantic

  constructor(loc: Loc, exp: TraitsExp | null) {
    super(TY.Ttraits);
    this.loc = loc;
    this.exp = exp;
  }

  override kind(): string { return "traits"; }

  // dmd/mtype.d:1559 — deep node copy: clone the TraitsExp, reuse `loc`, carry `mod`.
  override syntaxCopy(): TypeTraits {
    const te = this.exp!.syntaxCopy();
    const tt = new TypeTraits(this.loc, te);
    tt.mod = this.mod;
    return tt;
  }

  override accept(v: Visitor): void { v.visitTypeTraits(this); }
}

// dmd/mtype.d:1578 — `extern (C++) final class TypeMixin : Type`. mixin(...) type, resolved later.
export class TypeMixin extends Type {
  loc: Loc;
  exps: Expressions | null;
  obj: RootObject | null = null; // cached result of semantic analysis

  constructor(loc: Loc, exps: Expressions | null) {
    super(TY.Tmixin);
    this.loc = loc;
    this.exps = exps;
  }

  override kind(): string { return "mixin"; }

  // dmd/mtype.d:1596 — deep node copy: reuse `loc`, deep-copy the `exps` Array via Expression's
  // static arraySyntaxCopy (filled in expression.ts's body phase).
  override syntaxCopy(): TypeMixin {
    return new TypeMixin(this.loc, Expression.arraySyntaxCopy(this.exps));
  }

  override accept(v: Visitor): void { v.visitTypeMixin(this); }
}

// dmd/mtype.d:1609 — `extern (C++) abstract class TypeQualified : Type`. ident.ident!tiargs.ident...
export abstract class TypeQualified extends Type {
  loc: Loc;
  // array of Identifier and TypeInstance, representing ident.ident!tiargs.ident. ... etc.
  idents!: Objects; // `Objects idents;` (Array!RootObject) — value-struct container

  constructor(ty: TY, loc: Loc) {
    super(ty);
    this.loc = loc;
    // dmd/mtype.d:1615 — `Objects idents;` is a value-struct Array field; default-construct it empty
    // (Objects = Array!RootObject, 08-runtime-lib.md). The allocator (08 §8) is erased.
    this.idents = new Array_<RootObject | null>();
  }

  // dmd/mtype.d:1625 — abstract override so `TypeQualified.syntaxCopy` returns a TypeQualified.
  abstract override syntaxCopy(): TypeQualified;

  /// dmd/mtype.d:1627 — deep-copy the qualifier components (`idents`) from `t` into this. Each
  /// component is one of object/Identifier/expression/dsymbol/type per its `dyncast()`; expression,
  /// TemplateInstance, and Type components are syntax-copied, the rest are carried by reference.
  syntaxCopyHelper(t: TypeQualified): void {
    this.idents.setDim(t.idents.length);
    for (let i = 0; i < this.idents.length; i++) {
      // `idents` slots are `RootObject | null` (08 §3); mtype.d:1634 calls `id.dyncast()` with no
      // null test, so the read into the non-null cursor is `!`.
      let id: RootObject = t.idents.opIndex(i)!;
      switch (id.dyncast()) {
        case DYNCAST.object:
          break;
        case DYNCAST.expression: {
          const e = (id as unknown as Expression).syntaxCopy();
          id = e;
          break;
        }
        case DYNCAST.dsymbol: {
          const ti = (id as unknown as TemplateInstance).syntaxCopy(null);
          id = ti;
          break;
        }
        case DYNCAST.type: {
          const tx = (id as unknown as Type).syntaxCopy();
          id = tx;
          break;
        }
        case DYNCAST.identifier:
        case DYNCAST.tuple:
        case DYNCAST.parameter:
        case DYNCAST.statement:
        case DYNCAST.condition:
        case DYNCAST.templateparameter:
        case DYNCAST.initializer:
          break;
        default:
          // D `with (DYNCAST) final switch` (mtype.d:1634): the 11 DYNCAST members above are the
          // complete set, so an out-of-range tag is unreachable — 06 §3.2 exhaustiveness guard.
          assertUnreachable();
      }
      this.idents.opIndexAssign(id, i);
    }
  }

  /// dmd/mtype.d:1665 — append an identifier component.
  addIdent(ident: Identifier): void { this.idents.push(ident); }
  /// dmd/mtype.d:1670 — append a template-instance component.
  addInst(inst: TemplateInstance): void { this.idents.push(inst); }
  /// dmd/mtype.d:1675 — append an index expression component.
  /// mtype.d:1675-1678 — `void addIndex(RootObject e) { idents.push(e); }`. The body neither
  /// dereferences nor null-tests `e`, and `idents` is `Objects` (`Array<RootObject | null>`), so the
  /// parameter stays nullable (02 §10.1): parse.d:3944 feeds it `dimStack.pop()`, a raw slot.
  addIndex(e: RootObject | null): void { this.idents.push(e); }

  override accept(v: Visitor): void { v.visitTypeQualified(this); }
}

// dmd/mtype.d:1688 — `extern (C++) final class TypeIdentifier : TypeQualified`.
export class TypeIdentifier extends TypeQualified {
  ident: Identifier | null;

  constructor(loc: Loc, ident: Identifier | null) {
    super(TY.Tident, loc);
    this.ident = ident;
  }

  static create(loc: Loc, ident: Identifier | null): TypeIdentifier {
    return new TypeIdentifier(loc, ident);
  }

  override kind(): string { return "identifier"; }

  // dmd/mtype.d:1708 — deep node copy: new node from (loc, ident), copy the qualifier chain, carry mod.
  override syntaxCopy(): TypeIdentifier {
    const t = new TypeIdentifier(this.loc, this.ident);
    t.syntaxCopyHelper(this);
    t.mod = this.mod;
    return t;
  }

  override accept(v: Visitor): void { v.visitTypeIdentifier(this); }
}

// dmd/mtype.d:1725 — `extern (C++) final class TypeInstance : TypeQualified`. Root is a TemplateInstance.
export class TypeInstance extends TypeQualified {
  tempinst: TemplateInstance | null;

  constructor(loc: Loc, tempinst: TemplateInstance | null) {
    super(TY.Tinstance, loc);
    this.tempinst = tempinst;
  }

  override kind(): string { return "instance"; }

  // dmd/mtype.d:1740 — deep node copy: clone the root TemplateInstance, copy the qualifier chain.
  override syntaxCopy(): TypeInstance {
    const t = new TypeInstance(this.loc, this.tempinst!.syntaxCopy(null));
    t.syntaxCopyHelper(this);
    t.mod = this.mod;
    return t;
  }

  override accept(v: Visitor): void { v.visitTypeInstance(this); }
}

// dmd/mtype.d:1757 — `extern (C++) final class TypeTypeof : TypeQualified`. typeof(exp).
export class TypeTypeof extends TypeQualified {
  exp: Expression | null;
  inuse = 0;

  constructor(loc: Loc, exp: Expression | null) {
    super(TY.Ttypeof, loc);
    this.exp = exp;
  }

  override kind(): string { return "typeof"; }

  // dmd/mtype.d:1773 — deep node copy: clone the expression, copy the qualifier chain.
  override syntaxCopy(): TypeTypeof {
    const t = new TypeTypeof(this.loc, this.exp!.syntaxCopy());
    t.syntaxCopyHelper(this);
    t.mod = this.mod;
    return t;
  }

  override accept(v: Visitor): void { v.visitTypeTypeof(this); }
}

// dmd/mtype.d:1790 — `extern (C++) final class TypeReturn : TypeQualified`. typeof(return).
export class TypeReturn extends TypeQualified {
  constructor(loc: Loc) {
    super(TY.Treturn, loc);
  }

  override kind(): string { return "return"; }

  // dmd/mtype.d:1802 — deep node copy: new node from loc, copy the qualifier chain, carry mod.
  override syntaxCopy(): TypeReturn {
    const t = new TypeReturn(this.loc);
    t.syntaxCopyHelper(this);
    t.mod = this.mod;
    return t;
  }

  override accept(v: Visitor): void { v.visitTypeReturn(this); }
}

// dmd/mtype.d:1818 — `extern (C++) final class TypeStruct : Type`.
export class TypeStruct extends Type {
  sym: StructDeclaration | null;
  att: AliasThisRec = AliasThisRec.fwdref;
  inuse = false; // struct currently subject of recursive method call

  constructor(sym: StructDeclaration | null) {
    super(TY.Tstruct);
    this.sym = sym;
  }

  static create(sym: StructDeclaration | null): TypeStruct { return new TypeStruct(sym); }

  override kind(): string { return "struct"; }

  override syntaxCopy(): TypeStruct { return this; }

  override accept(v: Visitor): void { v.visitTypeStruct(this); }
}

// dmd/mtype.d:1853 — `extern (C++) final class TypeEnum : Type`.
export class TypeEnum extends Type {
  sym: EnumDeclaration | null;

  constructor(sym: EnumDeclaration | null) {
    super(TY.Tenum);
    this.sym = sym;
  }

  override kind(): string { return "enum"; }
  override syntaxCopy(): TypeEnum { return this; }

  override accept(v: Visitor): void { v.visitTypeEnum(this); }
}

// dmd/mtype.d:1881 — `extern (C++) final class TypeClass : Type`.
export class TypeClass extends Type {
  sym: ClassDeclaration | null;
  att: AliasThisRec = AliasThisRec.fwdref;
  cppmangle: CPPMANGLE = CPPMANGLE.def;

  constructor(sym: ClassDeclaration | null) {
    super(TY.Tclass);
    this.sym = sym;
  }

  override kind(): string { return "class"; }
  override syntaxCopy(): TypeClass { return this; }
  override isClassHandle(): ClassDeclaration | null { return this.sym; }
  // dmd/mtype.d:1908 — trivial accessor over the resolved ClassDeclaration's `stack` flag.
  override isScopeClass(): boolean { return this.sym!.stack; }

  override accept(v: Visitor): void { v.visitTypeClass(this); }
}

// dmd/mtype.d:1921 — `extern (C++) final class TypeTuple : Type`.
export class TypeTuple extends Type {
  // dmd/mtype.d:1927 — `__gshared TypeTuple empty = new TypeTuple();`, the live arm
  // (`static if (__VERSION__ == 2081)` is a dead host-compiler workaround — resolved away, and with
  // it the `TypeTuple.empty = new TypeTuple();` line typesem.d:1341 puts inside `Type._init`).
  // The eager form is Rule 4.5-safe here even though it is a top-level `new`: everything the
  // no-arg ctor touches — `Type` (declared above in this module), `TY` (astenums, a leaf) and
  // `Array` (root/array, a runtime-lib module outside the core SCC) — is evaluated by the time
  // this class body runs, so nothing is read across the cycle.
  static empty: TypeTuple = new TypeTuple();

  arguments: Parameters | null = null; // types making up the tuple

  // dmd/mtype.d:1931-2015 — D has 5 ctors. Two of them are ARITY-distinct prefixes and collapse
  // into this one constructor (04 §1 Form A): `this(Parameters*)` (mtype.d:1931) carries the
  // pointer verbatim, null included; `this()` (mtype.d:1983) sets `arguments = new Parameters()`.
  // The absence marker is `undefined` ONLY, so `new TypeTuple(null)` still reaches the D
  // `this(Parameters*)` behaviour rather than being rerouted to the empty-tuple form.
  //
  // The other three — `this(Expressions*)` (:1954), `this(Type)` (:1989), `this(Type, Type)`
  // (:1995) — are SAME-ARITY, different-type ctors, so 04 §1.1(c) promotes them to named static
  // factories (`fromExpressions` / `fromType` / `fromTypes`). D resolved every call site
  // statically; nothing tests a runtime type here (04 §1.1(c): `instanceof` also mis-routes
  // `null`, which satisfies the static type of two of the three D forms).
  //
  // The D `debug` per-element `assert(arg && arg.type)` (mtype.d:1937-1947) is a debug-only
  // invariant check, not emitted under release — faithful to D's `debug{}` block.
  constructor(arguments_?: Parameters | null) {
    super(TY.Ttuple);
    this.arguments = arguments_ !== undefined ? arguments_ : new Array_<Parameter | null>();
  }

  /// dmd/mtype.d:1954 — `this(Expressions* exps)`: form a TypeTuple from the TYPES of the
  /// expressions. Assumes `exps[]` is already tuple-expanded (asserted per element).
  /// Form-B ctor promoted to a named factory (04 §1.1(c)).
  static fromExpressions(exps: Expressions | null): TypeTuple {
    // A TS static cannot call `super`, so route through the primary ctor with an explicit null and
    // then assign — the observable result is D's `super(Ttuple); this.arguments = …;`.
    const t = new TypeTuple(null);
    if (!exps) { // mtype.d:1957-1961
      t.arguments = new Array_<Parameter | null>(0);
      return t;
    }
    const args = new Array_<Parameter | null>(exps.length);
    for (let i = 0; i < exps.length; i++) {
      // slot `Expression | null` (08 §3); mtype.d:1966-1968 reads `e.type`/`e.loc` with no null test.
      const e = exps.opIndex(i)!;
      assert(e.type!.ty !== TY.Ttuple);
      const arg = new Parameter(e.loc, STC.none, e.type, null, null, null);
      args.opIndexAssign(arg, i);
    }
    t.arguments = args;
    return t;
  }

  /// dmd/mtype.d:1989 — `this(Type t1)`: a one-element type sequence.
  static fromType(t1: Type): TypeTuple {
    const args = new Array_<Parameter | null>();
    args.push(new Parameter(Loc.initial, STC.none, t1, null, null, null));
    return new TypeTuple(args);
  }

  /// dmd/mtype.d:1995 — `this(Type t1, Type t2)`: a two-element type sequence.
  static fromTypes(t1: Type, t2: Type): TypeTuple {
    const args = new Array_<Parameter | null>();
    args.push(new Parameter(Loc.initial, STC.none, t1, null, null, null));
    args.push(new Parameter(Loc.initial, STC.none, t2, null, null, null));
    return new TypeTuple(args);
  }

  // dmd/mtype.d:1975 `create(Parameters*)` + :2002 `create()` — arity-distinct prefixes, collapsed
  // (04 §1A) exactly like the constructor they forward to.
  static create(arguments_?: Parameters | null): TypeTuple {
    return arguments_ !== undefined ? new TypeTuple(arguments_) : new TypeTuple();
  }

  // dmd/mtype.d:2007 `create(Type t1)` / :2012 `create(Type t1, Type t2)` — same arity as
  // `create(Parameters*)`, different type -> Form-B rename (04 §1B); call sites use the renamed
  // target D picked for them.
  static createFromType(t1: Type): TypeTuple { return TypeTuple.fromType(t1); }
  static createFromTypes(t1: Type, t2: Type): TypeTuple { return TypeTuple.fromTypes(t1, t2); }

  override kind(): string { return "sequence"; }

  // dmd/mtype.d:2022 — deep node copy: deep-copy the parameter array, carry `mod`.
  override syntaxCopy(): TypeTuple {
    const args = Parameter.arraySyntaxCopy(this.arguments);
    const t = new TypeTuple(args);
    t.mod = this.mod;
    return t;
  }

  override accept(v: Visitor): void { v.visitTypeTuple(this); }
}

// dmd/mtype.d:2039 — `extern (C++) final class TypeSlice : TypeNext`. To slice a TypeTuple.
export class TypeSlice extends TypeNext {
  lwr: Expression | null;
  upr: Expression | null;

  constructor(next: Type | null, lwr: Expression | null, upr: Expression | null) {
    super(TY.Tslice, next);
    this.lwr = lwr;
    this.upr = upr;
  }

  override kind(): string { return "slice"; }

  // dmd/mtype.d:2057 — deep node copy: clone `next`, `lwr`, `upr`; carry `mod`.
  override syntaxCopy(): TypeSlice {
    const t = new TypeSlice(this.next!.syntaxCopy(), this.lwr!.syntaxCopy(), this.upr!.syntaxCopy());
    t.mod = this.mod;
    return t;
  }

  override accept(v: Visitor): void { v.visitTypeSlice(this); }
}

// dmd/mtype.d:2072 — `extern (C++) final class TypeNull : Type`. typeof(null).
export class TypeNull extends Type {
  constructor() {
    super(TY.Tnull);
  }

  override kind(): string { return "null"; }
  override syntaxCopy(): TypeNull { return this; }

  override accept(v: Visitor): void { v.visitTypeNull(this); }
}

// dmd/mtype.d:2099 — `extern (C++) final class TypeNoreturn : Type`. The bottom type typeof(*null).
export class TypeNoreturn extends Type {
  constructor() {
    super(TY.Tnoreturn);
  }

  override kind(): string { return "noreturn"; }
  override syntaxCopy(): TypeNoreturn { return this; }

  override accept(v: Visitor): void { v.visitTypeNoreturn(this); }
}

// dmd/mtype.d:2132 — `extern (C++) final class TypeTag : Type`. C struct/union/enum tag, deferred.
export class TypeTag extends Type {
  loc: Loc;            // location of declaration
  tok: number;                // `TOK tok` -> TOK.struct_/union_/enum_ (number domain)
  packalign!: structalign_t;  // alignment of struct/union fields (value-struct)
  alignExps: Expressions | null; // alignment of struct itself
  id: Identifier | null;      // tag name identifier
  base: Type | null;          // base type for enums otherwise null
  members: Dsymbols | null;   // members of struct, null if none

  resolved: Type | null = null; // type after semantic()
  // dmd/mtype.d:2145 — `MOD mod;` "modifiers to apply after type is resolved (only MODFlags.const_)".
  // shadow-split: D redeclares Type.mod; this is the DERIVED slot (02 §11.5b registry).
  // D keeps two slots, chosen by the STATIC type of the reference: an access through a TypeTag-typed
  // reference reads and writes this one (the ctor below, toConst at cparse.d:4943, visitTag at
  // hdrgen.d:4504-4524), while every Type-level access (isConst, merge, visitWithMask, ...) reads
  // Type.mod (mtype.d:394), which stays 0 for a parsed C tag. One JS property cannot hold both: merged,
  // `const struct S * const cp;` made the pointer const (toConst's isConst on the pointee saw `const`)
  // where ldc2 keeps it mutable, and the header printed `const(const(S))`. Type.copy carries both slots.
  modTag: MOD = 0;

  constructor(
    loc: Loc, tok: number, id: Identifier | null, packalign: structalign_t,
    alignExps: Expressions | null, base: Type | null, members: Dsymbols | null,
  ) {
    super(TY.Ttag);
    this.loc = loc;
    this.tok = tok;
    this.id = id;
    this.packalign = packalign;
    this.alignExps = alignExps;
    this.base = base;
    this.members = members;
    this.modTag = 0; // dmd/mtype.d:2158 — `this.mod = 0;` names TypeTag's own slot
  }

  override kind(): string { return "tag"; }
  override syntaxCopy(): TypeTag { return this; }

  override accept(v: Visitor): void { v.visitTypeTag(this); }
}

// dmd/mtype.d:2184 — `extern (C++) struct ParameterList`. A VALUE-type struct (02 §2): function
// formal parameters + variadic info. Backed by a TS class with `.copy()` (03 §2). Iteration in D
// is via `opApply` over the expanded (tuple-flattened) params — those become explicit iteration
// helpers in the body phase (no TS for-of magic).
export class ParameterList {
  parameters: Parameters | null;          // raw (unexpanded) formal params, may contain tuples
  stc: STC;                               // storage class of ...
  varargs: VarArg = VarArg.none;
  hasIdentifierList = false;              // true if C identifier-list style

  constructor(parameters: Parameters | null, varargs: VarArg = VarArg.none, stc: STC = STC.none) {
    this.parameters = parameters;
    this.varargs = varargs;
    this.stc = stc;
  }

  /// dmd/mtype.d:2200 — number of expanded parameters. O(N). Thin forward to the tuple-folding
  /// `Parameter.dim`, which drives `Parameter._foreach`.
  length(): number { return Parameter.dim(this.parameters); }

  /// dmd/mtype.d:2207 — expanded parameter at index i, or null. O(i). Thin forward to `Parameter.getNth`.
  opIndex(i: number): Parameter | null { return Parameter.getNth(this.parameters, i); }

  /// dmd/mtype.d:2215 — `int opApply(scope Parameter.ForeachDg dg)`. Iterate the expanded
  /// parameters. Prefer this to `length` + N × `opIndex` (O(N) instead of O(N + N²/2)).
  ///
  /// 05 §11: an `opApply` is emitted as `opApply(dg): number` with D's control-code protocol —
  /// the callback returns 0 to continue and non-zero to stop, and that value is the result. Every
  /// D `foreach (i, p; parameterList)` becomes `parameterList.opApply((i, p) => { …; return 0; })`.
  opApply(dg: ParameterForeachDg): number {
    return Parameter._foreach(this.parameters, dg);
  }

  /// dmd/mtype.d:2222 — `int opApply(scope Parameter.SemanticForeachDg dg)`. Same iteration, but the
  /// callback also receives the ORIGINAL (unexpanded) parameter and its index, for semantic
  /// processing. Same-arity/different-delegate-type Form-B sibling of `opApply` (04 §1B), renamed;
  /// D `foreach (oidx, oparam, eidx, eparam; this)` becomes `this.opApplySemantic(...)`.
  opApplySemantic(dg: ParameterSemanticForeachDg): number {
    return Parameter._foreachSemantic(this.parameters, dg);
  }

  /// dmd/mtype.d:2227 — clone (parameters deep-copied, varargs carried; stc defaults). Returns a fresh
  /// value-struct `ParameterList` (03 §1 #3 — caller receives a new value).
  syntaxCopy(): ParameterList {
    return new ParameterList(Parameter.arraySyntaxCopy(this.parameters), this.varargs);
  }

  /// dmd/mtype.d:2233 — `bool opEquals(scope ref ParameterList other) const`. Structural equality,
  /// expanding tuples. `ref` parameter = alias, so no `.copy()` at the call site (03 §3.2).
  ///
  /// `!parameters != !other.parameters` is a pointer-truthiness comparison ("exactly one is null").
  /// `p1 != p2` on two `Parameter`s uses `Parameter.opEquals` (mtype.d:2581) -> `!p1.opEquals(p2)`
  /// (05 §2). D's `break` out of the `foreach`-over-`opApply` is control code 1 (05 §11 / 06 §1.8).
  opEquals(other: ParameterList): boolean {
    if (this.stc !== other.stc || this.varargs !== other.varargs
        || ((this.parameters === null) !== (other.parameters === null)))
      return false;

    if (this.parameters === other.parameters)
      return true;

    let idx = 0;
    let diff = false;

    // Pairwise compare each parameter
    // Can this avoid the O(n) indexing for the second list?
    this.opApply((_n: number, p1: Parameter): number => {
      const p2 = other.opIndex(idx++);
      if (!p2 || !p1.opEquals(p2)) {
        diff = true;
        return 1; // D `break`
      }
      return 0;
    });

    // Ensure no remaining parameters in `other`
    return !diff && other.opIndex(idx) === null;
  }

  /// dmd/mtype.d:2261 — true if any parameter has a default argument.
  hasDefaultArgs(): boolean {
    let found = false;
    this.opApplySemantic((_oidx, _oparam, _eidx, eparam): number => {
      if (eparam.defaultArg !== null) { // 06 §2.7 — nullable-reference truthiness made explicit
        found = true;
        return 1; // D `return true` out of the foreach body
      }
      return 0;
    });
    return found;
  }

  /// dmd/mtype.d:2272 — true if any parameter does NOT have a default argument.
  hasArgsWithoutDefault(): boolean {
    let found = false;
    this.opApplySemantic((_oidx, _oparam, _eidx, eparam): number => {
      if (eparam.defaultArg === null) {
        found = true;
        return 1; // D `return true` out of the foreach body
      }
      return 0;
    });
    return found;
  }

  /// Value-struct copy (03 §2): primitive/enum fields by value; `parameters` is a slice field
  /// shared by reference (02 §8); `stc`/`varargs` are scalars.
  copy(): ParameterList {
    const c = new ParameterList(this.parameters, this.varargs, this.stc);
    c.hasIdentifierList = this.hasIdentifierList;
    return c;
  }
}

// dmd/mtype.d:2286 — `extern (C++) final class Parameter : ASTNode`. A function formal parameter.
export class Parameter extends ASTNode {
  loc: Loc;
  storageClass: STC;
  type: Type | null;
  ident: Identifier | null;
  defaultArg: Expression | null;
  userAttribDecl: UserAttributeDeclaration | null; // user defined attributes

  constructor(
    loc: Loc, storageClass: STC, type: Type | null, ident: Identifier | null,
    defaultArg: Expression | null, userAttribDecl: UserAttributeDeclaration | null,
  ) {
    super();
    this.loc = loc;
    this.type = type;
    this.ident = ident;
    this.storageClass = storageClass;
    this.defaultArg = defaultArg;
    this.userAttribDecl = userAttribDecl;
  }

  /// dmd/mtype.d:2307 — factory. D's `StorageClass storageClass` parameter is reinterpreted to
  /// `STC` by `cast(STC)`; both are the same 64-bit flag carrier in the port (02 §4.2), so the
  /// cast erases and the body is D's one-line forward to the constructor.
  static create(
    loc: Loc, storageClass: STC, type: Type | null, ident: Identifier | null,
    defaultArg: Expression | null, userAttribDecl: UserAttributeDeclaration | null,
  ): Parameter {
    return new Parameter(loc, storageClass, type, ident, defaultArg, userAttribDecl);
  }

  /// dmd/mtype.d:2312 — clone: deep-copy type/defaultArg/userAttribDecl (each null-guarded), carry
  /// loc/ident/storageClass by reference/value.
  syntaxCopy(): Parameter {
    return new Parameter(
      this.loc, this.storageClass,
      this.type ? this.type.syntaxCopy() : null,
      this.ident,
      this.defaultArg ? this.defaultArg.syntaxCopy() : null,
      this.userAttribDecl ? this.userAttribDecl.syntaxCopy(null) : null,
    );
  }

  /// dmd/mtype.d:2318 — whether this parameter is lazy. Pure STC bit test (branded bigint, `!== 0n`).
  isLazy(): boolean { return (this.storageClass & STC.lazy_) !== 0n; }
  /// dmd/mtype.d:2324 — whether this parameter is a reference (out / ref). Pure STC bit test.
  isReference(): boolean { return (this.storageClass & (STC.ref_ | STC.out_)) !== 0n; }

  // dmd/mtype.d:2330 — kludge for template.isType(): a Parameter dyncasts to DYNCAST.parameter.
  override dyncast(): DYNCAST { return DYNCAST.parameter; }

  // dmd/mtype.d:2335 — 13-visitor.md §2: own named method. Overrides ASTNode.accept (abstract).
  override accept(v: Visitor): void { v.visitParameter(this); }

  /// dmd/mtype.d:2340 — deep node copy of a `Parameters` array (per-element syntaxCopy).
  static arraySyntaxCopy(parameters: Parameters | null): Parameters | null {
    let params: Parameters | null = null;
    if (parameters) {
      params = new Array_<Parameter | null>(parameters.length);
      for (let i = 0; i < params.length; i++)
        // slot `Parameter | null` (08 §3); mtype.d:2347 calls through it with no null test -> `!`.
        params.opIndexAssign(parameters.opIndex(i)!.syntaxCopy(), i);
    }
    return params;
  }

  /// dmd/mtype.d:2355 — number of arguments, folding in tuples. Counts via `_foreach` (the
  /// tuple-flattening engine); the `dimDg` callback just increments and continues (0).
  static dim(parameters: Parameters | null): number {
    let nargs = 0;
    const dimDg: ParameterForeachDg = (_n: number, _p: Parameter): number => {
      ++nargs;
      return 0;
    };
    Parameter._foreach(parameters, dimDg);
    return nargs;
  }

  /// dmd/mtype.d:2384 — nth Parameter, folding in tuples, or null if out of bounds. The `getNthParamDg`
  /// callback stops (returns 1) at index `nth`; a non-zero `_foreach` result means it was found.
  static getNth(parameters: Parameters | null, nth: number): Parameter | null {
    let param: Parameter | null = null;
    const getNthParamDg: ParameterForeachDg = (n: number, p: Parameter): number => {
      if (n === nth) {
        param = p;
        return 1;
      }
      return 0;
    };
    const res = Parameter._foreach(parameters, getNthParamDg);
    return res ? param : null;
  }

  /// dmd/mtype.d:2417 — `static int _foreach(Parameters*, scope ForeachDg dg)`. Iterate the
  /// expanded params, passing `(paramidx, param)`; `dg` returns !=0 to stop, and that value is
  /// returned. Thin adapter onto the 4-arity form, exactly as D's body is (mtype.d:2420).
  ///
  /// D's two `_foreach` overloads have the SAME arity and differ only by delegate TYPE, so they are
  /// 04 §1 Form B: this one keeps the bare name (it is what the tree's dependents — typesem.ts:497,
  /// mangle/index.ts:281/448 — already import) and the `SemanticForeachDg` form is renamed
  /// `_foreachSemantic`. The previous `dg.length <= 2` runtime probe is forbidden by 04 §1.1(c)
  /// (D chose statically) and is unsound besides: a caller lambda with a default or rest parameter
  /// reports the wrong arity and would silently pick the wrong protocol.
  static _foreach(parameters: Parameters | null, dg: ParameterForeachDg): number {
    assert(dg !== null); // mtype.d:2419
    // mtype.d:2420 — `_foreach(parameters, (_oidx, _oparam, idx, param) => dg(idx, param));`
    return Parameter._foreachSemantic(parameters, (_oidx, _oparam, idx, param) => dg(idx, param));
  }

  /// dmd/mtype.d:2424 — `static int _foreach(Parameters*, scope SemanticForeachDg dg)`, the Form-B
  /// sibling renamed per the doc-comment above. Expands tuples in depth-first order, pairing each
  /// EXPANDED parameter with the ORIGINAL one it came from.
  ///
  /// The tuple branch (`TypeTuple` element type) is ported faithfully — a parameter whose semantic'd
  /// type is a tuple expands into its element parameters and does NOT itself count toward arity. For
  /// a flat parameter list (`int f(int a)`) no element is a tuple, so the recursion is one level deep.
  static _foreachSemantic(parameters: Parameters | null, dg: ParameterSemanticForeachDg): number {
    assert(dg !== null); // mtype.d:2427
    const sdg = dg;

    if (parameters === null)
      return 0;

    const eidxBox = { value: 0 }; // `ref size_t eidx` — modelled as a mutable box (passed by ref).
    for (let oidx = 0; oidx < parameters.length; oidx++) {
      const oparam = parameters.opIndex(oidx);
      // slot `Parameter | null` (08 §3). mtype.d:2435 passes the SAME value twice, as `oparam` AND
      // as `eparam`, and `_foreachImpl` returns 0 on `eparam is null` (mtype.d:2446-2447) before
      // touching either — so a null slot is a silent skip in D, NOT a fault. No `!` here: the deref
      // lives inside `_foreachImpl`, past the early return.
      const r = Parameter._foreachImpl(sdg, oidx, oparam, eidxBox, /* eparam */ oparam);
      if (r)
        return r;
    }
    return 0;
  }

  /// dmd/mtype.d:2443 — recursive implementation of the iteration: forwards `oidx`/`oparam`, and when
  /// `eparam`'s base type is a `TypeTuple`, recurses over the tuple's element parameters (without
  /// incrementing `eidx`, since an empty/expanded tuple does not count as a parameter for arity).
  /// `eidx` is D's `ref size_t` — modelled here as a `{ value }` box so the recursion shares one
  /// counter, exactly as the `ref` parameter does.
  ///
  /// `oparam` is `Parameter | null` because D's body never dereferences it when it is null: the
  /// only entry point (`_foreach`, mtype.d:2435) passes the SAME slot as `oparam` and `eparam`, and
  /// the `eparam is null` guard below returns 0 first. Past that guard `oparam` is non-null — at the
  /// top call it IS `eparam`, and the tuple recursion forwards it unchanged — hence the single `!`
  /// at the `dg(...)` deref, which is where D's delegates would fault.
  private static _foreachImpl(
    dg: ParameterSemanticForeachDg, oidx: number, oparam: Parameter | null,
    eidx: { value: number }, eparam: Parameter | null,
  ): number {
    if (eparam === null)
      return 0;

    // mtype.d:2449 — `if (auto tu = eparam.type.isTypeTuple())`. The RAW type is tested: no
    // `toBasetype()`. Inserting one would add a semantic-resolution step D does not take on this
    // hot path (`dim`/`getNth`/`ParameterList.length`/`opIndex` all run through here) and, for an
    // enum-typed formal, would route into the still-walled `TypeEnum.toBasetype2`.
    const tu = eparam.type!.isTypeTuple();
    if (tu) {
      // Check for empty tuples
      if (tu.arguments === null)
        return 0;

      for (let nidx = 0; nidx < tu.arguments.length; nidx++) {
        const nextep = tu.arguments.opIndex(nidx);
        const r = Parameter._foreachImpl(dg, oidx, oparam, eidx, nextep);
        if (r)
          return r;
      }
    } else {
      // `oparam!`: non-null past the `eparam === null` guard (see the interface comment above).
      const r = dg(oidx, oparam!, eidx.value, eparam);
      if (r)
        return r;
      // The only place where we should increment eidx is here, as a TypeTuple doesn't count as a
      // parameter (for arity) if it is empty.
      eidx.value++;
    }
    return 0;
  }

  /// dmd/mtype.d:2474 — name for debugging. `override const(char)* toChars()` -> DString (02 §11.2).
  /// The literal arm returns a C string (D returns the literal's `char*`), so the bytes carry the
  /// trailing NUL the C-string view requires (02 §11); `Identifier.toChars()` already does.
  /// The literal is byte-exact per 10 §3.5.
  override toChars(): DString {
    return this.ident !== null ? this.ident.toChars() : ds("__anonymous_param\0");
  }

  /// dmd/mtype.d:2490 — compute covariance of parameters `this` and `p` as determined by the
  /// storage classes of both.
  ///
  /// Params: `returnByRef` = true if the function returns by ref; `p` = parameter to compare with.
  /// Returns: true = `this` can be used in place of `p`.
  /// `p` is `const Parameter` — a read-only alias, no `.copy()` at the call site (03 §3.4).
  isCovariant(returnByRef: boolean, p: Parameter): boolean {
    let thisSTC: STC = this.storageClass;
    let otherSTC: STC = p.storageClass;

    if ((thisSTC & STC.constscoperef) !== 0n)
      thisSTC = (thisSTC | STC.scope_) as STC;
    if ((otherSTC & STC.constscoperef) !== 0n)
      otherSTC = (otherSTC | STC.scope_) as STC;

    // mtype.d:2501 — the `? STC.in_ : STC.none` selector is a flag-set truthiness test (09 §9).
    const mask = (STC.ref_ | STC.out_ | STC.lazy_
      | (((thisSTC | otherSTC) & STC.constscoperef) !== 0n ? STC.in_ : STC.none)) as STC;
    if ((thisSTC & mask) !== (otherSTC & mask))
      return false;
    return Parameter.isCovariantScope(returnByRef, thisSTC, otherSTC);
  }

  /// dmd/mtype.d:2507 — scope/ref covariance between two storage-class sets, decided by the
  /// `covariant[from][to]` table below.
  static isCovariantScope(returnByRef: boolean, from: STC, to: STC): boolean {
    /* Workaround for failing covariance when finding a common type of delegates, some of which
     * have parameters with inferred scope (dlang issue 21285). The root cause is that
     * scopeinferred is not part of the mangle, and mangle is used for type equality checks.
     */
    if ((to & STC.returninferred) !== 0n)
      to = (to & ~STC.return_) as STC;
    // note: f(return int* x) currently 'infers' scope without inferring `return`, keep STC.scope there
    if ((to & STC.scopeinferred) !== 0n && (to & STC.return_) === 0n)
      to = (to & ~STC.scope_) as STC;

    if (from === to)
      return true;

    /* result is true if the 'from' can be used as a 'to' */

    if (((from ^ to) & STC.ref_) !== 0n) // differing in 'ref' means no covariance
      return false;

    /* workaround until we get STC.returnScope reliably set correctly */
    if (returnByRef) {
      from = (from & ~STC.returnScope) as STC;
      to = (to & ~STC.returnScope) as STC;
    } else {
      from = (from | STC.returnScope) as STC;
      to = (to | STC.returnScope) as STC;
    }
    return Parameter.covariant[buildScopeRef(from)]![buildScopeRef(to)]!;
  }

  /// dmd/mtype.d:2544 `covariantInit()` + :2579 `private static immutable ... covariant =
  /// covariantInit();`. A CTFE-built `bool[ScopeRef.max+1][ScopeRef.max+1]` table, so 07 §9
  /// applies: the initializer is EVALUATED at translation time and emitted as the literal it
  /// produces — the D function itself is not ported (there is nothing left for it to compute).
  ///
  /// `covariant[from][to]`, rows/cols indexed by `ScopeRef` (None 0, Scope 1, ReturnScope 2,
  /// Ref 3, ReturnRef 4, RefScope 5, ReturnRef_Scope 6, Ref_ReturnScope 7, Return 8). Folded from
  /// mtype.d:2562-2574: the `i==i` diagonal, the all-true `RefScope` row, then the seven explicit
  /// cells. The result matches the From\To diagram in the D comment (mtype.d:2548-2558) exactly:
  ///
  ///     From\To           n   rs  s          From\To           r   rr  rs  rr-s r-rs
  ///     None              X                  Ref               X   X
  ///     ReturnScope       X   X              ReturnRef             X
  ///     Scope             X   X   X          RefScope          X   X   X   X    X
  ///                                          ReturnRef-Scope       X       X
  ///                                          Ref-ReturnScope   X   X            X
  private static readonly covariant: readonly (readonly boolean[])[] = [
    /* from None            */ [true,  false, false, false, false, false, false, false, false],
    /* from Scope           */ [true,  true,  true,  false, false, false, false, false, false],
    /* from ReturnScope     */ [true,  false, true,  false, false, false, false, false, false],
    /* from Ref             */ [false, false, false, true,  true,  false, false, false, false],
    /* from ReturnRef       */ [false, false, false, false, true,  false, false, false, false],
    /* from RefScope        */ [true,  true,  true,  true,  true,  true,  true,  true,  true ],
    /* from ReturnRef_Scope */ [false, false, false, false, true,  false, true,  false, false],
    /* from Ref_ReturnScope */ [false, false, false, true,  true,  false, false, true,  false],
    /* from Return          */ [false, false, false, false, false, false, false, false, true ],
  ];

  /// dmd/mtype.d:2581 — structural equality (storageClass + type). `type == other.type` is reference
  /// identity (Type defines no opEquals; D's class `==` falls back to `is`) -> `===` (05 §2).
  opEquals(other: Parameter): boolean {
    return this.storageClass === other.storageClass && this.type === other.type;
  }
}

// dmd/mtype.d:2403 — `alias ForeachDg = extern(D) int delegate(size_t, Parameter);` (Parameter.ForeachDg).
// Type alias of a delegate -> TS function type (02 §5.2). Hoisted to module scope (was nested in Parameter).
export type ParameterForeachDg = (paramidx: number, param: Parameter) => number;
// dmd/mtype.d:2407 — `alias SemanticForeachDg = ... delegate(size_t, Parameter, size_t, Parameter);`.
export type ParameterSemanticForeachDg = (
  oidx: number, oparam: Parameter, eidx: number, eparam: Parameter,
) => number;

// ── Module-private MODFlags shortcuts ──────────────────────────────────────────────────────
// dmd/mtype.d references `MODFlags.const_`/etc. unqualified (via `import dmd.astenums`). astenums.ts
// exports `MODFlags` as a TS enum; the mod predicates above are pure bit tests. We alias the few
// members used by the implemented predicates to module-local consts to keep those one-liners short.
// (Sourced from astenums MODFlags; values fixed by the D enum.)
const MODFlagsConst = 1;      // MODFlags.const_     (dmd/astenums.d)
const MODFlagsImmutable = 4;  // MODFlags.immutable_
const MODFlagsShared = 2;     // MODFlags.shared_
const MODFlagsWild = 8;       // MODFlags.wild
const MODFlagsWildconst = MODFlagsWild | MODFlagsConst; // MODFlags.wildconst == 0x9
