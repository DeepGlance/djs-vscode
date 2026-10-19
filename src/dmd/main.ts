// Ported from dmd/main.d (module dmd.main).
//
// The frontend half of the compiler's entry point: `mars_tryMain`, which LDC's C++ driver (driver/main.cpp
// `cppmain`) calls once the command line is parsed, and the two reconcilers it uses. It reads the sources,
// parses them, runs the semantic passes, reports, and exits; everything after semantic analysis that is
// codegen, linking or an output file the shim does not produce is a marked stop, never a silent skip.
//
// IN_LLVM RESOLUTION (_config.md §2, "Driver/option glue": CASE-BY-CASE). Top-level D declarations:
//   - dropped (!IN_LLVM, main.d:92-169): the C `main` / `_Dmain` entry points. The process entry is
//     src/djs.ts (the port of driver/main.cpp's `main`/`cppmain`).
//   - dropped: the `extern(C++)` declarations of main.d:79-89 have C++ bodies in LDC's driver.
//     `registerPredefinedVersions` is ported in src/djs.ts (driver/main.cpp:997) and imported from there;
//     `codegenModules`, `createStaticLibrary`, `linkObjToBinary`, `deleteExeFile`, `runProgram` are codegen
//     or link and are excluded (11 §3): each is a stop at the point where main.d reaches it.
//   - imported: main.d:78 `import gen.semantic : extraLDCSpecificSemanticAnalysis;` from src/gen/semantic.ts.
//   - ported: `mars_tryMain` (main.d:189), `reconcileCommands` (main.d:1204), `reconcileLinkRunLib`
//     (main.d:1333).
//   - dropped (!IN_LLVM, main.d:1066-1171): `parseCommandlineAndConfig`; ldc2 parses in C++ (src/djs.ts).
//   - dropped (DigitalMars, main.d:1175-1193): the druntime `_d_run_main` / `rt_options` hooks.
//
// FATAL SEMANTICS. `fatal()` (dmd/errors.d:818) ends the process without unwinding, so main.d's `scope(exit)`
// blocks do not run on a fatal stop. The CLI installs a `fatalErrorHandler` that throws `FatalError` itself
// (`throwFatalError`); `mars_tryMain`'s scope-exit work therefore skips a `FatalError` and src/djs.ts finishes
// the stop as dmd/errors.d:823-825 does (plug the sinks, exit 1). Under a host's handler that answers true,
// `fatal()` returns as in D and the passes below go on (10 §4.7), except past a failed ImportC file, which stops
// in every mode (src/driver/cpreprocessor.ts `stopAtFatal`).

import { Module } from "./dmodule.js";
import { K, keepRoot, keepRootParse } from "../keep.js";
import { removeHdrFilesAndFail } from "./dmodule.js";
import { FileType } from "./astenums.js";
import { CHECKACTION, CHECKENABLE } from "./astenums.js";
import { CLIUsage } from "./cli.js";
import { IdentifierCharLookup, IdentifierTable } from "./common/charactertables.js";
import { OutBuffer } from "./common/outbuffer.js";
import { compiledImports, includeImports } from "./compiler.js";
import { createConsole } from "./console.js";
import { FatalError, error, errorSupplemental, fatal, messageNoLoc } from "./errors.js";
import { Expression } from "./expression.js";
import {
    CLIIdentifierTable, DiagnosticReporting, ImportPathInfo, OUTPUTFLAGno, Output, global, hdr_ext,
} from "./globals.js";
import type { Param } from "./globals.js";
import { genhdrfile, moduleToBuffer } from "./hdrgen.js";
import { Id } from "./id.js";
import { Loc, MessageStyle } from "./location.js";
import {
    createModules, flushMixins, generateJson, moduleObjfileToken, moduleWithEmptyMain, printPredefinedVersions,
} from "./mars.js";
import { Objc } from "./objc.js";
import { Array as DArray } from "./root/array.js";
import { CTFloat } from "./root/ctfloat.js";
import { File } from "./root/file.js";
import { FileName } from "./root/filename.js";
import { generateSarifReport } from "./sarif.js";
import { target } from "./target.js";
import type { Target } from "./target.js";
import { readFile, writeFile } from "./utils.js";
import { assert } from "../assert.js";
import { ds, dsToJs } from "../dstring.js";
import type { DString } from "../dstring.js";
import { registerPredefinedVersions } from "../djs.js";
// last: 01 §4.8 — value imports into the sema half of the core SCC.
import { printCtfePerformanceStats } from "./dinterpret.js";
import { initDtemplate, printTemplateStats } from "./dtemplate.js";
import {
    dsymbolSemantic, importAll, runDeferredSemantic, runDeferredSemantic2, runDeferredSemantic3,
    semantic3OnDependencies,
} from "./dsymbolsem.js";
import { semantic2 } from "./semantic2.js";
import { semantic3 } from "./semantic3.js";
import { Type_init } from "./typesem.js";

import type { Modules } from "./arraytypes.js";
import type { Dsymbol } from "./dsymbol.js";
import type { ErrorSink } from "./errorsink.js";
import { writeMakeDeps } from "./deps.js"; // value import last (01 §4.8)
import { gendocfile } from "./doc.js"; // value import last (01 §4.8): main.d's `import dmd.doc;`
// value import last (01 §4.8): main.d:78 `import gen.semantic : extraLDCSpecificSemanticAnalysis;`
import { extraLDCSpecificSemanticAnalysis } from "../gen/semantic.js";

/** EXIT_SUCCESS / EXIT_FAILURE of core.stdc.stdlib. */
const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

/**
 * `m` as the Dsymbol the semantic entry points take. Module IS-A Dsymbol; the cast is needed only because
 * Module.errors (uint) is an audited field-shadow of Dsymbol.errors (bool) (dmodule.ts:168), which breaks
 * structural subtyping (the dsymbolsem.ts `runSemantic` precedent).
 */
function asDsymbol(m: Module): Dsymbol {
    // upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool)
    return m as unknown as Dsymbol;
}

/**
 * DMD's real entry point, as LDC calls it (main.d:189, `extern (C++) int mars_tryMain(ref Param params,
 * ref Strings files)`): reads, parses and analyses every module of `files` with the switches already in
 * `params` (global.params), and reports.
 *
 * Preconditions: `global._init()` has run and `params` is filled from the command line (src/djs.ts, the port
 * of driver/main.cpp `cppmain`), and a `fatalErrorHandler` is installed: the CLI's throws `FatalError` at every
 * `fatal()`; a host's that answers true makes `fatal()` return and the passes go on (10 §4.7).
 * Returns: the process exit status, EXIT_SUCCESS (0) or EXIT_FAILURE (1); EXIT_SUCCESS with `global.errors > 0`
 * when a returning `fatal()` lets the compile reach the end (dmd/main.d:930).
 * Throws: `FatalError` from the CLI's handler (main.d's error checks all end in `fatal()`); an Error carrying a wall
 * or stop marker where main.d reaches codegen, link, or an output the shim does not produce.
 */
export function mars_tryMain(params: Param, files: DArray<DString>): number {
    const libmodules: DString[] = [];   // version (IN_LLVM) `Strings libmodules;`

    let fatalStop = false;
    try {
        return tryMainBody(params, files, libmodules);
    } catch (e) {
        fatalStop = e instanceof FatalError;
        throw e;
    } finally {
        // main.d:206 `scope(exit)`: compilation ended gracefully, not with `fatal`.
        if (!fatalStop) {
            global.plugErrorSinks();

            if (global.errors === 0 && global.params.v.messageStyle === MessageStyle.sarif)
                generateSarifReport(true);
        }
    }
}

/** The body of `mars_tryMain` after its `scope(exit)` (main.d:216-1054). */
function tryMainBody(params: Param, files: DArray<DString>, libmodules: DString[]): number {
    // dropped: main.d:220-224, !IN_LLVM — `target.setTargetBuildDefaults()` and DMD's command-line parse.

    global.compileEnv.previewIn        = params.previewIn;
    global.compileEnv.transitionIn     = params.v.vin;
    global.compileEnv.ddocOutput       = params.ddoc.doOutput;

    switch (global.params.cIdentifierTable) {   // final switch
        case CLIIdentifierTable.C99:
            global.compileEnv.cCharLookupTable = IdentifierCharLookup.forTable(IdentifierTable.C99);
            break;

        case CLIIdentifierTable.C11:
        case CLIIdentifierTable.default_:
            // ImportC is defined against C11, not C23.
            // If it was C23 this needs to be changed to UAX31 instead.
            global.compileEnv.cCharLookupTable = IdentifierCharLookup.forTable(IdentifierTable.C11);
            break;

        case CLIIdentifierTable.UAX31:
            global.compileEnv.cCharLookupTable = IdentifierCharLookup.forTable(IdentifierTable.UAX31);
            break;

        case CLIIdentifierTable.All:
            global.compileEnv.cCharLookupTable = IdentifierCharLookup.forTable(IdentifierTable.LR);
            break;
    }

    switch (global.params.dIdentifierTable) {   // final switch
        case CLIIdentifierTable.C99:
            global.compileEnv.dCharLookupTable = IdentifierCharLookup.forTable(IdentifierTable.C99);
            break;

        case CLIIdentifierTable.C11:
            global.compileEnv.dCharLookupTable = IdentifierCharLookup.forTable(IdentifierTable.C11);
            break;

        case CLIIdentifierTable.UAX31:
            global.compileEnv.dCharLookupTable = IdentifierCharLookup.forTable(IdentifierTable.UAX31);
            break;

        case CLIIdentifierTable.All:
        case CLIIdentifierTable.default_:
            // @@@DEPRECATED_2.119@@@
            // Change the default to UAX31,
            //  this is a breaking change as C99 (what D used for ~23 years),
            //  has characters that are not in UAX31.
            global.compileEnv.dCharLookupTable = IdentifierCharLookup.forTable(IdentifierTable.LR);
            break;
    }

    // dropped: main.d:276-289, !IN_LLVM — `-help` / `-logo`.

    /*
    Prints a supplied usage text to the console and
    returns the exit code for the help usage page.
    */
    const printHelpUsage = (help: DString): number => {
        process.stdout.write(help);   // printf("%.*s", …): the bytes as they are
        return global.errors ? EXIT_FAILURE : EXIT_SUCCESS;
    };

    /*
    Print a message to make it clear when warnings are treated as errors.
    */
    const errorOnWarning = (): void => {
        error(Loc.initial, ds("warnings are treated as errors"));
        errorSupplemental(Loc.initial, ds("Use -wi if you wish to treat warnings only as informational."));
    };

    // In case deprecation messages were omitted, inform the user about it
    const mentionOmittedDeprecations = (): void => {
        if (global.params.v.errorLimit !== 0 &&
            global.deprecations > global.params.v.errorLimit) {
            const omitted = global.deprecations - global.params.v.errorLimit;
            messageNoLoc(ds("%d deprecation warning%s omitted, use `-verrors=0` to show all"),
                omitted, omitted === 1 ? ds("") : ds("s"));
        }
    };

    // main.d:352 — `mixin(generateUsageChecks(["transition", "preview", "revert"]))` under IN_LLVM.
    if (params.help.transition)
        return printHelpUsage(CLIUsage.transitionUsage);
    if (params.help.preview)
        return printHelpUsage(CLIUsage.previewUsage);
    if (params.help.revert)
        return printHelpUsage(CLIUsage.revertUsage);

    // dropped: main.d:360-393, !IN_LLVM — `-man`.

    if (params.v.color)
        global.console = createConsole(process.stderr);   // `core.stdc.stdio.stderr`, a console.ts `FILE`

    // dropped: main.d:398-401, !IN_LLVM — `target.setCPU()`.
    Loc.set(params.v.showColumns, params.v.messageStyle);

    if (global.errors) {
        fatal();
    }
    if (files.length === 0 && !params.readStdin) {
        if (params.jsonFieldFlags) {
            const modules: Modules = new DArray<Module | null>();            // empty
            if (generateJson(modules, global.errorSink!))
                fatal();
            return EXIT_SUCCESS;
        }
        error(Loc.initial, ds("No source files"));   // version (IN_LLVM)
        return EXIT_FAILURE;
    }

    reconcileCommands(params, target);

    registerPredefinedVersions();   // version (IN_LLVM): driver/main.cpp:997

    // Initialization
    target._init(params);
    // the kept-module engine (src/keep.ts): a kept compile keeps these tables, which its kept modules point into
    if (!K.kept) {
        Type_init();
        Id.initialize();
        Module._init();
        Expression._init();
        Objc._init();
        Loc._init();
    }
    // port-only, no D counterpart: the 01 §4.1 lazy `TypeDeduced` class, LAST of the inits (10 §1.5).
    initDtemplate();

    reconcileLinkRunLib(params, files.length, target.obj_ext);
    // dropped: main.d:449-453, CRuntime_Microsoft — `initFPU()`.
    CTFloat.initialize();

    // dropped: main.d:457-461, !IN_LLVM — `addDefaultVersionIdentifiers` (ldc2 registered them above).

    if (params.v.verbose) {
        const buf = new OutBuffer();
        printPredefinedVersions(buf);
        // LDC prints binary/version/config before entering this function.
        process.stdout.write(buf.peekSlice());   // fputs(buf.peekChars(), stdout)
    }

    // Build import search path

    const buildImportPath = (imppath: DArray<ImportPathInfo>, result: DArray<ImportPathInfo>,
        pathsOnlyResult: DArray<DString>): void => {
        const array = new DArray<ImportPathInfo>();
        const pathsOnlyArray = new DArray<DString>();

        for (const entry of imppath) {
            const sink = (p: DString): number => {
                const temp = entry.copy();
                temp.path = p;
                array.push(temp);
                return 0;
            };

            stubForSplitPath(sink, entry.path);
            stubForSplitPath((p) => { pathsOnlyArray.push(p); return 0; }, entry.path);   // appendSplitPath
        }

        result.append(array);
        pathsOnlyResult.append(pathsOnlyArray);
    };

    const buildFileImportPath = (imppath: DArray<DString>, result: DArray<DString>): void => {
        const array = new DArray<DString>();
        for (const path of imppath) {
            stubForSplitPath((p) => { array.push(p); return 0; }, path);   // FileName.appendSplitPath
        }
        result.append(array);
    };

    if (params.mixinOut.doOutput) {
        params.mixinOut.buffer = new OutBuffer();
        // atexit(&flushMixins) is for the exits that skip scope(exit) (mars.d:475-479: fatal() calling exit).
        // djs's fatal() throws FatalError or returns (10 §4.1): both leave through the `finally` below.
    }
    try {   // scope(exit) flushMixins();
        buildImportPath(params.imppath, global.path, global.importPaths);
        buildFileImportPath(params.fileImppath, global.filePath);

        // dropped: main.d:523-534 — `-ftime-trace` (a profiling callee, 11 §2.5); src/djs.ts refuses the flag.

        // Create Modules
        const created = createModules(files.opSlice(), libmodules, params, target, global.errorSink!);
        const modules: Modules = created.modules;
        if (created.err)
            fatal();

        // Read files
        for (const m of modules) {
            m!.read(Loc.initial);
        }
        // the kept-module engine: a kept root module whose file did not change takes the new one's place
        for (let i = 0; K.kept && i < modules.length; i++)
            keepRoot(modules.opIndex(i)!, modules, i);

        const ddocbuf = new OutBuffer();   // buffer for contents of .ddoc files
        let ddocbufIsRead = false;         // set when ddocbuf is filled

        /* Read ddoc macro files named by the DDOCFILE environment variable and command line
         * and concatenate the text into ddocbuf
         */
        const readDdocFiles = (loc: Loc, ddocfiles: DArray<DString>, ddocbuf: OutBuffer): void => {
            for (const file of ddocfiles) {
                if (readFile(loc, file, ddocbuf))
                    fatal();
                // BUG: convert file contents to UTF-8 before use
            }
            ddocbufIsRead = true;
        };

        let anydocfiles = false;
        const ddocOutputText = new OutBuffer();
        {
            // Parse files
            // dropped: main.d:569-570 — time-trace begin/end pair (11 §2.5).
            const filecount = modules.length;
            for (let filei = 0, modi = 0; filei < filecount; filei++, modi++) {
                const m = modules.opIndex(modi)!;
                if (params.v.verbose)
                    messageNoLoc(ds("parse     %s"), m.toChars());
                if (!Module.rootModule)
                    Module.rootModule = m;
                m.importedFrom = m; // m.isRoot() == true

                if (!K.on || !keepRootParse(m))   // the kept-module engine: a kept root is registered, not parsed
                    m.parse();

                // Finalize output filenames. Update if `-oq` was specified (only feasible after parsing).
                if (params.fullyQualifiedObjectFiles && m.md) {
                    m.objfile = m.setOutfilename(params.objname, params.objdir, m.arg,
                        FileName.ext(m.objfile.toString()) ?? ds(""));
                    if (m.docfile.toBool())
                        m.setDocfile();
                    if (m.hdrfile.toBool())
                        m.hdrfile = m.setOutfilename(params.dihdr.name, params.dihdr.dir, m.arg, hdr_ext);
                }

                // version (IN_LLVM), main.d:598-613
                // Set object filename in params.objfiles.
                for (let j = 0; j < params.objfiles.length; j++) {
                    if (params.objfiles.opIndex(j) === moduleObjfileToken(m)) {   // pointer identity (mars.ts)
                        params.objfiles.opIndexAssign(m.objfile.toChars(), j);
                        if (m.filetype !== FileType.dhdr && m.filetype !== FileType.ddoc && params.obj)
                            m.checkAndAddOutputFile(m.objfile);
                        break;
                    }
                }

                if (!params.oneobj || modi === 0 || m.filetype === FileType.ddoc)
                    m.deleteObjFile();

                if (m.filetype === FileType.dhdr) {
                    // Remove m's object file from list of object files
                    for (let j = 0; j < params.objfiles.length; j++) {
                        // `==` on two `const(char)*`: pointer identity; `toChars()` returns the stored slice
                        if (m.objfile.toChars() === params.objfiles.opIndex(j)) {
                            params.objfiles.remove(j);
                            break;
                        }
                    }
                    if (params.objfiles.length === 0)
                        params.link = false;
                }
                if (m.filetype === FileType.ddoc) {
                    anydocfiles = true;
                    if (!ddocbufIsRead)
                        readDdocFiles(m.loc, global.params.ddoc.files, ddocbuf);

                    ddocOutputText.setsize(0);
                    gendocfile(m, ddocbuf.peekSlice(), global.datetime, global.errorSink!, ddocOutputText);

                    if (!writeFile(m.loc, m.docfile.toString(), ddocOutputText.peekSlice()))
                        fatal();

                    // Remove m from list of modules
                    modules.remove(modi);
                    modi--;
                    // Remove m's object file from list of object files
                    for (let j = 0; j < params.objfiles.length; j++) {
                        if (m.objfile.toChars() === params.objfiles.opIndex(j)) {   // pointer identity, as above
                            params.objfiles.remove(j);
                            break;
                        }
                    }
                    if (params.objfiles.length === 0)
                        params.link = false;
                }
            }
        }

        if (anydocfiles && modules.length && (params.oneobj || params.objname)) {
            error(Loc.initial, ds("conflicting Ddoc and obj generation options"));
            fatal();
        }
        if (global.errors)
            fatal();

        if (params.dihdr.doOutput) {
            /* Generate 'header' import files.
             * Since 'header' import files must be independent of command
             * line switches and what else is imported, they are generated
             * before any semantic analysis.
             */
            const buf = new OutBuffer();
            for (const m of modules) {
                if (m!.filetype === FileType.dhdr)
                    continue;
                if (params.v.verbose)
                    messageNoLoc(ds("import    %s"), m!.toChars());

                buf.reset();         // reuse the buffer
                genhdrfile(m!, params.dihdr.fullOutput, buf);
                if (params.dihdr.name !== null && dsToJs(params.dihdr.name) === "-") {
                    process.stdout.write(buf.peekSlice());   // fwrite(buf[].ptr, 1, buf.length, stdout)
                }
                else if (!writeFile(m!.loc, m!.hdrfile.toString(), buf.peekSlice()))
                    fatal();
            }
        }
        if (global.errors)
            removeHdrFilesAndFail(params, modules);

        {
            // dropped: main.d:697-698 — time-trace begin/end pair (11 §2.5).

            // load all unconditional imports for better symbol resolving
            for (const m of modules) {
                if (params.v.verbose)
                    messageNoLoc(ds("importall %s"), m!.toChars());
                importAll(asDsymbol(m!), null);
            }
            if (global.errors)
                removeHdrFilesAndFail(params, modules);

            // dropped: main.d:710-713, !IN_LLVM — `backend_init`.

            // Do semantic analysis
            for (const m of modules) {
                if (params.v.verbose)
                    messageNoLoc(ds("semantic  %s"), m!.toChars());
                dsymbolSemantic(asDsymbol(m!), null);
            }
            // main.d:722-723 — no error check here (upstream's `fatal()` is commented out).
            runDeferredSemantic();
            if (Module.deferred.length) {
                for (let i = 0; i < Module.deferred.length; i++) {
                    const sd = Module.deferred.opIndex(i)!;
                    error(sd.loc, ds("%s `%s` unable to resolve forward reference in definition"), sd.kind(),
                        sd.toPrettyChars());
                }
                // main.d:732 — no `fatal()` here either (commented out upstream).
            }

            // Do pass 2 semantic analysis
            for (const m of modules) {
                if (params.v.verbose)
                    messageNoLoc(ds("semantic2 %s"), m!.toChars());
                semantic2(asDsymbol(m!), null);
            }
            runDeferredSemantic2();
            if (global.errors)
                removeHdrFilesAndFail(params, modules);

            // Do pass 3 semantic analysis
            for (const m of modules) {
                if (params.v.verbose)
                    messageNoLoc(ds("semantic3 %s"), m!.toChars());
                semantic3(asDsymbol(m!), null);
            }
            if (includeImports) {
                // Note: DO NOT USE foreach here because Module.amodules.length can
                //       change on each iteration of the loop
                for (let i = 0; i < compiledImports.length; i++) {
                    const m = compiledImports.opIndex(i)!;
                    assert(m.isRoot());
                    if (params.v.verbose)
                        messageNoLoc(ds("semantic3 %s"), m.toChars());
                    semantic3(asDsymbol(m), null);
                    modules.push(m);
                }
            }
            runDeferredSemantic3();
            if (global.errors)
                removeHdrFilesAndFail(params, modules);

            // main.d:771-774, version (IN_LLVM) (src/gen/semantic.ts)
            extraLDCSpecificSemanticAnalysis(modules);

            // dropped: main.d:775-797, !IN_LLVM — the pragma(inline) / `-inline` scans.

            if (global.warnings)
                errorOnWarning();

            if (global.params.useDeprecated === DiagnosticReporting.inform)
                mentionOmittedDeprecations();

            // Do not attempt to generate output files if errors or warnings occurred
            if (global.errors || global.warnings)
                removeHdrFilesAndFail(params, modules);

            // inlineScan incrementally run semantic3 of each expanded functions.
            // So deps file generation should be moved after the inlining stage.
            const ob = params.moduleDeps.buffer;
            if (ob) {
                for (let i = 1; i < modules.opIndex(0)!.aimports.length; i++)
                    semantic3OnDependencies(modules.opIndex(0)!.aimports.opIndex(i)!);
                runDeferredSemantic3();

                const data = ob.peekSlice();
                if (params.moduleDeps.name) {
                    if (!writeFile(Loc.initial, params.moduleDeps.name, data))
                        fatal();
                    // fix LDC issue #1625
                    params.moduleDeps = new Output();
                }
                else
                    process.stdout.write(data);   // printf("%.*s", …)
            }
        }

        printCtfePerformanceStats();
        printTemplateStats(global.params.v.templatesListInstances, global.errorSink!);

        // Generate output files
        if (params.json.doOutput) {
            if (generateJson(modules, global.errorSink!))
                fatal();
        }
        if (!global.errors && params.ddoc.doOutput) {
            for (const m of modules) {
                if (!ddocbufIsRead)
                    readDdocFiles(m!.loc, global.params.ddoc.files, ddocbuf);

                ddocOutputText.setsize(0);
                gendocfile(m!, ddocbuf.peekSlice(), global.datetime, global.errorSink!, ddocOutputText);

                if (!writeFile(m!.loc, m!.docfile.toString(), ddocOutputText.peekSlice()))
                    fatal();
            }
        }
        if (params.vcg_ast) {
            for (const mod of modules) {
                const buf = new OutBuffer();
                buf.doindent = true;
                moduleToBuffer(buf, params.vcg_ast, mod!);

                // write the output to $(filename).cg
                const cgFilename = FileName.addExt(mod!.srcfile.toString(), ds("cg"));
                File.write(cgFilename, buf.peekSlice());
            }
        }

        if (global.params.cxxhdr.doOutput) {
            const genCppHdrFiles = (_ms: Modules, _eSink: ErrorSink): void => {
                throw new Error("TODO-BODY: genCppHdrFiles (dmd/dtoh.d:60)");
            };
            genCppHdrFiles(modules, global.errorSink!);
        }

        if (global.errors)
            fatal();

        // `!IN_LLVM && driverParams.lib && …` (main.d:878) is false under IN_LLVM.

        if (params.addMain && !global.hasMainFunction) {
            const mainModule = moduleWithEmptyMain();
            modules.push(mainModule);
            if (params.oneobj && modules.length === 1)   // `IN_LLVM &&` is the manifest true
                params.objfiles.insert(0, mainModule.objfile.toChars()); // must be *first* objfile for LDC's oneobj
            else if (!params.oneobj || modules.length === 1)
                params.objfiles.push(mainModule.objfile.toChars());
        }

        // version (IN_LLVM), main.d:894-910 — `-v` prints `GC stats  %dM used, %dM free, %dM total` from the
        // D GC. Its numbers describe ldc2's own heap, which no port reproduces; the line is not printed, so a
        // `-v` run differs from ldc2 by that one line.

        // `codegenModules(modules)` (driver/main.cpp:1298): with `params.obj` false, or no module, its body
        // does nothing; otherwise it generates object files, which the shim cannot.
        if (params.obj && modules.length)
            throw new Error("DJS-ESCALATE(excluded): codegen — codegenModules (driver/main.cpp:1298) at dmd/main.d:912");

        if (global.errors)
            fatal();
        const status = EXIT_SUCCESS;
        if (!params.objfiles.length) {
            if (params.link)
                error(Loc.initial, ds("no object files to link"));
            if (!params.link && params.lib)   // `IN_LLVM &&` is the manifest true
                error(Loc.initial, ds("no object files"));
        }
        else {
            if (params.link)
                throw new Error("DJS-ESCALATE(excluded): link — linkObjToBinary (driver/linker.cpp) at dmd/main.d:943");
            else if (params.lib)
                throw new Error("DJS-ESCALATE(excluded): link — createStaticLibrary (driver/archiver.cpp) at dmd/main.d:945");
            // main.d:947-955 — `-cleanup-obj` deletes the object files the link produced; unreachable here.
            // main.d:966-989 — `-run`: runs the linked program; src/djs.ts refuses `-run`.
        }

        // dropped: main.d:994-1036 — `-ftime-trace` output (a profiling callee, 11 §2.5); refused flag.

        // Output the makefile dependencies
        if (params.makeDeps.doOutput) {
            const buf = new OutBuffer();
            writeMakeDeps(buf, params, params.link, params.lib, target.lib_ext); // dmd/deps.d:68
            const data = buf.peekSlice();
            if (params.makeDeps.name) {
                if (!writeFile(Loc.initial, params.makeDeps.name, data))
                    fatal();
            }
            else
                process.stdout.write(data);   // printf("%.*s", …)
        }

        if (global.warnings)
            errorOnWarning();

        if (global.errors || global.warnings)
            removeHdrFilesAndFail(params, modules);

        return status;
    } finally {
        flushMixins();
    }
}

/**
 * STAND-IN, named per 11 §2.5, for `FileName.splitPath` (dmd/root/filename.d:503), which root/filename.ts
 * does not export (its `appendSplitPath` is a stop). main.d:481-503 builds the import path through it, so
 * without it no run could start. This is a complete transliteration of the D body for this host
 * (version (Posix) and version (OSX) on, Windows off), not a narrowed one: it splits `path` at `:` and, on
 * OSX, at `,`; skips leading whitespace of each piece; drops `"` and `\r`; ends at NUL or ^Z; expands a
 * leading `~/` to `$HOME`; and passes each non-empty piece to `sink`, stopping when `sink` returns non-zero.
 * Effects of the real callee it does NOT reproduce: none known. Its home is root/filename.ts; the record
 * asking the owner to land it there is in the n6-shim report.
 */
function stubForSplitPath(sink: (p: DString) => number, path: DString | null): void {
    if (!path)
        return;

    let p = 0;
    const at = (i: number): number => (i < path.length ? path[i]! : 0);   // the C string's NUL terminator
    let c: number;
    do {
        let home: string | undefined = undefined;
        const buf: number[] = [];
        while (at(p) === 0x20 || (at(p) >= 0x09 && at(p) <= 0x0d)) // skip leading whitespace (isspace)
            ++p;
        for (;; ++p) {
            c = at(p);
            if (c === 0x22)             // '"': toggle inside/outside of string — `instring ^= false`
                continue;
            if (c === 0x2c || c === 0x3a) {   // version (OSX) ',' and version (Posix) ':'
                p++;    // ; cannot appear as part of a
                break;  // path, quotes won't protect it
            }
            if (c === 0x1a || c === 0)  // ^Z means end of file
                break;
            if (c === 0x0d)             // '\r'
                continue;  // ignore carriage returns
            if (c === 0x7e) {           // '~', version (Posix)
                if (home === undefined)
                    home = process.env["HOME"];
                // Expand ~ only if it is prefixing the rest of the path.
                if (!buf.length && at(p + 1) === 0x2f && home !== undefined)
                    buf.push(...new TextEncoder().encode(home));
                else
                    buf.push(0x7e);
                continue;
            }
            buf.push(c);
        }
        if (buf.length) { // if path is not empty
            if (sink(Uint8Array.from(buf)))
                break;
        }
    } while (c);
}

/**
 * Adjusts the switches gathered from the command line and reconciles them, in place (main.d:1204): the
 * `-lib`/`-shared` clash, `-boundscheck`, and the defaults of every `use*` check from `-unittest`,
 * `-release` and `-betterC`.
 */
export function reconcileCommands(params: Param, _target: Target): void {
    // version (IN_LLVM)
    if (params.lib && params.dll)
        error(Loc.initial, ds("cannot mix -lib and -shared"));

    if (params.boundscheck !== CHECKENABLE._default) {
        if (params.useArrayBounds === CHECKENABLE._default)
            params.useArrayBounds = params.boundscheck;
    }

    if (params.useUnitTests) {
        if (params.useAssert === CHECKENABLE._default)
            params.useAssert = CHECKENABLE.on;
    }

    if (params.release) {
        if (params.useInvariants === CHECKENABLE._default)
            params.useInvariants = CHECKENABLE.off;

        if (params.useIn === CHECKENABLE._default)
            params.useIn = CHECKENABLE.off;

        if (params.useOut === CHECKENABLE._default)
            params.useOut = CHECKENABLE.off;

        if (params.useArrayBounds === CHECKENABLE._default)
            params.useArrayBounds = CHECKENABLE.safeonly;

        if (params.useAssert === CHECKENABLE._default)
            params.useAssert = CHECKENABLE.off;

        if (params.useSwitchError === CHECKENABLE._default)
            params.useSwitchError = CHECKENABLE.off;

        if (params.useNullCheck === CHECKENABLE._default)
            params.useNullCheck = CHECKENABLE.off;
    }
    else {
        if (params.useInvariants === CHECKENABLE._default)
            params.useInvariants = CHECKENABLE.on;

        if (params.useIn === CHECKENABLE._default)
            params.useIn = CHECKENABLE.on;

        if (params.useOut === CHECKENABLE._default)
            params.useOut = CHECKENABLE.on;

        if (params.useArrayBounds === CHECKENABLE._default)
            params.useArrayBounds = CHECKENABLE.on;

        if (params.useAssert === CHECKENABLE._default)
            params.useAssert = CHECKENABLE.on;

        if (params.useSwitchError === CHECKENABLE._default)
            params.useSwitchError = CHECKENABLE.on;

        if (params.useNullCheck === CHECKENABLE._default)
            params.useNullCheck = CHECKENABLE.off;
    }

    if (params.betterC) {
        if (params.checkAction !== CHECKACTION.halt)
            params.checkAction = CHECKACTION.C;

        params.useModuleInfo = false;
        params.useTypeInfo = false;
        params.useExceptions = false;
        params.useGC = false;
    }
}

/**
 * Adjusts the link, run and lib switches and reconciles them, in place (main.d:1333): no link without an
 * object file, the executable and object names under `-of`/`-od`, the `-run` conflict (fatal), the library
 * name under `-lib`.
 */
export function reconcileLinkRunLib(params: Param, numSrcFiles: number, obj_ext: DString): void {
    if (!params.obj || params.lib || params.output_o === OUTPUTFLAGno)   // `IN_LLVM &&` is the manifest true
        params.link = false;

    // dropped: main.d:1338-1357, !IN_LLVM — the Windows `-mscrtlib` default.

    if (params.link) {
        params.exefile = params.objname ?? ds("");
        params.oneobj = true;
        if (params.objname) {
            /* Use this to name the one object file with the same
             * name as the exe file.
             */
            params.objname = FileName.forceExt(params.objname, obj_ext);
            /* If output directory is given, use that path rather than
             * the exe file path.
             */
            if (params.objdir) {
                const name = FileName.name(params.objname);
                params.objname = FileName.combine(params.objdir, name);
            }
        }
    }
    else if (params.run) {
        error(Loc.initial, ds("flags conflict with -run"));
        fatal();
    }
    else if (params.lib) {
        params.libname = params.objname;
        params.objname = null;
        // Haven't investigated handling these options with multiobj
        // `if (!IN_LLVM && …)` is false under IN_LLVM.
    }
    else {
        if (params.objname && numSrcFiles) {
            params.oneobj = true;
            // main.d:1397-1398 — the "multiple source files, but only one .obj name" error is commented out.
        }
    }
}
