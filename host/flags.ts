// The build tool's ldc2 line -> the command line of a save-time compile.
//
// The extension does not replay the build tool's line: it keeps the flags that change what is compiled or
// diagnosed and drops the ones that only shape the build. Unknown flags are kept, so the shim, not this table,
// decides what it supports: a flag it refuses shows as `djs: unsupported flag` instead of silently vanishing.
//
// COMPILE-DEFINING (kept): -I, -J (made absolute), -i and -i=<patterns> (ruling 5: on at save time, since the
// kept-module engine keeps -i compiles), -mtriple, -mcpu, -mattr, -float-abi (the target; the shim models
// aarch64-linux-gnu and x86_64-linux-gnu, refuses armv6kz and the others), -d-version/--d-version, -d-debug, -O*
// (D_Optimized), -release, -unittest, --preview, --checkaction, --vcolumns, -P (ImportC's preprocessor), --gcc (which
// C compiler preprocesses).
// BUILD-ONLY (dropped): --deps, -c, -of, -od, -op, -oq, -L, -defaultlib, -debuglib, -g*, -fPIC, -lowmem,
// -disable-linker-strip-dead, the source files and link inputs of the line (the saved file is the one root), and
// the build tool's `%s` placeholder.
// ADDED: -c -o- -verrors=0 (the editor-mode contract, 10 §4.7), then the root file.
// With no line set, `defaultLine` gives one from the folder's layout.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface FlagPlan {
    /** The save-time command line without the root file. */
    args: string[];
    /** Each dropped token with the reason, for the output channel. */
    dropped: { flag: string; why: string }[];
}

/** Splits a command line as the build tool's shell does for its lines: whitespace only, no quoting in them. */
export function splitLine(line: string): string[] {
    return line.split(/\s+/).filter((t) => t !== "");
}

/**
 * The line a workspace folder compiles with when `djs.ldc2Line` is empty, as tokens (a folder path may hold spaces):
 * `ldc2 -i -I<root>`, plus `-I<root>/source` and `-I<root>/src` where those directories exist (dub's layouts), so a
 * project opened with no setting compiles its own modules against the bundled druntime and Phobos. Planned by
 * `planFlags` like a written line.
 */
export function defaultLine(root: string): string[] {
    const dirs = [root, ...["source", "src"].map((d) => join(root, d)).filter((d) => existsSync(d))];
    return ["ldc2", "-i", ...dirs.map((d) => `-I${d}`)];
}

/** `~` and `~/x` to the home directory; lines write `-J~/dir`. */
function expandTilde(p: string): string {
    return p === "~" ? homedir() : p.startsWith("~/") ? homedir() + p.slice(1) : p;
}

function absolute(p: string, root: string): string {
    const e = expandTilde(p);
    return isAbsolute(e) ? e : resolve(root, e);
}

/**
 * The switch the setting `djs.ldcRoot` adds in front of the command line: `--djs-ldc=<root>` (`~` expanded, a relative
 * path resolved against `root`), which makes djs play that ldc2 install's import tree instead of the one bundled with
 * it; none for an empty setting. djs refuses a root without `import/object.d` (`djs: unsupported flag`).
 */
export function ldcRootArgs(setting: string, root: string): string[] {
    const s = setting.trim();
    return s === "" ? [] : [`--djs-ldc=${absolute(s, root)}`];
}

/**
 * Whether the planned command line `planned` makes deprecations errors: the last of `-d`, `-de`, `-dw` is `-de`, as
 * the compiler reads them, the last one winning (djs refuses the `--de` spelling, `djs: unsupported flag`).
 */
export function deprecationsAreErrors(planned: readonly string[]): boolean {
    return planned.filter((a) => /^-d[ew]?$/.test(a)).at(-1) === "-de";
}

/**
 * The switch the setting `djs.target` adds when the planned command line `planned` names no target:
 * `-mtriple=<target>`; none when it names one (`-mtriple=<t>` or `-mtriple <t>`) or the setting is empty, the
 * compile then targeting the host's triple, which djs derives from the platform (an arm64 Mac, Linux on aarch64 or
 * x86_64) and refuses elsewhere. djs refuses a target it does not model (`djs: unsupported flag`).
 */
export function targetArgs(setting: string, planned: readonly string[]): string[] {
    const t = setting.trim();
    return t === "" || planned.some((a) => a.startsWith("-mtriple")) ? [] : [`-mtriple=${t}`];
}

const PATH_PREFIXES = ["-I", "-J"];
const DROP_EXACT = new Map<string, string>([
    ["-c", "build-only: the editor adds its own -c -o-"],
    ["-o-", "build-only: the editor adds its own -c -o-"],
    ["-op", "build-only: object file paths"],
    ["-oq", "build-only: object file names"],
    ["-fPIC", "build-only: codegen"],
    ["-lowmem", "build-only: GC mode"],
    ["-disable-linker-strip-dead", "build-only: link"],
]);
const DROP_PREFIX: [string, string][] = [
    ["--deps", "build-only: dependency output"],
    ["-deps", "build-only: dependency output"],
    ["-of", "build-only: output file"],
    ["-od", "build-only: output directory"],
    ["-L", "build-only: linker flag"],
    ["-defaultlib", "build-only: link"],
    ["-debuglib", "build-only: link"],
];
/** -g, -gc, -gf, -gs and LLVM's -gline-tables-only / -gdwarf* / -gsplit-dwarf; not -gcc. */
const DEBUG_INFO = /^-(g|gc|gf|gs|gline-tables-only|gsplit-dwarf|gdwarf.*)$/;
const INPUT = /\.(d|di|c|h|i|o|a|so|dylib|obj|lib)$/;

/**
 * Plans the save-time command line from `line`, the ldc2 command a build tool builds for the repository's target
 * (its compile lines plus the target's flags), with or without the compiler path in front. Relative paths resolve
 * against `root`, the repository root, where the build tool runs ldc2.
 */
export function planFlags(line: readonly string[], root: string): FlagPlan {
    const args: string[] = [];
    const dropped: FlagPlan["dropped"] = [];
    let i = 0;
    if (line.length && !line[0]!.startsWith("-") && /(^|\/)(ldc2|ldmd2)$/.test(line[0]!)) {
        dropped.push({ flag: line[0]!, why: "the compiler: djs replaces it" });
        i = 1;
    }
    for (; i < line.length; i++) {
        const t = line[i]!;
        if (t === "%s") {
            dropped.push({ flag: t, why: "a placeholder for the sources" });
            continue;
        }
        if (!t.startsWith("-")) {
            dropped.push({ flag: t, why: INPUT.test(t) ? "an input of the build: the saved file is the root"
                : "a positional argument of the build" });
            continue;
        }
        const exact = DROP_EXACT.get(t);
        if (exact !== undefined) {
            dropped.push({ flag: t, why: exact });
            continue;
        }
        if (DEBUG_INFO.test(t)) {
            dropped.push({ flag: t, why: "build-only: debug information" });
            continue;
        }
        const prefix = DROP_PREFIX.find(([p]) => t.startsWith(p));
        if (prefix !== undefined) {
            dropped.push({ flag: t, why: prefix[1] });
            continue;
        }
        const pathPrefix = PATH_PREFIXES.find((p) => t.startsWith(p) && t.length > p.length);
        if (pathPrefix !== undefined) {
            const v = t.slice(pathPrefix.length).replace(/^=/, "");
            args.push(pathPrefix + absolute(v, root));
            continue;
        }
        args.push(t);
    }
    args.push("-c", "-o-", "-verrors=0");
    return { args, dropped };
}
