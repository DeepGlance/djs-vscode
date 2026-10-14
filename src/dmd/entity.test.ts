// Behavioral / goal test for the ported dmd/entity.d HTML-named-entity table + lookup.
//
// entity.d has NO `unittest{}` blocks (verified), so there is nothing to port 1:1. This test instead
// PROTECTS THE GOAL of the translation: the full ~2194-row table is wired and `HtmlNamedEntity`
// returns the same `[value, value2]` pairs as upstream ldc2 (all expectations below are VERIFIED with
// `ldc2 -run` against dmd/entity.d). It also guards the four lexer-relevant entities (`quot`/`lt`/
// `gt`/`amp`) the lexer's old MINIMAL_ENTITIES stub covered, plus entities that stub got WRONG
// (`copy`/`nbsp`) — the regression this de-stub fixes.

import { describe, test, expect } from "vitest";
import { HtmlNamedEntity } from "./entity.js";
import { ds } from "../dstring.js";
import { DError } from "../assert.js";

function lookup(name: string): [number, number] {
    return HtmlNamedEntity(ds(name));
}

describe("HtmlNamedEntity", () => {
    test("the four lexer-stub entities (quot/lt/gt/amp)", () => {
        expect(lookup("quot")).toEqual([0x22, 0]);
        expect(lookup("lt")).toEqual([0x3c, 0]);
        expect(lookup("gt")).toEqual([0x3e, 0]);
        expect(lookup("amp")).toEqual([0x26, 0]);
    });

    test("entities the old 4-entry stub got WRONG are now decoded", () => {
        // The MINIMAL_ENTITIES stub reported these as "unnamed"; the full table decodes them.
        expect(lookup("copy")).toEqual([0xa9, 0]);
        expect(lookup("nbsp")).toEqual([0xa0, 0]);
        expect(lookup("AElig")).toEqual([0xc6, 0]);
        expect(lookup("Aacute")).toEqual([0xc1, 0]);
    });

    test("case-sensitive name match (AMP vs amp share a code point, but distinct rows)", () => {
        expect(lookup("AMP")).toEqual([0x26, 0]);
        expect(lookup("amp")).toEqual([0x26, 0]);
    });

    test("two-code-point entity carries value2 (acE)", () => {
        expect(lookup("acE")).toEqual([0x223e, 0x333]);
    });

    test("first and last rows of the alphabetic span", () => {
        // namesA[0] and namesZ[$-1]
        expect(lookup("Aacgr")).toEqual([0x00386, 0]);
        expect(lookup("zwnj")).toEqual([0x0200c, 0]);
        expect(lookup("Zopf")).toEqual([0x02124, 0]);
    });

    test("astral-plane code point (Mathematical Fraktur, > U+FFFF)", () => {
        expect(lookup("Afr")).toEqual([0x1d504, 0]);
    });

    test("unrecognized name returns [0, 0] (entity.init)", () => {
        expect(lookup("BAD")).toEqual([0, 0]);
        expect(lookup("notanentity")).toEqual([0, 0]);
    });

    test("name whose first byte is non-letter returns [0, 0] without scanning", () => {
        // tolower('1') == '1' is outside 'a'..'z', so the linear search is skipped.
        expect(lookup("1abc")).toEqual([0, 0]);
    });

    test("empty name is a loud bounds violation (D `name[0]` out of bounds)", () => {
        expect(() => HtmlNamedEntity(ds(""))).toThrow(DError);
    });
});
