// Co-located test file for `src/dmd/templatesem.ts` (10-tests-diagnostics.md §1.6b).
//
// dmd/templatesem.d carries ZERO in-source `unittest` blocks (verified: `grep -c unittest
// dmd/templatesem.d` -> 0), so there is nothing to port under 10 §1. What follows is the thin
// artifact §1.6b prescribes: ONE module-load smoke test, then one `test()` per risky RESOLVED
// CONSTRUCT of this translation, so a red gate names the pin that moved.
//
// Every pin is constructible with the EXISTING harness conventions (the §1.5 init snippet:
// `Loc._init()` + `Type._init()`, plus a bare `new Scope()` as dscope.test.ts does). No new
// machinery, no fabricated state. Paths that need a real semantic context — `matchWithInstance`,
// `deduceFunctionTemplateMatch`, `functionResolve`, `deduceType`'s aggregate arms — are
// deliberately NOT pinned: the sema.* goal tests and the corpus are the honest oracle for those,
// and reaching past the entry guards of `templateDeclarationSemantic` needs a Module-rooted Scope
// this harness does not build.
//
// CONCERNS PINNED (one test each):
//   1. module load / SCC value edges (the file is not a load-order root, 01 §4.7);
//   2. the S1 tag dispatch of `reliesOnTemplateParameters` + `reliesOnTident`'s forwarding;
//   3. the CT-folded `X(m, n)` case labels of `deduceTypeHelper` (07 §9 — 61 labels, the file's
//      single largest compile-time resolution);
//   4. the same fold in `deduceWildHelper` (28 labels) + its `tparam.mod & wild` guard;
//   5. `rootObjectsEqual`'s `final switch` over DYNCAST (06 §3.2/§3.3) and the monomorphized
//      `check!T` (07 §6);
//   6. the §F.3 `getValue` overload split and `getExpression`'s routing;
//   7. the recorded container substitution `TemplateInstanceTable` / `TemplateInstanceBox`
//      (08 §5) — including the LOAD-BEARING probe direction of the lookup;
//   8. `templateParameterLookup`'s Tident gate;
//   9. `templateDeclarationSemantic`'s two entry guards (dmd:740 semanticRun, dmd:748 no scope).

import { describe, it, expect, beforeEach } from "vitest";

// Import an SCC member FIRST: the core SCC only loads cleanly when the entry is inside it
// (01-conventions.md §4.5 — the load-order invariant recorded in visitor/index.ts).
import { IntegerExp } from "./expression.js";
import { Type, TypeIdentifier } from "./mtype.js";
import { MATCH, MODFlags, TY } from "./astenums.js";
import { Loc } from "./location.js";
import { Scope } from "./dscope.js";
import { Identifier } from "./identifier.js";
import { PASS } from "./dsymbol.js";
import { DYNCAST } from "./rootobject.js";
import { initTokens } from "./tokens.js";
import { global } from "./globals.js";
import { ErrorSinkNull } from "./errorsink.js";
import { Array as DArray } from "./root/array.js";
import { ds } from "../dstring.js";
import { addMod, constOf, pointerTo, Type_init } from "./typesem.js";
import {
    TemplateDeclaration, TemplateInstance, TemplateTypeParameter, Tuple,
} from "./dtemplate.js";
import type { Objects, TemplateParameters } from "./arraytypes.js";
import type { RootObject } from "./rootobject.js";

import {
    TemplateInstanceBox,
    TemplateInstanceTable,
    arrayObjectMatch,
    deduceTypeHelper,
    deduceWildHelper,
    getExpression,
    getValueFromDsymbol,
    getValueFromExpression,
    reliesOnTemplateParameters,
    reliesOnTident,
    rootObjectsEqual,
    templateDeclarationSemantic,
    templateParameterLookup,
} from "./templatesem.js";

beforeEach(() => {
    // The §1.5 canonical init snippet, in its fixed order. `initTokens()` is needed here because
    // the pins below intern identifiers through `Identifier.idPool`: D's `Identifier.equals` is
    // POINTER identity (identifier.d:87), so two separately constructed `Identifier`s spelled "T"
    // are NOT equal — every name compare in this module rides on the pool.
    Loc._init();
    initTokens();
    Type_init();
    global.errorSink = new ErrorSinkNull();
    global.errors = 0;
});

/** A `TemplateParameters` holding one `T` type parameter — the shape every deduction path wants. */
function oneTypeParam(name: string): TemplateParameters {
    const a: TemplateParameters = new DArray<TemplateTypeParameter | null>();
    a.push(new TemplateTypeParameter(Loc.initial, Identifier.idPool(ds(name)), null, null));
    return a;
}

describe("templatesem module surface", () => {
    // CONCERN 1 — LOAD ORDER. templatesem.ts is NOT a load-order root (01 §4.7): it carries plain
    // VALUE imports into the 76-module core SCC and its only top-level `extends Visitor` is
    // `DummyArgVisitor`, whose base comes from the visitor/index.ts ROOT. Importing the module here
    // executes its entire top level, so a new cycle edge that would surface elsewhere as
    // `Class extends value undefined` fails HERE, loudly and by name.
    it("loads; the free-function surface and the container class are live", () => {
        expect(typeof reliesOnTemplateParameters).toBe("function");
        expect(typeof deduceTypeHelper).toBe("function");
        expect(typeof rootObjectsEqual).toBe("function");
        expect(typeof TemplateInstanceTable).toBe("function");
        expect(typeof TemplateInstanceBox).toBe("function");
    });
});

describe("reliesOnTemplateParameters — the dmd:160 tag dispatch (S1)", () => {
    // CONCERN 2. Nine arms; the risky ones are `Tident` (name compare), `Tenum` (hard false) and
    // the `default:` arm, which D writes as UFCS `tb.nextOf().reliesOnTemplateParameters(tparams)`
    // — a null `nextOf()` must fall into the `t is null` guard and answer false, NOT fault.
    it("answers on the type tag, and the default arm walks nextOf()", () => {
        const tparams = oneTypeParam("T");

        // `t is null` guard (dmd/templatesem.d:87).
        expect(reliesOnTemplateParameters(null, tparams.opSlice(0, tparams.length))).toBe(false);

        // Tident arm (dmd:130): the identifier compares equal to the parameter's.
        const tT = new TypeIdentifier(Loc.initial, Identifier.idPool(ds("T")));
        expect(tT.ty).toBe(TY.Tident);
        expect(reliesOnTemplateParameters(tT, tparams.opSlice(0, tparams.length))).toBe(true);

        const tU = new TypeIdentifier(Loc.initial, Identifier.idPool(ds("U")));
        expect(reliesOnTemplateParameters(tU, tparams.opSlice(0, tparams.length))).toBe(false);

        // default arm on a basic type: `nextOf(Type.tint32)` is null -> the null guard -> false.
        expect(reliesOnTemplateParameters(Type.tint32, tparams.opSlice(0, tparams.length))).toBe(false);

        // default arm with a real `next`: int* -> nextOf() == int -> false; (T)* -> true.
        expect(reliesOnTemplateParameters(pointerTo(Type.tint32), tparams.opSlice(0, tparams.length))).toBe(false);
        expect(reliesOnTemplateParameters(pointerTo(tT), tparams.opSlice(0, tparams.length))).toBe(true);
    });

    // dmd/templatesem.d:73 — `reliesOnTident` is a thin forwarder onto the Type overload, and its
    // `iStart` parameter is DECLARED BUT UNUSED by the 1.43 body (the slice starts at 0 regardless).
    // The pin records that: a nonzero `iStart` changes nothing.
    it("reliesOnTident forwards the whole slice — iStart is inert in 1.43", () => {
        const tparams = oneTypeParam("T");
        const tT = new TypeIdentifier(Loc.initial, Identifier.idPool(ds("T")));
        expect(reliesOnTident(tT, tparams)).toBe(true);
        expect(reliesOnTident(tT, tparams, 1)).toBe(true);
        expect(reliesOnTident(null, tparams)).toBe(false);
    });
});

describe("deduceTypeHelper — the CT-folded X(m, n) labels (07 §9)", () => {
    // CONCERN 3. `X(m, n)` is `(m << 4) | n` over MODFlags; the 61 case labels are folded to integer
    // literals at translation time. A single mis-folded literal silently reroutes one (tparam-mod,
    // arg-mod) pair to the wrong arm — invisible to tsc. These pins exercise one representative
    // pair per arm, chosen so the arms are told apart by BOTH the MATCH and the `out` type.
    it("routes each mod pair to the arm D's label set selects", () => {
        const at: { value: Type | null } = { value: null };
        const mut = Type.tint32;                                   // mod 0
        const cst = constOf(Type.tint32);                          // mod const_
        // NOTE `sharedOf` is `castMod(shared_)` — it REPLACES the mod. `shared const` is built by
        // ORing, which is what `addMod` does (mtype.d MODmerge).
        const shc = addMod(constOf(Type.tint32), MODFlags.shared_); // mod shared_|const_
        const wld = addMod(Type.tint32, MODFlags.wild);            // mod wild

        // X(0, 0) == 0 — `foo(U)` vs `T` => exact, `at` is `t` itself.
        expect(deduceTypeHelper(mut, at, mut)).toBe(MATCH.exact);
        expect(at.value).toBe(mut);

        // X(0, const_) == 1 — same arm: an unqualified parameter takes the argument verbatim.
        expect(deduceTypeHelper(cst, at, mut)).toBe(MATCH.exact);
        expect(at.value).toBe(cst);

        // X(const_, const_) == 17 — `foo(const(U))` vs `const(T)` => exact, `at` strips to mutable.
        expect(deduceTypeHelper(cst, at, cst)).toBe(MATCH.exact);
        expect(at.value!.mod).toBe(MODFlags.none);

        // X(const_, 0) == 16 — `foo(const(U))` vs `T` => CONSTANT (not exact); this is the arm the
        // fold most easily confuses with 17, and the MATCH value is what separates them.
        expect(deduceTypeHelper(mut, at, cst)).toBe(MATCH.constant);
        expect(at.value!.mod).toBe(MODFlags.none);

        // X(const_, shared_|const_) == 19 — `foo(const(U))` vs `shared(const(T))` => exact, and the
        // `shared` SURVIVES on `at` (mutableOf, not unSharedOf) — the arm's whole point.
        expect(deduceTypeHelper(shc, at, cst)).toBe(MATCH.exact);
        expect(at.value!.mod).toBe(MODFlags.shared_);

        // X(wild, wild) == 136 — `foo(inout(U))` vs `inout(T)` => exact, stripped.
        expect(deduceTypeHelper(wld, at, wld)).toBe(MATCH.exact);
        expect(at.value!.mod).toBe(MODFlags.none);
    });

    // D declares `out Type at`, which the runtime resets before the callee's first statement
    // (03 §3.3). The port must reproduce the reset, or a caller's stale slot leaks into a nomatch.
    it("resets the `out` box on entry (03 §3.3)", () => {
        const at: { value: Type | null } = { value: Type.tint32 };
        // X(immutable_, 0) == 64 (dmd:6523) — the NOMATCH group, the one family of arms that never
        // writes `at`. Without the entry reset the caller's stale `Type.tint32` would survive a
        // nomatch and be read as a deduced type.
        expect(deduceTypeHelper(Type.tint32, at, addMod(Type.tint32, MODFlags.immutable_)))
            .toBe(MATCH.nomatch);
        expect(at.value).toBe(null);
    });
});

describe("deduceWildHelper — the wild guard and its folded labels", () => {
    // CONCERN 4. Two folded groups (16 + 12 labels) behind one early guard.
    it("returns 0 unless the parameter is `inout`, then routes on the folded label", () => {
        const at: { value: Type | null } = { value: null };
        const mut = Type.tint32;
        const wld = addMod(Type.tint32, MODFlags.wild);

        // The guard (dmd/templatesem.d:6320): a non-wild `tparam` never reaches the switch.
        expect(deduceWildHelper(wld, at, mut)).toBe(0);

        // X(wild, 0) == 128 — first group. `wm = t.mod & ~shared_` is 0, so it becomes
        // MODFlags.mutable (0x10) — the one place that sentinel is produced.
        expect(deduceWildHelper(mut, at, wld)).toBe(MODFlags.mutable);
        expect(at.value!.mod).toBe(MODFlags.none);

        // X(wild, const_) == 129 — same group, but `wm` is the argument's own const.
        expect(deduceWildHelper(constOf(Type.tint32), at, wld)).toBe(MODFlags.const_);

        // X(wild, wild) == 136 — second group: answers `wild`, and `at` is `t.unqualify(tparam.mod
        // & t.mod)`, i.e. the `wild` bit is STRIPPED off the deduced type (dmd:6363).
        expect(deduceWildHelper(wld, at, wld)).toBe(MODFlags.wild);
        expect(at.value!.mod).toBe(MODFlags.none);
    });
});

describe("rootObjectsEqual — the DYNCAST final switch (06 §3.2/§3.3)", () => {
    // CONCERN 5. D writes `with (DYNCAST) final switch (d)`; the port re-qualifies the labels and
    // ends in the `never`-exhaustiveness default. `bool check(T)` (dmd:7888) has exactly three
    // instantiations and is monomorphized into the expression/dsymbol/type arms; the remaining
    // seven tags stack onto plain reference identity.
    it("gates on dyncast, then compares by arm", () => {
        const t1 = Type.tint32;
        const t2 = Type.tint32;
        const e1 = new IntegerExp(Loc.initial, 1n, Type.tint32);
        const e2 = new IntegerExp(Loc.initial, 1n, Type.tint32);
        const e3 = new IntegerExp(Loc.initial, 2n, Type.tint32);

        // the leading `o1.dyncast() != o2.dyncast()` gate (dmd:7885).
        expect(t1.dyncast()).toBe(DYNCAST.type);
        expect(e1.dyncast()).toBe(DYNCAST.expression);
        expect(rootObjectsEqual(t1 as unknown as RootObject, e1 as unknown as RootObject)).toBe(false);

        // DYNCAST.type arm — `Type.equals`.
        expect(rootObjectsEqual(t1 as unknown as RootObject, t2 as unknown as RootObject)).toBe(true);

        // DYNCAST.expression arm — the free `equals(Expression, Expression)` (04 §6.1).
        expect(rootObjectsEqual(e1 as unknown as RootObject, e2 as unknown as RootObject)).toBe(true);
        expect(rootObjectsEqual(e1 as unknown as RootObject, e3 as unknown as RootObject)).toBe(false);

        // a stacked identity arm — DYNCAST.tuple falls through to `o1 is o2` (dmd:7906).
        const tu1 = new Tuple();
        const tu2 = new Tuple();
        expect(tu1.dyncast()).toBe(DYNCAST.tuple);
        expect(rootObjectsEqual(tu1, tu1)).toBe(true);
        expect(rootObjectsEqual(tu1, tu2)).toBe(false);
    });
});

describe("getValue* / getExpression — the §F.3 overload split", () => {
    // CONCERN 6. D has TWO `getValue` overloads at dmd:8167 (`ref Dsymbol`) and dmd:8183
    // (`Expression`), and `getExpression` (dmd:8200) picks between them on ONE line. A collapsed
    // pair would compile and silently answer the wrong overload — this pin separates them.
    it("routes a Dsymbol through the Dsymbol overload and an Expression through the other", () => {
        expect(getValueFromDsymbol(null)).toBe(null);
        expect(getValueFromExpression(null)).toBe(null);
        expect(getExpression(null)).toBe(null);

        // dmd:8183 — the Expression overload answers the expression itself when it is not a
        // manifest-constant VarExp.
        const e = new IntegerExp(Loc.initial, 7n, Type.tint32);
        expect(getValueFromExpression(e)).toBe(e);
        expect(getExpression(e as unknown as RootObject)).toBe(e);

        // dmd:8200 — a Dsymbol operand takes the Dsymbol overload; a plain TemplateDeclaration is
        // not a manifest VarDeclaration, so the answer is null (dmd:8180).
        const td = new TemplateDeclaration(Loc.initial, Identifier.idPool(ds("Foo")),
            oneTypeParam("T"), null, null);
        expect(getValueFromDsymbol(td)).toBe(null);
        expect(getExpression(td as unknown as RootObject)).toBe(null);
    });
});

describe("TemplateInstanceTable — the recorded container substitution (08 §5)", () => {
    // CONCERN 7. D's `TemplateInstance[TemplateInstanceBox]` builtin AA has no JS equivalent, so
    // the port supplies a hash-bucket table resolved with `toHash()`/`opEquals()`. TWO things must
    // hold, and neither is visible to tsc:
    //   (a) `toHash()` is STABLE for one box (it is cached at construction, dmd:676-680);
    //   (b) the lookup probes `probe.opEquals(stored)`, never the reverse — `equalsx` documents
    //       itself as NON-commutative ("ti1 = proposed, ti2 = existing", dmd:2398-2404).
    //
    // The pin drives `opEquals`'s FIRST clause (dmd:690-696, `ti.inst && s.ti.inst` -> reference
    // identity). The second clause routes into `equalsx`, which compares the instances' analysed
    // state (`tdtypes`, `enclosing`, `ti2.toAlias()`, dmd:2408-2425) — state only the semantic pass
    // builds, so this suite cannot reach it honestly (10 §1.6b) and it is left to the corpus.
    it("stores, finds and removes by hash+opEquals, and keeps the box hash stable", () => {
        const ti = new TemplateInstance(Loc.initial, Identifier.idPool(ds("Foo")), null);
        ti.tdtypes = new DArray<RootObject | null>();
        ti.inst = ti; // an already-instantiated instance: selects opEquals' identity clause

        const box = new TemplateInstanceBox(ti);
        const h = box.toHash();
        expect(typeof h).toBe("bigint");
        expect(box.toHash()).toBe(h); // (a) cached, so repeated reads cannot drift

        // 03 §2: `.copy()` shares the `ti` reference and carries the cached hash across.
        const clone = box.copy();
        expect(clone.ti).toBe(ti);
        expect(clone.toHash()).toBe(h);

        const table = new TemplateInstanceTable();
        expect(table.has(box)).toBe(false);
        expect(table.get(box)).toBe(null);

        table.set(box, ti);
        expect(table.has(box)).toBe(true);
        expect(table.get(box)).toBe(ti);
        // (b) a DIFFERENT box over the SAME instance resolves to the same slot.
        expect(table.get(clone)).toBe(ti);

        table.remove(box);
        expect(table.has(box)).toBe(false);
        expect(table.get(box)).toBe(null);

        // traits.d's `aa.clear()` (the only other D operation on this AA) empties it.
        table.set(box, ti);
        table.clear();
        expect(table.has(box)).toBe(false);
    });
});

describe("templateParameterLookup / arrayObjectMatch", () => {
    // CONCERN 8. `templateParameterLookup` (dmd:6694) answers IDX_NOTFOUND for anything that is not
    // a bare `TypeIdentifier` — the gate that keeps deduction from matching a qualified name.
    it("looks a bare TypeIdentifier up in the parameter list, IDX_NOTFOUND otherwise", () => {
        const parameters = oneTypeParam("T");
        const tT = new TypeIdentifier(Loc.initial, Identifier.idPool(ds("T")));
        const tU = new TypeIdentifier(Loc.initial, Identifier.idPool(ds("U")));

        expect(templateParameterLookup(tT, parameters)).toBe(0);
        expect(templateParameterLookup(tU, parameters)).not.toBe(0);
        // a non-identifier type never enters the lookup at all (dmd:6700).
        expect(templateParameterLookup(Type.tint32, parameters)).not.toBe(0);
    });

    // dmd:2374 — `arrayObjectMatch` is length-gated, then element-wise through `match`.
    it("arrayObjectMatch is length-gated and element-wise", () => {
        const a: Objects = new DArray<RootObject | null>();
        const b: Objects = new DArray<RootObject | null>();
        expect(arrayObjectMatch(a, b)).toBe(true); // two empty arrays match

        a.push(Type.tint32 as unknown as RootObject);
        expect(arrayObjectMatch(a, b)).toBe(false); // length gate (dmd:2376)

        b.push(Type.tint32 as unknown as RootObject);
        expect(arrayObjectMatch(a, b)).toBe(true);  // identity arm of `match` (dmd:2287)

        const c: Objects = new DArray<RootObject | null>();
        c.push(Type.tchar as unknown as RootObject);
        expect(arrayObjectMatch(a, c)).toBe(false);
    });
});

describe("templateDeclarationSemantic — the two entry guards (dmd:740, dmd:748)", () => {
    // CONCERN 9. `templateDeclarationSemantic` (dmd:731) opens with `timeTraceBeginEvent(...)` +
    // `scope (exit) timeTraceEndEvent(...)`. Those are DROPPED as a balanced pair, not walled —
    // `dmd.timetrace` is profiling-only with no semantic effect and no port, the same disposition
    // every other timetrace site in the tree carries (dmodule.ts:828, dsymbolsem.ts:4017/:4466,
    // funcsem.ts:454, semantic2.ts:582, semantic3.ts:318). So there is no wall to pin here.
    //
    // What IS pinnable with the §1.5 harness is the pair of guard clauses D takes BEFORE any work,
    // both of which return without touching the scope. Everything past them needs a real semantic
    // context (a Module-rooted Scope); the sema.* goal tests and the corpus are the honest oracle
    // for that, and 10 §1.6b forbids fabricating harness state to reach it.
    it("returns immediately when the semantic pass already ran (dmd:740)", () => {
        const td = new TemplateDeclaration(Loc.initial, Identifier.idPool(ds("Foo")),
            oneTypeParam("T"), null, null);
        td.semanticRun = PASS.semanticdone;
        expect(() => templateDeclarationSemantic(new Scope(), td)).not.toThrow();
        expect(td.semanticRun).toBe(PASS.semanticdone); // untouched: D returned at :741
        expect(td._scope).toBe(null);                   // the :743 `_scope` steal did not run
    });

    it("returns immediately when there is no scope (dmd:748)", () => {
        const td = new TemplateDeclaration(Loc.initial, Identifier.idPool(ds("Foo")),
            oneTypeParam("T"), null, null);
        expect(() => templateDeclarationSemantic(null, td)).not.toThrow(); // dmd:748 `if (!sc) return;`
        expect(td.semanticRun).toBe(PASS.initial);
    });
});

describe("the constraint-failure message through dtemplate.write (dtemplate.d:1290)", () => {
    // dtemplate.d:1295/:1297 write `toErrMsg()` / `toChars()` through `writestring(const(char)*)`, which
    // stops at the NUL. Both are `extractChars()` buffers carrying one, so writing the whole DString cut
    // every later piece of formatParamsWithTiargs' "with `T = int`" line. Pinned end to end against
    // ldc2 1.43.0 (`ldc2 -o- p.d`):
    //   p.d(2): Error: template instance `p.f!int` does not match template declaration `f(T)(T x)`
    //     with `T = int`
    //     must satisfy the following constraint:
    //   `       is(T == long)`
    it("prints every piece after the tiargs (ldc2: p.d)", async () => {
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
            const text = "module p;\nvoid f(T)(T x) if (is(T == long)) {}\nvoid main(){ f!int(1); }\n";
            const src = new Uint8Array(text.length + 1); // NUL-terminated: the lexer scans to the sentinel
            for (let i = 0; i < text.length; i++) src[i] = text.charCodeAt(i);
            const p = new Parser(null, null, src, false, global.errorSink, null, false);
            p.nextToken();
            runSemantic(moduleFromParse(p.parseModule(), p.md));
        } finally {
            setDiagnosticHandler(null);
        }
        expect(diags).toEqual([
            "Error: template instance `p.f!int` does not match template declaration `f(T)(T x)`\n" +
                "  with `T = int`\n  must satisfy the following constraint:\n`       is(T == long)`",
        ]);
    });
});
