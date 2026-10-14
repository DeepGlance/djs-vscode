// Goal tests for src/dmd/staticcond.ts.
//
// dmd/staticcond.d has ZERO in-source `unittest{}` blocks (10 §1.6b shape: smoke + behaviour pins).
// The pins reproduce, at the `visualizeStaticCondition` level, the constraint texts ldc2 1.43.0 prints
// for this probe (scratchpad w15-smallports/sc1.d), where `enum A = true, B = false, C = false,
// D = true;` and each constraint's `negatives` are the primitives `evalStaticCondition` found false:
//
//     void f(T)(T t) if (A && (B || C) && !D) {}   // negatives: B, C
//     void g(T)(T t) if (A ? B : C) {}             // negatives: B
//     void h(T)(T t) if (!(A ? D : C)) {}          // negatives: none (A and D are true)
//
// Oracle text (non-verbose = `full == false`; `-v` = `full == true`), copied from ldc2's output between
// the backticks:
//   f short: "       B\n       C"                    f full: "    A\n      > B\n        or:\n      > C\n  - !D\n"
//   g short: "       B\n       !A"                   g full: "    A\n  > B\n    or:\n  > !A\n  - C\n"
//   h short: "       !A\n       !D"

import { beforeEach, describe, expect, test } from "vitest";
import { visualizeStaticCondition } from "./staticcond.js";
import { CondExp, Expression, IdentifierExp, LogicalExp, NotExp } from "./expression.js";
import { EXP, TOK, initTokens } from "./tokens.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { cstr, ds, dsToJs } from "../dstring.js";

beforeEach(() => {
    Loc._init();
    initTokens();
});

const id = (s: string): IdentifierExp => new IdentifierExp(Loc.initial, new Identifier(ds(s), TOK.identifier));

/// Builds the same constraint shape twice (D: `td.constraint` and its instantiated copy
/// `td.lastConstraint`, which share the loc) and returns the primitives of the instantiated copy by name.
function build(make: (p: (s: string) => IdentifierExp) => Expression) {
    const inst = new Map<string, IdentifierExp[]>();
    const original = make(id);
    const instantiated = make((s) => {
        const e = id(s);
        inst.set(s, [...(inst.get(s) ?? []), e]);
        return e;
    });
    return { original, instantiated, prim: (s: string) => inst.get(s)! };
}

function run(original: Expression, instantiated: Expression, negatives: Expression[], full: boolean) {
    const count = { value: 0 };
    const r = visualizeStaticCondition(original, instantiated, negatives, full, count);
    return { text: r === null ? null : dsToJs(cstr(r)), count: count.value };
}

const fShape = (p: (s: string) => IdentifierExp): Expression =>
    new LogicalExp(Loc.initial, EXP.andAnd,
        new LogicalExp(Loc.initial, EXP.andAnd, p("A"), new LogicalExp(Loc.initial, EXP.orOr, p("B"), p("C"))),
        new NotExp(Loc.initial, p("D")));
const gShape = (p: (s: string) => IdentifierExp): Expression => new CondExp(Loc.initial, p("A"), p("B"), p("C"));
const hShape = (p: (s: string) => IdentifierExp): Expression =>
    new NotExp(Loc.initial, new CondExp(Loc.initial, p("A"), p("D"), p("C")));

describe("staticcond.ts", () => {
    test("SMOKE: the module loads; null inputs and a different loc yield null, itemCount untouched", () => {
        const count = { value: 7 };
        expect(visualizeStaticCondition(null, id("A"), [], false, count)).toBe(null);
        expect(visualizeStaticCondition(id("A"), null, [], true, count)).toBe(null);
        const other = new IdentifierExp(Loc.singleFilename(ds("x.d")), new Identifier(ds("A"), TOK.identifier));
        expect(visualizeStaticCondition(id("A"), other, [], true, count)).toBe(null);
        expect(count.value).toBe(7);
    });

    test("PIN 1: `A && (B || C) && !D` — short list and full tree match ldc2", () => {
        const { original, instantiated, prim } = build(fShape);
        const negs = [prim("B")[0], prim("C")[0]];
        expect(run(original, instantiated, negs, false)).toEqual({ text: "       B\n       C", count: 2 });
        expect(run(original, instantiated, negs, true))
            .toEqual({ text: "    A\n      > B\n        or:\n      > C\n  - !D\n", count: 4 });
    });

    test("PIN 2: `A ? B : C` — the ternary is rewritten as (A && B || !A && C)", () => {
        const { original, instantiated, prim } = build(gShape);
        const negs = [prim("B")[0]];
        expect(run(original, instantiated, negs, false)).toEqual({ text: "       B\n       !A", count: 2 });
        expect(run(original, instantiated, negs, true))
            .toEqual({ text: "    A\n  > B\n    or:\n  > !A\n  - C\n", count: 4 });
    });

    test("PIN 3: `!(A ? D : C)` — the inverted ternary, short list", () => {
        const { original, instantiated } = build(hShape);
        expect(run(original, instantiated, [], false)).toEqual({ text: "       !A\n       !D", count: 2 });
    });
});
