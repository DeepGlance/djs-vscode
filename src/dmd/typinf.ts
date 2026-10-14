/**
 * Generate `TypeInfo` objects, which are needed for run-time introspection of types.
 *
 * Ported 1:1 from dmd/typinf.d (module dmd.typinf), ldc 1.43.0, with IN_LLVM ON (_config.md §1):
 *  - resolved: `version (IN_LLVM)` in `genTypeInfo` (typinf.d:91-102) -> the LDC branch, which is
 *    empty ("LDC handles emission in the codegen layer"). `needsCodegen` therefore stays `false`, so
 *    `genTypeInfo` always returns `false` and `getTypeInfoType` never pushes onto the root module.
 *  - dropped: `isSpeculativeType` (typinf.d:226, inside `version (IN_LLVM) {} else { … }` at :213-318)
 *    — not compiled under LDC ("no need to take care of speculative types").
 *  - dropped: `import core.stdc.stdio;` (typinf.d:28) — only commented-out printf use it.
 *  - dropped: `import dmd.templatesem;` (typinf.d:25) — nothing here resolves to it: the one call it
 *    could serve, `printInstantiationTrace`, is a `TemplateInstance` method in the TS tree
 *    (dtemplate.ts).
 *
 * Load order (01 §4.8): node modules first (mtype, declaration), the `*sem` modules last. Every
 * value read of the imports happens inside a function body; the module reads nothing at load.
 */

import { assert } from "../assert.js";
import { ds } from "../dstring.js";

import { MODFlags, TY } from "./astenums.js";
import { global } from "./globals.js";
import { Classification, error, fatal } from "./errors.js";
import type { Loc } from "./location.js";
import type { Scope } from "./dscope.js";
import type { Module } from "./dmodule.js";
import type { Expression } from "./expression.js";
import { Type, TypeAArray } from "./mtype.js";
import {
    TypeInfoDeclaration, TypeInfoStructDeclaration, TypeInfoClassDeclaration, TypeInfoInterfaceDeclaration,
    TypeInfoPointerDeclaration, TypeInfoArrayDeclaration, TypeInfoStaticArrayDeclaration,
    TypeInfoAssociativeArrayDeclaration, TypeInfoEnumDeclaration, TypeInfoFunctionDeclaration,
    TypeInfoDelegateDeclaration, TypeInfoTupleDeclaration, TypeInfoConstDeclaration, TypeInfoInvariantDeclaration,
    TypeInfoSharedDeclaration, TypeInfoWildDeclaration, TypeInfoVectorDeclaration,
} from "./declaration.js";
// last (01 §4.8): semantic passes after the node modules, so this module never enters the core SCC
// through a `*sem` file.
import { merge, merge2, nakedOf, nextOf, substWildTo, toBasetype } from "./typesem.js";
import { addDeferredSemantic3 } from "./dsymbolsem.js";
import { K, keepTypeInfo, keepTypeInfoDecl } from "../keep.js";

/****************************************************
 * dmd/typinf.d:41 — `bool genTypeInfo(Expression e, Loc loc, Type torig, Scope* sc)`.
 *
 * Generates the `TypeInfo` object associated with `torig` if it
 * hasn't already been generated
 * Params:
 *      e     = if not null, then expression for pretty-printing errors
 *      loc   = the location for reporting line numbers in errors
 *      torig = the type to generate the `TypeInfo` object for
 *      sc    = the scope (may be null: LDC codegen calls with none, gen/typinf.cpp:68; frontend callers pass one)
 * Returns:
 *      true if `TypeInfo` was generated and needs compiling to object file — never under LDC
 *      (IN_LLVM: codegen emits TypeInfo itself), so this always returns false.
 * Postcondition: `torig.vtinfo` is non-null. Fatal (`fatal()`) when TypeInfo is unavailable (`-betterC` outside
 * CTFE, or `object.TypeInfo` missing); past a `fatal()` that returns (10 §4.7) the body goes on as D's does.
 */
export function genTypeInfo(e: Expression | null, loc: Loc, torig: Type, sc: Scope | null): boolean {
    // dropped: commented-out printf (typinf.d:43).

    // Even when compiling without `useTypeInfo` (e.g. -betterC) we should
    // still be able to evaluate `TypeInfo` at compile-time, just not at runtime.
    // https://issues.dlang.org/show_bug.cgi?id=18472
    if (!sc || !sc.ctfe) {
        if (!global.params.useTypeInfo) {
            global.gag = 0;
            if (e)
                error(loc, ds("expression `%s` uses the GC and cannot be used with switch `-betterC`"), e.toChars());
            else
                error(loc, ds("`TypeInfo` cannot be used with `-betterC`"));

            if (sc && sc.tinst)
                sc.tinst.printInstantiationTrace(Classification.error, 0xFFFF_FFFF); // D `uint.max`

            fatal();
        }
    }

    // probe: Type.dtypeinfo is declared non-null but unset until object.d is analysed; D tests
    // `if (!Type.dtypeinfo)` (02 §11.4).
    if (!(Type as { dtypeinfo?: unknown }).dtypeinfo) {
        error(loc, ds("`object.TypeInfo` could not be found, but is implicitly used"));
        fatal();
    }

    // resolved: function-local `import dmd.typesem : merge2;` (typinf.d:71) -> the module import above.
    let t: Type = merge2(torig); // do this since not all Type's are merge'd
    if (t.ty === TY.Taarray)
        t = makeNakedAssociativeArray(t.isTypeAArray()!); // tag-proved by the test above

    const needsCodegen = false;
    if (!t.vtinfo) {
        if (t.isShared()) // does both 'shared' and 'shared const'
            t.vtinfo = TypeInfoSharedDeclaration.create(t);
        else if (t.isConst())
            t.vtinfo = TypeInfoConstDeclaration.create(t);
        else if (t.isImmutable())
            t.vtinfo = TypeInfoInvariantDeclaration.create(t);
        else if (t.isWild())
            t.vtinfo = TypeInfoWildDeclaration.create(t);
        else
            t.vtinfo = getTypeInfoDeclaration(t, sc);
        assert(t.vtinfo !== null);

        // resolved: `version (IN_LLVM)` (typinf.d:91) -> "LDC handles emission in the codegen layer";
        // the `else` branch (ClassInfo test + `builtinTypeInfo` -> `needsCodegen = true`, :95-101) is
        // DROPPED (_config.md §1).
    }
    if (!torig.vtinfo)
        torig.vtinfo = t.vtinfo; // Types aren't merged, but we can share the vtinfo's
    assert(torig.vtinfo !== null);
    if (K.on && t.ty === TY.Taarray) keepTypeInfo(t, torig, sc);   // the kept-module engine: an AA's TypeInfo
    return needsCodegen;
}

/****************************************************
 * dmd/typinf.d:119 — `extern (C++) Type getTypeInfoType(Loc loc, Type t, Scope* sc)`.
 *
 * Gets the type of the `TypeInfo` object associated with `t`
 * Params:
 *      loc = the location for reporting line nunbers in errors
 *      t   = the type to get the type of the `TypeInfo` object for (not `Terror`, asserted)
 *      sc  = the scope (may be null, forwarded to `genTypeInfo`)
 * Returns:
 *      The type of the `TypeInfo` object associated with `t`
 * Side effect: creates and caches `t.vtinfo` (see `genTypeInfo`).
 */
export function getTypeInfoType(loc: Loc, t: Type, sc: Scope | null): Type {
    assert(t.ty !== TY.Terror);
    if (genTypeInfo(null, loc, t, sc)) {
        // Unreachable under IN_LLVM (genTypeInfo always returns false); kept 1:1 — D compiles it.
        // Find module that will go all the way to an object file
        const m: Module = sc!._module!.importedFrom!;
        m.members!.push(t.vtinfo!);
    }
    return t.vtinfo!.type!;
}

// dmd/typinf.d:131 — `private TypeInfoDeclaration getTypeInfoDeclaration(Type t, Scope* sc)`.
function getTypeInfoDeclaration(t: Type, sc: Scope | null): TypeInfoDeclaration {
    // dropped: commented-out printf (typinf.d:133).
    switch (t.ty) {
        case TY.Tpointer:
            return TypeInfoPointerDeclaration.create(t);
        case TY.Tarray:
            return TypeInfoArrayDeclaration.create(t);
        case TY.Tsarray:
            return TypeInfoStaticArrayDeclaration.create(t);
        case TY.Taarray:
            return getTypeInfoAssocArrayDeclaration(t.isTypeAArray()!, sc); // tag-proved by the case label
        case TY.Tstruct:
            return TypeInfoStructDeclaration.create(t);
        case TY.Tvector:
            return TypeInfoVectorDeclaration.create(t);
        case TY.Tenum:
            return TypeInfoEnumDeclaration.create(t);
        case TY.Tfunction:
            return TypeInfoFunctionDeclaration.create(t);
        case TY.Tdelegate:
            return TypeInfoDelegateDeclaration.create(t);
        case TY.Ttuple:
            return TypeInfoTupleDeclaration.create(t);
        case TY.Tclass:
            // D `(cast(TypeClass)t).sym`, tag-proved by the case label; `sym` dereferenced as in D.
            if (t.isTypeClass()!.sym!.isInterfaceDeclaration())
                return TypeInfoInterfaceDeclaration.create(t);
            else
                return TypeInfoClassDeclaration.create(t);

        default:
            return TypeInfoDeclaration.create(t);
    }
}

/******************************************
 * dmd/typinf.d:177 — `TypeInfoDeclaration getTypeInfoAssocArrayDeclaration(TypeAArray t, Scope* sc)`.
 *
 * Instantiate TypeInfoAssociativeArrayDeclaration and fill
 * the entry with TypeInfo_AssociativeArray.Entry!(t.index, t.next)
 *
 * Params:
 *      t = TypeAArray to generate TypeInfo_AssociativeArray for
 *      sc = context (must be non-null: asserted — never called in the code generation phase)
 * Returns:
 *      a TypeInfoAssociativeArrayDeclaration with field entry initialized
 * Side effects: sets `t.vtinfo` early (recursion guard), pins `sc` (`setNoFree`) and queues the
 * declaration for deferred semantic3.
 */
export function getTypeInfoAssocArrayDeclaration(t: TypeAArray, sc: Scope | null): TypeInfoDeclaration {
    // dropped: function-local `import dmd.arraytypes; import dmd.expressionsem; import dmd.id;`
    // (typinf.d:179-181) — nothing in the body resolves to them.

    assert(sc !== null); // must not be called in the code generation phase

    // the kept-module engine: in a kept compile, the type's kept declaration, reused; the creation below is redone
    const ti = K.on ? keepTypeInfoDecl(t, () => TypeInfoAssociativeArrayDeclaration.create(t))
        : TypeInfoAssociativeArrayDeclaration.create(t);
    t.vtinfo = ti; // assign it early to avoid recursion in expressionSemantic
    ti._scope = sc;
    sc!.setNoFree();
    addDeferredSemantic3(ti);
    return ti;
}

/******************************************
 * dmd/typinf.d:202 — `Type makeNakedAssociativeArray(TypeAArray t)`.
 *
 * Find or create a TypeAArray with index and next without
 * any head modifiers, tail `inout` is replaced with `const`
 *
 * Params:
 *      t = TypeAArray to convert
 * Returns:
 *      t = found type (`t` itself when already naked, else a merged new TypeAArray)
 */
export function makeNakedAssociativeArray(t: TypeAArray): Type {
    const tindex = substWildTo(nakedOf(toBasetype(t.index!)), MODFlags.const_);
    const tnext = substWildTo(nakedOf(toBasetype(t.next!)), MODFlags.const_);
    if (tindex === t.index && tnext === t.next)
        return t;

    t = new TypeAArray(tnext, tindex);
    return merge(t);
}

/* ========================================================================= */

/**
 * dmd/typinf.d:325 — `bool builtinTypeInfo(Type t)`.
 *
 * Indicates whether druntime already contains an appropriate TypeInfo instance
 * for the specified type (in module rt.util.typeinfo).
 * Compiled under LDC too (outside the `!IN_LLVM` block); its frontend caller in `genTypeInfo` is
 * not, so under IN_LLVM only the (unported) codegen layer would call it.
 */
export function builtinTypeInfo(t: Type): boolean {
    if (!t.mod) { // unqualified types only
        // unqualified basic types + typeof(null)
        if (t.isTypeBasic() || t.ty === TY.Tnull)
            return true;
        // some unqualified arrays
        if (t.ty === TY.Tarray) {
            const next = nextOf(t)!; // a Tarray always has a `next`; D dereferences it
            return (next.isTypeBasic() !== null && !next.mod)                   // of unqualified basic types
                || (next.ty === TY.Tchar && next.mod === MODFlags.immutable_)  // string
                || (next.ty === TY.Tchar && next.mod === MODFlags.const_);     // const(char)[]
        }
    }
    return false;
}
