// Port of dmd/root/file.d — File: read/write a file to/from memory.
// Contract: docs/porting/08-runtime-lib.md §14.1 (+ §0 byte-string invariants, _config.md §6 POSIX).
//
// MINIMAL per §14.1: File.read (4), File.write (3), File.remove (5), File.update (1),
// File.removeDirectory (1), File.size. The `Buffer`/`ReadResult` ownership structs exist only to
// manage the rmem-allocated read buffer (raw `ubyte[]` + `~this` xfree) — with GC + an OutBuffer
// sink they have no role and are dropped (08 §0/§13).
//
// GOVERNING TRANSLATIONS:
//   - resolved: version(Posix) -> true; version(Windows) -> false (_config.md). open/fstat/read/
//     close -> Node `fs.readFileSync`; the Windows CreateFileW branch and the `linux`+`PPC` stat
//     workaround are dropped.
//   - resolved: version(IN_LLVM) -> true (we are LDC): `removeDirectory` is KEPT.
//   - File.read returns `true` on FAILURE, `false` on SUCCESS (D's inverted convention, §14.1) —
//     preserved exactly; see the signature comment.
//   - File.size returns `ulong.max` on error -> bigint domain (09-numerics.md); ULONG_MAX below.

import { dsToJs } from "../../dstring.js";
import type { DString } from "../../dstring.js";
import { writeFile } from "../common/file.js";
import * as fs from "node:fs";

// `common/outbuffer.ts` is a Bucket-3 sibling NOT yet translated in this batch. `File.read` takes
// `ref OutBuffer` and uses ONLY `allocate(nbytes)` (outbuffer.d:557 `char[] allocate(size_t)` — a
// slice of fresh space to fill). We declare that minimal structural contract here so this file
// type-checks now; when common/outbuffer.ts lands, the real `OutBuffer` (whose `allocate` returns a
// DString slice) satisfies it structurally and this local alias is replaced with the real import.
// GAP: forward dependency on common/outbuffer (08 §14.1 / §17 cross-ref). See escalation report.
interface OutBuffer {
    allocate(nbytes: number): DString;
}

// D `ulong.max` (2^64-1) — File.size's error sentinel, in the bigint domain (09 §1). NOT SIZE_MAX
// (that is the `number` not-found sentinel): a file size is a genuine 64-bit value, compared `==`
// against `ulong.max` by callers, so it must be the real 2^64-1, not -1.
const ULONG_MAX = (1n << 64n) - 1n;

/**
 * `File` (file.d:56) — static read/write helpers. D's `File` is a struct used only as a namespace
 * for `static` members; ported as a class with all-static methods, same call syntax (`File.read`).
 */
export class File {
    /**
     * read(name, buffer) (file.d:87) — read the entire file `name`, appending its bytes to `buffer`.
     *
     * RETURNS `true` on FAILURE, `false` on SUCCESS (file.d:89 `enum Success=false; Failure=true`).
     * This inverted convention is a classic trap — do not "fix" it; callers test `if (File.read(...))`
     * meaning "if it failed". D allocates `statbuf.st_size` bytes in the OutBuffer via
     * `buffer.allocate(size)` then reads into that slice; the port reads the file bytes and copies
     * them into the same `allocate`d slice.
     * resolved: version(Posix) open/fstat/read/close -> Node `fs.readFileSync` (flag #1/#6).
     */
    static read(name: DString, buffer: OutBuffer): boolean {
        const Success = false;
        const Failure = true;
        let bytes: Uint8Array;
        try {
            bytes = fs.readFileSync(dsToJs(name));
        } catch {
            return Failure;
        }
        // Mirror D: allocate `size` bytes in the OutBuffer, then fill them.
        const buf = buffer.allocate(bytes.length);
        buf.set(bytes);
        return Success;
    }

    /**
     * write(name, data) (file.d:165) — write `data` to file `name`. Returns `true` on success.
     * Delegates to common/file `writeFile` exactly as D does (file.d:160-161).
     * (D's `const(char)*` overload, file.d:158, collapses into this single DString form.)
     */
    static write(name: DString, data: Uint8Array): boolean {
        return writeFile(name, data);
    }

    /**
     * remove(name) (file.d:171) — delete a file, ignoring any error (D's `.remove(name)` return is
     * discarded). resolved: version(Posix) `.remove` -> Node `fs.rmSync(path, {force:true})`.
     */
    static remove(name: DString): void {
        try {
            fs.rmSync(dsToJs(name), { force: true });
        } catch {
            // ignore — D discards remove()'s result
        }
    }

    /**
     * removeDirectory(name) (file.d:189, IN_LLVM) — delete a directory.
     * resolved: version(IN_LLVM) -> ON (we are LDC). version(Posix) `.remove` -> Node `fs.rmSync`
     * with `recursive` so a non-empty directory is removed (D used POSIX `remove` on the dir path).
     */
    static removeDirectory(name: DString): void {
        try {
            fs.rmSync(dsToJs(name), { recursive: true, force: true });
        } catch {
            // ignore
        }
    }

    /**
     * update(namez, data) (file.d:221/244) — write `data` to `namez`. DMD's same-size identity check
     * is commented out (file.d:234), so update currently ALWAYS writes (file.d:235). Faithful port:
     * just `write`. Returns `true` on success.
     */
    static update(name: DString, data: Uint8Array): boolean {
        return File.write(name, data);
    }

    /**
     * size(namez) (file.d:252) — size of the file in bytes, or `ulong.max` on any error. The size is
     * a genuine 64-bit value (bigint domain, 09-numerics.md); callers compare `== ulong.max`.
     * resolved: version(Posix) `stat` -> Node `fs.statSync(path).size` (a JS number, widened to bigint).
     */
    static size(name: DString): bigint {
        try {
            const st = fs.statSync(dsToJs(name));
            return BigInt(st.size);
        } catch {
            return ULONG_MAX;
        }
    }
}
