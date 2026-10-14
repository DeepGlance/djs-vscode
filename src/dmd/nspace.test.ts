// Co-located tests for src/dmd/nspace.ts (dmd/nspace.d).
//
// `dmd/nspace.d` contains ZERO in-source `unittest{}` blocks (verified: the module has none), so
// per 10-tests-diagnostics.md §1.6b this file is the thin test file: one module-load smoke
// test plus a small set of behavior pins constructible with the EXISTING harness conventions. No
// new harness machinery, no fabricated pins.
//
// Pin count: 5, one per ported declaration (ctor, kind, accept) plus the two distinct halves of
// syntaxCopy — slightly over §1.6b's canonical 1-3, and deliberately so: the class ports exactly
// four functions, and every pin is reachable with the §1.5 init snippet alone. Nothing here is
// fabricated to hit a number, and no assertion is a tautology (see the `endlinnum` note below).
//
// Setup is the §1.5 canonical init snippet: `Loc._init()` for the location table and
// `initTokens()` (which also runs `Identifier.initTable`) so `Identifier.idPool` can intern.
// `Type._init()` is deliberately NOT called — nothing here needs the basic-type table.

import { beforeEach, describe, expect, test } from "vitest";
import { Nspace } from "./nspace.js";
import { DSYM, Dsymbol } from "./dsymbol.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { initTokens } from "./tokens.js";
import { astTypeNameDsymbol } from "./asttypename.js";
import { Array as DArray } from "./root/array.js";
import { dsToJs } from "../dstring.js";

import type { Dsymbols } from "./arraytypes.js";

const loc = Loc.initial;

beforeEach(() => {
    Loc._init();
    initTokens(); // also runs Identifier.initTable
});

function id(name: string): Identifier {
    return Identifier.idPool(Uint8Array.from(Array.from(name, (c) => c.charCodeAt(0))));
}

describe("module load smoke (§1.6b)", () => {
    test("importing dmd/nspace.ts executes its top level and exports the node class", () => {
        // A load-order/cycle regression in this core-SCC module surfaces here as a
        // "cannot access before initialization" at import time.
        expect(typeof Nspace).toBe("function");
    });
});

describe("Nspace ctor (nspace.d:65)", () => {
    test("retags dsym to nspace and stores members/identExp as shared references", () => {
        const members: Dsymbols = new DArray<Dsymbol | null>();
        const ns = new Nspace(loc, id("Basket"), null, members);

        // `super(loc, ident)` leaves DSYM.scopeDsymbol; the body overwrites it (nspace.d:69).
        expect(ns.dsym).toBe(DSYM.nspace);
        // dsymbol.d's tag-driven downcast reads that same tag:
        // `dsym === DSYM.nspace ? cast(Nspace)this : null` — so the retag is what makes it succeed.
        expect(ns.isNspace()).toBe(ns);
        expect(ns.ident).toBe(Identifier.idPool(Uint8Array.from([0x42, 0x61, 0x73, 0x6b, 0x65, 0x74])));
        // `Dsymbols*` / `Expression*` are stored, never copied (02 §10 case 1).
        expect(ns.members).toBe(members);
        expect(ns.identExp).toBe(null);
    });
});

describe("Nspace.kind (nspace.d:81)", () => {
    test('returns the C string literal "namespace"', () => {
        const ns = new Nspace(loc, id("Basket"), null, null);
        expect(dsToJs(ns.kind())).toBe("namespace");
    });
});

describe("Nspace.accept (nspace.d:86)", () => {
    test("double-dispatches to the visitor's visitNspace overload", () => {
        // astTypeNameDsymbol drives `node.accept(v)` through AstTypeNameVisitor, whose
        // visitNspace arm writes "Nspace" — so a right answer here proves the dispatch
        // reached THIS node's own named method and not a base's (13 §2).
        const ns = new Nspace(loc, id("Basket"), null, null);
        expect(dsToJs(astTypeNameDsymbol(ns)!)).toBe("Nspace");
    });
});

describe("Nspace.syntaxCopy (nspace.d:74)", () => {
    test("always allocates a fresh node and ignores the Dsymbol argument", () => {
        const ns = new Nspace(loc, id("Basket"), null, null);
        const other = new Nspace(loc, id("Other"), null, null);

        // Unlike ScopeDsymbol.syntaxCopy (which fills a non-null `s`), this override never
        // reuses the argument.
        const copy = ns.syntaxCopy(other);
        expect(copy).not.toBe(ns);
        expect(copy).not.toBe(other);
        expect(copy).toBeInstanceOf(Nspace);
        expect(copy.dsym).toBe(DSYM.nspace);
        expect(copy.ident).toBe(ns.ident);
        expect(copy.identExp).toBe(ns.identExp);
    });

    test("the base call deep-copies members (fresh container, fresh element nodes)", () => {
        const inner = new Nspace(loc, id("Inner"), null, null);
        const members: Dsymbols = new DArray<Dsymbol | null>();
        members.push(inner);
        const ns = new Nspace(loc, id("Basket"), null, members);
        // Non-default value on purpose: `endlinnum` inits to 0 (dsymbol.ts:1365), so comparing the
        // two zeroes would pass whether or not the base call ran. 42 makes the assertion discriminate.
        ns.endlinnum = 42;

        // The fresh node is built with `members = null`; ScopeDsymbol.syntaxCopy(ns) is what
        // repopulates it, via Dsymbol.arraySyntaxCopy (element-wise syntaxCopy).
        const copy = ns.syntaxCopy(null);
        expect(copy.members).not.toBe(members);
        expect(copy.members!.length).toBe(1);
        expect(copy.members!.opIndex(0)).not.toBe(inner);
        // tag-driven downcast (no narrowing assertion): the copied element really is an Nspace.
        expect(copy.members!.opIndex(0)!.isNspace()!.ident).toBe(inner.ident);
        // dsymbol.d:1158 `sds.endlinnum = endlinnum;` — only the base call carries it over.
        expect(copy.endlinnum).toBe(42);
    });
});
