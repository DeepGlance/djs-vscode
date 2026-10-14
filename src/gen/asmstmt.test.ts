// Co-located tests for src/gen/asmstmt.ts (`asmSemantic`, djs's own) and, through it, the semantic half of
// src/dmd/iasm/gcc.ts.
//
// Each pin is a whole D module. The GCC-style and aarch64 cases go through lex -> parse -> runSemantic, their
// diagnostics compared with ldc2 1.43.0 (arm64-apple-darwin) on the same source (`ldc2 -c -o- -vcolumns`). The
// x86_64 cases run one `djsMain` under `-mtriple=x86_64-linux-gnu`: there djs keeps the DMD-style statement
// unanalysed and warns once per module, where ldc2 runs its x86 parser (asmstmt.ts notes).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
// First on purpose (01 §4.8): the module under test is the entry of its import graph here.
import { asmSemantic } from "./asmstmt.js";
import { initSemaHarness, sourceMembers, userBody } from "../sema-harness.js";
import { Parser } from "../dmd/parse.js";
import { ErrorSinkNull } from "../dmd/errorsink.js";
import { global } from "../dmd/globals.js";
import { moduleFromParse, type Module } from "../dmd/dmodule.js";
import { runSemantic } from "../dmd/dsymbolsem.js";
import {
    ErrorSinkCompiler, FatalError, setDiagnosticHandler, setFatalErrorHandler, throwFatalError,
} from "../dmd/errors.js";
import { dmdformat } from "../dmd/root/dmdformat.js";
import { initDtemplate } from "../dmd/dtemplate.js";
import { EXP } from "../dmd/tokens.js";
import { dsToJs } from "../dstring.js";
import type { Dsymbols } from "../dmd/arraytypes.js";
import type { GccAsmStatement, Statement } from "../dmd/statement.js";

let messages: string[] = [];

beforeEach(() => {
    initSemaHarness();
    initDtemplate();
    global.params.useInlineAsm = true; // the driver's default, `!noAsm` (driver/main.cpp:347; djs.ts)
    // The asm parser reports through `global.errorSink` (dmd/iasm/gcc.d:48-49), as ldc2's driver installs it.
    global.errorSink = new ErrorSinkCompiler();
    messages = [];
    setDiagnosticHandler((loc, _color, header, messageFormat, args) => {
        const text = dsToJs(dmdformat(messageFormat, [...args]));
        messages.push(`(${loc.linnum},${loc.charnum}): ${dsToJs(header)}${text}`);
        return true;
    });
    setFatalErrorHandler(throwFatalError);
});

afterEach(() => {
    setDiagnosticHandler(null);
    setFatalErrorHandler(null);
});

/** NUL-terminated source buffer (the lexer scans to the NUL). */
function srcBuf(s: string): Uint8Array {
    const b = new Uint8Array(s.length + 1);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    return b;
}

/** Lex, parse and run semantic over `src`; a `fatal()` surfaces as `FatalError`. */
function sema(src: string): Module {
    const p = new Parser(null, null, srcBuf(src), false, new ErrorSinkNull(), null, false);
    p.nextToken();
    const members: Dsymbols = p.parseModule();
    const m = moduleFromParse(members, p.md);
    runSemantic(m);
    return m;
}

/** Runs `src` and returns its diagnostics, with "FATAL" appended when semantic stopped in `fatal()`. */
function diagnose(src: string): string[] {
    try {
        sema(src);
    } catch (ex) {
        if (!(ex instanceof FatalError))
            throw ex;
        messages.push("FATAL");
    }
    return messages;
}

/** Every statement of `s` in source order, descending into compound, scope and label statements. */
function flatten(s: Statement | null, out: Statement[] = []): Statement[] {
    if (s === null)
        return out;
    out.push(s);
    const cs = s.isCompoundStatement() ?? s.isCompoundAsmStatement();
    if (cs !== null) {
        for (let i = 0; i < cs.statements!.length; i++)
            flatten(cs.statements!.opIndex(i), out);
    }
    const ss = s.isScopeStatement();
    if (ss !== null)
        flatten(ss.statement, out);
    const ls = s.isLabelStatement();
    if (ls !== null)
        flatten(ls.statement, out);
    return out;
}

/** The GCC-style statements of function `name`'s body, after semantic. */
function gccStatements(m: Module, name: string): GccAsmStatement[] {
    for (const d of sourceMembers(m)) {
        const fd = d.isFuncDeclaration();
        if (fd !== null && dsToJs(fd.ident!.toString()) === name)
            return flatten(userBody(fd)).map((s) => s.isGccAsmStatement()).filter((s) => s !== null);
    }
    throw new Error(`no function ${name}`);
}

describe("gen/asmstmt — module surface", () => {
    test("loads first and exports asmSemantic", () => {
        expect(typeof asmSemantic).toBe("function");
    });
});

describe("GCC-style asm statements (gccAsmSemantic, dmd/iasm/gcc.d:43)", () => {
    test("outputs, inputs and clobbers are analysed", () => {
        const m = sema(`module m;
void f(int input)
{
    int a, b;
    asm { "add %0, %1, %2" : "=r" (a) : "r" (input), "r" (b) : "memory", "cc"; }
}`);
        expect(messages).toEqual([]);
        const [gas] = gccStatements(m, "f");
        expect(gas).toBeDefined();
        expect(gas!.outputargs).toBe(1);
        expect(gas!.args!.length).toBe(3);
        for (let i = 0; i < 3; i++)
            expect(gas!.args!.opIndex(i)!.op).toBe(EXP.variable);
        expect(dsToJs(gas!.insn!.isStringExp()!.peekString())).toBe("add %0, %1, %2");
        expect(gas!.insn!.type!.ty).toBe(gas!.constraints!.opIndex(0)!.type!.ty);
        expect(gas!.clobbers!.length).toBe(2);
        expect(dsToJs(gas!.clobbers!.opIndex(1)!.isStringExp()!.peekString())).toBe("cc");
        expect(gas!.labels).toBeNull();
    });

    test("goto labels become analysed GotoStatements", () => {
        const m = sema(`module m;
void g()
{
    asm { "b %l0" :: : "memory" : Lend; }
Lend:
    return;
}`);
        expect(messages).toEqual([]);
        const [gas] = gccStatements(m, "g");
        expect(gas!.labels!.length).toBe(1);
        expect(gas!.gotos!.length).toBe(1);
        expect(dsToJs(gas!.gotos!.opIndex(0)!.ident!.toString())).toBe("Lend");
        expect(gas!.gotos!.opIndex(0)!.label).not.toBeNull();
    });

    test("a CTFE-able instruction template is folded", () => {
        const m = sema(`module m;
enum insn = "n" ~ "op";
void f()
{
    asm { (insn); }
}`);
        expect(messages).toEqual([]);
        const [gas] = gccStatements(m, "f");
        expect(dsToJs(gas!.insn!.isStringExp()!.peekString())).toBe("nop");
    });

    // ldc2 -c -o- -vcolumns on this source: (5,35).
    test("labels with output constraints (dmd/iasm/gcc.d:85)", () => {
        expect(diagnose(`module m;
void h()
{
    int a;
    asm { "" : "=r" (a) : : : Lend; }
Lend:
}`)).toEqual(["(5,35): Error: extended asm statements with labels cannot have output constraints"]);
    });

    // ldc2 -c -o- -vcolumns on this source: (5,25).
    test("malformed operand list: parse error, statement dropped", () => {
        expect(diagnose(`module m;
void f()
{
    int a;
    asm { "" : "=r" (a) d; }
}`)).toEqual(["(5,25): Error: found `d` when expecting `;`"]);
    });

    // ldc2 -vcolumns on the same source.
    test("an output operand must be a modifiable lvalue", () => {
        expect(diagnose(`module m;
void f()
{
    asm { "" : "=r" (1); }
}`)).toEqual(["(4,22): Error: cannot modify constant `1`"]);
    });

    // ldc2 -c -o- -vcolumns -noasm on this source: no output, exit 0. The `useInlineAsm` test
    // sits on the DMD-style leg only.
    test("-noasm does not reject GCC-style asm", () => {
        global.params.useInlineAsm = false;
        expect(diagnose(`module m;
void f()
{
    int a;
    asm { "nop" : "=r" (a); }
}`)).toEqual([]);
    });
});

describe("DMD-style asm statements on aarch64 (LDC's rejection)", () => {
    // ldc2 -c -o- -vcolumns on this source: (4,21), then exit 1.
    test("rejected on aarch64, then fatal", () => {
        expect(diagnose(`module m;
void f()
{
    asm { mov x0, x1; }
}`)).toEqual([
            "(4,21): Error: DMD-style `asm { op; }` statements are not supported for the \"arm64\" architecture.",
            "(4,21):        Use GDC-style `asm { \"op\" : …; }` syntax or `ldc.llvmasm.__asm` instead.",
            "FATAL",
        ]);
    });

    // ldc2 -noasm: both errors, then the compilation stops.
    test("-noasm adds its own error", () => {
        global.params.useInlineAsm = false;
        expect(diagnose(`module m;
void f()
{
    asm { mov x0, x1; }
}`)).toEqual([
            "(4,21): Error: DMD-style `asm { op; }` statements are not supported for the \"arm64\" architecture.",
            "(4,21):        Use GDC-style `asm { \"op\" : …; }` syntax or `ldc.llvmasm.__asm` instead.",
            "(4,21): Error: the `asm` statement is not allowed when the -noasm switch is used",
            "FATAL",
        ]);
    });

    // ldc2 prints `false` and compiles the GCC-style statement: gagged, the error does not stop compilation.
    test("gagged inside __traits(compiles): no fatal, the test is false", () => {
        expect(diagnose(`module m;
void f()
{
    enum ok = __traits(compiles, { asm { mov x0, x1; } });
    static assert(!ok);
    asm { "nop"; }
}`)).toEqual([]);
    });
});

/** One `djsMain(args)` from `cwd` in a fresh module registry (a new ldmd2 process), streams captured apart. */
async function djsRun(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
    vi.resetModules();
    const { djsMain } = await import("../djs.js");
    const out: string[] = [];
    const err: string[] = [];
    const tap = (into: string[]) => (c: string | Uint8Array): boolean => {
        into.push(typeof c === "string" ? c : new TextDecoder().decode(c));
        return true;
    };
    const o = vi.spyOn(process.stdout, "write").mockImplementation(tap(out));
    const e = vi.spyOn(process.stderr, "write").mockImplementation(tap(err));
    const here = process.cwd();
    try {
        process.chdir(cwd);
        return { code: djsMain(args), stdout: out.join(""), stderr: err.join("") };
    } finally {
        process.chdir(here);
        o.mockRestore();
        e.mockRestore();
    }
}

/** Compiles `src` as `<name>.d` under the x86_64 triple, with `flags` before the file. */
async function compileX86(name: string, src: string, flags: string[] = []):
        Promise<{ code: number; stdout: string; stderr: string }> {
    const dir = mkdtempSync(join(tmpdir(), "djs-asm-x86-"));
    try {
        writeFileSync(join(dir, `${name}.d`), src);
        return await djsRun(["-mtriple=x86_64-linux-gnu", "-c", "-o-", ...flags, `${name}.d`], dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// Two blocks, one of them an instruction ldc2's parser rejects ("unknown opcode `frobnicate`"): djs sees neither.
const X86 = [
    "module x;",
    "int f(int x) {",
    "    asm { mov EAX, x; add EAX, 1; L1: jmp L1; }",
    "    asm { frobnicate EAX; }",
    "    return x;",
    "}",
].join("\n") + "\n";

const X86_WARNING = [
    "x.d(3): Warning: inline assembly is not checked by djs (x86 DMD-style asm parser not included, see LICENSE)",
    "    asm { mov EAX, x; add EAX, 1; L1: jmp L1; }",
    "                    ^",
].join("\n") + "\n";

describe("DMD-style asm statements on x86_64 (kept unanalysed)", () => {
    test("silent by default: the warning class is off", async () => {
        expect(await compileX86("x", X86)).toEqual({ code: 0, stdout: "", stderr: "" });
    }, 120_000);

    test("-wi: one warning for the module, at its first DMD-style instruction", async () => {
        expect(await compileX86("x", X86, ["-wi"])).toEqual({ code: 0, stdout: "", stderr: X86_WARNING });
    }, 120_000);

    // ldc2 -w compiles the module: the notice must not fail it.
    test("-w: printed, not counted as an error", async () => {
        expect(await compileX86("x", X86, ["-w"])).toEqual({ code: 0, stdout: "", stderr: X86_WARNING });
    }, 120_000);

    // ldc2 reports the same error: `naked` is still recognised.
    test("`naked` marks the function naked", async () => {
        const src = "module n;\nvoid g(int a)\nin (a > 0)\n{\n    asm { naked; ret; }\n}\n";
        const r = await compileX86("n", src);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain(
            "n.d(2): Error: function `n.g` naked assembly functions with contracts are not supported");
    }, 120_000);
});
