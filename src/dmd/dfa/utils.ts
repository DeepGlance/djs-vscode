// Ported from dmd/dfa/utils.d (module dmd.dfa.utils).
//
// Type classification helpers for the fast data-flow analysis (dfa/fast/*). Free functions over the AST
// types; no state, no structs, no allocation. D imports dmd.tokens, dmd.visitor and dmd.identifier
// without using a symbol from them here: those edges carry no binding in TS (01 §3 strict-mode imports).

import { TY, Taarray, Tstruct } from "../astenums.js";
import type { IndexExp } from "../expression.js";
import type { Type } from "../mtype.js";
// last: typesem enters the core SCC; the leaf imports above load first (01 §4.8).
import { isFloating } from "../typesem.js";

/***********************************************************
 * Checks if a type is capable of being null at runtime.
 *
 * The DFA uses this to determine if a null-check is required
 * for a specific variable.
 *
 * dmd/dfa/utils.d:29 — `bool isTypeNullable(Type type)`. A null `type` answers false.
 *
 * Returns:
 *      true if the type is a pointer, array, class, delegate, etc.
 */
export function isTypeNullable(type: Type | null): boolean {
    if (type === null)
        return false;

    switch (type.ty) {
    case TY.Tarray: case TY.Taarray: case TY.Tpointer: case TY.Treference: case TY.Tfunction:
    case TY.Tclass: case TY.Tdelegate:
        return true;

    default:
        return false;
    }
}

/***********************************************************
 * Checks if a type can be evaluated as a boolean (truthy/falsey).
 *
 * Used by the DFA to determine if control flow (like `if` statements)
 * depends on this variable.
 *
 * dmd/dfa/utils.d:55 — `bool isTypeTruthy(Type type)`. A null `type` answers false.
 *
 * Returns:
 *      false for types like `void` (noreturn) or `struct` (unless they define opCast),
 *      true for integers, pointers, bools, etc.
 */
export function isTypeTruthy(type: Type | null): boolean {
    if (type === null)
        return false;

    switch (type.ty) {
    case TY.Tident:
    case TY.Terror:
    case TY.Ttypeof:
    case TY.Ttuple:
    case TY.Treturn:
    case TY.Ttraits:
    case TY.Tmixin:
    case TY.Tnoreturn:
    case TY.Ttag:
    case TY.Tsarray:
    case TY.Tstruct:
    case TY.Tvector:
        return false;

    default:
        return true;
    }
}

/**
 * dmd/dfa/utils.d:81 — `bool isIndexContextAA(IndexExp ie)`: true when `ie` indexes an associative
 * array. Any missing link (`ie`, `ie.e1`, `ie.e1.type`) answers false.
 */
export function isIndexContextAA(ie: IndexExp | null): boolean {
    if (ie === null || ie.e1 === null || ie.e1.type === null)
        return false;
    return ie.e1.type.isTypeAArray() !== null;
}

/**
 * dmd/dfa/utils.d:88 — `int concatNullableResult(Type lhs, Type rhs)`: how the nullability of a
 * `lhs ~ rhs` result follows from its operands. 1 = depends on both operands (array ~ array),
 * 2 = never null (exactly one side is an array), 0 = unknown (neither side is an array).
 * Both types are dereferenced (non-null).
 */
export function concatNullableResult(lhs: Type, rhs: Type): number {
    // T[] ~ T[]
    // T[] ~ T
    // T ~ T[]
    // T ~ T

    if (lhs.isStaticOrDynamicArray()) {
        if (rhs.isStaticOrDynamicArray())
            return 1; // Depends on lhs and rhs
        return 2; // non-null
    }
    else if (rhs.isStaticOrDynamicArray())
        return 2;

    return 0; // Unknown
}

/// dmd/dfa/utils.d:107 — `enum EqualityArgType` (int base, <= 32 bits -> TS numeric enum, 02 §4.2).
export enum EqualityArgType {
    Unknown,
    Struct,
    FloatingPoint,
    StaticArray,
    StaticArrayLHS,
    StaticArrayRHS,
    DynamicArray,
    AssociativeArray,
    Nullable,
}

/***********************************************************
 * Classifies how two types are compared for equality at runtime.
 *
 * This mirrors the logic in the compiler backend/glue layer.
 * The DFA needs this to accurately predict if an equality check (`==`)
 * involves simple integer comparison, array comparison, or struct comparison.
 *
 * dmd/dfa/utils.d:128 — `EqualityArgType equalityArgTypes(Type lhs, Type rhs)`. `lhs` is
 * dereferenced; a null `rhs` is read as `lhs` (the struct and floating-point answers come first and
 * never look at `rhs`).
 */
/// See_Also: EqualityArgType
export function equalityArgTypes(lhs: Type, rhs: Type | null): EqualityArgType {
    // This logic originally came from dmd's glue layer.
    // It was copied over and modified so that the DFA is accruate to runtime actions.

    // struct
    // floating point
    // lhs && rhs    static, dyamic array
    // lhs && rhs    associative array
    // otherwise integral

    if (lhs.ty === Tstruct)
        return EqualityArgType.Struct;
    else if (isFloating(lhs))
        return EqualityArgType.FloatingPoint;

    if (rhs === null)
        rhs = lhs; // Assume rhs is similar to lhs

    const lhsSArray = lhs.isTypeSArray() !== null, rhsSArray = rhs.isTypeSArray() !== null;
    if (lhsSArray && rhsSArray)
        return EqualityArgType.StaticArray;
    else if (lhsSArray)
        return EqualityArgType.StaticArrayLHS;
    else if (rhsSArray)
        return EqualityArgType.StaticArrayRHS;

    if (lhs.isTypeDArray() !== null || rhs.isTypeDArray() !== null)
        return EqualityArgType.DynamicArray;
    else if (lhs.ty === Taarray && rhs.ty === Taarray)
        return EqualityArgType.AssociativeArray;
    else if (isTypeNullable(lhs))
        return EqualityArgType.Nullable;
    else
        return EqualityArgType.Unknown;
}
