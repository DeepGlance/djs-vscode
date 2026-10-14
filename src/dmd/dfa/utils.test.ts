// Tests for src/dmd/dfa/utils.ts (ported from dmd/dfa/utils.d, LDC 1.43.0).
//
// dmd/dfa/utils.d ships no `unittest{}` block (10 §1): these pin the classification tables, whose answers
// decide what the fast DFA tracks (nullability, truthiness) and how it models `==` (the glue-layer
// classification, with its null-`rhs` fallback and the struct / floating-point answers that never look at rhs).

import { beforeEach, describe, expect, test } from "vitest";

// FIRST on purpose: this import makes utils.ts the module that enters the graph (01 §4.8).
import {
    EqualityArgType, concatNullableResult, equalityArgTypes, isIndexContextAA, isTypeNullable, isTypeTruthy,
} from "./utils.js";
import { Type, TypeAArray, TypeBasic } from "../mtype.js";
import { TY } from "../astenums.js";
import { arrayOf, pointerTo, sarrayOf } from "../typesem.js";
import { IndexExp, IntegerExp } from "../expression.js";
import { Loc } from "../location.js";
import { initSemaHarness } from "../../sema-harness.js";

beforeEach(() => {
    initSemaHarness();
});

describe("isTypeNullable (utils.d:29)", () => {
    test("null, pointer, slice, AA, class-like and function types", () => {
        expect(isTypeNullable(null)).toBe(false);
        expect(isTypeNullable(pointerTo(Type.tint32))).toBe(true);
        expect(isTypeNullable(arrayOf(Type.tint32))).toBe(true);
        expect(isTypeNullable(new TypeAArray(Type.tint32, Type.tint32))).toBe(true);
        expect(isTypeNullable(sarrayOf(Type.tint32, 4n))).toBe(false);
        expect(isTypeNullable(Type.tint32)).toBe(false);
        expect(isTypeNullable(Type.tbool)).toBe(false);
    });
});

describe("isTypeTruthy (utils.d:55)", () => {
    test("the excluded kinds answer false, everything else true", () => {
        expect(isTypeTruthy(null)).toBe(false);
        expect(isTypeTruthy(sarrayOf(Type.tint32, 4n))).toBe(false);
        expect(isTypeTruthy(Type.terror)).toBe(false);
        expect(isTypeTruthy(Type.tnoreturn)).toBe(false);
        expect(isTypeTruthy(Type.tint32)).toBe(true);
        expect(isTypeTruthy(Type.tbool)).toBe(true);
        expect(isTypeTruthy(Type.tfloat64)).toBe(true);
        expect(isTypeTruthy(pointerTo(Type.tint32))).toBe(true);
        expect(isTypeTruthy(arrayOf(Type.tint32))).toBe(true);
    });
});

describe("isIndexContextAA (utils.d:81)", () => {
    test("only an index into an associative array answers true; missing links answer false", () => {
        expect(isIndexContextAA(null)).toBe(false);

        const aa = new IntegerExp(Loc.initial, 0n, Type.tint32);
        aa.type = new TypeAArray(Type.tint32, Type.tint32);
        const zero = new IntegerExp(Loc.initial, 0n, Type.tint32);
        expect(isIndexContextAA(new IndexExp(Loc.initial, aa, zero))).toBe(true);

        const arr = new IntegerExp(Loc.initial, 0n, Type.tint32);
        arr.type = arrayOf(Type.tint32);
        expect(isIndexContextAA(new IndexExp(Loc.initial, arr, zero))).toBe(false);

        const untyped = new IntegerExp(Loc.initial, 0n, Type.tint32);
        untyped.type = null;
        expect(isIndexContextAA(new IndexExp(Loc.initial, untyped, untyped))).toBe(false);
    });
});

describe("concatNullableResult (utils.d:88)", () => {
    test("array ~ array depends on both (1), one array side is non-null (2), none is unknown (0)", () => {
        const s = arrayOf(Type.tint32), sa = sarrayOf(Type.tint32, 2n);
        expect(concatNullableResult(s, s)).toBe(1);
        expect(concatNullableResult(sa, s)).toBe(1);
        expect(concatNullableResult(s, Type.tint32)).toBe(2);
        expect(concatNullableResult(Type.tint32, sa)).toBe(2);
        expect(concatNullableResult(Type.tint32, Type.tint32)).toBe(0);
    });
});

describe("equalityArgTypes (utils.d:128)", () => {
    test("floating point wins before rhs is consulted", () => {
        expect(equalityArgTypes(Type.tfloat64, arrayOf(Type.tint32))).toBe(EqualityArgType.FloatingPoint);
        expect(equalityArgTypes(new TypeBasic(TY.Tfloat32), null)).toBe(EqualityArgType.FloatingPoint);
    });

    test("static arrays on either side, then dynamic arrays, then AAs", () => {
        const sa = sarrayOf(Type.tint32, 3n), da = arrayOf(Type.tint32);
        expect(equalityArgTypes(sa, sa)).toBe(EqualityArgType.StaticArray);
        expect(equalityArgTypes(sa, da)).toBe(EqualityArgType.StaticArrayLHS);
        expect(equalityArgTypes(da, sa)).toBe(EqualityArgType.StaticArrayRHS);
        expect(equalityArgTypes(da, Type.tint32)).toBe(EqualityArgType.DynamicArray);
        expect(equalityArgTypes(Type.tint32, da)).toBe(EqualityArgType.DynamicArray);
        const aa = new TypeAArray(Type.tint32, Type.tint32);
        expect(equalityArgTypes(aa, aa)).toBe(EqualityArgType.AssociativeArray);
    });

    test("a null rhs is read as lhs", () => {
        expect(equalityArgTypes(sarrayOf(Type.tint32, 3n), null)).toBe(EqualityArgType.StaticArray);
        const aa = new TypeAArray(Type.tint32, Type.tint32);
        expect(equalityArgTypes(aa, null)).toBe(EqualityArgType.AssociativeArray);
    });

    test("an AA against a non-AA is Nullable (the lhs is nullable), integers Unknown", () => {
        const aa = new TypeAArray(Type.tint32, Type.tint32);
        expect(equalityArgTypes(aa, Type.tint32)).toBe(EqualityArgType.Nullable);
        expect(equalityArgTypes(pointerTo(Type.tint32), pointerTo(Type.tint32))).toBe(EqualityArgType.Nullable);
        expect(equalityArgTypes(Type.tint32, Type.tint32)).toBe(EqualityArgType.Unknown);
    });
});
