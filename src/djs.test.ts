// Tests for src/djs.ts, the shim's process entry (hand-written djs module; no D unittests to port).
//
// Each run goes through `djsMain` in a FRESH module registry (`vi.resetModules()` + dynamic import), as a new
// ldmd2 process starts from load-time globals; the static imports of this file are never touched. stdout and
// stderr are captured separately. `djsSequence` runs several calls in one registry, as an in-process host does.
//
// ORACLE: <ldc2-1.43.0>/bin/ldmd2 with the same arguments, the
// absolute corpus paths below; each expected text is its output, byte for byte, split by stream. A run whose output
// names the import tree or the config file passes `--djs-ldc=` that install (ORACLE_LDC), so djs spells them as it.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { Dsymbol } from "./dmd/dsymbol.js";
import type { FatalErrorHandler } from "./dmd/errors.js";

// ORACLE CONSTANT: a checkout of LDC v1.43.0's sources (tests/dmd); set it to yours to run the oracle tests.
const TESTS = "/Users/pinver/Projects/Public/ldc-1.43.0/tests/dmd";
const ACCEPT = [`-I${TESTS}/compilable`, `${TESTS}/compilable/test11225a.d`];   // prints `WORKS` (pragma msg)

interface ShimRun {
    code: number;
    stdout: string;
    stderr: string;
    includeImports: boolean;
    patterns: string[];
}

/**
 * One `djsMain` per argument list, in order, all in one fresh registry; each run also reads back compiler.d's `-i`
 * state from that registry. `onFatal` is djsMain's (the CLI's `throwFatalError` when absent).
 */
async function djsSequence(calls: string[][], onFatal?: FatalErrorHandler): Promise<ShimRun[]> {
    vi.resetModules();
    const { djsMain } = await import("./djs.js");
    const compiler = await import("./dmd/compiler.js");
    const { cstr, dsToJs } = await import("./dstring.js");
    const runs: ShimRun[] = [];
    for (const args of calls) {
        const out: string[] = [];
        const err: string[] = [];
        const decode = (c: string | Uint8Array): string => (typeof c === "string" ? c : new TextDecoder().decode(c));
        const tap = (into: string[]) => (c: string | Uint8Array): boolean => {
            into.push(decode(c));
            return true;
        };
        const o = vi.spyOn(process.stdout, "write").mockImplementation(tap(out));
        const e = vi.spyOn(process.stderr, "write").mockImplementation(tap(err));
        try {
            const code = djsMain(args, onFatal);
            runs.push({
                code, stdout: out.join(""), stderr: err.join(""), includeImports: compiler.includeImports,
                patterns: [...compiler.includeModulePatterns].map((p) => dsToJs(cstr(p))),
            });
        } finally {
            o.mockRestore();
            e.mockRestore();
        }
    }
    return runs;
}

/** The oracle's install, and the djs switch that plays its import tree and ldc2.conf instead of the bundled tree. */
// ORACLE CONSTANT: an LDC 1.43.0 install (what --djs-ldc names); set it to yours to run the oracle tests.
const LDC_ROOT = "/Users/pinver/Projects/Prefix/tools/mac_a64/ldc2-1.43.0";
const ORACLE_LDC = `--djs-ldc=${LDC_ROOT}`;

/** One `djsMain(args, onFatal)` in a fresh registry. */
async function djs(args: string[], onFatal?: FatalErrorHandler): Promise<ShimRun> {
    return (await djsSequence([args], onFatal))[0]!;
}

describe("djsMain — ldmd2's exit status and streams (10 §4.1)", () => {
    test("a clean compile exits 0; pragma(msg) goes to stderr", async () => {
        const r = await djs(["-c", "-o-", ...ACCEPT]);
        expect(r.code).toBe(0);
        expect(r.stdout).toBe("");
        expect(r.stderr).toBe("WORKS\n");
    });

    test("an error exits 1 with the source line and caret (ldc2's printErrorContext default)", async () => {
        const r = await djs(["-c", "-o-", `${TESTS}/fail_compilation/test21304.d`]);
        expect(r.code).toBe(1);
        expect(r.stderr).toBe(`${TESTS}/fail_compilation/test21304.d(6): Error: undefined identifier \`unknown\`\n`
            + "int[unknown] values = [1, 2, 3];\n    ^\n");
    });

    test("-verrors=simple (ldmd2: -verrors-context=false) drops the context lines", async () => {
        const r = await djs(["-verrors=simple", "-verrors=0", "-c", "-o-", `${TESTS}/fail_compilation/test21304.d`]);
        expect(r.code).toBe(1);
        expect(r.stderr).toBe(`${TESTS}/fail_compilation/test21304.d(6): Error: undefined identifier \`unknown\`\n`);
    });

    test("no source file: `Error: No source files`, exit 1 (main.d:419, IN_LLVM)", async () => {
        const r = await djs(["-c", "-o-", "-w"]);
        expect(r.code).toBe(1);
        expect(r.stderr).toBe("Error: No source files\n");
    });

    test("an unsupported switch stops before the frontend: exit 2, named on stderr", async () => {
        const r = await djs(["-lib", ...ACCEPT]);
        expect(r.code).toBe(2);
        expect(r.stderr).toBe("djs: unsupported flag `-lib` (not in the shim's flag table (10 §4.2))\n");
    });
});

describe("djsMain called again in one process (deinitializeFrontend)", () => {
    test("each call after an error, a fatal stop or -i compiles as a fresh process does", async () => {
        const error = ["-c", "-o-", `${TESTS}/fail_compilation/test21304.d`];
        const fatal = ["-c", "-o-", `${TESTS}/fail_compilation/diag10327.d`];
        const accept = ["-c", "-o-", ...ACCEPT];
        // Output lines a second call changes when a reset misses its slot: the generated names `__anonclass1`
        // (dmd/identifier.d:199 `newSuffix`) and `__unittest_L3_C1` (dmd/identifier.d:257 `counters`, `_1` appended),
        // and `-v`'s `entry` line (dmd/funcsem.d:904 `printedMain`).
        const dir = mkdtempSync(join(tmpdir(), "djs-seq-"));
        try {
            const gen = join(dir, "seqgen.d");
            writeFileSync(gen, "module seqgen;\n"
                + "void main() { auto o = new class Object {}; pragma(msg, typeof(o).stringof); }\n"
                + "unittest {}\npragma(msg, __traits(getUnitTests, seqgen)[0].stringof);\n");
            const verbose = ["-v", "-unittest", "-c", "-o-", gen];
            const include = ["-i=std", ...accept];
            const runs = await djsSequence([error, accept, fatal, include, error, accept, verbose, verbose]);
            const fresh: ShimRun[] = [];
            for (const a of [error, accept, fatal, include, verbose])
                fresh.push(await djs(a));
            expect(runs).toEqual([fresh[0], fresh[1], fresh[2], fresh[3], fresh[0], fresh[1], fresh[4], fresh[4]]);
            expect(runs[5]!.patterns).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 120_000);   // 13 compiles (8 in one registry, 5 fresh): over the 30 s default when the machine is loaded
});

describe("parseCommandLine — the switches ldmd2 translates, as ldc2 applies them", () => {
    test("-version=4: main.cpp:159 processVersions rejects a non-identifier, fatal", async () => {
        const r = await djs(["-c", "-o-", "-version=4", ...ACCEPT]);
        expect(r.code).toBe(1);
        expect(r.stderr).toBe("Error: Invalid version identifier: '4'\n");
    });

    test("-version=D_LP64: VersionCondition.addGlobalIdent reports the reserved identifier", async () => {
        const r = await djs(["-c", "-o-", "-version=D_LP64", ...ACCEPT]);
        expect(r.code).toBe(1);
        expect(r.stderr).toBe("Error: version identifier `D_LP64` is reserved and cannot be set\n");
    });

    test.each([
        ["-preview=nosuch", "Error: Preview `nosuch` is invalid\n"],
        ["-revert=nosuch", "Error: Revert `nosuch` is invalid\n"],
        ["-transition=nosuch", "Error: transition `nosuch` is invalid\n"],
    ])("%s: mars.d's parse*Option error, then cppmain's fatal", async (flag, text) => {
        const r = await djs(["-c", "-o-", flag, ...ACCEPT]);
        expect(r.code).toBe(1);
        expect(r.stderr).toBe(text);
    });

    test.each([
        ["-dip25", "Deprecation: `-dip25` no longer has any effect\n"],
        ["-transition=intpromote", "Deprecation: `-transition=intpromote` is now the default behavior\n"],
        ["-preview=dip25", "Deprecation: `-preview=dip25` no longer has any effect.\n"],
    ])("%s: a deprecation, and the compile goes on", async (flag, text) => {
        const r = await djs(["-c", "-o-", flag, ...ACCEPT]);
        expect(r.code).toBe(0);
        expect(r.stderr).toBe(text + "WORKS\n");
    });

    test("-transition=? prints the transition usage page on stdout and exits 0 (main.d:352)", async () => {
        const r = await djs(["-c", "-o-", "-transition=?", ...ACCEPT]);
        expect(r.code).toBe(0);
        expect(r.stdout.split("\n")[0]).toBe("Language transitions listed by -transition=name:");
        expect(r.stderr).toBe("");
    });

    test("-v: the predefs line is ldc2's for arm64-apple-darwin", async () => {
        const r = await djs(["-v", "-c", "-o-", ...ACCEPT]);
        expect(r.code).toBe(0);
        const predefs = r.stdout.split("\n").find((l) => l.startsWith("predefs"));
        expect(predefs).toBe("predefs  LDC all D_Version2 assert D_PreConditions D_PostConditions D_Invariants "
            + "D_ModuleInfo D_Exceptions D_TypeInfo AArch64 ARM_HardFloat D_HardFloat LittleEndian D_LP64 D_PIC OSX "
            + "Apple darwin Posix CppRuntime_LLVM CppRuntime_Clang LDC_LLVM_22 D_ObjectiveC");
    });

    test("-unittest -release -betterC: the check-dependent predefined versions follow reconcileCommands", async () => {
        const r = await djs(["-v", "-unittest", "-release", "-betterC", "-c", "-o-", ...ACCEPT]);
        const predefs = r.stdout.split("\n").find((l) => l.startsWith("predefs"));
        expect(predefs).toBe("predefs  LDC all D_Version2 unittest assert D_BetterC AArch64 ARM_HardFloat D_HardFloat "
            + "LittleEndian D_LP64 D_PIC OSX Apple darwin Posix CppRuntime_LLVM CppRuntime_Clang LDC_LLVM_22 "
            + "D_ObjectiveC");
    });

    test("@<file>: ldmd2 expands a response file first (driver/response.cpp); the shim refuses it", async () => {
        const r = await djs(["-c", "-o-", "@ABC", ...ACCEPT]);
        expect(r.code).toBe(2);
        expect(r.stderr).toBe("djs: unsupported flag `@ABC` (a response file: ldmd2 expands it before parsing "
            + "(driver/response.cpp), the shim does not)\n");
    });

    // gen/optimizer.cpp:76 `optimizeLevel` keeps the last occurrence, and only -O0 is level 0 (:177).
    test.each([
        [["-O0"], 1],
        [["-O", "-O0"], 1],
        [["-O0", "-O"], 0],
        [["-Os"], 0],
    ])("%j: D_Optimized follows the last -O level (compilable/version_d_optimized.d)", async (flags, code) => {
        const file = `${TESTS}/compilable/version_d_optimized.d`;
        const r = await djs(["-c", "-o-", ...flags, file]);
        expect(r.code).toBe(code);
        expect(r.stderr).toBe(code === 0 ? ""
            : `${file}(14): Error: static assert:  \`0\` is false\n        static assert(0);\n        ^\n`);
    });

    test("-I with nothing attached takes the next argument as the path (LLVM cl::Prefix)", async () => {
        const r = await djs(["-c", "-o-", "-I", `${TESTS}/compilable`, `${TESTS}/compilable/test11225a.d`]);
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("WORKS\n");
        const eaten = await djs(["-c", "-o-", "-J", `${TESTS}/compilable/test11225a.d`]);
        expect(eaten.code).toBe(1);
        expect(eaten.stderr).toBe("Error: No source files\n");
    });

    test.each(["od", "of"])("-%s= with an empty value: cl_helpers.cpp fromPathString's error, fatal", async (n) => {
        const r = await djs(["-c", "-o-", `-${n}=`, ...ACCEPT]);
        expect(r.code).toBe(1);
        expect(r.stderr).toBe(`Error: Expected argument to '-${n}'\n`);
    });

    test("-vcg-ast (cl_options.cpp:144) writes <srcfile>.cg next to the source, as ldmd2 does", async () => {
        const dir = mkdtempSync(join(tmpdir(), "djs-vcg-"));
        try {
            const file = join(dir, "vcgpin.d");
            writeFileSync(file, "module vcgpin;\nint sum(int[] a)\n{\n    int s;\n    foreach (x; a)\n        s += x;\n"
                + "    return s;\n}\n");
            const r = await djs(["-c", "-o-", "-vcg-ast", file]);
            expect(r.code).toBe(0);
            expect(r.stdout + r.stderr).toBe("");
            expect(readFileSync(`${file}.cg`, "utf8")).toBe("module vcgpin;\nimport object;\nint sum(int[] a)\n{\n"
                + "\tint s = 0;\n\t{\n\t\tscope int[] __r3 = a[];\n\t\tulong __key4 = 0LU;\n"
                + "\t\tfor (; __key4 < __r3.length; __key4 += 1LU)\n\t\t{\n\t\t\tint x = __r3[__key4];\n"
                + "\t\t\ts += x;\n\t\t}\n\t}\n\treturn s;\n}\n");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("-i and -i=<pattern> fill compiler.d's includeImports / includeModulePatterns (main.cpp:412)", async () => {
        const r = await djs(["-i", "-i=std", "-i=-core", "-c", "-o-", ...ACCEPT]);
        expect(r.code).toBe(0);
        expect(r.includeImports).toBe(true);
        expect(r.patterns).toEqual(["std", "-core"]);
    });

    // Build tools' ldc2 lines spell ldc2's own options; ldmd2 passes every `--<name>`, `-d-version=` and `-d-debug` through
    // to ldc2 (ldmd.cpp:760), whose LLVM cl reads `--<name>` as `-<name>`.
    test.each([
        [["--d-version=Foo", "--d-debug", "-O3"], "1 1 1\n", ""],
        [["-d-version=Foo", "-d-debug"], "1 1 0\n", ""],
        [["--vcolumns", "--preview=dip1000", "--release", "--checkaction=C"], "0 0 0\n", ",20"],
    ])("%j: ldc2's spelling, as ldmd2 passes it through", async (flags, msg, column) => {
        const dir = mkdtempSync(join(tmpdir(), "djs-ldc2-"));
        try {
            const file = join(dir, "v.d");
            writeFileSync(file, "module v;\nversion (Foo) enum foo = 1; else enum foo = 0;\n"
                + "debug enum dbg = 1; else enum dbg = 0;\nversion (D_Optimized) enum opt = 1; else enum opt = 0;\n"
                + "pragma(msg, foo, \" \", dbg, \" \", opt);\nvoid f() { int x = \"a\"; }\n");
            const r = await djs(["-c", "-o-", ...flags, file]);
            expect(r.code).toBe(1);
            expect(r.stderr).toBe(`${msg}${file}(6${column}): Error: cannot implicitly convert expression \`"a"\` `
                + "of type `string` to `int`\nvoid f() { int x = \"a\"; }\n                   ^\n");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("--version=Foo is LLVM's own --version, not ldmd2's -version=: refused", async () => {
        const r = await djs(["-c", "-o-", "--version=Foo", ...ACCEPT]);
        expect(r.code).toBe(2);
        expect(r.stderr).toBe("djs: unsupported flag `--version=Foo` (an ldc2 switch outside the shim's flag table "
            + "(10 §4.2))\n");
    });
});

// `-mcpu=` through ldmd.cpp:619-634 to the target machine gen/ldctraits.ts models: the CPU name, the feature bits,
// D_AVX/D_AVX2 (main.cpp:805-808) and LLVM's warnings, against `ldmd2 <flags> -c -o- mcpupin.d` on an Apple M2 host
// (`-mcpu=native` is `apple-m2` there; on another host the shim refuses it).
describe("-mcpu= and the target machine (ldmd.cpp:619-634, driver/targetmachine.cpp:441)", () => {
    const MCPUPIN = `version (X86_64) enum fs = ["sse4.2", "avx", "avx2", "cx16", "avx512f"];
else enum fs = ["neon", "crc", "i8mm", "sme", "sve"];
static foreach (f; fs) pragma(msg, f, " ", __traits(targetHasFeature, f));
pragma(msg, __traits(targetCPU));
version (D_AVX) pragma(msg, "D_AVX");
version (D_AVX2) pragma(msg, "D_AVX2");
`;
    const X86 = "-mtriple=x86_64-linux-gnu";
    const notCpu = (c: string) => `'${c}' is not a recognized processor for this target (ignoring processor)\n`;
    const notFeature = (f: string) => `'${f}' is not a recognized feature for this target (ignoring feature)\n`;

    test.each([
        [["-mcpu=native"], "neon true\ncrc true\ni8mm true\nsme false\nsve false\napple-m2\n"],
        [["-mcpu=native", X86], notCpu("apple-m2") + notCpu("apple-m2")
            + "sse4.2 false\navx false\navx2 false\ncx16 false\navx512f false\napple-m2\n"],
        [["-mcpu=avx", X86], "sse4.2 true\navx true\navx2 false\ncx16 true\navx512f false\nx86-64\nD_AVX\n"],
        [["-mcpu=avx2", X86], "sse4.2 true\navx true\navx2 true\ncx16 true\navx512f false\nx86-64\nD_AVX\nD_AVX2\n"],
        [["-mcpu=x86-64-v4", X86],
            "sse4.2 true\navx true\navx2 true\ncx16 true\navx512f true\nx86-64-v4\nD_AVX\nD_AVX2\n"],
        [["-mcpu=apple-m4", "-mcpu=avx2", X86], notCpu("apple-m4") + notCpu("apple-m4")
            + "sse4.2 true\navx true\navx2 true\ncx16 false\navx512f false\napple-m4\nD_AVX\nD_AVX2\n"],
        // LDC's `+cx16` for `x86-64` whatever the arch, after the `-mattr` flags
        [["-mcpu=x86-64", "-mcpu=avx"], notCpu("x86-64") + notFeature("+avx") + notFeature("+cx16") + notCpu("x86-64")
            + "neon false\ncrc false\ni8mm false\nsme false\nsve false\nx86-64\n"],
        [["-mcpu=cortex-a76", "-mtriple=aarch64-linux-gnu"],
            "neon true\ncrc true\ni8mm false\nsme false\nsve false\ncortex-a76\n"],
        // `baseline` is dropped by ldmd2; an empty `-mcpu=` is the default CPU
        [["-mcpu=apple-m1", "-mcpu=baseline"], "neon true\ncrc true\ni8mm false\nsme false\nsve false\napple-m1\n"],
        [["-mcpu=apple-m3", "-mcpu="], "neon true\ncrc false\ni8mm false\nsme false\nsve false\ngeneric\n"],
    ])("%j", async (flags, stderr) => {
        const dir = mkdtempSync(join(tmpdir(), "djs-mcpu-"));
        try {
            writeFileSync(join(dir, "mcpupin.d"), MCPUPIN);
            const r = await djs(["-c", "-o-", ...flags, join(dir, "mcpupin.d")]);
            expect(r.code).toBe(0);
            expect(r.stdout).toBe("");
            expect(r.stderr).toBe(stderr);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test.each([
        // a CPU LLVM knows, with no probed table: ldc2 prints `haswell`, D_AVX and D_AVX2
        [["-mcpu=haswell", X86], "-mcpu=haswell", "no ldc2-probed feature table for `haswell` on x86_64 (10 §4.2)"],
        // recognised by LLVM though `-mcpu=help` does not list it: no name outside the tables is assumed unknown
        [["-mcpu=apple-latest"], "-mcpu=apple-latest",
            "no ldc2-probed feature table for `apple-latest` on aarch64 (10 §4.2)"],
        [["-mcpu=help"], "-mcpu=help", "ldc2 prints LLVM's CPU list, which the shim does not reproduce"],
    ])("%j is refused before the frontend", async (flags, flag, why) => {
        const r = await djs(["-c", "-o-", ...flags, ...ACCEPT]);
        expect(r.code).toBe(2);
        expect(r.stderr).toBe(`djs: unsupported flag \`${flag}\` (${why})\n`);
    });
});

// The driver-path cases of dmodule.test.ts `compile()`, through the shim: the same startup sequence, now in
// src/dmd/main.ts, gives ldc2's output for them.
describe("the dmodule.test.ts driver cases, through djsMain", () => {
    const LDC_IMPORT = `${LDC_ROOT}/bin/../import`;

    test("fail_compilation/diag10327.d: a missing import is fatal, -I then ldc2.conf's import path", async () => {
        const r = await djs([ORACLE_LDC, "-c", "-o-", `-I${TESTS}/fail_compilation`,
            `${TESTS}/fail_compilation/diag10327.d`]);
        const at = `${TESTS}/fail_compilation/diag10327.d(10)`;
        const context = "import imports.test10327;  // package.d missing\n       ^\n";
        expect(r.code).toBe(1);
        expect(r.stderr).toBe(`${at}: Error: unable to read module \`test10327\`\n` + context
            + `${at}:        Expected 'imports/test10327.d' or 'imports/test10327/package.d' in one of the following `
            + "import paths:\n" + context
            + `import path[0] = ${TESTS}/fail_compilation\nimport path[1] = ${LDC_IMPORT}\n`);
    });

    test("compilable/ldc_github_821.d -v: the -I import is loaded after object.d's closure", async () => {
        const r = await djs([ORACLE_LDC, "-v", "-c", "-o-", `-I${TESTS}/compilable`,
            `${TESTS}/compilable/ldc_github_821.d`]);
        expect(r.code).toBe(0);
        const imports = r.stdout.split("\n").filter((l) => l.startsWith("import "));
        expect(imports[0]).toBe(`import    object\t(${LDC_IMPORT}/object.d)`);
        expect(imports[imports.length - 1])
            .toBe(`import    imports.ldc_github_821a\t(${TESTS}/compilable/imports/ldc_github_821a.d)`);
    });
});

describe("parseCommandLine — Ddoc and JSON switches (ldmd.cpp:655-668 pass-through; main.cpp:356-409)", () => {
    test("each -Xi names one field: an unknown one is ldc2's error, every one reported, then fatal", async () => {
        const r = await djs(["-c", "-o-", "-Xi=bogus", "-Xi=nope", "-Xf=-", ...ACCEPT]);
        expect(r.code).toBe(1);
        expect(r.stdout).toBe("");
        expect(r.stderr).toBe("Error: unknown JSON field `-Xi=bogus`\nError: unknown JSON field `-Xi=nope`\n");
    });

    test("empty -Dd= / -Df= / -Xf= are fromPathString errors, in main.cpp's order, before the -Xi loop", async () => {
        const r = await djs(["-c", "-o-", "-Xf=", "-Xi=bad", "-Dd=", "-Df=", ...ACCEPT]);
        expect(r.code).toBe(1);
        expect(r.stderr).toBe("Error: Expected argument to '-Dd'\nError: Expected argument to '-Df'\n"
            + "Error: Expected argument to '-Xf'\nError: unknown JSON field `-Xi=bad`\n");
    });

    test("-Xi <field> (separate value) and -Xf- write the selected field to stdout", async () => {
        const r = await djs(["-c", "-o-", "-Xi", "modules", "-Xf-", ...ACCEPT]);
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("WORKS\n");
        expect(r.stdout.length).toBe(444);
        expect(r.stdout.startsWith(`{\n "modules" : [\n  {\n   "kind" : "module",\n   "file" : "${TESTS}/compilable/`
            + "test11225a.d\",\n")).toBe(true);
    });

    test("buildInfo objectFiles lists the root's object file (mars.d:2151 push, main.d:600 swap)", async () => {
        const r = await djs(["-c", "-o-", "-Xi=buildInfo", "-Xf=-", ...ACCEPT]);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain(`  "objectFiles" : [\n   "test11225a.o"\n  ],\n`);
    });

    test("two modules writing one -Df file: gen/modules.cpp:71's collision error, then fatal", async () => {
        const dir = mkdtempSync(join(tmpdir(), "djs-col-"));
        try {
            writeFileSync(join(dir, "a.d"), "module a;\nint x;\n");
            writeFileSync(join(dir, "b.d"), "module b;\nint y;\n");
            const out = join(dir, "one.html");
            const r = await djs(["-c", "-o-", "-D", `-Df${out}`, join(dir, "a.d"), join(dir, "b.d")]);
            expect(r.code).toBe(1);
            expect(r.stderr).toBe(`Error: Output file '${out}' for module \`b\` collides with previous module \`a\`. `
                + "See the -oq option\n");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("-Xi<field> with nothing between is not ldc2's spelling (an unknown argument): refused", async () => {
        const r = await djs(["-c", "-o-", "-XicompilerInfo", ...ACCEPT]);
        expect(r.code).toBe(2);
        expect(r.stderr).toBe("djs: unsupported flag `-XicompilerInfo` (not in the shim's flag table (10 §4.2))\n");
    });
});

describe("ImportC sources: main.cpp:1272's preprocessor hook and cl_options.cpp:449's -P", () => {
    /**
     * Runs `djs <args> <dir>/<name>` over a file holding `text`, in a fresh directory that is also $TMPDIR: a
     * failing preprocessor leaves its itmp-ldc-* directory behind, as ldc2 does, and it goes with the rest.
     * `tmpContents` lists $TMPDIR after the run.
     */
    async function onC(name: string, text: string, args: string[])
        : Promise<ShimRun & { file: string; tmpContents: string[] }> {
        const dir = mkdtempSync(join(tmpdir(), "djs-cpp-"));
        const tmp = join(dir, "tmp");
        mkdirSync(tmp);
        const saved = process.env["TMPDIR"];
        process.env["TMPDIR"] = tmp;
        try {
            const file = join(dir, name);
            writeFileSync(file, text);
            const r = await djs([...args, file]);
            return { ...r, file, tmpContents: readdirSync(tmp) };
        } finally {
            if (saved === undefined)
                delete process.env["TMPDIR"];
            else
                process.env["TMPDIR"] = saved;
            rmSync(dir, { recursive: true, force: true });
        }
    }
    const NEEDS_ABC = "#if ABC != 3\n#error no ABC\n#endif\n";

    test.each([["-P=-DABC=3"], ["-P-DABC=3"]])("%s reaches `cc` (cpreprocessor.cpp:85): exit 0, nothing printed",
        async (flag) => {
            const r = await onC("p3.c", NEEDS_ABC, ["-c", "-o-", flag]);
            expect(r.code).toBe(0);
            expect(r.stdout).toBe("");
            expect(r.stderr).toBe("");
        });

    // tool.cpp:41 `-gcc` names the C compiler (tool.cpp:164 getCCImpl), ldc2's spelling passed through by ldmd2.
    test.each([["-gcc=clang"], ["--gcc=clang"]])("%s runs that compiler: exit 0", async (flag) => {
        const r = await onC("p3.c", NEEDS_ABC, ["-c", "-o-", flag, "-P=-DABC=3"]);
        expect(r.code).toBe(0);
        expect(r.stdout + r.stderr).toBe("");
    });

    test.each([["-gcc=nosuchcc"], ["--gcc", "nosuchcc"]])("%j: tool.cpp:154's error, fatal", async (...flags) => {
        const r = await onC("p3.c", NEEDS_ABC, ["-c", "-o-", ...flags]);
        expect(r.code).toBe(1);
        expect(r.stderr).toBe("Error: cannot find program `nosuchcc`\n");
    });

    // `cc`'s own `#error` diagnostic goes to the inherited stderr, outside the frontend's stream captured here.
    // ldc2 prints `<file>: Error: …` on both lines: D passes Module.read's `loc` by `ref const` (globals.d:447) to a
    // C++ hook that takes `Loc` by value (globals.h:469), so the binary reads a pointer's low bits as a Loc index,
    // past every file's start: the last file registered, line 0 (cpreprocessor.ts `cHookLoc`).
    test("a failing preprocessor: tool.cpp:372's status error, cpreprocessor.cpp:166's supplemental, fatal",
        async () => {
            const r = await onC("p3.c", NEEDS_ABC, ["-c", "-o-"]);
            expect(r.code).toBe(1);
            expect(r.tmpContents).toHaveLength(1);   // fatal() before Module.read's cleanup, as in ldc2
        });
    test("the failing preprocessor's diagnostics are located at the .c file, as ldc2 prints them", async () => {
        const r = await onC("p3.c", NEEDS_ABC, ["-c", "-o-"]);
        expect(r.stderr).toBe(`${r.file}: Error: /usr/bin/cc failed with status: 1\n`
            + `${r.file}:        C preprocessor failed for file '${r.file}'\n`);
    });

    test("Module.read deletes the .i and its itmp-ldc-* directory after reading it (dmodule.d:708-710)", async () => {
        const r = await onC("p3.c", NEEDS_ABC, ["-c", "-o-", "-P=-DABC=3"]);
        expect(r.code).toBe(0);
        expect(r.tmpContents).toEqual([]);
    });

    test("a C syntax error: CParser's diagnostics, located in the .c file through the .i line markers", async () => {
        const r = await onC("pe.c", "#define T 1\n\nint x = ;\n", ["-c", "-o-"]);
        expect(r.code).toBe(1);
        expect(r.stderr).toBe(`${r.file}(3): Error: expression expected, not \`;\`\nint x = ;\n        ^\n`
            + `${r.file}(4): Error: \`=\`, \`;\` or \`,\` expected to end declaration instead of \`End of File\`\n`);
    });

    test("a .i file is parsed as C without the preprocessor (dmodule.d:697-700 tests .c and .h only)", async () => {
        const r = await djs(["-c", "-o-", `${TESTS}/compilable/test22724.i`]);
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
    });
});

// THE RECOVERY FILES of the VS Code readiness mandate (question 3): a clean control (rec00) and fourteen modules with
// one defect each, placed between declarations that exist before and after it, so a test can ask what survives past
// the error. `recovery(n)` rebuilds rec<n>.d byte for byte from one skeleton (the probe's generators, ported).
// RECOVERY_LDMD2[n] is ldmd2's exit status and merged output for `ldmd2 -c -o- -verrors=0 rec<n>.d`, run in the
// file's directory; the run here passes an absolute path, so `rec<n>.d(` is prefixed with it before comparing.
const HEAD = (name: string): string => `module ${name};

import std.stdio;
import std.algorithm;

enum Color { red, green, blue }

struct Point
{
    int x;
    int y;
    int sum() const { return x + y; }
}

T twice(T)(T v)
{
    return v + v;
}

int before(int a, int b)
{
    pragma(msg, "S3_BEFORE");
    return a * b;
}

`;
const MIDDLE_OK = "void middle(int[] arr)\n{\n    auto a = 1;\n    writeln(a);\n"
    + "    auto r = arr.filter!(x => x > 0);\n}\n";
const SIZE_OPEN = "\nstruct Size\n{\n    int w;\n    int h;\n    int area() const { return w * h; }\n";
const TAIL_SIZE = SIZE_OPEN + "}\n";
const TAIL_REST = `
class Shape
{
    Point origin;
    int id;
    this(int id) { this.id = id; }
    int perimeter() { return 0; }
}

int after(int a)
{
    pragma(msg, "S3_AFTER");
    return twice(a) + before(a, 2);
}

pragma(msg, "S1_AFTER");
static assert(Size.sizeof == 8);

unittest
{
    assert(after(1) == 4);
}
`;
const TEMPLATE_BAD = "T bad(T)(T v)\n{\n    int x = \"str\";\n    return v;\n}\n";
const mid = (body: string): string => "void middle(int[] arr)\n{\n" + body + "}\n";
const open = (body: string): string => "void middle(int[] arr)\n{\n" + body;
const DEFECTS: [string, string, string?][] = [
    ["unterminated expression", mid("    auto a = 1;\n    auto x = a + ;\n    writeln(a);\n")],
    ["missing closing brace of a function body", open("    auto a = 1;\n    writeln(a);\n")],
    ["missing closing brace of a struct", MIDDLE_OK, SIZE_OPEN],
    ["half-typed identifier", mid("    auto a = 1;\n    writ(a);\n")],
    ["half-typed member access", mid("    auto a = 1;\n    auto r = arr.fil;\n")],
    ["bad import", "import std.nosuchmodule;\n\n" + MIDDLE_OK],
    ["template type error, instantiated", TEMPLATE_BAD + "\n" + mid("    auto a = bad(1);\n    writeln(a);\n")],
    ["template type error, not instantiated", TEMPLATE_BAD + "\n" + MIDDLE_OK],
    ["missing semicolon", mid("    auto a = 1\n    writeln(a);\n")],
    ["unterminated string literal", mid("    auto a = 1;\n    writeln(\"hello);\n    writeln(a);\n")],
    ["half-typed call, open parenthesis at end of function", open("    auto a = 1;\n    writeln(a\n}\n")],
    ["dangling if (", open("    auto a = 1;\n    if (\n}\n")],
    ["member access with trailing dot", open("    auto a = 1;\n    arr.\n}\n")],
];
function recovery(n: number): string {
    const name = `rec${String(n).padStart(2, "0")}`;
    if (n === 0)
        return HEAD(name) + MIDDLE_OK + TAIL_SIZE + TAIL_REST;
    if (n === 14)
        return HEAD(name) + "// DEFECT: half-typed type name at module level\nPoin g;\n\n" + MIDDLE_OK + TAIL_SIZE
            + TAIL_REST;
    const [what, middle, size = TAIL_SIZE] = DEFECTS[n - 1]!;
    return HEAD(name) + `// DEFECT: ${what}\n` + middle + size + TAIL_REST;
}

const RECOVERY_LDMD2: [number, string][] = [
    [0, "S1_AFTER\n"
        + "S3_BEFORE\n"
        + "S3_AFTER\n"],   // rec00
    [1, "rec01.d(30): Error: expression expected, not `;`\n"
        + "    auto x = a + ;\n"
        + "                 ^\n"
        + "rec01.d(31): Error: semicolon expected following auto declaration, not `writeln`\n"
        + "    writeln(a);\n"
        + "    ^\n"],   // rec01
    [1, "rec02.d(56): Error: found `unittest` instead of statement\n"
        + "unittest\n"
        + "^\n"],   // rec02
    [1, "rec03.d(61): Error: `}` expected following members in `struct` declaration\n"
        + "rec03.d(34):        struct `Size` starts here\n"
        + "struct Size\n"
        + "^\n"],   // rec03
    [1, "S1_AFTER\n"
        + "S3_BEFORE\n"
        + "rec04.d(30): Error: undefined identifier `writ`, did you mean template `write(T...)(T args"
        + ") if (!is(T[0] : File))`?\n"
        + "    writ(a);\n"
        + "    ^\n"
        + "S3_AFTER\n"],   // rec04
    [1, "S1_AFTER\n"
        + "S3_BEFORE\n"
        + "rec05.d(30): Error: no property `fil` for `arr` of type `int[]`\n"
        + "    auto r = arr.fil;\n"
        + "                ^\n"
        + "S3_AFTER\n"],   // rec05
    [1, "rec06.d(27): Error: unable to read module `nosuchmodule`\n"
        + "import std.nosuchmodule;\n"
        + "       ^\n"
        + "rec06.d(27):        Expected 'std/nosuchmodule.d' or 'std/nosuchmodule/package.d' in one o"
        + "f the following import paths:\n"
        + "import std.nosuchmodule;\n"
        + "       ^\n"
        + `import path[0] = ${LDC_ROOT}/bin/../import\n`],   // rec06
    [1, "S1_AFTER\n"
        + "S3_BEFORE\n"
        + "rec07.d(29): Error: cannot implicitly convert expression `\"str\"` of type `string` to `int`\n"
        + "    int x = \"str\";\n"
        + "            ^\n"
        + "rec07.d(35): Error: template instance `rec07.bad!int` error instantiating\n"
        + "    auto a = bad(1);\n"
        + "                ^\n"
        + "S3_AFTER\n"],   // rec07
    [0, "S1_AFTER\n"
        + "S3_BEFORE\n"
        + "S3_AFTER\n"],   // rec08
    [1, "rec09.d(30): Error: semicolon expected following auto declaration, not `writeln`\n"
        + "    writeln(a);\n"
        + "    ^\n"],   // rec09
    [1, "rec10.d(51): Error: found `S3_AFTER` when expecting `)`\n"
        + "    pragma(msg, \"S3_AFTER\");\n"
        + "                 ^\n"
        + "rec10.d(51): Error: found `\");\\n    return twice(a) + before(a, 2);\\n}\\n\\npragma(msg, \"` w"
        + "hen expecting `;` following expression\n"
        + "    pragma(msg, \"S3_AFTER\");\n"
        + "                         ^\n"
        + "rec10.d(30):        expression: `writeln(\"hello);\\n    writeln(a);\\n}\\n\\nstruct Size\\n{\\n "
        + "   int w;\\n    int h;\\n    int area() const { return w * h; }\\n}\\n\\nclass Shape\\n{\\n    Po"
        + "int origin;\\n    int id;\\n    this(int id) { this.id = id; }\\n    int perimeter() { return"
        + " 0; }\\n}\\n\\nint after(int a)\\n{\\n    pragma(msg, \")`\n"
        + "    writeln(\"hello);\n"
        + "           ^\n"
        + "rec10.d(55): Error: unterminated string constant starting at rec10.d(55)\n"
        + "pragma(msg, \"S1_AFTER\");\n"
        + "             ^\n"
        + "rec10.d(55): Error: found `\"\"` when expecting `;` following expression\n"
        + "pragma(msg, \"S1_AFTER\");\n"
        + "                     ^\n"
        + "rec10.d(55):        expression: `S1_AFTER`\n"
        + "pragma(msg, \"S1_AFTER\");\n"
        + "             ^\n"
        + "rec10.d(62): Error: matching `}` expected following compound statement, not `End of File`\n"
        + "rec10.d(28):        unmatched `{`\n"
        + "{\n"
        + "^\n"],   // rec10
    [1, "rec11.d(31): Error: found `}` when expecting `)`\n"
        + "}\n"
        + "^\n"
        + "rec11.d(33): Error: found `struct` when expecting `;` following expression\n"
        + "struct Size\n"
        + "^\n"
        + "rec11.d(30):        expression: `writeln(a)`\n"
        + "    writeln(a\n"
        + "           ^\n"
        + "rec11.d(34): Error: found `{` when expecting `;` following expression\n"
        + "{\n"
        + "^\n"
        + "rec11.d(33):        expression: `Size`\n"
        + "struct Size\n"
        + "       ^\n"],   // rec11
    [1, "rec12.d(31): Error: expression expected, not `}`\n"
        + "}\n"
        + "^\n"
        + "rec12.d(33): Error: missing closing `)` after `if (__error`\n"
        + "struct Size\n"
        + "^\n"
        + "rec12.d(57): Error: found `unittest` instead of statement\n"
        + "unittest\n"
        + "^\n"],   // rec12
    [1, "rec13.d(31): Error: identifier or `new` expected following `.`, not `}`\n"
        + "}\n"
        + "^\n"
        + "rec13.d(33): Error: found `struct` when expecting `;` following expression\n"
        + "struct Size\n"
        + "^\n"
        + "rec13.d(30):        expression: `arr`\n"
        + "    arr.\n"
        + "    ^\n"
        + "rec13.d(34): Error: found `{` when expecting `;` following expression\n"
        + "{\n"
        + "^\n"
        + "rec13.d(33):        expression: `Size`\n"
        + "struct Size\n"
        + "       ^\n"],   // rec13
    [1, "rec14.d(27): Error: undefined identifier `Poin`, did you mean struct `Point`?\n"
        + "Poin g;\n"
        + "^\n"
        + "S1_AFTER\n"],   // rec14
];

describe("broken modules: the CLI stops where ldc2 stops (fatal() after parse, importAll, semantic2)", () => {
    const cases = RECOVERY_LDMD2.map((e, n) => [n, ...e] as const);
    test.each(cases)("rec%i: exit %i, ldmd2's output", async (n, code, text) => {
        const dir = mkdtempSync(join(tmpdir(), "djs-rec-"));
        try {
            const file = join(dir, `rec${String(n).padStart(2, "0")}.d`);
            writeFileSync(file, recovery(n));
            const r = await djs([ORACLE_LDC, "-c", "-o-", "-verrors=0", file]);
            expect(r.code).toBe(code);
            expect(r.stdout).toBe("");
            expect(r.stderr).toBe(text.replace(/\brec\d\d\.d\(/g, `${dir}/$&`));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// EDITOR MODE (10 §4.7): the same fifteen modules, through `djsMain` with a fatal handler that answers true, so
// `fatal()` returns as D's does and every pass runs past the CLI's stop. Where ldc2 stops, nothing is an oracle:
// the CLI's output (RECOVERY_LDMD2, ldmd2's) is checked as the start of the editor's, and what follows is djs's own.
interface EditorRun {
    code: number;
    stdout: string;
    stderr: string;
    errors: number;
    fatals: number;
    /** The root module's PASS, then `<scope>.<name>` → PASS for the aggregates and functions of `SCOPES`. */
    root: string;
    passes: Map<string, string>;
}

// Where the declarations after the defect end up: the module, middle()'s localsymtab (the function body left
// open swallows them as nested declarations), or the open struct Size's members.
const SCOPES = ["module", "middle", "Size"] as const;

/** One `djsMain` in a fresh registry with a returning fatal handler; reads back the last compile's AST. */
async function editorRun(file: string): Promise<EditorRun> {
    vi.resetModules();
    const { djsMain } = await import("./djs.js");
    const { Module } = await import("./dmd/dmodule.js");
    const { global } = await import("./dmd/globals.js");
    const { PASS } = await import("./dmd/dsymbol.js");
    const { cstr, dsToJs } = await import("./dstring.js");
    const out: string[] = [];
    const err: string[] = [];
    const decode = (c: string | Uint8Array): string => (typeof c === "string" ? c : new TextDecoder().decode(c));
    const o = vi.spyOn(process.stdout, "write").mockImplementation((c) => out.push(decode(c)) > 0);
    const e = vi.spyOn(process.stderr, "write").mockImplementation((c) => err.push(decode(c)) > 0);
    let fatals = 0;
    let code: number;
    try {
        code = djsMain([ORACLE_LDC, "-c", "-o-", "-verrors=0", file], () => ++fatals > 0);
    } finally {
        o.mockRestore();
        e.mockRestore();
    }
    const name = (s: Dsymbol): string => dsToJs(cstr(s.toChars()));
    const rootName = file.replace(/^.*\/|\.d$/g, "");
    const root = Module.amodules.opSlice().find((m) => dsToJs(cstr(m!.toChars())) === rootName)!;
    const passes = new Map<string, string>();
    const record = (scope: string, syms: Iterable<Dsymbol | null>): void => {
        for (const s of syms) {
            if (s!.ident !== null && s!.isTemplateInstance() === null)
                passes.set(`${scope}.${name(s!)}`, PASS[s!.semanticRun]!);
        }
    };
    const members = root.members!.opSlice();
    const named = (id: string): Dsymbol | undefined => members.find((s) => s!.ident !== null && name(s!) === id)!;
    record(SCOPES[0], members);
    const middle = named("middle")!.isFuncDeclaration()!;
    if (middle.localsymtab !== null)
        record(SCOPES[1], [...middle.localsymtab.tab.asRange()].map(([, s]) => s));
    const size = named("Size");
    if (size !== undefined)
        record(SCOPES[2], size.isStructDeclaration()!.members!.opSlice());
    return { code, stdout: out.join(""), stderr: err.join(""), errors: global.errors, fatals,
        root: PASS[root.semanticRun]!, passes };
}

// The declarations after the defect that reach semantic3done, per module: rec10's string runs to the end of the
// file and leaves none; in rec11 and rec13 Size's body reads as statements of middle(), so only `area` survives it.
const AFTER = ["Size", "Shape", "after"];
const SURVIVORS: string[][] = [
    AFTER.map((s) => `module.${s}`),                                    // rec00
    AFTER.map((s) => `module.${s}`),                                    // rec01
    AFTER.map((s) => `middle.${s}`),                                    // rec02
    ["module.Size", "Size.Shape", "Size.after"],                        // rec03
    AFTER.map((s) => `module.${s}`),                                    // rec04
    AFTER.map((s) => `module.${s}`),                                    // rec05
    AFTER.map((s) => `module.${s}`),                                    // rec06
    AFTER.map((s) => `module.${s}`),                                    // rec07
    AFTER.map((s) => `module.${s}`),                                    // rec08
    AFTER.map((s) => `module.${s}`),                                    // rec09
    [],                                                                 // rec10
    ["middle.area", "module.Shape", "module.after"],                    // rec11
    AFTER.map((s) => `middle.${s}`),                                    // rec12
    ["middle.area", "module.Shape", "module.after"],                    // rec13
    AFTER.map((s) => `module.${s}`),                                    // rec14
];

describe("broken modules in editor mode: fatal() returns and every pass runs (10 §4.7)", () => {
    const cases = RECOVERY_LDMD2.map((e, n) => [n, ...e] as const);
    test.each(cases)("rec%i (CLI exit %i): status 0, semantic3done, ldmd2's output first", async (n, cliCode, cli) => {
        const dir = mkdtempSync(join(tmpdir(), "djs-edit-"));
        try {
            const file = join(dir, `rec${String(n).padStart(2, "0")}.d`);
            writeFileSync(file, recovery(n));
            const r = await editorRun(file);
            // (a) nothing escapes: dmd/main.d:930's EXIT_SUCCESS, no internal error; (d) the errors stay readable
            expect(r.code).toBe(0);
            expect(r.stderr).not.toContain("Internal error");
            expect(r.errors > 0).toBe(cliCode === 1);
            expect(r.fatals > 0).toBe(cliCode === 1);
            // (b) semantic analysis completes on the root module
            expect(r.root).toBe("semantic3done");
            // (c) the declarations after the defect are in the AST and analysed; rec10 has none anywhere
            for (const s of SURVIVORS[n]!)
                expect([s, r.passes.get(s)]).toEqual([s, "semantic3done"]);
            if (n === 10)
                expect([...r.passes.keys()].filter((k) => /\.(Size|Shape|after)$/.test(k))).toEqual([]);
            // (d) byte prefix: ldmd2's stderr (the oracle, cut where ldc2's fatal() exits) is the start of the
            // editor's, so the CLI's lines are its first lines; the rest is djs's own, with no oracle
            expect(r.stdout).toBe("");
            expect(r.stderr.startsWith(cli.replace(/\brec\d\d\.d\(/g, `${dir}/$&`))).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("rec06: the failed import is reported twice (djs's own output, no oracle)", async () => {
        // ImportAllVisitor (dmd/dsymbolsem.d:8348) and the import's semantic (dmd/dsymbolsem.d:3498) each call
        // `imp.load`; past the first returning fatal() (dmd/dmodule.d:668, removeHdrFilesAndFail) the second
        // tries again.
        const dir = mkdtempSync(join(tmpdir(), "djs-edit-"));
        try {
            const file = join(dir, "rec06.d");
            writeFileSync(file, recovery(6));
            const r = await editorRun(file);
            expect(r.stderr.split("Error: unable to read module `nosuchmodule`").length - 1).toBe(2);
            expect(r.errors).toBe(2);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// An ImportC import whose C preprocessor fails stops editor mode at the CLI's stop (10 §4.7, cpreprocessor.ts
// `stopAtFatal`). The fixture is the shape of a project missing a `-P=-I`: two C imports whose headers cc cannot
// find, and D code using both. ldmd2 prints the two lines below after cc's own diagnostic (on the inherited fd 2,
// outside the captured stream), located at the last file read before first.c (cpreprocessor.ts `cHookLoc`).
describe("a failed ImportC import in editor mode: the compile stops where the CLI stops (10 §4.7)", () => {
    test("status 1 and ldmd2's output, as the CLI; the second failing C import is never preprocessed", async () => {
        const dir = mkdtempSync(join(tmpdir(), "djs-edit-c-"));
        const tmp = join(dir, "tmp");   // $TMPDIR: each preprocessor run that fails leaves its itmp-ldc-* there
        mkdirSync(tmp);
        const saved = process.env["TMPDIR"];
        process.env["TMPDIR"] = tmp;
        try {
            writeFileSync(join(dir, "app.d"), "import first;\nimport second;\n\n"
                + "int use() { return rtc_now() + other_now(); }\n");
            writeFileSync(join(dir, "first.c"), '#include "rtc.h"\nint rtc_now(void) { return RTC_ZERO; }\n');
            writeFileSync(join(dir, "second.c"), '#include "other.h"\nint other_now(void) { return 0; }\n');
            const args = [ORACLE_LDC, "-c", "-o-", "-verrors=0", `-I${dir}`, join(dir, "app.d")];
            const at = `${LDC_ROOT}/bin/../import/ldc/intrinsics.di(742)`;
            const ldmd2 = `${at}: Error: /usr/bin/cc failed with status: 1\n`
                + `${at}:        C preprocessor failed for file '${dir}/first.c'\n`;

            const cli = await djs(args);
            expect([cli.code, cli.stdout, cli.stderr]).toEqual([1, "", ldmd2]);
            expect(readdirSync(tmp)).toHaveLength(1);

            let fatals = 0;
            const editor = await djs(args, () => ++fatals > 0);
            expect([editor.code, editor.stdout, editor.stderr]).toEqual([1, "", ldmd2]);
            expect(fatals).toBe(1);
            // first.c's run left a second directory (the stop precedes Module.read's cleanup); second.c had no run
            expect(readdirSync(tmp)).toHaveLength(2);
        } finally {
            if (saved === undefined)
                delete process.env["TMPDIR"];
            else
                process.env["TMPDIR"] = saved;
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // The stops before cc runs: `-gcc` naming no program (tool.cpp:155), a $TMPDIR that does not exist
    // (cpreprocessor.cpp:42). first.c's content is never read. The directory name's random suffix differs per run.
    test.each([
        ["-gcc names no program", ["-gcc=nosuchcc"], "tmp"],
        ["$TMPDIR does not exist", [], "missing"],
    ])("%s: status 1 and the CLI's output", async (_, extra, tmpName) => {
        const dir = mkdtempSync(join(tmpdir(), "djs-edit-c-"));
        mkdirSync(join(dir, "tmp"));
        const saved = process.env["TMPDIR"];
        process.env["TMPDIR"] = join(dir, tmpName);
        try {
            writeFileSync(join(dir, "app.d"), "import first;\n\nint use() { return rtc_now(); }\n");
            writeFileSync(join(dir, "first.c"), "int rtc_now(void) { return 0; }\n");
            const args = ["-c", "-o-", "-verrors=0", ...extra, `-I${dir}`, join(dir, "app.d")];

            const cli = await djs(args);
            expect([cli.code, cli.stdout]).toEqual([1, ""]);
            expect(cli.stderr).toContain("Error: ");

            let fatals = 0;
            const editor = await djs(args, () => ++fatals > 0);
            const unrandom = (s: string) => s.replace(/itmp-ldc-[0-9a-f]+/g, "itmp-ldc-*");
            expect([editor.code, editor.stdout, unrandom(editor.stderr)]).toEqual([1, "", unrandom(cli.stderr)]);
            expect(fatals).toBe(1);
        } finally {
            if (saved === undefined)
                delete process.env["TMPDIR"];
            else
                process.env["TMPDIR"] = saved;
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
