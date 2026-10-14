// Co-located tests for `src/dmd/safe.ts`.
//
// dmd/safe.d has ZERO `unittest` blocks (verified: `grep -c unittest dmd/safe.d` -> 0), so this is the
// thin test file of 10 §1.6b: one module-load smoke test plus one behaviour pin per concern of the
// whole-file translation. Diagnostic texts and accept/reject verdicts come from ldc2 1.43.0 probes
// (`ldc2 -c -o- x.d`) quoted next to the pin, except where a comment says the text follows from the D
// format literal alone (a gagged message, or a format no probe emits verbatim).
//
// Not pinned here, and why:
//   * `checkUnsafeAccess` beyond its early-out: its unsafe arms need a sized aggregate with overlapped
//     or misaligned fields built by `determineSize`, which only the sema driver produces; the corpus
//     is the oracle for those (10 §1.6b). sema.fieldaccess.test.ts already drives its readonly exit.
//   * `isSafeCast`'s class arm: it needs semantic-run `ClassDeclaration`s.
//
// Harness: the §1.5 init snippet (`initSemaHarness`) and `globalScope()` as in escape.test.ts; message
// text is captured with `setDiagnosticHandler`, the sema.fieldaccess.test.ts convention, behind the
// compiler's own `ErrorSinkCompiler` so both D routes (`.error` and `global.errorSink.error`) land there.

import "./parse.js"; // module-graph ROOT for a core-SCC test file (10 §1.5)

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
    checkUnsafeAccess, checkUnsafeDotExp, isSafe, isSafeBypassingInference, isSafeCast, isSaferD, isTrusted,
    setFunctionToUnsafe, setUnsafe, setUnsafeCall, setUnsafePreview, setUnsafePreviewScopeVar,
} from "./safe.js";
import { initSemaHarness } from "../sema-harness.js";
import { IntegerExp, Expression } from "./expression.js";
import { Type, TypeFunction, ParameterList, Parameter, DotExpFlag } from "./mtype.js";
import { VarDeclaration } from "./declaration.js";
import { FuncDeclaration } from "./func.js";
import { ForeachStatement } from "./statement.js";
import { STC, LINK, TRUST, MATCH } from "./astenums.js";
import { TOK } from "./tokens.js";
import { Loc } from "./location.js";
import { Identifier } from "./identifier.js";
import { Id } from "./id.js";
import { global, FeatureState } from "./globals.js";
import { ErrorSinkCompiler, setDiagnosticHandler } from "./errors.js";
import { moduleFromParse } from "./dmodule.js";
import { Scope } from "./dscope.js";
import { Array as DArray } from "./root/array.js";
import { dmdformat } from "./root/dmdformat.js";
import { ds, dsToJs } from "../dstring.js";
import { arrayOf, constOf, pointerTo } from "./typesem.js";
import { implicitConvToType } from "./dcast.js";
import { scopeCreateGlobal } from "./dsymbolsem.js";

import type { Dsymbol } from "./dsymbol.js";
import type { Dsymbols, Parameters } from "./arraytypes.js";
import type { DString } from "../dstring.js";

let diags: string[] = [];

beforeEach(() => {
    initSemaHarness();
    global.errorSink = new ErrorSinkCompiler();
    diags = [];
    setDiagnosticHandler((_loc, _color, header, messageFormat, args) => {
        diags.push(dsToJs(header) + dsToJs(dmdformat(messageFormat, [...args])));
        return true;
    });
});

afterEach(() => {
    setDiagnosticHandler(null);
});

function id(name: string): Identifier {
    return Identifier.idPool(ds(name));
}

/** A global `Scope` over a bare module — the sema-test convention (escape.test.ts, sema.var.test.ts). */
function globalScope(): Scope {
    const members: Dsymbols = new DArray<Dsymbol | null>();
    return scopeCreateGlobal(moduleFromParse(members, null), global.errorSink!);
}

/** `void name()` with the given trust, as a `FuncDeclaration` shell (no semantic run). */
function func(name: string, trust: TRUST): FuncDeclaration {
    const ps: Parameters = new DArray<Parameter | null>();
    const tf = new TypeFunction(new ParameterList(ps), Type.tvoid, LINK.d, STC.none);
    tf.trust = trust;
    return new FuncDeclaration(Loc.initial, Loc.initial, id(name), STC.none, tf);
}

/** A function whose `@safe`-ty is still being inferred (dmd sets `safetyInprocess` in funcsem). */
function inferring(name: string): FuncDeclaration {
    const fd = func(name, TRUST.default_);
    fd.safetyInprocess = true;
    return fd;
}

function inFunc(fd: FuncDeclaration): Scope {
    const sc = globalScope();
    sc.func = fd;
    return sc;
}

const trustOf = (fd: FuncDeclaration): TRUST => fd.type!.toTypeFunction().trust;

describe("safe.ts module load", () => {
    it("loads and exposes the safe.d entry points", () => {
        // 10 §1.5: names a core-SCC load-order regression instead of a collect-time crash elsewhere.
        expect(typeof Expression).toBe("function");
        for (const f of [checkUnsafeAccess, isSafeCast, checkUnsafeDotExp, isSaferD, isSafe,
            isSafeBypassingInference, isTrusted, setFunctionToUnsafe, setUnsafeCall, setUnsafe,
            setUnsafePreview, setUnsafePreviewScopeVar])
            expect(typeof f).toBe("function");
    });

    it("checkUnsafeAccess: anything but a DotVarExp is not an access to check (safe.d:62-63)", () => {
        const sc = inFunc(func("f", TRUST.safe));
        expect(checkUnsafeAccess(sc, new IntegerExp(Loc.initial, 1n, Type.tint32), false, true)).toBe(false);
        expect(diags).toEqual([]);
    });
});

describe("setUnsafe (dmd/safe.d:469/:475)", () => {
    it("is permissive inside typeof(...) and debug scopes, and leaves inference alone (safe.d:478-482)", () => {
        // ldc2: `@safe void m(){ ...; debug { p++; } auto t = typeof(p + 1).sizeof; }` compiles (-d-debug).
        const fd = inferring("f");
        const sc = inFunc(fd);
        sc.intypeof = 1;
        expect(setUnsafe(sc, false, Loc.initial, ds("pointer arithmetic"))).toBe(false);
        sc.intypeof = 0;
        sc.debug_ = true;
        expect(setUnsafe(sc, false, Loc.initial, ds("pointer arithmetic"))).toBe(false);
        expect(fd.safetyInprocess).toBe(true);
        expect(diags).toEqual([]);
    });

    it("rejects a `@safe` variable initializer at module scope (safe.d:488-492)", () => {
        // ldc2: `@safe int* p = &x + 1;` -> "Error: pointer arithmetic can't initialize `@safe` variable `p`"
        const sc = globalScope();
        sc.varDecl = new VarDeclaration(Loc.initial, Type.tvoidptr, id("p"), null, STC.safe);
        expect(setUnsafe(sc, false, Loc.initial, ds("pointer arithmetic"))).toBe(true);
        expect(diags).toEqual(["Error: pointer arithmetic can't initialize `@safe` variable `p`"]);
    });

    it("infers a plain module-scope variable `@system`, and leaves a `@trusted` one untouched (safe.d:494-498)", () => {
        const sc = globalScope();
        const v = new VarDeclaration(Loc.initial, Type.tvoidptr, id("p"), null, STC.none);
        sc.varDecl = v;
        expect(setUnsafe(sc, false, Loc.initial, ds("pointer arithmetic"))).toBe(false);
        expect(v.storage_class & STC.system).toBe(STC.system);
        expect(v.systemInferred).toBe(true);

        const t = new VarDeclaration(Loc.initial, Type.tvoidptr, id("q"), null, STC.trusted);
        sc.varDecl = t;
        expect(setUnsafe(sc, false, Loc.initial, ds("pointer arithmetic"))).toBe(false);
        expect(t.storage_class & STC.system).toBe(0n);
        expect(t.systemInferred).toBe(false);
        expect(diags).toEqual([]);
    });

    it("is an error in a `@safe` function (safe.d:517 -> reportSafeError)", () => {
        // ldc2: `@safe void k(int* p) { p++; }` -> "Error: pointer arithmetic is not allowed in a `@safe` function"
        const sc = inFunc(func("k", TRUST.safe));
        expect(setUnsafe(sc, false, Loc.initial, ds("pointer arithmetic"))).toBe(true);
        expect(diags).toEqual(["Error: pointer arithmetic is not allowed in a `@safe` function"]);
    });

    it("gag suppresses the `@safe` message but not the verdict (safe.d:397)", () => {
        const sc = inFunc(func("k", TRUST.safe));
        expect(setUnsafe(sc, /*gag:*/ true, Loc.initial, ds("pointer arithmetic"))).toBe(true);
        expect(diags).toEqual([]);
    });

    it("reports under -preview=safer but returns false, the function not being `@safe` (safe.d:405/:523)", () => {
        // ldc2 -preview=safer: `void k(int* p) { p++; }` ->
        // "Error: pointer arithmetic is not allowed in a function with default safety with `-preview=safer`"
        const fd = func("k", TRUST.default_);
        fd.saferD = true;
        expect(isSaferD(fd)).toBe(true);
        expect(setUnsafe(inFunc(fd), false, Loc.initial, ds("pointer arithmetic"))).toBe(false);
        expect(diags).toEqual(
            ["Error: pointer arithmetic is not allowed in a function with default safety with `-preview=safer`"]);
    });

    it("commits an inferring function to `@system` and records the violation silently (safe.d:517 -> :385)", () => {
        // ldc2: `void n()() { int* p; p++; }` called from `@safe` reports the stored action later:
        // "and pointer arithmetic makes it fail to infer `@safe`".
        const fd = inferring("n");
        expect(setUnsafe(inFunc(fd), false, Loc.initial, ds("pointer arithmetic"))).toBe(false);
        expect(fd.safetyInprocess).toBe(false);
        expect(trustOf(fd)).toBe(TRUST.system);
        expect(dsToJs(fd.safetyViolation!.action!)).toBe("pointer arithmetic");
        expect(diags).toEqual([]);
    });

    it("inside the root __traits(compiles) scope only a `@safe` function errors (safe.d:504-514)", () => {
        // ldc2: `@safe void m(){ int* p; enum b = __traits(compiles, p + 1); static assert(!b); }` compiles.
        const safeSc = inFunc(func("m", TRUST.safe));
        safeSc.traitsCompiles = true;
        const before = global.errors;
        expect(setUnsafe(safeSc, false, Loc.initial, ds("pointer arithmetic"))).toBe(true);
        expect(global.errors).toBe(before + 1);
        // Not from a probe: D gags this message (safe.d:508), so ldc2 never prints it. The text follows
        // from the format literal at safe.d:511 with the action "pointer arithmetic".
        expect(diags).toEqual(["Error: pointer arithmetic is not allowed in a `@safe` function"]);

        // An inferring function is asked WITHOUT forcing its inference (isSafeBypassingInference).
        const fd = inferring("g");
        const sc = inFunc(fd);
        sc.traitsCompiles = true;
        expect(setUnsafe(sc, false, Loc.initial, ds("pointer arithmetic"))).toBe(false);
        expect(fd.safetyInprocess).toBe(true);
    });
});

describe("setFunctionToUnsafe / isSafe / isTrusted / isSafeBypassingInference (dmd/safe.d:341-437)", () => {
    it("isSafe/isTrusted commit an inferring function; the bypassing form does not (safe.d:341/:348/:353)", () => {
        const a = inferring("a");
        expect(isSafeBypassingInference(a)).toBe(false);
        expect(a.safetyInprocess).toBe(true);
        expect(isSafe(a)).toBe(false);
        expect(a.safetyInprocess).toBe(false);
        expect(trustOf(a)).toBe(TRUST.system);

        const b = inferring("b");
        expect(isTrusted(b)).toBe(false);
        expect(trustOf(b)).toBe(TRUST.system);

        expect(isSafeBypassingInference(func("c", TRUST.safe))).toBe(true);
        expect(isTrusted(func("d", TRUST.trusted))).toBe(true);
    });

    it("recurses into the function enclosing a foreach body (safe.d:430)", () => {
        const outer = inferring("outer");
        const body = inferring("__foreachbody");
        const fes = new ForeachStatement(Loc.initial, TOK.foreach_, null, null, null, Loc.initial);
        fes.func = outer;
        body.fes = fes;
        expect(setFunctionToUnsafe(body)).toBe(true);
        expect(trustOf(body)).toBe(TRUST.system);
        expect(outer.safetyInprocess).toBe(false);
        expect(trustOf(outer)).toBe(TRUST.system);
    });

    it("a non-inferring function answers by its declared trust (safe.d:433-435)", () => {
        expect(setFunctionToUnsafe(func("s", TRUST.safe))).toBe(true);
        expect(setFunctionToUnsafe(func("t", TRUST.trusted))).toBe(false);
        expect(setFunctionToUnsafe(func("d", TRUST.default_))).toBe(false);
    });
});

describe("setUnsafeCall (dmd/safe.d:447)", () => {
    it("a `@safe` caller errs silently here; an inferring caller records the callee (safe.d:451)", () => {
        const f = func("f", TRUST.system);
        expect(setUnsafeCall(func("g", TRUST.safe), f)).toBe(true);
        expect(diags).toEqual([]);   // the message is expressionsem's (checkSafety), not this file's

        const h = inferring("h");
        expect(setUnsafeCall(h, f)).toBe(false);
        expect(trustOf(h)).toBe(TRUST.system);
        expect(h.safetyViolation!.fd).toBe(f);
        expect(h.safetyViolation!.action).toBe(null);
    });
});

describe("setUnsafePreview (dmd/safe.d:547/:553)", () => {
    it("`disabled` does nothing; `enabled` is setUnsafe (safe.d:561-564)", () => {
        const fd = func("k", TRUST.safe);
        const msg = ds("pointer arithmetic");
        expect(setUnsafePreview(inFunc(fd), FeatureState.disabled, false, Loc.initial, msg)).toBe(false);
        expect(diags).toEqual([]);
        expect(setUnsafePreview(inFunc(fd), FeatureState.enabled, false, Loc.initial, msg)).toBe(true);
        expect(diags).toEqual(["Error: pointer arithmetic is not allowed in a `@safe` function"]);
    });

    it("`default_` in a `@safe` function is a deprecation and not an error (safe.d:569-574)", () => {
        // ldc2: `@safe void f(ubyte* p) { auto q = cast(bool*) p; }` ->
        // "Deprecation: cast from `ubyte*` to `bool*` will become `@system` in a future release"
        const sc = inFunc(func("f", TRUST.safe));
        expect(setUnsafePreview(sc, FeatureState.default_, false, Loc.initial, ds("pointer arithmetic"))).toBe(false);
        // The probe fixes the shape; this exact text follows from the format literal at safe.d:574 with the
        // action "pointer arithmetic", which no probe emits through this arm.
        expect(diags).toEqual(["Deprecation: pointer arithmetic will become `@system` in a future release"]);
    });

    it("`default_` in an inferring function keeps the FIRST violation and does not commit (safe.d:577-583)", () => {
        const fd = inferring("g");
        const sc = inFunc(fd);
        expect(setUnsafePreview(sc, FeatureState.default_, false, Loc.initial, ds("first"))).toBe(false);
        expect(setUnsafePreview(sc, FeatureState.default_, false, Loc.initial, ds("second"))).toBe(false);
        expect(dsToJs(fd.safetyViolation!.action!)).toBe("first");
        expect(fd.safetyInprocess).toBe(true);
        expect(diags).toEqual([]);
    });

    it("the scopeVar overload stores the variable on the recorded violation (safe.d:580-581)", () => {
        const fd = inferring("g");
        const v = new VarDeclaration(Loc.initial, Type.tvoidptr, id("p"), null, STC.scope_);
        expect(setUnsafePreviewScopeVar(inFunc(fd), FeatureState.default_, false, Loc.initial, v, ds("x"))).toBe(false);
        expect(fd.safetyViolation!.scopeVar).toBe(v);
    });
});

describe("checkUnsafeDotExp (dmd/safe.d:321)", () => {
    const e = (): Expression => new IntegerExp(Loc.initial, 0n, Type.tint32);

    it("a noDeref use is never unsafe (safe.d:323)", () => {
        const sc = inFunc(func("k", TRUST.safe));
        expect(checkUnsafeDotExp(sc, e(), Id.ptr!, DotExpFlag.noDeref)).toBe(false);
        expect(diags).toEqual([]);
    });

    it("a dereferencing use in a default-trust function is not an error (safe.d:326 -> :517, :435)", () => {
        // setUnsafe -> setFunctionToUnsafe returns false (safe.d:435: neither inferring, @safe nor saferD).
        expect(checkUnsafeDotExp(inFunc(func("d", TRUST.default_)), e(), Id.ptr!, DotExpFlag.none)).toBe(false);
        expect(diags).toEqual([]);
    });

    it("in a `@safe` function a `.ptr` dereference is an error (safe.d:326 -> :400)", () => {
        // ldc2: `@safe void m(int[] a) { auto p = a.ptr; }` ->
        // "Error: using `a.ptr` (instead of `&a[0])` is not allowed in a `@safe` function".
        // Path: safe.d:326 (`id == Id.ptr`, flag lacks noDeref) -> :471 -> :517 (setFunctionToUnsafe true:
        // `@safe`) -> :400 (the `@safe` arm reports through AttributeViolation, func.d:1263, rendering each
        // argument with toErrMsg(RootObject), hdrgen.d:112). The receiver here is the literal `0`.
        const sc = inFunc(func("m", TRUST.safe));
        expect(checkUnsafeDotExp(sc, e(), Id.ptr!, DotExpFlag.none)).toBe(true);
        expect(diags).toEqual(["Error: using `0.ptr` (instead of `&0[0])` is not allowed in a `@safe` function"]);
    });
});

describe("isSafeCast (dmd/safe.d:174)", () => {
    const e = (): Expression => new IntegerExp(Loc.initial, 0n, Type.tint32);
    const cast = (from: Type, to: Type): { ok: boolean; msg: string } => {
        const msg: { value: DString } = { value: ds("") };
        const ok = isSafeCast(e(), from, to, msg);
        return { ok, msg: dsToJs(msg.value) };
    };

    it("a non-pointer target is safe, `bool` exempt from the unsafe-bit-pattern rule (safe.d:179-188)", () => {
        // ldc2: `@safe bool f(int x) { return cast(bool) x; }` compiles.
        expect(cast(Type.tint32, Type.tbool)).toEqual({ ok: true, msg: "" });
    });

    it("casting to void* is always safe (safe.d:194)", () => {
        // ldc2: `@safe void h(const(int)* cp) { auto q = cast(void*) cp; }` compiles, and
        // `static assert(!is(const(int)* : void*))` holds: no implicit conversion, so the :177 early
        // return is not taken and the cast reaches the void* rule at :194.
        const cp = pointerTo(constOf(Type.tint32));
        expect(implicitConvToType(cp, Type.tvoidptr)).toBe(MATCH.nomatch);
        expect(cast(cp, Type.tvoidptr)).toEqual({ ok: true, msg: "" });
    });

    it("void[] to a mutable element type is unsafe (safe.d:248)", () => {
        // ldc2: `cast(int[]) a` with `void[] a` ->
        // "`void` data may contain pointers and target element type is mutable"
        expect(cast(arrayOf(Type.tvoid), arrayOf(Type.tint32)))
            .toEqual({ ok: false, msg: "`void` data may contain pointers and target element type is mutable" });
    });

    it("a pointer cast to a smaller element is safe, to a larger one is not (safe.d:299-307)", () => {
        // ldc2: `cast(int*) p` with `long* p` compiles; `cast(long*) p` with `int* p` ->
        // "Source type is incompatible with target type containing a pointer"
        expect(cast(pointerTo(Type.tint64), pointerTo(Type.tint32))).toEqual({ ok: true, msg: "" });
        expect(cast(pointerTo(Type.tint32), pointerTo(Type.tint64)))
            .toEqual({ ok: false, msg: "Source type is incompatible with target type containing a pointer" });
    });

    it("ubyte* to bool* is allowed but deprecated, returning true WITH a reason (safe.d:272-273)", () => {
        // ldc2: "Deprecation: cast from `ubyte*` to `bool*` will become `@system` in a future release"
        //       "       Source element may have bytes which are not 0 or 1"
        expect(cast(pointerTo(Type.tuns8), pointerTo(Type.tbool)))
            .toEqual({ ok: true, msg: "Source element may have bytes which are not 0 or 1" });
    });
});
