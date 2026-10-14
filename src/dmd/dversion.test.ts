// Co-located tests for src/dmd/dversion.ts (dmd/dversion.d).
//
// dversion.d carries NO `unittest` block; these are 10 §1.6b behaviour pins of its two classes: the
// constructor forms (including DebugSymbol's one-argument form, which D builds with
// `DSYM.aliasDeclaration`, dversion.d:35), `kind`, and `syntaxCopy`.

import "./parse.js"; // module-graph ROOT for a core-SCC test file (10 §1.5)

import { beforeEach, describe, expect, test } from "vitest";

import { DebugSymbol, VersionSymbol } from "./dversion.js";
import { DSYM } from "./dsymbol.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { initSemaHarness } from "../sema-harness.js";
import { ds, dsToJs } from "../dstring.js";

beforeEach(() => {
    initSemaHarness();
});

describe("dversion.d:26 — DebugSymbol", () => {
    test("the two-argument form is a debugSymbol; the one-argument form is D's aliasDeclaration", () => {
        const d = new DebugSymbol(Loc.initial, Identifier.idPool(ds("Foo")));
        expect(d.dsym).toBe(DSYM.debugSymbol);
        expect(dsToJs(d.kind())).toBe("debug");
        const bare = new DebugSymbol(Loc.initial);
        expect(bare.dsym).toBe(DSYM.aliasDeclaration);
        expect(bare.ident).toBe(null);
    });

    test("syntaxCopy: a fresh symbol with the same ident and doc comment", () => {
        const d = new DebugSymbol(Loc.initial, Identifier.idPool(ds("Foo")));
        d.addComment(ds("doc"));
        const c = d.syntaxCopy(null);
        expect(c).not.toBe(d);
        expect(c).toBeInstanceOf(DebugSymbol);
        expect(c.ident).toBe(d.ident);
        expect(c.dsym).toBe(DSYM.debugSymbol);
        expect(dsToJs(c.comment()!)).toBe("doc");
        expect(() => d.syntaxCopy(d)).toThrow();   // `assert(!s)` (dversion.d:40)
    });
});

describe("dversion.d:61 — VersionSymbol", () => {
    test("both constructor forms are versionSymbol", () => {
        expect(new VersionSymbol(Loc.initial, Identifier.idPool(ds("Bar"))).dsym).toBe(DSYM.versionSymbol);
        expect(new VersionSymbol(Loc.initial).dsym).toBe(DSYM.versionSymbol);
        expect(dsToJs(new VersionSymbol(Loc.initial).kind())).toBe("version");
    });

    test("syntaxCopy: a fresh symbol with the same ident and doc comment", () => {
        const v = new VersionSymbol(Loc.initial, Identifier.idPool(ds("Bar")));
        v.addComment(ds("vdoc"));
        const c = v.syntaxCopy(null);
        expect(c).not.toBe(v);
        expect(c).toBeInstanceOf(VersionSymbol);
        expect(c.ident).toBe(v.ident);
        expect(dsToJs(c.comment()!)).toBe("vdoc");
        expect(() => v.syntaxCopy(v)).toThrow();   // `assert(!s)` (dversion.d:76)
    });
});
