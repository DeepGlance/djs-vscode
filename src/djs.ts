// The djs process entry: the port of what LDC's C++ driver does before and around the frontend.
//
// Hand-written djs module, NOT a port of a dmd/ file. ldc2's `main` / `cppmain` / `parseCommandLine` /
// `registerPredefinedVersions` are C++ (driver/main.cpp), its switches are LLVM `cl::opt`s bound to
// `global.params` (driver/cl_options.cpp), and the DMD-style spellings the dmd test corpus passes are
// translated to them by ldmd2 (driver/ldmd.cpp `translateArgs`), which is how LDC runs that corpus. This file
// ports what the FRONTEND sees of those three: the `Param` values, the version identifiers, the import paths,
// the `-i` patterns (compiler.d), the fatal/exit plumbing (10 §4.1), and ImportC's preprocessor hook with its `-P`
// switches (src/driver/cpreprocessor.ts). Codegen, target-machine and linker state are not ported: the target is
// the host's (arm64-apple-darwin) or the `-mtriple` one of the Linux triples target.ts models (10 §4.8), and the
// shim stops rather than emit anything.
//
// THE FLAG CONTRACT (10 §4.2). `parseCommandLine` accepts the DMD spellings ldmd2 accepts, one at a time, and
// sets what ldc2 sets for the ldc2 switch ldmd2 translates it to; each arm cites both. A switch that is not in
// the table, or whose effect the shim does not reproduce (an output file other than the frontend's Ddoc, JSON,
// `-vcg-ast`, `.di` header, mixin and module-dependency files, codegen, linking, another target), STOPS the run
// before the frontend starts: `djs:
// unsupported flag` on stderr, exit status 2. Nothing is silently ignored except switches that cannot change a
// diagnostic, each marked where it is accepted.
//
// THE CONFIG FILE AND THE IMPORT TREE. ldc2 reads etc/ldc2.conf, whose only frontend-visible entry for this
// triple is the post-switch `-I%%ldcbinarypath%%/../import` (30-compiler.conf). The shim plays that entry: an
// import directory appended after the command line's `-I`s, and `-conf=` (no config file) drops it, as it does for
// ldc2. The directory is, in this order: the djs-only `--djs-ldc=<root>`, an ldc2 1.43.0 install laid out as LDC's
// release archives, spelled `<root>/bin/../import` as ldc2 expands it and reported as `<root>/etc/ldc2.conf`, so
// paths and `-v` print as that install's ldc2 prints them (the oracle's runs pass it); else the LDC 1.43.0 import
// tree bundled with djs, `ldc-1.43.0/import` in the repository root, reported as the config itself; else an error
// that stops the run. Nothing else is read from an LDC install, and djs never runs ldc2.
//
// RUN IT with Node over the tsc emit of `src/` as `node --stack-size=7600 <emit>/djs.js <args>` (see
// tests/corpus/run.ts STACK_KB): ldc2 recurses on an 8 MiB main-thread stack and the corpus probes that depth
// (fail_compilation/fail280.d), which Node's default ~1 MiB stack turns into a RangeError; the value stays below
// `ulimit -s` so V8 reports the overflow instead of the OS killing the process. Imported as a module (the
// load-order suites, the tests) it does nothing until `djsMain` is called.

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";
import { CHECKACTION, CHECKENABLE, Edition } from "./dmd/astenums.js";
import { Compiler, includeModulePatterns, resetCompilerState, setIncludeImports } from "./dmd/compiler.js";
import { DebugCondition, VersionCondition } from "./dmd/cond.js";
import {
    ErrorKind, FatalError, type FatalErrorHandler, clearDiagnostics, deprecation, diagnosticHandler, error, fatal,
    messageNoLoc, reportDiagnosticForKeep, resetErrorsState, setDiagnosticHandler, setFatalErrorHandler,
    throwFatalError,
} from "./dmd/errors.js";
import {
    CLIIdentifierTable, CppStdRevision, DiagnosticReporting, ErrorPrintMode, FeatureState, ImportPathInfo,
    JsonFieldFlags, OUTPUTFLAGno, OUTPUTFLAGdefault, dmd_version, global,
} from "./dmd/globals.js";
import { Identifier } from "./dmd/identifier.js";
import { initImphint } from "./dmd/imphint.js";
import { Loc, MessageStyle, purgeLocFiles } from "./dmd/location.js";
import { mars_tryMain } from "./dmd/main.js";
// after main.js, inside whose graph every one of these modules has evaluated (01 §4.8): the state
// `deinitializeFrontend` resets
import { _resetArrayOpTemplate } from "./dmd/arrayop.js";
import { _resetTfToHash } from "./dmd/clone.js";
import { ClassDeclaration } from "./dmd/dclass.js";
import { keepDropCtfeGlobals, resetCtfeGlobals } from "./dmd/dinterpret.js";
import { Module, getFilename } from "./dmd/dmodule.js";
import { StructDeclaration } from "./dmd/dstruct.js";
import { Dsymbol, PASS } from "./dmd/dsymbol.js";
import {
    addDeferredSemantic2, addDeferredSemantic3, resetDsymbolsemState, runDeferredSemantic,
} from "./dmd/dsymbolsem.js";
import {
    TemplateAliasParameter, TemplateStats, TemplateTypeParameter, TemplateValueParameter,
} from "./dmd/dtemplate.js";
import { EscapeState } from "./dmd/escape.js";
import { ErrorExp, Expression, IntegerExp } from "./dmd/expression.js";
import { resetExpressionsemState } from "./dmd/expressionsem.js";
import { FuncDeclaration } from "./dmd/func.js";
import { resetFuncsemState } from "./dmd/funcsem.js";
import { Id } from "./dmd/id.js";
import { Type, resetTypeGlobals } from "./dmd/mtype.js";
import { Objc } from "./dmd/objc.js";
import { resetSemantic3State, semantic3 } from "./dmd/semantic3.js";
import { HOST_TRIPLE, UNSUPPORTED_HOST, hostTriple, parseTargetTriple, target } from "./dmd/target.js";
import type { Triple } from "./dmd/target.js";
import {
    appendToModuleMember, deferSemantic3, keptInstanceMatch, resetTemplatesemState, walkInstanceScopes,
} from "./dmd/templatesem.js";
import { semantic2 } from "./dmd/semantic2.js";
import { PKG, Sizeok, TY } from "./dmd/astenums.js";
import { FileManager } from "./dmd/file_manager.js";
import { AssocArray } from "./dmd/root/aav.js";
import { FileName } from "./dmd/root/filename.js";
import { DYNCAST } from "./dmd/rootobject.js";
import { resetTypesemState } from "./dmd/typesem.js";
import { DFAAllocator } from "./dmd/dfa/fast/structure.js";
// dmodule.d:26 and iasm/gcc.d:27 `import dmd.cparse;` are registration slots in dmodule.ts and iasm/gcc.ts (their
// ORDER CONTRACTs): loading cparse.js fills both, so a `.c`/`.h`/`.i` module parses and a C `asm` statement is
// analysed. After main.js, inside whose graph dmodule.js and iasm/gcc.js have evaluated.
import "./dmd/cparse.js";
import { parsePreviewOption, parseRevertOption, parseTransitionOption } from "./dmd/mars.js";
// after mars.js, which already loads json.js inside the frontend graph: named here, json.js would not be the
// entry of that graph (01 §4.8)
import { tryParseJsonField } from "./dmd/json.js";
import { parseDigits } from "./dmd/utils.js";
import { OutBuffer } from "./dmd/common/outbuffer.js";
import { Array as DArray } from "./dmd/root/array.js";
import { initTokens } from "./dmd/tokens.js";
import { type KeptCompile, dropKeptState as dropKept, keepBind, keepCompile } from "./keep.js";
import { dropQueryIndex } from "./query.js";
import { ds, dsUtf8 } from "./dstring.js";
import type { DString } from "./dstring.js";
// after the frontend graph (main.js above); cpreprocessor.js imports only leaf modules of it
import { configureCPreprocessor, preprocessForKeep, runCPreprocessor } from "./driver/cpreprocessor.js";
// after the frontend graph (main.js above), inside which hooks.js has already loaded it
import { createTargetMachine, isModelledCPU, traitsTargetHasFeature } from "./gen/ldctraits.js";

/**
 * The LDC 1.43.0 import tree bundled with djs (druntime, Phobos, LDC's ldc/ and etc/ modules, object.d, ImportC's
 * headers, LDC's LICENSE beside it): `ldc-1.43.0/import` in the directory above this module's (the repository root
 * from src/) or the one above that (from dist/src/, an emit inside the repository or a package laid out like it).
 * Null when neither holds its object.d: an emit elsewhere, as the corpus and Phobos runners make, passes
 * `--djs-ldc=<root>`.
 */
function bundledImportDir(): string | null {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const up of ["..", "../.."]) {
        const dir = resolve(here, up, "ldc-1.43.0", "import");
        if (existsSync(join(dir, "object.d")))
            return dir;
    }
    return null;
}
/** `ldc::ldc_version` / `ldc::llvm_version` of the oracle (its `-v` `version` line). */
const LDC_VERSION = "1.43.0";
const LLVM_VERSION = "22.1.8";
const LLVM_VERSION_MAJOR = "22";

/**
 * The ldc2 options the shim accepts spelled `--<name>`: ldc2's LLVM cl reads them as `-<name>`, and each is in the
 * table under that name with ldc2's meaning (ldmd2 translates its own `-vcolumns`, `-preview=`, ... to the same
 * ldc2 option). ldmd2-only spellings (`version`, `debug`, `inline`, ...) are not: `--version` is LLVM's own option.
 */
const LDC2_DOUBLE_DASH: ReadonlySet<string> = new Set([
    "checkaction", "d-debug", "d-version", "deps", "gcc", "i", "preview", "release", "revert", "transition",
    "unittest", "vcolumns",
]);

/** The exit status of a run the shim refused (an unsupported switch); distinct from ldc2's 0 and 1. */
export const EXIT_UNSUPPORTED = 2;

/** Thrown by `parseCommandLine` for a switch outside the shim's table; `djsMain` reports it. */
class UnsupportedFlag extends Error {
    constructor(readonly flag: string, readonly why: string) {
        super(`unsupported flag \`${flag}\` (${why})`);
        this.name = "UnsupportedFlag";
    }
}

// ── driver state: the cl::opt globals the frontend never reads directly ─────────────────────────────────
// Reset by `resetDriverState` at the start of every `djsMain`, as a new ldc2 process starts with them.

let compileOnly = false;          // cl_options.cpp `compileOnly` ("c")
let dontWriteObj = false;         // cl_options.cpp `dontWriteObj` ("o-")
let fNoExceptions = false;        // cl_options.cpp `fNoExceptions` ("fno-exceptions"; ldmd `-nothrow`)
let noAsm = false;                // cl_options.cpp:254 `noAsm` ("noasm")
let optimize = false;             // driver/cl_options.cpp `-O*`; read by `isOptimizationEnabled()`
let objectFile: string | null = null;   // "of", null until it occurs (`getNumOccurrences`)
let objectDir: string | null = null;    // "od"
let printErrorContext: boolean | null = null;   // "verrors-context", with its occurrence
let useDIP1000Legacy: boolean | null = null;    // "dip1000" (hidden legacy switch)
let useDIP25Legacy = false;       // "dip25" occurrence
let explicitConf: string | null = null;          // "-conf=<file>"
let ldcRoot: string | null = null;               // djs-only "--djs-ldc=<root>", the last occurrence
let confImportDir = "";                          // the import directory the shim's ldc2.conf appends; "": none
let versions: string[] = [];      // "d-version"
let debugArgs: string[] = [];     // "d-debug=<x>"
let transitions: string[] = [];
let previews: string[] = [];
let reverts: string[] = [];
let includePatterns: string[] = [];              // "i", value-less occurrences as ""
let hasIncludeSwitch = false;
let hdrKeepAllBodies = false;       // "Hkeep-all-bodies" (ldmd `-inline`)
let ddocDir: string | null = null;      // "Dd", null until it occurs
let ddocFile: string | null = null;     // "Df"
let jsonFile: string | null = null;     // "Xf"
let jsonFields: string[] = [];          // "Xi", one entry per occurrence
let hdrDir: string | null = null;       // cl_options.cpp:324 "Hd"
let hdrFile: string | null = null;      // cl_options.cpp:328 "Hf"
let mixinFile: string | null = null;    // cl_options.cpp:375 "mixin"
let moduleDeps: string | null = null;   // cl_options.cpp:452 "deps", ValueOptional: "" for a value-less occurrence
let cppSwitches: string[] = [];         // cl_options.cpp:449 "P", one entry per occurrence
let m64bits = false;                    // main.cpp `m64bits` ("m64"), its occurrence
let mTargetTriple: Triple | null = null; // cl_options.cpp:468 `mTargetTriple` ("mtriple"), parsed; null: empty
let gcc = "";                           // tool.cpp:41 `gcc` ("gcc"), the last occurrence; "" when absent
let mCPU = "";                          // LLVM codegen's `MCPU` ("mcpu"), the last occurrence; "" when absent
let mCPUFlag = "";                      // the spelling of that occurrence, for a refusal
let mAttrs: string[] = [];              // LLVM codegen's `MAttrs` ("mattr", a cl::list), one entry per occurrence
let cpuStr = "";                        // `codegen::getCPUStr()`: `mCPU` with `native` resolved

function resetDriverState(): void {
    compileOnly = dontWriteObj = fNoExceptions = noAsm = optimize = false;
    objectFile = objectDir = null;
    printErrorContext = useDIP1000Legacy = null;
    useDIP25Legacy = false;
    explicitConf = ldcRoot = null;
    confImportDir = "";
    versions = []; debugArgs = []; transitions = []; previews = []; reverts = []; includePatterns = [];
    hasIncludeSwitch = hdrKeepAllBodies = false;
    ddocDir = ddocFile = jsonFile = null;
    jsonFields = [];
    hdrDir = hdrFile = mixinFile = moduleDeps = null;
    cppSwitches = [];
    gcc = "";
    m64bits = false;
    mTargetTriple = null;
    mCPU = mCPUFlag = cpuStr = "";
    mAttrs = [];
}

/**
 * Parses the command line into `global.params` and `files`, as ldmd2's translation followed by ldc2's
 * `parseCommandLine` (driver/main.cpp:268) would. Reports through the frontend's `error`/`deprecation`
 * what ldc2 reports there (bad version identifiers, bad `-preview`s); throws `UnsupportedFlag` for a switch
 * outside the table.
 */
function parseCommandLine(args: readonly string[], files: DArray<DString>): void {
    const P = global.params;
    global.params.argv0 = dsUtf8(process.argv[1] ?? "djs");   // main.cpp:270 `exe_path::getExePath()`
    P.v.errorPrintMode = ErrorPrintMode.printErrorContext;    // main.cpp:272

    const unsupported = (a: string, why: string): never => {
        throw new UnsupportedFlag(a, why);
    };
    /** The value of `-name=<v>` (or, for a cl::Prefix option, `-name<v>`). */
    const valueOf = (a: string, name: string): string => {
        const rest = a.slice(1 + name.length);
        return rest.startsWith("=") ? rest.slice(1) : rest;
    };
    const enumValue = <T>(a: string, name: string, table: Record<string, T>): T => {
        const v = valueOf(a, name);
        if (!(v in table))
            unsupported(a, `ldc2 rejects the value of -${name}`);
        return table[v]!;
    };

    const fileList: string[] = [];
    for (let i = 0; i < args.length; i++) {
        let a = args[i]!;
        /**
         * The value of the cl::Prefix option `-<name>`: attached (`-<name><v>`, `-<name>=<v>`), or, when nothing
         * is attached, the NEXT argument whatever it is, as LLVM's cl takes it for a value-required option.
         */
        const prefixValue = (name: string): string => {
            if (a.length > 1 + name.length)
                return valueOf(a, name);
            const next = args[++i];
            if (next === undefined) {
                // ldc2 appends ldc2.conf's post-switches after the command line, so a trailing `-I` takes the
                // config's `-I<import dir>` as its value
                unsupported(a, "no value follows: ldc2 takes its config file's first post-switch as the value");
            }
            return next!;
        };
        if (a.startsWith("@")) {
            // ldmd.cpp:393 `response_expand` (driver/response.cpp:121) expands `@<file>` / `@<envvar>` before
            // any switch is read, and stops with `Could not read response file.` when neither exists.
            unsupported(a, "a response file: ldmd2 expands it before parsing (driver/response.cpp), the shim "
                + "does not");
        }
        if (!a.startsWith("-") || a === "-") {
            fileList.push(a);   // cl::Positional `fileList`
            continue;
        }
        // djs's own switch, not ldc2's: the ldc2 install whose import tree and ldc2.conf the shim plays (THE CONFIG
        // FILE AND THE IMPORT TREE, above).
        if (a.startsWith("--djs-ldc=")) {
            ldcRoot = a.slice("--djs-ldc=".length);
            if (!isAbsolute(ldcRoot) || !existsSync(join(ldcRoot, "import", "object.d")))
                unsupported(a, "not an absolute path to an ldc2 1.43.0 install with import/object.d");
            continue;
        }
        // ldmd2 hands a `--<name>` switch to ldc2 unchanged (no arm of ldmd.cpp's translation matches a second dash;
        // the pass-through is :760), and ldc2's LLVM cl reads `--<name>` as `-<name>`. The shim takes that spelling
        // for the ldc2 options its table models under the same name, and for the ldc2-only `d-version`, `d-debug`
        // and `gcc` (the spellings build tools' ldc2 lines use); any other `--<name>` stops the run.
        if (a.startsWith("--")) {
            const name = a.slice(2).split("=")[0]!;
            if (!LDC2_DOUBLE_DASH.has(name))
                unsupported(a, "an ldc2 switch outside the shim's flag table (10 §4.2)");
            a = a.slice(1);
        }
        // Switches whose effect the frontend path never sees: accepted, nothing set.
        if (a === "-fPIC" || a === "-lowmem" || a === "-quiet"
            || a.startsWith("-L") || a.startsWith("-defaultlib=") || a.startsWith("-debuglib=")
            || a === "-disable-linker-strip-dead" || a === "-g" || a === "-gc" || a === "-gf" || a === "-gs"
            || a === "-color=off" || a === "-op" || a === "-nogc") {
            // -fPIC: ldmd.cpp `-relocation-model=pic`, already the model of every supported triple (`D_PIC`);
            // -lowmem: main.cpp:189, GC mode only;
            // -quiet: ldmd.cpp, nothing; -L/-defaultlib/-debuglib/
            // -disable-linker-strip-dead: link only; -g/-gc/-gf/-gs: debug info and frame pointers (codegen);
            // -color=off: ldmd.cpp `-disable-color`, the default for a pipe; -op: object file paths;
            // -nogc: gen/runtime.cpp:45, checked when code generation asks for a runtime function (:61), which no
            // run of the shim reaches (main.ts stops at `codegenModules`).
            if (a === "-op")
                P.preservePaths = true;   // gen/modules.cpp:62 "op"
            else if (a === "-g" || a === "-gf")
                P.symdebug = 1;   // cl_options.cpp `debugInfo`
            else if (a === "-gc")
                P.symdebug = 2;
            continue;
        }
        // main.cpp `m64bits`: every supported target is 64-bit already (tryGetExplicitTriple, main.cpp:241-249, and
        // createTargetMachine, targetmachine.cpp:472, keep the triple); with `-mtriple` it is an error (`cppmain`).
        if (a === "-m64") { m64bits = true; continue; }
        // cl_options.cpp:468 `mTargetTriple`, a cl::opt<std::string>: `-mtriple=<t>` or `-mtriple <t>`, the last
        // occurrence winning. ldmd2 passes it through (ldmd.cpp:760).
        if (a === "-mtriple" || a.startsWith("-mtriple=")) {
            const v = a === "-mtriple" ? prefixValue("mtriple") : a.slice(9);
            const triple = parseTargetTriple(v);
            if (triple === null) {
                unsupported(a === "-mtriple" ? `${a} ${v}` : a,
                    "the shim models aarch64-linux-gnu, x86_64-linux-gnu and the arm64 Mac only (10 §4.8)");
            }
            mTargetTriple = triple;
            continue;
        }
        // ldmd.cpp:619-634 `-mcpu=`: `?`, `h` and `help` become ldc2's `-mcpu=help`, which prints LLVM's CPU list;
        // `baseline` is dropped; `avx` and `avx2` become `-mattr=+avx` / `-mattr=+avx2`; `native` and any other
        // value (the Lerror arm, :760) pass through as ldc2's `-mcpu=<v>`. Which CPUs the model covers is checked
        // after the loop, once the triple is known.
        if (a.startsWith("-mcpu=")) {
            const v = a.slice(6);
            if (v === "?" || v === "h" || v === "help")
                unsupported(a, "ldc2 prints LLVM's CPU list, which the shim does not reproduce");
            if (v === "avx" || v === "avx2") {
                mAttrs.push(`+${v}`);
            } else if (v !== "baseline") {
                mCPU = v;
                mCPUFlag = a;
            }
            continue;
        }
        if (a.startsWith("-conf=")) {   // main.cpp:210 `tryGetExplicitConfFile`
            explicitConf = a.slice(6);
            if (explicitConf !== "")
                unsupported(a, "the shim plays only ldc2's own ldc2.conf");
            continue;
        }
        if (a === "-c") { compileOnly = true; continue; }
        if (a === "-o-") { dontWriteObj = true; continue; }
        if (a.startsWith("-od")) { objectDir = prefixValue("od"); continue; }     // cl_options.cpp:265
        if (a.startsWith("-of")) { objectFile = prefixValue("of"); continue; }    // cl_options.cpp:261
        if (a === "-oq") { P.fullyQualifiedObjectFiles = true; continue; }
        // ldmd.cpp:655-668 passes -D, -Dd, -Df, -X and -Xf through unchanged, and -Xi falls to its pass-through
        // arm (:760). cl_options.cpp:295 `doDdoc` ("D") and :308 `doJson` ("X") are bools bound to
        // `ddoc.doOutput` / `json.doOutput`; their `-D=<bool>` forms are not in the table. :300 "Dd", :304 "Df"
        // and :312 "Xf" are cl::Prefix strings, the last occurrence winning; main.cpp:356-363 reads them below.
        if (a === "-D") { P.ddoc.doOutput = true; continue; }
        if (a.startsWith("-Dd")) { ddocDir = prefixValue("Dd"); continue; }
        if (a.startsWith("-Df")) { ddocFile = prefixValue("Df"); continue; }
        if (a === "-X") { P.json.doOutput = true; continue; }
        if (a.startsWith("-Xf")) { jsonFile = prefixValue("Xf"); continue; }   // `-Xf-` / `-Xf=-`: stdout
        // cl_options.cpp:317 `jsonFields` ("Xi") is a cl::list, not a cl::Prefix: `-Xi=<field>` or `-Xi <field>`;
        // ldc2 rejects `-Xi<field>` as an unknown argument, which falls to the end of the table here.
        if (a.startsWith("-Xi=")) { jsonFields.push(a.slice(4)); continue; }
        if (a === "-Xi") { jsonFields.push(prefixValue("Xi")); continue; }
        // ldmd.cpp:661-663 passes -H, -Hd and -Hf through unchanged. cl_options.cpp:321 `doHdrGen` ("H") is a bool
        // bound to `dihdr.doOutput`; :324 "Hd" and :328 "Hf" are cl::Prefix strings, the last occurrence winning,
        // which main.cpp:366-369 reads below. :333 "Hkeep-all-bodies" is what ldmd's `-inline` sets. The C++ header
        // switches (-HC, -HCd, -HCf: dtoh.d) are not in the table.
        if (a === "-H") { P.dihdr.doOutput = true; continue; }
        if (a.startsWith("-Hd")) { hdrDir = prefixValue("Hd"); continue; }
        if (a.startsWith("-Hf")) { hdrFile = prefixValue("Hf"); continue; }
        if (a === "-Hkeep-all-bodies") { hdrKeepAllBodies = true; continue; }
        // cl_options.cpp:375 `mixinFile` ("mixin"), a cl::opt<std::string> ldmd2 passes through (ldmd.cpp:575):
        // `-mixin=<file>` or `-mixin <file>`, the last occurrence winning; main.cpp:376 reads it below.
        if (a === "-mixin" || a.startsWith("-mixin=")) {
            mixinFile = a === "-mixin" ? prefixValue("mixin") : a.slice(7);
            continue;
        }
        // cl_options.cpp:452 `moduleDeps` ("deps"), cl::ValueOptional, passed through by ldmd2 (ldmd.cpp:746):
        // `-deps` (to stdout) or `-deps=<file>`, never the next argument; main.cpp:379 reads it below.
        if (a === "-deps" || a.startsWith("-deps=")) { moduleDeps = a.slice(6); continue; }
        if (a.startsWith("-I")) {   // main.cpp:91 ImportPathsAdapter("I", params.imppath, false)
            const v = prefixValue("I");
            if (!v)
                error(Loc.initial, ds("Expected argument to '-%s'"), ds("I"));
            const info = new ImportPathInfo();
            info.path = dsUtf8(v);
            info.isOutOfBinary = false;
            P.imppath.push(info);
            continue;
        }
        // cl_options.cpp:449 `cppSwitches` ("P"), a cl::Prefix list ldmd2 passes through (ldmd.cpp:742): `-P=<flag>`,
        // `-P<flag>` or `-P <flag>`, each handed to the C preprocessor in order (cpreprocessor.cpp:85).
        if (a.startsWith("-P")) { cppSwitches.push(prefixValue("P")); continue; }
        // tool.cpp:41 `gcc`, a cl::opt<std::string>: `-gcc=<cc>` or `-gcc <cc>`, the last occurrence winning; the C
        // compiler ImportC's preprocessor runs (tool.cpp:164 getCCImpl). Passed through by ldmd2 (ldmd.cpp:760).
        if (a === "-gcc" || a.startsWith("-gcc=")) { gcc = a === "-gcc" ? prefixValue("gcc") : a.slice(5); continue; }
        if (a.startsWith("-J")) {   // cl_options.cpp StringsAdapter("J", params.fileImppath)
            const v = prefixValue("J");
            if (!v)
                error(Loc.initial, ds("Expected argument to '-%s'"), ds("J"));
            P.fileImppath.push(dsUtf8(v));
            continue;
        }
        if (a.startsWith("-mv=")) {   // cl_options.cpp StringsAdapter("mv", params.modFileAliasStrings)
            P.modFileAliasStrings.push(dsUtf8(a.slice(4)));
            continue;
        }
        if (a === "-i" || a.startsWith("-i=")) {   // cl_options.cpp `includeModulePatterns`, ValueOptional
            hasIncludeSwitch = true;
            includePatterns.push(a === "-i" ? "" : a.slice(3));
            continue;
        }
        // ldmd.cpp: `-version=<x>` -> `-d-version=<x>`, `-debug[=<x>]` -> `-d-debug[=<x>]`, comma-separated.
        // ldc2's own `-d-version=` and `-d-debug[=]` (cl_options.cpp, comma-separated), passed through by ldmd2.
        if (a.startsWith("-version=") || a.startsWith("-d-version=")) {
            versions.push(...a.slice(a.indexOf("=") + 1).split(","));
            continue;
        }
        if (a === "-debug" || a === "-d-debug") { P.debugEnabled = true; continue; }   // D_DebugStorage, empty value
        if (a.startsWith("-debug=") || a.startsWith("-d-debug=")) {
            for (const d of a.slice(a.indexOf("=") + 1).split(","))
                if (d === "")
                    P.debugEnabled = true;
                else
                    debugArgs.push(d);
            continue;
        }
        // main.cpp:107-112 `editions`, a cl::list whose EditionsAdapter (cl_helpers.cpp:78) hands each value to
        // ldcbindings.d:87 `parseEditionOption`; ldmd.cpp:525 turns the DMD spelling `-edition` into `-edition=`.
        if (a === "-edition" || a.startsWith("-edition=")) {
            const v = a === "-edition" ? "" : a.slice(9);
            if (!parseEditionOption(v))
                error(Loc.initial, ds("Invalid argument for '-edition': %s"), dsUtf8(v));
            continue;
        }
        if (a.startsWith("-transition=")) { transitions.push(...a.slice(12).split(",")); continue; }
        if (a.startsWith("-preview=")) { previews.push(...a.slice(9).split(",")); continue; }
        if (a.startsWith("-revert=")) { reverts.push(...a.slice(8).split(",")); continue; }
        if (a === "-vtls") { transitions.push("tls"); continue; }   // ldmd.cpp `-transition=tls`
        // cl_options.cpp `useDeprecated`: "de" error, "d" off, "dw" inform.
        if (a === "-de") { P.useDeprecated = DiagnosticReporting.error; continue; }
        if (a === "-d") { P.useDeprecated = DiagnosticReporting.off; continue; }
        if (a === "-dw") { P.useDeprecated = DiagnosticReporting.inform; continue; }
        // cl_options.cpp `warnings`: "w" error, "wi" inform.
        if (a === "-w") { P.useWarnings = DiagnosticReporting.error; continue; }
        if (a === "-wi") { P.useWarnings = DiagnosticReporting.inform; continue; }
        if (a === "-v") { P.v.verbose = true; continue; }
        if (a === "-vcolumns") { P.v.showColumns = true; continue; }
        if (a === "-vgc") { P.v.gc = true; continue; }
        // cl_options.cpp:144 `vcg-ast`, bound to `global.params.vcg_ast`; ldmd2 passes it through unchanged
        // (ldmd.cpp:588). main.ts's `mars_tryMain` writes `<srcfile>.cg` per root module (main.d:857).
        if (a === "-vcg-ast") { P.vcg_ast = true; continue; }
        if (a === "-vtemplates") { P.v.templates = true; continue; }   // cl_options.cpp VTemplatesParser
        if (a === "-vtemplates=list-instances") {
            P.v.templates = true;
            P.v.templatesListInstances = true;
            continue;
        }
        if (a.startsWith("-verrors=")) {   // ldmd.cpp: digits pass through; spec / simple / context translate
            const v = a.slice(9);
            if (/^[0-9]/.test(v)) {
                if (!/^[0-9]+$/.test(v))
                    unsupported(a, "ldc2 rejects a non-numeric -verrors");
                P.v.errorLimit = Number.parseInt(v, 10);   // cl_options.cpp `errorLimit` (unsigned)
            } else if (v === "spec")
                P.v.showGaggedErrors = true;   // `-verrors-spec`
            else if (v === "simple")
                printErrorContext = false;     // `-verrors-context=false`
            else if (v === "context")
                printErrorContext = true;      // `-verrors-context`
            else
                unsupported(a, "ldmd2 rejects it");
            continue;
        }
        if (a.startsWith("-verror-style=")) {
            P.v.messageStyle = enumValue(a, "verror-style",
                { digitalmars: MessageStyle.digitalmars, gnu: MessageStyle.gnu, sarif: MessageStyle.sarif });
            continue;
        }
        if (a.startsWith("-verror-supplements=")) {
            const v = a.slice(20);
            if (!/^[0-9]+$/.test(v))
                unsupported(a, "ldc2 rejects a non-numeric value");
            P.v.errorSupplementLimit = Number.parseInt(v, 10);
            continue;
        }
        if (a === "-unittest") { P.useUnitTests = true; continue; }
        if (a === "-release") { P.release = true; continue; }
        if (a === "-betterC") { P.betterC = true; continue; }
        if (a === "-allinst") { P.allInst = true; continue; }
        if (a === "-main") { P.addMain = true; continue; }
        if (a === "-ignore") { P.ignoreUnsupportedPragmas = true; continue; }
        if (a === "-shared") { P.dll = true; continue; }
        if (a === "-nothrow") { fNoExceptions = true; continue; }   // ldmd.cpp `-fno-exceptions`
        if (a === "-noasm") { noAsm = true; continue; }   // ldmd2 passes it through (ldmd.cpp:760)
        // gen/optimizer.cpp:76 `optimizeLevel`, the last occurrence wins; :177 `isOptimizationEnabled()` is
        // `optimizeLevel != 0`, and only `-O0` is level 0.
        if (a === "-O" || /^-O[0-5sz]$/.test(a)) { optimize = a !== "-O0"; continue; }
        if (a === "-inline") {   // ldmd.cpp: `-enable-inlining -Hkeep-all-bodies`; the former is an LLVM pass
            hdrKeepAllBodies = true;
            continue;
        }
        if (a === "-dip1000") { useDIP1000Legacy = true; continue; }
        if (a === "-dip25") { useDIP25Legacy = true; continue; }
        if (a === "-dip1008") { P.ehnogc = true; continue; }
        if (a === "-cov") { P.cov = true; continue; }   // cl_options.cpp:672 CoverageParser
        if (a === "-cov=ctfe") {
            P.cov = true;
            P.ctfe_cov = true;
            continue;
        }
        if (/^-cov=[0-9]+$/.test(a) && Number.parseInt(a.slice(5), 10) <= 100) {
            P.cov = true;
            P.covPercent = Number.parseInt(a.slice(5), 10);
            continue;
        }
        // ldmd.cpp `-fdmd-trace-functions`, which sets `trace` (cl_options_instrumentation.cpp:135)
        if (a === "-profile") { P.trace = true; continue; }
        if (a.startsWith("-checkaction=")) {
            P.checkAction = enumValue(a, "checkaction",
                { D: CHECKACTION.D, C: CHECKACTION.C, halt: CHECKACTION.halt, context: CHECKACTION.context });
            continue;
        }
        if (a.startsWith("-boundscheck=")) {
            P.useArrayBounds = enumValue(a, "boundscheck",
                { off: CHECKENABLE.off, safeonly: CHECKENABLE.safeonly, on: CHECKENABLE.on });
            continue;
        }
        if (a === "-noboundscheck") { P.useArrayBounds = CHECKENABLE.off; continue; }   // ldmd.cpp
        if (a.startsWith("-check=")) { parseCheck(a); continue; }
        if (a.startsWith("-extern-std=")) {
            P.cplusplus = enumValue(a, "extern-std", {
                "c++98": CppStdRevision.cpp98, "c++11": CppStdRevision.cpp11, "c++14": CppStdRevision.cpp14,
                "c++17": CppStdRevision.cpp17, "c++20": CppStdRevision.cpp20, "c++23": CppStdRevision.cpp23,
            });
            continue;
        }
        if (a.startsWith("-identifiers=") || a.startsWith("-identifiers-importc=")) {
            const imp = a.startsWith("-identifiers-importc=");
            const t = enumValue(a, imp ? "identifiers-importc" : "identifiers", {
                c99: CLIIdentifierTable.C99, c11: CLIIdentifierTable.C11, UAX31: CLIIdentifierTable.UAX31,
                all: CLIIdentifierTable.All,
            });
            if (imp)
                P.cIdentifierTable = t;
            else
                P.dIdentifierTable = t;
            continue;
        }
        unsupported(a, "not in the shim's flag table (10 §4.2)");
    }

    // cl_options-llvm.cpp:65 `getCPUStr()`, LLVM's `codegen::getCPUStr()`: `native` is the host's CPU name. Checked
    // here, before anything is printed, against the CPUs gen/ldctraits.ts has ldc2's tables for (10 §4.2). Without a
    // triple (an unsupported host and no `-mtriple`) the check is left out: `cppmain` stops the run.
    cpuStr = mCPU;
    if (mCPU === "native") {
        const host = getHostCPUName();
        if (host === null) {
            unsupported(mCPUFlag, "the host's CPU is not the one ldc2 was probed on (the Apple M2, apple-m2; "
                + "10 §4.2)");
        }
        cpuStr = host!;
    }
    const tripleForCPU = mTargetTriple ?? HOST_TRIPLE;
    if (tripleForCPU !== null && !isModelledCPU(tripleForCPU, cpuStr)) {
        unsupported(mCPUFlag, `no ldc2-probed feature table for \`${cpuStr}\` on ${tripleForCPU.arch} (10 §4.2)`);
    }

    // main.cpp:274-282, 331-342 — the config file, and what `-v` prints about the run.
    if (explicitConf === null) {
        if (ldcRoot !== null) {
            confImportDir = `${ldcRoot}/bin/../import`;
            global.inifilename = dsUtf8(`${ldcRoot}/etc/ldc2.conf`);
        } else {
            const bundled = bundledImportDir();
            if (bundled === null) {
                // cppmain's `global.errors` check right after the command line stops the run.
                error(Loc.initial, ds("djs: no import tree: no `--djs-ldc=<root>`, and no bundled "
                    + "`ldc-1.43.0/import` above the djs module"));
            } else {
                confImportDir = bundled;
                global.inifilename = dsUtf8(bundled);
            }
        }
    }
    if (global.params.v.verbose) {
        messageNoLoc(ds("binary    %s"), dsUtf8(process.argv[1] ?? "djs"));
        messageNoLoc(ds("version   %s (DMD %s, LLVM %s)"), ds(LDC_VERSION), dmd_version, ds(LLVM_VERSION));
        if (global.inifilename.length) {
            // main.cpp:277 `cfg_triple`, tryGetExplicitTriple (main.cpp:221): the default triple when `-m64` was
            // given (:241-249) or no `-mtriple`, else the normalized `-mtriple`.
            // On a host without a triple (null) the line is left out: cppmain refuses the run.
            const cfgTriple = m64bits || mTargetTriple === null ? HOST_TRIPLE : mTargetTriple;
            if (cfgTriple !== null) {
                messageNoLoc(ds("config    %.*s (%s)"), global.inifilename.length, global.inifilename,
                    dsUtf8(cfgTriple.getTriple()));
            }
        }
    }

    // Negated options (main.cpp:344)
    P.link = !compileOnly;
    P.obj = !dontWriteObj;
    P.useInlineAsm = !noAsm;
    P.useExceptions = !fNoExceptions;
    // `useModuleInfo = !fNoModuleInfo; useTypeInfo = !fNoRTTI;` — neither switch is in the table.
    P.useModuleInfo = true;
    P.useTypeInfo = true;

    // String options (main.cpp:352)
    P.objname = fromPathString("of", objectFile);
    P.objdir = fromPathString("od", objectDir);
    P.ddoc.dir = fromPathString("Dd", ddocDir);     // main.cpp:356
    P.ddoc.name = fromPathString("Df", ddocFile);
    P.ddoc.doOutput ||= (P.ddoc.dir?.length ?? 0) !== 0 || (P.ddoc.name?.length ?? 0) !== 0;

    P.json.name = fromPathString("Xf", jsonFile);   // main.cpp:361
    if ((P.json.name?.length ?? 0) !== 0 || jsonFields.length !== 0) {
        P.json.doOutput = true;
    }
    P.dihdr.dir = fromPathString("Hd", hdrDir);     // main.cpp:366
    P.dihdr.name = fromPathString("Hf", hdrFile);
    P.dihdr.doOutput ||= (P.dihdr.dir?.length ?? 0) !== 0 || (P.dihdr.name?.length ?? 0) !== 0;
    // main.cpp:371-374 `cxxhdr`: -HC, -HCd and -HCf are refused above, so it keeps its default.

    P.mixinOut.name = fromPathString("mixin", mixinFile);   // main.cpp:376
    P.mixinOut.doOutput ||= (P.mixinOut.name?.length ?? 0) !== 0;

    if (moduleDeps !== null) {   // main.cpp:379 `moduleDeps.getNumOccurrences() != 0`
        P.moduleDeps.doOutput = true;
        P.moduleDeps.buffer = new OutBuffer();   // `createOutBuffer()`
        if (moduleDeps !== "")
            P.moduleDeps.name = dsUtf8(moduleDeps);   // `opts::dupPathString`
    }
    // main.cpp:386-390 `makeDeps`: -makedeps is refused above, so it keeps its default.

    for (const field of jsonFields) {   // main.cpp:403
        const flag = tryParseJsonField(dsUtf8(field + "\0"));   // `field.c_str()`: json.d reads a C string
        if (flag === JsonFieldFlags.none) {
            error(Loc.initial, ds("unknown JSON field `-Xi=%s`"), dsUtf8(field));
        } else {
            P.jsonFieldFlags |= flag;
        }
    }

    // main.cpp:412-422 — `-i`.
    setIncludeImports(hasIncludeSwitch);
    for (const pattern of includePatterns) {
        // a value-less `-i` only enables `includeImports`
        if (pattern !== "")
            includeModulePatterns.push(dsUtf8(pattern + "\0"));   // `pattern.c_str()`: compiler.d reads a C string
    }
    // When including imports, their object files aren't tracked in
    // global.params.objfiles etc. Enforce `-singleobj` to avoid related issues.
    if (hasIncludeSwitch)
        P.oneobj = true;

    if (printErrorContext !== null) {   // main.cpp:427
        P.v.errorPrintMode = printErrorContext ? ErrorPrintMode.printErrorContext : ErrorPrintMode.simpleError;
    }

    processVersions("debug", debugArgs);     // main.cpp:435
    processVersions("version", versions);    // main.cpp:436

    for (const id of transitions)
        parseTransitionOption(P, dsUtf8(id));
    for (const id of previews)
        parsePreviewOption(P, dsUtf8(id));
    for (const id of reverts)
        parseRevertOption(P, dsUtf8(id));

    if (P.useDIP1021) // DIP1021 implies DIP1000
        P.useDIP1000 = FeatureState.enabled;
    // legacy -dip1000 option
    if (P.useDIP1000 === FeatureState.default_ && useDIP1000Legacy !== null)
        P.useDIP1000 = useDIP1000Legacy ? FeatureState.enabled : FeatureState.disabled;

    if (P.useDIP1000 === FeatureState.enabled) // DIP1000 implies DIP25
        P.useDIP25 = FeatureState.enabled;
    // legacy -dip25 option
    if (useDIP25Legacy)
        deprecation(Loc.initial, ds("`-dip25` no longer has any effect"));

    // -betterC implies -allinst (since D v2.105)
    if (P.betterC)
        P.allInst = true;

    // main.cpp:466 — no `-output-*` switch is in the table, so `output_o` is its default.
    P.output_o = OUTPUTFLAGdefault;
    P.output_bc = P.output_ll = P.output_mlir = P.output_s = OUTPUTFLAGno;

    // main.cpp:477 `templateLinkage` is codegen state.

    for (const file of fileList) {   // main.cpp:518
        if (file !== "") {
            if (file === "-")
                P.readStdin = true;
            else
                files.push(dsUtf8(file));
        }
    }
    // main.cpp:529-560 — the `-of` extension autodetect switches only `output_*` for an `.ll`/`.bc`/`.s`/`.mlir`
    // object name; with no link those produce no object the shim could write. Left to the codegen stop.

    P.dihdr.fullOutput = hdrKeepAllBodies;   // main.cpp:569
    // main.cpp:570 `disableRedZone` is codegen state.
}

/**
 * LLVM's `sys::getHostCPUName()` (llvm/lib/TargetParser/Host.cpp), for `-mcpu=native`. On an arm64 Mac LLVM maps
 * `sysctl hw.cpufamily` to a CPU name, and so does the shim, for the one family probed with ldc2 on this machine:
 * CPUFAMILY_ARM_BLIZZARD_AVALANCHE (0xda33d83d in the SDK's <mach/machine.h>, the M2) is `apple-m2`
 * (`ldc2 --version`: `Host CPU: apple-m2`). Returns null for any other family and on any other host (on Linux LLVM
 * reads /proc/cpuinfo): their names are not verified, so the driver refuses `-mcpu=native` there.
 * `codegen::getFeaturesStr()` also adds `sys::getHostCPUFeatures()` for `native`: none on this M2 (probed: under
 * x86_64-linux-gnu, where every AArch64 feature name would warn, `-mcpu=native` warns about the CPU name only, and on
 * AArch64 it answers every feature as `-mcpu=apple-m2` does), so the shim adds none.
 * Cost: one `sysctl` process.
 */
function getHostCPUName(): string | null {
    if (process.platform !== "darwin" || process.arch !== "arm64")
        return null;
    const family = execFileSync("/usr/sbin/sysctl", ["-n", "hw.cpufamily"], { encoding: "utf8" });
    return Number.parseInt(family, 10) >>> 0 === 0xda33d83d ? "apple-m2" : null;   // printed as a signed int
}

/**
 * ldcbindings.d:87 `parseEditionOption`: an empty value is `Edition.min`, `NNNN` the edition of every module, and
 * `NNNN<filename>` an entry of `editionFiles` (which the frontend does not read). False for anything else.
 */
function parseEditionOption(str: string): boolean {
    const s = dsUtf8(str);
    if (s.length === 0) {
        global.params.edition = Edition.v2023;   // `Edition.min`
        return true;
    }
    if (s.length >= 4) {
        const box = { value: 0 as number | bigint };
        // `parseDigits!Edition(edition, str[0 .. 4], Edition.max) && edition >= Edition.min`
        if (parseDigits(box, s.subarray(0, 4), "ushort", BigInt(Edition.v2025)) && box.value >= Edition.v2023) {
            if (s.length === 4)
                global.params.edition = Number(box.value) as Edition;
            else
                global.params.editionFiles.set(s.subarray(4), Number(box.value) as Edition);
            return true;
        }
    }
    return false;
}

/**
 * cl_helpers.cpp:33 `fromPathString`: null when the switch never occurred; an occurrence with an empty value
 * is an error (`-od=`), whose empty path is still returned.
 */
function fromPathString(name: string, value: string | null): DString | null {
    if (value === null)
        return null;
    if (value === "")
        error(Loc.initial, ds("Expected argument to '-%s'"), ds(name));
    return dsUtf8(value);
}

/** ldmd.cpp's `-check=` translation into ldc2's `-boundscheck=` / `-{enable,disable}-<check>` switches. */
function parseCheck(a: string): void {
    const P = global.params;
    const arg = a.slice(7);
    const all = [
        (v: CHECKENABLE) => { P.useArrayBounds = v; },   // `-boundscheck=on|off`
        (v: CHECKENABLE) => { P.useAssert = v; },
        (v: CHECKENABLE) => { P.useIn = v; },
        (v: CHECKENABLE) => { P.useInvariants = v; },
        (v: CHECKENABLE) => { P.useOut = v; },
        (v: CHECKENABLE) => { P.useSwitchError = v; },
    ];
    if (arg === "on") { for (const f of all) f(CHECKENABLE.on); return; }
    if (arg === "off") { for (const f of all) f(CHECKENABLE.off); return; }
    let enabled = true;
    let kind = arg;
    if (arg.length > 3 && arg.endsWith("=on")) kind = arg.slice(0, -3);
    else if (arg.length > 4 && arg.endsWith("=off")) { enabled = false; kind = arg.slice(0, -4); }
    const v = enabled ? CHECKENABLE.on : CHECKENABLE.off;
    switch (kind) {
        case "bounds": P.useArrayBounds = v; return;
        case "assert": P.useAssert = v; return;
        case "in": P.useIn = v; return;
        case "invariant": P.useInvariants = v; return;
        case "out": P.useOut = v; return;
        case "switch": P.useSwitchError = v; return;
        case "nullderef":
            if (!enabled)
                return;   // ldmd.cpp: `-check=nullderef=off` passes, `=on` is "not in LDC"
            break;
    }
    throw new UnsupportedFlag(a, "ldmd2 rejects it");
}

/** main.cpp:159 `processVersions`: each `-d-debug=`/`-d-version=` value must be a valid identifier. */
function processVersions(type: "debug" | "version", list: readonly string[]): void {
    for (const i of list) {
        const cstr = dsUtf8(i);
        if (Identifier.isValidIdentifier(cstr)) {
            if (type === "debug")
                DebugCondition.addGlobalIdent(cstr);
            else
                VersionCondition.addGlobalIdent(cstr);
        } else {
            error(Loc.initial, ds("Invalid %s identifier: '%s'"), ds(type), cstr);
        }
    }
}

/**
 * Registers the predefined version identifiers (driver/main.cpp:997): the compiler's, the ones that follow
 * `global.params` (checks, `-unittest`, `-betterC`, coverage, profiling, optimization), the target triple's
 * (main.cpp:645 `registerPredefinedTargetVersions`, below), and the LLVM major.
 * `D_ObjectiveC` is added by `Objc._init()`. Called by `mars_tryMain` (main.d:432) after `reconcileCommands`.
 */
export function registerPredefinedVersions(): void {
    const add = (s: string): void => VersionCondition.addPredefinedGlobalIdent(ds(s));
    add("LDC");
    add("all");
    add("D_Version2");

    // main.cpp:1002-1022 — no `-mdcompute-targets` switch is in the table: no DCompute versions.

    if (global.params.ddoc.doOutput)
        add("D_Ddoc");

    if (global.params.cov)
        add("D_Coverage");

    if (global.params.useUnitTests)
        add("unittest");

    if (global.params.useAssert === CHECKENABLE.on)
        add("assert");

    if (global.params.useIn === CHECKENABLE.on)
        add("D_PreConditions");

    if (global.params.useOut === CHECKENABLE.on)
        add("D_PostConditions");

    if (global.params.useInvariants === CHECKENABLE.on)
        add("D_Invariants");

    if (global.params.useArrayBounds === CHECKENABLE.off)
        add("D_NoBoundsChecks");

    if (global.params.betterC) {
        add("D_BetterC");
    } else {
        if (global.params.useModuleInfo)
            add("D_ModuleInfo");
        if (global.params.useExceptions)
            add("D_Exceptions");
        if (global.params.useTypeInfo)
            add("D_TypeInfo");
    }

    if (global.params.trace)
        add("D_Profile");

    if (global.params.tracegc)
        add("D_ProfileGC");

    if (optimize)
        add("D_Optimized");

    registerPredefinedTargetVersions(add);

    // `D_ObjectiveC` is added by the dmd.objc.Supported ctor

    // main.cpp:1083-1101 — no dynamic-compile or sanitizer switch is in the table.

    // Expose LLVM version to runtime
    add(`LDC_LLVM_${LLVM_VERSION_MAJOR}`);
}

/**
 * driver/main.cpp:645 `registerPredefinedTargetVersions`, over the triples target.ts models (10 §4.8): the arms of
 * other archs and OSes are dead. Inputs beyond the triple: the float ABI, `Hard` on aarch64 and x86_64 with no
 * `-float-abi` switch (driver/targetmachine.cpp:584-587); the data layout, little endian with 64-bit pointers on
 * every supported triple; the relocation model, PIC on all three (ldc2 -v prints `D_PIC`); on x86_64 the target
 * machine's `avx` and `avx2` (src/gen/ldctraits.ts, `createTargetMachine`). ldc2 -v prints exactly these sequences.
 */
function registerPredefinedTargetVersions(add: (s: string) => void): void {
    const triple = global.params.targetTriple ?? hostTriple();

    if (triple.arch === "x86_64") {   // main.cpp:657-663
        add("X86_64");
        if (global.params.useInlineAsm) {
            add("D_InlineAsm_X86_64");
        }
        add("D_HardFloat");
    } else {                          // main.cpp:685-688, registerPredefinedFloatABI (:623) with `Hard`
        add("AArch64");
        add("ARM_HardFloat");
        add("D_HardFloat");
    }

    // endianness
    add("LittleEndian");   // main.cpp:768-772

    // ELFv1/ELFv2 — main.cpp:775-784; not ppc64
    if (triple.isOSBinFormatELF()) {
        add("ELFv1");
    }

    // Set versions for arch bitwidth
    add("D_LP64");   // main.cpp:787-789

    add("D_PIC");    // main.cpp:796-798

    if (triple.arch === "x86_64") {   // main.cpp:800-809; no `D_SIMD` (:801-804, LDC lacks DMD's core.simd interface)
        if (traitsTargetHasFeature(ds("avx")))
            add("D_AVX");
        if (traitsTargetHasFeature(ds("avx2")))
            add("D_AVX2");
    }

    // parse the OS out of the target triple
    if (triple.isOSLinux()) {   // main.cpp:834-855, the glibc arm: not Android, not musl, not uClibc
        add("linux");
        add("Posix");
        add("CRuntime_Glibc");
        add("CppRuntime_GNU");
        add("CppRuntime_Gcc"); // legacy
    } else {                    // main.cpp:860-868
        add("OSX");
        add("Apple");
        add("darwin"); // For backwards compatibility.
        add("Posix");
        add("CppRuntime_LLVM");
        add("CppRuntime_Clang"); // legacy
    }
}

/**
 * The part of `cppmain` (driver/main.cpp:1174) the frontend sees: `global._init()`, the command line, the
 * config file's import directory, the non-Windows `dllexport`/`dllimport` defaults, then `mars_tryMain`.
 * Returns: `mars_tryMain`'s status. Throws what `mars_tryMain` throws, and `FatalError` from the CLI's fatal
 * handler; with a host's returning handler the `fatal()` below falls through, as main.cpp:1199-1201 does.
 */
function cppmain(args: readonly string[]): number {
    global._init();
    global.ldc_version = ds(LDC_VERSION);
    global.llvm_version = ds(LLVM_VERSION);

    const files = new DArray<DString>();
    parseCommandLine(args, files);

    // ldc2.conf's post-switches (etc/ldc2.conf/30-compiler.conf), appended after the command line.
    if (confImportDir !== "") {
        const info = new ImportPathInfo();
        info.path = dsUtf8(confImportDir);
        global.params.imppath.push(info);
    }

    if (args.length === 0) {
        // main.cpp:1194-1196 — `cl::PrintHelpMessage` then `exit(EXIT_FAILURE)`: LLVM's help text is not ported.
        throw new UnsupportedFlag("", "no arguments: ldc2 prints its help, which the shim does not reproduce");
    }

    if (global.errors) {
        fatal();
    }

    // main.cpp:1203-1240 — the target machine. `-m32` and `-march` are refused (not in the table), so `bitness`
    // and `arch` are their defaults, and so is the relocation model.
    if (m64bits && mTargetTriple !== null) {
        error(Loc.initial, ds("-m32 and -m64 switches cannot be used together with -march and -mtriple switches"));
    }
    // djs's own refusal: no `-mtriple` on a host the shim models no target for (target.ts `hostTripleOf`). Under a
    // returning fatal handler `hostTriple()` below then throws, reported as `Internal error: ` with the same text.
    if (mTargetTriple === null && HOST_TRIPLE === null) {
        error(Loc.initial, ds(UNSUPPORTED_HOST));
    }
    if (global.errors) {
        fatal();
    }
    // main.cpp:1238-1239 — `global.params.targetTriple = new llvm::Triple(gTargetMachine->getTargetTriple());`
    global.params.targetTriple = mTargetTriple ?? hostTriple();
    // main.cpp:1229 `createTargetMachine(mTargetTriple, arch, opts::getCPUStr(), opts::getFeaturesStr(), ...)`, after
    // the triple here because the port reads the triple from `global.params`; nothing prints in between.
    // `getFeaturesStr()` is the host's features for `native` (none, `getHostCPUName`), then each `-mattr`.
    createTargetMachine(cpuStr, mAttrs);

    // main.cpp:1248-1263 — not Windows:
    global.params.dllexport = false;
    // `global.params.dllimport = DLLImport::none;` — the Param default.
    // main.cpp:1272 — ImportC's C preprocessor (driver/cpreprocessor.cpp), with the command line's `-P` values;
    // `-Xcc` (cl_options.cpp:445) is not in the table, so `ccSwitches` stays empty.
    global.preprocess = runCPreprocessor;
    configureCPreprocessor([], cppSwitches, gcc);
    // main.cpp:1285 `loadAllPlugins()` — no `-plugin` switch is in the table: nothing to load.

    return mars_tryMain(global.params, files);
}

/**
 * Puts every piece of frontend state a compilation leaves behind back to its load-time value, so that the next
 * `djsMain` in this process compiles as a fresh process would. ldc2 compiles once per process and never needs
 * this; an in-process host (an editor) does, so it is a duty of the djs driver (10 §4). Upstream dmd's
 * frontend.d `deinitializeDMD` calls such methods for DMD as a library; it is not in LDC's tree.
 * Order: first the D deinitialize and reset methods of the 1.43.0 tree, each cited (`clearDiagnostics` is not
 * one: it empties the dmd/errors.d:52 `diagnostics` slot); then the `__gshared` slots no D deinitialize covers
 * (statics, function-local statics, caches over the finished compile's types and modules, recursion counters a
 * `fatal()` stop leaves raised) and the port's own module state. Module-private state is reset by its owning
 * module; public statics are reset here. dmd/timetrace.d:50 `deinitializeTimeTrace` has no call: timetrace is
 * dropped from the port.
 * Left to the code that refills them on every call: the identifier table (`initTokens`), the Loc file table
 * (`Loc._init` in `mars_tryMain`), the C preprocessor's switches and tool caches (`configureCPreprocessor` in
 * `cppmain`), and the target machine the LDC traits read (gen/ldctraits.ts `createTargetMachine` in `cppmain`).
 * What stays across calls holds no compile's state: immutable tables, the registration slots, scratch buffers each
 * use clears.
 * Called at the start of every `djsMain`, the first included: on a fresh process every reset below writes the
 * slot's load-time value, or one the inits of `mars_tryMain` overwrite before any read (`Type.stringtable`), so
 * one unconditional call needs no first-call flag (which would be state too).
 * Cost: a few hundred assignments; the previous compile's AST becomes garbage.
 */
function deinitializeFrontend(): void {
    clearDiagnostics();                 // dmd/errors.d:52 `diagnostics`, the SARIF collector
    global.deinitialize();              // dmd/globals.d:561 — `this = this.init`: errors, gag, params, version ids
    Type.deinitialize();                // dmd/mtype.d:632
    Id.deinitialize();                  // dmd/id.d:45
    Module.deinitialize();              // dmd/dmodule.d:303
    Expression.deinitialize();          // dmd/expression.d:165
    Objc.deinitialize();                // dmd/objc.d:244
    Dsymbol.deinitialize();             // dmd/dsymbol.d:928
    EscapeState.reset();                // dmd/escape.d:56
    DFAAllocator.deinitialize();        // dmd/dfa/fast/structure.d:982
    // dmd/target.d:625 `deinitialize` is DMD's (!IN_LLVM); LDC's `Target::_init` (gen/target.cpp) refills `target`
    // on every compile, except the va_list type it caches over `Type.tchar`
    target._resetVaListCache();

    Module.resetState();
    Module.djsTexts = null;             // the host's text override (src/djs.ts `DjsOptions.texts`), one call's
    resetTypeGlobals();
    // dmd/dclass.d:100-108 `__gshared` ClassDeclarations object.d's declarations fill
    ClassDeclaration.object = ClassDeclaration.throwable = ClassDeclaration.exception = null;
    ClassDeclaration.errorException = ClassDeclaration.cpp_type_info_ptr = null;
    StructDeclaration.xerreq = StructDeclaration.xerrcmp = null;   // dmd/dstruct.d:47-48, object.d's xopEquals/xopCmp
    FuncDeclaration.lastMain = null;    // dmd/func.d:341, the `main` the "only one entry point" error compares with
    TemplateTypeParameter.tdummy = null;            // dmd/dtemplate.d:498
    TemplateValueParameter.edummies = new Map();    // dmd/dtemplate.d:588
    TemplateAliasParameter.sdummy = null;           // dmd/dtemplate.d:648
    TemplateStats.stats = new Map();                // dmd/dtemplate.d:1161, `-vtemplates`
    ErrorExp.errorexp = null;           // dmd/expression.d:694, typed `Type.terror` of the finished compile
    IntegerExp._resetLiteralCache();    // dmd/expression.d:633/:649 literal and createBool singletons
    Identifier.resetGenerators();
    Loc.showColumns = false;            // dmd/location.d:46-47, set by `Loc.set` only after the command line parses
    Loc.messageStyle = MessageStyle.digitalmars;
    _resetTfToHash();
    _resetArrayOpTemplate();
    resetCompilerState();
    resetCtfeGlobals();
    resetDsymbolsemState();
    resetErrorsState();
    resetExpressionsemState();
    resetFuncsemState();
    resetSemantic3State();
    resetTemplatesemState();
    resetTypesemState();
}

// ── the kept-module engine (src/keep.ts; 10 §4.7 "The kept-module engine") ─────────────────────────────────────

keepBind({
    global,
    Module,
    report: reportDiagnosticForKeep,
    printInstantiationTrace: (ti, cl, maxShown) => ti.printInstantiationTrace(cl, maxShown),
    walkInstanceScopes,
    appendToModuleMember: (ti) => { appendToModuleMember(ti); },
    instanceMatch: keptInstanceMatch,
    deferSemantic3,
    // upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool)
    semantic2: (m) => semantic2(m as unknown as Dsymbol, null),
    semantic3: (m) => semantic3(m as unknown as Dsymbol, null),
    suffixCounter: (n) => Identifier.keepSuffixCounter(n),
    purgeLocCounters: (dead, kept) => Identifier.purgeLocCounters(dead, kept),
    dropCtfeGlobals: (kept) => keepDropCtfeGlobals(kept),
    purgeLocFiles,
    resolveModule: (packages, ident) => {
        // dmd/dmodule.d:500-512 `Module.load`'s lookup, through a FileManager of its own (the compile's caches what it
        // read; this asks the file system now)
        const found = new FileManager().lookForSourceFile(getFilename([...packages], ident), global.path.opSlice(),
            { value: 0 });
        return found === null ? null : new TextDecoder().decode(found);
    },
    searchStringImport: (name) => {
        const found = FileName.searchPath(global.filePath.opSlice(), name, false);
        return found === null ? null : new TextDecoder().decode(found);
    },
    addDeferred: (s, pass) => (pass === 2 ? addDeferredSemantic2 : addDeferredSemantic3)(s),
    runDeferredSemantic,
    checkCompiledImport: (m) => {
        // dmd/dmodule.d:783-787, the parse's `checkCompiledImport`: under `-i`, `Compiler.onImport` pushes the module
        // on `compiledImports` and it becomes a root
        if (!m.isRoot() && Compiler.onImport(m))
            m.importedFrom = m;
    },
    objectStatics: (v) => {
        // Probe (02 §11.5c shape 2): the statics are typed non-null where object.d's analysis fills them
        // (resetTypeGlobals writes `undefined!`); the engine empties and refills them as one table
        // each name checked by tsc against its class's statics (`keyof typeof`): a rename fails to compile
        const slot = <C extends object>(c: C, ...keys: (keyof C & string)[]): [object, string][] =>
            keys.map((k) => [c, k]);
        const slots: [object, string][] = [
            ...slot(Type, "dtypeinfo", "typeinfoclass", "typeinfointerface", "typeinfostruct", "typeinfopointer",
                "typeinfoarray", "typeinfostaticarray", "typeinfoassociativearray", "typeinfovector", "typeinfoenum",
                "typeinfofunction", "typeinfodelegate", "typeinfotypelist", "typeinfoconst", "typeinfoinvariant",
                "typeinfoshared", "typeinfowild", "rtinfo", "rtinfoImpl"),
            ...slot(ClassDeclaration, "object", "throwable", "exception", "errorException", "cpp_type_info_ptr"),
            ...slot(StructDeclaration, "xerreq", "xerrcmp"),
            ...slot(Module, "moduleinfo"),
        ];
        const rec = (o: object): Record<string, Dsymbol | null> => o as unknown as Record<string, Dsymbol | null>;
        if (v !== undefined)
            slots.forEach(([o, k], i) => { rec(o)[k] = v[i] ?? (o === Type ? undefined! : null); });
        return slots.map(([o, k]) => rec(o)[k] ?? null);
    },
    preprocess: preprocessForKeep,
    clearTable: (t) => { t.tab = new AssocArray(); },
    // Probe (02 §11.5c shape 2): StringTable's Map is private to root/stringtable.ts; the engine iterates it to
    // drop the types over dropped symbols
    typeTable: () => (Type.stringtable as unknown as { map: Map<string, { value: Type | null }> }).map,
    DYNCAST, PASS, PKG, Sizeok, Taarray: TY.Taarray, ErrorKind, DiagnosticReporting,
});

/**
 * The per-compile part of `deinitializeFrontend`, for a compile that keeps modules (src/keep.ts): what no kept
 * module, instance or type points to. Kept, against `deinitializeFrontend`, and why:
 * - the identifier table (`initTokens` is not run), `Id`, `Type.stringtable` (purged of dead types by the engine),
 *   `Module.modules` (emptied in place by the engine: kept packages are its entries again when registered),
 *   `Package.packageTag` (kept packages and modules hold their tags), the `CTFEExp`
 *   singletons, `Objc`, the Loc file table (purged of dead files): the kept AST points into all of them;
 * - the object.d declarations the frontend remembers when it parses or analyses object.d (`resetTypeGlobals`'s
 *   slots, `ClassDeclaration.object` ..., `StructDeclaration.xerreq`/`xerrcmp`, `Module.moduleinfo`): object.d is
 *   registered and replayed, not parsed and analysed, so the engine empties them and puts each back when its
 *   module is registered (`keepPrepare`); `ErrorExp.errorexp`, the literal cache and the template dummies are
 *   typed over kept types;
 * - `resetTemplatesemState`'s object ids: the kept instance tables hash their arguments with them; its two nest
 *   counters are 0 after any compile that left kept state (an unfinished one drops it);
 * - `resetCtfeGlobals`'s stack: kept globals hold their CTFE values there (`ctfeAdrOnStack`);
 * - `EscapeState`: keyed by variable (escape.ts), a kept variable keeps its `scope` reason;
 * - `global.varSequenceNumber`: dmd/escape.d:2203 orders two variables of one function by it, and a kept function's
 *   variables keep their numbers, so the numbering goes on instead of restarting;
 * - the va_list type cached over `Type.tchar` (kept);
 * - `Dsymbol.commentHashTable`: a kept module is registered, not parsed again, so its symbols' doc comments (the
 *   doc-comment knob, `DjsOptions`) are the ones its parse attached; a WeakMap, an entry goes with its dropped
 *   symbol. Only -D and -X read it, and both are refused by the engine;
 * - generateIdWithLoc's counters and parent ids (dmd/identifier.d:257, `Identifier.resetGenerators` is not run): the
 *   engine purges the keys of dead files and dead parents, and every other key is a kept file's or a kept parent's,
 *   whose analysis replays and generates nothing; a parent made in this compile is a new object, with new keys.
 * The generated-identifier counter restarts at 0 here; the engine adds what each replayed unit consumed.
 */
function resetForKeptCompile(): void {
    clearDiagnostics();
    const varSequenceNumber = global.varSequenceNumber;
    global.deinitialize();              // dmd/globals.d:561
    global.varSequenceNumber = varSequenceNumber;
    const comments = Dsymbol.commentHashTable;
    Dsymbol.deinitialize();             // dmd/dsymbol.d:928, the Ddoc tables
    Dsymbol.commentHashTable = comments;
    DFAAllocator.deinitialize();        // dmd/dfa/fast/structure.d:982
    Module.resetState(true);
    FuncDeclaration.lastMain = null;    // dmd/func.d:341
    TemplateValueParameter.edummies = new Map();    // dmd/dtemplate.d:588, keyed by this compile's types
    TemplateStats.stats = new Map();                // dmd/dtemplate.d:1161
    Identifier.keepSuffixCounter(0);
    Loc.showColumns = false;            // dmd/location.d:46-47
    Loc.messageStyle = MessageStyle.digitalmars;
    resetCompilerState();
    resetDsymbolsemState();
    resetErrorsState();
    resetExpressionsemState();
    resetFuncsemState();
    resetSemantic3State();
    resetTypesemState();
    _resetTfToHash();
    _resetArrayOpTemplate();
}

/**
 * For the host (10 §4.7): drops what `djsMainKept` kept, as a `djsMain` call does, and resets the frontend's
 * statics, which still reach the last compile's AST, so that its memory can be collected now.
 */
export function dropKeptState(): void {
    dropQueryIndex();
    dropKept();
    deinitializeFrontend();
}

export type { KeptCompile };

/**
 * What a host sets besides the command line (10 §4.7). `docComments`: the parser collects doc comments, as `-D`
 * does, for the queries' hovers (`Module.djsDocComments`), with no change to the compile's output; it costs the
 * comments' memory. Part of the kept state's key: a `djsMainKept` call with another value compiles fresh.
 */
export interface DjsOptions {
    docComments?: boolean;
    /**
     * Source texts that replace files' contents for this call: absolute path -> the UTF-8 text of a D source (an
     * editor's buffer, no byte order mark). A module whose source file is the key's file (both resolved against the
     * working directory to their real paths: `/tmp/a.d` and `/private/tmp/a.d` are one) is read from the text instead
     * of the disk (`Module.read`, `Module.djsTextOf`): the root, and the modules `-i` and the import paths reach. The
     * file must exist on disk (a key without one is ignored): module resolution (`FileName.exists`) and the kept
     * engine's record are the file's. String imports (`-J`) and C files (`.c`, `.h`, `.i`) are never
     * overridden. Not part of the kept state's key (`optionsKey`): the kept engine sees an overridden file as a file
     * whose content is the text (THE DEAD SET in src/keep.ts: changed iff its bytes differ from the kept module's
     * `src`), and a module compiled from a text and then read from disk is compared by bytes, never by stat. A key
     * that is not absolute throws (a host error). Cost: one UTF-8 encoding of each text per call.
     */
    texts?: ReadonlyMap<string, string>;
}

/** The kept state's key for `options` (`KeepHost.options`): `texts` is not part of it (see `DjsOptions`). */
function optionsKey(options: DjsOptions): string {
    return options.docComments === true ? "docComments" : "";
}

/**
 * `options.texts` as `Module.djsTexts` holds them: each key by its real path (symbolic links resolved, as
 * `Module.djsTextOf` resolves the files the compile reads; a key whose file does not exist is left out: no module is
 * read from it), each text UTF-8 with the four zero bytes past its end that `FileManager.getFileContents` leaves after
 * a file's bytes (the D lexer's terminating dchar); null when none. Throws on a key that is not absolute.
 */
function sourceTexts(options: DjsOptions): ReadonlyMap<string, Uint8Array> | null {
    if (options.texts === undefined || options.texts.size === 0)
        return null;
    const encoder = new TextEncoder();
    const texts = new Map<string, Uint8Array>();
    for (const [path, text] of options.texts) {
        if (!isAbsolute(path))
            throw new Error(`DjsOptions.texts: the key \`${path}\` is not an absolute path`);
        let real: string;
        try {
            real = realpathSync(path);
        } catch {
            continue;
        }
        const bytes = encoder.encode(text);
        const buffer = new Uint8Array(bytes.length + 4);
        buffer.set(bytes);
        texts.set(real, buffer.subarray(0, bytes.length));
    }
    return texts;
}

export {
    type AstAnswer, type AstEntry, type AstResult, type CompletionAnswer, type CompletionItem, type CompletionKind,
    type CompletionResult, type DeclarationSite, type DefinitionAnswer, type DefinitionResult, type DocumentSymbol,
    type DocumentSymbolsAnswer, type DocumentSymbolsResult, type ExpansionAnswer, type PrepareRenameAnswer,
    type PrepareRenameResult, type ReferenceSite, type ReferencesAnswer, type ReferencesResult, type RenameAnswer,
    type RenameResult, type SignatureHelpAnswer, type SignatureHelpResult, type SignatureInformation,
    type ExpansionKind, type ExpansionResult, type ExpansionSite, type ExpansionSitesAnswer, type ExpansionSitesResult,
    type HoverAnswer, type HoverResult, type ImportModule, type ImportsAnswer, type ImportsResult,
    type InactiveRangesAnswer, type InactiveRangesResult, type InlayHint, type InlayHintsAnswer, type InlayHintsResult,
    type InstanceSite, type InstancesAnswer, type InstancesResult, type QueryMiss, type QueryPosition, type QueryRange,
    type SemanticTokensAnswer, type SemanticTokensResult, type SymbolKindName, type TemplateInstances,
    type UnusedAnswer, type UnusedDeclaration, type UnusedKind, type UnusedResult, type UnusedWhy,
    SEMANTIC_TOKEN_MODIFIERS, SEMANTIC_TOKEN_TYPES, STALE_REASON, queryAst, queryCompletion, queryDefinition,
    queryDocumentSymbols, queryExpansion, queryExpansionSites, queryPrepareRename, queryReferences, queryRename,
    querySignatureHelp, queryUnused,
    queryHover, queryImports, queryInactiveRanges, queryInlayHints, queryInstances, querySemanticTokens,
} from "./query.js";

/**
 * Runs one compilation as `djsMain(args, onFatal, options)` does, keeping the parsed and analysed modules and
 * template instances for the next call (10 §4.7, "The kept-module engine"). A call whose command line equals the
 * previous one's (the root source files excepted) recompiles only what changed: a kept module whose file and role
 * did not change, and every instance and function body over kept code only, replays its recorded analysis instead
 * of running it. Guarantee: status, stdout and stderr (and the diagnostic handler's calls) are those of a fresh
 * compile of the same arguments and files (an overridden file's text, `DjsOptions.texts`, as its content); a call
 * that cannot keep compiles fresh and says why (`mode`, `reason`), a change of `options.docComments` (part of the
 * kept state's key; `texts` is not) among the causes. In a kept compile, the handler is called when the compile
 * ends, in order, with copies of its arguments (the output is buffered so that an abort can discard it); `onFatal` is
 * called where the fatal stop is, and again by the fresh compile that follows an abort. `djsMain` never keeps and
 * drops what this kept. Like `djsMain`, the call drops the query indexes (src/query.ts): the queries (`queryHover`,
 * `queryDefinition`, `querySemanticTokens`) answer on this compile's AST from its end on.
 * Cost: the first call, and every fresh one, is a fresh compile plus recording (memory for the logs); a kept
 * call costs the root's analysis plus the replay of what it requests (a large application: see 10 §4.7).
 */
export function djsMainKept(args: readonly string[], onFatal: FatalErrorHandler = throwFatalError,
    options: DjsOptions = {}): KeptCompile {
    dropQueryIndex();
    const texts = sourceTexts(options);
    const perCall = (fresh: boolean): void => {
        resetDriverState();
        Module.djsDocComments = options.docComments === true;
        Module.djsTexts = texts;     // again: a fresh compile's `deinitializeFrontend` empties it
        if (fresh)
            initTokens();    // tokens.d's module constructor, run before main
        initImphint();       // imphint.d's `shared static this()`
        setFatalErrorHandler(onFatal);
    };
    Module.djsTexts = texts;         // the dead set reads it before the compile's reset
    try {
        return keepCompile(args, {
            resetFresh: () => {
                deinitializeFrontend();
                perCall(true);
            },
            resetKept: () => {
                resetForKeptCompile();
                perCall(false);
            },
            run: () => cppmain(args),
            options: optionsKey(options),
            crashed: (e) => !(e instanceof FatalError) && !(e instanceof UnsupportedFlag),
            escape: finishEscape,
            getHandler: () => diagnosticHandler,
            setHandler: setDiagnosticHandler,
        });
    } finally {
        Module.djsTexts = null;
    }
}

/** What `djsMain` does with an error escaping `cppmain`: the status, after printing what the error calls for. */
function finishEscape(e: unknown): number {
    if (e instanceof FatalError) {
        global.plugErrorSinks();   // dmd/errors.d:823, the rest of `fatal()`
        return 1;                  // EXIT_FAILURE
    }
    if (e instanceof UnsupportedFlag) {
        process.stderr.write(`djs: ${e.message}\n`);
        return EXIT_UNSUPPORTED;
    }
    const text = e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e);
    process.stderr.write(`Internal error: ${text}\n`);
    return 1;
}

/**
 * Runs one compilation as `ldmd2 <args>` would, writing diagnostics to stderr and messages to stdout.
 * Returns: the exit status (10 §4.1): 0 success, 1 errors or a fatal stop, 1 with `Internal error: ` and the
 * stack on stderr for an escaped JS error (an AssertError, a wall, a TypeError), EXIT_UNSUPPORTED (2) with
 * `djs: unsupported flag` on stderr for a refused switch.
 * Any number of calls per process: each starts from `deinitializeFrontend`, so a call compiles as a fresh
 * process would, whatever the previous call did (errors, a fatal stop, an escaped error included).
 *
 * `onFatal` is installed as `fatalErrorHandler` (dmd/errors.d:812) for this call. The default, `throwFatalError`,
 * is the CLI: every `fatal()` stops the compile and the status is 1, as ldc2's `exit(EXIT_FAILURE)`. A host that
 * wants every pass run past a fatal point (an editor: semantic analysis of a module with parse errors) passes a
 * handler that answers true; `fatal()` then returns as D's does (dmd/errors.d:820-821) and the driver goes on with
 * the code that follows each call. Contract for that host (10 §4.7):
 * - the status is 0 when the compile reaches the end of `mars_tryMain` (dmd/main.d:930, `status = EXIT_SUCCESS`
 *   after the `fatal()` on `global.errors`): read `global.errors` (and `global.warnings`), never the status;
 * - the output up to the first fatal point is ldc2's; past it come diagnostics ldc2 never prints, with no oracle:
 *   a failed import reports "unable to read module" twice (its importAll and its semantic each load it), the
 *   error limit (`-verrors`, default 20) prints its line again after every further error unless the host passes
 *   `-verrors=0`;
 * - the args carry `-o-`: past a fatal point an object file would reach the codegen wall (an Internal error);
 * - a failed ImportC file, imported or on the command line (importc.h, the C compiler, its temporary directory, a C
 *   preprocessor that fails), stops at that `fatal()` as the CLI does: status 1, the CLI's output
 *   (driver/cpreprocessor.ts `stopAtFatal`);
 * - known non-returns, each printing the diagnostics up to that point (the list, each entry with its D line and
 *   its probe, is 10 §4.7 "Known non-returns"): an LDC continuation that is undefined behaviour in C++ or runs past
 *   a D assert that LDC's release build compiles out stops with an AssertError (Internal error, status 1); a crash
 *   faithful to LDC, which segfaults at the same point, is an Internal error, status 1; an `LDC_intrinsic` name
 *   with a misplaced `#` loops without end, as LDC does.
 * The handler is called with no arguments; it may count the calls, and may throw `FatalError` to stop the compile.
 * A handler answering false gives D's exit path (dmd/errors.d:823-825): `process.exit(1)` ends the host process.
 * A host answers true or throws `FatalError`.
 *
 * `options`: `DjsOptions`, what a host sets besides the command line (the doc-comment knob, the text override). The
 * call drops the query indexes (src/query.ts): the queries answer on this compile's AST from its end on.
 */
export function djsMain(args: readonly string[], onFatal: FatalErrorHandler = throwFatalError,
    options: DjsOptions = {}): number {
    dropQueryIndex();
    dropKept();          // never keeps (djsMainKept does), and frees what a djsMainKept call kept
    deinitializeFrontend();
    resetDriverState();
    Module.djsDocComments = options.docComments === true;
    Module.djsTexts = sourceTexts(options);
    initTokens();        // tokens.d's module constructor, run before main
    initImphint();       // imphint.d's `shared static this()`
    // dmd/errors.d:825 `fatal()` exits the process; the CLI's handler throws FatalError instead, so the stop is
    // finished below, after the output streams are drained, instead of by `process.exit`.
    setFatalErrorHandler(onFatal);
    try {
        return cppmain(args);
    } catch (e) {
        return finishEscape(e);
    } finally {
        Module.djsTexts = null;
    }
}

/**
 * True when this module is the process entry (`node djs.js ...`), not an import. Never in a worker thread: there
 * `process.argv[1]` is the worker's script, which is this module's file when a bundler inlines djs into it (the VS Code
 * extension's worker.js), and a match would run the CLI with no arguments.
 */
function isProcessEntry(): boolean {
    const script = process.argv[1];
    if (!isMainThread || script === undefined)
        return false;
    try {
        return import.meta.url === pathToFileURL(realpathSync(script)).href;
    } catch {
        return false;   // argv[1] is not a file (a worker's eval, a REPL)
    }
}

if (isProcessEntry()) {
    // ldc2 writes through C stdio, stdout flushed after every message (errors.d:573) and stderr unbuffered, so
    // the two streams interleave in write order. Node writes to a pipe asynchronously on macOS, one queue per
    // stream, and a full pipe reorders them; blocking handles make every write complete in order (10 §4.4).
    // Probe (02 §11.5c shape 2): `_handle` is Node's undeclared libuv handle; a file or TTY stream is already
    // synchronous and may lack `setBlocking`, hence the optional calls.
    for (const s of [process.stdout, process.stderr])
        (s as { _handle?: { setBlocking?: (b: boolean) => void } })._handle?.setBlocking?.(true);
    process.exitCode = djsMain(process.argv.slice(2));
}
