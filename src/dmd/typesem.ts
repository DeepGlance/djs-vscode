// Ported from dmd/typesem.d (module dmd.typesem).
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// W3 RETRANSLATION — the WHOLE of dmd/typesem.d (1.43.0-beta1, 9685 D lines), stitched from three
// chunk fragments in D source order. The rung-era partial that lived here is replaced wholesale.
// Four invariants govern this file (the shared file-preamble sheet §0):
//
// (a) IDIOM-B FILE. `grep -c 'class .*Visitor' dmd/typesem.d` == 0. This retranslation DELETES the
//     rung-era `TypeSemanticVisitor` class — it was the census violation named in 13 §7/§7.5
//     rule 5. Every dispatch is a trailing `switch` inside the free function, emitted IN FULL
//     (S1 hasPointers, S2 size, S3 constConv, S4 typeSemantic, S5 merge, S6 getProperty,
//     S7 resolve, S8 dotExp, S9 isZeroInit, S10 defaultInit, S11 toDsymbol, S12 addStorageClass).
//     Unfilled arms are inline walls AT their `case` position — never routed to `default:`.
//
// (b) LOAD-ORDER. Deleting that class removes the `Visitor` import: typesem.ts carries ZERO
//     runtime edge to visitor/index.ts, which is a LOAD-ORDER ROOT (01 Rule 4.7). Do not re-add
//     it. Every value binding below is referenced only inside function bodies (no top-level
//     `new`, no top-level value read, no top-level `extends`), so plain value imports are
//     load-safe by 01 Rule 4.3; every binding used ONLY in type position takes `import type`
//     (Rule 4.2) so it contributes zero to the SCC load cycle. The value/type split below was
//     derived mechanically — every name in an `import type` list provably has no value use.
//
// (c) FREE FUNCTIONS LIVE HERE (04 §6 anti-pattern). Every declaration of typesem.d is emitted as
//     a TS free function in this module — no promotion onto `Type`. The old re-homes onto `Type`
//     are gone from mtype.ts; every consumer calls the free form.
//     `typeToExpression` / `typeToExpressionHelper` are NOT declared here: 1.43 moved them to
//     mtype.d (:131 / :79) and mtype.ts homes both; astcodegen.ts and parse.ts import them there.
//
// (d) D module-private (`private` functions, and everything after `private:` at typesem.d:9392)
//     is emitted WITHOUT TS `private` and marked `// D module-private` (01 Rule 2.5) — these are
//     cross-chunk callees inside one module and several are called from sibling functions here.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

// ── core/std (01 Rule 3.7 — never TS modules; runtime shims) ────────────────────────────────────
// `core.checkedint.mulu` has no home in src/numeric.ts today; it is shimmed file-local below and
// reported to the integrator as a numeric.ts candidate.
// `core.stdc.string` (strlen/strcmp/memcpy) -> `cstr`/byte compare over `DString` (08 §11) and a
// field-wise clone at typesem.d:3757 (07 §7.1).
// `core.stdc.stdio` -> printf only, inside dead `static if` blocks: dropped entirely.
// `core.stdc.stdarg` (va_list in getMatchError, typesem.d:2054) -> `...args: unknown[]` (04 §3.1).
// dropped: import dmd.root.rmem (mem.xmalloc erased, JS GC — 03 §8 / 08 §13)
// dropped: import dmd.astcodegen (the `Parser!ASTCodegen` template arg is monomorphized, 13 §3)

import { assert, assertUnreachable, SwitchError } from "../assert.js";
import { cstr, ds, dsEquals, dsSlice, dsToJs } from "../dstring.js";
import type { DString } from "../dstring.js";
import { maskUnsignedN, SIZE_MAX, toInt64 } from "../numeric.js";
import { K, keepErrorState, keepMergedAA, keepMergeFound, keepReadErrors, keepType } from "../keep.js";
import { checkAccess, checkAccessPackage, mostVisibleOverload, symbolIsVisible } from "./access.js";
import { ClassKind } from "./aggregate.js";
import type { AggregateDeclaration } from "./aggregate.js";
// Body-fill (01 §4.3 — value import across the core-SCC cycle, read only inside a function body):
// `arrayop.ts` value-imports `isAssignable`/`nextOf`/`toBasetype` from this module the same way, so
// neither side reads the other at load time.
import { checkNonAssignmentArrayOp } from "./arrayop.js";
// NOTE `Parameters` shadows TypeScript's built-in `Parameters<T>` utility type — it MUST be
// imported explicitly, or every `Parameters` annotation silently resolves to the lib type.
import type { Expressions, Objects, Parameters, VarDeclarations } from "./arraytypes.js";
import {
    AliasThisRec, LINK, MATCH, MODFlags, PURE, Sizeok, STC, structalign_t, TFlags, TRUST, TY, VarArg,
} from "./astenums.js";
import type { MOD } from "./astenums.js";
import { OutBuffer } from "./common/outbuffer.js";
import { castTo, cimplicitConvTo, implicitCastTo, implicitConvTo, implicitConvToType, inferType } from "./dcast.js";
import { ClassDeclaration } from "./dclass.js";
import {
    ObjectNotFound, SymbolDeclaration, TupleDeclaration, TypeInfoClassDeclaration, VarDeclaration,
} from "./declaration.js";
import type { Declaration } from "./declaration.js";
import { EnumDeclaration } from "./denum.js";
import type { Module } from "./dmodule.js";
import { Scope } from "./dscope.js";
import { StructDeclaration, UnionDeclaration } from "./dstruct.js";
import { ArrayScopeSymbol, foreachDsymbol, PASS, SearchOpt, Visibility } from "./dsymbol.js";
import type { Dsymbol, ScopeDsymbol, SearchOptFlags } from "./dsymbol.js";
// `dmd.dsymbolsem.getType` is written module-qualified at typesem.d:1585/1709/4386/…; this module
// declares no `getType`, so a plain named import is faithful.
import {
    checkDeprecated, determineFields, determineSize, dsymbolSemantic, getType, hasPointersDsymbol,
    resolveAliasThis, search, search_correct, sizeDsymbol, toAlias, search_correctScope,
    searchScope, search_correct_C, isPOD, followInstantiationContext, loadCoreStdcConfig, adjustLocForMixin,
    toParentP } from "./dsymbolsem.js";
import { isDsymbol, isExpression, isType } from "./dtemplate.js";
import type { TemplateDeclaration } from "./dtemplate.js";
import { analysisSeesErrors, deprecation, deprecationSupplemental, error, errorSupplemental } from "./errors.js";
import {
    AddExp, AddrExp, ArgumentList, ArrayExp, ArrayLengthExp, ArrayLiteralExp, AssertExp, CallExp, CastExp,
    CmpExp, CommaExp, ComplexExp, DelegateFuncptrExp, DelegatePtrExp, DotExp, DotIdExp,
    DotTemplateExp, DotTemplateInstanceExp, DotTypeExp, DotVarExp, DsymbolExp, ErrorExp, FuncExp,
    getFuncTemplateDecl, IdentifierExp, IndexExp, IntegerExp, IntervalExp, isFuncAddress, lastComma,
    NullExp, ObjcClassReferenceExp, OverExp, PtrExp, RealExp, ScopeExp, StringExp, StructLiteralExp,
    TemplateExp, ThisExp, TupleExp, TypeExp, VarExp, VectorArrayExp, VectorExp, WANTvalue,
} from "./expression.js";
import type { ArgumentLabel, Expression } from "./expression.js";
// `trySemantic` is renamed on import: D spells `dmd.expressionsem.trySemantic` module-qualified
// (typesem.d:2388/6813) because this module declares its own `trySemantic(Type, …)`.
import {
    addressOf, checkDisabled, dotIdSemanticProp, dotTemplateSemanticProp, equals, expressionSemantic,
    expressionsToString, fillTupleExpExps, findTempDecl, getConstInitializer, getDsymbol,
    getThisSkipNestedFuncs, getVarExp, hasThis, hasValidType, isBitField, isLvalue, resolveProperties,
    resolvePropertiesOnly, symbolToExp, toBool, toInteger, toLvalue, toUInteger,
    trySemantic as expressionsemTrySemantic,
} from "./expressionsem.js";
// D-homed at funcsem.d:1712 / funcsem.d:1547.
import { checkForwardRef, functionSemantic, FuncResolveFlag, resolveFuncCall } from "./funcsem.js";
import type { FuncDeclaration } from "./func.js";
import { checkNestedReference, isPure, setImpure } from "./funcsem.js";
import { global } from "./globals.js";
import { dsymbolToErrMsg, linkageToChars, parameterToChars, stcToBuffer, toErrMsg } from "./hdrgen.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { cIncludeHint, importHint } from "./imphint.js";
import { ExpInitializer, INITnointerpret } from "./init.js";
import type { Initializer } from "./init.js";
import { initializerSemantic, initializerToExpression } from "./initsem.js";
import { Loc } from "./location.js";
import { tyToDecoBuffer } from "./mangle/basic.js";
import { mangleToBuffer } from "./mangle/index.js";
// NOTE `TypeError` below shadows the JS built-in of the same name — the explicit import is what
// keeps `new TypeError(...)` / `instanceof TypeError` bound to dmd's node class, not to `Error`.
import {
    Covariant, DotExpFlag, isImaginaryNonSemantic, isSomeChar, MODimplicitConv, MODtoChars,
    Parameter, ParameterList, SIZE_INVALID, Type, TypeAArray, TypeBasic, TypeDArray, TypeDelegate,
    TypeEnum, TypeError, TypeFunction, TypeNoreturn, TypeNull, TypePointer, TypeReference,
    TypeSArray, TypeStruct, typeToExpressionHelper, TypeTuple,
} from "./mtype.js";
import type {
    TypeArray, TypeClass, TypeIdentifier, TypeInstance, TypeMixin, TypeNext, TypeQualified,
    TypeReturn, TypeSlice, TypeTag, TypeTraits, TypeTypeof, TypeVector,
} from "./mtype.js";
import { isNogc, setGC } from "./nogc.js";
// D home of `search_function` is opover.d:1183. NOTE clone.ts also exports a `search_function`
// today (a re-home defect reported to the integrator); this file imports the D-faithful one.
import { search_function } from "./opover.js";
import { optimize } from "./optimize.js";
import { Parser } from "./parse.js";
// The growable container `Array!T` (08 §2). Chunk 1 spelled the alias `Array_`, chunks 2 and 3
// `DArray`; the stitch unifies on `DArray` (the spelling already used by attrib.ts / dclass.ts).
// NOTE astenums.ts ALSO exports a `DArray` — the thin `struct DArray(T){T[] data;}` of
// astenums.d:502. That is NOT what this file needs and is deliberately not imported.
import { Array as DArray } from "./root/array.js";
import { complex_t } from "./root/complex.js";
import { CTFloat } from "./root/ctfloat.js";
import { StringTable } from "./root/stringtable.js";
import { DYNCAST } from "./rootobject.js";
import type { RootObject } from "./rootobject.js";
import { checkUnsafeDotExp, isSafe, isTrusted, setUnsafe } from "./safe.js";
// Body-fill (01 §4.3 — value import across the core-SCC cycle, read only inside a function body):
// sideeffect.ts value-imports `mutabilityOfType`/`purityLevel`/`toBasetype` from this module, so the
// edge is mutual; sideeffect.ts declares no top-level class/`new`/value read (both its
// `StoppableVisitor` subclasses are nested inside function bodies), so neither side reads the other
// at load time and typesem.ts still carries no LOAD-TIME edge to visitor/index.ts (invariant (b)).
import { extractSideEffect, isTrivialExp } from "./sideeffect.js";
import { semantic3 } from "./semantic3.js";
import { target } from "./target.js";
import { EXP, TOK, Token } from "./tokens.js";
// last (01 Rule 4.8): the two value edges this module did not carry before — enumsem.ts and
// templatesem.ts both value-import this module back; placed last so neither becomes the entry
// point of the core SCC through typesem.
import { getDefaultValue, getMemtype } from "./enumsem.js";
import { computeOneMember } from "./templatesem.js";
// last (01 Rule 4.8): dinterpret.ts value-imports the sema world back; entering the core SCC through
// it from here would make it the entry point.
import { ctfeInterpret } from "./dinterpret.js";
// last (01 §4.8): objc.ts value-imports dsymbolsem/expressionsem, which close the core SCC back here, so
// entering it from an earlier position would make it the SCC's entry. `objc()` is read only inside
// bodies; it is non-null there because the driver runs `Objc._init()` at startup (main.d:445), hence `objc()!`.
import { objc } from "./objc.js";
// last (01 §4.8): dmd/typesem.d:6043's function-local `import dmd.traits : semanticTraits;`, hoisted
// (01 Rule 4.4). traits.ts value-imports typesem, expressionsem and dsymbolsem back, so entering the core
// SCC through it from an earlier position would make it the SCC's entry.
import { semanticTraits } from "./traits.js";
// last (01 §4.8): dmd/typesem.d:47 `import dmd.importc;`. importc.ts value-imports typesem, dcast, dsymbolsem
// and expressionsem back, so entering the core SCC through it from an earlier position would make it the entry.
import { cAdjustParamType, handleTagSymbols } from "./importc.js";

// ---------------------------------------------------------------------------------------------
// M8 — the out-param box (03 §3.3 / §7.2). ONE file-local declaration, owned by chunk 1; chunks 2
// and 3 use it and declare nothing.
// ---------------------------------------------------------------------------------------------
interface Ref<T> {
    value: T;
}

/**
 * 08 runtime shim: `core.checkedint.mulu(ulong, ulong, ref bool overflow)`.
 *
 * Multiplies two 64-bit unsigned values, setting `overflow.value` (D's `ref bool overflow`, which
 * D ACCUMULATES — it is only ever OR'd, never cleared) when the mathematical product does not fit
 * in 64 bits. `bigint` domain is mandatory: the callers feed the result into `size()`'s
 * `uinteger_t` return and compare it against `uint.max`, so exactness decides the diagnostic
 * (09 §8, §1.3.1).
 *
 * Candidate for `src/numeric.ts` — reported to the integrator; declared file-local here so
 * chunk 3's `numberOfElems` site can use it without a second declaration.
 */
function mulu(a: bigint, b: bigint, overflow: Ref<boolean>): bigint {
    const product = a * b;
    if (product > 0xFFFF_FFFF_FFFF_FFFFn)
        overflow.value = true;                 // D accumulates: `overflow |= …`, never clears
    return BigInt.asUintN(64, product);
}

// ---------------------------------------------------------------------------------------------
// dmd/typesem.d:70
// ---------------------------------------------------------------------------------------------
export function hasDeprecatedAliasThis(_this: Type): boolean {
    const ad = isAggregate(_this);
    // D: `return ad && ad.aliasthis && (ad.aliasthis.isDeprecated || ad.aliasthis.sym.isDeprecated);`
    // — nullable-reference truthiness (06 §2.7); the `&&` chain yields `bool` in D (09 §9).
    return ad !== null && ad.aliasthis !== null &&
        (ad.aliasthis.isDeprecated() || ad.aliasthis.sym!.isDeprecated());
}

/*************************************
 * dmd/typesem.d:80 — `Type addSTC(Type _this, STC stc)`.
 * Apply STCxxxx bits to existing type.
 * Use *before* semantic analysis is run.
 */
export function addSTC(_this: Type, stc: STC): Type {
    let t: Type = _this;
    if (t.isImmutable()) {
        return t;
    } else if ((stc & STC.immutable_) !== 0n) {
        t = makeImmutable(t);
        return t;
    }

    if ((stc & STC.shared_) !== 0n && !t.isShared()) {
        if (t.isWild()) {
            if (t.isConst())
                t = makeSharedWildConst(t);
            else
                t = makeSharedWild(t);
        } else {
            if (t.isConst())
                t = makeSharedConst(t);
            else
                t = makeShared(t);
        }
    }
    if ((stc & STC.const_) !== 0n && !t.isConst()) {
        if (t.isShared()) {
            if (t.isWild())
                t = makeSharedWildConst(t);
            else
                t = makeSharedConst(t);
        } else {
            if (t.isWild())
                t = makeWildConst(t);
            else
                t = makeConst(t);
        }
    }
    if ((stc & STC.wild) !== 0n && !t.isWild()) {
        if (t.isShared()) {
            if (t.isConst())
                t = makeSharedWildConst(t);
            else
                t = makeSharedWild(t);
        } else {
            if (t.isConst())
                t = makeWildConst(t);
            else
                t = makeWild(t);
        }
    }

    return t;
}

/***************************************************
 * dmd/typesem.d:156 — Determine if type t can be indexed or sliced given that it is not an
 * aggregate with operator overloads.
 * Params:
 *      t = type to check
 * Returns:
 *      true if an expression of type t can be e1 in an array expression
 */
export function isIndexableNonAggregate(t: Type): boolean {
    t = toBasetype(t);
    return (t.ty === TY.Tpointer || t.isStaticOrDynamicArray() || t.ty === TY.Taarray ||
            t.ty === TY.Ttuple || t.ty === TY.Tvector);
}

/**
 * dmd/typesem.d:167 — If the type is a class or struct, returns the symbol for it,
 * else null.
 */
export function isAggregate(t: Type): AggregateDeclaration | null {
    t = toBasetype(t);
    const tc = t.isTypeClass();
    if (tc !== null)
        return tc.sym;
    const ts = t.isTypeStruct();
    if (ts !== null)
        return ts.sym;
    return null;
}

/****************************************************
 * dmd/typesem.d:186 — Determine if parameter is a lazy array of delegates.
 * If so, return the return type of those delegates.
 * If not, return NULL.
 *
 * Returns T if the type is one of the following forms:
 *      T delegate()[]
 *      T delegate()[dim]
 */
export function isLazyArray(_this: Parameter): Type | null {
    const tb = toBasetype(_this.type!);
    if (tb.isStaticOrDynamicArray()) {
        // D: `(cast(TypeArray)tb).next` — tag-proved RTTI downcast (02 §11.5c shape 3); the
        // adjacent `tb.isStaticOrDynamicArray()` IS the proof, and `TypeArray` (the abstract
        // TypeSArray/TypeDArray base) has no `isTypeXxx()` accessor of its own.
        const tel = toBasetype((tb as unknown as TypeArray).next!);
        const td = tel.isTypeDelegate();
        if (td !== null) {
            const tf: TypeFunction = td.next!.toTypeFunction();
            if (tf.parameterList.varargs === VarArg.none && tf.parameterList.length() === 0) {
                return tf.next; // return type of delegate
            }
        }
    }
    return null;
}

/****************************************
 * dmd/typesem.d:208 — Return the mask that an integral type will fit into.
 * `ulong` return -> `bigint` (09 §1); the masks are exact bit patterns.
 */
export function sizemask(_this: Type): bigint {
    let m: bigint;
    switch (toBasetype(_this).ty) {
    case TY.Tbool:
        m = 1n;
        break;
    case TY.Tchar:
    case TY.Tint8:
    case TY.Tuns8:
        m = 0xFFn;
        break;
    case TY.Twchar:
    case TY.Tint16:
    case TY.Tuns16:
        m = 0xFFFFn;
        break;
    case TY.Tdchar:
    case TY.Tint32:
    case TY.Tuns32:
        m = 0xFFFFFFFFn;
        break;
    case TY.Tint64:
    case TY.Tuns64:
        m = 0xFFFFFFFFFFFFFFFFn;
        break;
    default:
        return assertUnreachable(); // D `assert(0)` (typesem.d:236)
    }
    return m;
}

/*************************************
 * dmd/typesem.d:244 — If _this is a type of static array, return its base element type.
 */
export function baseElemOf(_this: Type): Type {
    let t = toBasetype(_this);
    let tsa: TypeSArray | null;
    while ((tsa = t.isTypeSArray()) !== null)
        t = toBasetype(tsa.next!);
    return t;
}

/*************************************
 * dmd/typesem.d:256 — If this is a type of something, return that something.
 */
export function nextOf(_this: Type): Type | null {
    /*******************************
     * For TypeFunction, nextOf() can return NULL if the function return
     * type is meant to be inferred, and semantic() hasn't yet been run
     * on the function. After semantic(), it must no longer be NULL.
     */
    const tn = isTypeNext(_this);
    if (tn !== null)
        return tn.next;
    const te = _this.isTypeEnum();
    if (te !== null)
        return nextOf(memType(te));
    return null;
}

/***************************
 * dmd/typesem.d:273 — Look for bugs in constructing types.
 */
export function check(_this: Type): void {
    if (_this.mcache !== null) {
        const _w = _this.mcache; // D: `with (_this.mcache)` (06 §5)
        switch (_this.mod) {
        case 0:
            if (_w.cto !== null)
                assert(_w.cto.mod === MODFlags.const_);
            if (_w.ito !== null)
                assert(_w.ito.mod === MODFlags.immutable_);
            if (_w.sto !== null)
                assert(_w.sto.mod === MODFlags.shared_);
            if (_w.scto !== null)
                assert(_w.scto.mod === (MODFlags.shared_ | MODFlags.const_));
            if (_w.wto !== null)
                assert(_w.wto.mod === MODFlags.wild);
            if (_w.wcto !== null)
                assert(_w.wcto.mod === MODFlags.wildconst);
            if (_w.swto !== null)
                assert(_w.swto.mod === (MODFlags.shared_ | MODFlags.wild));
            if (_w.swcto !== null)
                assert(_w.swcto.mod === (MODFlags.shared_ | MODFlags.wildconst));
            break;

        case MODFlags.const_:
            if (_w.cto !== null)
                assert(_w.cto.mod === 0);
            if (_w.ito !== null)
                assert(_w.ito.mod === MODFlags.immutable_);
            if (_w.sto !== null)
                assert(_w.sto.mod === MODFlags.shared_);
            if (_w.scto !== null)
                assert(_w.scto.mod === (MODFlags.shared_ | MODFlags.const_));
            if (_w.wto !== null)
                assert(_w.wto.mod === MODFlags.wild);
            if (_w.wcto !== null)
                assert(_w.wcto.mod === MODFlags.wildconst);
            if (_w.swto !== null)
                assert(_w.swto.mod === (MODFlags.shared_ | MODFlags.wild));
            if (_w.swcto !== null)
                assert(_w.swcto.mod === (MODFlags.shared_ | MODFlags.wildconst));
            break;

        case MODFlags.wild:
            if (_w.cto !== null)
                assert(_w.cto.mod === MODFlags.const_);
            if (_w.ito !== null)
                assert(_w.ito.mod === MODFlags.immutable_);
            if (_w.sto !== null)
                assert(_w.sto.mod === MODFlags.shared_);
            if (_w.scto !== null)
                assert(_w.scto.mod === (MODFlags.shared_ | MODFlags.const_));
            if (_w.wto !== null)
                assert(_w.wto.mod === 0);
            if (_w.wcto !== null)
                assert(_w.wcto.mod === MODFlags.wildconst);
            if (_w.swto !== null)
                assert(_w.swto.mod === (MODFlags.shared_ | MODFlags.wild));
            if (_w.swcto !== null)
                assert(_w.swcto.mod === (MODFlags.shared_ | MODFlags.wildconst));
            break;

        case MODFlags.wildconst:
            assert(_w.cto === null || _w.cto.mod === MODFlags.const_);
            assert(_w.ito === null || _w.ito.mod === MODFlags.immutable_);
            assert(_w.sto === null || _w.sto.mod === MODFlags.shared_);
            assert(_w.scto === null || _w.scto.mod === (MODFlags.shared_ | MODFlags.const_));
            assert(_w.wto === null || _w.wto.mod === MODFlags.wild);
            assert(_w.wcto === null || _w.wcto.mod === 0);
            assert(_w.swto === null || _w.swto.mod === (MODFlags.shared_ | MODFlags.wild));
            assert(_w.swcto === null || _w.swcto.mod === (MODFlags.shared_ | MODFlags.wildconst));
            break;

        case MODFlags.shared_:
            if (_w.cto !== null)
                assert(_w.cto.mod === MODFlags.const_);
            if (_w.ito !== null)
                assert(_w.ito.mod === MODFlags.immutable_);
            if (_w.sto !== null)
                assert(_w.sto.mod === 0);
            if (_w.scto !== null)
                assert(_w.scto.mod === (MODFlags.shared_ | MODFlags.const_));
            if (_w.wto !== null)
                assert(_w.wto.mod === MODFlags.wild);
            if (_w.wcto !== null)
                assert(_w.wcto.mod === MODFlags.wildconst);
            if (_w.swto !== null)
                assert(_w.swto.mod === (MODFlags.shared_ | MODFlags.wild));
            if (_w.swcto !== null)
                assert(_w.swcto.mod === (MODFlags.shared_ | MODFlags.wildconst));
            break;

        case MODFlags.shared_ | MODFlags.const_:
            if (_w.cto !== null)
                assert(_w.cto.mod === MODFlags.const_);
            if (_w.ito !== null)
                assert(_w.ito.mod === MODFlags.immutable_);
            if (_w.sto !== null)
                assert(_w.sto.mod === MODFlags.shared_);
            if (_w.scto !== null)
                assert(_w.scto.mod === 0);
            if (_w.wto !== null)
                assert(_w.wto.mod === MODFlags.wild);
            if (_w.wcto !== null)
                assert(_w.wcto.mod === MODFlags.wildconst);
            if (_w.swto !== null)
                assert(_w.swto.mod === (MODFlags.shared_ | MODFlags.wild));
            if (_w.swcto !== null)
                assert(_w.swcto.mod === (MODFlags.shared_ | MODFlags.wildconst));
            break;

        case MODFlags.shared_ | MODFlags.wild:
            if (_w.cto !== null)
                assert(_w.cto.mod === MODFlags.const_);
            if (_w.ito !== null)
                assert(_w.ito.mod === MODFlags.immutable_);
            if (_w.sto !== null)
                assert(_w.sto.mod === MODFlags.shared_);
            if (_w.scto !== null)
                assert(_w.scto.mod === (MODFlags.shared_ | MODFlags.const_));
            if (_w.wto !== null)
                assert(_w.wto.mod === MODFlags.wild);
            if (_w.wcto !== null)
                assert(_w.wcto.mod === MODFlags.wildconst);
            if (_w.swto !== null)
                assert(_w.swto.mod === 0);
            if (_w.swcto !== null)
                assert(_w.swcto.mod === (MODFlags.shared_ | MODFlags.wildconst));
            break;

        case MODFlags.shared_ | MODFlags.wildconst:
            assert(_w.cto === null || _w.cto.mod === MODFlags.const_);
            assert(_w.ito === null || _w.ito.mod === MODFlags.immutable_);
            assert(_w.sto === null || _w.sto.mod === MODFlags.shared_);
            assert(_w.scto === null || _w.scto.mod === (MODFlags.shared_ | MODFlags.const_));
            assert(_w.wto === null || _w.wto.mod === MODFlags.wild);
            assert(_w.wcto === null || _w.wcto.mod === MODFlags.wildconst);
            assert(_w.swto === null || _w.swto.mod === (MODFlags.shared_ | MODFlags.wild));
            assert(_w.swcto === null || _w.swcto.mod === 0);
            break;

        case MODFlags.immutable_:
            if (_w.cto !== null)
                assert(_w.cto.mod === MODFlags.const_);
            if (_w.ito !== null)
                assert(_w.ito.mod === 0);
            if (_w.sto !== null)
                assert(_w.sto.mod === MODFlags.shared_);
            if (_w.scto !== null)
                assert(_w.scto.mod === (MODFlags.shared_ | MODFlags.const_));
            if (_w.wto !== null)
                assert(_w.wto.mod === MODFlags.wild);
            if (_w.wcto !== null)
                assert(_w.wcto.mod === MODFlags.wildconst);
            if (_w.swto !== null)
                assert(_w.swto.mod === (MODFlags.shared_ | MODFlags.wild));
            if (_w.swcto !== null)
                assert(_w.swcto.mod === (MODFlags.shared_ | MODFlags.wildconst));
            break;

        default:
            return assertUnreachable(); // D `assert(0)` (typesem.d:435)
        }
    }

    const tn = nextOf(_this);
    if (tn !== null && _this.ty !== TY.Tfunction && tn.ty !== TY.Tfunction && _this.ty !== TY.Tenum) {
        // Verify transitivity
        switch (_this.mod) {
        case 0:
        case MODFlags.const_:
        case MODFlags.wild:
        case MODFlags.wildconst:
        case MODFlags.shared_:
        case MODFlags.shared_ | MODFlags.const_:
        case MODFlags.shared_ | MODFlags.wild:
        case MODFlags.shared_ | MODFlags.wildconst:
        case MODFlags.immutable_:
            assert(tn.mod === MODFlags.immutable_ || (tn.mod & _this.mod) === _this.mod);
            break;

        default:
            return assertUnreachable(); // D `assert(0)` (typesem.d:457)
        }
        check(tn);
    }
}

/**********************************
 * dmd/typesem.d:467 — For our new type '_this', which is type-constructed from t,
 * fill in the cto, ito, sto, scto, wto shortcuts.
 */
// D module-private (typesem.d:467 `private void fixTo`); called from chunk 3's `*Of` family.
function fixTo(_this: Type, t: Type): void {
    let mto: Type | null = null;            // the naked type of `t`
    // D: `if (_this.mod || t.mod)` — MOD is `ubyte` (number domain, 09 §1); expanded per 06 §2.5.
    if (_this.mod !== 0 || t.mod !== 0) {
        _this.getMcache();
        t.getMcache();
    }
    // If fixing this: immutable(T*) by t: immutable(T)*,
    // cache t to this.xto won't break transitivity.
    const tn = nextOf(_this);
    if (tn === null || _this.ty !== TY.Tsarray && tn.mod === nextOf(t)!.mod) {
        switch (t.mod) {
        case 0:
            mto = t;            // t is naked
            break;

        case MODFlags.const_:
            mto = t.mcache!.cto; // cto is naked
            _this.mcache!.cto = t;
            break;

        case MODFlags.wild:
            mto = t.mcache!.wto; // wto is naked
            _this.mcache!.wto = t;
            break;

        case MODFlags.wildconst:
            mto = t.mcache!.wcto; // wcto is naked
            _this.mcache!.wcto = t;
            break;

        case MODFlags.shared_:
            mto = t.mcache!.sto;  // sto is naked
            _this.mcache!.sto = t;
            break;

        case MODFlags.shared_ | MODFlags.const_:
            mto = t.mcache!.scto; // scto is naked
            _this.mcache!.scto = t;
            break;

        case MODFlags.shared_ | MODFlags.wild:
            mto = t.mcache!.swto; // swto is naked
            _this.mcache!.swto = t;
            break;

        case MODFlags.shared_ | MODFlags.wildconst:
            mto = t.mcache!.swcto; // swcto is naked
            _this.mcache!.swcto = t;
            break;

        case MODFlags.immutable_:
            mto = t.mcache!.ito;  // ito is naked
            _this.mcache!.ito = t;
            break;

        default:
            break;
        }
    }
    assert(_this.mod !== t.mod);

    switch (_this.mod) {
    case 0:
        break;

    case MODFlags.const_:
        _this.mcache!.cto = mto;
        t.mcache!.cto = _this;
        break;

    case MODFlags.wild:
        _this.mcache!.wto = mto;
        t.mcache!.wto = _this;
        break;

    case MODFlags.wildconst:
        _this.mcache!.wcto = mto;
        t.mcache!.wcto = _this;
        break;

    case MODFlags.shared_:
        _this.mcache!.sto = mto;
        t.mcache!.sto = _this;
        break;

    case MODFlags.shared_ | MODFlags.const_:
        _this.mcache!.scto = mto;
        t.mcache!.scto = _this;
        break;

    case MODFlags.shared_ | MODFlags.wild:
        _this.mcache!.swto = mto;
        t.mcache!.swto = _this;
        break;

    case MODFlags.shared_ | MODFlags.wildconst:
        _this.mcache!.swcto = mto;
        t.mcache!.swcto = _this;
        break;

    case MODFlags.immutable_:
        t.mcache!.ito = _this;
        if (t.mcache!.cto !== null)
            t.mcache!.cto!.getMcache().ito = _this;
        if (t.mcache!.sto !== null)
            t.mcache!.sto!.getMcache().ito = _this;
        if (t.mcache!.scto !== null)
            t.mcache!.scto!.getMcache().ito = _this;
        if (t.mcache!.wto !== null)
            t.mcache!.wto!.getMcache().ito = _this;
        if (t.mcache!.wcto !== null)
            t.mcache!.wcto!.getMcache().ito = _this;
        if (t.mcache!.swto !== null)
            t.mcache!.swto!.getMcache().ito = _this;
        if (t.mcache!.swcto !== null)
            t.mcache!.swcto!.getMcache().ito = _this;
        break;

    default:
        return assertUnreachable(); // D `assert(0)` (typesem.d:591)
    }
    check(_this);
    check(t);
    //printf("fixTo: %s, %s\n", toChars(), t.toChars());
}

/** dmd/typesem.d:598 — Invoke transitivity of type attributes. */
export function transitive(_this: TypeNext): void {
    // Invoke transitivity of type attributes
    _this.next = addMod(_this.next!, _this.mod);
}

/** dmd/typesem.d:604 — `private inout(TypeNext) isTypeNext(inout Type _this)`. */
// D module-private (typesem.d:604); called from every chunk.
function isTypeNext(_this: Type): TypeNext | null {
    switch (_this.ty) {
        case TY.Tpointer:
        case TY.Treference:
        case TY.Tfunction:
        case TY.Tdelegate:
        case TY.Tslice:
        case TY.Tarray:
        case TY.Taarray:
        case TY.Tsarray:
            // D: `cast(typeof(return)) _this` — tag-proved RTTI downcast (02 §11.5c shape 3); the
            // switch arm IS the proof, exactly as in D.
            return _this as unknown as TypeNext;
        default: return null;
    }
}

/********************************
 * dmd/typesem.d:618 — true if when type is copied, it needs a copy constructor or postblit
 * applied. Only applies to value types, not ref types.
 */
export function needsCopyOrPostblit(_this: Type): boolean {
    const tsa = _this.isTypeSArray();
    if (tsa !== null)
        return needsCopyOrPostblit(tsa.next!);
    const ts = _this.isTypeStruct();
    if (ts !== null)
        return ts.sym!.hasCopyCtor || ts.sym!.postblit !== null;
    const te = _this.isTypeEnum();
    if (te !== null)
        return needsCopyOrPostblit(memType(te));
    return false;
}

/********************************
 * dmd/typesem.d:633 — true if when type goes out of scope, it needs a destructor applied.
 * Only applies to value types, not ref types.
 */
export function needsDestruction(_this: Type): boolean {
    const tsa = _this.isTypeSArray();
    if (tsa !== null)
        return needsDestruction(tsa.next!);
    const ts = _this.isTypeStruct();
    if (ts !== null)
        return ts.sym!.dtor !== null;
    const te = _this.isTypeEnum();
    if (te !== null)
        return needsDestruction(memType(te));
    return false;
}

/** dmd/typesem.d:644 */
export function needsNested(_this: Type): boolean {
    // dmd/typesem.d:646 — nested `static bool typeStructNeedsNested(TypeStruct _this)`.
    const typeStructNeedsNested = (_this: TypeStruct): boolean => {
        if (_this.inuse) return false; // circular type, error instead of crashing

        _this.inuse = true;
        // D: `scope(exit) _this.inuse = false;` -> try/finally (06 §7.1).
        try {
            if (_this.sym!.isNested())
                return true;

            for (let i = 0; i < _this.sym!.fields.length; i++) {
                const v: VarDeclaration = _this.sym!.fields.opIndex(i)!;
                if (!v.isDataseg() && needsNested(v.type!))
                    return true;
            }
            return false;
        } finally {
            _this.inuse = false;
        }
    };

    const tsa = _this.isTypeSArray();
    if (tsa !== null)
        return needsNested(tsa.next!);
    const ts = _this.isTypeStruct();
    if (ts !== null)
        return typeStructNeedsNested(ts);
    const te = _this.isTypeEnum();
    if (te !== null)
        return needsNested(memType(te));
    return false;
}

/** dmd/typesem.d:674 */
export function isScalar(_this: Type): boolean {
    const tb = _this.isTypeBasic();
    if (tb !== null)
        return (tb.flags & (TFlags.integral | TFlags.floating)) !== 0;
    const tv = _this.isTypeVector();
    if (tv !== null)
        return isScalar(nextOf(tv.basetype)!);
    const te = _this.isTypeEnum();
    if (te !== null)
        return isScalar(memType(te));
    if (_this.isTypePointer() !== null)
        return true;
    return false;
}

/** dmd/typesem.d:687 */
export function isUnsigned(_this: Type): boolean {
    const tb = _this.isTypeBasic();
    if (tb !== null)
        return (tb.flags & TFlags.unsigned) !== 0;
    const tv = _this.isTypeVector();
    if (tv !== null)
        return isUnsigned(nextOf(tv.basetype)!);
    const te = _this.isTypeEnum();
    if (te !== null)
        return isUnsigned(memType(te));
    return false;
}

/** dmd/typesem.d:698 */
export function isImaginary(_this: Type): boolean {
    const te = _this.isTypeEnum();
    if (te !== null)
        return isImaginary(memType(te));
    return isImaginaryNonSemantic(_this);
}

/** dmd/typesem.d:705 */
export function isComplex(_this: Type): boolean {
    const tb = _this.isTypeBasic();
    if (tb !== null)
        return (tb.flags & TFlags.complex) !== 0;
    const te = _this.isTypeEnum();
    if (te !== null)
        return isComplex(memType(te));
    return false;
}

/** dmd/typesem.d:715 — Exposed as it is used in `expressionsem`. */
export function typeDeduceWild(_this: Type, t: Type, isRef: boolean): MOD {
    void isRef; // D's parameter is unread in this body (typesem.d:715-737); kept for the 1:1 signature
    //printf("Type::deduceWild this = '%s', tprm = '%s'\n", toChars(), tprm.toChars());
    if (t.isWild()) {
        if (_this.isImmutable())
            return MODFlags.immutable_;
        if (_this.isWildConst()) {
            if (t.isWildConst())
                return MODFlags.wild;
            return MODFlags.wildconst;
        }
        if (_this.isWild())
            return MODFlags.wild;
        if (_this.isConst())
            return MODFlags.const_;
        if (_this.isMutable())
            return MODFlags.mutable;
        return assertUnreachable(); // D `assert(0)` (typesem.d:734)
    }
    return 0;
}

/***************************************
 * dmd/typesem.d:748 — Compute MOD bits matching `this` argument type to wild parameter type.
 * Params:
 *  _this = base parameter type
 *  t = corresponding parameter type
 *  isRef = parameter is `ref` or `out`
 * Returns:
 *  MOD bits
 */
export function deduceWild(_this: Type, t: Type, isRef: boolean): MOD {
    // dmd/typesem.d:750
    const typeNextDeduceWild = (_this: TypeNext, t: Type, isRef: boolean): MOD => {
        if (_this.ty === TY.Tfunction)
            return 0;

        let wm: number; // D `ubyte wm;` — default-init 0 (09 §1.0)
        wm = 0;

        const tn = nextOf(t);
        if (!isRef && (_this.ty === TY.Tarray || _this.ty === TY.Tpointer) && tn !== null) {
            wm = deduceWild(_this.next!, tn, true);
            if (wm === 0)
                wm = typeDeduceWild(_this, t, true); // D: `cast(Type)_this` — upcast, vanishes in TS
        } else {
            wm = typeDeduceWild(_this, t, isRef);    // D: `cast(Type)_this` — upcast, vanishes in TS
            if (wm === 0 && tn !== null)
                wm = deduceWild(_this.next!, tn, true);
        }
        return wm;
    };

    // dmd/typesem.d:773
    const typeStructDeduceWild = (_this: TypeStruct, t: Type, isRef: boolean): MOD => {
        // D: `(cast(TypeStruct)t).sym` — tag-proved by the adjacent `_this.ty == t.ty`
        // (02 §11.5c shape 3); `&&` short-circuits so the accessor only runs when proved.
        if (_this.ty === t.ty && _this.sym === t.isTypeStruct()!.sym)
            return typeDeduceWild(_this, t, isRef);

        let wm = 0; // `ubyte wm = 0;`

        if (t.hasWild() !== 0 && _this.sym!.aliasthis !== null &&
            (_this.att & AliasThisRec.tracing) === 0) {
            const ato = aliasthisOf(_this);
            if (ato !== null) {
                // D: `cast(AliasThisRec)(att | AliasThisRec.tracing)` — enum re-cast after a
                // bitwise op (02 §11.5c shape 4).
                _this.att = (_this.att | AliasThisRec.tracing) as AliasThisRec;
                wm = deduceWild(ato, t, isRef);
                _this.att = (_this.att & ~AliasThisRec.tracing) as AliasThisRec;
            }
        }

        return wm;
    };

    // dmd/typesem.d:793
    const typeClassDeduceWild = (_this: TypeClass, t: Type, isRef: boolean): MOD => {
        const cd = t.isClassHandle();
        if (cd !== null && (_this.sym === cd || cd.isBaseOf(_this.sym, null)))
            return typeDeduceWild(_this, t, isRef);

        let wm = 0; // `ubyte wm = 0;`

        if (t.hasWild() !== 0 && _this.sym!.aliasthis !== null &&
            (_this.att & AliasThisRec.tracing) === 0) {
            const ato = aliasthisOf(_this);
            if (ato !== null) {
                // D: `cast(AliasThisRec)(...)` — enum re-cast after a bitwise op (shape 4).
                _this.att = (_this.att | AliasThisRec.tracing) as AliasThisRec;
                wm = deduceWild(ato, t, isRef);
                _this.att = (_this.att & ~AliasThisRec.tracing) as AliasThisRec;
            }
        }

        return wm;
    };

    const tn = isTypeNext(_this);
    if (tn !== null)
        return typeNextDeduceWild(tn, t, isRef);
    const ts = _this.isTypeStruct();
    if (ts !== null)
        return typeStructDeduceWild(ts, t, isRef);
    const tc = _this.isTypeClass();
    if (tc !== null)
        return typeClassDeduceWild(tc, t, isRef);
    return typeDeduceWild(_this, t, isRef);
}

/** dmd/typesem.d:823 */
export function isString(_this: Type): boolean {
    const tsa = _this.isTypeSArray();
    if (tsa !== null) {
        const nty: TY = toBasetype(tsa.next!).ty;
        return isSomeChar(nty);
    }
    const tda = _this.isTypeDArray();
    if (tda !== null) {
        const nty: TY = toBasetype(tda.next!).ty;
        return isSomeChar(nty);
    }
    const te = _this.isTypeEnum();
    if (te !== null)
        return isString(memType(te));
    return false;
}

/**************************
 * dmd/typesem.d:843 — Returns true if T can be converted to boolean value.
 */
export function isBoolean(_this: Type): boolean {
    switch (_this.ty) {
        case TY.Tvector:
        case TY.Tstruct: return false;
        case TY.Tarray:
        case TY.Taarray:
        case TY.Tdelegate:
        case TY.Tclass:
        case TY.Tnull: return true;
        case TY.Tenum: return isBoolean(memType(_this.isTypeEnum()!));
        // bottom type can be implicitly converted to any other type
        case TY.Tnoreturn: return true;
        default: return isScalar(_this);
    }
}

/** dmd/typesem.d:856 */
export function isReal(_this: Type): boolean {
    const tb = _this.isTypeBasic();
    if (tb !== null)
        return (tb.flags & TFlags.real_) !== 0;
    const te = _this.isTypeEnum();
    if (te !== null)
        return isReal(memType(te));
    return false;
}

/** dmd/typesem.d:866 — real, imaginary, or complex */
export function isFloating(_this: Type): boolean {
    const tb = _this.isTypeBasic();
    if (tb !== null)
        return (tb.flags & TFlags.floating) !== 0;
    const tv = _this.isTypeVector();
    if (tv !== null)
        return isFloating(nextOf(tv.basetype)!);
    const te = _this.isTypeEnum();
    if (te !== null)
        return isFloating(memType(te));
    return false;
}

/** dmd/typesem.d:877 */
export function isIntegral(_this: Type): boolean {
    const tb = _this.isTypeBasic();
    if (tb !== null)
        return (tb.flags & TFlags.integral) !== 0;
    const tv = _this.isTypeVector();
    if (tv !== null)
        return isIntegral(nextOf(tv.basetype)!);
    const te = _this.isTypeEnum();
    if (te !== null)
        return isIntegral(memType(te));
    return false;
}

/** dmd/typesem.d:888 */
export function makeSharedWildConst(_this: Type): Type {
    if (_this.mcache !== null && _this.mcache.swcto !== null)
        return _this.mcache.swcto;
    const t: Type = _this.nullAttributes();
    t.mod = MODFlags.shared_ | MODFlags.wildconst;

    const tn = isTypeNext(_this);
    if (tn !== null) {
        //printf("TypeNext::makeSharedWildConst() %s\n", toChars());
        // D: `cast(TypeNext) t` — `t` is `_this.nullAttributes()`, a same-class copy of a proved
        // TypeNext (02 §11.5c shape 3, proof = the `isTypeNext(_this)` immediately above).
        const _t = t as unknown as TypeNext;
        if (tn.ty !== TY.Tfunction && tn.next!.ty !== TY.Tfunction && !tn.next!.isImmutable()) {
            _t.next = sharedWildConstOf(tn.next!);
        }
        //printf("TypeNext::makeSharedWildConst() returns %p, %s\n", t, t.toChars());
        return _t;
    }
    return t;
}

/** dmd/typesem.d:909 */
export function makeSharedWild(_this: Type): Type {
    if (_this.mcache !== null && _this.mcache.swto !== null)
        return _this.mcache.swto;
    const t: Type = _this.nullAttributes();
    t.mod = MODFlags.shared_ | MODFlags.wild;

    const tn = isTypeNext(_this);
    if (tn !== null) {
        //printf("TypeNext::makeSharedWild() %s\n", toChars());
        const _t = t as unknown as TypeNext; // D: `cast(TypeNext) t` (shape 3, proof above)
        if (tn.ty !== TY.Tfunction && tn.next!.ty !== TY.Tfunction && !tn.next!.isImmutable()) {
            if (tn.next!.isConst())
                _t.next = sharedWildConstOf(tn.next!);
            else
                _t.next = sharedWildOf(tn.next!);
        }
        //printf("TypeNext::makeSharedWild() returns %p, %s\n", t, t.toChars());
        return _t;
    }
    return t;
}

/** dmd/typesem.d:933 */
export function makeWildConst(_this: Type): Type {
    if (_this.mcache !== null && _this.mcache.wcto !== null)
        return _this.mcache.wcto;
    const t: Type = _this.nullAttributes();
    t.mod = MODFlags.wildconst;

    const tn = isTypeNext(_this);
    if (tn !== null) {
        //printf("TypeNext::makeWildConst() %s\n", toChars());
        const _t = t as unknown as TypeNext; // D: `cast(TypeNext) t` (shape 3, proof above)
        if (tn.ty !== TY.Tfunction && tn.next!.ty !== TY.Tfunction && !tn.next!.isImmutable()) {
            if (tn.next!.isShared())
                _t.next = sharedWildConstOf(tn.next!);
            else
                _t.next = wildConstOf(tn.next!);
        }
        //printf("TypeNext::makeWildConst() returns %p, %s\n", t, t.toChars());
        return _t;
    }
    return t;
}

/** dmd/typesem.d:957 */
export function makeWild(_this: Type): Type {
    if (_this.mcache !== null && _this.mcache.wto !== null)
        return _this.mcache.wto;
    const t: Type = _this.nullAttributes();
    t.mod = MODFlags.wild;

    const tn = isTypeNext(_this);
    if (tn !== null) {
        //printf("TypeNext::makeWild() %s\n", toChars());
        const _t = t as unknown as TypeNext; // D: `cast(TypeNext) t` (shape 3, proof above)
        if (tn.ty !== TY.Tfunction && tn.next!.ty !== TY.Tfunction && !tn.next!.isImmutable()) {
            if (tn.next!.isShared()) {
                if (tn.next!.isConst())
                    _t.next = sharedWildConstOf(tn.next!);
                else
                    _t.next = sharedWildOf(tn.next!);
            } else {
                if (tn.next!.isConst())
                    _t.next = wildConstOf(tn.next!);
                else
                    _t.next = wildOf(tn.next!);
            }
        }
        //printf("TypeNext::makeWild() returns %p, %s\n", t, t.toChars());
        return _t;
    }
    return t;
}

/** dmd/typesem.d:991 */
export function makeSharedConst(_this: Type): Type {
    if (_this.mcache !== null && _this.mcache.scto !== null)
        return _this.mcache.scto;
    const t: Type = _this.nullAttributes();
    t.mod = MODFlags.shared_ | MODFlags.const_;

    const tn = isTypeNext(_this);
    if (tn !== null) {
        //printf("TypeNext::makeSharedConst() %s\n", toChars());
        const _t = t as unknown as TypeNext; // D: `cast(TypeNext) t` (shape 3, proof above)
        if (tn.ty !== TY.Tfunction && tn.next!.ty !== TY.Tfunction && !tn.next!.isImmutable()) {
            if (tn.next!.isWild())
                _t.next = sharedWildConstOf(tn.next!);
            else
                _t.next = sharedConstOf(tn.next!);
        }
        //printf("TypeNext::makeSharedConst() returns %p, %s\n", t, t.toChars());
        return _t;
    }
    return t;
}

/** dmd/typesem.d:1015 */
export function makeShared(_this: Type): Type {
    if (_this.mcache !== null && _this.mcache.sto !== null)
        return _this.mcache.sto;
    const t: Type = _this.nullAttributes();
    t.mod = MODFlags.shared_;

    const tn = isTypeNext(_this);
    if (tn !== null) {
        //printf("TypeNext::makeShared() %s\n", toChars());
        const _t = t as unknown as TypeNext; // D: `cast(TypeNext) t` (shape 3, proof above)
        if (tn.ty !== TY.Tfunction && tn.next!.ty !== TY.Tfunction && !tn.next!.isImmutable()) {
            if (tn.next!.isWild()) {
                if (tn.next!.isConst())
                    _t.next = sharedWildConstOf(tn.next!);
                else
                    _t.next = sharedWildOf(tn.next!);
            } else {
                if (tn.next!.isConst())
                    _t.next = sharedConstOf(tn.next!);
                else
                    _t.next = sharedOf(tn.next!);
            }
        }
        //printf("TypeNext::makeShared() returns %p, %s\n", t, t.toChars());
        return _t;
    }
    return t;
}

/** dmd/typesem.d:1049 */
export function makeImmutable(_this: Type): Type {
    if (_this.mcache !== null && _this.mcache.ito !== null)
        return _this.mcache.ito;
    const t: Type = _this.nullAttributes();
    t.mod = MODFlags.immutable_;

    const tn = isTypeNext(_this);
    if (tn !== null) {
        //printf("TypeNext::makeImmutable() %s\n", toChars());
        const _t = t as unknown as TypeNext; // D: `cast(TypeNext) t` (shape 3, proof above)
        if (tn.ty !== TY.Tfunction && tn.next!.ty !== TY.Tfunction && !tn.next!.isImmutable()) {
            _t.next = immutableOf(tn.next!);
        }
        return _t;
    }
    return t;
}

/** dmd/typesem.d:1069 */
export function makeMutable(_this: Type): Type {
    const t: Type = _this.nullAttributes();
    t.mod = _this.mod & MODFlags.shared_;

    const tn = isTypeNext(_this);
    if (tn !== null) {
        //printf("TypeNext::makeMutable() %p, %s\n", this, toChars());
        const _t = t as unknown as TypeNext; // D: `cast(TypeNext)t` (shape 3, proof above)
        if (tn.ty === TY.Tsarray) {
            _t.next = mutableOf(tn.next!);
        }
        //printf("TypeNext::makeMutable() returns %p, %s\n", t, t.toChars());
        return _t;
    }
    return t;
}

/** dmd/typesem.d:1088 */
export function makeConst(_this: Type): Type {
    if (_this.mcache !== null && _this.mcache.cto !== null) {
        assert(_this.mcache.cto.mod === MODFlags.const_);
        return _this.mcache.cto;
    }

    // dmd/typesem.d:1096 — nested `static Type defaultMakeConst(Type _this)`.
    const defaultMakeConst = (_this: Type): Type => {
        //printf("Type::makeConst() %p, %s\n", this, toChars());
        const t: Type = _this.nullAttributes();
        t.mod = MODFlags.const_;
        //printf("-Type::makeConst() %p, %s\n", t, toChars());
        return t;
    };

    // dmd/typesem.d:1105 — nested `static Type typeNextMakeConst(TypeNext _this)`.
    const typeNextMakeConst = (_this: TypeNext): Type => {
        //printf("TypeNext::makeConst() %p, %s\n", this, toChars());
        // D: `cast(TypeNext)defaultMakeConst(cast(Type)_this)` — the argument cast is an upcast
        // (vanishes); the result cast is the tag-proved shape-3 downcast of a same-class copy.
        const t = defaultMakeConst(_this) as unknown as TypeNext;
        if (_this.ty !== TY.Tfunction && _this.next!.ty !== TY.Tfunction && !_this.next!.isImmutable()) {
            if (_this.next!.isShared()) {
                if (_this.next!.isWild())
                    t.next = sharedWildConstOf(_this.next!);
                else
                    t.next = sharedConstOf(_this.next!);
            } else {
                if (_this.next!.isWild())
                    t.next = wildConstOf(_this.next!);
                else
                    t.next = constOf(_this.next!);
            }
        }
        //printf("TypeNext::makeConst() returns %p, %s\n", t, t.toChars());
        return t;
    };

    const tn = isTypeNext(_this);
    if (tn !== null)
        return typeNextMakeConst(tn);

    return defaultMakeConst(_this);
}

/*******************************
 * dmd/typesem.d:1140 — If _this is a shell around another type, get that other type.
 */
export function toBasetype(_this: Type): Type {
    /* This function is used heavily.
     * De-virtualize it so it can be easily inlined.
     */
    const te = _this.isTypeEnum();
    if (te !== null)
        return toBasetype2(te);
    return _this;
}

/** dmd/typesem.d:1150 */
export function toBasetype2(_this: TypeEnum): Type {
    if (_this.sym!.members === null && _this.sym!.memtype === null)
        return _this;
    const tb = toBasetype(getMemtype(_this.sym!, Loc.initial));
    return castMod(tb, _this.mod); // retain modifier bits from '_this'
}

/** dmd/typesem.d:1158 */
export function memType(_this: TypeEnum): Type {
    return getMemtype(_this.sym!, Loc.initial);
}

/** dmd/typesem.d:1163 — alignment (in bytes) to use for this type. `uint` -> number (09 §1). */
export function alignsize(_this: Type): number {
    // dmd/typesem.d:1165 — nested `static uint structAlignsize(TypeStruct _this)`.
    const structAlignsize = (_this: TypeStruct): number => {
        // D: `import dmd.dsymbolsem : size; _this.sym.size(Loc.initial);` — RENAMED `sizeDsymbol`
        // in the port, because typesem owns the bare `size(Type, Loc)` (04 §1B).
        sizeDsymbol(_this.sym!, Loc.initial); // give error for forward references
        return _this.sym!.alignsize;
    };

    // dmd/typesem.d:1172 — nested `static uint enumAlignsize(TypeEnum _this)`.
    const enumAlignsize = (_this: TypeEnum): number => {
        const t = memType(_this);
        if (t.ty === TY.Terror)
            return 4;
        return alignsize(t);
    };

    const tb = _this.isTypeBasic();
    if (tb !== null)
        return target.alignsize(tb);

    switch (_this.ty) {
        // D: `cast(uint)…size()` — a `uinteger_t` narrowed into the `uint` (number) domain. The
        // 32-bit mask runs in the bigint domain FIRST, so no sentinel transits a JS number
        // (09 §2 mask-then-store, §1.3.1).
        case TY.Tvector: return Number(maskUnsignedN(32, size(_this.isTypeVector()!.basetype)));
        case TY.Tsarray: return alignsize(_this.isTypeSArray()!.next!);
        // A DArray consists of two ptr-sized values, so align it on pointer size boundary
        case TY.Tarray:
        case TY.Tdelegate: return target.ptrsize;
        case TY.Tstruct: return structAlignsize(_this.isTypeStruct()!);
        case TY.Tenum: return enumAlignsize(_this.isTypeEnum()!);
        case TY.Tnoreturn: return 0;
        default: return Number(maskUnsignedN(32, size(_this, Loc.initial)));
    }
}

/*************************************
 * dmd/typesem.d:1204 — Detect if type has pointer fields that are initialized to void.
 * Local stack variables with such void fields can remain uninitialized,
 * leading to pointer bugs.
 * Returns:
 *  true if so
 */
export function hasVoidInitPointers(_this: Type): boolean {
    const tsa = _this.isTypeSArray();
    if (tsa !== null) {
        return hasVoidInitPointers(tsa.next!);
    }
    const ts = _this.isTypeStruct();
    if (ts !== null) {
        sizeDsymbol(ts.sym!, Loc.initial); // give error for forward references
        determineTypeProperties(ts.sym!);
        return ts.sym!.hasVoidInitPointers;
    }
    const te = _this.isTypeEnum();
    if (te !== null) {
        return hasVoidInitPointers(memType(te));
    }
    return false;
}

// ---------------------------------------------------------------------------------------------
// M3 — dmd/typesem.d:1229 `__gshared TY* basetab = [...]` (declared inside `Type_init`). A
// `__gshared` immutable table -> module-level `const` (01 §5.5). `Terror` is BOTH the loop
// terminator (typesem.d:1278) and a separately-assigned entry (typesem.d:1285) — keep it.
// ---------------------------------------------------------------------------------------------
const basetab: readonly TY[] = [
    TY.Tvoid,
    TY.Tint8,
    TY.Tuns8,
    TY.Tint16,
    TY.Tuns16,
    TY.Tint32,
    TY.Tuns32,
    TY.Tint64,
    TY.Tuns64,
    TY.Tint128,
    TY.Tuns128,
    TY.Tfloat32,
    TY.Tfloat64,
    TY.Tfloat80,
    TY.Timaginary32,
    TY.Timaginary64,
    TY.Timaginary80,
    TY.Tcomplex32,
    TY.Tcomplex64,
    TY.Tcomplex80,
    TY.Tbool,
    TY.Tchar,
    TY.Twchar,
    TY.Tdchar,
    TY.Terror,
];

/** dmd/typesem.d:1224 — `void Type_init()`. */
export function Type_init(): void {
    // D: `Type.stringtable._init(14_000);`. mtype.ts declares `static stringtable` WITHOUT a
    // top-level construction (01 Rule 4.5 — no top-level `new` across the core cycle), so the
    // construction happens here, immediately before D's `_init` capacity hint.
    Type.stringtable = new StringTable<Type | null>();
    Type.stringtable._init(14_000);

    // Set basic types
    // (the `basetab` table itself is module-level above — M3)

    /**
     * dmd/typesem.d:1258 — nested `static Type merge(Type t)`.
     *
     * NAME HAZARD (04 §6.1): this nested `merge` SHADOWS the file-level free `merge`
     * (typesem.d:4813). D disambiguates with the leading dot: `.merge(t)` at :1281 is the
     * module-level one, `merge(t)` at :1282 is this one. Renamed `mergeBasic` here so BOTH
     * calls survive; every other `merge` in this file is the module-level one.
     */
    const mergeBasic = (t: Type): Type => {
        // D: function-local `import dmd.mangle.basic : tyToDecoBuffer;` — hoisted to the file's
        // top-level import (01 Rule 4.4).
        const buf = new OutBuffer();
        buf.reserve(3);

        if (t.ty === TY.Tnoreturn)
            buf.writestring(ds("Nn"));
        else
            tyToDecoBuffer(buf, t.ty);

        // `buf[]` is a VIEW (08 §13a.2) -> opSliceAll(); never extractChars here.
        const sv = Type.stringtable.update(buf.opSliceAll(), null);
        if (sv.value !== null)
            return sv.value;
        // D: `t.deco = cast(char*)sv.toDchars();` — the tree's `Type.deco` slot is the JS-string
        // form of the interned ASCII key (mtype.ts:721); `dsToJs` is the field's own model.
        t.deco = dsToJs(sv.toDchars());
        sv.value = t;
        return t;
    };

    for (let i = 0; basetab[i] !== TY.Terror; i++) {
        let t: Type = new TypeBasic(basetab[i]);
        merge(t);          // D `.merge(t)` — the module-level free merge (typesem.d:4813)
        t = mergeBasic(t); // D `merge(t)`  — the Type_init-local one (typesem.d:1258)
        Type.basic[basetab[i]] = t;
    }
    Type.basic[TY.Terror] = new TypeError();

    Type.tnoreturn = new TypeNoreturn();
    Type.tnoreturn.deco = mergeBasic(Type.tnoreturn).deco;
    Type.basic[TY.Tnoreturn] = Type.tnoreturn;

    Type.tvoid = Type.basic[TY.Tvoid]!;
    Type.tint8 = Type.basic[TY.Tint8]!;
    Type.tuns8 = Type.basic[TY.Tuns8]!;
    Type.tint16 = Type.basic[TY.Tint16]!;
    Type.tuns16 = Type.basic[TY.Tuns16]!;
    Type.tint32 = Type.basic[TY.Tint32]!;
    Type.tuns32 = Type.basic[TY.Tuns32]!;
    Type.tint64 = Type.basic[TY.Tint64]!;
    Type.tuns64 = Type.basic[TY.Tuns64]!;
    Type.tint128 = Type.basic[TY.Tint128]!;
    Type.tuns128 = Type.basic[TY.Tuns128]!;
    Type.tfloat32 = Type.basic[TY.Tfloat32]!;
    Type.tfloat64 = Type.basic[TY.Tfloat64]!;
    Type.tfloat80 = Type.basic[TY.Tfloat80]!;

    Type.timaginary32 = Type.basic[TY.Timaginary32]!;
    Type.timaginary64 = Type.basic[TY.Timaginary64]!;
    Type.timaginary80 = Type.basic[TY.Timaginary80]!;

    Type.tcomplex32 = Type.basic[TY.Tcomplex32]!;
    Type.tcomplex64 = Type.basic[TY.Tcomplex64]!;
    Type.tcomplex80 = Type.basic[TY.Tcomplex80]!;

    Type.tbool = Type.basic[TY.Tbool]!;
    Type.tchar = Type.basic[TY.Tchar]!;
    Type.twchar = Type.basic[TY.Twchar]!;
    Type.tdchar = Type.basic[TY.Tdchar]!;

    Type.tshiftcnt = Type.tint32;
    Type.terror = Type.basic[TY.Terror]!;
    Type.tnoreturn = Type.basic[TY.Tnoreturn]!;
    Type.tnull = new TypeNull();
    Type.tnull.deco = mergeBasic(Type.tnull).deco;

    Type.tvoidptr = pointerTo(Type.tvoid);
    Type.tstring = arrayOf(immutableOf(Type.tchar));
    Type.twstring = arrayOf(immutableOf(Type.twchar));
    Type.tdstring = arrayOf(immutableOf(Type.tdchar));

    const isLP64 = target.isLP64;

    Type.tsize_t    = Type.basic[isLP64 ? TY.Tuns64 : TY.Tuns32]!;
    Type.tptrdiff_t = Type.basic[isLP64 ? TY.Tint64 : TY.Tint32]!;
    Type.thash_t = Type.tsize_t;

    // resolved: static if (__VERSION__ == 2081) -> false (__VERSION__ == 2113, 07 §3.2); the
    // `TypeTuple.empty = new TypeTuple();` workaround block (typesem.d:1336-1342) is NOT emitted.
    // D's live initializer is the declaration one at dmd/mtype.d:1927, ported as mtype.ts's static
    // initializer; an in-process host renews it between compiles (`resetTypeGlobals`).
}

/************************************
 * dmd/typesem.d:1348 — Return alignment to use for this type.
 */
export function alignment(_this: Type): structalign_t {
    const tsa = _this.isTypeSArray();
    if (tsa !== null) {
        return alignment(tsa.next!);
    }
    const ts = _this.isTypeStruct();
    if (ts !== null) {
        if (ts.sym!.alignment.isUnknown())
            sizeDsymbol(ts.sym!, ts.sym!.loc);
        // D returns the field BY VALUE (03 §1 #3). `structalign_t` has live mutators
        // (`setDefault`/`set`/`setPack`) so it is NOT in the alias-safe register (03 §9.1):
        // the caller must not alias the aggregate's own slot.
        return ts.sym!.alignment.copy();
    }
    // D: `structalign_t s; s.setDefault(); return s;` — a value struct with LIVE mutators, so it
    // is NOT in the alias-safe register (03 §9.1): a fresh instance is constructed here and
    // returned; the caller owns it.
    const s = new structalign_t();
    s.setDefault();
    return s;
}

/***************************************
 * dmd/typesem.d:1369 — Returns: true if type has any invariants
 */
export function hasInvariant(_this: Type): boolean {
    const tsa = _this.isTypeSArray();
    if (tsa !== null) {
        return hasInvariant(tsa.next!);
    }
    const ts = _this.isTypeStruct();
    if (ts !== null) {
        sizeDsymbol(ts.sym!, Loc.initial); // give error for forward references
        determineTypeProperties(ts.sym!);
        return ts.sym!.hasInvariant() || ts.sym!.hasFieldWithInvariant;
    }
    const te = _this.isTypeEnum();
    if (te !== null) {
        return hasInvariant(memType(te));
    }
    return false;
}

/*************************************
 * dmd/typesem.d:1394 — Detect if this is an unsafe type because of the presence of `@system`
 * members.
 * Returns:
 *  true if so
 */
export function hasUnsafeBitpatterns(_this: Type): boolean {
    // dmd/typesem.d:1396 — nested `static bool tstructImpl(TypeStruct _this)`.
    const tstructImpl = (_this: TypeStruct): boolean => {
        sizeDsymbol(_this.sym!, Loc.initial); // give error for forward references
        determineTypeProperties(_this.sym!);
        return _this.sym!.hasUnsafeBitpatterns;
    };

    const tb = _this.isTypeBasic();
    if (tb !== null)
        return tb.ty === TY.Tbool;

    switch (_this.ty) {
        case TY.Tenum: return hasUnsafeBitpatterns(memType(_this.isTypeEnum()!));
        case TY.Tstruct: return tstructImpl(_this.isTypeStruct()!);
        case TY.Tsarray: return hasUnsafeBitpatterns(_this.isTypeSArray()!.next!);
        default: return false;
    }
}

/*************************************
 * dmd/typesem.d:1428 — Resolve a tuple index, `s[oindex]`, by figuring out what `s[oindex]`
 * represents. Setting one of pe/pt/ps.
 * Params:
 *      loc = location for error messages
 *      sc = context
 *      s = symbol being indexed - could be a tuple, could be an expression
 *      pe = set if s[oindex] is an Expression, otherwise null
 *      pt = set if s[oindex] is a Type, otherwise null
 *      ps = set if s[oindex] is a Dsymbol, otherwise null
 *      oindex = index into s
 */
// D module-private (typesem.d:1428).
function resolveTupleIndex(loc: Loc, sc: Scope, s: Dsymbol, pe: Ref<Expression | null>,
    pt: Ref<Type | null>, ps: Ref<Dsymbol | null>, oindex: RootObject): void {
    // D `out` params: default-init all three slots on entry (03 §3.3).
    pe.value = null;
    pt.value = null;
    ps.value = null;

    const tup = s.isTupleDeclaration();

    // `eindex`/`tindex`/`sindex` are passed to `resolve` as `out` params below, so each is a
    // one-slot box (03 §3.3/§7.2) rather than a plain local.
    const eindex: Ref<Expression | null> = { value: isExpression(oindex) };
    const tindex: Ref<Type | null> = { value: isType(oindex) };
    const sindex: Ref<Dsymbol | null> = { value: isDsymbol(oindex) };

    if (tup === null) {
        // It's really an index expression
        if (tindex.value !== null)
            eindex.value = new TypeExp(loc, tindex.value);
        else if (sindex.value !== null)
            eindex.value = symbolToExp(sindex.value, loc, sc, false);
        let e: Expression = new IndexExp(loc, symbolToExp(s, loc, sc, false), eindex.value);
        e = expressionSemantic(e, sc);
        resolveExp(e, pt, pe, ps);
        return;
    }

    // Convert oindex to Expression, then try to resolve to constant.
    if (tindex.value !== null)
        resolve(tindex.value, loc, sc, eindex, tindex, sindex);
    if (sindex.value !== null)
        eindex.value = symbolToExp(sindex.value, loc, sc, false);
    if (eindex.value === null) {
        error(loc, ds("index `%s` is not an expression"), oindex.toChars());
        pt.value = Type.terror;
        return;
    }

    eindex.value = semanticLengthTupleDecl(sc, tup, eindex.value);
    eindex.value = ctfeInterpret(eindex.value);     // dmd/typesem.d:1462
    if (eindex.value!.op === EXP.error) {
        pt.value = Type.terror;
        return;
    }
    // D: `const(uinteger_t) d = eindex.toUInteger();` — bigint domain end-to-end (09 §1.3.1).
    const d: bigint = toUInteger(eindex.value!);
    if (d >= BigInt(tup.objects!.length)) {
        error(loc, ds("sequence index `%llu` out of bounds `[0 .. %llu]`"),
            d, BigInt(tup.objects!.length));
        pt.value = Type.terror;
        return;
    }

    // D: `(*tup.objects)[cast(size_t)d]`. `Number(d)` is the ONE bigint->number crossing here and
    // it is proved safe by the bounds check immediately above (`d < objects.length`), so no
    // sentinel and no value above 2^53 can transit (09 §1.3 index domain / §1.3.1).
    const o: RootObject = tup.objects!.opIndex(Number(d))!;
    ps.value = isDsymbol(o);
    const t = isType(o);
    if (t !== null)
        pt.value = typeSemantic(t, loc, sc);
    const e = isExpression(o);
    if (e !== null)
        resolveExp(e, pt, pe, ps);
}

/*************************************
 * dmd/typesem.d:1498 — Takes an array of Identifiers and figures out if
 * it represents a Type, Expression, or Dsymbol.
 * Params:
 *      mt = array of identifiers
 *      loc = location for error messages
 *      sc = context
 *      s = symbol to start search at
 *      scopesym = unused
 *      pe = set if expression otherwise null
 *      pt = set if type otherwise null
 *      ps = set if symbol otherwise null
 *      intypeid = set if in TypeidExpression
 *                 https://dlang.org/spec/expression.html#TypeidExpression
 */
// D module-private (typesem.d:1498); called from chunk 2's `resolve`.
function resolveHelper(mt: TypeQualified, loc: Loc, sc: Scope | null, s: Dsymbol | null,
    scopesym: Dsymbol | null, pe: Ref<Expression | null>, pt: Ref<Type | null>,
    ps: Ref<Dsymbol | null>, intypeid = false): void {
    void scopesym; // D documents the parameter as "unused" (typesem.d:1492)

    // D `out` params: default-init all three slots on entry (03 §3.3).
    pe.value = null;
    pt.value = null;
    ps.value = null;

    // resolved: version(none) printf block (typesem.d:1501-1506) -> not taken, dropped (07 §1)

    if (s === null) {
        /* Look for what user might have intended
         */
        const p = unSharedOf(mutableOf(mt)).toChars();
        const id = Identifier.idPool(cstr(p)); // D: `p[0 .. strlen(p)]` (08 §11)
        if (!(sc !== null && sc.inCfile)) {
            const n = importHint(id.toString());
            if (n !== null)
                error(loc, ds("`%s` is not defined, perhaps `import %.*s;` ?"), p, n.length, n);
            else {
                const s2 = search_correctScope(sc!, id);
                if (s2 !== null)
                    error(mt.loc, ds("undefined identifier `%s`, did you mean %s `%s`?"),
                        p, s2.kind(), s2.toChars());
                else {
                    // D: `else if (const q = search_correct_C(id))` (06 §2.6 hoist).
                    const q = search_correct_C(id);
                    if (q !== null)
                        error(mt.loc, ds("undefined identifier `%s`, did you mean `%s`?"), p, q);
                    else if ((id === Id.This && sc!.getStructClassScope() !== null) ||
                             (id === Id._super && sc!.getClassScope() !== null))
                        error(mt.loc, ds("undefined identifier `%s`, did you mean `typeof(%s)`?"), p, p);
                    else
                        error(mt.loc, ds("undefined identifier `%s`"), p);
                }
            }
        } else {
            const n = cIncludeHint(id.toString());
            if (n !== null)
                error(loc, ds("`%s` is not defined, perhaps `#include %.*s` ?"), p, n.length, n);
            else {
                const s2 = search_correctScope(sc!, id);
                if (s2 !== null)
                    error(mt.loc, ds("undefined identifier `%s`, did you mean %s `%s`?"),
                        p, s2.kind(), s2.toChars());
                else
                    error(mt.loc, ds("undefined identifier `%s`"), p);
            }
        }

        pt.value = Type.terror;
        return;
    }

    //printf("\t1: s = '%s' %p, kind = '%s'\n",s.toChars(), s, s.kind());
    const d = s.isDeclaration();
    if (d !== null && (d.storage_class & STC.templateparameter) !== 0n)
        s = toAlias(s);
    else {
        // check for deprecated or disabled aliases
        // functions are checked after overloading
        // templates are checked after matching constraints
        if (s.isFuncDeclaration() === null && s.isTemplateDeclaration() === null)
            checkDeprecated(s, loc, sc!);
        if (d !== null)
            checkDisabled(d, loc, sc!, true);
    }
    s = toAlias(s);
    //printf("\t2: s = '%s' %p, kind = '%s'\n",s.toChars(), s, s.kind());
    for (let i = 0; i < mt.idents.length; i++) {
        const id: RootObject = mt.idents.opIndex(i)!;
        // D: `switch (id.dyncast()) with (DYNCAST)` -> re-qualified case labels (06 §3.3).
        switch (id.dyncast()) {
        case DYNCAST.expression:
        case DYNCAST.type: {
            const tx: Ref<Type | null> = { value: null };
            const ex: Ref<Expression | null> = { value: null };
            const sx: Ref<Dsymbol | null> = { value: null };
            resolveTupleIndex(loc, sc!, s, ex, tx, sx, id);
            if (sx.value !== null) {
                s = toAlias(sx.value);
                continue;
            }
            if (tx.value !== null)
                ex.value = new TypeExp(loc, tx.value);
            assert(ex.value !== null);

            let e2: Expression = typeToExpressionHelper(mt, ex.value!, i + 1);
            e2 = expressionSemantic(e2, sc!);
            resolveExp(e2, pt, pe, ps);
            return;
        }
        default:
            break;
        }

        const t = getType(s); // D: `dmd.dsymbolsem.getType(s)` — type symbol, type alias, or type tuple?
        const errorsave = global.errors;
        const flags: SearchOptFlags = t === null ? SearchOpt.localsOnly : SearchOpt.ignorePrivateImports;

        let sm: Dsymbol | null = searchX(s, loc, sc!, id, flags);
        if (sm !== null) {
            if (!sc!.ignoresymbolvisibility && !symbolIsVisible(sc!, sm)) {
                error(loc, ds("`%s` is not visible from module `%s`"),
                    sm.toPrettyChars(), sc!._module!.toChars());
                sm = null;
            }
            // Same check as in dotIdSemanticProp(DotIdExp)
            else if (sm.isPackage() !== null && checkAccessPackage(sc!, sm.isPackage()!)) {
                // @@@DEPRECATED_2.106@@@
                // Should be an error in 2.106. Just remove the deprecation call
                // and uncomment the null assignment
                deprecation(loc, ds("%s %s is not accessible here, perhaps add 'static import %s;'"),
                    sm.kind(), sm.toPrettyChars(), sm.toPrettyChars());
                //sm = null;
            }
        }
        if (global.errors !== errorsave) {
            pt.value = Type.terror;
            return;
        }

        // dmd/typesem.d:1613 — nested `void helper3()`. Captures the loop variable `i` and the
        // reassigned cursor `s` by reference, exactly as D's nested function does.
        const helper3 = (): void => {
            let e: Expression;
            const v = s!.isVarDeclaration();
            const f = s!.isFuncDeclaration();
            if (intypeid || v === null && f === null)
                e = symbolToExp(s!, loc, sc!, true);
            else
                e = new VarExp(loc, s!.isDeclaration()!, true);

            e = typeToExpressionHelper(mt, e, i);
            e = expressionSemantic(e, sc!);
            resolveExp(e, pt, pe, ps);
        };

        //printf("\t3: s = %p %s %s, sm = %p\n", s, s.kind(), s.toChars(), sm);
        if (intypeid && t === null && sm !== null && sm.needThis())
            return helper3();

        const v = s.isVarDeclaration();
        if (v !== null) {
            // https://issues.dlang.org/show_bug.cgi?id=19913
            // v.type would be null if it is a forward referenced member.
            if (v.type === null)
                dsymbolSemantic(v, sc!);
            if ((v.storage_class & (STC.const_ | STC.immutable_ | STC.manifest)) !== 0n ||
                v.type!.isConst() || v.type!.isImmutable()) {
                // https://issues.dlang.org/show_bug.cgi?id=13087
                // this.field is not constant always
                if (v.isThisDeclaration() === null)
                    return helper3();
            }
        }

        if (sm === null)
            return helper3();

        if (sm.isAliasDeclaration() !== null) // D: `if (sm.isAliasDeclaration)` — optional parens
            checkDeprecated(sm, loc, sc!);
        s = toAlias(sm);
    }

    const em = s.isEnumMember();
    if (em !== null) {
        // It's not a type, it's an expression
        pe.value = getVarExp(em, loc, sc!);
        return;
    }
    const v2 = s.isVarDeclaration();
    if (v2 !== null) {
        /* This is mostly same with DsymbolExp::semantic(), but we cannot use it
         * because some variables used in type context need to prevent lowering
         * to a literal or contextful expression. For example:
         *
         *  enum a = 1; alias b = a;
         *  template X(alias e){ alias v = e; }  alias x = X!(1);
         *  struct S { int v; alias w = v; }
         *      // TypeIdentifier 'a', 'e', and 'v' should be EXP.variable,
         *      // because getDsymbol() need to work in AliasDeclaration::semantic().
         */
        if (v2.type === null ||
            v2.type.deco === null && v2.inuse !== 0) {
            if (v2.inuse !== 0) // https://issues.dlang.org/show_bug.cgi?id=9494
                error(loc, ds("circular reference to %s `%s`"), v2.kind(), v2.toPrettyChars());
            else
                error(loc, ds("forward reference to %s `%s`"), v2.kind(), v2.toPrettyChars());
            pt.value = Type.terror;
            return;
        }
        if (v2.type.ty === TY.Terror)
            pt.value = Type.terror;
        else
            pe.value = new VarExp(loc, v2);
        return;
    }
    const fld = s.isFuncLiteralDeclaration();
    if (fld !== null) {
        //printf("'%s' is a function literal\n", fld.toChars());
        const e = new FuncExp(loc, fld);
        pe.value = expressionSemantic(e, sc!);
        return;
    }
    // resolved: version(none) FuncDeclaration -> DsymbolExp block (typesem.d:1697-1704) -> dropped

    let t: Type | null;
    for (;;) {
        t = getType(s);
        if (t !== null)
            break;
        ps.value = s;
        return;
    }

    const ti = t.isTypeInstance();
    if (ti !== null)
        if (ti !== mt && ti.deco === null) {
            if (!ti.tempinst!.errors)
                error(loc, ds("forward reference to `%s`"), ti.toChars());
            pt.value = Type.terror;
            return;
        }

    if (t.ty === TY.Ttuple)
        pt.value = t;
    else
        pt.value = merge(t);
}

/***************************************
 * dmd/typesem.d:1744 — Search for identifier id as a member of `this`.
 * `id` may be a template instance.
 *
 * Params:
 *  loc = location to print the error messages
 *  sc = the scope where the symbol is located
 *  id = the id of the symbol
 *  flags = the search flags which can be `SearchLocalsOnly` or `SearchOpt.ignorePrivateImports`
 *
 * Returns:
 *      symbol found, NULL if not
 */
// D module-private (typesem.d:1744).
function searchX(dsym: Dsymbol, loc: Loc, sc: Scope, id: RootObject, flags: SearchOptFlags): Dsymbol | null {
    //printf("Dsymbol::searchX(this=%p,%s, ident='%s')\n", this, toChars(), ident.toChars());
    const s = toAlias(dsym);
    let sm: Dsymbol | null;
    const d = s.isDeclaration();
    if (d !== null) {
        if (d.inuse !== 0) {
            error(loc, ds("circular reference to `%s`"), d.toPrettyChars());
            return null;
        }
    }
    switch (id.dyncast()) {
    case DYNCAST.identifier:
        // D: `cast(Identifier)id` — tag-proved by the adjacent `id.dyncast() == DYNCAST.identifier`
        // (02 §11.5c shape 3); RootObject has no `isIdentifier()` accessor in the tree.
        sm = search(s, loc, id as unknown as Identifier, flags);
        break;
    case DYNCAST.dsymbol:
        {
            // It's a template instance
            //printf("\ttemplate instance id\n");
            const st: Dsymbol = isDsymbol(id)!; // D: `cast(Dsymbol)id`
            const ti = st.isTemplateInstance()!;
            sm = search(s, loc, ti.name!);
            if (sm === null)
                return null;
            sm = toAlias(sm);
            const td = sm.isTemplateDeclaration();
            if (td === null)
                return null; // error but handled later
            ti.tempdecl = td;
            if (ti.semanticRun === PASS.initial)  // D: `if (!ti.semanticRun)` — PASS.initial == 0
                dsymbolSemantic(ti, sc);
            sm = toAlias(ti);
            break;
        }
    case DYNCAST.type:
    case DYNCAST.expression:
    default:
        return assertUnreachable(); // D `assert(0)` (typesem.d:1784)
    }
    return sm;
}

/***************************************************
 * dmd/typesem.d:1796 — Determine if type t is copyable.
 * Params:
 *      t = type to check
 * Returns:
 *      true if we can copy it
 */
export function isCopyable(t: Type): boolean {
    //printf("isCopyable() %s\n", t.toChars());
    const ts = t.isTypeStruct();
    if (ts !== null) {
        if (ts.sym!.postblit !== null &&
            (ts.sym!.postblit.storage_class & STC.disable) !== 0n)
            return false;
        if (ts.sym!.hasCopyCtor) {
            // check if there is a matching overload of the copy constructor and whether it is disabled or not
            // `assert(ctor)` fails on Win32 and Win_32_64. See: https://auto-tester.puremagic.com/pull-history.ghtml?projectid=1&repoid=1&pullid=10575
            const ctor = search_function(ts.sym, Id.ctor!);
            assert(ctor !== null);
            const el = new IdentifierExp(Loc.initial, Id.p!); // dummy lvalue
            el.type = ts; // D: `cast() ts` — strips `const`, erased (04 §8)
            const args: Expressions = new DArray<Expression | null>();
            args.push(el);
            // typesem.d:1813; `cast()ts` erased (04 §8)
            const f = resolveFuncCall(Loc.initial, null, ctor, null, ts, new ArgumentList(args), FuncResolveFlag.quiet);
            if (f === null || (f.storage_class & STC.disable) !== 0n)
                return false;
        }
    }
    return true;
}

/**************************
 * dmd/typesem.d:1829 — When T is mutable,
 * Given:
 *      T a, b;
 * Can we bitwise assign:
 *      a = b;
 * ?
 */
export function isAssignable(t: Type): boolean {
    const te = t.isTypeEnum();
    if (te !== null)
        t = memType(te);
    const ts = t.isTypeStruct();
    if (ts === null)
        return true;

    let assignable = true;
    let offset = 0xFFFFFFFF; // D: `uint offset = ~0;` — dead-store to prevent spurious warning

    const sym = ts.sym!;
    determineSize(sym, sym.loc);

    /* If any of the fields are const or immutable,
     * then one cannot assign this struct.
     */
    for (let i = 0; i < sym.fields.length; i++) {
        const v: VarDeclaration = sym.fields.opIndex(i)!;
        //printf("%s [%d] v = (%s) %s, v.offset = %d, v.parent = %s\n", sym.toChars(), i, v.kind(), v.toChars(), v.offset, v.parent.kind());
        if (i === 0) {
            // (empty in D)
        } else if (v.offset === offset) {
            /* If any fields of anonymous union are assignable,
             * then regard union as assignable.
             * This is to support unsafe things like Rebindable templates.
             */
            if (assignable)
                continue;
        } else {
            if (!assignable)
                return false;
        }
        assignable = v.type!.isMutable() && isAssignable(v.type!);
        offset = v.offset;
        //printf(" -> assignable = %d\n", assignable);
    }

    return assignable;
}

/************************************
 * dmd/typesem.d:1886 — Determine mutability of indirections in (ref) t.
 *
 * Returns: When the type has any mutable indirections, returns 0.
 * When all indirections are immutable, returns 2.
 * Otherwise, when the type has const/inout indirections, returns 1.
 *
 * Params:
 *      isRef = if true, check `ref t`; otherwise, check just `t`
 *      t = the type that is being checked
 */
export function mutabilityOfType(isRef: boolean, t: Type): number {
    if (isRef) {
        if ((t.mod & MODFlags.immutable_) !== 0)
            return 2;
        if ((t.mod & (MODFlags.const_ | MODFlags.wild)) !== 0)
            return 1;
        return 0;
    }

    t = baseElemOf(t);

    if (!hasPointers(t) || (t.mod & MODFlags.immutable_) !== 0)
        return 2;

    /* Accept immutable(T)[] and immutable(T)* as being strongly pure
     */
    if (t.ty === TY.Tarray || t.ty === TY.Tpointer) {
        const tn = toBasetype(nextOf(t)!);
        if ((tn.mod & MODFlags.immutable_) !== 0)
            return 2;
        if ((tn.mod & (MODFlags.const_ | MODFlags.wild)) !== 0)
            return 1;
    }

    /* The rest of this is too strict; fix later.
     * For example, the only pointer members of a struct may be immutable,
     * which would maintain strong purity.
     * (Just like for dynamic arrays and pointers above.)
     */
    if ((t.mod & (MODFlags.const_ | MODFlags.wild)) !== 0)
        return 1;

    /* Should catch delegates and function pointers, and fold in their purity
     */
    return 0;
}

/********************************************
 * dmd/typesem.d:1930 — Set 'purity' field of 'typeFunction'.
 * Do this lazily, as the parameter types might be forward referenced.
 */
export function purityLevel(typeFunction: TypeFunction): void {
    const tf: TypeFunction = typeFunction;
    if (tf.purity !== PURE.fwdref)
        return;

    typeFunction.purity = PURE.const_; // assume strong until something weakens it

    /* Evaluate what kind of purity based on the modifiers for the parameters
     */
    // D: `foreach (i, fparam; tf.parameterList)` — ParameterList.opApply, control-code protocol
    // (05 §11 / 06 §1.8): 0 continues, non-zero breaks.
    tf.parameterList.opApply((_i: number, fparam: Parameter): number => {
        const t = fparam.type;
        if (t === null)
            return 0; // D: `continue;`

        if ((fparam.storageClass & (STC.lazy_ | STC.out_)) !== 0n) {
            typeFunction.purity = PURE.weak;
            return 1; // D: `break;`
        }
        const pref = (fparam.storageClass & STC.ref_) !== 0n;
        if (mutabilityOfType(pref, t) === 0)
            typeFunction.purity = PURE.weak;
        return 0;
    });

    tf.purity = typeFunction.purity;
}

/*************************************
 * dmd/typesem.d:1968 — https://issues.dlang.org/show_bug.cgi?id=14488
 * Check if the inner most base type is complex or imaginary.
 * Should only give alerts when set to emit transitional messages.
 * Params:
 *  type = type to check
 *  loc = The source location.
 *  sc = scope of the type
 */
export function checkComplexTransition(type: Type, loc: Loc, sc: Scope): boolean {
    if (sc.isDeprecated())
        return false;
    // Don't complain if we're inside a template constraint
    // https://issues.dlang.org/show_bug.cgi?id=21831
    if (sc.inTemplateConstraint)
        return false;

    let t = baseElemOf(type);
    while (t.ty === TY.Tpointer || t.ty === TY.Tarray)
        t = baseElemOf(nextOf(t)!);

    // Basetype is an opaque enum, nothing to check.
    // D: `(cast(TypeEnum)t).sym` — tag-proved by the adjacent `t.ty == Tenum` (shape 3).
    if (t.ty === TY.Tenum && t.isTypeEnum()!.sym!.memtype === null)
        return false;

    if (isImaginary(t) || isComplex(t)) {
        if (sc.inCfile)
            return true;            // complex/imaginary not deprecated in C code
        let rt: Type;
        switch (t.ty) {
        case TY.Tcomplex32:
        case TY.Timaginary32:
            rt = Type.tfloat32;
            break;

        case TY.Tcomplex64:
        case TY.Timaginary64:
            rt = Type.tfloat64;
            break;

        case TY.Tcomplex80:
        case TY.Timaginary80:
            rt = Type.tfloat80;
            break;

        default:
            return assertUnreachable(); // D `assert(0)` (typesem.d:2008)
        }
        // @@@DEPRECATED_2.117@@@
        // Deprecated in 2.097 - Can be made an error from 2.117.
        // The deprecation period is longer than usual as `cfloat`,
        // `cdouble`, and `creal` were quite widely used.
        if (isComplex(t)) {
            deprecation(loc, ds("use of complex type `%s` is deprecated, use `std.complex.Complex!(%s)` instead"),
                type.toChars(), rt.toChars());
            return true;
        } else {
            deprecation(loc, ds("use of imaginary type `%s` is deprecated, use `%s` instead"),
                type.toChars(), rt.toChars());
            return true;
        }
    }
    return false;
}

/**
 * dmd/typesem.d:2038 — Look for the index of parameter `ident` in the parameter list
 *
 * Params:
 *   tf = function type
 *   ident = identifier of parameter to search for
 * Returns: index of parameter with name `ident` or -1 if not found
 */
// D module-private (typesem.d:2038). `ptrdiff_t` -> number with the -1 not-found sentinel (09 §1.3).
function findParameterIndex(tf: TypeFunction, ident: Identifier): number {
    let found = -1;
    tf.parameterList.opApply((i: number, p: Parameter): number => {
        if (p.ident === ident) {
            found = i;
            return 1; // D: `return i;` — leave the foreach carrying the result
        }
        return 0;
    });
    return found;
}

/*********************************
 * dmd/typesem.d:2054 — Append error message to buf.
 * Input:
 *  buf = message sink
 *  format = printf format
 *
 * D `private extern(C) void getMatchError(ref OutBuffer buf, const(char)* format, ...)` — the
 * C-variadic becomes `...args: unknown[]` forwarded to `OutBuffer.vprintf` (04 §3.1). `ref
 * OutBuffer` is an alias: pass the object, never a copy (03 §3.2).
 */
// D module-private (typesem.d:2054).
function getMatchError(buf: OutBuffer, format: DString, ...args: unknown[]): void {
    if (global.gag !== 0 && !global.params.v.showGaggedErrors)
        return;
    // D: `va_list ap; va_start(ap, format); buf.vprintf(format, ap); va_end(ap);` — the va_list
    // scaffolding erases; the rest arguments ARE the list (04 §3.1).
    buf.vprintf(format, args);
}

/********************************
 * dmd/typesem.d:2074 — Convert an `argumentList`, which may contain named arguments, into
 * a list of arguments in the order of the parameter list.
 *
 * Params:
 *   tf = function type
 *      argumentList = array of function arguments
 *      buf = if not null, append error message to it
 * Returns: re-ordered argument list, or `null` on error
 */
export function resolveNamedArgs(tf: TypeFunction, argumentList: ArgumentList,
    buf: OutBuffer | null): Expressions | null {
    // D: `argumentList.arguments ? (*argumentList.arguments)[] : null` — the null slice is modeled
    // as an empty array: D never pointer-tests `args`/`names` (06 §2.8), only indexes and reads
    // `.length`, and a D null slice has length 0.
    const args: (Expression | null)[] =
        argumentList.arguments_ !== null ? argumentList.arguments_.opSlice() : [];
    const names: ArgumentLabel[] =
        argumentList.names !== null ? argumentList.names.opSlice() : [];
    const nParams = tf.parameterList.length(); // cached because O(n)
    const newArgs: Expressions = new DArray<Expression | null>(nParams);
    // D `newArgs.zero()` (array.d:323) sets all `nParams` slots to `Expression.init` == `null`, and
    // BOTH loops below READ those slots — `if ((*newArgs)[ci])` (typesem.d:2116) and the trailing
    // missing-argument scan (typesem.d:2124). The port's `Array.zero()` is a documented NO-OP (08
    // §2.0a: there is no generic `T.init`), and its doc-comment mandates exactly this: "special-case
    // at the single known `T`". Here `T` is `Expression`, whose `.init` is `null` (09 §1.0). Without
    // the fill every slot reads `undefined`, `undefined !== null` is true, and the "assigned twice"
    // guard fires on the FIRST positional argument of every call. (Reproduced, then fixed.)
    for (let i = 0; i < nParams; i++)
        newArgs.opIndexAssign(null, i);
    let ci = 0;
    let hasNamedArgs = false;
    const isVariadic: boolean = tf.parameterList.varargs !== VarArg.none;
    for (const [i, arg] of args.entries()) {
        if (arg === null) {
            ci++;
            continue;
        }
        const name = i < names.length ? names[i].name : null;
        if (name !== null) {
            hasNamedArgs = true;
            const pi = findParameterIndex(tf, name);
            if (pi === -1) {
                if (buf !== null)
                    getMatchError(buf, ds("no parameter named `%s`"), name.toChars());
                return null;
            }
            ci = pi;
        }
        if (ci >= newArgs.length) {
            if (!isVariadic) {
                // Without named args, let the caller diagnose argument overflow
                if (hasNamedArgs && buf !== null)
                    getMatchError(buf, ds("argument `%s` goes past end of parameter list"), arg.toChars());
                return null;
            }
            while (ci >= newArgs.length)
                newArgs.push(null);
        }

        if (newArgs.opIndex(ci) !== null) {
            if (buf !== null)
                getMatchError(buf, ds("parameter `%s` assigned twice"),
                    tf.parameterList.opIndex(ci)!.toChars());
            return null;
        }
        newArgs.opIndexAssign(arg, ci); // D: `(*newArgs)[ci++] = arg;`
        ci++;
    }
    for (const [i, arg] of newArgs.opSlice().entries()) {
        if (arg !== null || tf.parameterList.opIndex(i)!.defaultArg !== null)
            continue;

        if (isVariadic && i + 1 === newArgs.length)
            continue;

        // dtemplate sets `defaultArg=null` to avoid semantic on default arguments,
        // don't complain about missing arguments in that case
        if (tf.incomplete)
            continue;

        if (buf !== null) {
            // `parameterToChars` (dmd/hdrgen.d:3634) takes `Parameter | null`, so
            // `parameterList[i]`'s nullable slot passes through unchanged.
            getMatchError(buf, ds("missing argument for parameter #%d: `%s`"),
                          i + 1, parameterToChars(tf.parameterList.opIndex(i), tf, false));
        }
        return null;
    }
    // strip trailing nulls from default arguments
    let e = newArgs.length;
    while (e > 0 && newArgs.opIndex(e - 1) === null) {
        --e;
    }
    newArgs.setDim(e);
    return newArgs;
}

/********************************
 * dmd/typesem.d:2167 — 'args' are being matched to function type 'tf'.
 * Determine match level.
 * Params:
 *      fd = function being called, if a symbol
 *      tf = function type
 *      tthis = type of `this` pointer, null if not member function
 *      argumentList = arguments to function call
 *      flag = 1: performing a partial ordering match
 *      errorHelper = delegate to call for error messages
 *      sc = context
 * Returns:
 *      MATCHxxxx
 *
 * PROTOCOL NOTE (04 §0.1): 1.43 widened `errorHelper` from `void delegate(const(char)*)` to
 * `void delegate(const(char)*, Loc argloc = Loc.initial)`, and added the two-argument call at
 * typesem.d:2343 with its own early `return MATCH.nomatch`. Ported verbatim — expressionsem.ts
 * already imports `callMatch`, so this is a signature change its call sites must absorb.
 */
export function callMatch(fd: FuncDeclaration | null, tf: TypeFunction, tthis: Type | null,
    argumentList: ArgumentList, flag = 0,
    errorHelper: ((msg: DString, argloc?: Loc) => void) | null = null,
    sc: Scope | null = null): MATCH {
    //printf("callMatch() fd: %s, tf: %s\n", fd ? fd.ident.toChars() : "null", toChars(tf));
    let match: MATCH = MATCH.exact; // assume exact match
    let wildmatch = 0;              // D `ubyte wildmatch = 0;`

    if (tthis !== null) {
        let t: Type = tthis;
        if (toBasetype(t).ty === TY.Tpointer)
            t = nextOf(toBasetype(t))!; // change struct* to struct
        if (t.mod !== tf.mod) {
            if (MODimplicitConv(t.mod, tf.mod))
                match = MATCH.constant;
            else if ((tf.mod & MODFlags.wild) !== 0 &&
                     MODimplicitConv(t.mod, (tf.mod & ~MODFlags.wild) | MODFlags.const_)) {
                match = MATCH.constant;
            } else
                return MATCH.nomatch;
        }
        if (tf.isWild()) {
            if (t.isWild())
                wildmatch |= MODFlags.wild;
            else if (t.isConst())
                wildmatch |= MODFlags.const_;
            else if (t.isImmutable())
                wildmatch |= MODFlags.immutable_;
            else
                wildmatch |= MODFlags.mutable;
        }
    }

    // D: `ParameterList* parameterList = &tf.parameterList;` — an intentional alias to a value
    // struct: share the object, NO copy (02 §10 `Struct*` row, 03 §7.2).
    const parameterList: ParameterList = tf.parameterList;
    const nparams = parameterList.length();
    if (argumentList.length() > nparams) {
        if (parameterList.varargs === VarArg.none) {
            // suppress early exit if an error message is wanted,
            // so we can check any matching args are valid
            if (errorHelper === null)
                return MATCH.nomatch;
        }
        // too many args; no match
        match = MATCH.convert; // match ... with a "conversion" match level
    }

    // https://issues.dlang.org/show_bug.cgi?id=22997
    if (parameterList.varargs === VarArg.none && nparams > argumentList.length() &&
        !parameterList.hasDefaultArgs()) {
        if (errorHelper !== null) {
            const buf0 = new OutBuffer();
            buf0.printf(ds("too few arguments, expected %d, got %d"), nparams, argumentList.length());
            errorHelper(buf0.peekChars());
        }
        return MATCH.nomatch;
    }
    // D: `const(char)* failMessage; const(char)** pMessage = errorHelper ? &failMessage : null;`
    // — `failMessage` is a slot the callees write THROUGH `pMessage` (03 §7.2 box).
    const failMessage: Ref<DString | null> = { value: null };
    const pMessage: Ref<DString | null> | null = errorHelper !== null ? failMessage : null;
    const buf = new OutBuffer();
    // D passes `argumentList` BY VALUE (03 §1 #2 — copy at the call site).
    const resolvedArgs = resolveNamedArgs(tf, argumentList.copy(), errorHelper !== null ? buf : null);
    let args: (Expression | null)[];
    if (resolvedArgs === null) {
        if (buf.length() !== 0) {
            errorHelper!(buf.peekChars());
            return MATCH.nomatch;
        }

        // if no message was provided, it was because of overflow which will be diagnosed below
        match = MATCH.nomatch;
        args = argumentList.arguments_ !== null ? argumentList.arguments_.opSlice() : [];
    } else {
        args = resolvedArgs.opSlice();
    }

    parameterList.opApply((u: number, p: Parameter): number => {
        if (u >= args.length)
            return 1; // D: `break;`

        const arg = args[u];
        if (arg === null)
            return 0; // default argument -> D `continue;`

        const tprm = p.type!;
        const targ = arg.type!;

        if (!(p.isLazy() && tprm.ty === TY.Tvoid && targ.ty !== TY.Tvoid)) {
            const isRef = p.isReference();
            wildmatch |= deduceWild(targ, tprm, isRef);
        }
        return 0;
    });
    if (wildmatch !== 0) {
        /* Calculate wild matching modifier
         */
        if ((wildmatch & MODFlags.const_) !== 0 || (wildmatch & (wildmatch - 1)) !== 0)
            wildmatch = MODFlags.const_;
        else if ((wildmatch & MODFlags.immutable_) !== 0)
            wildmatch = MODFlags.immutable_;
        else if ((wildmatch & MODFlags.wild) !== 0)
            wildmatch = MODFlags.wild;
        else {
            assert((wildmatch & MODFlags.mutable) !== 0);
            wildmatch = MODFlags.mutable;
        }
    }

    // D's second `foreach (u, p; *parameterList)` carries TWO early `return`s out of callMatch.
    // The opApply protocol only signals "stop", so the returned MATCH travels in a local slot.
    let earlyResult: MATCH | null = null;
    parameterList.opApply((u: number, p: Parameter): number => {
        let m: MATCH = MATCH.nomatch; // D `MATCH m;` — MATCH.init is the FIRST member (09 §1.0)

        assert(p !== null);

        // One or more arguments remain
        if (u < args.length) {
            const arg = args[u];
            if (arg === null)
                return 0; // default argument -> D `continue;`
            m = argumentMatchParameter(fd, tf, p, arg, wildmatch, flag, sc, pMessage);
            if (failMessage.value !== null) {
                buf.reset();
                buf.writestring(failMessage.value);
            }
        } else if (p.defaultArg !== null)
            return 0; // D `continue;`

        /* prefer matching the element type rather than the array
         * type when more arguments are present with T[]...
         */
        // G4 (06 §4 SKIP-FLAG): D's `goto L1;` jumps INTO the `if (m == MATCH.nomatch)` block,
        // skipping its test. The flag gates the test; the L1 body stays in place.
        let gotoL1 = false;
        if (parameterList.varargs === VarArg.typesafe && u + 1 === nparams && args.length > nparams)
            gotoL1 = true; // goto L1 (dmd/typesem.d:2312)

        //printf("\tm = %d\n", m);
        if (gotoL1 || m === MATCH.nomatch) // if no match
        {
            // L1:
            if (parameterList.varargs === VarArg.typesafe && u + 1 === nparams) { // if last varargs param
                let trailingArgs: (Expression | null)[] = [];
                if (args.length >= u)
                    trailingArgs = args.slice(u);
                const vmatch = matchTypeSafeVarArgs(tf, p, trailingArgs, pMessage);
                if (vmatch !== MATCH.nomatch) { // D: `if (auto vmatch = …)` (09 §9 MATCH truthiness)
                    earlyResult = vmatch < match ? vmatch : match;
                    return 1;
                }
                // Error message was already generated in `matchTypeSafeVarArgs`
                if (failMessage.value !== null)
                    errorHelper!(failMessage.value);
                earlyResult = MATCH.nomatch;
                return 1;
            }
            if (errorHelper !== null) {
                if (u >= args.length) {
                    getMatchError(buf, ds("missing argument for parameter #%d: `%s`"),
                                  u + 1, parameterToChars(p, tf, false));
                }
                // If an error happened previously, `pMessage` was already filled
                else if (buf.length() === 0) {
                    // typesem.d:2340 `writestring(const(char)*)`: the bytes before the NUL. getParamError
                    // answers null under a gag (typesem.d:2664), and that overload writes nothing for a
                    // null pointer (common/outbuffer.d:260 `if (!s) return;`): the TS OutBuffer drops the
                    // `const(char)*` overload, so its null test lands here.
                    const paramError = getParamError(tf, args[u]!, p);
                    if (paramError !== null)
                        buf.writestring(cstr(paramError));
                    if (!args[u]!.loc.opEquals(Loc.initial)) { // D: `args[u].loc !is Loc.initial`
                        errorHelper(buf.peekChars(), args[u]!.loc);
                        earlyResult = MATCH.nomatch;
                        return 1;
                    }
                }
                errorHelper(buf.peekChars());
            }
            earlyResult = MATCH.nomatch;
            return 1;
        }
        if (m < match)
            match = m; // pick worst match
        return 0;
    });
    if (earlyResult !== null)
        return earlyResult;

    if (errorHelper !== null && parameterList.varargs === VarArg.none && args.length > nparams) {
        // all parameters had a match, but there are surplus args
        const buf2 = new OutBuffer();
        getMatchError(buf2, ds("expected %d argument(s), not %d"), nparams, args.length);
        errorHelper(buf2.extractChars()); // CONSUMES buf2 (08 §13a.2) — faithful to D
        return MATCH.nomatch;
    }
    //printf("match = %d\n", match);
    return match;
}

/**
 * dmd/typesem.d:2377 — Used by `callMatch` to check if the copy constructor may be called to
 * copy the argument
 *
 * This is done by seeing if a call to the copy constructor can be made:
 * ```
 * typeof(tprm) __copytemp;
 * copytemp.__copyCtor(arg);
 * ```
 */
// D module-private (typesem.d:2377).
function isCopyConstructorCallable(argStruct: StructDeclaration, arg: Expression, tprm: Type,
    sc: Scope, pMessage: Ref<DString | null> | null): boolean {
    //printf("isCopyConstructorCallable() argStruct: %s arg: %s tprm: %s\n", argStruct.toChars(), toChars(arg), toChars(tprm));
    const tmp = new VarDeclaration(arg.loc, tprm, Identifier.generateId(ds("__copytemp")), null);
    // branded flag-enum re-cast after a bitwise OR (02 §11.5c shape 4) — D's implicit `STC` result.
    tmp.storage_class = (STC.rvalue | STC.temp | STC.ctfe) as STC;
    dsymbolSemantic(tmp, sc);
    const ve: Expression = new VarExp(arg.loc, tmp);
    let e: Expression = new DotIdExp(arg.loc, ve, Id.ctor!);
    // D: `new CallExp(arg.loc, e, arg)` — the single-Expression-argument ctor; the tree names that
    // same-arity Form-B overload `CallExp.fromArg` (04 §1.1(c)).
    e = CallExp.fromArg(arg.loc, e, arg);
    //printf("e = %s\n", e.toChars());
    // D: `if (dmd.expressionsem.trySemantic(e, sc))` — module-qualified in D because this module
    // declares its own `trySemantic(Type, …)` (typesem.d:4779); the import is renamed to match.
    if (expressionsemTrySemantic(e, sc) !== null)
        return true;

    if (pMessage === null)
        return false;

    /* https://issues.dlang.org/show_bug.cgi?id=22202
     *
     * If a function was deduced by semantic on the CallExp,
     * it means that resolveFuncCall completed succesfully.
     * Therefore, there exists a callable copy constructor,
     * however, it cannot be called because scope constraints
     * such as purity, safety or nogc.
     */
    const buf = new OutBuffer();
    const callExp = e.isCallExp();

    // dmd/typesem.d:2405 — nested `bool nocpctor()`.
    const nocpctor = (): boolean => {
        buf.printf(ds("`struct %s` does not define a copy constructor for `%s` to `%s` copies"),
                   argStruct.toChars(), arg.type!.toChars(), tprm.toChars());
        pMessage.value = buf.extractChars(); // CONSUMES buf — faithful to D
        return false;
    };

    const f = callExp!.f;
    if (f === null)
        return nocpctor();

    if (f.isDisabled() && !f.isGenerated) {
        /* https://issues.dlang.org/show_bug.cgi?id=24301
         * Copy constructor is explicitly disabled
         */
        buf.printf(ds("`%s` copy constructor cannot be used because it is annotated with `@disable`"),
            f.type!.toChars());
        pMessage.value = buf.extractChars();
        return false;
    }

    // D: `!f.isPure` — `isPure` (funcsem.d:3684) returns a PURE enum; enum truthiness must be
    // expanded (06 §2.5 / 09 §9.1). PURE.impure == 0.
    const bpure = isPure(f) === PURE.impure && setImpure(sc.func!, arg.loc, null);
    // D passes a null format: only inference is affected (safe.d:469).
    const bsafe = !isSafe(f) && !isTrusted(f) && setUnsafe(sc, false, arg.loc, null);
    const bnogc = !isNogc(f) && setGC(sc, sc.func!, arg.loc, null);
    if (bpure || bsafe || bnogc) { // D: `if (bpure | bsafe | bnogc)` — bitwise-OR of three bools
        const nullptr = ds("");
        buf.printf(ds("`%s` copy constructor cannot be called from a `%s%s%s` context"),
            f.type!.toChars(),
            bpure ? ds("pure ") : nullptr,
            bsafe ? ds("@safe ") : nullptr,
            bnogc ? ds("nogc") : nullptr);
    } else if (f.isGenerated && f.isDisabled()) {
        /* https://issues.dlang.org/show_bug.cgi?id=23097
         * Compiler generated copy constructor failed.
         */
        buf.printf(ds("generating a copy constructor for `struct %s` failed, therefore instances of it are uncopyable"),
                   argStruct.toChars());
    } else {
        /* Although a copy constructor may exist, no suitable match was found.
         * i.e: `inout` constructor creates `const` object, not mutable.
         * Fallback to using the original generic error before https://issues.dlang.org/show_bug.cgi?id=22202.
         */
        return nocpctor();
    }

    pMessage.value = buf.extractChars();

    return false;
}

/**
 * dmd/typesem.d:2483 — Match a single parameter to an argument.
 *
 * This function is called by `TypeFunction.callMatch` while iterating over
 * the list of parameter. Here we check if `arg` is a match for `p`,
 * which is mostly about checking if `arg.type` converts to type of `p`
 * and some check about value reference.
 *
 * Params:
 *   fd = the function being called if symbol, null if not
 *   tf = The `TypeFunction`, only used for error reporting
 *   p = The parameter of `tf` being matched
 *   arg = Argument being passed (bound) to `p`
 *   wildmatch = Wild (`inout`) matching level, derived from the full argument list
 *   flag = A non-zero value means we are doing a partial ordering check
 *          (no value semantic check)
 *   sc = Scope we are in
 *   pMessage = A buffer to write the error in, or `null`
 *
 * Returns: Whether `trailingArgs` match `p`.
 */
// D module-private (typesem.d:2483).
function argumentMatchParameter(fd: FuncDeclaration | null, tf: TypeFunction, p: Parameter,
    arg: Expression, wildmatch: number, flag: number, sc: Scope | null,
    pMessage: Ref<DString | null> | null): MATCH {
    // resolved: static if (0) printf block (typesem.d:2486-2488) -> not taken, dropped (07 §3)
    let m: MATCH = MATCH.nomatch; // D `MATCH m;` — MATCH.init is the FIRST member (09 §1.0)
    let targ = arg.type!;
    const tprm = wildmatch !== 0 ? substWildTo(p.type!, wildmatch) : p.type!;

    if (p.isLazy() && tprm.ty === TY.Tvoid && targ.ty !== TY.Tvoid)
        m = MATCH.convert;
    else if (flag !== 0) {
        // for partial ordering, value is an irrelevant mockup, just look at the type
        // D `targ.implicitConvTo(tprm)` — UFCS onto the free `implicitConvTo(Type from, Type to)`
        // (dcast.d:1558), ported as `implicitConvToType` (04 §1B: the Expression-first overload
        // dcast.d:312 keeps the plain name).
        m = implicitConvToType(targ, tprm);
    } else {
        const isRef = p.isReference();

        let argStruct: StructDeclaration | null = null;
        let prmStruct: StructDeclaration | null = null;
        if (targ.ty === TY.Tstruct && tprm.ty === TY.Tstruct) {
            // if the argument and the parameter are of the same unqualified struct type
            // D: `(cast(TypeStruct)targ).sym` — tag-proved by the adjacent ty tests (shape 3).
            argStruct = targ.isTypeStruct()!.sym;
            prmStruct = tprm.isTypeStruct()!.sym;

            /* if both a copy constructor and move constructor exist, then match
             * the lvalue to the copy constructor only and the rvalue to the move constructor
             * only
             */
            if (argStruct === prmStruct && fd !== null) {
                const cfd = fd.isCtorDeclaration();
                if (cfd !== null) {
                    /* Get struct that constructor is making
                     */

                    const t1 = toBasetype(cfd.type!);
                    const t2 = nextOf(t1);
                    const t3 = t2!.isTypeStruct();
                    if (t3 !== null) {
                    const ctorStruct = t3.sym;
//                    StructDeclaration ctorStruct = cfd.type.toBasetype().nextOf().isTypeStruct().sym;

                    if (prmStruct === ctorStruct && ctorStruct!.hasCopyCtor && ctorStruct!.hasMoveCtor) {
                        if (cfd.isCpCtor && !isLvalue(arg))
                            return MATCH.nomatch;       // copy constructor is only for lvalues
                        if (cfd.isMoveCtor && isLvalue(arg))
                            return MATCH.nomatch;       // move constructor is only for rvalues
                    }
                    }
                }
            }
        }

        // check if the copy constructor may be called to copy the argument
        if (isLvalue(arg) && !isRef && argStruct !== null && argStruct === prmStruct &&
            argStruct.hasCopyCtor &&
            !isCopyConstructorCallable(argStruct, arg, tprm, sc!, pMessage)) {
            return MATCH.nomatch;
        } else {
            // D: function-local `import dmd.dcast : cimplicitConvTo;` (typesem.d:2550), hoisted to
            // the file-level dcast import (01 Rule 4.4).
            m = (sc !== null && sc.inCfile) ? cimplicitConvTo(arg, tprm) : implicitConvTo(arg, tprm);
        }
    }

    // Non-lvalues do not match ref or out parameters
    if (!p.isReference())
        return m;

    // https://issues.dlang.org/show_bug.cgi?id=13783
    // Don't use toBasetype() to handle enum types.
    let ta = targ;
    const tp = tprm;
    //printf("fparam[%d] ta = %s, tp = %s\n", u, ta.toChars(), tp.toChars());

    if (m !== MATCH.nomatch && !isLvalue(arg)) { // D: `if (m && …)` (09 §9 MATCH truthiness)
        if ((p.storageClass & STC.out_) !== 0n) {
            if (pMessage !== null) pMessage.value = getParamError(tf, arg, p);
            return MATCH.nomatch;
        }

        if (arg.op === EXP.string_ && tp.ty === TY.Tsarray) {
            if (ta.ty !== TY.Tsarray) {
                const tn = castMod(nextOf(tp)!, nextOf(ta)!.mod);
                const dim: bigint = BigInt(arg.isStringExp()!.len); // D: `(cast(StringExp)arg).len`
                ta = sarrayOf(tn, dim);
            }
        } else if (arg.op === EXP.slice && tp.ty === TY.Tsarray) {
            // Allow conversion from T[lwr .. upr] to ref T[upr-lwr]
            if (ta.ty !== TY.Tsarray) {
                const tn = nextOf(ta)!;
                // D: `(cast(TypeSArray)tp).dim.toUInteger()` — bigint domain (09 §1.3.1).
                const dim: bigint = toUInteger(tp.isTypeSArray()!.dim!);
                ta = sarrayOf(tn, dim);
            }
        } else if ((p.storageClass & STC.constscoperef) !== 0n) {
            // Allow converting a literal to an `in` which is `ref`
            if (arg.op === EXP.arrayLiteral && tp.ty === TY.Tsarray) {
                const tn = nextOf(tp)!;
                // D: `(cast(TypeSArray)tp).dim.toUInteger()` — see above.
                const dim: bigint = toUInteger(tp.isTypeSArray()!.dim!);
                ta = sarrayOf(tn, dim);
            }

            // Need to make this a rvalue through a temporary
            m = MATCH.convert;
        } else if (!(sc !== null && sc.previews.rvalueRefParam) ||
                 (p.storageClass & STC.out_) !== 0n ||
                 !isCopyable(arg.type!)) {  // can't copy to temp for ref parameter
            if (pMessage !== null) pMessage.value = getParamError(tf, arg, p);
            return MATCH.nomatch;
        } else {
            /* in functionParameters() we'll convert this
             * rvalue into a temporary
             */
            m = MATCH.convert;
        }
    }

    /* If the match is not already perfect or if the arg
       is not a lvalue then try the `alias this` chain
       see  https://issues.dlang.org/show_bug.cgi?id=15674
       and https://issues.dlang.org/show_bug.cgi?id=21905
    */
    if (ta !== tp || !isLvalue(arg)) {
        const firsttab = toBasetype(ta);
        for (;;) {
            const tab = toBasetype(ta);
            const tat = aliasthisOf(tab);
            // D `tat.implicitConvTo(tprm)` — UFCS onto the free `implicitConvTo(Type, Type)`
            // (dcast.d:1558) = `implicitConvToType`; `!m` on a MATCH enum expands (09 §9).
            if (tat === null || implicitConvToType(tat, tprm) === MATCH.nomatch)
                break;
            if (tat === tab || tat === firsttab)
                break;
            ta = tat;
        }
    }

    /* A ref variable should work like a head-const reference.
     * e.g. disallows:
     *  ref T      <- an lvalue of const(T) argument
     *  ref T[dim] <- an lvalue of const(T[dim]) argument
     */
    if (constConv(ta, tp) === MATCH.nomatch) { // D: `if (!ta.constConv(tp))` (09 §9)
        if (pMessage !== null) pMessage.value = getParamError(tf, arg, p);
        return MATCH.nomatch;
    }

    // swept (11 §2.5): D's free `isBitField` is `BitFieldDeclaration isBitField(Expression e)` at
    // dmd/expressionsem.d:20129 (the wall's :20111 cited the enclosing doc-comment block), and it is
    // live and exported at expressionsem.ts:22483 with that exact signature. D writes it UFCS
    // (`arg.isBitField()`); the port keeps the free form (04 §6).
    if (isBitField(arg) !== null) {
        if (pMessage !== null) pMessage.value = getParamError(tf, arg, p);
        return MATCH.nomatch;
    }

    return m;
}

/** dmd/typesem.d:2662 — arguments get specially formatted */
// D module-private (typesem.d:2662).
function getParamError(tf: TypeFunction, arg: Expression, par: Parameter): DString | null {
    if (global.gag !== 0 && !global.params.v.showGaggedErrors)
        return null;
    // show qualification when toChars() is the same but types are different
    // https://issues.dlang.org/show_bug.cgi?id=19948
    // when comparing the type with strcmp, we need to drop the qualifier
    const qual = !mutableOf(arg.type!).equals(mutableOf(par.type!)) &&
        dsEquals(cstr(mutableOf(arg.type!).toChars()), cstr(mutableOf(par.type!).toChars()));
    const buf = new OutBuffer();
    // only mention rvalue or bitfield if it's relevant
    if (isBitField(arg) !== null) {
        buf.printf(ds("cannot pass bitfield argument `%s` to parameter `%s`"),
                   toErrMsg(arg), parameterToChars(par, tf, qual));
    } else {
        const at = qual ? arg.type!.toPrettyChars(true) : arg.type!.toChars();
        const rv = !isLvalue(arg) && par.isReference() && (par.storageClass & STC.constscoperef) === 0n;
        buf.printf(ds("cannot pass %sargument `%s` of type `%s` to parameter `%s`"),
            rv ? ds("rvalue ") : ds(""), toErrMsg(arg), at,
            parameterToChars(par, tf, qual));
    }
    return buf.extractChars(); // CONSUMES buf — faithful to D
}

/**
 * dmd/typesem.d:2703 — Match the remaining arguments `trailingArgs` with parameter `p`.
 *
 * Assume we already checked that `p` is the last parameter of `tf`,
 * and we want to know whether the arguments would match `p`.
 *
 * Params:
 *   tf = The `TypeFunction`, only used for error reporting
 *   p = The last parameter of `tf` which is variadic
 *   trailingArgs = The remaining arguments that should match `p`
 *   pMessage = A buffer to write the error in, or `null`
 *
 * Returns: Whether `trailingArgs` match `p`.
 */
// D module-private (typesem.d:2703).
function matchTypeSafeVarArgs(tf: TypeFunction, p: Parameter,
    trailingArgs: (Expression | null)[], pMessage: Ref<DString | null> | null): MATCH {
    const tb = toBasetype(p.type!);

    switch (tb.ty) {
    case TY.Tsarray: {
        const tsa = tb.isTypeSArray()!; // D: `cast(TypeSArray)tb`
        const sz: bigint = toInteger(tsa.dim!);
        if (sz !== BigInt(trailingArgs.length)) {
            if (pMessage !== null) {
                const buf = new OutBuffer();
                getMatchError(buf, ds("expected %llu variadic argument(s), not %zu"),
                    sz, trailingArgs.length);
                pMessage.value = buf.extractChars();
            }
            return MATCH.nomatch;
        }
        // G2 (06 §3.6a): D `goto case Tarray;` targets the IMMEDIATELY NEXT case — fall through.
    }
    // goto case Tarray (dmd/typesem.d:2724) — falls into the next arm (JS no-break fallthrough)
    case TY.Tarray:
    {
        let match: MATCH = MATCH.exact;
        // D: `cast(TypeArray)tb` — tag-proved by the two arms reaching here (Tsarray falls
        // through), and `TypeArray` has no `isTypeXxx()` accessor (02 §11.5c shape 3).
        const ta = tb as unknown as TypeArray;
        for (const arg of trailingArgs) {
            let m: MATCH;
            assert(arg !== null);

            /* If lazy array of delegates,
             * convert arg(s) to delegate(s)
             */
            const tret = isLazyArray(p);
            if (tret !== null) {
                if (ta.next!.equals(arg.type))
                    m = MATCH.exact;
                else if (toBasetype(tret).ty === TY.Tvoid)
                    m = MATCH.convert;
                else {
                    m = implicitConvTo(arg, tret);
                    if (m === MATCH.nomatch)
                        m = implicitConvTo(arg, ta.next!);
                }
            } else
                m = implicitConvTo(arg, ta.next!);

            if (m === MATCH.nomatch) {
                if (pMessage !== null) pMessage.value = getParamError(tf, arg, p);
                return MATCH.nomatch;
            }
            if (m < match)
                match = m;
        }
        return match;
    }
    case TY.Tclass:
        // We leave it up to the actual constructor call to do the matching.
        return MATCH.exact;

    default: {
        // We can have things as `foo(int[int] wat...)` but they only match
        // with an associative array proper.
        if (pMessage === null) { /* D: `if (!pMessage) {}` — empty */ }
        else if (trailingArgs.length === 0) {
            const buf = new OutBuffer();
            getMatchError(buf, ds("expected an argument for parameter `%s`"),
                parameterToChars(p, tf, false));
            pMessage.value = buf.extractChars();
        }
        else
            pMessage.value = getParamError(tf, trailingArgs[0]!, p);

        return MATCH.nomatch;
    }
    }
}

/** dmd/typesem.d:2787 — Compute cached type properties for `TypeStruct` */
export function determineTypeProperties(sd: StructDeclaration): void {
    // D: function-local `import dmd.dsymbolsem : hasPointers;` — hoisted to the top-level import
    // as `hasPointersDsymbol` (04 §6.1; the typesem `hasPointers(Type)` keeps the plain name).
    if (sd.computedTypeProperties)
        return;
    for (const vd of sd.fields) {
        if ((vd!.storage_class & STC.ref_) !== 0n || hasPointersDsymbol(vd!)) {
            sd.hasPointerField = true;
            sd.hasUnsafeBitpatterns = true;
        }

        if (vd!._init !== null && vd!._init.isVoidInitializer() !== null && hasPointersDsymbol(vd!))
            sd.hasVoidInitPointers = true;

        if ((vd!.storage_class & STC.system) !== 0n || hasUnsafeBitpatterns(vd!.type!))
            sd.hasUnsafeBitpatterns = true;

        if (vd!._init === null && hasVoidInitPointers(vd!.type!))
            sd.hasVoidInitPointers = true;

        if (hasInvariant(vd!.type!))
            sd.hasFieldWithInvariant = true;
    }
    sd.computedTypeProperties = true;
}

/***************************************
 * dmd/typesem.d:2819 — Return !=0 if type has pointers that need to
 * be scanned by the GC during a collection cycle.
 */
export function hasPointers(t: Type): boolean {
    const visitType = (_: Type): boolean            => { return false; };
    const visitDArray = (_: TypeDArray): boolean    => { return true; };
    const visitAArray = (_: TypeAArray): boolean    => { return true; };
    const visitPointer = (_: TypePointer): boolean  => { return true; };
    const visitDelegate = (_: TypeDelegate): boolean => { return true; };
    const visitClass = (_: TypeClass): boolean      => { return true; };
    const visitEnum = (t: TypeEnum): boolean        => { return hasPointers(memType(t)); };

    /* Although null isn't dereferencable, treat it as a pointer type for
     * attribute inference, generic code, etc.
     */
    const visitNull = (_: TypeNull): boolean        => { return true; };

    const visitSArray = (t: TypeSArray): boolean => {
        /* Don't want to do this, because:
         *    struct S { T* array[0]; }
         * may be a variable length struct.
         */
        //if (dim.toInteger() == 0)
        //    return false;

        if (t.next!.ty === TY.Tvoid) {
            // Arrays of void contain arbitrary data, which may include pointers
            return true;
        } else
            return hasPointers(t.next!);
    };

    const visitStruct = (t: TypeStruct): boolean => {
        const sym = t.sym!;

        if (sym.members !== null && !determineFields(sym) &&
            sym.type !== Type.terror)
            error(sym.loc, ds("no size because of forward references"));

        determineTypeProperties(sym);
        return sym.hasPointerField;
    };

    // S1 — dispatch switch (13 §7.5), emitted IN FULL.
    switch (t.ty) {
        default:            return visitType(t);
        case TY.Tsarray:    return visitSArray(t.isTypeSArray()!);
        case TY.Tarray:     return visitDArray(t.isTypeDArray()!);
        case TY.Taarray:    return visitAArray(t.isTypeAArray()!);
        case TY.Tpointer:   return visitPointer(t.isTypePointer()!);
        case TY.Tdelegate:  return visitDelegate(t.isTypeDelegate()!);
        case TY.Tstruct:    return visitStruct(t.isTypeStruct()!);
        case TY.Tenum:      return visitEnum(t.isTypeEnum()!);
        case TY.Tclass:     return visitClass(t.isTypeClass()!);
        case TY.Tnull:      return visitNull(t.isTypeNull()!);
    }
}

/**************************************
 * dmd/typesem.d:2882 — Returns an indirect type one step from t.
 */
export function getIndirection(t: Type): Type | null {
    t = baseElemOf(t);
    if (t.ty === TY.Tarray || t.ty === TY.Tpointer)
        return toBasetype(nextOf(t)!);
    if (t.ty === TY.Taarray || t.ty === TY.Tclass)
        return t;
    if (t.ty === TY.Tstruct)
        return hasPointers(t) ? t : null; // TODO

    // should consider TypeDelegate?
    return null;
}

/**
 * dmd/typesem.d:2901 — `uinteger_t size(Type t, Loc loc)`.
 *
 * resolved: the arity-prefix overload `uinteger_t size(Type t)` (typesem.d:2896) folds into this
 * one's default argument (04 §1A / §9-D5) — its whole body is `return size(t, Loc.initial);`.
 *
 * `uinteger_t` -> `bigint` end-to-end: the SIZE_INVALID sentinel must never transit a JS number
 * (09 §1.3.1).
 */
export function size(t: Type, loc: Loc = Loc.initial): bigint {

    const visitType = (t: Type): bigint => {
        error(loc, ds("no size for type `%s`"), t.toChars());
        return SIZE_INVALID;
    };

    const visitBasic = (t: TypeBasic): bigint => {
        let size: number; // D `uint size;` — number domain (09 §1)
        //printf("TypeBasic::size()\n");
        switch (t.ty) {
            case TY.Tint8:
            case TY.Tuns8:
                size = 1;
                break;

            case TY.Tint16:
            case TY.Tuns16:
                size = 2;
                break;

            case TY.Tint32:
            case TY.Tuns32:
            case TY.Tfloat32:
            case TY.Timaginary32:
                size = 4;
                break;

            case TY.Tint64:
            case TY.Tuns64:
            case TY.Tfloat64:
            case TY.Timaginary64:
                size = 8;
                break;

            case TY.Tfloat80:
            case TY.Timaginary80:
                size = target.realsize;
                break;

            case TY.Tcomplex32:
                size = 8;
                break;

            case TY.Tcomplex64:
            case TY.Tint128:
            case TY.Tuns128:
                size = 16;
                break;

            case TY.Tcomplex80:
                size = target.realsize * 2;
                break;

            case TY.Tvoid:
                //size = Type::size();      // error message
                size = 1;
                break;

            case TY.Tbool:
                size = 1;
                break;

            case TY.Tchar:
                size = 1;
                break;

            case TY.Twchar:
                size = 2;
                break;

            case TY.Tdchar:
                size = 4;
                break;

            default:
                return assertUnreachable(); // D `assert(0)` (typesem.d:2981)
            }

        //printf("TypeBasic::size() = %d\n", size);
        return BigInt(size);
    };

    const visitSArray = (t: TypeSArray): bigint => {
        //printf("TypeSArray::size()\n");
        const n = numberOfElems(t, loc);                 // `uint` -> number
        const elemsize = size(baseElemOf(t), loc);       // `uinteger_t` -> bigint
        const overflow: Ref<boolean> = { value: false }; // D: `bool overflow = false;`
        const sz = mulu(BigInt(n), elemsize, overflow);
        if (overflow.value || sz >= 0xFFFF_FFFFn) {      // D: `sz >= uint.max` (bigint both sides)
            if (elemsize !== SIZE_INVALID && n !== 0xFFFF_FFFF) // D: `n != uint.max` (number domain)
                error(loc, ds("static array `%s` size overflowed to %lld"), t.toChars(), toInt64(sz));
            return SIZE_INVALID;
        }
        return sz;

    };

    const visitTypeQualified = (t: TypeQualified): bigint => {
        if (t.ty === TY.Ttypeof) {
            const type = t.isTypeTypeof()!.exp!.type; // D: `(cast(TypeTypeof)t).exp.type`
            if (type !== null)
                return size(type, loc);
        }

        error(t.loc, ds("size of type `%s` is not known"), t.toChars());
        return SIZE_INVALID;
    };

    // S2 — dispatch switch (13 §7.5), emitted IN FULL. The `default:` arm carries D's ternary on
    // isTypeBasic — reproduced, never split into per-TY cases.
    switch (t.ty) {
        default:            return t.isTypeBasic() !== null ? visitBasic(t.isTypeBasic()!) : visitType(t);
        case TY.Ttraits:
        case TY.Terror:     return SIZE_INVALID;
        case TY.Tvector:    return size(t.isTypeVector()!.basetype);
        case TY.Tsarray:    return visitSArray(t.isTypeSArray()!);
        case TY.Tdelegate:
        case TY.Tarray:     return BigInt(target.ptrsize * 2);
        case TY.Tpointer:
        case TY.Treference:
        case TY.Tclass:
        case TY.Taarray:    return BigInt(target.ptrsize);
        case TY.Tident:
        case TY.Tinstance:
        case TY.Ttypeof:
        // D: `cast(TypeQualified)t` — tag-proved by these four arms (02 §11.5c shape 3).
        case TY.Treturn:    return visitTypeQualified(t as unknown as TypeQualified);
        case TY.Tstruct:
        {
            // D: `return t.isTypeStruct().sym.size(loc);` — the DSYMBOL `size` (dsymbolsem.d:993),
            // a different overload family from this function (04 §1B).
            return sizeDsymbol(t.isTypeStruct()!.sym!, loc);
        }
        case TY.Tenum: {
            return size(getMemtype(t.isTypeEnum()!.sym!, loc), loc);
        }
        case TY.Tnull:      return size(Type.tvoidptr, loc);
        case TY.Tnoreturn:  return 0n;
    }
}

/*******************************
 * dmd/typesem.d:3054 — Determine if converting 'this' to 'to' is an identity operation,
 * a conversion to const operation, or the types aren't the same.
 * Returns:
 *      MATCH.exact      'this' == 'to'
 *      MATCH.constant      'to' is const
 *      MATCH.nomatch    conversion to mutable or invariant
 */
export function constConv(from: Type, to: Type): MATCH {
    const visitType = (from: Type): MATCH => {
        //printf("Type::constConv(this = %s, to = %s)\n", from.toChars(), to.toChars());
        if (from.equals(to))
            return MATCH.exact;
        if (from.ty === to.ty && MODimplicitConv(from.mod, to.mod))
            return MATCH.constant;
        return MATCH.nomatch;
    };

    const visitNext = (from: TypeNext): MATCH => {
        //printf("TypeNext::constConv from = %s, to = %s\n", from.toChars(), to.toChars());
        if (from.equals(to))
            return MATCH.exact;

        if (!(from.ty === to.ty && MODimplicitConv(from.mod, to.mod)))
            return MATCH.nomatch;

        const tn = nextOf(to);
        if (!(tn !== null && from.next!.ty === tn.ty))
            return MATCH.nomatch;

        let m: MATCH;
        if (to.isConst()) // whole tail const conversion
        {
            // Recursive shared level check
            m = constConv(from.next!, tn);
            if (m === MATCH.exact)
                m = MATCH.constant;
        } else {
            //printf("\tnext => %s, to.next => %s\n", from.next.toChars(), tn.toChars());
            m = from.next!.equals(tn) ? MATCH.constant : MATCH.nomatch;
        }
        return m;
    };

    const visitSArray = (from: TypeSArray): MATCH => {
        const tsa = to.isTypeSArray();
        if (tsa !== null) {
            // D: `from.dim.equals(tsa.dim)` — the free `equals(Expression, Expression)`.
            if (!equals(from.dim!, tsa.dim!))
                return MATCH.nomatch;
        }
        return visitNext(from);
    };

    const visitAArray = (from: TypeAArray): MATCH => {
        const taa = to.isTypeAArray();
        if (taa !== null) {
            const mindex = constConv(from.index!, taa.index!);
            const mkey = constConv(from.next!, taa.next!);
            // Pick the worst match
            return mkey < mindex ? mkey : mindex;
        }
        return visitType(from);
    };

    const visitPointer = (from: TypePointer): MATCH => {
        if (from.next!.ty === TY.Tfunction) {
            // D: `(cast(TypeNext)to).next` — D's own proof here is only `to.nextOf()` being
            // non-null (a TypeEnum can also answer that), so the cascade reproduces D's
            // assumption exactly (02 §11.5c shape 3; reported as a D-side sharp edge).
            if (nextOf(to) !== null && from.next!.equals((to as unknown as TypeNext).next))
                return visitType(from);
            else
                return MATCH.nomatch;
        }
        return visitNext(from);
    };

    const visitFunction = (from: TypeFunction): MATCH => {
        // Attributes need to match exactly, otherwise it's an implicit conversion
        // D: `cast(TypeFunction) to` — `||` short-circuits, so the accessor only runs once
        // `from.ty == to.ty` proved `to` is a TypeFunction (shape 3).
        if (from.ty !== to.ty || !from.attributesEqual(to.isTypeFunction()!))
            return MATCH.nomatch;

        return visitNext(from);
    };

    const visitStruct = (from: TypeStruct): MATCH => {
        if (from.equals(to))
            return MATCH.exact;
        // D: `(cast(TypeStruct)to).sym` — tag-proved by the preceding `from.ty == to.ty` (shape 3).
        if (from.ty === to.ty && from.sym === to.isTypeStruct()!.sym && MODimplicitConv(from.mod, to.mod))
            return MATCH.constant;
        return MATCH.nomatch;
    };

    const visitEnum = (from: TypeEnum): MATCH => {
        if (from.equals(to))
            return MATCH.exact;
        if (from.ty === to.ty && from.sym === to.isTypeEnum()!.sym && MODimplicitConv(from.mod, to.mod))
            return MATCH.constant;
        return MATCH.nomatch;
    };

    const visitClass = (from: TypeClass): MATCH => {
        if (from.equals(to))
            return MATCH.exact;
        if (from.ty === to.ty && from.sym === to.isTypeClass()!.sym && MODimplicitConv(from.mod, to.mod))
            return MATCH.constant;

        /* Conversion derived to const(base)
         */
        const offset: Ref<number> = { value: 0 }; // D: `int offset = 0;` + `&offset` (03 §7.2)
        if (isBaseOf(to, from, offset) && offset.value === 0 && MODimplicitConv(from.mod, to.mod)) {
            // Disallow:
            //  derived to base
            //  inout(derived) to inout(base)
            if (!to.isMutable() && !to.isWild())
                return MATCH.convert;
        }

        return MATCH.nomatch;
    };

    const visitNoreturn = (from: TypeNoreturn): MATCH => {
        // Either another noreturn or conversion to any type
        // D `from.implicitConvTo(to)` — UFCS onto the free `implicitConvTo(Type, Type)`
        // (dcast.d:1558) = `implicitConvToType`.
        return implicitConvToType(from, to);
    };

    // S3 — dispatch switch (13 §7.5), emitted IN FULL.
    switch (from.ty) {
        default:            return visitType(from);
        case TY.Tsarray:    return visitSArray(from.isTypeSArray()!);
        case TY.Taarray:    return visitAArray(from.isTypeAArray()!);
        case TY.Treference:
        case TY.Tdelegate:
        case TY.Tslice:
        case TY.Tarray:     return visitNext(isTypeNext(from)!); // D: `cast(TypeNext)from`
        case TY.Tpointer:   return visitPointer(from.isTypePointer()!);
        case TY.Tfunction:  return visitFunction(from.isTypeFunction()!);
        case TY.Tstruct:    return visitStruct(from.isTypeStruct()!);
        case TY.Tenum:      return visitEnum(from.isTypeEnum()!);
        case TY.Tclass:     return visitClass(from.isTypeClass()!);
        case TY.Tnoreturn:  return visitNoreturn(from.isTypeNoreturn()!);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// CHUNK 2 — dmd/typesem.d:3202-6151
//   typeSemantic (3213) · trySemantic (4779) · merge (4813) · merge2 (4897) ·
//   LOGDEFAULTINIT (4916, folds away) · defaultInitLiteral (4921) · getProperty (5030) ·
//   resolveExp (5492, D module-private) · resolve (5530)
// Dispatch switches S4 (typeSemantic), S5 (merge), S6 (getProperty), S7 (resolve) are emitted
// IN FULL (13 §7.5). Label-jump shapes handled here (the jump token is kept off prose lines
// so the 14 §3 audit grep stays clean): G1 (merge, default-arm closure x3), G3 (next-case
// fallthrough into `case Terror` x3), G5 (resolve.visitTypeof `Lerr` x6, BAIL tail).
// ═══════════════════════════════════════════════════════════════════════════════════════════

// dmd/typesem.d:3626-3628 — `__gshared FuncDeclaration feq, fcmp, fhash;` declared INSIDE
// typeSemantic's nested `visitAArray`. `__gshared` = one process-wide slot, so these are
// module-level (01 §5.5), NOT function locals: the D code fills them once (`if (!feq) feq = …`)
// and never resets them, and making them locals would silently turn a process-wide cache into a
// per-call lookup. Module-private (no export): the only reader is visitAArray.
let feq: FuncDeclaration | null = null;
let fcmp: FuncDeclaration | null = null;
let fhash: FuncDeclaration | null = null;

/******************************************
 * dmd/typesem.d:3213 — `Type typeSemantic(Type type, Loc loc, Scope* sc)`.
 * Perform semantic analysis on a type.
 * Params:
 *      type = Type AST node
 *      loc = the location of the type
 *      sc = context
 * Returns:
 *      `Type` with completed semantic analysis, `Terror` if errors were encountered
 *
 * `sc` is `Scope | null` (02 §10.1 — the BODY decides): `visitAArray` null-tests it
 * (`if (sc) sc.setNoFree();`, typesem.d:3462). Every other use dereferences unconditionally, so
 * those sites carry the `!` marking the exact point D would fault.
 *
 * IDIOM B (13 §7.5): nested `visit*` locals + one trailing dispatch `switch (type.ty)` — emitted
 * IN FULL, 23 arms, unfilled arms walled AT their `case` position, never routed to `default`.
 */
export function typeSemantic(type: Type, loc: Loc, sc: Scope | null): Type {
    // dmd/typesem.d:3215 — `static Type error() { return Type.terror; }`. RENAMED `errorType`: the D
    // nested `error()` SHADOWS the imported diagnostic `error(loc, fmt, …)`, which D disambiguates by
    // spelling the module one `.error(...)`. Both spellings of the diagnostic emit `error(...)` here;
    // the arity-0 shadow becomes `errorType()` (04 §6.1 / preamble §4 nested-name shadow).
    const errorType = (): Type => {
        return Type.terror;
    };

    // dmd/typesem.d:3220 — the dispatch `default:` arm.
    const visitType = (t: Type): Type => {
        // @@@DEPRECATED_2.110@@@
        // Use of `cent` and `ucent` has always been an error.
        // Starting from 2.100, recommend core.int128 as a replace for the
        // lack of compiler support.
        if (t.ty === TY.Tint128 || t.ty === TY.Tuns128) {
            error(loc, ds("`cent` and `ucent` types are obsolete, use `core.int128.Cent` instead"));
            return errorType();
        }

        return merge(t); // D `t.merge()` — UFCS onto the file-level free `merge` (typesem.d:4813)
    };

    // dmd/typesem.d:3235 — 1.43 reduced this arm to a plain forward. (1.42 routed C-file complex
    // types through `getComplexLibraryType`; do NOT reinstate that from a rung-era reference —
    // `getComplexLibraryType` survives at typesem.d:7976 but is no longer called from here.)
    const visitComplex = (t: TypeBasic): Type => {
        return visitType(t);
    };

    // dmd/typesem.d:3240
    const visitVector = (mtype: TypeVector): Type => {
        const errors = global.errors;
        mtype.basetype = typeSemantic(mtype.basetype, loc, sc);
        if (errors !== global.errors)
            return errorType();
        mtype.basetype = mutableOf(toBasetype(mtype.basetype));
        if (mtype.basetype.ty !== TY.Tsarray) {
            error(loc, ds("T in __vector(T) must be a static array, not `%s`"), mtype.basetype.toChars());
            return errorType();
        }
        const t: TypeSArray = mtype.basetype.isTypeSArray()!;
        // D `const sz = cast(int)t.size(loc);` — `size` is `uinteger_t` (bigint); `cast(int)` is the
        // mask-then-sign-extend truncation of 09 §2, and the `int` result lives in the number domain.
        const sz = Number(BigInt.asIntN(32, size(t, loc)));
        // dmd/typesem.d:3254
        switch (target.isVectorTypeSupported(sz, nextOf(t)!)) {
            case 0:
                // valid
                break;

            case 1:
                // no support at all
                error(loc, ds("SIMD vector types not supported on this platform"));
                return errorType();

            case 2:
                // invalid base type
                error(loc, ds("vector type `%s` is not supported on this platform"), mtype.toChars());
                return errorType();

            case 3:
                // invalid size
                error(loc, ds("%d byte vector type `%s` is not supported on this platform"), sz, mtype.toChars());
                return errorType();

            default:
                // final switch: exhaustiveness not statically checkable here (an `int` discriminant)
                throw new SwitchError();
        }
        return merge(mtype);
    };

    // dmd/typesem.d:3278
    const visitSArray = (mtype: TypeSArray): Type => {
        //printf("TypeSArray::semantic() %s\n", toChars());
        // D `Type t; Expression e; Dsymbol s;` passed as `out` to `resolve` -> Ref boxes (03 §3.3).
        const t: Ref<Type | null> = { value: null };
        const e: Ref<Expression | null> = { value: null };
        const s: Ref<Dsymbol | null> = { value: null };
        resolve(mtype.next!, loc, sc, e, t, s);

        // dmd/typesem.d:3286 — `if (auto tup = s ? s.isTupleDeclaration() : null)` (06 §2.6 hoist).
        const tup = s.value !== null ? s.value.isTupleDeclaration() : null;
        if (tup !== null) {
            mtype.dim = semanticLengthTupleDecl(sc!, tup, mtype.dim!);
            mtype.dim = ctfeInterpret(mtype.dim);   // dmd/typesem.d:3289
            if (mtype.dim.op === EXP.error)
                return errorType();

            // dmd/typesem.d:3293 — `uinteger_t d = mtype.dim.toUInteger();`
            const d: bigint = toUInteger(mtype.dim);
            if (d >= BigInt(tup.objects!.length)) {
                error(loc, ds("sequence index `%llu` out of bounds `[0 .. %llu]`"),
                    d, BigInt(tup.objects!.length));
                return errorType();
            }

            // `cast(size_t)d` — a bigint value used as an INDEX; index/length domain is `number`
            // (09 §1.1), so the narrowing is the prescribed one, not an exactness-critical compare.
            const o: RootObject | null = tup.objects!.opIndex(Number(d));
            // D `o.isType()` — UFCS onto the free `isType(RootObject)` (dtemplate.d:94), NOT a method.
            const tt = isType(o);
            if (tt !== null)
                return addMod(tt, mtype.mod);
            error(loc, ds("`%s` is not a type"), mtype.toChars());
            return errorType();
        }

        if (t.value !== null && t.value.ty === TY.Terror)
            return errorType();

        const tn = typeSemantic(mtype.next!, loc, sc);
        if (tn.ty === TY.Terror)
            return errorType();

        const tbn = toBasetype(tn);
        if (mtype.dim !== null) {
            // dmd/typesem.d:3312 — `if (auto ide = mtype.dim.isIdentifierExp())` (06 §2.6 hoist).
            const ide = mtype.dim.isIdentifierExp();
            if (ide !== null) {
                if (ide.ident === Id.dollar) {
                    mtype.next = tn;
                    transitive(mtype);
                    return merge(addMod(mtype, tn.mod));
                }
            }
            let errors = global.errors;
            mtype.dim = semanticLength(sc!, tbn, mtype.dim);
            mtype.dim = implicitCastTo(mtype.dim, sc, Type.tsize_t);
            if (errors !== global.errors)
                return errorType();

            mtype.dim = optimize(mtype.dim, WANTvalue);
            mtype.dim = ctfeInterpret(mtype.dim);   // dmd/typesem.d:3333
            if (mtype.dim.op === EXP.error)
                return errorType();

            errors = global.errors;
            const d1: bigint = toInteger(mtype.dim);
            if (errors !== global.errors)
                return errorType();

            mtype.dim = implicitCastTo(mtype.dim, sc, Type.tsize_t);
            mtype.dim = optimize(mtype.dim, WANTvalue);
            if (mtype.dim.op === EXP.error)
                return errorType();

            errors = global.errors;
            const d2: bigint = toInteger(mtype.dim);
            if (errors !== global.errors)
                return errorType();

            // 02 §11.4 — D repeats the `op == EXP.error` probe here (typesem.d:3353) even though
            // `mtype.dim` has not been reassigned since the previous one; TS's stale narrowing would
            // reject the literal spelling as a "no overlap" comparison, so the value is re-read into
            // a freshly-declared local annotated at the field's declared type and THAT is tested.
            const dim2: Expression = mtype.dim;
            if (dim2.op === EXP.error)
                return errorType();

            // dmd/typesem.d:3355 — nested `Type overflowError()`.
            const overflowError = (): Type => {
                // dmd/typesem.d:3357
                error(loc, ds("`%s` size %llu * %llu exceeds 0x%llx size limit for static array"),
                    mtype.toChars(), size(tbn, loc), d1, target.maxStaticDataSize);
                return errorType();
            };

            if (d1 !== d2)
                return overflowError();

            const tbx = baseElemOf(tbn);
            if ((tbx.ty === TY.Tstruct && tbx.isTypeStruct()!.sym!.members === null) ||
                (tbx.ty === TY.Tenum && tbx.isTypeEnum()!.sym!.members === null)) {
                /* To avoid meaningless error message, skip the total size limit check
                 * when the bottom of element type is opaque.
                 */
            } else if (tbn.isTypeBasic() !== null ||
                       tbn.ty === TY.Tpointer ||
                       tbn.ty === TY.Tarray ||
                       tbn.ty === TY.Tsarray ||
                       tbn.ty === TY.Taarray ||
                       (tbn.ty === TY.Tstruct && tbn.isTypeStruct()!.sym!.sizeok === Sizeok.done) ||
                       tbn.ty === TY.Tclass) {
                /* Only do this for types that don't need to have semantic()
                 * run on them for the size, since they may be forward referenced.
                 */
                const overflow: Ref<boolean> = { value: false };
                // dmd/typesem.d:3385 — both operands of the compare stay bigint (09 §8): the overflow
                // test is exactness-critical.
                if (mulu(size(tbn, loc), d2, overflow) > target.maxStaticDataSize || overflow.value)
                    return overflowError();
            }
        }
        switch (tbn.ty) {
            case TY.Ttuple: {
                // Index the tuple to get the type
                assert(mtype.dim !== null);
                const tt = tbn.isTypeTuple()!;
                // dmd/typesem.d:3396 — `uinteger_t d = mtype.dim.toUInteger();`
                const d: bigint = toUInteger(mtype.dim!);
                if (d >= BigInt(tt.arguments!.length)) {
                    error(loc, ds("sequence index `%llu` out of bounds `[0 .. %llu]`"),
                        d, BigInt(tt.arguments!.length));
                    return errorType();
                }
                // `cast(size_t)d` — bigint -> index domain (09 §1.1)
                const telem = tt.arguments!.opIndex(Number(d))!.type!;
                return addMod(telem, mtype.mod);
            }

            case TY.Tfunction:
            case TY.Tnone:
                error(loc, ds("cannot have array of `%s`"), tbn.toChars());
                return errorType();

            default:
                break;
        }
        if (tbn.isScopeClass()) {
            error(loc, ds("cannot have array of scope `%s`"), tbn.toChars());
            return errorType();
        }

        /* Ensure things like const(immutable(T)[3]) become immutable(T[3])
         * and const(T)[3] become const(T[3])
         */
        mtype.next = tn;
        transitive(mtype);
        return merge(addMod(mtype, tn.mod));
    };

    // dmd/typesem.d:3428
    const visitDArray = (mtype: TypeDArray): Type => {
        const tn = typeSemantic(mtype.next!, loc, sc);
        const tbn = toBasetype(tn);
        switch (tbn.ty) {
            case TY.Ttuple:
                return tbn;

            case TY.Tfunction:
            case TY.Tnone:
                error(loc, ds("cannot have array of `%s`"), tbn.toChars());
                return errorType();

            case TY.Terror:
                return errorType();

            default:
                break;
        }
        if (tn.isScopeClass()) {
            error(loc, ds("cannot have array of scope `%s`"), tn.toChars());
            return errorType();
        }
        mtype.next = tn;
        transitive(mtype);
        return merge(mtype);
    };

    // dmd/typesem.d:3458
    const visitAArray = (mtype: TypeAArray): Type => {
        //printf("TypeAArray::semantic() %s index.ty = %d\n", mtype.toChars(), mtype.index.ty);
        // `deco` is D's `char*`; the port models it as a JS string slot that is null until merged, so
        // the pointer test is the explicit null test (06 §2.7), never JS truthiness.
        if (mtype.deco !== null) {
            if (K.on) keepMergedAA(mtype, loc);   // the kept-module engine: a merge of a kept AA entry
            return mtype;
        }

        mtype.loc = loc;
        if (sc !== null)
            sc.setNoFree();

        // Deal with the case where we thought the index was a type, but
        // in reality it was an expression.
        if (mtype.index!.ty === TY.Tident || mtype.index!.ty === TY.Tinstance ||
            mtype.index!.ty === TY.Tsarray || mtype.index!.ty === TY.Ttypeof ||
            mtype.index!.ty === TY.Treturn || mtype.index!.ty === TY.Tmixin) {
            const e: Ref<Expression | null> = { value: null };
            const t: Ref<Type | null> = { value: null };
            const s: Ref<Dsymbol | null> = { value: null };
            // D `Loc indexLoc;` — default-initialized, i.e. `Loc.initial` (09 §1.0).
            let indexLoc: Loc = Loc.initial;

            switch (mtype.index!.ty) {
                case TY.Tident:    indexLoc = mtype.index!.isTypeIdentifier()!.loc;  break;
                case TY.Tinstance: indexLoc = mtype.index!.isTypeInstance()!.loc;    break;
                case TY.Ttypeof:   indexLoc = mtype.index!.isTypeTypeof()!.loc;      break;
                case TY.Treturn:   indexLoc = mtype.index!.isTypeReturn()!.loc;      break;
                case TY.Tmixin:    indexLoc = mtype.index!.isTypeMixin()!.loc;       break;
                default: indexLoc = mtype.loc;
            }

            resolve(mtype.index!, indexLoc, sc, e, t, s);

            // https://issues.dlang.org/show_bug.cgi?id=15478
            if (s.value !== null)
                e.value = symbolToExp(s.value, loc, sc!, false);

            if (e.value !== null) {
                // It was an expression -
                // Rewrite as a static array
                const tsa = new TypeSArray(mtype.next, e.value);
                return typeSemantic(tsa, loc, sc);
            } else if (t.value !== null)
                mtype.index = typeSemantic(t.value, loc, sc);
            else {
                error(loc, ds("index is not a type or an expression"));
                return errorType();
            }
        } else
            mtype.index = typeSemantic(mtype.index!, loc, sc);
        mtype.index = merge2(mtype.index);

        if (nextOf(mtype.index) !== null && !nextOf(mtype.index)!.isImmutable()) {
            mtype.index = mutableOf(constOf(mtype.index));
            // resolved: version(none) (typesem.d:3517-3527) -> not taken, printf block dropped
        }

        switch (toBasetype(mtype.index).ty) {
            case TY.Tfunction:
            case TY.Tvoid:
            case TY.Tnone:
            case TY.Ttuple:
                error(loc, ds("cannot have associative array key of `%s`"), toBasetype(mtype.index).toChars());
                // goto case Terror (dmd/typesem.d:3538) — falls into the next arm
            case TY.Terror:
                return errorType();

            default:
                break;
        }
        let tbase = baseElemOf(mtype.index);
        while (tbase.ty === TY.Tarray)
            tbase = baseElemOf(nextOf(tbase)!);
        // dmd/typesem.d:3546 — `if (auto ts = tbase.isTypeStruct())` (06 §2.6 hoist).
        const ts = tbase.isTypeStruct();
        if (ts !== null) {
            /* AA's need typeid(index).equals() and getHash(). Issue error if not correctly set up.
             */
            const sd: StructDeclaration = ts.sym!;
            if (sd.semanticRun < PASS.semanticdone)
                dsymbolSemantic(sd, null);

            // duplicate a part of StructDeclaration::semanticTypeInfoMembers
            //printf("AA = %s, key: xeq = %p, xerreq = %p xhash = %p\n", toChars(), sd.xeq, sd.xerreq, sd.xhash);

            if (sd.xeq !== null && sd.xeq.isGenerated && sd.xeq._scope !== null &&
                sd.xeq.semanticRun < PASS.semantic3done) {
                const errors = global.startGagging();
                semantic3(sd.xeq, sd.xeq._scope);
                if (global.endGagging(errors))
                    sd.xeq = StructDeclaration.xerreq; // `xerreq` is D `__gshared` (dstruct.d:47) -> a static
            }

            //printf("AA = %s, key: xeq = %p, xhash = %p\n", toChars(), sd.xeq, sd.xhash);
            const s: DString = (toBasetype(mtype.index).ty !== TY.Tstruct) ? ds("bottom of ") : ds("");
            if (sd.xeq === null) {
                // If sd.xhash != NULL:
                //   sd or its fields have user-defined toHash.
                //   AA assumes that its result is consistent with bitwise equality.
                // else:
                //   bitwise equality & hashing
            } else if (sd.xeq === StructDeclaration.xerreq) { // `__gshared` static (dstruct.d:47)
                if (search_function(sd, Id.opEquals!) !== null) {
                    error(loc, ds("%sAA key type `%s` does not have `bool opEquals(ref const %s) const`"),
                        s, sd.toChars(), sd.toChars());
                } else {
                    error(loc, ds("%sAA key type `%s` does not support const equality"), s, sd.toChars());
                }
                return errorType();
            } else if (sd.xhash === null) {
                if (search_function(sd, Id.opEquals!) !== null) {
                    error(loc, ds("%sAA key type `%s` should have `extern (D) size_t toHash() const nothrow @safe` if `opEquals` defined"),
                        s, sd.toChars(), sd.toChars());
                } else {
                    error(loc, ds("%sAA key type `%s` supports const equality but doesn't support const hashing"),
                        s, sd.toChars());
                }
                return errorType();
            } else {
                // defined equality & hashing
                assert(sd.xeq !== null && sd.xhash !== null);

                /* xeq and xhash may be implicitly defined by compiler. For example:
                 *   struct S { int[] arr; }
                 * With 'arr' field equality and hashing, compiler will implicitly
                 * generate functions for xopEquals and xtoHash in TypeInfo_Struct.
                 */
            }
        } else if (tbase.ty === TY.Tclass && tbase.isTypeClass()!.sym!.isInterfaceDeclaration() === null) {
            const cd: ClassDeclaration = tbase.isTypeClass()!.sym!;
            if (cd.semanticRun < PASS.semanticdone)
                dsymbolSemantic(cd, null);

            if (ClassDeclaration.object === null) {
                ObjectNotFound(Loc.initial, cd.ident!);
                return errorType();
            }

            // dmd/typesem.d:3626-3628 — the three `__gshared` caches live at module scope (see the
            // declarations above); D declares them here purely for lexical locality.
            if (feq === null)
                feq = search_function(ClassDeclaration.object, Id.opEquals!)!.isFuncDeclaration();
            if (fcmp === null)
                fcmp = search_function(ClassDeclaration.object, Id.opCmp!)!.isFuncDeclaration();
            if (fhash === null)
                fhash = search_function(ClassDeclaration.object, Id.tohash!)!.isFuncDeclaration();
            assert(fcmp !== null && feq !== null && fhash !== null);

            // `feq!`/`fcmp!` mark exactly the dereference D performs right after its own assert.
            if (feq!.vtblIndex < cd.vtbl.length && cd.vtbl.opIndex(feq!.vtblIndex) === feq) {
                // resolved: version(all) (typesem.d:3639) -> taken, body kept
                if (fcmp!.vtblIndex < cd.vtbl.length && cd.vtbl.opIndex(fcmp!.vtblIndex) !== fcmp) {
                    const s: DString = (toBasetype(mtype.index).ty !== TY.Tclass) ? ds("bottom of ") : ds("");
                    error(loc, ds("%sAA key type `%s` now requires equality rather than comparison"), s, cd.toChars());
                    errorSupplemental(loc, ds("Please override `Object.opEquals` and `Object.toHash`."));
                }
            }
        }
        mtype.next = merge2(typeSemantic(mtype.next!, loc, sc));
        transitive(mtype);

        switch (toBasetype(mtype.next).ty) {
            case TY.Tfunction:
            case TY.Tvoid:
            case TY.Tnone:
            case TY.Ttuple:
                error(loc, ds("cannot have associative array of `%s`"), mtype.next.toChars());
                // goto case Terror (dmd/typesem.d:3660) — falls into the next arm
            case TY.Terror:
                return errorType();
            default:
                break;
        }
        if (mtype.next.isScopeClass()) {
            error(loc, ds("cannot have array of scope `%s`"), mtype.next.toChars());
            return errorType();
        }
        return merge(mtype);
    };

    // dmd/typesem.d:3674
    const visitPointer = (mtype: TypePointer): Type => {
        //printf("TypePointer::semantic() %s\n", toChars());
        if (mtype.deco !== null) {
            return mtype;
        }
        const n = typeSemantic(mtype.next!, loc, sc);
        switch (toBasetype(n).ty) {
            case TY.Ttuple:
                error(loc, ds("cannot have pointer to `%s`"), n.toChars());
                // goto case Terror (dmd/typesem.d:3686) — falls into the next arm
            case TY.Terror:
                return errorType();
            default:
                break;
        }
        if (n !== mtype.next) {
            mtype.deco = null;
        }
        mtype.next = n;
        if (mtype.next.ty !== TY.Tfunction) {
            transitive(mtype);
            return merge(mtype);
        }
        // resolved: version(none) (typesem.d:3702-3705) -> not taken; the `else` arm below is live
        mtype.deco = merge(mtype).deco;
        /* Don't return merge(), because arg identifiers and default args
         * can be different
         * even though the types match
         */
        return mtype;
    };

    // dmd/typesem.d:3717
    const visitReference = (mtype: TypeReference): Type => {
        //printf("TypeReference::semantic()\n");
        const n = typeSemantic(mtype.next!, loc, sc);
        if (n !== mtype.next)
            mtype.deco = null;
        mtype.next = n;
        transitive(mtype);
        return merge(mtype);
    };

    // dmd/typesem.d:3728
    const visitFunction = (mtype: TypeFunction): Type => {
        if (mtype.deco !== null) { // if semantic() already run
            //printf("already done\n");
            return mtype;
        }
        //printf("TypeFunction::semantic() this = %p\n", mtype);
        //printf("TypeFunction::semantic() %s, sc.stc = %llx\n", mtype.toChars(), sc.stc);

        let errors = false;

        if (mtype.inuse > global.recursionLimit) {
            mtype.inuse = 0;
            error(loc, ds("recursive type"));
            return errorType();
        }

        /* Copy in order to not mess up original.
         * This can produce redundant copies if inferring return type,
         * as semantic() will get called again on this.
         */
        const tf: TypeFunction = mtype.copy().toTypeFunction();
        if (mtype.parameterList.parameters !== null) {
            tf.parameterList.parameters = mtype.parameterList.parameters.copy();
            for (let i = 0; i < mtype.parameterList.parameters.length; i++) {
                // resolved: __traits(classInstanceSize, Parameter) elided (07 §7.1) — field-wise clone
                // reproduces the memcpy (typesem.d:3757-3758). `Parameter` is `final`, so the memcpy
                // copies exactly its six declared fields; the ctor takes all six, in order.
                const src: Parameter = mtype.parameterList.parameters.opIndex(i)!;
                const p = new Parameter(src.loc, src.storageClass, src.type, src.ident,
                    src.defaultArg, src.userAttribDecl);
                tf.parameterList.parameters!.opIndexAssign(p, i);
            }
        }

        // NOTE on the `as STC` re-casts below and throughout this function: STC is a BRANDED bigint
        // flag enum (02 §4.2), so every bitwise combination is re-branded — the whitelisted
        // flag-enum re-cast of 02 §11.5c shape 4, modelling D's own `cast(STC)`. Truthiness of an
        // STC mask is the explicit `!== 0n` of 06 §2.5, never JS falsiness.
        if ((sc!.stc & STC.pure_) !== 0n)
            tf.purity = PURE.fwdref;
        if ((sc!.stc & STC.nothrow_) !== 0n)
            tf.isNothrow = true;
        if ((sc!.stc & STC.nogc) !== 0n)
            tf.isNogc = true;
        if ((sc!.stc & STC.ref_) !== 0n)
            tf.isRef = true;
        if ((sc!.stc & STC.return_) !== 0n)
            tf.isReturn = true;
        if ((sc!.stc & STC.returnScope) !== 0n)
            tf.isReturnScope = true;
        if ((sc!.stc & STC.returninferred) !== 0n)
            tf.isReturnInferred = true;
        if ((sc!.stc & STC.scope_) !== 0n)
            tf.isScopeQual = true;
        if ((sc!.stc & STC.scopeinferred) !== 0n)
            tf.isScopeInferred = true;

        //        if (tf.isReturn && !tf.isRef)
        //            tf.isScopeQual = true;                                  // return by itself means 'return scope'

        if (tf.trust === TRUST.default_) {
            if ((sc!.stc & STC.safe) !== 0n)
                tf.trust = TRUST.safe;
            else if ((sc!.stc & STC.system) !== 0n)
                tf.trust = TRUST.system;
            else if ((sc!.stc & STC.trusted) !== 0n)
                tf.trust = TRUST.trusted;
        }

        if ((sc!.stc & STC.property) !== 0n)
            tf.isProperty = true;
        if ((sc!.stc & STC.live) !== 0n)
            tf.isLive = true;

        tf.linkage = sc!.linkage;
        if (tf.linkage === LINK.system) {
            tf.linkage = target.systemLinkage();    // dmd/typesem.d:3802
        }

        // resolved: version(none) (typesem.d:3804-3822) -> not taken, @safe-inference block dropped

        let wildreturn = false;
        if (tf.next !== null) {
            sc = sc!.push();
            sc.stc = (sc.stc & ~(STC.TYPECTOR | STC.FUNCATTR)) as STC;
            tf.next = typeSemantic(tf.next, loc, sc);
            sc = sc.pop();
            // D `errors |= tf.checkRetType(loc);` — `|=` ALWAYS evaluates its right operand, and
            // `checkRetType` emits diagnostics. `errors = errors || checkRetType(...)` would
            // short-circuit and suppress them once `errors` is true, so the call is sequenced first.
            const retTypeErrors = checkRetType(tf, loc);
            errors = errors || retTypeErrors;
            if (tf.next!.isScopeClass() && !tf.isCtor) {
                error(loc, ds("functions cannot return `scope %s`"), tf.next!.toChars());
                errors = true;
            }
            if (tf.next!.hasWild())
                wildreturn = true;

            if (tf.isReturn && !tf.isRef && !hasPointers(tf.next!)) {
                tf.isReturn = false;
            }
        }

        /// Perform semantic on the default argument to a parameter
        /// Modify the `defaultArg` field of `fparam`, which must not be `null`
        /// Returns `false` whether an error was encountered.
        // dmd/typesem.d:3849 — `static bool defaultArgSemantic(ref Parameter fparam, Scope* sc)`.
        // `ref Parameter` is an alias to a class reference: no `.copy()` at the call sites (03 §3.2).
        // The `sc` parameter SHADOWS the enclosing `sc` (D marks it `static`, so no capture).
        const defaultArgSemantic = (fparam: Parameter, sc: Scope): boolean => {
            let e: Expression = fparam.defaultArg!;
            const isRefOrOut = fparam.isReference();
            const isAuto = (fparam.storageClass & (STC.auto_ | STC.autoref)) !== 0n;
            if (isRefOrOut && !isAuto) {
                e = expressionSemantic(e, sc);
                e = resolveProperties(sc, e);
            } else {
                e = inferType(e, fparam.type);
                const sc2 = sc.push();
                sc2.inDefaultArg = true;
                let iz: Initializer = new ExpInitializer(e.loc, e);
                // D `iz.initializerSemantic(sc2, fparam.type, INITnointerpret)` passes `fparam.type`
                // by `ref` (initsem.d:105) -> box + write-back (03 §3.2/§3.3).
                const txBox = { value: fparam.type! };
                iz = initializerSemantic(iz, sc2, txBox, INITnointerpret);
                fparam.type = txBox.value;
                e = initializerToExpression(iz)!;
                sc2.pop();
            }
            if (e.op === EXP.function_) { // https://issues.dlang.org/show_bug.cgi?id=4820
                const fe = e.isFuncExp()!;
                // Replace function literal with a function symbol,
                // since default arg expression must be copied when used
                // and copying the literal itself is wrong.
                e = new VarExp(e.loc, fe.fd!, false);
                e = new AddrExp(e.loc, e);
                e = expressionSemantic(e, sc);
            }
            if (isRefOrOut && (!isAuto || isLvalue(e)) &&
                !MODimplicitConv(e.type!.mod, fparam.type!.mod)) {
                const errTxt: DString = (fparam.storageClass & STC.ref_) !== 0n ? ds("ref") : ds("out");
                error(e.loc, ds("expression `%s` of type `%s` is not implicitly convertible to type `%s %s` of parameter `%s`"),
                    toErrMsg(e), e.type!.toChars(), errTxt, fparam.type!.toChars(), fparam.toChars());
            }
            e = implicitCastTo(e, sc, fparam.type!);

            // default arg must be an lvalue
            if (isRefOrOut && !isAuto &&
                (fparam.storageClass & STC.constscoperef) === 0n && !sc.previews.rvalueRefParam) {
                e = toLvalue(e, sc, ds("create default argument for `ref` / `out` parameter from"));
            }

            fparam.defaultArg = e;
            return (e.op !== EXP.error);
        };

        let wildparams = 0; // D `ubyte wildparams` -> number (09 §1)
        if (tf.parameterList.parameters !== null) {
            /* Create a scope for evaluating the default arguments for the parameters
             */
            const argsc = sc!.push();
            argsc.stc = STC.none; // don't inherit storage class
            argsc.visibility = new Visibility(Visibility.Kind.public_);
            argsc.func = null;

            let dim = tf.parameterList.length();
            for (let i = 0; i < dim; i++) {
                const fparam: Parameter = tf.parameterList.opIndex(i)!;
                fparam.storageClass = (fparam.storageClass | STC.parameter) as STC;
                mtype.inuse++;
                fparam.type = typeSemantic(fparam.type!, loc, argsc);
                mtype.inuse--;

                if (fparam.type.ty === TY.Terror) {
                    errors = true;
                    continue;
                }

                fparam.type = addStorageClass(fparam.type, fparam.storageClass);

                if ((fparam.storageClass & (STC.auto_ | STC.alias_ | STC.static_)) !== 0n) {
                    if (fparam.type === null)
                        continue;
                }

                // dmd/typesem.d:3930 — `fparam.type = fparam.type.cAdjustParamType(sc);`
                fparam.type = cAdjustParamType(fparam.type, sc!); // adjust C array and function parameter types

                const t = toBasetype(fparam.type);

                /* If fparam after semantic() turns out to be a tuple, the number of parameters may
                 * change.
                 */
                // dmd/typesem.d:3939 — `if (auto tt = t.isTypeTuple())` (06 §2.6 hoist).
                const tt = t.isTypeTuple();
                if (tt !== null) {
                    /* TypeFunction::parameter also is used as the storage of
                     * Parameter objects for FuncDeclaration. So we should copy
                     * the elements of TypeTuple::arguments to avoid unintended
                     * sharing of Parameter object among other functions.
                     */
                    // D `if (tt.arguments && tt.arguments.length)` — the first test is the SLICE
                    // POINTER (06 §2.8), the second the length; never collapse them.
                    if (tt.arguments !== null && tt.arguments.length !== 0) {
                        /* Propagate additional storage class from tuple parameters to their
                         * element-parameters.
                         * Make a copy, as original may be referenced elsewhere.
                         */
                        const tdim = tt.arguments.length;
                        const newparams: Parameters = new DArray<Parameter | null>(tdim);
                        for (let j = 0; j < tdim; j++) {
                            const narg: Parameter = tt.arguments.opIndex(j)!;

                            // https://issues.dlang.org/show_bug.cgi?id=12744
                            // If the storage classes of narg
                            // conflict with the ones in fparam, it's ignored.
                            let stc: STC = (fparam.storageClass | narg.storageClass) as STC;
                            const stc1: STC = (fparam.storageClass & (STC.ref_ | STC.out_ | STC.lazy_)) as STC;
                            const stc2: STC = (narg.storageClass & (STC.ref_ | STC.out_ | STC.lazy_)) as STC;
                            if (stc1 !== 0n && stc2 !== 0n && stc1 !== stc2) {
                                const buf1 = new OutBuffer();
                                stcToBuffer(buf1, (stc1 | ((stc1 & STC.ref_) !== 0n
                                    ? (fparam.storageClass & STC.auto_) : STC.none)) as STC);
                                const buf2 = new OutBuffer();
                                stcToBuffer(buf2, stc2);

                                error(loc, ds("incompatible parameter storage classes `%s` and `%s`"),
                                    buf1.peekChars(), buf2.peekChars());
                                errors = true;
                                stc = (stc1 | (stc & ~(STC.ref_ | STC.out_ | STC.lazy_))) as STC;
                            }
                            newparams.opIndexAssign(new Parameter(
                                loc, stc, narg.type, narg.ident, narg.defaultArg,
                                narg.userAttribDecl !== null ? narg.userAttribDecl : fparam.userAttribDecl), j);
                        }
                        fparam.type = new TypeTuple(newparams);
                        fparam.type = typeSemantic(fparam.type, loc, argsc);
                    }
                    fparam.storageClass = STC.parameter;

                    /* Reset number of parameters, and back up one to do this fparam again,
                     * now that it is a tuple
                     */
                    dim = tf.parameterList.length();
                    i--;
                    continue;
                }

                // -preview=in: Always add `ref` when used with `extern(C++)` functions
                // Done here to allow passing opaque types with `in`
                if ((fparam.storageClass & (STC.in_ | STC.ref_)) === STC.in_) {
                    switch (tf.linkage) {
                        case LINK.cpp:
                            if ((fparam.storageClass & STC.constscoperef) !== 0n)
                                fparam.storageClass = (fparam.storageClass | STC.ref_) as STC;
                            break;
                        case LINK.default_:
                        case LINK.d:
                            break;
                        default:
                            if ((fparam.storageClass & STC.constscoperef) !== 0n) {
                                error(loc, ds("cannot use `in` parameters with `extern(%s)` functions"),
                                    linkageToChars(tf.linkage));
                                errorSupplemental(loc, ds("parameter `%s` declared as `in` here"),
                                    fparam.toChars());
                            } else {
                                // Note that this deprecation will not trigger on `in ref` / `ref in`
                                // parameters, however the parser will trigger a deprecation on them.
                                deprecation(loc, ds("using `in` parameters with `extern(%s)` functions is deprecated"),
                                    linkageToChars(tf.linkage));
                                deprecationSupplemental(loc, ds("parameter `%s` declared as `in` here"),
                                    fparam.toChars());
                            }
                            break;
                    }
                }

                if (t.ty === TY.Tfunction) {
                    error(loc, ds("cannot have parameter of function type `%s`"), fparam.type.toChars());
                    errors = true;
                } else if (!fparam.isReference() &&
                           (t.ty === TY.Tstruct || t.ty === TY.Tsarray || t.ty === TY.Tenum)) {
                    const tb2 = baseElemOf(t);
                    if ((tb2.ty === TY.Tstruct && tb2.isTypeStruct()!.sym!.members === null) ||
                        (tb2.ty === TY.Tenum && tb2.isTypeEnum()!.sym!.memtype === null)) {
                        if ((fparam.storageClass & STC.constscoperef) !== 0n) {
                            error(loc, ds("cannot infer `ref` for `in` parameter `%s` of opaque type `%s`"),
                                fparam.toChars(), fparam.type.toChars());
                        } else
                            error(loc, ds("cannot have parameter of opaque type `%s` by value"),
                                fparam.type.toChars());
                        errors = true;
                    }
                } else if (!fparam.isLazy() && t.ty === TY.Tvoid) {
                    error(loc, ds("cannot have parameter of type `%s`"), fparam.type.toChars());
                    errors = true;
                }

                const isTypesafeVariadic = i + 1 === dim && tf.parameterList.varargs === VarArg.typesafe;
                const isStackAllocatedVariadic = isTypesafeVariadic &&
                    (t.isTypeDArray() !== null || t.isTypeClass() !== null);

                if (isTypesafeVariadic && t.isTypeClass() !== null) {
                    // Deprecated in 2.111, kept as a legacy feature for compatibility (currently no plan to turn it into an error)
                    deprecation(loc, ds("typesafe variadic parameters with a `class` type (`%s %s...`) are deprecated"),
                        t.isTypeClass()!.sym!.ident!.toChars(), fparam.toChars());
                }

                if (isStackAllocatedVariadic) {
                    /* typesafe variadic arguments are constructed on the stack, so must be `scope`
                     */
                    fparam.storageClass = (fparam.storageClass | STC.scope_ | STC.scopeinferred) as STC;
                }

                if ((fparam.storageClass & STC.return_) !== 0n) {
                    if (!fparam.isReference()) {
                        if ((fparam.storageClass & STC.scope_) === 0n)
                            fparam.storageClass = (fparam.storageClass | STC.scope_ | STC.scopeinferred) as STC; // 'return' implies 'scope'
                        if (tf.isRef) {
                        } else if (tf.next !== null && !hasPointers(tf.next) &&
                                   toBasetype(tf.next).ty !== TY.Tvoid) {
                            fparam.storageClass = (fparam.storageClass & ~STC.return_) as STC;   // https://issues.dlang.org/show_bug.cgi?id=18963
                        }
                    }

                    if (isStackAllocatedVariadic) {
                        /* This is because they can be constructed on the stack
                         * https://dlang.org/spec/function.html#typesafe_variadic_functions
                         */
                        error(loc, ds("typesafe variadic function parameter `%s` of type `%s` cannot be marked `return`"),
                            fparam.ident !== null ? fparam.ident.toChars() : ds(""), t.toChars());
                        errors = true;
                    }
                }

                if ((fparam.storageClass & STC.out_) !== 0n) {
                    // dmd/typesem.d:4083 — `if (ubyte m = fparam.type.mod & (…))` (06 §2.6 hoist;
                    // `m` is a `ubyte`, so the condition is the §2.5 numeric expansion).
                    const m = fparam.type.mod & (MODFlags.immutable_ | MODFlags.const_ | MODFlags.wild);
                    if (m !== 0) {
                        error(loc, ds("cannot have `%s out` parameter of type `%s`"), MODtoChars(m), t.toChars());
                        errors = true;
                    } else {
                        const tv = baseElemOf(t);
                        if (tv.ty === TY.Tstruct && tv.isTypeStruct()!.sym!.noDefaultCtor) {
                            error(loc, ds("cannot have `out` parameter of type `%s` because the default construction is disabled"),
                                fparam.type.toChars());
                            errors = true;
                        }
                    }
                }

                if (t.hasWild()) {
                    wildparams |= 1;
                    //if (tf.next && !wildreturn)
                    //    error(loc, "inout on parameter means inout must be on return type as well (if from D1 code, replace with `ref`)");
                }

                // Remove redundant storage classes for type, they are already applied
                fparam.storageClass = (fparam.storageClass & ~(STC.TYPECTOR)) as STC;

                // -preview=in: add `ref` storage class to suited `in` params
                if ((fparam.storageClass & (STC.constscoperef | STC.ref_)) === STC.constscoperef) {
                    const ts2 = baseElemOf(t).isTypeStruct();
                    // ported: D local `isPOD` -> `isPOD_` (01 Rule 2.3: it would shadow the imported
                    // free `isPOD`, which D reaches as the UFCS `ts.sym.isPOD()`).
                    const isPOD_ = ts2 === null || isPOD(ts2.sym!);          // dmd/typesem.d:4124
                    if (!isPOD_ || target.preferPassByRef(t))                  // dmd/typesem.d:4125
                        fparam.storageClass = (fparam.storageClass | STC.ref_) as STC;
                }
            }

            let fargs: Expressions | null = mtype.inferenceArguments.arguments_;

            // mtype.argumentList only provided for Implicit Function Template Instantiation
            if (mtype.inferenceArguments.length() > 0)
                fargs = resolveNamedArgs(tf, mtype.inferenceArguments, null);

            // Now that we completed semantic for the argument types,
            // run semantic on their default values,
            // bearing in mind tuples have been expanded.
            // We need to keep a pair of [oidx, eidx] (original index,
            // extended index), as we need to run semantic when `oidx` changes.
            // `size_t.max` is the NOT-SET sentinel here, never an arithmetic value -> SIZE_MAX (09 §1.3).
            let tupleOrigIdx = SIZE_MAX;
            let tupleExtIdx = SIZE_MAX;
            // D `foreach (oidx, oparam, eidx, eparam; tf.parameterList)` — the SemanticForeachDg
            // `opApply` overload (05 §11 / 06 §1.8): 0 continues, non-zero breaks. This body never
            // breaks, so it always returns 0.
            tf.parameterList.opApplySemantic((oidx: number, oparam: Parameter,
                                             eidx: number, eparam: Parameter): number => {
                // oparam (original param) will always have the default arg
                // if there's one, but `eparam` will not if it's an expanded
                // tuple. When we see an expanded tuple, we need to save its
                // position to get the offset in it later on.
                if (oparam.defaultArg !== null) {
                    // Get the obvious case out of the way
                    if (oparam === eparam) {
                        // D `errors |= !defaultArgSemantic(eparam, argsc);` — `|=` always evaluates
                        // the call (which mutates `eparam.defaultArg` and may emit diagnostics).
                        const ok = defaultArgSemantic(eparam, argsc);
                        errors = errors || !ok;
                    }
                    // We're seeing a new tuple
                    else if (tupleOrigIdx === SIZE_MAX || tupleOrigIdx < oidx) {
                        /* https://issues.dlang.org/show_bug.cgi?id=18572
                         *
                         * If a tuple parameter has a default argument, when expanding the parameter
                         * tuple the default argument tuple must also be expanded.
                         */
                        tupleOrigIdx = oidx;
                        tupleExtIdx = eidx;
                        const ok = defaultArgSemantic(oparam, argsc);
                        errors = errors || !ok;
                        const te = oparam.defaultArg.isTupleExp();
                        if (te !== null && te.exps !== null && te.exps.length !== 0)
                            eparam.defaultArg = te.exps.opIndex(0);
                    }
                    // Processing an already-seen tuple
                    else {
                        const te = oparam.defaultArg.isTupleExp();
                        if (te !== null && te.exps !== null && te.exps.length !== 0)
                            eparam.defaultArg = te.exps.opIndex(eidx - tupleExtIdx);
                    }
                }

                // We need to know the default argument to resolve `auto ref`,
                // hence why this has to take place as the very last step.
                /* Resolve "auto ref" storage class to be either ref or value,
                 * based on the argument matching the parameter
                 */
                if ((eparam.storageClass & STC.auto_) !== 0n) {
                    let farg: Expression | null =
                        (fargs !== null && eidx < fargs.length) ? fargs.opIndex(eidx) : null;
                    if (farg === null)
                        farg = eparam.defaultArg;

                    if (farg !== null && (eparam.storageClass & STC.ref_) !== 0n) {
                        // dmd/typesem.d:4191 — `if (!farg.isLvalue() || farg.isBitField())`. swept
                        // (11 §2.5): the free `isBitField` (dmd/expressionsem.d:20129) is live and
                        // exported at expressionsem.ts:22483; D uses the returned
                        // `BitFieldDeclaration` reference in a boolean context (09 §9).
                        if (!isLvalue(farg) || isBitField(farg) !== null)
                            eparam.storageClass = (eparam.storageClass & ~STC.ref_) as STC; // value parameter
                        eparam.storageClass = (eparam.storageClass & ~STC.auto_) as STC;    // https://issues.dlang.org/show_bug.cgi?id=14656
                        eparam.storageClass = (eparam.storageClass | STC.autoref) as STC;
                    } else if (mtype.incomplete && (eparam.storageClass & STC.ref_) !== 0n) {
                        // the default argument may have been temporarily removed,
                        // see usage of `TypeFunction.incomplete`.
                        // https://issues.dlang.org/show_bug.cgi?id=19891
                        eparam.storageClass = (eparam.storageClass & ~STC.auto_) as STC;
                        eparam.storageClass = (eparam.storageClass | STC.autoref) as STC;
                    } else if ((eparam.storageClass & STC.ref_) !== 0n) {
                        error(loc, ds("cannot explicitly instantiate template function with `auto ref` parameter"));
                        errors = true;
                    } else {
                        error(loc, ds("`auto` can only be used as part of `auto ref` for template function parameters"));
                        errors = true;
                    }
                }
                return 0;
            });

            argsc.pop();
        }
        if (tf.isWild())
            wildparams |= 2;

        if (wildreturn && wildparams === 0) {
            error(loc, ds("`inout` on `return` means `inout` must be on a parameter as well for `%s`"),
                mtype.toChars());
            errors = true;
        }
        tf.isInOutParam = (wildparams & 1) !== 0;
        tf.isInOutQual = (wildparams & 2) !== 0;

        if (tf.isProperty && (tf.parameterList.varargs !== VarArg.none || tf.parameterList.length() > 2)) {
            error(loc, ds("properties can only have zero, one, or two parameter"));
            errors = true;
        }

        if (tf.parameterList.varargs === VarArg.variadic && tf.linkage !== LINK.d &&
            tf.parameterList.length() === 0 && !sc!.inCfile) {
            error(loc, ds("variadic functions with non-D linkage must have at least one parameter"));
            errors = true;
        }

        if (errors)
            return errorType();

        if (tf.next !== null)
            tf.deco = merge(tf).deco;

        /* Don't return merge(), because arg identifiers and default args
         * can be different
         * even though the types match
         */
        return tf;
    };

    // dmd/typesem.d:4256
    const visitDelegate = (mtype: TypeDelegate): Type => {
        //printf("TypeDelegate::semantic() %s\n", mtype.toChars());
        if (mtype.deco !== null) { // if semantic() already run
            //printf("already done\n");
            return mtype;
        }
        mtype.next = typeSemantic(mtype.next!, loc, sc);
        if (mtype.next.ty !== TY.Tfunction)
            return errorType();

        /* In order to deal with https://issues.dlang.org/show_bug.cgi?id=4028
         * perhaps default arguments should
         * be removed from next before the merge.
         */
        // resolved: version(none) (typesem.d:4272-4275) -> not taken; the `else` arm below is live
        /* Don't return merge(), because arg identifiers and default args
         * can be different
         * even though the types match
         */
        mtype.deco = merge(mtype).deco;
        return mtype;
    };

    // dmd/typesem.d:4287
    const visitIdentifier = (mtype: TypeIdentifier): Type => {
        const t: Ref<Type | null> = { value: null };
        const e: Ref<Expression | null> = { value: null };
        const s: Ref<Dsymbol | null> = { value: null };
        //printf("TypeIdentifier::semantic(%s)\n", mtype.toChars());
        // `Loc` is an alias-safe register member (03 §9.1) — compared by value, shared on read.
        if (!mtype.loc.equals(Loc.initial))
            resolve(mtype, mtype.loc, sc, e, t, s);
        else
            resolve(mtype, loc, sc, e, t, s);

        if (t.value !== null) {
            //printf("\tit's a type %d, %s, %s\n", t.ty, t.toChars(), t.deco);
            return addMod(t.value, mtype.mod);
        }

        if (s.value !== null) {
            const td = s.value.isTemplateDeclaration();
            // dmd/typesem.d:4307 — `td.computeOneMember();`, UFCS onto the free function
            // (templatesem.d:441), which returns early on a null `td`.
            computeOneMember(td);
            if (td !== null && td.onemember !== null && td.onemember.isAggregateDeclaration() !== null)
                error(loc, ds("template %s `%s` is used as a type without instantiation; to instantiate it use `%s!(arguments)`"),
                    s.value.kind(), s.value.toPrettyChars(), s.value.ident!.toChars());
            else
                error(loc, ds("%s `%s` is used as a type"), s.value.kind(), s.value.toPrettyChars());
            //assert(0);
        } else if (e.value!.op === EXP.variable) { // special case: variable is used as a type
            /*
                N.B. This branch currently triggers for the following code
                template test(x* x)
                {

                }
                i.e. the compiler prints "variable x is used as a type"
                which isn't a particularly good error message (x is a variable?).
            */
            const varDecl: Dsymbol = toDsymbol(mtype, sc)!;
            const varDeclModule: Module | null = varDecl.getModule(); //This can be null

            error(loc, ds("variable `%s` is used as a type"), mtype.toChars());
            //Check for null to avoid https://issues.dlang.org/show_bug.cgi?id=22574
            if ((varDeclModule !== null) && varDeclModule !== sc!._module) { // variable is imported
                errorSupplemental(
                    varDeclModule.loc,
                    ds("variable `%s` is imported here from: `%s`"),
                    varDecl.toChars(),
                    varDeclModule.toPrettyChars(),
                );
            }

            errorSupplemental(varDecl.loc, ds("variable `%s` is declared here"), varDecl.toChars());
        } else
            error(loc, ds("`%s` is used as a type"), mtype.toChars());
        return errorType();
    };

    // dmd/typesem.d:4349
    const visitInstance = (mtype: TypeInstance): Type => {
        const t: Ref<Type | null> = { value: null };
        const e: Ref<Expression | null> = { value: null };
        const s: Ref<Dsymbol | null> = { value: null };

        //printf("TypeInstance::semantic(%p, %s)\n", this, toChars());
        {
            const errors = global.errors;
            resolve(mtype, loc, sc, e, t, s);
            // if we had an error evaluating the symbol, suppress further errors
            if (t.value === null && errors !== global.errors)
                return errorType();
        }

        if (t.value === null) {
            if (e.value === null && s.value !== null && s.value.errors) {
                // if there was an error evaluating the symbol, it might actually
                // be a type. Avoid misleading error messages.
                error(loc, ds("`%s` had previous errors"), mtype.toChars());
            } else
                error(loc, ds("`%s` is used as a type"), mtype.toChars());
            return errorType();
        }
        return t.value;
    };

    // dmd/typesem.d:4379
    const visitTypeof = (mtype: TypeTypeof): Type => {
        //printf("TypeTypeof::semantic() %s\n", mtype.toChars());
        const e: Ref<Expression | null> = { value: null };
        const t: Ref<Type | null> = { value: null };
        const s: Ref<Dsymbol | null> = { value: null };
        resolve(mtype, loc, sc, e, t, s);
        if (s.value !== null) {
            const gt = getType(s.value);
            t.value = gt;
            if (gt !== null)
                t.value = addMod(gt, mtype.mod);
        }
        if (t.value === null) {
            error(loc, ds("`%s` is used as a type"), mtype.toChars());
            return errorType();
        }
        return t.value;
    };

    // dmd/typesem.d:4396
    const visitTraits = (mtype: TypeTraits): Type => {
        const e: Ref<Expression | null> = { value: null };
        const t: Ref<Type | null> = { value: null };
        const s: Ref<Dsymbol | null> = { value: null };
        resolve(mtype, loc, sc, e, t, s);

        if (t.value === null) {
            if (K.on)
                keepReadErrors();       // the kept-module engine: the answer decides the report
            if (!analysisSeesErrors())  // `!global.errors`, read as dmd/errors.ts `analysisSeesErrors`
                error(mtype.loc, ds("`%s` does not give a valid type"), mtype.toChars());
            else if (K.on)
                keepErrorState(null);   // the kept-module engine: not reported, after an error
            return errorType();
        }
        return t.value;
    };

    // dmd/typesem.d:4412
    const visitReturn = (mtype: TypeReturn): Type => {
        //printf("TypeReturn::semantic() %s\n", toChars());
        const e: Ref<Expression | null> = { value: null };
        const t: Ref<Type | null> = { value: null };
        const s: Ref<Dsymbol | null> = { value: null };
        resolve(mtype, loc, sc, e, t, s);
        if (s.value !== null) {
            const gt = getType(s.value);
            t.value = gt;
            if (gt !== null)
                t.value = addMod(gt, mtype.mod);
        }
        if (t.value === null) {
            error(loc, ds("`%s` is used as a type"), mtype.toChars());
            return errorType();
        }
        return t.value;
    };

    // dmd/typesem.d:4429
    const visitStruct = (mtype: TypeStruct): Type => {
        //printf("TypeStruct::semantic('%s')\n", mtype.toChars());
        if (mtype.deco !== null)
            return mtype;

        /* Don't semantic for sym because it should be deferred until
         * sizeof needed or its members accessed.
         */
        // instead, parent should be set correctly
        assert(mtype.sym!.parent !== null);

        if (mtype.sym!.type!.ty === TY.Terror)
            return errorType();

        return merge(mtype);
    };

    // dmd/typesem.d:4447
    const visitEnum = (mtype: TypeEnum): Type => {
        //printf("TypeEnum::semantic() %s\n", toChars());
        return mtype.deco !== null ? mtype : merge(mtype);
    };

    // dmd/typesem.d:4453
    const visitClass = (mtype: TypeClass): Type => {
        //printf("TypeClass::semantic(%s)\n", mtype.toChars());
        if (mtype.deco !== null)
            return mtype;

        /* Don't semantic for sym because it should be deferred until
         * sizeof needed or its members accessed.
         */
        // instead, parent should be set correctly
        assert(mtype.sym!.parent !== null);

        if (mtype.sym!.type!.ty === TY.Terror)
            return errorType();

        return merge(mtype);
    };

    // dmd/typesem.d:4471
    const visitTuple = (mtype: TypeTuple): Type => {
        //printf("TypeTuple::semantic(this = %p)\n", this);
        //printf("TypeTuple::semantic() %p, %s\n", this, toChars());
        if (mtype.deco === null)
            mtype.deco = merge(mtype).deco;

        /* Don't return merge(), because a tuple with one type has the
         * same deco as that type.
         */
        return mtype;
    };

    // dmd/typesem.d:4484
    const visitSlice = (mtype: TypeSlice): Type => {
        //printf("TypeSlice::semantic() %s\n", toChars());
        const tn = typeSemantic(mtype.next!, loc, sc);
        //printf("next: %s\n", tn.toChars());

        const tbn = toBasetype(tn);
        if (tbn.ty !== TY.Ttuple) {
            error(loc, ds("can only slice type sequences, not `%s`"), tbn.toChars());
            return errorType();
        }
        // tag-proved RTTI downcast: the `tbn.ty != Ttuple` test immediately above IS the proof
        const tt = tbn as unknown as TypeTuple;

        mtype.lwr = semanticLength(sc!, tbn, mtype.lwr!);
        mtype.upr = semanticLength(sc!, tbn, mtype.upr!);
        mtype.lwr = ctfeInterpret(mtype.lwr);    // dmd/typesem.d:4500
        mtype.upr = ctfeInterpret(mtype.upr);    // dmd/typesem.d:4501
        if (mtype.lwr.op === EXP.error || mtype.upr.op === EXP.error)
            return errorType();

        const i1: bigint = toUInteger(mtype.lwr);        // dmd/typesem.d:4505
        const i2: bigint = toUInteger(mtype.upr);        // dmd/typesem.d:4506
        if (!(i1 <= i2 && i2 <= BigInt(tt.arguments!.length))) {
            error(loc, ds("slice `[%llu..%llu]` is out of range of `[0..%llu]`"),
                i1, i2, BigInt(tt.arguments!.length));
            return errorType();
        }

        mtype.next = tn;
        transitive(mtype);

        const args: Parameters = new DArray<Parameter | null>();
        // `cast(size_t)(i2 - i1)` / the `[i1 .. i2]` bounds — bigint -> index domain (09 §1.1)
        args.reserve(Number(i2 - i1));
        for (const arg of tt.arguments!.opSlice(Number(i1), Number(i2))) {
            args.push(arg);
        }
        const t: Type = new TypeTuple(args);
        return typeSemantic(t, loc, sc);
    };

    // dmd/typesem.d:4527
    const visitMixin = (mtype: TypeMixin): Type => {
        //printf("TypeMixin::semantic() %s\n", toChars());

        const e: Ref<Expression | null> = { value: null };
        const t: Ref<Type | null> = { value: null };
        const s: Ref<Dsymbol | null> = { value: null };
        resolve(mtype, loc, sc, e, t, s);

        if (t.value !== null && t.value.ty !== TY.Terror)
            return t.value;

        error(mtype.loc, ds("`mixin(%s)` does not give a valid type"), mtype.obj!.toChars());
        return errorType();
    };

    // dmd/typesem.d:4543
    const visitTag = (mtype: TypeTag): Type => {
        //printf("TypeTag.semantic() %s\n", mtype.toChars());
        // dmd/typesem.d:4546 — nested `Type returnType(TypeTag tt)`.
        const returnType = (tt: TypeTag): Type => {
            const t: Type = tt.resolved!;
            // To make const checking work, the const STC needs to be added:
            // t = t.resolved.addSTC(mtype.mod.ModToStc);
            // However, this currently fails compilable/test22875.i
            // Apparently there's some aliasing going on, where mutable
            // versions of the type also get const applied to them.
            return t.deco !== null ? t : merge(t);
        };

        if (mtype.resolved !== null) {
            /* struct S s, *p;
             */
            return returnType(mtype);
        }

        /* Find the current scope by skipping tag scopes.
         * In C, tag scopes aren't considered scopes.
         */
        let sc2: Scope = sc!;
        for (;;) {
            sc2 = sc2.inner()!;
            const scopesym = sc2.scopesym;
            if (scopesym!.isStructDeclaration() !== null) {
                sc2 = sc2.enclosing!;
                continue;
            }
            break;
        }

        /* Declare mtype as a struct/union/enum declaration
         */
        // dmd/typesem.d:4582 — nested `void declareTag()`.
        const declareTag = (): void => {
            // dmd/typesem.d:4584 — nested `void declare(ScopeDsymbol sd)` (double nesting kept).
            const declare = (sd: ScopeDsymbol): void => {
                sd.members = mtype.members;
                const scopesym = sc2.inner()!.scopesym!;
                if (scopesym.members !== null)
                    scopesym.members.push(sd);
                if (scopesym.symtab !== null && scopesym.symtabInsert(sd) === null) {
                    const s2 = scopesym.symtabLookup(sd, mtype.id!);
                    // dmd/typesem.d:4593 — `handleTagSymbols(*sc2, sd, s2, scopesym);` `s2!`: the failed
                    // `symtabInsert` just found an entry under `mtype.id`, so the lookup of that id is non-null.
                    handleTagSymbols(sc2, sd, s2!, scopesym);
                }
                sd.parent = sc2.parent;
                dsymbolSemantic(sd, sc2);
            };

            switch (mtype.tok) {
                case TOK.enum_: {
                    const ed = new EnumDeclaration(mtype.loc, mtype.id, mtype.base);
                    declare(ed);
                    mtype.resolved = visitEnum(new TypeEnum(ed));
                    break;
                }

                case TOK.struct_: {
                    const sd = new StructDeclaration(mtype.loc, mtype.id, false);
                    sd.alignment = mtype.packalign.copy();
                    declare(sd);
                    mtype.resolved = visitStruct(new TypeStruct(sd));
                    break;
                }

                case TOK.union_: {
                    const ud = new UnionDeclaration(mtype.loc, mtype.id);
                    ud.alignment = mtype.packalign.copy();
                    declare(ud);
                    mtype.resolved = visitStruct(new TypeStruct(ud));
                    break;
                }

                default:
                    assertUnreachable(); // D `assert(0)`
            }
        };

        /* If it doesn't have a tag by now, supply one.
         * It'll be unique, and therefore introducing.
         * Declare it, and done.
         */
        if (mtype.id === null) {
            mtype.id = Identifier.generateId(ds("__tag"));
            declareTag();
            return returnType(mtype);
        }

        /* look for pre-existing declaration
         */
        const scopesym: Ref<Dsymbol | null> = { value: null };
        const s = searchScope(sc2, mtype.loc, mtype.id, scopesym, SearchOpt.ignoreErrors | SearchOpt.tagNameSpace);
        if (s === null || s.isModule() !== null) {
            // no pre-existing declaration, so declare it
            if (mtype.tok === TOK.enum_ && mtype.members === null)
                error(mtype.loc, ds("`enum %s` is incomplete without members"), mtype.id.toChars()); // C11 6.7.2.3-3
            declareTag();
            return returnType(mtype);
        }

        /* A redeclaration only happens if both declarations are in
         * the same scope
         */
        const redeclar = (scopesym.value === sc2.inner()!.scopesym);

        if (redeclar) {
            if (mtype.tok === TOK.enum_ && s.isEnumDeclaration() !== null) {
                const ed = s.isEnumDeclaration()!;
                if (mtype.members !== null && ed.members !== null)
                    error(mtype.loc, ds("`%s` already has members"), mtype.id.toChars());
                else if (ed.members === null) {
                    ed.members = mtype.members;
                } else {
                }
                mtype.resolved = ed.type;
            } else if ((mtype.tok === TOK.union_ && s.isUnionDeclaration() !== null) ||
                       (mtype.tok === TOK.struct_ && s.isStructDeclaration() !== null)) {
                // Add members to original declaration
                const sd = s.isStructDeclaration()!;
                if (mtype.members !== null && sd.members !== null) {
                    /* struct S { int b; };
                     * struct S { int a; } *s;
                     */
                    error(mtype.loc, ds("`%s` already has members"), mtype.id.toChars());
                } else if (sd.members === null) {
                    /* struct S;
                     * struct S { int a; } *s;
                     */
                    sd.members = mtype.members;
                    if (sd.semanticRun === PASS.semanticdone) {
                        /* The first semantic pass marked `sd` as an opaque struct.
                         * Re-run semantic so that all newly assigned members are
                         * picked up and added to the symtab.
                         */
                        sd.semanticRun = PASS.semantic;
                        dsymbolSemantic(sd, sc2);
                    }
                } else {
                    /* struct S { int a; };
                     * struct S* s;
                     */
                }
                mtype.resolved = sd.type;
            } else {
                /* int S;
                 * struct S { int a; } *s;
                 */
                error(mtype.loc, ds("redeclaration of `%s`"), mtype.id.toChars());
                mtype.resolved = errorType();
            }
        } else if (mtype.members !== null) {
            /* struct S;
             * { struct S { int a; } *s; }
             */
            declareTag();
        } else {
            if (mtype.tok === TOK.enum_ && s.isEnumDeclaration() !== null) {
                mtype.resolved = s.isEnumDeclaration()!.type;
            } else if ((mtype.tok === TOK.union_ && s.isUnionDeclaration() !== null) ||
                       (mtype.tok === TOK.struct_ && s.isStructDeclaration() !== null)) {
                /* struct S;
                 * { struct S* s; }
                 */
                mtype.resolved = s.isStructDeclaration()!.type;
            } else {
                /* union S;
                 * { struct S* s; }
                 */
                error(mtype.loc, ds("redeclaring `%s %s` as `%s %s`"),
                    s.kind(), s.toChars(), Token.toCharsValue(mtype.tok), mtype.id.toChars());
                declareTag();
            }
        }
        return returnType(mtype);
    };

    // dmd/typesem.d:4750 — S4, the 23-arm dispatch. Emitted IN FULL (13 §7.5 rule 1).
    switch (type.ty) {
        default:              return visitType(type);
        case TY.Tcomplex32:
        case TY.Tcomplex64:
        case TY.Tcomplex80:   return visitComplex(type.isTypeBasic()!);
        case TY.Tvector:      return visitVector(type.isTypeVector()!);
        case TY.Tsarray:      return visitSArray(type.isTypeSArray()!);
        case TY.Tarray:       return visitDArray(type.isTypeDArray()!);
        case TY.Taarray:      return visitAArray(type.isTypeAArray()!);
        case TY.Tpointer:     return visitPointer(type.isTypePointer()!);
        case TY.Treference:   return visitReference(type.isTypeReference()!);
        case TY.Tfunction:    return visitFunction(type.isTypeFunction()!);
        case TY.Tdelegate:    return visitDelegate(type.isTypeDelegate()!);
        case TY.Tident:       return visitIdentifier(type.isTypeIdentifier()!);
        case TY.Tinstance:    return visitInstance(type.isTypeInstance()!);
        case TY.Ttypeof:      return visitTypeof(type.isTypeTypeof()!);
        case TY.Ttraits:      return visitTraits(type.isTypeTraits()!);
        case TY.Treturn:      return visitReturn(type.isTypeReturn()!);
        case TY.Tstruct:      return visitStruct(type.isTypeStruct()!);
        case TY.Tenum:        return visitEnum(type.isTypeEnum()!);
        case TY.Tclass:       return visitClass(type.isTypeClass()!);
        case TY.Ttuple:       return visitTuple(type.isTypeTuple()!);
        case TY.Tslice:       return visitSlice(type.isTypeSlice()!);
        case TY.Tmixin:       return visitMixin(type.isTypeMixin()!);
        case TY.Ttag:         return visitTag(type.isTypeTag()!);
    }
}

/**
 * dmd/typesem.d:4779 — `Type trySemantic(Type type, Loc loc, Scope* sc)`.
 *
 * Run `typeSemantic` with diagnostics gagged. Returns the analysed type, or `null` if any error
 * (or an errored result) was produced. On success, a second UNgagged pass is run over a syntax
 * copy when deprecations were gagged, so they still reach the user (dlang issue 19107).
 *
 * NOTE the name: `dmd.expressionsem.trySemantic` is a DIFFERENT function (typesem.d:2388/6813
 * spell it module-qualified for exactly that reason). This one takes a `Type`.
 */
export function trySemantic(type: Type, loc: Loc, sc: Scope | null): Type | null {
    //printf("+trySemantic(%s) %d\n", toChars(), global.errors);

    // Needed to display any deprecations that were gagged
    const tcopy = type.syntaxCopy();

    const errors = global.startGagging();
    let t: Type | null;
    try {
        t = typeSemantic(type, loc, sc);
    } catch (ex) {
        // WALL PROTECTION (11 §2.5), not in D: `typeSemantic` still reaches walls,
        // and a throw between `startGagging` and `endGagging` would leak `global.gag` for the life
        // of the process — silently suppressing every later diagnostic. D needs no such exit.
        global.endGagging(errors);
        throw ex;
    }
    if (global.endGagging(errors) || t.ty === TY.Terror) { // if any errors happened
        t = null;
    } else {
        // If `typeSemantic` succeeded, there may have been deprecations that
        // were gagged due the `startGagging` above.  Run again to display
        // those deprecations.  https://issues.dlang.org/show_bug.cgi?id=19107
        if (global.gaggedDeprecations > 0)
            typeSemantic(tcopy, loc, sc);
    }
    //printf("-trySemantic(%s) %d\n", toChars(), global.errors);
    return t;
}

/************************************
 * dmd/typesem.d:4813 — `Type merge(Type type)`.
 * If an identical type to `type` is in `type.stringtable`, return
 * the latter one. Otherwise, add it to `type.stringtable`.
 * Some types don't get merged and are returned as-is.
 * Params:
 *      type = Type to check against existing types
 * Returns:
 *      the type that was merged
 *
 * Cost: on a cache miss, one full type-deco mangling + one string-table intern.
 */
export function merge(type: Type): Type {
    // G1 (06 §3.6): the Tsarray/Taarray/Tfunction arms `goto default;` (typesem.d:4837/4847/4852)
    // INTO the default arm, whose body is a CONDITIONAL early return. A bare `break` would silently
    // skip that leave-unmerged check, so the default arm is a shared closure returning the SIGNAL and
    // every jump site (and `default:` itself) tests it.
    const defaultArm = (): boolean => {
        const n = nextOf(type);
        return n !== null && n.deco === null;
    };
    // S5 — emitted IN FULL.
    switch (type.ty) {
        case TY.Terror:
        case TY.Ttypeof:
        case TY.Tident:
        case TY.Tinstance:
        case TY.Tmixin:
        case TY.Ttag:
            return type;        // don't merge placeholder types

        case TY.Tsarray: {
            // prevents generating the mangle if the array dim is not yet known
            // dmd/typesem.d:4826 — `if (auto ie = type.isTypeSArray().dim.isIntegerExp())` (06 §2.6).
            const ie = type.isTypeSArray()!.dim!.isIntegerExp();
            if (ie !== null) {
                // After TypeSemantic, the length is always converted to size_t, but the parser
                // usually generates regular integer types (e.g. in cast(const ubyte[2])) which
                // it may try to merge, which then leads to failing implicit conversions as 2LU != 2
                // according to Expression.equals. Only merge array types with size_t lengths for now.
                // https://github.com/dlang/dmd/issues/21179
                if (ie.type !== Type.tsize_t)
                    return type;

                if (defaultArm()) // goto default (dmd/typesem.d:4837)
                    return type;
                break;
            }
            return type;
        }

        case TY.Tenum:
            break;

        case TY.Taarray:
            if (merge(type.isTypeAArray()!.index!).deco === null)
                return type;
            if (defaultArm()) // goto default (dmd/typesem.d:4847)
                return type;
            break;

        case TY.Tfunction:
            if (nextOf(type) === null) // don't merge if return type is unknown
                return type;
            if (defaultArm()) // goto default (dmd/typesem.d:4852)
                return type;
            break;

        default:
            if (defaultArm())
                return type;
            break;
    }

    //printf("merge(%s)\n", toChars());
    if (type.deco !== null)
        return type;

    const buf = new OutBuffer();
    buf.reserve(32);

    mangleToBuffer(type, buf);

    // `buf[]` is the VIEW slice (08 §13a.2) — `opSliceAll()`, NEVER `extractChars()`.
    // `update` needs the concrete `T.init` from the caller (08 §5): `Type.stringtable` is
    // `StringTable<Type | null>`, so the class-reference `.init` is `null`.
    const sv = Type.stringtable.update(buf.opSliceAll(), null);
    if (sv.value !== null) {
        const t: Type = sv.value;
        // resolved: debug { printf } (typesem.d:4873-4878) -> dropped; the assert below is OUTSIDE it
        assert(t.deco !== null);
        //printf("old value, deco = '%s' %p\n", t.deco, t.deco);
        if (K.on) keepMergeFound(type, t);   // the kept-module engine: another symbol's type has this mangling
        return t;
    } else {
        const t: Type = stripDefaultArgs(type)!;
        sv.value = t;
        // D `type.deco = t.deco = cast(char*)sv.toDchars();` — both slots take the interned key.
        // The mangle ABI is ASCII, so the JS-string `deco` form round-trips the key bytes exactly.
        const deco = dsToJs(sv.toDchars());
        type.deco = deco;
        t.deco = deco;
        if (K.on) keepType(t);   // the kept-module engine: the running unit created this table entry
        //printf("new value, deco = '%s' %p\n", t.deco, t.deco);
        return t;
    }
}

/*************************************
 * dmd/typesem.d:4897 — `Type merge2(Type type)`.
 * This version does a merge even if the deco is already computed.
 * Necessary for types that have a deco, but are not merged.
 */
export function merge2(type: Type): Type {
    //printf("merge2(%s)\n", toChars());
    let t: Type = type;
    // D `assert(t);` — `t` is a non-null class reference in the port, so the test is vacuous.
    if (t.deco === null)
        return merge(t);

    // D `Type.stringtable.lookup(t.deco, strlen(t.deco))` — the ptr+len pair is the whole logical
    // C string; the port's `deco` carries its own length, so `ds(t.deco)` IS that slice.
    const sv = Type.stringtable.lookup(ds(t.deco));
    if (sv !== null && sv.value !== null) {
        t = sv.value;
        assert(t.deco !== null);
    } else if (K.on) {
        // the kept-module engine drops some entries its dead units created (keepType): a kept type still carrying
        // that deco puts its entry back, as the first merge of the mangling in this compile
        Type.stringtable.update(ds(t.deco), null).value = t;
        if (t.ty === TY.Taarray) keepMergedAA(t, (t as TypeAArray).loc);
    } else
        return assertUnreachable(); // D `assert(0)`
    return t;
}

// resolved: `private enum LOGDEFAULTINIT = 0;` (dmd/typesem.d:4916) — a manifest constant read only
// by `static if (LOGDEFAULTINIT)` printf blocks (typesem.d:4928, 7604, 7662, 7680, 7693, 7707, 7728);
// every one folds to false, so no TS binding is emitted (07 §3 / preamble §M1).

/***************************************
 * dmd/typesem.d:4921 — `Expression defaultInitLiteral(Type t, Loc loc)`.
 * Use when we prefer the default initializer to be a literal,
 * rather than a global immutable variable.
 *
 * NOTE (1.43 change, same name): the struct arm's field-skip test is now BITFIELD-AWARE — it tracks
 * a `ulong bitoffset` cursor instead of 1.42's `uint offset`. Both cursors stay in the bigint domain
 * (09 §8): they are byte/bit offsets derived from `Type.size`, which is `uinteger_t`.
 *
 * Return type: D declares `Expression`, but the tail forwards to `defaultInit` (typesem.d:7600),
 * whose dispatch `default:` arm can yield null for a non-basic type with no default initializer —
 * so the honest port-side return is `Expression | null`, matching `defaultInit`'s own.
 */
export function defaultInitLiteral(t: Type, loc: Loc): Expression | null {

    if (t.isTypeError() !== null)
        return ErrorExp.get();
    // dmd/typesem.d:4926 — `if (auto ts = t.isTypeStruct())` (06 §2.6 hoist).
    const ts = t.isTypeStruct();
    if (ts !== null) {
        // resolved: static if (LOGDEFAULTINIT == 0) -> false, printf block dropped (typesem.d:4928)
        // dmd/typesem.d:4932-4933 — `ts.sym.size(loc)`: the DSYMBOL `size` (dsymbolsem.d:993), a
        // different overload family from the typesem `size(Type, Loc)` used below (04 §1B). D's
        // braces scope its function-local import and carry nothing else.
        sizeDsymbol(ts.sym!, loc);
        if (ts.sym!.sizeok !== Sizeok.done)
            return ErrorExp.get();

        const structelems: Expressions = new DArray<Expression | null>(ts.sym!.nonHiddenFields());
        let bitoffset = 0n;
        const nelems = structelems.length; // D `foreach (j; 0 .. structelems.length)` — bound captured once
        for (let j = 0; j < nelems; j++) {
            const vd: VarDeclaration = ts.sym!.fields.opIndex(j)!;
            let e: Expression | null;
            if (vd.inuse !== 0) {
                error(loc, ds("circular reference to `%s`"), vd.toPrettyChars());
                return ErrorExp.get();
            }
            let vbitoffset = BigInt(vd.offset) * 8n;
            const vbf = vd.isBitFieldDeclaration();
            if (vbf !== null)
                vbitoffset += BigInt(vbf.bitOffset);
            if (vbitoffset < bitoffset || size(vd.type!) === 0n)
                e = null;
            else if (vd._init !== null) {
                if (vd._init.isVoidInitializer() !== null)
                    e = null;
                else {
                    e = getConstInitializer(vd, false);             // dmd/typesem.d:4961
                }
            } else
                e = defaultInitLiteral(vd.type!, loc);
            if (e !== null && e.op === EXP.error)
                return e;
            if (e !== null) {
                if (vbf !== null)
                    bitoffset = vbitoffset + BigInt(vbf.fieldWidth);
                else
                    bitoffset = vbitoffset + size(vd.type!) * 8n;
            }
            structelems.opIndexAssign(e, j);
        }
        const structinit = new StructLiteralExp(loc, ts.sym, structelems);

        /* Copy from the initializer symbol for larger symbols,
         * otherwise the literals expressed as code get excessively large.
         */
        if (size(ts, loc) > BigInt(target.ptrsize * 4) && !needsNested(ts))
            structinit.useStaticInit = true;

        structinit.type = ts;
        return structinit;
    }
    // dmd/typesem.d:4988 — `if (auto tv = t.isTypeVector())` (06 §2.6 hoist).
    const tv = t.isTypeVector();
    if (tv !== null) {
        //printf("TypeVector::defaultInitLiteral()\n");
        assert(tv.basetype!.ty === TY.Tsarray);
        const e = defaultInitLiteral(tv.basetype!, loc); // D: `Expression e = …` (deref'd below)
        const ve = new VectorExp(loc, e, tv);
        ve.type = tv;
        // D `cast(int)(tv.basetype.size(loc) / tv.elementType().size(loc))` — an exact bigint
        // division, then the int truncation of 09 §2.
        ve.dim = Number(BigInt.asIntN(32, size(tv.basetype!, loc) / size(tv.elementType(), loc)));
        return ve;
    }
    // dmd/typesem.d:4998 — `if (auto tsa = t.isTypeSArray())` (06 §2.6 hoist).
    const tsa = t.isTypeSArray();
    if (tsa !== null) {
        // resolved: static if (LOGDEFAULTINIT == 0) -> false, printf block dropped (typesem.d:5000)
        const d = Number(toInteger(tsa.dim!)); // D `cast(size_t)tsa.dim.toInteger()` — index domain (09 §1.1)
        let elementinit: Expression;
        if (tsa.next!.ty === TY.Tvoid)
            elementinit = defaultInitLiteral(Type.tuns8, loc)!;
        else
            elementinit = defaultInitLiteral(tsa.next!, loc)!;
        const elements: Expressions = new DArray<Expression | null>(d);
        for (let i = 0; i < elements.length; i++)
            elements.opIndexAssign(null, i);
        const ae = ArrayLiteralExp.fromBasis(loc, tsa, elementinit, elements);
        return ae;
    }
    return defaultInit(t, loc);
}

/***************************************
 * dmd/typesem.d:5030 — `Expression getProperty(Type t, Scope* scope_, Loc loc, Identifier ident,
 * int flag, Expression src = null)`.
 * Calculate built-in properties which just the type is necessary.
 *
 * Params:
 *  t = the type for which the property is calculated
 *  scope_ = the scope from which the property is being accessed. Used for visibility checks only.
 *  loc = the location where the property is encountered
 *  ident = the identifier of the property
 *  flag = if flag & 1, don't report "not a property" error and just return NULL.
 *  src = expression for type `t` or null.
 * Returns:
 *      expression representing the property, or null if not a property and (flag & 1)
 */
export function getProperty(t: Type, scope_: Scope, loc: Loc, ident: Identifier, flag: number,
    src: Expression | null = null): Expression | null {

    // dmd/typesem.d:5033 — the dispatch `default:` arm (non-basic types).
    const visitType = (mt: Type): Expression | null => {
        let e: Expression | null;
        // resolved: static if (LOGDOTEXP == 0) -> false, printf block dropped (typesem.d:5036)
        if (ident === Id.__sizeof) {
            const sz = size(mt, loc);
            if (sz === SIZE_INVALID)
                return ErrorExp.get();
            return new IntegerExp(loc, sz, Type.tsize_t);
        } else if (ident === Id.__xalignof) {
            const explicitAlignment = alignment(mt);
            const naturalAlignment = alignsize(mt);
            const actualAlignment = (explicitAlignment.isDefault() ? naturalAlignment : explicitAlignment.get());
            return new IntegerExp(loc, BigInt(actualAlignment), Type.tsize_t);
        } else if (ident === Id._init) {
            const tb = toBasetype(mt);
            e = defaultInitLiteral(mt, loc);
            if (tb.ty === TY.Tstruct && needsNested(tb)) {
                // D dereferences the literal here with no null test — the `!` marks that same point.
                e!.isStructLiteralExp()!.useStaticInit = true;
            }
            return e;
        } else if (ident === Id._mangleof) {
            if (mt.deco === null) {
                error(loc, ds("forward reference of type `%s.mangleof`"), mt.toChars());
                return ErrorExp.get();
            } else {
                // D `mt.deco.toDString()` — the `char*` deco read as a slice; the port's `deco` is
                // already the logical (NUL-free) key string, so `ds()` IS that slice.
                e = new StringExp(loc, [...ds(mt.deco)]);
                const sc = new Scope(); // D `Scope sc;` — a stack-resident value Scope
                sc.eSink = global.errorSink;
                e = expressionSemantic(e, sc);
            }
            return e;
        } else if (ident === Id.stringof) {
            const s = mt.toChars();
            // `toChars()` yields a NUL-terminated view; D's `.toDString()` is the bytes BEFORE the
            // first NUL (02 §11.2) -> `cstr`.
            e = new StringExp(loc, [...cstr(s)]);
            const sc = new Scope();
            sc.eSink = global.errorSink;
            e = expressionSemantic(e, sc);
            return e;
        } else if (flag !== 0 && mt !== Type.terror) {
            return null;
        }

        let s: Dsymbol | null = null;
        const derefType = mt.isTypePointer() !== null ? nextOf(mt)! : mt;

        if (derefType.isTypeStruct() !== null || derefType.isTypeClass() !== null ||
            derefType.isTypeEnum() !== null)
            s = toDsymbol(derefType, null);
        if (s !== null)
            s = search_correct(s, ident);
        if (s !== null && !symbolIsVisible(scope_, s))
            s = null;

        if (mt === Type.terror)
            return ErrorExp.get();

        if (s !== null) {
            // `ident.toErrMsg()` / `mt.toErrMsg()` bind to the `toErrMsg(const RootObject)` overload
            // (hdrgen.d:112), whose runtime dispatch for an Identifier/Type operand is `toChars()`
            // (hdrgen.d:118-121) — D's overload choice is static, so the fold is exact.
            error(loc, ds("no property `%s` for type `%s`"), ident.toChars(), mt.toChars());
            errorSupplemental(s.loc, ds("did you mean `%s`?"),
                ident === s.ident ? s.toPrettyChars() : dsymbolToErrMsg(s));
        } else if (ident === Id.opCall && mt.ty === TY.Tclass)
            error(loc, ds("no property `%s` for type `%s`, did you mean `new %s`?"),
                ident.toChars(), mt.toChars(), mt.toPrettyChars());
        else {
            // dmd/typesem.d:5133 — `else if (const n = importHint(ident.toString()))` (06 §2.6 hoist;
            // the tested value is a nullable slice -> §2.8 pointer test).
            const n = importHint(ident.toString());
            if (n !== null)
                error(loc, ds("no property `%s` for type `%s`, perhaps `import %.*s;` is needed?"),
                    ident.toChars(), mt.toChars(), n.length, n);
            else {
                if (src !== null) {
                    error(loc, ds("no property `%s` for `%s` of type `%s`"),
                        ident.toChars(), toErrMsg(src), mt.toPrettyChars(true));
                    const s2 = search_correctScope(scope_, ident);
                    // UFCS
                    if (s2 !== null && s2.isFuncDeclaration() !== null) {
                        if (s2.ident === ident) {
                            errorSupplemental(s2.loc,
                                ds("cannot call %s `%s` with UFCS because it is not declared at module scope"),
                                s2.kind(), dsymbolToErrMsg(s2));
                        } else
                            errorSupplemental(s2.loc, ds("did you mean %s `%s`?"),
                                s2.kind(), dsymbolToErrMsg(s2));
                    }
                } else
                    error(loc, ds("no property `%s` for type `%s`"),
                        ident.toChars(), mt.toPrettyChars(true));

                // dmd/typesem.d:5140 — `if (auto dsym = derefType.toDsymbol(scope_))` (06 §2.6).
                const dsym = toDsymbol(derefType, scope_);
                if (dsym !== null) {
                    const sym = dsym.isAggregateDeclaration();
                    if (sym !== null) {
                        if (sym.members === null) {
                            errorSupplemental(sym.loc, ds("`%s %s` is opaque and has no members."),
                                sym.kind(), mt.toPrettyChars(true));
                            return ErrorExp.get();
                        }

                        // dmd/typesem.d:5150 — `if (auto fd = search_function(sym, Id.opDispatch))`.
                        const fd = search_function(sym, Id.opDispatch!);
                        if (fd !== null) {
                            const td = fd.isTemplateDeclaration();
                            if (td !== null) {
                                e = defaultInitLiteral(mt, loc);
                                // D dereferences `e.loc` with no null test — the `!` marks that point.
                                const se = new StringExp(e!.loc, [...ident.toString()]);
                                const tiargs: Objects = DArray.from<RootObject | null>(se);
                                const dti = DotTemplateInstanceExp.fromName(e!.loc, e, Id.opDispatch, tiargs);
                                dti.ti!.tempdecl = td;
                                // dmd/typesem.d:5159 — D passes `DotExpFlag.none` (== 0) into `bool gag`.
                                dotTemplateSemanticProp(dti, scope_, false);
                                return ErrorExp.get();
                            }
                        }
                    }
                    errorSupplemental(dsym.loc, ds("%s `%s` defined here"),
                        dsym.kind(), dsymbolToErrMsg(dsym));
                }
            }
        }

        return ErrorExp.get();
    };

    // dmd/typesem.d:5172 — `Expression visitError(TypeError)`. The parameter is unnamed in D.
    const visitError = (_mt: TypeError): Expression | null => {
        return ErrorExp.get();
    };

    // dmd/typesem.d:5177
    const visitBasic = (mt: TypeBasic): Expression | null => {
        // dmd/typesem.d:5179
        const integerValue = (i: bigint): Expression => {
            return new IntegerExp(loc, i, mt);
        };

        // dmd/typesem.d:5184
        const intValue = (i: bigint): Expression => {
            return new IntegerExp(loc, i, Type.tint32);
        };

        // dmd/typesem.d:5189 — `Expression floatValue(real_t r)`. `real_t` erases to `number` (09 §6).
        const floatValue = (r: number): Expression => {
            if (isReal(mt) || isImaginary(mt))
                return new RealExp(loc, r, mt);
            else {
                return new ComplexExp(loc, new complex_t(r, r), mt);
            }
        };

        // dmd/typesem.d:5199 — the per-property inner switches. The float arms read
        // `target.{Float,Double,Real}Properties` (target.d:436-438), whose integral fields are bigint
        // (D `long`), so `intValue` takes them unconverted. The integral `max`/`min` bounds are
        // compile-time constants (09 §8: `long.max`/`ulong.max` are exact only in the bigint domain).

        //printf("TypeBasic::getProperty('%s')\n", ident.toChars());
        if (ident === Id.max) {
            switch (mt.ty) {
                case TY.Tint8:        return integerValue(127n);                    // byte.max
                case TY.Tuns8:        return integerValue(255n);                    // ubyte.max
                case TY.Tint16:       return integerValue(32767n);                  // short.max
                case TY.Tuns16:       return integerValue(65535n);                  // ushort.max
                case TY.Tint32:       return integerValue(2147483647n);             // int.max
                case TY.Tuns32:       return integerValue(4294967295n);             // uint.max
                case TY.Tint64:       return integerValue(9223372036854775807n);    // long.max
                case TY.Tuns64:       return integerValue(18446744073709551615n);   // ulong.max
                case TY.Tbool:        return integerValue(1n);                      // bool.max
                case TY.Tchar:        return integerValue(255n);                    // char.max
                case TY.Twchar:       return integerValue(65535n);                  // wchar.max
                case TY.Tdchar:       return integerValue(0x10FFFFn);               // dchar.max
                case TY.Tcomplex32:
                case TY.Timaginary32:
                case TY.Tfloat32:     return floatValue(target.FloatProperties.max);
                case TY.Tcomplex64:
                case TY.Timaginary64:
                case TY.Tfloat64:     return floatValue(target.DoubleProperties.max);
                case TY.Tcomplex80:
                case TY.Timaginary80:
                case TY.Tfloat80:     return floatValue(target.RealProperties.max);
                default:              break;
            }
        } else if (ident === Id.min) {
            switch (mt.ty) {
                case TY.Tint8:        return integerValue(-128n);                   // byte.min
                case TY.Tuns8:
                case TY.Tuns16:
                case TY.Tuns32:
                case TY.Tuns64:
                case TY.Tbool:
                case TY.Tchar:
                case TY.Twchar:
                case TY.Tdchar:       return integerValue(0n);
                case TY.Tint16:       return integerValue(-32768n);                 // short.min
                case TY.Tint32:       return integerValue(-2147483648n);            // int.min
                case TY.Tint64:       return integerValue(-9223372036854775808n);   // long.min
                default:              break;
            }
        } else if (ident === Id.min_normal) {
            switch (mt.ty) {
                case TY.Tcomplex32:
                case TY.Timaginary32:
                case TY.Tfloat32:     return floatValue(target.FloatProperties.min_normal);
                case TY.Tcomplex64:
                case TY.Timaginary64:
                case TY.Tfloat64:     return floatValue(target.DoubleProperties.min_normal);
                case TY.Tcomplex80:
                case TY.Timaginary80:
                case TY.Tfloat80:     return floatValue(target.RealProperties.min_normal);
                default:              break;
            }
        } else if (ident === Id.nan) {
            switch (mt.ty) {
                case TY.Tcomplex32:
                case TY.Tcomplex64:
                case TY.Tcomplex80:
                case TY.Timaginary32:
                case TY.Timaginary64:
                case TY.Timaginary80:
                case TY.Tfloat32:
                case TY.Tfloat64:
                case TY.Tfloat80:     return floatValue(target.RealProperties.nan);
                default:              break;
            }
        } else if (ident === Id.infinity) {
            switch (mt.ty) {
                case TY.Tcomplex32:
                case TY.Tcomplex64:
                case TY.Tcomplex80:
                case TY.Timaginary32:
                case TY.Timaginary64:
                case TY.Timaginary80:
                case TY.Tfloat32:
                case TY.Tfloat64:
                case TY.Tfloat80:     return floatValue(target.RealProperties.infinity);
                default:              break;
            }
        } else if (ident === Id.dig) {
            switch (mt.ty) {
                case TY.Tcomplex32:
                case TY.Timaginary32:
                case TY.Tfloat32:     return intValue(target.FloatProperties.dig);
                case TY.Tcomplex64:
                case TY.Timaginary64:
                case TY.Tfloat64:     return intValue(target.DoubleProperties.dig);
                case TY.Tcomplex80:
                case TY.Timaginary80:
                case TY.Tfloat80:     return intValue(target.RealProperties.dig);
                default:              break;
            }
        } else if (ident === Id.epsilon) {
            switch (mt.ty) {
                case TY.Tcomplex32:
                case TY.Timaginary32:
                case TY.Tfloat32:     return floatValue(target.FloatProperties.epsilon);
                case TY.Tcomplex64:
                case TY.Timaginary64:
                case TY.Tfloat64:     return floatValue(target.DoubleProperties.epsilon);
                case TY.Tcomplex80:
                case TY.Timaginary80:
                case TY.Tfloat80:     return floatValue(target.RealProperties.epsilon);
                default:              break;
            }
        } else if (ident === Id.mant_dig) {
            switch (mt.ty) {
                case TY.Tcomplex32:
                case TY.Timaginary32:
                case TY.Tfloat32:     return intValue(target.FloatProperties.mant_dig);
                case TY.Tcomplex64:
                case TY.Timaginary64:
                case TY.Tfloat64:     return intValue(target.DoubleProperties.mant_dig);
                case TY.Tcomplex80:
                case TY.Timaginary80:
                case TY.Tfloat80:     return intValue(target.RealProperties.mant_dig);
                default:              break;
            }
        } else if (ident === Id.max_10_exp) {
            switch (mt.ty) {
                case TY.Tcomplex32:
                case TY.Timaginary32:
                case TY.Tfloat32:     return intValue(target.FloatProperties.max_10_exp);
                case TY.Tcomplex64:
                case TY.Timaginary64:
                case TY.Tfloat64:     return intValue(target.DoubleProperties.max_10_exp);
                case TY.Tcomplex80:
                case TY.Timaginary80:
                case TY.Tfloat80:     return intValue(target.RealProperties.max_10_exp);
                default:              break;
            }
        } else if (ident === Id.max_exp) {
            switch (mt.ty) {
                case TY.Tcomplex32:
                case TY.Timaginary32:
                case TY.Tfloat32:     return intValue(target.FloatProperties.max_exp);
                case TY.Tcomplex64:
                case TY.Timaginary64:
                case TY.Tfloat64:     return intValue(target.DoubleProperties.max_exp);
                case TY.Tcomplex80:
                case TY.Timaginary80:
                case TY.Tfloat80:     return intValue(target.RealProperties.max_exp);
                default:              break;
            }
        } else if (ident === Id.min_10_exp) {
            switch (mt.ty) {
                case TY.Tcomplex32:
                case TY.Timaginary32:
                case TY.Tfloat32:     return intValue(target.FloatProperties.min_10_exp);
                case TY.Tcomplex64:
                case TY.Timaginary64:
                case TY.Tfloat64:     return intValue(target.DoubleProperties.min_10_exp);
                case TY.Tcomplex80:
                case TY.Timaginary80:
                case TY.Tfloat80:     return intValue(target.RealProperties.min_10_exp);
                default:              break;
            }
        } else if (ident === Id.min_exp) {
            switch (mt.ty) {
                case TY.Tcomplex32:
                case TY.Timaginary32:
                case TY.Tfloat32:     return intValue(target.FloatProperties.min_exp);
                case TY.Tcomplex64:
                case TY.Timaginary64:
                case TY.Tfloat64:     return intValue(target.DoubleProperties.min_exp);
                case TY.Tcomplex80:
                case TY.Timaginary80:
                case TY.Tfloat80:     return intValue(target.RealProperties.min_exp);
                default:              break;
            }
        }
        // `intValue` is reached only from the walled float arms above; keep the D-faithful nested
        // declaration and mark it read for `noUnusedLocals` until `target`'s FP tables land.
        void intValue;
        void floatValue;
        return visitType(mt);
    };

    // dmd/typesem.d:5410
    const visitVector = (mt: TypeVector): Expression | null => {
        return visitType(mt);
    };

    // dmd/typesem.d:5415
    const visitEnum = (mt: TypeEnum): Expression | null => {
        let e: Expression | null;
        if (ident === Id.max || ident === Id.min) {
            return getMaxMinValue(mt.sym!, loc, ident);
        } else if (ident === Id._init) {
            e = defaultInitLiteral(mt, loc);
        } else if (ident === Id.stringof) {
            e = new StringExp(loc, [...mt.toString()]); // D `mt.toString()`, NUL-free (rootobject.d:50-51)
            const sc = new Scope(); // D `Scope sc;` — note: no `eSink` here, unlike visitType
            e = expressionSemantic(e, sc);
        } else if (ident === Id._mangleof) {
            e = visitType(mt);
        } else {
            e = getProperty(toBasetype(mt), scope_, loc, ident, flag);
        }
        return e;
    };

    // dmd/typesem.d:5443
    const visitTuple = (mt: TypeTuple): Expression | null => {
        let e: Expression | null;
        // resolved: static if (LOGDOTEXP == 0) -> false, printf block dropped (typesem.d:5446)
        if (ident === Id.length) {
            e = new IntegerExp(loc, BigInt(mt.arguments!.length), Type.tsize_t);
        } else if (ident === Id._init) {
            e = defaultInitLiteral(mt, loc);
        } else if (flag !== 0) {
            e = null;
        } else {
            error(loc, ds("no property `%s` for sequence `%s`"), ident.toChars(), mt.toChars());
            e = ErrorExp.get();
        }
        return e;
    };

    // dmd/typesem.d:5470 — S6, emitted IN FULL. NOTE the `default:` carries a TERNARY on
    // `isTypeBasic()` — reproduce it, never split it into per-basic-TY cases.
    switch (t.ty) {
        default:        return t.isTypeBasic() !== null ?
                                // tag-proved RTTI downcast: the adjacent `isTypeBasic()` IS the proof
                                visitBasic(t as unknown as TypeBasic) :
                                visitType(t);

        case TY.Terror:    return visitError(t.isTypeError()!);
        case TY.Tvector:   return visitVector(t.isTypeVector()!);
        case TY.Tenum:     return visitEnum(t.isTypeEnum()!);
        case TY.Ttuple:    return visitTuple(t.isTypeTuple()!);
    }
}

/***************************************
 * dmd/typesem.d:5492 — `private void resolveExp(Expression exp, out Type t, out Expression e,
 * out Dsymbol s)`.
 * Determine if Expression `exp` should instead be a Type, a Dsymbol, or remain an Expression.
 * Params:
 *      exp = Expression to look at
 *      t = if exp should be a Type, set t to that Type else null
 *      s = if exp should be a Dsymbol, set s to that Dsymbol else null
 *      e = if exp should remain an Expression, set e to that Expression else null
 *
 * D module-private (`private void resolveExp`, dmd/typesem.d:5492). The chunks it was split
 * across during translation are now one stitched module, so it stays module-local — not
 * `export`ed — matching `fixTo` / `isTypeNext` / `searchX` / `getMatchError` and the file's other
 * D-private helpers. No sibling module or test reaches it (verified by tree-wide grep).
 */
function resolveExp(exp: Expression, t: Ref<Type | null>, e: Ref<Expression | null>,
    s: Ref<Dsymbol | null>): void {
    // D `out` params: default-init all three slots on entry (03 §3.3).
    t.value = null;
    e.value = null;
    s.value = null;

    if (exp.isTypeExp() !== null)
        t.value = exp.type;
    else {
        // dmd/typesem.d:5496 — `else if (auto ve = exp.isVarExp())` (06 §2.6 hoist, chained: each
        // subsequent probe runs ONLY if the previous one missed, so the hoists NEST into the else).
        const ve = exp.isVarExp();
        if (ve !== null) {
            if (ve.var_.isVarDeclaration() !== null)
                e.value = exp;
            else
                s.value = ve.var_;
        } else {
            const te = exp.isTemplateExp();
            if (te !== null)
                s.value = te.td;
            else {
                const se = exp.isScopeExp();
                if (se !== null)
                    s.value = se.sds;
                else if (exp.isFuncExp() !== null) {
                    s.value = getDsymbol(exp);                      // dmd/typesem.d:5508
                } else {
                    const dte = exp.isDotTemplateExp();
                    if (dte !== null)
                        s.value = dte.td;
                    else if (exp.isErrorExp() !== null)
                        t.value = Type.terror;
                    else
                        e.value = exp;
                }
            }
        }
    }
}

/************************************
 * dmd/typesem.d:5530 — `void resolve(Type mt, Loc loc, Scope* sc, out Expression pe, out Type pt,
 * out Dsymbol ps, bool intypeid = false)`.
 * Resolve type 'mt' to either type, symbol, or expression.
 * If errors happened, resolved to Type.terror.
 *
 * Params:
 *  mt = type to be resolved
 *  loc = the location where the type is encountered
 *  sc = the scope of the type
 *  pe = is set if t is an expression
 *  pt = is set if t is a type
 *  ps = is set if t is a symbol
 *  intypeid = true if in type id
 *
 * `sc` is `Scope | null` (02 §10.1): `visitTypeof` null-tests it (typesem.d:5785). The other arms
 * dereference unconditionally, so their `!` marks exactly where D faults.
 */
export function resolve(mt: Type, loc: Loc, sc: Scope | null, pe: Ref<Expression | null>,
    pt: Ref<Type | null>, ps: Ref<Dsymbol | null>, intypeid = false): void {
    // D `out` params: default-init all three slots on entry (03 §3.3).
    pe.value = null;
    pt.value = null;
    ps.value = null;

    // dmd/typesem.d:5532
    const returnExp = (e: Expression): void => {
        pe.value = e;
        pt.value = null;
        ps.value = null;
    };

    // dmd/typesem.d:5539
    const returnType = (t: Type): void => {
        pe.value = null;
        pt.value = t;
        ps.value = null;
    };

    // dmd/typesem.d:5546
    const returnSymbol = (s: Dsymbol): void => {
        pe.value = null;
        pt.value = null;
        ps.value = s;
    };

    // dmd/typesem.d:5553
    const returnError = (): void => {
        returnType(Type.terror);
    };

    // dmd/typesem.d:5558 — the dispatch `default:` arm.
    const visitType = (mt: Type): void => {
        //printf("Type::resolve() %s, %d\n", mt.toChars(), mt.ty);
        const t = typeSemantic(mt, loc, sc);
        assert(t !== null);
        returnType(t);
    };

    // dmd/typesem.d:5566
    const visitSArray = (mt: TypeSArray): void => {
        //printf("TypeSArray::resolve() %s\n", mt.toChars());
        resolve(mt.next!, loc, sc, pe, pt, ps, intypeid);
        //printf("s = %p, e = %p, t = %p\n", ps, pe, pt);
        if (pe.value !== null) {
            // It's really an index expression
            // dmd/typesem.d:5574 — `if (Dsymbol s = getDsymbol(pe))` (06 §2.6 hoist).
            const s = getDsymbol(pe.value);
            if (s !== null)
                pe.value = new DsymbolExp(loc, s);
            returnExp(new ArrayExp(loc, pe.value, mt.dim));
        } else if (ps.value !== null) {
            const s: Dsymbol = ps.value;
            // dmd/typesem.d:5580 — `if (auto tup = s.isTupleDeclaration())` (06 §2.6 hoist).
            const tup = s.isTupleDeclaration();
            if (tup !== null) {
                mt.dim = semanticLengthTupleDecl(sc!, tup, mt.dim!);
                mt.dim = ctfeInterpret(mt.dim);    // dmd/typesem.d:5584
                if (mt.dim.op === EXP.error)
                    return returnError();

                const d: bigint = toUInteger(mt.dim);        // dmd/typesem.d:5588
                if (d >= BigInt(tup.objects!.length)) {
                    error(loc, ds("sequence index `%llu` out of bounds `[0 .. %llu]`"),
                        d, BigInt(tup.objects!.length));
                    return returnError();
                }

                // `cast(size_t)d` — bigint -> index domain (09 §1.1)
                const o: RootObject = tup.objects!.opIndex(Number(d))!;
                // resolved: with(DYNCAST) -> case labels re-qualified (06 §3.3)
                switch (o.dyncast()) {
                    case DYNCAST.dsymbol:
                        // tag-proved RTTI downcast: the `dyncast()` arm IS the proof
                        return returnSymbol(o as unknown as Dsymbol);
                    case DYNCAST.expression: {
                        // tag-proved RTTI downcast: the `dyncast()` arm IS the proof
                        const e = o as unknown as Expression;
                        if (e.op === EXP.dSymbol)
                            return returnSymbol(e.isDsymbolExp()!.s!);
                        else
                            return returnExp(e);
                    }
                    case DYNCAST.type:
                        // tag-proved RTTI downcast: the `dyncast()` arm IS the proof
                        return returnType(addMod(o as unknown as Type, mt.mod));
                    default:
                        break;
                }

                /* Create a new TupleDeclaration which
                 * is a slice [d..d+1] out of the old one.
                 * Do it this way because TemplateInstance::semanticTiargs()
                 * can handle unresolved Objects this way.
                 */
                const objects: Objects = new DArray<RootObject | null>(1);
                objects.opIndexAssign(o, 0);
                return returnSymbol(new TupleDeclaration(loc, tup.ident!, objects));
            } else
                return visitType(mt);
        } else {
            if (pt.value!.ty !== TY.Terror)
                mt.next = pt.value; // prevent re-running semantic() on 'next'
            visitType(mt);
        }
    };

    // dmd/typesem.d:5633
    const visitDArray = (mt: TypeDArray): void => {
        //printf("TypeDArray::resolve() %s\n", mt.toChars());
        resolve(mt.next!, loc, sc, pe, pt, ps, intypeid);
        //printf("s = %p, e = %p, t = %p\n", ps, pe, pt);
        if (pe.value !== null) {
            // It's really a slice expression
            // dmd/typesem.d:5641 — `if (Dsymbol s = getDsymbol(pe))` (06 §2.6 hoist).
            const s = getDsymbol(pe.value);
            if (s !== null)
                pe.value = new DsymbolExp(loc, s);
            returnExp(new ArrayExp(loc, pe.value));
        } else if (ps.value !== null) {
            // dmd/typesem.d:5646 — `if (auto tup = ps.isTupleDeclaration())` (06 §2.6 hoist).
            const tup = ps.value.isTupleDeclaration();
            if (tup !== null) {
                // keep ps
            } else
                visitType(mt);
        } else {
            if (pt.value!.ty !== TY.Terror)
                mt.next = pt.value; // prevent re-running semantic() on 'next'
            visitType(mt);
        }
    };

    // dmd/typesem.d:5662
    const visitAArray = (mt: TypeAArray): void => {
        //printf("TypeAArray::resolve() %s\n", mt.toChars());
        // Deal with the case where we thought the index was a type, but
        // in reality it was an expression.
        if (mt.index!.ty === TY.Tident || mt.index!.ty === TY.Tinstance ||
            mt.index!.ty === TY.Tsarray) {
            const e: Ref<Expression | null> = { value: null };
            const t: Ref<Type | null> = { value: null };
            const s: Ref<Dsymbol | null> = { value: null };
            resolve(mt.index!, loc, sc, e, t, s, intypeid);
            if (e.value !== null) {
                // It was an expression -
                // Rewrite as a static array
                const tsa = new TypeSArray(mt.next, e.value);
                tsa.mod = mt.mod; // just copy mod field so tsa's semantic is not yet done
                return resolve(tsa, loc, sc, pe, pt, ps, intypeid);
            } else if (t.value !== null)
                mt.index = t.value;
            else
                error(loc, ds("index is not a type or an expression"));
        }
        visitType(mt);
    };

    /*************************************
     * dmd/typesem.d:5696 — `void visitIdentifier(TypeIdentifier mt)`.
     * Takes an array of Identifiers and figures out if
     * it represents a Type or an Expression.
     * Output:
     *      if expression, pe is set
     *      if type, pt is set
     */
    const visitIdentifier = (mt: TypeIdentifier): void => {
        //printf("TypeIdentifier::resolve(sc = %p, idents = '%s')\n", sc, mt.toChars());
        if (mt.ident === Id.ctfe) {
            error(loc, ds("variable `__ctfe` cannot be read at compile time"));
            return returnError();
        }
        if (mt.ident === Id.builtin_va_list) { // gcc has __builtin_va_xxxx for stdarg.h
            /* Since we don't support __builtin_va_start, -arg, -end, we don't
             * have to actually care what -list is. A void* will do.
             * If we ever do care, import core.stdc.stdarg and pull
             * the definition out of that, similarly to how std.math is handled for PowExp
             */
            pt.value = target.va_listType(loc, sc);     // dmd/typesem.d:5711
            return;
        }

        const scopesym: Ref<Dsymbol | null> = { value: null };
        let s = searchScope(sc!, loc, mt.ident!, scopesym);
        /*
         * https://issues.dlang.org/show_bug.cgi?id=1170
         * https://issues.dlang.org/show_bug.cgi?id=10739
         *
         * If a symbol is not found, it might be declared in
         * a mixin-ed string or a mixin-ed template, so before
         * issuing an error semantically analyze all string/template
         * mixins that are members of the current ScopeDsymbol.
         */
        if (s === null && sc!.enclosing !== null) {
            const sds = sc!.enclosing!.scopesym;
            if (sds !== null && sds.members !== null) {
                // dmd/typesem.d:5731 — nested `void semanticOnMixin(Dsymbol member)`.
                const semanticOnMixin = (member: Dsymbol): void => {
                    // dmd/typesem.d:5733 — `if (auto compileDecl = member.isMixinDeclaration())`.
                    const compileDecl = member.isMixinDeclaration();
                    if (compileDecl !== null)
                        dsymbolSemantic(compileDecl, sc);
                    else {
                        const mixinTempl = member.isTemplateMixin();
                        if (mixinTempl !== null)
                            dsymbolSemantic(mixinTempl, sc);
                    }
                };
                // D `sds.members.foreachDsymbol( s => semanticOnMixin(s) )` — UFCS onto the free
                // `foreachDsymbol` (dsymbol.d:73). The `void` overload's delegate takes a
                // possibly-null slot (08 §3), and D's lambda dereferences it: `!` marks that.
                foreachDsymbol(sds.members, (m: Dsymbol | null): number => {
                    semanticOnMixin(m!);
                    return 0;
                });
                s = searchScope(sc!, loc, mt.ident!, scopesym);
            }
        }

        if (s !== null) {
            // https://issues.dlang.org/show_bug.cgi?id=16042
            // If `f` is really a function template, then replace `f`
            // with the function template declaration.
            // dmd/typesem.d:5747 — `if (auto f = s.isFuncDeclaration())` (06 §2.6 hoist).
            const f = s.isFuncDeclaration();
            if (f !== null) {
                let td = getFuncTemplateDecl(f);
                if (td !== null) {
                    // If not at the beginning of the overloaded list of
                    // `TemplateDeclaration`s, then get the beginning
                    if (td.overroot !== null)
                        td = td.overroot;
                    s = td;
                }
            }
        }

        resolveHelper(mt, loc, sc!, s, scopesym.value, pe, pt, ps, intypeid);
        if (pt.value !== null)
            pt.value = addMod(pt.value, mt.mod);
    };

    // dmd/typesem.d:5766
    const visitInstance = (mt: TypeInstance): void => {
        // Note close similarity to TypeIdentifier::resolve()

        //printf("TypeInstance::resolve(sc = %p, tempinst = '%s')\n", sc, mt.tempinst.toChars());
        dsymbolSemantic(mt.tempinst!, sc);
        if (global.gag === 0 && mt.tempinst!.errors)
            return returnError();

        resolveHelper(mt, loc, sc!, mt.tempinst, null, pe, pt, ps, intypeid);
        if (pt.value !== null)
            pt.value = addMod(pt.value, mt.mod);
        //if (pt) printf("pt = %d '%s'\n", pt.ty, pt.toChars());
    };

    // dmd/typesem.d:5781
    const visitTypeof = (mt: TypeTypeof): void => {
        //printf("TypeTypeof::resolve(this = %p, sc = %p, idents = '%s')\n", mt, sc, mt.toChars());
        //static int nest; if (++nest == 50) *(char*)0=0;

        // G5 (06 §4, BAIL shape): `Lerr:` (typesem.d:5794) sits INSIDE the `if (mt.inuse)` block and
        // is jumped to from six later sites (5828, 5839, 5855, 5860, 5867, 5872). The tail is
        // terminal (`mt.inuse--; return returnError();`), so it becomes a zero-parameter nested arrow
        // that CAPTURES `mt` — never positional parameters — declared before its first use.
        const LerrTail = (): void => {
            mt.inuse--;
            return returnError();
        };

        if (sc === null) {
            error(loc, ds("invalid scope"));
            return returnError();
        }
        if (mt.inuse !== 0) {
            mt.inuse = 2;
            error(loc, ds("circular `typeof` definition"));
            return LerrTail(); // falls into Lerr: (dmd/typesem.d:5794)
        }
        mt.inuse++;
        try {
            /* Currently we cannot evaluate 'exp' in speculative context, because
             * the type implementation may leak to the final execution. Consider:
             *
             * struct S(T) {
             *   string toString() const { return "x"; }
             * }
             * void main() {
             *   alias X = typeof(S!int());
             *   assert(typeid(X).toString() == "x");
             * }
             */
            const sc2 = sc.push();

            if (mt.exp!.isTypeidExp() === null)
                /* Treat typeof(typeid(exp)) as needing
                 * the full semantic analysis of the typeid.
                 * https://issues.dlang.org/show_bug.cgi?id=20958
                 */
                sc2.intypeof = 1;

            let exp2 = expressionSemantic(mt.exp!, sc2);
            exp2 = resolvePropertiesOnly(sc2, exp2);           // dmd/typesem.d:5821
            sc2.pop();

            if (exp2.op === EXP.error) {
                if (global.gag === 0)
                    mt.exp = exp2;
                return LerrTail(); // goto Lerr (dmd/typesem.d:5828)
            }
            mt.exp = exp2;

            if ((mt.exp.op === EXP.type || mt.exp.op === EXP.scope_) &&
                // https://issues.dlang.org/show_bug.cgi?id=23863
                // compile time sequences are valid types
                mt.exp.type!.isTypeTuple() === null) {
                // R1: 1.42's `mt.exp.checkType()` became 1.43's `!mt.exp.hasValidType()` — the name AND
                // the POLARITY flipped (expressionsem.d:573). The leading `!` is load-bearing.
                if (!sc.inCfile && // in (extended) C typeof may be used on types as with sizeof
                    !hasValidType(mt.exp))
                    return LerrTail(); // goto Lerr (dmd/typesem.d:5839)

                /* Today, 'typeof(func)' returns void if func is a
                 * function template (TemplateExp), or
                 * template lambda (FuncExp).
                 * It's actually used in Phobos as an idiom, to branch code for
                 * template functions.
                 */
            }
            // dmd/typesem.d:5849 — `if (auto f = <ternary chain>)` (06 §2.6 hoist).
            const f = mt.exp.op === EXP.variable    ? mt.exp.isVarExp()!.var_.isFuncDeclaration()
                    : mt.exp.op === EXP.dotVariable ? mt.exp.isDotVarExp()!.var_!.isFuncDeclaration() : null;
            if (f !== null) {
                // f might be a unittest declaration which is incomplete when compiled
                // without -unittest. That causes a segfault in checkForwardRef, see
                // https://issues.dlang.org/show_bug.cgi?id=20626
                if ((f.isUnitTestDeclaration() === null || global.params.useUnitTests) &&
                    checkForwardRef(f, loc))
                    return LerrTail(); // goto Lerr (dmd/typesem.d:5855)
            }
            // dmd/typesem.d:5857 — `if (auto f = isFuncAddress(mt.exp))` (06 §2.6 hoist; the name
            // shadows the previous `f` in D, which scopes it to this `if`).
            const f2 = isFuncAddress(mt.exp);
            if (f2 !== null) {
                if (checkForwardRef(f2, loc))
                    return LerrTail(); // goto Lerr (dmd/typesem.d:5860)
            }

            const t = mt.exp.type;
            if (t === null) {
                error(loc, ds("expression `%s` has no type"), mt.exp.toChars());
                return LerrTail(); // goto Lerr (dmd/typesem.d:5867)
            }
            if (t.ty === TY.Ttypeof) {
                error(loc, ds("forward reference to `%s`"), mt.toChars());
                return LerrTail(); // goto Lerr (dmd/typesem.d:5872)
            }
            if (mt.idents.length === 0) {
                returnType(addMod(t, mt.mod));
            } else {
                // dmd/typesem.d:5879 — `if (Dsymbol s = t.toDsymbol(sc))` (06 §2.6 hoist).
                const s = toDsymbol(t, sc);
                if (s !== null)
                    resolveHelper(mt, loc, sc, s, null, pe, pt, ps, intypeid);
                else {
                    let e = typeToExpressionHelper(mt, new TypeExp(loc, t));
                    e = expressionSemantic(e, sc);
                    resolveExp(e, pt, pe, ps);
                }
                if (pt.value !== null)
                    pt.value = addMod(pt.value, mt.mod);
            }
            mt.inuse--;
        } catch (ex) {
            // WALL PROTECTION (11 §2.5), not in D: D reaches `mt.inuse--` on EVERY exit — the
            // `Lerr:` tail (typesem.d:5795) or the fall-out at :5891. The walls inside this region
            // are exits D does not have, and a leaked `mt.inuse` makes the NEXT resolve of this
            // same TypeTypeof node emit a spurious "circular typeof definition" diagnostic.
            mt.inuse--;
            throw ex;
        }
    };

    // dmd/typesem.d:5894
    const visitReturn = (mt: TypeReturn): void => {
        //printf("TypeReturn::resolve(sc = %p, idents = '%s')\n", sc, mt.toChars());
        let t: Type | null;
        {
            let func: FuncDeclaration | null = sc!.func;
            if (func === null) {
                error(loc, ds("`typeof(return)` must be inside function"));
                return returnError();
            }
            if (func.fes !== null)
                func = func.fes.func;
            t = nextOf(func!.type!);
            if (t === null) {
                error(loc, ds("cannot use `typeof(return)` inside function `%s` with inferred return type"),
                    sc!.func!.toChars());
                return returnError();
            }
        }
        if (mt.idents.length === 0) {
            return returnType(addMod(t, mt.mod));
        } else {
            // dmd/typesem.d:5915 — `if (Dsymbol s = t.toDsymbol(sc))` (06 §2.6 hoist).
            const s = toDsymbol(t, sc);
            if (s !== null)
                resolveHelper(mt, loc, sc!, s, null, pe, pt, ps, intypeid);
            else {
                let e = typeToExpressionHelper(mt, new TypeExp(loc, t));
                e = expressionSemantic(e, sc!);
                resolveExp(e, pt, pe, ps);
            }
            if (pt.value !== null)
                pt.value = addMod(pt.value, mt.mod);
        }
    };

    // dmd/typesem.d:5933
    const visitSlice = (mt: TypeSlice): void => {
        resolve(mt.next!, loc, sc, pe, pt, ps, intypeid);
        if (pe.value !== null) {
            // It's really a slice expression
            // dmd/typesem.d:5939 — `if (Dsymbol s = getDsymbol(pe))` (06 §2.6 hoist).
            const s = getDsymbol(pe.value);
            if (s !== null)
                pe.value = new DsymbolExp(loc, s);
            return returnExp(new ArrayExp(loc, pe.value, new IntervalExp(loc, mt.lwr, mt.upr)));
        } else if (ps.value !== null) {
            const s: Dsymbol = ps.value;
            const td = s.isTupleDeclaration();
            if (td !== null) {
                /* It's a slice of a TupleDeclaration
                 */
                const sym: ScopeDsymbol = ArrayScopeSymbol.fromTupleDeclaration(sc!, td);
                sym.parent = sc!.scopesym;
                sc = sc!.push(sym);
                sc = sc.startCTFE();
                mt.lwr = expressionSemantic(mt.lwr!, sc);
                mt.upr = expressionSemantic(mt.upr!, sc);
                sc = sc.endCTFE();
                sc = sc!.pop();

                mt.lwr = ctfeInterpret(mt.lwr);    // dmd/typesem.d:5960
                mt.upr = ctfeInterpret(mt.upr);    // dmd/typesem.d:5961
                const i1: bigint = toUInteger(mt.lwr);       // dmd/typesem.d:5962
                const i2: bigint = toUInteger(mt.upr);       // dmd/typesem.d:5963
                if (!(i1 <= i2 && i2 <= BigInt(td.objects!.length))) {
                    error(loc, ds("slice `[%llu..%llu]` is out of range of [0..%llu]"),
                        i1, i2, BigInt(td.objects!.length));
                    return returnError();
                }

                if (i1 === 0n && i2 === BigInt(td.objects!.length)) {
                    return returnSymbol(td);
                }

                /* Create a new TupleDeclaration which
                 * is a slice [i1..i2] out of the old one.
                 */
                // `cast(size_t)(i2 - i1)` / `cast(size_t)i1 + i` — bigint -> index domain (09 §1.1)
                const objects: Objects = new DArray<RootObject | null>(Number(i2 - i1));
                for (let i = 0; i < objects.length; i++) {
                    objects.opIndexAssign(td.objects!.opIndex(Number(i1) + i), i);
                }

                return returnSymbol(new TupleDeclaration(loc, td.ident!, objects));
            } else
                visitType(mt);
        } else {
            if (pt.value!.ty !== TY.Terror)
                mt.next = pt.value; // prevent re-running semantic() on 'next'
            visitType(mt);
        }
    };

    // dmd/typesem.d:5997
    const visitMixin = (mt: TypeMixin): void => {
        let o: RootObject | null = mt.obj;
        // if already resolved just set pe/pt/ps and return.
        if (o !== null) {
            // D `o.isExpression()/isType()/isDsymbol()` — UFCS onto the free functions of
            // dtemplate.d:78/86/94, NOT RootObject methods.
            pe.value = isExpression(o);
            pt.value = isType(o);
            ps.value = isDsymbol(o);
            return;
        }

        o = compileTypeMixin(mt, loc, sc!);
        // dmd/typesem.d:6010 — `if (auto t = o.isType())` (06 §2.6 hoist).
        const t = isType(o);
        if (t !== null) {
            resolve(t, loc, sc, pe, pt, ps, intypeid);
            if (pt.value !== null)
                pt.value = addMod(pt.value, mt.mod);
        } else {
            const e0 = isExpression(o);
            if (e0 !== null) {
                const e = expressionSemantic(e0, sc!);
                const et = e.isTypeExp();
                if (et !== null)
                    returnType(addMod(et.type!, mt.mod));
                else
                    returnExp(e);
            } else
                returnError();
        }

        // save the result
        mt.obj = pe.value !== null ? pe.value : (pt.value !== null ? pt.value : ps.value);
    };

    // dmd/typesem.d:6032
    const visitTraits = (mt: TypeTraits): void => {
        // if already resolved just return the cached object.
        if (mt.obj !== null) {
            pt.value = isType(mt.obj);
            ps.value = isDsymbol(mt.obj);
            pe.value = isExpression(mt.obj);
            return;
        }

        // dmd/typesem.d:6043 — function-local `import dmd.traits : semanticTraits;` hoisted to the
        // module imports (01 Rule 4.4). swept: `semanticTraits` is live in traits.ts, AUTHORISED by
        // `Expression semanticTraits(TraitsExp e, Scope* sc)` (dmd/traits.d:322).
        // dmd/typesem.d:6045 — `if (Expression e = semanticTraits(mt.exp, sc))` (06 §2.6 hoist).
        const e: Expression | null = semanticTraits(mt.exp!, sc!);
        if (e !== null) {
            switch (e.op) {
                case EXP.dotVariable:
                    mt.obj = e.isDotVarExp()!.var_;
                    break;
                case EXP.variable:
                    mt.obj = e.isVarExp()!.var_;
                    break;
                case EXP.function_: {
                    const fe = e.isFuncExp()!;
                    mt.obj = fe.td !== null ? fe.td : fe.fd;
                    break;
                }
                case EXP.dotTemplateDeclaration:
                    mt.obj = e.isDotTemplateExp()!.td;
                    break;
                case EXP.dSymbol:
                    mt.obj = e.isDsymbolExp()!.s;
                    break;
                case EXP.template_:
                    mt.obj = e.isTemplateExp()!.td;
                    break;
                case EXP.scope_:
                    mt.obj = e.isScopeExp()!.sds;
                    break;
                case EXP.tuple: {
                    const te = e.isTupleExp()!;
                    const elems: Objects = new DArray<RootObject | null>(te.exps!.length);
                    const nelems = elems.length; // D `foreach (i; 0 .. elems.length)` — bound captured once
                    for (let i = 0; i < nelems; i++) {
                        const srcE = te.exps!.opIndex(i)!;
                        switch (srcE.op) {
                            case EXP.type:
                                elems.opIndexAssign(srcE.isTypeExp()!.type, i);
                                break;
                            case EXP.dotType:
                                elems.opIndexAssign(isType(srcE.isDotTypeExp()!.sym), i);
                                break;
                            case EXP.overloadSet:
                                elems.opIndexAssign(srcE.isOverExp()!.type, i);
                                break;
                            default: {
                                const sym = isDsymbol(srcE);
                                if (sym !== null)
                                    elems.opIndexAssign(sym, i);
                                else
                                    elems.opIndexAssign(srcE, i);
                            }
                        }
                    }
                    const td = new TupleDeclaration(e.loc, Identifier.generateId(ds("__aliastup")), elems);
                    mt.obj = td;
                    break;
                }
                case EXP.dotType:
                    mt.obj = isType(e.isDotTypeExp()!.sym);
                    break;
                case EXP.type:
                    mt.obj = e.isTypeExp()!.type;
                    break;
                case EXP.overloadSet:
                    mt.obj = e.isOverExp()!.type;
                    break;
                case EXP.error:
                    break;
                default:
                    mt.obj = e;
                    break;
            }
        }

        if (mt.obj !== null) {
            // dmd/typesem.d:6113 — `if (auto t = mt.obj.isType())` (06 §2.6 hoist, chained).
            const t = isType(mt.obj);
            if (t !== null) {
                const t2 = addMod(t, mt.mod);
                mt.obj = t2;
                returnType(t2);
            } else {
                const s = isDsymbol(mt.obj);
                if (s !== null)
                    returnSymbol(s);
                else {
                    const ex = isExpression(mt.obj);
                    if (ex !== null)
                        returnExp(ex);
                }
            }
        } else {
            assert(global.errors !== 0);
            mt.obj = Type.terror;
            return returnError();
        }
    };

    // dmd/typesem.d:6136 — S7, emitted IN FULL. STATEMENT form (each arm `visitX(...); break;`),
    // not a `return` dispatch — keep it that way.
    switch (mt.ty) {
        default:            visitType      (mt);                     break;
        case TY.Tsarray:    visitSArray    (mt.isTypeSArray()!);     break;
        case TY.Tarray:     visitDArray    (mt.isTypeDArray()!);     break;
        case TY.Taarray:    visitAArray    (mt.isTypeAArray()!);     break;
        case TY.Tident:     visitIdentifier(mt.isTypeIdentifier()!); break;
        case TY.Tinstance:  visitInstance  (mt.isTypeInstance()!);   break;
        case TY.Ttypeof:    visitTypeof    (mt.isTypeTypeof()!);     break;
        case TY.Treturn:    visitReturn    (mt.isTypeReturn()!);     break;
        case TY.Tslice:     visitSlice     (mt.isTypeSlice()!);      break;
        case TY.Tmixin:     visitMixin     (mt.isTypeMixin()!);      break;
        case TY.Ttraits:    visitTraits    (mt.isTypeTraits()!);     break;
    }
}

// ══════════════════════════════════════════════════════════════════════════
// CHUNK 3 — dmd/typesem.d lines 6152-9685 (dotExp … compileTypeMixin).
// Idiom B throughout (preamble §5): every dispatch is a trailing `switch` emitted IN FULL.
// ══════════════════════════════════════════════════════════════════════════

// dmd/typesem.d:6604 — `__gshared int nest;` declared inside `dotExp.noMember`, but with
// `__gshared` (process-wide) lifetime, so it is module state here (preamble §M5). It is a
// recursion guard: `++nest` on entry to `noMember`, `--nest` in the `returnExp` tail that EVERY
// D exit of `noMember` goes through. 11 §2.5 (paired state): the port's walls add exit paths D
// does not have, so `noMember` wraps its body in a `try/catch` that undoes the increment before
// rethrowing — otherwise one wall throw poisons the counter for the rest of the process.
let nest = 0;

/************************
 * Access the members of the object e. This type is same as e.type.
 * Params:
 *  mt = type for which the dot expression is used
 *  sc = instantiating scope
 *  e = expression to convert
 *  ident = identifier being used
 *  flag = DotExpFlag bit flags
 *
 * Returns:
 *  resulting expression with e.ident resolved
 *
 * `e` is `Expression | null` (02 §10.1 — the body decides): the `Lreturn:` tail null-tests it
 * (`if (e) e = e.expressionSemantic(sc);`, dmd/typesem.d:6244) and several arms assign the
 * nullable result of `getProperty`/`noMember` into it. The entry `e.lastComma()` dereferences
 * with no test, so the `!` there marks the same fault point D has.
 */
export function dotExp(mt: Type, sc: Scope, e: Expression | null, ident: Identifier,
                       flag: DotExpFlag): Expression | null {
    // resolved: `enum LOGDOTEXP = false;` (dmd/typesem.d:6166) folds the RUNTIME
    // `if (LOGDOTEXP) printf("dotExp()\n");` (:6167) to false — statement dropped (07 §9).
    // Every `static if (LOGDOTEXP)` below reads the module-level mtype.d:41 `LOGDOTEXP == 0`
    // and is likewise dropped (07 §3, preamble §M2).

    const visitType = (mt: Type): Expression | null => {
        // SKIP-FLAG (06 §4 / §4.1) for `goto Lreturn;` at dmd/typesem.d:6229. It is a LOCAL of this
        // function: the jump lives entirely inside one `visitType` call, so the flag must not
        // survive across calls (visitArray/visitDelegate/... re-enter `visitType` freely).
        let gotoLreturn = false;
        let v: VarDeclaration | null = null;
        // resolved: static if (LOGDOTEXP == 0) -> false, printf block dropped (dmd/typesem.d:6172)
        const ex = lastComma(e!);
        if (ex.op === EXP.dotVariable) {
            // D: `DotVarExp dv = cast(DotVarExp)ex;` — the `ex.op` test above is the tag proof;
            // rendered through the accessor the port already offers (02 §11.5c shape 3).
            const dv = ex.isDotVarExp()!;
            v = dv.var_.isVarDeclaration();
        } else if (ex.op === EXP.variable) {
            const ve = ex.isVarExp()!;    // D: `cast(VarExp)ex`
            v = ve.var_.isVarDeclaration();
        }
        // dmd/typesem.d:6187 — `if (v)`: nullable reference truthiness (06 §2.7).
        if (v !== null) {
            if (ident === Id.offsetof ||
                ident === Id.bitoffsetof ||
                ident === Id.bitwidth) {
                dsymbolSemantic(v, null);
                if (v.isField()) {
                    const ad = v.isMember();
                    objc()!.checkOffsetof(e!, ad!); // dmd/typesem.d:6198
                    sizeDsymbol(ad!, e!.loc);
                    if (ad!.sizeok !== Sizeok.done)
                        return ErrorExp.get();
                    let value = 0;      // D `uint value;` — number domain (09 §1)
                    if (ident === Id.offsetof)
                        value = v.offset;
                    else // Id.bitoffsetof || Id.bitwidth
                    {
                        const bf = v.isBitFieldDeclaration();
                        if (bf !== null) {
                            value = ident === Id.bitoffsetof ? bf.bitOffset : bf.fieldWidth;
                        } else
                            error(v.loc, ds("`%s` is not a bitfield, cannot apply `%s`"), v.toChars(), ident.toChars());
                    }
                    return new IntegerExp(e!.loc, BigInt(value), Type.tsize_t);
                }
            } else if (ident === Id._init) {
                const tb = toBasetype(mt);
                e = defaultInitLiteral(mt, e!.loc);
                if (tb.ty === TY.Tstruct && needsNested(tb)) {
                    e!.isStructLiteralExp()!.useStaticInit = true;
                }
                gotoLreturn = true;     // goto Lreturn (dmd/typesem.d:6229)
            }
        }
        // The jump skips the stringof/getProperty selection below and lands on the shared
        // `Lreturn:` tail (:6243), which every other path reaches by fall-through.
        if (!gotoLreturn) {
            if (ident === Id.stringof) {
                /* https://issues.dlang.org/show_bug.cgi?id=3796
                 * this should demangle e.type.deco rather than
                 * pretty-printing the type.
                 */
                e = new StringExp(e!.loc, [...e!.toString()]);
            } else
                e = getProperty(mt, sc, e!.loc, ident, flag & DotExpFlag.gag);
        }

        // Lreturn: (dmd/typesem.d:6243)
        if (e !== null)
            e = expressionSemantic(e, sc);
        return e;
    };

    const visitError = (_t: TypeError): Expression | null => {
        return ErrorExp.get();
    };

    const visitBasic = (mt: TypeBasic): Expression | null => {
        // resolved: static if (LOGDOTEXP == 0) -> false, printf block dropped (dmd/typesem.d:6256)
        let t: Type | null = null;
        if (ident === Id.re) {
            // SHARED-ARM (06 §4): `L1:` (dmd/typesem.d:6276) is the shared tail of the three
            // Tcomplex arms; `t` is CAPTURED, never passed (06 §4 "tails capture locals").
            const L1 = (): void => {
                e = castTo(e!, sc, t!);
            };
            // SHARED-ARM `L2:` (dmd/typesem.d:6296) — the shared tail of the three Timaginary arms
            // of this SAME switch; captures the same `t`.
            const L2 = (): void => {
                e = new RealExp(e!.loc, CTFloat.zero, t!);
            };
            switch (mt.ty) {
            case TY.Tcomplex32:
                t = Type.tfloat32;
                L1();       // goto L1 (dmd/typesem.d:6267)
                break;

            case TY.Tcomplex64:
                t = Type.tfloat64;
                L1();       // goto L1 (dmd/typesem.d:6271)
                break;

            case TY.Tcomplex80:
                t = Type.tfloat80;
                L1();       // goto L1 (dmd/typesem.d:6275)
                break;

            case TY.Tfloat32:
            case TY.Tfloat64:
            case TY.Tfloat80:
                break;

            case TY.Timaginary32:
                t = Type.tfloat32;
                L2();       // goto L2 (dmd/typesem.d:6287)
                break;

            case TY.Timaginary64:
                t = Type.tfloat64;
                L2();       // goto L2 (dmd/typesem.d:6291)
                break;

            case TY.Timaginary80:
                t = Type.tfloat80;
                L2();       // goto L2 (dmd/typesem.d:6295)
                break;

            default:
                // D: `mt.Type.getProperty(...)` — the base-class-qualified spelling only picks the
                // free function `getProperty` (dmd/typesem.d:5030); its dispatch is a runtime
                // switch on `t.ty`, so the upcast has no effect on which arm runs.
                e = getProperty(mt, sc, e!.loc, ident, flag);
                break;
            }
        } else if (ident === Id.im) {
            let t2: Type | null = null;
            // SHARED-ARM tails `L3:` (:6324) and `L4:` (:6340); `t`/`t2` captured.
            const L3 = (): void => {
                e = castTo(e!, sc, t!);
                e.type = t2;
            };
            const L4 = (): void => {
                e = e!.copy();
                e.type = t;
            };
            switch (mt.ty) {
            case TY.Tcomplex32:
                t = Type.timaginary32;
                t2 = Type.tfloat32;
                L3();       // goto L3 (dmd/typesem.d:6313)
                break;

            case TY.Tcomplex64:
                t = Type.timaginary64;
                t2 = Type.tfloat64;
                L3();       // goto L3 (dmd/typesem.d:6318)
                break;

            case TY.Tcomplex80:
                t = Type.timaginary80;
                t2 = Type.tfloat80;
                L3();       // goto L3 (dmd/typesem.d:6323)
                break;

            case TY.Timaginary32:
                t = Type.tfloat32;
                L4();       // goto L4 (dmd/typesem.d:6331)
                break;

            case TY.Timaginary64:
                t = Type.tfloat64;
                L4();       // goto L4 (dmd/typesem.d:6335)
                break;

            case TY.Timaginary80:
                t = Type.tfloat80;
                L4();       // goto L4 (dmd/typesem.d:6339)
                break;

            case TY.Tfloat32:
            case TY.Tfloat64:
            case TY.Tfloat80:
                e = new RealExp(e!.loc, CTFloat.zero, mt);
                break;

            default:
                e = getProperty(mt, sc, e!.loc, ident, flag);
                break;
            }
        } else {
            return visitType(mt);
        }
        // dmd/typesem.d:6360 — `if (!(flag & 1) || e)`. `flag` is a DotExpFlag bit set (number
        // domain): the mask test is made explicit (06 §2.5), the `e` test is a nullable-reference
        // test (06 §2.7).
        if ((flag & 1) === 0 || e !== null)
            e = expressionSemantic(e!, sc);
        return e;
    };

    const visitVector = (mt: TypeVector): Expression | null => {
        // resolved: static if (LOGDOTEXP == 0) -> false, printf block dropped (dmd/typesem.d:6367)
        if (ident === Id.ptr && e!.op === EXP.call) {
            /* The trouble with EXP.call is the return ABI for float[4] is different from
             * __vector(float[4]), and a type paint won't do.
             */
            e = new AddrExp(e!.loc, e);
            e = expressionSemantic(e, sc);
            return castTo(e, sc, pointerTo(nextOf(mt.basetype)!));
        }
        if (ident === Id.array) {
            //e = e.castTo(sc, basetype);
            // Keep lvalue-ness
            e = new VectorArrayExp(e!.loc, e);
            e = expressionSemantic(e, sc);
            return e;
        }
        if (ident === Id._init || ident === Id.offsetof || ident === Id.stringof || ident === Id.__xalignof) {
            // init should return a new VectorExp
            // https://issues.dlang.org/show_bug.cgi?id=12776
            // offsetof does not work on a cast expression, so use e directly
            // stringof should not add a cast to the output
            return visitType(mt);
        }

        // Properties based on the vector element type and are values of the element type
        if (ident === Id.max || ident === Id.min || ident === Id.min_normal ||
            ident === Id.nan || ident === Id.infinity || ident === Id.epsilon) {
            const vet = mt.basetype.isTypeSArray()!.next; // vector element type
            const ev = getProperty(vet!, sc, e!.loc, ident, DotExpFlag.gag);
            if (ev !== null)
                return castTo(ev, sc, mt); // 'broadcast' ev to the vector elements
        }

        return dotExp(mt.basetype, sc, castTo(e!, sc, mt.basetype), ident, flag);
    };

    const visitArray = (mt: TypeArray): Expression | null => {
        // resolved: static if (LOGDOTEXP == 0) -> false, printf block dropped (dmd/typesem.d:6411)
        e = visitType(mt);

        if ((flag & 1) === 0 || e !== null)
            e = expressionSemantic(e!, sc);
        return e;
    };

    const visitSArray = (mt: TypeSArray): Expression | null => {
        // resolved: static if (LOGDOTEXP == 0) -> false, printf block dropped (dmd/typesem.d:6425)
        if (ident === Id.length) {
            const oldLoc = e!.loc;   // `Loc` is an alias-safe register member (03 §9.1) — share
            e = mt.dim!.copy();
            e.loc = oldLoc;
        } else if (ident === Id.ptr) {
            if (e!.op === EXP.type) {
                error(e!.loc, ds("`%s` is not an expression"), toErrMsg(e!));
                return ErrorExp.get();
            } else if (toUInteger(mt.dim!) < 1n && checkUnsafeDotExp(sc, e!, ident, flag)) {
                // .ptr on static array is @safe unless size is 0
                // https://issues.dlang.org/show_bug.cgi?id=20853
                return ErrorExp.get();
            }
            e = castTo(e!, sc, pointerTo(nextOf(e!.type!)!));
        } else if (ident === Id._tupleof) {
            if (e!.isTypeExp() !== null) {
                error(e!.loc, ds("`.tupleof` cannot be used on type `%s`"), mt.toChars());
                return ErrorExp.get();
            } else {
                const e0: Ref<Expression | null> = { value: null };  // D `Expression e0;` + `ref` out-slot
                let ev: Expression | null = e;
                // swept (11 §2.5): `extractSideEffect` (dmd/sideeffect.d:435) is live and exported
                // at sideeffect.ts:598 as `(sc: Scope, name: DString, e0: { value: Expression | null },
                // e: Expression, alwaysCopy?, stc?) => Expression` — D's `ref Expression e0` is the
                // one-slot box (03 §3.3), which is exactly the `Ref` cell declared above.
                ev = extractSideEffect(sc, ds("__tup"), e0, ev!); // typesem.d:6461

                // D `cast(size_t)mt.dim.toUInteger()` — size_t is the index domain (number, 09 §1.1);
                // the narrowing is D's own cast, and a static-array length that does not fit a
                // size_t is already rejected upstream.
                const length = Number(toUInteger(mt.dim!));
                const exps: Expressions = new DArray<Expression | null>();
                exps.reserve(length);
                for (let i = 0; i < length; i++)
                    exps.push(new IndexExp(e!.loc, ev, new IntegerExp(e!.loc, BigInt(i), Type.tsize_t)));
                e = new TupleExp(e!.loc, e0.value, exps);
            }
        } else {
            e = visitArray(mt);
        }
        if ((flag & 1) === 0 || e !== null)
            e = expressionSemantic(e!, sc);
        return e;
    };

    const visitDArray = (mt: TypeDArray): Expression | null => {
        // resolved: static if (LOGDOTEXP == 0) -> false, printf block dropped (dmd/typesem.d:6482)
        if (e!.op === EXP.type && (ident === Id.length || ident === Id.ptr)) {
            error(e!.loc, ds("`%s` is not an expression"), toErrMsg(e!));
            return ErrorExp.get();
        }
        if (ident === Id.length) {
            if (e!.op === EXP.string_) {
                const se = e!.isStringExp()!;   // D: `cast(StringExp)e`, proved by the `op` test
                return new IntegerExp(se.loc, BigInt(se.len), Type.tsize_t);
            }
            if (e!.op === EXP.null_) {
                return new IntegerExp(e!.loc, 0n, Type.tsize_t);
            }
            // swept: `checkNonAssignmentArrayOp` (dmd/arrayop.d:90) is live in arrayop.ts — the call
            // D authorises at dmd/typesem.d:6502 is written for real. The `suggestion` parameter
            // keeps its D default (`false`); D passes one argument here.
            if (checkNonAssignmentArrayOp(e!)) {
                return ErrorExp.get();
            }
            e = new ArrayLengthExp(e!.loc, e);
            e.type = Type.tsize_t;
            return e;
        } else if (ident === Id.ptr) {
            if (checkUnsafeDotExp(sc, e!, ident, flag))
                return ErrorExp.get();
            return castTo(e!, sc, pointerTo(mt.next!));
        } else {
            return visitArray(mt);
        }
    };

    const visitAArray = (mt: TypeAArray): Expression | null => {
        // resolved: static if (LOGDOTEXP == 0) -> false, printf block dropped (dmd/typesem.d:6524)
        if (ident === Id.length) {
            const loc = e!.loc;
            let hookFunc: Expression = new IdentifierExp(loc, Id.empty);
            hookFunc = new DotIdExp(loc, hookFunc, Id.object);
            const keytype = substWildTo(mt.index!, MODFlags.const_);
            const valtype = substWildTo(nextOf(mt)!, MODFlags.const_);
            const tiargs: Objects = DArray.from<RootObject | null>(keytype, valtype);
            // D's `(Loc, Expression, Identifier, Objects*)` ctor -> the port's named factory
            // `fromName` (04 §1.1(c)); it carries its own §2 escalation in expression.ts.
            hookFunc = DotTemplateInstanceExp.fromName(loc, hookFunc, Id._d_aaLen, tiargs);
            // D declares a LOCAL `Expression e` here (dmd/typesem.d:6535) that SHADOWS the captured
            // `dotExp` parameter; its initializer still reads the outer `e` (D locals are visible
            // only from their declaration on). TS forbids the same-name shadow in one scope, so the
            // local takes a distinct name — the outer `e` is untouched by this arm, exactly as in D.
            // D's `(Loc, Expression, Expression)` ctor -> the port's named factory (04 §1.1(c)).
            let eLocal: Expression = CallExp.fromArg(loc, hookFunc, e);
            eLocal = expressionSemantic(eLocal, sc);
            return eLocal;
        } else {
            return visitType(mt);
        }
    };

    const visitReference = (mt: TypeReference): Expression | null => {
        // resolved: static if (LOGDOTEXP == 0) -> false, printf block dropped (dmd/typesem.d:6549)
        // References just forward things along
        return dotExp(mt.next!, sc, e, ident, flag);
    };

    const visitDelegate = (mt: TypeDelegate): Expression | null => {
        // resolved: static if (LOGDOTEXP == 0) -> false, printf block dropped (dmd/typesem.d:6559)
        if (ident === Id.ptr) {
            e = new DelegatePtrExp(e!.loc, e);
            e = expressionSemantic(e, sc);
        } else if (ident === Id.funcptr) {
            if (checkUnsafeDotExp(sc, e!, ident, flag)) {
                return ErrorExp.get();
            }
            e = new DelegateFuncptrExp(e!.loc, e);
            e = expressionSemantic(e, sc);
        } else {
            return visitType(mt);
        }
        return e;
    };

    /***************************************
     * `ident` was not found as a member of `mt`.
     * Attempt to use overloaded opDispatch() or `alias this`.
     * If that fails, forward to visitType().
     * Params:
     *  mt = class or struct
     *  sc = context
     *  e = `this` for `ident`
     *  ident = name of member
     *  flag = flag & 1, don't report "not a property" error and just return NULL.
     *         flag & DotExpFlag.noAliasThis, don't do 'alias this' resolution.
     * Returns:
     *  resolved expression if found, otherwise null
     */
    const noMember = (mt: Type, sc: Scope, e: Expression | null, ident: Identifier,
                      flag: number): Expression | null => {
        //printf("Type.noMember(e: %s ident: %s flag: %d)\n", e.toChars(), ident.toChars(), flag);

        const gagError = (flag & 1) !== 0;

        // `nest` is module state (preamble §M5, declared at the top of this file).

        // dmd/typesem.d:6606 — `static Expression returnExp(Expression e) { --nest; return e; }`.
        const returnExp = (e: Expression | null): Expression | null => {
            --nest;
            return e;
        };

        ++nest;
        try {
            if (nest > global.recursionLimit) {
                error(e!.loc, ds("cannot resolve identifier `%s`"), ident.toChars());
                return returnExp(gagError ? null : ErrorExp.get());
            }

            assert(mt.ty === TY.Tstruct || mt.ty === TY.Tclass);
            const sym = toDsymbol(mt, sc)!.isAggregateDeclaration();
            assert(sym !== null);
            if (// https://issues.dlang.org/show_bug.cgi?id=22054
                // if a class or struct does not have a body
                // there is no point in searching for its members
                sym!.members !== null &&
                ident !== Id.__sizeof &&
                ident !== Id.__xalignof &&
                ident !== Id._init &&
                ident !== Id._mangleof &&
                ident !== Id.stringof &&
                ident !== Id.offsetof &&
                ident !== Id.bitoffsetof &&
                ident !== Id.bitwidth &&
                // https://issues.dlang.org/show_bug.cgi?id=15045
                // Don't forward special built-in member functions.
                ident !== Id.ctor &&
                ident !== Id.dtor &&
                ident !== Id.__xdtor &&
                ident !== Id.postblit &&
                ident !== Id.__xpostblit) {
                /* Look for overloaded opDispatch to see if we should forward request
                 * to it.
                 */
                const fd = search_function(sym, Id.opDispatch!);
                if (fd !== null) {
                    /* Rewrite e.ident as:
                     *  e.opDispatch!("ident")
                     */

                    const se = new StringExp(e!.loc, [...ident.toString()]);
                    const tiargs: Objects = DArray.from<RootObject | null>(se);
                    // D's `(Loc, Expression, Identifier, Objects*)` ctor -> the named factory.
                    const dti = DotTemplateInstanceExp.fromName(e!.loc, e, Id.opDispatch, tiargs);

                    const os = fd.isOverloadSet();
                    if (os !== null) {
                        // dmd/typesem.d:6657 — the `DotTemplateInstanceExp` overload (expressionsem.d:1360),
                        // not templatesem's `findTempDecl(TemplateInstance, …)`.
                        if (!findTempDecl(dti, sc)) {
                            error(fd.loc, ds("Couldn't find template declaration for opDispatch"));
                            return returnExp(ErrorExp.get());
                        }
                    } else {
                        const td = fd.isTemplateDeclaration();
                        if (td === null) {
                            error(fd.loc, ds("%s `%s` must be a template `opDispatch(string s)`, not a %s"),
                                   fd.kind(), fd.toPrettyChars(), fd.kind());
                            return returnExp(ErrorExp.get());
                        }
                        dti.ti!.tempdecl = td;
                    }

                    /* opDispatch, which doesn't need IFTI,  may occur instantiate error.
                     * e.g.
                     *  template opDispatch(name) if (isValid!name) { ... }
                     */
                    const errors = gagError ? global.startGagging() : 0;
                    // WALL PROTECTION (11 §2.5, capture-in-finally), not in D: a wall inside the
                    // callee would be an exit D does not have, between `startGagging` and
                    // `endGagging`; a leaked `global.gag` suppresses every later diagnostic in the
                    // process. (The enclosing `catch` repairs `nest` only.)
                    let gagged: boolean;
                    try {
                        // dmd/typesem.d:6680 — D passes `DotExpFlag.none` (== 0) into `bool gag`.
                        e = dotTemplateSemanticProp(dti, sc, false);
                    } finally {
                        gagged = gagError && global.endGagging(errors);
                    }
                    if (gagged)
                        e = null;
                    return returnExp(e);
                }

                /* See if we should forward to the alias this.
                 */
                const alias_e = (flag & DotExpFlag.noAliasThis) !== 0 ? null
                                                                      : resolveAliasThis(sc, e!, gagError);
                if (alias_e !== null && alias_e !== e) {
                    /* Rewrite e.ident as:
                     *  e.aliasthis.ident
                     */
                    const die = new DotIdExp(e!.loc, alias_e, ident);

                    const errors = gagError ? 0 : global.startGagging();
                    let exp: Expression | null;
                    try {
                        exp = dotIdSemanticProp(die, sc, gagError);
                    } catch (ex) {
                        // WALL PROTECTION (11 §2.5), not in D: `dotIdSemanticProp` still holds 5
                        // walls, and a throw between `startGagging` and `endGagging` would leak
                        // `global.gag` for the life of the process. (The enclosing `catch` repairs
                        // `nest` only.)
                        if (!gagError)
                            global.endGagging(errors);
                        throw ex;
                    }
                    if (!gagError) {
                        global.endGagging(errors);
                        if (exp !== null && exp.op === EXP.error)
                            exp = null;
                    }

                    if (exp !== null && gagError)
                        // now that we know that the alias this leads somewhere useful,
                        // go back and print deprecations/warnings that we skipped earlier due to the gag
                        resolveAliasThis(sc, e!, false);

                    return returnExp(exp);
                }
            }
            return returnExp(visitType(mt));
        } catch (ex) {
            // 11 §2.5 (paired state): every D exit runs `returnExp`'s `--nest`. A wall throw inside
            // this region is an exit D does not have, so undo the `++nest` before rethrowing.
            --nest;
            throw ex;
        }
    };

    const visitStruct = (mt: TypeStruct): Expression | null => {
        let s: Dsymbol | null;
        // resolved: static if (LOGDOTEXP == 0) -> false, printf block dropped (dmd/typesem.d:6720)
        assert(e!.op !== EXP.dot);

        // https://issues.dlang.org/show_bug.cgi?id=14010
        if (!sc.inCfile && ident === Id._mangleof) {
            return getProperty(mt, sc, e!.loc, ident, flag & 1);
        }

        /* If e.tupleof
         */
        if (ident === Id._tupleof) {
            /* Create a TupleExp out of the fields of the struct e:
             * (e.field0, e.field1, e.field2, ...)
             */
            e = expressionSemantic(e!, sc); // do this before turning on noAccessCheck

            if (!determineFields(mt.sym!)) {
                error(e.loc, ds("unable to determine fields of `%s` because of forward references"), mt.toChars());
            }

            const e0: Ref<Expression | null> = { value: null };
            let ev: Expression | null = e.op === EXP.type ? null : e;
            if (ev !== null) {
                // swept (11 §2.5): `extractSideEffect` (dmd/sideeffect.d:435) is live at
                // sideeffect.ts:598; the `ref Expression e0` out-slot is the `Ref` cell above.
                ev = extractSideEffect(sc, ds("__tup"), e0, ev); // typesem.d:6749
            }

            const exps: Expressions = new DArray<Expression | null>();
            exps.reserve(mt.sym!.fields.length);
            for (let i = 0; i < mt.sym!.fields.length; i++) {
                const v = mt.sym!.fields.opIndex(i)!;
                let ex: Expression;
                if (ev !== null)
                    ex = new DotVarExp(e.loc, ev, v);
                else {
                    ex = new VarExp(e.loc, v);
                    ex.type = addMod(ex.type!, e.type!.mod);
                }
                exps.push(ex);
            }

            e = new TupleExp(e.loc, e0.value, exps);
            const sc2 = sc.push();
            sc2.noAccessCheck = true;
            e = expressionSemantic(e, sc2);
            sc2.pop();
            return e;
        }

        const flags: SearchOptFlags = sc.ignoresymbolvisibility ? SearchOpt.ignoreVisibility : 0;
        s = search(mt.sym!, e!.loc, ident, flags | SearchOpt.ignorePrivateImports);

        // RETRY (06 §4): `L1:` (dmd/typesem.d:6777) is jumped BACK to from :6897 after the
        // template-instance alias resolution; the whole L1..end region becomes a labeled `for(;;)`
        // whose body always `return`s or `continue`s.
        L1: for (;;) {
            if (s === null) {
                return noMember(mt, sc, e, ident, flag);
            }
            if (!sc.ignoresymbolvisibility && !symbolIsVisible(sc, s)) {
                return noMember(mt, sc, e, ident, flag);
            }
            // check before alias resolution; the alias itself might be deprecated!
            {
                const ad = s.isAliasDeclaration();
                if (ad !== null) {
                    checkDeprecated(s, e!.loc, sc);

                    // Fix for https://github.com/dlang/dmd/issues/20610
                    if (ad.originalType !== null) {
                        const tid = ad.originalType.isTypeIdentifier();
                        if (tid !== null) {
                            if (tid.idents.length) {
                                // resolved: static if (0) -> false, the four printf lines
                                // (dmd/typesem.d:6798-6805) are dropped (07 §3).
                                /* Rewrite e.s as e.(tid.ident).(tid.idents)
                                 */
                                let die: Expression | null = new DotIdExp(e!.loc, e, tid.ident);
                                for (const id of tid.idents) // maybe use typeToExpressionHelper()
                                    // D's own UNCHECKED `cast(Identifier)id` over `tid.idents` — no
                                    // adjacent DYNCAST test
                                    // in D either (contrast mtype.ts:246, which has one). Outside the 02 §11.5c
                                    // whitelist; reported as a finding, NOT walled (D takes this path normally).
                                    die = new DotIdExp(e!.loc, die, id as unknown as Identifier);
                                /* Ambiguous syntax, only way to disambiguate it to try it
                                 */
                                // D: `dmd.expressionsem.trySemantic` — see isCopyConstructorCallable.
                                die = expressionsemTrySemantic(die, sc);
                                if (die !== null && die.isDotVarExp() !== null) {   // shrink wrap around DotVarExp()
                                    return die;
                                }
                            }
                        }
                    }
                }
            }
            s = toAlias(s);

            {
                const em = s.isEnumMember();
                if (em !== null) {
                    return getVarExp(em, e!.loc, sc);
                }
            }
            {
                const v = s.isVarDeclaration();
                if (v !== null) {
                    checkDeprecated(v, e!.loc, sc);
                    checkDisabled(v, e!.loc, sc);
                    if (v.type === null ||
                        (v.type.deco === null && v.inuse)) {
                        if (v.inuse) // https://issues.dlang.org/show_bug.cgi?id=9494
                            error(e!.loc, ds("circular reference to %s `%s`"), v.kind(), v.toPrettyChars());
                        else
                            error(e!.loc, ds("forward reference to %s `%s`"), v.kind(), v.toPrettyChars());
                        return ErrorExp.get();
                    }
                    if (v.type.ty === TY.Terror) {
                        return ErrorExp.get();
                    }

                    if ((v.storage_class & STC.manifest) !== 0n && v._init !== null) {
                        if (v.inuse) {
                            error(e!.loc, ds("circular initialization of %s `%s`"), v.kind(), v.toPrettyChars());
                            return ErrorExp.get();
                        }
                        checkAccess(e!.loc, sc, null, v);
                        let ve: Expression = new VarExp(e!.loc, v);
                        // swept (11 §2.5): `isTrivialExp` (dmd/sideeffect.d:38) is live and exported
                        // at sideeffect.ts:118 as `(e: Expression) => boolean`.
                        if (!isTrivialExp(e!)) { // typesem.d:6855
                            ve = new CommaExp(e!.loc, e, ve);
                        }
                        return expressionSemantic(ve, sc);
                    }
                }
            }

            {
                const t = getType(s);
                if (t !== null) {
                    return expressionSemantic(new TypeExp(e!.loc, t), sc);
                }
            }

            const tm = s.isTemplateMixin();
            if (tm !== null) {
                const se = new ScopeExp(e!.loc, tm);
                return expressionSemantic(new DotExp(e!.loc, e, se), sc);
            }

            const td = s.isTemplateDeclaration();
            if (td !== null) {
                if (e!.op === EXP.type)
                    e = new TemplateExp(e!.loc, td);
                else
                    e = new DotTemplateExp(e!.loc, e, td);
                return expressionSemantic(e, sc);
            }

            const ti = s.isTemplateInstance();
            if (ti !== null) {
                if (ti.semanticRun === PASS.initial) {  // D: `if (!ti.semanticRun)` — PASS.initial == 0 (09 §9)
                    dsymbolSemantic(ti, sc);
                    if (ti.inst === null || ti.errors) { // if template failed to expand
                        return ErrorExp.get();
                    }
                }
                s = toAlias(ti.inst!);
                if (s.isTemplateInstance() === null)
                    continue L1;    // goto L1 (dmd/typesem.d:6897)
                if (e!.op === EXP.type)
                    e = new ScopeExp(e!.loc, ti);
                else
                    e = new DotExp(e!.loc, e, new ScopeExp(e!.loc, ti));
                return expressionSemantic(e, sc);
            }

            if (s.isImport() !== null || s.isModule() !== null || s.isPackage() !== null) {
                return symbolToExp(s, e!.loc, sc, false);
            }

            const o = s.isOverloadSet();
            if (o !== null) {
                const oe = new OverExp(e!.loc, o);
                if (e!.op === EXP.type) {
                    return oe;
                }
                return new DotExp(e!.loc, e, oe);
            }

            let d = s.isDeclaration();
            if (d === null) {
                error(e!.loc, ds("`%s.%s` is not a declaration"), toErrMsg(e!), ident.toChars());
                return ErrorExp.get();
            }

            if (e!.op === EXP.type) {
                /* It's:
                 *    Struct.d
                 */
                const tup = d.isTupleDeclaration();
                if (tup !== null) {
                    e = TupleExp.fromTupleDeclaration(e!.loc, tup);
                    fillTupleExpExps(e.isTupleExp()!, tup);          // dmd/typesem.d:6936
                    return expressionSemantic(e, sc);
                }
                if (d.needThis() && sc.intypeof !== 1) {
                    /* Rewrite as:
                     *  this.d
                     *
                     * only if the scope in which we are
                     * has a `this` that matches the type
                     * of the lhs of the dot expression.
                     *
                     * https://issues.dlang.org/show_bug.cgi?id=23617
                     */
                    const fd = hasThis(sc);                           // dmd/typesem.d:6950
                    if (fd !== null && fd.isThis() === mt.sym) {
                        e = new DotVarExp(e!.loc, new ThisExp(e!.loc), d);
                        return expressionSemantic(e, sc);
                    }
                }
                if (d.semanticRun === PASS.initial)
                    dsymbolSemantic(d, null);
                checkAccess(e!.loc, sc, e, d);
                const ve = new VarExp(e!.loc, d);
                if (d.isVarDeclaration() !== null && d.needThis())
                    ve.type = addMod(d.type!, e!.type!.mod);
                return ve;
            }

            const unreal = e!.op === EXP.variable && e!.isVarExp()!.var_.isField();
            if (d.isDataseg() || (unreal && d.isField())) {
                // (e, d)
                checkAccess(e!.loc, sc, e, d);
                const ve: Expression = new VarExp(e!.loc, d);
                e = unreal ? ve : new CommaExp(e!.loc, e, ve);
                return expressionSemantic(e, sc);
            }

            e = new DotVarExp(e!.loc, e, d);
            return expressionSemantic(e, sc);
        }
    };

    const visitEnum = (mt: TypeEnum): Expression | null => {
        // resolved: static if (LOGDOTEXP == 0) -> false, printf block dropped (dmd/typesem.d:6982)
        // https://issues.dlang.org/show_bug.cgi?id=14010
        if (ident === Id._mangleof) {
            return getProperty(mt, sc, e!.loc, ident, flag & 1);
        }

        if (mt.sym!.semanticRun < PASS.semanticdone)
            dsymbolSemantic(mt.sym!, null);

        const s = search(mt.sym!, e!.loc, ident);
        if (s === null) {
            if (ident === Id._init) {
                return getProperty(mt, sc, e!.loc, ident, flag & 1);
            }

            /* Allow special enums to not need a member list
             */
            if ((ident === Id.max || ident === Id.min) && (mt.sym!.members !== null || !mt.sym!.isSpecial())) {
                return getProperty(mt, sc, e!.loc, ident, flag & 1);
            }

            const res = dotExp(getMemtype(mt.sym!, Loc.initial), sc, e, ident, DotExpFlag.gag);
            if ((flag & 1) === 0 && res === null) {
                const ns = search_correct(mt.sym!, ident);
                if (ns !== null)
                    error(e!.loc, ds("no property `%s` for type `%s`. Did you mean `%s.%s` ?"),
                        ident.toChars(), mt.toChars(), mt.toChars(), ns.toChars());
                else
                    error(e!.loc, ds("no property `%s` for type `%s`"), ident.toChars(),
                        mt.toChars());

                errorSupplemental(mt.sym!.loc, ds("%s `%s` defined here"),
                    mt.sym!.kind(), mt.toChars());
                return ErrorExp.get();
            }
            return res;
        }
        const m = s.isEnumMember();
        return getVarExp(m!, e!.loc, sc);   // D dereferences `m` unchecked (typesem.d:7027)
    };

    const visitClass = (mt: TypeClass): Expression | null => {
        let s: Dsymbol | null;
        // resolved: static if (LOGDOTEXP == 0) -> false, printf block dropped (dmd/typesem.d:7033)
        assert(e!.op !== EXP.dot);

        // https://issues.dlang.org/show_bug.cgi?id=12543
        if (ident === Id.__sizeof || ident === Id.__xalignof || ident === Id._mangleof) {
            return getProperty(mt, sc, e!.loc, ident, 0);
        }

        /* If e.tupleof
         */
        if (ident === Id._tupleof) {
            objc()!.checkTupleof(e!, mt); // dmd/typesem.d:7049

            /* Create a TupleExp
             */
            e = expressionSemantic(e!, sc); // do this before turning on noAccessCheck

            sizeDsymbol(mt.sym!, e.loc); // do semantic of type

            const e0: Ref<Expression | null> = { value: null };
            let ev: Expression | null = e.op === EXP.type ? null : e;
            if (ev !== null) {
                // swept (11 §2.5): `extractSideEffect` (dmd/sideeffect.d:435) is live at
                // sideeffect.ts:598; the `ref Expression e0` out-slot is the `Ref` cell above.
                ev = extractSideEffect(sc, ds("__tup"), e0, ev); // typesem.d:7063
            }

            const exps: Expressions = new DArray<Expression | null>();
            exps.reserve(mt.sym!.fields.length);
            for (let i = 0; i < mt.sym!.fields.length; i++) {
                const v = mt.sym!.fields.opIndex(i)!;
                // Don't include hidden 'this' pointer
                if (v.isThisDeclaration() !== null)
                    continue;
                let ex: Expression;
                if (ev !== null)
                    ex = new DotVarExp(e.loc, ev, v);
                else {
                    ex = new VarExp(e.loc, v);
                    ex.type = addMod(ex.type!, e.type!.mod);
                }
                exps.push(ex);
            }

            e = new TupleExp(e.loc, e0.value, exps);
            const sc2 = sc.push();
            sc2.noAccessCheck = true;
            e = expressionSemantic(e, sc2);
            sc2.pop();
            return e;
        }

        const flags: SearchOptFlags = sc.ignoresymbolvisibility ? SearchOpt.ignoreVisibility : SearchOpt.all;
        s = search(mt.sym!, e!.loc, ident, flags | SearchOpt.ignorePrivateImports);

        // RETRY (06 §4): `L1:` (dmd/typesem.d:7095) is jumped BACK to from :7333.
        L1: for (;;) {
            if (s === null) {
                // See if it's a 'this' class or a base class
                if (mt.sym!.ident === ident) {
                    if (e!.op === EXP.type) {
                        return getProperty(mt, sc, e!.loc, ident, 0);
                    }
                    e = new DotTypeExp(e!.loc, e, mt.sym);
                    e = expressionSemantic(e, sc);
                    return e;
                }
                const cbase = mt.sym!.searchBase(ident);
                if (cbase !== null) {
                    if (e!.op === EXP.type) {
                        return getProperty(mt, sc, e!.loc, ident, 0);
                    }
                    const ifbase = cbase.isInterfaceDeclaration();
                    if (ifbase !== null)
                        e = new CastExp(e!.loc, e, ifbase.type);
                    else
                        e = new DotTypeExp(e!.loc, e, cbase);
                    e = expressionSemantic(e, sc);
                    return e;
                }

                if (ident === Id.classinfo) {
                    // 02 §11.4 probe: `Type.typeinfoclass` is declared non-null but unset until
                    // `_init` runs; D tests `if (!Type.typeinfoclass)`.
                    if (!(Type as { typeinfoclass?: unknown }).typeinfoclass) {
                        error(e!.loc, ds("`object.TypeInfo_Class` could not be found, but is implicitly used"));
                        return ErrorExp.get();
                    }

                    const t = Type.typeinfoclass.type!;
                    if (e!.op === EXP.type || e!.op === EXP.dotType) {
                        /* For type.classinfo, we know the classinfo
                         * at compile time.
                         */
                        if (mt.sym!.vclassinfo === null)
                            mt.sym!.vclassinfo = new TypeInfoClassDeclaration(mt.sym!.type!);
                        e = new VarExp(e!.loc, mt.sym!.vclassinfo);
                        e = addressOf(e);                             // dmd/typesem.d:7140
                        e.type = t; // do this so we don't get redundant dereference
                    } else {
                        /* For class objects, the classinfo reference is the first
                         * entry in the vtbl[]
                         */
                        e = new PtrExp(e!.loc, e);
                        e.type = pointerTo(t);
                        if (mt.sym!.isInterfaceDeclaration() !== null) {
                            if (mt.sym!.isCPPinterface()) {
                                /* C++ interface vtbl[]s are different in that the
                                 * first entry is always pointer to the first virtual
                                 * function, not classinfo.
                                 * We can't get a .classinfo for it.
                                 */
                                error(e.loc, ds("no `.classinfo` for C++ interface objects"));
                            }
                            /* For an interface, the first entry in the vtbl[]
                             * is actually a pointer to an instance of struct Interface.
                             * The first member of Interface is the .classinfo,
                             * so add an extra pointer indirection.
                             */
                            e.type = pointerTo(e.type!);
                            e = new PtrExp(e.loc, e);
                            e.type = pointerTo(t);
                        }
                        e = new PtrExp(e.loc, e, t);
                    }
                    return e;
                }

                if (ident === Id.__vptr) {
                    /* The pointer to the vtbl[]
                     * *cast(immutable(void*)**)e
                     */
                    e = castTo(e!, sc, pointerTo(pointerTo(immutableOf(Type.tvoidptr))));
                    e = new PtrExp(e.loc, e);
                    e = expressionSemantic(e, sc);
                    return e;
                }

                if (ident === Id.__monitor && mt.sym!.hasMonitor()) {
                    /* The handle to the monitor (call it a void*)
                     * *(cast(void**)e + 1)
                     */
                    e = castTo(e!, sc, pointerTo(Type.tvoidptr));
                    e = new AddExp(e.loc, e, IntegerExp.literal(1));
                    e = new PtrExp(e.loc, e);
                    e = expressionSemantic(e, sc);
                    return e;
                }

                if (ident === Id.outer && mt.sym!.vthis !== null) {
                    if (mt.sym!.vthis.semanticRun === PASS.initial)
                        dsymbolSemantic(mt.sym!.vthis, null);

                    {
                        const cdp = mt.sym!.toParentLocal()?.isClassDeclaration() ?? null;
                        if (cdp !== null) {
                            const dve = new DotVarExp(e!.loc, e, mt.sym!.vthis);
                            dve.type = addMod(cdp.type!, e!.type!.mod);
                            return dve;
                        }
                    }

                    /* https://issues.dlang.org/show_bug.cgi?id=15839
                     * Find closest parent class through nested functions.
                     */
                    for (let p: Dsymbol | null = mt.sym!.toParentLocal(); p !== null; p = p.toParentLocal()) {
                        const fd = p.isFuncDeclaration();
                        if (fd === null)
                            break;
                        const ad = fd.isThis();
                        if (ad === null && fd.isNested())
                            continue;
                        if (ad === null)
                            break;
                        const cdp = ad.isClassDeclaration();
                        if (cdp !== null) {
                            const ve = new ThisExp(e!.loc);

                            ve.var_ = fd.vthis;
                            const nestedError = checkNestedReference(fd.vthis!, sc, e!.loc);
                            assert(!nestedError);

                            ve.type = addMod(addMod(cdp.type!, fd.vthis!.type!.mod), e!.type!.mod);
                            return ve;
                        }
                        break;
                    }

                    // Continue to show enclosing function's frame (stack or closure).
                    const dve = new DotVarExp(e!.loc, e, mt.sym!.vthis);
                    dve.type = addMod(mt.sym!.vthis.type!, e!.type!.mod);
                    return dve;
                }

                return noMember(mt, sc, e, ident, flag & 1);
            }
            if (!sc.ignoresymbolvisibility && !symbolIsVisible(sc, s)) {
                return noMember(mt, sc, e, ident, flag);
            }
            if (s.isFuncDeclaration() === null) { // because of overloading
                checkDeprecated(s, e!.loc, sc);
                const d = s.isDeclaration();
                if (d !== null)
                    checkDisabled(d, e!.loc, sc);
            }
            s = toAlias(s);

            {
                const em = s.isEnumMember();
                if (em !== null) {
                    return getVarExp(em, e!.loc, sc);
                }
            }
            {
                const v = s.isVarDeclaration();
                if (v !== null) {
                    if (v.type === null ||
                        (v.type.deco === null && v.inuse)) {
                        if (v.inuse) // https://issues.dlang.org/show_bug.cgi?id=9494
                            error(e!.loc, ds("circular reference to %s `%s`"), v.kind(), v.toPrettyChars());
                        else
                            error(e!.loc, ds("forward reference to %s `%s`"), v.kind(), v.toPrettyChars());
                        return ErrorExp.get();
                    }
                    if (v.type.ty === TY.Terror) {
                        error(e!.loc, ds("type of variable `%s` has errors"), v.toPrettyChars());
                        return ErrorExp.get();
                    }

                    if ((v.storage_class & STC.manifest) !== 0n && v._init !== null) {
                        if (v.inuse) {
                            error(e!.loc, ds("circular initialization of %s `%s`"), v.kind(), v.toPrettyChars());
                            return ErrorExp.get();
                        }
                        checkAccess(e!.loc, sc, null, v);
                        let ve: Expression = new VarExp(e!.loc, v);
                        ve = expressionSemantic(ve, sc);
                        return ve;
                    }
                }
            }

            {
                const t = getType(s);
                if (t !== null) {
                    return expressionSemantic(new TypeExp(e!.loc, t), sc);
                }
            }

            const tm = s.isTemplateMixin();
            if (tm !== null) {
                const se = new ScopeExp(e!.loc, tm);
                return expressionSemantic(new DotExp(e!.loc, e, se), sc);
            }

            const td = s.isTemplateDeclaration();

            // dmd/typesem.d:7305 — nested helper, declared where D declares it.
            const toTemplateExp = (td: TemplateDeclaration): Expression | null => {
                if (e!.op === EXP.type)
                    e = new TemplateExp(e!.loc, td);
                else
                    e = new DotTemplateExp(e!.loc, e, td);
                e = expressionSemantic(e, sc);
                return e;
            };

            if (td !== null) {
                return toTemplateExp(td);
            }

            const ti = s.isTemplateInstance();
            if (ti !== null) {
                if (ti.semanticRun === PASS.initial) {  // D: `if (!ti.semanticRun)` — PASS.initial == 0 (09 §9)
                    dsymbolSemantic(ti, sc);
                    if (ti.inst === null || ti.errors) { // if template failed to expand
                        return ErrorExp.get();
                    }
                }
                s = toAlias(ti.inst!);
                if (s.isTemplateInstance() === null)
                    continue L1;    // goto L1 (dmd/typesem.d:7333)
                if (e!.op === EXP.type)
                    e = new ScopeExp(e!.loc, ti);
                else
                    e = new DotExp(e!.loc, e, new ScopeExp(e!.loc, ti));
                return expressionSemantic(e, sc);
            }

            if (s.isImport() !== null || s.isModule() !== null || s.isPackage() !== null) {
                e = symbolToExp(s, e!.loc, sc, false);
                return e;
            }

            const o = s.isOverloadSet();
            if (o !== null) {
                const oe = new OverExp(e!.loc, o);
                if (e!.op === EXP.type) {
                    return oe;
                }
                return new DotExp(e!.loc, e, oe);
            }

            let d = s.isDeclaration();
            if (d === null) {
                error(e!.loc, ds("`%s.%s` is not a declaration"), toErrMsg(e!), ident.toChars());
                return ErrorExp.get();
            }

            if (e!.op === EXP.type) {
                /* It's:
                 *    Class.d
                 */
                const tup = d.isTupleDeclaration();
                if (tup !== null) {
                    e = TupleExp.fromTupleDeclaration(e!.loc, tup);
                    fillTupleExpExps(e.isTupleExp()!, tup);          // dmd/typesem.d:7373
                    e = expressionSemantic(e, sc);
                    return e;
                }

                if (mt.sym!.classKind === ClassKind.objc
                    && d.isFuncDeclaration() !== null
                    && d.isFuncDeclaration()!.isStatic()      // D `@property`-less method call (04 §9)
                    && d.isFuncDeclaration()!.objc.selector !== null) {
                    const classRef = new ObjcClassReferenceExp(e!.loc, mt.sym);
                    // dmd/typesem.d:7384. D hands the nullable result to getType unchecked: `!` at D's fault point.
                    classRef.type = getType(objc()!.getRuntimeMetaclass(mt.sym!)!);
                    return expressionSemantic(new DotVarExp(e!.loc, classRef, d), sc);
                } else if (d.needThis() && sc.intypeof !== 1) {
                    /* Rewrite as:
                     *  this.d
                     */
                    const ad = d.isMemberLocal();
                    const f = hasThis(sc);      // dmd/typesem.d:7393 — `if (auto f = hasThis(sc))` (06 §2.6)
                    if (f !== null) {
                        // This is almost same as getRightThis() in expressionsem.d
                        let e1: Expression | null = null;
                        let t: Type | null = null;
                        /* returns: true to continue, false to return */
                        // SKIP-FLAG (06 §4.1) for the forward `goto L2;` at dmd/typesem.d:7415 —
                        // it skips the `e1 = new ThisExp(...)` prologue below.
                        let gotoL2 = false;
                        if (f.hasDualContext) {
                            if (followInstantiationContext(f, ad)) {   // typesem.d:7401
                                e1 = new VarExp(e!.loc, f.vthis!);
                                e1 = new PtrExp(e1.loc, e1);
                                e1 = new IndexExp(e1.loc, e1, IntegerExp.literal(1));
                                const pd = f.toParent2()!.isDeclaration();
                                assert(pd !== null);
                                t = toBasetype(pd!.type!);
                                // dmd/typesem.d:7409
                                e1 = getThisSkipNestedFuncs(e1.loc, sc, f.toParent2(), ad!, e1, t, d, true);
                                if (e1 === null) {
                                    e = new VarExp(e!.loc, d);
                                    return e;
                                }
                                gotoL2 = true;      // goto L2 (dmd/typesem.d:7415)
                            }
                        }
                        if (!gotoL2) {
                            e1 = new ThisExp(e!.loc);
                            e1 = expressionSemantic(e1, sc);
                        }
                        // RETRY (06 §4): `L2:` (dmd/typesem.d:7420) is also jumped BACK to from :7451.
                        L2: for (;;) {
                            t = toBasetype(e1!.type!);
                            const cd = e!.type!.isClassHandle();
                            const tcd = t.isClassHandle();
                            if (cd !== null && tcd !== null && (tcd === cd || cd.isBaseOf(tcd, null))) {
                                e = new DotTypeExp(e1!.loc, e1, cd);
                                e = new DotVarExp(e.loc, e, d);
                                e = expressionSemantic(e, sc);
                                return e;
                            }
                            if (tcd !== null && tcd.isNested()) {
                                /* e1 is the 'this' pointer for an inner class: tcd.
                                 * Rewrite it as the 'this' pointer for the outer class.
                                 */
                                // dmd/typesem.d:7436.
                                const vthis = followInstantiationContext(tcd, ad) ? tcd.vthis2 : tcd.vthis;
                                e1 = new DotVarExp(e!.loc, e1, vthis!);
                                e1.type = vthis!.type;
                                e1.type = addMod(e1.type!, t.mod);
                                // Do not call ensureStaticLinkTo()
                                //e1 = e1.expressionSemantic(sc);

                                // Skip up over nested functions, and get the enclosing
                                // class type.
                                // dmd/typesem.d:7445
                                e1 = getThisSkipNestedFuncs(e1.loc, sc, toParentP(tcd, ad), ad!, e1, t, d, true);
                                if (e1 === null) {
                                    e = new VarExp(e!.loc, d);
                                    return e;
                                }
                                continue L2;    // goto L2 (dmd/typesem.d:7451)
                            }
                            break L2;
                        }
                        void ad;
                    }
                }
                //printf("e = %s, d = %s\n", e.toChars(), d.toChars());
                if (d.semanticRun === PASS.initial)
                    dsymbolSemantic(d, null);

                // If static function, get the most visible overload.
                // Later on the call is checked for correctness.
                // https://issues.dlang.org/show_bug.cgi?id=12511
                let d2: Dsymbol = d;
                {
                    const fd = d.isFuncDeclaration();
                    if (fd !== null)
                        d2 = mostVisibleOverload(fd, sc._module);
                }

                checkAccess(e!.loc, sc, e, d2);
                if (d2.isDeclaration() !== null) {
                    d = d2.isDeclaration()!;    // D: `d = cast(Declaration)d2;`
                    const ve = new VarExp(e!.loc, d);
                    if (d.isVarDeclaration() !== null && d.needThis())
                        ve.type = addMod(d.type!, e!.type!.mod);
                    return ve;
                } else if (d2.isTemplateDeclaration() !== null) {
                    return toTemplateExp(d2.isTemplateDeclaration()!);  // D: `cast(TemplateDeclaration)d2`
                } else
                    return assertUnreachable();
            }

            const unreal = e!.op === EXP.variable && e!.isVarExp()!.var_.isField();
            if (d.isDataseg() || (unreal && d.isField())) {
                // (e, d)
                checkAccess(e!.loc, sc, e, d);
                const ve: Expression = new VarExp(e!.loc, d);
                e = unreal ? ve : new CommaExp(e!.loc, e, ve);
                e = expressionSemantic(e, sc);
                return e;
            }

            e = new DotVarExp(e!.loc, e, d);
            e = expressionSemantic(e, sc);
            return e;
        }
    };

    // Dispatch switch S8 (dmd/typesem.d:7502-7518) — emitted IN FULL, in D's arm ORDER
    // (the `default:` is LAST here, unlike the file's other dispatches).
    switch (mt.ty) {
        case TY.Tvector:    return visitVector   (mt.isTypeVector()!);
        case TY.Tsarray:    return visitSArray   (mt.isTypeSArray()!);
        case TY.Tstruct:    return visitStruct   (mt.isTypeStruct()!);
        case TY.Tenum:      return visitEnum     (mt.isTypeEnum()!);
        case TY.Terror:     return visitError    (mt.isTypeError()!);
        case TY.Tarray:     return visitDArray   (mt.isTypeDArray()!);
        case TY.Taarray:    return visitAArray   (mt.isTypeAArray()!);
        case TY.Treference: return visitReference(mt.isTypeReference()!);
        case TY.Tdelegate:  return visitDelegate (mt.isTypeDelegate()!);
        case TY.Tclass:     return visitClass    (mt.isTypeClass()!);

        default:            return mt.isTypeBasic() !== null
                                   ? visitBasic(mt.isTypeBasic()!)
                                   : visitType(mt);
    }
}

// if initializer is 0
export function isZeroInit(t: Type, loc: Loc): boolean {
    const visitType = (_t: Type): boolean => {
        return false;       // assume not
    };

    const visitBasic = (t: TypeBasic): boolean => {
        switch (t.ty) {
            case TY.Tchar:
            case TY.Twchar:
            case TY.Tdchar:
            case TY.Timaginary32:
            case TY.Timaginary64:
            case TY.Timaginary80:
            case TY.Tfloat32:
            case TY.Tfloat64:
            case TY.Tfloat80:
            case TY.Tcomplex32:
            case TY.Tcomplex64:
            case TY.Tcomplex80:
                return false; // no
            default:
                return true; // yes
        }
    };

    const visitVector = (t: TypeVector): boolean => {
        return isZeroInit(t.basetype, loc);
    };

    const visitSArray = (t: TypeSArray): boolean => {
        return isZeroInit(t.next!, loc);
    };

    const visitStruct = (t: TypeStruct): boolean => {
        // Determine zeroInit here, as this can be called before semantic2
        determineSize(t.sym!, t.sym!.loc);
        return t.sym!.zeroInit;
    };

    const visitEnum = (t: TypeEnum): boolean => {
        // dmd/typesem.d:7570 — D dereferences the `getDefaultValue` result unchecked.
        return toBool(getDefaultValue(t.sym!, loc)!).hasValue(false);
    };

    // Dispatch switch S9 (dmd/typesem.d:7573-7586) — emitted IN FULL.
    switch (t.ty) {
        default:               return t.isTypeBasic() !== null ? visitBasic(t.isTypeBasic()!) : visitType(t);
        case TY.Tvector:       return visitVector(t.isTypeVector()!);
        case TY.Tsarray:       return visitSArray(t.isTypeSArray()!);
        case TY.Taarray:
        case TY.Tarray:
        case TY.Treference:
        case TY.Tdelegate:
        case TY.Tclass:
        case TY.Tpointer:      return true;
        case TY.Tstruct:       return visitStruct(t.isTypeStruct()!);
        case TY.Tenum:         return visitEnum(t.isTypeEnum()!);
    }
}

/************************
 * Get the default initialization expression for a type.
 * Params:
 *  mt = the type for which the init expression is returned
 *  loc = the location where the expression needs to be evaluated
 *  isCfile = default initializers are different with C
 *
 * Returns:
 *  The initialization expression for the type.
 *
 * Returns `Expression | null`: the dispatch's `default:` arm yields `null` for a non-basic type
 * that matches no case (dmd/typesem.d:7762).
 */
export function defaultInit(mt: Type, loc: Loc, isCfile = false): Expression | null {
    const visitBasic = (mt: TypeBasic): Expression | null => {
        // resolved: static if (LOGDEFAULTINIT == 0) -> false, printf block dropped (dmd/typesem.d:7604)
        let value: bigint = 0n;     // D `dinteger_t value = 0;` — bigint domain (09 §1)

        switch (mt.ty) {
        case TY.Tchar:
            value = isCfile ? 0n : 0xFFn;
            break;

        case TY.Twchar:
        case TY.Tdchar:
            value = isCfile ? 0n : 0xFFFFn;
            break;

        case TY.Timaginary32:
        case TY.Timaginary64:
        case TY.Timaginary80:
        case TY.Tfloat32:
        case TY.Tfloat64:
        case TY.Tfloat80:
            return new RealExp(loc, isCfile ? CTFloat.zero : target.RealProperties.nan, mt);

        case TY.Tcomplex32:
        case TY.Tcomplex64:
        case TY.Tcomplex80:
            {
                // Can't use fvalue + I*fvalue (the im part becomes a quiet NaN).
                const cvalue = isCfile ? new complex_t(CTFloat.zero, CTFloat.zero)
                                       : new complex_t(target.RealProperties.nan, target.RealProperties.nan);
                return new ComplexExp(loc, cvalue, mt);
            }

        case TY.Tvoid:
            error(loc, ds("`void` does not have a default initializer"));
            return ErrorExp.get();

        default:
            break;
        }
        return new IntegerExp(loc, value, mt);
    };

    const visitVector = (mt: TypeVector): Expression | null => {
        //printf("TypeVector::defaultInit()\n");
        assert(mt.basetype.ty === TY.Tsarray);
        const e = defaultInit(mt.basetype, loc, isCfile);
        const ve = new VectorExp(loc, e, mt);
        ve.type = mt;
        // dmd/typesem.d:7656 — `cast(int)(mt.basetype.size(loc) / mt.elementType().size(loc))`.
        // Both operands are `uinteger_t` (bigint) and `size()` can return SIZE_INVALID, so the
        // quotient is NOT provably in the int domain: reproduce D's cast as a 32-bit mask-on-store
        // (09 §2), exactly as the sibling `defaultInitLiteral.visitVector` does at typesem.d:4994.
        ve.dim = Number(BigInt.asIntN(32, size(mt.basetype, loc) / size(mt.elementType(), loc)));
        return ve;
    };

    const visitSArray = (mt: TypeSArray): Expression | null => {
        // resolved: static if (LOGDEFAULTINIT == 0) -> false, printf block dropped (dmd/typesem.d:7662)
        if (mt.next!.ty === TY.Tvoid)
            return defaultInit(Type.tuns8, loc, isCfile);
        else
            return defaultInit(mt.next!, loc, isCfile);
    };

    const visitFunction = (_mt: TypeFunction): Expression | null => {
        error(loc, ds("`function` does not have a default initializer"));
        return ErrorExp.get();
    };

    const visitStruct = (mt: TypeStruct): Expression | null => {
        // resolved: static if (LOGDEFAULTINIT == 0) -> false, printf block dropped (dmd/typesem.d:7680)
        const d: Declaration = new SymbolDeclaration(mt.sym!.loc, mt.sym!);
        assert(d !== null);
        d.type = mt;
        d.storage_class = (d.storage_class | STC.rvalue) as STC; // https://issues.dlang.org/show_bug.cgi?id=14398
        return new VarExp(mt.sym!.loc, d);
    };

    const visitEnum = (mt: TypeEnum): Expression | null => {
        // resolved: static if (LOGDEFAULTINIT == 0) -> false, printf block dropped (dmd/typesem.d:7693)
        // Initialize to first member of enum
        // dmd/typesem.d:7698 — D dereferences the result unchecked (`e.copy()` below).
        let e: Expression = getDefaultValue(mt.sym!, loc)!;
        e = e.copy();
        e.loc = loc;
        e.type = mt; // to deal with const, immutable, etc., variants
        return e;
    };

    const visitTuple = (mt: TypeTuple): Expression | null => {
        // resolved: static if (LOGDEFAULTINIT == 0) -> false, printf block dropped (dmd/typesem.d:7707)
        const exps: Expressions = new DArray<Expression | null>(mt.arguments!.length);
        for (let i = 0; i < mt.arguments!.length; i++) {
            const p = mt.arguments!.opIndex(i)!;
            assert(p.type !== null);
            const e = defaultInitLiteral(p.type!, loc);
            // STITCH SEAM (02 §10.1): `defaultInitLiteral` is declared `Expression | null` here (its
            // `defaultInit` tail has a null-yielding `default:` arm), but D writes
            // `e.op == EXP.error` with no null test (dmd/typesem.d:7717) — the `!` marks exactly
            // the point D would fault.
            if (e!.op === EXP.error) {
                return e;
            }
            exps.opIndexAssign(e, i);
        }
        return TupleExp.fromExps(loc, exps);
    };

    const visitNoreturn = (mt: TypeNoreturn): Expression | null => {
        // resolved: static if (LOGDEFAULTINIT == 0) -> false, printf block dropped (dmd/typesem.d:7728)
        const cond = IntegerExp.createBool(false);
        const msg = new StringExp(loc, [...ds("Accessed expression of type `noreturn`")]);
        msg.type = Type.tstring;
        const ae = new AssertExp(loc, cond, msg);
        ae.type = mt;
        return ae;
    };

    // Dispatch switch S10 (dmd/typesem.d:7740-7764) — emitted IN FULL; the `default:` arm CAN
    // return null.
    switch (mt.ty) {
        case TY.Tvector:   return visitVector  (mt.isTypeVector()!);
        case TY.Tsarray:   return visitSArray  (mt.isTypeSArray()!);
        case TY.Tfunction: return visitFunction(mt.isTypeFunction()!);
        case TY.Tstruct:   return visitStruct  (mt.isTypeStruct()!);
        case TY.Tenum:     return visitEnum    (mt.isTypeEnum()!);
        case TY.Ttuple:    return visitTuple   (mt.isTypeTuple()!);

        case TY.Tnull:     return new NullExp(Loc.initial, Type.tnull);

        case TY.Terror:    return ErrorExp.get();

        case TY.Tarray:
        case TY.Taarray:
        case TY.Tpointer:
        case TY.Treference:
        case TY.Tdelegate:
        case TY.Tclass:    return new NullExp(loc, mt);
        case TY.Tnoreturn: return visitNoreturn(mt.isTypeNoreturn()!);

        default:           return mt.isTypeBasic() !== null ?
                                  visitBasic(mt.isTypeBasic()!) :
                                  null;
    }
}

/*
If `type` resolves to a dsymbol, then that
dsymbol is returned.

Params:
  type = the type that is checked
  sc   = the scope where the type is used

Returns:
  The dsymbol to which the type resolve or `null`
  if the type does resolve to any symbol (for example,
  in the case of basic types).
*/
export function toDsymbol(type: Type, sc: Scope | null): Dsymbol | null {
    const visitType = (_t: Type): Dsymbol | null            => { return null; };
    const visitStruct = (type: TypeStruct): Dsymbol | null  => { return type.sym; };
    const visitEnum = (type: TypeEnum): Dsymbol | null      => { return type.sym; };
    const visitClass = (type: TypeClass): Dsymbol | null    => { return type.sym; };

    const visitTraits = (type: TypeTraits): Dsymbol | null => {
        // D `Type t; Expression e; Dsymbol s;` are the three `out` slots of `resolve` -> boxes
        // (03 §3.3); `resolve` resets them on entry, so the initial values are never read.
        const t: Ref<Type | null> = { value: null };
        const e: Ref<Expression | null> = { value: null };
        const s: Ref<Dsymbol | null> = { value: null };
        resolve(type, type.loc, sc!, e, t, s);
        if (t.value !== null && t.value.ty !== TY.Terror)
            s.value = toDsymbol(t.value, sc);
        else if (e.value !== null) {
            s.value = getDsymbol(e.value);                     // dmd/typesem.d:7796
        }

        return s.value;
    };

    const visitMixin = (type: TypeMixin): Dsymbol | null => {
        const t: Ref<Type | null> = { value: null };
        const e: Ref<Expression | null> = { value: null };
        const s: Ref<Dsymbol | null> = { value: null };
        resolve(type, type.loc, sc!, e, t, s);
        if (t.value !== null)
            s.value = toDsymbol(t.value, sc);
        else if (e.value !== null) {
            s.value = getDsymbol(e.value);                     // dmd/typesem.d:7810
        }

        return s.value;
    };

    const visitIdentifier = (type: TypeIdentifier): Dsymbol | null => {
        //printf("TypeIdentifier::toDsymbol('%s')\n", toChars(type));
        if (sc === null)
            return null;

        const t: Ref<Type | null> = { value: null };
        const e: Ref<Expression | null> = { value: null };
        const s: Ref<Dsymbol | null> = { value: null };
        resolve(type, type.loc, sc, e, t, s);
        if (t.value !== null && t.value.ty !== TY.Tident)
            s.value = toDsymbol(t.value, sc);
        if (e.value !== null) {
            s.value = getDsymbol(e.value);                     // dmd/typesem.d:7828
        }
        return s.value;
    };

    const visitInstance = (type: TypeInstance): Dsymbol | null => {
        const t: Ref<Type | null> = { value: null };
        const e: Ref<Expression | null> = { value: null };
        const s: Ref<Dsymbol | null> = { value: null };
        //printf("TypeInstance::semantic(%s)\n", toChars());
        resolve(type, type.loc, sc!, e, t, s);
        if (t.value !== null && t.value.ty !== TY.Tinstance)
            s.value = toDsymbol(t.value, sc);
        return s.value;
    };

    const visitTypeof = (type: TypeTypeof): Dsymbol | null => {
        //printf("TypeTypeof::toDsymbol('%s')\n", toChars());
        const e: Ref<Expression | null> = { value: null };
        const t: Ref<Type | null> = { value: null };
        const s: Ref<Dsymbol | null> = { value: null };
        resolve(type, type.loc, sc!, e, t, s);
        return s.value;
    };

    const visitReturn = (type: TypeReturn): Dsymbol | null => {
        const e: Ref<Expression | null> = { value: null };
        const t: Ref<Type | null> = { value: null };
        const s: Ref<Dsymbol | null> = { value: null };
        resolve(type, type.loc, sc!, e, t, s);
        return s.value;
    };

    // Dispatch switch S11 (dmd/typesem.d:7863-7875) — emitted IN FULL.
    switch (type.ty) {
        default:                return visitType(type);
        case TY.Ttraits:        return visitTraits(type.isTypeTraits()!);
        case TY.Tmixin:         return visitMixin(type.isTypeMixin()!);
        case TY.Tident:         return visitIdentifier(type.isTypeIdentifier()!);
        case TY.Tinstance:      return visitInstance(type.isTypeInstance()!);
        case TY.Ttypeof:        return visitTypeof(type.isTypeTypeof()!);
        case TY.Treturn:        return visitReturn(type.isTypeReturn()!);
        case TY.Tstruct:        return visitStruct(type.isTypeStruct()!);
        case TY.Tenum:          return visitEnum(type.isTypeEnum()!);
        case TY.Tclass:         return visitClass(type.isTypeClass()!);
    }
}

/************************************
 * Add storage class modifiers to type.
 */
export function addStorageClass(type: Type, stc: STC): Type {
    const visitType = (t: Type): Type => {
        /* Just translate to MOD bits and let addMod() do the work
         */
        let mod: MOD = 0;
        if ((stc & STC.immutable_) !== 0n)
            mod = MODFlags.immutable_;
        else {
            if ((stc & (STC.const_ | STC.in_)) !== 0n)
                mod |= MODFlags.const_;
            if ((stc & STC.wild) !== 0n)
                mod |= MODFlags.wild;
            if ((stc & STC.shared_) !== 0n)
                mod |= MODFlags.shared_;
        }
        return addMod(t, mod);
    };

    const visitFunction = (tf_src: TypeFunction): Type => {
        //printf("addStorageClass(%llx) %d\n", stc, (stc & STC.scope_) != 0);
        let t: TypeFunction = visitType(tf_src).toTypeFunction();
        // `!t.purity` / `!t.isNothrow` — PURE is an integer-backed enum, expanded per 09 §9.1
        // (PURE.impure == 0); the `bool` fields stay plain negations.
        if (((stc & STC.pure_) !== 0n && t.purity === PURE.impure) ||
            ((stc & STC.nothrow_) !== 0n && !t.isNothrow) ||
            ((stc & STC.nogc) !== 0n && !t.isNogc) ||
            ((stc & STC.scope_) !== 0n && !t.isScopeQual) ||
            ((stc & STC.safe) !== 0n && t.trust < TRUST.trusted)) {
            // Klunky to change these
            const tf = new TypeFunction(t.parameterList, t.next, t.linkage, STC.none);
            tf.mod = t.mod;
            // 03 §1 #5: `ArgumentList` (expression.d:2352) is a VALUE struct and is NOT in the
            // §9.1 alias-safe register, so a field store copies. Same as mtype.ts:849/3167.
            tf.inferenceArguments = tf_src.inferenceArguments.copy();
            tf.purity = t.purity;
            tf.isNothrow = t.isNothrow;
            tf.isNogc = t.isNogc;
            tf.isProperty = t.isProperty;
            tf.isRef = t.isRef;
            tf.isReturn = t.isReturn;
            tf.isReturnScope = t.isReturnScope;
            tf.isScopeQual = t.isScopeQual;
            tf.isReturnInferred = t.isReturnInferred;
            tf.isScopeInferred = t.isScopeInferred;
            tf.trust = t.trust;
            tf.isInOutParam = t.isInOutParam;
            tf.isInOutQual = t.isInOutQual;
            tf.isCtor = t.isCtor;

            if ((stc & STC.pure_) !== 0n)
                tf.purity = PURE.fwdref;
            if ((stc & STC.nothrow_) !== 0n)
                tf.isNothrow = true;
            if ((stc & STC.nogc) !== 0n)
                tf.isNogc = true;
            if ((stc & STC.safe) !== 0n)
                tf.trust = TRUST.safe;
            if ((stc & STC.scope_) !== 0n) {
                tf.isScopeQual = true;
                if ((stc & STC.scopeinferred) !== 0n)
                    tf.isScopeInferred = true;
            }

            tf.deco = merge(tf).deco;
            t = tf;
        }
        return t;
    };

    const visitDelegate = (tdg: TypeDelegate): Type => {
        const t = visitType(tdg).isTypeDelegate()!;
        return t;
    };

    // Dispatch switch S12 (dmd/typesem.d:7958-7963) — emitted IN FULL.
    switch (type.ty) {
        default:                return visitType(type);
        case TY.Tfunction:      return visitFunction(type.isTypeFunction()!);
        case TY.Tdelegate:      return visitDelegate(type.isTypeDelegate()!);
    }
}

// dmd/typesem.d:7979-7981 — `__gshared Type complex_float, complex_double, complex_real;` declared
// inside `getComplexLibraryType` but process-wide (preamble §M6). They are the singleton cache the
// `Type* pt` slot-pointer writes through.
let complex_float: Type | null = null;
let complex_double: Type | null = null;
let complex_real: Type | null = null;

/**
 * No D counterpart: the djs driver's reset between two compiles in one process (src/djs.ts
 * `deinitializeFrontend`). The function-static caches of this module hold declarations and types of the
 * finished compile (`visitAArray`'s object.d `xopEquals`/`xopCmp`/`xtoHash`, `getComplexLibraryType`'s
 * `core.stdc.config` types), and `noMember`'s recursion counter stays raised after a compile stopped by
 * `fatal()`.
 */
export function resetTypesemState(): void {
    feq = fcmp = fhash = null;
    nest = 0;
    complex_float = complex_double = complex_real = null;
}

/**********************************************
 * Extract complex type from core.stdc.config
 * Params:
 *      loc = for error messages
 *      sc = context
 *      ty = a complex or imaginary type
 * Returns:
 *      Complex!float, Complex!double, Complex!real or null for error
 */
export function getComplexLibraryType(loc: Loc, sc: Scope, ty: TY): Type {
    // D `Type* pt = &complex_float | &complex_double | &complex_real;` — a pointer to a MODULE
    // SLOT that is both read (`*pt`) and written (`*pt = ...`). §9-D6: an accessor PAIR over the
    // three `let`s, selected by the same switch that selects the D pointer.
    let getPt!: () => Type | null;
    let setPt!: (t: Type | null) => void;
    // `Id.*` is declared `Identifier | null` (filled by `Id.initialize()`); D types them non-null,
    // so the `!` marks the same "used before Id.initialize()" fault D would have.
    let id: Identifier;
    switch (ty) {
        case TY.Timaginary32:
        case TY.Tcomplex32:
            id = Id.c_complex_float!;
            getPt = () => complex_float; setPt = (t) => { complex_float = t; };
            break;
        case TY.Timaginary64:
        case TY.Tcomplex64:
            id = Id.c_complex_double!;
            getPt = () => complex_double; setPt = (t) => { complex_double = t; };
            break;
        case TY.Timaginary80:
        case TY.Tcomplex80:
            id = Id.c_complex_real!;
            getPt = () => complex_real; setPt = (t) => { complex_real = t; };
            break;
        default:
             return Type.terror;
    }

    if (getPt() !== null)
        return getPt()!;
    setPt(Type.terror);

    const mConfig = loadCoreStdcConfig();                  // dmd/typesem.d:8001
    if (mConfig === null) {
        error(loc, ds("`core.stdc.config` is required for complex numbers"));
        return getPt()!;
    }

    // upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool)
    let s = searchX(mConfig as unknown as Dsymbol, Loc.initial, sc, id, SearchOpt.ignorePrivateImports);
    if (s === null) {
        error(loc, ds("`%s` not found in core.stdc.config"), id.toChars());
        return getPt()!;
    }
    s = toAlias(s);
    {
        const t = getType(s);
        if (t !== null) {
            const ts = toBasetype(t).isTypeStruct();
            if (ts !== null) {
                setPt(ts);
                return ts;
            }
        }
    }
    {
        const sd = s.isStructDeclaration();
        if (sd !== null) {
            setPt(sd.type);
            return sd.type!;
        }
    }

    error(loc, ds("`%s` must be an alias for a complex struct"), s.toChars());
    return getPt()!;
}

/*******************************
 * Covariant means that 'src' can substitute for 't',
 * i.e. a pure function is a match for an impure type.
 * Params:
 *      src = source type
 *      t = type 'src' is covariant with
 *      pstc = if not null, store STCxxxx which would make it covariant
 *      cppCovariant = true if extern(C++) function types should follow C++ covariant rules
 * Returns:
 *     An enum value of either `Covariant.yes` or a reason it's not covariant.
 */
export function covariant(src: Type, t: Type, pstc: Ref<STC> | null = null, cppCovariant = false): Covariant {
    // resolved: version(none) -> OFF (_config.md); the four printf lines (dmd/typesem.d:8046-8052)
    // are dropped (07 §1).
    if (pstc !== null)
        pstc.value = STC.none;
    let stc: STC = STC.none;

    let notcovariant = false;

    // ── the three BAIL tails (06 §4). Built FIRST; every `goto` site below is a `return <tail>()`.
    // `Ldistinct:` (dmd/typesem.d:8281).
    const LdistinctTail = (): Covariant => {
        //printf("\tcovaraint: 0\n");
        return Covariant.distinct;
    };
    // `Lnotcovariant:` (dmd/typesem.d:8285).
    const LnotcovariantTail = (): Covariant => {
        //printf("\tcovaraint: 2\n");
        return Covariant.no;
    };

    if (src.equals(t))
        return Covariant.yes;

    const t1 = src.isTypeFunction();
    const t2 = t.isTypeFunction();

    // `Lcovariant:` (dmd/typesem.d:8199) — the epilogue. A forward jump target only, so it is a
    // BAIL tail returning the epilogue's own result; it CAPTURES `t1`/`t2`/`stc`/`pstc`
    // (06 §4: tails capture locals, never positional params).
    const LcovariantTail = (): Covariant => {
        if (t1!.isRef !== t2!.isRef)
            return LnotcovariantTail();     // goto Lnotcovariant (dmd/typesem.d:8201)

        if (!t1!.isRef && (t1!.isScopeQual || t2!.isScopeQual)) {
            let stc1: STC = t1!.isScopeQual ? STC.scope_ : STC.none;
            let stc2: STC = t2!.isScopeQual ? STC.scope_ : STC.none;
            if (t1!.isReturn) {
                stc1 = (stc1 | STC.return_) as STC;
                if (!t1!.isScopeQual)
                    stc1 = (stc1 | STC.ref_) as STC;
            }
            if (t2!.isReturn) {
                stc2 = (stc2 | STC.return_) as STC;
                if (!t2!.isScopeQual)
                    stc2 = (stc2 | STC.ref_) as STC;
            }
            if (!Parameter.isCovariantScope(t1!.isRef, stc1, stc2))
                return LnotcovariantTail(); // goto Lnotcovariant (dmd/typesem.d:8220)
        }

        // We can subtract 'return ref' from 'this', but cannot add it
        else if (t1!.isReturn && !t2!.isReturn)
            return LnotcovariantTail();     // goto Lnotcovariant (dmd/typesem.d:8225)

        /* https://issues.dlang.org/show_bug.cgi?id=23135
         * extern(C++) mutable member functions are not covariant with const.
         */
        if (t1!.linkage === LINK.cpp && cppCovariant && t1!.isNaked() !== t2!.isNaked())
            return LnotcovariantTail();     // goto Lnotcovariant (dmd/typesem.d:8231)

        /* Can convert mutable to const
         */
        if (!MODimplicitConv(t2!.mod, t1!.mod)) {
            // resolved: version(none) -> OFF (_config.md); the const-inference block
            // (dmd/typesem.d:8237-8245) is dropped and the `else` arm is the live one (07 §1);
            // the dropped arm's `goto Lnotcovariant;` at :8244 goes with it.
            return LdistinctTail();         // goto Ldistinct (dmd/typesem.d:8248)
        }

        /* Can convert pure to impure, nothrow to throw, and nogc to gc
         */
        if (t1!.purity === PURE.impure && t2!.purity !== PURE.impure)
            stc = (stc | STC.pure_) as STC;

        if (!t1!.isNothrow && t2!.isNothrow)
            stc = (stc | STC.nothrow_) as STC;

        if (!t1!.isNogc && t2!.isNogc)
            stc = (stc | STC.nogc) as STC;

        /* Can convert safe/trusted to system
         */
        if (t1!.trust <= TRUST.system && t2!.trust >= TRUST.trusted) {
            // Should we infer trusted or safe? Go with safe.
            stc = (stc | STC.safe) as STC;
        }

        // dmd/typesem.d:8271 — `if (stc)`: STC is a branded 64-bit flag set (09 §9, 02 §4.2).
        if (stc !== 0n) {
            if (pstc !== null)
                pstc.value = stc;
            return LnotcovariantTail();     // goto Lnotcovariant (dmd/typesem.d:8275)
        }

        //printf("\tcovaraint: 1\n");
        return Covariant.yes;
    };

    if (t1 === null || t2 === null)
        return LdistinctTail();     // goto Ldistinct (dmd/typesem.d:8066)

    if (t1.parameterList.varargs !== t2.parameterList.varargs)
        return LdistinctTail();     // goto Ldistinct (dmd/typesem.d:8069)

    if (t1.parameterList.parameters !== null && t2.parameterList.parameters !== null) {
        if (t1.parameterList.length() !== t2.parameterList.length())
            return LdistinctTail(); // goto Ldistinct (dmd/typesem.d:8074)

        // D `foreach (i, fparam1; t1.parameterList)` drives `ParameterList.opApply` (05 §11 /
        // 06 §1.8): the callback returns 0 to continue, non-zero to break. A `goto Ldistinct;`
        // from inside the loop is BOTH a break and a function return, so the tail's value is
        // parked in `bail` and re-returned right after the loop.
        let bail: Covariant | null = null;
        t1.parameterList.opApply((i: number, fparam1: Parameter): number => {
            const fparam2 = t2.parameterList.opIndex(i)!;
            const tp1 = fparam1.type!;
            const tp2 = fparam2.type!;

            if (!tp1.equals(tp2)) {
                // SKIP-FLAG (06 §4.1) for the five `goto Lcov;` sites — they skip the
                // `goto Ldistinct;` at dmd/typesem.d:8112 and land on `Lcov:` (:8114), which the
                // equals-path reaches by fall-through.
                let gotoLcov = false;
                if (tp1.ty === tp2.ty) {
                    const tc1 = tp1.isTypeClass();
                    const ts1 = tp1.isTypeStruct();
                    if (tc1 !== null) {
                        if (tc1.sym === tp2.isTypeClass()!.sym && MODimplicitConv(tp2.mod, tp1.mod))
                            gotoLcov = true;    // goto Lcov (dmd/typesem.d:8089)
                    } else if (ts1 !== null) {
                        if (ts1.sym === tp2.isTypeStruct()!.sym && MODimplicitConv(tp2.mod, tp1.mod))
                            gotoLcov = true;    // goto Lcov (dmd/typesem.d:8094)
                    } else if (tp1.ty === TY.Tpointer) {
                        if (implicitConvToType(tp2, tp1) !== MATCH.nomatch)
                            gotoLcov = true;    // goto Lcov (dmd/typesem.d:8099)
                    } else if (tp1.ty === TY.Tarray) {
                        if (implicitConvToType(tp2, tp1) !== MATCH.nomatch)
                            gotoLcov = true;    // goto Lcov (dmd/typesem.d:8104)
                    } else if (tp1.ty === TY.Tdelegate) {
                        if (implicitConvToType(tp2, tp1) !== MATCH.nomatch)
                            gotoLcov = true;    // goto Lcov (dmd/typesem.d:8109)
                    }
                }
                if (!gotoLcov) {
                    bail = LdistinctTail();     // goto Ldistinct (dmd/typesem.d:8112)
                    return 1;
                }
            }
            // Lcov: (dmd/typesem.d:8114)
            // D `notcovariant |= X` is a NON-short-circuiting bitwise or on a bool; the RHS is
            // evaluated first into a local so `||` cannot skip it.
            {
                const nc = !fparam1.isCovariant(t1.isRef, fparam2);
                notcovariant = notcovariant || nc;
            }

            /* https://issues.dlang.org/show_bug.cgi?id=23135
             * extern(C++) mutable parameters are not covariant with const.
             */
            if (t1.linkage === LINK.cpp && cppCovariant) {
                const ncNaked = tp1.isNaked() !== tp2.isNaked();
                notcovariant = notcovariant || ncNaked;
                const tpn1 = nextOf(tp1);
                if (tpn1 !== null) {
                    const ncNext = tpn1.isNaked() !== nextOf(tp2)!.isNaked();
                    notcovariant = notcovariant || ncNext;
                }
            }
            return 0;
        });
        if (bail !== null)
            return bail;
    } else if (t1.parameterList.parameters !== t2.parameterList.parameters) {
        if (t1.parameterList.length() || t2.parameterList.length())
            return LdistinctTail(); // goto Ldistinct (dmd/typesem.d:8131)
    }

    // The argument lists match
    if (notcovariant)
        return LnotcovariantTail(); // goto Lnotcovariant (dmd/typesem.d:8136)
    if (t1.linkage !== t2.linkage)
        return LnotcovariantTail(); // goto Lnotcovariant (dmd/typesem.d:8138)

    {
        // Return types
        const t1n = t1.next;
        const t2n = t2.next;

        if (t1n === null || t2n === null) // happens with return type inference
            return LnotcovariantTail(); // goto Lnotcovariant (dmd/typesem.d:8146)

        if (t1n.equals(t2n))
            return LcovariantTail();    // goto Lcovariant (dmd/typesem.d:8149)
        if (t1n.ty === TY.Tclass && t2n.ty === TY.Tclass) {
            /* If same class type, but t2n is const, then it's
             * covariant. Do this test first because it can work on
             * forward references.
             */
            if (t1n.isTypeClass()!.sym === t2n.isTypeClass()!.sym && MODimplicitConv(t1n.mod, t2n.mod))
                return LcovariantTail();    // goto Lcovariant (dmd/typesem.d:8157)

            // If t1n is forward referenced:
            const cd = t1n.isTypeClass()!.sym!;
            if (cd.semanticRun < PASS.semanticdone && !cd.isBaseInfoComplete())
                dsymbolSemantic(cd, null);
            if (!cd.isBaseInfoComplete()) {
                return Covariant.fwdref;
            }
        }
        if (t1n.ty === TY.Tstruct && t2n.ty === TY.Tstruct) {
            if (t1n.isTypeStruct()!.sym === t2n.isTypeStruct()!.sym && MODimplicitConv(t1n.mod, t2n.mod))
                return LcovariantTail();    // goto Lcovariant (dmd/typesem.d:8171)
        } else if (t1n.ty === t2n.ty && implicitConvToType(t1n, t2n) !== MATCH.nomatch) {
            if (t1.isRef && t2.isRef) {
                // Treat like pointers to t1n and t2n
                if (constConv(t1n, t2n) < MATCH.constant)
                    return LnotcovariantTail(); // goto Lnotcovariant (dmd/typesem.d:8179)
            }
            return LcovariantTail();    // goto Lcovariant (dmd/typesem.d:8181)
        } else if (t1n.ty === TY.Tnull) {
            // NULL is covariant with any pointer type, but not with any
            // dynamic arrays, associative arrays or delegates.
            // https://issues.dlang.org/show_bug.cgi?id=8589
            // https://issues.dlang.org/show_bug.cgi?id=19618
            const t2bn = toBasetype(t2n);
            if (t2bn.ty === TY.Tnull || t2bn.ty === TY.Tpointer || t2bn.ty === TY.Tclass)
                return LcovariantTail();    // goto Lcovariant (dmd/typesem.d:8191)
        }
        // bottom type is covariant to any type
        else if (t1n.ty === TY.Tnoreturn)
            return LcovariantTail();    // goto Lcovariant (dmd/typesem.d:8195)
    }
    return LnotcovariantTail();         // goto Lnotcovariant (dmd/typesem.d:8197)
}

/************************************
 * Take the specified storage class for p,
 * and use the function signature to infer whether
 * STC.scope_ and STC.return_ should be OR'd in.
 * (This will not affect the name mangling.)
 * Params:
 *  tf = TypeFunction to use to get the signature from
 *  tthis = type of `this` parameter, null if none
 *  p = parameter to this function
 *  outerVars = context variables p could escape into, if any
 *  indirect = is this for an indirect or virtual function call?
 * Returns:
 *  storage class with STC.scope_ or STC.return_ OR'd in
 */
export function parameterStorageClass(tf: TypeFunction, tthis: Type | null, p: Parameter,
    outerVars: VarDeclarations | null = null, indirect = false): STC {
    //printf("parameterStorageClass(p: %s)\n", p.toChars());
    const stc = p.storageClass;

    // When the preview switch is enable, `in` parameters are `scope`
    if ((stc & STC.constscoperef) !== 0n)
        return (stc | STC.scope_) as STC;

    if ((stc & (STC.scope_ | STC.return_ | STC.lazy_)) !== 0n || tf.purity === PURE.impure)
        return stc;

    /* If haven't inferred the return type yet, can't infer storage classes
     */
    if (nextOf(tf) === null || !tf.isNothrow)
        return stc;

    purityLevel(tf);

    const mayHavePointers = (t: Type): boolean => {
        const ts = t.isTypeStruct();
        if (ts !== null) {
            const sym = ts.sym!;
            if (sym.members !== null && !determineFields(sym)
                && sym.type !== Type.terror)
                // struct is forward referenced, so "may have" pointers
                return true;
        }
        return hasPointers(t);
    };

    // See if p can escape via any of the other parameters
    if (tf.purity === PURE.weak) {
        /*
         * Indirect calls may escape p through a nested context
         * See:
         *   https://issues.dlang.org/show_bug.cgi?id=24212
         *   https://issues.dlang.org/show_bug.cgi?id=24213
         */
        if (indirect)
            return stc;

        // Check escaping through parameters. D's `foreach (i, fparam; tf.parameterList)` with an
        // inner `return stc;` is the opApply protocol (05 §11) plus a parked result.
        let bail = false;
        tf.parameterList.opApply((_i: number, fparam: Parameter): number => {
            let t = fparam.type;
            if (t === null)
                return 0;       // D `continue`
            t = baseElemOf(t);     // punch thru static arrays
            if (t.isMutable() && hasPointers(t)) {
                // D's `fparam != p` calls `Parameter.opEquals` (mtype.d:2581): storage class and type, not
                // identity, so a second `ref` parameter of the same type and storage class as `p` does not
                // bail (`pure void f(ref int[] a, ref int[] b)` infers `scope` for both, as ldc2 does).
                if (fparam.isReference() && !fparam.opEquals(p)) {
                    bail = true; return 1;
                }

                if (t.ty === TY.Tdelegate) {
                    bail = true; return 1;     // could escape thru delegate
                }

                if (t.ty === TY.Tclass) {
                    bail = true; return 1;
                }

                /* if t is a pointer to mutable pointer
                 */
                const tn = nextOf(t);
                if (tn !== null) {
                    if (tn.isMutable() && mayHavePointers(tn)) {
                        bail = true; return 1;   // escape through pointers
                    }
                }
            }
            return 0;
        });
        if (bail)
            return stc;

        // Check escaping through `this`
        if (tthis !== null && tthis.isMutable()) {
            // D: `import dmd.dsymbolsem : hasPointers;` — the Dsymbol family member (04 §6.1),
            // ported as `hasPointersDsymbol`.
            for (const v of isAggregate(tthis)!.fields) {
                if (hasPointersDsymbol(v!))
                    return stc;
            }
        }

        // Check escaping through nested context
        if (outerVars !== null && tf.isMutable()) {
            for (const v of outerVars) {
                if (hasPointersDsymbol(v!))
                    return stc;
            }
        }
    }

    // Check escaping through return value
    const tret = toBasetype(nextOf(tf)!);
    if (tf.isRef || hasPointers(tret)) {
        return (stc | STC.scope_ | STC.return_ | STC.returnScope) as STC;
    } else
        return (stc | STC.scope_) as STC;
}

export function isBaseOf(tthis: Type, t: Type | null, poffset: Ref<number> | null): boolean {
    const tc = tthis.isTypeClass();
    if (tc === null)
        return false;

    if (t === null || t.ty !== TY.Tclass)
        return false;

    const cd = t.isTypeClass()!.sym!;
    if (cd.semanticRun < PASS.semanticdone && !cd.isBaseInfoComplete())
        dsymbolSemantic(cd, null);
    if (tc.sym!.semanticRun < PASS.semanticdone && !tc.sym!.isBaseInfoComplete())
        dsymbolSemantic(tc.sym!, null);

    if (tc.sym!.isBaseOf(cd, poffset))
        return true;

    return false;
}

export function equivalent(src: Type, t: Type): boolean {
    return immutableOf(src).equals(immutableOf(t));
}

export function pointerTo(type: Type): Type {
    if (type.ty === TY.Terror)
        return type;
    const mcache = type.getMcache();
    if (mcache.pto === null) {
        const t: Type = new TypePointer(type);
        if (type.ty === TY.Tfunction) {
            t.deco = merge(t).deco;
            mcache.pto = t;
        } else
            mcache.pto = merge(t);
    }
    return mcache.pto;
}

export function referenceTo(type: Type): Type {
    if (type.ty === TY.Terror)
        return type;
    const mcache = type.getMcache();
    if (mcache.rto === null) {
        const t: Type = new TypeReference(type);
        mcache.rto = merge(t);
    }
    return mcache.rto;
}

// Make corresponding static array type without semantic
export function sarrayOf(type: Type, dim: bigint): Type {
    // dmd/typesem.d:8470 — `assert(type.deco);`. `deco` is a NUL-terminated C-string view, so the
    // truthiness test is the explicit non-null/non-empty form (06 §2.8 / D8 of the preamble).
    assert(type.deco !== null && type.deco.length > 0);
    let t: Type = new TypeSArray(type, new IntegerExp(Loc.initial, dim, Type.tsize_t));
    // according to TypeSArray.semantic()
    t = addMod(t, type.mod);
    t = merge(t);
    return t;
}

export function arrayOf(type: Type): Type {
    if (type.ty === TY.Terror)
        return type;
    const mcache = type.getMcache();
    if (mcache.arrayof === null) {
        const t: Type = new TypeDArray(type);
        mcache.arrayof = merge(t);
    }
    return mcache.arrayof;
}

/********************************
 * Convert to 'const'.
 */
export function constOf(type: Type): Type {
    //printf("Type::constOf() %p %s\n", type, type.toChars());
    if (type.mod === MODFlags.const_)
        return type;
    if (type.mcache !== null && type.mcache.cto !== null) {
        assert(type.mcache.cto.mod === MODFlags.const_);
        return type.mcache.cto;
    }
    let t = makeConst(type);
    t = merge(t);
    fixTo(t, type);
    //printf("-Type::constOf() %p %s\n", t, t.toChars());
    return t;
}

/********************************
 * Convert to 'immutable'.
 */
export function immutableOf(type: Type): Type {
    //printf("Type::immutableOf() %p %s\n", this, toChars());
    if (type.isImmutable())
        return type;
    if (type.mcache !== null && type.mcache.ito !== null) {
        assert(type.mcache.ito.isImmutable());
        return type.mcache.ito;
    }
    let t = makeImmutable(type);
    t = merge(t);
    fixTo(t, type);
    //printf("\t%p\n", t);
    return t;
}

/********************************
 * Make type mutable.
 *      0            => 0
 *      const        => 0
 *      immutable    => 0
 *      shared       => shared
 *      shared const => shared
 *      wild         => 0
 *      wild const   => 0
 *      shared wild  => shared
 *      shared wild const => shared
 */
export function mutableOf(type: Type): Type {
    //printf("Type::mutableOf() %p, %s\n", type, type.toChars());
    let t: Type | null = type;
    if (type.isImmutable()) {
        type.getMcache();
        t = type.mcache!.ito; // immutable => naked
        assert(t === null || (t.isMutable() && !t.isShared()));
    } else if (type.isConst()) {
        type.getMcache();
        if (type.isShared()) {
            // 1.43 CHANGE (rename sweep R5): 1.42 read `mcache.swcto` when `isWild()` here; 1.43
            // always reads `sto`. Translated fresh from dmd/typesem.d:8557.
            t = type.mcache!.sto; // shared (wild) const => shared
        } else {
            if (type.isWild())
                t = type.mcache!.wcto; // wild const => naked
            else
                t = type.mcache!.cto; // const => naked
        }
        assert(t === null || t.isMutable());
    } else if (type.isWild()) {
        type.getMcache();
        if (type.isShared())
            t = type.mcache!.sto; // shared wild => shared
        else
            t = type.mcache!.wto; // wild => naked
        assert(t === null || t.isMutable());
    }
    if (t === null) {
        t = makeMutable(type);
        t = merge(t);
        fixTo(t, type);
    } else
        t = merge(t);
    assert(t.isMutable());
    return t;
}

export function sharedOf(type: Type): Type {
    //printf("Type::sharedOf() %p, %s\n", type, type.toChars());
    if (type.mod === MODFlags.shared_)
        return type;
    if (type.mcache !== null && type.mcache.sto !== null) {
        assert(type.mcache.sto.mod === MODFlags.shared_);
        return type.mcache.sto;
    }
    let t = makeShared(type);
    t = merge(t);
    fixTo(t, type);
    //printf("\t%p\n", t);
    return t;
}

export function sharedConstOf(type: Type): Type {
    //printf("Type::sharedConstOf() %p, %s\n", type, type.toChars());
    if (type.mod === (MODFlags.shared_ | MODFlags.const_))
        return type;
    if (type.mcache !== null && type.mcache.scto !== null) {
        assert(type.mcache.scto.mod === (MODFlags.shared_ | MODFlags.const_));
        return type.mcache.scto;
    }
    let t = makeSharedConst(type);
    t = merge(t);
    fixTo(t, type);
    //printf("\t%p\n", t);
    return t;
}

/********************************
 * Make type unshared.
 *      0            => 0
 *      const        => const
 *      immutable    => immutable
 *      shared       => 0
 *      shared const => const
 *      wild         => wild
 *      wild const   => wild const
 *      shared wild  => wild
 *      shared wild const => wild const
 */
export function unSharedOf(type: Type): Type {
    //printf("Type::unSharedOf() %p, %s\n", type, type.toChars());
    let t: Type | null = type;

    if (type.isShared()) {
        type.getMcache();
        if (type.isWild()) {
            if (type.isConst())
                t = type.mcache!.wcto; // shared wild const => wild const
            else
                t = type.mcache!.wto; // shared wild => wild
        } else {
            if (type.isConst())
                t = type.mcache!.cto; // shared const => const
            else
                t = type.mcache!.sto; // shared => naked
        }
        assert(t === null || !t.isShared());
    }

    if (t === null) {
        t = type.nullAttributes();
        t.mod = type.mod & ~MODFlags.shared_;
        t = merge(t);
        fixTo(t, type);
    } else
        t = merge(t);
    assert(!t.isShared());
    return t;
}

/********************************
 * Convert to 'wild'.
 */
export function wildOf(type: Type): Type {
    //printf("Type::wildOf() %p %s\n", type, type.toChars());
    if (type.mod === MODFlags.wild)
        return type;
    if (type.mcache !== null && type.mcache.wto !== null) {
        assert(type.mcache.wto.mod === MODFlags.wild);
        return type.mcache.wto;
    }
    let t = makeWild(type);
    t = merge(t);
    fixTo(t, type);
    //printf("\t%p %s\n", t, t.toChars());
    return t;
}

export function wildConstOf(type: Type): Type {
    //printf("Type::wildConstOf() %p %s\n", type, type.toChars());
    if (type.mod === MODFlags.wildconst)
        return type;
    if (type.mcache !== null && type.mcache.wcto !== null) {
        assert(type.mcache.wcto.mod === MODFlags.wildconst);
        return type.mcache.wcto;
    }
    let t = makeWildConst(type);
    t = merge(t);
    fixTo(t, type);
    //printf("\t%p %s\n", t, t.toChars());
    return t;
}

export function sharedWildOf(type: Type): Type {
    //printf("Type::sharedWildOf() %p, %s\n", type, type.toChars());
    if (type.mod === (MODFlags.shared_ | MODFlags.wild))
        return type;
    if (type.mcache !== null && type.mcache.swto !== null) {
        assert(type.mcache.swto.mod === (MODFlags.shared_ | MODFlags.wild));
        return type.mcache.swto;
    }
    let t = makeSharedWild(type);
    t = merge(t);
    fixTo(t, type);
    //printf("\t%p %s\n", t, t.toChars());
    return t;
}

export function sharedWildConstOf(type: Type): Type {
    //printf("Type::sharedWildConstOf() %p, %s\n", type, type.toChars());
    if (type.mod === (MODFlags.shared_ | MODFlags.wildconst))
        return type;
    if (type.mcache !== null && type.mcache.swcto !== null) {
        assert(type.mcache.swcto.mod === (MODFlags.shared_ | MODFlags.wildconst));
        return type.mcache.swcto;
    }
    let t = makeSharedWildConst(type);
    t = merge(t);
    fixTo(t, type);
    //printf("\t%p %s\n", t, t.toChars());
    return t;
}

export function nakedOf(type: Type): Type {
    //printf("Type::nakedOf() %p, %s\n", type, type.toChars());
    if (type.mod === 0)
        return type;
    if (type.mcache !== null) {
        // D `with(type.mcache) { ... }` -> explicit member access on a local alias (06 §5).
        const _w = type.mcache;
        // the cache has the naked type at the "identity" position, try to find it
        if (_w.cto !== null && _w.cto.mod === 0)
            return _w.cto;
        if (_w.ito !== null && _w.ito.mod === 0)
            return _w.ito;
        if (_w.sto !== null && _w.sto.mod === 0)
            return _w.sto;
        if (_w.scto !== null && _w.scto.mod === 0)
            return _w.scto;
        if (_w.wto !== null && _w.wto.mod === 0)
            return _w.wto;
        if (_w.wcto !== null && _w.wcto.mod === 0)
            return _w.wcto;
        if (_w.swto !== null && _w.swto.mod === 0)
            return _w.swto;
        if (_w.swcto !== null && _w.swcto.mod === 0)
            return _w.swcto;
    }
    let t = type.nullAttributes();
    t.mod = 0;
    t = merge(t);
    fixTo(t, type);
    //printf("\t%p %s\n", t, t.toChars());
    return t;
}

export function unqualify(type: Type, m: number): Type {
    let t = unSharedOf(mutableOf(type));

    const tn = type.ty === TY.Tenum ? null : nextOf(type);
    if (tn !== null && tn.ty !== TY.Tfunction) {
        const utn = unqualify(tn, m);
        if (utn !== tn) {
            if (type.ty === TY.Tpointer)
                t = pointerTo(utn);
            else if (type.ty === TY.Tarray)
                t = arrayOf(utn);
            else if (type.ty === TY.Tsarray)
                t = new TypeSArray(utn, type.isTypeSArray()!.dim);  // D: `cast(TypeSArray)type`
            else if (type.ty === TY.Taarray) {
                t = new TypeAArray(utn, type.isTypeAArray()!.index); // D: `cast(TypeAArray)type`
            } else
                return assertUnreachable();

            t = merge(t);
        }
    }
    t = addMod(t, type.mod & ~m);
    return t;
}

/**************************
 * Return type with the top level of it being mutable.
 *
 * Params:
 *  t = type for which the top level mutable version is being returned
 *
 * Returns:
 *  type version with mutable top level
 */
export function toHeadMutable(t: Type): Type {
    // D `const Type t` + `cast(Type) t` — the `const` qualifier is erased (04 §8) and the
    // const-stripping cast with it, so `unqualType` is just `t`.
    const unqualType: Type = t;
    if (t.isTypeStruct() !== null || t.isTypeClass() !== null)
        return unqualType;

    if (!t.mod)
        return unqualType;
    return mutableOf(unqualType);
}

export function aliasthisOf(type: Type): Type | null {
    const ad = isAggregate(type);
    if (ad === null || ad.aliasthis === null)
        return null;

    let s: Dsymbol = ad.aliasthis.sym!;
    if (s.isAliasDeclaration() !== null)
        s = toAlias(s);

    if (s.isTupleDeclaration() !== null)
        return null;

    {
        const vd = s.isVarDeclaration();
        if (vd !== null) {
            let t = vd.type;
            if (vd.needThis())
                t = addMod(t!, type.mod);
            return t;
        }
    }
    let callable: Dsymbol | null = s.isFuncDeclaration();
    callable = callable !== null ? callable : s.isTemplateDeclaration();
    if (callable !== null) {
        // typesem.d:8852
        const fd = resolveFuncCall(Loc.initial, null, callable, null, type, new ArgumentList(), FuncResolveFlag.quiet);
        if (fd === null || fd.errors || !functionSemantic(fd))
            return Type.terror;

        let t = nextOf(fd.type!);
        if (t === null) // https://issues.dlang.org/show_bug.cgi?id=14185
            return Type.terror;
        t = substWildTo(t, type.mod === 0 ? MODFlags.mutable : type.mod);
        return t;
    }
    {
        const d = s.isDeclaration();
        if (d !== null) {
            assert(d.type !== null);
            return d.type;
        }
    }
    {
        const ed = s.isEnumDeclaration();
        if (ed !== null) {
            return ed.type;
        }
    }

    //printf("%s\n", s.kind());
    return null;
}

/************************************
 * Apply MODxxxx bits to existing type.
 */
export function castMod(type: Type, mod: MOD): Type {
    let t: Type;
    switch (mod) {
    case 0:
        t = mutableOf(unSharedOf(type));
        break;

    case MODFlags.const_:
        t = constOf(unSharedOf(type));
        break;

    case MODFlags.wild:
        t = wildOf(unSharedOf(type));
        break;

    case MODFlags.wildconst:
        t = wildConstOf(unSharedOf(type));
        break;

    case MODFlags.shared_:
        t = sharedOf(mutableOf(type));
        break;

    case MODFlags.shared_ | MODFlags.const_:
        t = sharedConstOf(type);
        break;

    case MODFlags.shared_ | MODFlags.wild:
        t = sharedWildOf(type);
        break;

    case MODFlags.shared_ | MODFlags.wildconst:
        t = sharedWildConstOf(type);
        break;

    case MODFlags.immutable_:
        t = immutableOf(type);
        break;

    default:
        return assertUnreachable();
    }
    return t;
}

export function substWildTo(type: Type, mod: number): Type {
    const tf = type.isTypeFunction();
    if (tf === null) {
        //printf("+Type.substWildTo this = %s, mod = x%x\n", toChars(), mod);
        let t: Type;

        // `goto L1;` at dmd/typesem.d:8940 skips exactly the rest of the `if (tn)` block and
        // lands on `L1:` (:8971), which every other path reaches by fall-through. The skipped
        // statements are contiguous and end the block, so the jump is reproduced structurally by
        // the `else` below — no skip flag is needed (06 §4).
        const tn = nextOf(type);
        if (tn !== null) {
            // substitution has no effect on function pointer type.
            if (type.ty === TY.Tpointer && tn.ty === TY.Tfunction) {
                t = type;
                // goto L1 (dmd/typesem.d:8940) — the `else` arm below IS the skipped region
            } else {
                t = substWildTo(tn, mod);
                if (t === tn)
                    t = type;
                else {
                    if (type.ty === TY.Tpointer)
                        t = pointerTo(t);
                    else if (type.ty === TY.Tarray)
                        t = arrayOf(t);
                    else if (type.ty === TY.Tsarray)
                        t = new TypeSArray(t, type.isTypeSArray()!.dim!.syntaxCopy());
                    else if (type.ty === TY.Taarray) {
                        t = new TypeAArray(t, substWildTo(type.isTypeAArray()!.index!, mod));
                    } else if (type.ty === TY.Tdelegate) {
                        t = new TypeDelegate(t.isTypeFunction()!);
                    } else
                        return assertUnreachable();

                    t = merge(t);
                }
            }
        } else
            t = type;

        // L1: (dmd/typesem.d:8971)
        if (type.isWild()) {
            if (mod === MODFlags.immutable_) {
                t = immutableOf(t);
            } else if (mod === MODFlags.wildconst) {
                t = wildConstOf(t);
            } else if (mod === MODFlags.wild) {
                if (type.isWildConst())
                    t = wildConstOf(t);
                else
                    t = wildOf(t);
            } else if (mod === MODFlags.const_) {
                t = constOf(t);
            } else {
                if (type.isWildConst())
                    t = constOf(t);
                else
                    t = mutableOf(t);
            }
        }
        if (type.isConst())
            t = addMod(t, MODFlags.const_);
        if (type.isShared())
            t = addMod(t, MODFlags.shared_);

        //printf("-Type.substWildTo t = %s\n", t.toChars());
        return merge(t);
    }

    if (!tf.iswild() && !(tf.mod & MODFlags.wild))
        return tf;

    // Substitude inout qualifier of function type to mutable or immutable
    // would break type system. Instead substitude inout to the most weak
    // qualifer - const.
    const m = MODFlags.const_;

    assert(tf.next !== null);
    const tret = substWildTo(tf.next!, m);
    let params: Parameters | null = tf.parameterList.parameters;
    if (tf.mod & MODFlags.wild)
        params = tf.parameterList.parameters!.copy();
    for (let i = 0; i < params!.length; i++) {
        const p = params!.opIndex(i)!;
        const t = substWildTo(p.type!, m);
        if (t === p.type)
            continue;
        if (params === tf.parameterList.parameters)
            params = tf.parameterList.parameters!.copy();
        params!.opIndexAssign(new Parameter(p.loc, p.storageClass, t, null, null, null), i);
    }
    if (tf.next === tret && params === tf.parameterList.parameters)
        return tf;

    // Similar to TypeFunction.syntaxCopy;
    const t = new TypeFunction(new ParameterList(params, tf.parameterList.varargs), tret, tf.linkage);
    t.mod = ((tf.mod & MODFlags.wild) ? (tf.mod & ~MODFlags.wild) | MODFlags.const_ : tf.mod);
    t.isNothrow = tf.isNothrow;
    t.isNogc = tf.isNogc;
    t.purity = tf.purity;
    t.isProperty = tf.isProperty;
    t.isRef = tf.isRef;
    t.isReturn = tf.isReturn;
    t.isReturnScope = tf.isReturnScope;
    t.isScopeQual = tf.isScopeQual;
    t.isReturnInferred = tf.isReturnInferred;
    t.isScopeInferred = tf.isScopeInferred;
    t.isInOutParam = false;
    t.isInOutQual = false;
    t.trust = tf.trust;
    // 03 §1 #5: `ArgumentList` is a value struct outside the §9.1 register — field store copies.
    t.inferenceArguments = tf.inferenceArguments.copy();
    t.isCtor = tf.isCtor;
    return merge(t);
}

/************************************
 * Add MODxxxx bits to existing type.
 * We're adding, not replacing, so adding const to
 * a shared type => "shared const"
 */
export function addMod(type: Type, mod: MOD): Type {
    /* Add anything to immutable, and it remains immutable
     */
    let t: Type = type;
    if (!t.isImmutable()) {
        //printf("addMod(%x) %s\n", mod, toChars());
        switch (mod) {
        case 0:
            break;

        case MODFlags.const_:
            if (type.isShared()) {
                if (type.isWild())
                    t = sharedWildConstOf(type);
                else
                    t = sharedConstOf(type);
            } else {
                if (type.isWild())
                    t = wildConstOf(type);
                else
                    t = constOf(t);
            }
            break;

        case MODFlags.wild:
            if (type.isShared()) {
                if (type.isConst())
                    t = sharedWildConstOf(type);
                else
                    t = sharedWildOf(type);
            } else {
                if (type.isConst())
                    t = wildConstOf(type);
                else
                    t = wildOf(type);
            }
            break;

        case MODFlags.wildconst:
            if (type.isShared())
                t = sharedWildConstOf(type);
            else
                t = wildConstOf(type);
            break;

        case MODFlags.shared_:
            if (type.isWild()) {
                if (type.isConst())
                    t = sharedWildConstOf(type);
                else
                    t = sharedWildOf(type);
            } else {
                if (type.isConst())
                    t = sharedConstOf(type);
                else
                    t = sharedOf(type);
            }
            break;

        case MODFlags.shared_ | MODFlags.const_:
            if (type.isWild())
                t = sharedWildConstOf(type);
            else
                t = sharedConstOf(type);
            break;

        case MODFlags.shared_ | MODFlags.wild:
            if (type.isConst())
                t = sharedWildConstOf(type);
            else
                t = sharedWildOf(type);
            break;

        case MODFlags.shared_ | MODFlags.wildconst:
            t = sharedWildConstOf(type);
            break;

        case MODFlags.immutable_:
            t = immutableOf(type);
            break;

        default:
            return assertUnreachable();
        }
    }
    return t;
}

/**
 * Check whether this type has endless `alias this` recursion.
 *
 * Params:
 *   t = type to check whether it has a recursive alias this
 * Returns:
 *   `true` if `t` has an `alias this` that can be implicitly
 *    converted back to `t` itself.
 */
// D module-private (`private bool checkAliasThisRec`, dmd/typesem.d:9171) — module-local, not
// `export`ed: its only caller is `isRecursiveAliasThis` in this same module (dmd/typesem.d:9214,
// call at :9220), and no sibling module or test reaches it (verified by tree-wide grep).
function checkAliasThisRec(t: Type): boolean {
    const tb = toBasetype(t);
    // D `AliasThisRec* pflag = &(cast(TypeStruct)tb).att | &(cast(TypeClass)tb).att;` — a pointer
    // to a FIELD SLOT that is read AND written. §9-D6: an accessor pair over the selected field.
    let getPflag!: () => AliasThisRec;
    let setPflag!: (v: AliasThisRec) => void;
    if (tb.ty === TY.Tstruct) {
        const ts = tb.isTypeStruct()!;
        getPflag = () => ts.att; setPflag = (v) => { ts.att = v; };
    } else if (tb.ty === TY.Tclass) {
        const tc = tb.isTypeClass()!;
        getPflag = () => tc.att; setPflag = (v) => { tc.att = v; };
    } else
        return false;

    let flag: AliasThisRec = (getPflag() & AliasThisRec.typeMask) as AliasThisRec;
    if (flag === AliasThisRec.fwdref) {
        const att = aliasthisOf(t);
        flag = (att !== null && implicitConvToType(att, t) !== MATCH.nomatch) ? AliasThisRec.yes : AliasThisRec.no;
    }
    setPflag((flag | (getPflag() & ~AliasThisRec.typeMask)) as AliasThisRec);
    return flag === AliasThisRec.yes;
}

/**************************************
 * Check and set 'att' if 't' is a recursive 'alias this' type
 *
 * The goal is to prevent endless loops when there is a cycle in the alias this chain.
 * Since there is no multiple `alias this`, the chain either ends in a leaf,
 * or it loops back on itself as some point.
 *
 * Example: S0 -> (S1 -> S2 -> S3 -> S1)
 *
 * `S0` is not a recursive alias this, so this returns `false`, and a rewrite to `S1` can be tried.
 * `S1` is a recursive alias this type, but since `att` is initialized to `null`,
 * this still returns `false`, but `att1` is set to `S1`.
 * A rewrite to `S2` and `S3` can be tried, but when we want to try a rewrite to `S1` again,
 * we notice `att == t`, so we're back at the start of the loop, and this returns `true`.
 *
 * Params:
 *   att = type reference used to detect recursion. Should be initialized to `null`.
 *   t   = type of 'alias this' rewrite to attempt
 *
 * Returns:
 *   `false` if the rewrite is safe, `true` if it would loop back around
 *
 * `ref Type att` is an ALIAS the callee writes through -> the one-slot box (03 §3.3 / §7.2).
 */
export function isRecursiveAliasThis(att: Ref<Type | null>, t: Type): boolean {
    //printf("+isRecursiveAliasThis(att = %s, t = %s)\n", att ? att.toChars() : "null", t.toChars());
    const tb = toBasetype(t);
    if (att.value !== null && equivalent(tb, att.value))
        return true;
    if (att.value === null && checkAliasThisRec(tb))
        att.value = tb;
    return false;
}

// §9-D5 Form-B rename: D's two same-arity `implicitConvToWithoutAliasThis` overloads differ only
// in their first parameter's type, so each takes the receiver-type suffix. Callers live in dcast.d.
export function implicitConvToWithoutAliasThisStruct(from: TypeStruct, to: Type): MATCH {
    //printf("TypeStruct::implicitConvToWithoutAliasThis(%s => %s)\n", toChars(), to.toChars());

    const tos = to.isTypeStruct();
    if (!(tos !== null && from.sym === tos.sym))
        return MATCH.nomatch;

    if (from.mod === to.mod)
        return MATCH.exact;

    if (MODimplicitConv(from.mod, to.mod))
        return MATCH.constant;

    /* Check all the fields. If they can all be converted,
     * allow the conversion.
     */
    if (sizeDsymbol(from.sym!, Loc.initial) === SIZE_INVALID)
        return MATCH.nomatch;
    let m: MATCH = MATCH.constant;
    let offset = 0xFFFFFFFF; // must never match a field offset  (D `uint offset = ~0`)
    for (const v of from.sym!.fields.opSlice()) {
        /* Why are we only looking at the first member of a union?
         * The check should check for overlap of v with the previous field,
         * not just starting at the same point
         */
        if (!global.params.fixImmutableConv && v!.offset === offset) // v is at same offset as previous field
            continue;       // ignore

        const tvf = addMod(v!.type!, from.mod);    // from type
        const tvt = addMod(v!.type!, to.mod);      // to type

        // field match
        const mf = implicitConvToType(tvf, tvt);
        //printf("\t%s => %s, match = %d\n", v.type.toChars(), tvt.toChars(), mf);

        if (mf === MATCH.nomatch)
            return MATCH.nomatch;
        if (mf < m) // if field match is worse
            m = mf;
        offset = v!.offset;
    }
    return m;
}

export function implicitConvToWithoutAliasThisClass(from: TypeClass, to: Type): MATCH {
    const cdto = to.isClassHandle();
    const m = constConv(from, to);
    if (m > MATCH.nomatch)
        return m;

    if (cdto !== null && cdto.isBaseOf(from.sym, null) && MODimplicitConv(from.mod, to.mod)) {
        //printf("'to' is base\n");
        return MATCH.convert;
    }
    return MATCH.nomatch;
}

export function implicitConvToThroughAliasThisClass(from: TypeClass, to: Type): MATCH {
    // D `MATCH m;` default-initializes to the enum's FIRST member (09 §1.0) — MATCH.nomatch.
    let m: MATCH = MATCH.nomatch;
    if (from.sym!.aliasthis !== null && !(from.att & AliasThisRec.tracing)) {
        const ato = aliasthisOf(from);
        if (ato !== null) {
            from.att = (from.att | AliasThisRec.tracing) as AliasThisRec;
            m = implicitConvToType(ato, to);
            from.att = (from.att & ~AliasThisRec.tracing) as AliasThisRec;
        }
    }
    return m;
}

export function implicitConvToThroughAliasThisStruct(from: TypeStruct, to: Type): MATCH {
    const tos = to.isTypeStruct();
    if (!(tos !== null && from.sym === tos.sym) &&
        from.sym!.aliasthis !== null &&
        !(from.att & AliasThisRec.tracing)) {
        const ato = aliasthisOf(from);
        if (ato !== null) {
            from.att = (from.att | AliasThisRec.tracing) as AliasThisRec;
            const m = implicitConvToType(ato, to);
            from.att = (from.att & ~AliasThisRec.tracing) as AliasThisRec;
            return m;
        }
    }
    return MATCH.nomatch;
}

/*******************************************
 * Compute number of elements for a (possibly multidimensional) static array,
 * or 1 for other types.
 * Params:
 *  t = static array type
 *  loc = for error message
 * Returns:
 *  number of elements, uint.max on overflow
 */
export function numberOfElems(t: Type, loc: Loc): number {
    //printf("Type::numberOfElems()\n");
    let n = 1n;                 // D `uinteger_t n = 1;` — bigint domain (09 §1)
    let tb: Type = t;
    for (;;) {
        tb = toBasetype(tb);
        if (tb.ty !== TY.Tsarray)
            break;
        const overflow: Ref<boolean> = { value: false };
        n = mulu(n, toUInteger(tb.isTypeSArray()!.dim!), overflow);   // D: `(cast(TypeSArray)tb)`
        if (overflow.value || n >= 0xFFFFFFFFn) {
            error(loc, ds("static array `%s` size overflowed to %llu"), t.toChars(), n);
            return 0xFFFFFFFF;      // D `uint.max`
        }
        tb = tb.isTypeSArray()!.next!;
    }
    // D `cast(uint)n`: the loop above returns early unless `n < uint.max`, so the narrowing is
    // exact — no bigint-domain sentinel crosses here (09 §1.3.1).
    return Number(n);
}

export function checkRetType(tf: TypeFunction, loc: Loc): boolean {
    const tb = toBasetype(tf.next!);
    if (tb.ty === TY.Tfunction) {
        error(loc, ds("functions cannot return a function"));
        tf.next = Type.terror;
    }
    if (tb.ty === TY.Ttuple) {
        error(loc, ds("functions cannot return a sequence (use `std.typecons.Tuple`)"));
        tf.next = Type.terror;
    }
    if (!tf.isRef && (tb.ty === TY.Tstruct || tb.ty === TY.Tsarray)) {
        const ts = baseElemOf(tb).isTypeStruct();
        if (ts !== null) {
            if (ts.sym!.members === null) {
                error(loc, ds("functions cannot return opaque type `%s` by value"), tb.toChars());
                tf.next = Type.terror;
            }
        }
    }
    if (tb.ty === TY.Terror)
        return true;
    return false;
}

/// Returns: whether `t` is a struct/class/enum without a body
export function isOpaqueType(t: Type): boolean {
    {
        const te = t.isTypeEnum();
        if (te !== null)
            return te.sym!.members === null;
    }
    {
        const ts = t.isTypeStruct();
        if (ts !== null)
            return ts.sym!.members === null;
    }
    {
        const tc = t.isTypeClass();
        if (tc !== null)
            return tc.sym!.members === null;
    }
    return false;
}

/******************************* Private *****************************************/

// ---- D `private:` (dmd/typesem.d:9392): the declarations below are module-private ----
// (preamble §M7). D module-private is NOT TS `private` (01 Rule 2.5); they are emitted as
// ordinary EXPORTED free functions because chunks 1 and 2 call them across the stitched file
// and mtype.ts's carried `stripDefaultArgs` is un-picked against `stripDefaultArgs` here.

/**************************
 * This evaluates exp while setting length to be the number
 * of elements in the tuple t.
 */
export function semanticLength(sc: Scope, t: Type, exp: Expression): Expression {
    // D reassigns the `sc` parameter (push/startCTFE/endCTFE); TS lets the parameter itself be
    // reassigned, exactly as D does.
    const tt = t.isTypeTuple();
    if (tt !== null) {
        // D `new ArrayScopeSymbol(sc, tt)` — the TypeTuple ctor of the Form-B overload set
        // (04 §1B; the port's named factory).
        const sym: ScopeDsymbol = ArrayScopeSymbol.fromTypeTuple(sc, tt);
        sym.parent = sc.scopesym;
        sc = sc.push(sym);
        sc = sc.startCTFE();
        exp = expressionSemantic(exp, sc);
        exp = resolveProperties(sc, exp);
        // The `!` is a NARROWING artifact, not a D fault site: `endCTFE()`/`pop()` return the
        // scope the matching push came from, which is non-null here.
        sc = sc.endCTFE()!;
        sc.pop();
    } else {
        sc = sc.startCTFE();
        exp = expressionSemantic(exp, sc);
        exp = resolveProperties(sc, exp);
        sc = sc.endCTFE()!;
    }
    return exp;
}

// §9-D5 Form-B rename: same arity as `semanticLength(Scope*, Type, Expression)`, second parameter
// type differs -> the `TupleDecl` suffix (04 §1B).
export function semanticLengthTupleDecl(sc: Scope, tup: TupleDeclaration, exp: Expression): Expression {
    // D `new ArrayScopeSymbol(sc, tup)` — the TupleDeclaration ctor of the Form-B overload set.
    const sym: ScopeDsymbol = ArrayScopeSymbol.fromTupleDeclaration(sc, tup);
    sym.parent = sc.scopesym;

    sc = sc.push(sym);
    sc = sc.startCTFE();
    exp = expressionSemantic(exp, sc);
    exp = resolveProperties(sc, exp);
    sc = sc.endCTFE()!;
    sc.pop();

    return exp;
}

/************************************
 * Transitively search a type for all function types.
 * If any function types with parameters are found that have parameter identifiers
 * or default arguments, remove those and create a new type stripped of those.
 * This is used to determine the "canonical" version of a type which is useful for
 * comparisons.
 * Params:
 *      t = type to scan
 * Returns:
 *      `t` if no parameter identifiers or default arguments found, otherwise a new type that is
 *      the same as t but with no parameter identifiers or default arguments.
 */
export function stripDefaultArgs(t: Type | null): Type | null {
    const stripParams = (parameters: Parameters | null): Parameters | null => {
        const stripParameter = (p: Parameter): Parameter | null => {
            const t = stripDefaultArgs(p.type);
            return (t !== p.type || p.defaultArg !== null || p.ident !== null || p.userAttribDecl !== null)
                ? new Parameter(p.loc, p.storageClass, t, null, null, null)
                : null;
        };

        // dmd/typesem.d:9460 — `if (parameters)`: slice/container pointer truthiness (06 §2.8).
        if (parameters !== null) {
            for (const [i, p] of parameters.opSlice().entries()) {
                const ps = stripParameter(p!);
                if (ps !== null) {
                    // Replace params with a copy we can modify
                    const nparams: Parameters = new DArray<Parameter | null>(parameters.length);

                    for (let j = 0; j < nparams.length; j++) {
                        const pj = parameters.opIndex(j)!;
                        if (j < i)
                            nparams.opIndexAssign(pj, j);
                        else if (j === i)
                            nparams.opIndexAssign(ps, j);
                        else {
                            const nps = stripParameter(pj);
                            nparams.opIndexAssign(nps !== null ? nps : pj, j);
                        }
                    }
                    return nparams;
                }
            }
        }
        return parameters;
    };

    if (t === null)
        return t;

    const tfIn = t.isTypeFunction();
    if (tfIn !== null) {
        const tret = stripDefaultArgs(tfIn.next);
        const params = stripParams(tfIn.parameterList.parameters);
        if (tret === tfIn.next && params === tfIn.parameterList.parameters)
            return t;
        const tr = t.copy().isTypeFunction()!;
        tr.parameterList.parameters = params;
        tr.next = tret;
        //printf("strip %s\n   <- %s\n", tr.toChars(), t.toChars());
        return tr;
    } else {
        const ttIn = t.isTypeTuple();
        if (ttIn !== null) {
            const args = stripParams(ttIn.arguments);
            if (args === ttIn.arguments)
                return t;
            const tr = t.copy().isTypeTuple()!;
            tr.arguments = args;
            return tr;
        } else if (t.ty === TY.Tenum) {
            // TypeEnum::nextOf() may be != NULL, but it's not necessary here.
            return t;
        } else {
            const tn = nextOf(t);
            const n = stripDefaultArgs(tn);
            if (n === tn)
                return t;
            // D: `TypeNext tr = cast(TypeNext)t.copy();` — rendered through typesem.d:604's own
            // `isTypeNext` accessor so no narrowing assertion is needed. Reaching here proves
            // `nextOf(t) !is null` and the arms above already excluded Tfunction/Ttuple/Tenum.
            const tr = isTypeNext(t.copy())!;
            tr.next = n;
            return tr;
        }
    }
}

/******************************
 * Get the value of the .max/.min property of `ed` as an Expression.
 * Lazily computes the value and caches it in maxval/minval.
 * Reports any errors.
 * Params:
 *      ed = the EnumDeclaration being examined
 *      loc = location to use for error messages
 *      id = Id::max or Id::min
 * Returns:
 *      corresponding value of .max/.min
 */
export function getMaxMinValue(ed: EnumDeclaration, loc: Loc, id: Identifier): Expression | null {
    //printf("EnumDeclaration::getMaxValue()\n");

    const pvalToResult = (e: Expression, loc: Loc): Expression => {
        if (e.op !== EXP.error) {
            e = e.copy();
            e.loc = loc;
        }
        return e;
    };

    // D `Expression* pval = (id == Id.max) ? &ed.maxval : &ed.minval;` — a pointer to a FIELD SLOT
    // that is both read and WRITTEN. §9-D6: the accessor pair, chosen once exactly as D chooses
    // the pointer once.
    const getPval = (): Expression | null => id === Id.max ? ed.maxval : ed.minval;
    const setPval = (e: Expression | null): void => { if (id === Id.max) ed.maxval = e; else ed.minval = e; };

    const errorReturn = (): Expression | null => {
        setPval(ErrorExp.get());
        return getPval();
    };

    if (ed.inuse) {
        error(loc, ds("%s `%s` recursive definition of `.%s` property"), ed.kind(), ed.toPrettyChars(), id.toChars());
        return errorReturn();
    }
    if (getPval() !== null)
        return pvalToResult(getPval()!, loc);

    if (ed._scope !== null)
        dsymbolSemantic(ed, ed._scope);
    if (ed.errors)
        return errorReturn();
    if (ed.members === null) {
        error(loc, ds("%s `%s` is opaque and has no `.%s`"), ed.kind(), ed.toPrettyChars(), id.toChars(), id.toChars());
        return errorReturn();
    }
    if (!(ed.memtype !== null && isIntegral(ed.memtype))) {
        error(loc, ds("%s `%s` has no `.%s` property because base type `%s` is not an integral type"),
              ed.kind(), ed.toPrettyChars(), id.toChars(),
              id.toChars(), ed.memtype !== null ? ed.memtype.toChars() : ds(""));
        return errorReturn();
    }

    let first = true;
    for (let i = 0; i < ed.members.length; i++) {
        const em = ed.members.opIndex(i)!.isEnumMember();
        if (em === null)
            continue;
        if (em.errors) {
            ed.errors = true;
            continue;
        }

        if (em.semanticRun < PASS.semanticdone) {
            error(em.loc, ds("%s `%s` is forward referenced looking for `.%s`"),
                  em.kind(), em.toPrettyChars(), id.toChars());
            ed.errors = true;
            continue;
        }

        if (first) {
            setPval(em.value);
            first = false;
        } else {
            /* In order to work successfully with UDTs,
             * build expressions to do the comparisons,
             * and let the semantic analyzer and constant
             * folder give us the result.
             */

            /* Compute:
             *   if (e > maxval)
             *      maxval = e;
             */
            const e = em.value!;
            let ec: Expression = new CmpExp(id === Id.max ? EXP.greaterThan : EXP.lessThan, em.loc, e, getPval());
            ed.inuse = true;
            ec = expressionSemantic(ec, em._scope!);
            ed.inuse = false;
            ec = ctfeInterpret(ec);     // dmd/typesem.d:9628
            if (ec.op === EXP.error) {
                ed.errors = true;
                continue;
            }
            // dmd/typesem.d:9634 — `if (ec.toInteger())`: bigint domain (09 §9).
            if (toInteger(ec) !== 0n)
                setPval(e);
        }
    }
    return ed.errors ? errorReturn() : pvalToResult(getPval()!, loc);
}

/******************************************
 * Compile the MixinType, returning the type or expression AST.
 *
 * Doesn't run semantic() on the returned object.
 * Params:
 *      tm = mixin to compile as a type or expression
 *      loc = location for error messages
 *      sc = context
 * Return:
 *      null if error, else RootObject AST as parsed
 */
export function compileTypeMixin(tm: TypeMixin, loc: Loc, sc: Scope): RootObject | null {
    const buf = new OutBuffer();
    // dmd/typesem.d:9655 — D's `ref OutBuffer buf` is `buf` itself (a class reference IS the
    // alias, 03 §7.2).
    if (expressionsToString(buf, sc, tm.exps, tm.loc, null, true))
        return null;

    const errors = global.errors;
    const len = buf.length();
    buf.writeByte(0);
    // 08 §13a.2 — `extractSlice()` CONSUMES the buffer (D's own `buf.extractSlice()`), then the
    // `[0 .. len]` slice drops the NUL just written.
    const str = dsSlice(buf.extractSlice(), 0, len);
    const doUnittests = global.params.parsingUnittestsRequired();
    // 13 §3 — `Parser!ASTCodegen` monomorphizes to the concrete `Parser`. D's 6-argument overload
    // is the port's 7-parameter ctor with the leading `loc` absent (04 §1A) -> `null`.
    // `&global.compileEnv` is a pointer to a value struct = the object itself (03 §7.2).
    const p = new Parser(null, sc._module, str, false, global.errorSink!, global.compileEnv, doUnittests);
    // dmd/typesem.d:9664 — D's `*p.baseLoc` deref of the Lexer-set `BaseLoc*`.
    adjustLocForMixin(str, loc, p.baseLoc!, global.params.mixinOut);
    p.linnum = p.baseLoc!.startLine;    // `baseLoc` is set by the Lexer ctor the Parser ran
    p.nextToken();
    //printf("p.loc.linnum = %d\n", p.loc.linnum);

    const o = p.parseTypeOrAssignExp(TOK.endOfFile);
    if (errors !== global.errors) {
        assert(global.errors !== errors); // should have caught all these cases
        return null;
    }
    if (p.token.value !== TOK.endOfFile) {
        error(loc, ds("unexpected token `%s` after type `%s`"),
            p.token.toChars(), o.toChars());
        // D passes `str.ptr` (the C-string view of the NUL-terminated buffer); `str` is the same
        // bytes without the terminator, which `%s` renders identically (02 §11.2).
        errorSupplemental(loc, ds("while parsing string mixin type `%s`"),
            str);
        return null;
    }

    return o;
}
