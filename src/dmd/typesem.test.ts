// Co-located test file for `src/dmd/typesem.ts` (10 §1.6b).
//
// dmd/typesem.d carries ZERO `unittest` blocks (verified: `grep -c unittest dmd/typesem.d` finds
// only two prose mentions at :5851-5852), so there is nothing to port under 10 §1. What follows is
// the thin artifact that section prescribes: ONE module-load smoke test, then one `test()` per
// risky RESOLVED CONSTRUCT of this retranslation, so a red gate names the pin that moved.
//
// Every pin below is constructible with the EXISTING harness conventions (`Loc._init()` +
// `Type._init()`, the §1.5 init snippet already used by typesem.basic.test.ts) — no new machinery,
// no fabricated state, and nothing that needs a `Scope`. Paths that need a real scope (resolve /
// dotExp / typeSemantic's aggregate arms) are deliberately NOT pinned here: the sema.* goal tests
// and the corpus are the honest oracle for those.
//
// The rung-era `typesem.basic.test.ts` stays as-is; it pins the `typeSemantic` basic-type arm and
// the cent/ucent rejection, and is the behavior floor this retranslation had to hold.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type, TypeFunction, Parameter, ParameterList } from "./mtype.js";
import { TY, MATCH, MODFlags, STC, LINK, VarArg } from "./astenums.js";
import { Loc } from "./location.js";
import { global } from "./globals.js";
import { ErrorSinkNull } from "./errorsink.js";
import {
    addStorageClass, alignsize, constConv, constOf, hasPointers, immutableOf, isZeroInit, merge,
    mutableOf, pointerTo, arrayOf, resolveNamedArgs, sharedOf, size, sizemask, stripDefaultArgs,
    toBasetype, Type_init } from "./typesem.js";
import { ArgumentList, Expression, IntegerExp } from "./expression.js";
import { Array as DArray } from "./root/array.js";
import { OutBuffer } from "./common/outbuffer.js";
import { Identifier } from "./identifier.js";
import { cstr, ds, dsToJs } from "../dstring.js";
import type { Expressions } from "./arraytypes.js";

beforeEach(() => {
    Loc._init();
    Type_init();
    global.errorSink = new ErrorSinkNull();
    global.errors = 0;
});

describe("typesem module surface", () => {
    // CONCERN: load order. This retranslation deleted the rung-era `TypeSemanticVisitor` class and
    // with it typesem.ts's runtime edge to visitor/index.ts (01 Rule 4.7), while adding value edges
    // to denum/parse/opover/… (Rule 4.3). Importing the module here executes its whole top level;
    // a `Class extends value undefined` regression from a new SCC value edge fails HERE, loudly.
    it("loads and exposes the free-function surface (no visitor class)", () => {
        expect(typeof size).toBe("function");
        expect(typeof merge).toBe("function");
        expect(typeof hasPointers).toBe("function");
    });
});

describe("size / sizemask / alignsize — the numeric-domain split (09 §0/§8, §1.3.1)", () => {
    // CONCERN: `size()` returns D's `uinteger_t`, so the port's carrier is `bigint` END TO END —
    // the SIZE_INVALID sentinel (0xFFFF_FFFF_FFFF_FFFFn) cannot survive a `Number(...)` round-trip.
    // ldc2 ground truth: int.sizeof == 4, long.sizeof == 8, void.sizeof == 1, bool.sizeof == 1.
    it("size() answers in the bigint domain with the ldc2-verified widths", () => {
        expect(size(Type.tint32, Loc.initial)).toBe(4n);
        expect(size(Type.tint64, Loc.initial)).toBe(8n);
        expect(size(Type.tvoid, Loc.initial)).toBe(1n);
        expect(size(Type.tbool, Loc.initial)).toBe(1n);
        // D declares `size(Type)` (typesem.d:2896) and `size(Type, Loc)` (:2901) as an ARITY-
        // distinct prefix pair, folded into one default-arg function (04 §1A): both spellings agree.
        expect(size(Type.tint32)).toBe(size(Type.tint32, Loc.initial));
    });

    // CONCERN: `alignsize` is D `uint` -> the NUMBER domain, sitting right beside a bigint `size`.
    // The two must not drift into one carrier (the litmus of 09 §0).
    it("alignsize() answers in the number domain", () => {
        expect(alignsize(Type.tint32)).toBe(4);
        expect(alignsize(Type.tint64)).toBe(8);
        expect(typeof alignsize(Type.tint32)).toBe("number");
        expect(typeof size(Type.tint32, Loc.initial)).toBe("bigint");
    });

    // CONCERN: `sizemask` (typesem.d:208) folds a size into an all-ones mask in the bigint domain.
    // int -> 0xFFFF_FFFF, long -> 0xFFFF_FFFF_FFFF_FFFF: the 64-bit case is exactly the value a
    // `number` cannot hold, so this pin dies the moment the carrier is narrowed.
    it("sizemask() stays exact at 64 bits", () => {
        expect(sizemask(Type.tint32)).toBe(0xFFFF_FFFFn);
        expect(sizemask(Type.tint64)).toBe(0xFFFF_FFFF_FFFF_FFFFn);
    });
});

describe("merge — S5 dispatch and the deco intern table", () => {
    // CONCERN: S5 is one of the twelve Idiom-B dispatch switches this retranslation emits IN FULL
    // (13 §7.5). Its contract is interning: merging an already-deco'd type yields the SAME object.
    // ldc2 ground truth: int.mangleof == "i", long.mangleof == "l".
    it("returns the interned singleton for an already-merged basic type", () => {
        expect(merge(Type.tint32)).toBe(Type.tint32);
        expect(merge(Type.tint64)).toBe(Type.tint64);
    });

    // CONCERN: the derived-type constructors (pointerTo/arrayOf/constOf/…) route through merge and
    // cache in `Type.mcache`, so a second call must hand back the same node, not a fresh one.
    it("derived-type constructors cache through merge", () => {
        expect(pointerTo(Type.tint32)).toBe(pointerTo(Type.tint32));
        expect(arrayOf(Type.tint32)).toBe(arrayOf(Type.tint32));
        expect(constOf(Type.tint32)).toBe(constOf(Type.tint32));
    });
});

describe("the makeXxx / mod family — one free function branching inside (04 §6, no override family)", () => {
    // CONCERN: the mtype.ts carry-over index modelled `makeConst`/`constOf`/… as per-subclass
    // OVERRIDE families. The faithful 1.43 form is a SINGLE free function whose body branches on
    // `isTypeNext()`/`isTypeBasic()`; this wave unwinds the re-home. The observable contract is the
    // MOD bits, so pin those.
    it("constOf / immutableOf / sharedOf set exactly D's MOD bits", () => {
        expect(constOf(Type.tint32).mod).toBe(MODFlags.const_);
        expect(immutableOf(Type.tint32).mod).toBe(MODFlags.immutable_);
        expect(sharedOf(Type.tint32).mod).toBe(MODFlags.shared_);
    });

    // CONCERN: the VERIFIED 1.43 drift the scout sheet flagged on `mutableOf` (typesem.d:8543) —
    // 1.42 read `mcache.swcto` in the const+shared+wild branch, 1.43 always reads `mcache.sto`.
    // The observable invariant either way: mutableOf strips `const` and is idempotent.
    it("mutableOf strips const and is idempotent", () => {
        const c = constOf(Type.tint32);
        expect(c.mod).toBe(MODFlags.const_);
        expect(mutableOf(c)).toBe(Type.tint32);
        expect(mutableOf(Type.tint32)).toBe(Type.tint32);
    });

    // CONCERN: S12 (addStorageClass) is a dispatch switch whose non-function arms fold STC -> MOD.
    it("addStorageClass folds STC.const_ into the MOD bits (S12 default arm)", () => {
        expect(addStorageClass(Type.tint32, STC.const_).mod).toBe(MODFlags.const_);
        expect(addStorageClass(Type.tint32, STC.none)).toBe(Type.tint32);
    });
});

describe("constConv / hasPointers / isZeroInit — S3, S1, S9 dispatch arms", () => {
    // CONCERN: S3's `default -> visitType` arm. D: identical types convert exactly; adding `const`
    // on the target is a MATCH.constant conversion; unrelated basics do not convert.
    it("constConv answers exact / constant / nomatch", () => {
        expect(constConv(Type.tint32, Type.tint32)).toBe(MATCH.exact);
        expect(constConv(Type.tint32, constOf(Type.tint32))).toBe(MATCH.constant);
        expect(constConv(Type.tint32, Type.tint64)).toBe(MATCH.nomatch);
    });

    // CONCERN: S1 has NINE named arms plus `default`. Pin one arm from each side of the split so a
    // dropped arm (the 13 §7.5 silent-miscompile class) cannot pass unnoticed.
    it("hasPointers is false for scalars and true for the indirection arms", () => {
        expect(hasPointers(Type.tint32)).toBe(false);
        expect(hasPointers(Type.tvoid)).toBe(false);
        expect(hasPointers(pointerTo(Type.tint32))).toBe(true);   // case Tpointer
        expect(hasPointers(arrayOf(Type.tint32))).toBe(true);     // case Tarray
    });

    // CONCERN: S9's stacked arm `Taarray|Tarray|Treference|Tdelegate|Tclass|Tpointer -> return true`
    // versus the basic-type default. ldc2: `int.init == 0` (zero-init), `char.init == 0xFF` (not).
    it("isZeroInit separates the zero-init basics from char/float and the reference arms", () => {
        expect(isZeroInit(Type.tint32, Loc.initial)).toBe(true);
        expect(isZeroInit(Type.tchar, Loc.initial)).toBe(false);   // char.init is 0xFF (09 §1.0)
        expect(isZeroInit(Type.tfloat64, Loc.initial)).toBe(false); // float.init is NaN
        expect(isZeroInit(pointerTo(Type.tint32), Loc.initial)).toBe(true);
    });
});

describe("toBasetype / stripDefaultArgs — identity on the paths with nothing to strip", () => {
    // CONCERN: `toBasetype` is the entry every other arm funnels through; on a canonical basic type
    // it is the identity, and it must not lose the mod bits of a qualified one.
    it("toBasetype is the identity on basics and preserves MOD", () => {
        expect(toBasetype(Type.tint32)).toBe(Type.tint32);
        expect(toBasetype(constOf(Type.tint32)).mod).toBe(MODFlags.const_);
    });

    // CONCERN: `stripDefaultArgs` (typesem.d:9448, behind D's `private:`) is emitted WITHOUT TS
    // `private` (01 Rule 2.5) precisely so siblings — and this pin — can reach it. Its documented
    // contract is "returns the same node when there is nothing to strip".
    it("stripDefaultArgs returns the same node for a non-function type and passes null through", () => {
        expect(stripDefaultArgs(Type.tint32)).toBe(Type.tint32);
        expect(stripDefaultArgs(null)).toBe(null);
    });
});

describe("TY coverage of the dispatch switches (13 §7.5 — arms are emitted IN FULL)", () => {
    // CONCERN: an Idiom-B arm that was never written routes to `default:` and miscompiles silently.
    // These calls exercise the arm SELECTION for the tags reachable without a Scope; the point of
    // the pin is that none of them throws an "unhandled tag" or falls to a wrong arm.
    it("every scope-free basic/derived tag reaches a real arm", () => {
        const cases: Array<[Type, TY]> = [
            [Type.tint32, TY.Tint32],
            [Type.tvoid, TY.Tvoid],
            [pointerTo(Type.tint32), TY.Tpointer],
            [arrayOf(Type.tint32), TY.Tarray],
            [constOf(Type.tint32), TY.Tint32],
        ];
        for (const [t, ty] of cases) {
            expect(t.ty).toBe(ty);
            expect(typeof hasPointers(t)).toBe("boolean");
            expect(typeof isZeroInit(t, Loc.initial)).toBe("boolean");
            expect(typeof size(t, Loc.initial)).toBe("bigint");
        }
    });
});

describe("resolveNamedArgs — the `Expressions.zero()` default-dependence (08 §2.0a, 09 §1.0)", () => {
    // CONCERN: D's `newArgs.zero()` (typesem.d:2080) fills all `nParams` slots with
    // `Expression.init` == null, and BOTH loops that follow READ those slots — the "assigned twice"
    // guard at typesem.d:2116 and the missing-argument scan at :2124. The port's `Array.zero()` is a
    // documented NO-OP (there is no generic `T.init`), so the call site must do the fill itself.
    // Without it every slot reads `undefined`, `undefined !== null` is true, and a PLAIN POSITIONAL
    // call is rejected with `parameter `a` assigned twice`. That is the exact bug this pin locks
    // out: it was live in the tree and is what the sema.func / sema.rung3 / sema.callexp goal tests
    // were failing on. Reproduced against `Array.zero()` first, then fixed at this call site.
    it("a plain positional call re-orders into a full argument list (no spurious `assigned twice`)", () => {
        const params = new DArray<Parameter | null>();
        params.push(new Parameter(Loc.initial, STC.none, Type.tint32, Identifier.idPool(ds("a")), null, null));
        const tf = new TypeFunction(new ParameterList(params, VarArg.none), Type.tint32,
            LINK.d, STC.none);

        const args: Expressions = new DArray<Expression | null>();
        args.push(IntegerExp.literal(7));

        const buf = new OutBuffer();
        const out = resolveNamedArgs(tf, new ArgumentList(args, null), buf);

        // The D contract: one parameter, one positional argument -> a one-slot result holding it,
        // and NOTHING appended to the error buffer.
        expect(out).not.toBe(null);
        expect(out!.length).toBe(1);
        expect(out!.opIndex(0)).toBe(args.opIndex(0));
        expect(buf.length()).toBe(0);
    });

    // CONCERN: the same fill is what lets the MISSING-argument scan see an empty slot as empty.
    // Zero arguments against one no-default parameter must be rejected, not silently accepted.
    it("a missing argument for a no-default parameter is still rejected", () => {
        const params = new DArray<Parameter | null>();
        params.push(new Parameter(Loc.initial, STC.none, Type.tint32, Identifier.idPool(ds("a")), null, null));
        const tf = new TypeFunction(new ParameterList(params, VarArg.none), Type.tint32,
            LINK.d, STC.none);

        // RE-PIN (10 §1.8 rule 7): this was a pinned wall on `TODO-BODY: parameterToChars`. That
        // wall is swept — `parameterToChars` (dmd/hdrgen.d:3634) is live at hdrgen.ts:306 — so the
        // pin becomes a BEHAVIOUR pin on what D's missing-argument branch actually produces
        // (dmd/typesem.d:2134-2136): `null` returned, and the diagnostic written to the buffer with
        // D's own format string `"missing argument for parameter #%d: `%s`"` rendered over
        // `parameterToChars(parameterList[0], tf, false)` == "int a". Reaching that branch at all is
        // still the original proof: the scan saw slot 0 as EMPTY, which is only true because the
        // fill put `null` there, not `undefined`.
        const buf = new OutBuffer();
        const out = resolveNamedArgs(tf, new ArgumentList(null, null), buf);
        expect(out).toBe(null);
        // `peekChars` keeps OutBuffer's 0 terminator in the slice; `cstr` truncates at it (08 §11).
        expect(dsToJs(cstr(buf.peekChars()))).toBe("missing argument for parameter #1: `int a`");
    });
});

describe("callMatch's argument-mismatch line (typesem.d:2340, funcsem.d:2120)", () => {
    // getParamError returns an `extractChars()` buffer carrying the NUL. D writes it through
    // `writestring(const(char)*)` (typesem.d:2340) and passes it as the `const(char)*` format of
    // errorSupplemental (funcsem.d:2120); both stop at the NUL, and the TS put two NULs into the message.
    // Pinned against ldc2 1.43.0 (`ldc2 -o- r.d`).
    it("carries no NUL (ldc2: r.d)", async () => {
        const { Parser } = await import("./parse.js");
        const { ErrorSinkCompiler, setDiagnosticHandler } = await import("./errors.js");
        const { moduleFromParse } = await import("./dmodule.js");
        const { runSemantic } = await import("./dsymbolsem.js");
        const { dmdformat } = await import("./root/dmdformat.js");
        const { initSemaHarness } = await import("../sema-harness.js");
        const { dsToJs } = await import("../dstring.js");
        initSemaHarness();
        global.errorSink = new ErrorSinkCompiler();
        const diags: string[] = [];
        setDiagnosticHandler((_loc, _color, header, messageFormat, args) => {
            diags.push(dsToJs(header) + dsToJs(dmdformat(messageFormat, [...args])));
            return true;
        });
        try {
            const text = "module p;\nstruct S { void f(int* x) {} }\nvoid main(){ S s; s.f(1); }\n";
            const src = new Uint8Array(text.length + 1); // NUL-terminated: the lexer scans to the sentinel
            for (let i = 0; i < text.length; i++) src[i] = text.charCodeAt(i);
            const p = new Parser(null, null, src, false, global.errorSink, null, false);
            p.nextToken();
            runSemantic(moduleFromParse(p.parseModule(), p.md));
        } finally {
            setDiagnosticHandler(null);
        }
        expect(diags).toEqual([
            "Error: function `p.S.f(int* x)` is not callable using argument types `(int)`",
            "       cannot pass argument `1` of type `int` to parameter `int* x`",
        ]);
    });

    // Under a gag getParamError answers null (typesem.d:2664), and D's `writestring(const(char)*)` writes
    // nothing for it (common/outbuffer.d:260 `if (!s) return;`); the port took `cstr` of the null and died
    // with a TypeError (15 corpus tests: test69, testVRP, nulltype, test9176, ...). ldc2 1.43.0 compiles this
    // source with no output and exit 0 (`ldc2 -c -o- g.d`).
    it("is empty, not a crash, when the call is speculative (ldc2: g.d)", async () => {
        const { Parser } = await import("./parse.js");
        const { ErrorSinkCompiler, setDiagnosticHandler } = await import("./errors.js");
        const { moduleFromParse } = await import("./dmodule.js");
        const { runSemantic } = await import("./dsymbolsem.js");
        const { dmdformat } = await import("./root/dmdformat.js");
        const { initSemaHarness } = await import("../sema-harness.js");
        initSemaHarness();
        global.errorSink = new ErrorSinkCompiler();
        const diags: string[] = [];
        setDiagnosticHandler((_loc, _color, header, messageFormat, args) => {
            diags.push(dsToJs(header) + dsToJs(dmdformat(messageFormat, [...args])));
            return true;
        });
        try {
            const text = "module g;\nvoid foo(int* x) {}\nstatic assert(!__traits(compiles, foo(1)));\n" +
                "static assert(!is(typeof(foo(1))));\n";
            const src = new Uint8Array(text.length + 1); // NUL-terminated: the lexer scans to the sentinel
            for (let i = 0; i < text.length; i++) src[i] = text.charCodeAt(i);
            const p = new Parser(null, null, src, false, global.errorSink, null, false);
            p.nextToken();
            runSemantic(moduleFromParse(p.parseModule(), p.md));
        } finally {
            setDiagnosticHandler(null);
        }
        expect(diags).toEqual([]);
        expect(global.errors).toBe(0);
    });
});

describe("parameterStorageClass — `fparam != p` is Parameter.opEquals (typesem.d:8357, mtype.d:2581)", () => {
    // ORACLE: `ldmd2 -c -o- -vcg-ast -preview=dip1000 scopepure.d` (ldc2 1.43.0) on SRC: exit 0, no output, and
    // EXPECTED is its .cg byte for byte. D compares the other `ref` parameter with `p` through
    // Parameter.opEquals (storage class and type), so in a pure function two `ref int[]` parameters do not
    // bail each other and both are `scope`: g1's `scope` x is accepted, and ce's `source` passes `value` on as
    // `scope`, so the constructor's array literal argument is lowered to a stack temporary (expressionsem.d:4582),
    // the std.variant MISMATCH-CG. An identity test bailed at the second parameter and did neither.
    const SRC = "module scopepure;\nvoid mc(void* a, scope void* b) @system pure nothrow;\n"
        + "void ce(S, T)(ref S source, ref T target) @system { mc(&target, &source); }\n"
        + "struct V\n{\n    int[] store;\n    this(T)(T value) { ce(value, store); }\n}\n"
        + "void f() { V v = [2, 2]; }\nvoid c1(ref int[] source, ref int[] t) @trusted pure nothrow;\n"
        + "void g1(scope int[] x) @safe { int[] y; c1(x, y); }\n";
    const EXPECTED = "module scopepure;\nimport object;\npure nothrow @system void mc(void* a, scope void* b);\n"
        + "@system void ce(S, T)(ref S source, ref T target)\n{\n\tmc(&target, &source);\n}\n"
        + "struct V\n{\n\tint[] store;\n\tthis(T)(T value)\n\t{\n\t\tce(value, store);\n\t}\n}\n"
        + "void f()\n{\n\tV v = v = 0 , v.__ctor(((int[2] __arrayliteral_on_stack3 = [2, 2];) , "
        + "cast(int[])__arrayliteral_on_stack3));\n}\n"
        + "pure nothrow @trusted void c1(ref int[] source, ref int[] t);\n"
        + "@safe void g1(scope int[] x)\n{\n\tint[] y = null;\n\tc1(x, y);\n}\n"
        + "RTInfo!(V)\n{\n\tenum immutable(ulong)* RTInfo = & RTInfoImpl;\n\n}\n"
        + "RTInfoImpl!([16LU, 2LU])\n{\n\timmutable immutable(ulong[2]) RTInfoImpl = [16LU, 2LU];\n\n}\n"
        + "__ctor!(int[])\n{\n\tpure nothrow @system this(int[] value)\n\t{\n\t\tce(value, this.store);\n"
        + "\t\treturn this;\n\t}\n\n}\n"
        + "ce!(int[], int[])\n{\n\tpure nothrow @system void ce(ref int[] source, ref int[] target)\n\t{\n"
        + "\t\tmc(cast(void*)&target, cast(void*)&source);\n\t}\n\n}\n";

    it("two `ref` parameters of one type and storage class are both `scope` in a pure function", async () => {
        const dir = mkdtempSync(join(tmpdir(), "djs-scopepure-"));
        const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        const ewrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            const file = join(dir, "scopepure.d");
            writeFileSync(file, SRC);
            // A fresh module registry, as a new ldmd2 process starts from load-time globals (djs.test.ts).
            vi.resetModules();
            const { djsMain } = await import("../djs.js");
            expect(djsMain(["-c", "-o-", "-vcg-ast", "-preview=dip1000", file])).toBe(0);
            expect(write).not.toHaveBeenCalled();
            expect(ewrite).not.toHaveBeenCalled();
            expect(readFileSync(`${file}.cg`, "utf8")).toBe(EXPECTED);
        } finally {
            write.mockRestore();
            ewrite.mockRestore();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);
});

/** One ldc2-shaped `-c -o-` compile through the shim in a fresh module registry (a new ldmd2 process starts from
 * load-time globals, djs.test.ts); returns the exit code and everything written to stderr. */
async function shimCompile(file: string): Promise<{ code: number; stderr: string }> {
    vi.resetModules();
    const { djsMain } = await import("../djs.js");
    const err: string[] = [];
    const e = vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array): boolean => {
        err.push(typeof c === "string" ? c : new TextDecoder().decode(c));
        return true;
    });
    try {
        return { code: djsMain(["-c", "-o-", file]), stderr: err.join("") };
    } finally {
        e.mockRestore();
    }
}

// dmd/typesem.d:3930 calls `cAdjustParamType` (importc.d:48) on every parameter; outside a C file it is the
// identity, so a D static-array parameter keeps its type (the C adjustment would make it `int*`, without
// `.length`). Expected: ldc2 1.43.0 `-c -o-` on the same file, exit 0 and no output.
describe("typeSemantic of a function type — cAdjustParamType outside ImportC (typesem.d:3930)", () => {
    it("a D `int[3]` parameter stays `int[3]`", async () => {
        const dir = mkdtempSync(join(tmpdir(), "djs-cadjust-"));
        try {
            const f = join(dir, "pa.d");
            writeFileSync(f, "module pa;\nvoid f(int[3] a) { static assert(a.length == 3); "
                + "static assert(is(typeof(a) == int[3])); }\nvoid g(int function(int) h) {}\n");
            expect(await shimCompile(f)).toEqual({ code: 0, stderr: "" });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);
});
