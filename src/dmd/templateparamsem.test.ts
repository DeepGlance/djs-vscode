// Tests for src/dmd/templateparamsem.ts (port of dmd/templateparamsem.d).
//
// dmd/templateparamsem.d carries ZERO `unittest` blocks, so this file takes the 10 §1.6b shape: one
// module-load smoke test plus one behavior pin per risky RESOLVED construct. The risky constructs
// here are (a) the Idiom-A visit-method renaming + `accept` routing (13 §1/§2), (b) the
// `visit(cast(TemplateTypeParameter)ttp)` base-forward of the `this`-parameter (13 §4), (c) the
// `reliesOnTident` / `ctfeInterpret` legs (:64, :124, :166, :169), and (d) `aliasParameterSemantic`'s
// null / plain-type arms.
//
// Every expected value is read off the D source (dmd/templateparamsem.d:39-201), never off the TS.
// The :64/:124/:169 pins pass a NON-null `parameters`: `reliesOnTident` dereferences it
// (dmd/templatesem.d:75), so a null there is a D fault, not a path.

import { describe, test, expect, beforeEach } from "vitest";

import { tpsemantic, aliasParameterSemantic } from "./templateparamsem.js";
import {
    TemplateTypeParameter,
    TemplateThisParameter,
    TemplateValueParameter,
    TemplateAliasParameter,
    TemplateTupleParameter,
} from "./dtemplate.js";
import { Scope } from "./dscope.js";
import { Type } from "./mtype.js";
import { Loc } from "./location.js";
import { IntegerExp } from "./expression.js";
import { global } from "./globals.js";
import { ErrorSinkNull } from "./errorsink.js";
import type { TemplateParameter } from "./dtemplate.js";
import type { TemplateParameters } from "./arraytypes.js";
import { Array as DArray } from "./root/array.js";
import { Type_init } from "./typesem.js";

function freshScope(): Scope {
    // dscope.test.ts precedent: a bare `new Scope()` needs no init snippet. Its `scopesym` chain is
    // empty, so `getStructClassScope()` answers null — the "outside an aggregate type" state.
    return new Scope();
}

beforeEach(() => {
    Loc._init();
    Type_init();
    // `error(...)` reads global.errorSink and bumps global.errors.
    global.errorSink = new ErrorSinkNull();
    global.errors = 0;
    global.gag = 0;
});

describe("templateparamsem module load", () => {
    test("smoke: the module loads and exports the two D free functions", () => {
        expect(typeof tpsemantic).toBe("function");
        expect(typeof aliasParameterSemantic).toBe("function");
    });
});

describe("tpsemantic dispatch (13 §1 named methods + §2 accept routing)", () => {
    test("TemplateTupleParameter -> result = true (dmd/templateparamsem.d:138-141)", () => {
        const tp = new TemplateTupleParameter(Loc.initial, null);
        expect(tpsemantic(tp, freshScope(), null)).toBe(true);
    });

    test("TemplateTypeParameter with no specialization -> true, specType untouched (d:61-77)", () => {
        // `ttp.specType` is null, so D short-circuits BEFORE reliesOnTident and
        // `result = !(null && isError(null))` is true.
        const tp = new TemplateTypeParameter(Loc.initial, null, null, null);
        expect(tpsemantic(tp, freshScope(), null)).toBe(true);
        expect(tp.specType).toBe(null);
    });

    test("TemplateValueParameter runs typeSemantic on valType (d:88-90,119)", () => {
        // typeSemantic on an already-canonical basic type returns the interned singleton
        // (typesem.basic.test.ts pin), and isError(int) is false -> result true.
        const tp = new TemplateValueParameter(Loc.initial, null, Type.tint32, null, null);
        expect(tpsemantic(tp, freshScope(), null)).toBe(true);
        expect(tp.valType).toBe(Type.tint32);
    });

    test("TemplateValueParameter with an errored valType -> result false (d:119)", () => {
        // `result = !isError(tvp.valType)`; isError(Terror) is true (dmd/dtemplate.d:143).
        const tp = new TemplateValueParameter(Loc.initial, null, Type.terror, null, null);
        expect(tpsemantic(tp, freshScope(), null)).toBe(false);
    });

    test("TemplateAliasParameter with nothing set -> true, specAlias stays null (d:122-135)", () => {
        // aliasParameterSemantic(o = null) returns null at dmd/templateparamsem.d:157-158.
        const tp = new TemplateAliasParameter(Loc.initial, null, null, null, null);
        expect(tpsemantic(tp, freshScope(), null)).toBe(true);
        expect(tp.specAlias).toBe(null);
    });
});

describe("TemplateThisParameter — the base-forward of dmd/templateparamsem.d:85 (13 §4)", () => {
    test("outside an aggregate: one diagnostic, then the TemplateTypeParameter body runs", () => {
        // `sc.getStructClassScope()` is null on a bare scope -> D emits
        // "cannot use `this` outside an aggregate type" (d:84) and then forwards to the base
        // overload, which (specType == null) sets result = true.
        // gag the (byte-exact) stderr print; the emission still bumps global.errors, which is what
        // is asserted (typesem.basic.test.ts precedent).
        const tp = new TemplateThisParameter(Loc.initial, null, null, null);
        global.gag = 1;
        try {
            expect(tpsemantic(tp, freshScope(), null)).toBe(true);
            expect(global.errors).toBe(1);
        } finally {
            global.gag = 0;
        }
    });
});

describe("reliesOnTident / ctfeInterpret legs — pinned on the arms D actually takes", () => {
    test("TemplateTypeParameter WITH a specialization: reliesOnTident false -> specType semantic'd (d:64-66)", () => {
        // `int` names no template parameter, so `reliesOnTident(int, [])` is false and d:66 runs
        // typeSemantic on the (already canonical) specType; result = !isError(int) = true (d:76).
        const params: TemplateParameters = new DArray<TemplateParameter | null>();
        const tp = new TemplateTypeParameter(Loc.initial, null, Type.tint32, null);
        expect(tpsemantic(tp, freshScope(), params)).toBe(true);
        expect(tp.specType).toBe(Type.tint32);
    });

    test(
        "TemplateAliasParameter WITH a specialization: reliesOnTident false -> specType semantic'd (d:124-126)",
        () => {
        const params: TemplateParameters = new DArray<TemplateParameter | null>();
        const tp = new TemplateAliasParameter(Loc.initial, null, Type.tint32, null, null);
        expect(tpsemantic(tp, freshScope(), params)).toBe(true);
        expect(tp.specType).toBe(Type.tint32);
        expect(tp.specAlias).toBe(null);
    });

    test(
        "aliasParameterSemantic on an EXPRESSION runs the CTFE bracket and returns ctfeInterpret's value (d:166)",
        () => {
        // D dispatch: `isType(o)` is null for an Expression (d:167), so `if (ta && ...)` (d:168) is
        // false and control reaches `else if (ea) return eaCTFE();` (d:198-199). Inside `eaCTFE`,
        // d:163-165 run on an already-typed IntegerExp, and d:166's `ctfeInterpret` takes its
        // literal fast path (dmd/dinterpret.d:71-91), returning the SAME expression.
        const e = IntegerExp.create(Loc.initial, 42n, Type.tint32);
        expect(aliasParameterSemantic(Loc.initial, freshScope(), e, null)).toBe(e);
    });

    test(
        "aliasParameterSemantic with a non-null `parameters`: reliesOnTident false -> typeSemantic(ta) (d:169, :196)",
        () => {
        // D: `if (ta && (!parameters || !reliesOnTident(ta, parameters)))` — a NON-null `parameters`
        // reaches the call; `int` relies on no parameter, so the body runs and d:196 returns
        // typeSemantic(int), the interned singleton.
        const params: TemplateParameters = new DArray<TemplateParameter | null>();
        expect(aliasParameterSemantic(Loc.initial, freshScope(), Type.tint32, params)).toBe(Type.tint32);
    });
});

describe("aliasParameterSemantic (dmd/templateparamsem.d:155-201)", () => {
    test("a null object returns null (d:157-158)", () => {
        expect(aliasParameterSemantic(Loc.initial, freshScope(), null, null)).toBe(null);
    });

    test("a plain (non-TypeInstance) type with null `parameters` -> typeSemantic(ta) (d:195-196)", () => {
        // `!parameters` short-circuits reliesOnTident; `toDsymbol(int)` is null and
        // `int.isTypeInstance()` is null, so the `else` arm at d:196 returns typeSemantic(ta).
        const r = aliasParameterSemantic(Loc.initial, freshScope(), Type.tint32, null);
        expect(r).toBe(Type.tint32);
    });
});
