// Ported from dmd/mars.d (module dmd.mars).
//
// Entry point helpers for DMD's command line: the parts of mars.d that LDC's frontend path (lex -> parse ->
// sema -> CTFE) reaches when it is driven by ldc2 on arm64-apple-darwin.
//
// IN_LLVM RESOLUTION (_config.md §2, "Driver/option glue" row: CASE-BY-CASE). ldc2 parses its command line
// in C++ (driver/main.cpp `parseCommandLine`, driver/cl_options.cpp); DMD's own parser and everything around
// it sit in `version (IN_LLVM) {} else` blocks and resolve away. Top-level D declarations, in source order:
//   - dropped (!IN_LLVM, mars.d:75-137): `logo`, `printInternalFailure`, `usage`.
//   - ported: `generateJson` (mars.d:147), over json.ts's `json_generate`. main.d calls it for `-X`/`-Xf`/`-Xi`.
//   - dropped (!IN_LLVM, mars.d:190-417): `getenv_setargv`, `parse_arch_arg`, `parse_conf_arg`,
//     `setDefaultLibraries`, the `DigitalMars`/`NoMain` runtime option blocks.
//   - ported: `printPredefinedVersions` (mars.d:419).
//   - dropped (!IN_LLVM, mars.d:430-472): `printGlobalConfigs`, `printGlobalConfig`.
//   - ported: `flushMixins` (mars.d:482).
//   - ported (IN_LLVM, mars.d:494-583): `parseCLIOption` and the three entry points LDC's C++ driver calls,
//     `parseTransitionOption`, `parsePreviewOption`, `parseRevertOption`.
//   - dropped (!IN_LLVM, mars.d:585-1956): DMD's `parseCommandLine` and its helpers; ldc2's C++ parser
//     stands in its place (src/djs.ts).
//   - ported: `setFlagFor` (mars.d:1959/1965, one function over both overloads, see its comment),
//     `createModule` (mars.d:1989), `createModules` (mars.d:2125), `moduleWithEmptyMain` (mars.d:2225),
//     `readFromStdin` (mars.d:2248).
//
// OBJECT-FILE BOOKKEEPING (IN_LLVM). `createModules` pushes each root Module POINTER into `params.objfiles`
// (`cast(const(char)*)m`, mars.d:2151) and main.d:600-610 swaps the real object file name in after parsing; the
// list then feeds codegen and the linker, and two frontend readers: `generateJson` below (the JSON file name
// when `-Xf` gives none, mars.d:171) and json.d's buildInfo `objectFiles` (json.d:917). `params.objfiles` is a
// `DArray<DString>`, so the pointer is modelled by a per-Module token, `moduleObjfileToken`: a DString object
// compared by identity, as D compares the pointer (main.d:602).

import { Usage } from "./cli.js";
import type { Feature } from "./cli.js";
import { Module } from "./dmodule.js";
import { deprecation, error } from "./errors.js";
import type { ErrorSink } from "./errorsink.js";
import {
    FeatureState, bc_ext, c_ext, dd_ext, ddoc_ext, global, h_ext, hdr_ext, i_ext, json_ext, map_ext, mars_ext,
} from "./globals.js";
import type { Param } from "./globals.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { OutBuffer } from "./common/outbuffer.js";
import { Array as DArray } from "./root/array.js";
import { File } from "./root/file.js";
import { FileName } from "./root/filename.js";
import { OS } from "./target.js";
import { writeFile } from "./utils.js";
import type { Target } from "./target.js";
import { ds, dsConcat, dsEquals, dsToJs } from "../dstring.js";
import type { DString } from "../dstring.js";
import { assert, assertUnreachable } from "../assert.js";
import { readFileSync } from "node:fs";
// last: 01 §4.8 — value imports into the sema half of the core SCC.
import { dsymbolSemantic, importAll } from "./dsymbolsem.js";
import { semantic2 } from "./semantic2.js";
import { semantic3 } from "./semantic3.js";
import { json_generate } from "./json.js";

import type { Modules } from "./arraytypes.js";
import type { Dsymbol } from "./dsymbol.js";

/**
 * Generates the JSON description of `modules` and writes it to `-Xf`'s file, stdout for `-Xf=-`, or a file named
 * after the first object file (mars.d:147). Returns: true on error (reported through `eSink`).
 */
export function generateJson(modules: Modules, eSink: ErrorSink): boolean {
    const buf = new OutBuffer();
    // dmd/json.d:987 — `void json_generate(ref Modules modules, ref OutBuffer buf)`
    json_generate(modules, buf);

    // Write buf to file
    const name = global.params.json.name;
    if (name !== null && dsEquals(name, ds("-"))) {
        // Write to stdout; assume it succeeds
        process.stdout.write(buf.peekSlice());   // fwrite(buf[].ptr, 1, buf.length, stdout)
    }
    else {
        /* The filename generation code here should be harmonized with Module.setOutfilename()
         */
        let jsonfilename: DString;
        if (name !== null) {   // `if (name)`: a non-null slice
            jsonfilename = FileName.defaultExt(name, json_ext);
        }
        else {
            if (global.params.objfiles.length === 0) {
                eSink.error(Loc.initial,
                    ds("cannot determine JSON filename, use `-Xf=<file>` or provide a source file"));
                return true;
            }
            // Generate json file name from first obj name
            let n = global.params.objfiles.opIndex(0);
            n = FileName.name(n);
            jsonfilename = FileName.forceExt(n, json_ext);
        }
        if (!writeFile(Loc.initial, jsonfilename, buf.peekSlice()))
            return true;
    }
    return false;
}

/**
 * Writes `predefs ` and every version identifier in `global.versionids`, each after a space, then a newline
 * (mars.d:419). ldc2 prints it under `-v`, so the line starts `predefs  LDC ...` (two spaces).
 */
export function printPredefinedVersions(buf: OutBuffer): void {
    buf.writestring(ds("predefs "));
    for (const str of global.versionids) {
        buf.writeByte(0x20);
        buf.writestring(str!.toChars());   // slot `Identifier | null` (08 §3); D writes every entry
    }
    buf.writeByte(0x0a);
}

/**
 * Writes the `-mixin=` buffer to its file and releases it (mars.d:482). A no-op when no buffer was set up,
 * which is every run without `-mixin=`. main.d calls it at scope exit.
 */
export function flushMixins(): void {
    if (!global.params.mixinOut.buffer)
        return;

    assert(global.params.mixinOut.name !== null);
    File.write(global.params.mixinOut.name!, global.params.mixinOut.buffer.peekSlice());

    global.params.mixinOut.buffer = null;   // `buffer.destroy(); buffer = null;` — the GC owns the rest
}

/** The three `-<group>=` switches of mars.d's `parseCLIOption` instantiations. */
type FeatureGroup = "transition" | "preview" | "revert";

/**
 * The `setFlagFor` pair (mars.d:1959 for `bool`, mars.d:1965 for `FeatureState`): true/enabled unless the
 * group is `revert`. D picks the overload from the static type of `params.<paramName>`; the port reads the
 * field's current value, whose JS type is that static type (`boolean` for `bool`, `number` for the
 * `FeatureState` enum), so the choice is the same one D makes.
 */
function setFlagFor(name: FeatureGroup, params: Param, paramName: DString): void {
    // D builds `params.<paramName>` as source text; the port walks the same dotted path on the object. The
    // Usage tables (cli.ts, pinned by cli.test.ts) name only Param fields, so every step lands on a field.
    const path = dsToJs(paramName).split(".");   // `v.field` names `params.v.field`
    // proof-carrying widening: a Param is indexed by the field names the tables list (comment above)
    let owner = params as unknown as Record<string, unknown>;
    for (const p of path.slice(0, -1))
        owner = owner[p] as Record<string, unknown>;
    const field = path[path.length - 1]!;
    const cur = owner[field];
    if (typeof cur === "boolean")
        owner[field] = name !== "revert";
    else if (typeof cur === "number")
        owner[field] = name !== "revert" ? FeatureState.enabled : FeatureState.disabled;
    else
        assertUnreachable();   // every Usage.Feature names a bool or FeatureState field of Param
}

/**
 * Handles one `-<groupName>=<name>` value (mars.d:499): `all` sets every non-deprecated feature of the
 * group; a feature name sets that feature (deprecated ones also report a deprecation); `?`, `h`, `help` ask
 * for the group's usage page. Returns: false for an unknown name.
 */
function parseCLIOption(groupName: FeatureGroup, features: readonly Feature[], params: Param, name: DString): boolean {
    // mars.d:501-523 — the mixin-generated `switch`: `case "all"` first, then one case per feature.
    if (dsEquals(name, ds("all"))) {
        for (const t of features) {
            if (t.deprecated_)
                continue;
            setFlagFor(groupName, params, t.paramName);
        }
        return true;
    }
    for (const t of features) {
        if (!dsEquals(name, t.name))
            continue;
        if (t.deprecated_)
            deprecation(Loc.initial, dsConcat(ds("`-" + groupName + "="), t.name, ds("` no longer has any effect.")));
        setFlagFor(groupName, params, t.paramName);
        return true;
    }
    // mars.d:526-530
    if (dsEquals(name, ds("?")) || dsEquals(name, ds("h")) || dsEquals(name, ds("help"))) {
        // `mixin("params.help." ~ groupName ~ " = true;")`
        if (groupName === "transition")
            params.help.transition = true;
        else if (groupName === "preview")
            params.help.preview = true;
        else
            params.help.revert = true;
        return true;
    }
    return false;
}

/** `-transition=<name>` (mars.d:538), called by ldc2's driver (driver/main.cpp:439). */
export function parseTransitionOption(params: Param, name: DString): void {
    if (parseCLIOption("transition", Usage.transitions, params, name))
        return;

    // undocumented legacy -transition flags (before 2.085)
    const dname = dsToJs(name);
    switch (dname) {
        case "3449":
            params.v.field = true;
            break;
        case "14246":
        case "dtorfields":
            params.dtorFields = FeatureState.enabled;
            break;
        case "14488":
            break;
        case "16997":
        case "intpromote":
            deprecation(Loc.initial, ds("`-transition=%s` is now the default behavior"), name);
            break;
        default:
            error(Loc.initial, ds("transition `%s` is invalid"), name);
            params.help.transition = true;
            break;
    }
}

/** `-preview=<name>` (mars.d:567), called by ldc2's driver (driver/main.cpp:441). */
export function parsePreviewOption(params: Param, name: DString): void {
    if (!parseCLIOption("preview", Usage.previews, params, name)) {
        error(Loc.initial, ds("Preview `%s` is invalid"), name);
        params.help.preview = true;
    }
}

/** `-revert=<name>` (mars.d:576), called by ldc2's driver (driver/main.cpp:443). */
export function parseRevertOption(params: Param, name: DString): void {
    if (!parseCLIOption("revert", Usage.reverts, params, name)) {
        error(Loc.initial, ds("Revert `%s` is invalid"), name);
        params.help.revert = true;
    }
}

/**
 * Creates the module for one command-line file, or files it by extension into the matching `params` list
 * (mars.d:1989). Returns: `{ err, m }` — `err` true on error (reported through `eSink`); `m` null when the
 * file is not a source (object, library, ddoc, json, map files).
 */
function createModule(file: DString, libmodules: DString[], params: Param, target: Target,
    eSink: ErrorSink): { err: boolean; m: Module | null } {
    const p = FileName.name(file); // strip path
    const ext = FileName.ext(p);
    const loc = Loc.singleFilename(file);
    if (!ext) {
        if (!p.length) {
            eSink.error(Loc.initial, ds("invalid file name '%s'"), file);
            return { err: true, m: null };
        }
        const id = Identifier.idPool(p);
        const m = new Module(loc, file, id, params.ddoc.doOutput ? 1 : 0, params.dihdr.doOutput ? 1 : 0);
        return { err: false, m };
    }

    /* Deduce what to do with a file based on its extension
        */
    if (FileName.equals(ext, ds("obj")) || FileName.equals(ext, ds("o"))) {
        params.objfiles.push(file);
        libmodules.push(file);
        return { err: false, m: null };
    }
    // Detect LLVM bitcode files on commandline
    if (FileName.equals(ext, bc_ext)) {   // `IN_LLVM &&` is the manifest true
        global.params.bitcodeFiles.push(file);
        return { err: false, m: null };
    }
    if (FileName.equals(ext, target.lib_ext)) {
        params.libfiles.push(file);
        libmodules.push(file);
        return { err: false, m: null };
    }
    // IN_LLVM replaced: if (target.os & (Target.OS.linux | ...))
    if (target.os !== OS.Windows) {
        if (FileName.equals(ext, target.dll_ext)) {
            params.dllfiles.push(file);
            libmodules.push(file);
            return { err: false, m: null };
        }
    }
    if (FileName.equals(ext, ddoc_ext)) {
        params.ddoc.files.push(file);
        return { err: false, m: null };
    }
    if (FileName.equals(ext, json_ext)) {
        params.json.doOutput = true;
        params.json.name = file;
        return { err: false, m: null };
    }
    if (FileName.equals(ext, map_ext)) {
        params.mapfile = file;
        return { err: false, m: null };
    }
    if (target.os === OS.Windows) {
        if (FileName.equals(ext, ds("res"))) {
            params.resfile = file;
            return { err: false, m: null };
        }
        if (FileName.equals(ext, ds("def"))) {
            params.deffile = file;
            return { err: false, m: null };
        }
        if (FileName.equals(ext, ds("exe")))
            assertUnreachable(); // should have already been handled
    }
    /* Examine extension to see if it is a valid
     * D, Ddoc or C source file extension
     */
    if (FileName.equals(ext, mars_ext) ||
        FileName.equals(ext, hdr_ext) ||
        FileName.equals(ext, dd_ext) ||
        FileName.equals(ext, c_ext) ||
        FileName.equals(ext, h_ext) ||
        FileName.equals(ext, i_ext)) {
        // strip off .ext
        const name = p.subarray(0, p.length - ext.length - 1); // -1 for the .
        if (!name.length || dsEquals(name, ds("..")) || dsEquals(name, ds("."))) {
            eSink.error(Loc.initial, ds("invalid file name '%s'"), file);
            return { err: true, m: null };
        }
        /* name is the D source file name stripped of
         * its path and extension.
         */
        const id = Identifier.idPool(name);
        const m = new Module(loc, file, id, params.ddoc.doOutput ? 1 : 0, params.dihdr.doOutput ? 1 : 0);
        return { err: false, m };
    }
    eSink.error(Loc.initial, ds("unrecognized file extension %.*s"), ext.length, ext);
    return { err: true, m: null };
}

/**
 * Creates the list of modules for the command-line `files` (mars.d:2125), dispatching non-sources into the
 * `params` lists by extension and binaries into `libmodules`; with `params.readStdin`, appends the module
 * `__stdin` whose source is read from standard input.
 * Returns: `{ err, modules }` — `err` true on error (reported through `eSink`).
 */
export function createModules(files: readonly DString[], libmodules: DString[], params: Param, target: Target,
    eSink: ErrorSink): { err: boolean; modules: Modules } {
    const modules: Modules = new DArray<Module | null>();   // `out Modules`
    let firstModuleObjectFileIndex = -1;   // version (IN_LLVM), mars.d:2131 — `size_t.max`
    for (const file of files) {
        const r = createModule(file, libmodules, params, target, eSink);
        if (r.err)
            return { err: true, modules };

        if (r.m === null)
            continue;

        modules.push(r.m);
        if (!params.oneobj || firstModuleObjectFileIndex === -1) {   // version (IN_LLVM), mars.d:2149
            global.params.objfiles.push(moduleObjfileToken(r.m)); // defer to a later stage after parsing
            if (firstModuleObjectFileIndex === -1)
                firstModuleObjectFileIndex = global.params.objfiles.length - 1;
        }
    }

    // version (IN_LLVM) `scope(exit)` (mars.d:2166): runs on every exit below.
    try {
        // Special module representing `stdin`
        if (params.readStdin) {
            const r = createModule(ds("__stdin.d"), libmodules, params, target, eSink);
            if (r.err)
                return { err: true, modules };
            if (r.m === null)
                return { err: false, modules };
            const m = r.m;

            modules.push(m);

            // Set the source file contents of the module
            const buf = new OutBuffer();
            if (readFromStdin(buf, eSink))
                return { err: true, modules };        // propagate error
            m.src = buf.extractSlice();

            // Give unique outfile name
            const namebuf = new OutBuffer();
            namebuf.printf(ds("__stdin_%d"), process.pid);

            const filename = FileName.forceExt(namebuf.extractSlice(), target.obj_ext);
            m.objfile = new FileName(filename);

            if (!params.oneobj || firstModuleObjectFileIndex === -1) {   // version (IN_LLVM), mars.d:2207
                global.params.objfiles.push(moduleObjfileToken(m)); // defer to a later stage after parsing
                if (firstModuleObjectFileIndex === -1)
                    firstModuleObjectFileIndex = global.params.objfiles.length - 1;
            }
        }

        return { err: false, modules };
    } finally {
        // When compiling to a single object file, move that object file to the
        // beginning of the object files list.
        if (params.oneobj && modules.length > 0 && firstModuleObjectFileIndex !== 0) {
            const fn = global.params.objfiles.opIndex(firstModuleObjectFileIndex);
            global.params.objfiles.remove(firstModuleObjectFileIndex);
            global.params.objfiles.insert(0, fn);
        }
    }
}

const objfileTokens = new WeakMap<Module, DString>();

/**
 * Returns: the token that stands for `m` in `params.objfiles` until main.d:600-610 replaces it with the object
 * file name — D's `cast(const(char)*)m` (mars.d:2151). The same object on every call for one Module, distinct
 * across Modules; callers compare it with `===`, never `dsEquals` (every token is empty).
 */
export function moduleObjfileToken(m: Module): DString {
    let t = objfileTokens.get(m);
    if (t === undefined) {
        t = new Uint8Array(0);
        objfileTokens.set(m, t);
    }
    return t;
}

/**
 * Returns: a module `__main`, run through every semantic pass, holding an empty `main()` (mars.d:2225), for
 * `-main`.
 */
export function moduleWithEmptyMain(): Module {
    const result = new Module(Loc.initial, ds("__main.d"), Identifier.idPool(ds("__main")), 0, 0);
    // need 2 trailing nulls for sentinel and 2 for lexer — the port's lexer does not read past the end, and
    // D slices the four NULs off again (`data[0 .. $-4]`).
    result.src = ds("version(D_BetterC)extern(C)int main(){return 0;}else int main(){return 0;}");
    result.parse();
    result.importedFrom = result;
    // `result` IS-A Dsymbol; Module.errors (uint) shadows Dsymbol.errors (bool) (dmodule.ts:168).
    // upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool)
    const d = result as unknown as Dsymbol;
    importAll(d, null);
    dsymbolSemantic(d, null);
    semantic2(d, null);
    semantic3(d, null);
    return result;
}

/**
 * Reads all of standard input into `sink` (mars.d:2248). Returns: true on error, reported through `eSink`.
 * D reads in 128 KiB chunks with `fread` and pads 16 NULs past the end (excluded from the length); one
 * blocking `readFileSync(0)` yields the same bytes.
 */
function readFromStdin(sink: OutBuffer, eSink: ErrorSink): boolean {
    let bytes: Uint8Array;
    try {
        bytes = readFileSync(0);
    } catch (e) {
        // readFileSync throws a Node system error, which carries `errno` (libuv's negative code)
        const errno = (e as NodeJS.ErrnoException).errno ?? 0;
        eSink.error(Loc.initial, ds("cannot read from stdin, errno = %d"), -errno);   // libuv errnos are negative
        return true;
    }
    sink.write(bytes);
    return false;
}
