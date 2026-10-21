// Tests for src/query.ts, the hover, go-to-definition, semantic-tokens, inlay-hints and inactive-ranges queries, the
// unused code (10 §4.7, "Queries"), through `djsMainKept` and `djsMain` (src/djs.ts) with the doc-comment knob on.
// Hand-written djs module; no D unittests to port.
//
// Two modules in a temporary directory: lib.d (a documented function, a deprecated one, a documented struct template,
// a ditto'd overload) and app.d, which uses them; then fb.d (code the analysis skipped, member chains), tk.d (a token
// of each type and modifier, branches not chosen), ih.d (inlay hints, inactive ranges), xp.d (expansion peeks, the
// hover's Resolved section), rv.d (the review's shapes), ef.d (enum members whose initializer failed), avlib.d and
// avapp.d (the AST view, the instances), ima.d, imb.d and imc.d (the imports), ua.d and ub.d (unused code) and ro.d.
// Positions are found by searching the text for a token, so an edit of the sources does not shift them by hand. Then
// the read-only contract: a query calls no `optimize` and reports nothing, and queries (tokens included) between two
// kept compiles leave the second compile's output equal to a fresh compile's; the unused code last (its kept-compile
// test resets the modules, which the contract's tests import after their compiles).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type * as Djs from "./djs.js";
import type * as Query from "./query.js";

const LIB = `module lib;

/// Adds two numbers.
///
/// The sum wraps on overflow.
///
/// Params:
///     a = the first operand
///     b = the second, as $(D a)
/// Returns: \`a + b\`, see $(REF add, lib)
int add(int a, int b) { return a + b; }

deprecated("use add") int plus(int a, int b) { return a + b; }

/// A box of one value.
struct Box(T) {
    T value;
    /// The boxed value.
    T get() { return value; }
}

/// Multiplies.
/// Examples:
/// ---
/// int x = mul(2, 3);
/// ---
int mul(int a, int b) { return a * b; }
/// ditto
long mul(long a, long b) { return a * b; }
`;

const APP = `module app;
import lib;

struct Point { int x; int y; int len() { return x + y; } }

int use(int param) {
    Point p;
    int local = param + p.len();
    Box!int b;
    b.value = local;
    Box!string s;
    return add(local, b.get()) + plus(1, 2) + cast(int) s.get().length;
}
`;

const XP = `module xp;

struct V {
    int v;
    V opBinary(string op)(V o) const { return V(mixin("v " ~ op ~ " o.v")); }
    bool opEquals(V o) const { return v == o.v; }
    int opCmp(V o) const { return v - o.v; }
    @property int twice() const { return v * 2; }
}
struct Inner { int deep; }
struct Outer { Inner inner; alias inner this; }
struct Rng { int i; bool empty() const { return i >= 3; } int front() const { return i; } void popFront() { i++; } }
struct App { int opApply(scope int delegate(ref int) dg) { int x = 1; return dg(x); } }

mixin("int mixedA = 1; int mixedB = 2;");
enum K = 1 << 4;
enum K2 = 3;
enum Plain = 3;
enum E { a = 1 << 2, b }
template Twice(int n) { enum Twice = n * 2; }
struct Box(T, int N) { T[N] items; }
mixin template Adder(T) { T added; }
struct WithMixin { mixin Adder!int; }
int over(int a) { return a; }
int over(long a, int b) { return b; }
int only(int a) { return a; }
int ufcs(V a, int b) { return a.v + b; }
int pick(T)(T x) { static if (is(T == int)) return 1; else return 2; }

int main() {
    V a = V(1), b = V(2);
    V c = a + b;
    bool ne = a != b;
    bool lt = a < b;
    int t = a.twice;
    Outer o;
    int d = o.deep;
    int s = 0;
    foreach (x; Rng()) s += x;
    foreach (ref y; App()) s += y;
    s += over(1) + only(4) + a.ufcs(5);
    long l = s;
    mixin("s += 1;"); mixin("s += 2;");
    Box!(int, K2 + 1) bx;
    s += Twice!3 + pick!int(1) + pick(2L);
    WithMixin wm;
    static if (K > 10) s++;
    return s + cast(int) l + only(1);
}
`;

let dir = "";
let djs: typeof Djs;
let query: typeof Query;

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "djs-query-"));
    vi.resetModules();
    djs = await import("./djs.js");
    query = await import("./query.js");
});

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

/** Runs `f` with stdout and stderr captured (the compiles print the deprecation). */
function quiet<T>(f: () => T): { value: T; out: string } {
    const chunks: string[] = [];
    const decode = (c: string | Uint8Array): string => (typeof c === "string" ? c : new TextDecoder().decode(c));
    const o = vi.spyOn(process.stdout, "write").mockImplementation((c) => { chunks.push(decode(c)); return true; });
    const e = vi.spyOn(process.stderr, "write").mockImplementation((c) => { chunks.push(decode(c)); return true; });
    try {
        return { value: f(), out: chunks.join("") };
    } finally {
        o.mockRestore();
        e.mockRestore();
    }
}

/**
 * Writes the files and compiles `root` with the knob on, through `djsMainKept` or `djsMain`: the status and the
 * output, and the engine's mode ("fresh" for djsMain).
 */
function compile(files: Record<string, string>, root: string, kept: boolean, extra: readonly string[] = []):
    { out: string; mode: string } {
    for (const [name, text] of Object.entries(files))
        writeFileSync(join(dir, name), text);
    const args = ["-c", "-o-", "-verrors=0", ...extra, `-I${dir}`, join(dir, root)];
    const onFatal = (): boolean => true;
    const r = quiet(() => (kept ? djs.djsMainKept(args, onFatal, { docComments: true })
        : { status: djs.djsMain(args, onFatal, { docComments: true }), mode: "fresh" }));
    return { out: `${r.value.status}\n${r.out}`, mode: r.value.mode };
}

/** The (line, character) of the `nth` occurrence of `token` in `text`, plus `skip` characters. */
function at(text: string, token: string, nth = 0, skip = 0): { line: number; character: number } {
    let i = -1;
    for (let k = 0; k <= nth; k++) {
        i = text.indexOf(token, i + 1);
        if (i < 0)
            throw new Error(`no occurrence ${nth} of ${token}`);
    }
    i += skip;
    const before = text.slice(0, i);
    const line = before.split("\n").length - 1;
    return { line, character: i - (before.lastIndexOf("\n") + 1) };
}

function hover(file: string, text: string, token: string, nth = 0, skip = 0): Djs.HoverAnswer {
    const p = at(text, token, nth, skip);
    return djs.queryHover(join(dir, file), p.line, p.character, text);
}

function definition(file: string, text: string, token: string, nth = 0, skip = 0): Djs.DefinitionAnswer {
    const p = at(text, token, nth, skip);
    return djs.queryDefinition(join(dir, file), p.line, p.character, text);
}

/** The hover's kind and name, or the miss's reason. */
function said(a: Djs.HoverAnswer): string {
    return a.result === null ? `miss: ${a.reason}` : `${a.result.kind} ${a.result.name}`;
}

/** The definition's file (base name), line and character, or the miss's reason. */
function target(a: Djs.DefinitionAnswer): string {
    if (a.result === null)
        return `miss: ${a.reason}`;
    const r = a.result.range;
    return `${a.result.file.slice(dir.length + 1)}:${r.start.line}:${r.start.character}-${r.end.character}`;
}

describe.each([["djsMainKept", true], ["djsMain", false]])("queries after %s", (_name, kept) => {
    beforeAll(() => {
        compile({ "lib.d": LIB, "app.d": APP }, "app.d", kept);
    });

    test("a local variable, a parameter, a call, a method through `.`, a struct type, an imported function", () => {
        expect(said(hover("app.d", APP, "local", 1))).toBe("local variable app.use.local");
        expect(said(hover("app.d", APP, "param", 1))).toBe("parameter app.use.param");
        expect(said(hover("app.d", APP, "add("))).toBe("function lib.add");
        expect(said(hover("app.d", APP, "len()", 1))).toBe("function app.Point.len");
        expect(said(hover("app.d", APP, "Point p"))).toBe("struct app.Point");
        expect(said(hover("app.d", APP, "lib;"))).toBe("module lib");
        expect(target(definition("app.d", APP, "local", 1))).toBe("app.d:7:8-13");
        expect(target(definition("app.d", APP, "param", 1))).toBe("app.d:5:12-17");
        expect(target(definition("app.d", APP, "add("))).toBe("lib.d:10:4-7");
        expect(target(definition("app.d", APP, "len()", 1))).toBe("app.d:3:33-36");
        expect(target(definition("app.d", APP, "Point p"))).toBe("app.d:3:7-12");
        expect(target(definition("app.d", APP, "lib;"))).toBe("lib.d:0:0-0");
    });

    test("the hover's code block, and the doc comment's sections rendered", () => {
        const h = hover("app.d", APP, "add(");
        expect(h.result).not.toBeNull();
        const md = h.result!.markdown;
        expect(md).toContain("```d\nint add(int a, int b)\n```");
        expect(md).toContain("Adds two numbers.\n\nThe sum wraps on overflow.");
        expect(md).toContain("**Params**\n\n- `a`: the first operand\n- `b`: the second, as `a`");
        expect(md).toContain("**Returns**\n\n`a + b`, see `add`");
        expect(h.result!.range).toEqual({ start: at(APP, "add("), end: at(APP, "add(", 0, 3) });
    });

    test("a template instance's member, its type and its doc comment", () => {
        const h = hover("app.d", APP, "get()");
        expect(said(h)).toBe("function lib.Box!int.Box.get");
        expect(h.result!.markdown).toContain("In instance `Box!int`.");
        expect(h.result!.markdown).toContain("The boxed value.");
        expect(target(definition("app.d", APP, "get()"))).toBe("lib.d:18:6-9");
        expect(said(hover("app.d", APP, "Box!int"))).toBe("struct lib.Box!int.Box");
        expect(hover("app.d", APP, "Box!int").result!.markdown).toContain("A box of one value.");
        expect(said(hover("app.d", APP, "value", 0))).toBe("field lib.Box!int.Box.value");
        // inside the template, the analysed copies answer: the first instance, and how many there are
        const inside = hover("lib.d", LIB, "value;", 1);
        expect(said(inside)).toBe("field lib.Box!int.Box.value");
        expect(inside.result!.markdown).toContain("In instance `Box!int` (1 of 2 instances).");
        expect(target(definition("lib.d", LIB, "value;", 1))).toBe("lib.d:16:6-11");
    });

    test("a `---` example under a section's own line; a `ditto` comment is the previous declaration's", () => {
        const h = hover("lib.d", LIB, "mul(long");
        expect(said(h)).toBe("function lib.mul");
        expect(h.result!.markdown).toContain("```d\nlong mul(long a, long b)\n```");
        expect(h.result!.markdown).toContain("Multiplies.\n\n**Examples**\n\n```d\nint x = mul(2, 3);\n```");
        expect(hover("lib.d", LIB, "mul(int").result!.markdown).toContain("Multiplies.");
    });

    test("a deprecated symbol says so", () => {
        const h = hover("app.d", APP, "plus(");
        expect(said(h)).toBe("function lib.plus");
        expect(h.result!.markdown).toContain("**Deprecated**: use add");
    });

    test("a text other than the compiled one: no answer, stale", () => {
        const edited = APP.replace("int local", "int  local");
        const h = djs.queryHover(join(dir, "app.d"), 7, 14, edited);
        expect(h).toEqual({ result: null, stale: true, reason: djs.STALE_REASON });
        expect(djs.queryDefinition(join(dir, "app.d"), 7, 14, edited).result).toBeNull();
    });

    test("no symbol: a keyword, a literal, a file outside the compile", () => {
        expect(said(hover("app.d", APP, "return add"))).toBe("miss: no symbol at the position");
        expect(said(hover("app.d", APP, "(1, 2)", 0, 1))).toBe("miss: no identifier at the position");
        expect(said(djs.queryHover(join(dir, "other.d"), 0, 0, ""))).toBe("miss: the file is not in the last compile");
    });
});

describe("a file that does not compile", () => {
    const BAD = `module bad;
int broken() { return undefinedThing + 1; }
int fine(int q) { return q * 2; }
`;

    test("the error gives nothing; the rest answers", () => {
        const { out } = compile({ "bad.d": BAD }, "bad.d", true);
        expect(out).toContain("undefined identifier `undefinedThing`");
        expect(said(hover("bad.d", BAD, "undefinedThing"))).toBe("miss: no symbol at the position");
        expect(said(hover("bad.d", BAD, "q *"))).toBe("parameter bad.fine.q");
        expect(target(definition("bad.d", BAD, "q *"))).toBe("bad.d:2:13-14");
    });
});

describe("the fallback, and member chains", () => {
    const FB = `module fb;
int count;
int value;
void f(T)(T value) { int count = 2; count += value; }
version (none) { void g() { int count; count++; } }
int h(int n) { static if (false) { int count; count++; } return n; }
enum E { a = 1 }
int k() { return E.a; }
struct T1 { int x; int len() { return x; } }
struct S1 { T1 x; T1 len() { return x; } }
int z(S1 a) { return a.x.x + a.len().len(); }
struct Q { int[] bits; }
struct R { Q q; }
size_t pz(R* r) { return r.q.bits.length; }
`;

    test("no answer in code the analysis skipped; a folded enum member answers", () => {
        compile({ "fb.d": FB }, "fb.d", true);
        // an uninstantiated template, a `version (none)` block, a `static if (false)` statement: the module's
        // `count` and `value` are other declarations
        expect(said(hover("fb.d", FB, "count +="))).toBe("miss: no symbol at the position");
        expect(said(hover("fb.d", FB, "value;", 1))).toBe("miss: no symbol at the position");
        expect(said(hover("fb.d", FB, "count++"))).toBe("miss: no symbol at the position");
        expect(said(hover("fb.d", FB, "count++", 1))).toBe("miss: no symbol at the position");
        expect(said(hover("fb.d", FB, "E.a", 0, 2))).toBe("enum member fb.E.a");
    });

    test("each access of a chain names its own member: two of one name, a call between, a pointer", () => {
        expect(said(hover("fb.d", FB, "x.x"))).toBe("field fb.S1.x");
        expect(said(hover("fb.d", FB, "x.x", 0, 2))).toBe("field fb.T1.x");
        expect(said(hover("fb.d", FB, "len().len"))).toBe("function fb.S1.len");
        expect(said(hover("fb.d", FB, "len().len", 0, 6))).toBe("function fb.T1.len");
        expect(said(hover("fb.d", FB, "q.bits", 0))).toBe("field fb.R.q");
        expect(said(hover("fb.d", FB, "q.bits", 0, 2))).toBe("field fb.Q.bits");
    });
});

// built-in properties, names through public and local imports, template parameters without a node
const BP = `module bp;
struct S { int a; long b; }
int[] arr;
int[4] fixed;
string[string] aa;
string[] words(const(char)[] t) { return null; }
size_t f(S s, const(char)[] text) {
    S[] list;
    size_t n = list.length + text.length + fixed.length + s.sizeof + S.sizeof;
    float x = float.nan;
    uint m = uint.max;
    aa.remove("k");
    return n + arr.ptr[0] + words(text).length + S.init.a;
}
struct J { int[string] m; ref int[string] obj() return { return m; } }
void delegate(int code, string why) onDone;
size_t g(J j) { int addr; j.obj.remove("x"); return "--port=".length + addr.sizeof; }
`;
const PA = "module pa;\npublic import pb;\nenum A_ONE = 1;\n";
const PB = "module pb;\nenum B_TWO = 2;\nstruct Handle { int v; static Handle invalid() { return Handle(); } }\n";
const PU = `module pu;
import pa;
int use() {
    Handle h = Handle.invalid();
    int x = B_TWO;
    {
        import io = pb;
        x += io.B_TWO;
    }
    import pb : TWO = B_TWO;
    return x + TWO + A_ONE + h.v;
}
`;
const TP = `module tp;
struct Layer { int x; }
struct Other { int y; }
enum isLayer(T) = is(T == struct);
struct Node(CL, int N = 2) if (isLayer!CL) {
    static if (N > 1) CL* layers;
    int count() { static if (isLayer!CL) return N; else return 0; }
}
int use() { Node!Layer a; Node!(Other, 3) b; return a.count() + b.count(); }
`;

describe("built-in properties, imports, template parameters", () => {
    /** The hover's first line and code block, or the miss's reason. */
    function shown(token: string, nth = 0, skip = 0): string {
        const h = hover("bp.d", BP, token, nth, skip);
        return h.result === null ? `miss: ${h.reason}` : `${h.result.kind}: ${h.result.markdown.replace(/\n+/g, " ")}`;
    }

    test("a property of the operand's type: its type, the operand's; no declaration", () => {
        compile({ "bp.d": BP }, "bp.d", true);
        expect(shown("list.length", 0, 5)).toBe("property: *property* `length` of `S[]` ```d size_t length ```");
        expect(shown("text.length", 0, 5))
            .toBe("property: *property* `length` of `const(char)[]` ```d size_t length ```");
        expect(shown("fixed.length", 0, 6)).toBe("property: *property* `length` of `int[4]` ```d size_t length ```");
        expect(shown("s.sizeof", 0, 2)).toBe("property: *property* `sizeof` of `S` ```d size_t sizeof ```");
        expect(shown("S.sizeof", 0, 2)).toBe("property: *property* `sizeof` of `S` ```d size_t sizeof ```");
        expect(shown("float.nan", 0, 6)).toBe("property: *property* `nan` of `float` ```d float nan ```");
        expect(shown("uint.max", 0, 5)).toBe("property: *property* `max` of `uint` ```d uint max ```");
        expect(shown("aa.remove", 0, 3))
            .toBe("property: *property* `remove` of `string[string]` ```d bool remove(string key) ```");
        expect(shown("arr.ptr", 0, 4)).toBe("property: *property* `ptr` of `int[]` ```d int* ptr ```");
        expect(shown("text).length", 0, 6)).toBe("property: *property* `length` of `string[]` ```d size_t length ```");
        expect(shown("S.init", 0, 2)).toBe("property: *property* `init` of `S` ```d S init ```");
        expect(target(definition("bp.d", BP, "list.length", 0, 5)))
            .toBe("miss: a built-in property has no declaration");
        expect(target(definition("bp.d", BP, "list.length"))).toBe("bp.d:7:8-12");
        // a property call's return type; a string literal; the operand `.sizeof` folds away
        expect(shown("obj.remove", 0, 4))
            .toBe("property: *property* `remove` of `int[string]` ```d bool remove(string key) ```");
        expect(shown("\".length", 0, 2)).toBe("property: *property* `length` of `string` ```d size_t length ```");
        expect(said(hover("bp.d", BP, "addr.sizeof"))).toBe("local variable bp.g.addr");
        expect(target(definition("bp.d", BP, "addr.sizeof"))).toBe("bp.d:16:20-24");
    });

    test("a parameter named in a delegate type: its type, its name as its declaration", () => {
        expect(shown("code,")).toBe("parameter: *parameter* `code` ```d int code ```");
        expect(target(definition("bp.d", BP, "why)"))).toBe("bp.d:15:31-34");
    });

    test("names through a public import, a function's imports: renamed, selective, a module's member", () => {
        compile({ "pa.d": PA, "pb.d": PB, "pu.d": PU }, "pu.d", true);
        const both = (token: string, skip = 0): string =>
            `${said(hover("pu.d", PU, token, 0, skip))} | ${target(definition("pu.d", PU, token, 0, skip))}`;
        // `Handle` and `B_TWO` through pa's public import of pb, where the analysis left no node
        expect(both("Handle.invalid")).toBe("struct pb.Handle | pb.d:2:7-13");
        expect(both("B_TWO;")).toBe("variable pb.B_TWO | pb.d:1:5-10");
        // a renamed import in a block: its name, at the import and at a use; the module's member after it
        expect(both("io = pb")).toBe("import pu.use.io | pu.d:6:20-22");
        expect(both("io.B_TWO")).toBe("import pu.use.io | pu.d:6:20-22");
        expect(both("io.B_TWO", 3)).toBe("variable pb.B_TWO | pb.d:1:5-10");
        // a selective import's new name in the function's body
        expect(both("TWO +")).toBe("variable pb.B_TWO | pb.d:1:5-10");
        expect(both("A_ONE")).toBe("variable pa.A_ONE | pa.d:2:5-10");
    });

    test("a template's parameter where the analysis left no node: the argument, of the instance there", () => {
        compile({ "tp.d": TP }, "tp.d", true);
        const shown = (token: string, nth = 0): string => {
            const h = hover("tp.d", TP, token, nth);
            const inst = h.result?.markdown.match(/In instance .*/)?.[0] ?? "";
            return `${said(h)} ${inst} | ${target(definition("tp.d", TP, token, nth))}`;
        };
        const layer = "struct tp.Layer In instance `Node!(Layer, 2)` (1 of 2 instances). | tp.d:1:7-12";
        const n = "variable tp.N In instance `Node!(Layer, 2)` (1 of 2 instances). | tp.d:4:20-21";
        // the parameter list, the constraint, a `static if` condition: no node; a field's type: the analysed one
        expect([shown("CL, int"), shown("N = 2"), shown("CL) {"), shown("N > 1"), shown("CL* layers")])
            .toEqual([layer, n, layer, n, layer]);
        // in an instance's function: that instance's argument
        expect([shown("CL) return"), shown("N; else")]).toEqual([layer, n]);
    });
});

// round 2: no answer where the compile resolved nothing, a plain import's name as its package, no pick among imports
const UT = `module ut;
int count;
int f() { return count; }
unittest {
    int count = 3;
    count++;
    f();
}
int g() { return count; }
`;
const IP = `module ip;
import core.stdc.stdio;
int f() {
    import core.stdc.string;
    return cast(int) core.stdc.string.strlen("x") + core.stdc.stdio.EOF;
}
`;
const AMA = "module ama;\nenum K = 1;\n";
const AMB = "module amb;\nenum K = 2;\n";
const AMC = "module amc;\npublic import amb;\n";
const AMD = "module amd;\npublic import amb;\nenum K = 4;\n";
const AMU = `module amu;
import ama;
import amc;
int bad() { return K; }
int good() { return ama.K + amb.K; }
`;
const AMV = "module amv;\nimport amd;\nint one() { return K; }\n";
const MS = `module ms;
import std.typecons : Tuple;
class C { int f; }
struct U { bool force; }
Tuple!(bool, "terminated", int, "status") wait() { return typeof(return)(true, 0); }
bool forced(T)(T* cl) {
    static if (is(typeof(cl.force) : bool))
        return cl.force;
    else
        return false;
}
int use(Object o, int[]* q, C c) {
    import cstdio = core.stdc.stdio;
    cstdio.fflush(cstdio.stdout);
    auto st = wait();
    U u;
    bool b = st.terminated && forced(&u) && forced(&o);
    return (cast(C) o).f + (c).f + cast(int) (*q).length + b;
}
`;

describe("no answer the compile did not resolve, imports' names, operands and aliases", () => {
    test("a unittest body the parser skipped answers nothing; with -unittest, its analysis", () => {
        compile({ "ut.d": UT }, "ut.d", true);
        // without -unittest the module's `count` and `f` are not what the compile resolved there: it resolved nothing
        expect(said(hover("ut.d", UT, "count++"))).toBe("miss: no symbol at the position");
        expect(said(hover("ut.d", UT, "f();"))).toBe("miss: no symbol at the position");
        expect(target(definition("ut.d", UT, "count = 3"))).toBe("miss: no symbol at the position");
        // the token after the body's `}` is outside it
        expect(said(hover("ut.d", UT, "g()"))).toBe("function ut.g");
        expect(said(hover("ut.d", UT, "count; }", 1))).toBe("variable ut.count");
        compile({ "ut.d": UT }, "ut.d", true, ["-unittest"]);
        expect(said(hover("ut.d", UT, "count++"))).toBe("local variable ut.__unittest_L4_C1.count");
        expect(said(hover("ut.d", UT, "f();"))).toBe("function ut.f");
    });

    test("a plain import's name is its package, in a body and at the module, as the analysis resolves it", () => {
        compile({ "ip.d": IP }, "ip.d", true);
        expect(said(hover("ip.d", IP, "core.stdc.string.strlen"))).toBe("package core");
        expect(said(hover("ip.d", IP, "core.stdc.stdio.EOF"))).toBe("package core");
        expect(said(hover("ip.d", IP, "stdio.EOF"))).toBe("module core.stdc.stdio");
        expect(said(hover("ip.d", IP, "EOF"))).toBe("enum member core.stdc.stdio.EOF");
        expect(target(definition("ip.d", IP, "core.stdc.string.strlen"))).toBe("miss: a package has no declaration");
    });

    test("a name two imports declare answers nothing; a module's own member hides its public imports'", () => {
        const files = { "ama.d": AMA, "amb.d": AMB, "amc.d": AMC, "amd.d": AMD, "amu.d": AMU, "amv.d": AMV };
        compile(files, "amu.d", true);
        // `K` is ama's and, through amc's public import, amb's: ldc2 reports the ambiguity, the body has errors
        expect(said(hover("amu.d", AMU, "K; }"))).toBe("miss: no symbol at the position");
        expect(said(hover("amu.d", AMU, "K +", 0))).toBe("variable ama.K");
        expect(said(hover("amu.d", AMU, "K; }", 1))).toBe("variable amb.K");
        compile(files, "amv.d", true);
        expect(said(hover("amv.d", AMV, "K; }"))).toBe("variable amd.K");
    });

    test("a parenthesised operand's member, an alias's runtime target, a Tuple's field, a name in `typeof`", () => {
        compile({ "ms.d": MS }, "ms.d", true);
        const both = (token: string, nth = 0, skip = 0): string =>
            `${said(hover("ms.d", MS, token, nth, skip))} | ${target(definition("ms.d", MS, token, nth, skip))}`;
        // the access sits inside the parentheses (`o`), or the variable at the `(`
        expect(both("f + (c)")).toBe("field ms.C.f | ms.d:2:14-15");
        expect(both("c).f")).toBe("parameter ms.use.c | ms.d:11:30-31");
        expect(both("f + cast")).toBe("field ms.C.f | ms.d:2:14-15");
        expect(said(hover("ms.d", MS, "length"))).toBe("property length");
        // the analysis' node is the alias's target, under another name: at the token, at the chain's start
        expect(said(hover("ms.d", MS, "stdout"))).toBe("variable core.stdc.stdio.__stdoutp");
        expect(said(hover("ms.d", MS, "terminated &&")))
            .toBe("field std.typecons.Tuple!(bool, \"terminated\", int, \"status\").Tuple.__expand_field_0");
        // `typeof` keeps no node: the parameter of the first instance, its type's member
        expect(both("cl.force) :")).toBe("parameter ms.forced!(U).forced.cl | ms.d:5:18-20");
        expect(both("force) :")).toBe("field ms.U.force | ms.d:3:16-21");
    });
});

describe("the doc-comment knob", () => {
    test("off: no doc comment in the hover; flipping it compiles fresh", () => {
        const args = ["-c", "-o-", "-verrors=0", `-I${dir}`, join(dir, "app.d")];
        writeFileSync(join(dir, "lib.d"), LIB);
        writeFileSync(join(dir, "app.d"), APP);
        const on = quiet(() => djs.djsMainKept(args, () => true, { docComments: true })).value;
        expect(hover("app.d", APP, "add(").result!.markdown).toContain("Adds two numbers.");
        const off = quiet(() => djs.djsMainKept(args, () => true)).value;
        expect([on.status, off.status, off.mode, off.reason]).toEqual([0, 0, "fresh", "the host options changed"]);
        const h = hover("app.d", APP, "add(");
        expect(said(h)).toBe("function lib.add");
        expect(h.result!.markdown).not.toContain("Adds two numbers.");
    });
});

describe("semantic tokens", () => {
    const TK = `module tk;
import core.stdc.stdlib : exit;

interface Shape { double area(); }
class Circle : Shape {
    double r;
    static int count;
    this(double r) { this.r = r; }
    double area() { return r * r; }
    @property int twice() const { return 2; }
    static Circle unit() { return new Circle(1); }
}
struct Pt { int x; }
union U { int i; float f; }
enum Color { red, green }
enum int limit = 3;
alias Cb = void delegate();
alias PtAlias = Pt;
deprecated int old() { return 1; }
T id(T, int n)(T v) { return v + n; }
version (none) { enum other = Color.red; }
struct Box(T) { T value; T get() { return value; } }
struct M { void tm(T)(T x) {} static M opCall(T)(T x) { M m; return m; } }
class C2 { this(T)(T x) {} }
alias Ex = Exception;
int helper(int p) {
    static int calls;
    const int k = 2;
    int c = Color.green;
    auto s = new Circle(2.0);
    Pt q = Pt(1);
    PtAlias a;
    Cb cb;
    Exception e;
    version (none) { int dead = limit; }
    scope(exit) calls++;
    M mm;
    mm.tm(1);
    mm.tm!long(2);
    auto r2 = M(2);
    auto c2 = new C2(1);
    Box!Pt bx;
    Ex ex;
    tk.Pt qq;
    return id!(int, 1)(p) + k + q.x + a.x + limit + s.twice + Circle.count + old() + c;
}
`;

    /** The token at the `nth` occurrence of `token` (plus `skip`) as "type modifier...", or "none". */
    function tokenAt(data: Uint32Array, text: string, token: string, nth = 0, skip = 0): string {
        const p = at(text, token, nth, skip);
        for (let i = 0; i < data.length; i += 5) {
            if (data[i] === p.line && data[i + 1] === p.character) {
                const mods = djs.SEMANTIC_TOKEN_MODIFIERS.filter((_, k) => (data[i + 4]! & (1 << k)) !== 0);
                return [djs.SEMANTIC_TOKEN_TYPES[data[i + 3]!], ...mods].join(" ");
            }
        }
        return "none";
    }

    test("each type and modifier; sorted, no overlap", () => {
        compile({ "tk.d": TK }, "tk.d", true);
        const a = djs.querySemanticTokens(join(dir, "tk.d"), TK);
        expect(a.result).not.toBeNull();
        const d = a.result!.data;
        const tk = (token: string, nth = 0, skip = 0): string => tokenAt(d, TK, token, nth, skip);
        expect(tk("tk;")).toBe("namespace declaration");
        expect([tk("core"), tk("stdc"), tk("stdlib")]).toEqual(Array(3).fill("namespace defaultLibrary"));
        expect(tk("exit;")).toBe("function defaultLibrary");
        expect(tk("exit)")).toBe("none");                             // `scope(exit)`
        expect(tk("Shape {")).toBe("interface declaration");
        expect(tk("Shape {", 1)).toBe("interface");                   // a base class
        expect(tk("Circle :")).toBe("class declaration");
        expect(tk("Circle(1)")).toBe("class");                        // `new Circle(...)`: the constructor's type
        expect(tk("Circle.count")).toBe("class");
        expect(tk("r;")).toBe("property declaration");
        expect(tk("r = r", 0, 0)).toBe("property");
        expect(tk("r = r", 0, 4)).toBe("parameter");
        expect(tk("count;")).toBe("property declaration static");
        expect(tk("count +")).toBe("property static");
        expect(tk("area() {")).toBe("method declaration");
        expect(tk("twice()")).toBe("property declaration");
        expect(tk("twice +")).toBe("property");
        expect(tk("unit()")).toBe("method declaration static");
        expect(tk("Pt {")).toBe("struct declaration");
        expect(tk("Pt(1)")).toBe("struct");
        expect(tk("U {")).toBe("struct declaration");
        expect(tk("Color {")).toBe("enum declaration");
        expect(tk("red,")).toBe("enumMember declaration readonly");
        expect(tk("Color.green")).toBe("enum");
        expect(tk("green;")).toBe("enumMember readonly");             // folded to its value: the fallback
        expect(tk("limit =")).toBe("variable declaration readonly");
        expect(tk("limit +")).toBe("variable readonly");
        expect(tk("Cb =")).toBe("type declaration");
        expect(tk("Cb cb")).toBe("type");
        expect(tk("PtAlias a")).toBe("struct");                      // an alias of a struct type
        expect(tk("old()")).toBe("function declaration deprecated");
        expect(tk("old() +")).toBe("function deprecated");
        expect(tk("id(")).toBe("function declaration");
        expect(tk("id!")).toBe("function");
        expect(tk("T v")).toBe("typeParameter");
        expect(tk("n; }")).toBe("parameter readonly");              // a template value parameter, folded
        expect(tk("helper(")).toBe("function declaration");
        expect(tk("p) {")).toBe("parameter declaration");
        expect(tk("p) +")).toBe("parameter");
        expect(tk("calls;")).toBe("variable declaration static");
        expect(tk("k = 2")).toBe("variable declaration readonly");
        expect(tk("c = ")).toBe("variable declaration");
        expect(tk("Exception")).toBe("class defaultLibrary");
        expect(tk("tm(T)")).toBe("method declaration");
        expect([tk("tm(1)"), tk("tm!long")]).toEqual(["method", "method"]);   // a member template's instances
        expect(tk("M(2)")).toBe("struct");                            // a templated static `opCall`: its aggregate
        expect(tk("C2(1)")).toBe("class");                            // a templated constructor: its type
        expect(tk("T value")).toBe("typeParameter");                  // in the instance Box!Pt
        expect(tk("Ex =")).toBe("class declaration");                 // a user's alias of druntime's class
        expect(tk("Ex ex")).toBe("class");
        expect(tk("tk.Pt")).toBe("namespace");                        // the module, not its declaration
        expect(tk("int")).toBe("none");                               // keywords and basic types: the grammar's
        let sorted = true;
        for (let i = 5; i < d.length; i += 5)
            sorted &&= d[i]! > d[i - 5]! || (d[i] === d[i - 5] && d[i + 1]! >= d[i - 4]! + d[i - 3]!);
        expect(sorted).toBe(true);
    });

    test("hover and definition at a template parameter in an instance: the argument", () => {
        expect(said(hover("tk.d", TK, "T value"))).toBe("struct tk.Pt");
        expect(target(definition("tk.d", TK, "T value"))).toBe(`tk.d:${at(TK, "Pt {").line}:7-9`);
    });

    test("a branch the analysis did not choose has no tokens", () => {
        const d = djs.querySemanticTokens(join(dir, "tk.d"), TK).result!.data;
        expect(tokenAt(d, TK, "other")).toBe("none");
        expect(tokenAt(d, TK, "Color.red")).toBe("none");
        expect(tokenAt(d, TK, "red;")).toBe("none");
        expect(tokenAt(d, TK, "dead")).toBe("none");
        expect(tokenAt(d, TK, "limit; }")).toBe("none");
    });

    test("a text other than the compiled one: stale; a file outside the compile: a miss", () => {
        expect(djs.querySemanticTokens(join(dir, "tk.d"), `${TK}\n`))
            .toEqual({ result: null, stale: true, reason: djs.STALE_REASON });
        expect(djs.querySemanticTokens(join(dir, "other.d"), ""))
            .toEqual({ result: null, stale: false, reason: "the file is not in the last compile" });
    });
});

describe("inlay hints and inactive ranges", () => {
    const IH = `module ih;

struct Box(T) { T value; auto get() { return value; } }
int add(int left, int right) { return left + right; }
void many(string fmt, int[] rest...) {}
int named(int a, int b) { return a - b; }
auto twice(int x) { return x * 2; }
T id(T)(T v) { return v; }
template Unused(T) { enum Unused = 1; }
class C { this(int size, string name) {} }
struct S { int a; version (none): int b; }
enum E { one }

version (none) enum os = "none"; else enum os = "other";
version (all) {} else { int never() { return 1; } }
debug (Lab) int labOnly;
static if (is(int == long)) alias W = long; else alias W = int;

int use(int left) {
    auto a = add(1, 2);
    const b = add(left, 3);
    int c = add(a, b);
    auto d = 1, e = "x";
    int f = 2, g = 3;
    foreach (i, x; [1, 2, 3]) c += x;
    foreach (size_t j, ref y; [4, 5]) c += y;
    Box!int bi;
    Box!string bs;
    auto v = bi.get() + named(b: 1, a: 2);
    auto k = new C(3, "n");
    many("x", 1, 2, 3);
    version (none) c += 1; else c -= 1;
    version (none) try { c++; } catch (Exception) { c--; }
    version (none) do c++; while (c < 3);
    version (none) while (c > 100) c--; else c++;
    static if (W.sizeof == 8) { c = 9; } else { c = 8; }
    version (all) c += E.one;
    auto z = id!long(4) + twice(c) + left.twice;
    return c + id(3) + f + g;
}
`;
    const whole = { start: { line: 0, character: 0 }, end: { line: 999, character: 0 } };

    beforeAll(() => {
        compile({ "ih.d": IH }, "ih.d", true);
    });

    /** The hints at the `nth` occurrence of `token` (plus `skip`) as "kind label", or "none". */
    function hintsAt(hints: readonly Djs.InlayHint[], token: string, nth = 0, skip = 0): string {
        const p = at(IH, token, nth, skip);
        const here = hints.filter((h) => h.position.line === p.line && h.position.character === p.character);
        return here.length === 0 ? "none" : here.map((h) => `${h.kind} ${h.label}`).join(", ");
    }

    test("types of declarations without one, an `auto` function's return type, a template's instances", () => {
        const h = djs.queryInlayHints(join(dir, "ih.d"), IH, whole).result!.hints;
        expect(hintsAt(h, "a = add", 0, 1)).toBe("type : int");
        expect(hintsAt(h, "b = add", 0, 1)).toBe("type : const(int)");
        expect(hintsAt(h, "c = add", 0, 1)).toBe("none");
        expect(hintsAt(h, "auto d = 1", 0, 6)).toBe("type : int");
        expect(hintsAt(h, `e = "x"`, 0, 1)).toBe("type : string");
        expect(hintsAt(h, "f = 2", 0, 1)).toBe("none");
        expect(hintsAt(h, "g = 3", 0, 1)).toBe("none");
        expect(hintsAt(h, "i, x", 0, 1)).toBe("type : ulong");
        expect(hintsAt(h, "x; [1", 0, 1)).toBe("type : int");
        expect(hintsAt(h, "j, ref", 0, 1)).toBe("none");
        expect(hintsAt(h, "y; [4", 0, 1)).toBe("type : int");
        expect(hintsAt(h, `os = "other"`, 0, 2)).toBe("type : string");
        expect(hintsAt(h, "get()", 0, 5)).toBe("type -> int | string");
        expect(hintsAt(h, "twice(int x)", 0, 12)).toBe("type -> int");
        expect(hintsAt(h, "Box(T)", 0, 3)).toBe("instances 2 instances");
        expect(hintsAt(h, "id(T)", 0, 2)).toBe("instances 2 instances");
        expect(hintsAt(h, "Unused(T)", 0, 6)).toBe("none");
        const box = h.find((x) => x.kind === "instances" && x.position.line === at(IH, "Box(T)").line)!;
        expect(box.tooltip).toContain("`Box!int`");
        expect(box.tooltip).toContain("`Box!string`");
        expect(h.find((x) => x.label === ": const(int)")!.tooltip).toBe("```d\nconst(int) b\n```");
    });

    test("parameter names: the overload picked, UFCS, variadic, named arguments, a constructor, a range", () => {
        const h = djs.queryInlayHints(join(dir, "ih.d"), IH, whole).result!.hints;
        expect(hintsAt(h, "add(1, 2)", 0, 4)).toBe("parameter left:");
        expect(hintsAt(h, "add(1, 2)", 0, 7)).toBe("parameter right:");
        expect(hintsAt(h, "add(left, 3)", 0, 4)).toBe("none");
        expect(hintsAt(h, "add(left, 3)", 0, 10)).toBe("parameter right:");
        expect(hintsAt(h, "named(b: 1", 0, 6)).toBe("none");
        expect(hintsAt(h, "C(3, ", 0, 2)).toBe("parameter size:");
        expect(hintsAt(h, `"n")`)).toBe("parameter name:");
        expect(hintsAt(h, `many("x"`, 0, 5)).toBe("parameter fmt:");
        expect(hintsAt(h, "1, 2, 3)")).toBe("parameter rest:");
        expect(hintsAt(h, "2, 3)")).toBe("none");
        expect(hintsAt(h, "twice(c)", 0, 6)).toBe("parameter x:");
        expect(hintsAt(h, "id(3)", 0, 3)).toBe("parameter v:");
        expect(h.find((x) => x.label === "left:")!.tooltip).toBe("```d\nint add(int left, int right)\n```");
        const line = at(IH, "add(1, 2)").line;
        const one = djs.queryInlayHints(join(dir, "ih.d"), IH,
            { start: { line, character: 0 }, end: { line: line + 1, character: 0 } }).result!.hints;
        expect(one.map((x) => x.label)).toEqual([": int", "left:", "right:"]);
    });

    test("the branches not chosen: declarations, statements, the `:` form, `else`; tokens only outside them", () => {
        const r = djs.queryInactiveRanges(join(dir, "ih.d"), IH).result!.ranges;
        const lines = IH.split("\n");
        const textOf = (q: Djs.QueryRange): string => {
            const part = lines.slice(q.start.line, q.end.line + 1);
            part[part.length - 1] = part[part.length - 1]!.slice(0, q.end.character);
            part[0] = part[0]!.slice(q.start.character);
            return part.join("\n");
        };
        expect(r.map(textOf)).toEqual([
            " int b; ", ` enum os = "none";`, " { int never() { return 1; } }", " int labOnly;", " alias W = long;",
            " c += 1;", " try { c++; } catch (Exception) { c--; }", " do c++; while (c < 3);",
            " while (c > 100) c--;", " { c = 9; }",
        ]);
        const d = djs.querySemanticTokens(join(dir, "ih.d"), IH).result!.data;
        const tokenAt = (token: string, skip = 0): boolean => {
            const p = at(IH, token, 0, skip);
            for (let i = 0; i < d.length; i += 5)
                if (d[i] === p.line && d[i + 1] === p.character)
                    return true;
            return false;
        };
        expect(tokenAt("never")).toBe(false);
        expect(tokenAt("W = long", 0)).toBe(false);
        expect(tokenAt("W = int", 0)).toBe(true);
        // a chosen branch whose only names were folded away keeps its tokens
        expect(tokenAt("E.one")).toBe(true);
        expect(tokenAt("E.one", 2)).toBe(true);
    });

    test("a text other than the compiled one: stale; a file outside the compile: a miss", () => {
        expect(djs.queryInactiveRanges(join(dir, "ih.d"), `${IH}\n`))
            .toEqual({ result: null, stale: true, reason: djs.STALE_REASON });
        expect(djs.queryInlayHints(join(dir, "ih.d"), `${IH}\n`, whole))
            .toEqual({ result: null, stale: true, reason: djs.STALE_REASON });
        expect(djs.queryInlayHints(join(dir, "other.d"), "", whole))
            .toEqual({ result: null, stale: false, reason: "the file is not in the last compile" });
    });

    test("tuple expansions, speculative instances, contracts, strings, a mixin template: the reviewed shapes", () => {
        const R = `module ih2;
import std.typecons : tuple;
void foo(int a, int b, int c) {}
auto f(T)(T x) { static if (is(T == int)) return 1; else return "s"; }
void use(string s) {}
void a() {} void b() {} void c() {}
mixin template M(T) { static if (is(T == int)) int ma; else float mb; }
struct A { mixin M!int; }
void main() {
    int n;
    auto t = tuple(1, 2);
    foo(t.expand, 3);
    auto r = f(1);
    enum ok = __traits(compiles, f(1.0));
    version (none) void helper() { }
    do { n++; } while (n < 3);
    version (all) static foreach (i; 0 .. 1) if (n) a(); else b(); else c();
    version (none) use(q"(say "hi)"); else use("x");
    version (none) auto s = q{ ( }; else { }
}
`;
        compile({ "ih2.d": R }, "ih2.d", true);
        const file = join(dir, "ih2.d");
        const h = djs.queryInlayHints(file, R, whole).result!.hints;
        const label = (token: string, skip: number): string => {
            const p = at(R, token, 0, skip);
            const here = h.filter((x) => x.position.line === p.line && x.position.character === p.character);
            return here.length === 0 ? "none" : here.map((x) => x.label).join(", ");
        };
        // a tuple written as one argument expands to several: no parameter follows the text any more
        expect(label("foo(t.expand", 4)).toBe("none");
        expect(label("3);", 0)).toBe("none");
        // the instance of `__traits(compiles)` is speculative: not counted, its type not shown
        expect(label("f(T)", 1)).toBe("1 instance");
        expect(label("f(T)(T x)", 9)).toBe("-> int");
        const lines = R.split("\n");
        const ranges = djs.queryInactiveRanges(file, R).result!.ranges.map((q) => {
            const part = lines.slice(q.start.line, q.end.line + 1);
            part[part.length - 1] = part[part.length - 1]!.slice(0, q.end.character);
            part[0] = part[0]!.slice(q.start.character);
            return part.join("\n");
        });
        // the speculative instance's choice does not count; the `do` after a dimmed function is a statement, not its
        // contract; a brace-less `static foreach` holds its `if ... else`; delimited and token strings hide their
        // parentheses and quotes; a mixin template's branches are not decided by this file's mixins alone
        expect(ranges).toEqual([' return "s";', " void helper() { }", " c();", ` use(q"(say "hi)");`,
            " auto s = q{ ( };"]);
    });
});

describe("expansion peeks and resolution on hover", () => {
    const file = (): string => join(dir, "xp.d");

    beforeAll(() => {
        compile({ "xp.d": XP }, "xp.d", true);
    });

    /** The expansion at the `nth` occurrence of `token` (plus `skip`) as "kind title instances: text", or the miss. */
    function peek(token: string, nth = 0, skip = 0): string {
        const p = at(XP, token, nth, skip);
        const a = djs.queryExpansion(file(), { start: p, end: p }, XP);
        if (a.result === null)
            return `miss: ${a.reason}`;
        return `${a.result.kind} ${a.result.title} ${a.result.instances}: ${a.result.text}`;
    }

    /** The Resolved section of the hover at the `nth` occurrence of `token` (plus `skip`), "" when it has none. */
    function resolved(token: string, nth = 0, skip = 0): string {
        const h = hover("xp.d", XP, token, nth, skip);
        const md = h.result?.markdown ?? "";
        return md.includes("**Resolved**") ? md.slice(md.indexOf("**Resolved**")) : "";
    }

    test("the sites: string mixins, instances written with `!`, folded values; the outermost of nested ones", () => {
        const lines = XP.split("\n");
        const sites = djs.queryExpansionSites(file(), XP).result!.sites.map((x) => {
            const r = x.range;
            return `${x.kind} ${lines[r.start.line]!.slice(r.start.character, r.end.character)} | ${x.title}`;
        });
        expect(sites).toEqual([
            'mixin mixin("int mixedA = 1; int mixedB = 2;") | mixin: 2 declarations',
            "value 1 << 4 | = 16",
            "value 1 << 2 | = 4",
            "value n * 2 | = 6",
            "instance Adder!int | mixin Adder!int",
            "value is(T == int) | = true",
            'mixin mixin("s += 1;") | mixin: 1 statement',
            'mixin mixin("s += 2;") | mixin: 1 statement',
            "instance Box!(int, K2 + 1) | Box!(int, 4)",
            "instance Twice!3 | Twice!3",
            "instance pick!int | pick!int",
            "value K > 10 | = true",
        ]);
    });

    test("a peek: a mixin's parsed code, an instance as -vcg-ast prints it, a value; the innermost site", () => {
        expect(peek('mixin("int')).toBe("mixin mixin: 2 declarations 1: int mixedA = 1;\nint mixedB = 2;\n");
        expect(peek('mixin("s += 2')).toBe("mixin mixin: 1 statement 1: s += 2;\n");   // the second on its line
        expect(peek("Box!(int", 0, 5)).toBe("instance Box!(int, 4) 1: Box!(int, 4)\n{\n    struct Box\n    {\n"
            + "        int[4] items;\n    }\n\n}\n");
        expect(peek("K2 + 1", 0, 3)).toBe("value = 4 1: 4\n");                       // a value argument in it
        expect(peek("Adder!int;")).toBe("instance mixin Adder!int 1: mixin Adder!int;\n{\n    int added;\n}\n");
        expect(peek("Twice!3")).toBe("instance Twice!3 1: Twice!3\n{\n    enum int Twice = 6;\n\n}\n");
        expect(peek("pick!int")).toContain("int pick(int x)\n    {\n        return 1;\n    }");
        expect(peek("is(T == int)")).toBe("value = true 2: true\n");               // two instances, the first shown
        expect(peek("1 << 2")).toBe("value = 4 1: 4\n");
        expect(peek("pick(2L)")).toBe("miss: no expansion at the range");          // an IFTI call is no site
        expect(peek("K2 = 3")).toBe("miss: no expansion at the range");            // nor a value as written
        expect(djs.queryExpansion(file(), { start: at(XP, "K"), end: at(XP, "K") }, `${XP}\n`))
            .toEqual({ result: null, stale: true, reason: djs.STALE_REASON });
        expect(djs.queryExpansionSites(join(dir, "other.d"), ""))
            .toEqual({ result: null, stale: false, reason: "the file is not in the last compile" });
    });

    test("the Resolved section: operators, `foreach`, property, `alias this`, UFCS, an overload, a conversion", () => {
        const block = (label: string, code: string): string => `**Resolved**\n\n${label}\n\n\`\`\`d\n${code}\n\`\`\``;
        const plus = hover("xp.d", XP, "a + b", 0, 2);
        expect([plus.result!.kind, plus.result!.name]).toEqual(["operator", "+"]);
        expect(plus.result!.markdown).toBe(block("Lowered:", 'a.opBinary!"+"(b)'));
        expect(resolved("!= b", 0, 1)).toBe(block("Lowered:", "!a.opEquals(b)"));
        expect(resolved("< b")).toBe(block("Lowered:", "a.opCmp(b) < 0"));
        expect(resolved("foreach (x")).toBe(block("Lowered:",
            "Rng __r3 = Rng(0);\nfor (; !__r3.empty(); __r3.popFront())\n{\n    int x = __r3.front();\n    ...\n}"));
        expect(resolved("foreach (ref")).toContain("App().opApply(delegate int(ref int y)");
        expect(resolved("twice;")).toBe(block("Property call:", "a.twice()"));
        expect(resolved("deep;", 1)).toBe(block("Through `alias this`:", "o.inner.deep"));
        expect(resolved("ufcs(5)")).toBe(block("UFCS:", "ufcs(a, 5)"));
        expect(resolved("over(1)")).toBe(block("Overload picked among 2 candidates:", "int over(int a)"));
        expect(resolved("s;", 2)).toBe(block("Implicit conversion:", "cast(long)s"));
        // the first part is unchanged, the section follows it
        const over = hover("xp.d", XP, "over(1)").result!.markdown;
        expect(over.startsWith("*function* `xp.over`\n\n```d\nint over(int a)\n```\n\n---\n\n**Resolved**")).toBe(true);
        // quiet where it says nothing: the only overload as written, a written cast, an operator on ints
        expect(resolved("only(4)")).toBe("");
        expect(resolved("l + only")).toBe("");
        expect(said(hover("xp.d", XP, "+ cast"))).toBe("miss: no identifier at the position");
    });
});

describe("the review's shapes: recursion, mixins on one line, operators, ranges, quiet values", () => {
    const RV = `module rv;
template Traits(T) { alias Self = Traits!T; enum size = T.sizeof; }
template apply(alias fun) { auto apply(T)(T x) { return fun(x); } }
struct V {
    int v;
    V opBinary(string op)(V o) const { return V(v + o.v); }
    V opUnary(string op)() const { return V(-v); }
    int opIndex(size_t i) const { return v; }
    int opCast(T : int)() const { return v; }
}
struct W { int[] a; void opIndexOpAssign(string op)(int x, size_t i) { a[i] += x; } }
struct Get { int deep; }
struct ByFun { Get g; Get get() { return g; } alias get this; }
struct F(double d) { enum x = 1; }
struct B(string s) { enum x = 1; }
struct Box(T) { T v; }
interface I {}
class C : I {}
enum s1 = "a" ~ "b";
enum s2 = "abc";
enum hex = 0xFF;
enum fl = 2.5f;
enum n = Box!int.sizeof;

int main() {
    int ex = mixin("2"); static foreach (z; 0 .. 2) mixin("ex += z;");
    V a = V(1), b = V(2);
    V* p = &a;
    V c = a+b;
    int g = a[1];
    V u1 = -*p;
    V u2 = -(a + b);
    V u3 = -a;
    int ci = cast(int) a;
    W w;
    w.a = [1];
    w[0] += 1;
    ByFun bf;
    int d = bf.deep;
    F!1.5 f;
    int k = 3;
    int r = apply!(x => x + k)(1) + B!("a" ~ "b").x;
    static if (true) ex++;
    int[] arr = [1, 2];
    foreach (i, x; arr) ex += x;
    I o = new C;
    return ex + cast(int) Traits!int.size + c.v + g + u1.v + u2.v + u3.v + ci + d + r;
}
`;
    const file = (): string => join(dir, "rv.d");

    beforeAll(() => {
        compile({ "rv.d": RV }, "rv.d", true);
    });

    /** The expansion of the range from the `nth` `token` (plus `skip`) over `width` characters, as in `peek`. */
    function peekRange(token: string, nth = 0, skip = 0, width = 0): string {
        const p = at(RV, token, nth, skip);
        const a = djs.queryExpansion(file(), { start: p, end: { line: p.line, character: p.character + width } }, RV);
        return a.result === null ? `miss: ${a.reason}` : `${a.result.kind} ${a.result.title} ${a.result.instances}`;
    }

    /** The hover at the `nth` `token` (plus `skip`): kind, then its Resolved section's code blocks, or "none". */
    function lowered(token: string, nth = 0, skip = 0): string {
        const h = hover("rv.d", RV, token, nth, skip);
        const md = h.result?.markdown ?? "";
        const i = md.indexOf("**Resolved**");
        return i < 0 ? "none" : `${h.result!.kind}: ${[...md.slice(i).matchAll(/```d\n([\s\S]*?)\n```/g)]
            .map((m) => m[1]).join(" | ")}`;
    }

    test("a self-referential alias in an instance prints by name; a lens's range gets its own site", () => {
        const p = at(RV, "Traits!int.size");
        expect(djs.queryExpansion(file(), { start: p, end: p }, RV).result!.text)
            .toBe("Traits!int\n{\n    alias Self = Traits!int;\n    enum ulong size = 4LU;\n}\n");
        const site = djs.queryExpansionSites(file(), RV).result!.sites.find((x) => x.title === "= 4LU"
            && x.range.start.line === at(RV, "Box!int.sizeof").line)!;
        expect(djs.queryExpansion(file(), site.range, RV).result!.kind).toBe("value");   // not the instance inside
        expect(peekRange("Box!int.sizeof")).toBe("instance Box!int 1");                   // a cursor: the innermost
        expect(peekRange("Box!int.sizeof", 0, 0, 14)).toBe("value = 4LU 1");              // a selection of it
        expect(peekRange("n = Box", 0, 0, 10)).toBe("miss: no expansion at the range");
    });

    test("statement mixins only, matched per keyword; ranges past strings and floats; no literal is a site", () => {
        const lines = RV.split("\n");
        const sites = djs.queryExpansionSites(file(), RV).result!.sites.map((x) => {
            const r = x.range;
            return `${lines[r.start.line]!.slice(r.start.character, r.end.character)} | ${x.title}`;
        });
        expect(sites).toEqual(["T.sizeof | = 4LU", '"a" ~ "b" | = "ab"', "Box!int.sizeof | = 4LU",
            'mixin("ex += z;") | mixin: 1 statement', "F!1.5 | F!1.5", "apply!(x => x + k) | apply!((x) => x + k)",
            'B!("a" ~ "b") | B!"ab"', "Traits!int | Traits!int"]);
        expect(peekRange('mixin("ex')).toBe("mixin mixin: 1 statement 2");   // two `static foreach` iterations
        expect(peekRange('mixin("2")')).toBe("miss: no expansion at the range");
        expect(peekRange("1.5", 0, 2)).toBe("instance F!1.5 1");
        expect(peekRange('"b").x', 0, 1)).toBe('value = "ab" 1');           // the value argument, whole
    });

    test("operators after an identifier, unary lowerings at their token, `alias this` to a function, kinds", () => {
        expect(lowered("a+b", 0, 1)).toBe('operator: a.opBinary!"+"(b)');
        expect(lowered("a[1]", 0, 1)).toBe("operator: a.opIndex(1LU)");
        expect(lowered("-*p")).toBe('operator: (*p).opUnary!"-"()');
        expect(lowered("-(a + b)")).toBe('operator: a.opBinary!"+"(b).opUnary!"-"()');
        expect(lowered("-(a + b)", 0, 4)).toBe('operator: a.opBinary!"+"(b)');
        expect(lowered("-a;")).toBe('operator: a.opUnary!"-"()');
        expect(lowered("cast(int) a")).toBe("expression: a.opCast!int()");
        expect(lowered("+= 1")).toBe('operator: w.opIndexOpAssign!"+"(1, 0LU)');
        expect(lowered("deep;", 1)).toBe("field: bf.get().deep");
        expect(lowered("bf.deep")).toBe("none");
        expect(lowered("new C")).toBe("expression: cast(I)new C");
        expect(lowered("foreach (i")).toBe("none");   // the array's `cast(int)__r12.length`: a compiler's temporary
    });
});

describe("enum members whose initializer failed", () => {
    // noreturn_expr2.d: the use of `E.illegal` replaces its initializer with an `ErrorInitializer`; fail109.d: the
    // second enum's `Unknown` keeps an unanalysed `DWORD.max`, and `Bool.Unknown` a null value, so a literal of
    // those enums printed meets a member with no integer value
    const EF = `module ef;
enum E { e1 = 1, e2 = 2, illegal = noreturn }
alias DWORD = uint;
enum : DWORD { REG_DWORD = 4 }
enum RegValueType1a : DWORD { Unknown = DWORD.max, DWORD = REG_DWORD }
enum Bool : bool { False, True, Unknown }
void main() { E e; e = E.illegal; }
`;

    beforeAll(() => {
        compile({ "ef.d": EF }, "ef.d", true);
    });

    test("every query answers, at every character; the failed member's hover has no value", () => {
        const file = join(dir, "ef.d");
        const lines = EF.split("\n");
        const whole = { start: { line: 0, character: 0 }, end: { line: lines.length, character: 0 } };
        expect(djs.querySemanticTokens(file, EF).result).not.toBeNull();
        expect(djs.queryInlayHints(file, EF, whole).result).not.toBeNull();
        expect(djs.queryInactiveRanges(file, EF).result).not.toBeNull();
        expect(djs.queryExpansionSites(file, EF).result).not.toBeNull();
        for (let l = 0; l < lines.length; l++) {
            for (let c = 0; c < lines[l]!.length; c++) {
                const p = { line: l, character: c };
                djs.queryHover(file, l, c, EF);
                djs.queryDefinition(file, l, c, EF);
                djs.queryExpansion(file, { start: p, end: p }, EF);
            }
        }
        expect(said(hover("ef.d", EF, "illegal", 1))).toBe("enum member ef.E.illegal");
        expect(hover("ef.d", EF, "illegal", 1).result!.markdown).toContain("```d\nef.E.illegal\n```");
        expect(said(hover("ef.d", EF, "DWORD = REG"))).toBe("enum member ef.RegValueType1a.DWORD");
        expect(said(hover("ef.d", EF, "True"))).toBe("enum member ef.Bool.True");
    });

    test("the compile keeps LDC's crash where hdrgen meets one: each query restores the faithful reader", () => {
        const r = compile({ "ec.d": "enum E { A = int.max, B }\npragma(msg, cast(E)5);\n" }, "ec.d", true);
        expect(r.out).toContain("Internal error: TypeError");
    });
});

describe("the AST view, the template instances, the imports", () => {
    const AVLIB = `module avlib;
struct Box(T) { T value; T get() { return value; } }
int sum(int[] a) { int s; foreach (x; a) s += x; return s; }
const width = 3;
template count(Args...) { enum count = Args.length; }
`;
    const AVAPP = `module avapp;
import avlib;
struct Point { int x; int y; int len() const { return x + y; } }
int use(int param) {
    Point p;
    Box!int b;
    b.value = param + p.len();
    Box!string s;
    foreach (i; 0 .. 2) b.value += i;
    return b.get() + cast(int) s.get().length + sum([1, 2]) + cast(int) count!(param, width);
}
`;
    /** avapp.d with a function before `use` whose `foreach` takes two generated names (`__r`, `__key`). */
    const EDITED = AVAPP.replace("int use(", "int pre(int[] q) { int t; foreach (y; q) t += y; return t; }\nint use(");
    const AV_ARGS = (): string[] => ["-c", "-o-", "-verrors=0", "-i", `-I${dir}`, join(dir, "avapp.d")];

    /** Writes the files and compiles avapp.d with avlib.d under `-i`, kept: the engine's mode. */
    function avCompile(files: Record<string, string>): string {
        for (const [name, text] of Object.entries(files))
            writeFileSync(join(dir, name), text);
        return quiet(() => djs.djsMainKept(AV_ARGS(), () => true, { docComments: true })).value.mode;
    }

    function view(name: string, text: string): Djs.AstResult {
        return djs.queryAst(join(dir, name), text).result!;
    }

    /** The `.cg` files a fresh `-vcg-ast` compile of the same command line writes, removed once read. */
    function written(): Record<string, string> {
        quiet(() => djs.djsMain(["-vcg-ast", ...AV_ARGS()]));
        const files: Record<string, string> = {};
        for (const name of ["avapp.d", "avlib.d"]) {
            files[name] = readFileSync(join(dir, `${name}.cg`), "utf8");
            rmSync(join(dir, `${name}.cg`));
        }
        return files;
    }

    /** The text of `r` in `text` (lines from 0, UTF-16 characters, end exclusive). */
    function slice(text: string, r: Djs.QueryRange): string {
        const lines = text.split("\n");
        if (r.start.line === r.end.line)
            return lines[r.start.line]!.slice(r.start.character, r.end.character);
        return [lines[r.start.line]!.slice(r.start.character), ...lines.slice(r.start.line + 1, r.end.line),
            lines[r.end.line]!.slice(0, r.end.character)].join("\n");
    }

    const before = (a: Djs.QueryPosition, b: Djs.QueryPosition): boolean =>
        a.line < b.line || (a.line === b.line && a.character <= b.character);

    test("the text is the .cg that -vcg-ast writes, a variable template argument folded", () => {
        // ORACLE: ldmd2 -c -o- -vcg-ast -i writes the same two files; hdrgen folds `width` with `optimize`
        avCompile({ "avlib.d": AVLIB, "avapp.d": AVAPP });
        const app = view("avapp.d", AVAPP).text;
        const lib = view("avlib.d", AVLIB).text;
        expect(written()).toEqual({ "avapp.d": app, "avlib.d": lib });
        expect(app).toContain("\ncount!(param, 3)\n");
        expect(app).toContain("\t\tint __key3 = 0;\n");
    });

    test("after a kept compile that numbered generated names otherwise, the view is a fresh compile's", () => {
        avCompile({ "avlib.d": AVLIB, "avapp.d": AVAPP });
        const first = view("avlib.d", AVLIB);
        // avlib.d is kept: its `foreach` names were numbered by the first compile, before `pre` took two
        expect(avCompile({ "avapp.d": EDITED })).toBe("kept");
        const kept = [view("avapp.d", EDITED), view("avlib.d", AVLIB)];
        quiet(() => djs.djsMain(AV_ARGS(), () => true, { docComments: true }));
        expect(kept).toEqual([view("avapp.d", EDITED), view("avlib.d", AVLIB)]);
        expect(kept[1]!.text).not.toBe(first.text);
        expect(kept[1]!.text.replace(/__(r|key)\d+/g, "__$1")).toBe(first.text.replace(/__(r|key)\d+/g, "__$1"));
        expect(query.queryAmbiguousNames()).toBe(0);
    });

    // gn.d holds the generated names that are not a unit's own `foreach` temporaries: a lambda's template parameter
    // `__T`, numbered by the parse; a templated constructor's `catch` variable `__o`, numbered by the unit that
    // requested its semantic3 (mk's), not by the instance printed; an anonymous class, `generateAnonymousId`
    const GN = `module gn;
alias id = (x) => x;
struct D { ~this() {} }
struct C(T) { D d; this(int x) { if (x) throw new Exception("c"); } }
Object anon() { return new class Object {}; }
int mk() { auto c = C!int(1); return id(1); }
`;
    const GNAPP = "module gnapp;\nimport gn;\nint use() { return mk(); }\n";
    /** gnapp.d with a function before `use` that takes a `__T` (its lambda), an `__r` and a `__key`. */
    const GNEDIT = GNAPP.replace("int use()",
        "int pre(int[] q) { int t; foreach (y; q) t += y; return t + (z => z)(1); }\nint use()");

    /**
     * Compiles gnapp.d with gn.d under -i, then gnapp.d edited, kept, then fresh: the matches of `names` in gn.d's view
     * and in its instances' names after the first compile, after the kept one and after the fresh one.
     */
    function renumbering(names: RegExp): string[][] {
        const gn = join(dir, "gn.d");
        const args = ["-c", "-o-", "-verrors=0", "-i", `-I${dir}`, join(dir, "gnapp.d")];
        const seen = (): string[] => [...djs.queryAst(gn, GN).result!.text.matchAll(names),
            ...JSON.stringify(djs.queryInstances([gn]).result).matchAll(names)].map((x) => x[0]);
        writeFileSync(gn, GN);
        writeFileSync(join(dir, "gnapp.d"), GNAPP);
        quiet(() => djs.djsMainKept(args, () => true));
        const first = seen();
        writeFileSync(join(dir, "gnapp.d"), GNEDIT);
        expect(quiet(() => djs.djsMainKept(args, () => true)).value.mode).toBe("kept");
        const kept = seen();
        expect(query.queryAmbiguousNames()).toBe(0);
        quiet(() => djs.djsMain(args, () => true));
        return [first, kept, seen()];
    }

    test("a parse's generated names, a lambda's `__T` in the instances' names, renumbered as fresh", () => {
        const [first, kept, fresh] = renumbering(/__T\d+/g);
        expect(kept).toEqual(fresh);
        expect(kept.length).toBeGreaterThan(0);
        expect(kept).not.toEqual(first);
    });

    test("a constructor's `catch` variable, made by the unit that requested its semantic3, renumbered", () => {
        const [first, kept, fresh] = renumbering(/catch\(Exception __o\d+\)/g);
        expect([kept, kept.length]).toEqual([fresh, 1]);
        expect(kept).not.toEqual(first);
    });

    test("an anonymous class's name (`generateAnonymousId`), renumbered", () => {
        const [first, kept, fresh] = renumbering(/__anonclass\d+/g);
        expect(kept).toEqual(fresh);
        expect(kept.length).toBeGreaterThan(0);
        expect(kept).not.toEqual(first);
    });

    test("an unchanged kept recompile: `main`'s `mixin _d_cmain!()` among the instances, as a fresh compile has it",
        () => {
            // the module sem1 that analyses `main` appends the mixin after Box!int's instance and before Box!short's;
            // the kept module's replay appends it again there (keep.ts `keepAppend`)
            const OM = "module om;\nimport omlib;\nBox!int x;\nvoid main() { Box!long y; }\nBox!short z;\n";
            writeFileSync(join(dir, "omlib.d"), "module omlib;\nstruct Box(T) { T value; }\n");
            writeFileSync(join(dir, "om.d"), OM);
            const args = ["-c", "-o-", "-verrors=0", `-I${dir}`, join(dir, "om.d")];
            const text = (): string => djs.queryAst(join(dir, "om.d"), OM).result!.text;
            quiet(() => djs.djsMainKept(args, () => true));
            expect(quiet(() => djs.djsMainKept(args, () => true)).value.mode).toBe("kept");
            const kept = text();
            quiet(() => djs.djsMain(args, () => true));
            expect(kept).toBe(text());
            expect(kept.indexOf("\nBox!int\n")).toBeLessThan(kept.indexOf("\nmixin _d_cmain!();"));
            expect(kept.indexOf("\nmixin _d_cmain!();")).toBeLessThan(kept.indexOf("\nBox!short\n"));
        });

    test("an instance a template argument's default requests while its tinst is matched: where fresh puts it", () => {
        // `by!1`'s default `b = Yes.useIt` instantiates `opDispatch!"useIt"` before `by!1` is created; its replay must
        // not read the `minst` the kept `by!1` has not got yet, which put the instance in dfapp.d's members
        const LIB = "module dflib;\nstruct Yes { template opDispatch(string n) { enum opDispatch = true; } }\n"
            + "auto by(int n, bool b = Yes.useIt)(int x) { return b ? x + n : -x; }\nalias byY = by!1;\n";
        const APP = "module dfapp;\nimport dflib;\nint f() { return byY(1); }\n";
        writeFileSync(join(dir, "dflib.d"), LIB);
        writeFileSync(join(dir, "dfapp.d"), APP);
        const args = ["-c", "-o-", "-verrors=0", `-I${dir}`, join(dir, "dfapp.d")];
        const text = (): string => djs.queryAst(join(dir, "dfapp.d"), APP).result!.text;
        quiet(() => djs.djsMainKept(args, () => true));
        expect(quiet(() => djs.djsMainKept(args, () => true)).value.mode).toBe("kept");
        const kept = text();
        quiet(() => djs.djsMain(args, () => true));
        expect(kept).toBe(text());
        expect(kept).not.toContain("opDispatch!");
    });

    test("after a renumbering kept compile, a peek and a hover's Resolved section print the fresh numbers", () => {
        const LIB = `module pklib;
struct R { int i; bool empty() { return i > 2; } int front() { return i; } void popFront() { ++i; } }
int tsum(T)(T[] a) { T s; foreach (x; a) s += x; return s; }
int use2(int[] q) { int t; foreach (y; R()) t += y; return t + tsum!int(q); }
`;
        const APP = "module pkapp;\nimport pklib;\nint use() { return use2([1]); }\n";
        const lib = join(dir, "pklib.d");
        const args = ["-c", "-o-", "-verrors=0", "-i", `-I${dir}`, join(dir, "pkapp.d")];
        writeFileSync(lib, LIB);
        writeFileSync(join(dir, "pkapp.d"), APP);
        const seen = (): string[] => {
            const site = djs.queryExpansionSites(lib, LIB).result!.sites.find((x) => x.title === "tsum!int")!;
            const p = at(LIB, "foreach (y");
            return [djs.queryExpansion(lib, site.range, LIB).result!.text,
                djs.queryHover(lib, p.line, p.character, LIB).result!.markdown];
        };
        quiet(() => djs.djsMainKept(args, () => true));
        const first = seen();
        writeFileSync(join(dir, "pkapp.d"), APP.replace("int use()", "int pre(int[] q) { int t; foreach (y; q) "
            + "t += y; return t; }\nint use()"));
        expect(quiet(() => djs.djsMainKept(args, () => true)).value.mode).toBe("kept");
        const kept = seen();
        expect(query.queryAmbiguousNames()).toBe(0);
        quiet(() => djs.djsMain(args, () => true));
        expect(kept).toEqual(seen());
        expect(kept[0]).toMatch(/__r\d+/);
        expect(kept[1]).toMatch(/__r\d+/);
        expect(kept).not.toEqual(first);
    });

    test("the fold: a constant variable argument folded, another variable and a slice's `$` as written", () => {
        // ORACLE: ldmd2 -c -o- -vcg-ast prints the same: `getAttributes, v` and `getAttributes, 8`, `a[1..__dollar]`
        const FV = `module fv;
int v;
const w = 8;
pragma(msg, __traits(getAttributes, v), __traits(getAttributes, w));
int f(int[] a) { return a[1 .. $][0]; }
`;
        writeFileSync(join(dir, "fv.d"), FV);
        const args = ["-c", "-o-", "-verrors=0", join(dir, "fv.d")];
        quiet(() => djs.djsMainKept(args, () => true));
        const text = djs.queryAst(join(dir, "fv.d"), FV).result!.text;
        quiet(() => djs.djsMain(["-vcg-ast", ...args], () => true));
        expect(text).toBe(readFileSync(join(dir, "fv.d.cg"), "utf8"));
        rmSync(join(dir, "fv.d.cg"));
        expect(text).toContain("pragma (msg, __traits(getAttributes, v), __traits(getAttributes, 8));");
        expect(text).toContain("return a[1..__dollar][0];");
    });

    test("the map: each declaration's print, where it is declared, a function's extent, both ways", () => {
        avCompile({ "avlib.d": AVLIB, "avapp.d": AVAPP });
        const r = view("avapp.d", AVAPP);
        const entry = (name: string): Djs.AstEntry => r.entries.find((e) => e.name === name)!;
        const app = join(dir, "avapp.d");
        const id = (token: string, length: number): Djs.QueryRange => ({ start: at(AVAPP, token),
            end: at(AVAPP, token, 0, length) });
        const use = entry("avapp.use");
        expect([use.kind, slice(r.text, use.ast).split("\n")[0], slice(r.text, use.ast).slice(-2)])
            .toEqual(["function", "int use(int param)", "\n}"]);
        expect(use.source).toEqual({ file: app, range: id("use(", 3) });
        expect(use.extent).toEqual({ start: at(AVAPP, "use("), end: { line: 10, character: 1 } });
        const p = entry("avapp.use.p");
        expect([p.kind, slice(r.text, p.ast)]).toEqual(["local variable", "Point p = 0;"]);
        expect(p.source).toEqual({ file: app,
            range: { start: at(AVAPP, "Point p;", 0, 6), end: at(AVAPP, "Point p;", 0, 7) } });
        expect(before(use.ast.start, p.ast.start) && before(p.ast.end, use.ast.end)).toBe(true);
        const count = entry("avapp.use.count!(param, 3)");   // an instance: where it was instantiated
        expect([count.kind, slice(r.text, count.ast).split("\n")[0], count.source]).toEqual(["template instance",
            "count!(param, 3)", { file: app, range: id("count!", 5) }]);
        expect(entry("avlib").kind).toBe("import");
        // avlib.d, compiled through -i, holds the instances of its templates, and their members are declared there
        const lib = view("avlib.d", AVLIB).entries;
        expect(lib.find((e) => e.name === "avlib.Box!int")!.source).toEqual({ file: app, range: id("Box!int", 3) });
        expect(lib.find((e) => e.name === "avlib.Box!int.Box.get")!.source)
            .toEqual({ file: join(dir, "avlib.d"), range: { start: at(AVLIB, "get("), end: at(AVLIB, "get(", 0, 3) } });
        // sorted, a container before what it holds
        expect(r.entries.every((e, i) => i === 0 || before(r.entries[i - 1]!.ast.start, e.ast.start))).toBe(true);
        expect(r.entries.indexOf(use)).toBeLessThan(r.entries.indexOf(p));
        // from the source to the view: the entries of this file whose extent holds a cursor in `use`'s body
        const cursor = at(AVAPP, "b.get()");
        expect(r.entries.filter((e) => e.source?.file === app && e.extent !== null && before(e.extent.start, cursor)
            && before(cursor, e.extent.end)).map((e) => e.name)).toEqual(["avapp.use"]);
    });

    test("extents from a function's location: destructors, postblits, literals, static constructors, invariants",
        () => {
            const EX = `module ex;
static this() { int a = 1; }
shared static ~this() { }
struct S { int x; invariant { assert(x >= 0); } ~this() { } this(this) { } }
int g() { auto dg = delegate int() { return 1; }; return dg() + (q => q + 1)(2); }
void h() { S s; s.__dtor(); }
`;
            writeFileSync(join(dir, "ex.d"), EX);
            quiet(() => djs.djsMainKept(["-c", "-o-", "-verrors=0", join(dir, "ex.d")], () => true));
            const r = djs.queryAst(join(dir, "ex.d"), EX).result!;
            const extent = (name: string): string => slice(EX, r.entries.find((e) => e.name === name)!.extent!);
            expect(["ex.static this", "ex._sharedStaticDtor_L3_C1", "ex.S.~this", "ex.S.this(this)",
                "ex.g.__dgliteral_L5_C21"].map(extent)).toEqual(["static this() { int a = 1; }",
                "shared static ~this() { }", "~this() { }", "this(this) { }", "delegate int() { return 1; }"]);
            expect(extent("ex.S.invariant")).toBe("invariant { assert(x >= 0); }");
            expect(r.entries.filter((e) => e.kind === "function" && e.name.startsWith("ex.g.__lambda"))
                .map((e) => slice(EX, e.extent!))).toContain("q => q + 1");
            // a destructor's declaration is its `this`, as queryDefinition answers at a call of it
            const dtor = r.entries.find((e) => e.name === "ex.S.~this")!;
            expect(slice(EX, dtor.source!.range)).toBe("this");
            expect(slice(EX, djs.queryDefinition(join(dir, "ex.d"), at(EX, "__dtor").line, at(EX, "__dtor").character,
                EX).result!.range)).toBe("this");
        });

    test("an anonymous class in `typeof` in an instance, kept and replayed: the view a fresh compile gives", () => {
        // the analysis appends the class to the instance's members; a replay appends it only where it lacks it
        const AL = "module al;\nint mk(T)() { alias C = typeof(new class Object { T t; }); return C.sizeof; }\n";
        const AA = "module aa;\nimport al;\nint use() { return mk!int(); }\n";
        writeFileSync(join(dir, "al.d"), AL);
        writeFileSync(join(dir, "aa.d"), AA);
        const args = ["-c", "-o-", "-verrors=0", "-i", `-I${dir}`, join(dir, "aa.d")];
        quiet(() => djs.djsMainKept(args, () => true));
        writeFileSync(join(dir, "aa.d"), `${AA}int more() { return use(); }\n`);
        expect(quiet(() => djs.djsMainKept(args, () => true)).value.mode).toBe("kept");
        expect(quiet(() => djs.djsMainKept(args, () => true)).value.mode).toBe("kept");
        const kept = djs.queryAst(join(dir, "al.d"), AL).result!;
        quiet(() => djs.djsMain(args, () => true));
        expect(kept).toEqual(djs.queryAst(join(dir, "al.d"), AL).result!);
    });

    test("the instances of the templates a file declares, each where the compile created it", () => {
        avCompile({ "avlib.d": AVLIB, "avapp.d": AVAPP });
        const r = djs.queryInstances([join(dir, "avlib.d"), join(dir, "nothere.d")]).result!;
        expect(r.templates.map((t) => [t.name, t.kind, t.instances.map((i) => i.title)])).toEqual([
            ["avlib.Box(T)", "struct", ["Box!int", "Box!string"]],
            ["avlib.count(Args...)", "template", ["count!(param, 3)"]],
        ]);
        expect(r.templates[0]!.range).toEqual({ start: at(AVLIB, "Box("), end: at(AVLIB, "Box(", 0, 3) });
        expect(r.templates[0]!.instances[1]).toEqual({ title: "Box!string", file: join(dir, "avapp.d"),
            range: { start: at(AVAPP, "Box!string"), end: at(AVAPP, "Box!string", 0, 3) } });
        expect(djs.queryInstances([join(dir, "avapp.d")]).result!.templates).toEqual([]);
    });

    const IMA = "module ima;\nimport imb;\nint a() { return b(); }\n";
    const IMB = "module imb;\nimport ima, imc;\nint b() { return c(); }\nint b2() { return a(); }\n";
    const IMC = "module imc;\nint c() { return 1; }\n";

    /** Compiles ima.d with `-i` but imc.d, which is only imported. */
    function imCompile(): void {
        for (const [name, text] of [["ima.d", IMA], ["imb.d", IMB], ["imc.d", IMC]] as const)
            writeFileSync(join(dir, name), text);
        quiet(() => djs.djsMainKept(["-c", "-o-", "-verrors=0", "-i", "-i=-imc", `-I${dir}`, join(dir, "ima.d")],
            () => true));
    }

    test("the modules loaded: their role, size and imports, the root first, a cycle", () => {
        imCompile();
        const mods = djs.queryImports().result!.modules;
        const m = (name: string): Djs.ImportModule => mods.find((x) => x.name === name)!;
        const names = (x: Djs.ImportModule): string[] => x.imports.map((i) => mods[i]!.name);
        expect(mods[0]!.name).toBe("ima");
        expect(["ima", "imb", "imc", "object"].map((n) => m(n).kind)).toEqual(["root", "included", "imported",
            "imported"]);
        expect([m("ima").file, m("ima").size]).toEqual([join(dir, "ima.d"), IMA.length]);
        expect([names(m("ima")), names(m("imb")), names(m("imc"))]).toEqual([["object", "imb"],
            ["object", "ima", "imc"], ["object"]]);
        expect(m("ima").cycle).not.toBeNull();
        expect(m("imb").cycle).toBe(m("ima").cycle);
        expect(m("imc").cycle).toBeNull();
        expect(names(m("object"))).not.toContain("object");   // its implicit `import object` is not an edge
    });

    test("imports: chosen branches, `static foreach`, mixins, aggregates; not a function's; unreached by name", () => {
        const IA = `module ia;
version (all) import ib1; else import ib0;
static if (true) import ib2;
static foreach (m; ["ib3"]) mixin("import " ~ m ~ ";");
mixin("import ib4;");
mixin template MT() { import ib5; }
mixin MT;
struct Agg { import ib6; }
int f() { import iz; import iy; return 1; }
`;
        writeFileSync(join(dir, "ia.d"), IA);
        for (const n of ["ib0", "ib1", "ib2", "ib3", "ib4", "ib5", "ib6", "iy", "iz"])
            writeFileSync(join(dir, `${n}.d`), `module ${n};\n`);
        quiet(() => djs.djsMainKept(["-c", "-o-", "-verrors=0", `-I${dir}`, join(dir, "ia.d")], () => true));
        const mods = djs.queryImports().result!.modules;
        const at = (name: string): number => mods.findIndex((x) => x.name === name);
        expect(mods[0]!.imports.map((i) => mods[i]!.name)).toEqual(["object", "ib1", "ib2", "ib3", "ib4", "ib5",
            "ib6"]);
        expect(at("ib0")).toBe(-1);
        // iy and iz, loaded by f's imports only, come after every module the root reaches, by name
        const reached = Math.max(...["ib1", "ib2", "ib3", "ib4", "ib5", "ib6"].map(at));
        expect(reached < at("iy") && at("iy") < at("iz")).toBe(true);
    });

    test("misses: a file outside the compile, another text, a module only imported, no compile", () => {
        imCompile();
        expect(djs.queryAst(join(dir, "other.d"), "")).toEqual({ result: null, stale: false,
            reason: "the file is not in the last compile" });
        expect(djs.queryAst(join(dir, "ima.d"), `${IMA}\n`)).toEqual({ result: null, stale: true,
            reason: djs.STALE_REASON });
        expect(djs.queryAst(join(dir, "imc.d"), IMC).result).toBeNull();
        expect(djs.queryAst(join(dir, "imc.d"), IMC))
            .toMatchObject({ reason: expect.stringMatching(/^the module is imported, not compiled/) });
        djs.dropKeptState();
        const none = { result: null, stale: false, reason: "no compile to read" };
        expect([djs.queryImports(), djs.queryInstances([join(dir, "ima.d")])]).toEqual([none, none]);
    });

    test("the three queries between kept compiles: every swap undone, the next compile's output a fresh one's",
        async () => {
            avCompile({ "avlib.d": AVLIB, "avapp.d": AVAPP });
            expect(avCompile({ "avapp.d": EDITED })).toBe("kept");   // the view spells generated names anew
            const { global } = await import("./dmd/globals.js");
            const { Identifier } = await import("./dmd/identifier.js");
            const { FuncDeclaration } = await import("./dmd/func.js");
            const { TemplateInstance } = await import("./dmd/dtemplate.js");
            const swapped = (): unknown[] => [Identifier.prototype.toChars, Identifier.prototype.toString,
                FuncDeclaration.prototype.accept, TemplateInstance.prototype.accept];
            const slots = swapped();
            const errors = global.errors;
            view("avapp.d", EDITED);
            view("avlib.d", AVLIB);
            djs.queryInstances([join(dir, "avlib.d")]);
            djs.queryImports();
            expect([swapped(), global.errors]).toEqual([slots, errors]);
            const third = EDITED.replace("int use(", "deprecated int old() { return 1; }\n"
                + "int pre2() { return old() + sum([1]) + pre([2]); }\n"
                + "pragma(msg, count!(1, width), Box!long.stringof);\nint use(");
            writeFileSync(join(dir, "avapp.d"), third);
            const r = quiet(() => djs.djsMainKept(AV_ARGS(), () => true, { docComments: true }));
            expect(r.value.mode).toBe("kept");
            expect(r.out).toContain("is deprecated");
            const f = quiet(() => djs.djsMain(AV_ARGS(), () => true, { docComments: true }));
            expect(`${r.value.status}\n${r.out}`).toBe(`${f.value}\n${f.out}`);
        });
});

describe("member completion after a dot", () => {
    const CPLIB = `module cplib;
/// Library summary line.
/// More text.
int libFun(int a) { return a; }
private int hidden() { return 1; }
/// Doubles a point's x.
int doubleX(T)(T p) { return p.x * 2; }
enum Color { red, green, blue }
`;
    const CP = `module cp;
import io = cplib;
import cplib : doubleX;

/// A point.
struct Pt {
    /// The x coordinate.
    int x;
    int y;
    private int secret;
    static int count;
    enum Zero = 0;
    int len() const { return x + y; }
    int len(int k) const { return k; }
    @property int area() const { return x * y; }
    void touch() { this.x = 1; }
}
class Base { int baseField; void baseMethod() {} }
class Derived : Base { int own; void m() { super.baseMethod(); } }
int norm(Pt p) { return p.x; }
int other(int z) { return z; }
Pt make() { return Pt(); }
int use() {
    Pt p;
    Derived d = new Derived;
    Pt[] arr = [p];
    auto c = io.Color.red;
    int s = p.x + d.baseField + io.libFun(1) + p.norm + make().x + arr[0].x + p.doubleX + Pt.count
        + cast(int) arr.length;
    // p.x in a comment
    return s + c;
}
`;

    beforeAll(() => {
        compile({ "cplib.d": CPLIB, "cp.d": CP }, "cp.d", true);
    });

    /** The completion right after the `nth` occurrence of `token` (which ends with the `.`) in `text`. */
    function complete(text: string, token: string, nth = 0): Djs.CompletionAnswer {
        return djs.queryCompletion(join(dir, "cp.d"), text, at(text, token, nth, token.length));
    }

    /** The items as `group label kind`, or the miss's reason. */
    function labels(a: Djs.CompletionAnswer): string[] {
        return a.result === null ? [`miss: ${a.reason}`] : a.result.items.map((i) => `${i.group} ${i.label} ${i.kind}`);
    }

    const BUILTIN = ["2 alignof property", "2 init property", "2 mangleof property", "2 sizeof property",
        "2 stringof property"];

    test("a struct's members, a UFCS function and a template's instance, the built-in properties", () => {
        const a = complete(CP, "p.", 1);
        expect(labels(a)).toEqual(["0 Zero constant", "0 area property", "0 count variable", "0 len method",
            "0 secret field", "0 touch method", "0 x field", "0 y field", "1 doubleX function", "1 norm function",
            ...BUILTIN, "2 tupleof property"]);
        const items = new Map(a.result!.items.map((i) => [i.label, i]));
        expect(items.get("x")).toMatchObject({ detail: "int x", documentation: "The x coordinate." });
        expect(items.get("len")!.detail).toBe("const int len() (+1 overloads)");
        // the instance's signature, with the attributes its analysis inferred
        expect(items.get("doubleX")).toMatchObject({ detail: "pure nothrow @nogc @safe int doubleX(Pt p)",
            documentation: "Doubles a point's x." });
        expect(items.get("init")!.detail).toBe("Pt");
        expect(a.result!.range).toEqual({ start: at(CP, "p.x", 1, 2), end: at(CP, "p.x", 1, 2) });
        expect(a.result!.moved).toBe(false);
        expect(labels(complete(CP, "{ return p.")).filter((l) => l.startsWith("0 x"))).toEqual(["0 x field"]);
    });

    test("a class with its base class's members; `this.` and `super.`; a type's static members", () => {
        // object.Object's members too; not object.d's `setSameMutex(shared Object, ...)`: a plain value is not shared
        expect(labels(complete(CP, "d."))).toEqual(["0 Monitor interface", "0 baseField field", "0 baseMethod method",
            "0 factory method", "0 m method", "0 opCmp method", "0 opEquals method", "0 own field", "0 toHash method",
            "0 toString method", "2 alignof property", "2 classinfo property", ...BUILTIN.slice(1),
            "2 tupleof property"]);
        expect(labels(complete(CP, "this.")).filter((l) => l.startsWith("0 "))).toContain("0 secret field");
        expect(labels(complete(CP, "super.")).filter((l) => l.startsWith("0 b"))).toEqual(["0 baseField field",
            "0 baseMethod method"]);
        expect(labels(complete(CP, "super.")).filter((l) => l.startsWith("0 o"))).not.toContain("0 own field");
        expect(labels(complete(CP, "Pt.")).filter((l) => l.startsWith("0 "))).toEqual(["0 Zero constant",
            "0 count variable"]);
    });

    test("a module through a renamed import: its public members; an enum's members", () => {
        const io = complete(CP, "io.", 1);
        expect(labels(io)).toEqual(["0 Color enum", "0 doubleX function", "0 libFun function"]);
        expect(io.result!.items.find((i) => i.label === "libFun"))
            .toMatchObject({ detail: "int libFun(int a)", documentation: "Library summary line. More text." });
        expect(labels(complete(CP, "io.Color."))).toEqual(["0 blue enumMember", "0 green enumMember",
            "0 red enumMember", "2 alignof property", "2 init property", "2 mangleof property", "2 max property",
            "2 min property", "2 sizeof property", "2 stringof property"]);
    });

    test("a `()` link and a `[...]` link: the function's return type, the element type", () => {
        expect(labels(complete(CP, "make().")).filter((l) => l.startsWith("0 x"))).toEqual(["0 x field"]);
        expect(labels(complete(CP, "arr[0].")).filter((l) => l.startsWith("0 x"))).toEqual(["0 x field"]);
        expect(labels(complete(CP, "arr.")).filter((l) => l.startsWith("2 "))).toEqual(["2 alignof property",
            "2 dup property", "2 idup property", "2 init property", "2 length property", "2 mangleof property",
            "2 ptr property", "2 sizeof property", "2 stringof property"]);
    });

    test("misses: an unresolved name, a comment, a number", () => {
        const typed = CP.replace("    // p.x in a comment", "    nothere.");
        expect(labels(complete(typed, "nothere."))).toEqual(
            ["miss: the expression before the `.` is not resolved: `nothere` is not found"]);
        expect(labels(complete(CP, "// p."))).toEqual(["miss: the `.` is in a comment or a literal"]);
        const number = CP.replace("    // p.x in a comment", "    auto f = 1.");
        expect(labels(complete(number, "= 1."))).toEqual(["miss: the `.` follows a number"]);
        expect(labels(djs.queryCompletion(join(dir, "nope.d"), CP, { line: 0, character: 0 })))
            .toEqual(["miss: the file is not in the last compile"]);
    });

    test("a request whose text has the dot typed after the compile: moved, the typed name's range", () => {
        const typed = CP.replace("    // p.x in a comment", "    auto q = p.le");
        const a = djs.queryCompletion(join(dir, "cp.d"), typed, at(typed, "p.le", 0, 4));
        expect(a.result!.moved).toBe(true);
        expect(a.result!.range).toEqual({ start: at(typed, "p.le", 0, 2), end: at(typed, "p.le", 0, 4) });
        expect(a.result!.items.map((i) => i.label)).toContain("len");
        const local = CP.replace("    // p.x in a comment", "    c.");
        expect(labels(complete(local, "    c.")).filter((l) => l.startsWith("2 m"))).toEqual(["2 mangleof property",
            "2 max property", "2 min property"]);
    });
});

describe("completion without a dot: the names in scope", () => {
    const SCLIB = `module sclib;
/// Library summary line.
int libFun(int a) { return a; }
private int hidden() { return 1; }
public import sccore;
`;
    const SCCORE = `module sccore;
int coreFun() { return 0; }
`;
    const SC = `module sc;
import sclib;
import io = sclib;

int global;
/// A point.
struct Pt {
    int x;
    static int count;
    int len() const { return x + 0; }
    int len(int k) const { return k; }
    void touch() { x = 1; }
    static int make() { return count; }
}
class Base { int baseField; }
class Derived : Base { int own; void m() { own = 1; } }
int blocks(int a) {
    int b;
    { int inner; inner = 1; }
    foreach (i; 0 .. 3) { int loop = i; }
    if (auto q = a) { b = q; }
    int after;
    int nested(int n) { return n + b; }
    return after + nested(1);
}
T twice(T)(T v) { return v * 2; }
int user() {
    import sccore : coreFun;
    import cio = sccore;
    return twice(2) + coreFun() + global + cio.coreFun();
}
int broken(int a) {
    int first = a;
    return first + nowhere;
}
void never(T)(T t) { int z = 0; }
`;

    beforeAll(() => {
        compile({ "sclib.d": SCLIB, "sccore.d": SCCORE, "sc.d": SC }, "sc.d", true);
    });

    /** The completion at the end of the `nth` occurrence of `token` in `text`, `back` characters before it. */
    function complete(text: string, token: string, nth = 0, back = 0): Djs.CompletionAnswer {
        return djs.queryCompletion(join(dir, "sc.d"), text, at(text, token, nth, token.length - back));
    }

    /** The items of `groups` as `group label kind`, or the miss's reason. */
    function labels(a: Djs.CompletionAnswer, groups: readonly number[] = [0, 1, 2]): string[] {
        return a.result === null ? [`miss: ${a.reason}`]
            : a.result.items.filter((i) => groups.includes(i.group)).map((i) => `${i.group} ${i.label} ${i.kind}`);
    }

    const MODULE = ["2 Base class", "2 Derived class", "2 Pt struct", "2 blocks function", "2 broken function",
        "2 global variable", "2 io module", "2 never function", "2 object module", "2 sclib module", "2 twice function",
        "2 user function"];

    test("locals declared before, in a block still open; parameters, a nested function; the module's names", () => {
        const a = complete(SC, "return after", 0, 5);
        expect(labels(a)).toEqual(["0 a variable", "0 after variable", "0 b variable", "0 nested function",
            ...MODULE]);
        expect(a.result!.range).toEqual({ start: at(SC, "after +"), end: at(SC, "after +") });
        expect(a.result!.moved).toBe(false);
        expect(labels(complete(SC, "{ int loop = i", 0, 1), [0])).toEqual(["0 a variable", "0 b variable",
            "0 i variable", "0 loop variable"]);
        expect(labels(complete(SC, "b = q", 0, 1), [0])).toEqual(["0 a variable", "0 b variable", "0 q variable"]);
        expect(labels(complete(SC, "return n + b", 0, 1), [0])).toEqual(["0 a variable", "0 after variable",
            "0 b variable", "0 n variable", "0 nested function"]);
        expect(labels(complete(SC, "return v", 0, 1), [0])).toEqual(["0 T typeParameter", "0 v variable"]);
        const items = new Map(a.result!.items.map((i) => [i.label, i]));
        expect(items.get("b")).toMatchObject({ detail: "int b", group: 0 });
        expect(items.get("Pt")).toMatchObject({ documentation: "A point.", group: 2 });
    });

    test("the imported modules' public names, their public imports', a function-local import's", () => {
        const imported = labels(complete(SC, "return after", 0, 5), [3]);
        expect(imported).toEqual(expect.arrayContaining(["3 libFun function", "3 coreFun function", "3 Object class"]));
        expect(imported.filter((l) => l.includes("hidden"))).toEqual([]);
        const lib = complete(SC, "return after", 0, 5).result!.items.find((i) => i.label === "libFun");
        expect(lib).toMatchObject({ detail: "int libFun(int a)", documentation: "Library summary line." });
        expect(labels(complete(SC, "return twice", 0, 5), [0, 1])).toEqual(["0 cio module"]);
        expect(labels(complete(SC, "return twice", 0, 5), [3])).toContain("3 coreFun function");
    });

    test("the members of `this`, by its qualifier; a static member function's; a class's with its bases'", () => {
        const members = ["1 count variable", "1 len method", "1 make method", "1 touch method", "1 x field"];
        expect(labels(complete(SC, "{ x = 1", 0, 5), [1])).toEqual(members);
        expect(labels(complete(SC, "const { return x", 0, 1), [1]))
            .toEqual(members.filter((l) => !l.includes("touch")));
        expect(labels(complete(SC, "{ return count", 0, 5), [1])).toEqual(["1 count variable", "1 make method"]);
        expect(labels(complete(SC, "{ own = 1", 0, 7), [1])).toEqual(["1 Monitor interface", "1 baseField field",
            "1 factory method", "1 m method", "1 opCmp method", "1 opEquals method", "1 own field",
            "1 toHash method", "1 toString method"]);
    });

    test("a body with errors: its locals by their location; a name typed after the compile; the misses", () => {
        expect(labels(complete(SC, "return first", 0, 5), [0])).toEqual(["0 a variable", "0 first variable"]);
        const typed = SC.replace("    int after;", "    gl\n    int after;");
        const t = djs.queryCompletion(join(dir, "sc.d"), typed, at(typed, "    gl", 0, 6));
        expect(t.result!.moved).toBe(true);
        expect(t.result!.range).toEqual({ start: at(typed, "    gl", 0, 4), end: at(typed, "    gl", 0, 6) });
        expect(labels(t, [0])).toEqual(["0 a variable", "0 b variable"]);
        expect(labels(t, [2])).toContain("2 global variable");
        expect(labels(complete(SC, "/// A po"))).toEqual(["miss: the position is in a comment or a literal"]);
        const number = SC.replace("    int after;", "    int after = 12");
        expect(labels(complete(number, "after = 12"))).toEqual(["miss: the position is in a number"]);
        expect(labels(complete(SC, "int z = 0", 0, 1)))
            .toEqual(["miss: the function at the position was not analysed"]);
    });
});

describe("member completion: scopes, chains, receivers", () => {
    /** Compiles `files` (kept, the knob on), `root` from `texts[root]` when given: the status. */
    function build(files: Record<string, string>, root: string, texts: Record<string, string> = {}): number {
        for (const [name, text] of Object.entries(files))
            writeFileSync(join(dir, name), text);
        const args = ["-c", "-o-", "-verrors=0", `-I${dir}`, join(dir, root)];
        const map = new Map(Object.entries(texts).map(([name, text]) => [join(dir, name), text]));
        return quiet(() => djs.djsMainKept(args, () => true, { docComments: true, texts: map })).value.status;
    }

    /** The labels of group `group` after the `nth` `token` (ending with the `.`) of `text` in `file`, or the miss. */
    function names(file: string, text: string, token: string, group = 0, nth = 0): string[] {
        const a = djs.queryCompletion(join(dir, file), text, at(text, token, nth, token.length));
        return a.result === null ? [`miss: ${a.reason}`]
            : a.result.items.filter((i) => i.group === group).map((i) => i.label);
    }

    const NR = "the expression before the `.` is not resolved: ";

    test("a buffer half-typed before its block's last `}`: the body runs to the text's end, its index answers", () => {
        const disk = "module lg;\nstruct S { int alpha; int beta() { return 1; } }\n"
            + "void f() {\n    S s;\n    int y = 2;\n}\n";
        const buffer = disk.replace("    int y = 2;\n", "    int y = s.\n");
        build({ "lg.d": disk }, "lg.d", { "lg.d": buffer });
        expect(names("lg.d", buffer, "int y = s.")).toEqual(["alpha", "beta"]);
    });

    test("locals by position: two of one name in disjoint blocks, a global shadowed by a later local", () => {
        const LP = `module lp;
struct A { int alpha; }
struct B { int beta; }
S x;
struct S { int sfield; }
void f(A[] as, B[] bs) {
    foreach (e; as) { e.alpha++; }
    foreach (e; bs) {
        e.beta++;
    }
}
void g() {
    x.sfield++;
    int x = 3;
}
`;
        build({ "lp.d": LP }, "lp.d");
        // the analysis resolved each written `e` and `x`: the index has them
        expect(names("lp.d", LP, "        e.")).toEqual(["beta"]);
        expect(names("lp.d", LP, "    x.")).toEqual(["sfield"]);
        // typed after the compile: the function declares two `e`, and the local `x` comes after the dot
        const typed = LP.replace("        e.beta++;", "        e.beta++;\n        e.").replace("    x.sfield++;",
            "    x.\n    x.sfield++;");
        expect(names("lp.d", typed, "        e.", 0, 1)).toEqual([`miss: ${NR}\`e\` names several locals of \`lp.f\``]);
        expect(names("lp.d", typed, "    x.")).toEqual(["sfield"]);
    });

    test("locals in a body with errors (the walk sees none): by their own location, a name declared twice a miss",
        () => {
            const EB = `module eb;
struct P { int x; string name; }
struct M { int f; }
void f() {
    const P cp;
    cp.x = cp.x;
    int k;
    { P w; w.x = 1; }
    { M w; w.f = 1; }
}
`;
            build({ "eb.d": EB }, "eb.d");
            for (const block of ["{ P w; w.x = 1; }", "{ M w; w.f = 1; }"]) {
                const typed = EB.replace(block, block.replace(" }", " w. }"));
                expect(names("eb.d", typed, "= 1; w.")).toEqual([`miss: ${NR}\`w\` names several locals of \`eb.f\``]);
            }
            const one = EB.replace("    int k;", "    int k;\n    cp.");
            expect(names("eb.d", one, "    cp.")).toEqual(["name", "x"]);
            const loops = EB.replace("    int k;", "    int k;\n    foreach (e; [P()]) { e.x++; }\n"
                + "    foreach (e; [M()]) { e.f++; e. }");
            build({ "eb.d": EB }, "eb.d", { "eb.d": loops.replace(" e. }", " }") });
            expect(names("eb.d", loops, "e.f++; e.")).toEqual([`miss: ${NR}\`e\` names several locals of \`eb.f\``]);
        });

    test("an out parameter after `if (c) t.x = ...`: its hit, its walk entry, never the text's count", () => {
        const OP = `module op;
struct D { int x; int y; }
bool decode(int v, out D t) {
    if (v > 0) t.x = v;
    t.y = 2;
    return true;
}
bool broken(int v, out D t) {
    if (v > 0) t.x = v;
    t.y = "no";
    return true;
}
`;
        build({ "op.d": OP }, "op.d");
        expect(names("op.d", OP, "    t.")).toEqual(["x", "y"]);
        // a line inserted above: the link is in the unchanged end of the text, its hit still answers
        expect(names("op.d", `// moved\n${OP}`, "    t.")).toEqual(["x", "y"]);
        // in the body with an error the walk has the parameter, not the hits
        const typed = OP.replace("    t.y = \"no\";", "    t.y = \"no\";\n    t.");
        expect(names("op.d", typed, "    t.", 0, 2)).toEqual(["x", "y"]);
        expect(names("op.d", `// moved\n${OP}`, "    t.", 0, 1)).toEqual(["x", "y"]);
    });

    test("receivers: a qualified copy without mutable indirections; methods by their `this` qualifier", () => {
        const RQ = `module rq;
struct P { int x; string name; }
struct Q { int* p; }
struct M {
    int f;
    void mut() {}
    void con() const {}
    void wil() inout {}
    void imm() immutable {}
    void tc()() const {}
    static void st() {}
}
void byValP(P p) {}
void refConstP(ref const P p) {}
void byValQ(Q q) {}
void f() {
    const P cp;
    const Q cq;
    M m;
    const M cm;
    immutable M im;
    cp.byValP(); cq.x; m.f = 1; cm.f; im.f;
}
`;
            build({ "rq.d": RQ }, "rq.d");
            expect(names("rq.d", RQ, "cp.", 1)).toEqual(["byValP", "refConstP"]);
            expect(names("rq.d", RQ, "cq.", 1)).toEqual([]);
            expect(names("rq.d", RQ, " m.")).toEqual(["con", "f", "mut", "st", "tc", "wil"]);
            expect(names("rq.d", RQ, "cm.")).toEqual(["con", "f", "st", "tc", "wil"]);
            expect(names("rq.d", RQ, "im.")).toEqual(["con", "f", "imm", "st", "tc", "wil"]);
        });

    test("a chain across lines and comments; a literal before the dot; a leading dot after a statement", () => {
        const CH = `module ch;
struct P { Q q; }
struct Q { int qq; }
R q;
struct R { int rr; }
int f() {
    P p;
    int v = p
        .q.qq;
    return v;
}
`;
        build({ "ch.d": CH }, "ch.d");
        expect(names("ch.d", CH, "        .q.")).toEqual(["qq"]);
        const typed = CH.replace("    return v;", "    p /* a comment */\n        .q.\n    return v;");
        expect(names("ch.d", typed, "*/\n        .q.")).toEqual(["qq"]);
        const lit = CH.replace("    return v;", "    \"q\".\n    return v;");
        expect(names("ch.d", lit, "\"q\".")).toEqual([`miss: ${NR}a literal before the \`.\``]);
        const lead = CH.replace("    return v;", "    v = 1;\n    .q.\n    return v;");
        expect(names("ch.d", lead, "    .q.", 0, 1)).toEqual(["rr"]);
    });

    test("UFCS: D's qualifier conversions, `ref` binding, a copy of a basic type", () => {
        const UF = `module uf;
struct H { int* p; }
void mutRef(ref H h) {}
void constRef(ref const H h) {}
void byVal(H h) {}
void constVal(const H h) {}
class C { int cf; }
void takeC(C c) {}
void takeImm(immutable(int)[] a) {}
void takeConst(const(int)[] a) {}
int twice(int v) { return v * 2; }
void f() {
    const H ch;
    H mh;
    const C cc = new C;
    int[] ia;
    const int ci = 1;
    auto o = new C;
    ch.constRef(); mh.mutRef(); ia.takeConst(); o.takeC(); ci.twice;
}
`;
        build({ "uf.d": UF }, "uf.d");
        expect(names("uf.d", UF, "ch.", 1)).toEqual(["constRef", "constVal"]);
        expect(names("uf.d", UF, "mh.", 1)).toEqual(["byVal", "constRef", "constVal", "mutRef"]);
        expect(names("uf.d", UF, "ia.", 1)).toEqual(["takeConst"]);
        expect(names("uf.d", UF, "o.", 1)).toEqual(["takeC"]);
        expect(names("uf.d", UF, "ci.", 1)).toEqual(["twice"]);
        const typed = UF.replace("    ch.constRef();", "    cc.\n    ch.constRef();");
        expect(names("uf.d", typed, "    cc.", 1)).toEqual([]);
    });

    test("a function template's body: answered when its instances agree, else a miss", () => {
        const TB = `module tb;
struct Inner { int x; }
void show(T)(T v) {
    auto y = v;
}
void one(T)(T v) {
    auto y = v;
}
void f() {
    show(Inner(1)); show(42); one(Inner(2));
}
`;
        build({ "tb.d": TB }, "tb.d");
        const typed = TB.replace("    auto y = v;", "    auto y = v;\n    v.");
        expect(names("tb.d", typed, "    v.")).toEqual([
            "miss: the expression before the `.` has different types in the template's instances"]);
        const single = TB.replace("void one(T)(T v) {\n    auto y = v;", "void one(T)(T v) {\n    auto y = v;\n    v.");
        expect(names("tb.d", single, "    v.")).toEqual(["x"]);
    });

    test("a function link only when callable with no arguments, and not `void`", () => {
        const FN = `module fn;
struct S { int a; }
S make() { return S(); }
S withDefault(int k = 1) { return S(); }
S needsArgs(int a, int b) { return S(); }
void main() {
    int k = 0;
}
`;
        build({ "fn.d": FN }, "fn.d");
        const typed = (line: string): string => FN.replace("    int k = 0;", `    int k = 0;\n    ${line}`);
        expect(names("fn.d", typed("make."), "make.")).toEqual(["a"]);
        expect(names("fn.d", typed("withDefault()."), "withDefault().")).toEqual(["a"]);
        expect(names("fn.d", typed("needsArgs."), "needsArgs.")).toEqual([`miss: ${NR}\`needsArgs\` needs arguments`]);
        expect(names("fn.d", typed(".main."), ".main.")).toEqual([`miss: ${NR}\`main\` returns \`void\``]);
    });

    test("a package's package.d members; an enum value's `min` and `max`; a `const` receiver's methods", () => {
        const PK = `module pk;
import std.algorithm;
enum Color { red, green }
struct T { int v; int get() const { return v; } void set(int x) { v = x; } static int make() { return 1; } }
void f() {
    auto c = Color.red;
    const T ct;
    int k = 0;
}
`;
        build({ "pk.d": PK }, "pk.d");
        const typed = (line: string): string => PK.replace("    int k = 0;", `    int k = 0;\n    ${line}`);
        const algo = names("pk.d", typed("std.algorithm."), "std.algorithm.");
        expect(algo).toContain("map");
        expect(algo).toContain("iteration");
        const c = djs.queryCompletion(join(dir, "pk.d"), typed("c."), at(typed("c."), "    c.", 0, 6));
        expect(c.result!.items.filter((i) => i.label === "min" || i.label === "max").map((i) => i.detail))
            .toEqual(["Color", "Color"]);
        expect(names("pk.d", typed("ct."), "    ct.")).toEqual(["get", "make", "v"]);
    });
});

const NV = `module nv;

import lib;
import lib : mul;

/// A shape.
struct Shape {
    int w;
    int h;
    this(int s) { w = s; h = s; }
    int area() const { return w * h; }
    @property int width() const { return w; }
}

class Base { void run() {} }
interface Named { string name(); }
class Derived : Base, Named { override string name() { return "d"; } }

enum Color { red, green }
enum { loose = 1 }
enum limit = 10;
alias Size = int;

struct Pair(T) {
    T first;
    T second;
    T sum() { return first + second; }
}
/// Twice \`x\`.
T twice(T)(T x) { return x * 2; }

template Kit(T) {
    alias Item = T;
    enum size = cast(int) T.sizeof;
}

mixin("int mixedVar = 1;");

version (none) { int hidden; } else { int shown; }

/// Grows a shape.
int grow(Shape s, int by) { return s.area + by; }
/// Grows a number.
int grow(int a) { return a; }

int outer(int a) {
    int inner(int b) { return a + b; }
    struct Local { int z; }
    return inner(a);
}

unittest { assert(true); }

int main() {
    Shape s = Shape(2);
    int r = s.grow(3) + grow(1) + outer(s.w) + twice(4);
    Pair!int p;
    p.first = r;
    return p.sum() + Kit!int.size + limit + mixedVar + add(1, 2) + mul(2, 3) + loose + Color.red;
}

enum code = q{ int fromMixin() { return limit; } };
mixin(code);

struct Money(T) {
    T c;
    /// Adds two amounts.
    Money opBinary(string op : "+")(Money o) const { return Money(c + o.c); }
}
int spend() { Money!int a, b; return (a + b).c; }
`;

/** An outline as indented lines: kind, name, detail, the selection's start. */
function outline(symbols: readonly Djs.DocumentSymbol[], depth = 0): string[] {
    return symbols.flatMap((s) => [
        `${"  ".repeat(depth)}${s.kind} ${s.name}${s.detail !== "" ? ` [${s.detail}]` : ""} `
            + `${s.selectionRange.start.line}:${s.selectionRange.start.character}`,
        ...outline(s.children, depth + 1)]);
}

describe("navigation: the outline", () => {
    beforeAll(() => {
        compile({ "lib.d": LIB, "nv.d": NV }, "nv.d", true);
    });

    test("the declarations as a tree: aggregates, templates, nested functions, mixins, the chosen branch", () => {
        const a = djs.queryDocumentSymbols(join(dir, "nv.d"), NV);
        expect(outline(a.result!.symbols)).toEqual([
            "module nv 0:7",
            "namespace imports 2:7",
            "  module lib 2:7",
            "  module lib [: mul] 3:7",
            "struct Shape 6:7",
            "  field w [int] 7:8",
            "  field h [int] 8:8",
            "  constructor this [ref Shape(int s)] 9:4",
            "  method area [const int()] 10:8",
            "  property width [const @property int()] 11:18",
            "class Base [: object.Object] 14:6",
            "  method run [void()] 14:18",
            "interface Named 15:10",
            "  method name [string()] 15:25",
            "class Derived [: nv.Base, nv.Named] 16:6",
            "  method name [string()] 16:46",
            "enum Color [int] 18:5",
            "  enumMember red [0] 18:13",
            "  enumMember green [1] 18:18",
            "enumMember loose [1] 19:7",
            "constant limit [int] 20:5",
            "typeParameter Size [= int] 21:6",
            "struct Pair [(T)] 23:7",
            "  field first [T] 24:6",
            "  field second [T] 25:6",
            "  method sum [T()] 26:6",
            "function twice [(T) T(T x)] 29:2",
            "namespace Kit [(T)] 31:9",
            "  typeParameter Item [= T] 32:10",
            "  constant size 33:9",
            "variable mixedVar [(mixin) int] 36:0",
            "variable shown [int] 38:42",
            "function grow [int(Shape s, int by)] 41:4",
            "function grow [int(int a)] 43:4",
            "function outer [int(int a)] 45:4",
            "  function inner [pure nothrow @nogc @safe int(int b)] 46:8",
            "  struct Local 47:11",
            "    field z [int] 47:23",
            "function unittest 51:0",
            "function main [int()] 53:4",
            "constant code [string] 61:5",
            "function fromMixin [(mixin) int()] 62:0",
            "struct Money [(T)] 64:7",
            "  field c [T] 65:6",
            "  method opBinary [(string op : \"+\") const Money(Money o)] 67:10",
            "function spend [int()] 69:4",
        ]);
        const byName = new Map(a.result!.symbols.map((x) => [x.name, x.range]));
        // from the line's first token to the end of the block or the `;`
        expect(byName.get("Shape")).toEqual({ start: at(NV, "struct Shape"), end: at(NV, "}\n\nclass", 0, 1) });
        expect(byName.get("twice")).toEqual({ start: at(NV, "T twice"), end: at(NV, "* 2; }", 0, 6) });
        expect(byName.get("limit")).toEqual({ start: at(NV, "enum limit"), end: at(NV, "= 10;", 0, 5) });
        expect(byName.get("mixedVar")).toEqual({ start: at(NV, "mixin("), end: at(NV, "1;\");", 0, 5) });
    });

    test("a text other than the compiled one: stale; a file outside the compile: a miss", () => {
        expect(djs.queryDocumentSymbols(join(dir, "nv.d"), `${NV} `)).toEqual(
            { result: null, stale: true, reason: djs.STALE_REASON });
        expect(djs.queryDocumentSymbols(join(dir, "none.d"), "").result).toBeNull();
    });
});

/** The references at a token: `file:line:character`, `*` after the declaration's. */
function refs(file: string, text: string, token: string, nth = 0, skip = 0): string[] {
    const p = at(text, token, nth, skip);
    const a = djs.queryReferences(join(dir, file), p.line, p.character, text);
    if (a.result === null)
        return [`miss: ${a.reason}`];
    return a.result.references.map((r) => `${r.file.slice(dir.length + 1)}:${r.range.start.line}:`
        + `${r.range.start.character}${r.declaration ? "*" : ""}`);
}

describe("navigation: references", () => {
    beforeAll(() => {
        compile({ "lib.d": LIB, "nv.d": NV }, "nv.d", true);
    });

    test("a function through UFCS, one overload; a member; an aggregate through its constructor", () => {
        expect(refs("nv.d", NV, "grow(Shape")).toEqual(["nv.d:41:4*", "nv.d:55:14"]);
        expect(refs("nv.d", NV, "grow(1)")).toEqual(["nv.d:43:4*", "nv.d:55:24"]);
        expect(refs("nv.d", NV, "w;")).toEqual(["nv.d:7:8*", "nv.d:9:18", "nv.d:10:30", "nv.d:11:41",
            "nv.d:55:42"]);
        expect(refs("nv.d", NV, "Shape(2)")).toEqual(["nv.d:6:7*", "nv.d:41:9", "nv.d:54:4", "nv.d:54:14"]);
    });

    test("a template parameter, a member of a template's instances, a function template", () => {
        expect(refs("nv.d", NV, "T first")).toEqual(["nv.d:23:12*", "nv.d:24:4", "nv.d:25:4", "nv.d:26:4"]);
        expect(refs("nv.d", NV, "first;")).toEqual(["nv.d:24:6*", "nv.d:26:21", "nv.d:57:6"]);
        expect(refs("nv.d", NV, "twice(4)")).toEqual(["nv.d:29:2*", "nv.d:55:47"]);
        expect(refs("nv.d", NV, "T twice")).toEqual(["nv.d:29:0", "nv.d:29:8*", "nv.d:29:11"]);
        expect(refs("nv.d", NV, "Pair!int")).toEqual(["nv.d:23:7*", "nv.d:56:4"]);
    });

    test("folded names through the fallback; a name another module declares, a selective import's", () => {
        expect(refs("nv.d", NV, "red,")).toEqual(["nv.d:18:13*", "nv.d:58:93"]);
        expect(refs("nv.d", NV, "limit +")).toEqual(["nv.d:20:5*", "nv.d:58:36"]);
        expect(refs("nv.d", NV, "add(1")).toEqual(["nv.d:58:55"]);
        expect(refs("nv.d", NV, "mul;")).toEqual(["nv.d:3:13", "nv.d:58:67"]);
    });

    test("misses: no symbol, another text", () => {
        expect(refs("nv.d", NV, "return p")).toEqual(["miss: no symbol at the position"]);
        expect(djs.queryReferences(join(dir, "nv.d"), 0, 0, `${NV} `).result).toBeNull();
    });
});

const EB = `module eb;

enum code = q{ int fromCode() { return 1; } };
mixin(code);
mixin(\`int raw = 2;\`);
int g = 1;
struct S { int f; int m() { return f; } }

int broken(int a) {
    S s;
    int k = a + g;
    return k + s.f + s.m() + raw + fromCode() + nowhere;
}

int withBlock(S w) {
    with (w) { m(); }
    return g + nowhere;
}

int lambdas() {
    return nowhere + (g => g * 2)(1);
}
`;

describe("navigation: a string mixin's declaration, a body with errors", () => {
    test("a global a string mixin declares, at its use: the hover, the name in the literal, the references", () => {
        compile({ "lib.d": LIB, "nv.d": NV }, "nv.d", true);
        expect(said(hover("nv.d", NV, "mixedVar +"))).toBe("variable nv.mixedVar");
        expect(target(definition("nv.d", NV, "mixedVar +"))).toBe("nv.d:36:11-19");
        expect(refs("nv.d", NV, "mixedVar +")).toEqual(["nv.d:36:11*", "nv.d:58:44"]);
        // the shape of the miss first seen: the use in a `return` whose expression has an error (ulong to int)
        const failing = NV.replace("cast(int) T.sizeof", "T.sizeof");
        try {
            expect(compile({ "nv.d": failing }, "nv.d", true).out).toContain("cannot be implicitly converted");
            expect(said(hover("nv.d", failing, "mixedVar +"))).toBe("variable nv.mixedVar");
            expect(refs("nv.d", failing, "mixedVar +")).toEqual(["nv.d:36:11*", "nv.d:58:44"]);
            expect(said(hover("nv.d", failing, "sum() +"))).toBe("function nv.Pair!int.Pair.sum");
            expect(refs("nv.d", failing, "p.first")).toEqual(["nv.d:56:13*", "nv.d:57:4", "nv.d:58:11"]);
        } finally {
            compile({ "nv.d": NV }, "nv.d", true);
        }
    });

    test("an expression with an error: its names by position; not where a `with` or a lambda could hide one", () => {
        expect(compile({ "eb.d": EB }, "eb.d", true).out).toContain("undefined identifier `nowhere`");
        expect(said(hover("eb.d", EB, "k + s"))).toBe("local variable eb.broken.k");
        expect(said(hover("eb.d", EB, "f + s"))).toBe("field eb.S.f");
        expect(said(hover("eb.d", EB, "m() + raw"))).toBe("function eb.S.m");
        expect(target(definition("eb.d", EB, "raw +"))).toBe("eb.d:4:11-14");
        // a mixed-in string built elsewhere: the `mixin` keyword, as the outline selects it; no declaration listed
        expect(target(definition("eb.d", EB, "fromCode()", 1))).toBe("eb.d:3:0-5");
        expect(refs("eb.d", EB, "fromCode()", 1)).toEqual(["eb.d:11:35"]);
        expect(refs("eb.d", EB, "g;")).toEqual(["eb.d:5:4*", "eb.d:10:16"]);
        expect(said(hover("eb.d", EB, "g + nowhere"))).toBe("miss: no symbol at the position");
        expect(said(hover("eb.d", EB, "g * 2"))).toBe("miss: no symbol at the position");
    });
});

/** A rename's edits as `line:character`, or the miss's reason. */
function renamed(text: string, token: string, newName: string, nth = 0, skip = 0): string[] {
    const p = at(text, token, nth, skip);
    const a = djs.queryRename(join(dir, "nv.d"), p.line, p.character, text, newName);
    return a.result === null ? [`miss: ${a.reason}`]
        : a.result.edits.map((e) => `${e.file.slice(dir.length + 1)}:${e.range.start.line}:${e.range.start.character}`);
}

/** `text` with every edit of a rename applied (one file). */
function applied(text: string, edits: readonly { range: Djs.QueryRange }[], newName: string): string {
    const lines = text.split("\n");
    for (const e of [...edits].sort((a, b) => b.range.start.line - a.range.start.line
        || b.range.start.character - a.range.start.character)) {
        const l = lines[e.range.start.line]!;
        lines[e.range.start.line] = l.slice(0, e.range.start.character) + newName + l.slice(e.range.end.character);
    }
    return lines.join("\n");
}

describe("navigation: rename", () => {
    beforeAll(() => {
        compile({ "lib.d": LIB, "nv.d": NV }, "nv.d", true);
    });

    test("a function through UFCS, a member, a template parameter: the edits, and the renamed text compiles", () => {
        expect(renamed(NV, "grow(Shape", "enlarge")).toEqual(["nv.d:41:4", "nv.d:55:14"]);
        expect(renamed(NV, "h;", "height")).toEqual(["nv.d:8:8", "nv.d:9:25", "nv.d:10:34"]);
        expect(renamed(NV, "T first", "E")).toEqual(["nv.d:23:12", "nv.d:24:4", "nv.d:25:4", "nv.d:26:4"]);
        expect(compile({ "nv.d": NV }, "nv.d", true).out).not.toContain("Error");
        let text = NV;
        try {
            for (const [token, name] of [["grow(Shape", "enlarge"], ["h;", "height"], ["T first", "E"]] as const) {
                const p = at(text, token);
                const a = djs.queryRename(join(dir, "nv.d"), p.line, p.character, text, name);
                text = applied(text, a.result!.edits, name);
                expect(compile({ "nv.d": text }, "nv.d", true).out).not.toContain("Error");
            }
        } finally {
            compile({ "nv.d": NV }, "nv.d", true);
        }
        expect(text).toContain("s.enlarge(3)");
    });

    test("refused, with the reason: special functions, implicit names, imported modules, mixin texts, clashes", () => {
        const prepare = (token: string, nth = 0, skip = 0): string => {
            const p = at(NV, token, nth, skip);
            const a = djs.queryPrepareRename(join(dir, "nv.d"), p.line, p.character, NV);
            return a.result === null ? `miss: ${a.reason}` : `${a.result.placeholder} ${a.result.range.start.line}`;
        };
        expect(prepare("grow(Shape")).toBe("grow 41");
        expect(prepare("this(int")).toBe("miss: a special function has no name of its own");
        expect(prepare("lib : mul")).toBe("miss: a module is renamed with its file");
        expect(prepare("add(1")).toBe(`miss: \`add\` is declared in ${join(dir, "lib.d")}, which the last compile only `
            + "imports: its other uses are not analysed");
        expect(prepare("limit +")).toBe(
            `miss: \`limit\` is spelled in the text of a string mixin at ${join(dir, "nv.d")}:62`);
        expect(renamed(NV, "w;", "width")).toEqual(["miss: `width` is already declared in `nv.Shape`"]);
        expect(renamed(NV, "w;", "int")).toEqual(["miss: `int` is not a name a declaration can take"]);
        expect(renamed(NV, "T first", "first")).toEqual(["miss: `first` is already used in the template"]);
    });
});

/** The signature help at a token: the active signature's label and parameter, then the other labels. */
function signatures(text: string, token: string, nth = 0, skip = 0): string[] {
    const p = at(text, token, nth, skip);
    const a = djs.querySignatureHelp(join(dir, "nv.d"), p.line, p.character, text);
    if (a.result === null)
        return [`miss: ${a.reason}`];
    const r = a.result;
    const sig = r.signatures[r.activeSignature]!;
    const span = sig.parameters[r.activeParameter];
    return [`${sig.label} [${span !== undefined ? sig.label.slice(...span) : "-"}] ${sig.documentation}`.trim(),
        ...r.signatures.filter((_, i) => i !== r.activeSignature).map((x) => x.label)];
}

describe("doc summaries where the picked overload has one", () => {
    beforeAll(() => {
        compile({ "lib.d": LIB, "nv.d": NV }, "nv.d", true);
    });

    test("an operator's hover: the lowering and the summary of a member template of an instance; a UFCS item", () => {
        const plus = hover("nv.d", NV, "(a + b).c", 0, 3);
        expect(plus.result!.markdown).toMatch(/Lowered:\n\n```d\na\.opBinary!"\+"\(b\)\n```\n\nAdds two amounts\./);
        const typed = NV.replace("    p.first = r;", "    p.first = r.;");
        const items = djs.queryCompletion(join(dir, "nv.d"), typed, at(typed, "r.;", 0, 2)).result!.items;
        expect(items.find((i) => i.label === "grow")?.documentation).toBe("Grows a number.");
    });
});

describe("navigation: signature help", () => {
    beforeAll(() => {
        compile({ "lib.d": LIB, "nv.d": NV }, "nv.d", true);
    });

    test("the overload picked first, the argument under the cursor, UFCS, a constructor, a template's instance", () => {
        expect(signatures(NV, "s.grow(3)", 0, 7)).toEqual(["int grow(Shape s, int by) [int by] Grows a shape.",
            "int grow(int a)"]);
        expect(signatures(NV, "grow(1)", 0, 5)).toEqual(["int grow(int a) [int a] Grows a number.",
            "int grow(Shape s, int by)"]);
        expect(signatures(NV, "Shape(2)", 0, 6)).toEqual(["Shape(int s) [int s]"]);
        expect(signatures(NV, "twice(4)", 0, 6)).toEqual(["int twice(int x) [int x] Twice `x`."]);
        expect(signatures(NV, "add(1, 2)", 0, 7)).toEqual(["int add(int a, int b) [int b] Adds two numbers."]);
        expect(signatures(NV, "outer(s.w)", 0, 8)).toEqual(["int outer(int a) [int a]"]);
    });

    test("a call being typed: the name looked up, the template's signature; misses", () => {
        const typed = NV.replace("unittest {", "int typing(Shape s0) { return add(1, twice(\n}\nunittest {");
        compile({ "nv.d": typed }, "nv.d", true);
        try {
            expect(signatures(typed, "add(1, twice(", 0, 7))
                .toEqual(["int add(int a, int b) [int b] Adds two numbers."]);
            expect(signatures(typed, "add(1, twice(", 0, 13)).toEqual(["T twice(T)(T x) [T x] Twice `x`."]);
        } finally {
            compile({ "nv.d": NV }, "nv.d", true);
        }
        expect(signatures(NV, "int main() {", 0, 12)).toEqual(["miss: not inside a call's parentheses"]);
        expect(signatures(`${NV} `, "grow(1)", 0, 5)).toEqual([`miss: ${djs.STALE_REASON}`]);
    });
});

describe("the read-only contract", () => {
    test("a query runs no semantic: no `optimize` while printing, no diagnostic on `__ctfe`", async () => {
        // hdrgen folds a variable template argument with `optimize`, which runs the initializer of `lastLevel`
        // (not analysed yet: a manifest constant of an instance); `isDataseg` on `__ctfe` reports an error
        const RO = `module ro;
struct TB(Args...) {
    enum lastLevel = Args.length - 1;
    void addValue(size_t level, T)(T val) {}
    void put() { addValue!lastLevel(1); }
}
void use() { TB!(int, int, int) b; b.put(); }
int mode() { if (__ctfe) return 1; return 2; }
`;
        compile({ "ro.d": RO }, "ro.d", true);
        const hdrgen = await import("./dmd/hdrgen.js");
        const { optimize } = await import("./dmd/optimize.js");
        const { global } = await import("./dmd/globals.js");
        const errors = global.errors;
        let calls = 0;
        // each query restores the real `optimize` when it ends: the counting one goes back in before each
        const counting = (): void => hdrgen.registerOptimize((e, r, k) => {
            calls++;
            return optimize(e, r, k);
        });
        const file = join(dir, "ro.d");
        const lines = RO.split("\n");
        for (let l = 0; l < lines.length; l++) {
            for (const m of lines[l]!.matchAll(/[A-Za-z_]\w*|[^\w\s]/g)) {
                counting();
                djs.queryHover(file, l, m.index, RO);
                counting();
                djs.queryDefinition(file, l, m.index, RO);
            }
        }
        // the peeks print `lastLevel`'s value and the instance as -vcg-ast prints it, `addValue` and `put` in it
        counting();
        const sites = djs.queryExpansionSites(file, RO).result!.sites;
        expect(sites.map((x) => x.title)).toEqual(["= 2LU", "TB!(int, int, int)"]);
        for (const x of sites) {
            counting();
            expect(djs.queryExpansion(file, x.range, RO).result).not.toBeNull();
        }
        hdrgen.registerOptimize(optimize);
        expect(calls).toBe(0);
        expect(global.errors).toBe(errors);
        const h = hover("ro.d", RO, "__ctfe");
        expect(said(h)).toBe("variable __ctfe");
        expect(h.result!.markdown).toContain("```d\nbool __ctfe\n```");
    });

    test("queries between two kept compiles: the second compile's output is a fresh compile's", async () => {
        compile({ "lib.d": LIB, "app.d": APP }, "app.d", true);
        for (const token of ["local", "param", "add(", "len()", "Point p", "get()", "Box!int", "plus(", "lib;"]) {
            hover("app.d", APP, token);
            definition("app.d", APP, token);
        }
        hover("lib.d", LIB, "value;", 1);
        expect(djs.querySemanticTokens(join(dir, "app.d"), APP).result!.data.length).toBeGreaterThan(0);
        expect(djs.querySemanticTokens(join(dir, "lib.d"), LIB).result!.data.length).toBeGreaterThan(0);
        const whole = { start: { line: 0, character: 0 }, end: { line: 999, character: 0 } };
        expect(djs.queryInlayHints(join(dir, "app.d"), APP, whole).result!.hints.length).toBeGreaterThan(0);
        expect(djs.queryInlayHints(join(dir, "lib.d"), LIB, whole).result!.hints.length).toBeGreaterThan(0);
        expect(djs.queryInactiveRanges(join(dir, "app.d"), APP).result!.ranges).toEqual([]);
        const edited = `${APP}int more() { return use(1) + add(2, 3); }\n`;
        const second = compile({ "app.d": edited }, "app.d", true);
        expect(second.mode).toBe("kept");
        // lib.d is kept, and its `Module.loc` (and its implicit `import object`) is in the first parse of app.d,
        // which the kept compile dropped: the Loc file table keeps that range
        const { Module } = await import("./dmd/dmodule.js");
        const { cstr, dsToJs } = await import("./dstring.js");
        const lib = Module.amodules.opSlice()
            .find((m) => m !== null && dsToJs(cstr(m.srcfile.toChars())).endsWith("lib.d"));
        expect(dsToJs(lib!.loc.filename()!)).toBe(join(dir, "app.d"));
        expect(said(hover("lib.d", LIB, "add("))).toBe("function lib.add");
        vi.resetModules();
        const fresh = await import("./djs.js");
        const args = ["-c", "-o-", "-verrors=0", `-I${dir}`, join(dir, "app.d")];
        const f = quiet(() => fresh.djsMain(args, () => true));
        expect(second.out).toContain("is deprecated");
        expect(second.out).toBe(`${f.value}\n${f.out}`);
    });

    test("completions between two kept compiles: the second compile's output is a fresh compile's", async () => {
        const LIB2 = "module rolib;\nstruct R { int a; int f() { return a; } }\nint g(R r) { return r.a; }\n";
        const APP2 = "module roapp;\nimport rolib;\nint use() { R r; return r.f() + r.g; }\n";
        compile({ "rolib.d": LIB2, "roapp.d": APP2 }, "roapp.d", true);
        const { global } = await import("./dmd/globals.js");
        const errors = global.errors;
        const app = join(dir, "roapp.d");
        for (const token of ["r.f", "r.g"])
            expect(djs.queryCompletion(app, APP2, at(APP2, token, 0, 2)).result).not.toBeNull();
        const typed = APP2.replace("return r.f()", "R s; s.a = 1; return s.");
        djs.queryCompletion(app, typed, at(typed, "return s.", 0, 9));
        expect(global.errors).toBe(errors);
        const second = compile({ "roapp.d": `${APP2}int more() { return use(); }\n` }, "roapp.d", true);
        expect(second.mode).toBe("kept");
        vi.resetModules();
        const fresh = await import("./djs.js");
        const f = quiet(() => fresh.djsMain(["-c", "-o-", "-verrors=0", `-I${dir}`, app], () => true));
        expect(second.out).toBe(`${f.value}\n${f.out}`);
    });

    test("outline, references, rename and signature help at every character between two kept compiles", async () => {
        compile({ "lib.d": LIB, "nv.d": NV }, "nv.d", true);
        const { global } = await import("./dmd/globals.js");
        const errors = global.errors;
        const nv = join(dir, "nv.d");
        expect(djs.queryDocumentSymbols(nv, NV).result).not.toBeNull();
        const lines = NV.split("\n");
        for (let l = 0; l < lines.length; l++) {
            for (let c = 0; c < lines[l]!.length; c++) {
                djs.queryReferences(nv, l, c, NV);
                djs.queryPrepareRename(nv, l, c, NV);
                djs.queryRename(nv, l, c, NV, "renamed");
                djs.querySignatureHelp(nv, l, c, NV);
            }
        }
        expect(global.errors).toBe(errors);
        const second = compile({ "nv.d": `${NV}int more() { return main() + grow(2); }\n` }, "nv.d", true);
        expect(second.mode).toBe("kept");
        vi.resetModules();
        const fresh = await import("./djs.js");
        const f = quiet(() => fresh.djsMain(["-c", "-o-", "-verrors=0", `-I${dir}`, nv], () => true));
        expect(second.out).toBe(`${f.value}\n${f.out}`);
    });

    test("expansions and hovers at every character between two kept compiles: the second is fresh", async () => {
        compile({ "xp.d": XP }, "xp.d", true);
        const xp = join(dir, "xp.d");
        for (const x of djs.queryExpansionSites(xp, XP).result!.sites)
            expect(djs.queryExpansion(xp, x.range, XP).result).not.toBeNull();
        const lines = XP.split("\n");
        for (let l = 0; l < lines.length; l++)
            for (let c = 0; c < lines[l]!.length; c++)
                djs.queryHover(xp, l, c, XP);
        const second = compile({ "xp.d": `${XP}int more() { return main() + over(2); }\n` }, "xp.d", true);
        expect(second.mode).toBe("kept");
        vi.resetModules();
        const fresh = await import("./djs.js");
        const f = quiet(() => fresh.djsMain(["-c", "-o-", "-verrors=0", `-I${dir}`, xp], () => true));
        expect(second.out).toBe(`${f.value}\n${f.out}`);
    });

    test("hovers and definitions at every character between two kept compiles: the second is fresh", async () => {
        const { global } = await import("./dmd/globals.js");
        const cases: [Record<string, string>, string, string][] = [[{ "bp.d": BP }, "bp.d", "S.init.b"],
            [{ "pa.d": PA, "pb.d": PB, "pu.d": PU }, "pu.d", "use() + B_TWO"], [{ "tp.d": TP }, "tp.d", "use()"]];
        for (const [files, root, more] of cases) {
            compile(files, root, true);
            const errors = global.errors;
            const file = join(dir, root);
            const text = files[root]!;
            const lines = text.split("\n");
            for (let l = 0; l < lines.length; l++) {
                for (let c = 0; c < lines[l]!.length; c++) {
                    djs.queryHover(file, l, c, text);
                    djs.queryDefinition(file, l, c, text);
                }
            }
            expect(djs.querySemanticTokens(file, text).result).not.toBeNull();
            expect(global.errors).toBe(errors);
            const second = compile({ [root]: `${text}long more() { return ${more}; }\n` }, root, true);
            expect(second.mode).toBe("kept");
            vi.resetModules();
            const fresh = await import("./djs.js");
            const f = quiet(() => fresh.djsMain(["-c", "-o-", "-verrors=0", `-I${dir}`, file], () => true));
            expect(second.out).toBe(`${f.value}\n${f.out}`);
        }
    });
});

const UA = `module ua;
import ub;

struct S {
    int v;
    int opApply(scope int delegate(ref int) dg) { return dg(v); }
    S opBinary(string op : "+")(S o) const { return S(v + o.v); }
    string toString() const { return "s"; }
    void unusedMethod() {}
}
struct Dead { void m() {} }

int helper() { return 1; }
int deadHelper() { return deadHelper2(); }
int deadHelper2() { return 2; }
int recurse(int n) { return n > 0 ? recurse(n - 1) : 0; }

T tmpl(T)(T x) { return x; }
T deadTmpl(T)(T x) { return calledFromDeadTmpl(); }
int calledFromDeadTmpl() { return 3; }
struct Box(T) { T v; T get() { return v; } T unusedGet() { return v; } }

class Base { void f() {} void g() {} }
class Derived : Base { override void f() {} override void g() {} void own() {} }
class Printed { override string toString() const { return "p"; } }
interface I { void run(); }
class Impl : I { void run() {} }
class NeverMade { void x() {} }

int ctfeOnly() { return 4; }
enum fromCtfe = ctfeOnly();
int mixinRuntime() { return 5; }
int mixinCtfe() { return 6; }
mixin("int mixinDeclared() { return 7; }");
int traitsReached() { return 8; }
int otherTarget() { return 9; }
int testedOnly() { return 10; }
version (none) int inactiveUser() { return otherTarget(); }
unittest { assert(testedOnly() == 10); }
extern (C) int cExported() { return 11; }
extern (C) extern __gshared int foreignVar;
int gvar;
int deadGvar;
immutable int constGvar = 12;

void main() {
    S s;
    foreach (x; s) gvar += x;
    S t = s + s;
    gvar += helper() + tmpl(2) + fromCtfe;
    Box!int b;
    gvar += b.get();
    Base x = new Derived;
    x.f();
    Object o = new Printed;
    I i = new Impl;
    i.run();
    mixin("gvar += mixinRuntime();");
    mixin("enum z = mixinCtfe();");
    gvar += z + t.v;
    gvar += __traits(getMember, ua, "traitsReached")();
    void nestedUsed() { gvar++; }
    void nestedUnused() {}
    nestedUsed();
    gvar += ubUsed() + constGvar;
}
`;

const UB = `module ub;
int ubUsed() { return 1; }
int ubUnused() { return 2; }
`;

/** The unused declarations as `file:line:character kind name: why` (positions from 0), or the miss's reason. */
function unused(): string[] {
    const a = djs.queryUnused();
    if (a.result === null)
        return [`miss: ${a.reason}`];
    return a.result.declarations.map((d) => `${d.file.slice(dir.length + 1)}:${d.range.start.line}:`
        + `${d.range.start.character} ${d.kind} ${d.name}: ${d.why}`);
}

/** The expected line of `unused` for the declaration whose name is `token` in `text` (`file`). */
function dead(file: string, text: string, token: string, kind: string, name: string, why: string, nth = 0): string {
    const p = at(text, token, nth);
    return `${file}:${p.line}:${p.character} ${kind} ${name}: ${why}`;
}

describe("unused code", () => {
    test("what the program's main cannot reach, in the modules it compiles, the outermost declaration only", () => {
        compile({ "ua.d": UA, "ub.d": UB }, "ua.d", true, ["-i"]);
        expect(unused()).toEqual([
            dead("ua.d", UA, "unusedMethod", "method", "ua.S.unusedMethod", "unreferenced"),
            dead("ua.d", UA, "Dead", "struct", "ua.Dead", "unreferenced"),
            dead("ua.d", UA, "deadHelper", "function", "ua.deadHelper", "unreferenced"),
            dead("ua.d", UA, "deadHelper2() {", "function", "ua.deadHelper2", "only referenced from unreachable code"),
            dead("ua.d", UA, "recurse", "function", "ua.recurse", "only self-referenced"),
            dead("ua.d", UA, "deadTmpl", "template", "ua.deadTmpl", "unreferenced"),
            dead("ua.d", UA, "calledFromDeadTmpl() {", "function", "ua.calledFromDeadTmpl",
                "only referenced from unreachable code"),
            dead("ua.d", UA, "unusedGet", "method", "ua.Box.unusedGet", "unreferenced"),
            dead("ua.d", UA, "g() {}", "method", "ua.Base.g", "unreferenced"),
            dead("ua.d", UA, "g() {}", "method", "ua.Derived.g", "unreferenced", 1),
            dead("ua.d", UA, "own", "method", "ua.Derived.own", "unreferenced"),
            dead("ua.d", UA, "NeverMade", "class", "ua.NeverMade", "unreferenced"),
            dead("ua.d", UA, "deadGvar", "variable", "ua.deadGvar", "unreferenced"),
            dead("ua.d", UA, "nestedUnused", "function", "ua.main.nestedUnused", "unreferenced"),
            dead("ub.d", UB, "ubUnused", "function", "ub.ubUnused", "unreferenced"),
        ]);
    });

    test("live: lowered calls, overrides, mixin and traits names, CTFE, other targets, tests, foreign linkage", () => {
        compile({ "ua.d": UA, "ub.d": UB }, "ua.d", true, ["-i"]);
        const names = unused().join("\n");
        // opApply (foreach), opBinary (+), an uncalled toString of a live struct; Derived.f through Base.f, an
        // Object.toString override, an interface's implementation; a string mixin's runtime call and its CTFE call,
        // a member reached by __traits(getMember); a function called in CTFE only; names in a branch not compiled
        // and in a unittest without -unittest; extern(C); a declaration a string mixin made, an `extern` variable (a
        // declaration of a variable defined elsewhere) are not listed
        for (const name of ["opApply", "opBinary", "S.toString", "Derived.f", "Printed", "run", "mixinRuntime",
            "mixinCtfe", "mixinDeclared", "traitsReached", "ctfeOnly", "otherTarget", "testedOnly", "cExported",
            "nestedUsed", "ubUsed", "constGvar", "foreignVar", "helper:", "tmpl:", "Box:", "Box.get"])
            expect(names).not.toContain(name);
        expect(djs.queryUnused().result!.entry).toBe("D main");
    });

    test("misses: a library (no main), a compile with errors", () => {
        compile({ "ub.d": UB }, "ub.d", true);
        expect(unused()).toEqual(["miss: the program has no entry: no module of the compile declares a main"]);
        compile({ "ue.d": "module ue;\nvoid main() { nowhere(); }\n" }, "ue.d", true);
        expect(unused()).toEqual(["miss: the last compile reported errors"]);
    });

    test("a query between two kept compiles: the second compile's output is a fresh compile's", async () => {
        compile({ "ua.d": UA, "ub.d": UB }, "ua.d", true, ["-i"]);
        expect(unused().length).toBeGreaterThan(0);
        const edited = `${UA}int more() { return ubUnused() + deadHelper(); }\n`;
        const second = compile({ "ua.d": edited }, "ua.d", true, ["-i"]);
        expect(second.mode).toBe("kept");
        expect(unused()).toContain(dead("ua.d", edited, "more", "function", "ua.more", "unreferenced"));
        vi.resetModules();
        const fresh = await import("./djs.js");
        const args = ["-c", "-o-", "-verrors=0", "-i", `-I${dir}`, join(dir, "ua.d")];
        const f = quiet(() => fresh.djsMain(args, () => true));
        expect(second.out).toBe(`${f.value}\n${f.out}`);
    });
});
