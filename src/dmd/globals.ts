// Ported from dmd/globals.d (module dmd.globals).
//
// Cycle C member (translation-order §2.1 / 01 §4.6): globals ↔ errors ↔ file_manager ↔ utils ↔
// sarif. This module is the DATA hub (Global / Param + the enums); the error-printing functions
// live in errors.ts. To break the value cycle at module-evaluation time:
//   - the types ErrorSink (errorsink.ts, not in this cycle) is a value import (safe).
//   - ErrorSinkCompiler / ErrorSinkNull (errors.ts) are constructed only inside Global._init(),
//     which the shim runs AFTER all modules load (01 §4.3) — so a normal value import is safe.
//   - FileManager (file_manager.ts) is likewise only `new`-ed inside _init().
//   - parseVersionNumber / parseDigits (this module / utils.ts): parseVersionNumber is LOCAL to
//     this module; the SOURCE_DATE_EPOCH parse uses parseDigits from utils.ts (value import).
//   - `export const global = new Global()` is a top-level construction, but Global's constructor
//     only assigns primitive/Array defaults (no cross-module value read) — verified safe (01 §4.5).

import { ds, dsConcat, type DString } from "../dstring.js";
import { Array as DArray } from "./root/array.js";
import { FileName } from "./root/filename.js";
import { OutBuffer } from "./common/outbuffer.js";
import { ErrorSink, ErrorSinkNull } from "./errorsink.js";
import { ErrorSinkCompiler } from "./errors.js";
import { FileManager } from "./file_manager.js";
import type { Identifier } from "./identifier.js";
import type { Triple } from "./target.js";
import { Loc } from "./location.js";
import { K, keepWin } from "../keep.js";
import { CompileEnv } from "./lexer.js";
import { TargetCompiler, SwitchPrefix } from "./targetcompiler.js";
import { parseDigits } from "./utils.js";
import { Edition, CHECKENABLE, CHECKACTION } from "./astenums.js";
import { MessageStyle } from "./location.js";

// resolved: version(IN_LLVM) -> ON (we are LDC; globals.d:34 `enum IN_LLVM = true`, _config.md).
export const IN_LLVM = true;

// resolved: version(IN_LLVM) block (globals.d:36-44). LDC's output-flag enum + member aliases.
// `enum OUTPUTFLAG : int` -> TS numeric enum (02 §4.2). The `alias OUTPUTFLAGno = OUTPUTFLAG.x`
// rebinds are re-exported as bare consts so call sites can read either form (02 §5.3).
export enum OUTPUTFLAG {
    OUTPUTFLAGno,
    OUTPUTFLAGdefault, // for the .o default
    OUTPUTFLAGset, // for -output
}
export const OUTPUTFLAGno = OUTPUTFLAG.OUTPUTFLAGno;
export const OUTPUTFLAGdefault = OUTPUTFLAG.OUTPUTFLAGdefault;
export const OUTPUTFLAGset = OUTPUTFLAG.OUTPUTFLAGset;

/// Defines a setting for how compiler warnings and deprecations are handled (globals.d:50).
/// `enum DiagnosticReporting : ubyte` -> TS numeric enum (02 §4.2).
export enum DiagnosticReporting {
    error, /// generate an error
    inform, /// generate a warning
    off, /// disable diagnostic
}

/**
 * Each flag represents a field that can be included in the JSON output (globals.d:62).
 * `enum JsonFieldFlags : uint` — members are bit flags OR'd together; per 02 §4.2 a flag-enum
 * stays a plain numeric enum here (values are <=32-bit, JS `|`/`&` direct).
 */
export enum JsonFieldFlags {
    none = 0,
    compilerInfo = 1 << 0,
    buildInfo = 1 << 1,
    modules = 1 << 2,
    semantics = 1 << 3,
}

/// Version of C++ standard to support (globals.d:72). `enum CppStdRevision : uint`.
export enum CppStdRevision {
    cpp98 = 1997_11,
    cpp11 = 2011_03,
    cpp14 = 2014_02,
    cpp17 = 2017_03,
    cpp20 = 2020_02,
    cpp23 = 2023_02,
}

/// Trivalent boolean to represent the state of a `revert`able change (globals.d:83).
/// `enum FeatureState : ubyte`. `default_` keeps D's keyword-escape (01 §2.1).
export enum FeatureState {
    default_ = 0, /// Not specified by the user
    disabled = 1, /// Specified as `-revert=`
    enabled = 2, /// Specified as `-preview=`
}

/// Different identifier tables specifiable by CLI (globals.d:91). `enum CLIIdentifierTable : ubyte`.
export enum CLIIdentifierTable {
    default_ = 0, /// Not specified by user
    C99 = 1, /// Tables from C99 standard
    C11 = 2, /// Tables from C11 standard
    UAX31 = 3, /// Tables from the Unicode Standard Annex 31: UNICODE IDENTIFIERS AND SYNTAX
    All = 4, /// The least restrictive set of all other tables
}

/// Specifies the mode for error printing (globals.d:101). `enum ErrorPrintMode : ubyte`.
export enum ErrorPrintMode {
    simpleError, // Print errors without squiggles and carets
    printErrorContext, // Print errors with context (source line and caret)
}

// resolved: version(IN_LLVM) block (globals.d:107-123). LDC linkage / dllimport policy enums.
// `enum LinkonceTemplates : byte` / `enum DLLImport : byte` -> TS numeric enums (02 §4.2).
export enum LinkonceTemplates {
    no, // non-discardable weak_odr linkage
    yes, // discardable linkonce_odr linkage + lazily and recursively define all referenced instantiated symbols in each object file (define-on-declare)
    aggressive, // be more aggressive wrt. speculative instantiations - don't append to module members and skip needsCodegen() culling; rely on define-on-declare.
}

export enum DLLImport {
    none,
    externalOnly, // only symbols from -extI modules
    defaultLibsOnly, // only symbols from druntime/Phobos and -extI modules
    all,
}

/**
 * `extern(C++) struct Output` (globals.d:125) — a VALUE struct (02 §2). `.copy()` clones the
 * primitive/byte-slice fields; `files` (an `Array!(const(char)*)`) and `buffer` (an `OutBuffer*`)
 * are reference fields, shared on copy (03 §2). `OutBuffer* buffer` -> `OutBuffer | null` (02 §10).
 *
 * `const(char)[] dir/name` are byte-slices -> `DString | null`, with `null` as the UNSET state:
 * D's slice truthiness (`if (params.moduleDeps.name)`) tests the slice POINTER, so a null slice is
 * falsy while an empty-non-null one is TRUTHY (06 §2.8). A non-nullable `DString = ds("")` model
 * collapses the two states and makes that test unspellable; `DString | null` reproduces D exactly.
 * `.init` of a slice is null, so both fields default to `null`.
 */
export class Output {
    doOutput = false; // Output is enabled
    fullOutput = false; // Generate comments for hidden declarations (for -HC), and don't strip the bodies of plain (non-template) functions (for -H)

    dir: DString | null = null; // write to directory 'dir'
    name: DString | null = null; // write to file 'name'
    files: DArray<DString> = new DArray<DString>(); // Other files associated with this output, e.g. macro include files for Ddoc, dependencies for makedeps
    buffer: OutBuffer | null = null; // if this output is buffered, this is the buffer
    bufferLines = 0; // number of lines written to the buffer

    /// `.copy()` (03 §2): primitive fields by value, byte-slices shared, reference fields shared.
    copy(): Output {
        const c = new Output();
        c.doOutput = this.doOutput;
        c.fullOutput = this.fullOutput;
        c.dir = this.dir;
        c.name = this.name;
        c.files = this.files; // Array ref — shared (03 §2)
        c.buffer = this.buffer; // class ref — shared (03 §2)
        c.bufferLines = this.bufferLines;
        return c;
    }
}

/// Command line state related to printing usage about other switches (globals.d:140).
/// `extern(C++) struct Help` — a flat bool value struct.
export class Help {
    manual = false; // open browser on compiler manual
    usage = false; // print usage and exit
    // print help of switch:
    mcpu = false; // -mcpu
    transition = false; // -transition
    check = false; // -check
    checkAction = false; // -checkaction
    revert = false; // -revert
    preview = false; // -preview
    externStd = false; // -extern-std
    hc = false; // -HC

    copy(): Help {
        const c = new Help();
        c.manual = this.manual;
        c.usage = this.usage;
        c.mcpu = this.mcpu;
        c.transition = this.transition;
        c.check = this.check;
        c.checkAction = this.checkAction;
        c.revert = this.revert;
        c.preview = this.preview;
        c.externStd = this.externStd;
        c.hc = this.hc;
        return c;
    }
}

/// `extern(C++) struct Verbose` (globals.d:155) — verbose-output state. Value struct.
export class Verbose {
    verbose = false; // verbose compile
    showColumns = false; // print character (column) numbers in diagnostics
    tls = false; // identify thread local variables
    templates = false; // collect and list statistics on template instantiations
    // collect and list statistics on template instantiations origins.
    // TODO: make this an enum when we want to list other kinds of instances
    templatesListInstances = false;
    gc = false; // identify gc usage
    field = false; // identify non-mutable field variables
    complex = true; // identify complex/imaginary type usage
    vin = false; // identify 'in' parameters
    showGaggedErrors = false; // print gagged errors anyway
    logo = false; // print compiler logo
    color = false; // use ANSI colors in console output
    cov = false; // generate code coverage data
    errorPrintMode: ErrorPrintMode = ErrorPrintMode.simpleError; // enum for error printing mode
    messageStyle: MessageStyle = MessageStyle.digitalmars; // style of file/line annotations on messages
    errorLimit = 20;
    errorSupplementLimit = 6; // Limit the number of supplemental messages for each error (0 means unlimited)

    /// (globals.d:177) `uint.max` -> the 32-bit unsigned max 0xFFFF_FFFF (provably-small counter
    /// domain stays `number`, 09 §1.1).
    errorSupplementCount(): number {
        if (this.verbose) return 0xffff_ffff;
        if (this.errorSupplementLimit === 0) return 0xffff_ffff;
        return this.errorSupplementLimit;
    }

    copy(): Verbose {
        const c = new Verbose();
        c.verbose = this.verbose;
        c.showColumns = this.showColumns;
        c.tls = this.tls;
        c.templates = this.templates;
        c.templatesListInstances = this.templatesListInstances;
        c.gc = this.gc;
        c.field = this.field;
        c.complex = this.complex;
        c.vin = this.vin;
        c.showGaggedErrors = this.showGaggedErrors;
        c.logo = this.logo;
        c.color = this.color;
        c.cov = this.cov;
        c.errorPrintMode = this.errorPrintMode;
        c.messageStyle = this.messageStyle;
        c.errorLimit = this.errorLimit;
        c.errorSupplementLimit = this.errorSupplementLimit;
        return c;
    }
}

/// `extern (C++) struct ImportPathInfo` (globals.d:187). `const(char)* path` -> DString (02 §11).
export class ImportPathInfo {
    path: DString = ds(""); // char*'s of where to look for import modules
    isOutOfBinary = false; // Will any module found from this path be out of binary?

    copy(): ImportPathInfo {
        const c = new ImportPathInfo();
        c.path = this.path;
        c.isOutOfBinary = this.isOutOfBinary;
        return c;
    }
}

/**
 * Put command line switches in here (globals.d:193). `extern (C++) struct Param` — a large value
 * struct of compiler options. Reference fields (Array!, Output, Help, Verbose) are shared on copy
 * (03 §2); the nested Output/Help/Verbose value structs are deep-copied via their own `.copy()`.
 *
 * `Edition[const(char)*] editionFiles` is an associative array keyed by a `const(char)*` -> a
 * `Map<DString, Edition>` (02 §9). `const(char)[] argv0/objdir/…` byte-slices -> DString.
 */
export class Param {
    obj = true; // write object file
    readStdin = false; // saw "-" on command line, read source file from stdin
    multiobj = false; // break one object file into multiple ones
    trace = false; // insert profiling hooks
    tracegc = false; // instrument calls to 'new'
    vcg_ast = false; // write-out codegen-ast
    useDeprecated: DiagnosticReporting = DiagnosticReporting.inform; // how use of deprecated features are handled
    useUnitTests = false; // generate unittest code
    useInline = false; // inline expand functions
    release = false; // build release version
    preservePaths = false; // true means don't strip path from source file
    useWarnings: DiagnosticReporting = DiagnosticReporting.off; // how compiler warnings are handled
    cov = false; // generate code coverage data
    covPercent = 0; // 0..100 code coverage percentage required (ubyte)
    ctfe_cov = false; // generate coverage data for ctfe
    ignoreUnsupportedPragmas = true; // rather than error on them
    useModuleInfo = true; // generate runtime module information
    useTypeInfo = true; // generate runtime type information
    useExceptions = true; // support exception handling
    useGC = true; // support features that require the D runtime GC
    betterC = false; // be a "better C" compiler; no dependency on D runtime
    addMain = false; // add a default main() function
    allInst = false; // generate code for all template instantiations
    bitfields = true; // support C style bit fields
    nothrowOptimizations = false; // Allow finally statements that do not throw an Exception
    //                               in try body to rewrite to a sequence.

    cplusplus: CppStdRevision = CppStdRevision.cpp11; // version of C++ standard to support

    help: Help = new Help();
    v: Verbose = new Verbose();

    // Editions
    edition: Edition = Edition.v2023; // edition year (D's default-init is the enum's `.init` == first member == Edition.min == v2023)
    editionFiles: Map<DString, Edition> = new Map(); // Edition corresponding to a filespec

    // Options for `-preview=/-revert=`
    useDIP25: FeatureState = FeatureState.enabled; // implement https://wiki.dlang.org/DIP25
    useDIP1000: FeatureState = FeatureState.default_; // implement https://dlang.org/spec/memory-safe-d.html#scope-return-params
    ehnogc = false; // use @nogc exception handling
    useDIP1021 = false; // implement DIP1021
    fieldwise: FeatureState = FeatureState.default_; // do struct equality testing field-wise rather than by memcmp()
    fixAliasThis = false; // if the current scope has an alias this, check it before searching upper scopes
    rvalueRefParam: FeatureState = FeatureState.default_; // allow rvalues to be arguments to ref parameters
    safer: FeatureState = FeatureState.default_; // safer by default (more @safe checks in unattributed code)
    noSharedAccess: FeatureState = FeatureState.default_; // read/write access to shared memory objects
    previewIn = false; // `in` means `[ref] scope const`, accepts rvalues
    inclusiveInContracts = false; // 'in' contracts of overridden methods must be a superset of parent contract
    shortenedMethods = true; // allow => in normal function declarations
    fixImmutableConv = false; // error on unsound immutable conversion
    fix16997 = true; // fix integral promotions for unary + - ~ operators
    dtorFields: FeatureState = FeatureState.default_; // destruct fields of partially constructed objects
    systemVariables: FeatureState = FeatureState.default_; // limit access to variables marked @system from @safe code
    useFastDFA = false; // Use fast data flow analysis engine

    useInvariants: CHECKENABLE = CHECKENABLE._default; // generate class invariant checks
    useIn: CHECKENABLE = CHECKENABLE._default; // generate precondition checks
    useOut: CHECKENABLE = CHECKENABLE._default; // generate postcondition checks
    useArrayBounds: CHECKENABLE = CHECKENABLE._default; // when to generate code for array bounds checks
    useNullCheck: CHECKENABLE = CHECKENABLE._default; // when to generate code for null dereference checks
    useAssert: CHECKENABLE = CHECKENABLE._default; // when to generate code for assert()'s
    useSwitchError: CHECKENABLE = CHECKENABLE._default; // check for switches without a default
    boundscheck: CHECKENABLE = CHECKENABLE._default; // state of -boundscheck switch

    checkAction: CHECKACTION = CHECKACTION.D; // action to take when bounds, asserts or switch defaults are violated

    dIdentifierTable: CLIIdentifierTable = CLIIdentifierTable.default_;
    cIdentifierTable: CLIIdentifierTable = CLIIdentifierTable.default_;

    argv0: DString = ds(""); // program name
    modFileAliasStrings: DArray<DString> = new DArray<DString>(); // array of char*'s of -I module filename alias strings
    imppath: DArray<ImportPathInfo> = new DArray<ImportPathInfo>(); // array of import path information of where to look for import modules
    fileImppath: DArray<DString> = new DArray<DString>(); // array of char*'s of where to look for file import modules
    objdir: DString | null = null; // .obj/.lib file output directory (D .init null — unset ≠ empty, 06 §2.8)
    objname: DString | null = null; // .obj file output name (D .init null — unset ≠ empty)
    libname: DString | null = null; // .lib file output name (D .init null: json.d:907 prints it as `null`)

    ddoc: Output = new Output(); // Generate embedded documentation comments
    dihdr: Output = new Output(); // Generate `.di` 'header' files
    cxxhdr: Output = new Output(); // Generate 'Cxx header' file
    json: Output = new Output(); // Generate JSON file
    jsonFieldFlags: JsonFieldFlags = JsonFieldFlags.none; // JSON field flags to include
    makeDeps: Output = new Output(); // Generate make file dependencies
    mixinOut: Output = new Output(); // write expanded mixins for debugging
    moduleDeps: Output = new Output(); // Generate `.deps` module dependencies

    debugEnabled = false; // Global -debug flag (no -debug=XXX) is active

    run = false; // run resulting executable
    runargs: DArray<DString> = new DArray<DString>(); // arguments for executable (Strings == Array!(const(char)*))
    cppswitches: DArray<DString> = new DArray<DString>(); // C preprocessor switches
    cpp: DString | null = null; // if not null, then this specifies the C preprocessor

    // Linker stuff
    objfiles: DArray<DString> = new DArray<DString>();
    linkswitches: DArray<DString> = new DArray<DString>();
    linkswitchIsForCC: DArray<boolean> = new DArray<boolean>();
    libfiles: DArray<DString> = new DArray<DString>();
    dllfiles: DArray<DString> = new DArray<DString>();
    deffile: DString | null = null; // D .init null, printed as `null` by json.d:943
    resfile: DString | null = null; // D .init null, printed as `null` by json.d:942
    exefile: DString = ds("");
    mapfile: DString | null = null; // D .init null, printed as `null` by json.d:941

    fullyQualifiedObjectFiles = false; // prepend module names to object files to prevent name conflicts with -od

    // Time tracing
    timeTrace = false; /// Whether profiling of compile time is enabled
    timeTraceGranularityUs = 500; /// In microseconds, minimum event size to report
    timeTraceFile: DString | null = null; /// File path of output file

    // resolved: version(IN_LLVM) block (globals.d:310-352) — driverParams-extracted fields + LDC
    // codegen/PGO/target options. Per _config.md §2: these are LDC frontend bookkeeping fields; the
    // ones holding LLVM codegen payload become `unknown` (no codegen, 09; carried for AST-field fidelity),
    // except `targetTriple`, which the port models (target.ts `Triple`). All KEPT as data fields.
    dll = false; // generate shared dynamic library
    lib = false; // write library file instead of object file(s)
    link = true; // perform link
    oneobj = false; // write one object file instead of multiple ones
    symdebug = 0; // insert debug symbolic information (ubyte)

    bitcodeFiles: DArray<DString> = new DArray<DString>(); // LLVM bitcode files passed on cmdline

    // LDC stuff
    output_ll: OUTPUTFLAG = OUTPUTFLAG.OUTPUTFLAGno;
    output_mlir: OUTPUTFLAG = OUTPUTFLAG.OUTPUTFLAGno;
    output_bc: OUTPUTFLAG = OUTPUTFLAG.OUTPUTFLAGno;
    output_s: OUTPUTFLAG = OUTPUTFLAG.OUTPUTFLAGno;
    output_o: OUTPUTFLAG = OUTPUTFLAG.OUTPUTFLAGno;
    useInlineAsm = false;
    verbose_cg = false;
    cleanupObjectFiles = false;

    // Profile-guided optimization:
    datafileInstrProf: DString | null = null; // Either the input or output file for PGO data

    // target stuff
    // const llvm::Triple*, set by the driver (driver/main.cpp:1239, src/djs.ts `cppmain`); the port's model of it
    // is target.ts `Triple`. null until set: target.ts `targetTriple()` reads it as the host triple.
    targetTriple: Triple | null = null;
    isUClibcEnvironment = false;
    isNewlibEnvironment = false;

    // Codegen cl options
    disableRedZone = false;
    dwarfVersion = 0;

    hashThreshold = 0; // MD5 hash symbols larger than this threshold (0 = no hashing)

    outputSourceLocations = false; // if true, output line tables.

    linkonceTemplates: LinkonceTemplates = LinkonceTemplates.no; // -linkonce-templates

    // Windows-specific:
    dllexport = false; // dllexport ~all defined symbols?
    dllimport: DLLImport = DLLImport.none; // dllimport data symbols not defined in any root module?

    /// (globals.d:355)
    parsingUnittestsRequired(): boolean {
        return this.useUnitTests || this.ddoc.doOutput || this.dihdr.doOutput;
    }
}

// File extension manifest constants (globals.d:361-377). `enum x = "..."` with no member list is a
// manifest constant -> `const` (02 §4.1). Byte-slices -> DString.
export const mars_ext: DString = ds("d"); // for D source files
export const doc_ext: DString = ds("html"); // for Ddoc generated files
export const ddoc_ext: DString = ds("ddoc"); // for Ddoc macro include files
export const dd_ext: DString = ds("dd"); // for Ddoc source files
export const hdr_ext: DString = ds("di"); // for D 'header' import files
export const json_ext: DString = ds("json"); // for JSON files
export const map_ext: DString = ds("map"); // for .map files
export const c_ext: DString = ds("c"); // for C source files
export const h_ext: DString = ds("h"); // for C header source files
export const i_ext: DString = ds("i"); // for preprocessed C source file
// resolved: version(IN_LLVM) -> ON (globals.d:371-377): LDC output-file extensions.
export const ll_ext: DString = ds("ll");
export const mlir_ext: DString = ds("mlir");
export const bc_ext: DString = ds("bc");
export const s_ext: DString = ds("s");

// resolved: version(IN_LLVM) -> ON (globals.d:379-382): `extern (C++, ldc) extern const char*
// dmd_version;`. This is the C++-side DMD-frontend version string LDC links in. In the port there
// is no FFI symbol; it is the version string of the baseline, ldc2-1.43.0 (`based on DMD v2.113.0`).
// parseVersionNumber("v2.113.0") == 2113 == __VERSION__ (verified ldc2 1.43.0, 07 §3.2).
export const dmd_version: DString = ds("v2.113.0");

/**
 * Collection of global compiler settings and global state used by the frontend (globals.d:387).
 * `extern (C++) struct Global` — held only as the single `__gshared global` instance below, so in
 * the port it is a reference object (one instance, mutated in place). `.copy()` is NOT needed for
 * the singleton; `deinitialize()` resets it to a fresh `Global` (matching `this = this.init`).
 */
export class Global {
    inifilename: DString = ds(""); /// filename of configuration file as given by `-conf=`, or default value

    copyright: DString = ds("Copyright (C) 1999-2026 by The D Language Foundation, All Rights Reserved");
    written: DString = ds("written by Walter Bright");

    path: DArray<ImportPathInfo> = new DArray<ImportPathInfo>(); /// Array of path informations which form the import lookup path
    importPaths: DArray<DString> = new DArray<DString>(); /// Array of char*'s which form the import lookup path without metadata
    filePath: DArray<DString> = new DArray<DString>(); /// Array of char*'s which form the file import lookup path

    // dropped: `version (IN_LLVM) {} else { private enum string _version = import("VERSION"); }`
    // (globals.d:395-398) — the non-IN_LLVM branch is dead for us (IN_LLVM ON, _config.md §1); the
    // LDC build takes the version string from `dmd_version` instead.

    datetime: DString = ds(""); /// string returned by asctime() (`char[26]` -> a DString of up to 26 bytes)
    compileEnv: CompileEnv = new CompileEnv();

    params: Param = new Param(); /// command line parameters
    errors = 0; /// number of errors reported so far
    deprecations = 0; /// number of deprecations reported so far
    warnings = 0; /// number of warnings reported so far
    gag = 0; /// !=0 means gag reporting of errors & warnings
    gaggedErrors = 0; /// number of errors reported while gagged
    gaggedDeprecations = 0; /// number of deprecations reported while gagged
    /**
     * No D counterpart: the gagged errors of the gag windows open now (dmd/errors.ts `analysisSeesErrors`, the
     * kept-module engine's `replayUnit`). A gagged report counts here as in `gaggedErrors`, and `startGagging` saves it
     * and `endGagging` restores it, so at gag level 0 it is 0. `gaggedErrors` cannot serve: it also takes the errors of
     * an instance with errors matched ungagged (dmd/templatesem.d:1021-1022), which then stay counted past every
     * window; here a match counts only under gag (templatesem.ts).
     */
    windowErrors = 0;
    /** No D counterpart: `windowErrors` at the start of each open window, innermost last. */
    windowErrorsSaved: number[] = [];

    console: unknown = null; /// opaque pointer to console for controlling text attributes (`void*`, 02 §11)

    // globals.d:419-420 — `Array!Identifier`, the SAME instantiation arraytypes.d:29 aliases as
    // `Identifiers`, so the element type is `Identifier | null` like every other class-element
    // container (08 §3 uniformity — the null model must not depend on which D spelling was used).
    versionids: DArray<Identifier | null> = new DArray<Identifier | null>(); /// command line versions and predefined versions
    debugids: DArray<Identifier | null> = new DArray<Identifier | null>(); /// command line debug versions and predefined versions

    hasMainFunction = false; /// Whether a main function has already been compiled in (for -main switch)
    varSequenceNumber = 1; /// Relative lifetime of `VarDeclaration` within a function, used for `scope` checks

    /// Cache files read from disk. Assigned in `_init` (`new FileManager()`); null until then.
    fileManager: FileManager | null = null;

    // resolved: version(IN_LLVM) -> ON (globals.d:420-428): LDC version strings + inlining flag +
    // mutable recursionLimit (the MARS `else` makes it an `enum` constant; LDC makes it a field).
    ldc_version: DString = ds("");
    llvm_version: DString = ds("");
    gaggedForInlining = false; /// Set for functionSemantic3 for external inlining candidates
    recursionLimit = 500; /// number of recursive template expansions before abort

    errorSink: ErrorSink | null = null; /// where the error messages go (assigned in `_init`)
    errorSinkNull: ErrorSink | null = null; /// where the error messages are ignored (assigned in `_init`)

    // resolved: version(IN_LLVM) -> ON (globals.d:437-440): the `preprocess` hook is
    // `extern (C++) FileName function(FileName, ref const Loc, ref OutBuffer)`. It is set by the
    // driver (out of frontend scope, no ImportC here); carried as a nullable callback field.
    preprocess: ((fn: FileName, loc: Loc, buf: OutBuffer) => FileName) | null = null;

    // nothrow: (globals.d:446) — ERASE (04 §8).

    /**
     * Start ignoring compile errors instead of reporting them (globals.d:459).
     *
     * Used for speculative compilation like `__traits(compiles, XXX)`, but also internally to e.g.
     * try out an `alias this` rewrite without committing to it. Works like a stack: N calls to
     * `startGagging` pair with N calls to `endGagging`.
     * Returns: the current number of gagged errors, to pass back to `endGagging`. Counter domain is
     * `number` (provably small, 10 §3.4 / 09 §1.1).
     */
    startGagging(): number {
        if (K.on) keepWin(1);   // the kept-module engine: a gag window opened inside the running unit
        ++this.gag;
        this.gaggedDeprecations = 0;
        this.windowErrorsSaved.push(this.windowErrors);     // no D counterpart: see `windowErrors`
        return this.gaggedErrors;
    }

    /**
     * Stop gagging, restoring the old gagged state before the most recent `startGagging`
     * (globals.d:473). Returns: true if errors occurred while gagged.
     */
    endGagging(oldGagged: number): boolean {
        if (K.on) keepWin(-1);   // the kept-module engine: the window closes
        const anyErrs = this.gaggedErrors !== oldGagged;
        --this.gag;
        // Restore the original state of gagged errors; set total errors to be original errors + new
        // ungagged errors.
        this.errors -= this.gaggedErrors - oldGagged;
        this.gaggedErrors = oldGagged;
        this.windowErrors = this.windowErrorsSaved.pop()!;  // no D counterpart: see `windowErrors`
        return anyErrs;
    }

    /**
     * Increment the error count to record that an error has occurred in the current context
     * (globals.d:489). An error message may or may not have been printed.
     */
    increaseErrorCount(): void {
        if (this.gag) {
            ++this.gaggedErrors;
            ++this.windowErrors;    // no D counterpart: see `windowErrors`
        }
        ++this.errors;
    }

    /// (globals.d:496) Install the compiler error sinks, file manager, compile-env vendor/version,
    /// and the date/time/timestamp strings. Constructs `ErrorSinkCompiler`/`ErrorSinkNull`/
    /// `FileManager` (cross-module value uses — safe because `_init` runs after module load, 01 §4.3).
    _init(): void {
        this.errorSink = new ErrorSinkCompiler();
        this.errorSinkNull = new ErrorSinkNull();

        this.fileManager = new FileManager();
        this.compileEnv.vendor = TargetCompiler;
        this.compileEnv.switchPrefix = SwitchPrefix;

        // `mixin UseAnsiColors; params.v.color = useAnsiColors();` (globals.d:505-506). The mixin
        // expands to a console-capability probe; for the non-TTY corpus shim there is no ANSI color
        // (10 §3.5 invariant: the pipe has no TTY). Resolve to OFF — matches the shim's pipe target.
        this.params.v.color = false;

        this.compileEnv.versionNumber = Global.parseVersionNumber(this.versionString());

        // `Initialize date, time, and timestamp` (globals.d:518-546). D snapshots the C time string
        // into char[] fields via snprintf("%.6s %.4s", …) etc. The SOURCE_DATE_EPOCH branch parses a
        // UNIX timestamp with `parseDigits` and formats it as `asctime(gmtime(&ct))` — i.e. UTC, so a
        // reproducible build does not depend on the builder's timezone; the wall-clock branch keeps
        // `ctime(&ct)` == `asctime(localtime(&ct))`. Both share asctime's fixed 26-byte layout
        // ("Www Mmm dd hh:mm:ss yyyy\n\0"). For the corpus shim these strings feed __DATE__/__TIME__/
        // __TIMESTAMP__; we build them from JS Date in the C `asctime` byte layout.
        const epoch = Global.readSourceDate();
        // 26-byte "Www Mmm dd hh:mm:ss yyyy\n\0" layout, NUL at [25]
        const p = epoch !== null ? Global.asctimeBytes(epoch, true) : Global.asctimeBytes(new Date(), false);
        this.datetime = p.slice(0, 26);

        // date  = "%.6s %.4s", p+4, p+20  -> "Mmm dd yyyy"   (month+day, space, year)
        // time  = "%.8s",       p+11      -> "hh:mm:ss"
        // tstamp= "%.24s",      p         -> "Www Mmm dd hh:mm:ss yyyy"
        const date = dsConcat(p.slice(4, 10), ds(" "), p.slice(20, 24));
        const time = p.slice(11, 19);
        const timestamp = p.slice(0, 24);
        this.compileEnv.time = time;
        this.compileEnv.date = date;
        this.compileEnv.timestamp = timestamp;
    }

    /**
     * Deinitializes the global state of the compiler (globals.d:547). `this = this.init` resets
     * every field to its default; in the port this means rebuilding from a fresh `Global` and
     * copying its fields back into `this` (preserve object identity for the exported `global`).
     */
    deinitialize(): void {
        const fresh = new Global();
        Object.assign(this, fresh);
    }

    /**
     * Computes the version number __VERSION__ from the compiler version string (globals.d:555).
     * `private static` -> static method; the `version_[1..$]` skip drops the leading 'v'.
     * Counters are `uint` -> `number` (provably small, the result is ~2113). Verified: parses
     * "v2.113.0" -> 2113 (ldc2 1.43.0 probe).
     */
    static parseVersionNumber(version_: DString): number {
        let major = 0;
        let minor = 0;
        let point = false;
        // skip initial 'v'
        for (let k = 1; k < version_.length; k++) {
            const c = version_[k];
            if (0x30 <= c && c <= 0x39) {
                // isdigit ('0'..'9')
                minor = minor * 10 + c - 0x30;
            } else if (c === 0x2e) {
                // '.'
                if (point) break; // ignore everything after second '.'
                point = true;
                major = minor;
                minor = 0;
            } else break;
        }
        return major * 1000 + minor;
    }

    /**
     * Indicate to stateful error sinks that no more errors can be produced (globals.d:589). Used by
     * SARIF-collecting sinks to emit their single report at the end.
     */
    plugErrorSinks(): void {
        global.errorSink?.plugSink();
        global.errorSinkNull?.plugSink();
    }

    /// Returns: the version as the number that would be returned for __VERSION__ (globals.d:598).
    versionNumber(): number {
        return this.compileEnv.versionNumber;
    }

    /// Returns: compiler version string (globals.d:606). resolved: version(IN_LLVM) -> ON —
    /// `toDString(cast(immutable char*) dmd_version)`; `dmd_version` is already a DString here.
    versionString(): DString {
        return dmd_version;
    }

    /// Returns: compiler version as char string (globals.d:622). resolved: version(IN_LLVM) -> ON.
    /// D returns `dmd_version` (a `const(char*)`) -> the DString directly (02 §11).
    versionChars(): DString {
        return dmd_version;
    }

    // ── helpers for _init's date/time construction (no upstream .d source) ───────────────────────

    /// Resolve the SOURCE_DATE_EPOCH override (a UNIX timestamp), or `null` when it is unset — the
    /// caller then falls back to the wall clock. Mirrors globals.d:524-529 (the parseDigits-validated
    /// env override).
    private static readSourceDate(): Date | null {
        const env = process.env["SOURCE_DATE_EPOCH"];
        if (env !== undefined && env.length > 0) {
            const box = { value: 0n };
            // parseDigits!time_t: time_t is a signed 64-bit integer -> bigint domain (09 §1).
            if (parseDigits(box, ds(env), "long")) {
                return new Date(Number(box.value) * 1000);
            }
            // D errors here ("value of environment variable `SOURCE_DATE_EPOCH` should be a valid
            // UNIX timestamp, not: `%s`"); the shim would route that through errorSink. For the
            // date-string build we fall through to the wall clock.
        }
        return null;
    }

    /// Build the C `asctime()` 26-byte layout "Www Mmm dd hh:mm:ss yyyy\n\0" for `ct`, reading the
    /// broken-down time in UTC (`gmtime`, the SOURCE_DATE_EPOCH path) or LOCAL time (`localtime`,
    /// what `ctime` does). asctime pads the day to a leading SPACE for single digits ("Www Mmm  d ...").
    private static asctimeBytes(ct: Date, utc: boolean): DString {
        const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][utc ? ct.getUTCDay() : ct.getDay()];
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const mon = months[utc ? ct.getUTCMonth() : ct.getMonth()];
        const day = String(utc ? ct.getUTCDate() : ct.getDate()).padStart(2, " ");
        const hh = String(utc ? ct.getUTCHours() : ct.getHours()).padStart(2, "0");
        const mm = String(utc ? ct.getUTCMinutes() : ct.getMinutes()).padStart(2, "0");
        const ss = String(utc ? ct.getUTCSeconds() : ct.getSeconds()).padStart(2, "0");
        const yyyy = String(utc ? ct.getUTCFullYear() : ct.getFullYear());
        const s = `${wd} ${mon} ${day} ${hh}:${mm}:${ss} ${yyyy}\n\0`;
        return ds(s);
    }
}

// Because int64_t and friends may be any integral type of the correct size, D explicitly asks for
// the correct integer type to get the correct mangling with dmd (globals.d:635-645). These three
// aliases are the 64-bit integer domain -> `bigint` (09 §1; CTFE/AST integer carrier).
export type dinteger_t = bigint; // alias dinteger_t = ulong;
export type sinteger_t = bigint; // alias sinteger_t = long;
export type uinteger_t = bigint; // alias uinteger_t = ulong;

/// Collection of global state (globals.d:648). `extern (C++) __gshared Global global;` -> a single
/// exported instance. Top-level construction is safe (Global's ctor reads no other cyclic module's
/// value, only sets defaults — 01 §4.5). Cross-module state is wired in `global._init()` by the shim.
export const global: Global = new Global();
