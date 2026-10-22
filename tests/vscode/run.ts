// Runs the integration tests in the VS Code installed on this Mac: tests/vscode/suite.cts in the fixture workspace
// trusted, then tests/vscode/restricted.cts in the same fixture opened untrusted (Restricted Mode).
//
//     npm run build && npm run test:vscode
//
// Never a downloaded VS Code: the installed app, launched with `--extensionTestsPath` (VS Code runs the suite's `run`
// and exits with its outcome), with a user-data directory and an extensions directory of the run's own, so the user's
// profile is never read or written (not @vscode/test-electron's runTests, which always adds
// `--disable-workspace-trust`). Those and the fixture workspace live in a fresh directory under $DJS_VSCODE_SCRATCH
// (default: the system temp directory), removed after the run. Keep that path short: VS Code listens on
// `<user-data-dir>/1.14-main.sock`, and a macOS socket path is limited to 103 characters (a longer one fails with
// `listen EINVAL`).
//
// Plain erasable TypeScript: Node runs it directly (type stripping).

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const VSCODE = "/Applications/Visual Studio Code.app/Contents/MacOS/Code";
const repo = fileURLToPath(new URL("../..", import.meta.url));
const scratch = process.env["DJS_VSCODE_SCRATCH"] ?? tmpdir();

/**
 * Writes the fixture workspace in a fresh directory under `scratch` and runs `suite` (dist/tests/vscode/<suite>.cjs)
 * in it: the folder trusted (workspace trust disabled), or opened untrusted, in Restricted Mode (trust on, the startup
 * prompt that would ask for it off). The directory is removed after the run.
 */
async function runSuite(suite: string, trusted: boolean): Promise<void> {
    const work = mkdtempSync(join(scratch, "djs-vscode-it-"));
    const ws = join(work, "workspace");
    mkdirSync(join(ws, ".vscode"), { recursive: true });
    mkdirSync(join(ws, "src"));
    // compile on pause off: the suite's unsaved edits stay uncompiled until it turns the setting on for its own part
    writeFileSync(join(ws, ".vscode", "settings.json"), JSON.stringify({
        "djs.ldc2Line": "ldc2 --deps -i -Isrc --vcolumns --d-version=Foo --preview=dip1000 -c -of/tmp/x.a %s",
        "djs.compileOnPause": false,
    }, null, 4));
    writeFileSync(join(ws, "src", "lib.d"), "module lib;\n/// The library's value.\nint libValue() { return 1; }\n"
        + "auto twice(int n) { return n * 2; }\nT same(T)(T v) { return v; }\n"
        + "int four() { auto r = twice(same(2)); return r; }\nalias SameInt = same!int;\n"
        + "int _hidden() { return 0; }\n");
    writeFileSync(join(ws, "src", "app.d"), "module app;\nimport lib;\n// perché è così: a non-ASCII comment\n"
        + "void main() { string s = \"è\"; int x = \"a\"; }\nversion (Foo) {} else static assert(0, \"no Foo\");\n");
    writeFileSync(join(work, "outside.d"), "module outside;\nvoid f() {}\n");   // in no workspace folder
    const userData = join(work, "user-data");
    if (!trusted) {
        mkdirSync(join(userData, "User"), { recursive: true });
        writeFileSync(join(userData, "User", "settings.json"),
            JSON.stringify({ "security.workspace.trust.startupPrompt": "never" }, null, 4));
    }
    try {
        const code = await new Promise<number | null>((done, fail) => {
            spawn(VSCODE, [ws, "--user-data-dir", userData, "--extensions-dir", join(work, "extensions"),
                "--disable-extensions", ...(trusted ? ["--disable-workspace-trust"] : []), "--skip-welcome",
                "--skip-release-notes", "--disable-updates", "--no-cached-data", `--extensionDevelopmentPath=${repo}`,
                `--extensionTestsPath=${join(repo, "dist", "tests", "vscode", `${suite}.cjs`)}`],
            { stdio: "inherit" }).on("error", fail).on("exit", done);
        });
        if (code !== 0)
            throw new Error(`djs-vscode integration test, ${suite}: failed (exit ${code})`);
        console.log(`djs-vscode integration test, ${suite}: passed`);
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

await runSuite("suite", true);
await runSuite("restricted", false);
