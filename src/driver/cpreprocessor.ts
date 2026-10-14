// Ported from driver/cpreprocessor.cpp (LDC's C++ driver), with the parts of driver/tool.cpp,
// driver/args.cpp and driver/targetmachine.cpp that its Posix path reaches.
//
// Hand-ported LDC C++ glue, homed under src/driver/ (translation-order.md §5): ImportC's C preprocessor,
// run as ldc2 runs it (FEATURES.md): the system C compiler, `-E` over the `.c`/`.h` file with druntime's
// `importc.h` force-included, the output written to a `.i` file in a fresh temporary directory, which
// Module.read (dmodule.d:705-710) reads and then deletes with its directory. djs.ts installs
// `runCPreprocessor` as `global.preprocess` where driver/main.cpp:1272 does.
//
// THE TARGETS (target.ts `Triple`, 10 §4.8): the host arm64-apple-darwin, or a `-mtriple` Linux triple, so
//   - dropped: the `_WIN32` blocks (cpreprocessor.cpp:25-28 `toAbsolute` of importc.h, :63-67 the MSVC
//     environment scope) and the MSVC leg (:89-147 `/nologo /P`, clang-cl's `--target`, `-Xclang
//     -target-feature` and `/FI`/`/Fi`): `triple.isWindowsMSVCEnvironment()` is false for every supported triple;
//   - `-fno-blocks` (:79-80) is passed on Darwin only; appendTargetArgsForGcc (tool.cpp:210) takes its Apple
//     arm (`-target <triple>`, :216-220) on the host, `-m64` (:225-231) on x86_64, nothing on aarch64 Linux
//     (its `default:` arm, :300); its LoongArch, MIPS and RISC-V arms (:233-300) are no supported triple's;
//   - findCCFallback (tool.cpp:57): with no `-mtriple` the build is native and the one choice is `cc` (:78-79);
//     a Linux `-mtriple` is a cross build (`isCompatibleWith` is false against the Darwin host), whose choices
//     are `<mtriple>-gcc`, `<mtriple>-clang` and `clang --target=<triple>` (:101-106), with the "Trying to find a
//     C cross-compiler" messages under `-v` (:110-125); the MSVC, Darwin-cross, WASI and Emscripten choices
//     are no supported triple's;
//   - getCCImpl (tool.cpp:164): `-gcc=<cc>` (tool.cpp:41) names the C compiler; without it `$CC` or the fallback
//     decides; the `_WIN32` arm (:172-175) is dropped.
// THE HOST TRIPLE `-target` passes is the target machine's, which createTargetMachine
// (targetmachine.cpp:444-469) builds from LLVM's default triple, `arm64-apple-darwin<uname release>`, by
// renaming the OS `macos<version>`: $MACOSX_DEPLOYMENT_TARGET when set, else the host's macOS version, which
// LLVM's `Triple::getMacOSXVersion` derives from the Darwin major (`darwinTargetTriple` below). Probed: ldc2 on
// Darwin 27.0.0 passes `-target arm64-apple-macos28`, and `arm64-apple-macos13.1` under
// MACOSX_DEPLOYMENT_TARGET=13.1. Under `-mtriple=aarch64-linux-gnu` ldc2 runs
// `/usr/bin/clang --target=aarch64-unknown-linux-gnu -std=c11 -dD ...` (no sysroot: a `#include <stdio.h>` fails
// in both compilers alike).
// dropped: `dmd::TimeTraceScope` (cpreprocessor.cpp:56), profiling only (11 §2.5).
// dropped: the response file of args::executeAndWait (args.cpp:158-170), written only when the command line
//   exceeds the system's limit; this one is a dozen arguments.
//
// DECLARED DIVERGENCES (the first three: text the host OS writes, which Node does not expose):
//   - llvm::sys::ExecuteAndWait reports a child killed by a signal as status -2 with `strsignal()`'s text as
//     its message; Node gives the signal's name (`SIGSEGV`), which `message:` prints instead;
//   - a failure to spawn, or to create the temporary directory, prints Node's error text where LLVM prints
//     its `std::error_code` message;
//   - the temporary directory follows LLVM's `system_temp_directory(true)` env order (TMPDIR, TMP, TEMP,
//     TEMPDIR) and then `/tmp`; LLVM's Darwin `confstr(_CS_DARWIN_USER_TEMP_DIR)` step, taken only when none
//     of the four is set, is not reachable from Node, so such a run uses `/tmp`. The path is printed only by
//     `-v`, and it is random in both compilers.
//   - when the preprocessor fails, ldc2 `fatal()`s before Module.read deletes the temporary directory, and
//     leaves it; so does the port.
//   - the column of every diagnostic at the hook's `loc` under `-vcolumns`: ldc2 reads a stack address as the
//     Loc's index (`cHookLoc`), which changes from run to run; the port's fixed index gives the same file and
//     line and its own column.

import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { release } from "node:os";
import { randomBytes } from "node:crypto";
import { global, i_ext } from "../dmd/globals.js";
import { FileName } from "../dmd/root/filename.js";
import { Loc } from "../dmd/location.js";
import type { OutBuffer } from "../dmd/common/outbuffer.js";
import { error, errorSupplemental, fatal, messageNoLoc, throwFatalError, tip } from "../dmd/errors.js";
import { targetTriple } from "../dmd/target.js";
import { ds, dsToJs, dsUtf8 } from "../dstring.js";
import { K, KeepAbort } from "../keep.js";

/** cl_options.cpp:445 `opts::ccSwitches` (`-Xcc`) and :449 `opts::cppSwitches` (`-P`), in command-line order. */
let ccSwitches: readonly string[] = [];
let cppSwitches: readonly string[] = [];
/** tool.cpp:41 `gcc` (`-gcc=<cc>`), the last occurrence; "" when absent. */
let gcc = "";
/** The function-static caches of getPathToImportc_h (cpreprocessor.cpp:17) and getCC (tool.cpp:198-199). */
let cachedImportcH: string | null = null;
let cachedCC = "";
let cachedCCArgs: string[] = [];
/**
 * The C compiler, its own arguments and importc.h of the last preprocessor run, fresh or kept, for
 * `preprocessForKeep`: a kept compile runs the preprocessor only for the C modules it reads, so the per-compile
 * caches above may be empty when the next one checks its C modules.
 */
let lastRun: { cc: string; ccArgs: string[]; importc_h: string } | null = null;

/**
 * Sets the `-Xcc` and `-P` values the next preprocessor runs pass to the C compiler and the `-gcc` value that
 * names it ("" for none), and empties the caches
 * that ldc2 keeps for its process lifetime (the importc.h path, the C compiler). djs.ts calls it once per
 * compilation, before `mars_tryMain`; one compilation per process is ldc2's model, so the reset matters to every
 * caller that compiles twice in one process: the in-process driver (`djsMain`, src/djs.ts) and the tests.
 */
export function configureCPreprocessor(cc: readonly string[], cpp: readonly string[], gccOpt: string): void {
    ccSwitches = cc.slice();
    cppSwitches = cpp.slice();
    gcc = gccOpt;
    cachedImportcH = null;
    cachedCC = "";
    cachedCCArgs = [];
}

/**
 * Runs the C preprocessor over `csrcfile` (cpreprocessor.cpp:55), the `global.preprocess` hook.
 *
 * Returns: the path of the preprocessed `.i` file, inside a new temporary directory; the caller (Module.read,
 * dmodule.d:705-710) reads it and removes the file and the directory.
 * `_defines` (D `defines`) is not written: the `-dD` switch keeps the `#define`s in the `.i` text, where CParser
 * collects them (LDC's hook has the same signature and ignores it too).
 * Failure: a missing importc.h, C compiler or temporary directory, or a non-zero exit of the C compiler,
 * prints ldc2's diagnostics and stops the compile at that `fatal()` in editor mode too (`stopAtFatal`, 10 §4.7).
 * In a kept compile (src/keep.ts), a run whose C compiler writes anything throws `KeepAbort` first.
 * The C compiler's own diagnostics go to the process's stdout/stderr, inherited; in a kept compile they are piped,
 * since the compile buffers what it prints and a fresh compile writes them outside any buffer.
 * Cost: one synchronous child process.
 */
export function runCPreprocessor(csrcfile: FileName, loc: Loc, _defines: OutBuffer): FileName {
    loc = cHookLoc(); // the `Loc` LDC's C++ body reads in place of the one D passes (see cHookLoc)
    const importc_h = getPathToImportc_h(loc);

    const ipath = getOutputPath(loc, csrcfile.toChars());

    const args: string[] = [];
    const cc = getCC(args);
    lastRun = { cc, ccArgs: [...args], importc_h };
    appendPreprocessorArgs(args, importc_h, dsToJs(csrcfile.toChars()), dsToJs(ipath.toChars()));

    // the kept-module engine (src/keep.ts): a kept compile buffers what it prints, which the C compiler's inherited
    // stdout and stderr would bypass, so there they are piped. A fresh compile's run writes what the C compiler prints
    // (a warning, a `#warning`) to the inherited stderr, in no buffer: a run that printed anything aborts the kept
    // compile. A run that printed nothing gives the `.i` text a fresh compile's run gives.
    const piped = K.kept ? { printed: false } : null;
    const status = executeToolAndWait(loc, cc, args, global.params.v.verbose, piped);
    if (piped !== null && piped.printed) {
        rmSync(dsToJs(FileName.path(ipath.toChars())), { recursive: true, force: true });
        throw new KeepAbort(`the C preprocessor writes for ${dsToJs(csrcfile.toChars())}`);
    }
    if (status) {
        errorSupplemental(loc, ds("C preprocessor failed for file '%s'"), csrcfile.toChars());
        stopAtFatal();
    }

    return ipath;
}

/** cpreprocessor.cpp:68-162, Posix: the C compiler's arguments after its own (getCC's). */
function appendPreprocessorArgs(args: string[], importc_h: string, csrcfile: string, ipath: string): void {
    args.push("-std=c11");

    appendTargetArgsForGcc(args);

    if (targetTriple().isOSDarwin())
        args.push("-fno-blocks"); // disable blocks extension

    for (const ccSwitch of ccSwitches)
        args.push(ccSwitch);
    for (const cppSwitch of cppSwitches)
        args.push(cppSwitch);

    // Posix (cpreprocessor.cpp:148-162)
    // merge #define's with output:
    // https://gcc.gnu.org/onlinedocs/cpp/Invocation.html#index-dD
    args.push("-dD");

    // need to redefine some macros in importc.h
    args.push("-Wno-builtin-macro-redefined");

    args.push("-E"); // run preprocessor only
    args.push("-include");
    args.push(importc_h);
    args.push(csrcfile);
    args.push("-o");
    args.push(ipath);
}

/**
 * No LDC counterpart: the kept-module engine (src/keep.ts) checks a kept C module before a kept compile by
 * preprocessing its file again, as `runCPreprocessor` would in this compile. Returns the `.i` text, or null when
 * the run fails or no run preceded it in this process (the module then counts as changed), and whether the C
 * compiler wrote anything (a warning, a `#warning`): a fresh compile's run writes that to the inherited stderr,
 * which a kept compile, registering the kept module without reading it, cannot give, so the engine then compiles
 * fresh. The last run's C compiler and importc.h are this one's: a kept compile has the previous compile's command
 * line.
 * Cost: one synchronous child process.
 */
export function preprocessForKeep(csrcfile: string): { text: Uint8Array | null; printed: boolean } {
    if (lastRun === null)
        return { text: null, printed: false };
    let dir: string;
    try {
        dir = createUniqueDirectory("itmp-ldc");
    } catch {
        return { text: null, printed: false };
    }
    const ipath = replaceExtension(pathAppend(dir, dsToJs(FileName.name(dsUtf8(csrcfile)))), dsToJs(i_ext));
    const args = [...lastRun.ccArgs];
    appendPreprocessorArgs(args, lastRun.importc_h, csrcfile, ipath);
    try {
        const r = spawnSync(findProgramByName(lastRun.cc), args, { stdio: ["ignore", "pipe", "pipe"] });
        const printed = (r.stdout?.length ?? 0) + (r.stderr?.length ?? 0) !== 0;
        return { text: r.status === 0 ? readFileSync(ipath) : null, printed };
    } catch {
        return { text: null, printed: false };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * ImportC's `fatal()` (cpreprocessor.cpp:22, :42, :167; tool.cpp:133, :155): the stop in every mode. The CLI's
 * handler throws inside `fatal()`; a host's handler answering true (editor mode, 10 §4.7) makes it return, and
 * `throwFatalError` then stops the compile as the CLI's handler does: `djsMain` returns 1 with the CLI's output.
 * WHY: past a returning `fatal()` LDC goes on with no `.i` text (the import fails and every use of its symbols
 * reports again: ~80 s against the CLI's ~5 s on a project missing one `-P=-I`), or into undefined behaviour (a
 * null importc.h path, the end of the non-void findCCFallback). Neither gives an editor a diagnostic it needs.
 */
function stopAtFatal(): never {
    fatal();
    return throwFatalError();
}

/** cpreprocessor.cpp:15 — importc.h, next to object.d: the first import path holding it, cached. */
function getPathToImportc_h(loc: Loc): string {
    if (cachedImportcH === null) {
        const found = FileName.searchPath(global.importPaths.opSlice(), ds("importc.h"), false);
        if (found === null) {
            error(loc, ds("cannot find \"importc.h\" along import path"));
            stopAtFatal();
        }
        cachedImportcH = dsToJs(found);   // `cached = FileName::searchPath(...)`
    }
    return cachedImportcH;
}

/**
 * cpreprocessor.cpp:33 — a new unique directory `itmp-ldc-XXXXXX` under the temporary directory, joined with
 * the source file's name, its extension replaced by `.i`.
 */
function getOutputPath(loc: Loc, csrcfile: Uint8Array): FileName {
    // 1) create a new temporary directory (e.g., `/tmp/itmp-ldc-10ecec`)
    let buffer: string;
    try {
        buffer = createUniqueDirectory("itmp-ldc");
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // On failure LLVM leaves the last model path tried in `buffer`, which the error prints.
        buffer = e instanceof UniqueDirectoryError ? e.path : "";
        error(loc, ds("failed to create temporary directory for preprocessed .i file: %s\n%s"),
            dsUtf8(buffer), dsUtf8(msg));
        stopAtFatal();
    }

    // 2) append the .c file name, replacing the extension with .i
    buffer = pathAppend(buffer, dsToJs(FileName.name(csrcfile)));
    buffer = replaceExtension(buffer, dsToJs(i_ext));

    // the directory is removed (after the file) in Module.read()

    return FileName.create(dsUtf8(buffer)); // allocates a copy
}

/** The model path a failed llvm::sys::fs::createUniqueDirectory leaves in its result buffer. */
class UniqueDirectoryError extends Error {
    constructor(readonly path: string, cause: string) {
        super(cause);
    }
}

/**
 * llvm::sys::fs::createUniqueDirectory (llvm/lib/Support/Path.cpp): `<tmp>/<prefix>-%%%%%%`, each `%` a random
 * lowercase hex digit, created with mode 0770 (`owner_all | group_all`); an existing name is retried, up to 128
 * times. Returns the directory's path; throws UniqueDirectoryError with the last model tried.
 */
function createUniqueDirectory(prefix: string): string {
    const model = pathAppend(systemTempDirectory(), `${prefix}-%%%%%%`);
    let last = model;
    for (let retry = 0; retry < 128; retry++) {
        const hex = randomBytes(6).toString("hex");
        let k = 0;
        last = model.replace(/%/g, () => hex[2 * k++]!);
        try {
            mkdirSync(last, { mode: 0o770 });
            return last;
        } catch (e) {
            if (e instanceof Error && "code" in e && e.code === "EEXIST")
                continue;
            throw new UniqueDirectoryError(last, e instanceof Error ? e.message : String(e));
        }
    }
    throw new UniqueDirectoryError(last, "File exists");
}

/** llvm::sys::path::system_temp_directory(/*ErasedOnReboot=*\/true), Unix: the first SET variable, else /tmp. */
function systemTempDirectory(): string {
    for (const env of ["TMPDIR", "TMP", "TEMP", "TEMPDIR"]) {
        const dir = process.env[env];
        if (dir !== undefined)
            return dir;
    }
    return "/tmp";
}

/** llvm::sys::path::append on Posix: one `/` between the parts unless the left one already ends in it. */
function pathAppend(base: string, name: string): string {
    if (base === "" || base.endsWith("/"))
        return base + name;
    return `${base}/${name}`;
}

/** llvm::sys::path::replace_extension: drops the file name's last `.ext` (if any), then appends `.<ext>`. */
function replaceExtension(path: string, ext: string): string {
    const slash = path.lastIndexOf("/");
    const dot = path.lastIndexOf(".");
    const stem = dot > slash ? path.slice(0, dot) : path;
    return ext.startsWith(".") ? stem + ext : `${stem}.${ext}`;
}

/**
 * tool.cpp:197 `getCC` — the C compiler's full path; the arguments `$CC` carries after the command are
 * appended to `additional_args`. Both cached for the process.
 */
function getCC(additional_args: string[]): string {
    if (cachedCC === "")
        cachedCC = getCCImpl(cachedCCArgs);

    additional_args.push(...cachedCCArgs);
    return cachedCC;
}

/** tool.cpp:164 `getCCImpl`. */
function getCCImpl(additional_args: string[]): string {
    if (gcc !== "")
        return getProgram(gcc);   // tool.cpp:139 `getProgram(nullptr, &gcc)`: the option's value

    const cc = process.env["CC"] ?? "";   // args.cpp:203 env::get: "" when unset
    if (cc === "") {
        const fallback = findCCFallback();
        additional_args.push(...fallback.slice(1));
        return fallback[0]!;
    }

    // Posix: in case $CC contains spaces split it into a command and arguments
    if (!cc.includes(" "))
        return getProgram(cc);

    const args = cc.split(" ").filter((s) => s !== "");   // StringRef::split, keepEmpty=false

    // args[0] == CC command, args[1..] = CLI options
    for (let i = 1; i < args.length; i++)
        additional_args.push(args[i]!);
    return getProgram(args[0]!);
}

/**
 * tool.cpp:57 `findCCFallback`: the first choice found on the PATH (its arguments after it), else a fatal error.
 * Native build (no `-mtriple`): `cc`. Cross build (a Linux `-mtriple`): the `<mtriple>-gcc`, `<mtriple>-clang`
 * and `clang --target=<triple>` choices, each logged under `-v`.
 */
function findCCFallback(): string[] {
    const triple = targetTriple();
    // tool.cpp:59-61 — `opts::mTargetTriple.empty() || triple.isCompatibleWith(nativeTriple)`: a Linux triple is
    // not compatible with the Darwin host.
    const isNativeBuild = triple.explicit === null;

    let choices: string[][];
    if (isNativeBuild) {
        choices = [["cc"]];
    } else {
        choices = [
            [triple.explicit + "-gcc"],
            [triple.explicit + "-clang"],
            ["clang", "--target=" + triple.getTriple()],
        ];
    }

    const verbose = global.params.v.verbose;
    const logCross = verbose && !isNativeBuild;
    if (logCross) messageNoLoc(ds("Trying to find a C cross-compiler"));

    for (const choice of choices) {
        const fullPath = findProgramByName(choice[0]!);
        if (fullPath === "") {
            if (logCross) messageNoLoc(ds("Did not find C cross-compiler: `%s`"), dsUtf8(choice[0]!));
            continue;
        }

        if (logCross) messageNoLoc(ds("Found C cross-compiler: `%s`"), dsUtf8(fullPath));
        choice[0] = fullPath;
        return choice;
    }

    if (isNativeBuild) {
        error(Loc.initial, ds("could not find C compiler `%s`"), dsUtf8(choices[0]![0]!));
    } else {
        error(Loc.initial, ds("could not find a C cross-compiler for this cross-compilation"));
        tip(ds("make sure you have a compiler like `%s` installed and set $CC or pass -gcc accordingly"),
            dsUtf8(choices[0]![0]!));
    }

    return stopAtFatal();
}

/** tool.cpp:139 `getProgram` with no environment variable: `name` (the `-gcc` value, or `$CC`'s command) on the PATH. */
function getProgram(name: string): string {
    const path = findProgramByName(name);
    if (path === "") {
        error(Loc.initial, ds("cannot find program `%s`"), dsUtf8(name));
        stopAtFatal();
    }

    return path;
}

/**
 * llvm::sys::findProgramByName (llvm/lib/Support/Unix/Program.inc) through tool.cpp:49: a name holding a `/` is
 * returned as is; otherwise the first `<dir>/<name>` over $PATH's non-empty entries that is a readable,
 * executable regular file (`sys::fs::can_execute`). "" when none is (or $PATH is unset).
 */
function findProgramByName(name: string): string {
    if (name.includes("/"))
        return name;
    const pathEnv = process.env["PATH"];
    if (pathEnv === undefined)
        return "";
    for (const dir of pathEnv.split(":")) {
        if (dir === "")
            continue;
        const filePath = pathAppend(dir, name);
        try {
            accessSync(filePath, constants.R_OK | constants.X_OK);
            if (statSync(filePath).isFile())
                return filePath;
        } catch {
            // not there, or not executable: the next entry
        }
    }
    return "";
}

/**
 * tool.cpp:210 `appendTargetArgsForGcc`: on Darwin the Apple arm (:216-220), `-target <triple>`; on x86_64
 * `-m64` (:225-231, `isArch64Bit()` true); nothing on aarch64 Linux (`default:`, :300).
 */
function appendTargetArgsForGcc(args: string[]): void {
    const triple = targetTriple();

    // specify a -target triple for Apple targets (and Apple clang as C compiler)
    if (triple.isOSDarwin()) {
        args.push("-target");
        args.push(triple.explicit === null ? darwinTargetTriple() : triple.getTriple());
        return;
    }

    // Specify -m32/-m64 for architectures where gcc supports those flags.
    if (triple.arch === "x86_64")
        args.push("-m64");
}

/**
 * `global.params.targetTriple->getTriple()` as createTargetMachine (targetmachine.cpp:444-469) builds it with no
 * `-mtriple`: LLVM's default triple `arm64-apple-darwin<release>`, the OS renamed `macos` plus
 * $MACOSX_DEPLOYMENT_TARGET when it is set and non-empty, else the host's macOS version. With a `-mtriple` it is the
 * triple as normalized (targetmachine.cpp:479), `Triple.getTriple()`.
 */
function darwinTargetTriple(): string {
    let osname = "macos";
    // We have to specify OS version in the triple to avoid linker warnings,
    // see https://github.com/ldc-developers/ldc/issues/4501.
    const envVersion = process.env["MACOSX_DEPLOYMENT_TARGET"] ?? "";
    if (envVersion !== "")
        osname += envVersion;
    else
        osname += macOSXVersion(Number.parseInt(release(), 10));
    return `arm64-apple-${osname}`;
}

/**
 * LLVM's `Triple::getMacOSXVersion` for a `darwin<major>` OS, printed as `VersionTuple::getAsString` does:
 * darwin 0 counts as 8; 4-19 are macOS 10.(major-4); 20-24 are macOS 11-15; 25 and later are macOS major+1
 * (darwin 25 is macOS 26). Darwin majors below 4 do not occur on a host that runs ldc2 1.43.
 */
function macOSXVersion(darwinMajor: number): string {
    const major = darwinMajor === 0 ? 8 : darwinMajor;
    if (major <= 19)
        return `10.${major - 4}`;
    if (major < 25)
        return `${11 + major - 20}`;
    return `${major + 1}`;
}

/**
 * The `Loc` cpreprocessor.cpp:55 receives. D declares the hook with `ref const Loc` (globals.d:447) and LDC's C++
 * takes `Loc` by value (globals.h:469), so the C++ body reads the low 32 bits of the address of Module.read's `loc`
 * parameter (dmodule.d:705), a stack address, as the Loc's index. On the arm64 macOS stack that index is about
 * 1.8e9 and changes from run to run (the column ldmd2 `-vcolumns` prints changes with it), but it is past the
 * start of every registered file, so it resolves to the LAST registered BaseLoc at its last line: for a `.c` root
 * module, the last root's `Loc.singleFilename` (mars.d:2001), line 0 (`helloc.c: Error: ...`); for a `.c` file
 * imported from D, the last file read before it (`.../ldc/intrinsics.di(742): Error: ...` in runnable/test23402.d).
 * The port takes index 0x7FFF_FFFF: past every start, so the same file and line; only the column (`-vcolumns`)
 * differs, as it does between two ldc2 runs. `index_` is Loc's raw-index accessor, used outside location.ts here
 * because the C++ reinterprets raw bits.
 */
function cHookLoc(): Loc {
    const loc = new Loc();
    loc.index_ = 0x7FFF_FFFF;
    return loc;
}

/**
 * tool.cpp:346 `executeToolAndWait` (with getFullArgs, :320, and args::executeAndWait, args.cpp:155): runs `tool`
 * with `args`, stdio inherited (with `piped`, the kept-module engine's, stdout and stderr are piped, and `printed`
 * says whether the tool wrote anything); under `verbose` first prints the command line, each word followed by a space.
 * Returns the exit status (-1 when it could not run or exited with 127/126, -2 when a signal killed it); a non-zero
 * status is reported as an error at `loc`.
 */
function executeToolAndWait(loc: Loc, tool_: string, args: readonly string[], verbose: boolean,
    piped: { printed: boolean } | null = null): number {
    const tool = findProgramByName(tool_);
    if (tool === "") {
        error(loc, ds("cannot find program `%s`"), dsUtf8(tool_));
        return -1;
    }

    // Construct real argument list; first entry is the tool itself.
    // Print command line if requested
    if (verbose) {
        let singleString = "";
        for (const arg of [tool, ...args])
            singleString += `${arg} `;
        messageNoLoc(ds("%s"), dsUtf8(singleString));
    }

    // Execute tool.
    let errorMsg = "";
    let status: number;
    const r = spawnSync(tool, args, { stdio: piped === null ? "inherit" : ["inherit", "pipe", "pipe"] });
    if (piped !== null)
        piped.printed = (r.stdout?.length ?? 0) + (r.stderr?.length ?? 0) !== 0;
    if (r.error !== undefined) {
        status = -1;
        errorMsg = r.error.message;
    } else if (r.signal !== null) {
        status = -2;
        errorMsg = r.signal;
    } else {
        status = r.status ?? -1;
        // llvm::sys::Wait (llvm/lib/Support/Unix/Program.inc): exit codes 127 and 126 are the shell's "not found" and
        // "not executable", reported as a failure to run.
        if (status === 127) {
            status = -1;
            errorMsg = "No such file or directory";
        } else if (status === 126) {
            status = -1;
            errorMsg = "Program could not be executed";
        }
    }

    if (status) {
        error(loc, ds("%s failed with status: %d"), dsUtf8(tool), status);
        if (errorMsg !== "") {
            errorSupplemental(loc, ds("message: %s"), dsUtf8(errorMsg));
        }
    }

    return status;
}
