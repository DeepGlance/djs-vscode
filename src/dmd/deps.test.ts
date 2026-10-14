// Co-located tests for src/dmd/deps.ts (dmd/deps.d).
//
// deps.d:242 carries one `unittest` (writeEscapedMakePath), ported first. The other pins are the
// `-deps` / `-makedeps` output of ldc2 1.43.0 (`ldc2 -c -o- -I. -deps`, `-deps=file`, `-makedeps`) for the
// module shapes below, byte for byte with the machine-specific import root removed:
//   app.d:  import pkg.lib;  import pkg.lib : f, gg = g;  static import pl = pkg.lib;  enum s = import("data.txt");
//   pkg/sub.d: package(pkg) import pkg.lib;  package import pkg.lib : f;
// One leg has no ldc2 run behind it: an import whose module failed to load prints `???`, but ldc2 reports
// the load error and writes no deps output, so that line is pinned from the D source (deps.d:196-199).

import { beforeEach, describe, expect, test } from "vitest";
import { addImportDep, addImportExpDep, writeEscapedMakePath, writeMakeDeps } from "./deps.js";
import { OutBuffer } from "./common/outbuffer.js";
import { Import } from "./dimport.js";
import { Module, Package } from "./dmodule.js";
import { Visibility } from "./dsymbol.js";
import { Identifier } from "./identifier.js";
import { Output, Param } from "./globals.js";
import { ds, dsToJs, type DString } from "../dstring.js";
import { Loc } from "./location.js";
import { initSemaHarness } from "../sema-harness.js";

beforeEach(() => {
    initSemaHarness();
});

function ident(s: string): Identifier {
    return Identifier.idPool(ds(s));
}

function text(buf: OutBuffer): string {
    return dsToJs(buf.peekSlice());
}

/** A module `<pkgs...>.<name>` read from `<file>`, parented to a Package chain as the loader does. */
function moduleIn(pkgs: string[], name: string, file: string): Module {
    const m = new Module(Loc.initial, ds(file), ident(name), 0, 0);
    let parent: Package | null = null;
    for (const p of pkgs) {
        const pkg = new Package(Loc.initial, ident(p));
        pkg.parent = parent;
        parent = pkg;
    }
    m.parent = parent;
    return m;
}

/** An `Output` whose `-deps` text goes to a fresh buffer. */
function depsOutput(name: DString | null = null): Output {
    const o = new Output();
    o.buffer = new OutBuffer();
    o.name = name;
    return o;
}

function importOf(packages: string[] | null, id: string, mod: Module | null): Import {
    const imp = new Import(Loc.initial, packages === null ? null : packages.map(ident), ident(id), null, 0);
    imp.mod = mod;
    return imp;
}

describe("writeEscapedMakePath", () => {
    // deps.d:242 — the in-source unittest (non-Windows arm).
    test("unittest#1", () => {
        const buf = new OutBuffer();
        writeEscapedMakePath(buf, ds("/foo\\bar/weird$.:name#\\ with spaces.ext"));
        expect(text(buf)).toBe("/foo\\bar/weird$$.\\:name\\#\\\\\\ with\\ spaces.ext");
    });

    // deps.d:236 — a tab is escaped like a space; backslashes before other characters are not doubled.
    test("tab preceded by a backslash", () => {
        const buf = new OutBuffer();
        writeEscapedMakePath(buf, ds("a\\b\\\tc"));
        expect(text(buf)).toBe("a\\b\\\\\\\tc");
    });
});

describe("addImportDep (-deps import lines, ldc2 1.43.0)", () => {
    const lib = (): Module => moduleIn(["pkg"], "lib", "./pkg/lib.d");

    test("plain, selective+renamed, static+aliased", () => {
        const app = moduleIn([], "app", "app.d");
        const deps = depsOutput();

        addImportDep(deps, importOf(["pkg"], "lib", lib()), app);

        const sel = importOf(["pkg"], "lib", lib());
        sel.names.push(ident("f"));
        sel.aliases.push(null);
        sel.names.push(ident("g"));
        sel.aliases.push(ident("gg"));
        addImportDep(deps, sel, app);

        const stat = importOf(["pkg"], "lib", lib());
        stat.isstatic = 1;
        stat.aliasId = ident("pl");
        addImportDep(deps, stat, app);

        expect(text(deps.buffer!)).toBe(
            "depsImport app (app.d) : private : pkg.lib (./pkg/lib.d)\n" +
            "depsImport app (app.d) : private : pkg.lib (./pkg/lib.d):f,gg=g\n" +
            "depsImport app (app.d) : private static : pkg.lib (./pkg/lib.d) -> pl\n");
    });

    test("package visibility, and a named -deps file drops the `depsImport ` prefix", () => {
        const sub = moduleIn(["pkg"], "sub", "pkg/sub.d");
        const pkgVis = new Visibility(Visibility.Kind.package_);
        pkgVis.pkg = sub.parent as Package;
        const a = importOf(["pkg"], "lib", lib());
        a.visibility = pkgVis;
        const b = importOf(["pkg"], "lib", lib());
        b.visibility = new Visibility(Visibility.Kind.package_);
        b.names.push(ident("f"));
        b.aliases.push(null);

        const anon = depsOutput();
        addImportDep(anon, a, sub);
        addImportDep(anon, b, sub);
        expect(text(anon.buffer!)).toBe(
            "depsImport pkg.sub (pkg/sub.d) : package(pkg) : pkg.lib (./pkg/lib.d)\n" +
            "depsImport pkg.sub (pkg/sub.d) : package : pkg.lib (./pkg/lib.d):f\n");

        const named = depsOutput(ds("out.deps"));
        addImportDep(named, a, sub);
        expect(text(named.buffer!)).toBe("pkg.sub (pkg/sub.d) : package(pkg) : pkg.lib (./pkg/lib.d)\n");
    });

    test("an import whose module did not load prints ???, and paths are escaped", () => {
        const odd = moduleIn([], "odd", "we(ird)\\n.d");
        const deps = depsOutput();
        addImportDep(deps, importOf(null, "missing", null), odd);
        expect(text(deps.buffer!)).toBe("depsImport odd (we\\(ird\\)\\\\n.d) : private : missing (???)\n");
    });

    test("no buffer, object importing itself and __main write nothing", () => {
        const app = moduleIn([], "app", "app.d");
        const none = new Output();
        addImportDep(none, importOf(null, "x", null), app);
        expect(none.buffer).toBeNull();

        const deps = depsOutput();
        const obj = moduleIn([], "object", "object.d");
        addImportDep(deps, importOf(null, "object", obj), obj);
        addImportDep(deps, importOf(null, "x", null), moduleIn([], "__main", "__main.d"));
        expect(deps.buffer!.length()).toBe(0);

        // `object` imported by another module is listed (ldc2: `app (app.d) : private : object (...)`).
        addImportDep(deps, importOf(null, "object", obj), app);
        expect(text(deps.buffer!)).toBe("depsImport app (app.d) : private : object (object.d)\n");
    });
});

describe("addImportExpDep (import expressions, ldc2 1.43.0)", () => {
    test("-deps: `depsFile` line, or `string :` with a named deps file", () => {
        const app = moduleIn([], "app", "app.d");
        const anon = depsOutput();
        addImportExpDep(anon, new Output(), ds("./data.txt"), ds("data.txt"), app);
        expect(text(anon.buffer!)).toBe("depsFile app (app.d) : data.txt (./data.txt)\n");

        const named = depsOutput(ds("out.deps"));
        addImportExpDep(named, new Output(), ds("./data.txt"), ds("data.txt"), app);
        expect(text(named.buffer!)).toBe("app (app.d) : string : data.txt (./data.txt)\n");
    });

    test("-makedeps: the resolved file name is appended only when makedeps output is on", () => {
        const app = moduleIn([], "app", "app.d");
        const off = new Output();
        addImportExpDep(new Output(), off, ds("./data.txt"), ds("data.txt"), app);
        expect(off.files.length).toBe(0);

        const on = new Output();
        on.doOutput = true;
        addImportExpDep(new Output(), on, ds("./data.txt"), ds("data.txt"), app);
        expect(on.files.length).toBe(1);
        expect(dsToJs(on.files.opIndex(0))).toBe("./data.txt");
    });
});

describe("writeMakeDeps (ldc2 1.43.0 -makedeps)", () => {
    test("-of object name, escaped, then each dependency on a continued line", () => {
        const params = new Param();
        params.objname = ds("my $o#bj.o");
        params.makeDeps.files.push(ds("app.d"));
        params.makeDeps.files.push(ds("./pkg/lib.d"));
        const buf = new OutBuffer();
        writeMakeDeps(buf, params, false, false, ds(".a"));
        expect(text(buf)).toBe("my\\ $$o\\#bj.o: \\\n  app.d \\\n  ./pkg/lib.d\n");
    });

    test("no -of: every object file is a target", () => {
        const params = new Param();
        params.objfiles.push(ds("a.o"));
        params.objfiles.push(ds("b c.o"));
        const buf = new OutBuffer();
        writeMakeDeps(buf, params, false, false, ds(".a"));
        expect(text(buf)).toBe("a.o b\\ c.o:\n");
    });

    test("no target at all is an assertion failure; link/lib targets are driver state (escalated)", () => {
        const params = new Param();
        expect(() => writeMakeDeps(new OutBuffer(), params, false, false, ds(".a")))
            .toThrow("cannot resolve makedeps target");
        expect(() => writeMakeDeps(new OutBuffer(), params, true, false, ds(".a"))).toThrow("dmd/deps.d:55");
        expect(() => writeMakeDeps(new OutBuffer(), params, false, true, ds(".a"))).toThrow("dmd/deps.d:53");
    });
});
