// Ported from dmd/dcast.d (module dmd.dcast) — "Semantic analysis for cast-expressions".
//
// FULL-FILE TRANSLATION (W3 S1). Every top-level D declaration of dcast.d is present here, in
// SOURCE ORDER, translated / walled (11 §2.5) / dropped-with-comment (07).
//
// IDIOM B (13 §7.5). `grep 'class .*Visitor' dmd/dcast.d` -> 0 hits: this module uses the
// nested-function visitor idiom — a free function whose body declares a base `visit` plus
// `visitXxx` specializations and ends with a hand-written dispatch `switch` on the node tag.
// The four such functions here are `implicitCastTo`, `implicitConvTo`, `implicitConvToType`
// (D's Type-receiver `implicitConvTo`), `castTo` and `getIntRange`. **Every dispatch switch is
// emitted IN FULL** — an unfilled arm is an inline wall at its `case` position, never a route
// to `default`/base `visit` (that silent collapse is the rung-era bug this file replaces).
//
// OVERLOAD SETS RESOLVED (04 §1):
//   - `implicitConvTo(Expression, Type)` (dcast.d:312) and `implicitConvTo(Type, Type)`
//     (dcast.d:1558) are a same-arity/different-first-parameter set -> Form B rename by receiver
//     type (04 §1B rule 2, §6.1). The **Expression** form keeps the bare name (every existing TS
//     dependent — typesem.ts, initsem.ts, semantic3.ts — imports that one); the **Type** form is
//     `implicitConvToType`.
//   - `intRangeFromType(Type)` / `intRangeFromType(Type, bool)` are arity-distinct prefixes ->
//     Form A, one function with an optional trailing parameter.
//
// TYPE OPERATIONS (04 §6). D homes ~55 `Type` operations as free functions in typesem.d (`size`,
// `toBasetype`, `nextOf`, `sizemask`, `constOf`, `immutableOf`, `arrayOf`, `sarrayOf`, `pointerTo`,
// `addMod`, `merge`, `isIntegral`, `isUnsigned`, `isFloating`, `isReal`, `isImaginary`, `isComplex`,
// `constConv`, `equivalent`, `isBaseOf`, …). typesem.ts exports every one of them, and this file
// calls the faithful free form.
//
// WAVE-5 WALL SWEEP. `constConv`, `equivalent`, `castMod`, `covariant`, `getIndirection`,
// `defaultInitLiteral`, `isRecursiveAliasThis`, `purityLevel` (typesem.ts), `equals`,
// `semanticTypeInfo`, `toUInteger`, `getConstInitializer`, `matchType` (expressionsem.ts),
// `getMemtype` (enumsem.ts) and `isReturnIsolated`, `overloadExactMatch` (funcsem.ts) are LIVE
// exports and their call sites call them.
//
// WAVE-9 WALL SWEEP. The `IntRange` API (intrange.ts: casts, `widest`, `contains`, the operator
// methods), `setUnsafe` (safe.ts), the receiver-split `implicitConvToWithoutAliasThis{Struct,Class}` /
// `implicitConvToThroughAliasThis{Struct,Class}` (typesem.ts), `incompatibleTypesFromBinExp`
// (expressionsem.ts) and `resolveAliasThis` (dsymbolsem.ts) are live, and their call walls are swept.
// The wave-5 "region is a FILL" walls over live callees (`castMod`, `defaultInitLiteral`,
// `isRecursiveAliasThis`, `equivalent`, `getIndirection`, `purityLevel`, `matchType`, `equals`,
// `overloadExactMatch`) are translated too, with the `Lcc` class-merge loop of `typeMerge`.
// `ctfeInterpret` (castTo, dcast.d:2097) is live in dinterpret.ts. `Dsymbol.toString` and
// `toChars(Expression)` are live, and the two array-op arm bodies of `typeMerge` (dcast.d:4121/:4165)
// are translated.
//
// COMPILE-TIME RESOLUTION (07):
//   - `enum LOG = false;` (dcast.d:51) -> `static if (LOG)` blocks at dcast.d:424, :443, :953,
//     :1026, :1287, :1343 are DROPPED (07 §3); the manifest constant is kept below for audit.
//   - 19 `version (none) { printf(...) }` blocks -> OFF (built-in, _config §1), DROPPED (07 §1).
//   - `enum log = false;` inside `findClassCommonRoot` -> its `if (log) printf(...)` lines are
//     dead and DROPPED (07 §9).
//
// IMPORTC: `import dmd.importc;` (dcast.d:37) supplies `arrayFuncConv` (ImportC array/function decay), called
// only from `typeMerge`'s `if (sc)` preamble; a value import placed last (01 §4.8).

import { assert, assertUnreachable } from "../assert.js";
import { ds, dsEquals, type DString } from "../dstring.js";
import { toInt8, toUint8, toInt16, toUint16, toInt32, toUint32, toUint64 } from "../numeric.js";

import type { Scope } from "./dscope.js";
import type { AggregateDeclaration } from "./aggregate.js";
import type { ClassDeclaration } from "./dclass.js";
import type { FuncDeclaration } from "./func.js";
import type { VarDeclaration } from "./declaration.js";
import type { StructDeclaration } from "./dstruct.js";
import type { Dsymbol } from "./dsymbol.js";
import type { dinteger_t } from "./globals.js";
import type { MOD } from "./astenums.js";

import type {
    BinExp,
    UnaExp,
    RealExp,
    ComplexExp,
    StringExp,
    ArrayLiteralExp,
    AssocArrayLiteralExp,
    StructLiteralExp,
    TupleExp,
    NewExp,
    OverExp,
    FuncExp,
    CallExp,
    SliceExp,
    CondExp,
    CommaExp,
    CastExp as CastExpT,
    AddExp as AddExpT,
    MinExp as MinExpT,
    DivExp as DivExpT,
    MulExp as MulExpT,
    ModExp as ModExpT,
    AndExp as AndExpT,
    OrExp as OrExpT,
    XorExp as XorExpT,
    ShlExp as ShlExpT,
    ShrExp as ShrExpT,
    UshrExp as UshrExpT,
    AssignExp,
    ComExp as ComExpT,
    NegExp as NegExpT,
    VarExp as VarExpT,
    AddrExp as AddrExpT,
    SymOffExp as SymOffExpT,
    DelegateExp as DelegateExpT,
    NullExp,
    IntegerExp as IntegerExpT,
    ErrorExp as ErrorExpT,
} from "./expression.js";

// Body-fill value imports (01 §4.3 — read only inside function bodies, after module load). None of
// these modules value-import dcast.ts on the load path that reaches these symbols, so the cycle is
// broken by use-time reads.
import {
    Expression,
    ErrorExp,
    CastExp,
    VectorExp,
    AddrExp,
    CondExp as CondExpC,
    CommaExp as CommaExpC,
    IntegerExp,
    IndexExp,
    AddExp,
    MinExp,
    MulExp,
    DivExp,
    PowExp,
    SymOffExp,
    VarExp,
    DelegateExp,
    ThisExp,
    WANTvalue,
    isFuncAddress,
} from "./expression.js";
import {
    Type,
    TypeVector,
    TypeSArray,
    TypeStruct,
    TypeClass,
    TypeFunction,
    TypeDelegate,
    Parameter,
    toAutoQualChars,
    isSomeChar,
    MODimplicitConv,
    MODmerge,
    SIZE_INVALID,
} from "./mtype.js";
import type {
    TypeBasic,
    TypeTuple,
    TypeAArray,
    TypeDArray,
    TypePointer,
    TypeEnum,
    TypeNull,
    TypeNoreturn,
    TypeAArray as TypeAArrayT,
} from "./mtype.js";
import { EXP } from "./tokens.js";
import { MATCH, TY, MODFlags, TFlags, PURE, STC, TRUST } from "./astenums.js";
import { Covariant } from "./mtype.js";
import { IntRange, SignExtendedNumber } from "./intrange.js";
import { implicitConvCommonTy, implicitConvTy1 } from "./impcnvtab.js";
import { error, errorSupplemental, deprecation } from "./errors.js";
import { Loc } from "./location.js";
import { global } from "./globals.js";
import { optimize } from "./optimize.js";
import { EXPtoString, dsymbolToErrMsg, toErrMsg } from "./hdrgen.js";
// Body-fill (01 §4.3 — value import across the core-SCC cycle, read only inside `typeMerge`):
// `arrayop.ts` declares its one visitor class INSIDE a function body, so it carries no top-level
// `extends` back into the SCC.
import { isArrayOpImplicitCast, isArrayOpOperand, isBinArrayOp } from "./arrayop.js";
import {
    hasPointers, constConv, equivalent, isBaseOf, isIntegral, toBasetype, isUnsigned, sizemask, nextOf, addMod,
    immutableOf, size, constOf, isReal, isImaginary, isComplex, isFloating, arrayOf, sarrayOf, pointerTo,
    isAggregate, castMod, covariant, getIndirection, defaultInitLiteral, isRecursiveAliasThis, purityLevel,
    typeSemantic, isZeroInit, implicitConvToWithoutAliasThisStruct, implicitConvToWithoutAliasThisClass,
    implicitConvToThroughAliasThisStruct, implicitConvToThroughAliasThisClass
} from "./typesem.js";
// ALIAS: `intRangeFromType`'s own `isUnsigned` parameter (dcast.d:78) shadows the bare binding.
import { isUnsigned as typeIsUnsigned } from "./typesem.js";
import { expressionSemantic, toInteger, toBool, isLvalue, trySemantic, hasThis } from "./expressionsem.js";
// `equals` / `semanticTypeInfo` are D-homed at expressionsem.d:919 / :18781 (1.43 de-methodized
// both into Idiom-B free functions).
import {
    equals, semanticTypeInfo, toUInteger, getConstInitializer, incompatibleTypesFromBinExp, matchType
} from "./expressionsem.js";
// `checkForwardRef` is D-homed at funcsem.d:1712.
import { checkForwardRef } from "./funcsem.js";
import { isPure, isReturnIsolated, overloadExactMatch } from "./funcsem.js";
// dmd/dcast.d:1904 — D's function-local selective import `import dmd.enumsem : getMemtype;`,
// hoisted to module scope (01 §4.4).
import { getMemtype } from "./enumsem.js";
import { OutBuffer } from "./common/outbuffer.js";
import { utf_decodeChar, utf_decodeWchar, utf_isValidDchar } from "./root/utf.js";
import { arrayCastBigEndian } from "./utils.js";
// dmd/dcast.d:3344 — `sc.setUnsafe(...)` (`dmd.safe`, safe.d:469). Last (01 §4.8): safe.ts value-imports
// dcast.ts, dsymbolsem.ts and funcsem.ts, so an earlier position could make it the SCC entry.
import { setUnsafe } from "./safe.js";
// dmd/dcast.d:171 — `resolveAliasThis` (dsymbolsem.d:1845). Last, for the same reason as safe.ts above.
import { resolveAliasThis, sizeDsymbol } from "./dsymbolsem.js";
// `ScopeDsymbol.multiplyDefined` (dsymbol.d), read only inside function bodies. Last, as above.
import { ScopeDsymbol } from "./dsymbol.js";
// dmd/dcast.d:4187 — `isCommutative` (opover.d:49), read only inside `typeMerge`. Last, as above:
// opover.ts value-imports dsymbolsem.ts, funcsem.ts and templatesem.ts.
import { isCommutative } from "./opover.js";
// dmd/dcast.d:23 (`import dmd.dinterpret;`) — `ctfeInterpret`, added by the wave-14 sweep. Last, as above:
// dinterpret.ts value-imports the core SCC (expressionsem, dsymbolsem, funcsem).
import { ctfeInterpret } from "./dinterpret.js";
// dmd/dcast.d:37 (`import dmd.importc;`) — `arrayFuncConv` (importc.d:83). Last, as above: importc.ts value-imports
// typesem, dcast, dsymbolsem and expressionsem.
import { arrayFuncConv } from "./importc.js";
import type { Expressions } from "./arraytypes.js";

/// The canonical box / ref-cell for a D `ref`/`out` parameter (03 §7.2 / §3.3).
interface Ref<T> {
    value: T;
}

/// dmd/dcast.d:51 — `enum LOG = false;` (manifest constant). Kept for audit: it is the input to the
/// six `static if (LOG)` blocks resolved OFF and dropped (07 §3).
const LOG = false;
void LOG;

/**
 * dmd/dcast.d:53 — `IntRange _cast(IntRange _this, Type type)`.
 *
 * Narrows `_this` to the value range representable by `type`. UFCS receiver-first free function
 * (`someRange._cast(t)` in D); the name keeps D's keyword-escaping underscore verbatim (01 §2.1).
 *
 * `_this` is a D BY-VALUE parameter and the `castSigned`/`castDchar`/`castUnsigned` methods
 * (intrange.d:341/:408/:383) MUTATE their receiver: a caller passes a copy unless its argument is
 * a fresh temporary (03 §3.1). The result may be `_this` itself.
 */
export function _cast(_this: IntRange, type: Type): IntRange {
    if (!isIntegral(type) || toBasetype(type).isTypeVector() !== null)
        return _this;
    if (!isUnsigned(type))
        return _this.castSigned(sizemask(type));
    if (toBasetype(type).ty === TY.Tdchar)
        return _this.castDchar();
    return _this.castUnsigned(sizemask(type));
}

/**
 * dmd/dcast.d:64 — `IntRange castUnsigned(IntRange _this, Type type)`.
 *
 * The unsigned-reinterpretation companion of `_cast`. Note the name collision is only apparent:
 * this is the dcast.d FREE function; `_this.castUnsigned(mask)` inside it is the intrange.d
 * METHOD of the same name (intrange.d:383). Same by-value `_this` contract as `_cast`.
 */
export function castUnsigned(_this: IntRange, type: Type): IntRange {
    if (!isIntegral(type) || toBasetype(type).isTypeVector() !== null)
        return _this.castUnsigned(0xFFFF_FFFF_FFFF_FFFFn); // ulong.max
    if (toBasetype(type).ty === TY.Tdchar)
        return _this.castDchar();
    return _this.castUnsigned(sizemask(type));
}

/**
 * dmd/dcast.d:73 + dmd/dcast.d:78 — `IntRange intRangeFromType(Type)` /
 * `IntRange intRangeFromType(Type, bool isUnsigned)`.
 *
 * Overload set collapsed by ARITY (04 §1 Form A): the 1-argument form is literally the 2-argument
 * one with `isUnsigned = type.isUnsigned()`. The default is computed in the body (it depends on the
 * first argument), so the parameter is optional rather than carrying a TS default expression.
 */
export function intRangeFromType(type: Type, isUnsigned?: boolean): IntRange {
    // dmd/dcast.d:75 — the 1-arg overload forwards with `type.isUnsigned()`. The typesem free
    // function is reached through the `typeIsUnsigned` alias here: this function's own `bool
    // isUnsigned` parameter (dcast.d:78) shadows the module-level binding inside this body.
    const unsigned = isUnsigned !== undefined ? isUnsigned : typeIsUnsigned(type);

    if (!isIntegral(type) || toBasetype(type).isTypeVector() !== null)
        return IntRange.widest();

    const mask: bigint = sizemask(type);
    const lower = new SignExtendedNumber(0n);
    const upper = new SignExtendedNumber(mask);
    if (toBasetype(type).ty === TY.Tdchar)
        upper.value = 0x10FFFFn;
    else if (!unsigned) {
        // `mask` is a `uinteger_t` and `SignExtendedNumber.value` is a `uinteger_t`, so D's `~`
        // yields a 64-bit UNSIGNED pattern (`~0x7FFFFFFF` -> 0xFFFF_FFFF_8000_0000). BigInt `~` is
        // unbounded, hence the re-truncation (09 §4.2).
        lower.value = BigInt.asUintN(64, ~(mask >> 1n));
        lower.negative = true;
        upper.value = mask >> 1n;
    }
    return new IntRange(lower, upper);
}

/**
 * dmd/dcast.d:112 — `Expression implicitCastTo(Expression e, Scope* sc, Type t)`.
 *
 * Attempt to implicitly cast the expression into type `t`. This routine will CHANGE `e`; to check
 * the matching level only, use `implicitConvTo`.
 *
 * Params: e = expression to be cast; sc = current scope (nullable — the body null-tests it);
 *         t = expected resulting type.
 * Returns: the resulting cast expression (mutating `e`), or `ErrorExp` if no such implicit
 *          conversion is possible.
 *
 * IDIOM B (13 §7.5): nested `visit` + 5 specializations + the trailing dispatch switch, in full.
 */
export function implicitCastTo(e: Expression, sc: Scope | null, t: Type): Expression {
    // dmd/dcast.d:114 — the base `visit(Expression)`.
    const visit = (e: Expression): Expression => {
        // dropped: //printf trace (dcast.d:116)
        // dmd/dcast.d:117 — `(sc && sc.inCfile) ? e.cimplicitConvTo(t) : e.implicitConvTo(t)`.
        const match: MATCH = sc !== null && sc.inCfile ? cimplicitConvTo(e, t) : implicitConvTo(e, t);
        if (match !== MATCH.nomatch) {
            // no need for an extra cast when matching is exact
            if (match === MATCH.convert && e.type!.isTypeNoreturn() !== null && e.op !== EXP.type) {
                return specialNoreturnCast(e, t);
            }
            // dmd/dcast.d:125 — `e.type.constConv(t) || !e.isLvalue() && e.type.equivalent(t)`.
            // `constConv`/`equivalent` are typesem.d free functions (typesem.ts carries both);
            // `e.isLvalue()` is the expressionsem.d:681 free function reached by UFCS (04 §6).
            // D's `||`/`&&` precedence is `a || ((!b) && c)`; `constConv` returns a MATCH used in a
            // boolean context -> `!== MATCH.nomatch` (09 §9.1).
            if (match === MATCH.constant &&
                (constConv(e.type!, t) !== MATCH.nomatch || (!isLvalue(e) && equivalent(e.type!, t)))) {
                /* Do not emit CastExp for const conversions and
                 * unique conversions on rvalue.
                 */
                const result = e.copy();
                result.type = t;
                return result;
            }

            const ad = isAggregate(e.type!);
            if (ad === null || ad.aliasthis === null)
                return castTo(e, sc, t);

            if (ad.type === null || ad.type.isTypeError() !== null)
                return e;
            // dmd/dcast.d:141 — D's two `implicitConvToWithoutAliasThis` receivers are the Form B
            // `...Struct` / `...Class` pair in typesem.ts (typesem.d:9225/:9272).
            const ts = ad.type.isTypeStruct();
            const adMatch = ts !== null
                ? implicitConvToWithoutAliasThisStruct(ts, t)
                : implicitConvToWithoutAliasThisClass(ad.type.isTypeClass()!, t);

            if (adMatch !== MATCH.nomatch)
                return castTo(e, sc, t);

            const tob = toBasetype(t);
            const t1b = toBasetype(e.type!);
            if (ad === isAggregate(tob))
                return castTo(e, sc, t);

            if (t1b.ty === TY.Tclass && tob.ty === TY.Tclass) {
                const t1cd: ClassDeclaration = t1b.isClassHandle()!;
                const tocd: ClassDeclaration = tob.isClassHandle()!;
                const offset: Ref<number> = { value: 0 };
                if (tocd.isBaseOf(t1cd, offset)) {
                    const result = new CastExp(e.loc, e, t);
                    result.type = t;
                    return result;
                }
            }

            /* Forward the cast to our alias this member, rewrite to:
             *   cast(to)e1.aliasthis
             */
            // D hands its `Scope*` through unchecked; `resolveAliasThis` (dsymbolsem.d) is not gagged
            // here, so it returns an expression.
            const result = resolveAliasThis(sc!, e)!;
            return castTo(result, sc, t);
        }

        const result = optimize(e, WANTvalue);
        if (result !== e) {
            return implicitCastTo(result, sc, t);
        }

        if (t.ty === TY.Terror || e.type!.ty === TY.Terror)
            return ErrorExp.get();

        if (t.deco === null) {
            error(e.loc, ds("forward reference to type `%s`"), t.toChars());
            return ErrorExp.get();
        }

        // dropped: //printf traces + the commented-out typeSemantic retry (dcast.d:186-191)
        const ts = toAutoQualChars(e.type!, t);

        // Special case for improved diagnostic when const to mutable conversion
        // fails due to struct/union having pointers
        if (e.type!.ty === TY.Tstruct && t.ty === TY.Tstruct &&
            e.type!.isTypeStruct()!.sym === t.isTypeStruct()!.sym &&
            e.type!.mod === MODFlags.const_ && t.mod === 0 && hasPointers(e.type!)) {
            const sym: StructDeclaration = e.type!.isTypeStruct()!.sym!;
            // swept: the whole diagnostic D writes at dmd/dcast.d:202-204 is live. `e.toErrMsg()`
            // resolves to the Expression overload (hdrgen.d:126 — more specialised than the
            // RootObject dispatcher at :112), `sym.toErrMsg()` to the Dsymbol overload (hdrgen.d:138,
            // exported here as `dsymbolToErrMsg`); `sym.kind()` is dstruct.ts:212 and `ts` was
            // computed three lines above by the live `toAutoQualChars`.
            error(e.loc,
                ds("cannot implicitly convert expression `%s` of type `%s` to `%s` because %s `%s` contains pointers or references"),
                // upcast cascade (02 §11.5): AggregateDeclaration.deferred (Dsymbol) shadows
                // Dsymbol.deferred (bool), so TS rejects the sound StructDeclaration -> Dsymbol
                // upcast. Typing artifact only — `sym` IS a Dsymbol at runtime.
                toErrMsg(e), ts[0], ts[1], sym.kind(), dsymbolToErrMsg(sym as unknown as Dsymbol));
            return ErrorExp.get();
        }

        // Special case for pointer conversions
        if (toBasetype(e.type!).ty === TY.Tpointer && toBasetype(t).ty === TY.Tpointer) {
            const fromPointee = nextOf(e.type!)!;
            const toPointee = nextOf(t)!;
            // Const -> mutable conversion (disallowed)
            if (fromPointee.isConst() && !toPointee.isConst()) {
                error(e.loc, ds("cannot implicitly convert `%s` to `%s`"), e.type!.toChars(), t.toChars());
                errorSupplemental(
                    e.loc,
                    ds("Note: Converting const to mutable requires an explicit cast (`cast(int*)`)."),
                );
                return ErrorExp.get();
            }
            // Incompatible pointee types (e.g., int* -> float* )
            else if (toBasetype(fromPointee).ty !== toBasetype(toPointee).ty) {
                error(e.loc, ds("cannot implicitly convert `%s` to `%s`"), e.type!.toChars(), t.toChars());
                errorSupplemental(
                    e.loc,
                    ds("Note: Pointer types point to different base types (`%s` vs `%s`)"),
                    fromPointee.toChars(),
                    toPointee.toChars(),
                );
                return ErrorExp.get();
            }
        }
        error(
            e.loc,
            ds("cannot implicitly convert expression `%s` of type `%s` to `%s`"),
            toErrMsg(e),
            ts[0],
            ts[1],
        );

        return ErrorExp.get();
    };

    // dmd/dcast.d:231 — `Expression visitString(StringExp e)`.
    const visitString = (e: StringExp): Expression => {
        const result = visit(e);
        const se = result.isStringExp();
        if (se !== null) {
            // Retain polysemous nature if it started out that way
            se.committed = e.committed;
        }
        return result;
    };

    // dmd/dcast.d:243 — `Expression visitError(ErrorExp e)`.
    const visitError = (e: ErrorExpT): Expression => {
        return e;
    };

    // dmd/dcast.d:248 — `Expression visitFunc(FuncExp e)`.
    const visitFunc = (e: FuncExp): Expression => {
        // dropped: //printf trace (dcast.d:250)
        // `&fe` (a `FuncExp*` out-slot) is the 03 §7.2 box.
        const fe: { value: FuncExp | null } = { value: null };
        if (matchType(e, t, sc, fe, global.errorSink!) > MATCH.nomatch) {
            return fe.value!;
        }
        return visit(e);
    };

    // dmd/dcast.d:259 — `Expression visitArrayLiteral(ArrayLiteralExp e)`.
    const visitArrayLiteral = (e: ArrayLiteralExp): Expression => {
        const result = visit(e);

        const tb = toBasetype(result.type!);
        const ta = tb.isTypeDArray();
        if (ta !== null) {
            // probe: Type.dtypeinfo is declared non-null but unset until Type._init; D tests
            // `if (Type.dtypeinfo)` (02 §11.4 uninitialized-static probe).
            if (global.params.useTypeInfo && (Type as { dtypeinfo?: unknown }).dtypeinfo) {
                // dmd/dcast.d:266 — `semanticTypeInfo(sc, ta.next)`; callee authorised at
                // dmd/expressionsem.d:18781 (`semanticTypeInfo`).
                semanticTypeInfo(sc, ta.next);
            }
        }
        return result;
    };

    // dmd/dcast.d:270 — `Expression visitSlice(SliceExp e)`.
    const visitSlice = (e: SliceExp): Expression => {
        const result = visit(e);

        const se = result.isSliceExp();
        if (se !== null) {
            const ale = se.e1!.isArrayLiteralExp();
            if (ale !== null) {
                const tb = toBasetype(t);
                const tx: Type = tb.ty === TY.Tsarray
                    ? sarrayOf(nextOf(tb)!, ale.elements !== null ? BigInt(ale.elements.length) : 0n)
                    : arrayOf(nextOf(tb)!);
                se.e1 = implicitCastTo(ale, sc, tx);
            }
        }

        return result;
    };

    // dmd/dcast.d:287 — the trailing dispatch switch IS the visitor dispatch (13 §7.5 rule 1):
    // emitted IN FULL, `default` reproduces D's fall-to-base.
    switch (e.op) {
        default: return visit(e);
        case EXP.string_: return visitString(e.isStringExp()!);
        case EXP.error: return visitError(e.isErrorExp()!);
        case EXP.function_: return visitFunc(e.isFuncExp()!);
        case EXP.arrayLiteral: return visitArrayLiteral(e.isArrayLiteralExp()!);
        case EXP.slice: return visitSlice(e.isSliceExp()!);
    }
}

/**
 * dmd/dcast.d:312 — `MATCH implicitConvTo(Expression e, Type t)`.
 *
 * Checks whether or not an expression can be implicitly converted to type `t`. Unlike
 * `implicitCastTo`, this routine does NOT perform the cast — it only reports up to what `MATCH`
 * level the conversion would be possible.
 *
 * Overload set (04 §1B): this is the **Expression**-receiver member of D's `implicitConvTo` pair
 * and keeps the bare name; the Type-receiver member is `implicitConvToType` below.
 *
 * IDIOM B (13 §7.5): nested `visit` + 3 static helpers + 22 specializations + the trailing
 * dispatch switch, emitted IN FULL.
 */
export function implicitConvTo(e: Expression, t: Type): MATCH {
    // dmd/dcast.d:314 — the base `visit(Expression)`.
    const visit = (e: Expression): MATCH => {
        // resolved: version (none) printf block (dcast.d:316) -> OFF, dropped (07 §1).
        // dropped: `//static int nest; if (++nest == 10) assert(0);` (commented out upstream)
        if (t === Type.terror)
            return MATCH.nomatch;
        if (e.type === null) {
            error(e.loc, ds("`%s` is not an expression"), e.toChars());
            e.type = Type.terror;
        }

        const ex = optimize(e, WANTvalue);
        if (ex.type!.equals(t)) {
            return MATCH.exact;
        }
        if (ex !== e) {
            // dropped: //printf trace (dcast.d:335)
            return implicitConvTo(ex, t);
        }

        const match = implicitConvToType(e.type!, t);
        if (match !== MATCH.nomatch) {
            return match;
        }

        /* See if we can do integral narrowing conversions
         */
        if (isIntegral(e.type!) && isIntegral(t) && e.type!.isTypeBasic() !== null && t.isTypeBasic() !== null) {
            const src = getIntRange(e);
            const target = intRangeFromType(t);
            // `contains` (intrange.d:420) does not mutate its by-value argument (intrange.ts COPY
            // DISCIPLINE): `src` passes bare.
            if (target.contains(src)) {
                return MATCH.convert;
            }
        }
        return MATCH.nomatch;
    };

    /**
     * dmd/dcast.d:366 — `static MATCH implicitMod(Expression e, Type t, MOD mod)`.
     * Given expression e of type t, see if we can implicitly convert e to type tprime, where
     * tprime is type t with mod bits added. Returns: match level.
     */
    const implicitMod = (e: Expression, t: Type, mod: MOD): MATCH => {
        // dmd/dcast.d:368-376 — every branch calls `Type.castMod`; callee authorised at
        // dmd/typesem.d:8879 (`castMod`).
        let tprime: Type;
        if (t.ty === TY.Tpointer)
            tprime = pointerTo(castMod(nextOf(t)!, mod));
        else if (t.ty === TY.Tarray)
            tprime = arrayOf(castMod(nextOf(t)!, mod));
        else if (t.ty === TY.Tsarray)
            tprime = sarrayOf(castMod(nextOf(t)!, mod), size(t) / size(nextOf(t)!));
        else
            tprime = castMod(t, mod);

        return implicitConvTo(e, tprime);
    };

    /// dmd/dcast.d:381 — `static MATCH implicitConvToAddMin(BinExp e, Type t)`.
    /// Is this (ptr +- offset)? If so, then ask ptr if the conversion can be done. This is to
    /// support doing things like implicitly converting a mutable unique pointer to an immutable one.
    const implicitConvToAddMin = (e: BinExp, t: Type): MATCH => {
        const tb = toBasetype(t);
        const typeb = toBasetype(e.type!);

        if (typeb.ty !== TY.Tpointer || tb.ty !== TY.Tpointer)
            return MATCH.nomatch;

        const t1b = toBasetype(e.e1!.type!);
        const t2b = toBasetype(e.e2!.type!);
        // dmd/dcast.d:397/:404 — `t1b.equivalent(tb)` / `t2b.equivalent(tb)`; callee authorised
        // at dmd/typesem.d:8430 (`equivalent`).
        if (t1b.ty === TY.Tpointer && isIntegral(t2b) && equivalent(t1b, tb)) {
            // ptr + offset
            // ptr - offset
            const m = implicitConvTo(e.e1!, t);
            return m > MATCH.constant ? MATCH.constant : m;
        }
        if (t2b.ty === TY.Tpointer && isIntegral(t1b) && equivalent(t2b, tb)) {
            // offset + ptr
            const m = implicitConvTo(e.e2!, t);
            return m > MATCH.constant ? MATCH.constant : m;
        }

        return MATCH.nomatch;
    };

    /// dmd/dcast.d:416 — `static bool parametersModMatch(Expressions* args, TypeFunction tf, MOD mod)`.
    /// Apply mod bits to each function parameter, and see if we can convert the function argument
    /// to the modded type.
    const parametersModMatch = (args: Expressions | null, tf: TypeFunction, mod: MOD): boolean => {
        const nparams = tf.parameterList.length();
        const j = tf.isDstyleVariadic() ? 1 : 0; // if TypeInfoArray was prepended
        for (let i = j; i < (args ?? []).length; i++) {
            const earg = args!.opIndex(i)!;
            const targ = toBasetype(earg.type!);
            // resolved: static if (LOG) printf(...) -> OFF, dropped (dcast.d:424).
            if (i - j < nparams) {
                const fparam = tf.parameterList.opIndex(i - j)!;
                if (fparam.isLazy())
                    return false; // not sure what to do with this
                const tparam = fparam.type;
                if (tparam === null)
                    continue;
                if (fparam.isReference()) {
                    // dmd/dcast.d:438 — `targ.constConv(tparam.castMod(mod))`; callees authorised
                    // at dmd/typesem.d:3054 (`constConv`) and dmd/typesem.d:8879 (`castMod`).
                    if (constConv(targ, castMod(tparam, mod)) === MATCH.nomatch)
                        return false;
                    continue;
                }
            }
            // resolved: static if (LOG) printf(...) -> OFF, dropped (dcast.d:443).
            if (implicitMod(earg, targ, mod) === MATCH.nomatch)
                return false;
        }
        return true;
    };

    // dmd/dcast.d:453 — `MATCH visitAdd(AddExp e)`.
    const visitAdd = (e: AddExpT): MATCH => {
        // resolved: version (none) printf block (dcast.d:455) -> OFF, dropped.
        let result = visit(e);
        if (result === MATCH.nomatch)
            result = implicitConvToAddMin(e, t);
        return result;
    };

    // dmd/dcast.d:465 — `MATCH visitMin(MinExp e)`.
    const visitMin = (e: MinExpT): MATCH => {
        // resolved: version (none) printf block (dcast.d:467) -> OFF, dropped.
        let result = visit(e);
        if (result === MATCH.nomatch)
            result = implicitConvToAddMin(e, t);
        return result;
    };

    // dmd/dcast.d:477 — `MATCH visitInteger(IntegerExp e)`.
    const visitInteger = (e: IntegerExpT): MATCH => {
        // resolved: version (none) printf block (dcast.d:479) -> OFF, dropped.
        const m = implicitConvToType(e.type!, t);
        if (m >= MATCH.constant) {
            return m;
        }

        let ty: TY = toBasetype(e.type!).ty;
        let toty: TY = toBasetype(t).ty;
        const oldty: TY = ty;

        if (m === MATCH.nomatch && t.ty === TY.Tenum)
            return MATCH.nomatch;

        const tv = t.isTypeVector();
        if (tv !== null) {
            const tb: TypeBasic = tv.elementType();
            if (tb.ty === TY.Tvoid)
                return MATCH.nomatch;
            toty = tb.ty;
        }

        switch (ty) {
            case TY.Tbool:
            case TY.Tint8:
            case TY.Tchar:
            case TY.Tuns8:
            case TY.Tint16:
            case TY.Tuns16:
            case TY.Twchar:
                ty = TY.Tint32;
                break;

            case TY.Tdchar:
                ty = TY.Tuns32;
                break;

            default:
                break;
        }

        // Only allow conversion if no change in value
        const value: dinteger_t = toInteger(e);

        /// dmd/dcast.d:527 — `bool isLosslesslyConvertibleToFP(T)()`. Template instantiated at
        /// `float`, `double` and `real_t`; `real_t` is the host double whatever the triple (`_config`, 09 §6,
        /// 10 §4.8), so all three instantiations share ONE body parameterised by the JS float
        /// round-trip. Monomorphized here with the mantissa width as the only varying input
        /// (07 §4): `float` rounds through `Math.fround`, `double`/`real_t` are exact JS numbers.
        const isLosslesslyConvertibleToFP = (single: boolean): boolean => {
            if (isUnsigned(e.type!)) {
                const uv = BigInt.asUintN(64, value);
                const f = single ? Math.fround(Number(uv)) : Number(uv);
                return BigInt(Math.trunc(f)) === uv;
            }
            const sv = BigInt.asIntN(64, value);
            const f = single ? Math.fround(Number(sv)) : Number(sv);
            return BigInt(Math.trunc(f)) === sv;
        };

        // dmd/dcast.d:628 — `goto default;` from `case Tpointer:` needs the default arm as a
        // callable (06 §3.6(b)); the arm is a plain `return visit(e)`, so the closure returns MATCH.
        const defaultArm = (): MATCH => visit(e);

        switch (toty) {
            case TY.Tbool:
                if ((value & 1n) !== value)
                    return MATCH.nomatch;
                break;

            case TY.Tint8:
                // D: `value & ~0x7FU` — `0x7FU` is a `uint`, so `~` gives the UINT 0xFFFF_FF80 which
                // ZERO-extends into the ulong compare (bits 32..63 are NOT tested). 09 §4.1/§4.2.
                if (ty === TY.Tuns64 && (value & 0xFFFFFF80n) !== 0n)
                    return MATCH.nomatch;
                if (BigInt(toInt8(Number(value & 0xFFn))) !== BigInt.asIntN(64, value))
                    return MATCH.nomatch;
                break;

            case TY.Tchar:
                if ((oldty === TY.Twchar || oldty === TY.Tdchar) && value > 0x7Fn)
                    return MATCH.nomatch;
            // goto case Tuns8; -> fall through to the next case (06 §3.6(a))
            case TY.Tuns8:
                // dropped: //printf trace (dcast.d:559)
                if (BigInt(toUint8(Number(value & 0xFFn))) !== BigInt.asIntN(64, value))
                    return MATCH.nomatch;
                break;

            case TY.Tint16:
                // D: `value & ~0x7FFFU` — zero-extended uint mask 0xFFFF_8000 (see the Tint8 arm).
                if (ty === TY.Tuns64 && (value & 0xFFFF8000n) !== 0n)
                    return MATCH.nomatch;
                if (BigInt(toInt16(Number(value & 0xFFFFn))) !== BigInt.asIntN(64, value))
                    return MATCH.nomatch;
                break;

            case TY.Twchar:
                if (oldty === TY.Tdchar && value > 0xD7FFn && value < 0xE000n)
                    return MATCH.nomatch;
            // goto case Tuns16; -> fall through to the next case (06 §3.6(a))
            case TY.Tuns16:
                if (BigInt(toUint16(Number(value & 0xFFFFn))) !== BigInt.asIntN(64, value))
                    return MATCH.nomatch;
                break;

            case TY.Tint32:
                if (ty === TY.Tuns32) {
                    // (empty in D)
                    // D: `value & ~0x7FFFFFFFU` — zero-extended uint mask 0x8000_0000.
                } else if (ty === TY.Tuns64 && (value & 0x80000000n) !== 0n)
                    return MATCH.nomatch;
                else if (BigInt(toInt32(Number(value & 0xFFFFFFFFn))) !== BigInt.asIntN(64, value))
                    return MATCH.nomatch;
                break;

            case TY.Tuns32:
                if (ty === TY.Tint32) {
                    // (empty in D)
                } else if (BigInt(toUint32(Number(value & 0xFFFFFFFFn))) !== BigInt.asIntN(64, value))
                    return MATCH.nomatch;
                break;

            case TY.Tdchar:
                // D compares the raw `dinteger_t` (ulong) carrier, so a NEGATIVE source constant
                // reads as 0xFFFF_FFFF_FFFF_FFFF and is rejected (`dchar d = -1;` is an error).
                // The port's carrier is sign-normalized, so read it unsigned first (09 §3.1).
                if (BigInt.asUintN(64, value) > 0x10FFFFn)
                    return MATCH.nomatch;
                break;

            case TY.Tfloat32:
                if (!isLosslesslyConvertibleToFP(true))
                    return MATCH.nomatch;
                break;

            case TY.Tfloat64:
                if (!isLosslesslyConvertibleToFP(false))
                    return MATCH.nomatch;
                break;

            case TY.Tfloat80:
                if (!isLosslesslyConvertibleToFP(false))
                    return MATCH.nomatch;
                break;

            case TY.Tpointer:
                // dropped: //printf traces (dcast.d:619-620)
                if (ty === TY.Tpointer && nextOf(toBasetype(e.type!))!.ty === nextOf(toBasetype(t))!.ty) {
                    /* Allow things like:
                     *      const char* P = cast(char *)3;
                     *      char* q = P;
                     */
                    break;
                }
                // goto default; -> the default arm as a closure (06 §3.6(b))
                return defaultArm();

            default:
                return defaultArm();
        }

        // dropped: //printf("MATCH.convert\n")
        return MATCH.convert;
    };

    // dmd/dcast.d:638 — `MATCH visitError(ErrorExp e)`.
    const visitError = (e: ErrorExpT): MATCH => {
        void e;
        return MATCH.nomatch;
    };

    // dmd/dcast.d:643 — `MATCH visitNull(NullExp e)`.
    const visitNull = (e: NullExp): MATCH => {
        // resolved: version (none) printf block (dcast.d:645) -> OFF, dropped.
        if (e.type!.equals(t)) {
            return MATCH.exact;
        }

        /* Allow implicit conversions from immutable to mutable|const, and mutable to immutable.
         * It works because, after all, a null doesn't actually point to anything.
         */
        // dmd/dcast.d:658 — `t.equivalent(e.type)`; callee authorised at dmd/typesem.d:8430
        // (`equivalent`).
        if (equivalent(t, e.type!)) {
            return MATCH.constant;
        }

        return visit(e);
    };

    // dmd/dcast.d:666 — `MATCH visitStructLiteral(StructLiteralExp e)`.
    const visitStructLiteral = (e: StructLiteralExp): MATCH => {
        // resolved: version (none) printf block (dcast.d:668) -> OFF, dropped.
        let result = visit(e);
        if (result !== MATCH.nomatch)
            return result;
        if (e.type!.ty === t.ty && e.type!.isTypeStruct() !== null &&
            e.type!.isTypeStruct()!.sym === t.isTypeStruct()!.sym) {
            result = MATCH.constant;
            for (let i = 0; i < e.elements!.length; i++) {
                const el = e.elements!.opIndex(i);
                if (el === null)
                    continue;
                // dmd/dcast.d:682 — `e.sd.fields[i].type.addMod(t.mod)`.
                const te = addMod(e.sd!.fields.opIndex(i)!.type!, t.mod);
                const m2 = implicitConvTo(el, te);
                // dropped: //printf trace (dcast.d:683)
                if (m2 < result)
                    result = m2;
            }
        }
        return result;
    };

    // dmd/dcast.d:692 — `MATCH visitString(StringExp e)`.
    const visitString = (e: StringExp): MATCH => {
        // resolved: version (none) printf block (dcast.d:694) -> OFF, dropped.
        if (!e.committed && t.ty === TY.Tpointer && nextOf(t)!.ty === TY.Tvoid)
            return MATCH.nomatch;

        if (!(e.type!.isStaticOrDynamicArray() || e.type!.ty === TY.Tpointer))
            return visit(e);

        const tyn: TY = nextOf(e.type!)!.ty;

        if (!isSomeChar(tyn) && !e.hexString)
            return visit(e);

        switch (t.ty) {
            case TY.Tsarray:
                if (e.type!.ty === TY.Tsarray) {
                    const tynto: TY = nextOf(t)!.ty;
                    if (tynto === tyn) {
                        if (toInteger(e.type!.isTypeSArray()!.dim!) === toInteger(t.isTypeSArray()!.dim!)) {
                            return MATCH.exact;
                        }
                        return MATCH.nomatch;
                    }
                    if (isSomeChar(tynto)) {
                        if (e.committed && tynto !== tyn)
                            return MATCH.nomatch;
                        // `out .string s` -> single-slot box, reset on entry (03 §3.3).
                        const sBox: { value: DString | null } = { value: null };
                        const fromlen = e.numberOfCodeUnits(tynto, sBox);
                        // slice truthiness tests the POINTER (06 §2.8): null slice falsy.
                        if (sBox.value !== null)
                            error(e.loc, ds("%.*s"), sBox.value.length, sBox.value);
                        // D: cast(size_t) of a CT-known dim — index/length domain (09 §1.1)
                        const tolen = Number(toInteger(t.isTypeSArray()!.dim!));
                        if (tolen < fromlen)
                            return MATCH.nomatch;
                        if (tolen !== fromlen) {
                            // implicit length extending
                            return MATCH.convert;
                        }
                    }
                    if (!e.committed && isSomeChar(tynto)) {
                        return MATCH.exact;
                    }
                } else if (e.type!.ty === TY.Tarray) {
                    const tynto: TY = nextOf(t)!.ty;
                    if (isSomeChar(tynto)) {
                        if (e.committed && tynto !== tyn)
                            return MATCH.nomatch;
                        const sBox: { value: DString | null } = { value: null };
                        const fromlen = e.numberOfCodeUnits(tynto, sBox);
                        if (sBox.value !== null)
                            error(e.loc, ds("%.*s"), sBox.value.length, sBox.value);
                        const tolen = Number(toInteger(t.isTypeSArray()!.dim!));
                        if (tolen < fromlen)
                            return MATCH.nomatch;
                        if (tolen !== fromlen) {
                            // implicit length extending
                            return MATCH.convert;
                        }
                    }
                    if (tynto === tyn) {
                        return MATCH.exact;
                    }
                    if (!e.committed && isSomeChar(tynto)) {
                        return MATCH.exact;
                    }
                }
            // goto case; (dmd/dcast.d:774) -> fall through to the next case (06 §3.6(a))
            case TY.Tarray:
            case TY.Tpointer: {
                const tn = nextOf(t)!;
                let m: MATCH = MATCH.exact;
                if (nextOf(e.type!)!.mod !== tn.mod) {
                    // https://issues.dlang.org/show_bug.cgi?id=16183
                    if (!tn.isConst() && !tn.isImmutable())
                        return MATCH.nomatch;
                    m = MATCH.constant;

                    // After converting e.g. ubyte[] to const(ubyte)[], don't change to
                    // MATCH.convert, return MATCH.constant
                    // https://github.com/dlang/dmd/issues/20635
                    if (e.type!.ty === t.ty && nextOf(e.type!)!.ty === tn.ty)
                        return m;
                }
                if (e.type !== t && e.hexString && isIntegral(tn) &&
                    (size(tn) === BigInt(e.sz) || (!e.committed && BigInt(e.len) % size(tn) === 0n))) {
                    m = MATCH.convert;
                    return m;
                }
                if (!e.committed) {
                    switch (tn.ty) {
                        case TY.Tchar:
                            if (e.postfix === 0x77 /* 'w' */ || e.postfix === 0x64 /* 'd' */)
                                m = MATCH.convert;
                            return m;
                        case TY.Twchar:
                            if (e.postfix !== 0x77 /* 'w' */)
                                m = MATCH.convert;
                            return m;
                        case TY.Tdchar:
                            if (e.postfix !== 0x64 /* 'd' */)
                                m = MATCH.convert;
                            return m;
                        case TY.Tenum:
                            if (tn.isTypeEnum()!.sym!.isSpecial()) {
                                /* Allow string literal -> const(wchar_t)[] */
                                const tob = toBasetype(tn).isTypeBasic();
                                if (tob !== null)
                                    return implicitConvToType(tn, tob);
                            }
                            break;
                        default:
                            break;
                    }
                }
                break;
            }

            default:
                break;
        }

        return visit(e);
    };

    // dmd/dcast.d:835 — `MATCH visitArrayLiteral(ArrayLiteralExp e)`.
    const visitArrayLiteral = (e: ArrayLiteralExp): MATCH => {
        // resolved: version (none) printf block (dcast.d:837) -> OFF, dropped.
        const tb = toBasetype(t);
        const typeb = toBasetype(e.type!);

        let result: MATCH = MATCH.nomatch;
        if (tb.isStaticOrDynamicArray() && typeb.isStaticOrDynamicArray()) {
            result = MATCH.exact;
            const typen = toBasetype(nextOf(typeb)!);

            const tsa = tb.isTypeSArray();
            if (tsa !== null) {
                if (BigInt(e.elements!.length) !== toInteger(tsa.dim!))
                    result = MATCH.nomatch;
            }

            const telement = nextOf(tb)!;
            if (e.elements!.length === 0) {
                if (typen.ty !== TY.Tvoid)
                    result = implicitConvToType(typen, telement);
            } else {
                if (e.basis !== null) {
                    const m = implicitConvTo(e.basis, telement);
                    if (m < result)
                        result = m;
                }
                for (let i = 0; i < e.elements!.length; i++) {
                    const el = e.elements!.opIndex(i);
                    if (result === MATCH.nomatch)
                        break;
                    if (el === null)
                        continue;
                    const m = implicitConvTo(el, telement);
                    if (m < result)
                        result = m; // remember worst match
                }
            }

            if (result === MATCH.nomatch)
                result = implicitConvToType(e.type!, t);

            return result;
        } else if (tb.ty === TY.Tvector && (typeb.isStaticOrDynamicArray() || typeb.ty === TY.Tpointer)) {
            // Tpointer because ImportC eagerly converts Tsarray to Tpointer
            result = MATCH.exact;
            // Convert array literal to vector type
            const tv = tb.isTypeVector()!;
            const tbase = tv.basetype.isTypeSArray();
            assert(tbase !== null);
            const edim = e.elements!.length;
            const tbasedim = toInteger(tbase!.dim!);
            if (BigInt(edim) > tbasedim) {
                return MATCH.nomatch;
            }

            const telement: Type = tv.elementType();
            if (BigInt(edim) < tbasedim) {
                // D types `defaultInitLiteral`'s result `Expression` and reads it unchecked.
                const el = defaultInitLiteral(nextOf(typeb)!, e.loc)!;
                const m = implicitConvTo(el, telement);
                if (m < result)
                    result = m; // remember worst match
            }
            for (let i = 0; i < e.elements!.length; i++) {
                const el = e.elements!.opIndex(i);
                const m = implicitConvTo(el!, telement);
                if (m < result)
                    result = m; // remember worst match
                if (result === MATCH.nomatch)
                    break; // no need to check for worse
            }
            return result;
        }

        return visit(e);
    };

    // dmd/dcast.d:924 — `MATCH visitAssocArrayLiteral(AssocArrayLiteralExp e)`.
    const visitAssocArrayLiteral = (e: AssocArrayLiteralExp): MATCH => {
        const taa: TypeAArrayT | null = toBasetype(t).isTypeAArray();
        const typeb = toBasetype(e.type!);

        if (!(taa !== null && typeb.ty === TY.Taarray))
            return visit(e);

        let result: MATCH = MATCH.exact;
        for (let i = 0; i < e.keys!.length; i++) {
            let el = e.keys!.opIndex(i);
            let m = implicitConvTo(el!, taa.index!);
            if (m < result)
                result = m; // remember worst match
            if (result === MATCH.nomatch)
                break; // no need to check for worse
            el = e.values!.opIndex(i);
            m = implicitConvTo(el!, nextOf(taa)!);
            if (m < result)
                result = m; // remember worst match
            if (result === MATCH.nomatch)
                break; // no need to check for worse
        }
        return result;
    };

    // dmd/dcast.d:950 — `MATCH visitCall(CallExp e)`.
    const visitCall = (e: CallExp): MATCH => {
        // resolved: `enum LOG = false;` + static if (LOG) printf (dcast.d:938-953) -> dropped.
        // `auto result` is REASSIGNED at dmd/dcast.d:970/:972 -> `let` (D `auto`, not `const`).
        let result = visit(e);
        if (result !== MATCH.nomatch)
            return result;

        /* Allow the result of strongly pure functions to convert to immutable
         */
        {
            const ef: FuncDeclaration | null = e.f;
            // dmd/dcast.d:965-968 — the three-term `&&`, in D's own evaluation order; the third
            // term `e.f.isReturnIsolated()` is authorised at dmd/funcsem.d:3923
            // (`isReturnIsolated`). D's comment: check it last, it is potentially expensive.
            if (ef !== null && (!global.params.fixImmutableConv || isPure(ef) >= PURE.const_) &&
                isReturnIsolated(ef)) {
                result = implicitConvToType(immutableOf(e.type!), t);
                if (result > MATCH.constant) // Match level is MATCH.constant at best.
                    result = MATCH.constant;
                return result;
            }
        }

        /* Conversion is 'const' conversion if:
         * 1. function is pure (weakly pure is ok)
         * 2. implicit conversion only fails because of mod bits
         * 3. each function parameter can be implicitly converted to the mod bits
         */
        // 02 §11.4: `e.f` is re-read into a freshly-declared const with the field's declared type
        // (the wall above otherwise leaves it narrowed to `null`).
        const ef2: FuncDeclaration | null = e.f;
        const tf = toBasetype((ef2 !== null ? ef2.type! : e.e1!.type!)).isTypeFunction();
        if (tf === null)
            return result;

        if (tf.purity === PURE.impure)
            return result;
        if (ef2 !== null && ef2.isNested())
            return result;

        /* See if fail only because of mod bits. https://issues.dlang.org/show_bug.cgi?id=14155
         * All pure functions can access global immutable data, so the returned pointer may refer to
         * immutable global data, and then a pointer to non-mutable data cannot be a unique pointer.
         */
        if (implicitConvToType(immutableOf(e.type!), t) < MATCH.constant &&
            implicitConvToType(addMod(e.type!, MODFlags.shared_), t) < MATCH.constant &&
            implicitConvToType(e.type!, addMod(t, MODFlags.shared_)) < MATCH.constant) {
            return result;
        }
        // Allow a conversion to immutable type, or conversions of mutable types between
        // thread-local and shared.

        /* Get mod bits of what we're converting to
         */
        const tb = toBasetype(t);
        let mod: MOD = tb.mod;
        if (tf.isRef) {
            // (empty in D)
        } else {
            // dmd/dcast.d:1023 — `if (Type ti = getIndirection(t)) mod = ti.mod;`; callee
            // authorised at dmd/typesem.d:2882 (`getIndirection`).
            const ti = getIndirection(t);
            if (ti !== null)
                mod = ti.mod;
        }
        // resolved: static if (LOG) printf(...) -> OFF, dropped (dcast.d:1026).
        if ((mod & MODFlags.wild) !== 0)
            return result; // not sure what to do with this

        /* Apply mod bits to each function parameter, and see if we can convert the function
         * argument to the modded type
         */
        const dve = e.e1!.isDotVarExp();
        if (dve !== null) {
            /* Treat 'this' as just another function argument
             */
            // dmd/dcast.d:1041 — `targ.constConv(targ.castMod(mod))`; callees authorised at
            // dmd/typesem.d:3054 (`constConv`) and dmd/typesem.d:8879 (`castMod`).
            const targ = dve.e1!.type!;
            if (constConv(targ, castMod(targ, mod)) === MATCH.nomatch)
                return result;
        }

        if (!parametersModMatch(e.arguments_, tf, mod))
            return result;

        /* Success
         */
        return MATCH.constant;
    };

    // dmd/dcast.d:1053 — `MATCH visitAddr(AddrExp e)`.
    const visitAddr = (e: AddrExpT): MATCH => {
        // resolved: version (none) printf block (dcast.d:1055) -> OFF, dropped.
        let result = implicitConvToType(e.type!, t);
        // dropped: //printf trace (dcast.d:1060)

        if (result !== MATCH.nomatch)
            return result;

        const tb = toBasetype(t);
        const typeb = toBasetype(e.type!);

        // Look for pointers to functions where the functions are overloaded.
        if (e.e1!.op === EXP.overloadSet &&
            (tb.ty === TY.Tpointer || tb.ty === TY.Tdelegate) && nextOf(tb)!.ty === TY.Tfunction) {
            const eo: OverExp = e.e1!.isOverExp()!;
            let f: FuncDeclaration | null = null;
            for (const s of eo.vars!.a) {
                const f2 = s!.isFuncDeclaration();
                assert(f2 !== null);
                if (overloadExactMatch(f2!, nextOf(tb)!) !== null) {
                    if (f !== null) {
                        /* Error if match in more than one overload set,
                         * even if one is a 'better' match than the other.
                         */
                        ScopeDsymbol.multiplyDefined(e.loc, f, f2!);
                    } else
                        f = f2;
                    result = MATCH.exact;
                }
            }
        }

        if (e.e1!.op === EXP.variable &&
            typeb.ty === TY.Tpointer && nextOf(typeb)!.ty === TY.Tfunction &&
            tb.ty === TY.Tpointer && nextOf(tb)!.ty === TY.Tfunction) {
            /* I don't think this can ever happen - it should have been converted to a SymOffExp. */
            assertUnreachable(); // D: assert(0) (dcast.d:1102)
        }

        // dropped: //printf trace (dcast.d:1105)
        return result;
    };

    // dmd/dcast.d:1109 — `MATCH visitSymOff(SymOffExp e)`.
    const visitSymOff = (e: SymOffExpT): MATCH => {
        // resolved: version (none) printf block (dcast.d:1111) -> OFF, dropped.
        let result = implicitConvToType(e.type!, t);
        // dropped: //printf trace (dcast.d:1116)
        if (result !== MATCH.nomatch)
            return result;

        const tb = toBasetype(t);
        const typeb = toBasetype(e.type!);

        // Look for pointers to functions where the functions are overloaded.
        if (typeb.ty === TY.Tpointer && nextOf(typeb)!.ty === TY.Tfunction &&
            (tb.ty === TY.Tpointer || tb.ty === TY.Tdelegate) && nextOf(tb)!.ty === TY.Tfunction) {
            let f = e.var_!.isFuncDeclaration();
            if (f !== null) {
                f = overloadExactMatch(f, nextOf(tb)!);
                if (f !== null) {
                    if ((tb.ty === TY.Tdelegate && (f.needThis() || f.isNested())) ||
                        (tb.ty === TY.Tpointer && !(f.needThis() || f.isNested()))) {
                        result = MATCH.exact;
                    }
                }
            }
        }
        // dropped: //printf trace (dcast.d:1139)
        return result;
    };

    // dmd/dcast.d:1144 — `MATCH visitDelegate(DelegateExp e)`.
    const visitDelegate = (e: DelegateExpT): MATCH => {
        // resolved: version (none) printf block (dcast.d:1146) -> OFF, dropped.
        // `auto result` is REASSIGNED at dmd/dcast.d:1161 -> `let` (D `auto`, not `const`).
        let result = implicitConvToType(e.type!, t);
        if (result !== MATCH.nomatch)
            return result;

        const tb = toBasetype(t);
        const typeb = toBasetype(e.type!);

        // Look for pointers to functions where the functions are overloaded.
        if (typeb.ty === TY.Tdelegate && tb.ty === TY.Tdelegate) {
            if (e.func !== null) {
                // dmd/dcast.d:1160 — `e.func.overloadExactMatch(tb.nextOf())`; callee authorised
                // at dmd/funcsem.d:2444 (`overloadExactMatch`).
                if (overloadExactMatch(e.func, nextOf(tb)!) !== null)
                    result = MATCH.exact;
            }
        }
        return result;
    };

    // dmd/dcast.d:1166 — `MATCH visitFunc(FuncExp e)`.
    const visitFunc = (e: FuncExp): MATCH => {
        // dropped: //printf trace (dcast.d:1167)
        const m = matchType(e, t, null, null, global.errorSinkNull!);
        if (m > MATCH.nomatch) {
            return m;
        }
        return visit(e);
    };

    // dmd/dcast.d:1177 — `MATCH visitAnd(AndExp e)`.
    const visitAnd = (e: AndExpT): MATCH => {
        const result = visit(e);
        if (result !== MATCH.nomatch)
            return result;

        const m1 = implicitConvTo(e.e1!, t);
        const m2 = implicitConvTo(e.e2!, t);

        // Pick the worst match
        return m1 < m2 ? m1 : m2;
    };

    // dmd/dcast.d:1190 — `MATCH visitOr(OrExp e)`.
    const visitOr = (e: OrExpT): MATCH => {
        const result = visit(e);
        if (result !== MATCH.nomatch)
            return result;

        const m1 = implicitConvTo(e.e1!, t);
        const m2 = implicitConvTo(e.e2!, t);

        // Pick the worst match
        return m1 < m2 ? m1 : m2;
    };

    // dmd/dcast.d:1203 — `MATCH visitXor(XorExp e)`.
    const visitXor = (e: XorExpT): MATCH => {
        const result = visit(e);
        if (result !== MATCH.nomatch)
            return result;

        const m1 = implicitConvTo(e.e1!, t);
        const m2 = implicitConvTo(e.e2!, t);

        // Pick the worst match
        return m1 < m2 ? m1 : m2;
    };

    // dmd/dcast.d:1216 — `MATCH visitCond(CondExp e)`.
    const visitCond = (e: CondExp): MATCH => {
        e.econd = optimize(e.econd!, WANTvalue);
        const opt = toBool(e.econd!);
        if (opt.isPresent()) {
            const result = visit(e);
            if (result !== MATCH.nomatch)
                return result;
        }

        const m1 = implicitConvTo(e.e1!, t);
        const m2 = implicitConvTo(e.e2!, t);
        // dropped: //printf trace (dcast.d:1227)

        // Pick the worst match
        return m1 < m2 ? m1 : m2;
    };

    // dmd/dcast.d:1235 — `MATCH visitComma(CommaExp e)`.
    const visitComma = (e: CommaExp): MATCH => {
        return implicitConvTo(e.e2!, t);
    };

    // dmd/dcast.d:1240 — `MATCH visitCast(CastExp e)`.
    const visitCast = (e: CastExpT): MATCH => {
        // resolved: version (none) printf block (dcast.d:1242) -> OFF, dropped.
        let result = implicitConvToType(e.type!, t);
        if (result !== MATCH.nomatch)
            return result;

        if (isIntegral(t) && isIntegral(e.e1!.type!) && implicitConvTo(e.e1!, t) !== MATCH.nomatch)
            result = MATCH.convert;
        else
            result = visit(e);
        return result;
    };

    // dmd/dcast.d:1257 — `MATCH visitNew(NewExp e)`.
    const visitNew = (e: NewExp): MATCH => {
        // resolved: version (none) printf block (dcast.d:1259) -> OFF, dropped.
        const result = visit(e);
        if (result !== MATCH.nomatch)
            return result;

        /* Calling new() is like calling a pure function. We can implicitly convert the return from
         * new() to t using the same algorithm as in CallExp, with the function 'arguments' being:
         *    thisexp / arguments / .init ; 'member' needs to be pure.
         */

        /* See if fail only because of mod bits */
        if (implicitConvToType(immutableOf(e.type!), immutableOf(t)) === MATCH.nomatch)
            return MATCH.nomatch;

        /* Get mod bits of what we're converting to */
        const tb = toBasetype(t);
        let mod: MOD = tb.mod;
        const ti = getIndirection(t);
        if (ti !== null)
            mod = ti.mod;
        // resolved: static if (LOG) printf(...) -> OFF, dropped (dcast.d:1287).
        if ((mod & MODFlags.wild) !== 0)
            return MATCH.nomatch; // not sure what to do with this

        /* Apply mod bits to each argument,
         * and see if we can convert the argument to the modded type
         */

        if (e.thisexp !== null) {
            /* Treat 'this' as just another function argument
             */
            const targ = e.thisexp.type!;
            if (constConv(targ, castMod(targ, mod)) === MATCH.nomatch)
                return MATCH.nomatch;
        }

        /* Check call to 'member'
         */
        if (e.member !== null) {
            const fd: FuncDeclaration = e.member;
            if (fd.errors || fd.type!.ty !== TY.Tfunction)
                return MATCH.nomatch; // error
            const tf: TypeFunction = fd.type!.isTypeFunction()!;
            if (tf.purity === PURE.impure)
                return MATCH.nomatch; // impure

            // Allow a conversion to immutable type, or
            // conversions of mutable types between thread-local and shared.
            if (implicitConvToType(immutableOf(e.type!), t) < MATCH.constant &&
                implicitConvToType(addMod(e.type!, MODFlags.shared_), t) < MATCH.constant &&
                implicitConvToType(e.type!, addMod(t, MODFlags.shared_)) < MATCH.constant) {
                return MATCH.nomatch;
            }

            if (!parametersModMatch(e.arguments_, tf, mod)) {
                return MATCH.nomatch;
            }
        }

        /* If no 'member', then construction is by simple assignment,
         * and just straight check 'arguments'
         */
        if (e.member === null && e.arguments_ !== null) {
            for (let i = 0; i < e.arguments_.length; ++i) {
                const earg = e.arguments_.opIndex(i);
                if (earg === null) // https://issues.dlang.org/show_bug.cgi?id=14853
                                   // if it's on overlapped field
                    continue;
                const targ = toBasetype(earg.type!);
                // resolved: static if (LOG) printf(...) -> OFF, dropped (dcast.d:1343).
                if (implicitMod(earg, targ, mod) === MATCH.nomatch)
                    return MATCH.nomatch;
            }
        }

        /* Consider the .init expression as an argument
         */
        let ntb = toBasetype(e.newtype!);
        if (ntb.ty === TY.Tarray)
            ntb = toBasetype(nextOf(ntb)!);
        const ts = ntb.isTypeStruct();
        if (ts !== null) {
            // Don't allow nested structs - uplevel reference may not be convertible
            const sd: StructDeclaration = ts.sym!;
            // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool)
            sizeDsymbol(sd as unknown as Dsymbol, e.loc); // resolve any forward references
            if (sd.isNested())
                return MATCH.nomatch;
        }
        if (!isZeroInit(ntb, e.loc)) {
            // D types `defaultInitLiteral`'s result `Expression` and reads it unchecked.
            const earg = defaultInitLiteral(e.newtype!, e.loc)!;
            const targ = toBasetype(e.newtype!);

            if (implicitMod(earg, targ, mod) === MATCH.nomatch)
                return MATCH.nomatch;
            return MATCH.constant;
        }
        /* Zeros are implicitly convertible, except for special cases.
         */
        const tc = ntb.isTypeClass();
        if (tc === null)
            return MATCH.constant;

        /* With new() must look at the class instance initializer.
         */
        const cd: ClassDeclaration = tc.sym!;

        // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool)
        sizeDsymbol(cd as unknown as Dsymbol, e.loc); // resolve any forward references

        if (cd.isNested())
            return MATCH.nomatch; // uplevel reference may not be convertible

        assert(cd.isInterfaceDeclaration() === null);

        // dmd/dcast.d:1392 — `static bool convertible(Expression e, ClassDeclaration cd, MOD mod)`.
        const convertible = (e: Expression, cd: ClassDeclaration, mod: MOD): boolean => {
            for (let i = 0; i < cd.fields.length; i++) {
                const v: VarDeclaration = cd.fields.opIndex(i)!;
                const _init = v._init;
                if (_init !== null) {
                    if (_init.isVoidInitializer() !== null) {
                        // (empty in D)
                    } else {
                        const ei = _init.isExpInitializer();
                        if (ei !== null) {
                            // https://issues.dlang.org/show_bug.cgi?id=21319
                            // This is to prevent re-analyzing the same expression
                            // over and over again.
                            if (ei.exp === e)
                                return false;
                            const tb = toBasetype(v.type!);
                            if (implicitMod(ei.exp!, tb, mod) === MATCH.nomatch)
                                return false;
                        } else {
                            /* Enhancement: handle StructInitializer and ArrayInitializer
                             */
                            return false;
                        }
                    }
                } else if (!isZeroInit(v.type!, e.loc))
                    return false;
            }
            return cd.baseClass !== null ? convertible(e, cd.baseClass, mod) : true;
        };

        if (!convertible(e, cd, mod))
            return MATCH.nomatch;

        /* Success
         */
        return MATCH.constant;
    };

    // dmd/dcast.d:1435 — `MATCH visitSlice(SliceExp e)`.
    const visitSlice = (e: SliceExp): MATCH => {
        // dropped: //printf trace (dcast.d:1410)
        let result = visit(e);
        if (result !== MATCH.nomatch)
            return result;

        const tb = toBasetype(t);
        let typeb = toBasetype(e.type!);

        if (tb.ty === TY.Tsarray && typeb.ty === TY.Tarray) {
            const sat = toStaticArrayType(e);
            if (sat !== null) {
                // Try: T[] -> T[dim] (slice with compile-time known boundaries to static array)
                result = implicitConvToType(sat, t);
                if (result > MATCH.convert)
                    result = MATCH.convert; // match with implicit conversion at most
            }
            return result;
        }

        /* If the only reason it won't convert is because of the mod bits, then test for conversion
         * by seeing if e1 can be converted with those same mod bits.
         */
        const t1b = toBasetype(e.e1!.type!);
        if (tb.ty === TY.Tarray && equivalent(typeb, tb)) {
            const tbn = nextOf(tb)!;
            let tx: Type | null = null;

            /* If e.e1 is dynamic array or pointer, the uniqueness of e.e1
             * is equivalent with the uniqueness of the referred data. And in here
             * we can have arbitrary typed reference for that.
             */
            if (t1b.ty === TY.Tarray)
                tx = arrayOf(tbn);
            if (t1b.ty === TY.Tpointer)
                tx = pointerTo(tbn);

            /* If e.e1 is static array, at least it should be an rvalue.
             * If not, e.e1 is a reference, and its uniqueness does not link
             * to the uniqueness of the referred data.
             */
            // ZERO DIVISOR (09 §3.1): a zero-size element (`int[0]`, `noreturn`) makes `tbn.size()` 0. This is a
            // match query that overload resolution runs ungagged on every candidate, not constant folding, so the
            // "divide by 0" error does not apply here: an error would reject overload sets ldc2 resolves. ldc2's
            // own division is arm64 `udiv`, whose quotient is 0, and the port takes that quotient, so the query
            // answers as ldc2's does.
            if (t1b.ty === TY.Tsarray && !isLvalue(e.e1!)) {
                const dividend = size(t1b); // D evaluates `t1b.size()` before `tbn.size()`
                const divisor = size(tbn);
                tx = sarrayOf(tbn, divisor === 0n ? 0n : dividend / divisor);
            }

            if (tx !== null) {
                result = implicitConvTo(e.e1!, tx);
                if (result > MATCH.constant) // Match level is MATCH.constant at best.
                    result = MATCH.constant;
            }
        }

        // Enhancement 10724
        if (tb.ty === TY.Tpointer && e.e1!.op === EXP.string_)
            result = implicitConvTo(e.e1!, t);
        return result;
    };

    // dmd/dcast.d:1499 — `MATCH visitTuple(TupleExp e)`.
    const visitTuple = (e: TupleExp): MATCH => {
        let result = implicitConvToType(e.type!, t);
        if (result !== MATCH.nomatch)
            return result;

        /* If target type is a tuple of same length, test conversion of each expression to the
         * corresponding type in the tuple.
         */
        const totuple: TypeTuple | null = t.isTypeTuple();
        if (totuple !== null && e.exps!.length === totuple.arguments!.length) {
            result = MATCH.exact;
            for (let i = 0; i < e.exps!.length; i++) {
                const ex = e.exps!.opIndex(i);
                const to = totuple.arguments!.opIndex(i)!.type!;
                const mi = implicitConvTo(ex!, to);
                if (mi < result)
                    result = mi;
            }
        }
        return result;
    };

    // dmd/dcast.d:1500 — the trailing dispatch switch (13 §7.5 rule 1), emitted IN FULL.
    switch (e.op) {
        default: return visit(e);
        case EXP.add: return visitAdd(e.isAddExp()!);
        case EXP.min: return visitMin(e.isMinExp()!);
        case EXP.int64: return visitInteger(e.isIntegerExp()!);
        case EXP.error: return visitError(e.isErrorExp()!);
        case EXP.null_: return visitNull(e.isNullExp()!);
        case EXP.structLiteral: return visitStructLiteral(e.isStructLiteralExp()!);
        case EXP.string_: return visitString(e.isStringExp()!);
        case EXP.arrayLiteral: return visitArrayLiteral(e.isArrayLiteralExp()!);
        case EXP.assocArrayLiteral: return visitAssocArrayLiteral(e.isAssocArrayLiteralExp()!);
        case EXP.call: return visitCall(e.isCallExp()!);
        case EXP.address: return visitAddr(e.isAddrExp()!);
        case EXP.symbolOffset: return visitSymOff(e.isSymOffExp()!);
        case EXP.delegate_: return visitDelegate(e.isDelegateExp()!);
        case EXP.function_: return visitFunc(e.isFuncExp()!);
        case EXP.and: return visitAnd(e.isAndExp()!);
        case EXP.or: return visitOr(e.isOrExp()!);
        case EXP.xor: return visitXor(e.isXorExp()!);
        case EXP.question: return visitCond(e.isCondExp()!);
        case EXP.comma: return visitComma(e.isCommaExp()!);
        case EXP.cast_: return visitCast(e.isCastExp()!);
        case EXP.new_: return visitNew(e.isNewExp()!);
        case EXP.slice: return visitSlice(e.isSliceExp()!);
        case EXP.tuple: return visitTuple(e.isTupleExp()!);
    }
}

/**
 * dmd/dcast.d:1558 — `MATCH implicitConvTo(Type from, Type to)`.
 *
 * Determine if `from` can be implicitly converted to type `to`.
 * Returns: `MATCH.nomatch`, `MATCH.convert`, `MATCH.constant` or `MATCH.exact`.
 *
 * Overload set (04 §1B): the **Type**-receiver member of D's `implicitConvTo` pair. The bare name
 * belongs to the Expression form above, so this one carries the receiver-type suffix (04 §6.1).
 *
 * IDIOM B (13 §7.5): nested `visitType` + 13 specializations + `implicitPointerConv` helper + the
 * trailing dispatch switch on `from.ty`, emitted IN FULL.
 */
export function implicitConvToType(from: Type, to: Type): MATCH {
    // dmd/dcast.d:1560 — `MATCH visitType(Type from)`, the base arm.
    const visitType = (from: Type): MATCH => {
        // dropped: three //printf traces (dcast.d:1562-1564)
        if (from.equals(to))
            return MATCH.exact;
        return MATCH.nomatch;
    };

    // dmd/dcast.d:1571 — `MATCH visitBasic(TypeBasic from)`.
    const visitBasic = (from: TypeBasic): MATCH => {
        // dropped: //printf trace (dcast.d:1573)
        if (from === to)
            return MATCH.exact;

        if (from.ty === to.ty) {
            if (from.mod === to.mod)
                return MATCH.exact;
            if (MODimplicitConv(from.mod, to.mod))
                return MATCH.constant;
            if (((from.mod ^ to.mod) & MODFlags.shared_) === 0) // for wild matching
                return MATCH.constant;
            return MATCH.convert;
        }

        if (from.ty === TY.Tvoid || to.ty === TY.Tvoid)
            return MATCH.nomatch;
        if (to.ty === TY.Tbool)
            return MATCH.nomatch;

        let tob: TypeBasic | null;
        if (to.ty === TY.Tvector && to.deco !== null) {
            // D: `cast(TypeVector)to` — the `to.ty == Tvector` test above is the tag proof
            // (02 §11.5c #3); the tree spells the tag-proved downcast as `isTypeVector()`.
            const tv = to.isTypeVector()!;
            tob = tv.elementType();
        } else {
            const te = to.isTypeEnum();
            if (te !== null) {
                const ed = te.sym!;
                if (ed.isSpecial()) {
                    /* Special enums that allow implicit conversions to them with a MATCH.convert */
                    tob = toBasetype(to).isTypeBasic();
                } else
                    return MATCH.nomatch;
            } else
                tob = to.isTypeBasic();
        }
        if (tob === null)
            return MATCH.nomatch;

        if ((from.flags & TFlags.integral) !== 0) {
            // Disallow implicit conversion of integers to imaginary or complex
            if ((tob.flags & (TFlags.imaginary | TFlags.complex)) !== 0)
                return MATCH.nomatch;

            // If converting from integral to integral
            if ((tob.flags & TFlags.integral) !== 0) {
                // dmd/dcast.d:1626 — the typesem.d free `size` (typesem.d:2901).
                const sz = size(from, Loc.initial);
                const tosz = size(tob, Loc.initial);

                /* Can't convert to smaller size */
                if (sz > tosz)
                    return MATCH.nomatch;
                /* Can't change sign if same size — the D check is commented out upstream (dcast.d:1634) */
            }
        } else if ((from.flags & TFlags.floating) !== 0) {
            // Disallow implicit conversion of floating point to integer
            if ((tob.flags & TFlags.integral) !== 0)
                return MATCH.nomatch;

            assert((tob.flags & TFlags.floating) !== 0 || to.ty === TY.Tvector);

            // Disallow implicit conversion from complex to non-complex
            if ((from.flags & TFlags.complex) !== 0 && (tob.flags & TFlags.complex) === 0)
                return MATCH.nomatch;

            // Disallow implicit conversion of real or imaginary to complex
            if ((from.flags & (TFlags.real_ | TFlags.imaginary)) !== 0 && (tob.flags & TFlags.complex) !== 0)
                return MATCH.nomatch;

            // Disallow implicit conversion to-from real and imaginary
            if ((from.flags & (TFlags.real_ | TFlags.imaginary)) !== (tob.flags & (TFlags.real_ | TFlags.imaginary)))
                return MATCH.nomatch;
        }
        return MATCH.convert;
    };

    // dmd/dcast.d:1663 — `MATCH visitVector(TypeVector from)`.
    const visitVector = (from: TypeVector): MATCH => {
        // dropped: //printf trace (dcast.d:1662)
        if (from === to)
            return MATCH.exact;
        if (to.ty !== TY.Tvector)
            return MATCH.nomatch;

        // D: `cast(TypeVector)to` — guarded by the `to.ty != Tvector` early-out above.
        const tv = to.isTypeVector()!;
        assert(from.basetype.ty === TY.Tsarray && tv.basetype.ty === TY.Tsarray);

        // Can't convert to a vector which has different size.
        if (size(from.basetype) !== size(tv.basetype))
            return MATCH.nomatch;

        // Allow conversion to void[]
        if (nextOf(tv.basetype)!.ty === TY.Tvoid)
            return MATCH.convert;

        // Otherwise implicitly convertible only if basetypes are.
        return implicitConvToType(from.basetype, tv.basetype);
    };

    // dmd/dcast.d:1686 — `MATCH visitSArray(TypeSArray from)`.
    const visitSArray = (from: TypeSArray): MATCH => {
        // dropped: //printf trace (dcast.d:1685)
        const ta = to.isTypeDArray();
        if (ta !== null) {
            if (!MODimplicitConv(from.next!.mod, ta.next!.mod))
                return MATCH.nomatch;

            /* Allow conversion to void[] */
            if (ta.next!.ty === TY.Tvoid) {
                return MATCH.convert;
            }

            // dmd/dcast.d:1701 — `from.next.constConv(ta.next)`; callee authorised at
            // dmd/typesem.d:3054 (`constConv`).
            const m = constConv(from.next!, ta.next!);
            if (m > MATCH.nomatch) {
                return MATCH.convert;
            }
            return MATCH.nomatch;
        }
        const tsa = to.isTypeSArray();
        if (tsa === null)
            return MATCH.nomatch;

        if (from === to)
            return MATCH.exact;

        // dmd/dcast.d:1715 — `from.dim.equals(tsa.dim)` is UFCS onto the free function
        // `equals(Expression, Expression)`; callee authorised at dmd/expressionsem.d:919.
        if (!equals(from.dim!, tsa.dim!))
            return MATCH.nomatch;

        let m = implicitConvToType(from.next!, tsa.next!);

        /* Allow conversion to non-interface base class. */
        if (m === MATCH.convert && from.next!.ty === TY.Tclass) {
            const toc = tsa.next!.isTypeClass();
            if (toc !== null) {
                if (toc.sym!.isInterfaceDeclaration() === null)
                    return MATCH.convert;
            }
        }

        /* Since static arrays are value types, allow conversions from const elements to
         * non-const ones, just like we allow conversion from const int to int.
         */
        if (m >= MATCH.constant) {
            if (from.mod !== to.mod)
                m = MATCH.constant;
            return m;
        }

        return MATCH.nomatch;
    };

    // dmd/dcast.d:1747 — `MATCH visitDArray(TypeDArray from)`.
    const visitDArray = (from: TypeDArray): MATCH => {
        // dropped: //printf trace (dcast.d:1742)
        if (from.equals(to))
            return MATCH.exact;

        const ta = to.isTypeDArray();
        if (ta === null)
            return visitType(from);

        if (!MODimplicitConv(from.next!.mod, ta.next!.mod))
            return MATCH.nomatch; // not const-compatible

        /* Allow conversion to void[] */
        if (from.next!.ty !== TY.Tvoid && ta.next!.ty === TY.Tvoid) {
            return MATCH.convert;
        }

        // dmd/dcast.d:1767 — `from.next.constConv(ta.next)`; callee authorised at
        // dmd/typesem.d:3054 (`constConv`).
        let m = constConv(from.next!, ta.next!);
        if (m > MATCH.nomatch) {
            if (m === MATCH.exact && from.mod !== to.mod)
                m = MATCH.constant;
            return m;
        }

        return visitType(from);
    };

    // dmd/dcast.d:1778 — `MATCH visitAArray(TypeAArray from)`.
    const visitAArray = (from: TypeAArray): MATCH => {
        // dropped: //printf trace (dcast.d:1774)
        if (from.equals(to))
            return MATCH.exact;

        const ta = to.isTypeAArray();
        if (ta === null)
            return visitType(from);

        if (!MODimplicitConv(from.next!.mod, ta.next!.mod))
            return MATCH.nomatch; // not const-compatible

        if (!MODimplicitConv(from.index!.mod, ta.index!.mod))
            return MATCH.nomatch; // not const-compatible

        // dmd/dcast.d:1794 — `from.next.constConv(ta.next)` / `from.index.constConv(ta.index)`;
        // callee authorised at dmd/typesem.d:3054 (`constConv`).
        const m = constConv(from.next!, ta.next!);
        const mi = constConv(from.index!, ta.index!);
        if (m > MATCH.nomatch && mi > MATCH.nomatch) {
            return MODimplicitConv(from.mod, to.mod) ? MATCH.constant : MATCH.nomatch;
        }

        return visitType(from);
    };

    /**
     * dmd/dcast.d:1816 — `MATCH implicitPointerConv(TypeFunction tf, Type to)`.
     * Checks whether this function type is convertible to `to` when used in a function pointer /
     * delegate. Returns nomatch (not covariant), convert (covariant) or constant (identical).
     */
    const implicitPointerConv = (tf: TypeFunction, to: Type): MATCH => {
        assert(to !== null);

        if (tf.equals(to))
            return MATCH.constant;

        // dmd/dcast.d:1823 — `tf.covariant(to)`; callee authorised at dmd/typesem.d:8044
        // (`covariant`), whose default arguments match D's (`pstc = null`, `cppCovariant = false`).
        if (covariant(tf, to) !== Covariant.yes)
            return MATCH.nomatch;

        const tret = nextOf(tf)!;
        const toret = nextOf(to)!;
        if (tret.ty === TY.Tclass && toret.ty === TY.Tclass) {
            /* https://issues.dlang.org/show_bug.cgi?id=10219
             * Check covariant interface return with offset tweaking.
             * interface I {}
             * class C : Object, I {}
             * I function() dg = function C() {}    // should be error
             */
            const offset: Ref<number> = { value: 0 };
            if (isBaseOf(toret, tret, offset) && offset.value !== 0)
                return MATCH.nomatch;
        }
        return MATCH.convert;
    };

    // dmd/dcast.d:1843 — `MATCH visitPointer(TypePointer from)`.
    const visitPointer = (from: TypePointer): MATCH => {
        // dropped: //printf trace (dcast.d:1839)
        if (from.equals(to))
            return MATCH.exact;

        // Only convert between pointers
        const tp = to.isTypePointer();
        if (tp === null)
            return MATCH.nomatch;

        assert(nextOf(from) !== null);
        assert(tp.next !== null);

        // Conversion to void*
        if (tp.next!.ty === TY.Tvoid) {
            // Function pointer conversion doesn't check constness?
            if (nextOf(from)!.ty === TY.Tfunction)
                return MATCH.convert;

            if (!MODimplicitConv(nextOf(from)!.mod, tp.next!.mod))
                return MATCH.nomatch; // not const-compatible

            return nextOf(from)!.ty === TY.Tvoid ? MATCH.constant : MATCH.convert;
        }

        // Conversion between function pointers
        const thisTf = nextOf(from)!.isTypeFunction();
        if (thisTf !== null)
            return implicitPointerConv(thisTf, tp.next!);

        // Default, no implicit conversion between the pointer targets
        // dmd/dcast.d:1875 — `from.next.constConv(tp.next)`; callee authorised at
        // dmd/typesem.d:3054 (`constConv`).
        let m = constConv(from.next!, tp.next!);

        if (m === MATCH.exact && from.mod !== to.mod)
            m = MATCH.constant;
        return m;
    };

    // dmd/dcast.d:1882 — `MATCH visitDelegate(TypeDelegate from)`.
    const visitDelegate = (from: TypeDelegate): MATCH => {
        // dropped: three //printf traces (dcast.d:1877-1879)
        if (from.equals(to))
            return MATCH.exact;

        const toDg = to.isTypeDelegate();
        if (toDg === null)
            return MATCH.nomatch;

        const m = implicitPointerConv(from.next!.isTypeFunction()!, toDg.next!);

        // Retain the old behaviour for this refactoring.
        // Should probably be changed to constant to match function pointers.
        if (m > MATCH.convert)
            return MATCH.convert;
        return m;
    };

    // dmd/dcast.d:1903 — `MATCH visitStruct(TypeStruct from)`.
    const visitStruct = (from: TypeStruct): MATCH => {
        // dropped: //printf trace (dcast.d:1905)
        // The receiver-split Form B names of typesem.d:9225/:9302 (typesem.ts).
        const m = implicitConvToWithoutAliasThisStruct(from, to);
        return m === MATCH.nomatch ? implicitConvToThroughAliasThisStruct(from, to) : m;
    };

    // dmd/dcast.d:1910 — `MATCH visitEnum(TypeEnum from)`.
    const visitEnum = (from: TypeEnum): MATCH => {
        // dmd/dcast.d:1904 — function-local selective import `import dmd.enumsem : getMemtype;`.
        let m: MATCH;
        // dropped: //printf trace (dcast.d:1907)
        if (from.ty === to.ty && from.sym === to.isTypeEnum()!.sym)
            m = from.mod === to.mod ? MATCH.exact : MATCH.constant;
        // dmd/dcast.d:1918 — `from.sym.getMemtype(Loc.initial).implicitConvTo(to)`; callee
        // authorised at dmd/enumsem.d:309 (`getMemtype`).
        else if (implicitConvToType(getMemtype(from.sym!, Loc.initial), to))
            m = MATCH.convert; // match with conversions
        else
            m = MATCH.nomatch; // no match
        return m;
    };

    // dmd/dcast.d:1925 — `MATCH visitClass(TypeClass from)`.
    const visitClass = (from: TypeClass): MATCH => {
        // dropped: //printf trace (dcast.d:1927)
        // The receiver-split Form B names of typesem.d:9272/:9287 (typesem.ts).
        const m = implicitConvToWithoutAliasThisClass(from, to);
        return m !== MATCH.nomatch ? m : implicitConvToThroughAliasThisClass(from, to);
    };

    // dmd/dcast.d:1932 — `MATCH visitTuple(TypeTuple from)`.
    const visitTuple = (from: TypeTuple): MATCH => {
        if (from === to)
            return MATCH.exact;
        const tt = to.isTypeTuple();
        if (tt === null)
            return MATCH.nomatch;

        if (from.arguments!.length !== tt.arguments!.length)
            return MATCH.nomatch;

        let m: MATCH = MATCH.exact;
        for (let i = 0; i < tt.arguments!.length; i++) {
            const arg1: Parameter = from.arguments!.opIndex(i)!;
            const arg2: Parameter = tt.arguments!.opIndex(i)!;
            const mi = implicitConvToType(arg1.type!, arg2.type!);
            if (mi < m)
                m = mi;
        }
        return m;
    };

    // dmd/dcast.d:1955 — `MATCH visitNull(TypeNull from)`.
    const visitNull = (from: TypeNull): MATCH => {
        // dropped: three //printf traces (dcast.d:1955-1957)
        const m = visitType(from);
        if (m !== MATCH.nomatch)
            return m;

        // NULL implicitly converts to any pointer type or dynamic array
        // (D keeps the `//if (type.ty == Tpointer && ...)` guard commented out, dcast.d:1963)
        {
            const tb = toBasetype(to);
            if (tb.ty === TY.Tnull || tb.ty === TY.Tpointer || tb.ty === TY.Tarray ||
                tb.ty === TY.Taarray || tb.ty === TY.Tclass || tb.ty === TY.Tdelegate)
                return MATCH.constant;
        }

        return MATCH.nomatch;
    };

    // dmd/dcast.d:1975 — `MATCH visitNoreturn(TypeNoreturn from)`.
    const visitNoreturn = (from: TypeNoreturn): MATCH => {
        // dropped: three //printf traces (dcast.d:1975-1977)
        if (from.equals(to))
            return MATCH.exact;

        // Different qualifiers?
        if (to.ty === TY.Tnoreturn)
            return MATCH.constant;

        // Implicitly convertible to any type
        return MATCH.convert;
    };

    // dmd/dcast.d:1989 — the trailing dispatch switch on `from.ty` (13 §7.5 rule 1), IN FULL.
    switch (from.ty) {
        default: return from.isTypeBasic() !== null ? visitBasic(from.isTypeBasic()!) : visitType(from);
        case TY.Tvector: return visitVector(from.isTypeVector()!);
        case TY.Tsarray: return visitSArray(from.isTypeSArray()!);
        case TY.Tarray: return visitDArray(from.isTypeDArray()!);
        case TY.Taarray: return visitAArray(from.isTypeAArray()!);
        case TY.Tpointer: return visitPointer(from.isTypePointer()!);
        case TY.Tdelegate: return visitDelegate(from.isTypeDelegate()!);
        case TY.Tstruct: return visitStruct(from.isTypeStruct()!);
        case TY.Tenum: return visitEnum(from.isTypeEnum()!);
        case TY.Tclass: return visitClass(from.isTypeClass()!);
        case TY.Ttuple: return visitTuple(from.isTypeTuple()!);
        case TY.Tnull: return visitNull(from.isTypeNull()!);
        case TY.Tnoreturn: return visitNoreturn(from.isTypeNoreturn()!);
    }
}

/**
 * dmd/dcast.d:2019 — `MATCH cimplicitConvTo(Expression e, Type t)`.
 *
 * Same as `implicitConvTo()`, except it follows C11 rules, which are quite a bit more permissive
 * than D (C11 6.3 and 6.5.16.1).
 *
 * Params: e = expression that is to be cast; t = expected resulting type.
 * Returns: the `MATCH` level between `e.type` and `t`.
 *
 * Not an Idiom-B function — a flat rule cascade with no nested visitors.
 */
export function cimplicitConvTo(e: Expression, t: Type): MATCH {
    const tb = toBasetype(t);
    const typeb = toBasetype(e.type!);

    if (tb.equals(typeb))
        return MATCH.exact;

    if (tb.isTypeVector() !== null || typeb.isTypeVector() !== null)
        return implicitConvTo(e, t); // permissive checking doesn't apply to vectors

    if ((isIntegral(typeb) || isFloating(typeb)) && (isIntegral(tb) || isFloating(tb)))
        return MATCH.convert;
    if (tb.ty === TY.Tpointer && isIntegral(typeb)) // C11 6.3.2.3-5
        return MATCH.convert;
    if (isIntegral(tb) && typeb.ty === TY.Tpointer) // C11 6.3.2.3-6
        return MATCH.convert;
    if (tb.ty === TY.Tpointer && typeb.ty === TY.Tpointer) // C11 6.3.2.3-7
        return MATCH.convert;

    return implicitConvTo(e, t);
}

/**
 * dmd/dcast.d:2045 — `Type toStaticArrayType(SliceExp e)`.
 *
 * If the slice has compile-time-known bounds, produce the equivalent static-array type; otherwise
 * `null`. `e` should be optimized beforehand (`$` in lwr/upr already resolved where possible).
 */
export function toStaticArrayType(e: SliceExp): Type | null {
    if (e.lwr !== null && e.upr !== null) {
        // For the following code to work, e should be optimized beforehand.
        // (eg. $ in lwr and upr should be already resolved, if possible)
        const lwr = optimize(e.lwr, WANTvalue);
        const upr = optimize(e.upr, WANTvalue);
        if (lwr.isConst() !== 0 && upr.isConst() !== 0) {
            // dmd/dcast.d:2055 — `cast(size_t)(upr.toUInteger() - lwr.toUInteger())`; callee
            // authorised at dmd/expressionsem.d:223 (`toUInteger`). Both operands are
            // `uinteger_t` (bigint, 09 §1); `cast(size_t)` on a 64-bit target is the identity
            // over the difference, and `sarrayOf` takes the dimension in the bigint domain.
            const len = toUInteger(upr) - toUInteger(lwr);
            return sarrayOf(nextOf(toBasetype(e.type!))!, len);
        }
    } else {
        const t1b = toBasetype(e.e1!.type!);
        if (t1b.ty === TY.Tsarray)
            return t1b;
    }
    return null;
}

/**
 * dmd/dcast.d:2073 — `Expression castTo(Expression e, Scope* sc, Type t, Type att = null)`.
 *
 * Do an explicit cast. Assumes the expression `e` does not have any indirections.
 * Parameter `att` is used to stop 'alias this' recursion.
 *
 * IDIOM B (13 §7.5): a noreturn preamble, nested `visit` + 15 specializations, then the trailing
 * dispatch switch emitted IN FULL.
 */
export function castTo(e: Expression, sc: Scope | null, t: Type, att: Type | null = null): Expression {
    // `tryAliasThisCast` hands the by-value parameter `att` to `isRecursiveAliasThis`'s `ref Type
    // att` (typesem.d:9214), which may rebind it: the parameter slot is an accessor box (03 §7.2).
    const attRef: Ref<Type | null> = { get value() { return att; }, set value(v: Type | null) { att = v; } };

    // dmd/dcast.d:2077 — the base `visit(Expression)`.
    const visit = (e: Expression): Expression => {
        // resolved: version (none) printf block (dcast.d:2080) -> OFF, dropped.
        if (e.type!.equals(t)) {
            return e;
        }
        if (e.type!.isTypeNoreturn() !== null && e.op !== EXP.type) {
            return specialNoreturnCast(e, t);
        }
        const ve = e.isVarExp();
        if (ve !== null) {
            const v: VarDeclaration | null = ve.var_!.isVarDeclaration();
            if (v !== null && (v.storage_class & STC.manifest) !== 0n) {
                const result = ctfeInterpret(e);
                /* https://issues.dlang.org/show_bug.cgi?id=18236
                 *
                 * The expression returned by ctfeInterpret points
                 * to the line where the manifest constant was declared
                 * so we need to update the location before trying to cast
                 */
                result.loc = e.loc;
                return castTo(result, sc, t);
            }
        }

        const tob = toBasetype(t);
        const t1b = toBasetype(e.type!);
        if (tob.equals(t1b)) {
            const result = e.copy(); // because of COW for assignment to e.type
            result.type = t;
            return result;
        }

        /* Make semantic error against invalid cast between concrete types.
         * Assume that 'e' is never any placeholder expression.
         * The result of these checks should be consistent with CastExp::toElem().
         */

        // Fat Value types
        const tob_isFV = tob.ty === TY.Tstruct || tob.ty === TY.Tsarray || tob.ty === TY.Tvector;
        const t1b_isFV = t1b.ty === TY.Tstruct || t1b.ty === TY.Tsarray || t1b.ty === TY.Tvector;

        // Fat Reference types
        const tob_isFR = tob.ty === TY.Tarray || tob.ty === TY.Tdelegate;
        const t1b_isFR = t1b.ty === TY.Tarray || t1b.ty === TY.Tdelegate;

        // Reference types
        const tob_isR = tob_isFR || tob.ty === TY.Tpointer || tob.ty === TY.Taarray || tob.ty === TY.Tclass;
        const t1b_isR = t1b_isFR || t1b.ty === TY.Tpointer || t1b.ty === TY.Taarray || t1b.ty === TY.Tclass;

        // Arithmetic types (== valueable basic types)
        const tob_isA = (isIntegral(tob) || isFloating(tob)) && tob.ty !== TY.Tvector;
        const t1b_isA = (isIntegral(t1b) || isFloating(t1b)) && t1b.ty !== TY.Tvector;

        // dmd/dcast.d:2139 — `Expression ok()`.
        const ok = (): Expression => {
            const result: Expression = new CastExp(e.loc, e, t);
            result.type = t; // Don't call semantic()
            return result;
        };

        // dmd/dcast.d:2148 — `Expression tryAliasThisCast()`. Try casting the alias this member;
        // returns the expression on success, null otherwise.
        const tryAliasThisCast = (): Expression | null => {
            if (isRecursiveAliasThis(attRef, t1b))
                return null;

            /* Forward the cast to our alias this member, rewrite to:
             *   cast(to)e1.aliasthis
             */
            // D hands its `Scope*` through unchecked; not gagged, so `resolveAliasThis` returns non-null.
            let exp = resolveAliasThis(sc!, e)!;
            const errors = global.startGagging();
            // 11 §2.5 capture-in-finally: D consumes `endGagging`'s result at region end.
            let gagged: boolean;
            try {
                exp = castTo(exp, sc, t, att);
            } finally {
                gagged = global.endGagging(errors);
            }
            return gagged ? null : exp;
        };

        let hasAliasThis = false;

        // dmd/dcast.d:2164 — `Expression fail()`.
        const fail = (): Expression => {
            /* if the cast cannot be performed, maybe there is an alias this that can be used for
             * casting.
             */
            if (hasAliasThis) {
                const result = tryAliasThisCast();
                if (result !== null)
                    return result;
            }
            error(
                e.loc,
                ds("cannot cast expression `%s` of type `%s` to `%s`"),
                e.toChars(),
                e.type!.toChars(),
                t.toChars(),
            );
            return ErrorExp.get();
        };

        const t1ad: AggregateDeclaration | null = isAggregate(t1b);
        if (t1ad !== null) {
            const toad = isAggregate(tob);
            if (t1ad !== toad && t1ad.aliasthis !== null) {
                if (t1b.ty === TY.Tclass && tob.ty === TY.Tclass) {
                    const t1cd: ClassDeclaration = t1b.isClassHandle()!;
                    const tocd: ClassDeclaration = tob.isClassHandle()!;
                    const offset: Ref<number> = { value: 0 };
                    if (tocd.isBaseOf(t1cd, offset))
                        return ok();
                }
                hasAliasThis = true;
            }
        } else if (tob.ty === TY.Tvector && t1b.ty !== TY.Tvector) {
            if (t1b.ty === TY.Tsarray) {
                // Casting static array to vector with same size, e.g. `cast(int4) int[4]`
                if (size(t1b, e.loc) !== size(tob, e.loc))
                    return fail();
                return expressionSemantic(new VectorExp(e.loc, e, tob), sc!);
            }
            const tv = tob.isTypeVector()!;
            let result: Expression = new CastExp(e.loc, e, tv.elementType());
            result = new VectorExp(e.loc, result, tob);
            result = expressionSemantic(result, sc!);
            return result;
        } else if (tob.ty !== TY.Tvector && t1b.ty === TY.Tvector) {
            // T[n] <-- __vector(U[m])
            if (tob.ty === TY.Tsarray) {
                if (size(t1b, e.loc) === size(tob, e.loc))
                    return ok();
            }
            return fail();
        } else if (implicitConvToType(t1b, tob) === MATCH.constant && t.equals(constOf(e.type!))) {
            const result = e.copy();
            result.type = t;
            return result;
        }

        // arithmetic values vs. other arithmetic values / arithmetic values vs. T*
        if ((tob_isA && (t1b_isA || t1b.ty === TY.Tpointer)) || (t1b_isA && (tob_isA || tob.ty === TY.Tpointer))) {
            return ok();
        }

        // arithmetic values vs. references or fat values
        if ((tob_isA && (t1b_isR || t1b_isFV)) || (t1b_isA && (tob_isR || tob_isFV))) {
            return fail();
        }

        // Bugzilla 3133: A cast between fat values is possible only when the sizes match.
        if (tob_isFV && t1b_isFV) {
            if (hasAliasThis) {
                const result = tryAliasThisCast();
                if (result !== null)
                    return result;
            }

            if (size(t1b, e.loc) === size(tob, e.loc))
                return ok();

            const ts = toAutoQualChars(e.type!, t);
            error(
                e.loc,
                ds("cannot cast expression `%s` of type `%s` to `%s` because of different sizes"),
                e.toChars(),
                ts[0],
                ts[1],
            );
            return ErrorExp.get();
        }

        // Fat values vs. null or references
        if ((tob_isFV && (t1b.ty === TY.Tnull || t1b_isR)) || (t1b_isFV && (tob.ty === TY.Tnull || tob_isR))) {
            if (tob.ty === TY.Tpointer && t1b.ty === TY.Tsarray) {
                // T[n] sa; cast(U*)sa; // ==> cast(U*)sa.ptr;
                return new AddrExp(e.loc, e, t);
            }
            if (tob.ty === TY.Tarray && t1b.ty === TY.Tsarray) {
                // T[n] sa; cast(U[])sa; // ==> cast(U[])sa[];
                const fsize = size(nextOf(t1b)!);
                const tsize = size(nextOf(tob)!);
                if (fsize === SIZE_INVALID || tsize === SIZE_INVALID) {
                    return ErrorExp.get();
                }
                if (fsize !== tsize) {
                    const dim = toInteger(t1b.isTypeSArray()!.dim!);
                    // D multiplies two `uinteger_t`s, so the product wraps modulo 2^64 (09 §3).
                    if (tsize === 0n || BigInt.asUintN(64, dim * fsize) % tsize !== 0n) {
                        error(
                            e.loc,
                            ds("cannot cast expression `%s` of type `%s` to `%s` since sizes don't line up"),
                            e.toChars(),
                            e.type!.toChars(),
                            t.toChars(),
                        );
                        return ErrorExp.get();
                    }
                }
                return ok();
            }
            return fail();
        }

        /* For references, any reinterpret casts are allowed to same 'ty' type:
         *   T* to U* / R1 function(P1) to R2 function(P2) / R1 delegate(P1) to R2 delegate(P2)
         *   T[] to U[] / V1[K1] to V2[K2] / class/interface A to B (dynamic cast if possible)
         */
        if (tob.ty === t1b.ty && tob_isR && t1b_isR)
            return ok();

        // typeof(null) <-- non-null references or values
        if (tob.ty === TY.Tnull && t1b.ty !== TY.Tnull)
            return fail(); // https://issues.dlang.org/show_bug.cgi?id=14629
        // typeof(null) --> non-null references or arithmetic values
        if (t1b.ty === TY.Tnull && tob.ty !== TY.Tnull)
            return ok();

        // Check size mismatch of references.
        // Tarray and Tdelegate are (void*).sizeof*2, but others have (void*).sizeof.
        if ((tob_isFR && t1b_isR) || (t1b_isFR && tob_isR)) {
            if (tob.ty === TY.Tpointer && t1b.ty === TY.Tarray) {
                // T[] da; cast(U*)da; // ==> cast(U*)da.ptr;
                return ok();
            }
            if (tob.ty === TY.Tpointer && t1b.ty === TY.Tdelegate) {
                // void delegate() dg; cast(U*)dg; // ==> cast(U*)dg.ptr;
                // Note that it happens even when U is a Tfunction!
                deprecation(
                    e.loc,
                    ds("casting from %s to %s is deprecated"),
                    e.type!.toChars(),
                    t.toChars(),
                );
                return ok();
            }
            return fail();
        }

        if (t1b.ty === TY.Tvoid && tob.ty !== TY.Tvoid) {
            return fail();
        }
        return ok();
    };

    // dmd/dcast.d:2339 — `Expression visitError(ErrorExp e)`.
    const visitError = (e: ErrorExpT): Expression => {
        return e;
    };

    // dmd/dcast.d:2344 — `Expression visitReal(RealExp e)`.
    const visitReal = (e: RealExp): Expression => {
        if (e.type!.equals(t))
            return e;

        if ((isReal(e.type!) && isReal(t)) || (isImaginary(e.type!) && isImaginary(t))) {
            const result = e.copy();
            result.type = t;
            return result;
        } else
            return visit(e);
    };

    // dmd/dcast.d:2359 — `Expression visitComplex(ComplexExp e)`.
    const visitComplex = (e: ComplexExp): Expression => {
        if (e.type!.equals(t))
            return e;

        if (isComplex(e.type!) && isComplex(t)) {
            const result = e.copy();
            result.type = t;
            return result;
        } else
            return visit(e);
    };

    // dmd/dcast.d:2374 — `Expression visitStructLiteral(StructLiteralExp e)`.
    const visitStructLiteral = (e: StructLiteralExp): Expression => {
        const result = visit(e);
        const sle = result.isStructLiteralExp();
        if (sle !== null)
            sle.stype = t; // commit type
        return result;
    };

    // dmd/dcast.d:2382 — `Expression visitString(StringExp e)`.
    const visitString = (e: StringExp): Expression => {
        /* This follows copy-on-write; any changes to 'this' will result in a copy.
         * The this.string member is considered immutable.
         */
        let copied = 0;

        if (!e.committed && t.ty === TY.Tpointer && nextOf(t)!.ty === TY.Tvoid &&
            (sc === null || !sc.inCfile)) {
            error(e.loc, ds("cannot convert string literal to `void*`"));
            return ErrorExp.get();
        }

        let se: StringExp = e;

        // dmd/dcast.d:2401 — `Expression lcast()`.
        const lcast = (): Expression => {
            const result: Expression = new CastExp(e.loc, se, t);
            result.type = t; // so semantic() won't be run on e
            return result;
        };

        if (!e.committed) {
            se = e.copy().isStringExp()!;
            se.committed = true;
            copied = 1;
        }

        if (e.type!.equals(t)) {
            return se;
        }

        const tb = toBasetype(t);
        const typeb = toBasetype(e.type!);

        if (e.hexString && !e.committed && isIntegral(nextOf(tb)!)) {
            // D: `cast(ubyte) tb.nextOf().size()` — truncate the `uinteger_t` IN the bigint domain
            // (09 §2 / §1.3.1): `Number(SIZE_INVALID)` would round to 2^64 before any masking.
            const szx = Number(BigInt.asUintN(8, size(nextOf(tb)!)));
            if (szx !== se.sz && e.len % szx === 0) {
                // dmd/dcast.d:2428 — function-local selective import `import dmd.utils: arrayCastBigEndian;`
                const data = e.peekData();
                se.setData(Array.from(arrayCastBigEndian(data, szx)), Math.trunc(data.length / szx), szx);
                se.type = t;
                return se;
            }
        }

        if (tb.ty === TY.Tdelegate && typeb.ty !== TY.Tdelegate) {
            return visit(e);
        }

        if (typeb.equals(tb)) {
            if (copied === 0) {
                se = e.copy().isStringExp()!;
                copied = 1;
            }
            se.type = t;
            return se;
        }

        /* Handle reinterpret casts (dcast.d:2470-2474): cast(wchar[3])"abcd"c, cast(wchar[2])"abcd"c,
         * cast(wchar[1])"abcd"c, cast(char[4])"a" --> ['a', 0, 0, 0].
         */
        if (e.committed && tb.ty === TY.Tsarray && typeb.ty === TY.Tarray) {
            se = e.copy().isStringExp()!;
            const szx: bigint = size(nextOf(tb)!);
            assert(szx <= 255n);
            se.sz = Number(szx); // D: cast(ubyte)szx — a code-unit width in 1..4, not a sentinel
            // D: cast(size_t) of a CT-known dim — index/length domain (09 §1.1), not a sentinel
            se.len = Number(toInteger(tb.isTypeSArray()!.dim!));
            se.committed = true;
            se.type = t;

            /* If larger than source, pad with zeros. */
            const fullSize = (se.len + 1) * se.sz; // incl. terminating 0
            if (fullSize > (e.len + 1) * e.sz) {
                // erased: mem.xmalloc -> JS GC (03 §8). A fresh zero-filled buffer makes D's
                // `memset(s + srcSize, 0, fullSize - srcSize)` tail implicit.
                const s: number[] = new Array<number>(fullSize).fill(0);
                const srcSize = e.len * e.sz;
                // D's `se.peekData()` slices the WIDENED `len * sz` past the source allocation, and only its
                // `.ptr` is used: `se` is a copy of `e`, so that pointer is `e`'s payload. `e.peekData()` is the
                // same bytes, `srcSize` of them, without the read past the end that the port asserts against.
                const data = e.peekData();
                for (let i = 0; i < srcSize; i++)
                    s[i] = data[i]; // memcpy(s, data.ptr, srcSize)
                se.setData(s, se.len, se.sz);
            }
            return se;
        }

        if (tb.ty !== TY.Tsarray && tb.ty !== TY.Tarray && tb.ty !== TY.Tpointer) {
            if (copied === 0) {
                se = e.copy().isStringExp()!;
                copied = 1;
            }
            return lcast();
        }
        if (typeb.ty !== TY.Tsarray && typeb.ty !== TY.Tarray && typeb.ty !== TY.Tpointer) {
            if (copied === 0) {
                se = e.copy().isStringExp()!;
                copied = 1;
            }
            return lcast();
        }

        const nextSz: bigint = size(nextOf(typeb)!);
        if (nextSz === SIZE_INVALID) {
            return ErrorExp.get();
        }

        // `goto L2;` (dmd/dcast.d:2516) is a forward jump into the shared tail that every other
        // path reaches by fall-through -> the 06 §4.1 SKIP-FLAG.
        let gotoL2 = false;

        if (nextSz === size(nextOf(tb)!)) {
            if (copied === 0) {
                se = e.copy().isStringExp()!;
                copied = 1;
            }
            if (tb.ty === TY.Tsarray) {
                gotoL2 = true; // goto L2 (dmd/dcast.d:2516) — handle possible static-array dim change
            } else {
                se.type = t;
                return se;
            }
        }

        if (!gotoL2) {
            if (e.committed)
                return lcast();

            // dmd/dcast.d:2524 — `static auto X(T, U)(T tf, U tt) { return cast(int)tf * 256 + cast(int)tt; }`
            // Monomorphized at (TY, TY) -> int (07 §4): the only instantiation in this file.
            const X = (tf: number, tt: number): number => tf * 256 + tt;

            {
                const buffer = new OutBuffer();
                let newlen = 0;
                const tfty: number = toBasetype(nextOf(typeb)!).ty;
                const ttty: number = toBasetype(nextOf(tb)!).ty;

                // `L1:` (dmd/dcast.d:2619) is the SHARED ARM six transcode cases jump to
                // (06 §4 SHARED-ARM / §3.6): a zero-parameter nested arrow capturing the live
                // locals — never positional parameters.
                const L1Tail = (): void => {
                    if (copied === 0) {
                        se = e.copy().isStringExp()!;
                        copied = 1;
                    }
                    {
                        const szx: bigint = size(nextOf(tb)!);
                        assert(szx <= 255n);
                        se.setData(Array.from(buffer.extractSlice()), newlen, Number(szx));
                    }
                };

                switch (X(tfty, ttty)) {
                    case X(TY.Tchar, TY.Tchar):
                    case X(TY.Twchar, TY.Twchar):
                    case X(TY.Tdchar, TY.Tdchar):
                        break;

                    case X(TY.Tchar, TY.Twchar): {
                        for (let u = 0; u < e.len;) {
                            const r = utf_decodeChar(se.peekString(), u);
                            u = r.nextIdx;
                            if (r.error !== null)
                                error(e.loc, ds("%.*s"), r.error.length, r.error);
                            else
                                buffer.writeUTF16(r.dchar);
                        }
                        newlen = Math.trunc(buffer.length() / 2);
                        buffer.writeUTF16(0);
                        L1Tail(); // goto L1 (dmd/dcast.d:2552)
                        break;
                    }

                    case X(TY.Tchar, TY.Tdchar): {
                        for (let u = 0; u < e.len;) {
                            const r = utf_decodeChar(se.peekString(), u);
                            u = r.nextIdx;
                            if (r.error !== null)
                                error(e.loc, ds("%.*s"), r.error.length, r.error);
                            buffer.write4(r.dchar);
                            newlen++;
                        }
                        buffer.write4(0);
                        L1Tail(); // goto L1 (dmd/dcast.d:2564)
                        break;
                    }

                    case X(TY.Twchar, TY.Tchar): {
                        for (let u = 0; u < e.len;) {
                            const r = utf_decodeWchar(se.peekWstring(), u);
                            u = r.nextIdx;
                            if (r.error !== null)
                                error(e.loc, ds("%.*s"), r.error.length, r.error);
                            else
                                buffer.writeUTF8(r.dchar);
                        }
                        newlen = buffer.length();
                        buffer.writeUTF8(0);
                        L1Tail(); // goto L1 (dmd/dcast.d:2577)
                        break;
                    }

                    case X(TY.Twchar, TY.Tdchar): {
                        for (let u = 0; u < e.len;) {
                            const r = utf_decodeWchar(se.peekWstring(), u);
                            u = r.nextIdx;
                            if (r.error !== null)
                                error(e.loc, ds("%.*s"), r.error.length, r.error);
                            buffer.write4(r.dchar);
                            newlen++;
                        }
                        buffer.write4(0);
                        L1Tail(); // goto L1 (dmd/dcast.d:2589)
                        break;
                    }

                    case X(TY.Tdchar, TY.Tchar): {
                        for (let u = 0; u < e.len; u++) {
                            const c = se.peekDstring()[u];
                            if (!utf_isValidDchar(c))
                                error(e.loc, ds("invalid UCS-32 char \\U%08x"), c);
                            else
                                buffer.writeUTF8(c);
                            newlen++;
                        }
                        newlen = buffer.length();
                        buffer.writeUTF8(0);
                        L1Tail(); // goto L1 (dmd/dcast.d:2603)
                        break;
                    }

                    case X(TY.Tdchar, TY.Twchar): {
                        for (let u = 0; u < e.len; u++) {
                            const c = se.peekDstring()[u];
                            if (!utf_isValidDchar(c))
                                error(e.loc, ds("invalid UCS-32 char \\U%08x"), c);
                            else
                                buffer.writeUTF16(c);
                            newlen++;
                        }
                        newlen = Math.trunc(buffer.length() / 2);
                        buffer.writeUTF16(0);
                        L1Tail(); // goto L1 (dmd/dcast.d:2617)
                        break;
                    }

                    default:
                        assert(size(nextOf(typeb)!) !== size(nextOf(tb)!));
                        return lcast();
                }
            }
        }

        // L2: (dmd/dcast.d:2638) — the shared tail, un-gated: reached by fall-through AND by the
        // `gotoL2` skip flag above.
        assert(copied !== 0);

        // See if need to truncate or extend the literal
        {
            const tsa = tb.isTypeSArray();
            if (tsa !== null) {
                // D: cast(size_t)tsa.dim.toInteger() — index/length domain (09 §1.1)
                const dim2 = Number(toInteger(tsa.dim!));

                // Changing dimensions
                if (dim2 !== se.len) {
                    // Copy when changing the string literal
                    const newsz = se.sz;
                    const d = dim2 < se.len ? dim2 : se.len;
                    // erased: mem.xmalloc -> JS GC (03 §8); the zero fill covers D's memset tail.
                    const s: number[] = new Array<number>((dim2 + 1) * newsz).fill(0);
                    const src = se.peekData();
                    for (let i = 0; i < d * newsz; i++)
                        s[i] = src[i]; // memcpy(s, se.peekData().ptr, d * newsz)
                    se.setData(s, dim2, newsz);
                }
            }
        }
        se.type = t;
        return se;
    };

    // dmd/dcast.d:2664 — `Expression visitAddr(AddrExp e)`.
    const visitAddr = (e: AddrExpT): Expression => {
        // resolved: version (none) printf block (dcast.d:2666) -> OFF, dropped.
        const tb = toBasetype(t);
        const typeb = toBasetype(e.type!);

        if (tb.equals(typeb)) {
            const result = e.copy();
            result.type = t;
            return result;
        }

        // Look for pointers to functions where the functions are overloaded.
        if (e.e1!.isOverExp() !== null &&
            (tb.ty === TY.Tpointer || tb.ty === TY.Tdelegate) && nextOf(tb)!.ty === TY.Tfunction) {
            const eo: OverExp = e.e1!.isOverExp()!;
            let f: FuncDeclaration | null = null;
            for (let i = 0; i < eo.vars!.a.length; i++) {
                const s = eo.vars!.a.opIndex(i);
                const f2 = s!.isFuncDeclaration();
                assert(f2 !== null);
                if (overloadExactMatch(f2!, nextOf(tb)!) !== null) {
                    if (f !== null) {
                        /* Error if match in more than one overload set,
                         * even if one is a 'better' match than the other.
                         */
                        ScopeDsymbol.multiplyDefined(e.loc, f, f2!);
                    } else
                        f = f2;
                }
            }
            if (f !== null) {
                f.tookAddressOf++;
                const se = new SymOffExp(e.loc, f, 0n, false);
                const se2 = expressionSemantic(se, sc!);
                // Let SymOffExp::castTo() do the heavy lifting
                return visit(se2);
            }
        }

        if (e.e1!.isVarExp() !== null &&
            typeb.ty === TY.Tpointer && nextOf(typeb)!.ty === TY.Tfunction &&
            tb.ty === TY.Tpointer && nextOf(tb)!.ty === TY.Tfunction) {
            const ve = e.e1!.isVarExp()!;
            let f0 = ve.var_!.isFuncDeclaration();
            if (f0 !== null) {
                assert(f0.isImportedSymbol());
                f0 = overloadExactMatch(f0, nextOf(tb)!);
                if (f0 !== null) {
                    let result: Expression = new VarExp(e.loc, f0, false);
                    result.type = f0.type;
                    result = new AddrExp(e.loc, result, t);
                    return result;
                }
            }
        }

        const fa = isFuncAddress(e);
        if (fa !== null) {
            if (checkForwardRef(fa, e.loc)) {
                return ErrorExp.get();
            }
        }

        return visit(e);
    };

    // dmd/dcast.d:2744 — `Expression visitTuple(TupleExp e)`.
    const visitTuple = (e: TupleExp): Expression => {
        if (e.type!.equals(t)) {
            return e;
        }

        /* If target type is a tuple of same length, cast each expression to the corresponding type
         * in the tuple.
         */
        let totuple: TypeTuple | null = null;
        {
            const tt = t.isTypeTuple();
            if (tt !== null)
                totuple = e.exps!.length === tt.arguments!.length ? tt : null;
        }

        const te: TupleExp = e.copy().isTupleExp()!;
        te.e0 = e.e0 !== null ? e.e0.copy() : null;
        te.exps = e.exps!.copy();
        for (let i = 0; i < te.exps!.length; i++) {
            let ex = te.exps!.opIndex(i)!;
            ex = castTo(ex, sc, totuple !== null ? totuple.arguments!.opIndex(i)!.type! : t);
            te.exps!.opIndexAssign(ex, i);
        }
        if (totuple !== null)
            te.type = totuple;
        return te;

        /* Questionable behavior (upstream comment, dcast.d:2769): result.type is not set to t if the
         * target type is not a tuple of the same length.
         */
    };

    // dmd/dcast.d:2784 — `Expression visitArrayLiteral(ArrayLiteralExp e)`.
    const visitArrayLiteral = (e: ArrayLiteralExp): Expression => {
        // resolved: version (none) printf block (dcast.d:2786) -> OFF, dropped.
        let ae: ArrayLiteralExp = e;

        const tb = toBasetype(t);

        if (e.type === t) { // D: `e.type == t` — Type reference identity
            return e;
        }
        const typeb = toBasetype(e.type!);

        if (tb.isStaticOrDynamicArray() && typeb.isStaticOrDynamicArray()) {
            if (toBasetype(nextOf(tb)!).ty === TY.Tvoid && toBasetype(nextOf(typeb)!).ty !== TY.Tvoid) {
                // Don't do anything to cast non-void[] to void[]
            } else if (typeb.ty === TY.Tsarray && toBasetype(nextOf(typeb)!).ty === TY.Tvoid) {
                // Don't do anything for casting void[n] to others
            } else {
                const tsa = tb.isTypeSArray();
                if (tsa !== null) {
                    if (BigInt(e.elements!.length) !== toInteger(tsa.dim!))
                        return visit(ae);
                }

                ae = e.copy().isArrayLiteralExp()!;
                if (e.basis !== null)
                    ae.basis = castTo(e.basis, sc, nextOf(tb)!);
                ae.elements = e.elements!.copy();
                for (let i = 0; i < e.elements!.length; i++) {
                    let ex = e.elements!.opIndex(i);
                    if (ex === null)
                        continue;
                    ex = castTo(ex, sc, nextOf(tb)!);
                    ae.elements!.opIndexAssign(ex, i);
                }
                ae.type = t;
                return ae;
            }
        } else if (tb.ty === TY.Tpointer && typeb.ty === TY.Tsarray) {
            const tp = pointerTo(nextOf(typeb)!);
            if (!tp.equals(ae.type!)) {
                ae = e.copy().isArrayLiteralExp()!;
                ae.type = tp;
            }
        } else if (tb.ty === TY.Tvector && (typeb.isStaticOrDynamicArray() || typeb.ty === TY.Tpointer)) {
            // Convert array literal to vector type. The Tpointer case comes from C eagerly
            // converting Tsarray to Tpointer.
            const tv = tb.isTypeVector()!;
            const tbase = tv.basetype.isTypeSArray();
            assert(tbase!.ty === TY.Tsarray);
            const edim = e.elements!.length;
            const tbasedim = toInteger(tbase!.dim!);
            if (BigInt(edim) > tbasedim)
                return visit(ae);

            ae = e.copy().isArrayLiteralExp()!;
            ae.type = tv.basetype; // https://issues.dlang.org/show_bug.cgi?id=12642
            ae.elements = e.elements!.copy();
            const telement: Type = tv.elementType();
            for (let i = 0; i < edim; i++) {
                let ex = e.elements!.opIndex(i)!;
                ex = castTo(ex, sc, telement);
                ae.elements!.opIndexAssign(ex, i);
            }
            // Fill in the rest with the default initializer
            // D: cast(size_t)tbasedim — index/length domain (09 §1.1)
            ae.elements!.setDim(Number(tbasedim));
            for (let i = edim; i < Number(tbasedim); i++) {
                // D types `defaultInitLiteral`'s result `Expression` and reads it unchecked.
                let ex = defaultInitLiteral(nextOf(typeb)!, e.loc)!;
                ex = castTo(ex, sc, telement);
                ae.elements!.opIndexAssign(ex, i);
            }
            let ev: Expression = new VectorExp(e.loc, ae, tb);
            ev = expressionSemantic(ev, sc!);
            return ev;
        }
        return visit(ae);
    };

    // dmd/dcast.d:2881 — `Expression visitAssocArrayLiteral(AssocArrayLiteralExp e)`.
    const visitAssocArrayLiteral = (e: AssocArrayLiteralExp): Expression => {
        if (e.type === t) { // D: `e.type == t` — Type reference identity
            return e;
        }

        const tb = toBasetype(t);
        const typeb = toBasetype(e.type!);

        if (tb.ty === TY.Taarray && typeb.ty === TY.Taarray && toBasetype(nextOf(tb)!).ty !== TY.Tvoid) {
            const ae: AssocArrayLiteralExp = e.copy().isAssocArrayLiteralExp()!;
            ae.keys = e.keys!.copy();
            ae.values = e.values!.copy();
            assert(e.keys!.length === e.values!.length);
            for (let i = 0; i < e.keys!.length; i++) {
                let ex = e.values!.opIndex(i)!;
                ex = castTo(ex, sc, nextOf(tb)!);
                ae.values!.opIndexAssign(ex, i);

                ex = e.keys!.opIndex(i)!;
                ex = castTo(ex, sc, tb.isTypeAArray()!.index!);
                ae.keys!.opIndexAssign(ex, i);
            }
            ae.type = t;
            ae.lowering = null; // we need a different lowering
            ae.loweringCtfe = null;
            expressionSemantic(ae, sc!);
            return ae;
        }
        return visit(e);
    };

    // dmd/dcast.d:2918 — `Expression visitSymOff(SymOffExp e)`.
    const visitSymOff = (e: SymOffExpT): Expression => {
        // resolved: version (none) printf block (dcast.d:2920) -> OFF, dropped.
        if (e.type === t && !e.hasOverloads) { // D: `e.type == t` — Type reference identity
            return e;
        }

        const tb = toBasetype(t);
        const typeb = toBasetype(e.type!);

        if (tb.equals(typeb)) {
            const result = e.copy();
            result.type = t;
            result.isSymOffExp()!.hasOverloads = false;
            return result;
        }

        // Look for pointers to functions where the functions are overloaded.
        if (e.hasOverloads &&
            typeb.ty === TY.Tpointer && nextOf(typeb)!.ty === TY.Tfunction &&
            (tb.ty === TY.Tpointer || tb.ty === TY.Tdelegate) && nextOf(tb)!.ty === TY.Tfunction) {
            let f0 = e.var_!.isFuncDeclaration();
            f0 = f0 !== null ? overloadExactMatch(f0, nextOf(tb)!) : null;
            if (f0 !== null) {
                let result: Expression;
                if (tb.ty === TY.Tdelegate) {
                    if (f0.needThis() && hasThis(sc!) !== null) {
                        result = new DelegateExp(e.loc, new ThisExp(e.loc), f0, false);
                        result = expressionSemantic(result, sc!);
                    } else if (f0.needThis()) {
                        error(e.loc, ds("no `this` to create delegate for `%s`"), f0.toChars());
                        return ErrorExp.get();
                    } else if (f0.isNested()) {
                        result = new DelegateExp(e.loc, IntegerExp.literal(0), f0, false);
                        result = expressionSemantic(result, sc!);
                    } else {
                        error(e.loc, ds("cannot cast from function pointer to delegate"));
                        return ErrorExp.get();
                    }
                } else {
                    result = new SymOffExp(e.loc, f0, 0n, false);
                    result.type = t;
                }
                f0.tookAddressOf++;
                return result;
            }
        }

        const fa = isFuncAddress(e);
        if (fa !== null) {
            if (checkForwardRef(fa, e.loc)) {
                return ErrorExp.get();
            }
        }

        return visit(e);
    };

    // dmd/dcast.d:2994 — `Expression visitDelegate(DelegateExp e)`.
    const visitDelegate = (e: DelegateExpT): Expression => {
        // resolved: version (none) printf block (dcast.d:2996) -> OFF, dropped.
        const errorCovariantReturnType = (): void => {
            error(e.loc, ds("cannot form delegate due to covariant return type"));
        };

        const tb = toBasetype(t);
        const typeb = toBasetype(e.type!);

        if (tb.equals(typeb) && !e.hasOverloads) {
            // D: `int offset;` — the `&offset` out-parameter box (03 §7.2); `int.init` is 0 (09 §1.0).
            const offset: Ref<number> = { value: 0 };
            e.func!.tookAddressOf++;
            // dmd/dcast.d:3012 — `e.func.tintro.nextOf().isBaseOf(e.func.type.nextOf(), &offset)`,
            // the typesem.d free function reached by UFCS (04 §6). `errorCovariantReturnType()` is
            // `void`: the branch only emits a diagnostic, and D falls through to the copy-and-
            // repaint tail either way — so no wall may sit on this path (11 §2.5).
            if (e.func!.tintro !== null &&
                isBaseOf(nextOf(e.func!.tintro!)!, nextOf(e.func!.type!), offset) && offset.value !== 0)
                errorCovariantReturnType();
            const result = e.copy();
            result.type = t;
            return result;
        }

        // Look for delegates to functions where the functions are overloaded.
        if (typeb.ty === TY.Tdelegate && tb.ty === TY.Tdelegate) {
            if (e.func !== null) {
                const f = overloadExactMatch(e.func, nextOf(tb)!);
                if (f !== null) {
                    const offset: Ref<number> = { value: 0 };
                    if (f.tintro !== null && isBaseOf(nextOf(f.tintro)!, nextOf(f.type!), offset) && offset.value !== 0)
                        errorCovariantReturnType();
                    if (f !== e.func)    // if address not already marked as taken
                        f.tookAddressOf++;
                    const result = new DelegateExp(e.loc, e.e1, f, false, e.vthis2);
                    result.type = t;
                    return result;
                }
                if (e.func.tintro !== null)
                    errorCovariantReturnType();
            }
        }

        const fa = isFuncAddress(e);
        if (fa !== null) {
            if (checkForwardRef(fa, e.loc)) {
                return ErrorExp.get();
            }
        }

        return visit(e);
    };

    // dmd/dcast.d:3051 — `Expression visitFunc(FuncExp e)`.
    const visitFunc = (e: FuncExp): Expression => {
        // dropped: //printf trace (dcast.d:3053)
        // `&fe` (a `FuncExp*` out-slot) is the 03 §7.2 box.
        const fe: { value: FuncExp | null } = { value: null };
        if (matchType(e, t, sc, fe, global.errorSinkNull!) > MATCH.nomatch) {
            return fe.value!;
        }
        return visit(e);
    };

    // dmd/dcast.d:3062 — `Expression visitCond(CondExp e)`.
    const visitCond = (e: CondExp): Expression => {
        if (!e.type!.equals(t)) {
            const result: Expression = new CondExpC(
                e.loc,
                e.econd!,
                castTo(e.e1!, sc, t),
                castTo(e.e2!, sc, t),
            );
            result.type = t;
            return result;
        }
        return e;
    };

    // dmd/dcast.d:3073 — `Expression visitComma(CommaExp e)`.
    const visitComma = (e: CommaExp): Expression => {
        const e2c = castTo(e.e2!, sc, t);

        if (e2c !== e.e2) {
            const result: Expression = new CommaExpC(e.loc, e.e1!, e2c);
            result.type = e2c.type;
            return result;
        } else {
            e.type = e.e2!.type;
            return e;
        }
    };

    // dmd/dcast.d:3090 — `Expression visitSlice(SliceExp e)`.
    const visitSlice = (e: SliceExp): Expression => {
        const tb = toBasetype(t);
        const typeb = toBasetype(e.type!);

        if (e.type!.equals(t) || typeb.ty !== TY.Tarray ||
            (tb.ty !== TY.Tarray && tb.ty !== TY.Tsarray)) {
            return visit(e);
        }

        if (tb.ty === TY.Tarray) {
            // dmd/dcast.d:3105 — `typeb.nextOf().equivalent(tb.nextOf())`; callee authorised at
            // dmd/typesem.d:8430 (`equivalent`).
            if (equivalent(nextOf(typeb)!, nextOf(tb)!)) {
                // T[] to const(T)[]
                const result = e.copy();
                result.type = t;
                return result;
            } else {
                return visit(e);
            }
        }

        // Handle the cast from Tarray to Tsarray with CT-known slicing
        let tsa: TypeSArray | null;
        {
            // D shadows the outer `t` with an inner `Type t` here (dcast.d:3119); the port renames
            // the inner binding so the outer target type stays reachable. Only one slot is live at
            // a time, so this is a local rename, not a 02 §11.5b shadow-split.
            const tInner = toStaticArrayType(e);
            tsa = tInner !== null ? tInner.isTypeSArray() : null;
        }

        if (tsa !== null && size(tsa, e.loc) === size(tb, e.loc)) {
            /* Match if the sarray sizes are equal:
             *  T[a .. b] to const(T)[b-a]
             *  T[a .. b] to U[dim] if (T.sizeof*(b-a) == U.sizeof*dim)
             * If a SliceExp has Tsarray, it will become lvalue (handled in SliceExp::isLvalue).
             */
            const result = e.copy();
            result.type = t;
            return result;
        }
        // dmd/dcast.d:3139 — `tsa.dim.equals(...)` is UFCS onto `equals(Expression, Expression)`
        // (expressionsem.d:919).
        if (tsa !== null && equals(tsa.dim!, tb.isTypeSArray()!.dim!)) {
            /* Match if the dimensions are equal
             * with the implicit conversion of e.e1:
             *  cast(float[2]) [2.0, 1.0, 0.0][0..2];
             */
            let t1b = toBasetype(e.e1!.type!);
            if (t1b.ty === TY.Tsarray)
                t1b = sarrayOf(nextOf(tb)!, toInteger(t1b.isTypeSArray()!.dim!));
            else if (t1b.ty === TY.Tarray)
                t1b = arrayOf(nextOf(tb)!);
            else if (t1b.ty === TY.Tpointer)
                t1b = pointerTo(nextOf(tb)!);
            else
                assertUnreachable(); // D: assert(0) (dcast.d:3153)
            if (implicitConvTo(e.e1!, t1b) > MATCH.nomatch) {
                const e1x = implicitCastTo(e.e1!, sc, t1b);
                assert(e1x.op !== EXP.error);
                e = e.copy().isSliceExp()!;
                e.e1 = e1x;
                e.type = t;
                return e;
            }
        }
        const ts = toAutoQualChars(tsa !== null ? tsa : e.type!, t);
        error(
            e.loc,
            ds("cannot cast expression `%s` of type `%s` to `%s`"),
            e.toChars(),
            ts[0],
            ts[1],
        );
        return ErrorExp.get();
    };

    // dmd/dcast.d:3167 — the noreturn preamble, BEFORE the dispatch switch.
    // Casting to noreturn isn't an actual cast: rewrite `cast(<qual> noreturn) <exp>`
    // as `<exp>, assert(false)`.
    if (t.isTypeNoreturn() !== null) {
        // Don't generate an unreachable assert(false) if e will abort
        if (e.type!.isTypeNoreturn() !== null) {
            // Paint e to accomodate for different type qualifiers
            e.type = t;
            return e;
        }

        const ini = defaultInitLiteral(t, e.loc);
        // `combine` returns its non-null first operand combined: never null here.
        return Expression.combine(e, ini)!;
    }

    // dmd/dcast.d:3184 — the trailing dispatch switch (13 §7.5 rule 1), emitted IN FULL.
    switch (e.op) {
        default: return visit(e);
        case EXP.error: return visitError(e.isErrorExp()!);
        case EXP.float64: return visitReal(e.isRealExp()!);
        case EXP.complex80: return visitComplex(e.isComplexExp()!);
        case EXP.structLiteral: return visitStructLiteral(e.isStructLiteralExp()!);
        case EXP.string_: return visitString(e.isStringExp()!);
        case EXP.address: return visitAddr(e.isAddrExp()!);
        case EXP.tuple: return visitTuple(e.isTupleExp()!);
        case EXP.arrayLiteral: return visitArrayLiteral(e.isArrayLiteralExp()!);
        case EXP.assocArrayLiteral: return visitAssocArrayLiteral(e.isAssocArrayLiteralExp()!);
        case EXP.symbolOffset: return visitSymOff(e.isSymOffExp()!);
        case EXP.delegate_: return visitDelegate(e.isDelegateExp()!);
        case EXP.function_: return visitFunc(e.isFuncExp()!);
        case EXP.question: return visitCond(e.isCondExp()!);
        case EXP.comma: return visitComma(e.isCommaExp()!);
        case EXP.slice: return visitSlice(e.isSliceExp()!);
    }
}

/**
 * dmd/dcast.d:3213 — `Expression inferType(Expression e, Type t, int flag = 0)`.
 *
 * Set the type-inference target. `t` = target type; `flag` = 1: don't put an error when inference
 * fails. IDIOM B (13 §7.5): four nested visitors + the trailing dispatch switch, emitted IN FULL.
 */
export function inferType(e: Expression, t: Type | null, flag = 0): Expression {
    // dmd/dcast.d:3215 — `Expression visitAle(ArrayLiteralExp ale)`.
    const visitAle = (ale: ArrayLiteralExp): Expression => {
        const tb = toBasetype(t!);
        if (!tb.isStaticOrDynamicArray())
            return ale;

        const tn = nextOf(tb)!;
        if (ale.basis !== null)
            ale.basis = inferType(ale.basis, tn, flag);
        for (let i = 0; i < ale.elements!.length; i++) {
            const el = ale.elements!.opIndex(i);
            if (el !== null) {
                ale.elements!.opIndexAssign(inferType(el, tn, flag), i);
            }
        }

        return ale;
    };

    // dmd/dcast.d:3236 — `Expression visitAar(AssocArrayLiteralExp aale)`.
    const visitAar = (aale: AssocArrayLiteralExp): Expression => {
        const tb = toBasetype(t!);
        const taa = tb.isTypeAArray();
        if (taa === null)
            return aale;

        const ti = taa.index!;
        const tv = nextOf(taa)!;
        for (let i = 0; i < aale.keys!.length; i++) {
            const el = aale.keys!.opIndex(i);
            if (el !== null) {
                aale.keys!.opIndexAssign(inferType(el, ti, flag), i);
            }
        }
        for (let i = 0; i < aale.values!.length; i++) {
            const el = aale.values!.opIndex(i);
            if (el !== null) {
                aale.values!.opIndexAssign(inferType(el, tv, flag), i);
            }
        }

        return aale;
    };

    // dmd/dcast.d:3265 — `Expression visitFun(FuncExp fe)`.
    const visitFun = (fe: FuncExp): Expression => {
        // dropped: //printf trace (dcast.d:3264)
        if (t!.ty === TY.Tdelegate || (t!.ty === TY.Tpointer && nextOf(t!)!.ty === TY.Tfunction)) {
            fe.fd!.treq = t;
        }
        return fe;
    };

    // dmd/dcast.d:3275 — `Expression visitTer(CondExp ce)`.
    const visitTer = (ce: CondExp): Expression => {
        const tb = toBasetype(t!);
        ce.e1 = inferType(ce.e1!, tb, flag);
        ce.e2 = inferType(ce.e2!, tb, flag);
        return ce;
    };

    // dmd/dcast.d:3283 — `if (t) switch (e.op) { … default: }`. The dispatch is emitted IN FULL;
    // note D's `default:` here is EMPTY (falls out of the switch to the trailing `return e`), not a
    // route to a base `visit` — this function has no base arm.
    if (t !== null) {
        switch (e.op) {
            case EXP.arrayLiteral: return visitAle(e.isArrayLiteralExp()!);
            case EXP.assocArrayLiteral: return visitAar(e.isAssocArrayLiteralExp()!);
            case EXP.function_: return visitFun(e.isFuncExp()!);
            case EXP.question: return visitTer(e.isCondExp()!);
            default:
                break;
        }
    }
    return e;
}

/**
 * dmd/dcast.d:3297 — `Expression scaleFactor(BinExp be, Scope* sc)`.
 *
 * Scale addition/subtraction to/from a pointer: rewrite `(ptr + int)` as `(ptr + (int * stride))`
 * (and the mirrored `(int + ptr)`). `sc` is dereferenced unconditionally on the reachable tail, so
 * it is typed non-null (02 §10.1).
 */
export function scaleFactor(be: BinExp, sc: Scope): Expression {
    const t1b = toBasetype(be.e1!.type!);
    const t2b = toBasetype(be.e2!.type!);
    let eoff: Expression;

    if (t1b.ty === TY.Tpointer && isIntegral(t2b)) {
        // Need to adjust operator by the stride.
        // Replace (ptr + int) with (ptr + (int * stride))
        const t = Type.tptrdiff_t;

        const stride: bigint = size(nextOf(t1b)!, be.loc);
        if (!t.equals(t2b))
            be.e2 = castTo(be.e2!, sc, t);
        eoff = be.e2!;
        be.e2 = new MulExp(be.loc, be.e2!, new IntegerExp(Loc.initial, stride, t));
        be.e2!.type = t;
        be.type = be.e1!.type;
    } else if (t2b.ty === TY.Tpointer && isIntegral(t1b)) {
        // Need to adjust operator by the stride.
        // Replace (int + ptr) with (ptr + (int * stride))
        const t = Type.tptrdiff_t;
        let e: Expression;

        const stride: bigint = size(nextOf(t2b)!, be.loc);
        if (!t.equals(t1b))
            e = castTo(be.e1!, sc, t);
        else
            e = be.e1!;
        eoff = e;
        e = new MulExp(be.loc, e, new IntegerExp(Loc.initial, stride, t));
        e.type = t;
        be.type = be.e2!.type;
        be.e1 = be.e2;
        be.e2 = e;
    } else
        assertUnreachable(); // D: assert(0) (dcast.d:3341)

    eoff = optimize(eoff, WANTvalue);
    if (eoff.op === EXP.int64 && toInteger(eoff) === 0n) {
        // (empty in D)
    } else if (setUnsafe(sc, false, be.loc, ds("pointer arithmetic"))) {
        return ErrorExp.get();
    }

    return be;
}

/**
 * dmd/dcast.d:3359 — `private bool isVoidArrayLiteral(Expression e, Type other)`.
 *
 * Return true if `e` is an empty array literal with dimensionality equal to or less than the type
 * of the other array (`[]`, `[[]]`, `[[[]]]`, …) — i.e. make sure `[1,2]` is compatible with `[]`,
 * `[[1,2]]` with `[[]]`, etc.
 *
 * D `private` is MODULE-scoped: emitted as a non-exported module-local function, which is exactly
 * TS module privacy (01-conventions / 10 §1.7).
 */
function isVoidArrayLiteral(e: Expression, other: Type): boolean {
    // The D parameters are reassigned while walking the nesting chain; TS parameters keep their
    // declared type, so the walk uses widened local cursors (02 §10.1).
    let cur: Expression = e;
    let curOther: Type = other;
    while (cur.op === EXP.arrayLiteral && cur.type!.ty === TY.Tarray &&
           cur.isArrayLiteralExp()!.elements!.length === 1) {
        const ale = cur.isArrayLiteralExp()!;
        // dmd/dcast.d:3364 — `e = ale[0]` is `ArrayLiteralExp.opIndex(0)` (expression.d), the
        // basis-aware element read.
        cur = ale.opIndex(0)!;
        if (curOther.isStaticOrDynamicArray())
            curOther = nextOf(curOther)!;
        else
            return false;
    }
    if (curOther.ty !== TY.Tsarray && curOther.ty !== TY.Tarray)
        return false;
    const t = cur.type!;
    return cur.op === EXP.arrayLiteral && t.ty === TY.Tarray && nextOf(t)!.ty === TY.Tvoid &&
        cur.isArrayLiteralExp()!.elements!.length === 0;
}

/**
 * dmd/dcast.d:3391 — `Type typeMerge(Scope* sc, EXP op, ref Expression pe1, ref Expression pe2)`.
 *
 * Merge the types of `e1` and `e2` into a common subset. Parameters `pe1`/`pe2` are rewritten in
 * place as needed (D `ref` -> one-slot boxes, 03 §3.3).
 *
 * Params: sc = current scope; op = operator such as `e1 op e2` (in practice `EXP.question` or one
 * of the binary operators); pe1/pe2 = the LHS/RHS of the operation, rewritten.
 * Returns: the resulting type on success, `null` on error.
 *
 * GOTO VOCABULARY (06 §4): `Lagain` and `LmergeClassTypes` are RETRY shapes -> labeled `for (;;)`
 * with `continue`; `Lcc` and `LmodCompare` are SKIP-FLAG shapes (§4.1) -> `gotoLcc` / `gotoLmodCompare`
 * gates on the enclosing conditions.
 */
export function typeMerge(sc: Scope | null, op: EXP, pe1: Ref<Expression>, pe2: Ref<Expression>): Type | null {
    // dropped: //printf trace (dcast.d:3393)

    let e1: Expression = pe1.value;
    let e2: Expression = pe2.value;

    // ImportC: do array/function conversions
    if (sc !== null) {
        // dmd/dcast.d:3401 — `e1 = e1.arrayFuncConv(sc);`
        e1 = arrayFuncConv(e1, sc);
        // dmd/dcast.d:3402 — `e2 = e2.arrayFuncConv(sc);`
        e2 = arrayFuncConv(e2, sc);
    }

    // D's nested `convert(ref Expression from, Type to)` binds `ref` to the LOCAL `e1`/`e2`. A TS
    // local cannot be aliased directly, so each gets a one-slot accessor box (03 §3.3/§7.2); the
    // locals stay plain everywhere else.
    const e1Ref: Ref<Expression> = { get value() { return e1; }, set value(v: Expression) { e1 = v; } };
    const e2Ref: Ref<Expression> = { get value() { return e2; }, set value(v: Expression) { e2 = v; } };

    // dmd/dcast.d:3405 — `Type Lret(Type result)`.
    const Lret = (result: Type): Type => {
        pe1.value = e1;
        pe2.value = e2;
        // resolved: version (none) trace block (dcast.d:3410) -> OFF, dropped.
        return result;
    };

    /// dmd/dcast.d:3423 — `Type convert(ref Expression from, Type to)`. Converts one of the
    /// expressions to the other.
    const convert = (from: Ref<Expression>, to: Type): Type => {
        from.value = castTo(from.value, sc, to);
        return Lret(to);
    };

    /// dmd/dcast.d:3430 — `Type coerce(Type towards)`. Converts both expressions to a third type.
    const coerce = (towards: Type): Type => {
        e1 = castTo(e1, sc, towards);
        e2 = castTo(e2, sc, towards);
        return Lret(towards);
    };

    let t1b = toBasetype(e1.type!);
    let t2b = toBasetype(e2.type!);

    if (sc !== null && sc.inCfile) {
        // Integral types can be implicitly converted to pointers — unreachable: the C-file branch
        // above already escalates (dcast.d:3439).
        if ((t1b.ty === TY.Tpointer) !== (t2b.ty === TY.Tpointer)) {
            if (isIntegral(t1b)) {
                return convert(e1Ref, t2b);
            } else if (isIntegral(t2b)) {
                return convert(e2Ref, t1b);
            }
        }
    }

    if (op !== EXP.question || (t1b.ty !== t2b.ty && (t1b.isTypeBasic() !== null && t2b.isTypeBasic() !== null))) {
        if (op === EXP.question && isSomeChar(t1b.ty) && isSomeChar(t2b.ty)) {
            e1 = castTo(e1, sc, Type.tdchar);
            e2 = castTo(e2, sc, Type.tdchar);
        } else {
            e1 = integralPromotions(e1, sc);
            e2 = integralPromotions(e2, sc);
        }
    }

    let m: MATCH;
    let t1 = e1.type!;
    let t2 = e2.type!;
    assert(t1 !== null);
    let t = t1;

    /* The start type of alias this type recursion. In the following case, we should save A and stop
     * recursion if it appears again:  X -> Y -> [A] -> B -> A -> B -> ...
     */
    // `isRecursiveAliasThis` takes `ref Type att` (typesem.d:9214): each is a box (03 §7.2).
    const att1: Ref<Type | null> = { value: null };
    const att2: Ref<Type | null> = { value: null };

    if (t1.mod !== t2.mod &&
        t1.ty === TY.Tenum && t2.ty === TY.Tenum &&
        t1.isTypeEnum()!.sym === t2.isTypeEnum()!.sym) {
        const mod = MODmerge(t1.mod, t2.mod);
        t1 = castMod(t1, mod);
        t2 = castMod(t2, mod);
        return Lret(t1);
    }

    // `Lagain:` (dmd/dcast.d:3494) — RETRY shape: a labeled infinite loop; every `goto Lagain;`
    // becomes `continue Lagain;` (06 §4).
    Lagain: for (;;) {
        t1b = toBasetype(t1);
        t2b = toBasetype(t2);

        /// dmd/dcast.d:3498 — `static bool isComplexStruct(Type t)`.
        const isComplexStruct = (tt: Type): boolean => {
            if (tt.ty !== TY.Tstruct)
                return false;

            const ts: TypeStruct = tt.isTypeStruct()!;

            // dmd/dcast.d:3505 — `ts.sym.toString()` is `RootObject.toString` (rootobject.d:47), which
            // forwards to the virtual `toChars()`; D's `==` on slices is content equality.
            return dsEquals(ts.sym!.toString(), ds("_Complex"));
        };

        /// dmd/dcast.d:3508 — `static bool isComplexStructOfType(Type t, Type t2)`.
        const isComplexStructOfType = (tt: Type, tt2: Type): boolean => {
            if (!isComplexStruct(tt))
                return false;

            const ts: TypeStruct = toBasetype(tt).isTypeStruct()!;

            const memberType = toBasetype(ts.sym!.fields.opIndex(0)!.type!);

            /* ensure the complex member types fall under one of the complex types */
            switch (toBasetype(memberType).ty) {
                case TY.Tfloat32:
                case TY.Tfloat64:
                case TY.Tfloat80:
                    break;
                default:
                    return false;
            }

            switch (toBasetype(tt2).ty) {
                case TY.Tfloat32:
                case TY.Tfloat64:
                case TY.Tfloat80:
                    return true;
                default:
                    return false;
            }
        };

        /* check for complex structure and an associate complex type in a single condexp */
        if (sc !== null && sc.inCfile) {
            if (isComplexStructOfType(t1b, t2b)) {
                return Lret(toBasetype(e1.type!));
            } else if (isComplexStructOfType(t2b, t1b)) {
                return Lret(toBasetype(e2.type!));
            }
        }

        const ty = implicitConvCommonTy(t1b.ty, t2b.ty);
        if (ty !== TY.Terror) {
            const ty1 = implicitConvTy1(t1b.ty, t2b.ty);
            const ty2 = implicitConvTy1(t2b.ty, t1b.ty);

            if (t1b.ty === ty1) { // if no promotions
                if (t1.equals(t2))
                    return Lret(t1);

                if (t1b.equals(t2b))
                    return Lret(t1b);
            }

            const b1 = Type.basic[ty1];
            const b2 = Type.basic[ty2];

            if (!(b1 !== null && b2 !== null))
                return null;
            t1 = b1;
            t2 = b2;
            e1 = castTo(e1, sc, t1);
            e2 = castTo(e2, sc, t2);
            return Lret(Type.basic[ty]!);
        }

        t1 = t1b;
        t2 = t2b;

        if (t1.ty === TY.Ttuple || t2.ty === TY.Ttuple)
            return null;

        if (t1.equals(t2)) {
            // merging can not result in new enum type
            if (t.ty === TY.Tenum)
                return Lret(t1b);
            return Lret(t);
        }

        if ((t1.ty === TY.Tpointer && t2.ty === TY.Tpointer) ||
            (t1.ty === TY.Tdelegate && t2.ty === TY.Tdelegate)) {
            // Bring pointers to compatible type
            const t1n = nextOf(t1)!;
            const t2n = nextOf(t2)!;

            if (t1n.equals(t2n))
                return Lret(t);

            if (t1n.ty === TY.Tvoid) // pointers to void are always compatible
                return Lret(t1);

            if (t2n.ty === TY.Tvoid)
                return Lret(t2);

            if (implicitConvToType(t1, t2) !== MATCH.nomatch)
                return convert(e1Ref, t2);

            if (implicitConvToType(t2, t1) !== MATCH.nomatch)
                return convert(e2Ref, t1);

            if (t1n.ty === TY.Tfunction && t2n.ty === TY.Tfunction) {
                const tf1: TypeFunction = t1n.isTypeFunction()!;
                const tf2: TypeFunction = t2n.isTypeFunction()!;
                purityLevel(tf1);
                purityLevel(tf2);

                const d: TypeFunction = tf1.syntaxCopy();

                if (tf1.purity !== tf2.purity)
                    d.purity = PURE.impure;
                assert(d.purity !== PURE.fwdref);

                d.isNothrow = (tf1.isNothrow && tf2.isNothrow);
                d.isNogc = (tf1.isNogc && tf2.isNogc);

                if (tf1.trust === tf2.trust)
                    d.trust = tf1.trust;
                else if (tf1.trust <= TRUST.system || tf2.trust <= TRUST.system)
                    d.trust = TRUST.system;
                else
                    d.trust = TRUST.trusted;

                let tx: Type = (t1.ty === TY.Tdelegate) ? new TypeDelegate(d) : pointerTo(d);
                tx = typeSemantic(tx, e1.loc, sc);

                if (implicitConvToType(t1, tx) !== MATCH.nomatch && implicitConvToType(t2, tx) !== MATCH.nomatch)
                    return coerce(tx);
                return null;
            }

            if (t1n.mod !== t2n.mod) {
                if (!t1n.isImmutable() && !t2n.isImmutable() && t1n.isShared() !== t2n.isShared())
                    return null;
                const mod = MODmerge(t1n.mod, t2n.mod);
                t1 = pointerTo(castMod(t1n, mod));
                t2 = pointerTo(castMod(t2n, mod));
                t = t1;
                continue Lagain; // goto Lagain (dmd/dcast.d:3651)
            }

            if (t1n.ty === TY.Tclass && t2n.ty === TY.Tclass) {
                const cd1: ClassDeclaration = t1n.isClassHandle()!;
                const cd2: ClassDeclaration = t2n.isClassHandle()!;
                const offset: Ref<number> = { value: 0 };
                if (cd1.isBaseOf(cd2, offset)) {
                    if (offset.value !== 0)
                        e2 = castTo(e2, sc, t);
                    return Lret(t);
                }

                if (cd2.isBaseOf(cd1, offset)) {
                    if (offset.value !== 0)
                        e1 = castTo(e1, sc, t2);
                    return Lret(t2);
                }

                return null;
            }

            t1 = pointerTo(constOf(t1n));
            t2 = pointerTo(constOf(t2n));
            if (implicitConvToType(t1, t2) !== MATCH.nomatch)
                return convert(e1Ref, t2);
            if (implicitConvToType(t2, t1) !== MATCH.nomatch)
                return convert(e2Ref, t1);
            return null;
        }

        if (t1.isStaticOrDynamicArray() &&
            ((e2.op === EXP.null_ && t2.ty === TY.Tpointer && nextOf(t2)!.ty === TY.Tvoid) ||
             (e2.op === EXP.arrayLiteral && t2.ty === TY.Tsarray && nextOf(t2)!.ty === TY.Tvoid &&
              toInteger(t2.isTypeSArray()!.dim!) === 0n) ||
             isVoidArrayLiteral(e2, t1))) {
            /*  (T[n] op void*)   => T[]   (T[]  op void*)   => T[]
             *  (T[n] op void[0]) => T[]   (T[]  op void[0]) => T[]
             *  (T[n] op void[])  => T[]   (T[]  op void[])  => T[]
             */
            return coerce(arrayOf(nextOf(t1)!));
        }

        if (t2.isStaticOrDynamicArray() &&
            ((e1.op === EXP.null_ && t1.ty === TY.Tpointer && nextOf(t1)!.ty === TY.Tvoid) ||
             (e1.op === EXP.arrayLiteral && t1.ty === TY.Tsarray && nextOf(t1)!.ty === TY.Tvoid &&
              toInteger(t1.isTypeSArray()!.dim!) === 0n) ||
             isVoidArrayLiteral(e1, t2))) {
            /*  (void*   op T[n]) => T[]   (void*   op T[])  => T[]
             *  (void[0] op T[n]) => T[]   (void[0] op T[])  => T[]
             *  (void[]  op T[n]) => T[]   (void[]  op T[])  => T[]
             */
            return coerce(arrayOf(nextOf(t2)!));
        }

        if (t1.isStaticOrDynamicArray() && (m = implicitConvToType(t1, t2)) !== MATCH.nomatch) {
            // https://issues.dlang.org/show_bug.cgi?id=7285  Tsarray op [x, y, ...] -> Tsarray
            // https://issues.dlang.org/show_bug.cgi?id=14737 Tsarray ~ [x, y, ...] -> Tarray
            if (t1.ty === TY.Tsarray && e2.op === EXP.arrayLiteral && op !== EXP.concatenate)
                return convert(e2Ref, t1);
            if (m === MATCH.constant &&
                (op === EXP.addAssign || op === EXP.minAssign || op === EXP.mulAssign ||
                 op === EXP.divAssign || op === EXP.modAssign || op === EXP.powAssign ||
                 op === EXP.andAssign || op === EXP.orAssign || op === EXP.xorAssign)) {
                // Don't make the lvalue const
                return Lret(t2);
            }
            return convert(e1Ref, t2);
        }

        if (t2.isStaticOrDynamicArray() && implicitConvToType(t2, t1) !== MATCH.nomatch) {
            // https://issues.dlang.org/show_bug.cgi?id=7285 / 14737
            if (t2.ty === TY.Tsarray && e1.op === EXP.arrayLiteral && op !== EXP.concatenate)
                return convert(e1Ref, t2);
            return convert(e2Ref, t1);
        }

        if ((t1.isStaticOrDynamicArray() || t1.ty === TY.Tpointer) &&
            (t2.isStaticOrDynamicArray() || t2.ty === TY.Tpointer) &&
            nextOf(t1)!.mod !== nextOf(t2)!.mod) {
            /* If one is mutable and the other immutable, then retry with both of them as const */
            const t1n = nextOf(t1)!;
            const t2n = nextOf(t2)!;
            let mod: MOD;
            if (e1.op === EXP.null_ && e2.op !== EXP.null_)
                mod = t2n.mod;
            else if (e1.op !== EXP.null_ && e2.op === EXP.null_)
                mod = t1n.mod;
            else if (!t1n.isImmutable() && !t2n.isImmutable() && t1n.isShared() !== t2n.isShared())
                return null;
            else
                mod = MODmerge(t1n.mod, t2n.mod);

            if (t1.ty === TY.Tpointer)
                t1 = pointerTo(castMod(t1n, mod));
            else
                t1 = arrayOf(castMod(t1n, mod));

            if (t2.ty === TY.Tpointer)
                t2 = pointerTo(castMod(t2n, mod));
            else
                t2 = arrayOf(castMod(t2n, mod));
            t = t1;
            continue Lagain; // goto Lagain (dmd/dcast.d:3764)
        }

        // `LmergeClassTypes:` (dmd/dcast.d:3767) — RETRY shape reached by `goto LmergeClassTypes;`
        // from inside the `Lcc` loop below (06 §4). The labeled loop must therefore enclose both the
        // class-mod merge and the `Lcc` block.
        LmergeClassTypes: for (;;) {
            // `goto Lcc;` (dmd/dcast.d:3788) is a forward jump into the block that immediately
            // follows, whose condition is implied here -> the §4.1 SKIP-FLAG. Reset per iteration.
            let gotoLcc = false;

            /* Merge different type modifiers on classes */
            if (t1.ty === TY.Tclass && t2.ty === TY.Tclass) {
                if (t1.mod !== t2.mod) {
                    let mod: MOD;
                    if (e1.op === EXP.null_ && e2.op !== EXP.null_)
                        mod = t2.mod;
                    else if (e1.op !== EXP.null_ && e2.op === EXP.null_)
                        mod = t1.mod;
                    else if (!t1.isImmutable() && !t2.isImmutable() && t1.isShared() !== t2.isShared())
                        return null;
                    else
                        mod = MODmerge(t1.mod, t2.mod);
                    t1 = castMod(t1, mod);
                    t2 = castMod(t2, mod);
                    t = t1;
                    continue Lagain; // goto Lagain (dmd/dcast.d:3786)
                }
                gotoLcc = true; // goto Lcc (dmd/dcast.d:3788)
            }

            if (gotoLcc || t1.ty === TY.Tclass || t2.ty === TY.Tclass) {
                // Lcc: (dmd/dcast.d:3793) — D labels the `while (1)`; its bare `continue` is `continue Lcc`
                // and `goto LmergeClassTypes` is `continue LmergeClassTypes` (06 §4).
                Lcc: for (;;) {
                    // The receiver-split Form B names of typesem.d:9272 (typesem.ts).
                    let i1woat: MATCH = MATCH.exact;
                    let i2woat: MATCH = MATCH.exact;

                    const t2c = t2.isTypeClass();
                    if (t2c !== null)
                        i1woat = implicitConvToWithoutAliasThisClass(t2c, t1);
                    const t1c = t1.isTypeClass();
                    if (t1c !== null)
                        i2woat = implicitConvToWithoutAliasThisClass(t1c, t2);

                    let i1 = implicitConvTo(e2, t1);
                    let i2 = implicitConvTo(e1, t2);

                    if (i1 !== MATCH.nomatch && i2 !== MATCH.nomatch) {
                        // We have the case of class vs. void*, so pick class
                        if (t1.ty === TY.Tpointer)
                            i1 = MATCH.nomatch;
                        else if (t2.ty === TY.Tpointer)
                            i2 = MATCH.nomatch;
                    }

                    // Match but without 'alias this' on classes
                    if (i2 !== MATCH.nomatch && i2woat !== MATCH.nomatch)
                        return coerce(t2);
                    if (i1 !== MATCH.nomatch && i1woat !== MATCH.nomatch)
                        return coerce(t1);

                    // Here use implicitCastTo() instead of castTo() to try 'alias this' on classes
                    const coerceImplicit = (towards: Type): Type => {
                        e1 = implicitCastTo(e1, sc, towards);
                        e2 = implicitCastTo(e2, sc, towards);
                        return Lret(towards);
                    };

                    // Implicit conversion with 'alias this'
                    if (i2 !== MATCH.nomatch)
                        return coerceImplicit(t2);
                    if (i1 !== MATCH.nomatch)
                        return coerceImplicit(t1);

                    if (t1.ty === TY.Tclass && t2.ty === TY.Tclass) {
                        /* t1 cannot be converted to t2, and vice versa
                         */
                        const tc1: TypeClass = t1.isTypeClass()!;
                        const tc2: TypeClass = t2.isTypeClass()!;

                        //if (tc1.sym.interfaces.length || tc2.sym.interfaces.length)
                        if (tc1.sym!.isInterfaceDeclaration() !== null ||
                            tc2.sym!.isInterfaceDeclaration() !== null) {
                            const cd = findClassCommonRoot(tc1.sym!, tc2.sym!);
                            if (cd === null)
                                return null;    // no common root
                            t1 = castMod(cd.type!, t1.mod);
                            t2 = castMod(cd.type!, t2.mod);
                            continue LmergeClassTypes;   // deal with mod differences
                        }

                        /* Pick 'tightest' type
                         */
                        const cd1 = tc1.sym!.baseClass;
                        const cd2 = tc2.sym!.baseClass;
                        if (cd1 !== null && cd2 !== null) {
                            t1 = castMod(cd1.type!, t1.mod);
                            t2 = castMod(cd2.type!, t2.mod);
                        } else if (cd1 !== null)
                            t1 = cd1.type!;
                        else if (cd2 !== null)
                            t2 = cd2.type!;
                        else
                            return null;
                        continue LmergeClassTypes;
                    } else if (t1.ty === TY.Tstruct && t1.isTypeStruct()!.sym!.aliasthis !== null) {
                        if (isRecursiveAliasThis(att1, e1.type!))
                            return null;
                        // dropped: //printf trace (dcast.d:3876)
                        // Not gagged, so `resolveAliasThis` returns non-null; D hands `Scope*` through.
                        e1 = resolveAliasThis(sc!, e1)!;
                        t1 = e1.type!;
                        continue Lcc;
                    } else if (t2.ty === TY.Tstruct && t2.isTypeStruct()!.sym!.aliasthis !== null) {
                        if (isRecursiveAliasThis(att2, e2.type!))
                            return null;
                        // dropped: //printf trace (dcast.d:3885)
                        e2 = resolveAliasThis(sc!, e2)!;
                        t2 = e2.type!;
                        continue Lcc;
                    } else
                        return null;
                }
            }

            break LmergeClassTypes; // fall out of the class block (D falls past the `Lcc` if)
        }

        if (t1.ty === TY.Tstruct && t2.ty === TY.Tstruct) {
            if (t1.mod !== t2.mod) {
                if (!t1.isImmutable() && !t2.isImmutable() && t1.isShared() !== t2.isShared())
                    return null;
                const mod = MODmerge(t1.mod, t2.mod);
                t1 = castMod(t1, mod);
                t2 = castMod(t2, mod);
                t = t1;
                continue Lagain; // goto Lagain (dmd/dcast.d:3905)
            }

            const ts1: TypeStruct = t1.isTypeStruct()!;
            const ts2: TypeStruct = t2.isTypeStruct()!;
            if (ts1.sym !== ts2.sym) {
                if (ts1.sym!.aliasthis === null && ts2.sym!.aliasthis === null)
                    return null;

                let i1: MATCH = MATCH.nomatch;
                let i2: MATCH = MATCH.nomatch;

                // `resolveAliasThis` (dsymbolsem.d:1845) is not gagged here, so it returns non-null;
                // D hands its `Scope*` through unchecked.
                let e1b: Expression | null = null;
                let e2b: Expression | null = null;
                if (ts2.sym!.aliasthis !== null) {
                    if (isRecursiveAliasThis(att2, e2.type!))
                        return null;
                    // dropped: //printf trace (dcast.d:3924)
                    e2b = resolveAliasThis(sc!, e2)!;
                    i1 = implicitConvTo(e2b, t1);
                }
                if (ts1.sym!.aliasthis !== null) {
                    if (isRecursiveAliasThis(att1, e1.type!))
                        return null;
                    // dropped: //printf trace (dcast.d:3932)
                    e1b = resolveAliasThis(sc!, e1)!;
                    i2 = implicitConvTo(e1b, t2);
                }
                if (i1 !== MATCH.nomatch && i2 !== MATCH.nomatch)
                    return null;

                if (i1 !== MATCH.nomatch)
                    return convert(e2Ref, t1);
                if (i2 !== MATCH.nomatch)
                    return convert(e1Ref, t2);

                if (e1b !== null) {
                    e1 = e1b;
                    t1 = toBasetype(e1b.type!);
                }
                if (e2b !== null) {
                    e2 = e2b;
                    t2 = toBasetype(e2b.type!);
                }
                t = t1;
                continue Lagain; // goto Lagain (dmd/dcast.d:3955)
            }
        }

        if (t1.ty === TY.Tstruct && t1.isTypeStruct()!.sym!.aliasthis !== null) {
            if (isRecursiveAliasThis(att1, e1.type!))
                return null;
            // dropped: //printf trace (dcast.d:3963)
            e1 = resolveAliasThis(sc!, e1)!;
            t1 = e1.type!;
            t = t1;
            continue Lagain; // goto Lagain (dmd/dcast.d:3967)
        }

        if (t2.ty === TY.Tstruct && t2.isTypeStruct()!.sym!.aliasthis !== null) {
            if (isRecursiveAliasThis(att2, e2.type!))
                return null;
            // dropped: //printf trace (dcast.d:3974)
            e2 = resolveAliasThis(sc!, e2)!;
            t2 = e2.type!;
            t = t2;
            continue Lagain; // goto Lagain (dmd/dcast.d:3978)
        }

        if ((e1.op === EXP.string_ || e1.op === EXP.null_) && implicitConvTo(e1, t2) !== MATCH.nomatch)
            return convert(e1Ref, t2);
        if ((e2.op === EXP.string_ || e2.op === EXP.null_) && implicitConvTo(e2, t1) !== MATCH.nomatch)
            return convert(e2Ref, t1);
        if (t1.ty === TY.Tsarray && t2.ty === TY.Tsarray &&
            implicitConvTo(e2, arrayOf(nextOf(t1)!)) !== MATCH.nomatch)
            return coerce(arrayOf(nextOf(t1)!));
        if (t1.ty === TY.Tsarray && t2.ty === TY.Tsarray &&
            implicitConvTo(e1, arrayOf(nextOf(t2)!)) !== MATCH.nomatch)
            return coerce(arrayOf(nextOf(t2)!));

        // `goto LmodCompare;` (dmd/dcast.d:4000) jumps forward INTO the integral block below
        // -> the §4.1 SKIP-FLAG.
        let gotoLmodCompare = false;

        if (t1.ty === TY.Tvector && t2.ty === TY.Tvector) {
            // https://issues.dlang.org/show_bug.cgi?id=13841 — all vector types should have no
            // common types between different vectors, even though their sizes are the same.
            const tv1 = t1.isTypeVector()!;
            const tv2 = t2.isTypeVector()!;
            if (!tv1.basetype.equals(tv2.basetype))
                return null;

            gotoLmodCompare = true; // goto LmodCompare (dmd/dcast.d:4000)
        }

        if (!gotoLmodCompare && t1.ty === TY.Tvector && t2.ty !== TY.Tvector &&
            implicitConvTo(e2, t1) !== MATCH.nomatch) {
            e2 = castTo(e2, sc, t1);
            t2 = t1;
            t = t1;
            continue Lagain; // goto Lagain (dmd/dcast.d:4008)
        }

        if (!gotoLmodCompare && t2.ty === TY.Tvector && t1.ty !== TY.Tvector &&
            implicitConvTo(e1, t2) !== MATCH.nomatch) {
            e1 = castTo(e1, sc, t2);
            t1 = t2;
            t = t1;
            continue Lagain; // goto Lagain (dmd/dcast.d:4016)
        }

        if (gotoLmodCompare || (isIntegral(t1) && isIntegral(t2))) {
            if (!gotoLmodCompare) {
                if (t1.ty !== t2.ty) {
                    if (t1.ty === TY.Tvector || t2.ty === TY.Tvector)
                        return null;
                    e1 = integralPromotions(e1, sc);
                    e2 = integralPromotions(e2, sc);
                    t1 = e1.type!;
                    t2 = e2.type!;
                    continue Lagain; // goto Lagain (dmd/dcast.d:4029)
                }
                assert(t1.ty === t2.ty);
            }
            // LmodCompare: (dmd/dcast.d:4032) — shared by fall-through and the skip flag.
            if (!t1.isImmutable() && !t2.isImmutable() && t1.isShared() !== t2.isShared())
                return null;
            const mod = MODmerge(t1.mod, t2.mod);

            t1 = castMod(t1, mod);
            t2 = castMod(t2, mod);
            t = t1;
            e1 = castTo(e1, sc, t);
            e2 = castTo(e2, sc, t);
            continue Lagain; // goto Lagain (dmd/dcast.d:4042)
        }

        if (t1.ty === TY.Tnull && t2.ty === TY.Tnull) {
            const mod = MODmerge(t1.mod, t2.mod);
            return coerce(castMod(t1, mod));
        }

        if (t2.ty === TY.Tnull && (t1.ty === TY.Tpointer || t1.ty === TY.Taarray || t1.ty === TY.Tarray))
            return convert(e2Ref, t1);
        if (t1.ty === TY.Tnull && (t2.ty === TY.Tpointer || t2.ty === TY.Taarray || t2.ty === TY.Tarray))
            return convert(e1Ref, t2);

        /// dmd/dcast.d:4057 — `Type checkArrayOpType(Expression e1, Expression e2, EXP op, Scope* sc)`.
        /// Covers array operations for user-defined types.
        const checkArrayOpType = (a1: Expression, a2: Expression, aop: EXP, asc: Scope | null): Type | null => {
            // scalar op scalar - we shouldn't be here
            if (a1.type!.ty !== TY.Tarray && a1.type!.ty !== TY.Tsarray &&
                a2.type!.ty !== TY.Tarray && a2.type!.ty !== TY.Tsarray)
                return null;

            // only supporting slices and array literals
            if (a1.isSliceExp() === null && a1.isArrayLiteralExp() === null &&
                a2.isSliceExp() === null && a2.isArrayLiteralExp() === null)
                return null;

            // start with e1 op e2 and if either one of e1 or e2 is a slice or array literal,
            // replace it with the first element of the array
            let lhs: Expression = a1;
            let rhs: Expression = a2;

            // T[x .. y] op ?
            const se1 = a1.isSliceExp();
            if (se1 !== null)
                lhs = new IndexExp(Loc.initial, se1.e1!, IntegerExp.literal(0));

            // [t1, t2, .. t3] op ?
            const ale1 = a1.isArrayLiteralExp();
            if (ale1 !== null)
                lhs = ale1.opIndex(0)!;

            // ? op U[z .. t]
            const se2 = a2.isSliceExp();
            if (se2 !== null)
                rhs = new IndexExp(Loc.initial, se2.e1!, IntegerExp.literal(0));

            // ? op [u1, u2, .. u3]
            const ale2 = a2.isArrayLiteralExp();
            if (ale2 !== null)
                rhs = ale2.opIndex(0)!;

            // create a new binary expression with the new lhs and rhs (at this stage, at least one
            // of lhs/rhs has been replaced with the 0'th element of the array it was before)
            let exp: Expression | null;
            switch (aop) {
                case EXP.add:
                    exp = new AddExp(Loc.initial, lhs, rhs); break;
                case EXP.min:
                    exp = new MinExp(Loc.initial, lhs, rhs); break;
                case EXP.mul:
                    exp = new MulExp(Loc.initial, lhs, rhs); break;
                case EXP.div:
                    exp = new DivExp(Loc.initial, lhs, rhs); break;
                case EXP.pow:
                    exp = new PowExp(Loc.initial, lhs, rhs); break;
                default:
                    exp = null;
            }

            if (exp !== null) {
                // if T op U is valid and has type V, then T[] op U and T op U[] should be valid and
                // have type V[].
                // swept: `trySemantic` (expressionsem.d:15580) is live at expressionsem.ts:17992 — the
                // previous wall's "expressionsem.d, not ported" claim was stale. D's `Scope* sc` is
                // nullable and `trySemantic` derefs it through `expressionSemantic`; the file's
                // convention for that (dcast.ts:1959/:1964/:2564/:2596) is the non-null assertion.
                const e = trySemantic(exp, asc!);
                if (e !== null && e.type !== null)
                    return arrayOf(e.type);
            }

            return null;
        };
        // dmd/dcast.d:4119 / :4163 — the array-operation arms. No goto inside either: each leg
        // leaves through `Lret` or `return null`, and the `T op T[]` legs fall through to one shared
        // tail (the WANTvalue optimize and the commutative swap).
        if (t1.ty === TY.Tarray && isBinArrayOp(op) && isArrayOpOperand(e1)) {
            if (implicitConvTo(e2, nextOf(t1)!) !== MATCH.nomatch) {
                // T[] op T
                // T[] op cast(T)U
                e2 = castTo(e2, sc, nextOf(t1)!);
                return Lret(arrayOf(nextOf(t1)!));
            }
            if (implicitConvToType(nextOf(t1)!, e2.type!) !== MATCH.nomatch) {
                // (cast(T)U)[] op T    (https://issues.dlang.org/show_bug.cgi?id=12780)
                // e1 is left as U[], it will be handled in arrayOp() later.
                return Lret(arrayOf(e2.type!));
            }
            if (t2.ty === TY.Tarray && isArrayOpOperand(e2)) {
                if (implicitConvToType(nextOf(t1)!, nextOf(t2)!) !== MATCH.nomatch) {
                    // (cast(T)U)[] op T[]  (https://issues.dlang.org/show_bug.cgi?id=12780)
                    t = arrayOf(nextOf(t2)!);
                    // if cast won't be handled in arrayOp() later
                    if (!isArrayOpImplicitCast(t1.isTypeDArray()!, t2.isTypeDArray()!))
                        e1 = castTo(e1, sc, t);
                    return Lret(t);
                }
                if (implicitConvToType(nextOf(t2)!, nextOf(t1)!) !== MATCH.nomatch) {
                    // T[] op (cast(T)U)[]  (https://issues.dlang.org/show_bug.cgi?id=12780)
                    // e2 is left as U[], it will be handled in arrayOp() later.
                    t = arrayOf(nextOf(t1)!);
                    // if cast won't be handled in arrayOp() later
                    if (!isArrayOpImplicitCast(t2.isTypeDArray()!, t1.isTypeDArray()!))
                        e2 = castTo(e2, sc, t);
                    return Lret(t);
                }
            }

            // `t = checkArrayOpType(...)` (dcast.d:4157): `t` is a non-null `Type` local here, so the
            // nullable result goes through `ta`; both legs leave the function, `t` is not read after.
            const ta = checkArrayOpType(e1, e2, op, sc);
            if (ta !== null)
                return Lret(ta);

            return null;
        } else if (t2.ty === TY.Tarray && isBinArrayOp(op) && isArrayOpOperand(e2)) {
            if (implicitConvTo(e1, nextOf(t2)!) !== MATCH.nomatch) {
                // T op T[]
                // cast(T)U op T[]
                e1 = castTo(e1, sc, nextOf(t2)!);
                t = arrayOf(nextOf(t2)!);
            } else if (implicitConvToType(nextOf(t2)!, e1.type!) !== MATCH.nomatch) {
                // T op (cast(T)U)[]    (https://issues.dlang.org/show_bug.cgi?id=12780)
                // e2 is left as U[], it will be handled in arrayOp() later.
                t = arrayOf(e1.type!);
            } else {
                // nullable result through `ta`, as in the arm above (dcast.d:4180)
                const ta = checkArrayOpType(e1, e2, op, sc);
                if (ta === null)
                    return null;
                t = ta;
            }

            // dropped: //printf trace (dcast.d:4185)
            e1 = optimize(e1, WANTvalue);
            if (isCommutative(op) && e1.isConst() !== 0) {
                // Swap operands to minimize number of functions generated
                // dropped: //printf trace (dcast.d:4191)
                const tmp = e1;
                e1 = e2;
                e2 = tmp;
            }
            return Lret(t);
        }

        return null;
    }
}

/**
 * dmd/dcast.d:4212 — `private ClassDeclaration findClassCommonRoot(ClassDeclaration cd1, ClassDeclaration cd2)`.
 *
 * Find the common root both `cd1` and `cd2` can be implicitly converted to.
 * Returns: the common base both can implicitly convert to, or `null` if there is none or there are
 * multiple matches.
 *
 * D `private` is MODULE-scoped -> emitted as a non-exported module-local function.
 * resolved: `enum log = false;` (dcast.d:4214) -> every `if (log) printf(...)` line is dead and
 * dropped (07 §3/§9).
 */
function findClassCommonRoot(cd1: ClassDeclaration, cd2: ClassDeclaration): ClassDeclaration | null {
    /**
     * dmd/dcast.d:4217 — `static struct Root`. A plain value struct accumulating the search result
     * (03 §1/§2: field-wise `.copy()`; it is only ever passed by `ref`, so no copy point fires).
     */
    class Root {
        cd: ClassDeclaration | null = null;
        error = false;

        /* merge cd into results */
        accumulate(cd: ClassDeclaration | null): void {
            if (this.cd === cd) {
                // (empty in D)
            } else if (this.cd === null)
                this.cd = cd;
            else
                this.error = true;
        }

        copy(): Root {
            const c = new Root();
            c.cd = this.cd; // class reference: share (03 §2)
            c.error = this.error;
            return c;
        }
    }

    /* Find common root of cd1 and cd2. Accumulate results in r. */
    // dmd/dcast.d:4237 — `void findCommonRoot(ClassDeclaration cd1, ClassDeclaration cd2, ref Root r)`.
    // `ref Root r` is an alias to a value struct: pass the object itself, NO copy (03 §3.2).
    const findCommonRoot = (a1: ClassDeclaration, a2: ClassDeclaration, r: Root): void => {
        /* Warning: quadratic time function */
        if (a1 === a2) {
            r.accumulate(a1);
            return;
        }

        for (const b1 of a1.baseclasses ?? []) {
            if (b1!.sym !== r.cd)
                findCommonRoot(a2, b1!.sym!, r);
        }
        for (const b2 of a2.baseclasses ?? []) {
            if (b2!.sym !== r.cd)
                findCommonRoot(a1, b2!.sym!, r);
        }
    };

    const r = new Root();
    findCommonRoot(cd1, cd2, r);
    if (r.cd === null || r.error)
        return null; // no common root
    return r.cd;
}

/**
 * dmd/dcast.d:4272 — `Expression typeCombine(BinExp be, Scope* sc)`.
 *
 * Bring leaves to a common type.
 * Returns: `null` on success, an `ErrorExp` if an error occurs.
 */
export function typeCombine(be: BinExp, sc: Scope | null): Expression | null {
    // dmd/dcast.d:4274 — `Expression errorReturn()`.
    const errorReturn = (): Expression => {
        // `incompatibleTypes(BinExp, Scope*)` is the Form B `incompatibleTypesFromBinExp`
        // (expressionsem.d:1483, expressionsem.ts).
        const ex = incompatibleTypesFromBinExp(be, sc);
        if (ex.op === EXP.error)
            return ex;
        return ErrorExp.get();
    };

    // `typeMerge`'s `ref Expression pe1/pe2` bind directly to `be.e1`/`be.e2` in D; here they are
    // one-slot accessor boxes over the same fields, so a write inside `Lret` lands on the node
    // exactly as D's `ref` does (03 §3.3).
    const pe1: Ref<Expression> = {
        get value() { return be.e1!; },
        set value(v: Expression) { be.e1 = v; },
    };
    const pe2: Ref<Expression> = {
        get value() { return be.e2!; },
        set value(v: Expression) { be.e2 = v; },
    };

    const result = typeMerge(sc, be.op, pe1, pe2);
    if (result !== null) {
        if (be.type === null)
            be.type = result;
    } else
        return errorReturn();

    // If the types have no value, return an error
    if (be.e1!.op === EXP.error)
        return be.e1;
    if (be.e2!.op === EXP.error)
        return be.e2;
    return null;
}

/**
 * dmd/dcast.d:4302 — `Expression integralPromotions(Expression e, Scope* sc)`.
 *
 * Do integral promotions (convertchk). Don't convert `<array of>` to `<pointer to>`.
 * `sc` is only forwarded to `castTo` (which null-tests it), so it stays nullable (02 §10.1).
 */
export function integralPromotions(e: Expression, sc: Scope | null): Expression {
    // dropped: //printf trace (dcast.d:4304)
    let r = e;
    switch (toBasetype(e.type!).ty) {
        case TY.Tvoid:
            error(e.loc, ds("void has no value"));
            return ErrorExp.get();

        case TY.Tint8:
        case TY.Tuns8:
        case TY.Tint16:
        case TY.Tuns16:
        case TY.Tbool:
        case TY.Tchar:
        case TY.Twchar:
            r = castTo(r, sc, Type.tint32);
            break;

        case TY.Tdchar:
            r = castTo(r, sc, Type.tuns32);
            break;

        default:
            break;
    }
    return r;
}

/**
 * dmd/dcast.d:4341 — `void fix16997(Scope* sc, UnaExp ue)`.
 *
 * Provides a transition from the non-promoting behavior of unary `+ - ~` to the C-like integral
 * promotion behavior. `ue` is a NegExp, UAddExp or ComExp, revised per the rules.
 * References: https://issues.dlang.org/show_bug.cgi?id=16997
 *
 * `sc` is dereferenced unconditionally (`sc.inCfile`), so it is non-null (02 §10.1).
 */
export function fix16997(sc: Scope, ue: UnaExp): void {
    if (global.params.fix16997 || sc.inCfile) {
        ue.e1 = integralPromotions(ue.e1!, sc); // desired C-like behavior
        return;
    }

    switch (toBasetype(ue.e1!.type!).ty) {
        case TY.Tint8:
        case TY.Tuns8:
        case TY.Tint16:
        case TY.Tuns16:
        // case Tbool: — these operations aren't allowed on bool anyway (D keeps it commented out)
        case TY.Tchar:
        case TY.Twchar:
        case TY.Tdchar:
            // dmd/dcast.d:4360 — `ue.toChars()` / `ue.e1.toChars()` are the `Expression.toChars` method
            // (expression.d:210), kept as method calls: it is what forwards to hdrgen's `toChars(const
            // Expression)` (hdrgen.d:204, `expressionToChars`) outside the FuncExp arm.
            deprecation(ue.loc,
                ds("integral promotion not done for `%s`, remove '-revert=intpromote' switch or `%scast(int)(%s)`"),
                ue.toChars(), EXPtoString(ue.op), ue.e1!.toChars());
            return;

        default:
            return;
    }
}

/**
 * dmd/dcast.d:4374 — `extern (D) bool keyCompatibleWithoutCasting(Expression ekey, Type t2)`.
 *
 * See if an AA key can be compared for equality without any casting; returns true if so. This
 * enables comparing things like an immutable array with a mutable one.
 */
export function keyCompatibleWithoutCasting(ekey: Expression, t2: Type): boolean {
    const t1 = ekey.type!;

    if ((t1.isStaticOrDynamicArray() || t1.ty === TY.Tpointer) && t2.ty === t1.ty) {
        if (implicitConvToType(nextOf(t1)!, nextOf(t2)!) >= MATCH.constant ||
            implicitConvToType(nextOf(t2)!, nextOf(t1)!) >= MATCH.constant)
            return true;
        return false;
    }
    if (implicitConvTo(ekey, t2) < MATCH.constant)
        return false;
    // The receiver-split Form B names of typesem.d:9302/:9287 (typesem.ts).
    const ts = t1.isTypeStruct();
    if (ts !== null)
        return implicitConvToThroughAliasThisStruct(ts, t2) === MATCH.nomatch;
    const tc = t1.isTypeClass();
    if (tc !== null)
        return implicitConvToThroughAliasThisClass(tc, t2) === MATCH.nomatch;
    return true;
}

/**
 * dmd/dcast.d:4399 — `@trusted IntRange getIntRange(Expression e)`.
 *
 * Determine the integral range of an expression. This is used to decide whether implicit narrowing
 * conversions will be allowed. (`@trusted` erased, 04 §8.)
 *
 * IDIOM B (13 §7.5): base `visit` + 21 specializations + the trailing dispatch switch, IN FULL.
 * D's `IntRange` operators (`ir1 + ir2`, `-ir`, …) are the monomorphized intrange.ts methods
 * (`opAdd`, `opNeg`, …; 05 §1).
 */
export function getIntRange(e: Expression): IntRange {
    // dmd/dcast.d:4401 — the base `visit(Expression)`.
    const visit = (e: Expression): IntRange => {
        return intRangeFromType(e.type!);
    };

    // dmd/dcast.d:4406 — `IntRange visitInteger(IntegerExp e)`.
    const visitInteger = (e: IntegerExpT): IntRange => {
        // D converts the `dinteger_t` (ulong) into the `uinteger_t` field as is; the TS IntegerExp
        // value is signed-normalized (09), so it is converted to the unsigned 64-bit carrier that
        // `SignExtendedNumber.value` requires (-5n -> 0xFFFF_FFFF_FFFF_FFFBn).
        return _cast(new IntRange(new SignExtendedNumber(toUint64(e.getInteger()))), e.type!);
    };

    // dmd/dcast.d:4411 — `IntRange visitCast(CastExp e)`.
    const visitCast = (e: CastExpT): IntRange => {
        return _cast(getIntRange(e.e1!), e.type!);
    };

    // In the arms below every argument handed to `_cast`/`castUnsigned` (by-value `_this`, mutated
    // by the intrange.d cast methods) is a fresh operator result or a local that is dead after the
    // call, so the D copy is unobservable (03 §9, condition 2) and is elided.

    // dmd/dcast.d:4416 — `IntRange visitAdd(AddExp e)`.
    const visitAdd = (e: AddExpT): IntRange => {
        const ir1 = getIntRange(e.e1!);
        const ir2 = getIntRange(e.e2!);
        return _cast(ir1.opAdd(ir2), e.type!);
    };

    // dmd/dcast.d:4423 — `IntRange visitMin(MinExp e)`.
    const visitMin = (e: MinExpT): IntRange => {
        const ir1 = getIntRange(e.e1!);
        const ir2 = getIntRange(e.e2!);
        return _cast(ir1.opSub(ir2), e.type!);
    };

    // dmd/dcast.d:4430 — `IntRange visitDiv(DivExp e)`.
    const visitDiv = (e: DivExpT): IntRange => {
        const ir1 = getIntRange(e.e1!);
        const ir2 = getIntRange(e.e2!);

        // `opDiv` mutates its by-value `rhs` (intrange.ts COPY DISCIPLINE): pass a copy.
        return _cast(ir1.opDiv(ir2.copy()), e.type!);
    };

    // dmd/dcast.d:4438 — `IntRange visitMul(MulExp e)`.
    const visitMul = (e: MulExpT): IntRange => {
        const ir1 = getIntRange(e.e1!);
        const ir2 = getIntRange(e.e2!);

        return _cast(ir1.opMul(ir2), e.type!);
    };

    // dmd/dcast.d:4446 — `IntRange visitMod(ModExp e)`.
    const visitMod = (e: ModExpT): IntRange => {
        const ir1 = getIntRange(e.e1!);
        const ir2 = getIntRange(e.e2!);

        // Modding on 0 is invalid anyway.
        if (!ir2.absNeg().imin.negative) {
            return visit(e);
        }
        return _cast(ir1.opMod(ir2), e.type!);
    };

    // dmd/dcast.d:4459 — `IntRange visitAnd(AndExp e)`.
    const visitAnd = (e: AndExpT): IntRange => {
        const result = new IntRange();
        const hasResult: Ref<boolean> = { value: false };
        result.unionOrAssign(getIntRange(e.e1!).opAnd(getIntRange(e.e2!)), hasResult);

        assert(hasResult.value);
        return _cast(result, e.type!);
    };

    // dmd/dcast.d:4469 — `IntRange visitOr(OrExp e)`.
    const visitOr = (e: OrExpT): IntRange => {
        const result = new IntRange();
        const hasResult: Ref<boolean> = { value: false };
        result.unionOrAssign(getIntRange(e.e1!).opOr(getIntRange(e.e2!)), hasResult);

        assert(hasResult.value);
        return _cast(result, e.type!);
    };

    // dmd/dcast.d:4479 — `IntRange visitXor(XorExp e)`.
    const visitXor = (e: XorExpT): IntRange => {
        const result = new IntRange();
        const hasResult: Ref<boolean> = { value: false };
        result.unionOrAssign(getIntRange(e.e1!).opXor(getIntRange(e.e2!)), hasResult);

        assert(hasResult.value);
        return _cast(result, e.type!);
    };

    // dmd/dcast.d:4489 — `IntRange visitShl(ShlExp e)`.
    const visitShl = (e: ShlExpT): IntRange => {
        const ir1 = getIntRange(e.e1!);
        const ir2 = getIntRange(e.e2!);

        return _cast(ir1.opShl(ir2), e.type!);
    };

    // dmd/dcast.d:4497 — `IntRange visitShr(ShrExp e)`.
    const visitShr = (e: ShrExpT): IntRange => {
        const ir1 = getIntRange(e.e1!);
        const ir2 = getIntRange(e.e2!);

        return _cast(ir1.opShr(ir2), e.type!);
    };

    // dmd/dcast.d:4505 — `IntRange visitUshr(UshrExp e)`.
    const visitUshr = (e: UshrExpT): IntRange => {
        const ir1 = castUnsigned(getIntRange(e.e1!), e.e1!.type!);
        const ir2 = getIntRange(e.e2!);

        return _cast(ir1.opUShr(ir2), e.type!);
    };

    // dmd/dcast.d:4513 — `IntRange visitAssign(AssignExp e)`.
    const visitAssign = (e: AssignExp): IntRange => {
        return _cast(getIntRange(e.e2!), e.type!);
    };

    // dmd/dcast.d:4518 — `IntRange visitCond(CondExp e)`.
    const visitCond = (e: CondExp): IntRange => {
        // No need to check e.econd; assume caller has called optimize()
        const ir1 = getIntRange(e.e1!);
        const ir2 = getIntRange(e.e2!);
        return _cast(ir1.unionWith(ir2), e.type!);
    };

    // dmd/dcast.d:4526 — `IntRange visitVar(VarExp e)`.
    const visitVar = (e: VarExpT): IntRange => {
        const vd: VarDeclaration | null = e.var_!.isVarDeclaration();
        if (vd !== null && vd.range !== null)
            // D: `_cast(*vd.range, e.type)` — the deref materialises a by-value COPY for `_cast`'s
            // by-value `IntRange _this` parameter (dcast.d:53). `IntRange` is not in the 03 §9.1
            // alias-safe register, so the copy is emitted at the call site (03 §1 #2 / §3.1).
            return _cast(vd.range.copy(), e.type!);
        // dmd/dcast.d:4532 — `(ie = vd.getConstInitializer()) !is null` — D declares `Expression
        // ie;` at the top of the function and ASSIGNS inside the condition; callee authorised at
        // dmd/expressionsem.d:18998 (`getConstInitializer`).
        if (vd !== null && vd._init !== null && !vd.type!.isMutable()) {
            const ie = getConstInitializer(vd);
            if (ie !== null)
                return getIntRange(ie);
        }
        return visit(e);
    };

    // dmd/dcast.d:4537 — `IntRange visitComma(CommaExp e)`.
    const visitComma = (e: CommaExp): IntRange => {
        return getIntRange(e.e2!);
    };

    // dmd/dcast.d:4542 — `IntRange visitCom(ComExp e)`.
    const visitCom = (e: ComExpT): IntRange => {
        const ir = getIntRange(e.e1!);
        return _cast(
            new IntRange(
                // Both complements are on `uinteger_t` in D — re-truncate to 64 bits (09 §4.2).
                new SignExtendedNumber(BigInt.asUintN(64, ~ir.imax.value), !ir.imax.negative),
                new SignExtendedNumber(BigInt.asUintN(64, ~ir.imin.value), !ir.imin.negative),
            ),
            e.type!,
        );
    };

    // dmd/dcast.d:4548 — `IntRange visitNeg(NegExp e)`.
    const visitNeg = (e: NegExpT): IntRange => {
        const ir = getIntRange(e.e1!);
        return _cast(ir.opNeg(), e.type!);
    };

    // dmd/dcast.d:4555 — the trailing dispatch switch (13 §7.5 rule 1), emitted IN FULL.
    switch (e.op) {
        default: return visit(e);
        case EXP.int64: return visitInteger(e.isIntegerExp()!);
        case EXP.cast_: return visitCast(e.isCastExp()!);
        case EXP.add: return visitAdd(e.isAddExp()!);
        case EXP.min: return visitMin(e.isMinExp()!);
        case EXP.div: return visitDiv(e.isDivExp()!);
        case EXP.mul: return visitMul(e.isMulExp()!);
        case EXP.mod: return visitMod(e.isModExp()!);
        case EXP.and: return visitAnd(e.isAndExp()!);
        case EXP.or: return visitOr(e.isOrExp()!);
        case EXP.xor: return visitXor(e.isXorExp()!);
        case EXP.leftShift: return visitShl(e.isShlExp()!);
        case EXP.rightShift: return visitShr(e.isShrExp()!);
        case EXP.unsignedRightShift: return visitUshr(e.isUshrExp()!);
        case EXP.blit: return visitAssign(e.isBlitExp()!);
        case EXP.construct: return visitAssign(e.isConstructExp()!);
        case EXP.assign: return visitAssign(e.isAssignExp()!);
        case EXP.question: return visitCond(e.isCondExp()!);
        case EXP.variable: return visitVar(e.isVarExp()!);
        case EXP.comma: return visitComma(e.isCommaExp()!);
        case EXP.tilde: return visitCom(e.isComExp()!);
        case EXP.negate: return visitNeg(e.isNegExp()!);
    }
}

/**
 * dmd/dcast.d:4594 — `Expression specialNoreturnCast(Expression toBeCasted, Type to)`.
 *
 * A helper to "cast" from expressions of type `noreturn` to any other type — `noreturn` is
 * implicitly convertible to any other type. However, the dmd backend does not like a naive cast
 * from a noreturn expression (particularly an `assert(0)`), so this generates `(value, assert(0))`
 * instead of `cast(to)(assert(0))`. `value` is currently `to.init` however it cannot be read, so it
 * could be made simpler.
 *
 * Params: toBeCasted = expression of type noreturn to cast; to = type to cast the expression to.
 * Returns: a `CommaExp`; upon any failure an `ErrorExp` will be returned.
 */
export function specialNoreturnCast(toBeCasted: Expression, to: Type): Expression {
    // `combine` returns its non-null first operand combined: never null here.
    return Expression.combine(toBeCasted, defaultInitLiteral(to, toBeCasted.loc))!;
}
