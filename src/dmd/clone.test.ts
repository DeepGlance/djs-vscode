// Goal tests for src/dmd/clone.ts.
//
// dmd/clone.d has ZERO in-source `unittest{}` blocks (`grep -c '^unittest' dmd/clone.d` = 0), so
// this file takes the 10 §1.6b shape: one export-surface smoke test plus behavior pins — one
// `test()` per CONCERN — for the constructs this translation actually resolved.
//
// SCOPE OF THE SMOKE TEST (do NOT read more into it): it only asserts that importing dmd.clone
// executes its top level and publishes the D surface. It canNOT detect a core-SCC load-order
// regression, because this file imports `./clone.js` FIRST — the cycle that breaks other entry
// orders (declaration.ts -> mangle -> mtype -> dsymbolsem -> clone -> func) never arises in this
// file's own module graph. Load-order regressions are caught by the FULL `vitest run`, never here.
//
// Pinned concerns:
//
//   * `mergeFuncAttrs` (clone.d:54): the file's one pure function, and the whole reason the
//     branded 64-bit STC carrier (02 §4.2 / 09) had to be threaded correctly. Pinned on the null
//     early-out, the merge algebra, and the @system/@trusted/@safe precedence ladder.
//   * `needOpEquals` (clone.d:417): the union-arity gate, the `hasIdentityEquals` short-circuit,
//     and the `isFloating` arm — the three independently-risky legs of the field scan.
//   * The identity-opAssign detection (clone.d:113-128), now that `resolveFuncCall` is live: the
//     negative pin on the swept callee, the null D resolves this input to, and the gag-counter
//     pairing (11 §2.5) — `startGagging`/`endGagging` must balance, or every later diagnostic in
//     the process is silently swallowed.
//   * The POD paths of `buildInv` / `buildPostBlit` / `buildDtors` that `visitStructDeclaration`
//     (dsymbolsem.ts) calls unconditionally — these are pins that a wall creeping onto a POD path
//     would turn red immediately.
//
// No new harness machinery (10 §1.6b): everything is built with the canonical init snippet
// (10 §1.5) plus `Type._init()`, exactly as dcast.rung1.test.ts does.

import { beforeEach, describe, expect, test } from "vitest";
import {
    _resetTfToHash, buildDtors, buildInv, buildOpEquals, buildPostBlit, mergeFuncAttrs,
    needCopyOrMoveCtor, hasIdentityOpAssign, needOpEquals,
} from "./clone.js";
import type { Ref } from "./clone.js";
import { StructDeclaration, UnionDeclaration } from "./dstruct.js";
import { Scope } from "./dscope.js";
import type { AggregateDeclaration } from "./aggregate.js";
import { DsymbolTable } from "./dsymbol.js";
import type { Dsymbol } from "./dsymbol.js";
import { Array as Array_ } from "./root/array.js";
import { VarDeclaration } from "./declaration.js";
import { FuncDeclaration } from "./func.js";
import { ParameterList, Type, TypeFunction } from "./mtype.js";
import { LINK, PURE, STC, TRUST } from "./astenums.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { initTokens } from "./tokens.js";
import { global } from "./globals.js";
import { ErrorSinkNull } from "./errorsink.js";
import { ds } from "../dstring.js";
import { Type_init } from "./typesem.js";

beforeEach(() => {
    initTokens(); // also runs Identifier.initTable
    Id.initialize();
    Loc._init();
    Type_init();
    // `tftohash` (clone.d:822 `__gshared`) is interned in the table `Type._init()` just replaced —
    // 01 §5.5 rule 3: reset the process-global cache alongside it.
    _resetTfToHash();
    global.errorSink = new ErrorSinkNull();
    global.errors = 0;
    // `global.gag` is a process-global counter this file's wall pins drive through. It is reset
    // here so a pin can never leave a later test gagged (the code's own try/finally is what makes
    // that hold — see the gag-pairing pin below; this is the harness's independent floor).
    global.gag = 0;
});

/// A bare `Scope` — the builders' POD paths never dereference it, and the paths that DO
/// (`sc.push()` in the identity-opAssign detection) only need a pushable scope.
function sc(): Scope {
    return new Scope();
}

function id(name: string): Identifier {
    return Identifier.idPool(ds(name));
}

/// `new StructDeclaration(loc, id, inObject: false)` — the shape every non-`object.d` parse uses.
function makeStruct(name = "S"): StructDeclaration {
    return new StructDeclaration(Loc.initial, id(name), false);
}

/// A field of the given basic type, pushed into `sd.fields` the way `setFieldOffset` would.
function addField(sd: StructDeclaration, name: string, t: Type): VarDeclaration {
    const v = new VarDeclaration(Loc.initial, t, id(name), null, STC.field);
    sd.fields.push(v);
    return v;
}

/// A `FuncDeclaration` carrying just a `TypeFunction` — the only thing `mergeFuncAttrs` reads.
function makeFunc(configure: (tf: TypeFunction) => void, stc: STC = STC.none): FuncDeclaration {
    const tf = new TypeFunction(new ParameterList(null), Type.tvoid, LINK.d);
    configure(tf);
    return new FuncDeclaration(Loc.initial, Loc.initial, id("f"), stc, tf);
}

describe("export surface", () => {
    test("smoke: importing dmd.clone executes its top level and exports the D surface", () => {
        expect(typeof mergeFuncAttrs).toBe("function");
        expect(typeof needOpEquals).toBe("function");
        expect(typeof buildDtors).toBe("function");
        expect(typeof buildPostBlit).toBe("function");
        expect(typeof buildInv).toBe("function");
        expect(typeof needCopyOrMoveCtor).toBe("function");
    });
});

describe("mergeFuncAttrs (dmd/clone.d:54)", () => {
    test("a null function returns s1 unchanged (clone.d:56)", () => {
        // Every caller passes a possibly-absent special member (`sd.dtor`, `sdv.postblit`, the
        // result of `hasIdentityOpAssign`), so this early-out is the common case.
        const s1 = (STC.safe | STC.nothrow_ | STC.pure_ | STC.nogc) as STC;
        expect(mergeFuncAttrs(s1, null)).toBe(s1);
    });

    test("pure/nothrow/nogc are INTERSECTED, @disable is UNIONED (clone.d:75-78)", () => {
        // `stc = (sa & (pure|nothrow|nogc)) | (so & disable)`: an attribute survives only if BOTH
        // sides have it, while a single @disable poisons the result.
        const s1 = (STC.safe | STC.nothrow_ | STC.pure_ | STC.nogc) as STC;
        const f = makeFunc((tf) => {
            tf.trust = TRUST.safe;
            tf.purity = PURE.const_;   // != PURE.impure -> contributes STC.pure_
            tf.isNothrow = true;
            tf.isNogc = false;         // NOT @nogc -> the intersection drops @nogc
        }, STC.disable);
        const r = mergeFuncAttrs(s1, f);
        expect((r & STC.pure_) !== 0n).toBe(true);
        expect((r & STC.nothrow_) !== 0n).toBe(true);
        expect((r & STC.nogc) !== 0n).toBe(false);   // intersected away
        expect((r & STC.disable) !== 0n).toBe(true); // unioned in
    });

    test("@system on either side dominates the trust ladder (clone.d:80-87)", () => {
        // `if (so & system) system;` is tested FIRST, so a @system member wins over a @safe s1.
        const f = makeFunc((tf) => { tf.trust = TRUST.system; });
        const r = mergeFuncAttrs(STC.safe, f);
        expect((r & STC.system) !== 0n).toBe(true);
        expect((r & STC.safe) !== 0n).toBe(false);
        expect((r & STC.trusted) !== 0n).toBe(false);
    });

    test("@trusted vs @safe: the mixed pair degrades to @trusted (clone.d:84-85)", () => {
        // `(so & (trusted|safe)) == (trusted|safe)` — one side @safe, the other @trusted.
        const f = makeFunc((tf) => { tf.trust = TRUST.trusted; });
        const r = mergeFuncAttrs(STC.safe, f);
        expect((r & STC.trusted) !== 0n).toBe(true);
        expect((r & STC.safe) !== 0n).toBe(false);
    });

    test("@safe on both sides stays @safe (clone.d:87)", () => {
        const f = makeFunc((tf) => { tf.trust = TRUST.safe; });
        const r = mergeFuncAttrs(STC.safe, f);
        expect((r & STC.safe) !== 0n).toBe(true);
        expect((r & STC.trusted) !== 0n).toBe(false);
        expect((r & STC.system) !== 0n).toBe(false);
    });
});

describe("needOpEquals (dmd/clone.d:417)", () => {
    test("a field-less struct does not need one (clone.d:471 dontneed)", () => {
        expect(needOpEquals(makeStruct())).toBe(false);
    });

    test("a union with != 1 field bails early; a 1-field union is treated as a struct (clone.d:430-436)", () => {
        const u2 = new UnionDeclaration(Loc.initial, id("U2"));
        addField(u2, "a", Type.tfloat64);
        addField(u2, "b", Type.tfloat64);
        // Two fields -> `dontneed()` BEFORE the float scan, even though the fields are floating.
        expect(needOpEquals(u2)).toBe(false);

        const u1 = new UnionDeclaration(Loc.initial, id("U1"));
        addField(u1, "a", Type.tfloat64);
        // One field -> falls through to the field scan, where the float arm fires.
        expect(needOpEquals(u1)).toBe(true);
    });

    test("hasIdentityEquals short-circuits to need() (clone.d:437)", () => {
        const sd = makeStruct();
        sd.hasIdentityEquals = true;
        expect(needOpEquals(sd)).toBe(true);
    });

    test("a floating field forces one; an integral field does not (clone.d:457-463)", () => {
        // "comparison of +0.0 and -0.0 should be true; comparison of NANs should be false always".
        const withInt = makeStruct("SI");
        addField(withInt, "x", Type.tint32);
        expect(needOpEquals(withInt)).toBe(false);

        const withDouble = makeStruct("SD");
        addField(withDouble, "x", Type.tfloat64);
        expect(needOpEquals(withDouble)).toBe(true);
    });

    test("a `ref` or overlapped field is skipped (clone.d:444-447)", () => {
        const sd = makeStruct();
        const v = addField(sd, "x", Type.tfloat64);
        v.storage_class = (v.storage_class | STC.ref_) as STC;
        expect(needOpEquals(sd)).toBe(false);   // skipped by the `ref` continue

        const sd2 = makeStruct("S2");
        const v2 = addField(sd2, "x", Type.tfloat64);
        v2.overlapped = true;
        expect(needOpEquals(sd2)).toBe(false);  // skipped by the overlapped continue
    });
});

describe("the POD paths visitStructDeclaration calls unconditionally", () => {
    // dsymbolsem.ts:1514-1540 runs every builder on EVERY struct, including a plain-old-data one.
    // These pins fail the moment a wall creeps onto a POD path.

    test("buildInv on a struct with no invariants returns null (clone.d:1219 case 0)", () => {
        const sd = makeStruct();
        // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool) —
        // 02 §11.5; the runtime object IS an AggregateDeclaration.
        expect(buildInv(sd as unknown as AggregateDeclaration, sc())).toBe(null);
    });

    test("buildPostBlit on a POD struct builds nothing and returns null (clone.d:1481 case 0)", () => {
        const sd = makeStruct();
        addField(sd, "x", Type.tint32);
        expect(buildPostBlit(sd, sc())).toBe(null);
        expect(sd.postblits.length).toBe(0);
        expect(sd.members).toBe(null);          // nothing was pushed
    });

    test("buildDtors on a POD struct leaves dtor/aggrDtor/fieldDtor/tidtor null (clone.d:1025 case 0)", () => {
        const sd = makeStruct();
        addField(sd, "x", Type.tint32);
        buildDtors(sd as unknown as AggregateDeclaration, sc());
        expect(sd.fieldDtor).toBe(null);
        expect(sd.aggrDtor).toBe(null);
        expect(sd.dtor).toBe(null);
        expect(sd.tidtor).toBe(null);           // buildExternDDtor's `if (!dtor) return null;`
    });

    test("buildDtors returns immediately for a union (clone.d:906)", () => {
        const u = new UnionDeclaration(Loc.initial, id("U"));
        buildDtors(u as unknown as AggregateDeclaration, sc());
        expect(u.dtor).toBe(null);
        expect(u.tidtor).toBe(null);            // NOT even the buildExternDDtor tail ran
    });

    test("buildPostBlit returns null for a union before any scan (clone.d:1276)", () => {
        const u = new UnionDeclaration(Loc.initial, id("U"));
        expect(buildPostBlit(u, sc())).toBe(null);
    });
});

describe("needCopyOrMoveCtor (dmd/clone.d:1685) — the four out-parameter boxes (03 §3.3)", () => {
    const boxes = (): [Ref<boolean>, Ref<boolean>, Ref<boolean>, Ref<boolean>] =>
        [{ value: true }, { value: true }, { value: true }, { value: true }];

    test("a prior error aborts the analysis, and the out params are still RESET (clone.d:1688)", () => {
        // D default-initializes every `out` parameter on entry, before the `global.errors` bail —
        // so a caller's stale `true` must not survive the call.
        global.errors = 1;
        const [hasCp, hasMv, needCp, needMv] = boxes();
        needCopyOrMoveCtor(makeStruct(), hasCp, hasMv, needCp, needMv);
        expect([hasCp.value, hasMv.value, needCp.value, needMv.value]).toEqual([false, false, false, false]);
    });
});

describe("the identity-opAssign detection (clone.d:113-128) — live overload resolution", () => {
    /// The struct state `visitStructDeclaration` has built before it calls any clone builder, plus
    /// the ONE member `search_function(ad, Id.opAssign)` has to find.
    ///
    /// Harness support, not a code concession (10 §1.9): `opAssign.parent` is set because the live
    /// `resolveFuncCall` path reaches `ungagSpeculative` (dsymbolsem.ts:2398), which dereferences
    /// `s.toParent2()` exactly as dmd/dsymbolsem.d:1983 does. Real compilation sets that parent in
    /// `addMember`; a symtab-only insert leaves it null, so D would fault there too.
    function structWithOpAssign(): [StructDeclaration, FuncDeclaration] {
        const sd = makeStruct();
        sd.members = new Array_<Dsymbol | null>();
        sd.symtab = new DsymbolTable();
        const opAssign = makeFunc((tf) => { tf.trust = TRUST.safe; });
        opAssign.ident = Id.opAssign!;
        // upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool) — 02 §11.5; the
        // runtime object IS a Dsymbol.
        sd.symtab.insert(opAssign as unknown as Dsymbol);
        opAssign.parent = sd as unknown as Dsymbol;
        return [sd, opAssign];
    }

    test("a non-matching user opAssign resolves to null — no wall on the path (clone.d:120)", () => {
        // RE-PIN (10 §1.8 rule 7 + rule 9). This test used to pin the §2.5 wall over `resolveFuncCall`
        // (the message named funcsem.d:1905 as unported); funcsem.ts:2016 landed, the
        // wall is swept, and the coverage the pin bought is converted into (a) a NEGATIVE pin naming
        // only the callee the sweep removed — which survives whatever funcsem does next — and (b) the
        // behaviour D produces for this input.
        //
        // The behaviour: `makeFunc` builds `void opAssign()`, a ZERO-parameter overload, and
        // dmd/clone.d:120 resolves against a ONE-argument `ArgumentList`. No overload matches, the
        // second try with the dummy lvalue (clone.d:124) matches nothing either, so D returns null.
        const [sd] = structWithOpAssign();
        expect(() => hasIdentityOpAssign(sd as unknown as AggregateDeclaration, sc())).not.toThrow(/resolveFuncCall/);
        expect(hasIdentityOpAssign(sd as unknown as AggregateDeclaration, sc())).toBe(null);
        expect(global.errors).toBe(0);   // the whole region is gagged (clone.d:113)
    });

    test("global.gag is balanced across the detection (11 §2.5 paired state)", () => {
        // `startGagging()` at clone.d:113 raises a PROCESS-global counter. If the matching
        // `endGagging` is ever lost — by an early return, or by a wall re-appearing inside
        // `resolveFuncCall` and escaping the port's try/finally — `global.gag` stays raised for the
        // rest of the process, every later `error()` is silently swallowed (globals.ts:536) and
        // `global.errors` stops counting. The try/finally in the port is what holds this.
        const [sd] = structWithOpAssign();
        const gagBefore = global.gag;
        hasIdentityOpAssign(sd as unknown as AggregateDeclaration, sc());
        expect(global.gag).toBe(gagBefore);
    });
});

describe("buildOpEquals (dmd/clone.d:541)", () => {
    test("always returns null — opEquals is never implicitly generated (issue 3789)", () => {
        // The function's whole job is the `sd.hasIdentityEquals` side effect; the built-in
        // comparison is `s1.tupleof == s2.tupleof`, generated in opOverloadEquals, not here.
        //
        // Harness note (10 §1.9 — the test adapts, never the code): `search_function` routes into
        // dsymbolsem's `SearchVisitor`, whose struct arm raises a forward-reference diagnostic when
        // `members`/`symtab` are unset (dsymbolsem.ts:344). `visitStructDeclaration` has both built
        // before it calls any clone builder, so the pin reproduces that state instead of pinning
        // another file's wall.
        const sd = makeStruct();
        sd.members = new Array_<Dsymbol | null>();
        sd.symtab = new DsymbolTable();
        expect(buildOpEquals(sd, sc())).toBe(null);
        expect(sd.hasIdentityEquals).toBe(false);   // no user opEquals member -> flag stays false
    });
});
