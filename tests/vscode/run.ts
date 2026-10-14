// Runs the integration test (tests/vscode/suite.cts) in the VS Code installed on this Mac.
//
//     npm run build && npm run test:vscode
//
// Never a downloaded VS Code (no .vscode-test directory): the installed app, with a user-data directory and an
// extensions directory of the run's own, so the user's profile is never read or written. Those and the fixture
// workspace live in a fresh directory under $DJS_VSCODE_SCRATCH (default: the system temp directory), removed
// after the run. Keep that path short: VS Code listens on `<user-data-dir>/1.14-main.sock`, and a macOS socket
// path is limited to 103 characters (a longer one fails with `listen EINVAL`).
//
// Plain erasable TypeScript: Node runs it directly (type stripping).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const VSCODE = "/Applications/Visual Studio Code.app/Contents/MacOS/Code";
const repo = fileURLToPath(new URL("../..", import.meta.url));
const work = mkdtempSync(join(process.env["DJS_VSCODE_SCRATCH"] ?? tmpdir(), "djs-vscode-it-"));

const ws = join(work, "workspace");
mkdirSync(join(ws, ".vscode"), { recursive: true });
mkdirSync(join(ws, "src"));
// compile on pause off: the suite's unsaved edits must stay uncompiled until it turns the setting on for its own part
writeFileSync(join(ws, ".vscode", "settings.json"), JSON.stringify({
    "djs.ldc2Line": "ldc2 --deps -i -Isrc --vcolumns --d-version=Foo --preview=dip1000 -c -of/tmp/x.a %s",
    "djs.compileOnPause": false,
}, null, 4));
writeFileSync(join(ws, "src", "lib.d"), "module lib;\n/// The library's value.\nint libValue() { return 1; }\n"
    + "auto twice(int n) { return n * 2; }\nT same(T)(T v) { return v; }\n"
    + "int four() { auto r = twice(same(2)); return r; }\nalias SameInt = same!int;\n");
writeFileSync(join(ws, "src", "app.d"), "module app;\nimport lib;\n// perché è così: a non-ASCII comment\n"
    + "void main() { string s = \"è\"; int x = \"a\"; }\nversion (Foo) {} else static assert(0, \"no Foo\");\n");
writeFileSync(join(work, "outside.d"), "module outside;\nvoid f() {}\n");   // in no workspace folder

try {
    await runTests({
        vscodeExecutablePath: VSCODE,
        extensionDevelopmentPath: repo,
        extensionTestsPath: join(repo, "dist", "tests", "vscode", "suite.cjs"),
        launchArgs: [ws, "--user-data-dir", join(work, "user-data"), "--extensions-dir", join(work, "extensions"),
            "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes"],
    });
    console.log("djs-vscode integration test: passed");
} finally {
    rmSync(work, { recursive: true, force: true });
}
