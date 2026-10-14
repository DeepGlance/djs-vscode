// Co-located tests for src/dmd/denum.ts (dmd/denum.d).
//
// `dmd/denum.d` contains ZERO in-source `unittest{}` blocks (verified: `grep -c '^unittest'`
// returns 0), so per 10-tests-diagnostics.md §1.6b this file is the thin test file and takes
// the CANONICAL SHAPE that section prescribes: one module-load smoke test plus THREE behavior
// pins, each constructible with the EXISTING harness conventions. No new harness machinery, and
// no fabricated pins for paths the harness cannot reach honestly.
//
// Setup is the §1.5 canonical init snippet, in the 01 §5.2 ORDER contract, reduced to the three
// steps these pins touch: `Loc._init()`, `initTokens()`, `Id.initialize()`. `Type._init()` is not
// called because §1.5 runs it "only if the test touches" the basic-type table, and nothing here
// does — `TypeError` and `NullExp` are constructible without it.

import { beforeEach, describe, expect, test } from "vitest";
import { EnumDeclaration, EnumMember, isSpecialEnumIdent } from "./denum.js";
import { Visibility, DSYM } from "./dsymbol.js";
import { STC } from "./astenums.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { initTokens } from "./tokens.js";
import { TypeEnum, TypeError as TypeErrorNode, type Type } from "./mtype.js";
import { ExpInitializer } from "./init.js";
import { NullExp } from "./expression.js";
import { UserAttributeDeclaration, DeprecatedDeclaration } from "./attrib.js";
import { dsToJs } from "../dstring.js";

const loc = Loc.initial;

beforeEach(() => {
    Loc._init();
    initTokens(); // also runs Identifier.initTable
    Id.initialize(); // interns the Id.__c_* singletons isSpecialEnumIdent compares against
});

function id(name: string): Identifier {
    return Identifier.idPool(Uint8Array.from(Array.from(name, (c) => c.charCodeAt(0))));
}

describe("module load smoke (§1.6b)", () => {
    test("importing dmd/denum.ts executes its top level and exports the node classes", () => {
        // A load-order/cycle regression in this core-SCC module surfaces here as a
        // "cannot access before initialization" at import time.
        expect(typeof EnumDeclaration).toBe("function");
        expect(typeof EnumMember).toBe("function");
        expect(typeof isSpecialEnumIdent).toBe("function");
    });
});

describe("denum.d — behavior pins (§1.6b)", () => {
    // PIN 1 — EnumDeclaration's birth and the two reads over it: the resolved bit-field members
    // (denum.d:54-62, the packed word DISCARDED per 11 §3.6), `visible()` returning BY VALUE
    // (denum.d:98, 03 §1 #3), and `isSpecial()` (denum.d:109) which routes through the
    // interning-identity comparison of `isSpecialEnumIdent` (denum.d:193, 05 §2).
    test("EnumDeclaration: ctor wiring, .init fields, bit-field members, visible() by value, isSpecial()", () => {
        const memtype: Type = new TypeErrorNode();
        const ed = new EnumDeclaration(loc, id("E"), memtype);

        // `type = new TypeEnum(this)` — the enum's own type points back at the declaration.
        expect(ed.type).toBeInstanceOf(TypeEnum);
        expect(ed.type!.isTypeEnum()!.sym).toBe(ed);
        expect(ed.memtype).toBe(memtype);
        // The `super(loc, ident)` call leaves DSYM.scopeDsymbol; the body overwrites it.
        expect(ed.dsym).toBe(DSYM.enumDeclaration);
        expect(ed.visibility.kind).toBe(Visibility.Kind.undefined);
        expect(dsToJs(ed.kind())).toBe("enum");
        // Anonymous enum (null ident) and memtype-less enum are both legal; the remaining fields
        // keep their D `.init` (09 §1.0): class refs are null.
        const anon = new EnumDeclaration(loc, null, null);
        expect([anon.ident, anon.memtype, anon.maxval, anon.minval, anon.defaultval])
            .toEqual([null, null, null, null, null]);

        // The three resolved bit-field members: independent booleans, all false at birth — the
        // exact guarantee the generated shift/mask accessors gave.
        expect([ed.isdeprecated, ed.added, ed.inuse]).toEqual([false, false, false]);
        ed.added = true;
        ed.isdeprecated = true;
        expect([ed.isdeprecated, ed.added, ed.inuse]).toEqual([true, true, false]);
        expect(ed.isDeprecated()).toBe(true); // denum.d:93 reads `isdeprecated`

        // 03 §1 #3: D returns `visibility` BY VALUE, so a caller cannot reach back into the
        // declaration through the returned struct. `Visibility` is NOT in the 03 §9.1 alias-safe
        // register, so the copy is the required default, not an elidable one.
        const v = ed.visible();
        expect(v).not.toBe(ed.visibility);
        v.kind = Visibility.Kind.public_;
        expect(ed.visibility.kind).toBe(Visibility.Kind.undefined);

        // `isSpecialEnumIdent(ident) && memtype` — BOTH halves required (denum.d:111).
        for (const special of [Id.__c_long, Id.__c_ulong, Id.__c_longlong, Id.__c_ulonglong,
                               Id.__c_long_double, Id.__c_wchar_t, Id.__c_complex_float,
                               Id.__c_complex_double, Id.__c_complex_real]) {
            expect(special).not.toBeNull();
            expect(isSpecialEnumIdent(special)).toBe(true);
        }
        expect(isSpecialEnumIdent(id("__c_longish"))).toBe(false);
        // Identity holds through interning (05 §2): a freshly pooled spelling IS the singleton.
        expect(id("__c_long")).toBe(Id.__c_long);
        expect(new EnumDeclaration(loc, Id.__c_long, null).isSpecial()).toBe(false);      // no memtype
        expect(new EnumDeclaration(loc, id("plain"), new TypeErrorNode()).isSpecial()).toBe(false);
        expect(new EnumDeclaration(loc, Id.__c_long, new TypeErrorNode()).isSpecial()).toBe(true);
    });

    // PIN 2 — the riskiest translation decision in the file: D's TWO ctors collapsed by ARITY
    // (04 §1A Form A, denum.d:143 and denum.d:151). The trailing assignments belong to the
    // 7-argument form ALONE, so the 4-argument form must leave storage_class/userAttribDecl/
    // depdecl exactly as Declaration/Dsymbol gave them. Also pins the ref-returning `value`
    // property (denum.d:132, 04 §9): both halves must route through `_init`, not a private copy.
    test("EnumMember: the ctor arity gate (denum.d:143 vs :151) and the ref `value` property", () => {
        const value = new NullExp(loc);
        const origType: Type = new TypeErrorNode();
        const em4 = new EnumMember(loc, id("m"), value, origType);

        expect(em4.dsym).toBe(DSYM.enumMember);
        expect(dsToJs(em4.kind())).toBe("enum member");
        expect(em4._init).toBeInstanceOf(ExpInitializer);
        expect(em4.origValue).toBe(value);
        expect(em4.origType).toBe(origType);
        expect(em4.ed).toBeNull();
        // The 4-argument D ctor does NOT touch these — and must not materialize DsymbolAttributes.
        expect(em4.storage_class).toBe(STC.none);
        expect(em4.userAttribDecl()).toBeNull();
        expect(em4.depdecl()).toBeNull();
        // `id ? id : Id.empty` (denum.d:145).
        expect(new EnumMember(loc, null, null, null).ident).toBe(Id.empty);

        const uad = new UserAttributeDeclaration(null, null);
        const dd = new DeprecatedDeclaration(new NullExp(loc), null);
        const em7 = new EnumMember(loc, id("m7"), null, null, STC.deprecated_, uad, dd);
        expect(em7._init).toBeInstanceOf(ExpInitializer); // delegated to the 4-argument form
        expect(em7.storage_class).toBe(STC.deprecated_);
        expect(em7.userAttribDecl()).toBe(uad);
        expect(em7.depdecl()).toBe(dd);
        // The parse.d call shape passes a null uad through the 7-argument form.
        const em7n = new EnumMember(loc, id("m8"), null, null, STC.none, null, dd);
        expect(em7n.userAttribDecl()).toBeNull();
        expect(em7n.depdecl()).toBe(dd);

        // `value` reads AND writes through `_init.exp`; `origValue` is a separate slot.
        expect(em4.value).toBe(value);
        const em = new EnumMember(loc, id("v2"), null, null);
        expect(em.value).toBeNull();
        const replacement = new NullExp(loc);
        em.value = replacement;
        expect(em._init!.isExpInitializer()!.exp).toBe(replacement);
        expect(em.value).toBe(replacement);
        expect(em.origValue).toBeNull();
    });

    // PIN 3 — both `syntaxCopy` overrides (denum.d:79 and denum.d:160). Each ALWAYS allocates
    // (`assert(!s)`), and each deep-copies exactly the parts D deep-copies — semantic-time state
    // (the bit-field members, `ed`) is NOT carried.
    test("syntaxCopy: both overrides allocate a fresh node and deep-copy their parts", () => {
        const ed = new EnumDeclaration(loc, id("SC"), new TypeErrorNode());
        ed.added = true; // NOT carried by syntaxCopy — it is a semantic-time flag
        const edc = ed.syntaxCopy(null);

        expect(edc).not.toBe(ed);
        expect(edc).toBeInstanceOf(EnumDeclaration);
        expect(edc.ident).toBe(ed.ident);
        expect(edc.memtype).not.toBeNull();
        expect(edc.dsym).toBe(DSYM.enumDeclaration);
        // Its own TypeEnum, pointing at the COPY (built by the copy's own constructor).
        expect(edc.type!.isTypeEnum()!.sym).toBe(edc);
        expect(edc.added).toBe(false);
        // ScopeDsymbol.syntaxCopy carried the (empty) member list and endlinnum across.
        expect(edc.members).toBeNull();
        // A null memtype stays null (the `memtype ? … : null` half of denum.d:82).
        expect(new EnumDeclaration(loc, id("SC2"), null).syntaxCopy(null).memtype).toBeNull();
        // denum.d:81 — `assert(!s)`: this override never fills a caller's node.
        expect(() => ed.syntaxCopy(new EnumDeclaration(loc, id("other"), null))).toThrow();

        const uad = new UserAttributeDeclaration(null, null);
        const dd = new DeprecatedDeclaration(new NullExp(loc), null);
        const em = new EnumMember(loc, id("sc"), new NullExp(loc), new TypeErrorNode(),
            STC.manifest, uad, dd);
        const emc = em.syntaxCopy(null);

        expect(emc).not.toBe(em);
        expect(emc).toBeInstanceOf(EnumMember);
        expect(emc.ident).toBe(em.ident);
        expect(emc.storage_class).toBe(STC.manifest); // a flag word, carried verbatim
        // `value`/`origType`/`userAttribDecl`/`depdecl` are copied, not shared.
        expect(emc.value).not.toBeNull();
        expect(emc.value).not.toBe(em.value);
        expect(emc.origType).not.toBeNull();
        expect(emc.userAttribDecl()).not.toBe(uad);
        expect(emc.userAttribDecl()).not.toBeNull();
        expect(emc.depdecl()).not.toBe(dd);
        expect(emc.depdecl()).not.toBeNull();
        // `origValue` is set from the COPIED value by the ctor (D passes `value.syntaxCopy()` in).
        expect(emc.origValue).toBe(emc.value);
        // Nulls stay null through the copy.
        const emn = new EnumMember(loc, id("sc2"), null, null).syntaxCopy(null);
        expect([emn.value, emn.origType, emn.userAttribDecl(), emn.depdecl()])
            .toEqual([null, null, null, null]);
        // denum.d:162 — `assert(!s)`.
        expect(() => em.syntaxCopy(new EnumMember(loc, id("other"), null, null))).toThrow();
    });
});
