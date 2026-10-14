// Ported from dmd/denum.d (module dmd.denum) — WHOLE-FILE faithful translation (W2/BatchB).
//
// Define `enum` declarations and `enum` members.
// Specification: https://dlang.org/spec/enum.html
//
// Copyright: Copyright (C) 1999-2026 by The D Language Foundation, All Rights Reserved.
// Authors:   Walter Bright.  License: Boost License 1.0.
//
// ---------------------------------------------------------------------------------------------
// TRANSLATION NOTES (the decisions a reader/reviewer needs, keyed to the guide)
// ---------------------------------------------------------------------------------------------
// * Cross-core types come in with `import type` where only the TYPE is needed, so the ESM load
//   cycle of the 76-module core SCC stays broken (01 §4.2/§4.5). `ScopeDsymbol`, `VarDeclaration`,
//   `TypeEnum`, `ExpInitializer`, `Id`, `Visibility`, `DSYM` and `STC` are VALUE imports because
//   the bodies `extends`/`new`/read them.
// * resolved: `import core.stdc.stdio;` (denum.d:17) — pulled in only for the commented-out
//   `printf` trace at denum.d:72. No live use, so no runtime shim is imported (01 §3.7).
// * resolved: `private extern (D) static struct BitFields { … }` + `mixin(generateBitFields!
//   (BitFields, ubyte))` (denum.d:54-62) — a CTFE string mixin, evaluated AT TRANSLATION TIME
//   (07 §5, common/bitfields.ts). The three members are all `bool`, so the generated accessors are
//   plain boolean reads/writes over one packed `ubyte`. 11 §3.6 licenses DISCARDING the packed
//   word when nothing reads the integer or its `.sizeof`: verified by tree-wide grep on
//   ldc-1.43.0-beta1 — every `bitFields` hit in a `.d` file outside `common/bitfields.d` belongs
//   to ANOTHER class's word, never to `EnumDeclaration`'s: `Scope` at dscope.d:200/:201 (its
//   second word `bitFields2`) and dscope.d:285/:291, `FuncDeclaration` at func.d:609/:614/:615.
//   The remaining hits are the C++ mirror headers (`enum.h:45` is EnumDeclaration's, plus
//   `frontend.h`/`declaration.h`/...), which this port does not serve. So `EnumDeclaration`'s
//   group is flattened to three plain `bool` fields, exactly as `Dsymbol`'s group is in
//   dsymbol.ts. The `BitFields` struct itself is consumed by that resolution and emits nothing.
// * resolved: `version (IN_LLVM) {} else { void* sinit; }` (denum.d:64-67) — IN_LLVM is ON
//   (_config.md §1), so the `else` leg is NOT taken and the back-end field `sinit` is DROPPED.
// * Visitor: each `accept` calls ITS OWN named method (13 §2), never the base's.

import { ScopeDsymbol, Visibility, DSYM } from "./dsymbol.js";
import { VarDeclaration } from "./declaration.js";
import { TypeEnum } from "./mtype.js";
import { ExpInitializer } from "./init.js";
import { Id } from "./id.js";
// STC is a value import: the collapsed EnumMember ctor needs `STC.none` as the default of the
// trailing `stc` parameter (the value D's `Declaration.storage_class` already holds — the field
// is declared `STC storage_class = STC.none;` at declaration.d:67). `astenums.ts` imports no
// core-SCC module, so the edge is cycle-safe.
import { STC } from "./astenums.js";
import { assert } from "../assert.js";
import { ds } from "../dstring.js";

import type { DString } from "../dstring.js";
import type { Identifier } from "./identifier.js";
import type { Loc } from "./location.js";
import type { Type } from "./mtype.js";
import type { Dsymbol } from "./dsymbol.js";
import type { Expression } from "./expression.js";
import type { UserAttributeDeclaration, DeprecatedDeclaration } from "./attrib.js";
import type { Visitor } from "./visitor/index.js";

/***********************************************************
 * AST node for `EnumDeclaration`
 * https://dlang.org/spec/enum.html#EnumDeclaration
 *
 * dmd/denum.d:35 — `extern (C++) final class EnumDeclaration : ScopeDsymbol`
 * (`final` erases, 04 §8: TS has no `final`).
 */
export class EnumDeclaration extends ScopeDsymbol {
    /* The separate, and distinct, cases are:
     *  1. enum { ... }
     *  2. enum : memtype { ... }
     *  3. enum id { ... }
     *  4. enum id : memtype { ... }
     *  5. enum id : memtype;
     *  6. enum id;
     */
    type: Type | null = null;              // the TypeEnum
    memtype: Type | null = null;           // type of the members

    // denum.d:48 — `Visibility visibility;` is a D default-initialized VALUE struct field: every
    // field takes its `.init` (09 §1.0), i.e. `Kind.undefined` + null package. The zero-argument
    // `new Visibility()` is exactly that birth (03 §6.4). The ctor then assigns an explicitly
    // constructed one, and TS runs field initializers right after `super()` — same order as D.
    visibility: Visibility = new Visibility();
    maxval: Expression | null = null;
    minval: Expression | null = null;
    defaultval: Expression | null = null;  // default initializer

    // `bool` fields that are compacted into bit fields in a string mixin (denum.d:53-62).
    // resolved: `mixin(generateBitFields!(BitFields, ubyte))` -> the three generated accessors,
    // flattened to plain fields (see the file header for the 11 §3.6 justification). Declaration
    // order and names are carried verbatim (01 §2).
    isdeprecated = false;
    added = false;
    inuse = false;

    // resolved: `version (IN_LLVM) {} else { void* sinit; }` (denum.d:64-67) -> IN_LLVM ON, so the
    // `else` leg's code-generator field `sinit` is DROPPED (no codegen in this port).

    /**
     * dmd/denum.d:69 — `extern (D) this(Loc loc, Identifier ident, Type memtype)`.
     *
     * Preconditions: none. `ident` is null for an anonymous enum (`enum { … }`) and `memtype` is
     * null for cases 1/3, so both are nullable — the body only stores them (02 §10.1).
     * Postconditions: `type` is a fresh `TypeEnum` pointing back at this declaration, and the
     * hand-rolled RTTI tag is retagged to `DSYM.enumDeclaration` (the `super` call leaves
     * `DSYM.scopeDsymbol`, exactly as in D).
     */
    constructor(loc: Loc, ident: Identifier | null, memtype: Type | null) {
        super(loc, ident);
        //printf("EnumDeclaration() %p %s : %s\n", this, toChars(), memtype.toChars());
        this.type = new TypeEnum(this);
        this.memtype = memtype;
        this.dsym = DSYM.enumDeclaration;
        // Fresh rvalue stored into a struct-typed field: construction, not a copy (03 §1).
        this.visibility = new Visibility(Visibility.Kind.undefined);
    }

    /**
     * dmd/denum.d:79 — `override EnumDeclaration syntaxCopy(Dsymbol s)`.
     *
     * Contract: `s` must be null — this override always ALLOCATES (the `assert(!s)` is D's own
     * statement of that). The comment, member list and endlinnum are then filled in by
     * `ScopeDsymbol.syntaxCopy(ed)`: an EXPLICITLY-qualified (non-virtual) base call on `this`,
     * passing the freshly built node as the destination — `super.syntaxCopy(ed)` is exactly that.
     */
    override syntaxCopy(s: Dsymbol | null): EnumDeclaration {
        assert(s === null);                                   // denum.d:81 — `assert(!s)` (06 §2.7)
        const ed = new EnumDeclaration(this.loc, this.ident,
            this.memtype !== null ? this.memtype.syntaxCopy() : null);
        super.syntaxCopy(ed);                                 // denum.d:83 — `ScopeDsymbol.syntaxCopy(ed)`
        return ed;
    }

    /// dmd/denum.d:87 — `override const(char)* kind() const`.
    override kind(): DString {
        return ds("enum");
    }

    // is Dsymbol deprecated?
    /// dmd/denum.d:93 — reads the resolved bit-field member (see the file header).
    override isDeprecated(): boolean {
        return this.isdeprecated;
    }

    /**
     * dmd/denum.d:98 — `override Visibility visible()` (all attributes erase, 04 §8).
     * Returns BY VALUE in D, so the port copies the value struct (03 §1 #3); the caller must not
     * be able to mutate this declaration's `visibility` through the returned object.
     */
    override visible(): Visibility {
        return this.visibility.copy();
    }

    /****************
     * dmd/denum.d:109 — Determine if enum is a special one.
     * Returns:
     *  `true` if special
     */
    isSpecial(): boolean {
        // `isSpecialEnumIdent(ident) && memtype` — the second operand is a nullable class
        // reference in a boolean context, expanded per 06 §2.7. D's `&&` yields `bool`.
        return isSpecialEnumIdent(this.ident) && this.memtype !== null;
    }

    /// dmd/denum.d:114 — `override void accept(Visitor v) { v.visit(this); }` (13 §2).
    override accept(v: Visitor): void {
        v.visitEnumDeclaration(this);
    }
}

/***********************************************************
 * AST node representing a member of an enum.
 * https://dlang.org/spec/enum.html#EnumMember
 * https://dlang.org/spec/enum.html#AnonymousEnumMember
 *
 * dmd/denum.d:125 — `extern (C++) final class EnumMember : VarDeclaration`.
 */
export class EnumMember extends VarDeclaration {
    /* Can take the following forms:
     *  1. id
     *  2. id = value
     *  3. type id = value
     */
    /**
     * dmd/denum.d:132 — `@property ref value() { return (cast(ExpInitializer)_init).exp; }`.
     *
     * A REF-returning property over the inherited `_init`, so D call sites both READ and ASSIGN
     * `em.value`. `@property` erases to an accessor (04 §9) and the ref-ness to the setter half.
     * The `cast(ExpInitializer)` is D's checked downcast, spelled here with the InitKind-tag
     * `isExpInitializer()` accessor (cheatsheet: `cast(ClassDecl)sym` -> `isXxx()`); D dereferences
     * the result unconditionally, so the `!`s mark exactly the points where D faults on null
     * (02 §10.1). `_init` is an `ExpInitializer` for every EnumMember — the constructor installs
     * one — until a use of a member whose initializer fails its analysis replaces it with an
     * `ErrorInitializer` (`getConstInitializer`, expressionsem.d:19014); D faults there as well, and
     * after that error only the queries walk the node (src/query.ts `memberValue`).
     */
    get value(): Expression | null {
        return this._init!.isExpInitializer()!.exp;
    }
    set value(v: Expression | null) {
        this._init!.isExpInitializer()!.exp = v;
    }

    // A cast() is injected to 'value' after dsymbolSemantic(),
    // but 'origValue' will preserve the original value,
    // or previous value + 1 if none was specified.
    origValue: Expression | null = null;

    origType: Type | null = null;

    ed: EnumDeclaration | null = null;

    /**
     * The TWO D constructors collapsed by ARITY (04 §1A Form A) — they are prefix-related and the
     * longer one literally delegates to the shorter:
     *   denum.d:143 `this(Loc loc, Identifier id, Expression value, Type origType)`
     *   denum.d:151 `this(Loc loc, Identifier id, Expression value, Type memtype, STC stc,
     *                     UserAttributeDeclaration uad, DeprecatedDeclaration dd)`
     *                -> `this(loc, id, value, memtype); storage_class = stc; userAttribDecl = uad;
     *                    depdecl = dd;`
     * The trailing assignments belong to the 7-argument form ALONE, so they are gated on the
     * argument count (`arguments.length`, the same discriminator 03 §6.4 uses for a dual-birth
     * ctor) — the 4-argument form must leave `storage_class`/`userAttribDecl`/`depdecl` at the
     * values `Declaration`/`Dsymbol` already gave them, and must not materialize the lazy
     * `DsymbolAttributes` block.
     * The 4th parameter keeps the PRIMARY ctor's name `origType` (denum.d:143); the secondary
     * spells the same slot `memtype` (denum.d:151) and passes it straight through.
     *
     * Preconditions: none — `id` may be null (an anonymous enum member is interned as `Id.empty`)
     * and `value`/`origType` may be null (form 1: a bare `id`).
     * Postconditions: `_init` is always a fresh `ExpInitializer`, which is what the `value`
     * property reads through.
     */
    constructor(
        loc: Loc,
        id: Identifier | null,
        value: Expression | null,
        origType: Type | null,
        stc: STC = STC.none,
        uad: UserAttributeDeclaration | null = null,
        dd: DeprecatedDeclaration | null = null,
    ) {
        // denum.d:145 — `super(loc, null, id ? id : Id.empty, new ExpInitializer(loc, value));`
        // `id ? id : Id.empty` is a nullable-reference test (06 §2.7). `Id.empty` is declared
        // nullable because the interned singletons are unset until `Id.initialize()` runs; the `!`
        // is the point where D would fault on an uninitialized table (02 §10.1).
        super(loc, null, id !== null ? id : Id.empty!, new ExpInitializer(loc, value));
        this.origValue = value;
        this.origType = origType;
        this.dsym = DSYM.enumMember;
        if (arguments.length > 4) {
            // denum.d:155-157 — the secondary ctor's extra assignments. `userAttribDecl` and
            // `depdecl` are D property SETTERS on Dsymbol (dsymbol.d:487/:473), renamed `_set` in
            // the port (04 §1B), so `userAttribDecl = uad` is spelled `userAttribDecl_set(uad)`.
            this.storage_class = stc;
            this.userAttribDecl_set(uad);
            this.depdecl_set(dd);
        }
    }

    /**
     * dmd/denum.d:160 — `override EnumMember syntaxCopy(Dsymbol s)`.
     *
     * Contract: `s` must be null (this override always allocates). Deep-copies `value`, `origType`,
     * `userAttribDecl` and `depdecl`; `storage_class` is a flag word, carried verbatim.
     * `userAttribDecl`/`depdecl` are the D property GETTERS (dsymbol.d:471/:469) — each is read
     * twice here, exactly as D reads them (test, then use), so no hoisting is introduced.
     */
    override syntaxCopy(s: Dsymbol | null): EnumMember {
        assert(s === null);                                   // denum.d:162 — `assert(!s)` (06 §2.7)
        return new EnumMember(
            this.loc, this.ident,
            this.value !== null ? this.value.syntaxCopy() : null,
            this.origType !== null ? this.origType.syntaxCopy() : null,
            this.storage_class,
            this.userAttribDecl() !== null ? this.userAttribDecl()!.syntaxCopy(s) : null,
            this.depdecl() !== null ? this.depdecl()!.syntaxCopy(s) : null);
    }

    /// dmd/denum.d:172 — `override const(char)* kind() const`.
    override kind(): DString {
        return ds("enum member");
    }

    /// dmd/denum.d:177 — `override void accept(Visitor v) { v.visit(this); }` (13 §2).
    override accept(v: Visitor): void {
        v.visitEnumMember(this);
    }
}

/******************************************
 * dmd/denum.d:193 — Check for special enum names.
 *
 * Special enum names are used by the C++ name mangler to represent
 * C++ types that are not basic D types.
 * Params:
 *      ident = identifier to check for specialness
 * Returns:
 *      `true` if it is special
 *
 * `const Identifier` erases to a nullable class reference (04 §8, 02 §10.1): the body neither
 * dereferences nor null-tests `ident`, it only compares references, and the sole in-tree caller
 * passes the nullable `Dsymbol.ident`.
 */
export function isSpecialEnumIdent(ident: Identifier | null): boolean {
    // `ident == Id.__c_long` on class references: neither `Identifier` nor `RootObject` declares
    // `opEquals` (verified by grep on identifier.d/rootobject.d), so D's `==` falls through to
    // `Object.opEquals`, i.e. reference identity — `===` here (05 §2). Identifiers are interned by
    // `Identifier.idPool`, which is what makes identity the right test.
    return ident === Id.__c_long ||
           ident === Id.__c_ulong ||
           ident === Id.__c_longlong ||
           ident === Id.__c_ulonglong ||
           ident === Id.__c_long_double ||
           ident === Id.__c_wchar_t ||
           ident === Id.__c_complex_float ||
           ident === Id.__c_complex_double ||
           ident === Id.__c_complex_real;
}
