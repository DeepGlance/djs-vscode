// Goal tests for src/dmd/aliasthis.ts.
//
// dmd/aliasthis.d has ZERO in-source `unittest{}` blocks, so this file takes the 10 §1.6b CANONICAL
// shape exactly: ONE module-load smoke test plus THREE behavior pins, all built with the EXISTING
// harness conventions (the 10 §1.5 init snippet, mirrored from cond.test.ts). No new harness
// machinery, and no pin for a path the harness cannot reach honestly.
//
// The three pins, each consolidating one coherent slice of the node's behavior:
//   1. the freshly-constructed node — DSYM tag, the `.init` of `sym`/`isDeprecated_` (09 §1.0), the
//      two ident slots (02 §11.5b: the derived `identAlias` holds the name, the base `ident` stays
//      null, so `isAnonymous()` is true as in D), and the three trivial hooks `kind()`
//      (aliasthis.d:48) / `isAliasThis()` (:53) / `isDeprecated()` (:63);
//   2. `syntaxCopy` (:40) — fresh node, same loc/ident, ddoc comment carried, `assert(!s)` enforced;
//   3. the visitor double-dispatch of `accept` (:58) — 13 §2.

import { beforeEach, describe, expect, test } from "vitest";
import { AliasThis } from "./aliasthis.js";
import { Dsymbol, DSYM } from "./dsymbol.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { initTokens } from "./tokens.js";
import { Id } from "./id.js";
import { SemanticTimePermissiveVisitor } from "./visitor/index.js";
import { ds, dsToJs } from "../dstring.js";

beforeEach(() => {
    Loc._init();
    initTokens(); // also runs Identifier.initTable
    Id.initialize();
});

describe("aliasthis.ts", () => {
    test("SMOKE: the module loads and AliasThis constructs (aliasthis.d:36)", () => {
        // aliasthis.ts takes a VALUE import on dsymbol.ts (it `extends Dsymbol`), so a load-order
        // cycle would surface right here (01 §4.1). A successful construction IS the smoke test.
        const at = new AliasThis(Loc.initial, Identifier.idPool(ds("payload")));
        expect(at instanceof Dsymbol).toBe(true);
    });

    test("PIN 1: the freshly-constructed node — tag, .init slots, ident, trivial hooks", () => {
        const id = Identifier.idPool(ds("payload"));
        const at = new AliasThis(Loc.initial, id);

        expect(at.dsym).toBe(DSYM.aliasThis); // aliasthis.d:36
        expect(at.sym).toBe(null); // aliasthis.d:30 — class ref, `.init` = null (09 §1.0)
        expect(at.isDeprecated_).toBe(false); // aliasthis.d:32 — `bool`, `.init` = false

        // aliasthis.d:36-37: the base slot gets `null` from `super(..., null)` and the name goes to
        // the DERIVED slot, `identAlias` (02 §11.5b). Both slots are live, as in D.
        expect(at.identAlias).toBe(id);
        expect(at.ident).toBe(null);
        expect(at.isAnonymous()).toBe(true); // dsymbol.d:501 reads the base slot

        expect(dsToJs(at.kind())).toBe("alias this"); // aliasthis.d:50
        expect(at.isAliasThis()).toBe(at); // aliasthis.d:55
        expect(at.isDeprecated()).toBe(false); // aliasthis.d:65
        // dsymbolsem.d:2050 sets isDeprecated_ from the scope's STC.deprecated_; the getter follows.
        at.isDeprecated_ = true;
        expect(at.isDeprecated()).toBe(true);
    });

    test("PIN 2: syntaxCopy — fresh node, same loc/ident, ddoc carried, assert(!s) (aliasthis.d:40)", () => {
        const id = Identifier.idPool(ds("payload"));
        const at = new AliasThis(Loc.initial, id);
        at.addComment(ds("the doc comment")); // D `at.addComment(comment)`, aliasthis.d:44

        const cp = at.syntaxCopy(null);
        expect(cp).not.toBe(at);
        expect(cp instanceof AliasThis).toBe(true);
        expect(cp.identAlias).toBe(id);
        expect(cp.ident).toBe(null);
        expect(cp.loc.equals(at.loc)).toBe(true);
        // the copy is a brand-new node: the semantic slots are back at their .init
        expect(cp.sym).toBe(null);
        expect(cp.isDeprecated_).toBe(false);
        expect(dsToJs(cp.comment()!)).toBe("the doc comment");

        // D `assert(!s)` (aliasthis.d:42) rejects a non-null argument.
        const other = new AliasThis(Loc.initial, Identifier.idPool(ds("other")));
        expect(() => at.syntaxCopy(other)).toThrow();
    });

    test("PIN 3: accept calls the visitor's OWN visitAliasThis, not visitDsymbol (aliasthis.d:60)", () => {
        class Recorder extends SemanticTimePermissiveVisitor {
            seen: AliasThis | null = null;
            baseHits = 0;
            override visitAliasThis(s: AliasThis): void {
                this.seen = s;
            }
            override visitDsymbol(_s: Dsymbol): void {
                this.baseHits++;
            }
        }
        const at = new AliasThis(Loc.initial, Identifier.idPool(ds("payload")));
        const v = new Recorder();
        at.accept(v);
        expect(v.seen).toBe(at);
        expect(v.baseHits).toBe(0);
    });
});
