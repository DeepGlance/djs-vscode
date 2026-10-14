// Co-located tests for src/dmd/attribsem.ts (dmd/attribsem.d).
//
// `dmd/attribsem.d` contains ZERO in-source `unittest{}` blocks (verified: the manifest scan and a
// manual read of all 87 lines agree), so per 10-tests-diagnostics.md §1.6b this file is the thin
// test file: one module-load smoke test plus behavior pins — one `test()` per CONCERN, only
// where constructible with the EXISTING harness conventions (the §1.5 init snippet). No new harness
// machinery, and no fabricated pins for paths the harness cannot reach honestly.
//
// RE-PINNED (10 §1.8 rule 7). This file used to carry TWO ESCALATION PINS asserting that the two
// paths through `arrayExpressionSemantic` halted at attribsem.ts's escalation stub. The stub is gone:
// expressionsem.ts:2288 exports the callee (authorised by dmd/expressionsem.d:1923) and the sweep
// restored both faithful calls, so each escalation pin is CONVERTED — not deleted — into a behaviour
// pin on what the now-live body produces, on the SAME input, in the same harness tier. The pins that
// replace them are marked RE-PIN below and name the escalation they close.
//
// The harness gained the two lines the live path needs, both from the 10 §1.5 canonical snippet:
// `import "./parse.js"` (module-graph root — attribsem now reaches into the core SCC through
// expressionsem) and `Type_init()` (real `expressionSemantic` paints basic types).

import { beforeEach, describe, expect, test } from "vitest";
import "./parse.js"; // module-graph ROOT for a core-SCC test file (10 §1.5) — FIRST import
import { foreachUda, getAttributes } from "./attribsem.js";
import { UserAttributeDeclaration } from "./attrib.js";
import { Dsymbol } from "./dsymbol.js";
import { Scope } from "./dscope.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { initTokens } from "./tokens.js";
import { IntegerExp, NullExp, TupleExp, type Expression } from "./expression.js";
import { Type } from "./mtype.js";
import { Type_init } from "./typesem.js";
import { Array as DArray } from "./root/array.js";
import type { Expressions } from "./arraytypes.js";

beforeEach(() => {
    // The 10 §1.5 canonical order, copied verbatim (never re-derived).
    Loc._init();
    initTokens(); // also runs Identifier.initTable
    Id.initialize();
    Type_init(); // builds the basic-type table: the swept calls run REAL expressionSemantic
});

function id(name: string): Identifier {
    return Identifier.idPool(Uint8Array.from(Array.from(name, (c) => c.charCodeAt(0))));
}

function exprs(...es: Expression[]): Expressions {
    // Constructed AS the `Expressions` alias — element type `Expression | null` (08 §3).
    const a = new DArray<Expression | null>();
    for (const e of es) a.push(e);
    return a;
}

describe("module load (10 §1.6b smoke)", () => {
    test("attribsem.ts loads and exports the two D free functions", () => {
        // dmd/attribsem.d declares exactly two top-level symbols, both free functions; they stay
        // free functions here (04 §6 — never promoted to methods on their receiver).
        expect(typeof getAttributes).toBe("function");
        expect(typeof foreachUda).toBe("function");
    });
});

describe("getAttributes (attribsem.d:37)", () => {
    test("a declaration with no scope, no attached UDA and no atts yields an EMPTY, non-null container", () => {
        // D: `_scope` null -> no semantic pass; `a.userAttribDecl` null -> no outer tuple;
        // `a.atts` null -> no own tuple; the freshly allocated `Expressions*` is still returned.
        const uad = new UserAttributeDeclaration(null, null);
        const r = getAttributes(uad);
        expect(r).not.toBe(null);
        expect(r.length).toBe(0);
    });

    test("RE-PIN: a set `_scope` is CLEARED and the UDAs are analysed IN PLACE (attribsem.d:39-43)", () => {
        // RE-PIN of the escalation pin over `arrayExpressionSemantic` (closed by the (s1) sweep;
        // it used to assert this input halted at the stub). attribsem.d:39-43 — the branch D takes
        // when `_scope` is non-null: FIRST clear `_scope` (:41, so the pass runs at most once),
        // THEN `arrayExpressionSemantic(a.atts.peekSlice(), sc)` (:42), which now really runs.
        //
        // The expected values are D's, not the port's own expressions (10 §1.8 rule 8):
        // `expressionSemantic` of a `NullExp` is `e.type = Type.tnull; result = e`
        // (dmd/expressionsem.d:5820-5821), i.e. the SAME node, painted `typeof(null)`. So the pin
        // states: the element object is unchanged, it is now typed `tnull`, `_scope` is cleared,
        // and :47-48 still wraps `atts` in one shared TupleExp.
        //
        // NOT PINNED, and deliberately so: the `tdata()`-vs-copy distinction the sweep turns on
        // (a callee write-back `exps[i] = e2` must be visible in `a.atts`) needs an expression whose
        // `expressionSemantic` returns a DIFFERENT node, which this harness cannot build without a
        // populated symbol table. `NullExp` is analysed in place, so this pin would stay green over
        // a `peekSlice()` copy too.
        const n = new NullExp(Loc.initial);
        const atts = exprs(n);
        const uad = new UserAttributeDeclaration(atts, null);
        uad._scope = Scope.alloc();
        const r = getAttributes(uad);
        expect(uad._scope).toBe(null);
        expect(atts.opIndex(0)).toBe(n); // analysed in place, not replaced
        expect(atts.opIndex(0)!.type).toBe(Type.tnull);
        expect(r.length).toBe(1);
        expect(r.opIndex(0)!.isTupleExp()!.exps).toBe(atts);
    });

    // A UserAttributeDeclaration with its own UDAs and no enclosing userAttribDecl: D skips attribsem.d:45-46 and
    // pushes one TupleExp over `atts` at :47-48.
    test("own atts are wrapped in a single TupleExp, like D (attribsem.d:47-48)", () => {
        const atts = exprs(new NullExp(Loc.initial));
        const uad = new UserAttributeDeclaration(atts, null);
        const r = getAttributes(uad);
        expect(r.length).toBe(1);
        expect(r.opIndex(0)).toBeInstanceOf(TupleExp);
        expect(r.opIndex(0)!.isTupleExp()!.exps).toBe(atts); // SHARED, not copied (02 §8)
    });
});

describe("foreachUda (attribsem.d:64)", () => {
    test("returns 0 for a symbol with no userAttribDecl and never calls the delegate", () => {
        // attribsem.d:66-67 — the one path through this function that reaches neither
        // `arrayExpressionSemantic` (:70) nor the iteration (:72).
        const sym = Dsymbol.create(id("s"));
        const sc = Scope.alloc();
        let calls = 0;
        expect(foreachUda(sym, sc, () => { calls++; return 1; })).toBe(0);
        expect(calls).toBe(0);
    });

    test("returns 0 for a UserAttributeDeclaration symbol carrying its own atts", () => {
        // The second half of the attribsem.d:66-67 concern, and the twin of the `getAttributes` test
        // above: `sym` here IS a UserAttributeDeclaration, so `sym.userAttribDecl` reads the (null)
        // base slot and D returns 0 without touching :69-70.
        const uad = new UserAttributeDeclaration(exprs(new NullExp(Loc.initial)), null);
        const sc = Scope.alloc();
        let calls = 0;
        expect(foreachUda(uad, sc, () => { calls++; return 1; })).toBe(0);
        expect(calls).toBe(0);
    });

    test("RE-PIN: a symbol WITH an EMPTY userAttribDecl runs the whole body and yields 0", () => {
        // RE-PIN of the escalation pin over `arrayExpressionSemantic` (closed by the (s1) sweep),
        // same input as before: a symbol whose UDA carries no `atts`. attribsem.d:69-72 now runs
        // end to end — `getAttributes` returns the empty container it allocates at :44, the
        // semantic pass over it is a no-op, and `udas.each` over zero elements returns 0 (D's
        // int-form `each`, array.d:784-797) without ever reaching `dg`. The delegate returning 1
        // is what makes the 0 meaningful: it could only be 1 if `dg` had run.
        const sym = Dsymbol.create(id("s"));
        sym.userAttribDecl_set(new UserAttributeDeclaration(null, null));
        const sc = Scope.alloc();
        let calls = 0;
        expect(foreachUda(sym, sc, () => { calls++; return 1; })).toBe(0);
        expect(calls).toBe(0);
    });

    test("the iteration reaches `dg` and breaks on its non-zero result (attribsem.d:72-85)", () => {
        // The behaviour the escalation had darkened outright: with the (s1) sweep in, a symbol that
        // really carries UDAs traverses both `each` levels. `getAttributes` wraps the UDA's `atts`
        // in one TupleExp (:48); the outer `each` unwraps it (:73-76) and the inner one calls `dg`
        // per element (:78-84), returning the first non-zero result verbatim (D's break protocol,
        // NOT a boolean). It also exercises the (s2) sweep: both `each` calls are the bare int form.
        //
        // The element is an already-typed `IntegerExp` because the live `expressionSemantic` of the
        // enclosing TupleExp builds a TypeTuple over its elements and asserts each one has a type
        // (mtype.ts:1994 / dmd/mtype.d:1967) — an untyped element is a harness error, not a
        // port defect.
        const inner = exprs(IntegerExp.fromValue(7n));
        const sym = Dsymbol.create(id("s"));
        sym.userAttribDecl_set(new UserAttributeDeclaration(exprs(TupleExp.fromExps(Loc.initial, inner)), null));
        const sc = Scope.alloc();
        const seen: Expression[] = [];
        expect(foreachUda(sym, sc, (e) => { seen.push(e); return 42; })).toBe(42);
        expect(seen.length).toBe(1);
        expect(seen[0]).toBeInstanceOf(IntegerExp);
    });
});
