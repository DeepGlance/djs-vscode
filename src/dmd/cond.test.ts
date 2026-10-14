// Goal tests for src/dmd/cond.ts.
//
// dmd/cond.d has NO in-source `unittest{}` blocks (the only "unittest" token in it is the
// `case "unittest":` reserved-version label), so this is a GOAL test, not a ported unittest
// (10-tests-diagnostics.md §1). It protects three things the translation of cond.d achieves:
//   1. the module LOADS — cond.ts newly takes VALUE imports on the core SCC (mtype/expression/
//      declaration/func/dstruct/statement); a load-time cycle would surface here as a
//      "cannot access ... before initialization" and fail every test in the file (01 §4.1);
//   2. the visitor double-dispatch of each node's `accept` (13-visitor.md §2);
//   3. the two pieces of real logic in the file: `VersionCondition.isReserved`'s content-compared
//      switch (cond.d:342) and `findCondition`'s interned-identity search (cond.d:603).
//
// Setup mirrors declaration.test.ts (10 §1.5) and the ORDER CONTRACT of 01 §5.2: Loc._init() then
// initTokens() (which also runs Identifier.initTable) then Id.initialize() — initTokens re-creates
// the interning table, so running Id.initialize() first would orphan every Id.* singleton.

import { beforeEach, describe, expect, test } from "vitest";
import {
    Condition,
    DVCondition,
    DebugCondition,
    Include,
    StaticIfCondition,
    VersionCondition,
    findCondition,
} from "./cond.js";
import { Array as Array_ } from "./root/array.js";
import { DYNCAST } from "./rootobject.js";
import { Id } from "./id.js";
import { Loc } from "./location.js";
import { initTokens } from "./tokens.js";
import { Identifier } from "./identifier.js";
import { global } from "./globals.js";
import { SemanticTimePermissiveVisitor } from "./visitor/index.js";
import { ds } from "../dstring.js";

beforeEach(() => {
    Loc._init();
    initTokens(); // also runs Identifier.initTable
    Id.initialize();
});

describe("cond.ts — module load + node shape", () => {
    test("module loads and the Include enum keeps its declaration order (cond.d:42)", () => {
        // A successful import of every value symbol is itself the smoke test: cond.ts value-imports
        // mtype/expression/declaration/func/dstruct/statement, so a load cycle would throw here.
        expect(Include.notComputed).toBe(0);
        expect(Include.yes).toBe(1);
        expect(Include.no).toBe(2);
    });

    test("dyncast is DYNCAST.condition and inc defaults to notComputed (cond.d:53/55)", () => {
        const c = new DebugCondition(Loc.initial, null, Identifier.idPool(ds("Foo")));
        expect(c.dyncast()).toBe(DYNCAST.condition);
        expect(c.inc).toBe(Include.notComputed); // D `Include inc;` -> .init = FIRST member (09 §1.0)
    });

    test("isXxxCondition() downcast hooks: only the matching subclass returns itself (cond.d:67-80)", () => {
        const dc = new DebugCondition(Loc.initial, null, Identifier.idPool(ds("Foo")));
        const vc = new VersionCondition(Loc.initial, null, Identifier.idPool(ds("Foo")));
        const sc: Condition = new StaticIfCondition(Loc.initial, null);

        expect(dc.isDebugCondition()).toBe(dc);
        expect(dc.isVersionCondition()).toBeNull();
        expect(dc.isStaticIfCondition()).toBeNull();

        expect(vc.isVersionCondition()).toBe(vc);
        expect(vc.isDebugCondition()).toBeNull();

        expect(sc.isStaticIfCondition()).toBe(sc);
        expect(sc.isDebugCondition()).toBeNull();
    });

    test("DVCondition.syntaxCopy returns THIS, not a clone (cond.d:249 'don't need to copy')", () => {
        const dc: DVCondition = new DebugCondition(Loc.initial, null, Identifier.idPool(ds("Foo")));
        expect(dc.syntaxCopy()).toBe(dc);
    });

    test("accept dispatches to the node's OWN named visit method (13-visitor.md §2)", () => {
        const seen: string[] = [];
        // A local recording visitor — no new harness machinery, just an override of the two named
        // methods cond.d's nodes dispatch to.
        class Rec extends SemanticTimePermissiveVisitor {
            override visitDebugCondition(c: DebugCondition): void { seen.push("debug"); void c; }
            override visitVersionCondition(c: VersionCondition): void { seen.push("version"); void c; }
        }
        const v = new Rec();
        new DebugCondition(Loc.initial, null, Identifier.idPool(ds("Foo"))).accept(v);
        new VersionCondition(Loc.initial, null, Identifier.idPool(ds("Foo"))).accept(v);
        expect(seen).toEqual(["debug", "version"]);
    });
});

describe("VersionCondition.isReserved (cond.d:342) — content compare, D_ prefix default arm", () => {
    test("listed identifiers are reserved", () => {
        for (const name of ["AArch64", "all", "linux", "Posix", "unittest", "X86_64", "none"])
            expect(VersionCondition.isReserved(ds(name))).toBe(true);
    });

    test("the default arm reserves anything starting with D_ (cond.d:460)", () => {
        expect(VersionCondition.isReserved(ds("D_"))).toBe(true);
        expect(VersionCondition.isReserved(ds("D_InlineAsm_X86"))).toBe(true);
        // Length guard: fewer than two bytes can never match the prefix.
        expect(VersionCondition.isReserved(ds("D"))).toBe(false);
        expect(VersionCondition.isReserved(ds(""))).toBe(false);
    });

    test("unlisted / near-miss identifiers are not reserved (byte-exact compare)", () => {
        expect(VersionCondition.isReserved(ds("MyFeature"))).toBe(false);
        expect(VersionCondition.isReserved(ds("Linux"))).toBe(false);   // case-sensitive vs "linux"
        expect(VersionCondition.isReserved(ds("linux2"))).toBe(false);  // length-sensitive
        expect(VersionCondition.isReserved(ds("Dx"))).toBe(false);      // 'D' but not "D_"
    });

    // Pins the property the `keyOf`-keyed switch rests on (see cond.ts:isReserved): the key is an
    // INJECTIVE byte->code-unit encoding, so JS string equality IS D's byte equality. A UTF-8
    // decode (`dsToJs`) would not be injective over these inputs, and a NUL-stopping compare would
    // change which byte sequences match — D's `switch (const(char)[])` does neither.
    test("the switch is byte-exact: NUL bytes and bytes >= 0x80 neither match nor throw", () => {
        // A C-string VIEW of "linux" keeps its terminator inside the slice (02 §11); those are six
        // bytes, not five, so D's content-compared switch would miss it and so must the port.
        expect(VersionCondition.isReserved(new Uint8Array([0x6c, 0x69, 0x6e, 0x75, 0x78, 0x00]))).toBe(false);
        // Not a valid UTF-8 sequence: `keyOf` still maps each byte to its own code unit.
        expect(VersionCondition.isReserved(new Uint8Array([0xff, 0xfe]))).toBe(false);
        // The default arm looks only at the first two bytes (cond.d:460), whatever follows them.
        expect(VersionCondition.isReserved(new Uint8Array([0x44, 0x5f, 0xff]))).toBe(true);   // "D_" + 0xFF
    });
});

describe("findCondition (cond.d:603) + addGlobalIdent (cond.d:289/536)", () => {
    test("finds an interned identifier by reference identity, misses an absent one", () => {
        const a = Identifier.idPool(ds("Alpha"));
        const b = Identifier.idPool(ds("Beta"));
        const ids = new Array_<Identifier | null>();
        ids.push(a);
        expect(findCondition(ids, a)).toBe(true);
        // idPool interns, so a fresh lookup of the same bytes IS the same object.
        expect(findCondition(ids, Identifier.idPool(ds("Alpha")))).toBe(true);
        expect(findCondition(ids, b)).toBe(false);
        expect(findCondition(new Array_<Identifier | null>(), a)).toBe(false);
    });

    test("addGlobalIdent pushes the interned ident onto the matching global list", () => {
        const dbgBefore = global.debugids.length;
        DebugCondition.addGlobalIdent(ds("MyDebugTag"));
        expect(global.debugids.length).toBe(dbgBefore + 1);
        expect(global.debugids.opIndex(dbgBefore)).toBe(Identifier.idPool(ds("MyDebugTag")));

        const verBefore = global.versionids.length;
        // addPredefinedGlobalIdent skips checkReserved, so a reserved name lands with no diagnostic.
        VersionCondition.addPredefinedGlobalIdent(ds("Posix"));
        expect(global.versionids.length).toBe(verBefore + 1);
        expect(global.versionids.opIndex(verBefore)).toBe(Identifier.idPool(ds("Posix")));
    });
});
