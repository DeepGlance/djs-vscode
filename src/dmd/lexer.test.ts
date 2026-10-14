import { describe, test, expect, beforeEach } from "vitest";

// Port of the in-source unittest{} blocks of dmd/lexer.d (10 §1.2: bare blocks -> "unittest#N",
// 1-based source order). These are the GOAL TEST: the TS lexer must tokenize / decode escapes
// exactly as the D lexer does.
//
// Module-level setup (10 §1.5): the lexer interns identifiers (idPool) and reads the keyword pool,
// and uses the process-global Loc table. `Loc._init()` + `initTokens()` + `Id.initialize()` are run
// before each test, mirroring what the D `unittest` runner relies on. ORDER: initTokens() FIRST —
// its Identifier.initTable() orphans previously-interned Id.* singletons (see tokens.ts initTokens).

import { CompileEnv, Lexer } from "./lexer.js";
import { Global, dmd_version } from "./globals.js";
import { TOK } from "./tokens.js";
import { initTokens } from "./tokens.js";
import { Id } from "./id.js";
import { Loc } from "./location.js";
import { ErrorSink, ErrorSinkStderr, ErrorSinkNull } from "./errorsink.js";
import { OutBuffer } from "./common/outbuffer.js";
import { ds, dsToJs } from "../dstring.js";
import type { DString } from "../dstring.js";

beforeEach(() => {
    Loc._init(); // resets locFileTable, locIndex (10 §1.5)
    initTokens(); // intern the keyword pool (and Identifier.initTable)
    Id.initialize(); // intern the predefined Id.* identifiers
});

/// Build a NUL-terminated byte buffer from an ASCII/Latin-1 JS string. The D unittest passes a
/// `string sequence` whose `.ptr` the lexer scans; the buffer needs the trailing NUL sentinel the
/// lexer's byteAt() relies on (the D test strings are implicitly null-terminated).
function seqBuf(s: string): DString {
    const b = new Uint8Array(s.length + 1);
    for (let i = 0; i < s.length; i++) {
        b[i] = s.charCodeAt(i) & 0xff;
    }
    b[s.length] = 0;
    return b;
}

describe("lexer.d", () => {
    // lexer.d:3573 — escapeSequence: each `test(sequence, expected)` decodes one escape and asserts
    // the returned dchar AND that the cursor advanced exactly `sequence.length` bytes.
    test("unittest#1", () => {
        const errorSink: ErrorSink = new ErrorSinkStderr();

        const testEsc = (sequence: string, expected: number, Ccompile = false): void => {
            const buf = seqBuf(sequence);
            const seq = { buf, p: 0 };
            const c2 = { value: 0 };
            const lexer = Lexer.forMock(errorSink);
            const actual = lexer.escapeSequence(Loc.initial, seq, Ccompile, c2);
            expect(actual).toBe(expected);
            // assert(p == sequence.ptr + sequence.length)
            expect(seq.p).toBe(sequence.length);
        };

        testEsc("'", 0x27 /* '\'' */);
        testEsc('"', 0x22 /* '"' */);
        testEsc("?", 0x3f /* '?' */);
        testEsc("\\", 0x5c /* '\\' */);
        testEsc("0", 0x00 /* '\0' */);
        testEsc("a", 0x07 /* '\a' */);
        testEsc("b", 0x08 /* '\b' */);
        testEsc("f", 0x0c /* '\f' */);
        testEsc("n", 0x0a /* '\n' */);
        testEsc("r", 0x0d /* '\r' */);
        testEsc("t", 0x09 /* '\t' */);
        testEsc("v", 0x0b /* '\v' */);

        testEsc("x00", 0x00);
        testEsc("xff", 0xff);
        testEsc("xFF", 0xff);
        testEsc("xa7", 0xa7);
        testEsc("x3c", 0x3c);
        testEsc("xe2", 0xe2);

        testEsc("1", 0o1 /* '\1' */);
        testEsc("42", 0o42 /* '\42' */);
        testEsc("357", 0o357 /* '\357' */);

        testEsc("u1234", 0x1234 /* 'ሴ' */);
        testEsc("uf0e4", 0xf0e4 /* '' */);

        testEsc("U0001f603", 0x1f603 /* '\U0001f603' */);

        testEsc("&quot;", 0x22 /* '"' */);
        testEsc("&lt;", 0x3c /* '<' */);
        testEsc("&gt;", 0x3e /* '>' */);
    });

    // lexer.d:3622 — escapeSequence error cases: a custom ErrorSink captures the (formatted) error
    // and supplemental message; the test asserts both, plus the returned dchar and the scan length.
    test("unittest#2", () => {
        // The D `ErrorSinkTest extends ErrorSinkNull` overrides verror/errorSupplemental and formats
        // `format`+`ap` via vsnprintf, comparing to the expected JS strings. Here we format via the
        // same printf subset (OutBuffer.vprintf — 10 §3.5) and compare the decoded JS string.
        class ErrorSinkTest extends ErrorSinkNull {
            expected = "";
            expectedSupplemental = "";
            gotError = false;

            override verror(_loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
                this.gotError = true;
                const buf = new OutBuffer();
                buf.vprintf(format, ap);
                expect(dsToJs(buf.extractSlice())).toBe(this.expected);
            }

            override verrorSupplemental(_loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
                this.gotError = true;
                const buf = new OutBuffer();
                buf.vprintf(format, ap);
                expect(dsToJs(buf.extractSlice())).toBe(this.expectedSupplemental);
            }
        }

        const errorSink = new ErrorSinkTest();

        const test2 = (
            sequence: string,
            expectedError: [string, string | null],
            expectedReturnValue: number,
            expectedScanLength: number,
            Ccompile = false,
        ): void => {
            errorSink.expected = expectedError[0];
            errorSink.expectedSupplemental = expectedError[1] ?? "";
            errorSink.gotError = false;
            const buf = seqBuf(sequence);
            const seq = { buf, p: 0 };
            const lexer = Lexer.forMock(errorSink);
            const c2 = { value: 0 };
            const actualReturnValue = lexer.escapeSequence(Loc.initial, seq, Ccompile, c2);
            expect(errorSink.gotError).toBe(true);
            expect(actualReturnValue).toBe(expectedReturnValue);
            expect(seq.p).toBe(expectedScanLength);
        };

        const testE = (
            sequence: string,
            expectedError: string,
            expectedReturnValue: number,
            expectedScanLength: number,
            Ccompile = false,
        ): void => {
            test2(sequence, [expectedError, null], expectedReturnValue, expectedScanLength, Ccompile);
        };

        testE("c", "undefined escape sequence \\c", 0x63 /* 'c' */, 1);
        testE("!", "undefined escape sequence \\!", 0x21 /* '!' */, 1);
        testE("&quot;", "undefined escape sequence \\&", 0x26 /* '&' */, 1, true);

        testE("x1", "escape hex sequence has 1 hex digits instead of 2", 0x01, 2);

        testE("u1", "escape hex sequence has 1 hex digits instead of 4", 0x1, 2);
        testE("u12", "escape hex sequence has 2 hex digits instead of 4", 0x12, 3);
        testE("u123", "escape hex sequence has 3 hex digits instead of 4", 0x123, 4);

        testE("U0", "escape hex sequence has 1 hex digits instead of 8", 0x0, 2);
        testE("U00", "escape hex sequence has 2 hex digits instead of 8", 0x00, 3);
        testE("U000", "escape hex sequence has 3 hex digits instead of 8", 0x000, 4);
        testE("U0000", "escape hex sequence has 4 hex digits instead of 8", 0x0000, 5);
        testE("U0001f", "escape hex sequence has 5 hex digits instead of 8", 0x0001f, 6);
        testE("U0001f6", "escape hex sequence has 6 hex digits instead of 8", 0x0001f6, 7);
        testE("U0001f60", "escape hex sequence has 7 hex digits instead of 8", 0x0001f60, 8);

        testE("U00110000", "invalid UTF character \\U00110000", 0x3f /* '?' */, 9);

        testE("xg0", "undefined escape hex sequence \\xg", 0x67 /* 'g' */, 2);
        testE("ug000", "undefined escape hex sequence \\ug", 0x67 /* 'g' */, 2);
        testE("Ug0000000", "undefined escape hex sequence \\Ug", 0x67 /* 'g' */, 2);

        testE("&BAD;", "unnamed character entity &BAD;", 0x3f /* '?' */, 5);
        testE("&quot", "unterminated named entity &quot;", 0x3f /* '?' */, 5);
        testE("&quot", "unterminated named entity &quot;", 0x3f /* '?' */, 5);

        testE("400", "escape octal sequence \\400 is larger than \\377", 0x100, 3);

        test2(
            "uD800",
            [
                "invalid UTF character \\U0000d800",
                "The code unit is a UTF-16 surrogate, is the escape UTF-16 not a Unicode code point?",
            ],
            0x3f /* '?' */,
            5,
        );
        test2(
            "uDFFF",
            [
                "invalid UTF character \\U0000dfff",
                "The code unit is a UTF-16 surrogate, is the escape UTF-16 not a Unicode code point?",
            ],
            0x3f /* '?' */,
            5,
        );
    });

    // lexer.d:3716 — lex "int": one int32 keyword token, then endOfFile (sticky on repeat).
    test("unittest#3", () => {
        const text = ds("int\0"); // "We rely on the implicit null-terminator"
        const errorSink: ErrorSink = new ErrorSinkStderr();
        const lex1 = new Lexer(null, text, 0, 3 /* "int".length */, false, false, errorSink, null);
        let tok: TOK;
        tok = lex1.nextToken();
        expect(tok).toBe(TOK.int32);
        tok = lex1.nextToken();
        expect(tok).toBe(TOK.endOfFile);
        tok = lex1.nextToken();
        expect(tok).toBe(TOK.endOfFile);
        tok = lex1.nextToken();
        expect(tok).toBe(TOK.endOfFile);
    });

    // lexer.d:3736 — malformed input still terminates in TOK.endOfFile.
    test("unittest#4", () => {
        // We don't want to see Lexer error output during these tests.
        const errorSink: ErrorSink = new ErrorSinkNull();

        // Testcase must end with 0 or 0x1A.
        const testcases: number[][] = [
            [0], // not malformed, but pathological
            [0x27 /* '\'' */, 0],
            [0x27 /* '\'' */, 0x1a],
            [0x7b /* '{' */, 0x7b, 0x71 /* 'q' */, 0x7b, 0],
            [0xff, 0],
            [0xff, 0x80, 0],
            [0xff, 0xff, 0],
            [0xff, 0xff, 0],
            [0x78 /* 'x' */, 0x22 /* '"' */, 0x1a],
        ];

        for (const testcase of testcases) {
            const buf = Uint8Array.from(testcase);
            const lex2 = new Lexer(null, buf, 0, testcase.length - 1, false, false, errorSink, null);
            let tok: TOK = lex2.nextToken();
            let iterations = 1;
            while (tok !== TOK.endOfFile && iterations++ < testcase.length) {
                tok = lex2.nextToken();
            }
            expect(tok).toBe(TOK.endOfFile);
            tok = lex2.nextToken();
            expect(tok).toBe(TOK.endOfFile);
        }
    });
});

describe("__VERSION__ with the driver's compile environment (lexer.d VERSIONX, globals.d:555)", () => {
    test("lexes as 2113, the baseline frontend's number (ldc2 1.43.0: `pragma(msg, __VERSION__)` prints 2113L)", () => {
        // The driver fills compileEnv.versionNumber from dmd_version (`based on DMD v2.113.0`); a null compileEnv
        // (the sema harness's) keeps the lexer's own default, as D's does.
        const env = new CompileEnv();
        env.versionNumber = Global.parseVersionNumber(dmd_version);
        const text = ds("__VERSION__\0");
        const lex = new Lexer(null, text, 0, 11, false, false, new ErrorSinkNull(), env);
        lex.nextToken();
        expect(lex.token.value).toBe(TOK.int64Literal);
        expect(lex.token.unsvalue).toBe(2113n);
    });
});

// lexer.d:421-446 — `case '\\':` outside C falls to `goto default;`, whose invalid-token arm reports the
// character and `continue`s the scan loop (lexer.d:1225), so the NEXT real token is returned. ORACLE
// (ldc2 -c -o-, `int x = \ 3;`): the one line `Error: character '\' is not a valid token`, nothing else —
// the parser sees `int x = 3;`.
describe("lexer.d:446 — an invalid character reached through `goto default` resumes the scan", () => {
    test("`= \\ 3` lexes as `=`, `3`, EOF with one invalid-token error", () => {
        const errors: string[] = [];
        class RecordingSink extends ErrorSinkNull {
            override verror(_loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
                const buf = new OutBuffer();
                buf.vprintf(format, ap);
                errors.push(dsToJs(buf.extractSlice()));
            }
        }
        const text = ds("= \\ 3\0");
        const lex = new Lexer(null, text, 0, 5, false, false, new RecordingSink(), null);
        expect(lex.nextToken()).toBe(TOK.assign);
        expect(lex.nextToken()).toBe(TOK.int32Literal);
        expect(lex.nextToken()).toBe(TOK.endOfFile);
        expect(errors).toEqual(["character '\\' is not a valid token"]);
    });
});
