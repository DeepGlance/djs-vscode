// Goal tests for src/dmd/ctfeexpr.ts.
//
// dmd/ctfeexpr.d has ZERO in-source `unittest{}` blocks (`grep -c unittest dmd/ctfeexpr.d` = 0), so this file
// takes the 10 §1.6b shape: one module-load smoke test plus behaviour pins, one `test()` per concern. The
// comparison / concatenation / length results are ground-truthed against ldc2 1.43.0 CTFE (`static assert`
// probes, listed per test); the diagnostic strings against the D literal at the cited ctfeexpr.d line.
// The last block pins the §2.5 walls on the exact paths D takes into unported code (10 §1.8).

import { initSemaHarness } from "../sema-harness.js"; // imports ./dmd/parse.js first: the module-graph root (10 §1.5)
import { beforeEach, describe, expect, test } from "vitest";
import {
    UnionExp, exceptionOrCantInterpret, needToCopyLiteral, copyLiteral, resolveArrayLength, resolveSlice,
    createBlockDuplicatedArrayLiteral, isAssocArray, isPointer, isTrueBool, isSafePointerCast,
    getAggregateFromPointer, pointToSameMemoryBlock, pointerDifference, pointerArithmetic, comparePointers,
    isFloatIntPaint, paintFloatInt, isCtfeComparable, specificCmp, intUnsignedCmp, intSignedCmp, realCmp, ctfeEqual,
    ctfeIdentity, ctfeCmp, ctfeCat, findKeyInAA, ctfeIndex, ctfeCast, assignInPlace, assignAssocArrayElement,
    changeArrayLiteralLength, isCtfeValueValid, isCtfeReferenceValid, voidInitLiteral, paintTypeOntoLiteral,
    paintTypeOntoLiteralNoPue, findFieldIndexByName, generateUncaughtError, isTypeInfo_Class, toBuiltinAAType,
    createBlockDuplicatedStringLiteral, showCtfeExpr,
} from "./ctfeexpr.js";
import {
    Expression, IntegerExp, RealExp, ArrayLiteralExp, AssocArrayLiteralExp, NullExp, AddrExp, IndexExp, SliceExp,
    CTFEExp, ErrorExp, VoidInitExp, OwnedBy, CatExp, StringExp, SymOffExp,
} from "./expression.js";
import { Type, TypeAArray } from "./mtype.js";
import { pointerTo, sarrayOf, arrayOf, constOf } from "./typesem.js";
import { VarDeclaration } from "./declaration.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { EXP } from "./tokens.js";
import { Array as DArray } from "./root/array.js";
import type { Expressions } from "./arraytypes.js";
import { setDiagnosticHandler } from "./errors.js";
import { dmdformat } from "./root/dmdformat.js";
import { ds, dsToJs } from "../dstring.js";
import { AssertError } from "../assert.js";

function int(v: number | bigint, t: Type = Type.tint32): IntegerExp {
    return new IntegerExp(Loc.initial, BigInt(v), t);
}

function exps(...es: Expression[]): Expressions {
    return DArray.from<Expression | null>(...es);
}

/// `[a, b, ...]` typed `int[]`, owned by code (the parser's default).
function intArray(...vs: number[]): ArrayLiteralExp {
    return new ArrayLiteralExp(Loc.initial, arrayOf(Type.tint32), exps(...vs.map((v) => int(v))));
}

function elementValues(e: Expression): bigint[] {
    const ale = e.isArrayLiteralExp()!;
    const out: bigint[] = [];
    for (let i = 0; i < ale.elements!.length; i++)
        out.push(ale.elements!.opIndex(i)!.isIntegerExp()!.value);
    return out;
}

/** Runs `fn` with diagnostics captured as `<header><message>` strings (the safe.test.ts convention). */
function captureDiags(fn: () => void): string[] {
    const diags: string[] = [];
    setDiagnosticHandler((_loc, _color, header, messageFormat, args) => {
        diags.push(dsToJs(header) + dsToJs(dmdformat(messageFormat, [...args])));
        return true;
    });
    try {
        fn();
    } finally {
        setDiagnosticHandler(null);
    }
    return diags;
}

describe("ctfeexpr.ts", () => {
    beforeEach(() => {
        initSemaHarness(); // also builds the CTFEExp sentinels (Expression._init, expression.d:149)
    });

    test("SMOKE: the module loads and its exported surface is callable", () => {
        // ctfeexpr.ts value-imports expression / typesem / expressionsem / dcast / constfold (a cycle with
        // constfold.ts); a load-order break in the core SCC would surface here (01 §4.8).
        expect(typeof Expression).toBe("function");
        for (const f of [
            exceptionOrCantInterpret, needToCopyLiteral, copyLiteral, resolveArrayLength, resolveSlice,
            createBlockDuplicatedArrayLiteral, createBlockDuplicatedStringLiteral, isAssocArray, toBuiltinAAType,
            isTypeInfo_Class, isPointer, isTrueBool, isSafePointerCast, getAggregateFromPointer,
            pointToSameMemoryBlock, pointerDifference, pointerArithmetic, comparePointers, isFloatIntPaint,
            paintFloatInt, isCtfeComparable, specificCmp, intUnsignedCmp, intSignedCmp, realCmp, ctfeEqual,
            ctfeIdentity, ctfeCmp, ctfeCat, findKeyInAA, ctfeIndex, ctfeCast, assignInPlace, assignAssocArrayElement,
            changeArrayLiteralLength, isCtfeValueValid, isCtfeReferenceValid, voidInitLiteral, paintTypeOntoLiteral,
            paintTypeOntoLiteralNoPue, findFieldIndexByName, generateUncaughtError, showCtfeExpr,
        ])
            expect(typeof f).toBe("function");
    });

    test("UnionExp: emplace/exp hold ONE reference; copy() answers the five CTFEExp singletons (ctfeexpr.d:62)", () => {
        const ue = new UnionExp();
        const lit = int(7);
        ue.emplace(lit);
        expect(ue.exp()).toBe(lit);
        const c = ue.copy();
        expect(c).not.toBe(lit); // default arm: a shallow Expression.copy()
        expect(c.isIntegerExp()!.value).toBe(7n);
        expect(c.type).toBe(Type.tint32);
        const sentinels: [EXP, CTFEExp][] = [
            [EXP.cantExpression, CTFEExp.cantexp!], [EXP.voidExpression, CTFEExp.voidexp!],
            [EXP.break_, CTFEExp.breakexp!], [EXP.continue_, CTFEExp.continueexp!], [EXP.goto_, CTFEExp.gotoexp!],
        ];
        for (const [op, singleton] of sentinels) {
            const u = new UnionExp();
            u.emplace(new CTFEExp(op)); // `emplaceExp!(CTFEExp)(pue, op)` builds a FRESH node...
            expect(u.copy()).toBe(singleton); // ...but copy() answers the shared singleton
        }
    });

    test("predicates: exceptionOrCantInterpret, isPointer, isAssocArray, isFloatIntPaint, isSafePointerCast, "
        + "isTrueBool, isCtfeComparable (ctfeexpr.d:150-988)", () => {
        expect(exceptionOrCantInterpret(null)).toBe(false);
        expect(exceptionOrCantInterpret(CTFEExp.cantexp)).toBe(true);
        expect(exceptionOrCantInterpret(CTFEExp.showcontext)).toBe(true);
        expect(exceptionOrCantInterpret(CTFEExp.voidexp)).toBe(false);
        expect(exceptionOrCantInterpret(int(1))).toBe(false);
        expect(isPointer(pointerTo(Type.tint32))).toBe(true);
        expect(isPointer(Type.tint32)).toBe(false);
        expect(isAssocArray(Type.tint32)).toBe(false);
        expect(isFloatIntPaint(Type.tfloat64, Type.tint64)).toBe(true);
        expect(isFloatIntPaint(Type.tint32, Type.tfloat32)).toBe(true);
        expect(isFloatIntPaint(Type.tfloat32, Type.tint64)).toBe(false);
        expect(isFloatIntPaint(Type.tint64, Type.tint64)).toBe(false);
        expect(isSafePointerCast(Type.tint32, Type.tuns32)).toBe(true);
        expect(isSafePointerCast(Type.tint32, Type.tvoid)).toBe(true);
        expect(isSafePointerCast(Type.tint32, Type.tint64)).toBe(false);
        expect(isSafePointerCast(pointerTo(Type.tint32), pointerTo(Type.tuns32))).toBe(true);
        expect(isTrueBool(int(1))).toBe(true);
        expect(isTrueBool(int(0))).toBe(false);
        expect(isTrueBool(new NullExp(Loc.initial, pointerTo(Type.tint32)))).toBe(false);
        expect(isCtfeComparable(int(1))).toBe(true);
        expect(isCtfeComparable(intArray(1))).toBe(true);
        expect(isCtfeComparable(new NullExp(Loc.initial, pointerTo(Type.tint32)))).toBe(true);
        expect(isCtfeComparable(CTFEExp.cantexp!)).toBe(false);
    });

    test("needToCopyLiteral: ownership decides; the walk passes index/slice/cast/concat (ctfeexpr.d:158)", () => {
        const code = intArray(1, 2);
        expect(needToCopyLiteral(code)).toBe(true);
        const ctfe = intArray(1, 2);
        ctfe.ownedByCtfe = OwnedBy.ctfe;
        expect(needToCopyLiteral(ctfe)).toBe(false);
        expect(needToCopyLiteral(new IndexExp(Loc.initial, code, int(0)))).toBe(true);
        expect(needToCopyLiteral(new IndexExp(Loc.initial, ctfe, int(0)))).toBe(false);
        expect(needToCopyLiteral(new CatExp(Loc.initial, ctfe, code))).toBe(true);
        expect(needToCopyLiteral(int(3))).toBe(false);
    });

    test("copyLiteral(array literal): a fresh CTFE-owned literal whose elements are copies (ctfeexpr.d:227)", () => {
        // ldc2: `int[] a = [1]; auto c = a ~ [2,3]; c[0] = 9;` leaves a[0] == 1 — CTFE mutates only copies.
        const orig = intArray(1, 2, 3);
        const copy = copyLiteral(orig).copy().isArrayLiteralExp()!;
        expect(copy).not.toBe(orig);
        expect(copy.ownedByCtfe).toBe(OwnedBy.ctfe);
        expect(copy.type).toBe(orig.type);
        expect(copy.elements).not.toBe(orig.elements);
        expect(copy.elements!.opIndex(0)).not.toBe(orig.elements!.opIndex(0));
        copy.elements!.opIndex(0)!.isIntegerExp()!.setInteger(9n);
        expect(elementValues(orig)).toEqual([1n, 2n, 3n]);
        expect(elementValues(copy)).toEqual([9n, 2n, 3n]);
    });

    test("copyLiteral(AA literal): keys and values copied, lowering fields carried (ctfeexpr.d:237)", () => {
        const aa = new AssocArrayLiteralExp(Loc.initial, exps(int(1)), exps(int(2)));
        const lowering = int(0);
        aa.lowering = lowering;
        const r = copyLiteral(aa).copy().isAssocArrayLiteralExp()!;
        expect(r).not.toBe(aa);
        expect(r.keys!.opIndex(0)).not.toBe(aa.keys!.opIndex(0));
        expect(r.values!.opIndex(0)!.isIntegerExp()!.value).toBe(2n);
        expect(r.lowering).toBe(lowering);
        expect(r.ownedByCtfe).toBe(OwnedBy.ctfe);
    });

    test("copyLiteral(simple value): the stored node is a memcpy clone (ctfeexpr.d:310, 02 §11.1)", () => {
        const lit = int(5);
        const ue = copyLiteral(lit);
        expect(ue.exp()).not.toBe(lit);
        expect(ue.exp().isIntegerExp()!.value).toBe(5n);
        expect(ue.exp().type).toBe(Type.tint32);
        const c = ue.copy();
        expect(c).not.toBe(lit);
        expect(c.isIntegerExp()!.value).toBe(5n);
    });

    test("copyLiteral: ErrorExp is cloned, not shared; a non-literal is an internal error (ctfeexpr.d:365-371)", () => {
        const err = ErrorExp.get(); // the shared singleton: a repaint of the stored node must not reach it
        const r = copyLiteral(err).exp();
        expect(r).not.toBe(err);
        expect(r.op).toBe(EXP.error);
        expect(r.type).toBe(err.type);
        const cat = new CatExp(Loc.initial, intArray(1), intArray(2));
        cat.type = arrayOf(Type.tint32);
        const diags = captureDiags(() => {
            expect(() => copyLiteral(cat)).toThrow(); // `assert(0)` after the diagnostic
        });
        expect(diags).toHaveLength(1);
        expect(diags[0]).toMatch(/^Error: CTFE internal error: literal `/);
    });

    test("resolveArrayLength over every literal shape (ctfeexpr.d:476)", () => {
        expect(resolveArrayLength(intArray(4, 5, 6))).toBe(3n);
        expect(resolveArrayLength(new NullExp(Loc.initial, arrayOf(Type.tint32)))).toBe(0n);
        const empty = new ArrayLiteralExp(Loc.initial, arrayOf(Type.tint32), null);
        expect(resolveArrayLength(empty)).toBe(0n);
        const aa = new AssocArrayLiteralExp(Loc.initial, exps(int(1), int(2)), exps(int(3), int(4)));
        expect(resolveArrayLength(aa)).toBe(2n);
        const sl = new SliceExp(Loc.initial, intArray(1, 2, 3, 4), int(1, Type.tsize_t), int(3, Type.tsize_t));
        expect(resolveArrayLength(sl)).toBe(2n);
    });

    test("resolveSlice: a non-slice is returned as is; slice of null is the null (ctfeexpr.d:456)", () => {
        const lit = intArray(1);
        expect(resolveSlice(lit)).toBe(lit);
        const nul = new NullExp(Loc.initial, arrayOf(Type.tint32));
        expect(resolveSlice(new SliceExp(Loc.initial, nul, int(0), int(0)))).toBe(nul);
    });

    test("createBlockDuplicatedArrayLiteral: dim copies of a scalar element, CTFE-owned (ctfeexpr.d:525)", () => {
        const ue = new UnionExp();
        const elem = int(7);
        const ale = createBlockDuplicatedArrayLiteral(ue, Loc.initial, sarrayOf(Type.tint32, 3n), elem, 3);
        expect(ue.exp()).toBe(ale);
        expect(ale.ownedByCtfe).toBe(OwnedBy.ctfe);
        expect(elementValues(ale)).toEqual([7n, 7n, 7n]);
        expect(ale.elements!.opIndex(2)).toBe(elem); // scalars are shared (mustCopy is for struct/sarray)
    });

    test("getAggregateFromPointer: &a[i] -> (a, i); `cast(int*)0` -> a typed null (ctfeexpr.d:666)", () => {
        const a = intArray(1, 2, 3);
        const ofs = { value: 99n };
        const p = new AddrExp(Loc.initial, new IndexExp(Loc.initial, a, int(2, Type.tsize_t)));
        expect(getAggregateFromPointer(p, ofs)).toBe(a);
        expect(ofs.value).toBe(2n);
        const zero = int(0, pointerTo(Type.tint32));
        const r = getAggregateFromPointer(zero, ofs);
        expect(r.op).toBe(EXP.null_);
        expect(r.type).toBe(Type.tint32); // `e.type.nextOf()`
        expect(ofs.value).toBe(0n);
    });

    test("pointerDifference: byte difference in one block; error + cantexp across blocks (ctfeexpr.d:744)", () => {
        // ldc2: `int[4] a; &a[3] - &a[1] == 2` — dinterpret divides this BYTE difference by the element size.
        const a = intArray(0, 0, 0, 0);
        const pt = pointerTo(Type.tint32);
        const p3 = new AddrExp(Loc.initial, new IndexExp(Loc.initial, a, int(3, Type.tsize_t)));
        const p1 = new AddrExp(Loc.initial, new IndexExp(Loc.initial, a, int(1, Type.tsize_t)));
        p3.type = pt;
        p1.type = pt;
        const r = pointerDifference(new UnionExp(), Loc.initial, Type.tint64, p3, p1);
        expect(r.isIntegerExp()!.value).toBe(8n);
        const b = intArray(0, 0);
        const q = new AddrExp(Loc.initial, new IndexExp(Loc.initial, b, int(0, Type.tsize_t)));
        q.type = pt;
        let res: Expression | null = null;
        const diags = captureDiags(() => {
            res = pointerDifference(new UnionExp(), Loc.initial, Type.tint64, p3, q);
        });
        expect(res!.op).toBe(EXP.cantExpression);
        expect(diags).toHaveLength(1);
        expect(diags[0]).toContain("cannot subtract pointers to two different memory blocks");
    });

    test("comparePointers: same block by offset, null ordering, distinct blocks (ctfeexpr.d:872)", () => {
        const a = intArray(1, 2);
        const b = intArray(1, 2);
        expect(comparePointers(EXP.lessThan, a, 0n, a, 1n)).toBe(1);
        expect(comparePointers(EXP.greaterOrEqual, a, 0n, a, 1n)).toBe(0);
        expect(comparePointers(EXP.notEqual, a, 1n, a, 1n)).toBe(0);
        const nul = new NullExp(Loc.initial, pointerTo(Type.tint32));
        expect(comparePointers(EXP.lessThan, nul, 0n, a, 0n)).toBe(1);
        expect(comparePointers(EXP.equal, nul, 0n, a, 0n)).toBe(0);
        expect(comparePointers(EXP.notIdentity, nul, 0n, a, 0n)).toBe(1);
        expect(comparePointers(EXP.equal, a, 0n, b, 0n)).toBe(0);
        expect(comparePointers(EXP.lessThan, a, 0n, b, 0n)).toBe(-1); // non-comparable memory blocks
    });

    test("pointToSameMemoryBlock: identity and equal integers (ctfeexpr.d:720)", () => {
        const a = intArray(1);
        expect(pointToSameMemoryBlock(a, a)).toBe(true);
        expect(pointToSameMemoryBlock(int(4, Type.tuns64), int(4, Type.tuns64))).toBe(true);
        expect(pointToSameMemoryBlock(int(4, Type.tuns64), int(5, Type.tuns64))).toBe(false);
        // same 64 bits read at two signednesses: D compares the `ulong` carriers
        expect(pointToSameMemoryBlock(int(-1, Type.tint64), int(0xFFFF_FFFF_FFFF_FFFFn, Type.tuns64))).toBe(true);
    });

    test("numeric comparators: same bits, signed vs unsigned; NaN is unordered (ctfeexpr.d:1010-1049)", () => {
        // ldc2: `cast(ulong)-1 > 1UL` and `-1L < 1L` both hold; `double.nan < 1.0` is false.
        expect(intUnsignedCmp(EXP.greaterThan, 0xFFFF_FFFF_FFFF_FFFFn, 1n)).toBe(true);
        expect(intSignedCmp(EXP.lessThan, -1n, 1n)).toBe(true);
        expect(specificCmp(EXP.lessThan, -3)).toBe(true);
        expect(specificCmp(EXP.greaterOrEqual, 0)).toBe(true);
        expect(realCmp(EXP.lessThan, NaN, 1.0)).toBe(false);
        expect(realCmp(EXP.greaterOrEqual, NaN, NaN)).toBe(false);
        expect(realCmp(EXP.lessOrEqual, 1.0, 1.0)).toBe(true);
        expect(() => realCmp(EXP.equal, NaN, 1.0)).toThrow(); // `default: assert(0)` in the unordered arm
    });

    test("ctfeCmp picks the signed or unsigned carrier from the operand types (ctfeexpr.d:1354)", () => {
        expect(ctfeCmp(Loc.initial, EXP.lessThan, int(-1, Type.tint64), int(1, Type.tint64))).toBe(true);
        expect(ctfeCmp(Loc.initial, EXP.lessThan, int(-1, Type.tint64), int(1, Type.tuns64))).toBe(false);
        expect(ctfeCmp(Loc.initial, EXP.lessThan, new RealExp(Loc.initial, 0.5, Type.tfloat64),
            new RealExp(Loc.initial, 1.5, Type.tfloat64))).toBe(true);
    });

    test("ctfeEqual on array literals: elementwise, then by length (ctfeexpr.d:1316)", () => {
        // ldc2: [1,2,3] == [1,2,3]; [1,2,3] != [1,2,4]; [1,2] != [1,2,3].
        expect(ctfeEqual(Loc.initial, EXP.equal, intArray(1, 2, 3), intArray(1, 2, 3))).toBe(true);
        expect(ctfeEqual(Loc.initial, EXP.notEqual, intArray(1, 2, 3), intArray(1, 2, 4))).toBe(true);
        expect(ctfeEqual(Loc.initial, EXP.equal, intArray(1, 2), intArray(1, 2, 3))).toBe(false);
        expect(ctfeEqual(Loc.initial, EXP.equal, new NullExp(Loc.initial, arrayOf(Type.tint32)),
            new ArrayLiteralExp(Loc.initial, arrayOf(Type.tint32), null))).toBe(true);
    });

    test("ctfeEqual on AA literals ignores key order (ctfeexpr.d:1270)", () => {
        // ldc2: `[1:2, 3:4] == [3:4, 1:2]`.
        const a = new AssocArrayLiteralExp(Loc.initial, exps(int(1), int(3)), exps(int(2), int(4)));
        const b = new AssocArrayLiteralExp(Loc.initial, exps(int(3), int(1)), exps(int(4), int(2)));
        const c = new AssocArrayLiteralExp(Loc.initial, exps(int(3), int(1)), exps(int(4), int(9)));
        const taa = new TypeAArray(Type.tint32, Type.tint32); // `int[int]`
        a.type = taa;
        b.type = taa;
        c.type = taa;
        expect(isAssocArray(taa)).toBe(true);
        expect(toBuiltinAAType(taa)).toBe(taa);
        expect(ctfeEqual(Loc.initial, EXP.equal, a, b)).toBe(true);
        expect(ctfeEqual(Loc.initial, EXP.equal, a, c)).toBe(false);
    });

    test("ctfeIdentity: null is null; NaN is NaN (same bits); symbol offsets (ctfeexpr.d:1322)", () => {
        // ldc2: `double.nan is double.nan` holds while `nan == nan` does not.
        const n1 = new NullExp(Loc.initial, pointerTo(Type.tint32));
        const n2 = new NullExp(Loc.initial, pointerTo(Type.tint32));
        expect(ctfeIdentity(Loc.initial, EXP.identity, n1, n2)).toBe(true);
        expect(ctfeIdentity(Loc.initial, EXP.notIdentity, n1, n2)).toBe(false);
        const nan1 = new RealExp(Loc.initial, NaN, Type.tfloat64);
        const nan2 = new RealExp(Loc.initial, NaN, Type.tfloat64);
        expect(ctfeIdentity(Loc.initial, EXP.identity, nan1, nan2)).toBe(true);
        expect(ctfeEqual(Loc.initial, EXP.equal, nan1, nan2)).toBe(false);
    });

    test("ctfeCat: [e1] ~ [e2] builds a fresh literal of copies; [e1] ~ null dups (ctfeexpr.d:1371)", () => {
        // ldc2: `int[] a = [1]; auto c = a ~ [2,3]; c[0] = 9;` gives c == [9,2,3] and leaves a[0] == 1.
        const a = intArray(1);
        const b = intArray(2, 3);
        const r = ctfeCat(Loc.initial, arrayOf(Type.tint32), a, b).exp();
        expect(elementValues(r)).toEqual([1n, 2n, 3n]);
        expect(r.isArrayLiteralExp()!.elements!.opIndex(0)).not.toBe(a.elements!.opIndex(0));
        const d = ctfeCat(Loc.initial, arrayOf(Type.tint32), a, new NullExp(Loc.initial, arrayOf(Type.tint32))).exp();
        expect(d).not.toBe(a);
        expect(elementValues(d)).toEqual([1n]);
        expect(d.type).toBe(arrayOf(Type.tint32));
    });

    test("findKeyInAA searches backwards (last duplicate wins) and reports the index (ctfeexpr.d:1465)", () => {
        const aa = new AssocArrayLiteralExp(Loc.initial, exps(int(1), int(2), int(1)), exps(int(10), int(20), int(30)));
        const pidx = { value: -1 };
        const v = findKeyInAA(Loc.initial, aa, int(1), pidx);
        expect(v!.isIntegerExp()!.value).toBe(30n);
        expect(pidx.value).toBe(2);
        expect(findKeyInAA(Loc.initial, aa, int(7))).toBe(null);
    });

    test("assignAssocArrayElement updates in place or appends (ctfeexpr.d:1662)", () => {
        // ldc2: `int[int] a = [1:2]; a[1] = 5; a[7] = 8;` -> length 2.
        const aa = new AssocArrayLiteralExp(Loc.initial, exps(int(1)), exps(int(2)));
        const five = int(5);
        expect(assignAssocArrayElement(Loc.initial, aa, int(1), five)).toBe(five);
        expect(aa.values!.opIndex(0)).toBe(five);
        assignAssocArrayElement(Loc.initial, aa, int(7), int(8));
        expect(aa.keys!.length).toBe(2);
        expect(aa.values!.opIndex(1)!.isIntegerExp()!.value).toBe(8n);
    });

    test("ctfeIndex: in bounds paints the element; out of bounds is the D diagnostic (ctfeexpr.d:1488)", () => {
        const a = intArray(4, 5, 6);
        expect(ctfeIndex(new UnionExp(), Loc.initial, Type.tint32, a, 1n)).toBe(a.elements!.opIndex(1));
        let r: Expression | null = null;
        const diags = captureDiags(() => {
            r = ctfeIndex(new UnionExp(), Loc.initial, Type.tint32, a, 5n);
        });
        expect(r).toBe(CTFEExp.cantexp);
        expect(diags).toEqual(["Error: array index 5 is out of bounds `[4, 5, 6][0 .. 3]`"]);
    });

    test("ctfeCast: same type keeps e's identity (ctfeexpr.d:1551); null paints (ctfeexpr.d:1524)", () => {
        const e = int(3);
        expect(ctfeCast(new UnionExp(), Loc.initial, Type.tint32, Type.tint32, e)).toBe(e);
        const nul = new NullExp(Loc.initial, pointerTo(Type.tint32));
        expect(ctfeCast(new UnionExp(), Loc.initial, pointerTo(Type.tint32), pointerTo(Type.tint32), nul)).toBe(nul);
    });

    test("assignInPlace: integers, reals and array literals are overwritten in place (ctfeexpr.d:1589)", () => {
        const d = int(1);
        assignInPlace(d, int(42));
        expect(d.value).toBe(42n);
        const r = new RealExp(Loc.initial, 1.0, Type.tfloat64);
        assignInPlace(r, new RealExp(Loc.initial, 2.5, Type.tfloat64));
        expect(r.value).toBe(2.5);
        const dst = intArray(1, 2);
        const src = intArray(7, 8);
        const keep = dst.elements;
        assignInPlace(dst, src);
        expect(dst.elements).toBe(keep); // references into dest stay valid
        expect(elementValues(dst)).toEqual([7n, 8n]);
    });

    test("changeArrayLiteralLength: grow fills .init, shrink truncates (ctfeexpr.d:1692)", () => {
        // ldc2: `[5, 6]` grown to 4 is `[5, 6, 0, 0]`; `[5, 6, 7]` shrunk to 1 is `[5]`.
        const t = arrayOf(Type.tint32).isTypeDArray()!;
        const g = changeArrayLiteralLength(new UnionExp(), Loc.initial, t, intArray(5, 6), 2, 4);
        expect(elementValues(g)).toEqual([5n, 6n, 0n, 0n]);
        expect(g.isArrayLiteralExp()!.ownedByCtfe).toBe(OwnedBy.ctfe);
        const s = changeArrayLiteralLength(new UnionExp(), Loc.initial, t, intArray(5, 6, 7), 3, 1);
        expect(elementValues(s)).toEqual([5n]);
    });

    test("isCtfeValueValid / isCtfeReferenceValid on the common shapes (ctfeexpr.d:1771, :1869)", () => {
        expect(isCtfeValueValid(int(1))).toBe(true);
        expect(isCtfeValueValid(new NullExp(Loc.initial, pointerTo(Type.tint32)))).toBe(true);
        expect(isCtfeValueValid(new NullExp(Loc.initial, Type.tint32))).toBe(false);
        expect(isCtfeValueValid(intArray(1))).toBe(true);
        expect(isCtfeReferenceValid(new IndexExp(Loc.initial, intArray(1), int(0)))).toBe(true);
        expect(isCtfeReferenceValid(new IndexExp(Loc.initial, int(1), int(0)))).toBe(false);
        const diags = captureDiags(() => {
            expect(isCtfeValueValid(CTFEExp.cantexp!)).toBe(false);
        });
        expect(diags).toHaveLength(1);
        expect(diags[0]).toMatch(/^Error: CTFE internal error: illegal CTFE value `/);
    });

    test("voidInitLiteral: a scalar is a VoidInitExp; int[3] is three of them (ctfeexpr.d:2013)", () => {
        const v = new VarDeclaration(Loc.initial, Type.tint32, Identifier.idPool(ds("x")), null);
        const s = voidInitLiteral(Type.tint32, v).exp();
        expect(s).toBeInstanceOf(VoidInitExp);
        expect(s.isVoidInitExp()!.var_).toBe(v);
        const arr = voidInitLiteral(sarrayOf(Type.tint32, 3n), v).exp().isArrayLiteralExp()!;
        expect(arr.elements!.length).toBe(3);
        expect(arr.elements!.opIndex(2)!.op).toBe(EXP.void_);
        expect(arr.ownedByCtfe).toBe(OwnedBy.ctfe);
    });

    test("paintTypeOntoLiteral: an equal type returns lit itself, both Form-B members (ctfeexpr.d:380, :387)", () => {
        const lit = int(1);
        expect(paintTypeOntoLiteralNoPue(Type.tint32, lit)).toBe(lit);
        expect(paintTypeOntoLiteral(new UnionExp(), Type.tint32, lit)).toBe(lit);
    });

    test("type painting repaints a CLONE, never the source literal (02 §11.1, ctfeexpr.d:442-444)", () => {
        // ctfeIndex of a `const(int)[]` literal read as `int`: the element keeps `const(int)`.
        const cint = constOf(Type.tint32);
        const elem = int(4, cint);
        const a = new ArrayLiteralExp(Loc.initial, arrayOf(cint), exps(elem));
        const r = ctfeIndex(new UnionExp(), Loc.initial, Type.tint32, a, 0n);
        expect(r).not.toBe(elem);
        expect(r.type).toBe(Type.tint32);
        expect(r.isIntegerExp()!.value).toBe(4n);
        expect(elem.type).toBe(cint);
        // ctfeCast of a `null` int* to void*: the source NullExp stays typed int*.
        const pint = pointerTo(Type.tint32);
        const nul = new NullExp(Loc.initial, pint);
        const c = ctfeCast(new UnionExp(), Loc.initial, Type.tvoidptr, Type.tvoidptr, nul);
        expect(c).not.toBe(nul);
        expect(c.type).toBe(Type.tvoidptr);
        expect(nul.type).toBe(pint);
    });

    // §2.5 walls: each stands on a path D takes into unported code (10 §1.8), and the paths their sweep opened

    test("pointerArithmetic: &a[1] + 4 bytes is &a[2], built through ctfeEmplaceExp (ctfeexpr.d:862-866)", () => {
        // RE-PIN (10 §1.8): the ctfeEmplaceExp wall is gone. ldc2: in CTFE `int[3] a; int* p = &a[1]; p + 1`
        // points at a[2]; the frontend lowers `p + 1` to a 4-byte offset, which is what reaches pointerArithmetic.
        const a = intArray(1, 2, 3);
        const p = new AddrExp(Loc.initial, new IndexExp(Loc.initial, a, int(1, Type.tsize_t)));
        p.type = pointerTo(Type.tint32);
        p.e1!.type = Type.tint32;
        const pt = pointerTo(Type.tint32);
        const r = pointerArithmetic(new UnionExp(), Loc.initial, EXP.add, pt, p, int(4, Type.tsize_t));
        expect(r.op).toBe(EXP.address);
        expect(r.type).toBe(pt);
        const ie = r.isAddrExp()!.e1!.isIndexExp()!;
        expect(ie.e1).toBe(a);
        expect(ie.e2!.isIntegerExp()!.value).toBe(2n);
        expect(ie.type).toBe(Type.tint32);
    });

    test("pointerArithmetic: void* and non-array aggregates are diagnosed before a wall (ctfeexpr.d:786, :803)", () => {
        const vp = new NullExp(Loc.initial, pointerTo(Type.tvoid));
        let r: Expression | null = null;
        let diags = captureDiags(() => {
            r = pointerArithmetic(new UnionExp(), Loc.initial, EXP.add, pointerTo(Type.tvoid), vp, int(1));
        });
        expect(r!.op).toBe(EXP.cantExpression);
        expect(diags).toEqual(["Error: cannot perform arithmetic on `void*` pointers at compile time"]);
        // an integer disguised as a pointer (`cast(int*)420`) is its own aggregate: not an array
        const ip = int(420, pointerTo(Type.tint32));
        diags = captureDiags(() => {
            r = pointerArithmetic(new UnionExp(), Loc.initial, EXP.add, pointerTo(Type.tint32), ip, int(4));
        });
        expect(r!.op).toBe(EXP.cantExpression);
        expect(diags).toEqual(["Error: cannot perform pointer arithmetic on non-arrays at compile time"]);
    });

    test("paintFloatInt reinterprets the bits through Compiler.paintAsType (ctfeexpr.d:965)", () => {
        // RE-PIN (10 §1.8): compiler.d is ported; 0x3FF0000000000000 is the IEEE double 1.0.
        const r = paintFloatInt(new UnionExp(), int(0x3FF0000000000000n, Type.tint64), Type.tfloat64);
        expect(r.op).toBe(EXP.float64);
        expect(r.type).toBe(Type.tfloat64);
        expect((r as RealExp).value).toBe(1.0);
        // an exception/cantexp operand returns before paintAsType (ctfeexpr.d:962)
        expect(paintFloatInt(new UnionExp(), CTFEExp.cantexp!, Type.tfloat64)).toBe(CTFEExp.cantexp);
    });

    test("paintTypeOntoLiteral: an array literal is repainted through a slice lit[0 .. 2] (ctfeexpr.d:420)", () => {
        // RE-PIN (10 §1.8): the ctfeEmplaceExp wall is gone; D wraps the literal in `lit[0 .. $]` and paints that.
        const lit = intArray(1, 2);
        const t = arrayOf(Type.tuns32);
        const r = paintTypeOntoLiteral(new UnionExp(), t, lit);
        expect(r.op).toBe(EXP.slice);
        expect(r.type).toBe(t);
        const se = r.isSliceExp()!;
        expect(se.e1).toBe(lit);
        expect(se.lwr!.isIntegerExp()!.value).toBe(0n);
        expect(se.upr!.isIntegerExp()!.value).toBe(2n);
    });

    // ── the StringExp payload at sz > 1 (11 §3.5: little-endian bytes of width sz) ────────────────────────────
    test("createBlockDuplicatedStringLiteral writes dim code units of width sz (ctfeexpr.d:556)", () => {
        // ldc2: `dchar[] a = new dchar[2]; a[1] = '😀';` in CTFE prints `\uFFFF😀` — the untouched unit is dchar.init,
        // 0xFFFF, duplicated at width sz like every unit `new wchar[n]` / `new dchar[n]` starts with.
        const w = createBlockDuplicatedStringLiteral(new UnionExp(), Loc.initial, arrayOf(Type.twchar), 0xffff, 3, 2);
        expect([...w.peekData()]).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
        expect(w.ownedByCtfe).toBe(OwnedBy.ctfe);
        const d = createBlockDuplicatedStringLiteral(new UnionExp(), Loc.initial, arrayOf(Type.tdchar), 0x1f600, 2, 4);
        expect([...d.peekDstring()]).toEqual([0x1f600, 0x1f600]);
        expect([...d.peekData()]).toEqual([0x00, 0xf6, 0x01, 0x00, 0x00, 0xf6, 0x01, 0x00]);
        const tl = arrayOf(Type.tuns64);
        const l = createBlockDuplicatedStringLiteral(new UnionExp(), Loc.initial, tl, 0xffffffff, 1, 8);
        expect(l.getIndex(0)).toBe(0xffffffffn);
    });

    test("changeArrayLiteralLength grows a wchar string with wchar.init units (ctfeexpr.d:1692)", () => {
        // ldc2: `wchar[] a = new wchar[2]; a[0] = 'a'; a[1] = 'b'; a.length = 4; a[3] = 'z';` prints `ab￿z`.
        const t = arrayOf(Type.twchar).isTypeDArray()!;
        const old = new StringExp(Loc.initial, [0x61, 0x00, 0x62, 0x00], 2, 2);
        old.type = t;
        const g = changeArrayLiteralLength(new UnionExp(), Loc.initial, t, old, 2, 4).isStringExp()!;
        expect(g.sz).toBe(2);
        expect([...g.peekWstring()]).toEqual([0x61, 0x62, 0xffff, 0xffff]);
        expect(g.ownedByCtfe).toBe(OwnedBy.ctfe);
        const td = arrayOf(Type.tdchar).isTypeDArray()!;
        const oldd = new StringExp(Loc.initial, [0x61, 0, 0, 0], 1, 4);
        oldd.type = td;
        const gd = changeArrayLiteralLength(new UnionExp(), Loc.initial, td, oldd, 1, 2).isStringExp()!;
        expect([...gd.peekDstring()]).toEqual([0x61, 0xffff]); // dchar.init is 0x0000FFFF
    });

    test("copyLiteral of a wchar string: a fresh payload that CTFE writes keep apart (ctfeexpr.d:214)", () => {
        const se = new StringExp(Loc.initial, [0x61, 0x00, 0xac, 0x20], 2, 2);
        se.type = arrayOf(Type.twchar);
        const c = copyLiteral(se).exp().isStringExp()!;
        expect([...c.peekWstring()]).toEqual([0x61, 0x20ac]);
        c.setCodeUnit(0, 0x7a);
        expect(se.getCodeUnit(0)).toBe(0x61);
        expect(c.peekData().buffer).not.toBe(se.peekData().buffer);
    });

    test("pointerDifference over strings: copies share the block, two literals do not (ctfeexpr.d:755)", () => {
        // ldc2: `string s = "abcd"; string t = s; &s[3] - &t[0]` is 3; with `t = "abcd"` (a second literal) it is
        // `cannot subtract pointers to two different memory blocks`.
        const pt = pointerTo(Type.tchar);
        const s = new StringExp(Loc.initial, [0x61, 0x62, 0x63, 0x64]);
        s.type = arrayOf(Type.tchar);
        const at = (agg: Expression, i: number): AddrExp => {
            const a = new AddrExp(Loc.initial, new IndexExp(Loc.initial, agg, int(i, Type.tsize_t)));
            a.type = pt;
            return a;
        };
        const same = pointerDifference(new UnionExp(), Loc.initial, Type.tint64, at(s, 3), at(s.copy(), 0));
        expect(same.isIntegerExp()!.value).toBe(3n);
        const other = new StringExp(Loc.initial, [0x61, 0x62, 0x63, 0x64]);
        other.type = arrayOf(Type.tchar);
        let res: Expression | null = null;
        const diags = captureDiags(() => {
            res = pointerDifference(new UnionExp(), Loc.initial, Type.tint64, at(s, 3), at(other, 0));
        });
        expect(res!.op).toBe(EXP.cantExpression);
        expect(diags[0]).toContain("cannot subtract pointers to two different memory blocks");
    });

    test("pointerArithmetic, zero-size pointee: udiv's 0, no error (ctfeexpr.d:824/:826)", () => {
        // ldc2 compiles `int[0][3] a; int[0]* p = &a[0]; p = p + 1; --p;` in CTFE clean: arm64 `udiv` by 0 is 0
        // (09 §3.1, as dcast.d:1483). The pointer stays at index 0: `eptr` is `a[0]`, typed `int[0]`, so D's
        // static-array branch builds `&a[0 .. 0]`. An offset of 5 makes any nonzero quotient leave `[0..3]`.
        const int0 = sarrayOf(Type.tint32, 0n);
        const a = new ArrayLiteralExp(Loc.initial, sarrayOf(int0, 3n), exps());
        const elem = new IndexExp(Loc.initial, a, int(0, Type.tsize_t));
        elem.type = int0;
        const p = new AddrExp(Loc.initial, elem);
        p.type = pointerTo(int0);
        for (const op of [EXP.add, EXP.min]) {
            let res: Expression | null = null;
            const diags = captureDiags(() => {
                res = pointerArithmetic(new UnionExp(), Loc.initial, op, pointerTo(int0), p, int(5, Type.tsize_t));
            });
            expect(diags).toEqual([]);
            const se = res!.isAddrExp()!.e1!.isSliceExp()!;
            expect(se.lwr!.isIntegerExp()!.value).toBe(0n);
            expect(se.upr!.isIntegerExp()!.value).toBe(0n);
        }
    });

    test("pointerArithmetic over a symbol offset, zero-size pointee: udiv's 0, no error (ctfeexpr.d:813)", () => {
        // ldc2 compiles `__gshared int[0][3] ga; int k() { int[0]* p = &ga[0]; p = p + 1; p = p - 1; p -= 5;
        // return 4; } enum kk = k();` clean and prints 4 (09 §3.1, as dcast.d:1483). The result offset is
        // `indx * sz`, 0 whatever the quotient; the offset of 5 is what pins the quotient: any nonzero one
        // leaves `[0..3]` and errors.
        const int0 = sarrayOf(Type.tint32, 0n);
        const ga = new VarDeclaration(Loc.initial, sarrayOf(int0, 3n), Identifier.idPool(ds("ga")), null);
        const p = new SymOffExp(Loc.initial, ga, 0n);
        p.type = pointerTo(int0);
        for (const op of [EXP.add, EXP.min]) {
            let res: Expression | null = null;
            const diags = captureDiags(() => {
                res = pointerArithmetic(new UnionExp(), Loc.initial, op, pointerTo(int0), p, int(5, Type.tsize_t));
            });
            expect(diags).toEqual([]);
            expect(res!.isSymOffExp()!.offset).toBe(0n);
        }
    });

    test("pointerDifference over two wstring nodes keeps D's `assert(sz == 1)` in peekString (ctfeexpr.d:756)", () => {
        // A known gap: ldc2's release build drops the assert, so `enum w = "abc"w; w.ptr + 2 - w.ptr` in CTFE
        // prints 2 there; a debug-built dmd and the port stop on the assert (10 §2.2).
        const pt = pointerTo(Type.twchar);
        const w = new StringExp(Loc.initial, [0x61, 0, 0x62, 0, 0x63, 0], 3, 2);
        w.type = arrayOf(Type.twchar);
        const at = (agg: Expression, i: number): AddrExp => {
            const a = new AddrExp(Loc.initial, new IndexExp(Loc.initial, agg, int(i, Type.tsize_t)));
            a.type = pt;
            return a;
        };
        expect(() => pointerDifference(new UnionExp(), Loc.initial, Type.tint64, at(w, 2), at(w.copy(), 0)))
            .toThrow(AssertError);
        // the same node on both sides is `agg1 == agg2` (ctfeexpr.d:748), before the string arm
        expect(pointerDifference(new UnionExp(), Loc.initial, Type.tint64, at(w, 2), at(w, 0))
            .isIntegerExp()!.value).toBe(4n);
    });
});
