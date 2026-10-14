// Port of dmd/common/file.d — file I/O utilities shared by frontend + backend.
// Contract: docs/porting/08-runtime-lib.md §14 (+ §0 byte-string invariants, _config.md §6 POSIX).
//
// MINIMAL per §14: of this module the frontend needs `writeFile` (called by root/File.write) and
// the POSIX directory scan `findFiles`. `FileMapping(Datum)` is a memory-mapped-file abstraction
// built on raw `mmap`/pointer arithmetic + `Datum[]` reinterpretation — there is no faithful JS
// translation of the mmap/pointer layout, and it is not on §14's needed list → STOP stub.
//
// GOVERNING TRANSLATIONS:
//   - resolved: version(Posix) -> true; version(Windows) -> false (_config.md). All Windows
//     branches (CreateFileW/extendedPathThen/WIN32_FIND_DATAW) dropped; the POSIX `else` kept.
//   - resolved: version(IN_LLVM) -> true (we are LDC) where it gates POSIX vs Windows code-page.
//   - A D `const(char)*` / `const(char)[]` is a DString; `const void[] data` is a Uint8Array.
//   - `mem.xrealloc_noscan` buffer-growth in findFiles is raw-alloc plumbing → a JS array; Node's
//     `fs.readdirSync`/`fs.statSync` replace `opendir`/`readdir`/`lstat`.

import { dsToJs } from "../../dstring.js";
import type { DString } from "../../dstring.js";
import { FileName } from "../root/filename.js";
import { dsEquals } from "../../dstring.js";
import * as fs from "node:fs";

/**
 * FileMapping(Datum) (common/file.d:80) — a memory-mapped file. Built on `mmap`/`munmap`,
 * raw `Datum* / Datum[]` reinterpretation of mapped pages, and pointer-sized handle bookkeeping.
 * There is no faithful JS model of the mmap'd page layout / pointer arithmetic, and §14 does not
 * list it among the members the lex→sema→CTFE pipeline needs.
 *
 * NOTE: kept as a class shell so any residual type reference compiles; every method STOP-stubs.
 */
export class FileMapping<Datum> {
    // DJS-ESCALATE: FileMapping is mmap + raw-pointer page reinterpretation; no faithful JS model
    // and not on §14's needed list. (dmd/common/file.d:80)
    constructor(_filename: DString) {
        throw new Error("DJS-ESCALATE: FileMapping not translated — see escalation report");
    }
    // The unused type parameter is retained to mirror D's `FileMapping(Datum)` signature.
    declare private readonly _datum: Datum;
}

/**
 * writeFile(name, data) (common/file.d:481) — write `data` to the file `name`, truncating/creating.
 * Returns `true` on SUCCESS, `false` on failure. On a partial/failed write D closes the fd and
 * `remove`s the file; the Node path writes the whole buffer atomically per the fs call and removes
 * the file on error.
 * resolved: version(Posix) open(O_CREAT|O_WRONLY|O_TRUNC, 0644) -> Node `fs.writeFileSync` (mode 0644).
 */
export function writeFile(name: DString, data: Uint8Array): boolean {
    const path = dsToJs(name);
    try {
        fs.writeFileSync(path, data, { mode: 0o644 });
        return true;
    } catch {
        // Best-effort cleanup of a partially written file (D: close + .remove(name)).
        try {
            fs.rmSync(path, { force: true });
        } catch {
            // ignore cleanup failure
        }
        return false;
    }
}

/**
 * touchFile(namez) (common/file.d:535) — set the file's modification time to now.
 * resolved: version(Posix) `utime(namez, null)` -> Node `fs.utimesSync(path, now, now)`.
 * Returns true on success.
 */
export function touchFile(namez: DString): boolean {
    try {
        const now = new Date();
        fs.utimesSync(dsToJs(namez), now, now);
        return true;
    } catch {
        return false;
    }
}

/**
 * findFiles(dir_path, exts, recurse, filenameSink) (common/file.d:623) — recursively walk
 * `dir_path`, calling `filenameSink(fullPath)` for every regular file whose extension matches one
 * of `exts`. Returns `true` on FAILURE to open the directory (D convention), `false` otherwise.
 * resolved: version(Posix) opendir/readdir/lstat -> Node `fs.readdirSync` + `fs.lstatSync`. Entries
 * starting with '.' are skipped (matching D's `entry.d_name[0] == '.'` guard, which also skips
 * "." and ".."). The raw `xrealloc_noscan` fullPath buffer becomes a built DString.
 */
export function findFiles(
    dir_path: DString,
    exts: readonly DString[],
    recurse: boolean,
    filenameSink: (name: DString) => void,
): boolean {
    let entries: string[];
    try {
        entries = fs.readdirSync(dsToJs(dir_path));
    } catch {
        return true; // failed to open the directory
    }

    const dirStr = dsToJs(dir_path);
    for (const entryName of entries) {
        if (entryName.length === 0 || entryName.charCodeAt(0) === 0x2e /* '.' */) {
            continue; // ignore entries starting with '.' (also covers "." and "..")
        }

        // fullPath = dir_path '/' entry
        const fullPathStr = `${dirStr}/${entryName}`;
        const fullPath = strToDString(fullPathStr);

        let st: fs.Stats;
        try {
            st = fs.lstatSync(fullPathStr);
        } catch {
            continue; // lstat failed (D: `if (lstat(...) == -1) continue;`)
        }

        const name = strToDString(entryName);
        if (st.isDirectory()) {
            if (recurse) findFiles(fullPath, exts, recurse, filenameSink);
        } else if (st.isFile()) {
            const nameExt = FileName.ext(name);
            for (const ext of exts) {
                if (nameExt && dsEquals(nameExt, ext)) {
                    filenameSink(fullPath);
                }
            }
        }
    }
    return false;
}

// A path component returned by Node is a JS string of file-name bytes; encode it back to a DString.
// Node decodes paths as UTF-8, so re-encode UTF-8 to recover the byte sequence the frontend uses.
function strToDString(s: string): DString {
    return new TextEncoder().encode(s);
}
