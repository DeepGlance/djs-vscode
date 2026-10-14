// Co-located tests for src/dmd/delegatize.ts.
//
// dmd/delegatize.d carries ZERO in-source unittest blocks (verified: `grep -c unittest delegatize.d`
// -> 0), so this file is the thin test file of 10 §1.6b: one module-load smoke test plus one
// pin per risky resolved construct, built with hand-made nodes over the existing sema harness
// (`initSemaHarness`, 10 §1.5). No new harness machinery.
//
// The risky constructs these pins cover:
//   - `ensureStaticLinkTo` (delegatize.d:284): the `s == p` hit, the walk up the parent chain through
//     `toParentP`, both `break` exits (a function neither member nor nested, a `static` aggregate),
//     and the issue-15332 side effect — a function literal passed on the way up becomes a
//     `delegate`, even when the walk then fails.
//   - `toDelegate` (delegatize.d:48): the lowering shape it builds for `expressionSemantic` — the
//     `FuncLiteralDeclaration` with `TOK.delegate_`, the `TypeFunction` returning `t`, `return e;`
//     vs `e;` by `t.ty == Tvoid`, the `MODFlags.wild` on a wild return type — observed through the
//     re-parented declarations of `e` (the `LambdaSetParent` visitor, including its closure-var move),
//     and the semantic'd `FuncExp` it returns (delegatize.d:70-72): the delegate type, the literal's
//     final `tok` and its location-generated identifier. ldc2 -vcg-ast on `int take(lazy int x)` /
//     `void vtake(lazy void x)` prints exactly this shape: `take(delegate int() pure nothrow @nogc
//     @safe => a + 1)` and `vtake(delegate void() pure nothrow @nogc @safe { a++; })`.
//   - `toDelegate`'s `ErrorExp` return (delegatize.d:62-63): a `__dollar` of another function reached
//     from the literal makes `checkNestedReference` report and answer `true` (funcsem.d:4265-4268).
//   - `lambdaCheckForNestedRef` (delegatize.d:205): the walk visits variable references (VarExp,
//     SymOffExp, ThisExp, DeclarationExp), recurses into a DeclarationExp's ExpInitializer, and keeps
//     the answer of the LAST node it visits (the FAITHFUL QUIRK in the delegatize.ts header).

import { beforeEach, describe, expect, test } from "vitest";

import "./parse.js"; // module-graph ROOT — first import of any core-SCC test file (10 §1.5)

import { ensureStaticLinkTo, lambdaCheckForNestedRef, toDelegate } from "./delegatize.js";

import { ds, dsToJs } from "../dstring.js";
import { initSemaHarness, userBody } from "../sema-harness.js";
import { LINK, MODFlags, STC, VarArg } from "./astenums.js";
import { VarDeclaration } from "./declaration.js";
import { moduleFromParse } from "./dmodule.js";
import type { Module } from "./dmodule.js";
import type { Dsymbol } from "./dsymbol.js";
import { scopeCreateGlobal } from "./dsymbolsem.js";
import { StructDeclaration } from "./dstruct.js";
import {
    AddExp,
    DeclarationExp,
    ErrorExp,
    Expression,
    IndexExp,
    IntegerExp,
    SliceExp,
    SymOffExp,
    ThisExp,
    VarExp,
} from "./expression.js";
import { FuncDeclaration, FuncLiteralDeclaration } from "./func.js";
import { global } from "./globals.js";
import { Identifier } from "./identifier.js";
import { setDiagnosticHandler } from "./errors.js";
import { ExpInitializer } from "./init.js";
import { Loc } from "./location.js";
import { ParameterList, Type, TypeFunction } from "./mtype.js";
import { ExpStatement, ReturnStatement } from "./statement.js";
import type { Scope } from "./dscope.js";
import { TOK } from "./tokens.js";
import { arrayOf, wildOf } from "./typesem.js";
import { Array as DArray } from "./root/array.js";
import { dmdformat } from "./root/dmdformat.js";

beforeEach(() => {
    initSemaHarness();
});

function id(name: string): Identifier {
    return Identifier.idPool(ds(name));
}

function emptyModule(): Module {
    return moduleFromParse(new DArray<Dsymbol | null>(), null);
}

// CASCADE NOTE (02 §11.5, whitelist item 1; file-level note per 02 §11.5c "comment scale"): two D
// field-shadowing pairs make a `Module` and a `StructDeclaration` fail TS's structural check against
// `Dsymbol` although they ARE Dsymbols — `Module.errors` (uint) shadows `Dsymbol.errors` (bool), and
// `AggregateDeclaration.deferred` (Dsymbol) shadows `Dsymbol.deferred` (bool). Every
// `as unknown as Dsymbol` in this file is one of these two upcasts, written at its use site.

function intExp(v: number): Expression {
    return new IntegerExp(Loc.initial, BigInt(v), Type.tint32!);
}

/** funcsem.d:4267 — the report for a `__dollar` referenced from another function (typo is D's). */
const DOLLAR_ERROR = "Error: cannnot use `$` inside a function literal";

/** Runs `fn` with diagnostics captured as `<header><message>` strings (the safe.test.ts convention). */
function captureDiags(fn: () => void): string[] {
    const diags: string[] = [];
    setDiagnosticHandler((_loc, _color, header, messageFormat, args) => {
        diags.push(dsToJs(header) + dsToJs(dmdformat(messageFormat, [...args])));
        return true;
    });
    try {
        fn();
    } finally {
        setDiagnosticHandler(null);
    }
    return diags;
}

/** `int <name>()` as a bare FuncDeclaration parented to `parent` (no semantic run). */
function makeFunc(name: string, parent: Dsymbol): FuncDeclaration {
    const tf = new TypeFunction(new ParameterList(null, VarArg.none), Type.tint32, LINK.d);
    const f = new FuncDeclaration(Loc.initial, Loc.initial, id(name), STC.none, tf);
    f.parent = parent;
    return f;
}

/** A function literal with the given `tok`, parented to `parent`. */
function makeLiteral(tok: TOK, parent: Dsymbol): FuncLiteralDeclaration {
    const tf = new TypeFunction(new ParameterList(null, VarArg.none), Type.tint32, LINK.d);
    const fld = new FuncLiteralDeclaration(Loc.initial, Loc.initial, tf, tok, null);
    fld.parent = parent;
    return fld;
}

/** An `int` local variable parented to `parent` (no semantic run). */
function makeLocal(name: string, parent: Dsymbol, init: Expression | null = null): VarDeclaration {
    const ei = init !== null ? new ExpInitializer(Loc.initial, init) : null;
    const v = new VarDeclaration(Loc.initial, Type.tint32, id(name), ei);
    v.parent = parent;
    return v;
}

/**
 * A scope whose current function is `f` — the shape `toDelegate` and `checkNestedReference` read
 * (`sc.parent`, `sc.func`). It needs no semantic pass over `m`: `scopeCreateGlobal` supplies the
 * global `scopesym` with its own `symtab` (dsymbolsem.ts:878-886), and with `sc.parent = f` the
 * function-literal identifier goes into `f.localsymtab`, which `genIdent` creates lazily.
 */
function scopeIn(m: Module, f: FuncDeclaration): Scope {
    const sc = scopeCreateGlobal(m, global.errorSink!).push();
    sc.parent = f;
    sc.func = f;
    return sc;
}

describe("delegatize.ts — module-load smoke (10 §1.6b)", () => {
    test("importing the module executes its top-level and exposes the D surface", () => {
        // Both visitor classes are NESTED inside their functions, so a load-order regression in the
        // visitor root surfaces on first CALL; the lambdaCheckForNestedRef pins below are the canary.
        expect(typeof Expression).toBe("function"); // 10 §1.5 — names the graph-root regression
        expect(typeof toDelegate).toBe("function");
        expect(typeof lambdaCheckForNestedRef).toBe("function");
        expect(typeof ensureStaticLinkTo).toBe("function");
    });
});

describe("ensureStaticLinkTo (delegatize.d:284)", () => {
    test("s == p is an immediate hit (delegatize.d:288)", () => {
        const f = makeFunc("f", emptyModule() as unknown as Dsymbol);
        expect(ensureStaticLinkTo(f, f)).toBe(true);
    });

    test("walks a nested literal up to its enclosing function and makes it a delegate (issue 15332)", () => {
        // An inferred literal (`TOK.reserved`) is nested (func.d:906: tok != function_ && !isThis()),
        // so the walk passes it (delegatize.d:293), rewrites its tok (:299) and reaches `f` via
        // `toParentP` (:306).
        const f = makeFunc("f", emptyModule() as unknown as Dsymbol);
        const lit = makeLiteral(TOK.reserved, f);
        expect(ensureStaticLinkTo(lit, f)).toBe(true);
        expect(lit.tok).toBe(TOK.delegate_);
    });

    test("a `function` literal is neither member nor nested: the walk breaks (delegatize.d:293-294)", () => {
        const f = makeFunc("f", emptyModule() as unknown as Dsymbol);
        const lit = makeLiteral(TOK.function_, f);
        expect(ensureStaticLinkTo(lit, f)).toBe(false);
        expect(lit.tok).toBe(TOK.function_); // the break precedes the :299 rewrite
    });

    test("a literal passed on the way up is rewritten even when the walk then fails", () => {
        // lit -> g (a module-level function: not nested, not a member) -> break; `p` is never met.
        const m = emptyModule();
        const g = makeFunc("g", m as unknown as Dsymbol);
        const lit = makeLiteral(TOK.reserved, g);
        const unrelated = makeFunc("h", m as unknown as Dsymbol);
        expect(ensureStaticLinkTo(lit, unrelated)).toBe(false);
        expect(lit.tok).toBe(TOK.delegate_);
    });

    test("a `static` aggregate stops the walk; a non-static one is walked through (delegatize.d:301-305)", () => {
        const f = makeFunc("f", emptyModule() as unknown as Dsymbol);
        const S = new StructDeclaration(Loc.initial, id("S"), false);
        S.parent = f;
        expect(ensureStaticLinkTo(S as unknown as Dsymbol, f)).toBe(true);

        const T = new StructDeclaration(Loc.initial, id("T"), false);
        T.parent = f;
        T.storage_class = STC.static_;
        expect(ensureStaticLinkTo(T as unknown as Dsymbol, f)).toBe(false);
    });
});

describe("toDelegate (delegatize.d:48) — the lowering and the FuncExp it returns", () => {
    /**
     * Runs `toDelegate(e, t, sc)` inside `int f()` over `e = DeclarationExp(v)`, where `v`'s
     * initializer declares `w` (`int v = (int w);`, AST-only), and returns its result together with
     * the literal it built, read off the re-parented `v`. `v` sits in `f.closureVars`. `e.type` is
     * preset, as for an argument that has been through semantic already (the expressionsem re-entry
     * returns at once). The final `expressionSemantic` runs semantic3 over the literal's body and
     * types the delegate.
     */
    interface Lowered {
        r: Expression;
        lit: FuncLiteralDeclaration;
        e: DeclarationExp;
        f: FuncDeclaration;
        v: VarDeclaration;
        w: VarDeclaration;
    }
    function lowerDecl(t: Type): Lowered {
        const m = emptyModule();
        const f = makeFunc("f", m as unknown as Dsymbol);
        const w = makeLocal("w", f);
        const v = makeLocal("v", f, new DeclarationExp(Loc.initial, w));
        f.closureVars.push(v);
        const e = new DeclarationExp(Loc.initial, v);
        e.type = t;
        const r = toDelegate(e, t, scopeIn(m, f));
        const lit = v.parent!.isFuncDeclaration()!.isFuncLiteralDeclaration()!;
        return { r, lit, e, f, v, w };
    }

    test("non-void `t`: a `delegate` literal returning `t` whose body is `return e;` (delegatize.d:52-69)", () => {
        const { lit, e } = lowerDecl(Type.tint32!);
        expect(lit.tok).toBe(TOK.delegate_);
        const tf = lit.type!.isTypeFunction()!;
        expect(tf.next).toBe(Type.tint32);
        expect(tf.parameterList.length()).toBe(0);
        expect(tf.mod).toBe(0);
        const body = userBody(lit); // semantic3 already wrapped the body (sema-harness.ts userBody)
        expect(body).toBeInstanceOf(ReturnStatement);
        expect(body.isReturnStatement()!.exp).toBe(e); // the test's own node, not a copy
    });

    // delegatize.d:70-72 — `e = new FuncExp(loc, fld); e = e.expressionSemantic(sc); return e;`.
    test("returns the semantic'd FuncExp over the literal, typed as the delegate (delegatize.d:70-72)", () => {
        const { r, lit } = lowerDecl(Type.tint32!);
        const fe = r.isFuncExp()!;
        expect(fe).not.toBeNull();
        expect(fe.fd).toBe(lit);
        expect(lit.tok).toBe(TOK.delegate_);
        // expressionsem.d:7303 names a `delegate_` literal `__dgliteral`; identifier.d:231 appends
        // `_L<line>_C<col>` of `e.loc` (Loc.initial here), with no counter on first use.
        expect(lit.ident!.toString()).toEqual(ds("__dgliteral_L0_C0"));
        const td = r.type!.isTypeDelegate()!;
        expect(td).not.toBeNull();
        expect(td.next).toBe(lit.type);
        // ldc2 1.43.0: `typeof(delegate int() => 1).mangleof` is `DFNaNbNiNfZi`, and -vcg-ast prints the
        // lazy argument as `delegate int() pure nothrow @nogc @safe` (attributes inferred by semantic3).
        expect(r.type!.deco).toBe("DFNaNbNiNfZi");
        expect(global.errors).toBe(0);
    });

    test("void `t`: the body is the expression statement `e;` (delegatize.d:66-67)", () => {
        const { r, lit, e } = lowerDecl(Type.tvoid!);
        const body = userBody(lit);
        expect(body).toBeInstanceOf(ExpStatement);
        expect(body.isExpStatement()!.exp).toBe(e);
        expect(r.type!.deco).toBe("DFNaNbNiNfZv"); // ldc2 -vcg-ast: `delegate void() pure nothrow @nogc @safe`
    });

    test("a wild return type makes the delegate's function type wild (delegatize.d:53-54)", () => {
        const { lit } = lowerDecl(wildOf(Type.tint32!));
        expect(lit.type!.isTypeFunction()!.mod).toBe(MODFlags.wild);
    });

    // delegatize.d:93-110 (setParent), :122-126 (DeclarationExp), :152-165 (VarDeclaration, ExpInitializer).
    test("LambdaSetParent re-parents nested declarations and moves the closure var", () => {
        const { lit, f, v, w } = lowerDecl(Type.tint32!);
        expect(v.parent).toBe(lit);
        expect(w.parent).toBe(lit); // reached through visitVarDeclaration -> visitExpInitializer -> walk
        expect(f.closureVars.length).toBe(0);
        expect(lit.closureVars.length).toBe(1);
        expect(lit.closureVars.opIndex(0)).toBe(v);
    });

    // delegatize.d:59-63 — `bool r = lambdaCheckForNestedRef(e, sc); … if (r) return ErrorExp.get();`.
    // `e` names the `__dollar` of another function `g` and is not re-parented (only a lengthVar is),
    // so checkNestedReference reports it and answers `true` (funcsem.d:4265-4268).
    test("a nested reference that errors makes toDelegate return ErrorExp (delegatize.d:62-63)", () => {
        const m = emptyModule();
        const f = makeFunc("f", m as unknown as Dsymbol);
        const g = makeFunc("g", m as unknown as Dsymbol);
        const dollar = makeLocal("__dollar", g);
        const e = new VarExp(Loc.initial, dollar);
        e.type = Type.tint32;
        const diags = captureDiags(() => expect(toDelegate(e, Type.tint32!, scopeIn(m, f))).toBe(ErrorExp.get()));
        expect(diags).toEqual([DOLLAR_ERROR]);
    });

    // delegatize.d:128-146 — the IndexExp and SliceExp `lengthVar` arms. ldc2 1.43.0 accepts
    // `take(arr[$-1])` and `take(arr[0 .. $][0])` for `lazy int` and prints `__dollar` inside each
    // delegate literal (-vcg-ast). The two nodes are carried in a declaration's initializer so the
    // literal's body stays the pre-typed DeclarationExp of `lowerDecl`, and no var reference is added.
    test("LambdaSetParent moves the `__dollar` of an IndexExp and of a SliceExp into the literal", () => {
        const m = emptyModule();
        const f = makeFunc("f", m as unknown as Dsymbol);
        const dollarIndex = makeLocal("__dollar", f);
        const dollarSlice = makeLocal("__dollar", f);
        const se = new SliceExp(Loc.initial, intExp(0), intExp(0), intExp(1));
        se.lengthVar = dollarSlice;
        se.type = arrayOf(Type.tint32!); // typed as after semantic: semantic3's @nogc walk reads it
        const ie = new IndexExp(Loc.initial, se, intExp(0));
        ie.lengthVar = dollarIndex;
        ie.type = Type.tint32;
        const v = makeLocal("v", f, ie);
        const e = new DeclarationExp(Loc.initial, v);
        e.type = Type.tint32;
        expect(toDelegate(e, Type.tint32!, scopeIn(m, f)).isFuncExp()).not.toBeNull();
        const lit = v.parent!.isFuncDeclaration()!.isFuncLiteralDeclaration()!;
        expect(dollarIndex.parent).toBe(lit);
        expect(dollarSlice.parent).toBe(lit);
    });
});

describe("lambdaCheckForNestedRef (delegatize.d:205)", () => {
    /**
     * `f` and `g` are module-level functions, `w` a local of `g`, and the scope is `f`'s. A reference
     * to `w` runs checkNestedReference past its early-outs (funcsem.d:4217-4227): the static-link walk
     * from `f` breaks (`f` is neither nested nor a member), `fdv = g` differs from `f`, and the
     * Loc.initial the visitor passes skips getLevelAndCheck (funcsem.d:4240). The reference is then
     * recorded (funcsem.d:4247-4261) and the answer is `false`: `w` is neither `__dollar` nor `__withSym`.
     */
    function nestedRef(build: (w: VarDeclaration, f: FuncDeclaration) => Expression): {
        r: boolean;
        f: FuncDeclaration;
        g: FuncDeclaration;
        w: VarDeclaration;
    } {
        const m = emptyModule();
        const f = makeFunc("f", m as unknown as Dsymbol);
        const g = makeFunc("g", m as unknown as Dsymbol);
        const w = makeLocal("w", g);
        const r = lambdaCheckForNestedRef(build(w, f), scopeIn(m, f));
        return { r, f, g, w };
    }

    function expectRecorded(x: { r: boolean; f: FuncDeclaration; g: FuncDeclaration; w: VarDeclaration }): void {
        expect(x.r).toBe(false);
        expect(x.w.nestedrefs.contains(x.f)).toBe(true);
        expect(x.g.closureVars.contains(x.w)).toBe(true);
        expect(x.f.outerVars.contains(x.w)).toBe(true);
    }

    test("the VarExp, SymOffExp and ThisExp arms each run checkNestedReference (delegatize.d:223-239)", () => {
        // A missing arm would route the node to the empty visitExpression: nothing would be recorded.
        expectRecorded(nestedRef((w) => new VarExp(Loc.initial, w)));
        expectRecorded(nestedRef((w) => new SymOffExp(Loc.initial, w, 0n)));
        expectRecorded(nestedRef((w) => {
            const te = new ThisExp(Loc.initial);
            te.var_ = w;
            return te;
        }));
    });

    test("a DeclarationExp's ExpInitializer is walked too (delegatize.d:257-261)", () => {
        // `y`'s own reference is local (checkNestedReference returns at funcsem.d:4219-4220), so the
        // walk descends into its initializer and meets `w`, which is recorded as above.
        expectRecorded(nestedRef((w, f) => {
            const y = makeLocal("y", f, new VarExp(Loc.initial, w));
            return new DeclarationExp(Loc.initial, y);
        }));
    });

    // FAITHFUL QUIRK (delegatize.ts header): the visitor never sets `stop` and every arm overwrites
    // `result`, so the postorder walk answers with its last variable reference. `d` (the `__dollar` of
    // `g`) answers `true` after reporting (funcsem.d:4265-4268); `w` answers `false`.
    test("the last reference visited decides the answer; an earlier `true` is overwritten", () => {
        const m = emptyModule();
        const f = makeFunc("f", m as unknown as Dsymbol);
        const g = makeFunc("g", m as unknown as Dsymbol);
        const d = makeLocal("__dollar", g);
        const w = makeLocal("w", g);
        const sc = scopeIn(m, f);
        const dollarFirst = new AddExp(Loc.initial, new VarExp(Loc.initial, d), new VarExp(Loc.initial, w));
        const dollarLast = new AddExp(Loc.initial, new VarExp(Loc.initial, w), new VarExp(Loc.initial, d));
        let r1 = true;
        let r2 = false;
        expect(captureDiags(() => { r1 = lambdaCheckForNestedRef(dollarFirst, sc); })).toEqual([DOLLAR_ERROR]);
        expect(captureDiags(() => { r2 = lambdaCheckForNestedRef(dollarLast, sc); })).toEqual([DOLLAR_ERROR]);
        expect(r1).toBe(false);
        expect(r2).toBe(true);
    });
});
