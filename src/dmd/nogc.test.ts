// Co-located tests for src/dmd/nogc.ts.
//
// dmd/nogc.d carries ZERO in-source `unittest{}` blocks (verified: `grep -c '^\s*unittest\b'` -> 0),
// so this file is the THIN FLEET ARTIFACT of 10 §1.6b: one module-load smoke test plus roughly one
// behaviour pin per risky RESOLVED CONSTRUCT of the translation. No new harness machinery — the init
// snippet (10 §1.5) and `globalScope()` are the existing sema-test conventions (mirroring
// enumsem.test.ts / sema.var.test.ts). Byte-exact diagnostic text is the corpus's oracle (10 §5),
// not this file's, so no pin drives an `error()` path.
//
// NO WALL PINS REMAIN — the three wave-4 walls of nogc.ts are swept (`walkPostorder`,
// dmd/visitor/postorder.d:20, at nogc.d:70 and nogc.d:283; `checkArrayLiteralEscape`, dmd/escape.d:246,
// at nogc.d:158) and each pin was CONVERTED, never deleted (10 §1.8 rule 7):
//   - `checkGC` (nogc.d:283) → a behaviour pin on what the live pass produces for an expression that
//     allocates nothing: `e` back unchanged, `e.gcPassDone` set (nogc.d:284), no diagnostic.
//   - `NOGCVisitor.doCond` (nogc.d:70) → a behaviour pin that the descent is REAL: an expression the
//     postorder walk routes to a reporting arm flips `err`, which a walk that never dispatched could
//     not do. The null leg (nogc.d:69) stays pinned live alongside.
//   - `visitDeclarationExp` (nogc.d:88) → the same, one level up: the live initializer leg descends
//     through `doCond` into the arm, while the `STC.manifest` leg still returns without descending.
//   - `visitArrayLiteralExp` (nogc.d:158) → the call is live, but the D path now runs INTO escape.ts's
//     own wall (`checkNewEscape`, dmd/escape.d:969, thrown at escape.d:250/:254), so a positive
//     behaviour pin is not available here. 10 §1.8 rule 9's sanctioned form is used instead: a
//     NEGATIVE pin naming only the callee this sweep made live, which survives escape.ts's next move.
//
// NOT PINNED, and honestly so: `visitNewExp` (nogc.d:195) and `visitIndexExp` (nogc.d:227) need a
// `NewExp` with a resolved `member`, and an `IndexExp` over a live `TypeAArray` with `modifiable`
// set — both are sema products, and building one by hand is the new harness machinery 10 §1.6b
// forbids. No pin drives an `error()` diagnostic string either: byte-exact text is the corpus's
// oracle (10 §5).

import { beforeEach, describe, expect, test } from "vitest";

import "./parse.js"; // module-graph ROOT — first import of any core-SCC test file (10 §1.5)

import {
    NOGCVisitor,
    checkGC,
    isNogc,
    isNogcBypassingInference,
    printGCUsage,
    setGC,
    setGCCall,
    stripHookTraceImpl,
    vgcEnabled,
} from "./nogc.js";

import { LINK, STC, VarArg } from "./astenums.js";
import { Scope } from "./dscope.js";
import { ErrorSinkNull } from "./errorsink.js";
import { scopeCreateGlobal } from "./dsymbolsem.js";
import { FuncDeclaration } from "./func.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { moduleFromParse } from "./dmodule.js";
import { ParameterList, Type, TypeFunction } from "./mtype.js";
import { VarDeclaration } from "./declaration.js";
import {
    ArrayLiteralExp, AssocArrayLiteralExp, CallExp, CatAssignExp, DeclarationExp, DeleteExp, Expression,
    IntegerExp, VarExp,
} from "./expression.js";
import { ExpInitializer } from "./init.js";
import { Array as DArray } from "./root/array.js";
import { initTokens } from "./tokens.js";
import { global } from "./globals.js";
import { Type_init } from "./typesem.js";
import { AssertError } from "../assert.js";
import { ds } from "../dstring.js";

import type { Dsymbol } from "./dsymbol.js";
import type { Dsymbols } from "./arraytypes.js";

beforeEach(() => {
    Loc._init();
    initTokens();
    Id.initialize();
    global._init();
    Type_init();
    global.errorSink = new ErrorSinkNull();
    global.errors = 0;
    global.gaggedErrors = 0;
    global.gag = 0;
});

function id(name: string): Identifier {
    return Identifier.idPool(ds(name));
}

/** `int <name>()` as a bare module-level FuncDeclaration (no semantic run). */
function makeFunc(name: string, isNogcAttr = false): FuncDeclaration {
    const tf = new TypeFunction(new ParameterList(null, VarArg.none), Type.tint32, LINK.d);
    tf.isNogc = isNogcAttr;
    return new FuncDeclaration(Loc.initial, Loc.initial, id(name), STC.none, tf);
}

/** A global `Scope` over a bare module — the sema-test convention (sema.var.test.ts:85). */
function globalScope(): Scope {
    const members: Dsymbols = new DArray<Dsymbol | null>();
    const m = moduleFromParse(members, null);
    return scopeCreateGlobal(m, global.errorSink!);
}

function intExp(v: number): Expression {
    return new IntegerExp(Loc.initial, BigInt(v), Type.tint32!);
}

describe("nogc.ts — module-load smoke (10 §1.6b)", () => {
    test("importing the module executes its top-level and exposes the whole D surface", () => {
        // nogc.d's NOGCVisitor `extends StoppableVisitor` at TOP LEVEL, so a load-order/cycle
        // regression in the visitor root shows up right here as `Class extends value undefined`.
        expect(typeof Expression).toBe("function"); // 10 §1.5 — names the graph-root regression
        expect(typeof NOGCVisitor).toBe("function");
        expect(typeof checkGC).toBe("function");
        expect(typeof vgcEnabled).toBe("function");
        expect(typeof printGCUsage).toBe("function");
        expect(typeof stripHookTraceImpl).toBe("function");
        expect(typeof setGC).toBe("function");
        expect(typeof setGCCall).toBe("function");
        expect(typeof isNogc).toBe("function");
        expect(typeof isNogcBypassingInference).toBe("function");
    });

    test("NOGCVisitor is a StoppableVisitor: the inherited `stop` slot starts false", () => {
        const gcv = new NOGCVisitor(makeFunc("f"), globalScope());
        expect(gcv.stop).toBe(false);
        expect(gcv.err).toBe(false);
        expect(gcv.checkOnly).toBe(false);
        expect(gcv.nogcExceptions).toBe(false);
    });
});

describe("nogc.ts — isNogc / isNogcBypassingInference (nogc.d:410, :418)", () => {
    test("a non-inferred plain function reads `tf.isNogc` straight through", () => {
        const f = makeFunc("g");
        expect(f.nogcInprocess).toBe(false); // no inference head, so no setGC side-effect
        expect(isNogc(f)).toBe(false);
        expect(isNogc(makeFunc("h", true))).toBe(true);
    });

    test("isNogcBypassingInference short-circuits on `nogcInprocess` WITHOUT consulting isNogc", () => {
        // nogc.d:420 is `!fd.nogcInprocess && fd.isNogc()`. With the flag up and `tf.isNogc` true,
        // only the short-circuit explains a `false` — and it must leave `tf.isNogc` untouched (no
        // inference commit), which the second assertion pins.
        const f = makeFunc("g", true);
        f.nogcInprocess = true;
        expect(isNogcBypassingInference(f)).toBe(false);
        expect(f.type!.toTypeFunction().isNogc).toBe(true);
    });
});

describe("nogc.ts — setGC / setGCCall (nogc.d:349, :405)", () => {
    test("non-inference tail: a default caller reports no violation, a `@nogc` caller does", () => {
        // nogc.d:391-393 — `else if (fd.isNogc()) return true; return false;`. Both callers have
        // `nogcInprocess` false and `sc = null`, so the semantic2/3 head and the traits head are
        // both skipped and only the tail runs.
        expect(setGC(null, makeFunc("g"), Loc.initial, null)).toBe(false);
        expect(setGC(null, makeFunc("h", true), Loc.initial, null)).toBe(true);
    });

    test("inference branch with a format string commits not-`@nogc` and records the action", () => {
        // nogc.d:371-390 with `fmt` non-null and an EMPTY variadic tail: `_scope` is null so the
        // semantic2/3 head (nogc.d:352) is skipped, `sc` is null so the traits head is skipped.
        const f = makeFunc("g", true);
        f.nogcInprocess = true;
        expect(setGC(null, f, Loc.initial, ds("allocating with `new`"))).toBe(false);
        expect(f.nogcInprocess).toBe(false);
        expect(f.type!.toTypeFunction().isNogc).toBe(false);
        expect(f.nogcViolation).not.toBeNull();
        expect(f.nogcViolation!.fd).toBeNull(); // the format form, not the called-function form
    });

    test("inference branch with a null format and a Dsymbol arg records the CALLED function", () => {
        // nogc.d:376-385 — the `else if (args.length > 0)` leg: `isDsymbol(args[0])` then
        // `isFuncDeclaration()`, landing in the `AttributeViolation(loc, fd2)` form.
        const caller = makeFunc("g", true);
        caller.nogcInprocess = true;
        const callee = makeFunc("mallocy");
        expect(setGC(null, caller, Loc.initial, null, callee)).toBe(false);
        expect(caller.nogcViolation).not.toBeNull();
        expect(caller.nogcViolation!.fd).toBe(callee);
    });

    test("setGCCall forwards `f` as the sole variadic arg and `null` as the format", () => {
        // nogc.d:407 — `return sc.setGC(fd, fd.loc, null, f);`. A `@nogc` caller with inference
        // already settled takes setGC's tail, so the return is the caller's own `@nogc`-ness.
        const sc = globalScope();
        expect(setGCCall(sc, makeFunc("h", true), makeFunc("mallocy"))).toBe(true);
        expect(setGCCall(sc, makeFunc("g"), makeFunc("mallocy"))).toBe(false);
    });
});

describe("nogc.ts — vgcEnabled / printGCUsage (nogc.d:298, :307)", () => {
    test("`-vgc` off returns false BEFORE `fd.getModule()` is reached", () => {
        // nogc.d:300 is the guard; the pin's proof is that a parent-less FuncDeclaration (whose
        // getModule() walk has nothing to walk) neither throws nor reports enabled.
        expect(global.params.v.gc).toBe(false);
        expect(vgcEnabled(makeFunc("g"))).toBe(false);
    });

    test("printGCUsage with `-vgc` off emits nothing", () => {
        const before = global.errors;
        printGCUsage(makeFunc("g"), Loc.initial, ds("array literal may cause a GC allocation"));
        expect(global.errors).toBe(before);
    });
});

describe("nogc.ts — stripHookTraceImpl (nogc.d:319)", () => {
    test("a function that is not `_d_HookTraceImpl` is returned unchanged", () => {
        // nogc.d:324-325 — the identity early-out, which is the only path a non-hook call takes.
        // Reachable from the test because D `private` is MODULE-private and the port exports it
        // with the `// D module-private` marker (10 §1.7).
        const f = makeFunc("g");
        expect(stripHookTraceImpl(f)).toBe(f);
    });
});

describe("nogc.ts — checkGC (nogc.d:268)", () => {
    test("early-out: an expression already through the pass is returned as-is", () => {
        // nogc.d:271 `e.gcPassDone` — the first disjunct, so the walkPostorder wall is never reached.
        const e = intExp(1);
        e.gcPassDone = true;
        const sc = globalScope();
        expect(checkGC(e, sc)).toBe(e);
    });

    test("early-out: a scope with no enclosing function is returned as-is", () => {
        // nogc.d:271 `!sc.func` — a global scope has none, so the pass does not run.
        const sc = globalScope();
        expect(sc.func).toBeNull();
        const e = intExp(2);
        expect(checkGC(e, sc)).toBe(e);
        expect(e.gcPassDone).toBe(false); // nogc.d:284 is downstream of the early-out
    });

    test("early-out: a CTFE-only scope is returned as-is", () => {
        // nogc.d:271 `sc.ctfe` — set on the same global scope, which otherwise has no func anyway;
        // the pin fixes the disjunct order by giving the scope a func first.
        const sc = globalScope();
        sc.func = makeFunc("g");
        sc.ctfe = true;
        const e = intExp(3);
        expect(checkGC(e, sc)).toBe(e);
    });

    test("the live pass returns a non-allocating expression unchanged and marks it done", () => {
        // RE-PIN (10 §1.8 rule 7): replaces the wave-4 wall pin on `walkPostorder`, swept once
        // dmd/visitor/postorder.d:20 landed. D reaches nogc.d:283 unconditionally past the nogc.d:271
        // early-outs, so this is still the arm D selects — what changed is that it now completes.
        // An `IntegerExp` routes to `visit(Expression)` (nogc.d:73), the empty arm, so `err` stays
        // false and nogc.d:286-287 returns `e` itself; nogc.d:284 is now REACHED, which the wall
        // never let happen.
        const sc = globalScope();
        sc.func = makeFunc("g");
        const e = intExp(4);
        const before = global.errors;
        expect(checkGC(e, sc)).toBe(e);
        expect(e.gcPassDone).toBe(true);
        expect(global.errors).toBe(before);
    });
});

describe("nogc.ts — NOGCVisitor arms (nogc.d:67-265)", () => {
    test("doCond(null) is a live no-op; doCond(exp) really walks the subtree", () => {
        // nogc.d:69 `if (exp)` — the null leg was always live; the non-null leg is the RE-PIN
        // (10 §1.8 rule 7) of the wave-4 wall on `walkPostorder`, swept once
        // dmd/visitor/postorder.d:20 landed.
        const gcv = new NOGCVisitor(makeFunc("g"), globalScope());
        expect(() => gcv.doCond(null)).not.toThrow();

        // A non-allocating expression walks to completion and records nothing.
        gcv.doCond(intExp(1));
        expect(gcv.err).toBe(false);
        expect(gcv.stop).toBe(false);

        // The pin that a walk which never dispatched could not pass: `checkOnly` makes the
        // `~=` arm (nogc.d:250-253) observable as `err` alone, so `err` flips only if the
        // postorder walk actually routed the node to `visit(CatAssignExp)`.
        gcv.checkOnly = true;
        gcv.doCond(new CatAssignExp(Loc.initial, intExp(2), intExp(3)));
        expect(gcv.err).toBe(true);
    });

    test("visitExpression is the empty arm: it records nothing", () => {
        // nogc.d:73-75 — `override void visit(Expression e) {}`.
        const gcv = new NOGCVisitor(makeFunc("g"), globalScope());
        gcv.visitExpression(intExp(1));
        expect(gcv.err).toBe(false);
        expect(gcv.stop).toBe(false);
    });

    test("visitDeleteExp returns for a stack-allocated variable and asserts otherwise", () => {
        // nogc.d:216-224. The live leg needs `e1` to be a VarExp over an `onstack` VarDeclaration
        // (which also pins the `var` -> `var_` escape, 01 §2.3); anything else is D's `assert(0)`,
        // ported as `assertUnreachable()` — normal translated code, never a wall (11 §2.5).
        const gcv = new NOGCVisitor(makeFunc("g"), globalScope());
        const v = new VarDeclaration(Loc.initial, Type.tint32, id("p"), null);
        v.onstack = true;
        expect(() => gcv.visitDeleteExp(new DeleteExp(Loc.initial, new VarExp(Loc.initial, v), false))).not.toThrow();

        const v2 = new VarDeclaration(Loc.initial, Type.tint32, id("q"), null);
        expect(v2.onstack).toBe(false);
        // `AssertError` (assert.ts:65), not a bare `.toThrow()`: a bare matcher is satisfied by any
        // throw, including a TypeError from an unrelated null dereference, so it could not tell the
        // faithful `assertUnreachable()` from an accidental crash in the same arm.
        expect(() => gcv.visitDeleteExp(new DeleteExp(Loc.initial, new VarExp(Loc.initial, v2), false)))
            .toThrow(AssertError);
    });

    test("visitCatAssignExp under checkOnly sets `err` without consulting setGC", () => {
        // nogc.d:250-254 — the `-betterC` check-only leg returns before the setGC/printGCUsage pair,
        // so a caller with a `@nogc` function never reports a diagnostic here.
        const gcv = new NOGCVisitor(makeFunc("h", true), globalScope());
        gcv.checkOnly = true;
        const before = global.errors;
        gcv.visitCatAssignExp(new CatAssignExp(Loc.initial, intExp(1), intExp(2)));
        expect(gcv.err).toBe(true);
        expect(global.errors).toBe(before);
    });

    test("visitCallExp: the callee's ident is compared by POOLED IDENTITY to Id._d_arraysetlengthT", () => {
        // nogc.d:137-147. `checkOnly` (nogc.d:119) makes the private setGC observable as `err` alone,
        // so all three calls below differ ONLY in what nogc.d:137/:142 decide — no error() path, no
        // -vgc machinery. This is the file's one positive leg of an `Id.*` identity comparison
        // (01 §5.2(c)): an init-order break that orphaned `Id._d_arraysetlengthT` would flip it.
        const gcv = new NOGCVisitor(makeFunc("g"), globalScope());
        gcv.checkOnly = true;

        const noCallee = new CallExp(Loc.initial, null);
        expect(noCallee.f).toBeNull(); // nogc.d:137-138 — the no-callee early return
        gcv.visitCallExp(noCallee);
        expect(gcv.err).toBe(false);

        const other = new CallExp(Loc.initial, null);
        other.f = makeFunc("notAHook"); // stripHookTraceImpl returns it unchanged (nogc.d:324)
        gcv.visitCallExp(other);
        expect(gcv.err).toBe(false);

        const hook = new CallExp(Loc.initial, null);
        hook.f = makeFunc("_d_arraysetlengthT");
        expect(hook.f.ident).toBe(Id._d_arraysetlengthT); // pooled identity, not string equality
        gcv.visitCallExp(hook);
        expect(gcv.err).toBe(true);
    });

    test("visitAssocArrayLiteralExp: empty keys return live, a non-empty literal reaches setGC", () => {
        // nogc.d:188-189 is the empty-keys early return, nogc.d:190 the setGC report. The second call
        // exercises the PRIVATE member setGC (nogc.d:115) a second time, through a different arm than
        // the array-literal pin — the member-vs-module-level `setGC` split D gets from member-vs-UFCS
        // lookup, and which this file's header calls out.
        const gcv = new NOGCVisitor(makeFunc("g"), globalScope());
        gcv.checkOnly = true;
        const noKeys = new AssocArrayLiteralExp(Loc.initial, new DArray<Expression | null>(),
            new DArray<Expression | null>());
        gcv.visitAssocArrayLiteralExp(noKeys);
        expect(gcv.err).toBe(false);

        const keys = new DArray<Expression | null>();
        keys.push(intExp(1));
        const values = new DArray<Expression | null>();
        values.push(intExp(2));
        gcv.visitAssocArrayLiteralExp(new AssocArrayLiteralExp(Loc.initial, keys, values));
        expect(gcv.err).toBe(true);
    });

    test("visitDeclarationExp: a manifest constant is skipped, a live initializer descends", () => {
        // nogc.d:82-90. The two calls differ ONLY in `STC.manifest`, so they pin the first conjunct
        // of nogc.d:84 and the bigint mask that carries it (`(storage_class & STC.manifest) === 0n`).
        // `STC.exptemp` makes `isDataseg()` return false at declaration.d:589 without the
        // forward-referenced diagnostic a parent-less variable would otherwise emit; `isCsymbol()` is
        // false because a parent-less symbol has no module. The live leg therefore reaches
        // `doCond(ei.exp)` (nogc.d:88).
        // RE-PIN (10 §1.8 rule 7): the live leg used to stop at the `walkPostorder` wall; now that
        // dmd/visitor/postorder.d:20 is ported it descends, so the pin is the DESCENT itself — a
        // `~=` initializer under `checkOnly` flips `err` only if nogc.d:88 reached the arm, while the
        // `STC.manifest` declaration (nogc.d:84) still returns without descending at all.
        const gcv = new NOGCVisitor(makeFunc("g"), globalScope());
        gcv.checkOnly = true;
        const manifest = new VarDeclaration(Loc.initial, Type.tint32, id("c"),
            new ExpInitializer(Loc.initial, new CatAssignExp(Loc.initial, intExp(5), intExp(5))),
            STC.manifest);
        gcv.visitDeclarationExp(new DeclarationExp(Loc.initial, manifest));
        expect(gcv.err).toBe(false);

        const live = new VarDeclaration(Loc.initial, Type.tint32, id("v"),
            new ExpInitializer(Loc.initial, new CatAssignExp(Loc.initial, intExp(6), intExp(6))),
            STC.exptemp);
        expect(live.isDataseg()).toBe(false);
        expect(live.isCsymbol()).toBe(false);
        gcv.visitDeclarationExp(new DeclarationExp(Loc.initial, live));
        expect(gcv.err).toBe(true);
    });

    test("visitArrayLiteralExp early-out: an empty literal is not a GC allocation", () => {
        // nogc.d:152-154 — `dim == 0` returns before setGC, so the nogc.d:158 wall is NOT reached.
        // `e.type` is a non-SArray type, so the first disjunct is false and `dim` decides.
        const gcv = new NOGCVisitor(makeFunc("g"), globalScope());
        const ale = new ArrayLiteralExp(Loc.initial, Type.tint32, null);
        expect(() => gcv.visitArrayLiteralExp(ale)).not.toThrow();
        expect(gcv.err).toBe(false);
    });

    test("a non-empty array literal now enters checkArrayLiteralEscape and stops inside escape.ts", () => {
        // The arm D selects: nogc.d:153 lets a 1-element non-SArray literal through, nogc.d:155
        // `setGC` returns false for a non-`@nogc`, non-inferring function, and nogc.d:158 is the
        // next statement — that ordering is what this test has always certified.
        // RE-PIN (10 §1.8 rule 9): the wave-4 wall on `checkArrayLiteralEscape` is swept
        // (dmd/escape.d:246 is exported by escape.ts), but the now-live callee runs into escape.ts's
        // OWN wall on `checkNewEscape` (dmd/escape.d:969, thrown at escape.d:250/:254), so the D path
        // still cannot complete and no positive behaviour pin exists yet. The sanctioned form is the
        // NEGATIVE pin naming only the callee this sweep made live: it fails if a wall over
        // `checkArrayLiteralEscape` ever comes back, and it survives escape.ts's next move.
        const gcv = new NOGCVisitor(makeFunc("g"), globalScope());
        const elements = new DArray<Expression | null>();
        elements.push(intExp(7));
        const ale = new ArrayLiteralExp(Loc.initial, Type.tint32, elements);
        expect(() => gcv.visitArrayLiteralExp(ale)).not.toThrow(/checkArrayLiteralEscape/);
    });
});
