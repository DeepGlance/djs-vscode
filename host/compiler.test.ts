// Tests for the compiler worker (host/compiler.ts, host/worker.ts), run against the emit in dist/.
//
// THE PROTOCOL TEST compiles the edit list of the VS Code readiness mandate (tests/phobos/editloop.ts, sixteen
// successive versions of one program) in one worker, in order, and compares each reply with a fresh CLI process on
// the same file: the CLI's diagnostics, rendered as `file(line,column): Header message`, must be a prefix of the
// worker's (editor mode prints ldc2's output up to the first fatal point, then more, 10 §4.7). The worker compiles
// through the kept-module engine, so the edits after the first are kept compiles.
//
// THE ENGINE TESTS check the reply's `mode` and `reason`, and that a kept reply is the one a fresh worker gives.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
let compiler: Compiler;
let dir: string;

beforeAll(async () => {
    ({ DjsCompiler } = await import(new URL("host/compiler.js", DIST).href) as typeof import("./compiler.js"));
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
        const r = await compiler.compile(["--deps", "-c", "-o-", file]);
        expect(r.status).toBe(2);
        expect(r.output).toBe("djs: unsupported flag `--deps` (an ldc2 switch outside the shim's flag table (10 §4.2))\n");
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
});
