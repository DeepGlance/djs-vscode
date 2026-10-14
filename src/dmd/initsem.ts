// Ported from dmd/initsem.d (module dmd.initsem) — "Semantic analysis of initializers."
//
// WHOLE-FILE translation of the 6 top-level declarations (initsem.d:58 `toAssocArrayLiteral`,
// :105 `initializerSemantic`, :1221 `inferType`, :1370 `initializerToExpression`,
// :1602 `hasNonConstPointers` (D module-private), :1689 `resolveStructLiteralNamedArgs`).
// Every one is a D FREE FUNCTION and is emitted here as a free function (04 §6 anti-pattern: a
// UFCS free function is never promoted to a method on the receiver class).
//
// IDIOM CENSUS (13 §7, mandatory precondition — run before emitting anything):
//   `grep -c 'class .*Visitor' dmd/initsem.d` -> 0.
// So this module uses NEITHER Idiom A (visitor classes) NOR Idiom B (nested functions + a
// hand-written trailing `switch (e.op)`). It uses **Idiom C** (13 §7.6): three of its functions
// declare nested `visitXxx` handlers and drive them through the CTFE-generated dispatch of
// `mixin VisitInitializer!Result visit;` (dmd/init.d:369 + the `visitCase` CTFE string builder,
// init.d:394). Per 13 §7.6 rule 1 the mixin is RESOLVED at translation time and its generated
// `final switch (init.kind)` is emitted INLINE at each `visit.VisitInitializer(init)` call site,
// in FULL (rule 2), with the nested handlers keeping their D names verbatim (rule 4). The
// expansion is identical in shape to the one already emitted in `init.ts` `syntaxCopy` — the
// two `Result = Initializer` instantiations — while `initializerToExpression` is the tree's only
// `Result = Expression` instantiation, so its `Result.init` fall-through is a null EXPRESSION.
//
// GOTOs (06 §4): four `goto` statements, three shapes.
//   - initsem.d:242 `goto default;` inside `visitArray`'s `switch (t.ty)` — SHARED-ARM: the
//     `default:` body ends in `return err();`, so it becomes a signal/result-returning closure
//     (`arrayDefaultArm`) that BOTH the jump site and `default:` itself `return`.
//   - initsem.d:479 / :492 `goto L1;` in `visitExp` — BAIL: the `L1:` tail (:625-:635) only folds
//     the result and returns, so it is a zero-parameter nested arrow (`L1Tail`) declared before
//     its first use, capturing the locals (never positional params).
//   - initsem.d:1427 `goto case Tsarray;` — the TEXTUALLY NEXT arm, so it is JS no-break
//     fallthrough (06 §3.6(a)), commented at the site.
//
// IMPORTC: `import dmd.importc;` (initsem.d:36) is a value import of `arrayFuncConv`, its only use in this file
// (`i.exp.arrayFuncConv(sc)`, :364), placed last (01 §4.8). The many `sc.inCfile` legs are ordinary code.
//
// WALLS (11 §2.5): each deferred callee is walled INLINE at D's own statement position with the D
// file:line, using the single-use named local `(): T` arrow shape (11 §2.5 "wall position vs TS
// narrowing"); nothing is factored into a helper family and no narrower stand-in is substituted.
// The D callees are ported and are called faithfully as free functions (04 §6):
// `ctfeInterpret` (dinterpret.ts, D dinterpret.d:67; :262, :400, :522, :541, :631),
// `toChars(const Initializer)` (hdrgen.ts as `initializerToChars`, D hdrgen.d:212; :65, :866, :1025,
// :1108, :1113, :1202),
// `hasRegularCtor` (expressionsem.ts, D expressionsem.d:1236), `fill` (expressionsem.ts,
// D expressionsem.d:19195), `size(Dsymbol, Loc)` (dsymbolsem.ts as `sizeDsymbol`, D
// dsymbolsem.d:993), `isUnique(FuncDeclaration)` (funcsem.ts, D funcsem.d:408),
// `checkForwardRef` (funcsem.ts, D funcsem.d:1712), `isOverlappedWith` (dsymbolsem.ts,
// D dsymbolsem.d:843), `setUnsafe` (safe.ts, D safe.d:469).
//
// NUMERICS (09): `uinteger_t`/`dinteger_t` stay `bigint` end-to-end (`toInteger`, `size`,
// `SIZE_INVALID`); `uint` counters (`length`, `edim`, `i.dim`) are the `number` domain and every
// `++`/`cast(uint)` on them re-truncates (09 §3). `amax` is a `const(uint)` and is widened to
// bigint at each mixed-domain comparison boundary (09 §5).

import { assert, assertUnreachable, SwitchError } from "../assert.js";
import { ds } from "../dstring.js";
import { error, errorSupplemental } from "./errors.js";
import { EXP, TOK } from "./tokens.js";
import { TY, MATCH, InitKind, Sizeok, LINK } from "./astenums.js";
import { PASS } from "./dsymbol.js";
import { global } from "./globals.js";
import { target } from "./target.js";
import { Id } from "./id.js";
import { Loc } from "./location.js";
import { CTFloat } from "./root/ctfloat.js";
import { Array as DArray } from "./root/array.js";
import {
    AddExp,
    ArrayLiteralExp,
    AssocArrayLiteralExp,
    CallExp,
    DotIdExp,
    ErrorExp,
    FuncExp,
    IntegerExp,
    MulExp,
    RealExp,
    StructLiteralExp,
    StructLiteralExpStageFlags,
    TupleExp,
    WANTvalue,
    isFuncAddress,
    typeDotIdExp,
} from "./expression.js";
import { Type, TypeSArray, TypeFunction, ParameterList, SIZE_INVALID, isSomeChar } from "./mtype.js";
import {
    ArrayInitializer,
    ErrorInitializer,
    ExpInitializer,
    NeedInterpret,
    StructInitializer,
} from "./init.js";
import { CompoundStatement } from "./statement.js";
import { FuncLiteralDeclaration } from "./func.js";
import {
    doCopyOrMove,
    expressionSemantic,
    fill,
    hasRegularCtor,
    resolveProperties,
    toInteger,
} from "./expressionsem.js";
// `checkForwardRef` (funcsem.d:1712) and `isUnique` (funcsem.d:408) are BOTH declared only in
// dmd.funcsem, which initsem.d:31 imports; the same-named `checkForwardRef` in expressionsem.ts is a
// mis-homed duplicate and is NOT what this call site resolves to (04 §6/§6.1).
import { checkForwardRef, isUnique } from "./funcsem.js";
import { optimize } from "./optimize.js";
import { castTo, implicitCastTo, implicitConvTo, toStaticArrayType } from "./dcast.js";
import {
    addMod,
    alignment,
    arrayOf,
    defaultInit,
    hasPointers,
    isIntegral,
    nextOf,
    size,
    toBasetype,
    toDsymbol,
    typeSemantic,
} from "./typesem.js";
import {
    checkDeprecated,
    isOverlappedWith,
    resolveAliasThis,
    search,
    search_correct,
    sizeDsymbol,
    toAlias,
} from "./dsymbolsem.js";
import { search_function } from "./opover.js";
import { initializerToChars, toErrMsg, typeToChars } from "./hdrgen.js";
// last (01 §4.8): safe.ts is a core-SCC module; the value import goes after every other one.
import { setUnsafe } from "./safe.js";
// last (01 §4.8): dinterpret.ts value-imports initsem back and drags the CTFE world (ctfeexpr, constfold).
import { ctfeInterpret } from "./dinterpret.js";
// last (01 §4.8): dmd/initsem.d:36 `import dmd.importc;`. importc.ts value-imports typesem, dcast, dsymbolsem and
// expressionsem, so entering the core SCC through it from an earlier position would make it the entry.
import { arrayFuncConv } from "./importc.js";

import type { DString } from "../dstring.js";
import type { Scope } from "./dscope.js";
import type { AssignExp, Expression } from "./expression.js";
import type { Expressions } from "./arraytypes.js";
import type {
    CInitializer,
    DefaultInitializer,
    Initializer,
    VoidInitializer,
} from "./init.js";
import type { Statement } from "./statement.js";
import type { TypeStruct } from "./mtype.js";
import type { StructDeclaration } from "./dstruct.js";
import type { VarDeclaration } from "./declaration.js";
import type { Identifier } from "./identifier.js";
import type { Dsymbol, ScopeDsymbol } from "./dsymbol.js";

/**
 * dmd/initsem.d:15 — `import core.checkedint;` `mulu`. Unsigned 64-bit multiply with an
 * ACCUMULATING overflow flag (D `ref bool overflow` is only ever OR'd, never cleared).
 * `bigint` domain is mandatory: the product is compared against `amax` and feeds a `%llu`
 * diagnostic, so exactness decides the outcome (09 §8).
 *
 * Declared file-local, matching the existing tree precedent for this same `core.checkedint`
 * helper (typesem.ts:163, lexer.ts:3746) — reported to the integrator as a `src/numeric.ts`
 * candidate rather than a fourth private copy.
 */
function mulu(a: bigint, b: bigint, overflow: { value: boolean }): bigint {
    const product = a * b;
    if (product > 0xFFFF_FFFF_FFFF_FFFFn)
        overflow.value = true; // D accumulates: `overflow |= …`, never clears
    return BigInt.asUintN(64, product);
}

/********************************
 * dmd/initsem.d:58 — `Expression toAssocArrayLiteral(ArrayInitializer ai)`.
 *
 * If possible, convert array initializer to associative array initializer.
 *
 *  Params:
 *     ai = array initializer to be converted
 *
 *  Returns:
 *     The converted associative array initializer or ErrorExp if `ai`
 *     is not an associative array initializer.
 */
export function toAssocArrayLiteral(ai: ArrayInitializer): Expression {
    //printf("ArrayInitializer::toAssocArrayInitializer(%s)\n", ai.toChars());
    //static int i; if (++i == 2) assert(0);

    // initsem.d:63 — `auto no(const char* format, Initializer i)`; nested fn -> inner const arrow
    // (04 §5). D infers `ErrorExp`; typed here at the wider `Expression` every caller returns into.
    const no = (format: DString, i: Initializer): Expression => {
        // initsem.d:65 — `error(i.loc, format, toChars(i))`; `toChars(const Initializer)` (hdrgen.d:212) is
        // `initializerToChars` (04 §1 Form B).
        error(i.loc, format, initializerToChars(i));
        return ErrorExp.get();
    };

    const dim = ai.value.length;
    if (dim === 0) // `if (!dim)` — size_t, number domain (09 §9)
        return no(ds("invalid associative array initializer `%s`, use `null` instead"), ai);

    // Containers are CONSTRUCTED as their alias's element type (08 §3).
    const keys: Expressions = new DArray<Expression | null>(dim);
    const values: Expressions = new DArray<Expression | null>(dim);
    // initsem.d:75 — `foreach (i, iz; ai.value[])`; `[]` is a read-only slice here (08 §2.0).
    for (const [i, iz] of ai.value.opSlice().entries()) {
        assert(iz !== null); // nullable-reference truthiness inside assert (06 §2.7)
        const ev = initializerToExpression(iz); // UFCS `iz.initializerToExpression()` (04 §6)
        if (ev === null)
            return no(ds("invalid value `%s` in initializer"), iz);
        values.opIndexAssign(ev, i); // `(*values)[i] = ev` (05 §7, 08 §2.0c)

        const ei = ai.index.opIndex(i);
        if (ei === null)
            return no(ds("missing key for value `%s` in initializer"), iz);
        keys.opIndexAssign(ei, i);
    }
    return new AssocArrayLiteralExp(ai.loc, keys, values);
}

/******************************************
 * dmd/initsem.d:105 — `Initializer initializerSemantic(Initializer init, Scope* sc, ref Type tx,
 * NeedInterpret needInterpret)`.
 *
 * Perform semantic analysis on init.
 * Params:
 *      init = Initializer AST node
 *      sc = context
 *      tx = type that the initializer needs to become. If tx is an incomplete
 *           type and the initializer completes it, it is updated to be the
 *           complete type. ImportC has incomplete types
 *      needInterpret = if CTFE needs to be run on this,
 *                      such as if it is the initializer for a const declaration
 * Returns:
 *      `Initializer` with completed semantic analysis, `ErrorInitializer` if errors
 *      were encountered
 *
 * `ref Type tx` -> a one-slot box (03 §3.3). NOTE the box is written ONLY where D writes it
 * (:318 and :506) — D keeps its own local `t` and never flushes it back on exit, so a blanket
 * write-back at the end of this function would be a fabricated side effect.
 */
export function initializerSemantic(
    init: Initializer,
    sc: Scope,
    tx: { value: Type },
    needInterpret: NeedInterpret,
): Initializer {
    //printf("initializerSemantic() tx: %p %s\n", tx, tx.toChars());
    if (init.semanticDone)
        return init;

    let t: Type = tx.value;

    // initsem.d:113 — `static Initializer err()`. `static` (no closure) -> plain inner arrow.
    const err = (): Initializer => new ErrorInitializer();

    // initsem.d:118
    const visitVoid = (i: VoidInitializer): Initializer => {
        i.type = t;
        return i;
    };

    // initsem.d:124
    const visitDefault = (i: DefaultInitializer): Initializer => {
        i.type = t;
        return i;
    };

    // initsem.d:130
    const visitError = (i: ErrorInitializer): Initializer => i;

    // initsem.d:135
    const visitStruct = (i: StructInitializer): Initializer => {
        //printf("StructInitializer::semantic(t = %s) %s\n", t.toChars(), i.toChars());
        /* This works by replacing the StructInitializer with an ExpInitializer.
          */
        t = toBasetype(t);
        // initsem.d:141 — declaration in a condition -> hoist + `!== null` test (06 §2.6/§2.7).
        const tsa = t.isTypeSArray();
        if (tsa !== null) {
            const ts = toBasetype(nextOf(tsa)!).isTypeStruct();
            if (ts !== null)
                t = ts;
        }
        const ts = t.isTypeStruct();
        if (ts !== null) {
            const sd: StructDeclaration = ts.sym!;
            // check if the sd has a regular ctor (user defined non-copy ctor)
            // that is not disabled.
            // initsem.d:152 — `sd.hasRegularCtor(true)` is UFCS for the free function at
            // dmd/expressionsem.d:1236 (04 §6).
            if (hasRegularCtor(sd, true)) {
                error(i.loc, ds("Cannot use %s initializer syntax for %s `%s` because it has a constructor"),
                    sd.kind(), sd.kind(), sd.toChars());
                errorSupplemental(i.loc, ds("Use `%s( arguments )` instead of `{ initializers }`"),
                    sd.toChars());
                return err();
            }
            // initsem.d:160 — `sd.size(i.loc)` is UFCS for `size(Dsymbol, Loc)` (dmd/dsymbolsem.d:993),
            // a DIFFERENT family from typesem's `size(Type, Loc)` (04 §6.1); dsymbolsem.ts spells it
            // `sizeDsymbol`. D discards the result here — the call is made for its side effect
            // (it runs semantic on `sd` so `sd.sizeok` becomes meaningful).
            // upcast cascade (02 §11.5): AggregateDeclaration.deferred (Dsymbol) shadows
            // Dsymbol.deferred (bool), so TS rejects the sound StructDeclaration -> Dsymbol upcast.
            sizeDsymbol(sd as unknown as Dsymbol, i.loc);
            if (sd.sizeok !== Sizeok.done)
                return err();

            // initsem.d:164 — `Expression getExp(size_t j, Type fieldType)`.
            const getExp = (j: number, fieldType: Type): Expression => {
                // Convert initializer to Expression `ex`
                // `ref Type tx` of the recursive call -> box (03 §3.3). D's `tm` is not read after
                // the call, so no write-back is emitted.
                const tm: { value: Type } = { value: addMod(fieldType, t.mod) };
                const iz = initializerSemantic(i.value.opIndex(j)!, sc, tm, needInterpret);
                const ex = initializerToExpression(iz, fieldType, sc.inCfile)!;
                if (ex.op !== EXP.error)
                    i.value.opIndexAssign(iz, j);
                return ex;
            };

            const elements = resolveStructLiteralNamedArgs(sd, t, sc, i.loc, i.field.length,
                (j: number) => i.field.opIndex(j), getExp,
                (j: number) => i.value.opIndex(j)!.loc, (j: number) => i.value.opIndex(j)!.loc);
            //Keeping both the getArgLoc and getNameLoc same as i.field doesn't have a .loc value here.
            if (elements === null)
                return err();

            // Make a StructLiteralExp out of elements[]
            const sle = new StructLiteralExp(i.loc, sd, elements, t);
            // initsem.d:182 — `sd.fill(i.loc, *elements, false)` is UFCS for the free function at
            // dmd/expressionsem.d:19195 (04 §6). `*elements` is `ref Expressions` -> ALIAS, no copy
            // (03 §3.2): the callee's `setDim`/element writes must be seen through `elements` here.
            if (!fill(sd, i.loc, elements, false))
                return err();
            sle.type = t;
            const ie = new ExpInitializer(i.loc, sle);
            // `ref Type tx` -> box + write-back into the captured `t` (03 §3.2/§3.3).
            const tRef: { value: Type } = { value: t };
            const r = initializerSemantic(ie, sc, tRef, needInterpret);
            t = tRef.value;
            return r;
        } else if ((t.ty === TY.Tdelegate || t.isPtrToFunction() !== null) && i.value.length === 0) {
            const tok = (t.ty === TY.Tdelegate) ? TOK.delegate_ : TOK.function_;
            /* Rewrite as empty delegate literal { }
             */
            const tf: Type = new TypeFunction(new ParameterList(null), null, LINK.d);
            const fd = new FuncLiteralDeclaration(i.loc, Loc.initial, tf, tok, null);
            fd.fbody = new CompoundStatement(i.loc, new DArray<Statement | null>());
            fd.endloc = i.loc;
            const e: Expression = new FuncExp(i.loc, fd);
            const ie = new ExpInitializer(i.loc, e);
            const tRef: { value: Type } = { value: t };
            const r = initializerSemantic(ie, sc, tRef, needInterpret);
            t = tRef.value;
            return r;
        }
        if (t.ty !== TY.Terror)
            error(i.loc, ds("a struct is not a valid initializer for a `%s`"), t.toChars());
        return err();
    };

    // initsem.d:206
    const visitArray = (i: ArrayInitializer): Initializer => {
        let length: number; // D `uint length;` — number domain (09 §1)
        const amax = 0x80000000; // D `const(uint) amax`
        let errors = false;
        //printf("ArrayInitializer::semantic(%s), ai: %s\n", t.toChars(), toChars(i));
        t = toBasetype(t);
        // initsem.d:248 — the `default:` arm, extracted so the `goto default;` at :242 can reach it
        // (06 §3.6/§4 SHARED-ARM). It ends in an unconditional `return err()`, so both the jump site
        // and `default:` itself RETURN its result — a bare `break; // goto default` would be a lie.
        const arrayDefaultArm = (): Initializer => {
            error(i.loc, ds("cannot use array to initialize `%s`"), t.toChars());
            return err();
        };
        switch (t.ty) {
            case TY.Tsarray:
            case TY.Tarray:
                break;
            case TY.Tvector:
                t = t.isTypeVector()!.basetype!;
                break;
            case TY.Taarray:
            case TY.Tstruct: // consider implicit constructor call
                {
                    let e: Expression | null;
                    // note: MyStruct foo = [1:2, 3:4] is correct code if MyStruct has a this(int[int])
                    if (t.ty === TY.Taarray || i.isAssociativeArray())
                        e = toAssocArrayLiteral(i);
                    else
                        e = initializerToExpression(i);
                    // Bugzilla 13987
                    if (e === null) {
                        error(i.loc, ds("cannot use array to initialize `%s`"), t.toChars());
                        return err();
                    }
                    const ei = new ExpInitializer(e.loc, e);
                    const tRef: { value: Type } = { value: t };
                    const r = initializerSemantic(ei, sc, tRef, needInterpret);
                    t = tRef.value;
                    return r;
                }

            case TY.Tpointer:
                if (nextOf(t)!.isTypeFunction() !== null)
                    return arrayDefaultArm(); // goto default; (dmd/initsem.d:242)
                break;

            case TY.Terror:
                return err();

            default:
                return arrayDefaultArm();
        }
        i.type = t;
        length = 0;
        for (let j = 0; j < i.index.length; j++) { // don't replace with foreach; j is modified
            let idx = i.index.opIndex(j);
            if (idx !== null) {
                sc = sc.startCTFE();
                try {
                    idx = expressionSemantic(idx, sc);
                } finally {
                    // The `!` is a NARROWING artifact, not a D fault site: `endCTFE()`/`pop()` return
                    // the pushed scope's `enclosing`, i.e. the `sc` we came in with, non-null because
                    // the port spells this parameter non-null (02 §10.1). The try/finally is NOT in D:
                    // `expressionSemantic` is a partial port whose walls throw, and a throw out of this
                    // region would leave `sc` pointing at the dead CTFE scope (11 §2.5 "walls add exit
                    // paths D does not have — protect paired state").
                    sc = sc.endCTFE()!;
                }
                idx = ctfeInterpret(idx);
                i.index.opIndexAssign(idx, j);
                // `uinteger_t`: the signed carrier read unsigned, so a negative index is a huge one (09 §0, §3.1)
                const idxvalue: bigint = BigInt.asUintN(64, toInteger(idx));
                if (idxvalue >= BigInt(amax)) { // widen the `uint` comparand at the boundary (09 §5)
                    error(i.loc, ds("array index %llu overflow"), idxvalue);
                    errors = true;
                }
                // `cast(uint)idxvalue` — mask to 32 bits, unsigned (09 §2). The result is in the
                // `uint`/number domain, not the bigint sentinel domain.
                length = Number(BigInt.asUintN(32, idxvalue));
                if (idx.op === EXP.error)
                    errors = true;
            }
            let val: Initializer = i.value.opIndex(j)!;
            let ei = val.isExpInitializer();
            if (ei !== null && idx === null)
                ei.expandTuples = true;
            const tn = nextOf(t);
            // `ref Type tx` -> box + write-back (03 §3.3); D's `tn` is a fresh local per iteration.
            const tnRef: { value: Type } = { value: tn! };
            val = initializerSemantic(val, sc, tnRef, needInterpret);
            if (val.isErrorInitializer() !== null)
                errors = true;
            ei = val.isExpInitializer();
            // found a tuple, expand it
            if (ei !== null && ei.exp!.op === EXP.tuple) {
                const te = ei.exp!.isTupleExp()!;
                i.index.remove(j);
                i.value.remove(j);
                for (const [k, e] of te.exps!.opSlice().entries()) {
                    // `insertOne` is the explicit single-element overload: a bare `insert(idx, null)`
                    // would bind the `Array<T> | null` overload and silently no-op (08 §2.2).
                    i.index.insertOne(j + k, null); // `cast(Expression)null`
                    i.value.insertOne(j + k, new ExpInitializer(e!.loc, e));
                }
                j--;
                continue;
            } else {
                i.value.opIndexAssign(val, j);
            }
            // `++length` on a `uint` — JS numbers do not wrap, so re-truncate (09 §3).
            length = (length + 1) >>> 0;
            if (length === 0) {
                error(i.loc, ds("array dimension overflow"));
                return err();
            }
            if (length > i.dim)
                i.dim = length;
        }
        // initsem.d:310 — declaration in a condition -> hoist (06 §2.6).
        let tsa = t.isTypeSArray();
        if (tsa !== null) {
            if (sc.inCfile && tsa.isIncomplete()) {
                // Change to array of known length
                const tn = toBasetype(tsa.next!);
                tsa = new TypeSArray(tn, new IntegerExp(Loc.initial, BigInt(i.dim), Type.tsize_t));
                tx.value = tsa;  // rewrite caller's type
                i.type = tsa;    // remember for later passes
            } else {
                const edim: bigint = toInteger(tsa.dim!); // `ulong edim`
                if (BigInt(i.dim) > edim) {
                    error(i.loc, ds("array initializer has %u elements, but array length is %llu"), i.dim, edim);
                    return err();
                }
            }
        }
        if (errors)
            return err();

        const sz: bigint = size(nextOf(t)!); // typesem's `size(Type, Loc = Loc.initial)` (04 §6.1)
        if (sz === SIZE_INVALID)
            return err();
        const overflow: { value: boolean } = { value: false }; // D `bool overflow;` -> `ref` box
        const max = mulu(BigInt(i.dim), sz, overflow);
        if (overflow.value || max >= BigInt(amax)) {
            error(i.loc, ds("array dimension %llu exceeds max of %llu"), BigInt(i.dim), BigInt(amax) / sz);
            return err();
        }
        //printf("returns ai: %s\n", i.toChars());
        return i;
    };

    // initsem.d:347
    const visitExp = (i: ExpInitializer): Initializer => {
        //printf("ExpInitializer::semantic(%s), type = %s\n", i.exp.toChars(), t.toChars());
        if (needInterpret !== NeedInterpret.INITnointerpret) // enum truthiness (09 §9.1)
            sc = sc.startCTFE();
        try {
            i.exp = expressionSemantic(i.exp!, sc);
            i.exp = resolveProperties(sc, i.exp);
        } finally {
            // try/finally is NOT in D — it protects the start/endCTFE pair against the extra exit
            // paths this port's walls introduce (11 §2.5). `!` is a narrowing artifact (see :259).
            if (needInterpret !== NeedInterpret.INITnointerpret)
                sc = sc.endCTFE()!;
        }
        if (i.exp.op === EXP.error)
            return err();
        const olderrors = global.errors;

        /* ImportC: convert arrays to pointers, functions to pointers to functions
         */
        const tb = toBasetype(t);
        // dmd/initsem.d:364 — `i.exp = i.exp.arrayFuncConv(sc);`
        if (tb.isTypePointer() !== null)
            i.exp = arrayFuncConv(i.exp, sc);

        /* Save the expression before ctfe
         * Otherwise the error message would contain for example "&[0][0]" instead of "new int"
         * Regression: https://issues.dlang.org/show_bug.cgi?id=21687
         */
        const currExp = i.exp;
        if (needInterpret !== NeedInterpret.INITnointerpret) {
            // If the result will be implicitly cast, move the cast into CTFE
            // to avoid premature truncation of polysemous types.
            // eg real [] x = [1.1, 2.2]; should use real precision.
            if (implicitConvTo(i.exp, t) !== MATCH.nomatch && !sc.inCfile) {
                i.exp = implicitCastTo(i.exp, sc, t);
            }
            if (!global.gag && olderrors !== global.errors) {
                return i;
            }
            if (sc.inCfile) {
                /* the interpreter turns (char*)"string" into &"string"[0] which then
                 * it cannot interpret. Resolve that case by doing optimize() first
                 */
                i.exp = optimize(i.exp, WANTvalue);
                if (i.exp.isSymOffExp() !== null) {
                    /* `static variable cannot be read at compile time`
                     * https://issues.dlang.org/show_bug.cgi?id=22513
                     * Maybe this would be better addressed in ctfeInterpret()?
                     */
                    needInterpret = NeedInterpret.INITnointerpret;
                }
            }
            if (needInterpret !== NeedInterpret.INITnointerpret) {
                i.exp = ctfeInterpret(i.exp);
            }
            if (i.exp.op === EXP.voidExpression) {
                error(i.loc, ds("variables cannot be initialized with an expression of type `void`"));
                errorSupplemental(i.loc, ds("only `= void;` is allowed, which prevents default initialization"));
            }
        } else {
            i.exp = optimize(i.exp, WANTvalue);
        }

        if (!global.gag && olderrors !== global.errors) {
            return i; // Failed, suppress duplicate error messages
        }
        if (i.exp.type!.isTypeTuple() !== null && i.exp.type!.isTypeTuple()!.arguments!.length === 0) {
            const et = i.exp.type!;
            i.exp = TupleExp.fromExps(i.exp.loc, new DArray<Expression | null>());
            i.exp.type = et;
        }
        if (i.exp.op === EXP.type) {
            error(i.exp.loc, ds("initializer must be an expression, not `%s`"), i.exp.toChars());
            // If the error location differs from the initializer location, show where it was used
            if (!i.exp.loc.opEquals(i.loc)) // struct `!=` -> `!a.opEquals(b)` (05 §2)
                errorSupplemental(i.loc, ds("used in initialization here"));
            // If the type is a struct or class, suggest adding () to construct an instance
            const ts = i.exp.type!.isTypeStruct();
            if (ts !== null) {
                // Check if the struct can be default-constructed (no required args)
                if (!ts.sym!.hasCopyCtor && (ts.sym!.ctor === null || ts.sym!.defaultCtor !== null))
                    errorSupplemental(i.exp.loc, ds("perhaps use `%s()` to construct a value of the type"), i.exp.toChars());
                else if (ts.sym!.ctor !== null && !ts.sym!.hasCopyCtor)
                    errorSupplemental(i.exp.loc, ds("perhaps use `%s(...)` to construct a value of the type"), i.exp.toChars());
            } else {
                const tc = i.exp.type!.isTypeClass();
                if (tc !== null) {
                    // Check if the class can be default-constructed
                    if (!tc.sym!.noDefaultCtor && (tc.sym!.ctor === null || tc.sym!.defaultCtor !== null))
                        errorSupplemental(i.exp.loc, ds("perhaps use `new %s()` to construct a value of the type"), i.exp.toChars());
                    else if (tc.sym!.ctor !== null)
                        errorSupplemental(i.exp.loc, ds("perhaps use `new %s(...)` to construct a value of the type"), i.exp.toChars());
                }
            }
            return err();
        }
        // Make sure all pointers are constants
        if (needInterpret !== NeedInterpret.INITnointerpret && hasNonConstPointers(i.exp)) {
            error(i.exp.loc, ds("cannot use non-constant CTFE pointer in an initializer `%s`"), currExp.toChars());
            return err();
        }
        const ti = toBasetype(i.exp.type!);
        if (i.exp.op === EXP.tuple && i.expandTuples && implicitConvTo(i.exp, t) === MATCH.nomatch) {
            return new ExpInitializer(i.loc, i.exp);
        }

        // initsem.d:625 `L1:` — BAIL tail (06 §4): the label's tail only folds the result and
        // returns, and both `goto L1;` sites (:479, :492) jump straight into it. Canonical form:
        // a ZERO-PARAMETER nested arrow declared before its first use, capturing the locals —
        // never positional params.
        const L1Tail = (): Initializer => {
            if (i.exp!.op === EXP.error) {
                return i;
            }
            if (needInterpret !== NeedInterpret.INITnointerpret) {
                i.exp = ctfeInterpret(i.exp!);
            } else {
                i.exp = optimize(i.exp!, WANTvalue);
            }
            //printf("-ExpInitializer::semantic(): "); i.exp.print();
            return i;
        };

        /* Look for case of initializing a static array with a too-short
         * string literal, such as:
         *  char[5] foo = "abc";
         * Allow this by doing an explicit cast, which will lengthen the string
         * literal.
         */
        if (i.exp.op === EXP.string_ && tb.ty === TY.Tsarray) {
            const se = i.exp.isStringExp()!;
            const typeb = toBasetype(se.type!);
            const tynto: TY = nextOf(tb)!.ty;
            if (!se.committed &&
                typeb.isStaticOrDynamicArray() && isSomeChar(tynto)) {
                // D `string s;` -> `.init` is a NULL slice (09 §1.0); `out .string s` is a box that
                // the callee resets on entry (03 §3.3).
                const s: { value: DString | null } = { value: null };
                const len = se.numberOfCodeUnits(tynto, s);
                if (s.value !== null) // slice truthiness tests the POINTER, not the length (06 §2.8)
                    error(se.loc, ds("%.*s"), s.value.length, s.value);
                if (BigInt(len) < toInteger(tb.isTypeSArray()!.dim!)) { // widen at the boundary (09 §5)
                    i.exp = castTo(se, sc, t);
                    return L1Tail(); // goto L1; (dmd/initsem.d:479)
                }
            }

            /* Lop off terminating 0 of initializer for:
             *  static char s[5] = "hello";
             */
            if (sc.inCfile &&
                typeb.ty === TY.Tsarray &&
                isSomeChar(tynto) &&
                toInteger(tb.isTypeSArray()!.dim!) + 1n === toInteger(typeb.isTypeSArray()!.dim!)) {
                i.exp = castTo(se, sc, t);
                return L1Tail(); // goto L1; (dmd/initsem.d:492)
            }
        }
        /* C11 6.7.9-14..15
         * Initialize an array of unknown size with a string.
         * Change to static array of known size
         */
        if (sc.inCfile && i.exp.isStringExp() !== null &&
            tb.isTypeSArray() !== null && tb.isTypeSArray()!.isIncomplete()) {
            const se = i.exp.isStringExp()!;
            const ts = new TypeSArray(nextOf(tb), new IntegerExp(Loc.initial, BigInt(se.len + 1), Type.tsize_t));
            t = typeSemantic(ts, Loc.initial, sc);
            i.exp.type = t;
            tx.value = t;
        }

        // Look for implicit constructor call
        if (tb.ty === TY.Tstruct && !(ti.ty === TY.Tstruct && toDsymbol(tb, sc) === toDsymbol(ti, sc)) &&
            implicitConvTo(i.exp, t) === MATCH.nomatch) {
            const sd: StructDeclaration = tb.isTypeStruct()!.sym!;
            if (sd.ctor !== null) {
                // Rewrite as S().ctor(exp)
                let e: Expression;
                e = new StructLiteralExp(i.loc, sd, null);
                e = new DotIdExp(i.loc, e, Id.ctor);
                e = CallExp.fromArg(i.loc, e, i.exp); // D `this(Loc, Expression, Expression earg1)`
                e = expressionSemantic(e, sc);
                if (needInterpret !== NeedInterpret.INITnointerpret) {
                    i.exp = ctfeInterpret(e);
                } else
                    i.exp = optimize(e, WANTvalue);
            // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool)
                // (02 §11.5) — the runtime object IS a ScopeDsymbol, nothing is reinterpreted.
            } else if (search_function(sd as unknown as ScopeDsymbol, Id.opCall!) !== null) {
                /* https://issues.dlang.org/show_bug.cgi?id=1547
                 *
                 * Look for static opCall
                 *
                 * Rewrite as:
                 *  i.exp = typeof(sd).opCall(arguments)
                 */

                let e: Expression = typeDotIdExp(i.loc, sd.type!, Id.opCall!);
                e = CallExp.fromArg(i.loc, e, i.exp);
                e = expressionSemantic(e, sc);
                e = resolveProperties(sc, e);
                if (needInterpret !== NeedInterpret.INITnointerpret) {
                    i.exp = ctfeInterpret(e);
                } else
                    i.exp = optimize(e, WANTvalue);
            }
        }

        // Look for the case of statically initializing an array with a single member.
        // Recursively strip static array / enum layers until a compatible element is found,
        // and return an `ArrayLiteralExp` repeating the initializer, or `null` if no match found
        // int[2][3] = 7       => [[7, 7], [7, 7], [7, 7]]
        // int[2] = new Object => null
        // initsem.d:552 — the parameter `tb` deliberately SHADOWS the enclosing `tb` (D does the
        // same); kept verbatim (01 §2).
        const sarrayRepeat = (tb: Type): Expression | null => {
            const tsa = tb.isTypeSArray();
            if (tsa === null)
                return null;

            // printf("i.exp = %s, tsa = %s\n", i.exp.toChars(), tsa.toChars());
            let elem: Expression | null = null;
            if (implicitConvTo(i.exp!, nextOf(tb)!) !== MATCH.nomatch)
                elem = implicitCastTo(i.exp!, sc, nextOf(tb)!);
            else {
                const ae = sarrayRepeat(toBasetype(nextOf(tb)!));
                if (ae !== null)
                    elem = ae;
                else
                    return null;
            }

            const arrayElements: Expressions =
                // `cast(size_t)` — the index/length domain is `number` (09 §1.1); the mask is D's own.
                new DArray<Expression | null>(Number(BigInt.asUintN(64, toInteger(tsa.dim!))));
            // `foreach (ref e; *arrayElements) e = elem;` — a `ref` element write is an in-place
            // index write (03 §4), never an iteration over copies.
            for (let z = 0; z < arrayElements.length; z++)
                arrayElements.opIndexAssign(elem, z);
            return ArrayLiteralExp.fromBasis(i.exp!.loc, tb, elem, arrayElements);
        };

        const sa = sarrayRepeat(tb);
        if (sa !== null) {
            // printf("sa = %s\n", sa.toChars());
            i.exp = sa;
        }

        {
            const tta = t.isTypeSArray();
            if (implicitConvTo(i.exp!, t) !== MATCH.nomatch) {
                i.exp = implicitCastTo(i.exp!, sc, t);
            } else if (sc.inCfile && i.exp!.isStringExp() !== null &&
                tta !== null && (tta.next!.ty === TY.Tint8 || tta.next!.ty === TY.Tuns8) &&
                ti.ty === TY.Tsarray && nextOf(ti)!.ty === TY.Tchar) {
                /* unsigned char bbb[1] = "";
                 *   signed char ccc[1] = "";
                 */
                i.exp = castTo(i.exp!, sc, t);
            } else {
                const tba = tb.isTypeSArray();
                // Look for mismatch of compile-time known length to emit
                // better diagnostic message, as same as AssignExp::semantic.
                if (tba !== null && implicitConvTo(i.exp!, arrayOf(tba.next!)) > MATCH.nomatch) {
                    const dim1: bigint = toInteger(tba.dim!);
                    let dim2: bigint = dim1;
                    const ale = i.exp!.isArrayLiteralExp();
                    if (ale !== null) {
                        dim2 = ale.elements !== null ? BigInt(ale.elements.length) : 0n;
                    } else {
                        const se = i.exp!.isSliceExp();
                        if (se !== null) {
                            // initsem.d:609 — `if (Type tx = toStaticArrayType(se))`; the declared
                            // name SHADOWS this function's `tx` parameter, exactly as in D (01 §2).
                            const tx = toStaticArrayType(se);
                            if (tx !== null)
                                dim2 = toInteger(tx.isTypeSArray()!.dim!);
                        }
                    }
                    if (dim1 !== dim2) {
                        // `cast(int)dim1` — mask to 32 bits, signed (09 §2). The `Number(...)`
                        // argument is already truncated to int32, NOT a bigint-domain value.
                        error(i.exp!.loc, ds("mismatched array lengths, %d and %d"),
                            Number(BigInt.asIntN(32, dim1)), Number(BigInt.asIntN(32, dim2)));
                        i.exp = ErrorExp.get();
                    }
                }
                const et = i.exp!.type!;
                const errors = global.startGagging();
                let gagged: boolean;
                try {
                    i.exp = implicitCastTo(i.exp!, sc, t);
                } finally {
                    // try/finally is NOT in D — it protects the startGagging/endGagging pair against
                    // the extra exit paths this port's walls introduce (11 §2.5 "walls add exit paths
                    // D does not have"). A throw out of `implicitCastTo` would leak `global.gag`
                    // (`++` with no matching `--`) and silence every later diagnostic in the process.
                    gagged = global.endGagging(errors);
                }
                if (gagged)
                    error(currExp.loc, ds("cannot implicitly convert expression `%s` of type `%s` to `%s`"),
                        toErrMsg(currExp), et.toChars(), t.toChars());
            }
        }
        // initsem.d:625 — `L1:` reached by FALL-THROUGH; the tail is shared with the two `goto L1;`
        // sites above (06 §4 BAIL: the tail is terminal, so both routes `return` it).
        return L1Tail();
    };

    // initsem.d:638
    const visitC = (ci: CInitializer): Initializer => {
        //printf("CInitializer::semantic() tx: %s t: %s ci: %s\n", (tx ? tx.toChars() : "".ptr), t.toChars(), toChars(ci));
        // resolved: `static if (0)` (initsem.d:641-648) -> false; the guarded `toCBuffer`/`printf`
        // developer trace is dropped (07 §3, §2.1).

        /* Rewrite CInitializer into ExpInitializer, ArrayInitializer, or StructInitializer
         */
        t = toBasetype(t);

        // initsem.d:654
        const isComplexInitilaizer = (): boolean => { // D's spelling kept verbatim (01 §2)
            switch (t.ty) {
                case TY.Tcomplex32:
                case TY.Tcomplex64:
                case TY.Tcomplex80:
                    return true;
                default:
                    return false;
            }
        };

        const tv = t.isTypeVector();
        if (tv !== null)
            t = tv.basetype!;

        /* If `{ expression }` return the expression initializer
         */
        const isBraceExpression = (): ExpInitializer | null => {
            const dil = ci.initializerList.opSlice();
            return (dil.length === 1 && dil[0].designatorList === null)
                ? dil[0].initializer!.isExpInitializer()
                : null;
        };

        /********************************
         * initsem.d:682
         */
        const overlaps = (field: VarDeclaration, fields: (VarDeclaration | null)[], si: StructInitializer): boolean => {
            for (const fld of fields) {
                // initsem.d:686 — `field.isOverlappedWith(fld)` is UFCS for the free function at
                // dmd/dsymbolsem.d:843 (04 §6). D's `VarDeclaration[] fields` has non-null elements;
                // the port widens the container, so `fld!` is a narrowing artifact, not a fault site.
                if (isOverlappedWith(field, fld!)) {
                    // look for initializer corresponding with fld
                    for (const [i, ident] of si.field.opSlice().entries()) {
                        if (ident === fld!.ident && si.value.opIndex(i) !== null)
                            return true;   // already an initializer for `field`
                    }
                }
            }
            return false;
        };

        /* Run semantic on ExpInitializer, see if it represents entire struct ts
         */
        const representsStruct = (ei: ExpInitializer, ts: TypeStruct): boolean => {
            if (needInterpret !== NeedInterpret.INITnointerpret)
                sc = sc.startCTFE();
            try {
                ei.exp = expressionSemantic(ei.exp!, sc);
                ei.exp = resolveProperties(sc, ei.exp);
            } finally {
                // try/finally is NOT in D — it protects the CTFE push/pop pair against the extra
                // exit paths this port's walls introduce (11 §2.5). `!` is a narrowing artifact.
                if (needInterpret !== NeedInterpret.INITnointerpret)
                    sc = sc.endCTFE()!;
            }
            return implicitConvTo(ei.exp, ts) !== MATCH.nomatch; // initializer represents the entire struct
        };

        /* If { } are omitted from substructs, use recursion to reconstruct where
         * brackets go
         * Params:
         *  ts = substruct to initialize
         *  index = index into ci.initializer, updated
         * Returns: struct initializer for this substruct
         *
         * initsem.d:719 — `Initializer subStruct()(TypeStruct ts, ref size_t index)`. The empty
         * template-parameter list `()()` exists ONLY to defer the body's forward reference to
         * `subArray` (see the D comment at :764); TS closures resolve names at call time, so the
         * templating vanishes (07 §0). `ref size_t index` -> one-slot box (03 §3.3).
         */
        const subStruct = (ts: TypeStruct, index: { value: number }): Initializer => {
            //printf("subStruct(ts: %s, index %d)\n", ts.toChars(), cast(int)index);

            const si = new StructInitializer(ci.loc);
            const sd: StructDeclaration = ts.sym!;
            // initsem.d:725 — `sd.size(ci.loc)`; see the family note at :160. Result discarded.
            // upcast cascade (02 §11.5): AggregateDeclaration.deferred (Dsymbol) shadows
            // Dsymbol.deferred (bool).
            sizeDsymbol(sd as unknown as Dsymbol, ci.loc);
            if (sd.sizeok !== Sizeok.done) {
                index.value = ci.initializerList.length;
                return err();
            }
            const nfields = sd.fields.length;

            // initsem.d:733 — `foreach (fieldi; 0 .. nfields)`. VERIFIED by ldc2 probe: D's range
            // `foreach` variable is a PER-ITERATION COPY, so the `++fieldi` in the skip-overlap
            // `while` below does NOT advance the loop. The driver counter is therefore separate
            // from the body-visible `fieldi` (06 §1.3 + the copy semantics).
            for (let fieldiLoop = 0; fieldiLoop < nfields; fieldiLoop++) {
                let fieldi = fieldiLoop;
                if (index.value >= ci.initializerList.length)
                    break;          // ran out of initializers
                // D: `auto di = ci.initializerList[index];` (DesigInit is a struct, init.d:245 — 03 §1#4).
                // copy elided: `di` is only READ (`.designatorList` / `.initializer`) and the element is
                // never written through the list while `di` is live (03 §9).
                const di = ci.initializerList.opIndex(index.value);
                if (di.designatorList !== null && fieldi !== 0)
                    break;          // back to top level

                let field: VarDeclaration;
                for (;;) {  // skip field if it overlaps with previously seen fields
                    field = sd.fields.opIndex(fieldi)!;
                    ++fieldi;
                    if (!overlaps(field, sd.fields.opSlice(), si))
                        break;
                    if (fieldi === nfields)
                        break;
                }
                const tn = toBasetype(field.type!);
                const tnsa = tn.isTypeSArray();
                const tns = tn.isTypeStruct();
                const ix = di.initializer!;
                if (tnsa !== null && ix.isExpInitializer() !== null) {
                    const ei = ix.isExpInitializer()!;
                    if (ei.exp!.isStringExp() !== null && isIntegral(nextOf(tnsa)!)) {
                        si.addInit(field.ident, ei);
                        ++index.value;
                    } else
                        si.addInit(field.ident, subArray(tnsa, index)); // fwd ref of subArray is why subStruct is a template
                } else if (tns !== null && ix.isExpInitializer() !== null) {
                    /* Disambiguate between an exp representing the entire
                     * struct, and an exp representing the first field of the struct
                     */
                    if (representsStruct(ix.isExpInitializer()!, tns)) { // initializer represents the entire struct
                        const tnRef: { value: Type } = { value: tn };
                        si.addInit(field.ident, initializerSemantic(ix, sc, tnRef, needInterpret));
                        ++index.value;
                    } else                                // field initializers for struct
                        si.addInit(field.ident, subStruct(tns, index)); // the first field
                } else {
                    si.addInit(field.ident, ix);
                    ++index.value;
                }
            }
            //printf("subStruct() returns ai: %s, index: %d\n", si.toChars(), cast(int)index);
            return si;
        };

        /* If { } are omitted from subarrays, use recursion to reconstruct where
         * brackets go
         * Params:
         *  tsa = subarray to initialize
         *  index = index into ci.initializer, updated
         * Returns: array initializer for this subarray
         */
        const subArray = (tsa: TypeSArray, index: { value: number }): Initializer => {
            //printf("array(tsa: %s, index %d)\n", tsa.toChars(), cast(int)index);
            if (tsa.isIncomplete()) {
                // C11 6.2.5-20 "element type shall be complete whenever the array type is specified"
                // `assert(0)` -> assertUnreachable-shaped throw; a faithful D assert(0), NOT a wall.
                // `assert(0)` -> `assertUnreachable()` (cheatsheet / 09). A FAITHFUL port of a D
                // assert(0): it is normal translated code, never a wall (11 §2.5 accounting rule).
                assertUnreachable("initsem.d:802 — should have been detected by parser");
            }
            const bt = toBasetype(nextOf(tsa)!);

            const tnss = bt.isTypeStruct();
            if (tnss !== null) {
                return subStruct(tnss, index);
            }
            const tnsa = bt.isTypeSArray();
            const ai = new ArrayInitializer(ci.loc);
            ai.isCarray = true;

            // `cast(size_t)tsa.dim.toInteger()` — index/length domain -> `number` (09 §1.1).
            const nElems = Number(BigInt.asUintN(64, toInteger(tsa.dim!)));
            for (let n = 0; n < nElems; n++) { // `foreach (n; 0 .. cast(size_t)tsa.dim.toInteger())`
                if (index.value >= ci.initializerList.length)
                    break;          // ran out of initializers
                // copy elided: `auto di = ci.initializerList[index];` — `di` is read-only here (03 §9/§1#4).
                const di = ci.initializerList.opIndex(index.value);
                if (di.designatorList !== null)
                    break;          // back to top level
                else if (tnsa !== null && di.initializer!.isExpInitializer() !== null) {
                    const ei = di.initializer!.isExpInitializer()!;
                    if (ei.exp!.isStringExp() !== null && isIntegral(nextOf(tnsa)!)) {
                        ai.addInit(null, ei);
                        ++index.value;
                    } else
                        ai.addInit(null, subArray(tnsa, index));
                } else {
                    ai.addInit(null, di.initializer!);
                    ++index.value;
                }
            }
            //printf("array() returns ai: %s, index: %d\n", ai.toChars(), cast(int)index);
            return ai;
        };

        const ts = t.isTypeStruct();
        if (ts !== null) {
            const si = new StructInitializer(ci.loc);
            const sd: StructDeclaration = ts.sym!;
            // initsem.d:846 — `sd.size(ci.loc)`; see the family note at :160. Result discarded.
            // upcast cascade (02 §11.5): AggregateDeclaration.deferred (Dsymbol) shadows
            // Dsymbol.deferred (bool).
            sizeDsymbol(sd as unknown as Dsymbol, ci.loc);  // run semantic() on sd to get fields
            if (sd.sizeok !== Sizeok.done) {
                return err();
            }
            const nfields = sd.fields.length;
            let fieldi = 0;

            // `ref size_t index` is passed to subStruct/subArray, so the loop counter IS the box
            // (03 §3.3) — those callees advance it.
            const index: { value: number } = { value: 0 };
            Loop1:
            for (; index.value < ci.initializerList.length; ) {
                // copy elided: `DesigInit di = ci.initializerList[index];` — read-only (03 §9/§1#4).
                const di = ci.initializerList.opIndex(index.value);
                const dlist = di.designatorList;
                let field: VarDeclaration;
                if (dlist !== null) {
                    const length = dlist.length;
                    let id: Identifier | null = dlist.opIndex(0).ident;
                    if (length === 0 || dlist.opIndex(0).ident === null) {
                        // initsem.d:866 — `toChars(ci)` (hdrgen.d:212) is `initializerToChars`.
                        error(ci.loc, ds("`.identifier` expected for C struct field initializer `%s`"),
                            initializerToChars(ci));
                        return err();
                    }

                    if (length > 1) {
                        let nstsd: StructDeclaration = sd; // use this for member structs we wish to traverse
                        let subsi: StructInitializer = si;
                        /*
                         * run this for each designator in the chain until you hit the last
                         * then perform semantic analysis on the last field in the chain using the previous struct initializer
                         */
                        for (let i = 0; i < length; i++) {
                            let found = 0; // D `int found;` -> `.init` is 0 (09 §1.0)
                            id = dlist.opIndex(i).ident;
                            for (const f of nstsd.fields.opSlice()) {
                                if (f!.ident === id) {
                                    field = f!;
                                    ++found;
                                    break;
                                }
                            }
                            if (found === 0) {
                                error(ci.loc, ds("`.%s` is not a field of `%s`\n"), id!.toChars(), nstsd.toChars());
                                return err();
                            }

                            const base = toBasetype(field!.type!);

                            if (i >= length - 1) {
                                subsi.addInit(id, di.initializer!);
                                ++index.value;
                                continue Loop1;
                            }

                            const tstr = base.isTypeStruct();
                            const tarr = base.isTypeSArray();

                            if (tstr !== null) {
                                if (!overlaps(field!, nstsd.fields.opSlice(), subsi)) {
                                    const innersi = new StructInitializer(ci.loc);
                                    subsi.addInit(id, innersi);
                                    subsi = innersi;
                                } else {
                                    for (const [k, ident] of subsi.field.opSlice().entries()) {
                                        if (ident === id && subsi.value.opIndex(k) !== null)
                                            subsi = subsi.value.opIndex(k)!.isStructInitializer()!;
                                    }
                                }
                                nstsd = tstr.sym!;
                            } else if (tarr !== null) {
                                /*
                                 * once we hit an array, check & attach the array initializer to the struct initializer
                                 * move to the next initializer id and run initializer semantics on it
                                 */
                                /*
                                 * so tempting to check for null cases for field._init.
                                 * but if your object is set to null on decl, you can't use designators anymore
                                 * and D does well to default initialize for us
                                 */
                                let ai = field!._init!.isArrayInitializer();

                                if (ai === null) {
                                    ai = new ArrayInitializer(ci.loc);
                                    subsi.addInit(id, ai);
                                    field!._init = ai;
                                }

                                const ndx = dlist.opIndex(i + 1).exp;
                                ai.addInit(ndx, di.initializer!);
                                ++index.value;
                                continue Loop1;
                            } else {
                                error(ci.loc, ds("only 1 designated initializer allowed for C struct field of type `%s`"),
                                    typeToChars(base)); // hdrgen's `toChars(const Type)` (hdrgen.d:220)
                                return err();
                            }
                        }
                    }
                    for (const [k, f] of sd.fields.opSlice().entries()) {         // linear search for now
                        if (f!.ident === id) {
                            fieldi = k;
                            si.addInit(id, di.initializer!);
                            ++fieldi;
                            ++index.value;
                            continue Loop1;
                        }
                    }
                    error(ci.loc, ds("`.%s` is not a field of `%s`\n"), id!.toChars(), sd.toChars());
                    return err();
                }

                if (fieldi === nfields)
                    break;

                let ix: Initializer = di.initializer!;

                /* If a C initializer is wrapped in a C initializer, with no designators,
                 * peel off the outer one
                 */
                if (ix.isCInitializer() !== null) {
                    const cix = ix.isCInitializer()!;
                    if (cix.initializerList.length === 1) {
                        // copy elided: `DesigInit dix = cix.initializerList[0];` — read-only; `ix = inix` below
                        // rebinds the LOCAL cursor, it does not write through `dix` (03 §9/§1#4).
                        const dix = cix.initializerList.opIndex(0);
                        if (dix.designatorList === null) {
                            const inix = dix.initializer!;
                            if (inix.isCInitializer() !== null)
                                ix = inix;
                        }
                    }
                }

                const cix = ix.isCInitializer();
                if (cix !== null) {
                    /* ImportC loses the structure from anonymous structs, but this is retained
                     * by the initializer syntax. if a CInitializer has a Designator, it is probably
                     * a nested anonymous struct
                     */
                    let found = 0;
                    // copy elided: `foreach (dix; cix.initializerList)` — each `dix` is read-only (03 §9/§4).
                    for (const dix of cix.initializerList) { // foreach over a container value (06 §1.9)
                        const dlistx = dix.designatorList;
                        if (dlistx === null)
                            continue;
                        if (dlistx.length === 1 && dlistx.opIndex(0).ident !== null) {
                            const idx = dlistx.opIndex(0).ident;
                            for (const [k, f] of sd.fields.opSlice().entries()) {         // linear search for now
                                if (f!.ident === idx) {
                                    fieldi = k;
                                    si.addInit(idx, dix.initializer!);
                                    ++fieldi;
                                    ++index.value;
                                    ++found;
                                    break;
                                }
                            }
                        } else {
                            // initsem.d:1025 — `toChars(ci)` (hdrgen.d:212) is `initializerToChars`.
                            error(ci.loc, ds("only 1 designator currently allowed for C struct field initializer `%s`"),
                                initializerToChars(ci));
                        }
                    }

                    if (found === cix.initializerList.length)
                        continue Loop1;
                }

                for (;;) {  // skip field if it overlaps with previously seen fields
                    field = sd.fields.opIndex(fieldi)!;
                    ++fieldi;
                    if (!overlaps(field, sd.fields.opSlice(), si))
                        break;
                    if (fieldi === nfields)
                        break;
                }

                const tn = toBasetype(field!.type!);
                const tnsa = tn.isTypeSArray();
                const tns = tn.isTypeStruct();

                if (tnsa !== null && ix.isExpInitializer() !== null) {
                    const ei = ix.isExpInitializer()!;
                    if (ei.exp!.isStringExp() !== null && isIntegral(nextOf(tnsa)!)) {
                        si.addInit(field!.ident, ei);
                        ++index.value;
                    } else
                        si.addInit(field!.ident, subArray(tnsa, index));
                } else if (tns !== null && ix.isExpInitializer() !== null) {
                    /* Disambiguate between an exp representing the entire
                     * struct, and an exp representing the first field of the struct
                     */
                    if (representsStruct(ix.isExpInitializer()!, tns)) { // initializer represents the entire struct
                        const tnRef: { value: Type } = { value: tn };
                        si.addInit(field!.ident, initializerSemantic(ix, sc, tnRef, needInterpret));
                        ++index.value;
                    } else                                // field initializers for struct
                        si.addInit(field!.ident, subStruct(tns, index)); // the first field
                } else {
                    si.addInit(field!.ident, di.initializer!);
                    ++index.value;
                }
            }
            const tRef: { value: Type } = { value: t };
            const r = initializerSemantic(si, sc, tRef, needInterpret);
            t = tRef.value;
            return r;
        }
        const ta = t.isTypeSArray();
        if (ta !== null) {
            // D declares `auto ta` but never reads it — the binding is the condition (initsem.d:1079).
            void ta;
            const tn = toBasetype(nextOf(t)!);  // element type of array

            /* If it's an array of integral being initialized by `{ string }`
             * replace with `string`
             */
            if (isIntegral(tn)) {
                const ei = isBraceExpression();
                if (ei !== null) {
                    if (ei.exp!.isStringExp() !== null) {
                        const tRef: { value: Type } = { value: t };
                        const r = initializerSemantic(ei, sc, tRef, needInterpret);
                        t = tRef.value;
                        return r;
                    }
                }
            }

            const tnsa = tn.isTypeSArray();      // array of array
            const tns = tn.isTypeStruct();       // array of struct

            const ai = new ArrayInitializer(ci.loc);
            ai.isCarray = true;
            const index: { value: number } = { value: 0 }; // `ref size_t index` box (03 §3.3)
            for (; index.value < ci.initializerList.length; ) {
                // copy elided: `auto di = ci.initializerList[index];` — read-only (03 §9/§1#4).
                const di = ci.initializerList.opIndex(index.value);
                const dlist = di.designatorList;
                if (dlist !== null) {
                    const length = dlist.length;
                    if (length === 0 || dlist.opIndex(0).exp === null) {
                        // initsem.d:1108 — `toChars(ci)` (hdrgen.d:212) is `initializerToChars`.
                        error(ci.loc, ds("`[ constant-expression ]` expected for C array element initializer `%s`"),
                            initializerToChars(ci));
                        return err();
                    }
                    if (length > 1) {
                        // initsem.d:1113 — `toChars(ci)` (hdrgen.d:212) is `initializerToChars`.
                        error(ci.loc, ds("only 1 designator currently allowed for C array element initializer `%s`"),
                            initializerToChars(ci));
                        return err();
                    }
                    //printf("tn: %s, di.initializer: %s\n", tn.toChars(), di.initializer.toChars());
                    let ix: Initializer = di.initializer!;
                    if (tnsa !== null && ix.isExpInitializer() !== null) {
                        // Wrap initializer in [ ]
                        const ain = new ArrayInitializer(ci.loc);
                        ain.addInit(null, di.initializer!);
                        ix = ain;
                        const tnRef: { value: Type } = { value: tn };
                        ai.addInit(dlist.opIndex(0).exp, initializerSemantic(ix, sc, tnRef, needInterpret));
                        ++index.value;
                    } else if (tns !== null && ix.isExpInitializer() !== null) {
                        /* Disambiguate between an exp representing the entire
                         * struct, and an exp representing the first field of the struct
                         */
                        if (representsStruct(ix.isExpInitializer()!, tns)) { // initializer represents the entire struct
                            const tnRef: { value: Type } = { value: tn };
                            ai.addInit(dlist.opIndex(0).exp, initializerSemantic(ix, sc, tnRef, needInterpret));
                            ++index.value;
                        } else                                // field initializers for struct
                            ai.addInit(dlist.opIndex(0).exp, subStruct(tns, index)); // the first field
                    } else {
                        const tnRef: { value: Type } = { value: tn };
                        ai.addInit(dlist.opIndex(0).exp, initializerSemantic(ix, sc, tnRef, needInterpret));
                        ++index.value;
                    }
                } else if (tnsa !== null && di.initializer!.isExpInitializer() !== null) {
                    const ei = di.initializer!.isExpInitializer()!;
                    if (ei.exp!.isStringExp() !== null && isIntegral(nextOf(tnsa)!)) {
                        ai.addInit(null, ei);
                        ++index.value;
                    } else
                        ai.addInit(null, subArray(tnsa, index));
                } else if (tns !== null && di.initializer!.isExpInitializer() !== null) {
                    /* Disambiguate between an exp representing the entire
                     * struct, and an exp representing the first field of the struct
                     */
                    if (representsStruct(di.initializer!.isExpInitializer()!, tns)) { // initializer represents the entire struct
                        const tnRef: { value: Type } = { value: tn };
                        ai.addInit(null, initializerSemantic(di.initializer!, sc, tnRef, needInterpret));
                        ++index.value;
                    } else                                // field initializers for struct
                        ai.addInit(null, subStruct(tns, index)); // the first field
                } else {
                    const tnRef: { value: Type } = { value: tn };
                    ai.addInit(null, initializerSemantic(di.initializer!, sc, tnRef, needInterpret));
                    ++index.value;
                }
            }
            // initsem.d:1176 — passes the OUTER `ref Type tx` straight through, so the box itself
            // is forwarded (not a fresh one): the callee may rewrite THIS function's caller's type.
            return initializerSemantic(ai, sc, tx, needInterpret);
        }
        const eiBrace = isBraceExpression();
        if (eiBrace !== null) {
            return visitExp(eiBrace);
        } else if (isComplexInitilaizer()) {
            /* just convert _Complex = { a, b} to _Complex =. a + b*i */
            if (ci.initializerList.opSlice().length !== 2) {
                error(ci.loc, ds("only two initializers required for complex type `%s`"), t.toChars());
                return err();
            }
            const rexp = initializerToExpression(ci.initializerList.opIndex(0).initializer!);
            const imexp = initializerToExpression(ci.initializerList.opIndex(1).initializer!);

            // `import dmd.root.ctfloat;` (initsem.d:1193) — a function-local import; hoisted to the
            // module's import list (01 §3).
            const newExpr = new AddExp(ci.loc, rexp,
                new MulExp(ci.loc, imexp, new RealExp(ci.loc, CTFloat.one, Type.timaginary64)));

            const ce = new ExpInitializer(ci.loc, newExpr);
            const tRef: { value: Type } = { value: t };
            const r = initializerSemantic(ce, sc, tRef, needInterpret);
            t = tRef.value;
            return r;
        } else {
            // initsem.d:1202 — `toChars(ci)` (hdrgen.d:212) is `initializerToChars`.
            error(ci.loc, ds("unrecognized C initializer `%s` for type `%s`"), initializerToChars(ci), t.toChars());
            return err();
        }
    };

    // initsem.d:1207 — `mixin VisitInitializer!Initializer visit;` + :1208
    // `auto result = visit.VisitInitializer(init);`
    // resolved: mixin VisitInitializer!Initializer + visitCase -> inlined dispatch switch
    // (07 §6.2, 13 §7.6 rule 1: the generated switch is emitted INLINE at the call site, in FULL,
    // never behind a named wrapper). With `Result = Initializer` (a class) each generated case is
    //     auto ix = init.isXInitializer();
    //     Result r = visitX(ix); if (r !is Result.init) return r;
    // and `Result.init` is `null` (09 §1.0); init.d:383's `static if (is(Result == void))` takes
    // its ELSE branch, i.e. the trailing `return Result.init;` -> `return null;`.
    // `final switch` -> switch + `never` exhaustiveness check + throw (06 §3.2).
    let result: Initializer | null = null;
    dispatch: {
        switch (init.kind) {
            case InitKind.void_: {
                const ix = init.isVoidInitializer();
                const r = visitVoid(ix!);
                if (r !== null) { result = r; break dispatch; }
                break;
            }
            case InitKind.default_: {
                const ix = init.isDefaultInitializer();
                const r = visitDefault(ix!);
                if (r !== null) { result = r; break dispatch; }
                break;
            }
            case InitKind.error: {
                const ix = init.isErrorInitializer();
                const r = visitError(ix!);
                if (r !== null) { result = r; break dispatch; }
                break;
            }
            case InitKind.struct_: {
                const ix = init.isStructInitializer();
                const r = visitStruct(ix!);
                if (r !== null) { result = r; break dispatch; }
                break;
            }
            case InitKind.array: {
                const ix = init.isArrayInitializer();
                const r = visitArray(ix!);
                if (r !== null) { result = r; break dispatch; }
                break;
            }
            case InitKind.exp: {
                const ix = init.isExpInitializer();
                const r = visitExp(ix!);
                if (r !== null) { result = r; break dispatch; }
                break;
            }
            case InitKind.C_: {
                const ix = init.isCInitializer();
                const r = visitC(ix!);
                if (r !== null) { result = r; break dispatch; }
                break;
            }
            default: {
                // final switch: D throws SwitchError on an unhandled value
                const _exhaustive: never = init.kind;
                void _exhaustive;
                throw new SwitchError();
            }
        }
        // init.d:384 — `return Result.init;` with Result = Initializer (a class) -> null.
        result = null;
    }
    // initsem.d:1209-1210
    // `result.semanticDone = true;` runs on the mixin's result BEFORE the null substitution, so a
    // null result would fault in D exactly here; the `!` marks that same site (08 §3).
    result!.semanticDone = true;
    return (result !== null) ? result : new ErrorInitializer();
}

/***********************
 * dmd/initsem.d:1221 — `Initializer inferTypeInitializer(Initializer init, Scope* sc)`.
 *
 * Translate init to an `Expression` in order to infer the type.
 * Params:
 *      init = `Initializer` AST node
 *      sc = context
 * Returns:
 *      an equivalent `ExpInitializer` if successful, or `ErrorInitializer` if it cannot be translated
 */
// RENAMED (04 §6.1): D splits the name `inferType` across modules by first-argument type —
// `Initializer inferTypeInitializer(Initializer, Scope*)` here and `Expression inferTypeInitializer(Expression, Type, int)`
// at dcast.d:3213. The incumbent (dcast, pinned by dcast.test.ts) keeps the bare name; this one takes
// the receiver-type suffix, matching hasPointers/hasPointersDsymbol and size/sizeDsymbol.
export function inferTypeInitializer(init: Initializer, sc: Scope): Initializer {
    // initsem.d:1223
    const visitVoid = (i: VoidInitializer): Initializer => {
        error(i.loc, ds("cannot infer type from void initializer"));
        return new ErrorInitializer();
    };

    // initsem.d:1229
    const visitDefault = (i: DefaultInitializer): Initializer => {
        error(i.loc, ds("cannot infer type from default initializer"));
        return new ErrorInitializer();
    };

    // initsem.d:1235
    const visitError = (i: ErrorInitializer): Initializer => i;

    // initsem.d:1240
    const visitStruct = (i: StructInitializer): Initializer => {
        error(i.loc, ds("cannot infer type from struct initializer"));
        return new ErrorInitializer();
    };

    // initsem.d:1246 — the parameter deliberately SHADOWS the enclosing `init` (D does the same).
    const visitArray = (init: ArrayInitializer): Initializer => {
        //printf("ArrayInitializer::inferTypeInitializer() %s\n", toChars());
        let keys: Expressions | null = null;
        const values: Expressions = new DArray<Expression | null>(init.value.length);
        const no = (): Initializer => {
            if (keys !== null)
                error(init.loc, ds("not an associative array initializer"));
            else
                error(init.loc, ds("cannot infer type from array initializer"));
            return new ErrorInitializer();
        };
        const isAssoc: boolean = init.isAssociativeArray();
        if (isAssoc)
            keys = new DArray<Expression | null>(init.value.length);
        else
            // `Array.zero()` is a documented NO-OP in the port (08 §2.0a). Not a default-dependence
            // here: the loop below WRITES every slot in [0 .. init.value.length), which is exactly
            // the length `values` was constructed with, so no slot is ever read as a default.
            values.zero();

        for (let i = 0; i < init.value.length; i++) {
            if (isAssoc) {
                const e = init.index.opIndex(i);
                if (e === null)
                    return no();
                keys!.opIndexAssign(e, i);
            } else
                assert(init.index.opIndex(i) === null); // already asserted by isAssociativeArray()
            // D `Initializer iz = init.value[i];` — every D class reference is nullable and the
            // container slot is `Initializer | null` (08 §3), so the local carries the nullability
            // and D's `if (!iz)` is an ordinary slot-null test (06 §2.7). No `!` here: D does NOT
            // fault on the read.
            let iz: Initializer | null = init.value.opIndex(i);
            if (iz === null)
                return no();
            iz = inferTypeInitializer(iz, sc);
            if (iz.isErrorInitializer() !== null) {
                return iz;
            }
            values.opIndexAssign(iz.isExpInitializer()!.exp, i);
            assert(values.opIndex(i)!.isErrorExp() === null);
        }

        let e: Expression;
        e = isAssoc
            ? new AssocArrayLiteralExp(init.loc, keys, values)
            : new ArrayLiteralExp(init.loc, null, values);
        const ei = new ExpInitializer(init.loc, e);
        return inferTypeInitializer(ei, sc);
    };

    // initsem.d:1296 — the parameter deliberately SHADOWS the enclosing `init`.
    const visitExp = (init: ExpInitializer): Initializer => {
        //printf("ExpInitializer::inferTypeInitializer() %s\n", init.toChars());
        init.exp = expressionSemantic(init.exp!, sc);

        // for static alias this: https://issues.dlang.org/show_bug.cgi?id=17684
        if (init.exp.op === EXP.type)
            init.exp = resolveAliasThis(sc, init.exp);

        init.exp = resolveProperties(sc, init.exp!);
        const se = init.exp.isScopeExp();
        if (se !== null) {
            const ti = se.sds!.isTemplateInstance();
            if (ti !== null && ti.semanticRun === PASS.semantic && ti.aliasdecl === null)
                error(se.loc, ds("cannot infer type from %s `%s`, possible circular dependency"),
                    se.sds!.kind(), se.toChars());
            else
                error(se.loc, ds("cannot infer type from %s `%s`"), se.sds!.kind(), se.toChars());
            return new ErrorInitializer();
        }

        // Give error for overloaded function addresses
        // D `bool hasOverloads;` passed as `&hasOverloads` — a pointer-to-local -> box (03 §7.2).
        const hasOverloads: { value: boolean } = { value: false };
        const f = isFuncAddress(init.exp, hasOverloads);
        if (f !== null) {
            if (checkForwardRef(f, init.loc)) {
                return new ErrorInitializer();
            }
            // initsem.d:1324 — `f.isUnique()` is UFCS for `isUnique(FuncDeclaration)`
            // (dmd/funcsem.d:408), not the `OverDeclaration` sibling (04 §6/§1.1).
            if (hasOverloads.value && !isUnique(f)) {
                error(init.exp.loc, ds("cannot infer type from overloaded function symbol `%s`"), init.exp.toChars());
                return new ErrorInitializer();
            }
        }
        const ae = init.exp.isAddrExp();
        if (ae !== null) {
            if (ae.e1!.op === EXP.overloadSet) {
                error(init.exp.loc, ds("cannot infer type from overloaded function symbol `%s`"), init.exp.toChars());
                return new ErrorInitializer();
            }
        }
        if (init.exp.isErrorExp() !== null) {
            return new ErrorInitializer();
        }
        if (init.exp.type === null) {
            return new ErrorInitializer();
        }
        return init;
    };

    // initsem.d:1349
    const visitC = (i: CInitializer): Initializer => {
        //printf("CInitializer.inferType()\n");
        error(i.loc, ds("TODO C inferType initializers not supported yet"));
        return new ErrorInitializer();
    };

    // initsem.d:1356-1357 — `mixin VisitInitializer!Initializer visit;` +
    // `auto result = visit.VisitInitializer(init);`
    // resolved: mixin VisitInitializer!Initializer + visitCase -> inlined dispatch switch
    // (07 §6.2, 13 §7.6 rule 1). Same expansion as in `initializerSemantic` above.
    let result: Initializer | null = null;
    dispatch: {
        switch (init.kind) {
            case InitKind.void_: {
                const ix = init.isVoidInitializer();
                const r = visitVoid(ix!);
                if (r !== null) { result = r; break dispatch; }
                break;
            }
            case InitKind.default_: {
                const ix = init.isDefaultInitializer();
                const r = visitDefault(ix!);
                if (r !== null) { result = r; break dispatch; }
                break;
            }
            case InitKind.error: {
                const ix = init.isErrorInitializer();
                const r = visitError(ix!);
                if (r !== null) { result = r; break dispatch; }
                break;
            }
            case InitKind.struct_: {
                const ix = init.isStructInitializer();
                const r = visitStruct(ix!);
                if (r !== null) { result = r; break dispatch; }
                break;
            }
            case InitKind.array: {
                const ix = init.isArrayInitializer();
                const r = visitArray(ix!);
                if (r !== null) { result = r; break dispatch; }
                break;
            }
            case InitKind.exp: {
                const ix = init.isExpInitializer();
                const r = visitExp(ix!);
                if (r !== null) { result = r; break dispatch; }
                break;
            }
            case InitKind.C_: {
                const ix = init.isCInitializer();
                const r = visitC(ix!);
                if (r !== null) { result = r; break dispatch; }
                break;
            }
            default: {
                const _exhaustive: never = init.kind;
                void _exhaustive;
                throw new SwitchError();
            }
        }
        result = null; // init.d:384 — `return Result.init;` -> null
    }
    return (result !== null) ? result : new ErrorInitializer();
}

/***********************
 * dmd/initsem.d:1370 — `Expression initializerToExpression(Initializer init, Type itype = null,
 * const bool isCfile = false)`.
 *
 * Translate init to an `Expression`.
 * Params:
 *      init = `Initializer` AST node
 *      itype = if not `null`, type to coerce expression to
 *      isCfile = default initializers are different with C
 * Returns:
 *      `Expression` created, `null` if cannot, `ErrorExp` for other errors
 *
 * `init` is typed NON-null: the dispatch below reads `init.kind` unconditionally, so a null
 * argument faults exactly where D would (02 §10.1).
 */
export function initializerToExpression(
    init: Initializer,
    itype: Type | null = null,
    isCfile = false,
): Expression | null {
    //printf("initializerToExpression() isCfile: %d\n", isCfile);

    // initsem.d:1374 — `Expression visitVoid(VoidInitializer)`: the parameter is UNNAMED in D.
    const visitVoid = (_i: VoidInitializer): Expression | null => {
        return null;
    };

    // initsem.d:1379
    const visitDefault = (di: DefaultInitializer): Expression | null => {
        return di.type !== null ? defaultInit(di.type, Loc.initial, isCfile) : null;
    };

    // initsem.d:1384 — parameter UNNAMED in D.
    const visitError = (_i: ErrorInitializer): Expression | null => {
        return ErrorExp.get();
    };

    /***************************************
     * This works by transforming a struct initializer into
     * a struct literal. In the future, the two should be the
     * same thing.
     */
    const visitStruct = (_i: StructInitializer): Expression | null => {
        // cannot convert to an expression without target 'ad'
        return null;
    };

    /********************************
     * If possible, convert array initializer to array literal.
     * Otherwise return NULL.
     *
     * initsem.d:1404 — the parameter deliberately SHADOWS the enclosing `init`.
     */
    const visitArray = (init: ArrayInitializer): Expression | null => {
        //printf("ArrayInitializer::toExpression(), dim = %d\n", dim);
        //static int i; if (++i == 2) assert(0);
        if (itype === null || toBasetype(itype).isTypeAArray() !== null)
            if (init.type === null || init.type.isTypeAArray() !== null)
                if (init.isAssociativeArray())
                    return toAssocArrayLiteral(init);

        let edim: number;      // the length of the resulting array literal (D `uint`)
        const amax = 0x80000000; // D `const(uint) amax`
        let t: Type | null = null;  // type of the array literal being initialized
        if (init.type !== null) {
            if (init.type === Type.terror) {
                return ErrorExp.get();
            }
            t = toBasetype(init.type);
            switch (t.ty) {
                case TY.Tvector:
                    t = t.isTypeVector()!.basetype!;
                    // goto case Tsarray; -> the TEXTUALLY NEXT arm, so JS no-break fallthrough
                    // reproduces it exactly (06 §3.6(a)); dmd/initsem.d:1427.
                case TY.Tsarray: {
                    const adim: bigint = toInteger(t.isTypeSArray()!.dim!); // `uinteger_t`
                    if (adim >= BigInt(amax))
                        return null;
                    edim = Number(BigInt.asUintN(32, adim)); // `cast(uint)adim` (09 §2)
                    break;
                }

                case TY.Tpointer:
                case TY.Tarray:
                    edim = init.dim;
                    break;

                default:
                    // `assert(0)` -> `assertUnreachable()`; a FAITHFUL port of D's assert(0), NOT a
                    // wall (11 §2.5 accounting rule). It returns `never`, so `edim` stays
                    // definitely-assigned on every arm that falls out of the switch.
                    assertUnreachable("initsem.d:1442 — unexpected basetype of an ArrayInitializer");
            }
        } else {
            /* Calculate the length of the array literal
             */
            edim = init.value.length >>> 0; // `cast(uint)init.value.length`
            let j = 0;
            for (let i = 0; i < init.value.length; i++) {
                const e = init.index.opIndex(i);
                if (e !== null) {
                    if (e.op === EXP.int64) {
                        const idxval: bigint = BigInt.asUintN(64, toInteger(e)); // `uinteger_t` (09 §0, §3.1)
                        if (idxval >= BigInt(amax))
                            return null;
                        j = Number(idxval); // `cast(size_t)idxval`
                    } else
                        return null;
                }
                ++j;
                if (j > edim)
                    edim = j >>> 0; // `cast(uint)j`
            }
        }

        // enforce the element type only if the dimensions match, otherwise the value
        // might be used as an initializer for the whole array at another dimension
        const isTypeArray = (tn: Type | null): Type | null => {
            const ty: TY = tn !== null ? tn.ty : TY.Tnone;
            return ty === TY.Tarray || ty === TY.Tsarray || ty === TY.Taarray || ty === TY.Tvector ? tn : null;
        };
        let tnext = isTypeArray(itype);
        let initn: ArrayInitializer | null = init;
        while (tnext !== null && initn !== null) {
            tnext = isTypeArray(nextOf(tnext));
            initn = initn.value.length !== 0 ? initn.value.opIndex(0)!.isArrayInitializer() : null;
        }
        const telem: Type | null = (itype !== null && tnext === null && initn === null) ? nextOf(itype) : null;

        const elements: Expressions = new DArray<Expression | null>(edim);
        // initsem.d:1488 — `elements.zero();`. `Array.zero()` is a documented NO-OP in the port
        // (there is no generic `T.init`, 08 §2.0a) and THIS site READS the slots back as defaults
        // (:1512 `if (!element)`) — the genuine default-dependence 08 §2.0a names. Special-cased at
        // the SINGLE KNOWN `T`: the element type is `Expression | null`, whose `.init` is `null`
        // (09 §1.0), so the memset is unambiguous and is spelled out rather than guessed generically.
        elements.zero();
        for (let z = 0; z < edim; z++)
            elements.opIndexAssign(null, z);
        let j = 0;
        for (let i = 0; i < init.value.length; i++) {
            const e = init.index.opIndex(i);
            if (e !== null)
                j = Number(BigInt.asUintN(64, toInteger(e))); // `cast(size_t)e.toInteger()`
            assert(j < edim);
            const iz = init.value.opIndex(i);
            if (iz !== null) {
                const ex = initializerToExpression(iz, telem, isCfile);
                if (ex !== null) {
                    elements.opIndexAssign(ex, j);
                    ++j;
                } else
                    return null;
            } else
                return null;
        }

        /* Fill in any missing elements with the default initializer
         */
        let defaultInitExp: Expression | null = null;  // lazily create it (D names it `defaultInit`;
        // renamed here ONLY because the D free function `defaultInit` (typesem.d) is imported into
        // this module's scope and TS has no per-statement shadowing of an import — 01 §2 carve-out).
        // `foreach (ref element; (*elements)[0 .. edim])` — a `ref` element write is an in-place
        // index write (03 §4), never iteration over copies.
        for (let z = 0; z < edim; z++) {
            const element = elements.opIndex(z);
            if (element === null) {
                if (init.type === null) // don't know what type to use
                    return null;
                if (defaultInitExp === null)
                    // `(cast(TypeNext)t).next` — every arm of the `switch (t.ty)` above leaves
                    // `t` a TypeNext, and `nextOf` (typesem.d:256) returns that same `next` field
                    // for any TypeNext, so the downcast is not needed at all.
                    // `t!`: this branch is guarded by `if (!init.type) return null;` two lines up,
                    // and `t` is assigned exactly when `init.type` is non-null (:1416-:1444).
                    defaultInitExp = defaultInit(nextOf(t!)!, Loc.initial, isCfile);
                elements.opIndexAssign(defaultInitExp, z);
            }
        }

        /* Expand any static array initializers that are a single expression
         * into an array of them
         *    e => [e, e, ..., e, e]
         */
        if (t !== null) {
            const tn = toBasetype(nextOf(t)!);
            if (tn.ty === TY.Tsarray) {
                // `(cast(TypeSArray)tn)` — tag-proved RTTI downcast (02 §11.5c item 3): the
                // `tn.ty === Tsarray` test immediately above IS the proof.
                const dim = Number(BigInt.asUintN(64, toInteger(tn.isTypeSArray()!.dim!)));
                const te = toBasetype(nextOf(tn)!);
                for (let z = 0; z < elements.length; z++) { // `foreach (ref e; *elements)`
                    const e = elements.opIndex(z);
                    if (te.equals(e!.type)) {
                        const elements2: Expressions = new DArray<Expression | null>(dim);
                        for (let w = 0; w < elements2.length; w++) // `foreach (ref e2; *elements2)`
                            elements2.opIndexAssign(e, w);
                        elements.opIndexAssign(new ArrayLiteralExp(e!.loc, tn, elements2), z);
                    }
                }
            }
        }

        /* If any elements are errors, then the whole thing is an error
         */
        for (const e of elements.opSlice(0, edim)) {
            if (e!.op === EXP.error) {
                return e;
            }
        }

        const e: Expression = new ArrayLiteralExp(init.loc, init.type, elements);
        return e;
    };

    // initsem.d:1562
    const visitExp = (i: ExpInitializer): Expression | null => {
        if (itype !== null) {
            //printf("ExpInitializer::toExpression(t = %s) exp = %s\n", itype.toChars(), i.exp.toChars());
            const tb = toBasetype(itype);
            // `(cast(AssignExp)i.exp).e2` — tag-proved RTTI downcast (02 §11.5c item 3): the `op`
            // test on this very line proves the node is a ConstructExp/BlitExp, both AssignExp
            // subclasses. `isAssignExp()` cannot be used — it tests `EXP.assign` only.
            const e: Expression = (i.exp!.op === EXP.construct || i.exp!.op === EXP.blit)
                ? (i.exp as unknown as AssignExp).e2!
                : i.exp!;
            if (tb.ty === TY.Tsarray && implicitConvTo(e, nextOf(tb)!) !== MATCH.nomatch) {
                const tsa = tb.isTypeSArray()!; // tag-proved by the `tb.ty === Tsarray` test above
                const d = Number(BigInt.asUintN(64, toInteger(tsa.dim!)));
                const elements: Expressions = new DArray<Expression | null>(d);
                for (let j = 0; j < d; j++)
                    elements.opIndexAssign(e, j);
                const ae = new ArrayLiteralExp(e.loc, itype, elements);
                return ae;
            }
        }
        return i.exp;
    };

    // initsem.d:1583
    const visitC = (_i: CInitializer): Expression | null => {
        //printf("CInitializer.initializerToExpression(null, true)\n");
        return null;
    };

    // initsem.d:1589-1590 — `mixin VisitInitializer!Expression visit;` +
    // `return visit.VisitInitializer(init);`
    // resolved: mixin VisitInitializer!Expression + visitCase -> inlined dispatch switch
    // (07 §6.2, 13 §7.6 rule 1). This is the tree's ONLY `Result = Expression` instantiation, so
    // `Result.init` here is a null EXPRESSION (init.d:384) — do NOT copy the Initializer arms.
    dispatch: {
        switch (init.kind) {
            case InitKind.void_: {
                const ix = init.isVoidInitializer();
                const r = visitVoid(ix!);
                if (r !== null) return r;
                break;
            }
            case InitKind.default_: {
                const ix = init.isDefaultInitializer();
                const r = visitDefault(ix!);
                if (r !== null) return r;
                break;
            }
            case InitKind.error: {
                const ix = init.isErrorInitializer();
                const r = visitError(ix!);
                if (r !== null) return r;
                break;
            }
            case InitKind.struct_: {
                const ix = init.isStructInitializer();
                const r = visitStruct(ix!);
                if (r !== null) return r;
                break;
            }
            case InitKind.array: {
                const ix = init.isArrayInitializer();
                const r = visitArray(ix!);
                if (r !== null) return r;
                break;
            }
            case InitKind.exp: {
                const ix = init.isExpInitializer();
                const r = visitExp(ix!);
                if (r !== null) return r;
                break;
            }
            case InitKind.C_: {
                const ix = init.isCInitializer();
                const r = visitC(ix!);
                if (r !== null) return r;
                break;
            }
            default: {
                const _exhaustive: never = init.kind;
                void _exhaustive;
                throw new SwitchError();
            }
        }
        break dispatch;
    }
    return null; // init.d:384 — `return Result.init;` with Result = Expression -> null
}

/**************************************
 * dmd/initsem.d:1602 — `private bool hasNonConstPointers(Expression e)`.
 *
 * Determine if expression has non-constant pointers, or more precisely,
 * a pointer that CTFE cannot handle.
 * Params:
 *    e = expression to check
 * Returns:
 *    true if it has non-constant pointers
 *
 * D module-private: reached only from `initializerSemantic.visitExp` (:448) in this same module,
 * so it stays unexported here (01 §2 / 10 §1.7 — de-privatization is triggered by cross-module
 * reachability, and there is none).
 */
function hasNonConstPointers(e: Expression): boolean {
    // initsem.d:1604 — `static bool checkArray(Expressions* elems)`.
    const checkArray = (elems: Expressions | null): boolean => {
        for (const el of elems!) { // `foreach (e; *elems)` over a container value (06 §1.9)
            if (el !== null && hasNonConstPointers(el))
                return true;
        }
        return false;
    };

    if (e.type!.ty === TY.Terror)
        return false;
    if (e.op === EXP.null_)
        return false;
    const seLit = e.isStructLiteralExp();
    if (seLit !== null) {
        return checkArray(seLit.elements);
    }
    const aeArr = e.isArrayLiteralExp();
    if (aeArr !== null) {
        if (!hasPointers(nextOf(aeArr.type!)!))
            return false;
        return checkArray(aeArr.elements);
    }
    const aeAssoc = e.isAssocArrayLiteralExp();
    if (aeAssoc !== null) {
        if (hasPointers(nextOf(aeAssoc.type!)!) && checkArray(aeAssoc.values))
            return true;
        if (hasPointers(aeAssoc.type!.isTypeAArray()!.index!))
            return checkArray(aeAssoc.keys);
        return false;
    }
    const aeAddr = e.isAddrExp();
    if (aeAddr !== null) {
        if (nextOf(aeAddr.type!)!.isImmutable() || nextOf(aeAddr.type!)!.isConst()) {
            return false;
        }
        const se = aeAddr.e1!.isStructLiteralExp();
        if (se !== null) {
            if ((se.stageflags & StructLiteralExpStageFlags.searchPointers) === 0) {
                const old = se.stageflags;
                se.stageflags |= StructLiteralExpStageFlags.searchPointers;
                const ret = checkArray(se.elements);
                se.stageflags = old;
                return ret;
            } else {
                return false;
            }
        }
        return true;
    }
    if (e.type!.ty === TY.Tpointer && e.type!.isPtrToFunction() === null) {
        if (e.op === EXP.symbolOffset) // address of a global is OK
            return false;
        if (e.op === EXP.int64) // cast(void *)int is OK
            return false;
        if (e.op === EXP.string_) // "abc".ptr is OK
            return false;
        return true;
    }
    return false;
}

/**
 * dmd/initsem.d:1689 — `Expressions* resolveStructLiteralNamedArgs(...)`.
 *
 * Given the names and values of a `StructInitializer` or `CallExp`,
 * resolve it to a list of expressions to construct a `StructLiteralExp`.
 *
 * Params:
 *     sd = struct
 *     t = type of struct (potentially including qualifiers such as `const` or `immutable`)
 *     sc = scope of the expression initializing the struct
 *     iloc = location of expression initializing the struct
 *     argCount = count of argumnet present
 *     getExp = function that, given an index into `argNames` and destination type, returns the initializing expression
 *     getArgName = function that, given an index into `argNames`, returns the name of argument for error messages
 *     getArgLoc = function that, given an index into `argNames`, returns a location of argument for error messages
 *     getNameLoc = function that, given an index into `argNames`, returns a location of that `name` for error messages
 *
 * Returns: list of expressions ordered to the struct's fields, or `null` on error
 *
 * The four `scope ... delegate(...)` parameters become plain closures (04 §4.1); `scope` erases
 * (04 §8). `getArgName` is typed `Identifier | null` because the body null-TESTS its result
 * (:1711); `getExp`'s result is dereferenced unconditionally (:1803) so it stays non-null
 * (02 §10.1).
 */
export function resolveStructLiteralNamedArgs(
    sd: StructDeclaration,
    t: Type,
    sc: Scope,
    iloc: Loc,
    argCount: number,
    getArgName: (i: number) => Identifier | null,
    getExp: (i: number, fieldType: Type) => Expression,
    getArgLoc: (i: number) => Loc,
    getNameLoc: (i: number) => Loc,
): Expressions | null {
    //expandTuples for non-identity arguments?
    const nfields = sd.nonHiddenFields();
    const elements: Expressions = new DArray<Expression | null>(nfields);
    // initsem.d:1698 — `auto elems = (*elements)[];` is a MUTATING slice ALIAS: every
    // `elems[fieldi] = …` below must be visible through `elements`, which is what this function
    // RETURNS. `Array.opSlice()` returns a COPY in the port (array.ts, 08 §2.0), so the aliasing
    // spelling is `tdata()` — the live backing store, whose doc states mutations are visible on
    // the `Array`. `elements.length === nfields === tdata().length`, so the two cover the same range.
    const elems = elements.tdata();
    for (let z = 0; z < elems.length; z++) // `foreach (ref elem; elems) elem = null;`
        elems[z] = null;

    // Run semantic for explicitly given initializers
    // TODO: this part is slightly different from StructLiteralExp::semantic.
    let errors = false;
    let fieldi = 0;
    for (let j = 0; j < argCount; j++) { // `foreach (j; 0 .. argCount)`
        const argLoc = getArgLoc(j);     // `Loc` is an ALIAS-SAFE REGISTER member (03 §9.1)
        const nameLoc = getNameLoc(j);
        const id = getArgName(j);
        if (id !== null) {
            // Determine `fieldi` that `id` matches
            // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred
            // (bool) — 02 §11.5; the runtime object IS a Dsymbol, nothing is reinterpreted.
            const sdAsDsymbol = sd as unknown as Dsymbol;
            let s: Dsymbol | null = search(sdAsDsymbol, iloc, id); // UFCS -> dmd/dsymbolsem.d:7535 (04 §6.1)
            if (s === null) {
                s = search_correct(sdAsDsymbol, id);
                if (s !== null)
                    error(nameLoc, ds("`%s` is not a member of `%s`, did you mean %s `%s`?"),
                        id.toChars(), sd.toChars(), s.kind(), s.toChars());
                else
                    error(nameLoc, ds("`%s` is not a member of `%s`"), id.toChars(), sd.toChars());
                return null;
            }
            checkDeprecated(s, iloc, sc);
            s = toAlias(s);

            // Find out which field index `s` is
            for (fieldi = 0; ; fieldi++) { // `for (fieldi = 0; 1; fieldi++)`
                if (fieldi >= nfields) {
                    error(iloc, ds("`%s.%s` is not a per-instance initializable field"), sd.toChars(), s.toChars());
                    return null;
                }
                if (s === sd.fields.opIndex(fieldi)) // class-reference identity stays `===` (05 §2)
                    break;
            }
        }
        if (nfields === 0) {
            error(argLoc, ds("initializer provided for struct `%s` with no fields"), sd.toChars());
            return null;
        }
        if (j >= nfields) {
            error(argLoc, ds("too many initializers for `%s` with %d field%s"), sd.toChars(),
                nfields | 0, nfields !== 1 ? ds("s") : ds(""));
            return null;
        }
        if (fieldi >= nfields) {
            error(argLoc, ds("trying to initialize past the last field `%s` of `%s`"),
                sd.fields.opIndex(nfields - 1)!.toChars(), sd.toChars());
            return null;
        }

        const vd: VarDeclaration = sd.fields.opIndex(fieldi)!;
        if (elems[fieldi] !== null) {
            error(argLoc, ds("duplicate initializer for field `%s`"), vd.toChars());
            errors = true;
            elems[fieldi] = ErrorExp.get(); // for better diagnostics on multiple errors
            ++fieldi;
            continue;
        }

        // Check for @safe violations
        if (hasPointers(vd.type!)) { // `vd.type.hasPointers` — UFCS, no-paren call (04 §6, §9)
            if ((!alignment(t).isDefault() && alignment(t).get() < target.ptrsize ||
                    ((vd.offset & (target.ptrsize - 1)) !== 0))) {
                if (setUnsafe(sc, false, argLoc, ds("field `%s.%s` assigning to misaligned pointers"), sd, vd)) {
                    errors = true;
                    elems[fieldi] = ErrorExp.get(); // for better diagnostics on multiple errors
                    ++fieldi;
                    continue;
                }
            }
        }

        // Check for overlapping initializations (can happen with unions)
        for (const [k, v2] of sd.fields.opSlice(0, nfields).entries()) {
            // initsem.d:1786 — `vd.isOverlappedWith(v2)` is UFCS for the free function at
            // dmd/dsymbolsem.d:843 (04 §6). `v2!` is a narrowing artifact: D's `sd.fields` holds
            // non-null `VarDeclaration`s (the port widens the container element type).
            if (isOverlappedWith(vd, v2!) && elems[k] !== null) {
                error(elems[k]!.loc, ds("overlapping initialization for field `%s` and `%s`"),
                    v2!.toChars(), vd.toChars());
                // initsem.d:1789 — `enum errorMsg = "..." ~ "..." ~ "...";` — a manifest constant
                // whose CTFE concatenation is folded at translation time (07 §9).
                const errorMsg = ds("`struct` initializers that contain anonymous unions" +
                    " must initialize only the first member of a `union`. All subsequent" +
                    " non-overlapping fields are default initialized");
                if (sd.isUnionDeclaration() === null)
                    errorSupplemental(elems[k]!.loc, errorMsg); // `.errorSupplemental` — module scope
                errors = true;
                continue;
            }
        }

        assert(sc !== null);

        const ex = getExp(j, vd.type!);

        if (ex.op === EXP.error) {
            errors = true;
            elems[fieldi] = ErrorExp.get(); // for better diagnostics on multiple errors
            ++fieldi;
            continue;
        }

        elems[fieldi] = doCopyOrMove(sc, ex, null, false);
        ++fieldi;
    }
    if (errors)
        return null;

    return elements;
}
