// Goal tests for src/dmd/dinterpret.ts.
//
// dmd/dinterpret.d has ZERO in-source `unittest{}` blocks (`grep -c unittest dmd/dinterpret.d` = 0), so this file
// takes the 10 §1.6b shape: one module-load smoke test plus behaviour pins, one `test()` per concern. Each input is
// parsed and run through expressionSemantic in the scope of a small analysed module (no optimize() pass), then handed
// to `ctfeInterpret`, so the Interpreter visitors do the evaluation.
//
// WHERE THE EXPECTED VALUES COME FROM. Value and diagnostic pins are ldc2 1.43.0 output (arm64-apple-darwin):
// `pragma(msg, <expr>)` for values, `typeof` for types, stderr for diagnostics. Where ldc2's own front end folds the
// literal before CTFE (index, shift), the probe reaches the same dinterpret.d line through a CTFE function call; the
// probe text is quoted at the pin. Four pins are DERIVED from the D source instead, because ldc2 cannot show them:
// the ctfeEmplaceExp GC path (D:192), the isRuntimeHook answers (D:6230-6247), the getValue precondition (D:339) and
// the clean-unwind pin of the host-stack escalation (see dinterpret.ts's header record).
import { initSemaHarness } from "../sema-harness.js"; // imports ./dmd/parse.js first: the module-graph root (10 §1.5)
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ctfeInterpret, ctfeInterpretForPragmaMsg, ctfeEmplaceExp, getValue, isRuntimeHook } from "./dinterpret.js";
import { Expression, IntegerExp } from "./expression.js";
import { Parser } from "./parse.js";
import { ErrorSinkNull } from "./errorsink.js";
import { global } from "./globals.js";
import { Module, moduleFromParse } from "./dmodule.js";
import { runSemantic, scopeCreateGlobal } from "./dsymbolsem.js";
import { expressionSemantic } from "./expressionsem.js";
import { Type } from "./mtype.js";
import { TY } from "./astenums.js";
import { EXP } from "./tokens.js";
import { Loc } from "./location.js";
import { Identifier } from "./identifier.js";
import { setDiagnosticHandler } from "./errors.js";
import { dmdformat } from "./root/dmdformat.js";
import { AssertError } from "../assert.js";
import { ds, dsToJs } from "../dstring.js";
import type { Scope } from "./dscope.js";

/** The module every pin analyses its expression in: a struct, globals with and without initializer, and free
 *  functions (a constant, a recursion, a loop, a local struct). */
const MODULE_SRC = "struct S { int x; int y; } int g; const int k; const int k3 = 3; int f() { return 1; }" +
    " int rec(int n) { return n == 0 ? 0 : 1 + rec(n - 1); }" +
    " int sum(int n) { int s = 0; for (int i = 1; i <= n; i++) s += i; return s; }" +
    " int sy() { S s = S(1, 2); s.y += 5; return s.y; }";

function srcBuf(s: string): Uint8Array {
    const b = new Uint8Array(s.length + 1);
    for (let i = 0; i < s.length; i++)
        b[i] = s.charCodeAt(i) & 0xff;
    b[s.length] = 0;
    return b;
}

/** The analysed MODULE_SRC and a global scope over it, rebuilt by `beforeEach` (one module per test: analysing
 *  the same unnamed module twice in one test is itself an error). */
let mod: Module;
let modScope: Scope;

/** lex + parse + runSemantic (passes 0, 1, 3) over MODULE_SRC, into `mod` / `modScope`. */
function analyseModule(): void {
    const p = new Parser(null, null, srcBuf(MODULE_SRC), false, new ErrorSinkNull(), null, false);
    p.nextToken();
    mod = moduleFromParse(p.parseModule(), p.md);
    runSemantic(mod);
    expect(global.errors).toBe(0);
    modScope = scopeCreateGlobal(mod, global.errorSink!);
}

/** Parses `src` as an expression and runs expressionSemantic over it in the module scope (no optimize()). */
function semaExpr(src: string): Expression {
    const p = new Parser(null, null, srcBuf(src), false, new ErrorSinkNull(), null, false);
    p.nextToken();
    const e = expressionSemantic(p.parseExpression(), modScope);
    expect(global.errors).toBe(0);
    return e;
}

/** `ctfeInterpret(semaExpr(src))`, asserting the result is an IntegerExp; returns its carrier and type. */
function ctfeInt(src: string): { value: bigint; ty: TY } {
    const r = ctfeInterpret(semaExpr(src));
    expect(r.op).toBe(EXP.int64);
    return { value: r.isIntegerExp()!.value, ty: r.type!.ty };
}

/** Runs `fn` with diagnostics captured as `<header><message>` strings (the safe.test.ts convention). */
function captureDiags<T>(fn: () => T): { value: T; diags: string[] } {
    const diags: string[] = [];
    setDiagnosticHandler((_loc, _color, header, messageFormat, args) => {
        diags.push(dsToJs(header) + dsToJs(dmdformat(messageFormat, [...args])));
        return true;
    });
    try {
        return { value: fn(), diags };
    } finally {
        setDiagnosticHandler(null);
    }
}

describe("dinterpret.ts", () => {
    beforeEach(() => {
        initSemaHarness();
        analyseModule();
    });

    test("SMOKE: the module loads; ctfeEmplaceExp on the GC path returns the node its thunk builds", () => {
        expect(typeof Expression).toBe("function");
        const made = new IntegerExp(Loc.initial, 42n, Type.tint32);
        expect(ctfeEmplaceExp(() => made)).toBe(made);
    });

    test("integer arithmetic wraps per the result type: 1 + 2 * 3, int.max + 1, -7 / 2, -7 % 3, 5u - 7u", () => {
        expect(ctfeInt("1 + 2 * 3")).toEqual({ value: 7n, ty: TY.Tint32 });
        expect(ctfeInt("int.max + 1")).toEqual({ value: -2147483648n, ty: TY.Tint32 });
        expect(ctfeInt("-7 / 2")).toEqual({ value: -3n, ty: TY.Tint32 });
        expect(ctfeInt("-7 % 3")).toEqual({ value: -1n, ty: TY.Tint32 });
        // ldc2: `pragma(msg, 5u - 7u)` -> 4294967294u, `typeof(5u - 7u)` -> uint
        expect(ctfeInt("5u - 7u")).toEqual({ value: 4294967294n, ty: TY.Tuns32 });
    });

    test("floating arithmetic: 1.5 * 4.0 is 6.0", () => {
        const r = ctfeInterpret(semaExpr("1.5 * 4.0"));
        expect(r.op).toBe(EXP.float64);
        expect(r.isRealExp()!.value).toBe(6);
        expect(r.type!.ty).toBe(TY.Tfloat64);
    });

    test("comparisons and logical operators give bool: 3 < 5, 2 == 3, (1 > 2) || (3 == 3)", () => {
        expect(ctfeInt("3 < 5")).toEqual({ value: 1n, ty: TY.Tbool });
        expect(ctfeInt("2 == 3")).toEqual({ value: 0n, ty: TY.Tbool });
        expect(ctfeInt("(1 > 2) || (3 == 3)")).toEqual({ value: 1n, ty: TY.Tbool });
    });

    test("conditional expression picks the evaluated arm: 1 < 2 ? 10 : 20 is 10", () => {
        expect(ctfeInt("1 < 2 ? 10 : 20")).toEqual({ value: 10n, ty: TY.Tint32 });
    });

    test("array literal index, slice and length: [10, 20, 30][1], [1 .. 3], .length", () => {
        expect(ctfeInt("[10, 20, 30][1]")).toEqual({ value: 20n, ty: TY.Tint32 });
        const ale = ctfeInterpret(semaExpr("[10, 20, 30][1 .. 3]")).isArrayLiteralExp()!;
        expect(ale).not.toBeNull();
        expect(ale.elements!.length).toBe(2);
        expect([0, 1].map((i) => ale.opIndex(i)!.isIntegerExp()!.value)).toEqual([20n, 30n]);
        // ldc2: `pragma(msg, [10, 20, 30].length)` -> 3LU, `typeof(...)` -> ulong (size_t on arm64)
        expect(ctfeInt("[10, 20, 30].length")).toEqual({ value: 3n, ty: TY.Tuns64 });
    });

    test("struct literal field access: S(1, 2).y is 2", () => {
        expect(ctfeInt("S(1, 2).y")).toEqual({ value: 2n, ty: TY.Tint32 });
    });

    test("ctfeInterpretForPragmaMsg on a non-tuple is ctfeInterpret: 1 + 2 is 3", () => {
        const r = ctfeInterpretForPragmaMsg(semaExpr("1 + 2"));
        expect(r.isIntegerExp()!.value).toBe(3n);
    });

    test("non-constant input: reading a mutable global answers ErrorExp with ldc2's diagnostic", () => {
        // ldc2 on `int g; enum y = g + 1;`: `Error: static variable `g` cannot be read at compile time`.
        // getVarExp (dinterpret.d:2160) answers CTFEExp.cantexp; ctfeInterpret turns it into ErrorExp (D:123).
        const e = semaExpr("g + 1");
        const r = captureDiags(() => ctfeInterpret(e));
        expect(r.diags).toEqual(["Error: static variable `g` cannot be read at compile time"]);
        expect(r.value.op).toBe(EXP.error);
        expect(global.errors).toBe(1);
    });

    test("CTFE shift range diagnostic: 1 << 40 on int", () => {
        // ldc2 on `int f() { int n = 40; return 1 << n; } enum z = f();` (interpretCommon, dinterpret.d:3103):
        const shl = captureDiags(() => ctfeInterpret(semaExpr("1 << 40")));
        expect(shl.diags).toEqual(["Error: shift by 40 is outside the range 0..31"]);
        expect(shl.value.op).toBe(EXP.error);
    });

    test("CTFE index range diagnostic: [10, 20, 30][5]", () => {
        // ldc2 on `int f() { int i = 5; return [10, 20, 30][i]; } enum z = f();` (resolveIndexing, dinterpret.d:5189):
        const idx = captureDiags(() => ctfeInterpret(semaExpr("[10, 20, 30][5]")));
        expect(idx.diags).toEqual(["Error: array index 5 is out of bounds `[0..3]`"]);
        expect(idx.value.op).toBe(EXP.error);
    });

    test("getValue on a global CTFE never cached violates CtfeStack.getValue's precondition (dinterpret.d:339)", () => {
        // `const int k;` is data-segment and not CTFE-local, so D asserts `v.ctfeAdrOnStack < globalValues.length`;
        // ctfeAdrOnStack is still AdrOnStackNone.
        const k = mod.symtab!.lookup(Identifier.idPool(ds("k")))!.isVarDeclaration()!;
        expect(() => getValue(k)).toThrow(AssertError);
    });

    test("reading a const global with an initializer caches it: k3 + 1 is 4, then getValue(k3) is 3", () => {
        // ldc2: `const int k3 = 3; pragma(msg, k3 + 1);` -> 4. getVarExp saves the scrubbed initializer with
        // saveGlobalConstant (dinterpret.d:2114), which getValue then answers.
        expect(ctfeInt("k3 + 1")).toEqual({ value: 4n, ty: TY.Tint32 });
        const k3 = mod.symtab!.lookup(Identifier.idPool(ds("k3")))!.isVarDeclaration()!;
        expect(getValue(k3)!.isIntegerExp()!.value).toBe(3n);
    });

    test("isRuntimeHook: a call answers itself when the callee's ident is the hook, null otherwise", () => {
        const call = semaExpr("f()");
        expect(call.op).toBe(EXP.call);
        expect(isRuntimeHook(call, Identifier.idPool(ds("f")))).toBe(call);
        expect(isRuntimeHook(call, Identifier.idPool(ds("g")))).toBeNull();
        expect(isRuntimeHook(semaExpr("1 + 2"), Identifier.idPool(ds("f")))).toBeNull();
    });

    test("function calls: f() is 1, rec(10) is 10, sum(10) is 55, sy() is 7", () => {
        // ldc2: `pragma(msg, f())` -> 1, `rec(10)` -> 10, `sum(10)` -> 55 (a for loop), `sy()` -> 7 (a field
        // op-assign on a local struct). The call path is visitCallExp -> evaluateIfBuiltin (BUILTIN.unimp) ->
        // interpretFunction.
        expect(ctfeInt("f()")).toEqual({ value: 1n, ty: TY.Tint32 });
        expect(ctfeInt("rec(10)")).toEqual({ value: 10n, ty: TY.Tint32 });
        expect(ctfeInt("sum(10)")).toEqual({ value: 55n, ty: TY.Tint32 });
        expect(ctfeInt("sy()")).toEqual({ value: 7n, ty: TY.Tint32 });
    });

    test("ESCALATED: deep recursion overflows the host stack, and the unwinding leaves the CTFE state clean", () => {
        // ldc2 on `enum big = rec(5000);`: `Error: function `rec` CTFE recursion limit exceeded` after 1000 calls
        // (CTFE_RECURSION_LIMIT). The port overflows the JS stack first (dinterpret.ts header record): RangeError.
        // When the record is resolved this pin becomes the ldc2 diagnostic.
        const deep = semaExpr("rec(5000)");
        // Five overflows: a callDepth leaked by any of them (each overflow is 200+ levels deep) would sum past the
        // 1000-call limit, and rec(10) below would then fail with "CTFE recursion limit exceeded".
        for (let i = 0; i < 5; i++)
            expect(() => ctfeInterpret(deep)).toThrow(RangeError);
        const r = captureDiags(() => ctfeInterpret(semaExpr("rec(10)")));
        expect(r.diags).toEqual([]);
        expect(r.value.isIntegerExp()!.value).toBe(10n);
    });
});

/** lex + parse + runSemantic over `src` (UTF-8) as a module of its own; returns the captured diagnostics
 *  (`<header><message>` with the line number in front) and the text `pragma(msg)` wrote to stderr. */
function runModule(src: string): { diags: string[]; msgs: string } {
    const bytes = new TextEncoder().encode(src);
    const buf = new Uint8Array(bytes.length + 1); // NUL-terminated: the lexer scans to the NUL
    buf.set(bytes, 0);
    const msgs: string[] = [];
    const diags: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
        msgs.push(String(chunk));
        return true;
    });
    setDiagnosticHandler((loc, _color, header, messageFormat, args) => {
        diags.push(`${loc.linnum}: ` + dsToJs(header) + dsToJs(dmdformat(messageFormat, [...args])));
        return true;
    });
    try {
        const p = new Parser(null, null, buf, false, new ErrorSinkNull(), null, false);
        p.nextToken();
        runSemantic(moduleFromParse(p.parseModule(), p.md));
    } finally {
        setDiagnosticHandler(null);
        spy.mockRestore();
    }
    return { diags, msgs: msgs.join("") };
}

describe("dinterpret.ts — whole modules: wchar/dchar payloads and the zero-divisor ruling", () => {
    beforeEach(() => {
        initSemaHarness();
    });

    test("CTFE over wstring/dstring payloads: slicing, indexing, foreach decoding, equality (ldc2-pinned)", () => {
        // Every expected line is ldc2 1.43.0's `pragma(msg)` output for the same source (-c -o-).
        const r = runModule(`alias wstr = immutable(wchar)[];
alias dstr = immutable(dchar)[];
wstr f1() { wstr s = "h€llo"w; return s[1 .. 3]; }
pragma(msg, f1());
dchar f2() { dstr s = "x😀y"d; return s[1]; }
pragma(msg, f2());
uint f9() { wstr a = "a€"w; uint n; foreach (dchar c; a) n += c; return n; }
pragma(msg, f9());
wchar f11() { wstr a = "a€"w; return a[$ - 1]; }
pragma(msg, cast(uint) f11());
ulong f12() { dstr a = "a😀"d; return a[1]; }
pragma(msg, f12());
bool f13() { wstr a = "ab"w; wstr b = "ab"w; return a == b; }
pragma(msg, f13());
bool f14() { dstr a = "a😀"d; dstr b = "a😁"d; return a == b; }
pragma(msg, f14());
enum wstr ew = "é€😀";
pragma(msg, ew.length);
pragma(msg, ew);
enum wchar[3] sw = "a€b";
pragma(msg, sw);
`);
        expect(r.diags).toEqual([]);
        expect(r.msgs).toBe("€l\n😀\n8461u\n8364u\n128512LU\ntrue\nfalse\n4LU\né€😀\na€b\n");
    });

    test("constant folding of w/d strings: concatenation, indexing, slicing, pragma(msg) (ldc2-pinned)", () => {
        const r = runModule(`enum w = "ab"w ~ "cd"w;
pragma(msg, w);
enum wn = "é€"w ~ "\\U0001F600"w;
pragma(msg, wn);
pragma(msg, wn.length);
enum dn = "é€"d ~ "\\U0001F600"d;
pragma(msg, dn);
pragma(msg, dn.length);
pragma(msg, "héllo"w);
pragma(msg, "😀"d);
pragma(msg, "é€"w[1]);
pragma(msg, "é€"d[0]);
pragma(msg, "a€😀"w[1 .. 4]);
`);
        expect(r.diags).toEqual([]);
        expect(r.msgs).toBe("abcd\né€😀\n4LU\né€😀\n3LU\nhéllo\n😀\n€\né\n€😀\n");
    });

    test("reinterpret cast of a string literal to a wider static array pads with zeros (dcast.d:2459-2479)", () => {
        // ldc2 prints `扡\n扡摣end\n0u\n25699u\n`: the zero unit that pads `cast(wchar[3])"abcd"c` ends
        // pragma(msg)'s text there, so its newline is not written and "end" follows on the same line.
        const r = runModule(`pragma(msg, cast(wchar[1])"abcd"c);
pragma(msg, cast(wchar[3])"abcd"c);
pragma(msg, "end");
enum wchar[3] rc = cast(wchar[3])"abcd"c;
pragma(msg, cast(uint) rc[2]);
pragma(msg, cast(uint) rc[1]);
`);
        expect(r.diags).toEqual([]);
        expect(r.msgs).toBe("扡\n扡摣end\n0u\n25699u\n");
    });

    test("a failed CTFE assert prints its message through StringExp.toStringz (dinterpret.d:5881)", () => {
        // ldc2: `w5_msg.d(1): Error: bo€m` then `called from here: `g()``.
        const r = runModule(`bool g() { assert(false, "bo€m"); }
enum bb = g();
`);
        expect(r.diags).toEqual(["1: Error: bo€m", "2:        called from here: `g()`"]);
    });

    test("CTFE pointer cast, zero-size pointee: udiv's 0, compiles clean (dinterpret.d:1908/:1937)", () => {
        // ldc2 compiles both functions clean: arm64 `udiv` by 0 is 0 (09 §3.1, as dcast.d:1483).
        const r = runModule(`int f() { int[0][4] v; auto p = cast(int[0][2]*)&v; return 1; }
enum x = f();
int g() { int[0][4] v; auto p = cast(int[0]*)&v; return 2; }
enum y = g();
`);
        expect(r.diags).toEqual([]);
    });
});
