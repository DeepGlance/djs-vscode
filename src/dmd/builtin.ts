// Ported from dmd/builtin.d (module dmd.builtin) — "Implement CTFE for intrinsic (builtin) functions."
// Currently includes functions from `std.math`, `core.math` and `core.bitop`.
//
// FULL-FILE TRANSLATION (P5.0 wave 13). Every top-level D declaration of builtin.d is present here, in SOURCE
// ORDER: the public `isBuiltin` (:35) and `eval_builtin` (:48); then, under D's `private:` (:73),
// `determine_builtin` (:87), `eval_unimp` (:229), `eval_ctfeWrite` (:234), the one-argument float evaluators
// `eval_sin` .. `eval_trunc` (:249-:361, with `eval_ldexp` :284), `eval_copysign` (:363), `eval_pow` (:372),
// `eval_fmin` (:381), `eval_fmax` (:390), `eval_fma` (:399), `eval_isnan` (:410), `eval_isinfinity` (:417),
// `eval_isfinite` (:424), `eval_bsf` (:432), `eval_bsr` (:442), `eval_bswap` (:452), `eval_popcnt` (:464),
// `eval_yl2x` (:472), `eval_yl2xp1` (:485), `eval_toPrecFloat` (:498), `eval_toPrecDouble` (:505),
// `eval_toPrecReal` (:512), `eval_gcc` (:519), `eval_llvm` (:524); then the `version (IN_LLVM)` block (:529-:872,
// ON per _config.md §1): `getTypeOfOverloadedIntrinsic` (:533), `getBitsizeOfType` (:556), the 26 `eval_llvm*`
// evaluators (:577-:870) and the two symbol aliases `eval_llvmlrint` (:717) / `eval_llvmlround` (:726).
// builtin.d has no `unittest` blocks and declares no visitor class (the visitor-word class census over the D module
// is 0). The D-private functions stay unexported: the co-located test reaches every one of them through the two
// public entry points.
//
// THE LOOKUP KEY. The table is NOT keyed by mangled name: `determine_builtin` matches the callee's module
// (`core.math`, `core.bitop`, `core.builtins`, `std.math`, `std.math.<package>`) and then its identifier against
// `Id.*`. `mangleExact` is read at exactly one point, to tell the three `toPrec!T` instances apart (:220).
//
// COMPILE-TIME RESOLUTION (07). `version (IN_LLVM) enum IN_LLVM = true;` (:50) resolves to `true`. The
// `foreach (e; __traits(allMembers, BUILTIN))` + `static if` + `mixin` switch bodies (:60-:68) are UNROLLED, one arm
// per `BUILTIN` member in declaration order (07 §4.2). The `version (IN_LLVM)` arm of the yl2x/yl2xp1 test (:175)
// is the live one; its `else` (:186-:187) is resolved away.
//
// THE LDC_intrinsic LEG (builtin.d:93-127; 07's llvmInternal ruling, reopened). A function declared
// `pragma(LDC_intrinsic, "llvm.<name>.…")` carries `llvmInternal == LLVMintrinsic` and its intrinsic name in
// `mangleOverride` (gen/dpragma.ts, DtoCheckPragma); `determine_builtin` maps `<name>` onto the `llvm_*` members
// before the module/identifier lookup. A TEMPLATE intrinsic (the form LDC's druntime uses:
// `ldc.intrinsics.llvm_sqrt(T)` behind `core.math.sqrt`) gets its `mangleOverride` only from
// `DtoSetFuncDeclIntrinsicName` (gen/llvmhelpers.cpp:1296) at instantiation, walled at templatesem.ts; until that
// lands only the non-template form reaches `eval_llvm*`.
//
// `static import core.bitop;` (:29) is druntime, not the frontend (01 Rule 3.5): its four functions are replaced by
// the file-local `core_bitop` object below, a runtime-library replacement (08 §0), not a D declaration of this
// module. The C stdio `fprintf(stderr, …)` of `eval_ctfeWrite` is the raw-stderr FFI of 10 §4.4.
//
// NUMERICS (09). `real_t` is `number` (09 §6). The integer carrier `dinteger_t`/`uinteger_t` is a bigint that
// `IntegerExp` normalizes per type, so a signed operand may arrive sign-extended as a NEGATIVE bigint; D reads the
// same bits as a `ulong`. Every local D declares `dinteger_t`/`uinteger_t` and then shifts, counts or byte-swaps is
// therefore read through `toUint64` (the constfold.ts convention).

import { assert, assertUnreachable, SwitchError } from "../assert.js";
import { ds, dsEmpty, dsEquals, dsToJs } from "../dstring.js";
import { maskSignedN, maskUnsignedN, toUint64 } from "../numeric.js";

import { Expression, IntegerExp, RealExp, CTFEExp } from "./expression.js";
import type { Expressions } from "./arraytypes.js";
import { BUILTIN } from "./func.js";
import type { FuncDeclaration } from "./func.js";
import type { Loc } from "./location.js";
import { Type } from "./mtype.js";
import { TY, Tint16, Tuns16, Tint32, Tuns32, Tint64, Tuns64, Tint128, Tuns128, Tfunction } from "./astenums.js";
import type { dinteger_t, uinteger_t } from "./globals.js";
import { error } from "./errors.js";
import { toInteger, toReal, toStringExp } from "./expressionsem.js";
import { isFloating, toBasetype } from "./typesem.js";
import { mangleExact } from "./mangle/index.js";
import { CTFloat, type real_t } from "./root/ctfloat.js";
import { dmdformat } from "./root/dmdformat.js";
import { EXP } from "./tokens.js";
import { Id } from "./id.js";
import { resolveSlice } from "./ctfeexpr.js";
import { isType } from "./dtemplate.js";
// dmd/builtin.d:96 (`import gen.dpragma : LDCPragma;`, function-local, hoisted per 01 §4). LAST (01 §4.8): dpragma.js
// imports expressionsem.js; this module reads only the enum, inside a function body.
import { LDCPragma } from "../gen/dpragma.js";

/**
 * `static import core.bitop;` (builtin.d:29) — the four druntime functions this module calls, over the 64-bit
 * unsigned carrier. D resolves each call to the `ulong` overload (the argument is a `dinteger_t`), except `bswap`,
 * which D calls on both widths: `bswapUint` / `bswapUlong` carry the parameter type as a suffix (04 §1 Form B).
 *
 * `bsf(0)` / `bsr(0)` are undefined in druntime (`llvm_cttz(v, true)` / `63 - llvm_ctlz(v, true)`, core/bitop.d:104
 * and :170). builtin.d emits its "is undefined" error and still builds the result, and that value is what the
 * compiled ldc2 binary computes: 64 and 127 (ldc2 1.43.0, `enum x = bsf(0UL); pragma(msg, x);` prints the error and
 * then `64`; `bsr(0UL)` prints `127` — arm64 lowers `63 - ctlz` of a zero-poison ctlz to `ctlz ^ 63`, and
 * `clz(0)` is 64). Those two values are reproduced here.
 */
const core_bitop = {
    /// core/bitop.d:97 — `int bsf(ulong v)`: index of the lowest set bit.
    bsf(v: bigint): number {
        if (v === 0n)
            return 64; // undefined in druntime; the ldc2 1.43.0 host value (see above)
        let n = 0;
        while ((v & 1n) === 0n) {
            v >>= 1n;
            n++;
        }
        return n;
    },

    /// core/bitop.d:163 — `int bsr(ulong v)`: index of the highest set bit.
    bsr(v: bigint): number {
        if (v === 0n)
            return 127; // undefined in druntime; the ldc2 1.43.0 host value (see above)
        return v.toString(2).length - 1;
    },

    /// core/bitop.d:686 — `alias bswap = llvm_bswap!uint;` (LDC's `uint bswap(uint v)`): the four bytes reversed.
    bswapUint(v: bigint): bigint {
        let r = 0n;
        for (let i = 0; i < 4; i++) {
            r = (r << 8n) | (v & 0xFFn);
            v >>= 8n;
        }
        return r;
    },

    /// core/bitop.d:706 — `alias bswap = llvm_bswap!ulong;` (LDC's `ulong bswap(ulong v)`): the eight bytes reversed.
    bswapUlong(v: bigint): bigint {
        let r = 0n;
        for (let i = 0; i < 8; i++) {
            r = (r << 8n) | (v & 0xFFn);
            v >>= 8n;
        }
        return r;
    },

    /// core/bitop.d:872 — `int popcnt(ulong x)`: the number of set bits.
    popcnt(x: bigint): number {
        let cnt = 0;
        while (x !== 0n) {
            if ((x & 1n) !== 0n)
                cnt++;
            x >>= 1n;
        }
        return cnt;
    },
};

/**********************************
 * dmd/builtin.d:35 — `public extern (C++) BUILTIN isBuiltin(FuncDeclaration fd)`.
 *
 * Determine if function is a builtin one that we can evaluate at compile time.
 *
 * Returns `fd.builtin`, computing it on first call: the field starts at `BUILTIN.unknown` and is overwritten once
 * with `determine_builtin`'s answer, so later calls are a field read. `BUILTIN.unimp` means "not a builtin".
 * Cost: the first call reaches `fd.toAliasFunc()`, `fd.getModule()` and a chain of identifier compares; a
 * `toPrec!T` callee also runs `mangleExact` (mangle/index.ts).
 */
export function isBuiltin(fd: FuncDeclaration): BUILTIN {
    if (fd.builtin === BUILTIN.unknown) {
        fd.builtin = determine_builtin(fd);
    }
    return fd.builtin;
}

/**************************************
 * dmd/builtin.d:48 — `public extern (C++) Expression eval_builtin(Loc loc, FuncDeclaration fd`,
 * `Expressions* arguments)`.
 *
 * Evaluate builtin function.
 * Return result; NULL if cannot evaluate it.
 *
 * Preconditions: `fd.builtin` was set by `isBuiltin` (an `unknown` value asserts), and `arguments_` holds the
 * already-interpreted argument values; it is read only when `fd.builtin` is not `unimp`. The evaluators assert
 * the literal kind of each argument they read (`EXP.float64` / `EXP.int64`), so the caller hands them constants.
 * Postconditions: a fresh `RealExp`/`IntegerExp` for the math and bit builtins, `CTFEExp.voidexp` for
 * `__ctfeWrite`; null for `unimp`. `bsf(0)`, `bsr(0)` and the unsupported-width intrinsics report an error at
 * `loc` and still return a value.
 */
export function eval_builtin(loc: Loc, fd: FuncDeclaration, arguments_: Expressions | null): Expression | null {
    // resolved: `version (IN_LLVM) enum IN_LLVM = true; else enum IN_LLVM = false;` (builtin.d:50) -> true (LDC)

    if (fd.builtin === BUILTIN.unimp)
        return null;

    // resolved: `foreach (e; __traits(allMembers, BUILTIN))` (builtin.d:60) unrolled, one arm per member in
    // declaration order; `e == "unknown"` -> `assert(false)`; IN_LLVM && `e` starts with "llvm_" ->
    // `eval_llvm<e[5..$]>`; every other member (the bare `llvm` too: its name is not longer than 5) -> `eval_<e>`.
    // `(*arguments)[]` is the slice of the dereferenced array. The switch reads `builtin` through an alias of the
    // OBJECT (02 §11.4): the `unimp` test above narrowed `fd.builtin`, and D keeps the (dead) `unimp` arm below.
    const fdSwitch: FuncDeclaration = fd;
    switch (fdSwitch.builtin) {
        case BUILTIN.unknown: assertUnreachable();
        case BUILTIN.unimp: return eval_unimp(loc, fd, arguments_!.opSlice());
        case BUILTIN.gcc: return eval_gcc(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm: return eval_llvm(loc, fd, arguments_!.opSlice());
        case BUILTIN.sin: return eval_sin(loc, fd, arguments_!.opSlice());
        case BUILTIN.cos: return eval_cos(loc, fd, arguments_!.opSlice());
        case BUILTIN.tan: return eval_tan(loc, fd, arguments_!.opSlice());
        case BUILTIN.sqrt: return eval_sqrt(loc, fd, arguments_!.opSlice());
        case BUILTIN.fabs: return eval_fabs(loc, fd, arguments_!.opSlice());
        case BUILTIN.ldexp: return eval_ldexp(loc, fd, arguments_!.opSlice());
        case BUILTIN.log: return eval_log(loc, fd, arguments_!.opSlice());
        case BUILTIN.log2: return eval_log2(loc, fd, arguments_!.opSlice());
        case BUILTIN.log10: return eval_log10(loc, fd, arguments_!.opSlice());
        case BUILTIN.exp: return eval_exp(loc, fd, arguments_!.opSlice());
        case BUILTIN.expm1: return eval_expm1(loc, fd, arguments_!.opSlice());
        case BUILTIN.exp2: return eval_exp2(loc, fd, arguments_!.opSlice());
        case BUILTIN.round: return eval_round(loc, fd, arguments_!.opSlice());
        case BUILTIN.floor: return eval_floor(loc, fd, arguments_!.opSlice());
        case BUILTIN.ceil: return eval_ceil(loc, fd, arguments_!.opSlice());
        case BUILTIN.trunc: return eval_trunc(loc, fd, arguments_!.opSlice());
        case BUILTIN.copysign: return eval_copysign(loc, fd, arguments_!.opSlice());
        case BUILTIN.pow: return eval_pow(loc, fd, arguments_!.opSlice());
        case BUILTIN.fmin: return eval_fmin(loc, fd, arguments_!.opSlice());
        case BUILTIN.fmax: return eval_fmax(loc, fd, arguments_!.opSlice());
        case BUILTIN.fma: return eval_fma(loc, fd, arguments_!.opSlice());
        case BUILTIN.isnan: return eval_isnan(loc, fd, arguments_!.opSlice());
        case BUILTIN.isinfinity: return eval_isinfinity(loc, fd, arguments_!.opSlice());
        case BUILTIN.isfinite: return eval_isfinite(loc, fd, arguments_!.opSlice());
        case BUILTIN.bsf: return eval_bsf(loc, fd, arguments_!.opSlice());
        case BUILTIN.bsr: return eval_bsr(loc, fd, arguments_!.opSlice());
        case BUILTIN.bswap: return eval_bswap(loc, fd, arguments_!.opSlice());
        case BUILTIN.popcnt: return eval_popcnt(loc, fd, arguments_!.opSlice());
        case BUILTIN.yl2x: return eval_yl2x(loc, fd, arguments_!.opSlice());
        case BUILTIN.yl2xp1: return eval_yl2xp1(loc, fd, arguments_!.opSlice());
        case BUILTIN.toPrecFloat: return eval_toPrecFloat(loc, fd, arguments_!.opSlice());
        case BUILTIN.toPrecDouble: return eval_toPrecDouble(loc, fd, arguments_!.opSlice());
        case BUILTIN.toPrecReal: return eval_toPrecReal(loc, fd, arguments_!.opSlice());
        case BUILTIN.ctfeWrite: return eval_ctfeWrite(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_sin: return eval_llvmsin(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_cos: return eval_llvmcos(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_sqrt: return eval_llvmsqrt(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_exp: return eval_llvmexp(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_exp2: return eval_llvmexp2(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_log: return eval_llvmlog(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_log2: return eval_llvmlog2(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_log10: return eval_llvmlog10(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_fabs: return eval_llvmfabs(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_minnum: return eval_llvmminnum(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_maxnum: return eval_llvmmaxnum(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_floor: return eval_llvmfloor(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_ceil: return eval_llvmceil(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_trunc: return eval_llvmtrunc(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_rint: return eval_llvmrint(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_nearbyint: return eval_llvmnearbyint(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_round: return eval_llvmround(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_lround: return eval_llvmlround(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_llround: return eval_llvmllround(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_lrint: return eval_llvmlrint(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_llrint: return eval_llvmllrint(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_fma: return eval_llvmfma(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_copysign: return eval_llvmcopysign(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_bswap: return eval_llvmbswap(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_cttz: return eval_llvmcttz(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_ctlz: return eval_llvmctlz(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_ctpop: return eval_llvmctpop(loc, fd, arguments_!.opSlice());
        case BUILTIN.llvm_expect: return eval_llvmexpect(loc, fd, arguments_!.opSlice());
        default: assertUnreachable();
    }
}

// D `private:` (builtin.d:73) — every declaration below is module-private: not exported.

/**
 * Handler for evaluating builtins during CTFE.
 *
 * Params:
 *  loc = The call location, for error reporting.
 *  fd = The callee declaration, e.g. to disambiguate between different overloads
 *       in a single handler (LDC).
 *  arguments = The function call arguments.
 * Returns:
 *  An Expression containing the return value of the call.
 */
// (The comment above sits at builtin.d:75-85 in the D source, detached from any declaration; it documents the
// shape every `eval_*` function below shares.)

/// dmd/builtin.d:87 — `BUILTIN determine_builtin(FuncDeclaration func)`.
function determine_builtin(func: FuncDeclaration): BUILTIN {
    const fd = func.toAliasFunc();
    if (fd.isDeprecated())
        return BUILTIN.unimp;

    // resolved: `version (IN_LLVM)` (builtin.d:93) -> ON, so its block is live. Its function-local imports
    // (`dmd.root.string : toDString`, `gen.dpragma : LDCPragma`, :95-96) are module-level here (01 §3); `toDString`
    // has no use in the block.
    // `llvmInternal` is written by DtoCheckPragma (gen/dpragma.ts) for a `pragma(LDC_intrinsic)` function, and
    // `mangleOverride` then holds the intrinsic name. `LLVMintrinsic` is 2 in the D binding and the C++ enum alike.
    if (func.llvmInternal === LDCPragma.LLVMintrinsic) {
        let name = func.mangleOverride ?? dsEmpty; // `const(char)[]`: a null slice has length 0
        if (name.length < 7 || !dsEquals(name.subarray(0, 5), ds("llvm.")))
            return BUILTIN.unimp;

        // find next "." after "llvm."
        let end = 0;
        for (let i = 6; i < name.length; i++) {
            if (name[i] === 0x2e) { // '.'
                end = i;
                break;
            }
        }
        if (end === 0)
            return BUILTIN.unimp;

        name = name.subarray(5, end); // e.g., "llvm.sin.f32" => "sin"
        // The `foreach (e; __traits(allMembers, BUILTIN))` + `static if` + `mixin` arms (builtin.d:118-124),
        // unrolled (07 §4.2): one `case` per `llvm_*` member, in declaration order, keyed by the name after `llvm_`.
        switch (dsToJs(name)) {
            case "sin": return BUILTIN.llvm_sin;
            case "cos": return BUILTIN.llvm_cos;
            case "sqrt": return BUILTIN.llvm_sqrt;
            case "exp": return BUILTIN.llvm_exp;
            case "exp2": return BUILTIN.llvm_exp2;
            case "log": return BUILTIN.llvm_log;
            case "log2": return BUILTIN.llvm_log2;
            case "log10": return BUILTIN.llvm_log10;
            case "fabs": return BUILTIN.llvm_fabs;
            case "minnum": return BUILTIN.llvm_minnum;
            case "maxnum": return BUILTIN.llvm_maxnum;
            case "floor": return BUILTIN.llvm_floor;
            case "ceil": return BUILTIN.llvm_ceil;
            case "trunc": return BUILTIN.llvm_trunc;
            case "rint": return BUILTIN.llvm_rint;
            case "nearbyint": return BUILTIN.llvm_nearbyint;
            case "round": return BUILTIN.llvm_round;
            case "lround": return BUILTIN.llvm_lround;
            case "llround": return BUILTIN.llvm_llround;
            case "lrint": return BUILTIN.llvm_lrint;
            case "llrint": return BUILTIN.llvm_llrint;
            case "fma": return BUILTIN.llvm_fma;
            case "copysign": return BUILTIN.llvm_copysign;
            case "bswap": return BUILTIN.llvm_bswap;
            case "cttz": return BUILTIN.llvm_cttz;
            case "ctlz": return BUILTIN.llvm_ctlz;
            case "ctpop": return BUILTIN.llvm_ctpop;
            case "expect": return BUILTIN.llvm_expect;
            default: return BUILTIN.unimp;
        }
    }

    const m = fd.getModule();
    if (!m || !m.md)
        return BUILTIN.unimp;
    const md = m.md;

    // Look for core.math, core.bitop, std.math, and std.math.<package>
    const id2 = (md.packages.length === 2) ? md.packages[1]! : md.id;
    if (id2 !== Id.math && id2 !== Id.bitop && id2 !== Id.builtinsModuleName)
        return BUILTIN.unimp;

    if (md.packages.length !== 1 && !(md.packages.length === 2 && id2 === Id.math))
        return BUILTIN.unimp;

    const id1 = md.packages[0]!;
    if (id1 !== Id.core && id1 !== Id.std)
        return BUILTIN.unimp;
    const id3 = fd.ident;

    if (id1 === Id.core && id2 === Id.bitop) {
        if (id3 === Id.bsf)     return BUILTIN.bsf;
        if (id3 === Id.bsr)     return BUILTIN.bsr;
        if (id3 === Id.bswap)   return BUILTIN.bswap;
        if (id3 === Id._popcnt) return BUILTIN.popcnt;
        return BUILTIN.unimp;
    }

    if (id1 === Id.core && id2 === Id.builtinsModuleName) {
        if (id3 === Id.ctfeWrite)  return BUILTIN.ctfeWrite;
        return BUILTIN.unimp;
    }

    // Math
    if (id3 === Id.sin)   return BUILTIN.sin;
    if (id3 === Id.cos)   return BUILTIN.cos;
    if (id3 === Id.tan)   return BUILTIN.tan;
    if (id3 === Id.atan2) return BUILTIN.unimp; // N.B unimplmeneted

    if (id3 === Id._sqrt) return BUILTIN.sqrt;
    if (id3 === Id.fabs)  return BUILTIN.fabs;

    if (id3 === Id.exp)    return BUILTIN.exp;
    if (id3 === Id.expm1)  return BUILTIN.expm1;
    if (id3 === Id.exp2)   return BUILTIN.exp2;
    // resolved: `version (IN_LLVM)` (builtin.d:175) -> ON: yl2x/yl2xp1 are builtins unconditionally; the `else`
    // arm gating them on `CTFloat.yl2x_supported` / `yl2xp1_supported` (builtin.d:186-187) is resolved away.
    // Our implementations in CTFloat fall back to a generic version in case
    // host compiler's druntime doesn't provide core.math.yl2x[p1] (GDC,
    // non-x86 hosts). Not providing yl2x[p1] for CTFE would significantly
    // limit CTFE-ability of std.math for x86 targets.
    if (id3 === Id.yl2x)   return BUILTIN.yl2x;
    if (id3 === Id.yl2xp1) return BUILTIN.yl2xp1;

    if (id3 === Id.log)   return BUILTIN.log;
    if (id3 === Id.log2)  return BUILTIN.log2;
    if (id3 === Id.log10) return BUILTIN.log10;

    if (id3 === Id.ldexp) return BUILTIN.ldexp;
    if (id3 === Id.round) return BUILTIN.round;
    if (id3 === Id.floor) return BUILTIN.floor;
    if (id3 === Id.ceil)  return BUILTIN.ceil;
    if (id3 === Id.trunc) return BUILTIN.trunc;

    if (id3 === Id.fmin)     return BUILTIN.fmin;
    if (id3 === Id.fmax)     return BUILTIN.fmax;
    if (id3 === Id.fma)      return BUILTIN.fma;
    if (id3 === Id.copysign) return BUILTIN.copysign;

    if (id3 === Id.isnan)      return BUILTIN.isnan;
    if (id3 === Id.isInfinity) return BUILTIN.isinfinity;
    if (id3 === Id.isfinite)   return BUILTIN.isfinite;

    // Only match pow(fp,fp) where fp is a floating point type
    if (id3 === Id._pow) {
        if (isFloating(fd.parameters!.opIndex(0)!.type!) &&
            isFloating(fd.parameters!.opIndex(1)!.type!))
            return BUILTIN.pow;
        return BUILTIN.unimp;
    }

    if (id3 !== Id.toPrec)
        return BUILTIN.unimp;
    const me = mangleExact(fd);
    // `me["_D4core4math__T6toPrecHT".length]`: the byte after the template-parameter marker is the mangled `T`.
    const c = me["_D4core4math__T6toPrecHT".length];
    switch (c) {
        case 0x64: return BUILTIN.toPrecDouble; // 'd'
        case 0x65: return BUILTIN.toPrecReal;   // 'e'
        case 0x66: return BUILTIN.toPrecFloat;  // 'f'
        default:
            // final switch: exhaustiveness not statically checkable here (a `char` subject)
            throw new SwitchError(); // D default message: "No appropriate switch clause found"
    }
}

/// dmd/builtin.d:229 — `Expression eval_unimp(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_unimp(_loc: Loc, _fd: FuncDeclaration, _arguments: (Expression | null)[]): Expression | null {
    return null;
}

/// dmd/builtin.d:234 — `Expression eval_ctfeWrite(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
/// `__ctfeWrite(s)` writes the string straight to stderr (10 §4.4: one `dmdformat`, one write).
function eval_ctfeWrite(_loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    // function-local imports (builtin.d:236-239): core.stdc.stdio (10 §4.4), CTFEExp, resolveSlice, toStringExp —
    // hoisted to the module import list.

    const e = arguments_[0]!;
    const se = toStringExp(resolveSlice(e));
    assert(se);
    const slice = se.peekString();
    process.stderr.write(dsToJs(dmdformat(ds("%.*s"), [slice.length, slice])));
    return CTFEExp.voidexp!;
}

/// dmd/builtin.d:249 — `Expression eval_sin(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_sin(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.sin(toReal(arg0)), arg0.type);
}

/// dmd/builtin.d:256 — `Expression eval_cos(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_cos(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.cos(toReal(arg0)), arg0.type);
}

/// dmd/builtin.d:263 — `Expression eval_tan(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_tan(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.tan(toReal(arg0)), arg0.type);
}

/// dmd/builtin.d:270 — `Expression eval_sqrt(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_sqrt(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.sqrt(toReal(arg0)), arg0.type);
}

/// dmd/builtin.d:277 — `Expression eval_fabs(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_fabs(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.fabs(toReal(arg0)), arg0.type);
}

/// dmd/builtin.d:284 — `Expression eval_ldexp(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_ldexp(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    const arg1 = arguments_[1]!;
    assert(arg1.op === EXP.int64);
    // `cast(int) arg1.toInteger()` — the low 32 bits, signed (09 §2); the masked value is int-domain.
    return new RealExp(loc, CTFloat.ldexp(toReal(arg0), Number(maskSignedN(32, toInteger(arg1)))), arg0.type);
}

/// dmd/builtin.d:293 — `Expression eval_log(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_log(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.log(toReal(arg0)), arg0.type);
}

/// dmd/builtin.d:300 — `Expression eval_log2(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_log2(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.log2(toReal(arg0)), arg0.type);
}

/// dmd/builtin.d:307 — `Expression eval_log10(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_log10(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.log10(toReal(arg0)), arg0.type);
}

/// dmd/builtin.d:314 — `Expression eval_exp(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_exp(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.exp(toReal(arg0)), arg0.type);
}

/// dmd/builtin.d:321 — `Expression eval_expm1(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_expm1(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.expm1(toReal(arg0)), arg0.type);
}

/// dmd/builtin.d:328 — `Expression eval_exp2(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_exp2(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.exp2(toReal(arg0)), arg0.type);
}

/// dmd/builtin.d:335 — `Expression eval_round(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_round(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.round(toReal(arg0)), arg0.type);
}

/// dmd/builtin.d:342 — `Expression eval_floor(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_floor(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.floor(toReal(arg0)), arg0.type);
}

/// dmd/builtin.d:349 — `Expression eval_ceil(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_ceil(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.ceil(toReal(arg0)), arg0.type);
}

/// dmd/builtin.d:356 — `Expression eval_trunc(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_trunc(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.trunc(toReal(arg0)), arg0.type);
}

/// dmd/builtin.d:363 — `Expression eval_copysign(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_copysign(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    const arg1 = arguments_[1]!;
    assert(arg1.op === EXP.float64);
    return new RealExp(loc, CTFloat.copysign(toReal(arg0), toReal(arg1)), arg0.type);
}

/// dmd/builtin.d:372 — `Expression eval_pow(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_pow(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    const arg1 = arguments_[1]!;
    assert(arg1.op === EXP.float64);
    return new RealExp(loc, CTFloat.pow(toReal(arg0), toReal(arg1)), arg0.type);
}

/// dmd/builtin.d:381 — `Expression eval_fmin(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_fmin(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    const arg1 = arguments_[1]!;
    assert(arg1.op === EXP.float64);
    return new RealExp(loc, CTFloat.fmin(toReal(arg0), toReal(arg1)), arg0.type);
}

/// dmd/builtin.d:390 — `Expression eval_fmax(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_fmax(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    const arg1 = arguments_[1]!;
    assert(arg1.op === EXP.float64);
    return new RealExp(loc, CTFloat.fmax(toReal(arg0), toReal(arg1)), arg0.type);
}

/// dmd/builtin.d:399 — `Expression eval_fma(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_fma(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    const arg1 = arguments_[1]!;
    assert(arg1.op === EXP.float64);
    const arg2 = arguments_[2]!;
    assert(arg2.op === EXP.float64);
    return new RealExp(loc, CTFloat.fma(toReal(arg0), toReal(arg1), toReal(arg2)), arg0.type);
}

/// dmd/builtin.d:410 — `Expression eval_isnan(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_isnan(_loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return IntegerExp.createBool(CTFloat.isNaN(toReal(arg0)));
}

/// dmd/builtin.d:417 — `Expression eval_isinfinity(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_isinfinity(_loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return IntegerExp.createBool(CTFloat.isInfinity(toReal(arg0)));
}

/// dmd/builtin.d:424 — `Expression eval_isfinite(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_isfinite(_loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    const value = !CTFloat.isNaN(toReal(arg0)) && !CTFloat.isInfinity(toReal(arg0));
    return IntegerExp.createBool(value);
}

/// dmd/builtin.d:432 — `Expression eval_bsf(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_bsf(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.int64);
    const n: dinteger_t = toUint64(toInteger(arg0)); // `auto n = arg0.toInteger();` — a `ulong`
    if (n === 0n)
        error(loc, ds("`bsf(0)` is undefined"));
    return new IntegerExp(loc, BigInt(core_bitop.bsf(n)), Type.tint32);
}

/// dmd/builtin.d:442 — `Expression eval_bsr(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_bsr(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.int64);
    const n: dinteger_t = toUint64(toInteger(arg0)); // `auto n = arg0.toInteger();` — a `ulong`
    if (n === 0n)
        error(loc, ds("`bsr(0)` is undefined"));
    return new IntegerExp(loc, BigInt(core_bitop.bsr(n)), Type.tint32);
}

/// dmd/builtin.d:452 — `Expression eval_bswap(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_bswap(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.int64);
    const n: dinteger_t = toInteger(arg0);
    const ty: TY = toBasetype(arg0.type!).ty;
    if (ty === Tint64 || ty === Tuns64)
        return new IntegerExp(loc, core_bitop.bswapUlong(toUint64(n)), arg0.type!); // `cast(ulong) n`
    else
        return new IntegerExp(loc, core_bitop.bswapUint(maskUnsignedN(32, n)), arg0.type!); // `cast(uint) n`
}

/// dmd/builtin.d:464 — `Expression eval_popcnt(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_popcnt(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.int64);
    const n: dinteger_t = toUint64(toInteger(arg0)); // `auto n = arg0.toInteger();` — a `ulong`
    return new IntegerExp(loc, BigInt(core_bitop.popcnt(n)), Type.tint32);
}

/// dmd/builtin.d:472 — `Expression eval_yl2x(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_yl2x(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    const arg1 = arguments_[1]!;
    assert(arg1.op === EXP.float64);
    const x = toReal(arg0);
    const y = toReal(arg1);
    let result: real_t = CTFloat.zero;
    // `CTFloat.yl2x(&x, &y, &result);` — the port's CTFloat returns the value the D form writes through `result`
    // (root/ctfloat.ts, the yl2x block).
    result = CTFloat.yl2x(x, y);
    return new RealExp(loc, result, arg0.type);
}

/// dmd/builtin.d:485 — `Expression eval_yl2xp1(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_yl2xp1(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    const arg1 = arguments_[1]!;
    assert(arg1.op === EXP.float64);
    const x = toReal(arg0);
    const y = toReal(arg1);
    let result: real_t = CTFloat.zero;
    // `CTFloat.yl2xp1(&x, &y, &result);` — returned by value in the port (see eval_yl2x).
    result = CTFloat.yl2xp1(x, y);
    return new RealExp(loc, result, arg0.type);
}

/// dmd/builtin.d:498 — `Expression eval_toPrecFloat(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
///
/// `float f = cast(real)arg0.toReal();` is a conversion to a HOST `float` inside the compiler's own code, so the
/// value really is rounded to single precision before it is widened back into the `real_t` carrier: `Math.fround`
/// at builtin.d:501, ratified by the integrator on this file's E2 escalation (09 §6.1's no-`fround` rule is to be
/// amended for this site). ldc2 1.43.0: `toPrec!float(0.1)` folds to 0x3fb99999a0000000 (0.10000000149011612) and
/// `toPrec!float(16777217.0)` to 16777216.
function eval_toPrecFloat(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    const f = Math.fround(toReal(arg0));
    return new RealExp(loc, f /* real_t(f) */, Type.tfloat32);
}

/// dmd/builtin.d:505 — `Expression eval_toPrecDouble(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
/// `double d = cast(real)arg0.toReal();` — `real` is `double` on this target (09 §6), so the value is unchanged.
function eval_toPrecDouble(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    const d = toReal(arg0);
    return new RealExp(loc, d /* real_t(d) */, Type.tfloat64);
}

/// dmd/builtin.d:512 — `Expression eval_toPrecReal(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_toPrecReal(loc: Loc, _fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const arg0 = arguments_[0]!;
    return new RealExp(loc, toReal(arg0), Type.tfloat80);
}

// These built-ins are reserved for GDC and LDC.
/// dmd/builtin.d:519 — `Expression eval_gcc(Loc, FuncDeclaration, Expression[])`.
function eval_gcc(_loc: Loc, _fd: FuncDeclaration, _arguments: (Expression | null)[]): Expression {
    assertUnreachable();
}

/// dmd/builtin.d:524 — `Expression eval_llvm(Loc, FuncDeclaration, Expression[])`.
function eval_llvm(_loc: Loc, _fd: FuncDeclaration, _arguments: (Expression | null)[]): Expression {
    assertUnreachable();
}

// resolved: `version (IN_LLVM)` (builtin.d:529-872) -> ON (_config.md §1); the block shapes CTFE results, so it is
// KEPT (_config.md §2). `import dmd.globals : uinteger_t;` (:531) is the module-level `uinteger_t` type import above.

/// dmd/builtin.d:533 — `private Type getTypeOfOverloadedIntrinsic(FuncDeclaration fd)`.
/// The type an overloaded intrinsic is instantiated with. `cast(Type)` is D's dynamic downcast, null for a
/// non-Type, so the result is nullable as in D.
function getTypeOfOverloadedIntrinsic(fd: FuncDeclaration): Type | null {
    // function-local import `dmd.dtemplate : TemplateInstance` (builtin.d:535): only a type name in D; the port reads
    // it through `isTemplateInstance()`.

    // Depending on the state of the code generation we have to look at
    // the template instance or the function declaration.
    // D: `assert(fd.parent && "function declaration requires parent")` — the string literal is non-null, so the
    // condition is `fd.parent` alone and the message is the default one.
    assert(fd.parent !== null);
    const tinst = fd.parent.isTemplateInstance();
    if (tinst !== null) {
        // See DtoOverloadedIntrinsicName
        assert(tinst.tdtypes.length === 1);
        return isType(tinst.tdtypes.opIndex(0)); // `cast(Type) tinst.tdtypes[0]`
    } else {
        assert(fd.type!.ty === Tfunction);
        const tf = fd.type!.isTypeFunction()!; // `cast(TypeFunction) fd.type`, proved by the assert above
        assert(tf.parameterList.length() >= 1);
        return tf.parameterList.parameters!.opIndex(0)!.type;
    }
}

/// dmd/builtin.d:556 — `private int getBitsizeOfType(Loc loc, Type type)`.
function getBitsizeOfType(loc: Loc, type: Type): number {
    switch (toBasetype(type).ty) {
        case Tint64:
        case Tuns64: return 64;
        case Tint32:
        case Tuns32: return 32;
        case Tint16:
        case Tuns16: return 16;
        case Tint128:
        case Tuns128:
            error(loc, ds("cent/ucent not supported"));
            break;
        default:
            error(loc, ds("unsupported type"));
            break;
    }
    return 32; // in case of error
}

/// dmd/builtin.d:577 — `Expression eval_llvmsin(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_llvmsin(loc: Loc, fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const type = getTypeOfOverloadedIntrinsic(fd);
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.sin(toReal(arg0)), type);
}

/// dmd/builtin.d:585 — `Expression eval_llvmcos(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_llvmcos(loc: Loc, fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const type = getTypeOfOverloadedIntrinsic(fd);
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.cos(toReal(arg0)), type);
}

/// dmd/builtin.d:593 — `Expression eval_llvmsqrt(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_llvmsqrt(loc: Loc, fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const type = getTypeOfOverloadedIntrinsic(fd);
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.sqrt(toReal(arg0)), type);
}

/// dmd/builtin.d:601 — `Expression eval_llvmexp(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_llvmexp(loc: Loc, fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const type = getTypeOfOverloadedIntrinsic(fd);
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.exp(toReal(arg0)), type);
}

/// dmd/builtin.d:609 — `Expression eval_llvmexp2(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_llvmexp2(loc: Loc, fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const type = getTypeOfOverloadedIntrinsic(fd);
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.exp2(toReal(arg0)), type);
}

/// dmd/builtin.d:617 — `Expression eval_llvmlog(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_llvmlog(loc: Loc, fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const type = getTypeOfOverloadedIntrinsic(fd);
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.log(toReal(arg0)), type);
}

/// dmd/builtin.d:625 — `Expression eval_llvmlog2(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_llvmlog2(loc: Loc, fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const type = getTypeOfOverloadedIntrinsic(fd);
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.log2(toReal(arg0)), type);
}

/// dmd/builtin.d:633 — `Expression eval_llvmlog10(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_llvmlog10(loc: Loc, fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const type = getTypeOfOverloadedIntrinsic(fd);
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.log10(toReal(arg0)), type);
}

/// dmd/builtin.d:641 — `Expression eval_llvmfabs(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_llvmfabs(loc: Loc, fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const type = getTypeOfOverloadedIntrinsic(fd);
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.fabs(toReal(arg0)), type);
}

/// dmd/builtin.d:649 — `Expression eval_llvmminnum(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_llvmminnum(loc: Loc, fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const type = getTypeOfOverloadedIntrinsic(fd);
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    const arg1 = arguments_[1]!;
    assert(arg1.op === EXP.float64);
    return new RealExp(loc, CTFloat.fmin(toReal(arg0), toReal(arg1)), type);
}

/// dmd/builtin.d:659 — `Expression eval_llvmmaxnum(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_llvmmaxnum(loc: Loc, fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const type = getTypeOfOverloadedIntrinsic(fd);
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    const arg1 = arguments_[1]!;
    assert(arg1.op === EXP.float64);
    return new RealExp(loc, CTFloat.fmax(toReal(arg0), toReal(arg1)), type);
}

/// dmd/builtin.d:669 — `Expression eval_llvmfloor(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_llvmfloor(loc: Loc, fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const type = getTypeOfOverloadedIntrinsic(fd);
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.floor(toReal(arg0)), type);
}

/// dmd/builtin.d:677 — `Expression eval_llvmceil(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_llvmceil(loc: Loc, fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const type = getTypeOfOverloadedIntrinsic(fd);
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.ceil(toReal(arg0)), type);
}

/// dmd/builtin.d:685 — `Expression eval_llvmtrunc(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_llvmtrunc(loc: Loc, fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const type = getTypeOfOverloadedIntrinsic(fd);
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.trunc(toReal(arg0)), type);
}

/// dmd/builtin.d:693 — `Expression eval_llvmrint(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_llvmrint(loc: Loc, fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const type = getTypeOfOverloadedIntrinsic(fd);
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.rint(toReal(arg0)), type);
}

/// dmd/builtin.d:701 — `Expression eval_llvmnearbyint(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_llvmnearbyint(loc: Loc, fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const type = getTypeOfOverloadedIntrinsic(fd);
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.nearbyint(toReal(arg0)), type);
}

/// dmd/builtin.d:709 — `Expression eval_llvmround(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_llvmround(loc: Loc, fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const type = getTypeOfOverloadedIntrinsic(fd);
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new RealExp(loc, CTFloat.round(toReal(arg0)), type);
}

/// dmd/builtin.d:717 — `alias eval_llvmlrint = eval_llvmllrint; // difference: int return type, not long`.
/// A local second name for the function (02 §5.3); the function declaration below is hoisted.
const eval_llvmlrint = eval_llvmllrint;
/// dmd/builtin.d:718 — `Expression eval_llvmllrint(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_llvmllrint(loc: Loc, fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const type = fd.type!.isTypeFunction()!.next!; // int or long
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new IntegerExp(loc, CTFloat.llrint(toReal(arg0)), type);
}

/// dmd/builtin.d:726 — `alias eval_llvmlround = eval_llvmllround; // difference: int return type, not long`.
/// A local second name for the function (02 §5.3); the function declaration below is hoisted.
const eval_llvmlround = eval_llvmllround;
/// dmd/builtin.d:727 — `Expression eval_llvmllround(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_llvmllround(loc: Loc, fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const type = fd.type!.isTypeFunction()!.next!; // int or long
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    return new IntegerExp(loc, CTFloat.llround(toReal(arg0)), type);
}

/// dmd/builtin.d:735 — `Expression eval_llvmfma(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_llvmfma(loc: Loc, fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const type = getTypeOfOverloadedIntrinsic(fd);
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    const arg1 = arguments_[1]!;
    assert(arg1.op === EXP.float64);
    const arg2 = arguments_[2]!;
    assert(arg2.op === EXP.float64);
    return new RealExp(loc, CTFloat.fma(toReal(arg0), toReal(arg1), toReal(arg2)), type);
}

/// dmd/builtin.d:747 — `Expression eval_llvmcopysign(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_llvmcopysign(loc: Loc, fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const type = getTypeOfOverloadedIntrinsic(fd);
    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.float64);
    const arg1 = arguments_[1]!;
    assert(arg1.op === EXP.float64);
    return new RealExp(loc, CTFloat.copysign(toReal(arg0), toReal(arg1)), type);
}

/// dmd/builtin.d:757 — `Expression eval_llvmbswap(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
/// Byte-swaps within the operand's width by three mask-and-shift passes; the wider widths fall through into
/// the narrower passes. `type` is dereferenced by `toBasetype`, as in D.
function eval_llvmbswap(loc: Loc, fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const type = getTypeOfOverloadedIntrinsic(fd)!;

    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.int64);
    let n: uinteger_t = toUint64(toInteger(arg0));
    const BYTEMASK = 0x00FF00FF00FF00FFn;   // enum ulong
    const SHORTMASK = 0x0000FFFF0000FFFFn;  // enum ulong
    const INTMASK = 0x00000000FFFFFFFFn;    // enum ulong
    switch (toBasetype(type).ty) {
        case Tint64:
        case Tuns64:
            // swap high and low uints
            n = toUint64(((n >> 32n) & INTMASK) | ((n & INTMASK) << 32n));
            // goto case Tuns32; -> fall through (the textually next arm, 06 §3.6(a))
        case Tint32:
        case Tuns32:
            // swap adjacent ushorts
            n = toUint64(((n >> 16n) & SHORTMASK) | ((n & SHORTMASK) << 16n));
            // goto case Tuns16; -> fall through (the textually next arm, 06 §3.6(a))
        case Tint16:
        case Tuns16:
            // swap adjacent ubytes
            n = toUint64(((n >> 8n ) & BYTEMASK)  | ((n & BYTEMASK) << 8n ));
            break;
        case Tint128:
        case Tuns128:
            error(loc, ds("cent/ucent not supported"));
            break;
        default:
            error(loc, ds("unsupported type"));
            break;
    }
    return new IntegerExp(loc, n, type);
}

/// dmd/builtin.d:795 — `Expression eval_llvmcttz(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
/// Count of trailing zero bits, by binary search over halving shift widths.
function eval_llvmcttz(loc: Loc, fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const type = getTypeOfOverloadedIntrinsic(fd)!; // dereferenced by getBitsizeOfType, as in D

    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.int64);
    let x: uinteger_t = toUint64(toInteger(arg0));

    let n = getBitsizeOfType(loc, type);

    if (x === 0n) {
        if (toInteger(arguments_[1]!) !== 0n)
            error(loc, ds("llvm.cttz.i#(0) is undefined"));
    } else {
        let c = n >> 1;
        n -= 1;
        const mask: uinteger_t = toUint64((1n << BigInt(n)) | ((1n << BigInt(n)) - 1n));
        do {
            const y: uinteger_t = toUint64(x << BigInt(c)) & mask;
            if (y !== 0n) { n -= c; x = y; }
            c = c >> 1;
        } while (c !== 0);
    }

    return new IntegerExp(loc, BigInt(n), type);
}

/// dmd/builtin.d:825 — `Expression eval_llvmctlz(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
/// Count of leading zero bits within the operand's width, by binary search over halving shift widths.
function eval_llvmctlz(loc: Loc, fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const type = getTypeOfOverloadedIntrinsic(fd)!; // dereferenced by getBitsizeOfType, as in D

    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.int64);
    let x: uinteger_t = toUint64(toInteger(arg0));
    if (x === 0n && toInteger(arguments_[1]!) !== 0n)
        error(loc, ds("llvm.ctlz.i#(0) is undefined"));

    let n = getBitsizeOfType(loc, type);
    let c = n >> 1;
    do {
        const y: uinteger_t = x >> BigInt(c); if (y !== 0n) { n -= c; x = y; }
        c = c >> 1;
    } while (c !== 0);

    // `n - x`: `int - ulong` is a `ulong` subtraction; the IntegerExp constructor normalizes the carrier to `type`.
    return new IntegerExp(loc, toUint64(BigInt(n) - x), type);
}

/// dmd/builtin.d:845 — `Expression eval_llvmctpop(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_llvmctpop(loc: Loc, fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    // FIXME Does not work for cent/ucent
    const type = getTypeOfOverloadedIntrinsic(fd)!; // the IntegerExp constructor dereferences it, as in D

    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.int64);
    let n: uinteger_t = toUint64(toInteger(arg0));
    let cnt = 0;
    while (n !== 0n) {
        cnt += Number(n & 1n); // `cnt += (n & 1)` — the masked bit is 0 or 1, int-domain
        n >>= 1n;
    }
    return new IntegerExp(loc, BigInt(cnt), type);
}

/// dmd/builtin.d:862 — `Expression eval_llvmexpect(Loc loc, FuncDeclaration fd, Expression[] arguments)`.
function eval_llvmexpect(loc: Loc, fd: FuncDeclaration, arguments_: (Expression | null)[]): Expression {
    const type = getTypeOfOverloadedIntrinsic(fd)!; // the IntegerExp constructor dereferences it, as in D

    const arg0 = arguments_[0]!;
    assert(arg0.op === EXP.int64);

    return new IntegerExp(loc, toInteger(arg0), type);
}
