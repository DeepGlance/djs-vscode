// The main-thread side of the compiler worker: one worker, one compile at a time.
//
// Used by the extension (extension/extension.cts) and by the host tests; it has no VS Code dependency.

import { Worker } from "node:worker_threads";
import type {
    AstReply, CompileReply, CompletionReply, DefinitionReply, ExpansionReply, ExpansionSitesReply, HoverReply,
    ImportsReply, InactiveRangesReply, InlayHintsReply, InstancesReply, Position, Range, Reply, Request,
    SemanticTokensReply, TokenLegend, WorkerMessage,
} from "./protocol.js";

/** Where `DjsCompiler.send` puts a call: after every queued one, or ahead of those queued `last`. */
type QueuePosition = "last" | "next";

/** The worker's stack: the CLI runs `node --stack-size=7600` (KiB) on the main thread's 8 MiB (ruling 3). */
export const STACK_SIZE_MB = 8;

/**
 * A djs compiler in a worker thread.
 *
 * `compile` and the queries (`hover`, `definition`, `semanticTokens`, `inlayHints`, `inactiveRanges`, `expansionSites`,
 * `expansion`, `ast`, `instances`, `imports`, `completion`) run one at a time, in one queue, each resolving with the
 * worker's reply. The queue runs in call order, except that `hover` and `completion` (a user waiting on the answer) go
 * ahead of every call queued and not yet started, in call order among themselves: a refresh's tokens, hints, lenses or
 * AST print queued after a compile no longer delay them. Nothing preempts the call running: a query answers from the
 * last compile that ran before it, so a query made during a compile waits for that compile (a hover or completion
 * queued behind a compile that has not started answers from the compile before it). A query whose `cancelled` answers
 * true when its turn comes resolves null without reaching the worker (an editor gave up on it). A worker that dies (an
 * out-of-memory abort, a native stack overflow, `process.exit` from a fatal handler) rejects the call in flight with
 * the exit reason; the next call starts a new worker, paying the import of the emit again (~0.2 s), and finds no kept
 * state, so its first compile is fresh (`no kept state`) and a query before it finds no file. `dispose` loses the kept
 * state the same way.
 * Cost per compile: what djsMainKept costs: a fresh compile (seconds for a module importing Phobos) on a worker's
 * first call and whenever the engine falls back, otherwise the changed modules plus the replay of the kept ones;
 * the reply is a few KB. Per query: the worker's index of the file at the first query on it after a compile (dgpro07
 * labserver.d: tens of milliseconds), then well under a millisecond, plus the message round trip; the semantic tokens
 * of a file, one pass over it (labserver.d under -i: ~9000 tokens, 180 KB copied back, ~30-40 ms in the worker,
 * ~70-90 ms when the query builds the file's index); the inlay hints of the whole file (labserver.d: ~1800 hints,
 * ~27 ms, ~75 ms with the index build); its inactive ranges, ~2 ms once per compile, then kept with the index; its
 * expansion sites (labserver.d: 41), ~60-90 ms with the index build, then ~0.2 ms; one expansion, ~0.15 ms (up to
 * ~15 ms for a large instance printed by hdrgen), round trip ~0.3-0.5 ms more; a module's AST, one hdrgen print of
 * it at the first request after a compile, then kept by djs (labserver.d under -i: 5.8 MB, 65,000 entries, seconds;
 * ~30 ms after, the packing of the entries and the copy included); the instances, djs's instance table at the first
 * need after a compile (labserver.d's 168 own files: ~0.4 s); the imports, one pass over the modules (~30 ms); a
 * completion (labserver.d under -i, 44-71 items, at load 9), ~50 ms with the index build, then ~2-7 ms, the most
 * for a receiver with UFCS candidates (`arg.`: 64). A compile with `texts` copies them to the worker on top of its
 * cost (labserver.d with a one-line edit in a function body, kept from the buffer: ~0.9 s at load 9).
 */
export class DjsCompiler {
    private worker: Worker | null = null;
    private ready: Promise<void> | null = null;
    private nextId = 1;
    /** The calls not yet started, in the order they run; the one running is not here. */
    private queue: { position: QueuePosition; run: () => Promise<void> }[] = [];
    private running = false;
    private pending: { id: number; resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
    private tokenLegend: TokenLegend | null = null;

    /** `workerFile`: the emitted host/worker.js (the default is the one next to this file). */
    constructor(private readonly workerFile: URL = new URL("./worker.js", import.meta.url)) {}

    private start(): Promise<void> {
        const w = new Worker(this.workerFile, { resourceLimits: { stackSizeMb: STACK_SIZE_MB } });
        this.worker = w;
        return new Promise<void>((resolve, reject) => {
            w.on("message", (m: WorkerMessage) => {
                if (m.kind === "ready") {
                    this.tokenLegend = m.legend;
                    resolve();
                } else if (this.pending !== null && m.id === this.pending.id) {
                    const p = this.pending;
                    this.pending = null;
                    p.resolve(m);
                }
            });
            const fail = (e: Error): void => {
                if (this.worker === w) {
                    this.worker = null;
                    this.ready = null;
                }
                reject(e);
                if (this.pending !== null) {
                    const p = this.pending;
                    this.pending = null;
                    p.reject(e);
                }
            };
            w.on("error", fail);
            w.on("exit", (code) => fail(new Error(`djs worker exited with code ${code}`)));
        });
    }

    /**
     * Queues `make(id)`, at the end (`last`) or ahead of every call not yet started that was queued `last` (`next`):
     * when its turn comes, `cancelled` is asked first (true resolves null, the worker untouched), then the worker is
     * started if needed and the request sent; the promise resolves with the reply, or rejects when the worker dies.
     */
    private send<R extends Reply>(make: (id: number) => Request, cancelled: () => boolean = () => false,
        position: QueuePosition = "last"): Promise<R | null> {
        return new Promise<R | null>((resolve, reject) => {
            const run = async (): Promise<void> => {
                try {
                    if (cancelled()) {
                        resolve(null);
                        return;
                    }
                    this.ready ??= this.start();
                    await this.ready;
                    const req = make(this.nextId++);
                    resolve(await new Promise<R>((answered, died) => {
                        this.pending = { id: req.id, resolve: answered as (r: Reply) => void, reject: died };
                        this.worker!.postMessage(req);
                    }));
                } catch (e) {
                    reject(e);
                }
            };
            const at = position === "next" ? this.queue.findIndex((j) => j.position === "last") : -1;
            this.queue.splice(at < 0 ? this.queue.length : at, 0, { position, run });
            this.pump();
        });
    }

    /** Starts the first queued call when none runs; each call, done or failed, starts the next. */
    private pump(): void {
        if (this.running)
            return;
        const job = this.queue.shift();
        if (job === undefined)
            return;
        this.running = true;
        void job.run().finally(() => {
            this.running = false;
            this.pump();
        });
    }

    /**
     * Compiles once with the full ldmd2 command line `args`, reading the files of `texts` (absolute path -> text) from
     * it instead of the disk; see host/worker.ts for the contract on `args` and CompileRequest for `texts`. Cost: the
     * texts are copied to the worker (structured clone) on top of the compile.
     */
    async compile(args: readonly string[], texts?: Readonly<Record<string, string>>): Promise<CompileReply> {
        return (await this.send<CompileReply>((id) => ({ kind: "compile", id, args: [...args], texts })))!;
    }

    /**
     * The hover of the symbol at `line`/`character` (from 0, UTF-16) of `file` (absolute), whose editor text is
     * `text`, from the last compile; queued ahead of the calls not yet started (see the class); null when `cancelled`
     * answers true at its turn. See QueryRequest and HoverReply.
     */
    hover(file: string, line: number, character: number, text: string, cancelled?: () => boolean)
        : Promise<HoverReply | null> {
        return this.send<HoverReply>((id) => ({ kind: "hover", id, file, line, character, text }), cancelled, "next");
    }

    /** The declaration of the symbol at `line`/`character` of `file`; as `hover`, with a DefinitionReply. */
    definition(file: string, line: number, character: number, text: string, cancelled?: () => boolean)
        : Promise<DefinitionReply | null> {
        return this.send<DefinitionReply>((id) => ({ kind: "definition", id, file, line, character, text }), cancelled);
    }

    /**
     * The semantic tokens of `file` (absolute), whose editor text is `text`, from the last compile; null when
     * `cancelled` answers true at its turn. See SemanticTokensRequest and SemanticTokensReply.
     */
    semanticTokens(file: string, text: string, cancelled?: () => boolean): Promise<SemanticTokensReply | null> {
        return this.send<SemanticTokensReply>((id) => ({ kind: "semanticTokens", id, file, text }), cancelled);
    }

    /**
     * The inlay hints of `range` of `file` (absolute), whose editor text is `text`, from the last compile; null when
     * `cancelled` answers true at its turn. See InlayHintsRequest and InlayHintsReply.
     */
    inlayHints(file: string, text: string, range: Range, cancelled?: () => boolean): Promise<InlayHintsReply | null> {
        return this.send<InlayHintsReply>((id) => ({ kind: "inlayHints", id, file, text, range }), cancelled);
    }

    /**
     * The ranges of `file` (absolute), whose editor text is `text`, in the branches the last compile did not choose;
     * null when `cancelled` answers true at its turn. See InactiveRangesRequest and InactiveRangesReply.
     */
    inactiveRanges(file: string, text: string, cancelled?: () => boolean): Promise<InactiveRangesReply | null> {
        return this.send<InactiveRangesReply>((id) => ({ kind: "inactiveRanges", id, file, text }), cancelled);
    }

    /**
     * The expansion of `range` (lines from 0, UTF-16 characters, end exclusive; empty for a cursor) of `file`
     * (absolute), whose editor text is `text`, from the last compile; null when `cancelled` answers true at its turn.
     * See ExpansionRequest and ExpansionReply.
     */
    expansion(file: string, range: Range, text: string, cancelled?: () => boolean): Promise<ExpansionReply | null> {
        return this.send<ExpansionReply>((id) => ({ kind: "expansion", id, file, text, range }), cancelled);
    }

    /**
     * The expansion sites of `file` (absolute), whose editor text is `text`, from the last compile; null when
     * `cancelled` answers true at its turn. See ExpansionSitesRequest and ExpansionSitesReply.
     */
    expansionSites(file: string, text: string, cancelled?: () => boolean): Promise<ExpansionSitesReply | null> {
        return this.send<ExpansionSitesReply>((id) => ({ kind: "expansionSites", id, file, text }), cancelled);
    }

    /**
     * The module of `file` (absolute), whose editor text is `text`, as the last compile made it (`-vcg-ast`'s print and
     * its declarations); null when `cancelled` answers true at its turn. See AstRequest and AstReply.
     */
    ast(file: string, text: string, cancelled?: () => boolean): Promise<AstReply | null> {
        return this.send<AstReply>((id) => ({ kind: "ast", id, file, text }), cancelled);
    }

    /**
     * The templates declared in `files` (absolute; those not in the last compile are skipped) with their instances;
     * null when `cancelled` answers true at its turn. See InstancesRequest and InstancesReply.
     */
    instances(files: readonly string[], cancelled?: () => boolean): Promise<InstancesReply | null> {
        return this.send<InstancesReply>((id) => ({ kind: "instances", id, files: [...files] }), cancelled);
    }

    /**
     * The modules the last compile loaded and their imports; null when `cancelled` answers true at its turn. See
     * ImportsRequest and ImportsReply.
     */
    imports(cancelled?: () => boolean): Promise<ImportsReply | null> {
        return this.send<ImportsReply>((id) => ({ kind: "imports", id }), cancelled);
    }

    /**
     * The members visible after the dot before `position` (line from 0, UTF-16 character) of `file` (absolute), whose
     * editor text is `text`, from the last compile; queued ahead of the calls not yet started (see the class); null
     * when `cancelled` answers true at its turn. See CompletionRequest and CompletionReply. Cost: the file's index at
     * the first query on it after a compile (labserver.d under -i: ~50 ms in all, at load 9), then ~2-7 ms, the most
     * for a receiver with many UFCS candidates.
     */
    completion(file: string, text: string, position: Position, cancelled?: () => boolean)
        : Promise<CompletionReply | null> {
        return this.send<CompletionReply>((id) => ({ kind: "completion", id, file, text, position }), cancelled,
            "next");
    }

    /**
     * djs's semantic-token legend, which the worker sends when it is ready: starts the worker when none runs (the
     * compiler's import, ~0.2 s), outside the queue, so it does not wait for a compile.
     */
    async legend(): Promise<TokenLegend> {
        this.ready ??= this.start();
        await this.ready;
        return this.tokenLegend!;
    }

    /** Stops the worker; a later compile starts a new one. */
    async dispose(): Promise<void> {
        const w = this.worker;
        this.worker = null;
        this.ready = null;
        if (w !== null)
            await w.terminate();
    }
}
