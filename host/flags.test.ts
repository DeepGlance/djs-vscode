// Tests for host/flags.ts on the ldc2 lines yab builds (yab/src/yab/melkor.d:663-698, adhoc.d crossCompileCmd).

import { homedir } from "node:os";
import { describe, expect, test } from "vitest";
import { ldcRootArgs, planFlags, splitLine, targetArgs } from "./flags.js";

const ROOT = "/Users/pinver/Projects/DeepGlance/dgpro07";
const HOME = homedir();
const SYSROOT = `${HOME}/Projects/Prefix/sysroot/lin_a64/debian_13`;
const EDITOR = ["-c", "-o-", "-verrors=0"];

describe("planFlags — yab's lines", () => {
    test("the graph line for a Linux aarch64 dev build (ldcCmdUbnA64 + versions + -d-debug + dip1000 + -c -of)", () => {
        const line = `~/Projects/Prefix/tools/mac_a64/ldc2-1.43.0/bin/ldc2 --deps -i -Isrc --vcolumns -J~/Lembas `
            + `-J~/Projects/DeepGlance/fieldmanager -mtriple=aarch64-linux-gnu --gcc=clang -P=--target=aarch64-linux-gnu `
            + `-P=--sysroot=${SYSROOT} -P=-isystem${SYSROOT}/usr/include `
            + `--d-version=SoftwareEncoder -c --d-debug --preview=dip1000 -of/tmp/bin/labsensor_lin_a64_dg.a %s `
            + `-I${HOME}/Projects/DeepGlance/dgpro07/src -L-lstdc++ src/labsensor/labsensor.d glue.o`;
        const plan = planFlags(splitLine(line), ROOT);
        expect(plan.args).toEqual([
            "-i", `-I${ROOT}/src`, "--vcolumns", `-J${HOME}/Lembas`, `-J${HOME}/Projects/DeepGlance/fieldmanager`,
            "-mtriple=aarch64-linux-gnu", "--gcc=clang", "-P=--target=aarch64-linux-gnu", `-P=--sysroot=${SYSROOT}`,
            `-P=-isystem${SYSROOT}/usr/include`, "--d-version=SoftwareEncoder", "--d-debug", "--preview=dip1000",
            `-I${HOME}/Projects/DeepGlance/dgpro07/src`, ...EDITOR,
        ]);
        expect(plan.dropped.map((d) => d.flag)).toEqual([
            "~/Projects/Prefix/tools/mac_a64/ldc2-1.43.0/bin/ldc2", "--deps", "-c",
            "-of/tmp/bin/labsensor_lin_a64_dg.a", "%s", "-L-lstdc++", "src/labsensor/labsensor.d", "glue.o",
        ]);
    });

    test("adhoc.d's release line: -O3 stays (D_Optimized), -d-debug absent, -Jshare/claude made absolute", () => {
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
