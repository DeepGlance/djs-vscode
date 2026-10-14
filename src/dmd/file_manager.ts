// Ported from dmd/file_manager.d (module dmd.file_manager).
//
// Cycle C member: file_manager ↔ globals. `mars_ext`/`hdr_ext`/… and `ImportPathInfo` come from
// globals (value imports used in bodies and at the two module-const concatenations below — those
// concatenations read globals' ALREADY-evaluated `mars_ext`/`hdr_ext` DStrings, which are top-level
// consts that evaluate before this module if the shim imports globals first; to stay cycle-safe we
// build `package_d`/`package_di` lazily on first use instead of at top level, 01 §4.5).

import { ds, dsConcat, type DString } from "../dstring.js";
import { assertUnreachable } from "../assert.js";
import { OutBuffer } from "./common/outbuffer.js";
import { StringTable } from "./root/stringtable.js";
import { File } from "./root/file.js";
import { FileName, isDirSeparator } from "./root/filename.js";
import { toDString } from "./root/string.js";
import {
    type ImportPathInfo,
    mars_ext,
    hdr_ext,
    i_ext,
    h_ext,
    c_ext,
} from "./globals.js";
import { xarraydup } from "./root/rmem.js";

// enum package_d  = "package." ~ mars_ext;  (file_manager.d:23)
// enum package_di = "package." ~ hdr_ext;   (file_manager.d:24)
// D manifest enums concatenating module-const DStrings. Built lazily (memoized) so the read of
// globals' `mars_ext`/`hdr_ext` happens at call time, not at module-eval time (cycle-safe, 01 §4.5).
let _package_d: DString | null = null;
let _package_di: DString | null = null;
export function package_d(): DString {
    if (_package_d === null) _package_d = dsConcat(ds("package."), mars_ext);
    return _package_d;
}
export function package_di(): DString {
    if (_package_di === null) _package_di = dsConcat(ds("package."), hdr_ext);
    return _package_di;
}

/// Returns: whether a file with `name` is a special "package.d" module (file_manager.d:27).
/// `scope FileName fileName` -> the FileName ref. `nothrow` erases.
export function isPackageFileName(fileName: FileName): boolean {
    return FileName.equals(fileName.nameOf(), package_d()) || FileName.equals(fileName.nameOf(), package_di());
}

/**
 * A path stack that allows one to go up and down the path using directory separators (file_manager.d:35).
 * `cur` is the current path, `up`/`down` move one path component (returns false when no further).
 * `private struct PathStack` — module-private value struct; touched by sibling PathCache, so emitted
 * without TS `private` on the class (01 §2.5). `@safe @nogc nothrow pure` erase.
 */
class PathStack {
    path: DString; // D module-private (read by PathCache)
    pos: number; // D module-private

    constructor(p: DString) {
        this.path = p;
        this.pos = p.length;
    }

    cur(): DString {
        return this.path.subarray(0, this.pos); // path[0 .. pos] — a view
    }

    up(): boolean {
        if (this.pos === 0) return false;
        while (--this.pos !== 0) if (isDirSeparator(this.path[this.pos])) return true;
        return false;
    }

    down(): boolean {
        if (this.pos === this.path.length) return false;
        while (++this.pos !== this.path.length) if (isDirSeparator(this.path[this.pos])) return true;
        return false;
    }
}

/**
 * Cache path lookups so the operating system is only consulted once for each path (file_manager.d:78).
 * `private struct PathCache` — module-private value struct; touched by sibling FileManager, so emitted
 * without TS `private` on the class (01 §2.5).
 */
class PathCache {
    pathStatus: StringTable<boolean> = new StringTable<boolean>(); // cached value of does a path exist or not

    // nothrow: (file_manager.d:86) — ERASE.

    /**
     * Determine if the path part of path/filename exists (file_manager.d:96). Cache the results for
     * the path and each left-justified subpath. Returns: true if path exists.
     */
    pathExists(filespec: DString): boolean {
        // look for the longest leftmost parent path that is cached, scanning right-to-left
        let exists = true;
        const st = new PathStack(filespec);
        while (st.up()) {
            const cached = this.pathStatus.lookup(st.cur());
            if (cached) {
                exists = cached.value;
                break;
            }
        }
        // found a parent path that is cached (or reached the left end); now move right caching the
        // results. Once a directory is found to not exist, all directories to its right do not exist.
        while (st.down()) {
            if (!exists) {
                this.pathStatus.insert(st.cur(), false);
            } else {
                // FileName.exists(...) == 2 means "is a directory". `.insert(...).value` reads the new
                // entry's value (insert NEVER returns null here — st.cur() subpaths are distinct).
                const inserted = this.pathStatus.insert(st.cur(), FileName.exists(st.cur()) === 2);
                // boundary trust: insert on a fresh subpath returns the new StringValue (08 §5 contract)
                exists = inserted!.value;
            }
        }

        return exists;
    }

    /**
     * Ask if path ends in a directory (file_manager.d:135). Cache result for speed. Returns: true if
     * it's a path, false if not.
     */
    isExistingPath(path: DString): boolean {
        let cached = this.pathStatus.lookup(path);
        if (!cached) cached = this.pathStatus.insert(path, FileName.exists(path) === 2);
        // `cached` is non-null after either branch (lookup-hit or fresh insert).
        return cached!.value;
    }
}

/**
 * `final class FileManager` (file_manager.d:144) — caches read file contents and path lookups. A
 * reference class. `private StringTable!(...) files` / `private PathCache pathCache` are touched only
 * inside FileManager's own methods, so they stay TS `private`.
 */
export class FileManager {
    private files: StringTable<DString> = new StringTable<DString>(); // contents of files indexed by file name

    private pathCache: PathCache = new PathCache();

    /// (file_manager.d:151) `this()` — D `_init()`s the two StringTables; in the port they are already
    /// constructed (the field initializers above). `_init()` is a no-op capacity hint (08 §5).
    constructor() {
        this.files._init();
        this.pathCache.pathStatus._init();
    }

    // nothrow: (file_manager.d:157) — ERASE.

    /**
     * Look for the source file if it's different from filename (file_manager.d:170). Look for .di,
     * .d, directory, and along global.path. Does not open the file.
     * Params:
     *   filename = as supplied by the user
     *   pathsInfo = pathsInfo to look for filename with metadata
     *   whichPathFoundThis = OUT param (box): which path was used, or -1 if unknown (03 §3.3).
     * Returns: the found file name, or null if not different from filename.
     */
    lookForSourceFile(
        filename: DString,
        pathsInfo: readonly ImportPathInfo[],
        whichPathFoundThis: { value: number },
    ): DString | null {
        whichPathFoundThis.value = -1;

        // List of extensions to match, in order of precedence (file_manager.d:179).
        const extensions: DString[] = [FileName.forceExt(filename, hdr_ext), FileName.forceExt(filename, mars_ext)];
        const importCextensions: DString[] = [
            FileName.forceExt(filename, i_ext),
            FileName.forceExt(filename, h_ext),
            FileName.forceExt(filename, c_ext),
        ];
        // scope(exit) { foreach (ext; extensions) FileName.free(ext.ptr); … } — FileName.free is a
        // GC no-op in the port (08), so the cleanup is a no-op; emit a try/finally for fidelity (06 §7.1).
        try {
            // Search for all combinations of files (mod.di, mod.d, mod/package.d, ...) within `path`
            // (file_manager.d:199). Nested function -> inner arrow (inherits `this`, captures
            // extensions/importCextensions/filename) (04 §5).
            const lookForSourceFileInPath = (path: DString | null): DString | null => {
                // When checking for modules locally, combine won't allocate a new string.
                const checkLocal = path === null;
                // freePath is a GC no-op (FileName.free); kept for structure (file_manager.d:203).
                const freePath = (_p: DString): void => {
                    if (checkLocal) return;
                    // FileName.free(p.ptr) — no-op (GC)
                };

                const p = FileName.combine(path, filename);
                try {
                    if (!this.pathCache.pathExists(p)) return null; // no need to check for anything else.

                    // Search for any file matching {path}/{file}.{ext}.
                    for (const ext of extensions) {
                        const file = FileName.combine(path, ext);
                        if (FileName.exists(file) === 1) {
                            // checkLocal ? file.xarraydup : file
                            return checkLocal ? xarraydup(file) : file;
                        }
                        freePath(file);
                    }

                    const n = FileName.combine(path, FileName.sansExt(filename));
                    try {
                        if (this.pathCache.isExistingPath(n)) {
                            // The filename exists but it's a directory. Therefore the result should be
                            // filename/package.d iff filename/package.d is a file.
                            const ni = FileName.combine(n, package_di());
                            if (FileName.exists(ni) === 1) return ni;
                            FileName.free(ni);

                            const nd = FileName.combine(n, package_d());
                            if (FileName.exists(nd) === 1) return nd;
                            FileName.free(nd);
                        }

                        // Search for any file with importC extensions after all attempts to find a D
                        // module/package in the path are exhausted.
                        for (const ext of importCextensions) {
                            const file = FileName.combine(path, ext);
                            if (FileName.exists(file) === 1) {
                                return checkLocal ? xarraydup(file) : file;
                            }
                            freePath(file);
                        }
                        return null;
                    } finally {
                        freePath(n); // scope(exit) freePath(n)
                    }
                } finally {
                    freePath(p); // scope(exit) freePath(p)
                }
            };

            // First see if module is found in any search paths.
            if (!FileName.absolute(filename)) {
                for (let pathIndex = 0; pathIndex < pathsInfo.length; pathIndex++) {
                    const entry = pathsInfo[pathIndex];
                    const s = lookForSourceFileInPath(toDString(entry.path));
                    if (s) {
                        whichPathFoundThis.value = pathIndex;
                        return s;
                    }
                }
            }
            // No modules found, check for the module locally.
            const sLocal = lookForSourceFileInPath(null);
            if (sLocal) return sLocal;

            return null;
        } finally {
            // scope(exit) cleanup — FileName.free is a no-op (GC); nothing to free.
        }
    }

    /**
     * Retrieve the cached contents of the file given by `filename` (file_manager.d:289). If not read
     * before, read it and add the contents to the cache. Returns: the contents, or null if it could
     * not be read or was empty.
     */
    getFileContents(filename: FileName): DString | null {
        const name = filename.toString();
        const val = this.files.lookup(name); // if `name` is cached
        if (val) return val.value; // return its contents

        if (FileName.exists(name) !== 1) return null; // if not an ordinary file

        const buf = new OutBuffer();
        if (File.read(name, buf)) return null; // failed

        buf.write32(0); // terminating dchar 0

        const length = buf.length();
        // cast(ubyte[])(buf.extractSlice()[0 .. length - 4]) — drop the 4-byte terminating dchar.
        const fb = buf.extractSlice().subarray(0, length - 4);
        if (this.files.insert(name, fb) === null) {
            return assertUnreachable("Insert after lookup failure should never return `null`");
        }

        return fb;
    }

    /**
     * Adds the contents of a file to the table (file_manager.d:320). Returns: the buffer added, or null.
     */
    add(filename: FileName, buffer: DString): DString | null {
        const val = this.files.insert(filename.toString(), buffer);
        return val === null ? null : val.value;
    }
}
