// Tests for the compiler worker (host/compiler.ts, host/worker.ts), run against the emit in dist/.
//
// THE PROTOCOL TEST compiles the edit list of the VS Code readiness mandate (tests/phobos/editloop.ts, sixteen
// successive versions of one program) in one worker, in order, and compares each reply with a fresh CLI process on
// the same file: the CLI's diagnostics, rendered as `file(line,column): Header message`, must be a prefix of the
// worker's (editor mode prints ldc2's output up to the first fatal point, then more, 10 §4.7). The worker compiles
// through the kept-module engine, so the edits after the first are kept compiles.
//
// THE ENGINE TESTS check the reply's `mode` and `reason`, and that a kept reply is the one a fresh worker gives.
//
// THE ERROR COUNT: what the status bar reports (`distinctDiagnostics`, `shownErrors`) against the reply's `errors`.
//
// THE COMPILE-CACHE TESTS check that a worker asked for a cache directory enables it, writes it and accepts it at the
// next start, and that prepareCompileCache removes only other versions' caches.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { EDITS } from "../tests/phobos/editloop.js";
import type { DjsCompiler as Compiler } from "./compiler.js";
import type { CompileReply, Severity } from "./protocol.js";

const DIST = new URL("../dist/", import.meta.url);
const HEADER: Record<Severity, string> = { error: "Error: ", warning: "Warning: ", deprecation: "Deprecation: ",
    tip: "  Tip: " };

/** The reply's diagnostics as dmd prints them with `-vcolumns -verrors=simple`. */
function render(r: CompileReply): string[] {
    const loc = (file: string | null, l: number, c: number): string =>
        file === null ? "" : `${file}(${l}${c ? `,${c}` : ""}): `;
    return r.diagnostics.flatMap((d) => [
        `${loc(d.file, d.dmdLine, d.dmdColumn)}${HEADER[d.severity]}${d.message}`,
        ...d.supplemental.map((s) => `${loc(s.file, s.dmdLine, s.dmdColumn)}       ${s.message}`),
    ]);
}

/** What the editor reads from a reply: everything but the timing, the memory and the engine's own fields. */
function shown(r: CompileReply): unknown {
    return { status: r.status, errors: r.errors, warnings: r.warnings, diagnostics: r.diagnostics, output: r.output };
}

let DjsCompiler: typeof Compiler;
let distinctDiagnostics: typeof import("./compiler.js").distinctDiagnostics;
let shownErrors: typeof import("./compiler.js").shownErrors;
let errorCountNote: typeof import("./compiler.js").errorCountNote;
let compiler: Compiler;
let dir: string;

beforeAll(async () => {
    const host = await import(new URL("host/compiler.js", DIST).href) as typeof import("./compiler.js");
    ({ DjsCompiler, distinctDiagnostics, shownErrors, errorCountNote } = host);
    compiler = new DjsCompiler();
    dir = mkdtempSync(join(tmpdir(), "djs-vscode-host-"));
});

afterAll(async () => {
    await compiler.dispose();
    rmSync(dir, { recursive: true, force: true });
});

describe("DjsCompiler", () => {
    test("the edit list: each warm reply's diagnostics start with a fresh CLI's", async () => {
        const file = join(dir, "prog.d");
        const cli = new URL("src/djs.js", DIST).pathname;
        for (const [i, text] of EDITS.entries()) {
            writeFileSync(file, text);
            const r = await compiler.compile(["-c", "-o-", "-verrors=0", file]);
            let stderr = "";
            try {
                execFileSync(process.execPath, ["--stack-size=7600", cli, "-c", "-o-", "-verrors=0", "-vcolumns",
                    "-verrors=simple", file], { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
            } catch (e) {
                stderr = (e as { stderr: string }).stderr;
            }
            const fresh = stderr.split("\n").filter((l) => l !== "");
            expect(r.status, `e${i + 1}`).toBe(0);
            expect(render(r).slice(0, fresh.length), `e${i + 1}`).toEqual(fresh);
            expect(r.errors > 0, `e${i + 1}`).toBe(fresh.length > 0);
        }
    }, 600000);

    test("a refused switch: status 2 and the shim's line in the output; the worker serves the next call", async () => {
        const file = join(dir, "ok.d");
        writeFileSync(file, "module ok;\n");
        const r = await compiler.compile(["--makedeps", "-c", "-o-", file]);
        expect(r.status).toBe(2);
        expect(r.output).toBe("djs: unsupported flag `--makedeps` (an ldc2 switch outside the shim's flag table (10 §4.2))\n");
        const ok = await compiler.compile(["-c", "-o-", file]);
        expect([ok.status, ok.errors, ok.diagnostics.length]).toEqual([0, 0, 0]);
    });

    test("pragma(msg) goes to the output; a supplemental joins the diagnostic before it", async () => {
        const file = join(dir, "sup.d");
        writeFileSync(file, "module sup;\npragma(msg, \"hello\");\nvoid f(int) {}\nvoid g() { f(\"x\"); }\n");
        const r = await compiler.compile(["-c", "-o-", "-verrors=0", file]);
        expect(r.output).toBe("hello\n");
        expect(r.diagnostics.length).toBe(1);
        expect(r.diagnostics[0]!.start).toEqual({ line: 3, character: 12 });
        expect(r.diagnostics[0]!.supplemental.length).toBeGreaterThan(0);
    });

    test("the same arguments again: kept, with the first compile's diagnostics and output", async () => {
        const lib = join(dir, "klib.d");
        const file = join(dir, "kapp.d");
        writeFileSync(lib, "module klib;\nint libValue() { return 1; }\n");
        writeFileSync(file, "module kapp;\nimport klib;\npragma(msg, \"hi\");\nvoid f(int) {}\n"
            + "void g() { f(\"x\"); string s = libValue(); }\n");
        const args = ["-c", "-o-", "-verrors=0", `-I${dir}`, file];
        const first = await compiler.compile(args);
        const again = await compiler.compile(args);
        expect([again.mode, again.reason]).toEqual(["kept", ""]);
        expect(again.stats.replayed).toBeGreaterThan(0);
        expect(first.diagnostics.length).toBe(2);
        expect(shown(again)).toEqual(shown(first));
    });

    test("a refused flag: fresh with the engine's reason, on every call", async () => {
        const file = join(dir, "ok.d");
        writeFileSync(file, "module ok;\n");
        for (let i = 0; i < 2; i++) {
            const r = await compiler.compile(["-c", "-o-", "-main", file]);
            expect([r.status, r.mode, r.reason]).toEqual([0, "fresh", "refused flag -main: -main adds a module"]);
        }
    });

    test("an edited root: kept, and what a fresh worker gives", async () => {
        const lib = join(dir, "elib.d");
        const file = join(dir, "eapp.d");
        writeFileSync(lib, "module elib;\nint libValue() { return 1; }\n");
        const args = ["-c", "-o-", "-verrors=0", `-I${dir}`, file];
        writeFileSync(file, "module eapp;\nimport elib;\nint g() { return libValue(); }\n");
        expect((await compiler.compile(args)).errors).toBe(0);
        writeFileSync(file, "module eapp;\nimport elib;\nint g() { return libValue(); }\n"
            + "void h() { string s = libValue() + 1; }\n");
        const edited = await compiler.compile(args);
        expect(edited.mode).toBe("kept");
        const fresh = new DjsCompiler();
        try {
            const reference = await fresh.compile(args);
            expect(reference.mode).toBe("fresh");
            expect(edited.errors).toBe(1);
            expect(shown(edited)).toEqual(shown(reference));
        } finally {
            await fresh.dispose();
        }
    });

    test("the compile cache: active in the worker when asked, written at its start, accepted at the next", async () => {
        // a worker's environment is a copy of this thread's: a developer's own NODE_COMPILE_CACHE would reach it
        const saved = process.env["NODE_COMPILE_CACHE"];
        delete process.env["NODE_COMPILE_CACHE"];
        const plain = new DjsCompiler();
        try {
            await plain.legend();
            expect(plain.compileCacheDir()).toBeNull();
        } finally {
            await plain.dispose();
            if (saved !== undefined)
                process.env["NODE_COMPILE_CACHE"] = saved;
        }
        const cache = join(dir, "compile-cache");
        /** The cache's entries after one worker's start: name, modification time, content hash. */
        const start = async (): Promise<string[]> => {
            const c = new DjsCompiler(undefined, cache);
            try {
                await c.legend();
                const active = c.compileCacheDir()!;
                expect(active.startsWith(`${cache}/`)).toBe(true);
                return readdirSync(active).map((n) => `${n} ${statSync(join(active, n)).mtimeMs} `
                    + createHash("sha1").update(readFileSync(join(active, n))).digest("hex"));
            } finally {
                await c.dispose();
            }
        };
        const written = await start();
        expect(written.length).toBeGreaterThan(0);
        expect(await start()).toEqual(written);   // accepted: Node writes back only an entry it rejected
    });

    test("prepareCompileCache: removes the other versions' caches, nothing else", async () => {
        const { prepareCompileCache } = await import(new URL("host/compiler.js", DIST).href) as
            typeof import("./compiler.js");
        const storage = join(dir, "storage");
        const root = join(storage, "compile-cache");
        const ours = `0.3.0-node${process.versions.node}`;
        for (const d of [ours, "0.2.0-node22.20.0", "0.3.0-node1.2.3"])
            mkdirSync(join(root, d, "v-arm64"), { recursive: true });
        writeFileSync(join(root, ours, "v-arm64", "entry"), "x");
        writeFileSync(join(root, "notes.txt"), "x");
        writeFileSync(join(storage, "state.json"), "{}");
        const p = prepareCompileCache(storage, "0.3.0");
        expect(p.dir).toBe(join(root, ours));
        await p.removed;
        expect(readdirSync(root).sort()).toEqual([ours, "notes.txt"]);
        expect(readdirSync(join(root, ours, "v-arm64"))).toEqual(["entry"]);
        expect(readdirSync(storage).sort()).toEqual(["compile-cache", "state.json"]);
        await prepareCompileCache(join(dir, "no-storage"), "0.3.0").removed;   // no compile-cache yet: nothing to do
    });
});

describe("the error count", () => {
    /** The reply's `errors`, its diagnostics, those shown, the errors shown (with `-de` when `de`). */
    async function counts(name: string, text: string, de = false): Promise<number[]> {
        const file = join(dir, `${name}.d`);
        writeFileSync(file, text);
        const r = await compiler.compile(["-c", "-o-", "-verrors=0", ...(de ? ["-de"] : []), file]);
        const shown = distinctDiagnostics(r.diagnostics);
        return [r.errors, r.diagnostics.length, shown.length, shownErrors(shown, de)];
    }

    test("an instance with errors used twice: dmd counts it again with no message", async () => {
        const text = `module twice;\nstruct S(T) { T x = "oops"; }\nvoid main() { S!int a; S!int b; }\n`;
        expect(await counts("twice", text)).toEqual([3, 2, 2, 2]);
    });

    test("an error in a template's code, reported once per instance: shown once", async () => {
        const text = "module each;\nvoid f(T)(T v) { undefinedThing(); }\nvoid main() { f(1); f(2L); }\n";
        expect(await counts("each", text)).toEqual([4, 4, 3, 3]);
    });

    test("the tooltip's note: only where fewer errors are shown than the compiler counted", () => {
        expect(errorCountNote(2, 3)).toBe("The compiler counted 3 errors: a template instance with errors counts again "
            + "at each use, a repeated message at each report.");
        expect(errorCountNote(2, 2)).toBe("");
        expect(errorCountNote(3, 1)).toBe("");      // -verrors=spec shows gagged errors it does not count
    });

    test("-de: a deprecation counts as an error", async () => {
        const text = "module dep;\ndeprecated void old() {}\nvoid main() { old(); }\n";
        expect(await counts("dep", text)).toEqual([0, 1, 1, 0]);
        expect(await counts("dep", text, true)).toEqual([1, 1, 1, 1]);
    });
});
