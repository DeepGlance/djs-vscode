// Tests for src/dmd/dsymbol.ts.
//
// dmd/dsymbol.d carries exactly ONE in-source `unittest{}` block — the `Visibility.opCmp` ordering
// test at dsymbol.d:209-214 (10 §1.2: it is `unittest#1` of the file). It is ported first, verbatim.
// The D relational operators on a `Visibility` struct route through `opCmp` (05 §3): `a > b` ->
// `a.opCmp(b) > 0`, `a < b` -> `a.opCmp(b) < 0`, `a >= b` -> `a.opCmp(b) >= 0`.
//
// The remaining blocks are §1.6b behavior pins over what this module can exercise with NO new
// harness machinery: the module-load smoke test, `Visibility.opEquals`/default-init, the DSYM tag
// downcasts, the shared comment table, `DsymbolTable`'s insert/lookup/update contract, and the
// `Dsymbol.toChars` registration slot (its ORDER CONTRACT and the tail arm it reaches in hdrgen.ts).

import { beforeAll, describe, expect, test } from "vitest";
import {
    DSYM,
    Dsymbol,
    DsymbolTable,
    FieldState,
    PASS,
    SearchOpt,
    ScopeDsymbol,
    Visibility,
    AliasAssign,
} from "./dsymbol.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { ds, dsToJs } from "../dstring.js";

describe("dsymbol.d", () => {
    // dsymbol.d:209-214 — the file's only in-source unittest.
    test("unittest#1", () => {
        // assert(Visibility(Visibility.Kind.public_) > Visibility(Visibility.Kind.private_));
        expect(
            new Visibility(Visibility.Kind.public_).opCmp(new Visibility(Visibility.Kind.private_)) > 0,
        ).toBe(true);
        // assert(Visibility(Visibility.Kind.private_) < Visibility(Visibility.Kind.protected_));
        expect(
            new Visibility(Visibility.Kind.private_).opCmp(new Visibility(Visibility.Kind.protected_)) < 0,
        ).toBe(true);
        // assert(Visibility(Visibility.Kind.package_) >= Visibility(Visibility.Kind.package_));
        expect(
            new Visibility(Visibility.Kind.package_).opCmp(new Visibility(Visibility.Kind.package_)) >= 0,
        ).toBe(true);
    });
});

// §1.6b smoke: importing the module executed its top-level, so the exported bindings exist. This
// also guards the VALUE edge into visitor/index.js that `AddCommentVisitor : Visitor`
// (dsymbol.d:115) requires: if that edge ever dragged an AST-SCC module into dsymbol.js's load
// path, `class AddCommentVisitor extends Visitor` would throw "Class extends value undefined"
// while this module is still evaluating, and every assertion below would fail at import time.
describe("dsymbol module load", () => {
    test("the module's exports are live after load", () => {
        expect(typeof Dsymbol).toBe("function");
        expect(typeof ScopeDsymbol).toBe("function");
        expect(typeof DsymbolTable).toBe("function");
        expect(DSYM.none).toBe(0);
        expect(PASS.initial).toBe(0);
    });

    // The ORDER CONTRACT of dsymbol.ts's `Dsymbol.toChars` registration slot (01 §4.4): this file's
    // static imports enter through dsymbol.js, whose module graph does not contain hdrgen.js, so the
    // slot is still empty here and the call fails loudly instead of falling back. Must run BEFORE
    // the `Dsymbol.toChars` block below loads parse.js. If this goes red, dsymbol.js's graph now
    // reaches hdrgen.js: update the ORDER CONTRACT in dsymbol.ts, not this pin alone.
    test("Dsymbol.toChars fails loudly while hdrgen.js has not registered (entry through dsymbol.js)", () => {
        expect(() => Dsymbol.create(Identifier.idPool(ds("early"))).toChars())
            .toThrow("Dsymbol.toChars: registerDsymbolToChars not called (dmd/hdrgen.d:231)");
    });
});

// dsymbol.d:453 — `Dsymbol.toChars()` is `import dmd.hdrgen : toChars; return toChars(this);`,
// reached through the registration slot hdrgen.ts fills at its module end. The static imports above
// deliberately keep dsymbol.js as this file's entry (the load smoke test guards that entry), so this
// block loads parse.js, the module-graph root of 10 §1.5, dynamically: that evaluates hdrgen.js and
// fills the slot (and hdrgen's own precedence slot) without changing the entry.
describe("Dsymbol.toChars through the hdrgen registration slot (dsymbol.d:453, hdrgen.d:231)", () => {
    beforeAll(async () => {
        await import("./parse.js");
    });

    // hdrgen.d:264 — `return d.ident ? d.ident.toHChars2() : "__anonymous";`, the tail arm for a
    // plain symbol (not a template declaration, instance, mixin or TypeInfo declaration).
    test("a plain symbol prints its identifier, an anonymous one `__anonymous` (hdrgen.d:264)", () => {
        expect(dsToJs(Dsymbol.create(Identifier.idPool(ds("foo"))).toChars())).toBe("foo");
        expect(dsToJs(new ScopeDsymbol().toChars())).toBe("__anonymous");
    });

    // dsymbol.d:1511-1518 — AliasAssign redeclares `ident`; the ctor passes null to the base, so the alias name lives
    // only in the derived slot `identAssign` (02 §11.5b) and the symbol is anonymous (dsymbol.d:501).
    test("an AliasAssign is anonymous, keeps its name in identAssign and through syntaxCopy", () => {
        const id = Identifier.idPool(ds("A"));
        const aa = new AliasAssign(Loc.initial, id, null, null);
        expect(aa.ident).toBeNull();
        expect(aa.isAnonymous()).toBe(true);
        expect(aa.identAssign).toBe(id);
        expect(dsToJs(aa.toChars())).toBe("__anonymous");
        const copy = aa.syntaxCopy(null);
        expect(copy.identAssign).toBe(id);
        expect(copy.ident).toBeNull();
    });

    // dsymbol.d:738 — `buf.writestring(s)` over a `const(char)*` stops at the NUL. A template instance's
    // `toChars()` is an `extractChars()` buffer carrying that NUL, so a symbol inside the instance must
    // still print every qualifier after it (ldc2: "function `p5.t!().t` is not `nothrow`").
    test("toPrettyChars qualifies past a template-instance parent (dsymbol.d:719, :506)", async () => {
        const { TemplateInstance } = await import("./dtemplate.js");
        const { Loc } = await import("./location.js");
        const mod = Dsymbol.create(Identifier.idPool(ds("p5")));
        const ti = new TemplateInstance(Loc.initial, Identifier.idPool(ds("t")), null);
        const f = Dsymbol.create(Identifier.idPool(ds("t")));
        ti.parent = mod;
        f.parent = ti as unknown as Dsymbol; // TemplateInstance.deferred shadows Dsymbol.deferred (dtemplate.ts:937)
        expect(dsToJs(f.toPrettyChars())).toBe("p5.t!().t");
        expect(dsToJs(f.prettyFormatHelper())).toBe("`p5.t!().t`\0");
    });
});

describe("Visibility (dsymbol.d:165)", () => {
    // dsymbol.d:219 — same kind, non-package -> equal regardless of pkg.
    test("opEquals: same non-package kind is equal", () => {
        expect(
            new Visibility(Visibility.Kind.public_).opEquals(new Visibility(Visibility.Kind.public_)),
        ).toBe(true);
    });

    test("opEquals: different kind is not equal", () => {
        expect(
            new Visibility(Visibility.Kind.public_).opEquals(new Visibility(Visibility.Kind.private_)),
        ).toBe(false);
    });

    // dsymbol.d:223 — `package_` compares the Package reference (identity).
    test("opEquals: package_ kind compares the package by identity", () => {
        expect(
            new Visibility(Visibility.Kind.package_, null).opEquals(
                new Visibility(Visibility.Kind.package_, null),
            ),
        ).toBe(true);
    });

    // 03 §6.4 / 09 §1.0: `Visibility v;` default-init takes each field's `.init`; a named enum's
    // `.init` is its FIRST member (`Kind.undefined`), NOT zero-by-accident.
    test("default construction yields Kind.undefined and a null package", () => {
        const v = new Visibility();
        expect(v.kind).toBe(Visibility.Kind.undefined);
        expect(v.pkg).toBe(null);
    });

    // 03 §2: `.copy()` is a fresh object with the same field values (pkg shared).
    test("copy() produces an independent value", () => {
        const a = new Visibility(Visibility.Kind.protected_);
        const b = a.copy();
        expect(b).not.toBe(a);
        expect(b.opEquals(a)).toBe(true);
        b.kind = Visibility.Kind.export_;
        expect(a.kind).toBe(Visibility.Kind.protected_);
    });

    // dsymbol.d:168 — `enum Kind : ubyte { undefined, none, private_, package_, protected_,
    // public_, export_ }`. 02 §4.2: a named member-list enum with a <= 32-bit base is a TS numeric
    // enum, first member 0 and auto-incrementing — pinned so the D declaration order (which `opCmp`
    // turns into the visibility ORDERING) cannot drift.
    test("Kind carries the D member list in D order, starting at 0", () => {
        expect(Visibility.Kind.undefined).toBe(0);
        expect(Visibility.Kind.none).toBe(1);
        expect(Visibility.Kind.private_).toBe(2);
        expect(Visibility.Kind.package_).toBe(3);
        expect(Visibility.Kind.protected_).toBe(4);
        expect(Visibility.Kind.public_).toBe(5);
        expect(Visibility.Kind.export_).toBe(6);
    });
});

describe("SearchOpt flags (dsymbol.d:247)", () => {
    test("the flag values are the declared bits", () => {
        expect(SearchOpt.all).toBe(0x00);
        expect(SearchOpt.ignorePrivateImports).toBe(0x01);
        expect(SearchOpt.ignoreVisibility).toBe(0x80);
    });
});

describe("Dsymbol DSYM-tag downcasts (dsymbol.d:941-1116)", () => {
    test("Dsymbol.create yields DSYM.dsymbol and no narrower identity", () => {
        const s = Dsymbol.create(Identifier.idPool(ds("foo")));
        expect(s.dsym).toBe(DSYM.dsymbol);
        expect(s.isModule()).toBe(null);
        expect(s.isDeclaration()).toBe(null);
        expect(s.isScopeDsymbol()).toBe(null);
        expect(s.isAttribDeclaration()).toBe(null);
    });

    // dsymbol.d:1055 — `scopeDsymbol` IS one of the isScopeDsymbol() arms.
    test("a ScopeDsymbol answers isScopeDsymbol() with itself", () => {
        const sds = new ScopeDsymbol();
        expect(sds.dsym).toBe(DSYM.scopeDsymbol);
        expect(sds.isScopeDsymbol()).toBe(sds);
        expect(sds.isAggregateDeclaration()).toBe(null);
    });

    // dsymbol.d:501 — `ident is null || ident.isAnonymous`.
    test("isAnonymous() is true for a symbol with no ident", () => {
        expect(new ScopeDsymbol().isAnonymous()).toBe(true);
        expect(Dsymbol.create(Identifier.idPool(ds("bar"))).isAnonymous()).toBe(false);
    });
});

describe("Dsymbol comment table (dsymbol.d:109-162, :860-874)", () => {
    test("addComment stores the comment, and comment() reads it back", () => {
        Dsymbol.deinitialize(); // dsymbol.d:928 — reset the __gshared tables
        const s = Dsymbol.create(Identifier.idPool(ds("withDoc")));
        expect(s.comment()).toBe(null);
        s.addComment(ds("hello\0"));
        expect(dsToJs(s.comment()!)).toBe("hello\0");
    });

    // dsymbol.d:128 — `if (!comment || !*comment) return;`: null and the empty C string are no-ops.
    test("a null or NUL-leading comment is a no-op", () => {
        Dsymbol.deinitialize();
        const s = Dsymbol.create(Identifier.idPool(ds("noDoc")));
        s.addComment(null);
        expect(s.comment()).toBe(null);
        s.addComment(ds("\0"));
        expect(s.comment()).toBe(null);
    });

    // dsymbol.d:139 — an IDENTICAL comment does not concatenate (strcmp == 0).
    test("re-adding the same comment leaves the entry unchanged", () => {
        Dsymbol.deinitialize();
        const s = Dsymbol.create(Identifier.idPool(ds("sameDoc")));
        s.addComment(ds("doc\0"));
        s.addComment(ds("doc\0"));
        expect(dsToJs(s.comment()!)).toBe("doc\0");
    });

    // dsymbol.d:139-143 — a DIFFERENT comment concatenates through `Lexer.combineComments`, whose
    // two `const(char)*` operands D converts with `.toDString()` first (the strlen-bounded slice,
    // i.e. `cstr()`): the stored result must not carry an interior NUL from the first comment.
    test("a second, different comment concatenates without an interior NUL", () => {
        Dsymbol.deinitialize();
        const s = Dsymbol.create(Identifier.idPool(ds("twoDocs")));
        s.addComment(ds("first\0"));
        s.addComment(ds("second\0"));
        // `combineComments(c1, c2, newParagraph: true)` joins with the separating '\n' plus the
        // paragraph '\n' (lexer.d:3518). Without the `.toDString()`/`cstr()` conversion D applies to
        // both operands, the first comment's terminator would land INSIDE the result
        // ("first\0\n\nsecond") — something a D `const(char)*` cannot represent.
        expect(dsToJs(s.comment()!)).toBe("first\n\nsecond");
    });

    // dsymbol.d:109-113 — the dispatch is D's own `d.accept(v)` double dispatch into
    // `AddCommentVisitor`; a plain Dsymbol lands on the `visit(Dsymbol)` arm (dsymbol.d:126).
    test("the visitor's Dsymbol arm is the one a plain Dsymbol reaches", () => {
        Dsymbol.deinitialize();
        const s = new ScopeDsymbol(null, Identifier.idPool(ds("scoped")));
        s.addComment(ds("on a ScopeDsymbol\0"));
        expect(dsToJs(s.comment()!)).toBe("on a ScopeDsymbol\0");
    });

    // dsymbol.d:928 — deinitialize() restores the tables to their `.init` (empty).
    test("deinitialize clears the shared table", () => {
        const s = Dsymbol.create(Identifier.idPool(ds("cleared")));
        s.addComment(ds("gone\0"));
        expect(s.comment()).not.toBe(null);
        Dsymbol.deinitialize();
        expect(s.comment()).toBe(null);
    });
});

describe("DsymbolTable (dsymbol.d:1547)", () => {
    test("insert returns the symbol, then null on a duplicate ident", () => {
        const tab = new DsymbolTable();
        const id = Identifier.idPool(ds("x"));
        const a = Dsymbol.create(id);
        const b = Dsymbol.create(id);
        expect(tab.insert(a)).toBe(a);       // dsymbol.d:1584 -> :1597, inserted
        expect(tab.insert(b)).toBe(null);    // dsymbol.d:1601, already in table
        expect(tab.lookup(id)).toBe(a);      // dsymbol.d:1560
        expect(tab.length()).toBe(1);        // dsymbol.d:1611
    });

    test("update replaces an existing entry", () => {
        const tab = new DsymbolTable();
        const id = Identifier.idPool(ds("y"));
        const a = Dsymbol.create(id);
        const b = Dsymbol.create(id);
        tab.insert(a);
        tab.update(b);                       // dsymbol.d:1572
        expect(tab.lookup(id)).toBe(b);
        expect(tab.length()).toBe(1);
    });

    test("lookup of an absent ident is null", () => {
        expect(new DsymbolTable().lookup(Identifier.idPool(ds("absent")))).toBe(null);
    });
});

describe("ScopeDsymbol imported scopes (dsymbol.d:1162, :1196, :1207)", () => {
    // dsymbol.d:1207 — D returns `visibilities[0 .. importedScopes.length]`, a LIVE view onto the
    // buffer. The port keeps the two arrays the same length, so the array IS that slice; a write
    // through the returned value must be visible on the ScopeDsymbol (a `.slice()` copy would not).
    test("getImportVisibilities aliases the ScopeDsymbol's buffer", () => {
        const sds = new ScopeDsymbol();
        expect(sds.getImportVisibilities()).toBe(null);   // no imports yet -> null
        expect(sds.getImportedScopes()).toBe(null);

        const imported = new ScopeDsymbol(null, Identifier.idPool(ds("mod")));
        sds.importScope(imported, new Visibility(Visibility.Kind.private_));

        const vis = sds.getImportVisibilities()!;
        expect(vis.length).toBe(sds.getImportedScopes()!.length);
        expect(vis[0]).toBe(Visibility.Kind.private_);

        vis[0] = Visibility.Kind.public_;
        expect(sds.getImportVisibilities()![0]).toBe(Visibility.Kind.public_);
    });

    // dsymbol.d:1166 — `if (s != this)`: a self-import is dropped, so nothing is recorded.
    test("importing itself records nothing", () => {
        const sds = new ScopeDsymbol();
        sds.importScope(sds, new Visibility(Visibility.Kind.public_));
        expect(sds.getImportedScopes()).toBe(null);
    });

    // dsymbol.d:1174-1180 — re-importing the same scope upgrades the recorded access, never appends.
    test("re-importing the same scope upgrades the visibility in place", () => {
        const sds = new ScopeDsymbol();
        const imported = new ScopeDsymbol(null, Identifier.idPool(ds("m2")));
        sds.importScope(imported, new Visibility(Visibility.Kind.private_));
        sds.importScope(imported, new Visibility(Visibility.Kind.public_));
        expect(sds.getImportedScopes()!.length).toBe(1);
        expect(sds.getImportVisibilities()![0]).toBe(Visibility.Kind.public_);
        // a LOWER visibility does not downgrade it
        sds.importScope(imported, new Visibility(Visibility.Kind.private_));
        expect(sds.getImportVisibilities()![0]).toBe(Visibility.Kind.public_);
    });
});

describe("FieldState (dsymbol.d:268)", () => {
    // 03 §2: value struct, all-primitive fields -> `.copy()` is an independent clone.
    test("copy() is independent of the source", () => {
        const a = new FieldState();
        a.offset = 4;
        a.fieldOffset = 8;
        a.bitOffset = 3;
        a.inFlight = true;
        const b = a.copy();
        expect(b).not.toBe(a);
        expect(b.offset).toBe(4);
        expect(b.inFlight).toBe(true);
        a.offset = 99;
        expect(b.offset).toBe(4);
    });
});
