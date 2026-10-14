// Port of dmd/rootobject.d — the base class of nearly every AST class plus the DYNCAST
// hand-rolled RTTI tag. Contract: docs/porting/08-runtime-lib.md §1.
//
// RootObject is the root of the AST hierarchy (Expression, Dsymbol, Type, Identifier, …).
// DYNCAST is DMD's hand-rolled RTTI tag used in lieu of `cast(X)` in the extern(C++)
// subset (rootobject.d:54): frontend call sites compare `x.dyncast() == DYNCAST.expression`
// instead of using `instanceof`. The tag also participates in extern(C++) interop tables,
// so it MUST stay a method returning the tag — do NOT replace dyncast() with instanceof.

import { cstr } from "../dstring.js";
import type { DString } from "../dstring.js";
import { assertUnreachable } from "../assert.js";

/**
 * Hand-rolled RTTI discriminator (dmd/rootobject.d:17-30).
 *
 * Numeric enum: members are 0..10 in declaration order, matching D's `enum DYNCAST : int`.
 * The integer values are observable — frontend code compares against named members, and the
 * tags index extern(C++) interop tables — so the ORDER is contract. Do not reorder or insert.
 */
export enum DYNCAST {
    object,             // 0 — RootObject base
    expression,         // 1
    dsymbol,            // 2
    type,               // 3
    identifier,         // 4
    tuple,              // 5
    parameter,          // 6
    statement,          // 7
    condition,          // 8
    templateparameter,  // 9
    initializer,        // 10
}

/**
 * Base class of the AST hierarchy (dmd/rootobject.d:35-58).
 *
 * Every concrete AST class extends RootObject (directly or transitively) and overrides
 * `toChars()`; many also override `dyncast()`. The base `toChars()` is unreachable — it
 * marks "must be overridden" — and `toString()` is a thin wrapper that virtual-dispatches
 * to the subclass `toChars()`.
 *
 * Lifetime/ownership: AST nodes are GC-managed references (no value semantics). The D
 * `this() nothrow pure @nogc @safe scope {}` default constructor carries no behavior and is
 * dropped (the implicit TS constructor suffices).
 */
export class RootObject {
    /**
     * Render this object to a NUL-terminated C-string, conceptually; in djs it returns a
     * DString (byte array, 08 §11) — a DString carries its own length and has no embedded NUL.
     *
     * Contract: ABSTRACT. The base implementation is unreachable (D `assert(0)`,
     * rootobject.d:43); every concrete subclass overrides it. Calling it on a bare
     * RootObject throws (DError via `assertUnreachable`, 08 §12) — it never returns. Returning
     * `never` lets TS flow-analysis treat code after a base-class call as dead, mirroring
     * D's `assert(0)` no-return semantics.
     */
    toChars(): DString {
        return assertUnreachable("RootObject.toChars: abstract — every concrete AST class must override"); // assert(0)
    }

    /**
     * Render to a DString (D's `extern(D) const(char)[] toString()`, rootobject.d:47-52).
     *
     * D calls the virtual `toChars()` and slices it at `strlen`. The port's `toChars()` is not
     * always NUL-free: the Type, Expression and template printers return an `extractChars`
     * buffer that keeps its terminator (08 §13a.2), so `cstr` performs the same strlen slice.
     * Virtual dispatch is preserved: `toString()` on a subclass yields that subclass's
     * `toChars()` bytes up to the first NUL, as a view (no copy).
     */
    toString(): DString {
        return cstr(this.toChars()); // rootobject.d:50-51 `p[0 .. strlen(p)]`
    }

    /**
     * The hand-rolled RTTI tag (dmd/rootobject.d:54-57). Base returns DYNCAST.object;
     * subclasses override to their own tag. Frontend call sites compare the returned tag
     * against a DYNCAST member — keep them as-is; do NOT substitute `instanceof`.
     */
    dyncast(): DYNCAST {
        return DYNCAST.object;
    }
}
