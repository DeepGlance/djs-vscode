// Ported from dmd/dversion.d (module dmd.dversion).
//
// Defines a `Dsymbol` for `version = identifier` and `debug = identifier` statements.
//
// WHOLE FILE (P5.0 wave 16): two top-level D declarations, `DebugSymbol` (:26) and `VersionSymbol`
// (:61), both translated. Cross-core type references use `import type` (01 §4.2); the base class
// `Dsymbol` is a value import (used in `extends`, 01 §4.2). No `version`/`debug`/`static if` sites, no
// unittest blocks.
//
// CONSTRUCTORS (04 §1 Form A): each class has `this(Loc loc, Identifier ident)` and `this(Loc loc)`,
// collapsed by arity into one constructor with an optional trailing `ident`. The two D forms are NOT
// equivalent for `DebugSymbol`: the one-argument form passes `DSYM.aliasDeclaration` (dversion.d:35),
// not `DSYM.debugSymbol` — reproduced verbatim, so the branch keys on `ident === undefined` (an
// explicit `null` is the two-argument form with a null identifier, as in D).

import { Dsymbol } from "./dsymbol.js";
import { DSYM } from "./dsymbol.js";
import { assert } from "../assert.js";
import { ds } from "../dstring.js";
import type { DString } from "../dstring.js";
import type { Identifier } from "./identifier.js";
import type { Loc } from "./location.js";
import type { Visitor } from "./visitor/index.js";

/***********************************************************
 * DebugSymbol's happen for statements like:
 *      debug = identifier;
 *
 * dmd/dversion.d:26 — `extern (C++) final class DebugSymbol : Dsymbol`.
 */
export class DebugSymbol extends Dsymbol {
    /// dversion.d:28 `this(Loc loc, Identifier ident)` / dversion.d:33 `this(Loc loc)` (Form A).
    constructor(loc: Loc, ident?: Identifier | null) {
        if (ident === undefined)
            super(DSYM.aliasDeclaration, loc, null);   // dversion.d:35, verbatim
        else
            super(DSYM.debugSymbol, loc, ident);
    }

    /// dversion.d:38 — `override DebugSymbol syntaxCopy(Dsymbol s)`. Precondition: `s` is null.
    override syntaxCopy(s: Dsymbol | null): DebugSymbol {
        assert(s === null); // D `assert(!s)` — nullable-ref truthiness made explicit (06 §2.7)
        const ds = new DebugSymbol(this.loc, this.ident);
        ds.addComment(this.comment());   // `comment` is D's optional-parens call of `Dsymbol.comment()`
        return ds;
    }

    override kind(): DString {
        return ds("debug");
    }

    override accept(v: Visitor): void {
        v.visitDebugSymbol(this);
    }
}

/***********************************************************
 * VersionSymbol's happen for statements like:
 *      version = identifier;
 *
 * dmd/dversion.d:61 — `extern (C++) final class VersionSymbol : Dsymbol`.
 */
export class VersionSymbol extends Dsymbol {
    /// dversion.d:64 `this(Loc loc, Identifier ident)` / dversion.d:69 `this(Loc loc)` (Form A): both
    /// pass `DSYM.versionSymbol`, so a missing `ident` is the one-argument form's `null`.
    constructor(loc: Loc, ident: Identifier | null = null) {
        super(DSYM.versionSymbol, loc, ident);
    }

    /// dversion.d:74 — `override VersionSymbol syntaxCopy(Dsymbol s)`. Precondition: `s` is null.
    override syntaxCopy(s: Dsymbol | null): VersionSymbol {
        assert(s === null); // D `assert(!s)` — nullable-ref truthiness made explicit (06 §2.7)
        const ds = new VersionSymbol(this.loc, this.ident);
        ds.addComment(this.comment());   // `comment` is D's optional-parens call of `Dsymbol.comment()`
        return ds;
    }

    override kind(): DString {
        return ds("version");
    }

    override accept(v: Visitor): void {
        v.visitVersionSymbol(this);
    }
}
