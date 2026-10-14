// Ported from dmd/templatesem.d (module dmd.templatesem).
//
// ============================================================================================
// WHAT THIS MODULE OWNS
// ============================================================================================
// The template SEMANTIC engine: declaration/instance semantic passes, the instance cache, the
// argument<->parameter MATCHING and type DEDUCTION algorithms. The template DATA layer (the
// `TemplateDeclaration` / `TemplateInstance` / `TemplateParameter` node classes, `Tuple`, the
// `isType`/`isExpression`/`isDsymbol`/`isTuple` accessors) lives in `dtemplate.ts` — this file
// only operates on it. The file was translated in three chunks, stitched in D source order:
//   chunk 1 (D 1-2474)    — module state, `reliesOn*`, `computeOneMember`, `declareParameter`,
//                           the hashing layer + `TemplateInstanceBox` + the instance table,
//                           `templateDeclarationSemantic` / `templateInstanceSemantic` /
//                           `templateInstanceSemantic3`, the instance-cache ops, `findTempDecl`
//                           / `findMixinTempDecl`, `match` / `arrayObjectMatch` / `equalsx`.
//   chunk 2 (D 2475-5354) — `matchArg*`, `updateTempDecl`, `matchWithInstance`, constraint
//                           evaluation, `findBestMatch`, `leastAsSpecialized`, `defaultArg`,
//                           `deduceFunctionTemplateMatch`, `declareParameters`.
//   chunk 3 (D 5355-8204) — `semanticTiargs`, `functionResolve`, `deduceType` and the deduction
//                           helpers, `rootObjectsEqual`, `getValue*` / `getExpression`.
//
// ============================================================================================
// COMPILE-TIME RESOLUTIONS (07-compile-time.md, _config.md) — every one recorded with its D line
// ============================================================================================
//   templatesem.d:63    `enum LOG = false;`            -> manifest const, ALL 22 `static if (LOG)`
//                                                         blocks FALSE and dropped; the constant
//                                                         itself is NOT emitted (dead, 02 §4.1).
//   templatesem.d:733   `enum log = false;`   (templateDeclarationSemantic) -> block dropped.
//   templatesem.d:2269  `enum log = false;`   (`match`)                     -> blocks dropped;
//                        the nested `yes()`/`no()` return protocol STAYS (04 §0.1).
//   templatesem.d:3072  `enum LOGM = 0;`      (`matchWithInstance`)         -> FALSE; the whole
//                        `static if (LOGM)` at :3216-:3239 (its `else return nomatch();` included)
//                        is dropped, and the fall-through `return nomatch();` at :3241 stands.
//   templatesem.d:4012  `enum LOG_LEASTAS = 0;` (`leastAsSpecialized`)      -> FALSE, blocks
//                        dropped; the `L1:` goto target at :4061 SURVIVES.
//   templatesem.d:703   `static if (__VERSION__ < 2099)` -> __VERSION__ == 2113 => FALSE, the
//                        ELSE branch is live (`ti.equalsx(s.ti)`).
//   templatesem.d:759   `IN_LLVM && …`  -> IN_LLVM ON, folds to the bare condition.
//   templatesem.d:1034  `!(IN_LLVM && …)` -> folds to `!(…)`.
//   templatesem.d:1131  `IN_LLVM && …`  -> folds to the bare condition.
//   templatesem.d:1268  `version (IN_LLVM)` -> ON, block LIVE (no `else` to drop).
//   templatesem.d:1749  `version (IN_LLVM)` -> ON, block LIVE (no `else` to drop).
//   templatesem.d:3323  `version (IN_LLVM)` -> ON, block LIVE (no `else` to drop).
//   templatesem.d:872, :3014, :3077, :3141, :4158, :4209, :4280, :4702, :5135, :5156, :5642,
//                        :5675, :8065  `version (none)` -> OFF, all dropped.
//   templatesem.d:709,713-721 `debug (FindExistingInstance)` -> OFF (07 §2): the counter bumps,
//                        the `__gshared uint nHits, nCollisions;` and the `shared static ~this()`
//                        are dropped.
//   templatesem.d:1928-1941 `debug (FindExistingInstance)` counter block -> dropped entirely,
//                        together with the bumps at :1989, :2003, :2016.
//   templatesem.d:1733  `debug this(MATCH, MATCH)` on `MATCHpair` -> debug is OFF, so D has NO
//                        user constructor there; the struct takes the default field-order ctor.
//   templatesem.d:6313  `private auto X(T, U)(T m, U n) { return (m << 4) | n; }` is a CT-only
//                        label builder: every use is a `case X(a, b):` label in the two switches
//                        at :6325 (`deduceWildHelper`) and :6375 (`deduceTypeHelper`). Each label
//                        is FOLDED to its integer literal at translation time (07) with one
//                        `// resolved:` comment per stacked case group; `X` is NOT emitted.
//   templatesem.d:7134  `L2:` in `DeduceType.visit(TypeFunction)` is a DEAD label in 1.43 — the
//                        only `goto L2` (:7235) lives in `visit(TypeInstance)` and targets :7249.
//                        Nothing is emitted for it (a labeled block there would be a phantom).
//
// ============================================================================================
// RECORDED SUBSTITUTION ACTS (08 §5 "recorded act")
// ============================================================================================
// 1. `TemplateDeclaration.instances` (dtemplate.ts:281 `instances: unknown = null`) holds D's
//    builtin associative array `TemplateInstance[TemplateInstanceBox]` (dtemplate.d:244). This
//    module owns the engine, so the container model lands here: `TemplateInstanceTable` below,
//    a hash-bucket map resolved with `TemplateInstanceBox.toHash()`/`opEquals()`. D performs
//    exactly four operations on it — `k in aa` (:1990), `aa[k] = v` (:2007, :1456),
//    `aa.remove(k)` (:1451, :2020) — plus `traits.d`'s `aa[k] = null; aa.clear();`.
//    OBSERVABLE DIFFERENCE: iteration ORDER. D never iterates this AA (verified: the only
//    accesses are the four above plus traits.d's clear), so no in-scope behavior depends on it.
//    Second, minor: D leaves the AA null until the first insert, while `instancesOf()` allocates
//    an empty table on first touch — unobservable, because no D code reads the slot for nullness.
// 2. POINTER-IDENTITY HASHING. D hashes `cast(size_t)cast(void*)X` at :565 (`s1.getIdent()`,
//    `s1.parent`), :676 (`ti.enclosing`), :605/:609/:643/:647/:653 (`ident`, `type`, `var`, `fd`,
//    and the identity fallback). JS has no addresses, so `objId()` below assigns a stable
//    per-object id from a `WeakMap` (tree precedent: identifier.ts:385 `parentIds`). HASH VALUES
//    THEREFORE DIFFER FROM D. The file's own stated contract — "e1.equals(e2) implies
//    expressionHash(e1) == expressionHash(e2)" (templatesem.d:583) — is preserved exactly,
//    because equal references get equal ids and every non-pointer arm is value-derived.
//    `t1.deco` (:566) is NOT hashed through `objId`: `deco` is an INTERNED `const(char)*`, so D's
//    address IS a per-distinct-deco identity; the port uses `Type.getUniqueID()` (mtype.ts,
//    dmd/mtype.d:593), which is the tree's canonical stand-in for exactly that `cast(size_t)deco`.
// 3. HASH DOMAIN. `size_t` is 64-bit on the target, so `arrayObjectHash`/`expressionHash`/
//    `TemplateInstanceBox.hash` are `bigint` and use the verified 64-bit `mixHash(bigint, bigint)`
//    (08 §9) — the very function D calls. The 32-bit producers `calcHash` and `CTFloat.hash`
//    return `number` and are widened at the boundary with `BigInt(...)` (09 §5: widen the narrow
//    operand; never `Number(bigint)`). Sums are re-truncated with `BigInt.asUintN(64, …)` (09 §3).
// 4. `DEFAULT_ARGI` (templatesem.d:4407 `enum DEFAULT_ARGI = size_t.max - 10;`). The 09
//    `SIZE_MAX = -1` sentinel does NOT work here: `argi` holding DEFAULT_ARGI is compared
//    `argi >= fargs.length` and D expects TRUE. `argi` stays in the `number` index domain, so the
//    sentinel is written `2 ** 64 - 10` for diff-fidelity with D but FOLDS to exactly `2 ** 64`
//    (2^64-10 is not representable as a double). That is harmless for the identity and
//    `>=`-against-a-real-length uses; the ONE arithmetic use that D's exact value would change
//    (`fargs.length - argi`) carries a stop-stub escalation at its site. See the audit comment
//    at the declaration for the per-site proof.
//
// ============================================================================================
// OVERLOAD-SET RENAMES (04 §1B Form B) — binding for this file and every future caller
// ============================================================================================
//   matchArgFromTiargs        = D :2485 `matchArg(tp, instLoc, sc, tiargs, i, …)`  [public]
//   matchArgFromObject        = D :2552 `matchArg(tp, sc, oarg, i, …)`             [D module-private]
//   declareParameter          = D :497  `declareParameter(tp, sc)`                 [verbatim, public]
//   declareParameterWithValue = D :5258 `declareParameter(td, sc, tp, o)`          [D module-private]
//   getValueFromDsymbol       = D :8167 `getValue(ref Dsymbol s)`
//   getValueFromExpression    = D :8183 `getValue(Expression e)`
//   reliesOnTemplateParameters    = D :84  (Type overload — verbatim name, it is the exported one)
//   reliesOnTemplateParametersExp = D :182 (Expression overload)                   [D module-private]
// The MODULE-ALIAS at templatesem.d:61 (`alias funcLeastAsSpecialized =
// dmd.funcsem.leastAsSpecialized;`) is load-bearing: this file ALSO defines its own free
// `leastAsSpecialized` (:4010, TemplateDeclaration-vs-TemplateDeclaration). The two are distinct
// functions and are never collapsed — the import below carries the `funcLeastAsSpecialized` alias.
//
// ============================================================================================
// DEFERRED CALLEES (walls, 11 §2.5) — the whole file's inventory
// ============================================================================================
// (Every D line cite below is verified against ldc-1.43.0-beta1's dmd/templatesem.d and matches
// the cite carried by the emitted wall message, so a sweep driven by this inventory finds its
// own sites.)
//   dmd/timetrace.d       — NOT a wall. `timeTraceBeginEvent`/`timeTraceEndEvent` at
//                           templatesem.d:752/:753 and :916/:917 are DROPPED as balanced pairs
//                           (profiling only, no semantic effect, no port), matching every other
//                           timetrace site in the tree — dmodule.ts:828, dsymbolsem.ts:4017/:4466,
//                           funcsem.ts:454, semantic2.ts:582, semantic3.ts:318.
//   gen/llvmhelpers.d     — LDC glue, no D-frontend module. `DtoSetFuncDeclIntrinsicName` at
//                           :1275, inside the LIVE `version (IN_LLVM)` block.
//                           (`evalStaticCondition` DOES have a port, in expressionsem.ts, and is
//                           called normally at :3593).
// `tempinst.semantic2(sc2)` at :1369 is NOT deferred: dmd/semantic2.d IS ported (semantic2.ts),
// and D's UFCS resolves it to that module's free `semantic2(Dsymbol, Scope*)` (semantic2.d:79).
//
// ============================================================================================
// LOAD ORDER (01 §4.7)
// ============================================================================================
// templatesem.ts is NOT a load-order root and does not need to be one. It has no top-level
// `extends` (all four visitor classes in the file are nested inside function bodies except
// `DummyArgVisitor`, whose base `Visitor` comes from visitor/index.ts — itself a load-order ROOT,
// so that edge is safe by construction) and no top-level value read: the only module-level state
// is `objIds`/`nextObjId`, the two `__gshared` nest counters, and `emptyArrayElement`, all
// initialised to a fresh WeakMap / 0 / null. Per 01 §4.3 every import below may therefore be an
// ordinary VALUE import into the core SCC. Do NOT apply the §4.1 lazy-class shape here.
//
// ============================================================================================
// STITCH SEAMS (mechanical; recorded so a reviewer can see what the assembler touched)
// ============================================================================================
//  * ONE import block, merged from the three chunks' assumption sheets. Where two chunks picked
//    different local aliases for the SAME import, the file uses one spelling:
//      expressionsem.equals  -> `expressionEquals`      (chunk 2 wrote `expEquals`,
//                                                        chunk 3 wrote `expressionsemEquals`)
//      dsymbolsem.equals     -> `dsymbolEquals`         (chunk 3 wrote `dsymbolsemEquals`)
//    The 04 §6.1 first-parameter-type resolutions themselves are unchanged.
//  * `interface Ref<T>` (the 03 §3.3 one-slot out/ref box) is declared ONCE, here, instead of in
//    chunk 3's body; chunks 2 and 3 both consume it.
//  * `functionSemantic` is funcsem.ts's (04 §6.1: `functionSemantic(FuncDeclaration)`), not
//    expressionsem.ts's same-named re-export; `isAggregate` and `merge` are typesem.ts's; the
//    fully qualified `dmd.dsymbolsem.getType` of :3037/:3040/:3044/:6653/:6798 is imported as
//    `dsymbolsemGetType`; `typesem.trySemantic(Type, …)` as `trySemanticType`; `errors.tip` as
//    `tipDiagnostic` (two functions in this file have a LOCAL named `tip`, D:3615/:3846).

import type { Dsymbols, Objects, TemplateInstances, TemplateParameters, Types } from "./arraytypes.js";
import type { MOD } from "./astenums.js";
import { AliasThisRec, MATCH, MODFlags, STC, ThreeState, TY, VarArg } from "./astenums.js";
import { AttribDeclaration, ConditionalDeclaration, StorageClassDeclaration } from "./attrib.js";
import { OutBuffer } from "./common/outbuffer.js";
import { Include } from "./cond.js";
import { implicitCastTo, implicitConvTo, implicitConvToType, toStaticArrayType } from "./dcast.js";
import type { BaseClass } from "./dclass.js";
import { ClassDeclaration } from "./dclass.js";
import type { MatchAccumulator } from "./declaration.js";
import { AliasDeclaration, Declaration, TupleDeclaration, VarDeclaration } from "./declaration.js";
import { Module } from "./dmodule.js";
import { Scope } from "./dscope.js";
import { DSYM, Dsymbol, DsymbolTable, PASS, ScopeDsymbol, Visibility, WithScopeSymbol, foreachDsymbolVoid } from "./dsymbol.js";
import {
    Ungag, addDeferredSemantic2, addDeferredSemantic3, addMember, checkDeprecated, checkGNUABITag,
    checkHasBothRvalueAndCpCtor, dsymbolSemantic, hasStaticCtorOrDtor, importAll, include, makeNested,
    oneMembers, resolveAliasThis, runDeferredSemantic, search, searchScope, search_correctScope,
    setScope, toAlias, toAlias2, ungagSpeculative,
    equals as dsymbolEquals, getType as dsymbolsemGetType, insert } from "./dsymbolsem.js";
import { StructDeclaration } from "./dstruct.js";
import {
    IDX_NOTFOUND, TemplateAliasParameter, TemplateDeclaration, TemplateInstance, TemplateMixin,
    TemplateParameter, TemplatePrevious, TemplateStats, TemplateTupleParameter, TemplateTypeParameter,
    TemplateValueParameter, Tuple, TypeDeduced, definitelyValueParameter, isDsymbol, isError,
    isExpression, isParameter, isTuple, isType, write,
} from "./dtemplate.js";
import { error, errorSupplemental, fatal, tip as tipDiagnostic } from "./errors.js";
import {
    ArgumentLabel, ArgumentList, ArrayExp, ArrayLiteralExp, AssocArrayLiteralExp, BinExp, CallExp,
    CastExp, CommaExp, CondExp, DotTemplateInstanceExp, ErrorExp, Expression, FuncExp, IdentifierExp,
    IntegerExp, IntervalExp, IsExp, NewAnonClassExp, NewExp, NullExp, ScopeExp, SliceExp, StringExp,
    StructLiteralExp, TraitsExp, TupleExp, TypeExp, TypeidExp, UnaExp, VarExp, WANTvalue,
} from "./expression.js";
import {
    checkValue, evalStaticCondition, expressionSemantic, getConstInitializer, getDsymbol, isLvalue,
    resolveLoc, resolveProperties, toImaginary, toInteger, toReal, equals as expressionEquals,
} from "./expressionsem.js";
import { CtorDeclaration, FuncDeclaration } from "./func.js";
import {
    FuncResolveFlag, declareThis, functionSemantic, isReturnIsolated, isUnique, overloadApply,
    overrides, resolveFuncCall, leastAsSpecialized as funcLeastAsSpecialized,
} from "./funcsem.js";
import { DiagnosticReporting, LinkonceTemplates, global } from "./globals.js";
import { HdrGenState, toCharsMaybeConstraints } from "./hdrgen.js";
import { Id } from "./id.js";
import type { Identifier } from "./identifier.js";
import { implicitConvCommonTy } from "./impcnvtab.js";
import type { Initializer } from "./init.js";
import { ExpInitializer } from "./init.js";
import { initializerToExpression } from "./initsem.js";
import { Loc } from "./location.js";
import {
    Covariant, MODimplicitConv, MODmerge, MODmethodConv, ModToStc, Parameter, Type, TypeAArray,
    TypeClass, TypeDArray, TypeDelegate, TypeEnum, TypeFunction, TypeIdentifier, TypeInstance,
    TypeNext, TypeSArray, TypeStruct, TypeTuple, TypeTypeof, TypeVector,
} from "./mtype.js";
import { optimize } from "./optimize.js";
import { Array as DArray } from "./root/array.js";
import { CTFloat } from "./root/ctfloat.js";
import { calcHash, mixHash } from "./root/hash.js";
import type { RootObject } from "./rootobject.js";
import { DYNCAST } from "./rootobject.js";
import { semantic2 } from "./semantic2.js";
import { semantic3 } from "./semantic3.js";
import { aliasParameterSemantic, tpsemantic } from "./templateparamsem.js";
import { EXP, TOK } from "./tokens.js";
import {
    addMod, addSTC, addStorageClass, aliasthisOf, baseElemOf, callMatch, castMod, constOf, covariant,
    deduceWild, defaultInit, equivalent, hasPointers, isAggregate, isLazyArray, isRecursiveAliasThis,
    merge, merge2, mutableOf, nextOf, resolve, resolveNamedArgs, sarrayOf, substWildTo, toBasetype,
    toDsymbol, typeSemantic, unSharedOf, unqualify, trySemantic as trySemanticType,
} from "./typesem.js";
import { Visitor } from "./visitor/index.js";
import { K, keepDeferSemantic3, keepInstClose, keepInstMatch, keepInstOpen } from "../keep.js";
import { SwitchError, assert, assertUnreachable } from "../assert.js";
import type { DString } from "../dstring.js";
import { cstr, ds } from "../dstring.js";
// last (01 §4.8): dinterpret.ts value-imports dsymbolsem/funcsem/initsem/semantic2; entering the
// core SCC through it ahead of the node modules above would make it the entry of that chain.
import { ctfeInterpret } from "./dinterpret.js";
// dmd/templatesem.d:3620 function-local `import dmd.staticcond;` — hoisted, placed last (01 §4.8).
import { visualizeStaticCondition } from "./staticcond.js";
// dmd/templatesem.d:1270 (`import gen.llvmhelpers : DtoSetFuncDeclIntrinsicName;`, function-local, hoisted per 01 §4).
import { DtoSetFuncDeclIntrinsicName } from "../gen/llvmhelpers.js";

// D `import dmd.root.string : toDString;` (templatesem.d:50) is DROPPED (01 §3.2 selective +
// strict-mode unused-binding): its single use, at :918, is inside the `timeTraceEndEvent` lambda
// that the timetrace wall replaces.
// D `import core.stdc.stdio;` (:14) is DROPPED (01 §3.7): every `printf` in this file sits under
// `static if (LOG/log/LOGM/LOG_LEASTAS)` (all OFF), `version (none)`, or `debug (…)`.
// D `import core.stdc.string : memcpy;` (:15) is DROPPED (01 §3.7 — not a module): its four uses
// (:3768, :4253, :7398, :7862) are `Objects`-array bulk copies, translated as element loops /
// `Array` operations; :7862 copies INTO an existing `Objects` (03 in-place value-overwrite).
// D `import dmd.aliasthis;` (:17), `dmd.ast_node` (:20), `dmd.errorsink` (:33) and `dmd.opover`
// (:47) are DROPPED: nothing from them is referenced directly (verified by grep).

/**
 * The house out/ref box (03 §3.3 / §7.2) — one mutable cell, so a callee can write back through a
 * D `out`/`ref`/`T*` parameter. Each ported module declares its own (typesem.ts:147,
 * expressionsem.ts:195, dcast.ts:172 are the tree precedents); it is deliberately NOT exported.
 */
interface Ref<T> {
    value: T;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// MODULE-LEVEL STATE
// ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Stable per-object identity, standing in for D's `cast(size_t)cast(void*)x`. See the header's
 * "RECORDED SUBSTITUTION ACTS" §2. Tree precedent: identifier.ts:385 (`parentIds`/`nextParentId`).
 *
 * Contract: `objId(a) === objId(b)` IFF `a === b`; `objId(null)` is 0, D's null pointer. Ids are
 * dense and small, so they are NOT D's addresses — only the equality relation is reproduced, and
 * that is all any hash in this file needs.
 */
let objIds = new WeakMap<object, number>();
let nextObjId = 1;
function objId(o: object | null): number {
    if (o === null)
        return 0; // the null pointer
    let id = objIds.get(o);
    if (id === undefined) {
        id = ++nextObjId;
        objIds.set(o, id);
    }
    return id;
}

/**
 * The container behind `TemplateDeclaration.instances` — D's builtin AA
 * `TemplateInstance[TemplateInstanceBox]` (dtemplate.d:244). See the header's "RECORDED
 * SUBSTITUTION ACTS" §1 for why the model lives here and what differs from D.
 *
 * LOAD-BEARING PROBE DIRECTION: druntime's AA compares `probe == stored`, and
 * `TemplateInstanceBox.opEquals` is `this.ti.equalsx(s.ti)` — which `equalsx` documents as NOT
 * commutative ("ti1 = proposed, ti2 = existing", templatesem.d:2398-2404). So every lookup here
 * must call `probe.opEquals(entry.key)`, never the reverse.
 *
 * Exported because `dmd/traits.d:51` imports `TemplateInstanceBox` and clears this table
 * (`aa[k] = null; aa.clear();`) — a future traits.ts needs both names.
 */
export class TemplateInstanceTable {
    private buckets = new Map<bigint, { key: TemplateInstanceBox; value: TemplateInstance | null }[]>();

    /** D: `auto p = k in aa; return p ? *p : null;` */
    get(key: TemplateInstanceBox): TemplateInstance | null {
        const bucket = this.buckets.get(key.toHash());
        if (bucket === undefined)
            return null;
        for (const e of bucket) {
            if (key.opEquals(e.key))
                return e.value;
        }
        return null;
    }

    /** D: `k in aa` as a pure presence test (traits.d's use; distinct from a null VALUE). */
    has(key: TemplateInstanceBox): boolean {
        const bucket = this.buckets.get(key.toHash());
        if (bucket === undefined)
            return false;
        for (const e of bucket) {
            if (key.opEquals(e.key))
                return true;
        }
        return false;
    }

    /** D: `aa[k] = v;` */
    set(key: TemplateInstanceBox, value: TemplateInstance | null): void {
        const h = key.toHash();
        let bucket = this.buckets.get(h);
        if (bucket === undefined) {
            bucket = [];
            this.buckets.set(h, bucket);
        }
        for (const e of bucket) {
            if (key.opEquals(e.key)) {
                e.value = value;
                return;
            }
        }
        // D's AA stores the probe as the key when the slot is new.
        bucket.push({ key: key.copy(), value });
    }

    /** D: `aa.remove(k);` */
    remove(key: TemplateInstanceBox): void {
        const h = key.toHash();
        const bucket = this.buckets.get(h);
        if (bucket === undefined)
            return;
        for (let i = 0; i < bucket.length; i++) {
            if (key.opEquals(bucket[i].key)) {
                bucket.splice(i, 1);
                if (bucket.length === 0)
                    this.buckets.delete(h);
                return;
            }
        }
    }

    /** D: `aa.clear();` (traits.d). */
    clear(): void {
        this.buckets.clear();
    }

    /** No D counterpart: the kept-module engine (src/keep.ts) removes the instances it drops. */
    keepRemove(drop: (ti: TemplateInstance) => boolean): void {
        for (const [h, bucket] of this.buckets) {
            const live = bucket.filter((e) => e.value === null || !drop(e.value));
            if (live.length === 0)
                this.buckets.delete(h);
            else if (live.length !== bucket.length)
                this.buckets.set(h, live);
        }
    }
}

/**
 * The opaque `TemplateDeclaration.instances` slot, typed. ONE cast, in ONE place, so the four D
 * cast sites (templatesem.d:1451, :1456, :1990, :2007, :2020) stay auditable; see the header's
 * "RECORDED SUBSTITUTION ACTS" §1 for the lazy-allocation note.
 */
function instancesOf(td: TemplateDeclaration): TemplateInstanceTable {
    if (td.instances === null)
        td.instances = new TemplateInstanceTable();
    // opaque-slot re-typing: dtemplate.ts leaves `instances: unknown` and hands the container
    // model to this module (dtemplate.ts:272-281). Nothing else ever writes the slot.
    return td.instances as TemplateInstanceTable;
}

// ────────────────────────────────────────────────────────────────────────────────────────────

/***********************************************************
 * dmd/templatesem.d:73 — Check whether the type t representation relies on one or more the
 * template parameters.
 * Params:
 *      t           = Tested type, if null, returns false.
 *      tparams     = Template parameters.
 *      iStart      = Start index of tparams to limit the tested parameters. If it's
 *                    nonzero, tparams[0..iStart] will be excluded from the test target.
 *
 * NOTE `iStart` is declared but UNUSED by the 1.43 body (the slice starts at 0 regardless); the
 * parameter is kept verbatim and `_`-prefixed for `noUnusedParameters`.
 */
export function reliesOnTident(t: Type | null, tparams: TemplateParameters, _iStart = 0): boolean {
    return reliesOnTemplateParameters(t, tparams.opSlice(0, tparams.length));
}

/***********************************************************
 * dmd/templatesem.d:84 — Check whether the type t representation relies on one or more the
 * template parameters.
 * Params:
 *      t           = Tested type, if null, returns false.
 *      tparams     = Template parameters.
 *
 * OVERLOAD SET (04 §1B, Form B): D declares a second `reliesOnTemplateParameters(Expression,
 * TemplateParameter[])` at :182. Same arity, different first type — this **Type** form keeps the
 * verbatim name (it is the exported one, called from chunks 2 and 3 and from
 * templateparamsem.ts); the Expression form is `reliesOnTemplateParametersExp` below.
 *
 * `t` is typed nullable because the body null-tests it (02 §10.1).
 */
export function reliesOnTemplateParameters(t: Type | null, tparams: (TemplateParameter | null)[]): boolean {
    const visitVector = (t: TypeVector): boolean => {
        return reliesOnTemplateParameters(t.basetype, tparams);
    };

    const visitAArray = (t: TypeAArray): boolean => {
        return reliesOnTemplateParameters(t.next, tparams) ||
               reliesOnTemplateParameters(t.index, tparams);
    };

    const visitFunction = (t: TypeFunction): boolean => {
        // D: `foreach (i, fparam; t.parameterList) { … }` — ParameterList exposes `opApply` with
        // D's control-code protocol (05 §11 / 06 §1.8): 0 continues, non-zero stops. The index is
        // unused by the body.
        let found = false;
        t.parameterList.opApply((_i: number, fparam: Parameter): number => {
            if (reliesOnTemplateParameters(fparam.type, tparams)) {
                found = true;
                return 1;
            }
            return 0;
        });
        if (found)
            return true;
        return reliesOnTemplateParameters(t.next, tparams);
    };

    const visitIdentifier = (t: TypeIdentifier): boolean => {
        for (const tp of tparams) {
            if (tp!.ident!.equals(t.ident!))
                return true;
        }
        return false;
    };

    const visitInstance = (t: TypeInstance): boolean => {
        for (const tp of tparams) {
            if (t.tempinst!.name === tp!.ident)
                return true;
        }

        const tiargs = t.tempinst!.tiargs;
        if (tiargs !== null) {
            for (const arg of tiargs) {
                const ta = isType(arg);
                if (ta !== null) {
                    if (reliesOnTemplateParameters(ta, tparams))
                        return true;
                }
            }
        }

        return false;
    };

    const visitTypeof = (t: TypeTypeof): boolean => {
        return reliesOnTemplateParametersExp(t.exp!, tparams);
    };

    const visitTuple = (t: TypeTuple): boolean => {
        if (t.arguments !== null) {
            for (const arg of t.arguments) {
                if (reliesOnTemplateParameters(arg!.type, tparams))
                    return true;
            }
        }

        return false;
    };

    if (t === null)
        return false;

    const tb = toBasetype(t);
    switch (tb.ty) {
        case TY.Tvector:   return visitVector(tb.isTypeVector()!);
        case TY.Taarray:   return visitAArray(tb.isTypeAArray()!);
        case TY.Tfunction: return visitFunction(tb.isTypeFunction()!);
        case TY.Tident:    return visitIdentifier(tb.isTypeIdentifier()!);
        case TY.Tinstance: return visitInstance(tb.isTypeInstance()!);
        case TY.Ttypeof:   return visitTypeof(tb.isTypeTypeof()!);
        case TY.Ttuple:    return visitTuple(tb.isTypeTuple()!);
        case TY.Tenum:     return false;
        // D: `tb.nextOf().reliesOnTemplateParameters(tparams)` — UFCS on the free function above,
        // so a null `nextOf()` is NOT a fault: it falls into the `t === null` guard and returns
        // false, exactly as in D.
        default:           return reliesOnTemplateParameters(nextOf(tb), tparams);
    }
}

/***********************************************************
 * dmd/templatesem.d:182 — Check whether the expression representation relies on one or more the
 * template parameters.
 * Params:
 *      e           = expression to test
 *      tparams     = Template parameters.
 * Returns:
 *      true if it does
 *
 * D module-private. RENAMED from `reliesOnTemplateParameters` (04 §1B, Form B) — see the Type
 * overload above for the decision.
 */
function reliesOnTemplateParametersExp(e: Expression, tparams: (TemplateParameter | null)[]): boolean {
    // dmd/templatesem.d:184 — `extern (C++) final class ReliesOnTemplateParameters : Visitor`.
    // Idiom A (13 §7 census: templatesem.d HAS visitor classes). One named method per D `visit`
    // overload (13 §1); `alias visit = Visitor.visit;` dropped — no overload hiding in TS.
    // It captures nothing from the enclosing function (`tparams` arrives through its ctor) but
    // stays nested for 1:1 fidelity.
    class ReliesOnTemplateParameters extends Visitor {
        tparams: (TemplateParameter | null)[];
        result = false;

        constructor(tparams: (TemplateParameter | null)[]) {
            super();
            this.tparams = tparams;
        }

        /// dmd/templatesem.d:196 — body is a commented-out printf only.
        override visitExpression(_e: Expression): void {
        }

        /// dmd/templatesem.d:201
        override visitIdentifierExp(e: IdentifierExp): void {
            for (const tp of this.tparams) {
                if (e.ident === tp!.ident) {
                    this.result = true;
                    return;
                }
            }
        }

        /// dmd/templatesem.d:213
        override visitTupleExp(e: TupleExp): void {
            if (e.exps !== null) {
                for (const ea of e.exps) {
                    ea!.accept(this);
                    if (this.result)
                        return;
                }
            }
        }

        /// dmd/templatesem.d:226
        override visitArrayLiteralExp(e: ArrayLiteralExp): void {
            if (e.elements !== null) {
                for (const el of e.elements) {
                    el!.accept(this);
                    if (this.result)
                        return;
                }
            }
        }

        /// dmd/templatesem.d:239
        override visitAssocArrayLiteralExp(e: AssocArrayLiteralExp): void {
            for (const ek of e.keys!) {
                ek!.accept(this);
                if (this.result)
                    return;
            }
            for (const ev of e.values!) {
                ev!.accept(this);
                if (this.result)
                    return;
            }
        }

        /// dmd/templatesem.d:256
        override visitStructLiteralExp(e: StructLiteralExp): void {
            if (e.elements !== null) {
                for (const ea of e.elements) {
                    ea!.accept(this);
                    if (this.result)
                        return;
                }
            }
        }

        /// dmd/templatesem.d:269
        override visitTypeExp(e: TypeExp): void {
            this.result = reliesOnTemplateParameters(e.type, this.tparams);
        }

        /// dmd/templatesem.d:275
        override visitNewExp(e: NewExp): void {
            if (e.placement !== null)
                e.placement.accept(this);
            if (e.thisexp !== null)
                e.thisexp.accept(this);
            this.result = reliesOnTemplateParameters(e.newtype, this.tparams);
            if (!this.result && e.arguments_ !== null) {
                for (const ea of e.arguments_) {
                    ea!.accept(this);
                    if (this.result)
                        return;
                }
            }
        }

        /// dmd/templatesem.d:295
        override visitNewAnonClassExp(_e: NewAnonClassExp): void {
            this.result = true;
        }

        /// dmd/templatesem.d:301
        override visitFuncExp(_e: FuncExp): void {
            this.result = true;
        }

        /// dmd/templatesem.d:307
        override visitTypeidExp(e: TypeidExp): void {
            const ea = isExpression(e.obj);
            if (ea !== null) {
                ea.accept(this);
            } else {
                const ta = isType(e.obj);
                if (ta !== null)
                    this.result = reliesOnTemplateParameters(ta, this.tparams);
            }
        }

        /// dmd/templatesem.d:315
        override visitTraitsExp(e: TraitsExp): void {
            if (e.args !== null) {
                for (const oa of e.args) {
                    const ea = isExpression(oa);
                    if (ea !== null) {
                        ea.accept(this);
                    } else {
                        const ta = isType(oa);
                        if (ta !== null)
                            this.result = reliesOnTemplateParameters(ta, this.tparams);
                    }
                    if (this.result)
                        return;
                }
            }
        }

        /// dmd/templatesem.d:332
        override visitIsExp(e: IsExp): void {
            this.result = reliesOnTemplateParameters(e.targ, this.tparams);
        }

        /// dmd/templatesem.d:338
        override visitUnaExp(e: UnaExp): void {
            e.e1!.accept(this);
        }

        /// dmd/templatesem.d:344
        override visitDotTemplateInstanceExp(e: DotTemplateInstanceExp): void {
            this.visitUnaExp(e.isUnaExp()!);   // D: `visit(e.isUnaExp());` — a forwarding call (13 §4)
            if (!this.result) {
                // D: `if (!result && e.ti.tiargs)` — the `&&` short-circuit is kept by nesting.
                const tiargs = e.ti!.tiargs;
                if (tiargs !== null) {
                    for (const oa of tiargs) {
                        const ea = isExpression(oa);
                        if (ea !== null) {
                            ea.accept(this);
                        } else {
                            const ta = isType(oa);
                            if (ta !== null)
                                this.result = reliesOnTemplateParameters(ta, this.tparams);
                        }
                        if (this.result)
                            return;
                    }
                }
            }
        }

        /// dmd/templatesem.d:360
        override visitCallExp(e: CallExp): void {
            this.visitUnaExp(e.isUnaExp()!);
            if (!this.result && e.arguments_ !== null) {
                for (const ea of e.arguments_) {
                    ea!.accept(this);
                    if (this.result)
                        return;
                }
            }
        }

        /// dmd/templatesem.d:374
        override visitCastExp(e: CastExp): void {
            this.visitUnaExp(e.isUnaExp()!);
            // e.to can be null for cast() with no type
            if (!this.result && e.to !== null)
                this.result = reliesOnTemplateParameters(e.to, this.tparams);
        }

        /// dmd/templatesem.d:383
        override visitSliceExp(e: SliceExp): void {
            this.visitUnaExp(e.isUnaExp()!);
            if (!this.result && e.lwr !== null)
                e.lwr.accept(this);
            if (!this.result && e.upr !== null)
                e.upr.accept(this);
        }

        /// dmd/templatesem.d:393
        override visitIntervalExp(e: IntervalExp): void {
            e.lwr!.accept(this);
            if (!this.result)
                e.upr!.accept(this);
        }

        /// dmd/templatesem.d:401
        override visitArrayExp(e: ArrayExp): void {
            this.visitUnaExp(e.isUnaExp()!);
            if (!this.result && e.arguments_ !== null) {
                for (const ea of e.arguments_)
                    ea!.accept(this);
            }
        }

        /// dmd/templatesem.d:411
        override visitBinExp(e: BinExp): void {
            e.e1!.accept(this);
            if (!this.result)
                e.e2!.accept(this);
        }

        /// dmd/templatesem.d:418
        override visitCondExp(e: CondExp): void {
            e.econd!.accept(this);
            if (!this.result)
                this.visitBinExp(e.isBinExp()!);
        }
    }

    // D: `scope ReliesOnTemplateParameters v = new …` — `scope` is a lifetime annotation, erased.
    const v = new ReliesOnTemplateParameters(tparams);
    e.accept(v);
    return v.result;
}

/**
 * dmd/templatesem.d:441 — `void computeOneMember(TemplateDeclaration td)`.
 *
 * 1.43 made the `onemember` / `isTrivialAlias(Seq)` computation LAZY: 1.42 did it eagerly in the
 * `TemplateDeclaration` constructor (dtemplate.d:318-363). Every reader of `td.onemember` must be
 * preceded by a `computeOneMember(td)` call D places explicitly; the guard is the new
 * `TemplateDeclaration.haveComputedOneMember` field.
 *
 * Preconditions: none — `td` may be null (the body tests it). Idempotent.
 */
export function computeOneMember(td: TemplateDeclaration | null): void {
    if (td === null || td.haveComputedOneMember)
        return;

    // D: `if (td && td.members && td.ident)` — the `td &&` is dead after the guard above and is
    // dropped (TS would flag it as always-truthy); the two remaining tests are verbatim.
    if (td.members !== null && td.ident !== null) {
        // D: `Dsymbol s;` + `oneMembers(td.members, s, td.ident)` — `s` is a `ref`/out slot, so it
        // is boxed (03 §3.3).
        const s: { value: Dsymbol | null } = { value: null };
        if (oneMembers(td.members, s, td.ident) && s.value !== null) {
            td.onemember = s.value;
            s.value.parent = td;
            computeIsTrivialAlias(td, s.value);
        }
        td.haveComputedOneMember = true;
    }
}

/** dmd/templatesem.d:459 — `private void computeIsTrivialAlias(TemplateDeclaration td, Dsymbol s)`. */
function computeIsTrivialAlias(td: TemplateDeclaration, s: Dsymbol): void {
    /* Set isTrivialAliasSeq if this fits the pattern:
     *   template AliasSeq(T...) { alias AliasSeq = T; }
     * or set isTrivialAlias if this fits the pattern:
     *   template Alias(T) { alias Alias = qualifiers(T); }
     */
    if (!(td.parameters !== null && td.parameters.length === 1))
        return;

    const ad = s.isAliasDeclaration();
    if (ad === null || ad.type === null)
        return;

    const ti = ad.type.isTypeIdentifier();

    if (ti === null || ti.idents.length !== 0)
        return;

    const ttpTuple = td.parameters.opIndex(0)!.isTemplateTupleParameter();
    if (ttpTuple !== null) {
        if (ti.ident === ttpTuple.ident &&
            ti.mod === 0) {
            td.isTrivialAliasSeq = true;
        }
    } else {
        const ttpType = td.parameters.opIndex(0)!.isTemplateTypeParameter();
        if (ttpType !== null) {
            if (ti.ident === ttpType.ident) {
                td.isTrivialAlias = true;
            }
        }
    }
}

/**
 * dmd/templatesem.d:497 — `bool declareParameter(TemplateParameter _this, Scope* sc)`.
 *
 * 1.43 replaced 1.42's virtual-method set (`abstract bool TemplateParameter.declareParameter`
 * with four overrides, dtemplate.d:903/:956/:1059/:1136/:1189) with THIS free function holding
 * four nested `static` helpers and an explicit `isTemplateXxxParameter()` if-chain. The virtual
 * dispatch is gone; do NOT expect `TemplateParameter.declareParameter` to exist in dtemplate.ts,
 * and do NOT promote this back onto the class (04 §6 anti-pattern).
 *
 * OVERLOAD SET (04 §1B): the second D `declareParameter` (templatesem.d:5258, four params,
 * `RootObject` return) is renamed `declareParameterWithValue` in chunk 2; THIS two-argument
 * public entry keeps the verbatim name.
 *
 * Returns: true if the parameter was inserted into `sc` (false = multiply defined).
 */
export function declareParameter(_this: TemplateParameter, sc: Scope): boolean {
    const typeDeclareParameter = (_this: TemplateTypeParameter, sc: Scope): boolean => {
        const ti = new TypeIdentifier(_this.loc, _this.ident);
        const ad = AliasDeclaration.fromType(_this.loc, _this.ident!, ti);
        return insert(sc, ad) !== null;
    };

    const valueDeclareParameter = (_this: TemplateValueParameter, sc: Scope): boolean => {
        /*
            Do type semantic earlier.

            This means for certain erroneous value parameters
            their "type" can be known earlier and thus a better
            error message given.

            For example:
            `template test(x* x) {}`
            now yields "undefined identifier" rather than the opaque
            "variable `x` is used as a type".
         */
        if (_this.valType !== null)
            _this.valType = typeSemantic(_this.valType, _this.loc, sc);
        const v = new VarDeclaration(_this.loc, _this.valType, _this.ident!, null);
        v.storage_class = STC.templateparameter;
        return insert(sc, v) !== null;
    };

    const aliasDeclareParameter = (_this: TemplateAliasParameter, sc: Scope): boolean => {
        const ti = new TypeIdentifier(_this.loc, _this.ident);
        const ad = AliasDeclaration.fromType(_this.loc, _this.ident!, ti);
        return insert(sc, ad) !== null;
    };

    const tupleDeclareParameter = (_this: TemplateTupleParameter, sc: Scope): boolean => {
        const ti = new TypeIdentifier(_this.loc, _this.ident);
        const ad = AliasDeclaration.fromType(_this.loc, _this.ident!, ti);
        return insert(sc, ad) !== null;
    };

    const tp = _this.isTemplateTypeParameter();
    if (tp !== null)
        return typeDeclareParameter(tp, sc);
    const vp = _this.isTemplateValueParameter();
    if (vp !== null)
        return valueDeclareParameter(vp, sc);
    const ap = _this.isTemplateAliasParameter();
    if (ap !== null)
        return aliasDeclareParameter(ap, sc);
    const tup = _this.isTemplateTupleParameter();
    if (tup !== null)
        return tupleDeclareParameter(tup, sc);

    assertUnreachable(); // D: `assert(0); // unreachable`
}

/************************************
 * dmd/templatesem.d:557 — Return hash of Objects. D module-private.
 *
 * `ref Objects oa1` is an ALIAS (03 §3.2) — no `.copy()` at any call site.
 * Domain: `size_t` -> bigint; see the header's "RECORDED SUBSTITUTION ACTS" §3.
 */
function arrayObjectHash(oa1: Objects): bigint {
    // D's function-local `import dmd.root.hash : mixHash;` (:560) is hoisted to the top (01 §4.4).
    let hash = 0n;
    for (const o1 of oa1) {
        /* Must follow the logic of match()
         */
        const t1 = isType(o1);
        if (t1 !== null) {
            // D: `mixHash(hash, cast(size_t)t1.deco)` — `deco` is an INTERNED `const(char)*`, so
            // its address is a per-distinct-deco identity; `Type.getUniqueID()` (mtype.d:593) is
            // the tree's canonical stand-in for exactly that value (0 when `deco` is null).
            hash = mixHash(hash, BigInt(t1.getUniqueID()));
            continue;
        }
        const e1 = getExpression(o1);
        if (e1 !== null) {
            hash = mixHash(hash, expressionHash(e1));
            continue;
        }
        let s1 = isDsymbol(o1);
        if (s1 !== null) {
            const fa1 = s1.isFuncAliasDeclaration();
            if (fa1 !== null)
                s1 = fa1.toAliasFunc();
            hash = mixHash(hash, mixHash(BigInt(objId(s1.getIdent())), BigInt(objId(s1.parent))));
            continue;
        }
        const u1 = isTuple(o1);
        if (u1 !== null)
            hash = mixHash(hash, arrayObjectHash(u1.objects));
    }
    return hash;
}

/************************************
 * dmd/templatesem.d:587 — Computes hash of expression. D module-private.
 *
 * Handles all Expression classes and MUST match their equals method,
 * i.e. e1.equals(e2) implies expressionHash(e1) == expressionHash(e2).
 *
 * That contract survives the pointer-identity substitution: equal references get equal `objId`s.
 */
function expressionHash(e: Expression): bigint {
    // D's function-local imports (:589 `dmd.root.ctfloat : CTFloat`, `dmd.root.hash : calcHash,
    // mixHash`) are hoisted to the top (01 §4.4).

    // DISPATCH SWITCH (S2) — emitted IN FULL, every arm present (13 §7.5 rule 1).
    switch (e.op) {
    case EXP.int64:
        // D: `cast(size_t) e.isIntegerExp().getInteger()` — a 64-bit truncation, exact here.
        return BigInt.asUintN(64, e.isIntegerExp()!.getInteger());

    case EXP.float64:
        return BigInt(CTFloat.hash(e.isRealExp()!.value));

    case EXP.complex80: {
        const ce = e.isComplexExp()!;
        return mixHash(BigInt(CTFloat.hash(toReal(ce))), BigInt(CTFloat.hash(toImaginary(ce))));
    }

    case EXP.identifier:
        return BigInt(objId(e.isIdentifierExp()!.ident));

    case EXP.null_:
        return BigInt(objId(e.isNullExp()!.type));

    case EXP.string_:
        return BigInt(calcHash(e.isStringExp()!.peekData()));

    case EXP.tuple:
    {
        const te = e.isTupleExp()!;
        let hash = 0n;
        hash = BigInt.asUintN(64, hash + (te.e0 !== null ? expressionHash(te.e0) : 0n));
        for (const elem of te.exps!)
            hash = mixHash(hash, expressionHash(elem!));
        return hash;
    }

    case EXP.arrayLiteral:
    {
        const ae = e.isArrayLiteralExp()!;
        let hash = 0n;
        for (let i = 0; i < ae.elements!.length; i++)
            hash = mixHash(hash, expressionHash(ae.opIndex(i)!));
        return hash;
    }

    case EXP.assocArrayLiteral:
    {
        const ae = e.isAssocArrayLiteralExp()!;
        let hash = 0n;
        for (let i = 0; i < ae.keys!.length; i++)
            // reduction needs associative op as keys are unsorted (use XOR)
            hash ^= mixHash(expressionHash(ae.keys!.opIndex(i)!), expressionHash(ae.values!.opIndex(i)!));
        return hash;
    }

    case EXP.structLiteral:
    {
        const se = e.isStructLiteralExp()!;
        let hash = 0n;
        for (const elem of se.elements!)
            hash = mixHash(hash, elem !== null ? expressionHash(elem) : 0n);
        return hash;
    }

    case EXP.variable:
        return BigInt(objId(e.isVarExp()!.var_));

    case EXP.function_:
        return BigInt(objId(e.isFuncExp()!.fd));

    default:
        // no custom equals for this expression
        // equals based on identity
        return BigInt(objId(e));
    }
}

/************************************
 * dmd/templatesem.d:669 — `struct TemplateInstanceBox`.
 *
 * This struct is needed for TemplateInstance to be the key in an associative array.
 * Fixing https://issues.dlang.org/show_bug.cgi?id=15813 would make it unnecessary.
 *
 * VALUE type (02 §2 / 03): `.copy()` is emitted per 03 §2. `toHash`/`opEquals` are the AA-key
 * hooks (05 §13) `TemplateInstanceTable` above resolves with. Exported because dmd/traits.d:51
 * imports it.
 */
export class TemplateInstanceBox {
    ti: TemplateInstance;
    hash: bigint;   // size_t — cached result of toHash()

    /// dmd/templatesem.d:676 — `this(TemplateInstance ti)`.
    constructor(ti: TemplateInstance) {
        this.ti = ti;
        // D: `hash = cast(size_t)cast(void*)this.ti.enclosing;` — pointer identity, see the
        // header's "RECORDED SUBSTITUTION ACTS" §2.
        let hash = BigInt(objId(this.ti.enclosing));
        hash = BigInt.asUintN(64, hash + arrayObjectHash(this.ti.tdtypes));
        // D: `hash += hash == 0;` — a bool added as an integer, evaluated AFTER the line above.
        hash = BigInt.asUintN(64, hash + (hash === 0n ? 1n : 0n));
        this.hash = hash;
    }

    /// dmd/templatesem.d:682
    toHash(): bigint {
        assert(this.hash !== 0n);
        return this.hash;
    }

    /// dmd/templatesem.d:688 — `bool opEquals(ref const TemplateInstanceBox s)`. `ref` = alias.
    opEquals(s: TemplateInstanceBox): boolean {
        let res: boolean;
        if (this.ti.inst !== null && s.ti.inst !== null) {
            /* This clause is only used when an instance with errors
             * is replaced with a correct instance.
             */
            res = this.ti === s.ti;
        } else {
            /* Used when a proposed instance is used to see if there's
             * an existing instance.
             */
            // resolved: `static if (__VERSION__ < 2099)` -> __VERSION__ == 2113, so the ELSE
            // branch is live (templatesem.d:703-706).
            res = equalsx(this.ti, s.ti);
        }

        // dropped: `debug (FindExistingInstance) ++(res ? nHits : nCollisions);` (:709) — debug OFF.
        return res;
    }

    /// 03 §2: `ti` is a class reference (shared); `hash` is a value field.
    copy(): TemplateInstanceBox {
        const c = new TemplateInstanceBox(this.ti);
        c.hash = this.hash;
        return c;
    }
}

/************************************
 * dmd/templatesem.d:731 — Perform semantic analysis on template.
 * Params:
 *      sc = context
 *      tempdecl = template declaration
 *
 * `sc` is typed nullable: the body null-tests it (`if (!sc) return;`) after possibly reassigning
 * it from `tempdecl._scope` (02 §10.1).
 */
export function templateDeclarationSemantic(sc: Scope | null, tempdecl: TemplateDeclaration): void {
    // resolved: `enum log = false;` (:733) -> the `static if (log)` printf block is dropped.
    if (tempdecl.semanticRun !== PASS.initial)
        return; // semantic() already run

    if (tempdecl._scope !== null) {
        sc = tempdecl._scope;
        tempdecl._scope = null;
    }
    if (sc === null)
        return;
    // `sc` is not reassigned past this point, so TS's narrowing to non-null holds for the rest of
    // the body — no cursor local is needed (02 §10.1).

    // dropped: `import dmd.timetrace; timeTraceBeginEvent(TimeTraceEventType.sema1TemplateDecl);
    //          scope (exit) timeTraceEndEvent(TimeTraceEventType.sema1TemplateDecl, tempdecl);`
    //          (templatesem.d:751-753) — `dmd.timetrace` is a PROFILING module with no semantic
    //          effect and no port. Same disposition as every other timetrace site in the tree
    //          (dmodule.ts:828, dsymbolsem.ts:4017/:4466, funcsem.ts:454, semantic2.ts:582,
    //          semantic3.ts:318). Dropping the begin event and its `scope (exit)` end event
    //          TOGETHER keeps the guard balanced, so no try/finally is needed either.
    // Remember templates defined in module object that we need to know about
    if (sc._module !== null && sc._module.ident === Id.object) {
        if (tempdecl.ident === Id.RTInfo)
            Type.rtinfo = tempdecl;
        // resolved: IN_LLVM -> ON, `IN_LLVM && …` folds to the bare condition (:759).
        if (tempdecl.ident === Id.RTInfoImpl)
            Type.rtinfoImpl = tempdecl;
    }

    /* Remember Scope for later instantiations, but make
     * a copy since attributes can change.
     */
    if (tempdecl._scope === null) {
        tempdecl._scope = sc.copy();
        tempdecl._scope.setNoFree();
    }

    tempdecl.semanticRun = PASS.semantic;

    tempdecl.parent = sc.parent;
    tempdecl.visibility = sc.visibility.copy();   // value-struct field store (03 §1 #5)
    // `Dsymbol.userAttribDecl` / `.cppnamespace` are D `@property` PAIRS over `DsymbolAttributes`
    // (dsymbol.d:663/:661), so the port spells the setters `*_set` (dsymbol.ts:672/:676).
    tempdecl.userAttribDecl_set(sc.userAttribDecl);
    tempdecl.cppnamespace_set(sc.namespace);
    tempdecl.isstatic = tempdecl.toParent()!.isModule() !== null
        || (tempdecl._scope.stc & STC.static_) !== 0n;
    tempdecl.deprecated_ = (sc.stc & STC.deprecated_) !== 0n;

    checkGNUABITag(tempdecl, sc.linkage);

    if (!tempdecl.isstatic) {
        // D: `tempdecl.parent.pastMixin().isAggregateDeclaration()` — the `!`s mark exactly the
        // points D would fault on null (02 §10.1).
        const ad = tempdecl.parent!.pastMixin()!.isAggregateDeclaration();
        if (ad !== null)
            makeNested(ad);
    }

    // Set up scope for parameters
    const paramsym = new ScopeDsymbol();
    paramsym.parent = tempdecl.parent;
    const paramscope = sc.push(paramsym);
    paramscope.stc = STC.none;

    if (global.params.ddoc.doOutput) {
        tempdecl.origParameters = new DArray<TemplateParameter | null>(tempdecl.parameters!.length);
        for (let i = 0; i < tempdecl.parameters!.length; i++) {
            const tp = tempdecl.parameters!.opIndex(i)!;
            tempdecl.origParameters.opIndexAssign(tp.syntaxCopy(), i);
        }
    }
    for (let i = 0; i < tempdecl.parameters!.length; i++) {
        const tp = tempdecl.parameters!.opIndex(i)!;
        if (!declareParameter(tp, paramscope)) {
            error(tp.loc, ds("parameter `%s` multiply defined"), tp.ident!.toChars());
            tempdecl.errors = true;
        }
        if (!tpsemantic(tp, paramscope, tempdecl.parameters)) {
            tempdecl.errors = true;
        }
        if (i + 1 !== tempdecl.parameters!.length && tp.isTemplateTupleParameter() !== null) {
            computeOneMember(tempdecl); // for .kind
            error(tempdecl.loc, ds("%s `%s` template sequence parameter must be the last one"),
                tempdecl.kind(), tempdecl.toPrettyChars());
            tempdecl.errors = true;
        }
    }

    /* Calculate TemplateParameter.dependent
     */
    // D: `auto tparams = TemplateParameters(1);` — a VALUE container, born pre-sized to 1.
    const tparams: TemplateParameters = new DArray<TemplateParameter | null>(1);
    for (let i = 0; i < tempdecl.parameters!.length; i++) {
        const tp = tempdecl.parameters!.opIndex(i)!;
        tparams.opIndexAssign(tp, 0);

        for (let j = 0; j < tempdecl.parameters!.length; j++) {
            // Skip cases like: X(T : T)
            if (i === j)
                continue;

            const ttp = tempdecl.parameters!.opIndex(j)!.isTemplateTypeParameter();
            if (ttp !== null) {
                if (reliesOnTident(ttp.specType, tparams))
                    tp.dependent = true;
            } else {
                const tap = tempdecl.parameters!.opIndex(j)!.isTemplateAliasParameter();
                if (tap !== null) {
                    if (reliesOnTident(tap.specType, tparams) ||
                        reliesOnTident(isType(tap.specAlias), tparams)) {
                        tp.dependent = true;
                    }
                }
            }
        }
    }

    paramscope.pop();

    // Compute again
    tempdecl.onemember = null;
    // D does NOT clear `haveComputedOneMember` here (templatesem.d:857-858), so this call is a
    // no-op on the one path that already computed above (:818, an error path). Reproduced verbatim.
    computeOneMember(tempdecl);
    /* BUG: should check:
     *  1. template functions must not introduce virtual functions, as they
     *     cannot be accomodated in the vtbl[]
     *  2. templates cannot introduce non-static data members (i.e. fields)
     *     as they would change the instance size of the aggregate.
     */

    tempdecl.semanticRun = PASS.semanticdone;
}

/**
 * dmd/templatesem.d:1083 — `extern (C++) final class InstMemberWalker : Visitor`, declared by D inside the swap
 * block of `templateInstanceSemantic`; hoisted to module scope because the kept-module engine walks a kept
 * instance's members with it too (`keptInstanceMatch`, and its creation emulation in src/keep.ts). Idiom A
 * (13 §1); `alias visit = Visitor.visit;` dropped. Every member's `_scope.minst` becomes `inst.minst`.
 */
class InstMemberWalker extends Visitor {
    inst: TemplateInstance;

    constructor(inst: TemplateInstance) {
        super();
        this.inst = inst;
    }

    /// dmd/templatesem.d:1092
    override visitDsymbol(d: Dsymbol): void {
        if (d._scope !== null)
            d._scope.minst = this.inst.minst;
    }

    /// dmd/templatesem.d:1098
    override visitScopeDsymbol(sds: ScopeDsymbol): void {
        foreachDsymbolVoid(sds.members, (s) => s.accept(this));
        this.visitDsymbol(sds);   // D: `visit(cast(Dsymbol)sds);` (13 §4)
    }

    /// dmd/templatesem.d:1104
    override visitStructDeclaration(sd: StructDeclaration): void {
        // need to visit auto-generated methods as well
        // D: `visit(sd.xeq)` binds the INHERITED `visit(FuncDeclaration)` overload,
        // which forwards down the base chain to this class's `visit(Dsymbol)`.
        if (sd.xeq !== null) this.visitFuncDeclaration(sd.xeq);
        if (sd.xcmp !== null) this.visitFuncDeclaration(sd.xcmp);
        if (sd.xhash !== null) this.visitFuncDeclaration(sd.xhash);
        // D: `visit(cast(ScopeDsymbol)sd);`
        this.visitScopeDsymbol(sd);
    }

    /// dmd/templatesem.d:1112
    override visitAttribDeclaration(ad: AttribDeclaration): void {
        foreachDsymbolVoid(include(ad, null), (s) => s.accept(this));
        this.visitDsymbol(ad);   // D: `visit(cast(Dsymbol)ad);`
    }

    /// dmd/templatesem.d:1118
    override visitConditionalDeclaration(cd: ConditionalDeclaration): void {
        // D: `if (cd.condition.inc)` — enum truthiness expanded (06 §2.5 / 09 §9);
        // `Include.notComputed` is the 0 member (cond.ts:64).
        if (cd.condition.inc !== Include.notComputed)
            this.visitAttribDeclaration(cd);   // D: `visit(cast(AttribDeclaration)cd);`
        else
            this.visitDsymbol(cd);             // D: `visit(cast(Dsymbol)cd);`
    }
}

/** The kept-module engine (src/keep.ts): runs `InstMemberWalker` over a kept instance created anew. */
export function walkInstanceScopes(inst: TemplateInstance): void {
    inst.accept(new InstMemberWalker(inst));
}

/**
 * The kept-module engine (src/keep.ts): the match path of dmd/templatesem.d:1015-1158 for a replayed request of an
 * instance this compile already created. A replayed request has no requesting node, only the fields the request
 * gave it (`minst`, `tinst`, `gagged`), so the path is spelled for the primary alone: the requester's half of the
 * swap and the `tnext` link (codegen only, dmd/templatesem.d:1036) have nothing to act on.
 */
export function keptInstanceMatch(inst: TemplateInstance, minst: Module | null, tinst: TemplateInstance | null,
    gagged: boolean): void {
    // dmd/templatesem.d:1029 — `tempinst.inst.gagged = tempinst.gagged;` (when the first one was gagged)
    if (inst.gagged)
        inst.gagged = gagged;
    // dmd/templatesem.d:1052 — the swap; the requester's minst becomes the primary's old one (:1070)
    let requesterMinst = minst;
    if (minst !== null && minst.isRoot() && !(inst.minst !== null && inst.minst.isRoot())) {
        requesterMinst = inst.minst;
        inst.minst = minst;
        inst.tinst = tinst;
        inst.accept(new InstMemberWalker(inst));
        if (global.params.linkonceTemplates === LinkonceTemplates.aggressive)
            appendToModuleMember(inst);
        else if (!global.params.allInst && requesterMinst !== null)
            appendToModuleMember(inst);
    }
    // dmd/templatesem.d:1153 — the instantiating module gets the modules the instance imported
    if (requesterMinst !== null) {
        for (const imp of inst.importedModules) {
            if (!requesterMinst.aimports.contains(imp))
                requesterMinst.aimports.push(imp);
        }
    }
}

/**
 * dmd/templatesem.d:869 — `void templateInstanceSemantic(TemplateInstance tempinst, Scope* sc,
 * ArgumentList argumentList)`.
 *
 * `sc` dereferenced unconditionally -> non-null (02 §10.1). `argumentList` is a by-value struct
 * param, so every call site copies (03 §1 #2).
 */
export function templateInstanceSemantic(tempinst: TemplateInstance, sc: Scope, argumentList: ArgumentList): void {
    // the kept-module engine (src/keep.ts, CREATION EMULATION): true while the creation path below runs on a kept
    // instance this request creates; the steps whose results its kept members already hold are skipped
    let keptCreate = false;
    // dropped: `version (none)` block (:872-885) — OFF.
    // resolved: `static if (LOG)` (:887, :893, :899, :928, :1155, :1160, :1198, :1215, :1245, :1257,
    //           :1459) -> LOG == false, all printf blocks dropped.
    if (tempinst.inst !== null) // if semantic() was already run
        return;

    if (tempinst.semanticRun !== PASS.initial) {
        // D: `auto ungag = Ungag(global.gag);` — a value struct whose ~this() restores
        // `global.gag`; TS has no destructor, so the caller spells the guard (06 §7.1,
        // dsymbolsem.ts Ungag doc).
        const ungag = new Ungag(global.gag);
        try {
            if (!tempinst.gagged)
                global.gag = 0;
            error(tempinst.loc, ds("%s `%s` recursive template expansion"),
                tempinst.kind(), tempinst.toPrettyChars());
            if (tempinst.gagged)
                tempinst.semanticRun = PASS.initial;
            else
                tempinst.inst = tempinst;
            tempinst.errors = true;
            return;
        } finally {
            global.gag = ungag.oldgag;   // D's ~Ungag()
        }
    }

    // dropped: `timeTraceBeginEvent(TimeTraceEventType.sema1TemplateInstance);
    //          scope (exit) timeTraceEndEvent(TimeTraceEventType.sema1TemplateInstance, tempinst,
    //              () => tempinst.toPrettyChars().toDString());` (templatesem.d:916-918) — see the
    //          note on `templateDeclarationSemantic`: profiling only, dropped as a balanced pair.
    // Get the enclosing template instance from the scope tinst
    tempinst.tinst = sc.tinst;
    // Get the instantiating module from the scope minst
    tempinst.minst = sc.minst;
    // https://issues.dlang.org/show_bug.cgi?id=10920
    // If the enclosing function is non-root symbol,
    // this instance should be speculative.
    if (tempinst.tinst === null && sc.func !== null && sc.func.inNonRoot()) {
        tempinst.minst = null;
    }

    tempinst.gagged = (global.gag > 0);

    tempinst.semanticRun = PASS.semantic;

    /* Find template declaration first,
     * then run semantic on each argument (place results in tiargs[]),
     * last find most specialized template from overload list/set.
     */
    // goto Lerror; — BAIL tail (06 §4). Captures `tempinst`; declared before first use.
    const LerrorTail = (): void => {
        if (tempinst.gagged) {
            // https://issues.dlang.org/show_bug.cgi?id=13220
            // Roll back status for later semantic re-running
            tempinst.semanticRun = PASS.initial;
        } else
            tempinst.inst = tempinst;
        tempinst.errors = true;
    };
    if (!findTempDecl(tempinst, sc, null) || !semanticTiargs(tempinst, sc)
        || !findBestMatch(tempinst, sc, argumentList.copy())) {
        return LerrorTail();   // Lerror: reached by fall-through (dmd/templatesem.d:944)
    }
    const tempdecl = tempinst.tempdecl!.isTemplateDeclaration()!;
    assert(tempdecl !== null);

    if (global.params.v.templates)
        TemplateStats.incInstance(tempdecl, tempinst, global.params.v.templatesListInstances);

    checkDeprecated(tempdecl, tempinst.loc, sc);

    // If tempdecl is a mixin, disallow it
    if (tempdecl.ismixin) {
        error(tempinst.loc, ds("%s `%s` mixin templates are not regular templates"),
            tempinst.kind(), tempinst.toPrettyChars());
        return LerrorTail();   // goto Lerror; (dmd/templatesem.d:969)
    }

    hasNestedArgs(tempinst, tempinst.tiargs!, tempdecl.isstatic);
    if (tempinst.errors)
        return LerrorTail();   // goto Lerror; (dmd/templatesem.d:974)

    // Copy the tempdecl namespace (not the scope one)
    // `cppnamespace` is a D `@property` pair (dsymbol.d:661) — getter call + `*_set` setter.
    tempinst.cppnamespace_set(tempdecl.cppnamespace());
    if (tempinst.cppnamespace() !== null)
        dsymbolSemantic(tempinst.cppnamespace()!, sc);

    /* Greatly simplified semantic processing for AliasSeq templates
     */
    if (tempdecl.isTrivialAliasSeq) {
        tempinst.inst = tempinst;
        return aliasSeqInstanceSemantic(tempinst, sc, tempdecl);
    }

    /* Greatly simplified semantic processing for Alias templates
     */
    else if (tempdecl.isTrivialAlias) {
        tempinst.inst = tempinst;
        return aliasInstanceSemantic(tempinst, sc, tempdecl);
    }

    /* See if there is an existing TemplateInstantiation that already
     * implements the typeargs. If so, just refer to that one instead.
     */
    tempinst.inst = findExistingInstance(tempdecl, tempinst, argumentList.copy());
    let errinst: TemplateInstance | null = null;
    if (tempinst.inst === null) {
        // So, we need to implement 'this' instance.
    } else if (tempinst.inst.gagged && !tempinst.gagged && tempinst.inst.errors) {
        // If the first instantiation had failed, re-run semantic,
        // so that error messages are shown.
        errinst = tempinst.inst;
    } else if (K.on && keepInstMatch(tempinst)) {
        // the kept-module engine: the matched instance is kept and this is its first request in this compile, so
        // this request creates it, as a fresh compile would create `tempinst`; `tempinst` becomes a duplicate (the
        // match path's two fields below), and the creation path runs on the kept instance
        tempinst.parent = tempinst.inst.parent;
        tempinst.errors = tempinst.inst.errors;
        tempinst = tempinst.inst;
        keptCreate = true;
    } else {
        // It's a match
        tempinst.parent = tempinst.inst.parent;
        tempinst.errors = tempinst.inst.errors;

        // If both this and the previous instantiation were gagged,
        // use the number of errors that happened last time.
        global.errors += tempinst.errors ? 1 : 0;
        global.gaggedErrors += tempinst.errors ? 1 : 0;

        // If the first instantiation was gagged, but this is not:
        if (tempinst.inst.gagged) {
            // It had succeeded, mark it is a non-gagged instantiation,
            // and reuse it.
            tempinst.inst.gagged = tempinst.gagged;
        }

        // LDC: the tnext linked list is only used by TemplateInstance.needsCodegen(),
        //      which is skipped with -linkonce-templates-aggressive
        // resolved: IN_LLVM -> ON, `!(IN_LLVM && …)` folds to `!(…)` (:1034).
        if (!(global.params.linkonceTemplates === LinkonceTemplates.aggressive)) {
            tempinst.tnext = tempinst.inst.tnext;
            tempinst.inst.tnext = tempinst;
        }

        /* A module can have explicit template instance and its alias
         * in module scope (e,g, `alias Base64 = Base64Impl!('+', '/');`).
         * If the first instantiation 'inst' had happened in non-root module,
         * compiler can assume that its instantiated code would be included
         * in the separately compiled obj/lib file (e.g. phobos.lib).
         *
         * However, if 'this' second instantiation happened in root module,
         * compiler might need to invoke its codegen
         * (https://issues.dlang.org/show_bug.cgi?id=2500 & https://issues.dlang.org/show_bug.cgi?id=2644).
         * But whole import graph is not determined until all semantic pass finished,
         * so 'inst' should conservatively finish the semantic3 pass for the codegen.
         */
        if (tempinst.minst !== null && tempinst.minst.isRoot()
            && !(tempinst.inst.minst !== null && tempinst.inst.minst.isRoot())) {
            /* Swap the position of 'inst' and 'this' in the instantiation graph.
             * Then, the primary instance `inst` will be changed to a root instance,
             * along with all members of `inst` having their scopes updated.
             *
             * Before:
             *  non-root -> A!() -> B!()[inst] -> C!() { members[non-root] }
             *                      |
             *  root     -> D!() -> B!()[this]
             *
             * After:
             *  non-root -> A!() -> B!()[this]
             *                      |
             *  root     -> D!() -> B!()[inst] -> C!() { members[root] }
             */
            const mi = tempinst.minst;
            const ti = tempinst.tinst;
            tempinst.minst = tempinst.inst.minst;
            tempinst.tinst = tempinst.inst.tinst;
            tempinst.inst.minst = mi;
            tempinst.inst.tinst = ti;

            /* https://issues.dlang.org/show_bug.cgi?id=21299
               `minst` has been updated on the primary instance `inst` so it is
               now coming from a root module, however all Dsymbol `inst.members`
               of the instance still have their `_scope.minst` pointing at the
               original non-root module. We must now propagate `minst` to all
               members so that forward referenced dependencies that get
               instantiated will also be appended to the root module, otherwise
               there will be undefined references at link-time.  */
            // D: `scope v = new InstMemberWalker(tempinst.inst);` — `scope` erased.
            const v = new InstMemberWalker(tempinst.inst);
            tempinst.inst.accept(v);

            // resolved: IN_LLVM -> ON, `IN_LLVM && …` folds to the bare condition (:1131).
            if (global.params.linkonceTemplates === LinkonceTemplates.aggressive) {
                // with -linkonce-templates-aggressive, an earlier speculative or non-root instance
                // hasn't been appended to any module yet
                assert(tempinst.inst.memberOf === null);
                appendToModuleMember(tempinst.inst);
            } else if (!global.params.allInst &&
                tempinst.minst !== null) { // if inst was not speculative...
                assert(!tempinst.minst.isRoot()); // ... it was previously appended to a non-root module
                // Append again to the root module members[], so that the instance will
                // get codegen chances (depending on `tempinst.inst.needsCodegen()`).
                appendToModuleMember(tempinst.inst);
            }

            assert(tempinst.inst.memberOf !== null && tempinst.inst.memberOf.isRoot(), "no codegen chances");
        }

        // modules imported by an existing instance should be added to the module
        // that instantiates the instance.
        if (tempinst.minst !== null) {
            for (const imp of tempinst.inst.importedModules) {
                if (!tempinst.minst.aimports.contains(imp))
                    tempinst.minst.aimports.push(imp);
            }
        }

        return;
    }
    const errorsave = global.errors;

    tempinst.inst = tempinst;
    tempinst.parent = tempinst.enclosing !== null ? tempinst.enclosing : tempdecl.parent;

    if (global.params.v.templates)
        TemplateStats.incUnique(tempdecl, tempinst);

    const tempdecl_instance_idx = addInstance(tempdecl, tempinst);

    // Store the place we added it to in target_symbol_list(_idx) so we can
    // remove it later if we encounter an error.
    const target_symbol_list = appendToModuleMember(tempinst);
    const target_symbol_list_idx = target_symbol_list !== null ? target_symbol_list.length - 1 : 0;
    if (K.on) keepInstOpen(tempinst);   // the kept-module engine: records the creation, or replays a kept one

    if (!keptCreate) {
        // Copy the syntax trees from the TemplateDeclaration
        tempinst.members = Dsymbol.arraySyntaxCopy(tempdecl.members);

        // resolve TemplateThisParameter
        for (let i = 0; i < tempdecl.parameters!.length; i++) {
            if (tempdecl.parameters!.opIndex(i)!.isTemplateThisParameter() === null)
                continue;
            const t = isType(tempinst.tiargs!.opIndex(i));
            assert(t !== null);
            const stc = ModToStc(t.mod);
            if (stc !== 0n) {
                const s: Dsymbols = DArray.from<Dsymbol | null>(
                    new StorageClassDeclaration(stc, tempinst.members));
                tempinst.members = s;
            }
            break;
        }
    }

    // Create our own scope for the template parameters
    let _scope: Scope = tempdecl._scope!;
    if (tempdecl.semanticRun === PASS.initial) {
        error(tempinst.loc, ds("%s `%s` template instantiation `%s` forward references template declaration `%s`"),
            tempinst.kind(), tempinst.toPrettyChars(), tempinst.toChars(), tempdecl.toChars());
        if (K.on) keepInstClose(tempinst);   // the kept-module engine: the creation ends here
        return;
    }

    if (!keptCreate) {
        tempinst.argsym = new ScopeDsymbol();
        tempinst.argsym.parent = _scope.parent;
    }
    _scope = _scope.push(tempinst.argsym!);
    _scope.tinst = tempinst;
    _scope.minst = tempinst.minst;

    if (sc.isKnownToHaveACompileTimeContext())
        _scope.knownACompileTimeOnlyContext = true;
    _scope.deferSemantic3InCompilerHook = sc.deferSemantic3InCompilerHook;

    if (!keptCreate) {
        // Declare each template parameter as an alias for the argument type
        const paramscope = _scope.push();
        paramscope.stc = STC.none;
        // https://issues.dlang.org/show_bug.cgi?id=14169
        // template parameters should be public
        paramscope.visibility = new Visibility(Visibility.Kind.public_);
        declareParameters(tempinst, paramscope);
        paramscope.pop();

        // Add members of template instance to template instance symbol table
        tempinst.symtab = new DsymbolTable();

        foreachDsymbolVoid(tempinst.members, (s) => {
            addMember(s, _scope, tempinst);
        });
    }

    /* See if there is only one member of template instance, and that
     * member has the same name as the template instance.
     * If so, this template instance becomes an alias for that member.
     */
    if (!keptCreate && tempinst.members!.length !== 0) {
        const s: { value: Dsymbol | null } = { value: null };
        if (oneMembers(tempinst.members, s, tempdecl.ident) && s.value !== null) {
            tempinst.aliasdecl = s.value;
            // resolved: `version (IN_LLVM)` -> ON, block LIVE (templatesem.d:1268-1279). Its function-local
            // `import gen.llvmhelpers : DtoSetFuncDeclIntrinsicName;` (:1270) is module-level here (01 §4).
            if (tempdecl.llvmInternal !== 0) {
                s.value.llvmInternal = tempdecl.llvmInternal;
                const fd = s.value.isFuncDeclaration();
                if (fd !== null)
                    DtoSetFuncDeclIntrinsicName(tempinst, tempdecl, fd);
            }
        }
    }

    /* If function template declaration
     */
    if (!keptCreate && argumentList.length() > 0 && tempinst.aliasdecl !== null) {
        const fd = tempinst.aliasdecl.isFuncDeclaration();
        if (fd !== null) {
            /* Transmit fargs to type so that TypeFunction.dsymbolSemantic() can
             * resolve any "auto ref" storage classes.
             */
            if (fd.type !== null) {
                const tf = fd.type.isTypeFunction();
                if (tf !== null)
                    tf.inferenceArguments = argumentList.copy();   // struct store (03 §1 #5)
            }
        }
    }

    // Do semantic() analysis on template instance members
    // D: `Scope* sc2; sc2 = _scope.push(tempinst);` — a single assignment, so `const` here
    // (a `let` would defeat definite-assignment analysis inside `LaftersemanticTail`).
    const sc2: Scope = _scope.push(tempinst);
    sc2.parent = tempinst;
    sc2.tinst = tempinst;
    sc2.minst = tempinst.minst;
    sc2.stc = (sc2.stc & ~STC.deprecated_) as STC;
    if (!keptCreate)
        tryExpandMembers(tempinst, sc2);

    tempinst.semanticRun = PASS.semanticdone;

    /* ConditionalDeclaration may introduce eponymous declaration,
     * so we should find it once again after semantic.
     */
    if (tempinst.members!.length !== 0) {
        const s: { value: Dsymbol | null } = { value: null };
        if (oneMembers(tempinst.members, s, tempdecl.ident) && s.value !== null) {
            if (tempinst.aliasdecl === null || tempinst.aliasdecl !== s.value) {
                tempinst.aliasdecl = s.value;
            }
        }
    }
    if (K.on) keepInstClose(tempinst);   // the kept-module engine: the creation (members' semantic1) ends here

    // goto Laftersemantic; — BAIL tail (06 §4). It captures `sc2`, `_scope`, `errorsave`,
    // `tempdecl_instance_idx`, `target_symbol_list(_idx)`, `errinst`, `tempdecl`, `tempinst`
    // — never as positional params. Declared here, after every captured local exists and
    // before the first jump site (:1330).
    const LaftersemanticTail = (): void => {
        sc2.pop();
        _scope.pop();

        // Give additional context info if error occurred during instantiation
        if (global.errors !== errorsave) {
            if (!tempinst.errors) {
                if (!tempdecl.literal)
                    error(tempinst.loc, ds("%s `%s` error instantiating"),
                        tempinst.kind(), tempinst.toPrettyChars());
                if (tempinst.tinst !== null)
                    tempinst.tinst.printInstantiationTrace();
            }
            tempinst.errors = true;
            if (tempinst.gagged) {
                // Errors are gagged, so remove the template instance from the
                // instance/symbol lists we added it to and reset our state to
                // finish clean and so we can try to instantiate it again later
                // (see https://issues.dlang.org/show_bug.cgi?id=4302 and https://issues.dlang.org/show_bug.cgi?id=6602).
                removeInstance(tempdecl, tempdecl_instance_idx);
                if (target_symbol_list !== null) {
                    // Because we added 'this' in the last position above, we
                    // should be able to remove it without messing other indices up.
                    assert(target_symbol_list.opIndex(target_symbol_list_idx) === tempinst);
                    target_symbol_list.remove(target_symbol_list_idx);
                    tempinst.memberOf = null;                    // no longer a member
                }
                tempinst.semanticRun = PASS.initial;
                tempinst.inst = null;
                tempinst.symtab = null;
            }
        } else if (errinst !== null) {
            /* https://issues.dlang.org/show_bug.cgi?id=14541
            * If the previous gagged instance had failed by
            * circular references, currrent "error reproduction instantiation"
            * might succeed, because of the difference of instantiated context.
            * On such case, the cached error instance needs to be overridden by the
            * succeeded instance.
            */
            assert(errinst.errors);
            const ti1 = new TemplateInstanceBox(errinst);
            instancesOf(tempdecl).remove(ti1);

            const ti2 = new TemplateInstanceBox(tempinst);
            instancesOf(tempdecl).set(ti2, tempinst);
        }
    };

    if (global.errors !== errorsave)
        return LaftersemanticTail();   // goto Laftersemantic; (dmd/templatesem.d:1330)

    /* If any of the instantiation members didn't get semantic() run
     * on them due to forward references, we cannot run semantic2()
     * or semantic3() yet.
     */
    {
        let found_deferred_ad = false;
        for (let i = 0; i < Module.deferred.length; i++) {
            const sd = Module.deferred.opIndex(i)!;
            const ad = sd.isAggregateDeclaration();
            if (ad !== null && ad.parent !== null && ad.parent.isTemplateInstance() !== null) {
                found_deferred_ad = true;
                if (ad.parent === tempinst) {
                    // `ad.deferred` through an AggregateDeclaration reference: the DERIVED slot (02 §11.5b)
                    ad.deferredTI = tempinst;
                    break;
                }
            }
        }
        if (found_deferred_ad || Module.deferred.length !== 0)
            return LaftersemanticTail();   // goto Laftersemantic; (dmd/templatesem.d:1355)
    }

    /* The problem is when to parse the initializer for a variable.
     * Perhaps VarDeclaration.dsymbolSemantic() should do it like it does
     * for initializers inside a function.
     */
    {
        /* https://issues.dlang.org/show_bug.cgi?id=782
         * this has problems if the classes this depends on
         * are forward referenced. Find a way to defer semantic()
         * on this template.
         */
        // D: `tempinst.semantic2(sc2);` (dmd/templatesem.d:1369) — UFCS (04 §6): `semantic2` is
        // NOT a member of Dsymbol, it is the free `semantic2(Dsymbol dsym, Scope* sc)` of
        // dmd/semantic2.d:79, ported at semantic2.ts:197. Receiver becomes the first argument.
        semantic2(tempinst, sc2);
    }
    if (global.errors !== errorsave)
        return LaftersemanticTail();   // goto Laftersemantic; (dmd/templatesem.d:1372)

    if (sc.deferSemantic3InCompilerHook) {
        sc2.setNoFree();
        tempinst._scope = sc2;
        addDeferredSemantic3(tempinst);
    } else
        templateInstanceSemantic3(tempinst, sc, sc2);

    if (tempinst.aliasdecl !== null) {
        /* https://issues.dlang.org/show_bug.cgi?id=13816
        * AliasDeclaration tries to resolve forward reference
        * twice (See inuse check in AliasDeclaration.toAlias()). It's
        * necessary to resolve mutual references of instantiated symbols, but
        * it will left a true recursive alias in tuple declaration - an
        * AliasDeclaration A refers TupleDeclaration B, and B contains A
        * in its elements.  To correctly make it an error, we strictly need to
        * resolve the alias of eponymous member.
        */
        tempinst.aliasdecl = toAlias2(tempinst.aliasdecl);

        // stop AliasAssign tuple building
        const td = tempinst.aliasdecl.isTupleDeclaration();
        if (td !== null)
            td.building = false;
    }

    // Laftersemantic: — also reached by fall-through (dmd/templatesem.d:1401)
    return LaftersemanticTail();
}

/**
 * dmd/templatesem.d:1460 — `void templateInstanceSemantic3(TemplateInstance tempinst, Scope* sc,
 * Scope* sc2)`. NEW in 1.43: the semantic3-driving tail carved out of `templateInstanceSemantic`.
 */
export function templateInstanceSemantic3(tempinst: TemplateInstance, sc: Scope, sc2: Scope): void {
    if ((sc.func !== null || sc.fullinst) && tempinst.tinst === null) {
        /* If a template is instantiated inside function, the whole instantiation
         * should be done at that position. But, immediate running semantic3 of
         * dependent templates may cause unresolved forward reference.
         * https://issues.dlang.org/show_bug.cgi?id=9050
         * To avoid the issue, don't run semantic3 until semantic and semantic2 done.
         */
        // D: `TemplateInstances deferred;` — a by-VALUE container local, born usable (09 §1.0).
        const deferred: TemplateInstances = new DArray<TemplateInstance | null>();
        // D: `tempinst.deferred = &deferred;` — a pointer to the stack container; in TS the
        // container IS a reference, so the assignment is direct. `tempinst.deferred` through a
        // TemplateInstance reference is the DERIVED slot (02 §11.5b), here and below.
        tempinst.deferredTI = deferred;

        /* https://issues.dlang.org/show_bug.cgi?id=23965
         * DRuntime hooks are not deprecated, but may be used for deprecated
         * types. Deprecations are disabled while analysing hooks to avoid
         * spurious error messages.
         */
        const saveUseDeprecated = global.params.useDeprecated;
        if (sc.isDeprecated() && isDRuntimeHook(tempinst.name!))
            global.params.useDeprecated = DiagnosticReporting.off;

        trySemantic3(tempinst, sc2);

        global.params.useDeprecated = saveUseDeprecated;

        for (let i = 0; i < deferred.length; i++) {
            semantic3(deferred.opIndex(i)!, null);
        }

        tempinst.deferredTI = null;
    } else if (tempinst.tinst !== null) {
        let doSemantic3 = false;
        let fd: FuncDeclaration | null = null;
        if (tempinst.aliasdecl !== null)
            fd = toAlias2(tempinst.aliasdecl).isFuncDeclaration();

        if (fd !== null) {
            /* Template function instantiation should run semantic3 immediately
             * for attribute inference.
             */
            // D: `scope fld = fd.isFuncLiteralDeclaration();` — `scope` erased.
            const fld = fd.isFuncLiteralDeclaration();
            if (fld !== null && fld.tok === TOK.reserved)
                doSemantic3 = true;
            else if (sc.func !== null)
                doSemantic3 = true;
        } else if (sc.func !== null) {
            /* A lambda function in template arguments might capture the
             * instantiated scope context. For the correct context inference,
             * all instantiated functions should run the semantic3 immediately.
             * See also compilable/test14973.d
             */
            for (const oarg of tempinst.tdtypes) {
                let s = getDsymbol(oarg);
                if (s === null)
                    continue;

                const td = s.isTemplateDeclaration();
                if (td !== null) {
                    if (!td.literal)
                        continue;
                    assert(td.members !== null && td.members.length === 1);
                    s = td.members.opIndex(0);
                }
                const fld = s!.isFuncLiteralDeclaration();
                if (fld !== null) {
                    if (fld.tok === TOK.reserved) {
                        doSemantic3 = true;
                        break;
                    }
                }
            }
        }
        if (doSemantic3)
            trySemantic3(tempinst, sc2);

        deferSemantic3(tempinst);
        if (K.on) keepDeferSemantic3(tempinst);   // the kept-module engine: a replay must defer it as well
    }
}

/**
 * dmd/templatesem.d:1548-1574, the end of `templateInstanceSemantic3` for an instance with a `tinst`: its
 * semantic3 joins the deferred list of the outermost instance being instantiated in a function (`deferredTI`, set
 * at :1471), which runs it after its own (:1491). Extracted because the kept-module engine (src/keep.ts) does
 * the same for an instance whose creation it replays (the creation's rest is a recorded log, not this code).
 */
export function deferSemantic3(tempinst: TemplateInstance): void {
    let ti: TemplateInstance | null = tempinst.tinst;
    let nest = 0;
    while (ti !== null && ti.deferredTI === null && ti.tinst !== null) {
        ti = ti.tinst;
        if (++nest > global.recursionLimit) {
            global.gag = 0; // ensure error message gets printed
            error(tempinst.loc, ds("%s `%s` recursive expansion"),
                tempinst.kind(), tempinst.toPrettyChars());
            fatal();
        }
    }
    if (ti !== null && ti.deferredTI !== null) {
        for (let i = 0; ; i++) {
            if (i === ti.deferredTI.length) {
                ti.deferredTI.push(tempinst);
                break;
            }
            if (ti.deferredTI.opIndex(i) === tempinst)
                break;
        }
    }
}

/*****************************************
 * dmd/templatesem.d:1582 — Determines if a TemplateInstance will need a nested
 * generation of the TemplateDeclaration.
 * Sets enclosing property if so, and returns != 0;
 *
 * D module-private (called from chunk 2 at :3172). `Objects* args` is dereferenced
 * unconditionally (`foreach (o; *args)`), so it is non-null here and call sites carry the `!`.
 */
export function hasNestedArgs(_this: TemplateInstance, args: Objects, isstatic: boolean): boolean {
    let nested = 0;

    // arguments from parent instances are also accessible
    if (_this.enclosing === null) {
        const ti = _this.tempdecl!.toParent()!.isTemplateInstance();
        if (ti !== null)
            _this.enclosing = ti.enclosing;
    }

    /* Search for the most deeply nested of `dparent` and `enclosing` assigning
     * `dparent` to `enclosing` if `dparent` is more nested than `enclosing`.
     *
     * Returns:
     *  `true` if an error should be reported
     */
    // D: `static bool search(Dsymbol dparent, ref Dsymbol enclosing)` — `static` means it captures
    // nothing (this arrow does not); the `ref Dsymbol` REBINDS the caller's slot, so it is boxed
    // (03 §3.3/§7.2) and the caller writes the field back.
    const search = (dparent: Dsymbol | null, enclosing: { value: Dsymbol | null }): boolean => {
        if (dparent === null || dparent.isModule() !== null)
            return false;
        if (enclosing.value === null) {
            enclosing.value = dparent;
            return false;
        }
        if (enclosing.value === dparent)
            return false;

        /* Select the more deeply nested of the two.
         * Error if one is not nested inside the other.
         */
        for (let p: Dsymbol | null = enclosing.value; p !== null; p = p.parent) {
            if (p === dparent)
                return false; // enclosing is most nested
        }
        for (let p: Dsymbol | null = dparent; p !== null; p = p.parent) {
            if (p === enclosing.value) {
                enclosing.value = dparent;
                return false; // dparent is most nested
            }
        }
        //https://issues.dlang.org/show_bug.cgi?id=17870
        const pc = dparent.isClassDeclaration();
        const ec = enclosing.value.isClassDeclaration();
        if (pc !== null && ec !== null) {
            if (pc.isBaseOf(ec, null))
                return false;
            else if (ec.isBaseOf(pc, null)) {
                enclosing.value = dparent;
                return false;
            }
        }
        return true;
    };

    const search2 = (sa: Dsymbol): number => {
        const dparent = sa.toParent2();
        // D: `search(dparent, _this.enclosing)` — box the field, write it back (see `search`).
        const enclosingRef = { value: _this.enclosing };
        const bad = search(dparent, enclosingRef);
        _this.enclosing = enclosingRef.value;
        if (bad) {
            error(_this.loc, ds("%s `%s` `%s` is nested in both `%s` and `%s`"),
                _this.kind(), _this.toPrettyChars(), _this.toChars(),
                _this.enclosing!.toChars(), dparent!.toChars());
            _this.errors = true;
        }
        return 1;
    };

    const dsym = (sa: Dsymbol): number => {
        sa = toAlias(sa);
        const td = sa.isTemplateDeclaration();
        if (td !== null) {
            const ti = sa.toParent()!.isTemplateInstance();
            if (ti !== null && ti.enclosing !== null)
                sa = ti;
        }
        const ti = sa.isTemplateInstance();
        const d = sa.isDeclaration();
        if (td !== null && td.literal)
            return search2(sa);
        if (ti !== null && ti.enclosing !== null)
            return search2(sa);
        if (d !== null && !d.isDataseg()
              && (d.storage_class & STC.manifest) === 0n
              && (d.isFuncDeclaration() === null || d.isFuncDeclaration()!.isNested())
              && _this.isTemplateMixin() === null) {
            return search2(sa);
        }
        return 0;
    };

    /* A nested instance happens when an argument references a local
     * symbol that is on the stack.
     */
    for (const o of args) {
        const sa = isDsymbol(o);
        if (sa !== null) {
            nested |= dsym(sa);
            continue;
        }
        const va = isTuple(o);
        if (va !== null) {
            nested |= hasNestedArgs(_this, va.objects, isstatic) ? 1 : 0;
            continue;
        }
        const ea = isExpression(o);
        if (ea === null)
            continue;

        const ve = ea.isVarExp();
        if (ve !== null) {
            nested |= dsym(ve.var_);
            continue;
        }
        const te = ea.isThisExp();
        if (te !== null) {
            nested |= dsym(te.var_!);
            continue;
        }
        const fe = ea.isFuncExp();
        if (fe !== null) {
            nested |= dsym(fe.td !== null ? fe.td : fe.fd!);
            continue;
        }
        // Emulate Expression.toMangleBuffer call that had exist in TemplateInstance.genIdent.
        if (ea.op !== EXP.int64 && ea.op !== EXP.float64 && ea.op !== EXP.complex80 && ea.op !== EXP.null_ && ea.op !== EXP.string_ && ea.op !== EXP.arrayLiteral && ea.op !== EXP.assocArrayLiteral && ea.op !== EXP.structLiteral) {
            if (ea.type!.isTypeError() === null) {
                error(ea.loc, ds("%s `%s` expression `%s` is not a valid template value argument"),
                    _this.kind(), _this.toPrettyChars(), ea.toChars());
            }
            _this.errors = true;
        }
    }
    return nested !== 0;
}

/// dmd/templatesem.d:1728 — `private struct MATCHpair`. Pair of MATCHes. VALUE type (02 §2 / 03).
///
/// D's only constructor is `debug this(MATCH, MATCH)` (:1733), and debug is OFF (07 §2), so D
/// compiles this struct WITHOUT a user constructor: `MATCHpair(a, b)` is the default field-order
/// literal. The port emits exactly that ctor (the dropped debug ctor's two range asserts go with
/// it). Constructed in chunk 2 (`deduceFunctionTemplateMatch`).
export class MATCHpair {
    mta: MATCH;  /// match template parameters by initial template arguments
    mfa: MATCH;  /// match template parameters by inferred template arguments

    constructor(mta: MATCH, mfa: MATCH) {
        this.mta = mta;
        this.mfa = mfa;
    }

    copy(): MATCHpair {
        return new MATCHpair(this.mta, this.mfa);
    }
}

/*****************************************
 * dmd/templatesem.d:1745 — Append `ti` to the specific module `ti.members[]`. D module-private; exported for the
 * kept-module engine (src/keep.ts), which appends a kept instance it creates anew as the creation path does.
 */
export function appendToModuleMember(ti: TemplateInstance): Dsymbols | null {
    let mi = ti.minst; // instantiated . inserted module

    // resolved: `version (IN_LLVM)` -> ON, block LIVE (templatesem.d:1749-1765).
    if (global.params.linkonceTemplates === LinkonceTemplates.aggressive) {
        // Skip if it's not a root module.
        if (mi === null || !mi.isRoot())
            return null;

        // Skip if the primary instance has already been assigned to a root
        // module.
        if (ti.inst!.memberOf !== null)
            return null;

        // Okay, this is the primary instance to be assigned to a root
        // module and getting semantic3.
        assert(ti === ti.inst);
    }

    if (global.params.allInst || mi === null || mi.isRoot()) {
        /* If the instantiated module is speculative or root, insert to the
         * member of a root module. Then:
         *  - semantic3 pass will get called on the instance members.
         *  - codegen pass will get a selection chance to do/skip it (needsCodegen()).
         */
        // D: `static Dsymbol getStrictEnclosing(TemplateInstance ti)` — captures nothing.
        const getStrictEnclosing = (ti: TemplateInstance | null): Dsymbol | null => {
            do {
                if (ti!.enclosing !== null)
                    return ti!.enclosing;
                ti = ti!.tempdecl!.isInstantiated();
            } while (ti !== null);
            return null;
        };

        const enc = getStrictEnclosing(ti);
        // insert target is made stable by using the module
        // where tempdecl is declared.
        mi = (enc !== null ? enc : ti.tempdecl!).getModule();
        if (!mi!.isRoot()) {
            if (mi!.importedFrom !== null) {
                mi = mi!.importedFrom;
                assert(mi.isRoot());
            } else {
                // This can happen when using the frontend as a library.
                // Append it to the non-root module.
            }
        }
    } else {
        /* If the instantiated module is non-root, insert to the member of the
         * non-root module. Then:
         *  - semantic3 pass won't be called on the instance.
         *  - codegen pass won't reach to the instance.
         * Unless it is re-appended to a root module later (with changed minst).
         */
    }

    if (ti.memberOf !== null) { // already appended to some module
        assert(mi!.isRoot(), "can only re-append to a root module");
        if (ti.memberOf.isRoot())
            return null; // no need to move to another root module
    }

    const a = mi!.members;
    a!.push(ti);
    ti.memberOf = mi;
    if (mi!.semanticRun >= PASS.semantic2done && mi!.isRoot())
        addDeferredSemantic2(ti);
    if (mi!.semanticRun >= PASS.semantic3done && mi!.isRoot())
        addDeferredSemantic3(ti);
    return a;
}

/// dmd/templatesem.d:1836 — `private void expandMembers(TemplateInstance ti, Scope* sc2)`.
function expandMembers(ti: TemplateInstance, sc2: Scope): void {
    foreachDsymbolVoid(ti.members, (s) => { setScope(s, sc2); });

    foreachDsymbolVoid(ti.members, (s) => { importAll(s, sc2); });

    if (ti.aliasdecl === null) {
        /* static if's are crucial to evaluating aliasdecl correctly. But
         * evaluating the if/else bodies may require aliasdecl.
         * So, evaluate the condition for static if's, but not their if/else bodies.
         * Then try to set aliasdecl.
         * Later do the if/else bodies.
         * https://issues.dlang.org/show_bug.cgi?id=23598
         * It might be better to do this by attaching a lambda to the StaticIfDeclaration
         * to do the oneMembers call after the sid.include(sc2) is run as part of dsymbolSemantic().
         */
        let done = false;
        const staticIfDg = (s: Dsymbol): void => {
            if (done || ti.aliasdecl !== null)
                return;
            if (s.isStaticIfDeclaration() === null) {
                done = true;
                return;
            }
            const sid = s.isStaticIfDeclaration()!;
            include(sid, sc2);
            if (ti.members!.length !== 0) {
                const sa: { value: Dsymbol | null } = { value: null };
                if (oneMembers(ti.members, sa, ti.tempdecl!.ident) && sa.value !== null)
                    ti.aliasdecl = sa.value;
            }
            done = true;
        };

        foreachDsymbolVoid(ti.members, staticIfDg);
    }

    const symbolDg = (s: Dsymbol): void => {
        dsymbolSemantic(s, sc2);
        runDeferredSemantic();
    };

    foreachDsymbolVoid(ti.members, symbolDg);
}

// dmd/templatesem.d:1896 — `__gshared int nest;` inside `tryExpandMembers`. A D function-static,
// hoisted to module level. DISTINCT from `trySemantic3`'s counter below: the two must never share
// a slot.
let tryExpandMembersNest = 0;

/// dmd/templatesem.d:1894 — `private void tryExpandMembers(TemplateInstance ti, Scope* sc2)`.
function tryExpandMembers(ti: TemplateInstance, sc2: Scope): void {
    // extracted to a function to allow windows SEH to work without destructors in the same function
    if (++tryExpandMembersNest > global.recursionLimit) {
        global.gag = 0; // ensure error message gets printed
        error(ti.loc, ds("%s `%s` recursive expansion exceeded allowed nesting limit"),
            ti.kind(), ti.toPrettyChars());
        fatal();
    }

    // The inc/dec pair straddles a region that can contain a WALL (`expandMembers` reaches
    // `dsymbolSemantic`), and a wall throw is an exit path D does not have — so the decrement is
    // a `finally` even though D needs none (11 §2.5, the `noMember` nest-leak bug class).
    try {
        expandMembers(ti, sc2);
    } finally {
        tryExpandMembersNest--;
    }
}

// dmd/templatesem.d:1914 — `__gshared int nest;` inside `trySemantic3`. A SEPARATE function-static
// counter from `tryExpandMembersNest` above.
let trySemantic3Nest = 0;

/// dmd/templatesem.d:1911 — `private void trySemantic3(TemplateInstance ti, Scope* sc2)`.
function trySemantic3(ti: TemplateInstance, sc2: Scope): void {
    // extracted to a function to allow windows SEH to work without destructors in the same function
    if (++trySemantic3Nest > global.recursionLimit) {
        global.gag = 0; // ensure error message gets printed
        error(ti.loc, ds("%s `%s` recursive expansion exceeded allowed nesting limit"),
            ti.kind(), ti.toPrettyChars());
        fatal();
    }

    // See the note on `tryExpandMembers` — same paired-state protection (11 §2.5).
    try {
        semantic3(ti, sc2);
    } finally {
        --trySemantic3Nest;
    }
}

// dropped: `debug (FindExistingInstance) { private __gshared uint nFound, nNotFound, nAdded,
// nRemoved; shared static ~this() {…} }` (templatesem.d:1928-1941) — debug is OFF (07 §2), along
// with the counter bumps at :1989, :2003, :2016.

/******************************************************
 * dmd/templatesem.d:1944 — Do template instance semantic for isAlias templates.
 * This is a greatly simplified version of templateInstanceSemantic().
 * D module-private.
 */
function aliasInstanceSemantic(tempinst: TemplateInstance, sc: Scope, tempdecl: TemplateDeclaration): void {
    const paramscope = sc.push();
    paramscope.stc = STC.none;
    paramscope.visibility = new Visibility(Visibility.Kind.public_);

    const ttp = tempdecl.parameters!.opIndex(0)!.isTemplateTypeParameter()!;
    // D: `tempinst.tdtypes[0].isType()` — UFCS on dtemplate.d's free `isType(RootObject)`.
    const ta = isType(tempinst.tdtypes.opIndex(0));
    computeOneMember(tempdecl);
    const ad = tempdecl.onemember!.isAliasDeclaration()!;

    // Note: qualifiers can be in both 'ad.type.mod' and 'ad.storage_class'
    const d: Declaration = AliasDeclaration.fromType(tempinst.loc, ttp.ident!, addMod(ta!, ad.type!.mod));
    d.storage_class = (d.storage_class | STC.templateparameter | ad.storage_class) as STC;
    dsymbolSemantic(d, sc);

    paramscope.pop();

    tempinst.aliasdecl = d;

    tempinst.semanticRun = PASS.semanticdone;
}

/****************************************************
 * dmd/templatesem.d:1981 — Given a new instance `tithis` of this TemplateDeclaration,
 * see if there already exists an instance.
 *
 * Params:
 *   td = template declaration
 *   tithis = template instance to check
 *   argumentList = For function templates, needed because different
 *                  `auto ref` resolutions create different instances,
 *                  even when template parameters are identical
 *
 * Returns: that existing instance, or `null` when it doesn't exist
 *
 * D module-private. `argumentList` is by-value (03 §1 #2): call sites copy.
 */
function findExistingInstance(td: TemplateDeclaration, tithis: TemplateInstance,
                              argumentList: ArgumentList): TemplateInstance | null {
    tithis.fargs = argumentList.arguments_;
    tithis.fnames = argumentList.names;
    const tibox = new TemplateInstanceBox(tithis);
    // D: `auto p = tibox in cast(TemplateInstance[TemplateInstanceBox]) td.instances;`
    //    `return p ? *p : null;` — a stored null VALUE also yields null, so `get` matches exactly.
    return instancesOf(td).get(tibox);
}

/********************************************
 * dmd/templatesem.d:1998 — Add instance ti to TemplateDeclaration's table of instances.
 * Return a handle we can use to later remove it if it fails instantiation.
 * D module-private.
 */
function addInstance(td: TemplateDeclaration, ti: TemplateInstance): TemplateInstance {
    const tibox = new TemplateInstanceBox(ti);
    instancesOf(td).set(tibox, ti);
    return ti;
}

/*******************************************
 * dmd/templatesem.d:2012 — Remove TemplateInstance from table of instances.
 * Input:
 *      handle returned by addInstance()
 * D module-private.
 */
function removeInstance(td: TemplateDeclaration, ti: TemplateInstance): void {
    const tibox = new TemplateInstanceBox(ti);
    instancesOf(td).remove(tibox);
}

/******************************************************
 * dmd/templatesem.d:2025 — Do template instance semantic for isAliasSeq templates.
 * This is a greatly simplified version of templateInstanceSemantic().
 * D module-private.
 */
function aliasSeqInstanceSemantic(tempinst: TemplateInstance, sc: Scope, tempdecl: TemplateDeclaration): void {
    const paramscope = sc.push();
    paramscope.stc = STC.none;
    paramscope.visibility = new Visibility(Visibility.Kind.public_);

    const ttp = tempdecl.parameters!.opIndex(0)!.isTemplateTupleParameter()!;
    // D: `tempinst.tdtypes[0].isTuple()` — UFCS on dtemplate.d's free `isTuple(RootObject)`.
    const va = isTuple(tempinst.tdtypes.opIndex(0));
    // D: `new TupleDeclaration(tempinst.loc, ttp.ident, &va.objects)` — `&va.objects` is the
    // address of an inline value container, i.e. the container reference itself (02 §10 case 2).
    const d: Declaration = new TupleDeclaration(tempinst.loc, ttp.ident!, va!.objects);
    d.storage_class = (d.storage_class | STC.templateparameter) as STC;
    dsymbolSemantic(d, sc);

    paramscope.pop();

    tempinst.aliasdecl = d;

    tempinst.semanticRun = PASS.semanticdone;
}

/**********************************************
 * dmd/templatesem.d:2055 — Find template declaration corresponding to template instance.
 *
 * Returns:
 *      false if finding fails.
 * Note:
 *      This function is reentrant against error occurrence. If returns false,
 *      any members of this object won't be modified, and repetition call will
 *      reproduce same error.
 *
 * `WithScopeSymbol* pwithsym` is an OPTIONAL out-pointer (the body tests it and callers pass
 * `null`, e.g. :964) -> a nullable box (03 §3.3).
 */
export function findTempDecl(ti: TemplateInstance, sc: Scope,
                             pwithsym: { value: WithScopeSymbol | null } | null): boolean {
    if (pwithsym !== null)
        pwithsym.value = null;

    if (ti.havetempdecl)
        return true;

    if (ti.tempdecl === null) {
        /* Given:
         *    foo!( ... )
         * figure out which TemplateDeclaration foo refers to.
         */
        const id = ti.name!;
        const scopesym: { value: Dsymbol | null } = { value: null };
        // D: `sc.search(ti.loc, id, scopesym)` — UFCS on dsymbolsem.d:428's Scope-receiver
        // overload, which the port names `searchScope` (04 §1B / §6.1).
        let s = searchScope(sc, ti.loc, id, scopesym);
        if (s === null) {
            s = search_correctScope(sc, id);
            if (s !== null)
                error(ti.loc, ds("%s `%s` template `%s` is not defined, did you mean %s?"),
                    ti.kind(), ti.toPrettyChars(), id.toChars(), s.toChars());
            else
                error(ti.loc, ds("%s `%s` template `%s` is not defined"),
                    ti.kind(), ti.toPrettyChars(), id.toChars());
            return false;
        }
        // resolved: `static if (LOG)` (:2085-2090) -> false, printf block dropped.
        if (pwithsym !== null)
            pwithsym.value = scopesym.value!.isWithScopeSymbol();

        /* We might have found an alias within a template when
         * we really want the template.
         */
        if (s.parent !== null) {
            const ti2 = s.parent.isTemplateInstance();
            if (ti2 !== null) {
                if (ti2.tempdecl !== null && ti2.tempdecl.ident === id) {
                    /* This is so that one can refer to the enclosing
                     * template, even if it has the same name as a member
                     * of the template, if it has a !(arguments)
                     */
                    let td = ti2.tempdecl.isTemplateDeclaration();
                    assert(td !== null);
                    if (td!.overroot !== null) // if not start of overloaded list of TemplateDeclaration's
                        td = td!.overroot; // then get the start
                    s = td!;
                }
            }
        }

        // The template might originate from a selective import which implies that
        // s is a lowered AliasDeclaration of the actual TemplateDeclaration.
        // This is the last place where we see the deprecated alias because it is
        // stripped below, so check if the selective import was deprecated.
        // See https://issues.dlang.org/show_bug.cgi?id=20840.
        if (s.isAliasDeclaration() !== null)
            checkDeprecated(s, ti.loc, sc);

        if (!updateTempDecl(ti, sc, s)) {
            return false;
        }
    }
    assert(ti.tempdecl !== null);

    // Look for forward references
    const tovers = ti.tempdecl.isOverloadSet();
    // D: `foreach (size_t oi; 0 .. tovers ? tovers.a.length : 1)` (templatesem.d:2128) — the
    // range bound is evaluated ONCE at loop entry (06 §1.3), so it is hoisted.
    const noverloads = tovers !== null ? tovers.a.length : 1;
    for (let oi = 0; oi < noverloads; oi++) {
        const dstart = tovers !== null ? tovers.a.opIndex(oi)! : ti.tempdecl;
        const r = overloadApply(dstart, (s: Dsymbol): number => {
            const td = s.isTemplateDeclaration();
            if (td === null)
                return 0;

            if (td.semanticRun === PASS.initial) {
                if (td._scope !== null) {
                    // Try to fix forward reference. Ungag errors while doing so.
                    const ungag = ungagSpeculative(td);
                    try {
                        dsymbolSemantic(td, td._scope);
                    } finally {
                        global.gag = ungag.oldgag;   // D's ~Ungag()
                    }
                }
                if (td.semanticRun === PASS.initial) {
                    error(ti.loc, ds("%s `%s` `%s` forward references template declaration `%s`"),
                        ti.kind(), ti.toPrettyChars(), ti.toChars(), td.toChars());
                    return 1;
                }
            }
            return 0;
        });
        if (r !== 0)
            return false;
    }
    return true;
}

/// dmd/templatesem.d:2160 — `bool findMixinTempDecl(TemplateMixin tm, Scope* sc)`.
export function findMixinTempDecl(tm: TemplateMixin, sc: Scope): boolean {
    // Follow qualifications to find the TemplateDeclaration
    if (tm.tempdecl === null) {
        // D: `Expression e; Type t; Dsymbol s; tm.tqual.resolve(tm.loc, sc, e, t, s);` — three
        // `out`/`ref` slots -> boxes (03 §3.3).
        const e: { value: Expression | null } = { value: null };
        const t: { value: Type | null } = { value: null };
        const sBox: { value: Dsymbol | null } = { value: null };
        resolve(tm.tqual!, tm.loc, sc, e, t, sBox);
        if (sBox.value === null) {
            error(tm.loc, ds("%s `%s` is not defined"), tm.kind(), tm.toPrettyChars());
            return false;
        }
        let s = toAlias(sBox.value);
        tm.tempdecl = s.isTemplateDeclaration();
        const os = s.isOverloadSet();

        /* If an OverloadSet, look for a unique member that is a template declaration
         */
        if (os !== null) {
            let dsUnique: Dsymbol | null = null;
            for (const sym of os.a) {
                const s2 = sym!.isTemplateDeclaration();
                if (s2 !== null) {
                    if (dsUnique !== null) {
                        tm.tempdecl = os;
                        break;
                    }
                    dsUnique = s2;
                }
            }
        }
        if (tm.tempdecl === null) {
            error(tm.loc, ds("%s `%s` - `%s` is a %s, not a template"), tm.kind(),
                tm.toPrettyChars(), s.toChars(), s.kind());
            return false;
        }
    }
    assert(tm.tempdecl !== null);

    // Look for forward references
    const tovers = tm.tempdecl.isOverloadSet();
    // D: `foreach (size_t oi; 0 .. tovers ? tovers.a.length : 1)` (templatesem.d:2208) — the
    // range bound is evaluated ONCE at loop entry (06 §1.3), so it is hoisted.
    const noverloads = tovers !== null ? tovers.a.length : 1;
    for (let oi = 0; oi < noverloads; oi++) {
        const dstart = tovers !== null ? tovers.a.opIndex(oi)! : tm.tempdecl;
        const r = overloadApply(dstart, (s: Dsymbol): number => {
            const td = s.isTemplateDeclaration();
            if (td === null)
                return 0;

            if (td.semanticRun === PASS.initial) {
                if (td._scope !== null)
                    dsymbolSemantic(td, td._scope);
                else {
                    tm.semanticRun = PASS.initial;
                    return 1;
                }
            }
            return 0;
        });
        if (r !== 0)
            return false;
    }
    return true;
}

/******************************************************
 * dmd/templatesem.d:2245 — Verifies if the given Identifier is a DRuntime hook. It uses the hooks
 * defined in `id.d`.
 *
 * Params:
 *  id = Identifier to verify
 * Returns:
 *  true if `id` is a DRuntime hook
 *  false otherwise
 *
 * D module-private.
 */
function isDRuntimeHook(id: Identifier): boolean {
    return id === Id._d_HookTraceImpl ||
        id === Id._d_newclassT || id === Id._d_newclassTTrace ||
        id === Id._d_arraycatnTX || id === Id._d_arraycatnTXTrace ||
        id === Id._d_newThrowable || id === Id._d_delThrowable ||
        id === Id._d_arrayassign_l || id === Id._d_arrayassign_r ||
        id === Id._d_arraysetassign || id === Id._d_arraysetctor ||
        id === Id._d_arrayctor ||
        id === Id._d_arraysetlengthT ||
        id === Id._d_arraysetlengthTTrace ||
        id === Id._d_arrayappendT || id === Id._d_arrayappendTTrace ||
        id === Id._d_arrayappendcTX;
}

/******************************
 * dmd/templatesem.d:2267 — See if two objects match
 * Params:
 *      o1 = first object
 *      o2 = second object
 * Returns: true if they match
 *
 * D module-private (called from chunk 3 at :8046).
 */
function match(o1: RootObject | null, o2: RootObject | null): boolean {
    // resolved: `enum log = false;` (:2269) -> every `static if (log)` printf dropped. The
    // `yes()`/`no()` helpers are the function's RETURN PROTOCOL and stay verbatim (04 §0.1) —
    // they are NOT inlined to `return true/false`.
    const yes = (): boolean => {
        return true;
    };
    const no = (): boolean => {
        return false;
    };
    /* A proper implementation of the various equals() overrides
     * should make it possible to just do o1.equals(o2), but
     * we'll do that another day.
     */
    /* Manifest constants should be compared by their values,
     * at least in template arguments.
     */

    const t1 = isType(o1);
    if (t1 !== null) {
        const t2 = isType(o2);
        if (t2 === null)
            return no();

        if (!t1.equals(t2))
            return no();

        return yes();
    }
    const e1 = getExpression(o1);
    if (e1 !== null) {
        const e2 = getExpression(o2);
        if (e2 === null)
            return no();

        // two expressions can be equal although they do not have the same
        // type; that happens when they have the same value. So check type
        // as well as expression equality to ensure templates are properly
        // matched.
        if (!(e1.type !== null && e2.type !== null && e1.type.equals(e2.type)) || !expressionEquals(e1, e2))
            return no();

        return yes();
    }
    const s1 = isDsymbol(o1);
    if (s1 !== null) {
        const s2 = isDsymbol(o2);
        if (s2 === null)
            return no();

        if (!dsymbolEquals(s1, s2))
            return no();
        if (s1.parent !== s2.parent && s1.isFuncDeclaration() === null && s2.isFuncDeclaration() === null)
            return no();

        return yes();
    }
    const u1 = isTuple(o1);
    if (u1 !== null) {
        const u2 = isTuple(o2);
        if (u2 === null)
            return no();

        if (!arrayObjectMatch(u1.objects, u2.objects))
            return no();

        return yes();
    }
    return yes();
}

/************************************
 * dmd/templatesem.d:2374 — Match an array of them. D module-private (called from chunks 2 and 3).
 *
 * `ref Objects` params are ALIASES (03 §3.2) — no `.copy()` at any call site.
 */
export function arrayObjectMatch(oa1: Objects, oa2: Objects): boolean {
    if (oa1 === oa2)   // D: `if (&oa1 == &oa2)` — identity of the referenced storage (03 §7.2)
        return true;
    if (oa1.length !== oa2.length)
        return false;
    const oa1dim = oa1.length;
    // D takes `oa1[].ptr` / `oa2[].ptr` purely to skip bounds checks; the port reads the same
    // elements in the same order through `opIndex`.
    for (let j = 0; j < oa1dim; j++) {
        const o1 = oa1.opIndex(j);
        const o2 = oa2.opIndex(j);
        if (!match(o1, o2)) {
            return false;
        }
    }
    return true;
}

/*************************************
 * dmd/templatesem.d:2405 — Compare proposed template instantiation with existing template
 * instantiation.
 * Note that this is not commutative because of the auto ref check.
 * Params:
 *  ti1 = proposed template instantiation
 *  ti2 = existing template instantiation
 * Returns:
 *  true for match
 *
 * D module-private; the sole caller is `TemplateInstanceBox.opEquals`, which must always pass the
 * PROBE as `ti1` (see `TemplateInstanceTable`).
 */
function equalsx(ti1: TemplateInstance, ti2: TemplateInstance): boolean {
    assert(ti1.tdtypes.length === ti2.tdtypes.length);

    // Nesting must match
    if (ti1.enclosing !== ti2.enclosing) {
        return false;
    }

    if (!arrayObjectMatch(ti1.tdtypes, ti2.tdtypes))
        return false;

    /* Template functions may have different instantiations based on
     * "auto ref" parameters.
     */
    const fd = toAlias(ti2).isFuncDeclaration();
    if (fd === null)
        return true;
    if (fd.errors)
        return true;

    const resolvedArgs = resolveNamedArgs(fd.type!.isTypeFunction()!,
        new ArgumentList(ti1.fargs, ti1.fnames), null);

    // resolvedArgs can be null when there's an error: fail_compilation/fail14669.d
    // In that case, equalsx returns true to prevent endless template instantiations
    // However, it can also mean the function was explicitly instantiated
    // without function arguments: fail_compilation/fail14669
    // Hence the following check:
    if (ti1.fargs !== null && resolvedArgs === null)
        return true;

    const args: (Expression | null)[] = resolvedArgs !== null ? resolvedArgs.opSlice() : [];

    const fparameters = fd.getParameterList();
    const nfparams = fparameters.length();   // Num function parameters
    for (let j = 0; j < nfparams; j++) {
        const fparam = fparameters.opIndex(j)!;
        if ((fparam.storageClass & STC.autoref) === 0n)      // if "auto ref"
            continue;

        let farg = (j < args.length) ? args[j] : fparam.defaultArg;
        // resolveNamedArgs strips trailing nulls / default params
        // when it doesn't anymore, the ternary can be replaced with:
        // assert(j < resolvedArgs.length);
        if (farg === null)
            farg = fparam.defaultArg;
        if (farg === null)
            return false;
        if (isLvalue(farg)) {
            if ((fparam.storageClass & STC.ref_) === 0n)
                return false; // auto ref's don't match
        } else {
            if ((fparam.storageClass & STC.ref_) !== 0n)
                return false; // auto ref's don't match
        }
    }
    return true;
}

/*******************************************
 * Match to a particular TemplateParameter.
 * Input:
 *      instLoc         location that the template is instantiated.
 *      tiargs[]        actual arguments to template instance
 *      i               i'th argument
 *      parameters[]    template parameters
 *      dedtypes[]      deduced arguments to template instance
 *      *psparam        set to symbol declared and initialized to dedtypes[i]
 *
 * dmd/templatesem.d:2485 — `MATCH matchArg(TemplateParameter tp, Loc instLoc, Scope* sc,
 * Objects* tiargs, size_t i, TemplateParameters* parameters, ref Objects dedtypes,
 * Declaration* psparam)`. RENAMED per preamble §F.1 (Form B: this and the D:2552 `matchArg`
 * take the same first type and differ at params 2/3). Call sites resolve by the SECOND argument:
 * a `Loc` picks this one.
 *
 * `Objects* tiargs` / `TemplateParameters* parameters` are dereferenced unconditionally
 * (02 §10.1) -> non-null. `ref Objects dedtypes` is an alias, so the container object is passed
 * as-is (03 §3.2). `Declaration* psparam` is an OUT pointer the caller may pass as `null`
 * -> `Ref<Declaration | null> | null` (03 §3.3 / §7.2).
 */
export function matchArgFromTiargs(tp: TemplateParameter, instLoc: Loc, sc: Scope, tiargs: Objects,
    i: number, parameters: TemplateParameters, dedtypes: Objects,
    psparam: Ref<Declaration | null> | null): MATCH {
    // dmd/templatesem.d:2487 — nested `MATCH matchArgNoMatch()` (04 §5; captures `psparam`).
    const matchArgNoMatch = (): MATCH => {
        if (psparam !== null)
            psparam.value = null;
        return MATCH.nomatch;
    };

    // dmd/templatesem.d:2494 — nested `MATCH matchArgParameter()`.
    const matchArgParameter = (): MATCH => {
        let oarg: RootObject | null;

        if (i < tiargs.length)
            oarg = tiargs.opIndex(i);
        else {
            // Get default argument instead
            oarg = defaultArg(tp, instLoc, sc);
            if (oarg === null) {
                assert(i < dedtypes.length);
                // It might have already been deduced
                oarg = dedtypes.opIndex(i);
                if (oarg === null)
                    return matchArgNoMatch();
            }
        }
        return matchArgFromObject(tp, sc, oarg, i, parameters, dedtypes, psparam);
    };

    // dmd/templatesem.d:2516 — nested `MATCH matchArgTuple(TemplateTupleParameter ttp)`.
    const matchArgTuple = (ttp: TemplateTupleParameter): MATCH => {
        /* The rest of the actual arguments (tiargs[]) form the match
         * for the variadic parameter.
         */
        assert(i + 1 === dedtypes.length); // must be the last one
        let ovar: Tuple;

        // dmd:2523-2537 — a CHAIN of declarations-in-conditions; 06 §2.6 nests each hoist into the
        // prior `else` so the second `isTuple` runs only when the first arm did not match.
        const u = isTuple(dedtypes.opIndex(i));
        if (u !== null) {
            // It has already been deduced
            ovar = u;
        } else if (i + 1 === tiargs.length && isTuple(tiargs.opIndex(i)) !== null) {
            // D calls `isTuple((*tiargs)[i])` twice (test then use); both are kept — it is pure.
            ovar = isTuple(tiargs.opIndex(i))!;
        } else {
            ovar = new Tuple();
            //printf("ovar = %p\n", ovar);
            if (i < tiargs.length) {
                //printf("i = %d, tiargs.length = %d\n", i, tiargs.length);
                ovar.objects.setDim(tiargs.length - i);
                // D `foreach (j, ref obj; ovar.objects) obj = (*tiargs)[i + j];` — a by-reference
                // walk that WRITES every slot, so it is an indexed write (03 §4 / 05 §7). Every
                // slot grown by `setDim` is filled here, so no `.init` dependence.
                for (let j = 0; j < ovar.objects.length; j++)
                    ovar.objects.opIndexAssign(tiargs.opIndex(i + j), j);
            }
        }
        return matchArgFromObject(ttp, sc, ovar, i, parameters, dedtypes, psparam);
    };

    // dmd/templatesem.d:2546-2550 — the if-chain dispatch (06 §2.6 hoist per arm).
    const ttp = tp.isTemplateTupleParameter();
    if (ttp !== null)
        return matchArgTuple(ttp);

    return matchArgParameter();
}

/**
 * dmd/templatesem.d:2552 — `private MATCH matchArg(TemplateParameter tp, Scope* sc,
 * RootObject oarg, size_t i, TemplateParameters* parameters, ref Objects dedtypes,
 * Declaration* psparam)`. RENAMED `matchArgFromObject` per preamble §F.1; call sites resolve by
 * the second argument being a `Scope*`.
 *
 * `oarg` IS null-tested (`if (!ei && oarg)`, D:2569) -> `RootObject | null` (02 §10.1).
 * `sc` is reassigned through `startCTFE()`/`endCTFE()` inside `matchArgValue` — the assignment
 * lands on THIS parameter in D (the nested function closes over it), so the port assigns to the
 * parameter too rather than to a private copy.
 *
 * D module-private (module scope, not class scope) — emitted without `export`.
 */
function matchArgFromObject(tp: TemplateParameter, sc: Scope, oarg: RootObject | null, i: number,
    parameters: TemplateParameters, dedtypes: Objects,
    psparam: Ref<Declaration | null> | null): MATCH {
    // dmd/templatesem.d:2554 — nested `MATCH matchArgNoMatch()`.
    const matchArgNoMatch = (): MATCH => {
        //printf("\tm = %d\n", MATCH.nomatch);
        if (psparam !== null)
            psparam.value = null;
        return MATCH.nomatch;
    };

    // dmd/templatesem.d:2562 — nested `MATCH matchArgType(TemplateTypeParameter ttp)`.
    const matchArgType = (ttp: TemplateTypeParameter): MATCH => {
        //printf("TemplateTypeParameter.matchArg('%s')\n", ttp.ident.toChars());
        let m = MATCH.exact;
        let ta = isType(oarg);
        if (ta === null) {
            //printf("%s %p %p %p\n", oarg.toChars(), isExpression(oarg), isDsymbol(oarg), isTuple(oarg));
            return matchArgNoMatch();
        }
        //printf("ta is %s\n", ta.toChars());

        if (ttp.specType !== null) {
            // D re-tests `!ta` here even though the early-out above already excluded null; kept 1:1.
            if (ta === null || ta === TemplateTypeParameter.tdummy)
                return matchArgNoMatch();

            //printf("\tcalling deduceType(): ta is %s, specType is %s\n", …);
            const m2 = deduceType(ta, sc, ttp.specType, parameters, dedtypes);
            if (m2 === MATCH.nomatch) {
                //printf("\tfailed deduceType\n");
                return matchArgNoMatch();
            }

            if (m2 < m)
                m = m2;
            if (dedtypes.opIndex(i) !== null) {
                // D `cast(Type)dedtypes[i]` — the tag-gated `isType` IS that dynamic downcast
                // (both yield null for a non-Type), and D dereferences the result, so `!` marks
                // D's own fault point.
                const t = isType(dedtypes.opIndex(i))!;

                if (ttp.dependent && !t.equals(ta)) // https://issues.dlang.org/show_bug.cgi?id=14357
                    return matchArgNoMatch();

                /* This is a self-dependent parameter. For example:
                 *  template X(T : T*) {}
                 *  template X(T : S!T, alias S) {}
                 */
                //printf("t = %s ta = %s\n", t.toChars(), ta.toChars());
                ta = t;
            }
        } else {
            if (dedtypes.opIndex(i) !== null) {
                // Must match already deduced type
                const t = isType(dedtypes.opIndex(i))!;

                if (!t.equals(ta)) {
                    //printf("t = %s ta = %s\n", t.toChars(), ta.toChars());
                    return matchArgNoMatch();
                }
            } else {
                // So that matches with specializations are better
                m = MATCH.convert;
            }
        }
        dedtypes.opIndexAssign(ta, i);

        if (psparam !== null)
            psparam.value = AliasDeclaration.fromType(ttp.loc, ttp.ident!, ta);
        //printf("\tm = %d\n", m);
        return ttp.dependent ? MATCH.exact : m;
    };

    // dmd/templatesem.d:2631 — nested `MATCH matchArgValue(TemplateValueParameter tvp)`.
    const matchArgValue = (tvp: TemplateValueParameter): MATCH => {
        //printf("TemplateValueParameter.matchArg('%s')\n", tvp.ident.toChars());
        let m = MATCH.exact;

        let ei = isExpression(oarg);
        let vt: Type;

        if (ei === null && oarg !== null) {
            const si = isDsymbol(oarg);
            const f = si !== null ? si.isFuncDeclaration() : null;
            if (f === null || f.fbody === null || f.needThis())
                return matchArgNoMatch();

            ei = new VarExp(tvp.loc, f);
            ei = expressionSemantic(ei, sc);

            /* If a function is really property-like, and then
             * it's CTFEable, ei will be a literal expression.
             */
            const olderrors = global.startGagging();
            // GAG PAIRING (11 §2.5, "walls add exit paths D does not have — protect paired
            // state"): `startGagging()` increments the PROCESS-global `global.gag`, and the
            // region below still reaches walls (resolveProperties' and ctfeInterpret's own
            // callees, e.g. dinterpret's isBuiltin wall). Without the try/finally the counter
            // would leak and silence every later diagnostic in the run. D
            // (templatesem.d:2652-2655) needs no guard.
            let gagged: boolean;
            try {
                ei = resolveProperties(sc, ei);
                ei = ctfeInterpret(ei);
            } finally {
                gagged = global.endGagging(olderrors);
            }
            if (gagged || ei.op === EXP.error)
                return matchArgNoMatch();

            /* https://issues.dlang.org/show_bug.cgi?id=14520
             * A property-like function can match to both
             * TemplateAlias and ValueParameter. But for template overloads,
             * it should always prefer alias parameter to be consistent
             * template match result.
             *
             *   template X(alias f) { enum X = 1; }
             *   template X(int val) { enum X = 2; }
             *   int f1() { return 0; }  // CTFEable
             *   int f2();               // body-less function is not CTFEable
             *   enum x1 = X!f1;    // should be 1
             *   enum x2 = X!f2;    // should be 1
             *
             * e.g. The x1 value must be same even if the f1 definition will be moved
             *      into di while stripping body code.
             */
            m = MATCH.convert;
        }

        if (ei !== null && ei.op === EXP.variable) {
            // Resolve const variables that we had skipped earlier
            ei = ctfeInterpret(ei);
        }

        //printf("\tvalType: %s, ty = %d\n", tvp.valType.toChars(), tvp.valType.ty);
        vt = typeSemantic(tvp.valType!, tvp.loc, sc);
        //printf("ei: %s, ei.type: %s\n", ei.toChars(), ei.type.toChars());
        //printf("vt = %s\n", vt.toChars());

        // D dereferences `ei` here with no null test (`ei.type`) — `!` marks that fault point
        // (02 §10.1); the `ei is null` test only appears further down, in the specValue arm.
        if (ei!.type !== null) {
            const m2 = implicitConvTo(ei!, vt);
            //printf("m: %d\n", m);
            if (m2 < m)
                m = m2;
            if (m === MATCH.nomatch)
                return matchArgNoMatch();
            ei = implicitCastTo(ei!, sc, vt);
            ei = ctfeInterpret(ei);
        }

        if (tvp.specValue !== null) {
            // D: `if (ei is null || (cast(void*)ei.type in edummies && edummies[cast(void*)ei.type] == ei))`.
            // Split into two `if`s with the SAME consequent so the `||` short-circuit is exact
            // while the AA key can be read only once `ei` is known non-null. The `eiType !== null`
            // guard is NOT an extra condition: `edummies` (`Map<object, Expression>`,
            // dtemplate.ts:737) is populated only by `DummyArgVisitor` with a freshly built,
            // non-null `e.type`, so a null key can never be present and D's lookup on it always
            // misses — the guard yields exactly D's answer.
            if (ei === null)
                return matchArgNoMatch();
            {
                const eiType = ei.type;
                if (eiType !== null && TemplateValueParameter.edummies.has(eiType)
                    && TemplateValueParameter.edummies.get(eiType) === ei)
                    return matchArgNoMatch();
            }

            let e = tvp.specValue;

            // D reassigns the enclosing function's `sc` PARAMETER through startCTFE/endCTFE; the
            // nested function closes over it in D, so the port assigns the parameter too.
            // `endCTFE()` is `Scope | null` in the port while D re-dereferences it immediately
            // (`sc.startCTFE()` below) — `!` marks D's own fault point (02 §10.1).
            sc = sc.startCTFE();
            e = expressionSemantic(e, sc);
            e = resolveProperties(sc, e);
            sc = sc.endCTFE()!;
            e = implicitCastTo(e, sc, vt);
            e = ctfeInterpret(e);

            ei = ei.syntaxCopy();
            sc = sc.startCTFE();
            ei = expressionSemantic(ei, sc);
            sc = sc.endCTFE()!;
            ei = implicitCastTo(ei, sc, vt);
            ei = ctfeInterpret(ei);
            //printf("\tei: %s, %s\n", ei.toChars(), ei.type.toChars());
            //printf("\te : %s, %s\n", e.toChars(), e.type.toChars());
            if (!expressionEquals(ei, e))
                return matchArgNoMatch();
        } else {
            if (dedtypes.opIndex(i) !== null) {
                // Must match already deduced value
                // D `cast(Expression)dedtypes[i]` — tag-gated `isExpression` is that downcast.
                const e = isExpression(dedtypes.opIndex(i))!;
                if (ei === null || !expressionEquals(ei, e))
                    return matchArgNoMatch();
            }
        }
        dedtypes.opIndexAssign(ei, i);

        if (psparam !== null) {
            const _init: Initializer = new ExpInitializer(tvp.loc, ei);
            const sparam: Declaration = new VarDeclaration(tvp.loc, vt, tvp.ident!, _init);
            sparam.storage_class = STC.manifest;
            psparam.value = sparam;
        }
        return tvp.dependent ? MATCH.exact : m;
    };

    // dmd/templatesem.d:2748 — nested `MATCH matchArgAlias(TemplateAliasParameter tap)`.
    const matchArgAlias = (tap: TemplateAliasParameter): MATCH => {
        //printf("TemplateAliasParameter.matchArg('%s')\n", tap.ident.toChars());
        let m = MATCH.exact;
        const ta = isType(oarg);
        // D `Type ta = …; RootObject sa = ta && !ta.deco ? null : getDsymbol(oarg);` — the ternary
        // condition is nullable-reference truthiness on `ta` and on the `const(char)*` `deco`
        // (06 §2.7 / 02 §11.2).
        let sa: RootObject | null = (ta !== null && ta.deco === null) ? null : getDsymbol(oarg);
        const ea = isExpression(oarg);
        if (ea !== null) {
            // 06 §2.6 chained declaration-in-condition -> nested hoists (short-circuit preserved).
            const te = ea.isThisExp();
            if (te !== null)
                sa = te.var_; // ported field: D `var` -> `var_` (01 §2.3)
            else {
                const seSuper = ea.isSuperExp();
                if (seSuper !== null)
                    sa = seSuper.var_; // ported field: D `var` -> `var_` (01 §2.3)
                else {
                    const seScope = ea.isScopeExp();
                    if (seScope !== null)
                        sa = seScope.sds;
                }
            }
        }
        if (sa !== null) {
            // D `(cast(Dsymbol)sa)` twice. On this path `sa` came from `getDsymbol` / ThisExp.var /
            // SuperExp.var / ScopeExp.sds — always a Dsymbol; the tag-gated `isDsymbol` IS D's
            // dynamic cast, hoisted once (it is pure).
            const saDsym = isDsymbol(sa)!;
            if (saDsym.isAggregateDeclaration() !== null)
                m = MATCH.convert;

            /* specType means the alias must be a declaration with a type
             * that matches specType.
             */
            if (tap.specType !== null) {
                tap.specType = typeSemantic(tap.specType, tap.loc, sc);
                const d = saDsym.isDeclaration();
                if (d === null)
                    return matchArgNoMatch();
                if (!d.type!.equals(tap.specType))
                    return matchArgNoMatch();
            }
        } else {
            sa = oarg;
            if (ea !== null) {
                if (tap.specType !== null) {
                    if (!ea.type!.equals(tap.specType))
                        return matchArgNoMatch();
                }
            } else if (ta !== null && ta.ty === TY.Tinstance && tap.specAlias === null) {
                /* Specialized parameter should be preferred
                 * match to the template type parameter.
                 *  template X(alias a) {}                      // a == this
                 *  template X(alias a : B!A, alias B, A...) {} // B!A => ta
                 */
            } else if (sa !== null && sa === TemplateTypeParameter.tdummy) {
                /* https://issues.dlang.org/show_bug.cgi?id=2025
                 * Aggregate Types should preferentially
                 * match to the template type parameter.
                 *  template X(alias a) {}  // a == this
                 *  template X(T) {}        // T => sa
                 */
            } else if (ta !== null && ta.ty !== TY.Tident) {
                /* Match any type that's not a TypeIdentifier to alias parameters,
                 * but prefer type parameter.
                 * template X(alias a) { }  // a == ta
                 *
                 * TypeIdentifiers are excluded because they might be not yet resolved aliases.
                 */
                m = MATCH.convert;
            } else
                return matchArgNoMatch();
        }

        if (tap.specAlias !== null) {
            if (sa === TemplateAliasParameter.sdummy)
                return matchArgNoMatch();
            // check specialization if template arg is a symbol
            const sx = isDsymbol(sa);
            if (sa !== tap.specAlias && sx !== null) {
                const talias = isType(tap.specAlias);
                if (talias === null)
                    return matchArgNoMatch();

                let ti = sx.isTemplateInstance();
                if (ti === null && sx.parent !== null) {
                    ti = sx.parent.isTemplateInstance();
                    if (ti !== null && ti.name !== sx.ident)
                        return matchArgNoMatch();
                }
                if (ti === null)
                    return matchArgNoMatch();

                const t: Type = new TypeInstance(Loc.initial, ti);
                const m2 = deduceType(t, sc, talias, parameters, dedtypes);
                if (m2 === MATCH.nomatch)
                    return matchArgNoMatch();
            }
            // check specialization if template arg is a type
            else if (ta !== null) {
                const tspec = isType(tap.specAlias);
                if (tspec !== null) {
                    const m2 = implicitConvToType(ta, tspec); // D `ta.implicitConvTo(tspec)` — the Type/Type overload
                    if (m2 === MATCH.nomatch)
                        return matchArgNoMatch();
                } else {
                    error(tap.loc, ds("template parameter specialization for a type must be a type and not `%s`"),
                        tap.specAlias.toChars());
                    return matchArgNoMatch();
                }
            }
        } else if (dedtypes.opIndex(i) !== null) {
            // Must match already deduced symbol
            const si = dedtypes.opIndex(i);
            if (sa === null || si !== sa)
                return matchArgNoMatch();
        }
        // Note: Dsymbol can't have type qualifiers, so use type if it has them
        // https://github.com/dlang/dmd/issues/17959
        // `ta.mod` is a `MOD` (number) in a boolean context -> explicit `!== 0` (06 §2.5).
        dedtypes.opIndexAssign((ta !== null && ta.mod !== 0) ? ta : sa, i);

        if (psparam !== null) {
            // 06 §2.6 chained declaration-in-condition -> nested hoists.
            const s = isDsymbol(sa);
            if (s !== null) {
                psparam.value = AliasDeclaration.fromDsymbol(tap.loc, tap.ident!, s);
            } else {
                const t = isType(sa);
                if (t !== null) {
                    psparam.value = AliasDeclaration.fromType(tap.loc, tap.ident!, t);
                } else {
                    assert(ea !== null);

                    // Declare manifest constant
                    const _init: Initializer = new ExpInitializer(tap.loc, ea);
                    const v = new VarDeclaration(tap.loc, null, tap.ident!, _init);
                    // D sets STC.manifest ALONE here (templatesem.d:2896) — unlike
                    // `declareParameterWithValue` (D:5309), which ORs in STC.templateparameter.
                    v.storage_class = STC.manifest;
                    dsymbolSemantic(v, sc);
                    psparam.value = v;
                }
            }
        }
        return tap.dependent ? MATCH.exact : m;
    };

    // dmd/templatesem.d:2904 — nested `MATCH matchArgTuple(TemplateTupleParameter ttp)`.
    const matchArgTuple = (ttp: TemplateTupleParameter): MATCH => {
        //printf("TemplateTupleParameter.matchArg('%s')\n", ttp.ident.toChars());
        const ovar = isTuple(oarg);
        if (ovar === null)
            return MATCH.nomatch;
        if (dedtypes.opIndex(i) !== null) {
            const tup = isTuple(dedtypes.opIndex(i));
            if (tup === null)
                return MATCH.nomatch;
            if (!match(tup, ovar))
                return MATCH.nomatch;
        }
        dedtypes.opIndexAssign(ovar, i);

        if (psparam !== null)
            psparam.value = new TupleDeclaration(ttp.loc, ttp.ident!, ovar.objects);
        return ttp.dependent ? MATCH.exact : MATCH.convert;
    };

    // dmd/templatesem.d:2925-2933 — the if-chain dispatch, emitted in full, then D's `assert(0)`.
    {
        const ttp = tp.isTemplateTypeParameter();
        if (ttp !== null)
            return matchArgType(ttp);
    }
    {
        const tvp = tp.isTemplateValueParameter();
        if (tvp !== null)
            return matchArgValue(tvp);
    }
    {
        const tap = tp.isTemplateAliasParameter();
        if (tap !== null)
            return matchArgAlias(tap);
    }
    {
        const ttp = tp.isTemplateTupleParameter();
        if (ttp !== null)
            return matchArgTuple(ttp);
    }
    return assertUnreachable(); // dmd/templatesem.d:2933 `assert(0);`
}

/**********************************************
 * Confirm s is a valid template, then store it.
 * Input:
 *      sc
 *      s   candidate symbol of template. It may be:
 *          TemplateDeclaration
 *          FuncDeclaration with findTemplateDeclRoot() != NULL
 *          OverloadSet which contains candidates
 * Returns:
 *      true if updating succeeds.
 *
 * dmd/templatesem.d:2947. `s` is null-tested on entry -> `Dsymbol | null` (02 §10.1); it is
 * REASSIGNED while walking the alias / overload-set chain, so a widened local cursor carries it
 * (02 §10.1 `cur`).
 */
export function updateTempDecl(ti: TemplateInstance, sc: Scope, s: Dsymbol | null): boolean {
    if (s === null)
        return ti.tempdecl !== null;

    const id = ti.name;
    // D reassigns the `s` parameter repeatedly (`s = s.toAlias()`, `s = s2`, …) -> `cur`.
    let cur: Dsymbol = toAlias(s);

    /* If an OverloadSet, look for a unique member that is a template declaration
     */
    {
        const os = cur.isOverloadSet();
        if (os !== null) {
            // D sets `s = null` here and rebuilds it inside the loop; the cursor goes nullable for
            // the duration and is re-narrowed by the `if (!s)` check that follows.
            let found: Dsymbol | null = null;
            for (const s2Slot of os.a) {
                // D `foreach (s2; os.a)` binds a fresh `s2` per iteration and REASSIGNS it.
                let s2: Dsymbol | null = s2Slot;
                const f = s2!.isFuncDeclaration();
                if (f !== null)
                    s2 = f.findTemplateDeclRoot();
                else
                    s2 = s2!.isTemplateDeclaration();
                if (s2 !== null) {
                    if (found !== null) {
                        ti.tempdecl = os;
                        return true;
                    }
                    found = s2;
                }
            }
            if (found === null) {
                error(ti.loc, ds("%s `%s` template `%s` is not defined"),
                    ti.kind(), ti.toPrettyChars(), id!.toChars());
                return false;
            }
            cur = found;
        }
    }

    {
        const od = cur.isOverDeclaration();
        if (od !== null) {
            ti.tempdecl = od; // TODO: more strict check
            return true;
        }
    }

    /* It should be a TemplateDeclaration, not some other symbol
     */
    {
        const f = cur.isFuncDeclaration();
        if (f !== null)
            ti.tempdecl = f.findTemplateDeclRoot();
        else
            ti.tempdecl = cur.isTemplateDeclaration();
    }

    // We're done
    if (ti.tempdecl !== null)
        return true;

    // Error already issued, just return `false`
    if (cur.parent === null && global.errors !== 0)
        return false;

    if (cur.parent === null && dsymbolsemGetType(cur) !== null) {
        const s2 = toDsymbol(dsymbolsemGetType(cur)!, sc);
        if (s2 === null) {
            error(ti.loc,
                ds("`%s` is not a valid template instance, because `%s` is not a template declaration but a type (`%s == %s`)"),
                ti.toChars(), id!.toChars(), id!.toChars(), dsymbolsemGetType(cur)!.kind());
            return false;
        }
        // because s can be the alias created for a TemplateParameter
        const ad = cur.isAliasDeclaration();
        // resolved: version (none) -> OFF (dmd/templatesem.d:3011) — the printf block is dropped.
        if (ad === null || !ad.isAliasedTemplateParameter())
            cur = s2;
    }

    const ti2: TemplateInstance | null = cur.parent !== null ? cur.parent.isTemplateInstance() : null;

    /* This avoids the VarDeclaration.toAlias() which runs semantic() too soon
     *
     * dmd/templatesem.d:3027 — nested `static bool matchId(TemplateInstance _ti, Identifier id)`.
     * `static` means it captures nothing; it keeps the D signature verbatim (04 §0.1) rather than
     * closing over the enclosing `id`.
     */
    const matchId = (_ti: TemplateInstance, idArg: Identifier | null): boolean => {
        if (_ti.aliasdecl !== null && _ti.aliasdecl.isVarDeclaration() !== null)
            return _ti.aliasdecl.isVarDeclaration()!.ident === idArg;
        return toAlias(_ti).ident === idArg;
    };

    if (ti2 !== null && (ti2.name === cur.ident || matchId(ti2, cur.ident)) && ti2.tempdecl !== null) {
        /* This is so that one can refer to the enclosing
         * template, even if it has the same name as a member
         * of the template, if it has a !(arguments)
         */
        let td = ti2.tempdecl.isTemplateDeclaration();
        assert(td !== null);
        if (td!.overroot !== null) // if not start of overloaded list of TemplateDeclaration's
            td = td!.overroot; // then get the start
        ti.tempdecl = td;
        return true;
    } else {
        error(ti.loc, ds("%s `%s` `%s` is not a template declaration, it is a %s"),
            ti.kind(), ti.toPrettyChars(), id!.toChars(), cur.kind());
        return false;
    }
}

/***************************************
 * Given that ti is an instance of this TemplateDeclaration,
 * deduce the types of the parameters to this, and store
 * those deduced types in dedtypes[].
 * Params:
 *  sc = context
 *  td = template
 *  ti = instance of td
 *  dedtypes = fill in with deduced types
 *  argumentList = arguments to template instance
 *  flag = 1 - don't do semantic() because of dummy types
 *         2 - don't change types in matchArg()
 * Returns: match level.
 *
 * dmd/templatesem.d:3070. resolved: `enum LOGM = 0;` (D:3072) -> every `static if (LOGM)` block is
 * FALSE and dropped, INCLUDING the D:3216-3239 block whose `else return nomatch();` goes with it
 * (the `else` belongs to the dropped `static if`, verified by reading D:3212-3245).
 * resolved: `version (none)` at D:3077 and D:3141 -> OFF, dropped.
 */
export function matchWithInstance(sc: Scope, td: TemplateDeclaration, ti: TemplateInstance,
    dedtypes: Objects, argumentList: ArgumentList, flag: number): MATCH {
    // dmd/templatesem.d:3083 — nested `MATCH nomatch()`. Its only body was the dropped LOGM
    // printf; the return protocol stays a named helper (04 §0.1 — never inlined to `return`).
    const nomatch = (): MATCH => {
        return MATCH.nomatch;
    };
    let m: MATCH;
    const dedtypes_dim = dedtypes.length;

    // D `dedtypes.zero()` (templatesem.d:3092) = `data[0 .. length] = T.init`. `Array.zero()` is a
    // no-op in the port (no generic `T.init`, 08 §2.0a) and this site DEPENDS on the slots reading
    // as `null` (`if (dedtypes[i])` inside matchArgFromObject). `Objects` is
    // `Array<RootObject | null>`, whose element `.init` IS `null` — the single known `T`.
    dedtypes.zero();
    for (let z = 0; z < dedtypes.length; z++) dedtypes.opIndexAssign(null, z);

    if (td.errors)
        return MATCH.nomatch;

    const parameters_dim = td.parameters!.length;
    const variadic = td.isVariadic() !== null;

    // If more arguments than parameters, no match
    if (ti.tiargs!.length > parameters_dim && !variadic) {
        return MATCH.nomatch;
    }

    assert(dedtypes_dim === parameters_dim);
    assert(dedtypes_dim >= ti.tiargs!.length || variadic);

    assert(td._scope !== null);

    // Set up scope for template parameters
    const paramscope = createScopeForTemplateParameters(td, ti, sc);

    // Attempt type deduction
    m = MATCH.exact;
    for (let i = 0; i < dedtypes_dim; i++) {
        let m2: MATCH;
        const tp = td.parameters!.opIndex(i)!;
        // D `Declaration sparam;` + `&sparam` — an OUT pointer -> the one-slot box (03 §3.3).
        const sparam: Ref<Declaration | null> = { value: null };

        //printf("\targument [%d]\n", i);

        m2 = matchArgFromTiargs(tp, ti.loc, paramscope, ti.tiargs!, i, td.parameters!, dedtypes, sparam);
        //printf("\tm2 = %d\n", m2);
        if (m2 === MATCH.nomatch) {
            // resolved: version (none) -> OFF — the printf is dropped.
            return nomatch();
        }

        if (m2 < m)
            m = m2;

        if (flag === 0)
            dsymbolSemantic(sparam.value!, paramscope);
        if (insert(paramscope, sparam.value!) === null) { // TODO: This check can make more early
            // in TemplateDeclaration.semantic, and
            // then we don't need to make sparam if flags == 0
            return nomatch();
        }
    }

    if (flag === 0) {
        /* Any parameter left without a type gets the type of
         * its corresponding arg
         */
        // D `foreach (i, ref dedtype; dedtypes)` WRITES the slot -> indexed write (03 §4 / 05 §7).
        for (let i = 0; i < dedtypes.length; i++) {
            if (dedtypes.opIndex(i) === null) {
                assert(i < ti.tiargs!.length);
                // D `cast(Type)(*ti.tiargs)[i]` — the tag-gated `isType` IS that dynamic cast
                // (both yield null for a non-Type), and the slot type is `RootObject | null`.
                dedtypes.opIndexAssign(isType(ti.tiargs!.opIndex(i)), i);
            }
        }
    }

    if (m > MATCH.nomatch && td.constraint !== null && flag === 0) {
        if (hasNestedArgs(ti, ti.tiargs!, td.isstatic)) // TODO: should gag error
            ti.parent = ti.enclosing;
        else
            ti.parent = td.parent;

        // Similar to doHeaderInstantiation
        computeOneMember(td);
        // D reassigns the local `fd` inside the `if` and the `evaluateConstraint` call BELOW the
        // `if` reads the reassigned value — so this is one `let`, not two locals.
        let fd: FuncDeclaration | null = td.onemember !== null ? td.onemember.isFuncDeclaration() : null;
        if (fd !== null) {
            const tf = fd.type!.isTypeFunction()!.syntaxCopy();

            fd = new FuncDeclaration(fd.loc, fd.endloc, fd.ident, fd.storage_class, tf);
            fd.parent = ti;
            fd.inferRetType = true;

            // Shouldn't run semantic on default arguments and return type.
            // D `foreach (ref param; *tf.parameterList.parameters)` mutates the ELEMENT's field,
            // not the slot -> iterate in place (03 §4).
            for (const param of tf.parameterList.parameters!)
                param!.defaultArg = null;

            tf.next = null;
            tf.incomplete = true;

            // Resolve parameter types and 'auto ref's.
            tf.inferenceArguments = argumentList.copy(); // struct into a field (03 §1 #5)
            const olderrors = global.startGagging();
            // GAG PAIRING (11 §2.5): `typeSemantic` reaches walls — exit paths D does not have —
            // so the process-global `global.gag` counter is drained in a `finally` that D
            // (templatesem.d:3203-3205) does not need. Inert on every path D itself takes.
            try {
                fd.type = typeSemantic(tf, td.loc, paramscope);
            } finally {
                global.endGagging(olderrors);
            }
            if (fd.type.ty !== TY.Tfunction)
                return nomatch();
            fd.originalType = fd.type; // for mangling
        }

        // TODO: dedtypes => ti.tiargs ?
        if (!evaluateConstraint(td, ti, sc, paramscope, dedtypes, fd))
            return nomatch();
    }

    paramscope.pop();
    return m;
}

/**
    Returns: true if the instances' innards are discardable.

    The idea of this function is to see if the template instantiation
    can be 100% replaced with its eponymous member. All other members
    can be discarded, even in the compiler to free memory (for example,
    the template could be expanded in a region allocator, deemed trivial,
    the end result copied back out independently and the entire region freed),
    and can be elided entirely from the binary.

    The current implementation affects code that generally looks like:

    ---
    template foo(args...) {
        some_basic_type_or_string helper() { .... }
        enum foo = helper();
    }
    ---

    since it was the easiest starting point of implementation but it can and
    should be expanded more later.

    dmd/templatesem.d:3274.
*/
export function isDiscardable(ti: TemplateInstance): boolean {
    if (ti.aliasdecl === null)
        return false;

    const v = ti.aliasdecl.isVarDeclaration();
    if (v === null)
        return false;

    if ((v.storage_class & STC.manifest) === 0n)
        return false;

    // Currently only doing basic types here because it is the easiest proof-of-concept
    // implementation with minimal risk of side effects, but it could likely be
    // expanded to any type that already exists outside this particular instance.
    if (!(v.type!.equals(Type.tstring) || v.type!.isTypeBasic() !== null))
        return false;

    // Static ctors and dtors, even in an eponymous enum template, are still run,
    // so if any of them are in here, we'd better not assume it is trivial lest
    // we break useful code
    for (const member of ti.members!) {
        if (hasStaticCtorOrDtor(member!))
            return false;
        if (member!.isStaticDtorDeclaration() !== null)
            return false;
        if (member!.isStaticCtorDeclaration() !== null)
            return false;
    }

    // but if it passes through this gauntlet... it should be fine. D code will
    // see only the eponymous member, outside stuff can never access it, even through
    // reflection; the outside world ought to be none the wiser. Even dmd should be
    // able to simply free the memory of everything except the final result.

    return true;
}

/***********************************************
 * Returns true if this is not instantiated in non-root module, and
 * is a part of non-speculative instantiatiation.
 *
 * Note: minst does not stabilize until semantic analysis is completed,
 * so don't call this function during semantic analysis to return precise result.
 *
 * dmd/templatesem.d:3321. resolved: version (IN_LLVM) -> ON (_config.md) — the LDC assert at
 * D:3323-3326 is LIVE and emitted; there is no `else` branch to drop.
 *
 * D's three `const needsCodegen = …` locals SHADOW this function's own name; in D the UFCS
 * `tinst.needsCodegen()` inside `needsCodegenRootOnly` still resolves to the module function,
 * but a TS `const needsCodegen = needsCodegen(t)` is a temporal-dead-zone error. Each local is
 * therefore renamed `needsCodegenState` / `needsCodegenSibling` at its site — a mechanical
 * TS-scoping rename, no semantic content.
 */
export function needsCodegen(ti: TemplateInstance): boolean {
    // resolved: version (IN_LLVM) -> ON (dmd/templatesem.d:3322).
    assert(global.params.linkonceTemplates !== LinkonceTemplates.aggressive);

    //printf("needsCodegen() %s\n", toChars());

    // minst is finalized after the 1st invocation.
    // tnext is only needed for the 1st invocation and
    // cleared for further invocations.
    // D reassigns `tnext` while walking the sibling chain -> a widened local cursor (02 §10.1).
    let tnext: TemplateInstance | null = ti.tnext;
    const tinst: TemplateInstance | null = ti.tinst;
    ti.tnext = null;

    // Don't do codegen if the instance has errors,
    // is a dummy instance (see evaluateConstraint),
    // or is determined to be discardable.
    if (ti.errors || ti.inst === null || isDiscardable(ti.inst)) {
        ti.minst = null; // mark as speculative
        return false;
    }

    // This should only be called on the primary instantiation.
    assert(ti === ti.inst);

    /* Hack for suppressing linking errors against template instances
    * of `_d_arrayliteralTX` (e.g. `_d_arrayliteralTX!(int[])`).
    *
    * This happens, for example, when a lib module is compiled with `preview=dip1000` and
    * the array literal is placed on stack instead of using the lowering. In this case,
    * if the root module is compiled without `preview=dip1000`, the compiler will consider
    * the template already instantiated within the lib module, and thus skip the codegen for it
    * in the root module object file, thinking that the linker will find the instance in the lib module.
    *
    * To bypass this edge case, we always do codegen for `_d_arrayliteralTX` template instances,
    * even if an instance already exists in non-root module.
    */
    if (ti.inst !== null && ti.inst.name === Id._d_arrayliteralTX) {
        return true;
    }

    if (global.params.allInst) {
        // Do codegen if there is an instantiation from a root module, to maximize link-ability.
        // dmd/templatesem.d:3369 — nested `static ThreeState needsCodegenAllInst(...)`.
        const needsCodegenAllInst = (tithis: TemplateInstance, tinstArg: TemplateInstance | null): ThreeState => {
            // Do codegen if `this` is instantiated from a root module.
            if (tithis.minst !== null && tithis.minst.isRoot())
                return ThreeState.yes;

            // Do codegen if the ancestor needs it.
            if (tinstArg !== null && tinstArg.inst !== null && needsCodegen(tinstArg.inst)) {
                tithis.minst = tinstArg.inst.minst; // cache result
                assert(tithis.minst !== null);
                assert(tithis.minst!.isRoot());
                return ThreeState.yes;
            }
            return ThreeState.none;
        };

        {
            // D `if (const needsCodegen = needsCodegenAllInst(ti, tinst))` — 06 §2.6 hoist, and the
            // ThreeState value in a boolean context is `!= 0` i.e. `!= ThreeState.none` (06 §2.5).
            const needsCodegenState = needsCodegenAllInst(ti, tinst);
            if (needsCodegenState !== ThreeState.none)
                return needsCodegenState === ThreeState.yes;
        }

        // Do codegen if a sibling needs it.
        for (; tnext !== null; tnext = tnext.tnext) {
            const needsCodegenSibling = needsCodegenAllInst(tnext, tnext.tinst);
            if (needsCodegenSibling === ThreeState.yes) {
                ti.minst = tnext.minst; // cache result
                assert(ti.minst !== null);
                assert(ti.minst!.isRoot());
                return true;
            } else if (ti.minst === null && tnext.minst !== null) {
                ti.minst = tnext.minst; // cache result from non-speculative sibling
                // continue searching
            } else if (needsCodegenSibling !== ThreeState.none)
                break;
        }

        // Elide codegen because there's no instantiation from any root modules.
        return false;
    }

    // Prefer instantiations from non-root modules, to minimize object code size.

    /* If a TemplateInstance is ever instantiated from a non-root module,
     * we do not have to generate code for it,
     * because it will be generated when the non-root module is compiled.
     *
     * But, if the non-root 'minst' imports any root modules, it might still need codegen.
     *
     * The problem is if A imports B, and B imports A, and both A
     * and B instantiate the same template, does the compilation of A
     * or the compilation of B do the actual instantiation?
     *
     * See https://issues.dlang.org/show_bug.cgi?id=2500.
     *
     * => Elide codegen if there is at least one instantiation from a non-root module
     *    which doesn't import any root modules.
     *
     * dmd/templatesem.d:3430 — nested `static ThreeState needsCodegenRootOnly(...)`.
     */
    const needsCodegenRootOnly = (tithis: TemplateInstance, tinstArg: TemplateInstance | null): ThreeState => {
        // If the ancestor isn't speculative,
        // 1. do codegen if the ancestor needs it
        // 2. elide codegen if the ancestor doesn't need it (non-root instantiation of ancestor incl. subtree)
        // D reassigns the `tinst` parameter (`tinst = tinst.inst;`) -> widened local cursor.
        let cur: TemplateInstance | null = tinstArg;
        if (cur !== null && cur.inst !== null) {
            cur = cur.inst;
            const needsCodegenState = needsCodegen(cur!); // sets tinst.minst
            if (cur!.minst !== null) { // not speculative
                tithis.minst = cur!.minst; // cache result
                return needsCodegenState ? ThreeState.yes : ThreeState.no;
            }
        }

        // Elide codegen if `this` doesn't need it.
        if (tithis.minst !== null && !tithis.minst.isRoot() && !tithis.minst.rootImports())
            return ThreeState.no;

        return ThreeState.none;
    };

    {
        const needsCodegenState = needsCodegenRootOnly(ti, tinst);
        if (needsCodegenState !== ThreeState.none)
            return needsCodegenState === ThreeState.yes;
    }

    // Elide codegen if a (non-speculative) sibling doesn't need it.
    for (; tnext !== null; tnext = tnext.tnext) {
        const needsCodegenSibling = needsCodegenRootOnly(tnext, tnext.tinst); // sets tnext.minst
        if (tnext.minst !== null) { // not speculative
            if (needsCodegenSibling === ThreeState.no) {
                ti.minst = tnext.minst; // cache result
                assert(!ti.minst!.isRoot() && !ti.minst!.rootImports());
                return false;
            } else if (ti.minst === null) {
                ti.minst = tnext.minst; // cache result from non-speculative sibling
                // continue searching
            } else if (needsCodegenSibling !== ThreeState.none)
                break;
        }
    }

    // Unless `this` is still speculative (=> all further siblings speculative too),
    // do codegen because we found no guaranteed-codegen'd non-root instantiation.
    return ti.minst !== null;
}

/****************************
 * Check to see if constraint is satisfied.
 *
 * dmd/templatesem.d:3486. `Objects* dedargs` is dereferenced unconditionally (`*dedargs` at
 * D:3500, stored at D:3520) -> non-null `Objects` (02 §10.1). `sc` is DECLARED by D and never
 * read in this body (verified) — kept in the signature for the 1:1 shape, hence `_sc`.
 * The function-local `import dmd.staticcond;` (D:3599) resolves to `evalStaticCondition`, which
 * IS ported (expressionsem.ts) — no wall here.
 *
 * D module-private.
 */
function evaluateConstraint(td: TemplateDeclaration, ti: TemplateInstance, _sc: Scope,
    paramscope: Scope, dedargs: Objects, fd: FuncDeclaration | null): boolean {
    /* Detect recursive attempts to instantiate this template declaration,
     * https://issues.dlang.org/show_bug.cgi?id=4072
     *  void foo(T)(T x) if (is(typeof(foo(x)))) { }
     *  static assert(!is(typeof(foo(7))));
     * Recursive attempts are regarded as a constraint failure.
     */
    /* There's a chicken-and-egg problem here. We don't know yet if this template
     * instantiation will be a local one (enclosing is set), and we won't know until
     * after selecting the correct template. Thus, function we're nesting inside
     * is not on the sc scope chain, and this can cause errors in FuncDeclaration.getLevel().
     * Workaround the problem by setting a flag to relax the checking on frame errors.
     */

    for (let p: TemplatePrevious | null = td.previous; p !== null; p = p.prev) {
        if (!arrayObjectMatch(p.dedargs!, dedargs))
            continue;
        //printf("recursive, no match p.sc=%p %p %s\n", p.sc, this, this.toChars());
        /* It must be a subscope of p.sc, other scope chains are not recursive
         * instantiations.
         * the chain of enclosing scopes is broken by paramscope (its enclosing
         * scope is _scope, but paramscope.callsc is the instantiating scope). So
         * it's good enough to check the chain of callsc
         */
        for (let scx: Scope | null = paramscope.callsc; scx !== null; scx = scx.callsc) {
            // The first scx might be identical for nested eponymeous templates, e.g.
            // template foo() { void foo()() {...} }
            if (scx === p.sc && scx !== paramscope.callsc)
                return false;
        }
        /* BUG: should also check for ref param differences
         */
    }

    // D `TemplatePrevious pr;` is a STACK value struct whose ADDRESS is threaded onto a list
    // (`td.previous = &pr`) — 03 §7.2: the TS class instance IS that reference, no `.copy()`.
    const pr = new TemplatePrevious();
    pr.prev = td.previous;
    pr.sc = paramscope.callsc;
    pr.dedargs = dedargs;
    td.previous = pr; // add this to threaded list

    // D reassigns `scx` (`scx = scx.pop()`), so it is a widened local cursor (02 §10.1).
    let scx: Scope | null = paramscope.push(ti);
    scx.parent = ti;
    scx.tinst = null;
    scx.minst = null;
    // Set SCOPE.constraint before declaring function parameters for the static condition
    // (previously, this was immediately before calling evalStaticCondition), so the
    // semantic pass knows not to issue deprecation warnings for these throw-away decls.
    // https://issues.dlang.org/show_bug.cgi?id=21831
    scx.inTemplateConstraint = true;

    assert(ti.symtab === null);
    if (fd !== null) {
        /* Declare all the function parameters as variables and add them to the scope
         * Making parameters is similar to FuncDeclaration.semantic3
         */
        const tf = fd.type!.isTypeFunction()!;

        scx.parent = fd;

        const fparameters = tf.parameterList.parameters;
        const nfparams = tf.parameterList.length();
        // D `foreach (i, fparam; tf.parameterList)` iterates the EXPANDED list through
        // `ParameterList.opApply` (05 §11 / 06 §1.8): the callback returns 0 to continue.
        tf.parameterList.opApply((i: number, fparam: Parameter): number => {
            fparam.storageClass = (fparam.storageClass
                & (STC.IOR | STC.lazy_ | STC.final_ | STC.TYPECTOR | STC.nodtor)) as STC;
            fparam.storageClass = (fparam.storageClass | STC.parameter) as STC;
            if (tf.parameterList.varargs === VarArg.typesafe && i + 1 === nfparams) {
                fparam.storageClass = (fparam.storageClass | STC.variadic) as STC;
                /* Don't need to set STC.scope_ because this will only
                 * be evaluated at compile time
                 */
            }
            return 0;
        });
        for (const fparam of fparameters!) {
            if (fparam!.ident === null)
                continue;
            // don't add it, if it has no name
            const v = new VarDeclaration(fparam!.loc, fparam!.type, fparam!.ident, null);
            fparam!.storageClass = (fparam!.storageClass | STC.parameter) as STC;
            v.storage_class = fparam!.storageClass;
            dsymbolSemantic(v, scx);
            if (ti.symtab === null)
                ti.symtab = new DsymbolTable();
            if (insert(scx, v) === null)
                error(td.loc, ds("%s `%s` parameter `%s.%s` is already defined"),
                    td.kind(), td.toPrettyChars(), td.toChars(), v.toChars());
            else
                v.parent = fd;
        }
        if (td.isstatic)
            fd.storage_class = (fd.storage_class | STC.static_) as STC;
        declareThis(fd, scx);
    }

    td.lastConstraint = td.constraint!.syntaxCopy();
    td.lastConstraintTiargs = ti.tiargs;
    td.lastConstraintNegs.setDim(0);

    // resolved: function-local `import dmd.staticcond;` (D:3599) -> `evalStaticCondition` lives in
    // expressionsem.ts in this tree.

    assert(ti.inst === null);
    ti.inst = ti; // temporary instantiation to enable genIdent()
    // D `bool errors;` passed as an `out` argument -> the one-slot box (03 §3.3).
    const errors: Ref<boolean> = { value: false };
    const result = evalStaticCondition(scx, td.constraint!, td.lastConstraint!, errors,
        td.lastConstraintNegs);
    if (result || errors.value) {
        td.lastConstraint = null;
        td.lastConstraintTiargs = null;
        td.lastConstraintNegs.setDim(0);
    }
    ti.inst = null;
    ti.symtab = null;
    scx = scx.pop();
    td.previous = pr.prev; // unlink from threaded list
    if (errors.value)
        return false;
    return result;
}

/****************************
 * Destructively get the error message from the last constraint evaluation
 * Params:
 *      td = TemplateDeclaration
 *      tip = tip to show after printing all overloads
 *
 * dmd/templatesem.d:3615. `ref const(char)* tip` is an alias the callee WRITES -> the one-slot box
 * (03 §3.3 / §7.2). The `scope (exit)` at D:3622 is a SINGLE guard -> `try { … } finally { … }`
 * (06 §7.1), and it is registered AFTER the `visualizeStaticCondition` call, so the call sits
 * outside the `try` exactly as in D.
 */
export function getConstraintEvalError(td: TemplateDeclaration, tip: Ref<DString | null>): DString | null {
    // resolved: function-local `import dmd.staticcond;` (D:3620).
    // there will be a full tree view in verbose mode, and more compact list in the usual
    const full = global.params.v.verbose;
    // D `uint count;` is passed by `ref` to visualizeStaticCondition -> the one-slot box.
    const count: Ref<number> = { value: 0 };
    // `msg` is NUL-terminated (the callee returns `extractChars()`), so it is written with `cstr`, as D's
    // `writestring(const(char)*)` stops at the NUL.
    const msg = visualizeStaticCondition(td.constraint, td.lastConstraint, td.lastConstraintNegs.opSlice(), full,
        count); // dmd/templatesem.d:3621, staticcond.d:35
    try {
        if (msg === null)
            return null;

        const buf = new OutBuffer();

        assert(td.parameters !== null && td.lastConstraintTiargs !== null);
        if (td.parameters!.length > 0) {
            formatParamsWithTiargs(td.parameters!, td.lastConstraintTiargs!, td.isVariadic() !== null, buf);
            buf.writenl();
        }
        if (!full) {
            // choosing singular/plural
            const s = (count.value === 1)
                ? ds("  must satisfy the following constraint:")
                : ds("  must satisfy one of the following constraints:");
            buf.writestring(s);
            buf.writenl();
            // the constraints
            buf.writeByte(0x60 /* ` */);
            buf.writestring(cstr(msg));
            buf.writeByte(0x60 /* ` */);
        } else {
            buf.writestring(ds("  whose parameters have the following constraints:"));
            buf.writenl();
            const sep = ds("  `~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~`");
            buf.writestring(sep);
            buf.writenl();
            // the constraints
            buf.writeByte(0x60 /* ` */);
            buf.writestring(cstr(msg));
            buf.writeByte(0x60 /* ` */);
            buf.writestring(sep);
            tip.value = ds("not satisfied constraints are marked with `>`");
        }
        // `extractChars()` CONSUMES the buffer (08 §13a.2) — that is what D returns here.
        return buf.extractChars();
    } finally {
        // dmd/templatesem.d:3622 `scope (exit) { … }`.
        td.lastConstraint = null;
        td.lastConstraintTiargs = null;
        td.lastConstraintNegs.setDim(0);
    }
}

/**********************************
 * Find the TemplateDeclaration that matches this TemplateInstance best.
 *
 * Params:
 *   ti    = TemplateInstance
 *   sc    = the scope this TemplateInstance resides in
 *   argumentList = function arguments in case of a template function
 *
 * Returns:
 *   `true` if a match was found, `false` otherwise
 *
 * dmd/templatesem.d:3680. resolved: `enum LOG = false;` (D:63) -> the D:3698 and D:3874 printf
 * blocks are dropped.
 */
export function findBestMatch(ti: TemplateInstance, sc: Scope, argumentList: ArgumentList): boolean {
    if (ti.havetempdecl) {
        const tempdecl = ti.tempdecl!.isTemplateDeclaration();
        assert(tempdecl !== null);
        assert(tempdecl!._scope !== null);
        // Deduce tdtypes
        ti.tdtypes.setDim(tempdecl!.parameters!.length);
        if (matchWithInstance(sc, tempdecl!, ti, ti.tdtypes, argumentList.copy(), 2) === MATCH.nomatch) {
            error(ti.loc, ds("%s `%s` incompatible arguments for template instantiation"),
                ti.kind(), ti.toPrettyChars());
            return false;
        }
        // TODO: Normalizing tiargs for https://issues.dlang.org/show_bug.cgi?id=7469 is necessary?
        return true;
    }

    const errs = global.errors;
    let td_last: TemplateDeclaration | null = null;
    // D `Objects dedtypes;` — an inline BY-VALUE `Array!RootObject`, born empty (08 §3 / 09 §1.0).
    // Declared OUTSIDE the `oi` loop and reused, exactly as D does; the error path at D:3862 reads
    // whatever length the last lambda call left.
    const dedtypes: Objects = new DArray<RootObject | null>();

    /* Since there can be multiple TemplateDeclaration's with the same
     * name, look for the best match.
     */
    const tovers = ti.tempdecl!.isOverloadSet();
    // D: `foreach (size_t oi; 0 .. tovers ? tovers.a.length : 1)` (templatesem.d:3712) — the
    // range bound is evaluated ONCE at loop entry (06 §1.3), so it is hoisted.
    const noverloads = tovers !== null ? tovers.a.length : 1;
    for (let oi = 0; oi < noverloads; oi++) {
        // D `TemplateDeclaration td_best = null; TemplateDeclaration td_ambig = null;
        // MATCH m_best = MATCH.nomatch;` are ALL written from inside the `overloadApply` callback
        // below. TS control-flow analysis does not track closure assignments: a plain `let` stays
        // narrowed to its initializer for the rest of the iteration and every later read collapses
        // to `never`, and re-reading into an annotated const does not help (the narrowing rides the
        // initializer). The shape that keeps BOTH D's null-initialisation and the declared type at
        // the read sites is the single-slot box (03 §7.2) — the same remedy enumsem.ts:723 applies
        // to the identical construct.
        const td_best: Ref<TemplateDeclaration | null> = { value: null };
        const td_ambig: Ref<TemplateDeclaration | null> = { value: null };
        const m_best: Ref<MATCH> = { value: MATCH.nomatch };

        const dstart: Dsymbol | null = tovers !== null ? tovers.a.opIndex(oi) : ti.tempdecl;
        overloadApply(dstart, (s: Dsymbol): number => {
            const td = s.isTemplateDeclaration();
            if (td === null)
                return 0;
            if (td === td_best.value)   // skip duplicates
                return 0;

            //printf("td = %s\n", td.toPrettyChars());
            // If more arguments than parameters,
            // then this is no match.
            if (td.parameters!.length < ti.tiargs!.length) {
                if (td.isVariadic() === null)
                    return 0;
            }

            dedtypes.setDim(td.parameters!.length);
            // D `dedtypes.zero()` (templatesem.d:3736) — see the fragment header: `Array.zero()`
            // cannot fill in the port, and matchWithInstance/matchArgFromObject read these slots as
            // `null`. `Objects` element `.init` IS `null`.
            dedtypes.zero();
            for (let z = 0; z < dedtypes.length; z++) dedtypes.opIndexAssign(null, z);
            assert(td.semanticRun !== PASS.initial);

            const m = matchWithInstance(sc, td, ti, dedtypes, argumentList.copy(), 0);
            //printf("matchWithInstance = %d\n", m);
            if (m === MATCH.nomatch) // no match at all
                return 0;

            // dmd/templatesem.d:3759 / :3764 — `Ltd_best:` and `Ltd:` are terminal `return 0;`
            // tails inside this lambda (06 §4 BAIL). Zero-param nested arrows declared before
            // first use; they CAPTURE `td`, `m` and the enclosing `td_best`/`td_ambig`/`m_best`
            // (never positional parameters).
            const Ltd_bestTail = (): number => {
                // td_best is the best match so far
                td_ambig.value = null;
                return 0;
            };
            const LtdTail = (): number => {
                // td is the new best match
                td_ambig.value = null;
                td_best.value = td;
                m_best.value = m;
                ti.tdtypes.setDim(dedtypes.length);
                // D `memcpy(ti.tdtypes.tdata(), dedtypes.tdata(), ti.tdtypes.length * (void*).sizeof)`
                // — a bulk ELEMENT copy of `ti.tdtypes.length` slots. `tdata()` is the live backing
                // array on both sides (08 §2), so a slot-wise loop is the faithful form; there is no
                // memcpy shim in the port. It also fills every slot `setDim` just grew.
                {
                    const dst = ti.tdtypes.tdata();
                    const src = dedtypes.tdata();
                    for (let k = 0; k < ti.tdtypes.length; k++) dst[k] = src[k];
                }
                return 0;
            };

            if (m < m_best.value) return Ltd_bestTail(); // goto Ltd_best (dmd/templatesem.d:3744)
            if (m > m_best.value) return LtdTail();      // goto Ltd (dmd/templatesem.d:3745)

            // Disambiguate by picking the most specialized TemplateDeclaration
            {
                // `m == m_best` and `m != nomatch` here, so `m_best != nomatch` and `td_best` was
                // set by a previous LtdTail — `!` marks the point D would fault.
                const c1 = leastAsSpecialized(sc, td, td_best.value!, argumentList.copy());
                const c2 = leastAsSpecialized(sc, td_best.value!, td, argumentList.copy());
                //printf("c1 = %d, c2 = %d\n", c1, c2);
                if (c1 > c2) return LtdTail();      // goto Ltd (dmd/templatesem.d:3752)
                if (c1 < c2) return Ltd_bestTail(); // goto Ltd_best (dmd/templatesem.d:3753)
            }

            td_ambig.value = td;
            return 0;
        });

        if (td_ambig.value !== null) {
            error(ti.loc, ds("%s `%s.%s` matches more than one template declaration:"),
                td_best.value!.kind(), td_best.value!.parent!.toPrettyChars(),
                td_best.value!.ident!.toChars());
            errorSupplemental(td_best.value!.loc, ds("`%s`\nand:"), td_best.value!.toChars());
            errorSupplemental(td_ambig.value.loc, ds("`%s`"), td_ambig.value.toChars());
            return false;
        }
        if (td_best.value !== null) {
            if (td_last === null)
                td_last = td_best.value;
            else if (td_last !== td_best.value) {
                ScopeDsymbol.multiplyDefined(ti.loc, td_last, td_best.value);
                return false;
            }
        }
    }

    if (td_last !== null) {
        /* https://issues.dlang.org/show_bug.cgi?id=7469
         * Normalize tiargs by using corresponding deduced
         * template value parameters and tuples for the correct mangling.
         *
         * By doing this before hasNestedArgs, CTFEable local variable will be
         * accepted as a value parameter. For example:
         *
         *  void foo() {
         *    struct S(int n) {}   // non-global template
         *    const int num = 1;   // CTFEable local variable
         *    S!num s;             // S!1 is instantiated, not S!num
         *  }
         */
        const dim = td_last.parameters!.length - (td_last.isVariadic() !== null ? 1 : 0);
        for (let i = 0; i < dim; i++) {
            if (ti.tiargs!.length <= i)
                ti.tiargs!.push(ti.tdtypes.opIndex(i));
            assert(i < ti.tiargs!.length);

            const tvp = td_last.parameters!.opIndex(i)!.isTemplateValueParameter();
            if (tvp === null)
                continue;
            assert(ti.tdtypes.opIndex(i) !== null);
            // tdtypes[i] is already normalized to the required type in matchArg

            ti.tiargs!.opIndexAssign(ti.tdtypes.opIndex(i), i);
        }
        if (td_last.isVariadic() !== null && ti.tiargs!.length === dim && ti.tdtypes.opIndex(dim) !== null) {
            const va = isTuple(ti.tdtypes.opIndex(dim));
            assert(va !== null);
            ti.tiargs!.pushSlice(va!.objects.opSlice());
        }
    } else if (ti.errors && ti.inst !== null) {
        // instantiation was failed with error reporting
        assert(global.errors !== 0);
        return false;
    } else {
        const tdecl = ti.tempdecl!.isTemplateDeclaration();
        computeOneMember(tdecl!);

        if (errs !== global.errors)
            errorSupplemental(ti.loc, ds("while looking for match for `%s`"), ti.toChars());
        else if (tdecl !== null && tdecl.overnext === null) {
            // Only one template, so we can give better error message
            const msg = ds("does not match template declaration");
            // D `const(char)* tip;` handed to `getConstraintEvalError` by `ref` -> one-slot box.
            const tip: Ref<DString | null> = { value: null };
            const buf = new OutBuffer();
            const hgs = new HdrGenState();
            hgs.skipConstraints = true;
            toCharsMaybeConstraints(tdecl, buf, hgs); // templatesem.d:3852
            // `peekChars()` is a VIEW, not a consume (08 §13a.2) — D uses `peekChars` here.
            const tmsg = buf.peekChars();
            const cmsg = getConstraintEvalError(tdecl, tip);
            if (cmsg !== null) {
                error(ti.loc, ds("%s `%s` %s `%s`\n%s"), ti.kind(), ti.toPrettyChars(), msg, tmsg, cmsg);
                if (tip.value !== null)
                    tipDiagnostic(tip.value);
            } else {
                error(ti.loc, ds("%s `%s` %s `%s`"), ti.kind(), ti.toPrettyChars(), msg, tmsg);

                if (tdecl.parameters!.length === ti.tiargs!.length) {
                    // https://issues.dlang.org/show_bug.cgi?id=7352
                    // print additional information, e.g. `foo` is not a type
                    for (const [i, param] of tdecl.parameters!.opSlice().entries()) {
                        const matchRes = matchArgFromTiargs(param!, ti.loc, sc, ti.tiargs!, i,
                            tdecl.parameters!, dedtypes, null);
                        const arg = ti.tiargs!.opIndex(i)!;
                        // D `arg.isDsymbol` / `arg.isExpression` are parenless UFCS calls on the
                        // dtemplate free functions (04 §6), not members of RootObject.
                        const sym = isDsymbol(arg);
                        let exp = isExpression(arg);

                        if (exp !== null)
                            exp = optimize(exp, WANTvalue);

                        if (matchRes === MATCH.nomatch
                            && ((sym !== null && sym.isFuncDeclaration() !== null)
                                || (exp !== null && exp.isVarExp() !== null))) {
                            if (param!.isTemplateTypeParameter() !== null)
                                errorSupplemental(ti.loc, ds("`%s` is not a type"), arg.toChars());
                            else {
                                const tvp = param!.isTemplateValueParameter();
                                if (tvp !== null)
                                    errorSupplemental(ti.loc, ds("`%s` is not of a value of type `%s`"),
                                        arg.toChars(), tvp.valType!.toChars());
                            }
                        }
                    }
                }
            }
        } else {
            error(ti.loc, ds("%s `%s` does not match any template declaration"),
                ti.kind(), ti.toPrettyChars());
            let found = false;
            overloadApply(ti.tempdecl, (s: Dsymbol): number => {
                if (!found)
                    errorSupplemental(ti.loc, ds("Candidates are:"));
                found = true;
                errorSupplemental(s.loc, ds("%s"), s.toChars());
                return 0;
            });
        }
        return false;
    }

    /* The best match is td_last
     */
    ti.tempdecl = td_last;

    return errs === global.errors;
}

/*******************************************
 * Append to buf a textual representation of template parameters with their arguments.
 * Params:
 *  parameters = the template parameters
 *  tiargs = the correspondeing template arguments
 *  variadic = if it's a variadic argument list
 *  buf = where the text output goes
 *
 * dmd/templatesem.d:3928. All three `ref` parameters are ALIASES — the container/buffer objects
 * are passed as-is, no `.copy()` (03 §3.2).
 *
 * D module-private.
 */
function formatParamsWithTiargs(parameters: TemplateParameters, tiargs: Objects, variadic: boolean,
    buf: OutBuffer): void {
    buf.writestring(ds("  with `"));

    // write usual arguments line-by-line
    // skips trailing default ones - they are not present in `tiargs`
    const end = parameters.length - (variadic ? 1 : 0);
    let i = 0;
    for (; i < tiargs.length && i < end; i++) {
        if (i !== 0) { // `if (i)` on a size_t -> explicit `!== 0` (06 §2.5)
            buf.writeByte(0x2c /* , */);
            buf.writenl();
            buf.writestring(ds("       "));
        }
        write(buf, parameters.opIndex(i));
        buf.writestring(ds(" = "));
        write(buf, tiargs.opIndex(i));
    }
    // write remaining variadic arguments on the last line
    if (variadic) {
        if (i !== 0) {
            buf.writeByte(0x2c /* , */);
            buf.writenl();
            buf.writestring(ds("       "));
        }
        write(buf, parameters.opIndex(end));
        buf.writestring(ds(" = "));
        buf.writeByte(0x28 /* ( */);
        if (end < tiargs.length) {
            write(buf, tiargs.opIndex(end));
            for (let j = parameters.length; j < tiargs.length; j++) {
                buf.writestring(ds(", "));
                write(buf, tiargs.opIndex(j));
            }
        }
        buf.writeByte(0x29 /* ) */);
    }
    buf.writeByte(0x60 /* ` */);
}

/******************************
 * Create a scope for the parameters of the TemplateInstance
 * `ti` in the parent scope sc from the ScopeDsymbol paramsym.
 *
 * If paramsym is null a new ScopeDsymbol is used in place of
 * paramsym.
 * Params:
 *      td = template that ti is an instance of
 *      ti = the TemplateInstance whose parameters to generate the scope for.
 *      sc = the parent scope of ti
 * Returns:
 *      new scope for the parameters of ti
 *
 * dmd/templatesem.d:3987. D module-private.
 */
function createScopeForTemplateParameters(td: TemplateDeclaration, ti: TemplateInstance,
    sc: Scope): Scope {
    const paramsym = new ScopeDsymbol();
    paramsym.parent = td._scope!.parent;
    const paramscope = td._scope!.push(paramsym);
    paramscope.tinst = ti;
    paramscope.minst = sc.minst;
    paramscope.callsc = sc;
    paramscope.stc = STC.none;
    return paramscope;
}

/********************************************
 * Determine partial specialization order of `td` vs `td2`.
 * Params:
 *  sc = context
 *  td = first template
 *  td2 = second template
 *  argumentList = arguments to template
 * Returns:
 *      MATCH - td is at least as specialized as td2
 *      MATCH.nomatch - td2 is more specialized than td
 *
 * dmd/templatesem.d:4010. This is the module's OWN `leastAsSpecialized`
 * (TemplateDeclaration-vs-TemplateDeclaration); the FuncDeclaration one is imported under the
 * D:61 alias `funcLeastAsSpecialized` and is never conflated with it.
 * resolved: `enum LOG_LEASTAS = 0;` (D:4012) -> all three `static if` printf blocks dropped; the
 * `L1:` label at D:4061 SURVIVES (it is the goto target).
 */
export function leastAsSpecialized(sc: Scope, td: TemplateDeclaration, td2: TemplateDeclaration,
    argumentList: ArgumentList): MATCH {
    /* This works by taking the template parameters to this template
     * declaration and feeding them to td2 as if it were a template
     * instance.
     * If it works, then this template is at least as specialized
     * as td2.
     */

    // Set type arguments to dummy template instance to be types
    // generated from the parameters to this template declaration
    const tiargs: Objects = new DArray<RootObject | null>();
    tiargs.reserve(td.parameters!.length);
    for (const tp of td.parameters!) {
        if (tp!.dependent)
            break;
        const p = dummyArg(tp!);
        if (p === null) //TemplateTupleParameter
            break;

        tiargs.push(p);
    }
    // `scope` storage class erased (04 §8; JS is GC'd).
    const ti = new TemplateInstance(Loc.initial, td.ident, tiargs); // create dummy template instance

    // Temporary Array to hold deduced types.
    // D `Objects dedtypes = Objects(td2.parameters.length);` pre-sizes WITHOUT filling; the very
    // first thing `matchWithInstance` does is zero it, so no slot is read before it is written.
    const dedtypes: Objects = new DArray<RootObject | null>(td2.parameters!.length);

    // Attempt a type deduction
    const m = matchWithInstance(sc, td2, ti, dedtypes, argumentList.copy(), 1);
    // dmd/templatesem.d:4061 `L1:` is a terminal BAIL tail (`return MATCH.nomatch;` only), and the
    // sole `goto L1` (D:4053) sits inside this `if`. 06 §4: the tail is the single statement after
    // the `if`, so the goto is expressed by simply NOT returning `m` — no closure needed.
    if (m > MATCH.nomatch) {
        /* A non-variadic template is more specialized than a
         * variadic one.
         */
        const tp = td.isVariadic();
        if (!(tp !== null && !tp.dependent && td2.isVariadic() === null)) { // D: `if (…) goto L1;`
            return m;
        }
    }
    // L1:
    return MATCH.nomatch;
}

/**
 * dmd/templatesem.d:4069 — `private RootObject defaultArg(TemplateParameter tp, Loc instLoc,
 * Scope* sc)`. `sc` is dereferenced unconditionally (`sc.push()` at D:4131) before the defensive
 * `assert(sc && sc.tinst)` at D:4139, so it is non-null `Scope` (02 §10.1).
 *
 * D module-private.
 */
function defaultArg(tp: TemplateParameter, instLoc: Loc, sc: Scope): RootObject | null {
    if (tp.isTemplateTupleParameter() !== null)
        return null;
    {
        const tpp = tp.isTemplateTypeParameter();
        if (tpp !== null) {
            let t = tpp.defaultType;
            if (t !== null) {
                t = t.syntaxCopy();
                t = typeSemantic(t, tpp.loc, sc); // use the parameter loc
            }
            return t;
        }
    }
    {
        const tap = tp.isTemplateAliasParameter();
        if (tap !== null) {
            let da: RootObject | null = tap.defaultAlias;
            const ta = isType(tap.defaultAlias);
            if (ta !== null) {
                // dmd/templatesem.d:4088 — dispatch switch S3 (three label groups).
                switch (ta.ty) {
                    // If the default arg is a template, instantiate for each type
                    case TY.Tinstance:
                    // same if the default arg is a mixin, traits, typeof
                    // since the content might rely on a previous parameter
                    // (https://issues.dlang.org/show_bug.cgi?id=23686)
                    case TY.Tmixin:
                    case TY.Ttypeof:
                    case TY.Ttraits:
                        da = ta.syntaxCopy();
                        break;
                    default:
                        break;
                }
            }

            const o = aliasParameterSemantic(tap.loc, sc, da, null); // use the parameter loc
            return o;
        }
    }
    {
        const tvp = tp.isTemplateValueParameter();
        if (tvp !== null) {
            let e = tvp.defaultValue;
            if (e === null)
                return null;

            e = e.syntaxCopy();
            const sc2 = sc.push();
            sc2.inDefaultArg = true;
            e = expressionSemantic(e, sc2);
            sc2.pop();
            if (e === null)
                return null;
            const te = e.isTemplateExp();
            if (te !== null) {
                assert(sc !== null && sc.tinst !== null);
                if (te.td === sc.tinst!.tempdecl) {
                    // defaultValue is a reference to its template declaration
                    // i.e: `template T(int arg = T)`
                    // Raise error now before calling resolveProperties otherwise we'll
                    // start looping on the expansion of the template instance.
                    const td = sc.tinst!.tempdecl!;
                    error(td.loc, ds("%s `%s` recursive template expansion"), td.kind(), td.toPrettyChars());
                    return ErrorExp.get();
                }
            }
            // D: `if ((e = resolveProperties(sc, e)) is null) return null;` — assignment inside the
            // condition; 06 §2.6 hoists it to the statement above and tests the variable.
            e = resolveProperties(sc, e);
            if (e === null)
                return null;
            e = resolveLoc(e, instLoc, sc); // use the instantiated loc
            e = optimize(e, WANTvalue);

            return e;
        }
    }
    return assertUnreachable(); // dmd/templatesem.d:4139 `assert(0);`
}

/*************************************************
 * Match function arguments against a specific template function.
 *
 * Params:
 *     td = template declaration for template instance
 *     ti = template instance. `ti.tdtypes` will be set to Expression/Type deduced template arguments
 *     sc = instantiation scope
 *     fd = Partially instantiated function declaration, which is set to an instantiated function declaration
 *     tthis = 'this' argument if !NULL
 *     argumentList = arguments to function
 *
 * Returns:
 *      match pair of initial and inferred template arguments
 *
 * dmd/templatesem.d:4156 — `private MATCHpair deduceFunctionTemplateMatch(TemplateDeclaration td,
 * TemplateInstance ti, Scope* sc, ref FuncDeclaration fd, Type tthis, ArgumentList argumentList)`.
 *
 * `ref FuncDeclaration fd` REBINDS the caller's reference (D:5124 `fd = doHeaderInstantiation(…)`)
 * and the caller tests the result for null (`if (!fd || …)`, D:6035) -> the one-slot box
 * `Ref<FuncDeclaration | null>` (03 §3.3 / §7.2). A local mirror `fdCur` carries the value for the
 * ~8 reads D makes through the reference before the rebind; the rebind writes BOTH.
 *
 * `tthis` is REASSIGNED (D:4342 `tthis = null;`) and the reassigned value is what reaches
 * `doHeaderInstantiation` — the port assigns the parameter directly, exactly as D does.
 *
 * resolved: `version (none)` at D:4158, :4209, :4280, :4702, :5135 -> OFF, all dropped.
 *
 * The goto lattice (`Lmatch` / `Lvarargs` / `Lretry` / `L1`) is documented in the fragment header.
 *
 * D module-private.
 */
function deduceFunctionTemplateMatch(td: TemplateDeclaration, ti: TemplateInstance, sc: Scope,
    fd: Ref<FuncDeclaration | null>, tthis: Type | null, argumentList: ArgumentList): MATCHpair {
    assert(td._scope !== null);

    const dedargs: Objects = new DArray<RootObject | null>(td.parameters!.length);
    // D `dedargs.zero()` (templatesem.d:4175) — see the fragment header. The slots ARE read as
    // `null` below (`RootObject oarg = (*dedargs)[i]; if (oarg) continue;`, D:4635/:5015).
    dedargs.zero();
    for (let z = 0; z < dedargs.length; z++) dedargs.opIndexAssign(null, z);

    // D `Objects* dedtypes = &ti.tdtypes;` — a pointer to a field held BY VALUE; the TS container
    // object IS that reference (02 §10 case 2 / 03 §7.2), so every `*dedtypes` below is `dedtypes`.
    const dedtypes: Objects = ti.tdtypes; // for T:T*, the dedargs is the T*, dedtypes is the T
    dedtypes.setDim(td.parameters!.length);
    // D `dedtypes.zero()` (templatesem.d:4179) — same default-dependence as above.
    dedtypes.zero();
    for (let z = 0; z < dedtypes.length; z++) dedtypes.opIndexAssign(null, z);

    // The `ref FuncDeclaration fd` mirror — D dereferences the reference immediately (`fd.errors`),
    // so it is non-null on entry (02 §10.1); `!` marks that fault point.
    let fdCur: FuncDeclaration = fd.value!;

    if (td.errors || fdCur.errors)
        return new MATCHpair(MATCH.nomatch, MATCH.nomatch);

    // Set up scope for parameters
    const paramscope = createScopeForTemplateParameters(td, ti, sc);

    // dmd/templatesem.d:4187 — nested `MATCHpair nomatch()`.
    const nomatch = (): MATCHpair => {
        paramscope.pop();
        //printf("\tnomatch\n");
        return new MATCHpair(MATCH.nomatch, MATCH.nomatch);
    };

    // dmd/templatesem.d:4194 — nested `MATCHpair matcherror()`.
    const matcherror = (): MATCHpair => {
        // todo: for the future improvement
        paramscope.pop();
        //printf("\terror\n");
        return new MATCHpair(MATCH.nomatch, MATCH.nomatch);
    };
    // Mark the parameter scope as deprecated if the templated
    // function is deprecated (since paramscope.enclosing is the
    // calling scope already)
    paramscope.stc = (paramscope.stc | (fdCur.storage_class & STC.deprecated_)) as STC;

    const tp = td.isVariadic();
    let declaredTuple: Tuple | null = null;

    let ntargs = 0; // array size of tiargs
    let inferStart = 0; // index of first template parameter to infer from function argument
    const instLoc = ti.loc;
    let matchTiargs = MATCH.exact;

    {
        // 06 §2.6 — `if (auto tiargs = ti.tiargs)` hoisted to a `const` + explicit null test.
        const tiargs = ti.tiargs;
        if (tiargs !== null) {
            // Set initial template arguments
            ntargs = tiargs.length;
            let n = td.parameters!.length;
            if (tp !== null)
                n--;
            if (ntargs > n) {
                if (tp === null)
                    return nomatch();

                /* The extra initial template arguments
                 * now form the tuple argument.
                 */
                const t = new Tuple(ntargs - n);
                assert(td.parameters!.length !== 0); // `if (length)` on a size_t -> `!== 0` (06 §2.5)
                dedargs.opIndexAssign(t, td.parameters!.length - 1);

                for (let i = 0; i < t.objects.length; i++) {
                    t.objects.opIndexAssign(tiargs.opIndex(n + i), i);
                }
                declareParameterWithValue(td, paramscope, tp, t);
                declaredTuple = t;
            } else
                n = ntargs;

            // D `memcpy(dedargs.tdata(), tiargs.tdata(), n * (*dedargs.tdata()).sizeof)` — a bulk
            // ELEMENT copy of the first `n` slots (08 §2; `tdata()` is the live backing array on
            // both sides, and there is no memcpy shim in the port).
            {
                const dst = dedargs.tdata();
                const src = tiargs.tdata();
                for (let k = 0; k < n; k++) dst[k] = src[k];
            }

            for (let i = 0; i < n; i++) {
                assert(i < td.parameters!.length);
                // D `Declaration sparam = null;` + `&sparam` -> the one-slot box (03 §3.3).
                const sparam: Ref<Declaration | null> = { value: null };
                const m = matchArgFromTiargs(td.parameters!.opIndex(i)!, instLoc, paramscope, dedargs,
                    i, td.parameters!, dedtypes, sparam);
                //printf("\tdeduceType m = %d\n", m);
                if (m === MATCH.nomatch)
                    return nomatch();
                if (m < matchTiargs)
                    matchTiargs = m;

                dsymbolSemantic(sparam.value!, paramscope);
                if (insert(paramscope, sparam.value!) === null)
                    return nomatch();
            }
            if (n < td.parameters!.length && declaredTuple === null) {
                inferStart = n;
            } else
                inferStart = td.parameters!.length;
            //printf("tiargs matchTiargs = %d\n", matchTiargs);
        }
    }

    // D `ParameterList fparameters = fd.getParameterList();` — a fresh rvalue that is only READ
    // here, so the copy is elided (03 §9 condition 2: fresh temporary, no aliasing possible).
    const fparameters = fdCur.getParameterList(); // function parameter list
    const nfparams = fparameters.length(); // number of function parameters

    /* Check for match of function arguments with variadic template
     * parameter, such as:
     *
     * void foo(T, A...)(T t, A a);
     * void main() { foo(1,2,3); }
     */
    let fptupindex = IDX_NOTFOUND;
    if (tp !== null) { // if variadic
        // TemplateTupleParameter always makes most lesser matching.
        matchTiargs = MATCH.convert;

        if (nfparams === 0 && argumentList.length() !== 0) { // if no function parameters
            if (declaredTuple === null) {
                const t = new Tuple();
                //printf("t = %p\n", t);
                dedargs.opIndexAssign(t, td.parameters!.length - 1);
                declareParameterWithValue(td, paramscope, tp, t);
                declaredTuple = t;
            }
        } else {
            /* Figure out which of the function parameters matches
             * the tuple template parameter. Do this by matching
             * type identifiers.
             * Set the index of this function parameter to fptupindex.
             */
            // dmd/templatesem.d:4340 `L1:` — a break-out-of-loop that SKIPS the trailing
            // `fptupindex = IDX_NOTFOUND;`; the label body is empty, so a labeled BLOCK plus
            // `break L1;` reproduces it exactly (06 §4).
            L1: {
                for (fptupindex = 0; fptupindex < nfparams; fptupindex++) {
                    // D indexes the RAW parameter array here while `nfparams` is the EXPANDED
                    // length — kept 1:1.
                    const fparam = fparameters.parameters!.opIndex(fptupindex)!; // fparameters[fptupindex] ?
                    if (fparam.type!.ty !== TY.Tident)
                        continue;
                    const tid = fparam.type!.isTypeIdentifier()!;
                    if (!tp.ident!.equals(tid.ident) || tid.idents.length !== 0)
                        continue;

                    if (fparameters.varargs !== VarArg.none) // variadic function doesn't
                        return nomatch(); // go with variadic template

                    break L1; // goto L1 (dmd/templatesem.d:4339)
                }
                fptupindex = IDX_NOTFOUND;
            }
        }
    }

    let match = MATCH.exact;
    if (td.toParent()!.isModule() !== null)
        tthis = null;
    if (tthis !== null) {
        let hasttp = false;

        // Match 'tthis' to any TemplateThisParameter's
        for (const param of td.parameters!) {
            const ttp = param!.isTemplateThisParameter();
            if (ttp !== null) {
                hasttp = true;

                const t: Type = new TypeIdentifier(Loc.initial, ttp.ident);
                const m = deduceType(tthis, paramscope, t, td.parameters!, dedtypes);
                if (m === MATCH.nomatch)
                    return nomatch();
                if (m < match)
                    match = m; // pick worst match
            }
        }

        // Match attributes of tthis against attributes of fd
        if (fdCur.type !== null && fdCur.isCtorDeclaration() === null
            && (td._scope!.stc & STC.static_) === 0n) {
            let stc: STC = (td._scope!.stc | fdCur.storage_class2) as STC;
            // Propagate parent storage class, https://issues.dlang.org/show_bug.cgi?id=5504
            let p: Dsymbol | null = td.parent;
            while (p!.isTemplateDeclaration() !== null || p!.isTemplateInstance() !== null)
                p = p!.parent;
            const ad = p!.isAggregateDeclaration();
            if (ad !== null)
                stc = (stc | ad.storage_class) as STC;

            let mod: MOD = fdCur.type.mod;
            if ((stc & STC.immutable_) !== 0n)
                mod = MODFlags.immutable_;
            else {
                if ((stc & (STC.shared_ | STC.synchronized_)) !== 0n)
                    mod |= MODFlags.shared_;
                if ((stc & STC.const_) !== 0n)
                    mod |= MODFlags.const_;
                if ((stc & STC.wild) !== 0n)
                    mod |= MODFlags.wild;
            }

            const thismod: MOD = tthis.mod;
            if (hasttp)
                mod = MODmerge(thismod, mod);
            const m = MODmethodConv(thismod, mod);
            if (m === MATCH.nomatch)
                return nomatch();
            if (m < match)
                match = m;
        }
    }

    // Loop through the function parameters
    // dmd/templatesem.d:4998 `Lmatch:` is reached BOTH by fall-through out of this block and by
    // `goto Lmatch;` from inside the Lvarargs switch (D:4982, :4986) -> a labeled BLOCK whose
    // `break Lmatch;` lands on the shared tail below (06 §4).
    Lmatch: {
        //printf("%s\n\tnfargs = %d, nfparams = %d, tuple_dim = %d\n", …);
        //printf("\ttp = %p, fptupindex = %d, found = %d, declaredTuple = %s\n", …);
        //
        // dmd/templatesem.d:4407 — `enum DEFAULT_ARGI = size_t.max - 10;`, a PSEUDO-INDEX marking
        // "this parameter is expected to take its default argument". In the `number` index domain
        // `2 ** 64 - 10` folds to exactly `2 ** 64` (2^64-10 is not representable) — which is
        // harmless for the only two things D does with it here: `===`/`!==` against ITSELF, and
        // `>=`/`<` against a real argument count (both give D's answer for any real length).
        // Every arithmetic use is inside an `argi !== DEFAULT_ARGI` guard — VERIFIED at D:4445
        // (which gates D:4287/:4291/:4297/:4539/:4540), D:4653, D:4677, D:4816 — with ONE
        // exception, the `fargs.length - argi` of the Tsarray/Taarray arm, which carries a
        // stop-stub escalation at its site (see D:4878 below).
        const DEFAULT_ARGI = 2 ** 64 - 10; // pseudo index signifying the parameter is expected to be assigned its default argument
        let argi = 0; // current argument index
        let argsConsumed = 0; // to ensure no excess arguments
        let nfargs2 = argumentList.length(); // total number of arguments including applied defaultArgs
        let inoutMatch = 0; // for debugging only
        // D `Expression[] fargs = argumentList.arguments ? (*argumentList.arguments)[] : null;` —
        // the null slice is only ever MEASURED and INDEXED here (never null-tested), and D's
        // `null.length` is 0, so the empty array is exactly equivalent (06 §2.7).
        const fargs: (Expression | null)[] = argumentList.arguments_ !== null
            ? argumentList.arguments_.opSlice() : [];
        const fnames: ArgumentLabel[] = argumentList.names !== null
            ? argumentList.names.opSlice() : [];

        // The `parami` loop carries the label because D's `continue;` at D:4855 sits INSIDE the
        // `Lretry` loop and continues THIS loop, not that one.
        Lparami: for (let parami = 0; parami < nfparams; parami++) {
            // D declares `fparam` / `prmtype` / `farg` at LOOP-BODY scope and the `Lvarargs:` tail
            // reads them, so they are declared above the labeled block that models the pre-tail
            // region (same scope D gives them).
            const fparam = fparameters.opIndex(parami)!;

            // Apply function parameter storage classes to parameter types
            let prmtype = addStorageClass(fparam.type!, fparam.storageClass);

            let farg: Expression | null = null;

            // dmd/templatesem.d:4858 `Lvarargs:` — the tail of ONE iteration, reached by
            // fall-through and by three `goto Lvarargs;` (D:4561 from a nested `for`, D:4585,
            // D:4816). The pre-tail region is the labeled block; each goto is `break Lvarargs;`.
            Lvarargs: {
                const fname: Identifier | null = argi < fnames.length ? fnames[argi]!.name : null;
                let foundName = false;
                if (fparam.ident !== null) {
                    for (let i = 0; i < fnames.length; i++) {
                        if (fparam.ident === fnames[i]!.name) {
                            argi = i;
                            foundName = true;
                            break;  //Exits the loop after a match
                        }
                    }
                }
                if (fname !== null && !foundName) {
                    argi = DEFAULT_ARGI;
                }

                /* See function parameters which wound up
                 * as part of a template tuple parameter.
                 */
                if (fptupindex !== IDX_NOTFOUND && parami === fptupindex && argi !== DEFAULT_ARGI) {
                    const tid = prmtype.isTypeIdentifier();
                    assert(tid !== null);
                    if (declaredTuple === null) {
                        /* The types of the function arguments
                         * now form the tuple argument.
                         */
                        declaredTuple = new Tuple();
                        dedargs.opIndexAssign(declaredTuple, td.parameters!.length - 1);

                        /* Count function parameters with no defaults following a tuple parameter.
                         * void foo(U, T...)(int y, T, U, double, int bar = 0) {}  // rem == 2 (U, double)
                         */
                        let rem = 0;
                        for (let j = parami + 1; j < nfparams; j++) {
                            const p = fparameters.opIndex(j)!;
                            if (p.defaultArg !== null) {
                                break;
                            }
                            // D's inner `foreach (argLabel; fnames) { if (…) break; }` breaks only
                            // the INNER loop and has no other effect — kept 1:1. `ArgumentLabel` is
                            // a value struct read-only here, so the per-element copy is elided
                            // (03 §9: never mutated).
                            for (const argLabel of fnames) {
                                if (p.ident === argLabel.name)
                                    break;
                            }
                            if (!reliesOnTemplateParameters(p.type!,
                                    td.parameters!.opSlice(inferStart, td.parameters!.length))) {
                                const pt = typeSemantic(p.type!.syntaxCopy(), fdCur.loc, paramscope);
                                const ptt = pt.isTypeTuple();
                                if (ptt !== null)
                                    rem += ptt.arguments!.length;
                                else
                                    rem += 1;
                            } else {
                                ++rem;
                            }
                        }

                        if (nfargs2 - argi < rem)
                            return nomatch();
                        declaredTuple.objects.setDim(nfargs2 - argi - rem);
                        // Every slot grown above is written by this loop — no `.init` dependence.
                        for (let i = 0; i < declaredTuple.objects.length; i++) {
                            farg = fargs[argi + i];

                            // Check invalid arguments to detect errors early.
                            if (farg!.op === EXP.error || farg!.type!.ty === TY.Terror)
                                return nomatch();

                            if (!fparam.isLazy() && farg!.type!.ty === TY.Tvoid)
                                return nomatch();

                            // D `Type tt;` handed to `deduceWildHelper(…, &tt, …)` (a `Type*`) and
                            // to `deduceTypeHelper(…, tt, …)` (an `out Type`) — one one-slot box
                            // serves both (03 §3.3 / §7.2).
                            const tt: Ref<Type | null> = { value: null };
                            let m: MATCH;
                            // 06 §2.6 hoist; `ubyte wm` in a boolean context -> `!== 0` (06 §2.5).
                            const wm = deduceWildHelper(farg!.type!, tt, tid!);
                            if (wm !== 0) {
                                inoutMatch |= wm;
                                m = MATCH.constant;
                            } else {
                                m = deduceTypeHelper(farg!.type!, tt, tid!);
                            }
                            if (m === MATCH.nomatch)
                                return nomatch();
                            if (m < match)
                                match = m;

                            /* Remove top const for dynamic array types and pointer types
                             */
                            let ttv: Type = tt.value!;
                            if ((ttv.ty === TY.Tarray || ttv.ty === TY.Tpointer) && !ttv.isMutable()
                                && ((fparam.storageClass & STC.ref_) === 0n
                                    || ((fparam.storageClass & STC.auto_) !== 0n && !isLvalue(farg!)))) {
                                ttv = mutableOf(ttv);
                            }
                            declaredTuple.objects.opIndexAssign(ttv, i);
                        }
                        declareParameterWithValue(td, paramscope, tp!, declaredTuple);
                    } else {
                        // https://issues.dlang.org/show_bug.cgi?id=6810
                        // If declared tuple is not a type tuple,
                        // it cannot be function parameter types.
                        for (let i = 0; i < declaredTuple.objects.length; i++) {
                            if (isType(declaredTuple.objects.opIndex(i)) === null)
                                return nomatch();
                        }
                    }
                    assert(declaredTuple !== null);
                    argi += declaredTuple.objects.length;
                    argsConsumed += declaredTuple.objects.length;
                    continue Lparami;
                }

                // If parameter type doesn't depend on inferred template parameters,
                // semantic it to get actual type.
                if (!reliesOnTemplateParameters(prmtype,
                        td.parameters!.opSlice(inferStart, td.parameters!.length))) {
                    // should copy prmtype to avoid affecting semantic result
                    prmtype = typeSemantic(prmtype.syntaxCopy(), fdCur.loc, paramscope);

                    const tt = prmtype.isTypeTuple();
                    if (tt !== null) {
                        const tt_dim = tt.arguments!.length;
                        for (let j = 0; j < tt_dim; j++, ++argi, ++argsConsumed) {
                            const p = tt.arguments!.opIndex(j)!;
                            if (j === tt_dim - 1 && fparameters.varargs === VarArg.typesafe
                                && parami + 1 === nfparams && argi < fargs.length) {
                                prmtype = p.type!;
                                break Lvarargs; // goto Lvarargs (dmd/templatesem.d:4561)
                            }
                            if (argi >= fargs.length) {
                                if (p.defaultArg !== null)
                                    continue;

                                // https://issues.dlang.org/show_bug.cgi?id=19888
                                if (fparam.defaultArg !== null)
                                    break;

                                return nomatch();
                            }
                            farg = fargs[argi];
                            if (implicitConvTo(farg!, p.type!) === MATCH.nomatch)
                                return nomatch();
                        }
                        continue Lparami;
                    }
                }

                if (argi >= fargs.length) { // if not enough arguments
                    if (fparam.defaultArg === null)
                        break Lvarargs; // goto Lvarargs (dmd/templatesem.d:4585)

                    /* https://issues.dlang.org/show_bug.cgi?id=2803
                     * Before the starting of type deduction from the function
                     * default arguments, set the already deduced parameters into paramscope.
                     * It's necessary to avoid breaking existing acceptable code. Cases:
                     *
                     * 1. Already deduced template parameters can appear in fparam.defaultArg:
                     *  auto foo(A, B)(A a, B b = A.stringof);
                     *  foo(1);
                     *  // at fparam == 'B b = A.string', A is equivalent with the deduced type 'int'
                     *
                     * 2. If prmtype depends on default-specified template parameter, the
                     * default type should be preferred.
                     *  auto foo(N = size_t, R)(R r, N start = 0)
                     *  foo([1,2,3]);
                     *  // at fparam `N start = 0`, N should be 'size_t' before
                     *  // the deduction result from fparam.defaultArg.
                     */
                    if (argi === fargs.length) {
                        // D `foreach (ref dedtype; *dedtypes)` WRITES the slot -> indexed write.
                        for (let di = 0; di < dedtypes.length; di++) {
                            const at = isType(dedtypes.opIndex(di));
                            if (at !== null && at.ty === TY.Tnone) {
                                // D `cast(TypeDeduced)at` — the adjacent `at.ty == Tnone` test IS
                                // the proof (TypeDeduced, dtemplate.d:386, is the only `Tnone`
                                // type): the 02 §11.5c #3 tag-proved RTTI downcast. `TypeDeduced`
                                // is an interface + lazy ctor binding here (dtemplate.ts:444), so
                                // `instanceof` is not available at this position.
                                const xt = at as unknown as TypeDeduced;
                                dedtypes.opIndexAssign(xt.tded, di); // 'unbox'
                            }
                        }
                        for (let i = ntargs; i < dedargs.length; i++) {
                            const tparam = td.parameters!.opIndex(i)!;

                            const oarg = dedargs.opIndex(i);
                            let oded = dedtypes.opIndex(i);
                            if (oarg !== null)
                                continue;

                            if (oded !== null) {
                                if (tparam.specialization() !== null
                                    || tparam.isTemplateTypeParameter() === null) {
                                    /* The specialization can work as long as afterwards
                                     * the oded == oarg
                                     */
                                    dedargs.opIndexAssign(oded, i);
                                    const m2 = matchArgFromTiargs(tparam, instLoc, paramscope, dedargs,
                                        i, td.parameters!, dedtypes, null);
                                    //printf("m2 = %d\n", m2);
                                    if (m2 === MATCH.nomatch)
                                        return nomatch();
                                    if (m2 < matchTiargs)
                                        matchTiargs = m2; // pick worst match
                                    if (!rootObjectsEqual(dedtypes.opIndex(i)!, oded))
                                        // D passes FIVE arguments to a THREE-`%s` format here
                                        // (templatesem.d:4655) — kept verbatim; the extra args are
                                        // ignored by the formatter, exactly as in D.
                                        error(td.loc,
                                            ds("%s `%s` specialization not allowed for deduced parameter `%s`"),
                                            td.kind(), td.toPrettyChars(), td.kind(), td.toPrettyChars(),
                                            tparam.ident!.toChars());
                                } else {
                                    if (MATCH.convert < matchTiargs)
                                        matchTiargs = MATCH.convert;
                                }
                                dedargs.opIndexAssign(
                                    declareParameterWithValue(td, paramscope, tparam, oded), i);
                            } else {
                                oded = defaultArg(tparam, instLoc, paramscope);
                                if (oded !== null)
                                    dedargs.opIndexAssign(
                                        declareParameterWithValue(td, paramscope, tparam, oded), i);
                            }
                        }
                    }

                    if (argi !== DEFAULT_ARGI)
                        nfargs2 = argi + 1;

                    /* If prmtype does not depend on any template parameters:
                     *
                     *  auto foo(T)(T v, double x = 0);
                     *  foo("str");
                     *  // at fparam == 'double x = 0'
                     *
                     * or, if all template parameters in the prmtype are already deduced:
                     *
                     *  auto foo(R)(R range, ElementType!R sum = 0);
                     *  foo([1,2,3]);
                     *  // at fparam == 'ElementType!R sum = 0'
                     *
                     * Deducing prmtype from fparam.defaultArg is not necessary.
                     */
                    if (prmtype.deco !== null
                        || trySemanticType(prmtype.syntaxCopy(), td.loc, paramscope) !== null) {
                        if (argi !== DEFAULT_ARGI) {
                            ++argi;
                            ++argsConsumed;
                        }
                        continue Lparami;
                    }

                    // Deduce prmtype from the defaultArg.
                    farg = fparam.defaultArg!.syntaxCopy();
                    farg = expressionSemantic(farg, paramscope);
                    farg = resolveProperties(paramscope, farg);
                } else {
                    farg = fargs[argi];
                }
                {
                    assert(farg !== null);
                    // Check invalid arguments to detect errors early.
                    if (farg!.op === EXP.error || farg!.type!.ty === TY.Terror)
                        return nomatch();

                    // D `Type att = null;` is handed to `isRecursiveAliasThis(att, …)` by `ref`
                    // -> the one-slot box (03 §3.3). It is declared OUTSIDE the retry loop, as D
                    // declares it above `Lretry:`.
                    const att: Ref<Type | null> = { value: null };
                    // dmd/templatesem.d:4701 `Lretry:` — RETRY (backward) shape (06 §4).
                    Lretry: for (;;) {
                        let argtype: Type = farg!.type!;

                        if (!fparam.isLazy() && argtype.ty === TY.Tvoid && farg!.op !== EXP.function_)
                            return nomatch();

                        // https://issues.dlang.org/show_bug.cgi?id=12876
                        // Optimize argument to allow CT-known length matching
                        farg = optimize(farg!, WANTvalue, fparam.isReference());
                        //printf("farg = %s %s\n", farg.type.toChars(), farg.toChars());

                        let oarg: RootObject = farg!;

                        if (farg!.isFuncExp() !== null) {
                            // When assigning an untyped (void) lambda `x => y` to a `(F)(ref F)` parameter,
                            // we don't want to deduce type void creating a void parameter
                        } else if ((fparam.storageClass & STC.ref_) !== 0n
                            && ((fparam.storageClass & STC.auto_) === 0n || isLvalue(farg!))) {
                            /* Allow expressions that have CT-known boundaries and type [] to match with [dim]
                             */
                            let inferIndexType = (argtype.ty === TY.Tarray)
                                && (prmtype.ty === TY.Tsarray || prmtype.ty === TY.Taarray);
                            const aaType = prmtype.isTypeAArray();
                            if (aaType !== null) {
                                const indexType = aaType.index!.isTypeIdentifier();
                                if (indexType !== null) {
                                    inferIndexType = indexType.idents.length === 0;
                                }
                            }
                            if (inferIndexType) {
                                // 06 §2.6 chained declaration-in-condition -> nested hoists.
                                const se = farg!.isStringExp();
                                if (se !== null) {
                                    argtype = sarrayOf(nextOf(se.type!)!, BigInt(se.len));
                                } else {
                                    const ae = farg!.isArrayLiteralExp();
                                    if (ae !== null) {
                                        // `ArrayLiteralExp.elements` is `Expressions*` in D and
                                        // `ae.elements.length` faults on null — `!`, not `?? []`.
                                        argtype = sarrayOf(nextOf(ae.type!)!,
                                            BigInt(ae.elements!.length));
                                    } else {
                                        const sl = farg!.isSliceExp();
                                        if (sl !== null) {
                                            const tsa = toStaticArrayType(sl);
                                            if (tsa !== null)
                                                argtype = tsa;
                                        }
                                    }
                                }
                            }

                            oarg = argtype;
                        } else if ((fparam.storageClass & STC.out_) === 0n
                            && (argtype.ty === TY.Tarray || argtype.ty === TY.Tpointer)
                            && templateParameterLookup(prmtype, td.parameters!) !== IDX_NOTFOUND
                            && prmtype.isTypeIdentifier()!.idents.length === 0) {
                            /* The farg passing to the prmtype always make a copy. Therefore,
                             * we can shrink the set of the deduced type arguments for prmtype
                             * by adjusting top-qualifier of the argtype.
                             *
                             *  prmtype         argtype     ta
                             *  T            <- const(E)[]  const(E)[]
                             *  T            <- const(E[])  const(E)[]
                             *  qualifier(T) <- const(E)[]  const(E[])
                             *  qualifier(T) <- const(E[])  const(E[])
                             */
                            const ta = castMod(argtype, prmtype.mod !== 0 ? nextOf(argtype)!.mod : 0);
                            if (ta !== argtype) {
                                const ea = farg!.copy();
                                ea.type = ta;
                                oarg = ea;
                            }
                        }

                        if (fparameters.varargs === VarArg.typesafe && parami + 1 === nfparams
                            && argi + 1 < fargs.length)
                            break Lvarargs; // goto Lvarargs (dmd/templatesem.d:4816)

                        // D `uint im = 0;` handed to `deduceType(…, &im, …)` -> one-slot box.
                        const im: Ref<number> = { value: 0 };
                        let m = deduceType(oarg, paramscope, prmtype, td.parameters!, dedtypes, im,
                            inferStart);
                        //printf("\tL%d deduceType m = %d, im = x%x, inoutMatch = x%x\n", …);
                        inoutMatch |= im.value;

                        /* If no match, see if the argument can be matched by using
                         * implicit conversions.
                         */
                        if (m === MATCH.nomatch && prmtype.deco !== null)
                            m = implicitConvTo(farg!, prmtype);

                        if (m === MATCH.nomatch) {
                            const ad = isAggregate(farg!.type!);
                            if (ad !== null && ad.aliasthis !== null && !isRecursiveAliasThis(att, argtype)) {
                                // https://issues.dlang.org/show_bug.cgi?id=12537
                                // The isRecursiveAliasThis() call above

                                /* If a semantic error occurs while doing alias this,
                                 * eg purity(https://issues.dlang.org/show_bug.cgi?id=7295),
                                 * just regard it as not a match.
                                 *
                                 * We also save/restore sc.func.flags to avoid messing up
                                 * attribute inference in the evaluation.
                                */
                                const oldflags = sc.func !== null ? sc.func.saveFlags() : 0;
                                const e = resolveAliasThis(sc, farg!, true);
                                if (sc.func !== null)
                                    sc.func.restoreFlags(oldflags);
                                if (e !== null) {
                                    farg = e;
                                    continue Lretry; // goto Lretry (dmd/templatesem.d:4823)
                                }
                            }
                        }

                        if (m > MATCH.nomatch
                            && (fparam.storageClass & (STC.ref_ | STC.auto_)) === STC.ref_) {
                            if (!isLvalue(farg!)) {
                                if ((farg!.op === EXP.string_ || farg!.op === EXP.slice)
                                    && (prmtype.ty === TY.Tsarray || prmtype.ty === TY.Taarray)) {
                                    // Allow conversion from T[lwr .. upr] to ref T[upr-lwr]
                                } else if (sc.previews.rvalueRefParam) {
                                    // Allow implicit conversion to ref
                                } else
                                    return nomatch();
                            }
                        }
                        if (m > MATCH.nomatch && (fparam.storageClass & STC.out_) !== 0n) {
                            if (!isLvalue(farg!))
                                return nomatch();
                            if (!farg!.type!.isMutable()) // https://issues.dlang.org/show_bug.cgi?id=11916
                                return nomatch();
                        }
                        if (m === MATCH.nomatch && fparam.isLazy() && prmtype.ty === TY.Tvoid
                            && farg!.type!.ty !== TY.Tvoid)
                            m = MATCH.convert;
                        if (m !== MATCH.nomatch) {
                            if (m < match)
                                match = m; // pick worst match
                            if (argi !== DEFAULT_ARGI) {
                                argi++;
                                argsConsumed++;
                            }
                            continue Lparami;
                        }
                        // D falls off the end of the `Lretry` region here, into `Lvarargs:`.
                        break Lretry;
                    }
                }
            }

            // Lvarargs:
            /* The following code for variadic arguments closely
             * matches TypeFunction.callMatch()
             */
            if (!(fparameters.varargs === VarArg.typesafe && parami + 1 === nfparams))
                return nomatch();

            /* Check for match with function parameter T...
             */
            const tb = toBasetype(prmtype);
            // dmd/templatesem.d:4868 — dispatch switch S4, emitted in full.
            switch (tb.ty) {
                // 6764 fix - TypeAArray may be TypeSArray have not yet run semantic().
                case TY.Tsarray:
                case TY.Taarray: {
                    // DJS-ESCALATE: `fargs.length - argi` is size_t arithmetic reachable with argi == DEFAULT_ARGI  (dmd/templatesem.d:4878)
                    // The `goto Lvarargs` at D:4585 leaves `argi` at DEFAULT_ARGI when the named
                    // argument matched no parameter and the parameter has no default; D then wraps
                    // modulo 2^64 (`fargs.length + 10`), which the `number`-domain DEFAULT_ARGI
                    // cannot reproduce. Only this path is stubbed; the normal path below is 1:1.
                    if (argi === DEFAULT_ARGI)
                        throw new Error("DJS-ESCALATE: not translated — see escalation report");

                    // Perhaps we can do better with this, see TypeFunction.callMatch()
                    const tsa = tb.isTypeSArray();
                    if (tsa !== null) {
                        const sz = toInteger(tsa.dim!);
                        // `sz` is `dinteger_t` (bigint, 09 §1) while `fargs.length - argi` is in the
                        // `number` index domain — widen the narrow operand (09 §5).
                        if (sz !== BigInt(fargs.length - argi))
                            return nomatch();
                    } else {
                        const taa = tb.isTypeAArray();
                        if (taa !== null) {
                            const dim: Expression = new IntegerExp(instLoc,
                                BigInt(fargs.length - argi), Type.tsize_t);

                            const i = templateParameterLookup(taa.index!, td.parameters!);
                            if (i === IDX_NOTFOUND) {
                                // D `Expression e; Type t; Dsymbol s;` are `out` arguments of
                                // `Type.resolve` -> one-slot boxes (03 §3.3).
                                const eBox: Ref<Expression | null> = { value: null };
                                const tBox: Ref<Type | null> = { value: null };
                                const sBox: Ref<Dsymbol | null> = { value: null };
                                let sco: Scope;

                                const errors = global.startGagging();
                                // GAG PAIRING (11 §2.5): `resolve` reaches walls — exit paths D
                                // does not have — so the process-global `global.gag` counter is
                                // drained in a `finally` D (templatesem.d:4893-4906) does not
                                // need. Inert on every path D itself takes.
                                try {
                                    /* ref: https://issues.dlang.org/show_bug.cgi?id=11118
                                     * The parameter isn't part of the template
                                     * ones, let's try to find it in the
                                     * instantiation scope 'sc' and the one
                                     * belonging to the template itself. */
                                    sco = sc;
                                    resolve(taa.index!, instLoc, sco, eBox, tBox, sBox);
                                    if (eBox.value === null) {
                                        sco = paramscope;
                                        resolve(taa.index!, instLoc, sco, eBox, tBox, sBox);
                                    }
                                } finally {
                                    global.endGagging(errors);
                                }

                                if (eBox.value === null)
                                    return nomatch();

                                let e: Expression = eBox.value;
                                e = ctfeInterpret(e);
                                e = implicitCastTo(e, sco, Type.tsize_t);
                                e = optimize(e, WANTvalue);
                                if (!expressionEquals(dim, e))
                                    return nomatch();
                            } else {
                                // This code matches code in TypeInstance.deduceType()
                                const tprm = td.parameters!.opIndex(i)!;
                                const tvp = tprm.isTemplateValueParameter();
                                if (tvp === null)
                                    return nomatch();
                                // D `cast(Expression)(*dedtypes)[i]` — tag-gated `isExpression`.
                                const e = isExpression(dedtypes.opIndex(i));
                                if (e !== null) {
                                    if (!expressionEquals(dim, e))
                                        return nomatch();
                                } else {
                                    const vt = typeSemantic(tvp.valType!, Loc.initial, sc);
                                    const m = implicitConvTo(dim, vt);
                                    if (m === MATCH.nomatch)
                                        return nomatch();
                                    dedtypes.opIndexAssign(dim, i);
                                }
                            }
                        }
                    }
                }
                // goto case Tarray; (dmd/templatesem.d:4979) -> the ADJACENT next case, so JS
                // no-break fallthrough reproduces it exactly (06 §3.6(a)).
                case TY.Tarray: {
                    // D `TypeArray ta = cast(TypeArray)tb;` then `ta.next`. `tb` here is a
                    // TypeSArray / TypeDArray / TypeAArray — all `TypeNext` — and typesem's
                    // `nextOf` on a `TypeNext` returns exactly that `.next` field, so the downcast
                    // is expressed through the exported accessor rather than a bare `as`.
                    const taNext = nextOf(tb)!;
                    const tret = isLazyArray(fparam);
                    for (; argi < fargs.length; argi++) {
                        const arg = fargs[argi];
                        assert(arg !== null);

                        let m: MATCH;
                        /* If lazy array of delegates,
                         * convert arg(s) to delegate(s)
                         */
                        if (tret !== null) {
                            if (taNext.equals(arg!.type)) {
                                m = MATCH.exact;
                            } else {
                                m = implicitConvTo(arg!, tret);
                                if (m === MATCH.nomatch) {
                                    if (toBasetype(tret).ty === TY.Tvoid)
                                        m = MATCH.convert;
                                }
                            }
                        } else {
                            // D `uint wm = 0;` handed to `deduceType(…, &wm, …)` -> one-slot box.
                            const wm: Ref<number> = { value: 0 };
                            m = deduceType(arg!, paramscope, taNext, td.parameters!, dedtypes, wm,
                                inferStart);
                            inoutMatch |= wm.value;
                        }
                        if (m === MATCH.nomatch)
                            return nomatch();
                        if (m < match)
                            match = m;
                    }
                    break Lmatch; // goto Lmatch (dmd/templatesem.d:4982)
                }
                case TY.Tclass:
                case TY.Tident:
                    break Lmatch; // goto Lmatch (dmd/templatesem.d:4986)

                default:
                    return nomatch();
            }
            assertUnreachable(); // dmd/templatesem.d:4991 `assert(0);`
        }
        // printf(". argi = %d, nfargs = %d, nfargs2 = %d, argsConsumed = %d\n", …);
        if (argsConsumed !== nfargs2 && fparameters.varargs === VarArg.none)
            return nomatch();
    }

    // Lmatch:
    // D `foreach (ref dedtype; *dedtypes)` WRITES the slot -> indexed write (03 §4 / 05 §7).
    for (let di = 0; di < dedtypes.length; di++) {
        let at = isType(dedtypes.opIndex(di));
        if (at !== null) {
            if (at.ty === TY.Tnone) {
                // 02 §11.5c #3 tag-proved RTTI downcast — see the twin site above.
                const xt = at as unknown as TypeDeduced;
                at = xt.tded; // 'unbox'
            }
            dedtypes.opIndexAssign(merge2(at), di);
        }
    }
    for (let i = ntargs; i < dedargs.length; i++) {
        const tparam = td.parameters!.opIndex(i)!;
        //printf("tparam[%d] = %s\n", i, tparam.ident.toChars());

        /* For T:T*, the dedargs is the T*, dedtypes is the T
         * But for function templates, we really need them to match
         */
        const oarg = dedargs.opIndex(i);
        let oded = dedtypes.opIndex(i);
        //printf("1dedargs[%d] = %p, dedtypes[%d] = %p\n", i, oarg, i, oded);
        if (oarg !== null)
            continue;

        if (oded !== null) {
            if (tparam.specialization() !== null || tparam.isTemplateTypeParameter() === null) {
                /* The specialization can work as long as afterwards
                 * the oded == oarg
                 */
                dedargs.opIndexAssign(oded, i);
                const m2 = matchArgFromTiargs(tparam, instLoc, paramscope, dedargs, i,
                    td.parameters!, dedtypes, null);
                //printf("m2 = %d\n", m2);
                if (m2 === MATCH.nomatch)
                    return nomatch();
                if (m2 < matchTiargs)
                    matchTiargs = m2; // pick worst match
                if (!rootObjectsEqual(dedtypes.opIndex(i)!, oded))
                    error(td.loc, ds("%s `%s` specialization not allowed for deduced parameter `%s`"),
                        td.kind(), td.toPrettyChars(), tparam.ident!.toChars());
            } else {
                // Discussion: https://issues.dlang.org/show_bug.cgi?id=16484
                if (MATCH.convert < matchTiargs)
                    matchTiargs = MATCH.convert;
            }
        } else {
            oded = defaultArg(tparam, instLoc, paramscope);
            if (oded === null) {
                // if tuple parameter and
                // tuple parameter was not in function parameter list and
                // we're one or more arguments short (i.e. no tuple argument)
                if (tparam === tp && fptupindex === IDX_NOTFOUND
                    && ntargs <= dedargs.length - 1) {
                    // make tuple argument an empty tuple
                    oded = new Tuple();
                } else
                    return nomatch();
            }
            if (isError(oded))
                return matcherror();
            ntargs++;

            /* At the template parameter T, the picked default template argument
             * X!int should be matched to T in order to deduce dependent
             * template parameter A.
             *  auto foo(T : X!A = X!int, A...)() { ... }
             *  foo();  // T <-- X!int, A <-- (int)
             */
            if (tparam.specialization() !== null) {
                dedargs.opIndexAssign(oded, i);
                const m2 = matchArgFromTiargs(tparam, instLoc, paramscope, dedargs, i,
                    td.parameters!, dedtypes, null);
                //printf("m2 = %d\n", m2);
                if (m2 === MATCH.nomatch)
                    return nomatch();
                if (m2 < matchTiargs)
                    matchTiargs = m2; // pick worst match
                if (!rootObjectsEqual(dedtypes.opIndex(i)!, oded))
                    error(td.loc, ds("%s `%s` specialization not allowed for deduced parameter `%s`"),
                        td.kind(), td.toPrettyChars(), tparam.ident!.toChars());
            }
        }
        oded = declareParameterWithValue(td, paramscope, tparam, oded);
        dedargs.opIndexAssign(oded, i);
    }

    /* https://issues.dlang.org/show_bug.cgi?id=7469
     * As same as the code for 7469 in findBestMatch,
     * expand a Tuple in dedargs to normalize template arguments.
     */
    {
        // 06 §2.6 — `if (auto d = dedargs.length)` on a size_t -> hoist + `!== 0` (06 §2.5).
        const d = dedargs.length;
        if (d !== 0) {
            const va = isTuple(dedargs.opIndex(d - 1));
            if (va !== null) {
                dedargs.setDim(d - 1);
                dedargs.insert(d - 1, va.objects);
            }
        }
    }
    ti.tiargs = dedargs; // update to the normalized template arguments.

    // Partially instantiate function for constraint and fd.leastAsSpecialized()
    {
        assert(paramscope.scopesym !== null);
        // D reassigns `sc2` through push/pop -> a widened local cursor (02 §10.1).
        let sc2: Scope | null = td._scope;
        sc2 = sc2!.push(paramscope.scopesym!);
        sc2 = sc2.push(ti);
        sc2.parent = ti;
        sc2.tinst = ti;
        sc2.minst = sc.minst;
        sc2.stc = (sc2.stc | (fdCur.storage_class & STC.deprecated_)) as STC;

        const fdNew = doHeaderInstantiation(td, ti, sc2, fdCur, tthis, argumentList.copy());
        // The `ref FuncDeclaration fd` rebind — write BOTH the caller's box and the local mirror.
        fd.value = fdNew;
        sc2 = sc2.pop();
        sc2 = sc2!.pop();

        if (fdNew === null)
            return nomatch();
        fdCur = fdNew;
    }

    if (td.constraint !== null) {
        if (!evaluateConstraint(td, ti, sc, paramscope, dedargs, fdCur))
            return nomatch();
    }

    paramscope.pop();
    //printf("\tmatch %d\n", match);
    return new MATCHpair(matchTiargs, match);
}

/*************************************************
 * Limited function template instantiation for using fd.leastAsSpecialized()
 *
 * dmd/templatesem.d:5153. `fd` is a plain by-value parameter that D REASSIGNS (`fd = new
 * CtorDeclaration(…)`), so the port keeps it a `let` parameter. `inferenceArguments` is stored
 * into `tf.inferenceArguments`, a value-struct FIELD -> `.copy()` (03 §1 #5).
 *
 * resolved: `version (none)` at D:5156 -> OFF, dropped.
 */
function doHeaderInstantiation(td: TemplateDeclaration, ti: TemplateInstance, sc2: Scope,
    fd: FuncDeclaration, tthis: Type | null, inferenceArguments: ArgumentList): FuncDeclaration | null {
    assert(fd !== null);

    // function body and contracts are not need
    if (fd.isCtorDeclaration() !== null)
        fd = new CtorDeclaration(fd.loc, fd.endloc, fd.storage_class, fd.type!.syntaxCopy());
    else
        fd = new FuncDeclaration(fd.loc, fd.endloc, fd.ident, fd.storage_class, fd.type!.syntaxCopy());
    fd.parent = ti;

    assert(fd.type!.ty === TY.Tfunction);
    // D reassigns `tf` (`tf = tf.addSTC(…).isTypeFunction()`), so it is a `let`.
    let tf = fd.type!.isTypeFunction()!;
    tf.inferenceArguments = inferenceArguments.copy();

    if (tthis !== null) {
        // Match 'tthis' to any TemplateThisParameter's
        let hasttp = false;
        for (const tp of td.parameters!) {
            const ttp = tp!.isTemplateThisParameter();
            if (ttp !== null)
                hasttp = true;
        }
        if (hasttp) {
            tf = addSTC(tf, ModToStc(tthis.mod)).isTypeFunction()!;
            assert(tf.deco === null);
        }
    }

    // D reassigns `scx` (`scx = scx.pop()`) -> widened local cursor (02 §10.1).
    let scx: Scope | null = sc2.push();

    // Shouldn't run semantic on default arguments and return type.
    // D `foreach (ref params; *tf.parameterList.parameters)` mutates the ELEMENT's field, not the
    // slot -> iterate in place (03 §4).
    for (const params of tf.parameterList.parameters!)
        params!.defaultArg = null;
    tf.incomplete = true;

    if (fd.isCtorDeclaration() !== null) {
        // For constructors, emitting return type is necessary for
        // isReturnIsolated() in functionResolve.
        tf.isCtor = true;

        const parent = td.toParentDecl();
        let tret: Type | null;
        const ad = parent!.isAggregateDeclaration();
        if (ad === null || parent!.isUnionDeclaration() !== null) {
            tret = Type.tvoid;
        } else {
            tret = ad.handleType();
            assert(tret !== null);
            tret = addStorageClass(tret!, (fd.storage_class | scx!.stc) as STC);
            tret = addMod(tret, tf.mod);
        }
        tf.next = tret;
        if (ad !== null && ad.isStructDeclaration() !== null)
            tf.isRef = true; // D `tf.isRef = 1;` — a BitFields boolean slot
        //printf("tf = %s\n", tf.toChars());
    } else
        tf.next = null;
    fd.type = tf;
    fd.type = addSTC(fd.type, scx!.stc);
    fd.type = typeSemantic(fd.type, fd.loc, scx);
    scx = scx!.pop();

    if (fd.type.ty !== TY.Tfunction)
        return null;

    fd.originalType = fd.type; // for mangling
    //printf("\t[%s] fd.type = %s, mod = %x, ", loc.toChars(), fd.type.toChars(), fd.type.mod);
    //printf("fd.needThis() = %d\n", fd.needThis());

    return fd;
}

/****************************************************
 * Declare parameters of template instance, initialize them with the
 * template instance arguments.
 *
 * dmd/templatesem.d:5242.
 */
export function declareParameters(ti: TemplateInstance, sc: Scope): void {
    const tempdecl = ti.tempdecl!.isTemplateDeclaration();
    assert(tempdecl !== null);

    //printf("TemplateInstance.declareParameters()\n");
    // D `foreach (i, o; ti.tdtypes)` — read-only walk; `o` is a class reference, no copy.
    for (let i = 0; i < ti.tdtypes.length; i++) { // initializer for tp
        const o = ti.tdtypes.opIndex(i);
        const tp = tempdecl!.parameters!.opIndex(i)!;
        //printf("\ttdtypes[%d] = %p\n", i, o);
        declareParameterWithValue(tempdecl!, sc, tp, o);
    }
}

/**************************************************
 * Declare template parameter tp with value o, and install it in the scope sc.
 *
 * dmd/templatesem.d:5258 — `private RootObject declareParameter(TemplateDeclaration td, Scope* sc,
 * TemplateParameter tp, RootObject o)`. RENAMED `declareParameterWithValue` per preamble §F.2 (the
 * verbatim name stays with the D:497 two-argument, `bool`-returning entry point in chunk 1).
 *
 * `o` is REASSIGNED and returned (`o = v._init.initializerToExpression()`), and callers pass a
 * possibly-null `tdtypes` slot -> `RootObject | null` in and out.
 *
 * D module-private.
 */
function declareParameterWithValue(td: TemplateDeclaration, sc: Scope, tp: TemplateParameter,
    o: RootObject | null): RootObject | null {
    //printf("TemplateDeclaration.declareParameter('%s', o = %p)\n", tp.ident.toChars(), o);
    let ta = isType(o);
    const ea = isExpression(o);
    let sa = isDsymbol(o);
    const va = isTuple(o);

    let d: Declaration;
    let v: VarDeclaration | null = null;

    if (ea !== null) {
        // 06 §2.6 chained declaration-in-condition -> nested hoists (short-circuit preserved).
        if (ea.op === EXP.type)
            ta = ea.type;
        else {
            const se = ea.isScopeExp();
            if (se !== null)
                sa = se.sds;
            else {
                const te = ea.isThisExp();
                if (te !== null)
                    sa = te.var_; // ported field: D `var` -> `var_` (01 §2.3)
                else {
                    const seSuper = ea.isSuperExp();
                    if (seSuper !== null)
                        sa = seSuper.var_; // ported field: D `var` -> `var_` (01 §2.3)
                    else {
                        const fe = ea.isFuncExp();
                        if (fe !== null) {
                            if (fe.td !== null)
                                sa = fe.td;
                            else
                                sa = fe.fd;
                        }
                    }
                }
            }
        }
    }

    if (ta !== null) {
        //printf("type %s\n", ta.toChars());
        const ad = AliasDeclaration.fromType(Loc.initial, tp.ident!, ta);
        ad.storage_class = (ad.storage_class | STC.templateparameter) as STC;
        d = ad;
    } else if (sa !== null) {
        //printf("Alias %s %s;\n", sa.ident.toChars(), tp.ident.toChars());
        const ad = AliasDeclaration.fromDsymbol(Loc.initial, tp.ident!, sa);
        ad.storage_class = (ad.storage_class | STC.templateparameter) as STC;
        d = ad;
    } else if (ea !== null) {
        // tdtypes.data[i] always matches ea here
        const _init: Initializer = new ExpInitializer(td.loc, ea);
        const tvp = tp.isTemplateValueParameter();
        const t = tvp !== null ? tvp.valType : null;
        v = new VarDeclaration(td.loc, t, tp.ident!, _init);
        v.storage_class = (STC.manifest | STC.templateparameter) as STC;
        d = v;
    } else if (va !== null) {
        //printf("\ttuple\n");
        d = new TupleDeclaration(td.loc, tp.ident!, va.objects);
    } else {
        return assertUnreachable(); // dmd/templatesem.d:5319 `assert(0);`
    }
    d.storage_class = (d.storage_class | STC.templateparameter) as STC;

    if (ta !== null) {
        let t: Type = ta;
        // consistent with Type.checkDeprecated()
        while (t.ty !== TY.Tenum) {
            const tn = nextOf(t);
            if (tn === null)
                break;
            // D `t = (cast(TypeNext)t).next;` — for a `TypeNext`, `nextOf()` IS that `.next` field
            // (typesem.d:604), and the only non-`TypeNext` type with a non-null `nextOf()` is
            // `TypeEnum`, which the loop condition already excluded.
            t = tn;
        }
        const s = toDsymbol(t, sc);
        if (s !== null) {
            if (s.isDeprecated())
                d.storage_class = (d.storage_class | STC.deprecated_) as STC;
        }
    } else if (sa !== null) {
        if (sa.isDeprecated())
            d.storage_class = (d.storage_class | STC.deprecated_) as STC;
    }

    if (insert(sc, d) === null)
        error(td.loc, ds("%s `%s` declaration `%s` is already defined"),
            td.kind(), td.toPrettyChars(), tp.ident!.toChars());
    dsymbolSemantic(d, sc);
    /* So the caller's o gets updated with the result of semantic() being run on o
     */
    if (v !== null)
        o = initializerToExpression(v._init!);
    return o;
}

/**********************************
 * Run semantic on the elements of `ti.tiargs`.
 * Input:
 *      ti = template instance whose `tiargs` should have semantic done
 *      sc = scope
 * Returns:
 *      false if one or more arguments have errors.
 * Note:
 *      This function is reentrant against error occurrence. If returns false,
 *      all elements of tiargs won't be modified.
 */
export function semanticTiargs(ti: TemplateInstance, sc: Scope): boolean {
    //printf("+TemplateInstance.semanticTiargs() %s\n", toChars());
    if (ti.semantictiargsdone)
        return true;
    if (TemplateInstance_semanticTiargs(ti.loc, sc, ti.tiargs, 0)) {
        // cache the result iff semantic analysis succeeded entirely
        ti.semantictiargsdone = true; // D `= 1` on a `bool` bit-field (dtemplate.d)
        return true;
    }
    return false;
}

/**********************************
 * Run semantic of tiargs as arguments of template.
 * Input:
 *      loc
 *      sc
 *      tiargs  array of template arguments
 *      flags   1: replace const variables with their initializers
 *              2: don't devolve Parameter to Type
 *      atd     tuple being optimized. If found, it's not expanded here
 *              but in AliasAssign semantic.
 * Returns:
 *      false if one or more arguments have errors.
 *
 * GOTO LATTICE (06 §4) — dmd/templatesem.d:5434 `Ltype:`, :5463 `Lexpr:`, :5589 `Ldsym:`, reached by
 * NINE `goto`s (:5425, :5427, :5491, :5534, :5539, :5565, :5570, :5576, :5583; the tenth at :5558 is
 * commented out upstream). Every one of the three label blocks ENDS the loop iteration on every path
 * (`continue`, or fall-through to the loop bottom), and the jumps form a DAG —
 * type-arm -> {Lexpr, Ldsym}, Lexpr -> {Ltype, Ldsym} — so each label is a BAIL TAIL: a zero-parameter
 * arrow declared inside the loop body (capturing that iteration's `ta`/`ea`/`sa`/`j`, never taking them
 * as positional parameters) whose RETURN means "this iteration is over".
 */
export function TemplateInstance_semanticTiargs(loc: Loc, sc: Scope, tiargs: Objects | null,
    flags: number, atd: TupleDeclaration | null = null): boolean {
    // Run semantic on each argument, place results in tiargs[]
    //printf("+TemplateInstance.semanticTiargs()\n");
    if (tiargs === null)
        return true;
    let err = false;

    // The arguments are not treated as part of a default argument,
    // because they are evaluated at compile time.
    const inCondition = sc.condition;
    sc = sc.push(); // D reassigns the `Scope*` parameter; the TS parameter binding is mutable and is
                    // what the three label closures below capture, so the `startCTFE`/`endCTFE`
                    // swaps inside `Lexpr` are visible here exactly as in D.
    sc.inDefaultArg = false;

    // https://issues.dlang.org/show_bug.cgi?id=24699
    sc.condition = inCondition;

    // D `for (size_t j = 0; …; j++)`. Hoisted out of the header so the `j--` performed INSIDE the
    // label closures is unambiguously the loop's own counter.
    let j = 0;
    for (; j < tiargs.length; j++) {
        const o = tiargs.opIndex(j);
        let ta = isType(o);
        let ea = isExpression(o);
        let sa = isDsymbol(o);

        //printf("1: (*tiargs)[%d] = %p, s=%p, v=%p, ea=%p, ta=%p\n", j, o, isDsymbol(o), isTuple(o), ea, ta);

        // Ldsym: — dmd/templatesem.d:5589. BAIL tail; captures `sa` and `j`.
        const Ldsym = (): void => {
            //printf("dsym %s %s\n", sa.kind(), sa.toChars());
            if (sa!.errors) {
                err = true;
                return; // D `continue`
            }

            const d = toAlias(sa!).isTupleDeclaration();
            if (d !== null) {
                if (d === atd) {
                    tiargs.opIndexAssign(d, j);
                    return; // D `continue`
                }
                // Expand tuple. `d.objects` is D's `Objects*` — nullable — and the D-spelled
                // `insert(index, Array!T*)` overload is exactly the one that no-ops on null
                // (root/array.ts:203, D array.d:236 `if (a)`), so it is kept verbatim here.
                tiargs.remove(j);
                tiargs.insert(j, d.objects);
                j--;
                return; // D `continue`
            }
            const fa = sa!.isFuncAliasDeclaration();
            if (fa !== null) {
                const f = fa.toAliasFunc();
                if (!fa.hasOverloads && isUnique(f)) {
                    // Strip FuncAlias only when the aliased function
                    // does not have any overloads.
                    sa = f;
                }
            }
            tiargs.opIndexAssign(sa, j);

            const td = sa!.isTemplateDeclaration();
            if (td !== null && td.semanticRun === PASS.initial && td.literal) {
                dsymbolSemantic(td, sc);
            }
            const fd = sa!.isFuncDeclaration();
            if (fd !== null)
                functionSemantic(fd);
        };

        // Ltype: — dmd/templatesem.d:5432. BAIL tail; captures `ta` and `j`.
        const Ltype = (): void => {
            // Every route into Ltype leaves `ta` non-null: the type arm re-seeds it with
            // `Type.terror` at dmd:5431, and dmd:5533 sets it from `ea.type` under `op == EXP.type`.
            const taNN: Type = ta!;
            const tt = taNN.isTypeTuple();
            if (tt !== null) {
                // Expand tuple
                const dim = tt.arguments!.length;
                tiargs.remove(j);
                if (dim !== 0) {
                    tiargs.reserve(dim);
                    for (const [i, arg] of tt.arguments!.opSlice().entries()) {
                        // D `tiargs.insert(index, RootObject)`. The NAMED single-element form is used
                        // because the element type is nullable and the D-spelled `insert` overload set
                        // (root/array.ts:189-196) also accepts `Array<T> | null`, which a `null` slot
                        // would silently route to the no-op array form.
                        if ((flags & 2) !== 0 && (arg!.storageClass & STC.parameter) !== 0n)
                            tiargs.insertOne(j + i, arg);
                        else
                            tiargs.insertOne(j + i, arg!.type);
                    }
                }
                j--;
                return; // D `continue`
            }
            if (taNN.ty === TY.Terror) {
                err = true;
                return; // D `continue`
            }
            tiargs.opIndexAssign(merge2(taNN), j);
        };

        // Lexpr: — dmd/templatesem.d:5463. BAIL tail; captures `ea`/`ta`/`sa`/`j` and tail-calls
        // Ltype (dmd:5534) / Ldsym (dmd:5491, :5539, :5565, :5570, :5576, :5583).
        const Lexpr = (): void => {
            //printf("+[%d] ea = %s %s\n", j, EXPtoString(ea.op).ptr, ea.toChars());
            if ((flags & 1) !== 0) { // only used by __traits
                ea = expressionSemantic(ea!, sc);

                // must not interpret the args, excepting template parameters
                const ve = ea.isVarExp();
                if (ve === null || (ve.var_!.storage_class & STC.templateparameter) !== 0n) {
                    ea = optimize(ea, WANTvalue);
                }
            } else {
                sc = sc.startCTFE();
                ea = expressionSemantic(ea!, sc);
                // D `sc = sc.endCTFE();` — `endCTFE()` forwards to `pop()`, typed `Scope | null`;
                // D dereferences the result unconditionally right after, so `!` marks that same
                // fault point (02 §10.1).
                sc = sc.endCTFE()!;

                const varExp = ea.isVarExp();
                if (varExp !== null) {
                    /* If the parameter is a function that is not called
                     * explicitly, i.e. `foo!func` as opposed to `foo!func()`,
                     * then it is a dsymbol, not the return value of `func()`
                     */
                    const vd: Declaration = varExp.var_!;
                    const fd = vd.isFuncDeclaration();
                    if (fd !== null) {
                        sa = fd;
                        return Ldsym(); // goto Ldsym (dmd/templatesem.d:5491)
                    }
                    /* Otherwise skip substituting a const var with
                     * its initializer. The problem is the initializer won't
                     * match with an 'alias' parameter. Instead, do the
                     * const substitution in TemplateValueParameter.matchArg().
                     */
                } else if (definitelyValueParameter(ea)) {
                    if (checkValue(ea)) // check void expression
                        ea = ErrorExp.get();
                    const olderrs = global.errors;
                    ea = ctfeInterpret(ea);
                    if (global.errors !== olderrs)
                        ea = ErrorExp.get();
                }
            }
            //printf("-[%d] ea = %s %s\n", j, EXPtoString(ea.op).ptr, ea.toChars());
            const te = ea!.isTupleExp();
            if (te !== null) {
                // Expand tuple
                const dim = te.exps!.length;
                tiargs.remove(j);
                if (dim !== 0) {
                    tiargs.reserve(dim);
                    for (const [i, exp] of te.exps!.opSlice().entries())
                        tiargs.insertOne(j + i, exp); // named form — see the note in Ltype
                }
                j--;
                return; // D `continue`
            }
            if (ea!.op === EXP.error) {
                err = true;
                return; // D `continue`
            }
            tiargs.opIndexAssign(ea, j);

            if (ea!.op === EXP.type) {
                ta = ea!.type;
                return Ltype(); // goto Ltype (dmd/templatesem.d:5534)
            }
            if (ea!.op === EXP.scope_) {
                sa = ea!.isScopeExp()!.sds;
                return Ldsym(); // goto Ldsym (dmd/templatesem.d:5539)
            }
            const fe = ea!.isFuncExp();
            if (fe !== null) {
                /* A function literal, that is passed to template and
                 * already semanticed as function pointer, never requires
                 * outer frame. So convert it to global function is valid.
                 */
                if (fe.fd!.tok === TOK.reserved && fe.type!.ty === TY.Tpointer) {
                    // change to non-nested
                    fe.fd!.tok = TOK.function_;
                    fe.fd!.vthis = null;
                } else if (fe.td !== null) {
                    /* If template argument is a template lambda,
                     * get template declaration itself. */
                    //sa = fe.td;
                    //goto Ldsym;
                }
            }
            if (ea!.op === EXP.dotVariable && (flags & 1) === 0) {
                // translate expression to dsymbol.
                sa = ea!.isDotVarExp()!.var_;
                return Ldsym(); // goto Ldsym (dmd/templatesem.d:5565)
            }
            const teTempl = ea!.isTemplateExp();
            if (teTempl !== null) {
                sa = teTempl.td;
                return Ldsym(); // goto Ldsym (dmd/templatesem.d:5570)
            }
            if (ea!.op === EXP.dotTemplateDeclaration && (flags & 1) === 0) {
                // translate expression to dsymbol.
                sa = ea!.isDotTemplateExp()!.td;
                return Ldsym(); // goto Ldsym (dmd/templatesem.d:5576)
            }
            const de = ea!.isDotExp();
            if (de !== null) {
                const se = de.e2!.isScopeExp();
                if (se !== null) {
                    sa = se.sds;
                    return Ldsym(); // goto Ldsym (dmd/templatesem.d:5583)
                }
            }
        };

        if (ta !== null) {
            //printf("type %s\n", ta.toChars());

            // It might really be an Expression or an Alias.
            // D `ta.resolve(loc, sc, ea, ta, sa, (flags & 1) != 0)` writes all THREE of `ea`/`ta`/`sa`
            // through `out` parameters (they are reset to null on entry, so nothing is pre-loaded).
            const peBox: Ref<Expression | null> = { value: null };
            const ptBox: Ref<Type | null> = { value: null };
            const psBox: Ref<Dsymbol | null> = { value: null };
            resolve(ta, loc, sc, peBox, ptBox, psBox, (flags & 1) !== 0);
            ea = peBox.value;
            ta = ptBox.value;
            sa = psBox.value;

            if (ea !== null) {
                Lexpr(); // goto Lexpr (dmd/templatesem.d:5425)
                continue;
            }
            if (sa !== null) {
                Ldsym(); // goto Ldsym (dmd/templatesem.d:5427)
                continue;
            }
            if (ta === null) {
                assert(global.errors !== 0);
                ta = Type.terror;
            }

            Ltype(); // fall-through INTO `Ltype:` (dmd/templatesem.d:5434)
            continue;
        } else if (ea !== null) {
            Lexpr(); // fall-through INTO `Lexpr:` (dmd/templatesem.d:5463)
            continue;
        } else if (sa !== null) {
            Ldsym(); // fall-through INTO `Ldsym:` (dmd/templatesem.d:5589)
            continue;
        } else if (isParameter(o) !== null) {
        } else {
            assertUnreachable();
        }
        //printf("1: (*tiargs)[%d] = %p\n", j, (*tiargs)[j]);
    }
    sc.pop();
    // resolved: version (none) -> OFF; the trailing tiargs dump (dmd/templatesem.d:5642-5654) is
    // dropped (07 §1).
    return !err;
}

/*************************************************
 * Given function arguments, figure out which template function
 * to expand, and return matching result.
 * Params:
 *      m           = matching result
 *      dstart      = the root of overloaded function templates
 *      loc         = instantiation location
 *      sc          = instantiation scope
 *      tiargs      = initial list of template arguments
 *      tthis       = if !NULL, the 'this' pointer argument
 *      argumentList= arguments to function
 *      errorHelper = delegate to send error message to if not null
 *
 * `ref MatchAccumulator m` is a struct ALIAS (03 §3.2) — the object is passed through, never copied.
 * `sc` is genuinely nullable here (dmd:5887 `if (!sc) sc = td._scope;`) and is REASSIGNED from inside
 * the `applyTemplate` closure, so the parameter binding itself is the shared cursor (02 §10.1).
 * `errorHelper`'s 1.43 signature gained the trailing `Loc argloc = Loc.initial` (see the wave's
 * rename-sweep note R5); `typesem.callMatch` already takes exactly this shape.
 */
export function functionResolve(m: MatchAccumulator, dstart: Dsymbol, loc: Loc, sc: Scope | null,
    tiargs: Objects | null, tthis: Type | null, argumentList: ArgumentList,
    errorHelper: ((msg: DString, argloc?: Loc) => void) | null = null): void {
    // resolved: version (none) -> OFF; the dstart/tiargs/arguments dump (dmd/templatesem.d:5675-5695)
    // is dropped (07 §1).

    // results
    let property = 0;   // 0: uninitialized
                        // 1: seen @property
                        // 2: not @property
    let ov_index = 0;
    let td_best: TemplateDeclaration | null = null;
    let ti_best: TemplateInstance | null = null;
    let ta_last: MATCH = m.last !== MATCH.nomatch ? MATCH.exact : MATCH.nomatch;
    let tthis_best: Type | null = null;

    // Lerror: — dmd/templatesem.d:6170. BAIL tail of the OUTER body (targets at :6189 and the
    // fall-through from `if (ti.errors)`).
    const Lerror = (): void => {
        m.count = 1;
        assert(m.lastf !== null);
        m.last = MATCH.nomatch;
    };

    // Lnomatch: — dmd/templatesem.d:6215. BAIL tail of the OUTER body (targets at :6167, :6192 and
    // the fall-through of the final `else`).
    const Lnomatch = (): void => {
        m.count = 0;
        m.lastf = null;
        m.last = MATCH.nomatch;
    };

    const applyFunction = (fd: FuncDeclaration): number => {
        // skip duplicates
        if (fd === m.lastf)
            return 0;
        // explicitly specified tiargs never match to non template function
        if (tiargs !== null && tiargs.length > 0)
            return 0;

        // constructors need a valid scope in order to detect semantic errors
        if (fd.isCtorDeclaration() === null &&
            fd.semanticRun < PASS.semanticdone) {
            // D: `fd.ungagSpeculative();` (dmd/templatesem.d:5720) — a DISCARDED rvalue. The
            // `Ungag` temporary is destroyed at the end of THAT full expression, and
            // `~Ungag` (dmd/dsymbolsem.d:1974) restores `global.gag`, so the gag is already back
            // by the time `dsymbolSemantic` runs. `ungagSpeculative` SETS `global.gag = 0` as a
            // side effect, so the port must spell the immediate restore or gagging would be
            // switched off for the rest of the process. Nothing can throw between the two lines.
            const ungag = ungagSpeculative(fd);
            global.gag = ungag.oldgag;   // D's ~Ungag() at the end of the full expression
            dsymbolSemantic(fd, null);
        }
        if (fd.semanticRun < PASS.semanticdone) {
            error(loc, ds("forward reference to template `%s`"), fd.toChars());
            return 1;
        }
        //printf("fd = %s %s, fargs = %s\n", fd.toChars(), fd.type.toChars(), fargs.toChars());
        const tf = fd.type!.isTypeFunction()!;

        const prop = tf.isProperty ? 1 : 2;
        if (property === 0)
            property = prop;
        else if (property !== prop)
            error(fd.loc, ds("cannot overload both property and non-property functions"));

        /* For constructors, qualifier check will be opposite direction.
         * Qualified constructor always makes qualified object, then will be checked
         * that it is implicitly convertible to tthis.
         */
        let tthis_fd: Type | null = fd.needThis() ? tthis : null;
        const isCtorCall = tthis_fd !== null && fd.isCtorDeclaration() !== null;
        if (isCtorCall) {
            //printf("%s tf.mod = x%x tthis_fd.mod = x%x %d\n", tf.toChars(),
            //        tf.mod, tthis_fd.mod, fd.isReturnIsolated());
            if (MODimplicitConv(tf.mod, tthis_fd!.mod) ||
                (tf.isWild() && tf.isShared() === tthis_fd!.isShared()) ||
                isReturnIsolated(fd)) {
                /* && tf.isShared() == tthis_fd.isShared()*/
                // Uniquely constructed object can ignore shared qualifier.
                // TODO: Is this appropriate?
                tthis_fd = null;
            } else
                return 0;   // MATCH.nomatch
        }
        /* Fix Issue 17970:
           If a struct is declared as shared the dtor is automatically
           considered to be shared, but when the struct is instantiated
           the instance is no longer considered to be shared when the
           function call matching is done. The fix makes it so that if a
           struct declaration is shared, when the destructor is called,
           the instantiated struct is also considered shared.
        */
        const dt = fd.isDtorDeclaration();
        if (dt !== null) {
            const dtmod = dt.type!.toTypeFunction();
            const shared_dtor = dtmod.mod & MODFlags.shared_;
            const shared_this = tthis_fd !== null ?
                tthis_fd.mod & MODFlags.shared_ : 0;
            if (shared_dtor !== 0 && shared_this === 0)
                tthis_fd = dtmod;
            else if (shared_this !== 0 && shared_dtor === 0 && tthis_fd !== null)
                tf.mod = tthis_fd.mod;
        }
        // dmd/templatesem.d:5778 — `const(char)* failMessage;` is declared and NEVER assigned
        // upstream, so the guard below is dead and `errorHelper` is never reached through it. Ported
        // verbatim (the `!` marks the null-delegate fault D would take if it ever became live).
        const failMessage: DString | null = null;
        const mfa = callMatch(fd, tf, tthis_fd, argumentList.copy(), 0, errorHelper, sc);
        //printf("test1: mfa = %d\n", mfa);
        if (failMessage !== null)
            errorHelper!(failMessage);
        if (mfa === MATCH.nomatch)
            return 0;

        const firstIsBetter = (): number => {
            td_best = null;
            ti_best = null;
            ta_last = MATCH.exact;
            m.last = mfa;
            m.lastf = fd;
            tthis_best = tthis_fd;
            ov_index = 0;
            m.count = 1;
            return 0;
        };

        if (mfa > m.last) return firstIsBetter();
        if (mfa < m.last) return 0;

        /* See if one of the matches overrides the other.
         */
        assert(m.lastf !== null);
        if (overrides(m.lastf, fd) !== 0) return 0;
        if (overrides(fd, m.lastf) !== 0) return firstIsBetter();

        /* Try to disambiguate using template-style partial ordering rules.
         * In essence, if f() and g() are ambiguous, if f() can call g(),
         * but g() cannot call f(), then pick f().
         * This is because f() is "more specialized."
         */
        {
            const c1 = funcLeastAsSpecialized(fd, m.lastf, argumentList.names);
            const c2 = funcLeastAsSpecialized(m.lastf, fd, argumentList.names);
            //printf("c1 = %d, c2 = %d\n", c1, c2);
            if (c1 > c2) return firstIsBetter();
            if (c1 < c2) return 0;
        }

        /* The 'overrides' check above does covariant checking only
         * for virtual member functions. It should do it for all functions,
         * but in order to not risk breaking code we put it after
         * the 'leastAsSpecialized' check.
         * In the future try moving it before.
         * I.e. a not-the-same-but-covariant match is preferred,
         * as it is more restrictive.
         */
        if (!m.lastf.type!.equals(fd.type)) {
            //printf("cov: %d %d\n", m.lastf.type.covariant(fd.type), fd.type.covariant(m.lastf.type));
            const lastCovariant = covariant(m.lastf.type!, fd.type!);
            const firstCovariant = covariant(fd.type!, m.lastf.type!);

            if (lastCovariant === Covariant.yes || lastCovariant === Covariant.no) {
                if (firstCovariant !== Covariant.yes && firstCovariant !== Covariant.no) {
                    return 0;
                }
            } else if (firstCovariant === Covariant.yes || firstCovariant === Covariant.no) {
                return firstIsBetter();
            }
        }

        /* If the two functions are the same function, like:
         *    int foo(int);
         *    int foo(int x) { ... }
         * then pick the one with the body.
         *
         * If none has a body then don't care because the same
         * real function would be linked to the decl (e.g from object file)
         */
        if (tf.equals(m.lastf.type) &&
            fd.storage_class === m.lastf.storage_class &&
            fd.parent === m.lastf.parent &&
            fd.visibility.opEquals(m.lastf.visibility) &&
            fd._linkage === m.lastf._linkage) {
            if (fd.fbody !== null && m.lastf.fbody === null)
                return firstIsBetter();
            if (fd.fbody === null)
                return 0;
        }

        // https://issues.dlang.org/show_bug.cgi?id=14450
        // Prefer exact qualified constructor for the creating object type
        if (isCtorCall && tf.mod !== m.lastf.type!.mod) {
            if (tthis!.mod === tf.mod) return firstIsBetter();
            if (tthis!.mod === m.lastf.type!.mod) return 0;
        }

        m.nextf = fd;
        m.count++;
        return 0;
    };

    const applyTemplate = (td: TemplateDeclaration): number => {
        //printf("applyTemplate(): td = %s\n", td.toChars());
        if (td === td_best)   // skip duplicates
            return 0;

        if (sc === null)
            sc = td._scope; // workaround for Type.aliasthisOf

        // Lerror: — dmd/templatesem.d:5899. BAIL tail of applyTemplate (targets at :5945, :5968,
        // :6023, plus the fall-through from the forward-reference `error()` below).
        const LerrorArm = (): number => {
            m.lastf = null;
            m.count = 0;
            m.last = MATCH.nomatch;
            return 1;
        };

        if (td.semanticRun === PASS.initial && td._scope !== null) {
            // Try to fix forward reference. Ungag errors while doing so.
            // D: `td.ungagSpeculative();` (dmd/templatesem.d:5893) — a DISCARDED rvalue; see the
            // note at the `applyFunction` site above. The `Ungag` temporary dies at the end of
            // that statement, so `global.gag` is restored before `dsymbolSemantic` runs.
            const ungag = ungagSpeculative(td);
            global.gag = ungag.oldgag;   // D's ~Ungag() at the end of the full expression
            dsymbolSemantic(td, td._scope);
        }
        // 02 §11.4: `dsymbolSemantic` above MUTATES `semanticRun`, so the discriminant is re-read
        // into a fresh const annotated at the field's declared type before the next test.
        const semanticRunAfterFix: PASS = td.semanticRun;
        if (semanticRunAfterFix === PASS.initial) {
            error(loc, ds("forward reference to template `%s`"), td.toChars());
            return LerrorArm(); // fall-through INTO `Lerror:` (dmd/templatesem.d:5899)
        }
        //printf("td = %s\n", td.toChars());
        computeOneMember(td);
        let f: FuncDeclaration | null = td.onemember !== null ? td.onemember.isFuncDeclaration() : null;
        if (f === null) {
            if (tiargs === null)
                tiargs = new DArray<RootObject | null>();
            const ti = TemplateInstance.fromTemplateDeclaration(loc, td, tiargs);
            const dedtypes: Objects = new DArray<RootObject | null>(td.parameters!.length);
            assert(td.semanticRun !== PASS.initial);
            // 02 §10.1: `functionResolve`'s `sc` is `Scope | null` (it is null-tested at
            // dmd/templatesem.d:5883 and reassigned from `td._scope`), while every callee below
            // dereferences its `Scope*` unconditionally. The `!` marks exactly the point D faults
            // on a null `sc` — it adds no check D does not have. Same for the four sites following.
            const mta = matchWithInstance(sc!, td, ti, dedtypes, argumentList.copy(), 0);
            //printf("matchWithInstance = %d\n", mta);
            if (mta === MATCH.nomatch || mta < ta_last)   // no match or less match
                return 0;

            templateInstanceSemantic(ti, sc!, argumentList.copy());
            if (ti.inst === null)               // if template failed to expand
                return 0;

            const s: Dsymbol = toAlias(ti.inst);
            let fd: FuncDeclaration | null;
            const tdx = s.isTemplateDeclaration();
            if (tdx !== null) {
                const dedtypesX: Objects = new DArray<RootObject | null>();      // empty tiargs

                // https://issues.dlang.org/show_bug.cgi?id=11553
                // Check for recursive instantiation of tdx.
                for (let p = tdx.previous; p !== null; p = p.prev) {
                    if (arrayObjectMatch(p.dedargs!, dedtypesX)) {
                        //printf("recursive, no match p.sc=%p %p %s\n", p.sc, this, this.toChars());
                        /* It must be a subscope of p.sc, other scope chains are not recursive
                         * instantiations.
                         */
                        for (let scx = sc; scx !== null; scx = scx.enclosing) {
                            if (scx === p.sc) {
                                error(loc, ds("recursive template expansion while looking for `%s.%s`"), ti.toChars(), tdx.toChars());
                                return LerrorArm(); // goto Lerror (dmd/templatesem.d:5945)
                            }
                        }
                    }
                    /* BUG: should also check for ref param differences
                     */
                }

                const pr = new TemplatePrevious();
                pr.prev = tdx.previous;
                pr.sc = sc;
                pr.dedargs = dedtypesX;         // D `&dedtypesX` — the container reference (03 §7.2)
                tdx.previous = pr;              // add this to threaded list

                fd = resolveFuncCall(loc, sc!, s, null, tthis, argumentList.copy(), FuncResolveFlag.quiet);

                tdx.previous = pr.prev;         // unlink from threaded list
            } else if (s.isFuncDeclaration() !== null) {
                fd = resolveFuncCall(loc, sc!, s, null, tthis, argumentList.copy(), FuncResolveFlag.quiet);
            } else
                return LerrorArm(); // goto Lerror (dmd/templatesem.d:5968)

            if (fd === null)
                return 0;

            if (fd.type!.ty !== TY.Tfunction) {
                m.lastf = fd;   // to propagate "error match"
                m.count = 1;
                m.last = MATCH.nomatch;
                return 1;
            }

            const tthis_fd: Type | null = fd.needThis() && fd.isCtorDeclaration() === null ? tthis : null;

            const tf = fd.type!.isTypeFunction()!;
            const mfa = callMatch(fd, tf, tthis_fd, argumentList.copy(), 0, null, sc);
            if (mfa < m.last)
                return 0;

            // Ltd_best2: — dmd/templatesem.d:6000. BAIL tail; its whole body is `return 0`.
            const Ltd_best2 = (): number => {
                return 0;
            };

            // Ltd2: — dmd/templatesem.d:6003. BAIL tail; td is the new best match.
            const Ltd2 = (): number => {
                assert(td._scope !== null);
                td_best = td;
                ti_best = null;
                property = 0;   // (backward compatibility)
                ta_last = mta;
                m.last = mfa;
                m.lastf = fd;
                tthis_best = tthis_fd;
                ov_index = 0;
                m.nextf = null;
                m.count = 1;
                return 0;
            };

            if (mta < ta_last) return Ltd_best2(); // goto Ltd_best2 (dmd/templatesem.d:5988)
            if (mta > ta_last) return Ltd2();      // goto Ltd2      (dmd/templatesem.d:5989)

            if (mfa < m.last) return Ltd_best2();  // goto Ltd_best2 (dmd/templatesem.d:5991)
            if (mfa > m.last) return Ltd2();       // goto Ltd2      (dmd/templatesem.d:5992)

            // td_best and td are ambiguous
            //printf("Lambig2\n");
            m.nextf = fd;
            m.count++;
            return 0;
        }

        //printf("td = %s\n", td.toChars());
        for (let ovi = 0; f !== null; f = f.overnext0, ovi++) {
            if (f.type!.ty !== TY.Tfunction || f.errors)
                return LerrorArm(); // goto Lerror (dmd/templatesem.d:6023)

            /* This is a 'dummy' instance to evaluate constraint properly.
             */
            const ti = TemplateInstance.fromTemplateDeclaration(loc, td, tiargs);
            ti.parent = td.parent;  // Maybe calculating valid 'enclosing' is unnecessary.

            // D `ref FuncDeclaration fd` is WRITTEN by deduceFunctionTemplateMatch and read back at
            // dmd:6035, so the alias is a box (03 §3.3).
            const fdBox: Ref<FuncDeclaration | null> = { value: f };
            const x = deduceFunctionTemplateMatch(td, ti, sc!, fdBox, tthis, argumentList.copy());
            const fd = fdBox.value;
            const mta = x.mta;
            const mfa = x.mfa;
            //printf("match:t/f = %d/%d\n", mta, mfa);
            if (fd === null || mfa === MATCH.nomatch)
                continue;

            let tthis_fd: Type | null = fd.needThis() ? tthis : null;

            const isCtorCall = tthis_fd !== null && fd.isCtorDeclaration() !== null;
            if (isCtorCall) {
                // Constructor call requires additional check.
                const tf = fd.type!.isTypeFunction()!;
                assert(tf.next !== null);
                if (MODimplicitConv(tf.mod, tthis_fd!.mod) ||
                    (tf.isWild() && tf.isShared() === tthis_fd!.isShared()) ||
                    isReturnIsolated(fd)) {
                    tthis_fd = null;
                } else
                    continue;   // MATCH.nomatch

                // need to check here whether the constructor is the member of a struct
                // declaration that defines a copy constructor. This is already checked
                // in the semantic of CtorDeclaration, however, when matching functions,
                // the template instance is not expanded.
                // https://issues.dlang.org/show_bug.cgi?id=21613
                const ad = fd.isThis();
                const sd = ad!.isStructDeclaration();
                if (checkHasBothRvalueAndCpCtor(sd, fd.isCtorDeclaration()!, ti))
                    continue;
            }

            // Ltd: — dmd/templatesem.d:6117. SHARED ARM inside the overload loop; every jump site
            // runs it and then `continue`s (the label's own body ends in `continue`).
            const LtdArm = (): void => {
                //printf("Ltd\n");
                assert(td._scope !== null);
                td_best = td;
                ti_best = ti;
                property = 0;   // (backward compatibility)
                ta_last = mta;
                m.last = mfa;
                m.lastf = fd;
                tthis_best = tthis_fd;
                ov_index = ovi;
                m.nextf = null;
                m.count = 1;
            };
            // Ltd_best: — dmd/templatesem.d:6113. Its entire body is the dropped `//printf` plus
            // `continue`, so each jump site is a bare `continue` carrying the goto comment.

            if (mta < ta_last) continue;             // goto Ltd_best (dmd/templatesem.d:6066)
            if (mta > ta_last) { LtdArm(); continue; } // goto Ltd    (dmd/templatesem.d:6067)

            if (mfa < m.last) continue;              // goto Ltd_best (dmd/templatesem.d:6069)
            if (mfa > m.last) { LtdArm(); continue; }  // goto Ltd    (dmd/templatesem.d:6070)

            if (td_best !== null) {
                // Disambiguate by picking the most specialized TemplateDeclaration
                const c1 = leastAsSpecialized(sc!, td, td_best, argumentList.copy());
                const c2 = leastAsSpecialized(sc!, td_best, td, argumentList.copy());
                //printf("1: c1 = %d, c2 = %d\n", c1, c2);
                if (c1 > c2) { LtdArm(); continue; } // goto Ltd      (dmd/templatesem.d:6078)
                if (c1 < c2) continue;               // goto Ltd_best (dmd/templatesem.d:6079)
            }
            assert(fd !== null && m.lastf !== null);
            {
                // Disambiguate by tf.callMatch
                const tf1 = fd.type!.isTypeFunction()!;
                const tf2 = m.lastf.type!.isTypeFunction()!;
                const c1 = callMatch(fd,      tf1, tthis_fd,   argumentList.copy(), 0, null, sc);
                const c2 = callMatch(m.lastf, tf2, tthis_best, argumentList.copy(), 0, null, sc);
                //printf("2: c1 = %d, c2 = %d\n", c1, c2);
                if (c1 > c2) { LtdArm(); continue; } // goto Ltd      (dmd/templatesem.d:6089)
                if (c1 < c2) continue;               // goto Ltd_best (dmd/templatesem.d:6090)
            }
            {
                // Disambiguate by picking the most specialized FunctionDeclaration
                const c1 = funcLeastAsSpecialized(fd, m.lastf, argumentList.names);
                const c2 = funcLeastAsSpecialized(m.lastf, fd, argumentList.names);
                //printf("3: c1 = %d, c2 = %d\n", c1, c2);
                if (c1 > c2) { LtdArm(); continue; } // goto Ltd      (dmd/templatesem.d:6097)
                if (c1 < c2) continue;               // goto Ltd_best (dmd/templatesem.d:6098)
            }

            // https://issues.dlang.org/show_bug.cgi?id=14450
            // Prefer exact qualified constructor for the creating object type
            if (isCtorCall && fd.type!.mod !== m.lastf.type!.mod) {
                if (tthis!.mod === fd.type!.mod) { LtdArm(); continue; } // goto Ltd      (dmd:6105)
                if (tthis!.mod === m.lastf.type!.mod) continue;         // goto Ltd_best (dmd:6106)
            }

            m.nextf = fd;
            m.count++;
            continue;
        }
        return 0;
    };

    const td = dstart.isTemplateDeclaration();
    if (td !== null && td.funcroot !== null)
        dstart = td.funcroot;
    overloadApply(dstart, (s: Dsymbol): number => {
        if (s.errors)
            return 0;
        const fd = s.isFuncDeclaration();
        if (fd !== null)
            return applyFunction(fd);
        const td = s.isTemplateDeclaration();
        if (td !== null)
            return applyTemplate(td);
        return 0;
    }, sc);

    //printf("td_best = %p, m.lastf = %p\n", td_best, m.lastf);
    // 02 §11.4 (mutable state vs TS narrowing), local-variable variant: `td_best`/`ti_best` are
    // written ONLY from inside the applyFunction/applyTemplate closures, which TS's control-flow
    // analysis does not track — a direct read here (even into an explicitly-annotated const, the
    // doc's field-read remedy) still carries the initializer's `null` and collapses the branch to
    // `never`. Reading through a zero-parameter arrow yields the DECLARED type, which is the honest
    // one. Behaviour-neutral: each arrow is defined and called once, in place. (Filed as docFeedback:
    // 02 §11.4 covers field reads, not a local mutated only from a closure.)
    const readTdBest = (): TemplateDeclaration | null => td_best;
    const readTiBest = (): TemplateInstance | null => ti_best;
    const tdBest = readTdBest();
    const tiBest = readTiBest();
    if (tdBest !== null && tiBest !== null && m.count === 1) {
        // Matches to template function
        computeOneMember(tdBest);
        assert(tdBest.onemember !== null && tdBest.onemember.isFuncDeclaration() !== null);
        /* The best match is td_best with arguments tdargs.
         * Now instantiate the template.
         */
        assert(tdBest._scope !== null);
        if (sc === null)
            sc = tdBest._scope; // workaround for Type.aliasthisOf

        const ti = TemplateInstance.fromTemplateDeclaration(loc, tdBest, tiBest.tiargs);
        templateInstanceSemantic(ti, sc, argumentList.copy());

        m.lastf = toAlias(ti).isFuncDeclaration();
        if (m.lastf === null)
            return Lnomatch(); // goto Lnomatch (dmd/templatesem.d:6167)
        if (ti.errors) {
            return Lerror(); // fall-through INTO `Lerror:` (dmd/templatesem.d:6170)
        }

        // look forward instantiated overload function
        // Dsymbol.oneMembers is alredy called in TemplateInstance.semantic.
        // it has filled overnext0d
        // D `while (ov_index--)` tests the PRE-decrement value; the trailing wrap of the unsigned
        // counter past 0 is never read afterwards.
        while (ov_index-- !== 0) {
            m.lastf = m.lastf!.overnext0;
            assert(m.lastf !== null);
        }

        tthis_best = m.lastf!.needThis() && m.lastf!.isCtorDeclaration() === null ? tthis : null;

        if (m.lastf!.type!.ty === TY.Terror)
            return Lerror(); // goto Lerror (dmd/templatesem.d:6189)
        const tf = m.lastf!.type!.isTypeFunction()!;
        if (callMatch(m.lastf, tf, tthis_best, argumentList.copy(), 0, null, sc) === MATCH.nomatch)
            return Lnomatch(); // goto Lnomatch (dmd/templatesem.d:6192)

        /* As https://issues.dlang.org/show_bug.cgi?id=3682 shows,
         * a template instance can be matched while instantiating
         * that same template. Thus, the function type can be incomplete. Complete it.
         *
         * https://issues.dlang.org/show_bug.cgi?id=9208
         * For auto function, completion should be deferred to the end of
         * its semantic3. Should not complete it in here.
         */
        if (tf.next !== null && !m.lastf!.inferRetType) {
            m.lastf!.type = typeSemantic(tf, loc, sc);
        }
    } else if (m.lastf !== null) {
        // Matches to non template function,
        // or found matches were ambiguous.
        assert(m.count >= 1);
    } else {
        Lnomatch(); // fall-through INTO `Lnomatch:` (dmd/templatesem.d:6215)
    }
}

/* Create dummy argument based on parameter.
 */
// D module-private (01 §2 / cheatsheet): called from chunk 2 (`tp.dummyArg()`, dmd:4033).
export function dummyArg(tp: TemplateParameter): RootObject | null {
    const v = new DummyArgVisitor();
    tp.accept(v);
    return v.result;
}

// D module-private. The file's ONLY top-level `class … extends Visitor` (preamble §B cycle note:
// visitor/index.ts is a load-order root, so this edge is safe by construction).
class DummyArgVisitor extends Visitor {
    result: RootObject | null = null;

    // dropped: alias visit = typeof(super).visit — no overload hiding in TS (13 §1)

    override visitTemplateTypeParameter(ttp: TemplateTypeParameter): void {
        const t = ttp.specType;
        if (t !== null) {
            this.result = t;
            return;
        }
        // Use this for alias-parameter's too (?)
        // D `ttp.tdummy` names the `__gshared` member (dtemplate.d:498) through an instance —
        // in TS that is the STATIC slot.
        if (TemplateTypeParameter.tdummy === null)
            TemplateTypeParameter.tdummy = new TypeIdentifier(ttp.loc, ttp.ident!);
        this.result = TemplateTypeParameter.tdummy;
    }

    override visitTemplateValueParameter(tvp: TemplateValueParameter): void {
        let e = tvp.specValue;
        if (e !== null) {
            this.result = e;
            return;
        }

        // Create a dummy value.
        // D `cast(void*)tvp.valType in tvp.edummies` — the process-global AA keyed on the Type
        // POINTER; the port's Map is keyed on the object reference, the same identity
        // (dtemplate.ts:737). `in` yields a pointer-or-null, so `get` + `undefined` test.
        const pe = TemplateValueParameter.edummies.get(tvp.valType!);
        if (pe !== undefined) {
            this.result = pe;
            return;
        }

        e = defaultInit(tvp.valType!, Loc.initial);
        TemplateValueParameter.edummies.set(tvp.valType!, e!);
        this.result = e;
    }

    override visitTemplateAliasParameter(tap: TemplateAliasParameter): void {
        const s = tap.specAlias;
        if (s !== null) {
            this.result = s;
            return;
        }
        if (TemplateAliasParameter.sdummy === null)
            TemplateAliasParameter.sdummy = new Dsymbol(DSYM.dsymbol);
        this.result = TemplateAliasParameter.sdummy;
    }

    override visitTemplateTupleParameter(_tap: TemplateTupleParameter): void {
        this.result = null;
    }
}

/**
 * Returns the common type of the 2 types.
 */
// D module-private.
function rawTypeMerge(t1: Type, t2: Type): Type | null {
    if (t1.equals(t2))
        return t1;
    if (equivalent(t1, t2))
        return castMod(t1, MODmerge(t1.mod, t2.mod));

    const t1b = toBasetype(t1);
    const t2b = toBasetype(t2);
    if (t1b.equals(t2b))
        return t1b;
    if (equivalent(t1b, t2b))
        return castMod(t1b, MODmerge(t1b.mod, t2b.mod));

    const ty = implicitConvCommonTy(t1b.ty, t2b.ty);
    if (ty !== TY.Terror)
        return Type.basic[ty]!;

    return null;
}

// resolved (07 §9): `private auto X(T, U)(T m, U n) { return (m << 4) | n; }` (dmd/templatesem.d:6313)
// is a COMPILE-TIME helper — every use is a `case X(a, b):` label in the two switches below. Each
// label is folded to its integer literal here and `X` itself is NOT emitted. MODFlags values
// (astenums.ts:51): none=0, const_=1, shared_=2, immutable_=4, wild=8, wildconst=9.

// D module-private; called from chunk 2 (dmd:4494). `Type* at` -> the out box (03 §7.2).
export function deduceWildHelper(t: Type, at: Ref<Type | null>, tparam: Type): number {
    if ((tparam.mod & MODFlags.wild) === 0)
        return 0;

    at.value = null;

    switch ((tparam.mod << 4) | t.mod) {
    // resolved: X(wild,0)=128 X(wild,const_)=129 X(wild,shared_)=130 X(wild,shared_|const_)=131
    //           X(wild,immutable_)=132 X(wildconst,0)=144 X(wildconst,const_)=145
    //           X(wildconst,shared_)=146 X(wildconst,shared_|const_)=147 X(wildconst,immutable_)=148
    //           X(shared_|wild,shared_)=162 X(shared_|wild,shared_|const_)=163
    //           X(shared_|wild,immutable_)=164 X(shared_|wildconst,shared_)=178
    //           X(shared_|wildconst,shared_|const_)=179 X(shared_|wildconst,immutable_)=180
    //           (dmd/templatesem.d:6327-6342)
    case 128:
    case 129:
    case 130:
    case 131:
    case 132:
    case 144:
    case 145:
    case 146:
    case 147:
    case 148:
    case 162:
    case 163:
    case 164:
    case 178:
    case 179:
    case 180:
        {
            let wm = (t.mod & ~MODFlags.shared_);
            if (wm === 0)
                wm = MODFlags.mutable;
            const m = (t.mod & (MODFlags.const_ | MODFlags.immutable_)) | (tparam.mod & t.mod & MODFlags.shared_);
            at.value = unqualify(t, m);
            return wm;
        }
    // resolved: X(wild,wild)=136 X(wild,wildconst)=137 X(wild,shared_|wild)=138
    //           X(wild,shared_|wildconst)=139 X(wildconst,wild)=152 X(wildconst,wildconst)=153
    //           X(wildconst,shared_|wild)=154 X(wildconst,shared_|wildconst)=155
    //           X(shared_|wild,shared_|wild)=170 X(shared_|wild,shared_|wildconst)=171
    //           X(shared_|wildconst,shared_|wild)=186 X(shared_|wildconst,shared_|wildconst)=187
    //           (dmd/templatesem.d:6351-6362)
    case 136:
    case 137:
    case 138:
    case 139:
    case 152:
    case 153:
    case 154:
    case 155:
    case 170:
    case 171:
    case 186:
    case 187:
        {
            at.value = unqualify(t, tparam.mod & t.mod);
            return MODFlags.wild;
        }
    default:
        return 0;
    }
}

// D module-private; called from chunk 2 (dmd:4500). `out Type at` -> the out box, RESET on entry
// (03 §3.3): D default-initializes an `out` parameter before the callee's first statement, and the
// `default: assert(0)` arm is the only path that leaves it unwritten.
export function deduceTypeHelper(t: Type, at: Ref<Type | null>, tparam: Type): MATCH {
    at.value = null; // D `out` reset

    // 9*9 == 81 cases
    switch ((tparam.mod << 4) | t.mod) {
    // resolved: X(0,0)=0 X(0,const_)=1 X(0,wild)=8 X(0,wildconst)=9 X(0,shared_)=2
    //           X(0,shared_|const_)=3 X(0,shared_|wild)=10 X(0,shared_|wildconst)=11
    //           X(0,immutable_)=4 (dmd/templatesem.d:6377-6385)
    case 0:
    case 1:
    case 8:
    case 9:
    case 2:
    case 3:
    case 10:
    case 11:
    case 4:
        // foo(U)                       T                       => T
        // foo(U)                       const(T)                => const(T)
        // foo(U)                       inout(T)                => inout(T)
        // foo(U)                       inout(const(T))         => inout(const(T))
        // foo(U)                       shared(T)               => shared(T)
        // foo(U)                       shared(const(T))        => shared(const(T))
        // foo(U)                       shared(inout(T))        => shared(inout(T))
        // foo(U)                       shared(inout(const(T))) => shared(inout(const(T)))
        // foo(U)                       immutable(T)            => immutable(T)
        {
            at.value = t;
            return MATCH.exact;
        }
    // resolved: X(const_,const_)=17 X(wild,wild)=136 X(wildconst,wildconst)=153
    //           X(shared_,shared_)=34 X(shared_|const_,shared_|const_)=51
    //           X(shared_|wild,shared_|wild)=170 X(shared_|wildconst,shared_|wildconst)=187
    //           X(immutable_,immutable_)=68 (dmd/templatesem.d:6399-6406)
    case 17:
    case 136:
    case 153:
    case 34:
    case 51:
    case 170:
    case 187:
    case 68:
        // foo(const(U))                const(T)                => T
        // foo(inout(U))                inout(T)                => T
        // foo(inout(const(U)))         inout(const(T))         => T
        // foo(shared(U))               shared(T)               => T
        // foo(shared(const(U)))        shared(const(T))        => T
        // foo(shared(inout(U)))        shared(inout(T))        => T
        // foo(shared(inout(const(U)))) shared(inout(const(T))) => T
        // foo(immutable(U))            immutable(T)            => T
        {
            at.value = unSharedOf(mutableOf(t));
            return MATCH.exact;
        }
    // resolved: X(const_,shared_|const_)=19 X(wild,shared_|wild)=138
    //           X(wildconst,shared_|wildconst)=155 (dmd/templatesem.d:6419-6421)
    case 19:
    case 138:
    case 155:
        // foo(const(U))                shared(const(T))        => shared(T)
        // foo(inout(U))                shared(inout(T))        => shared(T)
        // foo(inout(const(U)))         shared(inout(const(T))) => shared(T)
        {
            at.value = mutableOf(t);
            return MATCH.exact;
        }
    // resolved: X(const_,0)=16 X(const_,wild)=24 X(const_,wildconst)=25 X(const_,shared_|wild)=26
    //           X(const_,shared_|wildconst)=27 X(const_,immutable_)=20
    //           X(shared_|const_,immutable_)=52 (dmd/templatesem.d:6429-6435)
    case 16:
    case 24:
    case 25:
    case 26:
    case 27:
    case 20:
    case 52:
        // foo(const(U))                T                       => T
        // foo(const(U))                inout(T)                => T
        // foo(const(U))                inout(const(T))         => T
        // foo(const(U))                shared(inout(T))        => shared(T)
        // foo(const(U))                shared(inout(const(T))) => shared(T)
        // foo(const(U))                immutable(T)            => T
        // foo(shared(const(U)))        immutable(T)            => T
        {
            at.value = mutableOf(t);
            return MATCH.constant;
        }
    // resolved: X(const_,shared_)=18 (dmd/templatesem.d:6447)
    case 18:
        // foo(const(U))                shared(T)               => shared(T)
        {
            at.value = t;
            return MATCH.constant;
        }
    // resolved: X(shared_,shared_|const_)=35 X(shared_,shared_|wild)=42
    //           X(shared_,shared_|wildconst)=43 (dmd/templatesem.d:6453-6455)
    case 35:
    case 42:
    case 43:
        // foo(shared(U))               shared(const(T))        => const(T)
        // foo(shared(U))               shared(inout(T))        => inout(T)
        // foo(shared(U))               shared(inout(const(T))) => inout(const(T))
        {
            at.value = unSharedOf(t);
            return MATCH.exact;
        }
    // resolved: X(shared_|const_,shared_)=50 (dmd/templatesem.d:6463)
    case 50:
        // foo(shared(const(U)))        shared(T)               => T
        {
            at.value = unSharedOf(t);
            return MATCH.constant;
        }
    // resolved: X(wildconst,immutable_)=148 X(shared_|const_,shared_|wildconst)=59
    //           X(shared_|wildconst,immutable_)=180 X(shared_|wildconst,shared_|wild)=186
    //           (dmd/templatesem.d:6469-6472)
    case 148:
    case 59:
    case 180:
    case 186:
        // foo(inout(const(U)))         immutable(T)            => T
        // foo(shared(const(U)))        shared(inout(const(T))) => T
        // foo(shared(inout(const(U)))) immutable(T)            => T
        // foo(shared(inout(const(U)))) shared(inout(T))        => T
        {
            at.value = mutableOf(unSharedOf(t));
            return MATCH.constant;
        }
    // resolved: X(shared_|const_,shared_|wild)=58 (dmd/templatesem.d:6481)
    case 58:
        // foo(shared(const(U)))        shared(inout(T))        => T
        {
            at.value = mutableOf(unSharedOf(t));
            return MATCH.constant;
        }
    // resolved (the 44 nomatch labels, dmd/templatesem.d:6487-6530):
    //   X(wild,·)            0=128 const_=129 wildconst=137 immutable_=132 shared_=130
    //                        shared_|const_=131 shared_|wildconst=139
    //   X(wildconst,·)       0=144 const_=145 wild=152 shared_=146 shared_|const_=147
    //                        shared_|wild=154
    //   X(shared_,·)         0=32 const_=33 wild=40 wildconst=41 immutable_=36
    //   X(shared_|const_,·)  0=48 const_=49 wild=56 wildconst=57
    //   X(shared_|wild,·)    0=160 const_=161 wild=168 wildconst=169 immutable_=164 shared_=162
    //                        shared_|const_=163 shared_|wildconst=171
    //   X(shared_|wildconst,·) 0=176 const_=177 wild=184 wildconst=185 shared_=178
    //                        shared_|const_=179
    //   X(immutable_,·)      0=64 const_=65 wild=72 wildconst=73 shared_=66 shared_|const_=67
    //                        shared_|wild=74 shared_|wildconst=75
    case 128:
    case 129:
    case 137:
    case 132:
    case 130:
    case 131:
    case 139:
    case 144:
    case 145:
    case 152:
    case 146:
    case 147:
    case 154:
    case 32:
    case 33:
    case 40:
    case 41:
    case 36:
    case 48:
    case 49:
    case 56:
    case 57:
    case 160:
    case 161:
    case 168:
    case 169:
    case 164:
    case 162:
    case 163:
    case 171:
    case 176:
    case 177:
    case 184:
    case 185:
    case 178:
    case 179:
    case 64:
    case 65:
    case 72:
    case 73:
    case 66:
    case 67:
    case 74:
    case 75:
        // foo(inout(U))                T                       => nomatch
        // foo(inout(U))                const(T)                => nomatch
        // foo(inout(U))                inout(const(T))         => nomatch
        // foo(inout(U))                immutable(T)            => nomatch
        // foo(inout(U))                shared(T)               => nomatch
        // foo(inout(U))                shared(const(T))        => nomatch
        // foo(inout(U))                shared(inout(const(T))) => nomatch
        // foo(inout(const(U)))         T                       => nomatch
        // foo(inout(const(U)))         const(T)                => nomatch
        // foo(inout(const(U)))         inout(T)                => nomatch
        // foo(inout(const(U)))         shared(T)               => nomatch
        // foo(inout(const(U)))         shared(const(T))        => nomatch
        // foo(inout(const(U)))         shared(inout(T))        => nomatch
        // foo(shared(U))               T                       => nomatch
        // foo(shared(U))               const(T)                => nomatch
        // foo(shared(U))               inout(T)                => nomatch
        // foo(shared(U))               inout(const(T))         => nomatch
        // foo(shared(U))               immutable(T)            => nomatch
        // foo(shared(const(U)))        T                       => nomatch
        // foo(shared(const(U)))        const(T)                => nomatch
        // foo(shared(const(U)))        inout(T)                => nomatch
        // foo(shared(const(U)))        inout(const(T))         => nomatch
        // foo(shared(inout(U)))        T                       => nomatch
        // foo(shared(inout(U)))        const(T)                => nomatch
        // foo(shared(inout(U)))        inout(T)                => nomatch
        // foo(shared(inout(U)))        inout(const(T))         => nomatch
        // foo(shared(inout(U)))        immutable(T)            => nomatch
        // foo(shared(inout(U)))        shared(T)               => nomatch
        // foo(shared(inout(U)))        shared(const(T))        => nomatch
        // foo(shared(inout(U)))        shared(inout(const(T))) => nomatch
        // foo(shared(inout(const(U)))) T                       => nomatch
        // foo(shared(inout(const(U)))) const(T)                => nomatch
        // foo(shared(inout(const(U)))) inout(T)                => nomatch
        // foo(shared(inout(const(U)))) inout(const(T))         => nomatch
        // foo(shared(inout(const(U)))) shared(T)               => nomatch
        // foo(shared(inout(const(U)))) shared(const(T))        => nomatch
        // foo(immutable(U))            T                       => nomatch
        // foo(immutable(U))            const(T)                => nomatch
        // foo(immutable(U))            inout(T)                => nomatch
        // foo(immutable(U))            inout(const(T))         => nomatch
        // foo(immutable(U))            shared(T)               => nomatch
        // foo(immutable(U))            shared(const(T))        => nomatch
        // foo(immutable(U))            shared(inout(T))        => nomatch
        // foo(immutable(U))            shared(inout(const(T))) => nomatch
        return MATCH.nomatch;

    default:
        return assertUnreachable();
    }
}

/**
 * dmd/templatesem.d:6582 — `private __gshared Expression emptyArrayElement = null;`.
 *
 * A process-global dummy filled lazily by `DeduceType.deduceEmptyArrayElement` (dmd:7575) and
 * compared by IDENTITY at dmd:6666 (`matchAll`) and dmd:7429/:7443 (`DeduceType.visit(Expression)`),
 * so every test is `===` on the class reference (05 §2).
 */
let emptyArrayElement: Expression | null = null;

/**
 * No D counterpart: the djs driver's reset between two compiles in one process (src/djs.ts
 * `deinitializeFrontend`), which ldc2 never needs. Puts this module's process state back to its load-time
 * value: the two function-static recursion counters (a compile stopped by `fatal()` leaves them raised), the
 * `emptyArrayElement` dummy (an Expression of the finished compile), and the `objId` numbering, so ids restart
 * as in a fresh process.
 */
export function resetTemplatesemState(): void {
    tryExpandMembersNest = 0;
    trySemantic3Nest = 0;
    emptyArrayElement = null;
    objIds = new WeakMap<object, number>();
    nextObjId = 1;
}

/*
 * Returns `true` if `t` is a reference type, or an array of reference types.
 */
// D module-private.
function isTopRef(t: Type): boolean {
    const tb = baseElemOf(t);
    return tb.ty === TY.Tclass ||
           tb.ty === TY.Taarray ||
           (tb.ty === TY.Tstruct && hasPointers(tb));
}

/*
 * Returns a valid `Loc` for semantic routines.
 * Some paths require a location derived from the first
 * template parameter when available.
 */
// D module-private. `scope ref TemplateParameters parameters` -> the container object (03 §3.2).
function semanticLoc(parameters: TemplateParameters): Loc {
    let loc: Loc = Loc.initial; // D `Loc loc;` — value-struct default init (09 §1.0)
    if (parameters.length !== 0)
        loc = parameters.opIndex(0)!.loc.copy(); // struct read out of a field (03 §1 #6)
    // 03 §9 elision: `loc` is a fresh local already copied out of the field and no alias to it
    // survives this frame, so the return copy is provably unnecessary.
    return loc;
}

// D module-private. `uint* wm` -> the box (03 §7.2); it is only ever OR-ed into, never re-pointed.
function deduceAliasThis(t: Type, sc: Scope | null, tparam: Type,
    parameters: TemplateParameters, dedtypes: Objects, wm: Ref<number> | null): MATCH {
    const tc = t.isTypeClass();
    if (tc !== null) {
        if (tc.sym!.aliasthis !== null && (tc.att & AliasThisRec.tracingDT) === 0) {
            const ato = aliasthisOf(t);
            if (ato !== null) {
                tc.att = (tc.att | AliasThisRec.tracingDT) as AliasThisRec; // branded flag re-cast (02 §11.5c #4)
                const m = deduceType(ato, sc, tparam, parameters, dedtypes, wm);
                tc.att = (tc.att & ~AliasThisRec.tracingDT) as AliasThisRec; // branded flag re-cast (02 §11.5c #4)
                return m;
            }
        }
    } else {
        const ts = t.isTypeStruct();
        if (ts !== null) {
            if (ts.sym!.aliasthis !== null && (ts.att & AliasThisRec.tracingDT) === 0) {
                const ato = aliasthisOf(t);
                if (ato !== null) {
                    ts.att = (ts.att | AliasThisRec.tracingDT) as AliasThisRec; // branded flag re-cast (02 §11.5c #4)
                    const m = deduceType(ato, sc, tparam, parameters, dedtypes, wm);
                    ts.att = (ts.att & ~AliasThisRec.tracingDT) as AliasThisRec; // branded flag re-cast (02 §11.5c #4)
                    return m;
                }
            }
        }
    }
    return MATCH.nomatch;
}

/**
 * D module-private.
 *
 * SAVE/RESTORE, NOT A COPY (dmd/templatesem.d:6654/:6656): D shortens `tpi.idents` by one across the
 * recursive `deduceType` call and then restores it. In D's `Array!T` (dmd/root/array.d:29) `length`
 * is a plain field over separate `data` storage, so `length--` / `length++` leaves the dropped
 * element intact and the regrow restores it. The port's `Array.length` setter truncates the backing
 * JS array destructively (root/array.ts:76), so the element is saved and put back explicitly — same
 * observable state, no reliance on capacity. (Recorded as a container-substitution act, 08 §5.)
 */
function deduceParentInstance(sc: Scope | null, sym: Dsymbol, tpi: TypeInstance,
    parameters: TemplateParameters, dedtypes: Objects, wm: Ref<number> | null): MATCH {
    if (tpi.idents.length === 0)
        return MATCH.nomatch;

    const id = tpi.idents.opIndex(tpi.idents.length - 1)!;
    // tag-proved RTTI downcast (02 §11.5c #3): the `dyncast() == DYNCAST.identifier` test on the
    // same line IS the proof, exactly as in D.
    if (id.dyncast() !== DYNCAST.identifier || !sym.ident!.equals(id as Identifier))
        return MATCH.nomatch;

    const tparent = dsymbolsemGetType(sym.parent!);
    if (tparent === null)
        return MATCH.nomatch;

    const savedIdent = tpi.idents.opIndex(tpi.idents.length - 1); // see SAVE/RESTORE above
    tpi.idents.length = tpi.idents.length - 1;
    const m = deduceType(tparent, sc, tpi, parameters, dedtypes, wm);
    tpi.idents.length = tpi.idents.length + 1;
    tpi.idents.opIndexAssign(savedIdent, tpi.idents.length - 1);
    return m;
}

// D module-private. Called as UFCS `xt.matchAll(tt)` at dmd:6863, :6907 and :7497.
function matchAll(td: TypeDeduced, tt: Type): MATCH {
    let match: MATCH = MATCH.exact;
    for (const [j, e] of td.argexps.opSlice().entries()) {
        assert(e !== null);
        if (e === emptyArrayElement)
            continue;

        const t = substWildTo(addMod(tt, td.tparams.opIndex(j)!.mod), MODFlags.const_);

        const m = implicitConvTo(e, t);
        if (match > m)
            match = m;
        if (match === MATCH.nomatch)
            break;
    }
    return match;
}

/****
 * Given an identifier, figure out which TemplateParameter it is.
 * Return IDX_NOTFOUND if not found.
 */
// D module-private.
function templateIdentifierLookup(id: Identifier, parameters: TemplateParameters | null): number {
    for (let i = 0; i < parameters!.length; i++) {
        const tp = parameters!.opIndex(i)!;
        if (tp.ident!.equals(id))
            return i;
    }
    return IDX_NOTFOUND;
}

// D module-private; called from chunk 2 (dmd:4757, :4881).
export function templateParameterLookup(tparam: Type, parameters: TemplateParameters | null): number {
    const tident = tparam.isTypeIdentifier();
    if (tident !== null) {
        //printf("\ttident = '%s'\n", tident.toChars());
        return templateIdentifierLookup(tident.ident!, parameters);
    }
    return IDX_NOTFOUND;
}

/* These form the heart of template argument deduction.
 * Given 'this' being the type argument to the template instance,
 * it is matched against the template declaration parameter specialization
 * 'tparam' to determine the type to be used for the parameter.
 * Example:
 *      template Foo(T:T*)      // template declaration
 *      Foo!(int*)              // template instantiation
 * Input:
 *      this = int*
 *      tparam = T*
 *      parameters = [ T:T* ]   // Array of TemplateParameter's
 * Output:
 *      dedtypes = [ int ]      // Array of Expression/Type's
 *
 * `tparam` is null-tested (dmd:6734) AND REASSIGNED (dmd:6755, :6938) from inside the nested
 * `DeduceType` class, so the parameter binding itself is the mutable slot the class closes over —
 * exactly D's shape (13 §7 verdict: this file is IDIOM A; the class stays nested because it is a
 * genuine closure over `tparam`/`sc`/`parameters`/`dedtypes`/`wm`/`inferStart`/`ignoreAliasThis`).
 */
export function deduceType(o: RootObject, sc: Scope | null, tparam: Type | null,
    parameters: TemplateParameters, dedtypes: Objects,
    wm: Ref<number> | null = null, inferStart = 0, ignoreAliasThis = false): MATCH {
    class DeduceType extends Visitor {
        // dropped: alias visit = Visitor.visit — no overload hiding in TS (13 §1)
        result: MATCH;

        constructor() {
            super();
            this.result = MATCH.nomatch;
        }

        override visitType(t: Type): void {
            // Lexact: / Lnomatch: / Lconst: — dmd/templatesem.d:6977/:6981/:6985. Three BAIL tails
            // reached by 22 `goto`s from up to five nesting levels; per 06 §4 they CAPTURE the
            // enclosing locals and never take positional parameters.
            const Lexact = (): void => {
                this.result = MATCH.exact;
            };
            const Lnomatch = (): void => {
                this.result = MATCH.nomatch;
            };
            const Lconst = (): void => {
                this.result = MATCH.constant;
            };

            if (tparam === null)
                return Lnomatch(); // goto Lnomatch (dmd/templatesem.d:6735)

            if (t === tparam)
                return Lexact(); // goto Lexact (dmd/templatesem.d:6738)

            if (tparam.ty === TY.Tident) {
                // Determine which parameter tparam is
                const i = templateParameterLookup(tparam, parameters);
                if (i === IDX_NOTFOUND) {
                    if (sc === null)
                        return Lnomatch(); // goto Lnomatch (dmd/templatesem.d:6747)

                    /* Need a loc to go with the semantic routine. */
                    const loc = semanticLoc(parameters);

                    /* BUG: what if tparam is a template instance, that
                     * has as an argument another Tident?
                     */
                    tparam = typeSemantic(tparam, loc, sc);
                    assert(tparam.ty !== TY.Tident);
                    this.result = deduceType(t, sc, tparam, parameters, dedtypes, wm);
                    return;
                }

                const tp = parameters.opIndex(i)!;

                const tident = tparam.isTypeIdentifier()!;
                if (tident.idents.length > 0) {
                    //printf("matching %s to %s\n", tparam.toChars(), t.toChars());
                    let s = toDsymbol(t, sc);
                    for (let j = tident.idents.length; j-- > 0;) {
                        const id = tident.idents.opIndex(j)!;
                        if (id.dyncast() === DYNCAST.identifier) {
                            if (s === null || s.parent === null)
                                return Lnomatch(); // goto Lnomatch (dmd/templatesem.d:6774)
                            // tag-proved RTTI downcast (02 §11.5c #3): the `dyncast()` test on the
                            // enclosing line IS the proof.
                            let s2 = search(s.parent, Loc.initial, id as Identifier);
                            if (s2 === null)
                                return Lnomatch(); // goto Lnomatch (dmd/templatesem.d:6777)
                            s2 = toAlias(s2);
                            //printf("[%d] s = %s %s, s2 = %s %s\n", j, s.kind(), s.toChars(), s2.kind(), s2.toChars());
                            if (s !== s2) {
                                const tx = dsymbolsemGetType(s2);
                                if (tx !== null) {
                                    if (s !== toDsymbol(tx, sc))
                                        return Lnomatch(); // goto Lnomatch (dmd/templatesem.d:6785)
                                } else
                                    return Lnomatch(); // goto Lnomatch (dmd/templatesem.d:6788)
                            }
                            s = s.parent;
                        } else
                            return Lnomatch(); // goto Lnomatch (dmd/templatesem.d:6793)
                    }
                    //printf("[e] s = %s\n", s?s.toChars():"(null)");
                    if (tp.isTemplateTypeParameter() !== null) {
                        // D: `Type tt = dmd.dsymbolsem.getType(s);` (templatesem.d:6798) with NO
                        // null test — `getType` (dsymbolsem.d:956) dereferences its parameter
                        // immediately, so a null `s` faults in D. `!` marks that same fault point
                        // (02 §10.1); an added null guard would turn the fault into `Lnomatch`.
                        const tt = dsymbolsemGetType(s!);
                        if (tt === null)
                            return Lnomatch(); // goto Lnomatch (dmd/templatesem.d:6800)
                        // tag-proved RTTI downcast (02 §11.5c #3): D's `cast(Type)dedtypes[i]` is a
                        // dynamic class cast on a RootObject; the adjacent DYNCAST compare IS the
                        // proof (tree precedent: expressionsem.ts:10550).
                        const di = dedtypes.opIndex(i);
                        let at: Type | null =
                            (di !== null && di.dyncast() === DYNCAST.type) ? (di as unknown as Type) : null;
                        if (at !== null && at.ty === TY.Tnone)
                            // tag-proved RTTI downcast (02 §11.5c #3): `at.ty == Tnone` on the line
                            // above IS the proof — TypeDeduced is the only Tnone type (dtemplate.d:392).
                            at = (at as unknown as TypeDeduced).tded;
                        if (at === null || tt.equals(at)) {
                            dedtypes.opIndexAssign(tt, i);
                            return Lexact(); // goto Lexact (dmd/templatesem.d:6807)
                        }
                    }
                    if (tp.isTemplateAliasParameter() !== null) {
                        // tag-proved RTTI downcast (02 §11.5c #3): D's `cast(Dsymbol)dedtypes[i]`;
                        // the adjacent DYNCAST compare IS the proof.
                        const dj = dedtypes.opIndex(i);
                        const s2: Dsymbol | null =
                            (dj !== null && dj.dyncast() === DYNCAST.dsymbol) ? (dj as unknown as Dsymbol) : null;
                        if (s2 === null || s === s2) {
                            dedtypes.opIndexAssign(s, i);
                            return Lexact(); // goto Lexact (dmd/templatesem.d:6816)
                        }
                    }
                    return Lnomatch(); // goto Lnomatch (dmd/templatesem.d:6819)
                }

                // Found the corresponding parameter tp
                /* (D's nesting-comment form has no TS equivalent; re-spelled as a block comment)
                    https://issues.dlang.org/show_bug.cgi?id=23578
                    To pattern match:
                    static if (is(S!int == S!av, alias av))

                    We eventually need to deduce `int` (Tint32 [0]) and `av` (Tident).
                    Previously this would not get pattern matched at all, but now we check if the
                    template parameter `av` came from.

                    This note has been left to serve as a hint for further explorers into
                    how IsExp matching works.
                */
                const ta = tp.isTemplateAliasParameter();
                if (ta !== null) {
                    dedtypes.opIndexAssign(t, i);
                    return Lexact(); // goto Lexact (dmd/templatesem.d:6838)
                }
                // (23578) - ensure previous behaviour for non-alias template params
                if (tp.isTemplateTypeParameter() === null) {
                    return Lnomatch(); // goto Lnomatch (dmd/templatesem.d:6843)
                }

                // tag-proved RTTI downcast (02 §11.5c #3): D's `cast(Type)dedtypes[i]`; the adjacent
                // DYNCAST compare IS the proof (tree precedent: expressionsem.ts:10550).
                const dk = dedtypes.opIndex(i);
                const at: Type | null =
                    (dk !== null && dk.dyncast() === DYNCAST.type) ? (dk as unknown as Type) : null;
                // D `Type tt;` is written through BOTH `deduceWildHelper(t, &tt, tparam)` and
                // `deduceTypeHelper(t, tt, tparam)` (an `out` param), so one shared box serves both.
                const tt: Ref<Type | null> = { value: null };
                const wx = wm !== null ? deduceWildHelper(t, tt, tparam) : 0;
                if (wx !== 0) {
                    // type vs (none)
                    if (at === null) {
                        dedtypes.opIndexAssign(tt.value, i);
                        wm!.value |= wx;
                        this.result = MATCH.constant;
                        return;
                    }

                    // type vs expressions
                    if (at.ty === TY.Tnone) {
                        // tag-proved RTTI downcast (02 §11.5c #3): `at.ty == Tnone` above IS the proof.
                        const xt = at as unknown as TypeDeduced;
                        this.result = matchAll(xt, tt.value!);
                        if (this.result > MATCH.nomatch) {
                            dedtypes.opIndexAssign(tt.value, i);
                            if (this.result > MATCH.constant)
                                this.result = MATCH.constant; // limit level for inout matches
                        }
                        return;
                    }

                    // type vs type
                    if (tt.value!.equals(at)) {
                        dedtypes.opIndexAssign(tt.value, i); // Prefer current type match
                        return Lconst(); // goto Lconst (dmd/templatesem.d:6877)
                    }
                    if (implicitConvToType(tt.value!, constOf(at)) !== MATCH.nomatch) {
                        dedtypes.opIndexAssign(mutableOf(constOf(at)), i);
                        wm!.value |= MODFlags.const_;
                        return Lconst(); // goto Lconst (dmd/templatesem.d:6883)
                    }
                    if (implicitConvToType(at, constOf(tt.value!)) !== MATCH.nomatch) {
                        dedtypes.opIndexAssign(mutableOf(constOf(tt.value!)), i);
                        wm!.value |= MODFlags.const_;
                        return Lconst(); // goto Lconst (dmd/templatesem.d:6889)
                    }
                    return Lnomatch(); // goto Lnomatch (dmd/templatesem.d:6891)
                } else {
                    const m = deduceTypeHelper(t, tt, tparam);
                    if (m !== MATCH.nomatch) {
                        // type vs (none)
                        if (at === null) {
                            dedtypes.opIndexAssign(tt.value, i);
                            this.result = m;
                            return;
                        }

                        // type vs expressions
                        if (at.ty === TY.Tnone) {
                            // tag-proved RTTI downcast (02 §11.5c #3): `at.ty == Tnone` above IS the proof.
                            const xt = at as unknown as TypeDeduced;
                            this.result = matchAll(xt, tt.value!);
                            if (this.result > MATCH.nomatch) {
                                dedtypes.opIndexAssign(tt.value, i);
                            }
                            return;
                        }

                        // type vs type
                        if (tt.value!.equals(at)) {
                            return Lexact(); // goto Lexact (dmd/templatesem.d:6918)
                        }
                        if (tt.value!.ty === TY.Tclass && at.ty === TY.Tclass) {
                            this.result = implicitConvToType(tt.value!, at);
                            return;
                        }
                        if (tt.value!.ty === TY.Tsarray && at.ty === TY.Tarray
                            && implicitConvToType(nextOf(tt.value!)!, nextOf(at)!) >= MATCH.constant) {
                            return Lexact(); // goto Lexact (dmd/templatesem.d:6927)
                        }
                    }
                }
                return Lnomatch(); // goto Lnomatch (dmd/templatesem.d:6930)
            }

            if (tparam.ty === TY.Ttypeof) {
                    /* Need a loc to go with the semantic routine. */
                    const loc = semanticLoc(parameters);

                tparam = typeSemantic(tparam, loc, sc);
            }
            if (t.ty !== tparam.ty) {
                const sym = toDsymbol(t, sc);
                if (sym !== null) {
                    // D `!tparam.deco` (templatesem.d:6944) is a POINTER test; `Type.deco`
                    // (mtype.ts:721) is `string | null`, so the faithful form is the plain null
                    // test (06 §2.7) — the same spelling the rest of this file and the tree use.
                    if (sym.isforwardRef() && tparam.deco === null)
                        return Lnomatch(); // goto Lnomatch (dmd/templatesem.d:6945)
                }

                let m = implicitConvToType(t, tparam);
                if (m === MATCH.nomatch && !ignoreAliasThis) {
                    m = deduceAliasThis(t, sc, tparam, parameters, dedtypes, wm);
                }
                this.result = m;
                return;
            }

            if (nextOf(t) !== null) {
                // D `tparam.deco` (templatesem.d:6959) — pointer test, plain null form.
                if (tparam.deco !== null && !tparam.hasWild()) {
                    this.result = implicitConvToType(t, tparam);
                    return;
                }

                let tpn = nextOf(tparam)!;
                if (wm !== null && t.ty === TY.Taarray && tparam.isWild()) {
                    // https://issues.dlang.org/show_bug.cgi?id=12403
                    // In IFTI, stop inout matching on transitive part of AA types.
                    tpn = substWildTo(tpn, MODFlags.mutable);
                }

                this.result = deduceType(nextOf(t)!, sc, tpn, parameters, dedtypes, wm);
                return;
            }

            // fall-through INTO `Lexact:` (dmd/templatesem.d:6977)
            Lexact();
        }

        override visitTypeVector(t: TypeVector): void {
            // D dereferences `tparam` here WITHOUT a null guard (dmd:6991); `!` marks that same
            // fault point (02 §10.1).
            const tp = tparam!.isTypeVector();
            if (tp !== null) {
                this.result = deduceType(t.basetype!, sc, tp.basetype, parameters, dedtypes, wm);
                return;
            }
            this.visitType(t);
        }

        override visitTypeDArray(t: TypeDArray): void {
            this.visitType(t);
        }

        override visitTypeSArray(t: TypeSArray): void {
            // Extra check that array dimensions must match
            if (tparam === null) {
                this.visitType(t);
                return;
            }

            if (tparam.ty === TY.Tarray) {
                const m = deduceType(t.next!, sc, nextOf(tparam), parameters, dedtypes, wm);
                this.result = (m >= MATCH.constant) ? MATCH.convert : MATCH.nomatch;
                return;
            }

            let tp: TemplateParameter | null = null;
            let edim: Expression | null = null;
            let i = 0; // D `size_t i;`
            const tsa = tparam.isTypeSArray();
            if (tsa !== null) {
                const dimVe = tsa.dim!.isVarExp();
                if (dimVe !== null && (dimVe.var_!.storage_class & STC.templateparameter) !== 0n) {
                    const id = dimVe.var_!.ident!;
                    i = templateIdentifierLookup(id, parameters);
                    assert(i !== IDX_NOTFOUND);
                    tp = parameters.opIndex(i);
                } else
                    edim = tsa.dim;
            } else {
                const taa = tparam.isTypeAArray();
                if (taa !== null) {
                    i = templateParameterLookup(taa.index!, parameters);
                    if (i !== IDX_NOTFOUND)
                        tp = parameters.opIndex(i);
                    else {
                        let loc: Loc = Loc.initial; // D `Loc loc;`
                        // The "type" (it hasn't been resolved yet) of the function parameter
                        // does not have a location but the parameter it is related to does,
                        // so we use that for the resolution (better error message).
                        if (inferStart < parameters.length) {
                            const loctp = parameters.opIndex(inferStart)!;
                            loc = loctp.loc.copy();
                        }

                        const eBox: Ref<Expression | null> = { value: null };
                        const txBox: Ref<Type | null> = { value: null };
                        const sBox: Ref<Dsymbol | null> = { value: null };
                        resolve(taa.index!, loc, sc, eBox, txBox, sBox);
                        // §F.3 rename: `getValue(s)` is the `ref Dsymbol` overload, `getValue(e)` the
                        // Expression one — both spelled `getValue` on ONE D line (dmd:7056).
                        edim = sBox.value !== null
                            ? getValueFromDsymbol(sBox.value)
                            : getValueFromExpression(eBox.value);
                    }
                }
            }
            if ((tp !== null && matchArgFromObject(tp, sc!, t.dim, i, parameters, dedtypes, null) !== MATCH.nomatch) ||
                (edim !== null && edim.isIntegerExp() !== null && toInteger(edim) === toInteger(t.dim!))
            ) {
                this.result = deduceType(t.next!, sc, nextOf(tparam), parameters, dedtypes, wm);
                return;
            }

            this.visitType(t);
        }

        override visitTypeAArray(t: TypeAArray): void {
            // Extra check that index type must match
            if (tparam !== null && tparam.ty === TY.Taarray) {
                const tp = tparam.isTypeAArray()!;
                if (deduceType(t.index!, sc, tp.index, parameters, dedtypes) === MATCH.nomatch) {
                    this.result = MATCH.nomatch;
                    return;
                }
            }
            this.visitType(t);
        }

        override visitTypeFunction(t: TypeFunction): void {
            // Extra check that function characteristics must match
            if (tparam === null)
                return this.visitType(t);

            const tp = tparam.isTypeFunction();
            if (tp === null) {
                this.visitType(t);
                return;
            }

            if (t.parameterList.varargs !== tp.parameterList.varargs || t.linkage !== tp.linkage) {
                this.result = MATCH.nomatch;
                return;
            }

            // D: `foreach (fparam; *tp.parameterList.parameters)` (templatesem.d:7104) — a POINTER
            // dereference, so a null `parameters` faults in D; `!` marks that fault point
            // (02 §10.1). `?? []` would silently skip the loop D never skips.
            for (const fparam of tp.parameterList.parameters!) {
                // https://issues.dlang.org/show_bug.cgi?id=2579
                // Apply function parameter storage classes to parameter types
                fparam!.type = addStorageClass(fparam!.type!, fparam!.storageClass);
                fparam!.storageClass = (fparam!.storageClass & ~STC.TYPECTOR) as STC; // branded flag re-cast (02 §11.5c #4)

                // https://issues.dlang.org/show_bug.cgi?id=15243
                // Resolve parameter type if it's not related with template parameters
                if (!reliesOnTemplateParameters(fparam!.type!, parameters.opSlice(inferStart, parameters.length))) {
                    const tx = typeSemantic(fparam!.type!, Loc.initial, sc);
                    if (tx.ty === TY.Terror) {
                        this.result = MATCH.nomatch;
                        return;
                    }
                    fparam!.type = tx;
                }
            }

            const nfargs = t.parameterList.length();
            // D `ref size_t nfparams` is DECREMENTED by deduceFunctionTuple (dmd:7970), so it is a box.
            const nfparams: Ref<number> = { value: tp.parameterList.length() };

            if (!deduceFunctionTuple(t, tp, parameters, dedtypes, nfargs, nfparams)) {
                this.result = MATCH.nomatch;
                return;
            }

            // DEAD LABEL: `L2:` at dmd/templatesem.d:7134 has no `goto` in 1.43 (the only `goto L2`,
            // dmd:7235, targets visit(TypeInstance)'s own L2 at :7249). Emitting a labelled block
            // here would be a phantom, so nothing is emitted (07 audit convention).
            assert(nfparams.value <= tp.parameterList.length());
            // D `foreach (i, ap; tp.parameterList)` drives `ParameterList.opApply` (05 §11 / 06 §1.8);
            // the body's `return` out of the foreach needs a second signal beyond D's break code.
            let earlyReturn = false;
            tp.parameterList.opApply((i: number, ap: Parameter): number => {
                if (i === nfparams.value)
                    return 1; // D `break`

                const a = t.parameterList.opIndex(i)!;

                if (!a.isCovariant(t.isRef, ap) ||
                    deduceType(a.type!, sc, ap.type, parameters, dedtypes) === MATCH.nomatch) {
                    this.result = MATCH.nomatch;
                    earlyReturn = true;
                    return 1;
                }
                return 0;
            });
            if (earlyReturn)
                return;

            this.visitType(t);
        }

        override visitTypeIdentifier(t: TypeIdentifier): void {
            // Extra check
            if (tparam !== null && tparam.ty === TY.Tident) {
                const tp = tparam.isTypeIdentifier()!;
                for (let i = 0; i < t.idents.length; i++) {
                    const id1 = t.idents.opIndex(i)!;
                    const id2 = tp.idents.opIndex(i)!;
                    if (!rootObjectsEqual(id1, id2)) {
                        this.result = MATCH.nomatch;
                        return;
                    }
                }
            }
            this.visitType(t);
        }

        override visitTypeInstance(t: TypeInstance): void {
            // Lnomatch: — dmd/templatesem.d:7256. BAIL tail (targets at :7239, :7244, :7247, :7251).
            const Lnomatch = (): void => {
                //printf("no match\n");
                this.result = MATCH.nomatch;
            };

            // Extra check
            if (tparam === null || tparam.ty !== TY.Tinstance || t.tempinst!.tempdecl === null) {
                this.visitType(t);
                return;
            }

            const tempdecl = t.tempinst!.tempdecl!.isTemplateDeclaration();
            assert(tempdecl !== null);

            const tp = tparam.isTypeInstance()!;

            // L2: — dmd/templatesem.d:7249. Reached BOTH by fall-through and by `goto L2` (dmd:7235,
            // from four nesting levels down). Its body is terminal, so it is a shared BAIL tail
            // called from both routes (06 §4).
            const L2 = (): void => {
                // `tempdecl!` — the `assert(tempdecl !== null)` above proves it; TS's narrowing of a
                // captured binding does not cross the closure boundary.
                if (!resolveTemplateInstantiation(sc, parameters, t.tempinst!.tiargs,
                        t.tempinst!.tdtypes, tempdecl!, tp, dedtypes))
                    return Lnomatch(); // goto Lnomatch (dmd/templatesem.d:7251)

                this.visitType(t);
            };

            //printf("tempinst.tempdecl = %p\n", tempdecl);
            //printf("tp.tempinst.tempdecl = %p\n", tp.tempinst.tempdecl);
            if (tp.tempinst!.tempdecl === null) {
                //printf("tp.tempinst.name = '%s'\n", tp.tempinst.name.toChars());

                /* Handle case of:
                 *  template Foo(T : sa!(T), alias sa)
                 */
                const i = templateIdentifierLookup(tp.tempinst!.name!, parameters);
                if (i === IDX_NOTFOUND) {
                    /* Didn't find it as a parameter identifier. Try looking
                     * it up and seeing if is an alias.
                     * https://issues.dlang.org/show_bug.cgi?id=1454
                     */
                    const tid = new TypeIdentifier(tp.loc, tp.tempinst!.name!);
                    const eBox: Ref<Expression | null> = { value: null };
                    const txBox: Ref<Type | null> = { value: null };
                    const sBox: Ref<Dsymbol | null> = { value: null };
                    resolve(tid, tp.loc, sc, eBox, txBox, sBox);
                    let s = sBox.value;
                    if (txBox.value !== null) {
                        s = toDsymbol(txBox.value, sc);
                        const ti = s !== null ? s.parent!.isTemplateInstance() : null;
                        if (ti !== null) {
                            // https://issues.dlang.org/show_bug.cgi?id=14290
                            // Try to match with ti.tempecl,
                            // only when ti is an enclosing instance.
                            let p: Dsymbol | null = sc!.parent;
                            while (p !== null && p !== ti)
                                p = p.parent;
                            if (p !== null)
                                s = ti.tempdecl;
                        }
                    }
                    if (s !== null) {
                        s = toAlias(s);
                        let td = s.isTemplateDeclaration();
                        if (td !== null) {
                            if (td.overroot !== null)
                                td = td.overroot;
                            for (; td !== null; td = td.overnext) {
                                if (td === tempdecl)
                                    return L2(); // goto L2 (dmd/templatesem.d:7235)
                            }
                        }
                    }
                    return Lnomatch(); // goto Lnomatch (dmd/templatesem.d:7239)
                }

                const tpx = parameters.opIndex(i)!;
                if (matchArgFromObject(tpx, sc!, tempdecl, i, parameters, dedtypes, null) === MATCH.nomatch)
                    return Lnomatch(); // goto Lnomatch (dmd/templatesem.d:7244)
            } else if (tempdecl !== tp.tempinst!.tempdecl)
                return Lnomatch(); // goto Lnomatch (dmd/templatesem.d:7247)

            L2(); // fall-through INTO `L2:` (dmd/templatesem.d:7249)
        }

        override visitTypeStruct(t: TypeStruct): void {
            /* If this struct is a template struct, and we're matching
             * it against a template instance, convert the struct type
             * to a template instance, too, and try again.
             */
            const ti = t.sym!.parent!.isTemplateInstance();

            if (tparam !== null && tparam.ty === TY.Tinstance) {
                if (ti !== null && toAlias(ti) === t.sym) {
                    const tx = new TypeInstance(Loc.initial, ti);
                    const m = deduceType(tx, sc, tparam, parameters, dedtypes, wm);
                    // if we have a no match we still need to check alias this
                    if (m !== MATCH.nomatch) {
                        this.result = m;
                        return;
                    }
                }

                const tpi = tparam.isTypeInstance()!;
                const m = deduceParentInstance(sc, t.sym!, tpi, parameters, dedtypes, wm);
                if (m !== MATCH.nomatch) {
                    this.result = m;
                    return;
                }
            }

            // Extra check
            if (tparam !== null && tparam.ty === TY.Tstruct) {
                const tp = tparam.isTypeStruct()!;

                //printf("\t%d\n", cast(MATCH) t.implicitConvTo(tp));
                if (wm !== null && deduceWild(t, tparam, false) !== 0) {
                    this.result = MATCH.constant;
                    return;
                }
                this.result = implicitConvToType(t, tp);
                return;
            }
            this.visitType(t);
        }

        override visitTypeEnum(t: TypeEnum): void {
            // Extra check
            if (tparam !== null && tparam.ty === TY.Tenum) {
                const tp = tparam.isTypeEnum()!;
                if (t.sym === tp.sym)
                    this.visitType(t);
                else
                    this.result = MATCH.nomatch;
                return;
            }
            const tb = toBasetype(t);
            if (tb.ty === tparam!.ty || (tb.ty === TY.Tsarray && tparam!.ty === TY.Taarray)) {
                this.result = deduceType(tb, sc, tparam, parameters, dedtypes, wm);
                if (this.result === MATCH.exact)
                    this.result = MATCH.convert;
                return;
            }
            this.visitType(t);
        }

        override visitTypeClass(t: TypeClass): void {
            //printf("TypeClass.deduceType(this = %s)\n", t.toChars());

            /* If this class is a template class, and we're matching
             * it against a template instance, convert the class type
             * to a template instance, too, and try again.
             */
            const ti = t.sym!.parent!.isTemplateInstance();

            if (tparam !== null && tparam.ty === TY.Tinstance) {
                if (ti !== null && toAlias(ti) === t.sym) {
                    const tx = new TypeInstance(Loc.initial, ti);
                    const m = deduceType(tx, sc, tparam, parameters, dedtypes, wm);
                    // Even if the match fails, there is still a chance it could match
                    // a base class.
                    if (m !== MATCH.nomatch) {
                        this.result = m;
                        return;
                    }
                }

                const tpi = tparam.isTypeInstance()!;
                const m = deduceParentInstance(sc, t.sym!, tpi, parameters, dedtypes, wm);
                if (m !== MATCH.nomatch) {
                    this.result = m;
                    return;
                }

                // If it matches exactly or via implicit conversion, we're done
                this.visitType(t);
                if (this.result !== MATCH.nomatch)
                    return;

                /* There is still a chance to match via implicit conversion to
                 * a base class or interface. Because there could be more than one such
                 * match, we need to check them all.
                 */

                // Have we found an interface match? D `int numBaseClassMatches = 0;` is passed by
                // `ref` to deduceBaseClassParameters, so it travels as a box (03 §3.3).
                const numBaseClassMatches: Ref<number> = { value: 0 };

                // Our best guess at dedtypes
                const best: Objects = new DArray<RootObject | null>(dedtypes.length);

                let s: ClassDeclaration | null = t.sym;
                while (s !== null && s.baseclasses!.length > 0) {
                    // Test the base class
                    deduceBaseClassParameters(s.baseclasses!.opIndex(0)!, sc, tparam, parameters, dedtypes, best, numBaseClassMatches);

                    // Test the interfaces inherited by the base class
                    for (const b of s.interfaces ?? []) {
                        deduceBaseClassParameters(b!, sc, tparam, parameters, dedtypes, best, numBaseClassMatches);
                    }
                    s = s.baseclasses!.opIndex(0)!.sym;
                }

                if (numBaseClassMatches.value === 0) {
                    this.result = MATCH.nomatch;
                    return;
                }

                // If we got at least one match, copy the known types into dedtypes.
                // D `memcpy(dedtypes.tdata(), best.tdata(), best.length * (void*).sizeof)` overwrites
                // the CALLER's container in place — its identity must survive (03 in-place
                // value-overwrite), so the slots are assigned, never the reference.
                for (let k = 0; k < best.length; k++)
                    dedtypes.opIndexAssign(best.opIndex(k), k);
                this.result = MATCH.convert;
                return;
            }

            // Extra check
            if (tparam !== null && tparam.ty === TY.Tclass) {
                const tp = tparam.isTypeClass()!;

                //printf("\t%d\n", cast(MATCH) t.implicitConvTo(tp));
                if (wm !== null && deduceWild(t, tparam, false) !== 0) {
                    this.result = MATCH.constant;
                    return;
                }
                this.result = implicitConvToType(t, tp);
                return;
            }
            this.visitType(t);
        }

        override visitExpression(e: Expression): void {
            //printf("Expression.deduceType(e = %s)\n", e.toChars());
            const i = templateParameterLookup(tparam!, parameters);
            if (i === IDX_NOTFOUND || tparam!.isTypeIdentifier()!.idents.length > 0) {
                if (e === emptyArrayElement && tparam!.ty === TY.Tarray) {
                    // `cast(TypeNext)tparam` — proved by `tparam.ty == Tarray` on the line above
                    // (02 §11.5c #3).
                    const tn = (tparam as unknown as TypeNext).next;
                    this.result = deduceType(emptyArrayElement!, sc, tn, parameters, dedtypes, wm);
                    return;
                }
                e.type!.accept(this);
                return;
            }

            const tp = parameters.opIndex(i)!.isTemplateTypeParameter();
            if (tp === null)
                return; // nomatch

            if (e === emptyArrayElement) {
                if (dedtypes.opIndex(i) !== null) {
                    this.result = MATCH.exact;
                    return;
                }
                if (tp.defaultType !== null) {
                    tp.defaultType.accept(this);
                    return;
                }
            }

            // tag-proved RTTI downcast (02 §11.5c #3): D's `cast(Type)dedtypes[i]`; the adjacent
            // DYNCAST compare IS the proof (tree precedent: expressionsem.ts:10550).
            const dm = dedtypes.opIndex(i);
            let at: Type | null =
                (dm !== null && dm.dyncast() === DYNCAST.type) ? (dm as unknown as Type) : null;
            // D `Type tt;` is written by both deduceWildHelper (`&tt`) and deduceTypeHelper (`out`),
            // and re-assigned outright at dmd:7476 — one shared box (03 §3.3/§7.2).
            const tt: Ref<Type | null> = { value: null };
            const wx = deduceWildHelper(e.type!, tt, tparam!);
            if (wx !== 0) {
                wm!.value |= wx;
                this.result = MATCH.constant;
            } else {
                const m = deduceTypeHelper(e.type!, tt, tparam!);
                if (m !== MATCH.nomatch) {
                    this.result = m;
                } else if (!isTopRef(e.type!)) {
                    /* https://issues.dlang.org/show_bug.cgi?id=15653
                     * In IFTI, recognize top-qualifier conversions
                     * through the value copy, e.g.
                     *      int --> immutable(int)
                     *      immutable(string[]) --> immutable(string)[]
                     */
                    tt.value = mutableOf(e.type!);
                    this.result = MATCH.convert;
                } else
                    return; // nomatch
            }

            // expression vs (none)
            if (at === null) {
                dedtypes.opIndexAssign(new TypeDeduced(tt.value!, e, tparam!), i);
                return;
            }

            let xt: TypeDeduced | null = null;
            if (at.ty === TY.Tnone) {
                // tag-proved RTTI downcast (02 §11.5c #3): `at.ty == Tnone` above IS the proof.
                xt = at as unknown as TypeDeduced;
                at = xt.tded;
            }

            // From previous matched expressions to current deduced type
            let match1: MATCH = xt !== null ? matchAll(xt, tt.value!) : MATCH.nomatch;

            // From current expressions to previous deduced type
            let pt = addMod(at, tparam!.mod);
            if (wm!.value !== 0)
                pt = substWildTo(pt, wm!.value);
            let match2: MATCH = implicitConvTo(e, pt);

            if (match1 > MATCH.nomatch && match2 > MATCH.nomatch) {
                if (implicitConvToType(at, tt.value!) === MATCH.nomatch)
                    match1 = MATCH.nomatch; // Prefer at
                else if (implicitConvToType(tt.value!, at) === MATCH.nomatch)
                    match2 = MATCH.nomatch; // Prefer tt
                else if (tt.value!.isTypeBasic() !== null && tt.value!.ty === at.ty && tt.value!.mod !== at.mod) {
                    if (!tt.value!.isMutable() && !at.isMutable())
                        tt.value = addMod(mutableOf(tt.value!), MODmerge(tt.value!.mod, at.mod));
                    else if (tt.value!.isMutable()) {
                        if (at.mod === 0) // Prefer unshared
                            match1 = MATCH.nomatch;
                        else
                            match2 = MATCH.nomatch;
                    } else if (at.isMutable()) {
                        if (tt.value!.mod === 0) // Prefer unshared
                            match2 = MATCH.nomatch;
                        else
                            match1 = MATCH.nomatch;
                    }
                    //printf("tt = %s, at = %s\n", tt.toChars(), at.toChars());
                } else {
                    match1 = MATCH.nomatch;
                    match2 = MATCH.nomatch;
                }
            }
            if (match1 > MATCH.nomatch) {
                // Prefer current match: tt
                if (xt !== null)
                    // §F rename of dtemplate's `update` overload set (dtemplate.ts:461).
                    xt.updateFromType(tt.value!, e, tparam!);
                else
                    dedtypes.opIndexAssign(tt.value, i);
                this.result = match1;
                return;
            }
            if (match2 > MATCH.nomatch) {
                // Prefer previous match: (*dedtypes)[i]
                if (xt !== null)
                    xt.updateFromExpression(e, tparam!);
                this.result = match2;
                return;
            }

            /* Deduce common type
             */
            const t = rawTypeMerge(at, tt.value!);
            if (t !== null) {
                if (xt !== null)
                    xt.updateFromType(t, e, tparam!);
                else
                    dedtypes.opIndexAssign(t, i);

                pt = addMod(tt.value!, tparam!.mod);
                if (wm!.value !== 0)
                    pt = substWildTo(pt, wm!.value);
                this.result = implicitConvTo(e, pt);
                return;
            }

            this.result = MATCH.nomatch;
        }

        // dmd/templatesem.d:7575 — a private helper, NOT a `visit` override.
        private deduceEmptyArrayElement(): MATCH {
            if (emptyArrayElement === null) {
                emptyArrayElement = new IdentifierExp(Loc.initial, Id.p!); // dummy
                emptyArrayElement.type = Type.tvoid;
            }
            assert(tparam!.ty === TY.Tarray);

            // `cast(TypeNext)tparam` — proved by the assert above (02 §11.5c #3).
            const tn = (tparam as unknown as TypeNext).next;
            return deduceType(emptyArrayElement, sc, tn, parameters, dedtypes, wm);
        }

        override visitNullExp(e: NullExp): void {
            if (tparam!.ty === TY.Tarray && e.type!.ty === TY.Tnull) {
                // tparam:T[] <- e:null (void[])
                this.result = this.deduceEmptyArrayElement();
                return;
            }
            this.visitExpression(e);
        }

        override visitStringExp(e: StringExp): void {
            // D `Type taai;` is declared before the condition and ASSIGNED INSIDE it, then read on
            // the same line — hoisted to a `let` so the assignment stays an expression-order 1:1.
            let taai: Type | null = null;
            if (e.type!.ty === TY.Tarray
                && (tparam!.ty === TY.Tsarray
                    || (tparam!.ty === TY.Taarray
                        // tag-proved RTTI downcasts (02 §11.5c #3): D's `cast(TypeAArray)tparam` is
                        // proved by the `tparam.ty == Taarray` test on the preceding line, and
                        // `cast(TypeIdentifier)taai` by the `taai.ty == Tident` test on this one.
                        && (taai = (tparam as unknown as TypeAArray).index!).ty === TY.Tident
                        && (taai as unknown as TypeIdentifier).idents.length === 0))) {
                // Consider compile-time known boundaries
                sarrayOf(nextOf(e.type!)!, BigInt(e.len)).accept(this);
                return;
            }
            this.visitExpression(e);
        }

        override visitArrayLiteralExp(e: ArrayLiteralExp): void {
            // https://issues.dlang.org/show_bug.cgi?id=20092
            if (nextOf(toBasetype(e.type!))!.ty === TY.Tvoid && tparam!.ty === TY.Tarray) {
                // tparam:T[] <- e:[] (void[])
                this.result = this.deduceEmptyArrayElement();
                return;
            }

            if (tparam!.ty === TY.Tarray && e.elements !== null && e.elements.length !== 0) {
                // `cast(TypeDArray)tparam` — proved by `tparam.ty == Tarray` above (02 §11.5c #3).
                const tn = (tparam as unknown as TypeDArray).next;
                this.result = MATCH.exact;
                if (e.basis !== null) {
                    const m = deduceType(e.basis, sc, tn, parameters, dedtypes, wm);
                    if (m < this.result)
                        this.result = m;
                }
                for (const el of e.elements) {
                    if (this.result === MATCH.nomatch)
                        break;
                    if (el === null)
                        continue;
                    const m = deduceType(el, sc, tn, parameters, dedtypes, wm);
                    if (m < this.result)
                        this.result = m;
                }
                return;
            }

            let taai: Type | null = null;
            if (e.type!.ty === TY.Tarray
                && (tparam!.ty === TY.Tsarray
                    || (tparam!.ty === TY.Taarray
                        // tag-proved RTTI downcasts (02 §11.5c #3): D's `cast(TypeAArray)tparam` is
                        // proved by the `tparam.ty == Taarray` test on the preceding line, and
                        // `cast(TypeIdentifier)taai` by the `taai.ty == Tident` test on this one.
                        && (taai = (tparam as unknown as TypeAArray).index!).ty === TY.Tident
                        && (taai as unknown as TypeIdentifier).idents.length === 0))) {
                // Consider compile-time known boundaries
                sarrayOf(nextOf(e.type!)!, BigInt(e.elements!.length)).accept(this);
                return;
            }
            this.visitExpression(e);
        }

        override visitAssocArrayLiteralExp(e: AssocArrayLiteralExp): void {
            if (tparam!.ty === TY.Taarray && e.keys !== null && e.keys.length !== 0) {
                // `cast(TypeAArray)tparam` — proved by `tparam.ty == Taarray` above (02 §11.5c #3).
                const taa = tparam as unknown as TypeAArray;
                this.result = MATCH.exact;
                for (const [i, key] of e.keys.opSlice().entries()) {
                    const m1 = deduceType(key!, sc, taa.index, parameters, dedtypes, wm);
                    if (m1 < this.result)
                        this.result = m1;
                    if (this.result === MATCH.nomatch)
                        break;
                    const m2 = deduceType(e.values!.opIndex(i)!, sc, taa.next, parameters, dedtypes, wm);
                    if (m2 < this.result)
                        this.result = m2;
                    if (this.result === MATCH.nomatch)
                        break;
                }
                return;
            }
            this.visitExpression(e);
        }

        override visitFuncExp(e: FuncExp): void {
            //printf("e.type = %s, tparam = %s\n", e.type.toChars(), tparam.toChars());
            if (e.td !== null) {
                const to = tparam!;
                if (nextOf(to) === null)
                    return;
                const tof = nextOf(to)!.isTypeFunction();
                if (tof === null)
                    return;

                // Parameter types inference from 'tof'
                assert(e.td._scope !== null);
                const tf = e.fd!.type!.isTypeFunction()!;
                //printf("\ttof = %s\n", tof.toChars());
                //printf("\ttf  = %s\n", tf.toChars());
                const dim = tf.parameterList.length();

                if (tof.parameterList.varargs !== tf.parameterList.varargs)
                    return;

                // https://github.com/dlang/dmd/issues/19905
                // Resolve and expand TypeTuples (e.g. from AliasSeq) in tof's parameters
                // before comparing counts. We can't call TypeFunction.typeSemantic because
                // the return type may contain unresolved template parameters.
                let expandedTypes: Types | null = null;
                // D: `foreach (pto; *tof.parameterList.parameters)` (templatesem.d:7705) and
                // `foreach (arg; *tt.arguments)` (:7718) — POINTER dereferences; `!` marks the
                // fault point D has (02 §10.1), never `?? []`.
                for (const pto of tof.parameterList.parameters!) {
                    let pt = pto!.type!;
                    if (!reliesOnTemplateParameters(pt, parameters.opSlice(inferStart, parameters.length))) {
                        pt = typeSemantic(pt.syntaxCopy(), e.loc, sc);
                        if (pt.ty === TY.Terror)
                            return;
                    }
                    const tt = pt.isTypeTuple();
                    if (tt !== null) {
                        if (expandedTypes === null)
                            expandedTypes = new DArray<Type | null>();
                        for (const arg of tt.arguments!)
                            expandedTypes.push(arg!.type);
                    } else {
                        if (expandedTypes === null)
                            expandedTypes = new DArray<Type | null>();
                        expandedTypes.push(pt);
                    }
                }

                if (expandedTypes === null || expandedTypes.length !== dim)
                    return;

                const tiargs: Objects = new DArray<RootObject | null>();
                tiargs.reserve(e.td.parameters!.length);

                for (const tp of e.td.parameters!) {
                    let u = 0;
                    tf.parameterList.opApply((_i: number, p: Parameter): number => {
                        // tag-proved RTTI downcast (02 §11.5c #3): D's `cast(TypeIdentifier)p.type`,
                        // proved by the `p.type.ty == Tident` test on the same expression.
                        if (p.type!.ty === TY.Tident
                            && (p.type as unknown as TypeIdentifier).ident === tp!.ident)
                            return 1; // D `break`
                        ++u;
                        return 0;
                    });
                    assert(u < dim);
                    let t = expandedTypes.opIndex(u);
                    if (t === null)
                        break;
                    if (reliesOnTemplateParameters(t, parameters.opSlice(inferStart, parameters.length)))
                        return;
                    // https://issues.dlang.org/show_bug.cgi?id=11774
                    t = t.syntaxCopy();
                    // D `!t.deco` (templatesem.d:7752) — pointer test, plain null form.
                    if (t.deco === null) {
                        t = typeSemantic(t, e.loc, sc);
                        if (t.ty === TY.Terror)
                            return;
                    }
                    tiargs.push(t);
                }

                // Set target of return type inference
                if (tf.next === null && tof.next !== null)
                    e.fd!.treq = tparam;

                const ti = TemplateInstance.fromTemplateDeclaration(e.loc, e.td, tiargs);
                const ex = expressionSemantic(new ScopeExp(e.loc, ti), e.td._scope);

                // Reset inference target for the later re-semantic
                e.fd!.treq = null;

                if (ex.op === EXP.error)
                    return;
                if (ex.op !== EXP.function_)
                    return;
                // D `visit(ex.type)` — the STATIC type of `ex.type` is `Type`, so D picks the
                // `visit(Type)` overload, not a dynamic re-dispatch (13 §1/§4).
                this.visitType(ex.type!);
                return;
            }

            let t = e.type!;

            if (t.ty === TY.Tdelegate && tparam!.ty === TY.Tpointer)
                return;

            // Allow conversion from implicit function pointer to delegate
            if (e.tok === TOK.reserved && t.ty === TY.Tpointer && tparam!.ty === TY.Tdelegate) {
                const tf = nextOf(t)!.isTypeFunction()!;
                t = merge(new TypeDelegate(tf));
            }
            //printf("tparam = %s <= e.type = %s, t = %s\n", tparam.toChars(), e.type.toChars(), t.toChars());
            // D `visit(t)` — `t`'s static type is `Type` (13 §1/§4).
            this.visitType(t);
        }

        override visitSliceExp(e: SliceExp): void {
            let taai: Type | null = null;
            if (e.type!.ty === TY.Tarray
                && (tparam!.ty === TY.Tsarray
                    || (tparam!.ty === TY.Taarray
                        // tag-proved RTTI downcasts (02 §11.5c #3): D's `cast(TypeAArray)tparam` is
                        // proved by the `tparam.ty == Taarray` test on the preceding line, and
                        // `cast(TypeIdentifier)taai` by the `taai.ty == Tident` test on this one.
                        && (taai = (tparam as unknown as TypeAArray).index!).ty === TY.Tident
                        && (taai as unknown as TypeIdentifier).idents.length === 0))) {
                // Consider compile-time known boundaries
                const tsa = toStaticArrayType(e);
                if (tsa !== null) {
                    tsa.accept(this);
                    if (this.result > MATCH.convert)
                        this.result = MATCH.convert; // match with implicit conversion at most
                    return;
                }
            }
            this.visitExpression(e);
        }

        override visitCommaExp(e: CommaExp): void {
            e.e2!.accept(this);
        }
    }

    const v = new DeduceType();
    const t = isType(o);
    if (t !== null)
        t.accept(v);
    else {
        const e = isExpression(o);
        if (e !== null) {
            assert(wm !== null);
            e.accept(v);
        } else
            assertUnreachable();
    }
    return v.result;
}

/* Helper for TypeClass.deduceType().
 * Classes can match with implicit conversion to a base class or interface.
 * This is complicated, because there may be more than one base class which
 * matches. In such cases, one or more parameters remain ambiguous.
 * For example,
 *
 *   interface I(X, Y) {}
 *   class C : I(uint, double), I(char, double) {}
 *   C x;
 *   foo(T, U)( I!(T, U) x)
 *
 *   deduces that U is double, but T remains ambiguous (could be char or uint).
 *
 * Given a baseclass b, and initial deduced types 'dedtypes', this function
 * tries to match tparam with b, and also tries all base interfaces of b.
 * If a match occurs, numBaseClassMatches is incremented, and the new deduced
 * types are ANDed with the current 'best' estimate for dedtypes.
 */
// D module-private. `ref BaseClass b` / `ref Objects` are struct/container ALIASES (03 §3.2);
// `ref int numBaseClassMatches` is written by the callee, so it travels as a box (03 §3.3).
function deduceBaseClassParameters(b: BaseClass, sc: Scope | null, tparam: Type,
    parameters: TemplateParameters, dedtypes: Objects, best: Objects,
    numBaseClassMatches: Ref<number>): void {
    const parti = b.sym !== null ? b.sym.parent!.isTemplateInstance() : null;
    if (parti !== null) {
        // Make a temporary copy of dedtypes so we don't destroy it.
        // D `memcpy(tmpdedtypes.tdata(), dedtypes.tdata(), …)` fills a FRESH container, so the slots
        // are assigned element-wise (08 §5 container substitution; no `memcpy` shim exists).
        const tmpdedtypes: Objects = new DArray<RootObject | null>(dedtypes.length);
        for (let k = 0; k < dedtypes.length; k++)
            tmpdedtypes.opIndexAssign(dedtypes.opIndex(k), k);

        const t = new TypeInstance(Loc.initial, parti);
        const m = deduceType(t, sc, tparam, parameters, tmpdedtypes);
        if (m > MATCH.nomatch) {
            // If this is the first ever match, it becomes our best estimate
            if (numBaseClassMatches.value === 0) {
                // Overwrites the CALLER's `best` in place — its identity must survive
                // (03 in-place value-overwrite), so the slots are assigned, never the reference.
                for (let k = 0; k < tmpdedtypes.length; k++)
                    best.opIndexAssign(tmpdedtypes.opIndex(k), k);
            } else
                for (let k = 0; k < tmpdedtypes.length; ++k) {
                    // If we've found more than one possible type for a parameter,
                    // mark it as unknown.
                    if (tmpdedtypes.opIndex(k) !== best.opIndex(k))
                        best.opIndexAssign(dedtypes.opIndex(k), k);
                }
            ++numBaseClassMatches.value;
        }
    }

    // Now recursively test the inherited interfaces
    for (const bi of b.baseInterfaces) {
        deduceBaseClassParameters(bi, sc, tparam, parameters, dedtypes, best, numBaseClassMatches);
    }
}

// D module-private; called from chunk 2 (dmd:4655, :5040, :5085).
export function rootObjectsEqual(o1: RootObject, o2: RootObject): boolean {
    const d = o1.dyncast();
    if (d !== o2.dyncast())
        return false;
    // resolved (07 §6): `bool check(T)(RootObject id1, RootObject id2)` (dmd/templatesem.d:7888) is a
    // CT template with exactly THREE instantiations — `check!Expression`, `check!Dsymbol`,
    // `check!Type` — so it is monomorphized into its three arms below. No generic is emitted.
    // Each `cast(T)` is the tag-proved RTTI downcast whose proof is the `d`/`dyncast()` compare that
    // selected the arm (02 §11.5c #3).
    switch (d) { // D `with (DYNCAST) final switch(d)` -> labels re-qualified (06 §3.3)
        case DYNCAST.expression:
            return expressionEquals(o1 as unknown as Expression, o2 as unknown as Expression);
        case DYNCAST.dsymbol:
            return dsymbolEquals(o1 as unknown as Dsymbol, o2 as unknown as Dsymbol);
        case DYNCAST.type:
            return (o1 as unknown as Type).equals(o2 as unknown as Type);
        case DYNCAST.identifier: //return check!Identifier(o1, o2); // Identifier.equals checks `o1 is o2`
        case DYNCAST.object:
        case DYNCAST.tuple:
        case DYNCAST.parameter:
        case DYNCAST.statement:
        case DYNCAST.condition:
        case DYNCAST.templateparameter:
        case DYNCAST.initializer:
            return o1 === o2;
        default: { // D `final switch` exhaustiveness (06 §3.2)
            const _e: never = d;
            throw new SwitchError(_e);
        }
    }
}

/*
 * Handle tuple matching for function parameters.
 * If the last parameter of `tp` is a template tuple parameter,
 * collect the corresponding argument types from `t`.
 * Params:
 *     t          = actual function type
 *     tp         = template function type
 *     parameters = template parameters
 *     dedtypes   = deduced types array
 *     nfargs     = number of arguments in `t`
 *     nfparams   = number of parameters in `tp` (updated on success)
 * Returns: `true` on success, `false` on mismatch.
 */
// D module-private. `ref size_t nfparams` is DECREMENTED at dmd:7970, so it travels as a box
// (03 §3.3) — every read/write below goes through `.value`.
function deduceFunctionTuple(t: TypeFunction, tp: TypeFunction,
    parameters: TemplateParameters, dedtypes: Objects,
    nfargs: number, nfparams: Ref<number>): boolean {
    if (nfparams.value === 0 || nfargs < nfparams.value - 1)
        return nfargs === nfparams.value;

    const fparam = tp.parameterList.opIndex(nfparams.value - 1);
    assert(fparam !== null && fparam.type !== null);
    if (fparam.type!.ty !== TY.Tident)
        return nfargs === nfparams.value;

    const tid = fparam.type!.isTypeIdentifier()!;
    if (tid.idents.length !== 0)
        return nfargs === nfparams.value;

    let tupi = 0;
    for (; tupi < parameters.length; ++tupi) {
        const tx = parameters.opIndex(tupi)!;
        const tup = tx.isTemplateTupleParameter();
        if (tup !== null && tup.ident!.equals(tid.ident!))
            break;
    }
    if (tupi === parameters.length)
        return nfargs === nfparams.value;

    const tuple_dim = nfargs - (nfparams.value - 1);

    const o = dedtypes.opIndex(tupi);
    if (o !== null) {
        const tup = isTuple(o);
        if (tup === null || tup.objects.length !== tuple_dim)
            return false;
        for (let i = 0; i < tuple_dim; ++i) {
            if (!rootObjectsEqual(t.parameterList.opIndex(nfparams.value - 1 + i)!.type!,
                                  tup.objects.opIndex(i)!))
                return false;
        }
    } else {
        const tup = new Tuple(tuple_dim);
        for (let i = 0; i < tuple_dim; ++i)
            tup.objects.opIndexAssign(t.parameterList.opIndex(nfparams.value - 1 + i)!.type, i);
        dedtypes.opIndexAssign(tup, tupi);
    }
    --nfparams.value; // ignore tuple parameter for further deduction
    return true;
}

/********************
 * Match template `parameters` to the target template instance.
 * Example:
 *    struct Temp(U, int Z) {}
 *    void foo(T)(Temp!(T, 3));
 *    foo(Temp!(int, 3)());
 * Input:
 *    sc               = context
 *    parameters       = template params of foo -> [T]
 *    tiargs           = <Temp!(int, 3)>.tiargs  -> [int, 3]
 *    tdtypes          = <Temp!(int, 3)>.tdtypes -> [int, 3]
 *    tempdecl         = <struct Temp!(T, int Z)> -> [T, Z]
 *    tp               = <Temp!(T, 3)>
 * Output:
 *    dedtypes         = deduced params of `foo(Temp!(int, 3)())` -> [int]
 *
 * GOTO LATTICE (06 §4): `Le:` (dmd:8094), `L1:` (dmd:8131) and `Ls:` (dmd:8144) are label blocks
 * inside the loop body. `Le` and `L1` are MUTUALLY reachable (dmd:8107 `goto L1`, dmd:8136
 * `goto Le`), so per 04 §5 both are hoisted `function` declarations (neither touches `this`); each
 * returns "keep going" (true) or "return false from the enclosing call".
 */
// D module-private.
function resolveTemplateInstantiation(sc: Scope | null, parameters: TemplateParameters | null,
    tiargs: Objects | null, tdtypes: Objects | null, tempdecl: TemplateDeclaration,
    tp: TypeInstance, dedtypes: Objects | null): boolean {
    for (let i = 0; ; i++) {
        //printf("\ttest: tempinst.tiargs[%zu]\n", i);
        let o1: RootObject | null = null;
        if (i < tiargs!.length)
            o1 = tiargs!.opIndex(i);
        else if (i < tdtypes!.length && i < tp.tempinst!.tiargs!.length) {
            // Pick up default arg
            o1 = tdtypes!.opIndex(i);
        } else if (i >= tp.tempinst!.tiargs!.length)
            break;
        //printf("\ttest: o1 = %s\n", o1.toChars());
        if (i >= tp.tempinst!.tiargs!.length) {
            const dim = tempdecl.parameters!.length - (tempdecl.isVariadic() !== null ? 1 : 0);
            while (i < dim && (tempdecl.parameters!.opIndex(i)!.dependent
                               || tempdecl.parameters!.opIndex(i)!.hasDefaultArg())) {
                i++;
            }
            if (i >= dim)
                break; // match if all remained parameters are dependent
            return false;
        }

        let o2: RootObject | null = tp.tempinst!.tiargs!.opIndex(i);
        let t2 = isType(o2);
        //printf("\ttest: o2 = %s\n", o2.toChars());
        let j = (t2 !== null && t2.ty === TY.Tident && i === tp.tempinst!.tiargs!.length - 1)
            ? templateParameterLookup(t2, parameters) : IDX_NOTFOUND;
        if (j !== IDX_NOTFOUND && j === parameters!.length - 1 &&
            parameters!.opIndex(j)!.isTemplateTupleParameter() !== null) {
            /* Given:
                 *  struct A(B...) {}
                 *  alias A!(int, float) X;
                 *  static if (is(X Y == A!(Z), Z...)) {}
                 * deduce that Z is a tuple(int, float)
                 */

            /* Create tuple from remaining args
                 */
            const vtdim = (tempdecl.isVariadic() !== null ? tiargs!.length : tdtypes!.length) - i;
            const vt = new Tuple(vtdim);
            for (let k = 0; k < vtdim; k++) {
                let o: RootObject | null;
                if (k < tiargs!.length)
                    o = tiargs!.opIndex(i + k);
                else // Pick up default arg
                    o = tdtypes!.opIndex(i + k);
                vt.objects.opIndexAssign(o, k);
            }

            // tag-proved RTTI downcast (02 §11.5c #3): D's `cast(Tuple)(*dedtypes)[j]`; the adjacent
            // DYNCAST compare IS the proof — and it is exactly what dtemplate's own `isTuple` does.
            const dv = dedtypes!.opIndex(j);
            const v: Tuple | null =
                (dv !== null && dv.dyncast() === DYNCAST.tuple) ? (dv as unknown as Tuple) : null;
            if (v !== null) {
                if (!match(v, vt))
                    return false;
            } else
                dedtypes!.opIndexAssign(vt, j);
            break;
        } else if (o1 === null)
            break;

        const t1 = isType(o1);
        const s1 = isDsymbol(o1);
        let s2 = isDsymbol(o2);
        // §F.3 rename: BOTH `getValue` overloads appear on this one D line (dmd:8063).
        let e1 = s1 !== null ? getValueFromDsymbol(s1) : getValueFromExpression(isExpression(o1));
        let e2 = isExpression(o2);
        // resolved: version (none) -> OFF; the t1/t2/e1/e2/s1/s2/v1/v2 dump
        // (dmd/templatesem.d:8065-8085) is dropped (07 §1).

        // Le: — dmd/templatesem.d:8094. Reached by fall-through from the `e1 && e2` arm and by
        // `goto Le` (dmd:8136, from inside L1).
        function Le(): boolean {
            e1 = ctfeInterpret(e1!);

            /* If it is one of the template parameters for this template,
                 * we should not attempt to interpret it. It already has a value.
                 */
            if (e2!.op === EXP.variable && (e2!.isVarExp()!.var_!.storage_class & STC.templateparameter) !== 0n) {
                /*
                     * (T:Number!(e2), int e2)
                     */
                j = templateIdentifierLookup(e2!.isVarExp()!.var_!.ident!, parameters);
                if (j !== IDX_NOTFOUND)
                    return L1(); // goto L1 (dmd/templatesem.d:8107)
                // The template parameter was not from this template
                // (it may be from a parent template, for example)
            }

            e2 = expressionSemantic(e2!, sc!); // https://issues.dlang.org/show_bug.cgi?id=13417
            e2 = ctfeInterpret(e2);

            //printf("e1 = %s, type = %s %d\n", e1.toChars(), e1.type.toChars(), e1.type.ty);
            //printf("e2 = %s, type = %s %d\n", e2.toChars(), e2.type.toChars(), e2.type.ty);
            if (!expressionEquals(e1!, e2!)) {
                if (implicitConvTo(e2!, e1!.type!) === MATCH.nomatch)
                    return false;

                e2 = implicitCastTo(e2!, sc, e1!.type!);
                e2 = ctfeInterpret(e2);
                if (!expressionEquals(e1!, e2!))
                    return false;
            }
            return true;
        }

        // L1: — dmd/templatesem.d:8131. Reached by fall-through from the `e1 && t2 && Tident` arm
        // and by `goto L1` (dmd:8107, from inside Le).
        function L1(): boolean {
            if (j === IDX_NOTFOUND) {
                // D `t2.resolve((cast(TypeIdentifier)t2).loc, sc, e2, t2, s2)` — three `out` params,
                // reset on entry, copied back into the loop's locals.
                const peBox: Ref<Expression | null> = { value: null };
                const ptBox: Ref<Type | null> = { value: null };
                const psBox: Ref<Dsymbol | null> = { value: null };
                // tag-proved RTTI downcast (02 §11.5c #3): the enclosing arm tested `t2.ty == Tident`.
                resolve(t2!, (t2 as unknown as TypeIdentifier).loc, sc, peBox, ptBox, psBox);
                e2 = peBox.value;
                t2 = ptBox.value;
                s2 = psBox.value;
                if (e2 !== null)
                    return Le(); // goto Le (dmd/templatesem.d:8136)
                return false;
            }
            if (matchArgFromObject(parameters!.opIndex(j)!, sc!, e1, j, parameters!, dedtypes!, null) === MATCH.nomatch)
                return false;
            return true;
        }

        // Ls: — dmd/templatesem.d:8144. Reached by fall-through from the `s1 && s2` arm and by
        // `goto Ls` (dmd:8155).
        function Ls(): boolean {
            if (!dsymbolEquals(s1!, s2))
                return false;
            return true;
        }

        if (t1 !== null && t2 !== null) {
            if (deduceType(t1, sc, t2, parameters!, dedtypes!) === MATCH.nomatch)
                return false;
        } else if (e1 !== null && e2 !== null) {
            if (!Le()) // fall-through INTO `Le:` (dmd/templatesem.d:8094)
                return false;
        } else if (e1 !== null && t2 !== null && t2.ty === TY.Tident) {
            j = templateParameterLookup(t2, parameters);
            if (!L1()) // fall-through INTO `L1:` (dmd/templatesem.d:8131)
                return false;
        } else if (s1 !== null && s2 !== null) {
            if (!Ls()) // fall-through INTO `Ls:` (dmd/templatesem.d:8144)
                return false;
        } else if (s1 !== null && t2 !== null && t2.ty === TY.Tident) {
            j = templateParameterLookup(t2, parameters);
            if (j === IDX_NOTFOUND) {
                const peBox: Ref<Expression | null> = { value: null };
                const ptBox: Ref<Type | null> = { value: null };
                const psBox: Ref<Dsymbol | null> = { value: null };
                // tag-proved RTTI downcast (02 §11.5c #3): the arm tested `t2.ty == Tident`.
                resolve(t2, (t2 as unknown as TypeIdentifier).loc, sc, peBox, ptBox, psBox);
                e2 = peBox.value;
                t2 = ptBox.value;
                s2 = psBox.value;
                if (s2 !== null) {
                    if (!Ls()) // goto Ls (dmd/templatesem.d:8155)
                        return false;
                } else
                    return false;
            } else if (matchArgFromObject(parameters!.opIndex(j)!, sc!, s1, j, parameters!, dedtypes!, null) === MATCH.nomatch)
                return false;
        } else
            return false;
    }
    return true;
}

// §F.3 rename of the `getValue(ref Dsymbol s)` overload (dmd/templatesem.d:8167). D module-private,
// but reached from chunk 1 through `getExpression` (dmd:565, :2290). The `ref` parameter is never
// written by the body, so it is passed as a plain reference (03 §3.2) — no box.
export function getValueFromDsymbol(s: Dsymbol | null): Expression | null {
    if (s !== null) {
        const v = s.isVarDeclaration();
        if (v !== null) {
            if ((v.storage_class & STC.manifest) !== 0n)
                return getConstInitializer(v);
        }
    }
    return null;
}

/***********************
 * Try to get value from manifest constant
 */
// §F.3 rename of the `getValue(Expression e)` overload (dmd/templatesem.d:8183). D module-private.
export function getValueFromExpression(e: Expression | null): Expression | null {
    if (e === null)
        return null;
    const ve = e.isVarExp();
    if (ve !== null) {
        const v = ve.var_!.isVarDeclaration();
        if (v !== null) {
            if ((v.storage_class & STC.manifest) !== 0n) {
                e = getConstInitializer(v);
            }
        }
    }
    return e;
}

// D module-private; called from chunk 1 (dmd:565, :2290). D's leading-dot `.getValue(s)` is
// module-scope qualification (not a different function) -> the Dsymbol form, §F.3.
export function getExpression(o: RootObject | null): Expression | null {
    const s = isDsymbol(o);
    return s !== null ? getValueFromDsymbol(s) : getValueFromExpression(isExpression(o));
}
