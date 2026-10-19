// Tests for tests/phobos/run.ts: the `/usr/bin/time -l` parser, the `.cg` comparison, its normalizer and
// MISMATCH-CG, the skip classes and their summary notes (the modules measured without -vcg-ast included), the
// timing table, and the edit-loop line of the `--sequence` summary. The time samples are macOS `time -l` output as
// this host prints it.

import { describe, expect, test } from "vitest";
import { LDC_ROOT } from "../corpus/run.ts";
import {
    compareCg, editLoopLine, NO_VCG_UNITTEST, normalizeCg, parseTimeL, quantile, skipNotes, skipOf, stripTimeLines,
    timingSummary, withCg,
} from "./run.ts";
import type { PhobosResult } from "./run.ts";

// /usr/bin/time -l -o f ldmd2 -c -o- -vcg-ast std/ascii.d, Italian locale (decimal comma), first lines.
const TIME_L = `        0,03 real         0,03 user         0,00 sys
            45907968  maximum resident set size
                   0  average shared memory size
                 234  page reclaims
             1261832  peak memory footprint
`;

describe("parseTimeL / stripTimeLines", () => {
    test("wall, user, sys seconds and peak RSS in bytes, with either decimal separator", () => {
        expect(parseTimeL(TIME_L)).toEqual({ wallS: 0.03, userS: 0.03, sysS: 0, rssBytes: 45907968 });
        expect(parseTimeL(TIME_L.replaceAll(",", "."))).toEqual(parseTimeL(TIME_L));
    });

    test("a report without both lines is null", () => {
        expect(parseTimeL("")).toBeNull();
        expect(parseTimeL("        1,00 real         0,90 user         0,10 sys\n")).toBeNull();
    });

    test("time's own lines leave the captured text; `terminated abnormally` marks a killed command", () => {
        const text = "a.d(1): Error: x\ntime: command terminated abnormally\ntime: signal: Invalid argument\n";
        expect(stripTimeLines(text)).toEqual({ text: "a.d(1): Error: x\n", killed: true });
        expect(stripTimeLines("WORKS\n")).toEqual({ text: "WORKS\n", killed: false });
    });
});

describe("the .cg comparison and MISMATCH-CG", () => {
    test("compareCg: same, the first differing line, a one-sided file at line 1, skipped only when neither", () => {
        expect(compareCg("module m;\n", "module m;\n")).toEqual({ status: "same" });
        expect(compareCg("module m;\nint x = 0;\n", "module m;\nint x = 1;\n"))
            .toEqual({ status: "differ", diff: { line: 2, shim: "int x = 0;", oracle: "int x = 1;" } });
        expect(compareCg(null, "module m;\nimport object;\n")).toEqual({ status: "differ",
            reason: "only ldmd2 wrote a .cg", diff: { line: 1, shim: "<no .cg>", oracle: "module m;" } });
        expect(compareCg("module m;\n", null)).toEqual({ status: "differ",
            reason: "only the shim wrote a .cg", diff: { line: 1, shim: "module m;", oracle: "<no .cg>" } });
        expect(compareCg(null, null)).toEqual({ status: "skipped", reason: "neither compiler wrote a .cg" });
        expect(compareCg(null, "m\n", { shim: "the in-process call", oracle: "the fresh process" }).reason)
            .toBe("only the fresh process wrote a .cg");
    });

    test("normalizeCg replaces the copy's root and the install's, and nothing else", () => {
        const text = `string f = "/tmp/x/import/std/a.d";\r\nstring g = "${LDC_ROOT}/import/core/b.d";\nldc2: x\n`;
        expect(normalizeCg(text, "/tmp/x/import"))
            .toBe(`string f = "{ROOT}/std/a.d";\r\nstring g = "{LDC}/import/core/b.d";\nldc2: x\n`);
    });

    test("withCg: a MATCH whose .cg differs, or exists on one side only, is MISMATCH-CG; other verdicts stand", () => {
        const differ = compareCg("a\n", "b\n");
        expect(withCg({ status: "MATCH" }, differ))
            .toEqual({ status: "MISMATCH-CG", diff: { line: 1, shim: "a", oracle: "b" } });
        expect(withCg({ status: "MATCH" }, compareCg("a\n", "a\n"))).toEqual({ status: "MATCH" });
        expect(withCg({ status: "MATCH" }, compareCg(null, "a\n")))
            .toEqual({ status: "MISMATCH-CG", diff: { line: 1, shim: "<no .cg>", oracle: "a" } });
        expect(withCg({ status: "MATCH" }, compareCg(null, null))).toEqual({ status: "MATCH" });
        const exit = { status: "MISMATCH-EXIT", diff: { line: 1, shim: "x", oracle: "y" } };
        expect(withCg(exit, differ)).toEqual(exit);
    });
});

describe("enumeration and the timing table", () => {
    test("skipOf: .d, .di and a C header are modules, a DCompute module SKIP-DCOMPUTE", () => {
        expect(skipOf("std/ascii.d")).toBeNull();
        expect(skipOf("ldc/intrinsics.di")).toBeNull();
        expect(skipOf("importc.h")).toBeNull();
        expect(skipOf("README")?.status).toBe("SKIP-OTHER");
        expect(skipOf("ldc/opencl.di")?.status).toBe("SKIP-DCOMPUTE");
        expect(skipOf("ldc/dcompute/std/index.d")?.status).toBe("SKIP-DCOMPUTE");
        expect(skipOf("ldc/dcompute.d")).toBeNull();   // not a @compute module: measured (MATCH)
    });

    test("skipNotes: one line per skip class present, with its count and reason", () => {
        const r = (file: string): PhobosResult => ({ dir: "ldc", file, ...skipOf(file)! });
        const notes = skipNotes([r("ldc/opencl.di"), r("README"), r("ldc/dcompute/x.d"),
            { dir: "std", file: "std/ascii.d", status: "MATCH" }]).split("\n");
        expect(notes[0]).toBe("Notes");
        expect(notes[1]).toMatch(/^ {4}2 {2}SKIP-DCOMPUTE: a @compute module: .*gen\/semantic\.d:20.* not ported$/);
        expect(notes[2]).toMatch(/^ {4}1 {2}SKIP-OTHER: not a D or C source/);
        expect(notes.length).toBe(4);
    });

    test("skipNotes: a module measured without -vcg-ast gets its line after the skip classes", () => {
        const notes = skipNotes([{ dir: "ldc", file: "ldc/opencl.di", ...skipOf("ldc/opencl.di")! },
            { dir: "std", file: "std/meta.d", status: "MATCH", noVcg: NO_VCG_UNITTEST.get("std/meta.d") }])
            .split("\n");
        expect(notes[1]).toMatch(/^ {4}1 {2}SKIP-DCOMPUTE: /);
        expect(notes[2]).toMatch(/^ {7}std\/meta\.d measured without -vcg-ast: ldc2 does not finish .*O\(N\^2\)/);
        expect(notes.length).toBe(4);
    });

    test("NO_VCG_UNITTEST holds exactly the two modules ldc2 cannot dump", () => {
        expect([...NO_VCG_UNITTEST.keys()]).toEqual(["std/meta.d", "std/traits.d"]);
        expect(NO_VCG_UNITTEST.get("std/traits.d")).toMatch(/173 s, 5\.2 GB$/);
    });

    test("quantile is nearest-rank", () => {
        expect(quantile([5, 1, 3, 2, 4], 0.5)).toBe(3);
        expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
        expect(quantile([7], 0.9)).toBe(7);
    });

    test("editLoopLine: the cold first call apart, median and p90 over the calls after it", () => {
        expect(editLoopLine([3500.4, 1800, 1700, 1900, 2500])).toBe(
            "cold call 1: 3500 ms; calls 2-5: median 1800 ms, p90 2500 ms");
    });

    test("timingSummary: per-compiler statistics over modules with both runs timed, and their ratio", () => {
        const cost = (wallS: number, mib: number) => ({ wallS, userS: 0, sysS: 0, rssBytes: mib * 2 ** 20 });
        const r = (shim: number, oracle: number): PhobosResult => ({ dir: "std", file: "x.d", status: "MATCH",
            cost: { shim: cost(shim, 100 * shim), oracle: cost(oracle, 100 * oracle) } });
        const s = timingSummary([r(1, 0.5), r(2, 0.5), r(4, 1), { dir: "std", file: "y.d", status: "TIMEOUT",
            cost: { shim: null, oracle: null } }]);
        expect(s.split("\n")[0]).toBe("Timing over 3 modules with both runs timed (median / p90 / max)");
        expect(s).toMatch(/ wall seconds\n {2}djs +2\.00 +4\.00 +4\.00\n {2}ldmd2 +0\.50 +1\.00 +1\.00\n/);
        expect(s).toMatch(/ratio djs\/ldmd2 +4\.0x +4\.0x +4\.0x\n peak RSS MiB/);
        expect(timingSummary([])).toBe("Timing: no module with both runs timed\n");
    });
});
