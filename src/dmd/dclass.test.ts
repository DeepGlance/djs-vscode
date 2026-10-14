// Goal tests for src/dmd/dclass.ts.
//
// dmd/dclass.d has ZERO in-source `unittest{}` blocks, so this file takes the 10 §1.6b shape:
// one module-load smoke test (importing the module executes its top level, catching load-order /
// cycle regressions in the core SCC) plus behavior pins the EXISTING harness reaches honestly —
// the `BaseClass` value struct (pure, no harness), the base-class predicates, `searchBase`, and
// `copyBaseInterfaces` on nodes built the way aggregate.test.ts / declaration.test.ts build them,
// plus one pinned wall (10 §1.8) on the single deferred callee in the module.
//
// Setup mirrors aggregate.test.ts (10 §1.5): initTokens() first (it also runs
// Identifier.initTable), then Id.initialize() and Loc._init().

import { beforeEach, describe, expect, test } from "vitest";
import {
    BaseClass,
    ClassDeclaration,
    ClassFlags,
    InterfaceDeclaration,
} from "./dclass.js";
import { ClassKind } from "./aggregate.js";
import { Baseok, Sizeok } from "./astenums.js";
import { DSYM, PASS } from "./dsymbol.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { TypeClass } from "./mtype.js";
import { Array as DArray } from "./root/array.js";
import { initTokens } from "./tokens.js";
import { Objc } from "./objc.js";
import type { BaseClasses } from "./arraytypes.js";
import type { Dsymbol } from "./dsymbol.js";
import { dsToJs } from "../dstring.js";

beforeEach(() => {
    initTokens(); // also runs Identifier.initTable
    Id.initialize();
    Loc._init();
});

function id(name: string): Identifier {
    return Identifier.idPool(Uint8Array.from(Array.from(name, (c) => c.charCodeAt(0))));
}

/// A plain (non-reserved, non-object.d) class, i.e. the path through the constructor that runs
/// no `classError` — dclass.d:180/:189 only fire for the reserved names.
function cls(name: string): ClassDeclaration {
    return new ClassDeclaration(Loc.initial, id(name), null, null, false);
}

function iface(name: string): InterfaceDeclaration {
    return new InterfaceDeclaration(Loc.initial, id(name), null);
}

describe("module load", () => {
    test("smoke: importing dmd.dclass executes its top level and exports the D symbols", () => {
        expect(typeof BaseClass).toBe("function");
        expect(typeof ClassDeclaration).toBe("function");
        expect(typeof InterfaceDeclaration).toBe("function");
        expect(ClassFlags.none).toBe(0x0);
        expect(ClassFlags.hasNameSig).toBe(0x200);
        // `OFFSET_FWDREF` (dclass.d:280) is file-private, so it is pinned through its observable
        // effect instead — see the InterfaceDeclaration.isBaseOf test below. Its former sibling
        // `OFFSET_RUNTIME` was deleted upstream in 1.43.0 final, so there is nothing left to pin.
    });
});

describe("BaseClass (dmd/dclass.d:36)", () => {
    test("the value ctor sets `type`; the no-arg birth leaves every field at its D .init", () => {
        const cd = cls("C");
        const b = new BaseClass(cd.type!);
        expect(b.type).toBe(cd.type);
        expect(b.sym).toBe(null);
        expect(b.offset).toBe(0);
        expect(b.vtbl.length).toBe(0);
        expect(b.baseInterfaces.length).toBe(0);

        const d = new BaseClass();
        expect(d.type).toBe(null); // dclass.d:38 — `Type type;` .init is null (09 §1.0)
        expect(d.vtbl.length).toBe(0);
    });

    test("copy() is a per-field value copy: class refs shared, vtbl a FRESH Array header", () => {
        const cd = cls("C");
        const a = new BaseClass(cd.type!);
        a.sym = cd;
        a.offset = 8;

        const c = a.copy();
        expect(c).not.toBe(a);
        expect(c.type).toBe(a.type); // class reference: shared (03 §2)
        expect(c.sym).toBe(a.sym);   // class reference: shared
        expect(c.offset).toBe(8);

        // The inline `Array!FuncDeclaration` member is an independent header after the copy —
        // D's struct copy duplicates ptr+length, so a push to one must not move the other.
        c.vtbl.push(null); // FuncDeclarations slots are nullable (08 §3)
        expect(c.vtbl.length).toBe(1);
        expect(a.vtbl.length).toBe(0);

        // Mutating the copy's own fields must not touch the source (03 §2 invariant).
        c.offset = 99;
        expect(a.offset).toBe(8);
    });

    test("copyBaseInterfaces overwrites the cells IN PLACE and pushes all but the first (dclass.d:56)", () => {
        // A `sym` whose `interfaces` holds three BaseClass pointers, each with an empty vtbl
        // (the state dclass.d:69 asserts) and no nested base interfaces.
        const sym = cls("Sym");
        const i0 = new BaseClass(); i0.sym = cls("I0"); i0.offset = 1;
        const i1 = new BaseClass(); i1.sym = cls("I1"); i1.offset = 2;
        const i2 = new BaseClass(); i2.sym = cls("I2"); i2.offset = 3;
        sym.interfaces = [i0, i1, i2];

        const owner = new BaseClass();
        owner.sym = sym;
        const vtblInterfaces: BaseClasses = new DArray<BaseClass | null>();
        owner.copyBaseInterfaces(vtblInterfaces);

        expect(owner.baseInterfaces.length).toBe(3);
        // Contents copied from sym.interfaces[i]...
        expect(owner.baseInterfaces.map((b) => b.offset)).toEqual([1, 2, 3]);
        expect(owner.baseInterfaces[0].sym).toBe(i0.sym);
        // ...into FRESH cells, never aliasing the source pointers.
        expect(owner.baseInterfaces[0]).not.toBe(i0);
        // `if (i) vtblInterfaces.push(b);` — single inheritance is i==0, so only 1 and 2.
        expect(vtblInterfaces.length).toBe(2);
        expect(vtblInterfaces.opIndex(0)).toBe(owner.baseInterfaces[1]);
        expect(vtblInterfaces.opIndex(1)).toBe(owner.baseInterfaces[2]);
    });
});

describe("ClassDeclaration (dmd/dclass.d:98)", () => {
    test("the ctor wires dsym/type/baseclasses/objc and leaves baseok at none", () => {
        const cd = cls("C");
        expect(cd.dsym).toBe(DSYM.classDeclaration);
        expect(cd.type).toBeInstanceOf(TypeClass);
        expect(cd.type!.isTypeClass()!.sym).toBe(cd);
        expect(cd.baseclasses.length).toBe(0); // dclass.d:170 — `new BaseClasses()`
        expect(cd.baseok).toBe(Baseok.none);
        expect(cd.objc.classDeclaration).toBe(cd); // dclass.d:154
        expect(cd.interfaces).toBe(null);          // D slice .init is null (09 §1.0)
        expect(cd.isBaseInfoComplete()).toBe(false);
    });

    test("a null `id` gets an anonymous one; kind()/vtblOffset()/COM+CPP predicates", () => {
        const anon = new ClassDeclaration(Loc.initial, null, null, null, false);
        expect(anon.ident).not.toBe(null); // dclass.d:157 — generateAnonymousId("class")

        const cd = cls("C");
        expect(dsToJs(cd.kind())).toBe("class");
        expect(cd.vtblOffset()).toBe(1);   // ClassKind.d -> 1
        expect(cd.hasMonitor()).toBe(true);
        expect(cd.isCOMclass()).toBe(false);
        expect(cd.isCOMinterface()).toBe(false);
        expect(cd.isCPPclass()).toBe(false);
        expect(cd.isCPPinterface()).toBe(false);

        cd.classKind = ClassKind.cpp;
        expect(cd.vtblOffset()).toBe(0);
        expect(cd.isCPPclass()).toBe(true);
        expect(cd.hasMonitor()).toBe(false);
        cd.com = true;
        expect(cd.isCOMclass()).toBe(true);
    });

    test("isBaseOf walks the baseClass chain and zeroes the poffset box (dclass.d:286)", () => {
        const base = cls("Base");
        const mid = cls("Mid");
        const leaf = cls("Leaf");
        mid.baseClass = base;
        leaf.baseClass = mid;
        // dclass.d:293 asserts every visited node is derived, semantically done, or an interface
        // (in a real compile only Object has no baseClass, and it is done by then). `base` is the
        // chain root here, so it must carry that state or the faithful assert fires.
        base.semanticRun = PASS.semanticdone;

        const poffset = { value: 42 };
        expect(base.isBaseOf(leaf, poffset)).toBe(true);
        expect(poffset.value).toBe(0); // reset on entry, never written again on this path
        expect(mid.isBaseOf(leaf, null)).toBe(true);
        expect(leaf.isBaseOf(base, null)).toBe(false);
        expect(base.isBaseOf(null, null)).toBe(false);
        // `this == cd.baseClass` is identity, so a class is not its OWN base here.
        expect(base.isBaseOf(base, null)).toBe(false);
    });

    test("isBaseOf2 walks baseclasses[] depth-first (dclass.d:266)", () => {
        const a = cls("A");
        const b = cls("B");
        const c = cls("C");
        const ba = new BaseClass(); ba.sym = a;
        const bb = new BaseClass(); bb.sym = b;
        b.baseclasses.push(ba); // B : A
        c.baseclasses.push(bb); // C : B

        expect(b.isBaseOf2(c)).toBe(true);  // direct
        expect(a.isBaseOf2(c)).toBe(true);  // indirect, through B
        expect(c.isBaseOf2(a)).toBe(false);
        expect(a.isBaseOf2(null)).toBe(false);
    });

    test("searchBase is depth-first left-to-right and bails on a non-class handle (dclass.d:320)", () => {
        const a = cls("A");
        const b = cls("B");
        const c = cls("C");
        b.baseclasses.push(new BaseClass(a.type!)); // B : A
        c.baseclasses.push(new BaseClass(b.type!)); // C : B

        expect(c.searchBase(id("B"))).toBe(b);
        expect(c.searchBase(id("A"))).toBe(a); // found through B's own baseclasses
        expect(c.searchBase(id("Z"))).toBe(null);
        expect(a.searchBase(id("A"))).toBe(null); // A has no bases at all
    });

    test("isBaseInfoComplete / isErrorException read the shared statics (dclass.d:306,:392)", () => {
        const cd = cls("C");
        cd.baseok = Baseok.done;
        expect(cd.isBaseInfoComplete()).toBe(true);
        // Chain roots must satisfy the dclass.d:293 assert (see the isBaseOf pin above).
        cd.semanticRun = PASS.semanticdone;

        const saved = ClassDeclaration.errorException;
        try {
            ClassDeclaration.errorException = null;
            expect(cd.isErrorException()).toBe(false);

            // NOT named "Error": that is one of dclass.d:217's reserved names, and building it
            // outside object.d is exactly the `classError` diagnostic path (dclass.d:189).
            const err = cls("MyError");
            err.semanticRun = PASS.semanticdone;
            ClassDeclaration.errorException = err;
            expect(err.isErrorException()).toBe(true); // `this == errorException`
            expect(cd.isErrorException()).toBe(false);
            cd.baseClass = err;
            expect(cd.isErrorException()).toBe(true);  // errorException.isBaseOf(this, null)
        } finally {
            ClassDeclaration.errorException = saved;
        }
    });

    test("toPrettyChars on a metaclass forwards to objc(): the metaclass prints as its class", () => {
        // D dispatch proof (10 §1.8 rule 5): dclass.d:235 `if (objc.isMeta) return .objc.
        // toPrettyChars(this, qualifyTypes);` — setting `isMeta` selects exactly that arm, and
        // `Supported.toPrettyChars` (objc.d:579) returns `classDeclaration.parent.toPrettyChars`.
        // The driver runs `Objc._init()` at startup (main.d:445); the fixed target installs `Supported`.
        Objc._init();
        try {
            const c = cls("C");
            const meta = cls("C_Meta");
            meta.parent = c as unknown as Dsymbol; // upcast cascade (02 §11.5)
            meta.objc.isMeta = true;
            expect(dsToJs(meta.toPrettyChars())).toBe(dsToJs(c.toPrettyChars()));
            // The fall-through arm is preserved verbatim and prints the metaclass's own name.
            meta.objc.isMeta = false;
            expect(dsToJs(meta.toPrettyChars())).toContain("C_Meta");
        } finally {
            Objc.deinitialize();
        }
    });
});

describe("InterfaceDeclaration (dmd/dclass.d:405)", () => {
    test("IUnknown is born COM + C++; kind()/vtblOffset() follow the overrides", () => {
        const plain = iface("I");
        expect(plain.dsym).toBe(DSYM.interfaceDeclaration);
        expect(dsToJs(plain.kind())).toBe("interface");
        expect(plain.com).toBe(false);
        expect(plain.classKind).toBe(ClassKind.d);
        expect(plain.vtblOffset()).toBe(1);
        expect(plain.isCOMinterface()).toBe(false);
        expect(plain.isCPPinterface()).toBe(false);

        const unk = new InterfaceDeclaration(Loc.initial, Id.IUnknown, null);
        expect(unk.com).toBe(true);
        expect(unk.classKind).toBe(ClassKind.cpp);
        expect(unk.isCOMinterface()).toBe(true);
        expect(unk.isCPPinterface()).toBe(true);
        expect(unk.vtblOffset()).toBe(0);
    });

    test("isBaseOf finds a direct interface and reports the offset per sizeok (dclass.d:437)", () => {
        const i = iface("I");
        const cd = cls("C");
        const b = new BaseClass();
        b.sym = i;
        b.offset = 16;
        cd.interfaces = [b];

        // sizeok != done -> OFFSET_FWDREF (don't return incorrect offsets, issue 16980). The
        // constant is file-private in the port (02 §4.1), so the literal from dclass.d:281 is what
        // is pinned here — a stronger pin than comparing the const against itself.
        const p1 = { value: -1 };
        expect(i.isBaseOf(cd, p1)).toBe(true);
        expect(p1.value).toBe(0x76543211); // dclass.d:281 — OFFSET_FWDREF

        cd.sizeok = Sizeok.done;
        const p2 = { value: -1 };
        expect(i.isBaseOf(cd, p2)).toBe(true);
        expect(p2.value).toBe(16);

        // Not implemented anywhere -> false, and the box is zeroed on the way out.
        const other = iface("J");
        const p3 = { value: -1 };
        expect(other.isBaseOf(cd, p3)).toBe(false);
        expect(p3.value).toBe(0);
    });

    test("isBaseOf walks baseClass and the indirect baseClassImplementsInterface path", () => {
        const i = iface("I");
        // `bc` implements `i` indirectly: bc.baseInterfaces[0].sym is i (dclass.d:515).
        const nested = new BaseClass();
        nested.sym = i;
        nested.offset = 24;
        const bc = new BaseClass();
        bc.sym = iface("Mid");
        bc.baseInterfaces = [nested];

        const cd = cls("C");
        cd.interfaces = [bc];
        const p = { value: -1 };
        expect(i.isBaseOf(cd, p)).toBe(true);
        expect(p.value).toBe(24);

        // Reached through the base CLASS chain: derived has no interfaces of its own.
        const derived = cls("D");
        derived.baseClass = cd;
        derived.interfaces = null; // a null slice iterates zero times, as in D
        expect(i.isBaseOf(derived, null)).toBe(true);

        // A class with neither interfaces nor a base is not implementing anything.
        expect(i.isBaseOf(cls("Empty"), null)).toBe(false);
    });
});
