// Tests for src/dmd/mars.ts (dmd/mars.d has no unittest blocks in the ported parts; 10 §1.6b).
//
// Every test loads the port in a FRESH module registry (`vi.resetModules()` + dynamic imports), because the
// functions write process globals (`global.params`, the identifier pool, the error counters) as they do in
// ldc2. Diagnostics are captured from stderr.
//
// ORACLE: ldmd2 1.43.0 (-c -o-): `-preview=dip25` -> "Deprecation: `-preview=dip25` no longer has any
// effect."; `-transition=3449` / `-transition=14246` are accepted silently; `x.zzz` on the command line ->
// "Error: unrecognized file extension zzz"; `.d` -> "Error: invalid file name '.d'".

import { describe, expect, test, vi } from "vitest";

/** A fresh registry with the startup inits the functions need (tokens, `global._init()`), and a stderr tap. */
async function fresh() {
    vi.resetModules();
    const mars = await import("./mars.js");
    const { global, FeatureState } = await import("./globals.js");
    const { initTokens } = await import("./tokens.js");
    const { Loc } = await import("./location.js");
    const { ds, dsToJs } = await import("../dstring.js");
    const { OutBuffer } = await import("./common/outbuffer.js");
    const { target } = await import("./target.js");
    const { VersionCondition } = await import("./cond.js");
    initTokens();
    global._init();
    Loc._init();
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => {
        stderr.push(typeof c === "string" ? c : new TextDecoder().decode(c));
        return true;
    });
    const restore = (): void => spy.mockRestore();
    return { mars, global, FeatureState, ds, dsToJs, OutBuffer, target, VersionCondition, stderr, restore };
}

describe("parsePreviewOption / parseRevertOption / parseTransitionOption (mars.d:499-583)", () => {
    test("a preview sets its Param field, bool or FeatureState (setFlagFor, mars.d:1959/1965)", async () => {
        const f = await fresh();
        try {
            f.mars.parsePreviewOption(f.global.params, f.ds("in"));
            f.mars.parsePreviewOption(f.global.params, f.ds("dip1000"));
            expect(f.global.params.previewIn).toBe(true);
            expect(f.global.params.useDIP1000).toBe(f.FeatureState.enabled);
            f.mars.parseRevertOption(f.global.params, f.ds("dip1000"));
            expect(f.global.params.useDIP1000).toBe(f.FeatureState.disabled);
            expect(f.global.errors).toBe(0);
        } finally {
            f.restore();
        }
    });

    test("a nested Param path: -transition=field sets params.v.field", async () => {
        const f = await fresh();
        try {
            f.mars.parseTransitionOption(f.global.params, f.ds("field"));
            expect(f.global.params.v.field).toBe(true);
        } finally {
            f.restore();
        }
    });

    test("`all` sets every non-deprecated preview and none of the deprecated ones", async () => {
        const f = await fresh();
        try {
            f.mars.parsePreviewOption(f.global.params, f.ds("all"));
            expect(f.global.params.previewIn).toBe(true);
            expect(f.global.params.useFastDFA).toBe(true);
            expect(f.stderr.join("")).toBe("");
        } finally {
            f.restore();
        }
    });

    test("a deprecated preview reports ldc2's deprecation and still sets the field", async () => {
        const f = await fresh();
        try {
            f.mars.parsePreviewOption(f.global.params, f.ds("dip25"));
            expect(f.stderr.join("")).toBe("Deprecation: `-preview=dip25` no longer has any effect.\n");
            expect(f.global.params.useDIP25).toBe(f.FeatureState.enabled);
        } finally {
            f.restore();
        }
    });

    test("legacy transitions: 3449 is `field`, 14246 is `dtorfields`, 14488 does nothing", async () => {
        const f = await fresh();
        try {
            f.mars.parseTransitionOption(f.global.params, f.ds("3449"));
            f.mars.parseTransitionOption(f.global.params, f.ds("14246"));
            f.mars.parseTransitionOption(f.global.params, f.ds("14488"));
            expect(f.global.params.v.field).toBe(true);
            expect(f.global.params.dtorFields).toBe(f.FeatureState.enabled);
            expect(f.global.errors).toBe(0);
        } finally {
            f.restore();
        }
    });

    test("`?` asks for the group's usage page (params.help.<group>)", async () => {
        const f = await fresh();
        try {
            f.mars.parseRevertOption(f.global.params, f.ds("?"));
            expect(f.global.params.help.revert).toBe(true);
            expect(f.global.errors).toBe(0);
        } finally {
            f.restore();
        }
    });
});

describe("createModules (mars.d:2125) — dispatch by extension", () => {
    test("sources become modules named by the file; objects, libraries, ddoc and json files go to params", async () => {
        const f = await fresh();
        try {
            const lib: Uint8Array[] = [];
            const files = ["dir/a.d", "b.di", "c.o", "d.a", "e.dylib", "f.ddoc", "g.json", "h"].map((s) => f.ds(s));
            const r = f.mars.createModules(files, lib, f.global.params, f.target, f.global.errorSink!);
            expect(r.err).toBe(false);
            expect([...r.modules].map((m) => f.dsToJs(m!.toChars()))).toEqual(["a", "b", "h"]);
            expect(lib.map((x) => f.dsToJs(x))).toEqual(["c.o", "d.a", "e.dylib"]);
            expect([...f.global.params.ddoc.files].map((x) => f.dsToJs(x))).toEqual(["f.ddoc"]);
            expect(f.global.params.json.doOutput).toBe(true);
            expect(f.dsToJs(f.global.params.json.name!)).toBe("g.json");
        } finally {
            f.restore();
        }
    });

    test("an unknown extension is an error through the sink", async () => {
        const f = await fresh();
        try {
            const r = f.mars.createModules([f.ds("x.zzz")], [], f.global.params, f.target, f.global.errorSink!);
            expect(r.err).toBe(true);
            expect(f.stderr.join("")).toBe("Error: unrecognized file extension zzz\n");
        } finally {
            f.restore();
        }
    });

    test("a source file with no name is `invalid file name`", async () => {
        const f = await fresh();
        try {
            const r = f.mars.createModules([f.ds(".d")], [], f.global.params, f.target, f.global.errorSink!);
            expect(r.err).toBe(true);
            expect(f.stderr.join("")).toBe("Error: invalid file name '.d'\n");
        } finally {
            f.restore();
        }
    });
});

test("printPredefinedVersions (mars.d:419): `predefs `, then each identifier after a space", async () => {
    const f = await fresh();
    try {
        f.VersionCondition.addPredefinedGlobalIdent(f.ds("LDC"));
        f.VersionCondition.addPredefinedGlobalIdent(f.ds("all"));
        const buf = new f.OutBuffer();
        f.mars.printPredefinedVersions(buf);
        expect(f.dsToJs(buf.peekSlice())).toBe("predefs  LDC all\n");
    } finally {
        f.restore();
    }
});
