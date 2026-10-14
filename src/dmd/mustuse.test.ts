// Goal tests for src/dmd/mustuse.ts.
//
// dmd/mustuse.d has ZERO in-source `unittest{}` blocks (manifest §8 = 0, confirmed by
// `grep -c '^unittest' dmd/mustuse.d`), so this file takes the 10 §1.6b shape: one export-surface
// smoke test plus behavior pins — one `test()` per CONCERN — for the constructs this translation
// actually resolved by judgment. No new harness machinery: everything is built with the canonical
// 10 §1.5 init snippet plus `Type_init()`, exactly as clone.test.ts and dcast.rung1.test.ts do.
//
// Pinned concerns:
//
//   * `isAssignmentOpId` (mustuse.d:109) — a hand-transcribed SEVEN-identifier disjunction over
//     `Id.*`. 10 §1.7 names exactly this shape as a file's highest-value pin: one dropped or
//     mistyped member is a silent miscompile (a `@mustuse` value discarded through that operator
//     would start erroring, or stop erroring). Pinned member by member, plus two negatives.
//   * `isAssignment` (mustuse.d:90) — the four `isXxx()` RTTI probes of :92, and the CallExp leg
//     (:94-102) with its two independent null gates (`ce.f`, `fd.ident`).
//   * `isIncrementOrDecrement` (mustuse.d:125) — three independent legs: the four `EXP` tags
//     (:132-135), the comma leg's THREE-level nesting plus its self-recursion (:167-182), and the
//     `else if` chain itself.
//   * `isMustUseAttribute` (mustuse.d:210) — the forward into `isEnumAttribute`, on its non-TypeExp
//     early-out (the only leg reachable without building a `core.attribute` module).
//   * `hasMustUseAttribute` (mustuse.d:189) and `checkMustUseReserved` (mustuse.d:58) — the
//     no-UDA path. This is the load-bearing one for the sweep: it proves both functions return
//     normally for a symbol with no `userAttribDecl`, i.e. that the walls in funcsem.ts /
//     dsymbolsem.ts / enumsem.ts sit on a path this port can now take without throwing.
//   * `checkMustUse` (mustuse.d:30) — the non-aggregate path (`toDsymbol` answers null), which is
//     what the walls in statementsem.ts:301 and expressionsem.ts:13086 sit on for scalar values.
//
// NOT PINNED, and why (10 §1.6b forbids fabricating pins the harness cannot reach honestly):
//
//   * The two byte-exact diagnostics (mustuse.d:42, :71, :77) and the `sym.errors = true` writes.
//     Reaching them needs a symbol carrying a `UserAttributeDeclaration` whose `atts` hold a
//     `TypeExp` over a `TypeEnum` whose `sym` lives in a module `isCoreModule("attribute")` accepts
//     (attrib.ts `isCoreUda`). That is a `core.attribute` module built from nothing — new harness
//     machinery, which 10 §1.6b rules out. The corpus (10 §5) is the oracle for these three
//     strings; `tests/dmd/fail_compilation/mustuse*.d` is the slice.
//   * The `else if` CHAIN fidelity at mustuse.d:137/:167 (a flat hoist of both declarations would
//     call `e.isCommaExp()` for a CallExp too). `EXP` tags are mutually exclusive, so no input can
//     distinguish the two shapes at runtime — the fidelity is a review property, not a testable
//     one. Stated here rather than pinned with something vacuous (10 §1.8 rule 8).
//   * `isIncrementOrDecrement`'s overloaded-preincrement leg (mustuse.d:143-162). It ends in
//     `StringExp.peekString()`, whose body is expression.ts's open §2 escalation, so the deepest
//     honest assertion is that the escalation is reached — and that pin would assert ANOTHER
//     file's site-anonymous message (11 §2: "not translated — see escalation report" is thrown
//     identically by dozens of files), which 10 §1.8 rule 9 would make unreadable the moment the
//     StringExp representation is decided. Left unpinned and reported instead.

import { beforeEach, describe, expect, test } from "vitest";
import "./parse.js"; // module-graph ROOT for a core-SCC test file (10 §1.5)
import {
    checkMustUse, checkMustUseReserved, hasMustUseAttribute, isAssignment, isAssignmentOpId,
    isIncrementOrDecrement, isMustUseAttribute,
} from "./mustuse.js";
import {
    AddAssignExp, AssignExp, BlitExp, CallExp, CommaExp, ConstructExp, Expression, IntegerExp,
    PostExp, PreExp,
} from "./expression.js";
import { FuncDeclaration } from "./func.js";
import { StructDeclaration } from "./dstruct.js";
import { Scope } from "./dscope.js";
import { ParameterList, Type, TypeFunction } from "./mtype.js";
import { LINK, STC } from "./astenums.js";
import { EXP } from "./tokens.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { initTokens } from "./tokens.js";
import { global } from "./globals.js";
import { ErrorSinkNull } from "./errorsink.js";
import { ds } from "../dstring.js";
import { Type_init } from "./typesem.js";
import type { Dsymbol } from "./dsymbol.js";

beforeEach(() => {
    // The 10 §1.5 canonical order, copied verbatim (never re-derived): Loc, then initTokens, then
    // Id, then the basic types. `global._init()` is replaced by the three explicit resets below,
    // because these pins need an ErrorSinkNull rather than the ErrorSinkCompiler it installs.
    Loc._init();
    initTokens(); // also runs Identifier.initTable
    Id.initialize();
    Type_init();
    global.errorSink = new ErrorSinkNull();
    global.errors = 0;
    global.gag = 0;
});

function id(name: string): Identifier {
    return Identifier.idPool(ds(name));
}

/// A bare `Scope`. Every path these pins take never dereferences it: `toDsymbol`'s basic-type arm
/// ignores it (typesem.ts:8218) and `foreachUda` returns before its only use when there is no
/// `userAttribDecl` (attribsem.ts:173).
function sc(): Scope {
    return new Scope();
}

/// An `int`-typed literal — the scalar `checkMustUse` sees for every discarded arithmetic value.
function intLit(v = 5): IntegerExp {
    return new IntegerExp(Loc.initial, BigInt(v), Type.tint32!);
}

/// A `FuncDeclaration` carrying only a `TypeFunction`, like clone.test.ts's `makeFunc`. Nothing
/// these pins reach reads more than `ident` / `parent` / `errors` / `loc`.
function makeFunc(name = "f"): FuncDeclaration {
    const tf = new TypeFunction(new ParameterList(null), Type.tvoid!, LINK.d);
    return new FuncDeclaration(Loc.initial, Loc.initial, id(name), STC.none, tf);
}

/// A `CallExp` whose resolved callee carries `ident` — the shape mustuse.d:94-101 and :141-143 test.
function callOf(ident: Identifier | null): CallExp {
    const ce = new CallExp(Loc.initial, intLit());
    if (ident !== null) {
        const fd = makeFunc();
        fd.ident = ident;
        ce.f = fd;
    }
    return ce;
}

describe("export surface", () => {
    test("smoke: importing dmd.mustuse executes its top level and exports the D surface", () => {
        // The seven top-level declarations of mustuse.d, all reachable (the five D-private ones are
        // exported per 10 §1.7). `Expression` is asserted too: the 10 §1.5 note makes the
        // parse.js-first entry a tree-wide property, and this is the assertion that names the
        // regression instead of letting it surface as a collect-time crash elsewhere.
        expect(typeof Expression).toBe("function");
        expect(typeof checkMustUse).toBe("function");
        expect(typeof checkMustUseReserved).toBe("function");
        expect(typeof isAssignment).toBe("function");
        expect(typeof isAssignmentOpId).toBe("function");
        expect(typeof isIncrementOrDecrement).toBe("function");
        expect(typeof hasMustUseAttribute).toBe("function");
        expect(typeof isMustUseAttribute).toBe("function");
    });
});

describe("isAssignmentOpId (dmd/mustuse.d:109)", () => {
    test("all SEVEN assignment-operator identifiers answer true (mustuse.d:113-119)", () => {
        // Member by member, in D's own order. `===` is reference identity on the interned
        // `Identifier` (neither RootObject nor Identifier overrides opEquals), which is why every
        // operand must come from `Id.*` / `Identifier.idPool` and not from a fresh construction.
        expect(isAssignmentOpId(Id.opAssign!)).toBe(true);          // mustuse.d:113
        expect(isAssignmentOpId(Id.opIndexAssign!)).toBe(true);     // mustuse.d:114
        expect(isAssignmentOpId(Id.opSlice!)).toBe(true);           // mustuse.d:115
        expect(isAssignmentOpId(Id.opSliceAssign!)).toBe(true);     // mustuse.d:116
        expect(isAssignmentOpId(Id.opOpAssign!)).toBe(true);        // mustuse.d:117
        expect(isAssignmentOpId(Id.opIndexOpAssign!)).toBe(true);   // mustuse.d:118
        expect(isAssignmentOpId(Id.opSliceOpAssign!)).toBe(true);   // mustuse.d:119
    });

    test("an operator NOT in the list answers false — including the near-misses", () => {
        // `opSlice` IS in D's list (a deliberate upstream over-approximation: a slice expression is
        // not an assignment), while `opIndex`, `opUnary` and `opEquals` are not. A transcription
        // that swapped one for the other passes the positive pin above and fails here.
        expect(isAssignmentOpId(Id.opUnary!)).toBe(false);
        expect(isAssignmentOpId(Id.opIndex!)).toBe(false);
        expect(isAssignmentOpId(id("opEquals"))).toBe(false);
    });

    test("interning is what makes the compare work — a same-spelled pool lookup IS the identity", () => {
        // Guards the reference-identity reading of D's `==` (mustuse.d:113). `idPool` returns the
        // ONE interned object, so a spelling round-trip must still match.
        expect(isAssignmentOpId(id("opAssign"))).toBe(true);
    });
});

describe("isAssignment (dmd/mustuse.d:90)", () => {
    test("the four RTTI probes of mustuse.d:92 each answer true", () => {
        // `AssignExp` (EXP.assign), `BinAssignExp` (here `AddAssignExp`), `ConstructExp` and
        // `BlitExp`. The last two are AssignExp SUBCLASSES with their own EXP tags, so a probe list
        // that dropped either would still pass an `isAssignExp`-only check.
        expect(isAssignment(new AssignExp(Loc.initial, intLit(), intLit(7)))).toBe(true);
        expect(isAssignment(new AddAssignExp(Loc.initial, intLit(), intLit(7)))).toBe(true);
        expect(isAssignment(new ConstructExp(Loc.initial, intLit(), intLit(7)))).toBe(true);
        expect(isAssignment(new BlitExp(Loc.initial, intLit(), intLit(7)))).toBe(true);
    });

    test("a CallExp answers true only through a resolved opAssign-family callee (mustuse.d:94-101)", () => {
        // The leg has THREE gates in series: `isCallExp()`, `ce.f` non-null, `fd.ident` non-null and
        // in the op-id list. Each negative below fails a different gate, so a collapsed guard shows.
        expect(isAssignment(callOf(Id.opAssign!))).toBe(true);
        expect(isAssignment(callOf(Id.opIndexOpAssign!))).toBe(true);
        expect(isAssignment(callOf(Id.opUnary!))).toBe(false);   // resolved, wrong operator
        expect(isAssignment(callOf(null))).toBe(false);          // `ce.f` still null (unresolved)
    });

    test("a plain value is not an assignment (mustuse.d:103)", () => {
        expect(isAssignment(intLit())).toBe(false);
        expect(isAssignment(new CommaExp(Loc.initial, intLit(), intLit(7)))).toBe(false);
    });
});

describe("isIncrementOrDecrement (dmd/mustuse.d:125)", () => {
    test("the four EXP tags of mustuse.d:132-135 each answer true", () => {
        // `PostExp` carries the post forms, `PreExp` the pre forms; both take the tag as their FIRST
        // constructor argument (expression.ts:3097/:3114), so a swapped pair is a real hazard.
        expect(isIncrementOrDecrement(new PostExp(EXP.plusPlus, Loc.initial, intLit()))).toBe(true);
        expect(isIncrementOrDecrement(new PostExp(EXP.minusMinus, Loc.initial, intLit()))).toBe(true);
        expect(isIncrementOrDecrement(new PreExp(EXP.prePlusPlus, Loc.initial, intLit()))).toBe(true);
        expect(isIncrementOrDecrement(new PreExp(EXP.preMinusMinus, Loc.initial, intLit()))).toBe(true);
    });

    test("the comma leg matches (tmp = a, ++a, tmp) and NOTHING shallower (mustuse.d:167-182)", () => {
        // D's shape is `((e1a, e1b), e2)`: the OUTER comma's `e1` must itself be a comma, and the
        // increment must sit in that inner comma's `e2` — the slot the overloaded-postincrement
        // lowering puts it in. The three negatives below each break one level of the nesting, which
        // is what a hoisted or flattened guard would silently accept.
        const inc = new PostExp(EXP.plusPlus, Loc.initial, intLit());
        const inner = new CommaExp(Loc.initial, intLit(), inc);
        expect(isIncrementOrDecrement(new CommaExp(Loc.initial, inner, intLit()))).toBe(true);

        // increment in the inner `e1` instead of `e2` — D looks only at `left.e2` (mustuse.d:175)
        const wrongSlot = new CommaExp(Loc.initial, inc, intLit());
        expect(isIncrementOrDecrement(new CommaExp(Loc.initial, wrongSlot, intLit()))).toBe(false);
        // outer `e1` is not a comma at all (mustuse.d:173 answers null)
        expect(isIncrementOrDecrement(new CommaExp(Loc.initial, inc, intLit()))).toBe(false);
        // a comma with no increment anywhere
        const flat = new CommaExp(Loc.initial, intLit(), intLit(7));
        expect(isIncrementOrDecrement(new CommaExp(Loc.initial, flat, intLit()))).toBe(false);
    });

    test("the comma leg RECURSES, so a doubly-nested lowering still matches (mustuse.d:177)", () => {
        // mustuse.d:177 calls `isIncrementOrDecrement(middle)`, not an inline tag test. Pinning the
        // recursion is what distinguishes the faithful port from a flattened rewrite.
        const inc = new PreExp(EXP.prePlusPlus, Loc.initial, intLit());
        const innermost = new CommaExp(Loc.initial, intLit(), inc);
        const middle = new CommaExp(Loc.initial, innermost, intLit());
        const inner = new CommaExp(Loc.initial, intLit(), middle);
        expect(isIncrementOrDecrement(new CommaExp(Loc.initial, inner, intLit()))).toBe(true);
    });

    test("an unresolved CallExp takes the call leg and falls through (mustuse.d:141)", () => {
        // `call.f` null: D never reaches the opUnary probe, and — because :137/:167 are an `else if`
        // chain — never tries the comma leg either. Returns false at :183.
        expect(isIncrementOrDecrement(callOf(null))).toBe(false);
        expect(isIncrementOrDecrement(callOf(Id.opAssign!))).toBe(false); // resolved, not opUnary
        expect(isIncrementOrDecrement(intLit())).toBe(false);
    });
});

describe("isMustUseAttribute (dmd/mustuse.d:210)", () => {
    test("a non-TypeExp is not the attribute — isEnumAttribute's first early-out (attrib.d:810-812)", () => {
        // The only leg of `isEnumAttribute` reachable without a `core.attribute` module: `e.isTypeExp()`
        // answers null for every value expression, so the forward returns false without dereferencing
        // `Id.udaMustUse` any further.
        expect(isMustUseAttribute(intLit())).toBe(false);
        expect(isMustUseAttribute(new AssignExp(Loc.initial, intLit(), intLit(7)))).toBe(false);
    });
});

describe("the no-UDA path — what the funcsem/dsymbolsem/enumsem walls sit on", () => {
    test("hasMustUseAttribute answers false for a symbol with no userAttribDecl (mustuse.d:193-204)", () => {
        // `foreachUda` reads `sym.userAttribDecl()` and returns 0 immediately when it is null
        // (attribsem.ts:172-174), BEFORE its own open escalation over `arrayExpressionSemantic`. So
        // this path returns normally today; the escalation bites only for a symbol that really
        // carries UDAs. The delegate never runs, `result` stays at its mustuse.d:193 initializer.
        const fd = makeFunc();
        expect(hasMustUseAttribute(fd, sc())).toBe(false);

        const sd = new StructDeclaration(Loc.initial, id("S"), false);
        // upcast cascade: AggregateDeclaration.deferred (aggregate.d:94, `Dsymbol`) shadows
        // Dsymbol.deferred (dsymbol.d:396, `bool`) — 02 §11.5; the runtime object IS a Dsymbol.
        expect(hasMustUseAttribute(sd as unknown as Dsymbol, sc())).toBe(false);
    });

    test("checkMustUseReserved is a clean no-op for a symbol with no UDAs (mustuse.d:66)", () => {
        // The UNCONDITIONAL path all three D call sites take (funcsem.d:537, dsymbolsem.d:5294,
        // enumsem.d:122) for the overwhelming majority of symbols. `foreachUdaNoSemantic` returns 0
        // at attrib.ts:1022-1023, so no diagnostic is emitted and `errors` is not set.
        const fd = makeFunc();
        expect(() => checkMustUseReserved(fd)).not.toThrow();
        expect(fd.errors).toBe(false);
        expect(global.errors).toBe(0);
    });
});

describe("checkMustUse (dmd/mustuse.d:30)", () => {
    test("a scalar value is never a @mustuse violation — toDsymbol answers null (mustuse.d:36)", () => {
        // The path statementsem.ts:301 and expressionsem.ts:13086 take for every discarded
        // non-aggregate expression. `toDsymbol` on a `TypeBasic` hits the base `visitType` arm
        // (typesem.ts:8218) and returns null, so D falls straight to mustuse.d:47 — the struct
        // branch, and with it `foreachUda`, is never entered.
        expect(checkMustUse(intLit(), sc())).toBe(false);
        expect(global.errors).toBe(0);
    });

    test("the mustuse.d:35 assert fires on an un-typed expression", () => {
        // `assert(e.type)`: D faults here rather than silently accepting a pre-semantic node, and
        // every D call site passes an expression that semantic has already typed. A `.type` left
        // null is a caller bug, and the port must keep it loud (10 §1.9 / 10 §2).
        const e = new CommaExp(Loc.initial, intLit(), intLit(7)); // `type` still null
        expect(() => checkMustUse(e, sc())).toThrow("Assertion failure");
    });
});
