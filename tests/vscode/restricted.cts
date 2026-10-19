// The integration test of Restricted Mode, run by tests/vscode/run.ts in the suite's fixture opened untrusted (workspace
// trust on, its startup prompt off). The extension declares limited support: it activates, the grammar colours app.d,
// and opening app.d compiles it with no edit and no save, with the default line (`ldc2 -i -I<folder> -I<folder>/src`)
// because VS Code ignores the workspace's djs.ldc2Line until the folder is trusted: its `--d-version=Foo` does not
// reach the compiler, so app.d's `static assert(0, "no Foo")` fires, and the status bar says `, default line,
// restricted`. The hover answers from that compile.

import vscode = require("vscode");
import assert = require("node:assert/strict");

type Api = {
    lastCompile(): { mode: string; reason: string } | undefined;
    statusText(): string;
    whenIdle(): Promise<void>;
};

async function run(): Promise<void> {
    assert.equal(vscode.workspace.isTrusted, false);
    const folder = vscode.workspace.workspaceFolders![0]!;
    const uri = vscode.Uri.joinPath(folder.uri, "src", "app.d");
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    assert.equal(doc.languageId, "d");
    const ext = vscode.extensions.getExtension<Api>("deepglance.djs");
    assert.ok(ext, "the extension is loaded");
    const api = await ext.activate();

    const until = Date.now() + 60000;
    while (api.lastCompile() === undefined && Date.now() <= until)
        await new Promise((r) => setTimeout(r, 200));
    await api.whenIdle();
    assert.deepEqual(api.lastCompile(), { mode: "fresh", reason: "no kept state" });
    assert.match(api.statusText(), /, disk, fresh, default line, restricted$/);
    const diags = vscode.languages.getDiagnostics(uri).map((d) => `${d.range.start.line} ${d.message}`);
    assert.ok(diags.some((d) => /^4 .*no Foo/.test(d)), JSON.stringify(diags));
    assert.ok(diags.some((d) => /^3 cannot implicitly convert/.test(d)), JSON.stringify(diags));

    const syntax = await vscode.commands.executeCommand<{ c: string; t: string }[]>("_workbench.captureSyntaxTokens",
        uri);
    assert.ok(syntax.some((x) => x.c === "module" && /keyword/.test(x.t)), JSON.stringify(syntax.slice(0, 5)));

    const at = new vscode.Position(3, doc.lineAt(3).text.indexOf("main") + 1);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", uri, at);
    const text = hovers.flatMap((h) => h.contents).map((c) => (typeof c === "string" ? c : c.value)).join("\n");
    assert.match(text, /void main\(\)/);
}

export = { run };
