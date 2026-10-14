// Co-located tests for src/dmd/dmodule.ts (dmd/dmodule.d).
//
// `dmd/dmodule.d` contains ZERO in-source `unittest{}` blocks (verified: `grep -c '^unittest'`
// returns 0), so per 10-tests-diagnostics.md §1.6b this file is the thin test file: one
// module-load smoke test plus behavior pins constructible with the EXISTING harness conventions
// (the §1.5 init snippet — `Loc._init()` + `initTokens()`). The one harness of its own is `compile()`
// at the end, which plays the driver-only legs of main.d/mars.d for the driver-path pins.
//
// The D leg of `Module.parseModule` is pinned on an in-memory `src`, through its `Compiler.onParseModule`
// tail, for a root module and for a non-root one (whose `checkCompiledImport` asks `Compiler.onImport`,
// dmodule.d:785). The DRIVER PATH is pinned at the end of the file against ldc2 on real files on disk:
// `Module.read` (a live `global.fileManager`), `Module.parse` through the dmodule.d:819 Parser,
// `Module.load` / `Module.find` for every import, druntime's real object.d closure included, and
// `Module.load`'s missing-module diagnostic, which ends in `fatal()` (dmodule.d:640-668), and a root that
// defines `main` (funcsem.d:925-941 mixes druntime's `_d_cmain` in, and its body passes parameters to a call).
// NOT YET on this path: any file whose passes reach a wall or an unported leg outside dmodule.d; the driver
// pins below are the files that match ldc2 today.
//
// `getFilename` and `processSource` are D module-private (dmodule.d:92 / :1151) and are exported
// from the port so this co-located test module can read them — the same-module-scope reader that
// 01 §2.5 sanctions for a D `private` declaration (its GOOD form names `<name>.test.ts` outright).
// 10 §1.7 is NOT the license: its trigger is a ported `unittest{}`, and dmodule.d has none.

import { beforeEach, describe, expect, test, vi } from "vitest";
import { global } from "./globals.js";
import { OS, target } from "./target.js";
import { Module, ModuleDeclaration, Package, getFilename, processSource, moduleFromParse } from "./dmodule.js";
import { DSYM, DsymbolTable, PASS } from "./dsymbol.js";
import type { Dsymbol } from "./dsymbol.js";
import { Edition, FileType, PKG } from "./astenums.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { initTokens } from "./tokens.js";
import { Array as DArray } from "./root/array.js";
import { OutBuffer } from "./common/outbuffer.js";
import { cstr, ds, dsToJs } from "../dstring.js";
import { Id } from "./id.js";
import { Type_init } from "./typesem.js";
import { ErrorSinkNull } from "./errorsink.js";
// fills dmodule.ts's CParser registration slot (its ORDER CONTRACT), as src/djs.ts does for the process
import "./cparse.js";

beforeEach(() => {
    Loc._init();
    initTokens(); // also runs Identifier.initTable — idPool needs the interning table
    Module._init(); // dmodule.d:292 — `modules = new DsymbolTable()`; Package.resolve needs it
});

function id(name: string): Identifier {
    return Identifier.idPool(Uint8Array.from(Array.from(name, (c) => c.charCodeAt(0))));
}

/** Bytes -> string, stopping at the first NUL (the C-string view, 02 §11.2). */
function str(b: Uint8Array | null): string {
    return b === null ? "<null>" : dsToJs(cstr(b));
}

describe("module load smoke (§1.6b)", () => {
    test("the module loads and its three types are constructible", () => {
        expect(typeof Package).toBe("function");
        expect(typeof Module).toBe("function");
        expect(typeof ModuleDeclaration).toBe("function");
        const p = new Package(Loc.initial, id("pkg"));
        expect(p.dsym).toBe(DSYM.package_);
        expect(str(p.kind())).toBe("package");
        expect(p.isPkgMod).toBe(PKG.unknown);
    });
});

describe("dmodule.d:151 — Package constructor", () => {
    test("each Package takes the next value of the __gshared packageTag counter", () => {
        const a = new Package(Loc.initial, id("a"));
        const b = new Package(Loc.initial, id("b"));
        expect(b.tag).toBe(a.tag + 1);
    });

    test("isPackageMod() returns `mod` only once isPkgMod == PKG.module_ (dmodule.d:248)", () => {
        const p = new Package(Loc.initial, id("p"));
        const m = new Module(Loc.initial, ds("p"), id("p"), 0, 0);
        p.mod = m;
        expect(p.isPackageMod()).toBe(null); // isPkgMod is still PKG.unknown
        p.isPkgMod = PKG.module_;
        expect(p.isPackageMod()).toBe(m);
    });
});

describe("dmodule.d:173 — Package.resolve (the real body; access.d:85 sweeps onto it)", () => {
    test("a two-level package path creates the tree and reports both ends", () => {
        const a = id("a");
        const b = id("b");
        const pparent: { value: Dsymbol | null } = { value: null };
        const ppkg: { value: Package | null } = { value: null };

        const dst = Package.resolve([a, b], pparent, ppkg);

        // *ppkg == the LEFTMOST package (pkg1); *pparent == the RIGHTMOST one (pkg2).
        expect(ppkg.value).not.toBe(null);
        expect(ppkg.value!.ident).toBe(a);
        expect(pparent.value).not.toBe(null);
        expect(pparent.value!.ident).toBe(b);

        // The returned table is the innermost package's symtab.
        expect(dst).toBe((pparent.value as Package).symtab);
        // Parent chain: a <- b; `a` was inserted into the global module table.
        expect((pparent.value as Package).parent).toBe(ppkg.value);
        expect(ppkg.value!.parent).toBe(null);
        expect(Module.modules!.lookup(a)).toBe(ppkg.value);
    });

    test("a second resolve of the same path REUSES the packages it already created", () => {
        const a = id("a");
        const b = id("b");
        const first = Package.resolve([a, b], null, null);
        const ppkg: { value: Package | null } = { value: null };
        const second = Package.resolve([a, b], null, ppkg);
        expect(second).toBe(first);
        expect(Module.modules!.lookup(a)).toBe(ppkg.value);
    });

    test("a null / empty package slice yields the global module table and null outputs", () => {
        const pparent: { value: Dsymbol | null } = { value: null };
        const ppkg: { value: Package | null } = { value: null };
        // access.d:85 calls `Package.resolve(m.md ? m.md.packages : null, null, null)` — the null
        // slice must iterate zero times (06 §2.8).
        expect(Package.resolve(null, pparent, ppkg)).toBe(Module.modules);
        expect(pparent.value).toBe(null);
        expect(ppkg.value).toBe(null);
        expect(Package.resolve([], pparent, ppkg)).toBe(Module.modules);
    });
});

describe("dmodule.d:234 — Package.isAncestorPackageOf", () => {
    test("a is an ancestor of a.b; the reverse is false; a is its own ancestor", () => {
        const pparent: { value: Dsymbol | null } = { value: null };
        const ppkg: { value: Package | null } = { value: null };
        Package.resolve([id("a"), id("b")], pparent, ppkg);
        const pkgA = ppkg.value!;
        const pkgB = pparent.value as Package;

        expect(pkgA.isAncestorPackageOf(pkgB)).toBe(true);
        expect(pkgB.isAncestorPackageOf(pkgA)).toBe(false);
        expect(pkgA.isAncestorPackageOf(pkgA)).toBe(true);
        expect(pkgA.isAncestorPackageOf(null)).toBe(false);
    });
});

describe("dmodule.d:407 — Module constructor", () => {
    test("the source file name gets the default `.d` extension and `arg` keeps the raw name", () => {
        const m = new Module(Loc.initial, ds("foo"), id("foo"), 0, 0);
        expect(m.dsym).toBe(DSYM.module_);
        expect(str(m.kind())).toBe("module");
        expect(str(m.arg)).toBe("foo");
        expect(str(m.srcfile.toChars())).toBe("foo.d");
        // D default-inits the other three FileNames; the port's empty FileName is falsy, matching
        // D's null `str` (dmodule.d:313-315).
        expect(m.objfile.toBool()).toBe(false);
        expect(m.hdrfile.toBool()).toBe(false);
        expect(m.docfile.toBool()).toBe(false);
        // enum `.init` is the FIRST member (09 §1.0), then `edition = global.params.edition`.
        expect(m.filetype).toBe(FileType.d);
        expect(m.edition).toBe(Edition.v2023);
    });

    test("an already-suffixed name is left alone; `.di` is an accepted extension", () => {
        expect(str(new Module(Loc.initial, ds("foo.d"), id("foo"), 0, 0).srcfile.toChars())).toBe("foo.d");
        expect(str(new Module(Loc.initial, ds("foo.di"), id("foo"), 0, 0).srcfile.toChars())).toBe("foo.di");
    });

    test("Module.create is the static factory for the same construction (dmodule.d:478)", () => {
        const m = Module.create(ds("bar"), id("bar"), 0, 0);
        expect(m).toBeInstanceOf(Module);
        expect(m).toBeInstanceOf(Package);
        expect(str(m.srcfile.toChars())).toBe("bar.d");
    });
});

describe("dmodule.d:92 — getFilename", () => {
    test("no packages and no -I aliases: the identifier's own name, unchanged", () => {
        expect(str(getFilename([], id("stdio")))).toBe("stdio");
    });

    test("packages are joined with the POSIX path separator and NUL-trimmed", () => {
        const r = getFilename([id("std"), id("range")], id("primitives"));
        expect(str(r)).toBe("std/range/primitives");
        // `buf.writeByte(0); filename = buf.extractSlice()[0 .. $ - 1];` — the NUL is trimmed OFF,
        // so the returned slice length is exactly the logical string length (dmodule.d:137-138).
        expect(r.length).toBe("std/range/primitives".length);
    });
});

describe("dmodule.d:1030/:1036 — isRoot / isCoreModule", () => {
    test("isRoot is `importedFrom is this`", () => {
        const m = new Module(Loc.initial, ds("m"), id("m"), 0, 0);
        expect(m.isRoot()).toBe(false);
        m.importedFrom = m;
        expect(m.isRoot()).toBe(true);
    });
});

describe("dmodule.d:1083 — Module.fullyQualifiedName", () => {
    test("walks the parent packages, prepending each with a dot", () => {
        const pparent: { value: Dsymbol | null } = { value: null };
        Package.resolve([id("a"), id("b")], pparent, null);
        const m = new Module(Loc.initial, ds("c"), id("c"), 0, 0);
        m.parent = pparent.value; // package b (whose parent is package a)

        const buf = new OutBuffer();
        m.fullyQualifiedName(buf);
        expect(dsToJs(buf.peekSlice())).toBe("a.b.c");
    });
});

describe("dmodule.d:1098 — ModuleDeclaration", () => {
    test("toChars() renders pkg1.pkg2.id (NUL-terminated) and toString() slices the NUL off", () => {
        const md = new ModuleDeclaration(Loc.initial, [id("a"), id("b")], id("c"), null, false);
        const chars = md.toChars();
        expect(str(chars)).toBe("a.b.c");
        expect(chars[chars.length - 1]).toBe(0);       // extractChars() keeps the terminator
        const s = md.toString();
        expect(dsToJs(s)).toBe("a.b.c");               // toDString stops before the NUL
        expect(s.length).toBe(5);
    });

    test("no packages: just the id", () => {
        expect(str(new ModuleDeclaration(Loc.initial, [], id("solo"), null, false).toChars())).toBe("solo");
    });

    test("copy() is a fresh value with a fresh Loc and shared class refs (03 §2)", () => {
        const packages = [id("a")];
        const md = new ModuleDeclaration(Loc.initial, packages, id("c"), null, true);
        const c = md.copy();
        expect(c).not.toBe(md);
        expect(c.loc).not.toBe(md.loc);                // nested value struct -> recursed
        expect(c.id).toBe(md.id);                      // class ref -> shared
        expect(c.packages).toBe(md.packages);          // D slice -> shared backing store (02 §8)
        expect(c.isdeprecated).toBe(true);
    });
});

describe("dmodule.d:1151 — processSource (BOM detection / UTF normalization)", () => {
    function mod(): Module {
        return new Module(Loc.initial, ds("enc"), id("enc"), 0, 0);
    }

    test("plain ASCII with no BOM is returned as the SAME slice (no allocation)", () => {
        const src = ds("module a;");
        expect(processSource(src, mod())).toBe(src);
    });

    test("a buffer shorter than 2 bytes is assumed UTF-8 and returned unchanged", () => {
        const src = ds("x");
        expect(processSource(src, mod())).toBe(src);
    });

    test("a null slice (D `const(ubyte)[] src` at its .init) is handed straight back", () => {
        // dmodule.d:1243-1245 — `buf.length` on a D null slice is 0 (09 §1.0), so the `< 2` early
        // return yields the null slice, which is exactly what the caller's
        // `if (buf is null) return null;` (dmodule.d:751) is written to catch.
        expect(processSource(null, mod())).toBe(null);
    });

    test("an EF BB BF UTF-8 BOM is stripped", () => {
        const src = Uint8Array.from([0xef, 0xbb, 0xbf, 0x41, 0x42]);
        const r = processSource(src, mod());
        expect(dsToJs(r!)).toBe("AB");
    });

    test("FF FE (UTF-16LE BOM) converts to UTF-8 with a terminating NUL", () => {
        const src = Uint8Array.from([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]);
        const r = processSource(src, mod())!;
        expect(str(r)).toBe("AB");
        expect(r.length).toBe(3);                      // "AB" + the terminator dbuf.writeByte(0)
    });

    test("FE FF (UTF-16BE BOM) converts to UTF-8", () => {
        const src = Uint8Array.from([0xfe, 0xff, 0x00, 0x41, 0x00, 0x42]);
        expect(str(processSource(src, mod())!)).toBe("AB");
    });

    test("FF FE 00 00 (UTF-32LE BOM) converts to UTF-8", () => {
        const src = Uint8Array.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00]);
        expect(str(processSource(src, mod())!)).toBe("A");
    });

    test("00 00 FE FF (UTF-32BE BOM) converts to UTF-8", () => {
        const src = Uint8Array.from([0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x41]);
        expect(str(processSource(src, mod())!)).toBe("A");
    });

    test("no BOM, but Arcane Jill's insight detects UTF-32LE from the three zero bytes", () => {
        const src = Uint8Array.from([0x41, 0x00, 0x00, 0x00]);
        expect(str(processSource(src, mod())!)).toBe("A");
    });

    test("no BOM, one trailing zero byte detects UTF-16LE", () => {
        const src = Uint8Array.from([0x41, 0x00, 0x42, 0x00]);
        expect(str(processSource(src, mod())!)).toBe("AB");
    });

    test("a UTF-16LE surrogate pair becomes the 4-byte UTF-8 encoding of U+1F600", () => {
        // D800-DBFF high + DC00-DFFF low; U+1F600 == D83D DE00 (little-endian bytes).
        const src = Uint8Array.from([0xff, 0xfe, 0x3d, 0xd8, 0x00, 0xde]);
        const r = processSource(src, mod())!;
        expect(Array.from(r.subarray(0, 4))).toEqual([0xf0, 0x9f, 0x98, 0x80]);
    });
});

describe("moduleFromParse (harness-only factory, no D counterpart)", () => {
    test("builds a Module carrying the parsed members and adopting md.id", () => {
        const members = new DArray<Dsymbol | null>();
        const md = new ModuleDeclaration(Loc.initial, [], id("gamma"), null, false);
        const m = moduleFromParse(members, md);
        expect(m.members).toBe(members);
        expect(m.md).toBe(md);
        expect(m.ident).toBe(md.id);
        expect(str(m.arg)).toBe("__stdin");
    });

    test("with no ModuleDeclaration the ident stays as constructed (null)", () => {
        const m = moduleFromParse(new DArray<Dsymbol | null>(), null);
        expect(m.md).toBe(null);
        expect(m.ident).toBe(null);
    });
});

describe("dmodule.d:292/:303 — Module._init / Module.deinitialize", () => {
    test("_init creates the global module table; deinitialize restores its `.init` (null)", () => {
        expect(Module.modules).toBeInstanceOf(DsymbolTable);
        Module.deinitialize();
        expect(Module.modules).toBe(null);
        Module._init();
        expect(Module.modules).toBeInstanceOf(DsymbolTable);
    });
});

describe("dmodule.d:795-822 — Module.parseModule, C leg (CParser through the registration slot)", () => {
    test("a .c module parses as C: one `extern (C)` LinkDeclaration, filetype c, masm reset (d:801/:803)", () => {
        // Windows is the only disposition where the masm set (d:801) and reset (d:803) differ, so it is the one
        // that can observe the pair; `target.os` is restored regardless of outcome.
        const savedOs = target.os;
        const savedMasm = global.compileEnv.masm;
        Id.initialize();
        Type_init();   // CParser's declaration specifiers read the basic types (Type.tint32, …)
        const savedSink = global.errorSink;
        global.errorSink = new ErrorSinkNull();
        target.os = OS.Windows;
        try {
            const m = new Module(Loc.initial, ds("cfile.c"), id("cfile"), 0, 0);
            m.src = ds("int x;\0");   // NUL-terminated: the lexer scans to the sentinel
            expect(m.parseModule()).toBe(m);
            expect(global.compileEnv.masm).toBe(false);
            expect(m.filetype).toBe(FileType.c);
            expect(m.md).toBe(null);
            expect(m.members!.length).toBe(1);
            expect(m.members!.opIndex(0)!.isAttribDeclaration()!.decl!.length).toBe(1);   // `int x;`
        } finally {
            target.os = savedOs;
            global.compileEnv.masm = savedMasm;
            global.errorSink = savedSink;
        }
    });
});

describe("dmodule.d:739 — Module.parseModule, D leg, on an in-memory source", () => {
    /** NUL-terminated byte buffer (the lexer scans to the NUL sentinel), as parse.smoke.test.ts builds it. */
    function srcBuf(text: string): Uint8Array {
        const b = new Uint8Array(text.length + 1);
        for (let i = 0; i < text.length; i++) b[i] = text.charCodeAt(i) & 0xff;
        b[text.length] = 0;
        return b;
    }

    test("parses md and members, inserts the module under its package, runs onParseModule, returns the module", () => {
        Id.initialize();
        Type_init();
        const savedSink = global.errorSink;
        global.errorSink = new ErrorSinkNull();
        try {
            const m = new Module(Loc.initial, ds("file.d"), id("file"), 0, 0);
            m.importedFrom = m; // a root module: checkCompiledImport (dmodule.d:783) does not call Compiler.onImport
            m.src = srcBuf("module alpha.beta;\nint x;\nvoid f() {}\n");
            // dmodule.d:956-957 — `Compiler.onParseModule(this); return this;` (the hook is empty in LDC).
            expect(m.parse()).toBe(m);
            // dmodule.d:819-838 — the Parser built the ModuleDeclaration and the two members.
            expect(m.filetype).toBe(FileType.d);
            expect(m.md).not.toBe(null);
            expect(m.ident).toBe(id("beta"));               // `this.ident = md.id` (dmodule.d:830)
            expect(m.md!.packages.map((p) => str(p.toChars()))).toEqual(["alpha"]);
            expect(m.members!.length).toBe(2);
            expect(str(m.members!.opIndex(0)!.toChars())).toBe("x");
            expect(str(m.members!.opIndex(1)!.toChars())).toBe("f");
            // dmodule.d:831 — Package.resolve created `alpha` in the global module table and set it as parent;
            // dmodule.d:921 — `dst.insert(s)` put the module in alpha's symbol table and amodules took it.
            const alpha = Module.modules!.lookup(id("alpha"))!.isPackage()!;
            expect(m.parent).toBe(alpha);
            expect(alpha.symtab!.lookup(id("beta"))).toBe(m);
            expect(Module.amodules.contains(m)).toBe(true);
        } finally {
            global.errorSink = savedSink;
        }
    });

    test("a non-root module asks Compiler.onImport, which declines without -i; importedFrom stays unset", () => {
        Id.initialize();
        Type_init();
        const savedSink = global.errorSink;
        global.errorSink = new ErrorSinkNull();
        try {
            const m = new Module(Loc.initial, ds("imp.d"), id("imp"), 0, 0);
            expect(m.isRoot()).toBe(false); // importedFrom unset: checkCompiledImport (dmodule.d:783) asks onImport
            m.src = srcBuf("module gamma;\nint y;\n");
            expect(m.parse()).toBe(m);
            // compiler.d:142 — `includeImports` is false, so onImport returns false and dmodule.d:786 is skipped.
            expect(m.importedFrom).toBe(null);
            expect(m.ident).toBe(id("gamma"));
        } finally {
            global.errorSink = savedSink;
        }
    });
});

// ── THE DRIVER PATH, end to end on files on disk ──────────────────────────────────────────────────
//
// What ldc2 does for `ldc2 -c -o- -I<dir> <file>`, as far as the frontend goes, run through the shim: src/djs.ts
// `djsMain` (driver/main.cpp's startup, the command line, ldc2.conf's import directory) and src/dmd/main.ts
// `mars_tryMain` (main.d: the inits, `createModules`, `m.read`, `m.parse` — dmodule.d:819 constructs the
// Parser — then passes 0-3 with main.d's stops). Pass 0's implicit `import object;` and every `import` go
// through `Module.load` -> `Module.find` -> `FileManager.lookForSourceFile` -> `read` -> `parse` on druntime's
// real object.d closure (the oracle's own `import/` tree).
//
// Every run starts in a FRESH module registry (`vi.resetModules()` + dynamic imports), so every
// process-global the passes set (ClassDeclaration.object, Module.amodules, the Id/Type tables, ...)
// starts from its load-time value, as in a new ldc2 process. The static imports at the top of this
// file are a different module instance and are not touched.
//
// ORACLE: <ldc2-1.43.0>/bin/ldc2 -c -o- [-v] -I<dir> <file>, run
// with the absolute paths below; stderr is compared byte for byte, `-v`'s `import` lines likewise.

// ORACLE CONSTANT: a checkout of LDC v1.43.0's sources (tests/dmd); set it to yours to run the oracle tests.
const TESTS = "/Users/pinver/Projects/Public/ldc-1.43.0/tests/dmd";
/** The oracle's install: every run passes it as `--djs-ldc=`, so djs plays its ldc2.conf, not the bundled tree. */
// ORACLE CONSTANT: an LDC 1.43.0 install (what --djs-ldc names); set it to yours to run the oracle tests.
const LDC_ROOT = "/Users/pinver/Projects/Prefix/tools/mac_a64/ldc2-1.43.0";
/** ldc2.conf's import dir, spelled as ldc2 spells it (`%%ldcbinarypath%%/../import`), so paths print alike. */
const LDC_IMPORT = `${LDC_ROOT}/bin/../import`;
interface DriverRun {
    errors: number;
    fatal: boolean;        // the run ended in `fatal()` (errors.d:818)
    semanticRun: number;   // of the root module
    stderr: string;        // everything errors.ts wrote to stderr
    stdout: string;        // everything errors.ts wrote to stdout (the `-v` messages)
}

/**
 * One ldc2-shaped compile of `file` through the shim (src/djs.ts `djsMain`, `-c -o- -I<importDir>`), in a fresh
 * module registry. The startup sequence, the passes and main.d's stops are src/dmd/main.ts `mars_tryMain`'s.
 * `fatal` is true when the run ended in `fatal()`, which every ldc2 run with errors does (main.d's checks end
 * in `removeHdrFilesAndFail` -> `fatal()`): a non-zero status. With `verbose`, `stdout` keeps only `-v`'s
 * `import` pairs (dmodule.d:529-532), the lines these tests pin.
 */
async function compile(file: string, importDir: string, verbose = false): Promise<DriverRun> {
    vi.resetModules();
    const { djsMain } = await import("../djs.js");
    const { Module } = await import("./dmodule.js");
    const { global } = await import("./globals.js");

    const stderr: string[] = [];
    const stdout: string[] = [];
    const tap = (into: string[]) => (chunk: string | Uint8Array): boolean => {
        into.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        return true;
    };
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(tap(stderr));
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(tap(stdout));
    try {
        const code = djsMain([`--djs-ldc=${LDC_ROOT}`, "-c", "-o-", `-I${importDir}`, ...(verbose ? ["-v"] : []),
            file]);
        const out = stdout.join("");
        return {
            errors: global.errors, fatal: code !== 0, semanticRun: Module.rootModule!.semanticRun,
            stderr: stderr.join(""),
            stdout: verbose
                ? out.split("\n").filter((l) => /^(import |\(imported from )/.test(l)).map((l) => l + "\n").join("")
                : out,
        };
    } finally {
        errSpy.mockRestore();
        outSpy.mockRestore();
    }
}

/**
 * `-v`'s lines for object.d's closure, in ldc2's order (dmodule.d:529-532: `import    <mod>\t(<file>)`, then
 * `(imported from <loc>)`). Each row: module, file under LDC_IMPORT, the importing location under LDC_IMPORT.
 * The closure is the same for every root; only the first `imported from` names the root.
 */
const OBJECT_CLOSURE: [string, string, string][] = [
    ["core.attribute", "core/attribute.d", "object.d(112)"],
    ["ldc.attributes", "ldc/attributes.d", "core/attribute.d(40)"],
    ["core.internal.newaa", "core/internal/newaa.d", "object.d(3029)"],
    ["core.internal.util.math", "core/internal/util/math.d", "core/internal/newaa.d(17)"],
    ["core.internal.traits", "core/internal/traits.d", "core/internal/newaa.d(18)"],
    ["core.internal.hash", "core/internal/hash.d", "object.d(3803)"],
    ["core.internal.array.capacity", "core/internal/array/capacity.d", "object.d(3976)"],
    ["core.internal.entrypoint", "core/internal/entrypoint.d", "object.d(4778)"],
    ["core.internal.array.appending", "core/internal/array/appending.d", "object.d(4780)"],
    ["core.internal.array.comparison", "core/internal/array/comparison.d", "object.d(4794)"],
    ["core.internal.array.equality", "core/internal/array/equality.d", "object.d(4795)"],
    ["core.internal.array.casting", "core/internal/array/casting.d", "object.d(4796)"],
    ["core.internal.array.concatenation", "core/internal/array/concatenation.d", "object.d(4797)"],
    ["core.internal.array.construction", "core/internal/array/construction.d", "object.d(4798)"],
    ["core.internal.array.arrayassign", "core/internal/array/arrayassign.d", "object.d(4804)"],
    ["core.internal.cast_", "core/internal/cast_.d", "object.d(4808)"],
    ["core.internal.dassert", "core/internal/dassert.d", "object.d(4810)"],
    ["core.internal.destruction", "core/internal/destruction.d", "object.d(4812)"],
    ["core.internal.moving", "core/internal/moving.d", "object.d(4814)"],
    ["core.internal.postblit", "core/internal/postblit.d", "object.d(4816)"],
    ["core.internal.switch_", "core/internal/switch_.d", "object.d(4818)"],
    ["core.lifetime", "core/lifetime.d", "object.d(4821)"],
    ["core.internal.attributes", "core/internal/attributes.d", "core/lifetime.d(3)"],
    ["core.builtins", "core/builtins.d", "object.d(4932)"],
    ["ldc.intrinsics", "ldc/intrinsics.di", "core/builtins.d(50)"],
];

/** The verbose `import` message pair (dmodule.d:529-532) for one loaded module. */
function importLines(mod: string, file: string, from: string): string {
    return `import    ${mod}\t(${file})\n(imported from ${from})\n`;
}

/** ldc2 -v's `import` lines for `root`'s implicit `import object;` and object.d's closure. */
function objectClosure(root: string): string {
    return importLines("object", `${LDC_IMPORT}/object.d`, root)
        + OBJECT_CLOSURE.map(([mod, file, from]) => importLines(mod, `${LDC_IMPORT}/${file}`, `${LDC_IMPORT}/${from}`))
            .join("");
}

describe("the driver path — read, parse (dmodule.d:819), load every import, passes 0-3; ldc2's output", () => {
    test("compilable/ldc_github_821.d: object.d's closure and the -I import load as ldc2 -v lists them", async () => {
        // `import imports.ldc_github_821a; S* s;` — the struct comes from a second file on disk.
        const r = await compile(`${TESTS}/compilable/ldc_github_821.d`, `${TESTS}/compilable`, true);
        expect(r.stderr).toBe("");
        expect(r.errors).toBe(0);
        expect(r.semanticRun).toBe(PASS.semantic3done);
        const root = `${TESTS}/compilable/ldc_github_821.d`;
        expect(r.stdout).toBe(objectClosure(root)
            + importLines("imports.ldc_github_821a", `${TESTS}/compilable/imports/ldc_github_821a.d`, `${root}(3)`));
    });

    test("compilable/ice11300.d: an import that `static import`s the root back finds it already loaded", async () => {
        // imports/ice11300a.d: `static import ice11300; enum value = ice11300.value;` — the lookup in the
        // module table (dsymbolsem.d:8481) answers, so no second `import` line and no second parse.
        const r = await compile(`${TESTS}/compilable/ice11300.d`, `${TESTS}/compilable`, true);
        expect(r.stderr).toBe("");
        expect(r.errors).toBe(0);
        expect(r.semanticRun).toBe(PASS.semantic3done);
        const root = `${TESTS}/compilable/ice11300.d`;
        expect(r.stdout).toBe(objectClosure(root)
            + importLines("imports.ice11300a", `${TESTS}/compilable/imports/ice11300a.d`, `${root}(4)`));
    });

    test("fail_compilation/ice11513a.d: parseModule's package-vs-module conflict (dmodule.d:866)", async () => {
        const r = await compile(`${TESTS}/fail_compilation/ice11513a.d`, `${TESTS}/fail_compilation`);
        expect(r.errors).toBe(1);
        expect(r.stderr).toBe(
            `${TESTS}/fail_compilation/imports/ice11513x.d(1): Error: package name 'ice11513a' conflicts with usage `
            + `as a module name in file ${TESTS}/fail_compilation/ice11513a.d\n`
            + "module ice11513a.imports;\n^\n");
    });

    test("fail_compilation/fail22121.d: a directory import resolves to package.d (file_manager.d:240)", async () => {
        // `import fail22121.imports.test22121;` names a directory; lookForSourceFile falls through to its
        // package.d, whose `module fail22121.imports.test22121;` then collides with the root module.
        const r = await compile(`${TESTS}/fail_compilation/fail22121.d`, `${TESTS}/fail_compilation`);
        expect(r.errors).toBe(1);
        expect(r.stderr).toBe(
            `${TESTS}/fail_compilation/fail22121/imports/test22121/package.d(1): Error: package name 'fail22121' `
            + `conflicts with usage as a module name in file ${TESTS}/fail_compilation/fail22121.d\n`
            + "module fail22121.imports.test22121;\n^\n");
    });

    test("fail_compilation/test21304.d: a pass-1 error reaches stderr with ldc2's location and caret", async () => {
        const r = await compile(`${TESTS}/fail_compilation/test21304.d`, `${TESTS}/fail_compilation`);
        expect(r.errors).toBe(1);
        expect(r.stderr).toBe(`${TESTS}/fail_compilation/test21304.d(6): Error: undefined identifier \`unknown\`\n`
            + "int[unknown] values = [1, 2, 3];\n    ^\n");
    });

    // The sema.corpus.test.ts files, here through the driver: ldc2 -c -o- accepts the four silently.
    const cleanAccepts = ["empty_file", "test12567e", "test14198", "ddocYear"];
    test.each(cleanAccepts)("compilable/%s.d: ldc2's clean accept", async (f) => {
        const r = await compile(`${TESTS}/compilable/${f}.d`, `${TESTS}/compilable`);
        expect(r.stderr).toBe("");
        expect(r.errors).toBe(0);
        expect(r.semanticRun).toBe(PASS.semantic3done);
    });

    // A root that defines `main`: funcsem.d:925-941 mixes druntime's `_d_cmain` into it, whose body calls
    // `_d_run_main` with the parameters, so these run only since arrayExpressionSemantic's write-back
    // (expressionsem.d:1923) keeps analysed call arguments. ldc2 -c -o- accepts both silently.
    test.each(["testlibmain", "test10375"])("compilable/%s.d: a root with `main`, ldc2's clean accept", async (f) => {
        const r = await compile(`${TESTS}/compilable/${f}.d`, `${TESTS}/compilable`);
        expect(r.stderr).toBe("");
        expect(r.errors).toBe(0);
        expect(r.semanticRun).toBe(PASS.semantic3done);
    });

    // `new S(...)` of a struct lowers to druntime's `_d_newitemT`, whose instantiation evaluates `is(...)`
    // expressions: these two need both the write-back above and the IsExp `dedtypes` null fill
    // (expressionsem.d:9225), without which `deduceType` reads an `undefined` slot. ldc2 accepts both silently.
    test.each(["issue24409", "test22510"])("compilable/%s.d: `new` of a struct, ldc2's clean accept", async (f) => {
        const r = await compile(`${TESTS}/compilable/${f}.d`, `${TESTS}/compilable`);
        expect(r.stderr).toBe("");
        expect(r.errors).toBe(0);
        expect(r.semanticRun).toBe(PASS.semantic3done);
    });

    test("fail_compilation/fail256.d: a pass-2 type error, ldc2's stderr", async () => {
        const r = await compile(`${TESTS}/fail_compilation/fail256.d`, `${TESTS}/fail_compilation`);
        expect(r.errors).toBe(1);
        expect(r.stderr).toBe(`${TESTS}/fail_compilation/fail256.d(8): Error: incompatible types for `
            + "`(\"foo\"d) ~ (\"bar\"c)`: `dstring` and `string`\n"
            + "auto s = \"foo\"d ~ \"bar\"c;\n                ^\n");
    });

    test("fail_compilation/diag10327.d: a missing import is fatal, listing the import paths in order", async () => {
        // dmodule.d:640-668: the error, the supplemental, one `import path[i]` line per `global.path` entry
        // (-I before ldc2.conf's post-switch), then `fatal()`.
        const r = await compile(`${TESTS}/fail_compilation/diag10327.d`, `${TESTS}/fail_compilation`);
        const at = `${TESTS}/fail_compilation/diag10327.d(10)`;
        const context = "import imports.test10327;  // package.d missing\n       ^\n";
        expect(r.fatal).toBe(true);
        expect(r.errors).toBe(1);
        expect(r.stderr).toBe(`${at}: Error: unable to read module \`test10327\`\n` + context
            + `${at}:        Expected 'imports/test10327.d' or 'imports/test10327/package.d' in one of the following `
            + "import paths:\n" + context
            + `import path[0] = ${TESTS}/fail_compilation\nimport path[1] = ${LDC_IMPORT}\n`);
    });

    test("fail_compilation/fail207.d: parse.d:4866's `declared here` form, from the dmodule.d:819 Parser", async () => {
        const r = await compile(`${TESTS}/fail_compilation/fail207.d`, `${TESTS}/fail_compilation`);
        const at = `${TESTS}/fail_compilation/fail207.d`;
        expect(r.errors).toBe(2);
        expect(r.stderr).toBe(`${at}(11): Error: found end of file instead of initializer\n`
            + `${at}(11): Error: semicolon needed to end declaration of \`x\`, instead of \`End of File\`\n`
            + `${at}(10):        \`x\` declared here\nint x = {\n    ^\n`);
    });

    test("fail_compilation/diag8684.d: the same form inside a function body", async () => {
        const r = await compile(`${TESTS}/fail_compilation/diag8684.d`, `${TESTS}/fail_compilation`);
        const at = `${TESTS}/fail_compilation/diag8684.d`;
        expect(r.errors).toBe(2);
        expect(r.stderr).toBe(`${at}(12): Error: found \`;\` when expecting \`)\`\n`
            + "    int x = foo( 5, m;\n                     ^\n"
            + `${at}(13): Error: semicolon needed to end declaration of \`x\`, instead of \`for\`\n`
            + "    for (int q=0; q<10; ++q){\n    ^\n"
            + `${at}(12):        \`x\` declared here\n    int x = foo( 5, m;\n        ^\n`);
    });
});
