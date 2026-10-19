// The druntime/Phobos runner: measures the djs shim against ldmd2 1.43.0 on the library ldc2 ships with.
//
// Hand-written djs tool, NOT a port. It compiles every module of the oracle install's import tree (object.d,
// core/, std/, etc/, ldc/) as a root module, once through the shim and once through ldmd2 (tests/corpus/run.ts
// ORACLE), with the same arguments, and classifies the pair as the corpus runner does; then it compares the two
// `-vcg-ast` files, so a module whose diagnostics match but whose lowered AST differs is told apart. Both
// compilers run under `/usr/bin/time -l`, and the record keeps their wall time and peak RSS.
//
// THE TREE. The import directory is copied to a fresh temporary directory: `-vcg-ast` writes `<module>.cg`
// next to the source (main.d:857), and the installed tree must stay untouched. Both compilers run from the
// copy's root with the module's relative path, so every import resolves in the copy first (the current directory
// precedes the import path in FileManager.lookForSourceFile), and ldc2.conf's import directory, which both read,
// is reached only by what the copy does not hold.
//
// THE COMMAND, per module: `-c -o- -vcg-ast <path>`, with `-unittest` and then the `--flags` switches before the
// path. The unittest measurement passes LDC's own runtime unittest flags (runtime/CMakeLists.txt:36, :51, :53:
// `-w -de -preview=dip1000 -preview=dtorfields -preview=fieldwise -version=CoreUnittest -version=StdUnittest
// -checkaction=context`): without StdUnittest, Phobos compiles almost none of its unittests. Every
// `.d` and `.di` file is a module and is measured (the ldc/*.di modules are the compiler's intrinsics, imported
// as modules by core and std), and so is the one C header, importc.h, through ImportC (`cc` preprocesses it).
// ldc/opencl.di (and any module in a directory ldc/dcompute*/) is SKIP-DCOMPUTE: a `@compute` module needs LDC's
// DCompute semantic (gen/semantic.d:20, dcomputeSemanticAnalysis in C++), which the port does not carry.
// Under `--unittest`, the modules of NO_VCG_UNITTEST are compiled without `-vcg-ast`: ldc2 itself never finishes
// their `.cg` dump, so only the exit status and the diagnostics are compared (decision of the advisor; each one
// gets a line, with the ldc2 cause, in the summary notes).
//
// CAPTURE. As the corpus runner's: stdout and stderr to one file (`>f 2>&1`), so the write order is exact.
// `/usr/bin/time -o` writes its report to a second file. A compiler killed by a signal makes time print
// `time: command terminated abnormally` on the captured stderr and then raise the same signal on itself, so the
// run's signal is the compiler's (SIGSEGV, SIGBUS, SIGABRT): the runner removes time's lines from the text and
// records the run as killed by that signal. The timeout kills the whole process group (time, ldmd2 and its ldc2
// child), so no compiler outlives its record.
//
// CLASSES. Those of tests/corpus/run.ts `classify` (MATCH, MISMATCH-EXIT, MISMATCH-OUTPUT, CRASH, TIMEOUT,
// UNSUPPORTED-FLAG), plus MISMATCH-CG: same exit status and text, different `.cg` files after path
// normalization; its record carries the first differing `.cg` line as `diff`, so the summary buckets it with the
// other mismatches. A `.cg` written by one compiler only is a difference too (main.d:857 writes it whenever the
// driver gets there, errors or not, so one side stopping earlier is a divergence): its `diff` is line 1, `<no .cg>`
// against the first line of the file that exists. The comparison is skipped, and recorded as such, only when
// neither compiler wrote a `.cg` (an error stopped both before main.d:857). The `.cg` texts are normalized for
// paths only (the copy's root and the install's), not by the diagnostic normalizer. A record's `dir` is the
// module's top-level directory (`core`, `std`, ...; `(root)` for object.d, __importc_builtins.di and importc.h).
//
// TIMING. `wallS` is time's `real` (10 ms resolution), `rssBytes` its `maximum resident set size` (for ldmd2,
// the maximum over ldmd2 and the ldc2 it spawns: the kernel folds a waited-for child's usage into its parent).
// The summary gives median, p90 and max of each per compiler over the modules where both compilers ran, and
// the shim/ldmd2 ratio of each statistic. Parallel jobs share the cores: compare wall times within one run.
//
// PROBES. `--probe-program` compiles a one-file program importing std.stdio, std.algorithm and std.range
// (`-c -o- prog.d` in the copy) with both compilers, classified and timed like a module. `--sequence <entries>`
// asks whether the frontend compiles correctly many times in one Node process, as an editor host would run it:
// one child process imports the shim once and calls `djsMain` once per entry, in order, and each call's exit
// status, merged output and `.cg` are compared with a fresh shim process for the same entry, with the call's time,
// the process RSS and the heap left reachable after it (after a full GC); the summary adds the cold first call and
// the median and p90 of the calls after it (the edit loop's latency). An entry is a module path relative to the
// import root, or `<path>=<file>`: `<file>` is copied to `<path>` in the copy before the call (and before its fresh
// run), so one path can alternate between a clean and a broken text, an edit loop's shape (a list that also names
// that path bare is refused). `--sequence` may repeat; each list runs in its own child and starts from the copy's
// own text. With `--keep` the child calls `djsMainKept` (src/djs.ts, the kept-module engine, 10 §4.7) instead of
// `djsMain`, and the calls and their fresh references drop `-vcg-ast`, which the engine refuses: each call is
// compared on exit status and merged output, and the table says whether it was kept and, when fresh, why.
// Both probes run in addition to the module measurement; `--only /dev/null` measures no module.
//
// USAGE (Node >= 22.18 runs this file directly, type stripping on):
//   node tests/phobos/run.ts --out <results.json> [--unittest] [--flags "<switches>"] [--sample N] [--jobs 4]
//       [--timeout 300] [--only <list>] [--probe-program] [--sequence <entry,entry,...>]... [--keep]
// `--only` reads a file of module paths relative to the import root (`std/ascii.d`). It writes <results.json>
// and <results>.summary.txt, prints the summary, and removes the temporary directory. The results are a
// measurement, not a fixture: nothing here commits them.

import { spawn } from "node:child_process";
import {
    closeSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
    realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
    LDC_ROOT, ORACLE, SHIM_LDC, STACK_KB, classify, emitTree, firstDifference, normalize, sampleOf, summarize,
    treeState,
} from "../corpus/run.ts";
import type { RunOutput, TestResult } from "../corpus/run.ts";

/** The installed import tree the oracle reads; copied, never written. */
export const IMPORT_ROOT = `${LDC_ROOT}/import`;
/** The top-level entries of IMPORT_ROOT that hold modules. */
const MODULE_ROOTS = ["object.d", "core", "std", "etc", "ldc"];
const TIME = "/usr/bin/time";

// ── /usr/bin/time -l ───────────────────────────────────────────────────────────────────────────────────

/** What one compiler run cost, from `/usr/bin/time -l`. */
export interface Cost {
    wallS: number;
    userS: number;
    sysS: number;
    rssBytes: number;
}

/**
 * Parses macOS `/usr/bin/time -l` output: the `<real> real <user> user <sys> sys` line (the decimal separator
 * follows the locale, `0,40` or `0.40`) and the `maximum resident set size` line, in bytes. Returns null when
 * either line is missing (time did not run the command, or the file is empty).
 */
export function parseTimeL(text: string): Cost | null {
    const t = /^\s*(\d+[.,]\d+) real\s+(\d+[.,]\d+) user\s+(\d+[.,]\d+) sys$/m.exec(text);
    const rss = /^\s*(\d+)\s+maximum resident set size$/m.exec(text);
    if (!t || !rss)
        return null;
    const n = (s: string): number => Number.parseFloat(s.replace(",", "."));
    return { wallS: n(t[1]!), userS: n(t[2]!), sysS: n(t[3]!), rssBytes: Number.parseInt(rss[1]!, 10) };
}

/**
 * Removes time's own lines (`time: ...`) from a captured text; `killed` is true when time reported that the
 * command terminated abnormally (a signal). No compiler message starts a line with `time: `.
 */
export function stripTimeLines(text: string): { text: string; killed: boolean } {
    const killed = /^time: command terminated abnormally$/m.test(text);
    return { text: text.replace(/^time: [^\n]*\n?/gm, ""), killed };
}

/** A run's output (as the corpus runner's `RunOutput`) and its cost (null when time wrote no report). */
interface TimedRun extends RunOutput {
    cost: Cost | null;
}

/**
 * Runs `argv` under `/usr/bin/time -l` from `cwd`, stdout and stderr both to `captureFile` and time's report to
 * `captureFile.time`; kills the process group after `timeoutMs`. Removes both files.
 */
function runTimed(argv: string[], cwd: string, timeoutMs: number, captureFile: string): Promise<TimedRun> {
    return new Promise((done, fail) => {
        const env = { ...process.env };
        delete env["DFLAGS"];   // ldmd2 appends $DFLAGS (ldmd.cpp:translateArgs); the shim has no such input
        const timeFile = `${captureFile}.time`;
        const fd = openSync(captureFile, "w+");
        const child = spawn(TIME, ["-l", "-o", timeFile, ...argv], { cwd, env, stdio: ["ignore", fd, fd],
            detached: true });
        closeSync(fd);
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            try {
                process.kill(-child.pid!, "SIGKILL");
            } catch {
                child.kill("SIGKILL");   // the group is already gone; the leader may still be reaped
            }
        }, timeoutMs);
        child.on("error", (e) => {
            clearTimeout(timer);
            fail(e);
        });
        child.on("close", (code, signal) => {
            clearTimeout(timer);
            const raw = readFileSync(captureFile, "utf8");
            const cost = existsSync(timeFile) ? parseTimeL(readFileSync(timeFile, "utf8")) : null;
            rmSync(captureFile, { force: true });
            rmSync(timeFile, { force: true });
            const { text, killed } = stripTimeLines(raw);
            if (killed)
                done({ code: null, signal: signal ?? "a signal (reported by time)", text, timedOut, cost });
            else
                done({ code, signal, text, timedOut, cost });
        });
    });
}

// ── the .cg comparison ─────────────────────────────────────────────────────────────────────────────────

/** The outcome of comparing the two `.cg` files of one module. */
export interface CgComparison {
    status: "same" | "differ" | "skipped";
    reason?: string;   // skipped: neither compiler wrote one; differ: only one compiler wrote one, and which
    diff?: { line: number; shim: string; oracle: string };
}

/** The placeholder a missing `.cg` file stands as in a one-sided difference. */
const NO_CG = "<no .cg>";

/**
 * Compares the shim's and the oracle's `.cg` texts, already normalized; null stands for a file the compiler
 * did not write. Skipped only when neither wrote one; a file on one side only differs at line 1, and the
 * reason names the side that wrote it by `names` (`--sequence` compares an in-process call with a fresh process).
 */
export function compareCg(shim: string | null, oracle: string | null,
    names = { shim: "the shim", oracle: "ldmd2" }): CgComparison {
    if (shim === null && oracle === null)
        return { status: "skipped", reason: "neither compiler wrote a .cg" };
    if (shim === null || oracle === null) {
        const first = (t: string | null): string => t === null ? NO_CG : t.split("\n")[0]!;
        return {
            status: "differ", reason: `only ${shim === null ? names.oracle : names.shim} wrote a .cg`,
            diff: { line: 1, shim: first(shim), oracle: first(oracle) },
        };
    }
    const diff = firstDifference(shim, oracle);
    return diff === null ? { status: "same" } : { status: "differ", diff };
}

/**
 * Normalizes a `.cg` text for comparison: the copy's root and the install's root replaced by placeholders, and
 * nothing else: the corpus `normalize` also rewrites newlines and message prefixes, which are diagnostics' traits.
 */
export function normalizeCg(text: string, root: string): string {
    return text.split(root).join("{ROOT}").split(LDC_ROOT).join("{LDC}");
}

/**
 * The final class of a module: the corpus verdict, turned into MISMATCH-CG when it is MATCH and the `.cg`
 * files differ, one-sided included (the `.cg` difference becomes the record's `diff`).
 */
export function withCg(verdict: Pick<TestResult, "status" | "detail" | "signature" | "diff">,
    cg: CgComparison): Pick<TestResult, "status" | "detail" | "signature" | "diff"> {
    if (verdict.status === "MATCH" && cg.status === "differ")
        return { status: "MISMATCH-CG", diff: cg.diff };
    return verdict;
}

// ── records and the timing summary ─────────────────────────────────────────────────────────────────────

/** One module's record: the corpus record plus the `.cg` comparison and both runs' cost. */
export interface PhobosResult extends TestResult {
    cg?: CgComparison;
    cost?: { shim: Cost | null; oracle: Cost | null };
    /** Set when the module ran without `-vcg-ast` under `--unittest`: the NO_VCG_UNITTEST reason. */
    noVcg?: string;
}

/**
 * The modules compiled without `-vcg-ast` under `--unittest`, with the reason: ldc2 does not finish their `.cg`
 * dump, so a comparison with it proves nothing. Without `-vcg-ast` both compilers finish in seconds.
 */
export const NO_VCG_UNITTEST: ReadonlyMap<string, string> = new Map([
    ["std/meta.d", "ldc2 does not finish the -vcg-ast dump: `alias Big = Repeat!(1_000_000, int);` (std/meta.d:1161) "
        + "prints in O(N^2), hdrgen.d:3658 parametersToBuffer walking Parameter.getNth (mtype.d:2207); over 8 min"],
    ["std/traits.d", "ldc2 does not finish the -vcg-ast dump: parentOf!(packageName) aliases the module itself "
        + "(templatesem.d:1394) and hdrgen.d:3966 prints it again without end; killed at 173 s, 5.2 GB"],
]);

/** The nearest-rank `p`-quantile (0 < p <= 1) of a non-empty list. */
export function quantile(values: readonly number[], p: number): number {
    const s = [...values].sort((a, b) => a - b);
    return s[Math.max(0, Math.ceil(p * s.length) - 1)]!;
}

/**
 * The timing table: median, p90 and max of wall seconds and peak RSS per compiler, over the records where
 * both runs have a cost, and the shim/ldmd2 ratio of each statistic.
 */
export function timingSummary(results: readonly PhobosResult[]): string {
    const both = results.filter((r) => r.cost?.shim && r.cost.oracle);
    if (both.length === 0)
        return "Timing: no module with both runs timed\n";
    const lines = [`Timing over ${both.length} modules with both runs timed (median / p90 / max)`];
    const stats = (v: number[]): number[] => [quantile(v, 0.5), quantile(v, 0.9), Math.max(...v)];
    const row = (name: string, v: number[], fmt: (x: number) => string): string =>
        `  ${name.padEnd(16)}${v.map((x) => fmt(x).padStart(12)).join("")}`;
    const metric = (title: string, get: (c: Cost) => number, fmt: (x: number) => string): void => {
        const shim = stats(both.map((r) => get(r.cost!.shim!)));
        const oracle = stats(both.map((r) => get(r.cost!.oracle!)));
        lines.push(title, row("djs", shim, fmt), row("ldmd2", oracle, fmt),
            row("ratio djs/ldmd2", shim.map((x, i) => x / oracle[i]!), (x) => `${x.toFixed(1)}x`));
    };
    metric(" wall seconds", (c) => c.wallS, (x) => x.toFixed(2));
    metric(" peak RSS MiB", (c) => c.rssBytes, (x) => (x / 2 ** 20).toFixed(0));
    return lines.join("\n") + "\n";
}

/**
 * The summary notes: one line per skip class present, its count and the reason the files are not measured; then
 * one line per module measured without `-vcg-ast` (NO_VCG_UNITTEST), with its reason.
 */
export function skipNotes(results: readonly PhobosResult[]): string {
    const skips = new Map<string, { n: number; detail: string }>();
    for (const r of results) {
        if (r.status.startsWith("SKIP-")) {
            const k = skips.get(r.status);
            skips.set(r.status, { n: (k?.n ?? 0) + 1, detail: r.detail ?? "" });
        }
    }
    const noVcg = results.filter((r) => r.noVcg !== undefined)
        .map((r) => `       ${r.file} measured without -vcg-ast: ${r.noVcg}`);
    return ["Notes", ...[...skips].sort().map(([c, k]) => `${String(k.n).padStart(5)}  ${c}: ${k.detail}`), ...noVcg]
        .join("\n") + "\n";
}

/** The `.cg` comparisons the summary reports apart: how many were skipped, and why. */
function cgSummary(results: readonly PhobosResult[]): string {
    const counts = new Map<string, number>();
    for (const r of results) {
        if (r.cg) {
            const k = r.cg.reason ? `${r.cg.status}: ${r.cg.reason}` : r.cg.status;
            counts.set(k, (counts.get(k) ?? 0) + 1);
        }
    }
    return [".cg comparisons", ...[...counts].sort().map(([k, n]) => `${String(n).padStart(5)}  ${k}`)]
        .join("\n") + "\n";
}

// ── enumeration ────────────────────────────────────────────────────────────────────────────────────────

/** Every file under MODULE_ROOTS of `root` and at its top level, relative to `root`, sorted. */
function enumerate(root: string): string[] {
    const out: string[] = [];
    const walk = (rel: string): void => {
        for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
            const p = rel === "" ? e.name : `${rel}/${e.name}`;
            if (e.isDirectory()) {
                if (rel !== "" || MODULE_ROOTS.includes(e.name))
                    walk(p);
            } else {
                out.push(p);
            }
        }
    };
    walk("");
    return out.sort();
}

/** Why a DCompute module is not measured: the record's detail and its line in the summary notes. */
const DCOMPUTE_NOTE = "a @compute module: LDC's DCompute semantic (gen/semantic.d:20, C++) is not ported";

/**
 * The skip class of a file that is not measured, or null for a module that is (`.d`, `.di`, and a C source,
 * `.h`, `.c` or `.i`, through ImportC): a DCompute module (ldc/opencl.di, or a module under a directory whose name
 * starts with `ldc/dcompute`) is SKIP-DCOMPUTE. ldc/dcompute.d itself is no `@compute` module and stays measured.
 */
export function skipOf(rel: string): { status: string; detail: string } | null {
    if (rel === "ldc/opencl.di" || /^ldc\/dcompute[^/]*\//.test(rel))
        return { status: "SKIP-DCOMPUTE", detail: DCOMPUTE_NOTE };
    if (/\.(d|di|h|c|i)$/.test(rel))
        return null;
    return { status: "SKIP-OTHER", detail: "not a D or C source" };
}

// ── the driver ─────────────────────────────────────────────────────────────────────────────────────────

interface Options {
    out: string;
    unittest: boolean;
    flags: string[];    // extra switches for both compilers, before the module path
    sample: number;     // 0 = every module
    jobs: number;
    timeoutS: number;
    only: Set<string> | null;
    probeProgram: boolean;
    sequences: string[][];   // `--sequence` lists, one child process each
    keep: boolean;           // `--keep`: the sequence child calls `djsMainKept`, without `-vcg-ast`
}

const USAGE = "usage: node tests/phobos/run.ts --out <results.json> [--unittest] [--flags \"<switches>\"] "
    + "[--sample N] [--jobs 4] [--timeout 300] [--only <list>] [--probe-program] [--sequence <entry,...>]... "
    + "[--keep (with --sequence)]";

function parseOptions(argv: string[]): Options {
    const o: Options = { out: "", unittest: false, flags: [], sample: 0, jobs: 4, timeoutS: 300, only: null,
        probeProgram: false, sequences: [], keep: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        const next = (): string => {
            const v = argv[++i];
            if (v === undefined)
                throw new Error(`${a} needs a value`);
            return v;
        };
        if (a === "--out") o.out = resolve(next());
        else if (a === "--unittest") o.unittest = true;
        else if (a === "--flags") o.flags = next().split(/\s+/).filter((f) => f !== "");
        else if (a === "--sample") o.sample = Number.parseInt(next(), 10);
        else if (a === "--jobs") o.jobs = Number.parseInt(next(), 10);
        else if (a === "--timeout") o.timeoutS = Number.parseInt(next(), 10);
        else if (a === "--only")
            o.only = new Set(readFileSync(next(), "utf8").split("\n").map((l) => l.trim()).filter((l) => l !== ""));
        else if (a === "--probe-program") o.probeProgram = true;
        else if (a === "--sequence") o.sequences.push(sequenceEntries(next()));
        else if (a === "--keep") o.keep = true;
        else throw new Error(`unknown option ${a}\n${USAGE}`);
    }
    if (!o.out || (o.keep && o.sequences.length === 0))
        throw new Error(USAGE);
    return o;
}

/**
 * The entries of one `--sequence` list. Throws when the list names a path both bare and as `<path>=<file>`: the
 * bare entry's fresh reference and its in-process call would compile whatever text the last install left, which
 * differs between the two (the fresh runs go once per distinct entry, the child in list order).
 */
function sequenceEntries(list: string): string[] {
    const entries = list.split(",").filter((e) => e !== "");
    const installed = new Set(entries.filter((e) => e.includes("=")).map((e) => e.slice(0, e.indexOf("="))));
    const bare = entries.find((e) => !e.includes("=") && installed.has(e));
    if (bare !== undefined)
        throw new Error(`--sequence: \`${bare}\` is both a bare entry and the target of \`${bare}=<file>\``);
    return entries;
}

/** The one-file program of `--probe-program`. */
const PROGRAM = `import std.stdio;
import std.algorithm;
import std.range;

void main()
{
    iota(1, 11).filter!(x => x % 2).map!(x => x * x).each!writeln;
    [3, 1, 2].sort.writeln;
    writeln(zip(iota(3), "abc").array);
}
`;

/**
 * One in-process `djsMain` call of the `--sequence` child: its merged output, `.cg`, time, and memory after it
 * (after a full GC: `heapUsedBytes` is what the frontend's globals keep alive between calls).
 */
interface InProcessCall {
    args: string[];
    code: number;
    text: string;
    cg: string | null;
    ms: number;
    rssBytes: number;
    heapUsedBytes: number;
    keep?: { mode: string; reason: string };   // `--keep`
}

/** One call of a `--sequence` child: the arguments, and the file to copy over the source before the call. */
interface SequenceCall {
    args: string[];
    install: { from: string; to: string } | null;
}

/**
 * The `--sequence-child <djs.js> <spec.json>` mode: imports the emitted shim once and calls `djsMain` (the spec's
 * `keep`: `djsMainKept`) for each call of the spec, in order, in this process; writes one InProcessCall per call to the
 * spec's `out`. Before a call, its `install` file (if any) is copied over the source. stdout and stderr are captured by
 * replacing their `write` (the shim writes through nothing else), and `process.argv[1]` is the shim's path, as in a
 * shim process (src/djs.ts reads it as ldc2's executable path, main.cpp:270). Each call's `.cg` (the last argument's)
 * is read and removed, so the next call starts without it.
 */
async function sequenceChild(djsPath: string, specFile: string): Promise<void> {
    const spec = JSON.parse(readFileSync(specFile, "utf8")) as { calls: SequenceCall[]; out: string; keep: boolean };
    const { djsMain, djsMainKept } = await import(pathToFileURL(djsPath).href) as {
        djsMain: (a: readonly string[]) => number;
        djsMainKept: (a: readonly string[]) => { status: number; mode: string; reason: string };
    };
    process.argv[1] = djsPath;
    const decoder = new TextDecoder();
    const calls: InProcessCall[] = [];
    for (const { args, install } of spec.calls) {
        if (install)
            copyFileSync(install.from, install.to);
        const chunks: string[] = [];
        const tap = (c: string | Uint8Array): boolean => {
            chunks.push(typeof c === "string" ? c : decoder.decode(c));
            return true;
        };
        const ow = process.stdout.write;
        const ew = process.stderr.write;
        process.stdout.write = tap as typeof process.stdout.write;
        process.stderr.write = tap as typeof process.stderr.write;
        const t0 = performance.now();
        let code: number;
        let keep: { mode: string; reason: string } | undefined;
        try {
            if (spec.keep) {
                const r = djsMainKept([SHIM_LDC, ...args]);
                code = r.status;
                keep = { mode: r.mode, reason: r.reason };
            } else
                code = djsMain([SHIM_LDC, ...args]);
        } finally {
            process.stdout.write = ow;
            process.stderr.write = ew;
        }
        const ms = performance.now() - t0;
        const cgFile = `${args.at(-1)!}.cg`;
        const cg = existsSync(cgFile) ? readFileSync(cgFile, "utf8") : null;
        rmSync(cgFile, { force: true });
        (globalThis as { gc?: () => void }).gc?.();   // with --expose-gc, heapUsed is what the call left reachable
        const mem = process.memoryUsage();
        calls.push({ args, code, text: chunks.join(""), cg, ms, rssBytes: mem.rss, heapUsedBytes: mem.heapUsed,
            ...(keep ? { keep } : {}) });
    }
    writeFileSync(spec.out, JSON.stringify(calls));
}

async function main(): Promise<void> {
    const o = parseOptions(process.argv.slice(2));
    const work = realpathSync(mkdtempSync(join(tmpdir(), "djs-phobos-")));
    try {
        const emitDir = join(work, "emit");   // the name the corpus crash signature strips (`/emit/`)
        const root = join(work, "import");
        const captureDir = join(work, "capture");
        mkdirSync(emitDir);
        mkdirSync(captureDir);
        cpSync(IMPORT_ROOT, root, { recursive: true });
        const tree = treeState();
        const djs = await emitTree(emitDir);
        const node = process.execPath;
        const shimArgv = (args: string[]): string[] => [node, `--stack-size=${STACK_KB}`, djs, SHIM_LDC, ...args];
        const timeoutMs = o.timeoutS * 1000;
        const normShim = (t: string): string => normalize(t, djs, root);
        const normOracle = (t: string): string => normalize(t, `${LDC_ROOT}/bin/ldc2`, root);
        const normCg = (t: string | null): string | null => t === null ? null : normalizeCg(t, root);

        /**
         * Runs the shim then the oracle on `args` (whose last element is the source, relative to the copy) and
         * classifies the pair; with `vcg`, moves each compiler's `.cg` aside and compares them.
         */
        const compare = async (dir: string, file: string, args: string[], vcg: boolean, slot: number)
            : Promise<PhobosResult> => {
            const capture = join(captureDir, `${slot}.txt`);
            const cgFile = join(root, `${file}.cg`);
            const takeCg = (side: string): string | null => {
                if (!vcg || !existsSync(cgFile))
                    return null;
                const kept = join(captureDir, `${slot}.${side}.cg`);
                renameSync(cgFile, kept);
                const text = readFileSync(kept, "utf8");
                rmSync(kept);
                return text;
            };
            const t0 = Date.now();
            const shim = await runTimed(shimArgv(args), root, timeoutMs, capture);
            const shimCg = takeCg("shim");
            const refused = shim.code === 2 && /^djs: unsupported flag/m.test(shim.text);
            const oracle = shim.timedOut || refused ? null
                : await runTimed([ORACLE, ...args], root, timeoutMs, capture);
            const oracleCg = takeCg("oracle");
            const verdict = classify(shim, oracle, normShim(shim.text), oracle ? normOracle(oracle.text) : "");
            const cg = vcg && oracle ? compareCg(normCg(shimCg), normCg(oracleCg)) : undefined;
            return {
                dir, file, ...(cg ? withCg(verdict, cg) : verdict), cg,
                exit: { shim: shim.code, oracle: oracle?.code ?? null }, args,
                cost: { shim: shim.cost, oracle: oracle?.cost ?? null }, ms: Date.now() - t0,
            };
        };

        const files = enumerate(root);
        const jobs = sampleOf(files, o.sample).filter((f) => o.only === null || o.only.has(f));
        const moduleArgs = (file: string, vcg = true): string[] => ["-c", "-o-", ...(vcg ? ["-vcg-ast"] : []),
            ...(o.unittest ? ["-unittest"] : []), ...o.flags, file];
        const measure = async (i: number): Promise<PhobosResult> => {
            const file = jobs[i]!;
            const dir = file.includes("/") ? file.slice(0, file.indexOf("/")) : "(root)";
            const skip = skipOf(file);
            if (skip !== null)
                return { dir, file, ...skip };
            const noVcg = o.unittest ? NO_VCG_UNITTEST.get(file) : undefined;
            if (noVcg !== undefined)
                return { ...await compare(dir, file, moduleArgs(file, false), false, i), noVcg };
            return compare(dir, file, moduleArgs(file), true, i);
        };

        const results: PhobosResult[] = new Array(jobs.length);
        let next = 0;
        let doneCount = 0;
        const lane = async (): Promise<void> => {
            for (let i = next++; i < jobs.length; i = next++) {
                results[i] = await measure(i);
                if (++doneCount % 25 === 0)
                    process.stderr.write(`${doneCount}/${jobs.length}\n`);
            }
        };
        await Promise.all(Array.from({ length: Math.max(1, o.jobs) }, lane));
        // the cap is wall time: a TIMEOUT stands only if the module also exceeds it running alone
        for (let i = 0; i < results.length; i++) {
            if (results[i]!.status === "TIMEOUT")
                results[i] = await measure(i);
        }

        let program: PhobosResult | null = null;
        if (o.probeProgram) {
            writeFileSync(join(root, "prog.d"), PROGRAM);
            program = await compare("(program)", "prog.d", ["-c", "-o-", "prog.d"], false, jobs.length);
        }

        const sequences = [];
        for (const [k, entries] of o.sequences.entries())
            sequences.push(await probeSequence(k, entries, (f) => moduleArgs(f, !o.keep), o.keep, root, captureDir,
                djs, timeoutMs, shimArgv, normShim, normCg));

        let summary = `HEAD ${tree.head}${tree.dirty.length ? ` (+${tree.dirty.length} dirty paths)` : ""}; `
            + `${o.unittest ? "-unittest; " : ""}${o.flags.length ? `flags ${o.flags.join(" ")}; ` : ""}`
            + `sample ${o.sample || "all"}; jobs ${o.jobs}\n\n`
            + summarize(results) + "\n" + skipNotes(results) + "\n" + cgSummary(results) + "\n"
            + timingSummary(results);
        if (program)
            summary += "\n" + programSummary(program);
        for (const q of sequences)
            summary += "\n" + q.summary;
        writeFileSync(o.out, JSON.stringify({
            oracle: ORACLE, importRoot: IMPORT_ROOT, head: tree.head, dirty: tree.dirty, unittest: o.unittest,
            flags: o.flags,
            sample: o.sample, only: o.only === null ? null : o.only.size, jobs: o.jobs, timeoutS: o.timeoutS,
            date: new Date().toISOString(), results, program, sequences: sequences.map((q) => q.record),
        }, null, 1) + "\n");
        writeFileSync(o.out.replace(/\.json$/, "") + ".summary.txt", summary);
        process.stdout.write(summary);
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

/** The program probe's lines of the summary. */
function programSummary(r: PhobosResult): string {
    const c = (x: Cost | null | undefined): string =>
        x ? `${x.wallS.toFixed(2)} s, ${(x.rssBytes / 2 ** 20).toFixed(0)} MiB peak RSS` : "no cost recorded";
    return `Program probe (std.stdio + std.algorithm + std.range, -c -o-): ${r.status}`
        + `${r.signature ? ` (${r.signature})` : ""}${r.diff ? ` at line ${r.diff.line}` : ""}\n`
        + `  djs    ${c(r.cost?.shim)}\n  ldmd2  ${c(r.cost?.oracle)}\n`;
}

/**
 * The edit-loop line of a `--sequence` summary: the first call (cold: the shim's code is not yet compiled by V8) and
 * the median and p90 of the calls after it, which is what an editor recompiling on every edit waits. Both are
 * nearest-rank (`quantile`): with fewer than 10 calls after the first, the p90 is the slowest of them.
 */
export function editLoopLine(ms: readonly number[]): string {
    const warm = ms.slice(1);
    return `cold call 1: ${Math.round(ms[0]!)} ms; calls 2-${ms.length}: median ${Math.round(quantile(warm, 0.5))} ms, `
        + `p90 ${Math.round(quantile(warm, 0.9))} ms`;
}

/**
 * The `--sequence` probe, list number `k`: a fresh shim process per distinct entry (the reference), then one child
 * process calling `djsMain` (`djsMainKept` with `keep`) for every entry in order; every in-process call is compared
 * with the fresh run of its entry. An entry `<path>=<file>` copies `<file>` to `<path>` in the copy before each of its
 * runs; once the child has run, every such path gets back the copy's text (or is removed, when the copy had none), so
 * the next list starts from the copy.
 */
async function probeSequence(k: number, entries: string[], moduleArgs: (f: string) => string[], keep: boolean,
    root: string, captureDir: string, djs: string, timeoutMs: number, shimArgv: (a: string[]) => string[],
    norm: (t: string) => string, normCg: (t: string | null) => string | null)
    : Promise<{ record: object; summary: string }> {
    const callOf = (entry: string): SequenceCall => {
        const eq = entry.indexOf("=");
        const path = eq < 0 ? entry : entry.slice(0, eq);
        return { args: moduleArgs(path), install: eq < 0 ? null : { from: resolve(entry.slice(eq + 1)),
            to: join(root, path) } };
    };
    const originals = new Map<string, Buffer | null>();
    for (const c of entries.map(callOf)) {
        if (c.install && !originals.has(c.install.to))
            originals.set(c.install.to, existsSync(c.install.to) ? readFileSync(c.install.to) : null);
    }
    const fresh = new Map<string, { code: number | null; text: string; cg: string | null; cost: Cost | null }>();
    for (const e of new Set(entries)) {
        const c = callOf(e);
        if (c.install)
            copyFileSync(c.install.from, c.install.to);
        const r = await runTimed(shimArgv(c.args), root, timeoutMs, join(captureDir, "sequence-fresh.txt"));
        const cgFile = join(root, `${c.args.at(-1)!}.cg`);
        const cg = existsSync(cgFile) ? readFileSync(cgFile, "utf8") : null;
        rmSync(cgFile, { force: true });
        fresh.set(e, { code: r.code, text: norm(r.text), cg: normCg(cg), cost: r.cost });
    }
    const lines = [`In-process sequence probe ${k} (${entries.length} calls)`];
    for (const [e, f] of fresh) {
        lines.push(`  fresh ${e.replace(/=.*\//, "=")}: exit ${f.code}, ${f.cost ? `${f.cost.wallS.toFixed(2)} s wall, `
            + `${(f.cost.rssBytes / 2 ** 20).toFixed(0)} MiB` : "no cost"}`);
    }
    const spec = join(captureDir, `sequence-${k}.json`);
    const out = join(captureDir, `sequence-${k}.out.json`);
    // the call's own args are relative to the copy: the child runs from `root`, as the fresh runs do
    writeFileSync(spec, JSON.stringify({ calls: entries.map(callOf), out, keep }));
    const self = realpathSync(process.argv[1]!);
    const child = await runTimed(
        [process.execPath, `--stack-size=${STACK_KB}`, "--expose-gc", self, "--sequence-child", djs, spec],
        root, timeoutMs * entries.length, join(captureDir, `sequence-${k}.txt`));
    for (const [path, text] of originals) {
        if (text === null)
            rmSync(path, { force: true });
        else
            writeFileSync(path, text);
    }
    if (!existsSync(out)) {
        lines.push(`  the child wrote no result (exit ${child.code}): `
            + child.text.split("\n").slice(0, 3).join(" | "));
        return { record: { entries, fresh: Object.fromEntries(fresh), failed: child.text }, summary:
            lines.join("\n") + "\n" };
    }
    const calls = JSON.parse(readFileSync(out, "utf8")) as InProcessCall[];
    const compared = calls.map((c, i) => {
        const f = fresh.get(entries[i]!)!;
        return {
            entry: entries[i], code: c.code, ms: Math.round(c.ms), rssBytes: c.rssBytes, keep: c.keep,
            heapUsedBytes: c.heapUsedBytes, sameExit: c.code === f.code,
            textDiff: firstDifference(norm(c.text), f.text),
            cg: compareCg(normCg(c.cg), f.cg, { shim: "the in-process call", oracle: "the fresh process" }),
        };
    });
    lines.push(`  one process: ${child.cost ? `${child.cost.wallS.toFixed(2)} s wall, `
        + `${(child.cost.rssBytes / 2 ** 20).toFixed(0)} MiB peak` : "no cost"}`);
    lines.push(`  ${"call".padStart(4)}  ${"entry".padEnd(28)} ${"exit".padStart(4)}  ${"fresh-equal".padEnd(11)} `
        + `${"ms".padStart(6)} ${"RSS MiB".padStart(7)} ${"heap MiB".padStart(8)}  `
        + `${keep ? "mode (why fresh)  " : ""}first difference`);
    for (const [i, c] of compared.entries()) {
        const equal = c.sameExit && c.textDiff === null && c.cg.status !== "differ";
        const diff = equal ? "" : !c.sameExit ? `exit ${c.code} vs ${fresh.get(c.entry!)!.code}`
            : c.textDiff ? `text line ${c.textDiff.line}: ${JSON.stringify(c.textDiff.shim)} vs `
                + `${JSON.stringify(c.textDiff.oracle)}`
            : `.cg line ${c.cg.diff!.line}: ${JSON.stringify(c.cg.diff!.shim)} vs ${JSON.stringify(c.cg.diff!.oracle)}`;
        lines.push(`  ${String(i + 1).padStart(4)}  ${c.entry!.replace(/=.*\//, "=").padEnd(28)} `
            + `${String(c.code).padStart(4)}  ${(equal ? "yes" : "NO").padEnd(11)} ${String(c.ms).padStart(6)} `
            + `${(c.rssBytes / 2 ** 20).toFixed(0).padStart(7)} ${(c.heapUsedBytes / 2 ** 20).toFixed(1).padStart(8)}  `
            + `${c.keep ? `${c.keep.mode}${c.keep.reason ? ` (${c.keep.reason})` : ""}  ` : ""}${diff}`);
    }
    if (compared.length >= 2)
        lines.push(`  ${editLoopLine(compared.map((c) => c.ms))}`);
    return { record: { entries, fresh: Object.fromEntries(fresh), childCost: child.cost, calls: compared }, summary:
        lines.join("\n") + "\n" };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    if (process.argv[2] === "--sequence-child")
        await sequenceChild(process.argv[3]!, process.argv[4]!);
    else
        await main();
}
