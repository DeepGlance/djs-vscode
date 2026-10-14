// Tests for src/driver/cpreprocessor.ts (hand-ported LDC C++; no D unittests to port).
//
// ORACLE: ldc2 1.43.0 (`ldc2 -v -c -o- x.c` on this host, Darwin 27.0.0, CC unset) prints the preprocessor command
//   /usr/bin/cc -std=c11 -target arm64-apple-macos28 -fno-blocks -dD -Wno-builtin-macro-redefined -E -include
//   <bin>/../import/importc.h x.c -o <TMPDIR>/itmp-ldc-<6 hex>/x.i
// (one line, each word followed by a space); MACOSX_DEPLOYMENT_TARGET=13.1 turns the target into
// `arm64-apple-macos13.1`, CC="cc -DFOO" puts `-DFOO` right after the compiler, `-P=-DABC=3` puts `-DABC=3` after
// `-fno-blocks`, and CC=nosuchcc stops with `Error: cannot find program \`nosuchcc\``.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { global } from "../dmd/globals.js";
import { FatalError, setFatalErrorHandler, throwFatalError } from "../dmd/errors.js";
import { Loc } from "../dmd/location.js";
import { FileName } from "../dmd/root/filename.js";
import { OutBuffer } from "../dmd/common/outbuffer.js";
import { ds, dsToJs, dsUtf8 } from "../dstring.js";
import { configureCPreprocessor, runCPreprocessor } from "./cpreprocessor.js";

// ORACLE CONSTANT: an LDC 1.43.0 install (what --djs-ldc names); set it to yours to run the oracle tests.
const IMPORT = "/Users/pinver/Projects/Prefix/tools/mac_a64/ldc2-1.43.0/bin/../import";
const darwinMajor = Number.parseInt(release(), 10);
const hostMacOS = darwinMajor >= 25 ? `${darwinMajor + 1}` : darwinMajor >= 20 ? `${darwinMajor - 9}` : "";

let work = "";
const ENV = ["TMPDIR", "CC", "MACOSX_DEPLOYMENT_TARGET"];
let savedEnv: (string | undefined)[] = [];
let out: string[] = [];
let err: string[] = [];

beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "djs-cpp-test-"));
    savedEnv = ENV.map((k) => process.env[k]);
    process.env["TMPDIR"] = join(work, "tmp");
    delete process.env["CC"];
    delete process.env["MACOSX_DEPLOYMENT_TARGET"];
    global._init();
    global.importPaths.push(ds(IMPORT));
    setFatalErrorHandler(throwFatalError);
    out = [];
    err = [];
    const tap = (into: string[]) => (c: string | Uint8Array): boolean => {
        into.push(typeof c === "string" ? c : new TextDecoder().decode(c));
        return true;
    };
    vi.spyOn(process.stdout, "write").mockImplementation(tap(out));
    vi.spyOn(process.stderr, "write").mockImplementation(tap(err));
});

afterEach(() => {
    vi.restoreAllMocks();
    setFatalErrorHandler(null);
    ENV.forEach((k, i) => {
        if (savedEnv[i] === undefined)
            delete process.env[k];
        else
            process.env[k] = savedEnv[i];
    });
    rmSync(work, { recursive: true, force: true });
});

/** Writes `x.c` into the work directory, creates $TMPDIR, and runs the preprocessor with `-v` on. */
function preprocess(cpp: string[] = []): { ipath: string; csrc: string } {
    const csrc = join(work, "x.c");
    writeFileSync(csrc, "#define TWO 2\nint x = TWO;\n");
    mkdirSync(join(work, "tmp"), { recursive: true });
    global.params.v.verbose = true;
    configureCPreprocessor([], cpp, "");
    const ipath = dsToJs(runCPreprocessor(FileName.create(dsUtf8(csrc)), Loc.initial, new OutBuffer()).toChars());
    return { ipath, csrc };
}

describe("runCPreprocessor (cpreprocessor.cpp:55)", () => {
    test("the .i lands in a fresh itmp-ldc-<6 hex> directory under $TMPDIR, #defines kept (-dD)", () => {
        const { ipath } = preprocess();
        expect(ipath).toMatch(new RegExp(`^${join(work, "tmp")}/itmp-ldc-[0-9a-f]{6}/x\\.i$`));
        const text = readFileSync(ipath, "latin1");
        expect(text).toContain("#define TWO 2\n");
        expect(text).toContain("int x = 2;");
    });

    test("-v prints ldc2's command line: getCC, -std=c11, -target, -fno-blocks, the Posix leg", () => {
        const { ipath, csrc } = preprocess(["-DABC=3"]);
        expect(out.join("")).toBe(`/usr/bin/cc -std=c11 -target arm64-apple-macos${hostMacOS} -fno-blocks -DABC=3 -dD `
            + `-Wno-builtin-macro-redefined -E -include ${IMPORT}/importc.h ${csrc} -o ${ipath} \n`);
    });

    test("MACOSX_DEPLOYMENT_TARGET names the triple's OS version (targetmachine.cpp:459)", () => {
        process.env["MACOSX_DEPLOYMENT_TARGET"] = "13.1";
        preprocess();
        expect(out.join("")).toContain(" -target arm64-apple-macos13.1 ");
    });

    test("$CC with a space: the words after the command follow it (tool.cpp:180-192)", () => {
        process.env["CC"] = "cc -DFOO";
        preprocess();
        expect(out.join("")).toMatch(/^\/usr\/bin\/cc -DFOO -std=c11 /);
    });

    test("$CC not on the PATH: `cannot find program`, fatal (tool.cpp:154)", () => {
        process.env["CC"] = "nosuchcc";
        expect(() => preprocess()).toThrow(FatalError);
        expect(err.join("")).toBe("Error: cannot find program `nosuchcc`\n");
    });

    // ORACLE: ldmd2 with CC=<script ending in `exit 127`> (`exit 126`) prints `failed with status: -1` and
    // `message: No such file or directory` (`message: Program could not be executed`), from llvm::sys::Wait.
    test.each([[127, "No such file or directory"], [126, "Program could not be executed"]])(
        "a C compiler exiting with %i: status -1 and LLVM's message (tool.cpp:372-374), fatal", (code, message) => {
            const cc = join(work, `e${code}`);
            writeFileSync(cc, `#!/bin/sh\nexit ${code}\n`, { mode: 0o755 });
            process.env["CC"] = cc;
            expect(() => preprocess()).toThrow(FatalError);
            expect(err.join("")).toBe(`Error: ${cc} failed with status: -1\n       message: ${message}\n`
                + `       C preprocessor failed for file '${join(work, "x.c")}'\n`);
        });
});
