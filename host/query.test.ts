// Tests for the worker's queue (host/compiler.ts), run against the emit in dist/ on a small module written to a
// temporary directory: a query made during a compile answers from it, one cancelled before its turn resolves null, and
// a hover goes ahead of the calls queued and not yet started, never ahead of the one running. The lane on real
// programs is host/query.private.test.ts.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import type { DjsCompiler as Compiler } from "./compiler.js";

const DIST = new URL("../dist/", import.meta.url);

let DjsCompiler: typeof Compiler;

beforeAll(async () => {
    ({ DjsCompiler } = await import(new URL("host/compiler.js", DIST).href) as typeof import("./compiler.js"));
});

describe("the chain", () => {
    test("a query during a compile waits for it; one cancelled before its turn never reaches the worker", async () => {
        const dir = mkdtempSync(join(tmpdir(), "djs-vscode-query-"));
        const c = new DjsCompiler();
        try {
            const file = join(dir, "q.d");
            const text = "module q;\nint twice(int v) { return v * 2; }\nint use() { return twice(3); }\n";
            writeFileSync(file, text);
            const compiling = c.compile(["-c", "-o-", "-verrors=0", file]);
            const dropped = c.hover(file, 2, 19, text, () => true);
            const waited = c.hover(file, 2, 19, text);
            const definition = c.definition(file, 2, 19, text);
            expect((await compiling).errors).toBe(0);
            expect(await dropped).toBeNull();
            expect((await waited)!.result!.name).toBe("q.twice");
            expect((await definition)!.result!.range.start).toEqual({ line: 1, character: 4 });
        } finally {
            await c.dispose();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("the queue", () => {
    test("a hover goes ahead of a queued compile and a queued query, not ahead of the compile running", async () => {
        const dir = mkdtempSync(join(tmpdir(), "djs-vscode-query-"));
        const c = new DjsCompiler();
        try {
            const file = join(dir, "q.d");
            const text = "module q;\nint twice(int v) { return v * 2; }\nint use() { return twice(3); }\n";
            writeFileSync(file, text);
            const args = ["-c", "-o-", "-verrors=0", file];
            const order: string[] = [];
            const track = <T>(name: string, p: Promise<T>): Promise<T> => p.then((r) => {
                order.push(name);
                return r;
            });
            const running = track("compile", c.compile(args));
            const queued = track("queued compile", c.compile(args, { [file]: `${text}int more() { return 1; }\n` }));
            const tokens = track("tokens", c.semanticTokens(file, text));
            const hover = track("hover", c.hover(file, 2, 19, text));
            await Promise.all([running, queued, tokens, hover]);
            expect(order).toEqual(["compile", "hover", "queued compile", "tokens"]);
            // the hover answered from the first compile; the tokens, after the second, find another text
            expect((await hover)!.result!.name).toBe("q.twice");
            expect((await tokens)!.stale).toBe(true);
        } finally {
            await c.dispose();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
