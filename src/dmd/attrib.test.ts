// Co-located tests for src/dmd/attrib.ts (dmd/attrib.d).
//
// `dmd/attrib.d` contains ZERO in-source `unittest{}` blocks (verified: `grep -c '^unittest'`
// returns 0), so per 10-tests-diagnostics.md §1.6b this file is the thin test file: one
// module-load smoke test plus a small set of behavior pins constructible with the EXISTING
// harness conventions. No new harness machinery, and no fabricated pins for paths the harness
// cannot reach honestly.
//
// Setup is the §1.5 canonical init snippet in the 01 §5.2 ORDER contract. `Type._init()` is
// deliberately NOT called (it throws from a sibling in-flight defect); nothing here needs the
// basic-type table — `NullExp` is constructible without it.

import { beforeEach, describe, expect, test } from "vitest";
import {
    AlignDeclaration,
    AnonDeclaration,
    AttribDeclaration,
    CPPMangleDeclaration,
    CPPNamespaceDeclaration,
    ConditionalDeclaration,
    DeprecatedDeclaration,
    ForwardingAttribDeclaration,
    LinkDeclaration,
    MixinDeclaration,
    PragmaDeclaration,
    StaticForeachDeclaration,
    StaticIfDeclaration,
    StorageClassDeclaration,
    UserAttributeDeclaration,
    VisibilityDeclaration,
    foreachUdaNoSemantic,
    isCoreUda,
    isEnumAttribute,
} from "./attrib.js";
import { Dsymbol, DSYM, Visibility } from "./dsymbol.js";
import { CPPMANGLE, LINK, STC, structalign_t } from "./astenums.js";
import { Scope } from "./dscope.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { initTokens } from "./tokens.js";
import { NullExp, TupleExp, type Expression } from "./expression.js";
import { Array as DArray } from "./root/array.js";
import type { Expressions } from "./arraytypes.js";
import { cstr, dsToJs } from "../dstring.js";

beforeEach(() => {
    Loc._init();
    initTokens(); // also runs Identifier.initTable
    Id.initialize();
});

function id(name: string): Identifier {
    return Identifier.idPool(Uint8Array.from(Array.from(name, (c) => c.charCodeAt(0))));
}

function exprs(...es: Expression[]): Expressions {
    // Constructed AS the `Expressions` alias — element type `Expression | null` (08 §3).
    const a = new DArray<Expression | null>();
    for (const e of es) a.push(e);
    return a;
}

describe("module load smoke (§1.6b)", () => {
    test("importing dmd/attrib.ts executes its top level and exports the whole family", () => {
        // A load-order/cycle regression in this core-SCC module surfaces here as a
        // "cannot access before initialization" at import time.
        for (const c of [AttribDeclaration, StorageClassDeclaration, DeprecatedDeclaration,
            LinkDeclaration, CPPMangleDeclaration, CPPNamespaceDeclaration, VisibilityDeclaration,
            AlignDeclaration, AnonDeclaration, PragmaDeclaration, ConditionalDeclaration,
            StaticIfDeclaration, StaticForeachDeclaration, ForwardingAttribDeclaration,
            MixinDeclaration, UserAttributeDeclaration]) {
            expect(typeof c).toBe("function");
        }
        expect(typeof isCoreUda).toBe("function");
        expect(typeof foreachUdaNoSemantic).toBe("function");
        expect(typeof isEnumAttribute).toBe("function");
    });
});

describe("AttribDeclaration ctor collapse (attrib.d:50/:56/:62)", () => {
    test("the one-argument form leaves loc at Loc.initial and ident null; kind() is `attribute`", () => {
        // `StorageClassDeclaration(stc, decl)` -> `super(decl)` -> `super(DSYM.attribDeclaration)`.
        const scd = new StorageClassDeclaration(STC.static_, null);
        expect(scd.loc.equals(Loc.initial)).toBe(true);
        expect(scd.ident).toBe(null);
        expect(scd.decl).toBe(null);
        expect(scd.stc).toBe(STC.static_);
        expect(scd.dsym).toBe(DSYM.storageClassDeclaration);
        // kind() is inherited from AttribDeclaration (attrib.d:100).
        expect(dsToJs(scd.kind())).toBe("attribute");
    });

    test("the loc-carrying form stores the location; the ident form stores the identifier", () => {
        const loc = Loc.initial;
        const withLoc = new StorageClassDeclaration(STC.const_, null, loc);
        expect(withLoc.loc.equals(loc)).toBe(true);

        // PragmaDeclaration is the one class that uses the (loc, ident, decl) base form.
        const pd = new PragmaDeclaration(loc, id("inline"), null, null);
        expect(pd.ident).toBe(id("inline"));
        expect(pd.dsym).toBe(DSYM.pragmaDeclaration);
        expect(dsToJs(pd.kind())).toBe("pragma");
    });
});

describe("AttribDeclaration.createNewScope (attrib.d:74)", () => {
    test("returns the SAME scope when every attribute already matches", () => {
        const sc = Scope.alloc();
        const same = AttribDeclaration.createNewScope(sc, sc.stc, sc.linkage, sc.cppmangle,
            sc.visibility, sc.explicitVisibility, sc.aligndecl, sc.inlining);
        expect(same).toBe(sc); // identity: no copy was made
    });

    test("copies the scope and applies the attributes when one differs", () => {
        const sc = Scope.alloc();
        sc.stc = STC.none;
        const sc2 = AttribDeclaration.createNewScope(sc, STC.static_, sc.linkage, sc.cppmangle,
            sc.visibility, sc.explicitVisibility, sc.aligndecl, sc.inlining);
        expect(sc2).not.toBe(sc);
        expect(sc2.stc).toBe(STC.static_);
        expect(sc.stc).toBe(STC.none); // the original is untouched
    });

    test("a differing `visibility` is detected by the struct's opEquals, not by identity", () => {
        const sc = Scope.alloc();
        sc.visibility = new Visibility(Visibility.Kind.public_);
        // An EQUAL-BUT-DISTINCT Visibility object must NOT trigger a copy (D compares by value).
        const equalValue = new Visibility(Visibility.Kind.public_);
        expect(AttribDeclaration.createNewScope(sc, sc.stc, sc.linkage, sc.cppmangle,
            equalValue, sc.explicitVisibility, sc.aligndecl, sc.inlining)).toBe(sc);
        // A genuinely different visibility does.
        const differing = new Visibility(Visibility.Kind.private_);
        const sc2 = AttribDeclaration.createNewScope(sc, sc.stc, sc.linkage, sc.cppmangle,
            differing, sc.explicitVisibility, sc.aligndecl, sc.inlining);
        expect(sc2).not.toBe(sc);
        expect(sc2.visibility.kind).toBe(Visibility.Kind.private_);
        // The store into the copy is a value copy (03 §1 #5), not an alias of the argument.
        expect(sc2.visibility).not.toBe(differing);
    });
});

describe("Form-B constructor sets — the named factories (04 §1.1(c))", () => {
    test("CPPNamespaceDeclaration: the Expression form is the ctor; ident/5-arg are factories", () => {
        const loc = Loc.initial;
        const e = new NullExp(loc);

        const byExp = new CPPNamespaceDeclaration(loc, e, null);
        expect(byExp.exp).toBe(e);
        expect(byExp.ident).toBe(null);
        expect(byExp.dsym).toBe(DSYM.cppNamespaceDeclaration);

        const byIdent = CPPNamespaceDeclaration.fromIdentifier(loc, id("foo"), null);
        expect(byIdent.ident).toBe(id("foo"));
        expect(byIdent.exp).toBe(null);

        const full = CPPNamespaceDeclaration.fromIdentifierExpParent(loc, id("bar"), e, null, byIdent);
        expect(full.ident).toBe(id("bar"));
        expect(full.exp).toBe(e);
        expect(full.cppnamespace()).toBe(byIdent);
    });

    test("AlignDeclaration: a single Expression wraps into a one-element Expressions; factories fill the rest", () => {
        const loc = Loc.initial;
        const e = new NullExp(loc);

        const byExp = new AlignDeclaration(loc, e, null);
        expect(byExp.exps).not.toBe(null);
        expect(byExp.exps!.length).toBe(1);
        expect(byExp.exps!.opIndex(0)).toBe(e);
        expect(byExp.dsym).toBe(DSYM.alignDeclaration);
        // A null `exp` leaves `exps` null (attrib.d:400 `if (exp)`).
        expect(new AlignDeclaration(loc, null, null).exps).toBe(null);

        const list = exprs(e);
        expect(AlignDeclaration.fromExps(loc, list, null).exps).toBe(list); // stored by reference

        const sa = new structalign_t();
        sa.set(8);
        const bySalign = AlignDeclaration.fromSalign(loc, sa, null);
        expect(bySalign.salign.get()).toBe(8);
        expect(bySalign.salign).not.toBe(sa); // by-value struct field store copies (03 §1 #5)
    });

    test("VisibilityDeclaration: the Visibility form is the ctor; the package form is a factory", () => {
        const loc = Loc.initial;
        const vd = new VisibilityDeclaration(loc, new Visibility(Visibility.Kind.public_), null);
        expect(vd.visibility.kind).toBe(Visibility.Kind.public_);
        expect(vd.pkg_identifiers).toBe(null); // D slice `.init` is the NULL slice (06 §2.8)
        expect(vd.dsym).toBe(DSYM.visibilityDeclaration);
        expect(dsToJs(vd.kind())).toBe("visibility attribute");

        // An EMPTY (or null) identifier list skips the Package.resolve block entirely — D reads
        // `.length` off a possibly-null slice as 0 (attrib.d:344).
        const pkg = VisibilityDeclaration.fromPkgIdentifiers(loc, null, null);
        expect(pkg.visibility.kind).toBe(Visibility.Kind.package_);
        expect(pkg.pkg_identifiers).toBe(null);
    });
});

describe("kind() strings and the dsym retags", () => {
    test("AnonDeclaration reports union vs struct off `isunion` (attrib.d:458)", () => {
        const loc = Loc.initial;
        expect(dsToJs(new AnonDeclaration(loc, true, null).kind())).toBe("anonymous union");
        expect(dsToJs(new AnonDeclaration(loc, false, null).kind())).toBe("anonymous struct");
        expect(new AnonDeclaration(loc, true, null).dsym).toBe(DSYM.anonDeclaration);
    });

    test("MixinDeclaration / LinkDeclaration / DeprecatedDeclaration tags", () => {
        const loc = Loc.initial;
        const md = new MixinDeclaration(loc, null);
        expect(md.dsym).toBe(DSYM.mixinDeclaration);
        expect(dsToJs(md.kind())).toBe("mixin");

        const ld = LinkDeclaration.create(loc, LINK.c, null);
        expect(ld).toBeInstanceOf(LinkDeclaration);
        expect(ld.linkage).toBe(LINK.c);
        expect(ld.dsym).toBe(DSYM.linkDeclaration);

        // attrib.d:159 — DeprecatedDeclaration does NOT retag; it keeps its base's tag.
        const dd = new DeprecatedDeclaration(new NullExp(loc), null);
        expect(dd.stc).toBe(STC.deprecated_);
        expect(dd.dsym).toBe(DSYM.storageClassDeclaration);

        expect(new CPPMangleDeclaration(loc, CPPMANGLE.asStruct, null).cppmangle).toBe(CPPMANGLE.asStruct);
    });
});

describe("UserAttributeDeclaration.concat (attrib.d:722)", () => {
    test("an empty/null operand returns the OTHER operand by reference (copy-on-write)", () => {
        const loc = Loc.initial;
        const a = exprs(new NullExp(loc));
        const empty = exprs();

        expect(UserAttributeDeclaration.concat(null, a)).toBe(a);
        expect(UserAttributeDeclaration.concat(empty, a)).toBe(a);
        expect(UserAttributeDeclaration.concat(a, null)).toBe(a);
        expect(UserAttributeDeclaration.concat(a, empty)).toBe(a);
        expect(UserAttributeDeclaration.concat(null, null)).toBe(null);
    });

    test("two non-empty operands build a fresh 2-element tuple; neither operand is appended to", () => {
        const loc = Loc.initial;
        const a = exprs(new NullExp(loc));
        const b = exprs(new NullExp(loc), new NullExp(loc));

        const r = UserAttributeDeclaration.concat(a, b)!;
        expect(r).not.toBe(a);
        expect(r).not.toBe(b);
        expect(r.length).toBe(2);
        expect(r.opIndex(0)).toBeInstanceOf(TupleExp);
        expect(r.opIndex(1)).toBeInstanceOf(TupleExp);
        const t0 = r.opIndex(0)!.isTupleExp();
        const t1 = r.opIndex(1)!.isTupleExp();
        expect(t0!.exps).toBe(a);
        expect(t1!.exps).toBe(b);
        // copy-on-write: the operands are untouched
        expect(a.length).toBe(1);
        expect(b.length).toBe(2);
    });
});

describe("foreachUdaNoSemantic (attrib.d:787)", () => {
    test("returns 0 for a symbol with no userAttribDecl and never calls the delegate", () => {
        const sym = Dsymbol.create(id("s"));
        let calls = 0;
        expect(foreachUdaNoSemantic(sym, () => { calls++; return 1; })).toBe(0);
        expect(calls).toBe(0);
    });

    test("returns 0 when the attached UserAttributeDeclaration has null atts", () => {
        const sym = Dsymbol.create(id("s"));
        sym.userAttribDecl_set(new UserAttributeDeclaration(null, null));
        let calls = 0;
        expect(foreachUdaNoSemantic(sym, () => { calls++; return 1; })).toBe(0);
        expect(calls).toBe(0);
    });

    test("visits every UDA in order, and short-circuits on the first non-zero result", () => {
        const loc = Loc.initial;
        const e0 = new NullExp(loc);
        const e1 = new NullExp(loc);
        const sym = Dsymbol.create(id("s"));
        sym.userAttribDecl_set(new UserAttributeDeclaration(exprs(e0, e1), null));

        const seen: Expression[] = [];
        expect(foreachUdaNoSemantic(sym, (e) => { seen.push(e); return 0; })).toBe(0);
        expect(seen).toEqual([e0, e1]);

        seen.length = 0;
        expect(foreachUdaNoSemantic(sym, (e) => { seen.push(e); return 7; })).toBe(7);
        expect(seen).toEqual([e0]); // stopped at the first non-zero
    });

    // A UserAttributeDeclaration with no enclosing UDA: `sym.userAttribDecl` reads the null base slot and D
    // returns 0 (attrib.d:789).
    test("a UserAttributeDeclaration scanned as the symbol returns 0 like D", () => {
        const uad = new UserAttributeDeclaration(exprs(new NullExp(Loc.initial)), null);
        expect(foreachUdaNoSemantic(uad, () => 1)).toBe(0);
    });
});

describe("syntaxCopy — structural deep copy (03 / the family's `assert(!s)` contract)", () => {
    test("StorageClassDeclaration.syntaxCopy yields a distinct node carrying the same stc", () => {
        const scd = new StorageClassDeclaration(STC.const_, null);
        const copy = scd.syntaxCopy(null);
        expect(copy).not.toBe(scd);
        expect(copy).toBeInstanceOf(StorageClassDeclaration);
        expect(copy.stc).toBe(STC.const_);
    });

    test("MixinDeclaration.syntaxCopy has NO assert(!s) in D — a non-null argument is accepted", () => {
        const md = new MixinDeclaration(Loc.initial, null);
        // attrib.d:682 omits the `assert(!s)` its siblings carry; the port is faithful to that.
        const copy = md.syntaxCopy(md);
        expect(copy).not.toBe(md);
        expect(copy).toBeInstanceOf(MixinDeclaration);
    });

    test("VisibilityDeclaration.syntaxCopy routes a `package` node through the pkg factory", () => {
        const loc = Loc.initial;
        const vd = VisibilityDeclaration.fromPkgIdentifiers(loc, null, null);
        const copy = vd.syntaxCopy(null);
        expect(copy).not.toBe(vd);
        expect(copy.visibility.kind).toBe(Visibility.Kind.package_);
    });
});

describe("VisibilityDeclaration.toPrettyChars (attrib.d:367)", () => {
    // RE-PIN (10 §1.8 rule 7), wave 11: this was a pinned wall over `hdrgen.visibilityToBuffer`
    // (dmd/attrib.d:371). The call is live now (hdrgen.d:3527), so the body completes. D path:
    // attrib.d:367 is a direct virtual override, reached by every `toPrettyChars` call on a
    // VisibilityDeclaration. The expected spellings are D's `visibilityToString` table
    // (hdrgen.d:3549), and a non-package visibility gets no `(pkg)` suffix (hdrgen.d:3530).
    test("prints the visibility keyword through hdrgen's visibilityToBuffer", () => {
        const pub = new VisibilityDeclaration(Loc.initial, new Visibility(Visibility.Kind.public_), null);
        expect(dsToJs(cstr(pub.toPrettyChars()))).toBe("public");
        const priv = new VisibilityDeclaration(Loc.initial, new Visibility(Visibility.Kind.private_), null);
        expect(dsToJs(cstr(priv.toPrettyChars()))).toBe("private");
    });
});
