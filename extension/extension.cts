// The VS Code side: diagnostics on save and on a pause in typing for D files, compiled by djs in a worker thread, and
// hover, go-to-definition, completion after a dot, semantic tokens, inlay hints, the dimming of inactive branches,
// expansion peeks, the AST view and the instances and imports explorers on what the last compile analysed; the colours
// under them come from the TextMate grammar (syntaxes/d.tmLanguage.json, code-d's) and the editing rules from
// language-configuration.json, both declared in package.json.
//
// A CommonJS entry (VS Code's loader requires extensions); the host modules are ES modules, loaded by dynamic import.
// Per repository, the setting `djs.ldc2Line` holds the ldc2 command yab builds for the repository's target; the command
// line is planned from it by host/flags.ts (compile-defining flags kept, -i among them, build-only dropped), with the
// saved or edited file as the one root; the setting `djs.ldcRoot` puts `--djs-ldc=<root>` in front (an ldc2 install's
// import tree; empty, the default: the tree bundled with djs), and `djs.target` adds `-mtriple=<target>` when the line
// names none (empty, the default: the host's triple). One compile runs at a time; a save or a pause during a compile
// queues its file as a root, the queue an ordered set of files (one queued again keeps its place, and a save makes it a
// save's compile), so no document's latest text is lost to another's. The previous diagnostics stay until the new set
// arrives.
// Compile on pause (settings `djs.compileOnPause`, default on, and `djs.compileOnPauseDelay`, default 300 ms): an edit
// of the active editor's D document, of a workspace folder, restarts that document's timer, and when it fires the
// document is queued as a save queues it, nothing written to disk; an edit of another document (a replace in files, a
// checkout reloading documents) arms no timer. Every compile, a save's included, hands the worker the text of every
// open D document with unsaved edits (`texts`), read when the compile starts, not when it is queued: the compile sees
// what the editor shows (an imported module's buffer too), a compile in progress is not interrupted, and the next one
// compiles the latest text. The status bar says which text the root came from (`, buffer` or `, disk`); the tooltip and
// the output channel name the buffers handed. A change that leaves the document clean (a revert, an undo back to the
// saved text) restarts the timer as any edit does: the diagnostics of a buffer compile no longer describe what the
// editor shows. A save and a close clear the document's timer, a change of `djs.compileOnPause` every timer. A pause
// compile refreshes the per-document answers (tokens, hints, lenses, dimming) and the imports explorer; the AST views
// and the instances explorer, whose first request after a compile costs seconds on a large module, are asked again
// after a save's compile only (or the first compile after a worker died, which they show), and a view hidden at a
// pause compile when it becomes visible.
// The worker's kept-module engine makes a compile with the previous compile's flags cost the changed root only (a
// buffer's bytes compared with the kept module's); a compile it runs fresh says so in the status bar (`, fresh`, the
// reason in the tooltip) and in the output channel.
// Hover and go-to-definition on a D file of the workspace send the document's text with the position; the worker
// answers from its last compile (djs 10 §4.7, "Queries"), after any compile in progress but ahead of the requests
// queued (host/compiler.ts). An empty answer shows nothing; a document edited since that compile shows the worker's
// reason as the hover (positions would be wrong), and a definition gives nothing, until its next compile has run (a
// query waits for the compile in progress, not for one queued behind it).
// Completion (djs 10 §4.7, "Queries"; rung 1, member completion after a dot): on `.` and on request, the members
// visible after `expr.` at the cursor, from the last compile, stale by one compile by design: djs reads the expression
// from the document's current text and finds its scope through the same text move the hints use, so a half-typed
// line needs no compile of its own. Members of the type come first, then UFCS candidates, then built-in properties;
// a miss gives no items. A position not after `expr.` (identifier characters back to a `.`) asks nothing: VS Code
// asks a provider at every word typed, and the request would wait behind a compile in progress.
// Semantic tokens (djs 10 §4.7, "Queries"; setting `djs.semanticTokens`, default on) colour a D file of the workspace
// by what each identifier names, over the grammar's colours. The legend is djs's, which the worker sends when it
// starts (the worker starts at activation, so that the provider can be registered with it; a worker that cannot start
// is reported as a dead one, and the provider is registered after the next compile that returns). A document whose
// text is the compiled one gets djs's tokens. Any other miss of djs, a document edited since that compile (`stale`) or
// a file not in the last compile (another root's compile, another workspace folder's), gets a CancellationError, which
// VS Code (1.141, ModelSemanticColoring) takes as "keep the tokens you have": it keeps the previous answer, moved along
// with the edits by its own token store, and asks again at the next change; an answer of null would clear them, and
// the whole file would flash back to the grammar's colours at every keystroke, or at every save of another root. djs
// never sends positions for a text it did not compile. A compile that returns and a change of the setting tell VS
// Code to ask again (`onDidChangeSemanticTokens`).
// Inlay hints (djs 10 §4.7, "Queries"; settings `djs.inlayHints.types`, `.parameterNames` and `.instanceCounts`,
// default on) show the inferred types, the parameter names of a call's arguments and the templates' instance counts of
// a D file of the workspace. The provider asks the worker for the whole document's hints once per compile and keeps
// the answer with the text it is for, one per open document: VS Code asks again at every scroll and every edit. When
// the text has changed since, or djs missed (a document edited since the compile, a file not in the last compile), the
// kept hints serve, moved through the edits since the previous request (the common prefix and suffix of the two
// texts keep their hints, those inside the edited span go); VS Code 1.141 (InlayHintsFragments) clears a provider's
// hints when it throws, so the tokens' CancellationError would make them flash out at every keystroke. A compile that
// returns and a change of the settings tell VS Code to ask again (`onDidChangeInlayHints`).
// Dimming (settings `djs.dimInactiveCode`, default on, and `djs.inactiveCodeOpacity`, default 0.5): the branches of
// `version`, `debug` and `static if` the last compile did not choose get a decoration of reduced opacity, VS Code
// having no API for inactive code. It is applied to every visible D editor when a compile returns and to an editor
// when it becomes visible: djs's ranges when the text is the compiled one; when the file is not in the last compile
// (another root compiled), the ranges kept with the document's text if it is unchanged. A stale document gets
// nothing new: an editor already dimmed keeps the ranges VS Code moved with the edits (text typed at their edges is
// not taken in), one shown again after an edit has none until the next compile of it. A worker that dies drops the
// dimming and the hints with the analysis they came from.
// Expansion peeks (djs 10 §4.7, "Queries"): the command `djs.showExpansion`, on the selection (a cursor is an empty
// one) or on a code lens's site range, asks the worker what the last compile made of the innermost string mixin,
// template instance or folded value containing it and shows it in a peek, a read-only virtual document of the
// `djs-expansion:` scheme whose path ends in `.d` (the grammar colours it); this module keeps the texts of the last 32,
// since VS Code closes such a document and asks for it again. A miss says why in the status bar: the stale reason, or
// `no expansion here` (a document with unsaved edits is asked too: a pause compile may have read its buffer); a
// document edited or an editor left while djs answered gets no peek. Code lenses (setting `djs.expansionLenses`,
// default on) mark every site of a D file of the workspace (of nested sites the outermost), asked once per compile and
// kept with the text per open document as the hints are; when the text has changed since, or djs misses, the kept
// sites serve, moved through the edits (a site with an end inside the edited span goes), since VS Code drops a
// provider's lenses when it throws or answers nothing. A compile that returns and a change of the setting tell VS Code
// to ask again (`onDidChangeCodeLenses`); a worker that dies drops the lenses.
// The AST view (djs 10 §4.7, "Queries"): the command `djs.showAst` opens beside the editor a read-only virtual document
// of the `djs-ast:` scheme, one per source file, its path the source's with `.d` turned into `.ast.d` (the grammar
// colours it) and the source's URI as its query: djs's `queryAst` of the file's current text, the module as `-vcg-ast`
// prints it. A view costs a print of its module at its first request after a compile (labserver.d's, 5.8 MB: seconds in
// the worker, which serves one request at a time), so after a save's compile the visible views are asked again only
// once the visible D editors' tokens, hints and lenses of that compile are queued (`gateAstRefresh`), a pause compile
// does not reprint them, and a hidden view is asked when it becomes visible again. VS Code replaces such a large
// document whole, so a reprint keeps each editor's place through anchors on the declarations under its cursor and its
// top line (`refreshAstView`). This module keeps no view's text, only its entries, packed (host/ast.ts), until the view
// closes. A miss (a document edited since the compile, a file not in the last compile or only imported by it, a worker
// dead since the last compile) shows the reason as a D comment on the first line above the last good text, or the
// reason alone when there is none yet; positions in the view are then one line down from the entries'. The view's
// entries navigate both ways: go-to-definition in the view goes to the source of the innermost declaration holding the
// position, and the command reveals the declaration the cursor is in. While the view is stale those positions are the
// compiled text's.
// The explorers (djs 10 §4.7, "Queries"): two tree views in the Explorer, "D Instances" and "D Imports", from the last
// compile, read-only, asked again when a compile returns (the instances after a save's compile only; VS Code defers the
// request of a hidden view until it is shown) and empty while the worker is dead since the last compile. The imports
// are asked once per compile and shared: they also give the files whose templates the instances view lists (the modules
// of the compile inside a workspace folder; a title-bar toggle narrows them to the active editor's file). File names
// are compared resolved: djs names druntime's files through the configuration's import path
// (`.../bin/../import/object.d`).
import vscode = require("vscode");
import path = require("node:path");
import url = require("node:url");
import type { AstAnchor } from "../host/ast.js";
import type { DjsCompiler } from "../host/compiler.js";
import type {
    CompileReply, CompletionKind, Diagnostic as DjsDiagnostic, ExpansionSite, ImportModule, InlayHint as DjsInlayHint,
    InstanceSite, PackedAst, Position, Range, Severity, TemplateInstances, TokenLegend,
} from "../host/protocol.js";

type HostModules = {
    compiler: typeof import("../host/compiler.js");
    flags: typeof import("../host/flags.js");
    ast: typeof import("../host/ast.js");
};

const SEVERITY: Record<Severity, vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    deprecation: vscode.DiagnosticSeverity.Warning,
    tip: vscode.DiagnosticSeverity.Information,
};

let host: HostModules;
let compiler: DjsCompiler;
let collection: vscode.DiagnosticCollection;
let channel: vscode.OutputChannel;
let status: vscode.StatusBarItem;
let subscriptions: vscode.Disposable[];
/** Whether the semantic-tokens provider is registered (it needs the legend of a worker that started). */
let tokensRegistered = false;
/** The files each root's last compile put diagnostics on, cleared when that root compiles again. */
const reported = new Map<string, vscode.Uri[]>();
/** What queued a compile: a save, or a pause in typing (which refreshes less, see the header). */
type CompileCause = "save" | "pause";
/**
 * The roots to compile when the current compile returns, by file URI, in queue order: a root queued again keeps its
 * place (its text is read when its compile starts), and a save of a root queued by a pause makes it a save's compile.
 */
const queued = new Map<string, { folder: vscode.WorkspaceFolder; file: vscode.Uri; cause: CompileCause }>();
let busy = false;
/** Per document with edits not yet compiled (its URI): the compile-on-pause timer. */
const pauseTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** The engine's verdict on the last compile that returned a reply (for tests). */
let last: { mode: CompileReply["mode"]; reason: string } | undefined;
/** Resolves when the queue is empty and no compile runs; the integration test waits on it. */
let idleWaiters: (() => void)[] = [];
/** Fired when a compile returns or `djs.semanticTokens` changes: VS Code asks for every document's tokens again. */
const tokensChanged = new vscode.EventEmitter<void>();
/** The documents the providers answer for: D files on disk (the providers then check the workspace folder). */
const dFiles: vscode.DocumentSelector = { scheme: "file", language: "d" };
/** Counts the compiles that returned: a kept answer of the worker is current while the count is the same. */
let generation = 0;
/**
 * Counts the workers that died (`reportDeath`): a provider that awaited the worker writes nothing back when the count
 * moved, since the analysis its answer (or its miss) came from went with the worker.
 */
let deaths = 0;
/** Per open document (its URI): the last hints djs gave, with the text and the compile they are for. */
const keptHints = new Map<string, { text: string; generation: number; hints: DjsInlayHint[] }>();
/** Fired when a compile returns or a `djs.inlayHints` setting changes: VS Code asks for the hints again. */
const hintsChanged = new vscode.EventEmitter<void>();
/** Per open document: the last inactive ranges djs gave, with the text they are for. */
const keptInactive = new Map<string, { text: string; ranges: Range[] }>();
/** The dimming decoration, made from `djs.inactiveCodeOpacity`. */
let dimType: vscode.TextEditorDecorationType;
/** Per document: the ranges the dimming last applied to its editors (for tests). */
const dimmed = new Map<string, vscode.Range[]>();
/** The scheme of the expansions' virtual documents. */
const EXPANSION_SCHEME = "djs-expansion";
/**
 * Per virtual document (its URI): the expansion it shows, the last `EXPANSIONS_KEPT` only, the oldest dropped first.
 * Not dropped when VS Code closes the document: VS Code closes and asks again (`Open` from the peek, a closed editor
 * reopened).
 */
const expansions = new Map<string, string>();
const EXPANSIONS_KEPT = 32;
/** Counts the expansions shown: each gets a URI of its own. */
let expansionCount = 0;
/** Per open document: the last expansion sites djs gave, with the text and the compile they are for. */
const keptSites = new Map<string, { text: string; generation: number; sites: ExpansionSite[] }>();
/** Fired when a compile returns or `djs.expansionLenses` changes: VS Code asks for the code lenses again. */
const lensesChanged = new vscode.EventEmitter<void>();
/** The scheme of the AST views' virtual documents. */
const AST_SCHEME = "djs-ast";
/**
 * An open AST view: the entries of the last good answer djs gave (null before the first); `shift`, 1 when the view's
 * first line is a reason above that answer's text, else 0 (the entries' lines plus `shift` are the view's); how many
 * of its content requests are in flight; and what to run once the content of the next one to end is in the document
 * (the reveals after a reprint). The text itself is not kept here: it is the view's own, read back on a miss.
 */
interface AstView {
    entries: PackedAst | null;
    shift: number;
    providing: number;
    afterUpdate: (() => void)[];
}
/** The open AST views by URI; a view leaves when its document closes, which cancels its queued request. */
const astViews = new Map<string, AstView>();
/** The open AST views hidden when a compile returned (or the worker died): asked again when they become visible. */
const astDirty = new Set<string>();
/** The requests of a visible D editor that a compile makes VS Code send, which an AST view's reprint must not delay. */
type EditorRequest = "tokens" | "hints" | "lenses";
/**
 * The AST refresh of the last compile, waiting until the visible D editors' requests of that compile are in the
 * worker's queue (`requestQueued`, by `<uri> <kind>`), or `AST_GATE_MS` at most, for a request VS Code never sends.
 */
let astGate: { waiting: Set<string>; timer: ReturnType<typeof setTimeout>; open: () => void } | undefined;
const AST_GATE_MS = 2000;
/** What a view and the explorers say while the last worker that died has not compiled again. */
const WORKER_DIED = "The djs worker died: the next compile starts a new one.";
/** Fired with an AST view's URI: VS Code asks for its content again. */
const astChanged = new vscode.EventEmitter<vscode.Uri>();
/** The value of `generation` when the last worker died: the explorers stay empty until the next compile returns. */
let deadAt = -1;
/** The last compile's modules, asked once per compile and shared by the two explorers (`lastModules`). */
let keptModules: { generation: number; modules: Promise<ImportModule[] | string> } | undefined;
/** The file of the last D editor of the workspace that was active (the reverse imports, the instances' filter). */
let activeFile: string | undefined;
/** Whether the instances view shows the active editor's file only (its title-bar toggle). */
let instancesCurrentFileOnly = false;
const instancesChanged = new vscode.EventEmitter<void>();
const importsChanged = new vscode.EventEmitter<void>();
let instancesView: vscode.TreeView<InstanceNode>;
let importsView: vscode.TreeView<ImportNode>;

function isD(doc: vscode.TextDocument): boolean {
    return doc.uri.scheme === "file" && /\.(d|di)$/.test(doc.fileName);
}

function range(l: Range): vscode.Range {
    return new vscode.Range(l.start.line, l.start.character, l.end.line, l.end.character);
}

/**
 * djs diagnostics to VS Code's, grouped by file; a diagnostic without a file goes on the root's first line. A
 * diagnostic identical to an earlier one (same file, position, severity and text) is dropped: dmd reports a
 * deprecation inside a template once per instance, and the Problems panel would list each copy.
 */
function convert(reply: CompileReply, root: vscode.Uri): Map<string, vscode.Diagnostic[]> {
    const byFile = new Map<string, vscode.Diagnostic[]>();
    const seen = new Set<string>();
    for (const d of reply.diagnostics as DjsDiagnostic[]) {
        const identity = JSON.stringify([d.file, d.dmdLine, d.dmdColumn, d.severity, d.message]);
        if (seen.has(identity))
            continue;
        seen.add(identity);
        const uri = d.file === null ? root : vscode.Uri.file(d.file);
        let message = d.message;
        const related: vscode.DiagnosticRelatedInformation[] = [];
        for (const s of d.supplemental) {
            if (s.file === null)
                message += `\n${s.message}`;
            else
                related.push(new vscode.DiagnosticRelatedInformation(
                    new vscode.Location(vscode.Uri.file(s.file), range(s)), s.message));
        }
        const v = new vscode.Diagnostic(range(d), message, SEVERITY[d.severity]);
        v.source = "djs";
        if (d.severity === "deprecation")
            v.tags = [vscode.DiagnosticTag.Deprecated];
        if (related.length)
            v.relatedInformation = related;
        const key = uri.toString();
        byFile.set(key, [...(byFile.get(key) ?? []), v]);
    }
    return byFile;
}

/**
 * The text of every open D document with unsaved edits, by file path: what the compile reads instead of the disk (see
 * the header). Read when the compile starts, so a compile queued during another compiles the latest text.
 */
function unsavedTexts(): Record<string, string> {
    const texts: Record<string, string> = {};
    for (const doc of vscode.workspace.textDocuments) {
        if (isD(doc) && doc.isDirty)
            texts[doc.uri.fsPath] = doc.getText();
    }
    return texts;
}

async function compileOne(folder: vscode.WorkspaceFolder, file: vscode.Uri, cause: CompileCause): Promise<void> {
    const line = vscode.workspace.getConfiguration("djs", folder.uri).get<string>("ldc2Line", "").trim();
    const name = vscode.workspace.asRelativePath(file, false);
    if (line === "") {
        status.text = "$(warning) djs: no djs.ldc2Line";
        status.tooltip = "Set djs.ldc2Line to the ldc2 command line your build uses for this repository.";
        return;
    }
    const plan = host.flags.planFlags(host.flags.splitLine(line), folder.uri.fsPath);
    const config = vscode.workspace.getConfiguration("djs", folder.uri);
    const args = [...host.flags.ldcRootArgs(config.get<string>("ldcRoot", ""), folder.uri.fsPath), ...plan.args,
        ...host.flags.targetArgs(config.get<string>("target", ""), plan.args), file.fsPath];
    const texts = unsavedTexts();
    const buffers = Object.keys(texts).map((f) => vscode.workspace.asRelativePath(f, false));
    status.text = `$(sync~spin) djs: ${name}`;
    channel.appendLine(`djs ${args.join(" ")}`);
    let reply: CompileReply;
    try {
        reply = await compiler.compile(args, texts);
    } catch (e) {
        reportDeath(e);
        return;
    }
    if (!tokensRegistered)
        await registerTokens();
    if (reply.mode === "refused") {   // nothing compiled: the diagnostics and the analysis stay the previous compile's
        status.text = "$(error) djs: request refused";
        status.tooltip = reply.reason;
        channel.appendLine(`refused: ${reply.reason}`);
        channel.show(true);
        return;
    }
    last = { mode: reply.mode, reason: reply.reason };
    if (reply.output !== "")
        channel.append(reply.output);

    const rootKey = file.toString();
    for (const uri of reported.get(rootKey) ?? [])
        collection.delete(uri);
    const byFile = convert(reply, file);
    const uris: vscode.Uri[] = [];
    for (const [key, list] of byFile) {
        const uri = vscode.Uri.parse(key);
        collection.set(uri, list);
        uris.push(uri);
    }
    reported.set(rootKey, uris);

    const secs = (reply.wallMs / 1000).toFixed(1);
    const source = reply.fromBuffer.includes(file.fsPath) ? "buffer" : "disk";
    const fresh = reply.mode === "fresh" ? ", fresh" : "";
    if (reply.status === 0) {
        const errors = `${reply.errors} error${reply.errors === 1 ? "" : "s"} `;
        status.text = `${reply.errors === 0 ? "$(check)" : "$(error)"} djs: ${name} ${reply.errors === 0 ? "" : errors}`
            + `${secs} s, ${source}${fresh}`;
    } else {
        status.text = (reply.status === 2 ? "$(error) djs: unsupported flag" : "$(error) djs: internal error") + fresh;
        channel.show(true);
    }
    const why = reply.mode === "fresh" ? `Fresh compile: ${reply.reason}` : "";
    const from = buffers.length > 0 ? `Unsaved buffers, read in place of the disk: ${buffers.join(", ")}` : "";
    status.tooltip = [why, from, reply.output.slice(0, 2000)].filter((t) => t !== "").join("\n\n") || undefined;
    // the AST views and the instances explorer show WORKER_DIED since a death: the first compile after it, a pause's
    // too, refreshes them as a save's does
    const afterDeath = deadAt === generation;
    generation++;
    tokensChanged.fire();
    hintsChanged.fire();
    lensesChanged.fire();
    void dimVisible();
    importsChanged.fire();
    if (cause === "save" || afterDeath) {
        gateAstRefresh();
        instancesChanged.fire();
    } else {
        markHiddenAstViews();
    }
    const k = reply.stats;
    channel.appendLine(`status ${reply.status}, ${reply.errors} errors, ${reply.warnings} warnings, `
        + `${reply.fatals} fatal stops, ${reply.wallMs.toFixed(0)} ms, ${cause}, root from ${source}, `
        + `buffers ${buffers.length > 0 ? buffers.join(" ") : "none"}, `
        + `rss ${(reply.rssBytes / 2 ** 20).toFixed(0)} MiB, ${reply.mode}${fresh ? ` (${reply.reason})` : ""}, `
        + `units ${k.replayed} replayed ${k.run} run, modules ${k.modulesKept} kept ${k.modulesDropped} dropped, `
        + `plan ${k.planMs.toFixed(0)} ms`);
}

async function drain(): Promise<void> {
    busy = true;
    try {
        while (queued.size) {
            const [key, { folder, file, cause }] = queued.entries().next().value!;
            queued.delete(key);
            await compileOne(folder, file, cause);
        }
    } finally {
        busy = false;
        const waiters = idleWaiters;
        idleWaiters = [];
        for (const w of waiters)
            w();
    }
}

/** Queues a compile of `file` as the root, with `folder`'s command line (see `queued`), and starts the queue. */
function queue(folder: vscode.WorkspaceFolder, file: vscode.Uri, cause: CompileCause): void {
    const key = file.toString();
    const saved = cause === "save" || queued.get(key)?.cause === "save";
    queued.set(key, { folder, file, cause: saved ? "save" : "pause" });
    if (!busy)
        void drain();
}

/** Stops the compile-on-pause timer of the document `key` (a URI string), if one runs. */
function clearPause(key: string): void {
    clearTimeout(pauseTimers.get(key));
    pauseTimers.delete(key);
}

/**
 * An edit of the active editor's D document, of a workspace folder, with `djs.compileOnPause` on (re)starts its timer
 * of `djs.compileOnPauseDelay` ms; when it fires the document is queued as a save queues it (see the header). An edit
 * of another document (a replace in files, a checkout reloading documents) arms nothing: its text reaches the next
 * compile as an unsaved buffer. A document in no folder is left to the save, which says it is not compiled; an event
 * without content changes (a dirty flag that flipped) starts nothing.
 */
function onChange(e: vscode.TextDocumentChangeEvent): void {
    const doc = e.document;
    if (e.contentChanges.length === 0 || !isD(doc) || vscode.window.activeTextEditor?.document !== doc)
        return;
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const config = vscode.workspace.getConfiguration("djs", doc.uri);
    if (folder === undefined || !config.get<boolean>("compileOnPause", true))
        return;
    const key = doc.uri.toString();
    clearPause(key);
    pauseTimers.set(key, setTimeout(() => {
        pauseTimers.delete(key);
        queue(folder, doc.uri, "pause");
    }, Math.max(config.get<number>("compileOnPauseDelay", 300), 50)));
}

/**
 * A saved D file compiles with its workspace folder's `djs.ldc2Line`; its pause timer stops, the save compiling the
 * same text. A file in no folder (a Phobos module opened from the LDC tree) has no command line to compile with: the
 * status bar and the output channel say so, rather than borrowing another folder's flags, whose diagnostics would
 * describe a build that does not exist.
 */
function onSave(doc: vscode.TextDocument): void {
    if (!isD(doc))
        return;
    clearPause(doc.uri.toString());
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (folder === undefined) {
        status.text = `$(warning) djs: ${path.basename(doc.fileName)} outside the workspace, not compiled`;
        status.tooltip = `${doc.fileName} is in no workspace folder: djs compiles a saved file with its folder's `
            + "djs.ldc2Line.";
        channel.appendLine(`not compiled: ${doc.fileName} is in no workspace folder`);
        return;
    }
    queue(folder, doc.uri, "save");
}

/**
 * A worker that died or could not start, in the status bar and the output channel; the dimming, the inlay hints, the
 * expansion lenses and the explorers go with the analysis they came from, until the next compile. The next call starts
 * a new worker.
 */
function reportDeath(e: unknown): void {
    status.text = "$(error) djs: worker died";
    channel.appendLine(`worker died: ${e instanceof Error ? e.message : String(e)}`);
    keptInactive.clear();
    keptHints.clear();
    keptSites.clear();
    deaths++;
    deadAt = generation;
    for (const editor of vscode.window.visibleTextEditors)
        setDimmed(editor, []);
    hintsChanged.fire();
    lensesChanged.fire();
    instancesChanged.fire();
    importsChanged.fire();
    refreshAstViews();   // they show the death above their kept text
}

/** A query's reason worth the output channel: an internal error in the worker (not a plain "no symbol"). */
function logQueryError(reason: string): void {
    if (reason.startsWith("internal error"))
        channel.appendLine(`query failed: ${reason}`);
}

/**
 * The reply of a query, or null; a worker that dies while serving it (`DjsCompiler` rejects the call) is reported as
 * a compile's death is, in the status bar and the output channel, and the query gives nothing.
 */
async function ask<T>(query: () => Promise<T | null>): Promise<T | null> {
    try {
        return await query();
    } catch (e) {
        reportDeath(e);
        return null;
    }
}

/** The hover of a D file of the workspace: the worker's Markdown, the stale reason as text, else nothing. */
async function provideHover(doc: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken)
    : Promise<vscode.Hover | undefined> {
    if (!isD(doc) || vscode.workspace.getWorkspaceFolder(doc.uri) === undefined)
        return undefined;
    const r = await ask(() => compiler.hover(doc.uri.fsPath, pos.line, pos.character, doc.getText(),
        () => token.isCancellationRequested));
    if (r === null)
        return undefined;
    if (r.result === null) {
        logQueryError(r.reason);
        return r.stale ? new vscode.Hover(`djs: ${r.reason}`) : undefined;
    }
    return new vscode.Hover(new vscode.MarkdownString(r.result.markdown), range(r.result.range));
}

/** The declaration of the symbol under the cursor in a D file of the workspace, else nothing. */
async function provideDefinition(doc: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken)
    : Promise<vscode.Location | undefined> {
    if (!isD(doc) || vscode.workspace.getWorkspaceFolder(doc.uri) === undefined)
        return undefined;
    const r = await ask(() => compiler.definition(doc.uri.fsPath, pos.line, pos.character, doc.getText(),
        () => token.isCancellationRequested));
    if (r === null)
        return undefined;
    if (r.result === null) {
        logQueryError(r.reason);
        return undefined;
    }
    return new vscode.Location(vscode.Uri.file(r.result.file), range(r.result.range));
}

const COMPLETION_KINDS: Record<CompletionKind, vscode.CompletionItemKind> = {
    method: vscode.CompletionItemKind.Method,
    function: vscode.CompletionItemKind.Function,
    field: vscode.CompletionItemKind.Field,
    property: vscode.CompletionItemKind.Property,
    variable: vscode.CompletionItemKind.Variable,
    constant: vscode.CompletionItemKind.Constant,
    enumMember: vscode.CompletionItemKind.EnumMember,
    enum: vscode.CompletionItemKind.Enum,
    struct: vscode.CompletionItemKind.Struct,
    class: vscode.CompletionItemKind.Class,
    interface: vscode.CompletionItemKind.Interface,
    module: vscode.CompletionItemKind.Module,
    typeParameter: vscode.CompletionItemKind.TypeParameter,
};

/** Whether `pos` follows `expr.` on its line: identifier characters (D's, Unicode letters included) back to a `.`. */
function afterDot(doc: vscode.TextDocument, pos: vscode.Position): boolean {
    const before = doc.lineAt(pos.line).text.slice(0, pos.character);
    return /\.[\p{L}\p{N}_]*$/u.test(before);
}

/**
 * The completion of a D file of the workspace after `expr.` (see the header): djs's items from the last compile, kind,
 * signature and the doc comment's summary, ordered by group (members, UFCS candidates, built-in properties) then name,
 * each replacing the identifier typed after the dot. A position not after a dot, a miss of djs, a request VS Code
 * cancelled before its turn and a worker that died give nothing (undefined).
 */
async function provideCompletion(doc: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken)
    : Promise<vscode.CompletionItem[] | undefined> {
    if (!isD(doc) || vscode.workspace.getWorkspaceFolder(doc.uri) === undefined || !afterDot(doc, pos))
        return undefined;
    const r = await ask(() => compiler.completion(doc.uri.fsPath, doc.getText(),
        { line: pos.line, character: pos.character }, () => token.isCancellationRequested));
    if (r === null)
        return undefined;
    if (r.result === null) {
        logQueryError(r.reason);
        return undefined;
    }
    const replaced = range(r.result.range);
    return r.result.items.map((d) => {
        const item = new vscode.CompletionItem(d.label, COMPLETION_KINDS[d.kind]);
        item.detail = d.detail || undefined;
        item.documentation = d.documentation || undefined;
        item.sortText = `${d.group}${d.label}`;
        item.range = replaced;
        return item;
    });
}

/**
 * The semantic tokens of a D file of the workspace with `djs.semanticTokens` on, from the worker's last compile: djs's
 * absolute tuples, encoded relatively by a SemanticTokensBuilder. A miss of djs (a stale document, a file not in the
 * last compile) and a query VS Code cancelled before its turn throw a CancellationError: VS Code keeps the tokens it
 * has, moved with the edits (see the header). The setting off, a file outside the workspace and a worker that died
 * give null: no tokens.
 */
async function provideSemanticTokens(doc: vscode.TextDocument, token: vscode.CancellationToken)
    : Promise<vscode.SemanticTokens | null> {
    if (!isD(doc) || vscode.workspace.getWorkspaceFolder(doc.uri) === undefined
        || !vscode.workspace.getConfiguration("djs", doc.uri).get<boolean>("semanticTokens", true))
        return null;
    let cancelled = false;
    const r = await ask(() => compiler.semanticTokens(doc.uri.fsPath, doc.getText(),
        () => (cancelled = token.isCancellationRequested)));
    if (cancelled)
        throw new vscode.CancellationError();
    if (r === null)
        return null;
    if (r.data === null) {
        logQueryError(r.reason);
        throw new vscode.CancellationError();
    }
    const builder = new vscode.SemanticTokensBuilder();
    const d = r.data;
    for (let i = 0; i < d.length; i += 5)
        builder.push(d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!, d[i + 4]!);
    return builder.build();
}

const HINT_KINDS: Record<DjsInlayHint["kind"], vscode.InlayHintKind | undefined> = {
    type: vscode.InlayHintKind.Type,
    parameter: vscode.InlayHintKind.Parameter,
    instances: undefined,
};

/** The UTF-16 offsets where the lines of `text` start. */
function lineStartsOf(text: string): number[] {
    const starts = [0];
    for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1))
        starts.push(i + 1);
    return starts;
}

/**
 * Where the positions of `before` are in `after` (the text of a request, not the live document, which may be newer),
 * the two texts taken as one edit apart, their common prefix and suffix unchanged: a position before the first changed
 * character keeps its place, one in the unchanged end of the text is shifted by the length difference, one in the
 * changed span gives null. At the change's start, `stay` keeps the position before the inserted text; otherwise it
 * goes after it.
 */
function editMover(before: string, after: string): (p: Position, stay: boolean) => Position | null {
    if (before === after)
        return (p) => p;
    const shortest = Math.min(before.length, after.length);
    let prefix = 0;
    while (prefix < shortest && before.charCodeAt(prefix) === after.charCodeAt(prefix))
        prefix++;
    let suffix = 0;
    while (suffix < shortest - prefix
        && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix))
        suffix++;
    const from = lineStartsOf(before);
    const to = lineStartsOf(after);
    const position = (offset: number): Position => {
        let lo = 0;
        let hi = to.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (to[mid]! <= offset)
                lo = mid;
            else
                hi = mid - 1;
        }
        return { line: lo, character: offset - to[lo]! };
    };
    return (p, stay) => {
        const offset = from[p.line]! + p.character;
        if (offset < prefix || (offset === prefix && stay))
            return position(offset);
        if (offset >= before.length - suffix)
            return position(offset + after.length - before.length);
        return null;
    };
}

/**
 * `hints`, given for `before`, in `after` (see `editMover`): one in the changed span goes. At the change's start, a
 * parameter hint stays before the inserted text (it precedes its argument) and a type or instance hint goes after it
 * (it follows a name being typed).
 */
function moveHints(before: string, after: string, hints: readonly DjsInlayHint[]): DjsInlayHint[] {
    const move = editMover(before, after);
    const moved: DjsInlayHint[] = [];
    for (const hint of hints) {
        const position = move(hint.position, hint.kind === "parameter");
        if (position !== null)
            moved.push({ ...hint, position });
    }
    return moved;
}

/**
 * The inlay hints of `range` of a D file of the workspace, of the kinds its `djs.inlayHints` settings turn on: the
 * worker's answer for the whole document, kept per document, or the kept one moved through the edits when djs misses
 * (see the header). A query VS Code cancelled gives none and leaves the kept answer serving; a worker that died during
 * the wait gives none and keeps nothing (`deaths`).
 */
async function provideInlayHints(doc: vscode.TextDocument, range: vscode.Range, token: vscode.CancellationToken)
    : Promise<vscode.InlayHint[]> {
    if (!isD(doc) || vscode.workspace.getWorkspaceFolder(doc.uri) === undefined)
        return [];
    const config = vscode.workspace.getConfiguration("djs.inlayHints", doc.uri);
    const shown = new Set<DjsInlayHint["kind"]>();
    if (config.get<boolean>("types", true))
        shown.add("type");
    if (config.get<boolean>("parameterNames", true))
        shown.add("parameter");
    if (config.get<boolean>("instanceCounts", true))
        shown.add("instances");
    if (shown.size === 0)
        return [];
    const key = doc.uri.toString();
    const text = doc.getText();
    let kept = keptHints.get(key);
    // djs is asked once per compile and document: after a miss with this compile, it would miss again (the text it
    // compiled is not this one), and the request would wait behind a compile in progress
    if (kept === undefined || kept.generation !== generation) {
        const whole = { start: { line: 0, character: 0 }, end: { line: doc.lineCount, character: 0 } };
        const cancelled = (): boolean => token.isCancellationRequested;
        const died = deaths;
        const r = await ask(() => compiler.inlayHints(doc.uri.fsPath, text, whole, cancelled));
        if (r === null || deaths !== died)
            return [];   // cancelled, or a worker died meanwhile (`reportDeath` dropped the kept hints)
        if (r.hints === null)
            logQueryError(r.reason);
        // a miss is the answer of this compile too: the kept hints (none for a file never answered) go on moving,
        // read again after the wait, when another request may have kept a fresher answer
        const current = keptHints.get(key);
        kept = r.hints !== null ? { text, generation, hints: r.hints }
            : { text: current?.text ?? text, generation, hints: current?.hints ?? [] };
        keptHints.set(key, kept);
    }
    if (kept === undefined)
        return [];
    if (kept.text !== text) {
        // moved from the previous request's text: each move then spans only the edits made since that request
        kept = { text, generation, hints: moveHints(kept.text, text, kept.hints) };
        keptHints.set(key, kept);
    }
    return kept.hints
        .filter((hint) => shown.has(hint.kind)
            && range.contains(new vscode.Position(hint.position.line, hint.position.character)))
        .map((hint) => {
            const position = new vscode.Position(hint.position.line, hint.position.character);
            const v = new vscode.InlayHint(position, hint.label, HINT_KINDS[hint.kind]);
            v.tooltip = new vscode.MarkdownString(hint.tooltip);
            v.paddingLeft = hint.kind === "instances" || hint.label.startsWith("->");
            v.paddingRight = hint.kind !== "type";
            return v;
        });
}

/** The dimming decoration at the opacity `djs.inactiveCodeOpacity` gives. */
function makeDimType(): vscode.TextEditorDecorationType {
    const opacity = vscode.workspace.getConfiguration("djs").get<number>("inactiveCodeOpacity", 0.5);
    // ClosedClosed: text typed at a dimmed range's edge (a new line after its `}`) is not dimmed with it
    return vscode.window.createTextEditorDecorationType({ opacity: String(opacity),
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed });
}

function setDimmed(editor: vscode.TextEditor, ranges: vscode.Range[]): void {
    editor.setDecorations(dimType, ranges);
    dimmed.set(editor.document.uri.toString(), ranges);
}

/**
 * Dims the inactive branches in `editor` when it shows a D file of the workspace with `djs.dimInactiveCode` on (see
 * the header): djs's ranges, or the kept ones when the file is not in the last compile and its text is unchanged. A
 * stale answer, or one for a text the document no longer has, changes nothing: an editor already dimmed keeps the
 * ranges VS Code moved with the edits, and one just shown has none.
 */
async function dim(editor: vscode.TextEditor): Promise<void> {
    const doc = editor.document;
    if (!isD(doc) || vscode.workspace.getWorkspaceFolder(doc.uri) === undefined)
        return;
    if (!vscode.workspace.getConfiguration("djs", doc.uri).get<boolean>("dimInactiveCode", true)) {
        setDimmed(editor, []);
        return;
    }
    const key = doc.uri.toString();
    const text = doc.getText();
    const r = await ask(() => compiler.inactiveRanges(doc.uri.fsPath, text));
    if (r === null || doc.getText() !== text || r.stale
        || !vscode.workspace.getConfiguration("djs", doc.uri).get<boolean>("dimInactiveCode", true))
        return;
    if (r.ranges !== null) {
        keptInactive.set(key, { text, ranges: r.ranges });
        setDimmed(editor, r.ranges.map(range));
        return;
    }
    logQueryError(r.reason);
    const kept = keptInactive.get(key);
    if (kept !== undefined && kept.text === text)
        setDimmed(editor, kept.ranges.map(range));
}

/** `dim` on every visible editor. */
async function dimVisible(): Promise<void> {
    await Promise.all(vscode.window.visibleTextEditors.map(dim));
}

const EXPANSION_VERBS: Record<ExpansionSite["kind"], string> = {
    mixin: "expand", instance: "instance", value: "value",
};

/**
 * A site's code lens label and its virtual document's name: `expand mixin: 1 statement`, `expand mixin Adder!int`,
 * `instance Foo!(int)`, `value = 3`.
 */
function expansionLabel(site: ExpansionSite): string {
    return `${EXPANSION_VERBS[site.kind]} ${site.title}`;
}

/**
 * `djs.showExpansion`: the expansion of `where` (a range) of the document `uri` when both are given (a code lens passes
 * its site's range and gets that site), else of the active editor's selection (the command palette passes nothing,
 * the editor's context menu its document's URI): djs answers the innermost site containing the range, at a cursor the
 * innermost site at the point. It is peeked in place as a `djs-expansion:` document (see the header), the peek
 * anchored at the range's start. When several analysed copies answer (inside a template body), the document's first
 * line says so in a D comment: djs gives the first. A miss says why in the status bar for a few seconds (the stale
 * reason, or `no expansion here`). A document edited, or an editor left, while djs answered gets no peek (the status
 * bar says so) rather than a cursor moved under the user. Returns the virtual document's URI, undefined when there is
 * none.
 */
async function showExpansion(uri?: unknown, where?: unknown): Promise<vscode.Uri | undefined> {
    let doc: vscode.TextDocument;
    let at: vscode.Range;
    // what a menu passes besides the URI (VS Code's own context objects) is not a range: the selection then
    if (uri instanceof vscode.Uri && where instanceof vscode.Range) {
        doc = await vscode.workspace.openTextDocument(uri);
        at = where;
    } else {
        const editor = vscode.window.activeTextEditor;
        if (editor === undefined)
            return undefined;
        doc = editor.document;
        at = editor.selection;
    }
    const miss = (message: string): undefined => {
        vscode.window.setStatusBarMessage(message, 5000);
        return undefined;
    };
    if (!isD(doc) || vscode.workspace.getWorkspaceFolder(doc.uri) === undefined)
        return miss("djs: no expansion here");
    const version = doc.version;
    const r = await ask(() => compiler.expansion(doc.uri.fsPath,
        { start: { line: at.start.line, character: at.start.character },
            end: { line: at.end.line, character: at.end.character } }, doc.getText()));
    if (r === null)
        return undefined;
    if (r.result === null) {
        logQueryError(r.reason);
        return miss(r.stale ? `djs: ${r.reason}` : "djs: no expansion here");
    }
    if (doc.version !== version || vscode.window.activeTextEditor?.document !== doc)
        return miss("djs: no expansion shown, the document changed or lost focus while djs answered");
    const e = r.result;
    // the peek's title is the path's last segment, its description the rest: the label, then where the site is;
    // the query makes every expansion's URI fresh, the `.d` ending gives the document the D grammar. A title djs
    // clipped may end in half a surrogate pair, and so may the clip here: Uri.toString throws on a lone surrogate
    const name = expansionLabel(e).replace(/[\/\\\x00-\x1f]/g, " ").slice(0, 100)
        .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
    const site = `${path.basename(doc.fileName)}:${e.range.start.line + 1}`;
    const expUri = vscode.Uri.from({ scheme: EXPANSION_SCHEME, path: `/${site}/${name}.d`,
        query: String(++expansionCount) });
    const note = e.instances > 1 ? `// the first of ${e.instances} analysed copies of this site\n` : "";
    expansions.set(expUri.toString(), note + e.text);
    if (expansions.size > EXPANSIONS_KEPT)
        expansions.delete(expansions.keys().next().value!);
    await vscode.commands.executeCommand("editor.action.peekLocations", doc.uri, at.start,
        [new vscode.Location(expUri, new vscode.Range(0, 0, 0, 0))], "peek");
    return expUri;
}

/**
 * `sites`, given for `before`, in `after` (see `editMover`): a site whose start or end is in the changed span goes; one
 * holding the whole edit stays, its end moved.
 */
function moveSites(before: string, after: string, sites: readonly ExpansionSite[]): ExpansionSite[] {
    const move = editMover(before, after);
    const moved: ExpansionSite[] = [];
    for (const site of sites) {
        const start = move(site.range.start, false);
        const end = move(site.range.end, true);
        if (start !== null && end !== null)
            moved.push({ ...site, range: { start, end } });
    }
    return moved;
}

/**
 * The code lenses of a D file of the workspace with `djs.expansionLenses` on: one per expansion site, running
 * `djs.showExpansion` on its range; the worker's sites for the whole document, kept per document, or the kept ones
 * moved through the edits when djs misses (see the header). A worker that died or a query VS Code cancelled gives none.
 */
async function provideCodeLenses(doc: vscode.TextDocument, token: vscode.CancellationToken)
    : Promise<vscode.CodeLens[]> {
    if (!isD(doc) || vscode.workspace.getWorkspaceFolder(doc.uri) === undefined
        || !vscode.workspace.getConfiguration("djs", doc.uri).get<boolean>("expansionLenses", true))
        return [];
    const key = doc.uri.toString();
    const text = doc.getText();
    let kept = keptSites.get(key);
    // once per compile and document, as the hints (see provideInlayHints)
    if (kept === undefined || kept.generation !== generation) {
        const died = deaths;
        const r = await ask(() => compiler.expansionSites(doc.uri.fsPath, text, () => token.isCancellationRequested));
        if (r === null || deaths !== died)
            return [];
        if (r.sites === null)
            logQueryError(r.reason);
        const current = keptSites.get(key);
        kept = r.sites !== null ? { text, generation, sites: r.sites }
            : { text: current?.text ?? text, generation, sites: current?.sites ?? [] };
        keptSites.set(key, kept);
    }
    if (kept.text !== text) {
        kept = { text, generation, sites: moveSites(kept.text, text, kept.sites) };
        keptSites.set(key, kept);
    }
    return kept.sites.map((site) => new vscode.CodeLens(range(site.range), {
        title: expansionLabel(site), tooltip: "djs: Show Expansion", command: "djs.showExpansion",
        arguments: [doc.uri, range(site.range)],
    }));
}

/**
 * The AST view of `source`: `app.d` gives `app.ast.d` (the `.d` ending gives it the D grammar), the source's URI as its
 * query.
 */
function astUri(source: vscode.Uri): vscode.Uri {
    return vscode.Uri.from({ scheme: AST_SCHEME, path: `${source.path.replace(/\.d$/, "")}.ast.d`,
        query: source.toString() });
}

/**
 * The content of an AST view (see the header): djs's AST of the source's current text, whose entries are kept for the
 * navigation. When the content is in the document, the view's `afterUpdate` callbacks run (each request ends by
 * running those queued before its end, even when its content is dropped).
 */
async function provideAst(uri: vscode.Uri): Promise<string> {
    const key = uri.toString();
    let view = astViews.get(key);
    if (view === undefined) {
        view = { entries: null, shift: 0, providing: 0, afterUpdate: [] };
        astViews.set(key, view);
    }
    view.providing++;
    let content = "";
    try {
        content = await astContent(uri, view);
        return content;
    } finally {
        view.providing--;
        const after = view.afterUpdate.splice(0);
        if (after.length > 0)
            void whenShown(key, content).then(() => after.forEach((f) => f()));
    }
}

/**
 * The text of an AST view: djs's answer, or on a miss the reason's first line as a D comment above the last good text
 * (the view's own, read back from its document), or alone. A dead worker since the last compile is a miss without
 * asking; a worker that died during the request writes nothing of it into the view; a request whose view closed
 * before its turn is dropped (`cancelled`), its text empty.
 */
async function astContent(uri: vscode.Uri, view: AstView): Promise<string> {
    const key = uri.toString();
    const missed = (reason: string): string => {
        let good = "";
        const shown = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
        if (view.entries !== null && shown !== undefined) {
            good = shown.getText();
            if (view.shift === 1)
                good = good.slice(good.indexOf("\n") + 1);
        }
        view.shift = 1;
        return `// djs: ${reason.split("\n")[0]}\n${good}`;
    };
    if (deadAt === generation)
        return missed(WORKER_DIED);
    const source = vscode.Uri.parse(uri.query);
    const doc = await vscode.workspace.openTextDocument(source);
    const died = deaths;
    const r = await ask(() => compiler.ast(source.fsPath, doc.getText(), () => astViews.get(key) !== view));
    if (deaths !== died)
        return missed(WORKER_DIED);
    if (r === null)
        return "";   // cancelled: the view closed
    if (r.result !== null) {
        view.entries = r.result.entries;
        view.shift = 0;
        return r.result.text;
    }
    logQueryError(r.reason);
    return missed(r.reason);
}

/** Resolves when the open document `key` holds `content`, or is closed. */
function whenShown(key: string, content: string): Promise<void> {
    return new Promise((resolve) => {
        const done = (): void => {
            subscriptions.dispose();
            resolve();
        };
        const check = (): void => {
            const d = vscode.workspace.textDocuments.find((x) => x.uri.toString() === key);
            if (d === undefined || d.getText() === content)
                done();
        };
        const subscriptions = vscode.Disposable.from(
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.uri.toString() === key)
                    check();
            }),
            vscode.workspace.onDidCloseTextDocument((d) => {
                if (d.uri.toString() === key)
                    done();
            }));
        check();
    });
}

/**
 * Asks the open AST view `uri` again, keeping its place: VS Code replaces a virtual document of more than 100,000
 * characters whole (`computeMoreMinimalEdits` gives up past its diff limit), which loses the selection and the scroll,
 * so the declaration under each visible editor's cursor and under its top line are anchored (host/ast.ts) before, and
 * revealed again in the new print once it is in the document.
 */
function refreshAstView(uri: vscode.Uri): void {
    const view = astViews.get(uri.toString());
    if (view === undefined)
        return;
    const old = view.entries;
    const oldShift = view.shift;
    const places = vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === uri.toString())
        .map((editor) => {
            const doc = editor.document;
            const anchor = (p: vscode.Position | undefined): AstAnchor | null =>
                (old === null || p === undefined || p.line < oldShift ? null
                    : host.ast.astAnchorAt(old, { line: p.line - oldShift, character: p.character },
                        (l) => (l + oldShift < doc.lineCount ? doc.lineAt(l + oldShift).text : "")));
            return { editor, cursor: anchor(editor.selection.active), top: anchor(editor.visibleRanges[0]?.start) };
        });
    if (places.some((p) => p.cursor !== null || p.top !== null)) {
        view.afterUpdate.push(() => {
            if (view.entries === null)
                return;
            for (const { editor, cursor, top } of places) {
                const doc = editor.document;
                if (doc.isClosed)
                    continue;
                const at = (a: AstAnchor | null): vscode.Position | null => {
                    const p = a === null ? null : host.ast.astAnchorPosition(view.entries!, a,
                        (l) => (l + view.shift < doc.lineCount ? doc.lineAt(l + view.shift).text : ""));
                    return p === null ? null : new vscode.Position(p.line + view.shift, p.character);
                };
                const c = at(cursor);
                if (c !== null)
                    editor.selection = new vscode.Selection(c, c);
                const t = at(top);
                if (t !== null)
                    editor.revealRange(new vscode.Range(t, t), vscode.TextEditorRevealType.AtTop);
                else if (c !== null)
                    editor.revealRange(new vscode.Range(c, c), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            }
        });
    }
    astChanged.fire(uri);
}

/**
 * Asks the visible AST views again (`refreshAstView`) and marks the hidden ones: a view costs a print of its module at
 * the first request after a compile (labserver.d: seconds), and the worker serves one request at a time, so a hidden
 * view asked at every save would delay every hover, token and hint after it.
 */
function refreshAstViews(): void {
    const visible = new Set(vscode.window.visibleTextEditors.map((e) => e.document.uri.toString()));
    for (const d of vscode.workspace.textDocuments) {
        if (d.uri.scheme === AST_SCHEME && visible.has(d.uri.toString()))
            refreshAstView(d.uri);
    }
    markHiddenAstViews();
}

/**
 * Marks the open AST views no editor shows: each is asked again when it becomes visible (`onVisibleAstViews`). After a
 * pause compile this is all the views get, the visible ones keeping the print of the last save.
 */
function markHiddenAstViews(): void {
    const visible = new Set(vscode.window.visibleTextEditors.map((e) => e.document.uri.toString()));
    for (const d of vscode.workspace.textDocuments) {
        if (d.uri.scheme === AST_SCHEME && !visible.has(d.uri.toString()))
            astDirty.add(d.uri.toString());
    }
}

/**
 * The requests a compile makes VS Code send for the visible D editors of the workspace, by `<uri> <kind>`: the semantic
 * tokens, the inlay hints and the code lenses, each when both djs's setting and VS Code's own turn it on.
 */
function expectedRequests(): Set<string> {
    const waiting = new Set<string>();
    for (const editor of vscode.window.visibleTextEditors) {
        const doc = editor.document;
        if (!isD(doc) || vscode.workspace.getWorkspaceFolder(doc.uri) === undefined)
            continue;
        const key = doc.uri.toString();
        const djs = vscode.workspace.getConfiguration("djs", doc.uri);
        const editorConfig = vscode.workspace.getConfiguration("editor", { languageId: "d", uri: doc.uri });
        if (tokensRegistered && djs.get<boolean>("semanticTokens", true)
            && editorConfig.get<unknown>("semanticHighlighting.enabled") !== false)
            waiting.add(`${key} tokens`);
        const hints = ["types", "parameterNames", "instanceCounts"]
            .some((k) => djs.get<boolean>(`inlayHints.${k}`, true));
        const shown = editorConfig.get<string>("inlayHints.enabled", "on");
        if (hints && shown !== "off" && shown !== "offUnlessPressed")
            waiting.add(`${key} hints`);
        if (djs.get<boolean>("expansionLenses", true) && editorConfig.get<boolean>("codeLens", true))
            waiting.add(`${key} lenses`);
    }
    return waiting;
}

/**
 * After a compile returned: the AST views are asked again once the visible D editors' requests of that compile are in
 * the worker's queue, so that the reprint (seconds for labserver.d) runs after them, not ahead. The mechanism: the
 * compile fires the providers' change events, then this records the requests VS Code will send (`expectedRequests`);
 * each provider, once it has queued its request (or answered without one), checks itself off (`requestQueued`); the
 * last one opens the gate. `AST_GATE_MS` bounds the wait for a request VS Code never sends (a theme without semantic
 * highlighting); a newer compile replaces the gate.
 */
function gateAstRefresh(): void {
    if (astGate !== undefined) {
        clearTimeout(astGate.timer);
        astGate = undefined;
    }
    const waiting = expectedRequests();
    if (waiting.size === 0) {
        refreshAstViews();
        return;
    }
    const gate = {
        waiting,
        timer: setTimeout(() => gate.open(), AST_GATE_MS),
        open: (): void => {
            if (astGate !== gate)
                return;
            clearTimeout(gate.timer);
            astGate = undefined;
            refreshAstViews();
        },
    };
    astGate = gate;
}

/** The provider of `kind` for `doc` has queued its request in the worker (or answered without one). */
function requestQueued(doc: vscode.TextDocument, kind: EditorRequest): void {
    if (astGate !== undefined && astGate.waiting.delete(`${doc.uri.toString()} ${kind}`) && astGate.waiting.size === 0)
        astGate.open();
}

/**
 * `provide` checking itself off the AST gate: the providers queue their worker request before their first await, so
 * when `provide` returns its promise the request is in the queue.
 */
function gated<A extends unknown[], R>(kind: EditorRequest, provide: (doc: vscode.TextDocument, ...rest: A) => R)
    : (doc: vscode.TextDocument, ...rest: A) => R {
    return (doc, ...rest) => {
        const result = provide(doc, ...rest);
        requestQueued(doc, kind);
        return result;
    };
}

/** Editors that became visible: an AST view marked by `refreshAstViews` is asked again, keeping its place. */
function onVisibleAstViews(editors: readonly vscode.TextEditor[]): void {
    for (const e of editors) {
        if (e.document.uri.scheme === AST_SCHEME && astDirty.delete(e.document.uri.toString()))
            refreshAstView(e.document.uri);
    }
}

/** Go-to-definition in an AST view: the source of the innermost declaration printed around the position. */
function provideAstDefinition(doc: vscode.TextDocument, pos: vscode.Position): vscode.Location | undefined {
    const view = astViews.get(doc.uri.toString());
    if (view === undefined || view.entries === null || pos.line < view.shift)
        return undefined;
    const hit = host.ast.astSourceAt(view.entries, { line: pos.line - view.shift, character: pos.character });
    return hit === null ? undefined : new vscode.Location(vscode.Uri.file(hit.file), range(hit.range));
}

/**
 * `djs.showAst`: opens the AST view of the active D editor's file beside it (see the header) and reveals the
 * declaration the cursor is in (host/ast.ts `astPrintFor`), selecting its first character. A view hidden when a compile
 * returned is reprinted first, and one being reprinted is waited for: the reveal is in the new print. A file that is
 * not a D file of the workspace says so in the status bar. Returns the view's URI once revealed, undefined when there
 * is none.
 */
async function showAst(): Promise<vscode.Uri | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined)
        return undefined;
    const doc = editor.document;
    if (!isD(doc) || vscode.workspace.getWorkspaceFolder(doc.uri) === undefined) {
        vscode.window.setStatusBarMessage("djs: no AST here", 5000);
        return undefined;
    }
    const cursor = { line: editor.selection.active.line, character: editor.selection.active.character };
    const uri = astUri(doc.uri);
    const key = uri.toString();
    const astDoc = await vscode.workspace.openTextDocument(uri);
    const astEditor = await vscode.window.showTextDocument(astDoc,
        { viewColumn: vscode.ViewColumn.Beside, preview: false });
    const view = astViews.get(key);
    if (view === undefined)
        return uri;
    const reveal = (): void => {
        const print = view.entries === null ? null : host.ast.astPrintFor(view.entries, doc.uri.fsPath, cursor);
        if (print === null || astEditor.document.isClosed)
            return;
        const at = new vscode.Position(print.start.line + view.shift, print.start.character);
        astEditor.selection = new vscode.Selection(at, at);
        astEditor.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    };
    const dirty = astDirty.delete(key);
    if (dirty || view.providing > 0) {
        await new Promise<void>((resolve) => {
            view.afterUpdate.push(() => {
                reveal();
                resolve();
            });
            if (dirty)
                astChanged.fire(uri);
        });
    } else {
        reveal();
    }
    return uri;
}

/** Whether `file` (absolute) is in a workspace folder. */
function inWorkspace(file: string): boolean {
    return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file)) !== undefined;
}

/**
 * The last compile's modules (djs `queryImports`), asked once per compile, or the reason the explorers show instead:
 * none while the last worker died after the last compile, the miss's reason (no compile yet).
 */
function lastModules(): Promise<ImportModule[] | string> {
    if (deadAt === generation)
        return Promise.resolve(WORKER_DIED);
    if (keptModules?.generation !== generation) {
        keptModules = { generation, modules: ask(() => compiler.imports()).then((r) => {
            if (r === null)
                return WORKER_DIED;
            if (r.modules === null) {
                logQueryError(r.reason);
                return `No compile to show (${r.reason}): save a D file.`;
            }
            return r.modules;
        }) };
    }
    return keptModules.modules;
}

/** A command that opens `file` with `at` selected (its start when given). */
function openAt(file: string, at: Range | null): vscode.Command {
    const options: vscode.TextDocumentShowOptions = at === null ? {} : { selection: range(at) };
    return { title: "Open", command: "vscode.open", arguments: [vscode.Uri.file(path.resolve(file)), options] };
}

/** `file` relative to its workspace folder, with the line of `at` (from 1) when given. */
function siteLabel(file: string, at: Range | null): string {
    const name = vscode.workspace.asRelativePath(path.resolve(file), false);
    return at === null ? name : `${name}:${at.start.line + 1}`;
}

/** A node of the instances view: a template, or one of its instances. */
type InstanceNode = { template: TemplateInstances } | { site: InstanceSite };

/**
 * The templates of the instances view: djs's `queryInstances` over the last compile's modules inside a workspace
 * folder, or the active editor's file alone when the title-bar toggle says so (file names compared resolved). The
 * view's message says why it is empty; a worker dead since the last compile, or dying while this waits, empties it.
 */
async function instanceRoots(): Promise<InstanceNode[]> {
    const died = deaths;
    const modules = await lastModules();
    if (typeof modules === "string") {
        instancesView.message = modules;
        return [];
    }
    if (deaths !== died || deadAt === generation) {
        instancesView.message = WORKER_DIED;
        return [];
    }
    let files = modules.map((m) => path.resolve(m.file)).filter(inWorkspace);
    if (instancesCurrentFileOnly)
        files = files.filter((f) => f === activeFile);
    const r = await ask(() => compiler.instances(files));
    if (deaths !== died || r === null) {
        instancesView.message = WORKER_DIED;
        return [];
    }
    if (r.templates === null) {
        logQueryError(r.reason);
        instancesView.message = r.reason;
        return [];
    }
    instancesView.message = r.templates.length > 0 ? undefined
        : instancesCurrentFileOnly ? "No template of the active file was instantiated in the last compile."
        : "No template of the workspace's files was instantiated in the last compile.";
    return r.templates.map((template) => ({ template }));
}

const instancesProvider: vscode.TreeDataProvider<InstanceNode> = {
    onDidChangeTreeData: instancesChanged.event,
    getChildren: (node) => node === undefined ? instanceRoots()
        : "template" in node ? node.template.instances.map((site) => ({ site })) : [],
    getTreeItem: (node) => {
        if ("template" in node) {
            const t = node.template;
            const item = new vscode.TreeItem(`${t.name} (${t.instances.length})`,
                vscode.TreeItemCollapsibleState.Collapsed);
            item.description = siteLabel(t.file, t.range);
            item.tooltip = `${t.kind} ${t.name}\n${t.file}`;
            item.command = openAt(t.file, t.range);
            item.iconPath = new vscode.ThemeIcon("symbol-class");
            return item;
        }
        const s = node.site;
        const item = new vscode.TreeItem(s.title, vscode.TreeItemCollapsibleState.None);
        item.description = s.file === null ? "no source location" : siteLabel(s.file, s.range);
        if (s.file !== null)
            item.command = openAt(s.file, s.range);
        return item;
    },
};

/**
 * A node of the imports view: the modules importing the active editor's module (`importedBy`), or a module of the
 * last compile's `modules`, reached along `path` (the indexes above it); `stop` when it is already on the path (a
 * cycle: not expanded again), `leaf` under "Imported by".
 */
type ImportNode = { importedBy: number; modules: ImportModule[] }
    | { index: number; modules: ImportModule[]; path: readonly number[]; stop: boolean; leaf: boolean };

/** The top of the imports view: "Imported by <active file>" when that file is a module of the compile, the roots. */
async function importRoots(): Promise<ImportNode[]> {
    const modules = await lastModules();
    if (typeof modules === "string") {
        importsView.message = modules;
        return [];
    }
    importsView.message = undefined;
    const nodes: ImportNode[] = [];
    const active = modules.findIndex((m) => path.resolve(m.file) === activeFile);
    if (active >= 0)
        nodes.push({ importedBy: active, modules });
    modules.forEach((m, index) => {
        if (m.kind === "root")
            nodes.push({ index, modules, path: [], stop: false, leaf: false });
    });
    return nodes;
}

function importChildren(node: ImportNode): ImportNode[] {
    const modules = node.modules;
    if ("importedBy" in node) {
        const nodes: ImportNode[] = [];
        modules.forEach((m, index) => {
            if (m.imports.includes(node.importedBy))
                nodes.push({ index, modules, path: [], stop: false, leaf: true });
        });
        return nodes;
    }
    if (node.stop || node.leaf)
        return [];
    const path = [...node.path, node.index];
    return modules[node.index]!.imports.map((index) =>
        ({ index, modules, path, stop: path.includes(index), leaf: false }));
}

const importsProvider: vscode.TreeDataProvider<ImportNode> = {
    onDidChangeTreeData: importsChanged.event,
    getChildren: (node) => node === undefined ? importRoots() : importChildren(node),
    getTreeItem: (node) => {
        if ("importedBy" in node) {
            const count = node.modules.filter((m) => m.imports.includes(node.importedBy)).length;
            const item = new vscode.TreeItem(`Imported by ${node.modules[node.importedBy]!.name}`,
                vscode.TreeItemCollapsibleState.Expanded);
            item.description = `${count} module${count === 1 ? "" : "s"}`;
            item.iconPath = new vscode.ThemeIcon("references");
            return item;
        }
        const m = node.modules[node.index]!;
        const expandable = !node.stop && !node.leaf && m.imports.length > 0;
        const item = new vscode.TreeItem(m.name, expandable ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None);
        const size = `${(m.size / 1024).toFixed(1)} KB`;
        item.description = `${node.stop ? "cycle, " : ""}${m.kind}, ${size}`;
        item.tooltip = [m.file, m.cycle === null ? "" : `In an import cycle (component ${m.cycle}).`,
            node.stop ? "Already above on this path: not expanded again." : ""].filter((p) => p !== "").join("\n");
        item.iconPath = new vscode.ThemeIcon(m.cycle === null ? "symbol-module" : "sync");
        item.command = openAt(m.file, null);
        return item;
    },
};

/** Sets the instances view's filter (the title-bar toggle) and its context key, and asks the view again. */
function setInstancesFilter(currentFileOnly: boolean): void {
    instancesCurrentFileOnly = currentFileOnly;
    void vscode.commands.executeCommand("setContext", "djs.instancesCurrentFile", currentFileOnly);
    instancesChanged.fire();
}

/**
 * A new active editor: when it shows a D file on disk other than the last one, the reverse imports (and the
 * instances, when filtered by file) follow it; any other editor (an output, a virtual document) changes nothing.
 */
function onActiveEditor(editor: vscode.TextEditor | undefined): void {
    if (editor === undefined || !isD(editor.document) || editor.document.uri.fsPath === activeFile)
        return;
    activeFile = editor.document.uri.fsPath;
    importsChanged.fire();
    if (instancesCurrentFileOnly)
        instancesChanged.fire();
}

/** The labels of the top-level items of an explorer, as its provider gives them now (for tests). */
async function explorerItems(view: "instances" | "imports"): Promise<string[]> {
    const labels = (items: vscode.TreeItem[]): string[] =>
        items.map((i) => (typeof i.label === "string" ? i.label : i.label?.label ?? ""));
    if (view === "instances")
        return labels((await instanceRoots()).map((n) => instancesProvider.getTreeItem(n) as vscode.TreeItem));
    return labels((await importRoots()).map((n) => importsProvider.getTreeItem(n) as vscode.TreeItem));
}

/**
 * The API the extension exports, for tests: `whenIdle` resolves once no compile runs or waits; `lastCompile` is the
 * mode and fresh reason of the last compile that returned, undefined before the first; `statusText` is what the
 * status bar shows; `dimmedRanges` what the dimming applied; `explorerItems` the top of an explorer.
 */
interface DjsApi {
    whenIdle(): Promise<void>;
    lastCompile(): { mode: CompileReply["mode"]; reason: string } | undefined;
    statusText(): string;
    /** The ranges the dimming last applied to the editors of the document `uri` (a URI string), [] when none. */
    dimmedRanges(uri: string): vscode.Range[];
    /** The labels of the top-level items the explorer `view` shows now, asked of its provider. */
    explorerItems(view: "instances" | "imports"): Promise<string[]>;
}

/**
 * Registers the semantic-tokens provider with djs's legend, which the worker sends when it starts (starting it when
 * none runs). A worker that cannot start is reported as a dead one, and the registration waits for the next compile
 * that returns.
 */
async function registerTokens(): Promise<void> {
    let legend: TokenLegend;
    try {
        legend = await compiler.legend();
    } catch (e) {
        reportDeath(e);
        return;
    }
    if (tokensRegistered)
        return;
    tokensRegistered = true;
    subscriptions.push(vscode.languages.registerDocumentSemanticTokensProvider(dFiles,
        { provideDocumentSemanticTokens: gated("tokens", provideSemanticTokens),
            onDidChangeSemanticTokens: tokensChanged.event },
        new vscode.SemanticTokensLegend(legend.types, legend.modifiers)));
}

async function activate(context: vscode.ExtensionContext): Promise<DjsApi> {
    const dir = path.join(__dirname, "..", "host");
    host = {
        compiler: await import(url.pathToFileURL(path.join(dir, "compiler.js")).href),
        flags: await import(url.pathToFileURL(path.join(dir, "flags.js")).href),
        ast: await import(url.pathToFileURL(path.join(dir, "ast.js")).href),
    };
    compiler = new host.compiler.DjsCompiler();
    collection = vscode.languages.createDiagnosticCollection("djs");
    channel = vscode.window.createOutputChannel("djs");
    status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    status.text = "djs";
    status.show();
    dimType = makeDimType();
    subscriptions = context.subscriptions;
    instancesView = vscode.window.createTreeView("djs.instances", { treeDataProvider: instancesProvider });
    importsView = vscode.window.createTreeView("djs.imports", { treeDataProvider: importsProvider });
    onActiveEditor(vscode.window.activeTextEditor);
    void vscode.commands.executeCommand("setContext", "djs.active", true);
    subscriptions.push(collection, channel, status, tokensChanged, hintsChanged, lensesChanged, astChanged,
        instancesChanged, importsChanged, instancesView, importsView,
        vscode.workspace.onDidSaveTextDocument(onSave),
        vscode.workspace.onDidChangeTextDocument(onChange),
        vscode.languages.registerCompletionItemProvider(dFiles, { provideCompletionItems: provideCompletion }, "."),
        vscode.languages.registerHoverProvider(dFiles, { provideHover }),
        vscode.languages.registerDefinitionProvider(dFiles, { provideDefinition }),
        vscode.languages.registerInlayHintsProvider(dFiles,
            { provideInlayHints: gated("hints", provideInlayHints), onDidChangeInlayHints: hintsChanged.event }),
        vscode.workspace.registerTextDocumentContentProvider(EXPANSION_SCHEME,
            { provideTextDocumentContent: (uri) => expansions.get(uri.toString()) }),
        vscode.commands.registerCommand("djs.showExpansion", showExpansion),
        vscode.languages.registerCodeLensProvider(dFiles,
            { provideCodeLenses: gated("lenses", provideCodeLenses), onDidChangeCodeLenses: lensesChanged.event }),
        vscode.workspace.registerTextDocumentContentProvider(AST_SCHEME,
            { provideTextDocumentContent: provideAst, onDidChange: astChanged.event }),
        vscode.languages.registerDefinitionProvider({ scheme: AST_SCHEME },
            { provideDefinition: provideAstDefinition }),
        vscode.commands.registerCommand("djs.showAst", showAst),
        vscode.commands.registerCommand("djs.instancesCurrentFile", () => setInstancesFilter(true)),
        vscode.commands.registerCommand("djs.instancesAllFiles", () => setInstancesFilter(false)),
        vscode.window.onDidChangeActiveTextEditor(onActiveEditor),
        vscode.window.onDidChangeVisibleTextEditors((editors) => {
            onVisibleAstViews(editors);
            void Promise.all(editors.map(dim));
        }),
        vscode.workspace.onDidCloseTextDocument((doc) => {
            clearPause(doc.uri.toString());
            astViews.delete(doc.uri.toString());
            astDirty.delete(doc.uri.toString());
            keptHints.delete(doc.uri.toString());
            keptInactive.delete(doc.uri.toString());
            keptSites.delete(doc.uri.toString());
            dimmed.delete(doc.uri.toString());
        }),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("djs.compileOnPause"))
                [...pauseTimers.keys()].forEach(clearPause);   // the next edit starts a timer where it is on
            if (e.affectsConfiguration("djs.semanticTokens"))
                tokensChanged.fire();
            if (e.affectsConfiguration("djs.inlayHints"))
                hintsChanged.fire();
            if (e.affectsConfiguration("djs.expansionLenses"))
                lensesChanged.fire();
            if (e.affectsConfiguration("djs.inactiveCodeOpacity")) {
                dimType.dispose();
                dimType = makeDimType();
            }
            if (e.affectsConfiguration("djs.inactiveCodeOpacity") || e.affectsConfiguration("djs.dimInactiveCode"))
                void dimVisible();
        }),
        { dispose: () => dimType.dispose() },
        { dispose: () => [...pauseTimers.keys()].forEach(clearPause) },
        { dispose: () => void compiler.dispose() });
    await registerTokens();
    return {
        whenIdle: () => (busy || queued.size ? new Promise<void>((r) => idleWaiters.push(r)) : Promise.resolve()),
        lastCompile: () => last,
        statusText: () => status.text,
        dimmedRanges: (uri) => dimmed.get(uri) ?? [],
        explorerItems,
    };
}

function deactivate(): Promise<void> {
    return compiler?.dispose();
}

export = { activate, deactivate };
