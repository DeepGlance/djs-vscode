// Ported from dmd/enumsem.d (module dmd.enumsem) — WHOLE-FILE faithful translation (W3/S2).
//
// Does the semantic passes on enums.
//
// ---------------------------------------------------------------------------------------------
// TRANSLATION NOTES (the decisions a reader/reviewer needs, keyed to the guide)
// ---------------------------------------------------------------------------------------------
// * IDIOM CHECK (13 §7, mandatory precondition): `grep -c 'class .*Visitor' dmd/enumsem.d` -> 0.
//   enumsem is an **Idiom B** module — free functions whose bodies declare nested helper
//   functions (`handleErrors`, `errorReturn`). It has NO node-tag dispatch `switch` at all (the
//   trailing-switch half of §7.5 has nothing to emit here), and NO visitor class is invented.
//   The nested functions become inner `const` arrows (04 §5), declared before first use.
// * D free functions are emitted AS FREE FUNCTIONS in the TS module mirroring their D module
//   (04 §6 anti-pattern): `enumSemantic`, `getDefaultValue`, `getMemtype`, `enumMemberSemantic`.
//   Every D `x.foo(y)` whose `foo` is a free function of another module is unwound to `foo(x, y)`.
// * UFCS resolution (04 §6/§6.1), decided per call site by the receiver's type + this module's
//   imports — never by repo-wide grep:
//     - `ed.memtype.typeSemantic(...)`   -> typesem.d free fn  -> `typeSemantic(t, loc, sc)`
//     - `te.toDsymbol(sc)`               -> typesem.d free fn  -> `toDsymbol(te, sc)`
//     - `ed.memtype.defaultInit(loc, …)` -> typesem.d free fn  -> `defaultInit(t, loc, …)`
//     - `t.isScalar()` / `t.isFloating()`/ `t.toHeadMutable()` / `t.addMod(m)` -> typesem.d free fns
//     - `sym.dsymbolSemantic(sc)`        -> dsymbolsem.d free fn
//     - `e.expressionSemantic(sc)` / `e.toInteger()` -> expressionsem.d free fns
//     - `e.implicitCastTo(...)` / `e.castTo(...)`     -> dcast.d free fns
//     - `inferType(e, t)` (enumsem.d:414) is already the FREE form; the first parameter is an
//       `Expression`, so it is `dcast.d:3213`'s `inferType`, NOT `initsem.d`'s `Initializer`
//       overload (04 §6.1 first-parameter-type rule).
//     - `.equals(...)` at enumsem.d:568 is a METHOD: the receiver is a `Type` and `Type.equals`
//       is declared at dmd/mtype.d:552 — so the dsymbolsem/expressionsem `equals` families named
//       in the manifest's §9 hazard row do NOT apply here (04 §6 detection rule).
//     - `ed.members.foreachDsymbol(dg)` -> dsymbol.d free fn. The D overload SET is split by the
//       delegate's return type: four sites bind a `void` delegate (enumsem.d:175/:222/:237/:435 —
//       the last one's bare `return;` statements are void returns) -> `foreachDsymbolVoid`; the
//       fifth (enumsem.d:532) returns `1`/`0` -> the `int` overload `foreachDsymbol` (04 §1B).
// * resolved: `version (none) { … }` at dmd/enumsem.d:200-207 — always false, so the block (the
//   @@@DEPRECATED_2.110@@@ `scope`-as-type-constraint deprecation) is DROPPED (07 §1.4). It is the
//   only use of `deprecation()` in this file, so `dmd.errors : deprecation` is not imported.
// * `import dmd.importc` (dmd/enumsem.d:49) is a value import of `cEnumSemantic`, its single call site being
//   the `sc.inCfile` branch at dmd/enumsem.d:235; placed last (01 §4.8).
// * dropped: `import core.stdc.stdio;` / `import core.stdc.string;` (dmd/enumsem.d:14-15) — pulled
//   in only for the commented-out `printf` traces (01 §3.7); no runtime shim is needed.
// * `Loc` is an ALIAS-SAFE REGISTER member (03 §9.1): it is shared, never `.copy()`-ed, with no
//   per-site comment. `Visibility` is NOT in the register, so its two copy points here
//   (enumsem.d:114 `ed.visibility = sc.visibility`, enumsem.d:376 the ternary's field-read arm)
//   emit `.copy()` (03 §1 #5/#6).
// * `ctfeInterpret` (dmd/dinterpret.d:67) is a value import placed LAST (01 §4.8); its 15 call
//   sites stand at the D statements' positions.
// * SWEPT WALLS (14 §8 end-of-wave sweep) — six callees this file walled have landed, so the walls
//   are gone and the faithful calls stand at the D statements' positions, each carrying the D line
//   that AUTHORISES the now-live callee (11 §2.5): `checkMustUseReserved` (dmd/mustuse.d:58 ->
//   mustuse.ts:143), `deferDsymbolSemantic` (dmd/dsymbolsem.d:1958 -> dsymbolsem.ts:2349),
//   `addEnumMembersToSymtab` (dmd/dsymbolsem.d:6537 -> dsymbolsem.ts:7190), `setScope`
//   (dmd/dsymbolsem.d:8176 -> dsymbolsem.ts:8918), `semanticTypeInfo` (dmd/expressionsem.d:18781 —
//   the wall's :18763 cite was 1.42-stale -> expressionsem.ts:21089), and the `Expression` overload
//   of `lowerStaticAAs` (dmd/semantic2.d:996 -> semantic2.ts:1225 `lowerStaticAAsExpression`).
// * GAG PAIRING (11 §2.5, last bullet): `global.gag` is a process-global counter, and the
//   walls still reachable inside the regions (`ctfeInterpret`'s own callees, e.g. dinterpret's
//   isBuiltin wall) are exit paths D does not have. The protection stays regardless of how
//   many walls remain — 11 §2.5 requires the shape for the shape, not for today's control flow, and
//   every one of the six swept callees can acquire a wall of its own later. Every
//   `startGagging`/`endGagging` region is wrapped in
//   `try { … } catch (ex) { global.endGagging(errors); throw ex; }` — the same shape typesem.ts
//   `trySemantic` uses — so a throw out of the region cannot leak the gag and silently suppress
//   every later diagnostic in the process. Each TS guard spans EXACTLY the D region
//   (enumsem.d:508-511, :564-584, :606-612), first statement to `endGagging` — a guard that opens
//   late leaves the statements before it able to throw out of an incremented gag, which is the
//   confirmed bug class 11 §2.5 names.

import { PASS, DsymbolTable, Visibility, foreachDsymbol, foreachDsymbolVoid } from "./dsymbol.js";
import { Type } from "./mtype.js";
import { STC, LINK, Tvoid, Terror } from "./astenums.js";
import { error } from "./errors.js";
import { global } from "./globals.js";
import { ErrorExp, IntegerExp, AddExp, EqualExp, DotIdExp, TypeExp } from "./expression.js";
import { Id } from "./id.js";
import { EXP } from "./tokens.js";
import { DYNCAST } from "./rootobject.js";
import { typeSemantic, toDsymbol, defaultInit, addMod, isScalar, isFloating, toHeadMutable } from "./typesem.js";
import { implicitCastTo, castTo, inferType } from "./dcast.js";
import { dsymbolSemantic, deferDsymbolSemantic, addEnumMembersToSymtab, setScope } from "./dsymbolsem.js";
import { expressionSemantic, resolveProperties, toInteger, semanticTypeInfo } from "./expressionsem.js";
import { checkGNUABITag } from "./dsymbolsem.js";
import { assert } from "../assert.js";
import { ds } from "../dstring.js";
// last (01 §4.8): two NEW value edges into the core SCC, added by the wave sweep of the walls that
// stood over them. Entering the SCC through `mustuse` or `semantic2` from the FIRST import position
// would make this module the entry point of `attrib -> attribsem -> typesem` / `semantic2 -> ...`;
// last position leaves the existing entry (`dsymbol.js`) untouched, and the module-surface smoke
// test in enumsem.test.ts is what catches a regression here.
import { checkMustUseReserved } from "./mustuse.js";
import { lowerStaticAAsExpression } from "./semantic2.js";
// last (01 §4.8), same reason: dinterpret value-imports dsymbolsem/funcsem/initsem/semantic2.
import { ctfeInterpret } from "./dinterpret.js";
// last (01 §4.8), same reason: importc.ts value-imports typesem, dcast, dsymbolsem and expressionsem.
import { cEnumSemantic } from "./importc.js";

import type { TY } from "./astenums.js";
import type { EnumDeclaration, EnumMember } from "./denum.js";
import type { Scope } from "./dscope.js";
import type { Loc } from "./location.js";
import type { Expression } from "./expression.js";

/**
 * Single-slot box (03 §7.2), file-local exactly as typesem.ts:147 / clone.ts:108 declare theirs.
 * Used here for ONE thing: D's `emprev` local (dmd/enumsem.d:531), which is written from inside a
 * `foreachDsymbol` callback — see the note at that site.
 */
interface Ref<T> {
    value: T;
}

/*********************************
 * dmd/enumsem.d:86 — `void enumSemantic(Scope* sc, EnumDeclaration ed)`.
 * Perform semantic analysis on enum declaration `ed`.
 *
 * Preconditions: `ed` is non-null. `sc` MAY be null — the body null-tests it at enumsem.d:108
 * after possibly replacing it with `ed._scope`, so the parameter is `Scope | null` (02 §10.1).
 * Postconditions: on the complete path `ed.semanticRun` is `PASS.semantic2done`; on each early
 * return it is left at the state D leaves it (`semanticdone`, `initial`, or untouched).
 * Cost: runs `typeSemantic` on the enum type and on the base type, then pass-1 semantic on every
 * member — not cheap, and re-entrant through `deferDsymbolSemantic` on a forward-referenced base.
 */
export function enumSemantic(sc: Scope | null, ed: EnumDeclaration): void {
    //printf("EnumDeclaration::semantic(sd = %p, '%s') %s\n", sc.scopesym, sc.scopesym.toChars(), ed.toChars());
    //printf("EnumDeclaration::semantic() %p %s\n", ed, ed.toChars());
    if (ed.semanticRun >= PASS.semanticdone)
        return; // semantic() already completed
    if (ed.semanticRun === PASS.semantic) {
        assert(ed.memtype !== null);                    // enumsem.d:94 — `assert(ed.memtype)` (06 §2.7)
        // No `!` on `ed.memtype` below: the `assert` above IS the fault site D has (enumsem.d:94),
        // and `assert` is declared `asserts cond` (assert.ts:95), so it narrows. A `!` here would
        // claim a second D fault site that does not exist (08 §3 / 02 §10.1).
        error(ed.loc, ds("circular reference to enum base type `%s`"), ed.memtype.toChars());
        ed.errors = true;
        ed.semanticRun = PASS.semanticdone;
        return;
    }
    let scx: Scope | null = null;
    if (ed._scope !== null) {
        sc = ed._scope;
        scx = ed._scope; // save so we don't make redundant copies
        ed._scope = null;
    }

    if (sc === null)
        return;

    ed.parent = sc.parent;
    ed.type = typeSemantic(ed.type!, ed.loc, sc);

    // enumsem.d:114 — `ed.visibility = sc.visibility;` stores a VALUE struct into a class field
    // (03 §1 #5). `Visibility` is not an alias-safe-register type, so the copy is emitted.
    ed.visibility = sc.visibility.copy();
    if ((sc.stc & STC.deprecated_) !== 0n)              // STC is a branded bigint flag enum (02 §4.2)
        ed.isdeprecated = true;
    // `userAttribDecl` / `cppnamespace` are D property SETTERS on Dsymbol (dsymbol.d:487/:480),
    // spelled `_set` in the port (04 §1B / §9).
    ed.userAttribDecl_set(sc.userAttribDecl);
    ed.cppnamespace_set(sc.namespace);

    ed.semanticRun = PASS.semantic;
    // `checkGNUABITag` is D-homed at dmd/dsymbolsem.d:9277 and imported from there.
    checkGNUABITag(ed, sc.linkage);
    // enumsem.d:122 — `checkMustUseReserved(ed);`; callee live at dmd/mustuse.d:58
    // (`void checkMustUseReserved(Dsymbol sym)`), exported by mustuse.ts:143.
    checkMustUseReserved(ed);

    if (ed.members === null && ed.memtype === null) {   // enum ident;
        ed.semanticRun = PASS.semanticdone;
        return;
    }

    if (ed.symtab === null)
        ed.symtab = new DsymbolTable();

    /* The separate, and distinct, cases are:
     *  1. enum { ... }
     *  2. enum : memtype { ... }
     *  3. enum ident { ... }
     *  4. enum ident : memtype { ... }
     *  5. enum ident : memtype;
     *  6. enum ident;
     */

    if (ed.memtype !== null) {
        ed.memtype = typeSemantic(ed.memtype, ed.loc, sc);

        /* Check to see if memtype is forward referenced
         */
        // enumsem.d:148 — `if (auto te = ed.memtype.isTypeEnum())`: declaration in a condition,
        // hoisted to a const and null-tested (06 §2.6/§2.7). No `!` on `ed.memtype` anywhere in
        // this block: the assignment above returns a non-null `Type`, so every read here is
        // already narrowed — a `!` would advertise a D fault site that does not exist (08 §3).
        const te = ed.memtype.isTypeEnum();
        if (te !== null) {
            // D dereferences the `toDsymbol` result unconditionally; the `!` marks exactly the
            // site D faults on null (02 §10.1). Same for `sym` at enumsem.d:153.
            const sym = toDsymbol(te, sc)!.isEnumDeclaration();
            // Special enums like __c_[u]long[long] are fine to forward reference
            // see https://issues.dlang.org/show_bug.cgi?id=20599
            if (!sym!.isSpecial() &&
                (sym!.memtype === null || sym!.members === null || sym!.symtab === null || sym!._scope !== null)) {
                // memtype is forward referenced, so try again later
                // enumsem.d:156 — `deferDsymbolSemantic(sc, ed, scx);`; callee live at
                // dmd/dsymbolsem.d:1958 (`void deferDsymbolSemantic(Scope* sc, Dsymbol s, Scope* scx)`),
                // exported by dsymbolsem.ts:2349.
                deferDsymbolSemantic(sc, ed, scx);
                //printf("\tdeferring %s\n", toChars());
                ed.semanticRun = PASS.initial;
                return;
            }
            // Ensure that semantic is run to detect. e.g. invalid forward references
            dsymbolSemantic(sym!, sc);
            if (ed.errors)
                ed.memtype = Type.terror; // avoid infinite recursion in toBaseType
        }
        if (ed.memtype.ty === Tvoid) {
            error(ed.loc, ds("%s `%s` base type must not be `void`"), ed.kind(), ed.toPrettyChars());
            ed.memtype = Type.terror;
        }
        if (ed.memtype.ty === Terror) {
            ed.errors = true;
            // poison all the members
            foreachDsymbolVoid(ed.members, (s) => { s.errors = true; });
            ed.semanticRun = PASS.semanticdone;
            return;
        }
        // probe: Type.dtypeinfo is declared non-null but unset until dclass.ts fills it; D tests
        // `if (Type.dtypeinfo)` (02 §11.4 uninitialized-static probe).
        if (global.params.useTypeInfo && (Type as { dtypeinfo?: unknown }).dtypeinfo && !ed.inNonRoot()) {
            // enumsem.d:180 — `semanticTypeInfo(sc, ed.memtype);`; callee live at
            // dmd/expressionsem.d:18781 (`void semanticTypeInfo(Scope* sc, Type t)`), exported by
            // expressionsem.ts:21089. RE-ANCHORED: the wall cited :18763, which lands inside an
            // unrelated body in the 1.43.0 tree — the declaration is :18781 (14 §3 item-5 D-cite
            // verification). The D body null-tests both parameters (`if (sc)` :18783,
            // `if (!t) return;` :18791), which is exactly the port's nullable signature, so no `!`
            // is owed at this site (02 §10.1).
            semanticTypeInfo(sc, ed.memtype);
        }
    }

    if (ed.members === null) {                          // enum ident : memtype;
        ed.semanticRun = PASS.semanticdone;
        return;
    }

    if (ed.members.length === 0) {
        error(ed.loc, ds("%s `%s` enum `%s` must have at least one member"),
            ed.kind(), ed.toPrettyChars(), ed.toChars());
        ed.errors = true;
        ed.semanticRun = PASS.semanticdone;
        return;
    }

    if (!sc.inCfile)  // C enum remains incomplete until members are done
        ed.semanticRun = PASS.semanticdone;

    // dropped: version (none) block at dmd/enumsem.d:200-207 (disabled upstream — the
    // @@@DEPRECATED_2.110@@@ `scope`-as-a-type-constraint deprecation) (07 §1.4).

    let sce: Scope;
    if (ed.isAnonymous())
        sce = sc;
    else {
        sce = sc.push(ed);
        sce.parent = ed;
    }
    sce = sce.startCTFE();
    sce.setNoFree(); // needed for getMaxMinValue()

    /* Each enum member gets the sce scope
     */
    foreachDsymbolVoid(ed.members, (s) => {
        // enumsem.d:224 — `if (EnumMember em = s.isEnumMember())` (06 §2.6 hoist + §2.7 test).
        const em = s.isEnumMember();
        if (em !== null)
            em._scope = sce;
    });

    /* addMember() is not called when the EnumDeclaration appears as a function statement,
     * so we have to do what addMember() does and install the enum members in the right symbol
     * table
     */
    // enumsem.d:232 — `addEnumMembersToSymtab(ed, sc, sc.getScopesym());`; callee live at
    // dmd/dsymbolsem.d:6537 (`void addEnumMembersToSymtab(EnumDeclaration ed, Scope* sc,
    // ScopeDsymbol sds)`), exported by dsymbolsem.ts:7190. `getScopesym()` returns null when no
    // enclosing scope carries a `scopesym` (dscope.d:395) and D hands that null to a parameter the
    // callee dereferences, so the `!` marks exactly the site D faults on (02 §10.1).
    addEnumMembersToSymtab(ed, sc, sc.getScopesym()!);

    // dmd/enumsem.d:235 — `return cEnumSemantic(sc, ed);`
    if (sc.inCfile)
        return cEnumSemantic(sc, ed);

    foreachDsymbolVoid(ed.members, (s) => {
        const em = s.isEnumMember();
        if (em !== null)
            dsymbolSemantic(em, em._scope);
    });

    if (ed.errors)
        ed.memtype = Type.terror; // avoid infinite recursion in toBaseType
    // probe: Type.dtypeinfo is declared non-null but unset until dclass.ts fills it; D tests
    // `if (Type.dtypeinfo)` (02 §11.4 uninitialized-static probe).
    else if (global.params.useTypeInfo && (Type as { dtypeinfo?: unknown }).dtypeinfo && !ed.inNonRoot()) {
        // enumsem.d:246 — `semanticTypeInfo(sc, ed.memtype);`; callee live at
        // dmd/expressionsem.d:18781 (`void semanticTypeInfo(Scope* sc, Type t)`), exported by
        // expressionsem.ts:21089 (same re-anchoring as the :180 site).
        // `ed.memtype` is genuinely nullable HERE (unlike at enumsem.d:180, which is inside the
        // `if (ed.memtype)` block): an anonymous enum reaches this line with a null base type and D
        // passes the null straight through to a callee that null-tests it (expressionsem.d:18791).
        // So no `!` — one here would assert an invariant D does not hold (08 §3).
        semanticTypeInfo(sc, ed.memtype);
    }
    //printf("ed.defaultval = %lld\n", ed.defaultval);

    //if (ed.defaultval) printf("ed.defaultval: %s %s\n", ed.defaultval.toChars(), ed.defaultval.type.toChars());
    //printf("members = %s\n", members.toChars());

    // Set semantic2done here to indicate all members have been processed
    // This prevents using the enum in a final switch while being defined
    ed.semanticRun = PASS.semantic2done;
}

/**
 * dmd/enumsem.d:257 — `Expression getDefaultValue(EnumDeclaration ed, Loc loc)`.
 *
 * Returns the `.init` value of the enum: the first member's value, the base type's default for a
 * special/C enum, or `ErrorExp` after emitting a diagnostic.
 *
 * Preconditions: `ed` non-null. `loc` is the location the diagnostic (and a C/special enum's
 * default-init expression) is attributed to — an invalid `Loc` is legal.
 * Postconditions: `ed.defaultval` is set on every path except the two early returns that read an
 * already-cached value; a failure path sets it to `ErrorExp` (which is why the cached read at
 * enumsem.d:269 explicitly ignores an `ErrorExp`, per issue 23904).
 * Returns `Expression | null`: `defaultInit` (typesem.d:7600) yields null for a type its dispatch
 * does not cover, and `em.value` is a nullable slot — D's `Expression` return is nullable too.
 */
export function getDefaultValue(ed: EnumDeclaration, loc: Loc): Expression | null {
    // enumsem.d:259 — nested function -> inner `const` arrow, declared before its first use (04 §5).
    const handleErrors = (): Expression | null => {
        ed.defaultval = ErrorExp.get();
        return ed.defaultval;
    };
    //printf("EnumDeclaration::getDefaultValue() %p %s\n", this, toChars());
    // https://issues.dlang.org/show_bug.cgi?id=23904
    // Return ed.defaultval only if it is not ErrorExp.
    // A speculative context may set ed.defaultval to ErrorExp;
    // subsequent non-speculative contexts need to be able
    // to print the error.
    if (ed.defaultval !== null && ed.defaultval.isErrorExp() === null)
        return ed.defaultval;

    if (ed.isCsymbol())
        return defaultInit(ed.memtype!, loc, true);

    if (ed._scope !== null)
        dsymbolSemantic(ed, ed._scope);
    if (ed.errors)
        return handleErrors();
    if (ed.members === null) {
        if (ed.isSpecial()) {
            /* Allow these special enums to not need a member list
             */
            return (ed.defaultval = defaultInit(ed.memtype!, loc));
        }

        error(loc, ds("%s `%s` is opaque and has no default initializer"), ed.kind(), ed.toPrettyChars());
        return handleErrors();
    }

    // enumsem.d:292 — `foreach (const i; 0 .. ed.members.length)`: integer-range foreach, with the
    // bound evaluated ONCE (06 §1.3).
    const n = ed.members.length;
    for (let i = 0; i < n; i++) {
        // enumsem.d:294 — declaration in a condition (06 §2.6). `(*ed.members)[i]` is dereferenced
        // unconditionally by D, so the `!` marks D's own fault site (08 §3 / 02 §10.1).
        const em = ed.members.opIndex(i)!.isEnumMember();
        if (em !== null) {
            if (em.semanticRun < PASS.semanticdone) {
                error(loc, ds("%s `%s` forward reference of `%s.init`"),
                    ed.kind(), ed.toPrettyChars(), ed.toChars());
                return handleErrors();
            }

            ed.defaultval = em.value;
            return ed.defaultval;
        }
    }
    return handleErrors();
}

/**
 * dmd/enumsem.d:309 — `Type getMemtype(EnumDeclaration ed, Loc loc)`.
 *
 * Returns the enum's base (member) type, resolving a forward reference if necessary. A named enum
 * with members but no explicit base defaults to `int`; an unresolvable one errors to `Type.terror`.
 *
 * Preconditions: `ed` non-null. `loc` may be invalid — `ed.loc` is used instead (enumsem.d:318/:333).
 * Postconditions: `ed.memtype` is non-null whenever the function returns normally through
 * enumsem.d:338 (the `!ed.memtype` block either assigns `Type.tint32` or returns `Type.terror`).
 */
export function getMemtype(ed: EnumDeclaration, loc: Loc): Type {
    if (ed._scope !== null) {
        /* Enum is forward referenced. We don't need to resolve the whole thing,
         * just the base type
         */
        if (ed.memtype !== null) {
            // `Loc` is an alias-safe-register value struct: shared, never copied (03 §9.1).
            const locx: Loc = loc.isValid() ? loc : ed.loc;
            ed.memtype = typeSemantic(ed.memtype, locx, ed._scope);
        }
        else {
            // Run semantic to get the type from a possible first member value
            dsymbolSemantic(ed, ed._scope);
        }
    }
    if (ed.memtype === null) {
        // `ed.members` is a `Dsymbols*` — a nullable pointer, so the D truthiness test is a null
        // test (06 §2.7/§2.8), and `||` over a ref and a bool yields D `bool`.
        if (!ed.isAnonymous() && (ed.members !== null || ed.semanticRun >= PASS.semanticdone))
            ed.memtype = Type.tint32;
        else {
            const locx: Loc = loc.isValid() ? loc : ed.loc;
            error(locx, ds("is forward referenced looking for base type"));
            return Type.terror;
        }
    }
    // The block above guarantees `ed.memtype` is non-null here (it either assigned `Type.tint32`
    // or returned), so the `!` is a narrowing artifact, not a new fault site.
    return ed.memtype!;
}

/*********************************
 * dmd/enumsem.d:344 — `void enumMemberSemantic(Scope* sc, EnumMember em)`.
 * Perform semantic analysis on enum member `em`.
 *
 * Preconditions: `em` non-null and `em.ed` non-null (asserted, enumsem.d:361). `sc` may be null —
 * the body null-tests it at enumsem.d:371 after possibly replacing it with `em._scope`, so the
 * parameter is `Scope | null` (02 §10.1).
 * Postconditions: `em.semanticRun` is `PASS.semanticdone` on every completing path (the error
 * paths go through the nested `errorReturn`, which also sets `em.errors`); `em.value` and
 * `em.origValue` are non-null when the pass completes without error.
 */
export function enumMemberSemantic(sc: Scope | null, em: EnumMember): void {
    //printf("EnumMember::semantic() %s\n", em.toChars());

    // enumsem.d:348 — nested function -> inner `const` arrow (04 §5). `void`-returning, and D
    // spells its uses `return errorReturn();` from a `void` function — carried verbatim.
    const errorReturn = (): void => {
        em.errors = true;
        em.semanticRun = PASS.semanticdone;
    };

    if (em.errors || em.semanticRun >= PASS.semanticdone)
        return;
    if (em.semanticRun === PASS.semantic) {
        error(em.loc, ds("%s `%s` circular reference to `enum` member"), em.kind(), em.toPrettyChars());
        return errorReturn();
    }
    assert(em.ed !== null);                             // enumsem.d:361 — `assert(em.ed)` (06 §2.7)

    dsymbolSemantic(em.ed!, sc);
    if (em.ed!.errors)
        return errorReturn();
    if (em.errors || em.semanticRun >= PASS.semanticdone)
        return;

    if (em._scope !== null)
        sc = em._scope;
    if (sc === null)
        return;

    em.semanticRun = PASS.semantic;

    // enumsem.d:376 — the anonymous arm READS a struct field (03 §1 #6 -> `.copy()`); the other arm
    // CONSTRUCTS a fresh value (no copy). `Visibility` is not an alias-safe-register type.
    em.visibility = em.ed!.isAnonymous()
        ? em.ed!.visibility.copy()
        : new Visibility(Visibility.Kind.public_);
    em._linkage = LINK.d;
    em.storage_class = (em.storage_class | STC.manifest) as STC;   // branded flag-enum re-cast (02 §11.5c #4)

    // https://issues.dlang.org/show_bug.cgi?id=9701
    if (em.ed!.isAnonymous()) {
        if (em.userAttribDecl() !== null)
            em.userAttribDecl()!.userAttribDecl_set(em.ed!.userAttribDecl());
        else
            em.userAttribDecl_set(em.ed!.userAttribDecl());
    }

    // Eval UDA in this same scope. Issues 19344, 20835, 21122
    if (em.userAttribDecl() !== null) {
        // Set scope but avoid extra sc.uda attachment inside setScope()
        const inneruda = em.userAttribDecl()!.userAttribDecl();
        // enumsem.d:394 — `em.userAttribDecl.setScope(sc);`; callee live at dmd/dsymbolsem.d:8176
        // (`void setScope(Dsymbol d, Scope* sc)`), exported by dsymbolsem.ts:8918. The UFCS receiver
        // is the first argument (04 §6).
        setScope(em.userAttribDecl()!, sc);
        em.userAttribDecl()!.userAttribDecl_set(inneruda);
        dsymbolSemantic(em.userAttribDecl()!, sc);
    }

    // The first enum member is special
    const first = (em === em.ed!.members!.opIndex(0));

    if (em.origType !== null) {
        em.origType = typeSemantic(em.origType, em.loc, sc);
        em.type = em.origType;
        assert(em.value !== null); // "type id;" is not a valid enum member declaration
    }

    if (em.value !== null) {
        let e: Expression = em.value;
        assert(e.dyncast() === DYNCAST.expression);
        if (em.ed!.memtype !== null)
            e = inferType(e, em.ed!.memtype);
        e = expressionSemantic(e, sc);
        e = resolveProperties(sc, e);
        e = ctfeInterpret(e);
        if (e.op === EXP.error)
            return errorReturn();
        if (first && em.ed!.memtype === null && !em.ed!.isAnonymous()) {
            em.ed!.memtype = e.type;
            // 02 §11.4: the field was just written, and D re-reads `em.ed.memtype.ty` at BOTH tests
            // (enumsem.d:423 and :428). Each test group therefore reads a FRESH const annotated at
            // the field's declared type — one read per D test, which is also what D does. Testing
            // one shared local instead would let the first test's narrowing kill the second
            // comparison (TS2367 "no overlap") and silently drop D's second guard.
            const mty: TY = em.ed!.memtype!.ty;
            if (mty === Terror) {
                em.ed!.errors = true;
                return errorReturn();
            }
            const mty2: TY = em.ed!.memtype!.ty;
            if (mty2 !== Terror) {
                /* https://issues.dlang.org/show_bug.cgi?id=11746
                 * All of named enum members should have same type
                 * with the first member. If the following members were referenced
                 * during the first member semantic, their types should be unified.
                 */
                foreachDsymbolVoid(em.ed!.members, (s) => {
                    const enm = s.isEnumMember();
                    if (enm === null || enm === em || enm.semanticRun < PASS.semanticdone || enm.origType !== null)
                        return;

                    //printf("[%d] em = %s, em.semanticRun = %d\n", i, toChars(), em.semanticRun);
                    let ev: Expression = enm.value!;
                    ev = implicitCastTo(ev, sc, em.ed!.memtype!);
                    ev = ctfeInterpret(ev);
                    ev = castTo(ev, sc, em.ed!.type!);
                    if (ev.op === EXP.error)
                        em.ed!.errors = true;
                    enm.value = ev;
                });

                if (em.ed!.errors) {
                    em.ed!.memtype = Type.terror;
                    return errorReturn();
                }
            }
        }

        if (em.ed!.memtype !== null && em.origType === null) {
            e = implicitCastTo(e, sc, em.ed!.memtype!);
            e = ctfeInterpret(e);

            // save origValue for better json output
            em.origValue = e;

            if (!em.ed!.isAnonymous()) {
                e = castTo(e, sc, addMod(em.ed!.type!, e.type!.mod)); // https://issues.dlang.org/show_bug.cgi?id=12385
                e = ctfeInterpret(e);
            }
        }
        else if (em.origType !== null) {
            e = implicitCastTo(e, sc, em.origType);
            e = ctfeInterpret(e);
            assert(em.ed!.isAnonymous());

            // save origValue for better json output
            em.origValue = e;
        }
        em.value = e;
        // https://issues.dlang.org/show_bug.cgi?id=24311
        // First enum member is .init value, which gets put into static segment
        if (first) {
            // enumsem.d:486 — `lowerStaticAAs(e, sc);`, the `Expression` overload; callee live at
            // dmd/semantic2.d:996 (`void lowerStaticAAs(Expression e, Scope* sc)`), exported by
            // semantic2.ts:1225 as `lowerStaticAAsExpression` — the two-overload D set is split by
            // first-parameter type (04 §1B), and semantic2.ts's own header names enumsem.d:486 as
            // the single D call site of the Expression arm.
            lowerStaticAAsExpression(e, sc);
        }
    }
    else if (first) {
        // D `Type t;` / `bool terror;` take their `.init`: null / false (09 §1.0).
        let t: Type | null = null;
        let terror = false;
        if (em.ed!.memtype !== null) {
            t = em.ed!.memtype;
            if (!isScalar(t!)) {
                t = Type.terror; // print more relevant error message later
                terror = true;
            }
        }
        else {
            t = Type.tint32;
            if (!em.ed!.isAnonymous())
                em.ed!.memtype = t;
        }

        const errors = global.startGagging();
        // GAG PAIRING (11 §2.5): walls reachable below are exit paths D does not have; without the
        // catch-rethrow, a wall throw would leave `global.gag` incremented for the life of the
        // process and silently gag every later diagnostic. D needs no such guard.
        let e: Expression;
        try {
            e = new IntegerExp(em.loc, 0n, t!);
            e = ctfeInterpret(e);
        } catch (ex) {
            global.endGagging(errors);
            throw ex;
        }
        if (global.endGagging(errors) || terror) {
            error(em.loc, ds("cannot generate 0 value of type `%s` for `%s`"),
                em.ed!.memtype!.toChars(), em.toChars());
        }
        // save origValue for better json output
        em.origValue = e;

        if (!em.ed!.isAnonymous()) {
            e = castTo(e, sc, em.ed!.type!);
            e = ctfeInterpret(e);
        }
        em.value = e;
    }
    else {
        /* Find the previous enum member,
         * and set this to be the previous value + 1
         */
        // D `EnumMember emprev = null;` is written from INSIDE the callback below. TS's
        // control-flow analysis does not track closure assignments: it would keep a plain `let`
        // narrowed to `null` for the whole rest of the branch (every later read collapses to
        // `never`), and re-reading it into an annotated const does not help — the narrowing rides
        // the initializer. The one shape that keeps BOTH the null-initialisation D specifies and
        // the declared type at the read sites is the single-slot box (03 §7.2): the closure writes
        // `.value`, the reads after the loop see `EnumMember | null`.
        const emprev: Ref<EnumMember | null> = { value: null };
        // enumsem.d:532 — the delegate returns `1`/`0`, so this binds the `int` overload of
        // `foreachDsymbol` (04 §1B); D discards the result.
        foreachDsymbol(em.ed!.members, (s) => {
            // enumsem.d:534 — declaration in a condition (06 §2.6). The `int`-overload delegate's
            // parameter is nullable (02 §10.1), and D dereferences it — the `!` is D's fault site.
            const enm = s!.isEnumMember();
            if (enm !== null) {
                if (enm === em)
                    return 1;       // found
                emprev.value = enm;
            }
            return 0;       // continue
        });

        assert(emprev.value !== null);                  // enumsem.d:543 — `assert(emprev)` (06 §2.7)
        // The one read of the box; every later `emprev` in dmd/enumsem.d:559-625 is this value.
        const emprevFound: EnumMember = emprev.value;

        // New check: if the base type is an enum, auto-increment is not supported,
        // unless it is a special enum (for example, the C types like cpp_long/longlong).
        // enumsem.d:547 — declaration in a condition, over a ternary (06 §2.6/§2.7).
        const te = em.ed!.memtype !== null ? em.ed!.memtype!.isTypeEnum() : null;
        if (te !== null) {
            if (!te.sym!.isSpecial()) {
                error(em.loc,
                    ds("cannot automatically assign value to enum member `%s` because base type `%s` is an enum; provide an explicit value"),
                    em.toPrettyChars(), em.ed!.memtype!.toChars());
                return errorReturn();
            }
        }

        if (emprevFound.semanticRun < PASS.semanticdone) // if forward reference
            dsymbolSemantic(emprevFound, emprevFound._scope); // resolve it
        if (emprevFound.errors)
            return errorReturn();

        let errors = global.startGagging();
        // GAG PAIRING (11 §2.5) — see the note on the `first` branch above. The guard opens on the
        // FIRST statement of D's gagged region (enumsem.d:565), not partway through it: the
        // `emprevFound.value` read, the assert and BOTH `toHeadMutable` calls sit inside D's
        // startGagging/endGagging window (enumsem.d:564-584), and `toHeadMutable` (typesem.ts)
        // falls through to `mutableOf`, which is wall-bearing code. A guard opening at the
        // `DotIdExp.create` below would leave those statements able to throw out of an incremented
        // `global.gag`, which is exactly the leak 11 §2.5's last bullet names.
        // The three locals are hoisted out of the `try` because D's uses of them run past
        // enumsem.d:584 (`eprev` to :635, `tprev` to :589, `e` to :644); the `catch` always
        // rethrows, so TS keeps both the definite assignment and the assert's narrowing.
        let eprev: Expression | null;
        let tprev: Type | null;
        let e: Expression;
        try {
            eprev = emprevFound.value;
            assert(eprev !== null);
            // .toHeadMutable() due to https://issues.dlang.org/show_bug.cgi?id=18645
            // `.equals` is `Type.equals` (dmd/mtype.d:552), a METHOD — not the
            // dsymbolsem/expressionsem free-function families (04 §6.1).
            tprev = toHeadMutable(eprev.type!).equals(toHeadMutable(em.ed!.type!))
                ? em.ed!.memtype
                : eprev.type;
            /*
                https://issues.dlang.org/show_bug.cgi?id=20777
                Previously this used getProperty, which doesn't consider anything user defined,
                this construct does do that and thus fixes the bug.
            */
            let emax: Expression = DotIdExp.create(em.ed!.loc, new TypeExp(em.ed!.loc, tprev), Id.max);
            emax = expressionSemantic(emax, sc);
            emax = ctfeInterpret(emax);

            // check that (eprev != emax)
            e = new EqualExp(EXP.equal, em.loc, eprev, emax);
            e = expressionSemantic(e, sc);
            e = ctfeInterpret(e);
        } catch (ex) {
            global.endGagging(errors);
            throw ex;
        }
        if (global.endGagging(errors)) {
            // display an introductory error before showing what actually failed
            error(em.loc, ds("cannot check `%s` value for overflow"), em.toPrettyChars());
            // rerun to show errors
            let e2: Expression = DotIdExp.create(em.ed!.loc, new TypeExp(em.ed!.loc, tprev), Id.max);
            e2 = expressionSemantic(e2, sc);
            e2 = ctfeInterpret(e2);
            e2 = new EqualExp(EXP.equal, em.loc, eprev, e2);
            e2 = expressionSemantic(e2, sc);
            e2 = ctfeInterpret(e2);
        }
        // now any errors are for generating a value
        // `toInteger` returns `dinteger_t` (bigint), so the D truthiness test is `!== 0n` (06 §2.5).
        if (toInteger(e) !== 0n) {
            let mt: Type | null = em.ed!.memtype;
            if (mt === null)
                mt = eprev.type;
            error(em.loc, ds("%s `%s` initialization with `%s.%s+1` causes overflow for type `%s`"),
                em.kind(), em.toPrettyChars(),
                emprevFound.ed!.toChars(), emprevFound.toChars(), mt!.toChars());
            return errorReturn();
        }
        errors = global.startGagging();
        // GAG PAIRING (11 §2.5) — see the note on the `first` branch above.
        try {
            // Now set e to (eprev + 1)
            e = new AddExp(em.loc, eprev, IntegerExp.literal(1));
            e = expressionSemantic(e, sc);
            e = castTo(e, sc, eprev.type!);
            e = ctfeInterpret(e);
        } catch (ex) {
            global.endGagging(errors);
            throw ex;
        }
        if (global.endGagging(errors)) {
            error(em.loc, ds("cannot generate value for `%s`"), em.toPrettyChars());
            // rerun to show errors
            let e2: Expression = new AddExp(em.loc, eprev, IntegerExp.literal(1));
            e2 = expressionSemantic(e2, sc);
            e2 = castTo(e2, sc, eprev.type!);
            e2 = ctfeInterpret(e2);
        }
        // save origValue (without cast) for better json output
        if (e.op !== EXP.error) { // avoid duplicate diagnostics
            assert(emprevFound.origValue !== null);
            // Neither re-read of `em.origValue` below is a D fault site: each is preceded by an
            // assignment of a non-null value in the SAME straight-line block (D dereferences what
            // it just stored, enumsem.d:626-627), so neither carries a `!`.
            em.origValue = new AddExp(em.loc, emprevFound.origValue, IntegerExp.literal(1));
            em.origValue = expressionSemantic(em.origValue, sc);
            em.origValue = ctfeInterpret(em.origValue);
        }

        if (e.op === EXP.error)
            return errorReturn();
        if (isFloating(e.type!)) {
            // Check that e != eprev (not always true for floats)
            let etest: Expression = new EqualExp(EXP.equal, em.loc, e, eprev);
            etest = expressionSemantic(etest, sc);
            etest = ctfeInterpret(etest);
            if (toInteger(etest) !== 0n) {
                error(em.loc, ds("%s `%s` has inexact value due to loss of precision"),
                    em.kind(), em.toPrettyChars());
                return errorReturn();
            }
        }
        em.value = e;
    }
    if (em.origType === null)
        em.type = em.value!.type;

    assert(em.origValue !== null);
    em.semanticRun = PASS.semanticdone;
}
