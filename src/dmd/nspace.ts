// Ported from dmd/nspace.d (module dmd.nspace) — FULL 1:1 structural translation (90 D lines,
// one declaration: `extern (C++) final class Nspace : ScopeDsymbol`, zero unittests).
//
// CYCLE HANDLING (01-conventions.md §4). This module sits in the core SCC. `ScopeDsymbol`/`DSYM`
// are VALUE imports — the base class is needed at runtime for `extends`, and `extends` across the
// cycle is the verified-safe case (01 §4.1/§4.2). Every other cross-core type reference is
// type-only, so it erases from the emitted JS and contributes nothing to the load cycle.
//
// dropped: `import core.stdc.stdio;` (nspace.d:55) — its only consumer in this module is the
//          commented-out `printf` trace inside the constructor (nspace.d:68), which stays a
//          comment here. No live call site, so no `08` stdio shim is pulled in.

import { ScopeDsymbol, DSYM } from "./dsymbol.js";
import { ds } from "../dstring.js";

import type { Dsymbol } from "./dsymbol.js";
import type { Dsymbols } from "./arraytypes.js";
import type { Expression } from "./expression.js";
import type { Identifier } from "./identifier.js";
import type { Loc } from "./location.js";
import type { Visitor } from "./visitor/index.js";
import type { DString } from "../dstring.js";

/**
 * A scoped C++ namespace symbol
 *
 * D supports the following syntax to declare symbol(s) as being part of a
 * C++ namespace:
 * ---
 * extern (C++, "myNamespace") { /+ Symbols +/ }       // String variant
 * extern (C++, SomeNamespace) { /+ Other symbols +/ } // Identifier variant
 * ---
 * The first form is an attribute and only affects mangling, and is implemented
 * in `dmd.attrib`.
 * The second form introduces a named scope and allows symbols to be refered
 * to with or without the namespace name, much like a named template mixin,
 * and is implemented in this module.
 * ---
 * extern (C++, Basket)
 * {
 *     struct StrawBerry;
 *     void swapFood (Strawberry* f1, Strawberry* f2);
 * }
 * void main ()
 * {
 *     Basket.StrawBerry fruit1;
 *     StrawBerry fruit2;
 *     Basket.swapFood(fruit1, fruit2);
 *     swapFood(fruit1, fruit2);
 * }
 * ---
 * Hence the `Nspace` symbol implements the usual `ScopeDsymbol` semantics.
 *
 * Note that it implies `extern(C++)` so it cannot be used as a generic
 * named scope. Additionally, `Nspace` with the same `Identifier` can be
 * defined in different module (as C++ allows a namespace to be spread accross
 * translation units), but symbols in it should be considered
 * part of the same scope. Lastly, not all possible C++ namespace names
 * are valid D identifier.
 *
 * See_Also:    https://github.com/dlang/dmd/pull/10031
 *
 * (dmd/nspace.d:58 — `extern (C++) final class Nspace : ScopeDsymbol`. `extern (C++)` and `final`
 * both ERASE, the inheritance is kept 1:1 — 04-functions.md §8, 02-types.md §2.)
 */
export class Nspace extends ScopeDsymbol {
    /**
     * Namespace identifier resolved during semantic.
     *
     * dmd/nspace.d:63 — `Expression identExp;`. A class reference, so its D `.init` is `null`
     * (09-numerics.md §1.0) and the declared TS type is `Expression | null`: the constructor is
     * routinely handed `null` for the identifier variant that has no resolved expression yet
     * (dmd/parse.d builds `new Nspace(linkLoc, id, null, a)`).
     */
    identExp: Expression | null = null;

    /**
     * dmd/nspace.d:65 — `extern (D) this(Loc loc, Identifier ident, Expression identExp,
     * Dsymbols* members)`. `extern (D)` erases (04 §8).
     *
     * `loc` is D's `Loc` struct passed by value; it is forwarded untouched to the base, whose own
     * constructor performs the field copy. `Loc` is on the ALIAS-SAFE REGISTER (03 §9.1), so the
     * forward needs no `.copy()` and no per-site justification.
     *
     * `ident` is a bare class-typed parameter that this body neither dereferences nor null-tests
     * (02 §10.1): it is only forwarded to `ScopeDsymbol(Loc, Identifier)`, whose parameter is
     * `Identifier | null` — and `syntaxCopy` below feeds it the inherited `Dsymbol.ident`, which
     * is nullable. So the faithful spelling here is `Identifier | null`.
     *
     * `identExp` (`Expression*`-shaped class ref) and `members` (`Dsymbols*`) are stored as SHARED
     * references, never copied — 02 §10 case 1.
     */
    constructor(loc: Loc, ident: Identifier | null, identExp: Expression | null, members: Dsymbols | null) {
        super(loc, ident);
        //printf("Nspace::Nspace(ident = %s)\n", ident.toChars());
        this.dsym = DSYM.nspace; // super(loc, ident) tagged it scopeDsymbol; retag (nspace.d:69)
        this.members = members;
        this.identExp = identExp;
    }

    /**
     * dmd/nspace.d:74 — `override Nspace syntaxCopy(Dsymbol s)`. The parameter is UNUSED in D:
     * this override always allocates its own fresh node rather than filling a caller-supplied one
     * (contrast `ScopeDsymbol.syntaxCopy`, which reuses `s` when non-null).
     *
     * ported: D parameter `s` -> `_s`. Being unused it is TS6133 under `noUnusedParameters`
     * (probed: a bare `s` here errors), so it takes the `_` prefix — the same escape the ported
     * visitors use for their assert-only overloads (src/dmd/visitor/strict.ts:17). This is the
     * only mutation of a D identifier in this file (01 §2).
     *
     * `ScopeDsymbol.syntaxCopy(ns)` is D's explicit non-virtual base call on `this` — `super.…` in
     * TS. It fills the inherited half of `ns` (comment, deep `members` via `arraySyntaxCopy`,
     * `endlinnum`); its return value is discarded in D, so it is discarded here too. The fresh
     * `Nspace` is deliberately built with `members = null` so that the base call is what populates
     * the copied member list.
     */
    override syntaxCopy(_s: Dsymbol | null): Nspace {
        const ns = new Nspace(this.loc, this.ident, this.identExp, null);
        super.syntaxCopy(ns);
        return ns;
    }

    /// dmd/nspace.d:81 — `override const(char)* kind() const` (trailing `const` erases, 04 §8);
    /// the C string literal becomes a `DString` byte buffer (02 §1.3 / 08 §8).
    override kind(): DString {
        return ds("namespace");
    }

    /// dmd/nspace.d:86 — `override void accept(Visitor v) { v.visit(this); }`. D's static overload
    /// selection becomes the node's OWN named visitor method (13-visitor.md §2).
    override accept(v: Visitor): void {
        v.visitNspace(this);
    }
}
