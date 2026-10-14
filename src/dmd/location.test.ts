// Tests for dmd/location.ts.
//
// location.d has NO in-source `unittest{}` blocks (verified: `grep -n unittest location.d` -> none),
// so there are no upstream unittests to port (10 §1). These are CONTRACT tests protecting the two
// load-bearing observables of this module:
//   1. `writeSourceLoc` byte-for-byte diagnostic-prefix format (10 §3.2 — the worked example).
//   2. the byte-offset -> line/column resolution through the BaseLoc line table (location.d:326-362
//      worked example: `int y` at file offset 20 of `app.d` resolves to line 3, column 4).
// Anchored to real ldc2 behavior (10 §3.1: `/tmp/fail1.d(3): Error: ...`, columns OFF, digitalmars).

import { describe, test, expect, beforeEach } from "vitest";
import { ds, dsToJs } from "../dstring.js";
import { Loc, SourceLoc, MessageStyle, writeSourceLoc, newBaseLoc } from "./location.js";
import { OutBuffer } from "./common/outbuffer.js";

// The Loc table is `__gshared` process-global; reset it between tests (10 §1.5) so location/index
// state does not leak across tests in Vitest's single-process run.
beforeEach(() => {
    Loc._init();
    Loc.set(false, MessageStyle.digitalmars); // restore the default config (columns OFF, digitalmars)
});

/** Format a SourceLoc prefix into a JS string via writeSourceLoc (the diagnostic path).
 * `extractChars()` returns a NUL-terminated C-string (the trailing `\0` is the terminator, not
 * content); reading it as a `char*` means stopping at the NUL — strip it before decoding. */
function fmt(loc: SourceLoc, showColumns: boolean, style: MessageStyle): string {
    const buf = new OutBuffer();
    writeSourceLoc(buf, loc, showColumns, style);
    let bytes = buf.extractChars();
    if (bytes.length > 0 && bytes[bytes.length - 1] === 0) bytes = bytes.subarray(0, bytes.length - 1);
    return dsToJs(bytes);
}

describe("location.d — writeSourceLoc format (10 §3.2)", () => {
    test("digitalmars, columns OFF -> filename(line)", () => {
        const loc = new SourceLoc(ds("app.d"), 3, 5);
        expect(fmt(loc, false, MessageStyle.digitalmars)).toBe("app.d(3)");
    });

    test("digitalmars, columns ON & column != 0 -> filename(line,column)", () => {
        const loc = new SourceLoc(ds("app.d"), 3, 5);
        expect(fmt(loc, true, MessageStyle.digitalmars)).toBe("app.d(3,5)");
    });

    test("digitalmars, columns ON but column == 0 -> column suppressed", () => {
        const loc = new SourceLoc(ds("app.d"), 3, 0);
        expect(fmt(loc, true, MessageStyle.digitalmars)).toBe("app.d(3)");
    });

    test("gnu, columns OFF -> filename:line", () => {
        const loc = new SourceLoc(ds("app.d"), 3, 5);
        expect(fmt(loc, false, MessageStyle.gnu)).toBe("app.d:3");
    });

    test("gnu, columns ON & column != 0 -> filename:line:column", () => {
        const loc = new SourceLoc(ds("app.d"), 3, 5);
        expect(fmt(loc, true, MessageStyle.gnu)).toBe("app.d:3:5");
    });

    test("empty filename -> no prefix at all (location.d:201)", () => {
        const loc = new SourceLoc(ds(""), 3, 5);
        expect(fmt(loc, false, MessageStyle.digitalmars)).toBe("");
    });

    test("filename only, line == 0 -> just the filename (location.d:204)", () => {
        const loc = new SourceLoc(ds("app.d"), 0, 0);
        expect(fmt(loc, false, MessageStyle.digitalmars)).toBe("app.d");
    });

    test("sarif -> filename only, no (line) text (location.d:228)", () => {
        const loc = new SourceLoc(ds("app.d"), 3, 5);
        expect(fmt(loc, true, MessageStyle.sarif)).toBe("app.d");
    });
});

describe("location.d — BaseLoc line/column resolution (location.d:326-362 worked example)", () => {
    // The worked example: a 24-byte 4-line `app.d` whose line starts are file offsets [0,9,11,22,24].
    // `int y` sits at file offset 20 (well, the doc uses offset 19/20 around `int y`); the table
    // computes line 3, column = 1 + (offset - lines[lineIdx]).
    function buildAppD(): void {
        // contents length only matters for locIndex bookkeeping; use a 24-byte filler.
        const contents = ds("struct S\n{\n    int y;\n}\n"); // 24 bytes, matches the example shape
        const base = newBaseLoc(ds("app.d"), contents);
        // Register the line starts as the example states: lines == [0, 9, 11, 22, 24].
        base.newLine(9);
        base.newLine(11);
        base.newLine(22);
        base.newLine(24);
    }

    test("Loc(1) (file start) resolves to app.d line 1 column 1", () => {
        buildAppD();
        const loc = new Loc();
        loc.index_ = 1; // first BaseLoc gets startIndex = 1; offset 0 -> line 1 col 1
        const sl = SourceLoc.fromLoc(loc);
        expect(dsToJs(sl.filename)).toBe("app.d");
        expect(sl.line).toBe(1);
        expect(sl.column).toBe(1);
    });

    test("offset into line 3 resolves to line 3 with the right column", () => {
        buildAppD();
        // startIndex = 1, so Loc.index = 1 + fileOffset. Pick fileOffset 14 (inside line 3, which
        // starts at offset 11): line 3, column 1 + (14 - 11) = 4 — the doc's `int y` example.
        const loc = new Loc();
        loc.index_ = 1 + 14;
        const sl = SourceLoc.fromLoc(loc);
        expect(sl.line).toBe(3);
        expect(sl.column).toBe(4);
    });

    test("Loc.filename()/linnum()/charnum() agree with SourceLoc resolution", () => {
        buildAppD();
        const loc = new Loc();
        loc.index_ = 1 + 14;
        expect(dsToJs(loc.filename()!)).toBe("app.d");
        expect(loc.linnum()).toBe(3);
        expect(loc.charnum()).toBe(4);
        expect(loc.isValid()).toBe(true);
    });
});

describe("location.d — Loc value semantics + AA-key methods", () => {
    test(".copy() is an independent one-field clone (03 §2)", () => {
        const a = new Loc();
        a.index_ = 7;
        const b = a.copy();
        expect(b.index_).toBe(7);
        a.index_ = 99;
        expect(b.index_).toBe(7); // copy did not alias
    });

    test("opEquals / toHash key on index (05 §13; toHash(uint)=identity, ldc2-verified)", () => {
        const a = new Loc();
        const b = new Loc();
        a.index_ = 42;
        b.index_ = 42;
        expect(a.opEquals(b)).toBe(true);
        expect(a.toHash()).toBe(42);
        b.index_ = 43;
        expect(a.opEquals(b)).toBe(false);
    });

    test("default Loc is invalid (index 0) and Loc.initial is the null location", () => {
        expect(new Loc().isValid()).toBe(false);
        expect(Loc.initial.isValid()).toBe(false);
        expect(Loc.singleFilename(ds("x.d")).isValid()).toBe(true);
    });
});

describe("location.d — SourceLoc value semantics + opEquals", () => {
    test("opEquals compares filename BYTES, not pointer identity (05 §2)", () => {
        const a = new SourceLoc(ds("a.d"), 1, 2);
        const b = new SourceLoc(ds("a.d"), 1, 2); // distinct Uint8Array, equal bytes
        const c = new SourceLoc(ds("b.d"), 1, 2);
        expect(a.opEquals(b)).toBe(true);
        expect(a.opEquals(c)).toBe(false);
    });

    test("linnum/charnum field aliases read & write the canonical fields (location.d:251)", () => {
        const sl = new SourceLoc(ds("a.d"), 1, 2);
        expect(sl.linnum).toBe(1);
        expect(sl.charnum).toBe(2);
        sl.linnum = 5;
        expect(sl.line).toBe(5);
    });
});
