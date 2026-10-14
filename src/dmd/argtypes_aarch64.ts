// Ported from dmd/argtypes_aarch64.d (module dmd.argtypes_aarch64), as LDC 1.43.0 builds it.
//
// Breaks a D type down into basic (register) types for the AArch64 procedure call standard
// (AAPCS64). The frontend reads the answer through `Target.toArgTypes` (gen/target.cpp:342), which
// feeds `__argTypes` (expressionsem.d:9147), `StructDeclaration.argTypes` (dsymbolsem.d:10290) and,
// through `TargetABI::getArgTypes` (gen/abi/abi.cpp:78), `Target.isReturnOnStack` (NRVO,
// `__traits(isReturnOnStack)`, `vresult.nrvo`) and `Target.preferPassByRef` (`-preview=in`).
//
// NUMERIC DOMAIN (09 §1.1/§1.3.1). Every `size_t` here is a type SIZE or an element count derived from
// type sizes, and `typesem.size()` returns the `uinteger_t` carrier with its SIZE_INVALID sentinel,
// so the whole module stays `bigint`: `cast(size_t)` of a `ulong` is the identity on a 64-bit target,
// and `getNestedHFVA`'s `size_t.max` "not an HFVA" sentinel is the real 2^64 - 1, the same domain as
// the struct sizes it is mixed with (09 §1.3.1: a bigint sentinel never transits a `number`), and the
// static-array product `N * dim` wraps modulo 2^64 as D's `size_t` does.
//
// IMPORTS. D's `import core.stdc.stdio;` serves only the commented-out `printf` at
// argtypes_aarch64.d:36 and has no TS counterpart (01 §3.7). The two function-local
// `import dmd.typesem : sarrayOf;` (argtypes_aarch64.d:73, :103) name a module this file already
// imports at module level, so they hoist into that import (01 §4.4). AST-node module FIRST, the
// *sem modules after it (01 §4.8).

import { TY } from "./astenums.js";
import { Type, TypeTuple } from "./mtype.js";
import { baseElemOf, isComplex, isFloating, nextOf, sarrayOf, size, toBasetype } from "./typesem.js";
import { isPOD } from "./dsymbolsem.js";
import { toUInteger } from "./expressionsem.js";
import { assert, assertUnreachable } from "../assert.js";
import { maskUnsignedN } from "../numeric.js";

/**
 * A D `ref` parameter or a `Type*` out-slot over a value the callee REASSIGNS becomes a one-slot box
 * (03 §3.2/§3.3). Exported because `isHFVA`'s `Type* rewriteType` is part of this module's public
 * signature: a caller must be able to build the box.
 */
export interface Ref<T> {
    value: T;
}

/// dmd/argtypes_aarch64.d — `size_t.max`, the "not suited as HFVA" sentinel `getNestedHFVA` returns
/// (bigint domain; see the header).
const SIZE_T_MAX = 0xFFFF_FFFF_FFFF_FFFFn;

/**
 * dmd/argtypes_aarch64.d:34 — `TypeTuple toArgTypes_aarch64(Type t)`.
 *
 * Breaks `t` down into 'simpler' types that can be passed to a function in registers, and returned
 * in registers, per AAPCS64 (https://github.com/ARM-software/abi-aa/blob/master/aapcs64/aapcs64.rst).
 *
 * Returns: a tuple of 1 type if `t` can be passed in registers (for a Homogeneous Floating-point/
 * Vector Aggregate, a static array of its fundamental type; for any other POD aggregate of at most
 * 16 bytes, `byte`/`short`/`int`/`long` or `long[n]`); an EMPTY tuple (`TypeTuple.empty`, shared)
 * if the type cannot be passed/returned in registers (a non-POD, or a non-HFVA larger than 16
 * bytes); null for a zero-sized type (`void`, `T[0]`). `Type.terror` yields a tuple of itself.
 *
 * Precondition: `t` has had semantic (its size is final). Cost: one `size()` query plus, for an
 * aggregate of at most 64 bytes, a recursive walk of its fields; it may build and merge one static
 * array type.
 */
export function toArgTypes_aarch64(t: Type): TypeTuple | null {
    //printf("toArgTypes_aarch64() %s\n", t.toChars());
    if (t === Type.terror)
        return TypeTuple.fromType(t);

    // ported: D's local `size` and `getGPType`'s parameter `size` -> `size_` (01 §2.3: each would shadow
    // typesem's `size`)
    const size_ = size(t);
    if (size_ === 0n)
        return null;

    const tb = toBasetype(t);
    const isAggregate = tb.ty === TY.Tstruct || tb.isStaticOrDynamicArray() || tb.ty === TY.Tdelegate
        || isComplex(tb);
    if (!isAggregate)
        return TypeTuple.fromType(t);

    const hfvaType: Ref<Type | null> = { value: null };
    const maxNumHFVAElements = 4;
    // ported: D local `isHFVA` -> `isHFVA_` (01 §2.3: it would shadow this module's `isHFVA`)
    const isHFVA_ = size_ > BigInt(maxNumHFVAElements * 16) ? false : isHFVA(tb, maxNumHFVAElements, hfvaType);

    // non-PODs and larger non-HFVA PODs are passed indirectly by value (pointer to caller-allocated copy)
    if ((size_ > 16n && !isHFVA_) || !isPODType(tb))
        return TypeTuple.empty;

    if (isHFVA_) {
        // pass in SIMD registers
        // isHFVA returned true, so it wrote `hfvaType` (argtypes_aarch64.d:104-105).
        return TypeTuple.fromType(hfvaType.value!);
    }

    // pass remaining aggregates in 1 or 2 GP registers
    const getGPType = (size_: bigint): Type => {
        switch (size_) {
        case 1n: return Type.tint8;
        case 2n: return Type.tint16;
        case 4n: return Type.tint32;
        case 8n: return Type.tint64;
        default:
            return sarrayOf(Type.tint64, (size_ + 7n) / 8n);
        }
    };
    return TypeTuple.fromType(getGPType(size_));
}

/**
 * dmd/argtypes_aarch64.d:92 — `bool isHFVA(Type t, int maxNumElements = 4, Type* rewriteType = null)`.
 *
 * A Homogeneous Floating-point/Vector Aggregate (HFA/HVA) is an ARM/AArch64 concept that consists of
 * up to 4 elements of the same floating point/vector type. It is the aggregate final data layout that
 * matters so structs, unions, static arrays and complex numbers can result in an HFVA.
 *
 * simple HFAs: struct F1 {float f;}  struct D4 {double a,b,c,d;}
 * interesting HFA: struct {F1[2] vals; float weight;}
 *
 * If the type is an HFVA and `rewriteType` is specified, `rewriteType.value` is set to a corresponding
 * static array type (`fundamental[N]`, merged); otherwise the box is left untouched. `real` counts as
 * `double` on this target (its size is 8), `__vector` types as their own fundamental type.
 */
export function isHFVA(t: Type, maxNumElements = 4, rewriteType: Ref<Type | null> | null = null): boolean {
    t = toBasetype(t);
    if ((t.ty !== TY.Tstruct && t.ty !== TY.Tsarray && !isComplex(t)) || !isPODType(t))
        return false;

    const fundamentalType: Ref<Type | null> = { value: null };
    const N = getNestedHFVA(t, fundamentalType);
    // D compares `size_t` against `int`: the int converts to the 64-bit unsigned type.
    if (N < 1n || N > maskUnsignedN(64, BigInt(maxNumElements)))
        return false;

    if (rewriteType !== null) {
        // N >= 1, so getNestedHFVA reached a leaf and set `fundamentalType` (argtypes_aarch64.d:196-197).
        rewriteType.value = sarrayOf(fundamentalType.value!, N);
    }

    return true;
}

/// dmd/argtypes_aarch64.d:112 — `bool isPOD(Type t)` (private). Renamed with the receiver-type suffix
/// (04 §6.1): the D module also imports `dsymbolsem.isPOD(StructDeclaration)`, which its body calls.
function isPODType(t: Type): boolean {
    const baseType = baseElemOf(t);
    const ts = baseType.isTypeStruct();
    if (ts !== null)
        return isPOD(ts.sym!);
    return true;
}

/**
 * dmd/argtypes_aarch64.d:128 — `size_t getNestedHFVA(Type t, ref Type fundamentalType)` (private).
 *
 * Recursive helper.
 * Returns size_t.max if the type isn't suited as HFVA (element) or incompatible
 * to the specified fundamental type, otherwise the number of consumed elements
 * of that fundamental type.
 * If `fundamentalType` is null, it is set on the first occasion and then left
 * untouched.
 */
function getNestedHFVA(t: Type, fundamentalType: Ref<Type | null>): bigint {
    t = toBasetype(t);

    const tarray = t.isTypeSArray();
    if (tarray !== null) {
        const N = getNestedHFVA(nextOf(tarray)!, fundamentalType);
        // D multiplies in `size_t`, which wraps modulo 2^64.
        return N === SIZE_T_MAX ? N : maskUnsignedN(64, N * toUInteger(tarray.dim!)); // => T[0] may return 0
    }

    const tstruct = t.isTypeStruct();
    if (tstruct !== null) {
        // check each field recursively and set fundamentalType
        let isEmpty = true;
        const fields = tstruct.sym!.fields;
        for (let i = 0; i < fields.length; i++) {
            const field = fields.opIndex(i)!;
            const field_N = getNestedHFVA(field.type!, fundamentalType);
            if (field_N === SIZE_T_MAX)
                return field_N;
            if (field_N > 0n) // might be 0 for empty static array
                isEmpty = false;
        }

        // an empty struct (no fields or only empty static arrays) is an undefined
        // byte, i.e., no HFVA
        if (isEmpty)
            return SIZE_T_MAX;

        // due to possibly overlapping fields (for unions and nested anonymous
        // unions), use the overall struct size to determine N
        const structSize = size(t);
        // A non-empty struct reached a leaf, which set `fundamentalType`.
        const fundamentalSize = size(fundamentalType.value!);
        assert(structSize % fundamentalSize === 0n);
        return structSize / fundamentalSize;
    }

    let thisFundamentalType: Type;
    let N: bigint;

    if (t.isTypeVector() !== null) {
        thisFundamentalType = t;
        N = 1n;
    } else if (isFloating(t)) { // incl. imaginary and complex
        let ftSize = size(t);
        N = 1n;

        if (isComplex(t)) {
            ftSize /= 2n;
            N = 2n;
        }

        switch (ftSize) {
            case 4n: thisFundamentalType = Type.tfloat32; break;
            case 8n: thisFundamentalType = Type.tfloat64; break;
            case 16n: thisFundamentalType = Type.tfloat80; break; // IEEE quadruple
            default: return assertUnreachable("unexpected floating-point type size");
        }
    } else {
        return SIZE_T_MAX; // reject all other types
    }

    if (fundamentalType.value === null)
        fundamentalType.value = thisFundamentalType; // initialize
    else if (fundamentalType.value !== thisFundamentalType)
        return SIZE_T_MAX; // incompatible fundamental types, reject

    return N;
}
