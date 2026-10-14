// Co-located tests for src/dmd/compiler.ts (dmd/compiler.d).
//
// compiler.d carries ONE `unittest` block (compiler.d:357, `parseModulePatternDepth`), ported verbatim
// below (10 §1). The rest are 10 §1.6b behaviour pins: `Compiler.paintAsType` on IEEE-754 bit patterns
// (the reinterpretation `*(Type *)&e` it models), and `Compiler.onImport` over a `-i` pattern set.
//
// `onImport` builds its matcher table once per process (`createMatchNodes` returns early once
// `matchNodes` is filled, compiler.d:302), as D's one-shot driver does; the whole pattern scenario is
// therefore ONE test, set up once, so no test depends on another's leftover table.

import "./parse.js"; // module-graph ROOT for a core-SCC test file (10 §1.5)

import { beforeEach, describe, expect, test } from "vitest";

import {
    Compiler, compiledImports, includeModulePatterns, parseModulePatternDepth, setIncludeImports,
} from "./compiler.js";
import { UnionExp } from "./ctfeexpr.js";
import { IntegerExp, RealExp } from "./expression.js";
import { Module, ModuleDeclaration } from "./dmodule.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { Type } from "./mtype.js";
import { toInteger, toReal } from "./expressionsem.js";
import { initSemaHarness } from "../sema-harness.js";
import { ds } from "../dstring.js";

beforeEach(() => {
    initSemaHarness();
});

function id(name: string): Identifier {
    return Identifier.idPool(ds(name));
}

describe("compiler.d:357 — unittest (parseModulePatternDepth)", () => {
    test("depth counts dot-separated components; `.` and `-.` are depth 0", () => {
        expect(parseModulePatternDepth(ds("."))).toBe(0);
        expect(parseModulePatternDepth(ds("-."))).toBe(0);
        expect(parseModulePatternDepth(ds("abc"))).toBe(1);
        expect(parseModulePatternDepth(ds("-abc"))).toBe(1);
        expect(parseModulePatternDepth(ds("abc.foo"))).toBe(2);
        expect(parseModulePatternDepth(ds("-abc.foo"))).toBe(2);
    });
});

describe("compiler.d:56 — Compiler.paintAsType", () => {
    const loc = Loc.initial;

    test("int32 bits -> float32 and back (1.0f is 0x3f800000; -1.0f is 0xbf800000)", () => {
        const ue = new UnionExp();
        const f = Compiler.paintAsType(ue, new IntegerExp(loc, 0x3f800000n, Type.tint32), Type.tfloat32);
        expect(f).toBeInstanceOf(RealExp);
        expect(f.type).toBe(Type.tfloat32);
        expect(toReal(f)).toBe(1.0);
        const i = Compiler.paintAsType(new UnionExp(), new RealExp(loc, -1.0, Type.tfloat32), Type.tuns32);
        expect(i).toBeInstanceOf(IntegerExp);
        expect(toInteger(i)).toBe(0xbf800000n);
    });

    test("int64 bits -> float64 and back (1.0 is 0x3ff0000000000000)", () => {
        const d = Compiler.paintAsType(new UnionExp(), new IntegerExp(loc, 0x3ff0000000000000n, Type.tint64),
            Type.tfloat64);
        expect(toReal(d)).toBe(1.0);
        const l = Compiler.paintAsType(new UnionExp(), new RealExp(loc, -2.0, Type.tfloat64), Type.tuns64);
        expect(toInteger(l)).toBe(0xc000000000000000n);
    });

    test("float80 is the 8-byte target `real` and takes the float64 path", () => {
        const r = Compiler.paintAsType(new UnionExp(), new IntegerExp(loc, 0x3ff0000000000000n, Type.tuns64),
            Type.tfloat80);
        expect(r.type).toBe(Type.tfloat80);
        expect(toReal(r)).toBe(1.0);
    });
});

describe("compiler.d:131/:140 — Compiler.onParseModule / onImport", () => {
    function mod(pkgs: string[], name: string): Module {
        const m = new Module(Loc.initial, ds(name + ".d"), id(name), 0, 0);
        m.md = new ModuleDeclaration(Loc.initial, pkgs.map(id), id(name), null, false);
        return m;
    }

    test("onParseModule is empty: the module is left untouched", () => {
        const m = mod([], "a");
        Compiler.onParseModule(m);
        expect(m.members).toBe(null);
    });

    test("without -i nothing is compiled", () => {
        expect(Compiler.onImport(mod(["foo"], "bar"))).toBe(false);
        expect(compiledImports.length).toBe(0);
    });

    test("-i=foo,-foo.baz: longest pattern wins, default exclusions apply, include pattern flips the default", () => {
        setIncludeImports(true);
        try {
            includeModulePatterns.push(ds("foo"));
            includeModulePatterns.push(ds("-foo.baz"));
            const fooBar = mod(["foo"], "bar");
            expect(Compiler.onImport(fooBar)).toBe(true);                    // matches `foo`
            expect(compiledImports.opSlice()).toEqual([fooBar]);
            expect(Compiler.onImport(mod(["foo", "baz"], "x"))).toBe(false); // depth-2 `-foo.baz` is tried first
            expect(Compiler.onImport(mod(["std"], "stdio"))).toBe(false);    // default `-std`
            expect(Compiler.onImport(mod(["ldc"], "attributes"))).toBe(false); // default `-ldc` (IN_LLVM)
            expect(Compiler.onImport(mod([], "object"))).toBe(false);        // default `-object`
            expect(Compiler.onImport(mod(["other"], "m"))).toBe(false);      // no match: includeByDefault is false
            expect(Compiler.onImport(mod([], "foo"))).toBe(true);            // `foo` itself
            const pkgFile = mod(["foo"], "baz");
            pkgFile.isPackageFile = true;                                    // foo.baz.package matches `-foo.baz`
            expect(Compiler.onImport(pkgFile)).toBe(false);
            expect(compiledImports.length).toBe(2);
        } finally {
            setIncludeImports(false);
        }
    });
});
