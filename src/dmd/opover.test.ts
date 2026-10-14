// Goal tests for src/dmd/opover.ts.
//
// dmd/opover.d has ZERO in-source `unittest{}` blocks (`grep -c 'unittest' dmd/opover.d` = 0), so
// this file takes the 10 §1.6b shape: one module-load smoke test (importing opover.ts executes its
// top level, catching load-order / cycle regressions in the core SCC) plus behavior pins — one
// `test()` per CONCERN — for the constructs this translation actually resolved:
//
//   * the four pure `EXP` switches — `isCommutative` (opover.d:49), `hasOpBinary` (:74),
//     `stripAssignOp` (:103) and `reverseRelation` (:1602). Each is a hand-transcribed arm list
//     where a single dropped or mistyped `case` is a silent miscompile, so each gets its own pin
//     with EVERY listed arm plus the default;
//   * `search_function` (opover.d:1183) — the function D homes in THIS module (the rung-era tree
//     also carries a copy in clone.ts). Its null-receiver guard is the early-exit every clone
//     builder's POD path rests on;
//   * the live no-aggregate early-outs of `opOverloadCast` (opover.d:428) and `binAliasThis`
//     (:465-:515) — the two entry points that return `null` without touching a wall, i.e. the
//     paths a caller with plain scalar operands takes today;
//   * the `!ad || !ad.aliasthis` gate of checkAliasThisForLhs/Rhs (opover.d:138/:161): both
//     early-out arms must `return null` without touching anything downstream;
//   * one pinned wall (10 §1.8), and it is no longer in this file. opover.ts has ZERO walls left:
//     the fifteen `EXPtoString` walls went when hdrgen.ts landed (their pin is now the behaviour
//     pin PIN 9, 10 §1.8 rule 7), and the remaining twenty-five went in the 14 §8 end-of-wave
//     sweep once typesem/expressionsem/templatesem/funcsem landed. The pin that used to sit on
//     `isRecursiveAliasThis` (opover.d:144) therefore MOVED downstream (10 §1.8 rule 2) into
//     expressionsem's CmpExp semantic — see PIN 8 (c);
//   * the struct-equality guard of opover.d:778 — `needOpEquals` is a ported callee (clone.ts:441),
//     not a deferred one, so the most common `s1 == s2` path must not stop there.
//
// No new harness machinery (10 §1.6b): everything is built with the canonical init snippet
// (10 §1.5) plus `Type._init()`, exactly as clone.test.ts / dcast.rung1.test.ts do.

import { beforeEach, describe, expect, test } from "vitest";
import {
    binAliasThis, build_overload, checkAliasThisForLhs, checkAliasThisForRhs, hasOpBinary,
    inferApplyArgTypes, inferForeachAggregate, isCommutative, opOverloadArray, opOverloadAssign,
    opOverloadBinary, opOverloadBinaryAssign, opOverloadCast, opOverloadCmp, opOverloadEqual,
    opOverloadUnary, opToArg, reverseRelation, search_function, stripAssignOp,
    suggestBinaryOverloads, suggestOpOpAssign,
} from "./opover.js";
import { AliasThis } from "./aliasthis.js";
import { StructDeclaration } from "./dstruct.js";
import type { AggregateDeclaration } from "./aggregate.js";
import { Scope } from "./dscope.js";
import { CastExp, CmpExp, EqualExp, Expression, IntegerExp, StringExp } from "./expression.js";
import { Type } from "./mtype.js";
import { TY } from "./astenums.js";
import { EXP, initTokens } from "./tokens.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { global } from "./globals.js";
import { ErrorSinkNull } from "./errorsink.js";
import { cstr, ds, dsToJs } from "../dstring.js";
import { Type_init } from "./typesem.js";

beforeEach(() => {
    initTokens(); // also runs Identifier.initTable
    Id.initialize();
    Loc._init();
    Type_init();
    global.errorSink = new ErrorSinkNull();
    global.errors = 0;
});

function id(name: string): Identifier {
    return Identifier.idPool(ds(name));
}

/// An `int`-typed expression — the simplest operand whose `isAggregate` is null, which is what the
/// no-aggregate early-outs need.
function intExp(v = 0): Expression {
    return new IntegerExp(Loc.initial, BigInt(v), Type.tint32);
}

describe("opover.ts", () => {
    test("SMOKE: the module loads and its exported surface is callable", () => {
        // opover.ts takes VALUE imports on expression.ts / mtype.ts / dsymbolsem.ts / expressionsem.ts
        // / optimize.ts / typesem.ts — a load-order cycle in the core SCC would surface right here
        // (01 §4.1). Touching one pure export IS the smoke test.
        expect(isCommutative(EXP.add)).toBe(true);
        // Every declaration opover.d exports is present under its D name (04 §6: free functions
        // stay free — nothing here is a method on Expression/Type).
        for (const f of [
            binAliasThis, build_overload, checkAliasThisForLhs, checkAliasThisForRhs, hasOpBinary,
            inferApplyArgTypes, inferForeachAggregate, isCommutative, opOverloadArray,
            opOverloadAssign, opOverloadBinary, opOverloadBinaryAssign, opOverloadCast,
            opOverloadCmp, opOverloadEqual, opOverloadUnary, opToArg, reverseRelation,
            search_function, stripAssignOp, suggestBinaryOverloads, suggestOpOpAssign,
        ]) {
            expect(typeof f).toBe("function");
        }
    });

    test("PIN 1: isCommutative — the eleven listed arms and the default (opover.d:49)", () => {
        // The five arithmetic/bitwise arms (opover.d:53-57).
        expect(isCommutative(EXP.add)).toBe(true);
        expect(isCommutative(EXP.mul)).toBe(true);
        expect(isCommutative(EXP.and)).toBe(true);
        expect(isCommutative(EXP.or)).toBe(true);
        expect(isCommutative(EXP.xor)).toBe(true);
        // EqualExp (opover.d:59-60).
        expect(isCommutative(EXP.equal)).toBe(true);
        expect(isCommutative(EXP.notEqual)).toBe(true);
        // CmpExp (opover.d:62-65). NOTE these are listed as commutative even though reversing them
        // needs `reverseRelation` (PIN 4) — that is D's own choice, not a translation artifact.
        expect(isCommutative(EXP.lessThan)).toBe(true);
        expect(isCommutative(EXP.lessOrEqual)).toBe(true);
        expect(isCommutative(EXP.greaterThan)).toBe(true);
        expect(isCommutative(EXP.greaterOrEqual)).toBe(true);

        // The default arm (opover.d:67-70): everything else is false — in particular the
        // NON-commutative arithmetic, the shifts, concatenation and every op= form.
        for (const op of [
            EXP.min, EXP.div, EXP.mod, EXP.leftShift, EXP.rightShift, EXP.unsignedRightShift,
            EXP.concatenate, EXP.pow, EXP.in_, EXP.identity, EXP.notIdentity, EXP.addAssign,
            EXP.assign, EXP.reserved,
        ]) {
            expect(isCommutative(op)).toBe(false);
        }
    });

    test("PIN 2: hasOpBinary — the fourteen `true` arms and the default (opover.d:74)", () => {
        for (const op of [
            EXP.add, EXP.min, EXP.mul, EXP.div, EXP.mod, EXP.and, EXP.or, EXP.xor,
            EXP.leftShift, EXP.rightShift, EXP.unsignedRightShift, EXP.concatenate, EXP.pow,
            EXP.in_,
        ]) {
            expect(hasOpBinary(op)).toBe(true);
        }
        // The default arm (opover.d:92). The op= forms are deliberately NOT `opBinary`-able —
        // they route to `opOpAssign` (suggestOpOpAssign, opover.d:629) instead.
        for (const op of [
            EXP.addAssign, EXP.minAssign, EXP.concatenateAssign, EXP.powAssign, EXP.equal,
            EXP.notEqual, EXP.lessThan, EXP.identity, EXP.assign, EXP.reserved,
        ]) {
            expect(hasOpBinary(op)).toBe(false);
        }
    });

    test("PIN 3: stripAssignOp — all thirteen op= mappings and the passthrough (opover.d:103)", () => {
        expect(stripAssignOp(EXP.addAssign)).toBe(EXP.add);
        expect(stripAssignOp(EXP.minAssign)).toBe(EXP.min);
        expect(stripAssignOp(EXP.mulAssign)).toBe(EXP.mul);
        expect(stripAssignOp(EXP.divAssign)).toBe(EXP.div);
        expect(stripAssignOp(EXP.modAssign)).toBe(EXP.mod);
        expect(stripAssignOp(EXP.andAssign)).toBe(EXP.and);
        expect(stripAssignOp(EXP.orAssign)).toBe(EXP.or);
        expect(stripAssignOp(EXP.xorAssign)).toBe(EXP.xor);
        expect(stripAssignOp(EXP.leftShiftAssign)).toBe(EXP.leftShift);
        expect(stripAssignOp(EXP.rightShiftAssign)).toBe(EXP.rightShift);
        expect(stripAssignOp(EXP.unsignedRightShiftAssign)).toBe(EXP.unsignedRightShift);
        expect(stripAssignOp(EXP.concatenateAssign)).toBe(EXP.concatenate);
        expect(stripAssignOp(EXP.powAssign)).toBe(EXP.pow);

        // The default arm (opover.d:120): a non-assign operator comes back unchanged — that is
        // what makes `opToArg` usable for both `opBinary` and `opOpAssign`.
        expect(stripAssignOp(EXP.add)).toBe(EXP.add);
        expect(stripAssignOp(EXP.equal)).toBe(EXP.equal);
        expect(stripAssignOp(EXP.assign)).toBe(EXP.assign); // plain `=` is NOT an op= form
        expect(stripAssignOp(EXP.reserved)).toBe(EXP.reserved);
    });

    test("PIN 4: reverseRelation — the four relations, and it is NOT negation (opover.d:1602)", () => {
        expect(reverseRelation(EXP.greaterOrEqual)).toBe(EXP.lessOrEqual);
        expect(reverseRelation(EXP.greaterThan)).toBe(EXP.lessThan);
        expect(reverseRelation(EXP.lessOrEqual)).toBe(EXP.greaterOrEqual);
        expect(reverseRelation(EXP.lessThan)).toBe(EXP.greaterThan);
        // "Note this is not negation" (opover.d:1596): `<` reverses to `>`, never to `>=`.
        expect(reverseRelation(EXP.lessThan)).not.toBe(EXP.greaterOrEqual);
        // The default arm (opover.d:1610): everything else passes through untouched, which is why
        // `compare_overload` can call it on an `EqualExp`'s op too.
        expect(reverseRelation(EXP.equal)).toBe(EXP.equal);
        expect(reverseRelation(EXP.notEqual)).toBe(EXP.notEqual);
        expect(reverseRelation(EXP.add)).toBe(EXP.add);
    });

    test("PIN 5: search_function — the null-receiver guard (opover.d:1185)", () => {
        // `if (!ad) return null;` is the gate every clone builder's POD early-exit rests on, and
        // the reason `isAggregate(...) -> null` call sites need no test of their own.
        expect(search_function(null, Id.opAssign!)).toBe(null);
        expect(search_function(null, id("anything"))).toBe(null);
    });

    test("PIN 6: opOverloadCast returns null for a non-aggregate operand (opover.d:428)", () => {
        // `AggregateDeclaration ad = isAggregate(e.e1.type); if (!ad) return null;` — the live
        // path for every `cast(T)scalar`, reached before any wall in the function.
        const ce = new CastExp(Loc.initial, intExp(), Type.tint32);
        expect(opOverloadCast(ce, new Scope())).toBe(null);
        // The default of D's third parameter (`Type att = null`, opover.d:426) is preserved, so a
        // two-argument call is legal and behaves identically.
        expect(opOverloadCast(ce, new Scope(), null)).toBe(null);
    });

    test("PIN 7: binAliasThis returns null when neither operand is an aggregate (opover.d:465)", () => {
        // Both `isAggregate` calls give null, so both guarded blocks call
        // checkAliasThisForLhs/Rhs(null, ...) which return null at their own `if (!ad)` gate
        // (opover.d:138/:161), `rewrittenLhs` stays null, and the function returns null — all
        // without reaching a wall. This pins the double-negation of opover.d:468/:504.
        const e = new CmpExp(EXP.lessThan, Loc.initial, intExp(1), intExp(2));
        expect(binAliasThis(e, new Scope(), [null, null])).toBe(null);
    });

    test("PIN 8 (RE-PIN, 10 §1.8 rule 7): checkAliasThisForLhs/Rhs — the `!ad || !ad.aliasthis` "
        + "gate falls through, and the aggregate-WITH-`alias this` arm now runs END TO END and "
        + "returns the re-semantic'd COPY (opover.d:138/:144/:155)", () => {
        const e = new CmpExp(EXP.lessThan, Loc.initial, intExp(1), intExp(2));

        // (a) null aggregate -> null, no throw.
        expect(checkAliasThisForLhs(null, new Scope(), e, [null, null])).toBe(null);
        expect(checkAliasThisForRhs(null, new Scope(), e, [null, null])).toBe(null);

        // (b) an aggregate whose `aliasthis` slot is still null -> null, no throw: the gate of
        // opover.d:138/:161 short-circuits before anything downstream is touched.
        const sd = new StructDeclaration(Loc.initial, id("S"), false);
        // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool),
        // which reaches the parameter through `syntaxCopy()`'s return type — 02 §11.5.
        const ad = sd as unknown as AggregateDeclaration;
        expect(sd.aliasthis).toBe(null);
        expect(checkAliasThisForLhs(ad, new Scope(), e, [null, null])).toBe(null);
        expect(checkAliasThisForRhs(ad, new Scope(), e, [null, null])).toBe(null);

        // (c) CONVERTED to a BEHAVIOUR pin (10 §1.8 rule 7) — the site is now fully LIVE, so there
        // is no next wall to follow and rule 2 does not apply. History: this first pinned
        // `TODO-BODY: isRecursiveAliasThis (dmd/typesem.d:9214)`; typesem.ts landed and the pin
        // MOVED to the `Target.isVectorOpSupported` wall (dmd/target.d:816); target.ts has now
        // landed that callee too (dmd/target.d:816, IN_LLVM arms), and nothing further down this
        // path walls. Walking D with these operands (`1 < 2`, i.e. `e.e1.type` is `int`):
        //   opover.d:144 `isRecursiveAliasThis(aliasThisStop[0], int)` -> false (int is no
        //                aggregate, so `checkAliasThisRec` never fires and the slot stays null);
        //   opover.d:147 `BinExp be = cast(BinExp)e.copy();` -> the result is a COPY; `e` itself is
        //                never re-typed, which is what the last assertion below holds;
        //   opover.d:150 `resolveAliasThis(sc, e.e1, true, false)` -> `isAggregate(int)` is null,
        //                so dsymbolsem.d:1849's `for` loop body never runs and `e.e1` comes back
        //                UNCHANGED (non-null), i.e. the `if (!be.e1) return null` gate is passed;
        //   opover.d:155 `be.trySemanticAliasThis(sc, aliasThisStop)` -> expressionSemantic on the
        //                copy, which for two non-aggregate scalars falls through every earlier arm
        //                of expressionsem.d's CmpExp visit to
        //                `else if (!target.isVectorOpSupported(t1, exp.op, t2))`
        //                (dmd/expressionsem.d:14719). `int` is not a vector, so target.d:820-822
        //                returns `true` on its first statement, the `!` branch is not taken, the
        //                visit takes the `else` at :14724 and reaches `result = exp` (:14743).
        //                `exp.type` was already `Type.tbool` before the predicate ran (:14662); a
        //                `false` answer would have replaced the node with `ErrorExp.get()` instead.
        // The expected values are ldc2's, not the port's own expression (10 §1.8 rule 8):
        // `pragma(msg, typeof(1 < 2));` prints `bool` on ldc2-1.43.0 / arm64-apple-darwin.
        sd.aliasthis = new AliasThis(Loc.initial, id("payload"));
        const lhs = checkAliasThisForLhs(ad, new Scope(), e, [null, null]);
        const rhs = checkAliasThisForRhs(ad, new Scope(), e, [null, null]);
        for (const got of [lhs, rhs]) {
            expect(got).not.toBe(null);
            expect(got).not.toBe(e);              // opover.d:147 — a copy, never the original
            expect(got!.op).toBe(EXP.lessThan);   // still a CmpExp; no operator rewrite happened
            expect(got!.type!.ty).toBe(TY.Tbool); // ldc2: typeof(1 < 2) is bool
        }
        // `e` itself is untouched: D re-types the copy, so the caller's node keeps its pre-semantic
        // state (dmd/opover.d:147). This is the half a `toThrow` pin could never state.
        expect(e.type).toBe(null);
    });

    test("PIN 9 (RE-PIN, 10 §1.8 rule 7): opToArg builds the operator's template argument "
        + "(opover.d:129)", () => {
        // RE-PIN. This test used to pin `TODO-BODY: EXPtoString (dmd/hdrgen.d:4602)`. hdrgen.ts
        // landed with `EXPtoString` live, the wall at opover.d:129 was swept, and opToArg now runs
        // end to end — there is no further wall on the path, so this is rule 7 (convert the pin to
        // what the live body produces), not rule 2 (re-point it at the next wall).
        //
        // The expected values are D's, verified with `ldc2 -run` on a struct carrying
        // `opBinary(string op)` / `opOpAssign(string op)`: the template argument is `"+"` for both
        // `s + 1` and `s += 1` (opToArg strips the assign form), `"<<"` for `s <<= 1`; and
        // `pragma(msg, typeof("+"))` prints `string`, the type semantic gives the literal.
        const argOf = (op: EXP): StringExp => {
            const tiargs = opToArg(new Scope(), op);
            expect(tiargs.length).toBe(1); // D: `new Objects(e)` — exactly one template argument
            const arg = tiargs.opIndex(0);
            expect(arg).toBeInstanceOf(StringExp);
            return arg as StringExp;
        };
        const spelling = (se: StringExp): string => String.fromCharCode(...se.string!);

        const plus = argOf(EXP.add);
        expect(spelling(plus)).toBe("+");
        expect(plus.len).toBe(1);
        expect(plus.sz).toBe(1); // char, not wchar/dchar — D's `string` literal
        // `e.expressionSemantic(sc)` ran: the literal is typed (opover.d:130). `toChars()` hands
        // back a C string, so the NUL-terminated view is what D's `%s` would print (02 §11).
        expect(dsToJs(cstr(plus.type!.toChars()))).toBe("string");

        // The `op=` forms go through `stripAssignOp` first (PIN 3) — the argument is the stripped
        // operator, which is what makes `s += 1` reach `opOpAssign!"+"`.
        expect(spelling(argOf(EXP.addAssign))).toBe("+");
        expect(spelling(argOf(EXP.leftShiftAssign))).toBe("<<");
    });

    test("PIN 10: struct `==` struct no longer stops at a needOpEquals wall (opover.d:777-:784)", () => {
        // `needOpEquals` is D-homed in clone.d:417 and IS ported (clone.ts:441), so opover.d:778's
        // `!sc.previews.fieldwise && !needOpEquals(sd)` is an ordinary call, not a deferred callee.
        // The bitwise-identity rewrite it guards is the default path for a POD struct compare.
        //
        // The lowering itself cannot be reached from a unit test yet: opover.d:707 runs
        // `compare_overload(e, sc, Id.opEquals, …)` FIRST, and that goes through `search`, whose
        // own wall (dsymbolsem.d) fires before control reaches d:771. So this pins the negative
        // that the fix is about — whatever this path stops on, it is no longer `needOpEquals` —
        // rather than a message from another agent's file that would make the pin brittle.
        const sd = new StructDeclaration(Loc.initial, id("S"), false);
        const lhs = intExp(1); lhs.type = sd.type;   // paint both operands with S's TypeStruct
        const rhs = intExp(2); rhs.type = sd.type;
        const e = new EqualExp(EXP.equal, Loc.initial, lhs, rhs);
        const sc = new Scope();
        expect(sc.previews.fieldwise).toBe(false); // the default; d:778's short-circuit is open
        expect(() => opOverloadEqual(e, sc, [null, null])).not.toThrow(/needOpEquals/);
    });
});

