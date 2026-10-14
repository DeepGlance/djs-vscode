// Single-entry load-order proof for the whole port (01 §4.1/§4.8, translation-order.md §2.2).
//
// Hand-written djs test (NOT a port of any dmd/ file). It exists because ESM evaluates a cyclic
// module graph in the order the FIRST imported module dictates, and the port's core SCC holds
// top-level `class ... extends` reads that fail (`TypeError: Class extends value undefined`) when a
// base class's module is still mid-evaluation. Which module a consumer imports first is not under
// the control of the module that breaks: a test file, the CLI shim, or a future caller may enter the
// graph anywhere. So the contract pinned here is: EVERY non-test module under src/ loads when it is
// the first module imported into an empty registry, under both loaders the port runs on.
//
// TWO LEGS, because the loaders differ on cycles. vitest's module runner (vite-node) hands a read of a
// cyclic export that is not yet evaluated back as `undefined`; native Node ESM throws a TDZ
// `ReferenceError: Cannot access 'X' before initialization`. Both fail on a top-level `extends` (vitest:
// `TypeError: Class extends value undefined`), but a top-level read that only STORES the binding
// (`export const table = [A];`) passes under vitest with a silent `undefined` and kills the native load.
// The vitest leg proves the test suites' loader; the native leg proves the CLI shim's (a tsc emit run
// by Node), and is the one that catches the store-only read.
//
// VITEST LEG — how the registry is emptied, and why it is the same thing as a fresh worker: vitest runs each test
// file in its own isolated worker, whose module cache starts empty, so a suite's first static
// import IS its entry into the graph. Inside one file, `vi.resetModules()` invalidates every cached
// module except vitest's own (vitest 3.2 `resetModules`: it skips only `/vitest/dist/`,
// `/vite-node/dist/`, the virtual modules and mocks), and the next `import()` re-evaluates the whole
// reachable graph from the requested entry. This file carries no static import of any src module,
// so nothing is evaluated before the first entry either. The same verdicts were cross-checked with
// one vitest worker per entry.
//
// NATIVE LEG — the repo's tsconfig emitted by the TypeScript compiler API into a temporary directory
// (`{"type":"module"}` beside it), then each entry imported in its own `worker_threads` Worker: every
// Worker owns a separate ESM loader, so each entry starts from an empty registry.
//
// A red row names the entry module and carries the loader's error; the fix recipe is 01 §4.4
// (registration slot) / §4.8 (value import last), located with the §4.4 diagnostic recipe.

import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every non-test `.ts` module under `src/`, as paths relative to `src/`, sorted. */
function entryModules(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory())
                walk(p);
            else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts"))
                out.push(relative(srcRoot, p));
        }
    };
    walk(srcRoot);
    return out.sort();
}

const entries = entryModules();

/**
 * The frames of a load failure under `root`, innermost first: the failing top-level read, then each
 * module's import line back to the entry, e.g. `dmd/dtemplate.ts:275 <- dmd/declaration.ts:62 <- dmd/func.ts:44`.
 * vitest source-maps the frames, so under it the lines are TS lines and each hop is one edge of the cycle;
 * native ESM reports only the module whose evaluation threw, as a line of the emitted `.js`.
 */
function importChain(stack: string, root: string, ext: string): string {
    const frames: string[] = [];
    for (const m of stack.matchAll(/(?:file:\/\/)?(\/[^\s():]+):(\d+):\d+/g)) {
        const rel = relative(root, m[1]!);
        if (!rel.startsWith("..") && rel.endsWith(ext) && !rel.endsWith(`loadorder.test${ext}`))
            frames.push(`${rel}:${m[2]}`);
    }
    return frames.join(" <- ");
}

describe("single-entry module load (01 §4.8)", () => {
    test("the entry table covers the tree", () => {
        expect(entries).toContain("dmd/dmodule.ts");
        expect(entries).toContain("dmd/parse.ts");
        expect(entries).toContain("sema-harness.ts");
        expect(entries.length).toBeGreaterThan(100);
    });

    // The reset is what makes each row an independent entry: a second import after it must build a
    // new graph (a new `Parser` class object), not hand back the cached one.
    test("vi.resetModules() empties the registry", async () => {
        const url = pathToFileURL(join(srcRoot, "dmd/parse.ts")).href;
        vi.resetModules();
        const first = await import(url);
        vi.resetModules();
        const second = await import(url);
        expect(typeof first.Parser).toBe("function");
        expect(second.Parser).not.toBe(first.Parser);
    });

    test.each(entries)("%s loads first into an empty registry", async (entry) => {
        vi.resetModules();
        const limit = Error.stackTraceLimit;
        Error.stackTraceLimit = 300; // the whole import chain, not the default 10 frames (01 §4.4 recipe)
        let failure = "";
        try {
            await import(pathToFileURL(join(srcRoot, entry)).href);
        } catch (e) {
            failure = e instanceof Error
                ? `${e.name}: ${e.message}\n  at ${importChain(e.stack ?? "", srcRoot, ".ts")}` : String(e);
        } finally {
            Error.stackTraceLimit = limit;
        }
        expect(failure, `entry ${entry}`).toBe("");
    });
});

/**
 * Emits every entry with the repo's tsconfig (emit switched on, no source maps) into `outDir`, as `tsc`
 * would for the CLI shim, and marks the directory as ESM. Throws on an emit that was skipped.
 */
function emitTree(outDir: string): void {
    const cfg = ts.getParsedCommandLineOfConfigFile(join(srcRoot, "..", "tsconfig.json"),
        { noEmit: false, outDir, rootDir: srcRoot, sourceMap: false, declaration: false },
        { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(String(d.messageText)); } });
    if (!cfg)
        throw new Error("tsconfig.json did not parse");
    const program = ts.createProgram(entries.map((e) => join(srcRoot, e)), cfg.options);
    const result = program.emit();
    if (result.emitSkipped)
        throw new Error("tsc emit skipped");
    writeFileSync(join(outDir, "package.json"), '{"type":"module"}\n');
}

/** Imports `file` as the first module of a fresh Worker's ESM loader; resolves "" on load, else the error. */
function loadInWorker(file: string, outDir: string): Promise<string> {
    const code = `const { parentPort } = require("node:worker_threads");
import(${JSON.stringify(pathToFileURL(file).href)}).then(
    () => parentPort.postMessage(""),
    (e) => parentPort.postMessage(e instanceof Error ? e.name + ": " + e.message + "\\n" + e.stack : String(e)));`;
    return new Promise<string>((resolve) => {
        const w = new Worker(code, { eval: true });
        let verdict: string | null = null;
        w.on("message", (m: string) => {
            verdict = m;
            void w.terminate();
        });
        w.on("error", (e) => {
            verdict ??= `worker error: ${e.message}`;
        });
        w.on("exit", (code) => {
            resolve(verdict ?? `worker exited with code ${code} and no verdict`);
        });
    }).then((v) => {
        if (v === "")
            return "";
        const [head] = v.split("\n");
        return `${head}\n  at ${importChain(v, outDir, ".js")}`;
    });
}

describe("single-entry module load, native Node ESM over the tsc emit", () => {
    let outDir = "";
    const verdicts = new Map<string, string>();

    beforeAll(async () => {
        outDir = realpathSync(mkdtempSync(join(tmpdir(), "djs-loadorder-")));   // the stacks carry real paths
        emitTree(outDir);
        const queue = [...entries];
        const lane = async (): Promise<void> => {
            for (let e = queue.shift(); e !== undefined; e = queue.shift())
                verdicts.set(e, await loadInWorker(join(outDir, e.replace(/\.ts$/, ".js")), outDir));
        };
        await Promise.all(Array.from({ length: Math.max(1, availableParallelism() >> 1) }, lane));
    }, 180_000);

    afterAll(() => {
        if (outDir !== "")
            rmSync(outDir, { recursive: true, force: true });
    });

    test.each(entries)("%s loads first into a fresh native ESM loader", (entry) => {
        expect(verdicts.get(entry), `entry ${entry}`).toBe("");
    });
});
