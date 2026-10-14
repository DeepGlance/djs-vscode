// Co-located tests for src/dmd/lambdacomp.ts (ported from dmd/lambdacomp.d).
//
// lambdacomp.d carries no `unittest` block (10 §1.6b), so this file pins `isSameFuncLiteral` directly
// on fully typed lambdas, semantically analysed inside a module scope. The end-to-end behaviour through
// `__traits(isSame)` (untyped lambdas, enums, calls, byte-exact against ldc2 1.43.0) is pinned in
// traits.test.ts.

import { beforeEach, describe, expect, test } from "vitest";
import { initSemaHarness } from "../sema-harness.js"; // imports ./dmd/parse.js first: the module-graph root (10 §1.5)
import { Parser } from "./parse.js";
import { ErrorSinkNull } from "./errorsink.js";
import { moduleFromParse } from "./dmodule.js";
import { scopeCreateGlobal } from "./dsymbolsem.js";
import { expressionSemantic } from "./expressionsem.js";
import { DsymbolTable } from "./dsymbol.js";
import type { Dsymbol } from "./dsymbol.js";
import type { FuncLiteralDeclaration } from "./func.js";
import { Array as DArray } from "./root/array.js";
import { global } from "./globals.js";
import { isSameFuncLiteral } from "./lambdacomp.js";

/** Semantic-analyses each source as a typed function literal in one module scope; returns the literals. */
function lambdas(...srcs: string[]): [FuncLiteralDeclaration[], ReturnType<typeof scopeCreateGlobal>] {
    let sc: ReturnType<typeof scopeCreateGlobal> | null = null;
    const out: FuncLiteralDeclaration[] = [];
    for (const src of srcs) {
        const bytes = new TextEncoder().encode(src);
        const buf = new Uint8Array(bytes.length + 1); // NUL-terminated: the lexer scans to the NUL
        buf.set(bytes, 0);
        const p = new Parser(null, null, buf, false, new ErrorSinkNull(), null, false);
        p.nextToken();
        const e = p.parseExpression();
        if (sc === null) {
            const m = moduleFromParse(new DArray<Dsymbol | null>(), p.md);
            m.symtab = new DsymbolTable(); // the lambda's `__lambda` name is inserted into the module's table
            sc = scopeCreateGlobal(m, global.errorSink!);
        }
        const fe = expressionSemantic(e, sc).isFuncExp();
        out.push(fe!.fd!);
    }
    return [out, sc!];
}

describe("lambdacomp.ts — isSameFuncLiteral (lambdacomp.d:64)", () => {
    beforeEach(() => {
        initSemaHarness();
    });

    test("parameter names do not matter, the body and the parameter types do", () => {
        const [[a, b, c, d], sc] = lambdas(
            "(int x) => x + 1", "(int y) => y + 1", "(int x) => x + 2", "(long x) => x + 1");
        expect(isSameFuncLiteral(a, b, sc)).toBe(true);
        expect(isSameFuncLiteral(a, c, sc)).toBe(false);
        expect(isSameFuncLiteral(a, d, sc)).toBe(false);
    });

    test("a lambda D cannot serialize is not the same as anything, itself included", () => {
        const [[a, b], sc] = lambdas("(int x) => \"s\"", "(int x) => \"s\"");
        expect(isSameFuncLiteral(a, b, sc)).toBe(false);
        expect(isSameFuncLiteral(a, a, sc)).toBe(false);
    });
});
