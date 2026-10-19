// The public lane of the host tests: every query of the worker on host/fixture/src (two modules of our own), with no
// ldc2 and no private repository, so it runs on a public clone and in CI. The expectations are written from the
// fixture's D, not from an oracle: the private lanes compare against ldc2 on real programs. Read-only: the compile
// writes nothing (`-o-`), and the diagnostics case gives the edited text as a buffer, never on disk.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { DjsCompiler as Compiler } from "./compiler.js";
import type { Position, Range } from "./protocol.js";

const DIST = new URL("../dist/", import.meta.url);
const REPO = fileURLToPath(new URL("fixture/", import.meta.url));
const APP = `${REPO}src/app.d`;
const GEOM = `${REPO}src/geom.d`;
const LINE = "ldc2 -i -Isrc -d-version=Fixture --vcolumns -c -of/dev/null src/app.d";
const whole: Range = { start: { line: 0, character: 0 }, end: { line: 1 << 20, character: 0 } };

let c: Compiler;
let args: string[];
const app = readFileSync(APP, "utf8");
const geom = readFileSync(GEOM, "utf8");

/** The (line, character) of the `nth` occurrence of `token` in `text`, plus `skip` characters (UTF-16, from 0). */
function at(text: string, token: string, nth = 0, skip = 0): Position {
    let i = -1;
    for (let k = 0; k <= nth; k++) {
        i = text.indexOf(token, i + 1);
        if (i < 0)
            throw new Error(`no occurrence ${nth} of ${JSON.stringify(token)}`);
    }
    i += skip;
    const before = text.slice(0, i);
    return { line: before.split("\n").length - 1, character: i - (before.lastIndexOf("\n") + 1) };
}

const inside = (p: Position, r: Range): boolean =>
    (p.line > r.start.line || (p.line === r.start.line && p.character >= r.start.character))
    && (p.line < r.end.line || (p.line === r.end.line && p.character <= r.end.character));

beforeAll(async () => {
    const { DjsCompiler } = await import(new URL("host/compiler.js", DIST).href) as typeof import("./compiler.js");
    const flags = await import(new URL("host/flags.js", DIST).href) as typeof import("./flags.js");
    args = [...flags.planFlags(flags.splitLine(LINE), REPO).args, APP];
    c = new DjsCompiler();
    const r = await c.compile(args);
    expect(r.status, r.output).toBe(0);
    expect(r.errors, r.output).toBe(0);
    expect(r.mode).toBe("fresh");
});

afterAll(async () => {
    await c.dispose();
});

describe("the public fixture", () => {
    test("hover: signature and doc comment, UFCS, a lowered operator", async () => {
        const scale = (await c.hover(APP, ...pos(at(app, "scale(b"), 1), app))!;
        expect(scale.result!.markdown).toMatch(/```d\nint scale\(int value, int factor\)\n```/);
        expect(scale.result!.markdown).toContain("times `factor`");
        const ufcs = (await c.hover(APP, ...pos(at(app, "length2"), 2), app))!;
        expect(ufcs.result!.markdown).toMatch(/UFCS:/);
        const plus = (await c.hover(APP, ...pos(at(app, "a + Vec"), 2), app))!;
        expect(plus.result!.markdown).toMatch(/Lowered:[\s\S]*opBinary/);
    });

    test("go to definition across modules", async () => {
        const d = (await c.definition(APP, ...pos(at(app, "Vec!int"), 1), app))!;
        expect(d.result!.file).toBe(GEOM);
        expect(d.result!.range.start).toEqual(at(geom, "Vec(T)"));
    });

    test("completion after a dot: members, then UFCS", async () => {
        const r = (await c.completion(APP, app, at(app, "b.length2", 0, 2)))!;
        const items = r.result!.items;
        expect(items.filter((i) => i.group === 0).map((i) => i.label)).toEqual(expect.arrayContaining(["x", "y"]));
        expect(items.find((i) => i.label === "length2")?.group).toBe(1);
    });

    test("semantic tokens", async () => {
        const r = (await c.semanticTokens(APP, app))!;
        expect(r.data, r.reason).not.toBeNull();
        expect(r.data!.length).toBeGreaterThan(0);
    });

    test("inlay hints and the inactive branch", async () => {
        const h = (await c.inlayHints(APP, app, whole))!;
        const label = (p: Position): string[] => h.hints!
            .filter((x) => x.position.line === p.line && x.position.character === p.character).map((x) => x.label);
        expect(label(at(app, "a = Vec", 0, 1)).join()).toMatch(/Vec!int/);
        expect(label(at(app, "b.length2"))).toEqual(["value:"]);
        const g = (await c.inlayHints(GEOM, geom, whole))!;
        expect(g.hints!.filter((x) => x.kind === "instances").map((x) => x.label).join()).toMatch(/2/);
        const i = (await c.inactiveRanges(APP, app))!;
        expect(i.ranges!.some((r) => inside(at(app, "\"other\""), r))).toBe(true);
        expect(i.ranges!.some((r) => inside(at(app, "\"fixture\""), r))).toBe(false);
    });

    test("expansion sites and a mixin's expansion", async () => {
        const s = (await c.expansionSites(APP, app))!;
        const kinds = new Set(s.sites!.map((x) => x.kind));
        expect([...kinds].sort()).toEqual(["instance", "mixin", "value"]);
        const mixin = s.sites!.find((x) => x.kind === "mixin")!;
        const e = (await c.expansion(APP, mixin.range, app))!;
        expect(e.result!.text).toContain("int generated = 3;");
    });

    test("AST, instances, imports", async () => {
        const ast = (await c.ast(APP, app))!;
        expect(ast.result!.text).toContain("int generated = 3;");
        const inst = (await c.instances([APP, GEOM]))!;
        const vec = inst.templates!.find((t) => t.name === "geom.Vec(T)")!;
        expect(vec.instances.length).toBeGreaterThanOrEqual(2);
        const imp = (await c.imports())!;
        const kind = (name: string): string | undefined => imp.modules!.find((m) => m.name === name)?.kind;
        expect([kind("app"), kind("geom"), kind("object")]).toEqual(["root", "included", "imported"]);
    });

    test("diagnostics from a buffer, then the disk text kept", async () => {
        const edited = app.replace("    return total", "    int bad = \"s\";\n    return total");
        const r = await c.compile(args, { [APP]: edited });
        expect(r.mode).toBe("kept");
        expect(r.fromBuffer).toEqual([APP]);
        expect(r.diagnostics.map((d) => [d.severity, d.start, d.message])).toEqual([
            ["error", at(edited, "\"s\""), "cannot implicitly convert expression `\"s\"` of type `string` to `int`"],
        ]);
        const back = await c.compile(args);
        expect([back.mode, back.errors]).toEqual(["kept", 0]);
    });

    test("the default line, no djs.ldc2Line: the folder and its src/ on the import path, geom found", async () => {
        const flags = await import(new URL("host/flags.js", DIST).href) as typeof import("./flags.js");
        const r = await c.compile([...flags.planFlags(flags.defaultLine(REPO), REPO).args, APP]);
        expect([r.status, r.errors, r.mode], r.output).toEqual([0, 0, "fresh"]);
        expect((await c.definition(APP, ...pos(at(app, "Vec!int"), 1), app))!.result!.file).toBe(GEOM);
    });
});

/** A position as the query methods' (line, character) arguments, `skip` characters further. */
function pos(p: Position, skip = 0): [number, number] {
    return [p.line, p.character + skip];
}
