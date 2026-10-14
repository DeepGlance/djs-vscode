// Tests for src/dmd/blockexit.ts.
//
// dmd/blockexit.d ships NO in-source `unittest{}` block (verified: zero `unittest` matches), so
// there is nothing to port 1:1 (10 §1). These are a module-load smoke test plus the few behavior
// pins constructible with the existing harness — the leaf `visitXxx` arms that need no semantic'd
// expression, plus the boundary guard and one dispatch-fidelity pin. No new harness machinery.
//
// Setup order per 01 §5.2 ORDER CONTRACT: Loc._init() BEFORE initTokens() (initTokens re-creates the
// identifier interning table; the reverse order orphans the Id.* singletons).

import { beforeEach, describe, expect, test } from "vitest";
import { BE, blockExit, checkThrow } from "./blockexit.js";
import { CT } from "./canthrow.js";
import { AssertError } from "../assert.js";
import {
    BreakStatement,
    CompoundDeclarationStatement,
    GotoStatement,
    ReturnStatement,
} from "./statement.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { initTokens } from "./tokens.js";

beforeEach(() => {
    Loc._init();
    initTokens(); // also runs Identifier.initTable
});

describe("module load + BE flag layout (blockexit.d:40)", () => {
    test("the module loads and exports both D top-level declarations", () => {
        expect(typeof blockExit).toBe("function");
        expect(typeof checkThrow).toBe("function");
    });

    test("the flag bits match the upstream layout", () => {
        expect(BE.none).toBe(0);
        expect(BE.fallthru).toBe(1);
        expect(BE.throw_).toBe(2);
        expect(BE.return_).toBe(4);
        expect(BE.goto_).toBe(8);
        expect(BE.halt).toBe(0x10);
        expect(BE.break_).toBe(0x20);
        expect(BE.continue_).toBe(0x40);
        expect(BE.errthrow).toBe(0x80);
        // `any = (fallthru | throw_ | return_ | goto_ | halt)` (blockexit.d:51)
        expect(BE.any).toBe(BE.fallthru | BE.throw_ | BE.return_ | BE.goto_ | BE.halt);
    });

    test("CT's values are still the BE bits they are declared FROM (canthrow.d:37-47)", () => {
        // D expresses the relation in the type system: `enum CT : BE { none = BE.none,
        // exception = BE.throw_, error = BE.errthrow }`. canthrow.ts must duplicate the numbers as
        // literals (reading `BE.*` at its module-init time would observe an undefined `BE` under the
        // import cycle) and delegates the drift check here — every `result |= canThrow(...)` in
        // blockExit (blockexit.d:103, 203, 222, 240, 246, 262, 301, 368) ORs a CT value into a BE mask,
        // so a divergence would silently mis-set the throw bits.
        expect(CT.none).toBe(BE.none);
        expect(CT.exception).toBe(BE.throw_);
        expect(CT.error).toBe(BE.errthrow);
    });
});

describe("blockExit boundary guard (blockexit.d:496)", () => {
    test("a null statement is the empty block: BE.fallthru", () => {
        expect(blockExit(null, null, null)).toBe(BE.fallthru);
    });
});

describe("leaf visit arms reachable without a semantic'd expression", () => {
    test("ReturnStatement with no expression -> BE.return_ (blockexit.d:342)", () => {
        // `s.exp` null, so the `canThrow` branch (blockexit.d:346) is not taken.
        expect(blockExit(new ReturnStatement(Loc.initial, null), null, null)).toBe(BE.return_);
    });

    test("Break/Continue label presence selects goto_ vs break_ (blockexit.d:349)", () => {
        expect(blockExit(new BreakStatement(Loc.initial, null), null, null)).toBe(BE.break_);
        const lbl = Identifier.idPool(Uint8Array.from(Array.from("L", (c) => c.charCodeAt(0))));
        expect(blockExit(new BreakStatement(Loc.initial, lbl), null, null)).toBe(BE.goto_);
        // GotoStatement is unconditional (blockexit.d:462).
        expect(blockExit(new GotoStatement(Loc.initial, null), null, null)).toBe(BE.goto_);
    });
});

describe("dispatch fidelity: a STMT with no visitXxx arm halts (blockexit.d:70)", () => {
    test("CompoundDeclarationStatement routes to visitDefaultCase, NOT to visitCompound", () => {
        // The mixin's arm for STMT.CompoundDeclaration (statement.d:2020) expands to
        // `static if (__traits(compiles, visitCompoundDeclaration(sx)))` — blockexit.d declares no
        // such nested function, so it falls to `visitDefaultCase(sx)` = `assert(0)`. Routing it to
        // `visitCompound` (a plausible-looking shortcut) would silently diverge from dmd.
        // The pin is the THROW CLASS, not a message: D's bare `assert(0)` (blockexit.d:74) produces the
        // default "Assertion failure" text and nothing else, so there is no message to pin.
        expect(() => blockExit(new CompoundDeclarationStatement(Loc.initial, null), null, null))
            .toThrow(AssertError);
    });
});
