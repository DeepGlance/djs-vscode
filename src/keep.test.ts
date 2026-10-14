// Tests for src/keep.ts, the kept-module engine, through `djsMainKept` (src/djs.ts; 10 §4.7 "The kept-module
// engine"). Hand-written djs module; no D unittests to port.
//
// Each test writes its modules to a temporary directory and runs a sequence of compiles in one module registry
// through `djsMainKept`, the way an editor host does; every compile is compared with `djsMain` (always fresh) on
// the same arguments and files, run from a second registry: the guarantee under test is that a kept compile's
// status, stdout and stderr are a fresh compile's. Each sequence also states which calls keep, so a test cannot
// pass by compiling fresh every time.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

interface Run {
    code: number;
    stdout: string;
    stderr: string;
}

interface KeptRun extends Run {
    mode: string;
    reason: string;
    unitsKept: number;
    seeds: Record<string, number>;
}

/**
 * One step: the files to write (relative to the test directory; null removes one), the environment variables to
 * set (null unsets one) and the working directory (relative to the test directory) for the compile, its arguments,
 * and the texts that replace files' contents for both compiles (`DjsOptions.texts`, relative to the test directory).
 */
interface Step {
    files?: Record<string, string | null>;
    env?: Record<string, string | null>;
    cwd?: string;
    args: string[];
    texts?: Record<string, string>;
}

/** A diagnostic handler's calls, recorded per registry: the header and the message as the handler receives them. */
type HandlerCalls = string[];

let dir = "";

afterEach(() => {
    if (dir !== "")
        rmSync(dir, { recursive: true, force: true });
    dir = "";
});

/** Runs `f` with stdout and stderr captured. */
function capture<T>(f: () => T): { value: T; stdout: string; stderr: string } {
    const out: string[] = [];
    const err: string[] = [];
    const decode = (c: string | Uint8Array): string => (typeof c === "string" ? c : new TextDecoder().decode(c));
    const o = vi.spyOn(process.stdout, "write").mockImplementation((c) => { out.push(decode(c)); return true; });
    const e = vi.spyOn(process.stderr, "write").mockImplementation((c) => { err.push(decode(c)); return true; });
    try {
        const value = f();
        return { value, stdout: out.join(""), stderr: err.join("") };
    } finally {
        o.mockRestore();
        e.mockRestore();
    }
}

/**
 * The steps, in order, in one registry through `djsMainKept`, each followed by `djsMain` in a second registry;
 * the arguments name files relative to the test directory, which is the working directory of both. With
 * `suppress`, each registry gets a diagnostic handler that records its calls and answers `suppress(header)`.
 */
async function sequence(files: Record<string, string>, steps: Step[], suppress?: (header: string) => boolean):
    Promise<{ kept: KeptRun; fresh: Run; calls?: { kept: HandlerCalls; fresh: HandlerCalls } }[]> {
    dir = mkdtempSync(join(tmpdir(), "djs-keep-"));
    const calls = { kept: [] as HandlerCalls, fresh: [] as HandlerCalls };
    const registry = async (into: "kept" | "fresh"): Promise<typeof import("./djs.js")> => {
        vi.resetModules();
        const djs = await import("./djs.js");
        if (suppress !== undefined) {
            const errors = await import("./dmd/errors.js");
            const { cstr, dsToJs } = await import("./dstring.js");
            const t = (d: Uint8Array | null): string => (d === null ? "" : dsToJs(cstr(d)));
            errors.setDiagnosticHandler((loc, _color, header, format, ap, p1, p2) => {
                calls[into].push(`${t(loc.filename)}(${loc.line}) ${t(header)}${t(p1)}${t(p2)}${t(format)} `
                    + JSON.stringify(ap.map((a) => (a instanceof Uint8Array ? t(a) : String(a)))));
                return suppress(t(header));
            });
        }
        return djs;
    };
    const keeping = await registry("kept");
    const reference = await registry("fresh");
    const cwd = process.cwd();
    const env = { ...process.env };
    process.chdir(dir);
    try {
        const write = (fs: Record<string, string | null>): void => {
            for (const [name, text] of Object.entries(fs)) {
                mkdirSync(dirname(join(dir, name)), { recursive: true });
                if (text === null)
                    rmSync(join(dir, name), { force: true });
                else
                    writeFileSync(join(dir, name), text);
            }
        };
        write(files);
        const out: { kept: KeptRun; fresh: Run; calls?: { kept: HandlerCalls; fresh: HandlerCalls } }[] = [];
        for (const s of steps) {
            write(s.files ?? {});
            for (const [k, v] of Object.entries(s.env ?? {})) {
                if (v === null)
                    delete process.env[k];
                else
                    process.env[k] = v;
            }
            process.chdir(join(dir, s.cwd ?? ""));
            calls.kept = [];
            calls.fresh = [];
            // the keys spelled through the temporary directory's symbolic link (macOS: /var for the working
            // directory's /private/var), which the override resolves
            const options = { texts: new Map(Object.entries(s.texts ?? {}).map(([name, t]) => [join(dir, name), t])) };
            const k = capture(() => keeping.djsMainKept(s.args, undefined, options));
            const f = capture(() => reference.djsMain(s.args, undefined, options));
            out.push({
                kept: { code: k.value.status, stdout: k.stdout, stderr: k.stderr, mode: k.value.mode,
                    reason: k.value.reason, unitsKept: k.value.stats.unitsKept, seeds: k.value.stats.seeds },
                fresh: { code: f.value, stdout: f.stdout, stderr: f.stderr },
                ...(suppress === undefined ? {} : { calls: { kept: calls.kept, fresh: calls.fresh } }),
            });
        }
        return out;
    } finally {
        process.chdir(cwd);
        process.env = env;
    }
}

/** Every kept compile equals its fresh one, and the modes are `modes` ("k" kept, "f" fresh), in order. */
function expectFresh(runs: { kept: KeptRun; fresh: Run }[], modes: string): void {
    for (const [i, r] of runs.entries()) {
        expect({ step: i + 1, code: r.kept.code, stdout: r.kept.stdout, stderr: r.kept.stderr })
            .toEqual({ step: i + 1, ...r.fresh });
    }
    expect(runs.map((r) => (r.kept.mode === "kept" ? "k" : "f")).join("")).toBe(modes);
}

const ARGS = ["-c", "-o-", "-verrors=0", "app.d"];

/** A library whose template instance reports a deprecation, located in the library, with its trace. */
const LIB_DEPRECATED = `module lib;
deprecated("use other") void old() {}
struct W(T) {
    T x;
    void f() { old(); }
}
`;

const APP = `module app;
import lib;
void main() {
    W!int w;
    w.f();
}
`;

describe("djsMainKept — a kept compile prints what a fresh one prints", () => {
    test("a library deprecation inside a template instance, with its trace, after the root moved", async () => {
        const runs = await sequence({ "lib.d": LIB_DEPRECATED, "app.d": APP }, [
            { args: ARGS },
            { args: ARGS },
            { files: { "app.d": "// two lines\n// inserted above\n" + APP }, args: ARGS },
        ]);
        expectFresh(runs, "fkk");
        expect(runs[2]!.kept.stderr).toContain("lib.d(5): Deprecation: function `lib.old` is deprecated - use other");
        expect(runs[2]!.kept.stderr).toContain("app.d(6):        instantiated from here: `W!int`");
    });

    test("an edit right after a parse error", async () => {
        const broken = APP.replace("w.f();", "w.f(;");
        const runs = await sequence({ "lib.d": LIB_DEPRECATED, "app.d": APP }, [
            { args: ARGS },
            { files: { "app.d": broken }, args: ARGS },
            { files: { "app.d": APP.replace("w.f();", "w.f(); w.f();") }, args: ARGS },
        ]);
        expectFresh(runs, "fkk");
        expect(runs[1]!.kept.code).toBe(1);
    });

    test("a line removed, then restored", async () => {
        const runs = await sequence({ "lib.d": LIB_DEPRECATED, "app.d": APP }, [
            { args: ARGS },
            { files: { "app.d": APP.replace("    w.f();\n", "") }, args: ARGS },
            { files: { "app.d": APP }, args: ARGS },
        ]);
        expectFresh(runs, "fkk");
        // W!int is still instantiated, in the root: its f() is analysed and the deprecation stays
        expect(runs[1]!.kept.stderr).toContain("app.d(4):        instantiated from here: `W!int`");
    });

    test("an import added, then dropped: the dropped module is invisible again", async () => {
        const extra = "module extra;\nint value() { return 1; }\n";
        const withImport = APP.replace("import lib;", "import lib;\nimport extra;")
            .replace("w.f();", "w.f();\n    auto v = extra.value();");
        const qualified = APP.replace("w.f();", "w.f();\n    auto v = extra.value();");
        const runs = await sequence({ "lib.d": LIB_DEPRECATED, "app.d": APP, "extra.d": extra }, [
            { args: ARGS },
            { files: { "app.d": withImport }, args: ARGS },
            { files: { "app.d": qualified }, args: ARGS },
        ]);
        expectFresh(runs, "fkk");
        expect(runs[2]!.kept.stderr).toContain("undefined identifier `extra`");
    });

    test("a library error gagged, then not needed, then ungagged", async () => {
        const lib = "module lib;\nint broken(T)(T t) { return t.nope; }\n";
        const app = (body: string): string => `module app;\nimport lib;\nvoid main() {\n${body}\n}\n`;
        const runs = await sequence({ "lib.d": lib, "app.d": app("    enum ok = __traits(compiles, broken(1));") }, [
            { args: ARGS },
            { args: ARGS },
            { files: { "app.d": app("    int x = 1;") }, args: ARGS },
            { files: { "app.d": app("    auto y = broken(1);") }, args: ARGS },
        ]);
        expectFresh(runs, "fkkk");
        expect(runs[3]!.kept.stderr).toContain("no property `nope` for `t` of type `int`");
    });

    test("the root changes from a module to one that imports it", async () => {
        const a = "module a;\ndeprecated int f() { return 1; }\nint g() { return f(); }\n";
        const b = "module b;\nimport a;\nint h() { return g() + f(); }\n";
        const runs = await sequence({ "a.d": a, "b.d": b }, [
            { args: ["-c", "-o-", "a.d"] },
            { args: ["-c", "-o-", "b.d"] },
            { args: ["-c", "-o-", "b.d"] },
        ]);
        expectFresh(runs, "fkk");
        expect(runs[1]!.kept.stderr).toContain("b.d(3): Deprecation: function `a.f` is deprecated");
    });

    test("a library instance over a root type is made again when the root changes", async () => {
        const lib = "module lib;\nstruct Box(T) { T v; }\n";
        const app = (fields: string, use: string): string =>
            `module app;\nimport lib;\nstruct S { ${fields} }\nvoid main() { Box!S b; ${use} }\n`;
        const runs = await sequence({ "lib.d": lib, "app.d": app("int a;", "b.v.a = 1;") }, [
            { args: ARGS },
            { files: { "app.d": app("int a; int c;", "b.v.c = 2;") }, args: ARGS },
        ]);
        expectFresh(runs, "fk");
        expect(runs[1]!.kept.code).toBe(0);
    });

    test("a kept module edited on disk is analysed again", async () => {
        const runs = await sequence({ "lib.d": LIB_DEPRECATED, "app.d": APP }, [
            { args: ARGS },
            { files: { "lib.d": LIB_DEPRECATED.replace("use other", "use another") }, args: ARGS },
            { files: { "lib.d": LIB_DEPRECATED.replace("old(); }", "old(); old(); }") }, args: ARGS },
        ]);
        expectFresh(runs, "fkk");
        expect(runs[1]!.kept.stderr).toContain("is deprecated - use another");
    });

    test("dip1000: a kept library function keeps the reason its parameter is not scope", async () => {
        // fail_compilation/diag23295.d, its two inferred functions moved to a library
        const lib = "module lib;\n@safe:\nauto foo(int* y, int** w) { fooImpl(y, null); }\n"
            + "auto fooImpl(int* z, int** w) { auto f = &z; }\n";
        const app = (pad: string): string => `module app;\n${pad}import lib;\n@safe void main() {\n`
            + "    scope int* x;\n    foo(x, null);\n}\n";
        const args = ["-c", "-o-", "-preview=dip1000", "app.d"];
        const runs = await sequence({ "lib.d": lib, "app.d": app("") }, [
            { args },
            { files: { "app.d": app("\n") }, args },
            { files: { "app.d": app("\n\n") }, args },
        ]);
        expectFresh(runs, "fkk");
        expect(runs[2]!.kept.stderr).toContain("`z` is not `scope` because of `f = & z`");
    });

    test("generated names in the root count those a kept library's parse consumed", async () => {
        // fail_compilation/test9150.d: the lowered foreach names `__r`/`__key` follow the `__T` numbers the
        // library's function literal took at its parse, which the kept compile does not run
        const lib = "module lib;\nalias first = (a, b) => a;\n";
        const app = (pad: string): string => `module app;\n${pad}import lib;\nvoid main() {\n`
            + "    int[3][2] m;\n    foreach (int[5] row; m) {}\n}\n";
        const runs = await sequence({ "lib.d": lib, "app.d": app("") }, [
            { args: ARGS },
            { files: { "app.d": app("\n") }, args: ARGS },
        ]);
        expectFresh(runs, "fk");
        expect(runs[1]!.kept.stderr).toMatch(/`row\[\] = __r\d+\[__key\d+\]`/);
    });

    test("a kept module first reached, in this compile, through an import that found it loaded", async () => {
        // runnable/ldc_github_430.d after 424: `c` was loaded by the root before `b` imported it; here `b` reaches
        // it first, so the replay of `b`'s import registers it (its parse's numbers too: `__r`/`__key`) and sets its
        // `importedFrom`, where the speculative instance of `conv`'s constraint is appended (dmd/templatesem.d:1745)
        const c = "module c;\nenum isInt(T) = is(T == int);\nalias first = (a, b) => a;\n";
        const b = "module b;\npublic import c;\nstring conv(T)(T t) if (!isInt!T) { return null; }\n";
        const app = (imports: string): string => `module app;\n${imports}\nstruct Foo {}\nvoid main() {\n`
            + "    Foo f;\n    auto s = conv(f);\n    enum x = isInt!Foo;\n"
            + "    int[3][2] m;\n    foreach (int[5] r; m) {}\n}\n";
        const runs = await sequence({ "c.d": c, "b.d": b, "app.d": app("import c;\nimport b;") }, [
            { args: ARGS },
            { files: { "app.d": app("import b;") }, args: ARGS },
        ]);
        expectFresh(runs, "fk");
        expect(runs[1]!.kept.stderr).toContain("mismatched array lengths 5 and 3");
    });

    test("a package.d imported after its submodules were kept", async () => {
        const files = {
            "pkg/package.d": "module pkg;\npublic import pkg.sub;\n",
            "pkg/sub.d": "module pkg.sub;\ndeprecated int s() { return 1; }\n",
            "app.d": "module app;\nimport pkg.sub;\nint main() { return s(); }\n",
        };
        const runs = await sequence(files, [
            { args: ARGS },
            { files: { "app.d": "module app;\nimport pkg;\nint main() { return s(); }\n" }, args: ARGS },
        ]);
        expectFresh(runs, "fk");
        expect(runs[1]!.kept.stderr).toContain("app.d(3): Deprecation: function `pkg.sub.s` is deprecated");
    });

    test("a kept module's import whose package another module's import had put in the tree", async () => {
        // runnable/test4.d, then test9495.d: the first root's import of a.b.one puts package `b` under `a`, so
        // a.two's import of a.b.three, recorded after it, adds only `three`; the second root imports a.two alone
        const files = {
            "a/b/one.d": "module a.b.one;\n",
            "a/b/three.d": "module a.b.three;\nint f() { return 3; }\n",
            "a/two.d": "module a.two;\npublic import a.b.three;\nalias g = a.b.three.f;\n",
            "app.d": "module app;\nimport a.b.one;\nimport a.two;\nvoid main() {}\n",
        };
        const runs = await sequence(files, [
            { args: ARGS },
            { files: { "app.d": "module app;\nimport a.two;\nint main() { return g(); }\n" }, args: ARGS },
        ]);
        expectFresh(runs, "fk");
        expect(runs[1]!.kept.code).toBe(0);
    });

    test("a kept module's location is its first import's in this compile", async () => {
        // fail_compilation/fail20163.d, then fail20164.d: a deprecated module reports at its Module's `loc`, which
        // the first load gives it (dmd/dsymbolsem.d:2012); the first root loaded it from a mixin
        const runs = await sequence({ "dep.d": "deprecated module dep;\n",
            "app.d": "module app;\nvoid f() { mixin(\"import dep;\"); }\n" }, [
            { args: ARGS },
            { files: { "app.d": "module app;\n\nvoid f() { import dep; }\n" }, args: ARGS },
        ]);
        expectFresh(runs, "fk");
        expect(runs[1]!.kept.stderr).toContain("app.d(3): Deprecation: module `dep` is deprecated");
    });

    test("a function pointer type the previous root's analysis created is not the next root's", async () => {
        // compilable/issue22854.d, then test17349.d: the first root leaves `int function()*` in the type table over
        // its own function type, given inferred `scope` and `@system`; the second root's array literal of function
        // pointers would merge with it
        const first = "void test22854() {\n    static foreach (ch; SomeContainer().range) { }\n}\n"
            + "struct SomeContainer {\n    SomeRange range() { return SomeRange(); }\n    TypeWithDestructor data;\n}\n"
            + "struct TypeWithDestructor { ~this() { } }\n"
            + "struct SomeRange {\n    int front() { return 0; }\n    bool empty() { return true; }\n"
            + "    void popFront() { }\n}\n";
        const second = "const(int) retConst1();\nint retConst2();\nauto retConst = [&retConst1, &retConst2];\n";
        const runs = await sequence({ "app.d": first }, [
            { args: ARGS },
            { files: { "app.d": second }, args: ARGS },
        ]);
        expectFresh(runs, "fk");
        expect(runs[1]!.kept.code).toBe(0);
    });

    test("a library struct's TypeInfo members, analysed at the end of the compile (deferred semantic3)", async () => {
        // `typeid` of an instance made in a library defers its member functions' semantic3 to runDeferredSemantic3
        // (dmd/expressionsem.d:18866), which runs outside every unit: the root's replayed analysis defers it again
        const lib = "module lib;\ndeprecated void dep() {}\nstruct T(X) {\n    X x;\n"
            + "    bool opEquals(const T o) const { dep(); return true; }\n"
            + "    size_t toHash() const nothrow { return 0; }\n}\nalias TI = T!int;\n";
        const app = "module app;\nimport lib;\nvoid main() { auto t = typeid(TI); }\n";
        const runs = await sequence({ "lib.d": lib, "app.d": app }, [
            { args: ARGS },
            { args: ARGS },
            { files: { "app.d": app.replace("{ auto", "{ int y; auto") }, args: ARGS },
        ]);
        expectFresh(runs, "fkk");
        expect(runs[1]!.kept.stderr).toContain("lib.d(5): Deprecation: function `lib.dep` is deprecated");
    });

    test("a module created where a gagged import found none", async () => {
        const lib = "module lib;\nstatic if (__traits(compiles, { import optmod; }))\n"
            + "    pragma(msg, \"has optmod\");\nelse\n    pragma(msg, \"no optmod\");\n";
        const runs = await sequence({ "lib.d": lib, "app.d": "module app;\nimport lib;\nvoid main() {}\n" }, [
            { args: ARGS },
            { files: { "optmod.d": "module optmod;\n" }, args: ARGS },
            { files: { "optmod.d": null }, args: ARGS },
        ]);
        expectFresh(runs, "fkk");
        expect(runs[1]!.kept.stderr).toBe("has optmod\n");
    });

    test("string imports follow the -J search: a file on an earlier path, a file created", async () => {
        const lib = "module lib;\npragma(msg, import(\"cfg.txt\"));\n"
            + "static if (__traits(compiles, import(\"opt.txt\")))\n    pragma(msg, \"has opt\");\n";
        const args = ["-c", "-o-", "-Ja", "-Jb", "app.d"];
        const runs = await sequence({ "lib.d": lib, "app.d": "module app;\nimport lib;\nvoid main() {}\n",
            "a/.keep": "", "b/cfg.txt": "from b" }, [
            { args },
            { files: { "a/cfg.txt": "from a" }, args },
            { files: { "b/opt.txt": "" }, args },
        ]);
        expectFresh(runs, "fkk");
        expect(runs[1]!.kept.stderr).toBe("from a\n");
        expect(runs[2]!.kept.stderr).toBe("from a\nhas opt\n");
    });

    test("__DATE__ and __TIME__ in a kept module are this compile's", async () => {
        const lib = "module lib;\npragma(msg, \"built \" ~ __DATE__ ~ \" \" ~ __TIME__);\n";
        const runs = await sequence({ "lib.d": lib, "app.d": "module app;\nimport lib;\nvoid main() {}\n" }, [
            { env: { SOURCE_DATE_EPOCH: "1000000000" }, args: ARGS },
            { env: { SOURCE_DATE_EPOCH: "1000003600" }, args: ARGS },
        ]);
        expectFresh(runs, "fk");
        expect(runs[1]!.kept.stderr).toBe("built Sep  9 2001 02:46:40\n");
    });

    test("__FILE_FULL_PATH__ in a kept module, compiled from another directory", async () => {
        const lib = "module lib;\npragma(msg, __FILE_FULL_PATH__);\n";
        const app = "module app;\nimport lib;\nvoid main() {}\n";
        const runs = await sequence({ "x/lib.d": lib, "x/app.d": app, "y/lib.d": lib, "y/app.d": app }, [
            { cwd: "x", args: ARGS },
            { cwd: "y", args: ARGS },
        ]);
        expectFresh(runs, "fk");
        expect(runs[1]!.kept.stderr).toMatch(/\/y\/lib\.d\n$/);
    });

    test("a C module edited, then a C module imported for the first time: both read in the kept compile", async () => {
        const app = (imports: string, body: string): string => `module app;\n${imports}\nint main() { ${body} }\n`;
        const runs = await sequence({ "shim.c": "int three(void) { return 3; }\n",
            "more.c": "int four(void) { return 4; }\n", "app.d": app("import shim;", "return three();") }, [
            { args: ARGS },
            { files: { "shim.c": "int three(void) { return 3; }\nint five(void) { return 5; }\n",
                "app.d": app("import shim;", "return three() + five();") }, args: ARGS },
            { files: { "app.d": app("import shim;\nimport more;", "return three() + four();") }, args: ARGS },
            { files: { "app.d": app("import shim;\nimport more;", "return three() + six();") }, args: ARGS },
        ]);
        expectFresh(runs, "fkkk");
        expect(runs[3]!.kept.stderr).toContain("undefined identifier `six`");
    });

    test("two C shims including one header: either one edited keeps", async () => {
        // the later-loaded shim takes the header's types from the earlier one, in a kept compile as in a fresh one;
        // an edit of the earlier one gives them a new declaration: the later shim, which took the old one, dies with it
        const c1 = "#include \"h.h\"\nint f1(S* s) { return s->a; }\n";
        const c2 = "#include \"h.h\"\nint f2(S* s) { return s->a + 1; }\n";
        const runs = await sequence({ "h.h": "typedef struct { int a; } S;\n", "c1.c": c1, "c2.c": c2,
            "app.d": "module app;\nimport c1;\nimport c2;\nvoid main() { S s; f1(&s); f2(&s); }\n" }, [
            { args: ARGS },
            { files: { "c2.c": c2 + "int g2(S s) { return s.a; }\n" }, args: ARGS },
            { files: { "c1.c": c1 + "int g1(S s) { return s.a; }\n" }, args: ARGS },
        ]);
        expectFresh(runs, "fkk");
    });

    test("a C shim loaded first and analysed after another that includes its header: edited, it keeps", async () => {
        // c2 is loaded by the module's importAll, c1 by the struct's semantic, which comes first: the header's types
        // merge in c1, as in a fresh compile, though c1 is loaded after c2
        const c1 = "#include \"h.h\"\nint f1(T* t) { return t->a; }\n";
        const c2 = "#include \"h.h\"\nint f2(T* t) { return t->a + 1; }\n";
        const runs = await sequence({ "h.h": "typedef struct { int a; } T;\n", "c1.c": c1, "c2.c": c2,
            "app.d": "module app;\nstruct S { import c1; }\nimport c2;\nvoid main() { T t; f2(&t); }\n" }, [
            { args: ARGS },
            { files: { "c2.c": c2 + "int g2(T t) { return t.a; }\n" }, args: ARGS },
        ]);
        expectFresh(runs, "fk");
    });

    test("a module a compile did not load keeps its importAll: the next one loads its imports where a fresh one does",
        async () => {
            // other.d's compile does not load x; app's next compile replays x's importAll (which loads c1) and then
            // reaches x again from S: with x's scope lost, x's importAll would run again and keep no loads, and the
            // edit of c2 would analyse c1 before loading it
            const c1 = "#include \"h.h\"\nint f1(T* t) { return t->a; }\n";
            const c2 = "#include \"h.h\"\nint f2(T* t) { return t->a + 1; }\n";
            const app = "module app;\nimport x;\nimport w;\nstruct S { import x; }\n"
                + "void main() { T t; f1(&t); f2(&t); }\n";
            const runs = await sequence({ "h.h": "typedef struct { int a; } T;\n", "c1.c": c1, "c2.c": c2,
                "x.d": "module x;\npublic import c1;\n", "w.d": "module w;\npublic import c2;\n", "app.d": app,
                "other.d": "module other;\nvoid main() {}\n" }, [
                { args: ARGS },
                { args: ["-c", "-o-", "-verrors=0", "other.d"] },
                { args: ARGS },
                { files: { "c2.c": c2 + "int g2(T t) { return t.a; }\n" }, args: ARGS },
            ]);
            expectFresh(runs, "fkkk");
        });

    test("an edited root still calling an imported auto function: its kept semantic3 replays at the call", async () => {
        // the kept function's type holds the inferred return type, so only `keepInfers` sends the call to semantic3
        const lib = "module lib;\ndeprecated(\"d\") void old() {}\nauto af() { old(); return 1; }\n"
            + "auto bf() { old(); return 2; }\n";
        const app = "module app;\nimport lib;\nvoid main() { auto r = af(); }\n";
        const runs = await sequence({ "lib.d": lib, "app.d": app }, [
            { args: ARGS },
            { files: { "app.d": "// moved\n" + app }, args: ARGS },
            { files: { "app.d": app.replace("auto r", "auto s = bf(); auto r") }, args: ARGS },
        ]);
        expectFresh(runs, "fkk");
        expect(runs[1]!.kept.stderr).toContain("lib.d(3): Deprecation: function `lib.old` is deprecated - d");
        expect(runs[2]!.kept.stderr.indexOf("lib.d(4)")).toBeLessThan(runs[2]!.kept.stderr.indexOf("lib.d(3)"));
    });

    test("a constraint's lambda, analysed while its instance was matched, replays before the instance's creation",
        async () => {
            // std.range's ZipShortest: matching `Box!(true, int, int)` tries the first template, whose constraint's
            // lambda has the instance being matched as its parent (dmd/templatesem.d evaluateConstraint), then
            // creates the instance from the second
            const lib = "module lib;\ndeprecated(\"d\") void old() {}\n"
                + "template Box(T...) if (__traits(compiles, { static assert(is(T[0])); })) {\n"
                + "    alias Box = .Box!(true, T);\n}\n"
                + "struct Box(bool b, T...) if (T.length) { T v; }\n"
                + "auto make(T...)(T args) { old(); return Box!(T)(args); }\n";
            const app = "module app;\nimport lib;\nvoid main() { auto b = make(1, 2); }\n";
            const runs = await sequence({ "lib.d": lib, "app.d": app }, [
                { args: ARGS },
                { args: ARGS },
                { files: { "app.d": "// moved\n" + app }, args: ARGS },
            ]);
            expectFresh(runs, "fkk");
            expect(runs[2]!.kept.stderr).toContain("lib.d(7): Deprecation: function `lib.old` is deprecated - d");
        });

    test("a function template's constraint lambda, made again by every edit of the root, is not kept past it",
        async () => {
            // the lambda's parent is the deduction's temporary instance (dmd/templatesem.d:3529-3530), which is never
            // created: once its requester dies with the root, nothing reaches it
            const lib = "module lib;\nvoid f(T)(T x) if (__traits(compiles, { T y; })) {}\n"
                + "auto make(T)(T a) { f(1); return a; }\n";
            const app = (pad: string): string =>
                `module app;\nimport lib;\n${pad}struct S {}\nvoid main() { make(S()); }\n`;
            const runs = await sequence({ "lib.d": lib, "app.d": app("") }, [
                { args: ARGS },
                { files: { "app.d": app("// 1\n") }, args: ARGS },
                { files: { "app.d": app("// 2\n") }, args: ARGS },
                { files: { "app.d": app("// 3\n") }, args: ARGS },
            ]);
            expectFresh(runs, "fkkk");
            expect(runs[3]!.kept.unitsKept).toBe(runs[1]!.kept.unitsKept);
        });

    test("the diagnostic handler gets a fresh compile's calls, with their arguments", async () => {
        const runs = await sequence({ "lib.d": LIB_DEPRECATED, "app.d": APP }, [
            { args: ARGS },
            { files: { "app.d": "// moved\n" + APP }, args: ARGS },
            { files: { "app.d": APP.replace("w.f();", "w.f(); int unused = 1 + ;") }, args: ARGS },
        ], (header) => header.startsWith("Deprecation"));
        expectFresh(runs, "fkk");
        for (const r of runs)
            expect(r.calls!.kept).toEqual(r.calls!.fresh);
        expect(runs[1]!.calls!.kept.some((c) => c.includes("lib.d(5) Deprecation: "))).toBe(true);
        expect(runs[1]!.kept.stderr).not.toContain("Deprecation:");
    });
});

describe("djsMainKept — DjsOptions.texts: a buffer compiled in place of its file", () => {
    test("the override's errors, not the disk's; the handler's calls a fresh compile's", async () => {
        const typo = APP.replace("w.f();", "w.g();");
        const runs = await sequence({ "lib.d": LIB_DEPRECATED, "app.d": APP }, [
            { args: ARGS },
            { args: ARGS, texts: { "app.d": typo } },
        ], (header) => header.startsWith("Error"));
        expectFresh(runs, "fk");
        expect(runs[1]!.calls!.kept).toEqual(runs[1]!.calls!.fresh);
        expect(runs[1]!.calls!.kept.some((c) => c.includes("app.d(5) Error: ") && c.includes("g"))).toBe(true);
        expect(runs[0]!.calls!.kept.some((c) => c.includes("Error: "))).toBe(false);
    });

    test("override -> disk with the same bytes keeps the root; -> another override analyses it again", async () => {
        const edited = APP.replace("w.f();", "w.f(); w.f();");
        const runs = await sequence({ "lib.d": LIB_DEPRECATED, "app.d": APP }, [
            { args: ARGS },
            { args: ARGS, texts: { "app.d": edited } },
            { files: { "app.d": edited }, args: ARGS },
            { args: ARGS, texts: { "app.d": APP } },
            { args: ARGS, texts: { "app.d": edited } },
        ]);
        expectFresh(runs, "fkkkk");
        // the saved buffer has the bytes the override had: nothing changed, though the file's stat did
        expect(runs.map((r) => r.kept.seeds["file"] ?? 0)).toEqual([0, 1, 0, 1, 1]);
        expect(runs[2]!.kept.stderr).toBe(runs[1]!.kept.stderr);
    });

    test("a call without texts after one with texts reads the disk", async () => {
        const runs = await sequence({ "lib.d": LIB_DEPRECATED, "app.d": APP }, [
            { args: ARGS, texts: { "app.d": APP.replace("w.f();", "w.g();") } },
            { args: ARGS },
        ]);
        expectFresh(runs, "fk");
        expect(runs[0]!.kept.stderr).toContain("no property `g`");
        expect(runs[1]!.kept.stderr).not.toContain("no property `g`");
        expect(runs[1]!.kept.seeds["file"]).toBe(1);
    });

    test("a key and a command line spelled through a symbolic link (/tmp, /private/tmp): one file", async () => {
        const tmp = mkdtempSync("/tmp/djs-texts-");
        try {
            writeFileSync(join(tmp, "app.d"), "module app;\nvoid main() {}\n");
            vi.resetModules();
            const djs = await import("./djs.js");
            const buffer = "module app;\nvoid main() { undefinedName(); }\n";
            const run = (root: string, key: string): string => capture(() => djs.djsMainKept(["-c", "-o-",
                join(root, "app.d")], undefined, { texts: new Map([[join(key, "app.d"), buffer]]) })).stderr;
            const real = realpathSync(tmp);
            expect(real).not.toBe(tmp);
            expect(run(real, tmp)).toContain("undefined identifier `undefinedName`");
            expect(run(tmp, real)).toContain("undefined identifier `undefinedName`");
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    test("a kept module overridden, then its file again: analysed from each", async () => {
        const lib = LIB_DEPRECATED.replace("use other", "use another");
        const runs = await sequence({ "lib.d": LIB_DEPRECATED, "app.d": APP }, [
            { args: ARGS },
            { args: ARGS, texts: { "lib.d": lib } },
            { args: ARGS },
        ]);
        expectFresh(runs, "fkk");
        expect(runs[1]!.kept.stderr).toContain("is deprecated - use another");
        expect(runs[2]!.kept.stderr).toContain("is deprecated - use other");
    });
});

/** `-i` modules: `lib`'s bodies, analysed only when it is compiled, report `dep`'s deprecation, one in an instance. */
const I_DEP = "module dep;\ndeprecated(\"use other\") int old() { return 1; }\n";
const I_LIB = `module lib;
import dep;
int use() { return old(); }
struct W(T) { T x; int f() { return old(); } }
int viaW() { W!int w; return w.f(); }
`;
const I_APP = "module app;\nimport lib;\nvoid main() { auto x = use(); }\n";
const I_ARGS = ["-i", "-c", "-o-", "-verrors=0", "app.d"];

describe("djsMainKept — -i, the imports compiled as roots (dmd/compiler.d:140, dmd/main.d:753-764)", () => {
    test("a compiled import's bodies, the root edited, the compiled import edited and restored", async () => {
        const lib2 = I_LIB.replace("int use()", "int more() { return old() + 1; }\nint use()");
        const runs = await sequence({ "dep.d": I_DEP, "lib.d": I_LIB, "app.d": I_APP }, [
            { args: I_ARGS },
            { args: I_ARGS },
            { files: { "app.d": "// moved\n" + I_APP }, args: I_ARGS },
            { files: { "lib.d": lib2 }, args: I_ARGS },
            { files: { "lib.d": I_LIB }, args: I_ARGS },
        ]);
        expectFresh(runs, "fkkkk");
        expect(runs[1]!.kept.stderr).toContain("lib.d(3): Deprecation: function `dep.old` is deprecated - use other");
        expect(runs[1]!.kept.stderr).toContain("lib.d(4): Deprecation: function `dep.old` is deprecated - use other");
        expect(runs[3]!.kept.stderr).toContain("lib.d(3): Deprecation: function `dep.old` is deprecated - use other");
    });

    test("an import added, then dropped: its bodies are compiled, then not", async () => {
        const extra = "module extra;\nimport dep;\nint value() { return old(); }\n";
        const runs = await sequence({ "dep.d": I_DEP, "lib.d": I_LIB, "app.d": I_APP, "extra.d": extra }, [
            { args: I_ARGS },
            { files: { "app.d": I_APP.replace("import lib;", "import lib;\nimport extra;") }, args: I_ARGS },
            { files: { "app.d": I_APP }, args: I_ARGS },
        ]);
        expectFresh(runs, "fkk");
        expect(runs[1]!.kept.stderr).toContain("extra.d(3): Deprecation: function `dep.old` is deprecated");
        expect(runs[2]!.kept.stderr).not.toContain("extra.d");
    });

    test("the root infers a compiled import's auto function and method, before the import's semantic3", async () => {
        const lib = `module lib;
import dep;
int plain() { return old(); }
auto af() { return old(); }
struct S { auto m() { return old(); } }
`;
        const app = (body: string): string => `module app;\nimport lib;\n${body}\nvoid main() {}\n`;
        const runs = await sequence({ "dep.d": I_DEP, "lib.d": lib, "app.d": app("") }, [
            { args: I_ARGS },
            { files: { "app.d": app("alias R = typeof(af());") }, args: I_ARGS },
            { files: { "app.d": app("void g() { S s; auto r = s.m(); }") }, args: I_ARGS },
            { files: { "app.d": app("") }, args: I_ARGS },
            { files: { "app.d": app("void g() { auto r = af(); }") }, args: I_ARGS },
        ]);
        expectFresh(runs, "fkkkk");
        expect(runs[1]!.kept.stderr.indexOf("lib.d(4)")).toBeLessThan(runs[1]!.kept.stderr.indexOf("lib.d(3)"));
        expect(runs[2]!.kept.stderr.indexOf("lib.d(5)")).toBeLessThan(runs[2]!.kept.stderr.indexOf("lib.d(3)"));
    });

    test("-i= patterns: only the included modules are compiled", async () => {
        const args = ["-i=lib", "-c", "-o-", "-verrors=0", "app.d"];
        const runs = await sequence({ "dep.d": I_DEP + "int old2() { return old(); }\n",
            "lib.d": I_LIB, "app.d": I_APP }, [
            { args },
            { files: { "app.d": "// moved\n" + I_APP }, args },
        ]);
        expectFresh(runs, "fk");
        expect(runs[1]!.kept.stderr).toContain("lib.d(3): Deprecation");
        expect(runs[1]!.kept.stderr).not.toContain("dep.d(3)");   // old2, analysed only if dep were compiled
    });
});

describe("djsMainKept — an unchanged recompile prints what the first compile printed (dmd corpus cases)", () => {
    // An editor's re-save of an unchanged file: the second compile replays the first. Sources from
    // tests/dmd/fail_compilation (the file named in each title), trimmed to what reproduces.
    const OWN_OBJECT = "module object;\nclass Object { }\nclass TypeInfo { }\nclass TypeInfo_AssociativeArray%s\n"
        + "extern(C) int main()\n{\n    int[int] aa;\n    return 0;\n}\n";

    test.each([
        ["test20863a.d", " { }", 7],
        ["test20863b.d", "\n{\n    int Entry;\n    struct aaOpEqual(K, V) { }\n    struct aaGetHash(K, V) { }\n}", 12],
    ])("%s: an AA type's TypeInfo hooks, missing from the root's own object", async (file, members, line) => {
        const args = ["-c", "-o-", "-verrors=0", file];
        const runs = await sequence({ [file]: OWN_OBJECT.replace("%s", members) }, [{ args }, { args }]);
        expectFresh(runs, "fk");
        expect(runs[1]!.kept.stderr).toContain(`${file}(${line}): Error: `);
    });

    test("fail15896.d: a selective import of members not visible, under -de", async () => {
        const args = ["-de", "-c", "-o-", "-verrors=0", "fail15896.d"];
        const runs = await sequence({
            "imports/imp15896.d": "module imports.imp15896;\n\nprivate int thebar=4;\npackage int packagebar=3;\n",
            "fail15896.d": "import imports.imp15896 : thebar, packagebar;\n\nint func()\n{\n    thebar +=1;\n"
                + "    packagebar += 1;\n    thebar +=1;\n    return 0;\n}\n",
        }, [{ args }, { args }]);
        expectFresh(runs, "fk");
        expect(runs[1]!.kept.stderr).toContain("member `thebar` is not visible from module `fail15896`");
    });

    test("fail18243.d: an overload set across two imports", async () => {
        const args = ["-c", "-o-", "-verrors=0", "fail18243.d"];
        const runs = await sequence({
            "imports/a18243.d": "module imports.a18243;\n\nimport imports.b18243 : isNaN;\n\n"
                + "public bool isNaN() { return false; }\n",
            "imports/b18243.d": "module imports.b18243;\n\nbool isNaN(T)(T x) { return false; }\n",
            "fail18243.d": "module fail18243;\n\nimport imports.a18243;\n\nvoid main()\n{\n"
                + "    bool b = isNaN(float.nan);\n}\n",
        }, [{ args }, { args }]);
        expectFresh(runs, "fk");
        expect(runs[1]!.kept.stderr).toContain("none of the overloads of `isNaN` are callable");
    });

    test("test18127.d: C structs of one name from two imports, merged, a bit-field's name differs", async () => {
        const args = ["-c", "-o-", "-verrors=0", "test18127.d"];
        const runs = await sequence({
            "imports/imp18127a.c": "struct S_bitfields_anon {\n    unsigned x: 3;\n    unsigned : 1;\n};\n",
            "imports/imp18127b.c": "struct S_bitfields_anon {\n    unsigned x: 3;\n    unsigned y: 1;\n};\n",
            "test18127.d": "import imports.imp18127a;\nimport imports.imp18127b;\n",
        }, [{ args }, { args }]);
        expectFresh(runs, "fk");
        expect(runs[1]!.kept.stderr).toContain("Field 1 differs in name");
    });

    test.each([
        ["fail11453a.d", { "fail11453a.d": "void main() {}\n", "foo11453.d": "module foo11453;\n",
            "bar11453.d": "module foo11453.bar11453;\n" }],
        ["ice11136.d", { "ice11136.d": "module ice11136;\n", "bar11136.d": "module ice11136.bar11136;\n" }],
    ])("%s: a root module whose name another root uses as a package", async (_, files) => {
        const args = ["-c", "-o-", "-verrors=0", ...Object.keys(files)];
        const runs = await sequence(files, [{ args }, { args }]);
        expectFresh(runs, "fk");
        expect(runs[1]!.kept.stderr).toContain("conflicts with usage as a module name");
    });
});

describe("djsMainKept — what the end-of-compile semantic3 analyses: an AA type's TypeInfo, a struct's RTInfo", () => {
    // A root `object` whose TypeInfo_AssociativeArray has hooks that print: the TypeInfo's semantic3 reports at its
    // type's `loc`, the type table entry's, which a fresh compile takes from the type's first merge in the compile
    const NO_HOOKS = "module object;\nclass Object { }\nclass TypeInfo { }\nclass TypeInfo_AssociativeArray { }\n";
    const DEPRECATED_ENTRY = "module object;\nalias size_t = typeof(int.sizeof);\nclass Object { }\n"
        + "class TypeInfo { }\nclass TypeInfo_Struct : TypeInfo { }\nclass TypeInfo_AssociativeArray {\n"
        + "    deprecated(\"old Entry\") struct Entry(K, V) { K k; V v; }\n"
        + "    static size_t aaGetHash(K, V)(scope const void* p) { return 0; }\n"
        + "    static bool aaOpEqual(K, V)(scope const void* p, scope const void* q) { return true; }\n}\n";

    test("lines inserted above the AA type: the TypeInfo's errors at the type's new line", async () => {
        const app = (pre: string): string =>
            `module app;\n${pre}extern(C) int main()\n{\n    int[int] aa;\n    return 0;\n}\n`;
        const args = ["-c", "-o-", "-verrors=0", "app.d", "object.d"];
        const runs = await sequence({ "object.d": NO_HOOKS, "app.d": app("") }, [
            { args }, { files: { "app.d": app("\n\n") }, args }, { args },
        ]);
        expectFresh(runs, "fkk");
        expect(runs[1]!.kept.stderr).toContain("app.d(6): Error: no property `Entry`");
    });

    test("the module that first named the AA type no longer imported: its first merge is the root's", async () => {
        const args = ["-c", "-o-", "-verrors=0", "app.d", "object.d"];
        const runs = await sequence({ "object.d": DEPRECATED_ENTRY, "lib.d": "module lib;\nalias AA = int[int];\n",
            "app.d": "module app;\nimport lib;\nvoid g() { AA b; }\n" }, [
            { args }, { files: { "app.d": "module app;\nvoid g() { int[int] b; }\n" }, args }, { args },
        ]);
        expectFresh(runs, "fkk");
        expect(runs[1]!.kept.stderr).toContain("app.d(2): Deprecation: struct `object.TypeInfo_AssociativeArray.Entry");
    });

    test("the AA type's first merge moves to another kept module: the TypeInfo's semantic3 runs again", async () => {
        // no file changes: the roots are reordered; b's request of the TypeInfo replays with its scope, and the
        // type's loc is c's now, so the semantic3 recorded at a's runs for real
        const files = { "object.d": DEPRECATED_ENTRY, "a.d": "module a;\nalias AA = int[int];\n",
            "c.d": "module c;\n\nalias CC = int[int];\n", "b.d": "module b;\nvoid g() { int[int] y; }\n" };
        const args = (...roots: string[]): string[] => ["-c", "-o-", "-verrors=0", ...roots, "b.d", "object.d"];
        const runs = await sequence(files, [{ args: args("a.d", "c.d") }, { args: args("c.d", "a.d") }]);
        expectFresh(runs, "fk");
        expect(runs[1]!.kept.stderr).toContain("c.d(3): Deprecation: struct `object.TypeInfo_AssociativeArray.Entry");
    });

    test("the AA type's first merge in a template's body, merged already: its loc is the new instance's", async () => {
        // `int[int]` in use's body is one object for every instance (syntaxCopy), the table entry since the first
        // compile; app's edits move the type's first merge to app and back to a new instance of use
        const args = ["-c", "-o-", "-verrors=0", "app.d", "object.d"];
        const app = (body: string): string => `module app;\nimport lib;\n${body}`;
        const runs = await sequence({ "object.d": DEPRECATED_ENTRY,
            "lib.d": "module lib;\n\n\nvoid use(X)() { int[int] b; }\n", "app.d": app("void g() { use!int(); }\n") }, [
            { args },
            { files: { "app.d": app("void f() { int[int] x; }\nvoid g() { use!int(); }\n") }, args },
            { files: { "app.d": app("void g() { use!char(); }\n") }, args },
            { args },
        ]);
        expectFresh(runs, "fkkk");
        expect(runs[2]!.kept.stderr).toContain("lib.d(4): Deprecation: struct `object.TypeInfo_AssociativeArray.Entry");
    });

    test("the TypeInfo's creating request moves to an edited module: its semantic3 runs with that scope", async () => {
        const args = ["-c", "-o-", "-verrors=0", "y.d", "x.d", "lib.d", "object.d"];
        const runs = await sequence({ "object.d": DEPRECATED_ENTRY, "lib.d": "module lib;\nalias AA = int[int];\n",
            "x.d": "module x;\nimport lib;\ndeprecated void f() { AA a; }\n",
            "y.d": "module y;\nimport lib;\nvoid g() { }\n" }, [
            { args }, { files: { "y.d": "module y;\nimport lib;\nvoid g() { AA b; }\n" }, args }, { args },
        ]);
        expectFresh(runs, "fkk");
    });

    test("a library struct's RTInfo, made outside every unit, is made again by each compile", async () => {
        // the struct's TypeInfo members are deferred to the end of the compile (a library struct with a destructor),
        // where semanticRTInfo instantiates RTInfo!S, whose deprecation prints
        const obj = "module object;\nclass Object { }\nclass TypeInfo { }\nclass TypeInfo_Struct : TypeInfo { }\n"
            + "template RTInfo(T) { deprecated(\"old\") enum RTInfo = null; }\n";
        const app = "module app;\nimport lib;\nvoid f() { auto t = typeid(S); }\n";
        const args = ["-c", "-o-", "-verrors=0", "app.d", "object.d"];
        const runs = await sequence({ "object.d": obj, "lib.d": "module lib;\nstruct S { int x; ~this() { } }\n",
            "app.d": app }, [{ args }, { args }, { files: { "app.d": "// moved\n" + app }, args }]);
        expectFresh(runs, "fkk");
        expect(runs[1]!.kept.stderr).toContain("`object.RTInfo!(S).RTInfo` is deprecated");
    });
});

describe("djsMainKept — what it does not keep, and says why", () => {
    test("an instance one request created and the same request matches in the next compile aborts", async () => {
        // lib's function body creates T!ubyte and runs its semantic3 there; the root's module-level request creates
        // it first, and lib's then matches, whose replay would run the instance's semantic3 inside lib's body
        const lib = `module lib;
deprecated("d") void old() {}
struct T(U) { U v; void f() { old(); } }
void lf() { T!ubyte u; old(); }
`;
        const app = "module app;\nimport lib;\nvoid main() {}\n";
        const withT = app.replace("void main", "T!ubyte gu;\nvoid main");
        for (const args of [I_ARGS, ["-c", "-o-", "-verrors=0", "app.d", "lib.d"]]) {
            const runs = await sequence({ "lib.d": lib, "app.d": app }, [
                { args },
                { files: { "app.d": withT }, args },
                { files: { "app.d": app }, args },
            ]);
            expectFresh(runs, "fff");
            for (const r of runs.slice(1))
                expect(r.kept.reason).toMatch(/^abort: creation of lib\.T!ubyte requested in another state: /);
        }
    });

    // -vcg-ast: a kept compile's module members are not a fresh one's (10 §4.7, the refused flags), so its dump would
    // differ
    test.each(["-vtemplates", "-vcg-ast"])("a refused flag compiles fresh and names the flag: %s", async (flag) => {
        const runs = await sequence({ "lib.d": LIB_DEPRECATED, "app.d": APP }, [
            { args: ARGS },
            { args: [flag, ...ARGS] },
        ]);
        expectFresh(runs, "ff");
        expect(runs[1]!.kept.reason).toMatch(new RegExp(`^refused flag ${flag}: `));
    });

    test("a printed generated name numbered otherwise in this compile aborts to fresh", async () => {
        // the lowered foreach's `__r`/`__key` in a kept instance's gagged error, printed by -verrors=spec, keep the
        // numbers of the compile that recorded them; the edited root consumes more before it
        const lib = "module lib;\nenum bool ok(T) = __traits(compiles, () { T[3][2] m; foreach (T[5] row; m) {} });\n";
        const app = "module app;\nimport lib;\nvoid main() { static assert(!ok!int); }\n";
        const args = ["-c", "-o-", "-verrors=spec", "app.d"];
        const runs = await sequence({ "lib.d": lib, "app.d": app }, [
            { args },
            { files: { "app.d": app.replace("void main", "void g() { int[] a; foreach (x; a) {} }\nvoid main") },
                args },
        ]);
        expectFresh(runs, "ff");
        expect(runs[1]!.kept.reason).toMatch(/^abort: .* prints a generated name, numbered otherwise in this compile$/);
    });

    test("a value made of a generated name numbered otherwise aborts to fresh", async () => {
        // `__traits(allMembers)` names the anonymous bit-field `__anonBitField3` and a lambda's `.stringof` its
        // generated name: kept, both keep the recording's numbers; the root's new lambda takes one before them
        const lib = "module lib;\nstruct S { int a : 3; int : 5; int b; }\nenum m1 = [__traits(allMembers, S)];\n"
            + "alias L = (a) => a;\nenum m4 = L.stringof;\n";
        const app = "module app;\nimport lib;\npragma(msg, m1[1], \" \", m4);\n"
            + "static if (m1[1] == \"__anonBitField3\") int three; else int other;\n"
            + "pragma(msg, \"branch three: \", __traits(compiles, three));\n";
        const args = ["-c", "-o-", "-verrors=0", "-i", "app.d"];
        const runs = await sequence({ "lib.d": lib, "app.d": app }, [
            { args },
            { files: { "app.d": app.replace("pragma", "alias pre = (x, y) => x;\npragma") }, args },
            { files: { "app.d": app }, args },
        ]);
        expectFresh(runs, "fff");
        expect(runs[1]!.fresh.stdout + runs[1]!.fresh.stderr).toContain("branch three: false");
        for (const r of runs.slice(1))
            expect(r.kept.reason).toMatch(/^abort: .* generated name, numbered otherwise in this compile$/);
    });

    test("a live unit's string naming a kept module's generated identifier numbered otherwise aborts to fresh",
        async () => {
            // app's pragma runs live after the edit and reads lib's names, which lib's parse and analysis numbered
            // in the first compile; the new lambda takes a `__T` before them
            const lib = "module lib;\nstruct S { int a : 3; int : 5; int b; }\nalias L = (a) => a;\n";
            const app = "module app;\nimport lib;\npragma(msg, [__traits(allMembers, S)][1], \" \", L.stringof);\n";
            const args = ["-c", "-o-", "-verrors=0", "-i", "app.d"];
            const runs = await sequence({ "lib.d": lib, "app.d": app }, [
                { args },
                { files: { "app.d": app.replace("pragma", "alias pre = (x, y) => x;\npragma") }, args },
            ]);
            expectFresh(runs, "ff");
            expect(runs[1]!.kept.reason).toMatch(/^abort: a string made in this compile names `__\w+\d`/);
        });

    test("strings that look generated but do not depend on the counter keep the compile kept", async () => {
        // an instance's mangle (`__T3Box`), a lambda's location name, `__FUNCTION__` in a lambda, a CTFE-built
        // declaration of `__x1`: none is an identifier the counter made
        const lib = "module lib;\nstruct Box(T) { T v; }\nenum m = Box!int.mangleof;\nalias L = (a) => a;\n"
            + "enum s = __traits(identifier, L);\nauto who() { auto dg = () => __FUNCTION__; return dg(); }\n"
            + "enum w = who();\nstring decl(string n) { return \"int \" ~ n ~ \" = 1;\"; }\nmixin(decl(\"__x1\"));\n";
        const app = "module app;\nimport lib;\npragma(msg, m, \" \", s, \" \", w, \" \", __x1);\n";
        const args = ["-c", "-o-", "-verrors=0", "-i", "app.d"];
        const runs = await sequence({ "lib.d": lib, "app.d": app }, [
            { args },
            { files: { "app.d": app.replace("pragma", "alias pre = (x) => x;\nint pre2(int[] q) { int t; "
                + "foreach (y; q) t += y; return t; }\npragma") }, args },
        ]);
        expectFresh(runs, "fk");
    });

    test("an unchanged recompile renumbers nothing: a segment starts at its first number, a parse inside it",
        async () => {
            // the function-local `import lz` parses lz.d, whose lambdas take numbers, between `use`'s `__r`, `__key`
            vi.resetModules();
            const djs = await import("./djs.js");
            const keep = await import("./keep.js");
            dir = mkdtempSync(join(tmpdir(), "djs-keep-"));
            writeFileSync(join(dir, "lz.d"), "module lz;\nalias inc = (a) => a + 1;\nalias dbl = (b) => b * 2;\n");
            writeFileSync(join(dir, "app.d"), "module app;\nint use() { int s; foreach (k; [1, 2]) s += k; import lz; "
                + "return s + inc(1) + dbl(2); }\n");
            const args = ["-c", "-o-", "-verrors=0", `-I${dir}`, join(dir, "app.d")];
            capture(() => djs.djsMainKept(args));
            const second = capture(() => djs.djsMainKept(args)).value;
            expect([second.mode, keep.keepRenumbered()]).toEqual(["kept", false]);
        });

    test("a C module whose preprocessor writes compiles fresh", async () => {
        // cc writes to the inherited stderr (outside the captured streams): a kept compile, running no preprocessor,
        // would not
        const runs = await sequence({ "shim.c": "int three(void) { return 3; }\n#warning \"from cpp\"\n",
            "app.d": "module app;\nimport shim;\nint main() { return three(); }\n" }, [
            { args: ARGS },
            { args: ARGS },
        ]);
        expectFresh(runs, "ff");
        expect(runs[1]!.kept.reason).toBe("the C preprocessor writes for shim.c");
    });

    test("a C module the kept compile reads, whose preprocessor writes, aborts to fresh", async () => {
        const runs = await sequence({ "shim.c": "int three(void) { return 3; }\n",
            "warn.c": "int four(void) { return 4; }\n#warning \"from cpp\"\n",
            "app.d": "module app;\nimport shim;\nint main() { return three(); }\n" }, [
            { args: ARGS },
            { files: { "app.d": "module app;\nimport shim;\nimport warn;\nint main() { return three() + four(); }\n" },
                args: ARGS },
        ]);
        expectFresh(runs, "ff");
        expect(runs[1]!.kept.reason).toBe("abort: the C preprocessor writes for warn.c");
    });

    test("two C modules' types of one name: one mangling, given by the module loaded first", async () => {
        // an ImportC enum mangles without its module: each `E` takes the table entry of the first one merged, which
        // a kept compile may hold from a module it does not load, or loads in another order
        const app = (imports: string, use: string): string => `module app;\n${imports}\nvoid main() { ${use} }\n`;
        const both = app("import c1;\nimport c2;", "auto x = c1.E.A1;");
        const runs = await sequence({ "c1.c": "typedef enum {A1} E;\n", "c2.c": "typedef enum {A2, B2} E;\n",
            "app.d": app("import c1;", "E x = E.A1;") }, [
            { args: ARGS },
            { files: { "app.d": app("import c2;", "E x = E.B2;") }, args: ARGS },
            { files: { "app.d": both }, args: ARGS },
            { files: { "app.d": "// moved\n" + both }, args: ARGS },
            { files: { "app.d": app("import c2;", "E x = E.B2;") }, args: ARGS },
        ]);
        expectFresh(runs, "fffkf");
        expect(runs[1]!.kept.reason).toBe("abort: c2.E of c2 has the type of c1.E of c1, not loaded (C types mangle "
            + "without their module)");
        expect(runs[4]!.kept.reason).toBe("abort: c2 took C types of c1, which this compile does not load");
        expect(runs[4]!.kept.code).toBe(0);
    });

    test("a C struct merged with a kept one whose size a fresh compile has not finalized there aborts", async () => {
        // fail_compilation/test18127.d with the second import added by an edit: the kept struct's size was finalized
        // by its module's semantic2, which drops the anonymous bit-field from the field list the merge compares
        const struct = (field: string): string => `struct S_bitfields_anon {\n    unsigned x: 3;\n    ${field}\n};\n`;
        const runs = await sequence({ "imports/imp18127a.c": struct("unsigned : 1;"),
            "imports/imp18127b.c": struct("unsigned y: 1;"), "app.d": "import imports.imp18127a;\n" }, [
            { args: ARGS },
            { files: { "app.d": "import imports.imp18127a;\nimport imports.imp18127b;\n" }, args: ARGS },
            { args: ARGS },
        ]);
        expectFresh(runs, "ffk");
        expect(runs[1]!.kept.reason).toBe("abort: imp18127b.S_bitfields_anon of imp18127b reads "
            + "imp18127a.S_bitfields_anon of imp18127a, whose size a fresh compile has not finalized here");
        expect(runs[2]!.kept.stderr).toContain("Field 1 differs in name");
    });

    test("a root added that names a kept root as its package aborts; dropped again, the kept root keeps", async () => {
        // ice11136.d: bar's name makes ice's symbol table a package's before ice's importAll, which then adds no
        // members (dmd/dsymbolsem.d:8412); the kept ice holds its members' table
        const files = { "ice.d": "module ice;\nint x;\n", "bar.d": "module ice.bar;\n",
            "app.d": "import ice;\nvoid main() { x = 1; }\n" };
        const two = ["-c", "-o-", "-verrors=0", "app.d", "ice.d"];
        const runs = await sequence(files, [
            { args: two }, { args: [...two, "bar.d"] }, { args: [...two, "bar.d"] }, { args: two },
        ]);
        expectFresh(runs, "ffkk");
        expect(runs[1]!.kept.reason).toBe("abort: ice used as a package, its symbol table not a fresh compile's");
        expect(runs[3]!.kept.code).toBe(0);
    });

    test("an imported module named as a package after its importAll: its members' table loses the entry", async () => {
        // foo's importAll ran before foo.bar's parse used foo as a package (an error): its members' table got the
        // entry; the imports reordered, foo.bar's name comes first, and foo's registration conflicts (an abort)
        const app = (imports: string): string => `module app;\n${imports}\nvoid main() { x = 1; }\n`;
        const args = ["-c", "-o-", "-verrors=0", "-I.", "app.d"];
        const runs = await sequence({ "foo.d": "module foo;\nint x;\n", "foo/bar.d": "module foo.bar;\nint y;\n",
            "app.d": app("import foo;\nimport foo.bar;") }, [
            { args }, { args }, { files: { "app.d": app("\nimport foo;\nimport foo.bar;") }, args },
            { files: { "app.d": app("import foo.bar;\nimport foo;") }, args }, { args },
            { files: { "app.d": app("import foo;") }, args },
            { files: { "app.d": app("import foo;\nimport foo.bar;") }, args },
        ]);
        expectFresh(runs, "fkkfkkf");
        expect(runs[3]!.kept.reason).toBe("abort: module tree conflict on foo");
    });

    test("a changed command line compiles fresh", async () => {
        const runs = await sequence({ "lib.d": LIB_DEPRECATED, "app.d": APP }, [
            { args: ARGS },
            { args: ["-de", ...ARGS] },
        ]);
        expectFresh(runs, "ff");
        expect(runs[1]!.kept.reason).toBe("the command line changed");
    });

    test("a root whose parse reported is parsed again: the module tree conflicts follow the root order", async () => {
        // fail_compilation/fail11453a.d, then fail11453b.d
        const files = { "app.d": "void main() {}\n", "foo.d": "module foo;\n", "bar.d": "module foo.bar;\n" };
        const runs = await sequence(files, [
            { args: ["-c", "-o-", "app.d", "foo.d", "bar.d"] },
            { args: ["-c", "-o-", "app.d", "bar.d", "foo.d"] },
        ]);
        expectFresh(runs, "ff");
        expect(runs[1]!.kept.reason).toBe("abort: module tree conflict on foo");
        expect(runs[1]!.kept.stderr).toContain("module `foo` from file foo.d conflicts with package name foo");
    });

    test("the abort path: a new module named as a kept one, then the fresh compile, its output unduplicated",
        async () => {
            const own = "module object;\nclass Object {}\nvoid test() { Object o; auto ti = typeid(o); }\n";
            const runs = await sequence({ "app.d": "void main() { int[] a; auto t = typeid(a); }\n", "own.d": own }, [
                { args: ["-c", "-o-", "app.d"] },
                { args: ["-c", "-o-", "own.d"] },
            ]);
            expectFresh(runs, "ff");
            expect(runs[1]!.kept.reason).toMatch(/^abort: object from own\.d has the name of a kept module/);
        });
});
