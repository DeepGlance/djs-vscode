// Tests for dmd/errorsink.ts.
//
// errorsink.d has NO in-source `unittest{}` blocks (verified: `grep -n unittest errorsink.d` ->
// none), so there are no upstream unittests to port (10 §1). These are CONTRACT tests protecting
// the load-bearing observables of this module, mirroring the location.test.ts precedent:
//   1. the C-variadic wrappers (`error`/`warning`/…) forward `loc`/`format`/printf-args verbatim to
//      the matching abstract `v*` method (04 §3.1) — the dispatch the whole frontend depends on.
//   2. `ErrorSinkNull` ignores everything; `ErrorSinkLatch` sets `sawErrors` ONLY on `error()`.
//   3. `ErrorSinkStderr` byte-format: "Error: "/"Warning: "/"Deprecation: " header, the
//      `<loc>: ` prefix (only when the loc is non-empty), the printf-formatted message, trailing
//      '\n', all to stderr (10 §3.3/§4.1). Anchored to the D body (errorsink.d:151-208).

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { ds, dsToJs, type DString } from "../dstring.js";
import { Loc, MessageStyle } from "./location.js";
import { ErrorSink, ErrorSinkNull, ErrorSinkLatch, ErrorSinkStderr } from "./errorsink.js";

// The Loc table is `__gshared` process-global; reset it between tests (10 §1.5) so location/index
// state does not leak across tests in Vitest's single-process run.
beforeEach(() => {
    Loc._init();
    Loc.set(false, MessageStyle.digitalmars); // restore the default config (columns OFF, digitalmars)
});

// A spy sink that records every `v*` call, so we can assert the wrappers forward verbatim.
interface Recorded {
    kind: string;
    loc: Loc;
    format: DString;
    ap: ReadonlyArray<unknown>;
}

class ErrorSinkSpy extends ErrorSink {
    readonly calls: Recorded[] = [];
    private record(kind: string, loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
        this.calls.push({ kind, loc, format, ap });
    }
    override verror(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
        this.record("verror", loc, format, ap);
    }
    override verrorSupplemental(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
        this.record("verrorSupplemental", loc, format, ap);
    }
    override vwarning(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
        this.record("vwarning", loc, format, ap);
    }
    override vwarningSupplemental(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
        this.record("vwarningSupplemental", loc, format, ap);
    }
    override vmessage(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
        this.record("vmessage", loc, format, ap);
    }
    override vdeprecation(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
        this.record("vdeprecation", loc, format, ap);
    }
    override vdeprecationSupplemental(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
        this.record("vdeprecationSupplemental", loc, format, ap);
    }
}

describe("errorsink.d — C-variadic wrappers forward to the abstract v* methods (04 §3.1)", () => {
    test("error/warning/message/deprecation + Supplemental each call the matching v* once", () => {
        const sink = new ErrorSinkSpy();
        const loc = Loc.initial;
        const fmt = ds("msg %s");

        sink.error(loc, fmt, "a");
        sink.errorSupplemental(loc, fmt, "b");
        sink.warning(loc, fmt, "c");
        sink.warningSupplemental(loc, fmt, "d");
        sink.message(loc, fmt, "e");
        sink.deprecation(loc, fmt, "f");
        sink.deprecationSupplemental(loc, fmt, "g");

        expect(sink.calls.map((c) => c.kind)).toEqual([
            "verror",
            "verrorSupplemental",
            "vwarning",
            "vwarningSupplemental",
            "vmessage",
            "vdeprecation",
            "vdeprecationSupplemental",
        ]);
    });

    test("the rest array IS the va_list — printf args pass through unchanged", () => {
        const sink = new ErrorSinkSpy();
        sink.error(Loc.initial, ds("%s has %d at %llx"), "name", 42, 0xffn);
        expect(sink.calls).toHaveLength(1);
        expect(sink.calls[0].ap).toEqual(["name", 42, 0xffn]);
    });

    test("a zero-arg call yields an empty va_list, not a 1-element array of undefined", () => {
        const sink = new ErrorSinkSpy();
        sink.error(Loc.initial, ds("no args here"));
        expect(sink.calls[0].ap).toEqual([]);
    });

    test("format and loc are forwarded by identity (no copy/rewrap)", () => {
        const sink = new ErrorSinkSpy();
        const loc = Loc.initial;
        const fmt = ds("verbatim");
        sink.error(loc, fmt);
        expect(sink.calls[0].loc).toBe(loc);
        expect(sink.calls[0].format).toBe(fmt);
    });

    test("plugSink() default is a no-op (errorsink.d:97)", () => {
        const sink = new ErrorSinkSpy();
        expect(() => sink.plugSink()).not.toThrow();
    });
});

describe("errorsink.d — ErrorSinkNull ignores every message", () => {
    test("none of the v* methods throw or record anything observable", () => {
        const sink = new ErrorSinkNull();
        const loc = Loc.initial;
        const fmt = ds("ignored %s");
        expect(() => {
            sink.error(loc, fmt, "x");
            sink.warning(loc, fmt, "x");
            sink.message(loc, fmt, "x");
            sink.deprecation(loc, fmt, "x");
            sink.errorSupplemental(loc, fmt, "x");
            sink.warningSupplemental(loc, fmt, "x");
            sink.deprecationSupplemental(loc, fmt, "x");
        }).not.toThrow();
    });
});

describe("errorsink.d — ErrorSinkLatch sets sawErrors only for error()", () => {
    test("sawErrors starts false", () => {
        expect(new ErrorSinkLatch().sawErrors).toBe(false);
    });

    test("error() sets sawErrors true (errorsink.d:135)", () => {
        const sink = new ErrorSinkLatch();
        sink.error(Loc.initial, ds("boom"));
        expect(sink.sawErrors).toBe(true);
    });

    test("warning/message/deprecation do NOT set sawErrors (inherited Null v* methods)", () => {
        const sink = new ErrorSinkLatch();
        sink.warning(Loc.initial, ds("w"));
        sink.message(Loc.initial, ds("m"));
        sink.deprecation(Loc.initial, ds("d"));
        sink.errorSupplemental(Loc.initial, ds("s"));
        expect(sink.sawErrors).toBe(false);
    });
});

describe("errorsink.d — ErrorSinkStderr byte format (errorsink.d:151-208)", () => {
    // Capture process.stderr.write so we can assert the exact bytes the sink emits.
    let captured: string;
    let original: typeof process.stderr.write;

    beforeEach(() => {
        captured = "";
        original = process.stderr.write.bind(process.stderr);
        // Intercept stderr; `as never` sidesteps the multi-overload signature of `write`.
        process.stderr.write = ((chunk: string | Uint8Array): boolean => {
            captured += typeof chunk === "string" ? chunk : dsToJs(chunk as DString);
            return true;
        }) as never;
    });

    afterEach(() => {
        process.stderr.write = original;
    });

    test('error with no location -> "Error: <msg>\\n", no loc prefix (errorsink.d:152-163)', () => {
        const sink = new ErrorSinkStderr();
        sink.verror(Loc.initial, ds("cannot do %s"), [ds("the thing")]);
        expect(captured).toBe("Error: cannot do the thing\n");
    });

    test('error WITH a location -> "Error: <loc>: <msg>\\n" (errorsink.d:154-158)', () => {
        const sink = new ErrorSinkStderr();
        const loc = Loc.singleFilename(ds("app.d")); // filename-only loc -> "app.d"
        sink.verror(loc, ds("bad %s"), [ds("thing")]);
        expect(captured).toBe("Error: app.d: bad thing\n");
    });

    test('warning -> "Warning: " header (errorsink.d:169)', () => {
        const sink = new ErrorSinkStderr();
        sink.vwarning(Loc.initial, ds("watch out"), []);
        expect(captured).toBe("Warning: watch out\n");
    });

    test('deprecation -> "Deprecation: " header (errorsink.d:185)', () => {
        const sink = new ErrorSinkStderr();
        sink.vdeprecation(Loc.initial, ds("old"), []);
        expect(captured).toBe("Deprecation: old\n");
    });

    test("vmessage has NO header, only the (optional loc and) message (errorsink.d:197-208)", () => {
        const sink = new ErrorSinkStderr();
        sink.vmessage(Loc.initial, ds("just a message"), []);
        expect(captured).toBe("just a message\n");
    });

    test("the *Supplemental variants emit nothing (empty bodies, errorsink.d:165/181/210)", () => {
        const sink = new ErrorSinkStderr();
        sink.verrorSupplemental(Loc.initial, ds("x"), []);
        sink.vwarningSupplemental(Loc.initial, ds("x"), []);
        sink.vdeprecationSupplemental(Loc.initial, ds("x"), []);
        expect(captured).toBe("");
    });
});
