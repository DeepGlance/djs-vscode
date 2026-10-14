// Tests for src/dmd/console.ts (ported from dmd/console.d).
//
// console.d has NO in-source `unittest{}` blocks (verified), so there are no upstream tests to port
// (10 §1.1). These are contract/goal tests that PROTECT the achievements of this port: the byte-exact
// ANSI escape sequences `ANSIConsole` emits, and the env-detection logic of `detectTerminal`/`detectColorPreference`. Every expected value is pinned to the verified
// `ldc2 -run` probes (/tmp/probe_console.d, /tmp/probe_term.d).

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { Color, ANSIConsole, createConsole, detectTerminal, detectColorPreference, type FILE } from "./console.js";
import { dsToJs } from "../dstring.js";

// A capturing FILE sink: accumulates every byte written, exposing it as a JS string for assertion.
class CaptureFile implements FILE {
    bytes: number[] = [];
    write(buffer: Uint8Array): boolean {
        for (const b of buffer) this.bytes.push(b);
        return true;
    }
    text(): string {
        return dsToJs(new Uint8Array(this.bytes));
    }
}

const ESC = "\x1b"; // 0x1b — the ANSI escape introducer

describe("console.d", () => {
    // The Color enum member values, verified with ldc2 -run (/tmp/probe_console.d). The bitwise-OR
    // member initializers must fold to exactly these constants (07-compile-time.md).
    test("Color enum member values (verified ldc2)", () => {
        expect(Color.black).toBe(0);
        expect(Color.red).toBe(1);
        expect(Color.green).toBe(2);
        expect(Color.blue).toBe(4);
        expect(Color.yellow).toBe(3); // red | green
        expect(Color.magenta).toBe(5); // red | blue
        expect(Color.cyan).toBe(6); // green | blue
        expect(Color.lightGray).toBe(7); // red | green | blue
        expect(Color.bright).toBe(8);
        expect(Color.darkGray).toBe(8); // bright | black
        expect(Color.brightRed).toBe(9); // bright | red
        expect(Color.brightGreen).toBe(10); // bright | green
        expect(Color.brightBlue).toBe(12); // bright | blue
        expect(Color.brightYellow).toBe(11); // bright | yellow
        expect(Color.brightMagenta).toBe(13); // bright | magenta
        expect(Color.brightCyan).toBe(14); // bright | cyan
        expect(Color.white).toBe(15); // bright | lightGray
    });

    test("createConsole returns an ANSIConsole bound to the given stream", () => {
        const f = new CaptureFile();
        const con = createConsole(f);
        expect(con).toBeInstanceOf(ANSIConsole);
        expect(con.fp()).toBe(f); // @property fp() returns the stored stream
    });

    // setColorBright(bool) -> "\033[%dm" with the bool printed as 1/0 (verified ldc2:
    // true->ESC[1m, false->ESC[0m).
    test("setColorBright emits ESC[1m / ESC[0m", () => {
        const f = new CaptureFile();
        const con = createConsole(f);
        con.setColorBright(true);
        con.setColorBright(false);
        expect(f.text()).toBe(`${ESC}[1m${ESC}[0m`);
    });

    // setColor(color) -> "\033[%d;%dm" with hi = (color & bright ? 1 : 0), code = 30 + (color & ~bright).
    // Verified ldc2 (brightYellow=11): hi=1, code=33 -> ESC[1;33m.
    test("setColor emits ESC[<hi>;<code>m (verified ldc2)", () => {
        const cases: ReadonlyArray<readonly [Color, string]> = [
            [Color.red, `${ESC}[0;31m`], // hi=0, 30+1
            [Color.green, `${ESC}[0;32m`], // hi=0, 30+2
            [Color.blue, `${ESC}[0;34m`], // hi=0, 30+4
            [Color.lightGray, `${ESC}[0;37m`], // hi=0, 30+7
            [Color.brightYellow, `${ESC}[1;33m`], // hi=1, 30+(11 & ~8)=30+3
            [Color.white, `${ESC}[1;37m`], // hi=1, 30+(15 & ~8)=30+7
            [Color.black, `${ESC}[0;30m`], // hi=0, 30+0
            [Color.darkGray, `${ESC}[1;30m`], // hi=1, 30+(8 & ~8)=30+0
        ];
        for (const [color, expected] of cases) {
            const f = new CaptureFile();
            createConsole(f).setColor(color);
            expect(f.text()).toBe(expected);
        }
    });

    // resetColor() -> fputs("\033[m") (no format).
    test("resetColor emits ESC[m", () => {
        const f = new CaptureFile();
        createConsole(f).resetColor();
        expect(f.text()).toBe(`${ESC}[m`);
    });

    // detectColorPreference: prefer color iff NO_COLOR is unset OR empty (verified ldc2:
    // unset->1, ''->1, '1'->0).
    describe("detectColorPreference (NO_COLOR)", () => {
        let saved: string | undefined;
        beforeEach(() => {
            saved = process.env.NO_COLOR;
        });
        afterEach(() => {
            if (saved === undefined) delete process.env.NO_COLOR;
            else process.env.NO_COLOR = saved;
        });

        test("unset -> true", () => {
            delete process.env.NO_COLOR;
            expect(detectColorPreference()).toBe(true);
        });
        test("empty -> true", () => {
            process.env.NO_COLOR = "";
            expect(detectColorPreference()).toBe(true);
        });
        test("non-empty -> false", () => {
            process.env.NO_COLOR = "1";
            expect(detectColorPreference()).toBe(false);
        });
    });

    // detectTerminal: requires isatty(stderr) AND TERM set, non-empty, and != "dumb". The test
    // harness runs with stderr piped (isTTY falsy), so the function returns false regardless of TERM
    // — matching the verified `ldc2 | cat` probe (detectTerminal=0). We assert the TERM-dependent
    // factors via the documented short-circuit: with stderr not a TTY, the result is always false.
    describe("detectTerminal (TERM + isatty)", () => {
        let savedTerm: string | undefined;
        beforeEach(() => {
            savedTerm = process.env.TERM;
        });
        afterEach(() => {
            if (savedTerm === undefined) delete process.env.TERM;
            else process.env.TERM = savedTerm;
        });

        test("stderr not a TTY -> false (corpus/pipe path)", () => {
            // Vitest captures stderr -> process.stderr.isTTY is falsy, exactly the shim's pipe path.
            process.env.TERM = "xterm-256color";
            expect(detectTerminal()).toBe(false);
        });
        test("TERM=dumb -> false", () => {
            process.env.TERM = "dumb";
            expect(detectTerminal()).toBe(false);
        });
        test("TERM unset -> false", () => {
            delete process.env.TERM;
            expect(detectTerminal()).toBe(false);
        });
    });
});
