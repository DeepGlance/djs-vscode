// Ported 1:1 from dmd/clone.d (module dmd.clone), ldc-1.43.0-beta1.
//
// "Builds struct member functions if needed and not defined by the user. Includes `opEquals`,
// `opAssign`, post blit, copy constructor and destructor." Every declaration of clone.d is
// translated here, in D source order, as a FREE FUNCTION (04 §6 — nothing is re-homed onto
// AggregateDeclaration/StructDeclaration).
//
// WHAT RUNS TODAY. Every builder is called unconditionally from `visitStructDeclaration`
// (dsymbolsem.ts) during a struct's pass-1, including for a plain-old-data struct that needs
// none of these members. Those POD paths are fully live end-to-end: no wall sits on a branch a
// field-less / special-member-less struct reaches. The deferred callees below are all inside the
// elaborate branches (a struct-typed field, a user dtor/postblit/opAssign/opEquals, an existing
// ctor, a C++ linkage dtor).
//
// DEFERRED CALLEES: none. `target.cpp.twoDtorInVtable` / `target.cpp.wrapDtorInExternD` (clone.d:1068/:1165,
// fields at target.d:1682/:1684) are read from target.ts, which folds LDC's C++ `Target::_init()` values.
//
// SWEPT (11 §2.5 end-of-wave sweep — every wall replaced by the faithful call, each citing the D
// line that AUTHORISES the now-live callee):
//   resolveFuncCall      (funcsem.d:1905)      -> funcsem.ts:2016      identity opAssign / opEquals
//   overloadExactMatch   (funcsem.d:2444)      -> funcsem.ts:2604      __xopEquals/__xopCmp/__xtoHash
//   overloadApply        (funcsem.d:4084)      -> funcsem.ts:4197      copy/move ctor discovery
//   semantic2            (semantic2.d:79)      -> semantic2.ts:197     pass 2 on generated members
//   getDsymbol           (expressionsem.d:5260)-> expressionsem.ts:6052 object._xopEquals/_xopCmp
//   numberOfElems        (typesem.d:9329)      -> typesem.ts:9726      array-of-struct element count
// The try/finally protections around `startGagging`/`endGagging` and `sc.push()`/`pop()` STAY: the
// swept callees hold walls of their own, and 11 §2.5 requires the shape for the shape.
//
// NO CARRY-OVER LIVES IN THIS FILE. `search_function` is D-homed at opover.d:1183 and this wave's
// `opover.ts` translation emits it; this module simply IMPORTS it from there. It is not
// re-exported: clone.d exports no such symbol, and the last consumer that selected it from
// `./clone.js` (typesem.ts) has been flipped to `./opover.js`.
//
// LOAD ORDER (01 §4.1/§4.3). The value import of `./func.js` below is the D-faithful form and it
// is a cross-core value edge: `func.ts` declares `class FuncDeclaration extends Declaration` at top
// level, so any entry order that starts declaration.ts and reaches this file before declaration.ts
// finishes throws `Class extends value undefined`. That is not fixable inside clone.ts (measured by
// scratch A/B: dropping ONLY the `./func.js` edge re-forms the chain through `./semantic3.js`,
// `./expressionsem.js` and `./typesem.js`, all of them real clone.d calls). It was fixed UPSTREAM,
// where the guide points: declaration.ts no longer value-imports `./mangle/index.js` (D's import
// there is function-local, declaration.d:725) and hdrgen.ts no longer value-imports `./typesem.js`
// (D writes the `t.next` FIELD at hdrgen.d:4369, not the `nextOf` accessor).

import { assert } from "../assert.js";
import { ds } from "../dstring.js";
import { STC, TRUST, PURE, LINK, MODFlags, TY } from "./astenums.js";
import type { MOD } from "./astenums.js";
import { ClassKind } from "./aggregate.js";
import type { AggregateDeclaration } from "./aggregate.js";
// Value import (01 Rule 4.3 — read post-load, only inside function bodies): `xerreq`/`xerrcmp`
// are D `__gshared` members (dstruct.d:47-48), so the port holds them as STATIC fields; D's
// `sd.xerreq` therefore becomes `StructDeclaration.xerreq`.
import { StructDeclaration } from "./dstruct.js";
import type { ClassDeclaration } from "./dclass.js";
import { Scope } from "./dscope.js"; // value: `Scope scx;` (clone.d:572/:645) is a stack Scope
import type { Dsymbol } from "./dsymbol.js";
// Value imports read post-load, only inside bodies (01 Rule 4.3): the generated members this
// module constructs (`new VarDeclaration` for `__swap`, `new FuncDeclaration` for the generated
// opAssign/__xopEquals/__xopCmp/__xtoHash, the Dtor/PostBlit/Invariant/Ctor declarations).
import { AliasDeclaration, VarDeclaration } from "./declaration.js";
import {
    CtorDeclaration, DtorDeclaration, FuncDeclaration, InvariantDeclaration, PostBlitDeclaration,
} from "./func.js";
import {
    AddrExp, ArgumentList, AssignExp, BlitExp, CallExp, CastExp, DeclarationExp, DotIdExp, DotVarExp,
    EqualExp, Expression, IdentifierExp, IntegerExp, NullExp, PtrExp, SliceExp, StringExp, ThisExp, VarExp,
} from "./expression.js";
import type { Statement } from "./statement.js";
import { CompoundStatement, ExpStatement, MixinStatement, ReturnStatement, ScopeGuardStatement } from "./statement.js";
import { VoidInitializer } from "./init.js";
import { ModToStc, Parameter, ParameterList, Type, TypeFunction } from "./mtype.js";
import type { TypeStruct } from "./mtype.js";
import type { DtorDeclarations, Expressions, Parameters, Statements } from "./arraytypes.js";
import { Array as Array_ } from "./root/array.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { global } from "./globals.js";
import { EXP, TOK } from "./tokens.js";
import { deprecation, deprecationSupplemental, error, errorSupplemental } from "./errors.js";
// Value imports read post-load, only inside bodies (01 Rule 4.3): the semantic drivers every
// generated member is pushed through.
import { addMember, dsymbolSemantic, search } from "./dsymbolsem.js";
import { semantic3 } from "./semantic3.js";
// Value import read post-load, only inside bodies (01 Rule 4.3). It is a NEW cross-core edge, but
// not a new ORDERING constraint: clone -> semantic3 -> semantic2 already existed (semantic3.ts:109).
import { semantic2 } from "./semantic2.js";
import { expressionSemantic, getDsymbol } from "./expressionsem.js";
// `functionSemantic` is D-homed at funcsem.d:1547 and imported from funcsem.ts; so are the three
// overload-resolution entry points D reaches by UFCS from this module.
import { FuncResolveFlag, functionSemantic, overloadApply, overloadExactMatch, resolveFuncCall } from "./funcsem.js";
import {
    isAssignable, toDsymbol, typeSemantic, baseElemOf, toBasetype, constOf, immutableOf, sharedOf, sharedConstOf,
    addSTC, merge, mutableOf, numberOfElems, pointerTo, isFloating
} from "./typesem.js";
// D-homed `search_function` (opover.d:1183) — this file's five call sites use it directly; no copy
// and no re-export (04 §6: a free function lives in the TS module mirroring its D module).
import { search_function } from "./opover.js";
import { target } from "./target.js";

/**
 * Single-slot box for a D `out` parameter (03 §3.3). D resets an `out` parameter to `T.init` on
 * entry and the caller reads the written value back; the box reproduces both halves.
 *
 * Exported because `needCopyOrMoveCtor` (clone.d:1685) has four of them in its public signature.
 */
export interface Ref<T> {
    value: T;
}

/*******************************************
 * dmd/clone.d:54 — `STC mergeFuncAttrs(STC s1, const FuncDeclaration f) pure @safe`.
 *
 * Merge function attributes pure, nothrow, @safe, @nogc, and @disable from `f` into `s1`.
 *
 * Params:
 *      s1 = storage class to merge into
 *      f = function (may be null — every caller passes a possibly-absent special member)
 * Returns:
 *      merged storage class
 *
 * Cost: pure bit arithmetic on the 64-bit STC carrier (02 §4.2 — `STC` is a branded `bigint`, so
 * every `&`/`|`/`~` result is re-cast, and every flag test compares against `0n`).
 */
export function mergeFuncAttrs(s1: STC, f: FuncDeclaration | null): STC {
    if (f === null)
        return s1;
    let s2: STC = (f.storage_class & STC.disable) as STC;

    const tf = f.type!.isTypeFunction();
    if (tf!.trust === TRUST.safe)
        s2 = (s2 | STC.safe) as STC;
    else if (tf!.trust === TRUST.system)
        s2 = (s2 | STC.system) as STC;
    else if (tf!.trust === TRUST.trusted)
        s2 = (s2 | STC.trusted) as STC;

    if (tf!.purity !== PURE.impure)
        s2 = (s2 | STC.pure_) as STC;
    if (tf!.isNothrow)
        s2 = (s2 | STC.nothrow_) as STC;
    if (tf!.isNogc)
        s2 = (s2 | STC.nogc) as STC;

    const sa = (s1 & s2) as STC;
    const so = (s1 | s2) as STC;

    let stc: STC = ((sa & (STC.pure_ | STC.nothrow_ | STC.nogc)) | (so & STC.disable)) as STC;

    if ((so & STC.system) !== 0n)
        stc = (stc | STC.system) as STC;
    else if ((sa & STC.trusted) !== 0n)
        stc = (stc | STC.trusted) as STC;
    else if ((so & (STC.trusted | STC.safe)) === (STC.trusted | STC.safe))
        stc = (stc | STC.trusted) as STC;
    else if ((sa & STC.safe) !== 0n)
        stc = (stc | STC.safe) as STC;

    return stc;
}

/*******************************************
 * dmd/clone.d:102 — `FuncDeclaration hasIdentityOpAssign(AggregateDeclaration ad, Scope* sc)`.
 *
 * Check given aggregate actually has an identity opAssign or not.
 * Params:
 *      ad = struct or class
 *      sc = current scope
 * Returns:
 *      if found, returns FuncDeclaration of opAssign, otherwise null
 * References:
 *      https://dlang.org/spec/operatoroverloading.html#assignment
 *
 * POD note: a struct with no `opAssign` member short-circuits at `search_function` -> null, which
 * is the early exit `buildOpAssign` relies on for a plain-old-data struct.
 */
export function hasIdentityOpAssign(ad: AggregateDeclaration, sc: Scope): FuncDeclaration | null {
    const assign = search_function(ad, Id.opAssign!);
    if (assign === null)
        return null;

    /* check identity opAssign exists
     */
    const er = new NullExp(ad.loc, ad.type);          // dummy rvalue  (`scope` erased, 04 §8)
    const el = new IdentifierExp(ad.loc, Id.p!);      // dummy lvalue
    el.type = ad.type;
    const errors = global.startGagging(); // Do not report errors, even if the template opAssign fbody makes it.
    sc = sc.push();
    sc.tinst = null;
    sc.minst = null;

    let f: FuncDeclaration | null;
    // GAG/SCOPE PAIRING (11 §2.5): the region below reaches `resolveFuncCall` -> template/overload
    // resolution, which still holds walls of its own — exit paths D does not have. `global.gag` is
    // a process-global counter, so the `startGagging`/`endGagging` pair (and the matching
    // `sc.push()`/`sc.pop()`) MUST be a try/finally in the port even though dmd/clone.d:113-128
    // needs none; 11 §2.5 requires the shape for the shape, not for today's control flow. D runs
    // the two lines at the end of the try block, in this order; the finally reproduces that
    // position for both the normal and the throwing exit.
    try {
        const a: Expressions = new Array_<Expression | null>(1);
        a.opIndexAssign(er, 0);
        // dmd/funcsem.d:1905 `FuncDeclaration resolveFuncCall(Loc, Scope*, Dsymbol, Objects*, Type,
        // ArgumentList, FuncResolveFlag)` authorises the live call (funcsem.ts:2016) — the wall that
        // stood here is swept (11 §2.5).
        f = resolveFuncCall(ad.loc, sc, assign, null, ad.type, new ArgumentList(a), FuncResolveFlag.quiet);
        if (f === null) {
            a.opIndexAssign(el, 0);
            // Second D call site (dmd/clone.d:124) — same callee, same authorising D line.
            f = resolveFuncCall(ad.loc, sc, assign, null, ad.type, new ArgumentList(a), FuncResolveFlag.quiet);
        }
    } finally {
        sc = sc.pop()!; // the matching push() above guarantees an enclosing scope (never null here)
        global.endGagging(errors);
    }

    if (f === null)
        return null;
    if (f.errors)
        return null;
    const fparams = f.getParameterList();
    if (fparams.length() !== 0) {
        const fparam0 = fparams.opIndex(0);
        if (toDsymbol(fparam0!.type!, null) !== ad)
            f = null;
    }
    // BUGS: This detection mechanism cannot find some opAssign-s like follows:
    // struct S { void opAssign(ref immutable S) const; }
    return f;
}

/*******************************************
 * dmd/clone.d:154 — `private bool needOpAssign(StructDeclaration sd)`.
 *
 * We need an opAssign for the struct if it has a destructor or a postblit.
 * (We will later generate one if a user-specified one does not exist)
 * Params:
 *      sd = struct to check
 * Returns:
 *      true if an opAssign is needed
 *
 * D `private` == module visibility, so this stays a non-exported module function (01 §2.5).
 */
function needOpAssign(sd: StructDeclaration): boolean {
    //printf("StructDeclaration::needOpAssign() %s\n", sd.toChars());

    // dmd/clone.d:158 — nested `static bool isNeeded()` -> inner const arrow (04 §5).
    const isNeeded = (): boolean => {
        //printf("\tneed\n");
        return true;
    };

    if (sd.isUnionDeclaration() !== null)
        return !isNeeded();

    if (sd.hasIdentityAssign || // because has identity==elaborate opAssign
        sd.dtor !== null ||
        sd.postblit !== null)
        return isNeeded();

    /* If any of the fields need an opAssign, then we
     * need it too.
     */
    for (const v of sd.fields) {
        // `fields` slots are `VarDeclaration | null` (08 §3); clone.d:177 dereferences the element
        // with no null test, so each read is `v!` — the `!` marks exactly where D would fault.
        if ((v!.storage_class & STC.ref_) !== 0n)
            continue;
        if (v!.overlapped)              // if field of a union
            continue;                   // user must handle it themselves
        const tv = baseElemOf(v!.type!);
        const ts = tv.isTypeStruct();
        if (ts !== null) {
            if (ts.sym!.isUnionDeclaration() !== null)
                continue;
            if (needOpAssign(ts.sym!))
                return isNeeded();
        }
    }
    return !isNeeded();
}

/******************************************
 * dmd/clone.d:259 — `FuncDeclaration buildOpAssign(StructDeclaration sd, Scope* sc)`.
 *
 * Build opAssign for a `struct`. The generated `opAssign` function has the signature
 * `ref S opAssign(S s)` and is built when: (1) `S` has no identity `opAssign`; (2) `S` has a
 * postblit, a destructor, or a field with an `opAssign`; (3) `S` has no non-mutable fields.
 * With a destructor the body is a swap (`__swap = this; this = s; __swap.dtor();`), with a
 * postblit it is a single blit, otherwise it is a memberwise assignment.
 *
 * References:
 *      https://dlang.org/spec/struct.html#assign-overload
 * Params:
 *      sd = struct to generate opAssign for
 *      sc = context
 * Returns:
 *      generated `opAssign` function, or null if it is not needed
 *
 * POD note: `hasIdentityOpAssign` is null and `needOpAssign` is false, so a plain-old-data struct
 * returns null at clone.d:269 without entering the synthesis.
 */
export function buildOpAssign(sd: StructDeclaration, sc: Scope): FuncDeclaration | null {
    const fIdentity = hasIdentityOpAssign(sd, sc);
    if (fIdentity !== null) {
        sd.hasIdentityAssign = true;
        return fIdentity;
    }
    // Even if non-identity opAssign is defined, built-in identity opAssign
    // will be defined.
    if (!needOpAssign(sd))
        return null;

    //printf("StructDeclaration::buildOpAssign() %s\n", sd.toChars());
    let stc: STC = STC.safe;
    const declLoc = sd.loc;
    const loc = Loc.initial; // internal code should have no loc to prevent coverage

    // One of our sub-field might have `@disable opAssign` so we need to
    // check for it.
    // In this event, it will be reflected by having `stc` (opAssign's
    // storage class) include `STC.disabled`.
    for (const v of sd.fields) {
        if ((v!.storage_class & STC.ref_) !== 0n)
            continue;
        if (v!.overlapped)
            continue;
        const tv = baseElemOf(v!.type!);
        const tvs = tv.isTypeStruct();
        if (tvs !== null) {
            stc = mergeFuncAttrs(stc, hasIdentityOpAssign(tvs.sym!, sc));
        }
    }

    if (sd.dtor !== null || sd.postblit !== null) {
        // if the type is not assignable, we cannot generate opAssign
        if (!isAssignable(sd.type!)) // https://issues.dlang.org/show_bug.cgi?id=13044
            return null;
        stc = mergeFuncAttrs(stc, sd.dtor);
        if ((stc & STC.safe) !== 0n)
            stc = ((stc & ~STC.safe) | STC.trusted) as STC;
    }

    const fparams: Parameters = Array_.from<Parameter | null>(
        new Parameter(loc, STC.nodtor, sd.type, Id.p!, null, null));
    const tf = new TypeFunction(new ParameterList(fparams), sd.handleType(), LINK.d, (stc | STC.ref_) as STC);
    const fop = new FuncDeclaration(declLoc, Loc.initial, Id.opAssign!, stc, tf);
    fop.storage_class = (fop.storage_class | STC.inference) as STC;
    fop.isGenerated = true;
    let e: Expression | null;
    if ((stc & STC.disable) !== 0n) {
        e = null;
    }
    /* Do swap this and rhs.
     *    __swap = this; this = s; __swap.dtor();
     */
    else if (sd.dtor !== null) {
        //printf("\tswap copy\n");
        const tdtor = sd.dtor.type!.isTypeFunction();

        const idswap = Identifier.generateId(ds("__swap"));
        const swap = new VarDeclaration(loc, sd.type, idswap, new VoidInitializer(loc));
        swap.storage_class = (swap.storage_class | STC.nodtor | STC.temp | STC.ctfe) as STC;
        if (tdtor!.isScopeQual)
            swap.storage_class = (swap.storage_class | STC.scope_) as STC;
        const e1 = new DeclarationExp(loc, swap);

        const e2 = new BlitExp(loc, new VarExp(loc, swap), new ThisExp(loc));
        const e3 = new BlitExp(loc, new ThisExp(loc), new IdentifierExp(loc, Id.p!));

        let e4: Expression | null;
        if (target.isCalleeDestroyingArgs(tf)) {  // clone.d:332
            /* callee destroys s
             * Instead of running the destructor on s, run it
             * on swap.
             */
            e4 = new CallExp(loc, new DotVarExp(loc, new VarExp(loc, swap), sd.dtor, false));
        } else {
            /* caller destroys s, so copy contents of swap back into s
             */
            e4 = new BlitExp(loc, new IdentifierExp(loc, Id.p!), new VarExp(loc, swap));
        }

        e = Expression.combine(e1, e2, e3, e4);
    }
    /* postblit was called when the value was passed to opAssign, we just need to blit the result */
    else if (sd.postblit !== null) {
        e = new BlitExp(loc, new ThisExp(loc), new IdentifierExp(loc, Id.p!));
        sd.hasBlitAssign = true;
    } else {
        /* Do memberwise copy.
         *
         * If sd is a nested struct, its vthis field assignment is:
         * 1. If it's nested in a class, it's a rebind of class reference.
         * 2. If it's nested in a function or struct, it's an update of void*.
         * In both cases, it will change the parent context.
         */
        //printf("\tmemberwise copy\n");
        e = null;
        for (const v of sd.fields) {
            // this.v = s.v;
            const ec = new AssignExp(loc,
                new DotVarExp(loc, new ThisExp(loc), v!),
                new DotVarExp(loc, new IdentifierExp(loc, Id.p!), v!));
            e = Expression.combine(e, ec);
        }
    }
    if (e !== null) {
        const s1: Statement = new ExpStatement(loc, e);
        /* Add:
         *   return this;
         */
        const er = new ThisExp(loc);
        const s2: Statement = new ReturnStatement(loc, er);
        fop.fbody = CompoundStatement.create(loc, s1, s2);
        tf.isReturn = true;
    }
    sd.members!.push(fop);
    addMember(fop, sc, sd);
    sd.hasIdentityAssign = true; // temporary mark identity assignable
    const errors = global.startGagging(); // Do not report errors, even if the template opAssign fbody makes it.
    const sc2 = sc.push();
    sc2.stc = STC.none;
    sc2.linkage = LINK.d;
    // GAG PAIRING (11 §2.5): `dsymbolSemantic`/`semantic2` still hold walls of their own, so this
    // region has exit paths dmd/clone.d:387-397 does not have, and `global.gag` is process-global —
    // so the pair is a try/finally here. `endGagging`'s RESULT is read by D at this position, so it
    // is captured in the finally and tested after.
    let gaggedErrorsHappened = false;
    try {
        dsymbolSemantic(fop, sc2);
        // dmd/semantic2.d:79 `void semantic2(Dsymbol dsym, Scope* sc)` authorises the live call
        // (semantic2.ts:197) — the wall that stood here is swept (11 §2.5).
        semantic2(fop, sc2);
        // https://issues.dlang.org/show_bug.cgi?id=15044
        //semantic3(fop, sc2); // isn't run here for lazy forward reference resolution.
    } finally {
        sc2.pop();
        gaggedErrorsHappened = global.endGagging(errors);
    }
    if (gaggedErrorsHappened) { // if errors happened
        // Disable generated opAssign, because some members forbid identity assignment.
        fop.storage_class = (fop.storage_class | STC.disable) as STC;
        fop.fbody = null; // remove fbody which contains the error
    }

    //printf("-StructDeclaration::buildOpAssign() %s, errors = %d\n", sd.toChars(), (fop.storage_class & STC.disable) != 0);
    //printf("fop.type: %s\n", fop.type.toPrettyChars());
    return fop;
}

/*******************************************
 * dmd/clone.d:417 — `bool needOpEquals(StructDeclaration sd)`.
 *
 * We need an opEquals for the struct if any field has an opEquals and a user-specified one does
 * not exist.
 * Params:
 *      sd = struct to check
 * Returns:
 *      true if need to generate one
 */
export function needOpEquals(sd: StructDeclaration): boolean {
    // dmd/clone.d:419/:424 — the two nested predicates -> inner const arrows (04 §5).
    const dontneed = (): boolean => {
        //printf("\tdontneed\n");
        return false;
    };
    const need = (): boolean => {
        //printf("\tneed\n");
        return true;
    };
    //printf("StructDeclaration::needOpEquals() %s\n", sd.toChars());
    if (sd.isUnionDeclaration() !== null) {
        /* If a union has only one field, treat it like a struct
         */
        if (sd.fields.length !== 1)
            return dontneed();
    }
    if (sd.hasIdentityEquals)
        return need();
    /* If any of the fields has an opEquals, then we
     * need it too.
     */
    for (const v of sd.fields) {
        if ((v!.storage_class & STC.ref_) !== 0n)
            continue;
        if (v!.overlapped)
            continue;
        const tv = toBasetype(v!.type!);
        const tvbase = baseElemOf(tv);
        const ts = tvbase.isTypeStruct();
        if (ts !== null) {
            if (ts.sym!.isUnionDeclaration() !== null && ts.sym!.fields.length !== 1)
                continue;
            if (needOpEquals(ts.sym!))
                return need();
        }
        if (isFloating(tvbase)) {
            // This is necessray for:
            //  1. comparison of +0.0 and -0.0 should be true.
            //  2. comparison of NANs should be false always.
            return need();
        }
        if (tvbase.ty === TY.Tarray)
            return need();
        if (tvbase.ty === TY.Taarray)
            return need();
        if (tvbase.ty === TY.Tclass)
            return need();
    }
    return dontneed();
}

/*******************************************
 * dmd/clone.d:481 — `private FuncDeclaration hasIdentityOpEquals(AggregateDeclaration ad, Scope* sc)`.
 *
 * Check given aggregate actually has an identity opEquals or not.
 *      ad = aggregate to check
 *      sc = context
 * Returns:
 *      identity opEquals if it is there, null if not
 *
 * D `private` == module visibility -> non-exported module function (01 §2.5).
 */
function hasIdentityOpEquals(ad: AggregateDeclaration, sc: Scope): FuncDeclaration | null {
    let f: FuncDeclaration | null = null;
    const eq = search_function(ad, Id.opEquals!);
    if (eq === null)
        return null;

    /* check identity opEquals exists
     */
    const er = new NullExp(ad.loc, null);            // dummy rvalue (`scope` erased, 04 §8)
    const el = new IdentifierExp(ad.loc, Id.p!);     // dummy lvalue
    const a: Expressions = new Array_<Expression | null>(1);

    // dmd/clone.d:494 — nested `bool hasIt(Type tthis)` -> inner const arrow (04 §5). It captures
    // and REASSIGNS the enclosing `sc` (D's `sc = sc.push()/pop()` inside a nested function), and
    // writes the enclosing `f` — both are the D semantics verbatim.
    const hasIt = (tthis: Type | null): boolean => {
        const errors = global.startGagging(); // Do not report errors, even if the template opAssign fbody makes it
        sc = sc.push();
        sc.tinst = null;
        sc.minst = null;

        // GAG/SCOPE PAIRING (11 §2.5): `rfc` reaches `resolveFuncCall` -> overload resolution, which
        // still holds walls — exit paths dmd/clone.d:496-513 does not have. `global.gag` is
        // process-global, and the captured `sc` is rebound by the push, so both are unwound in a
        // finally at the D position. The shape is mandatory for the shape (11 §2.5), not for today.
        try {
            // dmd/clone.d:501 — nested `FuncDeclaration rfc(Expression e)` -> inner const arrow (04 §5).
            const rfc = (e: Expression): FuncDeclaration | null => {
                a.opIndexAssign(e, 0);
                a.opIndex(0)!.type = tthis;
                // dmd/funcsem.d:1905 authorises the live `resolveFuncCall` (funcsem.ts:2016) — the
                // wall that stood here is swept (11 §2.5).
                return resolveFuncCall(ad.loc, sc, eq, null, tthis, new ArgumentList(a), FuncResolveFlag.quiet);
            };

            f = rfc(er);
            if (f === null)
                f = rfc(el);
        } finally {
            sc = sc.pop()!; // the matching push() above guarantees an enclosing scope (never null here)
            global.endGagging(errors);
        }

        return f !== null;
    };

    if (hasIt(ad.type) ||
        hasIt(constOf(ad.type!)) ||
        hasIt(immutableOf(ad.type!)) ||
        hasIt(sharedOf(ad.type!)) ||
        hasIt(sharedConstOf(ad.type!))) {
        if (f!.errors)
            return null;
    }

    return f;
}

/******************************************
 * dmd/clone.d:541 — `FuncDeclaration buildOpEquals(StructDeclaration sd, Scope* sc)`.
 *
 * Build opEquals for struct: `const bool opEquals(const S s) { ... }`.
 *
 * By fixing https://issues.dlang.org/show_bug.cgi?id=3789 opEquals is changed to be never
 * implicitly generated. Now, struct objects comparison s1 == s2 is translated to
 * `s1.tupleof == s2.tupleof` to calculate structural equality. See `opOverloadEquals`.
 *
 * So this only DETECTS a user identity opEquals (setting `sd.hasIdentityEquals`) and always
 * returns null.
 */
export function buildOpEquals(sd: StructDeclaration, sc: Scope): FuncDeclaration | null {
    if (hasIdentityOpEquals(sd, sc) !== null) {
        sd.hasIdentityEquals = true;
    }
    return null;
}

/******************************************
 * dmd/clone.d:560 — `FuncDeclaration buildXopEquals(StructDeclaration sd, Scope* sc)`.
 *
 * Build __xopEquals for TypeInfo_Struct:
 *      bool __xopEquals(ref const S p) const { return this == p; }
 *
 * This is called by TypeInfo.equals(p1, p2). If the struct does not support const objects
 * comparison, it will throw "not implemented" Error in runtime.
 */
export function buildXopEquals(sd: StructDeclaration, sc: Scope): FuncDeclaration | null {
    if (!needOpEquals(sd))
        return null; // bitwise comparison would work

    //printf("StructDeclaration::buildXopEquals() %s\n", sd.toChars());
    // dmd/clone.d:566 — declaration in a condition -> hoist, then test (06 §2.6/§2.7).
    const eq = search_function(sd, Id.opEquals!);
    if (eq !== null) {
        const fd0 = eq.isFuncDeclaration();
        if (fd0 !== null) {
            let tfeqptr: TypeFunction | null;
            {
                const scx = new Scope(); // D `Scope scx;` — a default-constructed stack Scope
                scx.eSink = sc.eSink;
                /* const bool opEquals(ref const S s);
                 */
                const parameters: Parameters = Array_.from<Parameter | null>(
                    new Parameter(Loc.initial, (STC.ref_ | STC.const_) as STC, sd.type, null, null, null));
                tfeqptr = new TypeFunction(new ParameterList(parameters), Type.tbool, LINK.d);
                tfeqptr.mod = MODFlags.const_;
                tfeqptr = typeSemantic(tfeqptr, Loc.initial, scx).isTypeFunction();
            }
            // dmd/funcsem.d:2444 `FuncDeclaration overloadExactMatch(FuncDeclaration thisfd, Type t)`
            // authorises the live call (funcsem.ts:2604) — the wall that stood here is swept (11 §2.5).
            // `tfeqptr!`: D's `isTypeFunction()` is nullable in the port's typing only; the two lines
            // above built the TypeFunction, and D passes the result unchecked.
            const fd = overloadExactMatch(fd0, tfeqptr!);
            if (fd !== null)
                return fd;
        }
    }
    if (StructDeclaration.xerreq === null) { // D `sd.xerreq` — a `__gshared` static (dstruct.d:47)
        // object._xopEquals
        const id0 = Identifier.idPool(ds("_xopEquals"));
        let e: Expression = new IdentifierExp(sd.loc, Id.empty!);
        e = new DotIdExp(sd.loc, e, Id.object!);
        e = new DotIdExp(sd.loc, e, id0);
        e = expressionSemantic(e, sc);
        if (e.isErrorExp() === null) {
            // dmd/expressionsem.d:5260 `Dsymbol getDsymbol(RootObject oarg)` authorises the live call
            // (expressionsem.ts:6052) — the wall that stood here is swept (11 §2.5).
            const s = getDsymbol(e);
            assert(s !== null);
            StructDeclaration.xerreq = s!.isFuncDeclaration();
        }
    }
    const declLoc = Loc.initial; // loc is unnecessary so __xopEquals is never called directly
    const loc = Loc.initial;     // loc is unnecessary so errors are gagged
    const parameters: Parameters = Array_.from<Parameter | null>(
        new Parameter(loc, (STC.ref_ | STC.const_) as STC, sd.type, Id.p!, null, null));
    let tf = new TypeFunction(new ParameterList(parameters), Type.tbool, LINK.d, STC.const_);
    tf = addSTC(tf, STC.const_).toTypeFunction();
    const id = Id.xopEquals!;
    let fop: FuncDeclaration | null = new FuncDeclaration(declLoc, Loc.initial, id, STC.none, tf);
    fop.isGenerated = true;
    fop.parent = sd;
    const e1: Expression = new IdentifierExp(loc, Id.This!);
    const e2: Expression = new IdentifierExp(loc, Id.p!);
    const e: Expression = new EqualExp(EXP.equal, loc, e1, e2);
    fop.fbody = new ReturnStatement(loc, e);
    const errors = global.startGagging(); // Do not report errors
    const sc2 = sc.push();
    sc2.stc = STC.none;
    sc2.linkage = LINK.d;
    // GAG PAIRING (11 §2.5): `dsymbolSemantic`/`semantic2` still hold walls, so this region has exit
    // paths dmd/clone.d:615-622 does not have and `global.gag` is process-global — the pair is a
    // try/finally in the port.
    let gaggedErrorsHappened = false;
    try {
        dsymbolSemantic(fop, sc2);
        // dmd/semantic2.d:79 authorises the live `semantic2` (semantic2.ts:197) — swept (11 §2.5).
        semantic2(fop, sc2);
    } finally {
        sc2.pop();
        gaggedErrorsHappened = global.endGagging(errors);
    }
    if (gaggedErrorsHappened) // if errors happened
        fop = StructDeclaration.xerreq;
    return fop;
}

/******************************************
 * dmd/clone.d:637 — `FuncDeclaration buildXopCmp(StructDeclaration sd, Scope* sc)`.
 *
 * Build __xopCmp for TypeInfo_Struct:
 *      int __xopCmp(ref const S p) const { return this.opCmp(p); }
 *
 * This is called by TypeInfo.compare(p1, p2). If the struct does not support const objects
 * comparison, it will throw "not implemented" Error in runtime.
 */
export function buildXopCmp(sd: StructDeclaration, sc: Scope): FuncDeclaration | null {
    //printf("StructDeclaration::buildXopCmp() %s\n", toChars());
    // dmd/clone.d:640 — declaration in a condition -> hoist, then test (06 §2.6/§2.7).
    const cmp = search_function(sd, Id.opCmp!);
    if (cmp !== null) {
        const fd = cmp.isFuncDeclaration();
        if (fd !== null) {
            let tfcmpptr: TypeFunction | null;
            {
                const scx = new Scope(); // D `Scope scx;` — a default-constructed stack Scope
                scx.eSink = sc.eSink;
                /* const int opCmp(ref const S s);
                 */
                const parameters: Parameters = Array_.from<Parameter | null>(
                    new Parameter(Loc.initial, (STC.ref_ | STC.const_) as STC, sd.type, null, null, null));
                tfcmpptr = new TypeFunction(new ParameterList(parameters), Type.tint32, LINK.d);
                tfcmpptr.mod = MODFlags.const_;
                tfcmpptr = typeSemantic(tfcmpptr, Loc.initial, scx).isTypeFunction();
            }
            // dmd/funcsem.d:2444 authorises the live `overloadExactMatch` (funcsem.ts:2604) — swept
            // (11 §2.5). `tfcmpptr!` for the same reason as at dmd/clone.d:582.
            const fdo = overloadExactMatch(fd, tfcmpptr!);
            if (fdo !== null)
                return fdo;
        }
    } else {
        // resolved: `version (none)` (dmd/clone.d:662, "FIXME: doesn't work for recursive alias
        // this") is OFF in the fixed world (07 §1.2), so its `else` arm is the live one. The dead
        // arm's DsymbolExp / DotIdExp / trySemantic / EXP.overloadSet-scope_-variable switch is
        // dropped with this comment.
        return null;
    }
    if (StructDeclaration.xerrcmp === null) { // D `sd.xerrcmp` — a `__gshared` static (dstruct.d:48)
        // object._xopCmp
        const id0 = Identifier.idPool(ds("_xopCmp"));
        let e: Expression = new IdentifierExp(sd.loc, Id.empty!);
        e = new DotIdExp(sd.loc, e, Id.object!);
        e = new DotIdExp(sd.loc, e, id0);
        e = expressionSemantic(e, sc);
        if (e.isErrorExp() === null) {
            // dmd/expressionsem.d:5260 authorises the live `getDsymbol` (expressionsem.ts:6052) —
            // swept (11 §2.5).
            const s = getDsymbol(e);
            assert(s !== null);
            StructDeclaration.xerrcmp = s!.isFuncDeclaration();
        }
    }
    const declLoc = Loc.initial; // loc is unnecessary so __xopCmp is never called directly
    const loc = Loc.initial;     // loc is unnecessary so errors are gagged
    const parameters: Parameters = Array_.from<Parameter | null>(
        new Parameter(loc, (STC.ref_ | STC.const_) as STC, sd.type, Id.p!, null, null));
    let tf = new TypeFunction(new ParameterList(parameters), Type.tint32, LINK.d, STC.const_);
    tf = addSTC(tf, STC.const_).toTypeFunction();
    const id = Id.xopCmp!;
    let fop: FuncDeclaration | null = new FuncDeclaration(declLoc, Loc.initial, id, STC.none, tf);
    fop.isGenerated = true;
    fop.parent = sd;
    const e1: Expression = new IdentifierExp(loc, Id.This!);
    const e2: Expression = new IdentifierExp(loc, Id.p!);
    const e: Expression = CallExp.fromArg(loc, new DotIdExp(loc, e1, Id.opCmp!), e2);
    fop.fbody = new ReturnStatement(loc, e);
    const errors = global.startGagging(); // Do not report errors
    const sc2 = sc.push();
    sc2.stc = STC.none;
    sc2.linkage = LINK.d;
    // GAG PAIRING (11 §2.5): `dsymbolSemantic`/`semantic2` still hold walls, so this region has exit
    // paths dmd/clone.d:738-745 does not have and `global.gag` is process-global — the pair is a
    // try/finally in the port.
    let gaggedErrorsHappened = false;
    try {
        dsymbolSemantic(fop, sc2);
        // dmd/semantic2.d:79 authorises the live `semantic2` (semantic2.ts:197) — swept (11 §2.5).
        semantic2(fop, sc2);
    } finally {
        sc2.pop();
        gaggedErrorsHappened = global.endGagging(errors);
    }
    if (gaggedErrorsHappened) // if errors happened
        fop = StructDeclaration.xerrcmp;
    return fop;
}

/*******************************************
 * dmd/clone.d:761 — `private bool needToHash(StructDeclaration sd)`.
 *
 * We need a toHash for the struct if any fields has a toHash.
 * (will generate one if a user-specified one does not exist)
 * Params:
 *      sd = struct to check
 * Returns:
 *      need to generate toHash()
 * References:
 *   https://dlang.org/spec/hash-map.html#using_struct_as_key
 *
 * D `private` == module visibility -> non-exported module function (01 §2.5).
 */
function needToHash(sd: StructDeclaration): boolean {
    // dmd/clone.d:763/:768 — the two nested predicates -> inner const arrows (04 §5).
    const dontneed = (): boolean => {
        //printf("\tdontneed\n");
        return false;
    };
    const need = (): boolean => {
        //printf("\tneed\n");
        return true;
    };
    //printf("StructDeclaration::needToHash() %s\n", sd.toChars());
    if (sd.isUnionDeclaration() !== null)
        return dontneed();
    if (sd.xhash !== null)
        return need();

    /* If any of the fields has an toHash, then we
     * need it too.
     */
    for (const v of sd.fields) {
        if ((v!.storage_class & STC.ref_) !== 0n)
            continue;
        if (v!.overlapped)
            continue;
        const tv = toBasetype(v!.type!);
        const tvbase = baseElemOf(tv);
        const ts = tvbase.isTypeStruct();
        if (ts !== null) {
            if (ts.sym!.isUnionDeclaration() !== null)
                continue;
            if (needToHash(ts.sym!))
                return need();
        }
        if (isFloating(tvbase)) {
            /* This is necessary because comparison of +0.0 and -0.0 should be true,
             * i.e. not a bit compare.
             */
            return need();
        }
        if (tvbase.ty === TY.Tarray)
            return need();
        if (tvbase.ty === TY.Taarray)
            return need();
        if (tvbase.ty === TY.Tclass)
            return need();
    }
    return dontneed();
}

// dmd/clone.d:822 — `__gshared TypeFunction tftohash;`, a function-local process-global inside
// `buildXtoHash`. D `__gshared` is one slot for the whole process, so it is emitted as module
// state (01 §5) here rather than as a function-body `let` (which would reset on every call).
let tftohash: TypeFunction | null = null;

/**
 * No D counterpart (01 §5.5 rule 3): called by the test harness and by the djs driver between two
 * compiles in one process (src/djs.ts `deinitializeFrontend`), never by frontend code.
 *
 * `tftohash` is interned into `Type.stringtable` by its `merge()`, and `Type._init()` REPLACES that
 * table wholesale. D is a one-shot process so the cache can never outlive its table; a second
 * `Type._init()` in one process (a vitest `beforeEach`, the driver's next compile) would leave the
 * cached `TypeFunction` interned in a discarded table and hand it to the next `buildXtoHash`.
 */
export function _resetTfToHash(): void {
    tftohash = null;
}

/******************************************
 * dmd/clone.d:818 — `FuncDeclaration buildXtoHash(StructDeclaration sd, Scope* sc)`.
 *
 * Build __xtoHash for non-bitwise hashing:
 *      static hash_t xtoHash(ref const S p) nothrow @trusted;
 */
export function buildXtoHash(sd: StructDeclaration, sc: Scope): FuncDeclaration | null {
    // dmd/clone.d:820 — declaration in a condition -> hoist, then test (06 §2.6/§2.7).
    const s0 = search_function(sd, Id.tohash!);
    if (s0 !== null) {
        if (tftohash === null) {
            tftohash = new TypeFunction(new ParameterList(null), Type.thash_t, LINK.d);
            tftohash.mod = MODFlags.const_;
            tftohash = merge(tftohash).isTypeFunction();
        }
        const fd = s0.isFuncDeclaration();
        if (fd !== null) {
            // dmd/funcsem.d:2444 authorises the live `overloadExactMatch` (funcsem.ts:2604) — swept
            // (11 §2.5). `tftohash!` for the same reason as at dmd/clone.d:582.
            const fdo = overloadExactMatch(fd, tftohash!);
            if (fdo !== null)
                return fdo;
        }
    }
    if (!needToHash(sd))
        return null;

    /* The trouble is that the following code relies on .tupleof, but .tupleof
     * is not allowed for C files. If we allow it for C files, then that turns on
     * the other D properties, too, such as .dup which will then conflict with allowed
     * field names.
     * One way to fix it is to replace the following foreach and .tupleof with C
     * statements and expressions.
     * But, it's debatable whether C structs should even need toHash().
     * Note that it would only be necessary if it has floating point fields.
     * For now, we'll just not generate a toHash() for C files.
     */
    if (sc.inCfile)
        return null;

    //printf("StructDeclaration::buildXtoHash() %s\n", sd.toPrettyChars());
    const declLoc = Loc.initial; // loc is unnecessary so __xtoHash is never called directly
    const loc = Loc.initial;     // internal code should have no loc to prevent coverage
    const parameters: Parameters = Array_.from<Parameter | null>(
        new Parameter(loc, (STC.ref_ | STC.const_) as STC, sd.type, Id.p!, null, null));
    const tf = new TypeFunction(new ParameterList(parameters), Type.thash_t, LINK.d,
        (STC.nothrow_ | STC.trusted) as STC);
    const id = Id.xtoHash!;
    const fop = new FuncDeclaration(declLoc, Loc.initial, id, STC.static_, tf);
    fop.isGenerated = true;

    /* Do memberwise hashing.
     *
     * If sd is a nested struct, and if it's nested in a class, the calculated
     * hash value will also contain the result of parent class's toHash().
     */
    const code = ds(
        ".object.size_t h = 0;" +
        "foreach (i, T; typeof(p.tupleof))" +
        // workaround https://issues.dlang.org/show_bug.cgi?id=17968
        "    static if(is(T* : const(.object.Object)*)) " +
        "        h = h * 33 + typeid(const(.object.Object)).getHash(cast(const void*)&p.tupleof[i]);" +
        // and another workaround for bitfields https://github.com/dlang/dmd/issues/20473
        "    else static if (!__traits(compiles, &p.tupleof[i])) {" +
        "        auto t = p.tupleof[i];" +
        "        h = h * 33 + typeid(T).getHash(cast(const void*)&t);" +
        "    } " +
        "    else " +
        "        h = h * 33 + typeid(T).getHash(cast(const void*)&p.tupleof[i]);" +
        "return h;");
    // The `const(char)[]` literal is USER-LEVEL D source handed to a MixinStatement — not a
    // construct this port resolves (07 §11 is about `mixin` in the FRONTEND'S own source). It is
    // carried verbatim as StringExp payload bytes (`number[]`, expression.ts:1030).
    fop.fbody = MixinStatement.fromExpression(loc, new StringExp(loc, [...code]));
    const sc2 = sc.push();
    sc2.stc = STC.none;
    sc2.linkage = LINK.d;
    // SCOPE PAIRING (11 §2.5): unlike its three siblings D does NOT gag this region, but
    // `sc.push()`/`sc2.pop()` is still a pair whose release mutates state that outlives a throw
    // (`Scope.pop` folds `ctorflow` back into the enclosing scope — 11 §2.5 rule (d)), and
    // `dsymbolSemantic`/`semantic2` still hold walls. D releases at the region's end and consumes
    // no return value, so the shape is a plain try/finally.
    try {
        dsymbolSemantic(fop, sc2);
        // dmd/semantic2.d:79 authorises the live `semantic2` (semantic2.ts:197) — swept (11 §2.5).
        semantic2(fop, sc2);
    } finally {
        sc2.pop();
    }

    //printf("%s fop = %s %s\n", sd.toChars(), fop.toChars(), fop.type.toChars());
    return fop;
}

/*****************************************
 * dmd/clone.d:903 — `void buildDtors(AggregateDeclaration ad, Scope* sc)`.
 *
 * Create aggregate destructor for struct/class by aggregating all the destructors in userDtors[]
 * with the destructors for all the members.
 * Sets ad's fieldDtor, aggrDtor, dtor and tidtor fields.
 * Params:
 *      ad = struct or class to build destructor for
 *      sc = context
 * Note:
 * Close similarity with StructDeclaration::buildPostBlit(), and the ordering changes (runs
 * backward instead of forwards).
 *
 * POD note: no user dtor and no struct-typed field means `e` stays null, `dtors` stays empty
 * (switch case 0), `ad.aggrDtor`/`ad.dtor` stay null and `buildExternDDtor` returns null at its
 * first line — so `ad.tidtor` stays null too. No wall is on that path.
 */
export function buildDtors(ad: AggregateDeclaration, sc: Scope): void {
    //printf("AggregateDeclaration::buildDtor() %s\n", ad.toChars());
    if (ad.isUnionDeclaration() !== null)
        return;                    // unions don't have destructors

    let stc: STC = (STC.safe | STC.nothrow_ | STC.pure_ | STC.nogc) as STC;
    const declLoc = ad.userDtors.length !== 0 ? ad.userDtors.opIndex(0)!.loc : ad.loc;
    const loc = Loc.initial; // internal code should have no loc to prevent coverage
    let xdtor_fwd: FuncDeclaration | null = null;

    // Build the field destructor (`ad.fieldDtor`), if needed.
    // If the user dtor is an extern(C++) prototype, then we expect it performs a full-destruction and skip building.
    const dtorIsCppPrototype: boolean = ad.userDtors.length !== 0
        && ad.userDtors.opIndex(0)!._linkage === LINK.cpp
        && ad.userDtors.opIndex(0)!.fbody === null;
    if (!dtorIsCppPrototype) {
        let e: Expression | null = null;
        for (let i = 0; i < ad.fields.length; i++) {
            // `fields` slots are `VarDeclaration | null` (08 §3); clone.d:922 dereferences with no
            // null test, so each read is `v!`.
            const v = ad.fields.opIndex(i)!;
            if ((v.storage_class & STC.ref_) !== 0n)
                continue;
            if (v.overlapped)
                continue;
            const tvs = baseElemOf(v.type!).isTypeStruct();
            if (tvs === null)
                continue;
            const sdv = tvs.sym!;
            if (sdv.dtor === null)
                continue;

            // fix: https://issues.dlang.org/show_bug.cgi?id=17257
            // braces for shrink wrapping scope of a
            {
                xdtor_fwd = sdv.dtor; // this dtor is temporary it could be anything
                const a = AliasDeclaration.fromDsymbol(Loc.initial, Id.__xdtor!, xdtor_fwd);
                addMember(a, sc, ad); // temporarily add to symbol table
            }

            functionSemantic(sdv.dtor);

            stc = mergeFuncAttrs(stc, sdv.dtor);
            if ((stc & STC.disable) !== 0n) {
                e = null;
                break;
            }

            let ex: Expression;
            const tv = toBasetype(v.type!);
            if (tv.isTypeStruct() !== null) {
                // this.v.__xdtor()

                ex = new ThisExp(loc);
                ex = new DotVarExp(loc, ex, v);

                // This is a hack so we can call destructors on const/immutable objects.
                // Do it as a type 'paint', `cast()`
                ex = CastExp.fromMod(loc, ex, MODFlags.none);
                if ((stc & STC.safe) !== 0n)
                    stc = ((stc & ~STC.safe) | STC.trusted) as STC;

                ex = new DotVarExp(loc, ex, sdv.dtor, false);
                ex = new CallExp(loc, ex);
            } else {
                // __ArrayDtor((cast(S*)this.v.ptr)[0 .. n])

                // dmd/typesem.d:9329 `uint numberOfElems(Type t, Loc loc)` authorises the live call
                // (typesem.ts:9726) — the wall that stood here is swept (11 §2.5). typesem's own body
                // still walls `toUInteger` (expressionsem.d:223) for a static-array dim, so this path
                // halts one D level deeper now.
                const n = numberOfElems(tv, loc);
                if (n === 0)
                    continue;

                ex = new ThisExp(loc);
                ex = new DotVarExp(loc, ex, v);

                // This is a hack so we can call destructors on const/immutable objects.
                ex = new DotIdExp(loc, ex, Id.ptr!);
                ex = new CastExp(loc, ex, pointerTo(sdv.type!));
                if ((stc & STC.safe) !== 0n)
                    stc = ((stc & ~STC.safe) | STC.trusted) as STC;

                const se = new SliceExp(loc, ex, new IntegerExp(loc, 0n, Type.tsize_t),
                                        new IntegerExp(loc, BigInt(n), Type.tsize_t));
                // Prevent redundant bounds check
                se.upperIsInBounds = true;
                se.lowerIsLessThanUpper = true;

                ex = CallExp.fromArg(loc, new IdentifierExp(loc, Id.__ArrayDtor!), se);
            }
            e = Expression.combine(ex, e); // combine in reverse order
        }

        if (e !== null || (stc & STC.disable) !== 0n) {
            //printf("Building __fieldDtor(), %s\n", e.toChars());
            const dd = new DtorDeclaration(declLoc, Loc.initial, stc, Id.__fieldDtor!);
            dd.isGenerated = true;
            dd.storage_class = (dd.storage_class | STC.inference) as STC;
            dd.fbody = new ExpStatement(loc, e);
            ad.members!.push(dd);
            dsymbolSemantic(dd, sc);
            ad.fieldDtor = dd;
        }
    }

    // Generate list of dtors to call in that order
    const dtors: DtorDeclarations = new Array_<DtorDeclaration | null>();
    // dmd/clone.d:1012 — `foreach_reverse (userDtor; ad.userDtors[])` -> descending counter over
    // the explicit slice (06 §2).
    const userDtorsSlice = ad.userDtors.opSlice();
    for (let i = userDtorsSlice.length - 1; i >= 0; i--) {
        const userDtor = userDtorsSlice[i];
        dtors.push(userDtor);
    }
    if (ad.fieldDtor !== null)
        dtors.push(ad.fieldDtor);
    if (!dtorIsCppPrototype) {
        // extern(C++) destructors call into super to destruct the full hierarchy
        const cldec: ClassDeclaration | null = ad.isClassDeclaration();
        if (cldec !== null && cldec.classKind === ClassKind.cpp && cldec.baseClass !== null
            && cldec.baseClass.aggrDtor !== null)
            dtors.push(cldec.baseClass.aggrDtor);
    }

    // Set/build `ad.aggrDtor`
    switch (dtors.length) {
    case 0:
        break;

    case 1:
        // Use the single existing dtor directly as aggregate dtor.
        // Note that this might be `cldec.baseClass.aggrDtor`.
        ad.aggrDtor = dtors.opIndex(0);
        break;

    default: {
        // Build the aggregate destructor, calling all dtors in order.
        assert(!dtorIsCppPrototype);
        let e: Expression | null = null;
        e = null;
        stc = (STC.safe | STC.nothrow_ | STC.pure_ | STC.nogc) as STC;
        for (const fd of dtors) {
            stc = mergeFuncAttrs(stc, fd);
            if ((stc & STC.disable) !== 0n) {
                e = null;
                break;
            }
            let ex: Expression = new ThisExp(loc);
            ex = new DotVarExp(loc, ex, fd!, false);
            const ce = new CallExp(loc, ex);
            ce.directcall = true;
            e = Expression.combine(e, ce);
        }
        const dd = new DtorDeclaration(declLoc, Loc.initial, stc, Id.__aggrDtor!);
        dd.isGenerated = true;
        dd.storage_class = (dd.storage_class | STC.inference) as STC;
        dd.fbody = new ExpStatement(loc, e);
        ad.members!.push(dd);
        dsymbolSemantic(dd, sc);
        ad.aggrDtor = dd;
        break;
    }
    }

    // Set/build `ad.dtor`.
    // On Windows, the dtor in the vtable is a shim with different signature.
    ad.dtor = (ad.aggrDtor !== null && ad.aggrDtor._linkage === LINK.cpp && !target.cpp.twoDtorInVtable)
        ? buildWindowsCppDtor(ad, ad.aggrDtor!, sc)
        : ad.aggrDtor;

    // Add an __xdtor alias to make `ad.dtor` accessible
    if (ad.dtor !== null) {
        const _alias = AliasDeclaration.fromDsymbol(Loc.initial, Id.__xdtor!, ad.dtor);
        dsymbolSemantic(_alias, sc);
        ad.members!.push(_alias);
        if (xdtor_fwd !== null)
            ad.symtab!.update(_alias); // update forward dtor to correct one
        else
            addMember(_alias, sc, ad); // add to symbol table
    }

    // Set/build `ad.tidtor`
    ad.tidtor = buildExternDDtor(ad, sc);
}

/**
 * dmd/clone.d:1100 — `private DtorDeclaration buildWindowsCppDtor(AggregateDeclaration ad,
 * DtorDeclaration dtor, Scope* sc)`.
 *
 * build a shim function around the compound dtor that accepts an argument that is used to
 * implement the deleting C++ destructor
 *
 * Params:
 *  ad = the aggregate that contains the destructor to wrap
 *  dtor = the destructor to wrap
 *  sc = the scope in which to analyze the new function
 *
 * Returns:
 *  the shim destructor, semantically analyzed and added to the class as a member
 *
 * D `private` == module visibility -> non-exported module function (01 §2.5).
 */
function buildWindowsCppDtor(ad: AggregateDeclaration, dtor: DtorDeclaration, sc: Scope): DtorDeclaration {
    const cldec = ad.isClassDeclaration();
    if (cldec === null || cldec.cppDtorVtblIndex === -1) // scalar deleting dtor not built for non-virtual dtors
        return dtor;    // perhaps also do this if STC.scope_ is set

    // generate deleting C++ destructor corresponding to:
    // void* C::~C(int del)
    // {
    //   this->~C();
    //   // TODO: if (del) delete (char*)this;
    //   return (void*) this;
    // }
    const delparam = new Parameter(Loc.initial, STC.none, Type.tuns32, Identifier.idPool(ds("del")),
        new IntegerExp(dtor.loc, 0n, Type.tuns32), null);
    const params: Parameters = new Array_<Parameter | null>();
    params.push(delparam);
    const stc = (dtor.storage_class & ~STC.scope_) as STC; // because we add the `return this;` later
    const ftype = new TypeFunction(new ParameterList(params), Type.tvoidptr, LINK.cpp, stc);
    const func = new DtorDeclaration(dtor.loc, dtor.loc, stc, Id.cppdtor!);
    func.type = ftype;

    // Always generate the function with body, because it is not exported from DLLs.
    const loc = dtor.loc;
    const stmts: Statements = new Array_<Statement | null>();
    const call = CallExp.fromFunc(loc, dtor, null);
    call.directcall = true;
    stmts.push(new ExpStatement(loc, call));
    stmts.push(new ReturnStatement(loc, new CastExp(loc, new ThisExp(loc), Type.tvoidptr)));
    func.fbody = new CompoundStatement(loc, stmts);
    func.isGenerated = true;

    const sc2 = sc.push();
    sc2.stc = (sc2.stc & ~STC.static_) as STC; // not a static destructor
    sc2.linkage = LINK.cpp;

    ad.members!.push(func);
    addMember(func, sc2, ad);
    dsymbolSemantic(func, sc2);

    sc2.pop();
    return func;
}

/**
 * dmd/clone.d:1154 — `private DtorDeclaration buildExternDDtor(AggregateDeclaration ad, Scope* sc)`.
 *
 * build a shim function around the aggregate dtor that translates a C++ destructor to a destructor
 * with extern(D) calling convention
 *
 * Params:
 *  ad = the aggregate that contains the destructor to wrap
 *  sc = the scope in which to analyze the new function
 *
 * Returns:
 *  the shim destructor, semantically analyzed and added to the class as a member
 *
 * D `private` == module visibility -> non-exported module function (01 §2.5).
 */
function buildExternDDtor(ad: AggregateDeclaration, sc: Scope): DtorDeclaration | null {
    const dtor = ad.aggrDtor;
    if (dtor === null)
        return null;

    // Don't try to call `@disable`d dtors
    if ((dtor.storage_class & STC.disable) !== 0n)
        return null;

    // Generate shim only when ABI incompatible on target platform
    if (dtor._linkage !== LINK.cpp || !target.cpp.wrapDtorInExternD)
        return dtor;

    // generate member function that adjusts calling convention
    // (EAX used for 'this' instead of ECX on Windows/stack on others):
    // extern(D) void __ticppdtor()
    // {
    //     Class.__dtor();
    // }
    const ftype = new TypeFunction(new ParameterList(null), Type.tvoid, LINK.d, dtor.storage_class);
    const func = new DtorDeclaration(dtor.loc, dtor.loc, dtor.storage_class, Id.ticppdtor!);
    func.type = ftype;

    const call = CallExp.fromFunc(dtor.loc, dtor, null);
    call.directcall = true;                   // non-virtual call Class.__dtor();
    func.fbody = new ExpStatement(dtor.loc, call);
    func.isGenerated = true;
    func.storage_class = (func.storage_class | STC.inference) as STC;

    const sc2 = sc.push();
    sc2.stc = (sc2.stc & ~STC.static_) as STC; // not a static destructor
    sc2.linkage = LINK.d;

    ad.members!.push(func);
    addMember(func, sc2, ad);
    dsymbolSemantic(func, sc2);
    functionSemantic(func); // to infer attributes

    sc2.pop();
    return func;
}

/******************************************
 * dmd/clone.d:1215 — `FuncDeclaration buildInv(AggregateDeclaration ad, Scope* sc)`.
 *
 * Create inclusive invariant for struct/class by aggregating all the invariants in invs[].
 * ---
 * void __invariant() const [pure nothrow @trusted]
 * {
 *     invs[0](), invs[1](), ...;
 * }
 * ---
 * Params:
 *      ad = aggregate for creating invariant
 *      sc = context
 * Returns:
 *      generated invariant, null if not needed
 * References:
 * https://dlang.org/spec/class.html#invariants
 * https://dlang.org/spec/struct.html#Invariant
 */
export function buildInv(ad: AggregateDeclaration, sc: Scope): FuncDeclaration | null {
    // dmd/clone.d:1224 — `case 1: goto default;`. The default arm's body is extracted into a
    // closure and CALLED from both arms (06 §3.6(b)); it ends in a `return`, so the closure
    // returns the value and each site returns it — the jump is reproduced, not narrated.
    const defaultArm = (): FuncDeclaration | null => {
        let e: Expression | null = null;
        let stcx: STC = STC.none;
        let stc: STC = (STC.safe | STC.nothrow_ | STC.pure_ | STC.nogc) as STC;
        // dmd/clone.d:1230 — `foreach (i, inv; ad.invs)` over a container VALUE (06 §1.2/§1.9).
        for (const [i, inv] of ad.invs.opSlice().entries()) {
            stc = mergeFuncAttrs(stc, inv);
            if ((stc & STC.disable) !== 0n) {
                // What should do?
            }
            const stcy: STC = ((inv!.storage_class & STC.synchronized_) |
                              ((inv!.type!.mod & MODFlags.shared_) !== 0 ? STC.shared_ : STC.none)) as STC;
            if (i === 0)
                stcx = stcy;
            else if ((stcx ^ stcy) !== 0n) {
                // resolved: `version (all)` (dmd/clone.d:1243) is ON, so its body is emitted
                // unconditionally (07 §1) — currently rejects.
                error(inv!.loc, ds("%s `%s` mixing invariants with different `shared`/`synchronized` qualifiers is not supported"),
                    ad.kind(), ad.toPrettyChars());
                e = null;
                break;
            }
            e = Expression.combine(e, new CallExp(Loc.initial, new VarExp(Loc.initial, inv!, false)));
        }
        const inv = new InvariantDeclaration(ad.loc, Loc.initial, (stc | stcx) as STC,
            Id.classInvariant!, new ExpStatement(Loc.initial, e));
        ad.members!.push(inv);
        dsymbolSemantic(inv, sc);
        return inv;
    };

    switch (ad.invs.length) {
    case 0:
        return null;

    case 1:
        // Don't return invs[0] so it has uniquely generated name.
        return defaultArm(); // D: `goto default;`

    default:
        return defaultArm();
    }
}

/*****************************************
 * dmd/clone.d:1273 — `FuncDeclaration buildPostBlit(StructDeclaration sd, Scope* sc)`.
 *
 * Create inclusive postblit for struct by aggregating all the postblits in postblits[] with the
 * postblits for all the members.
 * Note the close similarity with AggregateDeclaration::buildDtor(), and the ordering changes
 * (runs forward instead of backwards).
 * Params:
 *      sd = struct to create postblit for
 *      sc = context
 * Returns:
 *      generated postblit, or null if not
 *
 * POD note: no user postblit and no struct-typed field leaves `postblitCalls` empty, so no
 * `__fieldPostblit` is built, the `sd.postblits.length` switch takes case 0, and the function
 * returns null. No wall is on that path.
 */
export function buildPostBlit(sd: StructDeclaration, sc: Scope): FuncDeclaration | null {
    //printf("buildPostBlit() %s\n", sd.toChars());
    if (sd.isUnionDeclaration() !== null)
        return null;

    const hasUserDefinedPosblit: boolean =
        (sd.postblits.length !== 0 && !sd.postblits.opIndex(0)!.isDisabled()) ? true : false;

    // by default, the storage class of the created postblit
    let stc: STC = STC.safe;
    const declLoc = sd.postblits.length !== 0 ? sd.postblits.opIndex(0)!.loc : sd.loc;
    const loc = Loc.initial; // internal code should have no loc to prevent coverage

    // if any of the postblits are disabled, then the generated postblit
    // will be disabled
    for (const postblit of sd.postblits)
        stc = (stc | (postblit!.storage_class & STC.disable)) as STC;

    // D `VarDeclaration[] fieldsToDestroy;` — a null slice. Only `.length` and `~=`/`= []` are
    // used (never slice truthiness, 06 §2.8), so an empty JS array reproduces it exactly.
    let fieldsToDestroy: VarDeclaration[] = [];
    const postblitCalls: Statements = new Array_<Statement | null>();
    // iterate through all the struct fields that are not disabled
    for (let i = 0; i < sd.fields.length && (stc & STC.disable) === 0n; i++) {
        // `fields` slots are `VarDeclaration | null` (08 §3); clone.d:1296 dereferences with no
        // null test, so the read is `!`.
        const structField = sd.fields.opIndex(i)!;
        if ((structField.storage_class & STC.ref_) !== 0n)
            continue;
        if (structField.overlapped)
            continue;
        // if it's a struct declaration or an array of structs
        const tvs: TypeStruct | null = baseElemOf(structField.type!).isTypeStruct();
        if (tvs === null)
            continue;
        const sdv = tvs.sym!;
        // which has a postblit declaration
        if (sdv.postblit === null)
            continue;
        assert(sdv.isUnionDeclaration() === null);

        // if this field's postblit is not `nothrow`, add a `scope(failure)`
        // block to destroy any prior successfully postblitted fields should
        // this field's postblit fail.
        // Don't generate it for betterC code since it cannot throw exceptions.
        if (fieldsToDestroy.length > 0 && !sdv.postblit.type!.isTypeFunction()!.isNothrow
            && global.params.useExceptions) {
             // create a list of destructors that need to be called
            const dtorCalls: Expression[] = [];
            for (const sf of fieldsToDestroy) {
                let ex: Expression;
                const tv = toBasetype(sf.type!);
                const tvs2 = tv.isTypeStruct();
                if (tvs2 !== null) {
                    // this.v.__xdtor()

                    ex = new ThisExp(loc);
                    ex = new DotVarExp(loc, ex, sf);

                    // This is a hack so we can call destructors on const/immutable objects.
                    ex = new AddrExp(loc, ex);
                    ex = new CastExp(loc, ex, pointerTo(mutableOf(sf.type!)));
                    ex = new PtrExp(loc, ex);
                    if ((stc & STC.safe) !== 0n)
                        stc = ((stc & ~STC.safe) | STC.trusted) as STC;

                    ex = new DotVarExp(loc, ex, tvs2.sym!.dtor!, false);
                    ex = new CallExp(loc, ex);

                    dtorCalls.push(ex);
                } else {
                    // _ArrayDtor((cast(S*)this.v.ptr)[0 .. n])

                    // dmd/typesem.d:9329 authorises the live `numberOfElems` (typesem.ts:9726) —
                    // swept (11 §2.5); typesem still walls `toUInteger` one level deeper.
                    const length = numberOfElems(tv, loc);

                    ex = new ThisExp(loc);
                    ex = new DotVarExp(loc, ex, sf);

                    // This is a hack so we can call destructors on const/immutable objects.
                    ex = new DotIdExp(loc, ex, Id.ptr!);
                    ex = new CastExp(loc, ex, pointerTo(sdv.type!));
                    if ((stc & STC.safe) !== 0n)
                        stc = ((stc & ~STC.safe) | STC.trusted) as STC;

                    const se = new SliceExp(loc, ex, new IntegerExp(loc, 0n, Type.tsize_t),
                                                     new IntegerExp(loc, BigInt(length), Type.tsize_t));
                    // Prevent redundant bounds check
                    se.upperIsInBounds = true;
                    se.lowerIsLessThanUpper = true;

                    ex = CallExp.fromArg(loc, new IdentifierExp(loc, Id.__ArrayDtor!), se);

                    dtorCalls.push(ex);
                }
            }
            fieldsToDestroy = [];

            // aggregate the destructor calls
            const dtors: Statements = new Array_<Statement | null>();
            // dmd/clone.d:1372 — `foreach_reverse(dc; dtorCalls)` -> descending counter (06 §2).
            for (let k = dtorCalls.length - 1; k >= 0; k--) {
                const dc = dtorCalls[k];
                dtors.push(new ExpStatement(loc, dc));
            }

            // put destructor calls in a `scope(failure)` block
            postblitCalls.push(new ScopeGuardStatement(loc, TOK.onScopeFailure, new CompoundStatement(loc, dtors)));
        }

        // perform semantic on the member postblit in order to
        // be able to aggregate it later on with the rest of the
        // postblits
        sdv.postblit.isGenerated = true;
        functionSemantic(sdv.postblit);

        stc = mergeFuncAttrs(stc, sdv.postblit);
        stc = mergeFuncAttrs(stc, sdv.dtor);

        // if any of the struct member fields has disabled
        // its postblit, then `sd` is not copyable, so no
        // postblit is generated
        if ((stc & STC.disable) !== 0n) {
            postblitCalls.setDim(0);
            break;
        }

        let ex: Expression;
        const tv = toBasetype(structField.type!);
        if (tv.isTypeStruct() !== null) {
            // this.v.__xpostblit()

            ex = new ThisExp(loc);
            ex = new DotVarExp(loc, ex, structField);

            // This is a hack so we can call postblits on const/immutable objects.
            ex = new AddrExp(loc, ex);
            ex = new CastExp(loc, ex, pointerTo(mutableOf(structField.type!)));
            ex = new PtrExp(loc, ex);
            if ((stc & STC.safe) !== 0n)
                stc = ((stc & ~STC.safe) | STC.trusted) as STC;

            ex = new DotVarExp(loc, ex, sdv.postblit, false);
            ex = new CallExp(loc, ex);
        } else {
            // _ArrayPostblit((cast(S*)this.v.ptr)[0 .. n])

            // dmd/typesem.d:9329 authorises the live `numberOfElems` (typesem.ts:9726) — swept
            // (11 §2.5); typesem still walls `toUInteger` one level deeper.
            const length = numberOfElems(tv, loc);
            if (length === 0)
                continue;

            ex = new ThisExp(loc);
            ex = new DotVarExp(loc, ex, structField);

            // This is a hack so we can call postblits on const/immutable objects.
            ex = new DotIdExp(loc, ex, Id.ptr!);
            ex = new CastExp(loc, ex, pointerTo(sdv.type!));
            if ((stc & STC.safe) !== 0n)
                stc = ((stc & ~STC.safe) | STC.trusted) as STC;

            const se = new SliceExp(loc, ex, new IntegerExp(loc, 0n, Type.tsize_t),
                                             new IntegerExp(loc, BigInt(length), Type.tsize_t));
            // Prevent redundant bounds check
            se.upperIsInBounds = true;
            se.lowerIsLessThanUpper = true;
            ex = CallExp.fromArg(loc, new IdentifierExp(loc, Id.__ArrayPostblit!), se);
        }
        postblitCalls.push(new ExpStatement(loc, ex)); // combine in forward order

        /* https://issues.dlang.org/show_bug.cgi?id=10972
         * When subsequent field postblit calls fail,
         * this field should be destructed for Exception Safety.
         */
        if (sdv.dtor !== null) {
            sdv.dtor.isGenerated = true;
            functionSemantic(sdv.dtor);

            // keep a list of fields that need to be destroyed in case
            // of a future postblit failure
            fieldsToDestroy.push(structField);
        }
    }

    // dmd/clone.d:1459 — nested `void checkShared()` -> inner const arrow (04 §5). It mutates the
    // enclosing `stc`, exactly as D's nested function does.
    const checkShared = (): void => {
        if (sd.type!.isShared())
            stc = (stc | STC.shared_) as STC;
    };

    // Build our own "postblit" which executes a, but only if needed.
    if (postblitCalls.length !== 0 || (stc & STC.disable) !== 0n) {
        //printf("Building __fieldPostBlit()\n");
        checkShared();
        const dd = new PostBlitDeclaration(declLoc, Loc.initial, stc, Id.__fieldPostblit!);
        dd.isGenerated = true;
        dd.storage_class = (dd.storage_class | STC.inference | STC.scope_) as STC;
        dd.fbody = (stc & STC.disable) !== 0n ? null : new CompoundStatement(loc, postblitCalls);
        sd.postblits.shift(dd);
        sd.members!.push(dd);
        dsymbolSemantic(dd, sc);
    }

    // create __xpostblit, which is the generated postblit
    let xpostblit: FuncDeclaration | null = null;
    switch (sd.postblits.length) {
    case 0:
        break;

    case 1:
        xpostblit = sd.postblits.opIndex(0);
        break;

    default: {
        let e: Expression | null = null;
        stc = (STC.safe | STC.nothrow_ | STC.pure_ | STC.nogc) as STC;
        for (const fd of sd.postblits) {
            stc = mergeFuncAttrs(stc, fd);
            if ((stc & STC.disable) !== 0n) {
                e = null;
                break;
            }
            let ex: Expression = new ThisExp(loc);
            ex = new DotVarExp(loc, ex, fd!, false);
            ex = new CallExp(loc, ex);
            e = Expression.combine(e, ex);
        }

        checkShared();
        const dd = new PostBlitDeclaration(declLoc, Loc.initial, stc, Id.__aggrPostblit!);
        dd.isGenerated = true;
        dd.storage_class = (dd.storage_class | STC.inference) as STC;
        dd.fbody = new ExpStatement(loc, e);
        sd.members!.push(dd);
        dsymbolSemantic(dd, sc);
        xpostblit = dd;
        break;
    }
    }

    // Add an __xpostblit alias to make the inclusive postblit accessible
    if (xpostblit !== null) {
        const _alias = AliasDeclaration.fromDsymbol(Loc.initial, Id.__xpostblit!, xpostblit);
        dsymbolSemantic(_alias, sc);
        sd.members!.push(_alias);
        addMember(_alias, sc, sd); // add to symbol table
    }

    if (sd.hasCopyCtor) {
        // we have user defined postblit, so we prioritize it
        if (hasUserDefinedPosblit) {
            sd.hasCopyCtor = false;
            return xpostblit;
        }
        // we have fields with postblits, so print deprecations
        if (xpostblit !== null && !xpostblit.isDisabled()) {
            deprecation(sd.loc, ds("`struct %s` implicitly-generated postblit hides copy constructor."), sd.toChars());
            deprecationSupplemental(sd.loc, ds("The field postblit will have priority over the copy constructor."));
            deprecationSupplemental(sd.loc, ds("To change this, the postblit should be disabled for `struct %s`"), sd.toChars());
            sd.hasCopyCtor = false;
        } else
            xpostblit = null;
    }

    return xpostblit;
}

/**
 * dmd/clone.d:1563 — `private CtorDeclaration generateCtorDeclaration(StructDeclaration sd,
 * const STC paramStc, const STC funcStc, bool move)`.
 *
 * Generates a copy or move constructor declaration with the specified storage class for the
 * parameter and the function.
 *
 * Params:
 *  sd = the `struct` that contains the constructor
 *  paramStc = the storage class of the constructor parameter
 *  funcStc = the storage class for the constructor declaration
 *  move = true for move constructor, false for copy constructor
 *
 * Returns:
 *  The copy constructor declaration for struct `sd`.
 *
 * D `private` == module visibility -> non-exported module function (01 §2.5).
 */
function generateCtorDeclaration(sd: StructDeclaration, paramStc: STC, funcStc: STC, move: boolean): CtorDeclaration {
    const structType = sd.type;
    const stc: STC = move ? STC.none : STC.ref_;     // the only difference between copy or move
    const fparams: Parameters = Array_.from<Parameter | null>(
        new Parameter(Loc.initial, (paramStc | stc) as STC, structType, Id.p!, null, null));
    const pList = new ParameterList(fparams);
    const tf = new TypeFunction(pList, structType, LINK.d, STC.ref_);
    const ccd = new CtorDeclaration(sd.loc, Loc.initial, STC.ref_, tf);
    ccd.storage_class = (ccd.storage_class | funcStc) as STC;
    ccd.storage_class = (ccd.storage_class | STC.inference) as STC;
    ccd.isGenerated = true;
    return ccd;
}

/**
 * dmd/clone.d:1597 — `private Statement generateCtorBody(StructDeclaration sd, bool move)`.
 *
 * Generates a trivial copy or move constructor body that simply does memberwise initialization.
 *
 * for copy construction:
 *    this.field1 = rhs.field1; ...
 * for move construction:
 *    this.field1 = __rvalue(rhs.field1); ...
 *
 * Params:
 *  sd = the `struct` declaration that contains the constructor
 *  move = true for move constructor, false for copy constructor
 *
 * Returns:
 *  A `CompoundStatement` containing the body of the constructor.
 *
 * D `private` == module visibility -> non-exported module function (01 §2.5).
 */
function generateCtorBody(sd: StructDeclaration, move: boolean): Statement {
    const loc = Loc.initial;
    let e: Expression | null = null;
    for (const v of sd.fields) {
        const rhs: Expression = new DotVarExp(loc, new IdentifierExp(loc, Id.p!), v!);
        if (move)
            rhs.rvalue = true;
        const ec = new AssignExp(loc,
            new DotVarExp(loc, new ThisExp(loc), v!),
            rhs);
        e = Expression.combine(e, ec);
        //printf("e.toChars = %s\n", e.toChars());
    }
    const s1: Statement = new ExpStatement(loc, e);
    return new CompoundStatement(loc, Array_.from<Statement | null>(s1));
}

/******************************************
 * dmd/clone.d:1625 — `private bool findStructConstructorRoot(StructDeclaration sd, out Dsymbol ctor)`.
 *
 * Find root `this` constructor for struct sd.
 * (root is starting position for overloaded constructors)
 * Params:
 *  sd = the `struct` to be searched
 *  ctor = `this` if found, otherwise null (D `out` -> box, 03 §3.3)
 * Result:
 *  false means `this` found in overload set
 *
 * D `private` == module visibility -> non-exported module function (01 §2.5).
 */
function findStructConstructorRoot(sd: StructDeclaration, ctor: Ref<Dsymbol | null>): boolean {
    // D resets an `out` parameter to `T.init` on entry (03 §3.3); a class ref's `.init` is null.
    ctor.value = null;
    ctor.value = search(sd, sd.loc, Id.ctor!); // Aggregate.searchCtor() ?
    if (ctor.value !== null) {
        if (ctor.value.isOverloadSet() !== null)
            return false;
        const td = ctor.value.isTemplateDeclaration();
        if (td !== null)
            ctor.value = td.funcroot;
    }
    return true;
}

/***********************************************
 * dmd/clone.d:1645 — `private void findMoveAndCopyConstructors(Dsymbol ctor,
 * out CtorDeclaration copyCtor, out CtorDeclaration moveCtor)`.
 *
 * Find move and copy constructors (if any) starting at `ctor`
 * Params:
 *      ctor = `this` constructor root
 *      copyCtor = set to first copy constructor found, or null (D `out` -> box, 03 §3.3)
 *      moveCtor = set to first move constructor found, or null (D `out` -> box, 03 §3.3)
 *
 * D `private` == module visibility -> non-exported module function (01 §2.5).
 */
function findMoveAndCopyConstructors(ctor: Dsymbol, copyCtor: Ref<CtorDeclaration | null>,
                                     moveCtor: Ref<CtorDeclaration | null>): void {
    // D resets `out` parameters to `T.init` on entry (03 §3.3).
    copyCtor.value = null;
    moveCtor.value = null;
    // dmd/funcsem.d:4084 `extern (D) int overloadApply(Dsymbol fstart, scope int delegate(Dsymbol) dg,
    // Scope* sc = null)` authorises the live call (funcsem.ts:4197) — the wall that stood here is
    // swept (11 §2.5). D omits the `sc` default, so the port does too; the return value is discarded
    // at this D site.
    overloadApply(ctor, (s: Dsymbol): number => {
        if (s.isTemplateDeclaration() !== null)
            return 0;
        const ctorDecl = s.isCtorDeclaration();
        assert(ctorDecl !== null);
        if (ctorDecl!.isCpCtor) {
            if (copyCtor.value === null)
                copyCtor.value = ctorDecl;
        } else if (ctorDecl!.isMoveCtor) {
            if (moveCtor.value === null)
                moveCtor.value = ctorDecl;
        }
        return 0;
    });
}

/**
 * dmd/clone.d:1685 — `void needCopyOrMoveCtor(StructDeclaration sd, out bool hasCopyCtor,
 * out bool hasMoveCtor, out bool needCopyCtor, out bool needMoveCtor)`.
 *
 * Determine if a copy constructor is needed for struct sd, if the following conditions are met:
 * 1. sd does not define a copy constructor
 * 2. at least one field of sd defines a copy constructor
 *
 * Params:
 *  sd = the `struct` for which the copy constructor is generated
 *  hasCopyCtor = set to true if a copy constructor is already present
 *  hasMoveCtor = set to true if a move constructor is already present
 *  needCopyCtor = set to true if a copy constructor is not present, but needed
 *  needMoveCtor = set to true if a move constructor is not present, but needed
 *
 * The four D `out bool` parameters are single-slot boxes (03 §3.3): reset to `false` on entry,
 * written by this function, read back by the caller. The D signature (void return, four out
 * params) is preserved verbatim — 04 §0.1 forbids re-protocoling it to a returned record.
 *
 * The `dependency signature` record this declaration carried — a dependent still calling it with
 * one argument and reading a returned record — is RETIRED by this wave's sweep: dsymbolsem.ts:2040
 * and :5505 both call the five-argument out-box protocol now, so nothing diverges from the D
 * signature any more.
 *
 * POD note: no ctor member and no struct-typed field leaves all four flags false. No wall is on
 * that path.
 */
export function needCopyOrMoveCtor(sd: StructDeclaration, hasCopyCtor: Ref<boolean>, hasMoveCtor: Ref<boolean>,
                                   needCopyCtor: Ref<boolean>, needMoveCtor: Ref<boolean>): void {
    // D resets `out` parameters to `T.init` on entry (03 §3.3); `bool.init` is false.
    hasCopyCtor.value = false;
    hasMoveCtor.value = false;
    needCopyCtor.value = false;
    needMoveCtor.value = false;

    //printf("needCopyOrMoveCtor() %s\n", sd.toChars());
    if (global.errors !== 0)
        return;

    const ctor: Ref<Dsymbol | null> = { value: null };
    if (!findStructConstructorRoot(sd, ctor))
        return;

    const copyCtor: Ref<CtorDeclaration | null> = { value: null };
    const moveCtor: Ref<CtorDeclaration | null> = { value: null };

    if (ctor.value !== null)
        findMoveAndCopyConstructors(ctor.value, copyCtor, moveCtor);

    if (moveCtor.value !== null)
        hasMoveCtor.value = true;

    if (copyCtor.value !== null)
        hasCopyCtor.value = true;

    if (hasMoveCtor.value && hasCopyCtor.value)
        return;

    let fieldWithCpCtor: VarDeclaration | null = null;
    let fieldWithMoveCtor: VarDeclaration | null = null;
    // see if any struct members define a copy constructor
    for (const v of sd.fields) {
        if ((v!.storage_class & STC.ref_) !== 0n)
            continue;
        if (v!.overlapped)
            continue;

        const ts = baseElemOf(v!.type!).isTypeStruct();
        if (ts === null)
            continue;
        if (ts.sym!.hasCopyCtor) {
            fieldWithCpCtor = v;
        }
        if (ts.sym!.hasMoveCtor) {
            fieldWithMoveCtor = v;
        }
    }

    // dmd/clone.d:1733 — `if (0 && fieldWithCpCtor && moveCtor)`. This is ORDINARY D that the
    // compiler emits, merely constant-false at runtime — it is NOT a `version`/`static if`/`debug`
    // block, so 07 §1 does not cover it (11 §2 Operating rule: do not stretch a rule to a case it
    // does not literally address). It is therefore translated verbatim, diagnostics included, so a
    // future upstream flip of the `0 &&` guard has something to fill.
    if (0 && fieldWithCpCtor !== null && moveCtor.value !== null) {
        error(sd.loc, ds("`struct %s` may not define a rvalue constructor and have fields with copy constructors"),
            sd.toChars());
        errorSupplemental(moveCtor.value.loc, ds("rvalue constructor defined here"));
        errorSupplemental(fieldWithCpCtor.loc, ds("field with copy constructor defined here"));
        return;
    }

    if (fieldWithCpCtor !== null && !hasCopyCtor.value)
        needCopyCtor.value = true;
    if (fieldWithMoveCtor !== null && !hasMoveCtor.value)
        needMoveCtor.value = true;
}

/**
 * dmd/clone.d:1764 — `void buildCopyOrMoveCtor(StructDeclaration sd, Scope* sc, bool move)`.
 *
 * Generates a copy constructor if needCopyOrMoveCtor() reports one is needed. The generated copy
 * constructor will be of the form:
 *   this(ref return scope inout(S) rhs) inout
 *   {
 *      this.field1 = rhs.field1; ...
 *   }
 *
 * Params:
 *  sd = the `struct` for which the constructor is generated
 *  sc = the scope where the constructor is generated
 *  move = true means generate the move constructor, otherwise copy constructor
 * References:
 *   https://dlang.org/spec/struct.html#struct-copy-constructor
 */
export function buildCopyOrMoveCtor(sd: StructDeclaration, sc: Scope, move: boolean): void {
    //printf("buildCopyOrMoveCtor() generating %s constructor for %s\n", move ? "move".ptr : "copy".ptr, sd.toChars());
    const paramMod: MOD = MODFlags.wild;
    const funcMod: MOD = MODFlags.wild;
    const ccd = generateCtorDeclaration(sd, ModToStc(paramMod), ModToStc(funcMod), move);
    const ctorBody = generateCtorBody(sd, move);
    ccd.fbody = ctorBody;
    sd.members!.push(ccd);
    addMember(ccd, sc, sd);
    const errors = global.startGagging();
    const sc2 = sc.push();
    sc2.stc = STC.none;
    sc2.linkage = LINK.d;
    // GAG PAIRING (11 §2.5): `dsymbolSemantic`/`semantic2`/`semantic3` still hold walls, so this
    // region has exit paths dmd/clone.d:1774-1783 does not have and `global.gag` is process-global —
    // the pair is a try/finally in the port.
    let gaggedErrorsHappened = false;
    try {
        dsymbolSemantic(ccd, sc2);
        // dmd/semantic2.d:79 authorises the live `semantic2` (semantic2.ts:197) — swept (11 §2.5).
        semantic2(ccd, sc2);
        semantic3(ccd, sc2);
        //printf("ccd semantic: %s\n", ccd.type.toChars());
    } finally {
        sc2.pop();
        gaggedErrorsHappened = global.endGagging(errors);
    }
    if (gaggedErrorsHappened || sd.isUnionDeclaration() !== null) {
        ccd.storage_class = (ccd.storage_class | STC.disable) as STC;
        ccd.fbody = null;
    }
}

// ── CARRY-OVER INDEX (04 §6) ────────────────────────────────────────────────────────────────
// Carried FREE functions: none. `search_function` is D-homed at opover.d:1183, emitted by
// opover.ts, and imported from there above — clone.ts holds no copy and re-exports nothing (D's
// clone.d exports no such symbol). The last consumer that selected it from "./clone.js"
// (typesem.ts) has been flipped to "./opover.js" by this wave; verified by grep at fix time.
// Carried CLASS members: none (this module declares no class).
