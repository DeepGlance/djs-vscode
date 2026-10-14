// Co-located tests for src/gen/uda.ts (the frontend half of gen/uda.cpp) and src/gen/semantic.ts (gen/semantic.d).
//
// Neither source has a `unittest` block (10 §1.6b). `hasComputeAttr` is reached as ldc2 reaches it, from
// `extraLDCSpecificSemanticAnalysis` after semantic3 (main.d:773), through the process entry (src/djs.ts
// `djsMain`) in a FRESH module registry per run, on sources written to a temporary directory. The return value
// is then read on the root module from the same registry.
//
// ORACLE: <ldc2-1.43.0>/bin/ldmd2 -c -o- -verrors=simple with the
// same sources; each expected text is its output, byte for byte (paths are the temporary ones). Where ldc2 goes
// on into DCompute's semantic (gen/semantic-dcompute.cpp), the shim stops instead (gen/semantic.ts header).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";

/** The first stderr line of the DCompute stop; src/djs.ts prints the stack after it. */
const DCOMPUTE_STOP = "Internal error: Error: DJS-ESCALATE(excluded): dcompute — dcomputeSemanticAnalysis "
    + "(gen/semantic-dcompute.cpp:295) at gen/semantic.d:26";

describe("hasComputeAttr (gen/uda.cpp:645) from extraLDCSpecificSemanticAnalysis (gen/semantic.d:20)", () => {
    const dir = mkdtempSync(join(tmpdir(), "djs-uda-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    const write = (name: string, text: string): string => {
        const p = join(dir, name);
        mkdirSync(join(p, ".."), { recursive: true });
        writeFileSync(p, text);
        return p;
    };

    /** Runs the shim on `f`; returns its exit code, its stderr, and `hasComputeAttr` of the root module
     *  `rootName`, read in the run's own registry after the run (null when the module is not there). */
    async function shim(f: string, rootName: string): Promise<{ code: number; stderr: string; attr: number | null }> {
        vi.resetModules();
        const { djsMain } = await import("../djs.js");
        const err: string[] = [];
        const dec = (c: string | Uint8Array): string => (typeof c === "string" ? c : new TextDecoder().decode(c));
        const o = vi.spyOn(process.stdout, "write").mockImplementation((): boolean => true);
        const e = vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array): boolean => {
            err.push(dec(c));
            return true;
        });
        let code: number;
        try {
            code = djsMain(["-c", "-o-", "-verrors=simple", f]);
        } finally {
            o.mockRestore();
            e.mockRestore();
        }
        const { Module } = await import("../dmd/dmodule.js");
        const { global } = await import("../dmd/globals.js");
        const { hasComputeAttr } = await import("./uda.js");
        const { dsToJs } = await import("../dstring.js");
        let attr: number | null = null;
        for (const m of Module.amodules) {
            if (m !== null && dsToJs(m.toPrettyChars()) === rootName) {
                const errors = global.errors;
                // upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool) (gen/semantic.ts asDsymbol)
                attr = hasComputeAttr(m as unknown as Parameters<typeof hasComputeAttr>[0]);
                expect(global.errors).toBe(errors); // the gagged CTFE leaves no error behind
            }
        }
        return { code, stderr: err.join(""), attr };
    }

    test("`@(1) module`: an integer UDA is no @compute; the module compiles (ddoc13645's shape)", async () => {
        const f = write("m1.d", "@(1) module m1;\nint x;\n");
        expect(await shim(f, "m1")).toEqual({ code: 0, stderr: "", attr: 0 });
    });

    test("`@(\"x\") module`: a string UDA is no @compute", async () => {
        const f = write("m2.d", "@(\"x\") module m2;\nint x;\n");
        expect(await shim(f, "m2")).toEqual({ code: 0, stderr: "", attr: 0 });
    });

    test("a UDA whose CTFE errors is skipped under the gag (gen/uda.cpp:101-104), with no diagnostic", async () => {
        // `g.a` is a DotVarExp of a mutable global: semantic2 does not interpret it (dtemplate.d:1064
        // definitelyValueParameter is false), and getMagicAttribute's ctfeInterpret fails on it, gagged.
        const f = write("c2.d", "@(g.a, 7) module c2;\nstruct S { int a; }\nS g;\n");
        expect(await shim(f, "c2")).toEqual({ code: 0, stderr: "", attr: 0 });
    });

    test("after a gagged CTFE failure the search goes on and finds @compute behind it", async () => {
        // ldc2 reaches DCompute's semantic here and reports
        // `c3.d(4): Error: global variables not allowed in `@compute` code`; the shim stops at that call.
        const f = write("c3.d", "@(g.a) @compute(CompileFor.hostAndDevice) module c3;\nimport ldc.dcompute;\n"
            + "struct S { int a; }\nS g;\n");
        const r = await shim(f, "c3");
        expect([r.code, r.stderr.split("\n")[0], r.attr]).toEqual([1, DCOMPUTE_STOP, 2]);
    });

    test("`@compute(CompileFor.deviceOnly)` from ldc.dcompute: 1 + 0, and the DCompute stop", async () => {
        // ldc2: exit 0, no output (DCompute's semantic finds nothing to reject in `void foo() {}`).
        const f = write("a4.d", "@compute(CompileFor.deviceOnly) module a4;\nimport ldc.dcompute;\nvoid foo() {}\n");
        const r = await shim(f, "a4");
        expect([r.code, r.stderr.split("\n")[0], r.attr]).toEqual([1, DCOMPUTE_STOP, 1]);
    });

    test("`@compute(-1)`: 1 + -1 is hostOnly, so no DCompute semantic (the C++ int arithmetic)", async () => {
        const f = write("d3/dcompute.d", "@compute(-1) module ldc.dcompute;\nstruct compute { int n; }\n");
        expect(await shim(f, "ldc.dcompute")).toEqual({ code: 0, stderr: "", attr: 0 });
    });

    test("a tuple UDA is flattened (gen/uda.cpp:96 expandTuples), and a compute literal in it is found", async () => {
        // Without the flattening the TupleExp interprets to no struct literal and is skipped: exit 0.
        const f = write("t1/dcompute.d", "@(Seq!(1, compute(5L))) module ldc.dcompute;\n"
            + "template Seq(A...) { alias Seq = A; }\nstruct compute { long n; }\n");
        const r = await shim(f, "never");
        expect([r.code, r.stderr]).toEqual([1, `${f}(1): Error: invalid field type in \`ldc.dcompute.compute\`; `
            + "does druntime not match compiler version?\n"]);
    });

    test("the first compute literal wins (gen/uda.cpp:109-110), not the last", async () => {
        // A last-match search would take `@compute(7)`, 1 + 7, and reach the DCompute stop.
        const f = write("t2/dcompute.d", "@compute(-1) @compute(7) module ldc.dcompute;\nstruct compute { int n; }\n");
        expect(await shim(f, "ldc.dcompute")).toEqual({ code: 0, stderr: "", attr: 0 });
    });

    test("checkStructElems (gen/uda.cpp:67): a field of another type is fatal", async () => {
        const f = write("d1/dcompute.d", "@compute(5L) module ldc.dcompute;\nstruct compute { long n; }\n");
        const r = await shim(f, "never");
        expect([r.code, r.stderr]).toEqual([1, `${f}(1): Error: invalid field type in \`ldc.dcompute.compute\`; `
            + "does druntime not match compiler version?\n"]);
    });

    test("checkStructElems (gen/uda.cpp:67): another field count is fatal", async () => {
        const f = write("d2/dcompute.d", "@compute(1, 2) module ldc.dcompute;\nstruct compute { int a; int b; }\n");
        const r = await shim(f, "never");
        expect([r.code, r.stderr]).toEqual([1, `${f}(1): Error: unexpected field count in \`ldc.dcompute.compute\`; `
            + "does druntime not match compiler version?\n"]);
    });
});
