// The dmd-corpus runner: measures the djs shim against ldc2 1.43.0 on the FULL dmd test corpus.
//
// Hand-written djs tool, NOT a port. For every `.d`, `.c` and `.i` test in
// ~/Projects/Public/ldc-1.43.0/tests/dmd/{compilable,fail_compilation,runnable}, it reads the test's header as
// tests/dmd/tools/d_do_test.d does, builds the compile command d_do_test would build (d_do_test.d:1900), runs it
// once through the oracle and once through the shim, and classifies the pair. It does NOT check TEST_OUTPUT: the
// reference is the oracle's own output for the same command, so a test the oracle fails on this host is still a
// valid comparison.
//
// THE ORACLE IS ldmd2, not ldc2. The corpus headers spell switches the DMD way (`-version=`, `-debug`,
// `-verrors=spec`, `-check=`); ldc2 rejects those spellings, and LDC's own test runs pass the corpus through
// ldmd2 (`DMD=ldmd2`), which translates them and then execs ldc2 (driver/ldmd.cpp). The shim accepts the same
// DMD spellings (src/djs.ts).
//
// THE COMMAND, per d_do_test.d:1900 `<dmd> -conf= -m64 -I<input_dir> <REQUIRED_ARGS> <permuted> -od<out>
// -of<obj> <argSet> -c <sources> <compiled imports>`, with these stated departures:
//   - no `-conf=`: d_do_test pairs it with a DFLAGS that points at druntime; here both compilers read
//     ldc2.conf's import directory instead (the shim plays that file);
//   - the environment's REQUIRED_ARGS (d_do_test.d:685) is empty. LDC's CMake passes `-g
//     -link-defaultlib-debug` to every directory and `-O -linkonce-templates` to a second runnable pass
//     (tests/dmd/CMakeLists.txt:63-64); neither changes a frontend diagnostic, and the shim refuses the
//     link-only `-link-defaultlib-debug`;
//   - PERMUTE_ARGS: only the no-permutation run (the first combination d_do_test runs); ARG_SETS: the first set;
//   - `-o-` is added for every directory and `-of` dropped: there is no codegen, so a runnable test is
//     compiled only, and no object file is written into the output directory. `-c` is passed for RUN and LINK:
//     tests too, which d_do_test compiles without it (:1904). A fail_compilation test whose expected failure
//     is in codegen or linking therefore passes on the oracle; the summary counts those apart;
//   - COMPILE_SEPARATELY tests are skipped (skip-separately), not compiled one file at a time;
//   - COMPILED_IMPORTS: only the run that names them on the command line (d_do_test also runs one with `-i`);
//   - TEST_OUTPUT, OUTPUT_FILES, TEST_OUTPUT_FILE and POST_SCRIPT are not checked: the reference is the
//     oracle's output, and the files each compiler writes are compared with each other (OUTPUT FILES below);
//   - `${RESULTS_DIR}` is one directory per test per compiler instead of one per run (THE TREE below).
// EXTRA_FILES is documentation only; d_do_test ignores it (tests/dmd/README.md), and so does this runner.
// fail_compilation gets d_do_test's `-verrors=simple -verrors=0` prefix (d_do_test.d:738), and a `.c` or `.i` test
// its LDC `-defaultlib=` suffix (d_do_test.d:741-751). ImportC tests are otherwise planned as `.d` tests are: d_do_test
// reads the same header from them and builds the same command; both compilers run the system C preprocessor
// (`cc`, driver/cpreprocessor.cpp) into their own temporary directory.
//
// THE TREE. Nothing is written into the LDC clone. Once per run, the git-tracked files of its tests/dmd
// (`git ls-files`, read-only; an untracked file there is not copied) are copied under the OS temp directory,
// and the copy is deleted with the rest of the run's directory. Each compiler runs each test from its own
// working directory: a fresh directory holding one symlink per top-level entry of the copy, so the relative
// test paths are the ones d_do_test passes and diagnostics print alike, while a file a compiler writes into
// its working directory (a Ddoc module's `.html` without `-Dd`, compilable/test9369.d; a relative `-Dd`,
// compilable/b17651.d) lands in that directory alone. Each compiler also gets its own `${RESULTS_DIR}`
// (holding the `-od` directory), so concurrent tests and the two compilers never share an output path. Both
// directories are removed after the test. A file written next to a source goes through a symlink into the
// shared copy: `-vcg-ast`'s `<source>.cg` (main.d:857) is taken out of it after each compiler's run; any
// other such write stays in the copy until the run ends, and is not compared.
//
// OUTPUT FILES. After each compiler's run, every file under its `${RESULTS_DIR}` and every file it created in
// its working directory are read (as bytes, latin1) and named `{RESULTS_DIR}/<path>` / `{TESTS}/<path>`; the
// two sets are compared file by file after these normalizations, and nothing else:
//   - in every file, the compiler's own `${RESULTS_DIR}` path becomes `{RESULTS_DIR}`: the runner made two
//     directories where d_do_test has one;
//   - in a `.html` file (Ddoc's output, `doc_ext`, globals.d:366), exactly what
//     compilable/extra-files/ddocAny-postscript.sh removes before its diff: every line containing
//     `Generated by Ddoc from` (`grep -v`), and a CR ending a line (`diff --strip-trailing-cr`). No line is
//     time-dependent between the two runs: `$(DATETIME)` (doc.d:92) occurs in no corpus test and not in the
//     default theme, and `$(YEAR)` (doc.d:93, compilable/ddocYear.d) differs only across a new year;
//   - in any other file (JSON's, json.d), the values of the buildInfo fields that describe the process and
//     not the compilation, as tests/dmd/tools/sanitize_json.d:148-149 removes them: `"cwd"` (json.d:904, the
//     working directory, one per compiler here) and `"argv0"` (json.d:905, ldc2's path vs the shim's). The
//     third such field, `"config"` (json.d:906), is compared: the shim plays ldc2's own ldc2.conf and prints
//     its path. A JSON written to stdout (`-Xf-`) is compared with the rest of the output (`normalize`).
//
// CAPTURE. Each compiler writes stdout and stderr to ONE file opened for both (`>f 2>&1`). A pipe would not
// keep the write order for the shim: Node writes to a pipe asynchronously on macOS, and once the pipe buffer
// is full a later stderr write overtakes queued stdout data, even inside a line. File writes are synchronous in
// Node, and the shared file offset keeps the order exact for both compilers.
//
// CLASSES. MATCH: same exit status and byte-identical stdout+stderr (merged in write order, as d_do_test's
// `2>&1` captures them) after normalizing: absolute paths, the compiler's name where it starts a line
// (`ldc2: ...`), and ldc2's `-v` line `GC stats ...` (main.d:908), whose numbers describe ldc2's own heap and
// which the shim does not print; the per-test working directory and the copy of the corpus are spelled
// `{TESTS}`. MISMATCH-OUTPUT: same exit status, different text. MISMATCH-EXIT: different
// exit status. CRASH: the shim printed `Internal error:` (an escaped AssertError, a wall, a TypeError), died of
// an uncaught error before or outside `djsMain` (Node's own `Node.js v<N>` trailer), was killed by a signal, or
// exited with a status ldmd2 never uses (not 0, 1 or 2); the signature is the error's first line, followed by
// its first stack frame outside assert.js when that line carries no `.d:<line>` anchor. MATCH-LOWMEM: a test in
// LOWMEM_TESTS that mismatches ldmd2 and matches `ldmd2 -lowmem` (a declared divergence). MISMATCH-CG: a MATCH
// under `-vcg-ast` whose `.cg` files differ, a file written by one compiler only included; the first differing
// line is the `diff` (`<no .cg>` for the missing side). MISMATCH-FILE: a MATCH (and no MISMATCH-CG) whose
// written files differ (OUTPUT FILES above), a file written by one compiler only included; `written` names
// the first differing file and `diff` its first differing line (`<no file>` for the missing side); the summary
// buckets it by the file's extension (`.html` is Ddoc's, `.json` JSON's). UNSUPPORTED-FLAG: the
// shim refused a switch (`djs: unsupported flag`, exit 2); the oracle is not run. TIMEOUT: the shim exceeded
// the per-file wall-clock cap twice, once in the pool and once more alone after the pool drained (the cap is
// wall time, so a loaded pool alone must not decide it). SKIP-*: skip-cpp (EXTRA_CPP_SOURCES), skip-objc
// (EXTRA_OBJC_SOURCES), skip-disabled (DISABLED matches osx64 or an LDC rule), skip-separately
// (COMPILE_SEPARATELY), skip-header (a header d_do_test itself rejects).
//
// PROVENANCE. The runner refuses to measure a tree that does not type-check, and records the git HEAD and the
// `git status --porcelain` of the repository with the results. Recorded arguments spell the results directory
// `${RESULTS_DIR}`, as the headers do, so records compare across runs.
//
// IN-PROCESS MODE. `--in-process` runs the shim the way an editor host would: each lane keeps ONE Node child process
// that imports the emitted shim once and calls `djsMain` for every test of the lane, in turn, from the test's working
// directory (`process.chdir`), its stdout and stderr captured by replacing their `write`, and the arguments,
// `process.argv[1]` (the shim's path, main.cpp:270) and every compared file exactly as a shim process gets them. The
// oracle and the classification are unchanged, so a test whose class differs from the fresh-process measurement is a
// compile that a previous compile in the same process changed. A timeout or a dead child is replaced by a new child for
// the next test. With `--keep` the child calls `djsMainKept` (src/djs.ts, the kept-module engine, 10 §4.7) instead: a
// test whose command line equals the lane's previous one, the root files excepted, replays what that compile kept
// (object.d, druntime, the imports/ modules), and the lanes take the tests grouped by their switches so that most
// compiles have such a predecessor; each record says whether the compile was kept and, when fresh, why, and the
// summary counts them. The taps write synchronously to the child's fd 1, a per-lane file that is also its fd 2, so
// output written past them (the C preprocessor's own stdout and stderr, inherited by `cc`) lands in it in write order,
// as CAPTURE keeps it for a shim process; the file is the test's text. `--recompile` (with `--keep`) then compiles each
// test a second time in the same child, from the same directory and on unchanged files, which an editor's re-save of
// an unchanged file does: the engine replays the first compile, and the second compile's exit status and text must be
// the first's, byte for byte (the record's `recompile`; the summary lists every test where they differ).
// `--editor` makes the child call as djs-vscode's worker does: a fatal handler answering true (editor mode, 10 §4.7)
// and the doc-comment knob on. Past a test's first fatal point the output has no oracle (the CLI's is a prefix of
// it), so such a test is a MISMATCH by construction there; the switch is for `--recompile`, whose comparison is
// between the child's own two compiles.
//
// TARGET MODE. `--mtriple <t>` measures a cross target (10 §4.8): both compilers get `-mtriple=<t>` where d_do_test
// puts `-m64` (ldc2 refuses the two together), and the headers are read as d_do_test reads them natively on that
// target (`TargetEnv`: OS=linux; `LDC_not_x86` tests kept on x86_64). The summary and the JSON record the triple.
//
// USAGE (Node >= 22.18 runs this file directly, type stripping on):
//   node tests/corpus/run.ts --out <results.json> [--sample N] [--jobs 8] [--timeout 30] [--dirs a,b] [--only <list>]
//       [--in-process [--editor] [--keep [--recompile]]] [--mtriple <triple>]
// `--only` reads a file of `<dir>/<file>` lines (e.g. `compilable/test1.d`) and measures only those tests: the
// burn-down re-runs one failure bucket this way instead of the whole corpus.
// It emits src/ with the repo's tsconfig into a temporary directory, runs, writes <results.json> (per-test
// records) and <results>.summary.txt, prints the summary, and removes the temporary directory. The results
// file is a measurement, not a fixture: nothing here commits it.

import { execFileSync, spawn } from "node:child_process";
import {
    closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
    realpathSync, rmSync, symlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The LDC clone the corpus comes from: read-only, git included (THE TREE in the file header). */
// ORACLE CONSTANT: a checkout of LDC v1.43.0's sources (tests/dmd); set it to yours to run the oracle tests.
export const CLONE = "/Users/pinver/Projects/Public/ldc-1.43.0";
/** The corpus root in the clone: the directory holding compilable/, fail_compilation/, runnable/. */
export const TESTS = `${CLONE}/tests/dmd`;
/** The oracle install. */
// ORACLE CONSTANT: an LDC 1.43.0 install (what --djs-ldc names); set it to yours to run the oracle tests.
export const LDC_ROOT = "/Users/pinver/Projects/Prefix/tools/mac_a64/ldc2-1.43.0";
export const ORACLE = `${LDC_ROOT}/bin/ldmd2`;
/**
 * First on every shim command line: the emit lies outside the repository, away from the bundled import tree, and the
 * comparison wants the oracle's import tree and ldc2.conf, spelled as ldc2 spells them.
 */
export const SHIM_LDC = `--djs-ldc=${LDC_ROOT}`;
export const DIRS = ["compilable", "fail_compilation", "runnable"] as const;

/**
 * V8's stack limit for the shim, in KiB. ldc2 recurses on the main thread's 8 MiB stack (`ulimit -s` 8176 KiB
 * here), and the corpus probes that depth (fail_compilation/fail280.d: 500 nested template instances), which
 * overflows Node's default ~1 MiB. The limit must stay below the OS stack, or V8 overruns it and the process
 * dies by signal instead of `RangeError`: 7600 leaves ~570 KiB for native frames.
 */
export const STACK_KB = 7600;

/**
 * Declared divergence (10 §4.5, 08 §13): the port models CTFE with the GC on, as `ldc2 -lowmem` runs it; ldc2's
 * default build runs with the GC off (driver/main.cpp:1129), so CTFE literals live in a region and copyRegionExp
 * copies them out (dinterpret.d:6712), which is visible in these tests. A listed test that mismatches the default
 * oracle is compared again against `ldmd2 -lowmem`, and a match there is MATCH-LOWMEM.
 */
const LOWMEM_TESTS: ReadonlySet<string> = new Set(["runnable/xtest46.d"]);

/**
 * d_do_test's EnvData (d_do_test.d:175-187, SEP=/) and the target facts its header checks read, with the
 * `-mtriple` both compilers get. The host run is OS=osx MODEL=64 on a non-x86 d_do_test; a `--mtriple` run is
 * the native run of that target: OS=linux, and `isX86` (getDisabledReason's `version (X86_64)`, d_do_test.d:624)
 * true on x86_64, which keeps the `DISABLED: LDC_not_x86` tests.
 */
export interface TargetEnv {
    os: string;
    model: string;
    isX86: boolean;
    mtriple: string | null;
}

export const HOST_ENV: TargetEnv = { os: "osx", model: "64", isX86: false, mtriple: null };

/** The TargetEnv of `--mtriple <t>`. */
export function tripleEnv(mtriple: string): TargetEnv {
    return { os: "linux", model: "64", isX86: mtriple.startsWith("x86_64-"), mtriple };
}

// ── header parsing: d_do_test.d:496 consumeNextToken, :263 findTestParameter ─────────────────────────────

/** Thrown where d_do_test throws `SilentQuit` on a malformed directive (d_do_test.d:544). */
export class HeaderError extends Error {}

/**
 * Advances past the next real occurrence of `token` in `file` whose optional `(<envs>)` list matches this
 * host and which is followed by `:`; returns the remaining text after the colon, or null (d_do_test.d:496).
 */
function consumeNextToken(file: string, token: string, env: TargetEnv): string | null {
    for (;;) {
        const istart = file.indexOf(token);
        if (istart === -1)
            return null;
        // Examine the preceeding character to avoid false matches
        const ch = istart ? file[istart - 1]! : " ";
        file = file.slice(istart + token.length).replace(/^ +/, "");   // Don't read line breaks

        // Assume that real test token are preceeded by spaces or comment-related tokens
        if (!/\s/.test(ch) && !"/*+".includes(ch))
            continue;

        // filter by OS specific setting (os1 os2 ...)
        if (file.startsWith("(")) {
            const close = file.indexOf(")");
            if (close >= 0) {
                const oss = file.slice(1, close).split(" ");
                file = file.slice(close + 1).replace(/^ +/, "");
                // an OS (e.g. "linux") or OS + MODEL (e.g. "windows32")
                if (!oss.some((o) => o.startsWith(env.os) && (o.length === env.os.length
                    || o.slice(env.os.length) === env.model)))
                    continue; // Parameter was skipped
            }
        }

        // Skip a trailing colon
        if (file.startsWith(":"))
            return file.slice(1).replace(/^ +/, "");
        throw new HeaderError(`Test directive \`${token}\` must be followed by a \`:\``);
    }
}

/**
 * d_do_test's `unifyDirSep` for SEP=/ (d_do_test.d:1100), simplified: in every space-delimited word that ends
 * in a source-file extension, backslashes become slashes.
 */
function unifyDirSep(s: string): string {
    return s.replace(/\S+/g, (w) => (/\.(d|di|mixin|c|i|h)\b/.test(w) ? w.replace(/\\/g, "/") : w));
}

/**
 * Every definition of the single-line parameter `token`, joined by `delim`; null when absent
 * (d_do_test.d:263, including its `//` comment trimming).
 */
export function findTestParameter(file: string, token: string, delim = " ", env: TargetEnv = HOST_ENV): string | null {
    const rest = consumeNextToken(file, token, env);
    if (rest === null)
        return null;
    const m = /\r|\n/.exec(rest);
    const lineEnd = m ? m.index : rest.length;
    let result = rest.slice(0, lineEnd);
    const commentStart = result.indexOf("//");
    if (commentStart !== -1)
        result = result.slice(0, commentStart);
    result = result.trim();

    const result2 = findTestParameter(rest.slice(lineEnd), token, delim, env);
    if (result2 !== null && result2.length > 0)
        result = result.length === 0 ? result2 : result + delim + result2;
    return unifyDirSep(result);
}

/** d_do_test.d:611 `getDisabledReason` for `env` (target `osx64` or `linux64`, LDC). */
function disabledReason(platforms: string[], env: TargetEnv): string | null {
    const target = env.os + env.model;
    const i = platforms.find((p) => target.includes(p));
    if (i !== undefined)
        return "on " + i;
    if (platforms.includes("LDC"))
        return "for LDC";
    if (!env.isX86 && platforms.includes("LDC_not_x86"))
        return "for LDC_not_x86";
    const j = platforms.find((p) => p.startsWith("LDC_") && target.includes(p.slice(4)));
    if (j !== undefined)
        return "for LDC on " + j;
    return null;
}

/** One test's compile command, or the reason it is skipped. */
export type Plan =
    | { skip: string; detail?: string }
    | { skip: null; args: string[] };

/**
 * Reads `dir/name`'s header and builds the compile arguments d_do_test would pass (gatherTestParameters,
 * d_do_test.d:677, and the command of :1900 with the departures in the file header). `resultsDir` stands for
 * `${RESULTS_DIR}`; `outDir` is the `-od` directory. Under `env.mtriple` the command carries `-mtriple=<t>`
 * where d_do_test puts `-m64`, which ldc2 refuses beside `-mtriple` (driver/main.cpp:1205).
 */
export function planTest(dir: string, name: string, source: string, resultsDir: string, outDir: string,
                         env: TargetEnv = HOST_ENV): Plan {
    const param = (token: string, delim = " "): string | null => findTestParameter(source, token, delim, env);
    const input = `${dir}/${name}`;
    try {
        const dflags = param("DFLAGS");
        if (dflags !== null && dflags !== "")
            return { skip: "skip-header", detail: "non-empty DFLAGS" };

        let required = (param("REQUIRED_ARGS") ?? "").replaceAll("${RESULTS_DIR}", resultsDir);
        if (dir === "fail_compilation")
            required = "-verrors=simple -verrors=0 " + required;   // d_do_test.d:738
        if (name.endsWith(".c") || name.endsWith(".i"))
            required = required.length ? required + " -defaultlib=" : "-defaultlib=";   // d_do_test.d:741-751

        const argSetsStr = param("ARG_SETS", ";");
        const argSet = argSetsStr === null ? ""
            : (argSetsStr.split(";")[0] ?? "").replaceAll("${RESULTS_DIR}", resultsDir);

        const sources = [input];
        for (const s of (param("EXTRA_SOURCES") ?? "").split(/\s+/).filter((x) => x))
            sources.push(`${dir}/${s}`);
        const compiledImports: string[] = [];
        for (const s of (param("COMPILED_IMPORTS") ?? "").split(/\s+/).filter((x) => x))
            compiledImports.push(`${dir}/${s}`);

        if ((param("EXTRA_CPP_SOURCES") ?? "").trim())
            return { skip: "skip-cpp" };
        if (param("EXTRA_OBJC_SOURCES") !== null)
            return { skip: "skip-objc" };
        if (param("COMPILE_SEPARATELY") !== null)
            return { skip: "skip-separately" };
        const disabled = param("DISABLED");
        if (disabled !== null) {
            const why = disabledReason(disabled.split(/\s+/).filter((x) => x), env);
            if (why !== null)
                return { skip: "skip-disabled", detail: why };
        }

        const target = env.mtriple === null ? "-m64" : `-mtriple=${env.mtriple}`;
        const args = [target, `-I${dir}`, ...required.split(/\s+/), `-od${outDir}`, ...argSet.split(/\s+/), "-c", "-o-",
            ...sources, ...compiledImports].filter((a) => a !== "");
        return { skip: null, args };
    } catch (e) {
        if (e instanceof HeaderError)
            return { skip: "skip-header", detail: e.message };
        throw e;
    }
}

// ── running and comparing ───────────────────────────────────────────────────────────────────────────────

export interface RunOutput {
    code: number | null;   // null: killed by a signal (the timeout's SIGKILL, or a crash)
    signal?: string | null;
    text: string;          // stdout and stderr, merged in write order
    timedOut: boolean;
    keep?: KeepMode;       // `--keep`: how the in-process compile ran
}

/** `--keep`: whether an in-process compile replayed kept modules, and why not when it did not. */
export interface KeepMode {
    mode: string;          // "kept" | "fresh"
    reason: string;        // why fresh ("" when kept)
}

/**
 * Runs `argv` from `cwd` with stdout and stderr both written to `captureFile` (`>f 2>&1`, see CAPTURE in the
 * file header), killing it after `timeoutMs`; returns the captured text and removes the file.
 */
function run(argv: string[], cwd: string, timeoutMs: number, captureFile: string): Promise<RunOutput> {
    return new Promise((done, fail) => {
        const env = { ...process.env };
        delete env["DFLAGS"];   // ldmd2 appends $DFLAGS (ldmd.cpp:translateArgs); the shim has no such input
        const fd = openSync(captureFile, "w+");
        const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ["ignore", fd, fd] });
        closeSync(fd);   // the child holds its own copy
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, timeoutMs);
        child.on("error", (e) => {
            clearTimeout(timer);
            fail(e);
        });
        child.on("close", (code, signal) => {
            clearTimeout(timer);
            const text = readFileSync(captureFile, "utf8");
            rmSync(captureFile, { force: true });
            done({ code, signal, text, timedOut });
        });
    });
}

/**
 * Normalizes a compiler's output for comparison: newlines unified (d_do_test.d:1081), the absolute paths of
 * the corpus (each of `testRoots`: the compiler's working directory and the copy it links to), the results
 * directory, the ldc2 install and the compiler binary replaced by placeholders, the compiler's own name
 * (`ldc2`, `ldmd2`, `djs`) by `{COMPILER}` where it starts a line as a message prefix, and ldc2's `-v` `GC
 * stats` line (main.d:908) removed. Nothing else: a word inside a path or a message is compared as written.
 */
export function normalize(text: string, compilerPath: string, resultsDir: string,
    testRoots: readonly string[] = [TESTS]): string {
    let t = text.replace(/\r\r\n|\r\n|\r/g, "\n");
    t = t.split(compilerPath).join("{COMPILER}");
    t = t.split(resultsDir).join("{RESULTS_DIR}");
    for (const root of testRoots)
        t = t.split(root).join("{TESTS}");
    t = t.split(`${LDC_ROOT}/bin/../import`).join("{LDC_IMPORT}");
    t = t.split(LDC_ROOT).join("{LDC}");
    t = t.replace(/^(ldmd2|ldc2|djs):/gm, "{COMPILER}:");
    t = t.replace(/^GC stats  \d+M used, \d+M free, \d+M total\n/m, "");
    return t;
}

/**
 * The first line where `a` and `b` differ (1-based), with both texts of that line; a side with no line there
 * (an empty output included) reads `<end of output>`.
 */
export function firstDifference(a: string, b: string): { line: number; shim: string; oracle: string } | null {
    if (a === b)
        return null;
    const la = a === "" ? [] : a.split("\n");
    const lb = b === "" ? [] : b.split("\n");
    for (let i = 0; i < Math.max(la.length, lb.length); i++) {
        if (la[i] !== lb[i])
            return { line: i + 1, shim: la[i] ?? "<end of output>", oracle: lb[i] ?? "<end of output>" };
    }
    return null;
}

/**
 * `--recompile`: the test's second compile, on unchanged files in the same child. `same`: its exit status and text
 * are the first compile's; `different`: they are not (`exit`, and `diff`, the first differing line, `first` and
 * `again` for the two compiles); `timeout` / `died`: the second compile exceeded the cap or its child died.
 */
export interface Recompile {
    status: "same" | "different" | "timeout" | "died";
    mode?: string;            // as KeepMode, when the child answered
    reason?: string;
    exit?: { first: number | null; again: number | null };
    diff?: { line: number; first: string; again: string };
}

export interface TestResult {
    dir: string;
    file: string;
    status: string;
    detail?: string;          // skip reason / unsupported flag
    signature?: string;       // CRASH: the `Internal error:` line
    written?: string;         // MISMATCH-FILE: the first differing output file, `{RESULTS_DIR}/…` or `{TESTS}/…`
    diff?: { line: number; shim: string; oracle: string };
    exit?: { shim: number | null; oracle: number | null };
    args?: string[];
    ms?: number;
    keep?: KeepMode;          // `--keep`
    recompile?: Recompile;    // `--recompile`
}

/**
 * The CRASH signature: `first` (the error's first line), followed by ` @ <function> (<file>:<line>)` of the
 * first stack frame after `from` that is not in assert.js, when `first` carries no `.d:<line>` anchor. The
 * frame's file is relative to the emit directory and its line is the emitted `.js` line.
 */
function crashSignature(first: string, text: string, from: number): string {
    first = first.trim();
    if (/\.d:\d+/.test(first))
        return first;
    const frames = text.slice(from).matchAll(/^ +at (?:(\S+) \()?[^\n]*?\/emit\/([^\s:)]+):(\d+):\d+\)?$/gm);
    for (const f of frames) {
        if (f[2] !== "assert.js")
            return `${first} @ ${f[1] ?? "<anonymous>"} (${f[2]}:${f[3]})`;
    }
    return first;
}

/**
 * Takes the `.cg` files `-vcg-ast` wrote next to the root sources of `args` (relative to `root`, the copy of
 * the corpus) out of it: returns their texts joined in argument order, each headed by its source path, or null
 * when none was written (or the switch is absent). The copy is left without them either way.
 */
function takeCg(root: string, args: readonly string[]): string | null {
    if (!args.includes("-vcg-ast"))
        return null;
    const texts: string[] = [];
    for (const a of args.filter((x) => /\.(d|c|i)$/.test(x))) {
        const f = join(root, `${a}.cg`);
        if (existsSync(f)) {
            texts.push(`// ${a}.cg\n${readFileSync(f, "utf8")}`);
            rmSync(f);
        }
    }
    return texts.length ? texts.join("") : null;
}

// ── the tree and the written files (THE TREE, OUTPUT FILES in the file header) ─────────────────────────────

/**
 * Copies the git-tracked files of the clone's tests/dmd into `dest` (created), keeping their relative paths and
 * modes; returns `dest`. Reads the clone only: `git ls-files` and file reads. An untracked file is not copied.
 * Cost: about 5000 files, 25 MB.
 */
export function copyCorpus(dest: string): string {
    const listed = execFileSync("git", ["-C", CLONE, "ls-files", "-z", "tests/dmd"], { encoding: "utf8",
        maxBuffer: 64 << 20 });
    for (const rel of listed.split("\0").filter((l) => l !== "")) {
        const to = join(dest, rel.slice("tests/dmd/".length));
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(join(CLONE, rel), to);
    }
    return dest;
}

/**
 * Creates `at` as a working directory for one compiler run: one symlink per top-level entry of `root` (the copy
 * of the corpus), nothing else. Relative test paths resolve into `root`; a file created in `at` stays there.
 */
export function linkWorkDir(root: string, at: string): void {
    mkdirSync(at, { recursive: true });
    for (const e of readdirSync(root))
        symlinkSync(join(root, e), join(at, e));
}

/**
 * The files one compiler run wrote: every file under `resultsDir`, named `{RESULTS_DIR}/<path>`, and every file
 * under `workDir` that is not reached through one of its symlinks, named `{TESTS}/<path>`; each read as latin1
 * (one char per byte, so the comparison is byte for byte). Symlinks are never followed.
 */
export function writtenFiles(resultsDir: string, workDir: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (dir: string, label: string): void => {
        if (!existsSync(dir))
            return;
        for (const e of readdirSync(dir).sort()) {
            const f = join(dir, e);
            const st = lstatSync(f);
            if (st.isSymbolicLink())
                continue;
            if (st.isDirectory())
                walk(f, `${label}/${e}`);
            else
                out.set(`${label}/${e}`, readFileSync(f, "latin1"));
        }
    };
    walk(resultsDir, "{RESULTS_DIR}");
    walk(workDir, "{TESTS}");
    return out;
}

/**
 * Normalizes one written file named `name` (as `writtenFiles` names it) for comparison, with the normalizations
 * of OUTPUT FILES in the file header and no other: `resultsDir` (the writer's own) becomes `{RESULTS_DIR}`; a
 * `.html` file loses every line containing `Generated by Ddoc from` and every line-ending CR; any other file has
 * the values of its `"cwd"` and `"argv0"` JSON properties replaced.
 */
export function normalizeWritten(name: string, text: string, resultsDir: string): string {
    const t = text.split(resultsDir).join("{RESULTS_DIR}");
    if (name.endsWith(".html"))
        return t.split("\n").filter((l) => !l.includes("Generated by Ddoc from")).map((l) => l.replace(/\r$/, ""))
            .join("\n");
    return t.replace(/^(\s*"(?:cwd|argv0)" : )"(?:[^"\\]|\\.)*"/gm, '$1"{PROCESS}"');
}

/**
 * The first difference between two compilers' normalized written files, in name order: the file and its first
 * differing line, a file written by one side only reading `<no file>` on the other; null when the sets agree.
 */
export function compareWritten(shim: ReadonlyMap<string, string>, oracle: ReadonlyMap<string, string>):
    { written: string; diff: { line: number; shim: string; oracle: string } } | null {
    for (const name of [...new Set([...shim.keys(), ...oracle.keys()])].sort()) {
        const a = shim.get(name);
        const b = oracle.get(name);
        if (a === b)
            continue;
        if (a === undefined || b === undefined)
            return { written: name, diff: { line: 1, shim: a === undefined ? "<no file>" : a.split("\n")[0]!,
                oracle: b === undefined ? "<no file>" : b.split("\n")[0]! } };
        return { written: name, diff: firstDifference(a, b)! };
    }
    return null;
}

/** Classifies one compared pair (see the file header for the classes). */
export function classify(shim: RunOutput, oracle: RunOutput | null, shimText: string,
    oracleText: string): Pick<TestResult, "status" | "detail" | "signature" | "diff"> {
    if (shim.timedOut)
        return { status: "TIMEOUT" };
    const crash = /^Internal error: (.*)$/m.exec(shim.text);
    if (crash)
        return { status: "CRASH", signature: crashSignature(crash[1]!, shim.text, crash.index) };
    if (shim.code === null)
        return { status: "CRASH", signature: `killed by ${shim.signal ?? "a signal"}` };
    // Node's report of an uncaught error: `<Name>Error: <message>` followed by its frames, then the trailer; the
    // last such line, since a diagnostic can also start with `Error:` but is never followed by a frame
    const uncaught = /^Node\.js v\d+\.\d+\.\d+$/m.test(shim.text)
        ? [...shim.text.matchAll(/^(\w*Error\b[^\n]*)\n {4}at /gm)].at(-1) : undefined;
    if (uncaught)
        return { status: "CRASH", signature: crashSignature(`uncaught ${uncaught[1]!}`, shim.text, uncaught.index) };
    if (shim.code !== 0 && shim.code !== 1 && shim.code !== 2)
        return { status: "CRASH", signature: `exit status ${shim.code}` };
    const refused = /^djs: unsupported flag `([^`]*)`/m.exec(shim.text);
    if (shim.code === 2 && refused)
        return { status: "UNSUPPORTED-FLAG", detail: refused[1]! };
    if (oracle === null)
        return { status: "CRASH", signature: "oracle not run" };
    if (shim.code !== oracle.code)
        return { status: "MISMATCH-EXIT", diff: firstDifference(shimText, oracleText) ?? undefined };
    const diff = firstDifference(shimText, oracleText);
    if (diff === null)
        return { status: "MATCH" };
    return { status: "MISMATCH-OUTPUT", diff };
}

// ── the tree emit (as src/dmd/loadorder.test.ts's native leg does) ──────────────────────────────────────

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Emits `src/` with the repo's tsconfig into `outDir` (ESM); returns the path of the emitted djs.js. Throws when
 * the tree does not type-check: tsc would emit it anyway, and the measurement would describe no gated state.
 */
export async function emitTree(outDir: string): Promise<string> {
    const ts = (await import("typescript")).default;
    const srcRoot = join(repoRoot, "src");
    const cfg = ts.getParsedCommandLineOfConfigFile(join(repoRoot, "tsconfig.json"),
        { noEmit: false, outDir, rootDir: srcRoot, sourceMap: false, declaration: false },
        { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(String(d.messageText)); } });
    if (!cfg)
        throw new Error("tsconfig.json did not parse");
    const program = ts.createProgram(cfg.fileNames.filter((f) => !f.endsWith(".test.ts")), cfg.options);
    const diags = ts.getPreEmitDiagnostics(program);
    if (diags.length) {
        throw new Error("src/ does not type-check; nothing measured\n" + ts.formatDiagnostics(diags, {
            getCanonicalFileName: (f) => f, getCurrentDirectory: () => repoRoot, getNewLine: () => "\n",
        }));
    }
    const result = program.emit();
    if (result.emitSkipped)
        throw new Error("tsc emit skipped");
    writeFileSync(join(outDir, "package.json"), '{"type":"module"}\n');
    return join(outDir, "djs.js");
}

/** The repository's HEAD and `git status --porcelain`, recorded with the results (read-only git). */
export function treeState(): { head: string; dirty: string[] } {
    const git = (...a: string[]): string => execFileSync("git", ["-C", repoRoot, ...a], { encoding: "utf8" });
    return { head: git("rev-parse", "HEAD").trim(), dirty: git("status", "--porcelain").split("\n").filter((l) => l) };
}

// ── in-process mode (IN-PROCESS MODE in the file header) ─────────────────────────────────────────────────

/** One call of the in-process child: the shim's arguments and the working directory to run them from. */
interface InProcessRequest {
    args: string[];
    cwd: string;
}

/** The in-process child's calls: `djsMainKept` (`--keep`) or `djsMain`, in editor mode or not (`--editor`). */
interface ChildMode {
    keep: boolean;
    editor: boolean;
}

/**
 * The `--in-process-child <djs.js> [--keep] [--editor]` mode: imports the emitted shim once, then answers every IPC
 * message (an InProcessRequest) with one `djsMain` call (`djsMainKept` under `--keep`; under `--editor` with a fatal
 * handler answering true and the doc-comment knob on, as djs-vscode's worker calls it) from the request's directory,
 * replying `{ code }` (and `keep`) once the call has written its stdout and stderr, through `write`, synchronously to
 * fd 1 (the lane's file, see InProcessShim).
 */
async function inProcessChild(djsPath: string, { keep, editor }: ChildMode): Promise<void> {
    type Options = { docComments?: boolean };
    const { djsMain, djsMainKept } = await import(pathToFileURL(djsPath).href) as {
        djsMain: (a: readonly string[], onFatal?: () => boolean, o?: Options) => number;
        djsMainKept: (a: readonly string[], onFatal?: () => boolean, o?: Options) =>
            { status: number; mode: string; reason: string };
    };
    const onFatal = editor ? (): boolean => true : undefined;
    const options: Options = editor ? { docComments: true } : {};
    process.argv[1] = djsPath;   // the shim reads it as ldc2's executable path (main.cpp:270)
    process.on("message", (m: InProcessRequest) => {
        process.chdir(m.cwd);
        const tap = (c: string | Uint8Array): boolean => {
            writeSync(1, typeof c === "string" ? Buffer.from(c) : c);
            return true;
        };
        const ow = process.stdout.write;
        const ew = process.stderr.write;
        process.stdout.write = tap as typeof process.stdout.write;
        process.stderr.write = tap as typeof process.stderr.write;
        let code: number;
        let mode: KeepMode | undefined;
        try {
            if (keep) {
                const r = djsMainKept([SHIM_LDC, ...m.args], onFatal, options);
                code = r.status;
                mode = { mode: r.mode, reason: r.reason };
            } else
                code = djsMain([SHIM_LDC, ...m.args], onFatal, options);
        } finally {
            process.stdout.write = ow;
            process.stderr.write = ew;
        }
        process.send!({ code, keep: mode });
    });
}

/**
 * One lane's long-lived shim process for `--in-process`: `run` sends one compile and resolves with its output as
 * the fresh-process `run` does. A child that times out is killed, and a dead one is replaced on the next `run`.
 * The child's stdout and stderr are both `captureFile` (opened for append, so truncating it between tests is safe),
 * which the taps and the processes it spawns write in order: its contents are the test's text.
 */
class InProcessShim {
    private child: ReturnType<typeof spawn> | null = null;
    private readonly djs: string;
    private readonly captureFile: string;
    private readonly mode: ChildMode;

    constructor(djs: string, captureFile: string, mode: ChildMode) {
        this.djs = djs;
        this.captureFile = captureFile;
        this.mode = mode;
    }

    run(args: string[], cwd: string, timeoutMs: number): Promise<RunOutput> {
        if (this.child === null) {
            const fd = openSync(this.captureFile, "a");
            this.child = spawn(process.execPath, [`--stack-size=${STACK_KB}`, fileURLToPath(import.meta.url),
                "--in-process-child", this.djs, ...(this.mode.keep ? ["--keep"] : []),
                ...(this.mode.editor ? ["--editor"] : [])],
                { stdio: ["ignore", fd, fd, "ipc"] });
            closeSync(fd);
        }
        const child = this.child;
        return new Promise((done) => {
            const takeCapture = (): string => {
                const t = existsSync(this.captureFile) ? readFileSync(this.captureFile, "utf8") : "";
                writeFileSync(this.captureFile, "");
                return t;
            };
            let timedOut = false;
            const finish = (r: RunOutput): void => {
                clearTimeout(timer);
                child.off("message", onMessage);
                child.off("exit", onExit);
                done(r);
            };
            const onMessage = (m: { code: number; keep?: KeepMode }): void =>
                finish({ code: m.code, signal: null, text: takeCapture(), timedOut: false, keep: m.keep });
            const onExit = (code: number | null, signal: string | null): void => {
                this.child = null;
                finish({ code, signal, text: takeCapture(), timedOut });
            };
            const timer = setTimeout(() => {
                timedOut = true;
                child.kill("SIGKILL");
            }, timeoutMs);
            child.on("message", onMessage);
            child.on("exit", onExit);
            child.send({ args, cwd } satisfies InProcessRequest);
        });
    }

    close(): void {
        this.child?.kill("SIGKILL");
        this.child = null;
    }
}

// ── the driver ───────────────────────────────────────────────────────────────────────────────────────────

interface Options {
    out: string;
    sample: number;     // 0 = every test
    jobs: number;
    timeoutS: number;
    dirs: string[];
    only: Set<string> | null;   // `--only`: the `<dir>/<file>` tests to measure, or null for all
    inProcess: boolean;         // `--in-process` (IN-PROCESS MODE in the file header)
    editor: boolean;            // `--editor`: the in-process child calls in editor mode, as djs-vscode does
    keep: boolean;              // `--keep`: the in-process child calls `djsMainKept`
    recompile: boolean;         // `--recompile`: each test compiled again, unchanged, in the same child
    mtriple: string | null;     // `--mtriple <t>`: `-mtriple=<t>` to both compilers (TargetEnv)
}

function parseOptions(argv: string[]): Options {
    const o: Options = {
        out: "", sample: 0, jobs: 8, timeoutS: 30, dirs: [...DIRS], only: null, inProcess: false, keep: false,
        editor: false, recompile: false, mtriple: null,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        const next = (): string => {
            const v = argv[++i];
            if (v === undefined)
                throw new Error(`${a} needs a value`);
            return v;
        };
        if (a === "--out") o.out = resolve(next());
        else if (a === "--sample") o.sample = Number.parseInt(next(), 10);
        else if (a === "--jobs") o.jobs = Number.parseInt(next(), 10);
        else if (a === "--timeout") o.timeoutS = Number.parseInt(next(), 10);
        else if (a === "--dirs") o.dirs = next().split(",");
        else if (a === "--only")
            o.only = new Set(readFileSync(next(), "utf8").split("\n").map((l) => l.trim()).filter((l) => l !== ""));
        else if (a === "--in-process") o.inProcess = true;
        else if (a === "--keep") o.keep = true;
        else if (a === "--editor") o.editor = true;
        else if (a === "--recompile") o.recompile = true;
        else if (a === "--mtriple") o.mtriple = next();
        else throw new Error(`unknown option ${a}`);
    }
    if (!o.out || ((o.keep || o.editor) && !o.inProcess) || (o.recompile && !o.keep))
        throw new Error("usage: node tests/corpus/run.ts --out <results.json> [--sample N] [--jobs 8] "
            + "[--timeout 30] [--dirs a,b] [--only <list>] [--in-process [--editor] [--keep [--recompile]]] "
            + "[--mtriple <triple>]");
    return o;
}

/** `n` evenly spaced entries of the sorted list (every entry when `n` is 0 or larger than the list). */
export function sampleOf<T>(list: readonly T[], n: number): T[] {
    if (n <= 0 || n >= list.length)
        return [...list];
    const out: T[] = [];
    for (let k = 0; k < n; k++)
        out.push(list[Math.floor((k * list.length) / n)]!);
    return out;
}

/**
 * A diagnostic line reduced to its shape, for bucketing: the leading `file(line[,col]): ` location dropped,
 * every other source location (`... at file.d(88)`) replaced by `<loc>`, every backticked name by `X`.
 */
export function lineShape(line: string): string {
    if (line === "")
        return "<empty line>";
    return line.replace(/^\S+\(\d+(,\d+)?\): /, "").replace(/\S+\.(d|di|c|i)\(\d+(,\d+)?\)/g, "<loc>")
        .replace(/`[^`]*`/g, "`X`");
}

/**
 * The text summary: counts per directory per class; the fail_compilation tests whose oracle exits 0; then the
 * top crash signatures, refused switches, and mismatch first lines by shape, from each side.
 */
export function summarize(results: readonly TestResult[], topN = 30): string {
    const lines: string[] = [];
    const classes = [...new Set(results.map((r) => r.status))].sort();
    const dirs = [...new Set(results.map((r) => r.dir))];
    lines.push(["class".padEnd(20), ...dirs.map((d) => d.padStart(17)), "total".padStart(8)].join(" "));
    for (const c of classes) {
        const per = dirs.map((d) => results.filter((r) => r.dir === d && r.status === c).length);
        const total = per.reduce((a, b) => a + b, 0);
        lines.push([c.padEnd(20), ...per.map((n) => String(n).padStart(17)), String(total).padStart(8)].join(" "));
    }
    const per = dirs.map((d) => results.filter((r) => r.dir === d).length);
    lines.push(["total".padEnd(20), ...per.map((n) => String(n).padStart(17)), String(results.length).padStart(8)]
        .join(" "));

    // `-c -o-` stops before codegen and linking, so these tests' expected failure is never reached
    const noFail = results.filter((r) => r.dir === "fail_compilation" && r.exit?.oracle === 0);
    if (noFail.length) {
        lines.push("", `fail_compilation tests the oracle accepts under -c -o- (failure past the frontend): `
            + `${noFail.length}, of them MATCH: ${noFail.filter((r) => r.status === "MATCH").length}`);
    }

    const top = (title: string, keys: string[]): void => {
        const counts = new Map<string, number>();
        for (const k of keys)
            counts.set(k, (counts.get(k) ?? 0) + 1);
        const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, topN);
        lines.push("", `${title} (${keys.length} tests, ${counts.size} distinct)`);
        for (const [k, n] of sorted)
            lines.push(`${String(n).padStart(5)}  ${k}`);
    };
    top("Top crash signatures", results.filter((r) => r.status === "CRASH").map((r) => r.signature ?? ""));
    // a refused switch counts by its name: `-Hf<path>` and `-mixin=<path>` are one switch each
    top("Top unsupported flags", results.filter((r) => r.status === "UNSUPPORTED-FLAG")
        .map((r) => (r.detail ?? "").replace(/^(-[A-Za-z][A-Za-z0-9-]*=?).*$/, "$1")));
    const mismatches = results.filter((r) => r.status.startsWith("MISMATCH"));
    // a MISMATCH-FILE counts with its file's extension: Ddoc's `.html` and JSON's files are different bugs
    const side = (r: TestResult, which: "shim" | "oracle"): string =>
        `${r.status}${r.written ? ` ${extname(r.written) || "<no extension>"}` : ""}: `
        + `${r.diff ? lineShape(r.diff[which]) : "<same text>"}`;
    top("Top mismatch first lines, shim side, by shape", mismatches.map((r) => side(r, "shim")));
    top("Top mismatch first lines, oracle side, by shape", mismatches.map((r) => side(r, "oracle")));
    return lines.join("\n") + "\n";
}

/**
 * `--keep`: how many compiles were kept, and why the others were fresh, the reasons bucketed by shape (a name with
 * a dot, a `!` or a parenthesis, the instance or module the reason names, becomes `X`).
 */
export function keepSummary(results: readonly TestResult[], topN = 30): string {
    const ran = results.filter((r) => r.keep !== undefined);
    const kept = ran.filter((r) => r.keep!.mode === "kept");
    const counts = new Map<string, number>();
    for (const r of ran) {
        if (r.keep!.mode === "kept")
            continue;
        const k = r.keep!.reason.replace(/\S*[.!(]\S*/g, "X");
        counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const lines = [`kept compiles: ${kept.length} of ${ran.length}; fresh: ${ran.length - kept.length}, by reason`];
    for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, topN))
        lines.push(`${String(n).padStart(5)}  ${k}`);
    const notMatch = kept.filter((r) => r.status !== "MATCH" && r.status !== "MATCH-LOWMEM");
    lines.push(`kept compiles not MATCH: ${notMatch.length}`);
    for (const r of notMatch.slice(0, topN))
        lines.push(`  ${r.dir}/${r.file}: ${r.status}`);
    // a compile that ran and left no record: its child died (a crash, kept or fresh) or was replaced on a timeout
    const lost = results.filter((r) => r.keep === undefined && !r.status.startsWith("SKIP-"));
    lines.push(`no keep record (child died or timed out): ${lost.length}`);
    for (const r of lost.slice(0, topN))
        lines.push(`  ${r.dir}/${r.file}: ${r.status}`);
    return lines.join("\n") + "\n";
}

/**
 * `--recompile`: how many tests were compiled again, how many of those second compiles were kept, and every test
 * whose second compile is not its first, with the first differing line of each side (all of them: this is the
 * engine's gate, not a sample). A second compile that is fresh did not replay: under `--editor`, a known non-return
 * (10 §4.7) can stop at another depth (a template recursion's stack overflow) or print another trace in it.
 */
export function recompileSummary(results: readonly TestResult[]): string {
    const ran = results.filter((r) => r.recompile !== undefined);
    const kept = ran.filter((r) => r.recompile!.mode === "kept");
    const bad = ran.filter((r) => r.recompile!.status !== "same");
    const badKept = bad.filter((r) => r.recompile!.mode === "kept").length;
    const lines = [`unchanged recompiles: ${ran.length}, kept ${kept.length}; not the first compile: ${bad.length}, `
        + `of them kept ${badKept}`];
    for (const r of bad) {
        const c = r.recompile!;
        lines.push(`  ${r.dir}/${r.file}: ${c.status}${c.mode ? ` (${c.mode}${c.reason ? `: ${c.reason}` : ""})` : ""}`
            + (c.exit && c.exit.first !== c.exit.again ? `, exit ${c.exit.first} then ${c.exit.again}` : ""));
        if (c.diff) {
            lines.push(`    line ${c.diff.line}, first: ${c.diff.first}`);
            lines.push(`    line ${c.diff.line}, again: ${c.diff.again}`);
        }
    }
    return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
    const o = parseOptions(process.argv.slice(2));
    const env = o.mtriple === null ? HOST_ENV : tripleEnv(o.mtriple);
    const work = realpathSync(mkdtempSync(join(tmpdir(), "djs-corpus-")));
    try {
        const emitDir = join(work, "emit");
        const captureDir = join(work, "capture");
        mkdirSync(emitDir);
        mkdirSync(captureDir);
        const tree = treeState();
        const djs = await emitTree(emitDir);
        const node = process.execPath;
        const root = copyCorpus(join(work, "tests"));

        const jobs: { dir: string; file: string }[] = [];
        for (const dir of o.dirs) {
            const all = readdirSync(join(root, dir)).filter((f) => /\.(d|c|i)$/.test(f)).sort();
            for (const f of sampleOf(all, o.sample))
                if (o.only === null || o.only.has(`${dir}/${f}`))
                    jobs.push({ dir, file: f });
        }
        // The order the lanes take the jobs in. `--keep`: tests with the same switches run next to each other, so
        // that a lane's next compile usually has its predecessor's command line and replays its kept state; in the
        // alphabetical order most neighbours differ in a switch and the engine compiles fresh. The order changes no
        // class (each test is compared with the oracle) and not the order of the records.
        const order = jobs.map((_, i) => i);
        if (o.keep) {
            const keys = jobs.map(({ dir, file }) => {
                const plan = planTest(dir, file, readFileSync(join(root, dir, file), "latin1"), "${RESULTS_DIR}",
                    `\${RESULTS_DIR}/${dir}`, env);
                return plan.skip !== null ? "" : plan.args.filter((a) => a.startsWith("-")).join("\0");
            });
            order.sort((a, b) => (keys[a]! < keys[b]! ? -1 : keys[a]! > keys[b]! ? 1 : a - b));
        }

        /**
         * Plans, runs and classifies job `i`, each compiler from its own fresh working directory and with its
         * own results directory (THE TREE in the file header), both removed before returning.
         */
        const shims = o.inProcess ? Array.from({ length: Math.max(1, o.jobs) },
            (_, k) => new InProcessShim(djs, join(captureDir, `lane-${k}.capture.txt`), o)) : [];
        /**
         * `--recompile`: compiles the test again in its lane's child, as `first` was compiled, and compares the two
         * raw outputs (same directory, same paths: nothing to normalize). The `.cg` a second compile writes leaves the
         * copy as the first one's did; the written files were read after the first compile and are not read again.
         */
        const recompileOf = async (first: RunOutput, shim: InProcessShim, args: string[], cwd: string):
            Promise<Recompile> => {
            const again = await shim.run(args, cwd, o.timeoutS * 1000);
            takeCg(root, args);
            const how = again.keep ? { mode: again.keep.mode, reason: again.keep.reason } : {};
            if (again.timedOut)
                return { status: "timeout", ...how };
            if (again.code === null)
                return { status: "died", ...how };
            const d = firstDifference(first.text, again.text);
            if (d === null && first.code === again.code)
                return { status: "same", ...how };
            return { status: "different", ...how, exit: { first: first.code, again: again.code },
                ...(d ? { diff: { line: d.line, first: d.shim, again: d.oracle } } : {}) };
        };
        const measure = async (i: number, lane: number): Promise<TestResult> => {
            const { dir, file } = jobs[i]!;
            const src = readFileSync(join(root, dir, file), "latin1");
            // planned once with the placeholder itself, which is also how the record spells it
            const RD = "${RESULTS_DIR}";
            const plan = planTest(dir, file, src, RD, `${RD}/${dir}`, env);
            if (plan.skip !== null)
                return { dir, file, status: plan.skip.toUpperCase(), detail: plan.detail };
            const side = (name: "shim" | "oracle") => {
                const resultsDir = join(work, "results", String(i), name);
                const workDir = join(work, "cwd", String(i), name);
                rmSync(resultsDir, { recursive: true, force: true });   // a TIMEOUT re-run measures afresh
                rmSync(workDir, { recursive: true, force: true });
                return { resultsDir, workDir, args: plan.args.map((a) => a.split(RD).join(resultsDir)) };
            };
            const s = side("shim");
            const r = side("oracle");
            try {
                for (const x of [s, r]) {
                    mkdirSync(join(x.resultsDir, dir), { recursive: true });
                    linkWorkDir(root, x.workDir);
                }
                const t0 = Date.now();
                const capture = join(captureDir, `${i}.txt`);
                const shim = o.inProcess ? await shims[lane]!.run(s.args, s.workDir, o.timeoutS * 1000)
                    : await run([node, `--stack-size=${STACK_KB}`, djs, SHIM_LDC, ...s.args], s.workDir,
                        o.timeoutS * 1000, capture);
                const shimCg = takeCg(root, s.args);
                const shimFiles = writtenFiles(s.resultsDir, s.workDir);
                const recompile = o.recompile && !shim.timedOut && shim.code !== null
                    ? await recompileOf(shim, shims[lane]!, s.args, s.workDir) : undefined;
                const refused = shim.code === 2 && /^djs: unsupported flag/m.test(shim.text);
                const oracle = shim.timedOut || refused ? null
                    : await run([ORACLE, ...r.args], r.workDir, 120_000, capture);
                const oracleCg = takeCg(root, r.args);
                const oracleFiles = writtenFiles(r.resultsDir, r.workDir);
                const shimText = normalize(shim.text, djs, s.resultsDir, [s.workDir, root]);
                const oracleLdc2 = `${LDC_ROOT}/bin/ldc2`;
                const oracleText = oracle ? normalize(oracle.text, oracleLdc2, r.resultsDir, [r.workDir, root]) : "";
                let verdict: Pick<TestResult, "status" | "detail" | "signature" | "diff" | "written"> =
                    classify(shim, oracle, shimText, oracleText);
                // both compilers write the `.cg` next to the same relative source path, so it needs no normalizing
                if (verdict.status === "MATCH" && shimCg !== oracleCg) {
                    const diff = firstDifference(shimCg ?? "<no .cg>", oracleCg ?? "<no .cg>")!;
                    verdict = { status: "MISMATCH-CG", diff };
                }
                if (verdict.status === "MATCH") {
                    const norm = (m: Map<string, string>, resultsDir: string): Map<string, string> =>
                        new Map([...m].map(([k, v]) => [k, normalizeWritten(k, v, resultsDir)]));
                    const differs = compareWritten(norm(shimFiles, s.resultsDir), norm(oracleFiles, r.resultsDir));
                    if (differs !== null)
                        verdict = { status: "MISMATCH-FILE", ...differs };
                }
                if (verdict.status.startsWith("MISMATCH") && LOWMEM_TESTS.has(`${dir}/${file}`)) {
                    const low = await run([ORACLE, "-lowmem", ...r.args], r.workDir, 120_000, capture);
                    takeCg(root, r.args);
                    const lowText = normalize(low.text, oracleLdc2, r.resultsDir, [r.workDir, root]);
                    if (classify(shim, low, shimText, lowText).status === "MATCH")
                        verdict = { status: "MATCH-LOWMEM" };
                }
                return {
                    dir, file, ...verdict,
                    exit: { shim: shim.code, oracle: oracle?.code ?? null },
                    args: plan.args, ms: Date.now() - t0, ...(shim.keep ? { keep: shim.keep } : {}),
                    ...(recompile ? { recompile } : {}),
                };
            } finally {
                for (const x of [s, r]) {
                    rmSync(x.resultsDir, { recursive: true, force: true });
                    rmSync(x.workDir, { recursive: true, force: true });   // removes the symlinks, never their targets
                }
            }
        };

        const results: TestResult[] = new Array(jobs.length);
        let next = 0;
        let doneCount = 0;
        const lane = async (_: unknown, k: number): Promise<void> => {
            for (let n = next++; n < jobs.length; n = next++) {
                const i = order[n]!;
                results[i] = await measure(i, k);
                if (++doneCount % 50 === 0)
                    process.stderr.write(`${doneCount}/${jobs.length}\n`);
            }
        };
        await Promise.all(Array.from({ length: Math.max(1, o.jobs) }, lane));
        // the cap is wall time: a TIMEOUT stands only if the test also exceeds it running alone
        for (let i = 0; i < results.length; i++) {
            if (results[i]!.status === "TIMEOUT")
                results[i] = await measure(i, 0);
        }
        for (const shim of shims)
            shim.close();

        const summary = (o.mtriple !== null ? `target: -mtriple=${o.mtriple} (d_do_test OS=${env.os})\n\n` : "")
            + (o.inProcess ? `in-process: one shim process per lane, ${shims.length} lanes`
                + `${o.editor ? ", editor mode (past a fatal point no oracle)" : ""}\n\n` : "")
            + (o.keep ? keepSummary(results) + "\n" : "")
            + (o.recompile ? recompileSummary(results) + "\n" : "")
            + summarize(results);
        writeFileSync(o.out, JSON.stringify({
            oracle: ORACLE, tests: TESTS, head: tree.head, dirty: tree.dirty, inProcess: o.inProcess,
            keep: o.keep, editor: o.editor, recompile: o.recompile, mtriple: o.mtriple, sample: o.sample,
            dirs: o.dirs,
            only: o.only === null ? null : o.only.size,
            jobs: o.jobs, timeoutS: o.timeoutS, date: new Date().toISOString(), results,
        }, null, 1) + "\n");
        writeFileSync(o.out.replace(/\.json$/, "") + ".summary.txt", summary);
        process.stdout.write(summary);
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    if (process.argv[2] === "--in-process-child")
        await inProcessChild(process.argv[3]!, { keep: process.argv.includes("--keep"),
            editor: process.argv.includes("--editor") });
    else
        await main();
}
