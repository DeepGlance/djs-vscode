// Goal tests for src/dmd/optimize.ts.
//
// dmd/optimize.d has ZERO in-source `unittest{}` blocks (`grep -c unittest dmd/optimize.d` = 0), so this
// file takes the 10 §1.6b shape: one module-load smoke test plus behaviour pins, one `test()` per concern,
// for what the whole-file translation made live. Every folded shape is ground-truthed against
// `ldc2 -c -o- -vcg-ast` (LDC 1.43.0); every diagnostic string against ldc2 stderr or, where ldc2's own
// semantic pass stops the program earlier, against the D literal at the cited optimize.d line.
//
// The constant folds run through constfold.ts (its own pins live in constfold.test.ts). The last block pins the folds
// ldc2 performs on the exact paths D takes into constfold — the former §2.5 walls there, converted to the live
// behaviour (10 §1.8 rule 7) — and the one that still stops downstream, in the StringExp payload accessors.

import { initSemaHarness } from "../sema-harness.js"; // imports ./dmd/parse.js first: the module-graph root (10 §1.5)
import { beforeEach, describe, expect, test } from "vitest";
import { optimize, expandVar, setLengthVarIfKnown, setLengthVarIfKnownFromExpression } from "./optimize.js";
import {
    Expression, IntegerExp, StringExp, ArrayLiteralExp, VarExp, LogicalExp, CondExp, AddrExp, PtrExp, SymOffExp,
    ShlExp, ShlAssignExp, AddExp, MulExp, CatExp, NegExp, CastExp, ArrayLengthExp, ErrorExp, IndexExp, CmpExp,
    EqualExp, SliceExp, PowExp, RealExp, WANTvalue,
} from "./expression.js";
import { Type } from "./mtype.js";
import { pointerTo, sarrayOf, arrayOf, immutableOf } from "./typesem.js";
import { VarDeclaration } from "./declaration.js";
import { ExpInitializer, VoidInitializer } from "./init.js";
import { PASS } from "./dsymbol.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { EXP } from "./tokens.js";
import { STC } from "./astenums.js";
import { global } from "./globals.js";
import { Array as DArray } from "./root/array.js";
import { setDiagnosticHandler } from "./errors.js";
import { dmdformat } from "./root/dmdformat.js";
import { ds, dsToJs } from "../dstring.js";
import { TY } from "./astenums.js";

/// A local variable whose semantic has already run (so `expandVar` does not re-enter `dsymbolSemantic`).
function localVar(name: string, t: Type): VarDeclaration {
    const v = new VarDeclaration(Loc.initial, t, Identifier.idPool(ds(name)), null);
    v.semanticRun = PASS.semanticdone;
    return v;
}

function int(v: number, t: Type = Type.tint32): IntegerExp {
    return new IntegerExp(Loc.initial, BigInt(v), t);
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

describe("optimize.ts", () => {
    beforeEach(() => {
        initSemaHarness();
    });

    test("SMOKE: the module loads and its exported surface is callable", () => {
        // optimize.ts value-imports expression / mtype / expressionsem / typesem / dcast / dsymbolsem / dclass;
        // a load-order cycle in the core SCC would surface here (01 §4.8).
        expect(typeof Expression).toBe("function");
        for (const f of [optimize, expandVar, setLengthVarIfKnown, setLengthVarIfKnownFromExpression])
            expect(typeof f).toBe("function");
    });

    test("a literal is the fixed point: the default arm leaves it unchanged (optimize.d:1495)", () => {
        const lit = int(42);
        expect(optimize(lit, WANTvalue)).toBe(lit);
        expect(global.errors).toBe(0);
    });

    describe("setLengthVarIfKnown — `$` becomes known (optimize.d:220/:249)", () => {
        test("Type form: a static array fixes `$` to its dimension, as `static const size_t`", () => {
            const lengthVar = localVar("__dollar", Type.tsize_t);
            setLengthVarIfKnown(lengthVar, sarrayOf(Type.tint32, 3n));
            const ei = lengthVar._init!.isExpInitializer()!;
            expect(ei.exp!.isIntegerExp()!.value).toBe(3n);
            expect(ei.exp!.type).toBe(Type.tsize_t);
            expect(lengthVar.storage_class & (STC.static_ | STC.const_)).toBe(STC.static_ | STC.const_);
        });

        test("Type form: a dynamic array leaves `$` unknown; null lengthVar and a computed length are no-ops", () => {
            const lengthVar = localVar("__dollar", Type.tsize_t);
            setLengthVarIfKnown(lengthVar, arrayOf(Type.tint32));
            expect(lengthVar._init).toBeNull();
            setLengthVarIfKnown(null, sarrayOf(Type.tint32, 3n)); // `if (!lengthVar) return;`
            const prior = new ExpInitializer(Loc.initial, int(9, Type.tsize_t));
            lengthVar._init = prior;
            setLengthVarIfKnown(lengthVar, sarrayOf(Type.tint32, 3n)); // previously calculated
            expect(lengthVar._init).toBe(prior);
        });

        test("Expression form: a string literal, an array literal, and a void initializer that gets replaced", () => {
            const lv1 = localVar("__dollar", Type.tsize_t);
            setLengthVarIfKnownFromExpression(lv1, new StringExp(Loc.initial, [0x61, 0x62, 0x63, 0x64]));
            expect(lv1._init!.isExpInitializer()!.exp!.isIntegerExp()!.value).toBe(4n);

            const lv2 = localVar("__dollar", Type.tsize_t);
            lv2._init = new VoidInitializer(Loc.initial); // a void initializer does not count as computed
            const elems = new DArray<Expression | null>();
            elems.push(int(1)).push(int(2));
            setLengthVarIfKnownFromExpression(lv2, new ArrayLiteralExp(Loc.initial, arrayOf(Type.tint32), elems));
            expect(lv2._init!.isExpInitializer()!.exp!.isIntegerExp()!.value).toBe(2n);
        });
    });

    test("expandVar: null and a mutable local expand to nothing (optimize.d:78/:179)", () => {
        expect(expandVar(WANTvalue, null)).toBeNull();
        expect(expandVar(WANTvalue, localVar("m", Type.tint32))).toBeNull();
    });

    describe("visitLogical (optimize.d:1257) — ldc2 -vcg-ast", () => {
        test("`true || b` folds to `true` (the e1 node itself)", () => {
            const t = IntegerExp.createBool(true);
            const e = new LogicalExp(Loc.initial, EXP.orOr, t, new VarExp(Loc.initial, localVar("b", Type.tbool)));
            e.type = Type.tbool;
            expect(optimize(e, WANTvalue)).toBe(t);
        });

        test("`b || false` folds to `b`", () => {
            const b = new VarExp(Loc.initial, localVar("b", Type.tbool));
            const e = new LogicalExp(Loc.initial, EXP.orOr, b, IntegerExp.createBool(false));
            e.type = Type.tbool;
            expect(optimize(e, WANTvalue)).toBe(b);
        });

        test("`b && false` folds to `false`: (b, false) is built, then the side-effect-free comma drops b", () => {
            const e = new LogicalExp(Loc.initial, EXP.andAnd, new VarExp(Loc.initial, localVar("b", Type.tbool)),
                IntegerExp.createBool(false));
            e.type = Type.tbool;
            const r = optimize(e, WANTvalue);
            expect(r.op).toBe(EXP.int64);
            expect(r.isIntegerExp()!.value).toBe(0n);
            expect(r.type).toBe(Type.tbool);
        });
    });

    test("visitCond: `true ? a : c` folds to `a` (optimize.d:1383; ldc2 -vcg-ast)", () => {
        const a = new VarExp(Loc.initial, localVar("a", Type.tint32));
        const c = new VarExp(Loc.initial, localVar("c", Type.tint32));
        const e = new CondExp(Loc.initial, IntegerExp.createBool(true), a, c);
        e.type = Type.tint32;
        expect(optimize(e, WANTvalue)).toBe(a);
    });

    test("visitAddr: `&*p` folds to `p` (optimize.d:446; ldc2 -vcg-ast `return p;`)", () => {
        const pint = pointerTo(Type.tint32);
        const p = new VarExp(Loc.initial, localVar("p", pint));
        const e = new AddrExp(Loc.initial, new PtrExp(Loc.initial, p, Type.tint32), pint);
        expect(optimize(e, WANTvalue)).toBe(p);
    });

    test("`*&v` keeps the dereference over a SymOffExp (optimize.d:475; ldc2 -vcg-ast `return *& v;`)", () => {
        const v = localVar("v", Type.tint32);
        const e = new PtrExp(Loc.initial, new AddrExp(Loc.initial, new VarExp(Loc.initial, v), pointerTo(Type.tint32)),
            Type.tint32);
        const r = optimize(e, WANTvalue);
        expect(r).toBe(e);
        const so = r.isPtrExp()!.e1!.isSymOffExp();
        expect(so).toBeInstanceOf(SymOffExp);
        expect(so!.var_).toBe(v);
        expect(so!.offset).toBe(0n);
    });

    // ── cantexp answers: where the constfold callee answers cantexp before doing any work, D leaves the node
    // unchanged (`if (CTFEExp.isCantExp(ret)) ret = e;`). ldc2 -vcg-ast keeps each of these forms as written.
    describe("non-constant operands pass through unchanged (constfold answers cantexp)", () => {
        const ivar = (n: string): VarExp => new VarExp(Loc.initial, localVar(n, Type.tint32));

        test("`a < b` (dispatch optimize.d:1488; Cmp's cantexp guard, constfold.d:876-880)", () => {
            const e = new CmpExp(EXP.lessThan, Loc.initial, ivar("a"), ivar("b"));
            e.type = Type.tbool;
            expect(optimize(e, WANTvalue)).toBe(e);
        });

        test("`a == b` (dispatch optimize.d:1481; Equal's cantexp guard, constfold.d:764-768)", () => {
            const e = new EqualExp(EXP.equal, Loc.initial, ivar("a"), ivar("b"));
            e.type = Type.tbool;
            expect(optimize(e, WANTvalue)).toBe(e);
        });

        test("`arr[i]` (dispatch optimize.d:1484; Index's final cantexp, constfold.d:1210-1211)", () => {
            const arr = new VarExp(Loc.initial, localVar("arr", arrayOf(Type.tint32)));
            const e = new IndexExp(Loc.initial, arr, new VarExp(Loc.initial, localVar("i", Type.tsize_t)));
            e.type = Type.tint32;
            expect(optimize(e, WANTvalue)).toBe(e);
        });

        test("`arr[i .. j]` (dispatch optimize.d:1485; Slice's final cantexp, constfold.d:1273-1274)", () => {
            const arr = new VarExp(Loc.initial, localVar("arr", arrayOf(Type.tint32)));
            const e = new SliceExp(Loc.initial, arr, new VarExp(Loc.initial, localVar("i", Type.tsize_t)),
                new VarExp(Loc.initial, localVar("j", Type.tsize_t)));
            e.type = arrayOf(Type.tint32);
            expect(optimize(e, WANTvalue)).toBe(e);
        });

        test("`*(p + n)` (dispatch optimize.d:1435; Ptr's cantexp outside its guard, constfold.d:1721-1722)", () => {
            const pint = pointerTo(Type.tint32);
            const add = new AddExp(Loc.initial, new VarExp(Loc.initial, localVar("p", pint)), ivar("n"));
            add.type = pint;
            const e = new PtrExp(Loc.initial, add, Type.tint32);
            expect(optimize(e, WANTvalue)).toBe(e);
        });
    });

    describe("diagnostics", () => {
        test("`1 << 40` on int: shift out of range + ErrorExp (dispatch optimize.d:1471, message :1033; ldc2)", () => {
            const e = new ShlExp(Loc.initial, int(1), int(40));
            e.type = Type.tint32;
            let r: Expression | null = null;
            const diags = captureDiags(() => { r = optimize(e, WANTvalue); });
            expect(diags).toEqual(["Error: shift by 40 is outside the range `0..31`"]);
            expect(r).toBe(ErrorExp.get());
            expect(global.errors).toBe(1);
        });

        test("`x <<= 40` on int: shift-assign out of range (dispatch optimize.d:1450, message :939; ldc2)", () => {
            const e = new ShlAssignExp(Loc.initial, new VarExp(Loc.initial, localVar("x", Type.tint32)), int(40));
            e.type = Type.tint32;
            let r: Expression | null = null;
            const diags = captureDiags(() => { r = optimize(e, WANTvalue); });
            expect(diags).toEqual(["Error: shift assign by 40 is outside the range `0..31`"]);
            expect(r).toBe(ErrorExp.get());
            expect(global.errors).toBe(1);
        });

    });

    // visitPow's "if e2 *could* have been an integer" rewrite (optimize.d:1095-1100). `x` is a non-constant double,
    // so no constfold `Pow` runs afterwards. Expected forms are ldc2-1.43.0 `-vcg-ast` output (arm64-apple-darwin):
    // the float -> long cast saturates there (fcvtzs), so 2^63 becomes long.max and NaN/inf stay floating.
    describe("visitPow: an integral-valued real exponent becomes a long (optimize.d:1095; ldc2 -vcg-ast)", () => {
        const pow = (exponent: number): PowExp => {
            const e = new PowExp(Loc.initial, new VarExp(Loc.initial, localVar("x", Type.tfloat64)),
                new RealExp(Loc.initial, exponent, Type.tfloat64));
            e.type = Type.tfloat64;
            return e;
        };
        const exponentOf = (exponent: number): Expression => optimize(pow(exponent), WANTvalue).isPowExp()!.e2!;

        test("`x ^^ 9223372036854775808.0` -> `pow(x, 9223372036854775807L)`: 2^63 saturates to long.max", () => {
            const e2 = exponentOf(9223372036854775808);
            expect(e2.op).toBe(EXP.int64);
            expect(e2.isIntegerExp()!.value).toBe(9223372036854775807n);
            expect(e2.type).toBe(Type.tint64);
        });

        test("`x ^^ -9223372036854775808.0` -> `pow(x, cast(long)-9223372036854775808)`", () => {
            const e2 = exponentOf(-9223372036854775808);
            expect(e2.op).toBe(EXP.int64);
            expect(e2.isIntegerExp()!.value).toBe(-9223372036854775808n);
        });

        test("`x ^^ 3.0` -> `pow(x, 3L)`", () => {
            expect(exponentOf(3).isIntegerExp()!.value).toBe(3n);
        });

        test("`x ^^ 2.5`, `x ^^ 1e30`, `x ^^ double.nan`, `x ^^ double.infinity` keep the real exponent", () => {
            for (const v of [2.5, 1e30, NaN, Infinity])
                expect(exponentOf(v).op, String(v)).toBe(EXP.float64);
        });
    });

    // ── constfold folds (10 §1.8 rule 7: each former wall pin converted to the value ldc2 folds to) ──────────────────
    describe("constfold folds — the folds ldc2 performs, on D's own call paths", () => {
        test("`1 + 2 * 3` folds to 7 (ldc2: `enum int x = 7;`; dispatch optimize.d:1466, :1468)", () => {
            // RE-PIN: was the Mul wall (constfold.d:224) at optimize.d:996.
            const mul = new MulExp(Loc.initial, int(2), int(3));
            mul.type = Type.tint32;
            const add = new AddExp(Loc.initial, int(1), mul);
            add.type = Type.tint32;
            const r = optimize(add, WANTvalue);
            expect(r.op).toBe(EXP.int64);
            expect(r.isIntegerExp()!.value).toBe(7n);
            expect(r.type).toBe(Type.tint32);
        });

        test("`\"a\" ~ \"b\"` folds to `\"ab\"` (ldc2), test12567e.d's path (constfold.d:1479)", () => {
            const cat = new CatExp(Loc.initial, new StringExp(Loc.initial, [0x61]), new StringExp(Loc.initial, [0x62]));
            cat.type = Type.tstring;
            cat.e1!.type = Type.tstring;
            cat.e2!.type = Type.tstring;
            const r = optimize(cat, WANTvalue).isStringExp()!;
            expect([...r.peekString()]).toEqual([0x61, 0x62]);
            expect(r.type).toBe(Type.tstring);
        });

        test("`cast(long) 7` folds to `7L` past every non-fold rewrite (dispatch optimize.d:1439)", () => {
            // RE-PIN: was the Cast wall (constfold.d:917) at optimize.d:918.
            const c = new CastExp(Loc.initial, int(7), Type.tint64);
            c.type = Type.tint64;
            const r = optimize(c, WANTvalue);
            expect(r.isIntegerExp()!.value).toBe(7n);
            expect(r.type).toBe(Type.tint64);
        });

        test("`-5` folds to -5 (dispatch :1430); `\"abc\".length` folds to `3LU` (:1479)", () => {
            // RE-PIN: were the Neg (constfold.d:69) and ArrayLength (constfold.d:1083) walls.
            const neg = new NegExp(Loc.initial, int(5));
            neg.type = Type.tint32;
            expect(optimize(neg, WANTvalue).isIntegerExp()!.value).toBe(-5n);
            const se = new StringExp(Loc.initial, [0x61, 0x62, 0x63]);
            se.type = sarrayOf(immutableOf(Type.tchar), 3n);
            const al = new ArrayLengthExp(Loc.initial, se);
            al.type = Type.tsize_t;
            const r = optimize(al, WANTvalue);
            expect(r.isIntegerExp()!.value).toBe(3n);
            expect(r.type!.ty).toBe(TY.Tuns64);
        });

        test("`&a[5]` on `int[3] a`: Index rejects the index (dispatch optimize.d:1434, then :1484)", () => {
            // RE-PIN: was the Index wall (constfold.d:1117) at optimize.d:1209. visitAddr optimizes its operand first,
            // keeping it an lvalue (optimize.d:442): visitIndex reaches Index, whose Tsarray arm (constfold.d:1137)
            // emits the bounds error (ldc2 stderr, same text) and answers ErrorExp; expOptimize returns it.
            const a = new VarExp(Loc.initial, localVar("a", sarrayOf(Type.tint32, 3n)));
            const ie = new IndexExp(Loc.initial, a, int(5, Type.tsize_t));
            ie.type = Type.tint32;
            const e = new AddrExp(Loc.initial, ie, pointerTo(Type.tint32));
            let r: Expression | null = null;
            const diags = captureDiags(() => { r = optimize(e, WANTvalue); });
            expect(diags).toEqual(["Error: array index 5 is out of bounds `a[0 .. 3]`"]);
            expect(r!.op).toBe(EXP.error);
            expect(global.errors).toBe(1);
        });

        test("paired state: the edtor re-optimize folds `-5` in place, `v.inuse` restored (optimize.d:333-335)", () => {
            // RE-PIN: the edtor's Neg fold used to throw its wall inside the inuse region.
            const v = localVar("s", Type.tint32);
            const neg = new NegExp(Loc.initial, int(5));
            neg.type = Type.tint32;
            v.edtor = neg;
            const ve = new VarExp(Loc.initial, v);
            expect(optimize(ve, WANTvalue)).toBe(ve);
            expect(v.edtor!.isIntegerExp()!.value).toBe(-5n);
            expect(v.inuse).toBe(0);
        });

        test(
            "paired state: the edtor re-optimize folds `(-8.0) ^^ 0.5` to nan, `v.inuse` restored (optimize.d:333-335)",
            () => {
            // RE-PIN (10 §1.8): constfold's Pow negative-base arm used to throw its Target.RealProperties wall
            // inside the `v.inuse++ ... v.inuse--` region; it now reads target.RealProperties.nan (constfold.d:483).
            const v = localVar("s", Type.tint32);
            const pow = new PowExp(Loc.initial, new RealExp(Loc.initial, -8.0, Type.tfloat64),
                new RealExp(Loc.initial, 0.5, Type.tfloat64));
            pow.type = Type.tfloat64;
            v.edtor = pow;
            const ve = new VarExp(Loc.initial, v);
            expect(optimize(ve, WANTvalue)).toBe(ve);
            expect(v.edtor.op).toBe(EXP.float64);
            expect(Number.isNaN(v.edtor.isRealExp()!.value)).toBe(true);
            expect(v.inuse).toBe(0);
        });

        test("a non-constant operand takes no fold: `v + 1` is returned unchanged", () => {
            const add = new AddExp(Loc.initial, new VarExp(Loc.initial, localVar("v", Type.tint32)), int(1));
            add.type = Type.tint32;
            expect(optimize(add, WANTvalue)).toBe(add);
        });
    });
});
