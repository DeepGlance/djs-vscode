// The messages between the extension host thread and the compiler worker (host/worker.ts).
//
// Plain structured-clone data, request and reply matched by `id`: the same shape would travel over a child process's
// IPC channel, so swapping the worker for a child (ruling 3, 9/10) changes the transport, not the messages. Two kinds
// of request: a compile, and a query (hover, definition, semantic tokens, inlay hints, inactive ranges, expansion
// sites, expansion, AST, instances, imports, completion, document symbols, references, rename, signature help) on what
// the last compile analysed (djs 10 §4.7, "Queries"); the worker answers one request at a time, in arrival order.

/**
 * Main thread -> worker: compile once with `args`, the full ldmd2 command line (sources included). `texts` replaces
 * files' contents for this compile (djs `DjsOptions.texts`, 10 §4.7): absolute path -> the editor's text of a D source
 * that exists on disk; the compile reads it wherever it reads that file (a root, a module `-i` or an import path
 * reaches), and the kept engine compares it by bytes with what the previous compile read. Absent: every file from disk.
 */
export interface CompileRequest {
    kind: "compile";
    id: number;
    args: string[];
    texts?: Record<string, string>;
}

/** What the diagnostic's header says (dmd/errors.d:659); `tip` is the error sink's `  Tip: `. */
export type Severity = "error" | "warning" | "deprecation" | "tip";

/** A position in a file, in VS Code's terms: line from 0, character in UTF-16 code units from 0. */
export interface Position {
    line: number;
    character: number;
}

/** One location-bearing message, as dmd's printDiagnostic would print it (without the source-line context). */
export interface DiagnosticLine {
    /** The file as the compiler names it (absolute when the command line was), or null for `Loc.initial`. */
    file: string | null;
    /** dmd's own line and byte column, from 1 (0 when the Loc has none), as `-vcolumns` prints them. */
    dmdLine: number;
    dmdColumn: number;
    /** The token at the location: an identifier's extent, else one character; zero-width at the line start. */
    start: Position;
    end: Position;
    /** The message text after the header, backticks unescaped as the non-console printer does (errors.d:705). */
    message: string;
}

/** A diagnostic with its supplemental lines (the `       `-headed ones that follow it, dmd/errors.d:656). */
export interface Diagnostic extends DiagnosticLine {
    severity: Severity;
    supplemental: DiagnosticLine[];
}

/** The kept-module engine's counts for one compile (djs `KeptCompile.stats`, 10 §4.7), shown in the output channel. */
export interface KeepStats {
    /** Units (a module's passes, an instance's creation and passes, a function body) replayed from the kept log. */
    replayed: number;
    /** Units analysed for real: everything in a fresh compile, the changed root and what depends on it when kept. */
    run: number;
    /** Kept modules carried into this compile, and those the plan dropped (changed, or depending on a change). */
    modulesKept: number;
    modulesDropped: number;
    /** The plan's own cost: deciding kept or fresh and computing the dropped set, in milliseconds. */
    planMs: number;
}

/** Worker -> main thread: the outcome of one CompileRequest. */
export interface CompileReply {
    kind: "result";
    id: number;
    /**
     * djsMainKept's status, as djsMain's: 0 when the compile reached the end of mars_tryMain (errors or not, 10 §4.7),
     * 1 for an escaped error (`Internal error:` in `output`), 2 for a switch the shim refuses (`djs: unsupported flag`
     * in `output`). Also 1 for a request the worker refused (`mode` "refused").
     */
    status: number;
    /**
     * "kept": the engine replayed what the previous compile left and analysed only what changed; "fresh": it compiled
     * from nothing. Both give the same reply on the same files and arguments (the engine's guarantee, 10 §4.7).
     * "refused": the worker refused the request at its boundary (`texts` not a map of absolute paths to strings) and
     * compiled nothing: the kept state is untouched, `reason` says why, the counts are 0 and the lists empty.
     */
    mode: "kept" | "fresh" | "refused";
    /**
     * Why the compile was fresh, in the engine's words (`no kept state`, `refused flag -v: ...`), or why the request
     * was refused (`invalid request: ...`); "" when kept.
     */
    reason: string;
    /** The engine's counts for the compile that produced this reply (after an abort, the fresh one's). */
    stats: KeepStats;
    /** global.errors / global.warnings after the call: the editor reads these, never the status (10 §4.7). */
    errors: number;
    warnings: number;
    /**
     * How many times fatal() was called and returned (each one is a point where ldc2 would have stopped). After an
     * abort (`reason` starting `abort: `) it also counts the discarded kept run's calls: the engine calls the
     * fatal handler there unbuffered, and the host cannot tell the two runs apart.
     */
    fatals: number;
    diagnostics: Diagnostic[];
    /** Everything the call wrote to stdout and stderr, in order: pragma(msg), messages, internal errors. */
    output: string;
    /** The source files of `args` (the roots) whose text came from the request's `texts`, not from the disk. */
    fromBuffer: string[];
    /** Wall time of the djsMainKept call (the plan included), and the process RSS and the worker's heap after it. */
    wallMs: number;
    rssBytes: number;
    heapUsedBytes: number;
}

/**
 * Main thread -> worker: the hover or the declaration of the symbol at `line`/`character` of `file` (absolute, as the
 * compile's command line names it), answered from the worker's last compile. `text` is the editor's current text of
 * the file: when it is not the text that compile read, the reply is empty and `stale` (positions would be wrong).
 */
export interface QueryRequest extends Position {
    kind: "hover" | "definition";
    id: number;
    file: string;
    text: string;
}

/**
 * Main thread -> worker: the semantic tokens of `file` (absolute, as the compile's command line names it), answered
 * from the worker's last compile; `text` as in QueryRequest (another text: no tokens, `stale`).
 */
export interface SemanticTokensRequest {
    kind: "semanticTokens";
    id: number;
    file: string;
    text: string;
}

/** A range in a file, start inclusive, end exclusive. */
export interface Range {
    start: Position;
    end: Position;
}

/**
 * Main thread -> worker: the inlay hints of `range` of `file` (absolute, as the compile's command line names it),
 * answered from the worker's last compile; `text` as in QueryRequest (another text: no hints, `stale`).
 */
export interface InlayHintsRequest {
    kind: "inlayHints";
    id: number;
    file: string;
    text: string;
    range: Range;
}

/**
 * Main thread -> worker: the ranges of `file` (absolute) in the branches of `version`, `debug` and `static if` the last
 * compile did not choose; `text` as in QueryRequest (another text: no ranges, `stale`).
 */
export interface InactiveRangesRequest {
    kind: "inactiveRanges";
    id: number;
    file: string;
    text: string;
}

/**
 * Main thread -> worker: the expansion of `range` of `file` (absolute, as the compile's command line names it): what
 * the last compile made of the innermost string mixin, template instance or folded value whose site contains the
 * range (end exclusive). A cursor is an empty range (the innermost site at the point); a code lens passes its site's
 * range and gets that site; a selection gets the innermost site around it. `text` as in QueryRequest (another text:
 * no expansion, `stale`).
 */
export interface ExpansionRequest {
    kind: "expansion";
    id: number;
    file: string;
    text: string;
    range: Range;
}

/**
 * Main thread -> worker: the expansion sites of `file` (absolute), from the worker's last compile; `text` as in
 * QueryRequest (another text: no sites, `stale`).
 */
export interface ExpansionSitesRequest {
    kind: "expansionSites";
    id: number;
    file: string;
    text: string;
}

/**
 * Main thread -> worker: the module of `file` (absolute) as the last compile made it, printed as `-vcg-ast` prints it;
 * `text` as in QueryRequest (another text: no AST, `stale`).
 */
export interface AstRequest {
    kind: "ast";
    id: number;
    file: string;
    text: string;
}

/**
 * Main thread -> worker: the templates declared in `files` (absolute; those not in the last compile are skipped) with
 * the instances the last compile created of each. No text: the caller knows which documents changed since the compile.
 */
export interface InstancesRequest {
    kind: "instances";
    id: number;
    files: string[];
}

/** Main thread -> worker: the modules the last compile loaded and the imports between them. */
export interface ImportsRequest {
    kind: "imports";
    id: number;
}

/**
 * Main thread -> worker: the members visible after `expr.` at `position` of `file` (absolute), whose editor text is
 * `text`, or the names in scope there when no dot precedes the identifier being typed, from the last compile (djs
 * `queryCompletion`). Unlike the other queries, a text other than the compiled one is not a miss: djs reads the
 * expression before the dot from `text` and finds its scope at the position moved into the compiled text.
 */
export interface CompletionRequest {
    kind: "completion";
    id: number;
    file: string;
    text: string;
    position: Position;
}

/**
 * Main thread -> worker: the outline of `file` (absolute), answered from the worker's last compile; `text` as in
 * QueryRequest (another text: no outline, `stale`).
 */
export interface DocumentSymbolsRequest {
    kind: "documentSymbols";
    id: number;
    file: string;
    text: string;
}

/**
 * Main thread -> worker: the references of the symbol at `line`/`character` of `file` (absolute), answered from the
 * worker's last compile in every module it analysed; `text` as in QueryRequest (another text: none, `stale`).
 */
export interface ReferencesRequest extends Position {
    kind: "references";
    id: number;
    file: string;
    text: string;
}

/**
 * Main thread -> worker: whether the symbol at `line`/`character` of `file` can be renamed (`newName` absent), or the
 * edits renaming it to `newName`; from the worker's last compile, `text` as in QueryRequest.
 */
export interface RenameRequest extends Position {
    kind: "rename";
    id: number;
    file: string;
    text: string;
    newName?: string;
}

/**
 * Main thread -> worker: the signatures of the call whose parentheses hold `line`/`character` of `file` (absolute),
 * from the worker's last compile; `text` as in QueryRequest (another text: none, `stale`).
 */
export interface SignatureHelpRequest extends Position {
    kind: "signatureHelp";
    id: number;
    file: string;
    text: string;
}

/** Main thread -> worker: any request; the worker answers one at a time, in arrival order. */
export type Request = CompileRequest | QueryRequest | SemanticTokensRequest | InlayHintsRequest | InactiveRangesRequest
    | ExpansionRequest | ExpansionSitesRequest | AstRequest | InstancesRequest | ImportsRequest | CompletionRequest
    | DocumentSymbolsRequest | ReferencesRequest | RenameRequest | SignatureHelpRequest;

/** Worker -> main thread: the hover of a QueryRequest (djs `queryHover`). */
export interface HoverReply {
    kind: "hover";
    id: number;
    /**
     * The symbol's kind (`function`, `struct`, `parameter`, ...), its qualified name, the Markdown to show (the
     * signature or type in a ```d block, the template instance, the deprecation, the rendered doc comment), and the
     * range of the identifier hovered; null when there is nothing to show (`reason` says why).
     */
    result: { kind: string; name: string; markdown: string; range: Range } | null;
    /** True when the request's text is not the compiled one; `reason` is then the line to show instead of a hover. */
    stale: boolean;
    reason: string;
    /** The query's time in the worker, in milliseconds (the first on a file includes building its index). */
    ms: number;
}

/** Worker -> main thread: the declaration of a QueryRequest (djs `queryDefinition`). */
export interface DefinitionReply {
    kind: "definition";
    id: number;
    /**
     * The symbol's qualified name, the declaring file as the compiler names it, and the declaration's identifier in
     * it (a module: the start of its file); null when there is none (`reason` says why).
     */
    result: { name: string; file: string; range: Range } | null;
    stale: boolean;
    reason: string;
    ms: number;
}

/** Worker -> main thread: the semantic tokens of a SemanticTokensRequest (djs `querySemanticTokens`). */
export interface SemanticTokensReply {
    kind: "semanticTokens";
    id: number;
    /**
     * Flat 5-tuples `[line, character, length, type, modifiers]`, absolute (line from 0, UTF-16 character and length),
     * sorted, never overlapping; `type` indexes djs's `SEMANTIC_TOKEN_TYPES`, `modifiers` is a bit set over
     * `SEMANTIC_TOKEN_MODIFIERS`. Null when there are none to give (`reason` says why).
     */
    data: Uint32Array | null;
    stale: boolean;
    reason: string;
    /** The query's time in the worker, in milliseconds (the index build included when the query built it). */
    ms: number;
}

/**
 * One inlay hint (djs `InlayHint`): `label` goes before the character at `position`. `type`: `: T` after a variable
 * declared without a type, `-> T` after an `auto` function's parameters; `parameter`: `name:` before a call's argument;
 * `instances`: a template's instance count after its name. `tooltip` is Markdown.
 */
export interface InlayHint {
    position: Position;
    kind: "type" | "parameter" | "instances";
    label: string;
    tooltip: string;
}

/** Worker -> main thread: the hints of an InlayHintsRequest (djs `queryInlayHints`), sorted by position. */
export interface InlayHintsReply {
    kind: "inlayHints";
    id: number;
    /** Null when there are none to give (`reason` says why); an empty list when the range has none. */
    hints: InlayHint[] | null;
    stale: boolean;
    reason: string;
    /** The query's time in the worker, in milliseconds (the index build included when the query built it). */
    ms: number;
}

/** Worker -> main thread: the ranges of an InactiveRangesRequest (djs `queryInactiveRanges`). */
export interface InactiveRangesReply {
    kind: "inactiveRanges";
    id: number;
    /** Sorted, disjoint, outermost only; null when there are none to give (`reason` says why). */
    ranges: Range[] | null;
    stale: boolean;
    reason: string;
    ms: number;
}

/**
 * A construct the last compile expanded (djs `ExpansionSite`): `mixin`, a string mixin; `instance`, a template
 * instance (`Foo!(args)`, `Foo!arg`); `value`, a folded expression (an enum initializer, a `static if` condition, a
 * template value argument). `range` is the construct in the file; `title` one line for a code lens
 * (`mixin: 1 statement`, `mixin Adder!int`, `Foo!(int, 3)`, `= 42`).
 */
export interface ExpansionSite {
    kind: "mixin" | "instance" | "value";
    range: Range;
    title: string;
}

/** Worker -> main thread: the expansion of an ExpansionRequest (djs `queryExpansion`). */
export interface ExpansionReply {
    kind: "expansion";
    id: number;
    /**
     * The innermost site containing the range, with `text`, D source as dmd's hdrgen prints it, ending with "\n" (a
     * mixin's parsed members or statements, an instance's declaration as -vcg-ast prints it, a value), and
     * `instances`, how many analysed copies answer there (several inside a template body; `text` is the first's).
     * Null when there is none (`reason` says why: `no expansion at the range`, `the range is outside the text`, ...).
     */
    result: (ExpansionSite & { text: string; instances: number }) | null;
    stale: boolean;
    reason: string;
    /** The query's time in the worker, in milliseconds (the index build included when the query built it). */
    ms: number;
}

/** Worker -> main thread: the sites of an ExpansionSitesRequest (djs `queryExpansionSites`). */
export interface ExpansionSitesReply {
    kind: "expansionSites";
    id: number;
    /** Sorted by range start, not overlapping; null when there are none to give (`reason` says why). */
    sites: ExpansionSite[] | null;
    stale: boolean;
    reason: string;
    ms: number;
}

/**
 * The declarations printed in an AST (djs `AstEntry`: every declaration hdrgen's symbol printer printed, nested ones
 * too, sorted by the start of its print, a container before what it holds), packed by host/ast.ts `packAst`: per
 * entry, the range of its print in the AST text, the range of its identifier where it is declared (an instance: where
 * it was instantiated) and its extent there (functions only), in `ranges`, and the declaring file in `files`.
 */
export interface PackedAst {
    count: number;
    /** `ENTRY_INTS` (host/ast.ts) numbers per entry: print, identifier, extent; -1 four times for a missing range. */
    ranges: Int32Array;
    /** Per entry, an index into `fileNames` (files as the compiler names them); -1 when it has no source location. */
    files: Int32Array;
    fileNames: string[];
}

/** Worker -> main thread: the AST of an AstRequest (djs `queryAst`). */
export interface AstReply {
    kind: "ast";
    id: number;
    /**
     * `text`, D source printed by hdrgen as `-vcg-ast` writes it, tab indents, ending with "\n"; `entries`, the
     * declarations printed in it. Null when there is none to give (`reason` says why: also a module only imported,
     * which `-vcg-ast` does not print).
     */
    result: { text: string; entries: PackedAst } | null;
    stale: boolean;
    reason: string;
    /** The query's time in the worker, in milliseconds. */
    ms: number;
}

/** One instance of a template (djs `InstanceSite`), where the compile created it. */
export interface InstanceSite {
    /** The instance as hdrgen names it, as the AST view prints it: `Foo!(int, 3)`, `Box!int`. */
    title: string;
    /**
     * Where it was instantiated: the file as the compiler names it and the template's name there; both null when the
     * location is not in a source file.
     */
    file: string | null;
    range: Range | null;
}

/** A template (djs `TemplateInstances`) the compile instantiated, with every instance, speculative ones excepted. */
export interface TemplateInstances {
    /** dmd's `toPrettyChars`, with the parameters: `lib.Box(T)`. */
    name: string;
    /** dmd's kind of the template's eponymous member (`struct` for `Box(T)`, `function` for a function template). */
    kind: string;
    /** The declaring file as the compiler names it and the template's identifier there. */
    file: string;
    range: Range;
    /** Sorted by file, then position, then title; never empty. */
    instances: InstanceSite[];
}

/** Worker -> main thread: the templates of an InstancesRequest (djs `queryInstances`), by file, then position. */
export interface InstancesReply {
    kind: "instances";
    id: number;
    /** Null only when there is no compile to read (`reason` says why). */
    templates: TemplateInstances[] | null;
    reason: string;
    ms: number;
}

/** One module the last compile loaded (djs `ImportModule`). */
export interface ImportModule {
    /** `pkg.mod`. */
    name: string;
    /** The file as the compiler names it. */
    file: string;
    /** `root` on the command line, `included` compiled through `-i`, `imported` read for its declarations only. */
    kind: "root" | "included" | "imported";
    /** The file's size in bytes; 0 when it could not be read. */
    size: number;
    /**
     * The modules its own module-level `import` declarations name (not those inside functions and templates), indexes
     * into `ImportsReply.modules`, in source order, no duplicates, never itself.
     */
    imports: number[];
    /**
     * Its strongly connected component's number when that component holds more than one module, else null: an import
     * is in a cycle when both ends carry the same number.
     */
    cycle: number | null;
}

/**
 * Worker -> main thread: the modules of an ImportsRequest (djs `queryImports`): the roots first, then breadth-first
 * along the imports, then the modules no root reaches.
 */
export interface ImportsReply {
    kind: "imports";
    id: number;
    /** Null only when there is no compile to read (`reason` says why). */
    modules: ImportModule[] | null;
    reason: string;
    ms: number;
}

/** What a completion item is (djs `CompletionKind`), for the editor's icon: LSP's names. */
export type CompletionKind = "method" | "function" | "field" | "property" | "variable" | "constant" | "enumMember"
    | "enum" | "struct" | "class" | "interface" | "module" | "typeParameter";

/** One name visible after the dot, or where no dot precedes the position (djs `CompletionItem`). */
export interface CompletionItem {
    /** The name as written. */
    label: string;
    kind: CompletionKind;
    /** One line: the signature or type as the hover's code block prints it; "" when none. */
    detail: string;
    /** The doc comment's first line (its summary); "" when none. */
    documentation: string;
    /**
     * The editor's order. After a dot: members of the type (0), UFCS candidates (1), built-in properties (2). Without
     * one: locals and parameters (0), the enclosing aggregate's members (1), the module's names (2), the imported
     * modules' (3).
     */
    group: 0 | 1 | 2 | 3;
}

/** Worker -> main thread: the names of a CompletionRequest (djs `queryCompletion`). */
export interface CompletionReply {
    kind: "completion";
    id: number;
    /**
     * `range`, the text the items replace in the request's text (the identifier characters typed up to the position,
     * after the dot or not; empty right after the dot or with nothing typed); `items`, sorted by group, then label, as
     * djs gives them; `moved`, true when the request's text was not the compiled one and the scope was found through
     * the text move. Null when there is no answer, `reason` saying why: the misses are djs's, listed in
     * `queryCompletion`'s contract (src/query.ts).
     */
    result: { range: Range; items: CompletionItem[]; moved: boolean } | null;
    stale: boolean;
    reason: string;
    /** The query's time in the worker, in milliseconds (the index build included when the query built it). */
    ms: number;
}

/**
 * One declaration of an outline (djs `DocumentSymbol`): `kind` is LSP's name (`struct`, `method`, `enumMember`, ...),
 * `detail` the signature or type, short (`(mixin) ` before a string mixin's declarations), `range` the whole
 * declaration, `selectionRange` its name.
 */
export interface DocumentSymbol {
    name: string;
    kind: SymbolKindName;
    detail: string;
    range: Range;
    selectionRange: Range;
    children: DocumentSymbol[];
}

export type SymbolKindName = "module" | "namespace" | "class" | "struct" | "interface" | "enum" | "enumMember"
    | "function" | "method" | "constructor" | "property" | "field" | "variable" | "constant" | "typeParameter";

/** Worker -> main thread: the outline of a DocumentSymbolsRequest (djs `queryDocumentSymbols`). */
export interface DocumentSymbolsReply {
    kind: "documentSymbols";
    id: number;
    /** The declarations as a tree, each level sorted by position; null when there are none to give (`reason`). */
    symbols: DocumentSymbol[] | null;
    stale: boolean;
    reason: string;
    /** The query's time in the worker, in milliseconds (the index build included when the query built it). */
    ms: number;
}

/** One reference (djs `ReferenceSite`): the file as the compiler names it, the identifier, whether it declares. */
export interface ReferenceSite {
    file: string;
    range: Range;
    declaration: boolean;
}

/** Worker -> main thread: the references of a ReferencesRequest (djs `queryReferences`). */
export interface ReferencesReply {
    kind: "references";
    id: number;
    /** The symbol's qualified name and its references, sorted by file and position; null when none (`reason`). */
    result: { name: string; references: ReferenceSite[] } | null;
    stale: boolean;
    reason: string;
    /** The query's time in the worker, in milliseconds (the index builds of the modules searched included). */
    ms: number;
}

/**
 * Worker -> main thread: a RenameRequest's answer (djs `queryPrepareRename`, `queryRename`). Without `newName`: the
 * identifier and its text (`range`, `placeholder`), no edits; with it: the edits, each range replaced by `newName`
 * (`range` the request's position, `placeholder` the new name). Null when the
 * symbol cannot be renamed or the name is refused (`reason` says why, in words for the user).
 */
export interface RenameReply {
    kind: "rename";
    id: number;
    result: { range: Range; placeholder: string; edits: { file: string; range: Range }[] } | null;
    stale: boolean;
    reason: string;
    ms: number;
}

/**
 * One candidate of a call (djs `SignatureInformation`): its label (`int grow(Shape s, int by)`), each parameter's span
 * in it (UTF-16 offsets, end exclusive), the doc comment's summary.
 */
export interface SignatureInformation {
    label: string;
    parameters: [number, number][];
    documentation: string;
}

/** Worker -> main thread: the signatures of a SignatureHelpRequest (djs `querySignatureHelp`). */
export interface SignatureHelpReply {
    kind: "signatureHelp";
    id: number;
    /**
     * The candidates (the one the compile picked first), the active one and the argument the position is in (a UFCS
     * receiver is the first); null when none (`reason`: not in a call, no function, stale).
     */
    result: { signatures: SignatureInformation[]; activeSignature: number; activeParameter: number } | null;
    stale: boolean;
    reason: string;
    ms: number;
}

/** djs's semantic-token legend: the names `SemanticTokensReply` indexes (`SEMANTIC_TOKEN_TYPES`, `..._MODIFIERS`). */
export interface TokenLegend {
    types: string[];
    modifiers: string[];
}

/**
 * Worker -> main thread: the worker has imported the compiler and takes requests; `legend` is the compiler's, sent
 * here so that the extension host never loads the compiler to read it.
 */
export interface ReadyMessage {
    kind: "ready";
    legend: TokenLegend;
}

/** Worker -> main thread: the reply to a `Request`, matched by `id` (`DjsCompiler.pending` resolves with it). */
export type Reply = CompileReply | HoverReply | DefinitionReply | SemanticTokensReply | InlayHintsReply
    | InactiveRangesReply | ExpansionReply | ExpansionSitesReply | AstReply | InstancesReply | ImportsReply
    | CompletionReply | DocumentSymbolsReply | ReferencesReply | RenameReply | SignatureHelpReply;

export type WorkerMessage = Reply | ReadyMessage;
