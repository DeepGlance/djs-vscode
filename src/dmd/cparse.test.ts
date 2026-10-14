// Goal test for dmd/cparse.d. The D module has no `unittest` blocks, so there is nothing to port 1:1
// (10 §1); these tests drive `CParser` the way the driver does and pin its output against ldc2.
//
// ENTRY. `parseC` reproduces dmodule.d:799-806, the only frontend construction of the C parser that
// reaches a file: `new CParser!AST(this, buf, cast(bool) docfile, global.errorSink, target.c, &defines,
// &global.compileEnv)`, `p.nextToken()`, `members = p.parseModule()`, `md = p.md`. The module's
// `defines` buffer is empty because a `.i` file is not run through the preprocessor (dmodule.d:695-711
// fills it only for `.c`/`.h`), so a fresh `OutBuffer` stands for it. `compileEnv.masm` is false
// on the arm64-apple-darwin target (dmodule.d:801 sets it only for Windows).
//
// FRESH PROCESS PER CASE. Each case runs in an empty module registry (`vi.resetModules()` plus dynamic
// imports), as a new ldc2 process would: the anonymous-tag counter behind `__tag<n>`
// (identifier.d:199) and `global.errors` (with its error limit of 20) are process-global.
//
// ORACLE: ldc2 1.43.0 (arm64-apple-darwin), each source written to `<file>` and run from its directory.
//   - AST shape: `ldc2 -o- -H --Hkeep-all-bodies --Hf=<b>.di <file>`. The driver writes the header
//     through `genhdrfile` BEFORE semantic (main.d:668-691), so the `.di` is the parse AST exactly; the
//     test calls the same function on the module `parseC` built. `hgs.importcHdr` follows
//     `m.filetype == FileType.c` (hdrgen.d:101), which `parseC` sets as dmodule.d:800 does.
//   - The same sources under `ldc2 -c -o- -vcg-ast <file>` print the AST AFTER semantic. Each case's
//     `vcgAst` field states how that dump compares with the parse AST; where semantic rewrites the
//     construct the two are not comparable and only the `-H` text is pinned.
//   - Diagnostics: `ldc2 -c -o- <file>`, stderr byte for byte. ldc2's driver turns the source-line
//     context on by default (driver/main.cpp:272, `ErrorPrintMode.printErrorContext`), and a parse
//     error stops the run before semantic (main.d:665), so stderr holds the parser's messages only.
//     `failed` is whether ldc2 exited non-zero; a case with `failed: false` pins that ldc2 accepts the
//     input in silence.

import { describe, expect, test, vi } from "vitest";
import type { Module } from "./dmodule.js";

interface HeaderCase {
    file: string;
    what: string;
    vcgAst: string;   // how `-vcg-ast` (after semantic) compares with the parse AST
    source: string;
    header: string;   // ldc2 -H --Hkeep-all-bodies
}

interface DiagnosticCase {
    file: string;
    what: string;
    source: string;
    failed: boolean;  // ldc2 exit status was non-zero
    stderr: string;   // ldc2 -c -o-
}

interface Parsed {
    header: string | null;  // genhdrfile(m, doFuncBodies = true) over the parsed module; null after an error
    stderr: string;         // everything the error sink wrote
    errors: number;         // global.errors after the parse
    module: Module;         // the parsed module, for shapes the header printer does not show
}

/**
 * Parses `source` as the preprocessed C file `file` in a fresh module registry, through the
 * dmodule.d:799-806 sequence, with diagnostics going to ldc2's error sink (stderr captured).
 * Returns the `-H` text of the parsed module (null when the parse reported an error, as ldc2 then
 * writes no header), the captured stderr, the error count and the module.
 */
async function parseC(file: string, source: string): Promise<Parsed> {
    vi.resetModules();
    const { initSemaHarness } = await import("../sema-harness.js");
    const { CParser } = await import("./cparse.js");
    const { Module } = await import("./dmodule.js");
    const { FileType } = await import("./astenums.js");
    const { Loc } = await import("./location.js");
    const { Identifier } = await import("./identifier.js");
    const { OutBuffer } = await import("./common/outbuffer.js");
    const { ErrorSinkCompiler } = await import("./errors.js");
    const { global, ErrorPrintMode } = await import("./globals.js");
    const { target } = await import("./target.js");
    const { genhdrfile } = await import("./hdrgen.js");
    const { ds, dsToJs } = await import("../dstring.js");

    initSemaHarness();
    global.errorSink = new ErrorSinkCompiler();                            // main.d: the driver's sink
    global.params.v.errorPrintMode = ErrorPrintMode.printErrorContext;    // driver/main.cpp:272

    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
        stderr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        return true;
    });
    try {
        const input = new Uint8Array(source.length + 1);   // NUL-terminated, as the lexer expects
        for (let i = 0; i < source.length; i++)
            input[i] = source.charCodeAt(i) & 0xff;
        const m = new Module(Loc.initial, ds(file), Identifier.idPool(ds(file.replace(/\.i$/, ""))), 0, 0);
        m.filetype = FileType.c;
        global.compileEnv.masm = false;
        const p = new CParser(m, input, false, global.errorSink, target.c, new OutBuffer(), global.compileEnv);
        p.nextToken();
        m.members = p.parseModule();
        m.md = p.md;
        // main.d:665: a parse error ends the run before the header is generated
        if (global.errors !== 0)
            return { header: null, stderr: stderr.join(""), errors: global.errors, module: m };
        const buf = new OutBuffer();
        genhdrfile(m, true, buf);
        return { header: dsToJs(buf.extractSlice()), stderr: stderr.join(""), errors: global.errors, module: m };
    } finally {
        spy.mockRestore();
    }
}

const HEADER_CASES: readonly HeaderCase[] = [
    {
        file: "p01.i",
        what: "typedefs: basic, unsigned long, struct tag, pointer to function; a typedef-named variable",
        vcgAst: "the typedef aliases match; after semantic `v` prints as `int` and `fp` gains `extern (C)`",
        source:
            "typedef int myint;\n" +
            "typedef unsigned long ul;\n" +
            "typedef struct S S_t;\n" +
            "typedef int (*fp)(int);\n" +
            "myint v;\n",
        header:
            "// D import file generated from 'p01.i'\n" +
            "extern (C)\n" +
            "{\n" +
            "\talias myint = int;\n" +
            "\talias ul = ulong;\n" +
            "\talias S_t = S;\n" +
            "\talias fp = int function(int);\n" +
            "\textern __gshared myint v;\n" +
            "}\n",
    },
    {
        file: "p02.i",
        what: "struct/union/enum with and without tags, nested anonymous struct, forward declaration",
        vcgAst: "aggregates match; after semantic the enum is `enum E : int`, typed, without the aliases",
        source:
            "struct S { int a; struct { int b; } inner; };\n" +
            "union U { int i; float f; };\n" +
            "enum E { A, B = 5, C };\n" +
            "enum { X, Y };\n" +
            "struct { int z; } anon_var;\n" +
            "struct Fwd;\n",
        header:
            "// D import file generated from 'p02.i'\n" +
            "extern (C)\n" +
            "{\n" +
            "\tstruct __tag1\n" +
            "\t{\n" +
            "\t\tint b = void;\n" +
            "\t}\n" +
            "\tstruct S\n" +
            "\t{\n" +
            "\t\tint a = void;\n" +
            "\t\t__tag1 inner = void;\n" +
            "\t}\n" +
            "\tunion U\n" +
            "\t{\n" +
            "\t\tint i = void;\n" +
            "\t\tfloat f = void;\n" +
            "\t}\n" +
            "\tenum E\n" +
            "\t{\n" +
            "\t\tA,\n" +
            "\t\tB = 5,\n" +
            "\t\tC,\n" +
            "\t}\n" +
            "\talias A = E.A;\n" +
            "\talias B = E.B;\n" +
            "\talias C = E.C;\n" +
            "\tenum\n" +
            "\t{\n" +
            "\t\tX,\n" +
            "\t\tY,\n" +
            "\t}\n" +
            "\tstruct __tag2\n" +
            "\t{\n" +
            "\t\tint z = void;\n" +
            "\t}\n" +
            "\textern __gshared __tag2 anon_var;\n" +
            "\tstruct Fwd;\n" +
            "}\n",
    },
    {
        file: "p03.i",
        what: "bit-fields, including an unnamed zero-width one",
        vcgAst: "identical",
        source:
            "struct B { unsigned a : 3; int : 0; signed b : 5; };\n",
        header:
            "// D import file generated from 'p03.i'\n" +
            "extern (C) struct B\n" +
            "{\n" +
            "\tuint a : 3;\n" +
            "\tint : 0;\n" +
            "\tint b : 5;\n" +
            "}\n",
    },
    {
        file: "p04.i",
        what: "prototypes and definitions, static and extern storage, variadic `...`",
        vcgAst: "functions gain `extern (C)`; the builtins import adds vector templates",
        source:
            "int f(int x, char *p);\n" +
            "static int g(void) { return 1; }\n" +
            "extern double h(double, ...);\n",
        header:
            "// D import file generated from 'p04.i'\n" +
            "extern (C)\n" +
            "{\n" +
            "\tint f(int x, char* p);\n" +
            "\tstatic int g()\n" +
            "\t{\n" +
            "\t\treturn 1;\n" +
            "\t}\n" +
            "\textern double h(double, ...);\n" +
            "}\n" +
            "import __importc_builtins;\n",
    },
    {
        file: "p05.i",
        what: "K&R: empty parameter list and an identifier list with declarations",
        vcgAst: "same parameter list; after semantic `b` is promoted, `cast(int)b`",
        source:
            "int k();\n" +
            "int kr(a, b) int a; char b; { return a + b; }\n",
        header:
            "// D import file generated from 'p05.i'\n" +
            "extern (C)\n" +
            "{\n" +
            "\tint k();\n" +
            "\tint kr(int a, char b)\n" +
            "\t{\n" +
            "\t\treturn a + b;\n" +
            "\t}\n" +
            "}\n",
    },
    {
        file: "p06.i",
        what: "arrays, pointer to function, array of pointers to functions, 2-D array, const pointer",
        vcgAst: "same declarators; after semantic function types gain `extern (C)` and `cp` an initializer",
        source:
            "int arr[10];\n" +
            "int (*pf)(int, int);\n" +
            "int *(*apf[3])(void);\n" +
            "char m[2][3];\n" +
            "const char *const cp;\n",
        header:
            "// D import file generated from 'p06.i'\n" +
            "extern (C)\n" +
            "{\n" +
            "\textern __gshared int[10] arr;\n" +
            "\textern __gshared int function(int, int) pf;\n" +
            "\textern __gshared int* function()[3] apf;\n" +
            "\textern __gshared char[3][2] m;\n" +
            "\textern __gshared const(char*) cp;\n" +
            "}\n",
    },
    {
        file: "p07.i",
        what: "cast vs parenthesised expression after a typedef name",
        vcgAst: "not comparable: semantic folds `cast(T)x` to `x`, so the distinction is visible only before it",
        source:
            "typedef int T;\n" +
            "int c(int x) {\n" +
            "    int a = (T)x;\n" +
            "    int b = (x) + 1;\n" +
            "    int d = (T)-3;\n" +
            "    return (a) * (T)(b);\n" +
            "}\n",
        header:
            "// D import file generated from 'p07.i'\n" +
            "extern (C)\n" +
            "{\n" +
            "\talias T = int;\n" +
            "\tint c(int x)\n" +
            "\t{\n" +
            "\t\textern (C) int a = cast(T)x;\n" +
            "\t\textern (C) int b = x + 1;\n" +
            "\t\textern (C) int d = cast(T)-3;\n" +
            "\t\treturn a * cast(T)b;\n" +
            "\t}\n" +
            "}\n",
    },
    {
        file: "p08.i",
        what: "compound literals of struct and array type",
        vcgAst: "not comparable: semantic lowers `(P){1, 2}` to `P(1, 2)` and the array literal to `[1, 2, 3]`",
        source:
            "struct P { int x, y; };\n" +
            "void cl(void) {\n" +
            "    struct P p = (struct P){1, 2};\n" +
            "    int *q = (int[]){1, 2, 3};\n" +
            "}\n",
        header:
            "// D import file generated from 'p08.i'\n" +
            "extern (C)\n" +
            "{\n" +
            "\tstruct P\n" +
            "\t{\n" +
            "\t\tint x = void;\n" +
            "\t\tint y = void;\n" +
            "\t}\n" +
            "\tvoid cl()\n" +
            "\t{\n" +
            "\t\textern (C) P p = (P){1, 2};\n" +
            "\t\textern (C) int* q = (int[0]){1, 2, 3};\n" +
            "\t}\n" +
            "}\n",
    },
    {
        file: "p09.i",
        what: "designated initializers for a struct and an array",
        vcgAst: "not comparable: semantic lowers them to `P(1, 2)` and `[0, 0, 3, 0, 5]`",
        source:
            "struct P { int x, y; };\n" +
            "struct P gp = { .y = 2, .x = 1 };\n" +
            "void f(void) {\n" +
            "    struct P p = { .y = 2, .x = 1 };\n" +
            "    int a[5] = { [2] = 3, [4] = 5 };\n" +
            "}\n",
        header:
            "// D import file generated from 'p09.i'\n" +
            "extern (C)\n" +
            "{\n" +
            "\tstruct P\n" +
            "\t{\n" +
            "\t\tint x = void;\n" +
            "\t\tint y = void;\n" +
            "\t}\n" +
            "\textern __gshared P gp;\n" +
            "\tvoid f()\n" +
            "\t{\n" +
            "\t\textern (C) P p = {.y=2, .x=1};\n" +
            "\t\textern (C) int[5] a = {[2]=3, [4]=5};\n" +
            "\t}\n" +
            "}\n",
    },
    {
        file: "p10.i",
        what: "_Static_assert at file and block scope",
        vcgAst: "not comparable: semantic folds the condition and drops the block-scope assert",
        source:
            "_Static_assert(sizeof(int) == 4, \"int\");\n" +
            "void f(void) { _Static_assert(1, \"x\"); }\n",
        header:
            "// D import file generated from 'p10.i'\n" +
            "extern (C)\n" +
            "{\n" +
            "\tstatic assert((int).sizeof == 4, \"int\");\n" +
            "\tvoid f()\n" +
            "\t{\n" +
            "\t\tstatic assert(1, \"x\");\n" +
            "\t}\n" +
            "}\n",
    },
    {
        file: "p11.i",
        what: "__attribute__ (aligned, noreturn, deprecated, always_inline) and __declspec (dllexport, noreturn)",
        vcgAst: "same attributes; after semantic `deprecated` prints three times and functions gain `extern (C)`",
        source:
            "int x __attribute__((aligned(16)));\n" +
            "__declspec(dllexport) int f(void);\n" +
            "void g(void) __attribute__((noreturn));\n" +
            "__declspec(noreturn) void h(void);\n" +
            "int dep __attribute__((deprecated(\"msg\")));\n" +
            "__attribute__((always_inline)) inline int ai(void) { return 0; }\n",
        header:
            "// D import file generated from 'p11.i'\n" +
            "extern (C)\n" +
            "{\n" +
            "\talign (16) extern __gshared int x;\n" +
            "\tint f();\n" +
            "\tvoid g();\n" +
            "\tvoid h();\n" +
            "\tdeprecated(\"msg\") deprecated extern __gshared int dep;\n" +
            "\tint ai()\n" +
            "\t{\n" +
            "\t\treturn 0;\n" +
            "\t}\n" +
            "}\n",
    },
    {
        file: "p12.i",
        what: "_Alignas on a variable and on a struct member",
        vcgAst: "identical apart from the `extern` storage class",
        source:
            "_Alignas(8) int a;\n" +
            "struct A { _Alignas(16) char c; };\n",
        header:
            "// D import file generated from 'p12.i'\n" +
            "extern (C)\n" +
            "{\n" +
            "\talign (8) extern __gshared int a;\n" +
            "\tstruct A\n" +
            "\t{\n" +
            "\t\talign (16) char c = void;\n" +
            "\t}\n" +
            "}\n",
    },
    {
        file: "p13.i",
        what: "_Generic selection",
        vcgAst: "not comparable: semantic resolves the selection to `return 1;`",
        source:
            "int f(int x) { return _Generic(x, int: 1, default: 0); }\n",
        header:
            "// D import file generated from 'p13.i'\n" +
            "extern (C) int f(int x)\n" +
            "{\n" +
            "\treturn _Generic;\n" +
            "}\n",
    },
    {
        file: "p14.i",
        what: "labels and goto",
        vcgAst: "identical apart from the doubled `extern (C)` prefix",
        source:
            "int f(int x) {\n" +
            "L1:\n" +
            "    x++;\n" +
            "    if (x < 10)\n" +
            "        goto L1;\n" +
            "    return x;\n" +
            "}\n",
        header:
            "// D import file generated from 'p14.i'\n" +
            "extern (C) int f(int x)\n" +
            "{\n" +
            "\tL1:\n" +
            "\tx++;\n" +
            "\tif (x < 10)\n" +
            "\t\tgoto L1;\n" +
            "\treturn x;\n" +
            "}\n",
    },
    {
        file: "p15.i",
        what: "switch with a GNU case range",
        vcgAst: "not comparable: semantic expands `case 1: .. case 3:` to three cases",
        source:
            "int f(int x) {\n" +
            "    switch (x) {\n" +
            "    case 1 ... 3: return 1;\n" +
            "    case 4: break;\n" +
            "    default: return 0;\n" +
            "    }\n" +
            "    return 2;\n" +
            "}\n",
        header:
            "// D import file generated from 'p15.i'\n" +
            "extern (C) int f(int x)\n" +
            "{\n" +
            "\tswitch (x)\n" +
            "\t{\n" +
            "\t\tcase 1: .. case 3:\n" +
            "\t\t{\n" +
            "\t\t\treturn 1;\n" +
            "\t\t}\n" +
            "\t\tcase 4:\n" +
            "\t\t{\n" +
            "\t\t\tbreak;\n" +
            "\t\t}\n" +
            "\t\tdefault:\n" +
            "\t\t{\n" +
            "\t\t\treturn 0;\n" +
            "\t\t}\n" +
            "\t}\n" +
            "\treturn 2;\n" +
            "}\n",
    },
    {
        file: "p16.i",
        what: "typedef of anonymous struct/enum, packed struct, __declspec(align) on a tag, anonymous union variable",
        vcgAst: "aggregates match; the enum prints typed after semantic",
        source:
            "typedef struct { int a; } TS;\n" +
            "typedef enum { R, G } Color;\n" +
            "struct __attribute__((packed)) Pk { char c; int i; };\n" +
            "__declspec(align(8)) struct Al { int v; };\n" +
            "union { int u1; float u2; } uvar;\n",
        header:
            "// D import file generated from 'p16.i'\n" +
            "extern (C)\n" +
            "{\n" +
            "\tstruct TS\n" +
            "\t{\n" +
            "\t\tint a = void;\n" +
            "\t}\n" +
            "\tenum Color\n" +
            "\t{\n" +
            "\t\tR,\n" +
            "\t\tG,\n" +
            "\t}\n" +
            "\talias R = Color.R;\n" +
            "\talias G = Color.G;\n" +
            "\tstruct Pk\n" +
            "\t{\n" +
            "\t\talign align char c = void;\n" +
            "\t\talign align int i = void;\n" +
            "\t}\n" +
            "\tstruct Al\n" +
            "\t{\n" +
            "\t\tint v = void;\n" +
            "\t}\n" +
            "\tunion __tag1\n" +
            "\t{\n" +
            "\t\tint u1 = void;\n" +
            "\t\tfloat u2 = void;\n" +
            "\t}\n" +
            "\textern __gshared __tag1 uvar;\n" +
            "}\n",
    },
    {
        file: "p17.i",
        what: "for/while/do, nested blocks, sizeof of a type and of an expression, ?:, comma",
        vcgAst: "not comparable: semantic lowers the loops to `for (;;)` and folds `sizeof`",
        source:
            "void f(int n) {\n" +
            "    int i;\n" +
            "    for (i = 0; i < n; i++) { if (i == 2) continue; }\n" +
            "    while (n) n--;\n" +
            "    do { n++; } while (n < 3);\n" +
            "    { int s = sizeof(int) + sizeof n; }\n" +
            "    n = n > 0 ? n : -n;\n" +
            "    n += 1, n -= 2;\n" +
            "}\n",
        header:
            "// D import file generated from 'p17.i'\n" +
            "extern (C) void f(int n)\n" +
            "{\n" +
            "\textern (C) int i = void;\n" +
            "\tfor (i = 0; i < n; i++)\n" +
            "\t{\n" +
            "\t\t{\n" +
            "\t\t\tif (i == 2)\n" +
            "\t\t\t\tcontinue;\n" +
            "\t\t}\n" +
            "\t}\n" +
            "\twhile (n)\n" +
            "\tn--;\n" +
            "\tdo\n" +
            "\t{\n" +
            "\t\tn++;\n" +
            "\t}\n" +
            "\twhile (n < 3);\n" +
            "\t{\n" +
            "\t\textern (C) int s = (int).sizeof + n.sizeof;\n" +
            "\t}\n" +
            "\tn = n > 0 ? n : -n;\n" +
            "\tn += 1 , n -= 2;\n" +
            "}\n",
    },
    {
        file: "w02.i",
        what: "#pragma pack push and pop around struct definitions",
        vcgAst: "identical",
        source:
            "#pragma pack(push, 2)\n" +
            "struct P1 { char c; int i; };\n" +
            "#pragma pack(pop)\n" +
            "struct P2 { char c; int i; };\n",
        header:
            "// D import file generated from 'w02.i'\n" +
            "extern (C)\n" +
            "{\n" +
            "\tstruct P1\n" +
            "\t{\n" +
            "\t\talign char c = void;\n" +
            "\t\talign int i = void;\n" +
            "\t}\n" +
            "\tstruct P2\n" +
            "\t{\n" +
            "\t\tchar c = void;\n" +
            "\t\tint i = void;\n" +
            "\t}\n" +
            "}\n",
    },
    {
        file: "w04.i",
        what: "_Thread_local, restrict, volatile, long double, _Bool, signed/unsigned char, short, long long",
        vcgAst: "same types; only the header's `extern` differs",
        source:
            "_Thread_local int tl;\n" +
            "int * restrict rp;\n" +
            "volatile int vi;\n" +
            "long double ld;\n" +
            "_Bool b;\n" +
            "unsigned char uc;\n" +
            "signed char sc;\n" +
            "short s;\n" +
            "unsigned long long ull;\n",
        header:
            "// D import file generated from 'w04.i'\n" +
            "extern (C)\n" +
            "{\n" +
            "\textern int tl;\n" +
            "\textern __gshared int* rp;\n" +
            "\textern __gshared int vi;\n" +
            "\textern __gshared real ld;\n" +
            "\textern __gshared bool b;\n" +
            "\textern __gshared ubyte uc;\n" +
            "\textern __gshared byte sc;\n" +
            "\textern __gshared short s;\n" +
            "\textern __gshared ulong ull;\n" +
            "}\n",
    },
    {
        file: "w05.i",
        what: "literals: adjacent strings, character, hex float, suffixed integers and float, octal",
        vcgAst: "identical apart from the doubled `extern (C)` prefix",
        source:
            "void f(void) {\n" +
            "    char *s = \"ab\" \"cd\";\n" +
            "    int c = 'x';\n" +
            "    double hf = 0x1.8p1;\n" +
            "    unsigned u = 10u;\n" +
            "    long l = 10L;\n" +
            "    float ff = 1.5f;\n" +
            "    long long ll = 0x7fffffffffffffffLL;\n" +
            "    int o = 017;\n" +
            "}\n",
        header:
            "// D import file generated from 'w05.i'\n" +
            "extern (C) void f()\n" +
            "{\n" +
            "\textern (C) char* s = \"abcd\";\n" +
            "\textern (C) int c = 120;\n" +
            "\textern (C) double hf = 3.0;\n" +
            "\textern (C) uint u = 10u;\n" +
            "\textern (C) long l = 10L;\n" +
            "\textern (C) float ff = 1.5F;\n" +
            "\textern (C) long ll = 9223372036854775807L;\n" +
            "\textern (C) int o = 15;\n" +
            "}\n",
    },
    {
        file: "w06.i",
        what: "__func__ and a GNU statement expression",
        vcgAst: "after semantic `__func__` is NUL-terminated and read by address, and the lambda gains attributes",
        source:
            "void f(void) { const char *n = __func__; }\n" +
            "int g(int x) { return ({ int y = x; y + 1; }); }\n",
        header:
            "// D import file generated from 'w06.i'\n" +
            "extern (C)\n" +
            "{\n" +
            "\tvoid f()\n" +
            "\t{\n" +
            "\t\timmutable __gshared char[2u] __func__ = \"f\"c;\n" +
            "\t\textern (C) const(char)* n = __func__;\n" +
            "\t}\n" +
            "\tint g(int x)\n" +
            "\t{\n" +
            "\t\treturn delegate () => y + 1();\n" +
            "\t}\n" +
            "}\n",
    },
    {
        file: "w07.i",
        what: "a typedef shadowed in a block and by a parameter name",
        vcgAst: "after semantic the typedef names resolve (`char c`, `int g`)",
        source:
            "typedef int T;\n" +
            "void f(void) { typedef char T; T c = 1; }\n" +
            "T g;\n" +
            "void h(int T) { T = 2; }\n",
        header:
            "// D import file generated from 'w07.i'\n" +
            "extern (C)\n" +
            "{\n" +
            "\talias T = int;\n" +
            "\tvoid f()\n" +
            "\t{\n" +
            "\t\textern (C) alias T = char;\n" +
            "\t\textern (C) T c = 1;\n" +
            "\t}\n" +
            "\textern __gshared T g;\n" +
            "\tvoid h(int T)\n" +
            "\t{\n" +
            "\t\tT = 2;\n" +
            "\t}\n" +
            "}\n",
    },
    {
        file: "w08.i",
        what: "function returning a pointer to array, pointer to function returning a pointer to function, signal()",
        vcgAst: "same declarators; after semantic each function type gains `extern (C)`",
        source:
            "int (*fpa(void))[3];\n" +
            "int (*(*pfr)(int))(char);\n" +
            "void (*signal(int sig, void (*func)(int)))(int);\n",
        header:
            "// D import file generated from 'w08.i'\n" +
            "extern (C)\n" +
            "{\n" +
            "\tint[3]* fpa();\n" +
            "\textern __gshared int function(char) function(int) pfr;\n" +
            "\tvoid function(int) signal(int sig, void function(int) func);\n" +
            "}\n",
    },
    {
        file: "w09.i",
        what: "static inline, noinline, _Noreturn, __declspec(naked)",
        vcgAst: "identical apart from `extern (C)`",
        source:
            "static inline int si(void) { return 1; }\n" +
            "__attribute__((noinline)) int ni(void) { return 2; }\n" +
            "_Noreturn void nr(void);\n" +
            "__declspec(naked) void nk(void);\n",
        header:
            "// D import file generated from 'w09.i'\n" +
            "extern (C)\n" +
            "{\n" +
            "\tstatic int si()\n" +
            "\t{\n" +
            "\t\treturn 1;\n" +
            "\t}\n" +
            "\tint ni()\n" +
            "\t{\n" +
            "\t\treturn 2;\n" +
            "\t}\n" +
            "\tvoid nr();\n" +
            "\tvoid nk();\n" +
            "}\n",
    },
    {
        file: "w11.i",
        what: "member access through `->` and `.`, sizeof of a struct type, _Alignof",
        vcgAst: "not comparable: semantic folds the sizes",
        source:
            "struct S { int a; };\n" +
            "int f(struct S *p, struct S s) { return p->a + s.a + sizeof(struct S) + _Alignof(int); }\n",
        header:
            "// D import file generated from 'w11.i'\n" +
            "extern (C)\n" +
            "{\n" +
            "\tstruct S\n" +
            "\t{\n" +
            "\t\tint a = void;\n" +
            "\t}\n" +
            "\tint f(S* p, S s)\n" +
            "\t{\n" +
            "\t\treturn p.a + s.a + (S).sizeof + (int).alignof;\n" +
            "\t}\n" +
            "}\n",
    },
    {
        file: "w12.i",
        what: "enum with a C23 base type, enumerator constant expressions",
        vcgAst: "not comparable: semantic types and folds the members",
        source:
            "enum E : short { A, B };\n" +
            "enum F { X = 1 << 2, Y = X | 1 };\n",
        header:
            "// D import file generated from 'w12.i'\n" +
            "extern (C)\n" +
            "{\n" +
            "\tenum E : short\n" +
            "\t{\n" +
            "\t\tA,\n" +
            "\t\tB,\n" +
            "\t}\n" +
            "\talias A = E.A;\n" +
            "\talias B = E.B;\n" +
            "\tenum F\n" +
            "\t{\n" +
            "\t\tX = 1 << 2,\n" +
            "\t\tY = X | 1,\n" +
            "\t}\n" +
            "\talias X = F.X;\n" +
            "\talias Y = F.Y;\n" +
            "}\n",
    },
    {
        file: "w14.i",
        what: "variable length array, arrays sized by their initializer",
        vcgAst: "ldc2 -c rejects `int vla[n]` in semantic; `-H --Hf=-` prints this parse AST before it",
        source:
            "void f(int n) {\n" +
            "    int vla[n];\n" +
            "    int arr[] = { 1, 2 };\n" +
            "    char str[] = \"hi\";\n" +
            "}\n",
        header:
            "// D import file generated from 'w14.i'\n" +
            "extern (C) void f(int n)\n" +
            "{\n" +
            "\textern (C) int[n] vla = void;\n" +
            "\textern (C) int[0] arr = {1, 2};\n" +
            "\textern (C) char[0] str = \"hi\";\n" +
            "}\n",
    },
    {
        file: "w15.i",
        what: "flexible array member, self-referential pointer, anonymous struct inside a union",
        vcgAst: "identical apart from `extern`",
        source:
            "struct S { int a; struct S *next; int arr[]; };\n" +
            "union { struct { int x, y; }; int z; } anonu;\n",
        header:
            "// D import file generated from 'w15.i'\n" +
            "extern (C)\n" +
            "{\n" +
            "\tstruct S\n" +
            "\t{\n" +
            "\t\tint a = void;\n" +
            "\t\tS* next = void;\n" +
            "\t\tint[0] arr = void;\n" +
            "\t}\n" +
            "\tunion __tag1\n" +
            "\t{\n" +
            "\t\tstruct\n" +
            "\t\t{\n" +
            "\t\t\tint x = void;\n" +
            "\t\t\tint y = void;\n" +
            "\t\t}\n" +
            "\t\tint z = void;\n" +
            "\t}\n" +
            "\textern __gshared __tag1 anonu;\n" +
            "}\n",
    },
    {
        file: "w16.i",
        what: "null statement after a label, switch without braces, empty if branch",
        vcgAst: "semantic appends `break; default: break;` to the switch",
        source:
            "void f(void) {\n" +
            "    int i = 0;\n" +
            "    L: ;\n" +
            "    switch (i) case 1: i++;\n" +
            "    if (i) ; else i--;\n" +
            "}\n",
        header:
            "// D import file generated from 'w16.i'\n" +
            "extern (C) void f()\n" +
            "{\n" +
            "\textern (C) int i = 0;\n" +
            "\tL:\n" +
            "\t;\n" +
            "\tswitch (i)\n" +
            "\t{\n" +
            "\t\tcase 1:\n" +
            "\t\t{\n" +
            "\t\t\ti++;\n" +
            "\t\t}\n" +
            "\t}\n" +
            "\tif (i)\n" +
            "\t\t;\n" +
            "\telse\n" +
            "\t\ti--;\n" +
            "}\n",
    },
    {
        file: "w17.i",
        what: "variadic prototype and main()",
        vcgAst: "semantic adds `return 0;` to main and the builtins' templates",
        source:
            "int printf(const char *, ...);\n" +
            "int main(int argc, char **argv) { printf(\"%d\\n\", argc); return 0; }\n",
        header:
            "// D import file generated from 'w17.i'\n" +
            "extern (C)\n" +
            "{\n" +
            "\tint printf(const(char)*, ...);\n" +
            "\tint main(int argc, char** argv)\n" +
            "\t{\n" +
            "\t\tprintf(\"%d\\n\", argc);\n" +
            "\t\treturn 0;\n" +
            "\t}\n" +
            "}\n" +
            "import __importc_builtins;\n",
    },
    {
        file: "w20.i",
        what: "__attribute__((aligned)) on a struct, a typedef and an array",
        vcgAst: "identical apart from `extern` and the folded initializer",
        source:
            "struct A { int x; } __attribute__((aligned(8)));\n" +
            "typedef int I __attribute__((aligned(4)));\n" +
            "int arr[2] __attribute__((aligned(16))) = { 1 };\n",
        header:
            "// D import file generated from 'w20.i'\n" +
            "extern (C)\n" +
            "{\n" +
            "\talign (8) struct A\n" +
            "\t{\n" +
            "\t\tint x = void;\n" +
            "\t}\n" +
            "\talign (4) alias I = int;\n" +
            "\talign (16) extern __gshared int[2] arr;\n" +
            "}\n",
    },
    {
        file: "w01.i",
        what: "const applied to struct, union and enum tags",
        vcgAst: "not comparable: semantic drops the const; in D only the header printer reads TypeTag's own mod, " +
            "while Type-level reads (toConst's isConst, cparse.d:4949) see Type.mod == 0",
        source:
            "const struct S { int a; } cs;\n" +
            "typedef const struct S CS;\n" +
            "const union U { int i; } cu;\n" +
            "const enum E { A } ce;\n" +
            "void f(const struct S *p);\n" +
            "const struct S * const cp;\n",
        header:
            "// D import file generated from 'w01.i'\n" +
            "extern (C)\n" +
            "{\n" +
            "\tstruct S\n" +
            "\t{\n" +
            "\t\tint a = void;\n" +
            "\t}\n" +
            "\textern __gshared const(S) cs;\n" +
            "\talias CS = const(S);\n" +
            "\tunion U\n" +
            "\t{\n" +
            "\t\tint i = void;\n" +
            "\t}\n" +
            "\textern __gshared const(U) cu;\n" +
            "\tenum E\n" +
            "\t{\n" +
            "\t\tA,\n" +
            "\t}\n" +
            "\talias A = E.A;\n" +
            "\textern __gshared const(E) ce;\n" +
            "\tvoid f(const(S)* p);\n" +
            "\textern __gshared const(S)* cp;\n" +
            "}\n",
    },
];

const DIAGNOSTIC_CASES: readonly DiagnosticCase[] = [
    {
        file: "e01.i",
        what: "missing semicolon",
        source:
            "int x\n" +
            "int y;\n",
        failed: true,
        stderr:
            "e01.i(2): Error: `=`, `;` or `,` expected to end declaration instead of `int`\n" +
            "int y;\n" +
            "^\n",
    },
    {
        file: "e02.i",
        what: "unbalanced braces: function body runs into end of file",
        source:
            "int f(void) {\n" +
            "    return 1;\n",
        failed: true,
        stderr:
            "e02.i(3): Error: found `End of File` when expecting `}` following compound statement\n",
    },
    {
        file: "e03.i",
        what: "stray closing brace at file scope",
        source:
            "int x;\n" +
            "}\n",
        failed: true,
        stderr:
            "e03.i(2): Error: no type for declarator before `}`\n" +
            "}\n" +
            "^\n",
    },
    {
        file: "e04.i",
        what: "bad declarator: abstract declarator in a declaration",
        source:
            "int (*)x;\n",
        failed: true,
        stderr:
            "e04.i(1): Error: no type-specifier for parameter\n" +
            "int (*)x;\n" +
            "     ^\n" +
            "e04.i(1): Error: expected identifier for declarator\n" +
            "int (*)x;\n" +
            "       ^\n" +
            "e04.i(1): Error: expected identifier for declaration\n" +
            "int (*)x;\n" +
            "       ^\n" +
            "e04.i(1): Error: `=`, `;` or `,` expected to end declaration instead of `x`\n" +
            "int (*)x;\n" +
            "       ^\n",
    },
    {
        file: "e05.i",
        what: "unknown __declspec attribute: accepted silently",
        source:
            "__declspec(foobar) int x;\n",
        failed: false,
        stderr:
            "",
    },
    {
        file: "e06.i",
        what: "misplaced storage class: typedef static",
        source:
            "typedef static int T;\n",
        failed: true,
        stderr:
            "e06.i(1): Error: multiple storage classes in declaration specifiers\n" +
            "typedef static int T;\n" +
            "        ^\n",
    },
    {
        file: "e07.i",
        what: "struct member without semicolon",
        source:
            "struct S { int a } ;\n",
        failed: true,
        stderr:
            "e07.i(1): Error: `;` or `,` expected\n" +
            "struct S { int a } ;\n" +
            "                 ^\n" +
            "e07.i(2): Error: found `End of File` when expecting `}`\n" +
            "e07.i(2): Error: identifier or `(` expected\n" +
            "e07.i(2): Error: expected identifier for declarator\n" +
            "e07.i(2): Error: expected identifier for declaration\n" +
            "e07.i(2): Error: `=`, `;` or `,` expected to end declaration instead of `End of File`\n",
    },
    {
        file: "e08.i",
        what: "_Static_assert message is not a string literal",
        source:
            "_Static_assert(1, 2);\n",
        failed: true,
        stderr:
            "e08.i(1): Error: string literal expected\n" +
            "_Static_assert(1, 2);\n" +
            "                  ^\n",
    },
    {
        file: "e09.i",
        what: "unterminated array dimension",
        source:
            "int a[;\n",
        failed: true,
        stderr:
            "e09.i(1): Error: expression expected, not `;`\n" +
            "int a[;\n" +
            "      ^\n" +
            "e09.i(2): Error: found `End of File` when expecting `]`\n" +
            "e09.i(2): Error: `=`, `;` or `,` expected to end declaration instead of `End of File`\n",
    },
    {
        file: "e10.i",
        what: "goto without a label",
        source:
            "void f(void) { goto ; }\n",
        failed: true,
        stderr:
            "e10.i(1): Error: identifier expected following `goto`\n" +
            "void f(void) { goto ; }\n" +
            "                    ^\n",
    },
    {
        file: "e11.i",
        what: "illegal type combination: long long long",
        source:
            "long long long x;\n",
        failed: true,
        stderr:
            "e11.i(1): Error: illegal type combination\n" +
            "long long long x;\n" +
            "               ^\n",
    },
    {
        file: "e12.i",
        what: "illegal type combination: signed unsigned",
        source:
            "signed unsigned x;\n",
        failed: true,
        stderr:
            "e12.i(1): Error: illegal type combination\n" +
            "signed unsigned x;\n" +
            "                ^\n",
    },
    {
        file: "e14.i",
        what: "_Generic without an association list",
        source:
            "int f(void) { return _Generic(1); }\n",
        failed: true,
        stderr:
            "e14.i(1): Error: found `)` when expecting `,`\n" +
            "int f(void) { return _Generic(1); }\n" +
            "                               ^\n" +
            "e14.i(1): Error: type-specifier is missing\n" +
            "int f(void) { return _Generic(1); }\n" +
            "                                ^\n" +
            "e14.i(1): Error: found `;` when expecting `:`\n" +
            "int f(void) { return _Generic(1); }\n" +
            "                                ^\n" +
            "e14.i(1): Error: expression expected, not `}`\n" +
            "int f(void) { return _Generic(1); }\n" +
            "                                  ^\n" +
            "e14.i(2): Error: found `End of File` when expecting `)`\n" +
            "e14.i(2): Error: found `End of File` when expecting `;` following `return` statement\n" +
            "e14.i(2): Error: found `End of File` when expecting `}` following compound statement\n",
    },
    {
        file: "e15.i",
        what: "unknown __attribute__: accepted silently",
        source:
            "int x __attribute__((foobar));\n",
        failed: false,
        stderr:
            "",
    },
    {
        file: "e16.i",
        what: "compound literal missing its closing brace",
        source:
            "void f(void) { int y = (int){1; }\n",
        failed: true,
        stderr:
            "e16.i(1): Error: found `;` when expecting `}`\n" +
            "void f(void) { int y = (int){1; }\n" +
            "                              ^\n" +
            "e16.i(1): Error: `=`, `;` or `,` expected to end declaration instead of `}`\n" +
            "void f(void) { int y = (int){1; }\n" +
            "                                ^\n" +
            "e16.i(2): Error: found `End of File` when expecting `}` following compound statement\n",
    },
    {
        file: "e17.i",
        what: "case range without an upper bound",
        source:
            "int f(void) { switch (1) { case 1 ... : ; } }\n",
        failed: true,
        stderr:
            "e17.i(1): Error: expression expected, not `:`\n" +
            "int f(void) { switch (1) { case 1 ... : ; } }\n" +
            "                                      ^\n" +
            "e17.i(1): Error: found `;` when expecting `:`\n" +
            "int f(void) { switch (1) { case 1 ... : ; } }\n" +
            "                                        ^\n",
    },
    {
        file: "e18.i",
        what: "storage class on a function parameter",
        source:
            "void f(static int x);\n",
        failed: true,
        stderr:
            "e18.i(1): Error: only `register` storage class allowed for function parameters\n" +
            "void f(static int x);\n" +
            "       ^\n",
    },
    {
        file: "e19.i",
        what: "anonymous enum with no members",
        source:
            "enum E { A, B, };\n" +
            "enum { };\n",
        failed: true,
        stderr:
            "e19.i(2): Error: no members for anonymous enum\n" +
            "enum { };\n" +
            "       ^\n",
    },
    {
        file: "e20.i",
        what: "K&R identifier list does not match the declarations",
        source:
            "int f(a, b) int a; { return a; }\n",
        failed: true,
        stderr:
            "e20.i(1): Error: 2 identifiers does not match 1 declarations\n" +
            "int f(a, b) int a; { return a; }\n" +
            "                   ^\n" +
            "e20.i(1): Error: no declaration for identifier `b`\n" +
            "int f(a, b) int a; { return a; }\n" +
            "                   ^\n",
    },
    {
        file: "e21.i",
        what: "misplaced storage class: static on a struct member",
        source:
            "struct S { static int a; };\n",
        failed: true,
        stderr:
            "e21.i(1): Error: storage class not allowed in specifier-qualified-list\n" +
            "struct S { static int a; };\n" +
            "                      ^\n",
    },
    {
        file: "e22.i",
        what: "nested function definition",
        source:
            "int f(void) { extern int g(void) { return 1; } return 0; }\n",
        failed: true,
        stderr:
            "e22.i(1): Error: `=`, `;` or `,` expected to end declaration instead of `{`\n" +
            "int f(void) { extern int g(void) { return 1; } return 0; }\n" +
            "                                 ^\n" +
            "e22.i(1): Error: no type for declarator before `return`\n" +
            "int f(void) { extern int g(void) { return 1; } return 0; }\n" +
            "                                               ^\n" +
            "e22.i(1): Error: no type for declarator before `}`\n" +
            "int f(void) { extern int g(void) { return 1; } return 0; }\n" +
            "                                                         ^\n",
    },
    {
        file: "e23.i",
        what: "break without semicolon",
        source:
            "void f(void) { break }\n",
        failed: true,
        stderr:
            "e23.i(1): Error: found `}` when expecting `;` following `break` statement\n" +
            "void f(void) { break }\n" +
            "                     ^\n" +
            "e23.i(2): Error: found `End of File` when expecting `}` following compound statement\n",
    },
    {
        file: "e24.i",
        what: "initializer with no expression",
        source:
            "int x = ;\n",
        failed: true,
        stderr:
            "e24.i(1): Error: expression expected, not `;`\n" +
            "int x = ;\n" +
            "        ^\n" +
            "e24.i(2): Error: `=`, `;` or `,` expected to end declaration instead of `End of File`\n",
    },
    {
        file: "e25.i",
        what: "_Alignas with two arguments",
        source:
            "_Alignas(int, 4) int x;\n",
        failed: true,
        stderr:
            "e25.i(1): Error: found `,` when expecting `)`\n" +
            "_Alignas(int, 4) int x;\n" +
            "            ^\n" +
            "e25.i(1): Error: no type for declarator before `4`\n" +
            "_Alignas(int, 4) int x;\n" +
            "              ^\n",
    },
    {
        file: "w03.i",
        what: "GNU asm statement inside a function body",
        source:
            "int x asm(\"_y\");\n" +
            "void g(void) asm(\"_gg\");\n" +
            "void h(void) { __asm__ volatile (\"nop\"); }\n",
        failed: true,
        stderr:
            "w03.i(3): Error: no type-specifier for parameter\n" +
            "void h(void) { __asm__ volatile (\"nop\"); }\n" +
            "                                 ^\n" +
            "w03.i(3): Error: found `\"nop\"` when expecting `,`\n" +
            "void h(void) { __asm__ volatile (\"nop\"); }\n" +
            "                                 ^\n" +
            "w03.i(3): Error: expected identifier for declarator\n" +
            "void h(void) { __asm__ volatile (\"nop\"); }\n" +
            "                                       ^\n",
    },
    {
        file: "w10.i",
        what: "GNU `?:` with the middle operand omitted",
        source:
            "int f(int x) { return x ? : 1; }\n" +
            "int g(int *p) { return *p++ + -*p + ~x + !p[0]; }\n",
        failed: true,
        stderr:
            "w10.i(1): Error: expression expected, not `:`\n" +
            "int f(int x) { return x ? : 1; }\n" +
            "                          ^\n" +
            "w10.i(1): Error: found `1` when expecting `:`\n" +
            "int f(int x) { return x ? : 1; }\n" +
            "                            ^\n" +
            "w10.i(1): Error: expression expected, not `;`\n" +
            "int f(int x) { return x ? : 1; }\n" +
            "                             ^\n" +
            "w10.i(1): Error: found `}` when expecting `;` following `return` statement\n" +
            "int f(int x) { return x ? : 1; }\n" +
            "                               ^\n" +
            "w10.i(2): Error: `=`, `;` or `,` expected to end declaration instead of `{`\n" +
            "int g(int *p) { return *p++ + -*p + ~x + !p[0]; }\n" +
            "              ^\n",
    },
    {
        file: "w13.i",
        what: "__typeof__ spelling",
        source:
            "typeof(int) a;\n" +
            "__typeof__(a) b;\n" +
            "typeof(1 + 2) c;\n",
        failed: true,
        stderr:
            "w13.i(2): Error: missing comma or semicolon after declaration of `a`, found `b` instead\n" +
            "__typeof__(a) b;\n" +
            "              ^\n",
    },
    {
        file: "w18.i",
        what: "__int128",
        source:
            "__int128 big;\n" +
            "unsigned __int128 ubig;\n" +
            "_Complex double cd;\n" +
            "float _Complex cf;\n",
        failed: true,
        stderr:
            "w18.i(1): Error: __int128 not supported\n" +
            "__int128 big;\n" +
            "         ^\n" +
            "w18.i(2): Error: unsigned __int128 not supported\n" +
            "unsigned __int128 ubig;\n" +
            "                  ^\n",
    },
    {
        file: "w19.i",
        what: "static and VLA array parameters",
        source:
            "void f(int a[static 3], int b[const], int c[*]);\n",
        failed: true,
        stderr:
            "w19.i(1): Error: static array parameters are not supported\n" +
            "void f(int a[static 3], int b[const], int c[*]);\n" +
            "                      ^\n" +
            "w19.i(1): Error: variable length arrays are not supported\n" +
            "void f(int a[static 3], int b[const], int c[*]);\n" +
            "                                              ^\n",
    },
];

describe("cparse.d: the parse AST, printed by genhdrfile, is ldc2's -H output", () => {
    for (const c of HEADER_CASES) {
        test(`${c.file}: ${c.what}`, async () => {
            const r = await parseC(c.file, c.source);
            expect(r.stderr).toBe("");
            expect(r.errors).toBe(0);
            expect(r.header).toBe(c.header);
        });
    }
});

describe("cparse.d: parse errors are ldc2's diagnostics, byte for byte", () => {
    for (const c of DIAGNOSTIC_CASES) {
        test(`${c.file}: ${c.what}`, async () => {
            const r = await parseC(c.file, c.source);
            expect(r.stderr).toBe(c.stderr);
            expect(r.errors > 0).toBe(c.failed);
            expect(r.header === null).toBe(c.failed);
        });
    }
});

// hdrgen prints a generic selection as the bare keyword (ldc2 -H prints `return _Generic;` for p13.i), so
// the association list cparseGenericSelection builds (cparse.d:1582) is checked on the node itself.
describe("cparse.d: AST shape the header printer does not show", () => {
    test("_Generic: controlling expression, one type per association, null for `default`", async () => {
        const r = await parseC("p13.i", "int f(int x) { return _Generic(x, int: 1, char *: 2, default: 0); }\n");
        expect(r.errors).toBe(0);
        const fd = r.module.members!.opIndex(0)!.isAttribDeclaration()!.decl!.opIndex(0)!.isFuncDeclaration()!;
        // fbody wraps the parsed compound statement in a second one (cparse.d:2244/:2265)
        const outer = fd.fbody!.isCompoundStatement()!.statements!;
        expect(outer.length).toBe(1);
        const ret = outer.opIndex(0)!.isCompoundStatement()!.statements!.opIndex(0)!.isReturnStatement()!;
        const g = ret.exp!.isGenericExp()!;
        const { dsToJs } = await import("../dstring.js");
        const text = (o: { toChars(): Uint8Array } | null): string | null =>
            o === null ? null : dsToJs(o.toChars()).replace(/\0$/, "");
        expect(text(g.cntlExp)).toBe("x");
        expect(g.types!.opSlice().map(text)).toEqual(["int", "char*", null]);
        expect(g.exps!.opSlice().map(text)).toEqual(["1", "2", "0"]);
    });
});
