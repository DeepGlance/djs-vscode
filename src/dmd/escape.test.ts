// Co-located tests for `src/dmd/escape.ts`.
//
// dmd/escape.d has ZERO `unittest` blocks (verified: `grep -c '^\s*unittest' dmd/escape.d` -> 0), so
// this file is the thin test file of 10 §1.6b: one module-load smoke test plus one behavior pin
// per risky resolved CONCERN of the `checkAssignEscape` / `finishScopeParamInference` fill.
//
// The concerns pinned here, and why each is risky:
//   * `checkAssignEscape`'s two straight-line early-outs (escape.d:613 op filter, escape.d:621
//     pointer-free lhs) — the ONLY paths the tree reaches today, and the ones the walls in
//     expressionsem.ts stood over;
//   * `escapeExp`'s `deref` arithmetic and its routing through `EscapeByResults.varDeref`
//     (escape.d:1949): deref 0 -> `byValue`, deref -1 -> `byRef`, deref +1 -> nothing (scope is not
//     transitive). Getting a sign wrong here silently swaps "escapes by value" for "escapes by ref";
//   * `varDeref`'s `isDataseg()` early-out — a global never escapes;
//   * `finishScopeParamInference`'s `ref TypeFunction f` box (03 §3.2): D REASSIGNS the caller's `f`
//     to a copy (escape.d:2050). A port that took `f` by plain reference would set `isReturn` on the
//     shared premature type and the caller would never see the copy. Two pins: copy taken when
//     `funcdecl.type == f`, NOT taken otherwise;
//   * `finishScopeParamInference`'s `scope` inference loop (escape.d:2060) — the `opApply` index `u`
//     must line up with `funcdecl.parameters[u]`, and `inferScope` must clear `maybeScope`;
//   * `returnParamDest` (escape.d:576) — three outcomes, no prior test file existed.
//   * `checkArrayLiteralEscape` (escape.d:246) — the two guards that return `false` without calling
//     `checkNewEscape` (no `basis`, and the `if (ex)` skipping null elements) plus the two paths that
//     do call it. The two `false` pins are LEG-PRESERVATION pins over states the frontend cannot
//     build (why, with cites, in the describe block): they catch a dropped guard and nothing else.
//   * `checkNewEscape` (escape.d:969), `checkThrowEscape` (escape.d:928), `checkReturnEscape` /
//     `checkReturnEscapeRef` (escape.d:1106/:1124) — the fills of this round. Each is pinned on its
//     OBSERVABLE effect, not on the return value alone: `doNotInferScope` clearing `maybeScope`, the
//     `iscatchvar` special case, and the `refs` flag that flips the same expression's verdict.
//   * `checkParamArgumentEscape` (escape.d:344) — the `parStc & STC.scope_` switch its callbacks
//     read first, observed through `doNotInferScope`.
//   * `escapingRef`'s `ref`-PARAMETER arm (escape.d:1251) — `setUnsafePreview(...) ||
//     isSafeBypassingInference(...)`, pinned in a @system and a @safe function against ldc2.
//   * `checkMutableArguments` (escape.d:80) is pinned end to end in `ob.test.ts`, whose harness runs
//     source through `functionParameters` (expressionsem.d:4902) with `-preview=dip1021` set.
//   * `checkParamArgumentReturn` (escape.d:476), `checkConstructorEscape` (escape.d:512) and
//     `checkAssocArrayLiteralEscape` (escape.d:270) — the entry points expressionsem.ts calls at
//     expressionsem.d:4544/:12453/:6156. The first two are pinned from source against ldc2
//     `-preview=dip1000` (ob.test.ts's harness); the AA literal needs druntime's TypeInfo to be typed, so
//     in this harness it is pinned on a hand-built literal, key diagnostics before value diagnostics. Two
//     cases need druntime and are pinned on the driver path (djsMain, main.test.ts's recipe) in the last
//     describe: the :6156 call site itself, and the D-style variadic constructor's `j` (escape.d:532),
//     whose `TypeInfo_Tuple` the harness's empty `object` also lacks.
//
// No new harness machinery: the init snippet and `globalScope()` are the existing sema-test
// conventions (10 §1.5, mirroring sema.var.test.ts / enumsem.test.ts).

import "./parse.js"; // module-graph ROOT for a core-SCC test file (10 §1.5)

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    EscapeByResults, checkArrayLiteralEscape, checkAssignEscape, checkAssocArrayLiteralEscape, checkNewEscape,
    checkParamArgumentEscape, checkParamArgumentReturn, checkReturnEscape, checkReturnEscapeRef, checkThrowEscape,
    escapeByValue, finishScopeParamInference, returnParamDest, ReturnParamDest, type Ref,
} from "./escape.js";
import {
    ArrayLiteralExp, AssocArrayLiteralExp, Expression, AddrExp, AssignExp, IntegerExp, PtrExp, SymOffExp, VarExp,
} from "./expression.js";
import { Type, TypeFunction, ParameterList, Parameter } from "./mtype.js";
import { VarDeclaration } from "./declaration.js";
import { FuncDeclaration } from "./func.js";
import { STC, LINK } from "./astenums.js";
import { Loc } from "./location.js";
import { Identifier } from "./identifier.js";
import { Id } from "./id.js";
import { initTokens } from "./tokens.js";
import { global } from "./globals.js";
import { ErrorSinkNull } from "./errorsink.js";
import { Module, moduleFromParse } from "./dmodule.js";
import { Scope } from "./dscope.js";
import { Array as DArray } from "./root/array.js";
import { ds } from "../dstring.js";
import { Type_init, pointerTo } from "./typesem.js";
import { runSemantic, scopeCreateGlobal } from "./dsymbolsem.js";
import { Parser } from "./parse.js";
import { FeatureState } from "./globals.js";
import { ErrorSinkCompiler, setDiagnosticHandler } from "./errors.js";
import { dmdformat } from "./root/dmdformat.js";
import { initSemaHarness } from "../sema-harness.js";
import { dsToJs } from "../dstring.js";

import type { Dsymbol } from "./dsymbol.js";
import type { Dsymbols, Expressions, Parameters, VarDeclarations } from "./arraytypes.js";

beforeEach(() => {
    Loc._init();
    initTokens();
    Id.initialize();
    Type_init();
    global.errorSink = new ErrorSinkNull();
    global.errors = 0;
    global.gaggedErrors = 0;
    global.gag = 0;
    Module.deferred.setDim(0);
    Module.deferred2.setDim(0);
    Module.deferred3.setDim(0);
});

function id(name: string): Identifier {
    return Identifier.idPool(ds(name));
}

/** A global `Scope` over a bare module — the sema-test convention (sema.var.test.ts:85). */
function globalScope(): Scope {
    const members: Dsymbols = new DArray<Dsymbol | null>();
    const m = moduleFromParse(members, null);
    return scopeCreateGlobal(m, global.errorSink!);
}

/** `R f(params)` as a bare `TypeFunction` (no semantic run). */
function funcType(treturn: Type | null, params: Parameter[], stc: STC = STC.none): TypeFunction {
    const ps: Parameters = new DArray<Parameter | null>();
    for (const p of params) ps.push(p);
    return new TypeFunction(new ParameterList(ps), treturn, LINK.d, stc);
}

/** A `FuncDeclaration` shell whose `type` is `tf`; enough for the escape.ts entry points. */
function funcShell(name: string, tf: TypeFunction): FuncDeclaration {
    return new FuncDeclaration(Loc.initial, Loc.initial, id(name), STC.none, tf);
}

/**
 * A local variable whose parent is a function — the shape `isDataseg()` answers `false` for
 * (declaration.ts:683: a non-Module / non-TemplateInstance / non-Nspace parent leaves the cache at
 * "not in the data segment"), so `EscapeByResults.varDeref` does NOT take its early-out.
 */
function localVar(name: string, t: Type, owner: FuncDeclaration, stc: STC = STC.none): VarDeclaration {
    const v = new VarDeclaration(Loc.initial, t, id(name), null, stc);
    v.parent = owner;
    return v;
}

/** Records which `EscapeByResults` callback fired, for the `escapeExp` routing pins. */
interface Collected {
    er: EscapeByResults;
    byValue: VarDeclaration[];
    byRef: Array<{ v: VarDeclaration; retRefTransition: boolean }>;
    byFunc: FuncDeclaration[];
    byExp: Expression[];
}

function collector(): Collected {
    const byValue: VarDeclaration[] = [];
    const byRef: Array<{ v: VarDeclaration; retRefTransition: boolean }> = [];
    const byFunc: FuncDeclaration[] = [];
    const byExp: Expression[] = [];
    const er = new EscapeByResults(
        (v, retRefTransition) => { byRef.push({ v, retRefTransition }); },
        (v) => { byValue.push(v); },
        (fd) => { byFunc.push(fd); },
        (e) => { byExp.push(e); },
    );
    return { er, byValue, byRef, byFunc, byExp };
}

describe("escape.ts module load", () => {
    it("loads and exposes the escape.d entry points", () => {
        // 10 §1.5: names the core-SCC load-order regression instead of letting it surface as a
        // collect-time crash in an unrelated suite.
        expect(typeof Expression).toBe("function");
        expect(typeof checkAssignEscape).toBe("function");
        expect(typeof finishScopeParamInference).toBe("function");
        expect(typeof escapeByValue).toBe("function");
        expect(typeof checkArrayLiteralEscape).toBe("function");
    });
});

describe("checkAssignEscape (dmd/escape.d:609)", () => {
    it("returns false for an expression that is not one of the six assignment ops (escape.d:613)", () => {
        const sc = globalScope();
        const e = new IntegerExp(Loc.initial, 1n, Type.tint32); // EXP.int64
        expect(checkAssignEscape(sc, e, /*gag:*/ true, /*byRef:*/ false)).toBe(false);
    });

    it("returns false when the assigned-to type carries no pointers (escape.d:621)", () => {
        const sc = globalScope();
        const lhs = new IntegerExp(Loc.initial, 0n, Type.tint32);
        const rhs = new IntegerExp(Loc.initial, 1n, Type.tint32);
        const ae = new AssignExp(Loc.initial, lhs, rhs);
        ae.type = Type.tint32;
        expect(checkAssignEscape(sc, ae, /*gag:*/ true, /*byRef:*/ false)).toBe(false);
    });
});

describe("escapeByValue / escapeExp deref routing (dmd/escape.d:1508)", () => {
    it("a pointer-typed VarExp escapes BY VALUE (deref 0 -> varDeref -> byValue)", () => {
        const fd = funcShell("f", funcType(Type.tvoid, []));
        const v = localVar("p", Type.tvoidptr, fd);
        const c = collector();

        escapeByValue(new VarExp(Loc.initial, v), c.er);

        expect(c.byValue).toEqual([v]);
        expect(c.byRef).toEqual([]);
        expect(c.byExp).toEqual([]);
    });

    it("`&v` escapes BY REF with retRefTransition false (visitAddr: deref 0 -> -1)", () => {
        const fd = funcShell("f", funcType(Type.tvoid, []));
        const v = localVar("x", Type.tvoidptr, fd);
        const ae = new AddrExp(Loc.initial, new VarExp(Loc.initial, v), Type.tvoidptr);
        const c = collector();

        escapeByValue(ae, c.er);

        expect(c.byRef).toEqual([{ v, retRefTransition: false }]);
        expect(c.byValue).toEqual([]);
    });

    it("`*p` escapes nothing — visitPtr does not recurse (escape.d:1587)", () => {
        // `deref` is 0 and `er.live` is false, so visitPtr's guard
        // `if (deref < 0 || (er.live && e.type.hasPointers()))` (escape.d:1587) is false on both
        // operands and never recurses into `e.e1`. The `deref > 0 && !er.live` early-out
        // (escape.d:1839) is NOT what this pins: execution never reaches deref 1.
        const fd = funcShell("f", funcType(Type.tvoid, []));
        const v = localVar("p", Type.tvoidptr, fd);
        const pe = new PtrExp(Loc.initial, new VarExp(Loc.initial, v), Type.tvoidptr);
        const c = collector();

        escapeByValue(pe, c.er);

        expect(c.byValue).toEqual([]);
        expect(c.byRef).toEqual([]);
    });

    it("a data-segment variable is dropped by varDeref (escape.d:1951)", () => {
        // A `static` variable: `isDataseg()` answers true (declaration.ts:697), so no callback fires.
        const v = new VarDeclaration(Loc.initial, Type.tvoidptr, id("g"), null, STC.static_);
        expect(v.isDataseg()).toBe(true);
        const c = collector();

        escapeByValue(new VarExp(Loc.initial, v), c.er);

        expect(c.byValue).toEqual([]);
        expect(c.byRef).toEqual([]);
    });
});

describe("finishScopeParamInference (dmd/escape.d:2042)", () => {
    it("is a no-op when scopeInprocess is already false (escape.d:2044)", () => {
        const tf = funcType(Type.tvoid, []);
        const fd = funcShell("f", tf);
        fd.storage_class = STC.return_;
        fd.scopeInprocess = false;
        const box: Ref<TypeFunction> = { value: tf };

        finishScopeParamInference(fd, box);

        expect(box.value).toBe(tf);
        expect(tf.isReturn).toBe(false);
    });

    it("COPIES f when `funcdecl.type == f` and writes `return`/`return scope` on the copy (escape.d:2048)", () => {
        const tf = funcType(Type.tvoid, []);
        const fd = funcShell("f", tf);
        fd.scopeInprocess = true;
        fd.storage_class = (STC.return_ | STC.returnScope | STC.returninferred) as STC;
        const box: Ref<TypeFunction> = { value: tf };

        finishScopeParamInference(fd, box);

        expect(fd.scopeInprocess).toBe(false);
        expect(box.value).not.toBe(tf);          // the `ref TypeFunction f` reassignment
        expect(box.value.isReturn).toBe(true);
        expect(box.value.isReturnScope).toBe(true);
        expect(box.value.isReturnInferred).toBe(true);
        expect(tf.isReturn).toBe(false);         // the premature type is left alone
    });

    it("does NOT copy when `f` is already distinct from funcdecl.type (escape.d:2050)", () => {
        const tf = funcType(Type.tvoid, []);
        const inferred = funcType(Type.tvoid, []);
        const fd = funcShell("f", tf);
        fd.scopeInprocess = true;
        fd.storage_class = STC.return_;
        const box: Ref<TypeFunction> = { value: inferred };

        finishScopeParamInference(fd, box);

        expect(box.value).toBe(inferred);
        expect(inferred.isReturn).toBe(true);
        expect(inferred.isReturnScope).toBe(false);
    });

    it("infers `scope` on a pointer parameter and clears maybeScope (escape.d:2060)", () => {
        const p = Parameter.create(Loc.initial, STC.none, Type.tvoidptr, id("p"), null, null);
        const tf = funcType(Type.tvoid, [p]);
        const fd = funcShell("f", tf);
        fd.scopeInprocess = true;
        const v = localVar("p", Type.tvoidptr, fd, STC.parameter);
        v.maybeScope = true;
        const params: VarDeclarations = new DArray<VarDeclaration | null>();
        params.push(v);
        fd.parameters = params;
        const box: Ref<TypeFunction> = { value: tf };

        finishScopeParamInference(fd, box);

        // `tf.parameterList` is the TypeFunction's OWN copy of the list (mtype.ts:1366), so read the
        // storage class back off it rather than off the `p` handed to `funcType`.
        expect(box.value.parameterList.opIndex(0)!.storageClass & (STC.scope_ | STC.scopeinferred))
            .toBe(STC.scope_ | STC.scopeinferred);
        expect(v.maybeScope).toBe(false);
        expect(v.isScope()).toBe(true);
    });

    it("leaves a pointer-free parameter alone (escape.d:2066 `v.type.hasPointers()`)", () => {
        const p = Parameter.create(Loc.initial, STC.none, Type.tint32, id("i"), null, null);
        const tf = funcType(Type.tvoid, [p]);
        const fd = funcShell("f", tf);
        fd.scopeInprocess = true;
        const v = localVar("i", Type.tint32, fd, STC.parameter);
        v.maybeScope = true;
        const params: VarDeclarations = new DArray<VarDeclaration | null>();
        params.push(v);
        fd.parameters = params;
        const box: Ref<TypeFunction> = { value: tf };

        finishScopeParamInference(fd, box);

        expect(box.value.parameterList.opIndex(0)!.storageClass & STC.scope_).toBe(0n);
        expect(v.maybeScope).toBe(true);
    });
});

describe("returnParamDest (dmd/escape.d:576)", () => {
    it("a non-`void` return transfers through the return statement (escape.d:582)", () => {
        const tf = funcType(Type.tint32, [Parameter.create(Loc.initial, STC.none, Type.tint32, id("a"), null, null)]);
        expect(returnParamDest(tf, null)).toBe(ReturnParamDest.returnVal);
    });

    it("a constructor transfers to `this` (escape.d:579)", () => {
        const tf = funcType(Type.tvoid, []);
        tf.isCtor = true;
        expect(returnParamDest(tf, null)).toBe(ReturnParamDest.this_);
    });

    it("a `void` function with a `ref` first parameter transfers to it (escape.d:588)", () => {
        const tf = funcType(Type.tvoid, [Parameter.create(Loc.initial, STC.ref_, Type.tint32, id("a"), null, null)]);
        expect(returnParamDest(tf, null)).toBe(ReturnParamDest.firstArg);
    });

    it("a `void` function with a by-value first parameter still returns `returnVal` (escape.d:591)", () => {
        const tf = funcType(Type.tvoid, [Parameter.create(Loc.initial, STC.none, Type.tint32, id("a"), null, null)]);
        expect(returnParamDest(tf, null)).toBe(ReturnParamDest.returnVal);
    });
});

describe("checkArrayLiteralEscape (dmd/escape.d:246)", () => {
    // The two live `false` returns and the two paths that call `checkNewEscape` (now filled in
    // escape.ts, so no throw is involved any more). `sc` is only forwarded to `checkNewEscape` on
    // these inputs and never dereferenced there, so `globalScope()` is the sanctioned spelling here
    // (10 §1.9). The D dispatch needs no proof (10 §1.8 rule 5) because `checkArrayLiteralEscape`
    // calls `checkNewEscape` straight-line at escape.d:250/:254, with no visitor routing in between.
    //
    // SCOPE OF THE TWO `false` PINS, stated so nobody reads them as coverage: the one D caller in the
    // 1.43.0 tree is nogc.d:158 (verified: `grep -rn checkArrayLiteralEscape dmd/ gen/` -> the
    // definition plus that one call), and NEITHER `false` path is reachable through it. nogc.d:152-154
    // returns whenever `dim == 0`, so a frontend-built call always has a non-empty `elements`; and
    // `elements` may hold nulls only when `basis !is null` (expression.d:1346-1349, the contract
    // `opIndex` at expression.d:1403 relies on), and a non-null `basis` takes the escape.d:250 call
    // before the loop. So these two build states the frontend cannot deliver, deliberately: they are
    // leg-preservation pins (drop `if (ae.basis)` or `if (ex)` and the live `false` legs go away), NOT
    // evidence that any compiler-reachable input is escape-checked. The two RE-PINNED tests below are
    // on paths D does take.

    it("LEG PIN (unreachable state): empty, no basis -> false (escape.d:249 false, :251 no iterations)", () => {
        const sc = globalScope();
        const els: Expressions = new DArray<Expression | null>();
        expect(checkArrayLiteralEscape(sc, ArrayLiteralExp.create(Loc.initial, els), /*gag:*/ true)).toBe(false);
    });

    it("LEG PIN (unreachable state): wholly sparse -> false, the `if (ex)` guard skips nulls (escape.d:253)", () => {
        const sc = globalScope();
        const els: Expressions = new DArray<Expression | null>();
        els.push(null);
        els.push(null);
        expect(checkArrayLiteralEscape(sc, ArrayLiteralExp.create(Loc.initial, els), /*gag:*/ true)).toBe(false);
    });

    // RE-PIN (10 §1.8 rule 7): the two tests below were WALL PINs on
    // `TODO-BODY: checkNewEscape (dmd/escape.d:969) at dmd/escape.d:250 and :254`. That wall is gone —
    // `checkNewEscape` is filled at its own D position in escape.ts — so each is converted to a
    // BEHAVIOUR pin on what the now-live body produces, keeping the coverage the wall pin bought:
    // the element leg (escape.d:254) and the `basis` leg (escape.d:250) each still reach the callee.
    // The negative form (`not.toThrow`) names the callee whose wall is gone; the `false` beside it is
    // the behaviour.

    it("RE-PINNED: a non-null element is escape-checked by the live checkNewEscape (escape.d:254)", () => {
        const sc = globalScope();
        const els: Expressions = new DArray<Expression | null>();
        els.push(new IntegerExp(Loc.initial, 1n, Type.tint32));
        const ale = ArrayLiteralExp.create(Loc.initial, els);
        // An `IntegerExp` element reaches no `EscapeByResults` callback (`escapeExp`'s base `visit`
        // does nothing, escape.d:1519), so `checkNewEscape` reports nothing escaped.
        expect(() => checkArrayLiteralEscape(sc, ale, /*gag:*/ true)).not.toThrow(/checkNewEscape/);
        expect(checkArrayLiteralEscape(sc, ale, /*gag:*/ true)).toBe(false);
    });

    it("RE-PINNED: a `basis` is escape-checked before the loop (escape.d:250)", () => {
        const sc = globalScope();
        const els: Expressions = new DArray<Expression | null>();
        const ale = ArrayLiteralExp.fromBasis(Loc.initial, null,
            new IntegerExp(Loc.initial, 0n, Type.tint32), els);
        expect(() => checkArrayLiteralEscape(sc, ale, /*gag:*/ true)).not.toThrow(/checkNewEscape/);
        expect(checkArrayLiteralEscape(sc, ale, /*gag:*/ true)).toBe(false);
    });
});

describe("checkParamArgumentEscape (dmd/escape.d:344)", () => {
    // `parStc & STC.scope_` is the switch every callback reads first (escape.d:389/:423/:448): a
    // `scope` parameter cannot let its argument escape, so `onValue` returns before `doNotInferScope`.
    // Both pins read the same observable (`maybeScope`) with the flag flipped, so an inverted or
    // dropped test turns one of them red. The result is `false` both ways: `v` is not `scope`, so
    // `unsafeAssign` is not reached (escape.d:395).
    function passPointerLocal(parStc: STC): VarDeclaration {
        const sc = globalScope();
        const fd = funcShell("f", funcType(Type.tvoid, []));
        sc.func = fd;
        const v = localVar("p", Type.tvoidptr, fd);
        v.maybeScope = true;
        const vPar = localVar("q", Type.tvoidptr, fd, (STC.parameter | parStc) as STC);
        const arg = new VarExp(Loc.initial, v);
        expect(checkParamArgumentEscape(sc, null, id("q"), vPar, parStc, arg, false, /*gag:*/ true)).toBe(false);
        return v;
    }

    it("a pointer local passed to a non-scope parameter loses scope inference (escape.d:393)", () => {
        expect(passPointerLocal(STC.none).maybeScope).toBe(false);
    });

    it("a pointer local passed to a `scope` parameter is left alone (escape.d:390)", () => {
        expect(passPointerLocal(STC.scope_).maybeScope).toBe(true);
    });
});

describe("checkNewEscape (dmd/escape.d:969)", () => {
    // The `onValue` non-scope leg (escape.d:1007) is pinned through its OBSERVABLE side effect —
    // `doNotInferScope` clearing `maybeScope` (escape.d:2023) — not through the return value, which is
    // `false` on this path either way. `maybeScope` is set explicitly here because the TS
    // `VarDeclaration` bit-field defaults to 0 (declaration.ts:575) and no sema pass ran.
    it("a non-scope pointer local reached BY VALUE is marked never-scope (escape.d:1007)", () => {
        const sc = globalScope();
        const fd = funcShell("f", funcType(Type.tvoid, []));
        const v = localVar("p", Type.tvoidptr, fd);
        v.maybeScope = true;

        expect(checkNewEscape(sc, new VarExp(Loc.initial, v), /*gag:*/ true)).toBe(false);
        expect(v.maybeScope).toBe(false);
    });

    it("a pointer-free expression reaches no callback at all (escape.d:1088)", () => {
        const sc = globalScope();
        expect(checkNewEscape(sc, new IntegerExp(Loc.initial, 7n, Type.tint32), /*gag:*/ true)).toBe(false);
    });
});

describe("checkThrowEscape (dmd/escape.d:928)", () => {
    // The `iscatchvar` special case (escape.d:937) is the one branch of this function worth a pin: a
    // `scope` variable that IS a catch var must fall through to `doNotInferScope`, while one that is
    // not must take the `setUnsafeDIP1000` arm and return WITHOUT touching `maybeScope`. The two pins
    // read the same observable (`maybeScope`) with the flag flipped, so dropping the `!v.iscatchvar`
    // operand turns one of them red.
    it("a `scope` CATCH var is allowed to be rethrown and only loses scope inference (escape.d:946)", () => {
        const sc = globalScope();
        const fd = funcShell("f", funcType(Type.tvoid, []));
        const v = localVar("caught", Type.tvoidptr, fd, STC.scope_);
        v.maybeScope = true;
        v.iscatchvar = true;

        expect(checkThrowEscape(sc, new VarExp(Loc.initial, v), /*gag:*/ true)).toBe(false);
        expect(v.maybeScope).toBe(false);
    });

    it("a `scope` NON-catch var takes the setUnsafeDIP1000 arm and leaves maybeScope alone (escape.d:941)", () => {
        const sc = globalScope();
        const fd = funcShell("f", funcType(Type.tvoid, []));
        const v = localVar("s", Type.tvoidptr, fd, STC.scope_);
        v.maybeScope = true;

        // `sc.useDIP1000()` is `disabled` in the fixed target world (globals.ts:293 leaves
        // `useDIP1000` at `default_`, so dscope.ts:843 answers `disabled`), and setUnsafePreview
        // returns false for `disabled` (safe.d:560).
        expect(checkThrowEscape(sc, new VarExp(Loc.initial, v), /*gag:*/ true)).toBe(false);
        expect(v.maybeScope).toBe(true);
    });
});

describe("checkReturnEscape / checkReturnEscapeRef (dmd/escape.d:1106/:1124)", () => {
    // The `refs` flag is the whole content of these two entry points: it selects `escapeByRef` over
    // `escapeByValue` (escape.d:1387) and changes which nested callback sees the variable. One
    // expression, both entry points, opposite answers — an inverted flag turns both pins red.
    it("BY VALUE: a local pointer is not an escape, and loses scope inference (escape.d:1233)", () => {
        const sc = globalScope();
        const fd = funcShell("f", funcType(Type.tvoid, []));
        sc.func = fd;
        const v = localVar("p", Type.tvoidptr, fd);
        v.maybeScope = true;

        expect(checkReturnEscape(sc, new VarExp(Loc.initial, v), /*gag:*/ true)).toBe(false);
        expect(v.maybeScope).toBe(false);
    });

    it("BY REF: returning the same local by `ref` IS an escape (escape.d:1283)", () => {
        const sc = globalScope();
        const fd = funcShell("f", funcType(Type.tvoid, []));
        sc.func = fd;
        const v = localVar("p", Type.tvoidptr, fd);

        // `escapeByRef` enters `escapeExp` at deref -1 (escape.d:1919) -> `byRef` -> `onRef`; the
        // variable is not a `ref` PARAMETER, so `escapingRef` takes its `else` arm at escape.d:1276
        // — `previewErrorFunc` under `!gag` plus `result = true` — and NOT the
        // `isSafeBypassingInference` condition at escape.d:1254, which only a `ref` parameter reaches.
        expect(checkReturnEscapeRef(sc, new VarExp(Loc.initial, v), /*gag:*/ true)).toBe(true);
    });

    // A `ref` PARAMETER is the ONE input that reaches `escapingRef`'s first arm (escape.d:1251
    // `v.isParameter() && v.isReference()`): `setUnsafePreview(...) || sc.func.isSafeBypassingInference()`
    // (escape.d:1253-1254). The path D takes to get there, each link cited: `escapeByRef` ->
    // `escapeExp(e, er, -1)` -> `varDeref(v, -1)` -> `byRef` -> `onRef` (escape.d:1237); `refs` is true
    // so `checkScopeVarAddr` is skipped (escape.d:1293); `v` IS a reference so the escape.d:1299 block
    // is skipped; `vsr == ScopeRef.Ref` and `p === sc.func`, and `inferReturn` returns false at
    // escape.d:1437 because a plain named function has `scopeInprocess` false — so D falls to
    // escape.d:1340 `escapingRef(v, sc.useDIP25)`. With the harness `Scope` (`globalScope()` runs
    // `previews.setFromParams`, dsymbolsem.ts:887, and `global.params.useDIP25` is `enabled` by
    // default — globals.ts:292, matching globals.d:233) the featureState is `enabled`, so the first
    // operand is safe.d's `setUnsafe`. The two pins flip only the function's trust.
    it("BY REF, `ref` PARAMETER of a @system function: not an escape (escape.d:1253-1254)", () => {
        // ldc2 1.43.0 compiles `ref int f(ref int x) { return x; }` clean: `setUnsafe` answers false
        // outside @safe code, and so does `isSafeBypassingInference` (safe.d:348) for a @system function.
        const sc = globalScope();
        const param = new Parameter(Loc.initial, STC.ref_, Type.tint32, id("x"), null, null);
        const fd = funcShell("f", funcType(Type.tint32, [param], STC.ref_));
        sc.func = fd;
        // A `ref` parameter of `fd`: `isParameter()` true via STC.parameter, `isReference()` true via
        // STC.ref_, and `toParent2()` is `fd` itself, which is what escape.d:1336 `if (p == sc.func)` needs.
        // `(x | y) as STC` is this file's established bigint-flag widening (09; escape.ts:1300).
        const v = localVar("x", Type.tint32, fd, (STC.parameter | STC.ref_) as STC);

        expect(checkReturnEscapeRef(sc, new VarExp(Loc.initial, v), /*gag:*/ true)).toBe(false);
    });

    it("BY REF, `ref` PARAMETER of a @safe function: an escape (escape.d:1253-1257)", () => {
        // ldc2 1.43.0 on `@safe ref int g(ref int x) { return x; }`: "Error: escaping a reference to
        // parameter `x` by returning `x` is not allowed in a `@safe` function" — `setUnsafe` answers
        // true in @safe code, so `result` is set (the message itself is gagged here).
        const sc = globalScope();
        const param = new Parameter(Loc.initial, STC.ref_, Type.tint32, id("x"), null, null);
        const fd = funcShell("g", funcType(Type.tint32, [param], (STC.ref_ | STC.safe) as STC));
        sc.func = fd;
        const v = localVar("x", Type.tint32, fd, (STC.parameter | STC.ref_) as STC);

        expect(checkReturnEscapeRef(sc, new VarExp(Loc.initial, v), /*gag:*/ true)).toBe(true);
    });
});

/**
 * Source-driven pins for the three entry points reached from expressionsem.ts, each against ldc2 1.43.0
 * (`ldc2 -c -o- -preview=dip1000 x.d`, source and caret lines stripped). The harness is ob.test.ts's:
 * lex + parse + `runSemantic`, diagnostics captured as `(line) header+message`. `-preview=dip1000` is set
 * on `global.params` directly because this harness bypasses the driver.
 */
describe("checkParamArgumentReturn / checkConstructorEscape / checkAssocArrayLiteralEscape, from source", () => {
    let diags: string[] = [];

    beforeEach(() => {
        initSemaHarness();
        global.errorSink = new ErrorSinkCompiler();
        global.params.useDIP1000 = FeatureState.enabled;
        diags = [];
        setDiagnosticHandler((loc, _color, header, messageFormat, args) => {
            diags.push(`(${loc.linnum}) ` + dsToJs(header) + dsToJs(dmdformat(messageFormat, [...args])));
            return true;
        });
    });

    afterEach(() => {
        setDiagnosticHandler(null);
        global.params.useDIP1000 = FeatureState.default_;
    });

    /** NUL-terminated byte buffer (the lexer scans to the NUL sentinel). */
    function srcBuf(text: string): Uint8Array {
        const b = new Uint8Array(text.length + 1);
        for (let i = 0; i < text.length; i++) b[i] = text.charCodeAt(i) & 0xff;
        b[text.length] = 0;
        return b;
    }

    /** lex + parse + runSemantic over `text`; returns the diagnostics, each prefixed with its line. */
    function sema(text: string): string[] {
        const p = new Parser(null, null, srcBuf(text), false, global.errorSink!, null, false);
        p.nextToken();
        const members: Dsymbols = p.parseModule();
        runSemantic(moduleFromParse(members, p.md));
        return diags;
    }

    // expressionsem.d:4443 routes a `void` free function with a `ref` first parameter to
    // `ReturnParamDest.firstArg`, so :4544 checks `p = i` through `checkParamArgumentReturn`.
    it("a `return ref` argument assigned to a longer-lived first argument (escape.d:493 byRef leg)", () => {
        expect(sema("module pr1;\nvoid assign(ref int* x, return ref int i) @safe { x = &i; }\n" +
            "@safe void f() { int* p; int i; assign(p, i); }\n")).toEqual([
            "(3) Error: assigning address of variable `i` to `p` with longer lifetime is not allowed in a " +
                "`@safe` function",
        ]);
    });

    it("a `return scope` pointer argument, by value (escape.d:493 byRef false)", () => {
        expect(sema("module pr8;\nvoid assign(ref int* x, return scope int* i) @safe { x = i; }\n" +
            "@safe void f() { int* p; int i; assign(p, &i); }\n")).toEqual([
            "(3) Error: assigning address of variable `i` to `p` with longer lifetime is not allowed in a " +
                "`@safe` function",
        ]);
    });

    it("the first argument is a global: an error in @safe code, none in @system code", () => {
        expect(sema("module pr10;\nvoid assign(ref int* x, return ref int i) @safe { x = &i; }\nint* g;\n" +
            "@safe void f() { int i; assign(g, i); }\n@system void h() { int i; assign(g, i); }\n")).toEqual([
            "(4) Error: assigning address of variable `i` to `g` with longer lifetime is not allowed in a " +
                "`@safe` function",
        ]);
    });

    // expressionsem.d:12453: a field constructed in a constructor from `S(&i)` re-targets the
    // `__ctmp.this(&i)` call at `this.s`, and the `return scope` parameter is assigned to it.
    it("constructing a field from a `return scope` constructor argument (escape.d:544)", () => {
        expect(sema("module pr4;\nstruct S { int* p; this(return scope int* q) @safe { p = q; } }\n" +
            "struct T { S s; this(int) @safe { int i; s = S(&i); } }\n")).toEqual([
            "(3) Error: assigning address of variable `i` to `this` with longer lifetime is not allowed in a " +
                "`@safe` function",
        ]);
    });

    it("constructing a local from the same call is no error: the local is inferred `scope`", () => {
        expect(sema("module pr5;\nstruct S { int* p; this(return scope int* q) @safe { p = q; } }\n" +
            "@safe void f(ref S r) { int i; S s = S(&i); }\n")).toEqual([]);
    });

    // The first early-out of checkParamArgumentReturn, called directly: `functionParameters` filters on
    // `pStc & STC.return_` before calling (expressionsem.d:4539), where `pStc` may carry an inferred
    // `return` that `param.storageClass` lacks. Without the guard, `p = &i` is reported in @safe code.
    // The second early-out (escape.d:486) is not pinned: a pointer-free by-value argument does reach `onValue`
    // (varDeref, escape.d:1956), but its effects there, `return`/`scope` inference state on a pointer-free
    // variable, are not observable, because scope inference is gated on `hasPointers` (escape.d:2066).
    it("a parameter without `return` is not checked (escape.d:483)", () => {
        const { sc, fd } = aaScope(STC.safe);
        const firstArg = new VarExp(Loc.initial, localVar("p", pointerTo(Type.tint32), fd));
        const param = new Parameter(Loc.initial, STC.scope_, pointerTo(Type.tint32), id("q"), null, null);

        expect(checkParamArgumentReturn(sc, firstArg, addrOfLocal("i", fd), param, /*gag:*/ false)).toBe(false);
        expect(diags).toEqual([]);
    });

    // expressionsem.d:6156 is not reachable from source here: every AA literal lowers through druntime's
    // `_d_assocarrayliteralTX` and needs `TypeInfo_AssociativeArray` (semanticTypeInfo, :6154), which this
    // harness's empty `object` lacks (the TypeInfo lookup is fatal). The literal is built by hand instead,
    // with the shape semantic leaves: `&i` of a local is a `SymOffExp` typed `int*` (which is why ldc2
    // prints it `& i`, hdrgen's SymOffExp form), `i` a local of a @safe function. Expected text:
    // ldc2 1.43.0 on `@safe int*[int*] f() { int i; int j; return [&i: &j]; }` (the lines carry the
    // literal's own positions there; `Loc.initial` here).
    function addrOfLocal(name: string, fd: FuncDeclaration): Expression {
        const v = localVar(name, Type.tint32, fd);
        const e = new SymOffExp(Loc.initial, v, 0n);
        e.type = pointerTo(Type.tint32);
        return e;
    }

    function aaScope(stc: STC): { sc: Scope; fd: FuncDeclaration } {
        const sc = globalScope();
        const fd = funcShell("f", funcType(Type.tvoid, [], stc));
        sc.func = fd;
        return { sc, fd };
    }

    function exprs(...es: Expression[]): Expressions {
        const a: Expressions = new DArray<Expression | null>();
        for (const e of es) a.push(e);
        return a;
    }

    it("an AA literal checks every key, then every value (escape.d:273, :278)", () => {
        const { sc, fd } = aaScope(STC.safe);
        const ae = new AssocArrayLiteralExp(Loc.initial, exprs(addrOfLocal("i", fd)), exprs(addrOfLocal("j", fd)));

        expect(checkAssocArrayLiteralEscape(sc, ae, /*gag:*/ false)).toBe(true);
        expect(diags).toEqual([
            "(0) Error: escaping a reference to local variable `i` by copying `& i` into allocated memory is " +
                "not allowed in a `@safe` function",
            "(0) Error: escaping a reference to local variable `j` by copying `& j` into allocated memory is " +
                "not allowed in a `@safe` function",
        ]);
    });

    it("an AA literal in @system code is no error (ldc2: `@system int*[int] f() { int i; return [1: &i]; }`)", () => {
        const { sc, fd } = aaScope(STC.system);
        const ae = new AssocArrayLiteralExp(Loc.initial, exprs(new IntegerExp(Loc.initial, 1n, Type.tint32)),
            exprs(addrOfLocal("i", fd)));

        expect(checkAssocArrayLiteralEscape(sc, ae, /*gag:*/ false)).toBe(false);
        expect(diags).toEqual([]);
    });
});

/**
 * Pins that need druntime, which the sema harness's empty `object` lacks (the AA TypeInfo for
 * expressionsem.d:6156, `TypeInfo_Tuple` for a D-style variadic constructor): one ldc2-shaped compile through
 * the shim (src/djs.ts `djsMain`, druntime from the shim's ldc2.conf import directory) in a fresh module
 * registry, as main.test.ts does. Expected text: ldc2 1.43.0 `-c -o- -preview=dip1000` on the same file,
 * stderr byte for byte (the file path is the temp path both print).
 */
describe("checkAssocArrayLiteralEscape / checkConstructorEscape on the driver path", () => {
    const dir = mkdtempSync(join(tmpdir(), "djs-escape-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    async function shim(args: string[]): Promise<{ code: number; stderr: string }> {
        vi.resetModules();
        const { djsMain } = await import("../djs.js");
        const err: string[] = [];
        const e = vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array): boolean => {
            err.push(typeof c === "string" ? c : new TextDecoder().decode(c));
            return true;
        });
        try {
            return { code: djsMain(args), stderr: err.join("") };
        } finally {
            e.mockRestore();
        }
    }

    it("a @safe AA literal of local addresses: key, then value; the @system one is silent", async () => {
        const src = "@safe int*[int*] f() { int i; int j; return [&i: &j]; }";
        const f = join(dir, "aa2.d");
        writeFileSync(f, `module aa2;\n${src}\n@system int*[int] g() { int i; return [1: &i]; }\n`);
        const r = await shim(["-c", "-o-", "-preview=dip1000", f]);
        const msg = (v: string): string => `${f}(2): Error: escaping a reference to local variable \`${v}\` by ` +
            `copying \`& ${v}\` into allocated memory is not allowed in a \`@safe\` function\n${src}\n`;
        expect(r.code).toBe(1);
        expect(r.stderr).toBe(msg("i") + " ".repeat(45) + "^\n" + msg("j") + " ".repeat(49) + "^\n");
    }, 60_000);

    // escape.d:532 sets j=1 for a D-style variadic constructor, a dmd rule for its prepended `_arguments`;
    // ldc2 prepends none (expressionsem.d:4905 `!IN_LLVM`), so argument 0 is never checked and argument k is
    // checked against parameter k-1. ldc2 is silent on both constructions; with j=0 each reports `i`.
    it("a D-style variadic constructor skips argument 0 and shifts the rest (escape.d:532)", async () => {
        const f = join(dir, "va.d");
        writeFileSync(f, "module va;\n" +
            "struct S { int* p; this(return scope int* q, ...) @trusted { p = q; } }\n" +
            "struct T { S s; this(int) @safe { int i; s = S(&i); } }\n" +
            "struct S2 { int* p; this(int* a, return scope int* q, ...) @trusted { p = q; } }\n" +
            "struct U { S2 s; this(int) @safe { int i; s = S2(null, &i); } }\n");
        expect(await shim(["-c", "-o-", "-preview=dip1000", f])).toEqual({ code: 0, stderr: "" });
    }, 60_000);
});
