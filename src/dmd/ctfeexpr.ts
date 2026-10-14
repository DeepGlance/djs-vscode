// Ported from dmd/ctfeexpr.d (module dmd.ctfeexpr) — "CTFE for expressions involving pointers, slices,
// array concatenation etc."
//
// FULL-FILE TRANSLATION (P5.0 wave 12). Every top-level D declaration of ctfeexpr.d is present here, in
// SOURCE ORDER, translated / walled (11 §2.5) / dropped-with-comment (07). ctfeexpr.d has no `unittest`
// blocks and declares NO class: `CTFEExp`, `ClassReferenceExp`, `ThrownExceptionExp` and `VoidInitExp`
// are declared in expression.d and live in expression.ts (04 §6 homes) — this file only uses them.
// No visitor (`grep -c 'class .*Visitor' dmd/ctfeexpr.d` -> 0).
//
// UnionExp / emplaceExp (02 §11.1). `UnionExp` is the one-reference class of 02 §11.1; both `emplaceExp`
// templates (ctfeexpr.d:104, :114) collapse into `ue.emplace(...)` at every call site:
// `emplaceExp!(T)(&ue, args)` -> `ue.emplace(new T(args))`; `emplaceExp!(UnionExp)(&ue, e)` -> `ue.emplace(e.copy())`,
// because that D form is a `memcpy` of `e.size` bytes — a shallow clone, byte-identical to `Expression.copy()`
// (expression.d:178) — so later writes through `ue.exp()` must not reach `e`; and `*pue = <UnionExp call>` ->
// `pue.emplace(<call>.exp())` (the returned wrapper is always fresh).
//
// `Compiler.paintAsType` is a live import from compiler.ts. `ctfeEmplaceExp`, `getValue` and `incArrayAllocs`
// (dinterpret.d) are live imports from dinterpret.ts. The constfold.d entries (`Slice`, `Cat`, `Cast`,
// `ArrayLength`, `sliceCmp*`, `sliceAssign*`) are live imports from constfold.ts.
//
// STRING PAYLOAD. `StringExp`'s payload is one byte buffer of `len * sz` bytes, code units little-endian, with
// `sz` selecting the width (11 §3.5, expression.ts class doc). Byte buffers built here are handed to the
// `StringExp` constructor exactly as D hands it a `const(void)[]` byte slice; where D writes code units through
// a reinterpreting pointer cast (`(cast(wchar*)s)[i] = ...`) the port writes through a typed view of the same
// bytes. ctfeCat's `Port.valcpy` stores are the ported little-endian byte helper.
//
// dropped: `import core.stdc.stdio;` / `core.stdc.string;` (ctfeexpr.d:14-15) — `printf` maps to `dmdformat` +
// `process.stdout.write` (10 §3.5 / §4.4); `memcpy`/`memset` over JS buffers are `set`/`fill`.
// dropped: `import dmd.root.rmem;` (ctfeexpr.d:36) — `mem.xmalloc`/`xcalloc` become JS buffer allocations (08 §13).

import { assert, assertUnreachable } from "../assert.js";
import { ds, dsToJs } from "../dstring.js";
import { toInt64, toUint64, toInt32, toUint8, toUint16, maskSignedN, maskUnsignedN } from "../numeric.js";
import {
    Expression, IntegerExp, StringExp, ArrayLiteralExp, AssocArrayLiteralExp, StructLiteralExp, NullExp,
    SliceExp, IndexExp, AddrExp, DotVarExp, ClassReferenceExp, CTFEExp, SymOffExp, VoidInitExp, OwnedBy,
} from "./expression.js";
import type { ThrownExceptionExp } from "./expression.js";
import { Array as DArray } from "./root/array.js"; // value: `new Expressions(n)` (08 §3)
import type { Expressions } from "./arraytypes.js";
import { EXP } from "./tokens.js";
import { TY, MATCH } from "./astenums.js";
import { Type, Covariant } from "./mtype.js";
import type { TypeAArray, TypeArray } from "./mtype.js";
import {
    toBasetype, nextOf, size, isIntegral, isScalar, isString, isReal, isImaginary, isFloating, isUnsigned,
    isComplex, constConv, unSharedOf, covariant, baseElemOf, castMod, mutableOf,
    implicitConvToWithoutAliasThisClass, defaultInitLiteral,
} from "./typesem.js";
import { implicitConvToType } from "./dcast.js";
import {
    Slice, Cat, Cast, ArrayLength, sliceCmpStringWithString, sliceCmpStringWithArray, sliceAssignStringFromString,
    sliceAssignArrayLiteralFromString, sliceAssignStringFromArrayLiteral,
} from "./constfold.js";
import {
    toInteger, toReal, toImaginary, toComplex, toStringExp, toBool, isIdentical,
    getFieldIndexFromClassReferenceExp, getFieldIndexFromStructLiteralExp,
} from "./expressionsem.js";
import { isType } from "./dtemplate.js";
import { error, errorSupplemental } from "./errors.js";
import { CTFloat } from "./root/ctfloat.js";
import type { real_t } from "./root/ctfloat.js";
import { Port } from "./root/port.js";
import { BitArray } from "./root/bitarray.js";
import { dmdformat } from "./root/dmdformat.js"; // value: showCtfeExpr's printf (10 §3.5)
import { Loc } from "./location.js";
import type { dinteger_t, sinteger_t, uinteger_t } from "./globals.js";
import type { StructDeclaration } from "./dstruct.js";
import type { ClassDeclaration } from "./dclass.js";
import type { Declaration, VarDeclaration } from "./declaration.js";
import type { FuncDeclaration } from "./func.js";
// last (01 §4.8): dinterpret.ts value-imports this module back (the D pair ctfeexpr <-> dinterpret); every use
// below is call-time, inside function bodies, so neither module reads the other's bindings at load.
import { ctfeEmplaceExp, getValue, incArrayAllocs } from "./dinterpret.js";
// ctfeexpr.d:965 `Compiler.paintAsType` (dmd.compiler); LAST (01 §4.8).
import { Compiler } from "./compiler.js";

/// A single mutable cell standing in for a D `T*` out-parameter over a value (03 §7.2 box pattern).
interface Ref<T> {
    value: T;
}

/****************************************************************/
/**
 * dmd/ctfeexpr.d:45 — `extern (D) struct UnionExp`.
 *
 * A type meant as a union of all the Expression types, to serve essentially as a Variant that will sit on
 * the stack during CTFE to reduce memory consumption. Ported by the canonical mapping of 02 §11.1: the
 * value-storage optimization collapses to ONE `Expression` reference (the in-place/stack aspect is
 * irrelevant under GC). Construct with `new UnionExp()` (D `UnionExp ue = void;` / `UnionExp ue;`), fill
 * with `emplace`, read with `exp()`, detach with `copy()`.
 */
export class UnionExp {
    // dmd/ctfeexpr.d:78-101 — the private `align(8) union _AnonStruct_u` of
    // `char[__traits(classInstanceSize, X)]` members VANISHES (02 §11.1): sizing is meaningless under GC.
    private e!: Expression;

    // dmd/ctfeexpr.d:48 — `extern (D) this(Expression e) nothrow` (body `memcpy(&this, cast(void*)e, e.size)`)
    // has no D caller; 02 §11.1 maps its effect (a shallow clone) to `emplace(e.copy())` at the call site, so no
    // constructor is emitted.

    /// `emplaceExp!(T)(&ue, args...)` -> `ue.emplace(new T(args...))` (02 §11.1).
    emplace(x: Expression): void {
        this.e = x;
    }

    /// dmd/ctfeexpr.d:55 — Extract pointer to Expression. D returns `cast(Expression)&u`; here the reference.
    exp(): Expression {
        return this.e;
    }

    /// dmd/ctfeexpr.d:62 — Convert to an allocated Expression. The five CTFE sentinel ops answer their
    /// `CTFEExp` singleton (never a copy); every other op a shallow `Expression.copy()`.
    copy(): Expression {
        const e = this.exp();
        //if (e.size > sizeof(u)) printf("%s\n", EXPtoString(e.op).ptr);
        // dropped: `assert(e.size <= u.sizeof)` (ctfeexpr.d:66) — storage size check, no fixed buffer (02 §11.1)
        switch (e.op) {
            case EXP.cantExpression: return CTFEExp.cantexp!;
            case EXP.voidExpression: return CTFEExp.voidexp!;
            case EXP.break_:         return CTFEExp.breakexp!;
            case EXP.continue_:      return CTFEExp.continueexp!;
            case EXP.goto_:          return CTFEExp.gotoexp!;
            default:                 return e.copy();
        }
    }
}

// dropped: `void emplaceExp(T : Expression, Args...)(void* p, Args args)` (ctfeexpr.d:104) — collapsed by
// 02 §11.1 into `ue.emplace(new T(args...))` at every call site; no free function remains.
// dropped: `void emplaceExp(T : UnionExp)(T* p, Expression e)` (ctfeexpr.d:114) — collapsed by 02 §11.1 into
// `ue.emplace(e.copy())` at every call site (the memcpy is a shallow clone).

/**
 * dmd/ctfeexpr.d:120 — Generate an error message when this exception is not caught.
 */
export function generateUncaughtError(tee: ThrownExceptionExp): void {
    const ue = new UnionExp(); // `UnionExp ue = void;`
    const e = resolveSlice(tee.thrown!.value!.elements!.opIndex(0)!, ue);
    const se = toStringExp(e);
    error(tee.thrown!.loc, ds("uncaught CTFE exception `%s(%s)`"), tee.thrown!.type!.toChars(),
        se !== null ? se.toChars() : e.toChars());
    /* Also give the line where the throw statement was. We won't have it
     * in the case where the ThrowStatement is generated internally
     * (eg, in ScopeStatement)
     */
    if (tee.loc.isValid() && !tee.loc.equals(tee.thrown!.loc))
        errorSupplemental(tee.loc, ds("thrown from here"));
}

/*************************
 * dmd/ctfeexpr.d:139 — Same as getFieldIndex, but checks for a direct match with the VarDeclaration.
 * Returns:
 *    index of the field, or -1 if not found
 */
export function findFieldIndexByName(sd: StructDeclaration, v: VarDeclaration): number {
    for (let i = 0; i < sd.fields.length; i++) {
        const field = sd.fields.opIndex(i);
        if (field === v)
            return toInt32(i); // `cast(int)i`
    }
    return -1;
}

/// dmd/ctfeexpr.d:150 — True if 'e' is CTFEExp::cantexp, or an exception.
export function exceptionOrCantInterpret(e: Expression | null): boolean {
    return e !== null && (e.op === EXP.cantExpression || e.op === EXP.thrownException || e.op === EXP.showCtfeContext);
}

/************** Aggregate literals (AA/string/array/struct) ******************/
/// dmd/ctfeexpr.d:158 — Given expr, which evaluates to an array/AA/string literal,
/// return true if it needs to be copied.
export function needToCopyLiteral(expr: Expression): boolean {
    let e = expr; // `cast()expr`
    for (;;) {
        switch (e.op) {
            case EXP.arrayLiteral:
                return e.isArrayLiteralExp()!.ownedByCtfe === OwnedBy.code;
            case EXP.assocArrayLiteral:
                return e.isAssocArrayLiteralExp()!.ownedByCtfe === OwnedBy.code;
            case EXP.structLiteral:
                return e.isStructLiteralExp()!.ownedByCtfe === OwnedBy.code;
            case EXP.string_:
            case EXP.this_:
            case EXP.variable:
                return false;
            case EXP.assign:
                return false;
            case EXP.index:
            case EXP.dotVariable:
            case EXP.slice:
            case EXP.cast_:
                e = e.isUnaExp()!.e1!;
                continue;
            case EXP.concatenate:
                return needToCopyLiteral(e.isBinExp()!.e1!) || needToCopyLiteral(e.isBinExp()!.e2!);
            case EXP.concatenateAssign:
            case EXP.concatenateElemAssign:
            case EXP.concatenateDcharAssign:
                e = e.isBinExp()!.e2!;
                continue;
            default:
                return false;
        }
    }
}

/// dmd/ctfeexpr.d:196 — `private Expressions* copyLiteralArray(Expressions* oldelems, Expression basis = null)`.
function copyLiteralArray(oldelems: Expressions | null, basis: Expression | null = null): Expressions | null {
    if (oldelems === null)
        return oldelems;
    incArrayAllocs();
    const newelems: Expressions = new DArray<Expression | null>(oldelems.length);
    for (let i = 0; i < oldelems.length; i++) {
        const el = oldelems.opIndex(i);
        newelems.opIndexAssign(copyLiteral(el !== null ? el : basis!).copy(), i);
    }
    return newelems;
}

/**
 * dmd/ctfeexpr.d:211 — Make a copy of the ArrayLiteral, AALiteral, String, or StructLiteral.
 * This value will be used for in-place modification.
 */
export function copyLiteral(e: Expression): UnionExp {
    let ue = new UnionExp(); // `UnionExp ue = void;`
    { // D `if (auto se = e.isStringExp())` scopes `se` to the branch; the block keeps it there (06 §2.6)
        const se = e.isStringExp();
        if (se !== null) { // syntaxCopy doesn't make a copy for StringExp!
            // `mem.xcalloc(se.len + 1, se.sz)` -> a zero-filled JS byte buffer (08 §13).
            const s = new Uint8Array((se.len + 1) * se.sz);
            const slice = se.peekData();
            s.set(slice, 0); // `memcpy(s, slice.ptr, slice.length)`
            // `s[0 .. se.len * se.sz]`: the payload is the first len * sz bytes; the zeroed terminator unit past
            // them stays in the buffer, as in D's allocation (expression.ts class doc).
            ue.emplace(new StringExp(se.loc, Array.from(s), se.len, se.sz));
            const se2 = ue.exp().isStringExp()!;
            se2.committed = se.committed;
            se2.postfix = se.postfix;
            se2.type = se.type;
            se2.ownedByCtfe = OwnedBy.ctfe;
            return ue;
        }
    }
    const ale = e.isArrayLiteralExp();
    if (ale !== null) {
        const elements = copyLiteralArray(ale.elements, ale.basis);

        ue.emplace(new ArrayLiteralExp(e.loc, e.type, elements));

        const r = ue.exp().isArrayLiteralExp()!;
        r.ownedByCtfe = OwnedBy.ctfe;
        return ue;
    }
    const aae = e.isAssocArrayLiteralExp();
    if (aae !== null) {
        ue.emplace(new AssocArrayLiteralExp(aae.loc, copyLiteralArray(aae.keys), copyLiteralArray(aae.values)));
        const r = ue.exp().isAssocArrayLiteralExp()!;
        r.type = aae.type;
        r.lowering = aae.lowering;
        r.loweringCtfe = aae.loweringCtfe;
        r.ownedByCtfe = OwnedBy.ctfe;
        return ue;
    }
    const sle = e.isStructLiteralExp();
    if (sle !== null) {
        /* syntaxCopy doesn't work for struct literals, because of a nasty special
         * case: block assignment is permitted inside struct literals, eg,
         * an int[4] array can be initialized with a single int.
         */
        const oldelems = sle.elements!;
        const newelems: Expressions = new DArray<Expression | null>(oldelems.length);
        for (let i = 0; i < newelems.length; i++) { // `foreach (i, ref el; *newelems)`
            // We need the struct definition to detect block assignment
            const v = sle.sd!.fields.opIndex(i)!;
            let m = oldelems.opIndex(i);

            // If it is a void assignment, use the default initializer
            if (m === null)
                m = voidInitLiteral(v.type!, v).copy();

            if (v.type!.ty === TY.Tarray || v.type!.ty === TY.Taarray) {
                // Don't have to copy array references
            } else {
                // Buzilla 15681: Copy the source element always.
                m = copyLiteral(m).copy();

                // Block assignment from inside struct literals
                if (v.type!.ty !== m.type!.ty && v.type!.ty === TY.Tsarray) {
                    const tsa = v.type!.isTypeSArray()!;
                    // `cast(size_t)tsa.dim.toInteger()` — a static-array dim stepped down into the
                    // index/length domain (09 §1.1); it fits and is not a sentinel (09 §1.3.1).
                    const len = Number(toInteger(tsa.dim!));
                    m = createBlockDuplicatedArrayLiteral(ue, e.loc, v.type!, m, len);
                    if (m === ue.exp())
                        m = ue.copy();
                }
            }
            newelems.opIndexAssign(m, i); // `el = m;`
        }
        ue.emplace(new StructLiteralExp(e.loc, sle.sd, newelems, sle.stype));
        const r = ue.exp().isStructLiteralExp()!;
        r.type = e.type;
        r.ownedByCtfe = OwnedBy.ctfe;
        r.origin = sle.origin;
        return ue;
    }

    switch (e.op) {
        case EXP.function_:
        case EXP.delegate_:
        case EXP.symbolOffset:
        case EXP.null_:
        case EXP.variable:
        case EXP.dotVariable:
        case EXP.int64:
        case EXP.float64:
        case EXP.complex80:
        case EXP.void_:
        case EXP.vector:
        case EXP.typeid_: {
            // Simple value types
            // Keep e1 for DelegateExp and DotVarExp
            ue.emplace(e.copy()); // `emplaceExp!(UnionExp)(&ue, e)`: a memcpy clone (02 §11.1)
            const r = ue.exp();
            r.type = e.type;
            return ue;
        }
        default:
            break;
    }

    const se = e.isSliceExp();
    if (se !== null) {
        if (toBasetype(se.type!).ty === TY.Tsarray) {
            // same with resolveSlice()
            if (se.e1!.op === EXP.null_) {
                ue.emplace(new NullExp(se.loc, se.type));
                return ue;
            }
            ue = Slice(se.type!, se.e1!, se.lwr, se.upr);
            const r = ue.exp().isArrayLiteralExp()!;
            r.elements = copyLiteralArray(r.elements);
            r.ownedByCtfe = OwnedBy.ctfe;
            return ue;
        } else {
            // Array slices only do a shallow copy
            ue.emplace(new SliceExp(e.loc, se.e1, se.lwr, se.upr));
            const r = ue.exp();
            r.type = e.type;
            return ue;
        }
    }
    if (isPointer(e.type!)) {
        // For pointers, we only do a shallow copy.
        const ae = e.isAddrExp();
        if (ae !== null)
            ue.emplace(new AddrExp(e.loc, ae.e1));
        else {
            const ie = e.isIndexExp();
            if (ie !== null)
                ue.emplace(new IndexExp(e.loc, ie.e1, ie.e2));
            else {
                const dve = e.isDotVarExp();
                if (dve !== null) {
                    ue.emplace(new DotVarExp(e.loc, dve.e1, dve.var_, dve.hasOverloads));
                } else
                    assertUnreachable();
            }
        }

        const r = ue.exp();
        r.type = e.type;
        return ue;
    }
    const cre = e.isClassReferenceExp();
    if (cre !== null) {
        ue.emplace(new ClassReferenceExp(e.loc, cre.value!, e.type));
        return ue;
    }
    if (e.op === EXP.error) {
        ue.emplace(e.copy()); // `emplaceExp!(UnionExp)(&ue, e)`: a memcpy clone (02 §11.1)
        return ue;
    }
    error(e.loc, ds("CTFE internal error: literal `%s`"), e.toChars());
    assertUnreachable();
}

/* Deal with type painting.
 * Type painting is a major nuisance: we can't just set
 * e.type = type, because that would change the original literal.
 * But, we can't simply copy the literal either, because that would change
 * the values of any pointers.
 */
/**
 * dmd/ctfeexpr.d:380 — `Expression paintTypeOntoLiteral(Type type, Expression lit)`.
 *
 * Overload set (04 §1 Form B): `paintTypeOntoLiteral(Type, Expression)` (:380) and
 * `paintTypeOntoLiteral(UnionExp*, Type, Expression)` (:387) differ by the LEADING `pue`, so arity dispatch
 * (Form A, trailing prefix) is impossible. Rule 1: both have cross-module callers (dinterpret.d), the `pue`
 * form is the most called (6 dinterpret + 2 in-module vs 3), so it keeps the bare name; this form, which
 * LACKS the parameter, takes the `NoPue` suffix — the mirror of 04 §1.1(a)'s `NoLoc`.
 */
export function paintTypeOntoLiteralNoPue(type: Type, lit: Expression): Expression {
    if (lit.type!.equals(type))
        return lit;
    return paintTypeOntoLiteralCopy(type, lit).copy();
}

/// dmd/ctfeexpr.d:387 — `Expression paintTypeOntoLiteral(UnionExp* pue, Type type, Expression lit)`
/// (the bare-name member of the Form-B pair; see `paintTypeOntoLiteralNoPue`).
export function paintTypeOntoLiteral(pue: UnionExp, type: Type, lit: Expression): Expression {
    if (lit.type!.equals(type))
        return lit;
    pue.emplace(paintTypeOntoLiteralCopy(type, lit).exp()); // `*pue = paintTypeOntoLiteralCopy(type, lit);`
    return pue.exp();
}

/// dmd/ctfeexpr.d:395 — `private UnionExp paintTypeOntoLiteralCopy(Type type, Expression lit)`.
function paintTypeOntoLiteralCopy(type: Type, lit: Expression): UnionExp {
    let ue = new UnionExp(); // `UnionExp ue;`
    if (lit.type!.equals(type)) {
        ue.emplace(lit.copy()); // `emplaceExp!(UnionExp)(&ue, lit)`: a memcpy clone (02 §11.1)
        return ue;
    }
    // If it is a cast to inout, retain the original type of the referenced part.
    if (type.hasWild() !== 0) {
        ue.emplace(lit.copy()); // `emplaceExp!(UnionExp)(&ue, lit)`: the repaint below reaches the clone only
        ue.exp().type = type;
        return ue;
    }
    const se = lit.isSliceExp();
    if (se !== null) {
        ue.emplace(new SliceExp(lit.loc, se.e1, se.lwr, se.upr));
    } else {
        const ie = lit.isIndexExp();
        if (ie !== null) {
            ue.emplace(new IndexExp(lit.loc, ie.e1, ie.e2));
        } else {
            if (lit.op === EXP.arrayLiteral) {
                ue.emplace(new SliceExp(lit.loc, lit,
                    ctfeEmplaceExp(() => new IntegerExp(Loc.initial, 0n, Type.tsize_t)),
                    ArrayLength(Type.tsize_t, lit).copy()));
            } else if (lit.op === EXP.string_) {
                // For strings, we need to introduce another level of indirection
                ue.emplace(new SliceExp(lit.loc, lit,
                    ctfeEmplaceExp(() => new IntegerExp(Loc.initial, 0n, Type.tsize_t)),
                    ArrayLength(Type.tsize_t, lit).copy()));
            } else {
                let aae = lit.isAssocArrayLiteralExp();
                if (aae !== null) {
                    // TODO: we should be creating a reference to this AAExp, not
                    // just a ref to the keys and values.
                    const wasOwned = aae.ownedByCtfe;
                    ue.emplace(new AssocArrayLiteralExp(lit.loc, aae.keys, aae.values));
                    aae = ue.exp().isAssocArrayLiteralExp()!;
                    aae.ownedByCtfe = wasOwned;
                } else {
                    // Can't type paint from struct to struct*; this needs another
                    // level of indirection
                    if (lit.op === EXP.structLiteral && isPointer(type))
                        error(lit.loc, ds("CTFE internal error: painting `%s`"), type.toChars());
                    ue = copyLiteral(lit);
                }
            }
        }
    }
    ue.exp().type = type;
    return ue;
}

/*************************************
 * dmd/ctfeexpr.d:456 — If e is a SliceExp, constant fold it.
 * Params:
 *      e = expression to resolve
 *      pue = if not null, store resulting expression here
 * Returns:
 *      resulting expression
 */
export function resolveSlice(e: Expression, pue: UnionExp | null = null): Expression {
    const se = e.isSliceExp();
    if (se === null)
        return e;
    if (se.e1!.op === EXP.null_)
        return se.e1!;
    if (pue !== null) {
        pue.emplace(Slice(e.type!, se.e1!, se.lwr, se.upr).exp()); // `*pue = Slice(e.type, se.e1, se.lwr, se.upr);`
        return pue.exp();
    }
    return Slice(e.type!, se.e1!, se.lwr, se.upr).copy();
}

/* dmd/ctfeexpr.d:476 — Determine the array length, without interpreting it.
 * e must be an array literal, or a slice
 * It's very wasteful to resolve the slice when we only
 * need the length.
 */
export function resolveArrayLength(e: Expression): uinteger_t {
    switch (e.op) {
        case EXP.vector:
            return BigInt(e.isVectorExp()!.dim);

        case EXP.null_:
            return 0n;

        case EXP.slice: {
            const se = e.isSliceExp()!;
            const ilo = toInteger(se.lwr!);
            const iup = toInteger(se.upr!);
            return toUint64(iup - ilo); // `ulong` subtraction wraps mod 2^64 (09 §3)
        }

        case EXP.string_:
            return BigInt(e.isStringExp()!.len);

        case EXP.arrayLiteral: {
            const ale = e.isArrayLiteralExp()!;
            return BigInt(ale.elements !== null ? ale.elements.length : 0);
        }

        case EXP.assocArrayLiteral: {
            return BigInt(e.isAssocArrayLiteralExp()!.keys!.length);
        }

        default:
            assertUnreachable();
    }
}

/******************************
 * dmd/ctfeexpr.d:525 — Helper for NewExp
 * Create an array literal consisting of 'elem' duplicated 'dim' times.
 * Params:
 *      pue = where to store result
 *      loc = source location where the interpretation occurs
 *      type = target type of the result
 *      elem = the source of array element, it will be owned by the result
 *      dim = element number of the result
 * Returns:
 *      Constructed ArrayLiteralExp
 */
export function createBlockDuplicatedArrayLiteral(pue: UnionExp, loc: Loc, type: Type, elem: Expression,
                                                  dim: number): ArrayLiteralExp {
    if (type.ty === TY.Tsarray && nextOf(type)!.ty === TY.Tsarray && elem.type!.ty !== TY.Tsarray) {
        // If it is a multidimensional array literal, do it recursively
        const tsa = nextOf(type)!.isTypeSArray()!;
        // `cast(size_t)tsa.dim.toInteger()` — index/length domain (09 §1.1), not a sentinel.
        const len = Number(toInteger(tsa.dim!));
        elem = createBlockDuplicatedArrayLiteral(pue, loc, nextOf(type)!, elem, len);
        if (elem === pue.exp())
            elem = pue.copy();
    }

    // Buzilla 15681
    const tb = toBasetype(elem.type!);
    const mustCopy = tb.ty === TY.Tstruct || tb.ty === TY.Tsarray;

    const elements: Expressions = new DArray<Expression | null>(dim);
    for (let i = 0; i < elements.length; i++) { // `foreach (i, ref el; *elements)`
        elements.opIndexAssign(mustCopy && i !== 0 ? copyLiteral(elem).copy() : elem, i);
    }
    pue.emplace(new ArrayLiteralExp(loc, type, elements));
    const ale = pue.exp().isArrayLiteralExp()!;
    ale.ownedByCtfe = OwnedBy.ctfe;
    return ale;
}

/******************************
 * dmd/ctfeexpr.d:556 — Helper for NewExp
 * Create a string literal consisting of 'value' duplicated 'dim' times.
 */
export function createBlockDuplicatedStringLiteral(pue: UnionExp, loc: Loc, type: Type, value: number, dim: number,
                                                   sz: number): StringExp {
    // `mem.xcalloc(dim, sz)` -> a zero-filled JS byte buffer (08 §13).
    const s = new Uint8Array(dim * sz);
    // The wider arms write one code unit of width `sz` into the byte buffer, little-endian: the StringExp
    // payload model (expression.ts class doc). One view of the buffer serves the whole loop: only the arm
    // that `sz` selects reads it, and a view of the other widths may not fit the buffer's length.
    const s16 = sz === 2 ? new Uint16Array(s.buffer) : null;
    const s32 = sz === 4 ? new Uint32Array(s.buffer) : null;
    const s64 = sz === 8 ? new BigUint64Array(s.buffer) : null;
    for (let elemi = 0; elemi < dim; elemi++) {
        switch (sz) {
            case 1:
                s[elemi] = toUint8(value); // `cast(char)value` (09 §2)
                break;
            case 2:
                s16![elemi] = toUint16(value); // `(cast(wchar*)s)[elemi] = cast(wchar)value;`
                break;
            case 4:
                s32![elemi] = value; // `(cast(dchar*)s)[elemi] = value;`
                break;
            case 8:
                s64![elemi] = BigInt(value); // `(cast(ulong*)s)[elemi] = value;`
                break;
            default:
                assertUnreachable();
        }
    }
    pue.emplace(new StringExp(loc, Array.from(s), dim, sz)); // `s[0 .. dim * sz]`
    const se = pue.exp().isStringExp()!;
    se.type = type;
    se.committed = true;
    se.ownedByCtfe = OwnedBy.ctfe;
    return se;
}

/// dmd/ctfeexpr.d:588 — Return true if t is an AA.
export function isAssocArray(t: Type): boolean {
    return toBasetype(t).isTypeAArray() !== null;
}

/// dmd/ctfeexpr.d:594 — Given a template AA type, extract the corresponding built-in AA type.
export function toBuiltinAAType(t: Type): TypeAArray | null {
    return toBasetype(t).isTypeAArray();
}

/************** TypeInfo operations ************************************/
/// dmd/ctfeexpr.d:601 — Return true if type is TypeInfo_Class.
export function isTypeInfo_Class(type: Type): boolean {
    const tc = type.isTypeClass(); // `cast()type.isTypeClass()`
    return tc !== null && (Type.dtypeinfo === tc.sym || Type.dtypeinfo.isBaseOf(tc.sym, null));
}

/************** Pointer operations ************************************/
/// dmd/ctfeexpr.d:609 — Return true if t is a pointer (not a function pointer).
export function isPointer(t: Type): boolean {
    const tb = toBasetype(t);
    return tb.ty === TY.Tpointer && nextOf(tb)!.ty !== TY.Tfunction;
}

/// dmd/ctfeexpr.d:616 — For CTFE only. Returns true if 'e' is true or a non-null pointer.
export function isTrueBool(e: Expression): boolean {
    return toBool(e).hasValue(true) || ((e.type!.ty === TY.Tpointer || e.type!.ty === TY.Tclass) && e.op !== EXP.null_);
}

/* dmd/ctfeexpr.d:625 — Is it safe to convert from srcPointee* to destPointee* ?
 * srcPointee is the genuine type (never void).
 * destPointee may be void.
 */
export function isSafePointerCast(srcPointee: Type, destPointee: Type): boolean {
    // It's safe to cast S** to D** if it's OK to cast S* to D*
    while (srcPointee.ty === TY.Tpointer && destPointee.ty === TY.Tpointer) {
        srcPointee = nextOf(srcPointee)!;
        destPointee = nextOf(destPointee)!;
    }
    // It's OK if both are the same (modulo const)
    if (constConv(srcPointee, destPointee) !== MATCH.nomatch)
        return true;

    // It's ok to cast from/to shared because CTFE is single threaded anyways
    if (unSharedOf(srcPointee) === unSharedOf(destPointee))
        return true;

    // It's OK if function pointers differ only in safe/pure/nothrow
    if (srcPointee.ty === TY.Tfunction && destPointee.ty === TY.Tfunction) {
        return covariant(srcPointee, destPointee) === Covariant.yes ||
            covariant(destPointee, srcPointee) === Covariant.yes;
    }
    // it's OK to cast to void*
    if (destPointee.ty === TY.Tvoid)
        return true;
    // It's OK to cast from V[K] to void*
    if (srcPointee.ty === TY.Taarray && destPointee === Type.tvoidptr)
        return true;
    // It's OK if they are the same size (static array of) integers, eg:
    //     int*     --> uint*
    //     int[5][] --> uint[5][]
    if (srcPointee.ty === TY.Tsarray && destPointee.ty === TY.Tsarray) {
        if (size(srcPointee) !== size(destPointee))
            return false;
        srcPointee = baseElemOf(srcPointee);
        destPointee = baseElemOf(destPointee);
    }
    return isIntegral(srcPointee) && isIntegral(destPointee) && size(srcPointee) === size(destPointee);
}

/**
 * dmd/ctfeexpr.d:666 — `Expression getAggregateFromPointer(Expression e, dinteger_t* ofs)`.
 * `ofs` is the out-box (03 §7.2); it receives the offset as the UNSIGNED 64-bit carrier (`toUint64`), the
 * representation of D's `dinteger_t` value (09 §0), so later `ulong` comparisons read the right bits.
 */
export function getAggregateFromPointer(e: Expression, ofs: Ref<dinteger_t>): Expression {
    ofs.value = 0n;
    const ae = e.isAddrExp();
    if (ae !== null)
        e = ae.e1!;
    const soe = e.isSymOffExp();
    if (soe !== null)
        ofs.value = toUint64(soe.offset);
    const dve = e.isDotVarExp();
    if (dve !== null) {
        const ex = dve.e1!;
        const v = dve.var_.isVarDeclaration();
        assert(v);
        const se: StructLiteralExp = ex.op === EXP.classReference
            ? ex.isClassReferenceExp()!.value!
            : ex.isStructLiteralExp()!;

        // We can't use getField, because it makes a copy
        const i = ex.op === EXP.classReference
            ? getFieldIndexFromClassReferenceExp(ex.isClassReferenceExp()!, e.type!, v.offset)
            : getFieldIndexFromStructLiteralExp(se, e.type!, v.offset);
        e = se.elements!.opIndex(i)!;
    }
    { // D `if (auto ie = e.isIndexExp())` scopes `ie` to the branch (06 §2.6); a second `ie` follows below
        const ie = e.isIndexExp();
        if (ie !== null) {
            // Note that each AA element is part of its own memory block
            const e1 = ie.e1!;
            if ((e1.type!.isStaticOrDynamicArray() || e1.op === EXP.string_ || e1.op === EXP.arrayLiteral) &&
                ie.e2!.op === EXP.int64) {
                ofs.value = toUint64(toInteger(ie.e2!));
                return ie.e1!;
            }
        }
    }
    const se = e.isSliceExp();
    if (se !== null) {
        const e1 = se.e1!;
        if (se !== null && toBasetype(e.type!).ty === TY.Tsarray &&
            (e1.type!.isStaticOrDynamicArray() || e1.op === EXP.string_ || e1.op === EXP.arrayLiteral) &&
            se.lwr!.op === EXP.int64) {
            ofs.value = toUint64(toInteger(se.lwr!));
            return se.e1!;
        }
    }

    // It can be a `null` disguised as a cast, e.g. `cast(void*)0`.
    const ie = e.isIntegerExp();
    if (ie !== null)
        if (ie.type!.ty === TY.Tpointer && ie.getInteger() === 0n)
            return new NullExp(ie.loc, nextOf(e.type!));
    // Those casts are invalid, but let the rest of the code handle it,
    // as it could be something like `x !is null`, which doesn't need
    // to dereference the pointer, even if the pointer is `cast(void*)420`.

    return e;
}

/** dmd/ctfeexpr.d:720 — Return true if agg1 and agg2 are pointers to the same memory block
 */
export function pointToSameMemoryBlock(agg1: Expression, agg2: Expression): boolean {
    if (agg1 === agg2)
        return true;
    // For integers cast to pointers, we regard them as non-comparable
    // unless they are identical. (This may be overly strict).
    // `agg1.toInteger() == agg2.toInteger()` compares two `ulong` carriers: bit equality (09 §0).
    if (agg1.op === EXP.int64 && agg2.op === EXP.int64 && toUint64(toInteger(agg1)) === toUint64(toInteger(agg2))) {
        return true;
    }
    // Note that type painting can occur with VarExp, so we
    // must compare the variables being pointed to.
    if (agg1.op === EXP.variable && agg2.op === EXP.variable && agg1.isVarExp()!.var_ === agg2.isVarExp()!.var_) {
        return true;
    }
    if (agg1.op === EXP.symbolOffset && agg2.op === EXP.symbolOffset &&
        agg1.isSymOffExp()!.var_ === agg2.isSymOffExp()!.var_) {
        return true;
    }
    return false;
}

/// dmd/ctfeexpr.d:744 — return e1 - e2 as an integer, or error if not possible.
export function pointerDifference(pue: UnionExp, loc: Loc, type: Type, e1: Expression, e2: Expression): Expression {
    const ofs1: Ref<dinteger_t> = { value: 0n };
    const ofs2: Ref<dinteger_t> = { value: 0n };
    const agg1 = getAggregateFromPointer(e1, ofs1);
    const agg2 = getAggregateFromPointer(e2, ofs2);
    if (agg1 === agg2) {
        const pointee = nextOf(agg1.type!)!;
        const sz = size(pointee);
        // raw carrier product; the IntegerExp ctor normalizes it to `type` (09 §2.2)
        pue.emplace(new IntegerExp(loc, (ofs1.value - ofs2.value) * sz, type));
    } else if (agg1.op === EXP.string_ && agg2.op === EXP.string_ &&
               // `peekString().ptr ==`: a view's `.ptr` is its payload's base, i.e. the byte buffer's identity
               // (each payload owns its buffer; copies of a node share it, as D copies share the pointer).
               // peekString keeps D's `assert(sz == 1)`, so two distinct wstring/dstring nodes reach an
               // AssertError here, as in a debug-built dmd; ldc2's release build drops the assert and returns
               // the difference — a known gap (10 §2.2: asserts are never elided).
               agg1.isStringExp()!.peekString().buffer === agg2.isStringExp()!.peekString().buffer) {
        const pointee = nextOf(agg1.type!)!;
        const sz = size(pointee);
        pue.emplace(new IntegerExp(loc, (ofs1.value - ofs2.value) * sz, type));
    } else if (agg1.op === EXP.symbolOffset && agg2.op === EXP.symbolOffset &&
               agg1.isSymOffExp()!.var_ === agg2.isSymOffExp()!.var_) {
        pue.emplace(new IntegerExp(loc, ofs1.value - ofs2.value, type));
    } else {
        error(loc, ds("`%s - %s` cannot be interpreted at compile time: " +
            "cannot subtract pointers to two different memory blocks"), e1.toChars(), e2.toChars());
        pue.emplace(new CTFEExp(EXP.cantExpression));
    }
    return pue.exp();
}

/// dmd/ctfeexpr.d:777 — Return eptr op e2, where eptr is a pointer, e2 is an integer,
/// and op is EXP.add or EXP.min.
export function pointerArithmetic(pue: UnionExp, loc: Loc, op: EXP, type: Type, eptr: Expression,
                                  e2: Expression): Expression {
    const cant = (): Expression => {
        pue.emplace(new CTFEExp(EXP.cantExpression));
        return pue.exp();
    };
    if (nextOf(eptr.type!)!.ty === TY.Tvoid) {
        error(loc, ds("cannot perform arithmetic on `void*` pointers at compile time"));
        return cant();
    }
    if (eptr.op === EXP.address)
        eptr = eptr.isAddrExp()!.e1!;
    const ofs1: Ref<dinteger_t> = { value: 0n };
    const agg1 = getAggregateFromPointer(eptr, ofs1);
    if (agg1.op === EXP.symbolOffset) {
        if (agg1.isSymOffExp()!.var_.type!.ty !== TY.Tsarray) {
            error(loc, ds("cannot perform pointer arithmetic on arrays of unknown length at compile time"));
            return cant();
        }
    } else if (agg1.op !== EXP.string_ && agg1.op !== EXP.arrayLiteral) {
        error(loc, ds("cannot perform pointer arithmetic on non-arrays at compile time"));
        return cant();
    }
    const ofs2: dinteger_t = toUint64(toInteger(e2));
    const pointee = nextOf(toBasetype(agg1.type!))!;
    const sz: dinteger_t = size(pointee);
    let indx: sinteger_t;
    let len: dinteger_t;
    // ZERO DIVISOR: `sz` is 0 when the pointee is a zero-length static array (`int[0]`) or `noreturn`. ldc2 divides
    // with arm64 `udiv`, which yields 0, and compiles on with no error; so does the port: every division by `sz`
    // below is `sz == 0 ? 0 : x / sz`, as at dcast.d:1483 (09 §3.1). Constant folding, CTFE's `/` and `%`
    // included, keeps its "divide by 0" error.
    const soe = agg1.isSymOffExp();
    if (soe !== null) {
        indx = toInt64(sz === 0n ? 0n : ofs1.value / sz); // `ulong / ulong` assigned to `long`
        len = toUint64(toInteger(soe.var_.type!.isTypeSArray()!.dim!));
    } else {
        const dollar = ArrayLength(Type.tsize_t, agg1).copy();
        assert(!CTFEExp.isCantExp(dollar));
        indx = toInt64(ofs1.value);
        len = toUint64(toInteger(dollar));
    }
    // `long += ulong`: computed in the `ulong` carrier, stored back as `long` (09 §3)
    if (op === EXP.add || op === EXP.addAssign || op === EXP.plusPlus) {
        indx = toInt64(indx + (sz === 0n ? 0n : ofs2 / sz));
    } else if (op === EXP.min || op === EXP.minAssign || op === EXP.minusMinus) {
        indx = toInt64(indx - (sz === 0n ? 0n : ofs2 / sz));
    } else {
        error(loc, ds("CTFE internal error: bad pointer operation"));
        return cant();
    }
    // `len < indx` is `ulong < long`: the `long` converts to `ulong` (only reached with indx >= 0 here).
    if (indx < 0n || len < toUint64(indx)) {
        // `%lld` of the `ulong` len reinterprets its bits as signed (10 §3.5): pass the signed view.
        error(loc, ds("cannot assign pointer to index %lld inside memory block `[0..%lld]`"), indx, toInt64(len));
        return cant();
    }
    if (agg1.op === EXP.symbolOffset) {
        pue.emplace(new SymOffExp(loc, agg1.isSymOffExp()!.var_, toUint64(indx * sz)));
        const se = pue.exp().isSymOffExp()!;
        se.type = type;
        return pue.exp();
    }
    if (agg1.op !== EXP.arrayLiteral && agg1.op !== EXP.string_) {
        error(loc, ds("CTFE internal error: pointer arithmetic `%s`"), agg1.toChars());
        return cant();
    }
    const tsa = toBasetype(eptr.type!).isTypeSArray();
    if (tsa !== null) {
        const dim: dinteger_t = toUint64(toInteger(tsa.dim!));
        // Create a CTFE pointer &agg1[indx .. indx+dim]
        const se = ctfeEmplaceExp(() => new SliceExp(loc, agg1,
            ctfeEmplaceExp(() => new IntegerExp(loc, indx, Type.tsize_t)),
            ctfeEmplaceExp(() => new IntegerExp(loc, indx + dim, Type.tsize_t))));
        se.type = nextOf(toBasetype(type));
        pue.emplace(new AddrExp(loc, se));
        pue.exp().type = type;
        return pue.exp();
    }
    // Create a CTFE pointer &agg1[indx]
    const ofs = ctfeEmplaceExp(() => new IntegerExp(loc, indx, Type.tsize_t));
    const ie: Expression = ctfeEmplaceExp(() => new IndexExp(loc, agg1, ofs));
    ie.type = nextOf(toBasetype(type)); // https://issues.dlang.org/show_bug.cgi?id=13992
    pue.emplace(new AddrExp(loc, ie));
    pue.exp().type = type;
    return pue.exp();
}

/**
 * dmd/ctfeexpr.d:872 — Return 1 if true, 0 if false;
 * -1 if comparison is illegal because they point to non-comparable memory blocks.
 * Contract: `ofs1`/`ofs2` are D `dinteger_t` offsets, so callers pass `toUint64` values (what
 * `getAggregateFromPointer` produces); the `<`/`>` arms compare them unsigned (09 §3.1).
 */
export function comparePointers(op: EXP, agg1: Expression, ofs1: dinteger_t, agg2: Expression,
                                ofs2: dinteger_t): number {
    if (pointToSameMemoryBlock(agg1, agg2)) {
        let n: number;
        switch (op) {
            case EXP.lessThan:
                n = ofs1 < ofs2 ? 1 : 0;
                break;
            case EXP.lessOrEqual:
                n = ofs1 <= ofs2 ? 1 : 0;
                break;
            case EXP.greaterThan:
                n = ofs1 > ofs2 ? 1 : 0;
                break;
            case EXP.greaterOrEqual:
                n = ofs1 >= ofs2 ? 1 : 0;
                break;
            case EXP.identity:
            case EXP.equal:
                n = ofs1 === ofs2 ? 1 : 0;
                break;
            case EXP.notIdentity:
            case EXP.notEqual:
                n = ofs1 !== ofs2 ? 1 : 0;
                break;
            default:
                assertUnreachable();
        }
        return n;
    }
    const null1 = agg1.op === EXP.null_;
    const null2 = agg2.op === EXP.null_;
    let cmp: number;
    if (null1 || null2) {
        switch (op) {
            case EXP.lessThan:
                cmp = null1 && !null2 ? 1 : 0;
                break;
            case EXP.greaterThan:
                cmp = !null1 && null2 ? 1 : 0;
                break;
            case EXP.lessOrEqual:
                cmp = null1 ? 1 : 0;
                break;
            case EXP.greaterOrEqual:
                cmp = null2 ? 1 : 0;
                break;
            case EXP.identity:
            case EXP.equal:
            case EXP.notIdentity: // 'cmp' gets inverted below
            case EXP.notEqual:
                cmp = null1 === null2 ? 1 : 0;
                break;
            default:
                assertUnreachable();
        }
    } else {
        switch (op) {
            case EXP.identity:
            case EXP.equal:
            case EXP.notIdentity: // 'cmp' gets inverted below
            case EXP.notEqual:
                cmp = 0;
                break;
            default:
                return -1; // memory blocks are different
        }
    }
    if (op === EXP.notIdentity || op === EXP.notEqual)
        cmp ^= 1;
    return cmp;
}

/// dmd/ctfeexpr.d:954 — True if conversion from type 'from' to 'to' involves a reinterpret_cast
/// floating point -> integer or integer -> floating point.
export function isFloatIntPaint(to: Type, from: Type): boolean {
    return size(from) === size(to) && (isIntegral(from) && isFloating(to) || isFloating(from) && isIntegral(to));
}

/// dmd/ctfeexpr.d:960 — Reinterpret float/int value 'fromVal' as a float/integer of type 'to'.
export function paintFloatInt(pue: UnionExp, fromVal: Expression, to: Type): Expression {
    if (exceptionOrCantInterpret(fromVal))
        return fromVal;
    assert(size(to) === 4n || size(to) === 8n);
    return Compiler.paintAsType(pue, fromVal, to);
}

/******** Constant folding, with support for CTFE ***************************/
/// dmd/ctfeexpr.d:971 — Return true if non-pointer expression e can be compared
/// with >,is, ==, etc, using ctfeCmp, ctfeEqual, ctfeIdentity.
export function isCtfeComparable(e: Expression): boolean {
    if (e.op === EXP.slice)
        e = e.isSliceExp()!.e1!;
    if (e.isConst() !== 1) {
        if (e.op === EXP.null_ || e.op === EXP.string_ || e.op === EXP.function_ || e.op === EXP.delegate_ ||
            e.op === EXP.arrayLiteral || e.op === EXP.structLiteral || e.op === EXP.assocArrayLiteral ||
            e.op === EXP.classReference) {
            return true;
        }
        // https://issues.dlang.org/show_bug.cgi?id=14123
        // TypeInfo object is comparable in CTFE
        if (e.op === EXP.typeid_)
            return true;
        return false;
    }
    return true;
}

/**
 * dmd/ctfeexpr.d:991 — `private bool numCmp(N)(EXP op, N n1, N n2)` — Map EXP comparison ops.
 * The D template is instantiated for `int` and `real_t` (the `number` domain) and for `dinteger_t` /
 * `sinteger_t` (the `bigint` domain); `<`/`<=`/`>`/`>=` are the same operators in both domains, so one
 * generic body serves every instantiation. The SIGNEDNESS of a 64-bit instantiation is carried by the
 * caller's carrier (`toUint64` for `dinteger_t`, `toInt64` for `sinteger_t`, 09 §3.1).
 */
function numCmp<N extends number | bigint>(op: EXP, n1: N, n2: N): boolean {
    switch (op) {
        case EXP.lessThan:
            return n1 < n2;
        case EXP.lessOrEqual:
            return n1 <= n2;
        case EXP.greaterThan:
            return n1 > n2;
        case EXP.greaterOrEqual:
            return n1 >= n2;

        default:
            assertUnreachable();
    }
}

/// dmd/ctfeexpr.d:1010 — Returns cmp OP 0; where OP is ==, !=, <, >=, etc. Result is 0 or 1.
export function specificCmp(op: EXP, rawCmp: number): boolean {
    return numCmp<number>(op, rawCmp, 0);
}

/// dmd/ctfeexpr.d:1016 — Returns e1 OP e2; where OP is ==, !=, <, >=, etc. Result is 0 or 1.
/// Contract: `n1`/`n2` are UNSIGNED 64-bit carriers (`toUint64`) — D's `dinteger_t` parameter (09 §3.1).
export function intUnsignedCmp(op: EXP, n1: dinteger_t, n2: dinteger_t): boolean {
    return numCmp<bigint>(op, n1, n2);
}

/// dmd/ctfeexpr.d:1022 — Returns e1 OP e2; where OP is ==, !=, <, >=, etc. Result is 0 or 1.
/// Contract: `n1`/`n2` are SIGNED 64-bit carriers (`toInt64`) — D's `sinteger_t` parameter (09 §3.1).
export function intSignedCmp(op: EXP, n1: sinteger_t, n2: sinteger_t): boolean {
    return numCmp<bigint>(op, n1, n2);
}

/// dmd/ctfeexpr.d:1028 — Returns e1 OP e2; where OP is ==, !=, <, >=, etc. Result is 0 or 1.
export function realCmp(op: EXP, r1: real_t, r2: real_t): boolean {
    // Don't rely on compiler, handle NAN arguments separately
    if (CTFloat.isNaN(r1) || CTFloat.isNaN(r2)) { // if unordered
        switch (op) {
            case EXP.lessThan:
            case EXP.lessOrEqual:
            case EXP.greaterThan:
            case EXP.greaterOrEqual:
                return false;

            default:
                assertUnreachable();
        }
    } else {
        return numCmp<number>(op, r1, r2);
    }
}

/* dmd/ctfeexpr.d:1058 — Conceptually the same as memcmp(e1, e2).
 * e1 and e2 may be strings, arrayliterals, or slices.
 * For string types, return <0 if e1 < e2, 0 if e1==e2, >0 if e1 > e2.
 * For all other types, return 0 if e1 == e2, !=0 if e1 != e2.
 * Returns:
 *      -1,0,1
 */
function ctfeCmpArrays(loc: Loc, e1: Expression, e2: Expression, len: uinteger_t): number {
    // Resolve slices, if necessary
    let lo1: uinteger_t = 0n;
    let lo2: uinteger_t = 0n;

    let x1 = e1;
    const sle1 = x1.isSliceExp();
    if (sle1 !== null) {
        lo1 = toUint64(toInteger(sle1.lwr!));
        x1 = sle1.e1!;
    }
    const se1 = x1.isStringExp();
    const ae1 = x1.isArrayLiteralExp();

    let x2 = e2;
    const sle2 = x2.isSliceExp();
    if (sle2 !== null) {
        lo2 = toUint64(toInteger(sle2.lwr!));
        x2 = sle2.e1!;
    }
    const se2 = x2.isStringExp();
    const ae2 = x2.isArrayLiteralExp();

    // `cast(size_t)lo1` etc. — offsets/lengths into a literal: the index/length domain (09 §1.1).
    // Now both must be either EXP.arrayLiteral or EXP.string_
    if (se1 !== null && se2 !== null) {
        return sliceCmpStringWithString(se1, se2, Number(lo1), Number(lo2), Number(len));
    }
    if (se1 !== null && ae2 !== null) {
        return sliceCmpStringWithArray(se1, ae2, Number(lo1), Number(lo2), Number(len));
    }
    if (se2 !== null && ae1 !== null) {
        return toInt32(-sliceCmpStringWithArray(se2, ae1, Number(lo2), Number(lo1), Number(len)));
    }
    assert(ae1 !== null && ae2 !== null);
    // Comparing two array literals. This case is potentially recursive.
    // If they aren't strings, we just need an equality check rather than
    // a full cmp.
    const needCmp = isIntegral(nextOf(ae1.type!)!);
    const n = Number(len);
    for (let i = 0; i < n; i++) {
        const ee1 = ae1.elements!.opIndex(Number(lo1 + BigInt(i)))!;
        const ee2 = ae2.elements!.opIndex(Number(lo2 + BigInt(i)))!;
        if (needCmp) {
            // `ulong - ulong` read back as `long` (09 §3.1)
            const c: sinteger_t = toInt64(toInteger(ee1) - toInteger(ee2));
            if (c > 0n)
                return 1;
            if (c < 0n)
                return -1;
        } else {
            if (ctfeRawCmp(loc, ee1, ee2) !== 0)
                return 1;
        }
    }
    return 0;
}

/* dmd/ctfeexpr.d:1118 — Given a delegate expression e, return .funcptr.
 * If e is NullExp, return NULL.
 */
function funcptrOf(e: Expression): FuncDeclaration | null {
    assert(e.type!.ty === TY.Tdelegate);
    const de = e.isDelegateExp();
    if (de !== null)
        return de.func;
    const fe = e.isFuncExp();
    if (fe !== null)
        return fe.fd;
    assert(e.op === EXP.null_);
    return null;
}

/// dmd/ctfeexpr.d:1129 — `private bool isArray(const Expression e)`.
function isArray(e: Expression): boolean {
    return e.op === EXP.arrayLiteral || e.op === EXP.string_ || e.op === EXP.slice || e.op === EXP.null_;
}

/*****
 * dmd/ctfeexpr.d:1144 — `private int ctfeRawCmp(Loc loc, Expression e1, Expression e2, bool identity = false)`.
 * Params:
 *      loc = source file location
 *      e1 = left operand
 *      e2 = right operand
 *      identity = true for `is` identity comparisons
 * Returns:
 * For strings, return <0 if e1 < e2, 0 if e1==e2, >0 if e1 > e2.
 * For all other types, return 0 if e1 == e2, !=0 if e1 != e2.
 */
function ctfeRawCmp(loc: Loc, e1: Expression, e2: Expression, identity = false): number {
    if (e1.op === EXP.classReference || e2.op === EXP.classReference) {
        if (e1.op === EXP.classReference && e2.op === EXP.classReference &&
            e1.isClassReferenceExp()!.value === e2.isClassReferenceExp()!.value)
            return 0;
        return 1;
    }
    if (e1.op === EXP.typeid_ && e2.op === EXP.typeid_) {
        // printf("e1: %s\n", e1.toChars());
        // printf("e2: %s\n", e2.toChars());
        const t1 = isType(e1.isTypeidExp()!.obj);
        const t2 = isType(e2.isTypeidExp()!.obj);
        assert(t1);
        assert(t2);
        return t1 !== t2 ? 1 : 0;
    }
    // null == null, regardless of type
    if (e1.op === EXP.null_ && e2.op === EXP.null_)
        return 0;
    if (e1.type!.ty === TY.Tpointer && e2.type!.ty === TY.Tpointer) {
        // Can only be an equality test.
        const ofs1: Ref<dinteger_t> = { value: 0n };
        const ofs2: Ref<dinteger_t> = { value: 0n };
        const agg1 = getAggregateFromPointer(e1, ofs1);
        const agg2 = getAggregateFromPointer(e2, ofs2);
        if ((agg1 === agg2) ||
            (agg1.op === EXP.variable && agg2.op === EXP.variable && agg1.isVarExp()!.var_ === agg2.isVarExp()!.var_)) {
            if (ofs1.value === ofs2.value)
                return 0;
        }
        return 1;
    }
    if (e1.type!.ty === TY.Tdelegate && e2.type!.ty === TY.Tdelegate) {
        // If .funcptr isn't the same, they are not equal
        if (funcptrOf(e1) !== funcptrOf(e2))
            return 1;
        // If both are delegate literals, assume they have the
        // same closure pointer. TODO: We don't support closures yet!
        if (e1.op === EXP.function_ && e2.op === EXP.function_)
            return 0;
        assert(e1.op === EXP.delegate_ && e2.op === EXP.delegate_);
        // Same .funcptr. Do they have the same .ptr?
        const ptr1 = e1.isDelegateExp()!.e1!;
        const ptr2 = e2.isDelegateExp()!.e1!;
        const ofs1: Ref<dinteger_t> = { value: 0n };
        const ofs2: Ref<dinteger_t> = { value: 0n };
        const agg1 = getAggregateFromPointer(ptr1, ofs1);
        const agg2 = getAggregateFromPointer(ptr2, ofs2);
        // If they are EXP.variable, it means they are FuncDeclarations
        if ((agg1 === agg2 && ofs1.value === ofs2.value) ||
            (agg1.op === EXP.variable && agg2.op === EXP.variable && agg1.isVarExp()!.var_ === agg2.isVarExp()!.var_)) {
            return 0;
        }
        return 1;
    }
    if (isArray(e1) && isArray(e2)) {
        const len1 = resolveArrayLength(e1);
        const len2 = resolveArrayLength(e2);
        // workaround for dmc optimizer bug calculating wrong len for
        // uinteger_t len = (len1 < len2 ? len1 : len2);
        // if (len == 0) ...
        if (len1 > 0n && len2 > 0n) {
            const len = len1 < len2 ? len1 : len2;
            const res = ctfeCmpArrays(loc, e1, e2, len);
            if (res !== 0)
                return res;
        }
        // `cast(int)(len1 - len2)`: `ulong` subtraction, then a 32-bit truncation (09 §2); the masked value is a
        // 32-bit integer, exact as a `number`.
        return Number(maskSignedN(32, len1 - len2));
    }
    if (isIntegral(e1.type!)) {
        // `e1.toInteger() != e2.toInteger()` compares two `ulong` carriers: bit equality (09 §0).
        return toUint64(toInteger(e1)) !== toUint64(toInteger(e2)) ? 1 : 0;
    }
    if (identity && isFloating(e1.type!))
        return !isIdentical(e1, e2) ? 1 : 0;
    if (isReal(e1.type!) || isImaginary(e1.type!)) {
        const r1: real_t = isReal(e1.type!) ? toReal(e1) : toImaginary(e1);
        const r2: real_t = isReal(e1.type!) ? toReal(e2) : toImaginary(e2);
        if (CTFloat.isNaN(r1) || CTFloat.isNaN(r2)) { // if unordered
            return 1; // they are not equal
        }
        return r1 !== r2 ? 1 : 0;
    } else if (isComplex(e1.type!)) {
        return !toComplex(e1).opEquals(toComplex(e2)) ? 1 : 0;
    }
    if (e1.op === EXP.structLiteral && e2.op === EXP.structLiteral) {
        const es1 = e1.isStructLiteralExp()!;
        const es2 = e2.isStructLiteralExp()!;
        // For structs, we only need to return 0 or 1 (< and > aren't legal).
        if (es1.sd !== es2.sd)
            return 1;
        if ((es1.elements === null || es1.elements.length === 0) &&
            (es2.elements === null || es2.elements.length === 0))
            return 0; // both arrays are empty
        if (es1.elements === null || es2.elements === null)
            return 1;
        if (es1.elements.length !== es2.elements.length)
            return 1;
        for (let i = 0; i < es1.elements.length; i++) {
            const ee1 = es1.elements.opIndex(i);
            const ee2 = es2.elements.opIndex(i);

            // https://issues.dlang.org/show_bug.cgi?id=16284
            if (ee1!.op === EXP.void_ && ee2!.op === EXP.void_) // if both are VoidInitExp
                continue;

            if (ee1 === ee2)
                continue;
            if (ee1 === null || ee2 === null)
                return 1;
            const cmp = ctfeRawCmp(loc, ee1, ee2, identity);
            if (cmp !== 0)
                return 1;
        }
        return 0; // All elements are equal
    }
    if (e1.op === EXP.assocArrayLiteral && e2.op === EXP.assocArrayLiteral) {
        const es1 = e1.isAssocArrayLiteralExp()!;
        const es2 = e2.isAssocArrayLiteralExp()!;
        const dim = es1.keys!.length;
        if (es2.keys!.length !== dim)
            return 1;
        const used = new BitArray();
        used.length = dim;
        for (let i = 0; i < dim; i++) {
            const k1 = es1.keys!.opIndex(i)!;
            const v1 = es1.values!.opIndex(i)!;
            let v2: Expression | null = null;
            for (let j = 0; j < dim; j++) {
                if (used.opIndex(j))
                    continue;
                const k2 = es2.keys!.opIndex(j)!;
                if (ctfeRawCmp(loc, k1, k2, identity) !== 0)
                    continue;
                used.opIndexAssign(true, j);
                v2 = es2.values!.opIndex(j);
                break;
            }
            if (v2 === null || ctfeRawCmp(loc, v1, v2, identity) !== 0) {
                return 1;
            }
        }
        return 0;
    } else if (e1.op === EXP.assocArrayLiteral && e2.op === EXP.null_) {
        return e1.isAssocArrayLiteralExp()!.keys!.length !== 0 ? 1 : 0;
    } else if (e1.op === EXP.null_ && e2.op === EXP.assocArrayLiteral) {
        return e2.isAssocArrayLiteralExp()!.keys!.length !== 0 ? 1 : 0;
    }

    error(loc, ds("CTFE internal error: bad compare of `%s` and `%s`"), e1.toChars(), e2.toChars());
    assertUnreachable();
}

/// dmd/ctfeexpr.d:1316 — Evaluate ==, !=.  Resolves slices before comparing. Returns 0 or 1.
export function ctfeEqual(loc: Loc, op: EXP, e1: Expression, e2: Expression): boolean {
    return (ctfeRawCmp(loc, e1, e2) === 0) !== (op === EXP.notEqual); // `!raw ^ (op == EXP.notEqual)`
}

/// dmd/ctfeexpr.d:1322 — Evaluate is, !is.  Resolves slices before comparing. Returns 0 or 1.
export function ctfeIdentity(loc: Loc, op: EXP, e1: Expression, e2: Expression): boolean {
    //printf("ctfeIdentity %s %s\n", e1.toChars(), e2.toChars());
    //printf("ctfeIdentity op = '%s', e1 = %s %s, e2 = %s %s\n", EXPtoString(op).ptr,
    //    EXPtoString(e1.op).ptr, e1.toChars(), EXPtoString(e2.op).ptr, e1.toChars());
    let cmp: boolean;
    if (e1.op === EXP.null_) {
        cmp = e2.op === EXP.null_;
    } else if (e2.op === EXP.null_) {
        cmp = false;
    } else if (e1.op === EXP.symbolOffset && e2.op === EXP.symbolOffset) {
        const es1 = e1.isSymOffExp()!;
        const es2 = e2.isSymOffExp()!;
        // `es1.offset == es2.offset` compares two `dinteger_t` carriers: bit equality (09 §0).
        cmp = es1.var_ === es2.var_ && toUint64(es1.offset) === toUint64(es2.offset);
    } else if (isFloating(e1.type!))
        cmp = isIdentical(e1, e2);
    else {
        cmp = ctfeRawCmp(loc, e1, e2, true) === 0;
    }
    if (op === EXP.notIdentity || op === EXP.notEqual)
        cmp = !cmp; // `cmp ^= true`
    return cmp;
}

/// dmd/ctfeexpr.d:1354 — Evaluate >,<=, etc. Resolves slices before comparing. Returns 0 or 1.
export function ctfeCmp(loc: Loc, op: EXP, e1: Expression, e2: Expression): boolean {
    const t1 = toBasetype(e1.type!);
    const t2 = toBasetype(e2.type!);

    if (isString(t1) && isString(t2))
        return specificCmp(op, ctfeRawCmp(loc, e1, e2));
    if (isReal(t1))
        return realCmp(op, toReal(e1), toReal(e2));
    if (isImaginary(t1))
        return realCmp(op, toImaginary(e1), toImaginary(e2));
    // the `dinteger_t` -> `sinteger_t` parameter conversions are carrier re-reads (09 §3.1)
    if (isUnsigned(t1) || isUnsigned(t2))
        return intUnsignedCmp(op, toUint64(toInteger(e1)), toUint64(toInteger(e2)));
    else
        return intSignedCmp(op, toInt64(toInteger(e1)), toInt64(toInteger(e2)));
}

/// dmd/ctfeexpr.d:1371 — `UnionExp ctfeCat(Loc loc, Type type, Expression e1, Expression e2)`.
export function ctfeCat(loc: Loc, type: Type, e1: Expression, e2: Expression): UnionExp {
    const t1 = toBasetype(e1.type!);
    const t2 = toBasetype(e2.type!);
    let ue = new UnionExp(); // `UnionExp ue;`
    if (e2.op === EXP.string_ && e1.op === EXP.arrayLiteral && isIntegral(nextOf(t1)!)) {
        // [chars] ~ string => string (only valid for CTFE)
        const es1 = e2.isStringExp()!;
        const es2 = e1.isArrayLiteralExp()!;
        const len = es1.len + es2.elements!.length;
        const sz = es1.sz;
        const s = new Uint8Array((len + 1) * sz); // `mem.xmalloc((len + 1) * sz)` (08 §13)
        const data1 = es1.peekData();
        s.set(data1, sz * es2.elements!.length); // `memcpy(cast(char*)s + sz * es2.elements.length, ...)`
        for (let i = 0; i < es2.elements!.length; i++) {
            const es2e = es2.elements!.opIndex(i)!;
            if (es2e.op !== EXP.int64) {
                ue.emplace(new CTFEExp(EXP.cantExpression));
                return ue;
            }
            const v: dinteger_t = toInteger(es2e);
            // D stores through the ported byte helper `Port.valcpy` (port.d:202, little-endian bytes), which is
            // the StringExp payload layout; the byte buffer then reaches the ctor as D's `const(void)[]` slice.
            Port.valcpy(s, i * sz, v, sz);
        }
        // Add terminating 0
        s.fill(0, len * sz, len * sz + sz); // `memset(cast(char*)s + len * sz, 0, sz)`
        ue.emplace(new StringExp(loc, Array.from(s), len, sz)); // `s[0 .. len * sz]`, the terminator kept past it
        const es = ue.exp().isStringExp()!;
        es.committed = false;
        es.type = type;
        return ue;
    }
    if (e1.op === EXP.string_ && e2.op === EXP.arrayLiteral && isIntegral(nextOf(t2)!)) {
        // string ~ [chars] => string (only valid for CTFE)
        // Concatenate the strings
        const es1 = e1.isStringExp()!;
        const es2 = e2.isArrayLiteralExp()!;
        const len = es1.len + es2.elements!.length;
        const sz = es1.sz;
        const s = new Uint8Array((len + 1) * sz); // `mem.xmalloc((len + 1) * sz)` (08 §13)
        const slice = es1.peekData();
        s.set(slice, 0); // `memcpy(s, slice.ptr, slice.length)`
        for (let i = 0; i < es2.elements!.length; i++) {
            const es2e = es2.elements!.opIndex(i)!;
            if (es2e.op !== EXP.int64) {
                ue.emplace(new CTFEExp(EXP.cantExpression));
                return ue;
            }
            const v = toInteger(es2e);
            Port.valcpy(s, (es1.len + i) * sz, v, sz); // little-endian bytes: see the note in the arm above
        }
        // Add terminating 0
        s.fill(0, len * sz, len * sz + sz); // `memset(cast(char*)s + len * sz, 0, sz)`
        ue.emplace(new StringExp(loc, Array.from(s), len, sz)); // `s[0 .. len * sz]`, the terminator kept past it
        const es = ue.exp().isStringExp()!;
        es.sz = sz;
        es.committed = false; //es1.committed;
        es.type = type;
        return ue;
    }
    if (e1.op === EXP.arrayLiteral && e2.op === EXP.arrayLiteral && nextOf(t1)!.equals(nextOf(t2))) {
        //  [ e1 ] ~ [ e2 ] ---> [ e1, e2 ]
        let es1 = e1.isArrayLiteralExp()!;
        const es2 = e2.isArrayLiteralExp()!;
        ue.emplace(new ArrayLiteralExp(es1.loc, type, copyLiteralArray(es1.elements)));
        es1 = ue.exp().isArrayLiteralExp()!;
        es1.elements!.insert(es1.elements!.length, copyLiteralArray(es2.elements));
        return ue;
    }
    if (e1.op === EXP.arrayLiteral && e2.op === EXP.null_ && nextOf(t1)!.equals(nextOf(t2))) {
        //  [ e1 ] ~ null ----> [ e1 ].dup
        ue = paintTypeOntoLiteralCopy(type, copyLiteral(e1).copy());
        return ue;
    }
    if (e1.op === EXP.null_ && e2.op === EXP.arrayLiteral && nextOf(t1)!.equals(nextOf(t2))) {
        //  null ~ [ e2 ] ----> [ e2 ].dup
        ue = paintTypeOntoLiteralCopy(type, copyLiteral(e2).copy());
        return ue;
    }
    ue = Cat(loc, type, e1, e2);
    return ue;
}

/*  dmd/ctfeexpr.d:1465 — Given an AA literal 'ae', and a key 'e2':
 *  Return ae[e2] if present, or NULL if not found.
 *  `size_t* pidx` -> the `Ref<number>` out-box (03 §7.2); null means "caller doesn't want it".
 */
export function findKeyInAA(loc: Loc, ae: AssocArrayLiteralExp, e2: Expression,
                            pidx: Ref<number> | null = null): Expression | null {
    /* Search the keys backwards, in case there are duplicate keys
     */
    for (let i = ae.keys!.length; i !== 0;) {
        --i;
        const ekey = ae.keys!.opIndex(i)!;
        const eq = ctfeEqual(loc, EXP.equal, ekey, e2);
        if (eq) {
            if (pidx !== null)
                pidx.value = i;
            return ae.values!.opIndex(i);
        }
    }
    return null;
}

/* dmd/ctfeexpr.d:1488 — Same as for constfold.Index, except that it only works for static arrays,
 * dynamic arrays, and strings. We know that e1 is an
 * interpreted CTFE expression, so it cannot have side-effects.
 * Contract: `indx` is D's `uinteger_t`, so callers pass a `toUint64` value; a signed-negative carrier would
 * pass the `>=` bounds test the wrong way (09 §3.1).
 */
export function ctfeIndex(pue: UnionExp, loc: Loc, type: Type, e1: Expression, indx: uinteger_t): Expression {
    //printf("ctfeIndex(e1 = %s)\n", e1.toChars());
    assert(e1.type);
    const es1 = e1.isStringExp();
    if (es1 !== null) {
        if (indx >= BigInt(es1.len)) {
            error(loc, ds("string index %llu is out of bounds `[0 .. %llu]`"), indx, BigInt(es1.len));
            return CTFEExp.cantexp!;
        }
        // `cast(size_t) indx` — in bounds, so the index/length domain (09 §1.1)
        pue.emplace(new IntegerExp(loc, es1.getIndex(Number(indx)), type));
        return pue.exp();
    }

    const ale = e1.isArrayLiteralExp();
    if (ale !== null) {
        if (indx >= BigInt(ale.elements!.length)) {
            error(loc, ds("array index %llu is out of bounds `%s[0 .. %llu]`"), indx, e1.toChars(),
                BigInt(ale.elements!.length));
            return CTFEExp.cantexp!;
        }
        const e = ale.elements!.opIndex(Number(indx))!; // `cast(size_t)indx`, in bounds (09 §1.1)
        return paintTypeOntoLiteral(pue, type, e);
    }

    assertUnreachable();
}

/// dmd/ctfeexpr.d:1517 — `Expression ctfeCast(UnionExp* pue, Loc loc, Type type, Type to, Expression e`
/// (trailing `bool explicitCast = false)`).
export function ctfeCast(pue: UnionExp, loc: Loc, type: Type, to: Type, e: Expression,
                         explicitCast = false): Expression {
    const paint = (): Expression => {
        return paintTypeOntoLiteral(pue, to, e);
    };

    if (e.op === EXP.null_)
        return paint();

    if (e.op === EXP.classReference) {
        // Disallow reinterpreting class casts. Do this by ensuring that
        // the original class can implicitly convert to the target class.
        // Also do not check 'alias this' for explicit cast expressions.
        const tclass = e.isClassReferenceExp()!.originalClass()!.type!.isTypeClass()!;
        const match = explicitCast ? implicitConvToWithoutAliasThisClass(tclass, mutableOf(to))
                                   : implicitConvToType(tclass, mutableOf(to));
        if (match !== MATCH.nomatch)
            return paint();

        pue.emplace(new NullExp(loc, to));
        return pue.exp();
    }

    // Allow TypeInfo type painting
    if (isTypeInfo_Class(e.type!) && implicitConvToType(e.type!, to) !== MATCH.nomatch)
        return paint();

    // Allow casting away const for struct literals
    if (e.op === EXP.structLiteral && castMod(toBasetype(e.type!), 0) === castMod(toBasetype(to), 0))
        return paint();

    let r: Expression;
    if (e.type!.equals(type) && type.equals(to)) {
        // necessary not to change e's address for pointer comparisons
        r = e;
    } else if (toBasetype(to).ty === TY.Tarray &&
               toBasetype(type).ty === TY.Tarray &&
               size(nextOf(toBasetype(to))!) === size(nextOf(toBasetype(type))!)) {
        // https://issues.dlang.org/show_bug.cgi?id=12495
        // Array reinterpret casts: eg. string to immutable(ubyte)[]
        return paint();
    } else {
        pue.emplace(Cast(loc, type, to, e).exp()); // `*pue = Cast(loc, type, to, e);`
        r = pue.exp();
    }

    if (CTFEExp.isCantExp(r))
        error(loc, ds("cannot cast `%s` to `%s` at compile time"), e.toChars(), to.toChars());

    const ae = e.isArrayLiteralExp();
    if (ae !== null)
        ae.ownedByCtfe = OwnedBy.ctfe;

    const se = e.isStringExp();
    if (se !== null)
        se.ownedByCtfe = OwnedBy.ctfe;

    return r;
}

/******** Assignment helper functions ***************************/
/* dmd/ctfeexpr.d:1589 — Set dest = src, where both dest and src are container value literals
 * (ie, struct literals, or static arrays (can be an array literal or a string))
 * Assignment is recursively in-place.
 * Purpose: any reference to a member of 'dest' will remain valid after the
 * assignment.
 */
export function assignInPlace(dest: Expression, src: Expression): void {
    let oldelems: Expressions;
    let newelems: Expressions;
    if (dest.op === EXP.structLiteral) {
        assert(dest.op === src.op);
        oldelems = dest.isStructLiteralExp()!.elements!;
        newelems = src.isStructLiteralExp()!.elements!;
        const sd = dest.isStructLiteralExp()!.sd!;
        const nfields = sd.nonHiddenFields();
        const nvthis = sd.fields.length - nfields;
        if (nvthis !== 0 && oldelems.length >= nfields && oldelems.length < newelems.length) {
            // `foreach (_; 0 .. newelems.length - oldelems.length)`: D evaluates the bound ONCE, before the
            // pushes grow `oldelems` — hoisted so the count is not re-read each iteration.
            const count = newelems.length - oldelems.length;
            for (let k = 0; k < count; k++)
                oldelems.push(null);
        }
    } else if (dest.op === EXP.arrayLiteral && src.op === EXP.arrayLiteral) {
        oldelems = dest.isArrayLiteralExp()!.elements!;
        newelems = src.isArrayLiteralExp()!.elements!;
    } else if (dest.op === EXP.string_ && src.op === EXP.string_) {
        sliceAssignStringFromString(dest.isStringExp()!, src.isStringExp()!, 0);
        return;
    } else if (dest.op === EXP.arrayLiteral && src.op === EXP.string_) {
        sliceAssignArrayLiteralFromString(dest.isArrayLiteralExp()!, src.isStringExp()!, 0);
        return;
    } else if (src.op === EXP.arrayLiteral && dest.op === EXP.string_) {
        sliceAssignStringFromArrayLiteral(dest.isStringExp()!, src.isArrayLiteralExp()!, 0);
        return;
    } else if (dest.op === EXP.int64 && src.op === EXP.int64) {
        dest.isIntegerExp()!.setInteger(src.isIntegerExp()!.getInteger());
        return;
    } else if (dest.op === EXP.float64 && src.op === EXP.float64) {
        dest.isRealExp()!.value = src.isRealExp()!.value;
        return;
    } else {
        // dropped: bare printf developer trace before assert(0) (unreachable path)
        // (`printf("invalid op %d %d\n", src.op, dest.op);`, 07 §2.1)
        assertUnreachable();
    }
    assert(oldelems.length === newelems.length);
    for (let i = 0; i < oldelems.length; i++) {
        const e = newelems.opIndex(i)!;
        const o = oldelems.opIndex(i)!;
        if (e.op === EXP.structLiteral) {
            assert(o.op === e.op);
            assignInPlace(o, e);
        } else if (e.type!.ty === TY.Tsarray && e.op !== EXP.void_ && o.type!.ty === TY.Tsarray) {
            assignInPlace(o, e);
        } else {
            oldelems.opIndexAssign(newelems.opIndex(i), i);
        }
    }
}

/// dmd/ctfeexpr.d:1662 — Given an AA literal aae,  set aae[index] = newval and return newval.
export function assignAssocArrayElement(loc: Loc, aae: AssocArrayLiteralExp, index: Expression,
                                        newval: Expression): Expression {
    /* Create new associative array literal reflecting updated key/value
     */
    const keysx = aae.keys!;
    const valuesx = aae.values!;
    let updated = 0;
    for (let j = valuesx.length; j !== 0;) {
        j--;
        const ekey = aae.keys!.opIndex(j)!;
        const eq = ctfeEqual(loc, EXP.equal, ekey, index);
        if (eq) {
            valuesx.opIndexAssign(newval, j);
            updated = 1;
        }
    }
    if (updated === 0) {
        // Append index/newval to keysx[]/valuesx[]
        valuesx.push(newval);
        keysx.push(index);
    }
    return newval;
}

/// dmd/ctfeexpr.d:1692 — Given array literal oldval of type ArrayLiteralExp or StringExp, of length
/// oldlen, change its length to newlen. If the newlen is longer than oldlen,
/// all new elements will be set to the default initializer for the element type.
export function changeArrayLiteralLength(pue: UnionExp, loc: Loc, arrayType: TypeArray, oldval: Expression,
                                         oldlen: number, newlen: number): Expression {
    const elemType = arrayType.next;
    assert(elemType);
    const defaultElem = defaultInitLiteral(elemType, loc)!;
    const elements: Expressions = new DArray<Expression | null>(newlen);
    // Resolve slices
    let indxlo = 0;
    if (oldval.op === EXP.slice) {
        // `cast(size_t)...lwr.toInteger()` — index/length domain (09 §1.1)
        indxlo = Number(toInteger(oldval.isSliceExp()!.lwr!));
        oldval = oldval.isSliceExp()!.e1!;
    }
    const copylen = oldlen < newlen ? oldlen : newlen;
    if (oldval.op === EXP.string_) {
        const oldse = oldval.isStringExp()!;
        // `mem.xcalloc(newlen + 1, oldse.sz)` -> a zero-filled JS byte buffer (08 §13).
        const s = new Uint8Array((newlen + 1) * oldse.sz);
        const data = oldse.peekData();
        s.set(data.subarray(0, copylen * oldse.sz), 0); // `memcpy(s, data.ptr, copylen * oldse.sz)`
        const defaultValue: bigint = toUint64(toInteger(defaultElem)); // `cast(ulong)`
        // The wider arms write one little-endian code unit of width `sz` (expression.ts class doc), through one
        // view per loop, built only for the width `oldse.sz` selects.
        const s16 = oldse.sz === 2 ? new Uint16Array(s.buffer) : null;
        const s32 = oldse.sz === 4 ? new Uint32Array(s.buffer) : null;
        const s64 = oldse.sz === 8 ? new BigUint64Array(s.buffer) : null;
        for (let elemi = copylen; elemi < newlen; elemi++) {
            switch (oldse.sz) {
                case 1:
                    // `cast(char)defaultValue` (09 §2); D's index `indxlo + elemi` can pass the buffer end
                    // when `indxlo > 0` (a D out-of-bounds write) — a typed-array write there is dropped.
                    s[indxlo + elemi] = Number(maskUnsignedN(8, defaultValue));
                    break;
                // The wider arms: the same dropped out-of-bounds write as the `case 1` arm.
                case 2:
                    // `(cast(wchar*)s)[cast(size_t)(indxlo + elemi)] = cast(wchar)defaultValue;`
                    s16![indxlo + elemi] = Number(maskUnsignedN(16, defaultValue));
                    break;
                case 4:
                    // `(cast(dchar*)s)[cast(size_t)(indxlo + elemi)] = cast(dchar)defaultValue;`
                    s32![indxlo + elemi] = Number(maskUnsignedN(32, defaultValue));
                    break;
                case 8:
                    // `(cast(ulong*)s)[cast(size_t)(indxlo + elemi)] = cast(ulong)defaultValue;`
                    s64![indxlo + elemi] = defaultValue;
                    break;
                default:
                    assertUnreachable();
            }
        }
        // `s[0 .. newlen * oldse.sz]`, with the zeroed terminator unit kept past it (see copyLiteral).
        pue.emplace(new StringExp(loc, Array.from(s), newlen, oldse.sz));
        const se = pue.exp().isStringExp()!;
        se.type = arrayType;
        se.sz = oldse.sz;
        se.committed = oldse.committed;
        se.ownedByCtfe = OwnedBy.ctfe;
    } else {
        if (oldlen !== 0) {
            assert(oldval.op === EXP.arrayLiteral);
            const ae = oldval.isArrayLiteralExp()!;
            for (let i = 0; i < copylen; i++)
                elements.opIndexAssign(ae.elements!.opIndex(indxlo + i), i);
        }
        if (elemType.ty === TY.Tstruct || elemType.ty === TY.Tsarray) {
            /* If it is an aggregate literal representing a value type,
             * we need to create a unique copy for each element
             */
            for (let i = copylen; i < newlen; i++)
                elements.opIndexAssign(copyLiteral(defaultElem).copy(), i);
        } else {
            for (let i = copylen; i < newlen; i++)
                elements.opIndexAssign(defaultElem, i);
        }
        pue.emplace(new ArrayLiteralExp(loc, arrayType, elements));
        const aae = pue.exp().isArrayLiteralExp()!;
        aae.ownedByCtfe = OwnedBy.ctfe;
    }
    return pue.exp();
}

/*************************** CTFE Sanity Checks ***************************/

/// dmd/ctfeexpr.d:1771 — `bool isCtfeValueValid(Expression newval)`.
export function isCtfeValueValid(newval: Expression): boolean {
    const tb = toBasetype(newval.type!);
    switch (newval.op) {
        case EXP.int64:
        case EXP.float64:
        case EXP.complex80:
            return isScalar(tb);

        case EXP.null_:
            return tb.ty === TY.Tnull ||
                tb.ty === TY.Tpointer ||
                tb.ty === TY.Tarray ||
                tb.ty === TY.Taarray ||
                tb.ty === TY.Tclass ||
                tb.ty === TY.Tdelegate;

        case EXP.string_:
            return true; // CTFE would directly use the StringExp in AST.

        case EXP.arrayLiteral:
            return true; //((ArrayLiteralExp *)newval)->ownedByCtfe;

        case EXP.assocArrayLiteral:
            return true; //((AssocArrayLiteralExp *)newval)->ownedByCtfe;

        case EXP.structLiteral:
            return true; //((StructLiteralExp *)newval)->ownedByCtfe;

        case EXP.classReference:
            return true;

        case EXP.type:
            return true;

        case EXP.vector:
            return true; // vector literal

        case EXP.function_:
            return true; // function literal or delegate literal

        case EXP.delegate_: {
            // &struct.func or &clasinst.func
            // &nestedfunc
            const ethis = newval.isDelegateExp()!.e1!;
            return ethis.op === EXP.structLiteral || ethis.op === EXP.classReference ||
                ethis.op === EXP.variable && ethis.isVarExp()!.var_ === newval.isDelegateExp()!.func;
        }

        case EXP.symbolOffset: {
            // function pointer, or pointer to static variable
            const d: Declaration = newval.isSymOffExp()!.var_;
            return d.isFuncDeclaration() !== null || d.isDataseg();
        }

        case EXP.typeid_: {
            // always valid
            return true;
        }

        case EXP.address: {
            // e1 should be a CTFE reference
            const e1 = newval.isAddrExp()!.e1!;
            return tb.ty === TY.Tpointer &&
                (
                    (e1.op === EXP.structLiteral || e1.op === EXP.arrayLiteral) && isCtfeValueValid(e1) ||
                    e1.op === EXP.variable ||
                    e1.op === EXP.int64 ||
                    e1.op === EXP.float64 ||
                    e1.op === EXP.string_ ||
                    e1.op === EXP.dotVariable && isCtfeReferenceValid(e1) ||
                    e1.op === EXP.index && isCtfeReferenceValid(e1) ||
                    e1.op === EXP.slice && toBasetype(e1.type!).ty === TY.Tsarray
                );
        }

        case EXP.slice: {
            // e1 should be an array aggregate
            const se = newval.isSliceExp()!;
            assert(se.lwr && se.lwr.op === EXP.int64);
            assert(se.upr && se.upr.op === EXP.int64);
            return tb.isStaticOrDynamicArray() && (se.e1!.op === EXP.string_ || se.e1!.op === EXP.arrayLiteral);
        }

        case EXP.void_:
            return true; // uninitialized value

        default:
            error(newval.loc, ds("CTFE internal error: illegal CTFE value `%s`"), newval.toChars());
            return false;
    }
}

/// dmd/ctfeexpr.d:1869 — `bool isCtfeReferenceValid(Expression newval)`.
export function isCtfeReferenceValid(newval: Expression): boolean {
    switch (newval.op) {
        case EXP.this_:
            return true;

        case EXP.variable: {
            const v = newval.isVarExp()!.var_.isVarDeclaration();
            assert(v);
            // Must not be a reference to a reference
            return true;
        }

        case EXP.index: {
            const eagg = newval.isIndexExp()!.e1!;
            return eagg.op === EXP.string_ || eagg.op === EXP.arrayLiteral || eagg.op === EXP.assocArrayLiteral;
        }

        case EXP.dotVariable: {
            const eagg = newval.isDotVarExp()!.e1!;
            return (eagg.op === EXP.structLiteral || eagg.op === EXP.classReference) && isCtfeValueValid(eagg);
        }

        default:
            // Internally a ref variable may directly point a stack memory.
            // e.g. ref int v = 1;
            return isCtfeValueValid(newval);
    }
}

/// dmd/ctfeexpr.d:1904 — Used for debugging only. Its D callers all sit in debug(LOG)/debug(LOGASSIGN)
/// blocks of dinterpret.d, OFF (_config.md). `%p` prints go through `dmdformat`, which does not implement
/// `%p` (10 §3.5) and throws there — the runtime's documented gap, not a wall of this file.
export function showCtfeExpr(e: Expression, level = 0): void {
    const printf = (fmt: string, ...args: unknown[]): void => {
        process.stdout.write(dsToJs(dmdformat(ds(fmt), args)));
    };
    for (let i = level; i > 0; --i)
        printf(" ");
    let elements: Expressions | null = null;
    // We need the struct definition to detect block assignment
    let sd: StructDeclaration | null = null;
    let cd: ClassDeclaration | null = null;
    if (e.op === EXP.structLiteral) {
        elements = e.isStructLiteralExp()!.elements;
        sd = e.isStructLiteralExp()!.sd;
        printf("STRUCT type = %s %p:\n", e.type!.toChars(), e);
    } else if (e.op === EXP.classReference) {
        elements = e.isClassReferenceExp()!.value!.elements;
        cd = e.isClassReferenceExp()!.originalClass();
        printf("CLASS type = %s %p:\n", e.type!.toChars(), e.isClassReferenceExp()!.value);
    } else if (e.op === EXP.arrayLiteral) {
        elements = e.isArrayLiteralExp()!.elements;
        printf("ARRAY LITERAL type=%s %p:\n", e.type!.toChars(), e);
    } else if (e.op === EXP.assocArrayLiteral) {
        printf("AA LITERAL type=%s %p:\n", e.type!.toChars(), e);
    } else if (e.op === EXP.string_) {
        printf("STRING %s %p\n", e.toChars(), e.isStringExp()!.peekString());
    } else if (e.op === EXP.slice) {
        printf("SLICE %p: %s\n", e, e.toChars());
        showCtfeExpr(e.isSliceExp()!.e1!, level + 1);
    } else if (e.op === EXP.variable) {
        printf("VAR %p %s\n", e, e.toChars());
        const v = e.isVarExp()!.var_.isVarDeclaration();
        if (v !== null && getValue(v) !== null)
            showCtfeExpr(getValue(v)!, level + 1);
    } else if (e.op === EXP.address) {
        // This is potentially recursive. We mustn't try to print the thing we're pointing to.
        printf("POINTER %p to %p: %s\n", e, e.isAddrExp()!.e1, e.toChars());
    } else
        printf("VALUE %p: %s\n", e, e.toChars());
    if (elements !== null) {
        let fieldsSoFar = 0;
        for (let i = 0; i < elements.length; i++) {
            let z: Expression | null = null;
            let v: VarDeclaration | null = null;
            if (i > 15) {
                printf("...(total %d elements)\n", toInt32(elements.length));
                return;
            }
            if (sd !== null) {
                v = sd.fields.opIndex(i);
                z = elements.opIndex(i);
            } else if (cd !== null) {
                while (i - fieldsSoFar >= cd.fields.length) {
                    fieldsSoFar += cd.fields.length;
                    cd = cd.baseClass!;
                    for (let j = level; j > 0; --j)
                        printf(" ");
                    printf(" BASE CLASS: %s\n", cd.toChars());
                }
                v = cd.fields.opIndex(i - fieldsSoFar);
                assert((elements.length + i) >= (fieldsSoFar + cd.fields.length));
                const indx = (elements.length - fieldsSoFar) - cd.fields.length + i;
                assert(indx < elements.length);
                z = elements.opIndex(indx);
            }
            if (z === null) {
                for (let j = level; j > 0; --j)
                    printf(" ");
                printf(" void\n");
                continue;
            }
            if (v !== null) {
                // If it is a void assignment, use the default initializer
                if ((v.type!.ty !== z.type!.ty) && v.type!.ty === TY.Tsarray) {
                    // `for (int j = level; --j;)`: the pre-decremented `int` is the condition (09 §9)
                    for (let j = level; (j = toInt32(j - 1)) !== 0;)
                        printf(" ");
                    printf(" field: block initialized static array\n");
                    continue;
                }
            }
            showCtfeExpr(z, level + 1);
        }
    }
}

/*************************** Void initialization ***************************/
/// dmd/ctfeexpr.d:2013 — `UnionExp voidInitLiteral(Type t, VarDeclaration var)` (`var` -> `var_`, 01 §2.3).
export function voidInitLiteral(t: Type, var_: VarDeclaration): UnionExp {
    const ue = new UnionExp(); // `UnionExp ue;`
    const tsa = t.isTypeSArray();
    const ts = t.isTypeStruct();
    if (tsa !== null) {
        let elem = voidInitLiteral(tsa.next!, var_).copy();
        // For aggregate value types (structs, static arrays) we must
        // create an a separate copy for each element.
        const mustCopy = elem.op === EXP.arrayLiteral || elem.op === EXP.structLiteral;
        // `cast(size_t)tsa.dim.toInteger()` — index/length domain (09 §1.1), not a sentinel.
        const d = Number(toInteger(tsa.dim!));
        const elements: Expressions = new DArray<Expression | null>(d);
        for (let i = 0; i < d; i++) {
            if (mustCopy && i > 0)
                elem = copyLiteral(elem).copy();
            elements.opIndexAssign(elem, i);
        }
        ue.emplace(new ArrayLiteralExp(var_.loc, tsa, elements));
        const ae = ue.exp().isArrayLiteralExp()!;
        ae.ownedByCtfe = OwnedBy.ctfe;
    } else if (ts !== null) {
        const exps: Expressions = new DArray<Expression | null>(ts.sym!.fields.length);
        for (let i = 0; i < ts.sym!.fields.length; i++) {
            exps.opIndexAssign(voidInitLiteral(ts.sym!.fields.opIndex(i)!.type!, ts.sym!.fields.opIndex(i)!).copy(), i);
        }
        ue.emplace(new StructLiteralExp(var_.loc, ts.sym, exps));
        const se = ue.exp().isStructLiteralExp()!;
        se.type = ts;
        se.ownedByCtfe = OwnedBy.ctfe;
    } else
        ue.emplace(new VoidInitExp(var_));
    return ue;
}
