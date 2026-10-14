// Goal tests for src/dmd/typinf.ts.
//
// dmd/typinf.d has ZERO in-source `unittest{}` blocks (10 §1.6b shape: smoke + behaviour pins). The
// harness has no druntime, so the TypeInfo classes object.d would declare are stood in by bare
// `ClassDeclaration`s assigned to the `Type.typeinfo*` statics — the only thing typinf.d reads from them
// is `.type`. Oracle pins (ldc2 1.43.0, scratchpad w15-smallports):
//   - `extern(C) void main(){ auto t = typeid(int); }` with -betterC:
//       Error: `TypeInfo` cannot be used with `-betterC`                         (exit 1)
//   - the `expression `%s` uses the GC …` text (typinf.d:54) is pinned from the D format string only
//     (the two probes tried, gc.d and gc2.d, did not reach that branch; gc2.d reaches the `e is null`
//     message through a template instance and prints the `instantiated from here` trace of :59).
//   - `typeid(int)` against an object.d without TypeInfo:
//       Error: `object.TypeInfo` could not be found, but is implicitly used       (exit 1)
//   - `typeof(typeid(X))`: int -> TypeInfo, const(int) -> TypeInfo_Const, shared(int) -> TypeInfo_Shared,
//       int* -> TypeInfo_Pointer, int[int] and const(int)[const(int)] -> TypeInfo_AssociativeArray.

// Load-order smoke (01 §4.8 / 10 §1.5): typinf.ts is imported FIRST, so it is the entry of the module
// graph here; a `Class extends value undefined` from its import order fails at collect, loudly.
import { builtinTypeInfo, genTypeInfo, getTypeInfoType, makeNakedAssociativeArray } from "./typinf.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { initSemaHarness } from "../sema-harness.js";
import { Type, TypeAArray } from "./mtype.js";
import { ClassDeclaration } from "./dclass.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { TOK } from "./tokens.js";
import { global } from "./globals.js";
import { FatalError, setDiagnosticHandler, setFatalErrorHandler, throwFatalError } from "./errors.js";
import { dmdformat } from "./root/dmdformat.js";
import { Module } from "./dmodule.js";
import {
    TypeInfoAssociativeArrayDeclaration, TypeInfoConstDeclaration, TypeInfoDeclaration, TypeInfoPointerDeclaration,
    TypeInfoSharedDeclaration,
} from "./declaration.js";
import { arrayOf, constOf, immutableOf, merge, pointerTo, sharedOf } from "./typesem.js";
import { ds, dsToJs, cstr } from "../dstring.js";
import { Scope } from "./dscope.js";
import { IntegerExp } from "./expression.js";

type Statics = Record<string, unknown>;
const TI_STATICS = ["dtypeinfo", "typeinfoconst", "typeinfoshared", "typeinfopointer", "typeinfoassociativearray"];

function fakeClass(name: string): ClassDeclaration {
    return new ClassDeclaration(Loc.initial, new Identifier(ds(name), TOK.identifier), null, null, false);
}

let messages: string[] = [];

beforeEach(() => {
    initSemaHarness();
    for (const s of TI_STATICS)
        delete (Type as unknown as Statics)[s]; // the statics are unset until object.d is analysed
    messages = [];
    setDiagnosticHandler((_loc, _color, _header, messageFormat, args) => {
        messages.push(dsToJs(dmdformat(messageFormat, [...args])));
        return true;
    });
    setFatalErrorHandler(throwFatalError);
});

afterEach(() => {
    setDiagnosticHandler(null);
    setFatalErrorHandler(null);
    global.params.useTypeInfo = true;
    for (const s of TI_STATICS)
        delete (Type as unknown as Statics)[s];
});

function installTypeInfoClasses(): Record<string, ClassDeclaration> {
    const cls: Record<string, ClassDeclaration> = {};
    for (const [s, name] of [["dtypeinfo", "TypeInfo"], ["typeinfoconst", "TypeInfo_Const"],
                             ["typeinfoshared", "TypeInfo_Shared"], ["typeinfopointer", "TypeInfo_Pointer"],
                             ["typeinfoassociativearray", "TypeInfo_AssociativeArray"]]) {
        cls[s] = fakeClass(name);
        (Type as unknown as Statics)[s] = cls[s];
    }
    return cls;
}

describe("typinf.ts", () => {
    test("SMOKE: the module loads as the graph entry and exports its functions", () => {
        for (const f of [builtinTypeInfo, genTypeInfo, getTypeInfoType, makeNakedAssociativeArray])
            expect(typeof f).toBe("function");
    });

    test("PIN 1: -betterC outside CTFE reports and ends in fatal() (typinf.d:48-61), both messages", () => {
        global.params.useTypeInfo = false;
        global.gag = 3; // typinf.d:52 un-gags before reporting
        expect(() => genTypeInfo(null, Loc.initial, Type.tint32, null)).toThrow(FatalError);
        expect(global.gag).toBe(0);
        const e = new IntegerExp(Loc.initial, 0n, Type.tint32);
        expect(() => genTypeInfo(e, Loc.initial, Type.tint32, null)).toThrow(FatalError);
        expect(messages).toEqual([
            "`TypeInfo` cannot be used with `-betterC`",
            "expression `0` uses the GC and cannot be used with switch `-betterC`",
        ]);

        // Inside CTFE the betterC gate is skipped (issue 18472): the next failure is the missing class.
        const sc = new Scope();
        sc.ctfe = true;
        messages = [];
        expect(() => genTypeInfo(null, Loc.initial, Type.tint32, sc)).toThrow(FatalError);
        expect(messages).toEqual(["`object.TypeInfo` could not be found, but is implicitly used"]);
    });

    test("PIN 2: getTypeInfoType picks the TypeInfo class by qualifier and kind; genTypeInfo is false", () => {
        const cls = installTypeInfoClasses();

        expect(genTypeInfo(null, Loc.initial, Type.tint32, null)).toBe(false); // IN_LLVM: never codegen
        expect(Type.tint32.vtinfo).toBeInstanceOf(TypeInfoDeclaration);
        expect(getTypeInfoType(Loc.initial, Type.tint32, null)).toBe(cls.dtypeinfo.type);

        const cint = constOf(Type.tint32);
        expect(getTypeInfoType(Loc.initial, cint, null)).toBe(cls.typeinfoconst.type);
        expect(cint.vtinfo).toBeInstanceOf(TypeInfoConstDeclaration);

        const sint = sharedOf(Type.tint32);
        expect(getTypeInfoType(Loc.initial, sint, null)).toBe(cls.typeinfoshared.type);
        expect(sint.vtinfo).toBeInstanceOf(TypeInfoSharedDeclaration);

        const pint = pointerTo(Type.tint32);
        expect(getTypeInfoType(Loc.initial, pint, null)).toBe(cls.typeinfopointer.type);
        expect(pint.vtinfo).toBeInstanceOf(TypeInfoPointerDeclaration);
        expect(global.errors).toBe(0);
    });

    test("PIN 3: an AA's TypeInfo is built on the naked AA and queued for semantic3 (typinf.d:177)", () => {
        const cls = installTypeInfoClasses();
        const m = new Module(Loc.initial, ds("m.d"), new Identifier(ds("m"), TOK.identifier), 0, 0);
        const sc = new Scope();
        sc._module = m;

        const aa = merge(new TypeAArray(constOf(Type.tint32), constOf(Type.tint32))) as TypeAArray;
        const naked = makeNakedAssociativeArray(aa);
        expect(naked).not.toBe(aa);
        expect(dsToJs(cstr(naked.toChars()))).toBe("int[int]");
        expect(makeNakedAssociativeArray(naked as TypeAArray)).toBe(naked); // already naked: itself

        const before = Module.deferred3.length;
        expect(getTypeInfoType(Loc.initial, aa, sc)).toBe(cls.typeinfoassociativearray.type);
        const ti = naked.vtinfo!;
        expect(ti).toBeInstanceOf(TypeInfoAssociativeArrayDeclaration);
        expect(aa.vtinfo).toBe(ti); // typinf.d:106 shares the naked type's vtinfo
        expect(ti._scope).toBe(sc);
        expect(Module.deferred3.length).toBe(before + 1);
    });

    test("PIN 4: builtinTypeInfo — unqualified basics, typeof(null), and the three array shapes", () => {
        expect(builtinTypeInfo(Type.tint32)).toBe(true);
        expect(builtinTypeInfo(Type.tnull)).toBe(true);
        expect(builtinTypeInfo(constOf(Type.tint32))).toBe(false);
        expect(builtinTypeInfo(arrayOf(Type.tint32))).toBe(true);
        expect(builtinTypeInfo(arrayOf(immutableOf(Type.tchar)))).toBe(true); // string
        expect(builtinTypeInfo(arrayOf(constOf(Type.tchar)))).toBe(true);     // const(char)[]
        expect(builtinTypeInfo(arrayOf(constOf(Type.tint32)))).toBe(false);
        expect(builtinTypeInfo(pointerTo(Type.tint32))).toBe(false);
    });
});
