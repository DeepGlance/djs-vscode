// Co-located tests for src/dmd/iasm/gcc.ts (dmd/iasm/gcc.d).
//
// The first describe ports gcc.d's one unittest (dmd/iasm/gcc.d:555-785) table by table. The D block
// initializes only the cached types its fail cases need (`tint32`, `tchar`, gcc.d:568-583) because the D
// unittest runner has not run `Type._init()`; the harness here runs the full init (10 §1.5), a superset.
// The second describe pins what the parser stores and the parser diagnostics, byte-exact against ldc2
// 1.43.0 (arm64-apple-darwin), with errors not gagged.

import { afterEach, beforeEach, describe, expect, test } from "vitest";
// First on purpose (01 §4.8): the module under test is the entry of its import graph here.
import { gccAsmSemanticCAsmDeclaration, parseGccAsm } from "./gcc.js";
import { initSemaHarness } from "../../sema-harness.js";
import { GccAsmStatement } from "../statement.js";
import { Parser } from "../parse.js";
import { CParser } from "../cparse.js";
import { global } from "../globals.js";
import { target } from "../target.js";
import { Loc } from "../location.js";
import { Token, TOK } from "../tokens.js";
import { ErrorSinkCompiler, setDiagnosticHandler } from "../errors.js";
import { dmdformat } from "../root/dmdformat.js";
import { cstr, ds, dsToJs } from "../../dstring.js";
import { CAsmDeclaration, type Dsymbol } from "../dsymbol.js";
import { Module, moduleFromParse } from "../dmodule.js";
import { StringExp } from "../expression.js";
import { scopeCreateGlobal } from "../dsymbolsem.js";
import { typeToChars } from "../hdrgen.js";
import { Array as DArray } from "../root/array.js";

/** NUL-terminated source buffer (the lexer scans to the NUL, as D's string literals end in one). */
function srcBuf(s: string): Uint8Array {
    const b = new Uint8Array(s.length + 1);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    return b;
}

/** dmd/iasm/gcc.d:586 — `semanticAsm`: imitates asmSemantic if version = IN_GCC; returns the new errors. */
function semanticAsm(tokens: Token, importC: boolean, gas?: GccAsmStatement): number {
    const errors = global.errors;
    gas ??= new GccAsmStatement(Loc.initial, tokens);
    const doUnittests = false;
    const p: Parser = importC
        ? new CParser(null, srcBuf(";"), false, global.errorSink!, target.c, null, global.compileEnv)
        : new Parser(null, null, srcBuf(";"), false, global.errorSink!, global.compileEnv, doUnittests);
    Object.assign(p.token, tokens.copy()); // `p.token = *tokens;`
    parseGccAsm(p, gas);
    return global.errors - errors;
}

/**
 * dmd/iasm/gcc.d:600 — `parseAsm`, imitating parseStatement for asm statements: the tokens between the
 * braces of `asm { ... }` (each `::` split into two `:`), handed to semanticAsm. Returns the error count.
 */
function parseAsm(input: string, importC = false, gas?: GccAsmStatement): number {
    // Generate tokens from input test.
    const doUnittests = false;
    const p = new Parser(null, null, srcBuf(input), false, global.errorSink!, global.compileEnv, doUnittests);
    p.nextToken();

    let toklist: Token | null = null;
    let last: Token | null = null;
    const append = (t: Token): void => {
        if (last === null) toklist = t;
        else last.next = t;
        last = t;
    };
    p.check(TOK.asm_);
    p.check(TOK.leftCurly);
    while (true) {
        if ((p.token.value as TOK) === TOK.rightCurly || (p.token.value as TOK) === TOK.endOfFile)
            break;
        if (p.token.value === TOK.colonColon) {
            for (let k = 0; k < 2; k++) {
                const t = p.allocateToken();
                Object.assign(t, p.token.copy());
                t.value = TOK.colon;
                append(t);
            }
        } else {
            const t = p.allocateToken();
            Object.assign(t, p.token.copy());
            append(t);
        }
        last!.next = null;
        p.nextToken();
    }
    p.check(TOK.rightCurly);

    return semanticAsm(toklist!, importC, gas);
}

/// Assembly Tests, all should pass (dmd/iasm/gcc.d:645).
/// Note: Frontend is not initialized, use only strings and identifiers.
const passAsmTests: string[] = [
    // Basic asm statement
    `asm { "nop";
        }`,

    // Extended asm statement
    `asm { "cpuid"
               : "=a" (a), "=b" (b), "=c" (c), "=d" (d)
               : "a" (input);
        }`,

    // Assembly with symbolic names
    `asm { "bts %[base], %[offset]"
               : [base] "+rm" (*ptr)
               : [offset] "Ir" (bitnum);
        }`,

    // Assembly with clobbers
    `asm { "cpuid"
               : "=a" (a)
               : "a" (input)
               : "ebx", "ecx", "edx";
        }`,

    // Goto asm statement
    `asm { "jmp %l0"
               :
               :
               :
               : Ljmplabel;
        }`,

    // Any CTFE-able string allowed as instruction template.
    `asm { (generateAsm);
        }`,

    // Likewise mixins, permissible so long as the result is a string.
    "asm { (mixin(`\"repne\"`, `~ \"scasb\"`));\n        }",

    // :: token tests
    `asm { "" : : : "memory"; }`,
    `asm { "" :: : "memory"; }`,
    `asm { "" : :: "memory"; }`,
    `asm { "" ::: "memory"; }`,
    `asm { "" :::: label; }`,

    // https://github.com/dlang/dmd/issues/21299
    `asm { (insn) : (output) (a) : (input) (1) : (clobber); }`,
    `asm { (['t','e','s','t']) : (['=','r']) (a) : (['r']) (1) : (['m','e','m','o','r','y']); }`,

    // https://github.com/dlang/dmd/issues/21679
    `asm { "" : "=r" (s.x); }`,
];

/// dmd/iasm/gcc.d:700.
const failAsmTests: string[] = [
    // Found 'h' when expecting ';'
    `asm { ""h;
        }`,

    // https://issues.dlang.org/show_bug.cgi?id=20592
    `asm { "nop" : [name] string (expr); }`,

    // Expression expected, not ';'
    `asm { ""[;
        }`,

    // Expression expected, not ':'
    `asm { ""
               :
               : "g" (a ? b : : c);
        }`,

    // Found ',' when expecting ':'
    `asm { "", "";
        }`,

    // Identifier expected, not ';'
    `asm { "" : ::: ; }`,
    `asm { "" :: :: ; }`,
    `asm { "" ::: : ; }`,
    `asm { "" :::: ; }`,

    // https://issues.dlang.org/show_bug.cgi?id=20593
    `asm { "instruction" : : "operand" 123; }`,

    // https://github.com/dlang/dmd/issues/21298
    `asm { 1; }  `,
    `asm { int; }`,
    `asm { : "=r" (i); }`,
    `asm { (; }`,
    `asm { (""; }`,
    `asm { "" ,; }`,
    `asm { "" d; }`,
    `asm { "" : (; }`,
    `asm { "" : (""; }`,
    `asm { "" : ""; }`,
    `asm { "" : "" (; }`,
    `asm { "" : "" (a; }`,
    `asm { "" : "" (a) ,; }`,
    `asm { "" : "" (a) d; }`,
    `asm { "" : "" (a) : (; }`,
    `asm { "" : "" (a) : (""; }`,
    `asm { "" : "" (a) : ""; }`,
    `asm { "" : "" (a) : "" (; }`,
    `asm { "" : "" (a) : "" (b; }`,
    `asm { "" : "" (a) : "" (b) ,; }`,
    `asm { "" : "" (a) : "" (b) d; }`,
    `asm { "" : "" (a) : "" (b) : (; }`,
    `asm { "" : "" (a) : "" (b) : (""; }`,
    `asm { "" : "" (a) : "" (b) : "" ,; }`,
    `asm { "" : "" (a) : "" (b) : "" d; }`,
    `asm { "" : "" (a) : "" (b) : "" : (; }`,
    `asm { "" : "" (a) : "" (b) : "" : c ,; }`,
    `asm { "" : "" (a) : "" (b) : "" : c d; }`,
    `asm { "" : "" (a) : "" (b) : "" : c :; }`,
    `asm { "" : "" (a) : "" (b) : "" : c : (; }`,
    `asm { "" : "" (a) : "" (b) : "" : c : (""; }`,
    `asm { "" : "" (a) : "" (b) : "" : c : "" (; }`,
    `asm { "" : "" (a) : "" (b) : "" : c : "" (d; }`,
    `asm { "" : "" (a) : "" (b) : "" : c : "" (d); }`,

    // https://github.com/dlang/dmd/issues/21679
    `asm { "" : "=r" (s->x); }`,
];

/// dmd/iasm/gcc.d:771.
const passCAsmTests: string[] = [
    // https://github.com/dlang/dmd/issues/21679
    `asm { "" : "=r" (s->x); }`,
    `asm { "" : "=r" (s.x); }`,
];

describe("dmd/iasm/gcc.d unittest (gcc.d:555), gagged", () => {
    let gagErrors = 0;
    beforeEach(() => {
        initSemaHarness();
        global.errorSink = new ErrorSinkCompiler(); // gcc.d:560-561
        gagErrors = global.startGagging(); // gcc.d:563-564
    });
    afterEach(() => {
        global.endGagging(gagErrors);
    });

    // gcc.d:640 — Checks for both unexpected passes and failures (`assert((res == 0) != expectError, input)`);
    // the three tables are driven by the foreach loops at gcc.d:777-784.
    test.each(passAsmTests)("passAsmTests: %s", (input) => {
        expect(parseAsm(input)).toBe(0);
    });
    test.each(failAsmTests)("failAsmTests: %s", (input) => {
        expect(parseAsm(input)).not.toBe(0);
    });
    test.each(passCAsmTests)("passCAsmTests (importC): %s", (input) => {
        expect(parseAsm(input, /*importC*/true)).toBe(0);
    });
});

describe("parseGccAsm — parsed fields and diagnostics, byte-exact against ldc2", () => {
    let messages: string[] = [];
    beforeEach(() => {
        initSemaHarness();
        global.errorSink = new ErrorSinkCompiler();
        messages = [];
        setDiagnosticHandler((loc, _color, header, messageFormat, args) => {
            const text = dsToJs(dmdformat(messageFormat, [...args]));
            messages.push(`(${loc.linnum},${loc.charnum}): ${dsToJs(header)}${text}`);
            return true;
        });
    });
    afterEach(() => {
        setDiagnosticHandler(null);
    });

    test("extended asm: outputs, inputs, symbolic names, clobbers", () => {
        const gas = new GccAsmStatement(Loc.initial, null);
        expect(parseAsm(`asm { "add %0, %1" : [r] "=r" (a) : "r" (b), [c] "r" (c) : "memory", "cc"; }`,
            false, gas)).toBe(0);
        expect(gas.outputargs).toBe(1);
        expect(gas.args!.length).toBe(3);
        expect(gas.names!.length).toBe(3);
        expect(gas.constraints!.length).toBe(3);
        expect(dsToJs(gas.names!.opIndex(0)!.toString())).toBe("r");
        expect(gas.names!.opIndex(1)).toBeNull();
        expect(dsToJs(gas.names!.opIndex(2)!.toString())).toBe("c");
        expect(gas.clobbers!.length).toBe(2);
        expect(gas.labels).toBeNull();
        expect(messages).toEqual([]);
    });

    test("goto asm: `::` and `:` separators, labels", () => {
        const gas = new GccAsmStatement(Loc.initial, null);
        expect(parseAsm(`asm { "b %l0" :: : "memory" : L1, L2; }`, false, gas)).toBe(0);
        expect(gas.outputargs).toBe(0);
        expect(gas.args).toBeNull();
        expect(gas.clobbers!.length).toBe(1);
        expect(gas.labels!.length).toBe(2);
        expect(dsToJs(gas.labels!.opIndex(0)!.toString())).toBe("L1");
        expect(dsToJs(gas.labels!.opIndex(1)!.toString())).toBe("L2");
    });

    test("basic asm leaves every operand list null", () => {
        const gas = new GccAsmStatement(Loc.initial, null);
        expect(parseAsm(`asm { "nop"; }`, false, gas)).toBe(0);
        expect(gas.insn!.isStringExp()).not.toBeNull();
        expect(gas.args).toBeNull();
        expect(gas.clobbers).toBeNull();
        expect(gas.labels).toBeNull();
    });

    // ldc2 -c -o- on `void f() { int a; asm { "" : "=r" (a) d; } }` (line 4, column 25 there).
    test.each([
        [`asm { "" : "=r" (a) d; }`, ["(1,21): Error: found `d` when expecting `;`"]],
        [`asm { "" : "=r" (a; }`, ["(1,19): Error: found `;` when expecting `)`"]],
        [`asm { "nop" : [name] string (expr); }`,
            ["(1,22): Error: expected string literal or expression in parentheses"]],
        [`asm { "" : [1] "r" (a); }`, ["(1,13): Error: identifier expected after `[`"]],
        [`asm { "" :::: ; }`, ["(1,15): Error: identifier expected for goto label name, not `;`"]],
    ])("diagnostic: %s", (input, expected) => {
        parseAsm(input);
        expect(messages).toEqual(expected);
    });
});

describe("gccAsmSemanticCAsmDeclaration (dmd/iasm/gcc.d:139)", () => {
    beforeEach(() => {
        initSemaHarness();
        global.errorSink = new ErrorSinkCompiler();
    });
    afterEach(() => {
        Module.rootModule = null;
    });

    /** A module named `name` with no members; `root` makes it its own `importedFrom` (dmodule.d:1032). */
    function makeModule(name: string, root: boolean): Module {
        const m = moduleFromParse(new DArray<Dsymbol | null>(), null, ds(name));
        if (root)
            m.importedFrom = m;
        return m;
    }

    test("the code becomes a pointer to its element type; a non-root module's declaration moves to the root", () => {
        const rootm = makeModule("r", true);
        Module.rootModule = rootm;
        const m = makeModule("c", false);
        const ad = new CAsmDeclaration(StringExp.createFromCStr(Loc.initial, ds("nop")));
        gccAsmSemanticCAsmDeclaration(ad, scopeCreateGlobal(m, global.errorSink!));
        expect(ad.code.isStringExp()).not.toBeNull();
        expect(dsToJs(cstr(typeToChars(ad.code.type!)))).toBe("immutable(char)*");
        expect(rootm.members!.length).toBe(1);
        expect(rootm.members!.opIndex(0)).toBe(ad);
    });

    test("in a root module the declaration stays where it is", () => {
        const rootm = makeModule("r", true);
        Module.rootModule = rootm;
        const ad = new CAsmDeclaration(StringExp.createFromCStr(Loc.initial, ds("nop")));
        gccAsmSemanticCAsmDeclaration(ad, scopeCreateGlobal(rootm, global.errorSink!));
        expect(rootm.members!.length).toBe(0);
    });
});
