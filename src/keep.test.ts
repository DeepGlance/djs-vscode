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
    modulesDead: number;
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
 * `suppress`, each registry gets a diagnostic handler that records its calls and answers `suppress(header)`. With
 * `editor`, both compile in editor mode (a fatal handler answering true, 10 §4.7), else as the CLI.
 */
async function sequence(files: Record<string, string>, steps: Step[], suppress?: (header: string) => boolean,
    editor = false): Promise<{ kept: KeptRun; fresh: Run; calls?: { kept: HandlerCalls; fresh: HandlerCalls } }[]> {
    const onFatal = editor ? (): boolean => true : undefined;
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
            const k = capture(() => keeping.djsMainKept(s.args, onFatal, options));
            const f = capture(() => reference.djsMain(s.args, onFatal, options));
            out.push({
                kept: { code: k.value.status, stdout: k.stdout, stderr: k.stderr, mode: k.value.mode,
                    reason: k.value.reason, unitsKept: k.value.stats.unitsKept,
                    modulesDead: k.value.stats.modulesDead, seeds: k.value.stats.seeds },
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

    test("an instance made after an error, which looked for no copy constructor, is made again (clone.d:1688)",
        async () => {
            const lib = "module lib;\nstruct P { this(this) {} }\n"
                + "struct W(T) { P p; T t; this(ref return scope W rhs) {} }\n";
            const app = (decls: string): string => `module app;\nimport lib;\n${decls}\nvoid main() {}\n`;
            const runs = await sequence({ "lib.d": lib, "app.d": app("") }, [
                { args: ARGS },
                { files: { "app.d": app("alias A = Undefined;\nalias X = W!int;") }, args: ARGS },
                { files: { "app.d": app("alias X = W!int;") }, args: ARGS },
                { args: ARGS },
            ]);
            expectFresh(runs, "fkkk");
            const hides = "`struct W` implicitly-generated postblit hides copy constructor";
            expect(runs[1]!.kept.stderr).not.toContain(hides);
            expect(runs[2]!.kept.stderr).toContain(hides);
            expect(runs[2]!.kept.seeds["error state (inst)"]).toBe(1);
        });

    test("an instance made after an error, which did not report a __traits giving no type, reports it (typesem.d:4405)",
        async () => {
            const lib = "module lib;\nstruct W(T) { __traits(isIntegral, T) x; }\n";
            const app = (decls: string): string => `module app;\nimport lib;\n${decls}\nvoid main() {}\n`;
            const runs = await sequence({ "lib.d": lib, "app.d": app("") }, [
                { args: ARGS },
                { files: { "app.d": app("alias A = Undefined;\nalias X = W!int;") }, args: ARGS },
                { files: { "app.d": app("alias X = W!int;") }, args: ARGS },
            ]);
            expectFresh(runs, "fkk");
            expect(runs[2]!.kept.stderr).toContain("Error: `__traits(isIntegral, int)` does not give a valid type");
            expect(runs[2]!.kept.seeds["error state (inst)"]).toBe(1);
        });

    test("a library struct's isPOD answered after an error in the root is answered again once fixed", async () => {
        const lib = "module lib;\nstruct S { int x; this(ref return scope S rhs) {} }\n";
        const app = (decls: string): string => `module app;\nimport lib;\n${decls}\nvoid main() {}\n`;
        const pod = "pragma(msg, __traits(isPOD, S));";
        const runs = await sequence({ "lib.d": lib, "app.d": app(`alias A = Undefined;\n${pod}`) }, [
            { args: ARGS },
            { files: { "app.d": app(pod) }, args: ARGS },
            { args: ARGS },
        ]);
        expectFresh(runs, "fkk");
        expect(runs[0]!.kept.stdout + runs[0]!.kept.stderr).toContain("true");
        expect(runs[1]!.kept.stdout + runs[1]!.kept.stderr).toContain("false");
        expect(runs[1]!.kept.seeds["error state cached"]).toBe(1);
    });

    test("main's appended `mixin _d_cmain!()`: its passes 2 and 3 run again in an unchanged recompile", async () => {
        // an object.d of the program's own, whose _d_cmain prints at its first pass and in C main's body (semantic3)
        const obj = "module object;\ntemplate _d_cmain() {\n    pragma(msg, \"cmain sem1\");\n"
            + "    extern(C) int main(int argc, char** argv) { pragma(msg, \"cmain body\"); return _Dmain(); }\n"
            + "    extern(C) int _Dmain();\n}\n";
        const args = ["-c", "-o-", "-verrors=0", "-I.", "app.d"];
        const runs = await sequence({ "object.d": obj, "app.d": "module app;\nint main() { return 0; }\n" },
            [{ args }, { args }, { args }]);
        expectFresh(runs, "fkk");
        expect(runs[2]!.kept.stdout + runs[2]!.kept.stderr).toBe("cmain sem1\ncmain body\n");
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

    /** A library whose `isS` instance retries the deferred symbols at its creation (dmd/templatesem.d:1888). */
    const LIB_DEFERS = "module lib;\nstruct W(T) { T value; }\ntemplate isS(T) { enum isS = is(T == string); }\n";

    /** A module whose struct waits for its own size (`W!V*`, deferred) while its analysis requests isS!string. */
    const deferring = (name: string): string => `module ${name};\nimport lib;\nstruct V {\n    W!V* next;\n    int x;\n`
        + `    enum e = isS!string;\n    pragma(msg, "${name} ", e);\n}\n`;

    /** A root importing `imports`, then requesting isS!string itself. */
    const deferringApp = (...imports: string[]): string => `module app;\nimport lib;\n`
        + `${imports.map((m) => `import ${m};\n`).join("")}enum y = isS!string;\npragma(msg, "app ", y);\n`;

    test("an import added whose struct is deferred where a kept instance that retries is first requested, then dropped",
        async () => {
            // `W!V` waits for V's size (deferred) while V's analysis requests isS!string, whose creation retries the
            // deferred symbols: kept from a compile where none were, it replays where W!V is one, and the next
            // compile, without b, where none is again. The import added again: b's kept analysis puts back W!V,
            // analysed already, among the deferred symbols, where a fresh compile's is still deferred; the list is
            // one isS!string's replay was proved under when b was first added (`prove`), so it holds without the
            // retry, which would find W!V done
            const runs = await sequence({ "lib.d": LIB_DEFERS, "b.d": deferring("b"), "app.d": deferringApp() }, [
                { args: ARGS },
                { files: { "app.d": deferringApp("b") }, args: ARGS },
                { files: { "app.d": deferringApp() }, args: ARGS },
                { files: { "app.d": deferringApp("b") }, args: ARGS },
                { args: ARGS },
                { files: { "app.d": deferringApp() }, args: ARGS },
                { files: { "app.d": deferringApp("b") }, args: ARGS },
            ]);
            expectFresh(runs, "fkkkkkk");
            expect(runs[1]!.kept.stderr).toBe("b true\napp true\n");
        });

    test("past the proved lists' bound, the list used longest ago is probed again, and a retry finding it done aborts",
        async () => {
            // isS!string proved under [] (used again at every drop), b1's W!V, then b2's, b3's, b4's: the bound (4)
            // drops b1's list, the one used longest ago; b1 added again is probed and aborts as without the lists
            const mods = ["b1", "b2", "b3", "b4"];
            const steps: Step[] = [{ args: ARGS }];
            for (const m of mods)
                steps.push({ files: { "app.d": deferringApp(m) }, args: ARGS }, { files: { "app.d": deferringApp() },
                    args: ARGS });
            steps.push({ files: { "app.d": deferringApp("b1") }, args: ARGS });
            const runs = await sequence({ "lib.d": LIB_DEFERS, "app.d": deferringApp(),
                ...Object.fromEntries(mods.map((m) => [`${m}.d`, deferring(m)])) }, steps);
            expectFresh(runs, "fkkkkkkkkf");
            expect(runs[9]!.kept.reason).toBe("abort: other deferred symbols at the replay of lib.isS!string, whose "
                + "retry of them does work");
        });

    test("a proved list a replay matches is the last one the bound drops", async () => {
        // b1's list used again at step 6 outlives b2's: past the bound, b1 added again at step 12 still keeps
        const order = ["b1", "b2", "b1", "b3", "b4", "b1"];
        const steps: Step[] = [{ args: ARGS }];
        for (const m of order)
            steps.push({ files: { "app.d": deferringApp(m) }, args: ARGS }, { files: { "app.d": deferringApp() },
                args: ARGS });
        steps.pop();
        const runs = await sequence({ "lib.d": LIB_DEFERS, "app.d": deferringApp(),
            ...Object.fromEntries(["b1", "b2", "b3", "b4"].map((m) => [`${m}.d`, deferring(m)])) }, steps);
        expectFresh(runs, "fkkkkkkkkkkk");
    });

    test("a list a retry inside an outer one proved nothing for is probed outside one", async () => {
        // f's semantic3 runs inside the root's retry (W2!R waits for R's size), where isS!string's creation retry
        // returns at once: that list is not taken as proved, so the replay from an enum outside every retry probes
        // it, and a fresh compile's order (W!L's g between) is kept
        const lib = "module lib;\nstruct W(T) { T value; void g() { pragma(msg, \"W.g \", T.stringof); } }\n"
            + "template isS(T) { enum isS = is(T == string); }\n";
        const b = "module b;\nimport lib;\nauto f() {\n    static struct L { W!L* p; int x; }\n"
            + "    return isS!string;\n}\n";
        const v1 = "module app;\nimport lib;\nenum y = isS!string;\npragma(msg, \"app \", y);\n";
        const vN = "module app;\nimport lib;\nimport b;\nstruct W2(T) { T value; void h() { enum q = f(); } }\n"
            + "struct R { W2!R* next; int x; }\n";
        const vM = "module app;\nimport lib;\nimport b;\nenum q = f();\npragma(msg, \"app \", q);\n";
        const runs = await sequence({ "lib.d": lib, "b.d": b, "app.d": v1 }, [
            { args: ARGS },
            { files: { "app.d": vN }, args: ARGS },
            { files: { "app.d": v1 }, args: ARGS },
            { files: { "app.d": vM }, args: ARGS },
        ]);
        expectFresh(runs, "fkkf");
        expect(runs[3]!.fresh.stdout + runs[3]!.fresh.stderr).toBe("W.g L\napp true\n");
    });

    test("a struct an instance deferred, completed by the module's retry before the next instance is requested",
        async () => {
            // E's field type creates Arr!E, whose struct waits for E's size (deferred) past the creation; the module's
            // retry after E (dmd/dsymbolsem.d:3872) completes it, and Arr!int, whose creation retries the deferred
            // symbols, is requested where none is: its replay must find none either (`learnDeferred`)
            const app = "module app;\nstruct Arr(T) { T[1] small; }\nstruct E { Arr!E* p; }\nArr!int g;\n"
                + "pragma(msg, Arr!E.sizeof, \" \", Arr!int.sizeof);\n";
            const runs = await sequence({ "app.d": app }, [{ args: ARGS }, { args: ARGS }]);
            expectFresh(runs, "fk");
            expect(runs[1]!.kept.stdout + runs[1]!.kept.stderr).toBe("8LU 4LU\n");
        });

    test("a library struct an alias's instance deferred, completed by the module's retry before the next instance",
        async () => {
            // E's field type names the alias Es, analysed at its first use (a non-root module's alias): its instance
            // Arr!E leaves its struct deferred past the alias's unit, which returns into lib's semantic1 (`keepUnwind`)
            const lib = "module lib;\nstruct Arr(T) { T[1] small; }\nalias Es = Arr!E;\nstruct E { Es* p; }\n"
                + "Arr!int g;\npragma(msg, Arr!E.sizeof, \" \", Arr!int.sizeof);\n";
            const runs = await sequence({ "lib.d": lib, "app.d": "module app;\nimport lib;\n" }, [
                { args: ARGS },
                { args: ARGS },
            ]);
            expectFresh(runs, "fk");
            expect(runs[1]!.kept.stdout + runs[1]!.kept.stderr).toBe("8LU 4LU\n");
        });

    test("a lookup that passes through a kept module before its semantic and finds nothing there", async () => {
        // app's `size_t` is looked up before `import b;` runs b's semantic1, where b's importAll made it searchable:
        // the search passes through b, kept and not yet replayed, finds nothing there and `size_t` in object
        const b = "module b;\nint x;\npragma(msg, \"b\");\n";
        const app = "module app;\nsize_t n;\nimport b;\npragma(msg, \"app \", n.sizeof);\n";
        const runs = await sequence({ "b.d": b, "app.d": app }, [
            { args: ARGS },
            { files: { "app.d": "// edited\n" + app }, args: ARGS },
            { args: ARGS },
        ]);
        expectFresh(runs, "fkk");
        expect(runs[1]!.kept.stdout + runs[1]!.kept.stderr).toBe("b\napp 8LU\n");
    });

    test("a library struct the root analysed before the library's semantic, then the root edited", async () => {
        // app's `S.sizeof` comes before `import b;`: the lookup finds S unanalysed, and app's analysis of it prints;
        // with app edited, b is dropped with it (`peeks`), so that the live lookup finds S unanalysed again
        const b = "module b;\nstruct S { pragma(msg, \"S analysed\"); int x; }\n";
        const app = "module app;\nenum v = S.sizeof;\nimport b;\npragma(msg, \"app \", v);\n";
        const runs = await sequence({ "b.d": b, "app.d": app }, [
            { args: ARGS },
            { files: { "app.d": "// edited\n" + app }, args: ARGS },
            { files: { "app.d": app }, args: ARGS },
        ]);
        expectFresh(runs, "fkk");
        expect(runs[1]!.kept.stdout + runs[1]!.kept.stderr).toBe("S analysed\napp 4LU\n");
        expect(runs.map((r) => r.kept.modulesDead)).toEqual([0, 2, 2]);
    });

    test("a lookup through a kept module whose semantic made public an import it had private, then the root edited",
        async () => {
            // b imports c privately, then `static if` imports it again publicly, which only raises the import's
            // visibility (ScopeDsymbol.importScope): a fresh compile's search before b's semantic1 skips c and reports
            // X undefined, the kept b holds c public and would find it, so the edited root's lookup aborts there
            const c = "module c;\nenum int X = 5;\n";
            const b = "module b;\nimport c;\nstatic if (true) public import c;\n";
            const app = "module app;\nstatic import c;\nenum y = X;\npragma(msg, y);\nimport b;\n";
            const runs = await sequence({ "c.d": c, "b.d": b, "app.d": app }, [
                { args: ARGS },
                { files: { "app.d": "// edited\n" + app }, args: ARGS },
            ]);
            expectFresh(runs, "ff");
            expect(runs[1]!.kept.reason).toBe("abort: lookup into b before its semantic finds c.X");
            expect(runs[1]!.kept.stderr).toContain("undefined identifier `X`");
        });

    test("a lookup through an import a kept module's semantic added, before that semantic, then the root edited",
        async () => {
            // b's `static if` import of c is added by b's semantic1: before it, a fresh compile's search of b misses X,
            // the kept b holds the scope and would find it
            const app = "module app;\nimport d;\nstatic if (is(typeof(X))) enum v = 1; else enum v = 2;\nimport b;\n"
                + "pragma(msg, \"app \", v);\n";
            const runs = await sequence({ "c.d": "module c;\nint X;\n", "d.d": "module d;\nimport c;\n",
                "b.d": "module b;\nstatic if (true) public import c;\n", "app.d": app }, [
                { args: ARGS },
                { files: { "app.d": "// edited\n" + app }, args: ARGS },
            ]);
            expectFresh(runs, "ff");
            expect(runs[1]!.kept.reason).toBe("abort: lookup into b before its semantic finds c.X");
            expect(runs[1]!.kept.stdout + runs[1]!.kept.stderr).toBe("app 2\n");
        });

    test("a lookup through a kept module's importAll-time import, before its semantic, which added another",
        async () => {
            // X through b's public import, which importAll added; b's semantic1 adds a private import: a fresh
            // compile's search before that semantic finds X the same way
            const app = "module app;\nimport c;\nenum v = X.sizeof;\nimport b;\npragma(msg, \"app \", v);\n";
            const runs = await sequence({ "c.d": "module c;\nint X;\n", "d.d": "module d;\n",
                "b.d": "module b;\npublic import c;\nstatic if (true) import d;\n", "app.d": app }, [
                { args: ARGS },
                { files: { "app.d": "// edited\n" + app }, args: ARGS },
                { files: { "app.d": "// edited twice\n" + app }, args: ARGS },
            ]);
            expectFresh(runs, "fkk");
        });

    test("a private selective import's alias found before its module's semantic, then the finder edited", async () => {
        // the alias's visibility is its semantic's (dmd/dsymbolsem.d:2124): before b's semantic1 app's import loop
        // takes it, and `toAlias` runs b's import there (dmd/dsymbolsem.d:1499-1504), so b is dropped with app
        const app = "module app;\nimport c;\nenum v = X.sizeof;\nimport b;\npragma(msg, \"app \", v);\n";
        const runs = await sequence({ "c.d": "module c;\nint X;\n", "b.d": "module b;\nimport c : X;\nint y;\n",
            "app.d": app }, [
            { args: ARGS },
            { files: { "app.d": "// edited\n" + app }, args: ARGS },
            { files: { "app.d": "// edited twice\n" + app }, args: ARGS },
        ]);
        expectFresh(runs, "fkk");
        expect(runs.map((r) => r.kept.modulesDead)).toEqual([0, 2, 2]);
    });

    test("a package-qualified name checked through a kept module whose semantic opened the package", async () => {
        // lib's `static if` public import of pk.b over a private one, a public static one (package access only), or
        // a mixin's public import (an imported scope only: the mixin's) is its semantic1's: before it, a fresh
        // compile's check of `pk.b.X` (dmd/access.d:243, Module.isPackageAccessible) finds the package closed
        const app = "module app;\nimport pk.a;\nenum y = pk.b.X;\npragma(msg, y);\nimport lib;\n";
        for (const lib of ["import pk.b;\nstatic if (true) public import pk.b;\n",
            "static if (true) public static import pk.b;\n",
            "mixin template M() { public import pk.b; }\nmixin M;\n"]) {
            const runs = await sequence({ "pk/a.d": "module pk.a;\nimport pk.b;\n",
                "pk/b.d": "module pk.b;\nenum int X = 5;\n", "lib.d": "module lib;\n" + lib, "app.d": app }, [
                { args: ARGS },
                { files: { "app.d": "// edited\n" + app }, args: ARGS },
            ]);
            expectFresh(runs, "ff");
            expect(runs[1]!.kept.reason).toBe("abort: package access through lib before its semantic");
            expect(runs[1]!.kept.stderr).toContain("undefined identifier `b` in package `pk`");
        }
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

    test("a unit recorded inside a retry of the deferred symbols, replayed outside one with deferred symbols",
        async () => {
            // U!1 is first created inside the root's retry (W!R waits for R's size; W!R.f's analysis requests U!1),
            // where its creation's own retry returns at once; then from an enum outside every retry, while W!R is
            // deferred: a fresh compile's retry inside U!1's creation completes W!R (its g prints) between U's two
            // messages
            const lib = "module lib;\ntemplate U(int n) {\n    pragma(msg, \"U1\");\n    enum a = n;\n"
                + "    pragma(msg, \"U2\");\n}\n";
            const v1 = "module app;\nimport lib;\nstruct W(T) { T value; void f() { enum e = U!1.a; } }\n"
                + "struct R { W!R* next; int x; }\n";
            const v2 = "module app;\nimport lib;\nstruct W(T) { T value; void g() { pragma(msg, \"D\"); } }\n"
                + "enum z = R.sizeof + U!1.a;\nstruct R { W!R* next; int x; }\n";
            const runs = await sequence({ "lib.d": lib, "app.d": v1 },
                [{ args: ARGS }, { files: { "app.d": v2 }, args: ARGS }]);
            expectFresh(runs, "ff");
            expect(runs[1]!.fresh.stdout + runs[1]!.fresh.stderr).toBe("U1\nD\nU2\n");
            expect(runs[1]!.kept.reason).toBe("abort: other deferred symbols at the replay of lib.U!1, whose retry of "
                + "them does work");
        });

    test("a unit that defers, recorded inside a retry of the deferred symbols, replayed outside one", async () => {
        // T!1 is created inside the root's retry first (W2!R waits for R's size), its struct S deferring W!S; then
        // from an enum outside every retry, where a fresh compile's retry inside T!1's creation completes W!S (its g
        // prints) before T's own message
        const lib = "module lib;\nstruct W(T) { T value; void g() { pragma(msg, \"W.g \", T.stringof); } }\n"
            + "template T(int n) {\n    struct S { W!S* p; int x; }\n    enum a = n;\n"
            + "    pragma(msg, \"T after S\");\n}\n";
        const v1 = "module app;\nimport lib;\nstruct W2(X) { X value; void f() { enum e = T!1.a; } }\n"
            + "struct R { W2!R* next; int x; }\n";
        const v2 = "module app;\nimport lib;\nenum z = T!1.a;\npragma(msg, \"app\");\n";
        const runs = await sequence({ "lib.d": lib, "app.d": v1 },
            [{ args: ARGS }, { files: { "app.d": v2 }, args: ARGS }]);
        expectFresh(runs, "ff");
        expect(runs[1]!.fresh.stdout + runs[1]!.fresh.stderr).toBe("W.g S\nT after S\napp\n");
        expect(runs[1]!.kept.reason).toBe("abort: inst of lib.T!1 replayed outside a retry of the deferred symbols, "
            + "recorded inside one");
    });

    test("a unit whose retry did work, recorded outside a retry of the deferred symbols, replayed inside one",
        async () => {
            // f's semantic3 completes W!L in its retry when the root's enum requests it; then inside the root's retry
            // (W2!R waits for R's size), where a fresh compile's retry inside f returns at once and W!L completes later
            const lib = "module lib;\nstruct W(T) { T value; void g() { pragma(msg, \"W.g \", T.stringof); } }\n"
                + "template isS(T) { enum isS = is(T == string); }\n";
            const b = "module b;\nimport lib;\nauto f() {\n    static struct L { W!L* p; int x; }\n"
                + "    return isS!string;\n}\n";
            const vM = "module app;\nimport lib;\nimport b;\nenum q = f();\npragma(msg, \"app \", q);\n";
            const vN = "module app;\nimport lib;\nimport b;\n"
                + "struct W2(X) { X value; void h() { enum q = f(); pragma(msg, \"h after\"); } }\n"
                + "struct R { W2!R* next; int x; }\n";
            const runs = await sequence({ "lib.d": lib, "b.d": b, "app.d": vM },
                [{ args: ARGS }, { files: { "app.d": vN }, args: ARGS }, { files: { "app.d": vM }, args: ARGS }]);
            expectFresh(runs, "fff");
            expect(runs[1]!.fresh.stdout + runs[1]!.fresh.stderr).toBe("h after\nW.g L\n");
            expect(runs[1]!.kept.reason).toBe("abort: fsem3 of b.f replayed inside a retry of the deferred symbols, "
                + "recorded outside one");
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

// Editor mode: the frontend tests of the error count read only the gagged errors of the open windows (dmd/errors.ts
// `analysisSeesErrors`), so a unit recorded in a compile without errors replays as a fresh compile with errors runs it.
describe("djsMainKept — editor mode: a kept compile after an error prints what a fresh one prints", () => {
    /** A library whose structs need their copy constructors looked for (dmd/clone.d:1688). */
    const LIB_CPCTOR = `module lib;
struct P { this(this) {} }
struct C { int x; this(ref return scope inout C o) inout { x = o.x; } }
struct S { P p; C c; this(ref return scope S o) {} }
struct Box(T) { T x; C c; }
`;
    const appOf = (extra: string): string => `module app;
import lib;
void f() { S s; S t = s; Box!int u; auto v = u; }
${extra}
void g() { Box!long b; pragma(msg, __traits(hasCopyConstructor, Box!long)); }
`;

    test("a parse error after a good compile: the library's copy constructors are looked for", async () => {
        const runs = await sequence({ "lib.d": LIB_CPCTOR, "app.d": appOf("") }, [
            { args: ARGS },
            { files: { "app.d": appOf("void h() { int x = ; }") }, args: ARGS },
            { files: { "app.d": appOf("void h() { int x = 1; }") }, args: ARGS },
        ], undefined, true);
        expectFresh(runs, "fkk");
        expect(runs[1]!.kept.code).toBe(0);
        expect(runs[1]!.kept.stderr).toContain("Error: expression expected, not `;`");
        expect(runs[1]!.kept.stderr).toContain("`struct S` implicitly-generated postblit hides copy constructor");
        expect(runs[1]!.kept.stderr).toContain("\ntrue\n");
    });

    test("semantic errors under -verrors=2, and in another root", async () => {
        const args = ["-c", "-o-", "-verrors=2", "app.d"];
        const runs = await sequence({ "lib.d": LIB_CPCTOR, "app.d": appOf("") }, [
            { args },
            { files: { "app.d": appOf("void h() { a1(); a2(); a3(); }") }, args },
            { files: { "app.d": appOf("void h() { a1(); }") }, args },
            { files: { "app.d": appOf("") }, args },
        ], undefined, true);
        expectFresh(runs, "fkkk");
        expect(runs[1]!.kept.stderr).toContain("error limit (2) reached");
        expect(runs[2]!.kept.stderr).toContain("\ntrue\n");
        const two = ["-c", "-o-", "-verrors=0", "app.d", "b.d"];
        const b = (x: string): string => `module b;\nimport lib;\nvoid k() { ${x} Box!short s; auto t = s; }\n`;
        const runs2 = await sequence({ "lib.d": LIB_CPCTOR, "app.d": appOf(""), "b.d": b("") }, [
            { args: two },
            { files: { "b.d": b("undefinedQ();") }, args: two },
            { files: { "app.d": appOf("int x = ;") }, args: two },
        ], undefined, true);
        expectFresh(runs2, "fkk");
    });

    test("a root parse error with a semantic error in an imported module, and in a locally imported one", async () => {
        const lib = (x: string): string => LIB_CPCTOR + "template Def(T) { enum Def = T.sizeof; }\nint[string] aa;\n"
            + x;
        const loc = (x: string): string => "module loc;\nstruct L { C2 c; }\n"
            + "struct C2 { this(ref return scope C2 o) {} }\n" + x;
        const app = (x: string): string => "module app;\nimport lib;\n"
            + "void f() { S s; S t = s; Box!int u; auto v = u; }\n"
            + "void g() { import loc; L l; auto m = l; int[string] a; bool b = a == aa; }\n"
            + "void k() { pragma(msg, Def!int, __traits(hasCopyConstructor, Box!long)); }\n" + x;
        const runs = await sequence({ "lib.d": lib(""), "loc.d": loc(""), "app.d": app("") }, [
            { args: ARGS },
            { files: { "lib.d": lib("void z() { undefinedX(); }\n") }, args: ARGS },
            { files: { "app.d": app("void h() { int x = ; }\n") }, args: ARGS },
            { files: { "lib.d": lib("") }, args: ARGS },
            { files: { "app.d": app(""), "loc.d": loc("void z() { undefinedX(); }\n") }, args: ARGS },
            { files: { "app.d": app("void h() { int x = ; }\n") }, args: ARGS },
        ], undefined, true);
        expectFresh(runs, "fkkkkk");
        expect(runs[3]!.kept.stderr).toContain("`struct S` implicitly-generated postblit hides copy constructor");
    });

    test("an instance with errors requested twice ungagged leaves no gagged error behind", async () => {
        // dmd/templatesem.d:1021-1022 add the matched instance's errors to `gaggedErrors` at gag level 0 too; the
        // editor's reading (`Global.windowErrors`) must not take them, or analysis stops as in the CLI
        const app = (x: string): string => `module app;\nimport lib;\nvoid foo(X)(X a) { ${x} }\n`
            + "void h() { foo(1); foo(2); Box!short s; auto t = s; }\n"
            + "void g() { pragma(msg, __traits(hasCopyConstructor, Box!short)); }\n";
        const runs = await sequence({ "lib.d": LIB_CPCTOR, "app.d": app("") }, [
            { args: ARGS },
            { files: { "app.d": app("undefinedZ();") }, args: ARGS },
            { files: { "app.d": app("") }, args: ARGS },
        ], undefined, true);
        expectFresh(runs, "fkk");
        expect(runs[1]!.kept.stderr).toContain("\ntrue\n");
    });

    test("guard: a gagged error, then a kept instance requested in the same window, recompiled unchanged", async () => {
        // the replay puts back the window's gagged errors before the request (keep.ts `enterWindow`), in both modes
        const lib = "module lib;\nstruct Box(T) { T x; }\nenum ok = is(typeof(undefinedY() + Box!int.sizeof));\n";
        for (const editor of [true, false]) {
            const runs = await sequence({ "lib.d": lib, "app.d": "module app;\nimport lib;\n" }, [
                { args: ARGS },
                { args: ARGS },
                { files: { "app.d": "module app;\nimport lib;\nint x;\n" }, args: ARGS },
            ], undefined, editor);
            expectFresh(runs, "fkk");
        }
    });

    test("gagged errors still skip: __traits(compiles) after a gagged error, with a parse error in the root",
        async () => {
            const lib = `module lib;
struct C { int x; this(ref return scope C o) { x = o.x; } }
struct Box(T) { T x; C c; }
enum ok = __traits(compiles, { undefinedY(); Box!int b; });
`;
            const app = (x: string): string => `module app;\nimport lib;\n`
                + `void g() { pragma(msg, ok, __traits(hasCopyConstructor, Box!int)); }\n${x}\n`;
            const runs = await sequence({ "lib.d": lib, "app.d": app("") }, [
                { args: ARGS },
                { files: { "app.d": app("void h() { int a = ; }") }, args: ARGS },
                { files: { "app.d": app("void h() { int a = 2; }") }, args: ARGS },
            ], undefined, true);
            expectFresh(runs, "fkk");
            for (const r of runs)
                expect(r.kept.stderr).toContain("falsefalse\n");
            expect(runs[1]!.kept.stderr).not.toContain("copy constructor");
        });

    test("a struct with a function named __ctor and a parse error: no copy constructor search (clone.ts)", async () => {
        const app = (x: string): string => `module app;\nstruct S { void __ctor(ref S o) {} int a; }\n${x}\n`;
        const runs = await sequence({ "app.d": app("") }, [
            { args: ARGS },
            { files: { "app.d": app("void h() { int x = ; }") }, args: ARGS },
        ], undefined, true);
        expectFresh(runs, "fk");
        expect(runs[1]!.kept.code).toBe(0);
        expect(runs[1]!.kept.stderr).toContain("Error: function name `__ctor` is not allowed");
        expect(runs[1]!.kept.stderr).not.toContain("Internal error");
        // the same function after a constructor, in its overload chain, where `searchCtor` does not see it
        const after = (x: string): string => "module app;\n"
            + "struct S { this(ref return scope S o) {} void __ctor(int x) {} int a; }\n"
            + `void f() { S a; S b = a; }\n${x}\n`;
        const runs2 = await sequence({ "app.d": after("") }, [
            { args: ARGS },
            { files: { "app.d": after("void h() { int x = ; }") }, args: ARGS },
        ], undefined, true);
        expectFresh(runs2, "fk");
        expect(runs2[1]!.kept.stderr).not.toContain("Internal error");
    });

    test.each(["", "version(all)", "static if (true)", "private"])(
        "a mixin's copy constructor (%s mixin) looked for after an error before the import", async (wrap) => {
            const lib = "module lib;\n"
                + "mixin template CpCtor() { this(ref return scope typeof(this) o) { x = o.x + 1; } }\n"
                + `struct S { int x; ${wrap} mixin CpCtor; }\n`;
            const app = (x: string): string => `module app;\n${x}\nimport lib;\n`
                + "void g() { pragma(msg, __traits(hasCopyConstructor, S)); S a; S b = a; }\n";
            const runs = await sequence({ "lib.d": lib, "app.d": app("") }, [
                { args: ARGS },
                { files: { "app.d": app("int[1 / 0] zz;") }, args: ARGS },
                { files: { "app.d": app("") }, args: ARGS },
            ], undefined, true);
            expectFresh(runs, "fkk");
            expect(runs[1]!.kept.stderr).toContain("\ntrue\n");
        });

    test("a semantic error in the root, then fixed: std.traits instances replay (no abort)", async () => {
        const app = (x: string): string => `module app;\nimport std.traits;\nvoid f() { ${x} }\n`
            + "alias F = ubyte[32] function() pure nothrow @nogc @safe;\nvoid g() { pragma(msg, isCallable!F); }\n";
        const runs = await sequence({ "app.d": app("") }, [
            { args: ARGS },
            { files: { "app.d": app("undefinedQ();") }, args: ARGS },
            { files: { "app.d": app("int q;") }, args: ARGS },
        ], undefined, true);
        expectFresh(runs, "fkk");
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
    test("an instance replayed with gagged errors before it, recorded without, aborts (analysisSeesErrors)",
        async () => {
            // Box!int is first made in lib2's __traits(compiles) after a gagged error (no copy constructor looked for),
            // then first by the root, ungagged (looked for); back in lib2's window, its kept record would answer there
            const lib = "module lib;\nstruct C { int x; this(ref return scope C o) { x = o.x; } }\n"
                + "struct Box(T) { T x; C c; }\n";
            const lib2 = "module lib2;\nimport lib;\nenum ok = __traits(compiles, { undefinedY(); Box!int b; });\n";
            const app = (x: string): string => `module app;\nimport lib;\n${x}\nimport lib2;\n`
                + "void g() { pragma(msg, ok, __traits(hasCopyConstructor, Box!int)); }\n";
            const runs = await sequence({ "lib.d": lib, "lib2.d": lib2, "app.d": app("") }, [
                { args: ARGS },
                { files: { "app.d": app("Box!int gx;") }, args: ARGS },
                { files: { "app.d": app("") }, args: ARGS },
            ]);
            expectFresh(runs, "fkf");
            expect(runs[2]!.kept.stderr).toBe("falsefalse\n");
            expect(runs[2]!.kept.reason)
                .toBe("abort: inst of lib.Box!int replayed with gagged errors before it, recorded otherwise");
        });

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

    test("an instance one function's analysis created, requested first from the cycle's other end, aborts", async () => {
        // the base: dec!(int[])'s body creates isR!(int[]) in impl's constraint; isR's lambda reaches front and dec
        // again, running. The edit requests isR!(int[]) first: its replay reaches dec's body, whose log created the
        // instance, now running. A fresh compile matches the half-built instance there and reads its member before
        // it has a value (a gagged "undefined identifier `R`", printed by -verrors=spec), which no log holds: the
        // replay cannot be what a fresh compile does. The same in the other direction (std.uuid's `to` in an
        // application, std.utf.decode and std.range.primitives.isInputRange)
        const lib = `module lib;
enum bool isR(R) = is(typeof((R r) { return r.front; }));
@property int front(T)(T[] a) { return dec(a); }
int dec(S)(S s) { return impl(s); }
int impl(S)(S s) if (is(S : int[])) { return 1; }
int impl(S)(S s) if (is(S : long[]) || (isR!S && is(S == long[]))) { return 2; }
`;
        const app = "module app;\nimport lib;\nvoid main() { int[] a; dec(a); }\n";
        const first = app.replace("void main", "enum x = isR!(int[]);\nvoid main");
        const runs = await sequence({ "lib.d": lib, "app.d": app }, [
            { args: ARGS },
            { files: { "app.d": first }, args: ARGS },
            { files: { "app.d": app }, args: ARGS },
        ]);
        expectFresh(runs, "fff");
        for (const r of runs.slice(1))
            expect(r.kept.reason).toBe("abort: creation of lib.isR!(int[]) requested in another state");
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

    test("editor mode against the CLI's handler compiles fresh: the tests of the error count read otherwise",
        async () => {
            const app = (x: string): string => `module app;\n${x}\nvoid main() {}\n`;
            dir = mkdtempSync(join(tmpdir(), "djs-keep-"));
            const cwd = process.cwd();
            process.chdir(dir);
            try {
                writeFileSync(join(dir, "app.d"), app("int[1 / 0] zz;"));
                vi.resetModules();
                const djs = await import("./djs.js");
                const modes = [true, true, false, false, true].map((editor) => capture(() => djs.djsMainKept(ARGS,
                    editor ? (): boolean => true : undefined)).value);
                expect(modes.map((r) => (r.mode === "kept" ? "k" : "f")).join("")).toBe("fkfkf");
                expect(modes[2]!.reason).toBe("the host options changed");
            } finally {
                process.chdir(cwd);
            }
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
