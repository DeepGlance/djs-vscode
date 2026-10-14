// Ported from dmd/attribsem.d (module dmd.attribsem) — LDC 1.43.0-beta1 / DMD 2.113.
//
// Does semantic analysis for attributes.
//
// The term 'attribute' refers to things that can apply to a larger scope than a single
// declaration. Among them are: alignment (`align(8)`), user defined attributes (`@UDA`),
// function attributes (`@safe`), storage classes (`static`, `__gshared`), mixin declarations
// (`mixin("int x;")`), conditional compilation (`static if`, `static foreach`), linkage
// (`extern(C)`), anonymous structs / unions, protection (`private`, `public`), deprecated
// declarations (`@deprecated`).
//
// FAITHFUL 1:1 OF THE WHOLE MODULE: the two module-level FREE functions `getAttributes`
// (attribsem.d:37) and `foreachUda` (attribsem.d:64) — emitted as free functions, in the TS
// module mirroring their D module (04 §6 anti-pattern: a D free function is NEVER promoted to a
// method on its receiver). D's `a.userAttribDecl.getAttributes()` (attribsem.d:46/:69) and
// `udas.each!(...)` (:72/:78) are UFCS calls; the receiver becomes the first argument
// (`getAttributes(uad)`), except `each`, whose CANONICAL port is an `Array` METHOD (08 §2.6).
//
// No classes, no `version` / `debug` / `static if` / `mixin` / `__traits` sites, no `goto`, no
// `union`, no `struct`, and no `unittest` blocks exist in the D source (verified). The 13 §7
// idiom census also does not arise: `grep -c 'class .*Visitor' dmd/attribsem.d` = 0 AND there is
// no nested-function-plus-trailing-dispatch-switch shape (§7.5) — this module is two plain free
// functions, so no visitor of either idiom is invented here.
//
// ESCALATIONS (11 §1/§2): none.
//
// SWEPT (11 §2.5, end-of-wave wall sweep — 14 §8): TWO records that stood here are CLOSED, and
// neither of their claims survives anywhere in this file.
//
// (s1) `arrayExpressionSemantic` — the record asserted the symbol had no export in expressionsem.ts.
// That claim is FALSE: `src/dmd/expressionsem.ts:2288` EXPORTS
// `arrayExpressionSemantic(exps: (Expression | null)[], sc: Scope, preserveErrors = false): boolean`,
// the faithful port of D's `extern(D) bool arrayExpressionSemantic(Expression[] exps, Scope* sc,
// bool preserveErrors = false)` — dmd/expressionsem.d:1923, the D line that AUTHORISES both calls.
// Both sites (attribsem.d:42 and attribsem.d:70) now carry the real call; the two marker lines and
// their throws are gone, and so is the consequence they had ("`foreachUda` throws for every symbol
// that HAS a `userAttribDecl`").
// The RESTORABLE FORM the old record spelled — `arrayExpressionSemantic(a.atts, sc)`, the CONTAINER
// — was itself WRONG and is deliberately NOT what landed. The ported callee takes a SLICE and WRITES
// BACK through it (`exps[i] = e2`, expressionsem.ts:2298), and the port's `peekSlice` hands back a
// COPY, so passing either the container or `peekSlice(...)` would drop every write-back D relies on
// (at :42 the analysed expressions must be visible in `a.atts` for the push at :48; at :70 in `udas`
// for the `each` iteration at :72). The faithful spelling is therefore `tdata()` — the live backing
// array, 08 §2.1's "`peekSlice(arr)` written through by callee" row. D's own null-tolerance
// (`peekSlice` is `array ? (*array)[] : null`, root/array.d:515) is reproduced at the one site whose
// container is nullable.
//
// (s2) `Array.each` overload ORDER — the owner's fix has LANDED: `src/dmd/root/array.ts:334` now
// declares the INT overload FIRST (its own comment cites attribsem.d:72 as the reproducer), so a
// bare `udas.each(cb)` / `exps.each(cb)` selects D's int form (array.d:784-797) directly. The two
// annotated single-use `.bind` locals that stood in for it are deleted, exactly as that record said
// they would collapse.
//

import { assert } from "../assert.js";
import type { Expressions } from "./arraytypes.js";
import type { UserAttributeDeclaration } from "./attrib.js";
import type { Scope } from "./dscope.js";
import type { Dsymbol } from "./dsymbol.js";
import { TupleExp, type Expression } from "./expression.js"; // value: `new TupleExp` runs at runtime
// D's `import dmd.expressionsem;` (attribsem.d:32), restored by the (s1) sweep. PLAIN VALUE import
// per 01 §4.3: the binding is read only inside function bodies (never at this module's top level),
// and this module declares no class and no top-level `extends`, so it adds no load-order hazard of
// its own. Validated the way 01 §4.1 requires a new cross-core value edge to be validated — by a
// FULL suite run, not by inspecting this file (see the sweep report's before/after).
import { arrayExpressionSemantic } from "./expressionsem.js";
import { Loc } from "./location.js"; // value: `Loc.initial` is read at runtime
import { Array as DArray } from "./root/array.js"; // value: `new Expressions()` / `each` (08 §2.6)
// D's `import dmd.root.array; // for each` (attribsem.d:34) also brings `peekSlice` into scope, but
// neither D `peekSlice` use survives as a call to the ported free function: both feed a callee that
// writes back through the slice, so both are spelled `tdata()` (08 §2.1) — see the (s1) note.

/**
 * dmd/attribsem.d:37 — `Expressions* getAttributes(UserAttributeDeclaration a)`.
 *
 * Returns the UDA expressions attached to `a`, as a fresh (never null) `Expressions` holding at
 * most two `TupleExp`s: the enclosing declaration's attributes first, then `a`'s own.
 *
 * Preconditions: `a` is non-null (D dereferences it unconditionally — 02 §10.1).
 * Postconditions: `a._scope` is null on return; the returned container is NEW, but the pushed
 * `TupleExp`s SHARE `a.atts` and the recursively-produced container (no copy — `Expressions` is a
 * reference container, 02 §8).
 * Side effect: the first call runs `arrayExpressionSemantic` over `a.atts` IN PLACE
 * (expressionsem.ts:2288 — it writes each analysed expression back into the container), and clears
 * `_scope` so the analysis runs at most once.
 * Cost: recursive over the `userAttribDecl` chain; one allocation per level.
 */
export function getAttributes(a: UserAttributeDeclaration): Expressions {
    // `if (auto sc = a._scope)` — declaration in a condition (06 §2.6) over a nullable `Scope*`
    // (06 §2.7). The hoisted `const` is also the 02 §11.4 fresh-read: `a._scope` is written on the
    // next line, so the test must not be re-derived from the field afterwards.
    const sc = a._scope;
    if (sc !== null) {
        a._scope = null;
        // attribsem.d:42 — `arrayExpressionSemantic(a.atts.peekSlice(), sc);`. SWEPT (s1): the
        // callee is live at expressionsem.ts:2288, authorised by dmd/expressionsem.d:1923.
        // `a.atts` is an `Expressions*` and D's UFCS `peekSlice` is the NULL-TOLERANT free function
        // (root/array.d:515 — `array ? (*array)[] : null`), so a null `atts` hands the callee an
        // empty slice and it returns false; the ternary IS that D semantic, not a defensive guard.
        // `tdata()` and NOT `peekSlice(...)`: the callee writes the analysed expression back through
        // the slice, and the port's `peekSlice` returns a COPY (08 §2.1 — `peekSlice(arr)` written
        // through by callee → `arr.tdata()`), so a copy would silently lose every write before the
        // push of `a.atts` at :48. D discards the `bool`; so do we.
        arrayExpressionSemantic(a.attsUda !== null ? a.attsUda.tdata() : [], sc);
    }
    // `new Expressions()` — constructed AS the alias, element type `Expression | null` (08 §3).
    const exps: Expressions = new DArray<Expression | null>();

    // `a.userAttribDecl` is the `Dsymbol` property getter, ported as a method (04 §9, dsymbol.ts:661).
    // D reads it three times (twice at :45, once at :46); the read is pure, so it is hoisted once —
    // which is also what lets TS narrow it.
    const uad = a.userAttribDecl();
    // `a.userAttribDecl && a.userAttribDecl !is a` — a nullable-REFERENCE test (06 §2.7) followed by
    // D reference identity (`!is`), which is `!==` on class refs (05 §2).
    //
    if (uad !== null && uad !== a)
        // `new TupleExp(Loc.initial, exps)` is D's two-argument ctor, ported as the `fromExps`
        // Form-B factory (04 §1.1(c)). `Loc.initial` is SHARED, not copied: `Loc` is an ALIAS-SAFE
        // REGISTER member (03 §9.1). `a.userAttribDecl.getAttributes()` is UFCS on the free
        // function declared right here (04 §6) — the recursion.
        exps.push(TupleExp.fromExps(Loc.initial, getAttributes(uad)));
    // `a.atts && a.atts.length` — a POINTER test on `Expressions*` (06 §2.7/§2.8) followed by a
    // `size_t` numeric-truthiness test (06 §2.5); never collapse the pair into one length test.
    if (a.attsUda !== null && a.attsUda.length !== 0)
        exps.push(TupleExp.fromExps(Loc.initial, a.attsUda));
    return exps;
}

/**
 * dmd/attribsem.d:64 — `int foreachUda(Dsymbol sym, Scope* sc, int delegate(Expression) dg)`.
 *
 * Iterates the UDAs attached to the given symbol.
 *
 * Params:
 *  sym = the symbol to get the UDAs from
 *  sc = scope to use for semantic analysis of UDAs
 *  dg = called once for each UDA
 *
 * Returns:
 *  If `dg` returns `!= 0`, stops the iteration and returns that value.
 *  Otherwise, returns 0.
 *
 * `dg`'s parameter is NON-NULL `Expression` per the 02 §10.1 delegate clause (the union of every
 * D body bound to it decides): the five D call sites — dsymbolsem.d:4564 (`isEnumAttribute(e, …)`),
 * mustuse.d:195 (`isMustUseAttribute(uda)`), objc.d:586 (`e.isStructLiteralExp()`), objc.d:672 and
 * objc.d:890 (`e.isTypeExp()`) — all DEREFERENCE the parameter and none null-tests it, so the
 * forward carries the `!` (marking exactly where D faults). Same typing as attrib.ts's sibling
 * `foreachUdaNoSemantic`. If a later wave ports a body that null-tests, WIDENING THIS TYPE here is
 * the owner-file fix — never a cast at the new caller.
 */
export function foreachUda(sym: Dsymbol, sc: Scope, dg: (e: Expression) => number): number {
    // `if (!sym.userAttribDecl)` — nullable-reference truthiness (06 §2.7) on the getter (04 §9).
    const uad = sym.userAttribDecl();
    if (uad === null)
        return 0;

    // `sym.userAttribDecl.getAttributes()` — UFCS on the free function above (04 §6).
    const udas = getAttributes(uad);

    // attribsem.d:70 — `arrayExpressionSemantic(udas.peekSlice(), sc, true);`. SWEPT (s1): the callee
    // is live at expressionsem.ts:2288, authorised by dmd/expressionsem.d:1923. No null test here,
    // unlike the site in `getAttributes`: `getAttributes` allocates unconditionally (attribsem.d:44)
    // so `udas` is non-null in D and non-nullable in the port. `tdata()` and NOT `peekSlice(...)`
    // for the same reason as there (08 §2.1) — with `preserveErrors = true` the callee writes EVERY
    // analysed expression back, and those are exactly the elements the `each` below iterates, so a
    // copy would make this call inert. D discards the `bool`; so do we.
    arrayExpressionSemantic(udas.tdata(), sc, true);

    // `udas.each!(cb)` — the expansion-safe iteration whose INT form is array.d:784-797 (stop at the
    // first non-zero and return it, else 0; array.d:769-783 is its doc comment, not code). `udas` is
    // an `Expressions*`, so D binds the POINTER overload array.d:799-802 — `array ? each!callable(
    // *array) : 0` — but `getAttributes` never returns null (attribsem.d:44 allocates), so that
    // guard has nothing to test here; the `exps` site below is where it bites. Ported as the `Array`
    // METHOD (08 §2.6, CANONICAL): it must NOT be collapsed to `for…of`, because `each` re-reads
    // `.length` every step. The lambdas are 04 §5 arrows; slots are `Expression | null` (08 §3) and
    // D dereferences them, so `!` marks the D fault site.
    //
    // SWEPT (s2): the bare call is back. root/array.ts:334 now declares the INT overload first, so
    // `each` resolves to `each(cb: (e: T) => number): number` here with no annotation, no `.bind`
    // stand-in and no ` as `.
    return udas.each((uda: Expression | null): number => {
        // `if (!uda.isTupleExp())` — nullable-reference truthiness on the RTTI downcast (06 §2.7).
        if (uda!.isTupleExp() === null)
            return 0;

        const exps = uda!.isTupleExp()!.exps;

        // `exps.each!(cb)` — `TupleExp.exps` is `Expressions*` (expression.d:1296), so D binds the
        // POINTER overload (array.d:799-802): `array ? each!callable(*array) : 0`. A null `exps`
        // makes D RETURN 0; it does not fault. That ternary IS the D statement, so its guard is
        // reproduced here and neither `exps` carries a `!` — a `!` would mark a fault site D does
        // not have (06 §2.7, iterating a possibly-null slice). Not reachable today (every TupleExp
        // in `udas` was built by `getAttributes`, whose two push sites both supply a non-null
        // container), but it is D-visible semantics on a public function, and the element source
        // changes now that `arrayExpressionSemantic` above is live and free to replace elements of
        // `udas`.
        if (exps === null)
            return 0;

        // SWEPT (s2), same as the outer `each`: bare call, int overload selected by root/array.ts:334.
        return exps.each((e: Expression | null): number => {
            // `assert(e)` IS a boolean context: the nullable-reference expansion applies (06 §2.7).
            assert(e !== null);

            // `if (auto result = dg(e))` — declaration in a condition (06 §2.6) plus numeric
            // truthiness on an `int` (06 §2.5 / 09 §9).
            const result = dg(e);
            if (result !== 0)
                return result;

            return 0;
        });
    });
}
