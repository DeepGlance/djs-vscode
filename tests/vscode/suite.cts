// The integration test, run inside VS Code's extension host by tests/vscode/run.ts (the `extensionTestsPath`).
//
// The workspace is the fixture run.ts writes: `.vscode/settings.json` with a build-tool-shaped djs.ldc2Line (-Isrc,
// --d-version=Foo, -i and --deps to be dropped) and compile on pause off, src/lib.d, src/app.d with one error after a
// two-byte character on its line (dmd's byte column 40 is VS Code's character 38). Opening app.d activates the
// extension and compiles it with no edit and no save, the session's first compile, fresh (`no kept state`, `, fresh` in
// the status bar), its error on the document; an outline asked before that compile waits for it; the worker's compile
// cache is active, in the extension's global storage, and written. An edit adds a
// second error and the save compiles, kept by the worker's engine. The test checks the diagnostics VS Code holds:
// lines, UTF-16 characters, the version flag reaching the compiler (no `no Foo`), the import found through the
// relative -Isrc made absolute. A second save of the same content is kept and leaves the same diagnostics. Showing
// lib.d, which that compile analysed under -i, compiles nothing. Then VS Code's own
// hover and definition commands on `libValue` reach the extension's providers: the signature and the doc comment of
// lib.d, the declaration in lib.d. The TextMate grammar tokenises app.d (`_workbench.captureSyntaxTokens`, VS Code's
// own colorizer test command), and VS Code's semantic-tokens commands reach the extension's provider: djs's legend, and
// tokens that decode to `libValue` as a function and `lib` as a namespace. VS Code's inlay-hints command reaches the
// extension's provider on lib.d (compiled under -i): an inferred return type, a template's instance count, a variable's
// type, two parameter names; an unsaved edit of lib.d moves them with it. The `else` branch of app.d's `version (Foo)`
// is dimmed. VS Code's code-lens command reaches the extension's provider on lib.d: the lens over `same!int`, whose
// command (djs.showExpansion) peeks at the instance in a `djs-expansion:` document, coloured as D. djs.showAst at a
// cursor in lib.d's `libValue` opens lib.d's AST view beside it, a `djs-ast:` document coloured as D, holding the
// declaration and revealing it; go-to-definition from the view reaches the declaration in lib.d. VS Code's
// document-symbol command reaches the extension's outline of lib.d, its reference command the references of `libValue`
// in both files. The imports explorer lists the root, app; the instances explorer lists lib.d's `same` with its one
// instance. An unsaved edit makes the hover the worker's stale reason, and the semantic-tokens command rejects with the
// provider's CancellationError (the editor's request, the same function, then keeps its tokens). A D file next to the
// workspace, in no folder, is not compiled and the status bar says so. Then compile on pause, turned on: an unsaved
// edit of app.d compiles from its buffer, kept, its error on the document with no save, and the status bar says
// `buffer` (an outline asked before that compile ran waits for it); a typed `lib.` completes, through VS Code's
// completion command, with lib.d's `libValue`, a function, its signature and doc comment's summary, in djs's order,
// and so does a request without a dot, among the imported modules' names, after the module's; a call typed gets
// lib.d's `twice` from VS Code's signature-help command, which waits for its pause compile. VS Code's rename command
// renames `libValue` in both files, which saved compile with no new error. Last, app.d saved without errors gives
// lib.d's unused functions as hints tagged Unnecessary, which the setting turned off clears.

import vscode = require("vscode");
import assert = require("node:assert/strict");
import fs = require("node:fs");

async function diagnosticsWithin(uri: vscode.Uri, count: number, ms: number): Promise<vscode.Diagnostic[]> {
    const until = Date.now() + ms;
    for (;;) {
        const d = vscode.languages.getDiagnostics(uri);
        if (d.length >= count || Date.now() > until)
            return d;
        await new Promise((r) => setTimeout(r, 200));
    }
}

type Api = {
    whenIdle(): Promise<void>;
    lastCompile(): { mode: string; reason: string } | undefined;
    statusText(): string;
    dimmedRanges(uri: string): vscode.Range[];
    explorerItems(view: "instances" | "imports"): Promise<string[]>;
    compileCacheDir(): string | null;
};

/** Inlay hints as the assertions read them: line, character, label. */
async function hintsOf(uri: vscode.Uri, lines: number): Promise<string[]> {
    const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>("vscode.executeInlayHintProvider", uri,
        new vscode.Range(0, 0, lines, 0));
    return hints.map((h) => `${h.position.line}:${h.position.character} `
        + (typeof h.label === "string" ? h.label : h.label.map((p) => p.value).join("")));
}

/** The diagnostics as the assertions read them: range, severity, message. */
function shown(diags: readonly vscode.Diagnostic[]): string[] {
    return diags.map((d) => `${d.range.start.line}:${d.range.start.character}-${d.range.end.character} `
        + `${d.severity} ${d.message}`);
}

/** Waits until a compile after `before` (a `lastCompile()` value) has returned, or `ms` passed. */
async function compiledAfter(api: Api, before: unknown, ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (api.lastCompile() === before && Date.now() <= until)
        await new Promise((r) => setTimeout(r, 200));
    await api.whenIdle();
}

async function run(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders![0]!;
    const uri = vscode.Uri.joinPath(folder.uri, "src", "app.d");
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    const ext = vscode.extensions.getExtension<Api>("deepglance.djs-vscode");
    assert.ok(ext, "the extension is loaded");
    const api = await ext.activate();

    // compile at open: the outline, asked before the compile, waits for it; then the error, with no edit and no save
    const openOutline = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider", uri);
    assert.ok(openOutline.some((x) => x.name === "main"), JSON.stringify(openOutline.map((x) => x.name)));
    await compiledAfter(api, undefined, 60000);
    assert.deepEqual(api.lastCompile(), { mode: "fresh", reason: "no kept state" });
    assert.match(api.statusText(), /, disk, fresh$/);
    assert.deepEqual(shown(vscode.languages.getDiagnostics(uri)),
        ["3:38-39 0 cannot implicitly convert expression `\"a\"` of type `string` to `int`"]);
    // the compile cache: active in the worker of VS Code's Node, in the global storage, written at the worker's start
    const cache = api.compileCacheDir();
    assert.match(cache ?? "null", /[/\\]compile-cache[/\\][^/\\]+-node[^/\\]+[/\\]v\d/);
    assert.ok(fs.readdirSync(cache!).length > 0, cache!);

    const atOpen = api.lastCompile();
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(doc.lineCount - 1, 0), "void h() { auto z = libValue() + \"q\"; }\n");
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.ok(await doc.save());
    await compiledAfter(api, atOpen, 60000);
    const diags = await diagnosticsWithin(uri, 2, 60000);

    assert.deepEqual(shown(diags), [
        "3:38-39 0 cannot implicitly convert expression `\"a\"` of type `string` to `int`",
        "5:31-32 0 incompatible types for `(libValue()) + (\"q\")`: `int` and `string`",
    ]);
    assert.ok(diags.every((d) => d.source === "djs"));
    assert.deepEqual(api.lastCompile(), { mode: "kept", reason: "" });
    assert.match(api.statusText(), /, disk$/);

    // the document is not dirty: `doc.save()` would not save it, the Save command does
    const first = api.lastCompile();
    await vscode.commands.executeCommand("workbench.action.files.save");
    await compiledAfter(api, first, 60000);
    assert.deepEqual(api.lastCompile(), { mode: "kept", reason: "" });
    assert.doesNotMatch(api.statusText(), /fresh/);
    assert.deepEqual(shown(vscode.languages.getDiagnostics(uri)), shown(diags));

    // hover and go-to-definition through VS Code's commands, on `libValue` in the line the edit added
    const call = new vscode.Position(doc.lineCount - 2, doc.lineAt(doc.lineCount - 2).text.indexOf("libValue") + 2);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", uri, call);
    const hoverText = (hs: vscode.Hover[]): string => hs.flatMap((h) => h.contents)
        .map((c) => (typeof c === "string" ? c : c.value)).join("\n");
    assert.match(hoverText(hovers), /```d\nint libValue\(\)\n```/);
    assert.match(hoverText(hovers), /The library's value\./);
    const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        "vscode.executeDefinitionProvider", uri, call);
    assert.equal(defs.length, 1);
    const def = defs[0]!;
    const target = "targetUri" in def ? { uri: def.targetUri, range: def.targetRange } : def;
    assert.equal(target.uri.fsPath, vscode.Uri.joinPath(folder.uri, "src", "lib.d").fsPath);
    assert.deepEqual([target.range.start.line, target.range.start.character, target.range.end.character], [2, 4, 12]);

    // the outline of lib.d (compiled under -i) through VS Code's command
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider", vscode.Uri.joinPath(folder.uri, "src", "lib.d"));
    assert.deepEqual(symbols.map((x) => `${x.name} ${x.kind}`), ["lib 1", "libValue 11", "twice 11", "same 11",
        "four 11", "SameInt 11", "_hidden 11"]);
    assert.equal(symbols[1]!.detail, "int()");
    assert.deepEqual([symbols[1]!.selectionRange.start.line, symbols[1]!.selectionRange.start.character], [2, 4]);

    // the references of `libValue` through VS Code's command: its declaration in lib.d, the call in app.d
    const references = await vscode.commands.executeCommand<vscode.Location[]>("vscode.executeReferenceProvider",
        uri, call);
    assert.deepEqual(references.map((l) => `${l.uri.path.split("/").pop()}:${l.range.start.line}:`
        + `${l.range.start.character}`), [`app.d:${call.line}:${call.character - 2}`, "lib.d:2:4"]);

    // inlay hints on lib.d through VS Code's command; an unsaved line above them moves them down
    const libUri = vscode.Uri.joinPath(folder.uri, "src", "lib.d");
    const libDoc = await vscode.workspace.openTextDocument(libUri);
    const expected = ["3:17 -> int", "4:6 1 instance", "5:19 : int", "5:28 n:", "5:33 v:"];
    assert.deepEqual(await hintsOf(libUri, libDoc.lineCount), expected);
    const libEdit = new vscode.WorkspaceEdit();
    libEdit.insert(libUri, new vscode.Position(0, 0), "// unsaved\n");
    assert.ok(await vscode.workspace.applyEdit(libEdit));
    assert.deepEqual(await hintsOf(libUri, libDoc.lineCount),
        expected.map((h) => h.replace(/^\d+/, (l) => String(Number(l) + 1))));
    const beforeShown = api.lastCompile();
    await vscode.window.showTextDocument(libDoc);
    await vscode.commands.executeCommand("workbench.action.files.revert");
    assert.equal(libDoc.isDirty, false);
    await vscode.window.showTextDocument(doc);
    await new Promise((r) => setTimeout(r, 1000));   // past the open delay: lib.d, analysed under -i, is not compiled
    await api.whenIdle();
    assert.equal(api.lastCompile(), beforeShown);

    // the `else` branch of `version (Foo)`, which -d-version=Foo did not choose, is dimmed
    const versionLine = doc.lineAt(4).text;
    const dimUntil = Date.now() + 10000;
    while (api.dimmedRanges(uri.toString()).length === 0 && Date.now() <= dimUntil)
        await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(api.dimmedRanges(uri.toString()).map((r) => [r.start.line, r.start.character, r.end.line,
        r.end.character]), [[4, versionLine.indexOf("else") + 4, 4, versionLine.length]]);

    // an expansion peek: the code lens over lib.d's `same!int` runs djs.showExpansion at it, which opens the
    // instance's `djs-expansion:` document in a peek (VS Code loads its text when the peek resolves the location)
    // a lens is clicked in its own editor, and the command shows no peek in an editor that is not the active one
    await vscode.window.showTextDocument(libDoc);
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", libUri);
    const lens = lenses.find((l) => l.command?.title === "instance same!int");
    assert.ok(lens?.command, JSON.stringify(lenses.map((l) => l.command?.title)));
    const expUri = await vscode.commands.executeCommand<vscode.Uri | undefined>(lens.command.command,
        ...(lens.command.arguments ?? []));
    assert.ok(expUri !== undefined && expUri.scheme === "djs-expansion");
    const peekUntil = Date.now() + 10000;
    const opened = (): vscode.TextDocument | undefined =>
        vscode.workspace.textDocuments.find((d) => d.uri.toString() === expUri.toString());
    while (opened() === undefined && Date.now() <= peekUntil)
        await new Promise((r) => setTimeout(r, 100));
    const expansion = opened();
    assert.ok(expansion, "the peek opened the expansion's document");
    assert.equal(expansion.languageId, "d");
    assert.match(expansion.getText(), /int same\(int v\)/);
    await vscode.commands.executeCommand("closeReferenceSearch");

    // the AST view of lib.d, opened at a cursor in `libValue`, which it reveals; go-to-definition from the view's
    // `libValue` reaches its declaration in lib.d
    const libEditor = await vscode.window.showTextDocument(libDoc);
    const inLibValue = new vscode.Position(2, libDoc.lineAt(2).text.indexOf("libValue") + 3);
    libEditor.selection = new vscode.Selection(inLibValue, inLibValue);
    const astUri = await vscode.commands.executeCommand<vscode.Uri | undefined>("djs.showAst");
    assert.ok(astUri !== undefined && astUri.scheme === "djs-ast");
    const astEditor = vscode.window.activeTextEditor;
    assert.ok(astEditor !== undefined && astEditor.document.uri.toString() === astUri.toString());
    const astDoc = astEditor.document;
    assert.equal(astDoc.languageId, "d");
    assert.match(astDoc.getText(), /int libValue\(\)/);
    assert.match(astDoc.lineAt(astEditor.selection.active.line).text, /libValue/);
    const astLine = astDoc.getText().split("\n").findIndex((l) => /int libValue\(\)/.test(l));
    const inView = new vscode.Position(astLine, astDoc.lineAt(astLine).text.indexOf("libValue") + 2);
    const astDefs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        "vscode.executeDefinitionProvider", astUri, inView);
    assert.equal(astDefs.length, 1, JSON.stringify(astDefs));
    const astDef = astDefs[0]!;
    const astTarget = "targetUri" in astDef ? { uri: astDef.targetUri, range: astDef.targetRange } : astDef;
    assert.equal(astTarget.uri.fsPath, libUri.fsPath);
    assert.deepEqual([astTarget.range.start.line, astTarget.range.start.character, astTarget.range.end.character],
        [2, 4, 12]);
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

    // the explorers: the imports hold the root, app; the instances lib.d's `same`, instantiated once
    const importItems = await api.explorerItems("imports");
    assert.ok(importItems.includes("app"), JSON.stringify(importItems));
    const instanceItems = await api.explorerItems("instances");
    assert.ok(instanceItems.some((l) => /same.*\(1\)$/.test(l)), JSON.stringify(instanceItems));
    await vscode.window.showTextDocument(doc);

    // the grammar: every token of app.d in `source.d`, `module` and `int` scoped as code-d's grammar scopes them
    const syntax = await vscode.commands.executeCommand<{ c: string; t: string }[]>("_workbench.captureSyntaxTokens",
        uri);
    assert.ok(syntax.length > 0 && syntax.every((x) => x.t.startsWith("source.d")), JSON.stringify(syntax.slice(0, 5)));
    assert.ok(syntax.some((x) => x.c === "module" && /keyword/.test(x.t)), JSON.stringify(syntax.slice(0, 5)));
    assert.ok(syntax.some((x) => x.c === "int" && /storage\.type/.test(x.t)));

    // semantic tokens through VS Code's commands: djs's legend, `libValue` a function, `lib` a namespace
    const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>(
        "vscode.provideDocumentSemanticTokensLegend", uri);
    assert.ok(legend.tokenTypes.includes("function") && legend.tokenModifiers.includes("declaration"));
    const semantic = await vscode.commands.executeCommand<vscode.SemanticTokens | undefined>(
        "vscode.provideDocumentSemanticTokens", uri);
    assert.ok(semantic !== undefined && semantic.data.length > 0);
    const decoded = new Map<string, string>();
    for (let i = 0, line = 0, character = 0; i < semantic.data.length; i += 5) {
        line += semantic.data[i]!;
        character = semantic.data[i] === 0 ? character + semantic.data[i + 1]! : semantic.data[i + 1]!;
        decoded.set(`${line}:${character}`, legend.tokenTypes[semantic.data[i + 3]!]!);
    }
    const nameAt = (p: vscode.Position): vscode.Position => doc.getWordRangeAtPosition(p)!.start;
    const callStart = nameAt(call);
    assert.equal(decoded.get(`${callStart.line}:${callStart.character}`), "function");
    assert.equal(decoded.get(`1:${doc.lineAt(1).text.indexOf("lib")}`), "namespace");
    const stale = new vscode.WorkspaceEdit();
    stale.insert(uri, new vscode.Position(0, 0), "// unsaved\n");
    assert.ok(await vscode.workspace.applyEdit(stale));
    const staleAt = new vscode.Position(call.line + 1, call.character);
    const staleHovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", uri,
        staleAt);
    assert.match(hoverText(staleHovers), /djs: the file changed since the last compile/);
    // the command runs the editor's own request (getDocumentSemanticTokens), which rethrows the provider's
    // CancellationError: the rejection the editor answers by keeping its tokens
    await assert.rejects(Promise.resolve(vscode.commands.executeCommand("vscode.provideDocumentSemanticTokens", uri)),
        (e: Error) => e.name === "Canceled" || /Canceled/.test(e.message));
    // `undo` acts on the focused editor, and VS Code's chat view can take the focus while the window starts: give it
    // back to app.d first (1 run in 5 left app.d dirty without this)
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand("undo");
    assert.equal(doc.isDirty, false);

    const outside = vscode.Uri.joinPath(folder.uri, "..", "outside.d");
    const odoc = await vscode.workspace.openTextDocument(outside);
    await vscode.window.showTextDocument(odoc);
    const oedit = new vscode.WorkspaceEdit();
    oedit.insert(outside, new vscode.Position(0, 0), "// edited\n");
    assert.ok(await vscode.workspace.applyEdit(oedit));
    const kept = api.lastCompile();
    assert.ok(await odoc.save());
    const notCompiled = "$(warning) djs: outside.d outside the workspace, not compiled";
    const until = Date.now() + 10000;
    while (api.statusText() !== notCompiled && Date.now() <= until)
        await new Promise((r) => setTimeout(r, 100));
    await api.whenIdle();
    assert.equal(api.statusText(), notCompiled);
    assert.equal(api.lastCompile(), kept);

    // compile on pause: an unsaved edit of app.d compiles from the buffer after the delay, kept (same flags as the
    // last save), and its error is on the document while it is still dirty
    await vscode.workspace.getConfiguration("djs").update("compileOnPause", true, vscode.ConfigurationTarget.Workspace);
    await vscode.window.showTextDocument(doc);
    const pause = new vscode.WorkspaceEdit();
    pause.insert(uri, new vscode.Position(doc.lineCount - 1, 0), "void k() { int w = \"b\"; }\n");
    assert.ok(await vscode.workspace.applyEdit(pause));
    // asked before the pause compile ran, the outline waits for it and has the new function
    const outline = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider", uri);
    assert.ok(outline.some((x) => x.name === "k"), JSON.stringify(outline.map((x) => x.name)));
    await compiledAfter(api, kept, 60000);
    assert.ok(doc.isDirty);
    assert.deepEqual(api.lastCompile(), { mode: "kept", reason: "" });
    assert.match(api.statusText(), /, buffer$/);
    const pauseDiags = shown(vscode.languages.getDiagnostics(uri));
    assert.ok(pauseDiags.includes(`${doc.lineCount - 2}:19-20 0 cannot implicitly convert expression \`"b"\` of type `
        + "`string` to `int`"), JSON.stringify(pauseDiags));

    // completion after a typed dot, through VS Code's command: lib.d's members from the last compile (when it has not
    // seen the line being typed, djs moves the position into the text it compiled)
    const typed = new vscode.WorkspaceEdit();
    const dotLine = doc.lineCount - 1;
    typed.insert(uri, new vscode.Position(dotLine, 0), "void m() { lib. }\n");
    assert.ok(await vscode.workspace.applyEdit(typed));
    const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
        "vscode.executeCompletionItemProvider", uri, new vscode.Position(dotLine, "void m() { lib.".length), ".");
    const labelOf = (i: vscode.CompletionItem): string => (typeof i.label === "string" ? i.label : i.label.label);
    const libValue = completions.items.find((i) => labelOf(i) === "libValue"
        && i.kind === vscode.CompletionItemKind.Function);
    assert.ok(libValue, JSON.stringify(completions.items.map((i) => `${labelOf(i)} ${i.kind}`)));
    assert.match(libValue.detail ?? "", /int libValue\(\)/);
    assert.match(String(libValue.documentation), /The library's value/);
    // djs's order, kept by each item's sortText (its index, compared lowercased as VS Code does): lib.d's names by
    // label, case ignored, a name with a leading `_` last
    const sortKey = (i: vscode.CompletionItem): string => (i.sortText ?? labelOf(i)).toLowerCase();
    const bySort = (items: vscode.CompletionItem[]): string[] => [...items]
        .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0)).map(labelOf);
    const libNames = ["four", "libValue", "same", "SameInt", "twice", "_hidden"];
    assert.deepEqual(bySort(completions.items).filter((l) => libNames.includes(l)), libNames);
    // without a dot, on request: the names in scope, lib.d's `libValue` among the imported modules' (djs's group 3)
    const inScope = await vscode.commands.executeCommand<vscode.CompletionList>(
        "vscode.executeCompletionItemProvider", uri, new vscode.Position(dotLine, "void m() { li".length));
    const imported = inScope.items.find((i) => labelOf(i) === "libValue"
        && i.kind === vscode.CompletionItemKind.Function);
    assert.ok(imported, JSON.stringify(inScope.items.map((i) => `${labelOf(i)} ${i.kind}`)));
    const order = bySort(inScope.items);
    assert.ok(order.indexOf("main") >= 0 && order.indexOf("main") < order.indexOf("libValue"), JSON.stringify(order));

    // signature help on a call just typed, through VS Code's command: asked before the pause compile ran, it waits for
    // it (the compile analyses past the open parenthesis) and gives lib.d's `twice`
    const callLine = doc.lineCount - 1;
    const typing = new vscode.WorkspaceEdit();
    typing.insert(uri, new vscode.Position(callLine, 0), "void s2() { auto q = twice(\n");
    assert.ok(await vscode.workspace.applyEdit(typing));
    const help = await vscode.commands.executeCommand<vscode.SignatureHelp | undefined>(
        "vscode.executeSignatureHelpProvider", uri, new vscode.Position(callLine, "void s2() { auto q = twice(".length),
        "(");
    assert.ok(help, "signature help answered");
    assert.equal(help.signatures[help.activeSignature]?.label, "int twice(int n)");
    assert.equal(help.activeParameter, 0);

    // leave app.d as saved: the setting off first, so that the revert compiles nothing
    await vscode.workspace.getConfiguration("djs").update("compileOnPause", false,
        vscode.ConfigurationTarget.Workspace);
    await api.whenIdle();
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand("workbench.action.files.revert");
    assert.equal(doc.isDirty, false);

    // rename `libValue` through VS Code's command, after a compile of the saved text (the reverted buffer's compile is
    // gone): one edit in each file; saved, they compile with the same two errors and nothing undefined
    const beforeRename = api.lastCompile();
    await vscode.commands.executeCommand("workbench.action.files.save");
    await compiledAfter(api, beforeRename, 60000);
    const renaming = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
        "vscode.executeDocumentRenameProvider", uri, call, "libNumber");
    assert.deepEqual(renaming.entries().map(([u, es]) => `${u.path.split("/").pop()} ${es.length}`).sort(),
        ["app.d 1", "lib.d 1"]);
    assert.ok(await vscode.workspace.applyEdit(renaming));
    const renamed = api.lastCompile();
    assert.ok(await vscode.workspace.saveAll(false));
    await compiledAfter(api, renamed, 60000);
    const afterRename = shown(vscode.languages.getDiagnostics(uri));
    assert.equal(afterRename.length, 2, JSON.stringify(afterRename));
    assert.ok(afterRename.every((d) => !d.includes("undefined identifier")), JSON.stringify(afterRename));
    assert.match(doc.lineAt(call.line).text, /libNumber\(\)/);

    // unused code: app.d without its errors, saved: lib.d's `four` and `_hidden` (nothing calls them) and `twice` (only
    // `four` does) are hints tagged Unnecessary; the setting off clears them
    const clean = new vscode.WorkspaceEdit();
    clean.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0),
        "module app;\nimport lib;\nvoid main() { int x = libNumber(); }\nversion (Foo) {} else static assert(0);\n");
    assert.ok(await vscode.workspace.applyEdit(clean));
    const beforeClean = api.lastCompile();
    assert.ok(await doc.save());
    await compiledAfter(api, beforeClean, 60000);
    const unusedOf = (): string[] => vscode.languages.getDiagnostics(libUri)
        .filter((d) => d.tags?.includes(vscode.DiagnosticTag.Unnecessary))
        .map((d) => `${d.range.start.line}:${d.range.start.character} ${d.severity} ${d.message}`);
    const unusedBy = Date.now() + 30000;
    while (unusedOf().length < 3 && Date.now() <= unusedBy)
        await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(unusedOf(), [
        "3:5 3 unused in this build: function lib.twice, only referenced from unreachable code",
        "5:4 3 unused in this build: function lib.four, unreferenced",
        "7:4 3 unused in this build: function lib._hidden, unreferenced"]);
    await vscode.workspace.getConfiguration("djs").update("unusedCode", false, vscode.ConfigurationTarget.Workspace);
    assert.deepEqual(unusedOf(), []);
}

export = { run };
