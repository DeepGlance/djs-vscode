// Tests for the AST view's navigation through the worker (host/compiler.ts `ast`, host/ast.ts; djs 10 §4.7,
// "Queries"), run against the emit in dist/ on a small module written to a temporary directory. The lane on real
// programs is host/ast.private.test.ts.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import type { DjsCompiler as Compiler } from "./compiler.js";
import type { Position } from "./protocol.js";

const DIST = new URL("../dist/", import.meta.url);

let DjsCompiler: typeof Compiler;
let planFlags: typeof import("./flags.js").planFlags;
let splitLine: typeof import("./flags.js").splitLine;
let astPrintFor: typeof import("./ast.js").astPrintFor;
let astAnchorAt: typeof import("./ast.js").astAnchorAt;
let astAnchorPosition: typeof import("./ast.js").astAnchorPosition;

beforeAll(async () => {
    ({ astPrintFor, astAnchorAt, astAnchorPosition } =
        await import(new URL("host/ast.js", DIST).href) as typeof import("./ast.js"));
    ({ DjsCompiler } = await import(new URL("host/compiler.js", DIST).href) as typeof import("./compiler.js"));
    ({ planFlags, splitLine } = await import(new URL("host/flags.js", DIST).href) as typeof import("./flags.js"));
});

/** The (line, character) of the `nth` occurrence of `token` in `text`, plus `skip` characters (UTF-16, from 0). */
function at(text: string, token: string, nth = 0, skip = 0): Position {
    let i = -1;
    for (let k = 0; k <= nth; k++) {
        i = text.indexOf(token, i + 1);
        if (i < 0)
            throw new Error(`no occurrence ${nth} of ${JSON.stringify(token)}`);
    }
    i += skip;
    const before = text.slice(0, i);
    return { line: before.split("\n").length - 1, character: i - (before.lastIndexOf("\n") + 1) };
}

/** The UTF-16 offsets where the lines of `text` start. */
function lineStarts(text: string): number[] {
    const starts = [0];
    for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1))
        starts.push(i + 1);
    return starts;
}

/** A module small enough to reason about every entry: an aggregate, an aggregate template, a function template. */
const SMALL = "module app;\nstruct S { int x; }\nstruct Box(T) { T v; T twice() { return v + v; } }\n"
    + "T one(T)(T a) { return a; }\n"
    + "int use() { Box!int b; Box!long c; auto s = S(1); return b.twice() + cast(int) c.twice() + s.x + one(1); }\n";

describe("AST view navigation on a small module", () => {
    test("reveals the template's own print, skips compiler-made entries, keeps places across a reprint", async () => {
        const dir = mkdtempSync(join(tmpdir(), "djs-vscode-ast-"));
        const root = join(dir, "app.d");
        const c = new DjsCompiler();
        try {
            writeFileSync(root, SMALL);
            const args = [...planFlags(splitLine("ldc2 -c"), dir).args, root];
            const first = await c.compile(args);
            expect([first.status, first.errors], first.output).toEqual([0, 0]);
            const a1 = (await c.ast(root, SMALL))!;
            expect(a1.result, a1.reason).not.toBeNull();
            const { text, entries } = a1.result!;
            const lines = text.split("\n");
            const starts = lineStarts(text);
            const printAt = (token: string, skip = 0, file = root): string | null => {
                const r = astPrintFor(entries, file, at(SMALL, token, 0, skip));
                return r === null ? null : text.slice(starts[r.start.line]! + r.start.character,
                    starts[r.end.line]! + r.end.character);
            };
            // a member of an aggregate template: the template's print (`T twice()`), not an instance's (`int twice()`)
            expect(printAt("twice() {", 1), text).toMatch(/^T twice\(\)/);
            expect(printAt("return v + v", 2), text).toMatch(/^T twice\(\)/);
            // a function template, from its body: the template's print, not `one!int`'s
            const one = printAt("return a;", 3);
            expect(one, text).toMatch(/\bone\b/);
            expect(one, text).not.toMatch(/^(int|long)\b/);
            // a struct's name: the struct, not the RTInfo!(S) the compiler made with an empty range there
            expect(printAt("struct S", 7), text).toMatch(/^struct S\b/);
            // the module line: nothing, not the implicit `import object;` at (0,0)
            expect(printAt("module app;"), text).toBeNull();
            // file names are compared resolved, and kept resolved
            expect(printAt("struct S", 7, join(dir, ".", "sub", "..", "app.d"))).toMatch(/^struct S\b/);
            expect(entries.fileNames.every((f) => f === resolve(f)), JSON.stringify(entries.fileNames)).toBe(true);

            // a reprint after an edit above them: the places in the template's member and in an instance's member
            // are found again on the same printed lines
            const twiceLine = lines.findIndex((l) => /^\s*T twice\(\)/.test(l));
            const instanceLine = lines.findIndex((l) => /\bint twice\(\)/.test(l));
            expect([twiceLine, instanceLine].every((l) => l >= 0), text).toBe(true);
            const places = [{ line: twiceLine + 2, character: 1 }, { line: instanceLine, character: 2 }];
            const anchors = places.map((p) => astAnchorAt(entries, p, (l) => lines[l] ?? ""));
            expect(anchors.every((a) => a !== null)).toBe(true);
            const edited = SMALL.replace("module app;\n", "module app;\nstruct Pad { int y; }\n");
            writeFileSync(root, edited);
            const second = await c.compile(args);
            expect([second.status, second.errors], second.output).toEqual([0, 0]);
            const a2 = (await c.ast(root, edited))!;
            expect(a2.result, a2.reason).not.toBeNull();
            const lines2 = a2.result!.text.split("\n");
            expect(lines2.length).toBeGreaterThan(lines.length);
            anchors.forEach((a, k) => {
                const p = astAnchorPosition(a2.result!.entries, a!, (l) => lines2[l] ?? "");
                expect(p, JSON.stringify(a)).not.toBeNull();
                expect([lines2[p!.line], p!.character]).toEqual([lines[places[k]!.line], places[k]!.character]);
            });
        } finally {
            await c.dispose();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 120000);
});
