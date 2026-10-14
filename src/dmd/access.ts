// Ported from dmd/access.d (module dmd.access).
//
// Enforce visibility constraints such as `public` and `private`.
// Specification: https://dlang.org/spec/attribute.html#visibility_attributes
//
// Overload-set naming (04 §1 Form B / §1.1b — TS has no signature-based overloading). All three sets
// split by FIRST-parameter type, so all three take the receiver-type suffix (04 §6.1, as in
// `checkDeprecated`/`checkDeprecatedType` and `hasPointers`/`hasPointersDsymbol`) — not the `…From<T>`
// scheme, which 04 §1 Form B documents for value-type splits of a later parameter:
//   `checkAccess`     : the (Loc, Scope, Expression, Dsymbol) form keeps the bare name — 9 call sites
//                       (typesem.d:6853/6959/6970/7285/7469/7490, expressionsem.d:8501/10040/10057) against
//                       1 for the Aggregate form (expressionsem.d:6917) and 2 for the Package form
//                       (typesem.d:1598, expressionsem.d:15915), so 04 §1.1(b) "most-used form keeps the
//                       bare name" picks it; (AggregateDeclaration, …) -> `checkAccessAggregate`,
//                       (Scope, Package) -> `checkAccessPackage`.
//   `symbolIsVisible` : the (Scope, Dsymbol) form keeps the bare name; (Module, …) ->
//                       `symbolIsVisibleModule`, (Dsymbol origin, …) -> `symbolIsVisibleDsymbol`.
//   `hasPackageAccess`: the (Module, Dsymbol) form keeps the bare name (the only one D ever calls);
//                       (Scope, Dsymbol) -> `hasPackageAccessScope`.
//
// dropped: `import dmd.funcsem : overloadApply;` (access.d:26) — the symbol has ZERO call sites in this
// module's body; it survives in D only because `mostVisibleOverload`'s doc comment mentions it by name
// (access.d:307). A value import with no use is a `noUnusedLocals` failure (01 "Strict-mode imports").
//
// dropped: `private enum LOG = false;` (access.d:30) — a translation-time gate, always OFF; each of its
// eight `static if (LOG)` printf blocks is dropped in place with an audit marker (07 §3 / _config.md).

import type { Loc } from "./location.js";
import type { Scope } from "./dscope.js";
import type { Expression } from "./expression.js";
import type { Dsymbol } from "./dsymbol.js";
import type { Module } from "./dmodule.js";
// value: hasPackageAccess calls the static `Package.resolve` (dmd/access.d:85). Cycle-safe:
// the binding is read at call time, never at module top level (01 §4.3).
import { Package } from "./dmodule.js";
import type { AggregateDeclaration } from "./aggregate.js";
import type { ClassDeclaration } from "./dclass.js";
import type { StructDeclaration } from "./dstruct.js";
import { Visibility, PASS } from "./dsymbol.js"; // values: Visibility.Kind switches + PASS.semanticdone
import { Terror } from "./astenums.js";          // value: `ad.type.ty == Terror`
import { toAlias } from "./dsymbolsem.js";       // value: UFCS `ad.toAlias()` (access.d:360)
import { error } from "./errors.js";             // value: the "is not accessible" diagnostic
import { EXP } from "./tokens.js";               // value: `e.op == EXP.super_`
import { ds } from "../dstring.js";
import { assert, SwitchError } from "../assert.js";

/*******************************
 * Do access check for member of this class, this class being the
 * type of the 'this' pointer used to access smember.
 *
 * dmd/access.d:38 — `bool checkAccess(AggregateDeclaration ad, Loc loc, Scope* sc, Dsymbol smember)`.
 * Returns true if the member is NOT accessible (i.e. an access error was reported).
 */
export function checkAccessAggregate(ad: AggregateDeclaration, loc: Loc, sc: Scope, smember: Dsymbol): boolean {
    // dropped: static if (LOG) printf trace (access.d:40-43) — LOG = false.

    const p = smember.toParent();
    if (p !== null && p.isTemplateInstance() !== null) {
        return false; // for backward compatibility
    }

    if (!symbolIsVisible(sc, smember)) {
        error(loc, ds("%s `%s` %s `%s` is not accessible"),
              ad.kind(), ad.toPrettyChars(), smember.kind(), smember.toChars());
        //printf("smember = %s %s, vis = %d, semanticRun = %d\n",
        //        smember.kind(), smember.toPrettyChars(), smember.visible() smember.semanticRun);
        return true;
    }
    return false;
}

/****************************************
 * Determine if scope sc has package level access to s.
 *
 * dmd/access.d:64 — `private bool hasPackageAccess(Scope* sc, Dsymbol s)`. D module-private, and
 * DEAD in the 1.43.0-beta1 tree: a tree-wide grep for `hasPackageAccess` finds only the two
 * `Module`-first call sites (access.d:254, access.d:299) plus access.d:391 — none reaches this
 * overload. Ported for fidelity; see the `void` line below for the `noUnusedLocals` suppression.
 *
 * `sc._module!`: D passes `sc._module` (nullable) straight through; the callee's parameter is
 * non-null here (see its header), and D would fault identically on a null `_module`.
 */
function hasPackageAccessScope(sc: Scope, s: Dsymbol): boolean {
    return hasPackageAccess(sc._module!, s);
}
// `void fn;` suppresses `noUnusedLocals` without renaming or deleting the declaration — the 04 §5
// idiom (dclass.ts:446), applied here to a MODULE-LEVEL function rather than a nested closure. §5's
// "name the rung that will call it" clause cannot be met and is not being dodged: D itself has zero
// call sites for this overload (grep above), so no rung will ever call it. Extension of the idiom
// beyond its documented scope — raised as guide feedback, not invented as a local rule.
void hasPackageAccessScope;

/**
 * dmd/access.d:69 — `private bool hasPackageAccess(Module mod, Dsymbol s)`. D module-private (kept
 * unexported: nothing outside this module reaches it).
 *
 * `mod` is dereferenced (`mod.parent`, access.d:107/123) whenever a package is found, so a null `mod`
 * faults in D exactly as it does here: the port types the parameter non-null and records the
 * assertion at each call site rather than inventing a null branch D does not have.
 */
function hasPackageAccess(mod: Module, s: Dsymbol): boolean {
    // dropped: static if (LOG) printf trace (access.d:71-74) — LOG = false.
    let pkg: Package | null = null;
    if (s.visible().pkg !== null)
        pkg = s.visible().pkg;
    else {
        // no explicit package for visibility, inferring most qualified one
        // D reassigns the parameter `s` as the loop cursor; a TS parameter keeps its declared
        // non-null type, so the walk runs on a widened local `cur` (`Dsymbol | null`).
        for (let cur: Dsymbol | null = s; cur !== null; cur = cur.parent) {
            const m = cur.isModule();
            if (m !== null) {
                // reconciled to faithful surface (W2): `Package.resolve` now carries its real body
                // (dmodule.ts:238 / dmd/dmodule.d:186), so the former wall on this arm is gone and
                // access.d:85-94 is emitted live. `m.md.packages` is a non-null `Identifier[]` in
                // the port (dmodule.ts:1232 records why), and `resolve`'s parameter is
                // `Identifier[] | null`, so D's `m.md ? m.md.packages : null` maps unchanged.
                const dst = Package.resolve(m.md !== null ? m.md.packages : null, null, null);
                assert(dst !== null);                      // D `assert(dst)` (access.d:86)
                const s2 = dst.lookup(m.ident!);
                assert(s2 !== null);                       // D `assert(s2)` (access.d:88)
                const p = s2!.isPackage();
                if (p !== null && p.isPackageMod() !== null) {
                    pkg = p;
                    break;
                }
            }
            else if ((pkg = cur.isPackage()) !== null)
                break;
        }
    }
    // dropped: static if (LOG) conditional printf (access.d:100-104) — LOG = false.
    if (pkg !== null) {
        if (pkg === mod.parent) {
            // dropped: static if (LOG) printf trace (access.d:109-113) — LOG = false.
            return true;
        }
        if (pkg.isPackageMod() === mod) {
            // dropped: static if (LOG) printf trace (access.d:117-121) — LOG = false.
            return true;
        }
        let ancestor: Dsymbol | null = mod.parent;
        for (; ancestor !== null; ancestor = ancestor.parent) {
            if (ancestor === pkg) {
                // dropped: static if (LOG) printf trace (access.d:128-132) — LOG = false.
                return true;
            }
        }
    }
    // dropped: static if (LOG) printf trace (access.d:136-139) — LOG = false.
    return false;
}

/****************************************
 * Determine if scope sc has protected level access to cd.
 *
 * dmd/access.d:146 — `private bool hasProtectedAccess(Scope* sc, Dsymbol s)`. D module-private.
 */
function hasProtectedAccess(sc: Scope, s: Dsymbol): boolean {
    const cd = s.isClassMember(); // also includes interfaces
    if (cd !== null) {
        for (let scx: Scope | null = sc; scx !== null; scx = scx.enclosing) {
            if (scx.scopesym === null)
                continue;
            const cd2 = scx.scopesym.isClassDeclaration();
            if (cd2 !== null && cd.isBaseOf(cd2, null))
                return true;
        }
    }
    return sc._module === s.getAccessModule();
}

/****************************************
 * Check access to d for expression e.d
 *
 * dmd/access.d:166 — `bool checkAccess(Loc loc, Scope* sc, Expression e, Dsymbol d)`.
 * Returns true if the declaration is NOT accessible.
 */
export function checkAccess(loc: Loc, sc: Scope, e: Expression | null, d: Dsymbol): boolean {
    if (sc.noAccessCheck)
        return false;
    // dropped: static if (LOG) printf trace, both arms (access.d:170-181) — LOG = false.
    if (d.isUnitTestDeclaration() !== null) {
        // Unittests are always accessible.
        return false;
    }

    if (e === null)
        return false;

    const tc = e.type!.isTypeClass();
    if (tc !== null) {
        // Do access check
        let cd: ClassDeclaration | null = tc.sym;
        if (e.op === EXP.super_) {
            const cd2 = sc.func!.toParent()!.isClassDeclaration();
            if (cd2 !== null)
                cd = cd2;
        }
        // `as unknown as AggregateDeclaration`: cascade of the audited `deferred` field shadow
        // (AggregateDeclaration.deferred: Dsymbol hides Dsymbol.deferred: bool, aggregate.ts:103), which
        // blocks structural subtyping of the nominal `ClassDeclaration : AggregateDeclaration`. Same
        // spelling as dclass.ts:258 / dscope.ts:265. NOT a semantic cast — D's `cd` IS an AggregateDeclaration.
        return checkAccessAggregate(cd! as unknown as AggregateDeclaration, loc, sc, d);
    }
    else {
        // chained `else if (auto ts = …)`: nested so the second probe runs only when the first
        // arm did not match (06 §2.6).
        const ts = e.type!.isTypeStruct();
        if (ts !== null) {
            // Do access check
            const cd: StructDeclaration | null = ts.sym;
            // Same audited `deferred` field-shadow cascade as the class arm above.
            return checkAccessAggregate(cd! as unknown as AggregateDeclaration, loc, sc, d);
        }
    }
    return false;
}

/****************************************
 * Check access to package/module `p` from scope `sc`.
 *
 * dmd/access.d:224 — `bool checkAccess(Scope* sc, Package p)`.
 * Params:
 *   sc = scope from which to access to a fully qualified package name
 *   p = the package/module to check access for
 * Returns: true if the package is not accessible.
 *
 * Because a global symbol table tree is used for imported packages/modules,
 * access to them needs to be checked based on the imports in the scope chain
 * (see https://issues.dlang.org/show_bug.cgi?id=313).
 */
export function checkAccessPackage(sc: Scope, p: Package): boolean {
    // `as unknown as Package`: cascade of the audited `Module.errors` field shadow (uint hides
    // `Dsymbol.errors: bool`, dmodule.ts:173), which blocks structural subtyping of the nominal
    // `Module : Package`. Same spelling as dimport.ts:127. NOT a semantic cast — D's `Module` IS a `Package`.
    if ((sc._module as unknown as Package | null) === p)
        return false;
    // D reassigns the parameter `sc` as the loop cursor; the port walks a widened local instead.
    for (let scx: Scope | null = sc; scx !== null; scx = scx.enclosing) {
        // `Visibility(Visibility.Kind.private_)` is a fresh rvalue argument — copy elided (03 §9).
        if (scx.scopesym !== null &&
            scx.scopesym.isPackageAccessible(p, new Visibility(Visibility.Kind.private_)))
            return false;
    }

    return true;
}

/**
 * Check whether symbols `s` is visible in `mod`.
 *
 * dmd/access.d:245 — `bool symbolIsVisible(Module mod, Dsymbol s)`.
 * Params:
 *  mod = lookup origin
 *  s = symbol to check for visibility
 * Returns: true if s is visible in mod
 *
 * `mod` stays NULLABLE (04 §0.1 — the protocol is ported 1:1): D's `Module mod` is a class reference,
 * and `symbolIsVisible(Dsymbol origin, …)` (access.d:265) feeds it `origin.getAccessModule()`, which
 * returns null when the walk finds no enclosing Module (dsymbol.d:568). On that path D compares
 * `null == null` in the private_/protected_ arms and reports the symbol VISIBLE — a live behaviour,
 * not a corner to assert away.
 */
export function symbolIsVisibleModule(mod: Module | null, s: Dsymbol): boolean {
    // should sort overloads by ascending visibility instead of iterating here
    s = mostVisibleOverload(s);
    switch (s.visible().kind) {
        case Visibility.Kind.undefined: return true;
        case Visibility.Kind.none: return false; // no access
        case Visibility.Kind.private_: return s.getAccessModule() === mod;
        // `mod!`: past the short-circuit D reaches `hasPackageAccess(mod, s)`, whose body derefs
        // `mod.parent` (access.d:107) — a null `mod` faults there in D too; the `!` records D's own
        // precondition, it does not add an invariant.
        case Visibility.Kind.package_: return s.getAccessModule() === mod || hasPackageAccess(mod!, s);
        case Visibility.Kind.protected_: return s.getAccessModule() === mod;
        case Visibility.Kind.public_:
        case Visibility.Kind.export_: return true;
        default:
            // D `final switch` -> throwing default (06 §3.2). Exhaustiveness is not statically
            // checkable here: `Visibility.Kind` is a numeric tag, not a TS enum union.
            throw new SwitchError();
    }
}

/**
 * Same as above, but determines the lookup module from symbols `origin`.
 *
 * dmd/access.d:263 — `bool symbolIsVisible(Dsymbol origin, Dsymbol s)`.
 *
 * `getAccessModule()` may return null (dsymbol.d:568); D passes that null straight through, so the
 * port does too — no `!` (see `symbolIsVisibleModule`'s header for what D does with it).
 */
export function symbolIsVisibleDsymbol(origin: Dsymbol, s: Dsymbol): boolean {
    return symbolIsVisibleModule(origin.getAccessModule(), s);
}

/**
 * Same as above but also checks for protected symbols visible from scope `sc`.
 * Used for qualified name lookup.
 *
 * dmd/access.d:277 — `bool symbolIsVisible(Scope* sc, Dsymbol s)`.
 * Params:
 *  sc = lookup scope
 *  s = symbol to check for visibility
 * Returns: true if s is visible by origin
 */
export function symbolIsVisible(sc: Scope, s: Dsymbol): boolean {
    s = mostVisibleOverload(s);
    return checkSymbolAccess(sc, s);
}

/**
 * Check if a symbol is visible from a given scope without taking
 * into account the most visible overload.
 *
 * dmd/access.d:292 — `bool checkSymbolAccess(Scope* sc, Dsymbol s)`.
 * Params:
 *  sc = lookup scope
 *  s = symbol to check for visibility
 * Returns: true if s is visible by origin
 */
export function checkSymbolAccess(sc: Scope, s: Dsymbol): boolean {
    switch (s.visible().kind) {
        case Visibility.Kind.undefined: return true;
        case Visibility.Kind.none: return false; // no access
        case Visibility.Kind.private_: return sc._module === s.getAccessModule();
        case Visibility.Kind.package_:
            // `sc._module!`: same as in `symbolIsVisibleModule` — D hands `sc._module` (nullable) to a
            // callee that derefs it (access.d:107), so the `!` records D's precondition, not a new one.
            return sc._module === s.getAccessModule() || hasPackageAccess(sc._module!, s);
        case Visibility.Kind.protected_: return hasProtectedAccess(sc, s);
        case Visibility.Kind.public_:
        case Visibility.Kind.export_: return true;
        default:
            // D `final switch` -> throwing default (06 §3.2); numeric tag, no `never` check.
            throw new SwitchError();
    }
}

/**
 * Use the most visible overload to check visibility. Later perform an access
 * check on the resolved overload.  This function is similar to overloadApply,
 * but doesn't recurse nor resolve aliases because visibility is an
 * attribute of the alias not the aliasee.
 *
 * dmd/access.d:311 — `public Dsymbol mostVisibleOverload(Dsymbol s, Module mod = null)`.
 */
export function mostVisibleOverload(s: Dsymbol, mod: Module | null = null): Dsymbol {
    if (!s.isOverloadable())
        return s;

    // `Dsymbol next;` — a class reference's `.init` is null (09 §1.0).
    let next: Dsymbol | null = null;
    const fstart: Dsymbol = s;
    let mostVisible: Dsymbol = s;
    // D walks the chain by reassigning the parameter `s`; the port uses a widened local cursor
    // (`Dsymbol | null`) because a TS parameter keeps its declared non-null type.
    for (let cur: Dsymbol | null = s; cur !== null; cur = next) {
        // void func() {}
        // private void func(int) {}
        // The `else if (auto x = …)` chain is nested (06 §2.6) so each probe runs exactly as often
        // as in D.
        const fd = cur.isFuncDeclaration();
        if (fd !== null)
            next = fd.overnext;
        // template temp(T) {}
        // private template temp(T:int) {}
        else {
            const td = cur.isTemplateDeclaration();
            if (td !== null)
                next = td.overnext;
            // alias common = mod1.func1;
            // alias common = mod2.func2;
            else {
                const fa = cur.isFuncAliasDeclaration();
                if (fa !== null)
                    next = fa.overnext;
                // alias common = mod1.templ1;
                // alias common = mod2.templ2;
                else {
                    const od = cur.isOverDeclaration();
                    if (od !== null)
                        next = od.overnext;
                    // alias name = sym;
                    // private void name(int) {}
                    else {
                        const ad = cur.isAliasDeclaration();
                        if (ad !== null) {
                            assert(ad.isOverloadable() || (ad.type !== null && ad.type.ty === Terror),
                                "Non overloadable Aliasee in overload list");
                            // Yet unresolved aliases store overloads in overnext.
                            if (ad.semanticRun < PASS.semanticdone)
                                next = ad.overnext;
                            else {
                                /* This is a bit messy due to the complicated implementation of
                                 * alias.  Aliases aren't overloadable themselves, but if their
                                 * Aliasee is overloadable they can be converted to an overloadable
                                 * alias.
                                 *
                                 * This is done by replacing the Aliasee w/ FuncAliasDeclaration
                                 * (for functions) or OverDeclaration (for templates) which are
                                 * simply overloadable aliases w/ weird names.
                                 *
                                 * Usually aliases should not be resolved for visibility checking
                                 * b/c public aliases to private symbols are public. But for the
                                 * overloadable alias situation, the Alias (_ad_) has been moved
                                 * into its own Aliasee, leaving a shell that we peel away here.
                                 */
                                const aliasee = toAlias(ad); // UFCS `ad.toAlias()` (04 §6)
                                if (aliasee.isFuncAliasDeclaration() !== null || aliasee.isOverDeclaration() !== null)
                                    next = aliasee;
                                else {
                                    /* A simple alias can be at the end of a function or template overload chain.
                                     * It can't have further overloads b/c it would have been
                                     * converted to an overloadable alias.
                                     */
                                    assert(ad.overnext === null, "Unresolved overload of alias");
                                    break;
                                }
                            }
                            // handled by dmd.func.overloadApply for unknown reason
                            assert(next !== ad); // should not alias itself
                            assert(next !== fstart); // should not alias the overload list itself
                        }
                        else
                            break;
                    }
                }
            }
        }

        /**
        * Return the "effective" visibility attribute of a symbol when accessed in a module.
        * The effective visibility attribute is the same as the regular visibility attribute,
        * except package() is "private" if the module is outside the package;
        * otherwise, "public".
        *
        * dmd/access.d:386 — a `static` nested function (no context capture); its `mod` parameter
        * deliberately shadows the enclosing `mod`, exactly as in D. Kept at the D declaration's
        * position (inside the loop body) for line-for-line correspondence: `static` = captures
        * nothing, and this arrow closes over nothing either, so the per-iteration binding is a
        * pure allocation with no observable difference from D's single definition.
        */
        const visibilitySeenFromModule = (d: Dsymbol, mod: Module | null = null): Visibility => {
            // `Visibility vis = d.visible();` (access.d:388) is a §1 copy point — copy elided (03 §9).
            // `Visibility` is NOT in the §9.1 alias-safe register (it has a live in-scope mutator,
            // attrib.ts:296), so the elision is justified per-site: in the port `Declaration.visible()`
            // returns the LIVE field (declaration.ts:180), so `vis` ALIASES `d.visibility` — but `vis` is
            // never mutated here, and the only intervening call (`hasPackageAccess`) reads visibility
            // without writing it, so the alias is indistinguishable from D's copy. The fall-through still
            // copies on the way out (return-by-value, §1 #3).
            const vis = d.visible();
            if (mod !== null && vis.kind === Visibility.Kind.package_) {
                return hasPackageAccess(mod, d) ? new Visibility(Visibility.Kind.public_)
                                                : new Visibility(Visibility.Kind.private_);
            }
            return vis.copy(); // return-by-value copy point (03 §1 #3)
        };

        // `a < b` on a `Visibility` value routes through `opCmp` (05 §3).
        if (next !== null &&
            visibilitySeenFromModule(mostVisible, mod).opCmp(visibilitySeenFromModule(next, mod)) < 0)
            mostVisible = next;
    }
    return mostVisible;
}
