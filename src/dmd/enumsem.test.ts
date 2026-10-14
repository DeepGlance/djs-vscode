// Co-located tests for `src/dmd/enumsem.ts` (dmd/enumsem.d has ZERO `unittest` blocks — verified
// `grep -c '^unittest' dmd/enumsem.d` -> 0), so this file is the thin test file of
// 10 §1.6b: one module-load smoke test plus ONE behavior pin per risky resolved CONCERN.
//
// The concerns pinned here, and why each is risky:
//   * the `PASS`-state gates of `enumSemantic` / `enumMemberSemantic` — three different early
//     returns, each leaving a DIFFERENT `semanticRun` (`semantic2done` untouched / `semanticdone`
//     after the circular-reference report / `initial` on the null-scope fall-out);
//   * `getMemtype`'s two outcomes (default-to-`int` vs the forward-reference error to `terror`) —
//     it is one of the two functions typesem.ts/dcast.ts currently wall against, and both are
//     WALL-FREE in this port;
//   * `getDefaultValue`'s issue-23904 cache rule (a cached `ErrorExp` must NOT be returned), its
//     first-member path, and its two error paths;
//   * `errorReturn` (enumsem.d:348) setting BOTH `errors` and `semanticRun` — a nested closure
//     whose two writes are easy to lose in translation;
//   * GAG PAIRING (11 §2.5) in the auto-increment branch (enumsem.d:564-584): the port's walls are
//     exit paths D does not have, so each `startGagging`/`endGagging` region is guarded — and the
//     guard must span the WHOLE D region, first statement to `endGagging`. Two pins cover it: the
//     ordinary path through both regions (now wall-free: `ctfeInterpret` is live), and a throw
//     from the FIRST statements of the region (the ones a late-opening guard would leave
//     unprotected). Both assert `global.gag` is back to 0; a leaked gag silently suppresses every
//     later diagnostic in the process.
//   * the SWEPT `checkMustUseReserved` call (dmd/enumsem.d:122 -> dmd/mustuse.d:58). This slot held
//     a PINNED WALL until mustuse.ts landed and exported the callee (mustuse.ts:143); the wall was
//     swept, so per 10 §1.8 rule 7 the pin was CONVERTED into a behaviour pin on what the now-live
//     call produces on this path, plus the rule-9 negative pin naming the removed callee. A pin on
//     the vanished throw would have been a pin on a wall that no longer exists.
//
// DIAGNOSTIC TEXT: `error()` prints through `printDiagnostic` to stderr, NOT through
// `global.errorSink` (errors.ts:358-368), so a sink subclass cannot observe the message. Following
// the house convention (typesem.basic.test.ts:43-45), the error pins GAG the print and assert the
// bumped counter — `global.errors` is incremented before the gag test either way. Byte-exact
// diagnostic text is the corpus's oracle (10 §5), not this file's.
//
// No new harness machinery is built: the init snippet and `globalScope()` are the existing
// sema-test conventions (10 §1.5, mirroring sema.var.test.ts).

import { describe, it, expect, beforeEach } from "vitest";

import { enumSemantic, getDefaultValue, getMemtype, enumMemberSemantic } from "./enumsem.js";
import { EnumDeclaration, EnumMember } from "./denum.js";
import { PASS } from "./dsymbol.js";
import { Type } from "./mtype.js";
import { TY } from "./astenums.js";
import { Loc } from "./location.js";
import { Identifier } from "./identifier.js";
import { Id } from "./id.js";
import { initTokens } from "./tokens.js";
import { global } from "./globals.js";
import { ErrorSinkNull } from "./errorsink.js";
import { ErrorExp, IntegerExp } from "./expression.js";
import { toInteger } from "./expressionsem.js";
import { Module, moduleFromParse } from "./dmodule.js";
import { Scope } from "./dscope.js";
import { Array as DArray } from "./root/array.js";
import { ds } from "../dstring.js";

import type { Dsymbol } from "./dsymbol.js";
import type { Dsymbols } from "./arraytypes.js";
import { Type_init } from "./typesem.js";
import { scopeCreateGlobal } from "./dsymbolsem.js";

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

/** `enum <name> { a }` built directly (no parser): a named enum with one member. */
function namedEnumWithOneMember(name: string): EnumDeclaration {
    const ed = new EnumDeclaration(Loc.initial, id(name), null);
    const em = new EnumMember(Loc.initial, id("a"), null, null);
    em.ed = ed;
    const members: Dsymbols = new DArray<Dsymbol | null>();
    members.push(em);
    ed.members = members;
    return ed;
}

/** Run `body` with the diagnostic printer gagged; the `global.errors` bump still happens. */
function gagged<T>(body: () => T): T {
    global.gag = 1;
    try {
        return body();
    } finally {
        global.gag = 0;
    }
}

describe("enumsem — module surface", () => {
    it("loads and exports the four dmd/enumsem.d free functions", () => {
        // Smoke test (10 §1.6b): importing the module executes its top level, so a load-order or
        // import-cycle regression in the core SCC shows up here. The D file has exactly four
        // top-level declarations (enumsem.d:86/:257/:309/:344) and all four are free functions —
        // Idiom B has no visitor class to export (13 §7/§7.5).
        expect(typeof enumSemantic).toBe("function");
        expect(typeof getDefaultValue).toBe("function");
        expect(typeof getMemtype).toBe("function");
        expect(typeof enumMemberSemantic).toBe("function");
    });
});

describe("enumSemantic — the PASS gates (dmd/enumsem.d:90-109)", () => {
    it("returns untouched when semantic already completed (enumsem.d:90)", () => {
        const ed = new EnumDeclaration(Loc.initial, id("Done"), null);
        ed.semanticRun = PASS.semantic2done;
        ed.symtab = null;

        enumSemantic(null, ed);

        // Nothing ran: no diagnostic, no symtab, and the state is exactly as it was.
        expect(global.errors).toBe(0);
        expect(ed.semanticRun).toBe(PASS.semantic2done);
        expect(ed.symtab).toBe(null);
        expect(ed.errors).toBe(false);
    });

    it("reports a circular base-type reference and finishes the pass (enumsem.d:92-99)", () => {
        const ed = new EnumDeclaration(Loc.initial, id("Circular"), null);
        // The D branch asserts `ed.memtype` before printing it, so the state must be one D can
        // actually reach: mid-pass, with a base type already installed.
        ed.memtype = Type.tint32;
        ed.semanticRun = PASS.semantic;

        gagged(() => enumSemantic(null, ed));

        expect(global.errors).toBe(1);
        expect(ed.errors).toBe(true);
        expect(ed.semanticRun).toBe(PASS.semanticdone);
    });

    it("returns without work when the scope is null (enumsem.d:108)", () => {
        const ed = new EnumDeclaration(Loc.initial, id("NoScope"), null);
        // `ed._scope` is null and the caller passes null, so D falls out at enumsem.d:109 BEFORE
        // touching `parent`/`type`. `semanticRun` stays `initial` — distinct from both gates above.
        enumSemantic(null, ed);

        expect(global.errors).toBe(0);
        expect(ed.semanticRun).toBe(PASS.initial);
        expect(ed.parent).toBe(null);
    });
});

describe("enumSemantic — the swept checkMustUseReserved call (dmd/enumsem.d:122)", () => {
    it("runs the now-live checkMustUseReserved and completes the `enum ident;` leg", () => {
        // RE-PIN (10 §1.8 rule 7): this slot held the PINNED WALL on `checkMustUseReserved`
        // (dmd/enumsem.d:122 -> dmd/mustuse.d:58). mustuse.ts landed and exports the callee
        // (mustuse.ts:143, `void checkMustUseReserved(Dsymbol sym)` at dmd/mustuse.d:58), so the
        // wall was swept and the old pin would have asserted a throw that no longer exists.
        // The behaviour pinned instead is what the now-live body produces on THIS path: `ed`
        // carries no UDAs, so `foreachUdaNoSemantic` (attrib.ts:1019) iterates nothing and emits
        // no diagnostic, and `enumSemantic` walks on to the `enum ident;` early return
        // (dmd/enumsem.d:124-128), which is the state asserted below.
        // The STRONGER pin — a `@mustuse` UDA on an enum producing the reserved-usage diagnostic of
        // dmd/mustuse.d:77 — needs a `TypeExp` over a `TypeEnum` whose `sym` lives in a module
        // answering `isCoreModule("attribute")` (attrib.ts:isCoreUda). mustuse.test.ts's own header
        // lists that fixture as NOT covered anywhere in the tree, so building it here would be new
        // harness machinery for a thin 10 §1.6b artifact; it is left unbuilt and named as such.
        const ed = new EnumDeclaration(Loc.initial, id("Reaches"), null);
        const sc = globalScope();

        enumSemantic(sc, ed);

        expect(ed.semanticRun).toBe(PASS.semanticdone);
        expect(global.errors).toBe(0);
        expect(ed.errors).toBe(false);
    });

    it("no longer halts on the swept callee (negative pin, 10 §1.8 rule 9)", () => {
        // A NEGATIVE pin naming ONLY the callee the sweep removed: it stays valid when the
        // walls this path reaches later move, which a positive pin on any message would not.
        const ed = new EnumDeclaration(Loc.initial, id("NoWall"), null);
        const sc = globalScope();

        expect(() => enumSemantic(sc, ed)).not.toThrow(/checkMustUseReserved/);
    });
});

describe("getMemtype (dmd/enumsem.d:309)", () => {
    it("defaults a named enum WITH members to `int` and caches it (enumsem.d:329-330)", () => {
        const ed = namedEnumWithOneMember("Defaults");

        const t = getMemtype(ed, Loc.initial);

        expect(t).toBe(Type.tint32);
        expect(t.ty).toBe(TY.Tint32);
        expect(ed.memtype).toBe(Type.tint32);   // the slot is written, not just returned
        expect(global.errors).toBe(0);
    });

    it("errors to `terror` for a forward-referenced anonymous enum (enumsem.d:333-336)", () => {
        // Anonymous (`ident === null`) with no members and `semanticRun == initial`: the else leg.
        const ed = new EnumDeclaration(Loc.initial, null, null);

        const t = gagged(() => getMemtype(ed, Loc.initial));

        expect(t).toBe(Type.terror);
        expect(ed.memtype).toBe(null);          // D does NOT cache the error type here
        expect(global.errors).toBe(1);
    });
});

describe("getDefaultValue (dmd/enumsem.d:257)", () => {
    it("returns the cached defaultval when it is not an ErrorExp (enumsem.d:269)", () => {
        const ed = new EnumDeclaration(Loc.initial, id("Cached"), null);
        const cached = new IntegerExp(Loc.initial, 7n, Type.tint32);
        ed.defaultval = cached;

        expect(getDefaultValue(ed, Loc.initial)).toBe(cached);
        expect(global.errors).toBe(0);
    });

    it("ignores a cached ErrorExp and re-runs, so the error fires again (issue 23904)", () => {
        // The whole point of the `!ed.defaultval.isErrorExp()` half of enumsem.d:269: a speculative
        // context may have cached `ErrorExp`, and a later non-speculative context must still report.
        const ed = new EnumDeclaration(Loc.initial, id("Opaque"), null);
        const r = gagged(() => {
            ed.defaultval = ErrorExp.get();
            global.errors = 0;                  // ErrorExp.get() itself reports when no error is set
            return getDefaultValue(ed, Loc.initial);
        });

        // Opaque enum: no members, not special -> the diagnostic + `handleErrors()`.
        expect(global.errors).toBe(1);
        expect(r).not.toBe(null);
        expect(r!.isErrorExp()).not.toBe(null);
        expect(ed.defaultval).toBe(r);          // handleErrors() caches what it returns
    });

    it("returns the first enum member's value once that member is done (enumsem.d:292-304)", () => {
        const ed = namedEnumWithOneMember("First");
        const em = ed.members!.opIndex(0)!.isEnumMember()!;
        const v = new IntegerExp(Loc.initial, 3n, Type.tint32);
        em.value = v;
        em.semanticRun = PASS.semanticdone;     // the forward-reference gate at enumsem.d:296

        expect(getDefaultValue(ed, Loc.initial)).toBe(v);
        expect(ed.defaultval).toBe(v);
        expect(global.errors).toBe(0);
    });

    it("reports a forward reference when the first member is not done (enumsem.d:298)", () => {
        const ed = namedEnumWithOneMember("Fwd");
        // `em.semanticRun` stays `initial`, i.e. `< PASS.semanticdone`.

        const r = gagged(() => getDefaultValue(ed, Loc.initial));

        expect(global.errors).toBe(1);
        expect(r!.isErrorExp()).not.toBe(null);
        expect(ed.defaultval).toBe(r);
    });
});

/**
 * `enum <name> { a, b }` where `a` is already done: the shape that drives `enumMemberSemantic(b)`
 * into the auto-increment `else` branch (enumsem.d:526-645) and so into its gagged region.
 * `prevValue === null` leaves `a.value` unset, which makes D's `assert(eprev)` (enumsem.d:566) —
 * the FIRST statements of the gagged region — the exit point instead of a wall further in.
 */
function autoIncrementPair(prevValue: IntegerExp | null): { sc: Scope; second: EnumMember } {
    const sc = globalScope();
    const ed = new EnumDeclaration(Loc.initial, id("Auto"), null);
    ed.memtype = Type.tint32;
    // `enumMemberSemantic` runs `dsymbolSemantic(em.ed, sc)` first (enumsem.d:363); a finished enum
    // returns at the very first gate (enumsem.d:90), so the member pass is what the pin exercises.
    ed.semanticRun = PASS.semantic2done;

    const a = new EnumMember(Loc.initial, id("a"), null, null);
    a.ed = ed;
    a.semanticRun = PASS.semanticdone;          // enumsem.d:559 — no forward-reference resolve
    a.value = prevValue;
    a.origValue = prevValue;                    // what a finished first member carries (enumsem.d:465)

    const b = new EnumMember(Loc.initial, id("b"), null, null);
    b.ed = ed;                                  // no `value` and not first -> the else branch

    const members: Dsymbols = new DArray<Dsymbol | null>();
    members.push(a);
    members.push(b);
    ed.members = members;
    return { sc, second: b };
}

describe("enumMemberSemantic — the gagged auto-increment region (dmd/enumsem.d:564-584)", () => {
    it("completes both gagged regions: `b` = a + 1, gag restored, no diagnostics (enumsem.d:564-627)", () => {
        // ldc2: `enum Auto : int { a = 0, b }` compiles clean with `Auto.b == 1`. The ordinary path
        // runs `emax.ctfeInterpret()` (:578), the overflow test (:583), the increment (:611) and the
        // origValue fold (:627); no statement of either region throws.
        const { sc, second } = autoIncrementPair(new IntegerExp(Loc.initial, 0n, Type.tint32));

        enumMemberSemantic(sc, second);

        expect(global.gag).toBe(0);
        expect(global.errors).toBe(0);
        expect(second.errors).toBe(false);
        expect(toInteger(second.value!)).toBe(1n);
        expect(toInteger(second.origValue!)).toBe(1n);
    });

    it("restores global.gag when the FIRST statements of the region throw (enumsem.d:565-566)", () => {
        // Region-boundary pin. D's gagged window opens at enumsem.d:564, so `eprev = emprev.value`,
        // `assert(eprev)` and the two `toHeadMutable()` calls are all inside it; a TS guard that
        // opened later (at the `DotIdExp.create` of enumsem.d:576) would let these throw out of an
        // incremented gag. The state is harness-built to force the exit exactly there: a finished
        // previous member with no value, which is what D's `assert(eprev)` exists to reject.
        const { sc, second } = autoIncrementPair(null);

        expect(() => enumMemberSemantic(sc, second)).toThrow();
        expect(global.gag).toBe(0);
    });
});

describe("enumMemberSemantic — the PASS gates (dmd/enumsem.d:354-360)", () => {
    it("returns untouched when the member already completed (enumsem.d:354)", () => {
        const ed = new EnumDeclaration(Loc.initial, id("MDone"), null);
        const em = new EnumMember(Loc.initial, id("a"), null, null);
        em.ed = ed;
        em.semanticRun = PASS.semanticdone;

        enumMemberSemantic(null, em);

        expect(global.errors).toBe(0);
        expect(em.errors).toBe(false);
    });

    it("reports a circular member reference and takes errorReturn (enumsem.d:356-360)", () => {
        const ed = new EnumDeclaration(Loc.initial, id("MCircular"), null);
        const em = new EnumMember(Loc.initial, id("a"), null, null);
        em.ed = ed;
        em.semanticRun = PASS.semantic;

        gagged(() => enumMemberSemantic(null, em));

        expect(global.errors).toBe(1);
        // `errorReturn()` (enumsem.d:348) sets BOTH — that pairing is the thing worth pinning.
        expect(em.errors).toBe(true);
        expect(em.semanticRun).toBe(PASS.semanticdone);
    });
});
