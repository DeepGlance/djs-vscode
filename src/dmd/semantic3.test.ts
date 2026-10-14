// Co-located tests for src/dmd/semantic3.ts.
//
// dmd/semantic3.d carries ZERO in-source `unittest{}` blocks (verified: `grep -c '^unittest'
// semantic3.d` -> 0), so this file is the THIN FLEET ARTIFACT of 10 §1.6b: one module-load smoke
// test plus one behaviour pin per risky RESOLVED CONSTRUCT of the translation, one `test()` per
// CONCERN. No new harness machinery, and no fabricated pins for paths the harness cannot reach
// honestly — the sema corpus suites (sema.func.test.ts, sema.rung3.test.ts, sema.callexp.test.ts)
// are the oracle for the live `visit(FuncDeclaration)` spine.
//
// Harness init follows the canonical snippet (10 §1.5): Loc._init() + initTokens() + Id.initialize()
// + Type._init().

import { beforeEach, describe, expect, test } from "vitest";

// MODULE-GRAPH ROOT (harness convention, not a semantic3 requirement): every sema.*.test.ts opens
// with `./parse.js` because the core SCC's deferred value-imports (01 §4.3/§4.5) only settle when
// the graph is entered from the parser side. Verified tree-wide: entering from `./dsymbolsem.js`
// alone fails the same way (cond.ts -> func.ts, `Declaration` still undefined), so this is a
// pre-existing property of the SCC, not of this file.
import "./parse.js";

import {
    FuncDeclSem3,
    LOG,
    Semantic3Visitor,
    checkClosure,
    findClosureVars,
    search_toString,
    semantic3,
    semanticRTInfo,
    semanticTypeInfoMembers,
} from "./semantic3.js";

import { LINK, STC, VarArg } from "./astenums.js";
import { FuncDeclaration } from "./func.js";
import { ParameterList, Type, TypeFunction } from "./mtype.js";
import { Scope } from "./dscope.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { initTokens } from "./tokens.js";
import { global } from "./globals.js";
import { ds } from "../dstring.js";
import type { Dsymbol } from "./dsymbol.js";
import type { VarDeclaration } from "./declaration.js";
import { Type_init } from "./typesem.js";

beforeEach(() => {
    Loc._init();
    initTokens();
    Id.initialize();
    Type_init();
});

function id(name: string): Identifier {
    return Identifier.idPool(ds(name));
}

/** A bare module-level `<ret> <name>()` FuncDeclaration (no semantic run). */
function makeFunc(name: string, ret: Type): FuncDeclaration {
    const tf = new TypeFunction(new ParameterList(null, VarArg.none), ret, LINK.d);
    return new FuncDeclaration(Loc.initial, Loc.initial, id(name), STC.none, tf);
}

describe("semantic3.ts — module-load smoke (10 §1.6b)", () => {
    test("importing the module executes its top-level and exposes the whole D surface", () => {
        // semantic3.d's TS port has module-level state (the `__gshared TypeFunction tftostring`
        // hoisted out of `search_toString`, 01 §5.5) and a very wide import list spanning the core
        // SCC — a load-order/cycle regression shows up right here.
        expect(typeof semantic3).toBe("function");
        expect(typeof Semantic3Visitor).toBe("function");
        expect(typeof FuncDeclSem3).toBe("function");
        expect(typeof search_toString).toBe("function");
        expect(typeof semanticTypeInfoMembers).toBe("function");
        expect(typeof semanticRTInfo).toBe("function");
        expect(typeof checkClosure).toBe("function");
        expect(typeof findClosureVars).toBe("function");
    });
});

describe("semantic3.ts — resolved constructs", () => {
    // CONCERN 1 — `enum LOG = false;` (semantic3.d:87) is a manifest constant (02 §4.1), and it is
    // the input that resolves the THREE `static if (LOG)` printf blocks (semantic3.d:113, :179,
    // :1599) OFF at translation time (07 §3). If this ever flips, those blocks must come back.
    test("LOG is the manifest constant `false` that resolves the three static-if printf blocks off", () => {
        expect(LOG).toBe(false);
    });

    // CONCERN 2 — `override void visit(Dsymbol) {}` (semantic3.d:109) is an EMPTY body, not an
    // assert: most symbols simply have no semantic3 work. The visitor must also leave its `sc`
    // cursor untouched on that path (the field IS the pass's scope cursor).
    test("visitDsymbol is a no-op and leaves the visitor's `sc` cursor untouched", () => {
        const sc = new Scope();
        const v = new Semantic3Visitor(sc);
        const dummy = makeFunc("dummy", Type.tint32) as unknown as Dsymbol;
        expect(() => v.visitDsymbol(dummy)).not.toThrow();
        expect(v.sc).toBe(sc);
    });

    // CONCERN 3 — `FuncDeclSem3.addReturn0()` (semantic3.d:1775) decides whether `return 0;` is
    // appended. Two live legs, both reachable without running semantic: a `void main()` gets the
    // implicit `return 0`, a plain `int f()` does not. The `sc.inCfile && isCMain()` C11 leg is the
    // third and stays off for a D-linkage function.
    test("FuncDeclSem3.addReturn0: true for `void main()`, false for a plain `int f()`", () => {
        const sc = new Scope();
        const mainFd = makeFunc("main", Type.tvoid);
        expect(new FuncDeclSem3(mainFd, sc).addReturn0()).toBe(true);

        const intFd = makeFunc("f", Type.tint32);
        expect(new FuncDeclSem3(intFd, sc).addReturn0()).toBe(false);
    });

    // CONCERN 4 — `FuncDeclSem3` is a plain D VALUE struct (semantic3.d:1741; no postblit, no
    // opAssign, no copy-ctor), so `.copy()` is the per-field recursion of 03 §2: both fields are
    // references and must be SHARED by the copy, never cloned.
    test("FuncDeclSem3.copy() is a fresh object that shares both reference fields (03 §2)", () => {
        const sc = new Scope();
        const fd = makeFunc("f", Type.tint32);
        const a = new FuncDeclSem3(fd, sc);
        const b = a.copy();
        expect(b).not.toBe(a);
        expect(b.funcdecl).toBe(fd);
        expect(b.sc).toBe(sc);
    });

    // CONCERN 5 — `findClosureVars` (semantic3.d:1961) drives its `sink` delegate from
    // `fd.closureVars`; with no closure variables the outer `foreach` body never runs, so the sink
    // is never called and the labelled `break LcheckAncestorsOfANestedRef` (the one label in this
    // file, 06 §6) is never reached.
    test("findClosureVars never calls the sink when the function has no closureVars", () => {
        const fd = makeFunc("f", Type.tint32);
        let calls = 0;
        findClosureVars(fd, (_f: FuncDeclaration, _v: VarDeclaration) => { calls++; });
        expect(calls).toBe(0);
    });

    // CONCERN 6 — `checkClosure` (semantic3.d:1916) short-circuits on `if (!fd.needsClosure())
    // return false;` BEFORE reaching `setGC` and the two nogc free functions `printGCUsage`
    // (nogc.d:307) and `vgcEnabled` (nogc.d:298) — both walls until the end-of-wave sweep, both LIVE
    // calls now. A function that captures nothing must therefore return false without throwing.
    test("checkClosure returns false, without throwing, for a function that needs no closure", () => {
        const fd = makeFunc("f", Type.tint32);
        expect(checkClosure(fd)).toBe(false);
    });

    // CONCERN 7 — `search_toString` (semantic3.d:1797) is a module-level FREE FUNCTION and stays
    // one (04 §6 anti-pattern: never promoted onto StructDeclaration). expressionsem.ts:21593
    // carries a wall waiting on exactly this export, so the SHAPE is the contract.
    test("search_toString is a free function of this module, not a StructDeclaration method (04 §6)", () => {
        expect(typeof search_toString).toBe("function");
        expect(search_toString.length).toBe(1); // one parameter: the StructDeclaration receiver
    });

    // CONCERN 8 — `version (FastDFA)` is ON (semantic3.d:81-85: `version (IN_GCC)` is OFF, so
    // `version = FastDFA;` is set), so the guard at semantic3.d:1478 is emitted; its RUNTIME gate is
    // `global.params.useFastDFA`, which is off by default, so `dfaEntry` (dfa/entry.ts) stays off the
    // ordinary analysis path.
    test("the FastDFA guard's runtime gate `global.params.useFastDFA` is off by default", () => {
        expect(global.params.useFastDFA).toBe(false);
    });

    // CONCERN 9 — WALL-INDUCED EXIT PATHS (11 §2.5). semantic3.d:284-295 brackets the recursive
    // `semantic3` of a generated `opAssign` with a `startGagging`/`endGagging` pair AND an
    // `inuse` inc/dec. D needs no `scope(exit)` there because nothing in that region throws; the
    // port's walls DO throw, and `global.gag` is process-global — a leak silences every later
    // diagnostic in the process, and a leaked `inuse` permanently closes the semantic3.d:276 gate.
    // So both pairs are a try/finally here. This pin exercises the throwing path: the inner call
    // dies on the null root scope, and both counters must be back to their entry values.
    // (Verified to FAIL without the try/finally: gag 0 -> 1, inuse 0 -> 1.)
    test("an exception out of the gagged opAssign region leaks neither `global.gag` nor `inuse`", () => {
        const tf = new TypeFunction(new ParameterList(null, VarArg.none), Type.tvoid, LINK.d);
        const fd = new FuncDeclaration(Loc.initial, Loc.initial, Id.opAssign!, STC.inference, tf);
        fd.parent = makeFunc("outer", Type.tvoid);
        const gagBefore = global.gag;

        expect(() => semantic3(fd, null)).toThrow();

        expect(global.gag).toBe(gagBefore);
        expect(fd.inuse).toBe(0);
    });
});
