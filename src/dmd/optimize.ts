// Ported from dmd/optimize.d (module dmd.optimize) — "Perform constant folding."
//
// FULL-FILE TRANSLATION (P5.0 wave 10). Every top-level D declaration of optimize.d is present here, in
// SOURCE ORDER, translated / walled (11 §2.5) / dropped-with-comment (07): `expandVar` (:47),
// `fromConstInitializer` (:182), the two `setLengthVarIfKnown` overloads (:220, :249) and `optimize`
// (:274). optimize.d has no `unittest` blocks.
//
// IDIOM B (13 §7.5). `grep -c 'class .*Visitor' dmd/optimize.d` -> 0: `optimize` is a free function whose
// body declares nested `visitXxx` functions and ends with a hand-written dispatch `switch (ex.op)`
// (optimize.d:1405) inside the fixed-point `while (1)` loop. The switch is emitted IN FULL — every `case`
// and the `default` — and each case routes to its named nested visitor. Nested visitors keep their D names
// verbatim (`visitNop` is D's own name for the NotExp visitor).
//
// OVERLOAD SET RESOLVED (04 §1 Form B, rule 1 + rule 3): `setLengthVarIfKnown(VarDeclaration, Expression)`
// (:220) and `setLengthVarIfKnown(VarDeclaration, Type)` (:249) are same-arity, split on a later parameter's
// type. The CROSS-MODULE D callers (expressionsem.d:11314, :11784) select the `Type` form, so it keeps the
// bare name; the in-module `Expression` form is `setLengthVarIfKnownFromExpression`.
//
// CONSTANT FOLDING. Every fold calls its constfold.ts entry at D's own call position with D's own arguments and
// takes D's trailing `.copy()` on the returned `UnionExp` (02 §11.1); each site cites the callee's definition line.
//
// REF PARAMETERS. `expOptimize(ref Expression e, ...)` is D's in-place operand rewrite, and every call binds
// the `ref` to a SLOT inside a node (`e.e1`, `(*e.elements)[i]`, `v.edtor`, ...). It is ported with the
// §7.3 accessor pair (03-value-semantics.md): a `Slot` whose `get`/`set` close over the owner, so the slot is
// written exactly when D writes it (`e = ex;` on success only).
//
// COMPILE-TIME RESOLUTION (07): every `//printf` line is a D comment — nothing to resolve. The one
// `version (all) { ... } else { ... }` (optimize.d:164) resolves ON; its `else` arm is dead text, dropped at
// the site.

import { assert, assertUnreachable } from "../assert.js";
import { ds } from "../dstring.js";
import { toUint64, toInt64 } from "../numeric.js";

import {
    Expression, ErrorExp, IntegerExp, AddrExp, CommaExp, SymOffExp, AddExp, CastExp, CatExp, CTFEExp,
    WANTvalue, WANTexpand, StructLiteralExpStageFlags,
} from "./expression.js";
import type {
    UnaExp, BinExp, BinAssignExp, CatAssignExp, AssignExp, VarExp, TupleExp, ArrayLiteralExp,
    AssocArrayLiteralExp, StructLiteralExp, NegExp, ComExp, NotExp, PtrExp, DotVarExp, NewExp, CallExp,
    MinExp, MulExp, DivExp, ModExp, ShlExp, ShrExp, UshrExp, AndExp, OrExp, XorExp, PowExp,
    ArrayLengthExp, EqualExp, IdentityExp, IndexExp, SliceExp, LogicalExp, CmpExp, CondExp,
} from "./expression.js";
import { Type, SIZE_INVALID } from "./mtype.js";
import type { Parameter } from "./mtype.js"; // type-only: the return type of ParameterList.opIndex
import { ExpInitializer } from "./init.js";
import type { VarDeclaration } from "./declaration.js";
import { Loc } from "./location.js";
import type { dinteger_t, sinteger_t } from "./globals.js";
// reconciled to faithful surface (W2): DMD 2.113 moved `calledFunctionType` from expression.d into
// expressionsem.d:315.
import {
    calledFunctionType, castToSinteger, expressionSemantic, toInteger, toReal, toBool, isLvalue, getField,
    getConstInitializer,
} from "./expressionsem.js";
import { EXP } from "./tokens.js";
import { STC, TY, MATCH, Sizeok } from "./astenums.js";
import { ClassKind } from "./aggregate.js";
import { PASS } from "./dsymbol.js";
import type { Dsymbol } from "./dsymbol.js";
import { global } from "./globals.js";
import { error, errorSupplemental } from "./errors.js";
import {
    toBasetype, isScalar, size, nextOf, equivalent, pointerTo, arrayOf, mutableOf, unSharedOf, isIntegral,
    isFloating,
} from "./typesem.js";
import { castTo, implicitConvTo, implicitCastTo, implicitConvToType } from "./dcast.js";
import { hasSideEffect } from "./sideeffect.js";
import {
    Neg, Com, Not, Add, Min, Mul, Div, Mod, Pow, Shl, Shr, Ushr, And, Or, Xor, Equal, Identity, Cmp, Cast, ArrayLength,
    Index, Slice, Cat, Ptr,
} from "./constfold.js";
import type { UnionExp } from "./ctfeexpr.js"; // type-only: the return type of shift_optimize's `shift`
// last (01 §4.8): value reads of dsymbolsem / dclass happen only inside function bodies; naming them after the
// node modules keeps this module from becoming the SCC entry through a semantic pass.
import { dsymbolSemantic, sizeDsymbol } from "./dsymbolsem.js";
import { ClassDeclaration } from "./dclass.js"; // value: visitCast reads the static `ClassDeclaration.object`
import { registerOptimize, initializerToChars } from "./hdrgen.js";

/// The accessor pair for a D `ref Expression` parameter bound to a slot inside a node (03 §7.3):
/// `get` reads the slot, `set` writes it. D's `expOptimize` assigns through the `ref` only on success.
interface Slot {
    get(): Expression | null;
    set(v: Expression): void;
}

/// The canonical box for a D `ref`/`out` scalar or local (03 §3.3 / §7.2).
interface Ref<T> {
    value: T;
}

/**
 * 08 runtime shim: `core.checkedint.mulu(ulong, ulong, ref bool overflow)` — D's function-local
 * `import core.checkedint : mulu;` (optimize.d:592, :632, :667), a runtime intrinsic, not a module
 * (01 §3.7). Multiplies two 64-bit unsigned values, SETTING `overflow.value` when the mathematical product
 * does not fit in 64 bits (never clearing it). `ulong` -> the bigint domain (09 §1); the product is formed
 * exactly and re-truncated (09 §3). Same shape as typesem.ts's file-local shim, which reports the
 * numeric.ts candidate.
 */
function mulu(x: bigint, y: bigint, overflow: Ref<boolean>): bigint {
    const r = x * y;
    if (r > 0xFFFF_FFFF_FFFF_FFFFn)
        overflow.value = true;
    return BigInt.asUintN(64, r);
}

/*************************************
 * dmd/optimize.d:47 — `Expression expandVar(int result, VarDeclaration v)`.
 *
 * If variable has a const initializer, return that initializer.
 * Returns: initializer if there is one, null if not, ErrorExp if error.
 *
 * `v` is null-tested -> `VarDeclaration | null` (02 §10.1). May run `dsymbolSemantic(v, null)` on a
 * variable whose semantic has not run, and cast/optimize a copy of its initializer; `v.inuse` guards the
 * recursive-initialization case.
 */
export function expandVar(result: number, v: VarDeclaration | null): Expression | null {
    //printf("expandVar(result = %d, v = %p, %s)\n", result, v, v ? v.toChars() : "null");

    /********
     * Params:
     *  e = initializer expression
     */
    // Called only after the `if (!v)` early-out below: `v!` marks the point D would fault on null.
    const initializerReturn = (e: Expression): Expression => {
        if (e.type !== v!.type) {
            e = castTo(e, null, v!.type!);
        }
        v!.inuse++;
        // Paired state (11 §2.5): D releases with a plain `v.inuse--;` at region end (optimize.d:63) and has no
        // other exit; `optimize` reaches constfold walls, so that one statement moves into `finally`.
        try {
            e = optimize(e, result);
        } finally {
            v!.inuse--;
        }
        //if (e) printf("\te = %p, %s, e.type = %d, %s\n", e, e.toChars(), e.type.ty, e.type.toChars());
        return e;
    };

    const nullReturn = (): Expression | null => {
        return null;
    };

    const errorReturn = (): Expression | null => {
        return ErrorExp.get();
    };

    if (v === null)
        return nullReturn();
    if (v.originalType === null && v.semanticRun < PASS.semanticdone) // semantic() not yet run
        dsymbolSemantic(v, null);
    if (v.type !== null &&
        (v.isConst() || v.isImmutable() || (v.storage_class & STC.manifest) !== 0n)) {
        const tb = toBasetype(v.type);
        if ((v.storage_class & STC.manifest) !== 0n ||
            isScalar(tb) ||
            ((result & WANTexpand) !== 0 && (tb.ty !== TY.Tsarray && tb.ty !== TY.Tstruct))) {
            if (v._init !== null) {
                if (v.inuse !== 0) {
                    if ((v.storage_class & STC.manifest) !== 0n) {
                        error(v.loc, ds("%s `%s` recursive initialization of constant"), v.kind(), v.toPrettyChars());
                        return errorReturn();
                    }
                    return nullReturn();
                }
                let ei = getConstInitializer(v);
                if (ei === null) {
                    if ((v.storage_class & STC.manifest) !== 0n) {
                        // D's `dmd.hdrgen.toChars(v._init)` is the `const Initializer` overload (hdrgen.d:212), which
                        // hdrgen.ts exports as `initializerToChars` (the Form-B receiver split, 04 §6.1).
                        error(v.loc, ds("%s `%s` enum cannot be initialized with `%s`"), v.kind(), v.toPrettyChars(),
                            initializerToChars(v._init));
                        return errorReturn();
                    }
                    return nullReturn();
                }
                if (ei.op === EXP.construct || ei.op === EXP.blit) {
                    // D: `cast(AssignExp)ei` — the tag test `op == construct || op == blit` on the line above
                    // proves an AssignExp subclass (ConstructExp / BlitExp), which the op-keyed
                    // `isAssignExp()` (EXP.assign only) cannot express (02 §11.5c item 3).
                    const ae = ei as unknown as AssignExp;
                    ei = ae.e2!;
                    if (ei.isConst() === 1) {
                        // nothing: a constant initializer passes straight through
                    } else if (ei.op === EXP.string_) {
                        // https://issues.dlang.org/show_bug.cgi?id=14459
                        // Do not constfold the string literal
                        // if it's typed as a C string, because the value expansion
                        // will drop the pointer identity.
                        if ((result & WANTexpand) === 0 && toBasetype(ei.type!).ty === TY.Tpointer)
                            return nullReturn();
                    } else
                        return nullReturn();
                    if (ei.type === v.type) {
                        // const variable initialized with const expression
                    } else if (implicitConvTo(ei, v.type) >= MATCH.constant) {
                        // const var initialized with non-const expression
                        ei = implicitCastTo(ei, null, v.type);
                        ei = expressionSemantic(ei, null); // D passes a null Scope; `sc` is nullable there (02 §10.1)
                    } else
                        return nullReturn();
                } else if ((v.storage_class & STC.manifest) === 0n &&
                           ei.isConst() !== 1 &&
                           ei.op !== EXP.string_ &&
                           ei.op !== EXP.address) {
                    return nullReturn();
                }

                if (ei.type === null) {
                    return nullReturn();
                } else {
                    // Should remove the copy() operation by
                    // making all mods to expressions copy-on-write
                    return initializerReturn(ei.copy());
                }
            } else {
                // v does not have an initializer
                // resolved: `version (all)` -> ON (07); the `else` arm (optimize.d:168-174, the
                // `v.type.defaultInit()` expansion marked "BUG: what if const is initialized in constructor?")
                // is dead text — dropped.
                return nullReturn();
            }
            assertUnreachable(); // D: `assert(0);` (optimize.d:176)
        }
    }
    return nullReturn();
}

/// dmd/optimize.d:182 — `private Expression fromConstInitializer(int result, Expression e1)`.
/// Module-private in D: not exported. Replaces a reference to a const variable with (a painted copy of)
/// its expanded initializer; returns `e1` unchanged when there is none.
function fromConstInitializer(result: number, e1: Expression): Expression {
    //printf("fromConstInitializer(result = %x, %s)\n", result, e1.toChars());
    //static int xx; if (xx++ == 10) assert(0);
    const ve = e1.isVarExp();
    if (ve === null)
        return e1;

    let e: Expression | null = e1;
    const v = ve.var_.isVarDeclaration();
    e = expandVar(result, v);
    if (e === null)
        return e1;

    // If it is a comma expression involving a declaration, we mustn't
    // perform a copy -- we'd get two declarations of the same variable.
    // See https://issues.dlang.org/show_bug.cgi?id=4465.
    if (e.op === EXP.comma && e.isCommaExp()!.e1!.isDeclarationExp() !== null)
        e = e1;
    else if (e.type !== e1.type && e1.type !== null && e1.type.ty !== TY.Tident) {
        // Type 'paint' operation
        e = e.copy();
        e.type = e1.type;
    }
    e.loc = e1.loc;

    return e;
}

/***
 * dmd/optimize.d:220 — `package void setLengthVarIfKnown(VarDeclaration lengthVar, Expression arr)`.
 * Form-B rename of the `Expression` overload (see the file header): `setLengthVarIfKnownFromExpression`.
 *
 * It is possible for constant folding to change an array expression of
 * unknown length, into one where the length is known.
 * If the expression 'arr' is a literal, set lengthVar to be its length.
 * Params:
 *    lengthVar = variable declaration for the `.length` property (null-tested: nothing to do)
 *    arr = String, ArrayLiteral, or of TypeSArray
 * Postcondition: when the length is known and `lengthVar` has no non-void initializer yet, `lengthVar._init`
 * becomes `ExpInitializer(IntegerExp(len, size_t))` and `lengthVar` gains `static const`.
 */
export function setLengthVarIfKnownFromExpression(lengthVar: VarDeclaration | null, arr: Expression): void {
    if (lengthVar === null)
        return;
    if (lengthVar._init !== null && lengthVar._init.isVoidInitializer() === null)
        return; // we have previously calculated the length
    let len: dinteger_t;
    const se = arr.isStringExp();
    if (se !== null)
        len = BigInt(se.len);
    else {
        const ale = arr.isArrayLiteralExp();
        if (ale !== null)
            len = BigInt(ale.elements!.length);
        else {
            const tsa = toBasetype(arr.type!).isTypeSArray();
            if (tsa === null)
                return; // we don't know the length yet
            len = toInteger(tsa.dim!);
        }
    }
    const dollar: Expression = new IntegerExp(Loc.initial, len, Type.tsize_t);
    lengthVar._init = new ExpInitializer(Loc.initial, dollar);
    lengthVar.storage_class = (lengthVar.storage_class | STC.static_ | STC.const_) as STC;
}

/***
 * dmd/optimize.d:249 — `package void setLengthVarIfKnown(VarDeclaration lengthVar, Type type)`.
 * Keeps the bare name: it is the overload the cross-module D callers select (expressionsem.d:11314, :11784).
 *
 * Same as above, but determines the length from 'type'.
 * Params:
 *    lengthVar = variable declaration for the `.length` property (null-tested: nothing to do)
 *    type = TypeSArray
 */
export function setLengthVarIfKnown(lengthVar: VarDeclaration | null, type: Type): void {
    if (lengthVar === null)
        return;
    if (lengthVar._init !== null && lengthVar._init.isVoidInitializer() === null)
        return; // we have previously calculated the length
    const tsa = toBasetype(type).isTypeSArray();
    if (tsa === null)
        return; // we don't know the length yet
    const len = toInteger(tsa.dim!);
    const dollar: Expression = new IntegerExp(Loc.initial, len, Type.tsize_t);
    lengthVar._init = new ExpInitializer(Loc.initial, dollar);
    lengthVar.storage_class = (lengthVar.storage_class | STC.static_ | STC.const_) as STC;
}

/*********************************
 * dmd/optimize.d:274 — `Expression optimize(Expression e, int result, bool keepLvalue = false)`.
 * Constant fold an Expression.
 *
 * Params:
 *   e          = expression to const fold; this may get modified in-place
 *   result     = `WANTvalue`, `WANTexpand`, or both (bitmask)
 *   keepLvalue = `e` is an lvalue, and keep it as an lvalue since it is an argument to a `ref` or `out`
 *                parameter, or the operand of `&` operator
 * Returns: constant folded version of `e`.
 *
 * Cost: re-dispatches until a fixed point (`ex == ret`), bounded by `global.recursionLimit` (then
 * "infinite loop while optimizing expression" + ErrorExp). Operands are optimized recursively and rewritten
 * in place. Folds go through constfold.ts (see the file header).
 */
export function optimize(e: Expression, result: number, keepLvalue = false): Expression {
    //printf("optimize() e: %s result: %d keepLvalue %d\n", e.toChars(), result, keepLvalue);
    // Nullable: `visitComma` stores `e.e2` and null-tests it (optimize.d:1126-1128).
    let ret: Expression | null = e;

    const errorReturn = (): void => {
        ret = ErrorExp.get();
    };

    /* Returns: true if error
     */
    // `ref Expression e` -> the accessor pair `e` (03 §7.3); `e` and `keepLvalue` shadow the outer ones as in D.
    const expOptimize = (e: Slot, flags: number, keepLvalue = false): boolean => {
        if (e.get() === null)
            return false;
        const ex = optimize(e.get()!, flags, keepLvalue);
        if (ex.op === EXP.error) {
            ret = ex; // store error result
            return true;
        } else {
            e.set(ex); // modify original
            return false;
        }
    };

    const unaOptimize = (e: UnaExp, flags: number): boolean => {
        return expOptimize({ get: () => e.e1, set: (x) => { e.e1 = x; } }, flags);
    };

    // D's bitwise `|` (not `||`): both operands are always optimized, even after an lhs error.
    const binOptimize = (e: BinExp, flags: number, keepLhsLvalue = false): boolean => {
        const err1 = expOptimize({ get: () => e.e1, set: (x) => { e.e1 = x; } }, flags, keepLhsLvalue);
        const err2 = expOptimize({ get: () => e.e2, set: (x) => { e.e2 = x; } }, flags);
        return err1 || err2;
    };

    const visitExp = (_e: Expression): void => {
        //printf("Expression::optimize(result = x%x) %s\n", result, e.toChars());
    };

    const visitVar = (e: VarExp): void => {
        const v = e.var_.isVarDeclaration();

        if (!(keepLvalue && v !== null && (v.storage_class & STC.manifest) === 0n))
            ret = fromConstInitializer(result, e);

        // if unoptimized, try to optimize the dtor expression
        // (e.g., might be a LogicalExp with constant lhs)
        if (ret === e && v !== null && v.edtor !== null) {
            // prevent infinite recursion (`<var>.~this()`)
            if (v.inuse === 0) {
                v.inuse++;
                // Paired state (11 §2.5): the plain `v.inuse--;` (optimize.d:335) moves into `finally` — the
                // region reaches constfold walls through `optimize`.
                try {
                    expOptimize({ get: () => v.edtor, set: (x) => { v.edtor = x; } }, WANTvalue);
                } finally {
                    v.inuse--;
                }
            }
        }
    };

    const visitTuple = (e: TupleExp): void => {
        expOptimize({ get: () => e.e0, set: (x) => { e.e0 = x; } }, WANTvalue);
        const exps = e.exps!;
        for (let i = 0; i < exps.length; i++) {
            expOptimize({ get: () => exps.opIndex(i), set: (x) => { exps.opIndexAssign(x, i); } }, WANTvalue);
        }
    };

    const visitArrayLiteral = (e: ArrayLiteralExp): void => {
        if (e.elements !== null) {
            expOptimize({ get: () => e.basis, set: (x) => { e.basis = x; } }, result & WANTexpand);
            const elements = e.elements;
            for (let i = 0; i < elements.length; i++) {
                expOptimize({ get: () => elements.opIndex(i), set: (x) => { elements.opIndexAssign(x, i); } },
                    result & WANTexpand);
            }
        }
    };

    const visitAssocArrayLiteral = (e: AssocArrayLiteralExp): void => {
        assert(e.keys!.length === e.values!.length);
        const keys = e.keys!;
        const values = e.values!;
        for (let i = 0; i < keys.length; i++) {
            expOptimize({ get: () => keys.opIndex(i), set: (x) => { keys.opIndexAssign(x, i); } }, result & WANTexpand);
            expOptimize({ get: () => values.opIndex(i), set: (x) => { values.opIndexAssign(x, i); } },
                result & WANTexpand);
        }
    };

    const visitStructLiteral = (e: StructLiteralExp): void => {
        if ((e.stageflags & StructLiteralExpStageFlags.optimize) !== 0)
            return;
        const old = e.stageflags;
        e.stageflags |= StructLiteralExpStageFlags.optimize;
        // Paired state (11 §2.5): the flag set above is restored by the plain `e.stageflags = old;` at region
        // end (optimize.d:384); element optimization reaches constfold walls, so the restore moves into `finally`.
        try {
            if (e.elements !== null) {
                const elements = e.elements;
                for (let i = 0; i < elements.length; i++) {
                    expOptimize({ get: () => elements.opIndex(i), set: (x) => { elements.opIndexAssign(x, i); } },
                        result & WANTexpand);
                }
            }
        } finally {
            e.stageflags = old;
        }
    };

    const visitUna = (e: UnaExp): void => {
        //printf("UnaExp::optimize() %s\n", e.toChars());
        if (unaOptimize(e, result))
            return;
    };

    const visitNeg = (e: NegExp): void => {
        if (unaOptimize(e, result))
            return;
        if (e.e1!.isConst() === 1) {
            ret = Neg(e.type!, e.e1!).copy(); // dmd/constfold.d:69
        }
    };

    const visitCom = (e: ComExp): void => {
        if (unaOptimize(e, result))
            return;
        if (e.e1!.isConst() === 1) {
            ret = Com(e.type!, e.e1!).copy(); // dmd/constfold.d:92
        }
    };

    const visitNop = (e: NotExp): void => {
        if (unaOptimize(e, result))
            return;
        if (e.e1!.isConst() === 1) {
            ret = Not(e.type!, e.e1!).copy(); // dmd/constfold.d:100
        }
    };

    const visitSymOff = (e: SymOffExp): void => {
        assert(e.var_ !== null);
    };

    const visitAddr = (e: AddrExp): void => {
        //printf("AddrExp::optimize(result = %d, keepLvalue = %d) %s\n", result, keepLvalue, e.toChars());
        /* Rewrite &(a,b) as (a,&b)
         */
        const ce = e.e1!.isCommaExp();
        if (ce !== null) {
            const ae = new AddrExp(e.loc, ce.e2, e.type);
            ret = new CommaExp(ce.loc, ce.e1, ae);
            ret.type = e.type;
            return;
        }
        // Keep lvalue-ness
        if (expOptimize({ get: () => e.e1, set: (x) => { e.e1 = x; } }, result, true))
            return;                     // error return

        // Convert &*ex to ex
        const pe = e.e1!.isPtrExp();
        if (pe !== null) {
            const ex = pe.e1!;
            if (e.type!.equals(ex.type))
                ret = ex;
            else if (equivalent(toBasetype(e.type!), toBasetype(ex.type!))) {
                ret = ex.copy();
                ret.type = e.type;
            }
            return;
        }
        const ve = e.e1!.isVarExp();
        if (ve !== null) {
            if (!ve.var_.isReference() && !ve.var_.isImportedSymbol()) {
                let hasOverloads = ve.hasOverloads;
                const v = ve.var_.isVarDeclaration();
                if (v !== null) {
                    if (v.needThis()) {
                        const t = v.isThis();
                        assert(t !== null);
                        error(e.loc, ds("taking the address of non-static variable `%s` requires an instance of `%s`"),
                            v.toChars(), t.toChars());
                        ret = ErrorExp.get();
                        return;
                    }
                    hasOverloads = false;
                }
                ret = new SymOffExp(e.loc, ve.var_, 0n, hasOverloads);
                ret.type = e.type;
                return;
            }
        }
        if (e.e1!.isDotVarExp() !== null) {
            /******************************
             * Run down the left side of the a.b.c expression to determine the
             * leftmost variable being addressed (`a`), and accumulate the offsets of the `.b` and `.c`.
             * Params:
             *      e = the DotVarExp or VarExp
             *      var = set to the VarExp at the end, or null if doesn't end in VarExp
             *      eint = set to the IntegerExp at the end, or null if doesn't end in IntegerExp
             *      offset = accumulation of all the .var offsets encountered
             * Returns: true on error
             */
            // `out VarDeclaration var, out IntegerExp eint` -> boxes; D resets `out` parameters on entry
            // (03 §3.3). `ref uint offset` -> a box, NOT reset. `uint` arithmetic wraps mod 2^32 (09 §3).
            const getVarAndOffset = (e: Expression, var_: Ref<VarDeclaration | null>, eint: Ref<IntegerExp | null>,
                                     offset: Ref<number>): boolean => {
                var_.value = null;
                eint.value = null;
                if (size(e.type!) === SIZE_INVALID)  // trigger computation of v.offset
                    return true;

                const dve = e.isDotVarExp();
                if (dve !== null) {
                    const v = dve.var_.isVarDeclaration();
                    if (v === null || !v.isField() || v.isBitFieldDeclaration() !== null)
                        return false;

                    if (getVarAndOffset(dve.e1!, var_, eint, offset))
                        return true;
                    offset.value = (offset.value + v.offset) >>> 0;
                } else {
                    const ve = e.isVarExp();
                    if (ve !== null) {
                        if (!ve.var_.isReference() &&
                            !ve.var_.isImportedSymbol() &&
                            ve.var_.isDataseg() &&
                            ve.var_.isCsymbol()) {
                            var_.value = ve.var_.isVarDeclaration();
                        }
                    } else {
                        const ep = e.isPtrExp();
                        if (ep !== null) {
                            const ei = ep.e1!.isIntegerExp();
                            if (ei !== null) {
                                eint.value = ei;
                            } else {
                                const se = ep.e1!.isSymOffExp();
                                if (se !== null) {
                                    if (!se.var_.isReference() &&
                                        !se.var_.isImportedSymbol() &&
                                        se.var_.isDataseg()) {
                                        var_.value = se.var_.isVarDeclaration();
                                        // D `offset += se.offset;` — `uint += ulong` narrows to the low 32 bits.
                                        offset.value = Number(BigInt.asUintN(32, BigInt(offset.value) + se.offset));
                                    }
                                }
                            }
                        } else {
                            const ei = e.isIndexExp();
                            if (ei !== null) {
                                const ve = ei.e1!.isVarExp();
                                if (ve !== null) {
                                    if (!ve.var_.isReference() &&
                                        !ve.var_.isImportedSymbol() &&
                                        ve.var_.isDataseg() &&
                                        ve.var_.isCsymbol()) {
                                        const ie = ei.e2!.isIntegerExp();
                                        if (ie !== null) {
                                            var_.value = ve.var_.isVarDeclaration();
                                            // D `offset += ie.toInteger() * ...size();` — the ulong product
                                            // wraps mod 2^64, then `uint +=` keeps the low 32 bits.
                                            const prod = toUint64(toInteger(ie) * size(nextOf(toBasetype(ve.type!))!));
                                            offset.value = Number(BigInt.asUintN(32, BigInt(offset.value) + prod));
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                return false;
            };

            const offset: Ref<number> = { value: 0 };
            const var_: Ref<VarDeclaration | null> = { value: null };
            const eint: Ref<IntegerExp | null> = { value: null };
            if (getVarAndOffset(e.e1!, var_, eint, offset)) {
                ret = ErrorExp.get();
                return;
            }
            if (var_.value !== null) {
                ret = new SymOffExp(e.loc, var_.value, BigInt(offset.value), false);
                ret.type = e.type;
                return;
            }
            if (eint.value !== null) {
                // D: `eint.toInteger() + offset` — ulong + uint, wrapping mod 2^64.
                ret = new IntegerExp(e.loc, toUint64(toInteger(eint.value) + BigInt(offset.value)), e.type!);
                return;
            }
        } else {
            const ae = e.e1!.isIndexExp();
            if (ae !== null) {
                if (ae.e2!.isIntegerExp() !== null && ae.e1!.isIndexExp() !== null) {
                    /* Rewrite `(a[i])[index]` to `(&a[i]) + index*size`
                     */
                    const index: sinteger_t = toInt64(toInteger(ae.e2!));
                    const ae1 = ae.e1!.isIndexExp()!;          // ae1 is a[i]
                    const ts = ae1.type!.isTypeSArray();
                    if (ts !== null) {
                        const dim: sinteger_t = toInt64(toInteger(ts.dim!));

                        if (index < 0n || index > dim) {
                            error(e.loc, ds("array index %lld is out of bounds `[0..%lld]`"), index, dim);
                            return errorReturn();
                        }

                        // import core.checkedint : mulu;  (the file-local `mulu` shim above)
                        const overflow: Ref<boolean> = { value: false };
                        // `index` is non-negative here, so its conversion to mulu's ulong keeps the value.
                        const offset = mulu(toUint64(index), size(nextOf(ts)!, e.loc), overflow); // offset = index*size
                        if (overflow.value) {
                            error(e.loc, ds("array offset overflow"));
                            return errorReturn();
                        }

                        const ex: Expression = new AddrExp(ae1.loc, ae1);  // &a[i]
                        ex.type = pointerTo(ae1.type!);

                        const add: Expression =
                            new AddExp(ae.loc, ex, new IntegerExp(ae.e2!.loc, offset, ae.e2!.type!));
                        add.type = e.type;
                        ret = optimize(add, result, keepLvalue);
                        return;
                    }
                }

                // Convert &array[n] to &array+n
                if (ae.e2!.isIntegerExp() !== null && ae.e1!.isVarExp() !== null) {
                    const index: sinteger_t = toInt64(toInteger(ae.e2!));
                    const ve = ae.e1!.isVarExp()!;
                    if (ve.type!.isTypeSArray() !== null && !ve.var_.isImportedSymbol()) {
                        const ts = ve.type!.isTypeSArray()!;
                        const dim: sinteger_t = toInt64(toInteger(ts.dim!));
                        if (index < 0n || index >= dim) {
                            /* 0 for C static arrays means size is unknown, no need to check,
                             * and address one past the end is OK, too
                             */
                            if (!((dim === 0n || dim === index) && ve.var_.isCsymbol())) {
                                error(e.loc, ds("array index %lld is out of bounds `[0..%lld]`"), index, dim);
                                return errorReturn();
                            }
                        }

                        // import core.checkedint : mulu;  (the file-local `mulu` shim above)
                        const overflow: Ref<boolean> = { value: false };
                        // D converts the (possibly negative, C-symbol) `sinteger_t index` to mulu's ulong.
                        const offset = mulu(toUint64(index), size(nextOf(ts)!, e.loc), overflow);
                        if (overflow.value) {
                            error(e.loc, ds("array offset overflow"));
                            return errorReturn();
                        }

                        ret = new SymOffExp(e.loc, ve.var_, offset);
                        ret.type = e.type;
                        return;
                    }
                }
                // Convert &((a.b)[index]) to (&a.b)+index*elementsize
                else if (ae.e2!.isIntegerExp() !== null && ae.e1!.isDotVarExp() !== null) {
                    const index: sinteger_t = toInt64(toInteger(ae.e2!));
                    const ve = ae.e1!.isDotVarExp()!;
                    if (ve.type!.isTypeSArray() !== null && ve.var_.isField() && ve.e1!.isPtrExp() !== null) {
                        const ts = ve.type!.isTypeSArray()!;
                        const dim: sinteger_t = toInt64(toInteger(ts.dim!));
                        if (index < 0n || index >= dim) {
                            /* 0 for C static arrays means size is unknown, no need to check,
                             * and address one past the end is OK, too
                             */
                            if (!((dim === 0n || dim === index) && ve.var_.isCsymbol())) {
                                error(e.loc, ds("array index %lld is out of bounds `[0..%lld]`"), index, dim);
                                return errorReturn();
                            }
                        }

                        // import core.checkedint : mulu;  (the file-local `mulu` shim above)
                        const overflow: Ref<boolean> = { value: false };
                        // D converts the (possibly negative, C-symbol) `sinteger_t index` to mulu's ulong.
                        const offset = mulu(toUint64(index), size(nextOf(ts)!, e.loc), overflow); // index*elementsize
                        if (overflow.value) {
                            error(e.loc, ds("array offset overflow"));
                            return errorReturn();
                        }

                        const pe = new AddrExp(e.loc, ve);
                        pe.type = e.type;
                        ret = new AddExp(e.loc, pe, new IntegerExp(e.loc, offset, Type.tsize_t));
                        ret.type = e.type;
                        return;
                    }
                }
            }
        }
    };

    const visitPtr = (e: PtrExp): void => {
        //printf("PtrExp::optimize(result = x%x) %s\n", result, e.toChars());
        if (expOptimize({ get: () => e.e1, set: (x) => { e.e1 = x; } }, result))
            return;
        // Convert *&ex to ex
        // But only if there is no type punning involved
        const ey = e.e1!.isAddrExp();
        if (ey !== null) {
            const ex = ey.e1!;
            if (e.type!.equals(ex.type))
                ret = ex;
            else if (equivalent(toBasetype(e.type!), toBasetype(ex.type!))) {
                ret = ex.copy();
                ret.type = e.type;
            }
        }
        if (keepLvalue)
            return;
        // Constant fold *(&structliteral + offset)
        if (e.e1!.op === EXP.add) {
            const ex = Ptr(e.type!, e.e1!).copy(); // dmd/constfold.d:1700
            if (!CTFEExp.isCantExp(ex)) {
                ret = ex;
                return;
            }
        }
        const se = e.e1!.isSymOffExp();
        if (se !== null) {
            const v = se.var_.isVarDeclaration();
            let ex = expandVar(result, v);
            if (ex !== null && ex.isStructLiteralExp() !== null) {
                const sle = ex.isStructLiteralExp()!;
                // D's own narrowing `cast(uint)se.offset` (optimize.d:723): the low 32 bits.
                ex = getField(sle, e.type!, Number(BigInt.asUintN(32, se.offset)));
                if (ex !== null && !CTFEExp.isCantExp(ex)) {
                    ret = ex;
                    return;
                }
            }
        }
    };

    const visitDotVar = (e: DotVarExp): void => {
        //printf("DotVarExp::optimize(result = x%x) %s\n", result, e.toChars());
        if (expOptimize({ get: () => e.e1, set: (x) => { e.e1 = x; } }, result))
            return;
        if (keepLvalue)
            return;
        let ex: Expression | null = e.e1;
        const ve = ex!.isVarExp();
        if (ve !== null) {
            const v = ve.var_.isVarDeclaration();
            ex = expandVar(result, v);
        }
        if (ex !== null && ex.isStructLiteralExp() !== null) {
            const sle = ex.isStructLiteralExp()!;
            const vf = e.var_.isVarDeclaration();
            if (vf !== null && !vf.overlapped) {
                /* https://issues.dlang.org/show_bug.cgi?id=13021
                 * Prevent optimization if vf has overlapped fields.
                 */
                ex = getField(sle, e.type!, vf.offset);
                if (ex !== null && !CTFEExp.isCantExp(ex)) {
                    ret = ex;
                    return;
                }
            }
        }
    };

    const visitNew = (e: NewExp): void => {
        expOptimize({ get: () => e.placement, set: (x) => { e.placement = x; } }, WANTvalue);
        expOptimize({ get: () => e.thisexp, set: (x) => { e.thisexp = x; } }, WANTvalue);
        // Optimize parameters
        if (e.arguments_ !== null) {
            const args = e.arguments_;
            for (let i = 0; i < args.length; i++) {
                expOptimize({ get: () => args.opIndex(i), set: (x) => { args.opIndexAssign(x, i); } }, WANTvalue);
            }
        }
    };

    const visitCall = (e: CallExp): void => {
        //printf("CallExp::optimize(result = %d) %s\n", result, e.toChars());
        // Optimize parameters with keeping lvalue-ness
        if (expOptimize({ get: () => e.e1, set: (x) => { e.e1 = x; } }, result))
            return;
        if (e.arguments_ !== null) {
            // t1 can apparently be void for __ArrayDtor(T) calls
            const tf = calledFunctionType(e);
            if (tf !== null) {
                const args = e.arguments_;
                for (let i = 0; i < args.length; i++) {
                    const p: Parameter | null = tf.parameterList.opIndex(i);
                    const keep = p !== null && p.isReference();
                    expOptimize({ get: () => args.opIndex(i), set: (x) => { args.opIndexAssign(x, i); } },
                        WANTvalue, keep);
                }
            }
        }
    };

    const visitCast = (e: CastExp): void => {
        //printf("CastExp::optimize(result = %d) %s\n", result, e.toChars());
        //printf("from %s to %s\n", e.type.toChars(), e.to.toChars());
        //printf("from %s\n", e.type.toChars());
        //printf("e1.type %s\n", e.e1.type.toChars());
        //printf("type = %p\n", e.type);
        assert(e.type !== null);
        const op1 = e.e1!.op;
        const e1old = e.e1;
        if (expOptimize({ get: () => e.e1, set: (x) => { e.e1 = x; } }, result, keepLvalue))
            return;
        if (!keepLvalue)
            e.e1 = fromConstInitializer(result, e.e1!);
        if (e.e1 === e1old && e.e1!.op === EXP.arrayLiteral && toBasetype(e.type).ty === TY.Tpointer &&
            toBasetype(e.e1!.type!).ty !== TY.Tsarray) {
            // Casting this will result in the same expression, and
            // infinite loop because of Expression::implicitCastTo()
            return; // no change
        }
        if ((e.e1!.op === EXP.string_ || e.e1!.op === EXP.arrayLiteral) &&
            (e.type.ty === TY.Tpointer || e.type.ty === TY.Tarray)) {
            const esz = size(nextOf(e.type)!, e.loc);
            const e1sz = size(nextOf(toBasetype(e.e1!.type!))!, e.e1!.loc);
            if (esz === SIZE_INVALID || e1sz === SIZE_INVALID)
                return errorReturn();

            if (e1sz === esz) {
                // https://issues.dlang.org/show_bug.cgi?id=12937
                // If target type is void array, trying to paint
                // e.e1 with that type will cause infinite recursive optimization.
                if (nextOf(e.type)!.ty === TY.Tvoid)
                    return;
                ret = castTo(e.e1!, null, e.type);
                //printf(" returning1 %s\n", ret.toChars());
                return;
            }
        }

        // Returning e.e1 with changing its type
        const returnE_e1 = (): void => {
            ret = (e1old === e.e1 ? e.e1!.copy() : e.e1);
            ret!.type = e.type;
        };

        if (e.e1!.op === EXP.structLiteral && implicitConvToType(e.e1!.type!, e.type) >= MATCH.constant) {
            //printf(" returning2 %s\n", e.e1.toChars());
            return returnE_e1();
        }
        /* The first test here is to prevent infinite loops
         */
        if (op1 !== EXP.arrayLiteral && e.e1!.op === EXP.arrayLiteral) {
            ret = castTo(e.e1!, null, e.to!);
            return;
        }
        if (e.e1!.op === EXP.null_ &&
            (e.type.ty === TY.Tpointer || e.type.ty === TY.Tclass || e.type.ty === TY.Tarray)) {
            //printf(" returning3 %s\n", e.e1.toChars());
            return returnE_e1();
        }
        if (e.type.ty === TY.Tclass && e.e1!.type!.ty === TY.Tclass) {
            // import dmd.astenums : Sizeok;  import dmd.aggregate : ClassKind;  (hoisted to module scope, 01 §4.4)

            // See if we can remove an unnecessary cast
            const cdfrom = e.e1!.type!.isClassHandle()!;
            const cdto = e.type.isClassHandle()!;
            if (cdfrom.errors || cdto.errors)
                return errorReturn();
            if (cdto === ClassDeclaration.object && cdfrom.classKind === ClassKind.d &&
                cdfrom.isInterfaceDeclaration() === null)
                return returnE_e1();    // can always convert a class to Object
            // Need to determine correct offset before optimizing away the cast.
            // https://issues.dlang.org/show_bug.cgi?id=16980
            // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool) (02 §11.5).
            if (sizeDsymbol(cdfrom as unknown as Dsymbol, e.loc) === SIZE_INVALID)
                return errorReturn();
            assert(cdfrom.sizeok === Sizeok.done);
            assert(cdto.sizeok === Sizeok.done || !cdto.isBaseOf(cdfrom, null));
            const offset: Ref<number> = { value: 0 };
            if (cdto.isBaseOf(cdfrom, offset) && offset.value === 0) {
                //printf(" returning4 %s\n", e.e1.toChars());
                return returnE_e1();
            }
        }
        if (unSharedOf(mutableOf(e.e1!.type!)).equals(unSharedOf(mutableOf(e.to!)))) {
            //printf(" returning5 %s\n", e.e1.toChars());
            return returnE_e1();
        }
        if (e.e1!.isConst() !== 0) {
            if (e.e1!.op === EXP.symbolOffset) {
                if (toBasetype(e.type).ty !== TY.Tsarray) {
                    const esz = size(e.type, e.loc);
                    const e1sz = size(e.e1!.type!, e.e1!.loc);
                    if (esz === SIZE_INVALID ||
                        e1sz === SIZE_INVALID)
                        return errorReturn();

                    if (esz === e1sz)
                        return returnE_e1();
                }
                return;
            }
            if (toBasetype(e.to!).ty !== TY.Tvoid) {
                if (e.e1!.type!.equals(e.type) && e.type.equals(e.to))
                    ret = e.e1;
                else
                    ret = Cast(e.loc, e.type, e.to!, e.e1!).copy(); // dmd/constfold.d:917
            }
        }
        //printf(" returning6 %s\n", ret.toChars());
    };

    const visitBinAssign = (e: BinAssignExp): void => {
        //printf("BinAssignExp::optimize(result = %d) %s\n", result, e.toChars());
        if (binOptimize(e, result, /*keepLhsLvalue*/ true))
            return;
        if (e.op === EXP.leftShiftAssign || e.op === EXP.rightShiftAssign || e.op === EXP.unsignedRightShiftAssign) {
            if (e.e2!.isConst() === 1) {
                const i2: sinteger_t = toInt64(toInteger(e.e2!));
                let sz = size(e.e1!.type!, e.e1!.loc);
                assert(sz !== SIZE_INVALID);
                sz = toUint64(sz * 8n);
                // `i2 < 0` is tested first, so D's signed/unsigned `i2 >= sz` compares a non-negative value.
                if (i2 < 0n || i2 >= sz) {
                    error(e.loc, ds("shift assign by %lld is outside the range `0..%llu`"), i2, toUint64(sz - 1n));
                    return errorReturn();
                }
            }
        }
    };

    const visitCatAssign = (e: CatAssignExp): void => {
        const lowering = e.lowering;
        if (lowering !== null)
            optimize(lowering, result, keepLvalue);
        else
            visitBinAssign(e);
    };

    const visitBin = (e: BinExp): void => {
        //printf("BinExp::optimize(result = %d) %s\n", result, e.toChars());
        const keepLhsLvalue = e.op === EXP.construct || e.op === EXP.blit || e.op === EXP.assign
            || e.op === EXP.plusPlus || e.op === EXP.minusMinus
            || e.op === EXP.prePlusPlus || e.op === EXP.preMinusMinus;
        binOptimize(e, result, keepLhsLvalue);
    };

    const visitAdd = (e: AddExp): void => {
        //printf("AddExp::optimize(%s)\n", e.toChars());
        if (binOptimize(e, result))
            return;
        if (e.e1!.isConst() !== 0 && e.e2!.isConst() !== 0) {
            if (e.e1!.op === EXP.symbolOffset && e.e2!.op === EXP.symbolOffset)
                return;
            ret = Add(e.loc, e.type!, e.e1!, e.e2!).copy(); // dmd/constfold.d:111
        }
    };

    const visitMin = (e: MinExp): void => {
        //printf("MinExp::optimize(%s)\n", e.toChars());
        if (binOptimize(e, result))
            return;
        if (e.e1!.isConst() !== 0 && e.e2!.isConst() !== 0) {
            if (e.e2!.op === EXP.symbolOffset)
                return;
            ret = Min(e.loc, e.type!, e.e1!, e.e2!).copy(); // dmd/constfold.d:216
        }
    };

    const visitMul = (e: MulExp): void => {
        //printf("MulExp::optimize(result = %d) %s\n", result, e.toChars());
        if (binOptimize(e, result))
            return;
        if (e.e1!.isConst() === 1 && e.e2!.isConst() === 1) {
            ret = Mul(e.loc, e.type!, e.e1!, e.e2!).copy(); // dmd/constfold.d:224
        }
    };

    const visitDiv = (e: DivExp): void => {
        //printf("DivExp::optimize(%s)\n", e.toChars());
        if (binOptimize(e, result))
            return;
        if (e.e1!.isConst() === 1 && e.e2!.isConst() === 1) {
            ret = Div(e.loc, e.type!, e.e1!, e.e2!).copy(); // dmd/constfold.d:273
        }
    };

    const visitMod = (e: ModExp): void => {
        if (binOptimize(e, result))
            return;
        if (e.e1!.isConst() === 1 && e.e2!.isConst() === 1) {
            ret = Mod(e.loc, e.type!, e.e1!, e.e2!).copy(); // dmd/constfold.d:348
        }
    };

    // `extern (D)` erased (04 §8). D's `shift` is `UnionExp function(Loc, Type, Expression, Expression)`: the
    // constfold entries `Shl` / `Shr` / `Ushr` (dmd/constfold.d:493, :500, :546) are passed as plain function values.
    const shift_optimize = (e: BinExp,
                            shift: (loc: Loc, type: Type, e1: Expression, e2: Expression) => UnionExp): void => {
        if (binOptimize(e, result))
            return;
        if (e.e2!.isConst() === 1) {
            const i2: sinteger_t = toInt64(toInteger(e.e2!));
            let sz = size(e.e1!.type!, e.e1!.loc);
            assert(sz !== SIZE_INVALID);
            sz = toUint64(sz * 8n);
            // `i2 < 0` is tested first, so D's signed/unsigned `i2 >= sz` compares a non-negative value.
            if (i2 < 0n || i2 >= sz) {
                error(e.loc, ds("shift by %lld is outside the range `0..%llu`"), i2, toUint64(sz - 1n));
                return errorReturn();
            }
            if (e.e1!.isConst() === 1)
                ret = shift(e.loc, e.type!, e.e1!, e.e2!).copy();
        }
    };

    const visitShl = (e: ShlExp): void => {
        //printf("ShlExp::optimize(result = %d) %s\n", result, e.toChars());
        shift_optimize(e, Shl); // dmd/constfold.d:493
    };

    const visitShr = (e: ShrExp): void => {
        //printf("ShrExp::optimize(result = %d) %s\n", result, e.toChars());
        shift_optimize(e, Shr); // dmd/constfold.d:500
    };

    const visitUshr = (e: UshrExp): void => {
        //printf("UshrExp::optimize(result = %d) %s\n", result, toChars());
        shift_optimize(e, Ushr); // dmd/constfold.d:546
    };

    const visitAnd = (e: AndExp): void => {
        if (binOptimize(e, result))
            return;
        if (e.e1!.isConst() === 1 && e.e2!.isConst() === 1) {
            ret = And(e.loc, e.type!, e.e1!, e.e2!).copy(); // dmd/constfold.d:586
        }
    };

    const visitOr = (e: OrExp): void => {
        if (binOptimize(e, result))
            return;
        if (e.e1!.isConst() === 1 && e.e2!.isConst() === 1) {
            ret = Or(e.loc, e.type!, e.e1!, e.e2!).copy(); // dmd/constfold.d:593
        }
    };

    const visitXor = (e: XorExp): void => {
        if (binOptimize(e, result))
            return;
        if (e.e1!.isConst() === 1 && e.e2!.isConst() === 1) {
            ret = Xor(e.loc, e.type!, e.e1!, e.e2!).copy(); // dmd/constfold.d:600
        }
    };

    const visitPow = (e: PowExp): void => {
        if (binOptimize(e, result))
            return;
        // All negative integral powers are illegal.
        if (isIntegral(e.e1!.type!) && (e.e2!.op === EXP.int64) && toInt64(toInteger(e.e2!)) < 0n) {
            error(e.loc, ds("cannot raise `%s` to a negative integer power."), toBasetype(e.e1!.type!).toChars());
            errorSupplemental(e.loc, ds("did you mean `(cast(real)%s)^^%s` ?"), e.e1!.toChars(), e.e2!.toChars());
            return errorReturn();
        }
        // If e2 *could* have been an integer, make it one.
        // dmd/optimize.d:1095 — `cast(sinteger_t)` of a real_t saturates on our target (castToSinteger,
        // expressionsem.ts), and `real_t(...)` of the result is the long -> double conversion: `Number` of a
        // bigint rounds to nearest-even, as the target's `scvtf` does. So NaN and +-inf compare false, and
        // exactly 2^63 compares TRUE (long.max widens back to 2^63): ldc2 folds `x ^^ 9223372036854775808.0`
        // to `pow(x, 9223372036854775807L)` (pinned in optimize.test.ts).
        if (e.e2!.op === EXP.float64 && toReal(e.e2!) === Number(castToSinteger(toReal(e.e2!)))) {
            // This only applies to floating point, or positive integral powers.
            if (isFloating(e.e1!.type!) || toInt64(toInteger(e.e2!)) >= 0n)
                e.e2 = new IntegerExp(e.loc, toInteger(e.e2!), Type.tint64);
        }
        if (e.e1!.isConst() === 1 && e.e2!.isConst() === 1) {
            const ex = Pow(e.loc, e.type!, e.e1!, e.e2!).copy(); // dmd/constfold.d:413
            if (!CTFEExp.isCantExp(ex)) {
                ret = ex;
                return;
            }
        }
    };

    const visitComma = (e: CommaExp): void => {
        //printf("CommaExp::optimize(result = %d) %s\n", result, e.toChars());
        // Comma needs special treatment, because it may
        // contain compiler-generated declarations. We can interpret them, but
        // otherwise we must NOT attempt to constant-fold them.
        // In particular, if the comma returns a temporary variable, it needs
        // to be an lvalue (this is particularly important for struct constructors)
        expOptimize({ get: () => e.e1, set: (x) => { e.e1 = x; } }, WANTvalue);
        expOptimize({ get: () => e.e2, set: (x) => { e.e2 = x; } }, result, keepLvalue);
        if (ret!.op === EXP.error)
            return;
        if (e.e1 === null || e.e1.op === EXP.int64 || e.e1.op === EXP.float64 || !hasSideEffect(e.e1)) {
            ret = e.e2;
            if (ret !== null)
                ret.type = e.type;
        }
        //printf("-CommaExp::optimize(result = %d) %s\n", result, e.e.toChars());
    };

    const visitArrayLength = (e: ArrayLengthExp): void => {
        //printf("ArrayLengthExp::optimize(result = %d) %s\n", result, e.toChars());
        if (unaOptimize(e, WANTexpand))
            return;
        // CTFE interpret static immutable arrays (to get better diagnostics)
        const ve = e.e1!.isVarExp();
        if (ve !== null) {
            const v = ve.var_.isVarDeclaration();
            if (v !== null && (v.storage_class & STC.static_) !== 0n && (v.storage_class & STC.immutable_) !== 0n &&
                v._init !== null) {
                const ci = getConstInitializer(v);
                if (ci !== null)
                    e.e1 = ci;
            }
        }
        if (e.e1!.op === EXP.string_ || e.e1!.op === EXP.arrayLiteral || e.e1!.op === EXP.assocArrayLiteral ||
            toBasetype(e.e1!.type!).ty === TY.Tsarray || e.e1!.op === EXP.null_) {
            ret = ArrayLength(e.type!, e.e1!).copy(); // dmd/constfold.d:1083
        }
    };

    const visitEqual = (e: EqualExp): void => {
        //printf("EqualExp::optimize(result = %d) %s\n", result, e.toChars());
        const lowering = e.lowering;
        if (lowering !== null) {
            optimize(lowering, result, keepLvalue);
            return;
        }

        if (binOptimize(e, WANTvalue))
            return;

        const e1 = fromConstInitializer(result, e.e1!);
        const e2 = fromConstInitializer(result, e.e2!);
        if (e1.op === EXP.error) {
            ret = e1;
            return;
        }
        if (e2.op === EXP.error) {
            ret = e2;
            return;
        }
        ret = Equal(e.op, e.loc, e.type!, e1, e2).copy(); // dmd/constfold.d:610
        if (CTFEExp.isCantExp(ret))
            ret = e;
    };

    const visitIdentity = (e: IdentityExp): void => {
        //printf("IdentityExp::optimize(result = %d) %s\n", result, e.toChars());
        if (binOptimize(e, WANTvalue))
            return;
        if ((e.e1!.isConst() !== 0 && e.e2!.isConst() !== 0) || (e.e1!.op === EXP.null_ && e.e2!.op === EXP.null_)) {
            ret = Identity(e.op, e.loc, e.type!, e.e1!, e.e2!).copy(); // dmd/constfold.d:808
            if (CTFEExp.isCantExp(ret))
                ret = e;
        }
    };

    const visitIndex = (e: IndexExp): void => {
        //printf("IndexExp::optimize(result = %d) %s\n", result, e.toChars());
        if (expOptimize({ get: () => e.e1, set: (x) => { e.e1 = x; } }, result & WANTexpand))
            return;
        const ex = fromConstInitializer(result, e.e1!);
        // We might know $ now
        setLengthVarIfKnownFromExpression(e.lengthVar, ex);
        if (expOptimize({ get: () => e.e2, set: (x) => { e.e2 = x; } }, WANTvalue))
            return;
        // Don't optimize to an array literal element directly in case an lvalue is requested
        if (keepLvalue && ex.op === EXP.arrayLiteral)
            return;
        ret = Index(e.type!, ex, e.e2!, e.indexIsInBounds).copy(); // dmd/constfold.d:1117
        if (CTFEExp.isCantExp(ret) || (ret.isErrorExp() === null && keepLvalue && !isLvalue(ret)))
            ret = e;
    };

    const visitSlice = (e: SliceExp): void => {
        //printf("SliceExp::optimize(result = %d) %s\n", result, e.toChars());
        if (expOptimize({ get: () => e.e1, set: (x) => { e.e1 = x; } }, result & WANTexpand))
            return;
        if (e.lwr === null) {
            if (e.e1!.op === EXP.string_) {
                // Convert slice of string literal into dynamic array
                const t = toBasetype(e.e1!.type!);
                const tn = nextOf(t);
                if (tn !== null)
                    ret = castTo(e.e1!, null, arrayOf(tn));
            }
        } else {
            e.e1 = fromConstInitializer(result, e.e1!);
            // We might know $ now
            setLengthVarIfKnownFromExpression(e.lengthVar, e.e1);
            expOptimize({ get: () => e.lwr, set: (x) => { e.lwr = x; } }, WANTvalue);
            expOptimize({ get: () => e.upr, set: (x) => { e.upr = x; } }, WANTvalue);
            if (ret!.op === EXP.error)
                return;
            ret = Slice(e.type!, e.e1, e.lwr, e.upr).copy(); // dmd/constfold.d:1217
            if (CTFEExp.isCantExp(ret))
                ret = e;
        }
        // https://issues.dlang.org/show_bug.cgi?id=14649
        // Leave the slice form so it might be
        // a part of array operation.
        // Assume that the backend codegen will handle the form `e[]`
        // as an equal to `e` itself.
        if (ret!.op === EXP.string_) {
            e.e1 = ret;
            e.lwr = null;
            e.upr = null;
            ret = e;
        }
        //printf("-SliceExp::optimize() %s\n", ret.toChars());
    };

    const visitLogical = (e: LogicalExp): void => {
        //printf("LogicalExp::optimize(%d) %s\n", result, e.toChars());
        if (expOptimize({ get: () => e.e1, set: (x) => { e.e1 = x; } }, WANTvalue))
            return;
        const oror = e.op === EXP.orOr;
        const returnE_e1 = (): void => {
            ret = e.e1;
            if (!e.e1!.type!.equals(e.type)) {
                ret = new CastExp(e.loc, ret, e.type);
                ret.type = e.type;
                ret = optimize(ret, result, false);
            }
        };
        if (toBool(e.e1!).hasValue(oror)) {
            // e_true || e2 -> e_true
            // e_false && e2 -> e_false
            return returnE_e1();
        }
        expOptimize({ get: () => e.e2, set: (x) => { e.e2 = x; } }, WANTvalue);
        if (e.e1!.isConst() !== 0) {
            const e1Opt = toBool(e.e1!);
            if (e.e2!.isConst() !== 0) {
                const n1 = e1Opt.get();
                const n2 = toBool(e.e2!).get();
                ret = new IntegerExp(e.loc, (oror ? (n1 || n2) : (n1 && n2)) ? 1n : 0n, e.type!);
            } else if (e1Opt.hasValue(!oror)) {

                if (toBasetype(e.type!).ty === TY.Tvoid)
                    ret = e.e2;
                else {
                    ret = new CastExp(e.loc, e.e2, e.type);
                    ret.type = e.type;
                }
            }
        } else if (e.e2!.isConst() !== 0) {
            const e2Opt = toBool(e.e2!);
            if (e2Opt.hasValue(oror)) {
                // e1 || true -> (e1, true)
                // e1 && false -> (e1, false)
                ret = IntegerExp.createBool(oror);
                ret = Expression.combine(e.e1, ret);
                if (toBasetype(e.type!).ty === TY.Tvoid) {
                    ret = new CastExp(e.loc, ret, Type.tvoid);
                    ret.type = e.type;
                }
                ret = optimize(ret!, result, false);
            } else if (e2Opt.hasValue(!oror)) {
                // e1 || false -> e1
                // e1 && true -> e1
                return returnE_e1();
            }
        }
    };

    const visitCmp = (e: CmpExp): void => {
        //printf("CmpExp::optimize() %s\n", e.toChars());
        if (binOptimize(e, WANTvalue))
            return;
        const e1 = fromConstInitializer(result, e.e1!);
        const e2 = fromConstInitializer(result, e.e2!);
        ret = Cmp(e.op, e.loc, e.type!, e1, e2).copy(); // dmd/constfold.d:853
        if (CTFEExp.isCantExp(ret))
            ret = e;
    };

    const visitCat = (e: CatExp): void => {
        //printf("CatExp::optimize(%d) %s\n", result, e.toChars());
        if (binOptimize(e, result))
            return;

        if (e.type === Type.tstring) {
            const ce1 = e.e1!.isCatExp();
            if (ce1 !== null) {
                // https://issues.dlang.org/show_bug.cgi?id=12798
                // optimize ((expr ~ str1) ~ str2)
                // https://issues.dlang.org/show_bug.cgi?id=24078
                // This optimization is only valid if `expr` is a string.
                // Otherwise it leads to:
                // `["c"] ~ "a" ~ "b"` becoming `["c"] ~ "ab"`
                const cex = new CatExp(e.loc, ce1.e2, e.e2); // `scope` erased (04 §8)
                cex.type = e.type;
                const ex = optimize(cex, result, false);
                if (ex !== cex) {
                    e.e1 = ce1.e1;
                    e.e2 = ex;
                }
            }
        }
        // optimize "str"[] -> "str"
        const se1 = e.e1!.isSliceExp();
        if (se1 !== null) {
            if (se1.e1!.op === EXP.string_ && se1.lwr === null)
                e.e1 = se1.e1;
        }
        const se2 = e.e2!.isSliceExp();
        if (se2 !== null) {
            if (se2.e1!.op === EXP.string_ && se2.lwr === null)
                e.e2 = se2.e1;
        }
        ret = Cat(e.loc, e.type!, e.e1!, e.e2!).copy(); // dmd/constfold.d:1400
        if (CTFEExp.isCantExp(ret))
            ret = e;
    };

    const visitCond = (e: CondExp): void => {
        if (expOptimize({ get: () => e.econd, set: (x) => { e.econd = x; } }, WANTvalue))
            return;
        const opt = toBool(e.econd!);
        if (opt.hasValue(true))
            ret = optimize(e.e1!, result, keepLvalue);
        else if (opt.hasValue(false))
            ret = optimize(e.e2!, result, keepLvalue);
        else {
            expOptimize({ get: () => e.e1, set: (x) => { e.e1 = x; } }, result, keepLvalue);
            expOptimize({ get: () => e.e2, set: (x) => { e.e2 = x; } }, result, keepLvalue);
        }
    };

    // Optimize the expression until it can no longer be simplified.
    let b = 0; // size_t loop counter, bounded by global.recursionLimit (number domain, 09 §1.1)
    while (true) {
        if (b++ === global.recursionLimit) {
            error(e.loc, ds("infinite loop while optimizing expression"));
            return ErrorExp.get();
        }

        const ex: Expression = ret!; // D dereferences `ex.op` unconditionally
        switch (ex.op) {
            case EXP.variable:          visitVar(ex.isVarExp()!); break;
            case EXP.tuple:             visitTuple(ex.isTupleExp()!); break;
            case EXP.arrayLiteral:      visitArrayLiteral(ex.isArrayLiteralExp()!); break;
            case EXP.assocArrayLiteral: visitAssocArrayLiteral(ex.isAssocArrayLiteralExp()!); break;
            case EXP.structLiteral:     visitStructLiteral(ex.isStructLiteralExp()!); break;

            case EXP.import_:
            case EXP.assert_:
            case EXP.dotIdentifier:
            case EXP.dotTemplateDeclaration:
            case EXP.dotTemplateInstance:
            case EXP.delegate_:
            case EXP.dotType:
            case EXP.uadd:
            case EXP.delete_:
            case EXP.vector:
            case EXP.vectorArray:
            case EXP.array:
            case EXP.delegatePointer:
            case EXP.delegateFunctionPointer:
            case EXP.preMinusMinus:
            // D: `cast(UnaExp)ex`; every label of this arm is flagged unary in `exptab`.
            case EXP.prePlusPlus:       visitUna(ex.isUnaExp()!); break;

            case EXP.negate:            visitNeg(ex.isNegExp()!); break;
            case EXP.tilde:             visitCom(ex.isComExp()!); break;
            case EXP.not:               visitNop(ex.isNotExp()!); break;
            case EXP.symbolOffset:      visitSymOff(ex.isSymOffExp()!); break;
            case EXP.address:           visitAddr(ex.isAddrExp()!); break;
            case EXP.star:              visitPtr(ex.isPtrExp()!); break;
            case EXP.dotVariable:       visitDotVar(ex.isDotVarExp()!); break;
            case EXP.new_:              visitNew(ex.isNewExp()!); break;
            case EXP.call:              visitCall(ex.isCallExp()!); break;
            case EXP.cast_:             visitCast(ex.isCastExp()!); break;

            case EXP.addAssign:
            case EXP.minAssign:
            case EXP.mulAssign:
            case EXP.divAssign:
            case EXP.modAssign:
            case EXP.andAssign:
            case EXP.orAssign:
            case EXP.xorAssign:
            case EXP.powAssign:
            case EXP.leftShiftAssign:
            case EXP.rightShiftAssign:
            case EXP.unsignedRightShiftAssign:
            case EXP.concatenateDcharAssign: visitBinAssign(ex.isBinAssignExp()!); break;
            case EXP.concatenateElemAssign:
            // D: `cast(CatAssignExp) ex` — concatenateElemAssign is the CatElemAssignExp subclass and
            // concatenateAssign is CatAssignExp itself; the op-keyed `isCatAssignExp()` covers only the latter
            // (02 §11.5c item 3).
            case EXP.concatenateAssign:      visitCatAssign(ex as unknown as CatAssignExp); break;

            case EXP.minusMinus:
            case EXP.plusPlus:
            case EXP.assign:
            case EXP.construct:
            case EXP.blit:
            case EXP.in_:
            case EXP.remove:
            // D: `cast(BinExp)ex`; every label of this arm is flagged binary in `exptab`.
            case EXP.dot:                       visitBin(ex.isBinExp()!); break;

            case EXP.add:                       visitAdd(ex.isAddExp()!); break;
            case EXP.min:                       visitMin(ex.isMinExp()!); break;
            case EXP.mul:                       visitMul(ex.isMulExp()!); break;
            case EXP.div:                       visitDiv(ex.isDivExp()!); break;
            case EXP.mod:                       visitMod(ex.isModExp()!); break;
            case EXP.leftShift:                 visitShl(ex.isShlExp()!); break;
            case EXP.rightShift:                visitShr(ex.isShrExp()!); break;
            case EXP.unsignedRightShift:        visitUshr(ex.isUshrExp()!); break;
            case EXP.and:                       visitAnd(ex.isAndExp()!); break;
            case EXP.or:                        visitOr(ex.isOrExp()!); break;
            case EXP.xor:                       visitXor(ex.isXorExp()!); break;
            case EXP.pow:                       visitPow(ex.isPowExp()!); break;
            case EXP.comma:                     visitComma(ex.isCommaExp()!); break;
            case EXP.arrayLength:               visitArrayLength(ex.isArrayLengthExp()!); break;
            case EXP.notEqual:
            case EXP.equal:                     visitEqual(ex.isEqualExp()!); break;
            case EXP.notIdentity:
            case EXP.identity:                  visitIdentity(ex.isIdentityExp()!); break;
            case EXP.index:                     visitIndex(ex.isIndexExp()!); break;
            case EXP.slice:                     visitSlice(ex.isSliceExp()!); break;
            case EXP.andAnd:
            case EXP.orOr:                      visitLogical(ex.isLogicalExp()!); break;
            case EXP.lessThan:
            case EXP.lessOrEqual:
            case EXP.greaterThan:
            // D: `cast(CmpExp)ex` — `isCmpExp` is commented out upstream (no single EXP); the four comparison
            // case labels of this arm are all CmpExp (02 §11.5c item 3).
            case EXP.greaterOrEqual:            visitCmp(ex as unknown as CmpExp); break;
            case EXP.concatenate:               visitCat(ex.isCatExp()!); break;
            case EXP.question:                  visitCond(ex.isCondExp()!); break;

            default:                            visitExp(ex); break;
        }

        if (ex === ret)
            break;
    }
    return ret!; // non-null: the loop exits only when `ret` equals the dereferenced `ex`
}

// hdrgen.ts cannot value-import this module (load cycle; see its deferred-edge note): hand `optimize` over.
registerOptimize(optimize);
