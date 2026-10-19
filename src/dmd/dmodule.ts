// Ported from dmd/dmodule.d (module dmd.dmodule).
//
// WHOLE-FILE translation (W2/BatchB) — replaces the rung-era header-only partial. Defines
// `Package`, `Module`, `ModuleDeclaration`, `ForeachDg`, and the two module-private helpers
// `getFilename` / `processSource`.
//
// RESOLUTIONS applied (docs/porting):
//   - resolved: version(Windows) OFF / version(Posix) ON (_config.md §1) -> PathSeparator = '/'.
//     The `else static assert(0)` arm is dead. dmodule.d:47-56.
//   - resolved: version(IN_LLVM) ON (we are LDC, _config.md §1). Split KEEP/DROP by content per
//     _config.md §2: FE-shaping IN_LLVM code is KEPT (the objExt selection in the ctor, the
//     preprocessor path in `read`, the `!IN_LLVM &&` fold in `needModuleInfo`, the
//     `llvmForceLogging`/`noModuleInfo` bookkeeping fields); pure codegen payload is DROPPED.
//   - resolved: version(none) OFF (built-in) -> the debug-print block at dmodule.d:1010-1014 is
//     dropped (07 §1.4).
//   - dropped: `void* d_cover_valid` / `void* d_cover_data` (dmodule.d:1051-1052) —
//     `llvm::GlobalVariable*` codegen payload, no codegen (_config.md §2 "AST field holding an
//     LLVM pointer -> DROP").
//   - `void checkAndAddOutputFile(const ref FileName)` (dmodule.d:1045) is a bodiless extern(C++)
//     declaration; its body is LDC's C++ (gen/modules.cpp:71), ported as code here (11 §2.5, bodiless
//     extern(C++)): the output-file collision check that doc.d:71 and main.d:607 call.
//   - dropped: `void initCoverageDataWithCtfeCoverage(uint* data) const` (dmodule.d:1055-1061) —
//     it fills the `_d_cover_data` LLVM global, i.e. exactly the `d_cover_data` pointer dropped
//     above, through a raw `uint*` output buffer. Pure coverage-codegen emission (_config.md §2);
//     with its target global gone there is nothing for it to write into.
//   - dropped: the `else` (non-IN_LLVM) coverage fields `cov`/`covb`/`sfilename`/`hasCDtor`
//     (dmodule.d:1063-1069) — the dead branch of a resolved `version`.
//   - `void* _escapetable` (`Escape*`) — `struct Escape` lives in doc.d; the slot is typed through an
//     `import type` of doc.ts (02 §11.5c #6). dmodule.d declares only the FIELD; its lazy accessor
//     `escapetable(Module)` is doc.d's own (doc.d:634), and the only readers and writers are in doc.d.
//   - `FuncDeclaration findGetMembers(ScopeDsymbol)` is declared in dsymbolsem.d:243, NOT in
//     dmodule.d. The rung-era partial re-homed it here; re-homed free functions are forbidden
//     (04 §6), so it is dropped from this file (it has no consumer in the tree today).
//   - `MacroTable macrotable` -> the ported reference class (dmacro.ts); never copied by value.
//   - `Dsymbol[void*] tagSymTab` (ImportC tag table) -> `Map<object, Dsymbol>` (02 §9).
//   - `__gshared` statics -> `static` class members; `static this`-style `_init`/`deinitialize`
//     -> static methods (01 §5).
//
// `import dmd.cparse;` (dmodule.d:26) is the edge to `CParser`, constructed for a `.c`/`.h`/`.i` module in
// `parseModule` (dmodule.d:802); it is a registration slot (see the note below the imports).
//
// The two `Compiler.*` call sites in `parseModule` (dmodule.d:785 inside `checkCompiledImport`,
// dmodule.d:956 at the tail) are live calls into compiler.ts. The `dmd.timetrace` calls are DROPPED,
// not walled — see the note at their D position.

import { ScopeDsymbol, DSYM, DsymbolTable, Visibility, SearchOpt } from "./dsymbol.js";
import {
    K, keepLoad, keepMiss, keepModuleAsPackage, keepPackage, keepParse, keepParsed, keepPkgMod, keepTree,
    keepWrappingPackage,
} from "../keep.js";
import type { Dsymbol, SearchOptFlags } from "./dsymbol.js";
import type { AggregateDeclaration } from "./aggregate.js";
import { Identifier } from "./identifier.js"; // value: Identifier.isValidIdentifier
import { Loc } from "./location.js"; // value: Loc.initial
import type { Expression } from "./expression.js";
import { PKG, ThreeState, Edition, FileType } from "./astenums.js";
import type { Param } from "./globals.js";
import {
    global, ImportPathInfo, OUTPUTFLAG,
    mars_ext, hdr_ext, c_ext, h_ext, i_ext, dd_ext, doc_ext, bc_ext, ll_ext, s_ext, mlir_ext,
} from "./globals.js";
import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { MacroTable } from "./dmacro.js";
import { FileName } from "./root/filename.js";
import { File } from "./root/file.js";
import { Port } from "./root/port.js";
import { OutBuffer } from "./common/outbuffer.js";
import type { DString } from "../dstring.js";
import { ds, cstr, dsEmpty, dsEquals, dsToJs, dsConcat } from "../dstring.js";
import { toUint8 } from "../numeric.js";
import { assert } from "../assert.js";
import { Array as DArray, reverse } from "./root/array.js";
import type { Strings, Modules, Identifiers, Dsymbols } from "./arraytypes.js";
import { Id } from "./id.js"; // value: Id.core
import type { Visitor } from "./visitor/index.js";
import type { Escape } from "./doc.js";
import { error, errorSupplemental, fatal, messageNoLoc } from "./errors.js";
import { ObjectNotFound } from "./declaration.js";
import { isPackageFileName } from "./file_manager.js";
import { dmdformat } from "./root/dmdformat.js";
import { OS, target } from "./target.js";
// dmodule.d:38 `import dmd.parse;` — a VALUE import (the `new Parser!AST(…)` in `parseModule`,
// dmodule.d:819). parse.js reaches func.js/denum.js, whose top-level `extends` read declaration.js's
// classes; an earlier tree failed 3 suites at collect on this edge (`Class extends value undefined` at
// func.ts:353 / denum.ts:174). It sits LAST, 01 §4.8's canonical position. Measured since: with this edge
// and the compiler.js one below both FIRST, every module under src/ still loads as the first import of
// an empty registry, under vitest and under native Node ESM over the tsc emit, so the position is no
// longer load-bearing. loadorder.test.ts is the proof and the guard, on both loaders: one row per entry
// module, red with the entry's name and the import chain if an edge breaks.
import { Parser } from "./parse.js";
// dmodule.d:25 `import dmd.compiler;` — a VALUE import (`Compiler.onImport` / `Compiler.onParseModule` in
// `parseModule`, dmodule.d:785/:956). compiler.js reaches expression.js and the sema modules
// (expressionsem.js, typesem.js) at its top; LAST like the parse.js edge above, under the same proof.
import { Compiler } from "./compiler.js";
import type { CParser } from "./cparse.js";

// ── `dmd.cparse` THROUGH A REGISTRATION SLOT (01 §4.4 registration-slot inversion) ──
// D imports dmd.cparse at module level (dmodule.d:26) for the one `new CParser!AST(…)` in `parseModule`
// (dmodule.d:802). A value import of cparse.js here, in LAST position, failed loadorder.test.ts on both loaders
// (measured: 5 rows, entries dmd/parse.ts and sema-harness.ts, `TypeError: Class extends value undefined` /
// `ReferenceError: Cannot access 'Parser' before initialization` at cparse.ts:348): with parse.ts as the entry,
// parse → typesem → access → dmodule → cparse runs `class CParser extends Parser` while parse.ts is still
// evaluating. The provider hands its class over instead: cparse.ts ends with `registerCParser(CParser);`, and the
// consuming site fails LOUDLY while the slot is empty, never with a fallback.
// ORDER CONTRACT: only an entry whose module graph contains cparse.js fills the slot; src/djs.ts imports it for
// the process. With the slot empty, the C leg of `parseModule` (a `.c`, `.h` or `.i` module) raises
// `dmodule.parseModule: registerCParser not called (dmd/cparse.d:37)`; the D leg never reads it.
// The registrar is a hoisted function declaration and the slot a `var` with NO initializer, so a provider whose
// body runs before this module's body neither hits a TDZ nor has its registration reset.
var cparserSlot: typeof CParser | undefined; // cparse.d:37 `final class CParser(AST) : Parser!AST`

/// Registration point for the `dmd.cparse` edge described above: cparse.ts hands over its `CParser` class
/// (cparse.d:37). Not a D symbol.
export function registerCParser(ctor: typeof CParser): void {
    cparserSlot = ctor;
}

// resolved: version(Windows) OFF, version(Posix) ON (_config.md §1) -> PathSeparator = '/'.
// dmodule.d:47-56. A D manifest enum of type `char` -> a module-scope byte const (02 §4.1).
const PathSeparator = 0x2f; // '/'

// dmodule.d:58-62 — `version (IN_LLVM) { extern (C++) const(char)* createTempObjectsDir(); }`.
// resolved: version(IN_LLVM) ON, but the declaration is a bodyless `extern (C++)` binding to LDC's
// driver/main.cpp:1114, so no faithful body can ever be produced by porting more D (11 §1, external
// implementation). Its ONE call site (setOutfilename, dmodule.d:592) carries the escalation stub inside the
// branch that reaches it, which no run of the shim enters (see there).

/**
 * Remove generated .di files on error and exit. dmodule.d:64-80.
 *
 * `ref Param params` / `ref Modules modules` are aliases — no `.copy()` at the call site (03 §3.2).
 * Cost/contract: deletes each non-.di module's header file, then `fatal()`, which returns only to a host whose
 * fatal handler answers true (10 §4.7).
 */
export function removeHdrFilesAndFail(params: Param, modules: Modules): void {
    if (params.dihdr.doOutput) {
        // `modules` slots are `Module | null` (08 §3); dmodule.d:71-76 dereferences each with no
        // null test, so every read is `m!`.
        for (const m of modules) {
            if (m!.filetype === FileType.dhdr)
                continue;
            File.remove(m!.hdrfile.toChars());
        }
    }

    fatal();
}

/**
 * Converts a chain of identifiers to the filename of the module. dmodule.d:82-141.
 *
 * Params:
 *  packages = the names of the "parent" packages
 *  ident = the name of the child package or module
 * Returns:
 *  the filename of the child package or module
 *
 * D module-private (dmodule.d:92) — exported so the co-located `dmodule.test.ts` can read it, the
 * same-module-scope reader 01 §2.5 sanctions for a D `private` declaration (its GOOD form names
 * `<name>.test.ts` explicitly). dmodule.d carries NO `unittest` block, so what these drive are
 * 10 §1.6b behavior pins, not ported unittests — 10 §1.7 (the ported-unittest trigger) does not
 * apply to this file and is not the license claimed here.
 */
export function getFilename(packages: Identifier[], ident: Identifier): DString {
    let filename: DString = ident.toString();

    const buf = new OutBuffer();
    const dotmods = new OutBuffer();
    // `auto modAliases = &global.params.modFileAliasStrings;` — address-of a container held by the
    // Param value struct; a TS container is already an object, so `&x` IS the reference (03 §7.2).
    const modAliases = global.params.modFileAliasStrings;

    if (packages.length === 0 && modAliases.length === 0)
        return filename;

    // dmodule.d:103 — nested function -> inner arrow (inherits `this`, captures buf/dotmods) (04 §5).
    const checkModFileAlias = (p: DString): void => {
        /* Check and replace the contents of buf[] with
        * an alias string from global.params.modFileAliasStrings[]
        */
        dotmods.writestring(p);
        // `foreach_reverse (const m; *modAliases)` — descending index loop (06 §2).
        for (let mi = modAliases.length - 1; mi >= 0; mi--) {
            const m = modAliases.opIndex(mi);
            // `const q = strchr(m, '=')` — `m` is a `const(char)*`; in the port a `char*` is a
            // NUL-terminated byte cursor (02 §11.2), so `strchr` is a bounded index search inside
            // the C-string view and the returned pointer is that index. `q - m` is therefore `qi`
            // and `q[1 .. strlen(q)]` is the byte range after '=' up to the NUL.
            const mz = cstr(m);
            const qi = mz.indexOf(0x3d); // '='
            // `assert(q)` — a null `q` means the -I alias had no '='; D asserts it away (10 §2).
            assert(qi >= 0, "assert(q): modFileAliasStrings entry without '=' (dmd/dmodule.d:112)");
            if (dotmods.length() === qi && memcmpEq(dotmods.peekChars(), mz, qi)) {
                buf.setsize(0);
                let rhs = mz.subarray(qi + 1, mz.length);
                if (rhs.length > 0 && (rhs[rhs.length - 1] === 0x2f || rhs[rhs.length - 1] === 0x5c))
                    rhs = rhs.subarray(0, rhs.length - 1); // remove trailing separator
                buf.writestring(rhs);
                break; // last matching entry in ms[] wins
            }
        }
        dotmods.writeByte(0x2e); // '.'
    };

    for (const pid of packages) {
        const p = pid.toString();
        buf.writestring(p);
        if (modAliases.length !== 0) checkModFileAlias(p);
        buf.writeByte(PathSeparator);
    }
    buf.writestring(filename);
    if (modAliases.length !== 0) checkModFileAlias(filename);
    buf.writeByte(0);
    // `buf.extractSlice()[0 .. $ - 1]` — CONSUMES the buffer (08 §13a.2) and drops the NUL we
    // just wrote, leaving the logical string.
    const slice = buf.extractSlice();
    filename = slice.subarray(0, slice.length - 1);

    return filename;
}

/**
 * `memcmp(a, b, n) == 0` over the first `n` bytes of two byte cursors (dmodule.d:113).
 * File-local helper; not a D declaration — the C `memcmp` call it replaces has no port.
 */
function memcmpEq(a: DString, b: DString, n: number): boolean {
    for (let i = 0; i < n; i++)
        if (a[i] !== b[i]) return false;
    return true;
}

/***********************************************************
 * dmd/dmodule.d:145-279 — `extern (C++) class Package : ScopeDsymbol`.
 */
export class Package extends ScopeDsymbol {
    isPkgMod: PKG = PKG.unknown;
    tag = 0;                    // uint — auto incremented tag, used to mask package tree in scopes
    mod: Module | null = null;  // !=null if isPkgMod == PKG.module_

    // `__gshared uint packageTag;` (dmodule.d:154) — a function-static global: ONE counter for the
    // whole process, only ever touched by this constructor (and reset by `Module.resetState`).
    protected static packageTag = 0;

    // dmd/dmodule.d:151 — `final extern (D) this(Loc loc, Identifier ident)`.
    constructor(loc: Loc, ident: Identifier | null) {
        super(loc, ident);
        this.tag = Package.packageTag++;
        this.dsym = DSYM.package_;
    }

    override kind(): DString {
        return ds("package"); // dmd/dmodule.d:159
    }

    /****************************************************
     * dmd/dmodule.d:164-219 — resolve `packages[]` to the symbol table `mod` should be inserted into.
     *
     * Input:
     *      packages[]      the pkg1.pkg2 of pkg1.pkg2.mod
     * Returns:
     *      the symbol table that mod should be inserted into
     * Output:
     *      *pparent        the rightmost package, i.e. pkg2, or NULL if no packages
     *      *ppkg           the leftmost package, i.e. pkg1, or NULL if no packages
     *
     * `Dsymbol* pparent` / `Package* ppkg` are out-pointers -> single-slot boxes (03 §3.3/§7.2);
     * `null` for "caller does not want this output" (access.d:85 passes null for both).
     * `Identifier[] packages` is a D slice and may be NULL (access.d:85) — a null slice iterates
     * zero times in D (06 §2.8), reproduced by the `?? []` below.
     *
     * Precondition: `Module.modules` has been created by `Module._init()`; D dereferences it with
     * no null test, so the port faults at the same place (02 §10.1).
     */
    static resolve(packages: Identifier[] | null, pparent: { value: Dsymbol | null } | null,
                   ppkg: { value: Package | null } | null): DsymbolTable {
        let dst: DsymbolTable = Module.modules!;
        let parent: Dsymbol | null = null;
        //printf("Package::resolve()\n");
        if (ppkg !== null)
            ppkg.value = null;
        for (const pid of packages ?? []) {
            let pkg: Package | null;
            let p = dst.lookup(pid);
            if (p === null && K.on)
                p = keepPackage(dst, pid);   // the kept-module engine: a kept package comes back
            if (p === null) {
                pkg = new Package(Loc.initial, pid);
                dst.insert(pkg);
                if (K.on) keepTree(dst, pid, pkg);   // the kept-module engine: a module tree change
                pkg.parent = parent;
                pkg.symtab = new DsymbolTable();
            } else {
                pkg = p.isPackage();
                assert(pkg !== null, "assert(pkg): Package.resolve (dmd/dmodule.d:194)");
                // It might already be a module, not a package, but that needs
                // to be checked at a higher level, where a nice error message
                // can be generated.
                // dot net needs modules and packages with same name
                // But we still need a symbol table for it
                if (K.on && pkg.isModule() !== null)
                    keepModuleAsPackage(pkg.isModule()!);   // the kept-module engine: a module's table in the tree
                if (pkg.symtab === null)
                    pkg.symtab = new DsymbolTable();
            }
            parent = pkg;
            dst = pkg.symtab!;
            if (ppkg !== null && ppkg.value === null)
                ppkg.value = pkg;
            if (pkg.isModule() !== null) {
                // Return the module so that a nice error message can be generated
                // `*ppkg = cast(Package)p;` — a checked downcast; `Dsymbol.isPackage()` is exactly
                // that test in the port (it matches DSYM.package_ AND DSYM.module_, dsymbol.ts).
                if (ppkg !== null)
                    ppkg.value = p!.isPackage();
                break;
            }
        }

        if (pparent !== null)
            pparent.value = parent;
        return dst;
    }

    /**
     * dmd/dmodule.d:221-241 — checks if `pkg` is a sub-package of this.
     *
     * For example, if this qualifies to 'a1.a2' and pkg - to 'a1.a2.a3', this function returns
     * 'true'. If it is the other way around, or the qualified package paths conflict, it returns
     * 'false'.
     */
    isAncestorPackageOf(pkg: Package | null): boolean {
        if (this === pkg)                              // `this == pkg` — class identity (05 §2)
            return true;
        if (pkg === null || pkg.parent === null)
            return false;
        return this.isAncestorPackageOf(pkg.parent.isPackage());
    }

    override accept(v: Visitor): void {
        v.visitPackage(this);                          // dmd/dmodule.d:243 (13 §2)
    }

    isPackageMod(): Module | null {
        if (this.isPkgMod === PKG.module_) {           // dmd/dmodule.d:248
            return this.mod;
        }
        return null;
    }

    /**
     * dmd/dmodule.d:257-278 — checks for the existence of a package.d to set `isPkgMod`
     * appropriately if `isPkgMod == PKG.unknown`.
     */
    resolvePKGunknown(): void {
        if (this.isModule() !== null)
            return;
        if (this.isPkgMod !== PKG.unknown)
            return;

        const packages: Identifier[] = [];
        // `for (Dsymbol s = this.parent; s; s = s.parent)` — parameter/local walked as a widened
        // cursor named `cur` (02 §10.1). D appends `s.ident`, which it dereferences downstream in
        // `getFilename`, so the slot read is `cur.ident!`.
        for (let cur: Dsymbol | null = this.parent; cur !== null; cur = cur.parent)
            packages.push(cur.ident!);
        reverse(packages);

        const pathThatFoundThis: { value: ImportPathInfo } = { value: new ImportPathInfo() };
        if (Module.find(getFilename(packages, this.ident!), pathThatFoundThis) !== null)
            // `Module.load`'s `pathInfo` is a BY-VALUE `ImportPathInfo` parameter (dmodule.d:498),
            // so the copy is emitted at this call site (03 §1 #2/§3.1). `ImportPathInfo` is not in
            // the §9.1 alias-safe register, so the copy is not licensed to be elided.
            Module.load(Loc.initial, packages, this.ident!, pathThatFoundThis.value.copy());
        else {
            this.isPkgMod = PKG.package_;
            if (K.on) keepPkgMod(this);   // the kept-module engine: a module tree change
        }
    }
}

/***********************************************************
 * dmd/dmodule.d:283-1094 — `extern (C++) final class Module : Package`.
 */
export class Module extends Package {
    static rootModule: Module | null = null;
    // `__gshared DsymbolTable modules;` (dmodule.d:286) — a class reference whose `.init` is null
    // (09 §1.0); `_init()` fills it, `deinitialize()` resets it. Every reader dereferences it with
    // no null test, exactly as D does, so use sites carry `!` (02 §10.1).
    static modules: DsymbolTable | null = null;         // symbol table of all modules
    static amodules: Modules = new DArray<Module | null>();     // array of all modules
    static deferred: Dsymbols = new DArray<Dsymbol | null>();   // deferred Dsymbol's needing semantic()
    static deferred2: Dsymbols = new DArray<Dsymbol | null>();  // deferred Dsymbol's needing semantic2()
    static deferred3: Dsymbols = new DArray<Dsymbol | null>();  // deferred Dsymbol's needing semantic3()
    /**
     * No D counterpart: the djs host's doc-comment knob (10 §4.7, "Queries"). True makes `parse` hand the D parser
     * `doDocComment` as `-D` does (`cast(bool) docfile`, dmd/dmodule.d:819), so the lexer collects doc comments and
     * the parser attaches them (`Dsymbol.comment`), without -D's other effects (the `D_Ddoc` version, parsed
     * unittest blocks, the Ddoc file). The lexer only collects comments with it (dmd/lexer.d:738-870): no
     * diagnostic and no analysis changes. Under `-X` it does nothing: the JSON output prints the comments it finds
     * (dmd/json.d), and ldc2 without -D collects none. Set by src/djs.ts on every call from the host's `DjsOptions`.
     */
    static djsDocComments = false;
    /**
     * No D counterpart: the djs host's text override (10 §4.7, `DjsOptions.texts`): a file's real path (symbolic links
     * resolved) -> the bytes of a D source that replace its file's for one call (an editor's buffer, UTF-8, shaped as
     * `FileManager.getFileContents` returns a file: four zero bytes past the end). Read by `read` and, between
     * compiles, by the kept-module engine's dead set (src/keep.ts). Set by src/djs.ts for the call and null outside
     * one (`deinitializeFrontend` empties it too).
     */
    static djsTexts: ReadonlyMap<string, DString> | null = null;
    /** `djsTextOf`'s real paths, per `djsTexts` table (one per call): path as given -> real path, null if none. */
    private static djsRealPaths = new WeakMap<ReadonlyMap<string, DString>, Map<string, string | null>>();

    /**
     * The override of the D source `path` (`djsTexts`; `path` resolved against the working directory to its real
     * path, `/tmp` and `/private/tmp` alike, cached for the call), or null: no override, a path that does not exist,
     * or a C file (`.c`, `.h`, `.i`), whose text is the preprocessor's. Cost: one `realpath` per path and call.
     */
    static djsTextOf(path: string): DString | null {
        const texts = Module.djsTexts;
        if (texts === null || /\.[chi]$/.test(path))
            return null;
        let real = Module.djsRealPaths.get(texts);
        if (real === undefined) {
            real = new Map();
            Module.djsRealPaths.set(texts, real);
        }
        let found = real.get(path);
        if (found === undefined) {
            try {
                found = realpathSync(resolvePath(path));
            } catch {
                found = null;   // no such file: module resolution reports it, no text stands for it
            }
            real.set(path, found);
        }
        return found === null ? null : texts.get(found) ?? null;
    }

    static _init(): void {
        Module.modules = new DsymbolTable();            // dmd/dmodule.d:292
    }

    /**
     * dmd/dmodule.d:297-306 — deinitializes the global state of the compiler. This can be used to
     * restore the state set by `_init` to its original state.
     * `modules = modules.init` — the `.init` of a class reference is null (09 §1.0).
     */
    static override deinitialize(): void {
        Module.modules = null;
    }

    static moduleinfo: AggregateDeclaration | null = null;   // dmd/dmodule.d:308

    /**
     * No D counterpart: the djs driver's reset between two compiles in one process (src/djs.ts
     * `deinitializeFrontend`), next to `deinitialize`, which clears only `modules`. Puts back the load-time
     * value of the other `__gshared` statics (dmd/dmodule.d:285-290, :308): the root module, the list of every
     * module, the three deferred-semantic queues and object.d's ModuleInfo; then the package tag counter
     * (dmd/dmodule.d:154) and the output-file registry (gen/modules.cpp:72), so tags and files restart as in a fresh
     * process. `kept` (a compile of the kept-module engine, src/keep.ts) keeps object.d's ModuleInfo, which the
     * engine takes back with the other object.d statics, and the tag counter: kept modules and packages hold their
     * tags, and a restarted counter would give new packages theirs.
     */
    static resetState(kept = false): void {
        Module.rootModule = null;
        Module.amodules.setDim(0);
        Module.deferred.setDim(0);
        Module.deferred2.setDim(0);
        Module.deferred3.setDim(0);
        if (!kept) {
            Module.moduleinfo = null;
            Package.packageTag = 0;
        }
        Module.outputFiles.clear();
    }

    // dmd/dmodule.d:310-330 — instance fields. `const(char)[]`/`const(ubyte)[]` -> DString /
    // Uint8Array (02 §11); the four `FileName` fields are VALUE structs, default-constructed by D,
    // so they are born as an empty FileName (whose `toBool()` is false, matching D's null `str`).
    arg: DString = dsEmpty;               // original argument name
    md: ModuleDeclaration | null = null;  // if !=null, the contents of the ModuleDeclaration declaration
    srcfile: FileName = new FileName(dsEmpty);   // input source file (D `const FileName`)
    objfile: FileName = new FileName(dsEmpty);   // output .obj file
    hdrfile: FileName = new FileName(dsEmpty);   // 'header' file
    docfile: FileName = new FileName(dsEmpty);   // output documentation file
    src: DString | null = null;           /// Raw content of the file (`const(ubyte)[]`)
    // `Module.errors: uint` (count of errors in file) SHADOWS `Dsymbol.errors: bool` ("failed
    // semantic") — different type, separate storage in D (02 §11.5; same shape as
    // AggregateDeclaration.deferred, aggregate.ts:161). Identifier kept verbatim (01 §2); TS
    // forbids the incompatible re-declaration, so the mismatch is localized and audited here.
    // @ts-expect-error D field shadowing: Module.errors (uint) hides Dsymbol.errors (bool).
    errors = 0;                // uint — if any errors in file
    numlines = 0;              // uint — number of lines in source file
    filetype: FileType = FileType.d;     // source file type (enum `.init` == FIRST member, 09 §1.0)
    hasAlwaysInlines = false;  // contains references to functions that must be inlined
    isPackageFile = false;     // if it is a package.d
    edition: Edition = Edition.v2023;    // language edition (enum `.init` == FIRST member, 09 §1.0)
    pkg: Package | null = null;          // if isPackageFile, the Package that contains this package.d
    contentImportedFiles: Strings = new DArray<DString>(); // files whose content was imported
    needmoduleinfo = 0; // int
    private selfimports: ThreeState = ThreeState.none;
    private rootimports: ThreeState = ThreeState.none;
    /// ImportC: tag symbols that conflict with other symbols used as the index (`Dsymbol[void*]`).
    tagSymTab: Map<object, Dsymbol> = new Map();

    // D `private OutBuffer defines;` (dmodule.d:330) — a value struct, default-constructed. Touched
    // by the sibling-visible `read`, and by `parseModule`; class-local, so TS `private` is correct.
    private defines: OutBuffer = new OutBuffer();  // collect all the #define lines here

    /*************************************
     * dmd/dmodule.d:333-348 — return true if module imports itself.
     */
    selfImports(): boolean {
        //printf("Module::selfImports() %s\n", toChars());
        if (this.selfimports === ThreeState.none) {
            // `amodules` slots are `Module | null` (08 §3); dmodule.d:341-345 dereferences each with
            // no null test, so every read is `m!`.
            for (const m of Module.amodules) m!.insearch = false;
            this.selfimports = this.imports(this) ? ThreeState.yes : ThreeState.no;
            for (const m of Module.amodules) m!.insearch = false;
        }
        return this.selfimports === ThreeState.yes;
    }

    /*************************************
     * dmd/dmodule.d:350-373 — return true if module imports root module.
     */
    rootImports(): boolean {
        //printf("Module::rootImports() %s\n", toChars());
        if (this.rootimports === ThreeState.none) {
            for (const m of Module.amodules) m!.insearch = false;
            this.rootimports = ThreeState.no;
            for (const m of Module.amodules) {
                if (m!.isRoot() && this.imports(m!)) {
                    this.rootimports = ThreeState.yes;
                    break;
                }
            }
            for (const m of Module.amodules) m!.insearch = false;
        }
        return this.rootimports === ThreeState.yes;
    }

    searchCacheIdent: Identifier | null = null;   // dmd/dmodule.d:375
    searchCacheSymbol: Dsymbol | null = null;     // cached value of search
    searchCacheFlags: SearchOptFlags = 0;         // cached flags
    insearch = false;

    isExplicitlyOutOfBinary = false; // Is this module known to be out of binary, and must be DllImport'd?

    /**
     * dmd/dmodule.d:382-389 — a root module is one that will be compiled all the way to object
     * code. This field holds the root module that caused this module to be loaded. If this module
     * is a root module, then it will be set to `this`. This is used to determine ownership of
     * template instantiation.
     */
    importedFrom: Module | null = null;

    decldefs: Dsymbols | null = null;         // top level declarations for this Module (`Dsymbols*`)

    aimports: Modules = new DArray<Module | null>();  // all imported modules

    debugids: Identifiers | null = null;      // debug identifiers (`Identifiers*`)
    debugidsNot: Identifiers | null = null;   // forward referenced debug identifiers

    versionids: Identifiers | null = null;    // version identifiers
    versionidsNot: Identifiers | null = null; // forward referenced version identifiers

    macrotable: MacroTable = new MacroTable(); // document comment macros
    // `void* _escapetable;` — document comment escapes (`Escape*`), allocated lazily by doc.d's
    // `escapetable(Module)` (doc.d:634).
    _escapetable: Escape | null = null;

    nameoffset = 0;          // size_t — offset of module name from start of ModuleInfo
    namelen = 0;             // size_t — length of module name in characters

    /**
     * dmd/dmodule.d:407-466 — `extern (D) this(Loc loc, const(char)[] filename, Identifier ident,`
     * int doDocComment, int doHdrGen), plus the delegating four-parameter overload (dmodule.d:468)
     * which only defaults `loc` to `Loc.initial`; the two
     * collapse by ARITY into one ctor with a leading `loc` (04 §1A).
     */
    constructor(loc: Loc, filename: DString, ident: Identifier | null, doDocComment: number,
                doHdrGen: number) {
        super(loc, ident);
        this.dsym = DSYM.module_;
        let srcfilename: DString;
        //printf("Module::Module(filename = '%.*s', ident = '%s')\n", ...);
        this.arg = filename;
        srcfilename = FileName.defaultExt(filename, mars_ext);
        if (target.run_noext && global.params.run &&
            FileName.ext(filename) === null &&
            FileName.exists(srcfilename) === 0 &&
            FileName.exists(filename) === 1)
        {
            FileName.free(srcfilename);
            srcfilename = FileName.sansExt(filename);
        }
        else if (!FileName.equalsExt(srcfilename, mars_ext) &&
                 !FileName.equalsExt(srcfilename, hdr_ext) &&
                 !FileName.equalsExt(srcfilename, c_ext) &&
                 !FileName.equalsExt(srcfilename, h_ext) &&
                 !FileName.equalsExt(srcfilename, i_ext) &&
                 !FileName.equalsExt(srcfilename, dd_ext))
        {
            error(loc, ds("%s `%s` source file name '%.*s' must have .%.*s extension"),
                  this.kind(), this.toPrettyChars(),
                  srcfilename.length, srcfilename,
                  mars_ext.length, mars_ext);
            fatal();
        }

        this.srcfile = new FileName(srcfilename);
        // resolved: version(IN_LLVM) ON (_config.md §1) — the LDC output-extension selection is
        // FE-shaping (it decides `objfile`), so it is KEPT; the `else` DMD arm is the dead branch.
        // `const(char)[] objExt;` is a D slice: `.init` is null, and `if (objExt)` is a POINTER test
        // (06 §2.8).
        let objExt: DString | null = null;
        // `if (global.params.output_o)` etc. — OUTPUTFLAG is an enum in a boolean context, so the
        // test is made explicit against the enum's zero member (09 §9.1).
        if (global.params.output_o !== OUTPUTFLAG.OUTPUTFLAGno)
            objExt = target.obj_ext;
        else if (global.params.output_bc !== OUTPUTFLAG.OUTPUTFLAGno)
            objExt = bc_ext;
        else if (global.params.output_ll !== OUTPUTFLAG.OUTPUTFLAGno)
            objExt = ll_ext;
        else if (global.params.output_s !== OUTPUTFLAG.OUTPUTFLAGno)
            objExt = s_ext;
        else if (global.params.output_mlir !== OUTPUTFLAG.OUTPUTFLAGno)
            objExt = mlir_ext;

        if (objExt !== null)
            // dependency signature (11 §1, and 06 §2.8 "KEEPER's ported field has collapsed the
            // distinction"): `global.params.objname`/`objdir` are `DString = ds("")` in globals.ts
            // where D's `const(char)[]` `.init` is null, so `setOutfilename`'s `if (name)` test
            // takes the true branch here where D takes the false one. UNREACHABLE today: this arm
            // needs one of `global.params.output_*` set, which only the (unported) driver does.
            this.objfile = this.setOutfilename(global.params.objname, global.params.objdir, filename, objExt);
        if (doDocComment !== 0)
            this.setDocfile();
        if (doHdrGen !== 0)
            this.hdrfile = this.setOutfilename(global.params.dihdr.name, global.params.dihdr.dir, this.arg, hdr_ext);

        this.edition = global.params.edition;
    }

    /**
     * dmd/dmodule.d:473-481 — the two `create` overloads. `create(const(char)* filename, …)` only
     * `.toDString`s and forwards to `create(const(char)[] filename, …)`; a `const(char)*` IS a
     * DString in the port (02 §11), so the pair collapses into this one factory (04 §1A).
     *
     * NOTE the name collides with the inherited `Dsymbol.create(Identifier)`: in D these are two
     * unrelated static factories (statics never dispatch virtually; the derived one hides the base).
     */
    static override create(filename: DString, ident: Identifier | null, doDocComment: number,
                           doHdrGen: number): Module {
        return new Module(Loc.initial, filename, ident, doDocComment, doHdrGen);
    }

    /**
     * dmd/dmodule.d:483-491 — look for the source file.
     * `out ImportPathInfo pathThatFoundThis` -> a single-slot box, RESET on entry (03 §3.3).
     * Returns the found path, or null when the lookup did not change `filename`.
     */
    static find(filename: DString, pathThatFoundThis: { value: ImportPathInfo }): DString | null {
        pathThatFoundThis.value = new ImportPathInfo();   // D default-initializes an `out` param
        const whichPathFoundThis: { value: number } = { value: 0 }; // `ptrdiff_t whichPathFoundThis;`
        const ret = global.fileManager!.lookForSourceFile(filename, global.path.opSlice(), whichPathFoundThis);

        if (whichPathFoundThis.value >= 0)
            // struct read out of an array element then stored -> `.copy()` (03 §1 #4/#5).
            pathThatFoundThis.value = global.path.opIndex(whichPathFoundThis.value).copy();
        return ret;
    }

    /**
     * dmd/dmodule.d:493-496 — `extern (C++) static Module load(Loc loc, Identifiers* packages, Identifier ident)`.
     * Form B (04 §1B): the overload set splits on the SECOND parameter's type (`Identifiers*` vs
     * `Identifier[]`), so the C++ container form is renamed and the D slice form keeps `load`.
     */
    static loadFromIdentifiers(loc: Loc, packages: Identifiers | null, ident: Identifier): Module | null {
        // `packages ? (*packages)[] : null` — the whole-container slice, or a null slice.
        // `Identifiers` slots are `Identifier | null` (08 §3); `getFilename` dereferences each, so
        // the reads are `!`.
        return Module.load(loc, packages !== null ? packages.opSlice().map((x) => x!) : null, ident);
    }

    /**
     * dmd/dmodule.d:498-537 — `extern (D) static Module load(Loc loc, Identifier[] packages, Identifier ident,`
     * ImportPathInfo pathInfo = ImportPathInfo.init).
     */
    static load(loc: Loc, packages: Identifier[] | null, ident: Identifier,
                pathInfo: ImportPathInfo = new ImportPathInfo()): Module | null {
        //printf("Module::load(ident = '%s')\n", ident.toChars());
        // Build module filename by turning:
        //  foo.bar.baz
        // into:
        //  foo\bar\baz
        let filename: DString = getFilename(packages ?? [], ident);
        // Look for the source file
        const importPathThatFindUs: { value: ImportPathInfo } = { value: new ImportPathInfo() };
        // `if (const result = find(filename, importPathThatFindUs))` — declaration in a condition,
        // hoisted to a const and tested for non-null (06 §2.6/§2.8).
        const result = Module.find(filename, importPathThatFindUs);
        if (result !== null) {
            filename = result; // leaks
            pathInfo = importPathThatFindUs.value.copy();  // by-value param store (03 §1 #1)
        }
        // `pathInfo` is written but never read again in D — dmodule.d:516 records the TODO
        // ("apply import path information (pathInfo) on to module"). Kept verbatim.
        void pathInfo;
        // the kept-module engine: a kept module of this file and name is registered instead of read and parsed
        const kept = K.on ? keepLoad(packages, ident, filename, loc) : null;
        if (kept !== null)
            return kept;

        let m: Module | null = new Module(loc, filename, ident, 0, 0);

        // TODO: apply import path information (pathInfo) on to module
        m.isExplicitlyOutOfBinary = importPathThatFindUs.value.isOutOfBinary;

        if (!m.read(loc)) {
            if (K.on && result === null) keepMiss(packages ?? [], ident);   // the kept-module engine: no such module
            return null;
        }
        if (global.params.v.verbose) {
            const buf = new OutBuffer();
            for (const pid of packages ?? []) {
                buf.writestring(pid.toString());
                buf.writeByte(0x2e); // '.'
            }
            buf.printf(ds("%s\t(%s)"), ident.toChars(), m.srcfile.toChars());
            // `message("import    %s", …)` — the no-location overload (errors.d) -> messageNoLoc.
            messageNoLoc(ds("import    %s"), buf.peekChars());
            if (!loc.opEquals(Loc.initial))                 // `loc != Loc.initial` (05 §2)
                messageNoLoc(ds("(imported from %s)"), loc.toChars());
        }
        m = m.parse();
        if (m === null) return null;

        return m;
    }

    override kind(): DString {
        return ds("module");                                // dmd/dmodule.d:539
    }

    /*********************************************
     * dmd/dmodule.d:544-609 — combines things into the output file name for .html and .di files.
     * Input:
     *      name    Command line name given for the file, NULL if none
     *      dir     Command line directory given for the file, NULL if none
     *      arg     Name of the source file
     *      ext     File name extension to use if 'name' is NULL
     *      global.params.preservePaths     get output path from arg
     *      srcfile Input file - output file name must not match input file
     */
    setOutfilename(name: DString | null, dir: DString | null, arg: DString, ext: DString): FileName {
        let docfilename: DString;
        if (name !== null) {                                // `if (name)` — slice POINTER test (06 §2.8)
            docfilename = name;
        } else {
            let argdoc: DString;
            if (global.params.preservePaths)
                argdoc = arg;
            else
                argdoc = FileName.name(arg);

            if (global.params.fullyQualifiedObjectFiles) {
                const fqn = this.md !== null ? this.md.toString() : this.toString();
                argdoc = FileName.replaceName(argdoc, fqn);

                // add ext, otherwise forceExt will make nested.module into nested.<ext>
                const bufferLength = argdoc.length + 1 + ext.length + /* null terminator */ 1;
                const s = new Uint8Array(bufferLength);     // `char[] s = new char[bufferLength];`
                s.set(argdoc.subarray(0, argdoc.length), 0); // `s[0 .. argdoc.length] = argdoc[];`
                s[argdoc.length] = 0x2e;                    // '.'
                s.set(ext, bufferLength - 1 - ext.length);  // `s[$-1-ext.length .. $-1] = ext[];`
                s[bufferLength - 1] = 0;                    // `s[$-1] = 0;`
                argdoc = s;
            }
            // If argdoc doesn't have an absolute path, make it relative to dir
            if (!FileName.absolute(argdoc)) {
                // resolved: version(IN_LLVM) ON (_config.md §1) — the tempdir fallback is KEPT
                // (it shapes the output path), but its callee has no D source.
                if ((dir === null || dir.length === 0) && global.params.cleanupObjectFiles) {
                    // DJS-ESCALATE: createTempObjectsDir(), external implementation (dmd/dmodule.d:592)
                    // Only `-cleanup-obj` and ldmd's `-run` set cleanupObjectFiles (cl_options.cpp:290,
                    // main.cpp:514), and src/djs.ts refuses both (10 §4.2): no run of the shim gets here.
                    throw new Error("DJS-ESCALATE: createTempObjectsDir (driver/main.cpp:1114) at dmd/dmodule.d:592");
                }
                //FileName::ensurePathExists(dir);
                argdoc = FileName.combine(dir, argdoc);
            }
            docfilename = FileName.forceExt(argdoc, ext);
        }
        if (FileName.equals(docfilename, this.srcfile.toString())) {
            error(this.loc, ds("%s `%s` source file and output file have same name '%s'"),
                this.kind(), this.toPrettyChars(), this.srcfile.toChars());
            fatal();
        }
        return new FileName(docfilename);
    }

    setDocfile(): void {                                     // dmd/dmodule.d:611
        this.docfile = this.setOutfilename(global.params.ddoc.name, global.params.ddoc.dir, this.arg, doc_ext);
    }

    /**
     * dmd/dmodule.d:616-670 — trigger the relevant semantic error when a file cannot be read.
     *
     * We special case `object.d` as a failure is likely to be a rare but difficult to diagnose case
     * for the user. Packages also require special handling to avoid exposing the compiler's
     * internals.
     *
     * Params:
     *  loc = The location at which the file read originated (e.g. import)
     *
     * D `private` and reached only from `read` on this class -> TS `private` (01 §2.5).
     */
    private onFileReadError(loc: Loc): void {
        const name = this.srcfile.toString();
        if (FileName.equals(name, ds("object.d"))) {
            ObjectNotFound(Loc.initial, this.ident!);
        }
        else if (FileName.ext(this.arg) !== null || !loc.isValid()) {
            // Modules whose original argument name has an extension, or do not
            // have a valid location come from the command-line.
            // Error that their file cannot be found and return early.
            error(loc, ds("cannot find input file `%.*s`"), name.length, name);
        }
        else {
            // if module is not named 'package' but we're trying to read 'package.d', we're looking for a package module
            const isPackageMod = !dsEquals(cstr(this.toChars()), ds("package")) && isPackageFileName(this.srcfile);
            if (isPackageMod)
                error(loc, ds("importing package '%s' requires a 'package.d' file which cannot be found in '%.*s'"),
                    this.toChars(), name.length, name);
            else {
                error(loc, ds("unable to read module `%s`"), this.toChars());
                // dependency signature (11 §1): `package_d` (file_manager.d:23,
                // `enum package_d = "package." ~ mars_ext;`) is NOT exported from file_manager.ts.
                // Closest expressible form = the manifest enum's own definition, inlined here.
                const pkgfile = FileName.combine(FileName.sansExt(name), dsConcat(ds("package."), mars_ext));
                errorSupplemental(loc, ds("Expected '%.*s' or '%.*s' in one of the following import paths:"),
                    name.length, name, pkgfile.length, pkgfile);
            }
        }
        if (global.gag === 0) {
            /* Print path
             */
            if (global.path.length !== 0) {
                // `fprintf(stderr, …)` -> assemble via dmdformat, ONE stderr write each (10 §4.4).
                for (const [i, p] of global.path.opSlice().entries())
                    process.stderr.write(dsToJs(dmdformat(ds("import path[%llu] = %s\n"), [BigInt(i), p.path])));
            }
            else {
                process.stderr.write(dsToJs(dmdformat(ds("Specify path to file '%.*s' with -I switch\n"),
                    [name.length, name])));
            }

            removeHdrFilesAndFail(global.params, Module.amodules);
        }
    }

    /**
     * dmd/dmodule.d:672-730 — reads the file from `srcfile` and loads the source buffer.
     *
     * If makefile module dependency is requested, we add this module to the list of dependencies
     * from here.
     *
     * Params:
     *  loc = the location
     * Returns: `true` if successful
     */
    read(loc: Loc): boolean {
        if (this.src !== null)                             // `if (this.src)` — slice pointer test (06 §2.8)
            return true; // already read

        //printf("Module::read('%s') file '%s'\n", toChars(), srcfile.toChars());

        /* Preprocess the file if it's a .c file
         */
        // `FileName filename = srcfile;` — a struct copy. `.copy()` elided (03 §9): the ported
        // FileName is immutable after construction (filename.ts:44-46 documents the model and
        // provides no `copy()`), so the share is indistinguishable from a copy.
        const filename = this.srcfile;

        let srctext: DString | null = null;                // `const(ubyte)[] srctext;`
        if (global.preprocess !== null &&
            (FileName.equalsExt(this.srcfile.toString(), c_ext) ||
             FileName.equalsExt(this.srcfile.toString(), h_ext)) &&
            FileName.exists(this.srcfile.toString()) !== 0)
        {
            /* Apply C preprocessor to the .c file, returning the contents
             * after preprocessing
             */
            // resolved: version(IN_LLVM) ON (_config.md §1) — LDC's `preprocess` returns the path of
            // a temp file; the DMD `else` arm (which returns the bytes directly) is the dead branch.
            const ipath = global.preprocess(this.srcfile, loc, this.defines);
            srctext = global.fileManager!.getFileContents(ipath);

            // remove temp file and parent directory
            File.remove(ipath.toChars());
            File.removeDirectory(FileName.path(ipath.toChars()));
        }
        else    // `Module.djsTextOf`: the djs host's text override, no D counterpart (see its declaration)
            srctext = (Module.djsTexts !== null ? Module.djsTextOf(dsToJs(filename.toString())) : null)
                ?? global.fileManager!.getFileContents(filename);
        this.src = srctext;

        if (srctext !== null) {                            // `if (srctext)` (06 §2.8)
            if (global.params.makeDeps.doOutput)
                global.params.makeDeps.files.push(this.srcfile.toChars());
            return true;
        }

        this.onFileReadError(loc);
        return false;
    }

    /// dmd/dmodule.d:732-736 — syntactic parse.
    parse(): Module | null {
        // `parseModule!ASTCodegen()`; the kept-module engine counts the generated identifiers the parse consumes
        return K.on ? keepParse(this, () => this.parseModule()) : this.parseModule();
    }

    /**
     * dmd/dmodule.d:739-958 — `extern (D) Module parseModule(AST)()`. MONOMORPHIZED to the single
     * concrete AST (`ASTCodegen`), so the `(AST)` parameter vanishes and the node classes are
     * referenced directly (13 §3).
     */
    parseModule(): Module | null {
        const srcname = this.srcfile.toChars();
        //printf("Module::parse(srcname = '%s')\n", srcname);

        // dropped: `import dmd.timetrace; timeTraceBeginEvent(TimeTraceEventType.parse);
        //          scope (exit) timeTraceEndEvent(TimeTraceEventType.parse, this);`
        //          (dmd/dmodule.d:744-746) — profiling instrumentation, not semantics (out of port
        //          scope; dmd.timetrace not ported). Same disposition as the other two frontend
        //          timetrace sites already in the tree: dsymbolsem.ts:2211, funcsem.ts:60. The pair
        //          has no observable effect on the AST/sema/CTFE result, so nothing is walled here.
        this.isPackageFile = isPackageFileName(this.srcfile);
        // `src` is a nullable slice (dmodule.d:316) and `processSource` accepts the null (it comes
        // straight back out through the `< 2` early return), so no `!` here — D faults nowhere.
        const buf = processSource(this.src, this);
        // an error happened on UTF conversion
        if (buf === null) return null;

        /* If it starts with the string "Ddoc", then it's a documentation
         * source file.
         */
        if (buf.length >= 4 && dsEquals(buf.subarray(0, 4), ds("Ddoc"))) {
            this.addComment(buf.subarray(4));               // `buf.ptr + 4` — byte cursor (02 §11)
            this.filetype = FileType.ddoc;
            if (!this.docfile.toBool())                     // `if (!docfile)` — FileName opCast(bool)
                this.setDocfile();
            return this;
        }
        /* If it has the extension ".dd", it is also a documentation
         * source file. Documentation source files may begin with "Ddoc"
         * but do not have to if they have the .dd extension.
         * https://issues.dlang.org/show_bug.cgi?id=15465
         */
        if (FileName.equalsExt(this.arg, dd_ext)) {
            this.addComment(buf);   // the optional Ddoc, if present, is handled above.
            this.filetype = FileType.ddoc;
            if (!this.docfile.toBool())
                this.setDocfile();
            return this;
        }
        /* If it has the extension ".di", it is a "header" file.
         */
        if (FileName.equalsExt(this.arg, hdr_ext))
            this.filetype = FileType.dhdr;

        /// Promote `this` to a root module if requested via `-i`
        // dmd/dmodule.d:783 — nested function -> inner arrow (04 §5).
        const checkCompiledImport = (): void => {
            if (!this.isRoot() && Compiler.onImport(this))
                this.importedFrom = this;
        };

        let dst: DsymbolTable | null = null;
        // `Package ppack = null;` + `&ppack` at dmodule.d:811/:831 — address-of a LOCAL class
        // reference, so the local becomes the one-slot box the callee writes through (03 §7.2/§3.3).
        const ppack: { value: Package | null } = { value: null };

        /* If it has the extension ".c" or ".h", it is a "C" file.
         * If it has the extension ".i", it is a preprocessed "C" file.
         */
        if (FileName.equalsExt(this.arg, c_ext) ||
            FileName.equalsExt(this.arg, h_ext) ||
            FileName.equalsExt(this.arg, i_ext))
        {
            this.filetype = FileType.c;

            if (cparserSlot === undefined)   // the registration slot's order contract (header of this file)
                throw new Error("dmodule.parseModule: registerCParser not called (dmd/cparse.d:37)");
            global.compileEnv.masm = target.os === OS.Windows; // Microsoft inline assembler format
            // dmd/dmodule.d:802 — `scope p = new CParser!AST(this, buf, cast(bool) docfile, global.errorSink,`
            // with `target.c, &defines, &global.compileEnv`: CParser is monomorphized like Parser (cparse.ts
            // header); `&defines` is the Module's own OutBuffer (a reference class in the port), `scope` erases.
            // The `masm` set/reset pair (dmodule.d:801/:803) is held by a plain try/finally (11 §2.5: a release
            // at one normal-path line whose result nothing uses): a throw out of the constructor leaves no
            // `masm = true` behind.
            let p: CParser;
            try {
                p = new cparserSlot(this, buf, this.docfile.toBool(), global.errorSink!, target.c, this.defines,
                                    global.compileEnv);
            } finally {
                global.compileEnv.masm = false;
            }
            p.nextToken();
            checkCompiledImport();
            this.members = p.parseModule();
            this.md = p.md;
            if (this.md !== null) {
                this.ident = this.md.id;
                // `&this.parent` — the same accessor box as the D-leg's (03 §3.3/§7.2) below.
                const self = this;
                const pparentBox = {
                    get value(): Dsymbol | null { return self.parent; },
                    set value(v: Dsymbol | null) { self.parent = v; },
                };
                dst = Package.resolve(this.md.packages, pparentBox, ppack);
            }

            this.numlines = p.linnum;
        }
        else {
            const doUnittests = global.params.parsingUnittestsRequired();
            // `scope p = new Parser!AST(this, buf, cast(bool) docfile, global.errorSink,
            //   &global.compileEnv, doUnittests)`. The port's Parser ctor collapses D's two overloads
            // with a leading nullable `loc` (parse.ts:331), so this main-parser form passes `null`;
            // `scope` erases (04 §8). `global.errorSink` is `ErrorSink | null` in the port and set
            // by `global._init` before any parse, so it is read with `!`.
            // `|| ...djsDocComments ...`: the djs host's doc-comment knob, no D counterpart (see its declaration)
            const docComments = this.docfile.toBool() || (Module.djsDocComments && !global.params.json.doOutput);
            const p = new Parser(null, this, buf, docComments, global.errorSink!, global.compileEnv, doUnittests);
            p.nextToken();
            p.parseModuleDeclaration();
            this.md = p.md;

            if (this.md !== null) {
                /* A ModuleDeclaration, md, was provided.
                * The ModuleDeclaration sets the packages this module appears in, and
                * the name of this module.
                */
                this.ident = this.md.id;
                // `&this.parent` — address-of a class-reference SLOT: an accessor box that reads and
                // writes the field through (03 §3.3/§7.2), so the callee's write lands on `parent`.
                const self = this;
                const pparentBox = {
                    get value(): Dsymbol | null { return self.parent; },
                    set value(v: Dsymbol | null) { self.parent = v; },
                };
                dst = Package.resolve(this.md.packages, pparentBox, ppack);
            }

            // Done after parsing the module header because `module x.y.z` may override the file name
            checkCompiledImport();

            this.members = p.parseModuleContent();
            this.numlines = p.linnum;
        }

        /* The symbol table into which the module is to be inserted.
         */

        if (this.md !== null) {
            // Mark the package path as accessible from the current module
            // https://issues.dlang.org/show_bug.cgi?id=21661
            // Code taken from Import.addPackageAccess()
            if (this.md.packages.length > 0) {
                // module a.b.c.d;
                let p: Package | null = ppack.value; // a
                // D dereferences `p` here with no null test (dmodule.d:853), so the read is `!`.
                this.addAccessiblePackage(p!, new Visibility(Visibility.Kind.private_));
                for (const id of this.md.packages.slice(1)) {   // `md.packages[1 .. $]` — [b, c]
                    const looked = p!.symtab!.lookup(id);
                    // `p = cast(Package) p.symtab.lookup(id);` — checked downcast (isPackage() is
                    // exactly that test in the port; `cast(Package)null` is null).
                    p = looked !== null ? looked.isPackage() : null;
                    if (p === null)
                        break;
                    this.addAccessiblePackage(p, new Visibility(Visibility.Kind.private_));
                }
            }
            assert(dst !== null, "assert(dst): Module.parseModule (dmd/dmodule.d:862)");
            const m: Module | null = ppack.value !== null ? ppack.value.isModule() : null;
            if (m !== null && !isPackageFileName(m.srcfile)) {
                error(this.md.loc, ds("package name '%s' conflicts with usage as a module name in file %s"),
                      ppack.value!.toPrettyChars(), m.srcfile.toChars());
            }
        }
        else {
            /* The name of the module is set to the source file name.
             * There are no packages.
             */
            dst = Module.modules!; // and so this module goes into global module symbol table
            /* Check to see if module name is a valid identifier
             */
            if (!Identifier.isValidIdentifier(this.ident!.toChars()))
                error(this.loc, ds("%s `%s` has non-identifier characters in filename, use module declaration instead"),
                      this.kind(), this.toPrettyChars());
        }
        // Insert module into the symbol table
        // upcast cascade (02 §11.5): Module.errors (uint) shadows Dsymbol.errors (bool), so TS's
        // structural check rejects the sound `Dsymbol s = this;` upcast. Runtime object IS a Module.
        let s: Dsymbol = this as unknown as Dsymbol;
        if (this.isPackageFile) {
            /* If the source tree is as follows:
             *     pkg/
             *     +- package.d
             *     +- common.d
             * the 'pkg' will be incorporated to the internal package tree in two ways:
             *     import pkg;
             * and:
             *     import pkg.common;
             *
             * If both are used in one compilation, 'pkg' as a module (== pkg/package.d)
             * and a package name 'pkg' will conflict each other.
             *
             * To avoid the conflict:
             * 1. If preceding package name insertion had occurred by Package::resolve,
             *    reuse the previous wrapping 'Package' if it exists
             * 2. Otherwise, 'package.d' wrapped by 'Package' is inserted to the internal tree in here.
             *
             * Then change Package::isPkgMod to PKG.module_ and set Package::mod.
             *
             * Note that the 'wrapping Package' is the Package that contains package.d and other submodules,
             * the one inserted to the symbol table.
             */
            const ps = dst.lookup(this.ident!);
            let p: Package | null = ps !== null ? ps.isPackage() : null;
            if (p === null && K.on)
                p = keepWrappingPackage(dst, this.ident!);   // the kept-module engine: kept submodules' package
            if (p === null) {
                p = new Package(Loc.initial, this.ident);
                p.tag = this.tag; // reuse the same package tag
                p.symtab = new DsymbolTable();
            }
            this.tag = p.tag; // reuse the 'older' package tag
            this.pkg = p;
            p.parent = this.parent;
            p.isPkgMod = PKG.module_;
            p.mod = this;
            s = p;
        }
        if (dst.insert(s) === null) {                       // `if (!dst.insert(s))` (06 §2.7)
            /* It conflicts with a name that is already in the symbol table.
             * Figure out what went wrong, and issue error message.
             */
            const prev = dst.lookup(this.ident!);
            assert(prev !== null, "assert(prev): Module.parseModule (dmd/dmodule.d:927)");
            // `if (Module mprev = prev.isModule())` / `else if (Package pkg = prev.isPackage())` —
            // chained declarations in conditions: hoist each into the prior `else` so the second
            // initializer runs ONLY when the first arm did not match (06 §2.6).
            const mprev = prev.isModule();
            if (mprev !== null) {
                if (!FileName.equals(srcname, mprev.srcfile.toChars()))
                    error(this.loc, ds("%s `%s` from file %s conflicts with another module %s from file %s"),
                        this.kind(), this.toPrettyChars(), srcname, mprev.toChars(), mprev.srcfile.toChars());
                else if (this.isRoot() && mprev.isRoot())
                    error(this.loc, ds("%s `%s` from file %s is specified twice on the command line"),
                        this.kind(), this.toPrettyChars(), srcname);
                else
                    error(this.loc, ds("%s `%s` from file %s must be imported with 'import %s;'"),
                        this.kind(), this.toPrettyChars(), srcname, this.toPrettyChars());
                // https://issues.dlang.org/show_bug.cgi?id=14446
                // Return previously parsed module to avoid AST duplication ICE.
                return mprev;
            }
            else {
                const pkg = prev.isPackage();
                if (pkg !== null) {
                    // 'package.d' loaded after a previous 'Package' insertion
                    if (this.isPackageFile)
                        Module.amodules.push(this); // Add to global array of all modules
                    else
                        error(this.md !== null ? this.md.loc : this.loc,
                            ds("%s `%s` from file %s conflicts with package name %s"),
                            this.kind(), this.toPrettyChars(), srcname, pkg.toChars());
                }
                else
                    // `assert(global.errors)` — a uint in a boolean context (09 §9).
                    assert(global.errors !== 0, "assert(global.errors): Module.parseModule (dmd/dmodule.d:949)");
            }
        }
        else {
            // Add to global array of all modules
            Module.amodules.push(this);
        }
        if (K.on) keepParsed(this, dst!);   // the kept-module engine: the module's entry in the tree, kept
        Compiler.onParseModule(this);
        return this;
    }

    /**********************************
     * dmd/dmodule.d:960-968 — determine if we need to generate an instance of ModuleInfo for this
     * Module.
     *
     * `return needmoduleinfo || (!IN_LLVM && global.params.cov);` — resolved: IN_LLVM is ON, so
     * `!IN_LLVM` is false and the second term is dead (07 §1). D's `||` yields a `bool` that the
     * `int` return converts to 0/1.
     */
    needModuleInfo(): number {
        //printf("needModuleInfo() %s, %d, %d\n", toChars(), needmoduleinfo, global.params.cov);
        return (this.needmoduleinfo !== 0) ? 1 : 0;
    }

    /**
     * dmd/dmodule.d:970-980 — guard import cycles with `insearch`, then delegate to the base.
     * `scope (exit) insearch = false` -> try/finally (06 §7.1). `visibility` is a by-value struct
     * param, so reassigning the local is callee-private (03 §3.1).
     */
    override isPackageAccessible(p: Package, visibility: Visibility,
                                 flags: SearchOptFlags = SearchOpt.all): boolean {
        if (this.insearch) // don't follow import cycles
            return false;
        this.insearch = true;
        try {
            // SearchOptFlags is a uint flag set (number domain) — bitmask test (09 §4.1).
            if ((flags & SearchOpt.ignorePrivateImports) !== 0)
                visibility = new Visibility(Visibility.Kind.public_); // only consider public imports
            // `ScopeDsymbol.isPackageAccessible` (dsymbol.d:1223) takes `visibility` BY VALUE, so
            // the copy is emitted at this call site (03 §1 #2/§3.1) — the same spelling that
            // callee already uses for its own recursive call (dsymbol.ts:1489). `Visibility` is not
            // in the §9.1 alias-safe register, so the copy is not licensed to be elided.
            return super.isPackageAccessible(p, visibility.copy());
        } finally {
            this.insearch = false;
        }
    }

    override symtabInsert(s: Dsymbol): Dsymbol | null {      // dmd/dmodule.d:982
        this.searchCacheIdent = null; // symbol is inserted, so invalidate cache
        return super.symtabInsert(s); // `Package.symtabInsert(s)` — the inherited ScopeDsymbol body
    }

    deleteObjFile(): void {                                  // dmd/dmodule.d:988
        if (global.params.obj)
            File.remove(this.objfile.toChars());
        if (this.docfile.toBool())                           // `if (docfile)` — FileName opCast(bool)
            File.remove(this.docfile.toChars());
    }

    static clearCache(): void {                              // dmd/dmodule.d:996
        // `amodules` slots are `Module | null` (08 §3); dmodule.d:999 writes through each with no
        // null test -> `m!`.
        for (const m of Module.amodules) m!.searchCacheIdent = null;
    }

    /************************************
     * dmd/dmodule.d:1002-1028 — recursively look at every module this module imports, return true
     * if it imports `m`. Can be used to detect circular imports.
     * D returns `int` used as a bool -> `boolean`.
     */
    imports(m: Module): boolean {
        //printf("%s Module::imports(%s)\n", toChars(), m.toChars());
        // resolved: version(none) OFF (07 §1.4) — the `printf` walk at dmodule.d:1010-1014 is dropped.
        for (const mi of this.aimports) {
            if (mi === m)                                    // `mi == m` — class identity (05 §2)
                return true;
            if (!mi!.insearch) {
                mi!.insearch = true;
                const r = mi!.imports(m);
                if (r)
                    return r;
            }
        }
        return false;
    }

    isRoot(): boolean {
        return this.importedFrom === this;                   // dmd/dmodule.d:1032 (identity)
    }

    /// dmd/dmodule.d:1035 — Returns: whether this module is in the `core` package and has name `ident`.
    isCoreModule(ident: Identifier): boolean {
        // `==` on Identifier is class identity (no opEquals); `parent`/`parent.parent` are nullable
        // references, so their truthiness tests are explicit (06 §2.7).
        return this.ident === ident && this.parent !== null
            && this.parent.ident === Id.core && this.parent.parent === null;
    }

    // Back end — resolved: version(IN_LLVM) ON (_config.md §1/§2). FE bookkeeping KEPT; the LLVM
    // coverage globals and the function that fills them are DROPPED (see the file header).

    // gen/modules.cpp:72 `static std::map<std::string, Module *> files;` — a function-static that lives for
    // the process; the key is the file name's bytes (one UTF-16 unit per byte, an injective encoding). A
    // fresh module registry (each djsMain run in the tests) starts it empty, as a new ldc2 process does.
    private static outputFiles = new Map<string, Module>();

    /**
     * Records that this module writes `file`, and stops the compile when an earlier module already writes
     * it (dmodule.d:1045, body gen/modules.cpp:71). Called for the Ddoc file (doc.d:71) and the object file
     * (main.d:607). Errors: "Output file '<file>' for module `<this>` collides with previous module
     * `<prev>`. See the -oq option" at no location, then `fatal()`.
     */
    checkAndAddOutputFile(file: FileName): void {
        const name = file.toChars();
        let key = "";
        for (let i = 0; i < name.length; i++) key += String.fromCharCode(name[i]);
        const previousMod = Module.outputFiles.get(key);
        if (previousMod !== undefined) {
            error(Loc.initial,
                ds("Output file '%s' for module `%s` collides with previous module `%s`. See the -oq option"),
                name, this.toPrettyChars(), previousMod.toPrettyChars());
            fatal();
        }

        // gen/modules.cpp:85 `files.emplace(...)` inserts only an absent key: past a returning `fatal()` the first
        // module keeps the file, and a third colliding module is reported against it.
        if (previousMod === undefined)
            Module.outputFiles.set(key, this);
    }

    llvmForceLogging = false;                                // dmd/dmodule.d:1047
    noModuleInfo = false;                                    /// Do not emit any module metadata.
    d_cover_valid_init: DArray<number> = new DArray<number>(); // `Array!size_t` — init for _d_cover_valid

    ctfe_cov: Map<number, number> = new Map();  /// coverage from ctfe: execution_count[line] (`uint[uint]`)

    override accept(v: Visitor): void {
        v.visitModule(this);                                 // dmd/dmodule.d:1073 (13 §2)
    }

    /***********************************************
     * dmd/dmodule.d:1078-1092 — writes this module's fully-qualified name to `buf`.
     * Params:
     *    buf = The buffer to write to
     * `ref OutBuffer buf` -> the class reference, no copy (03 §3.2).
     */
    fullyQualifiedName(buf: OutBuffer): void {
        buf.writestring(this.ident!.toString());

        // `for (auto package_ = parent; package_ !is null; package_ = package_.parent)`
        for (let package_: Dsymbol | null = this.parent; package_ !== null; package_ = package_.parent) {
            buf.prependstring(ds("."));
            buf.prependstring(package_.ident!.toChars());
        }
    }
}

/***********************************************************
 * dmd/dmodule.d:1098-1132 — `extern (C++) struct ModuleDeclaration`.
 * A VALUE struct (02 §2): plain (no opAssign / postblit / copy-ctor), so `.copy()` is the
 * per-field recursion of 03 §2.
 */
export class ModuleDeclaration {
    loc: Loc = Loc.initial;
    id: Identifier | null = null;
    // `Identifier[] packages;` (dmodule.d:1102) — a D slice, `.init` null (09 §1.0). Modelled here
    // as a non-nullable array with an EMPTY `.init`, which collapses D's null-vs-empty-non-null
    // distinction (06 §2.8). The collapse is unobservable for THIS field, and the field IS
    // truthiness-tested (parse.d:3428/:3435 `md && !md.packages && md.id == Id.object`), so the
    // reason is spelled out rather than assumed:
    //   * the only writer is this struct's constructor (dmodule.d:1109), fed from the only
    //     construction site, parse.d:158 `new AST.ModuleDeclaration(loc, a, id, msg, isdeprecated)`;
    //   * that `a` is `Identifier[] a;` at parse.d:143 — null unless the `while (nextToken() == TOK.dot)`
    //     loop appends (parse.d:146-156). So `a` is EITHER null (`module foo;`) OR non-empty
    //     (`module a.b;`); an empty-non-null slice is never built.
    //   * hence D's `!md.packages` and the port's `!md.packages.length` (parse.ts:3293/:3300) agree
    //     on every reachable value, and every other reader only `.length`s it, iterates it, or
    //     passes it on (dmodule.d:849/:854, access.d:85).
    // The sibling field `Import.packages` records the same decision the other way round
    // (dimport.ts:80-94, nullable) — it is a DIFFERENT field, never truthiness-tested.
    packages: Identifier[] = [];  // array of Identifier's representing packages
    isdeprecated = false;         // if it is a deprecated module
    msg: Expression | null = null;

    /**
     * dmd/dmodule.d:1106 — `extern (D) this(Loc loc, Identifier[] packages, Identifier id,`
     * Expression msg, bool isdeprecated).
     * `loc` is a value-struct field store (03 §1 #5); `packages` is a D slice -> shared reference
     * (02 §8); `id`/`msg` are class refs -> shared.
     */
    constructor(loc: Loc, packages: Identifier[], id: Identifier | null, msg: Expression | null,
                isdeprecated: boolean) {
        this.loc = loc.copy();
        this.packages = packages;
        this.id = id;
        this.msg = msg;
        this.isdeprecated = isdeprecated;
    }

    /// dmd/dmodule.d:1115 — `extern (C++) const(char)* toChars() const` -> "pkg1.pkg2.id".
    toChars(): DString {
        const buf = new OutBuffer();
        for (const pid of this.packages) {
            buf.writestring(pid.toString());
            buf.writeByte(0x2e);                 // '.'
        }
        buf.writestring(this.id!.toString());
        return buf.extractChars();
    }

    /// dmd/dmodule.d:1127 — provide a human readable representation.
    /// `this.toChars().toDString` — `toChars()` returns a NUL-terminated DString; `.toDString`
    /// slices the C string up to (excluding) the first NUL -> `cstr()` (02 §11.2).
    toString(): DString {
        return cstr(this.toChars());
    }

    /// Value-struct copy (03 §2): the ctor already deep-copies `loc` and shares the class refs /
    /// the `Identifier[]` slice per the per-field rule, so delegating to it IS the full copy.
    copy(): ModuleDeclaration {
        return new ModuleDeclaration(this.loc, this.packages, this.id, this.msg, this.isdeprecated);
    }
}

/// dmd/dmodule.d:1134 — `alias ForeachDg = int delegate(size_t idx, Dsymbol s);` (02 §5.2).
export type ForeachDg = (idx: number, s: Dsymbol) => number;

/**
 * dmd/dmodule.d:1136-1325 — process the content of a source file.
 *
 * Attempts to find which encoding it is using, if it has BOM, and then normalize the source to
 * UTF-8. If no encoding is required, a slice of `src` will be returned without extra allocation.
 *
 * Params:
 *  src = Content of the source file to process
 *  mod = Module matching `src`, used for error handling
 * Returns:
 *   UTF-8 encoded variant of `src`, stripped of any BOM, or `null` if an error happened.
 *
 * D module-private (dmodule.d:1151) — exported so the co-located `dmodule.test.ts` can read it,
 * the same-module-scope reader 01 §2.5 sanctions for a D `private` declaration. dmodule.d carries
 * NO `unittest` block, so these are 10 §1.6b behavior pins, not ported unittests.
 *
 * `const(ubyte)[] src` is a D SLICE whose `.init` is null (09 §1.0), and D's body handles that
 * null: `buf.length` on a null slice is 0, so the `< 2` early return hands the null slice straight
 * back — which is exactly what the caller's `if (buf is null) return null;` (dmodule.d:751) is
 * written to catch. The parameter is therefore `DString | null`, not a non-null `DString`.
 */
export function processSource(src: DString | null, mod: Module): DString | null {
    // `enum SourceEncoding { utf16, utf32}` (dmodule.d:1153) is DEAD in the body — declared and
    // never referenced — so it is dropped (07 audit convention). `enum Endian { little, big}` is a
    // pure translation-time template argument (see below) and likewise emits nothing.
    // `immutable loc = mod.loc;` — Loc is an ALIAS-SAFE REGISTER type (03 §9.1): sharing on read is
    // licensed, no copy needed.
    const loc = mod.loc;

    /*
     * Convert a buffer from UTF32 to UTF8
     * Params:
     *    Endian = is the buffer big/little endian
     *    buf = buffer of UTF32 data
     * Returns:
     *    input buffer reencoded as UTF8
     */
    // dmd/dmodule.d:1166 — `char[] UTF32ToUTF8(Endian endian)(const(char)[] buf)`. The template's
    // only CT-dependent line is `static if (endian == Endian.little) alias readNext = …`
    // (dmodule.d:1168), so it is MONOMORPHIZED per instantiation (07 §3.4): one nested function per
    // `Endian` value actually instantiated (little at :1290/:1308, big at :1298/:1310).
    // `readNext(&eBuf[i])` reads the i-th 32-bit element of `cast(const(uint)[])buf`; a DString is a
    // byte buffer addressed by index (cheatsheet `prim*` -> byte cursor), so the element address
    // becomes the byte offset `i * 4`.

    const UTF32ToUTF8_little = (buf: DString): DString | null => {
        // resolved: static if (endian == Endian.little) -> alias readNext = Port.readlongLE (07 §3.4)
        if ((buf.length & 3) !== 0) {
            error(loc, ds("%s `%s` odd length of UTF-32 char source %llu"),
                mod.kind(), mod.toPrettyChars(), BigInt(buf.length));
            return null;
        }

        const eBufLength = buf.length / 4;      // `const (uint)[] eBuf = cast(const(uint)[])buf;`

        const dbuf = new OutBuffer();
        dbuf.reserve(eBufLength);

        for (let i = 0; i < eBufLength; i++) {
            const u = Port.readLongLE(buf, i * 4);
            if ((u & ~0x7f) !== 0) {
                if (u > 0x10ffff) {
                    error(loc, ds("%s `%s` UTF-32 value %08x greater than 0x10FFFF"),
                        mod.kind(), mod.toPrettyChars(), u);
                    return null;
                }
                dbuf.writeUTF8(u);
            }
            else
                dbuf.writeByte(toUint8(u));
        }
        dbuf.writeByte(0); //add null terminator
        return dbuf.extractSlice();
    };

    const UTF32ToUTF8_big = (buf: DString): DString | null => {
        // resolved: static if (endian == Endian.little) is FALSE -> alias readNext = Port.readlongBE
        if ((buf.length & 3) !== 0) {
            error(loc, ds("%s `%s` odd length of UTF-32 char source %llu"),
                mod.kind(), mod.toPrettyChars(), BigInt(buf.length));
            return null;
        }

        const eBufLength = buf.length / 4;

        const dbuf = new OutBuffer();
        dbuf.reserve(eBufLength);

        for (let i = 0; i < eBufLength; i++) {
            const u = Port.readLongBE(buf, i * 4);
            if ((u & ~0x7f) !== 0) {
                if (u > 0x10ffff) {
                    error(loc, ds("%s `%s` UTF-32 value %08x greater than 0x10FFFF"),
                        mod.kind(), mod.toPrettyChars(), u);
                    return null;
                }
                dbuf.writeUTF8(u);
            }
            else
                dbuf.writeByte(toUint8(u));
        }
        dbuf.writeByte(0); //add null terminator
        return dbuf.extractSlice();
    };

    /*
     * Convert a buffer from UTF16 to UTF8
     * Params:
     *    Endian = is the buffer big/little endian
     *    buf = buffer of UTF16 data
     * Returns:
     *    input buffer reencoded as UTF8
     */
    // dmd/dmodule.d:1213 — `char[] UTF16ToUTF8(Endian endian)(const(char)[] buf)`, monomorphized
    // exactly as above (little at :1291/:1313, big at :1295/:1315). Note `foreach (ref i; 0 ..
    // eBuf.length)`: the loop variable is by REFERENCE, so the `i++` inside the surrogate-pair arm
    // really advances the iteration — a plain counter `for` reproduces that (06 §1.3).

    const UTF16ToUTF8_little = (buf: DString): DString | null => {
        // resolved: static if (endian == Endian.little) -> alias readNext = Port.readwordLE (07 §3.4)
        if ((buf.length & 1) !== 0) {
            error(loc, ds("%s `%s` odd length of UTF-16 char source %llu"),
                mod.kind(), mod.toPrettyChars(), BigInt(buf.length));
            return null;
        }

        const eBufLength = buf.length / 2;      // `const (ushort)[] eBuf = cast(const(ushort)[])buf;`

        const dbuf = new OutBuffer();
        dbuf.reserve(eBufLength);

        //i will be incremented in the loop for high codepoints
        for (let i = 0; i < eBufLength; i++) {
            let u = Port.readWordLE(buf, i * 2);
            if ((u & ~0x7f) !== 0) {
                if (0xd800 <= u && u < 0xdc00) {
                    i++;
                    if (i >= eBufLength) {
                        error(loc, ds("%s `%s` surrogate UTF-16 high value %04x at end of file"),
                            mod.kind(), mod.toPrettyChars(), u);
                        return null;
                    }
                    const u2 = Port.readWordLE(buf, i * 2);
                    if (u2 < 0xdc00 || 0xe000 <= u2) {
                        error(loc, ds("%s `%s` surrogate UTF-16 low value %04x out of range"),
                            mod.kind(), mod.toPrettyChars(), u2);
                        return null;
                    }
                    u = (u - 0xd7c0) << 10;
                    u |= (u2 - 0xdc00);
                }
                else if (u >= 0xdc00 && u <= 0xdfff) {
                    error(loc, ds("%s `%s` unpaired surrogate UTF-16 value %04x"),
                        mod.kind(), mod.toPrettyChars(), u);
                    return null;
                }
                else if (u === 0xfffe || u === 0xffff) {
                    error(loc, ds("%s `%s` illegal UTF-16 value %04x"),
                        mod.kind(), mod.toPrettyChars(), u);
                    return null;
                }
                dbuf.writeUTF8(u);
            }
            else
                dbuf.writeByte(toUint8(u));
        }
        dbuf.writeByte(0); //add a terminating null byte
        return dbuf.extractSlice();
    };

    const UTF16ToUTF8_big = (buf: DString): DString | null => {
        // resolved: static if (endian == Endian.little) is FALSE -> alias readNext = Port.readwordBE
        if ((buf.length & 1) !== 0) {
            error(loc, ds("%s `%s` odd length of UTF-16 char source %llu"),
                mod.kind(), mod.toPrettyChars(), BigInt(buf.length));
            return null;
        }

        const eBufLength = buf.length / 2;

        const dbuf = new OutBuffer();
        dbuf.reserve(eBufLength);

        //i will be incremented in the loop for high codepoints
        for (let i = 0; i < eBufLength; i++) {
            let u = Port.readWordBE(buf, i * 2);
            if ((u & ~0x7f) !== 0) {
                if (0xd800 <= u && u < 0xdc00) {
                    i++;
                    if (i >= eBufLength) {
                        error(loc, ds("%s `%s` surrogate UTF-16 high value %04x at end of file"),
                            mod.kind(), mod.toPrettyChars(), u);
                        return null;
                    }
                    const u2 = Port.readWordBE(buf, i * 2);
                    if (u2 < 0xdc00 || 0xe000 <= u2) {
                        error(loc, ds("%s `%s` surrogate UTF-16 low value %04x out of range"),
                            mod.kind(), mod.toPrettyChars(), u2);
                        return null;
                    }
                    u = (u - 0xd7c0) << 10;
                    u |= (u2 - 0xdc00);
                }
                else if (u >= 0xdc00 && u <= 0xdfff) {
                    error(loc, ds("%s `%s` unpaired surrogate UTF-16 value %04x"),
                        mod.kind(), mod.toPrettyChars(), u);
                    return null;
                }
                else if (u === 0xfffe || u === 0xffff) {
                    error(loc, ds("%s `%s` illegal UTF-16 value %04x"),
                        mod.kind(), mod.toPrettyChars(), u);
                    return null;
                }
                dbuf.writeUTF8(u);
            }
            else
                dbuf.writeByte(toUint8(u));
        }
        dbuf.writeByte(0); //add a terminating null byte
        return dbuf.extractSlice();
    };

    const buf: DString | null = src;   // `const(char)[] buf = cast(const(char)[]) src;` — same bytes

    // Assume the buffer is from memory and has not be read from disk. Assume UTF-8.
    // A D null slice has `.length == 0` (09 §1.0), so `buf is null` falls into this same early
    // return and yields the null slice back — the `buf === null` disjunct reproduces that, it does
    // not add a branch D lacks (06 §2.8: null and empty-non-null stay distinguishable, and both
    // land here).
    if (buf === null || buf.length < 2)
        return buf;

    /* Convert all non-UTF-8 formats to UTF-8.
     * BOM : https://www.unicode.org/faq/utf_bom.html
     * 00 00 FE FF  UTF-32BE, big-endian
     * FF FE 00 00  UTF-32LE, little-endian
     * FE FF        UTF-16BE, big-endian
     * FF FE        UTF-16LE, little-endian
     * EF BB BF     UTF-8
     */
    if (buf[0] === 0xff && buf[1] === 0xfe) {
        if (buf.length >= 4 && buf[2] === 0 && buf[3] === 0)
            return UTF32ToUTF8_little(buf.subarray(4));
        return UTF16ToUTF8_little(buf.subarray(2));
    }

    if (buf[0] === 0xfe && buf[1] === 0xff)
        return UTF16ToUTF8_big(buf.subarray(2));

    if (buf.length >= 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 0xfe && buf[3] === 0xff)
        return UTF32ToUTF8_big(buf.subarray(4));

    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
        return buf.subarray(3);

    /* There is no BOM. Make use of Arcane Jill's insight that
     * the first char of D source must be ASCII to
     * figure out the encoding.
     */
    if (buf.length >= 4 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0)
        return UTF32ToUTF8_little(buf);
    if (buf.length >= 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 0)
        return UTF32ToUTF8_big(buf);
    // try to check for UTF-16
    if (buf.length >= 2 && buf[1] === 0)
        return UTF16ToUTF8_little(buf);
    if (buf[0] === 0)
        return UTF16ToUTF8_big(buf);

    // It's UTF-8
    if (buf[0] >= 0x80) {
        error(loc, ds("%s `%s` source file must start with BOM or ASCII character, not \\x%02X"),
            mod.kind(), mod.toPrettyChars(), buf[0]);
        return null;
    }

    return buf;
}

/**
 * HARNESS-ONLY FACTORY — **no D counterpart; never called by compiler code** (the
 * `IntegerExp._resetLiteralCache` pattern, 01 §5.5 / 10 §1.9).
 *
 * In-memory analogue of the member-assignment tail of `Module.parseModule()` (dmodule.d:807-838),
 * for the minimal lex->parse->sema harness. `Module.parseModule()` reads a file, runs the Parser on
 * `this`, then stores `members = p.parseModuleContent(); md = p.md;` (and `ident = md.id` when a
 * `module x.y;` declaration is present). Here the caller has already lexed+parsed the source buffer
 * (the Parser needs no on-disk `srcfile`), so this helper performs only that storage step: build a
 * fresh `Module`, attach the parsed top-level members and any `ModuleDeclaration`, and adopt the
 * declared module name.
 *
 * The driver-only file machinery (`Package.resolve`, symbol-table insertion, `Compiler.onImport`)
 * is intentionally skipped: `runSemantic` gives the module its own global scope from scratch
 * (createGlobal), so none of it is load-bearing for the passes `runSemantic` runs on an in-memory module.
 *
 * @param members  top-level declarations from `Parser.parseModule()` / `parseModuleContent()`.
 * @param md       the parsed `ModuleDeclaration` (Parser.md), or null if the source has no `module`.
 * @param name     original argument name recorded as `arg` (defaults to a placeholder).
 */
export function moduleFromParse(members: Dsymbols, md: ModuleDeclaration | null = null,
                                name: DString = ds("__stdin")): Module {
    const m = new Module(Loc.initial, name, null, 0, 0);
    m.members = members;            // `members = p.parseModuleContent();` (dmodule.d:837)
    m.md = md;                      // `md = p.md;` (dmodule.d:822)
    if (md) m.ident = md.id;        // `this.ident = md.id;` when a ModuleDeclaration is present (:830)
    return m;
}
