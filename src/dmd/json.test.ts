// Co-located tests for src/dmd/json.ts (dmd/json.d).
//
// json.d has no `unittest` block. These tests pin the `-X` output against ldc2 1.43.0 (arm64-apple-darwin), byte for
// byte, on the compilable/ tests that use `-X` and on three programs of this file's own.
//
// THE HARNESS. `jsonRun` compiles through the shim without `-X`/`-Xf`/`-Xi` (`-c -o-`; no frontend pass reads the
// json switches, only main.d:838 does; the switches themselves are pinned in djs.test.ts) and then plays main.d's
// tail itself: it sets `jsonFieldFlags` and `json.name = "-"` as the driver would (driver/main.cpp:361/:408) and
// calls mars.ts's `generateJson` on the root modules, capturing stdout. Each run starts in a fresh module registry
// (`vi.resetModules()`), as a new ldc2 process does.
//
// THE ORACLE. Each expectation is ldc2's output for the same arguments, spelled `-Xf=- -Xi=<field>` (the corpus
// headers' `-Xf-`/`-version=` are ldmd2 spellings of the same switches). The long ones are pinned by the SHA-256 of
// ldc2's output after `normalize`; the short ones inline. `normalize` blanks the three buildInfo values that name
// the running process (json.d:904 `cwd`, :905 `argv0`, :906 `config`) and replaces the directory of this file's
// own programs with `<DIR>`.
//
// KNOWN DIVERGENCES, owned by other files. Each entry is text djs prints today where ldc2 prints something else;
// the test checks the djs text is there, puts ldc2's text back, then compares. A fix in the owner file turns its
// entry red: delete the entry then.
//   - target.ts's `Target` constructor runs `_init` at module load; ldc2's `target` is zeroed until main.d's
//     `target._init(params)`, after the main.d:410 no-source-file `-Xi` exit, so there ldc2 lists no OS after
//     `posix` and an empty architecture (json.d:844-878).

import { describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { JsonFieldFlags } from "./globals.js";
import { jsonFieldNames, tryParseJsonField } from "./json.js";
import { ds, dsToJs } from "../dstring.js";

// ORACLE CONSTANT: a checkout of LDC v1.43.0's sources (tests/dmd); set it to yours to run the oracle tests.
const TESTS = "/Users/pinver/Projects/Public/ldc-1.43.0/tests/dmd/compilable";

interface JsonRun {
    code: number;     // djsMain's exit status for the compile
    stdout: string;   // what generateJson wrote
    stderr: string;   // everything written to stderr, compile and generateJson
}

/**
 * Compiles `file` with `djs -c -o- -I<inc> <args>` in a fresh module registry, then writes its JSON to stdout as
 * `-Xf=-` with `flags` as the `-Xi` fields would: `generateJson` over the root modules, in load order (the only
 * root is `file`).
 */
/** The oracle's install, passed as `--djs-ldc=`: the JSON's import paths and config file are its, as ldc2's are. */
// ORACLE CONSTANT: an LDC 1.43.0 install (what --djs-ldc names); set it to yours to run the oracle tests.
const LDC_ROOT = "/Users/pinver/Projects/Prefix/tools/mac_a64/ldc2-1.43.0";

async function jsonRun(args: string[], file: string, flags: JsonFieldFlags, inc = TESTS): Promise<JsonRun> {
    vi.resetModules();
    const { djsMain } = await import("../djs.js");
    const { Module } = await import("./dmodule.js");
    const { global } = await import("./globals.js");
    const { generateJson } = await import("./mars.js");
    const { Array: DArray } = await import("./root/array.js");
    const { ds } = await import("../dstring.js");

    const stderr: string[] = [];
    const stdout: string[] = [];
    const tap = (into: string[]) => (chunk: string | Uint8Array): boolean => {
        into.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        return true;
    };
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(tap(stderr));
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(tap(stdout));
    try {
        const code = djsMain([`--djs-ldc=${LDC_ROOT}`, "-c", "-o-", `-I${inc}`, ...args, file]);
        stdout.length = 0;
        global.params.jsonFieldFlags = flags;
        global.params.json.name = ds("-");
        const roots = new DArray<InstanceType<typeof Module> | null>();
        for (const m of Module.amodules) {
            if (m!.isRoot())
                roots.push(m);
        }
        expect(generateJson(roots, global.errorSink!)).toBe(false);
        return { code, stdout: stdout.join(""), stderr: stderr.join("") };
    } finally {
        errSpy.mockRestore();
        outSpy.mockRestore();
    }
}

/** Blanks the process-dependent buildInfo values and the directory `dir` (see the file header). */
function normalize(text: string, dir: string | null): string {
    const t = text.replace(/"(cwd|argv0|config)" : "[^"]*"/g, (_m, k: string) => `"${k}" : "<${k}>"`);
    return dir === null ? t : t.split(dir).join("<DIR>");
}

/** Takes each known divergence (djs text, ldc2 text) back, checking the djs text is there `count` times. */
function undoDivergences(text: string, known: [string, string, number][]): string {
    for (const [djsText, ldc2Text, count] of known) {
        expect(text.split(djsText).length - 1).toBe(count);
        text = text.split(djsText).join(ldc2Text);
    }
    return text;
}

function sha256(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

/** ldc2 -o- -X -Xf=- -Xi=compilerInfo <file>, after target init (main.d:440 `target._init(params)`). */
const COMPILER_INFO = [
    "{",
    " \"compilerInfo\" : {",
    "  \"vendor\" : \"LDC\",",
    "  \"version\" : \"v2.113.0\",",
    "  \"__VERSION__\" : 2113,",
    "  \"interface\" : \"ldc\",",
    "  \"size_t\" : 8,",
    "  \"platforms\" : [",
    "   \"posix\",",
    "   \"osx\"",
    "  ],",
    "  \"architectures\" : [",
    "   \"arm64\"",
    "  ],",
    "  \"predefinedVersions\" : [",
    "   \"LDC\",",
    "   \"all\",",
    "   \"D_Version2\",",
    "   \"assert\",",
    "   \"D_PreConditions\",",
    "   \"D_PostConditions\",",
    "   \"D_Invariants\",",
    "   \"D_ModuleInfo\",",
    "   \"D_Exceptions\",",
    "   \"D_TypeInfo\",",
    "   \"AArch64\",",
    "   \"ARM_HardFloat\",",
    "   \"D_HardFloat\",",
    "   \"LittleEndian\",",
    "   \"D_LP64\",",
    "   \"D_PIC\",",
    "   \"OSX\",",
    "   \"Apple\",",
    "   \"darwin\",",
    "   \"Posix\",",
    "   \"CppRuntime_LLVM\",",
    "   \"CppRuntime_Clang\",",
    "   \"LDC_LLVM_22\",",
    "   \"D_ObjectiveC\"",
    "  ],",
    "  \"supportedFeatures\" : {",
    "   \"includeImports\" : true",
    "  }",
    " }",
    "}",
].join("\n") + "\n";

describe("tryParseJsonField and jsonFieldNames (json.d:1032/:1055)", () => {
    test("each JsonFieldFlags member after `none` parses to itself; anything else is none", () => {
        expect(tryParseJsonField(ds("compilerInfo"))).toBe(JsonFieldFlags.compilerInfo);
        expect(tryParseJsonField(ds("buildInfo"))).toBe(JsonFieldFlags.buildInfo);
        expect(tryParseJsonField(ds("modules"))).toBe(JsonFieldFlags.modules);
        expect(tryParseJsonField(ds("semantics"))).toBe(JsonFieldFlags.semantics);
        expect(tryParseJsonField(ds("none"))).toBe(JsonFieldFlags.none);           // index 0 is skipped
        expect(tryParseJsonField(ds("CompilerInfo"))).toBe(JsonFieldFlags.none);   // case-sensitive
        expect(tryParseJsonField(ds("bogus"))).toBe(JsonFieldFlags.none);
        expect(tryParseJsonField(ds("modules\0tail"))).toBe(JsonFieldFlags.modules);   // a C string: up to the NUL
    });

    test("jsonFieldNames lists the fields, backquoted", () => {
        expect(dsToJs(jsonFieldNames)).toBe("`compilerInfo`, `buildInfo`, `modules`, `semantics`");
    });
});

describe("generateJson with no source file (main.d:410: before target and predefined versions are set up)", () => {
    /** A fresh registry with `global._init()` only: the state of ldc2's main.d:410 test. */
    async function noSource(flags: JsonFieldFlags, name: string | null): Promise<JsonRun & { failed: boolean }> {
        vi.resetModules();
        const { global } = await import("./globals.js");
        const { generateJson } = await import("./mars.js");
        const { Array: DArray } = await import("./root/array.js");
        const { ds } = await import("../dstring.js");
        const stderr: string[] = [];
        const stdout: string[] = [];
        const tap = (into: string[]) => (chunk: string | Uint8Array): boolean => {
            into.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
            return true;
        };
        const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(tap(stderr));
        const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(tap(stdout));
        try {
            global._init();
            global.params.jsonFieldFlags = flags;
            global.params.json.name = name === null ? null : ds(name);
            const failed = generateJson(new DArray(), global.errorSink!);
            return { code: 0, failed, stdout: stdout.join(""), stderr: stderr.join("") };
        } finally {
            errSpy.mockRestore();
            outSpy.mockRestore();
        }
    }

    test("-Xi=compilerInfo -Xf=-: posix, an empty architecture, no predefined version (ldmd2's output)", async () => {
        const r = await noSource(JsonFieldFlags.compilerInfo, "-");
        expect(r.failed).toBe(false);
        expect(r.stderr).toBe("");
        const out = undoDivergences(r.stdout, [
            ['   "posix",\n   "osx"\n', '   "posix"\n', 1],
            ['   "arm64"\n', '   ""\n', 1],
        ]);
        expect(out).toBe([
            "{",
            ' "compilerInfo" : {',
            '  "vendor" : "LDC",',
            '  "version" : "v2.113.0",',
            '  "__VERSION__" : 2113,',
            '  "interface" : "ldc",',
            '  "size_t" : 8,',
            '  "platforms" : [',
            '   "posix"',
            "  ],",
            '  "architectures" : [',
            '   ""',
            "  ],",
            '  "predefinedVersions" : [],',
            '  "supportedFeatures" : {',
            '   "includeImports" : true',
            "  }",
            " }",
            "}",
            "",
        ].join("\n"));
    });

    test("-Xi=compilerInfo without -Xf: no object file to name the output after (mars.d:171)", async () => {
        const r = await noSource(JsonFieldFlags.compilerInfo, null);
        expect(r.failed).toBe(true);
        expect(r.stdout).toBe("");
        expect(r.stderr).toBe("Error: cannot determine JSON filename, use `-Xf=<file>` or provide a source file\n");
    });
});

describe("the compilable/ tests that use -X, against ldc2", () => {
    test("jsonCompilerInfo.d -Xi=compilerInfo: the compiler description equals ldc2's", async () => {
        const r = await jsonRun([], `${TESTS}/jsonCompilerInfo.d`, JsonFieldFlags.compilerInfo);
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(r.stdout).toBe(COMPILER_INFO);
    });

    test("json20742.d -version=Showme: the original array format, the version-selected members only", async () => {
        const r = await jsonRun(["-version=Showme"], `${TESTS}/json20742.d`, JsonFieldFlags.none);
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(r.stdout).toBe([
        "[",
        " {",
        "  \"kind\" : \"module\",",
        "  \"file\" : \"<TESTS>/json20742.d\",",
        "  \"members\" : [",
        "   {",
        "    \"name\" : \"X1\",",
        "    \"kind\" : \"struct\",",
        "    \"protection\" : \"private\",",
        "    \"line\" : 52,",
        "    \"char\" : 13,",
        "    \"members\" : []",
        "   },",
        "   {",
        "    \"name\" : \"Y2\",",
        "    \"kind\" : \"struct\",",
        "    \"protection\" : \"private\",",
        "    \"line\" : 59,",
        "    \"char\" : 13,",
        "    \"members\" : []",
        "   },",
        "   {",
        "    \"name\" : \"A1\",",
        "    \"kind\" : \"struct\",",
        "    \"protection\" : \"private\",",
        "    \"line\" : 62,",
        "    \"char\" : 13,",
        "    \"members\" : []",
        "   },",
        "   {",
        "    \"name\" : \"B2\",",
        "    \"kind\" : \"struct\",",
        "    \"protection\" : \"private\",",
        "    \"line\" : 69,",
        "    \"char\" : 13,",
        "    \"members\" : []",
        "   }",
        "  ]",
        " }",
        "]",
        ].join("\n").replace("<TESTS>", TESTS) + "\n");
    });

    test("json.d -d -preview=dip1000: 1189 lines, ldc2's bytes", async () => {
        const r = await jsonRun(["-d", "-preview=dip1000"], `${TESTS}/json.d`, JsonFieldFlags.none);
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(sha256(r.stdout))
            .toBe("80fd7c4b9362d67ba3ed0d249c7d91cf052def8deaf39b1330971e73c6a8198d");
    });

    test("json2.d -Xi=compilerInfo,buildInfo,modules,semantics: 242 lines, ldc2's bytes", async () => {
        const all = JsonFieldFlags.compilerInfo | JsonFieldFlags.buildInfo | JsonFieldFlags.modules
            | JsonFieldFlags.semantics;
        const r = await jsonRun(["-d"], `${TESTS}/json2.d`, all);
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(r.stdout.startsWith(COMPILER_INFO.slice(0, -3))).toBe(true);
        expect(r.stdout).toContain('"objectFiles" : [\n   "json2.o"\n  ]');
        expect(sha256(normalize(r.stdout, null)))
            .toBe("34912b1a5ffd3b36ecae2bf74b6cdf3167a61860644c2f49cc70df68e4c09fa2");
    });

    test("jsonStdout.d -Xi=compilerInfo,modules: 52 lines, ldc2's bytes", async () => {
        const r = await jsonRun([], `${TESTS}/jsonStdout.d`, JsonFieldFlags.compilerInfo | JsonFieldFlags.modules);
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(sha256(r.stdout)).toBe("76d5c5f9f5b8d0c7ce5174614bebe517360f95ff05f6202ace362f2db702f80e");
    });

    test("futurexf.d: 45 lines, ldc2's bytes", async () => {
        const r = await jsonRun([], `${TESTS}/futurexf.d`, JsonFieldFlags.none);
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(sha256(r.stdout)).toBe("856ae8bd57b8c6eac610dcc66f9b38e85a386cd382eca0e8061e323c01eb53d1");
    });
});

// This file's own programs. jsonp1: imports (renamed, selective, static, private), named and anonymous enums,
// interfaces, an abstract class and a final one with overrides, contracts, a constructor, destructor and static
// constructors, alignment, structs and unions, aliases of types, function pointers and delegates, linkages,
// attributes, parameter storage classes and default arguments. jsonp2: templates with type, value, alias and tuple
// parameters, specializations, constraints, `this` parameters, mixin templates, version/static if/debug blocks;
// run with -Xi=modules,semantics. jsonp3 (with -unittest): protection labels, unittest blocks, properties, a
// nested function, `#line` naming a file with every escaped byte class, and UTF-8 identifiers.
const JSONP1 = String.raw`/// A module comment is not kept without -D.
module p.jsonp1;

import std_c = core.stdc.stdio : printf, cputs = puts;
private import core.stdc.string;
static import core.stdc.stdlib;

enum Color : ubyte { red = 1, green, blue = 7 }
enum { anonA = 3, anonB }
enum string greeting = "h\té\"\\\x01\n";

interface I { void f(); }
interface J : I { int g(int x = 3); }

abstract class Base : J
{
    protected int prot;
    package(p) int pkg;
    private int priv;
    export int exp;
    void f() {}
    int g(int x = 3) in (x > -1) { return x; }
    abstract void h();
}

final class Derived : Base
{
    align(16) int aligned;
    override void h() {}
    override int g(int x = 3)
    in (x > 0)
    out (r; r >= 0)
    { return x * 2; }
    this(int a) { aligned = a; }
    ~this() {}
    static this() {}
    shared static ~this() {}
}

struct S
{
    int a = 4;
    double d;
    S* next;
    this(this) {}
    invariant (a >= 0);
}

union U { int i; float f; }

alias IntAlias = int;
alias Fn = extern(C) int function(int, char*) nothrow @nogc;
alias Dg = void delegate() @safe pure;

extern(C) int cfunc(int);
extern(C++) void cppfunc(ref int, const int*);
@trusted pure nothrow int tfunc(scope int[] arr, lazy int v, out int o, in int i) { o = 1; return 0; }
ref int rf(return ref int x) @safe { return x; }
auto af() { return 1.5; }
void varfn(int[] xs...) {}
void cvar(int x, ...) {}

__gshared int gsh;
shared int shv = 2;
immutable int[] arr = [1, 2, 3];
const(char)* cp;
int[string] aa;
deprecated("old") void dep() {}
`;

const JSONP2 = String.raw`module jsonp2;

template Tmpl(T, int n = 3, alias fun = "a", Rest...)
{
    enum size = n;
}

struct Box(T) if (is(T : long))
{
    T value;
    T get() const { return value; }
}

class Node(T, U = int) : Object
{
    T payload;
    this(T p) { payload = p; }
    auto self(this This)() { return cast(This) this; }
}

T twice(T)(T x) { return x + x; }
auto sum(Args...)(Args args) { return 0; }
void spec(T : int)(T x) {}
void valspec(int v : 3)() {}
void aliasp(alias a : 3 = 3)() {}

mixin template Mixed(T)
{
    T mixedField;
    void mixedFun() {}
}

struct UsesMixin
{
    mixin Mixed!int;
    mixin Mixed!double m2;
}

alias BoxInt = Box!int;
Box!int bi;
enum e1 = twice(2);
version (none) { int notIncluded; } else { int included; }
static if (is(int == int)) { int staticIfYes; } else { int staticIfNo; }
debug int dbg;
`;

const JSONP3 = String.raw`module jsonp3;

private:
int hidden;

public:
unittest
{
    int localInUnittest;
}

unittest {}

struct WithTests
{
    int x;
    unittest { assert(true); }
}

class C
{
    private this() {}
    protected static int count;
    public @property int prop() { return 0; }
    @property void prop(int) {}
}

interface Ifc {}
class Impl : C, Ifc {}

void nested()
{
    int local;
    struct Inner {}
}

alias Tpl(T) = T[];
enum Tpl2(T) = T.sizeof;
static assert(true);

#line 100 "virt\tual\x01\x1f\x7f\r\n\b\f\"q\\.d"
int café = 1;
int naïve() { return 2; }
`;

describe("programs of this file's own, against ldc2", () => {
    async function ownRun(path: string, text: string, args: string[], flags: JsonFieldFlags): Promise<string> {
        const dir = mkdtempSync(`${tmpdir()}/djs-json-`);
        try {
            mkdirSync(`${dir}/p`);
            writeFileSync(`${dir}/${path}`, text);
            const r = await jsonRun(args, `${dir}/${path}`, flags, dir);
            expect(r.code).toBe(0);
            expect(r.stderr).toBe("");
            return normalize(r.stdout, dir);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }

    test("jsonp1: declarations, classes, contracts, linkages and attributes (762 lines)", async () => {
        const out = await ownRun("p/jsonp1.d", JSONP1, [], JsonFieldFlags.none);
        expect(sha256(out))
            .toBe("b3edf73ae8a02d67a3060fc3bc9bc36b05546b814eb29de3c2fbf4c81ffc876d");
    });

    test("jsonp2: templates, mixins and conditional declarations, -Xi=modules,semantics (552 lines)", async () => {
        const out = await ownRun("p/jsonp2.d", JSONP2, [], JsonFieldFlags.modules | JsonFieldFlags.semantics);
        expect(sha256(out))
            .toBe("c41408666df75fc4ccf1704345afef27ca554a6a0fc8e10ab55feaa60279ac50");
    });

    test("jsonp3 -unittest: protection, unittests, escapes in a #line file name (230 lines)", async () => {
        const out = await ownRun("p/jsonp3.d", JSONP3, ["-unittest"], JsonFieldFlags.none);
        expect(out).toContain(String.raw`"file" : "virt\tual\u0001\u001f` + "\x7f" + String.raw`\r\n\b\f\"q\\.d",`);
        expect(sha256(out))
            .toBe("c673eed86aed4e0b03a266c3097ba2a57ba827773ea04d2e26dd5ed37e6f85d2");
    });

    test("an i\"...\" default argument is parenthesised, as release ldc2 prints it (hdrgen.d:3884)", async () => {
        const out = await ownRun("p/jsonp4.d", 'module jsonp4;\nauto g(T)(T t = i"val $(1 + 2) end") { return t; }\n',
            [], JsonFieldFlags.none);
        expect(out).toContain(String.raw`"type" : "(T t = (i\"val $(1 + 2) end\"))",`);
    });
});
