// Structural goal tests for src/dmd/declaration.ts.
//
// dmd/declaration.d has NO in-source `unittest{}` blocks (verified: `grep -c '^unittest' = 0`), so
// this file takes the 10-tests-diagnostics.md §1.6b shape: one module-load smoke test plus a small
// set of behavior pins reachable with the EXISTING harness conventions. No new harness machinery,
// no fabricated pins for paths the harness cannot reach honestly (the TypeInfo* hierarchy faults on the
// unset `Type.dtypeinfo` without sema; see its describe block).
//
// Setup mirrors lexer.test.ts (10 §1.5): Loc._init() + initTokens() + Id.initialize() intern the
// predefined ids and reset the process-global Loc table, which the structural ctors
// (ThisDeclaration -> Id.This, etc.) rely on. ORDER: initTokens() first (see tokens.ts initTokens).

import { beforeEach, describe, expect, test } from "vitest";
import {
    AliasDeclaration,
    OverDeclaration,
    TupleDeclaration,
    VarDeclaration,
    BitFieldDeclaration,
    ThisDeclaration,
    TypeInfoStructDeclaration,
    MatchAccumulator,
    Declaration,
} from "./declaration.js";
import { Visibility, DSYM, PASS } from "./dsymbol.js";
import { STC, MATCH, LINK } from "./astenums.js";
import { Id } from "./id.js";
import { Loc } from "./location.js";
import { initTokens } from "./tokens.js";
import { Identifier } from "./identifier.js";
import { VoidInitializer } from "./init.js";
import { TypeError as TypeErrorNode, type Type } from "./mtype.js";
import { dsToJs } from "../dstring.js";

beforeEach(() => {
    Loc._init();
    initTokens(); // also runs Identifier.initTable
    Id.initialize();
});

function id(name: string): Identifier {
    return Identifier.idPool(Uint8Array.from(Array.from(name, (c) => c.charCodeAt(0))));
}

describe("module load smoke (§1.6b)", () => {
    test("importing dmd/declaration.ts executes its top level and exports the hierarchy", () => {
        // A load-order/cycle regression in this core-SCC module surfaces here as a
        // "cannot access before initialization" at import time.
        expect(typeof Declaration).toBe("function");
        expect(typeof VarDeclaration).toBe("function");
        expect(typeof TypeInfoStructDeclaration).toBe("function");
    });
});

describe("Declaration base ctor + structural accessors", () => {
    test("ctor sets visibility to undefined; kind() is 'declaration'", () => {
        // A VarDeclaration is the simplest concrete Declaration whose ctor we filled.
        const v = new VarDeclaration(Loc.initial, null, id("x"), new VoidInitializer(Loc.initial));
        // Declaration ctor initialized visibility = Visibility(undefined).
        expect(v.visibility).toBeInstanceOf(Visibility);
        expect(v.visibility.kind).toBe(Visibility.Kind.undefined);
        expect(v.visible().kind).toBe(Visibility.Kind.undefined);
        // VarDeclaration overrides kind() -> "variable"; the base default would be "declaration".
        expect(dsToJs(v.kind())).toBe("variable");
    });

    test("storage-class flag predicates read storage_class bits", () => {
        const v = new VarDeclaration(Loc.initial, null, id("y"), new VoidInitializer(Loc.initial),
            (STC.static_ | STC.const_) as STC);
        expect(v.isStatic()).toBe(true);
        expect(v.isConst()).toBe(true);
        expect(v.isImmutable()).toBe(false);
        expect(v.isFinal()).toBe(false);
        // base Declaration defaults that VarDeclaration does NOT override
        expect(v.isCodeseg()).toBe(false);
        expect(v.isDelete()).toBe(false);
    });

    // Pins the OBSERVABLE consequence of the resolved bit-field layout of
    // `mixin(generateBitFields!(BitFields, ubyte))` (declaration.d:84): `_linkage` gets its own
    // 3-bit slice (LINK.max == system == 6) and the five bools get one bit each, so writing any one
    // member must leave every other member untouched. The packed word itself is `private` in D
    // (common/bitfields.d:117) and in the port (01 §2.5), and no D code reads it — so the pin goes
    // through the generated accessors, which is exactly the surface D exposes.
    test("Declaration bit-fields do not cross-talk (generated getter/setter pairs)", () => {
        const v = new VarDeclaration(Loc.initial, null, id("bf"), new VoidInitializer(Loc.initial));
        // generated init value: LINK.default_ + all-false
        expect(v._linkage).toBe(LINK.default_);
        expect([v.wasRead, v.ignoreRead, v.noUnderscore, v.hidden, v.nrvo]).toEqual(
            [false, false, false, false, false]);
        // the widest linkage value must not spill out of its 3-bit slice into `wasRead` (bit 3)
        v._linkage = LINK.system;               // 6 — LINK.max, the value that sizes the slice
        expect(v._linkage).toBe(LINK.system);
        expect([v.wasRead, v.ignoreRead, v.noUnderscore, v.hidden, v.nrvo]).toEqual(
            [false, false, false, false, false]);
        v._linkage = LINK.objc;
        v.wasRead = true;
        v.nrvo = true;                          // the last member of the group
        expect(v._linkage).toBe(LINK.objc);     // no cross-talk into the linkage field
        expect([v.wasRead, v.ignoreRead, v.noUnderscore, v.hidden, v.nrvo]).toEqual(
            [true, false, false, false, true]);
        v._linkage = LINK.default_;
        expect([v.wasRead, v.nrvo]).toEqual([true, true]);
    });

    // The VarDeclaration group is a SEPARATE `uint` word (D shadows the name `bitFields`; the port
    // names the derived one `varBitFields`). This pins that the two words do not share storage.
    test("VarDeclaration bit-fields live in their own word, disjoint from Declaration's", () => {
        const v = new VarDeclaration(Loc.initial, null, id("bv"), new VoidInitializer(Loc.initial));
        v._linkage = LINK.objc;
        v.wasRead = true;
        v.isargptr = true;                      // first member of the VarDeclaration group
        v.systemInferred = true;                // last member of the VarDeclaration group
        // Declaration's word untouched by the VarDeclaration writes...
        expect(v._linkage).toBe(LINK.objc);
        expect(v.wasRead).toBe(true);
        expect([v.ignoreRead, v.noUnderscore, v.hidden, v.nrvo]).toEqual([false, false, false, false]);
        // ...and the VarDeclaration members hold only what was written to them.
        expect([v.isargptr, v.systemInferred]).toEqual([true, true]);
        expect([v.ctorinit, v.iscatchvar, v.isowner, v.setInCtorOnly, v.onstack,
                v.onstackWithMatchingDynType, v.overlapped, v.overlapUnsafe, v.maybeScope,
                v.doNotInferReturn, v.isArgDtorVar, v.isCmacro, v.dllImport, v.dllExport]).toEqual(
            [false, false, false, false, false, false, false, false, false, false, false, false,
             false, false]);
    });

    // declaration.d:109-111 — the non-`system` linkage returns verbatim; `LINK.system` resolves through
    // `target.systemLinkage()`, reached through declaration.ts's `dmd.target` registration slot (01 §4.4).
    // This file's static imports do not reach target.js, so the slot starts EMPTY (its ORDER CONTRACT)
    // and the call raises the load-order error; loading target.js (10 §1.5) fills it. ldc2 1.43.0 oracle:
    // `extern(System) void sysf(); pragma(msg, typeof(&sysf));` prints `extern (C) void function()` on
    // arm64-apple-darwin, so the resolved linkage is LINK.c.
    test("resolvedLinkage returns the stored linkage; LINK.system resolves to LINK.c once target.js is loaded",
        async () => {
        const v = new VarDeclaration(Loc.initial, null, id("rl"), new VoidInitializer(Loc.initial));
        v._linkage = LINK.c;
        expect(v.resolvedLinkage()).toBe(LINK.c);
        v._linkage = LINK.system;
        expect(() => v.resolvedLinkage())
            .toThrow("declaration.resolvedLinkage: registerTarget not called (dmd/declaration.d:111)");
        await import("./target.js");
        expect(v.resolvedLinkage()).toBe(LINK.c);
    });
});

describe("VarDeclaration ctor (declaration.d:490)", () => {
    test("assigns type/init/storage_class and AdrOnStackNone; needThis follows isField", () => {
        const init = new VoidInitializer(Loc.initial);
        const v = new VarDeclaration(Loc.initial, null, id("v"), init, STC.field as STC);
        expect(v._init).toBe(init);
        expect(v.ctfeAdrOnStack).toBe(VarDeclaration.AdrOnStackNone);
        expect(v.dsym).toBe(DSYM.varDeclaration);
        expect(v.isField()).toBe(true);
        expect(v.needThis()).toBe(true); // a field needs `this`
        expect(v.isCtorinit()).toBe(false);
        expect(v.canTakeAddressOf()).toBe(true);
        expect(v.needsScopeDtor()).toBe(false); // edtor is null
        // `structalign_t alignment;` / `FuncDeclarations nestedrefs;` are VALUE fields: default
        // constructed, never undefined (09 §1.0).
        expect(v.alignment.isUnknown()).toBe(true);
        expect(v.nestedrefs.length).toBe(0);
    });

    test("create() factory mirrors the ctor", () => {
        const v = VarDeclaration.create(Loc.initial, null, id("c"), new VoidInitializer(Loc.initial));
        expect(v).toBeInstanceOf(VarDeclaration);
        expect(v.dsym).toBe(DSYM.varDeclaration);
    });

    test("isExport reflects export visibility / dllExport", () => {
        const v = new VarDeclaration(Loc.initial, null, id("e"), new VoidInitializer(Loc.initial));
        expect(v.isExport()).toBe(false);
        v.visibility = new Visibility(Visibility.Kind.export_);
        expect(v.isExport()).toBe(true);
    });

    // declaration.d:508 — `assert(type || _init)` fires when both are absent.
    test("ctor asserts type || _init", () => {
        expect(() => new VarDeclaration(Loc.initial, null, id("bad"), null)).toThrow();
    });
});

describe("AliasDeclaration Form-B ctor pair -> named static factories (04 §1B)", () => {
    test("fromType sets type; kind()='alias'; isOverloadable pre-semantic", () => {
        const t: Type = new TypeErrorNode();
        const a = AliasDeclaration.fromType(Loc.initial, id("A"), t);
        expect(a.type).toBe(t);
        expect(a.aliassym).toBeNull();
        expect(dsToJs(a.kind())).toBe("alias");
        expect(a.dsym).toBe(DSYM.aliasDeclaration);
        // pre-semantic -> assume overloadable
        expect(a.semanticRun < PASS.semanticdone).toBe(true);
        expect(a.isOverloadable()).toBe(true);
    });

    test("fromDsymbol sets aliassym, leaves type null", () => {
        const inner = new OverDeclaration(id("inner"), null); // any Dsymbol
        const a = AliasDeclaration.fromDsymbol(Loc.initial, id("B"), inner);
        expect(a.aliassym).toBe(inner);
        expect(a.type).toBeNull();
    });

    test("isAliasedTemplateParameter reads the STC bit", () => {
        const a = AliasDeclaration.fromType(Loc.initial, id("T"), new TypeErrorNode());
        expect(a.isAliasedTemplateParameter()).toBe(false);
        a.storage_class = STC.templateparameter as STC;
        expect(a.isAliasedTemplateParameter()).toBe(true);
    });

    test("create() delegates to fromType (declaration.d:360)", () => {
        const a = AliasDeclaration.create(Loc.initial, id("C"), new TypeErrorNode());
        expect(a).toBeInstanceOf(AliasDeclaration);
        expect(a.aliassym).toBeNull();
    });
});

describe("TupleDeclaration / OverDeclaration ctors + kind()", () => {
    test("TupleDeclaration tags + kind()='sequence'", () => {
        const td = new TupleDeclaration(Loc.initial, id("seq"), null);
        expect(td.dsym).toBe(DSYM.tupleDeclaration);
        expect(dsToJs(td.kind())).toBe("sequence");
        expect(td.objects).toBeNull();
    });

    // declaration.d:279 — `isexp == false` short-circuits before foreachVar's `assert(isexp)`.
    test("needThis() is false for a non-expression tuple (no objects walk)", () => {
        const td = new TupleDeclaration(Loc.initial, id("seq2"), null);
        expect(td.isexp).toBe(false);
        expect(td.needThis()).toBe(false);
    });

    // declaration.d:290/:316 — both foreachVar forms open with `assert(isexp)`.
    test("foreachVar asserts isexp", () => {
        const td = new TupleDeclaration(Loc.initial, id("seq3"), null);
        expect(() => td.foreachVar(() => {})).toThrow();
        expect(() => td.foreachVarFromIntDelegate(() => 0)).toThrow();
    });

    test("OverDeclaration tags + kind()='overload alias' + isOverloadable", () => {
        const od = new OverDeclaration(id("ov"), null);
        expect(od.dsym).toBe(DSYM.overDeclaration);
        expect(dsToJs(od.kind())).toBe("overload alias");
        expect(od.isOverloadable()).toBe(true);
        // `this(DSYM tag, Identifier ident)` -> no loc, so Dsymbol's ctor stores Loc.initial.
        expect(od.ident).toBe(id("ov"));
    });
});

describe("BitFieldDeclaration / ThisDeclaration ctors", () => {
    test("BitFieldDeclaration retags, ORs STC.field, keeps width", () => {
        // A BitFieldDeclaration defaults `_init` to null, so its `type` must be non-null
        // (VarDeclaration's `assert(type || _init)` would otherwise fire — faithful D).
        // `width` is an Expression; null is fine here since we don't exercise syntaxCopy.
        const bf = new BitFieldDeclaration(Loc.initial, new TypeErrorNode(), id("bf"), null as never);
        expect(bf.dsym).toBe(DSYM.bitFieldDeclaration);
        expect((bf.storage_class & STC.field) !== 0n).toBe(true);
        expect(bf.isField()).toBe(true);
        expect(bf.fieldWidth).toBe(0);
        expect(bf.bitOffset).toBe(0);
    });

    test("ThisDeclaration uses Id.This, retags, ORs STC.nodtor", () => {
        const t: Type = new TypeErrorNode();
        const td = new ThisDeclaration(Loc.initial, t);
        expect(td.dsym).toBe(DSYM.thisDeclaration);
        expect(td.ident).toBe(Id.This);
        expect((td.storage_class & STC.nodtor) !== 0n).toBe(true);
        // declaration.d:1219 — `syntaxCopy` is `assert(0)`.
        expect(() => td.syntaxCopy(null)).toThrow();
    });
});

// Not a pinned wall: the TypeInfo hierarchy carries no wall. The TypeInfo constructor's very first
// statement is `super(Loc.initial, Type.dtypeinfo.type, …)`, and `Type.dtypeinfo` is only assigned
// when semantic analysis reads druntime's `object.d`. With no sema in this harness it is unset, so
// construction faults on it — the same null dereference D performs. Everything past that point
// (including `alignment.set(...)`, declaration.d:784) is unreachable from here; do not fabricate a
// pin for it. Re-pin if the fault point moves.
describe("TypeInfoDeclaration ctor is unreachable without sema (declaration.d:778)", () => {
    test("constructing a TypeInfo declaration faults on the unset Type.dtypeinfo", () => {
        expect(() => TypeInfoStructDeclaration.create(new TypeErrorNode())).toThrow();
    });
});

describe("MatchAccumulator.copy() (value struct, 03 §2)", () => {
    test("copy is independent for primitives, shared for class refs", () => {
        const m = new MatchAccumulator();
        m.count = 3;
        m.last = MATCH.exact;
        const c = m.copy();
        expect(c.count).toBe(3);
        expect(c.last).toBe(MATCH.exact);
        m.count = 99;
        expect(c.count).toBe(3); // primitive copy is independent
    });

    test(".init values match the D declaration (09 §1.0)", () => {
        const m = new MatchAccumulator();
        expect(m.count).toBe(0);
        expect(m.last).toBe(MATCH.nomatch); // declared initializer wins over the enum's first member
        expect(m.lastf).toBeNull();
        expect(m.nextf).toBeNull();
    });
});
