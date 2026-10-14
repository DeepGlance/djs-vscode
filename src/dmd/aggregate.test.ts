// Goal tests for src/dmd/aggregate.ts.
//
// dmd/aggregate.d has ZERO in-source `unittest{}` blocks, so this file takes the 10 §1.6b shape:
// one module-load smoke test (importing the module executes its top-level, catching load-order /
// cycle regressions in the core SCC) plus a few behavior pins that the EXISTING harness reaches
// honestly — the free aligner functions (pure, no harness needed) and the AggregateDeclaration
// accessors reachable through a StructDeclaration built the way declaration.test.ts builds nodes.
//
// Setup mirrors declaration.test.ts (10 §1.5): initTokens() first (it also runs
// Identifier.initTable), then Id.initialize() and Loc._init().

import { beforeEach, describe, expect, test } from "vitest";
import {
    AggregateDeclaration,
    ClassKind,
    ClassKindToChars,
    MangleOverride,
    alignmember,
    placeField,
} from "./aggregate.js";
import { StructDeclaration } from "./dstruct.js";
import { VarDeclaration } from "./declaration.js";
import { Visibility } from "./dsymbol.js";
import { VoidInitializer } from "./init.js";
import { Sizeok, STC, structalign_t, CPPMANGLE } from "./astenums.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { initTokens } from "./tokens.js";
import { dsToJs } from "../dstring.js";

beforeEach(() => {
    initTokens(); // also runs Identifier.initTable
    Id.initialize();
    Loc._init();
});

function id(name: string): Identifier {
    return Identifier.idPool(Uint8Array.from(Array.from(name, (c) => c.charCodeAt(0))));
}

/// A default (unset-by-the-user) alignment: `structalign_t.init` with `setDefault()`, which is what
/// `Target.fieldalign`-driven placement passes for a field without an explicit `align(N)`.
function defaultAlign(): structalign_t {
    const a = new structalign_t();
    a.setDefault();
    return a;
}

describe("module load", () => {
    test("smoke: importing dmd.aggregate executes its top level and exports the D symbols", () => {
        expect(typeof ClassKindToChars).toBe("function");
        expect(typeof alignmember).toBe("function");
        expect(typeof placeField).toBe("function");
        expect(typeof MangleOverride).toBe("function");
        expect(typeof AggregateDeclaration).toBe("function");
    });
});

describe("ClassKind / ClassKindToChars (dmd/aggregate.d:40,:59)", () => {
    test("the enum's members keep D's declaration order (ubyte base, .init == first member)", () => {
        expect(ClassKind.d).toBe(0);
        expect(ClassKind.cpp).toBe(1);
        expect(ClassKind.objc).toBe(2);
        expect(ClassKind.c).toBe(3);
    });

    test("each kind maps to its D spelling, in the DString domain (%s argument of error())", () => {
        expect(dsToJs(ClassKindToChars(ClassKind.d))).toBe("D");
        expect(dsToJs(ClassKindToChars(ClassKind.cpp))).toBe("C++");
        expect(dsToJs(ClassKindToChars(ClassKind.objc))).toBe("Objective-C");
        expect(dsToJs(ClassKindToChars(ClassKind.c))).toBe("C");
    });
});

describe("MangleOverride (dmd/aggregate.d:78) — value struct", () => {
    test(".copy() is field-wise and SHARES the class references (03 §2)", () => {
        const m = new MangleOverride();
        const ident = id("mangled");
        m.id = ident;
        const c = m.copy();
        expect(c).not.toBe(m);          // a distinct value
        expect(c.id).toBe(ident);       // class ref: shared, not cloned
        expect(c.agg).toBeNull();
        c.id = id("other");
        expect(m.id).toBe(ident);       // the copy is independent storage
    });
});

describe("alignmember (dmd/aggregate.d:229)", () => {
    test("default alignment rounds the offset up to the field's natural alignment", () => {
        expect(alignmember(defaultAlign(), 8, 4)).toBe(8);
        expect(alignmember(defaultAlign(), 4, 4)).toBe(4);
        expect(alignmember(defaultAlign(), 4, 5)).toBe(8);
    });

    test("an explicit align(1) falls through the chain and returns the offset unchanged", () => {
        // Neither default nor pack, and `alignment.get() > 1` is false -> `return offset`.
        const a = new structalign_t();
        a.set(1);
        expect(alignmember(a, 4, 7)).toBe(7);
    });

    test("#pragma pack takes min(memalignsize, alignment)", () => {
        const a = new structalign_t();
        a.set(2);
        a.setPack();
        expect(alignmember(a, 8, 3)).toBe(4);   // packed to 2 -> 3 rounds up to 4
    });
});

describe("placeField (dmd/aggregate.d:274)", () => {
    // The layout numbers are the ldc2-verified ones already pinned in sema.struct.test.ts.
    test("`struct M { int a; long b; }` layout: offsets 0 and 8, size 16, align 8", () => {
        const nextoffset = { value: 0 };
        const aggsize = { value: 0 };
        const aggalignsize = { value: 0 };

        const aOff = placeField(Loc.initial, nextoffset, 4, 4, defaultAlign(), aggsize, aggalignsize, false);
        expect(aOff).toBe(0);
        expect(nextoffset.value).toBe(4);
        expect(aggsize.value).toBe(4);
        expect(aggalignsize.value).toBe(4);

        const bOff = placeField(Loc.initial, nextoffset, 8, 8, defaultAlign(), aggsize, aggalignsize, false);
        expect(bOff).toBe(8);           // padded past `int a`
        expect(nextoffset.value).toBe(16);
        expect(aggsize.value).toBe(16);
        expect(aggalignsize.value).toBe(8);
    });

    test("a union does NOT advance nextoffset; aggsize is the max of the members", () => {
        const nextoffset = { value: 0 };
        const aggsize = { value: 0 };
        const aggalignsize = { value: 0 };

        placeField(Loc.initial, nextoffset, 4, 4, defaultAlign(), aggsize, aggalignsize, true);
        placeField(Loc.initial, nextoffset, 8, 8, defaultAlign(), aggsize, aggalignsize, true);
        expect(nextoffset.value).toBe(0);
        expect(aggsize.value).toBe(8);
        expect(aggalignsize.value).toBe(8);
    });
});

describe("AggregateDeclaration accessors (through a StructDeclaration)", () => {
    function sd(): StructDeclaration {
        return new StructDeclaration(Loc.initial, id("S"), false);
    }

    test("ctor: visibility is public_ (dmd/aggregate.d:152); the field .inits are D's", () => {
        const s = sd();
        expect(s.visibility).toBeInstanceOf(Visibility);
        expect(s.visibility.kind).toBe(Visibility.Kind.public_);
        expect(s.classKind).toBe(ClassKind.d);        // enum .init == FIRST member
        expect(s.cppmangle).toBe(CPPMANGLE.def);      // enum .init == FIRST member
        expect(s.sizeok).toBe(Sizeok.none);
        expect(s.storage_class).toBe(0n);
        expect(s.fields.length).toBe(0);
        expect(s.invs.length).toBe(0);
        expect(s.userDtors.length).toBe(0);
        expect(s.deferredTI).toBeNull();              // the derived slot (02 §11.5b)
    });

    test("visible() returns a COPY of visibility, not the field (D returns the struct by value)", () => {
        const s = sd();
        const v = s.visible();
        expect(v.kind).toBe(Visibility.Kind.public_);
        v.kind = Visibility.Kind.private_;
        expect(s.visibility.kind).toBe(Visibility.Kind.public_);
    });

    test("isNested()/nonHiddenFields() count the hidden context pointers (dmd/aggregate.d:161,:180)", () => {
        const s = sd();
        expect(s.isNested()).toBe(false);
        expect(s.nonHiddenFields()).toBe(0);

        // Nest it the way `makeNested` does (dmd/dsymbolsem.d:299): `enclosing` is set AND the
        // hidden `this` is added as a field — `fields` INCLUDES the hidden members
        // (dmd/aggregate.d:93), so a nested aggregate always carries its own entry there
        // (dsymbolsem.d:365, or via the members/field collection at dsymbolsem.d:7293). Setting
        // `enclosing` WITHOUT the field is not a state dmd hands to `nonHiddenFields()`: D's
        // `size_t` subtraction would wrap to 2^64-1 there, so pinning the port's negative `number`
        // would certify a divergence rather than D's behavior (10 §1.8 rule 5, §1.9).
        s.enclosing = s;   // any non-null Dsymbol makes the aggregate nested
        s.fields.push(new VarDeclaration(Loc.initial, null, id("__vthis"), new VoidInitializer(Loc.initial),
            STC.field as STC));
        expect(s.isNested()).toBe(true);
        expect(s.nonHiddenFields()).toBe(0);    // 1 field, and that one field IS the hidden `this`
    });

    test("isDeprecated()/setDeprecated() ride STC.deprecated_ (dmd/aggregate.d:165,:171)", () => {
        const s = sd();
        expect(s.isDeprecated()).toBe(false);
        s.setDeprecated();
        expect(s.isDeprecated()).toBe(true);
    });

    test("isExport() reads visibility.kind; hasInvariant() reads invs.length", () => {
        const s = sd();
        expect(s.isExport()).toBe(false);
        s.visibility = new Visibility(Visibility.Kind.export_);
        expect(s.isExport()).toBe(true);
        expect(s.hasInvariant()).toBe(false);
    });

    test("handleType() returns the aggregate's own type (the TypeStruct the ctor built)", () => {
        const s = sd();
        expect(s.handleType()).toBe(s.type);
        expect(s.handleType()).not.toBeNull();
    });
});
