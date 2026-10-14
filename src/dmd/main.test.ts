// Tests for src/dmd/main.ts (dmd/main.d has no unittest blocks; 10 §1.6b).
//
// The reconcilers are pure functions of a `Param`; `mars_tryMain` is exercised through the process entry
// (src/djs.ts `djsMain`), in a FRESH module registry per run, on sources written to a temporary directory.
//
// ORACLE: <ldc2-1.43.0>/bin/ldmd2 -c -o- with the same arguments and
// sources; each expected text is its output for that stream, byte for byte (paths are the temporary ones).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { CHECKACTION, CHECKENABLE } from "./astenums.js";
import { OUTPUTFLAGdefault, Param } from "./globals.js";
import { reconcileCommands, reconcileLinkRunLib } from "./main.js";
import { target } from "./target.js";
import { ds, dsToJs } from "../dstring.js";

describe("reconcileCommands (main.d:1204)", () => {
    test("no -release: every check on, null checks off", () => {
        const p = new Param();
        reconcileCommands(p, target);
        expect([p.useInvariants, p.useIn, p.useOut, p.useArrayBounds, p.useAssert, p.useSwitchError])
            .toEqual(Array(6).fill(CHECKENABLE.on));
        expect(p.useNullCheck).toBe(CHECKENABLE.off);
    });

    test("-release: checks off, bounds checks @safe-only; -unittest keeps asserts on", () => {
        const p = new Param();
        p.release = true;
        p.useUnitTests = true;
        reconcileCommands(p, target);
        expect(p.useAssert).toBe(CHECKENABLE.on);
        expect(p.useArrayBounds).toBe(CHECKENABLE.safeonly);
        expect([p.useInvariants, p.useIn, p.useOut, p.useSwitchError, p.useNullCheck])
            .toEqual(Array(5).fill(CHECKENABLE.off));
    });

    test("an explicit -boundscheck wins over the -release default", () => {
        const p = new Param();
        p.release = true;
        p.boundscheck = CHECKENABLE.on;
        reconcileCommands(p, target);
        expect(p.useArrayBounds).toBe(CHECKENABLE.on);
    });

    test("-betterC: C asserts, no ModuleInfo, TypeInfo, exceptions or GC", () => {
        const p = new Param();
        p.betterC = true;
        reconcileCommands(p, target);
        expect(p.checkAction).toBe(CHECKACTION.C);
        expect([p.useModuleInfo, p.useTypeInfo, p.useExceptions, p.useGC]).toEqual([false, false, false, false]);
    });
});

describe("reconcileLinkRunLib (main.d:1333)", () => {
    test("-o- turns linking off", () => {
        const p = new Param();
        p.obj = false;
        reconcileLinkRunLib(p, 1, target.obj_ext);
        expect(p.link).toBe(false);
    });

    test("linking with -of/-od: the exe keeps -of, the object file is renamed into -od", () => {
        const p = new Param();
        p.output_o = OUTPUTFLAGdefault;   // as ldc2's parseCommandLine leaves it without `-output-*` (main.cpp:464)
        p.objname = ds("out/prog");
        p.objdir = ds("objs");
        reconcileLinkRunLib(p, 1, target.obj_ext);
        expect(p.link).toBe(true);
        expect(p.oneobj).toBe(true);
        expect(dsToJs(p.exefile)).toBe("out/prog");
        expect(dsToJs(p.objname!)).toBe("objs/prog.o");
    });

    test("-c -of with sources: one object file", () => {
        const p = new Param();
        p.link = false;
        p.objname = ds("x.o");
        reconcileLinkRunLib(p, 2, target.obj_ext);
        expect(p.oneobj).toBe(true);
    });
});

describe("mars_tryMain through the shim — the driver sequence of main.d", () => {
    const dir = mkdtempSync(join(tmpdir(), "djs-main-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    const write = (name: string, text: string): string => {
        const p = join(dir, name);
        writeFileSync(p, text);
        return p;
    };

    async function shim(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        vi.resetModules();
        const { djsMain } = await import("../djs.js");
        const out: string[] = [];
        const err: string[] = [];
        const dec = (c: string | Uint8Array): string => (typeof c === "string" ? c : new TextDecoder().decode(c));
        const tap = (into: string[]) => (c: string | Uint8Array): boolean => {
            into.push(dec(c));
            return true;
        };
        const o = vi.spyOn(process.stdout, "write").mockImplementation(tap(out));
        const e = vi.spyOn(process.stderr, "write").mockImplementation(tap(err));
        try {
            const code = djsMain(args);
            return { code, stdout: out.join(""), stderr: err.join("") };
        } finally {
            o.mockRestore();
            e.mockRestore();
        }
    }

    test("-verrors=N: omitted deprecations are counted on stdout (main.d:314 mentionOmittedDeprecations)", async () => {
        const f = write("dep3.d", "deprecated void f() {}\nvoid g() { f(); f(); f(); }\n");
        const r = await shim(["-c", "-o-", "-verrors=simple", "-verrors=2", f]);
        expect(r.code).toBe(0);
        const pair = `${f}(2): Deprecation: function \`dep3.f\` is deprecated\n`
            + `${f}(1):        \`f\` is declared here\n`;
        expect(r.stderr).toBe(pair.repeat(2));
        expect(r.stdout).toBe("1 deprecation warning omitted, use `-verrors=0` to show all\n");
    });

    test("-v -main: the pass messages in main.d's order, then the `-main` module's entry point", async () => {
        const f = write("nomain.d", "int x;\n");
        const r = await shim(["-c", "-o-", "-main", "-v", f]);
        expect(r.code).toBe(0);
        const lines = r.stdout.split("\n").filter((l) => !/^(import |\(imported|binary|config)/.test(l));
        // ldc2 prints `GC stats  …` after `entry` (main.d:885-900); the shim does not (main.ts, GC stats note).
        expect(lines).toEqual([
            "version   1.43.0 (DMD v2.113.0, LLVM 22.1.8)",
            "predefs  LDC all D_Version2 assert D_PreConditions D_PostConditions D_Invariants D_ModuleInfo "
            + "D_Exceptions D_TypeInfo AArch64 ARM_HardFloat D_HardFloat LittleEndian D_LP64 D_PIC OSX Apple darwin "
            + "Posix CppRuntime_LLVM CppRuntime_Clang LDC_LLVM_22 D_ObjectiveC",
            "parse     nomain", "importall nomain", "semantic  nomain", "semantic2 nomain", "semantic3 nomain",
            "entry     main      \t__main.d", "",
        ]);
    });

    test("an error in pass 1 stops before pass 3 (main.d:743's check): no semantic3 line", async () => {
        const f = write("bad.d", "Undefined x;\n");
        const r = await shim(["-c", "-o-", "-v", "-verrors=simple", f]);
        expect(r.code).toBe(1);
        expect(r.stderr).toBe(`${f}(1): Error: undefined identifier \`Undefined\`\n`);
        const passes = r.stdout.split("\n").filter((l) => /^(parse|importall|semantic)/.test(l));
        expect(passes).toEqual(["parse     bad", "importall bad", "semantic  bad", "semantic2 bad"]);
    });

    test("without -o-, the object file is codegen: the shim stops there, after sema", async () => {
        const f = write("ok.d", "int x;\n");
        const r = await shim(["-c", f]);
        expect(r.code).toBe(1);
        expect(r.stderr.split("\n")[0]).toBe("Internal error: Error: DJS-ESCALATE(excluded): codegen — codegenModules "
            + "(driver/main.cpp:1298) at dmd/main.d:912");
    });
});
