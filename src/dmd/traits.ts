// Ported from dmd/traits.d (module dmd.traits).
//
// Handle introspection functionality of the `__traits()` construct
// (https://dlang.org/spec/traits.html).
//
// ---------------------------------------------------------------------------------------------
// TRANSLATION NOTES
// ---------------------------------------------------------------------------------------------
// * DECLARATION MANIFEST (traits.d, 2508 lines), in D order:
//     `LOGSEMANTIC` (:57)            resolved false (07 §3); its one `static if` is dropped.
//     `getDsymbolWithoutExpCtx` (:81) translated, module-private.
//     `getTypePointerBitmap` (:105)  translated, exported (the `mixin VisitType!void` at :255 is
//                                    expanded per 13 §7.5 into a full dispatch switch).
//     `pointerBitmap` (:293)         translated, module-private.
//     `semanticTraits` (:322)        translated, exported: every `__traits(ident)` arm in D order,
//                                    including the `version (IN_LLVM)` hook call (:2069-2076).
//     `isSame` (:2279)               translated, module-private.
//     `traitNotFound` (:2410)        translated, module-private, with its speller table.
//   traits.d has no `unittest` block (10 §1.6b); traits.test.ts pins behaviour against ldc2.
// * UFCS (04 §6): `t.isIntegral()`, `ex.ctfeInterpret()`, `s.dsymbolSemantic(sc)`, `sc.setUnsafe(…)`
//   and the like are D free functions; each call site names the free function with the receiver
//   first. Where D reaches a same-named function of a DIFFERENT module (`size(Type)` from typesem vs
//   `size(Dsymbol)` from dsymbolsem, the two `trySemantic`s), the import names the one D resolves to.
// * `out`/`ref` parameters are one-slot boxes (03 §3.2): `toTypeFunction`'s `out FuncDeclaration fdp`
//   and `resolve`'s three `out` slots.

// IMPORT ORDER (01 §4.8): AST-node modules first, then the `*sem` modules.
import { Expression, ArrayLiteralExp, DotExp, DotIdExp, DotTemplateExp, DotVarExp, DsymbolExp, ErrorExp,
    IdentifierExp, IntegerExp, ScopeExp, StringExp, TemplateExp, TupleExp, TypeExp, VarExp, WANTvalue,
    getFuncTemplateDecl, typeDotIdExp } from "./expression.js";
import type { TraitsExp } from "./expression.js";
import { Array, toStringObjects } from "./root/array.js";
import type { Expressions, Identifiers, Objects } from "./arraytypes.js";
import { LINK, MODFlags, STC, Sizeok, TY, VarArg } from "./astenums.js";
import { ClassKind } from "./aggregate.js";
import type { AggregateDeclaration } from "./aggregate.js";
import type { CPPNamespaceDeclaration, UserAttributeDeclaration } from "./attrib.js";
import type { ClassDeclaration, InterfaceDeclaration } from "./dclass.js";
import { SymbolDeclaration } from "./declaration.js";
import type { Declaration } from "./declaration.js";
import type { Package } from "./dmodule.js";
import type { Scope } from "./dscope.js";
import { PASS, foreachDsymbol } from "./dsymbol.js";
import type { Dsymbol } from "./dsymbol.js";
import { getType, isDsymbol, isError, isExpression, isParameter, isType } from "./dtemplate.js";
import { deprecation, deprecationSupplemental, error, errorSupplemental } from "./errors.js";
import type { ErrorSink } from "./errorsink.js";
import { FuncAliasDeclaration } from "./func.js";
import type { FuncDeclaration, FuncLiteralDeclaration, UnitTestDeclaration } from "./func.js";
import { global } from "./globals.js";
import { linkageToChars, visibilityToString } from "./hdrgen.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { decoToType } from "./mangle/index.js";
import { Parameter, SIZE_INVALID, TRUSTformat, Type, attributesApply, modifiersApply } from "./mtype.js";
import type { ParameterList, TypeAArray, TypeBasic, TypeClass, TypeDArray, TypeDelegate, TypeEnum, TypeError,
    TypeFunction, TypeNoreturn, TypeNull, TypePointer, TypeReference, TypeSArray, TypeStruct, TypeTuple,
    TypeVector } from "./mtype.js";
import { checkGC } from "./nogc.js";
import { optimize } from "./optimize.js";
import { speller } from "./root/speller.js";
import { StringTable } from "./root/stringtable.js";
import { toDString } from "./root/string.js";
import type { RootObject } from "./rootobject.js";
import { target } from "./target.js";
import { EXP } from "./tokens.js";
import { symbolIsVisible } from "./access.js";
import { getAttributes } from "./attribsem.js";
import { canThrow } from "./canthrow.js";
import { ctfeInterpret } from "./dinterpret.js";
import { _foreach, dsymbolSemantic, include, isAbstract, isPOD, search, sizeDsymbol, toAlias } from "./dsymbolsem.js";
import {
    equals, expressionSemantic, getDsymbol, resolveIsPackage, resolvePropertiesOnly, semanticString, symbolToExp,
    toBool, toInteger, toStringExp, toUInteger, toUTF8, trySemantic,
} from "./expressionsem.js";
import { functionSemantic3, isVirtual, isVirtualMethod, overloadApply } from "./funcsem.js";
import { setUnsafe } from "./safe.js";
import { TemplateInstance_semanticTiargs, TemplateInstanceTable } from "./templatesem.js";
import {
    baseElemOf, constOf, arrayOf, hasPointers, isAggregate, isComplex, isCopyable, isFloating, isImaginary, isIntegral,
    isScalar, isUnsigned, isZeroInit, nextOf, resolve, sarrayOf, size, toBasetype, typeSemantic,
} from "./typesem.js";
import { assert, assertUnreachable } from "../assert.js";
import { ds, type DString } from "../dstring.js";
import type { Ref } from "./root/speller.js";
import { semanticTraitsHook } from "./hooks.js";
// last (01 §4.8): a value import into the core SCC (lambdacomp.ts imports visitor, hdrgen, mangle, the sem modules).
import { isSameFuncLiteral } from "./lambdacomp.js";

// resolved: `enum LOGSEMANTIC = false;` (traits.d:57) — its one `static if (LOGSEMANTIC)` printf
// (traits.d:324-327) is dropped (07 §3).

/************************ TraitsExp ************************************/

/**
 * dmd/traits.d:81 — Convert `Expression` or `Type` to corresponding `Dsymbol`, additionally
 * stripping off expression contexts.
 *
 * Some symbol related `__traits` ignore arguments expression contexts. For example:
 *     struct S { void f() {} }
 *     S s;
 *     pragma(msg, __traits(isNested, s.f));
 *     // s.f is `DotVarExp`, but `__traits(isNested)`` needs a `FuncDeclaration`.
 *
 * This is used for that common `__traits` behavior.
 */
function getDsymbolWithoutExpCtx(oarg: RootObject | null): Dsymbol | null {
    const e = isExpression(oarg);
    if (e !== null) {
        const dve = e.isDotVarExp();
        if (dve !== null)
            return dve.var_;
        const dte = e.isDotTemplateExp();
        if (dte !== null)
            return dte.td;
    }
    return getDsymbol(oarg);
}

/**
 * dmd/traits.d:105 — Fill an array of target size_t values that indicate possible pointer words in
 * memory if interpreted as the type given as argument. One bit in the array per pointer-sized piece
 * of memory.
 *
 * Params:
 *      loc = location for error messages
 *      t = type to generate pointer bitmap from
 *      data = array forming the bitmap (D `ref Array!(ulong)`: the caller's container, resized and
 *             zero-filled here)
 *      eSink = error message sink
 * Returns:
 *      size of the type `t` in bytes, `ulong.max` on error (the `bigint` 2^64-1)
 */
export function getTypePointerBitmap(loc: Loc, t: Type, data: Array<bigint>, eSink: ErrorSink): bigint {
    const ULONG_MAX = 0xFFFF_FFFF_FFFF_FFFFn;
    const tc = t.isTypeClass();
    // D: `tc.sym.AggregateDeclaration.size(loc)` — the dsymbolsem `size(Dsymbol, Loc)`, called
    // non-virtually on the AggregateDeclaration base; `sizeDsymbol` is that function (04 §1B).
    const sz: bigint = (tc !== null && tc.sym!.isInterfaceDeclaration() === null)
        ? sizeDsymbol(tc.sym!, loc)
        : size(t, loc);
    if (sz === SIZE_INVALID)
        return ULONG_MAX;

    const sz_size_t: bigint = size(Type.tsize_t, loc); // size of target's size_t
    assert(sz_size_t <= 8n); // `ulong.sizeof`
    if (sz > ULONG_MAX - sz_size_t) {
        eSink.error(loc, ds("size overflow for type `%s`"), t.toChars());
        return ULONG_MAX;
    }

    const bitsPerElement: bigint = sz_size_t * 8n;  // bits used in each array element
    const cntptr: bigint = (sz + sz_size_t - 1n) / sz_size_t; // pointers have same size as sz_size_t
    const length: bigint = (cntptr + bitsPerElement - 1n) / bitsPerElement; // a bit per pointer

    data.setDim(Number(length)); // `cast(size_t)length`: a word count, far below 2^53
    // `data.zero()` (traits.d:127): every slot is read back below through `|=`, so the zero fill is a
    // default-dependence (08 §2.0a), special-cased at the one known element type, `ulong`.
    for (let i = 0; i < data.length; i++)
        data.opIndexAssign(0n, i);

    let offset = 0n;
    let error_ = false;    // sticky error indicator (D `error`; renamed off the imported `error`)

    const visit = (t: Type): void => {
        const setpointer = (off: bigint): void => {
            const ptroff: bigint = off / sz_size_t;
            const idx = Number(ptroff / bitsPerElement);
            data.opIndexAssign((data.opIndex(idx) | (1n << (ptroff % bitsPerElement))) & ULONG_MAX, idx);
        };

        const visitType = (t: Type): void => {
            const tb = toBasetype(t);
            if (tb !== t)
                visit(tb);
        };

        const visitError = (t: TypeError): void => {
            visitType(t);
        };

        const visitBasic = (t: TypeBasic): void => {
            if (t.ty === TY.Tvoid)
                setpointer(offset);
        };

        const visitVector = (_t: TypeVector): void => {
        };

        const visitSArray = (t: TypeSArray): void => {
            const arrayoff = offset;
            const nextsize: bigint = size(t.next!);
            if (nextsize === SIZE_INVALID)
                error_ = true;
            if (hasPointers(t)) {
                const dim: bigint = toInteger(t.dim!);
                for (let i = 0n; i < dim; i++) {
                    offset = (arrayoff + i * nextsize) & ULONG_MAX;
                    visit(t.next!);
                }
            }
            offset = arrayoff;
        };

        const visitDArray = (_t: TypeDArray): void => {
            setpointer(offset + sz_size_t);
        };

        // dynamic array is {length,ptr}
        const visitAArray = (_t: TypeAArray): void => {
            setpointer(offset);
        };

        const visitPointer = (t: TypePointer): void => {
            if (nextOf(t)!.ty !== TY.Tfunction) // don't mark function pointers
                setpointer(offset);
        };

        const visitReference = (_t: TypeReference): void => {
            setpointer(offset);
        };

        const visitClass = (_t: TypeClass): void => {
            setpointer(offset);
        };

        const visitFunction = (_t: TypeFunction): void => {
        };

        const visitDelegate = (_t: TypeDelegate): void => {
            setpointer(offset);
        };

        const visitEnum = (t: TypeEnum): void => {
            visitType(t);
        };

        const visitTuple = (t: TypeTuple): void => {
            visitType(t);
        };

        const visitNull = (_t: TypeNull): void => {
            // always a null pointer
        };

        const visitNoreturn = (_t: TypeNoreturn): void => {
        };

        const visitStruct = (t: TypeStruct): void => {
            const structoff = offset;
            for (const v of t.sym!.fields) {
                offset = structoff + BigInt(v!.offset);
                if (v!.type!.ty === TY.Tclass)
                    setpointer(offset);
                else
                    visit(v!.type!);
            }
            offset = structoff;
        };

        const visitDefaultCase = (_t: Type): void => {
            //printf("ty = %d\n", t.ty);
            assertUnreachable(); // D `assert(0)`
        };

        // resolved: `mixin VisitType!void visit; visit.VisitType(t);` (traits.d:255-256, mtype.d:2817)
        // expanded in full (13 §7.5): a TY with a `visitX` handler calls it; the others take
        // `visitDefaultCase`; `Tnone` is the mixin's own `assert(0)`.
        switch (t.ty) {
            case TY.Tvoid:
            case TY.Tint8:
            case TY.Tuns8:
            case TY.Tint16:
            case TY.Tuns16:
            case TY.Tint32:
            case TY.Tuns32:
            case TY.Tint64:
            case TY.Tuns64:
            case TY.Tfloat32:
            case TY.Tfloat64:
            case TY.Tfloat80:
            case TY.Timaginary32:
            case TY.Timaginary64:
            case TY.Timaginary80:
            case TY.Tcomplex32:
            case TY.Tcomplex64:
            case TY.Tcomplex80:
            case TY.Tbool:
            case TY.Tchar:
            case TY.Twchar:
            case TY.Tdchar:
            case TY.Tint128:
            case TY.Tuns128:    return visitBasic(t.isTypeBasic()!);
            case TY.Tarray:     return visitDArray(t.isTypeDArray()!);
            case TY.Tsarray:    return visitSArray(t.isTypeSArray()!);
            case TY.Taarray:    return visitAArray(t.isTypeAArray()!);
            case TY.Tpointer:   return visitPointer(t.isTypePointer()!);
            case TY.Treference: return visitReference(t.isTypeReference()!);
            case TY.Tfunction:  return visitFunction(t.isTypeFunction()!);
            case TY.Tident:     return visitDefaultCase(t);
            case TY.Tclass:     return visitClass(t.isTypeClass()!);
            case TY.Tstruct:    return visitStruct(t.isTypeStruct()!);
            case TY.Tenum:      return visitEnum(t.isTypeEnum()!);
            case TY.Tdelegate:  return visitDelegate(t.isTypeDelegate()!);
            case TY.Terror:     return visitError(t.isTypeError()!);
            case TY.Tinstance:  return visitDefaultCase(t);
            case TY.Ttypeof:    return visitDefaultCase(t);
            case TY.Ttuple:     return visitTuple(t.isTypeTuple()!);
            case TY.Tslice:     return visitDefaultCase(t);
            case TY.Treturn:    return visitDefaultCase(t);
            case TY.Tnull:      return visitNull(t.isTypeNull()!);
            case TY.Tvector:    return visitVector(t.isTypeVector()!);
            case TY.Ttraits:    return visitDefaultCase(t);
            case TY.Tmixin:     return visitDefaultCase(t);
            case TY.Tnoreturn:  return visitNoreturn(t.isTypeNoreturn()!);
            case TY.Ttag:       return visitDefaultCase(t);
            case TY.Tnone:      return assertUnreachable(); // mtype.d:2870 `case TY.Tnone: assert(0);`
            default:            return assertUnreachable(); // D `final switch`: no other TY exists
        }
    };

    const tcx = t.isTypeClass();
    if (tcx !== null) {
        // a "toplevel" class is treated as an instance, while TypeClass fields are treated as references
        const visitTopLevelClass = (t: TypeClass): void => {
            const classoff = offset;
            // skip vtable-ptr and monitor
            if (t.sym!.baseClass !== null)
                visitTopLevelClass(t.sym!.baseClass.type!.isTypeClass()!);
            for (const v of t.sym!.fields) {
                offset = classoff + BigInt(v!.offset);
                visit(v!.type!);
            }
            offset = classoff;
        };

        visitTopLevelClass(tcx);
    }
    else
        visit(t);
    return error_ ? ULONG_MAX : sz;
}

/**
 * dmd/traits.d:293 — get an array of size_t values that indicate possible pointer words in memory
 * if interpreted as the type given as argument. The first array element is the size of the type for
 * independent interpretation of the array; the following elements' bits represent one word (8 bytes
 * on our target). If set, the corresponding memory might contain a pointer/reference.
 *
 *  Returns: [T.sizeof, pointerbit0-63, pointerbit64-127, ...]
 */
function pointerBitmap(e: TraitsExp, eSink: ErrorSink): Expression {
    if (e.args === null || e.args.length !== 1) {
        eSink.error(e.loc, ds("a single type expected for trait pointerBitmap"));
        return ErrorExp.get();
    }

    const t = getType(e.args.opIndex(0));
    if (t === null) {
        eSink.error(e.loc, ds("`%s` is not a type"), e.args.opIndex(0)!.toChars());
        return ErrorExp.get();
    }

    const data = new Array<bigint>();
    const sz: bigint = getTypePointerBitmap(e.loc, t, data, eSink);
    if (sz === 0xFFFF_FFFF_FFFF_FFFFn) // `ulong.max`
        return ErrorExp.get();

    const exps: Expressions = new Array<Expression | null>(data.length + 1);
    exps.opIndexAssign(new IntegerExp(e.loc, sz, Type.tsize_t), 0);       // [0] is size in bytes of t
    for (let i = 1; i < exps.length; i++)
        exps.opIndexAssign(new IntegerExp(e.loc, data.opIndex(i - 1), Type.tsize_t), i);

    const ale = new ArrayLiteralExp(e.loc, sarrayOf(Type.tsize_t, BigInt(data.length + 1)), exps);
    return ale;
}

/**
 * dmd/traits.d:322 — the semantic pass of `__traits(ident, args...)`.
 *
 * Contract: `e.ident` names the trait and `e.args` holds its unanalysed arguments (null for none).
 * Returns the analysed result expression, or `ErrorExp.get()` after reporting a diagnostic.
 * Side effects: runs template-argument semantic over `e.args` IN PLACE (a tuple argument may expand
 * the list), and whatever semantic each trait triggers on the symbols it inspects.
 * Callers: `visit(TraitsExp)` (expressionsem.d:8904) and `TypeTraits` resolution (typesem.d:6045).
 */
export function semanticTraits(e: TraitsExp, sc: Scope): Expression {
    // resolved: `static if (LOGSEMANTIC)` (traits.d:324) — dropped (07 §3).

    if (e.ident !== Id.compiles &&
        e.ident !== Id.isSame &&
        e.ident !== Id.identifier &&
        e.ident !== Id.getProtection && e.ident !== Id.getVisibility &&
        e.ident !== Id.getAttributes) {
        // Pretend we're in a deprecated scope so that deprecation messages
        // aren't triggered when checking if a symbol is deprecated
        const save = sc.stc;
        // 11 §2.5 (catch-repair-rethrow): `sc.stc` outlives this block and D restores it on two
        // normal-path exits (traits.d:344, :347); a wall throw below would skip both.
        try {
            if (e.ident === Id.isDeprecated)
                sc.stc = (sc.stc | STC.deprecated_) as STC;
            const sc2 = sc.startCTFE();
            try { // scope(exit) { sc2.endCTFE(); } (traits.d:341)
                if (!TemplateInstance_semanticTiargs(e.loc, sc2, e.args, 1)) {
                    sc.stc = save;
                    return ErrorExp.get();
                }
                sc.stc = save;
            } finally {
                sc2.endCTFE();
            }
        } catch (ex) {
            sc.stc = save;
            throw ex;
        }
    }
    const dim: number = e.args !== null ? e.args.length : 0;

    const dimError = (expected: number): Expression => {
        error(e.loc, ds("expected %d arguments for `%s` but had %d"), expected, e.ident!.toChars(), dim);
        return ErrorExp.get();
    };

    const True = (): IntegerExp => {
        return IntegerExp.createBool(true);
    };

    const False = (): IntegerExp => {
        return IntegerExp.createBool(false);
    };

    /********
     * traits.d:378 — Gets the function type from a given AST node if the node is a function of some
     * sort.
     * Params:
     *   o = an AST node to check for a `TypeFunction`
     *   fdp = if `o` is a FuncDeclaration then fdp is set to that, otherwise `null` (D `out`)
     * Returns:
     *   a type node if `o` is a declaration of a delegate, function, function-pointer or a variable
     *   of the former. Otherwise, `null`.
     */
    const toTypeFunction = (o: RootObject | null, fdp: Ref<FuncDeclaration | null>): TypeFunction | null => {
        fdp.value = null; // D `out`: default-initialised on entry (03 §3.3)
        let t: Type | null = null;
        const s = getDsymbolWithoutExpCtx(o);
        if (s !== null) {
            const fd = s.isFuncDeclaration();
            if (fd !== null) {
                t = fd.type;
                fdp.value = fd;
            }
            else {
                const vd = s.isVarDeclaration();
                if (vd !== null)
                    t = vd.type;
                else
                    t = isType(o);
            }
        }
        else
            t = isType(o);

        if (t !== null) {
            const tf = t.isFunction_Delegate_PtrToFunction();
            if (tf !== null)
                return tf;
        }

        return null;
    };

    // resolved: `IntegerExp isX(T)(bool delegate(T) fp)` (traits.d:405) with its four aliases
    // `isTypeX`/`isDsymX`/`isDeclX`/`isFuncX` (:433-436) — monomorphised, one arrow per `T`, each
    // carrying the `static if` branch that `T` selects.
    const isTypeX = (fp: (t: Type) => boolean): IntegerExp => {
        if (dim === 0)
            return False();
        for (const o of e.args!) {
            const y = getType(o);
            if (y === null || !fp(y))
                return False();
        }
        return True();
    };

    const isDsymX = (fp: (s: Dsymbol) => boolean): IntegerExp => {
        if (dim === 0)
            return False();
        for (const o of e.args!) {
            const s = getDsymbolWithoutExpCtx(o);
            if (s === null)
                return False();
            const y = s;
            if (!fp(y))
                return False();
        }
        return True();
    };

    const isDeclX = (fp: (d: Declaration) => boolean): IntegerExp => {
        if (dim === 0)
            return False();
        for (const o of e.args!) {
            const s = getDsymbolWithoutExpCtx(o);
            if (s === null)
                return False();
            const y = s.isDeclaration();
            if (y === null || !fp(y))
                return False();
        }
        return True();
    };

    const isFuncX = (fp: (f: FuncDeclaration) => boolean): IntegerExp => {
        if (dim === 0)
            return False();
        for (const o of e.args!) {
            const s = getDsymbolWithoutExpCtx(o);
            if (s === null)
                return False();
            const y = s.isFuncDeclaration();
            if (y === null || !fp(y))
                return False();
        }
        return True();
    };

    const isPkgX = (fp: (p: Package) => boolean): Expression => {
        return isDsymX((sym: Dsymbol): boolean => {
            const p = resolveIsPackage(sym);
            return (p !== null) && fp(p);
        });
    };

    if (e.ident === Id.isOverlapped) {
        if (dim !== 1)
            return dimError(1);

        return isDeclX((d: Declaration): boolean => {
            const v = d.isVarDeclaration();
            if (v === null || !v.isField())
                return false;

            // Ensure semantic analysis is complete
            const agg = v.toParent()!.isAggregateDeclaration();
            if (agg !== null) {
                if (agg.semanticRun < PASS.semanticdone)
                    dsymbolSemantic(agg, null);
            }

            return v.overlapped;
        });
    }
    if (e.ident === Id.isArithmetic) {
        return isTypeX(t => isIntegral(t) || isFloating(t));
    }
    if (e.ident === Id.isFloating) {
        return isTypeX(t => isFloating(t));
    }
    if (e.ident === Id.isIntegral) {
        return isTypeX(t => isIntegral(t));
    }
    if (e.ident === Id.isScalar) {
        return isTypeX(t => isScalar(t));
    }
    if (e.ident === Id.isUnsigned) {
        return isTypeX(t => isUnsigned(t));
    }
    if (e.ident === Id.isAssociativeArray) {
        return isTypeX(t => toBasetype(t).ty === TY.Taarray);
    }
    if (e.ident === Id.isDeprecated) {
        if (toBool(isTypeX(t => isComplex(t) || isImaginary(t))).hasValue(true))
            return True();
        return isDsymX(t => t.isDeprecated());
    }
    if (e.ident === Id.isFuture) {
        return isDeclX(t => t.isFuture());
    }
    if (e.ident === Id.isStaticArray) {
        return isTypeX(t => toBasetype(t).ty === TY.Tsarray);
    }
    if (e.ident === Id.isAbstractClass) {
        return isTypeX((t: Type): boolean => {
            const c = toBasetype(t).isTypeClass();
            return c !== null && isAbstract(c.sym!);
        });
    }
    if (e.ident === Id.isFinalClass) {
        return isTypeX((t: Type): boolean => {
            const c = toBasetype(t).isTypeClass();
            return c !== null && (c.sym!.storage_class & STC.final_) !== 0n;
        });
    }
    if (e.ident === Id.isTemplate) {
        if (dim !== 1)
            return dimError(1);

        return isDsymX((s: Dsymbol): boolean => {
            if (!toAlias(s).isOverloadable())
                return false;
            return overloadApply(s,
                sm => (sm.isTemplateDeclaration() !== null ? 1 : 0)) !== 0;
        });
    }
    if (e.ident === Id.isBitfield) {
        if (dim !== 1)
            return dimError(1);

        return isDsymX((s: Dsymbol): boolean => {
            s = toAlias(s);
            return s.isBitFieldDeclaration() !== null;
        });
    }
    if (e.ident === Id.isPOD) {
        if (dim !== 1)
            return dimError(1);

        const o = e.args!.opIndex(0);
        const t = isType(o);
        if (t === null) {
            error(e.loc, ds("type expected as second argument of __traits `%s` instead of `%s`"),
                e.ident!.toChars(), o!.toChars());
            return ErrorExp.get();
        }

        const tb = baseElemOf(t);
        const ts = tb.isTypeStruct();
        const sd = ts !== null ? ts.sym : null;
        if (sd !== null) {
            return isPOD(sd) ? True() : False();
        }
        return True();
    }
    if (e.ident === Id.hasCopyConstructor ||
        e.ident === Id.hasMoveConstructor ||
        e.ident === Id.hasPostblit) {
        if (dim !== 1)
            return dimError(1);

        const o = e.args!.opIndex(0);
        const t = isType(o);
        if (t === null) {
            error(e.loc, ds("type expected as second argument of __traits `%s` instead of `%s`"),
                e.ident!.toChars(), o!.toChars());
            return ErrorExp.get();
        }

        const tb = baseElemOf(t);
        const ts = tb.isTypeStruct();
        const sd = ts !== null ? ts.sym : null;
        if (sd !== null) {
            let result: boolean;
            if (e.ident === Id.hasPostblit)
                result = sd.postblit !== null;
            else if (e.ident === Id.hasCopyConstructor)
                result = sd.hasCopyCtor;
            else
                result = sd.hasMoveCtor;
            return result ? True() : False();
        }
        return False();
    }
    if (e.ident === Id.isCopyable) {
        if (dim !== 1)
            return dimError(1);

        const o = e.args!.opIndex(0);
        let t = isType(o);
        if (t === null) {
            error(e.loc, ds("type expected as second argument of __traits `%s` instead of `%s`"),
                e.ident!.toChars(), o!.toChars());
            return ErrorExp.get();
        }

        // get enum base or static array element type
        t = baseElemOf(t);

        const ts = t.isTypeStruct();
        if (ts !== null) {
            dsymbolSemantic(ts.sym!, sc);
        }

        return isCopyable(t) ? True() : False();
    }
    if (e.ident === Id.needsDestruction) {
        if (dim !== 1)
            return dimError(1);

        const o = e.args!.opIndex(0);
        let t = isType(o);
        if (t === null) {
            error(e.loc, ds("type expected as second argument of __traits `%s` instead of `%s`"),
                e.ident!.toChars(), o!.toChars());
            return ErrorExp.get();
        }
        // FIXME should just check t.needsDestruction() but that doesn't run dsymbolSemantic

        // T[0]
        if (size(t) === 0n)
            return False();

        // get the base in case `t` is an `enum`
        // handle static arrays
        t = baseElemOf(t);
        const ts = t.isTypeStruct();
        if (ts !== null) {
            dsymbolSemantic(ts.sym!, sc);
            if (ts.sym!.dtor !== null)
                return True();
        }
        return False();
    }

    if (e.ident === Id.isNested) {
        if (dim !== 1)
            return dimError(1);

        const o = e.args!.opIndex(0);
        const s = getDsymbolWithoutExpCtx(o);
        if (s === null) {
        }
        else {
            const ad = s.isAggregateDeclaration();
            if (ad !== null) {
                return ad.isNested() ? True() : False();
            }
            const fd = s.isFuncDeclaration();
            if (fd !== null) {
                return fd.isNested() ? True() : False();
            }
        }

        error(e.loc, ds("aggregate or function expected instead of `%s`"), o!.toChars());
        return ErrorExp.get();
    }
    if (e.ident === Id.isDisabled) {
        if (dim !== 1)
            return dimError(1);

        return isDeclX(f => f.isDisabled());
    }
    if (e.ident === Id.isAbstractFunction) {
        if (dim !== 1)
            return dimError(1);

        return isFuncX(f => f.isAbstract());
    }
    if (e.ident === Id.isVirtualFunction) {
        // @@@DEPRECATED2.121@@@
        // Deprecated in 2.101 - Can be removed from 2.121
        deprecation(e.loc, ds("`traits(isVirtualFunction)` is deprecated. Use `traits(isVirtualMethod)` instead"));

        if (dim !== 1)
            return dimError(1);

        return isFuncX(f => isVirtual(f));
    }
    if (e.ident === Id.isVirtualMethod) {
        if (dim !== 1)
            return dimError(1);

        return isFuncX(f => isVirtualMethod(f));
    }
    if (e.ident === Id.isFinalFunction) {
        if (dim !== 1)
            return dimError(1);

        return isFuncX(f => f.isFinalFunc());
    }
    if (e.ident === Id.isOverrideFunction) {
        if (dim !== 1)
            return dimError(1);

        return isFuncX(f => f.isOverride());
    }
    if (e.ident === Id.isStaticFunction) {
        if (dim !== 1)
            return dimError(1);

        return isFuncX(f => !f.needThis() && !f.isNested());
    }
    if (e.ident === Id.isModule) {
        if (dim !== 1)
            return dimError(1);

        return isPkgX(p => p.isModule() !== null || p.isPackageMod() !== null);
    }
    if (e.ident === Id.isPackage) {
        if (dim !== 1)
            return dimError(1);

        return isPkgX(p => p.isModule() === null);
    }
    if (e.ident === Id.isRef) {
        if (dim !== 1)
            return dimError(1);

        return isDeclX(d => d.isRef());
    }
    if (e.ident === Id.isOut) {
        if (dim !== 1)
            return dimError(1);

        return isDeclX(d => d.isOut());
    }
    if (e.ident === Id.isLazy) {
        if (dim !== 1)
            return dimError(1);

        return isDeclX(d => (d.storage_class & STC.lazy_) !== 0n);
    }
    if (e.ident === Id.isCOMClass) {
        if (dim !== 1)
            return dimError(1);

        const o = e.args!.opIndex(0);
        const s = getDsymbol(o);
        let agg: AggregateDeclaration | null = null;

        if (s === null || ((agg = s.isAggregateDeclaration()) === null)) {
            error(e.loc, ds("argument to `__traits(isCOMClass, %s)` is not a declaration"), o!.toChars());
            return ErrorExp.get();
        }

        const cd: ClassDeclaration | null = agg.isClassDeclaration();
        if (cd !== null)
            return cd.com ? True() : False();
        return False();
    }
    if (e.ident === Id.identifier) {
        // Get identifier for symbol as a string literal
        /* Specify 0 for bit 0 of the flags argument to semanticTiargs() so that
         * a symbol should not be folded to a constant.
         * Bit 1 means don't convert Parameter to Type if Parameter has an identifier
         */
        if (!TemplateInstance_semanticTiargs(e.loc, sc, e.args, 2))
            return ErrorExp.get();
        if (dim !== 1)
            return dimError(1);

        const o = e.args!.opIndex(0);
        let id: Identifier;
        const po = isParameter(o);
        if (po !== null) {
            if (po.ident === null) {
                error(e.loc, ds("argument `%s` has no identifier"), po.type!.toChars());
                return ErrorExp.get();
            }
            id = po.ident;
        }
        else {
            const s = getDsymbolWithoutExpCtx(o);
            if (s === null || s.ident === null) {
                error(e.loc, ds("argument `%s` has no identifier"), o!.toChars());
                return ErrorExp.get();
            }
            id = s.ident;
        }

        const se = new StringExp(e.loc, [...id.toString()]);
        return expressionSemantic(se, sc);
    }
    if (e.ident === Id.fullyQualifiedName) { // https://dlang.org/spec/traits.html#fullyQualifiedName
        if (dim !== 1)
            return dimError(1);

        const sc2 = sc.push();
        let ok: boolean;
        try { // 11 §2.5 (catch-repair-rethrow): D pops on the normal path at traits.d:829
            sc2.copyFlagsFrom(sc);
            sc2.noAccessCheck = true;
            sc2.ignoresymbolvisibility = true;
            ok = TemplateInstance_semanticTiargs(e.loc, sc2, e.args, 1);
        } catch (ex) {
            sc2.pop();
            throw ex;
        }
        sc2.pop();
        if (!ok)
            return ErrorExp.get();

        let fqn: DString | null = null;
        const o = e.args!.opIndex(0);
        const s = getDsymbolWithoutExpCtx(o);
        if (s !== null) {
            if (s.semanticRun === PASS.initial)
                dsymbolSemantic(s, null);

            fqn = toDString(s.toPrettyChars());
        }
        else {
            const t = getType(o);
            if (t !== null) {
                fqn = toDString(t.toPrettyChars(true));
            }
            else {
                if (!isError(o))
                    error(e.loc, ds("argument `%s` has no identifier"), o!.toChars());
                return ErrorExp.get();
            }
        }
        assert(fqn !== null);
        const se = new StringExp(e.loc, [...fqn!]);
        return expressionSemantic(se, sc);

    }
    if (e.ident === Id.getBitfieldOffset || e.ident === Id.getBitfieldWidth) {
        if (dim !== 1)
            return dimError(1);

        const o = e.args!.opIndex(0);
        const s = getDsymbolWithoutExpCtx(o);
        if (s === null) {
            error(e.loc, ds("bitfield symbol expected not `%s`"), o!.toChars());
            return ErrorExp.get();
        }

        const vd = toAlias(s).isVarDeclaration();
        if (vd === null || (vd.storage_class & STC.field) === 0n) {
            error(e.loc, ds("bitfield symbol expected not %s `%s`"), s.kind(), s.toPrettyChars());
            return ErrorExp.get();
        }

        let fieldWidth: number;
        let bitOffset: number;
        const bf = vd.isBitFieldDeclaration();
        if (bf !== null) {
            fieldWidth = bf.fieldWidth;
            bitOffset  = bf.bitOffset;
        }
        else { // just a regular field
            const sz: bigint = size(vd.type!);
            assert(sz < 0xFFFF_FFFFn / 8n);    // overflow check
            fieldWidth = Number(sz) * 8;       // `cast(uint)sz * 8`: bounded by the assert above
            bitOffset  = 0;
        }
        const value: number = e.ident === Id.getBitfieldOffset ? bitOffset : fieldWidth;
        return new IntegerExp(e.loc, BigInt(value), Type.tuns32);
    }
    if (e.ident === Id.getProtection || e.ident === Id.getVisibility) {
        if (dim !== 1)
            return dimError(1);

        const sc2 = sc.push();
        let ok: boolean;
        try { // 11 §2.5 (catch-repair-rethrow): D pops on the normal path at traits.d:904
            sc2.copyFlagsFrom(sc);
            sc2.noAccessCheck = true;
            sc2.ignoresymbolvisibility = true;
            ok = TemplateInstance_semanticTiargs(e.loc, sc2, e.args, 1);
        } catch (ex) {
            sc2.pop();
            throw ex;
        }
        sc2.pop();
        if (!ok)
            return ErrorExp.get();

        const o = e.args!.opIndex(0);
        const s = getDsymbolWithoutExpCtx(o);
        if (s === null) {
            if (!isError(o))
                error(e.loc, ds("argument `%s` has no visibility"), o!.toChars());
            return ErrorExp.get();
        }
        if (s.semanticRun === PASS.initial)
            dsymbolSemantic(s, null);

        const protName = visibilityToString(s.visible().kind); // TODO: How about package(names)
        assert(protName !== null);
        const se = new StringExp(e.loc, [...protName]);
        return expressionSemantic(se, sc);
    }
    if (e.ident === Id.parent) {
        if (dim !== 1)
            return dimError(1);

        const o = e.args!.opIndex(0);
        let s = getDsymbolWithoutExpCtx(o);
        if (s !== null) {
            // https://issues.dlang.org/show_bug.cgi?id=12496
            // Consider:
            // class T1
            // {
            //     class C(uint value) { }
            // }
            // __traits(parent, T1.C!2)
            const ad = s.isAggregateDeclaration();
            if (ad !== null) {  // `s` is `C`
                if (ad.isNested()) {                     // `C` is nested
                    const p = s.toParent();
                    if (p !== null) {         // `C`'s parent is `C!2`, believe it or not
                        const ti = p.isTemplateInstance();
                        if (ti !== null) {    // `C!2` is a template instance
                            s = p;                     // `C!2`'s parent is `T1`
                            const td = ti.tempdecl;
                            if (td !== null)
                                s = td;                // get the declaration context just in case there's two contexts
                        }
                    }
                }
            }

            const fd = s.isFuncDeclaration();
            if (fd !== null) // https://issues.dlang.org/show_bug.cgi?id=8943
                s = fd.toAliasFunc();
            if (s.isImport() === null) // https://issues.dlang.org/show_bug.cgi?id=8922
                s = s.toParent();
        }
        if (s === null || s.isImport() !== null) {
            error(e.loc, ds("argument `%s` has no parent"), o!.toChars());
            return ErrorExp.get();
        }

        const f = s.isFuncDeclaration();
        if (f !== null) {
            let td = getFuncTemplateDecl(f);
            if (td !== null) {
                if (td.overroot !== null) // if not start of overloaded list of TemplateDeclaration's
                    td = td.overroot; // then get the start
                let ex: Expression = new TemplateExp(e.loc, td, f);
                ex = expressionSemantic(ex, sc);
                return ex;
            }
            const fld = f.isFuncLiteralDeclaration();
            if (fld !== null) {
                // Directly translate to VarExp instead of FuncExp
                const ex: Expression = new VarExp(e.loc, fld, true);
                return expressionSemantic(ex, sc);
            }
        }
        return symbolToExp(s, e.loc, sc, false);
    }
    if (e.ident === Id.child) {
        if (dim !== 2)
            return dimError(2);

        let ex: Expression;
        const op = e.args!.opIndex(0);
        const symp = getDsymbol(op);
        if (symp !== null)
            ex = new DsymbolExp(e.loc, symp);
        else {
            const exp = isExpression(op); // D `op.isExpression()`: the same dyncast test
            if (exp !== null)
                ex = exp;
            else {
                error(e.loc,
                    ds("symbol or expression expected as first argument of __traits `child` instead of `%s`"),
                    op!.toChars());
                return ErrorExp.get();
            }
        }

        ex = expressionSemantic(ex, sc);
        const oc = e.args!.opIndex(1);
        const symc = getDsymbol(oc);
        if (symc === null) {
            error(e.loc, ds("symbol expected as second argument of __traits `child` instead of `%s`"), oc!.toChars());
            return ErrorExp.get();
        }

        const d = symc.isDeclaration();
        if (d !== null)
            ex = new DotVarExp(e.loc, ex, d);
        else {
            const td = symc.isTemplateDeclaration();
            if (td !== null)
                ex = new DotExp(e.loc, ex, new TemplateExp(e.loc, td));
            else {
                const ti = symc.isScopeDsymbol();
                if (ti !== null)
                    ex = new DotExp(e.loc, ex, new ScopeExp(e.loc, ti));
                else
                    assertUnreachable(); // D `assert(0)`
            }
        }

        ex = expressionSemantic(ex, sc);
        return ex;
    }
    if (e.ident === Id.toType) {
        if (dim !== 1)
            return dimError(1);

        let ex = isExpression(e.args!.opIndex(0));
        if (ex === null) {
            error(e.loc, ds("expression expected as second argument of __traits `%s`"), e.ident!.toChars());
            return ErrorExp.get();
        }
        ex = ctfeInterpret(ex);

        const se = semanticString(sc, ex, ds("__traits(toType, string)"));
        if (se === null) {
            return ErrorExp.get();
        }
        const t = decoToType(toUTF8(se, sc).peekString());
        if (t === null) {
            error(e.loc, ds("cannot determine `%s`"), e.toChars());
            return ErrorExp.get();
        }
        return expressionSemantic(new TypeExp(e.loc, t), sc);
    }
    if (e.ident === Id.hasMember ||
        e.ident === Id.getMember ||
        e.ident === Id.getOverloads ||
        e.ident === Id.getVirtualMethods ||
        e.ident === Id.getVirtualFunctions) {
        if (dim !== 2 && !(dim === 3 && e.ident === Id.getOverloads))
            return dimError(2);

        const o = e.args!.opIndex(0);
        let ex = isExpression(e.args!.opIndex(1));
        if (ex === null) {
            error(e.loc, ds("expression expected as second argument of __traits `%s`"), e.ident!.toChars());
            return ErrorExp.get();
        }
        ex = ctfeInterpret(ex);

        let includeTemplates = false;
        if (dim === 3 && e.ident === Id.getOverloads) {
            let b = isExpression(e.args!.opIndex(2))!;
            b = ctfeInterpret(b);
            if (!b.type!.equals(Type.tbool)) {
                error(e.loc,
                    ds("`bool` expected as third argument of `__traits(getOverloads)`, not `%s` of type `%s`"),
                    b.toChars(), b.type!.toChars());
                return ErrorExp.get();
            }
            includeTemplates = toBool(b).get();
        }

        let se = toStringExp(ex);
        if (se === null || se.len === 0) {
            error(e.loc,
                ds("string expected as second argument of __traits `%s` instead of `%s`"),
                e.ident!.toChars(), ex.toChars());
            return ErrorExp.get();
        }
        se = toUTF8(se, sc);

        if (se.sz !== 1) {
            error(e.loc, ds("string must be chars"));
            return ErrorExp.get();
        }
        const id = Identifier.idPool(se.peekString());

        /* Prefer a Type, because getDsymbol(Type) can lose type modifiers.
           Then a Dsymbol, because it might need some runtime contexts.
         */

        const sym = getDsymbol(o);

        // goto doSemantic (traits.d:1112) — BLOCK-EXIT (06 §4): the label (:1130) sits where this block
        // falls through to.
        doSemantic: {
            if (sym !== null && e.ident === Id.hasMember) {
                const sm = search(sym, e.loc, id);
                if (sm !== null)
                    return True();

                // https://issues.dlang.org/show_bug.cgi?id=23951
                const decl = sym.isDeclaration();
                if (decl !== null) {
                    ex = typeDotIdExp(e.loc, decl.type!, id);
                    break doSemantic; // goto doSemantic (dmd/traits.d:1112)
                }
            }

            const t = isType(o);
            if (t !== null)
                ex = typeDotIdExp(e.loc, t, id);
            else if (sym !== null) {
                ex = new DsymbolExp(e.loc, sym);
                ex = new DotIdExp(e.loc, ex, id);
            }
            else {
                const ex2 = isExpression(o);
                if (ex2 !== null)
                    ex = new DotIdExp(e.loc, ex2, id);
                else {
                    error(e.loc, ds("invalid first argument"));
                    return ErrorExp.get();
                }
            }
        }
        // doSemantic:
        // ignore symbol visibility and disable access checks for these traits
        const scx = sc.push();
        scx.ignoresymbolvisibility = true;
        scx.noAccessCheck = true;
        try { // scope (exit) scx.pop(); (traits.d:1135)

            if (e.ident === Id.hasMember) {
                /* Take any errors as meaning it wasn't found
                 */
                const r = trySemantic(ex, scx);
                return r !== null ? True() : False();
            }
            else if (e.ident === Id.getMember) {
                const die = ex.isDotIdExp();
                if (die !== null)
                    // Prevent semantic() from replacing Symbol with its initializer
                    die.wantsym = true;
                ex = expressionSemantic(ex, scx);
                if (ex !== null) {
                    // function-local `import dmd.access : symbolIsVisible; import dmd.safe : setUnsafe;`
                    // (traits.d:1152-1153) hoisted to the module imports (01 Rule 4.4).
                    const msym = getDsymbolWithoutExpCtx(ex);
                    // https://github.com/dlang/dmd/issues/19721
                    if (msym !== null && !symbolIsVisible(sc, msym)) {
                        if (setUnsafe(sc, false, e.loc, ds("accessing member `%s`"), id))
                            return ErrorExp.get();
                    }
                }
                return ex;
            }
            else if (e.ident === Id.getVirtualFunctions ||
                     e.ident === Id.getVirtualMethods ||
                     e.ident === Id.getOverloads) {
                const errors = global.errors;
                const eorig = ex;
                ex = expressionSemantic(ex, scx);
                if (errors < global.errors)
                    error(e.loc, ds("`%s` cannot be resolved"), eorig.toChars());

                if (e.ident === Id.getVirtualFunctions) {
                    // @@@DEPRECATED2.121@@@
                    // Deprecated in 2.101 - Can be removed from 2.121
                    deprecation(e.loc,
                        ds("`traits(getVirtualFunctions)` is deprecated. Use `traits(getVirtualMethods)` instead"));
                }

                /* Create tuple of functions of ex
                 */
                const exps: Expressions = new Array<Expression | null>();
                let f: Dsymbol | null = null;
                let exCtx: Expression | null = ex; // D reuses `ex`; null means "no context"
                const ve = ex.isVarExp();
                const dve = ve === null ? ex.isDotVarExp() : null;
                const te = ve === null && dve === null ? ex.isTemplateExp() : null;
                const dte = ve === null && dve === null && te === null ? ex.isDotTemplateExp() : null;
                if (ve !== null) {
                    if (ve.var_.isFuncDeclaration() !== null || ve.var_.isOverDeclaration() !== null)
                        f = ve.var_;
                    exCtx = null;
                }
                else if (dve !== null) {
                    if (dve.var_.isFuncDeclaration() !== null || dve.var_.isOverDeclaration() !== null)
                        f = dve.var_;
                    if (dve.e1!.op === EXP.dotType || dve.e1!.op === EXP.this_)
                        exCtx = null;
                    else
                        exCtx = dve.e1;
                }
                else if (te !== null) {
                    const td = te.td;
                    f = td;
                    if (td !== null && td.funcroot !== null)
                        f = td.funcroot;
                    exCtx = null;
                }
                else if (dte !== null) {
                    const td = dte.td;
                    f = td;
                    if (td !== null && td.funcroot !== null)
                        f = td.funcroot;
                    exCtx = null;
                    if (dte.e1!.op !== EXP.dotType && dte.e1!.op !== EXP.this_)
                        exCtx = dte.e1;
                }
                // D `bool[string] funcTypeHash`: a set of byte-string keys; `StringTable` is the tree's
                // byte-keyed table (08 §5), used here only for presence.
                const funcTypeHash = new StringTable<boolean>();

                /* Compute the function signature and insert it in the
                 * hashtable, if not present. This is needed so that
                 * traits(getOverlods, F3, "visit") does not count `int visit(int)`
                 * twice in the following example:
                 *
                 * =============================================
                 * interface F1 { int visit(int);}
                 * interface F2 { int visit(int); void visit(); }
                 * interface F3 : F2, F1 {}
                 *==============================================
                 */
                const insertInterfaceInheritedFunction = (fd: FuncDeclaration, e: Expression): void => {
                    const signature = fd.type!.toString();
                    //printf("%s - %s\n", fd.toChars, signature);
                    if (funcTypeHash.lookup(signature) === null) {
                        funcTypeHash.insert(signature, true);
                        exps.push(e);
                    }
                };

                const dg = (s: Dsymbol): number => {
                    const fd = s.isFuncDeclaration();
                    if (fd === null) {
                        if (!includeTemplates)
                            return 0;
                        let td = s.isTemplateDeclaration();
                        if (td === null)
                            return 0;
                        // if td is part of an overload set we must take a copy
                        // which shares the same `instances` cache but without
                        // `overroot` and `overnext` set to avoid overload
                        // behaviour in the result.
                        if (td.overnext !== null) {
                            if (td.instances === null) {
                                // create an empty AA just to copy it
                                // D (traits.d:1261-1264) builds a throwaway `TemplateInstance` + box,
                                // inserts it and clears the AA: the net effect is an allocated, empty
                                // table in `td.instances`, which is exactly this.
                                td.instances = new TemplateInstanceTable();
                            }
                            td = td.syntaxCopy(null);
                            // function-local `import core.stdc.string : memcpy;` (traits.d:1267):
                            // `memcpy(td, s, __traits(classInstanceSize, TemplateDeclaration))` copies
                            // every field of the original into the copy — including `instances`, the
                            // shared cache the comment above is after. Own-field copy is that memcpy
                            // (07 §7.1: the size operand is the instance size, elided).
                            Object.assign(td, s);
                            td.overroot = null;
                            td.overnext = null;
                        }

                        const e = exCtx !== null ? new DotTemplateExp(Loc.initial, exCtx, td)
                                                 : new DsymbolExp(Loc.initial, td);
                        exps.push(e);
                        return 0;
                    }
                    if (e.ident === Id.getVirtualFunctions && !isVirtual(fd))
                        return 0;
                    if (e.ident === Id.getVirtualMethods && !isVirtualMethod(fd))
                        return 0;

                    const fa = new FuncAliasDeclaration(fd.ident!, fd, false);
                    fa.visibility = fd.visibility.copy();

                    const e2 = exCtx !== null ? new DotVarExp(Loc.initial, exCtx, fa, false)
                                              : new DsymbolExp(Loc.initial, fa, false);

                    // if the parent is an interface declaration
                    // we must check for functions with the same signature
                    // in different inherited interfaces
                    if (sym !== null && sym.isInterfaceDeclaration() !== null)
                        insertInterfaceInheritedFunction(fd, e2);
                    else
                        exps.push(e2);
                    return 0;
                };

                let ifd: InterfaceDeclaration | null = null;
                if (sym !== null)
                    ifd = sym.isInterfaceDeclaration();
                // If the symbol passed as a parameter is an
                // interface that inherits other interfaces
                overloadApply(f, dg);
                if (ifd !== null && ifd.interfaces !== null && f !== null) {
                    // check the overloads of each inherited interface individually
                    for (const bc of ifd.interfaces) {
                        const fd = search(bc!.sym!, e.loc, f.ident!);
                        if (fd !== null)
                            overloadApply(fd, dg);
                    }
                }

                const tup = TupleExp.fromExps(e.loc, exps);
                return expressionSemantic(tup, scx);
            }
            else
                assertUnreachable(); // D `assert(0)`
        } finally {
            scx.pop();
        }
    }
    if (e.ident === Id.classInstanceSize || e.ident === Id.classInstanceAlignment) {
        if (dim !== 1)
            return dimError(1);

        const o = e.args!.opIndex(0);
        const s = getDsymbol(o);
        const cd = s !== null ? s.isClassDeclaration() : null;
        if (cd === null) {
            error(e.loc, ds("first argument is not a class"));
            return ErrorExp.get();
        }
        if (cd.sizeok !== Sizeok.done) {
            sizeDsymbol(cd, e.loc); // `cd.size(e.loc)`, called to force `sizeok`
        }
        if (cd.sizeok !== Sizeok.done) {
            error(e.loc, ds("%s `%s` is forward referenced"), cd.kind(), cd.toChars());
            return ErrorExp.get();
        }

        return new IntegerExp(e.loc, BigInt(e.ident === Id.classInstanceSize ? cd.structsize : cd.alignsize),
            Type.tsize_t);
    }
    if (e.ident === Id.getAliasThis) {
        if (dim !== 1)
            return dimError(1);

        const o = e.args!.opIndex(0);
        const s = getDsymbol(o);
        const ad = s !== null ? s.isAggregateDeclaration() : null;

        const exps: Expressions = new Array<Expression | null>();
        if (ad !== null && ad.aliasthis !== null)
            exps.push(new StringExp(e.loc, [...ad.aliasthis.identAlias!.toString()]));
        let ex: Expression = TupleExp.fromExps(e.loc, exps);
        ex = expressionSemantic(ex, sc);
        return ex;
    }
    if (e.ident === Id.getAttributes) {
        /* Specify 0 for bit 0 of the flags argument to semanticTiargs() so that
         * a symbol should not be folded to a constant.
         * Bit 1 means don't convert Parameter to Type if Parameter has an identifier
         */
        if (!TemplateInstance_semanticTiargs(e.loc, sc, e.args, 3))
            return ErrorExp.get();

        if (dim !== 1)
            return dimError(1);

        const o = e.args!.opIndex(0);
        const po = isParameter(o);
        let s = getDsymbolWithoutExpCtx(o);
        const typeOfArg = isType(o);
        let udad: UserAttributeDeclaration | null = null;
        if (po !== null) {
            udad = po.userAttribDecl;
        }
        else if (s !== null) {
            // @@@DEPRECATION 2.100.2
            const fd = s.isFuncDeclaration();
            if (fd !== null) {
                if (fd.overnext !== null) {
                    deprecation(e.loc,
                        ds("`__traits(getAttributes)` may only be used for individual functions, not the overload " +
                            "set `%s`"),
                        fd.toChars());
                    deprecationSupplemental(e.loc,
                        ds("the result of `__traits(getOverloads)` may be used to select the desired function to " +
                            "extract attributes from"));
                }
            }

            // @@@DEPRECATION 2.100.2
            const td = s.isTemplateDeclaration();
            if (td !== null) {
                if (td.overnext !== null) {
                    deprecation(e.loc,
                        ds("`__traits(getAttributes)` may only be used for individual functions, not the overload " +
                            "set `%s`"),
                        td.ident!.toChars());
                    deprecationSupplemental(e.loc,
                        ds("the result of `__traits(getOverloads)` may be used to select the desired function to " +
                            "extract attributes from"));
                }
            }
            if (s.isImport() !== null) {
                // upcast cascade: Module.errors (number) shadows Dsymbol.errors (bool) — 02 §11.5.
                s = s.isImport()!.mod as unknown as Dsymbol | null;
            }
            //printf("getAttributes %s, attrs = %p, scope = %p\n", s.toChars(), s.userAttribDecl, s._scope);
            udad = s!.userAttribDecl();
        }
        else if (typeOfArg !== null) {
            // If there is a type but no symbol, do nothing rather than erroring.
        }
        else {
            // resolved: version (none) printf block (traits.d:1418-1426) — OFF (07 §1.4).
            error(e.loc, ds("first argument is not a symbol"));
            return ErrorExp.get();
        }

        const exps: Expressions = udad !== null ? getAttributes(udad) : new Array<Expression | null>();
        const tup = TupleExp.fromExps(e.loc, exps);
        return expressionSemantic(tup, sc);
    }
    if (e.ident === Id.getFunctionAttributes) {
        /* Extract all function attributes as a tuple (const/shared/inout/pure/nothrow/etc) except UDAs.
         * https://dlang.org/spec/traits.html#getFunctionAttributes
         */
        if (dim !== 1)
            return dimError(1);

        const fd: Ref<FuncDeclaration | null> = { value: null };
        let tf = toTypeFunction(e.args!.opIndex(0), fd);

        if (tf === null) {
            error(e.loc, ds("first argument is not a function"));
            return ErrorExp.get();
        }

        // https://issues.dlang.org/show_bug.cgi?id=19706
        // When getting the attributes of the instance of a
        // templated member function semantic tiargs does
        // not perform semantic3 on the instance.
        // For more information see FuncDeclaration.functionSemantic.
        // For getFunctionAttributes it is mandatory to do
        // attribute inference.
        if (fd.value !== null && fd.value.parent !== null && fd.value.parent.isTemplateInstance() !== null) {
            functionSemantic3(fd.value);
            tf = fd.value.type!.isTypeFunction();
        }

        const mods: Expressions = new Array<Expression | null>();

        const addToMods = (str: string): void => {
            mods.push(new StringExp(Loc.initial, [...ds(str)]));
        };
        modifiersApply(tf!, addToMods);
        attributesApply(tf!, addToMods, TRUSTformat.TRUSTformatSystem);

        const tup = TupleExp.fromExps(e.loc, mods);
        return expressionSemantic(tup, sc);
    }
    if (e.ident === Id.isReturnOnStack) {
        /* Extract as a boolean if function return value is on the stack
         * https://dlang.org/spec/traits.html#isReturnOnStack
         */
        if (dim !== 1)
            return dimError(1);

        const o = e.args!.opIndex(0);
        const fd: Ref<FuncDeclaration | null> = { value: null };
        const tf = toTypeFunction(o, fd);

        if (tf === null) {
            error(e.loc, ds("argument to `__traits(isReturnOnStack, %s)` is not a function"), o!.toChars());
            return ErrorExp.get();
        }

        const value = target.isReturnOnStack(tf, fd.value !== null && fd.value.needThis());
        return IntegerExp.createBool(value);
    }
    if (e.ident === Id.getFunctionVariadicStyle) {
        /* Accept a symbol or a type. Returns one of the following:
         *  "none"      not a variadic function
         *  "argptr"    extern(D) void dstyle(...), use `__argptr` and `__arguments`
         *  "stdarg"    extern(C) void cstyle(int, ...), use core.stdc.stdarg
         *  "typesafe"  void typesafe(T[] ...)
         *  "KR"        old K+R style
         */
        // get symbol linkage as a string
        if (dim !== 1)
            return dimError(1);

        let link: LINK;
        let varargs: VarArg;
        const o = e.args!.opIndex(0);

        const fd: Ref<FuncDeclaration | null> = { value: null };
        const tf = toTypeFunction(o, fd);

        if (tf !== null) {
            link = tf.linkage;
            varargs = tf.parameterList.varargs;
        }
        else {
            if (fd.value === null) {
                error(e.loc,
                    ds("argument to `__traits(getFunctionVariadicStyle, %s)` is not a function"),
                    o!.toChars());
                return ErrorExp.get();
            }
            link = fd.value._linkage;
            varargs = fd.value.getParameterList().varargs;
        }
        let style: string;
        switch (varargs) { // D `final switch`
            case VarArg.none:     style = "none";           break;
            case VarArg.variadic: style = (link === LINK.d)
                                             ? "argptr"
                                             : "stdarg";    break;
            case VarArg.KRvariadic: style = "KR";           break;
            case VarArg.typesafe: style = "typesafe";       break;
            default:              return assertUnreachable(); // `final switch`: SwitchError
        }
        const se = new StringExp(e.loc, [...ds(style)]);
        return expressionSemantic(se, sc);
    }
    if (e.ident === Id.getParameterStorageClasses) {
        /* Accept a function symbol or a type, followed by a parameter index.
         * Returns a tuple of strings of the parameter's storage classes.
         */
        // get symbol linkage as a string
        if (dim !== 2)
            return dimError(2);

        const o = e.args!.opIndex(0);
        const o1 = e.args!.opIndex(1);

        let fparams: ParameterList;

        let ce = null;
        const exp = isExpression(o);
        if (exp !== null)
            ce = exp.isCallExp();

        if (ce !== null) {
            fparams = ce.f!.getParameterList();
        }
        else {
            const fd: Ref<FuncDeclaration | null> = { value: null };
            const tf = toTypeFunction(o, fd);
            if (tf !== null)
                fparams = tf.parameterList.copy();
            else if (fd.value !== null)
                fparams = fd.value.getParameterList();
            else {
                error(e.loc,
                    ds("first argument to `__traits(getParameterStorageClasses, %s, %s)` is not a function or a " +
                        "function call"),
                    o!.toChars(), o1!.toChars());
                return ErrorExp.get();
            }
        }

        // Avoid further analysis for invalid functions leading to misleading error messages
        if (fparams.parameters === null)
            return ErrorExp.get();

        let stc: STC;

        // Set stc to storage class of the ith parameter
        let ex = isExpression(e.args!.opIndex(1));
        if (ex === null) {
            error(e.loc, ds("expression expected as second argument of `__traits(getParameterStorageClasses, %s, %s)`"),
                o!.toChars(), o1!.toChars());
            return ErrorExp.get();
        }
        ex = ctfeInterpret(ex);
        const ii: bigint = toUInteger(ex);
        if (ii >= BigInt(fparams.length())) {
            error(e.loc, ds("parameter index must be in range 0..%u not %s"), fparams.length(), ex.toChars());
            return ErrorExp.get();
        }

        const n = Number(ii); // `cast(uint)ii`: below `fparams.length` by the test above
        const p: Parameter = fparams.opIndex(n)!;
        stc = p.storageClass;

        // This mirrors hdrgen.visit(Parameter p)
        if (p.type !== null && (p.type.mod & MODFlags.shared_) !== 0)
            stc = (stc & ~STC.shared_) as STC;

        const exps: Expressions = new Array<Expression | null>();

        const push = (s: string): void => {
            exps.push(new StringExp(e.loc, [...ds(s)]));
        };

        if ((stc & STC.auto_) !== 0n)
            push("auto");
        if ((stc & STC.return_) !== 0n)
            push("return");

        if ((stc & STC.out_) !== 0n)
            push("out");
        else if ((stc & STC.in_) !== 0n)
            push("in");
        else if ((stc & STC.ref_) !== 0n)
            push("ref");
        else if ((stc & STC.lazy_) !== 0n)
            push("lazy");
        else if ((stc & STC.alias_) !== 0n)
            push("alias");

        if ((stc & STC.const_) !== 0n)
            push("const");
        if ((stc & STC.immutable_) !== 0n)
            push("immutable");
        if ((stc & STC.wild) !== 0n)
            push("inout");
        if ((stc & STC.shared_) !== 0n)
            push("shared");
        if ((stc & STC.scope_) !== 0n && (stc & STC.scopeinferred) === 0n)
            push("scope");

        const tup = TupleExp.fromExps(e.loc, exps);
        return expressionSemantic(tup, sc);
    }
    if (e.ident === Id.getLinkage) {
        // get symbol linkage as a string
        if (dim !== 1)
            return dimError(1);

        let link: LINK;
        const o = e.args!.opIndex(0);

        const fd: Ref<FuncDeclaration | null> = { value: null };
        const tf = toTypeFunction(o, fd);

        if (tf !== null) {
            link = fd.value !== null ? fd.value.toAliasFunc()._linkage : tf.linkage;
        }
        else {
            const s = getDsymbol(o);
            let d: Declaration | null = null;
            let agg: AggregateDeclaration | null = null;
            if (s === null || ((d = s.isDeclaration()) === null && (agg = s.isAggregateDeclaration()) === null)) {
                error(e.loc, ds("argument to `__traits(getLinkage, %s)` is not a declaration"), o!.toChars());
                return ErrorExp.get();
            }

            if (d !== null)
                link = d._linkage;
            else {
                // Resolves forward references
                if (agg!.sizeok !== Sizeok.done) {
                    sizeDsymbol(agg!, e.loc); // `agg.size(e.loc)`, called to force `sizeok`
                    // 02 §11.4 — D re-tests `agg.sizeok` after the call that sets it; TS's stale
                    // narrowing would reject the literal spelling as a "no overlap" comparison, so the
                    // object is re-read into a fresh local annotated at its declared type.
                    const aggSized: AggregateDeclaration = agg!;
                    if (aggSized.sizeok !== Sizeok.done) {
                        error(e.loc, ds("%s `%s` is forward referenced"), agg!.kind(), agg!.toChars());
                        return ErrorExp.get();
                    }
                }

                switch (agg!.classKind) { // D `final switch`
                    case ClassKind.d:
                        link = LINK.d;
                        break;
                    case ClassKind.cpp:
                        link = LINK.cpp;
                        break;
                    case ClassKind.objc:
                        link = LINK.objc;
                        break;
                    case ClassKind.c:
                        link = LINK.c;
                        break;
                    default:
                        return assertUnreachable(); // `final switch`: SwitchError
                }
            }
        }
        const linkage = linkageToChars(link);
        const se = new StringExp(e.loc, [...toDString(linkage)!]);
        return expressionSemantic(se, sc);
    }
    if (e.ident === Id.allMembers ||
        e.ident === Id.derivedMembers) {
        if (dim !== 1)
            return dimError(1);

        const o = e.args!.opIndex(0);
        let s = getDsymbol(o);
        if (s === null) {
            error(e.loc, ds("in expression `%s` `%s` can't have members"), e.toChars(), o!.toChars());
            errorSupplemental(e.loc,
                ds("`%s` must evaluate to either a module, a struct, an union, a class, an interface or a template " +
                    "instantiation"),
                o!.toChars());

            return ErrorExp.get();
        }
        const imp = s.isImport();
        if (imp !== null) {
            // https://issues.dlang.org/show_bug.cgi?id=9692
            // https://issues.dlang.org/show_bug.cgi?id=20008
            if (imp.pkg !== null)
                s = imp.pkg;
        }

        // https://issues.dlang.org/show_bug.cgi?id=16044
        const p = s.isPackage();
        if (p !== null) {
            const pm = p.isPackageMod();
            if (pm !== null)
                // upcast cascade: Module.errors (number) shadows Dsymbol.errors (bool) — 02 §11.5.
                s = pm as unknown as Dsymbol;
        }

        const sds = s.isScopeDsymbol();
        if (sds === null || sds.isTemplateDeclaration() !== null) {
            error(e.loc, ds("in expression `%s` %s `%s` has no members"), e.toChars(), s.kind(), s.toChars());
            errorSupplemental(e.loc,
                ds("`%s` must evaluate to either a module, a struct, an union, a class, an interface or a template " +
                    "instantiation"),
                s.toChars());
            return ErrorExp.get();
        }
        // https://issues.dlang.org/show_bug.cgi?id=13668
        // https://github.com/dlang/dmd/issues/22524
        // resolve forward references
        if (sds.semanticRun < PASS.semanticdone)
            dsymbolSemantic(sds, sc);

        const idents: Identifiers = new Array<Identifier | null>();

        const pushIdentsDg = (n: number, sm: Dsymbol | null): number => {
            void n;
            if (sm === null)
                return 1;

            // skip local symbols, such as static foreach loop variables
            const decl = sm.isDeclaration();
            if (decl !== null) {
                if ((decl.storage_class & STC.local) !== 0n) {
                    return 0;
                }
                // skip 'this' context pointers
                else if (decl.isThisDeclaration() !== null)
                    return 0;
            }

            // https://issues.dlang.org/show_bug.cgi?id=20915
            // skip version and debug identifiers
            if (sm.isVersionSymbol() !== null || sm.isDebugSymbol() !== null)
                return 0;

            //printf("\t[%i] %s %s\n", i, sm.kind(), sm.toChars());
            if (sm.ident !== null) {
                // https://issues.dlang.org/show_bug.cgi?id=10096
                // https://issues.dlang.org/show_bug.cgi?id=10100
                // Skip over internal members in __traits(allMembers)
                if ((sm.isCtorDeclaration() !== null && sm.ident !== Id.ctor) ||
                    (sm.isDtorDeclaration() !== null && sm.ident !== Id.dtor) ||
                    (sm.isPostBlitDeclaration() !== null && sm.ident !== Id.postblit) ||
                    sm.isInvariantDeclaration() !== null ||
                    sm.isUnitTestDeclaration() !== null) {
                    return 0;
                }
                if (sm.ident === Id.empty) {
                    return 0;
                }
                if (sm.isTypeInfoDeclaration() !== null) // https://issues.dlang.org/show_bug.cgi?id=15177
                    return 0;
                // https://issues.dlang.org/show_bug.cgi?id=17057
                if ((sds.isModule() === null && sds.isPackage() === null) && sm.isImport() !== null)
                    return 0;

                //printf("\t%s\n", sm.ident.toChars());

                /* Skip if already present in idents[]
                 */
                for (const id of idents) {
                    if (id === sm.ident)
                        return 0;

                    // resolved: the `debug { … strcmp … }` block (traits.d:1815-1819) — debug OFF (07 §2).
                }
                idents.push(sm.ident);
            }
            else {
                const ed = sm.isEnumDeclaration();
                if (ed !== null) {
                    _foreach(null, ed.members, pushIdentsDg);
                }
            }
            return 0;
        };

        _foreach(sc, sds.members, pushIdentsDg);
        const cd = sds.isClassDeclaration();
        if (cd !== null && e.ident === Id.allMembers) {
            const pushBaseMembersDg = (cd: ClassDeclaration): void => {
                for (let i = 0; i < cd.baseclasses.length; i++) {
                    const cb = cd.baseclasses.opIndex(i)!.sym;
                    assert(cb !== null);
                    _foreach(null, cb!.members, pushIdentsDg);
                    if (cb!.baseclasses.length !== 0)
                        pushBaseMembersDg(cb!);
                }
            };

            pushBaseMembersDg(cd);
        }

        // Turn Identifiers into StringExps reusing the allocated array
        // D (traits.d:1850-1856) casts `idents` to `Expressions*` and overwrites it slot by slot; the
        // reuse saves an allocation and nothing reads `idents` afterwards, so a fresh array of the
        // same length is the same result without re-typing the container.
        const exps: Expressions = new Array<Expression | null>(idents.length);
        for (const [i, id] of idents.tdata().entries()) {
            const se = new StringExp(e.loc, [...id!.toString()]);
            exps.opIndexAssign(se, i);
        }

        /* Making this a tuple is more flexible, as it can be statically unrolled.
         * To make an array literal, enclose __traits in [ ]:
         *   [ __traits(allMembers, ...) ]
         */
        let ex: Expression = TupleExp.fromExps(e.loc, exps);
        ex = expressionSemantic(ex, sc);
        return ex;
    }
    if (e.ident === Id.compiles) {
        /* Determine if all the objects - types, expressions, or symbols -
         * compile without error
         */
        if (dim === 0)
            return False();

        for (const o of e.args!) {
            const errors = global.startGagging();
            // 11 §2.5 (capture-in-finally): D consumes `endGagging`'s return at the region end
            // (traits.d:1923). `sc2` needs no guard: `detach` writes only `sc2` itself, which dies here.
            let gagged: boolean;
            let err = false;
            try {
                const sc2 = sc.push();
                sc2.tinst = null;
                sc2.minst = null;   // this is why code for these are not emitted to object file
                sc2.copyFlagsFrom(sc);
                sc2.ctfe = false;
                sc2.condition = false;
                sc2.traitsCompiles = true;
                sc2.fullinst = true;

                let t = isType(o);
                let ex = isExpression(o);
                if (t !== null) {
                    const pe: Ref<Expression | null> = { value: ex };
                    const pt: Ref<Type | null> = { value: t };
                    const ps: Ref<Dsymbol | null> = { value: null };
                    resolve(t, e.loc, sc2, pe, pt, ps);
                    ex = pe.value;
                    t = pt.value;
                    const s = ps.value;
                    if (t !== null) {
                        typeSemantic(t, e.loc, sc2);
                        if (t.ty === TY.Terror)
                            err = true;
                    }
                    else if (s !== null && s.errors)
                        err = true;
                }
                if (ex !== null) {
                    ex = expressionSemantic(ex, sc2);
                    ex = resolvePropertiesOnly(sc2, ex);
                    ex = optimize(ex, WANTvalue);
                    if (sc2.func !== null && sc2.func.type!.isTypeFunction() !== null) {
                        const tf = sc2.func.type!.isTypeFunction()!;
                        // D `err |= a && b`: the right operand is evaluated even when `err` is set.
                        const thrown = tf.isNothrow && canThrow(ex, sc2.func, null) !== 0;
                        err = err || thrown;
                    }
                    ex = checkGC(ex, sc2);
                    if (ex.op === EXP.error)
                        err = true;
                }

                // Carefully detach the scope from the parent and throw it away as
                // we only need it to evaluate the expression
                // https://issues.dlang.org/show_bug.cgi?id=15428
                sc2.detach();
            } finally {
                gagged = global.endGagging(errors);
            }

            if (gagged || err) {
                return False();
            }
        }
        return True();
    }
    if (e.ident === Id.isSame) {
        /* Determine if two symbols are the same
         */
        if (dim !== 2)
            return dimError(2);

        // https://issues.dlang.org/show_bug.cgi?id=20761
        // tiarg semantic may expand in place the list of arguments, for example:
        //
        //     before tiarg sema:  __traits(isSame, seq!(0,0), seq!(1,1))
        //     after            :  __traits(isSame, 0, 0, 1, 1)
        //
        // so we split in two lists
        const ob1: Objects = new Array<RootObject | null>();
        ob1.push(e.args!.opIndex(0));
        const ob2: Objects = new Array<RootObject | null>();
        ob2.push(e.args!.opIndex(1));
        if (!TemplateInstance_semanticTiargs(e.loc, sc, ob1, 0))
            return ErrorExp.get();
        if (!TemplateInstance_semanticTiargs(e.loc, sc, ob2, 0))
            return ErrorExp.get();
        if (ob1.length !== ob2.length)
            return False();
        for (let i = 0; i < ob1.length; i++)
            if (!isSame(ob1.opIndex(i), ob2.opIndex(i), sc))
                return False();
        return True();
    }
    if (e.ident === Id.getUnitTests) {
        if (dim !== 1)
            return dimError(1);

        const o = e.args!.opIndex(0);
        let s = getDsymbolWithoutExpCtx(o);
        if (s === null) {
            error(e.loc, ds("argument `%s` to __traits(getUnitTests) must be a module or aggregate"),
                o!.toChars());
            return ErrorExp.get();
        }
        const imp = s.isImport();
        if (imp !== null) // https://issues.dlang.org/show_bug.cgi?id=10990
            // upcast cascade: Module.errors (number) shadows Dsymbol.errors (bool) — 02 §11.5.
            s = imp.mod! as unknown as Dsymbol;

        const sds = s.isScopeDsymbol();
        if (sds === null || sds.isTemplateDeclaration() !== null) {
            error(e.loc, ds("argument `%s` to __traits(getUnitTests) must be a module or aggregate, not a %s"),
                s.toChars(), s.kind());
            return ErrorExp.get();
        }

        const exps: Expressions = new Array<Expression | null>();
        if (global.params.useUnitTests) {
            // D `bool[void*] uniqueUnitTests`: keyed on the object's address, i.e. identity.
            const uniqueUnitTests = new Set<UnitTestDeclaration>();

            const symbolDg = (s: Dsymbol | null): number => {
                const ad = s!.isAttribDeclaration();
                if (ad !== null) {
                    foreachDsymbol(include(ad, null), symbolDg);
                    return 0;
                }
                const tm = s!.isTemplateMixin();
                if (tm !== null) {
                    foreachDsymbol(tm.members, symbolDg);
                    return 0;
                }
                const ud = s!.isUnitTestDeclaration();
                if (ud !== null) {
                    if (uniqueUnitTests.has(ud))
                        return 0;

                    uniqueUnitTests.add(ud);

                    const ad2 = new FuncAliasDeclaration(ud.ident!, ud, false);
                    ad2.visibility = ud.visibility.copy();

                    const e2 = new DsymbolExp(Loc.initial, ad2, false);
                    exps.push(e2);
                }
                return 0;
            };

            foreachDsymbol(sds.members, symbolDg);
        }
        const te = TupleExp.fromExps(e.loc, exps);
        return expressionSemantic(te, sc);
    }
    if (e.ident === Id.getVirtualIndex) {
        if (dim !== 1)
            return dimError(1);

        const o = e.args!.opIndex(0);
        const s = getDsymbolWithoutExpCtx(o);

        let fd = s !== null ? s.isFuncDeclaration() : null;
        if (fd === null) {
            error(e.loc, ds("first argument to __traits(getVirtualIndex) must be a function"));
            return ErrorExp.get();
        }

        fd = fd.toAliasFunc(); // Necessary to support multiple overloads.
        return new IntegerExp(e.loc, BigInt(fd.vtblIndex), Type.tptrdiff_t);
    }
    if (e.ident === Id.getPointerBitmap) {
        return pointerBitmap(e, global.errorSink!);
    }
    if (e.ident === Id.initSymbol) {
        if (dim !== 1)
            return dimError(1);

        const o = e.args!.opIndex(0);

        const badArgument = (): ErrorExp => {
            error(e.loc,
                ds("struct / class type expected as argument to __traits(initSymbol) instead of `%s`"),
                o!.toChars());
            return ErrorExp.get();
        };

        const t = isType(o);

        if (t === null || t.isTypeEnum() !== null)
            return badArgument();

        const ad = isAggregate(t);

        // Interfaces don't have an init symbol and hence cause linker errors
        if (ad === null || ad.isInterfaceDeclaration() !== null)
            return badArgument();

        const d: Declaration = new SymbolDeclaration(ad.loc, ad);
        d.type = constOf(arrayOf(Type.tvoid));
        d.storage_class = (d.storage_class | STC.rvalue) as STC;
        return new VarExp(e.loc, d);
    }
    // resolved: version (IN_LLVM) -> true (LDC), traits.d:2069-2076. The function-local
    // `import dmd.hooks : semanticTraitsHook;` is hoisted to the module imports (01 Rule 4.4).
    {
        const ret = semanticTraitsHook(e, sc);
        if (ret !== null) {
            return ret;
        }
    }
    if (e.ident === Id.isZeroInit) {
        if (dim !== 1)
            return dimError(1);

        const o = e.args!.opIndex(0);
        const t = isType(o);
        if (t === null) {
            error(e.loc, ds("type expected as second argument of __traits `%s` instead of `%s`"),
                e.ident!.toChars(), o!.toChars());
            return ErrorExp.get();
        }

        // https://issues.dlang.org/show_bug.cgi?id=23534
        //
        // For enums, we need to get the enum initializer
        // (the first enum member), not the initializer of the
        // type of the enum members.
        const tb = t.isTypeEnum() !== null ? t : baseElemOf(t);
        return isZeroInit(tb, e.loc) ? True() : False();
    }
    if (e.ident === Id.getTargetInfo) {
        if (dim !== 1)
            return dimError(1);

        const ex = isExpression(e.args!.opIndex(0));
        let se = ex !== null ? toStringExp(ctfeInterpret(ex)) : null;
        if (ex === null || se === null || se.len === 0) {
            error(e.loc,
                ds("string expected as argument of __traits `%s` instead of `%s`"),
                e.ident!.toChars(), e.args!.opIndex(0)!.toChars());
            return ErrorExp.get();
        }
        se = toUTF8(se, sc);

        const slice = se.peekString();
        const r = target.getTargetInfo(slice, e.loc); // BUG: reliance on terminating 0
        if (r === null) {
            error(e.loc, ds("`getTargetInfo` key `\"%.*s\"` not supported by this implementation"),
                slice.length, slice);
            return ErrorExp.get();
        }
        return expressionSemantic(r, sc);
    }
    if (e.ident === Id.getLocation) {
        if (dim !== 1)
            return dimError(1);
        const arg0 = e.args!.opIndex(0);
        const s = getDsymbolWithoutExpCtx(arg0);
        if (s === null || !s.loc.isValid() || s.isModule() !== null) {
            error(e.loc,
                ds("can only get the location of a symbol, not `%s`"),
                s !== null ? s.toPrettyChars() : arg0!.toChars());
            return ErrorExp.get();
        }

        const fd = s.isFuncDeclaration();
        // FIXME:td.overnext is always set, even when using an index on it
        //const td = s.isTemplateDeclaration();
        if ((fd !== null && fd.overnext !== null) /*|| (td && td.overnext)*/) {
            error(e.loc, ds("cannot get location of an overload set, " +
                    "use `__traits(getOverloads, ..., \"%s\"%s)[N]` " +
                    "to get the Nth overload"),
                    arg0!.toChars(), /*td ? ", true".ptr :*/ ds(""));
            return ErrorExp.get();
        }

        const exps: Expressions = new Array<Expression | null>(3);
        exps.opIndexAssign(new StringExp(e.loc, [...(toDString(s.loc.filename()) ?? ds(""))]), 0); // null -> `[]`
        exps.opIndexAssign(new IntegerExp(e.loc, BigInt(s.loc.linnum()), Type.tint32), 1);
        exps.opIndexAssign(new IntegerExp(e.loc, BigInt(s.loc.charnum()), Type.tint32), 2);
        const tup = TupleExp.fromExps(e.loc, exps);
        return expressionSemantic(tup, sc);
    }
    if (e.ident === Id.getCppNamespaces) {
        const o = e.args!.opIndex(0);
        const s = getDsymbolWithoutExpCtx(o)!;
        const exps: Expressions = new Array<Expression | null>(0);
        {
            const d = s.isDeclaration();
            if (d !== null) {
                if (d.inuse !== 0) {
                    error(d.loc,
                        ds("%s `%s` circular reference in `__traits(GetCppNamespaces,...)`"),
                        d.kind(), d.toPrettyChars());
                    return ErrorExp.get();
                }
                d.inuse = 1;
            }
        }

        // 11 §2.5 (catch-repair-rethrow): `d.inuse` outlives the throw, and D releases it only at the
        // region end (traits.d:2228); its early error returns keep it set, as in D.
        try {
            /**
             Prepend the namespaces in the linked list `ns` to `es`.

             Returns: true if `ns` contains an `ErrorExp`.
             */
            const prependNamespaces = (es: Expressions, ns: CPPNamespaceDeclaration | null): boolean => {
                // Semantic processing will convert `extern(C++, "a", "b", "c")`
                // into `extern(C++, "a") extern(C++, "b") extern(C++, "c")`,
                // creating a linked list what `a`'s `cppnamespace` points to `b`,
                // and `b`'s points to `c`. Our entry point is `a`.
                for (; ns !== null; ns = ns.cppnamespace()) {
                    dsymbolSemantic(ns, sc);

                    if (ns.exp!.isErrorExp() !== null)
                        return true;

                    const se = toStringExp(ns.exp!)!;
                    // extern(C++, (emptyTuple))
                    // struct D {}
                    // will produce a blank ident
                    if (se.len === 0)
                        continue;
                    es.insert(0, se);
                }
                return false;
            };
            for (let p: Dsymbol = s; p.isModule() === null; p = p.toParent()!) {
                dsymbolSemantic(p, sc);
                const pp = p.toParent()!;
                if (pp.isTemplateInstance() !== null) {
                    if (p.cppnamespace() === null)
                        continue;
                    //if (!p.toParent().cppnamespace)
                    //    continue;
                    const inner: Expressions = new Array<Expression | null>(0);
                    const outer: Expressions = new Array<Expression | null>(0);
                    if (prependNamespaces(inner,  p.cppnamespace())) return ErrorExp.get();
                    if (prependNamespaces(outer, pp.cppnamespace())) return ErrorExp.get();

                    let i = 0;
                    while (i < outer.length && (inner.opIndex(i)) === outer.opIndex(i))
                        i++;

                    const tail = inner.opSlice(i, inner.length);
                    for (let j = tail.length - 1; j >= 0; j--) // foreach_reverse (ns; (*inner)[][i .. $])
                        exps.insert(0, tail[j]);
                    continue;
                }

                if (p.isNspace() !== null)
                    exps.insert(0, new StringExp(p.loc, [...p.ident!.toString()]));

                if (prependNamespaces(exps, p.cppnamespace()))
                    return ErrorExp.get();
            }
            {
                const d = s.isDeclaration();
                if (d !== null)
                    d.inuse = 0;
            }
        } catch (ex) {
            const d = s.isDeclaration();
            if (d !== null)
                d.inuse = 0;
            throw ex;
        }
        const tup = TupleExp.fromExps(e.loc, exps);
        return expressionSemantic(tup, sc);
    }
    //https://issues.dlang.org/show_bug.cgi?id=22291
    if (e.ident === Id.parameters) {
        //No args are valid
        if (e.args !== null) {
            // `cast(char[]) e.args.toString()`, then `contents[1..$]` and `contents[$-1] = '\0'`:
            // the brackets of `[a,b]` are cut, the `]` replaced by the terminator `%s` stops at.
            let contents: DString = toStringObjects(e.args);
            contents = contents.subarray(1);
            contents[contents.length - 1] = 0;
            error(e.loc, ds("`__traits(parameters)` cannot have arguments, but `%s` was supplied"), contents);
            return ErrorExp.get();
        }

        const fd = sc.getEnclosingFunction();
        if (fd === null) {
            error(e.loc, ds("`__traits(parameters)` may only be used inside a function"));
            return ErrorExp.get();
        }

        const tf = fd.type!.isTypeFunction();
        assert(tf !== null);
        const exps: Expressions = new Array<Expression | null>(0);
        const addParameterDG = (idx: number, x: Parameter): number => {
            void idx;
            assert(x.ident !== null);
            exps.push(new IdentifierExp(e.loc, x.ident));
            return 0;
        };
        /*
            This is required since not all "parameters" actually have a name
            until they (tuples) are expanded e.g. an anonymous tuple parameter's
            contents get given names but not the tuple itself.
        */
        Parameter._foreach(tf!.parameterList.parameters, addParameterDG);
        const tup = TupleExp.fromExps(e.loc, exps);
        return expressionSemantic(tup, sc);
    }

    /* Can't find the identifier. Try a spell check for a better error message
     */
    traitNotFound(e);

    return ErrorExp.get();
}

/**
 * dmd/traits.d:2279 — compare arguments of __traits(isSame).
 * The UFCS call `ob1[i].isSame(ob2[i], sc)` (traits.d:1955) resolves to this module-private function.
 */
function isSame(o1: RootObject | null, o2: RootObject | null, sc: Scope): boolean {
    const isLambda = (oarg: RootObject | null): FuncLiteralDeclaration | null => {
        const t = isDsymbol(oarg);
        if (t !== null) {
            const td = t.isTemplateDeclaration();
            if (td !== null) {
                if (td.members !== null && td.members.length === 1) {
                    const fd = td.members.opIndex(0)!.isFuncLiteralDeclaration();
                    if (fd !== null)
                        return fd;
                }
            }
        }
        else {
            const ea = isExpression(oarg);
            if (ea !== null) {
                if (ea.op === EXP.function_) {
                    const fe = ea.isFuncExp();
                    if (fe !== null)
                        return fe.fd;
                }
            }
        }
        return null;
    };

    const l1 = isLambda(o1);
    const l2 = isLambda(o2);

    if (l1 !== null && l2 !== null) {
        // function-local `import dmd.lambdacomp : isSameFuncLiteral;` (traits.d:2310), hoisted to module level.
        if (isSameFuncLiteral(l1, l2, sc))
            return true;
    }

    // https://issues.dlang.org/show_bug.cgi?id=12001, allow isSame, <BasicType>, <BasicType>
    const t1 = isType(o1);
    const t2 = isType(o2);
    if (t1 !== null && t2 !== null)
        return t1.equals(t2);

    let s1 = getDsymbol(o1);
    let s2 = getDsymbol(o2);
    //printf("isSame: %s, %s\n", o1.toChars(), o2.toChars());
    // resolved: version (none) printf block (traits.d:2324-2337) — OFF (07 §1.4).
    if (s1 === null && s2 === null) {
        const ea1 = isExpression(o1);
        const ea2 = isExpression(o2);
        if (ea1 !== null && ea2 !== null) {
            if (equals(ea1, ea2))
                return true;
        }
    }
    if (s1 === null || s2 === null)
        return false;

    s1 = toAlias(s1);
    s2 = toAlias(s2);

    const fa1 = s1.isFuncAliasDeclaration();
    if (fa1 !== null)
        s1 = fa1.toAliasFunc();
    const fa2 = s2.isFuncAliasDeclaration();
    if (fa2 !== null)
        s2 = fa2.toAliasFunc();

    // https://issues.dlang.org/show_bug.cgi?id=11259
    // compare import symbol to a package symbol
    const cmp = (s1: Dsymbol, s2: Dsymbol): boolean => {
        const imp = s1.isImport();
        return imp !== null && imp.pkg !== null && imp.pkg === s2.isPackage();
    };

    if (cmp(s1, s2) || cmp(s2, s1))
        return true;

    if (s1 === s2)
        return true;

    // https://issues.dlang.org/show_bug.cgi?id=18771
    // OverloadSets are equal if they contain the same functions
    const overSet1 = s1.isOverloadSet();
    if (overSet1 === null)
        return false;

    const overSet2 = s2.isOverloadSet();
    if (overSet2 === null)
        return false;

    if (overSet1.a.length !== overSet2.a.length)
        return false;

    // OverloadSets contain array of Dsymbols => O(n*n)
    // to compare for equality as the order of overloads
    // might not be the same
Lnext:
    for (const overload1 of overSet1.a) {
        for (const overload2 of overSet2.a) {
            if (overload1 === overload2)
                continue Lnext;
        }
        return false;
    }
    return true;
}

/**
 * dmd/traits.d:2412 — `__gshared const StringTable!bool traitsStringTable;` + `__gshared bool
 * initialized;`, the lazily-built table of every trait name the speller searches. Module state,
 * written once on first use; the table content is fixed, so no harness reset is needed.
 */
const traitsStringTable = new StringTable<boolean>();
let initialized = false;

/***********************************
 * dmd/traits.d:2410 — A trait was not found. Give a decent error message by trying a spell check.
 * Params:
 *      e = the offending trait
 */
function traitNotFound(e: TraitsExp): void {
    if (!initialized) {
        initialized = true;     // lazy initialization

        // All possible traits
        const idents: (Identifier | null)[] = [
            Id.allMembers,
            Id.child,
            Id.classInstanceAlignment,
            Id.classInstanceSize,
            Id.compiles,
            Id.derivedMembers,
            Id.fullyQualifiedName,
            Id.getAliasThis,
            Id.getAttributes,
            Id.getFunctionAttributes,
            Id.getFunctionVariadicStyle,
            Id.getLinkage,
            Id.getLocation,
            Id.getMember,
            Id.getOverloads,
            Id.getParameterStorageClasses,
            Id.getPointerBitmap,
            Id.getProtection,
            Id.getTargetInfo,
            Id.getUnitTests,
            Id.getVirtualFunctions,
            Id.getVirtualIndex,
            Id.getVirtualMethods,
            Id.getVisibility,
            Id.hasCopyConstructor,
            Id.hasMember,
            Id.hasPostblit,
            Id.identifier,
            Id.isAbstractClass,
            Id.isAbstractFunction,
            Id.isOverlapped,
            Id.isArithmetic,
            Id.isAssociativeArray,
            Id.isCopyable,
            Id.isDeprecated,
            Id.isDisabled,
            Id.isFinalClass,
            Id.isFinalFunction,
            Id.isFloating,
            Id.isFuture,
            Id.isIntegral,
            Id.isLazy,
            Id.isModule,
            Id.isNested,
            Id.isOut,
            Id.isOverrideFunction,
            Id.isPackage,
            Id.isPOD,
            Id.isRef,
            Id.isReturnOnStack,
            Id.isSame,
            Id.isScalar,
            Id.isStaticArray,
            Id.isStaticFunction,
            Id.isUnsigned,
            Id.isVirtualFunction,
            Id.isVirtualMethod,
            Id.isZeroInit,
            Id.parameters,
            Id.parent,
        ];

        // D `__gshared Identifier*[60] idents`: the array holds ADDRESSES of the `Id` fields so the
        // table can be built after `Id.initialize()`; reading the fields here, on first use, is the
        // same late binding.
        traitsStringTable._init(idents.length);

        for (const id of idents) {
            const sv = traitsStringTable.insert(id!.toString(), true);
            assert(sv !== null);
        }
    }

    const trait_search_fp = (seed: DString, cost: Ref<number>): DString | null => {
        //printf("trait_search_fp('%s')\n", seed);
        if (seed.length === 0)
            return null;
        cost.value = 0;       // all the same cost
        const sv = traitsStringTable.lookup(seed);
        return sv !== null ? sv.toString() : null;
    };

    const sub = speller<DString>(e.ident!.toString(), trait_search_fp);
    if (sub !== null)
        error(e.loc, ds("unrecognized trait `%s`, did you mean `%.*s`?"), e.ident!.toChars(), sub.length, sub);
    else
        error(e.loc, ds("unrecognized trait `%s`"), e.ident!.toChars());
}
