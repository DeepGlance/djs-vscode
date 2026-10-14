// Co-located tests for src/dmd/semantic2.ts (dmd/semantic2.d).
//
// `dmd/semantic2.d` contains ZERO in-source `unittest{}` blocks (verified: `grep -c '^unittest'`
// on dmd/semantic2.d returns 0), so per 10 §1.6b this file is the thin test file: one
// module-load smoke test plus one behaviour pin per risky RESOLVED CONSTRUCT — one `test()` per
// CONCERN so a red gate names the right pin. No new harness machinery is built here; every pin
// uses the existing conventions (the 10 §1.5 init snippet, `ErrorSinkNull`, `globalScope()`).
//
// The risky constructs this file resolves, and where each is pinned below:
//   - IDIOM A (13 §1/§2): the D overload set `visit(X)` became named `visit<X>` methods, and every
//     node's `accept` calls ITS OWN name. Pinned three ways: a node WITHOUT a semantic2 override
//     falls through the base-forward chain to the empty `visitDsymbol`; `Nspace`/`Import` reach
//     THEIR overrides (observable through `semanticRun` / the absence of a null deref).
//   - the `visit(cast(VarDeclaration)bfd)` base-overload forward (13 §4) that opens
//     `visitBitFieldDeclaration` — pinned on the VarDeclaration leg's early return.
//   - the Form-B overload split of D's two same-arity `lowerStaticAAs` (04 §1B): both halves are
//     callable and both no-op on a non-AA payload, which also pins that `StaticAAVisitor` really
//     extends `SemanticTimeTransitiveVisitor` (a wrong base would assert/throw at the root).
//   - `findFunc` emitted as a FREE function (04 §6) plus the `fdmatch`/`fdambig` one-slot boxes
//     (02 §11.4) and the `baseClass` cursor walk (02 §10.1).
//   - the bitfield representability check (dmd/semantic2.d:343-351): an accept behaviour pin and a
//     reject behaviour pin (the error text at :354 and its supplemental), both against ldc2 1.43.
//   - `staticAssertFail`'s msgs loop through the live `ctfeInterpretForPragmaMsg` (dmd/semantic2.d:1055),
//     pinned to the ldc2 report and the `fatal()` stop.

import { describe, test, expect, beforeEach } from "vitest";
import { Loc } from "./location.js";
import { initTokens } from "./tokens.js";
import { Id } from "./id.js";
import { Type } from "./mtype.js";
import { global } from "./globals.js";
import { ErrorSinkNull } from "./errorsink.js";
import { FatalError, setDiagnosticHandler, setFatalErrorHandler, throwFatalError } from "./errors.js";
import { dmdformat } from "./root/dmdformat.js";
import { dsToJs } from "../dstring.js";
import { Identifier } from "./identifier.js";
import { DSYM, Dsymbol, PASS } from "./dsymbol.js";
import { Nspace } from "./nspace.js";
import { Import } from "./dimport.js";
import { ClassDeclaration } from "./dclass.js";
import { FuncDeclaration } from "./func.js";
import { BitFieldDeclaration, VarDeclaration } from "./declaration.js";
import { ExpInitializer, VoidInitializer } from "./init.js";
import { IntegerExp } from "./expression.js";
import { ParameterList, TypeFunction } from "./mtype.js";
import { LINK, STC, VarArg } from "./astenums.js";
import { StaticAssert } from "./staticassert.js";
import { Scope } from "./dscope.js";
import { moduleFromParse } from "./dmodule.js";
import { Array as DArray } from "./root/array.js";

import {
    Semantic2Visitor,
    StaticAAVisitor,
    findFunc,
    lowerStaticAAs,
    lowerStaticAAsExpression,
    semantic2,
    staticAssertFail,
} from "./semantic2.js";

import type { Dsymbols, Expressions } from "./arraytypes.js";
import type { Expression } from "./expression.js";
import { Type_init } from "./typesem.js";
import { scopeCreateGlobal } from "./dsymbolsem.js";

beforeEach(() => {
    // 10 §1.5 — the canonical init snippet, in the ORDER contract of 01 §5.2.
    Loc._init();
    initTokens();
    Id.initialize();
    Type_init();
    global.errorSink = new ErrorSinkNull();
    global.errors = 0;
    global.gag = 0;
});

const loc = (): Loc => Loc.initial;

function id(name: string): Identifier {
    return Identifier.idPool(Uint8Array.from(Array.from(name, (c) => c.charCodeAt(0))));
}

/**
 * A real global `Scope` over a bare module — the tree's existing convention (precedent:
 * initsem.test.ts / sema.var.test.ts). 10 §1.9 forbids placeholder `undefined as unknown as T`
 * arguments, so every `Scope*` parameter below gets a genuine scope.
 */
function globalScope(): Scope {
    const members: Dsymbols = new DArray<Dsymbol | null>();
    const m = moduleFromParse(members, null);
    return scopeCreateGlobal(m, global.errorSink!);
}

describe("semantic2.d — module load (§1.6b)", () => {
    test("the module loads and its whole export surface is callable", () => {
        // semantic2 sits in the core SCC and value-imports dsymbolsem / expressionsem / initsem /
        // funcsem / dcast / typesem / mangle, every one of which imports back. A load-order or
        // import-cycle regression surfaces here at import time, before any behaviour runs.
        expect(typeof semantic2).toBe("function");
        expect(typeof findFunc).toBe("function");
        expect(typeof lowerStaticAAs).toBe("function");
        expect(typeof lowerStaticAAsExpression).toBe("function");
        expect(typeof staticAssertFail).toBe("function");
        expect(typeof Semantic2Visitor).toBe("function");
        expect(typeof StaticAAVisitor).toBe("function");
    });
});

describe("Idiom-A dispatch: accept -> the node's OWN visit<X> (13 §1/§2)", () => {
    test("a symbol with no semantic2 override falls through to the empty visitDsymbol (semantic2.d:94)", () => {
        // `Dsymbol.accept` calls `v.visitDsymbol(this)`; the override at semantic2.d:94 is `{}`.
        // Nothing may be mutated and nothing may throw — the whole pass is a no-op for such symbols.
        const s = new Dsymbol(DSYM.dsymbol, loc(), id("plain"));
        const before = s.semanticRun;
        expect(() => semantic2(s, null)).not.toThrow();
        expect(s.semanticRun).toBe(before);
    });

    test("Nspace reaches visitNspace and is marked PASS.semantic2 (semantic2.d:548)", () => {
        // `members == null` is D's early return at semantic2.d:559-560, reached AFTER the
        // `semanticRun` store (:552) and the `checkGNUABITag(ns, LINK.cpp)` call (:558). Observing
        // the store is what proves the dispatch landed on visitNspace and not on the base no-op.
        const ns = new Nspace(loc(), id("Outer"), null, null);
        expect(ns.semanticRun).toBe(PASS.initial);
        semantic2(ns, null);
        expect(ns.semanticRun).toBe(PASS.semantic2);
        // Second entry takes the `semanticRun >= PASS.semantic2` guard at semantic2.d:550.
        semantic2(ns, null);
        expect(ns.semanticRun).toBe(PASS.semantic2);
    });

    test("Import with a null `mod` returns before dereferencing it (semantic2.d:536)", () => {
        // D: `if (!i.mod) return;` — a pointer test (06 §2.7). Were the guard dropped, the very
        // next statement (`i.mod.semantic2(null)`) would throw a TypeError here.
        const imp = new Import(loc(), null, id("mymod"), null, 0);
        expect(imp.mod).toBe(null);
        expect(() => semantic2(imp, null)).not.toThrow();
    });
});

describe("visitBitFieldDeclaration — the base-overload forward (13 §4, semantic2.d:325)", () => {
    test("the VarDeclaration leg's early return leaves the bitfield tail unreached", () => {
        // `visit(cast(VarDeclaration)bfd)` runs FIRST. With `semanticRun < semanticdone && inuse`
        // (semantic2.d:216) that leg returns immediately — so `semanticRun` is never advanced and
        // the `semanticRun != PASS.semantic2done` guard at :326 returns before any bitfield work.
        // Reaching the tail instead would run the representability check pinned below.
        const bfd = new BitFieldDeclaration(loc(), Type.tint32!, id("b"), new IntegerExp(loc(), 4n, Type.tint32!));
        bfd.semanticRun = PASS.initial;
        bfd.inuse = 1;
        expect(() => semantic2(bfd, null)).not.toThrow();
        expect(bfd.semanticRun).toBe(PASS.initial);
    });

    /** A bitfield `int b : 4 = <init>` whose VarDeclaration leg completes (see the pins below). */
    function intBitfield(init: bigint): BitFieldDeclaration {
        const owner = new FuncDeclaration(loc(), loc(), id("f"), STC.none,
            new TypeFunction(new ParameterList(null, VarArg.none), Type.tvoid!, LINK.d));
        const ei = new ExpInitializer(loc(), new IntegerExp(loc(), init, Type.tint32!));
        const bfd = new BitFieldDeclaration(loc(), Type.tint32!, id("b"),
            new IntegerExp(loc(), 4n, Type.tint32!), ei);
        bfd.fieldWidth = 4;
        bfd.semanticRun = PASS.semanticdone;
        bfd.parent = owner;
        return bfd;
    }

    // The D path taken by both pins: visit(VarDeclaration) completes (parent is a FuncDeclaration, so
    // the `initializerSemantic` block at :233 is skipped; not manifest, not thread-local) and stores
    // PASS.semantic2done at :320; then :326-:340 all pass (fieldWidth != 0, an ExpInitializer holding
    // an IntegerExp), :343 `getIntRange(ei.exp)` runs and :351 tests `bounds.contains(value)`.
    // RE-PIN (10 §1.8 rule 7): these replace the wall pin on dcast's `_cast -> IntRange.castSigned`
    // and the §2 escalation over `IntRange.contains` at :351 — both callees are live now.
    test("a representable initializer passes the check silently (semantic2.d:351, ldc2 1.43 accepts)", () => {
        // ldc2 1.43: `struct T { int c : 4 = 3; }` inside a function compiles clean.
        const bfd = intBitfield(3n);
        expect(() => semantic2(bfd, globalScope())).not.toThrow();
        expect(bfd.semanticRun).toBe(PASS.semantic2done);
        expect(global.errors).toBe(0);
    });

    test("an unrepresentable initializer reports the ldc2 error and supplemental (semantic2.d:354/:360)", () => {
        // `contains` returns false for 9 against `int:4`'s [-8, 7], so D takes the error arm at :351.
        // RE-PIN (10 §1.8 rule 7), wave 11: this was a pin on expression.ts's wall over
        // `hdrgen.toChars(Expression)` (dmd/expression.d:216), the first argument of the error at
        // :354. That call is live now (hdrgen.d:204) and the arm completes. ldc2 1.43 on
        // `void f() { struct S { int b : 4 = 9; } }`:
        //   bf.d(1): Error: default initializer `9` is not representable as bitfield type `int:4`
        //   bf.d(1):        bitfield `b` default initializer must be a value between `-8..7`
        const messages: string[] = [];
        setDiagnosticHandler((_loc, _color, _header, messageFormat, args) => {
            messages.push(dsToJs(dmdformat(messageFormat, [...args])));
            return true;
        });
        try {
            semantic2(intBitfield(9n), globalScope());
        } finally {
            setDiagnosticHandler(null);
        }
        expect(messages).toEqual([
            "default initializer `9` is not representable as bitfield type `int:4`",
            "bitfield `b` default initializer must be a value between `-8..7`",
        ]);
        expect(global.errors).toBe(1);
    });
});

describe("lowerStaticAAs — the Form-B overload split (04 §1B, semantic2.d:980/:996)", () => {
    test("the VarDeclaration form no-ops when the initializer is not an ExpInitializer", () => {
        // semantic2.d:982 — `if (auto ei = vd._init.isExpInitializer())`; a VoidInitializer makes
        // the hoisted const null (06 §2.6) and no StaticAAVisitor is ever constructed.
        const vd = new VarDeclaration(loc(), Type.tint32!, id("v"), new VoidInitializer(loc()));
        expect(() => lowerStaticAAs(vd, globalScope())).not.toThrow();
    });

    test("the Expression form walks a non-AA expression and changes nothing", () => {
        // semantic2.d:998 — `scope v = new StaticAAVisitor(sc, STC.none); e.accept(v);`.
        // `IntegerExp.accept` -> `visitIntegerExp` -> ... -> the permissive root, i.e. a no-op.
        // A StaticAAVisitor built on the WRONG base (e.g. plain Visitor's assert roots) would
        // surface here as a throw.
        const e: Expression = new IntegerExp(loc(), 7n, Type.tint32!);
        expect(() => lowerStaticAAsExpression(e, globalScope())).not.toThrow();
        expect(e.op).toBe(new IntegerExp(loc(), 7n, Type.tint32!).op);
    });
});

describe("findFunc — free function + the closure-box locals (semantic2.d:863)", () => {
    test("an empty vtbl/vtblFinal chain yields null and reports no ambiguity", () => {
        // Exercises the whole shape with no matches: `searchVtbl(_this.vtbl)`, then the
        // `for (auto cd = _this; cd; cd = cd.baseClass)` cursor walk over `vtblFinal`
        // (`baseClass` is null here, so exactly one extra pass), then the `fdambig` test.
        // Both `fdmatch` and `fdambig` are read through their one-slot boxes (02 §11.4); a wrong
        // read there would either throw or return a stale value.
        const cd = new ClassDeclaration(loc(), id("C"), null, null, false);
        expect(cd.vtbl.length).toBe(0);
        expect(cd.vtblFinal.length).toBe(0);
        expect(cd.baseClass).toBe(null);

        const tf = new TypeFunction(new ParameterList(null, VarArg.none), Type.tvoid!, LINK.d);
        expect(findFunc(cd, id("foo"), tf)).toBe(null);
        expect(global.errors).toBe(0);
    });
});

describe("staticAssertFail (semantic2.d:1043)", () => {
    test("the msgs loop reports `static assert:  1` and ends in fatal() (semantic2.d:1055-1082)", () => {
        // RE-PIN (10 §1.8 rule 7), wave 14: this pinned the wall over `ctfeInterpretForPragmaMsg`
        // (dmd/dinterpret.d:133) at :1055. It is live now: an IntegerExp interprets to itself, the
        // `toStringExp` test at :1063 fails, so :1073 prints `e.toChars()`, :1075 reports, and
        // :1081-1082 call `fatal()` (not gagged). The fatal handler turns the exit into `FatalError`.
        // ldc2 1.43 on `static assert(0, 1);`:  sa.d(1): Error: static assert:  1   (exit 1)
        const sa = new StaticAssert(loc(), new IntegerExp(loc(), 0n, Type.tint32!), null);
        const msgs: Expressions = new DArray<Expression | null>();
        msgs.push(new IntegerExp(loc(), 1n, Type.tint32!));
        sa.msgs = msgs;

        const messages: string[] = [];
        setDiagnosticHandler((_loc, _color, _header, messageFormat, args) => {
            messages.push(dsToJs(dmdformat(messageFormat, [...args])));
            return true;
        });
        setFatalErrorHandler(throwFatalError);
        try {
            expect(() => staticAssertFail(sa, globalScope())).toThrow(FatalError);
        } finally {
            setDiagnosticHandler(null);
            setFatalErrorHandler(null);
        }
        expect(messages).toEqual(["static assert:  1"]);
        expect(global.errors).toBe(1);
    });
});

describe("Semantic2Visitor construction (semantic2.d:89)", () => {
    test("the ctor stores the (nullable) scope verbatim — `visit(Import)` passes null on purpose", () => {
        // semantic2.d:539 calls `i.mod.semantic2(null)`, so `Scope*` really is nullable here; a
        // non-null field type would have forced a fabricated scope at that site.
        expect(new Semantic2Visitor(null).sc).toBe(null);
        const sc = globalScope();
        expect(new Semantic2Visitor(sc).sc).toBe(sc);
    });

    test("StaticAAVisitor stores sc + storage_class verbatim (semantic2.d:1009)", () => {
        const sc = globalScope();
        const v = new StaticAAVisitor(sc, STC.manifest);
        expect(v.sc).toBe(sc);
        expect(v.storage_class).toBe(STC.manifest);
    });
});
