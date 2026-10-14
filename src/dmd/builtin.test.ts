// Goal tests for src/dmd/builtin.ts.
//
// dmd/builtin.d has ZERO in-source `unittest{}` blocks, so this file takes the 10 §1.6b shape: one module-load smoke
// test plus behaviour pins, one `test()` per concern. Every expected value is ldc2 1.43.0 output
// (arm64-apple-darwin): a `static immutable double` folded at compile time and printed as its bit pattern, or
// `pragma(msg, <call>)` for the integer and `ldc.intrinsics` cases, or the diagnostic ldc2 prints on stderr. The
// evaluators are reached through the two public entry points: `isBuiltin` on a FuncDeclaration placed in a module
// whose ModuleDeclaration names the D package, and `eval_builtin` on a FuncDeclaration whose `builtin` field is set.
//
// `test.fails` pins (the attrib.test.ts convention) cover exactly the escalated V8-vs-libm divergences of CTFloat
// (root/ctfloat.ts; the E1 escalation record of this file's translation report): each states a probed ldc2 value the
// port does not yet produce, and flips to a loud failure when its CTFloat member is fixed, to be turned into a plain
// pin then.

import { initSemaHarness } from "../sema-harness.js"; // imports ./dmd/parse.js first: the module-graph root (10 §1.5)
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { isBuiltin, eval_builtin } from "./builtin.js";
import { BUILTIN, FuncDeclaration } from "./func.js";
import { Expression, IntegerExp, RealExp, StringExp, CTFEExp } from "./expression.js";
import { Module, ModuleDeclaration } from "./dmodule.js";
import { VarDeclaration } from "./declaration.js";
import { TemplateInstance } from "./dtemplate.js";
import type { Dsymbol } from "./dsymbol.js";
import { Parameter, ParameterList, Type, TypeFunction } from "./mtype.js";
import { Identifier } from "./identifier.js";
import { Id } from "./id.js";
import { Loc } from "./location.js";
import { EXP } from "./tokens.js";
import { LINK, STC, VarArg } from "./astenums.js";
import { Array as DArray } from "./root/array.js";
import type { Expressions, Parameters, VarDeclarations } from "./arraytypes.js";
import { setDiagnosticHandler } from "./errors.js";
import { dmdformat } from "./root/dmdformat.js";
import { AssertError } from "../assert.js";
import { ds, dsToJs } from "../dstring.js";
import { LDCPragma } from "../gen/dpragma.js";

const loc = Loc.initial;

function ident(s: string): Identifier {
    return Identifier.idPool(ds(s));
}

/** A FuncDeclaration named `name`, declared in module `<packages>.<modId>` (a ModuleDeclaration is attached). */
function fdIn(packages: string[], modId: string, name: string): FuncDeclaration {
    const m = new Module(loc, ds(modId + ".d"), ident(modId), 0, 0);
    m.md = new ModuleDeclaration(loc, packages.map(ident), ident(modId), null, false);
    const fd = new FuncDeclaration(loc, loc, ident(name), STC.none, null);
    fd.parent = m as unknown as Dsymbol; // upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool)
    return fd;
}

/** A FuncDeclaration whose `builtin` is preset, typed `ret function(params...)`, parented to a plain module. */
function fdFor(b: BUILTIN, params: Type[] = [], ret: Type = Type.tvoid): FuncDeclaration {
    const fd = fdIn(["ldc"], "intrinsics", "f");
    const ps: Parameters = new DArray<Parameter | null>();
    for (const t of params)
        ps.push(new Parameter(loc, STC.none, t, null, null, null));
    fd.type = new TypeFunction(new ParameterList(ps, VarArg.none), ret, LINK.d);
    fd.builtin = b;
    return fd;
}

function args(...es: Expression[]): Expressions {
    const a: Expressions = new DArray<Expression | null>();
    for (const e of es)
        a.push(e);
    return a;
}

function real(v: number, t: Type = Type.tfloat64): RealExp {
    return new RealExp(loc, v, t);
}

function int(v: bigint, t: Type = Type.tint32): IntegerExp {
    return new IntegerExp(loc, v, t);
}

/** The IEEE-754 bit pattern of a double, as 16 lowercase hex digits (the ldc2 probe prints `%016llx`). */
function bits(v: number): string {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, v);
    return dv.getBigUint64(0).toString(16).padStart(16, "0");
}

/** Evaluate a one- to three-argument builtin, asserting it produced a RealExp; returns [bits, result]. */
function evalReal(b: BUILTIN, ...xs: Expression[]): [string, RealExp] {
    const e = eval_builtin(loc, fdFor(b), args(...xs))!;
    expect(e.op).toBe(EXP.float64);
    const re = e.isRealExp()!;
    return [bits(re.value), re];
}

function evalInt(fd: FuncDeclaration, ...xs: Expression[]): IntegerExp {
    const e = eval_builtin(loc, fd, args(...xs))!;
    expect(e.op).toBe(EXP.int64);
    return e.isIntegerExp()!;
}

/** Run `fn` with a diagnostic handler that records "Error: <message>" lines. */
function withDiags<T>(fn: () => T): { value: T; diags: string[] } {
    const diags: string[] = [];
    setDiagnosticHandler((_loc, _color, header, messageFormat, a) => {
        diags.push(dsToJs(header) + dsToJs(dmdformat(messageFormat, [...a])));
        return true;
    });
    try {
        return { value: fn(), diags };
    } finally {
        setDiagnosticHandler(null);
    }
}

describe("builtin.ts", () => {
    beforeEach(() => {
        initSemaHarness();
    });

    test("module loads: the two public entry points and the AST classes they build", () => {
        expect(typeof Expression).toBe("function"); // 10 §1.5 graph-root regression check
        expect(typeof isBuiltin).toBe("function");
        expect(typeof eval_builtin).toBe("function");
    });

    test("isBuiltin: core.math / std.math.<pkg> / core.bitop / core.builtins identifiers, cached in fd.builtin", () => {
        const sqrt = fdIn(["core"], "math", "sqrt");
        expect(sqrt.builtin).toBe(BUILTIN.unknown);
        expect(isBuiltin(sqrt)).toBe(BUILTIN.sqrt);
        expect(sqrt.builtin).toBe(BUILTIN.sqrt); // builtin.d:39 — the answer is stored
        sqrt.builtin = BUILTIN.cos;              // and read back, never recomputed (builtin.d:37)
        expect(isBuiltin(sqrt)).toBe(BUILTIN.cos);

        expect(isBuiltin(fdIn(["std", "math"], "trigonometry", "tan"))).toBe(BUILTIN.tan);
        expect(isBuiltin(fdIn(["std"], "math", "floor"))).toBe(BUILTIN.floor);
        expect(isBuiltin(fdIn(["std", "math"], "exponential", "yl2x"))).toBe(BUILTIN.yl2x); // IN_LLVM arm, :181
        expect(isBuiltin(fdIn(["std", "math"], "traits", "isInfinity"))).toBe(BUILTIN.isinfinity);
        expect(isBuiltin(fdIn(["core"], "bitop", "bsf"))).toBe(BUILTIN.bsf);
        expect(isBuiltin(fdIn(["core"], "bitop", "_popcnt"))).toBe(BUILTIN.popcnt);
        expect(isBuiltin(fdIn(["core"], "bitop", "popcnt"))).toBe(BUILTIN.unimp); // only `_popcnt` (:153)
        expect(isBuiltin(fdIn(["core"], "builtins", "__ctfeWrite"))).toBe(BUILTIN.ctfeWrite);
        expect(isBuiltin(fdIn(["core"], "builtins", "sin"))).toBe(BUILTIN.unimp);
    });

    test("isBuiltin: modules and names outside the table are unimp", () => {
        expect(isBuiltin(fdIn(["core", "stdc"], "math", "sqrt"))).toBe(BUILTIN.unimp); // id2 = `stdc`
        expect(isBuiltin(fdIn(["core"], "bitop", "sin"))).toBe(BUILTIN.unimp);
        expect(isBuiltin(fdIn(["etc"], "math", "sin"))).toBe(BUILTIN.unimp);             // id1 not core/std
        expect(isBuiltin(fdIn(["std", "math", "x"], "y", "sin"))).toBe(BUILTIN.unimp);   // three packages
        expect(isBuiltin(fdIn(["core", "bitop"], "x", "bsf"))).toBe(BUILTIN.unimp);      // bitop only as `id`
        expect(isBuiltin(fdIn(["std"], "math", "atan2"))).toBe(BUILTIN.unimp);           // N.B. unimplemented
        expect(isBuiltin(fdIn(["std"], "math", "isNaN"))).toBe(BUILTIN.unimp);           // Id.isnan is "isnan"
        const noMd = new FuncDeclaration(loc, loc, Id.sin, STC.none, null);
        // upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool)
        noMd.parent = new Module(loc, ds("math.d"), Id.math, 0, 0) as unknown as Dsymbol;
        expect(isBuiltin(noMd)).toBe(BUILTIN.unimp);                                     // `!m.md`
        const dep = fdIn(["core"], "math", "sin");
        dep.storage_class = (dep.storage_class | STC.deprecated_) as STC; // branded flag-enum re-cast (02 §4.2)
        expect(isBuiltin(dep)).toBe(BUILTIN.unimp);                                      // builtin.d:90
    });

    test("isBuiltin: pow is a builtin only for two floating parameters (builtin.d:210)", () => {
        const pow = (a: Type, b: Type): FuncDeclaration => {
            const fd = fdIn(["std", "math"], "exponential", "pow");
            const ps: VarDeclarations = new DArray<VarDeclaration | null>();
            ps.push(new VarDeclaration(loc, a, ident("x"), null));
            ps.push(new VarDeclaration(loc, b, ident("y"), null));
            fd.parameters = ps;
            return fd;
        };
        expect(isBuiltin(pow(Type.tfloat64, Type.tfloat32))).toBe(BUILTIN.pow);
        expect(isBuiltin(pow(Type.tfloat64, Type.tint32))).toBe(BUILTIN.unimp);
    });

    test("isBuiltin: toPrec runs mangleExact and final-switches on its type byte (builtin.d:220-226)", () => {
        // `id3 == Id.toPrec`, so `mangleExact(fd)` runs (live) and D's `final switch` reads the byte after
        // "_D4core4math__T6toPrecHT". This fd is a plain function, not a toPrec!T instance, so the byte matches no
        // case and the final switch fails, as D's would. The toPrec evaluators are pinned below via a preset
        // `fd.builtin`; a real toPrec!T instance needs druntime's core.math in the harness.
        expect(() => isBuiltin(fdIn(["core"], "math", "toPrec"))).toThrow("No appropriate switch clause found");
    });

    test("eval_builtin: unimp returns null without reading the arguments; unknown asserts", () => {
        expect(eval_builtin(loc, fdFor(BUILTIN.unimp), null)).toBeNull();
        expect(() => eval_builtin(loc, fdFor(BUILTIN.unknown), args())).toThrow(AssertError);
        expect(() => eval_builtin(loc, fdFor(BUILTIN.gcc), args())).toThrow(AssertError);  // eval_gcc: assert(0)
        expect(() => eval_builtin(loc, fdFor(BUILTIN.llvm), args())).toThrow(AssertError); // eval_llvm: assert(0)
    });

    test("float builtins agree bit for bit with ldc2 where CTFloat matches the host libm", () => {
        expect(evalReal(BUILTIN.sin, real(0.5))[0]).toBe("3fdeaee8744b05f0");
        expect(evalReal(BUILTIN.cos, real(0.5))[0]).toBe("3fec1528065b7d50");
        expect(evalReal(BUILTIN.tan, real(0.5))[0]).toBe("3fe17b4f5bf3474a");
        expect(evalReal(BUILTIN.sqrt, real(2.0))[0]).toBe("3ff6a09e667f3bcd");
        expect(evalReal(BUILTIN.sqrt, real(-1.0))[0]).toBe("7ff8000000000000");
        expect(evalReal(BUILTIN.exp, real(1.0))[0]).toBe("4005bf0a8b145769");
        expect(evalReal(BUILTIN.expm1, real(0.05))[0]).toBe("3faa403484548655");
        expect(evalReal(BUILTIN.exp2, real(0.05))[0]).toBe("3ff09071f3e983ad");
        expect(evalReal(BUILTIN.exp2, real(12.3456))[0]).toBe("40b454b3da46849c");
        expect(evalReal(BUILTIN.log, real(0.5))[0]).toBe("bfe62e42fefa39ef");
        expect(evalReal(BUILTIN.log, real(0.0))[0]).toBe("fff0000000000000");
        expect(evalReal(BUILTIN.log2, real(3.0))[0]).toBe("3ff95c01a39fbd68");
        expect(evalReal(BUILTIN.log10, real(7.25))[0]).toBe("3feb87e392374dd5");
        expect(evalReal(BUILTIN.pow, real(0.5), real(1.37))[0]).toBe("3fd8c2d382bb2f2b");
        expect(evalReal(BUILTIN.fabs, real(-0.0))[0]).toBe("0000000000000000");
        expect(evalReal(BUILTIN.ldexp, real(1.5), int(10n))[0]).toBe("4098000000000000");     // 1536
        expect(evalReal(BUILTIN.ldexp, real(-0.75), int(-3n))[0]).toBe("bfb8000000000000");   // -0.09375
    });

    test("rounding, min/max, fma and copysign follow CTFloat's D definitions (ldc2 values)", () => {
        expect(evalReal(BUILTIN.round, real(2.5))[1].value).toBe(3);
        expect(evalReal(BUILTIN.round, real(-2.5))[1].value).toBe(-3);
        // C roundl, not floor(x + 0.5): the addition would round these two (ctfloat.d:113)
        expect(evalReal(BUILTIN.round, real(0.49999999999999994))[0]).toBe("0000000000000000");
        expect(evalReal(BUILTIN.round, real(4503599627370497.0))[0]).toBe("4330000000000001");
        expect(evalReal(BUILTIN.round, real(-0.4))[0]).toBe("8000000000000000"); // -0.0
        expect(evalReal(BUILTIN.round, real(-0.5))[0]).toBe("bff0000000000000"); // -1
        expect(evalReal(BUILTIN.round, real(-0.0))[0]).toBe("8000000000000000");
        expect(evalReal(BUILTIN.round, real(Infinity))[0]).toBe("7ff0000000000000");
        expect(evalReal(BUILTIN.floor, real(-2.5))[1].value).toBe(-3);
        expect(evalReal(BUILTIN.ceil, real(-2.5))[1].value).toBe(-2);
        expect(evalReal(BUILTIN.trunc, real(-2.7))[1].value).toBe(-2);
        expect(evalReal(BUILTIN.fmin, real(NaN), real(1.0))[1].value).toBe(1);   // `x < y ? x : y`
        expect(evalReal(BUILTIN.fmax, real(1.0), real(NaN))[1].value).toBeNaN(); // `x > y ? x : y`
        expect(evalReal(BUILTIN.fma, real(0.1), real(10.0), real(-1.0))[0]).toBe("0000000000000000"); // two roundings
        expect(evalReal(BUILTIN.copysign, real(3.0), real(-0.0))[1].value).toBe(-3);
        expect(evalReal(BUILTIN.copysign, real(-3.0), real(1.0))[1].value).toBe(3);
    });

    test("ldexp is druntime's ldexpImpl: no intermediate overflow, subnormals truncated (ctfloat.d:93)", () => {
        const l = (n: number, e: bigint): string => evalReal(BUILTIN.ldexp, real(n), int(e))[0];
        expect(l(0.5, 1024n)).toBe("7fe0000000000000");
        expect(l(3.0, -1075n)).toBe("0000000000000001");  // 1.5 units of 2^-1074, truncated
        expect(l(-3.0, -1075n)).toBe("8000000000000001");
        expect(l(3.0, -1076n)).toBe("0000000000000000");  // 0.75 units, truncated
        expect(l(2.5, -1074n)).toBe("0000000000000002");
        expect(l(1.0, -1074n)).toBe("0000000000000001");
        expect(l(1.0, -1075n)).toBe("0000000000000000");
        expect(l(2 - 2 ** -52, -1023n)).toBe("000fffffffffffff"); // 0x1.fffffffffffffp-1 * 2^-1022
        expect(l(2 ** -1074, 1074n)).toBe("3ff0000000000000");   // subnormal input
        expect(l(2 ** -1074, 2000n)).toBe("79d0000000000000");
        expect(l(Number.MAX_VALUE, 1n)).toBe("7ff0000000000000");
        expect(l(1.0, 2000n)).toBe("7ff0000000000000");
        expect(l(Infinity, -5000n)).toBe("7ff0000000000000");
        expect(l(1e-300, 1500n)).toBe("5f656e1fc2f8f359");
        expect(l(1e300, -2000n)).toBe("0137e43c8800759c");
        expect(l(-0.0, 5n)).toBe("8000000000000010"); // ldexpImpl sends a zero down its subnormal-input path
    });

    test("a float builtin keeps the argument's type and the call location", () => {
        const at = Loc.singleFilename(ds("at.d")); // a Loc with a non-zero index, distinct from Loc.initial
        expect(at.isValid()).toBe(true);
        const e = eval_builtin(at, fdFor(BUILTIN.sqrt), args(real(4.0, Type.tfloat32)))!.isRealExp()!;
        expect(e.value).toBe(2);
        expect(e.type).toBe(Type.tfloat32);
        expect(e.loc.isValid()).toBe(true);
        expect(e.loc.opEquals(at)).toBe(true);
        expect(dsToJs(e.loc.filename()!)).toBe("at.d");
    });

    test("isnan / isinfinity / isfinite return bool IntegerExps", () => {
        const b = (k: BUILTIN, v: number): bigint => {
            const e = evalInt(fdFor(k), real(v));
            expect(e.type).toBe(Type.tbool);
            return e.value;
        };
        expect(b(BUILTIN.isnan, NaN)).toBe(1n);
        expect(b(BUILTIN.isnan, 1.0)).toBe(0n);
        expect(b(BUILTIN.isinfinity, -Infinity)).toBe(1n);
        expect(b(BUILTIN.isinfinity, NaN)).toBe(0n);
        expect(b(BUILTIN.isfinite, 1.0)).toBe(1n);
        expect(b(BUILTIN.isfinite, Infinity)).toBe(0n);
        expect(b(BUILTIN.isfinite, NaN)).toBe(0n);
    });

    test("bsf / bsr / popcnt read the carrier as a ulong and return int", () => {
        const f = (k: BUILTIN, v: bigint, t: Type = Type.tuns64): IntegerExp => evalInt(fdFor(k), int(v, t));
        expect(f(BUILTIN.bsf, 0x80n).value).toBe(7n);
        expect(f(BUILTIN.bsf, 0x80n).type).toBe(Type.tint32);
        expect(f(BUILTIN.bsr, 0x80n).value).toBe(7n);
        expect(f(BUILTIN.bsf, 0x8000_0000_0000_0000n).value).toBe(63n);
        expect(f(BUILTIN.bsr, 1n).value).toBe(0n);
        expect(f(BUILTIN.bsr, -1n, Type.tint64).value).toBe(63n); // ldc2: bsr(cast(ulong)-1L) == 63
        expect(f(BUILTIN.popcnt, 0xFFFF_0000_FFFFn).value).toBe(32n);
        expect(f(BUILTIN.popcnt, 0xFFFF_FFFF_FFFF_FFFFn).value).toBe(64n);
        expect(f(BUILTIN.popcnt, 0n, Type.tuns32).value).toBe(0n);
    });

    test("bsf(0) / bsr(0): the ldc2 diagnostic, and the value the ldc2 binary computes (64 / 127)", () => {
        const f = (k: BUILTIN): { value: IntegerExp; diags: string[] } =>
            withDiags(() => evalInt(fdFor(k), int(0n, Type.tuns64)));
        const sf = f(BUILTIN.bsf);
        expect(sf.diags).toEqual(["Error: `bsf(0)` is undefined"]);
        expect(sf.value.value).toBe(64n);
        const sr = f(BUILTIN.bsr);
        expect(sr.diags).toEqual(["Error: `bsr(0)` is undefined"]);
        expect(sr.value.value).toBe(127n);
    });

    test("bswap swaps 8 bytes for long/ulong and 4 bytes otherwise, keeping the argument type", () => {
        const u = evalInt(fdFor(BUILTIN.bswap), int(0x01020304n, Type.tuns32));
        expect(u.value).toBe(0x04030201n); // ldc2: 67305985u
        expect(u.type).toBe(Type.tuns32);
        const ul = evalInt(fdFor(BUILTIN.bswap), int(0x0102030405060708n, Type.tuns64));
        expect(ul.value).toBe(0x0807060504030201n); // ldc2: 578437695752307201LU
    });

    test("toPrec!float rounds to single precision; toPrec!double / toPrec!real keep the value", () => {
        const [f1, e1] = evalReal(BUILTIN.toPrecFloat, real(0.1));
        expect(f1).toBe("3fb99999a0000000"); // ldc2: toPrec!float(0.1)
        expect(e1.type).toBe(Type.tfloat32);
        expect(evalReal(BUILTIN.toPrecFloat, real(16777217.0))[1].value).toBe(16777216);
        const [d1, e2] = evalReal(BUILTIN.toPrecDouble, real(0.1));
        expect(d1).toBe("3fb999999999999a");
        expect(e2.type).toBe(Type.tfloat64);
        const [r1, e3] = evalReal(BUILTIN.toPrecReal, real(0.1));
        expect(r1).toBe("3fb999999999999a");
        expect(e3.type).toBe(Type.tfloat80);
    });

    test("yl2x / yl2xp1 compute y * log2(x) / y * log2(x + 1)", () => {
        expect(evalReal(BUILTIN.yl2x, real(8.0), real(2.0))[1].value).toBe(6);
        expect(evalReal(BUILTIN.yl2xp1, real(7.0), real(2.0))[1].value).toBe(6);
    });

    test("__ctfeWrite writes the string to stderr and returns the void CTFE value (builtin.d:234-247)", () => {
        // ldc2 on `enum x = { __ctfeWrite("hi"); return 0; }();` prints `hi` to stderr, with no newline.
        const se = new StringExp(loc, [0x68, 0x69]);
        se.type = Type.tstring;
        const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            expect(eval_builtin(loc, fdFor(BUILTIN.ctfeWrite), args(se))).toBe(CTFEExp.voidexp);
            expect(write.mock.calls).toEqual([["hi"]]);
        } finally {
            write.mockRestore();
        }
    });

    describe("the LDC_intrinsic leg of determine_builtin (builtin.d:93-127)", () => {
        /** A function as DtoCheckPragma leaves it for `pragma(LDC_intrinsic, name)` (gen/pragma.cpp:356-357). */
        const intrinsic = (name: string | null): FuncDeclaration => {
            const fd = fdIn(["ldc"], "intrinsics", "f");
            fd.llvmInternal = LDCPragma.LLVMintrinsic;
            fd.mangleOverride = name === null ? null : ds(name);
            return fd;
        };

        test("llvm.<name>.<suffix> selects the llvm_<name> member, whatever the suffix", () => {
            expect(isBuiltin(intrinsic("llvm.sqrt.f64"))).toBe(BUILTIN.llvm_sqrt);
            expect(isBuiltin(intrinsic("llvm.sin.f32"))).toBe(BUILTIN.llvm_sin);
            expect(isBuiltin(intrinsic("llvm.lround.i64.f64"))).toBe(BUILTIN.llvm_lround);
            expect(isBuiltin(intrinsic("llvm.ctpop.i#"))).toBe(BUILTIN.llvm_ctpop);
            expect(isBuiltin(intrinsic("llvm.expect.i1"))).toBe(BUILTIN.llvm_expect);
        });

        test("names without a second dot, shorter than 7, outside `llvm.`, or unknown are unimp", () => {
            expect(isBuiltin(intrinsic("llvm.sqrt"))).toBe(BUILTIN.unimp);   // no "." after index 6
            expect(isBuiltin(intrinsic("llvm.x"))).toBe(BUILTIN.unimp);      // length 6 < 7
            expect(isBuiltin(intrinsic("ldc.bitop.bt"))).toBe(BUILTIN.unimp);
            expect(isBuiltin(intrinsic("llvm.bogus.f64"))).toBe(BUILTIN.unimp);
            expect(isBuiltin(intrinsic(null))).toBe(BUILTIN.unimp);           // a null slice has length 0
        });

        test("the leg runs before the module lookup: an intrinsic named like core.math keeps the intrinsic", () => {
            const fd = fdIn(["core"], "math", "sqrt");
            fd.llvmInternal = LDCPragma.LLVMintrinsic;
            fd.mangleOverride = ds("llvm.sqrt.f32");
            expect(isBuiltin(fd)).toBe(BUILTIN.llvm_sqrt);
            expect(isBuiltin(fdIn(["core"], "math", "sqrt"))).toBe(BUILTIN.sqrt);
        });
    });

    describe("IN_LLVM evaluators (reached through eval_builtin; ldc2 `pragma(msg, llvm_*(...))` values)", () => {
        test("the float intrinsics take their type from the first parameter", () => {
            const e = eval_builtin(loc, fdFor(BUILTIN.llvm_sqrt, [Type.tfloat32], Type.tfloat32),
                args(real(4.0)))!.isRealExp()!;
            expect(e.value).toBe(2);
            expect(e.type).toBe(Type.tfloat32);
            const cs = eval_builtin(loc, fdFor(BUILTIN.llvm_copysign, [Type.tfloat32, Type.tfloat32], Type.tfloat32),
                args(real(3.0), real(-1.0)))!.isRealExp()!;
            expect(cs.value).toBe(-3);                                   // ldc2: -3.0F
            expect(cs.type).toBe(Type.tfloat32);
            const d = (k: BUILTIN, ...xs: number[]): number => eval_builtin(loc,
                fdFor(k, xs.map(() => Type.tfloat64), Type.tfloat64), args(...xs.map((x) => real(x))))!
                .isRealExp()!.value;
            expect(d(BUILTIN.llvm_rint, 2.5)).toBe(2);                   // ldc2: 2.0
            expect(d(BUILTIN.llvm_rint, 3.5)).toBe(4);                   // ldc2: 4.0
            expect(Object.is(d(BUILTIN.llvm_nearbyint, -0.5), -0)).toBe(true); // ldc2: -0.0
            expect(d(BUILTIN.llvm_minnum, NaN, 1.0)).toBe(1);            // ldc2: 1.0
            expect(d(BUILTIN.llvm_maxnum, 1.0, 2.0)).toBe(2);            // ldc2: 2.0
            expect(d(BUILTIN.llvm_fma, 0.1, 10.0, -1.0)).toBe(0);        // ldc2: 0.0
        });

        test("a template-instance parent supplies the type from tdtypes[0] (builtin.d:540-545)", () => {
            const fd = fdFor(BUILTIN.llvm_sin, [Type.tfloat64], Type.tfloat64);
            const ti = new TemplateInstance(loc, ident("llvm_sin"), null);
            ti.tdtypes.push(Type.tfloat32);
            fd.parent = ti as unknown as Dsymbol; // upcast cascade: TemplateInstance.deferred shadows Dsymbol.deferred
            const e = eval_builtin(loc, fd, args(real(0.5)))!.isRealExp()!;
            expect(bits(e.value)).toBe("3fdeaee8744b05f0");
            expect(e.type).toBe(Type.tfloat32); // not the parameter's double
        });

        test("llround / lround / llrint / lrint take the return type of the function", () => {
            const r = (k: BUILTIN, x: number, t: Type): IntegerExp =>
                evalInt(fdFor(k, [Type.tfloat64], t), real(x));
            expect(r(BUILTIN.llvm_llround, 2.5, Type.tint64).value).toBe(3n);  // ldc2: 3L
            expect(r(BUILTIN.llvm_llround, -2.5, Type.tint64).value).toBe(-3n); // ldc2: -3L
            const lr = r(BUILTIN.llvm_lround, 2.5, Type.tint32);                // alias of llround (:726)
            expect(lr.value).toBe(3n);                                           // ldc2: 3
            expect(lr.type).toBe(Type.tint32);
            expect(r(BUILTIN.llvm_llrint, 2.5, Type.tint64).value).toBe(2n);   // ldc2: 2L
            expect(r(BUILTIN.llvm_lrint, 3.5, Type.tint32).value).toBe(4n);    // alias of llrint (:717); ldc2: 4
        });

        test("bswap swaps within the parameter's width (ushort, uint, ulong)", () => {
            const s = evalInt(fdFor(BUILTIN.llvm_bswap, [Type.tuns16], Type.tuns16), int(0x0102n, Type.tuns16));
            expect(s.value).toBe(513n); // ldc2: cast(ushort)513u
            expect(s.type).toBe(Type.tuns16);
            expect(evalInt(fdFor(BUILTIN.llvm_bswap, [Type.tuns32], Type.tuns32), int(0x01020304n, Type.tuns32))
                .value).toBe(67305985n);
            expect(evalInt(fdFor(BUILTIN.llvm_bswap, [Type.tuns64], Type.tuns64),
                int(0x0102030405060708n, Type.tuns64)).value).toBe(578437695752307201n);
        });

        test("cttz / ctlz / ctpop / expect", () => {
            const u32 = (k: BUILTIN, x: bigint, zeroUndef = true): IntegerExp =>
                evalInt(fdFor(k, [Type.tuns32, Type.tbool], Type.tuns32), int(x, Type.tuns32),
                    int(zeroUndef ? 1n : 0n, Type.tbool));
            expect(u32(BUILTIN.llvm_cttz, 0x80n).value).toBe(7n);          // ldc2: 7u
            expect(u32(BUILTIN.llvm_cttz, 0n, false).value).toBe(32n);     // ldc2: 32u
            expect(u32(BUILTIN.llvm_ctlz, 1n).value).toBe(31n);            // ldc2: 31u
            expect(u32(BUILTIN.llvm_ctlz, 0n, false).value).toBe(32n);     // ldc2: 32u
            expect(evalInt(fdFor(BUILTIN.llvm_cttz, [Type.tuns64, Type.tbool], Type.tuns64),
                int(0x8000_0000_0000_0000n, Type.tuns64), int(1n, Type.tbool)).value).toBe(63n); // ldc2: 63LU
            expect(evalInt(fdFor(BUILTIN.llvm_ctlz, [Type.tuns64, Type.tbool], Type.tuns64),
                int(1n, Type.tuns64), int(1n, Type.tbool)).value).toBe(63n);                     // ldc2: 63LU
            expect(evalInt(fdFor(BUILTIN.llvm_ctlz, [Type.tuns16, Type.tbool], Type.tuns16),
                int(1n, Type.tuns16), int(1n, Type.tbool)).value).toBe(15n);                     // ldc2: 15u
            expect(evalInt(fdFor(BUILTIN.llvm_ctpop, [Type.tuns16], Type.tuns16), int(0xF0F0n, Type.tuns16))
                .value).toBe(8n);                                                                // ldc2: 8u
            expect(evalInt(fdFor(BUILTIN.llvm_ctpop, [Type.tuns64], Type.tuns64),
                int(0xFFFF_FFFF_FFFF_FFFFn, Type.tuns64)).value).toBe(64n);                     // ldc2: 64LU
            const ex = evalInt(fdFor(BUILTIN.llvm_expect, [Type.tint32, Type.tint32], Type.tint32),
                int(5n), int(5n));
            expect(ex.value).toBe(5n);                                                           // ldc2: 5
            expect(ex.type).toBe(Type.tint32);
        });

        test("cttz(0, true) reports the ldc2 diagnostic and still returns the bit width", () => {
            const r = withDiags(() => evalInt(fdFor(BUILTIN.llvm_cttz, [Type.tuns32, Type.tbool], Type.tuns32),
                int(0n, Type.tuns32), int(1n, Type.tbool)));
            expect(r.diags).toEqual(["Error: llvm.cttz.i#(0) is undefined"]);
            expect(r.value.value).toBe(32n); // ldc2: 32u after the error
        });

        test("an unsupported width reports an error and counts as 32 bits (builtin.d:571/:574)", () => {
            const r = withDiags(() => evalInt(fdFor(BUILTIN.llvm_ctlz, [Type.tuns8, Type.tbool], Type.tuns8),
                int(1n, Type.tuns8), int(1n, Type.tbool)));
            expect(r.diags).toEqual(["Error: unsupported type"]);
            expect(r.value.value).toBe(31n); // n = 32 from the error path; ubyte normalizes 31 unchanged
            const c = withDiags(() => evalInt(fdFor(BUILTIN.llvm_bswap, [Type.tint128], Type.tint128),
                int(1n, Type.tint64)));
            expect(c.diags).toEqual(["Error: cent/ucent not supported"]);
        });
    });

    describe("divergences from ldc2 inside CTFloat (root/ctfloat.ts), pinned as test.fails", () => {
        // Each states ldc2's folded bits (probed). JS Math (V8's fdlibm port) differs from the macOS libm ldc2
        // calls by one ULP on these inputs: the E1 escalation record.
        test.fails("cos(0.1) == 0x3fefd712f9a817c1", () => {
            expect(evalReal(BUILTIN.cos, real(0.1))[0]).toBe("3fefd712f9a817c1");
        });
        test.fails("tan(1.0) == 0x3ff8eb245cbee3a5", () => {
            expect(evalReal(BUILTIN.tan, real(1.0))[0]).toBe("3ff8eb245cbee3a5");
        });
        test.fails("log(3.0) == 0x3ff193ea7aad030b", () => {
            expect(evalReal(BUILTIN.log, real(3.0))[0]).toBe("3ff193ea7aad030b");
        });
        test.fails("expm1(1.0) == 0x3ffb7e151628aed3", () => {
            expect(evalReal(BUILTIN.expm1, real(1.0))[0]).toBe("3ffb7e151628aed3");
        });
        test.fails("pow(10.0, 1.37) == 0x40377139cbe1661f", () => {
            expect(evalReal(BUILTIN.pow, real(10.0), real(1.37))[0]).toBe("40377139cbe1661f");
        });
    });

    afterEach(() => {
        setDiagnosticHandler(null);
    });
});
