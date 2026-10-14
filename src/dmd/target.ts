// Ported from dmd/target.d (module dmd.target), as LDC 1.43.0 builds it.
//
// THE TARGETS. ldc2 answers every target question from `global.params.targetTriple`, the triple of its
// target machine (driver/main.cpp:1239). The port models that triple with `Triple` (below) for the three
// targets the shim accepts: the host default, arm64-apple-darwin (Apple M2 dev host, _ground-truth.md
// §3/§6: LP64, Mach-O, `real` == IEEE double), and, under `-mtriple=` (10 §4.8), aarch64-unknown-linux-gnu
// (ELF, `real` == IEEE quad) and x86_64-unknown-linux-gnu (ELF, `real` == x87 80-bit extended). Every
// triple query of LDC's C++ below is a query on that model; an arm for another triple is dead and says so.
// What the triple never changes is the HOST: CTFE computes `real` in ldc2's own `real_t`, the Mac's double
// (root/ctfloat.ts), whatever `real.sizeof` the target gives.
//
// THE IN_LLVM SPLIT (_config.md §1 row `IN_LLVM` = ON; 07 §1). Much of dmd's `Target` exists twice
// in target.d: a `version (IN_LLVM)` arm and a `!IN_LLVM` (DMD back end) arm. We are LDC, so:
//   - every `!IN_LLVM` block is resolved away (the version-identifier predefs at target.d:101-310,
//     DMD's `_init`/`objectFormat`/`setCPU`/`deinitialize`, the D bodies of `toArgTypes`,
//     `isReturnOnStack`, `preferPassByRef`, `getTargetInfo`, `isCalleeDestroyingArgs`,
//     `libraryObjectMonitors`, `supportsLinkerDirective`, `isXmmSupported`, `isPOSIX`,
//     `stackAlign`, and the `TargetC`/`TargetCPP`/`TargetObjC` `initialize` members);
//   - the IN_LLVM arm declares many members as BODILESS `extern (C++)` functions whose bodies live
//     in LDC's C++ (`gen/target.cpp`, `gen/abi/*.cpp`, `gen/llvmhelpers.cpp`, `gen/objcgen.cpp`).
//     Per 11 §2.5 (bodiless-`extern(C++)` bullet) those bodies are READ from the C++ (legitimate
//     ground truth) and ported here with the target triple const-folded, when the result is fixed
//     at translation time. Each such member cites its C++ line; a triple query reads the `Triple`
//     model, and an arm no supported triple reaches carries a `resolved:` comment. The ABI trio
//     `toArgTypes`/`isReturnOnStack`/`preferPassByRef` (gen/target.cpp:334-350, gen/abi/aarch64.cpp:64-87,
//     gen/abi/x86-64.cpp:203-217, gen/abi/abi.cpp:78) branches on the type, so it is ported as code in
//     full, on top of argtypes_aarch64.ts and argtypes_sysv_x64.ts.
//   - where the C++ needs an LLVM data-layout query we cannot run, the answer per triple is used only
//     where an ldc2 1.43.0 probe proves it (`target.test.ts` pins every such value per triple).
//
// ORACLE: <ldc2-1.43.0>/bin/ldc2 (`--version`: "Default
// target: arm64-apple-darwin27.0.0", "Host CPU: apple-m2"), with `-mtriple=<t> -c -o-` for a Linux
// triple. Probe results are quoted where used, `[darwin | aarch64-linux | x86_64-linux]` when they differ.
//
// ARGTYPES EDGES: `dmd.argtypes_aarch64` and `dmd.argtypes_sysv_x64` (reached by gen/target.cpp:340-342
// and, through `TargetABI::getArgTypes` (gen/abi/abi.cpp:78), by `isReturnOnStack` and `preferPassByRef`)
// are ported (argtypes_aarch64.ts, argtypes_sysv_x64.ts). D's own imports of them (target.d:1114, :1217)
// sit in the `!IN_LLVM` arm and are resolved away with it; LDC's edges are C++, so the TS edges are
// module-level value imports, LAST (01 §4.4 hoist, §4.8 position). Consumers: the NRVO decision
// (semantic3.d:666), funcsem.d:2801, `__traits(isReturnOnStack)` (traits.d:1495), `__argTypes` (expressionsem.d:9147),
// `in` parameters of struct/static-array type under `-preview=in` (typesem `preferPassByRef`), and
// `sd.argTypes` (dsymbolsem.d:10290), which `getArgTypes` below reads back for a sized struct.

import { release } from "node:os";
import { TY, LINK, Sizeok } from "./astenums.js";
import { EXP } from "./tokens.js";
// dmd/globals.d:34 — `enum IN_LLVM = true` (we are LDC; _config.md §1). Carried as a value, not
// folded away by hand, wherever D itself spells the flag in an expression (e.g. target.d:868).
// `global` is read only inside method bodies (never at load — 01 §4.5 rule 3).
import { IN_LLVM, global } from "./globals.js";
import { Loc } from "./location.js";
import { assert, assertUnreachable } from "../assert.js";
import { maskUnsignedN } from "../numeric.js";
import { ds, dsToJs, dsEquals, cstr } from "../dstring.js";
import type { DString } from "../dstring.js";
import type { Param } from "./globals.js";
import { CTFloat } from "./root/ctfloat.js";
import type { real_t } from "./root/ctfloat.js";
import { Array as DArray } from "./root/array.js"; // value: `createExpressions()` (08 §3)
import type { Expressions } from "./arraytypes.js";
import type { Scope } from "./dscope.js";
import type { FuncDeclaration } from "./func.js";
import type { Statement } from "./statement.js";
import type { Dsymbol } from "./dsymbol.js";
import type { ClassDeclaration } from "./dclass.js";
import type { BitFieldDeclaration } from "./declaration.js";
// AST-node modules BEFORE the *sem module (01 §4.8): entering the core SCC through a node file works.
import { Type, TypeIdentifier } from "./mtype.js";
import type { TypeFunction, TypeTuple } from "./mtype.js";
import { Identifier } from "./identifier.js";
import { Id } from "./id.js";
import { IntegerExp, StringExp, TupleExp } from "./expression.js";
import type { Expression } from "./expression.js";
import { size, alignsize, alignment, isScalar, isIntegral, toBasetype, typeSemantic, pointerTo } from "./typesem.js";
// dmd/target.d:818 — D's function-local `import dmd.hdrgen : EXPtoString;`, hoisted (01 §4.4).
// LAST in the import list on purpose (01 §4.8): hdrgen pulls mtype/dsymbol as values, and entering
// the core SCC through this edge first is exactly the load-order hazard that rule names.
import { EXPtoString } from "./hdrgen.js";
// Registration edge of 01 §4.4 (module-level-import extension): declaration.d:34 imports `dmd.target`,
// but that value import breaks load from declaration.ts, so THIS module hands `target` over at its
// end (`registerTarget(target);`). declaration.ts carries the measurement and the ORDER CONTRACT.
// LAST, after the hdrgen edge, for the same 01 §4.8 reason.
import { registerTarget } from "./declaration.js";
// gen/target.cpp:342 — LDC's C++ calls the D `toArgTypes_aarch64` (argtypes_aarch64.d:34). A value
// edge into the core SCC (argtypes_aarch64 imports typesem, dsymbolsem and expressionsem), so it goes
// LAST (01 §4.8): read only inside method bodies, never at load.
import { toArgTypes_aarch64 } from "./argtypes_aarch64.js";
// gen/target.cpp:340 — the same edge to the D `toArgTypes_sysv_x64` (argtypes_sysv_x64.d:36), LAST for the same
// reason.
import { toArgTypes_sysv_x64 } from "./argtypes_sysv_x64.js";
// dmd/target.d:1729 — `import dmd.mangle.cpp : toCppMangleItanium;` and its :1759 twin, function-local in
// `toMangle`/`typeInfoMangle`, hoisted (01 §4.4) as a value import LAST (01 §4.8): mangle/cpp enters the core SCC
// (typesem, dsymbolsem, expressionsem) and reads `target` back only inside method bodies. The `dmd.mangle.cppwin`
// imports beside them (:1730, :1760) serve only the MSVC arm, resolved away (`isTargetWindowsMSVC()` is false).
import { toCppMangleItanium, cppTypeInfoMangleItanium } from "./mangle/cpp.js";

// dmd/target.d:36 — `import gen.llvmhelpers : isTargetWindowsMSVC;` (inside `version (IN_LLVM)`,
// target.d:33-37, next to `import dmd.globals : IN_LLVM;`, imported above). `isTargetWindowsMSVC` is a bodiless
// `extern (C++)` function (gen/llvmhelpers.d:22) implemented at gen/llvmhelpers.cpp:71 as
// `global.params.targetTriple->isWindowsMSVCEnvironment()`; no supported triple is MSVC, so it is `false`,
// so each of its three call sites (target.d:1734, :1764, :1852) is resolved at the site and the
// import has no TS counterpart.

/**
 * The part of `llvm::Triple` the frontend's target questions read, for the triples the shim accepts
 * (10 §4.8). ldc2 builds `global.params.targetTriple` from its target machine (driver/main.cpp:1238-1239),
 * whose triple createTargetMachine normalizes (driver/targetmachine.cpp:447-480); `getTriple()` is that
 * normalized string for a `-mtriple`, and for the host LLVM's default triple string, the one ldc2's `-v`
 * prints (main.cpp:224, :338); the target machine renames its OS `macos<version>`, which only the C
 * preprocessor's `-target` shows (driver/cpreprocessor.ts). Immutable; `HOST_TRIPLE` and `parseTargetTriple()`
 * are the only instances callers use.
 */
export class Triple {
    /**
     * Params:
     *   arch     = `getArch()`: the architecture enum (`aarch64` covers LLVM's `arm64` spelling).
     *   archName = `getArchName()`: the arch component as spelled (`arm64` for the host, `aarch64`, `x86_64`).
     *   os       = `getOS()`: `darwin` (Darwin and MacOSX alike) or `linux`.
     *   triple   = `getTriple()`: the normalized string.
     *   osMajor  = `getOSMajorVersion()`.
     *   explicit = the `-mtriple` spelling as given (tool.cpp:103 `opts::mTargetTriple`), null for the host.
     */
    constructor(readonly arch: "aarch64" | "x86_64", readonly archName: string, readonly os: "darwin" | "linux",
                readonly triple: string, readonly osMajor: number, readonly explicit: string | null) {}

    getTriple(): string { return this.triple; }
    isOSDarwin(): boolean { return this.os === "darwin"; }
    isOSLinux(): boolean { return this.os === "linux"; }
    /** Mach-O for Darwin, ELF for Linux (llvm `Triple::getDefaultFormat`). */
    isOSBinFormatMachO(): boolean { return this.os === "darwin"; }
    isOSBinFormatELF(): boolean { return this.os === "linux"; }
}

/**
 * The target ldc2 builds with no `-mtriple` on the host `platform`/`arch` (Node's names; `release` the kernel's,
 * `os.release()`). On an arm64 Mac (driver/targetmachine.cpp:447-470), LLVM's default triple
 * `arm64-apple-darwin<release>`, its OS renamed `macos<version>` (driver/cpreprocessor.ts prints that renamed
 * string; the OS major is the Darwin major either way, 27 on Darwin 27.0.0). On Linux aarch64 and x86_64, LLVM's
 * default `<arch>-unknown-linux-gnu`, the target `-mtriple=<arch>-linux-gnu` gives, without a spelling of its own
 * (not probed: no Linux ldc2 runs here). Null for any other host (an Intel Mac, Windows): the shim models no target
 * for it, and the driver refuses a run without `-mtriple` there (src/djs.ts). What stays the Mac's on a Linux host:
 * CTFE's `real_t` and the rest of 10 §4.8's "What stays the HOST's".
 */
export function hostTripleOf(platform: string, arch: string, release: string): Triple | null {
    if (platform === "darwin" && arch === "arm64")
        return new Triple("aarch64", "arm64", "darwin", `arm64-apple-darwin${release}`, Number.parseInt(release, 10),
            null);
    if (platform === "linux" && arch === "arm64")
        return new Triple("aarch64", "aarch64", "linux", "aarch64-unknown-linux-gnu", 0, null);
    if (platform === "linux" && arch === "x64")
        return new Triple("x86_64", "x86_64", "linux", "x86_64-unknown-linux-gnu", 0, null);
    return null;
}

/** This host's `hostTripleOf`, built once at load: the host does not change under a running process. */
export const HOST_TRIPLE: Triple | null = hostTripleOf(process.platform, process.arch, release());

/** The error the driver reports for a run without `-mtriple` on a host `hostTripleOf` has no triple for. */
export const UNSUPPORTED_HOST = `djs: unsupported host ${process.platform}/${process.arch}: the shim models an arm64 `
    + "Mac and Linux on aarch64 or x86_64; pass -mtriple= one of the modelled targets (10 §4.8)";

/** `HOST_TRIPLE`; throws `UNSUPPORTED_HOST` on a host without one (the driver has already reported it). */
export function hostTriple(): Triple {
    if (HOST_TRIPLE === null)
        throw new Error(UNSUPPORTED_HOST);
    return HOST_TRIPLE;
}

/**
 * The `-mtriple` values the shim accepts (10 §4.2, §4.8): the two Linux triples (aarch64 and x86_64 GNU),
 * each also in its normalized spelling, and the arm64 Mac as
 * `arm64|aarch64-apple-darwin|macos|macosx[<version>]`, kept as spelled (LLVM's normalization leaves these unchanged,
 * ldc2 probe: `-v`'s config line), its OS major the version's first number, 0 without one (ldc2's default with that
 * `-mtriple`, from any host). Returns: the triple ldc2's target machine would carry, or null for any other value (the
 * shim refuses it).
 */
export function parseTargetTriple(spelling: string): Triple | null {
    switch (spelling) {
    case "aarch64-linux-gnu":
    case "aarch64-unknown-linux-gnu":
        return new Triple("aarch64", "aarch64", "linux", "aarch64-unknown-linux-gnu", 0, spelling);
    case "x86_64-linux-gnu":
    case "x86_64-unknown-linux-gnu":
        return new Triple("x86_64", "x86_64", "linux", "x86_64-unknown-linux-gnu", 0, spelling);
    default: {
        const mac = /^(arm64|aarch64)-apple-(?:darwin|macosx?)(\d+(?:\.\d+){0,2})?$/.exec(spelling);
        if (mac === null)
            return null;
        const osMajor = mac[2] === undefined ? 0 : Number.parseInt(mac[2], 10);
        return new Triple("aarch64", mac[1]!, "darwin", spelling, osMajor, spelling);
    }
    }
}

/**
 * `*global.params.targetTriple`, or the host triple when no driver has set one (a test harness). Reads `global`:
 * call it from method bodies only, never at load (01 §4.5 rule 3).
 */
export function targetTriple(): Triple {
    return global.params.targetTriple ?? hostTriple();
}

/// dmd/target.d:39 — `enum CPU : ubyte`. Declared unconditionally in D; every READER of it
/// (`Target.cpu`, `setCPU`, the `isVectorTypeSupported`/`isVectorOpSupported` SSE/AVX ladders and
/// the `D_SIMD`/`D_AVX` predefs) sits in a `!IN_LLVM` arm, so under the live config nothing reads it.
export enum CPU {
    x87,
    mmx,
    sse,
    sse2,
    sse3,
    ssse3,
    sse4_1,
    sse4_2,
    avx,                // AVX1 instruction set
    avx2,               // AVX2 instruction set
    avx512,             // AVX-512 instruction set

    // Special values that don't survive past the command line processing
    baseline,           // (default) the minimum capability CPU
    native,             // the machine the compiler is being run on
}

/**
 * dmd/target.d:58 — `Target.OS defaultTargetOS() @safe`. The OS the COMPILER ITSELF runs on (a chain
 * of host `version` tests), used by the driver for `-os=host` (mars.d:1277).
 *
 * resolved: `version (Windows)` -> OFF, `version (linux)` -> not taken, `version (OSX)` -> ON: the
 * port's fixed host is macOS (_ground-truth.md §6; `_config.md` §4 flag #1 records that the
 * linux-vs-OSX collapse is still open). The remaining arms and the `static assert(0)` are dead.
 */
export function defaultTargetOS(): OS {
    return OS.OSX;
}

/**
 * dmd/target.d:78 — `ubyte defaultTargetOSMajor() @safe`. resolved: `version (FreeBSD)` -> OFF
 * (host is macOS), so the `else` arm: `return 0;`.
 */
export function defaultTargetOSMajor(): number {
    return 0;
}

// dropped: the whole `version (IN_LLVM) {} else { ... } // !IN_LLVM` block at target.d:101-310 —
// `addDefaultVersionIdentifiers`, `addPredefinedGlobalIdentifiers`, `addCRuntimePredefinedGlobalIdent`
// and `addCppRuntimePredefinedGlobalIdent` are DMD's; LDC predefines version identifiers in its
// driver (driver/main.cpp), outside the frontend (07 §1).

// dmd/target.d:336 — `enum OS : ubyte` (nested in `Target`; exported under its own name, which the
// tree already imports). Flag bits kept faithful: `Posix` is a bit-MASK that OR-covers the unix
// variants (dmd uses `os & Target.OS.Posix` as a family test).
export enum OS {
    /* These are mutually exclusive; one and only one is set.
     * Match spelling and casing of corresponding version identifiers
     */
    none         = 0,
    linux        = 1,
    Windows      = 2,
    OSX          = 4,
    OpenBSD      = 8,
    FreeBSD      = 0x10,
    Solaris      = 0x20,
    DragonFlyBSD = 0x40,

    // Combination masks
    all   = linux | Windows | OSX | OpenBSD | FreeBSD | Solaris | DragonFlyBSD,
    Posix = linux | OSX | OpenBSD | FreeBSD | Solaris | DragonFlyBSD,
}

// dmd/target.d:355 — `extern(D) enum ObjectFormat : ubyte` (nested in `Target`; the class-qualified
// spelling is preserved in the exported name). Its only D reader, `Target.objectFormat()`, is in the
// `!IN_LLVM` arm; LDC answers `__traits(getTargetInfo, "objectFormat")` from the triple instead.
export enum TargetObjectFormat {
    elf,
    macho,
    coff,
}

/**
 * dmd/target.d:405 — `extern (C++) struct FPTypeProperties(T)`: all properties of one floating point
 * type. Every field is `real_t` (a `number`, 09 §6) or `long` (a `bigint`, 09 §1).
 *
 * MONOMORPHIZED per 07 §3.4 (a template is emitted once per instantiation): the fields do not
 * depend on `T`, only `initialize()` does (it reads
 * `T.max`, `T.dig`, ... at D compile time). The shape is this base class; the three instantiations
 * D declares (target.d:436-438: `float`, `double`, `real_t`) are the three subclasses below, each
 * overriding `initialize()` with the constants its `T` has in the LDC host build.
 *
 * Field defaults are D's `.init`: `real_t` (a floating type) is NaN, `long` is 0.
 */
export abstract class TargetFPTypeProperties {
    max: real_t = NaN;          /// largest representable value that's not infinity
    min_normal: real_t = NaN;   /// smallest representable normalized value that's not 0
    nan: real_t = NaN;          /// NaN value
    infinity: real_t = NaN;     /// infinity value
    epsilon: real_t = NaN;      /// smallest increment to the value 1

    dig = 0n;           /// number of decimal digits of precision
    mant_dig = 0n;      /// number of bits in mantissa
    max_exp = 0n;       /// maximum int value such that 2^(max_exp-1) is representable
    min_exp = 0n;       /// minimum int value such that 2^(min_exp-1) is representable as a normalized value
    max_10_exp = 0n;    /// maximum int value such that 10^max_10_exp is representable
    min_10_exp = 0n;    /// minimum int value such that 10^min_10_exp is representable as a normalized value

    /// dmd/target.d:420 — `extern (D) void initialize()`: copy `T`'s compile-time properties.
    abstract initialize(): void;
}

/**
 * `FPTypeProperties!float` (target.d:436). `initialize()` stores `float`'s properties into `real_t`
 * (double) fields, so each value is the exact double of the float constant (09 §6.1: no f32
 * rounding of the carrier). ldc2 probe: `float.max == 0x1.fffffep+127`, `float.min_normal ==
 * 0x1p-126`, `float.epsilon == 0x1p-23`; dig 6, mant_dig 24, max_exp 128, min_exp -125,
 * max_10_exp 38, min_10_exp -37.
 */
export class TargetFPTypeProperties_float extends TargetFPTypeProperties {
    override initialize(): void {
        this.max = 3.4028234663852886e38;           // float.max        = 0x1.fffffep+127
        this.min_normal = 1.1754943508222875e-38;   // float.min_normal = 0x1p-126
        this.nan = NaN;                             // float.nan (quiet NaN, same double image as JS NaN)
        this.infinity = Infinity;                   // float.infinity
        this.epsilon = 1.1920928955078125e-7;       // float.epsilon    = 0x1p-23
        this.dig = 6n;
        this.mant_dig = 24n;
        this.max_exp = 128n;
        this.min_exp = -125n;
        this.max_10_exp = 38n;
        this.min_10_exp = -37n;
    }
}

/**
 * `FPTypeProperties!double` (target.d:437). ldc2 probe: `double.max == 0x1.fffffffffffffp+1023`,
 * `double.min_normal == 0x1p-1022`, `double.epsilon == 0x1p-52`; dig 15, mant_dig 53, max_exp 1024,
 * min_exp -1021, max_10_exp 308, min_10_exp -307.
 */
export class TargetFPTypeProperties_double extends TargetFPTypeProperties {
    override initialize(): void {
        this.max = 1.7976931348623157e308;          // double.max        = 0x1.fffffffffffffp+1023
        this.min_normal = 2.2250738585072014e-308;  // double.min_normal = 0x1p-1022
        this.nan = NaN;                             // double.nan
        this.infinity = Infinity;                   // double.infinity
        this.epsilon = 2.220446049250313e-16;       // double.epsilon    = 0x1p-52
        this.dig = 15n;
        this.mant_dig = 53n;
        this.max_exp = 1024n;
        this.min_exp = -1021n;
        this.max_10_exp = 308n;
        this.min_10_exp = -307n;
    }
}

/**
 * `FPTypeProperties!real_t` (target.d:438). `real_t` is the LDC HOST build's `real`; the 1.43.0
 * binary is an arm64-apple-darwin build, where `real` is IEEE double (ctfloat.ts header), so `T`'s
 * properties are `double`'s. `Target._init` then overwrites them for the TARGET's `real`
 * (gen/target.cpp:207-271), with the same values on the host — see `_init` below.
 */
export class TargetFPTypeProperties_real_t extends TargetFPTypeProperties {
    override initialize(): void {
        this.max = 1.7976931348623157e308;          // 0x1.fffffffffffffp+1023
        this.min_normal = 2.2250738585072014e-308;  // 0x1p-1022
        this.nan = NaN;
        this.infinity = Infinity;
        this.epsilon = 2.220446049250313e-16;       // 0x1p-52
        this.dig = 15n;
        this.mant_dig = 53n;
        this.max_exp = 1024n;
        this.min_exp = -1021n;
        this.max_10_exp = 308n;
        this.min_10_exp = -307n;
    }
}

/** The three LLVM types `getRealType` (gen/target.cpp:44) returns for a supported triple. */
export enum RealKind {
    double_,    // IEEE double: aarch64 Darwin
    quad,       // IEEE quad (fp128): aarch64 Linux
    x87,        // x87 80-bit extended (x86_fp80): x86_64 Linux
}

/***********************************************************
 * dmd/target.d:322 — `extern (C++) struct Target`. Describes a back-end target. At present it is
 * incomplete, but in the future it should grow to contain most or all target machine and target
 * O/S specific information.
 *
 * In many cases, calls to sizeof() can't be used directly for getting data type sizes since cross
 * compiling is supported and would end up using the host sizes rather than the target sizes.
 *
 * A singleton `target` is exported below, mirroring the module-global `__gshared Target target;`
 * (target.d:1876) that the whole frontend dots into. Its constructor is LDC's `Target::_init`
 * (gen/target.cpp:129) for the host triple; a driver re-runs it for `params.targetTriple`: see `_init`.
 *
 * Not a copied value anywhere in the frontend (only the `__gshared` instance exists), so no
 * `copy()` is provided (03 §1).
 */
export class Target {
    os: OS = OS.none;           // dmd/target.d:362 — `OS os;`
    osMajor = 0;                // dmd/target.d:363 — `ubyte osMajor;`

    // D ABI
    ptrsize = 0;                /// size of a pointer in bytes (target.d:366)
    // dropped: `void* realType; /// llvm::Type* for `real`` (target.d:369) — IN_LLVM codegen
    // payload (an `llvm::Type*`), _config.md §2 row "AST field holding an LLVM pointer".
    /**
     * The LLVM type of `real` (`getRealType`, gen/target.cpp:44): no D counterpart, the port's stand-in for the
     * dropped `realType` pointer, read where LDC's C++ asks that type a question (`llvmBits` in
     * gen/llvmhelpers.ts, `RealProperties` above).
     */
    realKind: RealKind = RealKind.double_;
    realsize = 0;               /// size a real consumes in memory (target.d:371)
    realpad = 0;                /// padding added to the CPU real size to bring it up to realsize
    realalignsize = 0;          /// alignment for reals
    classinfosize = 0;          /// size of `ClassInfo`
    maxStaticDataSize = 0n;     /// maximum size of static data (`ulong`, bigint domain — 09 §1)

    /// C ABI
    c: TargetC = new TargetC();

    /// C++ ABI
    cpp: TargetCPP = new TargetCPP();

    /// Objective-C ABI
    objc: TargetObjC = new TargetObjC();

    /// Architecture name
    architectureName: DString = ds("");

    // dmd/target.d:393 — `bool isX86;`. It and `CPU cpu`, `isAArch64`, `isX86_64` are declared only
    // inside `version (IN_LLVM) {} else` (target.d:388-394; target.h:169-174 likewise `#if !IN_LLVM`),
    // so no live D or C++ code reads them.
    // dropped: `cpu`, `isAArch64`, `isX86_64` — no reader in the port.
    // `isX86` is RETAINED, fixed to false (no supported triple is 32-bit x86), as the one input of the
    // `alignsize` data-layout table below (see its comment); that is its only reader.
    isX86 = false;              // generate 32 bit Intel x86 code
    isLP64 = false;             // pointers are 64 bits (target.d:395)

    // Environmental
    obj_ext: DString = ds("");  /// extension for object files (target.d:398)
    lib_ext: DString = ds("");  /// extension for static library files
    dll_ext: DString = ds("");  /// extension for dynamic library files
    run_noext = false;          /// allow -run sources without extensions

    FloatProperties: TargetFPTypeProperties_float = new TargetFPTypeProperties_float();     ///
    DoubleProperties: TargetFPTypeProperties_double = new TargetFPTypeProperties_double();  ///
    RealProperties: TargetFPTypeProperties_real_t = new TargetFPTypeProperties_real_t();    ///

    private tvalist: Type | null = null; // cached lazy result of va_listType() (target.d:440)

    // dropped: `private const(Param)* params;` (target.d:442) — written by `_init` (gen/target.cpp:130)
    // and read only by the `!IN_LLVM` bodies of `getTargetInfo`/`libraryObjectMonitors`; LDC's C++
    // reads `global.params` directly. No live reader.

    /**
     * The singleton's construction runs `_init` (below) for the host triple, so the module-global `target` is
     * initialized at load, as the frontend has always found it; the driver calls `_init` again (main.d:440
     * `target._init(params);`) on every compile, for `params.targetTriple`.
     */
    constructor() {
        this._init(null);
    }

    /**
     * dmd/target.d:456 — `void _init(ref const Param params);`, a bodiless `extern (C++)` member
     * implemented at gen/target.cpp:129 `void Target::_init(const Param &params)`, ported over the `Triple`
     * model (07 §1, 11 §2.5): `params.targetTriple`, or the host triple when it is null.
     *
     * D's `ref const Param` is never null; the port also accepts `null` solely so the constructor can run this
     * at module load, before `global` may exist (01 §4.5 rule 3): the host triple's state, which is also what a
     * driver that sets no triple gets.
     *
     * LOAD-TIME SAFETY: touches only this module's classes, `ds` and `CTFloat` — never `Type.*` or
     * `global`. Idempotent: every field it writes is assigned, none accumulated.
     */
    _init(params: Param | null): void {
        // gen/target.cpp:130 — `this->params = &params;` — dropped with the field (above).
        CTFloat.initialize();       // gen/target.cpp:132 (a no-op in the port: eager constants)
        this.initFPTypeProperties();// gen/target.cpp:133

        // gen/target.cpp:135-136
        const triple = params?.targetTriple ?? hostTriple();
        // resolved: `triple.isWindowsMSVCEnvironment()` -> false for every supported triple.
        const isMSVC = false;

        // gen/target.cpp:138-154 — the OS chain. resolved: Windows, the BSDs, Solaris and freestanding are not
        // supported triples.
        if (triple.isOSLinux()) {
            this.os = OS.linux;
        } else {
            assert(triple.isOSDarwin());
            this.os = OS.OSX;
        }

        // gen/target.cpp:156 — no frontend reader under IN_LLVM (its only D reader is the `!IN_LLVM` FreeBSD
        // predef at target.d:223).
        this.osMajor = triple.osMajor;

        // gen/target.cpp:158 — `ptrsize = gDataLayout->getPointerSize();`: 8 on every supported triple (ldc2
        // probe: `size_t.sizeof == 8`).
        this.ptrsize = 8;
        // gen/target.cpp:159-162 — `realType = getRealType(triple)` (gen/target.cpp:44-124; no `-real-precision`
        // switch is in the shim's table), then its data-layout alloc size, padding and ABI alignment:
        //   - aarch64 on Darwin: `double` (:78-82), 8 / 0 / 8;
        //   - aarch64 on Linux: `fp128` (:78-82), 16 / 0 / 16;
        //   - x86_64 on Linux: `x86_fp80` (:72-76), alloc 16, store 10 (realpad 6), align 16.
        // ldc2 probe: `real.sizeof` / `real.alignof` 8/8 | 16/16 | 16/16; `struct { char c; real r; }` 16 | 32 | 32.
        this.realKind = triple.arch === "x86_64" ? RealKind.x87 : triple.isOSDarwin() ? RealKind.double_
                                                                                        : RealKind.quad;
        this.realsize = this.realKind === RealKind.double_ ? 8 : 16;
        this.realpad = this.realKind === RealKind.x87 ? 6 : 0;
        this.realalignsize = this.realsize;
        this.classinfosize = 0; // unused (gen/target.cpp:163)
        // gen/target.cpp:164 — `maxStaticDataSize = std::numeric_limits<unsigned long long>::max();`
        // ldc2 probe: `int[0x4000_0000_0000_0001] big;` -> "... exceeds 0xffffffffffffffff size limit
        // for static array".
        this.maxStaticDataSize = 0xFFFF_FFFF_FFFF_FFFFn;

        this.c.crtDestructorsSupported = true; // unused as of 2.099 (gen/target.cpp:166)
        this.c.boolsize = 1;
        this.c.shortsize = 2;
        this.c.intsize = 4;
        this.c.longsize = (this.ptrsize === 8) && !isMSVC ? 8 : 4; // ldc2 probe: c_long.sizeof 8
        this.c.long_longsize = 8;
        this.c.long_doublesize = this.realsize; // ldc2 probe: c_long_double.sizeof 8 | 16 | 16
        // gen/target.cpp:173 — `triple.isOSWindows() ? 2 : 4`. resolved: no supported triple is Windows.
        this.c.wchar_tsize = 4;
        this.c.bitFieldStyle = isMSVC ? TargetCBitFieldStyle.MS : TargetCBitFieldStyle.Gcc_Clang;

        this.cpp.reverseOverloads = isMSVC; // according to DMD, only for MSVC++
        this.cpp.exceptions = true;
        this.cpp.twoDtorInVtable = !isMSVC;
        this.cpp.splitVBasetable = isMSVC;
        // gen/target.cpp:181 — `triple.getArch() == llvm::Triple::x86` (32-bit x86): no supported triple.
        this.cpp.wrapDtorInExternD = false;

        // gen/target.cpp:183 — `objc.supported = objc_isSupported(triple);`, gen/objcgen.cpp:21-36: Darwin on
        // `aarch64` or `x86_64` only. ldc2 probe: `D_ObjectiveC` is predefined on darwin only.
        this.objc.supported = triple.isOSDarwin();

        // gen/target.cpp:185 — `const llvm::StringRef archName = triple.getArchName();`. ldc2 probe: `-X` JSON
        // output `"architectures" : ["arm64"]` on the host.
        this.architectureName = ds(triple.archName);

        // gen/target.cpp:188 — `isLP64 = gDataLayout->getPointerSizeInBits() == 64;`: true on every supported
        // triple.
        this.isLP64 = true;
        // gen/target.cpp:189 — resolved: `!triple.isOSWindows()` -> true.
        this.run_noext = true;

        // gen/target.cpp:191 — `if (isMSVC) {` ... else `obj_ext = "o"; lib_ext = "a"`. resolved: isMSVC false.
        this.obj_ext = ds("o");
        this.lib_ext = ds("a");

        // gen/target.cpp:199-205 — resolved: `triple.isOSWindows()` -> false.
        this.dll_ext = triple.isOSDarwin() ? ds("dylib") : ds("so");

        // gen/target.cpp:207-271 — finalize RealProperties for the target's `real` type.
        this.RealProperties.nan = CTFloat.nan;
        this.RealProperties.infinity = CTFloat.infinity;

        // dependency signature (11 §1): D parses each limit with `CTFloat::parse` (gen/target.cpp:221-223,
        // :233-235, :245-250), whose port throws on a hex literal. The value below is the exact double the HOST
        // `real_t` (double, root/ctfloat.ts) holds after that parse: the double each string denotes, rounded to
        // nearest, overflowing to infinity and underflowing to 0 as `strtod` does. `isOutOfRange` is never read
        // by D. ldc2 probe: `real.max` / `real.min_normal` / `real.epsilon` print 1.79769e+308L / 2.22507e-308L /
        // 2.22045e-16L | infL / 0.0L / 1.92593e-34L | infL / 0.0L / 1.0842e-19L.
        switch (this.realKind) {
        case RealKind.double_:
            this.RealProperties.max = 1.7976931348623157e308;          // CTFloat::parse("0x1.fffffffffffffp+1023")
            this.RealProperties.min_normal = 2.2250738585072014e-308;  // CTFloat::parse("0x1p-1022")
            this.RealProperties.epsilon = 2.220446049250313e-16;       // CTFloat::parse("0x1p-52")
            this.RealProperties.dig = 15n;
            this.RealProperties.mant_dig = 53n;
            this.RealProperties.max_exp = 1024n;
            this.RealProperties.min_exp = -1021n;
            this.RealProperties.max_10_exp = 308n;
            this.RealProperties.min_10_exp = -307n;
            break;
        case RealKind.x87:
            this.RealProperties.max = Infinity;             // CTFloat::parse("0x1.fffffffffffffffep+16383")
            this.RealProperties.min_normal = 0;             // CTFloat::parse("0x1p-16382")
            this.RealProperties.epsilon = 1.0842021724855044e-19;   // CTFloat::parse("0x1p-63")
            this.RealProperties.dig = 18n;
            this.RealProperties.mant_dig = 64n;
            this.RealProperties.max_exp = 16384n;
            this.RealProperties.min_exp = -16381n;
            this.RealProperties.max_10_exp = 4932n;
            this.RealProperties.min_10_exp = -4931n;
            break;
        case RealKind.quad:
            // FIXME: hex constants
            this.RealProperties.max = Infinity;   // CTFloat::parse("1.18973149535723176508575932662800702e+4932")
            this.RealProperties.min_normal = 0;   // CTFloat::parse("3.36210314311209350626267781732175260e-4932")
            this.RealProperties.epsilon = 1.925929944387236e-34; // ("1.92592994438723585305597794258492732e-34")
            this.RealProperties.dig = 33n;
            this.RealProperties.mant_dig = 113n;
            this.RealProperties.max_exp = 16384n;
            this.RealProperties.min_exp = -16381n;
            this.RealProperties.max_10_exp = 4932n;
            this.RealProperties.min_10_exp = -4931n;
            break;
        }
        // resolved: the PPCDoubleDouble arm and the "unknown properties" warning (gen/target.cpp:255-270) are dead:
        // `getRealType` gives one of the three kinds above on every supported triple.
    }

    // dropped: target.d:463-725 `else // !IN_LLVM` — DMD's own `_init` body, `objectFormat`, `setCPU`,
    // `deinitialize`, and the D bodies of `alignsize`/`fieldalign`/`va_listType` (07 §1; the live
    // counterparts are the LDC members in this class; `alignsize` reuses the D body's table, see there).

    /// dmd/target.d:448 — `private void initFPTypeProperties()`.
    private initFPTypeProperties(): void {
        this.FloatProperties.initialize();
        this.DoubleProperties.initialize();
        this.RealProperties.initialize();
    }

    /**
     * dmd/target.d:458 — `uint alignsize(Type type);`, bodiless under IN_LLVM; the live
     * implementation is gen/target.cpp:277:
     *   `if (type->ty == TY::Tvoid) return 1; return gDataLayout->getABITypeAlign(DtoType(type)).value();`
     * i.e. the LLVM data layout's ABI alignment of the type's LLVM lowering, which the port cannot
     * query. The body below is the `!IN_LLVM` D body (target.d:637), which reproduces that answer
     * on the three supported triples for the 22 probeable basic types — `void` 1, 1/2/4/8-byte integers
     * and characters at their size, `float`/`ifloat` 4, `double`/`idouble` 8, `real`/`ireal`/`creal`
     * `realalignsize` (8 | 16 | 16), `cfloat` 4, `cdouble` 8 — each pinned against ldc2's `.alignof` in
     * target.test.ts. `Tint128`/`Tuns128` fall through to their size, 16, which is LLVM's `i128`
     * alignment on aarch64 and x86_64; they are not probeable in 1.43 (`cent`/`ucent` are obsolete). It is
     * NOT a general port of the C++; the substitution is filed as an `external implementation` record.
     *
     * Precondition: `type.isTypeBasic()` (both bodies assert it). Caller is `TypeBasic.alignsize()`.
     */
    alignsize(type: Type): number {
        assert(type.isTypeBasic() !== null); // dmd/target.d:639 — `assert(type.isTypeBasic());`
        switch (type.ty) {
            case TY.Tfloat80:
            case TY.Timaginary80:
            case TY.Tcomplex80:
                return this.realalignsize;
            case TY.Tcomplex32:
                if (this.os & OS.Posix)
                    return 4;
                break;
            case TY.Tint64:
            case TY.Tuns64:
            case TY.Tfloat64:
            case TY.Timaginary64:
            case TY.Tcomplex64:
                if (this.os & OS.Posix)
                    return this.isX86 ? 4 : 8;
                break;
            default:
                break;
        }
        // dmd/target.d:661 — `return cast(uint)type.size(Loc.initial);`. `size` returns a 64-bit
        // `uinteger_t` (bigint); `cast(uint)` masks to 32 bits in the bigint domain first (09 §2).
        return Number(maskUnsignedN(32, size(type, Loc.initial)));
    }

    /**
     * dmd/target.d:459 — `uint fieldalign(Type type);`, bodiless under IN_LLVM; the live
     * implementation is gen/target.cpp:288 `return DtoAlignment(type);`, i.e.
     * gen/llvmhelpers.cpp:142 `unsigned DtoAlignment(Type *type)`, ported here. It is pure frontend
     * logic (no data-layout query): an explicit non-`pack` alignment of the type wins; an opaque
     * struct aligns to 0; everything else aligns to `alignsize`.
     *
     * DIVERGES from the `!IN_LLVM` D body (target.d:671), which clamps anything but 16/32 to at most
     * 8. ldc2 probe: `struct A64 { align(64) int x; } struct W { char c; A64 a; }` gives
     * `W.a.offsetof == 64` (the D body would give 8); `align(2) struct P { int x; }` inside
     * `struct W2 { char c; P p; }` gives `W2.p.offsetof == 2`.
     */
    fieldalign(type: Type): number {
        // gen/llvmhelpers.cpp:143-145
        const alignment_ = alignment(type);
        if (!alignment_.isDefault() && !alignment_.isPack())
            return alignment_.get();

        // gen/llvmhelpers.cpp:147-149
        const ts = toBasetype(type).isTypeStruct();
        return ts !== null && ts.sym!.members === null ? 0 // opaque struct
                                                        : alignsize(type);
    }

    /**
     * dmd/target.d:461 — `Type va_listType(Loc loc, Scope* sc);`, bodiless under IN_LLVM; live at
     * gen/target.cpp:290:
     *   `if (!tvalist) tvalist = typeSemantic(gABI->vaListType(), loc, sc); return tvalist;`
     * `gABI->vaListType()` per triple:
     *   - aarch64 (gen/abi/aarch64.cpp:154): `hasAAPCS64VaList()` (:35, not Darwin and not MSVC) picks the
     *     identifier `__va_list` (druntime's `extern (C++, std) struct __va_list`); Darwin ("Apple diverges
     *     and uses a simple char* pointer") takes `TargetABI::vaListType()` = `pointerTo(Type::tchar)`
     *     (gen/abi/abi.cpp:253);
     *   - x86_64 (gen/abi/x86-64.cpp:373): a pointer to the identifier `__va_list_tag`.
     * An identifier resolves in `sc`, as DMD's does. ldc2 probe: `pragma(msg, va_list)` (core.stdc.stdarg)
     * prints `char*` | `__va_list` | `__va_list_tag*`.
     *
     * The result is cached for the process, like D's. Test harnesses that re-run `Type_init` must
     * also call `_resetVaListCache()` (01 §5.5 rule 3).
     */
    va_listType(loc: Loc, sc: Scope | null): Type {
        if (this.tvalist === null) {
            const triple = targetTriple();
            let t: Type;
            if (triple.arch === "x86_64")
                t = pointerTo(TypeIdentifier.create(Loc.initial, Identifier.idPool(ds("__va_list_tag"))));
            else if (!triple.isOSDarwin())
                t = TypeIdentifier.create(Loc.initial, Identifier.idPool(ds("__va_list")));
            else
                t = pointerTo(Type.tchar);
            this.tvalist = typeSemantic(t, loc, sc);
        }
        return this.tvalist;
    }

    /**
     * No D counterpart, never called by frontend code: the test harness and the djs driver between two
     * compiles (src/djs.ts `deinitializeFrontend`) forget the `va_listType` cache, so a later compile does
     * not receive a `char*` built over a STALE `Type.tchar` (01 §5.5 rule 3).
     */
    _resetVaListCache(): void {
        this.tvalist = null;
    }

    /**
     * dmd/target.d:738 — `extern (C++) int isVectorTypeSupported(int sz, Type type) @safe`.
     * Checks whether the target supports a vector type.
     * Params:
     *      sz   = vector type size in bytes
     *      type = vector element type
     * Returns:
     *      0   vector type is supported,
     *      1   vector type is not supported on the target at all
     *      2   vector element type is not supported
     *      3   vector size is not supported
     *
     * resolved: both `static if (!IN_LLVM)` blocks (target.d:741-745 `isXmmSupported`, :765-802 the
     * SSE/AVX size ladder) -> false: only the element-type switch is live, and `sz` is not read.
     * ldc2 probe: `__vector(int[3])` (12 bytes), `__vector(int[64])`, `__vector(void[16])`,
     * `__vector(ubyte[2])`, `__vector(double[1])` are accepted; `real`, `bool`, `char`, `wchar`,
     * `dchar` and `cfloat` elements are rejected with "vector type `__vector(...)` is not supported on
     * this platform".
     */
    isVectorTypeSupported(_sz: number, type: Type): number {
        // LDC_FIXME: Is it possible to query the LLVM target about supported vectors?
        switch (type.ty) {
            case TY.Tvoid:
            case TY.Tint8:
            case TY.Tuns8:
            case TY.Tint16:
            case TY.Tuns16:
            case TY.Tint32:
            case TY.Tuns32:
            case TY.Tfloat32:
            case TY.Tint64:
            case TY.Tuns64:
            case TY.Tfloat64:
                break;
            default:
                return 2; // wrong base type
        }
        return 0;
    }

    /**
     * dmd/target.d:816 — `extern (C++) bool isVectorOpSupported(Type type, EXP op, Type t2 = null)`.
     *
     * Whether the target supports `op` on the vector type `type`.
     *
     * Params:
     *   type = target type of operation
     *   op   = the unary or binary op being done on the `type`
     *   t2   = type of second operand if `op` is a binary operation
     * Returns:
     *   true if the operation is supported or `type` is not a vector
     *
     * `t2` is declared by D and never read by the body (target.d:816-1064) — the parameter is
     * carried so the ~16 call sites keep their D argument lists verbatim (01 §2.1). It is spelled
     * `_t2` because `noUnusedParameters` is on in tsconfig and D's own name would not compile.
     *
     * CONFIG RESOLUTION (07-compile-time.md, _config.md §1 row `IN_LLVM` = ON): dmd ships TWO
     * bodies for almost every arm — a `version (IN_LLVM)` one that asks only whether the vector's
     * ELEMENT TYPE admits the op, and a `!IN_LLVM` one that consults `cpu >= CPU.sse/sse2/…` and
     * the 16/32-byte size table. We are LDC, so the IN_LLVM arms are the live ones and the whole
     * x86 SSE/AVX ladder is dead code here (that is also why this port reads no `cpu` field).
     * LDC's own back end lowers any scalar-element vector of any width, so the answer is a pure
     * element-type question:
     *   - `isScalar(tvec)`   for +x, -x, +, -, *, /, %, and every comparison/equality;
     *   - `isIntegral(tvec)` for <<, >>, >>>, &, |, ^, ~ (and their assign forms);
     *   - `true`             for `is` / `!is` (D: `return IN_LLVM;`);
     *   - `false`            for `!x` and `^^` on any vector, on every target.
     *
     * VERIFIED against the oracle on THIS host (arm64-apple-darwin, ldc2-1.43.0, `-c -o-`): all of
     * `+ - * / % & | ^ ~ << >> >>>` and their assign forms compile on `__vector(int[4])`; `+ - * /
     * %` compile on `__vector(float[4])` and `__vector(double[2])`; `<` and `==` on vectors are
     * ACCEPTED (they yield a `__vector(uint[4])` mask — the only error is the later implicit
     * conversion to `bool`); `a is b` compiles; 32-byte vectors (`__vector(float[8])`,
     * `__vector(long[4])`) compile, which the `!IN_LLVM` 16/32 table would also allow but the x86
     * `cpu` ladder would reject without AVX. Rejected, each with the diagnostic this predicate's
     * `false` produces at the call site: `a & b` / `~a` on `__vector(float[4])` ("incompatible
     * types"/"incompatible type"), `a ^^ b` on any vector, `!a` ("does not have a boolean value" —
     * that one comes from `toBoolean` BEFORE this predicate, see expressionsem.d:10653).
     *
     * NOT a hot path: one switch, no allocation.
     */
    isVectorOpSupported(type: Type, op: EXP, _t2: Type | null = null): boolean {
        // resolved: `import dmd.hdrgen : EXPtoString;` (target.d:818) — a D function-local import
        // hoisted to a top-level value import (01 §4.4, "preferred/covered case"): hdrgen is not on
        // target.ts's load cycle. Emitted LAST in the import list per 01 §4.8.
        const tvec = type.isTypeVector();
        if (tvec === null)
            return true; // not a vector op

        // resolved: `const vecsize = cast(int)tvec.basetype.size();` and
        // `const elemty = cast(int)tvec.elementType().ty;` (target.d:823-824), plus the
        // `if (!IN_LLVM && vecsize != 16 && vecsize != 32) return false;` pre-check
        // (target.d:827-828) — DROPPED. `IN_LLVM` is ON, so the pre-check is const-false and every
        // remaining reader of `vecsize`/`elemty` sits in a dead `!IN_LLVM` arm. Neither initialiser
        // is unconditionally side-effect-free — `size()`'s `Tsarray` arm emits `static array %s size
        // overflowed` and bumps `global.errors` (typesem.d:2995-2999), and `elementType()` is two
        // asserts (mtype.d:1087/:1090) — but both effects are unreachable for any `TypeVector` this
        // port can build: TypeVector's own invariant makes `basetype` a small `Tsarray` of a basic
        // type. On that reachable set the drop removes no observable effect.

        switch (op) {
        case EXP.uadd:
            // Expression is a no-op, supported everywhere.
            return isScalar(tvec);

        case EXP.negate:
            // target.d:837-839 `version (IN_LLVM) { return tvec.isScalar(); }`.
            return isScalar(tvec);

        case EXP.identity:
        case EXP.notIdentity:
            // target.d:868 `return IN_LLVM;` — ON, so unconditionally supported.
            return IN_LLVM;

        case EXP.lessThan:
        case EXP.greaterThan:
        case EXP.lessOrEqual:
        case EXP.greaterOrEqual:
        case EXP.equal:
        case EXP.notEqual:
            // target.d:873-875 IN_LLVM arm. ldc2 probe: `a < b` / `a == b` on `__vector(float[4])`
            // type-check and yield `__vector(uint[4])`.
            return isScalar(tvec);

        case EXP.leftShift:
        case EXP.leftShiftAssign:
        case EXP.rightShift:
        case EXP.rightShiftAssign:
        case EXP.unsignedRightShift:
        case EXP.unsignedRightShiftAssign:
            // target.d:916 `return IN_LLVM && tvec.isIntegral();`.
            return IN_LLVM && isIntegral(tvec);

        case EXP.add:
        case EXP.addAssign:
        case EXP.min:
        case EXP.minAssign:
            // target.d:919-921 IN_LLVM arm.
            return isScalar(tvec);

        case EXP.mul:
        case EXP.mulAssign:
            // target.d:950-952 IN_LLVM arm. Unlike the x86 ladder (which needs SSE4.1 for `int[4]`
            // multiply) LDC accepts every scalar element — ldc2 probe: `__vector(byte[16]) a * b`.
            return isScalar(tvec);

        case EXP.div:
        case EXP.divAssign:
            // target.d:987-989 IN_LLVM arm. The x86 ladder has NO integer-divide entry at all; LDC
            // accepts it — ldc2 probe: `__vector(int[4]) a / b` compiles.
            return isScalar(tvec);

        case EXP.mod:
        case EXP.modAssign:
            // target.d:1012 `return IN_LLVM && tvec.isScalar();`.
            return IN_LLVM && isScalar(tvec);

        case EXP.and:
        case EXP.andAssign:
        case EXP.or:
        case EXP.orAssign:
        case EXP.xor:
        case EXP.xorAssign:
            // target.d:1015-1017 IN_LLVM arm.
            return isIntegral(tvec);

        case EXP.not:
            // target.d:1034 — `return false;` on EVERY target, IN_LLVM included.
            return false;

        case EXP.tilde:
            // target.d:1037-1039 IN_LLVM arm.
            return isIntegral(tvec);

        case EXP.pow:
        case EXP.powAssign:
            // target.d:1056 — `return false;` on every target.
            return false;

        default:
            // target.d:1061 — `assert(0, "unhandled op " ~ EXPtoString(cast(EXP)op));`.
            return assertUnreachable(`unhandled op ${dsToJs(EXPtoString(op))}`);
        }
        // target.d:1063 — `return false;`. Unreachable in D too (every arm returns and the default
        // halts); emitted because a D statement is never dropped for tsc's unreachable-code
        // suggestion (11 §2.5).
        return false;
    }

    /**
     * dmd/target.d:1071 — `extern (C++) LINK systemLinkage() @safe`. Default system linkage for the
     * target: the `LINK` to use for `extern(System)`. A live D body (outside both version arms).
     * ldc2 probe: `extern(System) void sysf();` has type `extern (C) void function()`.
     */
    systemLinkage(): LINK {
        return this.os === OS.Windows ? LINK.windows : LINK.c;
    }

    /**
     * dmd/target.d:1080 — `TypeTuple toArgTypes(Type t);`, bodiless under IN_LLVM; live at
     * gen/target.cpp:334. Describes how an argument type is passed to a function on target: a tuple
     * of types if passed in registers, an empty tuple if always on the stack, null if `void` or
     * unsupported.
     *
     * resolved: `arch == x86` (32-bit, gen/target.cpp:337) -> false on every supported triple, and the
     * trailing `return nullptr;` (:343) is unreachable: a supported triple is `x86_64` on Linux or `aarch64`.
     *
     * ldc2 probe (`static if (is(T A == __argTypes)) A.stringof`), darwin | x86_64-linux: `int` `(int)`,
     * `real` `(real)`, `void` `(void)` | `(byte)`, `int[0]` null, `struct{float x2}` `(float[2])` | `(double)`,
     * `struct{long x3}` `()`; the rest are pinned in argtypes_aarch64.test.ts and argtypes_sysv_x64.test.ts.
     */
    toArgTypes(t: Type): TypeTuple | null {
        if (targetTriple().arch === "x86_64")   // gen/target.cpp:339 (and `!triple.isOSWindows()`)
            return toArgTypes_sysv_x64(t);
        return toArgTypes_aarch64(t);           // gen/target.cpp:341-342
    }

    /**
     * dmd/target.d:1081 — `bool isReturnOnStack(TypeFunction tf, bool needsThis);`, bodiless under
     * IN_LLVM; live at gen/target.cpp:347 `return !tf->isRef() && gABI->returnInArg(tf, needsThis);`,
     * `gABI` being `AArch64TargetABI` (gen/abi/aarch64.cpp:64) or `X86_64TargetABI` (gen/abi/x86-64.cpp:203)
     * by the triple's arch (gen/abi/abi.cpp:274, :294). `needsThis` is unnamed in both and unread. Both
     * aggregate legs go through `getArgTypes` (below), so for a sized struct they read `sd.argTypes` as
     * dsymbolsem.d:10290 left it.
     *
     * ldc2 probe (`__traits(isReturnOnStack, f)`): `int` false, `real` false, `ref int` false,
     * `struct{int}` false, `struct{long[5]}` true, `int[5]` true, `float[4]` false, a struct with a postblit
     * true; darwin and aarch64-linux | x86_64-linux: `int[0]` true | false, `struct{}` false | true,
     * `struct{double x4}` false | true, `struct{real x2}` false | true.
     */
    isReturnOnStack(tf: TypeFunction, _needsThis: boolean): boolean {
        if (tf.isRef)
            return false;
        if (targetTriple().arch === "x86_64") {
            // gen/abi/x86-64.cpp:203-212
            const rt = toBasetype(tf.next!);

            // x87 creal is returned on the x87 stack
            if (returnsComplexReal(tf))
                return false;

            return passInMemory(rt);
        }
        // gen/abi/aarch64.cpp:65-73
        const rt = toBasetype(tf.next!);
        if (rt.ty === TY.Tstruct || rt.ty === TY.Tsarray) {
            const argTypes = getArgTypes(rt);
            return argTypes === null // FIXME: get rid of sret workaround for 0-sized return
                                     //        values (static arrays with 0 elements)
                || argTypes.arguments!.length === 0;
        }

        return false;
    }

    /**
     * dmd/target.d:1082 — `bool preferPassByRef(Type t);`, bodiless under IN_LLVM; live at
     * gen/target.cpp:350 `return gABI->preferPassByRef(t);`. Decides whether an `in` parameter of POD type
     * `t` is passed by reference (`-preview=in`):
     *   - aarch64 (gen/abi/aarch64.cpp:78): if the POD cannot be passed in registers, i.e., if
     *     IndirectByvalRewrite would be applied;
     *   - x86_64 (gen/abi/x86-64.cpp:215): if the LLVM ByVal attribute would be applied, *and* the size is > 16.
     *
     * ldc2 probe (`-preview=in`, `void f(in T x) { pragma(msg, __traits(isRef, x)); }`):
     * `struct{long x2}` false, `struct{long x3}` true, `int[5]` true, `struct{}` false, `int[0]` false,
     * `long` false; darwin and aarch64-linux | x86_64-linux: `struct{double x4}` false | true,
     * `struct{real x2}` false | true.
     */
    preferPassByRef(t: Type): boolean {
        if (targetTriple().arch === "x86_64")
            return size(t) > 16n && passInMemory(toBasetype(t));   // gen/abi/x86-64.cpp:215-217

        t = toBasetype(t);

        if (!(t.ty === TY.Tstruct || t.ty === TY.Tsarray))
            return false;

        const argTypes = getArgTypes(t);
        return argTypes !== null // not 0-sized
            && argTypes.arguments!.length === 0; // cannot be passed in registers
    }

    /**
     * dmd/target.d:1083 — `Expression getTargetInfo(const(char)* name, Loc loc);`, bodiless under
     * IN_LLVM; live at gen/target.cpp:352. Returns the Expression for the requested
     * `__traits(getTargetInfo, name)` key, or null for an unknown key (the caller then reports
     * "`getTargetInfo` key ... not supported by this implementation").
     *
     * Triple queries read the `Triple` model; driver OPTIONS outside the shim's table are resolved to their
     * defaults (the same contract as `global.params`):
     * `opts::floatABI` Default -> Hard for aarch64 and x86_64 (driver/targetmachine.cpp:584-587),
     * `opts::fCFProtection` -> None = 0, `opts::dcomputeTargets` -> empty, `opts::dcomputeFilePrefix`
     * -> "kernels" (driver/cl_options.cpp:776-778). The dcompute keys are compiled in because this
     * LDC build supports an AArch64/NVPTX/SPIRV dcompute target (gen/target.cpp:405).
     *
     * ldc2 probe: objectFormat `macho` | `elf` | `elf`, floatAbi `hard`, cppRuntimeLibrary ``, cppStd `201103`
     * (int), CET `0` (int), dcomputeTargets `AliasSeq!()`, dcomputeFilePrefix `kernels`.
     */
    getTargetInfo(name_: DString, loc: Loc): Expression | null {
        const name = cstr(name_); // gen/target.cpp:353 — `const llvm::StringRef name(name_);`

        // gen/target.cpp:356-358 — `createStringExp` lambda. dependency signature (11 §1): the C++
        // calls `StringExp::create(loc, value)` (dmd/expression.d:964, body
        // `return new StringExp(loc, s.toDString());`), whose port `StringExp.createFromCStr` is an
        // escalation stub; the closest expressible form is that body's constructor call.
        const createStringExp = (value: DString | null): Expression | null => {
            return value !== null ? new StringExp(loc, Array.from(value)) : null;
        };

        if (dsEquals(name, ds("objectFormat"))) {
            // gen/target.cpp:361-370. resolved: no supported triple is COFF or Wasm.
            const triple = targetTriple();
            let objectFormat: DString | null = null;
            if (triple.isOSBinFormatMachO()) {
                objectFormat = ds("macho");
            } else if (triple.isOSBinFormatELF()) {
                objectFormat = ds("elf");
            }
            return createStringExp(objectFormat);
        }

        if (dsEquals(name, ds("floatAbi"))) {
            // gen/target.cpp:375-382 — resolved: `opts::floatABI == FloatABI::Hard` -> "hard".
            const floatAbi: DString | null = ds("hard");
            return createStringExp(floatAbi);
        }

        if (dsEquals(name, ds("cppRuntimeLibrary"))) {
            // gen/target.cpp:387-391 — resolved: `triple.isWindowsMSVCEnvironment()` -> false.
            const cppRuntimeLibrary: DString | null = ds("");
            return createStringExp(cppRuntimeLibrary);
        }

        if (dsEquals(name, ds("cppStd"))) {
            // gen/target.cpp:396-397 — note `Loc()`, not `loc`.
            return IntegerExp.create(Loc.initial, BigInt(global.params.cplusplus), Type.tint32);
        }

        if (dsEquals(name, ds("CET"))) {
            // gen/target.cpp:401-402 — resolved: `opts::fCFProtection.getValue()` -> CFProtectionType::None (0).
            const cet = 0n;
            return IntegerExp.create(loc, cet, Type.tint32);
        }

        // gen/target.cpp:405 — resolved: `#if LDC_LLVM_SUPPORTED_TARGET_SPIRV || ..._NVPTX` -> ON.
        if (dsEquals(name, ds("dcomputeTargets"))) {
            const exps: Expressions = new DArray<Expression | null>();
            // gen/target.cpp:408 — `for (auto &targ : opts::dcomputeTargets) {` (pushes one StringExp each).
            // resolved: the option list is empty (no command line), so the loop body never runs.
            return TupleExp.create(loc, exps);
        }

        if (dsEquals(name, ds("dcomputeFilePrefix"))) {
            // gen/target.cpp:415-416 — resolved: `opts::dcomputeFilePrefix` -> its default "kernels".
            return createStringExp(ds("kernels"));
        }

        return null;
    }

    /**
     * dmd/target.d:1084 — under `version(IN_LLVM)` (ON, _config.md §1) this is a BODILESS
     * `extern (C++)` declaration; the D body at target.d:1446 sits in the `!IN_LLVM` arm and is
     * resolved away (07 §1). The live implementation is LDC's C++ at gen/target.cpp:423:
     * `return isWindowsMSVCEnvironment() || tf->linkage != LINK::cpp;` — callEE destroys args for
     * extern(D) and MSVC++, callER for non-MSVC extern(C++). No supported triple is MSVC, so the
     * disjunct is const-false, leaving the linkage test. Complete operation, not a narrowing.
     */
    isCalleeDestroyingArgs(tf: TypeFunction): boolean {
        return tf.linkage !== LINK.cpp;
    }

    /**
     * dmd/target.d:1085 — `bool libraryObjectMonitors(FuncDeclaration fd, Statement fbody) { return true; }`.
     * Under IN_LLVM this declaration HAS a body: the object monitors of a `synchronized` function are
     * always implemented in the D runtime library (rt/monitor_.d). Parameters unread.
     */
    libraryObjectMonitors(_fd: FuncDeclaration, _fbody: Statement): boolean {
        return true;
    }

    /**
     * dmd/target.d:1086 — `bool supportsLinkerDirective() const;`, bodiless under IN_LLVM; live at
     * gen/target.cpp:429:
     *   `return triple->isWindowsMSVCEnvironment() || triple->isOSBinFormatMachO();`
     * resolved: MSVC false. True on the host (Mach-O), false on a Linux triple (ELF); the `!IN_LLVM` D body
     * (`os == Windows`, target.d:1486) would say false everywhere. It gates `pragma(linkerDirective)` on a
     * declaration (pragmasem.d:99).
     */
    supportsLinkerDirective(): boolean {
        return targetTriple().isOSBinFormatMachO();
    }

    // dropped: target.d:1088-1529 `else // !IN_LLVM` — DMD's own bodies of `toArgTypes`,
    // `isReturnOnStack`, `preferPassByRef`, `TargetInfoKeys`, `getTargetInfo`, `isCalleeDestroyingArgs`,
    // `libraryObjectMonitors`, `supportsLinkerDirective`, `isXmmSupported`, `isPOSIX`, `stackAlign`
    // (07 §1; the live counterparts are the LDC members above).
}

// dmd/target.d:1540 — `enum Runtime : ubyte` nested in `TargetC` (class-qualified export name).
// Its only field, `TargetC.runtime`, is `!IN_LLVM` (target.d:1570), so nothing reads it under LDC.
export enum TargetCRuntime {
    Unspecified,
    Bionic,
    Glibc,
    Microsoft,
    Musl,
    Newlib,
    UClibc,
    WASI,
}

// dmd/target.d:1552 — `enum BitFieldStyle : ubyte` nested in `TargetC` (class-qualified export name).
export enum TargetCBitFieldStyle {
    Unspecified,
    MS,                   /// Microsoft 32 and 64 bit C compilers
                          /// https://docs.microsoft.com/en-us/cpp/c-language/c-bit-fields?view=msvc-160
                          /// https://docs.microsoft.com/en-us/cpp/cpp/cpp-bit-fields?view=msvc-160
    Gcc_Clang,            /// gcc and clang
}

/***********************************************************
 * dmd/target.d:1536 — `struct TargetC`. Functions and variables specific to interfacing with
 * extern(C) ABI. Under IN_LLVM the fields are filled by `Target::_init` (gen/target.cpp:166-175),
 * i.e. by the `Target` constructor above; the D defaults are kept here as the `.init` values.
 */
export class TargetC {
    crtDestructorsSupported = true; /// Not all platforms support crt_destructor
    boolsize = 0;           /// size of a C `_Bool` type
    shortsize = 0;          /// size of a C `short` or `unsigned short` type
    intsize = 0;            /// size of a C `int` or `unsigned int` type
    longsize = 0;           /// size of a C `long` or `unsigned long` type
    long_longsize = 0;      /// size of a C `long long` or `unsigned long long` type
    long_doublesize = 0;    /// size of a C `long double`
    wchar_tsize = 0;        /// size of a C `wchar_t` type
    // dropped: `Runtime runtime;` (target.d:1570) — inside `version (IN_LLVM) {} else`.
    bitFieldStyle: TargetCBitFieldStyle = TargetCBitFieldStyle.Unspecified; /// different C compilers do it differently

    // dropped: `extern (D) void initialize(ref const Param params, ref const Target target)`
    // (target.d:1575) — `version (IN_LLVM) { /* initialized in Target::_init() */ } else`.

    /**
     * dmd/target.d:1637 — `extern (C++) bool contributesToAggregateAlignment(BitFieldDeclaration bfd);`,
     * bodiless under IN_LLVM; live at gen/target.cpp:434. Indicates whether the specified bitfield
     * contributes to the alignment of the containing aggregate: anonymous (incl. 0-length) bitfields
     * are NOT ignored by most ARM ABIs, but Apple diverges.
     *
     * resolved: the `arm`/`armeb`/`thumb` arm (gen/target.cpp:444-447) is no supported triple's. On `aarch64`
     * (:449-452) only Darwin ignores an anonymous bit-field; `x86_64` takes the default arm (:454-455). ldc2
     * probe: `struct { char a; int : 0; char c; }` has size 5 and align 1 | 8 and 4 | 5 and 1.
     */
    contributesToAggregateAlignment(bfd: BitFieldDeclaration): boolean {
        if (this.bitFieldStyle === TargetCBitFieldStyle.MS)
            return true;

        if (this.bitFieldStyle === TargetCBitFieldStyle.Gcc_Clang) {
            // special case for most ARM ABIs:
            // anonymous (incl. 0-length) bit-fields are NOT ignored
            // (see e.g. https://github.com/ARM-software/abi-aa/blob/main/aapcs64/aapcs64.rst#1018bit-fields)
            const triple = targetTriple();
            if (triple.arch === "aarch64") {
                // Apple diverges
                return !triple.isOSDarwin() || !bfd.isAnonymous();
            }
            return !bfd.isAnonymous();
        }

        // gen/target.cpp:459 — `llvm_unreachable("Unsupported bit-field style");`
        return assertUnreachable("Unsupported bit-field style");
    }
}

// dmd/target.d:1672 — `enum Runtime : ubyte` nested in `TargetCPP` (class-qualified export name).
// Its only field, `TargetCPP.runtime`, is `!IN_LLVM` (target.d:1687), so nothing reads it under LDC.
export enum TargetCPPRuntime {
    Unspecified,
    LLVM,
    GNU,
    Microsoft,
    Sun,
}

/***********************************************************
 * dmd/target.d:1665 — `struct TargetCPP`. Functions and variables specific to interface with
 * extern(C++) ABI. Under IN_LLVM the fields are filled by `Target::_init` (gen/target.cpp:177-181),
 * i.e. by the `Target` constructor above.
 */
export class TargetCPP {
    /// set if overloaded functions are grouped and in reverse order (such as in dmc and cl)
    reverseOverloads = false;
    exceptions = false;          /// set if catching C++ exceptions is supported
    twoDtorInVtable = false;     /// target C++ ABI puts deleting and non-deleting destructor into vtable
    splitVBasetable = false;     /// set if C++ ABI uses separate tables for virtual functions and virtual bases
    wrapDtorInExternD = false;   /// set if C++ dtors require a D wrapper to be callable from runtime
    // dropped: `Runtime runtime;` (target.d:1687) — inside `version (IN_LLVM) {} else`.

    // dropped: `extern (D) void initialize(ref const Param params, ref const Target target)`
    // (target.d:1691) — `version (IN_LLVM) { /* initialized in Target::_init() */ } else`.

    /**
     * dmd/target.d:1727 — `extern (C++) const(char)* toMangle(Dsymbol s)`. Mangle the given symbol
     * for C++ ABI. resolved: the IN_LLVM arm's `if (isTargetWindowsMSVC())` (target.d:1734) -> false,
     * so the live statement is `return toCppMangleItanium(s);`; the `!IN_LLVM` arm is dead. The callee is
     * dmd/mangle/cpp.d:78 — `const(char)* toCppMangleItanium(Dsymbol s)` (mangle/cpp.ts).
     */
    toMangle(s: Dsymbol): DString {
        return toCppMangleItanium(s);
    }

    /**
     * dmd/target.d:1757 — `extern (C++) const(char)* typeInfoMangle(ClassDeclaration cd)`. Get RTTI
     * mangling of the given class declaration for C++ ABI. resolved: `if (isTargetWindowsMSVC())`
     * (target.d:1764) -> false, so the live statement is `return cppTypeInfoMangleItanium(cd);`. The callee is
     * dmd/mangle/cpp.d:90 — `const(char)* cppTypeInfoMangleItanium(Dsymbol s)` (mangle/cpp.ts).
     */
    typeInfoMangle(cd: ClassDeclaration): DString {
        return cppTypeInfoMangleItanium(cd);
    }

    /**
     * dmd/target.d:1789 — `extern (C++) const(char)* thunkMangle(FuncDeclaration fd, int offset)`. Get
     * mangle name of a this-adjusting thunk to the given function declaration for C++ ABI: the string
     * mangling of the C++ thunk, or null if unhandled. Always null. Parameters unread.
     */
    thunkMangle(_fd: FuncDeclaration, _offset: number): DString | null {
        return null;
    }

    /**
     * dmd/target.d:1804 — `extern (C++) const(char)* typeMangle(Type t);`, bodiless under IN_LLVM; live
     * at gen/target.cpp:304. Vendor-specific type mangling for C++ ABI: a string if the type is mangled
     * specially on target, null if unhandled.
     *
     * resolved: the Android/x86_64 (`g`) and ppc64 (`u9__ieee128` / `g`) arms are dead for every
     * supported triple (none is Android or ppc64), leaving `"e"` for `real` (Itanium `long double`). ldc2
     * probe: `extern(C++) void cf2(real x);` mangles as `_Z3cf2e` on all three triples.
     */
    typeMangle(t: Type): DString | null {
        if (t.ty === TY.Tfloat80) {
            return ds("e");
        }

        return null;
    }

    /**
     * dmd/target.d:1822 — `extern (C++) Type parameterType(Type t)`. The type that will really be used
     * for passing the given argument to an `extern(C++)` function, or `null` if unhandled. Always null.
     */
    parameterType(_t: Type): Type | null {
        return null;
    }

    /**
     * dmd/target.d:1835 — `extern (C++) bool fundamentalType(const Type t, ref bool isFundamental)`.
     * Whether the type is a vendor-specific fundamental type: true if `isFundamental` was set. Never
     * sets it. `ref bool` is a one-slot box (03 §3.2).
     */
    fundamentalType(_t: Type, _isFundamental: { value: boolean }): boolean {
        return false;
    }

    /**
     * dmd/target.d:1848 — `extern (C++) uint derivedClassOffset(ClassDeclaration baseClass)`. The
     * starting offset position for fields of an `extern(C++)` class derived from `baseClass`.
     *
     * resolved: `if (isTargetWindowsMSVC())` (target.d:1852, "MSVC adds padding between base and
     * derived fields if required") -> false. ldc2 probe: `extern(C++) class B { int x; char c; void v()
     * {} }` has instance size 13, and `D : B`'s first field `d` sits at offset 13 (no padding).
     */
    derivedClassOffset(baseClass: ClassDeclaration): number {
        return baseClass.structsize;
    }
}

/***********************************************************
 * dmd/target.d:1863 — `struct TargetObjC`. Functions and variables specific to interface with
 * extern(Objective-C) ABI. `supported` is filled by `Target::_init` (gen/target.cpp:183).
 */
export class TargetObjC {
    supported = false;     /// set if compiler can interface with Objective-C

    // dropped: `extern (D) void initialize(ref const Param params, ref const Target target)`
    // (target.d:1868) — `version (IN_LLVM) { /* initialized in Target::_init() */ } else`.
}

/**
 * gen/abi/abi.cpp:78 — `TypeTuple *TargetABI::getArgTypes(Type *t)`, the LDC glue both
 * `AArch64TargetABI::returnInArg` and `::preferPassByRef` (gen/abi/aarch64.cpp:67, :84) reach through.
 * A `static` `TargetABI` member (gen/abi/abi.h:223), so it ports as a module-private function.
 *
 * Tries to reuse the cached argTypes of a StructDeclaration: for a struct whose size is final
 * (`sizeok == done`) it returns `sd.argTypes` as dsymbolsem.d:10290 stored it (null included);
 * otherwise it asks `target.toArgTypes(t)`.
 */
function getArgTypes(t: Type): TypeTuple | null {
    // try to reuse cached argTypes of StructDeclarations
    const ts = toBasetype(t).isTypeStruct();
    if (ts !== null) {
        const sd = ts.sym!;
        if (sd.sizeok === Sizeok.done)
            return sd.argTypes;
    }

    return target.toArgTypes(t);
}

/**
 * gen/abi/x86-64.cpp:177 — `static bool X86_64TargetABI::passInMemory(Type* t)`: the type has argTypes and they
 * are empty (it cannot be passed in registers). A zero-sized type (null argTypes) is not passed in memory.
 */
function passInMemory(t: Type): boolean {
    const argTypes = getArgTypes(t);
    return argTypes !== null && argTypes.arguments!.length === 0;
}

/**
 * gen/abi/x86-64.cpp:183 — `static bool X86_64TargetABI::returnsComplexReal(TypeFunction* tf)`: helper treating
 * the magic `__c_complex_real` enum as creal.
 */
function returnsComplexReal(tf: TypeFunction): boolean {
    const rt = tf.next!;
    const te = rt.isTypeEnum();
    if (te !== null) {
        if (te.sym!.ident === Id.__c_complex_real)
            return true;
    }
    return toBasetype(rt).ty === TY.Tcomplex80;
}

// dmd/target.d:1876 — `extern (C++) __gshared Target target;`. One process-wide singleton the whole
// frontend dots into (e.g. `target.fieldalign(t)`). (01 §5 — module state as a module-level const.)
// Its construction runs `Target::_init` for the host triple (see `Target.constructor`).
export const target = new Target();
// 01 §4.4 registration: hand the singleton to declaration.ts's `dmd.target` slot (declaration.d:34).
registerTarget(target);
