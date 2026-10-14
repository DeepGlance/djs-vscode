// Co-located tests for src/dmd/init.ts (dmd/init.d).
//
// `dmd/init.d` contains ZERO in-source `unittest` blocks (verified: `grep -c '^unittest'` on
// dmd/init.d returns 0), so per 10-tests-diagnostics.md §1.6b this file is the thin test
// file: one module-load smoke test plus a small set of behaviour pins that the EXISTING
// harness conventions construct honestly. No new harness machinery is built here.
//
// Every pin is Type-free: the `Initializer` hierarchy needs only `Loc` and (for the one pin that
// wants a real `Expression`) a `NullExp`, which the tree already constructs without `Type._init()`
// (precedent: expression.test.ts "pins that need no Type").

import { describe, it, expect, beforeEach } from "vitest";
import { Loc } from "./location.js";
import { initTokens, TOK } from "./tokens.js";
import { Identifier } from "./identifier.js";
import { ds } from "../dstring.js";
import { InitKind } from "./astenums.js";
import { DYNCAST } from "./rootobject.js";
import { NullExp } from "./expression.js";
import {
    NeedInterpret,
    INITnointerpret,
    INITinterpret,
    Initializer,
    VoidInitializer,
    DefaultInitializer,
    ErrorInitializer,
    StructInitializer,
    ArrayInitializer,
    ExpInitializer,
    Designator,
    DesigInit,
    CInitializer,
    syntaxCopy,
} from "./init.js";

const loc = Loc.initial;

beforeEach(() => {
    // 10 §1.5 — the canonical init snippet, in the ORDER contract of 01 §5.2. Only the two
    // entries these pins can reach are needed (no Id/Type: nothing here touches them).
    Loc._init();
    initTokens();
});

describe("init.d — module load", () => {
    it("module loads and its top-level state evaluates", () => {
        // Importing the module already executed its top level; these reads catch a load-order /
        // import-cycle regression at the earliest possible point.
        expect(NeedInterpret.INITnointerpret).toBe(0);
        expect(NeedInterpret.INITinterpret).toBe(1);
        // init.d:32-33 — the two module-level member aliases.
        expect(INITnointerpret).toBe(NeedInterpret.INITnointerpret);
        expect(INITinterpret).toBe(NeedInterpret.INITinterpret);
    });
});

describe("init.d — the InitKind tag and the isXxxInitializer downcasts (init.d:40, :55-89)", () => {
    it("every node carries its own InitKind and answers DYNCAST.initializer", () => {
        const nodes: [Initializer, InitKind][] = [
            [new VoidInitializer(loc), InitKind.void_],
            [new DefaultInitializer(loc), InitKind.default_],
            [new ErrorInitializer(), InitKind.error],
            [new StructInitializer(loc), InitKind.struct_],
            [new ArrayInitializer(loc), InitKind.array],
            [new ExpInitializer(loc, null), InitKind.exp],
            [new CInitializer(loc), InitKind.C_],
        ];
        for (const [node, kind] of nodes) {
            expect(node.kind).toBe(kind);
            expect(node.dyncast()).toBe(DYNCAST.initializer);
            expect(node.semanticDone).toBe(false); // init.d:41 — declared default
        }
    });

    it("isXxxInitializer() returns `this` on a tag match and null otherwise", () => {
        const vi = new VoidInitializer(loc);
        expect(vi.isVoidInitializer()).toBe(vi);
        expect(vi.isExpInitializer()).toBeNull();
        expect(vi.isCInitializer()).toBeNull();

        const ei = new ExpInitializer(loc, null);
        expect(ei.isExpInitializer()).toBe(ei);
        expect(ei.isVoidInitializer()).toBeNull();

        const err = new ErrorInitializer();
        expect(err.isErrorInitializer()).toBe(err);
        // init.d:138 — `super(Loc.initial, InitKind.error)`. D copies the VALUE of the
        // `static immutable Loc initial` into the field, so only EQUALITY is D-observable;
        // `toBe` would instead pin reference identity with the singleton, i.e. certify the
        // 03 §9.1 share as behaviour and break the moment anyone adds the elidable `.copy()`
        // back (location.ts:63 explicitly licenses `Loc.initial.copy()` for an owned default).
        expect(err.loc.opEquals(Loc.initial)).toBe(true);
    });
});

describe("init.d — addInit / isAssociativeArray (init.d:159, :187, :195)", () => {
    it("StructInitializer.addInit appends to the parallel arrays and accepts a null field name", () => {
        const si = new StructInitializer(loc);
        const a = new VoidInitializer(loc);
        const b = new VoidInitializer(loc);
        // parse.d's positional (un-named) element passes a null Identifier — the parameter is
        // `Identifier | null` precisely so this call needs no cast.
        si.addInit(null, a);
        si.addInit(null, b);
        expect(si.field.length).toBe(2);
        expect(si.value.length).toBe(2);
        expect(si.field.opIndex(0)).toBeNull();
        expect(si.value.opIndex(1)).toBe(b);
    });

    it("ArrayInitializer.addInit resets dim/type, and isAssociativeArray reads the index slots", () => {
        const ai = new ArrayInitializer(loc);
        ai.dim = 7;
        // a plain element: no `[expr]:` designator -> a null index slot
        ai.addInit(null, new VoidInitializer(loc));
        expect(ai.dim).toBe(0); // init.d:191-192 — appending invalidates the resolved shape
        expect(ai.type).toBeNull();
        expect(ai.isAssociativeArray()).toBe(false);

        // a `[expr]: value` element: a non-null index slot flips the answer
        ai.addInit(new NullExp(loc), new VoidInitializer(loc));
        expect(ai.isAssociativeArray()).toBe(true);
    });
});

describe("init.d — syntaxCopy (init.d:278) dispatches on kind and deep-copies children", () => {
    it("Void/Default produce a FRESH node of the same kind; Error returns ITSELF", () => {
        const vi = new VoidInitializer(loc);
        const viCopy = syntaxCopy(vi);
        expect(viCopy).not.toBe(vi);
        expect(viCopy!.kind).toBe(InitKind.void_);

        const di = new DefaultInitializer(loc);
        const diCopy = syntaxCopy(di);
        expect(diCopy).not.toBe(di);
        expect(diCopy!.kind).toBe(InitKind.default_);

        // init.d:290-293 — `visitError` returns `vi` unchanged; identity is the observable contract.
        const err = new ErrorInitializer();
        expect(syntaxCopy(err)).toBe(err);
    });

    it("StructInitializer copies the parallel arrays: field refs SHARED, value nodes FRESH", () => {
        const si = new StructInitializer(loc);
        const child = new VoidInitializer(loc);
        si.addInit(null, child);
        const copy = syntaxCopy(si)!.isStructInitializer()!; // downcast via the production tag accessor

        expect(copy).not.toBe(si);
        expect(copy.field.length).toBe(1);
        expect(copy.value.length).toBe(1);
        expect(copy.field.opIndex(0)).toBeNull(); // shared verbatim (here: the null field name)
        expect(copy.value.opIndex(0)).not.toBe(child); // deep-copied
        expect(copy.value.opIndex(0)!.kind).toBe(InitKind.void_);
    });

    it("ArrayInitializer copies a null index slot as null and a real one through Expression.syntaxCopy", () => {
        const ai = new ArrayInitializer(loc);
        const idx = new NullExp(loc);
        ai.addInit(null, new VoidInitializer(loc)); // plain element -> null index
        ai.addInit(idx, new VoidInitializer(loc)); // designated element -> copied index
        const copy = syntaxCopy(ai)!.isArrayInitializer()!;

        expect(copy.index.length).toBe(2);
        expect(copy.value.length).toBe(2);
        expect(copy.index.opIndex(0)).toBeNull(); // init.d:322 — the null arm stores null
        expect(copy.index.opIndex(1)).not.toBe(idx); // the non-null arm copies the Expression
        expect(copy.value.opIndex(1)!.kind).toBe(InitKind.void_);
    });

    it("ExpInitializer copies the wrapped Expression (init.d:295)", () => {
        const e = new NullExp(loc);
        const ei = new ExpInitializer(loc, e);
        const copy = syntaxCopy(ei)!.isExpInitializer()!;
        expect(copy).not.toBe(ei);
        expect(copy.exp).not.toBe(e);
        expect(copy.exp!.op).toBe(e.op);
    });

    it("CInitializer with an EMPTY initializer-list copies to a fresh empty node (init.d:328)", () => {
        // The empty list is the only shape `visitC` copies cleanly: with a NON-empty list the D
        // source reads back the freshly-setDim'd DESTINATION slot (init.d:334-335 both index `ci`)
        // and then dereferences it, which faults in D in every configuration — see the verified
        // breakdown on `visitC` in init.ts. Here the same input throws too (the slot is a JS hole),
        // on a different operation. Nothing in the in-scope frontend builds one: `CInitializer`
        // bodies come from the excluded ImportC parser.
        const ci = new CInitializer(loc);
        const copy = syntaxCopy(ci)!.isCInitializer()!;
        expect(copy).not.toBe(ci);
        expect(copy.kind).toBe(InitKind.C_);
        expect(copy.initializerList.length).toBe(0);
    });
});

describe("init.d — Designator / DesigInit value structs (init.d:233, :245)", () => {
    it("the zero-arg constructor is D's default-init; the two factories set one field each", () => {
        const d = new Designator(); // D `Designator d;` -> both fields .init (null)
        expect(d.exp).toBeNull();
        expect(d.ident).toBeNull();

        // init.d:238-239 — two same-arity ctors distinguished only by parameter TYPE, promoted to
        // named factories keyed to that type (04 §1.1(c)); each sets one field, the other keeps
        // its `.init`.
        const e = new NullExp(loc);
        const fromExpression = Designator.fromExpression(e);
        expect(fromExpression.exp).toBe(e);
        expect(fromExpression.ident).toBeNull();

        const id = new Identifier(ds("f"), TOK.identifier);
        const fromIdentifier = Designator.fromIdentifier(id);
        expect(fromIdentifier.ident).toBe(id);
        expect(fromIdentifier.exp).toBeNull();
    });

    it(".copy() is a per-field shallow copy: a fresh object sharing both references", () => {
        const e = new NullExp(loc);
        const d = Designator.fromExpression(e);
        const dc = d.copy();
        expect(dc).not.toBe(d);
        expect(dc.exp).toBe(e); // class reference: SHARED (03 §2)

        const di = new DesigInit();
        expect(di.designatorList).toBeNull();
        expect(di.initializer).toBeNull();
        di.initializer = new VoidInitializer(loc);
        const dic = di.copy();
        expect(dic).not.toBe(di);
        expect(dic.initializer).toBe(di.initializer); // class reference: SHARED
    });
});
