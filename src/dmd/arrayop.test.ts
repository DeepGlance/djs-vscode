// Goal tests for src/dmd/arrayop.ts.
//
// dmd/arrayop.d has ZERO in-source `unittest{}` blocks, so this file takes the 10 §1.6b CANONICAL
// shape: ONE module-load smoke test plus one pin per risky RESOLVED construct, built with the
// existing harness conventions (the 10 §1.5 init snippet) and nothing else.
//
// The pins, one per concern:
//   1-3. the three `switch` predicate tables (arrayop.d:282 / :297 / :319) — the shape a
//        transcription error hides in, and the three tables 14 call sites across the tree read;
//   4.   `isArrayOpImplicitCast` (:271) — D's `||`/`&&` PRECEDENCE (`&&` binds tighter), the one
//        place a mis-parenthesised port is silently wrong in one direction only;
//   5.   `checkNonAssignmentArrayOp` (:90) / `isNonAssignmentArrayOp` (:77) — the export the 26
//        walls across the tree stand over (expressionsem.ts 18, statementsem.ts 7, typesem.ts 1).
//        The FALSE path is what those walls darkened, so it is pinned as a non-throwing `false`,
//        not just as a value;
//   6.   `isArrayOpValid` (:39) — the recursive descent, including the `EXP.construct` leg whose
//        `be.e1.op == EXP.slice` guard differs from the plain binary leg;
//   7.   `isArrayOpOperand` (:341) — the near-twin of :39 that tests `tb.ty == Tarray` ONLY
//        (a static array is NOT an operand here, unlike in :39);
//   8.   `buildArrayOp`'s RPN encoding (arrayop.d:190) — operand order, the "u" prefix on the unary
//        arm, and the scalar HOIST arm; the one place this file calls hdrgen.ts's `EXPtoString`
//        (hdrgen.d:4602), which landed mid-wave and is why no wall stands here.
//
// NOT PINNED, honestly (10 §1.6b "never fabricate pins for paths the harness cannot reach"):
//   - `arrayOp` / `arrayOpBinExp` end-to-end, and the `arrayOpTemplate` cache
//     (arrayop.d:136): they need `object._arrayOp` resolved out of a real druntime `object.d`
//     through `expressionSemantic` + `resolveFuncCall`. The corpus (10 §5) is their oracle.
//   - the ERROR-emitting paths of `checkNonAssignmentArrayOp` (:97), `arrayOpInvalidError` (:375)
//     and `checkPossibleAddCatError_*` (:388): not pinned yet; `Expression.toChars()` is live, so they
//     are pinnable against ldc2's messages.

import { beforeEach, describe, expect, test } from "vitest";
import "./parse.js"; // module-graph ROOT — first import of any core-SCC test file (10 §1.5)
import { Loc } from "./location.js";
import { initTokens } from "./tokens.js";
import { Id } from "./id.js";
import { global } from "./globals.js";
import { ErrorSinkNull } from "./errorsink.js";
import { Type_init } from "./typesem.js";
import { EXP } from "./tokens.js";
import { Expression, AddExp, AssignExp, ConstructExp, NegExp, SliceExp, StringExp } from "./expression.js";
import { Type, TypeDArray, TypeSArray } from "./mtype.js";
import { Scope } from "./dscope.js";
import { Array as DArray } from "./root/array.js";
import { dsToJs } from "../dstring.js";
import type { RootObject } from "./rootobject.js";
import {
    buildArrayOp,
    checkNonAssignmentArrayOp,
    isArrayOpImplicitCast,
    isArrayOpOperand,
    isArrayOpValid,
    isBinArrayOp,
    isBinAssignArrayOp,
    isNonAssignmentArrayOp,
    isUnaArrayOp,
    _resetArrayOpTemplate,
} from "./arrayop.js";

beforeEach(() => {
    initTokens(); // also runs Identifier.initTable
    Id.initialize();
    Loc._init();
    Type_init(); // dmd/typesem.d:1224 — the basic types these pins build `int[]` / `double[]` over
    // `arrayOpTemplate` (arrayop.d:136 `__gshared`) caches a TemplateDeclaration interned against
    // the type/identifier tables just replaced — 01 §5.5 rule 3: reset it alongside them.
    _resetArrayOpTemplate();
    global.errorSink = new ErrorSinkNull();
    global.errors = 0;
});

/** A slice expression typed `t` — the canonical `EXP.slice` leaf every predicate here accepts. */
function slice(t: Type): SliceExp {
    const e = new SliceExp(Loc.initial, null, null, null);
    e.type = t;
    return e;
}

/** An expression of type `t` that is NOT a slice and NOT an array op — the "opaque leaf" case. */
function leaf(t: Type): Expression {
    const e = new Expression(Loc.initial, EXP.variable);
    e.type = t;
    return e;
}

describe("arrayop.ts", () => {
    test("SMOKE: the module loads and its predicates are callable (arrayop.d:14)", () => {
        // The 10 §1.5 canonical assertion: the graph was entered through the `./parse.js` root and
        // the core SCC evaluated, so `Expression` is a constructor and not `undefined`.
        // HONEST LIMIT (01 §4.8): this does NOT police arrayop.ts's OWN import order. `./parse.js`
        // is imported first here and finishes evaluating the whole SCC before arrayop.js is
        // reached, so a reordering inside arrayop.ts is masked and this test stays green through
        // it. What guards that order is the ordering comment on arrayop.ts's import block, plus
        // whichever production module the integrator wires up first.
        expect(typeof Expression).toBe("function");
        expect(isUnaArrayOp(EXP.negate)).toBe(true);
    });

    test("PIN 1: isUnaArrayOp — the two-case table (arrayop.d:282)", () => {
        expect(isUnaArrayOp(EXP.negate)).toBe(true); // arrayop.d:286
        expect(isUnaArrayOp(EXP.tilde)).toBe(true); // arrayop.d:287
        // `default: return false` (arrayop.d:289) — including the near-misses.
        expect(isUnaArrayOp(EXP.uadd)).toBe(false);
        expect(isUnaArrayOp(EXP.not)).toBe(false);
        expect(isUnaArrayOp(EXP.add)).toBe(false);
        expect(isUnaArrayOp(EXP.slice)).toBe(false);
    });

    test("PIN 2: isBinArrayOp — the nine-case table (arrayop.d:297)", () => {
        const yes = [EXP.add, EXP.min, EXP.mul, EXP.div, EXP.mod, EXP.xor, EXP.and, EXP.or, EXP.pow];
        for (const op of yes)
            expect(isBinArrayOp(op)).toBe(true);
        expect(yes.length).toBe(9); // arrayop.d:301-309, no more and no fewer
        // `default: return false` (arrayop.d:311). `~` is NOT an array op (concatenation is not
        // vectorised), and neither is any op= form — that is `isBinAssignArrayOp`'s table.
        expect(isBinArrayOp(EXP.concatenate)).toBe(false);
        expect(isBinArrayOp(EXP.addAssign)).toBe(false);
        expect(isBinArrayOp(EXP.negate)).toBe(false);
        expect(isBinArrayOp(EXP.assign)).toBe(false);
    });

    test("PIN 3: isBinAssignArrayOp — the nine-case table (arrayop.d:319)", () => {
        const yes = [EXP.addAssign, EXP.minAssign, EXP.mulAssign, EXP.divAssign, EXP.modAssign,
            EXP.xorAssign, EXP.andAssign, EXP.orAssign, EXP.powAssign];
        for (const op of yes)
            expect(isBinAssignArrayOp(op)).toBe(true);
        expect(yes.length).toBe(9); // arrayop.d:323-331
        // `default: return false` (arrayop.d:333). `~=` is NOT in the table.
        expect(isBinAssignArrayOp(EXP.concatenateAssign)).toBe(false);
        expect(isBinAssignArrayOp(EXP.assign)).toBe(false);
        expect(isBinAssignArrayOp(EXP.add)).toBe(false);
    });

    test("PIN 4: isArrayOpImplicitCast — the || / && precedence (arrayop.d:271)", () => {
        const ints = new TypeDArray(Type.tint32);
        const doubles = new TypeDArray(Type.tfloat64);
        const chars = new TypeDArray(Type.tchar);

        expect(isArrayOpImplicitCast(ints, ints)).toBe(true); // `tyf == tyt`
        expect(isArrayOpImplicitCast(doubles, doubles)).toBe(true);
        // `tyf == Tint32 && tyt == Tfloat64` — the ONE asymmetric widening _arrayOp performs.
        expect(isArrayOpImplicitCast(ints, doubles)).toBe(true);
        // ... and NOT the reverse: `&&` binds tighter than `||`, so a mis-parenthesised port that
        // reads `(tyf == tyt || tyf == Tint32) && tyt == Tfloat64` answers false here AND above.
        expect(isArrayOpImplicitCast(doubles, ints)).toBe(false);
        expect(isArrayOpImplicitCast(ints, chars)).toBe(false);
    });

    test("PIN 5: checkNonAssignmentArrayOp / isNonAssignmentArrayOp (arrayop.d:77, :90)", () => {
        const tarr = new TypeDArray(Type.tint32);

        // A NON-array-typed expression: `tb.isStaticOrDynamicArray()` is false -> false, and
        // `checkNonAssignmentArrayOp` returns false WITHOUT reaching `error()`. This is the exact
        // path the 26 walls across the tree darkened, so it is pinned as "returns, never throws".
        const scalar = new NegExp(Loc.initial, leaf(Type.tint32));
        scalar.type = Type.tint32;
        expect(isNonAssignmentArrayOp(scalar)).toBe(false);
        expect(() => checkNonAssignmentArrayOp(scalar)).not.toThrow();
        expect(checkNonAssignmentArrayOp(scalar)).toBe(false);
        expect(checkNonAssignmentArrayOp(scalar, true)).toBe(false); // the `suggestion` default arg
        expect(global.errors).toBe(0);

        // An array-typed UNARY op IS a non-assignment array op (arrayop.d:85).
        const negArr = new NegExp(Loc.initial, slice(tarr));
        negArr.type = tarr;
        expect(isNonAssignmentArrayOp(negArr)).toBe(true);

        // An array-typed BINARY op likewise; an array-typed op= does NOT (only :85's two tables).
        const addArr = new AddExp(Loc.initial, slice(tarr), slice(tarr));
        addArr.type = tarr;
        expect(isNonAssignmentArrayOp(addArr)).toBe(true);
        const asgArr = new AssignExp(Loc.initial, slice(tarr), slice(tarr));
        asgArr.type = tarr;
        expect(isNonAssignmentArrayOp(asgArr)).toBe(false);

        // arrayop.d:79 — a slice RECURSES into e1 rather than answering `true` outright.
        const sliceOfNeg = new SliceExp(Loc.initial, negArr, null, null);
        sliceOfNeg.type = tarr;
        expect(isNonAssignmentArrayOp(sliceOfNeg)).toBe(true);
        const sliceOfLeaf = new SliceExp(Loc.initial, leaf(tarr), null, null);
        sliceOfLeaf.type = tarr;
        expect(isNonAssignmentArrayOp(sliceOfLeaf)).toBe(false);
    });

    test("PIN 6: isArrayOpValid — the recursive descent (arrayop.d:39)", () => {
        const tarr = new TypeDArray(Type.tint32);

        expect(isArrayOpValid(slice(tarr))).toBe(true); // arrayop.d:42 — a slice is always valid
        expect(isArrayOpValid(leaf(Type.tint32))).toBe(true); // arrayop.d:74 — non-array falls through
        expect(isArrayOpValid(leaf(tarr))).toBe(false); // arrayop.d:72 — array-typed, no [] and no op

        // Unary leg (arrayop.d:54): descends into e1.
        const negOfSlice = new NegExp(Loc.initial, slice(tarr));
        negOfSlice.type = tarr;
        expect(isArrayOpValid(negOfSlice)).toBe(true);
        const negOfLeaf = new NegExp(Loc.initial, leaf(tarr));
        negOfLeaf.type = tarr;
        expect(isArrayOpValid(negOfLeaf)).toBe(false);

        // Binary leg (arrayop.d:58): BOTH operands must be valid.
        const addOk = new AddExp(Loc.initial, slice(tarr), slice(tarr));
        addOk.type = tarr;
        expect(isArrayOpValid(addOk)).toBe(true);
        const addBad = new AddExp(Loc.initial, slice(tarr), leaf(tarr));
        addBad.type = tarr;
        expect(isArrayOpValid(addBad)).toBe(false);

        // `construct` leg (arrayop.d:63) — NOT the binary leg: e1 must literally BE a slice, and
        // only e2 is descended into. A port that folded this into the :58 leg answers true below.
        const ctorBad = new ConstructExp(Loc.initial, leaf(tarr), slice(tarr));
        ctorBad.type = tarr;
        expect(isArrayOpValid(ctorBad)).toBe(false);
        const ctorOk = new ConstructExp(Loc.initial, slice(tarr), slice(tarr));
        ctorOk.type = tarr;
        expect(isArrayOpValid(ctorOk)).toBe(true);
    });

    test("PIN 7: isArrayOpOperand — Tarray only, unlike :39 (arrayop.d:341)", () => {
        const tarr = new TypeDArray(Type.tint32);
        const tsarr = new TypeSArray(Type.tint32, null);

        expect(isArrayOpOperand(slice(tarr))).toBe(true); // arrayop.d:344
        expect(isArrayOpOperand(leaf(Type.tint32))).toBe(false); // arrayop.d:361 — non-array
        expect(isArrayOpOperand(leaf(tarr))).toBe(false); // array-typed leaf: no op in the tables

        const addArr = new AddExp(Loc.initial, slice(tarr), slice(tarr));
        addArr.type = tarr;
        expect(isArrayOpOperand(addArr)).toBe(true); // arrayop.d:357
        const asgArr = new AssignExp(Loc.initial, slice(tarr), slice(tarr));
        asgArr.type = tarr;
        expect(isArrayOpOperand(asgArr)).toBe(true); // arrayop.d:359 — `e.op == EXP.assign`

        // THE difference from `isArrayOpValid`: this one tests `tb.ty == Tarray` (arrayop.d:354),
        // not `isStaticOrDynamicArray()`, so a STATIC array operand answers false.
        const addSArr = new AddExp(Loc.initial, slice(tsarr), slice(tsarr));
        addSArr.type = tsarr;
        expect(isArrayOpOperand(addSArr)).toBe(false);
        expect(isArrayOpValid(addSArr)).toBe(true); // ... while :52 accepts it
    });

    test("PIN 8: buildArrayOp — the RPN encoding and the scalar hoist (arrayop.d:190)", () => {
        const tarr = new TypeDArray(Type.tint32);
        const sc = new Scope();

        // Binary arm (arrayop.d:241 else): RPN — e1, then e2, then the operator STRING pushed onto
        // tiargs. This is the arm `arrayOp(BinExp, Scope*)` always reaches (arrayop.d:122 asserts
        // the node's basetype IS an array, which is exactly this `else`). `EXPtoString` is the live
        // hdrgen.ts export (hdrgen.d:4602) — this pin is what proves the fill, not a wall.
        const a = slice(tarr);
        const b = slice(tarr);
        const add = new AddExp(Loc.initial, a, b);
        add.type = tarr;
        const tiargs = new DArray<RootObject | null>();
        const args = buildArrayOp(sc, add, tiargs);

        expect(args.length).toBe(2); // the two SLICE operands, in D's own order
        expect(args.opIndex(0)).toBe(a);
        expect(args.opIndex(1)).toBe(b);
        expect(tiargs.length).toBe(3); // type(e1), type(e2), then the op string — RPN
        expect(tiargs.opIndex(0)).toBe(tarr);
        expect(tiargs.opIndex(1)).toBe(tarr);
        const opArg = tiargs.opIndex(2);
        expect(opArg instanceof StringExp).toBe(true);
        const opStr = opArg instanceof StringExp ? opArg : null; // narrowed by the pin above
        expect(dsToJs(Uint8Array.from(opStr!.string!))).toBe("+");

        // Unary arm (arrayop.d:223 else): the operator string is PREFIXED with "u" (arrayop.d:234).
        const inner = slice(tarr);
        const neg = new NegExp(Loc.initial, inner);
        neg.type = tarr;
        const utiargs = new DArray<RootObject | null>();
        const uargs = buildArrayOp(sc, neg, utiargs);
        expect(uargs.length).toBe(1);
        expect(uargs.opIndex(0)).toBe(inner);
        expect(utiargs.length).toBe(2);
        const uopArg = utiargs.opIndex(1);
        expect(uopArg instanceof StringExp).toBe(true);
        const uopStr = uopArg instanceof StringExp ? uopArg : null; // narrowed by the pin above
        expect(dsToJs(Uint8Array.from(uopStr!.string!))).toBe("u-");

        // The SCALAR-hoist arms (arrayop.d:226 / :244): a non-array-typed sub-expression is pushed
        // whole as (type, value) instead of being decomposed.
        const scalarAdd = new AddExp(Loc.initial, leaf(Type.tint32), leaf(Type.tint32));
        scalarAdd.type = Type.tint32;
        const stiargs = new DArray<RootObject | null>();
        const sargs = buildArrayOp(sc, scalarAdd, stiargs);
        expect(sargs.length).toBe(1);
        expect(sargs.opIndex(0)).toBe(scalarAdd);
        expect(stiargs.length).toBe(1);
        expect(stiargs.opIndex(0)).toBe(Type.tint32);
    });
});
