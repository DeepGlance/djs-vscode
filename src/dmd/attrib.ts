// Ported from dmd/attrib.d (module dmd.attrib) — LDC 1.43.0-beta1 / DMD 2.113.
//
// Defines declarations of various attributes. The term 'attribute' refers to things that can apply
// to a larger scope than a single declaration: alignment (`align(8)`), user defined attributes
// (`@UDA`), function attributes (`@safe`), storage classes (`static`, `__gshared`), mixin
// declarations (`mixin("int x;")`), conditional compilation (`static if`, `static foreach`),
// linkage (`extern(C)`), anonymous structs/unions, protection (`private`, `public`), deprecated
// declarations (`@deprecated`).
//
// FAITHFUL 1:1 of the WHOLE module: 16 classes + the three module-level helpers (`isCoreUda`,
// `foreachUdaNoSemantic`, `isEnumAttribute`). No `version` / `debug` / `static if` / `mixin` /
// `__traits` sites and no `unittest` blocks exist in the D source (verified).
//
// CONSTRUCTOR OVERLOAD SETS — the one thing to read before calling into this file (04 §1):
//   * `AttribDeclaration` (:50/:56/:62) and `StorageClassDeclaration` (:120/:127) are Form A —
//     the overloads differ only by which leading params are defaulted, so each collapses to ONE
//     constructor.
//   * `CPPNamespaceDeclaration` (:272/:278/:285), `VisibilityDeclaration` (:324/:338) and
//     `AlignDeclaration` (:396/:406/:413) each contain SAME-ARITY overloads separated only by a
//     parameter TYPE — Form B (04 §1.1(c)). One form keeps the `constructor`; the others are named
//     `static` factories. There is deliberately NO runtime type test in any constructor: D resolved
//     each call site statically, and `null` satisfies the static type of both arms (the documented
//     `null` trap that makes an `instanceof`-discriminated collapse silently wrong).
//
// WALLS (11 §2.5): none.
//
// SHADOW-SPLIT (02 §11.5b): `UserAttributeDeclaration.atts` (attrib.d:706) redeclares the
// module-private base field `Dsymbol.atts`, and both D slots are live; the derived slot is
// `attsUda` here, so the base slot keeps its own property.
//
// AUDITED TS SUPPRESSION (faithful to D, localized): `LinkDeclaration.create` HIDES the base
// `Dsymbol.create(Identifier)` — D statics hide, they do not override (attrib.d:195).
//
// CONSTRUCTOR SIGNATURES THAT DIVERGE FROM D PARAMETER ORDER: `StorageClassDeclaration` — see the
// divergence record on its constructor. No other collapse permutes D's parameter order.
//
// `Dsymbol`/`DSYM`/`Visibility` are value imports (the `extends` base, the RTTI tag enum and a
// value struct); `extends` across the core-SCC load cycle is verified safe (01 §4.1). Cross-core
// types that are only referenced in a type position use `import type` to keep the cycle type-only.

import { Dsymbol, DSYM, Visibility, ForwardingScopeDsymbol, DsymbolTable } from "./dsymbol.js";
import { ds } from "../dstring.js";
import { assert } from "../assert.js";
import { STC, structalign_t } from "./astenums.js";
import { Package } from "./dmodule.js"; // value: `Package.resolve` runs in a factory body — Rule 4.3
import { Array as DArray } from "./root/array.js"; // runtime growable container (08-runtime-lib.md)
import { Id } from "./id.js"; // value: `Id.attribute` is read at runtime in `isCoreUda` — Rule 4.3
import { Loc } from "./location.js"; // value: `Loc.initial` is read in `UserAttributeDeclaration.concat`
// value: `Expression.arraySyntaxCopy` (static) and `new TupleExp` both run at runtime — Rule 4.3.
import { Expression, TupleExp } from "./expression.js";

import type { Identifier } from "./identifier.js";
import type { Visitor } from "./visitor/index.js";
import type { ScopeDsymbol } from "./dsymbol.js";
import type { Scope } from "./dscope.js";
import type { LINK, CPPMANGLE } from "./astenums.js";
import type { Condition, StaticForeach } from "./cond.js";
import type { DString } from "../dstring.js";
import type { Dsymbols, Expressions } from "./arraytypes.js";
import { OutBuffer } from "./common/outbuffer.js"; // value: `VisibilityDeclaration.toPrettyChars`'s buffer
// dmd/attrib.d:34 — `import dmd.hdrgen : visibilityToBuffer;`, a MODULE-LEVEL D import, read only in
// `VisibilityDeclaration.toPrettyChars`. Last (01 §4.8): hdrgen.js reaches back into the core SCC.
// Measured load-safe here: full-suite collect clean, and the attrib/dsymbol/expression/mtype/hdrgen/
// parse entries all load.
import { visibilityToBuffer } from "./hdrgen.js";

/***********************************************************
 * dmd/attrib.d:46 — `extern (C++) abstract class AttribDeclaration : Dsymbol`.
 *
 * Abstract attribute applied to Dsymbol's, used as a common ancestor for storage classes
 * (StorageClassDeclaration), linkage (LinkDeclaration) and others.
 */
export abstract class AttribDeclaration extends Dsymbol {
    /// dmd/attrib.d:48 — `Dsymbols* decl;` Dsymbol's affected by this AttribDeclaration.
    /// `Dsymbols*` is a pointer to a class-like container -> the reference itself (02 §10 case 1).
    decl: Dsymbols | null;

    /**
     * dmd/attrib.d:50/:56/:62 — the three `extern (D) this(...)` ctors, collapsed to ONE
     * (04 §1 Form A). They differ ONLY in which of `loc` / `ident` is left at its default, and the
     * base `Dsymbol(tag, loc, ident)` already maps a null `loc` to `Loc.initial` (dmd/dsymbol.d:404)
     * — exactly what D's `super(DSYM.attribDeclaration)` produces. The mapping:
     *   this(decl)              -> super(null, null,  decl)
     *   this(loc, decl)         -> super(loc,  null,  decl)
     *   this(loc, ident, decl)  -> super(loc,  ident, decl)
     *
     * D declares all three `extern (D) this(...) @safe` with NO visibility attribute, i.e. public;
     * no access modifier is invented here (01 §2). The class is `abstract`, so TS already forbids
     * direct construction — a `protected` would be both unfaithful and redundant.
     *
     * NOTE the D set is NOT a prefix family: the varying parameters (`loc`, `ident`) are LEADING,
     * so 04 §1 Form A's "optional TRAILING params in D-declaration order" cannot be satisfied as
     * written. Resolved by keeping the LONGEST D form verbatim, in D order, with subclasses passing
     * explicit `null`s — D order preserved, nothing optional. (`StorageClassDeclaration` below has
     * the same leading-varying shape and resolves it the other way; its divergence is recorded
     * there.)
     */
    constructor(loc: Loc | null, ident: Identifier | null, decl: Dsymbols | null) {
        super(DSYM.attribDeclaration, loc, ident);
        this.decl = decl;
    }

    /****************************************
     * dmd/attrib.d:74 — `extern (D) static Scope* createNewScope(...)`.
     *
     * Create a new scope if one or more given attributes are different from the sc's. If the
     * returned scope != sc, the caller should pop the scope after it used.
     *
     * Preconditions: `sc` is non-null — the body dereferences it unconditionally (02 §10.1).
     * `visibility` is a by-VALUE `Visibility` struct: the caller copies at the call site
     * (03 §3.1), and the store into `sc2.visibility` copies again (03 §1 #5).
     * Cost: at most one `sc.copy()`, and only when some attribute actually differs.
     */
    static createNewScope(
        sc: Scope,
        stc: STC,
        linkage: LINK,
        cppmangle: CPPMANGLE,
        visibility: Visibility,
        explicitVisibility: boolean,
        aligndecl: AlignDeclaration | null,
        inlining: PragmaDeclaration | null,
    ): Scope {
        let sc2: Scope = sc;
        if (stc !== sc.stc ||                          // STC is a 64-bit flag set -> bigint (02 §4.2)
            linkage !== sc.linkage ||
            cppmangle !== sc.cppmangle ||
            explicitVisibility !== sc.explicitVisibility ||
            !visibility.opEquals(sc.visibility) ||     // `visibility != sc.visibility` — struct opEquals (05 §2)
            aligndecl !== sc.aligndecl ||              // `!is` — class-reference identity
            inlining !== sc.inlining) {
            // create new one for changes
            sc2 = sc.copy();
            sc2.stc = stc;
            sc2.linkage = linkage;
            sc2.cppmangle = cppmangle;
            sc2.visibility = visibility.copy();        // struct store into a field (03 §1 #5)
            sc2.explicitVisibility = explicitVisibility;
            sc2.aligndecl = aligndecl;
            sc2.inlining = inlining;
        }
        return sc2;
    }

    /// dmd/attrib.d:100 — `override const(char)* kind() const`.
    override kind(): DString {
        return ds("attribute");
    }

    /// dmd/attrib.d:105 — `override void accept(Visitor v) { v.visit(this); }` (13 §2).
    override accept(v: Visitor): void {
        v.visitAttribDeclaration(this);
    }
}

/***********************************************************
 * dmd/attrib.d:116 — `extern (C++) class StorageClassDeclaration : AttribDeclaration`.
 *
 * Storage classes applied to Dsymbols, e.g. `const int i;`  ->  `<stc> <decl...>`
 */
export class StorageClassDeclaration extends AttribDeclaration {
    /// dmd/attrib.d:118 — `STC stc;`
    stc: STC;

    /**
     * dmd/attrib.d:120/:127 — two ctors distinguished by ARITY, so Form A (04 §1):
     *   this(STC stc, Dsymbols* decl)           -> super(decl)       (loc stays Loc.initial)
     *   this(Loc loc, STC stc, Dsymbols* decl)  -> super(loc, decl)
     *
     * DIVERGENCE FROM D PARAMETER ORDER — declared, not licensed by a rule. The varying parameter
     * (`loc`) is LEADING in D, so the D set is not a prefix family and 04 §1 Form A's prescribed
     * emit ("one constructor, optional TRAILING params in D-declaration order") cannot be met on
     * both counts at once: making `loc` optional forces it to the tail, which permutes D's order.
     * Two shapes were possible:
     *   (a) `(loc, stc, decl)` — D order, nothing optional, callers pass an explicit `null` loc.
     *       This is what `AttribDeclaration` above does for the same leading-varying shape.
     *   (b) `(stc, decl, loc?)` — optional trailing `loc`, D order permuted.  <-- chosen
     * (b) is kept because it is the shape every existing dependent already calls
     * (parse.ts:1365/:4257/:4472) and the permutation is caught by tsc at any mis-ordered call site
     * (`STC` is a branded bigint, `Loc` a class), so the divergence cannot become a silent bug.
     * It is a STYLE divergence with no semantic content; the file is knowingly inconsistent with
     * `AttribDeclaration` on this point. Flagged to the integrator as a guide gap (04 §1 Form A
     * does not cover leading-varying overload sets); if the guide rules for (a), this ctor and the
     * three parse.ts call sites change together.
     */
    constructor(stc: STC, decl: Dsymbols | null, loc: Loc | null = null) {
        super(loc, null, decl);
        this.stc = stc;
        this.dsym = DSYM.storageClassDeclaration;
    }

    /// dmd/attrib.d:134 — `override StorageClassDeclaration syntaxCopy(Dsymbol s)`.
    override syntaxCopy(s: Dsymbol | null): StorageClassDeclaration {
        assert(s === null);
        return new StorageClassDeclaration(this.stc, Dsymbol.arraySyntaxCopy(this.decl));
    }

    /// dmd/attrib.d:140
    override accept(v: Visitor): void {
        v.visitStorageClassDeclaration(this);
    }
}

/***********************************************************
 * dmd/attrib.d:154 — `extern (C++) final class DeprecatedDeclaration : StorageClassDeclaration`.
 *
 * Deprecation with an additional message applied to Dsymbols, e.g.
 * `deprecated("Superseeded by foo") int bar;`. (Note that `deprecated int bar;` is currently
 * represented as a StorageClassDeclaration with STC.deprecated_.)
 *
 * `deprecated(<msg>) <decl...>`
 */
export class DeprecatedDeclaration extends StorageClassDeclaration {
    /// dmd/attrib.d:156 — deprecation message
    msg: Expression | null = null;
    /// dmd/attrib.d:157 — cached string representation of msg (`const(char)*` -> DString, 02 §11.2)
    /// D's only assignment is `dd.msgstr = se.toStringz().ptr` (dsymbolsem.d:1592).
    msgstr: DString | null = null;

    /// dmd/attrib.d:159 — `this(Expression msg, Dsymbols* decl)`. Note D does NOT retag `dsym`
    /// here: the node keeps `DSYM.storageClassDeclaration` from the base ctor (faithful).
    constructor(msg: Expression | null, decl: Dsymbols | null) {
        super(STC.deprecated_, decl);
        this.msg = msg;
    }

    /// dmd/attrib.d:165 — `msg.syntaxCopy()` dereferences unconditionally, so the `!` marks the
    /// exact point D would fault on a null `msg` (02 §10.1).
    override syntaxCopy(s: Dsymbol | null): DeprecatedDeclaration {
        assert(s === null);
        return new DeprecatedDeclaration(this.msg!.syntaxCopy(), Dsymbol.arraySyntaxCopy(this.decl));
    }

    /// dmd/attrib.d:171
    override accept(v: Visitor): void {
        v.visitDeprecatedDeclaration(this);
    }
}

/***********************************************************
 * dmd/attrib.d:183 — `extern (C++) final class LinkDeclaration : AttribDeclaration`.
 *
 * Linkage attribute applied to Dsymbols, e.g. `extern(C) void foo()`.
 *
 * `extern(<linkage>) <decl...>`
 *
 * D static-method HIDING: `LinkDeclaration.create(Loc, LINK, Dsymbols*)` (attrib.d:195) hides the
 * base `Dsymbol.create(Identifier)` — D allows this, statics hide rather than override. TS reports
 * it twice (TS4114 on the method, TS2417 on the class static side); both are suppressed and
 * audited here, the identifier stays verbatim (01 §2).
 *
 * SUPPRESSION BREADTH — read before adding a member to this class. TS2417 is anchored at the class
 * NAME (verified: `attrib.ts(224,14): error TS2417`), so the only place a directive can sit is the
 * `export class ...` line, and `@ts-expect-error` is LINE-scoped: it excuses every diagnostic TS
 * reports there, not just TS2417. The other errors that anchor at a class header — notably TS2515
 * ("non-abstract class does not implement inherited abstract member") — would therefore be
 * swallowed, and because an UNUSED `@ts-expect-error` is itself an error the directive keeps
 * passing while masking the new one. There is no narrower TS mechanism. Mitigation is manual: if a
 * class-level defect is ever suspected here, delete the directive, run `tsc --noEmit`, read what
 * surfaces, restore. The `static create` directive below is separately and narrowly scoped (TS4114)
 * and carries no such breadth.
 */
// @ts-expect-error D static-method hiding (class static side, TS2417): LinkDeclaration.create hides Dsymbol.create.
export class LinkDeclaration extends AttribDeclaration {
    /// dmd/attrib.d:185 — either explicitly set or `default_`
    linkage: LINK;

    /// dmd/attrib.d:187 — `this(Loc loc, LINK linkage, Dsymbols* decl)`.
    constructor(loc: Loc | null, linkage: LINK, decl: Dsymbols | null) {
        super(loc, null, decl);
        // dropped: `//printf("LinkDeclaration(linkage = %d, decl = %p)\n", linkage, decl);` (attrib.d:190)
        this.linkage = linkage;
        this.dsym = DSYM.linkDeclaration;
    }

    /// dmd/attrib.d:195 — `static LinkDeclaration create(Loc loc, LINK p, Dsymbols* decl)`.
    // @ts-expect-error D static-method hiding: LinkDeclaration.create hides Dsymbol.create.
    static create(loc: Loc | null, p: LINK, decl: Dsymbols | null): LinkDeclaration {
        return new LinkDeclaration(loc, p, decl);
    }

    /// dmd/attrib.d:200
    override syntaxCopy(s: Dsymbol | null): LinkDeclaration {
        assert(s === null);
        return new LinkDeclaration(this.loc, this.linkage, Dsymbol.arraySyntaxCopy(this.decl));
    }

    /// dmd/attrib.d:206
    override accept(v: Visitor): void {
        v.visitLinkDeclaration(this);
    }
}

/***********************************************************
 * dmd/attrib.d:220 — `extern (C++) final class CPPMangleDeclaration : AttribDeclaration`.
 *
 * Attribute declaring whether an external aggregate should be mangled as a struct or class in C++,
 * e.g. `extern(C++, struct) class C { ... }`. This is required for correct name mangling on MSVC
 * targets, see cppmanglewin.d for details.
 *
 * `extern(C++, <cppmangle>) <decl...>`
 */
export class CPPMangleDeclaration extends AttribDeclaration {
    /// dmd/attrib.d:222
    cppmangle: CPPMANGLE;

    /// dmd/attrib.d:224 — `this(Loc loc, CPPMANGLE cppmangle, Dsymbols* decl)`.
    constructor(loc: Loc | null, cppmangle: CPPMANGLE, decl: Dsymbols | null) {
        super(loc, null, decl);
        // dropped: `//printf("CPPMangleDeclaration(cppmangle = %d, decl = %p)\n", ...)` (attrib.d:227)
        this.cppmangle = cppmangle;
        this.dsym = DSYM.cppMangleDeclaration;
    }

    /// dmd/attrib.d:232
    override syntaxCopy(s: Dsymbol | null): CPPMangleDeclaration {
        assert(s === null);
        return new CPPMangleDeclaration(this.loc, this.cppmangle, Dsymbol.arraySyntaxCopy(this.decl));
    }

    /// dmd/attrib.d:238
    override accept(v: Visitor): void {
        v.visitCPPMangleDeclaration(this);
    }
}

/***********************************************************
 * dmd/attrib.d:267 — `extern (C++) final class CPPNamespaceDeclaration : AttribDeclaration`.
 *
 * A node to represent an `extern(C++)` namespace attribute.
 *
 * There are two ways to declarate a symbol as member of a namespace: `Nspace` and
 * `CPPNamespaceDeclaration`. The former creates a scope for the symbol and injects them in the
 * parent scope at the same time. The latter, this class, has no semantic implications and is only
 * used for mangling. Additionally, this class allows one to use reserved identifiers (D keywords)
 * in the namespace.
 *
 * A `CPPNamespaceDeclaration` can be created from an `Identifier` (already resolved) or from an
 * `Expression`, which is CTFE-ed and can be either a `TupleExp` — in which case additional
 * `CPPNamespaceDeclaration` nodes are created — or a `StringExp`.
 *
 * Note that this class, like `Nspace`, matches only one identifier part of a namespace. For the
 * namespace `"foo::bar"`, there will be a `CPPNamespaceDeclaration` with its `ident` set to
 * `"bar"`, and its `namespace` field pointing to another `CPPNamespaceDeclaration` with its
 * `ident` set to `"foo"`.
 */
export class CPPNamespaceDeclaration extends AttribDeclaration {
    /// dmd/attrib.d:270 — CTFE-able expression, resolving to `TupleExp` or `StringExp`
    exp: Expression | null = null;

    /**
     * dmd/attrib.d:278 — `this(Loc loc, Expression exp, Dsymbols* decl)`.
     *
     * The overload set (:272 Identifier, :278 Expression, :285 five-parameter) has TWO same-arity
     * members separated only by a parameter type, so it is Form B (04 §1.1(c)). The EXPRESSION form
     * keeps the `constructor`: it is the form every in-scope D caller selects (parse.d:880,
     * dsymbolsem.d:3767) and the one this port's dependents already call. The other two forms are
     * named static factories below. No runtime type test — D chose statically, and `null` satisfies
     * the static type of both same-arity arms.
     */
    constructor(loc: Loc | null, exp: Expression | null, decl: Dsymbols | null) {
        super(loc, null, decl);
        this.dsym = DSYM.cppNamespaceDeclaration;
        this.exp = exp;
    }

    /**
     * dmd/attrib.d:272 — `this(Loc loc, Identifier ident, Dsymbols* decl)`.
     * Form-B sibling of the constructor. D's `super(loc, ident, decl)` only differs in setting
     * `ident`, a plain `Dsymbol` field, so routing through the Expression ctor (with `exp` null,
     * its D default) and assigning `ident` afterwards is observationally identical.
     */
    static fromIdentifier(
        loc: Loc | null,
        ident: Identifier | null,
        decl: Dsymbols | null,
    ): CPPNamespaceDeclaration {
        const r = new CPPNamespaceDeclaration(loc, null, decl);
        r.ident = ident;
        return r;
    }

    /**
     * dmd/attrib.d:285 — `this(Loc loc, Identifier ident, Expression exp, Dsymbols* decl,
     * CPPNamespaceDeclaration parent)`. Named factory (the arity-5 member of the Form-B set);
     * `this.cppnamespace = parent` (attrib.d:291) is the `Dsymbol` property setter, ported as
     * `cppnamespace_set` (dsymbol.ts).
     */
    static fromIdentifierExpParent(
        loc: Loc | null,
        ident: Identifier | null,
        exp: Expression | null,
        decl: Dsymbols | null,
        parent: CPPNamespaceDeclaration | null,
    ): CPPNamespaceDeclaration {
        const r = new CPPNamespaceDeclaration(loc, exp, decl);
        r.ident = ident;
        r.cppnamespace_set(parent);
        return r;
    }

    /// dmd/attrib.d:294 — selects the five-parameter ctor.
    override syntaxCopy(s: Dsymbol | null): CPPNamespaceDeclaration {
        assert(s === null);
        return CPPNamespaceDeclaration.fromIdentifierExpParent(
            this.loc, this.ident, this.exp, Dsymbol.arraySyntaxCopy(this.decl), this.cppnamespace());
    }

    /// dmd/attrib.d:301
    override accept(v: Visitor): void {
        v.visitCPPNamespaceDeclaration(this);
    }
}

/***********************************************************
 * dmd/attrib.d:313 — `extern (C++) final class VisibilityDeclaration : AttribDeclaration`.
 *
 * Visibility declaration for Dsymbols, e.g. `public int i;`
 *
 * `<visibility> <decl...>` or `package(<pkg_identifiers>) <decl...>` if `pkg_identifiers !is null`.
 */
export class VisibilityDeclaration extends AttribDeclaration {
    /// dmd/attrib.d:315 — the visibility. A value struct with no declared initializer, so its
    /// `.init` is field-wise: `kind` = the FIRST enum member (`undefined`), `pkg` = null (09 §1.0).
    visibility: Visibility = new Visibility();

    /// dmd/attrib.d:316 — `Identifier[] pkg_identifiers;` identifiers for `package(foo.bar)` or
    /// null. A D slice's `.init` is the NULL slice, not an empty one, and the distinction is LIVE:
    /// dsymbolsem.d:6364 tests the pointer (`if (visd.pkg_identifiers)`) and :6369 writes it back
    /// to null. So the field is `Identifier[] | null` initialised to `null` (06 §2.8).
    pkg_identifiers: Identifier[] | null = null;

    /**
     * dmd/attrib.d:324 — `this(Loc loc, Visibility visibility, Dsymbols* decl)`.
     *
     * Params:
     *  loc = source location of attribute token
     *  visibility = visibility attribute data
     *  decl = declarations which are affected by this visibility attribute
     *
     * This is the field/data ctor of a same-arity Form-B pair, so it keeps the `constructor`
     * (04 §1.1(c)); the `Identifier[]` form is `fromPkgIdentifiers` below.
     */
    constructor(loc: Loc | null, visibility: Visibility, decl: Dsymbols | null) {
        super(loc, null, decl);
        this.dsym = DSYM.visibilityDeclaration;
        this.visibility = visibility.copy(); // by-value struct stored into a field (03 §1 #5)
        // dropped: `//printf("decl = %p\n", decl);` (attrib.d:329)
    }

    /**
     * dmd/attrib.d:338 — `this(Loc loc, Identifier[] pkg_identifiers, Dsymbols* decl)`.
     *
     * Params:
     *  loc = source location of attribute token
     *  pkg_identifiers = list of identifiers for a qualified package name
     *  decl = declarations which are affected by this visibility attribute
     *
     * D mutates the DEFAULT-initialised `visibility` field (`this.visibility.kind = package_`) —
     * no `Visibility` ctor runs — which is reproduced by handing the primary ctor a
     * default-constructed `Visibility` and setting `kind` on the stored copy.
     */
    static fromPkgIdentifiers(
        loc: Loc | null,
        pkg_identifiers: Identifier[] | null,
        decl: Dsymbols | null,
    ): VisibilityDeclaration {
        const r = new VisibilityDeclaration(loc, new Visibility(), decl);
        r.visibility.kind = Visibility.Kind.package_;
        r.pkg_identifiers = pkg_identifiers;
        // dmd/attrib.d:344 — `if (pkg_identifiers.length > 0)`. D reads `.length` off a possibly
        // NULL slice, which is 0; the explicit null test reproduces that exactly (06 §2.8) — it is
        // the translation of D's semantics, not a defensive guard. The null case is REACHABLE:
        // syntaxCopy (:357) routes a `package`-kind node built through the Visibility ctor here
        // with `pkg_identifiers` still null.
        if (pkg_identifiers !== null && pkg_identifiers.length > 0) {
            const tmp: { value: Dsymbol | null } = { value: null }; // D `Dsymbol tmp;` + `&tmp` (03 §3.3/§7.2)
            Package.resolve(pkg_identifiers, tmp, null);
            r.visibility.pkg = tmp.value !== null ? tmp.value.isPackage() : null;
        }
        return r;
    }

    /// dmd/attrib.d:352 — the package vs plain form is chosen by `visibility.kind`.
    override syntaxCopy(s: Dsymbol | null): VisibilityDeclaration {
        assert(s === null);

        if (this.visibility.kind === Visibility.Kind.package_)
            return VisibilityDeclaration.fromPkgIdentifiers(
                this.loc, this.pkg_identifiers, Dsymbol.arraySyntaxCopy(this.decl));
        else
            return new VisibilityDeclaration(this.loc, this.visibility, Dsymbol.arraySyntaxCopy(this.decl));
    }

    /// dmd/attrib.d:362
    override kind(): DString {
        return ds("visibility attribute");
    }

    /// dmd/attrib.d:367 — `override const(char)* toPrettyChars(bool)` (the parameter is unnamed in D).
    override toPrettyChars(_QualifyTypes = false): DString {
        // dmd/attrib.d:369 — enum comparison in the `number` domain (Visibility.Kind : ubyte).
        assert(this.visibility.kind > Visibility.Kind.undefined);
        const buf = new OutBuffer(); // dmd/attrib.d:370
        visibilityToBuffer(buf, this.visibility); // dmd/attrib.d:371 — the free function at hdrgen.d:3527
        return buf.extractChars(); // dmd/attrib.d:372
    }

    /// dmd/attrib.d:375
    override accept(v: Visitor): void {
        v.visitVisibilityDeclaration(this);
    }
}

/***********************************************************
 * dmd/attrib.d:387 — `extern (C++) final class AlignDeclaration : AttribDeclaration`.
 *
 * Alignment attribute for aggregates, members and variables.
 *
 * `align(<ealign>) <decl...>` or `align <decl...>` if `ealign` is null.
 */
export class AlignDeclaration extends AttribDeclaration {
    /// dmd/attrib.d:389 — Expression(s) yielding the desired alignment, the largest value wins
    exps: Expressions | null = null;

    /// dmd/attrib.d:393 — the actual alignment is Unknown until it's either set to the value of
    /// `ealign` or the default if `ealign` is null (/ an error ocurred).
    salign: structalign_t = new structalign_t();

    /**
     * dmd/attrib.d:396 — `this(Loc loc, Expression exp, Dsymbols* decl)`.
     *
     * Three same-arity ctors (:396 Expression, :406 `Expressions*`, :413 `structalign_t`) — Form B
     * (04 §1.1(c)). The single-Expression form keeps the `constructor`: it is the form every
     * in-scope D caller selects (parse.d:978/:4563/:4838 — the `structalign_t` form is reached
     * only from the EXCLUDED cparse.d) and the one this port's dependents already call.
     */
    constructor(loc: Loc | null, exp: Expression | null, decl: Dsymbols | null) {
        super(loc, null, decl);
        this.dsym = DSYM.alignDeclaration;
        if (exp !== null) {
            // dmd/attrib.d:402 — `exps = new Expressions(exp)`: the typesafe-variadic ctor building
            // a one-element container (08 §2.9). CONSTRUCTED AS the `Expressions` alias, i.e. with
            // element type `Expression | null` (08 §3 construction rule).
            this.exps = DArray.from<Expression | null>(exp);
        }
    }

    /// dmd/attrib.d:406 — `this(Loc loc, Expressions* exps, Dsymbols* decl)`. Form-B factory: D's
    /// body is the Expression ctor's `super`/`dsym` prologue with a straight `this.exps = exps`,
    /// which is what routing through the constructor with a null `exp` then assigning reproduces.
    static fromExps(loc: Loc | null, exps: Expressions | null, decl: Dsymbols | null): AlignDeclaration {
        const r = new AlignDeclaration(loc, null, decl);
        r.exps = exps;
        return r;
    }

    /// dmd/attrib.d:413 — `this(Loc loc, structalign_t salign, Dsymbols* decl)`. Form-B factory;
    /// `salign` is a by-value struct, so the field store copies (03 §1 #5).
    static fromSalign(loc: Loc | null, salign: structalign_t, decl: Dsymbols | null): AlignDeclaration {
        const r = new AlignDeclaration(loc, null, decl);
        r.salign = salign.copy();
        return r;
    }

    /// dmd/attrib.d:420 — `Expression.arraySyntaxCopy` returns an `Expressions*`, so D selects the
    /// `Expressions*` ctor here.
    override syntaxCopy(s: Dsymbol | null): AlignDeclaration {
        assert(s === null);
        return AlignDeclaration.fromExps(
            this.loc,
            Expression.arraySyntaxCopy(this.exps),
            Dsymbol.arraySyntaxCopy(this.decl));
    }

    /// dmd/attrib.d:428
    override accept(v: Visitor): void {
        v.visitAlignDeclaration(this);
    }
}

/***********************************************************
 * dmd/attrib.d:437 — `extern (C++) final class AnonDeclaration : AttribDeclaration`.
 *
 * An anonymous struct/union (defined by `isunion`).
 */
export class AnonDeclaration extends AttribDeclaration {
    /// dmd/attrib.d:439 — whether it's a union
    isunion: boolean;
    /// dmd/attrib.d:440 — `int sem;` 1 if successful semantic().
    /// Dead in D ITSELF at 1.43.0-beta1: no site in the frontend reads or writes it (tree-wide
    /// grep). Carried because it is part of the class shape — this is not a port gap.
    sem = 0;
    /// dmd/attrib.d:441 — `uint anonoffset;` offset of anonymous struct
    /// written only at dsymbolsem.d:8920 (`placeField`).
    anonoffset = 0;
    /// dmd/attrib.d:442 — `uint anonstructsize;` size of anonymous struct
    /// written only at dsymbolsem.d:8902/:8910.
    anonstructsize = 0;
    /// dmd/attrib.d:443 — `uint anonalignsize;` size of anonymous struct for alignment purposes
    /// written only at dsymbolsem.d:8903/:8911.
    anonalignsize = 0;

    /// dmd/attrib.d:445 — `this(Loc loc, bool isunion, Dsymbols* decl)`.
    constructor(loc: Loc | null, isunion: boolean, decl: Dsymbols | null) {
        super(loc, null, decl);
        this.dsym = DSYM.anonDeclaration;
        this.isunion = isunion;
    }

    /// dmd/attrib.d:452
    override syntaxCopy(s: Dsymbol | null): AnonDeclaration {
        assert(s === null);
        return new AnonDeclaration(this.loc, this.isunion, Dsymbol.arraySyntaxCopy(this.decl));
    }

    /// dmd/attrib.d:458
    override kind(): DString {
        return this.isunion ? ds("anonymous union") : ds("anonymous struct");
    }

    /// dmd/attrib.d:463
    override accept(v: Visitor): void {
        v.visitAnonDeclaration(this);
    }
}

/***********************************************************
 * dmd/attrib.d:475 — `extern (C++) final class PragmaDeclaration : AttribDeclaration`.
 *
 * Pragma applied to Dsymbols, e.g. `pragma(inline, true) void foo`, but not PragmaStatement's like
 * `pragma(msg, "hello");`.
 *
 * `pragma(<ident>, <args>)`
 */
export class PragmaDeclaration extends AttribDeclaration {
    /// dmd/attrib.d:477 — parameters of this pragma
    args: Expressions | null = null;

    /// dmd/attrib.d:479 — `this(Loc loc, Identifier ident, Expressions* args, Dsymbols* decl)`.
    constructor(loc: Loc | null, ident: Identifier | null, args: Expressions | null, decl: Dsymbols | null) {
        super(loc, ident, decl);
        this.dsym = DSYM.pragmaDeclaration;
        this.args = args;
    }

    /// dmd/attrib.d:486
    override syntaxCopy(s: Dsymbol | null): PragmaDeclaration {
        // dropped: `//printf("PragmaDeclaration::syntaxCopy(%s)\n", toChars());` (attrib.d:488)
        assert(s === null);
        return new PragmaDeclaration(
            this.loc, this.ident, Expression.arraySyntaxCopy(this.args), Dsymbol.arraySyntaxCopy(this.decl));
    }

    /// dmd/attrib.d:493
    override kind(): DString {
        return ds("pragma");
    }

    /// dmd/attrib.d:498
    override accept(v: Visitor): void {
        v.visitPragmaDeclaration(this);
    }
}

/***********************************************************
 * dmd/attrib.d:510 — `extern (C++) class ConditionalDeclaration : AttribDeclaration`.
 *
 * A conditional compilation declaration, used for `version` / `debug` and specialized for
 * `static if`.
 *
 * `<condition> { <decl...> } else { <elsedecl> }`
 */
export class ConditionalDeclaration extends AttribDeclaration {
    /// dmd/attrib.d:512 — condition deciding whether decl or elsedecl applies
    condition: Condition;
    /// dmd/attrib.d:513 — array of Dsymbol's for else block
    elsedecl: Dsymbols | null = null;

    /// dmd/attrib.d:515 — `this(Loc loc, Condition condition, Dsymbols* decl, Dsymbols* elsedecl)`.
    constructor(loc: Loc | null, condition: Condition, decl: Dsymbols | null, elsedecl: Dsymbols | null) {
        super(loc, null, decl);
        this.dsym = DSYM.conditionalDeclaration;
        // dropped: `//printf("ConditionalDeclaration::ConditionalDeclaration()\n");` (attrib.d:519)
        this.condition = condition;
        this.elsedecl = elsedecl;
    }

    /// dmd/attrib.d:524
    override syntaxCopy(s: Dsymbol | null): ConditionalDeclaration {
        assert(s === null);
        return new ConditionalDeclaration(
            this.loc, this.condition.syntaxCopy(),
            Dsymbol.arraySyntaxCopy(this.decl), Dsymbol.arraySyntaxCopy(this.elsedecl));
    }

    /// dmd/attrib.d:530
    override accept(v: Visitor): void {
        v.visitConditionalDeclaration(this);
    }
}

/***********************************************************
 * dmd/attrib.d:541 — `extern (C++) final class StaticIfDeclaration : ConditionalDeclaration`.
 *
 * `<scopesym> { static if (<condition>) { <decl> } else { <elsedecl> } }`
 */
export class StaticIfDeclaration extends ConditionalDeclaration {
    /// dmd/attrib.d:543 — enclosing symbol (e.g. module) where symbols will be inserted
    /// written only at dsymbolsem.d:6407.
    scopesym: ScopeDsymbol | null = null;
    /// dmd/attrib.d:544 — true if members have been added to scope
    /// written only at dsymbolsem.d:9213.
    addisdone = false;
    /// dmd/attrib.d:545 — true if a call to `include` is currently active
    /// written only at dsymbolsem.d:9191-9192.
    onStack = false;

    /// dmd/attrib.d:547 — `this(Loc loc, Condition condition, Dsymbols* decl, Dsymbols* elsedecl)`.
    constructor(loc: Loc | null, condition: Condition, decl: Dsymbols | null, elsedecl: Dsymbols | null) {
        super(loc, condition, decl, elsedecl);
        this.dsym = DSYM.staticIfDeclaration;
        // dropped: `//printf("StaticIfDeclaration::StaticIfDeclaration()\n");` (attrib.d:551)
    }

    /// dmd/attrib.d:554
    override syntaxCopy(s: Dsymbol | null): StaticIfDeclaration {
        assert(s === null);
        return new StaticIfDeclaration(
            this.loc, this.condition.syntaxCopy(),
            Dsymbol.arraySyntaxCopy(this.decl), Dsymbol.arraySyntaxCopy(this.elsedecl));
    }

    /// dmd/attrib.d:560
    override kind(): DString {
        return ds("static if");
    }

    /// dmd/attrib.d:565
    override accept(v: Visitor): void {
        v.visitStaticIfDeclaration(this);
    }
}

/***********************************************************
 * dmd/attrib.d:576 — `extern (C++) final class StaticForeachDeclaration : AttribDeclaration`.
 *
 * Static foreach at declaration scope, like:
 *     static foreach (i; [0, 1, 2]){ }
 */
export class StaticForeachDeclaration extends AttribDeclaration {
    /// dmd/attrib.d:578 — contains `static foreach` expansion logic
    sfe: StaticForeach;

    /// dmd/attrib.d:580 — cached enclosing scope (mimics `static if` declaration)
    /// written only at dsymbolsem.d:6414.
    scopesym: ScopeDsymbol | null = null;

    /* `include` can be called multiple times, but a `static foreach` should be expanded at most
     * once. Achieved by caching the result of the first call. We need both `cached` and `cache`,
     * because `null` is a valid value for `cache`.  (attrib.d:582-590)
     *
     * All three are written only inside the `static foreach` expansion — dsymbolsem.d:9237-9238
     * (`onStack`) and dsymbolsem.d:9261-9262 (`cached` / `cache`).
     */
    onStack = false;
    cached = false;
    cache: Dsymbols | null = null;

    /// dmd/attrib.d:592 — `this(StaticForeach sfe, Dsymbols* decl)`; the loc comes from `sfe`.
    constructor(sfe: StaticForeach, decl: Dsymbols | null) {
        super(sfe.loc, null, decl);
        this.dsym = DSYM.staticForeachDeclaration;
        this.sfe = sfe;
    }

    /// dmd/attrib.d:599
    override syntaxCopy(s: Dsymbol | null): StaticForeachDeclaration {
        assert(s === null);
        return new StaticForeachDeclaration(this.sfe.syntaxCopy(), Dsymbol.arraySyntaxCopy(this.decl));
    }

    /// dmd/attrib.d:607
    override kind(): DString {
        return ds("static foreach");
    }

    /// dmd/attrib.d:612
    override accept(v: Visitor): void {
        v.visitStaticForeachDeclaration(this);
    }
}

/***********************************************************
 * dmd/attrib.d:644 — `extern(C++) final class ForwardingAttribDeclaration : AttribDeclaration`.
 *
 * Collection of declarations that stores foreach index variables in a local symbol table. Other
 * symbols declared within are forwarded to another scope, like:
 *
 *      static foreach (i; 0 .. 10) // loop variables for different indices do not conflict.
 *      { // this body is expanded into 10 ForwardingAttribDeclarations, where `i` has storage
 *        // class STC.local
 *          mixin("enum x" ~ to!string(i) ~ " = i"); // ok, can access current loop variable
 *      }
 *
 *      static foreach (i; 0.. 10)
 *      {
 *          pragma(msg, mixin("x" ~ to!string(i))); // ok, all 10 symbols are visible as they were
 *                                                 // forwarded to the global scope
 *      }
 *
 *      static assert(!is(typeof(i))); // loop index variable is not visible outside of the
 *                                     // static foreach loop
 *
 * A StaticForeachDeclaration generates one ForwardingAttribDeclaration for each expansion of its
 * body. The AST of the ForwardingAttribDeclaration contains both the `static foreach` variables
 * and the respective copy of the `static foreach` body. The functionality is achieved by using a
 * ForwardingScopeDsymbol as the parent symbol for the generated declarations.
 */
export class ForwardingAttribDeclaration extends AttribDeclaration {
    /// dmd/attrib.d:646 — `ForwardingScopeDsymbol sym = null;`
    sym: ForwardingScopeDsymbol | null = null;

    /// dmd/attrib.d:648 — `this(Dsymbols* decl)`; selects the base's one-argument ctor form.
    constructor(decl: Dsymbols | null) {
        super(null, null, decl);
        this.dsym = DSYM.forwardingAttribDeclaration;
        this.sym = new ForwardingScopeDsymbol();
        this.sym.symtab = new DsymbolTable();
    }

    /// dmd/attrib.d:656
    override accept(v: Visitor): void {
        v.visitForwardingAttribDeclaration(this);
    }
}

/***********************************************************
 * dmd/attrib.d:668 — `extern (C++) final class MixinDeclaration : AttribDeclaration`.
 *
 * Mixin declarations, like:
 *      mixin("int x");
 * https://dlang.org/spec/module.html#mixin-declaration
 *
 * Note: was CompileDeclaration.
 */
export class MixinDeclaration extends AttribDeclaration {
    /// dmd/attrib.d:670
    exps: Expressions | null = null;
    /// dmd/attrib.d:671
    /// written only at dsymbolsem.d:6430.
    scopesym: ScopeDsymbol | null = null;
    /// dmd/attrib.d:672
    /// written only at dsymbolsem.d:3720 (the mixin-declaration compile step).
    compiled = false;

    /// dmd/attrib.d:674 — `this(Loc loc, Expressions* exps)`; the base gets a null `decl`.
    constructor(loc: Loc | null, exps: Expressions | null) {
        super(loc, null, null);
        // dropped: `//printf("MixinDeclaration(loc = %d)\n", loc.linnum);` (attrib.d:677)
        this.dsym = DSYM.mixinDeclaration;
        this.exps = exps;
    }

    /// dmd/attrib.d:682 — NOTE: unlike its siblings this override has NO `assert(!s)` in D, and the
    /// parameter is unused there too (faithful).
    override syntaxCopy(_s: Dsymbol | null): MixinDeclaration {
        // dropped: `//printf("MixinDeclaration::syntaxCopy('%s')\n", toChars());` (attrib.d:684)
        return new MixinDeclaration(this.loc, Expression.arraySyntaxCopy(this.exps));
    }

    /// dmd/attrib.d:688
    override kind(): DString {
        return ds("mixin");
    }

    /// dmd/attrib.d:693
    override accept(v: Visitor): void {
        v.visitMixinDeclaration(this);
    }
}

/***********************************************************
 * dmd/attrib.d:704 — `extern (C++) final class UserAttributeDeclaration : AttribDeclaration`.
 *
 * User defined attributes look like:
 *      @foo(args, ...)
 *      @(args, ...)
 */
export class UserAttributeDeclaration extends AttribDeclaration {
    // dmd/attrib.d:706 — `Expressions* atts;`.
    // shadow-split: D redeclares Dsymbol.atts; this is the DERIVED slot (02 §11.5b registry). Both D slots are live
    // on this object: the base `DsymbolAttributes*` (dsymbol.d:387) carries userAttribDecl, depdecl and cppnamespace,
    // which SetScopeVisitor writes on every Dsymbol (dsymbolsem.d:8199-8201). One JS property cannot hold both.
    attsUda: Expressions | null = null;

    /// dmd/attrib.d:708 — `this(Expressions* atts, Dsymbols* decl)`; selects the base's
    /// one-argument ctor form.
    constructor(atts: Expressions | null, decl: Dsymbols | null) {
        super(null, null, decl);
        this.dsym = DSYM.userAttributeDeclaration;
        this.attsUda = atts;
    }

    /// dmd/attrib.d:715
    override syntaxCopy(s: Dsymbol | null): UserAttributeDeclaration {
        // dropped: `//printf("UserAttributeDeclaration::syntaxCopy('%s')\n", toChars());` (attrib.d:717)
        assert(s === null);
        return new UserAttributeDeclaration(
            Expression.arraySyntaxCopy(this.attsUda), Dsymbol.arraySyntaxCopy(this.decl));
    }

    /**
     * dmd/attrib.d:722 — `extern (D) static Expressions* concat(Expressions* udas1, Expressions* udas2)`.
     *
     * Combines two UDA tuples. Copy-on-write: when both operands are non-empty a NEW two-element
     * tuple of `TupleExp`s is built; neither operand is appended to. Returns whichever operand is
     * non-empty when the other is null/empty (the reference is SHARED, not copied — matching D).
     */
    static concat(udas1: Expressions | null, udas2: Expressions | null): Expressions | null {
        let udas: Expressions | null;
        // `!udas1` is a POINTER test on `Expressions*` (06 §2.7), NOT a length test.
        if (udas1 === null || udas1.length === 0)
            udas = udas2;
        else if (udas2 === null || udas2.length === 0)
            udas = udas1;
        else {
            /* Create a new tuple that combines them
             * (do not append to left operand, as this is a copy-on-write operation)
             */
            // `new Expressions(2)` — the pre-sized ctor; constructed AS the `Expressions` alias
            // (element type `Expression | null`, 08 §3).
            udas = new DArray<Expression | null>(2);
            // `(*udas)[i] = v` -> `opIndexAssign(v, i)`, value first (05 §7). `new TupleExp(loc,
            // exps)` is the two-argument D ctor, ported as the `TupleExp.fromExps` factory.
            // `Loc.initial` is shared, not copied: `Loc` is an ALIAS-SAFE REGISTER member (03 §9.1).
            udas.opIndexAssign(TupleExp.fromExps(Loc.initial, udas1), 0);
            udas.opIndexAssign(TupleExp.fromExps(Loc.initial, udas2), 1);
        }
        return udas;
    }

    /// dmd/attrib.d:741
    override kind(): DString {
        return ds("UserAttribute");
    }

    /// dmd/attrib.d:746
    override accept(v: Visitor): void {
        v.visitUserAttributeDeclaration(this);
    }
}

/**
 * dmd/attrib.d:763 — `bool isCoreUda(Dsymbol sym, Identifier ident)`.
 *
 * Returns `true` if the given symbol is a symbol declared in `core.attribute` and has the given
 * identifier. This is used to determine if a symbol is a UDA declared in `core.attribute`.
 *
 * Params:
 *  sym = the symbol to check
 *  ident = the name of the expected UDA
 */
export function isCoreUda(sym: Dsymbol, ident: Identifier): boolean {
    // `sym.ident != ident` is Identifier REFERENCE identity — Identifier declares no opEquals and
    // interning makes identity the equality. `!sym.parent` is a nullable-ref test (06 §2.7).
    if (sym.ident !== ident || sym.parent === null)
        return false;

    const _module = sym.parent.isModule();
    // D's `&&` yields `bool` (09 §9), so the nullable-ref half is spelled explicitly. `Id.attribute`
    // is interned by `Id.initialize()`; the `!` marks where D would fault on an uninitialised table.
    return _module !== null && _module.isCoreModule(Id.attribute!);
}

/**
 * dmd/attrib.d:787 — `int foreachUdaNoSemantic(Dsymbol sym, int delegate(Expression) dg)`.
 *
 * Iterates the UDAs attached to the given symbol, without performing semantic analysis. Use this
 * function instead of `foreachUda` if semantic analysis of `sym` is still in progress.
 *
 * Params:
 *  sym = the symbol to get the UDAs from
 *  dg = called once for each UDA
 *
 * Returns:
 *  If `dg` returns `!= 0`, stops the iteration and returns that value. Otherwise, returns 0.
 */
export function foreachUdaNoSemantic(sym: Dsymbol, dg: (e: Expression) => number): number {
    // `sym.userAttribDecl` is the `Dsymbol` property getter, ported as a method (04 §9 / dsymbol.ts).
    const uad = sym.userAttribDecl();
    if (uad === null || uad.attsUda === null)
        return 0;

    // `foreach (exp; *sym.userAttribDecl.atts)` over an `Array` VALUE -> for-of (06 §1.9, 08 §2.0b).
    // The slots are `Expression | null` (08 §3). `dg`'s parameter type is fixed by 02 §10.1's
    // DELEGATE clause — "the UNION of all bodies decides; if ANY body null-tests the parameter, the
    // delegate parameter is `T | null`", enumerated by grepping the delegate's D call sites. D binds
    // exactly two bodies to this `dg` and NEITHER null-tests: dsymbolsem.d:9282 `isGNUABITag(exp)`,
    // whose callee dereferences at dsymbolsem.d:9317 (`e.type ? ... : null`), and mustuse.d:67
    // `isMustUseAttribute(exp)`, whose callee forwards to `isEnumAttribute` -> `e.isTypeExp()`
    // (attrib.d:808). Both bodies dereferencing => the delegate parameter is non-null `Expression`
    // and the forward carries the `!`, marking the point D would fault. (Same rule, opposite
    // outcome, as dsymbol.d's `int`-overload `foreachDsymbol` -> `dg: (s: Dsymbol | null) => number`.)
    // When a later wave ports a body that null-tests, WIDENING THIS TYPE is the owner-file fix here
    // — never a cast at the new caller.
    for (const exp of uad.attsUda) {
        // `if (auto result = dg(exp))` — declaration in a condition (06 §2.6) + numeric
        // truthiness on an `int` (09 §9).
        const result = dg(exp!);
        if (result !== 0)
            return result;
    }

    return 0;
}

/**
 * dmd/attrib.d:804 — `bool isEnumAttribute(Expression e, Identifier id)`.
 *
 * Returns: true if the given expression is an enum from `core.attribute` named `id`.
 *
 * The D body's function-local `import dmd.attrib : isCoreUda;` / `import dmd.id : Id;`
 * (attrib.d:806-807) are module-level imports here (01 §3).
 */
export function isEnumAttribute(e: Expression, id: Identifier): boolean {
    // Logic based on dmd.objc.Supported.declaredAsOptionalCount
    const typeExp = e.isTypeExp();
    if (typeExp === null)
        return false;

    // `typeExp.type` is dereferenced unconditionally by D here (02 §10.1).
    const typeEnum = typeExp.type!.isTypeEnum();
    if (typeEnum === null)
        return false;

    // `typeEnum.sym` likewise — a `TypeEnum` in a valid AST always carries its declaration.
    if (isCoreUda(typeEnum.sym!, id))
        return true;

    return false;
}
