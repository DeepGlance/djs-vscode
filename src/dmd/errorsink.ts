/**
 * Provides an abstraction for what to do with error messages.
 *
 * Copyright:   Copyright (C) 2023-2025 by The D Language Foundation, All Rights Reserved
 * Authors:     $(LINK2 https://www.digitalmars.com, Walter Bright)
 * License:     $(LINK2 https://www.boost.org/LICENSE_1_0.txt, Boost License 1.0)
 * Source:      $(LINK2 https://github.com/dlang/dmd/blob/master/compiler/src/dmd/errorsink.d, _errorsink.d)
 * Documentation:  https://dlang.org/phobos/dmd_errorsink.html
 * Coverage:    https://codecov.io/gh/dlang/dmd/src/master/compiler/src/dmd/errorsink.d
 */

// module dmd.errorsink;

// `import core.stdc.stdarg;` (errorsink.d:14) — the C `va_list`/`va_start`/`va_end` ABI plumbing.
// ERASED (04 §3.1): a C-variadic `(..., format, ...)` becomes a TS rest param `...args: unknown[]`,
// and that rest array IS the materialised `va_list`. No runtime import.

import { ds, cstr, cstrlen, type DString } from "../dstring.js";
import type { Loc } from "./location.js";
import { OutBuffer } from "./common/outbuffer.js";

/***************************************
 * Where error/warning/deprecation messages go.
 */
// `nothrow:` and `extern (C++):` (errorsink.d:23-24) — ERASE (04 §8).
//
// The seven `v*` methods are declared abstract in D (no body); `abstract class ErrorSink` makes
// them abstract here (02 §2). `va_list ap` is the rest-array form of the printf args, so its type
// is `ReadonlyArray<unknown>` (04 §3.1; matches OutBuffer.vprintf's `args` parameter). The public
// `error()`/`warning()`/… are the C-variadic wrappers: `...args: unknown[]` (04 §3.1).
export abstract class ErrorSink {
    abstract verror(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void;
    abstract verrorSupplemental(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void;
    abstract vwarning(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void;
    abstract vwarningSupplemental(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void;
    abstract vmessage(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void;
    abstract vdeprecation(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void;
    abstract vdeprecationSupplemental(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void;

    // The C-variadic wrappers (errorsink.d:34-88). Each forwards its printf args to the matching
    // `v*` method. The `va_list ap; va_start(ap, format); … ; va_end(ap)` triple erases — the rest
    // array `args` is the va_list (04 §3.1). `format` is byte-identical to the call site (10 §3.5).
    error(loc: Loc, format: DString, ...args: unknown[]): void {
        this.verror(loc, format, args);
    }

    errorSupplemental(loc: Loc, format: DString, ...args: unknown[]): void {
        this.verrorSupplemental(loc, format, args);
    }

    warning(loc: Loc, format: DString, ...args: unknown[]): void {
        this.vwarning(loc, format, args);
    }

    warningSupplemental(loc: Loc, format: DString, ...args: unknown[]): void {
        this.vwarningSupplemental(loc, format, args);
    }

    message(loc: Loc, format: DString, ...args: unknown[]): void {
        this.vmessage(loc, format, args);
    }

    deprecation(loc: Loc, format: DString, ...args: unknown[]): void {
        this.vdeprecation(loc, format, args);
    }

    deprecationSupplemental(loc: Loc, format: DString, ...args: unknown[]): void {
        this.vdeprecationSupplemental(loc, format, args);
    }

    /**
     * This will be called to indicate compilation has either
     * finished or terminated, no more errors are possible - it's
     * now the time to print any stored errors.
     *
     * The default implementation does nothing since most error sinks have no state
     */
    plugSink(): void {}
}

/*****************************************
 * Just ignores the messages.
 */
// `override:` (errorsink.d:107) — KEEP as `override` per-method (04 §8; tsconfig noImplicitOverride).
export class ErrorSinkNull extends ErrorSink {
    override verror(_loc: Loc, _format: DString, _ap: ReadonlyArray<unknown>): void {}

    override verrorSupplemental(_loc: Loc, _format: DString, _ap: ReadonlyArray<unknown>): void {}

    override vwarning(_loc: Loc, _format: DString, _ap: ReadonlyArray<unknown>): void {}

    override vwarningSupplemental(_loc: Loc, _format: DString, _ap: ReadonlyArray<unknown>): void {}

    override vmessage(_loc: Loc, _format: DString, _ap: ReadonlyArray<unknown>): void {}

    override vdeprecation(_loc: Loc, _format: DString, _ap: ReadonlyArray<unknown>): void {}

    override vdeprecationSupplemental(_loc: Loc, _format: DString, _ap: ReadonlyArray<unknown>): void {}
}

/*****************************************
 * Ignores the messages, but sets `sawErrors` for any calls to `error()`
 */
export class ErrorSinkLatch extends ErrorSinkNull {
    sawErrors = false;

    override verror(_loc: Loc, _format: DString, _ap: ReadonlyArray<unknown>): void {
        this.sawErrors = true;
    }
}

/*****************************************
 * Simplest implementation, just sends messages to stderr.
 * See also: ErrorSinkCompiler.
 */
// `import core.stdc.stdio;` / `import core.stdc.stdarg;` (errorsink.d:144-145) — C-stdio FFI.
// The D body writes to `stderr` via `fputs`/`fprintf`/`vfprintf`/`fputc`. There is no `FILE*` in
// JS: those four become OutBuffer appends (`writestring`/`vprintf`/`writeByte`) assembled in a
// buffer, then flushed to `process.stderr` in ONE `process.stderr.write` as raw bytes (resolution
// #7, doc home 10 §4). `OutBuffer.vprintf` delegates to `root/dmdformat.ts` — the canonical printf
// formatter (resolution #2, 10 §3.5), the same `vsnprintf` subset `vfprintf` drives — so the whole
// message is assembled byte-for-byte before the single flush. `va_list ap`/`vfprintf(stderr, format,
// ap)` → `buf.vprintf(format, ap)`.
export class ErrorSinkStderr extends ErrorSink {
    override verror(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
        const buf = new OutBuffer();
        buf.writestring(ds("Error: ")); // fputs("Error: ", stderr)
        const p = loc.toChars(); // NUL-terminated; D `if (*p)` -> cstrlen(p) > 0 (resolution #4 / 02 §11)
        if (cstrlen(p) > 0) {
            buf.vprintf(ds("%s: "), [cstr(p)]); // fprintf(stderr, "%s: ", p) — %s sees the C-string view
            //mem.xfree(cast(void*)p); // loc should provide the free()
        }

        buf.vprintf(format, ap); // vfprintf(stderr, format, ap)
        buf.writeByte(0x0a); // fputc('\n', stderr)
        flushStderr(buf);
    }

    override verrorSupplemental(_loc: Loc, _format: DString, _ap: ReadonlyArray<unknown>): void {}

    override vwarning(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
        const buf = new OutBuffer();
        buf.writestring(ds("Warning: ")); // fputs("Warning: ", stderr)
        const p = loc.toChars(); // NUL-terminated; D `if (*p)` -> cstrlen(p) > 0 (resolution #4 / 02 §11)
        if (cstrlen(p) > 0) {
            buf.vprintf(ds("%s: "), [cstr(p)]); // fprintf(stderr, "%s: ", p) — %s sees the C-string view
            //mem.xfree(cast(void*)p); // loc should provide the free()
        }

        buf.vprintf(format, ap); // vfprintf(stderr, format, ap)
        buf.writeByte(0x0a); // fputc('\n', stderr)
        flushStderr(buf);
    }

    override vwarningSupplemental(_loc: Loc, _format: DString, _ap: ReadonlyArray<unknown>): void {}

    override vdeprecation(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
        const buf = new OutBuffer();
        buf.writestring(ds("Deprecation: ")); // fputs("Deprecation: ", stderr)
        const p = loc.toChars(); // NUL-terminated; D `if (*p)` -> cstrlen(p) > 0 (resolution #4 / 02 §11)
        if (cstrlen(p) > 0) {
            buf.vprintf(ds("%s: "), [cstr(p)]); // fprintf(stderr, "%s: ", p) — %s sees the C-string view
            //mem.xfree(cast(void*)p); // loc should provide the free()
        }

        buf.vprintf(format, ap); // vfprintf(stderr, format, ap)
        buf.writeByte(0x0a); // fputc('\n', stderr)
        flushStderr(buf);
    }

    override vmessage(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
        const buf = new OutBuffer();
        const p = loc.toChars(); // NUL-terminated; D `if (*p)` -> cstrlen(p) > 0 (resolution #4 / 02 §11)
        if (cstrlen(p) > 0) {
            buf.vprintf(ds("%s: "), [cstr(p)]); // fprintf(stderr, "%s: ", p) — %s sees the C-string view
            //mem.xfree(cast(void*)p); // loc should provide the free()
        }

        buf.vprintf(format, ap); // vfprintf(stderr, format, ap)
        buf.writeByte(0x0a); // fputc('\n', stderr)
        flushStderr(buf);
    }

    override vdeprecationSupplemental(_loc: Loc, _format: DString, _ap: ReadonlyArray<unknown>): void {}
}

// --- C-stdio helpers (no upstream .d source; the FFI plumbing of ErrorSinkStderr) ---
//
// The `if (*p)` non-empty test and the `const(char)*` → `%s`-argument C-string view are the canonical
// `cstrlen`/`cstr` helpers from dstring.ts (resolution #4 / 02 §11) — used directly at the call
// sites above, no local re-implementation.

/// Flush an assembled diagnostic buffer to the process's stderr as raw bytes (the `stderr` target of
/// `fputs`/`fprintf`/`vfprintf`/`fputc`). Diagnostics go to stderr (10 §4.1). `extractSlice()` hands
/// over the buffer's bytes (no trailing NUL — that is `extractChars`).
function flushStderr(buf: OutBuffer): void {
    process.stderr.write(buf.extractSlice());
}
