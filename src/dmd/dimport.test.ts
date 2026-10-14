// Co-located tests for src/dmd/dimport.ts (dmd/dimport.d).
//
// `dmd/dimport.d` contains ZERO in-source `unittest{}` blocks (verified: `grep -c '^unittest'`
// returns 0), so per 10-tests-diagnostics.md §1.6b this file is the thin test file: one
// module-load smoke test plus behavior pins constructible with the EXISTING harness conventions
// (the §1.5 init snippet). No new harness machinery is built here, and no pin is fabricated for
// a path the harness cannot reach honestly — `addPackageAccess` needs a live `Package`/`Module`
// symbol tree, which is the corpus oracle's job, not this file's.
//
// SHAPE NOTE (flagged to the integrator): §1.6b's canonical shape is "1-3 behavior pins" and this
// file carries 9. Every one is honest and cheap — no harness machinery, no fabricated path — and
// each pins a distinct D line (:45-60 bracketing x3, :80, :64, :85, :100 x2, :96/:99), so they are
// kept rather than deleted; §1.6b caps the OBLIGATION, and dropping green pins would only shrink
// verified coverage. If the integrator reads the "1-3" as a hard cap, the trim is mechanical.

import { beforeEach, describe, expect, test } from "vitest";
import { Import } from "./dimport.js";
import { Dsymbol, DSYM, Visibility } from "./dsymbol.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { initTokens } from "./tokens.js";
import { dsToJs } from "../dstring.js";

beforeEach(() => {
    Loc._init();
    initTokens(); // also runs Identifier.initTable — idPool needs the interning table
});

function id(name: string): Identifier {
    return Identifier.idPool(Uint8Array.from(Array.from(name, (c) => c.charCodeAt(0))));
}

describe("module load smoke (§1.6b)", () => {
    test("the module loads and Import is constructible", () => {
        expect(typeof Import).toBe("function");
        const imp = new Import(Loc.initial, null, id("stdio"), null, 0);
        expect(imp).toBeInstanceOf(Import);
        expect(imp).toBeInstanceOf(Dsymbol);
        expect(imp.dsym).toBe(DSYM.import_);
    });
});

describe("dimport.d:43 — constructor + selectIdent bracketing", () => {
    // dimport.d:45-60: the Dsymbol identifier is aliasId, else packages[0], else id.
    test("import [id];  — no packages, no alias", () => {
        const modid = id("stdio");
        const imp = new Import(Loc.initial, null, modid, null, 0);
        expect(imp.ident).toBe(modid);
        expect(imp.id).toBe(modid);
        expect(imp.packages).toBe(null); // the D null slice survives as null (06 §2.8)
    });

    test("import [std].stdio;  — leftmost package wins over the module id", () => {
        const std = id("std");
        const modid = id("stdio");
        const imp = new Import(Loc.initial, [std], modid, null, 0);
        expect(imp.ident).toBe(std);
        expect(imp.id).toBe(modid);
    });

    test("import [aliasId] = std.stdio;  — the alias wins over both", () => {
        const std = id("std");
        const modid = id("stdio");
        const ali = id("io");
        const imp = new Import(Loc.initial, [std], modid, ali, 0);
        expect(imp.ident).toBe(ali);
        expect(imp.aliasId).toBe(ali);
    });

    test("dimport.d:80 — visibility defaults to private_, and visible() hands back a COPY", () => {
        const imp = new Import(Loc.initial, null, id("stdio"), null, 0);
        expect(imp.visibility.kind).toBe(Visibility.Kind.private_);
        const v = imp.visible();
        expect(v.kind).toBe(Visibility.Kind.private_);
        expect(v).not.toBe(imp.visibility); // 03 §1 #3: returned by value
        v.kind = Visibility.Kind.public_;
        expect(imp.visibility.kind).toBe(Visibility.Kind.private_); // the node is unaffected
    });

    test("dimport.d:64 — `assert(id)` rejects a null module identifier", () => {
        expect(() => new Import(Loc.initial, null, null, null, 0)).toThrow();
    });
});

describe("dimport.d:83/:93 — kind() and syntaxCopy()", () => {
    test("kind() reads isstatic (dimport.d:85)", () => {
        expect(dsToJs(new Import(Loc.initial, null, id("stdio"), null, 0).kind())).toBe("import");
        expect(dsToJs(new Import(Loc.initial, null, id("stdio"), null, 1).kind())).toBe("static import");
    });

    test("syntaxCopy carries the alias=name pairs and keeps ident when aliasId is set", () => {
        const imp = new Import(Loc.initial, [id("std")], id("stdio"), id("io"), 0);
        const name = id("writeln");
        const ali = id("wl");
        imp.names.push(name);
        imp.aliases.push(ali);

        const si = imp.syntaxCopy(null);
        expect(si).not.toBe(imp);
        expect(si.names.length).toBe(1);
        expect(si.names.opIndex(0)).toBe(name);
        expect(si.aliases.opIndex(0)).toBe(ali);
        // dimport.d:100 — `si.aliasId` is set, so the selected ident is kept.
        expect(si.ident).toBe(imp.aliasId);
    });

    test("syntaxCopy nulls ident when there are names but no aliasId (dimport.d:100)", () => {
        const imp = new Import(Loc.initial, null, id("stdio"), null, 0);
        imp.names.push(id("writeln"));
        imp.aliases.push(id("wl"));
        const si = imp.syntaxCopy(null);
        expect(si.ident).toBe(null);
    });

    test("syntaxCopy asserts s === null (dimport.d:96) and !(isstatic && names.length) (dimport.d:99)", () => {
        const imp = new Import(Loc.initial, null, id("stdio"), null, 0);
        expect(() => imp.syntaxCopy(imp)).toThrow();

        const stat = new Import(Loc.initial, null, id("stdio"), null, 1);
        stat.names.push(id("writeln"));
        stat.aliases.push(id("wl"));
        expect(() => stat.syntaxCopy(null)).toThrow();
    });
});
