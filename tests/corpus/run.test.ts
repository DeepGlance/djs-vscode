// Tests for tests/corpus/run.ts: the header parsing (a port of d_do_test.d's, pinned against its own
// unittests at d_do_test.d:311-368 and :926-1000), the command built per test, and the classification.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
    classify, compareWritten, findTestParameter, firstDifference, lineShape, linkWorkDir, normalize,
    normalizeWritten, planTest, sampleOf, summarize, TESTS, tripleEnv, writtenFiles,
} from "./run.ts";

// d_do_test.d:311 — the unittest's sample file, verbatim.
const SAMPLE = `
/*
Here's a link
FOO: a b
FOO: c
*/

void main() {}

// BAR(windows): all_win
// BAR(windows64): 64_win

int i;

/* REQUIRED_ARGS: -O
 * PERMUTE_ARGS:
 */

// COMPILE_SEPARATELY:
import foo.bar;
`;

describe("findTestParameter (d_do_test.d:263)", () => {
    test("every definition is joined with the delimiter", () => {
        expect(findTestParameter(SAMPLE, "FOO")).toBe("a b c");
        expect(findTestParameter(SAMPLE, "FOO", ";")).toBe("a b;c");
    });

    test("a parameter conditional on another OS is skipped on osx64", () => {
        expect(findTestParameter(SAMPLE, "BAR")).toBeNull();
        expect(findTestParameter("// X(osx): yes\n// X(linux): no\n", "X")).toBe("yes");
        expect(findTestParameter("// X(osx64): yes\n// X(osx32): no\n", "X")).toBe("yes");
    });

    test("an empty parameter is found, and a missing one is null", () => {
        expect(findTestParameter(SAMPLE, "PERMUTE_ARGS")).toBe("");
        expect(findTestParameter(SAMPLE, "COMPILE_SEPARATELY")).toBe("");
        expect(findTestParameter(SAMPLE, "REQUIRED_ARGS")).toBe("-O");
        expect(findTestParameter(SAMPLE, "OTHER")).toBeNull();
    });

    test("a partial match inside a word is not a directive", () => {
        expect(findTestParameter("NOT_REQUIRED_ARGS: -x\n", "REQUIRED_ARGS")).toBeNull();
    });
});

describe("planTest — the command d_do_test builds (d_do_test.d:1896), with the runner's departures", () => {
    test("fail_compilation gets `-verrors=simple -verrors=0` ahead of REQUIRED_ARGS, and -o- is always added", () => {
        const p = planTest("fail_compilation", "x.d", "/* REQUIRED_ARGS: -de\n*/\n", "/R", "/O");
        expect(p).toEqual({ skip: null, args: ["-m64", "-Ifail_compilation", "-verrors=simple", "-verrors=0", "-de",
            "-od/O", "-c", "-o-", "fail_compilation/x.d"] });
    });

    test("EXTRA_SOURCES and COMPILED_IMPORTS are prefixed with the directory; ${RESULTS_DIR} is replaced", () => {
        const src = "/* EXTRA_SOURCES: imports/a.d\nCOMPILED_IMPORTS: imports/b.d\nREQUIRED_ARGS: -J${RESULTS_DIR}\n*/";
        const p = planTest("compilable", "y.d", src, "/R", "/O");
        expect(p).toEqual({ skip: null, args: ["-m64", "-Icompilable", "-J/R", "-od/O", "-c", "-o-", "compilable/y.d",
            "compilable/imports/a.d", "compilable/imports/b.d"] });
    });

    test("the first ARG_SET goes after -od, as d_do_test.d:1900 places it", () => {
        const p = planTest("compilable", "z.d", "/* REQUIRED_ARGS: -w\nARG_SETS: -de; -d\n*/", "/R", "/O");
        expect(p).toEqual({ skip: null, args: ["-m64", "-Icompilable", "-w", "-od/O", "-de", "-c", "-o-",
            "compilable/z.d"] });
    });

    test("a .c or .i test is planned as a .d test, with LDC's -defaultlib= suffix (d_do_test.d:741-751)", () => {
        expect(planTest("compilable", "a.c", "", "/R", "/O")).toEqual({ skip: null,
            args: ["-m64", "-Icompilable", "-defaultlib=", "-od/O", "-c", "-o-", "compilable/a.c"] });
        expect(planTest("fail_compilation", "b.i", "/* REQUIRED_ARGS: -w\n*/", "/R", "/O")).toEqual({ skip: null,
            args: ["-m64", "-Ifail_compilation", "-verrors=simple", "-verrors=0", "-w", "-defaultlib=", "-od/O", "-c",
                "-o-", "fail_compilation/b.i"] });
    });

    test("the stated skips", () => {
        expect(planTest("runnable", "a.d", "// EXTRA_CPP_SOURCES: a.cpp\n", "/R", "/O")).toEqual({ skip: "skip-cpp" });
        expect(planTest("runnable", "a.d", "// COMPILE_SEPARATELY:\n", "/R", "/O"))
            .toEqual({ skip: "skip-separately" });
        expect(planTest("runnable", "a.d", "// DISABLED: osx\n", "/R", "/O"))
            .toEqual({ skip: "skip-disabled", detail: "on osx" });
        expect(planTest("runnable", "a.d", "// DISABLED: LDC_not_x86\n", "/R", "/O"))
            .toEqual({ skip: "skip-disabled", detail: "for LDC_not_x86" });
        expect(planTest("runnable", "a.d", "// DISABLED: win32 linux\n", "/R", "/O")).toMatchObject({ skip: null });
    });

    test("--mtriple: -mtriple=<t> where -m64 goes, and the headers read as a native run on Linux (10 §4.8)", () => {
        const x86 = tripleEnv("x86_64-linux-gnu");
        const a64 = tripleEnv("aarch64-linux-gnu");
        const src = "/* REQUIRED_ARGS(linux): -version=L\nREQUIRED_ARGS(osx): -version=O\n*/";
        expect(planTest("compilable", "t.d", src, "/R", "/O", x86)).toEqual({ skip: null,
            args: ["-mtriple=x86_64-linux-gnu", "-Icompilable", "-version=L", "-od/O", "-c", "-o-",
                "compilable/t.d"] });
        expect(planTest("runnable", "a.d", "// DISABLED: linux\n", "/R", "/O", a64))
            .toEqual({ skip: "skip-disabled", detail: "on linux" });
        expect(planTest("runnable", "a.d", "// DISABLED: osx\n", "/R", "/O", a64)).toMatchObject({ skip: null });
        // getDisabledReason's `isX86` (d_do_test.d:624): kept on x86_64, skipped on aarch64
        expect(planTest("runnable", "a.d", "// DISABLED: LDC_not_x86\n", "/R", "/O", x86))
            .toMatchObject({ skip: null });
        expect(planTest("runnable", "a.d", "// DISABLED: LDC_not_x86\n", "/R", "/O", a64))
            .toEqual({ skip: "skip-disabled", detail: "for LDC_not_x86" });
    });
});

describe("comparison", () => {
    test("normalize: paths, the compiler's name as a line prefix, ldc2's -v GC stats line", () => {
        const text = `${TESTS}/x.d(1): Error\r\n/bin/ldc2 -v\nldc2: Unknown\nat /a/djs/x.js\n`;
        expect(normalize(text, "/bin/ldc2", "/R"))
            .toBe("{TESTS}/x.d(1): Error\n{COMPILER} -v\n{COMPILER}: Unknown\nat /a/djs/x.js\n");
        expect(normalize("semantic3 x\nGC stats  1M used, 11M free, 12M total\nentry\n", "/c", "/R"))
            .toBe("semantic3 x\nentry\n");
    });

    test("normalize: every test root given (the working directory, the copy) reads {TESTS}", () => {
        const roots = ["/w/cwd/3/shim", "/w/tests"];
        expect(normalize("/w/cwd/3/shim/compilable/a.d(1): x\n/w/tests/b.d\n", "/bin/djs.js", "/R", roots))
            .toBe("{TESTS}/compilable/a.d(1): x\n{TESTS}/b.d\n");
    });

    test("firstDifference names the first differing line of each side", () => {
        expect(firstDifference("a\nb\n", "a\nc\n")).toEqual({ line: 2, shim: "b", oracle: "c" });
        expect(firstDifference("a\n", "a\n")).toBeNull();
        expect(firstDifference("x\n", "")).toEqual({ line: 1, shim: "x", oracle: "<end of output>" });
    });

    test("classify: crash before refusal before exit before text", () => {
        const out = (code: number, text: string) => ({ code, text, timedOut: false });
        expect(classify(out(1, "x\nInternal error: Error: TODO-BODY: f (dmd/a.d:1)\n  at …"), out(0, ""), "", ""))
            .toEqual({ status: "CRASH", signature: "Error: TODO-BODY: f (dmd/a.d:1)" });
        expect(classify(out(2, "djs: unsupported flag `-lib` (x)\n"), null, "", ""))
            .toEqual({ status: "UNSUPPORTED-FLAG", detail: "-lib" });
        expect(classify(out(0, ""), out(1, "e"), "", "e").status).toBe("MISMATCH-EXIT");
        expect(classify(out(1, "e"), out(1, "f"), "e", "f").status).toBe("MISMATCH-OUTPUT");
        expect(classify(out(1, "e"), out(1, "e"), "e", "e")).toEqual({ status: "MATCH" });
        expect(classify({ code: null, text: "", timedOut: true }, null, "", "")).toEqual({ status: "TIMEOUT" });
    });

    test("classify: a signal, an unknown status, and an uncaught error outside djsMain are crashes", () => {
        expect(classify({ code: null, signal: "SIGSEGV", text: "", timedOut: false }, null, "", ""))
            .toEqual({ status: "CRASH", signature: "killed by SIGSEGV" });
        expect(classify({ code: 134, text: "", timedOut: false }, null, "", ""))
            .toEqual({ status: "CRASH", signature: "exit status 134" });
        const uncaught = "Error: No source files\nfile:///w/emit/dmd/a.js:3\n\nTypeError: x is not a function\n"
            + "    at f (file:///w/emit/dmd/a.js:3:9)\n\nNode.js v22.18.0\n";
        expect(classify({ code: 1, text: uncaught, timedOut: false }, null, "", ""))
            .toEqual({ status: "CRASH", signature: "uncaught TypeError: x is not a function @ f (dmd/a.js:3)" });
    });

    test("a crash signature without a .d anchor carries its first frame outside assert.js", () => {
        const text = "Internal error: AssertError: Assertion failure\n"
            + "    at assert (file:///w/emit/assert.js:91:15)\n    at g (file:///w/emit/dmd/b.js:7:2)\n";
        expect(classify({ code: 1, text, timedOut: false }, null, "", "")).toEqual(
            { status: "CRASH", signature: "AssertError: Assertion failure @ g (dmd/b.js:7)" });
    });

    test("summarize buckets a MISMATCH-FILE by its file's extension", () => {
        const s = summarize([
            { dir: "compilable", file: "a.d", status: "MISMATCH-FILE", written: "{RESULTS_DIR}/compilable/a.html",
                diff: { line: 3, shim: "<p>`a`</p>", oracle: "<p>`b`</p>" } },
            { dir: "compilable", file: "b.d", status: "MISMATCH-FILE", written: "{RESULTS_DIR}/compilable/b.out",
                diff: { line: 1, shim: "<no file>", oracle: "{" } },
        ]);
        expect(s).toContain("    1  MISMATCH-FILE .html: <p>`X`</p>");
        expect(s).toContain("    1  MISMATCH-FILE .out: <no file>");
    });

    test("sampleOf spreads the sample evenly and keeps the order", () => {
        expect(sampleOf([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 3)).toEqual([0, 3, 6]);
        expect(sampleOf([1, 2], 0)).toEqual([1, 2]);
    });

    test("summarize counts per directory and class", () => {
        const s = summarize([
            { dir: "compilable", file: "a.d", status: "MATCH" },
            { dir: "compilable", file: "b.d", status: "CRASH", signature: "E" },
            { dir: "runnable", file: "c.d", status: "CRASH", signature: "E" },
        ]);
        expect(s.split("\n")[1]).toMatch(/^CRASH\s+1\s+1\s+2$/);
        expect(s).toContain("    2  E");
    });

    test("summarize buckets mismatches by shape, both sides; counts fail_compilation tests the oracle accepts", () => {
        const s = summarize([
            { dir: "fail_compilation", file: "a.d", status: "MATCH", exit: { shim: 0, oracle: 0 } },
            { dir: "fail_compilation", file: "b.d", status: "MISMATCH-EXIT", exit: { shim: 0, oracle: 1 },
                diff: { line: 1, shim: "<end of output>", oracle: "{TESTS}/b.d(3): Error: `f` is bad" } },
            { dir: "fail_compilation", file: "c.d", status: "MISMATCH-EXIT", exit: { shim: 0, oracle: 1 },
                diff: { line: 1, shim: "<end of output>", oracle: "{TESTS}/c.d(9,2): Error: `g` is bad" } },
        ]);
        expect(s).toContain("the oracle accepts under -c -o- (failure past the frontend): 1, of them MATCH: 1");
        expect(s).toContain("    2  MISMATCH-EXIT: <end of output>");
        expect(s).toContain("    2  MISMATCH-EXIT: Error: `X` is bad");
        expect(lineShape("")).toBe("<empty line>");
        expect(lineShape("{TESTS}/a.d(1): Error: alias this `a` conflicts with variable `b` at {LDC_IMPORT}/x.d(44)"))
            .toBe("Error: alias this `X` conflicts with variable `X` at <loc>");
    });
});

describe("the files each compiler writes (THE TREE, OUTPUT FILES)", () => {
    test("a working directory links the copy; only what the run created in it, and its results, are collected", () => {
        const w = mkdtempSync(join(tmpdir(), "djs-corpus-test-"));
        try {
            const root = join(w, "tests");
            mkdirSync(join(root, "compilable"), { recursive: true });
            writeFileSync(join(root, "compilable", "a.d"), "module a;\n");
            writeFileSync(join(root, "README.md"), "r\n");
            const cwd = join(w, "cwd");
            linkWorkDir(root, cwd);
            expect(readFileSync(join(cwd, "compilable", "a.d"), "utf8")).toBe("module a;\n");
            writeFileSync(join(cwd, "compilable", "a.d.cg"), "through the link\n");   // lands in the copy
            writeFileSync(join(cwd, "a.html"), "cwd\xe9\n", "latin1");
            mkdirSync(join(cwd, "test_results", "compilable"), { recursive: true });
            writeFileSync(join(cwd, "test_results", "compilable", "b.html"), "rel\n");
            const res = join(w, "results");
            mkdirSync(join(res, "compilable"), { recursive: true });
            writeFileSync(join(res, "compilable", "c.json"), "[]\n");
            expect([...writtenFiles(res, cwd)]).toEqual([
                ["{RESULTS_DIR}/compilable/c.json", "[]\n"],
                ["{TESTS}/a.html", "cwd\xe9\n"],
                ["{TESTS}/test_results/compilable/b.html", "rel\n"],
            ]);
            rmSync(cwd, { recursive: true });
            expect(readFileSync(join(root, "compilable", "a.d.cg"), "utf8")).toBe("through the link\n");
        } finally {
            rmSync(w, { recursive: true, force: true });
        }
    });

    test("a .html file: ddocAny-postscript.sh's `Generated by Ddoc from` lines and line-end CRs go, no more", () => {
        const html = "<html>\r\n<p>Generated by Ddoc from compilable/a.d</p>\n<p>$(YEAR) 2026 /R/x</p>\n";
        expect(normalizeWritten("{RESULTS_DIR}/compilable/a.html", html, "/R"))
            .toBe("<html>\n<p>$(YEAR) 2026 {RESULTS_DIR}/x</p>\n");
    });

    test("any other file: only buildInfo's cwd and argv0 values are replaced; config is compared", () => {
        const json = '{\n "buildInfo" : {\n  "cwd" : "/w/cwd/1/shim",\n  "argv0" : "/e/djs.js",\n'
            + '  "config" : "/l/etc/ldc2.conf",\n  "objectFiles" : [\n   "/R/compilable/a.o"\n  ]\n }\n}\n';
        expect(normalizeWritten("{RESULTS_DIR}/compilable/a.json", json, "/R")).toBe('{\n "buildInfo" : {\n'
            + '  "cwd" : "{PROCESS}",\n  "argv0" : "{PROCESS}",\n  "config" : "/l/etc/ldc2.conf",\n'
            + '  "objectFiles" : [\n   "{RESULTS_DIR}/compilable/a.o"\n  ]\n }\n}\n');
    });

    test("compareWritten names the first differing file in name order, a missing side reading <no file>", () => {
        const m = (...e: [string, string][]): Map<string, string> => new Map(e);
        expect(compareWritten(m(["a", "x\n"]), m(["a", "x\n"]))).toBeNull();
        expect(compareWritten(m(["b", "1\n2\n"], ["c", "q"]), m(["b", "1\n3\n"], ["c", "r"])))
            .toEqual({ written: "b", diff: { line: 2, shim: "2", oracle: "3" } });
        expect(compareWritten(m(), m(["{TESTS}/t.html", "<html>\nx"])))
            .toEqual({ written: "{TESTS}/t.html", diff: { line: 1, shim: "<no file>", oracle: "<html>" } });
    });
});
