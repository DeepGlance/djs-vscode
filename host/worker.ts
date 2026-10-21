// The compiler worker: one djs frontend per thread, compiling on request (host/protocol.ts).
//
// Runs in a worker thread (ruling 3, 9/10) started by host/compiler.ts with an 8 MiB stack (`resourceLimits`), the
// CLI's `node --stack-size=7600`. It imports the emitted djs once; every compile request is one `djsMainKept` call in
// editor mode (10 §4.7, "The kept-module engine"): the reply is what a fresh process would give on the same files and
// arguments, and a call with the previous call's command line (the root excepted) replays what that call analysed
// and analyses again only what changed. The kept state is the worker's own memory: the last compile's modules,
// instances and logs stay reachable between calls, and a dispose or a restart of the worker (host/compiler.ts)
// loses them, so the next compile is fresh (`no kept state`).
// Every compile runs with djs's doc-comment knob on (`DjsOptions.docComments`, 10 §4.7 "Queries"): the parser keeps
// the doc comments the hovers show, with no change to the compile's output, for the comments' memory. A compile's
// `texts` go to djs as `DjsOptions.texts`: the file reader returns them for those files, and the diagnostics' locations
// carry them as `fileContent`, so their positions are the buffer's.
// A hover or definition request is one `queryHover`/`queryDefinition` call on what the last compile left (10 §4.7,
// "Queries"): read-only, so the next compile's reply is the one it would be without the query. A semantic-tokens
// request is one `querySemanticTokens` call, the same way; its tokens travel as a Uint32Array (structured clone, one
// copy of the buffer); an inlay-hints request is one `queryInlayHints` call, an inactive-ranges request one
// `queryInactiveRanges` call, an expansion-sites request one `queryExpansionSites` call, an expansion request one
// `queryExpansion` call, an AST request one `queryAst` call, an instances request one `queryInstances` call, an imports
// request one `queryImports` call, a completion request one `queryCompletion` call, a document-symbols request one
// `queryDocumentSymbols` call, a references request one `queryReferences` call, a rename request one
// `queryPrepareRename` call (no new name) or one `queryRename` call, a signature-help request one `querySignatureHelp`
// call, an unused-code request one `queryUnused` call. A query that throws is answered with its error as the reason,
// and the worker serves the next request.
//
// CONTRACT WITH THE CALLER (10 §4.7):
// - every path in `args` is absolute: a worker cannot chdir (process.chdir throws in a worker), and the process's
//   working directory is the extension host's, not the repository's;
// - `args` carry `-c -o- -verrors=0`: past a returned fatal() an object file would reach the codegen wall, and the
//   error limit's line would print again after every error;
// - diagnostics arrive through dmd's own hook (dmd/errors.d:408 `diagnosticHandler`), which answers true, so
//   nothing is printed for them; what the call writes to stdout and stderr (pragma(msg), messages, `Internal
//   error:`, `djs: unsupported flag`) is captured into `output`. In a fresh compile the hook runs where dmd reports;
//   in a kept one the engine calls it when the compile ends, in order, with copies of its arguments (the location's
//   `fileContent` is the file's text of this compile, kept or read again), and `output` gets the buffered writes in
//   their place among those calls, so `messageText` and `lineOf` see what a fresh compile would hand them;
// - output of child processes (the C preprocessor's `cc` diagnostics) goes to the inherited stderr, not `output`.

import { isAbsolute } from "node:path";
import { parentPort } from "node:worker_threads";
import {
    SEMANTIC_TOKEN_MODIFIERS, SEMANTIC_TOKEN_TYPES, djsMainKept, queryAst, queryCompletion, queryDefinition,
    queryDocumentSymbols, queryExpansion, queryExpansionSites, queryHover, queryImports, queryInactiveRanges,
    queryInlayHints, queryInstances, queryPrepareRename, queryReferences, queryRename, querySemanticTokens,
    querySignatureHelp, queryUnused, type KeptCompile,
} from "../src/djs.js";
import { setDiagnosticHandler, unescapeBackticks } from "../src/dmd/errors.js";
import { OutBuffer } from "../src/dmd/common/outbuffer.js";
import { global } from "../src/dmd/globals.js";
import type { SourceLoc } from "../src/dmd/location.js";
import { cstr, ds, dsToJs, type DString } from "../src/dstring.js";
import { packAst } from "./ast.js";
import { tokenRange } from "./position.js";
import type {
    AstReply, AstRequest, CompileReply, CompileRequest, CompletionReply, CompletionRequest, DefinitionReply,
    Diagnostic, DiagnosticLine, DocumentSymbolsReply, DocumentSymbolsRequest, ExpansionReply, ExpansionRequest,
    ExpansionSitesReply, ExpansionSitesRequest, HoverReply, ImportsReply, ImportsRequest, InactiveRangesReply,
    InactiveRangesRequest, InlayHintsReply, InlayHintsRequest, InstancesReply, InstancesRequest, Position, QueryRequest,
    ReferencesReply, ReferencesRequest, RenameReply, RenameRequest, Request, ReadyMessage, SignatureHelpReply,
    SignatureHelpRequest, SemanticTokensReply, SemanticTokensRequest, Severity, UnusedReply, UnusedRequest,
} from "./protocol.js";

const port = parentPort!;

const HEADERS: ReadonlyMap<string, Severity | null> = new Map([
    ["Error: ", "error"], ["Warning: ", "warning"], ["Deprecation: ", "deprecation"], ["  Tip: ", "tip"],
    ["       ", null],   // supplemental (errors.d:656)
]);

let diagnostics: Diagnostic[] = [];

/** errors.d:672-706 `printDiagnostic`'s message: the prefixes, the formatted text, backticks unescaped. */
function messageText(format: DString, args: ReadonlyArray<unknown>, p1: DString | null, p2: DString | null): string {
    const tmp = new OutBuffer();
    if (p1) {
        tmp.writestring(p1);
        tmp.writestring(ds(" "));
    }
    if (p2) {
        tmp.writestring(p2);
        tmp.writestring(ds(" "));
    }
    tmp.vprintf(format, args);
    unescapeBackticks(tmp);
    return dsToJs(cstr(tmp.peekChars()));
}

function lineOf(loc: SourceLoc, message: string): DiagnosticLine {
    const file = loc.filename.length ? dsToJs(loc.filename) : null;
    return {
        file, dmdLine: loc.line, dmdColumn: loc.column, message,
        ...tokenRange(loc.fileContent, loc.fileOffset, loc.line, loc.column),
    };
}

setDiagnosticHandler((loc, _color, header, format, args, p1, p2) => {
    const severity = HEADERS.get(dsToJs(header));
    if (severity === undefined)
        throw new Error(`djs-vscode: unknown diagnostic header ${JSON.stringify(dsToJs(header))}`);
    const line = lineOf(loc, messageText(format, args, p1, p2));
    if (severity !== null)
        diagnostics.push({ ...line, severity, supplemental: [] });
    else if (diagnostics.length)
        diagnostics[diagnostics.length - 1]!.supplemental.push(line);
    else   // a supplemental before any diagnostic: dmd never emits one; kept visible rather than dropped
        diagnostics.push({ ...line, severity: "error", supplemental: [] });
    return true;
});

/** The boundary of a compile's `texts`: absent, or an object whose keys are absolute paths and whose values strings. */
function validTexts(texts: unknown): boolean {
    if (texts === undefined)
        return true;
    if (typeof texts !== "object" || texts === null || Array.isArray(texts))
        return false;
    return Object.entries(texts).every(([file, text]) => isAbsolute(file) && typeof text === "string");
}

/**
 * One `djsMainKept` call with `req.args` and `req.texts`. The boundary (`validTexts`): another request is refused
 * without compiling, mode "refused" with the reason `invalid request: ...`, the kept state untouched.
 */
function compile(req: CompileRequest): CompileReply {
    if (!validTexts(req.texts)) {
        const mem = process.memoryUsage();
        return {
            kind: "result", id: req.id, status: 1, mode: "refused",
            reason: "invalid request: compile texts must map absolute paths to strings",
            stats: { replayed: 0, run: 0, modulesKept: 0, modulesDropped: 0, planMs: 0 }, errors: 0, warnings: 0,
            fatals: 0, diagnostics: [], output: "", fromBuffer: [], wallMs: 0, rssBytes: mem.rss,
            heapUsedBytes: mem.heapUsed,
        };
    }
    const texts = new Map(Object.entries(req.texts ?? {}));
    diagnostics = [];
    let fatals = 0;
    const chunks: string[] = [];
    const decoder = new TextDecoder();
    const tap = (c: string | Uint8Array): boolean => {
        chunks.push(typeof c === "string" ? c : decoder.decode(c));
        return true;
    };
    const out = process.stdout.write;
    const err = process.stderr.write;
    process.stdout.write = tap as typeof process.stdout.write;
    process.stderr.write = tap as typeof process.stderr.write;
    const t0 = performance.now();
    let kept: KeptCompile;
    try {
        kept = djsMainKept(req.args, () => {
            fatals++;
            return true;
        }, { docComments: true, texts });
    } finally {
        process.stdout.write = out;
        process.stderr.write = err;
    }
    const wallMs = performance.now() - t0;
    const mem = process.memoryUsage();
    const k = kept.stats;
    return {
        kind: "result", id: req.id, status: kept.status, mode: kept.mode, reason: kept.reason,
        stats: { replayed: k.replayed, run: k.run, modulesKept: k.modulesKept, modulesDropped: k.modulesDead,
            planMs: k.planMs },
        errors: global.errors, warnings: global.warnings, fatals, diagnostics, output: chunks.join(""),
        fromBuffer: req.args.filter((a) => texts.has(a)), wallMs, rssBytes: mem.rss, heapUsedBytes: mem.heapUsed,
    };
}

/** One query on the last compile; an error it throws becomes the reply's reason (`internal error: ...`). */
function query(req: QueryRequest): HoverReply | DefinitionReply {
    const t0 = performance.now();
    try {
        if (req.kind === "hover") {
            const a = queryHover(req.file, req.line, req.character, req.text);
            const ms = performance.now() - t0;
            return a.result === null ? { kind: "hover", id: req.id, result: null, stale: a.stale, reason: a.reason, ms }
                : { kind: "hover", id: req.id, result: a.result, stale: false, reason: "", ms };
        }
        const a = queryDefinition(req.file, req.line, req.character, req.text);
        const ms = performance.now() - t0;
        return a.result === null
            ? { kind: "definition", id: req.id, result: null, stale: a.stale, reason: a.reason, ms }
            : { kind: "definition", id: req.id, result: a.result, stale: false, reason: "", ms };
    } catch (e) {
        return { kind: req.kind, id: req.id, result: null, stale: false, reason: internalError(e),
            ms: performance.now() - t0 };
    }
}

/** The boundary of a whole-file query: `file` an absolute path and `text` a string (djs trusts both). */
function validFile(req: { file: unknown; text: unknown }): boolean {
    return typeof req.file === "string" && isAbsolute(req.file) && typeof req.text === "string";
}

/** A position of a request: an object of two non-negative integers. */
function validPosition(p: unknown): boolean {
    if (typeof p !== "object" || p === null)
        return false;
    const { line, character } = p as Partial<Position>;
    return Number.isInteger(line) && line! >= 0 && Number.isInteger(character) && character! >= 0;
}

function internalError(e: unknown): string {
    return `internal error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`;
}

/**
 * The semantic tokens of the last compile's `req.file`. The boundary (`validFile`): another request is refused with
 * the reason `invalid request: ...`. An error the query throws becomes the reason (`internal error: ...`).
 */
function tokens(req: SemanticTokensRequest): SemanticTokensReply {
    const t0 = performance.now();
    const reply = (data: Uint32Array | null, stale: boolean, reason: string): SemanticTokensReply =>
        ({ kind: "semanticTokens", id: req.id, data, stale, reason, ms: performance.now() - t0 });
    if (!validFile(req))
        return reply(null, false, "invalid request: semanticTokens needs an absolute file and the document's text");
    try {
        const a = querySemanticTokens(req.file, req.text);
        return a.result === null ? reply(null, a.stale, a.reason) : reply(a.result.data, false, "");
    } catch (e) {
        return reply(null, false, internalError(e));
    }
}

/**
 * The inlay hints of `req.range` of the last compile's `req.file`. The boundary: `validFile` and a range of two
 * positions, else the reason `invalid request: ...`. An error the query throws becomes the reason.
 */
function hints(req: InlayHintsRequest): InlayHintsReply {
    const t0 = performance.now();
    const reply = (list: InlayHintsReply["hints"], stale: boolean, reason: string): InlayHintsReply =>
        ({ kind: "inlayHints", id: req.id, hints: list, stale, reason, ms: performance.now() - t0 });
    const range: unknown = req.range;
    if (!validFile(req) || typeof range !== "object" || range === null
        || !validPosition((range as { start?: unknown }).start) || !validPosition((range as { end?: unknown }).end))
        return reply(null, false, "invalid request: inlayHints needs an absolute file, the document's text, a range");
    try {
        const a = queryInlayHints(req.file, req.text, req.range);
        return a.result === null ? reply(null, a.stale, a.reason) : reply(a.result.hints, false, "");
    } catch (e) {
        return reply(null, false, internalError(e));
    }
}

/** The inactive ranges of the last compile's `req.file`; the boundary is `validFile`, as for the tokens. */
function inactive(req: InactiveRangesRequest): InactiveRangesReply {
    const t0 = performance.now();
    const reply = (ranges: InactiveRangesReply["ranges"], stale: boolean, reason: string): InactiveRangesReply =>
        ({ kind: "inactiveRanges", id: req.id, ranges, stale, reason, ms: performance.now() - t0 });
    if (!validFile(req))
        return reply(null, false, "invalid request: inactiveRanges needs an absolute file and the document's text");
    try {
        const a = queryInactiveRanges(req.file, req.text);
        return a.result === null ? reply(null, a.stale, a.reason) : reply(a.result.ranges, false, "");
    } catch (e) {
        return reply(null, false, internalError(e));
    }
}

/** A range of a request: two positions (`validPosition`), the start not after the end. */
function validRange(r: unknown): boolean {
    if (typeof r !== "object" || r === null)
        return false;
    const { start, end } = r as { start?: Position; end?: Position };
    return validPosition(start) && validPosition(end)
        && (start!.line < end!.line || (start!.line === end!.line && start!.character <= end!.character));
}

/**
 * The expansion of `req.range` of the last compile's `req.file`. The boundary: `validFile` and `validRange`, else the
 * reason `invalid request: ...`. An error the query throws becomes the reason.
 */
function expansion(req: ExpansionRequest): ExpansionReply {
    const t0 = performance.now();
    const reply = (result: ExpansionReply["result"], stale: boolean, reason: string): ExpansionReply =>
        ({ kind: "expansion", id: req.id, result, stale, reason, ms: performance.now() - t0 });
    if (!validFile(req) || !validRange(req.range))
        return reply(null, false, "invalid request: expansion needs an absolute file, the document's text, a range "
            + "whose start is not after its end");
    try {
        const a = queryExpansion(req.file, req.range, req.text);
        return a.result === null ? reply(null, a.stale, a.reason) : reply(a.result, false, "");
    } catch (e) {
        return reply(null, false, internalError(e));
    }
}

/** The expansion sites of the last compile's `req.file`; the boundary is `validFile`, as for the tokens. */
function expansionSites(req: ExpansionSitesRequest): ExpansionSitesReply {
    const t0 = performance.now();
    const reply = (sites: ExpansionSitesReply["sites"], stale: boolean, reason: string): ExpansionSitesReply =>
        ({ kind: "expansionSites", id: req.id, sites, stale, reason, ms: performance.now() - t0 });
    if (!validFile(req))
        return reply(null, false, "invalid request: expansionSites needs an absolute file and the document's text");
    try {
        const a = queryExpansionSites(req.file, req.text);
        return a.result === null ? reply(null, a.stale, a.reason) : reply(a.result.sites, false, "");
    } catch (e) {
        return reply(null, false, internalError(e));
    }
}

/**
 * The AST of the last compile's `req.file`, its entries packed (host/ast.ts: one clone of a few buffers instead of
 * one object per declaration); the boundary is `validFile`, as for the tokens.
 */
function ast(req: AstRequest): AstReply {
    const t0 = performance.now();
    const reply = (result: AstReply["result"], stale: boolean, reason: string): AstReply =>
        ({ kind: "ast", id: req.id, result, stale, reason, ms: performance.now() - t0 });
    if (!validFile(req))
        return reply(null, false, "invalid request: ast needs an absolute file and the document's text");
    try {
        const a = queryAst(req.file, req.text);
        return a.result === null ? reply(null, a.stale, a.reason)
            : reply({ text: a.result.text, entries: packAst(a.result.entries) }, false, "");
    } catch (e) {
        return reply(null, false, internalError(e));
    }
}

/**
 * The templates declared in `req.files` with their instances. The boundary: `files` an array of absolute paths, else
 * the reason `invalid request: ...`. An error the query throws becomes the reason.
 */
function instances(req: InstancesRequest): InstancesReply {
    const t0 = performance.now();
    const reply = (templates: InstancesReply["templates"], reason: string): InstancesReply =>
        ({ kind: "instances", id: req.id, templates, reason, ms: performance.now() - t0 });
    const files: unknown = req.files;
    if (!Array.isArray(files) || !files.every((f) => typeof f === "string" && isAbsolute(f)))
        return reply(null, "invalid request: instances needs an array of absolute files");
    try {
        const a = queryInstances(req.files);
        return a.result === null ? reply(null, a.reason) : reply(a.result.templates, "");
    } catch (e) {
        return reply(null, internalError(e));
    }
}

/** The modules of the last compile and their imports; the request carries nothing to validate. */
function imports(req: ImportsRequest): ImportsReply {
    const t0 = performance.now();
    const reply = (modules: ImportsReply["modules"], reason: string): ImportsReply =>
        ({ kind: "imports", id: req.id, modules, reason, ms: performance.now() - t0 });
    try {
        const a = queryImports();
        return a.result === null ? reply(null, a.reason) : reply(a.result.modules, "");
    } catch (e) {
        return reply(null, internalError(e));
    }
}

/**
 * The members after the dot before `req.position` of `req.file`, from the last compile. The boundary: `validFile` and
 * `validPosition`, else the reason `invalid request: ...`. An error the query throws becomes the reason.
 */
function completion(req: CompletionRequest): CompletionReply {
    const t0 = performance.now();
    const reply = (result: CompletionReply["result"], stale: boolean, reason: string): CompletionReply =>
        ({ kind: "completion", id: req.id, result, stale, reason, ms: performance.now() - t0 });
    if (!validFile(req) || !validPosition(req.position))
        return reply(null, false,
            "invalid request: completion needs an absolute file, the document's text, a position");
    try {
        const a = queryCompletion(req.file, req.text, req.position);
        return a.result === null ? reply(null, a.stale, a.reason) : reply(a.result, false, "");
    } catch (e) {
        return reply(null, false, internalError(e));
    }
}

/** The outline of the last compile's `req.file`; the boundary is `validFile`, as for the tokens. */
function documentSymbols(req: DocumentSymbolsRequest): DocumentSymbolsReply {
    const t0 = performance.now();
    const reply = (symbols: DocumentSymbolsReply["symbols"], stale: boolean, reason: string): DocumentSymbolsReply =>
        ({ kind: "documentSymbols", id: req.id, symbols, stale, reason, ms: performance.now() - t0 });
    if (!validFile(req))
        return reply(null, false, "invalid request: documentSymbols needs an absolute file and the document's text");
    try {
        const a = queryDocumentSymbols(req.file, req.text);
        return a.result === null ? reply(null, a.stale, a.reason) : reply(a.result.symbols, false, "");
    } catch (e) {
        return reply(null, false, internalError(e));
    }
}

/**
 * The references of the symbol at `req`'s position of `req.file`, from the last compile. The boundary: `validFile` and
 * a position (`validPosition`), else the reason `invalid request: ...`. An error the query throws becomes the reason.
 */
function references(req: ReferencesRequest): ReferencesReply {
    const t0 = performance.now();
    const reply = (result: ReferencesReply["result"], stale: boolean, reason: string): ReferencesReply =>
        ({ kind: "references", id: req.id, result, stale, reason, ms: performance.now() - t0 });
    if (!validFile(req) || !validPosition({ line: req.line, character: req.character }))
        return reply(null, false,
            "invalid request: references needs an absolute file, the document's text, a position");
    try {
        const a = queryReferences(req.file, req.line, req.character, req.text);
        return a.result === null ? reply(null, a.stale, a.reason) : reply(a.result, false, "");
    } catch (e) {
        return reply(null, false, internalError(e));
    }
}

/**
 * Whether the symbol at `req`'s position can be renamed, or (with `req.newName`) the edits renaming it, from the last
 * compile. The boundary: `validFile`, a position, `newName` absent or a string, else the reason `invalid request: ...`.
 * An error the query throws becomes the reason.
 */
function rename(req: RenameRequest): RenameReply {
    const t0 = performance.now();
    const reply = (result: RenameReply["result"], stale: boolean, reason: string): RenameReply =>
        ({ kind: "rename", id: req.id, result, stale, reason, ms: performance.now() - t0 });
    if (!validFile(req) || !validPosition({ line: req.line, character: req.character })
        || (req.newName !== undefined && typeof req.newName !== "string"))
        return reply(null, false, "invalid request: rename needs an absolute file, the document's text, a position");
    try {
        if (req.newName === undefined) {
            const a = queryPrepareRename(req.file, req.line, req.character, req.text);
            return a.result === null ? reply(null, a.stale, a.reason) : reply({ ...a.result, edits: [] }, false, "");
        }
        const a = queryRename(req.file, req.line, req.character, req.text, req.newName);
        const r = a.result;
        const at = { line: req.line, character: req.character };
        return r === null ? reply(null, a.stale, a.reason)
            : reply({ range: { start: at, end: at }, placeholder: r.newName, edits: r.edits }, false, "");
    } catch (e) {
        return reply(null, false, internalError(e));
    }
}

/**
 * The signatures of the call around `req`'s position of `req.file`, from the last compile. The boundary: `validFile`
 * and a position, else the reason `invalid request: ...`. An error the query throws becomes the reason.
 */
function signatureHelp(req: SignatureHelpRequest): SignatureHelpReply {
    const t0 = performance.now();
    const reply = (result: SignatureHelpReply["result"], stale: boolean, reason: string): SignatureHelpReply =>
        ({ kind: "signatureHelp", id: req.id, result, stale, reason, ms: performance.now() - t0 });
    if (!validFile(req) || !validPosition({ line: req.line, character: req.character }))
        return reply(null, false,
            "invalid request: signatureHelp needs an absolute file, the document's text, a position");
    try {
        const a = querySignatureHelp(req.file, req.line, req.character, req.text);
        return a.result === null ? reply(null, a.stale, a.reason) : reply(a.result, false, "");
    } catch (e) {
        return reply(null, false, internalError(e));
    }
}

/**
 * The unused code of the last compile's program (`queryUnused`); no request field to validate. An error the query
 * throws becomes the reason.
 */
function unused(req: UnusedRequest): UnusedReply {
    const t0 = performance.now();
    const reply = (result: UnusedReply["result"], reason: string): UnusedReply =>
        ({ kind: "unused", id: req.id, result, reason, ms: performance.now() - t0 });
    try {
        const a = queryUnused();
        return a.result === null ? reply(null, a.reason) : reply(a.result, "");
    } catch (e) {
        return reply(null, internalError(e));
    }
}

port.on("message", (req: Request) => {
    switch (req.kind) {
        case "compile": port.postMessage(compile(req)); break;
        case "semanticTokens": port.postMessage(tokens(req)); break;
        case "inlayHints": port.postMessage(hints(req)); break;
        case "inactiveRanges": port.postMessage(inactive(req)); break;
        case "expansion": port.postMessage(expansion(req)); break;
        case "expansionSites": port.postMessage(expansionSites(req)); break;
        case "ast": port.postMessage(ast(req)); break;
        case "instances": port.postMessage(instances(req)); break;
        case "imports": port.postMessage(imports(req)); break;
        case "completion": port.postMessage(completion(req)); break;
        case "documentSymbols": port.postMessage(documentSymbols(req)); break;
        case "references": port.postMessage(references(req)); break;
        case "rename": port.postMessage(rename(req)); break;
        case "signatureHelp": port.postMessage(signatureHelp(req)); break;
        case "unused": port.postMessage(unused(req)); break;
        default: port.postMessage(query(req));
    }
});
const ready: ReadyMessage = {
    kind: "ready", legend: { types: [...SEMANTIC_TOKEN_TYPES], modifiers: [...SEMANTIC_TOKEN_MODIFIERS] },
};
port.postMessage(ready);
