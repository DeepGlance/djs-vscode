// The fast DFA's diagnostic ORDER against ldc2, end to end on the driver path.
//
// Hand-written djs test (NOT a port of any dmd/ file). The DFA engine keys its scope-variable buckets by DFAVar
// address, and a DFAScope's bucket order is the order it visits (and reports on) its variables; the port runs that
// on simulated addresses (src/dmd/dfa/fast/structure.ts, ALLOCATOR and POINTER IDIOMS). The condition on that model
// is that it reproduces ldc2's order on programs that produce several DFA diagnostics in one run, several of them
// out of source order. Each program here is compiled once by ldc2 1.43.0 and once by the shim, and the merged
// stdout+stderr must be byte-identical.
//
// ORACLE: from this directory, `ldc2 -preview=fastdfa -verrors=0 -c -o- <name>.d > <name>.expected 2>&1`
// (<ldc2-1.43.0>/bin/ldc2); every program exits with status 1.
// m01.limit.expected is `ldc2 -preview=fastdfa -c -o- m01.d > m01.limit.expected 2>&1` (the default -verrors=20):
// the run stops at `error limit (20) reached`, where D's fatal() exits, so no ICE line follows (dfa/entry.ts).
// The programs, by what they exercise:
//   m01  24 null dereferences in reverse declaration order, one scope
//   m02  floats and pointers across a loop, a nested block and asserts; supplemental lines
//   m03  gotos forward and backward between labels
//   m04  a switch with `goto case`, reported default arm first
//   m05  parameters nulled and dereferenced out of order
//   m06  struct fields and pointers to structs
//   m07  nested loops: the reports come out at loop convergence, inner loop first
//   m08  300 locals, every seventh dereferenced
//   m09  5000 locals (2500 pointers, 2500 floats), so the static 128 KiB region overflows into malloc'd ones.
//        Its source is regular, so it is generated here (m09Source) instead of committed; m09.expected is ldc2's
//        output for exactly that text.
//   m10  nested blocks, a struct local and both arms of an if
//   m11  12 pointers required non-null in a loop and nulled: all reported at loop convergence, in the order the
//        loop scope's buckets hold them (address % 16, then ascending address)
//   m12  m11's loop after 5000 locals, so its pointers live in a malloc'd region: ldc2 reports the other address
//        parity first. Generated (m12Source), like m09.
// Only m07, m11 and m12 depend on the address model: the other programs report as the walk reads, so their order
// is the walk's. Measured on an isolated copy: shifting every DFAVar address by 8 fails m07, m11 and m12;
// reversing the address order within the same parity fails m11 and m12; moving the malloc'd regions' base by 8
// fails m12.
//
// Each run starts in a fresh module registry (`vi.resetModules()` + dynamic imports), as src/dmd/dmodule.test.ts's
// compile() does, so every process-global (the allocator's regions included) starts from its load-time value, as in
// a new ldc2 process. The shim writes stdout and stderr through `process.*.write`; both are captured into one list in
// write order, which is what `2>&1` into one file gives the oracle. The source directory prefix is removed from the
// shim's output so that paths print as ldc2 printed them when run on the bare file name.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

/** m09.d, byte for byte: 2500 pointer/float declaration pairs, then every 211th pair read. */
function m09Source(): string {
    const lines = ["void huge()", "{"];
    for (let i = 1; i <= 2500; i++)
        lines.push(`    int* p${i}; float f${i};`);
    for (let i = 211; i <= 2500; i += 211)
        lines.push(`    int v${i} = *p${i}; float r${i} = f${i} * 2;`);
    lines.push("}");
    return lines.join("\n") + "\n";
}

/** The loop of m11.d and m12.d: 12 pointers dereferenced in a loop, then nulled in a scrambled order. */
function nulledInLoop(): string[] {
    const n = 12;
    const lines: string[] = [];
    for (let i = 1; i <= n; i++)
        lines.push(`    int* p${i} = new int;`);
    lines.push("    foreach (i; 0 .. 2)", "    {");
    for (let i = 1; i <= n; i++)
        lines.push(`        int a${i} = *p${i};`);
    for (const i of [7, 3, 11, 1, 9, 5, 12, 2, 10, 4, 8, 6])
        lines.push(`        p${i} = null;`);
    lines.push("    }");
    return lines;
}

/** m12.d, byte for byte: 2500 pointer/float declaration pairs, then m11's loop. */
function m12Source(): string {
    const lines = ["void huge()", "{"];
    for (let i = 1; i <= 2500; i++)
        lines.push(`    int* q${i}; float f${i};`);
    lines.push(...nulledInLoop(), "}");
    return lines.join("\n") + "\n";
}

interface Run { status: number; output: string; }

/**
 * Compiles `dir/<name>.d` through the shim as `ldc2 -preview=fastdfa <args> -c -o- <file>` in a fresh module
 * registry. `output` is stdout and stderr merged in write order, with `dir/` removed.
 */
async function compile(dir: string, name: string, args: readonly string[] = ["-verrors=0"]): Promise<Run> {
    vi.resetModules();
    const { djsMain } = await import("../../src/djs.js");

    const out: string[] = [];
    const tap = (chunk: string | Uint8Array): boolean => {
        out.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        return true;
    };
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(tap);
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(tap);
    try {
        const status = djsMain(["-preview=fastdfa", ...args, "-c", "-o-", join(dir, `${name}.d`)]);
        return { status, output: out.join("").split(`${dir}/`).join("") };
    } finally {
        errSpy.mockRestore();
        outSpy.mockRestore();
    }
}

function expected(name: string): string {
    return readFileSync(join(HERE, `${name}.expected`), "utf8");
}

describe("fast DFA: several diagnostics per run, in ldc2's order (simulated DFAVar addresses)", () => {
    for (const name of ["m01", "m02", "m03", "m04", "m05", "m06", "m07", "m08", "m10", "m11"]) {
        test(`${name}.d matches ldc2 byte for byte`, async () => {
            const r = await compile(HERE, name);
            expect(r.output).toBe(expected(name));
            expect(r.status).toBe(1);
        });
    }

    test("m01.d at the default error limit matches ldc2", async () => {
        const r = await compile(HERE, "m01", []);
        expect(r.output).toBe(expected("m01.limit"));
        expect(r.status).toBe(1);
    });

    test("m11.d is m11's loop, as generated for m12", () => {
        const lines = ["void loops()", "{", ...nulledInLoop(), "}"];
        expect(lines.join("\n") + "\n").toBe(readFileSync(join(HERE, "m11.d"), "utf8"));
    });

    const generated: [string, () => string][] = [["m09", m09Source], ["m12", m12Source]];
    for (const [name, source] of generated) {
        test(`${name} (generated, 5000 locals over several allocator regions) matches ldc2 byte for byte`, async () => {
            const dir = mkdtempSync(join(tmpdir(), "djs-dfa-"));
            try {
                writeFileSync(join(dir, `${name}.d`), source());
                const r = await compile(dir, name);
                expect(r.output).toBe(expected(name));
                expect(r.status).toBe(1);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        }, 120_000);
    }
});
