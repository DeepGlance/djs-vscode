// Ported from dmd/aliasthis.d (module dmd.aliasthis) — LDC 1.43.0-beta1 / DMD 2.113.
//
// WHOLE-FILE faithful structural translation (wave W2). aliasthis.d declares exactly ONE top-level
// symbol: `AliasThis` (aliasthis.d:26). There are no `version`/`debug`/`static if` sites, no
// operators, no structs, no unions, no gotos and no `unittest{}` blocks in the D file.
//
// DROPPED IMPORT (01 §3.7): `import core.stdc.stdio;` (aliasthis.d:16) — a C runtime header, not a
// module of the port. Nothing in this file calls printf/fprintf, so the import has no translation.
//
// SHADOW-SPLIT (02 §11.5b registry): `AliasThis.ident` (aliasthis.d:28) redeclares `Dsymbol.ident`
// and the ctor gives the two D slots DIFFERENT runtime values, so the derived slot is the renamed
// field `identAlias`. See the field declaration below.

import { Dsymbol, DSYM } from "./dsymbol.js";
import { ds } from "../dstring.js";
import { assert } from "../assert.js";

import type { DString } from "../dstring.js";
import type { Loc } from "./location.js";
import type { Identifier } from "./identifier.js";
import type { Visitor } from "./visitor/index.js";

/***********************************************************
 * dmd/aliasthis.d:26 — `extern (C++) final class AliasThis : Dsymbol`.
 *
 * `alias ident this;`
 *
 * `final` erases (04 §8); `extern (C++)` erases (04 §8).
 */
export class AliasThis extends Dsymbol {
    /**
     * dmd/aliasthis.d:28 — `Identifier ident;`: the aliased member name.
     *
     * `Dsymbol.ident` (dsymbol.d:375) already declares `Identifier ident`, so this redeclaration is
     * a SECOND storage slot on the object. The ctor (aliasthis.d:34) passes `null` to the base
     * ("it's anonymous (no identifier)") and writes the name into this slot, and D picks the slot by
     * the STATIC type of the reference. Readers through an `AliasThis`-typed reference want this
     * slot: dsymbolsem.d:509, :518, :1857 and the `visit(AliasThis)` body (:2035), expressionsem.d
     * :5560, :12587, :12672, traits.d:1358, hdrgen.d:1071. Readers through a `Dsymbol`-typed
     * reference see the null base slot, which keeps D's behavior: `isAnonymous()` (dsymbol.d:501)
     * is true, so the `addMember` gate (dsymbolsem.d:6238-6239) skips the symbol-table insert, and
     * `toChars()` (hdrgen.d:264) prints `__anonymous`.
     */
    // shadow-split: D redeclares Dsymbol.ident; this is the DERIVED slot (02 §11.5b registry)
    identAlias: Identifier | null = null;

    /// The symbol this `alias this` resolves to
    sym: Dsymbol | null = null; // dmd/aliasthis.d:30 — class ref, `.init` = null (09 §1.0)

    /// Whether this `alias this` is deprecated or not
    isDeprecated_ = false; // dmd/aliasthis.d:32 — `bool`, `.init` = false (09 §1.0)

    /**
     * dmd/aliasthis.d:34 — `extern (D) this(Loc loc, Identifier ident) @safe`.
     *
     * Preconditions: none — `ident` is the aliased member name the parser just read
     * (parse.d:4948/:4964 always supply one), so it is typed non-null per 02 §10.1's
     * "no null-test in the body" reading and matching the AliasAssign ctor (dsymbol.ts).
     * `loc` is passed on verbatim: `Loc` is an ALIAS-SAFE REGISTER member (03 §9.1), and the
     * Dsymbol ctor copies it into its own slot anyway.
     */
    constructor(loc: Loc, ident: Identifier) {
        super(DSYM.aliasThis, loc, null); // it's anonymous (no identifier)
        this.identAlias = ident;
    }

    /**
     * dmd/aliasthis.d:40 — `override AliasThis syntaxCopy(Dsymbol s)`. Covariant return kept.
     *
     * Precondition: `s` is null (the D `assert(!s)`); this override never re-targets an existing
     * symbol. Postcondition: a fresh node carrying the same loc/ident and the same ddoc comment;
     * `sym` and `isDeprecated_` are left at their `.init` (D allocates a fresh object too).
     */
    override syntaxCopy(s: Dsymbol | null): AliasThis {
        assert(s === null); // D `assert(!s)` — nullable-ref truthiness made explicit (06 §2.7)
        const at = new AliasThis(this.loc, this.identAlias!);
        // D `at.addComment(comment)`: bare `comment` is a CALL to the plain method
        // `Dsymbol.comment()` — dsymbol.d:860 is `final const(char)* comment()` with NO `@property`
        // attribute, so the bare spelling is D's optional-parens call syntax, 04 §9's
        // `@property -> get foo()` mapping does NOT apply, and the port keeps the method form.
        // The receiver side `at.addComment(...)` binds the METHOD `Dsymbol.addComment`
        // (dsymbol.d:870), not the module-private free function `addComment(Dsymbol, const(char)*)`
        // (dsymbol.d:109); both write the shared commentHashTable.
        at.addComment(this.comment());
        return at;
    }

    /// dmd/aliasthis.d:48 — `override const(char)* kind() const`. `const(char)*` -> DString (08 §11).
    override kind(): DString {
        return ds("alias this");
    }

    /**
     * dmd/aliasthis.d:53 — `AliasThis isAliasThis()`.
     *
     * NOT an `override`: `Dsymbol` declares no `isAliasThis` in dmd/dsymbol.d (verified by a
     * tree-wide grep of the 1.43-beta1 frontend — the only D declaration is this one), so this is
     * the sole member of the hook. The C++ header mirrors it the same way (aliasthis.h:28).
     */
    isAliasThis(): AliasThis {
        return this;
    }

    /// dmd/aliasthis.d:58 — `override void accept(Visitor v) { v.visit(this); }`. The node dispatches
    /// to ITS OWN named visitor method (13 §2), never the base's.
    override accept(v: Visitor): void {
        v.visitAliasThis(this);
    }

    /// dmd/aliasthis.d:63 — `override bool isDeprecated() const`.
    override isDeprecated(): boolean {
        return this.isDeprecated_;
    }
}
