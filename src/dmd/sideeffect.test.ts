// Co-located tests for src/dmd/sideeffect.ts.
//
// dmd/sideeffect.d carries ZERO in-source unittest blocks (verified: `grep -c '^\s*unittest\b'
// sideeffect.d` -> 0, and the manifest's §8 agrees), so this file is the THIN FLEET ARTIFACT of
// 10 §1.6b: one module-load smoke test plus roughly one behaviour pin per risky RESOLVED CONSTRUCT
// of the translation. No new harness machinery — the init snippet (10 §1.5) and the `intExp` /
// `makeFunc` helpers are the existing sema-test conventions (mirroring nogc.test.ts).
//
// The risky constructs these pins cover:
//   - the two NESTED `StoppableVisitor` subclasses (sideeffect.d:40, :78) and their `visitExpression`
//     rename (13 §1) — a rename that missed the base's slot name would make `walkPostorder` never
//     reach the body, so `isTrivialExp`/`hasSideEffect` would answer from the base's empty visit;
//   - the `EXP.call` early-out inside `IsTrivialExp.visitExpression` (sideeffect.d:54);
//   - the shallow `lambdaHasSideEffect` switch (sideeffect.d:162) on both a side-effecting and a
//     side-effect-free node;
//   - `discardValue`'s cast-to-void arm (sideeffect.d:285) and its ErrorExp arm (:296);
//   - `discardValue`'s equality arm (sideeffect.d:374-393) only as far as its FIRST statement past
//     the assert, the `error(…, toErrMsg(e))` at :383 — which is where the pin below stops, on
//     hdrgen's wall. The `foreach` over `[tmp.e1, tmp.e2]`, the supplemental, the `seenSideEffect`
//     translation and the `!seenSideEffect` return (:384-393) are therefore NOT executed by any
//     test here; see the unpinned list below. The same holds for the "no effect" pin, which dies
//     at :397 before its `return true`;
//   - `copyToTemp`'s leading `assert(name[0] == '_' && name[1] == '_')` (sideeffect.d:412) as a BYTE
//     compare on a DString, and its `stc | STC.temp | STC.ctfe` re-brand (:416);
//   - the Form-B overload split: both `callSideEffectLevel` and `callSideEffectLevelType` exist and
//     answer 0 on the `!tf.isNothrow` leg (sideeffect.d:116, :141).
//
// NOT PINNED, and honestly so:
//   - the `PURE.const_` arm of either `callSideEffectLevel` (sideeffect.d:126, :155) and the
//     delegate purity adjustment (:146-152): reaching them needs a nothrow strongly-pure function
//     type whose purity was INFERRED by sema, i.e. a sema product — the new harness machinery
//     10 §1.6b forbids. The corpus (§5) is the oracle there.
//   - `extractSideEffect` (sideeffect.d:435): every leg past the trivial-expression early return
//     calls `expressionSemantic` on a freshly built `DeclarationExp`, which needs a real `Scope`
//     with a live enclosing function; that is a sema run, not a pin.
//   - the struct-rvalue diagnostic (sideeffect.d:269-275): it needs a `CallExp` with
//     `fromOpAssignment` over a `DotVarExp` on a semantically analysed struct.
//   - in `discardValue`'s equality arm, the supplemental and the `seenSideEffect` path for a
//     side-effecting operand (sideeffect.d:384-393); the two diagnostic pins use side-effect-free
//     `int` operands only.
//   - four RESOLVED constructs that are reachable with hand-built nodes and need no sema, yet have
//     no pin — named here rather than left silent, since each is a translation decision the file's
//     own body argues for:
//       * sideeffect.d:350 `discardValue(ce.e1) | discardValue(ce.e2)`, sequenced into two locals
//         and then or-ed (sideeffect.ts:453-455) because `||` would drop the second diagnostic.
//         Untested: with `int` operands both calls reach `toErrMsg` and die on hdrgen's wall, so a
//         pin here would assert the wall, not the sequencing. It needs the corpus (10 §5).
//       * sideeffect.d:371 the tuple arm's `if (!hasSideEffect(e)) break;`. The `break` falls
//         through to the ":397 has no effect" diagnostic, so a pin would assert hdrgen's wall
//         rather than the arm.
//     (sideeffect.d:300's `STC.temp` early-out and :359's `isGenerated` comma early-out WERE in
//     this list and are now pinned below.)
//   - no pin drives a byte-exact diagnostic STRING: that text is the corpus's oracle (10 §5). The
//     pins below assert the RETURN value and that a diagnostic was counted, not its wording.

import { beforeEach, describe, expect, test } from "vitest";

import "./parse.js"; // module-graph ROOT — first import of any core-SCC test file (10 §1.5)

import {
    callSideEffectLevel,
    callSideEffectLevelType,
    copyToTemp,
    discardValue,
    extractSideEffect,
    hasSideEffect,
    isTrivialExp,
} from "./sideeffect.js";

import { AssertError } from "../assert.js";
import { ds } from "../dstring.js";
import { LINK, STC, VarArg } from "./astenums.js";
import { ExpInitializer } from "./init.js";
import { ErrorSinkNull } from "./errorsink.js";
import { CallExp, CastExp, CommaExp, EqualExp, ErrorExp, Expression, IntegerExp, VarExp } from "./expression.js";
import { FuncDeclaration } from "./func.js";
import { global } from "./globals.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { ParameterList, Type, TypeFunction } from "./mtype.js";
import { EXP, initTokens } from "./tokens.js";
import { Type_init } from "./typesem.js";

beforeEach(() => {
    Loc._init();
    initTokens();
    Id.initialize();
    global._init();
    Type_init();
    global.errorSink = new ErrorSinkNull();
    global.errors = 0;
    global.gaggedErrors = 0;
    global.gag = 0;
});

function intExp(v: number): Expression {
    return new IntegerExp(Loc.initial, BigInt(v), Type.tint32!);
}

/** `int <name>()` as a bare module-level FuncDeclaration (no semantic run) — nogc.test.ts:89. */
function makeFunc(name: string, isNothrow = false): FuncDeclaration {
    const tf = new TypeFunction(new ParameterList(null, VarArg.none), Type.tint32, LINK.d);
    tf.isNothrow = isNothrow;
    return new FuncDeclaration(Loc.initial, Loc.initial, Identifier.idPool(ds(name)), STC.none, tf);
}

describe("sideeffect.ts — module-load smoke (10 §1.6b)", () => {
    test("importing the module executes its top-level and exposes the whole D surface", () => {
        // The two `extends StoppableVisitor` classes are NESTED inside their functions here, so a
        // load-order regression in the visitor root surfaces on first CALL, not at import — which is
        // why the isTrivialExp/hasSideEffect pins below are also the load-order canaries.
        expect(typeof Expression).toBe("function"); // 10 §1.5 — names the graph-root regression
        expect(typeof isTrivialExp).toBe("function");
        expect(typeof hasSideEffect).toBe("function");
        expect(typeof callSideEffectLevel).toBe("function");
        expect(typeof callSideEffectLevelType).toBe("function");
        expect(typeof discardValue).toBe("function");
        expect(typeof copyToTemp).toBe("function");
        expect(typeof extractSideEffect).toBe("function");
    });
});

describe("isTrivialExp / hasSideEffect — the two nested StoppableVisitor subclasses", () => {
    test("an integer literal is trivial and has no side effect (sideeffect.d:60, :89)", () => {
        // Both walks reach `lambdaHasSideEffect`, whose switch has no arm for EXP.int64, so it
        // returns false (sideeffect.d:233): `stop` stays false -> walkPostorder returns false.
        expect(isTrivialExp(intExp(1))).toBe(true);
        expect(hasSideEffect(intExp(1))).toBe(false);
    });

    test("a CallExp is never trivial (sideeffect.d:54) and a non-function callee has side effects", () => {
        // Two DIFFERENT reasons, which is what makes this pin worth having — it proves the two
        // nested visitors are genuinely separate bodies and not one shared slot:
        //   - `IsTrivialExp` stops on EXP.call UNCONDITIONALLY, before consulting
        //     lambdaHasSideEffect (sideeffect.d:54);
        //   - `LambdaHasSideEffect` has no such arm, so it goes through lambdaHasSideEffect's
        //     EXP.call leg (sideeffect.d:196). `e1.type` here is `int`, not a function/delegate
        //     type, so D's `level` (a bool — see the DOMAIN note in sideeffect.ts) is false and the
        //     leg returns true at :216.
        const ce = new CallExp(Loc.initial, intExp(1), null);
        expect(isTrivialExp(ce)).toBe(false);
        expect(hasSideEffect(ce)).toBe(true);
    });

    test("assumeImpureCalls makes every call a side effect (sideeffect.d:198)", () => {
        const ce = new CallExp(Loc.initial, intExp(1), null);
        expect(hasSideEffect(ce, true)).toBe(true);
    });
});

describe("discardValue", () => {
    test("the no-effect complaint is one diagnostic and a true return (sideeffect.d:397)", () => {
        // sideeffect.d:397 — `error(e.loc, "`%s` has no effect", e.toErrMsg())`; ldc2 on `1;` prints
        // "Error: `1` has no effect". discardValue counts that one diagnostic and returns true.
        expect(discardValue(intExp(1))).toBe(true);
        expect(global.errors).toBe(1);
    });

    test("cast-to-void silences the complaint and returns false (sideeffect.d:285)", () => {
        const ce = new CastExp(Loc.initial, intExp(1), Type.tvoid);
        expect(discardValue(ce)).toBe(false);
        expect(global.errors).toBe(0);
    });

    test("an ErrorExp is assumed side-effect-free and returns true silently (sideeffect.d:296)", () => {
        expect(discardValue(new ErrorExp())).toBe(true);
        expect(global.errors).toBe(0);
    });

    test("a compiler-generated temporary is not complained about (sideeffect.d:300)", () => {
        // The `STC.temp` early-out of the `EXP.variable` arm (bug 5810). `copyToTemp` is the tree's
        // own producer of such a variable, so the pin needs no hand-set storage class.
        const vd = copyToTemp(STC.none, ds("__tmp"), intExp(1));
        expect(discardValue(new VarExp(Loc.initial, vd))).toBe(false);
        expect(global.errors).toBe(0);
    });

    test("a compiler-generated comma is not complained about (sideeffect.d:359)", () => {
        // `CommaExp`'s ctor defaults `generated` to true (expression.d:2873), which is exactly the
        // rewrite case D declines to diagnose; the arm returns before ever looking at e2.
        const ce = new CommaExp(Loc.initial, intExp(1), intExp(2));
        expect(ce.isGenerated).toBe(true);
        expect(discardValue(ce)).toBe(false);
        expect(global.errors).toBe(0);
    });

    test("the discarded-equality complaint is one diagnostic and a true return (sideeffect.d:383)", () => {
        // sideeffect.d:374-393 — the equality arm: `error(e.loc, …, e.toErrMsg())` (:383) prints
        // "the result of the equality expression `1 == 2` is discarded" (ldc2's text for `1 == 2;`);
        // neither `int` operand has a side effect, so no supplemental follows. The `foreach (expr;
        // [tmp.e1, tmp.e2])` loop is exercised with no side-effecting operand only.
        const eq = new EqualExp(EXP.equal, Loc.initial, intExp(1), intExp(2));
        expect(discardValue(eq)).toBe(true);
        expect(global.errors).toBe(1);
    });
});

describe("copyToTemp (sideeffect.d:410)", () => {
    test("the `__` precondition is a BYTE compare on the DString name (sideeffect.d:412)", () => {
        expect(() => copyToTemp(STC.none, ds("tmp"), intExp(1))).toThrow(AssertError);
        expect(() => copyToTemp(STC.none, ds("_tmp"), intExp(1))).toThrow(AssertError);
    });

    test("the temporary carries STC.temp|STC.ctfe and an ExpInitializer over e (sideeffect.d:413-416)", () => {
        const e = intExp(7);
        const vd = copyToTemp(STC.none, ds("__tmp"), e);
        expect(vd.type).toBe(e.type);
        expect(vd._init).toBeInstanceOf(ExpInitializer);
        expect((vd._init as ExpInitializer).exp).toBe(e);
        expect(vd.storage_class & STC.temp).toBe(STC.temp);
        expect(vd.storage_class & STC.ctfe).toBe(STC.ctfe);
    });
});

describe("callSideEffectLevel — the Form-B overload pair (04 §1 Form B)", () => {
    test("a throwing function has side effects: level 0 (sideeffect.d:116)", () => {
        expect(callSideEffectLevel(makeFunc("f"))).toBe(0);
    });

    test("a throwing function TYPE has side effects: level 0 (sideeffect.d:141)", () => {
        const tf = new TypeFunction(new ParameterList(null, VarArg.none), Type.tint32, LINK.d);
        tf.isNothrow = false;
        expect(callSideEffectLevelType(tf)).toBe(0);
    });
});
