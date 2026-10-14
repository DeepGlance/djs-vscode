// Port of dmd/root/filename.d — FileName: path/file-name manipulation.
// Contract: docs/porting/08-runtime-lib.md §14.2 (+ §0 byte-string invariants, _config.md §6 POSIX).
// Read §14.2 before editing.
//
// MINIMAL per §14.2: the frontend calls a small subset of FileName. Pure string/path ops
// translate to byte-slice (DString) manipulation; a handful touch the filesystem
// (`exists`, `canonicalName`, `searchPath`, `toAbsolute`, `ensurePathExists`) and use node:fs.
//
// GOVERNING TRANSLATIONS:
//   - A D `const(char)[]` / `string` / `const(char)*` is a DString (Uint8Array) byte view; the
//     C++ `const(char)*` overloads (which only `.toDString()` then forward to the slice form)
//     collapse into the single DString-taking function — no separate pointer overload (§14.2).
//   - resolved: version(Windows) -> false (target = POSIX, _config.md). All Windows path branches
//     dropped; the POSIX `else` is kept. `isDirSeparator` is therefore just `c == '/'`.
//   - resolved: version(Posix) -> true. resolved: version(CRuntime_Glibc) -> Node fs (flag #6).
//   - `mem.xmalloc` + `memcpy` path-building is raw-allocation plumbing → replaced by DString
//     slicing / fresh Uint8Array; `FileName.free` is a GC no-op (§14.2).
//   - Not-found / "no extension" sentinels: D `size_t.max` -> SIZE_MAX (09 §1.3).

// resolved: version(Windows) -> false. The only consumer of `Port` (memicmp in the Windows branch
// of `equals`, filename.d:109) is dropped on POSIX, so `Port` is not imported here.
import { ds, dsConcat, dsEquals, dsToJs } from "../../dstring.js";
import type { DString } from "../../dstring.js";
import { SIZE_MAX } from "../../numeric.js";
import * as fs from "node:fs";

// Byte constants for the separators / extension dot used throughout (DString is bytes).
const SLASH = 0x2f; // '/'
const DOT = 0x2e; // '.'

/// Check whether a byte is a directory separator (filename.d:58).
/// resolved: version(Posix) -> only '/' (Windows '\\' branch dropped, _config.md).
export function isDirSeparator(c: number): boolean {
    return c === SLASH;
}

/**
 * `FileName` — encapsulates a path/file-name (filename.d:77). A value struct wrapping a single
 * `const(char)[] str` (a DString byte slice). In the port it is a small class; the bulk of the
 * type is `static` path helpers (no instance state), with a handful of instance methods that
 * operate on the wrapped `str`.
 *
 * Value semantics: D's `FileName` is a struct, but it holds only a slice (a reference-like view)
 * and is immutable after construction here (the one mutator, IN_LLVM `reset`, reassigns `str`).
 * Sharing the instance is safe for the immutable-after-construction usage; the `reset` mutator is
 * kept for fidelity (it replaces the whole `str`, not a sub-field).
 */
export class FileName {
    // The wrapped path bytes (filename.d:80 `private const(char)[] str`).
    private str: DString;

    /// this(const char[] str) (filename.d:83). D does `str.xarraydup` (an independent copy);
    /// reproduced with `slice()` so the FileName owns its bytes.
    constructor(str: DString) {
        this.str = str.slice();
    }

    /// create(const(char)* name) (filename.d:89) — C++ ctor wrapper. A `const(char)*` is already
    /// a DString in the port, so this is just `new FileName(name)`.
    static create(name: DString): FileName {
        return new FileName(name);
    }

    // ── equals ──────────────────────────────────────────────────────────────────────────────────

    /// equals(name1, name2) (filename.d:101) — platform path equality.
    /// resolved: version(Windows) -> false; POSIX compares the exact bytes (§14.2 invariant).
    static equals(name1: DString, name2: DString): boolean {
        if (name1.length !== name2.length) return false;
        return dsEquals(name1, name2);
    }

    // ── absolute ────────────────────────────────────────────────────────────────────────────────

    /// absolute(name) (filename.d:130) — is the path absolute?
    /// resolved: version(Posix) -> a leading '/' (the Windows drive-letter branch is dropped).
    static absolute(name: DString): boolean {
        if (!name.length) return false;
        return isDirSeparator(name[0]);
    }

    // ── toAbsolute (filesystem: CWD) ─────────────────────────────────────────────────────────────

    /**
     * toAbsolute(name, base=null) (filename.d:172) — return `name` as an absolute path, prefixing
     * `base` (defaulting to the CWD via `getcwd`) when `name` is relative.
     * resolved: version(CRuntime_Glibc) `getcwd(null,0)` -> Node `process.cwd()` (flag #1/#6).
     */
    static toAbsolute(name: DString, base: DString | null = null): DString {
        const base_ = base ?? ds(process.cwd());
        return FileName.absolute(name) ? name : FileName.combine(base_, name);
    }

    // ── ext / removeExt / sansExt ────────────────────────────────────────────────────────────────

    /**
     * ext(str) (filename.d:194) — the file-name extension as a slice of `str`, the part PAST the
     * '.', or `null` if there is none. Scans from the end; a '/' before any '.' means no extension.
     * resolved: version(Posix) -> only '/' terminates the scan (the Windows '\\'/':'/' branch dropped).
     * Returns a VIEW (subarray) into `str`.
     */
    static ext(str: DString): DString | null {
        for (let idx = str.length - 1; idx >= 0; idx--) {
            const e = str[idx];
            if (e === DOT) return str.subarray(idx + 1);
            if (e === SLASH) return null;
            // default: continue
        }
        return null;
    }

    /**
     * removeExt(str) (filename.d:254) — `str` without its extension (and without the dot).
     * D xmalloc's a copy; the port returns a fresh DString. When there is no extension, D returns
     * `xstrdup(str)` — an independent copy of the whole string.
     */
    static removeExt(str: DString): DString {
        const e = FileName.ext(str);
        if (e && e.length) {
            const len = str.length - e.length - 1; // -1 for the dot
            return str.slice(0, len);
        }
        return str.slice();
    }

    /**
     * sansExt(filename) (filename.d:281) — the slice of `filename` without its extension. Unlike
     * `removeExt` this returns a VIEW (no allocation). `+1` accounts for the dot when present.
     */
    static sansExt(filename: DString): DString {
        const e = FileName.ext(filename);
        const length = e ? e.length : 0;
        return filename.subarray(0, filename.length - (length ? length + 1 : 0));
    }

    // ── name / path / replaceName ────────────────────────────────────────────────────────────────

    /**
     * name(str) (filename.d:297) — the file-name excluding the path (the basename). A VIEW into `str`.
     * resolved: version(Posix) -> only '/' is a separator (the Windows '\\'/ADS-':' branch dropped).
     */
    static name(str: DString): DString {
        for (let idx = str.length - 1; idx >= 0; idx--) {
            if (str[idx] === SLASH) return str.subarray(idx + 1);
            // default: break — but D's `break` only exits the switch, the foreach continues;
            // so we keep scanning. (The POSIX switch has no early-loop-exit.)
        }
        return str;
    }

    /**
     * path(str) (filename.d:352) — the directory portion of `str`, WITHOUT a trailing separator.
     * D xmalloc's a copy; the port returns a fresh DString of `[0 .. pathlen)`.
     */
    static path(str: DString): DString {
        const n = FileName.name(str);
        let hasTrailingSlash = false;
        if (n.length < str.length) {
            if (isDirSeparator(str[str.length - n.length - 1])) hasTrailingSlash = true;
        }
        const pathlen = str.length - n.length - (hasTrailingSlash ? 1 : 0);
        return str.slice(0, pathlen);
    }

    /**
     * replaceName(path, name) (filename.d:377) — replace the file-name portion of `path` with `name`.
     * If `name` is absolute it is returned as-is; if `path` has no directory portion, `name` is
     * returned; otherwise `combine(dir-of-path, name)`.
     */
    static replaceName(path: DString, name: DString): DString {
        if (FileName.absolute(name)) return name;
        const n = FileName.name(path);
        if (dsEquals(n, path)) return name;
        return FileName.combine(path.subarray(0, path.length - n.length), name);
    }

    // ── combine / buildPath ──────────────────────────────────────────────────────────────────────

    /**
     * combine(path, name) (filename.d:406) — join `path` and `name` with a separator. An empty
     * `path` yields `name`. (D's C++ overload returns `name` for a null `path`; null collapses to
     * "empty path" here since a DString carries its own emptiness.)
     */
    static combine(path: DString | null, name: DString): DString {
        if (!path || !path.length) return name;
        return FileName.buildPath(path, name);
    }

    /**
     * buildPath(...fragments) (filename.d:420) — concatenate path fragments, inserting a '/' between
     * any two non-empty fragments that do not already end in a separator. Empty fragments are
     * skipped. An all-empty / empty input yields an empty path.
     * resolved: version(Posix) -> separator '/' (the Windows '\\'/':' branch dropped).
     *
     * D builds into one xmalloc'd buffer and overwrites the final trailing slash with NUL; the port
     * builds a JS byte array and slices it (no NUL — DString carries its length).
     */
    static buildPath(...fragments: (DString | null)[]): DString {
        const out: number[] = [];
        for (const f of fragments) {
            if (!f || !f.length) continue;
            for (let i = 0; i < f.length; i++) out.push(f[i]);
            const last = out[out.length - 1];
            if (!isDirSeparator(last)) out.push(SLASH);
        }
        // Overwrite/strip the last trailing separator (D: `p[length ? --length : 0] = 0`).
        if (out.length) out.pop();
        return Uint8Array.from(out);
    }

    // ── addExt / defaultExt / forceExt ───────────────────────────────────────────────────────────

    /**
     * addExt(name, ext) (filename.d:593) — append `.` + `ext` to `name` regardless of `name`'s
     * current content. D allocates `name.length + ext.length + 2` (the +2 = dot + NUL) and returns
     * the slice excluding the NUL; the port returns `name ~ "." ~ ext`.
     */
    static addExt(name: DString, ext: DString): DString {
        return dsConcat(name, ds("."), ext);
    }

    /**
     * defaultExt(name, ext) (filename.d:614) — add `.ext` only if `name` has NO extension already;
     * otherwise return a copy of `name`.
     */
    static defaultExt(name: DString, ext: DString): DString {
        const e = FileName.ext(name);
        if (e && e.length) return name.slice(); // already has an extension (D: xarraydup)
        return FileName.addExt(name, ext);
    }

    /**
     * forceExt(name, ext) (filename.d:638) — replace `name`'s extension with `ext` (adding one if
     * absent). When an extension is present, the new name is `name-without-ext-and-dot ~ "." ~ ext`.
     */
    static forceExt(name: DString, ext: DString): DString {
        const e = FileName.ext(name);
        if (e) {
            return FileName.addExt(name.subarray(0, name.length - e.length - 1), ext);
        }
        return FileName.defaultExt(name, ext); // doesn't have one
    }

    // ── equalsExt ────────────────────────────────────────────────────────────────────────────────

    /**
     * equalsExt(name, ext) (filename.d:660) — true iff `name`'s extension equals `ext`. Both-empty
     * counts as equal; one-empty is not. The extension compare uses platform `FileName.equals`
     * (POSIX: exact bytes).
     */
    static equalsExt(name: DString, ext: DString): boolean {
        const e = FileName.ext(name);
        const eLen = e ? e.length : 0;
        if (!eLen && !ext.length) return true;
        if (!eLen || !ext.length) return false;
        return FileName.equals(e!, ext);
    }

    // ── findReservedChar / refersToParentDir ─────────────────────────────────────────────────────

    /**
     * findReservedChar(name) (filename.d:765) — index of the first reserved path character, or
     * SIZE_MAX if none. resolved: version(Windows) -> false, so POSIX has NO reserved characters
     * and this always returns SIZE_MAX (the Windows `< > : " | ? *` scan is dropped).
     */
    static findReservedChar(_name: DString): number {
        return SIZE_MAX;
    }

    /**
     * refersToParentDir(name) (filename.d:814) — true iff `name` contains a `..` path component
     * (a segment delimited by separators, or the trailing segment, that is exactly "..").
     */
    static refersToParentDir(name: DString): boolean {
        const dotdot = ds("..");
        let s = 0;
        for (let i = 0; i < name.length; i++) {
            if (isDirSeparator(name[i])) {
                if (dsEquals(name.subarray(s, i), dotdot)) return true;
                s = i + 1;
            }
        }
        if (dsEquals(name.subarray(s), dotdot)) return true;
        return false;
    }

    // ── exists (filesystem) ──────────────────────────────────────────────────────────────────────

    /**
     * exists(name) (filename.d:872) — does the path exist, and what is it? Returns an INT CODE
     * (NOT a bool, §14.2 invariant): 0 = does not exist (or empty name), 1 = exists & not a dir,
     * 2 = exists & is a directory.
     * resolved: version(Posix) `stat` -> Node `fs.statSync` (flag #1/#6 — behavioral substitution).
     */
    static exists(name: DString): number {
        if (!name.length) return 0;
        try {
            const st = fs.statSync(dsToJs(name));
            return st.isDirectory() ? 2 : 1;
        } catch {
            return 0; // stat failed -> does not exist
        }
    }

    // ── canonicalName (filesystem) ───────────────────────────────────────────────────────────────

    /**
     * canonicalName(name) (filename.d:994) — the canonical (realpath-resolved) form of `name`.
     * resolved: version(Posix) realpath/canonicalize_file_name -> Node `fs.realpathSync`
     * (flag #6 — behavioral substitution; symlink/missing-path semantics differ from glibc).
     * On any error D falls back to duplicating the name (or null for an empty name).
     */
    static canonicalName(name: DString): DString | null {
        try {
            return ds(fs.realpathSync(dsToJs(name)));
        } catch {
            // Give up; duplicate the filename unless there is nothing to copy from.
            if (!name.length) return null;
            return name.slice();
        }
    }

    // ── searchPath (filesystem) ──────────────────────────────────────────────────────────────────

    /**
     * searchPath(path, name, cwd) (filename.d:700) — search the directory list `path` for `name`.
     * If `name` is absolute, return it iff it exists. If `cwd`, check the current directory first.
     * Then try `combine(p, name)` for each `p`; return the first that exists, else null.
     * (`mem.xfree` of non-matching combinations is dropped — GC.)
     */
    static searchPath(path: readonly DString[], name: DString, cwd: boolean): DString | null {
        if (FileName.absolute(name)) {
            return FileName.exists(name) ? name : null;
        }
        if (cwd) {
            if (FileName.exists(name)) return name;
        }
        for (const p of path) {
            const n = FileName.combine(p, name);
            if (FileName.exists(n)) return n;
        }
        return null;
    }

    // ── ensurePathExists (filesystem) ────────────────────────────────────────────────────────────

    /**
     * ensurePathExists(path) (filename.d:919) — ensure the directory of `path` exists, creating
     * parents as needed (mkdir -p). Accepts a path to a file or directory. Returns true on success.
     * resolved: version(Posix) `mkdir` + `errno == EEXIST` -> Node `fs.mkdirSync`; a pre-existing
     * directory is success (flag #1/#6).
     */
    static ensurePathExists(path: DString): boolean {
        if (!path.length) return true;
        if (FileName.exists(path)) return true;

        // Recurse to ensure the parent directory exists.
        const p = FileName.path(path);
        if (p.length) {
            const r = FileName.ensurePathExists(p);
            if (!r) return r;
        }

        try {
            fs.mkdirSync(dsToJs(path), 0o777);
            return true;
        } catch (e) {
            // Don't error out if another instance just created this directory (errno == EEXIST).
            if (e && typeof e === "object" && (e as { code?: string }).code === "EEXIST") return true;
            return false;
        }
    }

    // ── free ────────────────────────────────────────────────────────────────────────────────────

    /// free(str) (filename.d:1100) — frees a C-string. NO-OP under GC (§14.2 invariant). The 12
    /// `FileName.free(x)` call sites drop the line; kept as a no-op for residual sites.
    static free(_str: DString | null): void {
        // GC frees — intentionally empty.
    }

    // ── instance methods (operate on the wrapped `str`) ──────────────────────────────────────────

    /// ext() (filename.d:230) — extension of the wrapped path.
    extOf(): DString | null {
        return FileName.ext(this.str);
    }

    /// name() (filename.d:330) — basename of the wrapped path.
    nameOf(): DString {
        return FileName.name(this.str);
    }

    /// equalsExt(ext) (filename.d:681) — does the wrapped path's extension equal `ext`?
    equalsExtInstance(ext: DString): boolean {
        return FileName.equalsExt(this.str, ext);
    }

    /// toChars() (filename.d:1110) / toString() (filename.d:1117) — the wrapped bytes. In djs a
    /// DString already carries its length and has no embedded NUL, so both return `str`.
    toChars(): DString {
        return this.str;
    }

    toString(): DString {
        return this.str;
    }

    /// opCast(bool) (filename.d:1122) — truthy iff the wrapped slice is non-null. In the port a
    /// FileName always has a `str`; this is true unless the slice is empty-from-a-null source.
    /// 05-operators.md owns the call-site `if (fn)` -> `if (fn.toBool())` rewrite.
    toBool(): boolean {
        return this.str.length > 0;
    }

    /// reset(str) (filename.d:1130, IN_LLVM) — replace the wrapped path. resolved: version(IN_LLVM)
    /// -> ON (we are LDC). D does `this = FileName(str)`; here we reassign `str` (an independent copy).
    reset(str: DString): void {
        this.str = str.slice();
    }

    // appendSplitPath / splitPath are NOT ported here — see the STOP stubs below.
}

/**
 * appendSplitPath(path, array) (filename.d:485) and splitPath(sink, path) (filename.d:503) split a
 * delimiter-separated PATH-environment string into fragments. They build each fragment in an
 * `OutBuffer` (constructed as a value, plus `~`/`HOME` expansion) — `common/outbuffer.ts` is a
 * Bucket-3 sibling NOT yet translated in this batch, so constructing one here is a load-time value
 * dependency on a module that does not exist. They are singletons (§14.2: appendSplitPath ×2,
 * splitPath ×1) outside the lex→sema→CTFE core this batch targets.
 */
export function appendSplitPath(_path: DString, _array: import("./array.js").Array<DString>): void {
    // DJS-ESCALATE: splitPath/appendSplitPath need OutBuffer construction (common/outbuffer.ts,
    // not yet translated) + HOME/~ expansion. (dmd/root/filename.d:485)
    throw new Error("DJS-ESCALATE: appendSplitPath not translated — see escalation report");
}
