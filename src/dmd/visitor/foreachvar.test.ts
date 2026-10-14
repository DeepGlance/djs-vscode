// Co-located tests for src/dmd/visitor/foreachvar.ts.
//
// dmd/visitor/foreachvar.d carries no in-source `unittest{}` block. Both walkers run over a function
// body produced by passes 0-3 (the sema harness), which is the shape ob.d's collectVars hands them:
// `foreachExpAndVar` feeds every expression to `dgExp`, and `dgExp` calls `foreachVar`, so the
// variables arrive in statement order, each declaration's initializer after the declared variable.

import "../parse.js"; // module-graph ROOT for a core-SCC test file (10 §1.5)

import { beforeEach, describe, expect, test } from "vitest";

import { foreachExpAndVar, foreachVar } from "./foreachvar.js";
import { Parser } from "../parse.js";
import { global } from "../globals.js";
import { moduleFromParse } from "../dmodule.js";
import { runSemantic } from "../dsymbolsem.js";
import { WhileStatement } from "../statement.js";
import { Loc } from "../location.js";
import { initSemaHarness, sourceMembers } from "../../sema-harness.js";
import { dsToJs } from "../../dstring.js";

import type { Dsymbols } from "../arraytypes.js";
import type { FuncDeclaration } from "../func.js";
import type { Expression } from "../expression.js";
import type { VarDeclaration } from "../declaration.js";

beforeEach(() => {
    initSemaHarness();
});

/** NUL-terminated byte buffer (the lexer scans to the NUL sentinel). */
function srcBuf(text: string): Uint8Array {
    const b = new Uint8Array(text.length + 1);
    for (let i = 0; i < text.length; i++) b[i] = text.charCodeAt(i) & 0xff;
    b[text.length] = 0;
    return b;
}

/** Runs passes 0-3 over `text` and returns the function it declares first. */
function firstFunction(text: string): FuncDeclaration {
    const p = new Parser(null, null, srcBuf(text), false, global.errorSink!, null, false);
    p.nextToken();
    const members: Dsymbols = p.parseModule();
    const m = moduleFromParse(members, p.md);
    runSemantic(m);
    expect(global.errors).toBe(0);
    return sourceMembers(m)[0].isFuncDeclaration()!;
}

/** The names collectVars would see (ob.d:1176-1187): statement variables plus expression-declared ones. */
function collectNames(fd: FuncDeclaration): string[] {
    const names: string[] = [];
    const dgVar = (v: VarDeclaration): void => { names.push(dsToJs(v.ident!.toString())); };
    const dgExp = (e: Expression): void => { foreachVar(e, dgVar); };
    foreachExpAndVar(fd.fbody, dgExp, dgVar);
    return names;
}

describe("foreachvar.d:48/:112 — foreachVar driven by foreachExpAndVar", () => {
    test("locals declared in statements, a for initializer and a nested scope, in order", () => {
        const fd = firstFunction("module fv1;\nvoid f() { int a = 1; for (int i = 0; i < 2; i++) { int b = i; } }\n");
        expect(collectNames(fd)).toEqual(["a", "i", "b"]);
    });

    test("foreachvar.d:89 — an index with `$` reports the length variable", () => {
        const fd = firstFunction("module fv2;\nint f(int[] arr) { return arr[$ - 1]; }\n");
        expect(collectNames(fd)).toEqual(["__dollar"]);
    });

    test("if/else and return expressions are walked", () => {
        const fd = firstFunction("module fv3;\n"
            + "int f(bool c) { if (c) { int x = 1; return x; } else { int y = 2; return y; } }\n");
        expect(collectNames(fd)).toEqual(["x", "y"]);
    });

    test("foreachVar on a null expression is a no-op", () => {
        const seen: VarDeclaration[] = [];
        foreachVar(null, (v) => { seen.push(v); });
        expect(seen).toEqual([]);
    });

    test("foreachvar.d:304 — a statement kind semantic lowers away asserts", () => {
        const w = new WhileStatement(Loc.initial, null, null, Loc.initial, null);
        expect(() => foreachExpAndVar(w, () => {}, () => {})).toThrow("Assertion failure");
    });
});
