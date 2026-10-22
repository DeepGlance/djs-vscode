// Tests for host/flags.ts on the ldc2 lines a build tool writes.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { defaultLine, deprecationsAreErrors, ldcRootArgs, planFlags, splitLine, targetArgs } from "./flags.js";

const ROOT = "/work/app";
const HOME = homedir();
const SYSROOT = "/opt/sysroot/debian";
const EDITOR = ["-c", "-o-", "-verrors=0"];

describe("planFlags — a build tool's lines", () => {
    test("the graph line for a Linux aarch64 dev build (ldcCmdUbnA64 + versions + -d-debug + dip1000 + -c -of)", () => {
        const line = `~/tools/ldc2-1.43.0/bin/ldc2 --deps -i -Isrc --vcolumns -J~/assets `
            + `-J~/shared -mtriple=aarch64-linux-gnu --gcc=clang -P=--target=aarch64-linux-gnu `
            + `-P=--sysroot=${SYSROOT} -P=-isystem${SYSROOT}/usr/include `
            + `--d-version=Feature -c --d-debug --preview=dip1000 -of/tmp/bin/sensor_lin_a64.a %s `
            + `-I${HOME}/app/src -L-lstdc++ src/sensor/sensor.d glue.o`;
        const plan = planFlags(splitLine(line), ROOT);
        expect(plan.args).toEqual([
            "-i", `-I${ROOT}/src`, "--vcolumns", `-J${HOME}/assets`, `-J${HOME}/shared`,
            "-mtriple=aarch64-linux-gnu", "--gcc=clang", "-P=--target=aarch64-linux-gnu", `-P=--sysroot=${SYSROOT}`,
            `-P=-isystem${SYSROOT}/usr/include`, "--d-version=Feature", "--d-debug", "--preview=dip1000",
            `-I${HOME}/app/src`, ...EDITOR,
        ]);
        expect(plan.dropped.map((d) => d.flag)).toEqual([
            "~/tools/ldc2-1.43.0/bin/ldc2", "--deps", "-c",
            "-of/tmp/bin/sensor_lin_a64.a", "%s", "-L-lstdc++", "src/sensor/sensor.d", "glue.o",
        ]);
    });

    test("a release line: -O3 stays (D_Optimized), -d-debug absent, -Jshare/claude made absolute", () => {
        const plan = planFlags(splitLine("-i -Isrc -Jshare/claude --preview=dip1000 -O3 -release -g -gcc=clang"), ROOT);
        expect(plan.args).toEqual(["-i", `-I${ROOT}/src`, `-J${ROOT}/share/claude`, "--preview=dip1000", "-O3",
            "-release", "-gcc=clang", ...EDITOR]);
        expect(plan.dropped.map((d) => d.flag)).toEqual(["-g"]);
    });

    test("the armv6kz line keeps its target flags: the shim, not the table, refuses them", () => {
        const plan = planFlags(splitLine("-mtriple=armv6kz-linux-gnueabihf -mcpu=arm1176jzf-s -float-abi=hard "
            + "-mattr=+vfp2"), ROOT);
        expect(plan.args).toEqual(["-mtriple=armv6kz-linux-gnueabihf", "-mcpu=arm1176jzf-s", "-float-abi=hard",
            "-mattr=+vfp2", ...EDITOR]);
    });

    test("-i=<pattern> is kept (ruling 5); an unknown switch is kept for the shim to judge", () => {
        const plan = planFlags(["-i=std", "--i=core", "--something"], ROOT);
        expect(plan.args).toEqual(["-i=std", "--i=core", "--something", ...EDITOR]);
        expect(plan.dropped).toEqual([]);
    });
});

describe("ldcRootArgs — the setting djs.ldcRoot", () => {
    test("empty: nothing (the bundled tree); a root: --djs-ldc=, ~ expanded and a relative path resolved", () => {
        expect(ldcRootArgs("  ", ROOT)).toEqual([]);
        expect(ldcRootArgs("~/ldc2-1.43.0", ROOT)).toEqual([`--djs-ldc=${HOME}/ldc2-1.43.0`]);
        expect(ldcRootArgs("ldc", ROOT)).toEqual([`--djs-ldc=${ROOT}/ldc`]);
    });
});

describe("targetArgs — the setting djs.target", () => {
    test("added only when the line names no -mtriple, in either form, and the setting is not empty", () => {
        expect(targetArgs("x86_64-linux-gnu", EDITOR)).toEqual(["-mtriple=x86_64-linux-gnu"]);
        expect(targetArgs(" arm64-apple-darwin24.0.0 ", EDITOR)).toEqual(["-mtriple=arm64-apple-darwin24.0.0"]);
        expect(targetArgs("x86_64-linux-gnu", ["-mtriple=aarch64-linux-gnu", ...EDITOR])).toEqual([]);
        expect(targetArgs("x86_64-linux-gnu", ["-mtriple", "aarch64-linux-gnu", ...EDITOR])).toEqual([]);
        expect(targetArgs("", EDITOR)).toEqual([]);
    });
});

describe("defaultLine — the setting djs.ldc2Line empty", () => {
    test("the folder, then its source/ and src/ where they exist; a path with a space stays one token", () => {
        const root = mkdtempSync(join(tmpdir(), "djs default "));
        try {
            expect(defaultLine(root)).toEqual(["ldc2", "-i", `-I${root}`]);
            expect(planFlags(defaultLine(root), root).args).toEqual(["-i", `-I${root}`, ...EDITOR]);
            mkdirSync(join(root, "src"));
            expect(defaultLine(root)).toEqual(["ldc2", "-i", `-I${root}`, `-I${root}/src`]);
            mkdirSync(join(root, "source"));
            expect(planFlags(defaultLine(root), root).args).toEqual(
                ["-i", `-I${root}`, `-I${root}/source`, `-I${root}/src`, ...EDITOR]);
        } finally {
            rmSync(root, { recursive: true });
        }
    });
});

describe("deprecationsAreErrors — what the status bar counts", () => {
    test("the last of -d, -de, -dw wins; kept by planFlags", () => {
        expect(deprecationsAreErrors(planFlags(splitLine("ldc2 -i -de src/app.d"), ROOT).args)).toBe(true);
        expect(deprecationsAreErrors(["-de", "-dw"])).toBe(false);
        expect(deprecationsAreErrors(["-dw", "-d", "-de"])).toBe(true);
        expect(deprecationsAreErrors(["-de", "-d"])).toBe(false);
        expect(deprecationsAreErrors(["-debug", "-d-debug", "--d-version=de"])).toBe(false);
        expect(deprecationsAreErrors(EDITOR)).toBe(false);
    });
});
