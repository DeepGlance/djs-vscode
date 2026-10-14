// Co-located tests for src/dmd/ob.ts.
//
// dmd/ob.d carries no in-source `unittest{}` block, so this file pins the checker end to end: each
// test runs lex + parse + passes 0-3 over a `@live` program with `-preview=dip1021` set, which reaches
// `oblive` through semantic3.d:1470-1474, and compares the diagnostics, each prefixed with its line,
// against ldc2 1.43.0 (`ldc2 -c -o- -preview=dip1021 x.d`, the source and caret lines stripped). The
// program names (q1, r1, s1, ...) are the probe files of the port's report.
//
// The suites, split by the callee of every call the program makes:
//   - Programs whose calls, if any, go to a `@system` non-`@live` callee and carry no argument.
//     They reach the `error()` calls at ob.d:2034 (assigning to Owner), :2055 (reading from Undefined),
//     :2060 (borrowing from Readonly), :2098 (undefined state), :2542 (both X and Y), :2585 (returned but
//     Undefined) and :2614 (not disposed of), and the loop, try/finally, goto, switch, `?:` and `&&`
//     shapes of toObNodes/genKill.
//   - Programs calling a `@safe`, default-trust or `@live` callee, with or without arguments. Under
//     dip1021 each such call runs `checkMutableArguments` (dmd/escape.d:80) from functionParameters
//     (dmd/expressionsem.d:4900-4902) before oblive sees it. These pins are the only reach of
//     :2244/:2276 (not Owner, cannot consume), :2308 (passed as Owner more than once, including the slot
//     reads of `mutableStack[vi]` past the stack's end) and genKill's member-call arm (ob.d:1453-1478).
//   - `checkMutableArguments`' own diagnostics (escape.d:194-201): both messages, `to` and `of`, the
//     `this`, outer-variable, variadic, `inout`, function-pointer, dip1000 and global-gag legs, and the
//     error's location on the first argument of the pair.

import "./parse.js"; // module-graph ROOT for a core-SCC test file (10 §1.5)

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { oblive } from "./ob.js";
import { Parser } from "./parse.js";
import { FeatureState, global } from "./globals.js";
import { ErrorSinkCompiler, setDiagnosticHandler } from "./errors.js";
import { moduleFromParse } from "./dmodule.js";
import { runSemantic } from "./dsymbolsem.js";
import { dmdformat } from "./root/dmdformat.js";
import { initSemaHarness } from "../sema-harness.js";
import { dsToJs } from "../dstring.js";

import type { Dsymbols } from "./arraytypes.js";

let diags: string[] = [];

beforeEach(() => {
    initSemaHarness();
    global.errorSink = new ErrorSinkCompiler();
    global.params.useDIP1021 = true;
    // `-preview=dip1021` implies dip1000 in the driver (LDC driver/main.cpp:445, dmd mars.d:1407), which
    // this harness bypasses; set it here so `checkMutableArguments`' dip1000 leg (escape.d:185) matches
    // the ldc2 run. dip25 is already on by default (globals.d).
    global.params.useDIP1000 = FeatureState.enabled;
    diags = [];
    setDiagnosticHandler((loc, _color, header, messageFormat, args) => {
        diags.push(`(${loc.linnum}) ` + dsToJs(header) + dsToJs(dmdformat(messageFormat, [...args])));
        return true;
    });
});

afterEach(() => {
    setDiagnosticHandler(null);
    global.params.useDIP1021 = false;
    global.params.useDIP1000 = FeatureState.default_;
});

/** NUL-terminated byte buffer (the lexer scans to the NUL sentinel). */
function srcBuf(text: string): Uint8Array {
    const b = new Uint8Array(text.length + 1);
    for (let i = 0; i < text.length; i++) b[i] = text.charCodeAt(i) & 0xff;
    b[text.length] = 0;
    return b;
}

/** lex + parse + runSemantic over `text`; returns the diagnostics, each prefixed with its line. */
function sema(text: string): string[] {
    const p = new Parser(null, null, srcBuf(text), false, global.errorSink!, null, false);
    p.nextToken();
    const members: Dsymbols = p.parseModule();
    runSemantic(moduleFromParse(members, p.md));
    return diags;
}

describe("ob.d:56 — oblive, module load", () => {
    test("the module loads and exports the entry point", () => {
        expect(typeof oblive).toBe("function");
    });
});

describe("ob.d:56 — oblive reached from semantic3.d:1473", () => {
    test("a parameter never consumed is not disposed of before return (ldc2: q2.d)", () => {
        expect(sema("module q2;\nvoid consume(int* p);\n@live void f(int* p) { }\n")).toEqual([
            "(3) Error: variable `q2.f.p` is not disposed of before return",
        ]);
    });

    test("without -preview=dip1021 the checker does not run", () => {
        global.params.useDIP1021 = false;
        expect(sema("module q2n;\nvoid consume(int* p);\n@live void f(int* p) { }\n")).toEqual([]);
    });

    test("a function without @live is not checked", () => {
        expect(sema("module q2l;\nvoid f(int* p) { }\n")).toEqual([]);
    });

    test("returning the parameter disposes of it (ldc2: s1.d compiles clean)", () => {
        expect(sema("module s1;\n@live int* f(int* p) { return p; }\n")).toEqual([]);
    });

    test("assigning over a live Owner parameter (ldc2: s2.d)", () => {
        expect(sema("module s2;\n@live int* f(int* p, int* q) { p = q; return p; }\n")).toEqual([
            "(2) Error: variable `s2.f.p` assigning to Owner without disposing of owned value",
        ]);
    });

    test("initializing a second local from a moved pointer (ldc2: s3.d)", () => {
        expect(sema("module s3;\n@live int* f(int* p) { int* q = p; int* r = p; return q; }\n")).toEqual([
            "(2) Error: variable `s3.f.r` is reading from `p` which is Undefined",
            "(2) Error: variable `s3.f.r` is not disposed of before return",
        ]);
    });

    test("dereferencing a moved pointer (ldc2: s4.d)", () => {
        expect(sema("module s4;\n@live int* f(int* p) { int* q = p; *p = 1; return q; }\n")).toEqual([
            "(2) Error: variable `s4.f.p` has undefined state and cannot be read",
        ]);
    });

    test("returning a moved pointer, the new owner undisposed (ldc2: s5.d)", () => {
        expect(sema("module s5;\n@live int* f(int* p) { int* q = p; return p; }\n")).toEqual([
            "(2) Error: variable `s5.f.p` has undefined state and cannot be read",
            "(2) Error: variable `s5.f.p` is returned but is Undefined",
            "(2) Error: variable `s5.f.q` is not disposed of before return",
        ]);
    });

    test("a move on one path only, the other path returns null (ldc2: s6.d)", () => {
        expect(sema("module s6;\n@live int* f(int* p, bool b) { if (b) { int* q = p; return q; } return null; }\n"))
            .toEqual([
                "(2) Error: variable `s6.f.p` is not disposed of before return",
            ]);
    });

    test("an owner copied into another local (ldc2: s13.d)", () => {
        expect(sema("module s13;\n@live void f(int* p) { int* q = p; int* r = q; }\n")).toEqual([
            "(2) Error: variable `s13.f.r` is not disposed of before return",
        ]);
    });

    test("a struct holding a pointer is tracked like the pointer (ldc2: s14.d)", () => {
        expect(sema("module s14;\nstruct S { int* p; }\n@live S f(S s) { S t = s; return s; }\n")).toEqual([
            "(3) Error: variable `s14.f.s` has undefined state and cannot be read",
            "(3) Error: variable `s14.f.s` is returned but is Undefined",
            "(3) Error: variable `s14.f.t` is not disposed of before return",
        ]);
    });

    test("a const pointer parameter is not tracked (ldc2: s16.d compiles clean)", () => {
        expect(sema("module s16;\n@live void f(const(int)* p) { }\n")).toEqual([]);
    });

    test("a const read through the owner keeps it owned (ldc2: s17.d)", () => {
        expect(sema("module s17;\n@live int f(int* p) { int x = *p; return x; }\n")).toEqual([
            "(2) Error: variable `s17.f.p` is not disposed of before return",
        ]);
    });

    test("a mutable borrow cast from a Readonly one (ldc2: r2x.d)", () => {
        expect(sema("module r2x;\n@live void f(int* p) {\n  scope const(int)* c = p;\n"
            + "  scope int* b = cast(int*)c;\n  int x = *b;\n}\n")).toEqual([
            "(4) Error: variable `r2x.f.b` is borrowing from `c` which is Readonly",
            "(2) Error: variable `r2x.f.p` is not disposed of before return",
        ]);
    });

    test("an Owner from a @system call returned (ldc2: z2.d compiles clean)", () => {
        expect(sema("module z2;\nint* make() @system;\n@live int* f() @system { int* p = make(); return p; }\n"))
            .toEqual([]);
    });

    test("an Owner from a @system call overwritten (ldc2: z3.d)", () => {
        expect(sema("module z3;\nint* make() @system;\n"
            + "@live void f() @system { int* p = make(); int* q = make(); p = q; }\n")).toEqual([
            "(3) Error: variable `z3.f.p` assigning to Owner without disposing of owned value",
            "(3) Error: variable `z3.f.p` is not disposed of before return",
        ]);
    });

    test("a postblit initializer is a CommaExp read as BinExp (ldc2: pb1.d compiles clean)", () => {
        expect(sema("module pb1;\nstruct S { int* p; this(this) @system { } }\n"
            + "@live S f(S s) @system { S t = s; return t; }\n")).toEqual([]);
    });

    test("a postblit initializer: the copy temporary is tracked (ldc2: pb2.d)", () => {
        // ldc2 names the temporary `__copytmp3`; the counter behind it lives outside ob.d (the harness
        // compiles fewer declarations before this one), so the number is normalised.
        const got = sema("module pb2;\nstruct S { int* p; this(this) @system { } }\n"
            + "@live S f(S s) @system { S t = s; return s; }\n");
        expect(got.map((d) => d.replace(/__copytmp\d+/, "__copytmpN"))).toEqual([
            "(3) Error: variable `pb2.f.__copytmpN` has undefined state and cannot be read",
            "(3) Error: variable `pb2.f.t` is not disposed of before return",
        ]);
    });
});

describe("ob.d:348 — toObNodes and genKill, control flow", () => {
    test("for loop: the back edge meets the moved state (ldc2: s7.d)", () => {
        expect(sema("module s7;\n"
            + "@live int* f(int* p, int n) { int* q; for (int i = 0; i < n; i++) q = p; return q; }\n"))
            .toEqual([
                "(2) Error: variable `s7.f.p` is both Owner and Undefined",
                "(2) Error: variable `s7.f.p` has undefined state and cannot be read",
                "(2) Error: variable `s7.f.q` assigning to Owner without disposing of owned value",
                "(2) Error: variable `s7.f.q` is reading from `p` which is Undefined",
            ]);
    });

    test("a return in the first block of a try body stays outside the finally (ldc2: s8.d compiles clean)", () => {
        expect(sema("module s8;\n@live int* f(int* p) { try { return p; } finally { } }\n")).toEqual([]);
    });

    test("try/finally: a nested return goes through the finally, reported twice (ldc2: b3.d)", () => {
        expect(sema("module b3;\n@live void f(int* p, int n) {\n  try { if (n) return; } finally { n++; }\n}\n"))
            .toEqual([
                "(2) Error: variable `b3.f.p` is not disposed of before return",
                "(2) Error: variable `b3.f.p` is not disposed of before return",
            ]);
    });

    test("goto to a label: both paths return the owner (ldc2: s9.d compiles clean)", () => {
        expect(sema("module s9;\n@live int* f(int* p, bool b) { if (b) goto L; return p; L: return p; }\n"))
            .toEqual([]);
    });

    test("conditional expression: both arms move the same owner (ldc2: s10.d)", () => {
        expect(sema("module s10;\n@live int* f(int* p, bool b) { return b ? p : p; }\n")).toEqual([
            "(2) Error: variable `s10.f.p` is returned but is Undefined",
        ]);
    });

    test("switch with case and default arms, each returning (ldc2: s11.d compiles clean)", () => {
        expect(sema("module s11;\n"
            + "@live int* f(int* p, int n) { switch (n) { case 1: return p; default: return p; } }\n"))
            .toEqual([]);
    });

    test("a move under an `&&` condition (ldc2: s12.d)", () => {
        expect(sema("module s12;\n@live int* f(int* p, bool b, bool c) { int* q; if (b && c) q = p; return q; }\n"))
            .toEqual([
                "(2) Error: variable `s12.f.q` assigning to Owner without disposing of owned value",
                "(2) Error: variable `s12.f.p` is both Owner and Undefined",
            ]);
    });
});

describe("oblive over calls to checked callees", () => {
    test("consuming the parameter once is clean", () => {
        expect(sema("module q0;\nvoid consume(int* p);\n@live void f(int* p) { consume(p); }\n")).toEqual([]);
    });

    test("use after move: a second consume (ldc2: q1.d)", () => {
        expect(sema("module q1;\nvoid consume(int* p);\n@live void f(int* p) { consume(p); consume(p); }\n"))
            .toEqual([
                "(3) Error: variable `q1.f.p` has undefined state and cannot be read",
                "(3) Error: variable `q1.f.p` is not Owner, cannot consume its value",
            ]);
    });

    test("one path consumes, the other does not (ldc2: q3.d)", () => {
        expect(sema("module q3;\nvoid consume(int* p);\n@live void f(int* p, bool b) { if (b) consume(p); }\n"))
            .toEqual([
                "(3) Error: variable `q3.f.p` is both Owner and Undefined",
            ]);
    });

    test("assigning over a live Owner (ldc2: q4.d)", () => {
        expect(sema("module q4;\nvoid consume(int* p);\n@live void f(int* p, int* q) { p = q; consume(p); }\n"))
            .toEqual([
                "(3) Error: variable `q4.f.p` assigning to Owner without disposing of owned value",
            ]);
    });

    test("the same Owner passed twice by value (ldc2: q5.d)", () => {
        expect(sema("module q5;\nvoid two(int* a, int* b);\n@live void f(int* p) { two(p, p); }\n")).toEqual([
            "(3) Error: variable `q5.f.p` has undefined state and cannot be read",
            "(3) Error: variable `q5.f.p` is not Owner, cannot consume its value",
        ]);
    });

    test("the same Owner passed twice to scope parameters (ldc2: q9.d)", () => {
        expect(sema("module q9;\nvoid consume(int* p);\nvoid two(scope int* a, scope int* b);\n"
            + "@live void f(int* p) { two(p, p); consume(p); }\n")).toEqual([
            "(4) Error: variable `q9.f.p` is passed as Owner more than once",
        ]);
    });

    test("returning a moved pointer (ldc2: q6.d)", () => {
        expect(sema("module q6;\nvoid consume(int* p);\n@live int* f(int* p) { consume(p); return p; }\n"))
            .toEqual([
                "(3) Error: variable `q6.f.p` has undefined state and cannot be read",
                "(3) Error: variable `q6.f.p` is returned but is Undefined",
            ]);
    });

    test("a move into a local undefines the source (ldc2: q7.d)", () => {
        expect(sema("module q7;\nvoid consume(int* p);\n"
            + "@live void f(int* p) { int* q = p; consume(p); consume(q); }\n")).toEqual([
            "(3) Error: variable `q7.f.p` has undefined state and cannot be read",
            "(3) Error: variable `q7.f.p` is not Owner, cannot consume its value",
            "(3) Error: variable `q7.f.q` has undefined state and cannot be read",
            "(3) Error: variable `q7.f.q` is not Owner, cannot consume its value",
        ]);
    });

    test("initializing from a moved pointer (ldc2: r1.d)", () => {
        expect(sema("module r1;\nvoid consume(int* p);\n"
            + "@live void f(int* p) { consume(p); int* q = p; consume(q); }\n"))
            .toEqual([
                "(3) Error: variable `r1.f.q` is reading from `p` which is Undefined",
            ]);
    });

    test("assigning into a default-initialized Owner local (ldc2: r3.d)", () => {
        expect(sema("module r3;\nvoid consume(int* p);\n@live void f(int* p) { int* q; q = p; consume(q); }\n"))
            .toEqual([
                "(3) Error: variable `r3.f.q` assigning to Owner without disposing of owned value",
            ]);
    });

    test("a struct holding a pointer is tracked like the pointer (ldc2: r9.d)", () => {
        expect(sema("module r9;\nstruct S { int* p; }\nvoid consume(S s);\n"
            + "@live void f(S s) { consume(s); consume(s); }\n")).toEqual([
            "(4) Error: variable `r9.f.s` has undefined state and cannot be read",
            "(4) Error: variable `r9.f.s` is not Owner, cannot consume its value",
        ]);
    });

    test("argument-less calls: an Owner overwritten (ldc2: a10.d)", () => {
        expect(sema("module a10;\nint* g();\n@live void f() {\n  int* p = g();\n  int* q = g();\n  p = q;\n}\n"))
            .toEqual([
                "(6) Error: variable `a10.f.p` assigning to Owner without disposing of owned value",
                "(4) Error: variable `a10.f.p` is not disposed of before return",
            ]);
    });

    test("member calls: a non-scope `this` consumes the struct (ldc2: a9.d)", () => {
        expect(sema("module a9;\nstruct S { int* p; void m() scope; void n(); }\n"
            + "@live void f(S s) {\n  s.m();\n  s.n();\n  s.n();\n}\n")).toEqual([
            "(5) Error: variable `a9.f.s` has undefined state and cannot be read",
            "(6) Error: variable `a9.f.s` has undefined state and cannot be read",
        ]);
    });
});

describe("mutableStack[vi] read by variable index (ob.d:2306)", () => {
    const decls = "void consume(int* p);\nvoid two(scope int* a, scope int* b);\n";

    test("vi past every slot ever written reads false (ldc2: m1.d compiles clean)", () => {
        expect(sema("module m1;\n" + decls
            + "@live void f(int* x, int* y, int* p) { two(p, p); consume(p); consume(x); consume(y); }\n"))
            .toEqual([]);
    });

    test("vi inside the stack reads the pushed mutability (ldc2: m2.d)", () => {
        expect(sema("module m2;\n" + decls
            + "@live void f(int* p, int* x, int* y) { two(p, p); consume(p); consume(x); consume(y); }\n"))
            .toEqual([
                "(4) Error: variable `m2.f.p` is passed as Owner more than once",
            ]);
    });

    test("vi at a slot holding a const parameter's false (ldc2: m3.d compiles clean)", () => {
        expect(sema("module m3;\nvoid consume(int* p);\nvoid two(scope int* a, scope const(int)* b);\n"
            + "@live void f(int* x, int* p) { two(p, p); consume(p); consume(x); }\n")).toEqual([]);
    });

    test("vi past the stack reads the true an earlier call left there (ldc2: m5.d)", () => {
        expect(sema("module m5;\n" + decls + "void three(scope int* a, scope int* b, scope int* c);\n"
            + "@live void f(int* x, int* y, int* p) { three(x, y, p); two(p, p); "
            + "consume(p); consume(x); consume(y); }\n"))
            .toEqual([
                "(5) Error: variable `m5.f.p` is passed as Owner more than once",
            ]);
    });

    test("vi past the stack reads the false an earlier call left there (ldc2: m6.d compiles clean)", () => {
        expect(sema("module m6;\n" + decls
            + "void three(scope const(int)* a, scope const(int)* b, scope const(int)* c);\n"
            + "@live void f(int* x, int* y, int* p) { three(x, y, p); two(p, p); "
            + "consume(p); consume(x); consume(y); }\n"))
            .toEqual([]);
    });
});

describe("toObNodes control flow over calls to checked callees", () => {
    test("for loop: the back edge meets the consumed state (ldc2: q10.d)", () => {
        expect(sema("module q10;\nvoid consume(int* p);\n"
            + "@live void f(int* p, int n) { for (int i = 0; i < n; i++) consume(p); }\n")).toEqual([
            "(3) Error: variable `q10.f.p` is both Owner and Undefined",
            "(3) Error: variable `q10.f.p` has undefined state and cannot be read",
            "(3) Error: variable `q10.f.p` is not Owner, cannot consume its value",
        ]);
    });

    test("while (true) with break: the loop head merges both paths (ldc2: r7.d)", () => {
        expect(sema("module r7;\nvoid consume(int* p);\n"
            + "@live void f(int* p) { while (true) { consume(p); break; } }\n"))
            .toEqual([
                "(3) Error: variable `r7.f.p` is both Owner and Undefined",
            ]);
    });

    test("try/finally: the consume in the body reaches the return (ldc2: q11.d compiles clean)", () => {
        expect(sema("module q11;\nvoid consume(int* p);\n@live void f(int* p) { try { consume(p); } finally { } }\n"))
            .toEqual([]);
    });

    test("goto to a label: both paths consume once (ldc2: q12.d compiles clean)", () => {
        expect(sema("module q12;\nvoid consume(int* p);\n"
            + "@live void f(int* p, bool b) { if (b) goto L; consume(p); return; L: consume(p); }\n")).toEqual([]);
    });

    test("switch with case and default arms, each consuming (ldc2: r4.d compiles clean)", () => {
        expect(sema("module r4;\nvoid consume(int* p);\n"
            + "@live void f(int* p, int n) { switch (n) { "
            + "case 1: consume(p); break; default: consume(p); break; } }\n"))
            .toEqual([]);
    });

    test("conditional expression: each arm consumes (ldc2: r5.d compiles clean)", () => {
        expect(sema("module r5;\nvoid consume(int* p);\n"
            + "@live void f(int* p, bool b) { b ? consume(p) : consume(p); }\n"))
            .toEqual([]);
    });

    test("logical expression in a condition (ldc2: r6.d compiles clean)", () => {
        expect(sema("module r6;\nvoid consume(int* p);\n"
            + "@live void f(int* p, bool b, bool c) { if (b && c) {} consume(p); }\n"))
            .toEqual([]);
    });

    test("an uninitialized local passed by value is Undefined but not reported (ldc2: q13.d compiles clean)", () => {
        expect(sema("module q13;\nvoid consume(int* p);\n@live void f(int* p) { int* q; consume(q); consume(p); }\n"))
            .toEqual([]);
    });

    test("an out argument initializes the local (ldc2: r8.d compiles clean)", () => {
        expect(sema("module r8;\nvoid consume(int* p);\nvoid init(out int* p);\n"
            + "@live void f() { int* p; init(p); consume(p); }\n")).toEqual([]);
    });
});

// checkMutableArguments (dmd/escape.d:80), reached from functionParameters at expressionsem.d:4900-4902 for a
// `@safe` / default-trust or `@live` callee under dip1021. Each expectation is the ldc2 1.43.0
// `-c -o- -preview=dip1021` output (probes p1-p22, k1, g1, g2 of the port's report). The `gag = true` leg
// (escape.d:188) is unreachable: the one D caller passes `false`. The global gag (`__traits(compiles)`) is
// reachable and pinned by g1: `errors` is still set and the report is suppressed by `global.gag`.
describe("checkMutableArguments (dmd/escape.d:80) — DIP1021 argument ownership", () => {
    const one = (line: number, verb: string, v: string, fd: string): string =>
        `(${line}) Error: more than one mutable reference ${verb} \`${v}\` in arguments to \`${fd}()\``;
    const mixed = (line: number, verb: string, v: string, fd: string): string =>
        `(${line}) Error: mutable and const references ${verb} \`${v}\` in arguments to \`${fd}()\``;

    test("the same local's address passed twice to a @live callee: `to` (ldc2: p1.d)", () => {
        expect(sema("module p1;\n@live void two(int* a, int* b);\nvoid f() { int x; two(&x, &x); }\n"))
            .toEqual([one(3, "to", "x", "p1.two")]);
    });

    test("mutable plus const pointer to the same local (ldc2: p2.d)", () => {
        expect(sema("module p2;\n@live void two(int* a, const(int)* b);\nvoid f() { int x; two(&x, &x); }\n"))
            .toEqual([mixed(3, "to", "x", "p2.two")]);
    });

    test("both const: no error (ldc2: p7.d compiles clean)", () => {
        expect(sema("module p7;\n@live void two(const(int)* a, const(int)* b);\nvoid f() { int x; two(&x, &x); }\n"))
            .toEqual([]);
    });

    test("the same pointer passed twice by value: `of` (ldc2: p3.d)", () => {
        expect(sema("module p3;\n@live void two(int* a, int* b);\nvoid f(int* p) { two(p, p); }\n"))
            .toEqual([one(3, "of", "p", "p3.two")]);
    });

    test("the same local passed to two ref parameters (ldc2: p4.d)", () => {
        expect(sema("module p4;\n@live void two(ref int a, ref int b);\nvoid f() { int x; two(x, x); }\n"))
            .toEqual([one(3, "to", "x", "p4.two")]);
    });

    test("ref parameter against pointer parameter (ldc2: p10.d)", () => {
        expect(sema("module p10;\n@live void two(ref int a, int* b);\nvoid f() { int x; two(x, &x); }\n"))
            .toEqual([one(3, "to", "x", "p10.two")]);
    });

    test("a struct holding a pointer passed twice by value (ldc2: p20.d)", () => {
        expect(sema("module p20;\nstruct S { int* p; }\n@live void two(S a, S b);\nvoid f(S s) { two(s, s); }\n"))
            .toEqual([one(4, "of", "s", "p20.two")]);
    });

    test("distinct locals: no error (ldc2: p17.d compiles clean)", () => {
        expect(sema("module p17;\n@live void two(int* a, int* b);\nvoid f() { int x; int y; two(&x, &y); }\n"))
            .toEqual([]);
    });

    test("one argument: the len <= 1 early-out (ldc2: p18.d compiles clean)", () => {
        expect(sema("module p18;\n@live void one(int* a);\nvoid f() { int x; one(&x); }\n")).toEqual([]);
    });

    test("three arguments: each pair of the same local is reported (ldc2: p13.d)", () => {
        expect(sema("module p13;\n@live void three(int* a, const(int)* b, int* c);\n"
            + "void f() { int x; int y; three(&x, &y, &x); three(&y, &x, &x); }\n"))
            .toEqual([one(3, "to", "x", "p13.three"), mixed(3, "to", "x", "p13.three")]);
    });

    test("the error sits on the first argument of the pair (ldc2: k1.d, one argument per line)", () => {
        expect(sema("module k1;\n@live void three(int* a, const(int)* b, int* c);\nvoid f() { int x; int y;\n"
            + "  three(&y,\n    &x,\n    &x);\n  three(&x,\n    &y,\n    &x);\n}\n"))
            .toEqual([mixed(5, "to", "x", "k1.three"), one(7, "to", "x", "k1.three")]);
    });

    test("a variadic argument with no Parameter (ldc2: p8.d)", () => {
        expect(sema("module p8;\n@live void v(int* a, ...);\nvoid f() { int x; v(&x, &x); }\n"))
            .toEqual([one(3, "to", "x", "p8.v")]);
    });

    test("ref inout parameter reads the argument's mutability (ldc2: p21.d)", () => {
        expect(sema("module p21;\n@live void two(ref inout(int) a, int* b);\nvoid f() { int x; two(x, &x); }\n"))
            .toEqual([one(3, "to", "x", "p21.two")]);
    });

    test("ref inout parameter over a const argument: no error (ldc2: p22.d compiles clean)", () => {
        expect(sema("module p22;\n@live void two(ref inout(int) a, const(int)* b);\n"
            + "void f() { const int y; two(y, &y); }\n")).toEqual([]);
    });

    test("inout pointer parameter counts as const (ldc2: p19.d)", () => {
        expect(sema("module p19;\n@live void two(ref int a, inout(int)* b);\n"
            + "void f() { int x; two(x, &x); const int y; two(x, &y); }\n"))
            .toEqual([mixed(3, "to", "x", "p19.two")]);
    });

    test("struct `this` passed by ref against a field argument (ldc2: p5.d)", () => {
        expect(sema("module p5;\nstruct S { int x; @live void m(ref int a); }\nvoid f() { S s; s.m(s.x); }\n"))
            .toEqual([one(3, "to", "s", "p5.S.m")]);
    });

    test("class `this` passed by value against the same reference (ldc2: p12.d)", () => {
        expect(sema("module p12;\nclass C { int x; @live void m(C c); }\nvoid f(C c) { c.m(c); }\n"))
            .toEqual([one(3, "of", "c", "p12.C.m")]);
    });

    test("a call through a @live function pointer names `indirectly` (ldc2: p9.d)", () => {
        expect(sema("module p9;\nvoid f(void function(int*, int*) @live fp) { int x; fp(&x, &x); }\n"))
            .toEqual([one(2, "to", "x", "indirectly")]);
    });

    test("dip1000 leg: a non-@live callee from a @safe caller (ldc2: p11.d)", () => {
        expect(sema("module p11;\nvoid two(scope int* a, scope int* b) @safe;\n"
            + "void f() @safe { int x; two(&x, &x); }\n")).toEqual([one(3, "to", "x", "p11.two")]);
    });

    test("dip1000 leg: a @system caller is not reported (ldc2: p15.d compiles clean)", () => {
        expect(sema("module p15;\nvoid two(scope int* a, scope int* b);\nvoid f() { int x; two(&x, &x); }\n"))
            .toEqual([]);
    });

    test("an outer variable counts as a ref argument (ldc2: p14.d)", () => {
        expect(sema("module p14;\nvoid f() @safe { int x; void g(ref int a) @safe { x++; } g(x); }\n"))
            .toEqual([one(2, "to", "x", "p14.f.g")]);
    });

    test("globally gagged: `__traits(compiles)` sees the error, nothing is printed (ldc2: g1.d compiles clean)", () => {
        expect(sema("module g1;\n@live void two(int* a, int* b);\n"
            + "void f() { int x; static assert(!__traits(compiles, two(&x, &x))); }\n")).toEqual([]);
    });

    test("dip1000 leg: an inferred caller is committed to @system and still reports (ldc2: g2.d)", () => {
        expect(sema("module g2;\nvoid two(scope int* a, scope int* b) @safe;\n"
            + "void g()() { int x; two(&x, &x); }\nvoid h() @safe { g(); }\n"))
            .toEqual([
                one(3, "to", "x", "g2.two"),
                "(4) Error: template instance `g2.g!()` error instantiating",
                "(4) Error: `@safe` function `g2.h` cannot call `@system` function `g2.g!().g`",
                "(3)        `g2.g!().g` is declared here",
            ]);
    });
});
