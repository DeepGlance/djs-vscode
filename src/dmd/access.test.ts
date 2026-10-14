// Tests for src/dmd/access.ts.
//
// dmd/access.d has NO in-source `unittest{}` blocks (verified: `grep -c unittest` -> 0), so there is
// nothing to port per 10 §1. What follows is a module-load smoke test plus a few behaviour pins on the
// paths that are constructible with the existing harness conventions (a bare `Dsymbol` + a fresh
// `Scope`): the base `Dsymbol.visible()` is `public_` (dsymbol.d:792) and the base
// `Dsymbol.isOverloadable()` is false (dsymbol.d:729), which is exactly the shape the visibility
// entry points take for a plain symbol. No new harness machinery, no fabricated state (10 §1.9).
//
// Module setup (10 §1.5, 01 Rule 5.2 ORDER CONTRACT): `Loc._init()` resets the process-global location
// table the `Dsymbol` constructor reads through `Loc.initial`; `initTokens()` follows it, mirroring the
// order every other test harness in this tree uses.

import { beforeEach, describe, expect, test } from "vitest";

import { Loc } from "./location.js";
import { initTokens } from "./tokens.js";
import { Dsymbol, DSYM } from "./dsymbol.js";
import { Scope } from "./dscope.js";
import {
    checkAccess,
    checkAccessAggregate,
    checkAccessPackage,
    checkSymbolAccess,
    mostVisibleOverload,
    symbolIsVisible,
    symbolIsVisibleDsymbol,
    symbolIsVisibleModule,
} from "./access.js";

beforeEach(() => {
    Loc._init();
    initTokens();
});

describe("module load (access.d)", () => {
    test("every ported top-level declaration is exported and callable", () => {
        // The three D overload sets are split by receiver type (04 §1 Form B); this pins the split so a
        // later rename cannot silently drop a dependent's import (`checkAccess` <- expressionsem.ts,
        // `symbolIsVisible` <- typesem.ts).
        for (const fn of [checkAccess, checkAccessAggregate, checkAccessPackage, checkSymbolAccess,
                          mostVisibleOverload, symbolIsVisible, symbolIsVisibleDsymbol,
                          symbolIsVisibleModule]) {
            expect(typeof fn).toBe("function");
        }
    });
});

describe("symbolIsVisibleDsymbol (access.d:263)", () => {
    // access.d:265 — `return symbolIsVisible(origin.getAccessModule(), s);` with NO null guard. A bare
    // Dsymbol has no enclosing Module, so `getAccessModule()` is null (dsymbol.d:568) and D calls the
    // Module overload with a null `mod`. This pins that the port passes the null through instead of
    // asserting it away; with a public `s` the switch answers before `mod` is ever compared.
    test("a null lookup module is passed through, not asserted away", () => {
        const origin = new Dsymbol(DSYM.dsymbol);
        expect(origin.getAccessModule()).toBe(null);
        expect(symbolIsVisibleDsymbol(origin, new Dsymbol(DSYM.dsymbol))).toBe(true);
    });
});

describe("mostVisibleOverload (access.d:311)", () => {
    // access.d:313 — `if (!s.isOverloadable()) return s;`. A plain Dsymbol is not overloadable, so the
    // chain walk is never entered and the identity of the argument is preserved.
    test("a non-overloadable symbol is returned unchanged", () => {
        const s = new Dsymbol(DSYM.dsymbol);
        expect(mostVisibleOverload(s)).toBe(s);
    });
});

describe("checkSymbolAccess / symbolIsVisible (access.d:292 / access.d:277)", () => {
    // access.d:301 — `case Visibility.Kind.public_, export_: return true;`. The base Dsymbol reports
    // public visibility, so neither `sc._module` nor the package/protected helpers are consulted.
    test("a public symbol is accessible from any scope", () => {
        const sc = Scope.alloc();
        const s = new Dsymbol(DSYM.dsymbol);
        expect(checkSymbolAccess(sc, s)).toBe(true);
    });

    // access.d:279-280 — `s = mostVisibleOverload(s); return checkSymbolAccess(sc, s);`.
    test("symbolIsVisible composes mostVisibleOverload with checkSymbolAccess", () => {
        const sc = Scope.alloc();
        const s = new Dsymbol(DSYM.dsymbol);
        expect(symbolIsVisible(sc, s)).toBe(true);
    });
});

describe("checkAccess head guards (access.d:166)", () => {
    // access.d:168 — `if (sc.noAccessCheck) return false;`. Returns false = "accessible", before any
    // receiver inspection (`e` is never touched on this path).
    test("noAccessCheck short-circuits to accessible", () => {
        const sc = Scope.alloc();
        sc.noAccessCheck = true;
        expect(checkAccess(Loc.initial, sc, null, new Dsymbol(DSYM.dsymbol))).toBe(false);
    });

    // access.d:188 — `if (!e) return false;`. A receiver-less check (the `checkAccess(loc, sc, null, f)`
    // call shape used at expressionsem.d:8501) is accessible by construction.
    test("a null receiver expression is accessible", () => {
        const sc = Scope.alloc();
        expect(checkAccess(Loc.initial, sc, null, new Dsymbol(DSYM.dsymbol))).toBe(false);
    });
});
