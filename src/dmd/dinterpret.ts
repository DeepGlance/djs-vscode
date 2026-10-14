// Ported from dmd/dinterpret.d (module dmd.dinterpret) — "The entry point for CTFE."
//
// FULL-FILE TRANSLATION (P5.0 wave 13, stitched from five chunks, 14 §6). Every top-level D declaration of
// dinterpret.d is present here, in SOURCE ORDER, translated / walled (11 §2.5) / dropped-with-comment (07).
// dinterpret.d has no `unittest` blocks.
//
// VISITORS. Census `grep -c 'class .*Visitor' dmd/dinterpret.d` -> 1: `Interpreter` (dinterpret.d:1684),
// Idiom A (13 §7): each `visit(X)` overload is `override visitX(e: X): void`, driven by `e.accept(v)`.
// `interpretStatement(pue, s, istate)` (dinterpret.d:794) is Idiom C (13 §7.6): 32 nested `visitXxx`
// handlers + `mixin VisitStatement!void`, resolved into ONE inline 44-arm `switch (s.stmt)`.
//
// OVERLOADS (04 §1). Both D overload pairs are module-private; the `UnionExp* pue` form keeps the bare name
// and the other form takes the `No<ParamName>` suffix: `interpret` / `interpretNoPue` (dinterpret.d:6260,
// :6274), `interpretStatement` / `interpretStatementNoPue` (dinterpret.d:794, :784).
//
// UnionExp / emplaceExp (02 §11.1). `UnionExp ue = void;` -> `const ue = new UnionExp();`, `&ue` -> `ue`,
// `emplaceExp!(T)(pue, args)` -> `pue.emplace(new T(args))`, `*pue = <UnionExp call>` ->
// `pue.emplace(<call>.exp())`; after any overwrite of a UnionExp that a local was read from, the local is
// re-derived with `exp()` (03 §1.1). `ctfeEmplaceExp!T(args)` -> `ctfeEmplaceExp(() => new T(args))`: the
// thunk reaches the Form-B static factories (`ArrayLiteralExp.fromBasis`, `TupleExp.fromExps`, ...) that a
// constructor parameter cannot.
//
// CTFE REGION. `mem.isGCEnabled()` is always true in the port, as in `ldc2 -lowmem` (ldc2's default runs with the
// GC off and copies region literals out: a declared divergence, 08 §13), so every non-GC tail (region placement of
// ctfeEmplaceExp, the copy-out of interpretRegion) is `assertUnreachable` naming its D line; the
// `ctfeGlobals.region.savePos()/release()/contains()` calls stay, since the TS `Region` answers the GC-path
// behaviour (`contains` is false for every Expression).
//
// InterState (dinterpret.d:407) is a D value struct passed by pointer: a class with `copy()`; the three
// `InterState istatex = *istate;` sites are `istate.copy()` and their `*istate = istatex;` write-backs are
// in-place `Object.assign` (03 §1.1, flat struct of references).
//
// WALLS (11 §2.5): none. `isBuiltin` / `eval_builtin` come from builtin.ts.
//
// ESCALATION (11 §2 record, open):
//   file:        dmd/dinterpret.d
//   line:        255 (`enum CTFE_RECURSION_LIMIT = 1000;`), checked in interpretFunction
//   construct:   recursive CTFE: each CTFE call level nests interpretFunction -> interpretStatement -> Interpreter
//                visitors -> interpret on the HOST stack, as in D
//   category:    external implementation (host stack depth)
//   why_blocked: D's native frames allow 1000 CTFE levels and then print "function `X` CTFE recursion limit
//                exceeded"; the JS stack of node/vitest overflows first, between 200 and 260 levels
//                (`rec(260)` throws RangeError out of ctfeInterpret).
//   tried:       nothing yet; the fix is a design choice (larger worker stack, or a depth cap that reproduces
//                D's diagnostic), not a translation.
//   blast_radius: deep recursive CTFE only. The paired state unwinds cleanly after the RangeError (callDepth,
//                frames, `$` pushes, region): dinterpret.test.ts pins five overflows followed by a clean rec(10).
//
// dropped: `import core.stdc.stdio/stdlib/string;` (dinterpret.d:16-18) — `printf` only in debug blocks
// and in the bare traces before `assert(0)`; `strncmp` becomes a byte compare; `memcpy` sits on the dead
// region path.
// dropped: `import dmd.hdrgen;` (dinterpret.d:38) for `EXPtoString` — only in debug blocks and dropped
// traces. `s.toChars()` on a Statement (D:688, D:826) is NOT hdrgen's UFCS `toChars(const Statement)`: member
// lookup wins, so it is the inherited `RootObject.toChars()` (rootobject.d:41-44, `assert(0)`), which ldc2 hits
// too (it crashes there). The port calls the member, reaching the same `assertUnreachable`.
// dropped: every `debug (LOG|LOGASSIGN|LOGCOMPILE|SHOWPERFORMANCE)` block (non-debug build, _config §3),
// every function-local `import dmd.timetrace` begin/`scope (exit)` end pair (profiling module, no port;
// dropped together so no guard is left unbalanced) and `version (none)` (dinterpret.d:7552).
// Function-local D imports (`dmd.typesem : isBaseOf/toDsymbol/hasPointers`, `dmd.aggregate : ClassKind`)
// are hoisted into the module preamble (01 §4.4); none needs a registration slot.

import { K } from "../keep.js";
import { assert, assertUnreachable, SwitchError } from "../assert.js";
import { ds, dsEquals, dsSubslice } from "../dstring.js";
import type { DString } from "../dstring.js";
import { toInt32, toUint8, toInt64, toUint64, maskUnsignedN } from "../numeric.js";
import {
    IntegerExp, RealExp, NullExp, VarExp, IndexExp, SliceExp, AddrExp, PtrExp, ArrayLiteralExp, AssocArrayLiteralExp,
    StructLiteralExp, ClassReferenceExp, ThrownExceptionExp, CTFEExp, ErrorExp, TupleExp, StringExp, CallExp,
    DotVarExp, SymOffExp, TypeidExp, DelegateExp, VectorExp, OwnedBy, MemorySet, StructLiteralExpStageFlags,
    StringExp_NoPostfix,
} from "./expression.js";
import type {
    Expression, BinExp, UnaExp, AssignExp, BinAssignExp, ArrayLengthExp, AssertExp, CastExp, CatExp, CommaExp,
    ComplexExp, CondExp, DeclarationExp, DelegateFuncptrExp, DelegatePtrExp, DeleteExp, DotTypeExp, FuncExp,
    LogicalExp, NewExp, PostExp, SymbolExp, ThisExp, ThrowExp, TypeExp, VectorArrayExp, VoidInitExp,
} from "./expression.js";
import { Type, TypeTuple, TypeAArray, isSomeChar } from "./mtype.js";
import type { TypeFunction, TypeNext, TypeArray } from "./mtype.js";
import { VarDeclaration } from "./declaration.js";
import type { Declaration } from "./declaration.js";
import { PASS } from "./dsymbol.js";
import type { Dsymbol } from "./dsymbol.js";
import type { ClassDeclaration } from "./dclass.js";
import type { StructDeclaration } from "./dstruct.js";
import { ClassKind } from "./aggregate.js"; // hoisted: fn-local `import dmd.aggregate : ClassKind;` (dinterpret.d:5583)
import { BUILTIN } from "./func.js";
import type { FuncDeclaration } from "./func.js";
import { NeedInterpret } from "./init.js";
import { isType, isExpression, isDsymbol } from "./dtemplate.js";
import type {
    Statement, ExpStatement, DtorExpStatement, CompoundStatement, CompoundAsmStatement, UnrolledLoopStatement,
    IfStatement, ScopeStatement, ReturnStatement, BreakStatement, ContinueStatement, WhileStatement, DoStatement,
    ForStatement, ForeachStatement, ForeachRangeStatement, SwitchStatement, CaseStatement, DefaultStatement,
    GotoStatement, GotoCaseStatement, GotoDefaultStatement, LabelStatement, TryCatchStatement, TryFinallyStatement,
    ThrowStatement, ScopeGuardStatement, WithStatement, AsmStatement, InlineAsmStatement, GccAsmStatement,
    ImportStatement,
} from "./statement.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import {
    UnionExp, copyLiteral, paintTypeOntoLiteral, paintTypeOntoLiteralNoPue, resolveSlice, resolveArrayLength,
    getAggregateFromPointer, pointerDifference, pointerArithmetic, comparePointers, findKeyInAA, ctfeIndex, ctfeCast,
    ctfeEqual, ctfeIdentity, ctfeCmp, ctfeCat, changeArrayLiteralLength, createBlockDuplicatedArrayLiteral,
    createBlockDuplicatedStringLiteral, assignInPlace, voidInitLiteral, isCtfeValueValid, isCtfeReferenceValid,
    exceptionOrCantInterpret, generateUncaughtError, findFieldIndexByName, isAssocArray, toBuiltinAAType,
    isTypeInfo_Class, isPointer, isTrueBool, isSafePointerCast, pointToSameMemoryBlock, isFloatIntPaint,
    paintFloatInt, isCtfeComparable, needToCopyLiteral,
} from "./ctfeexpr.js";
import {
    Neg, Com, Not, Add, Min, Mul, Div, Mod, Pow, Shl, Shr, Ushr, And, Or, Xor, ArrayLength,
    sliceAssignArrayLiteralFromString, sliceAssignStringFromArrayLiteral, sliceAssignStringFromString, sliceBoundsCheck,
} from "./constfold.js";
import type { Expressions, VarDeclarations } from "./arraytypes.js";
import { Array as DArray } from "./root/array.js";
import { Loc } from "./location.js";
import { global } from "./globals.js";
import type { dinteger_t, sinteger_t, uinteger_t } from "./globals.js";
import { EXP } from "./tokens.js";
import { TY, STC, STMT, MODFlags, VarArg, MATCH } from "./astenums.js";
import { error, errorSupplemental, messageNoLoc } from "./errors.js";
import { mem } from "./root/rmem.js";
import { Region } from "./root/region.js";
import { CTFloat } from "./root/ctfloat.js";
import {
    utf_decodeChar, utf_decodeWchar, utf_encodeChar, utf_encodeWchar, utf_codeLengthChar, utf_codeLengthWchar,
} from "./root/utf.js";
import { arrayCastBigEndian } from "./utils.js";
import { Visitor } from "./visitor/index.js";
// The semantic passes LAST (01 §4.8): entering the core SCC through a *sem module fails at load.
import {
    toInteger, toBool, toStringExp, isLvalue, expressionSemantic, expandTuples, fill, getField, getConstInitializer,
} from "./expressionsem.js";
import {
    toBasetype, nextOf, size, defaultInitLiteral, baseElemOf, arrayOf, sarrayOf, pointerTo, mutableOf, merge,
    equivalent, isIntegral, isReal, isScalar, isUnsigned, isBaseOf, toDsymbol, hasPointers,
} from "./typesem.js";
import { implicitConvTo, implicitConvToType } from "./dcast.js";
import { dsymbolSemantic, toAlias, isOverlappedWith } from "./dsymbolsem.js";
import { functionSemantic3, isVirtual } from "./funcsem.js";
import { initializerSemantic, initializerToExpression } from "./initsem.js";
import { findFunc } from "./semantic2.js";
import { isBuiltin, eval_builtin } from "./builtin.js";

/// A single mutable cell standing in for a D `ref` / `T*` out-parameter over a value (03 §7.2 box pattern).
interface Ref<T> {
    value: T;
}

/*************************************
 * Entry point for CTFE.
 * A compile-time result is required. Give an error if not possible.
 *
 * `e` must be semantically valid expression. In other words, it should not
 * contain any `ErrorExp`s in it. But, CTFE interpretation will cross over
 * functions and may invoke a function that contains `ErrorStatement` in its body.
 * If that, the "CTFE failed because of previous errors" error is raised.
 *
 * dmd/dinterpret.d:67 — `public Expression ctfeInterpret(Expression e)`.
 */
export function ctfeInterpret(e: Expression): Expression {
    switch (e.op) {
        case EXP.int64:
        case EXP.float64:
        case EXP.complex80:
        case EXP.null_:
        case EXP.void_:
        case EXP.string_:
        case EXP.this_:
        case EXP.super_:
        case EXP.type:
        case EXP.typeid_:
        case EXP.template_:              // non-eponymous template/instance
        case EXP.scope_:                 // ditto
        case EXP.dotTemplateDeclaration: // ditto, e.e1 doesn't matter here
        case EXP.dotTemplateInstance:    // ditto
        case EXP.dot:                    // ditto
            if (e.type!.ty === TY.Terror)
                return ErrorExp.get();
            // dmd/dinterpret.d:88 — `goto case EXP.error;` -> fall through to the next case, which IS
            // `case EXP.error` (06 §3.6: JS no-break fallthrough)

        case EXP.error:
            return e;

        default:
            break;
    }

    assert(e.type !== null); // https://issues.dlang.org/show_bug.cgi?id=14642
    //assert(e.type.ty != Terror);    // FIXME
    if (e.type.ty === TY.Terror)
        return ErrorExp.get();

    const rgnpos = ctfeGlobals.region.savePos();

    // dropped: `import dmd.timetrace; timeTraceBeginEvent(TimeTraceEventType.ctfe);
    //          scope (exit) timeTraceEndEvent(TimeTraceEventType.ctfe, e);` (dinterpret.d:104-106) —
    //          profiling module with no port; begin and end dropped together, so no guard is left open.

    // Paired state (11 §2.5): D releases the region at one line (D:125) with no early exit in between; a wall
    // reached through interpretNoPue adds a throw exit, so the release moves into `finally` (single-release form).
    let result: Expression | null;
    try {
        result = interpretNoPue(e, null);

        // Report an error if the expression contained a `ThrowException` and
        // hence generated an uncaught exception
        const tee = result!.isThrownExceptionExp();
        if (tee !== null) {
            generateUncaughtError(tee);
            result = CTFEExp.cantexp!;
        }
        else
            result = copyRegionExp(result);

        if (!CTFEExp.isCantExp(result))
            result = scrubReturnValue(e.loc, result!);
        if (CTFEExp.isCantExp(result))
            result = ErrorExp.get();
    } finally {
        ctfeGlobals.region.release(rgnpos);
    }

    return result!;
}

/* Run CTFE on the expression, but allow the expression to be a TypeExp
 *  or a tuple containing a TypeExp. (This is required by pragma(msg)).
 *
 * dmd/dinterpret.d:133 — `public Expression ctfeInterpretForPragmaMsg(Expression e)`.
 */
export function ctfeInterpretForPragmaMsg(e: Expression): Expression {
    if (e.op === EXP.error || e.op === EXP.type)
        return e;

    // It's also OK for it to be a function declaration (happens only with
    // __traits(getOverloads))
    const ve = e.isVarExp();
    if (ve !== null)
        if (ve.var_.isFuncDeclaration() !== null) {
            return e;
        }

    const tup = e.isTupleExp();
    if (tup === null)
        return ctfeInterpret(e);

    // Tuples need to be treated separately, since they are
    // allowed to contain a TypeExp in this case.

    let expsx: Expressions | null = null;
    for (const [i, g] of tup.exps!.opSlice().entries()) {
        const h = ctfeInterpretForPragmaMsg(g!);
        if (h !== g) {
            if (expsx === null) {
                expsx = tup.exps!.copy();
            }
            expsx.opIndexAssign(h, i);
        }
    }
    if (expsx !== null) {
        // dmd/dinterpret.d:168 — `new TupleExp(e.loc, expsx)`: the 2-arg D ctor is the Form-B factory.
        const te = TupleExp.fromExps(e.loc, expsx);
        expandTuples(te.exps);
        te.type = TypeTuple.fromExpressions(te.exps); // `new TypeTuple(te.exps)` (Form-B factory)
        return te;
    }
    return e;
}

/// dmd/dinterpret.d:176 — `public Expression getValue(VarDeclaration vd)`.
export function getValue(vd: VarDeclaration): Expression | null {
    return ctfeGlobals.stack.getValue(vd);
}

/*************************************************
 * Allocate an Expression in the ctfe region.
 * Params:
 *      T = type of Expression to allocate
 *      args = arguments to Expression's constructor
 * Returns:
 *      allocated Expression
 *
 * dmd/dinterpret.d:189 — `T ctfeEmplaceExp(T : Expression, Args...)(Args args)`. The template takes a
 * thunk building the node (`ctfeEmplaceExp!IntegerExp(loc, v, t)` -> `ctfeEmplaceExp(() => new
 * IntegerExp(loc, v, t))`): D overload resolution can pick a constructor that the TS tree exposes as a
 * Form-B static factory, which a constructor parameter cannot reach.
 */
export function ctfeEmplaceExp<T extends Expression>(make: () => T): T {
    if (mem.isGCEnabled())
        return make();
    // dinterpret.d:193-195 — region placement (`region.malloc(__traits(classInstanceSize, T))` + emplaceExp)
    // has no analog under GC (07 §7.1, 08 §13); mem.isGCEnabled() is always true in the port.
    return assertUnreachable("ctfeEmplaceExp: CTFE region allocation has no analog under GC (dinterpret.d:193)");
}

// CTFE diagnostic information
/// dmd/dinterpret.d:199 — `public extern (C++) void printCtfePerformanceStats()`.
export function printCtfePerformanceStats(): void {
    // dropped: debug(SHOWPERFORMANCE) body (dinterpret.d:201-206, _config §3) — the whole body is the debug block.
}

/**************************
 */

/// dmd/dinterpret.d:212 — `void incArrayAllocs()`.
export function incArrayAllocs(): void {
    ++ctfeGlobals.numArrayAllocs;
}

/* ================================================ Implementation ======================================= */

// dinterpret.d:219 — `private:`: every declaration below is module-private (not exported) except the
// explicitly `public` isRuntimeHook (dinterpret.d:6230).

/***************
 * Collect together globals used by CTFE
 *
 * dmd/dinterpret.d:224 — `struct CtfeGlobals`. The only instance is the `__gshared` global below, never
 * copied, so the class carries no `copy()` (no D copy point exists).
 */
class CtfeGlobals {
    region = new Region();

    stack = new CtfeStack();

    callDepth = 0;        // current number of recursive calls

    // When printing a stack trace, suppress this number of calls
    stackTraceCallsToSuppress = 0;

    maxCallDepth = 0;     // highest number of recursive calls
    numArrayAllocs = 0;   // Number of allocated arrays
    numAssignments = 0;   // total number of assignments executed
}

// moved: `__gshared CtfeGlobals ctfeGlobals;` (dinterpret.d:240) is emitted right after `class CtfeStack`
// below — class declarations are not hoisted, and CtfeGlobals' field initializer constructs CtfeStack.

/// dmd/dinterpret.d:242 — `enum CTFEGoal : int`.
enum CTFEGoal {
    RValue,     /// Must return an Rvalue (== CTFE value)
    LValue,     /// Must return an Lvalue (== CTFE reference)
    Nothing,    /// The return value is not required
}

//debug = LOG;
//debug = LOGASSIGN;
//debug = LOGCOMPILE;
//debug = SHOWPERFORMANCE;

// Maximum allowable recursive function calls in CTFE
const CTFE_RECURSION_LIMIT = 1000;

/**
 The values of all CTFE variables

 dmd/dinterpret.d:260 — `struct CtfeStack`. Embedded by value in the one CtfeGlobals instance and never
 copied, so the class carries no `copy()`. Every `private` field is touched only inside this struct, so
 it is TS `private` (01 Rule 2.5).
 */
class CtfeStack {
    /* The stack. Every declaration we encounter is pushed here,
     * together with the VarDeclaration, and the previous
     * stack address of that variable, so that we can restore it
     * when we leave the stack frame.
     * Note that when a function is forward referenced, the interpreter must
     * run semantic3, and that may start CTFE again with a NULL istate. Thus
     * the stack might not be empty when CTFE begins.
     *
     * Ctfe Stack addresses are just 0-based integers, but we save
     * them as 'void *' because Array can only do pointers.
     *
     * (port: the `Array!(void*)` members hold those integers directly, as `DArray<number>`.)
     */
    private values: Expressions = new DArray<Expression | null>();         // values on the stack
    private vars: VarDeclarations = new DArray<VarDeclaration | null>();   // corresponding variables
    private savedId = new DArray<number>();     // id of the previous state of that var

    private frames = new DArray<number>();      // all previous frame pointers
    private savedThis: Expressions = new DArray<Expression | null>();      // all previous values of localThis

    /* Global constants get saved here after evaluation, so we never
     * have to redo them. This saves a lot of time and memory.
     */
    private globalValues: Expressions = new DArray<Expression | null>();   // values of global constants
    /** No D counterpart: the kept-module engine's index of `globalValues` by variable (`keepDropCtfeGlobals`). */
    keepGlobalVars = new Map<number, VarDeclaration>();

    private framepointer = 0;                   // current frame pointer
    private maxStackPointer = 0;                // most stack we've ever used
    private localThis: Expression | null = null; // value of 'this', or NULL if none

    /// dmd/dinterpret.d:291 — `size_t stackPointer() @safe`.
    stackPointer(): number {
        return this.values.length;
    }

    // The current value of 'this', or NULL if none
    /// dmd/dinterpret.d:297 — `Expression getThis() @safe`.
    getThis(): Expression | null {
        return this.localThis;
    }

    // Largest number of stack positions we've used
    /// dmd/dinterpret.d:303 — `size_t maxStackUsage() @safe`.
    maxStackUsage(): number {
        return this.maxStackPointer;
    }

    // Start a new stack frame, using the provided 'this'.
    /// dmd/dinterpret.d:309 — `void startFrame(Expression thisexp)`.
    startFrame(thisexp: Expression | null): void {
        this.frames.push(this.framepointer); // `cast(void*)cast(size_t)framepointer`
        this.savedThis.push(this.localThis);
        this.framepointer = this.stackPointer();
        this.localThis = thisexp;
    }

    /// dmd/dinterpret.d:317 — `void endFrame()`.
    endFrame(): void {
        const oldframe = this.frames.opIndex(this.frames.length - 1); // `cast(size_t)frames[...]`
        this.localThis = this.savedThis.opIndex(this.savedThis.length - 1);
        this.popAll(this.framepointer);
        this.framepointer = oldframe;
        this.frames.setDim(this.frames.length - 1);
        this.savedThis.setDim(this.savedThis.length - 1);
    }

    /// dmd/dinterpret.d:327 — `bool isInCurrentFrame(VarDeclaration v)`.
    isInCurrentFrame(v: VarDeclaration): boolean {
        if (v.isDataseg() && !v.isCTFE())
            return false; // It's a global
        return v.ctfeAdrOnStack >= this.framepointer;
    }

    /// dmd/dinterpret.d:334 — `Expression getValue(VarDeclaration v)`.
    getValue(v: VarDeclaration): Expression | null {
        //printf("getValue() %s\n", v.toChars());
        if ((v.isDataseg() || (v.storage_class & STC.manifest) !== 0n) && !v.isCTFE()) {
            assert(v.ctfeAdrOnStack < this.globalValues.length);
            return this.globalValues.opIndex(v.ctfeAdrOnStack);
        }
        assert(v.ctfeAdrOnStack < this.stackPointer());
        return this.values.opIndex(v.ctfeAdrOnStack);
    }

    /// dmd/dinterpret.d:346 — `void setValue(VarDeclaration v, Expression e)`.
    setValue(v: VarDeclaration, e: Expression | null): void {
        //printf("setValue() %s : %s\n", v.toChars(), e.toChars());
        assert(!v.isDataseg() || v.isCTFE());
        assert(v.ctfeAdrOnStack < this.stackPointer());
        this.values.opIndexAssign(e, v.ctfeAdrOnStack);
    }

    /// dmd/dinterpret.d:354 — `void push(VarDeclaration v)`.
    push(v: VarDeclaration): void {
        //printf("push() %s\n", v.toChars());
        assert(!v.isDataseg() || v.isCTFE());
        if (v.ctfeAdrOnStack !== VarDeclaration.AdrOnStackNone && v.ctfeAdrOnStack >= this.framepointer) {
            // Already exists in this frame, reuse it.
            this.values.opIndexAssign(null, v.ctfeAdrOnStack);
            return;
        }
        this.savedId.push(v.ctfeAdrOnStack); // `cast(void*)cast(size_t)v.ctfeAdrOnStack`
        v.ctfeAdrOnStack = this.values.length; // `cast(uint)values.length`: a stack index, < 2^32
        this.vars.push(v);
        this.values.push(null);
    }

    /// dmd/dinterpret.d:370 — `void pop(VarDeclaration v)`.
    pop(v: VarDeclaration): void {
        assert(!v.isDataseg() || v.isCTFE());
        assert(!v.isReference());
        const oldid = v.ctfeAdrOnStack;
        v.ctfeAdrOnStack = this.savedId.opIndex(oldid); // `cast(uint)cast(size_t)savedId[oldid]`
        // D compares a `uint` with `size_t` `values.length - 1`; on an empty stack D's operand is
        // size_t.max and the TS one is -1 — neither equals a uint address, so both tests are false.
        if (v.ctfeAdrOnStack === this.values.length - 1) {
            this.values.pop();
            this.vars.pop();
            this.savedId.pop();
        }
    }

    /// dmd/dinterpret.d:384 — `void popAll(size_t stackpointer)`.
    popAll(stackpointer: number): void {
        if (this.stackPointer() > this.maxStackPointer)
            this.maxStackPointer = this.stackPointer();
        assert(this.values.length >= stackpointer);
        for (let i = stackpointer; i < this.values.length; ++i) {
            const v = this.vars.opIndex(i)!;
            v.ctfeAdrOnStack = this.savedId.opIndex(i); // `cast(uint)cast(size_t)savedId[i]`
        }
        this.values.setDim(stackpointer);
        this.vars.setDim(stackpointer);
        this.savedId.setDim(stackpointer);
    }

    /// dmd/dinterpret.d:399 — `void saveGlobalConstant(VarDeclaration v, Expression e)`.
    saveGlobalConstant(v: VarDeclaration, e: Expression | null): void {
        assert(v._init !== null && (v.isConst() || v.isImmutable() || (v.storage_class & STC.manifest) !== 0n) &&
            !v.isCTFE());
        v.ctfeAdrOnStack = this.globalValues.length; // `cast(uint)globalValues.length`
        if (K.on) this.keepGlobalVars.set(v.ctfeAdrOnStack, v);   // the kept-module engine: whose value this is
        this.globalValues.push(copyRegionExp(e));
    }

    /**
     * No D counterpart: the kept-module engine (src/keep.ts) empties the slots of the variables it no longer keeps.
     * A kept compile does not reset this stack (kept variables' values stay at their `ctfeAdrOnStack`), so without
     * it each compile's new global constants, and the analysed code their values point into, would stay.
     */
    keepDrop(kept: (v: VarDeclaration) => boolean): void {
        for (const [slot, v] of this.keepGlobalVars) {
            if (!kept(v)) {
                this.globalValues.opIndexAssign(null, slot);
                this.keepGlobalVars.delete(slot);
            }
        }
    }
}

// moved from dinterpret.d:240 — `__gshared CtfeGlobals ctfeGlobals;`: class declarations are not hoisted, and
// CtfeGlobals' field initializer constructs CtfeStack, so the instance must follow `class CtfeStack`.
let ctfeGlobals = new CtfeGlobals();

/**
 * No D counterpart: the djs driver's reset between two compiles in one process (src/djs.ts
 * `deinitializeFrontend`). A compile stopped by `fatal()` inside CTFE leaves the call depth and the stack
 * raised; a fresh `CtfeGlobals` is what a new process starts with.
 */
export function resetCtfeGlobals(): void {
    ctfeGlobals = new CtfeGlobals();
}

/** No D counterpart: the kept-module engine's `CtfeStack.keepDrop` on the compile's stack. */
export function keepDropCtfeGlobals(kept: (v: VarDeclaration) => boolean): void {
    ctfeGlobals.stack.keepDrop(kept);
}

/**
 * dmd/dinterpret.d:407 — `private struct InterState`. A value struct that D passes by pointer
 * (`InterState*`): the pointer is the class reference, a D value copy is `copy()` (03 §2), and a
 * write-back through the pointer is an in-place overwrite (03 §1.1).
 */
class InterState {
    caller: InterState | null = null;       // calling function's InterState
    fd: FuncDeclaration | null = null;      // function being interpreted
    start: Statement | null = null;         // if !=NULL, start execution at this statement

    /* target of CTFEExp result; also
     * target of labelled CTFEExp or
     * CTFEExp. (null if no label).
     */
    gotoTarget: Statement | null = null;

    /// D struct copy (03 §2): four class references, shared.
    copy(): InterState {
        const c = new InterState();
        c.caller = this.caller;
        c.fd = this.fd;
        c.start = this.start;
        c.gotoTarget = this.gotoTarget;
        return c;
    }
}

/*************************************
 * Attempt to interpret a function given the arguments.
 * Params:
 *      pue       = storage for result
 *      fd        = function being called
 *      istate    = state for calling function (NULL if none)
 *      arguments = function arguments
 *      thisarg   = 'this', if a needThis() function, NULL if not.
 *
 * Returns:
 * result expression if successful, EXP.cantExpression if not,
 * or CTFEExp if function returned void.
 *
 * dmd/dinterpret.d:433 — `private Expression interpretFunction(UnionExp* pue, FuncDeclaration fd`.
 * D `arguments` -> `arguments_` (01 Rule 2.2).
 */
function interpretFunction(pue: UnionExp, fd: FuncDeclaration, istate: InterState | null,
                           arguments_: Expressions | null, thisarg: Expression | null): Expression | null {
    // dropped: `scope dlg = () { import dmd.common.outbuffer; ... };` + `import dmd.timetrace;
    //          timeTraceBeginEvent(TimeTraceEventType.ctfeCall); scope (exit) timeTraceEndEvent(...)`
    //          (dinterpret.d:440-459) — the `dlg` lambda only builds the time-trace event's detail string, so
    //          it goes with the profiling pair (no port; begin and end dropped together).

    // dmd/dinterpret.d:461 — nested `void fdError(const(char)* msg)`.
    const fdError = (msg: DString): void => {
        error(fd.loc, ds("%s `%s` %s"), fd.kind(), fd.toPrettyChars(), msg);
    };

    assert(pue);
    if (fd.semanticRun === PASS.semantic3) {
        fdError(ds("circular dependency. Functions cannot be interpreted while being compiled"));
        return CTFEExp.cantexp!;
    }
    if (!functionSemantic3(fd))
        return CTFEExp.cantexp!;
    if (fd.semanticRun < PASS.semantic3done) {
        fdError(ds("circular dependency. Functions cannot be interpreted while being compiled"));
        return CTFEExp.cantexp!;
    }

    const tf = toBasetype(fd.type!).isTypeFunction()!;
    if (tf.parameterList.varargs !== VarArg.none && arguments_ !== null &&
        ((fd.parameters !== null && arguments_.length !== fd.parameters.length) ||
         (fd.parameters === null && arguments_.length !== 0))) {
        fdError(ds("C-style variadic functions are not yet implemented in CTFE"));
        return CTFEExp.cantexp!;
    }

    // Nested functions always inherit the 'this' pointer from the parent,
    // except for delegates. (Note that the 'this' pointer may be null).
    // Func literals report isNested() even if they are in global scope,
    // so we need to check that the parent is a function.
    if (fd.isNested() && fd.toParentLocal()!.isFuncDeclaration() !== null && thisarg === null && istate !== null)
        thisarg = ctfeGlobals.stack.getThis();

    if (fd.needThis() && thisarg === null) {
        // error, no this. Prevent segfault.
        // Here should be unreachable by the strict 'this' check in front-end.
        error(fd.loc, ds("%s `%s` need `this` to access member `%s`"), fd.kind(), fd.toPrettyChars(), fd.toChars());
        return CTFEExp.cantexp!;
    }

    // Place to hold all the arguments to the function while
    // we are evaluating them.
    const dim = arguments_ !== null ? arguments_.length : 0;
    assert((fd.parameters !== null ? fd.parameters.length : 0) === dim);

    /* Evaluate all the arguments to the function,
     * store the results in eargs[]
     */
    // dmd/dinterpret.d:511 — `Expressions eargs = Expressions(dim);`: a by-value local container; every slot
    // [0, dim) is written below before it is read.
    const eargs = new DArray<Expression | null>(dim);
    for (let i = 0; i < dim; i++) {
        let earg: Expression | null = arguments_!.opIndex(i);
        const fparam = tf.parameterList.opIndex(i)!;

        if (fparam.isReference()) {
            if (istate === null && (fparam.storageClass & STC.out_) !== 0n) {
                // initializing an out parameter involves writing to it.
                error(earg!.loc, ds("global `%s` cannot be passed as an `out` parameter at compile time"),
                    earg!.toChars());
                return CTFEExp.cantexp!;
            }
            // Convert all reference arguments into lvalue references
            earg = interpretRegion(earg, istate, CTFEGoal.LValue);
            if (CTFEExp.isCantExp(earg))
                return earg;
        }
        else if (fparam.isLazy()) {
        }
        else {
            /* Value parameters
             */
            const ta = toBasetype(fparam.type!);
            if (ta.ty === TY.Tsarray) {
                const eaddr = earg!.isAddrExp();
                if (eaddr !== null) {
                    /* Static arrays are passed by a simple pointer.
                     * Skip past this to get at the actual arg.
                     */
                    earg = eaddr.e1;
                }
            }

            earg = interpretRegion(earg, istate);
            if (CTFEExp.isCantExp(earg))
                return earg;

            /* Struct literals are passed by value, but we don't need to
             * copy them if they are passed as const
             */
            if (earg!.op === EXP.structLiteral && (fparam.storageClass & (STC.const_ | STC.immutable_)) === 0n)
                earg = copyLiteral(earg!).copy();
        }
        const tee = earg!.isThrownExceptionExp();
        if (tee !== null) {
            if (istate !== null)
                return tee;
            generateUncaughtError(tee);
            return CTFEExp.cantexp!;
        }
        eargs.opIndexAssign(earg, i);
    }

    // Now that we've evaluated all the arguments, we can start the frame
    // (this is the moment when the 'call' actually takes place).
    const istatex = new InterState();
    istatex.caller = istate;
    istatex.fd = fd;

    if (fd.hasDualContext) {
        let arg0: Expression | null = thisarg;
        if (arg0 !== null && arg0.type!.ty === TY.Tstruct) {
            const t = pointerTo(arg0.type!);
            arg0 = ctfeEmplaceExp(() => new AddrExp(arg0!.loc, arg0));
            arg0.type = t;
        }
        const elements = new DArray<Expression | null>(2);
        elements.opIndexAssign(arg0, 0);
        elements.opIndexAssign(ctfeGlobals.stack.getThis(), 1);
        const t2 = sarrayOf(Type.tvoidptr, 2n);
        const loc = thisarg !== null ? thisarg.loc : fd.loc;
        thisarg = ctfeEmplaceExp(() => new ArrayLiteralExp(loc, t2, elements));
        thisarg = ctfeEmplaceExp(() => new AddrExp(loc, thisarg));
        thisarg.type = pointerTo(t2);
    }

    ctfeGlobals.stack.startFrame(thisarg);
    // Paired state (11 §2.5): `startFrame` above and `++callDepth` below are released at ONE line each on the
    // normal path (D:745 `--ctfeGlobals.callDepth;`, D:747 `endFrame()`), while D's own early error returns inside
    // the region skip both. A `finally` would release on those returns too, so each pair takes catch-repair-rethrow:
    // only the throw exits D does not have (a wall reached through interpretStatement) are repaired.
    let e: Expression | null = null;
    try {
        if (fd.vthis !== null && thisarg !== null) {
            ctfeGlobals.stack.push(fd.vthis);
            setValue(fd.vthis, thisarg);
        }

        for (let i = 0; i < dim; i++) {
            const earg = eargs.opIndex(i);
            const fparam = tf.parameterList.opIndex(i)!;
            const v = fd.parameters!.opIndex(i)!;
            ctfeGlobals.stack.push(v);

            if (fparam.isReference() && earg!.op === EXP.variable &&
                earg!.isVarExp()!.var_.toParent2() === fd) {
                const vx = earg!.isVarExp()!.var_.isVarDeclaration();
                if (vx === null) {
                    error(fd.loc, ds("%s `%s` cannot interpret `%s` as a `ref` parameter"), fd.kind(),
                        fd.toPrettyChars(), earg!.toChars());
                    return CTFEExp.cantexp!;
                }

                /* vx is a variable that is declared in fd.
                 * It means that fd is recursively called. e.g.
                 *
                 *  void fd(int n, ref int v = dummy) {
                 *      int vx;
                 *      if (n == 1) fd(2, vx);
                 *  }
                 *  fd(1);
                 *
                 * The old value of vx on the stack in fd(1)
                 * should be saved at the start of fd(2, vx) call.
                 */
                const oldadr = vx.ctfeAdrOnStack;

                ctfeGlobals.stack.push(vx);
                assert(!hasValue(vx)); // vx is made uninitialized

                // https://issues.dlang.org/show_bug.cgi?id=14299
                // v.ctfeAdrOnStack should be saved already
                // in the stack before the overwrite.
                v.ctfeAdrOnStack = oldadr;
                assert(hasValue(v)); // ref parameter v should refer existing value.
            }
            else {
                // Value parameters and non-trivial references
                setValueWithoutChecking(v, earg);
            }
        }

        if (fd.vresult !== null)
            ctfeGlobals.stack.push(fd.vresult);

        // Enter the function
        ++ctfeGlobals.callDepth;
        try {
            if (ctfeGlobals.callDepth > ctfeGlobals.maxCallDepth)
                ctfeGlobals.maxCallDepth = ctfeGlobals.callDepth;

            while (true) {
                if (ctfeGlobals.callDepth > CTFE_RECURSION_LIMIT) {
                    fdError(ds("CTFE recursion limit exceeded"));
                    e = CTFEExp.cantexp!;
                    break;
                }
                e = interpretStatement(pue, fd.fbody, istatex);
                if (CTFEExp.isCantExp(e)) {
                    // dropped: debug(LOG) block (dinterpret.d:680-683, non-debug build), the whole body of the `if`.
                }

                if (istatex.start !== null) {
                    error(fd.loc, ds("%s `%s` CTFE internal error: failed to resume at statement `%s`"), fd.kind(),
                        fd.toPrettyChars(), istatex.start.toChars()); // RootObject.toChars: assert(0), as in D
                    return CTFEExp.cantexp!;
                }

                /* This is how we deal with a recursive statement AST
                 * that has arbitrary goto statements in it.
                 * Bubble up a 'result' which is the target of the goto
                 * statement, then go recursively down the AST looking
                 * for that statement, then execute starting there.
                 */
                if (CTFEExp.isGotoExp(e)) {
                    istatex.start = istatex.gotoTarget; // set starting statement
                    istatex.gotoTarget = null;
                }
                else {
                    assert(e === null || (e.op !== EXP.continue_ && e.op !== EXP.break_));
                    break;
                }
            }
            // If fell off the end of a void function, return void
            if (e === null) {
                if (tf.next!.ty === TY.Tvoid)
                    e = CTFEExp.voidexp!;
                else {
                    /* missing a return statement can happen with C functions
                     * https://issues.dlang.org/show_bug.cgi?id=23056
                     */
                    fdError(ds("no return value from function"));
                    e = CTFEExp.cantexp!;
                }
            }

            if (tf.isRef && e.op === EXP.variable && e.isVarExp()!.var_ === fd.vthis)
                e = thisarg;
            if (tf.isRef && fd.hasDualContext && e!.op === EXP.index) {
                const ie = e!.isIndexExp()!;
                const pe = ie.e1!.isPtrExp();
                const ve = pe === null ? null : pe.e1!.isVarExp();
                if (ve !== null && ve.var_ === fd.vthis) {
                    const ne = ie.e2!.isIntegerExp();
                    assert(ne !== null);
                    const ale = thisarg!.isAddrExp()!.e1!.isArrayLiteralExp()!;
                    // `cast(size_t)ne.getInteger()` — an element index into the 2-slot context literal (09 §1.1)
                    e = ale.elements!.opIndex(Number(ne.getInteger()));
                    const ae = e!.isAddrExp();
                    if (ae !== null) {
                        e = ae.e1;
                    }
                }
            }
        } catch (ex) {
            --ctfeGlobals.callDepth; // repair on a wall's exit path D does not have (11 §2.5)
            throw ex;
        }

        // Leave the function
        --ctfeGlobals.callDepth;
    } catch (ex) {
        ctfeGlobals.stack.endFrame(); // repair on a wall's exit path D does not have (11 §2.5)
        throw ex;
    }

    ctfeGlobals.stack.endFrame();

    // If it generated an uncaught exception, report error.
    if (istate === null && e!.isThrownExceptionExp() !== null) {
        if (e === pue.exp())
            e = pue.copy();
        generateUncaughtError(e!.isThrownExceptionExp()!);
        e = CTFEExp.cantexp!;
    }

    return e;
}

/// used to collect coverage information in ctfe
/// dmd/dinterpret.d:762 — `void incUsageCtfe(InterState* istate, Loc loc)`.
function incUsageCtfe(istate: InterState | null, loc: Loc): void {
    if (global.params.ctfe_cov && istate !== null) {
        const line = loc.linnum();
        const mod = istate.fd!.getModule()!;

        // `++mod.ctfe_cov[line]` — a D AA `++` on a missing key inserts the default 0 first
        mod.ctfe_cov.set(line, (mod.ctfe_cov.get(line) ?? 0) + 1);
    }
}

/***********************************
 * Interpret the statement.
 * Params:
 *    s = Statement to interpret
 *    istate = context
 * Returns:
 *      NULL    continue to next statement
 *      EXP.cantExpression      cannot interpret statement at compile time
 *      !NULL   expression from return statement, or thrown exception
 *
 * dmd/dinterpret.d:784 — `Expression interpretStatement(Statement s, InterState* istate)`: the pue-less
 * overload, Form B `No<ParamName>` (04 §1).
 */
function interpretStatementNoPue(s: Statement | null, istate: InterState): Expression | null {
    const ue = new UnionExp();
    let result = interpretStatement(ue, s, istate);
    if (result === ue.exp())
        result = ue.copy();
    return result;
}

///
/// dmd/dinterpret.d:794 — `Expression interpretStatement(UnionExp* pue, Statement s, InterState* istate)`.
/// Idiom C (13 §7.6): the nested `visitXxx` handlers are inner arrows sharing the closure-captured `result`,
/// `pue` and `istate` (04 §5), dispatched by the inlined `VisitStatement` switch at the end.
function interpretStatement(pue: UnionExp, s: Statement | null, istate: InterState): Expression | null {
    let result: Expression | null = null;

    // If e is EXP.throw_exception or EXP.cantExpression,
    // set it to 'result' and returns true.
    // dmd/dinterpret.d:800 — `bool exceptionOrCant(Expression e)`.
    const exceptionOrCant = (e: Expression | null): boolean => {
        if (exceptionOrCantInterpret(e)) {
            // Make sure e is not pointing to a stack temporary
            result = (e!.op === EXP.cantExpression) ? CTFEExp.cantexp! : e;
            return true;
        }
        return false;
    };

    /******************************** Statement ***************************/

    // dmd/dinterpret.d:813 — `void visitDefaultCase(Statement s)`. NOT `assert(0)` here (13 §7.6 rule 3):
    // it reports the statement and answers cantexp.
    const visitDefaultCase = (s: Statement): void => {
        if (istate.start !== null) {
            if (istate.start !== s)
                return;
            istate.start = null;
        }

        // `s.toChars()` is RootObject.toChars (assert(0)): the argument throws before error() prints, as in D.
        error(s.loc, ds("statement `%s` cannot be interpreted at compile time"), s.toChars());
        result = CTFEExp.cantexp!;
    };

    // dmd/dinterpret.d:830 — `void visitExp(ExpStatement s)`.
    const visitExp = (s: ExpStatement): void => {
        if (istate.start !== null) {
            if (istate.start !== s)
                return;
            istate.start = null;
        }
        if (s.exp !== null && s.exp.hasCode())
            incUsageCtfe(istate, s.loc);

        const e = interpret(pue, s.exp, istate, CTFEGoal.Nothing);
        if (exceptionOrCant(e))
            return;
    };

    // dmd/dinterpret.d:850 — `void visitDtorExp(DtorExpStatement s)`.
    const visitDtorExp = (s: DtorExpStatement): void => {
        visitExp(s);
    };

    // dmd/dinterpret.d:855 — `void visitCompound(CompoundStatement s)`.
    const visitCompound = (s: CompoundStatement): void => {
        if (istate.start === s)
            istate.start = null;

        const dim = s.statements !== null ? s.statements.length : 0;
        for (let i = 0; i < dim; i++) {
            const sx = s.statements!.opIndex(i);
            result = interpretStatement(pue, sx, istate);
            if (result !== null)
                break;
        }
    };

    // dmd/dinterpret.d:878 — `void visitCompoundAsm(CompoundAsmStatement s)`.
    const visitCompoundAsm = (s: CompoundAsmStatement): void => {
        visitCompound(s);
    };

    // dmd/dinterpret.d:883 — `void visitUnrolledLoop(UnrolledLoopStatement s)`.
    const visitUnrolledLoop = (s: UnrolledLoopStatement): void => {
        if (istate.start === s)
            istate.start = null;

        const dim = s.statements !== null ? s.statements.length : 0;
        for (let i = 0; i < dim; i++) {
            const sx = s.statements!.opIndex(i);
            const e = interpretStatement(pue, sx, istate);
            if (e === null) // succeeds to interpret, or goto target was not found
                continue;
            if (exceptionOrCant(e))
                return;
            if (e.op === EXP.break_) {
                if (istate.gotoTarget !== null && istate.gotoTarget !== s) {
                    result = e; // break at a higher level
                    return;
                }
                istate.gotoTarget = null;
                result = null;
                return;
            }
            if (e.op === EXP.continue_) {
                if (istate.gotoTarget !== null && istate.gotoTarget !== s) {
                    result = e; // continue at a higher level
                    return;
                }
                istate.gotoTarget = null;
                continue;
            }

            // expression from return statement, or thrown exception
            result = e;
            break;
        }
    };

    // dmd/dinterpret.d:929 — `void visitIf(IfStatement s)`.
    const visitIf = (s: IfStatement): void => {
        incUsageCtfe(istate, s.loc);
        if (istate.start === s)
            istate.start = null;
        if (istate.start !== null) {
            let e: Expression | null = null;
            e = interpretStatementNoPue(s.ifbody, istate);
            if (e === null && istate.start !== null)
                e = interpretStatementNoPue(s.elsebody, istate);
            result = e;
            return;
        }

        const ue = new UnionExp();
        const e = interpret(ue, s.condition, istate);
        assert(e !== null);
        if (exceptionOrCant(e))
            return;

        if (isTrueBool(e))
            result = interpretStatement(pue, s.ifbody, istate);
        else if (toBool(e).hasValue(false))
            result = interpretStatement(pue, s.elsebody, istate);
        else {
            // no error, or assert(0)?
            result = CTFEExp.cantexp!;
        }
    };

    // dmd/dinterpret.d:965 — `void visitScope(ScopeStatement s)`.
    const visitScope = (s: ScopeStatement): void => {
        if (istate.start === s)
            istate.start = null;

        result = interpretStatement(pue, s.statement, istate);
    };

    // dmd/dinterpret.d:977 — `void visitReturn(ReturnStatement s)`.
    const visitReturn = (s: ReturnStatement): void => {
        if (istate.start !== null) {
            if (istate.start !== s)
                return;
            istate.start = null;
        }

        if (s.exp === null) {
            result = CTFEExp.voidexp!;
            return;
        }

        incUsageCtfe(istate, s.loc);
        assert(istate !== null && istate.fd !== null && istate.fd.type !== null && istate.fd.type.ty === TY.Tfunction);
        // D `cast(TypeFunction)istate.fd.type` — tag-proved RTTI downcast (02 §11.5c #3): the assert above
        // established `ty == Tfunction`.
        const tf: TypeFunction = istate.fd.type.isTypeFunction()!;

        /* If the function returns a ref AND it's been called from an assignment,
         * we need to return an lvalue. Otherwise, just do an (rvalue) interpret.
         */
        if (tf.isRef) {
            result = interpret(pue, s.exp, istate, CTFEGoal.LValue);
            return;
        }
        if (tf.next !== null && tf.next.ty === TY.Tdelegate && istate.fd.closureVars.length > 0) {
            // To support this, we need to copy all the closure vars
            // into the delegate literal.
            error(s.loc, ds("closures are not yet supported in CTFE"));
            result = CTFEExp.cantexp!;
            return;
        }

        // We need to treat pointers specially, because EXP.symbolOffset can be used to
        // return a value OR a pointer
        let e = interpret(pue, s.exp, istate);
        if (exceptionOrCant(e))
            return;

        /**
         * Interpret `return a ~= b` (i.e. `return _d_arrayappendT{,Trace}(a, b)`) as:
         *     a ~= b;
         *     return a;
         * This is needed because `a ~= b` has to be interpreted as an lvalue, in order to avoid
         * assigning a larger array into a smaller one, such as:
         *    `a = [1, 2], a ~= [3]` => `[1, 2] ~= [3]` => `[1, 2] = [1, 2, 3]`
         */

        // Disallow returning pointers to stack-allocated variables (bug 7876)
        if (!stopPointersEscaping(s.loc, e!)) {
            result = CTFEExp.cantexp!;
            return;
        }

        if (needToCopyLiteral(e!))
            e = copyLiteral(e!).copy();
        result = e;
    };

    // dmd/dinterpret.d:1049 — `void visitBreak(BreakStatement s)`.
    const visitBreak = (s: BreakStatement): void => {
        incUsageCtfe(istate, s.loc);
        if (istate.start !== null) {
            if (istate.start !== s)
                return;
            istate.start = null;
        }

        istate.gotoTarget = findGotoTarget(istate, s.ident);
        result = CTFEExp.breakexp!;
    };

    // dmd/dinterpret.d:1067 — `void visitContinue(ContinueStatement s)`.
    const visitContinue = (s: ContinueStatement): void => {
        incUsageCtfe(istate, s.loc);
        if (istate.start !== null) {
            if (istate.start !== s)
                return;
            istate.start = null;
        }

        istate.gotoTarget = findGotoTarget(istate, s.ident);
        result = CTFEExp.continueexp!;
    };

    // dmd/dinterpret.d:1085 — `void visitWhile(WhileStatement s)`.
    const visitWhile = (_s: WhileStatement): void => {
        assertUnreachable(); // rewritten to ForStatement
    };

    // dmd/dinterpret.d:1094 — `void visitDo(DoStatement s)`.
    const visitDo = (s: DoStatement): void => {
        if (istate.start === s)
            istate.start = null;

        while (true) {
            let e = interpretStatementNoPue(s._body, istate);
            if (e === null && istate.start !== null) // goto target was not found
                return;
            assert(istate.start === null);

            if (exceptionOrCant(e))
                return;
            if (e !== null && e.op === EXP.break_) {
                if (istate.gotoTarget !== null && istate.gotoTarget !== s) {
                    result = e; // break at a higher level
                    return;
                }
                istate.gotoTarget = null;
                break;
            }
            if (e !== null && e.op === EXP.continue_) {
                if (istate.gotoTarget !== null && istate.gotoTarget !== s) {
                    result = e; // continue at a higher level
                    return;
                }
                istate.gotoTarget = null;
                e = null;
            }
            if (e !== null) {
                result = e; // bubbled up from ReturnStatement
                return;
            }

            const ue = new UnionExp();
            incUsageCtfe(istate, s.condition!.loc);
            e = interpret(ue, s.condition, istate);
            if (exceptionOrCant(e))
                return;
            if (e!.isConst() === 0) {
                result = CTFEExp.cantexp!;
                return;
            }
            if (toBool(e!).hasValue(false))
                break;
            assert(isTrueBool(e!));
        }
        assert(result === null);
    };

    // dmd/dinterpret.d:1155 — `void visitFor(ForStatement s)`.
    const visitFor = (s: ForStatement): void => {
        if (istate.start === s)
            istate.start = null;

        const ueinit = new UnionExp();
        const ei = interpretStatement(ueinit, s._init, istate);
        if (exceptionOrCant(ei))
            return;
        assert(ei === null); // s.init never returns from function, or jumps out from it

        while (true) {
            if (s.condition !== null && istate.start === null) {
                const ue = new UnionExp();
                incUsageCtfe(istate, s.condition.loc);
                const e = interpret(ue, s.condition, istate);
                if (exceptionOrCant(e))
                    return;
                if (toBool(e!).hasValue(false))
                    break;
                assert(isTrueBool(e!));
            }

            let e = interpretStatement(pue, s._body, istate);
            if (e === null && istate.start !== null) // goto target was not found
                return;
            assert(istate.start === null);

            if (exceptionOrCant(e))
                return;
            if (e !== null && e.op === EXP.break_) {
                if (istate.gotoTarget !== null && istate.gotoTarget !== s) {
                    result = e; // break at a higher level
                    return;
                }
                istate.gotoTarget = null;
                break;
            }
            if (e !== null && e.op === EXP.continue_) {
                if (istate.gotoTarget !== null && istate.gotoTarget !== s) {
                    result = e; // continue at a higher level
                    return;
                }
                istate.gotoTarget = null;
                e = null;
            }
            if (e !== null) {
                result = e; // bubbled up from ReturnStatement
                return;
            }

            const uei = new UnionExp();
            if (s.increment !== null)
                incUsageCtfe(istate, s.increment.loc);
            e = interpret(uei, s.increment, istate, CTFEGoal.Nothing);
            if (exceptionOrCant(e))
                return;
        }
        assert(result === null);
    };

    // dmd/dinterpret.d:1227 — `void visitForeach(ForeachStatement s)`.
    const visitForeach = (_s: ForeachStatement): void => {
        assertUnreachable(); // rewritten to ForStatement
    };

    // dmd/dinterpret.d:1232 — `void visitForeachRange(ForeachRangeStatement s)`.
    const visitForeachRange = (_s: ForeachRangeStatement): void => {
        assertUnreachable(); // rewritten to ForStatement
    };

    // dmd/dinterpret.d:1237 — `void visitSwitch(SwitchStatement s)`.
    const visitSwitch = (s: SwitchStatement): void => {
        incUsageCtfe(istate, s.loc);
        if (istate.start === s)
            istate.start = null;
        if (istate.start !== null) {
            let e = interpretStatementNoPue(s._body, istate);
            if (istate.start !== null) // goto target was not found
                return;
            if (exceptionOrCant(e))
                return;
            if (e !== null && e.op === EXP.break_) {
                if (istate.gotoTarget !== null && istate.gotoTarget !== s) {
                    result = e; // break at a higher level
                    return;
                }
                istate.gotoTarget = null;
                e = null;
            }
            result = e;
            return;
        }

        const uecond = new UnionExp();
        const econdition = interpret(uecond, s.condition, istate);
        if (exceptionOrCant(econdition))
            return;

        let scase: Statement | null = null;
        if (s.cases !== null)
            for (const cs of s.cases) {
                const uecase = new UnionExp();
                const ecase = interpret(uecase, cs!.exp, istate);
                if (exceptionOrCant(ecase))
                    return;
                if (ctfeEqual(cs!.exp!.loc, EXP.equal, econdition!, ecase!)) {
                    scase = cs;
                    break;
                }
            }
        if (scase === null) {
            if (!s.hasDefault)
                error(s.loc, ds("no `default` or `case` for `%s` in `switch` statement"), econdition!.toChars());
            scase = s.sdefault;
        }

        assert(scase !== null);

        /* Jump to scase
         */
        istate.start = scase;
        let e = interpretStatement(pue, s._body, istate);
        assert(istate.start === null); // jump must not fail
        if (e !== null && e.op === EXP.break_) {
            if (istate.gotoTarget !== null && istate.gotoTarget !== s) {
                result = e; // break at a higher level
                return;
            }
            istate.gotoTarget = null;
            e = null;
        }
        result = e;
    };

    // dmd/dinterpret.d:1313 — `void visitCase(CaseStatement s)`.
    const visitCase = (s: CaseStatement): void => {
        incUsageCtfe(istate, s.loc);
        if (istate.start === s)
            istate.start = null;

        result = interpretStatement(pue, s.statement, istate);
    };

    // dmd/dinterpret.d:1326 — `void visitDefault(DefaultStatement s)`.
    const visitDefault = (s: DefaultStatement): void => {
        incUsageCtfe(istate, s.loc);
        if (istate.start === s)
            istate.start = null;

        result = interpretStatement(pue, s.statement, istate);
    };

    // dmd/dinterpret.d:1339 — `void visitGoto(GotoStatement s)`.
    const visitGoto = (s: GotoStatement): void => {
        if (istate.start !== null) {
            if (istate.start !== s)
                return;
            istate.start = null;
        }
        incUsageCtfe(istate, s.loc);

        assert(s.label !== null && s.label.statement !== null);
        istate.gotoTarget = s.label.statement;
        result = CTFEExp.gotoexp!;
    };

    // dmd/dinterpret.d:1358 — `void visitGotoCase(GotoCaseStatement s)`.
    const visitGotoCase = (s: GotoCaseStatement): void => {
        if (istate.start !== null) {
            if (istate.start !== s)
                return;
            istate.start = null;
        }
        incUsageCtfe(istate, s.loc);

        assert(s.cs !== null);
        istate.gotoTarget = s.cs;
        result = CTFEExp.gotoexp!;
    };

    // dmd/dinterpret.d:1377 — `void visitGotoDefault(GotoDefaultStatement s)`.
    const visitGotoDefault = (s: GotoDefaultStatement): void => {
        if (istate.start !== null) {
            if (istate.start !== s)
                return;
            istate.start = null;
        }
        incUsageCtfe(istate, s.loc);

        assert(s.sw !== null && s.sw.sdefault !== null);
        istate.gotoTarget = s.sw.sdefault;
        result = CTFEExp.gotoexp!;
    };

    // dmd/dinterpret.d:1396 — `void visitLabel(LabelStatement s)`.
    const visitLabel = (s: LabelStatement): void => {
        if (istate.start === s)
            istate.start = null;

        result = interpretStatement(pue, s.statement, istate);
    };

    // dmd/dinterpret.d:1408 — `void visitTryCatch(TryCatchStatement s)`.
    const visitTryCatch = (s: TryCatchStatement): void => {
        if (istate.start === s)
            istate.start = null;
        if (istate.start !== null) {
            let e: Expression | null = null;
            e = interpretStatement(pue, s._body, istate);
            for (const ca of s.catches!) {
                if (e !== null || istate.start === null) // goto target was found
                    break;
                e = interpretStatement(pue, ca!.handler, istate);
            }
            result = e;
            return;
        }

        let e = interpretStatementNoPue(s._body, istate);

        // An exception was thrown
        if (e !== null && e.isThrownExceptionExp() !== null) {
            const ex = e.isThrownExceptionExp()!;
            const extype = ex.thrown!.originalClass()!.type;

            // Search for an appropriate catch clause.
            for (const ca of s.catches!) {
                const catype = ca!.type!;
                // hoisted: fn-local `import dmd.typesem : isBaseOf;` (dinterpret.d:1442) — the Type overload
                if (!catype.equals(extype) && !isBaseOf(catype, extype, null))
                    continue;

                // Execute the handler
                if (ca!.var_ !== null) {
                    ctfeGlobals.stack.push(ca!.var_);
                    // `!`: D dereferences newval in setValue's assert (dinterpret.d:7559)
                    setValue(ca!.var_, ex.thrown!);
                }
                e = interpretStatementNoPue(ca!.handler, istate);
                while (CTFEExp.isGotoExp(e)) {
                    /* This is an optimization that relies on the locality of the jump target.
                     * If the label is in the same catch handler, the following scan
                     * would find it quickly and can reduce jump cost.
                     * Otherwise, the catch block may be unnnecessary scanned again
                     * so it would make CTFE speed slower.
                     */
                    const istatex = istate.copy(); // dmd/dinterpret.d:1461 — `InterState istatex = *istate;`
                    istatex.start = istate.gotoTarget; // set starting statement
                    istatex.gotoTarget = null;
                    const eh = interpretStatementNoPue(ca!.handler, istatex);
                    if (istatex.start !== null) {
                        // The goto target is outside the current scope.
                        break;
                    }
                    // The goto target was within the body.
                    if (CTFEExp.isCantExp(eh)) {
                        e = eh;
                        break;
                    }
                    // dmd/dinterpret.d:1476 — `*istate = istatex;`: in-place overwrite, identity preserved (03 §1.1:
                    // flat struct, class-ref fields shared)
                    Object.assign(istate, istatex);
                    e = eh;
                }
                break;
            }
        }
        result = e;
    };

    // dmd/dinterpret.d:1485 — `void visitTryFinally(TryFinallyStatement s)`.
    const visitTryFinally = (s: TryFinallyStatement): void => {
        if (istate.start === s)
            istate.start = null;
        if (istate.start !== null) {
            let e: Expression | null = null;
            e = interpretStatement(pue, s._body, istate);
            // Jump into/out from finalbody is disabled in semantic analysis.
            // and jump inside will be handled by the ScopeStatement == finalbody.
            result = e;
            return;
        }

        let ex = interpretStatementNoPue(s._body, istate);
        if (CTFEExp.isCantExp(ex)) {
            result = ex;
            return;
        }
        while (CTFEExp.isGotoExp(ex)) {
            // If the goto target is within the body, we must not interpret the finally statement,
            // because that will call destructors for objects within the scope, which we should not do.
            const istatex = istate.copy(); // dmd/dinterpret.d:1513 — `InterState istatex = *istate;`
            istatex.start = istate.gotoTarget; // set starting statement
            istatex.gotoTarget = null;
            const bex = interpretStatementNoPue(s._body, istatex);
            if (istatex.start !== null) {
                // The goto target is outside the current scope.
                break;
            }
            // The goto target was within the body.
            if (CTFEExp.isCantExp(bex)) {
                result = bex;
                return;
            }
            // dmd/dinterpret.d:1528 — `*istate = istatex;`: in-place overwrite, identity preserved (03 §1.1: flat
            // struct, class-ref fields shared)
            Object.assign(istate, istatex);
            ex = bex;
        }

        const ey = interpretStatementNoPue(s.finalbody, istate);
        if (CTFEExp.isCantExp(ey)) {
            result = ey;
            return;
        }
        if (ey !== null && ey.isThrownExceptionExp() !== null) {
            // Check for collided exceptions
            if (ex !== null && ex.isThrownExceptionExp() !== null)
                ex = chainExceptions(ex.isThrownExceptionExp()!, ey.isThrownExceptionExp()!);
            else
                ex = ey;
        }
        result = ex;
    };

    // dmd/dinterpret.d:1549 — `void visitThrow(ThrowStatement s)`.
    const visitThrow = (s: ThrowStatement): void => {
        if (istate.start !== null) {
            if (istate.start !== s)
                return;
            istate.start = null;
        }

        // dmd/dinterpret.d:1562 — `interpretThrow(result, s.exp, s.loc, istate);`: `ref Expression result`
        // -> a box over the captured `result`, written back after the call (03 §7.2).
        const resultRef: Ref<Expression | null> = { value: result };
        interpretThrow(resultRef, s.exp!, s.loc, istate);
        result = resultRef.value;
    };

    // dmd/dinterpret.d:1565 — `void visitScopeGuard(ScopeGuardStatement s)`.
    const visitScopeGuard = (_s: ScopeGuardStatement): void => {
        assertUnreachable();
    };

    // dmd/dinterpret.d:1570 — `void visitWith(WithStatement s)`.
    const visitWith = (s: WithStatement): void => {
        if (istate.start === s)
            istate.start = null;
        if (istate.start !== null) {
            result = s._body !== null ? interpretStatementNoPue(s._body, istate) : null;
            return;
        }

        // If it is with(Enum) {...}, just execute the body.
        if (s.exp!.op === EXP.scope_ || s.exp!.op === EXP.type) {
            result = interpretStatement(pue, s._body, istate);
            return;
        }

        incUsageCtfe(istate, s.loc);

        let e = interpretNoPue(s.exp, istate);
        if (exceptionOrCant(e))
            return;

        if (s.wthis!.type!.ty === TY.Tpointer && s.exp!.type!.ty !== TY.Tpointer) {
            e = ctfeEmplaceExp(() => new AddrExp(s.loc, e, s.wthis!.type));
        }
        ctfeGlobals.stack.push(s.wthis!);
        // Paired state (11 §2.5): D pops at one line (D:1630) with no early exit in between; a wall reached through
        // interpretStatementNoPue adds a throw exit, so the pop moves into `finally` (single-release form).
        try {
            setValue(s.wthis!, e!); // `!`: D dereferences newval in setValue's assert (dinterpret.d:7559)
            e = interpretStatementNoPue(s._body, istate);
            while (CTFEExp.isGotoExp(e)) {
                /* This is an optimization that relies on the locality of the jump target.
                 * If the label is in the same WithStatement, the following scan
                 * would find it quickly and can reduce jump cost.
                 * Otherwise, the statement body may be unnnecessary scanned again
                 * so it would make CTFE speed slower.
                 */
                const istatex = istate.copy(); // dmd/dinterpret.d:1612 — `InterState istatex = *istate;`
                istatex.start = istate.gotoTarget; // set starting statement
                istatex.gotoTarget = null;
                const ex = interpretStatementNoPue(s._body, istatex);
                if (istatex.start !== null) {
                    // The goto target is outside the current scope.
                    break;
                }
                // The goto target was within the body.
                if (CTFEExp.isCantExp(ex)) {
                    e = ex;
                    break;
                }
                // dmd/dinterpret.d:1627 — `*istate = istatex;`: in-place overwrite, identity preserved (03 §1.1:
                // flat struct, class-ref fields shared)
                Object.assign(istate, istatex);
                e = ex;
            }
        } finally {
            ctfeGlobals.stack.pop(s.wthis!);
        }
        result = e;
    };

    // dmd/dinterpret.d:1634 — `void visitAsm(AsmStatement s)`.
    const visitAsm = (s: AsmStatement): void => {
        if (istate.start !== null) {
            if (istate.start !== s)
                return;
            istate.start = null;
        }
        error(s.loc, ds("`asm` statements cannot be interpreted at compile time"));
        result = CTFEExp.cantexp!;
    };

    // dmd/dinterpret.d:1650 — `void visitInlineAsm(InlineAsmStatement s)`.
    const visitInlineAsm = (s: InlineAsmStatement): void => {
        visitAsm(s);
    };

    // dmd/dinterpret.d:1655 — `void visitGccAsm(GccAsmStatement s)`.
    const visitGccAsm = (s: GccAsmStatement): void => {
        visitAsm(s);
    };

    // dmd/dinterpret.d:1660 — `void visitImport(ImportStatement s)`.
    const visitImport = (s: ImportStatement): void => {
        if (istate.start !== null) {
            if (istate.start !== s)
                return;
            istate.start = null;
        }
    };

    if (s === null)
        return null;

    // dmd/dinterpret.d:1677-1678 — `mixin VisitStatement!void visit;` + `visit.VisitStatement(s);`.
    // resolved: mixin VisitStatement!void + visitStmtCase (dmd/statement.d:1981) -> inlined dispatch
    // switch, ALL 44 arms (13 §7.6). An arm whose `visitXxx` handler does not exist in this function
    // routes to `visitDefaultCase` — never to a "related" handler (STMT.CompoundDeclaration included,
    // although CompoundDeclarationStatement derives from CompoundStatement). Here visitDefaultCase is the
    // "cannot be interpreted at compile time" error, not `assert(0)`. STMT.InlineAsm and STMT.GccAsm DO
    // have handlers in this function (visitInlineAsm, visitGccAsm), so they route to them.
    switch (s.stmt) {
        case STMT.Error:               visitDefaultCase(s.isErrorStatement()!); break;
        case STMT.Scope:               visitScope(s.isScopeStatement()!); break;
        case STMT.Exp:                 visitExp(s.isExpStatement()!); break;
        case STMT.Compound:            visitCompound(s.isCompoundStatement()!); break;
        case STMT.Return:              visitReturn(s.isReturnStatement()!); break;
        case STMT.If:                  visitIf(s.isIfStatement()!); break;
        case STMT.Conditional:         visitDefaultCase(s.isConditionalStatement()!); break;
        case STMT.StaticForeach:       visitDefaultCase(s.isStaticForeachStatement()!); break;
        case STMT.Case:                visitCase(s.isCaseStatement()!); break;
        case STMT.Default:             visitDefault(s.isDefaultStatement()!); break;
        case STMT.Label:               visitLabel(s.isLabelStatement()!); break;
        case STMT.Goto:                visitGoto(s.isGotoStatement()!); break;
        case STMT.GotoDefault:         visitGotoDefault(s.isGotoDefaultStatement()!); break;
        case STMT.GotoCase:            visitGotoCase(s.isGotoCaseStatement()!); break;
        case STMT.Break:               visitBreak(s.isBreakStatement()!); break;
        case STMT.DtorExp:             visitDtorExp(s.isDtorExpStatement()!); break;
        case STMT.Mixin:               visitDefaultCase(s.isMixinStatement()!); break;
        case STMT.Forwarding:          visitDefaultCase(s.isForwardingStatement()!); break;
        case STMT.Do:                  visitDo(s.isDoStatement()!); break;
        case STMT.While:               visitWhile(s.isWhileStatement()!); break;
        case STMT.For:                 visitFor(s.isForStatement()!); break;
        case STMT.Foreach:             visitForeach(s.isForeachStatement()!); break;
        case STMT.Switch:              visitSwitch(s.isSwitchStatement()!); break;
        case STMT.Continue:            visitContinue(s.isContinueStatement()!); break;
        case STMT.With:                visitWith(s.isWithStatement()!); break;
        case STMT.TryCatch:            visitTryCatch(s.isTryCatchStatement()!); break;
        case STMT.Throw:               visitThrow(s.isThrowStatement()!); break;
        case STMT.Debug:               visitDefaultCase(s.isDebugStatement()!); break;
        case STMT.TryFinally:          visitTryFinally(s.isTryFinallyStatement()!); break;
        case STMT.ScopeGuard:          visitScopeGuard(s.isScopeGuardStatement()!); break;
        case STMT.SwitchError:         visitDefaultCase(s.isSwitchErrorStatement()!); break;
        case STMT.UnrolledLoop:        visitUnrolledLoop(s.isUnrolledLoopStatement()!); break;
        case STMT.ForeachRange:        visitForeachRange(s.isForeachRangeStatement()!); break;
        case STMT.CompoundDeclaration: visitDefaultCase(s.isCompoundDeclarationStatement()!); break;
        case STMT.Peel:                visitDefaultCase(s.isPeelStatement()!); break;
        case STMT.CompoundAsm:         visitCompoundAsm(s.isCompoundAsmStatement()!); break;
        case STMT.Pragma:              visitDefaultCase(s.isPragmaStatement()!); break;
        case STMT.StaticAssert:        visitDefaultCase(s.isStaticAssertStatement()!); break;
        case STMT.CaseRange:           visitDefaultCase(s.isCaseRangeStatement()!); break;
        case STMT.Synchronized:        visitDefaultCase(s.isSynchronizedStatement()!); break;
        case STMT.Asm:                 visitAsm(s.isAsmStatement()!); break;
        case STMT.InlineAsm:           visitInlineAsm(s.isInlineAsmStatement()!); break;
        case STMT.GccAsm:              visitGccAsm(s.isGccAsmStatement()!); break;
        case STMT.Import:              visitImport(s.isImportStatement()!); break;
        default: { const _e: never = s.stmt; throw new SwitchError(_e); }   // D `final switch` (06 §3.2)
    }
    return result;
}

/**
 * dmd/dinterpret.d:3024 — `private alias fp_t = extern (D) UnionExp function(Loc loc, Type, Expression, Expression);`
 * Declared inside `class Interpreter` in D; emitted at module level because a TS type alias cannot be a class
 * member (02 §5.2). Call sites pass the constfold folds (`Add`, `Min`, …) directly, where D writes `&Add`.
 */
type fp_t = (loc: Loc, type: Type, e1: Expression, e2: Expression) => UnionExp;

/**
 * dmd/dinterpret.d:3025 — `private alias fp2_t = extern (D) bool function(Loc loc, EXP, Expression, Expression);`
 * Module level for the same reason as `fp_t`. Call sites pass `ctfeEqual`, `ctfeIdentity`, `ctfeCmp` directly.
 */
type fp2_t = (loc: Loc, op: EXP, e1: Expression, e2: Expression) => boolean;

/**
 * dmd/dinterpret.d:1684 — `private extern (C++) final class Interpreter : Visitor`. Idiom A (13 §7).
 * `final` erased (04 §8); D `private` → not exported.
 * dropped: `alias visit = Visitor.visit;` (dinterpret.d:1686) — no overload hiding in TS (13 §1).
 * dropped: every `debug (LOG)` block of the class body (non-debug build, _config §3).
 */
class Interpreter extends Visitor {
    istate: InterState | null;          // D:1688 (null from ctfeInterpret's interpretNoPue(e, null))
    goal: CTFEGoal;                     // D:1689
    result: Expression | null = null;   // D:1690
    pue: UnionExp;                      // D:1691 storage for `result` (never null: no D caller passes null)

    /// dinterpret.d:1693 — `extern (D) this(UnionExp* pue, InterState* istate, CTFEGoal goal) scope @safe`
    constructor(pue: UnionExp, istate: InterState | null, goal: CTFEGoal) {
        super();
        this.pue = pue;
        this.istate = istate;
        this.goal = goal;
    }

    /// dmd/dinterpret.d:1702.
    // If e is EXP.throw_exception or EXP.cantExpression,
    // set it to 'result' and returns true.
    exceptionOrCant(e: Expression | null): boolean {
        if (exceptionOrCantInterpret(e)) {
            // Make sure e is not pointing to a stack temporary
            this.result = (e!.op === EXP.cantExpression) ? CTFEExp.cantexp! : e;
            return true;
        }
        return false;
    }

    /******************************** Expression ***************************/

    /// dmd/dinterpret.d:1715.
    override visitExpression(e: Expression): void {
        error(e.loc, ds("cannot interpret `%s` at compile time"), e.toChars());
        this.result = CTFEExp.cantexp!;
    }

    /// dmd/dinterpret.d:1727.
    override visitTypeExp(e: TypeExp): void {
        this.result = e;
    }

    /// dmd/dinterpret.d:1736.
    override visitThisExp(e: ThisExp): void {
        if (this.goal === CTFEGoal.LValue) {
            // We might end up here with istate being zero
            // https://issues.dlang.org/show_bug.cgi?id=16382
            if (this.istate !== null && this.istate.fd!.vthis !== null) {
                this.result = ctfeEmplaceExp(() => new VarExp(e.loc, this.istate!.fd!.vthis!));
                if (this.istate.fd!.hasDualContext) {
                    this.result = ctfeEmplaceExp(() => new PtrExp(e.loc, this.result));
                    this.result.type = sarrayOf(Type.tvoidptr, 2n);
                    this.result = ctfeEmplaceExp(() => new IndexExp(e.loc, this.result, IntegerExp.literal(0)));
                }
                this.result.type = e.type;
            } else
                this.result = e;
            return;
        }

        this.result = ctfeGlobals.stack.getThis();
        if (this.result !== null) {
            if (this.istate !== null && this.istate.fd!.hasDualContext) {
                assert(this.result.op === EXP.address);
                this.result = this.result.isAddrExp()!.e1;
                assert(this.result!.op === EXP.arrayLiteral);
                this.result = this.result!.isArrayLiteralExp()!.elements!.opIndex(0);
                if (e.type!.ty === TY.Tstruct) {
                    this.result = this.result!.isAddrExp()!.e1;
                }
                return;
            }
            assert(this.result.op === EXP.structLiteral || this.result.op === EXP.classReference ||
                this.result.op === EXP.type);
            return;
        }
        error(e.loc, ds("value of `this` is not known at compile time"));
        this.result = CTFEExp.cantexp!;
    }

    /// dmd/dinterpret.d:1784.
    override visitNullExp(e: NullExp): void {
        this.result = e;
    }

    /// dmd/dinterpret.d:1789.
    override visitIntegerExp(e: IntegerExp): void {
        this.result = e;
    }

    /// dmd/dinterpret.d:1798.
    override visitRealExp(e: RealExp): void {
        this.result = e;
    }

    /// dmd/dinterpret.d:1807.
    override visitComplexExp(e: ComplexExp): void {
        this.result = e;
    }

    /// dmd/dinterpret.d:1812.
    override visitStringExp(e: StringExp): void {
        if (e.ownedByCtfe >= OwnedBy.ctfe) { // We've already interpreted the string
            this.result = e;
            return;
        }

        // D: `(cast(TypeNext)e.type).next` — tag-proved by the `ty != Tsarray` operand the `||` already
        // evaluated false (02 §11.5c #3).
        if (e.type!.ty !== TY.Tsarray ||
            (e.type!.isTypeSArray()!.next!.mod & (MODFlags.const_ | MODFlags.immutable_)) !== 0) {
            // If it's immutable, we don't need to dup it. Attempts to modify
            // string literals are prevented in BinExp::interpretAssignCommon.
            this.result = e;
        } else {
            // https://issues.dlang.org/show_bug.cgi?id=20811
            // Create a copy of mutable string literals, so that any change in
            // value via an index or slice will not survive CTFE.
            this.pue.emplace(copyLiteral(e).exp());
            this.result = this.pue.exp();
        }
    }

    /// dmd/dinterpret.d:1841.
    override visitFuncExp(e: FuncExp): void {
        this.result = e;
    }

    /// dmd/dinterpret.d:1850.
    override visitSymOffExp(e: SymOffExp): void {
        if (e.var_.isFuncDeclaration() !== null && e.offset === 0n) {
            this.result = e;
            return;
        }
        if (isTypeInfo_Class(e.type!) && e.offset === 0n) {
            this.result = e;
            return;
        }
        if (e.type!.ty !== TY.Tpointer) {
            // Probably impossible
            error(e.loc, ds("cannot interpret `%s` at compile time"), e.toChars());
            this.result = CTFEExp.cantexp!;
            return;
        }
        // D: `(cast(TypePointer)e.type).next` — tag-proved by the Tpointer test above (02 §11.5c #3).
        const pointee: Type = e.type!.isTypePointer()!.next!;
        if (e.var_.isThreadlocal()) {
            error(e.loc, ds("cannot take address of thread-local variable %s at compile time"), e.var_.toChars());
            this.result = CTFEExp.cantexp!;
            return;
        }
        // Check for taking an address of a shared variable.
        // If the shared variable is an array, the offset might not be zero.
        let fromType: Type | null = null;
        if (e.var_.type!.isStaticOrDynamicArray()) {
            // D: `(cast(TypeArray)e.var.type).next` — tag-proved by isStaticOrDynamicArray(), whose two tags
            // are exactly the two accessors (02 §11.5c #3).
            fromType = (e.var_.type!.isTypeSArray() ?? e.var_.type!.isTypeDArray())!.next;
        }
        // `e.offset + pointee.size()` is ulong arithmetic: wraps mod 2^64 (09 §3).
        if (e.var_.isDataseg() && ((e.offset === 0n && isSafePointerCast(e.var_.type!, pointee)) ||
                                   (fromType !== null && isSafePointerCast(fromType, pointee)) ||
                                   (e.var_.isCsymbol() &&
                                    toUint64(e.offset + size(pointee)) <= size(e.var_.type!)))) {
            this.result = e;
            return;
        }

        const val = Interpreter.getVarExp(e.loc, this.istate, e.var_, this.goal);
        if (this.exceptionOrCant(val))
            return;
        if (val!.type!.isStaticOrDynamicArray()) {
            // Check for unsupported type painting operations
            // D: `(cast(TypeArray)val.type).next` — tag-proved by isStaticOrDynamicArray() (02 §11.5c #3).
            const elemtype: Type = (val!.type!.isTypeSArray() ?? val!.type!.isTypeDArray())!.next!;
            const elemsize = size(elemtype);

            // It's OK to cast from fixed length to fixed length array, eg &int[n] to int[d]*.
            if (val!.type!.ty === TY.Tsarray && pointee.ty === TY.Tsarray && elemsize === size(nextOf(pointee)!)) {
                // D: `cast(size_t)(cast(TypeSArray)pointee).dim.toInteger()` — the cast is tag-proved by
                // `pointee.ty == Tsarray` (02 §11.5c #3). `d` feeds an IntegerExp value below, so it stays in
                // the bigint carrier (09 §1.1 role rule); `cast(size_t)` of the ulong carrier is the identity.
                const d: dinteger_t = toInteger(pointee.isTypeSArray()!.dim!);
                // ZERO DIVISOR: `elemsize` is 0 for a zero-size element type (`int[0]`, `noreturn`). ldc2 divides
                // with arm64 `udiv`, which yields 0, and compiles on with no error; so does the port, as at
                // dcast.d:1483 (09 §3.1).
                const elq: dinteger_t = elemsize === 0n ? 0n : e.offset / elemsize;
                const elwr: Expression = ctfeEmplaceExp(() => new IntegerExp(e.loc, elq, Type.tsize_t));
                const eupr: Expression = ctfeEmplaceExp(() => new IntegerExp(e.loc, elq + d, Type.tsize_t));

                // Create a CTFE pointer &val[ofs..ofs+d]
                const se = ctfeEmplaceExp(() => new SliceExp(e.loc, val, elwr, eupr));
                se.type = pointee;
                this.pue.emplace(new AddrExp(e.loc, se, e.type));
                this.result = this.pue.exp();
                return;
            }

            if (!isSafePointerCast(elemtype, pointee)) {
                // It's also OK to cast from &string to string*.
                if (e.offset === 0n && isSafePointerCast(e.var_.type!, pointee)) {
                    // Create a CTFE pointer &var
                    const ve = ctfeEmplaceExp(() => new VarExp(e.loc, e.var_));
                    ve.type = elemtype;
                    this.pue.emplace(new AddrExp(e.loc, ve, e.type));
                    this.result = this.pue.exp();
                    return;
                }
                error(e.loc, ds("reinterpreting cast from `%s` to `%s` is not supported in CTFE"),
                    val!.type!.toChars(), e.type!.toChars());
                this.result = CTFEExp.cantexp!;
                return;
            }

            const sz: dinteger_t = size(pointee);
            // ZERO DIVISOR: `sz` is 0 for a zero-size pointee (`int[0]`, `noreturn`). ldc2 divides with arm64 `udiv`,
            // which yields 0, and compiles on with no error; so does the port, as at dcast.d:1483 (09 §3.1).
            // Then `sz * indx` is 0, so the assert below holds only for offset 0, as in D.
            let indx: dinteger_t = sz === 0n ? 0n : e.offset / sz;
            assert(toUint64(sz * indx) === e.offset);
            let aggregate: Expression | null = null;
            if (val!.op === EXP.arrayLiteral || val!.op === EXP.string_) {
                aggregate = val;
            } else {
                const se = val!.isSliceExp();
                if (se !== null) {
                    aggregate = se.e1;
                    const uelwr = new UnionExp();
                    const lwr = interpret(uelwr, se.lwr, this.istate);
                    indx = toUint64(indx + toInteger(lwr!)); // `dinteger_t +=`: wraps mod 2^64 (09 §3)
                }
            }
            if (aggregate !== null) {
                // Create a CTFE pointer &aggregate[ofs]
                const ofs = ctfeEmplaceExp(() => new IntegerExp(e.loc, indx, Type.tsize_t));
                const ei = ctfeEmplaceExp(() => new IndexExp(e.loc, aggregate, ofs));
                ei.type = elemtype;
                this.pue.emplace(new AddrExp(e.loc, ei, e.type));
                this.result = this.pue.exp();
                return;
            }
        } else if (e.offset === 0n && isSafePointerCast(e.var_.type!, pointee)) {
            // Create a CTFE pointer &var
            const ve = ctfeEmplaceExp(() => new VarExp(e.loc, e.var_));
            ve.type = e.var_.type;
            this.pue.emplace(new AddrExp(e.loc, ve, e.type));
            this.result = this.pue.exp();
            return;
        }

        error(e.loc, ds("cannot convert `&%s` to `%s` at compile time"), e.var_.type!.toChars(), e.type!.toChars());
        this.result = CTFEExp.cantexp!;
    }

    /// dmd/dinterpret.d:1976.
    override visitAddrExp(e: AddrExp): void {
        const ve = e.e1!.isVarExp();
        if (ve !== null) {
            const decl: Declaration = ve.var_;

            // We cannot take the address of an imported symbol at compile time
            if (decl.isImportedSymbol()) {
                error(e.loc, ds("cannot take address of imported symbol `%s` at compile time"), decl.toChars());
                this.result = CTFEExp.cantexp!;
                return;
            }

            if (decl.isDataseg()) {
                // Normally this is already done by optimize()
                // Do it here in case optimize(WANTvalue) wasn't run before CTFE
                this.pue.emplace(new SymOffExp(e.loc, e.e1!.isVarExp()!.var_, 0n));
                this.result = this.pue.exp();
                this.result.type = e.type;
                return;
            }
        }
        let er = interpretNoPue(e.e1, this.istate, CTFEGoal.LValue);
        const ve2 = er!.isVarExp();
        if (ve2 !== null)
            if (this.istate !== null && ve2.var_ === this.istate.fd!.vthis)
                er = interpretNoPue(er, this.istate);

        if (this.exceptionOrCant(er))
            return;

        // Return a simplified address expression
        this.pue.emplace(new AddrExp(e.loc, er, e.type));
        this.result = this.pue.exp();
    }

    /// dmd/dinterpret.d:2017.
    override visitDelegateExp(e: DelegateExp): void {
        // TODO: Really we should create a CTFE-only delegate expression
        // of a pointer and a funcptr.

        // If it is &nestedfunc, just return it
        // TODO: We should save the context pointer
        const ve1 = e.e1!.isVarExp();
        if (ve1 !== null)
            if (ve1.var_ === e.func) {
                this.result = e;
                return;
            }

        let er = interpret(this.pue, e.e1, this.istate);
        if (this.exceptionOrCant(er))
            return;
        if (er === e.e1) {
            // If it has already been CTFE'd, just return it
            this.result = e;
        } else {
            er = (er === this.pue.exp()) ? this.pue.copy() : er;
            this.pue.emplace(new DelegateExp(e.loc, er, e.func, false));
            this.result = this.pue.exp();
            this.result.type = e.type;
        }
    }

    /// dmd/dinterpret.d:2052 — `static Expression getVarExp(Loc loc, InterState* istate, Declaration d`.
    static getVarExp(loc: Loc, istate: InterState | null, d: Declaration, goal: CTFEGoal): Expression | null {
        let e: Expression | null = CTFEExp.cantexp!;
        const v = d.isVarDeclaration();
        if (v !== null) {
            /* Magic variable __ctfe always returns true when interpreting
             */
            if (v.ident === Id.ctfe)
                return IntegerExp.createBool(true);

            if (v.originalType === null && v.semanticRun < PASS.semanticdone) { // semantic() not yet run
                dsymbolSemantic(v, null);
                if (v.type!.ty === TY.Terror)
                    return CTFEExp.cantexp!;
            }

            if ((v.isConst() || v.isImmutable() || (v.storage_class & STC.manifest) !== 0n) && !hasValue(v) &&
                v._init !== null && !v.isCTFE()) {
                if (v.inuse !== 0) {
                    error(loc, ds("circular initialization of %s `%s`"), v.kind(), v.toPrettyChars());
                    return CTFEExp.cantexp!;
                }
                if (v._scope !== null) {
                    v.inuse++;
                    // The `finally` releases the pair on the exit paths walls add (11 §2.5); D's release is
                    // the plain `v.inuse--;` at D:2080.
                    try {
                        // `ref Type tx` (initsem.d) is bound to the field `v.type`: one-slot box, written back
                        // after the call (03 §3.2).
                        const tx = { value: v.type! };
                        // might not be run on aggregate members
                        v._init = initializerSemantic(v._init, v._scope, tx, NeedInterpret.INITinterpret);
                        v.type = tx.value;
                    } finally {
                        v.inuse--;
                    }
                }
                e = initializerToExpression(v._init, v.type);
                if (e === null)
                    return CTFEExp.cantexp!;
                assert(e.type);

                // There's a terrible hack in `dmd.dsymbolsem` that special case
                // a struct with all zeros to an `ExpInitializer(BlitExp(IntegerExp(0)))`
                // There's matching code for it in e2ir (toElem's visitAssignExp),
                // so we need the same hack here.
                // This does not trigger for global as they get a normal initializer.
                const ts = e.type.isTypeStruct();
                if (ts !== null) {
                    const ae = e.isBlitExp();
                    if (ae !== null)
                        if (ae.e2!.op === EXP.int64)
                            e = defaultInitLiteral(ts, loc);
                }

                if (e!.op === EXP.construct || e!.op === EXP.blit) {
                    // D `cast(AssignExp)e` — tag-proved: construct/blit are AssignExp subclasses (02 §11.5c #3).
                    const ae = e as unknown as AssignExp;
                    e = ae.e2;
                }

                if (e!.op === EXP.error) {
                    // FIXME: Ultimately all errors should be detected in prior semantic analysis stage.
                } else if (v.isDataseg() || (v.storage_class & STC.manifest) !== 0n) {
                    /* https://issues.dlang.org/show_bug.cgi?id=14304
                     * e is a value that is not yet owned by CTFE.
                     * Mark as "cached", and use it directly during interpretation.
                     */
                    e = scrubCacheValue(e);
                    ctfeGlobals.stack.saveGlobalConstant(v, e);
                } else {
                    v.inuse++;
                    // The `finally` releases the pair on the exit paths walls add (11 §2.5); D's release is
                    // the plain `v.inuse--;` at D:2120.
                    try {
                        e = interpretNoPue(e, istate);
                    } finally {
                        v.inuse--;
                    }
                    if (CTFEExp.isCantExp(e) && global.gag === 0 && ctfeGlobals.stackTraceCallsToSuppress === 0)
                        errorSupplemental(loc, ds("while evaluating %s.init"), v.toChars());
                    if (exceptionOrCantInterpret(e))
                        return e;
                }
            } else if (v.isCTFE() && !hasValue(v)) {
                if (v._init !== null && size(v.type!) !== 0n) {
                    if (v._init.isVoidInitializer() !== null) {
                        // var should have been initialized when it was created
                        error(loc, ds("CTFE internal error: trying to access uninitialized var"));
                        assertUnreachable();
                    }
                    e = initializerToExpression(v._init);
                } else
                    // Zero-length arrays don't have an initializer
                    e = defaultInitLiteral(v.type!, e.loc); // D reads `e.loc` of the CTFEExp.cantexp sentinel

                e = interpretNoPue(e, istate);
            } else if (!(v.isDataseg() || (v.storage_class & STC.manifest) !== 0n) && !v.isCTFE() && istate === null) {
                error(loc, ds("variable `%s` cannot be read at compile time"), v.toChars());
                return CTFEExp.cantexp!;
            } else {
                e = hasValue(v) ? getValue(v) : null;
                if (e === null) {
                    // Zero-length arrays don't have an initializer
                    if (size(v.type!) === 0n)
                        e = defaultInitLiteral(v.type!, loc);
                    else if (!v.isCTFE() && v.isDataseg()) {
                        error(loc, ds("static variable `%s` cannot be read at compile time"), v.toChars());
                        return CTFEExp.cantexp!;
                    } else {
                        assert(!(v._init !== null && v._init.isVoidInitializer() !== null));
                        // CTFE initiated from inside a function
                        error(loc, ds("variable `%s` cannot be read at compile time"), v.toChars());
                        return CTFEExp.cantexp!;
                    }
                }
                const vie = e!.isVoidInitExp();
                if (vie !== null) {
                    error(loc, ds("cannot read uninitialized variable `%s` in ctfe"), v.toPrettyChars());
                    errorSupplemental(vie.var_.loc, ds("`%s` was uninitialized and used before set"),
                        vie.var_.toChars());
                    return CTFEExp.cantexp!;
                }
                if (goal !== CTFEGoal.LValue && v.isReference())
                    e = interpretNoPue(e, istate, goal);
            }
            if (e === null)
                e = CTFEExp.cantexp!;
        } else {
            const s = d.isSymbolDeclaration();
            if (s !== null) {
                // exclude void[]-typed `__traits(initSymbol)`
                const ta = toBasetype(s.type!).isTypeDArray();
                if (ta !== null) {
                    assert(ta.next!.ty === TY.Tvoid);
                    error(loc, ds("cannot determine the address of the initializer symbol during CTFE"));
                    return CTFEExp.cantexp!;
                }

                // Struct static initializers, for example
                e = defaultInitLiteral(s.dsymAgg.type!, loc); // D `s.dsym` — the shadow-split `dsymAgg` (02 §11.5b)
                if (e!.op === EXP.error)
                    error(loc, ds("CTFE failed because of previous errors in `%s.init`"), s.toChars());
                e = expressionSemantic(e!, null);
                if (e.op === EXP.error)
                    e = CTFEExp.cantexp!;
                else // Convert NULL to CTFEExp
                    e = interpretNoPue(e, istate, goal);
            } else
                error(loc, ds("cannot interpret declaration `%s` at compile time"), d.toChars());
        }
        return e;
    }

    /// dmd/dinterpret.d:2208.
    override visitVarExp(e: VarExp): void {
        if (e.var_.isFuncDeclaration() !== null) {
            this.result = e;
            return;
        }

        if (this.goal === CTFEGoal.LValue) {
            const v = e.var_.isVarDeclaration();
            if (v !== null) {
                if (!hasValue(v)) {
                    // Compile-time known non-CTFE variable from an outer context
                    // e.g. global or from a ref argument
                    if (v.isConst() || v.isImmutable()) {
                        this.result = Interpreter.getVarExp(e.loc, this.istate, v, this.goal);
                        return;
                    }

                    if (!v.isCTFE() && v.isDataseg())
                        error(e.loc, ds("static variable `%s` cannot be read at compile time"), v.toChars());
                    else // CTFE initiated from inside a function
                        error(e.loc, ds("variable `%s` cannot be read at compile time"), v.toChars());
                    this.result = CTFEExp.cantexp!;
                    return;
                }

                if ((v.storage_class & (STC.out_ | STC.ref_)) !== 0n) {
                    // Strip off the nest of ref variables
                    const ev = getValue(v)!;
                    if (ev.op === EXP.variable ||
                        ev.op === EXP.index ||
                        (ev.op === EXP.slice && toBasetype(ev.type!).ty === TY.Tsarray) ||
                        ev.op === EXP.dotVariable) {
                        this.result = interpret(this.pue, ev, this.istate, this.goal);
                        return;
                    }
                }
            }
            this.result = e;
            return;
        }
        this.result = Interpreter.getVarExp(e.loc, this.istate, e.var_, this.goal);
        if (this.exceptionOrCant(this.result))
            return;

        // Visit the default initializer for noreturn variables
        // (Custom initializers would abort the current function call and exit above)
        if (this.result!.type!.ty === TY.Tnoreturn) {
            this.result!.accept(this);
            return;
        }

        if ((e.var_.storage_class & (STC.ref_ | STC.out_)) === 0n && baseElemOf(e.type!).ty !== TY.Tstruct) {
            /* Ultimately, STC.ref_|STC.out_ check should be enough to see the
             * necessity of type repainting. But currently front-end paints
             * non-ref struct variables by the const type.
             *
             *  auto foo(ref const S cs);
             *  S s;
             *  foo(s); // VarExp('s') will have const(S)
             */
            // A VarExp may include an implicit cast. It must be done explicitly.
            this.result = paintTypeOntoLiteral(this.pue, e.type!, this.result!);
        }
    }

    /// dmd/dinterpret.d:2286.
    override visitDeclarationExp(e: DeclarationExp): void {
        let s: Dsymbol = e.declaration!;
        while (s.isAttribDeclaration() !== null) {
            // D `cast(AttribDeclaration)s` — the accessor the loop condition just tested (02 §11.5c #3).
            const ad = s.isAttribDeclaration()!;
            assert(ad.decl !== null && ad.decl.length === 1); // Currently, only one allowed when parsing
            s = ad.decl.opIndex(0)!;
        }
        const v = s.isVarDeclaration();
        if (v !== null) {
            const td = toAlias(v).isTupleDeclaration();
            if (td !== null) {
                this.result = null;

                // Reserve stack space for all tuple members
                // D binds the `int delegate(Dsymbol)` overload of foreachVar (declaration.ts naming, 04 §1B).
                td.foreachVarFromIntDelegate((s) => {
                    const v2 = s.isVarDeclaration();
                    assert(v2);
                    if (v2.isDataseg() && !v2.isCTFE())
                        return 0;

                    ctfeGlobals.stack.push(v2);
                    if (v2._init !== null) {
                        let einit: Expression | null;
                        const ie = v2._init.isExpInitializer();
                        if (ie !== null) {
                            einit = interpretRegion(ie.exp, this.istate, this.goal);
                            if (this.exceptionOrCant(einit))
                                return 1;
                        } else if (v2._init.isVoidInitializer() !== null) {
                            einit = voidInitLiteral(v2.type!, v2).copy();
                        } else {
                            error(e.loc, ds("declaration `%s` is not yet implemented in CTFE"), e.toChars());
                            this.result = CTFEExp.cantexp!;
                            return 1;
                        }
                        setValue(v2, einit!); // `!`: D dereferences newval in setValue's assert (dinterpret.d:7559)
                    }
                    return 0;
                });
                return;
            }
            if (v.isStatic()) {
                // Just ignore static variables which aren't read or written yet
                this.result = null;
                return;
            }
            if (!(v.isDataseg() || (v.storage_class & STC.manifest) !== 0n) || v.isCTFE())
                ctfeGlobals.stack.push(v);
            if (v._init !== null) {
                const ie = v._init.isExpInitializer();
                if (ie !== null) {
                    this.result = interpretRegion(ie.exp, this.istate, this.goal);
                    if (this.result !== null && v.ctfeAdrOnStack !== VarDeclaration.AdrOnStackNone)
                        if (getValue(v) === null)
                            setValueWithoutChecking(v, this.result); // a temporary from extractSideEffects can be a ref
                    return;
                } else if (v._init.isVoidInitializer() !== null) {
                    this.result = voidInitLiteral(v.type!, v).copy();
                    // There is no AssignExp for void initializers,
                    // so set it here.
                    setValue(v, this.result);
                    return;
                } else if (v._init.isArrayInitializer() !== null) {
                    this.result = initializerToExpression(v._init, v.type);
                    if (this.result !== null) {
                        if (v.ctfeAdrOnStack !== VarDeclaration.AdrOnStackNone)
                            if (getValue(v) === null) // a temporary from extractSideEffects can be a ref
                                setValueWithoutChecking(v, this.result);
                        return;
                    }
                }
                error(e.loc, ds("declaration `%s` is not yet implemented in CTFE"), e.toChars());
                this.result = CTFEExp.cantexp!;
            } else if (size(v.type!) === 0n) {
                // Zero-length arrays don't need an initializer
                this.result = defaultInitLiteral(v.type!, e.loc);
            } else {
                error(e.loc, ds("variable `%s` cannot be modified at compile time"), v.toChars());
                this.result = CTFEExp.cantexp!;
            }
            return;
        }
        if (s.isTemplateMixin() !== null || s.isTupleDeclaration() !== null) {
            // These can be made to work, too lazy now
            error(e.loc, ds("declaration `%s` is not yet implemented in CTFE"), e.toChars());
            this.result = CTFEExp.cantexp!;
            return;
        }

        // Others should not contain executable code, so are trivial to evaluate
        this.result = null;
    }

    /// dmd/dinterpret.d:2407.
    override visitTypeidExp(e: TypeidExp): void {
        if (isType(e.obj) !== null) { // D `if (Type t = isType(e.obj))` — `t` is never read
            this.result = e;
            return;
        }
        const ex = isExpression(e.obj);
        if (ex !== null) {
            this.result = interpret(this.pue, ex, this.istate);
            if (this.exceptionOrCant(ex)) // D tests `ex`, not `result`
                return;

            if (this.result!.op === EXP.null_) {
                error(e.loc, ds("null pointer dereference evaluating typeid. `%s` is `null`"), ex.toChars());
                this.result = CTFEExp.cantexp!;
                return;
            }
            if (this.result!.op !== EXP.classReference) {
                error(e.loc, ds("CTFE internal error: determining classinfo"));
                this.result = CTFEExp.cantexp!;
                return;
            }

            const cd = this.result!.isClassReferenceExp()!.originalClass();
            assert(cd);

            this.pue.emplace(new TypeidExp(e.loc, cd.type));
            this.result = this.pue.exp();
            this.result.type = e.type;
            return;
        }
        this.visitExpression(e);
    }

    /// dmd/dinterpret.d:2448.
    override visitTupleExp(e: TupleExp): void {
        if (this.exceptionOrCant(interpretRegion(e.e0, this.istate, CTFEGoal.Nothing)))
            return;

        let expsx = e.exps;
        // `foreach (i, exp; *expsx)` iterates the slice taken once, before the copy-on-write rebinding.
        for (const [i, exp] of expsx!.opSlice().entries()) {
            const ex = interpretRegion(exp, this.istate);
            if (this.exceptionOrCant(ex))
                return;

            // A tuple of assignments can contain void (Bug 5676).
            if (this.goal === CTFEGoal.Nothing)
                continue;
            if (ex!.op === EXP.voidExpression) {
                error(e.loc, ds("CTFE internal error: void element `%s` in sequence"), exp!.toChars());
                assertUnreachable();
            }

            /* If any changes, do Copy On Write
             */
            if (ex !== exp) {
                expsx = copyArrayOnWrite(expsx, e.exps);
                expsx.opIndexAssign(copyRegionExp(ex), i);
            }
        }

        if (expsx !== e.exps) {
            expandTuples(expsx);
            this.pue.emplace(TupleExp.fromExps(e.loc, expsx));
            this.result = this.pue.exp();
            this.result.type = TypeTuple.fromExpressions(expsx);
        } else
            this.result = e;
    }

    /// dmd/dinterpret.d:2493.
    override visitArrayLiteralExp(e: ArrayLiteralExp): void {
        if (e.ownedByCtfe >= OwnedBy.ctfe) { // We've already interpreted all the elements
            this.result = e;
            return;
        }

        const tb = toBasetype(e.type!);
        const tn = toBasetype(nextOf(tb)!);
        const wantCopy = (tn.ty === TY.Tsarray || tn.ty === TY.Tstruct);

        const basis = interpretRegion(e.basis, this.istate);
        if (this.exceptionOrCant(basis))
            return;

        let expsx = e.elements;
        const dim = expsx !== null ? expsx.length : 0;

        for (let i = 0; i < dim; i++) {
            const exp = expsx!.opIndex(i);
            let ex: Expression | null;
            if (exp === null) {
                ex = copyLiteral(basis!).copy();
            } else {
                // segfault bug 6250
                assert(exp.op !== EXP.index || exp.isIndexExp()!.e1 !== e);

                ex = interpretRegion(exp, this.istate);
                if (this.exceptionOrCant(ex))
                    return;

                /* Each elements should have distinct CTFE memory.
                 *  int[1] z = 7;
                 *  int[1][] pieces = [z,z];    // here
                 */
                if (wantCopy)
                    ex = copyLiteral(ex!).copy();
            }

            /* If any changes, do Copy On Write
             */
            if (ex !== exp) {
                expsx = copyArrayOnWrite(expsx, e.elements);
                expsx.opIndexAssign(ex, i);
            }
        }

        // Only create new ArrayLiteralExp if needed (don't forget to check basis as well!)
        // https://github.com/dlang/dmd/issues/21039
        if (expsx !== e.elements || basis !== e.basis) {
            // todo: all tuple expansions should go in semantic phase.
            expandTuples(expsx);
            if (expsx!.length !== dim) {
                error(e.loc, ds("CTFE internal error: invalid array literal"));
                this.result = CTFEExp.cantexp!;
                return;
            }
            this.pue.emplace(ArrayLiteralExp.fromBasis(e.loc, e.type, basis, expsx));
            const ale = this.pue.exp().isArrayLiteralExp()!;
            ale.ownedByCtfe = OwnedBy.ctfe;
            this.result = ale;
        }
        // D: `(cast(TypeNext)e.type).next` — `nextOf()` IS that `.next` for every TypeNext (typesem.d:256);
        // the one non-TypeNext it also answers, TypeEnum, is a type on which D's cast yields null and faults.
        else if ((nextOf(e.type!)!.mod & (MODFlags.const_ | MODFlags.immutable_)) !== 0) {
            // If it's immutable, we don't need to dup it
            this.result = e;
        } else {
            this.pue.emplace(copyLiteral(e).exp());
            this.result = this.pue.exp();
        }
    }

    /// dmd/dinterpret.d:2579.
    override visitAssocArrayLiteralExp(e: AssocArrayLiteralExp): void {
        if (e.ownedByCtfe >= OwnedBy.ctfe) { // We've already interpreted all the elements
            this.result = e;
            return;
        }

        let keysx = e.keys;
        let valuesx = e.values;
        // `foreach (i, ekey; *keysx)` iterates the slice taken once, before the copy-on-write rebinding.
        for (const [i, ekey] of keysx!.opSlice().entries()) {
            const evalue = valuesx!.opIndex(i);

            const ek = interpretRegion(ekey, this.istate);
            if (this.exceptionOrCant(ek))
                return;
            const ev = interpretRegion(evalue, this.istate);
            if (this.exceptionOrCant(ev))
                return;

            /* If any changes, do Copy On Write
             */
            if (ek !== ekey ||
                ev !== evalue) {
                keysx = copyArrayOnWrite(keysx, e.keys);
                valuesx = copyArrayOnWrite(valuesx, e.values);
                keysx.opIndexAssign(ek, i);
                valuesx.opIndexAssign(ev, i);
            }
        }
        if (keysx !== e.keys)
            expandTuples(keysx);
        if (valuesx !== e.values)
            expandTuples(valuesx);
        if (keysx!.length !== valuesx!.length) {
            error(e.loc, ds("CTFE internal error: invalid AA"));
            this.result = CTFEExp.cantexp!;
            return;
        }

        /* Remove duplicate keys
         */
        for (let i = 1; i < keysx!.length; i++) {
            const ekey = keysx!.opIndex(i - 1);
            for (let j = i; j < keysx!.length; j++) {
                const ekey2 = keysx!.opIndex(j);
                if (!ctfeEqual(e.loc, EXP.equal, ekey!, ekey2!))
                    continue;

                // Remove ekey
                keysx = copyArrayOnWrite(keysx, e.keys);
                valuesx = copyArrayOnWrite(valuesx, e.values);
                keysx.remove(i - 1);
                valuesx.remove(i - 1);

                i -= 1; // redo the i'th iteration
                break;
            }
        }

        if (keysx !== e.keys ||
            valuesx !== e.values) {
            assert(keysx !== e.keys &&
                   valuesx !== e.values);
            const aae = ctfeEmplaceExp(() => new AssocArrayLiteralExp(e.loc, keysx, valuesx));
            aae.type = e.type;
            aae.lowering = e.lowering;
            aae.loweringCtfe = e.loweringCtfe;
            aae.ownedByCtfe = OwnedBy.ctfe;
            this.result = aae;
        } else {
            this.pue.emplace(copyLiteral(e).exp());
            this.result = this.pue.exp();
        }
    }

    /// dmd/dinterpret.d:2667.
    override visitStructLiteralExp(e: StructLiteralExp): void {
        if (e.ownedByCtfe >= OwnedBy.ctfe) {
            this.result = e;
            return;
        }

        let dim = e.elements !== null ? e.elements.length : 0;
        let expsx = e.elements;

        if (dim !== e.sd!.fields.length) {
            // guaranteed by AggregateDeclaration.fill and TypeStruct.defaultInitLiteral
            const nvthis = e.sd!.fields.length - e.sd!.nonHiddenFields();
            assert(e.sd!.fields.length - dim === nvthis);

            /* If a nested struct has no initialized hidden pointer,
             * set it to null to match the runtime behaviour.
             */
            for (let i = 0; i < nvthis; i++) {
                const ne = ctfeEmplaceExp(() => new NullExp(e.loc));
                const vthis = i === 0 ? e.sd!.vthis : e.sd!.vthis2;
                ne.type = vthis!.type;

                expsx = copyArrayOnWrite(expsx, e.elements);
                expsx.push(ne);
                ++dim;
            }
        }
        assert(dim === e.sd!.fields.length);

        for (let i = 0; i < dim; i++) {
            const v = e.sd!.fields.opIndex(i)!;
            const exp = expsx!.opIndex(i);
            let ex: Expression | null;
            if (exp === null) {
                ex = voidInitLiteral(v.type!, v).copy();
            } else {
                ex = interpretRegion(exp, this.istate);
                if (this.exceptionOrCant(ex))
                    return;
                if ((v.type!.ty !== ex!.type!.ty) && v.type!.ty === TY.Tsarray) {
                    // Block assignment from inside struct literals
                    // D `cast(TypeSArray)v.type` — tag-proved by `v.type.ty == Tsarray` (02 §11.5c #3).
                    const tsa = v.type!.isTypeSArray()!;
                    const len = Number(toInteger(tsa.dim!)); // `cast(size_t)`: a length (09 §1.1)
                    const ue = new UnionExp();
                    ex = createBlockDuplicatedArrayLiteral(ue, ex!.loc, v.type!, ex!, len);
                    if (ex === ue.exp())
                        ex = ue.copy();
                }
            }

            /* If any changes, do Copy On Write
             */
            if (ex !== exp) {
                expsx = copyArrayOnWrite(expsx, e.elements);
                expsx.opIndexAssign(ex, i);
            }
        }

        if (expsx !== e.elements) {
            expandTuples(expsx);
            if (expsx!.length !== e.sd!.fields.length) {
                error(e.loc, ds("CTFE internal error: invalid struct literal"));
                this.result = CTFEExp.cantexp!;
                return;
            }
            this.pue.emplace(new StructLiteralExp(e.loc, e.sd, expsx));
            const sle = this.pue.exp().isStructLiteralExp()!;
            sle.type = e.type;
            sle.ownedByCtfe = OwnedBy.ctfe;
            sle.origin = e.origin;
            this.result = sle;
        } else {
            this.pue.emplace(copyLiteral(e).exp());
            this.result = this.pue.exp();
        }
    }

    /**
     * dmd/dinterpret.d:2764 — `static Expression recursivelyCreateArrayLiteral(UnionExp* pue, Loc loc`.
     */
    // Create an array literal of type 'newtype' with dimensions given by
    // 'arguments'[argnum..$]
    static recursivelyCreateArrayLiteral(pue: UnionExp, loc: Loc, newtype: Type, istate: InterState | null,
                                         arguments_: Expressions, argnum: number): Expression | null {
        const lenExpr = interpret(pue, arguments_.opIndex(argnum), istate);
        if (exceptionOrCantInterpret(lenExpr))
            return lenExpr;
        const len = Number(toInteger(lenExpr!)); // `cast(size_t)`: a length (09 §1.1)
        // D: `(cast(TypeArray)newtype).next` — both D callers pass a `Tarray` type (D:2773 after its
        // `elemType.ty == Tarray` test, D:2819 after `e.newtype.ty == Tarray`), a TypeArray (02 §11.5c #3).
        const elemType: Type = (newtype.isTypeSArray() ?? newtype.isTypeDArray())!.next!;
        if (elemType.ty === TY.Tarray && argnum < arguments_.length - 1) {
            const elem = Interpreter.recursivelyCreateArrayLiteral(pue, loc, elemType, istate, arguments_, argnum + 1);
            if (exceptionOrCantInterpret(elem))
                return elem;

            const elements: Expressions = new DArray<Expression | null>(len);
            for (let i = 0; i < elements.length; i++) // `foreach (ref element; *elements)`
                elements.opIndexAssign(copyLiteral(elem!).copy(), i);
            pue.emplace(new ArrayLiteralExp(loc, newtype, elements));
            const ae = pue.exp().isArrayLiteralExp()!;
            ae.ownedByCtfe = OwnedBy.ctfe;
            return ae;
        }
        assert(argnum === arguments_.length - 1);
        if (isSomeChar(elemType.ty)) {
            // `cast(dchar)` of the carrier: its low 32 bits (09 §2.1), exact as a `number`.
            const ch = Number(maskUnsignedN(32, toInteger(defaultInitLiteral(elemType, loc)!)));
            const sz = Number(maskUnsignedN(8, size(elemType))); // `cast(ubyte)elemType.size()`
            return createBlockDuplicatedStringLiteral(pue, loc, newtype, ch, len, sz);
        } else {
            const el = interpretNoPue(defaultInitLiteral(elemType, loc), istate);
            return createBlockDuplicatedArrayLiteral(pue, loc, newtype, el!, len);
        }
    }

    /// dmd/dinterpret.d:2799.
    override visitNewExp(e: NewExp): void {
        if (e.placement !== null) {
            error(e.placement.loc, ds("`new ( %s )` PlacementExpression cannot be evaluated at compile time"),
                e.placement.toChars());
            this.result = CTFEExp.cantexp!;
            return;
        }

        const epre = interpret(this.pue, e.argprefix, this.istate, CTFEGoal.Nothing);
        if (this.exceptionOrCant(epre))
            return;

        if (e.newtype!.ty === TY.Tarray && e.arguments_ !== null) {
            this.result = Interpreter.recursivelyCreateArrayLiteral(this.pue, e.loc, e.newtype!, this.istate,
                e.arguments_, 0);
            return;
        }
        const ts = toBasetype(e.newtype!).isTypeStruct();
        if (ts !== null) {
            if (e.member !== null) {
                let se: Expression | null = defaultInitLiteral(e.newtype!, e.loc);
                se = interpretNoPue(se, this.istate);
                if (this.exceptionOrCant(se))
                    return;
                this.result = interpretFunction(this.pue, e.member, this.istate, e.arguments_, se);

                // Repaint as same as CallExp::interpret() does.
                this.result!.loc = e.loc;
            } else {
                const sd: StructDeclaration = ts.sym!;
                const exps: Expressions = new DArray<Expression | null>();
                exps.reserve(sd.fields.length);
                if (e.arguments_ !== null) {
                    exps.setDim(e.arguments_.length);
                    for (let [i, ex] of e.arguments_.opSlice().entries()) {
                        ex = interpretRegion(ex, this.istate);
                        if (this.exceptionOrCant(ex))
                            return;
                        exps.opIndexAssign(ex, i);
                    }
                }
                fill(sd, e.loc, exps, false);

                const se = ctfeEmplaceExp(() => new StructLiteralExp(e.loc, sd, exps, e.newtype));
                se.origin = se;
                se.type = e.newtype;
                se.ownedByCtfe = OwnedBy.ctfe;
                this.result = interpret(this.pue, se, this.istate);
            }
            if (this.exceptionOrCant(this.result))
                return;
            const ev = (this.result === this.pue.exp()) ? this.pue.copy() : this.result;
            this.pue.emplace(new AddrExp(e.loc, ev, e.type));
            this.result = this.pue.exp();
            return;
        }
        const tc = toBasetype(e.newtype!).isTypeClass();
        if (tc !== null) {
            const cd: ClassDeclaration = tc.sym!;
            let totalFieldCount = 0;
            for (let c: ClassDeclaration | null = cd; c !== null; c = c.baseClass)
                totalFieldCount += c.fields.length;
            const elems: Expressions = new DArray<Expression | null>(totalFieldCount);
            let fieldsSoFar = totalFieldCount;
            for (let c: ClassDeclaration | null = cd; c !== null; c = c.baseClass) {
                fieldsSoFar -= c.fields.length;
                for (const [i, v] of c.fields.opSlice().entries()) {
                    if (v!.inuse !== 0) {
                        error(e.loc, ds("circular reference to `%s`"), v!.toPrettyChars());
                        this.result = CTFEExp.cantexp!;
                        return;
                    }
                    let m: Expression | null;
                    if (v!._init !== null) {
                        if (v!._init.isVoidInitializer() !== null)
                            m = voidInitLiteral(v!.type!, v!).copy();
                        else
                            m = getConstInitializer(v!, true);
                    } else if (v!.type!.isTypeNoreturn() !== null) {
                        // Noreturn field with default initializer
                        elems.opIndexAssign(null, fieldsSoFar + i);
                        continue;
                    } else
                        m = defaultInitLiteral(v!.type!, e.loc);
                    if (this.exceptionOrCant(m))
                        return;
                    elems.opIndexAssign(copyLiteral(m!).copy(), fieldsSoFar + i);
                }
            }
            // Hack: we store a ClassDeclaration instead of a StructDeclaration.
            // We probably won't get away with this.
//            auto se = new StructLiteralExp(e.loc, cast(StructDeclaration)cd, elems, e.newtype);
            // D `cast(StructDeclaration)cd` between extern(C++) classes is an unchecked static reinterpretation
            // (no D RTTI), so `se.sd` holds the ClassDeclaration itself — which ClassReferenceExp's constructor
            // asserts (`lit.sd.isClassDeclaration()`). The `as unknown as` reproduces that reinterpretation.
            const se = ctfeEmplaceExp(() =>
                new StructLiteralExp(e.loc, cd as unknown as StructDeclaration, elems, e.newtype));
            se.origin = se;
            se.ownedByCtfe = OwnedBy.ctfe;
            const eref: Expression = ctfeEmplaceExp(() => new ClassReferenceExp(e.loc, se, e.type));
            if (e.member !== null) {
                // Call constructor
                if (e.member.fbody === null) {
                    const ctorfail = evaluateIfBuiltin(this.pue, this.istate, e.loc, e.member, e.arguments_, eref);
                    if (ctorfail !== null) {
                        if (this.exceptionOrCant(ctorfail))
                            return;
                        this.result = eref;
                        return;
                    }
                    const m = e.member;
                    error(m.loc, ds("%s `%s` `%s` cannot be constructed at compile time, " +
                        "because the constructor has no available source code"),
                        m.kind(), m.toPrettyChars(), e.newtype!.toChars());
                    this.result = CTFEExp.cantexp!;
                    return;
                }
                const ue = new UnionExp();
                const ctorfail = interpretFunction(ue, e.member, this.istate, e.arguments_, eref);
                if (this.exceptionOrCant(ctorfail))
                    return;

                /* https://issues.dlang.org/show_bug.cgi?id=14465
                 * Repaint the loc, because a super() call
                 * in the constructor modifies the loc of ClassReferenceExp
                 * in CallExp::interpret().
                 */
                eref.loc = e.loc;
            }
            this.result = eref;
            return;
        }
        if (isScalar(toBasetype(e.newtype!))) {
            let newval: Expression | null;
            if (e.arguments_ !== null && e.arguments_.length !== 0)
                newval = e.arguments_.opIndex(0);
            else
                newval = defaultInitLiteral(e.newtype!, e.loc);
            newval = interpretRegion(newval, this.istate);
            if (this.exceptionOrCant(newval))
                return;

            // Create a CTFE pointer &[newval][0]
            const elements: Expressions = new DArray<Expression | null>(1);
            elements.opIndexAssign(newval, 0);
            const ae = ctfeEmplaceExp(() => new ArrayLiteralExp(e.loc, arrayOf(e.newtype!), elements));
            ae.ownedByCtfe = OwnedBy.ctfe;

            const ei = ctfeEmplaceExp(() =>
                new IndexExp(e.loc, ae, ctfeEmplaceExp(() => new IntegerExp(Loc.initial, 0n, Type.tsize_t))));
            ei.type = e.newtype;
            this.pue.emplace(new AddrExp(e.loc, ei, e.type));
            this.result = this.pue.exp();
            return;
        }
        error(e.loc, ds("cannot interpret `%s` at compile time"), e.toChars());
        this.result = CTFEExp.cantexp!;
    }

    /// dmd/dinterpret.d:2974.
    override visitUnaExp(e: UnaExp): void {
        const ue = new UnionExp();
        const e1 = interpret(ue, e.e1, this.istate);
        if (this.exceptionOrCant(e1))
            return;
        switch (e.op) {
            case EXP.negate:
                this.pue.emplace(Neg(e.type!, e1!).exp());
                break;

            case EXP.tilde:
                this.pue.emplace(Com(e.type!, e1!).exp());
                break;

            case EXP.not:
                this.pue.emplace(Not(e.type!, e1!).exp());
                break;

            default:
                assertUnreachable();
        }
        this.result = this.pue.exp();
    }

    /// dmd/dinterpret.d:3004.
    override visitDotTypeExp(e: DotTypeExp): void {
        const ue = new UnionExp();
        const e1 = interpret(ue, e.e1, this.istate);
        if (this.exceptionOrCant(e1))
            return;
        if (e1 === e.e1)
            this.result = e; // optimize: reuse this CTFE reference
        else {
            const edt = e.copy().isDotTypeExp()!;
            edt.e1 = (e1 === ue.exp()) ? e1!.copy() : e1; // don't return pointer to ue
            this.result = edt;
        }
    }

    // dmd/dinterpret.d:3024-3025 — `fp_t` / `fp2_t` are emitted at module level above the class.

    /// dmd/dinterpret.d:3027 — `extern (D) private void interpretCommon(BinExp e, fp_t fp)`.
    private interpretCommon(e: BinExp, fp: fp_t): void {
        if (e.e1!.type!.ty === TY.Tpointer && e.e2!.type!.ty === TY.Tpointer && e.op === EXP.min) {
            const ue1 = new UnionExp();
            const e1 = interpret(ue1, e.e1, this.istate);
            if (this.exceptionOrCant(e1))
                return;
            const ue2 = new UnionExp();
            const e2 = interpret(ue2, e.e2, this.istate);
            if (this.exceptionOrCant(e2))
                return;
            this.result = pointerDifference(this.pue, e.loc, e.type!, e1!, e2!);
            return;
        }
        if (e.e1!.type!.ty === TY.Tpointer && isIntegral(e.e2!.type!)) {
            const ue1 = new UnionExp();
            const e1 = interpret(ue1, e.e1, this.istate);
            if (this.exceptionOrCant(e1))
                return;
            const ue2 = new UnionExp();
            const e2 = interpret(ue2, e.e2, this.istate);
            if (this.exceptionOrCant(e2))
                return;
            this.result = pointerArithmetic(this.pue, e.loc, e.op, e.type!, e1!, e2!);
            return;
        }
        if (e.e2!.type!.ty === TY.Tpointer && isIntegral(e.e1!.type!) && e.op === EXP.add) {
            const ue1 = new UnionExp();
            const e1 = interpret(ue1, e.e1, this.istate);
            if (this.exceptionOrCant(e1))
                return;
            const ue2 = new UnionExp();
            const e2 = interpret(ue2, e.e2, this.istate);
            if (this.exceptionOrCant(e2))
                return;
            this.result = pointerArithmetic(this.pue, e.loc, e.op, e.type!, e2!, e1!);
            return;
        }
        if (e.e1!.type!.ty === TY.Tpointer || e.e2!.type!.ty === TY.Tpointer) {
            error(e.loc, ds("pointer expression `%s` cannot be interpreted at compile time"), e.toChars());
            this.result = CTFEExp.cantexp!;
            return;
        }

        // dmd/dinterpret.d:3079 — nested `bool evalOperand(UnionExp* pue, Expression ex, out Expression er)`;
        // `out Expression er` is a one-slot box (03 §3.3).
        const evalOperand = (pue: UnionExp, ex: Expression | null, er: Ref<Expression | null>): boolean => {
            er.value = null; // `out` resets on entry (03 §3.3)
            er.value = interpret(pue, ex, this.istate);
            if (this.exceptionOrCant(er.value))
                return false;
            return true;
        };

        const ue1 = new UnionExp();
        const e1: Ref<Expression | null> = { value: null };
        if (!evalOperand(ue1, e.e1, e1))
            return;

        const ue2 = new UnionExp();
        const e2: Ref<Expression | null> = { value: null };
        if (!evalOperand(ue2, e.e2, e2))
            return;

        if (e.op === EXP.rightShift || e.op === EXP.leftShift || e.op === EXP.unsignedRightShift) {
            const i2: sinteger_t = toInt64(toInteger(e2.value!));
            const sz: uinteger_t = toUint64(size(e1.value!.type!) * 8n);
            // D compares `long >= ulong` as ulong; with `i2 >= 0` established by the `||`, both reads agree.
            if (i2 < 0n || i2 >= sz) {
                error(e.loc, ds("shift by %lld is outside the range 0..%llu"), i2, toUint64(sz - 1n));
                this.result = CTFEExp.cantexp!;
                return;
            }
        }

        /******************************************
         * Perform the operation fp on operands e1 and e2.
         */
        // dmd/dinterpret.d:3112 — nested `UnionExp evaluate(Loc loc, Type type, Expression e1, Expression e2)`.
        const evaluate = (loc: Loc, type: Type, e1: Expression, e2: Expression): UnionExp => {
            const ue = new UnionExp();
            let ae1 = e1.isArrayLiteralExp();
            let ae2 = e2.isArrayLiteralExp();
            if (ae1 !== null || ae2 !== null) {
                /* Cases:
                 * 1. T[] op T[]
                 * 2. T op T[]
                 * 3. T[] op T
                 */
                if (ae1 !== null && implicitConvTo(e2, nextOf(toBasetype(e1.type!))!) !== MATCH.nomatch) // case 3
                    ae2 = null;
                else if (ae2 !== null && implicitConvTo(e1, nextOf(toBasetype(e2.type!))!) !== MATCH.nomatch) // case 2
                    ae1 = null;
                // else case 1

                const aex = (ae1 !== null ? ae1 : ae2)!;
                if (aex.elements === null) {
                    ue.emplace(new ArrayLiteralExp(loc, type, null));
                    return ue;
                }
                const length = aex.elements.length;
                const elements: Expressions = new DArray<Expression | null>(length);

                ue.emplace(new ArrayLiteralExp(loc, type, elements));
                for (let i = 0; i < length; i++) {
                    const e1x = ae1 !== null ? ae1.opIndex(i) : e1;
                    const e2x = ae2 !== null ? ae2.opIndex(i) : e2;
                    const uex = evaluate(loc, e1x!.type!, e1x!, e2x!);
                    // This can be made more efficient by making use of ue.basis
                    elements.opIndexAssign(uex.copy(), i);
                }
                return ue;
            }

            if (e1.isConst() !== 1) {
                // The following should really be an assert()
                error(e1.loc, ds("CTFE internal error: non-constant value `%s`"), e1.toChars());
                ue.emplace(new CTFEExp(EXP.cantExpression));
                return ue;
            }
            if (e2.isConst() !== 1) {
                error(e2.loc, ds("CTFE internal error: non-constant value `%s`"), e2.toChars());
                ue.emplace(new CTFEExp(EXP.cantExpression));
                return ue;
            }

            return fp(loc, type, e1, e2);
        };

        this.pue.emplace(evaluate(e.loc, e.type!, e1.value!, e2.value!).exp());
        this.result = this.pue.exp();
        if (CTFEExp.isCantExp(this.result))
            error(e.loc, ds("`%s` cannot be interpreted at compile time"), e.toChars());
    }

    /// dmd/dinterpret.d:3174 — `extern (D) private void interpretCompareCommon(BinExp e, fp2_t fp)`.
    private interpretCompareCommon(e: BinExp, fp: fp2_t): void {
        const ue1 = new UnionExp();
        const ue2 = new UnionExp();
        if (e.e1!.type!.ty === TY.Tpointer && e.e2!.type!.ty === TY.Tpointer) {
            const e1 = interpret(ue1, e.e1, this.istate);
            if (this.exceptionOrCant(e1))
                return;
            const e2 = interpret(ue2, e.e2, this.istate);
            if (this.exceptionOrCant(e2))
                return;
            //printf("e1 = %s %s, e2 = %s %s\n", e1.type.toChars(), e1.toChars(), e2.type.toChars(), e2.toChars());
            const ofs1: Ref<dinteger_t> = { value: 0n };
            const ofs2: Ref<dinteger_t> = { value: 0n };
            const agg1 = getAggregateFromPointer(e1!, ofs1);
            const agg2 = getAggregateFromPointer(e2!, ofs2);
            //printf("agg1 = %p %s, agg2 = %p %s\n", agg1, agg1.toChars(), agg2, agg2.toChars());
            const cmp = comparePointers(e.op, agg1, ofs1.value, agg2, ofs2.value);
            if (cmp === -1) {
                // `char dir`: '<' (0x3c) or '>' (0x3e); `%c` consumes the code unit as a number.
                const dir = (e.op === EXP.greaterThan || e.op === EXP.greaterOrEqual) ? 0x3c : 0x3e;
                error(e.loc, ds("the ordering of pointers to unrelated memory blocks is indeterminate in CTFE."));
                errorSupplemental(e.loc, ds("to check if they point to the same memory block, use both `>` and `<` " +
                    "inside `&&` or `||`, eg `%s && %s %c= %s + 1`"),
                    e.toChars(), e.e1!.toChars(), dir, e.e2!.toChars());
                this.result = CTFEExp.cantexp!;
                return;
            }
            if (e.type!.equals(Type.tbool))
                this.result = IntegerExp.createBool(cmp !== 0);
            else {
                this.pue.emplace(new IntegerExp(e.loc, BigInt(cmp), e.type!));
                this.result = this.pue.exp();
            }
            return;
        }
        const e1 = interpret(ue1, e.e1, this.istate);
        if (this.exceptionOrCant(e1))
            return;
        if (!isCtfeComparable(e1!)) {
            error(e.loc, ds("cannot compare `%s` at compile time"), e1!.toChars());
            this.result = CTFEExp.cantexp!;
            return;
        }
        const e2 = interpret(ue2, e.e2, this.istate);
        if (this.exceptionOrCant(e2))
            return;
        if (!isCtfeComparable(e2!)) {
            error(e.loc, ds("cannot compare `%s` at compile time"), e2!.toChars());
            this.result = CTFEExp.cantexp!;
            return;
        }
        const cmp = fp(e.loc, e.op, e1!, e2!);
        if (e.type!.equals(Type.tbool))
            this.result = IntegerExp.createBool(cmp);
        else {
            this.pue.emplace(new IntegerExp(e.loc, cmp ? 1n : 0n, e.type!)); // `bool` -> dinteger_t
            this.result = this.pue.exp();
        }
    }

    /// dmd/dinterpret.d:3241 — `override void visit(BinExp e)`.
    override visitBinExp(e: BinExp): void {
        switch (e.op) {
            case EXP.add:
                this.interpretCommon(e, Add);
                return;

            case EXP.min:
                this.interpretCommon(e, Min);
                return;

            case EXP.mul:
                this.interpretCommon(e, Mul);
                return;

            case EXP.div:
                this.interpretCommon(e, Div);
                return;

            case EXP.mod:
                this.interpretCommon(e, Mod);
                return;

            case EXP.leftShift:
                this.interpretCommon(e, Shl);
                return;

            case EXP.rightShift:
                this.interpretCommon(e, Shr);
                return;

            case EXP.unsignedRightShift:
                this.interpretCommon(e, Ushr);
                return;

            case EXP.and:
                this.interpretCommon(e, And);
                return;

            case EXP.or:
                this.interpretCommon(e, Or);
                return;

            case EXP.xor:
                this.interpretCommon(e, Xor);
                return;

            case EXP.pow:
                this.interpretCommon(e, Pow);
                return;

            case EXP.equal:
            case EXP.notEqual:
                this.interpretCompareCommon(e, ctfeEqual);
                return;

            case EXP.identity:
            case EXP.notIdentity:
                this.interpretCompareCommon(e, ctfeIdentity);
                return;

            case EXP.lessThan:
            case EXP.lessOrEqual:
            case EXP.greaterThan:
            case EXP.greaterOrEqual:
                this.interpretCompareCommon(e, ctfeCmp);
                return;

            default:
                // dropped: bare printf developer trace before assert(0) (dinterpret.d:3311, 07 §2.1)
                assertUnreachable();
        }
    }

    /* Helper functions for BinExp::interpretAssignCommon
     */
    // Returns the variable which is eventually modified, or NULL if an rvalue.
    // thisval is the current value of 'this'.
    /// dmd/dinterpret.d:3320 — `static VarDeclaration findParentVar(Expression e) @safe`.
    static findParentVar(e: Expression): VarDeclaration | null {
        let cur: Expression = e; // D reassigns the parameter walking the chain (02 §10.1)
        for (;;) {
            const ve = cur.isVarExp();
            if (ve !== null) {
                const v = ve.var_.isVarDeclaration();
                assert(v !== null);
                return v;
            }
            // chained `else if (auto x = e.isXxx())` declarations: each nested into the prior `else` (06 §2.6)
            const ie = cur.isIndexExp();
            if (ie !== null)
                cur = ie.e1!;
            else {
                const dve = cur.isDotVarExp();
                if (dve !== null)
                    cur = dve.e1!;
                else {
                    const dtie = cur.isDotTemplateInstanceExp();
                    if (dtie !== null)
                        cur = dtie.e1!;
                    else {
                        const se = cur.isSliceExp();
                        if (se !== null)
                            cur = se.e1!;
                        else
                            return null;
                    }
                }
            }
        }
    }

    /// dmd/dinterpret.d:3343 — `extern (D) private void interpretAssignCommon(BinExp e, fp_t fp, int post = 0)`.
    /// `fp` is null for a plain assignment (visitAssignExp passes D's `null`).
    private interpretAssignCommon(e: BinExp, fp: fp_t | null, post: number = 0): void {
        // dropped: debug (LOG) trace (dinterpret.d:3345-3348) — debug OFF (_config.md)
        this.result = CTFEExp.cantexp!;

        let e1: Expression | null = e.e1!;
        if (this.istate === null) {
            error(e.loc, ds("value of `%s` is not known at compile time"), e1.toChars());
            return;
        }

        ++ctfeGlobals.numAssignments;

        /* Before we begin, we need to know if this is a reference assignment
         * (dynamic array, AA, or class) or a value assignment.
         * Determining this for slice assignments are tricky: we need to know
         * if it is a block assignment (a[] = e) rather than a direct slice
         * assignment (a[] = b[]). Note that initializers of multi-dimensional
         * static arrays can have 2D block assignments (eg, int[7][7] x = 6;).
         * So we need to recurse to determine if it is a block assignment.
         */
        let isBlockAssignment = false;
        if (e1.op === EXP.slice) {
            // a[] = e can have const e. So we compare the naked types.
            let tdst = toBasetype(e1.type!);
            const tsrc = toBasetype(e.e2!.type!);
            while (tdst.isStaticOrDynamicArray()) {
                // D: `(cast(TypeArray)tdst).next` — tag-proved RTTI downcast (02 §11.5c shape 3): the loop
                // condition `tdst.isStaticOrDynamicArray()` IS the proof, and `TypeArray` (the abstract
                // TypeSArray/TypeDArray base) has no `isTypeXxx()` accessor of its own.
                tdst = toBasetype((tdst as unknown as TypeArray).next!);
                if (equivalent(tsrc, tdst)) {
                    isBlockAssignment = true;
                    break;
                }
            }
        }

        // ---------------------------------------
        //      Deal with reference assignment
        // ---------------------------------------
        // If it is a construction of a ref variable, it is a ref assignment
        // D: `(cast(AssignExp)e).memset` — tag-proved RTTI downcast (02 §11.5c shape 3, superclass form): the
        // adjacent `e.op == EXP.construct || e.op == EXP.blit` proves an AssignExp subclass (ConstructExp/BlitExp).
        if ((e.op === EXP.construct || e.op === EXP.blit) &&
            ((e as unknown as AssignExp).memset === MemorySet.referenceInit)) {
            assert(fp === null);

            const newval = interpretRegion(e.e2, this.istate, CTFEGoal.LValue);
            if (this.exceptionOrCant(newval))
                return;

            const v = e1.isVarExp()!.var_.isVarDeclaration()!;
            setValue(v, newval!); // `!`: D dereferences newval in setValue's assert (dinterpret.d:7559)

            // Get the value to return. Note that 'newval' is an Lvalue,
            // so if we need an Rvalue, we have to interpret again.
            if (this.goal === CTFEGoal.RValue)
                this.result = interpretRegion(newval, this.istate);
            else
                this.result = e1; // VarExp is a CTFE reference
            return;
        }

        if (fp !== null) {
            while (e1.op === EXP.cast_) {
                const ce: CastExp = e1.isCastExp()!;
                e1 = ce.e1!;
            }
        }

        // ---------------------------------------
        //      Interpret left hand side
        // ---------------------------------------
        let oldval: Expression | null = null;
        // SKIP-FLAG (06 §4): the final `else` arm below is the label `L1:` (dinterpret.d:3458), reached by
        // falling into that arm and by two jumps from the construct/blit arm; its body runs after the chain.
        let gotoL1 = false;
        if (e1.op === EXP.index && toBasetype(e1.isIndexExp()!.e1!.type!).ty === TY.Taarray) {
            assertUnreachable("indexing AA should have been lowered in semantic analysis");
        } else if (e1.op === EXP.arrayLength) {
            oldval = interpretRegion(e1, this.istate);
            if (this.exceptionOrCant(oldval))
                return;
        } else if (e.op === EXP.construct || e.op === EXP.blit) {
            // Unless we have a simple var assignment, we're
            // only modifying part of the variable. So we need to make sure
            // that the parent variable exists.
            const ultimateVar = Interpreter.findParentVar(e1);
            const ve = e1.isVarExp();
            if (ve !== null) {
                const v = ve.var_.isVarDeclaration();
                assert(v !== null);
                if ((v.storage_class & STC.out_) !== 0n)
                    gotoL1 = true; // goto L1 (dmd/dinterpret.d:3444)
            } else if (ultimateVar !== null && getValue(ultimateVar) === null) {
                const ex = interpretRegion(defaultInitLiteral(ultimateVar.type!, e.loc), this.istate);
                if (this.exceptionOrCant(ex))
                    return;
                setValue(ultimateVar, ex!); // `!`: D dereferences newval in setValue's assert (dinterpret.d:7559)
            } else
                gotoL1 = true; // goto L1 (dmd/dinterpret.d:3454)
        } else {
            gotoL1 = true; // the arm that opens with `L1:` (dinterpret.d:3458), entered by fall-through
        }
        if (gotoL1) {
            // L1: (dinterpret.d:3458)
            e1 = interpretRegion(e1, this.istate, CTFEGoal.LValue);
            if (this.exceptionOrCant(e1))
                return;

            if (e1!.op === EXP.index && toBasetype(e1!.isIndexExp()!.e1!.type!).ty === TY.Taarray) {
                assertUnreachable("indexing AA should have been lowered in semantic analysis");
            }
        }

        // ---------------------------------------
        //      Interpret right hand side
        // ---------------------------------------
        let newval = interpretRegion(e.e2, this.istate);
        if (this.exceptionOrCant(newval))
            return;
        if (e.op === EXP.blit && newval!.op === EXP.int64) {
            const tbn = baseElemOf(e.type!);
            if (tbn.ty === TY.Tstruct) {
                /* Look for special case of struct being initialized with 0.
                 */
                newval = defaultInitLiteral(e.type!, e.loc);
                if (newval!.op === EXP.error) {
                    this.result = CTFEExp.cantexp!;
                    return;
                }
                newval = interpretRegion(newval, this.istate); // copy and set ownedByCtfe flag
                if (this.exceptionOrCant(newval))
                    return;
            }
        }

        // ----------------------------------------------------
        //  Deal with read-modify-write assignments.
        //  Set 'newval' to the final assignment value
        //  Also determine the return value (except for slice
        //  assignments, which are more complicated)
        // ----------------------------------------------------
        if (fp !== null) {
            if (oldval === null) {
                // Load the left hand side after interpreting the right hand side.
                oldval = interpretRegion(e1, this.istate);
                if (this.exceptionOrCant(oldval))
                    return;
            }

            if (e.e1!.type!.ty !== TY.Tpointer) {
                // ~= can create new values (see bug 6052)
                if (e.op === EXP.concatenateAssign || e.op === EXP.concatenateElemAssign ||
                    e.op === EXP.concatenateDcharAssign) {
                    // We need to dup it and repaint the type. For a dynamic array
                    // we can skip duplication, because it gets copied later anyway.
                    if (newval!.type!.ty !== TY.Tarray) {
                        newval = copyLiteral(newval!).copy();
                        newval.type = e.e2!.type; // repaint type
                    } else {
                        newval = paintTypeOntoLiteralNoPue(e.e2!.type!, newval!);
                        newval = resolveSlice(newval);
                    }
                }
                oldval = resolveSlice(oldval!);

                newval = fp(e.loc, e.type!, oldval, newval!).copy();
            } else if (isIntegral(e.e2!.type!) &&
                       (e.op === EXP.addAssign ||
                        e.op === EXP.minAssign ||
                        e.op === EXP.plusPlus ||
                        e.op === EXP.minusMinus)) {
                newval = pointerArithmetic(this.pue, e.loc, e.op, e.type!, oldval!, newval!).copy();
                if (newval === this.pue.exp())
                    newval = this.pue.copy();
            } else {
                error(e.loc, ds("pointer expression `%s` cannot be interpreted at compile time"), e.toChars());
                this.result = CTFEExp.cantexp!;
                return;
            }
            if (this.exceptionOrCant(newval)) {
                if (CTFEExp.isCantExp(newval))
                    error(e.loc, ds("cannot interpret `%s` at compile time"), e.toChars());
                return;
            }
        }

        if (e1!.op === EXP.arrayLength) {
            /* Change the assignment from:
             *  arr.length = n;
             * into:
             *  arr = new_length_array; (result is n)
             */

            // Determine the return value
            this.result = ctfeCast(this.pue, e.loc, e.type!, e.type!, fp !== null && post !== 0 ? oldval! : newval!);
            if (this.exceptionOrCant(this.result))
                return;

            if (this.result === this.pue.exp())
                this.result = this.pue.copy();

            // `cast(size_t)` of the two `dinteger_t` carriers — array lengths, the index/length domain (09 §1.1)
            const oldlen = Number(toUint64(toInteger(oldval!)));
            const newlen = Number(toUint64(toInteger(newval!)));
            if (oldlen === newlen) // no change required -- we're done!
                return;

            // We have changed it into a reference assignment
            // Note that returnValue is still the new length.
            e1 = e1!.isArrayLengthExp()!.e1!;
            const t = toBasetype(e1.type!);
            if (t.ty !== TY.Tarray) {
                error(e.loc, ds("`%s` is not yet supported at compile time"), e.toChars());
                this.result = CTFEExp.cantexp!;
                return;
            }
            e1 = interpretRegion(e1, this.istate, CTFEGoal.LValue);
            if (this.exceptionOrCant(e1))
                return;

            if (oldlen !== 0) // Get the old array literal.
                oldval = interpretRegion(e1, this.istate);
            const utmp = new UnionExp();
            oldval = resolveSlice(oldval!, utmp);

            // D: `cast(TypeArray)t` — `t.ty == Tarray` was just tested, so the tag-proved accessor applies.
            newval = changeArrayLiteralLength(this.pue, e.loc, t.isTypeDArray()!, oldval, oldlen, newlen);
            if (newval === this.pue.exp())
                newval = this.pue.copy();

            e1 = Interpreter.assignToLvalue(e, e1!, newval, this.istate);
            if (this.exceptionOrCant(e1))
                return;

            return;
        }

        if (!isBlockAssignment) {
            newval = ctfeCast(this.pue, e.loc, e.type!, e.type!, newval!);
            if (this.exceptionOrCant(newval))
                return;
            if (newval === this.pue.exp())
                newval = this.pue.copy();

            // Determine the return value
            if (this.goal === CTFEGoal.LValue) // https://issues.dlang.org/show_bug.cgi?id=14371
                this.result = e1;
            else {
                this.result = ctfeCast(this.pue, e.loc, e.type!, e.type!, fp !== null && post !== 0 ? oldval! : newval);
                if (this.result === this.pue.exp())
                    this.result = this.pue.copy();
            }
            if (this.exceptionOrCant(this.result))
                return;
        }
        if (this.exceptionOrCant(newval))
            return;

        // dropped: debug (LOGASSIGN) trace (dinterpret.d:3630-3634) — debug OFF (_config.md)

        /* Block assignment or element-wise assignment.
         */
        if (e1!.op === EXP.slice ||
            e1!.op === EXP.vector ||
            e1!.op === EXP.arrayLiteral ||
            e1!.op === EXP.string_ ||
            e1!.op === EXP.null_ && toBasetype(e1!.type!).ty === TY.Tarray) {
            // Note that slice assignments don't support things like ++, so
            // we don't need to remember 'returnValue'.
            this.result = this.interpretAssignToSlice(this.pue, e, e1!, newval!, isBlockAssignment);
            if (this.exceptionOrCant(this.result))
                return;
            const se = e.e1!.isSliceExp();
            if (se !== null) {
                const e1x = interpretRegion(se.e1, this.istate, CTFEGoal.LValue);
                const dve = e1x!.isDotVarExp();
                if (dve !== null) {
                    const ex = dve.e1!;
                    const sle = ex.op === EXP.structLiteral ? ex.isStructLiteralExp()
                              : ex.op === EXP.classReference ? ex.isClassReferenceExp()!.value
                              : null;
                    const v = dve.var_.isVarDeclaration();
                    if (sle === null || v === null) {
                        error(e.loc, ds("CTFE internal error: dotvar slice assignment"));
                        this.result = CTFEExp.cantexp!;
                        return;
                    }
                    Interpreter.stompOverlappedFields(sle, v);
                }
            }
            return;
        }
        assert(this.result !== null);

        /* Assignment to a CTFE reference.
         */
        const ex = Interpreter.assignToLvalue(e, e1!, newval!, this.istate);
        if (ex !== null)
            this.result = ex;

        return;
    }

    /* Set all sibling fields which overlap with v to VoidExp.
     */
    /// dmd/dinterpret.d:3682 — `private static void stompOverlappedFields(StructLiteralExp sle, VarDeclaration v)`.
    private static stompOverlappedFields(sle: StructLiteralExp, v: VarDeclaration): void {
        if (!v.overlapped)
            return;
        const fields = sle.sd!.fields;
        for (let i = 0; i < fields.length; i++) {
            const v2 = fields.opIndex(i)!;
            if (v === v2 || !isOverlappedWith(v, v2))
                continue;
            const e = sle.elements!.opIndex(i);
            if (e !== null && e.op !== EXP.void_)
                sle.elements!.opIndexAssign(voidInitLiteral(e.type!, v).copy(), i);
        }
    }

    /// dmd/dinterpret.d:3696 — `private static Expression assignToLvalue(BinExp e, Expression e1,`.
    /// Returns null on success, a CTFE sentinel/exception on failure, and for a blit the newly created value.
    /// D module-private: `private` is module-scoped in D, and the module-level pointerToAAValue calls it
    /// (dinterpret.d:7039, 7044), so no TS `private` (01 conventions, D module-private member).
    static assignToLvalue(e: BinExp, e1: Expression, newval: Expression, istate: InterState | null): Expression | null {
        //printf("assignToLvalue() e: %s e1: %s newval: %s\n", e.toChars(), e1.toChars(), newval.toChars());
        let vd: VarDeclaration | null = null;
        // D `Expression* payload` — the address of an element slot of an `Expressions` array: an accessor pair
        // over that slot (03 §7.3). `*payload` -> `payload.get()`, `*payload = x` -> `payload.set(x)`.
        // dead-store to prevent spurious warning
        let payload: { get: () => Expression | null; set: (x: Expression | null) => void } | null = null;
        let oldval: Expression | null = null;

        // chained `else if (auto x = e1.isXxx())` declarations: each nested into the prior `else` (06 §2.6)
        const ve = e1.isVarExp();
        if (ve !== null) {
            vd = ve.var_.isVarDeclaration();
            oldval = getValue(vd!);
        } else {
            const dve = e1.isDotVarExp();
            if (dve !== null) {
                /* Assignment to member variable of the form:
                 *  e.v = newval
                 */
                const ex = dve.e1!;
                const sle = ex.op === EXP.structLiteral ? ex.isStructLiteralExp()
                          : ex.op === EXP.classReference ? ex.isClassReferenceExp()!.value
                          : null;
                const v = e1.isDotVarExp()!.var_.isVarDeclaration();
                if (sle === null || v === null) {
                    error(e.loc, ds("CTFE internal error: dotvar assignment"));
                    return CTFEExp.cantexp!;
                }
                if (sle.ownedByCtfe !== OwnedBy.ctfe) {
                    error(e.loc, ds("cannot modify read-only constant `%s`"), sle.toChars());
                    return CTFEExp.cantexp!;
                }

                const fieldi = ex.op === EXP.structLiteral ? findFieldIndexByName(sle.sd!, v)
                             : ex.isClassReferenceExp()!.findFieldIndexByName(v);
                if (fieldi === -1) {
                    error(e.loc, ds("CTFE internal error: cannot find field `%s` in `%s`"), v.toChars(), ex.toChars());
                    return CTFEExp.cantexp!;
                }
                assert(0 <= fieldi && fieldi < sle.elements!.length);

                // If it's a union, set all other members of this union to void
                Interpreter.stompOverlappedFields(sle, v);

                const selems = sle.elements!;
                payload = { get: () => selems.opIndex(fieldi), set: (x) => { selems.opIndexAssign(x, fieldi); } };
                oldval = payload.get();
                const ival = newval.isIntegerExp();
                if (ival !== null) {
                    const bf = v.isBitFieldDeclaration();
                    if (bf !== null) {
                        // `sinteger_t` (long) arithmetic: carrier read signed, each shift re-truncated (09 §3/§4.2)
                        let value = toInt64(toInteger(ival));
                        if (isUnsigned(bf.type!)) {
                            // WHY `& 63` (dinterpret.d:3749): fieldWidth reaches 64 here (`ulong b : 64`), a case
                            // 09 §4.3 assumes the frontend never produces. CTFE runs on the host, arm64-apple-darwin
                            // whatever the triple, whose variable shift masks the count mod 64; ldc2 1.43.0 probe
                            // (-preview=bitfields):
                            // CTFE `s.b = 5` on `ulong b : 64` reads back 0. The port reproduces the arm64 result
                            // (integrator ruling).
                            value &= toInt64((1n << BigInt(bf.fieldWidth & 63)) - 1n); // zero extra bits
                        } else {   // sign extend extra bits
                            value = toInt64(value << BigInt(64 - bf.fieldWidth));
                            value = value >> BigInt(64 - bf.fieldWidth);
                        }
                        ival.setInteger(value);
                    }
                }
            } else {
                const ie = e1.isIndexExp();
                if (ie !== null) {
                    assert(toBasetype(ie.e1!.type!).ty !== TY.Taarray);

                    // locals `Expression aggregate; uinteger_t indexToModify;`, passed by address: Ref boxes (03 §7.2)
                    const aggregate: Ref<Expression | null> = { value: null };
                    const indexToModify: Ref<uinteger_t> = { value: 0n };
                    if (!Interpreter.resolveIndexing(ie, istate, aggregate, indexToModify, true)) {
                        return CTFEExp.cantexp!;
                    }
                    // `cast(size_t)indexToModify` — bounds-checked by resolveIndexing: index/length domain (09 §1.1)
                    const index = Number(indexToModify.value);

                    const existingSE = aggregate.value!.isStringExp();
                    if (existingSE !== null) {
                        if (existingSE.ownedByCtfe !== OwnedBy.ctfe) {
                            error(e.loc, ds("cannot modify read-only string literal `%s`"), ie.e1!.toChars());
                            return CTFEExp.cantexp!;
                        }
                        // `cast(dchar)` of the carrier: its low 32 bits (09 §2.1), exact as a `number`.
                        existingSE.setCodeUnit(index, Number(maskUnsignedN(32, toInteger(newval))));
                        return null;
                    }
                    if (aggregate.value!.op !== EXP.arrayLiteral) {
                        error(e.loc, ds("index assignment `%s` is not yet supported in CTFE "), e.toChars());
                        return CTFEExp.cantexp!;
                    }

                    const existingAE = aggregate.value!.isArrayLiteralExp()!;
                    if (existingAE.ownedByCtfe !== OwnedBy.ctfe) {
                        const literal: Expression = existingAE.aaLiteral !== null ? existingAE.aaLiteral : existingAE;
                        error(e.loc, ds("cannot modify read-only constant `%s`"), literal.toChars());
                        return CTFEExp.cantexp!;
                    }

                    const aelems = existingAE.elements!;
                    payload = { get: () => aelems.opIndex(index), set: (x) => { aelems.opIndexAssign(x, index); } };
                    oldval = payload.get();
                } else {
                    error(e.loc, ds("`%s` cannot be evaluated at compile time"), e.toChars());
                    return CTFEExp.cantexp!;
                }
            }
        }

        const t1b = toBasetype(e1.type!);
        const wantCopy = baseElemOf(t1b).ty === TY.Tstruct;

        { // block: D's `if (auto ve = ...)` scopes `ve` to the if, and the VarExp `ve` above is still live (06 §2.6)
            const ve = newval.isVectorExp();
            if (ve !== null) {
                // Ensure ve is an array literal, and not a broadcast
                if (ve.e1!.op === EXP.int64 || ve.e1!.op === EXP.float64) { // if broadcast
                    const ue = new UnionExp();
                    const ex = Interpreter.interpretVectorToArray(ue, ve);
                    ve.e1 = (ex === ue.exp()) ? ue.copy() : ex;
                }
            }
        }

        if (newval.op === EXP.structLiteral && oldval !== null) {
            assert(oldval.op === EXP.structLiteral || oldval.op === EXP.arrayLiteral || oldval.op === EXP.string_);
            newval = copyLiteral(newval).copy();
            assignInPlace(oldval, newval);
        } else if (wantCopy && (e.op === EXP.assign || e.op === EXP.loweredAssignExp)) {
            // Currently postblit/destructor calls on static array are done
            // in the druntime internal functions so they don't appear in AST.
            // Therefore interpreter should handle them specially.

            assert(oldval !== null);
            // resolved: version(all) -> always on (dinterpret.d:3831)
            // todo: instead we can directly access to each elements of the slice
            {
                newval = resolveSlice(newval);
                if (CTFEExp.isCantExp(newval)) {
                    error(e.loc, ds("CTFE internal error: assignment `%s`"), e.toChars());
                    return CTFEExp.cantexp!;
                }
            }
            assert(oldval.op === EXP.arrayLiteral);
            assert(newval.op === EXP.arrayLiteral);

            const oldelems = oldval.isArrayLiteralExp()!.elements!;
            const newelems = newval.isArrayLiteralExp()!.elements!;
            assert(oldelems.length === newelems.length);

            const elemtype = nextOf(oldval.type!)!;
            // `foreach (i, ref oldelem; *oldelems)`: `oldelem` aliases the slot — read and written by index (03 §4)
            for (let i = 0; i < oldelems.length; i++) {
                const newelem = paintTypeOntoLiteralNoPue(elemtype, newelems.opIndex(i)!);
                // https://issues.dlang.org/show_bug.cgi?id=9245
                if (isLvalue(e.e2!)) {
                    const ex = evaluatePostblit(istate, newelem);
                    if (ex !== null)
                        return ex;
                }
                // https://issues.dlang.org/show_bug.cgi?id=13661
                const ex = evaluateDtor(istate, oldelems.opIndex(i)!);
                if (ex !== null)
                    return ex;
                oldelems.opIndexAssign(newelem, i);
            }
        } else {
            // e1 has its own payload, so we have to create a new literal.
            if (wantCopy)
                newval = copyLiteral(newval).copy();

            if (t1b.ty === TY.Tsarray && e.op === EXP.construct && isLvalue(e.e2!)) {
                // https://issues.dlang.org/show_bug.cgi?id=9245
                const ex = evaluatePostblit(istate, newval);
                if (ex !== null)
                    return ex;
            }

            oldval = newval;
        }

        if (vd !== null)
            setValue(vd, oldval);
        else
            payload!.set(oldval);

        // Blit assignment should return the newly created value.
        if (e.op === EXP.blit)
            return oldval;

        return null;
    }

    /*************
     * dmd/dinterpret.d:3904 — `private Expression interpretAssignToSlice(UnionExp* pue, BinExp e, Expression e1,`.
     * Deal with assignments of the form:
     *  dest[] = newval
     *  dest[low..upp] = newval
     * where newval has already been interpreted
     *
     * This could be a slice assignment or a block assignment, and
     * dest could be either an array literal, or a string.
     *
     * Returns EXP.cantExpression on failure. If there are no errors,
     * it returns aggregate[low..upp], except that as an optimisation,
     * if goal == CTFEGoal.Nothing, it will return NULL
     */
    private interpretAssignToSlice(pue: UnionExp, e: BinExp, e1: Expression, newval: Expression,
                                   isBlockAssignment: boolean): Expression | null {
        //printf("interpretAssignToSlice(e: %s e1: %s newval: %s\n", e.toChars(), e1.toChars(), newval.toChars());

        // `dinteger_t` (ulong) bounds: the bigint carrier (09 §1.1 exception — they fold into IntegerExps below)
        let lowerbound: dinteger_t;
        let upperbound: dinteger_t;
        let firstIndex: dinteger_t;

        let aggregate: Expression;

        const se = e1.isSliceExp();
        if (se !== null) {
            // ------------------------------
            //   aggregate[] = newval
            //   aggregate[low..upp] = newval
            // ------------------------------
            aggregate = interpretRegion(se.e1, this.istate)!;
            // `dinteger_t` is ulong: the signed-normalized carrier is read unsigned (09 §3.1), as resolveIndexing does
            lowerbound = se.lwr !== null ? toUint64(toInteger(se.lwr)) : 0n;
            upperbound = se.upr !== null ? toUint64(toInteger(se.upr)) : resolveArrayLength(aggregate);

            // Slice of a slice --> change the bounds
            const oldse = aggregate.isSliceExp();
            if (oldse !== null) {
                aggregate = oldse.e1!;
                firstIndex = toUint64(lowerbound + toInteger(oldse.lwr!)); // ulong addition wraps (09 §3)
            } else
                firstIndex = lowerbound;
        } else {
            // chained `else if (auto x = e1.isXxx())` declarations: each nested into the prior `else` (06 §2.6)
            const ale = e1.isArrayLiteralExp();
            if (ale !== null) {
                lowerbound = 0n;
                upperbound = BigInt(ale.elements!.length);
            } else {
                const se = e1.isStringExp();
                if (se !== null) {
                    lowerbound = 0n;
                    upperbound = BigInt(se.len);
                } else if (e1.op === EXP.null_) {
                    lowerbound = 0n;
                    upperbound = 0n;
                } else {
                    const ve = e1.isVectorExp();
                    if (ve !== null) {
                        // ve is not handled but a proper error message is returned
                        // this is to prevent https://issues.dlang.org/show_bug.cgi?id=20042
                        lowerbound = 0n;
                        upperbound = BigInt(ve.dim);
                    } else
                        assertUnreachable();
                }
            }

            aggregate = e1;
            firstIndex = lowerbound;
        }
        if (upperbound === lowerbound)
            return newval;

        // For slice assignment, we check that the lengths match.
        if (!isBlockAssignment && e1.type!.ty !== TY.Tpointer) {
            const srclen = resolveArrayLength(newval);
            if (srclen !== toUint64(upperbound - lowerbound)) {
                error(e.loc, ds("array length mismatch assigning `[0..%llu]` to `[%llu..%llu]`"),
                    srclen, lowerbound, upperbound);
                return CTFEExp.cantexp!;
            }
        }

        const existingSE = aggregate.isStringExp();
        if (existingSE !== null) {
            if (existingSE.ownedByCtfe !== OwnedBy.ctfe) {
                error(e.loc, ds("cannot modify read-only string literal `%s`"), existingSE.toChars());
                return CTFEExp.cantexp!;
            }

            { // block: D's `if (auto se = ...)` scopes `se` to the if; a sibling `se` follows (06 §2.6)
                const se = newval.isSliceExp();
                if (se !== null) {
                    const aggr2 = se.e1!;
                    const srclower = toUint64(toInteger(se.lwr!)); // dinteger_t (ulong), 09 §3.1
                    const srcupper = toUint64(toInteger(se.upr!));

                    if (aggregate === aggr2 &&
                        lowerbound < srcupper && srclower < upperbound) {
                        error(e.loc, ds("overlapping slice assignment `[%llu..%llu] = [%llu..%llu]`"),
                            lowerbound, upperbound, srclower, srcupper);
                        return CTFEExp.cantexp!;
                    }
                    // resolved: version(all) -> always on (dinterpret.d:3999)
                    // todo: instead we can directly access to each elements of the slice
                    {
                        const orignewval = newval;
                        newval = resolveSlice(newval);
                        if (CTFEExp.isCantExp(newval)) {
                            error(e.loc, ds("CTFE internal error: slice `%s`"), orignewval.toChars());
                            return CTFEExp.cantexp!;
                        }
                    }
                    assert(newval.op !== EXP.slice);
                }
            }
            const se = newval.isStringExp();
            if (se !== null) {
                // `cast(size_t)firstIndex` — the index/length domain (09 §1.1)
                sliceAssignStringFromString(existingSE, se, Number(firstIndex));
                return newval;
            }
            const ale = newval.isArrayLiteralExp();
            if (ale !== null) {
                /* Mixed slice: it was initialized as a string literal.
                 * Now a slice of it is being set with an array literal.
                 */
                sliceAssignStringFromArrayLiteral(existingSE, ale, Number(firstIndex)); // `cast(size_t)firstIndex`
                return newval;
            }

            // String literal block slice assign
            // `cast(dchar)` of the carrier: its low 32 bits (09 §2.1), exact as a `number`.
            const value = Number(maskUnsignedN(32, toInteger(newval)));
            // `foreach (i; 0 .. upperbound - lowerbound)`: a ulong counter, bound evaluated once (06 §1.3)
            const count = toUint64(upperbound - lowerbound);
            for (let i = 0n; i < count; i++) {
                existingSE.setCodeUnit(Number(i + firstIndex), value); // `cast(size_t)(i + firstIndex)` (09 §1.1)
            }
            if (this.goal === CTFEGoal.Nothing)
                return null; // avoid creating an unused literal
            const retslice = ctfeEmplaceExp(() => new SliceExp(e.loc, existingSE,
                        ctfeEmplaceExp(() => new IntegerExp(e.loc, firstIndex, Type.tsize_t)),
                        ctfeEmplaceExp(() => new IntegerExp(e.loc, toUint64(firstIndex + upperbound - lowerbound),
                            Type.tsize_t))));
            retslice.type = e.type;
            return interpret(pue, retslice, this.istate);
        }
        const existingAE = aggregate.isArrayLiteralExp();
        if (existingAE !== null) {
            if (existingAE.ownedByCtfe !== OwnedBy.ctfe) {
                error(e.loc, ds("cannot modify read-only constant `%s`"), existingAE.toChars());
                return CTFEExp.cantexp!;
            }

            if (newval.op === EXP.slice && !isBlockAssignment) {
                const se = newval.isSliceExp()!;
                const aggr2 = se.e1!;
                const srclower = toUint64(toInteger(se.lwr!)); // dinteger_t (ulong), 09 §3.1
                const srcupper = toUint64(toInteger(se.upr!));
                const wantCopy = (baseElemOf(nextOf(toBasetype(newval.type!))!).ty === TY.Tstruct);

                //printf("oldval = %p %s[%d..%u]\nnewval = %p %s[%llu..%llu] wantCopy = %d\n",
                //    aggregate, aggregate.toChars(), lowerbound, upperbound,
                //    aggr2, aggr2.toChars(), srclower, srcupper, wantCopy);
                if (wantCopy) {
                    // Currently overlapping for struct array is allowed.
                    // The order of elements processing depends on the overlapping.
                    // https://issues.dlang.org/show_bug.cgi?id=14024
                    assert(aggr2.op === EXP.arrayLiteral);
                    const oldelems = existingAE.elements!;
                    const newelems = aggr2.isArrayLiteralExp()!.elements!;

                    const elemtype = nextOf(aggregate.type!)!;
                    const needsPostblit = isLvalue(e.e2!);

                    if (aggregate === aggr2 && srclower < lowerbound && lowerbound < srcupper) {
                        // reverse order
                        // `auto i = upperbound - lowerbound` — a ulong counter (09 §3); each
                        // `cast(size_t)(...)` below is an in-bounds element index (09 §1.1)
                        for (let i = toUint64(upperbound - lowerbound); 0n < i--;) {
                            const oldelem = oldelems.opIndex(Number(i + firstIndex))!;
                            let newelem = newelems.opIndex(Number(i + srclower))!;
                            newelem = copyLiteral(newelem).copy();
                            newelem.type = elemtype;
                            if (needsPostblit) {
                                const x = evaluatePostblit(this.istate, newelem);
                                if (x !== null)
                                    return x;
                            }
                            const x = evaluateDtor(this.istate, oldelem);
                            if (x !== null)
                                return x;
                            oldelems.opIndexAssign(newelem, Number(lowerbound + i));
                        }
                    } else {
                        // normal order
                        // `auto i = 0` — an `int` counter compared and summed in ulong (09 §5): widened at each use;
                        // each `cast(size_t)(...)` below is an in-bounds element index (09 §1.1)
                        for (let i = 0; BigInt(i) < toUint64(upperbound - lowerbound); i++) {
                            const oldelem = oldelems.opIndex(Number(BigInt(i) + firstIndex))!;
                            let newelem = newelems.opIndex(Number(BigInt(i) + srclower))!;
                            newelem = copyLiteral(newelem).copy();
                            newelem.type = elemtype;
                            if (needsPostblit) {
                                const x = evaluatePostblit(this.istate, newelem);
                                if (x !== null)
                                    return x;
                            }
                            const x = evaluateDtor(this.istate, oldelem);
                            if (x !== null)
                                return x;
                            oldelems.opIndexAssign(newelem, Number(lowerbound + BigInt(i)));
                        }
                    }

                    //assert(0);
                    return newval; // oldval?
                }
                if (aggregate === aggr2 &&
                    lowerbound < srcupper && srclower < upperbound) {
                    error(e.loc, ds("overlapping slice assignment `[%llu..%llu] = [%llu..%llu]`"),
                        lowerbound, upperbound, srclower, srcupper);
                    return CTFEExp.cantexp!;
                }
                // resolved: version(all) -> always on (dinterpret.d:4119)
                // todo: instead we can directly access to each elements of the slice
                {
                    const orignewval = newval;
                    newval = resolveSlice(newval);
                    if (CTFEExp.isCantExp(newval)) {
                        error(e.loc, ds("CTFE internal error: slice `%s`"), orignewval.toChars());
                        return CTFEExp.cantexp!;
                    }
                }
                // no overlapping
                //length?
                assert(newval.op !== EXP.slice);
            }
            if (newval.op === EXP.string_ && !isBlockAssignment) {
                /* Mixed slice: it was initialized as an array literal of chars/integers.
                 * Now a slice of it is being set with a string.
                 */
                // `cast(size_t)firstIndex` — the index/length domain (09 §1.1)
                sliceAssignArrayLiteralFromString(existingAE, newval.isStringExp()!, Number(firstIndex));
                return newval;
            }
            if (newval.op === EXP.arrayLiteral && !isBlockAssignment) {
                const oldelems = existingAE.elements!;
                const newelems = newval.isArrayLiteralExp()!.elements!;
                const elemtype = nextOf(existingAE.type!)!;
                const needsPostblit = e.op !== EXP.blit && isLvalue(e.e2!);
                // `foreach (j, newelem; *newelems)`: `newelem` is a by-value loop variable, rebound locally
                for (let j = 0; j < newelems.length; j++) {
                    let newelem = newelems.opIndex(j)!;
                    newelem = paintTypeOntoLiteralNoPue(elemtype, newelem);
                    if (needsPostblit) {
                        const x = evaluatePostblit(this.istate, newelem);
                        if (exceptionOrCantInterpret(x))
                            return x;
                    }
                    // `cast(size_t)(j + firstIndex)` — an in-bounds element index (09 §1.1)
                    oldelems.opIndexAssign(newelem, Number(BigInt(j) + firstIndex));
                }
                return newval;
            }

            /* Block assignment, initialization of static arrays
             *   x[] = newval
             *  x may be a multidimensional static array. (Note that this
             *  only happens with array literals, never with strings).
             */
            // dmd/dinterpret.d:4166 — `struct RecursiveBlock`: a nested value struct used through the single local
            // `rb`, never copied. Its five fields become the object `rb` below; its two `assignTo` overloads
            // (D:4174 / D:4179, the short one only filling the bounds) ONE local arrow with default trailing
            // parameters (04 §1 Form A, SCOUT §2). The arrow reads `rb`, which is initialized before the call.
            const assignTo = (ae: ArrayLiteralExp, lwr: number = 0,
                              upr: number = ae.elements!.length): Expression | null => {
                const w = ae.elements!;
                assert(ae.type!.isStaticOrDynamicArray() || ae.type!.ty === TY.Tpointer);
                // D: `(cast(TypeNext)ae.type).next` — tag-proved RTTI downcast (02 §11.5c shape 3): the assert just
                // above proves Tsarray/Tarray/Tpointer, all TypeNext subclasses with no common `isTypeXxx()` accessor.
                const directblk = equivalent((ae.type as unknown as TypeNext).next!, rb.newval.type!);
                for (let k = lwr; k < upr; k++) {
                    if (!directblk && w.opIndex(k)!.op === EXP.arrayLiteral) {
                        // Multidimensional array block assign
                        const ex = assignTo(w.opIndex(k)!.isArrayLiteralExp()!);
                        if (ex !== null)
                            return ex;
                    } else if (rb.refCopy) {
                        w.opIndexAssign(rb.newval, k);
                    } else if (!rb.needsPostblit && !rb.needsDtor) {
                        assignInPlace(w.opIndex(k)!, rb.newval);
                    } else {
                        const oldelem = w.opIndex(k)!;
                        const tmpelem = rb.needsDtor ? copyLiteral(oldelem).copy() : null;
                        assignInPlace(oldelem, rb.newval);
                        if (rb.needsPostblit) {
                            const ex = evaluatePostblit(rb.istate, oldelem);
                            if (ex !== null)
                                return ex;
                        }
                        if (rb.needsDtor) {
                            // https://issues.dlang.org/show_bug.cgi?id=14860
                            const ex = evaluateDtor(rb.istate, tmpelem!);
                            if (ex !== null)
                                return ex;
                        }
                    }
                }
                return null;
            };

            const tn = toBasetype(newval.type!);
            const wantRef = (tn.ty === TY.Tarray || isAssocArray(tn) || tn.ty === TY.Tclass);
            const cow = newval.op !== EXP.structLiteral && newval.op !== EXP.arrayLiteral && newval.op !== EXP.string_;
            const tb = baseElemOf(tn);
            const sd: StructDeclaration | null = (tb.ty === TY.Tstruct ? tb.isTypeStruct()!.sym : null);

            // `RecursiveBlock rb;` + the five field stores (D:4228-4233)
            const rb = {
                istate: this.istate,
                newval: newval,
                refCopy: wantRef || cow,
                needsPostblit: sd !== null && sd.postblit !== null && e.op !== EXP.blit && isLvalue(e.e2!),
                needsDtor: sd !== null && sd.dtor !== null && (e.op === EXP.assign || e.op === EXP.loweredAssignExp),
            };
            // `cast(size_t)lowerbound` / `cast(size_t)upperbound` — array bounds, the index/length domain (09 §1.1)
            const ex = assignTo(existingAE, Number(lowerbound), Number(upperbound));
            if (ex !== null)
                return ex;

            if (this.goal === CTFEGoal.Nothing)
                return null; // avoid creating an unused literal
            const retslice = ctfeEmplaceExp(() => new SliceExp(e.loc, existingAE,
                ctfeEmplaceExp(() => new IntegerExp(e.loc, firstIndex, Type.tsize_t)),
                ctfeEmplaceExp(() => new IntegerExp(e.loc, toUint64(firstIndex + upperbound - lowerbound),
                    Type.tsize_t))));
            retslice.type = e.type;
            return interpret(pue, retslice, this.istate);
        }

        error(e.loc, ds("slice operation `%s = %s` cannot be evaluated at compile time"), e1.toChars(),
            newval.toChars());
        return CTFEExp.cantexp!;
    }

    /// dmd/dinterpret.d:4250 — `override void visit(AssignExp e)`.
    override visitAssignExp(e: AssignExp): void {
        this.interpretAssignCommon(e, null);
    }

    /// dmd/dinterpret.d:4255 — `override void visit(BinAssignExp e)`.
    override visitBinAssignExp(e: BinAssignExp): void {
        switch (e.op) {
            case EXP.addAssign:
                this.interpretAssignCommon(e, Add);
                return;

            case EXP.minAssign:
                this.interpretAssignCommon(e, Min);
                return;

            case EXP.concatenateAssign:
            case EXP.concatenateElemAssign:
            case EXP.concatenateDcharAssign:
                this.interpretAssignCommon(e, ctfeCat);
                return;

            case EXP.mulAssign:
                this.interpretAssignCommon(e, Mul);
                return;

            case EXP.divAssign:
                this.interpretAssignCommon(e, Div);
                return;

            case EXP.modAssign:
                this.interpretAssignCommon(e, Mod);
                return;

            case EXP.leftShiftAssign:
                this.interpretAssignCommon(e, Shl);
                return;

            case EXP.rightShiftAssign:
                this.interpretAssignCommon(e, Shr);
                return;

            case EXP.unsignedRightShiftAssign:
                this.interpretAssignCommon(e, Ushr);
                return;

            case EXP.andAssign:
                this.interpretAssignCommon(e, And);
                return;

            case EXP.orAssign:
                this.interpretAssignCommon(e, Or);
                return;

            case EXP.xorAssign:
                this.interpretAssignCommon(e, Xor);
                return;

            case EXP.powAssign:
                this.interpretAssignCommon(e, Pow);
                return;

            default:
                assertUnreachable();
        }
    }

    /// dmd/dinterpret.d:4318 — `override void visit(PostExp e)`.
    override visitPostExp(e: PostExp): void {
        // dropped: debug (LOG) trace (dinterpret.d:4320-4323) — debug OFF (_config.md)
        if (e.op === EXP.plusPlus)
            this.interpretAssignCommon(e, Add, 1);
        else
            this.interpretAssignCommon(e, Min, 1);
        // dropped: debug (LOG) trace (dinterpret.d:4328-4332) — debug OFF (_config.md)
    }

    /* Return 1 if e is a p1 > p2 or p1 >= p2 pointer comparison;
     *       -1 if e is a p1 < p2 or p1 <= p2 pointer comparison;
     *        0 otherwise
     */
    /// dmd/dinterpret.d:4339 — `static int isPointerCmpExp(Expression e, Expression* p1, Expression* p2)`.
    /// `p1`/`p2` are D `Expression*` out-slots over the caller's locals -> Ref boxes (03 §7.2).
    static isPointerCmpExp(e: Expression, p1: Ref<Expression | null>, p2: Ref<Expression | null>): number {
        let ret = 1;
        let cur: Expression = e; // D reassigns the parameter walking the `!` chain (02 §10.1)
        while (cur.op === EXP.not) {
            ret *= -1;
            cur = cur.isNotExp()!.e1!;
        }
        switch (cur.op) {
            case EXP.lessThan:
            case EXP.lessOrEqual:
                ret *= -1;
                // goto case; -> fall through to next case (JS no-break fallthrough) (dinterpret.d:4352)
            case EXP.greaterThan:
            case EXP.greaterOrEqual:
                p1.value = cur.isBinExp()!.e1;
                p2.value = cur.isBinExp()!.e2;
                if (!(isPointer(p1.value!.type!) && isPointer(p2.value!.type!)))
                    ret = 0;
                break;

            default:
                ret = 0;
                break;
        }
        return ret;
    }

    /** dmd/dinterpret.d:4384 — `private void interpretFourPointerRelation(UnionExp* pue, BinExp e)`.
     *  If this is a four pointer relation, evaluate it, else return NULL.
     *
     *  This is an expression of the form (p1 > q1 && p2 < q2) or (p1 < q1 || p2 > q2)
     *  where p1, p2 are expressions yielding pointers to memory block p,
     *  and q1, q2 are expressions yielding pointers to memory block q.
     *  This expression is valid even if p and q are independent memory
     *  blocks and are therefore not normally comparable; the && form returns true
     *  if [p1..p2] lies inside [q1..q2], and false otherwise; the || form returns
     *  true if [p1..p2] lies outside [q1..q2], and false otherwise.
     *
     *  Within the expression, any ordering of p1, p2, q1, q2 is permissible;
     *  the comparison operators can be any of >, <, <=, >=, provided that
     *  both directions (p > q and p < q) are checked. Additionally the
     *  relational sub-expressions can be negated, eg
     *  (!(q1 < p1) && p2 <= q2) is valid.
     */
    private interpretFourPointerRelation(pue: UnionExp, e: BinExp): void {
        assert(e.op === EXP.andAnd || e.op === EXP.orOr);

        /*  It can only be an isInside expression, if both e1 and e2 are
         *  directional pointer comparisons.
         *  Note that this check can be made statically; it does not depends on
         *  any runtime values. This allows a JIT implementation to compile a
         *  special AndAndPossiblyInside, keeping the normal AndAnd case efficient.
         */

        // Save the pointer expressions and the comparison directions,
        // so we can use them later.
        // D locals `Expression p1 .. p4 = null;` passed by address -> Ref boxes (03 §7.2)
        const p1: Ref<Expression | null> = { value: null };
        const p2: Ref<Expression | null> = { value: null };
        const p3: Ref<Expression | null> = { value: null };
        const p4: Ref<Expression | null> = { value: null };
        const dir1 = Interpreter.isPointerCmpExp(e.e1!, p1, p2);
        const dir2 = Interpreter.isPointerCmpExp(e.e2!, p3, p4);
        if (dir1 === 0 || dir2 === 0) {
            this.result = null;
            return;
        }

        //printf("FourPointerRelation %s\n", toChars());

        const ue1 = new UnionExp();
        const ue2 = new UnionExp();
        const ue3 = new UnionExp();
        const ue4 = new UnionExp();

        // Evaluate the first two pointers
        p1.value = interpret(ue1, p1.value, this.istate);
        if (this.exceptionOrCant(p1.value))
            return;
        p2.value = interpret(ue2, p2.value, this.istate);
        if (this.exceptionOrCant(p2.value))
            return;
        // D `dinteger_t ofs1, ofs2;` passed by address -> Ref boxes (03 §7.2), `.init` 0
        const ofs1: Ref<dinteger_t> = { value: 0n };
        const ofs2: Ref<dinteger_t> = { value: 0n };
        const agg1 = getAggregateFromPointer(p1.value!, ofs1);
        const agg2 = getAggregateFromPointer(p2.value!, ofs2);

        if (!pointToSameMemoryBlock(agg1, agg2) && agg1.op !== EXP.null_ && agg2.op !== EXP.null_) {
            // Here it is either CANT_INTERPRET,
            // or an IsInside comparison returning false.
            p3.value = interpret(ue3, p3.value, this.istate);
            if (CTFEExp.isCantExp(p3.value))
                return;
            // Note that it is NOT legal for it to throw an exception!
            let except: Expression | null = null;
            if (exceptionOrCantInterpret(p3.value))
                except = p3.value;
            else {
                p4.value = interpret(ue4, p4.value, this.istate);
                if (CTFEExp.isCantExp(p4.value)) {
                    this.result = p4.value;
                    return;
                }
                if (exceptionOrCantInterpret(p4.value))
                    except = p4.value;
            }
            if (except !== null) {
                error(e.loc, ds("comparison `%s` of pointers to unrelated memory blocks remains indeterminate at " +
                    "compile time because exception `%s` was thrown while evaluating `%s`"),
                    e.e1!.toChars(), except.toChars(), e.e2!.toChars());
                this.result = CTFEExp.cantexp!;
                return;
            }
            const ofs3: Ref<dinteger_t> = { value: 0n };
            const ofs4: Ref<dinteger_t> = { value: 0n };
            const agg3 = getAggregateFromPointer(p3.value!, ofs3);
            const agg4 = getAggregateFromPointer(p4.value!, ofs4);
            // The valid cases are:
            // p1 > p2 && p3 > p4  (same direction, also for < && <)
            // p1 > p2 && p3 < p4  (different direction, also < && >)
            // Changing any > into >= doesn't affect the result
            if ((dir1 === dir2 && pointToSameMemoryBlock(agg1, agg4) && pointToSameMemoryBlock(agg2, agg3)) ||
                (dir1 !== dir2 && pointToSameMemoryBlock(agg1, agg3) && pointToSameMemoryBlock(agg2, agg4))) {
                // it's a legal two-sided comparison
                pue.emplace(new IntegerExp(e.loc, (e.op === EXP.andAnd) ? 0n : 1n, e.type!));
                this.result = pue.exp();
                return;
            }
            // It's an invalid four-pointer comparison. Either the second
            // comparison is in the same direction as the first, or else
            // more than two memory blocks are involved (either two independent
            // invalid comparisons are present, or else agg3 == agg4).
            error(e.loc, ds("comparison `%s` of pointers to unrelated memory blocks is indeterminate at compile " +
                "time, even when combined with `%s`."), e.e1!.toChars(), e.e2!.toChars());
            this.result = CTFEExp.cantexp!;
            return;
        }
        // The first pointer expression didn't need special treatment, so we
        // we need to interpret the entire expression exactly as a normal && or ||.
        // This is easy because we haven't evaluated e2 at all yet, and we already
        // know it will return a bool.
        // But we mustn't evaluate the pointer expressions in e1 again, in case
        // they have side-effects.
        let nott = false;
        let ex: Expression = e.e1!;
        while (true) {
            const ne = ex.isNotExp();
            if (ne !== null) {
                nott = !nott;
                ex = ne.e1!;
            } else
                break;
        }

        /** dmd/dinterpret.d:4503 — `static EXP negateRelation(EXP op) pure` (nested function -> local arrow, 04 §5).
         * Negate relational operator, eg >= becomes <
         * Params:
         *      op = comparison operator to negate
         * Returns:
         *      negate operator
         */
        const negateRelation = (op: EXP): EXP => {
            switch (op) {
                case EXP.greaterOrEqual:  op = EXP.lessThan;       break;
                case EXP.greaterThan:     op = EXP.lessOrEqual;    break;
                case EXP.lessOrEqual:     op = EXP.greaterThan;    break;
                case EXP.lessThan:        op = EXP.greaterOrEqual; break;
                default:                  assertUnreachable();
            }
            return op;
        };

        const cmpop: EXP = nott ? negateRelation(ex.op) : ex.op;
        const cmp = comparePointers(cmpop, agg1, ofs1.value, agg2, ofs2.value);
        // We already know this is a valid comparison.
        assert(cmp >= 0);
        if (e.op === EXP.andAnd && cmp === 1 || e.op === EXP.orOr && cmp === 0) {
            this.result = interpret(pue, e.e2, this.istate);
            return;
        }
        pue.emplace(new IntegerExp(e.loc, (e.op === EXP.andAnd) ? 0n : 1n, e.type!));
        this.result = pue.exp();
    }

    /// dmd/dinterpret.d:4529 — `override void visit(LogicalExp e)`
    override visitLogicalExp(e: LogicalExp): void {
        // dropped: `debug (LOG)` block (dinterpret.d:4531) — debug OFF (_config §3)
        // Check for an insidePointer expression, evaluate it if so
        this.interpretFourPointerRelation(this.pue, e);
        if (this.result !== null)
            return;

        const ue1 = new UnionExp(); // `UnionExp ue1 = void;`
        this.result = interpret(ue1, e.e1, this.istate);
        if (this.exceptionOrCant(this.result))
            return;

        let res = false; // D `bool res;` (bool.init)
        const andand = e.op === EXP.andAnd;
        if (andand ? toBool(this.result!).hasValue(false) : isTrueBool(this.result!))
            res = !andand;
        else if (andand ? isTrueBool(this.result!) : toBool(this.result!).hasValue(false)) {
            const ue2 = new UnionExp(); // `UnionExp ue2 = void;`
            this.result = interpret(ue2, e.e2, this.istate);
            if (this.exceptionOrCant(this.result))
                return;
            if (this.result!.op === EXP.voidExpression) {
                assert(e.type!.ty === TY.Tvoid);
                this.result = null;
                return;
            }
            if (toBool(this.result!).hasValue(false))
                res = false;
            else if (isTrueBool(this.result!))
                res = true;
            else {
                error(e.loc, ds("`%s` does not evaluate to a `bool`"), this.result!.toChars());
                this.result = CTFEExp.cantexp!;
                return;
            }
        } else {
            error(e.loc, ds("`%s` cannot be interpreted as a `bool`"), this.result!.toChars());
            this.result = CTFEExp.cantexp!;
            return;
        }
        incUsageCtfe(this.istate, e.e2!.loc);

        if (this.goal !== CTFEGoal.Nothing) {
            if (e.type!.equals(Type.tbool))
                this.result = IntegerExp.createBool(res);
            else {
                this.pue.emplace(new IntegerExp(e.loc, res ? 1n : 0n, e.type!)); // bool -> dinteger_t
                this.result = this.pue.exp();
            }
        }
    }


    // Print a stack trace, starting from callingExp which called fd.
    // To shorten the stack trace, try to detect recursion.
    /// dmd/dinterpret.d:4595 — `private void showCtfeBackTrace(CallExp callingExp, FuncDeclaration fd)`
    private showCtfeBackTrace(callingExp: CallExp, fd: FuncDeclaration): void {
        if (ctfeGlobals.stackTraceCallsToSuppress > 0) {
            --ctfeGlobals.stackTraceCallsToSuppress;
            return;
        }
        errorSupplemental(callingExp.loc, ds("called from here: `%s`"), callingExp.toChars());
        // Quit if it's not worth trying to compress the stack trace
        if (ctfeGlobals.callDepth < 6 || global.params.v.verbose)
            return;
        // Recursion happens if the current function already exists in the call stack.
        let numToSuppress = 0;
        let recurseCount = 0;
        let depthSoFar = 0;
        let lastRecurse = this.istate;
        for (let cur = this.istate; cur !== null; cur = cur.caller) {
            if (cur.fd === fd) {
                ++recurseCount;
                numToSuppress = depthSoFar;
                lastRecurse = cur;
            }
            ++depthSoFar;
        }
        // We need at least three calls to the same function, to make compression worthwhile
        if (recurseCount < 2)
            return;
        // We found a useful recursion.  Print all the calls involved in the recursion
        errorSupplemental(fd.loc, ds("%d recursive calls to function `%s`"), recurseCount, fd.toChars());
        // recurseCount >= 2 proves `fd` was found on the chain, so the walk below never leaves it (D derefs bare)
        for (let cur = this.istate!; cur.fd !== fd; cur = cur.caller!) {
            errorSupplemental(cur.fd!.loc, ds("recursively called from function `%s`"), cur.fd!.toChars());
        }
        // We probably didn't enter the recursion in this function.
        // Go deeper to find the real beginning.
        let cur = this.istate!;
        while (lastRecurse!.caller !== null && cur.fd === lastRecurse!.caller.fd) {
            cur = cur.caller!;
            lastRecurse = lastRecurse!.caller;
            ++numToSuppress;
        }
        ctfeGlobals.stackTraceCallsToSuppress = numToSuppress;
    }

    /// dmd/dinterpret.d:4642 — `override void visit(CallExp e)`
    override visitCallExp(e: CallExp): void {
        // dropped: `debug (LOG)` block (dinterpret.d:4644) — debug OFF (_config §3)
        let pthis: Expression | null = null;
        let fd: FuncDeclaration | null = null;

        const ecall = interpretRegion(e.e1, this.istate);
        if (this.exceptionOrCant(ecall))
            return;

        // 06 §2.6: the chained `if (auto x = ...)` declarations nest into each prior `else`
        const dve = ecall!.isDotVarExp();
        if (dve !== null) {
            // Calling a member function
            pthis = dve.e1;
            fd = dve.var_.isFuncDeclaration();
            assert(fd);

            const dte = pthis!.isDotTypeExp();
            if (dte !== null)
                pthis = dte.e1;
        } else {
            const ve = ecall!.isVarExp();
            if (ve !== null) {
                fd = ve.var_.isFuncDeclaration();
                assert(fd);

                // If `_d_HookTraceImpl` is found, resolve the underlying hook and replace `e` and `fd` with it.
                // `ref CallExp ce, ref FuncDeclaration fd` (dinterpret.d:7573) -> Ref boxes, written back (03 §3.2)
                const ceRef: Ref<CallExp> = { value: e };
                const fdRef: Ref<FuncDeclaration> = { value: fd };
                removeHookTraceImpl(ceRef, fdRef);
                e = ceRef.value;
                fd = fdRef.value;

                if (fd.ident === Id.__ArrayPostblit || fd.ident === Id.__ArrayDtor) {
                    assert(e.arguments_!.length === 1);
                    let ea = e.arguments_!.opIndex(0)!;
                    // printf("1 ea = %s %s\n", ea.type.toChars(), ea.toChars());
                    const se = ea.isSliceExp();
                    if (se !== null)
                        ea = se.e1!;
                    const ce = ea.isCastExp();
                    if (ce !== null)
                        ea = ce.e1!;

                    // printf("2 ea = %s, %s %s\n", ea.type.toChars(), EXPtoString(ea.op).ptr, ea.toChars());
                    if (ea.op === EXP.variable || ea.op === EXP.symbolOffset) {
                        // D `(cast(SymbolExp)ea)` — tag-proved downcast (02 §11.5c item 3): the tag set
                        // {variable, symbolOffset} tested on this line proves a SymbolExp (VarExp / SymOffExp)
                        const sym = ea as unknown as SymbolExp;
                        this.result = Interpreter.getVarExp(e.loc, this.istate, sym.var_, CTFEGoal.RValue);
                    } else {
                        const ae = ea.isAddrExp();
                        if (ae !== null)
                            this.result = interpretRegion(ae.e1, this.istate);

                        // https://issues.dlang.org/show_bug.cgi?id=18871
                        // https://issues.dlang.org/show_bug.cgi?id=18819
                        else {
                            const ale = ea.isArrayLiteralExp();
                            if (ale !== null)
                                this.result = interpretRegion(ale, this.istate);

                            else
                                assertUnreachable();
                        }
                    }
                    if (CTFEExp.isCantExp(this.result))
                        return;

                    if (fd.ident === Id.__ArrayPostblit)
                        this.result = evaluatePostblit(this.istate, this.result!);
                    else
                        this.result = evaluateDtor(this.istate, this.result!);
                    if (this.result === null)
                        this.result = CTFEExp.voidexp!;
                    return;
                }
            } else {
                const soe = ecall!.isSymOffExp();
                if (soe !== null) {
                    fd = soe.var_.isFuncDeclaration();
                    assert(fd !== null && soe.offset === 0n);
                } else {
                    const de = ecall!.isDelegateExp();
                    if (de !== null) {
                        // Calling a delegate
                        fd = de.func;
                        pthis = de.e1;

                        // Special handling for: &nestedfunc --> DelegateExp(VarExp(nestedfunc), nestedfunc)
                        const ve = pthis!.isVarExp();
                        if (ve !== null)
                            if (ve.var_ === fd)
                                pthis = null; // context is not necessary for CTFE
                    } else {
                        const fe = ecall!.isFuncExp();
                        if (fe !== null) {
                            // Calling a delegate literal
                            fd = fe.fd;
                        } else {
                            // delegate.funcptr()
                            // others
                            error(e.loc, ds("cannot call `%s` at compile time"), e.toChars());
                            this.result = CTFEExp.cantexp!;
                            return;
                        }
                    }
                }
            }
        }
        if (fd === null) {
            error(e.loc, ds("CTFE internal error: cannot evaluate `%s` at compile time"), e.toChars());
            this.result = CTFEExp.cantexp!;
            return;
        }
        if (pthis !== null) {
            // Member function call

            // Currently this is satisfied because closure is not yet supported.
            assert(!fd.isNested() || fd.needThis());

            if (pthis.op === EXP.typeid_) {
                error(pthis.loc, ds("static variable `%s` cannot be read at compile time"), pthis.toChars());
                this.result = CTFEExp.cantexp!;
                return;
            }
            assert(pthis);

            if (pthis.op === EXP.null_) {
                assert(toBasetype(pthis.type!).ty === TY.Tclass);
                error(e.loc, ds("function call through null class reference `%s`"), pthis.toChars());
                this.result = CTFEExp.cantexp!;
                return;
            }

            assert(pthis.op === EXP.structLiteral || pthis.op === EXP.classReference || pthis.op === EXP.type);

            if (isVirtual(fd) && !e.directcall) {
                // Make a virtual function call.
                // Get the function from the vtable of the original class
                const cd = pthis.isClassReferenceExp()!.originalClass();

                // We can't just use the vtable index to look it up, because
                // vtables for interfaces don't get populated until the glue layer.
                fd = findFunc(cd!, fd.ident!, fd.type!.isTypeFunction()!); // `cd.findFunc(...)` (semantic2.d)
                assert(fd);
            }
        }

        if (fd !== null && fd.semanticRun >= PASS.semantic3done && fd.hasSemantic3Errors) {
            error(e.loc, ds("CTFE failed because of previous errors in `%s`"), fd.toChars());
            this.result = CTFEExp.cantexp!;
            return;
        }

        // Check for built-in functions
        this.result = evaluateIfBuiltin(this.pue, this.istate, e.loc, fd, e.arguments_, pthis);
        if (this.result !== null)
            return;

        if (fd.fbody === null) {
            error(e.loc,
                ds("`%s` cannot be interpreted at compile time, because it has no available source code"),
                fd.toChars());
            this.result = CTFEExp.showcontext!;
            return;
        }

        this.result = interpretFunction(this.pue, fd, this.istate, e.arguments_, pthis);
        if (this.result!.op === EXP.voidExpression)
            return;
        if (!exceptionOrCantInterpret(this.result)) {
            if (this.goal !== CTFEGoal.LValue) { // Peel off CTFE reference if it's unnecessary
                if (this.result === this.pue.exp())
                    this.result = this.pue.copy();
                this.result = interpret(this.pue, this.result, this.istate);
            }
        }
        if (!exceptionOrCantInterpret(this.result)) {
            this.result = paintTypeOntoLiteral(this.pue, e.type!, this.result!);
            this.result.loc = e.loc;
        } else if (CTFEExp.isCantExp(this.result) && global.gag === 0)
            this.showCtfeBackTrace(e, fd); // Print a stack trace.
    }

    /// dmd/dinterpret.d:4821 — `override void visit(CommaExp e)`
    override visitCommaExp(e: CommaExp): void {
        /****************************************
         * Find the first non-comma expression.
         * Params:
         *      e = Expressions connected by commas
         * Returns:
         *      left-most non-comma expression
         */
        // dmd/dinterpret.d:4830 — `static inout(Expression) firstComma(inout Expression e)`: a nested
        // helper (04 §5); `inout` and the `cast()`/`cast(inout)` qualifier casts erase (04 §8).
        const firstComma = (e: Expression): Expression => {
            let ex = e;
            while (ex.op === EXP.comma)
                ex = ex.isCommaExp()!.e1!; // D `(cast(CommaExp)ex).e1`, tag-proved by the loop test
            return ex;

        };

        // dropped: `debug (LOG)` block (dinterpret.d:4839) — debug OFF (_config §3)

        // If it creates a variable, and there's no context for
        // the variable to be created in, we need to create one now.
        const istateComma = new InterState(); // `InterState istateComma;`

        // dmd/dinterpret.d:4853 — `void endTempStackFrame()`. Declared ahead of the `if` below (a nested
        // function declaration is inert) so the paired-state repair is in scope from the region's
        // first statement, `ctfeGlobals.stack.startFrame(null)` (11 §2.5 rule (c)).
        const endTempStackFrame = (): void => {
            // If we created a temporary stack frame, end it now.
            if (this.istate === istateComma)
                ctfeGlobals.stack.endFrame();
        };

        // Paired state (11 §2.5): `startFrame` here is released by `endTempStackFrame()` at three D lines
        // (4884, 4897, 4900), and every `interpret*` call in between reaches walls transitively (rule (a)):
        // catch-repair-rethrow, D's own release lines kept verbatim.
        try {
            if (this.istate === null && firstComma(e.e1!).op === EXP.declaration) {
                ctfeGlobals.stack.startFrame(null);
                this.istate = istateComma;
            }

            this.result = CTFEExp.cantexp!;

            // If the comma returns a temporary variable, it needs to be an lvalue
            // (this is particularly important for struct constructors)
            if (e.e1!.op === EXP.declaration &&
                e.e2!.op === EXP.variable &&
                e.e1!.isDeclarationExp()!.declaration === e.e2!.isVarExp()!.var_ &&
                (e.e2!.isVarExp()!.var_.storage_class & STC.ctfe) !== 0n) {
                const ve = e.e2!.isVarExp()!;
                const v = ve.var_.isVarDeclaration()!;
                ctfeGlobals.stack.push(v);
                if (v._init === null && getValue(v) === null) {
                    setValue(v, copyLiteral(defaultInitLiteral(v.type!, e.loc)!).copy());
                }
                if (getValue(v) === null) {
                    let newval = initializerToExpression(v._init!);
                    // Bug 4027. Copy constructors are a weird case where the
                    // initializer is a void function (the variable is modified
                    // through a reference parameter instead).
                    newval = interpretRegion(newval, this.istate);
                    if (this.exceptionOrCant(newval))
                        return endTempStackFrame();
                    if (newval!.op !== EXP.voidExpression) {
                        // v isn't necessarily null.
                        setValueWithoutChecking(v, copyLiteral(newval!).copy());
                    }
                }
            } else {
                const ue = new UnionExp(); // `UnionExp ue = void;`
                const e1 = interpret(ue, e.e1, this.istate, CTFEGoal.Nothing);
                if (this.exceptionOrCant(e1))
                    return endTempStackFrame();
            }
            this.result = interpret(this.pue, e.e2, this.istate, this.goal);
            return endTempStackFrame();
        } catch (ex) {
            endTempStackFrame(); // repair on a wall's exit path D does not have (11 §2.5)
            throw ex;
        }
    }

    /// dmd/dinterpret.d:4903 — `override void visit(CondExp e)`
    override visitCondExp(e: CondExp): void {
        // dropped: `debug (LOG)` block (dinterpret.d:4905) — debug OFF (_config §3)
        const uecond = new UnionExp(); // `UnionExp uecond = void;`
        let econd: Expression | null;
        econd = interpret(uecond, e.econd, this.istate);
        if (this.exceptionOrCant(econd))
            return;

        if (isPointer(e.econd!.type!)) {
            if (econd!.op !== EXP.null_) {
                econd = IntegerExp.createBool(true);
            }
        }

        if (isTrueBool(econd!)) {
            this.result = interpret(this.pue, e.e1, this.istate, this.goal);
            incUsageCtfe(this.istate, e.e1!.loc);
        } else if (toBool(econd!).hasValue(false)) {
            this.result = interpret(this.pue, e.e2, this.istate, this.goal);
            incUsageCtfe(this.istate, e.e2!.loc);
        } else {
            error(e.loc, ds("`%s` does not evaluate to boolean result at compile time"), e.econd!.toChars());
            this.result = CTFEExp.cantexp!;
        }
    }

    /// dmd/dinterpret.d:4940 — `override void visit(ArrayLengthExp e)`
    override visitArrayLengthExp(e: ArrayLengthExp): void {
        // dropped: `debug (LOG)` block (dinterpret.d:4942) — debug OFF (_config §3)
        const ue1 = new UnionExp(); // `UnionExp ue1;`
        const e1 = interpret(ue1, e.e1, this.istate);
        assert(e1);
        if (this.exceptionOrCant(e1))
            return;
        if (e1.op !== EXP.string_ && e1.op !== EXP.arrayLiteral && e1.op !== EXP.slice && e1.op !== EXP.null_) {
            error(e.loc, ds("`%s` cannot be evaluated at compile time"), e.toChars());
            this.result = CTFEExp.cantexp!;
            return;
        }
        this.pue.emplace(new IntegerExp(e.loc, resolveArrayLength(e1), e.type!));
        this.result = this.pue.exp();
    }

    /**
     * dmd/dinterpret.d:4969 — `static Expression interpretVectorToArray(UnionExp* pue, VectorExp e)`
     *
     * Interpret the vector expression as an array literal.
     * Params:
     *    pue = non-null pointer to temporary storage that can be used to store the return value
     *    e = Expression to interpret
     * Returns:
     *    resulting array literal or 'e' if unable to interpret
     */
    static interpretVectorToArray(pue: UnionExp, e: VectorExp): Expression {
        const ale = e.e1!.isArrayLiteralExp();
        if (ale !== null)
            return ale;         // it's already an array literal
        if (e.e1!.op === EXP.int64 || e.e1!.op === EXP.float64) {
            // Convert literal __vector(int) -> __vector([array])
            const elements = new DArray<Expression | null>(e.dim);
            for (let i = 0; i < elements.length; i++) // `foreach (ref element; *elements)` writes each slot (03 §4)
                elements.opIndexAssign(copyLiteral(e.e1!).copy(), i);
            const type = (e.type!.ty === TY.Tvector) ? e.type!.isTypeVector()!.basetype : e.type!.isTypeSArray();
            assert(type);
            pue.emplace(new ArrayLiteralExp(e.loc, type, elements));
            const ale = pue.exp().isArrayLiteralExp()!;
            ale.ownedByCtfe = OwnedBy.ctfe;
            return ale;
        }
        return e;
    }

    /// dmd/dinterpret.d:4989 — `override void visit(VectorExp e)`
    override visitVectorExp(e: VectorExp): void {
        // dropped: `debug (LOG)` block (dinterpret.d:4991) — debug OFF (_config §3)
        if (e.ownedByCtfe >= OwnedBy.ctfe) { // We've already interpreted all the elements
            this.result = e;
            return;
        }
        let e1 = interpret(this.pue, e.e1, this.istate);
        assert(e1);
        if (this.exceptionOrCant(e1))
            return;
        if (e1.op !== EXP.arrayLiteral && e1.op !== EXP.int64 && e1.op !== EXP.float64) {
            error(e.loc, ds("`%s` cannot be evaluated at compile time"), e.toChars());
            this.result = CTFEExp.cantexp!;
            return;
        }
        if (e1 === this.pue.exp())
            e1 = this.pue.copy();
        this.pue.emplace(new VectorExp(e.loc, e1, e.to!));
        const ve = this.pue.exp().isVectorExp()!;
        ve.type = e.type;
        ve.dim = e.dim;
        ve.ownedByCtfe = OwnedBy.ctfe;
        this.result = ve;
    }

    /// dmd/dinterpret.d:5020 — `override void visit(VectorArrayExp e)`
    override visitVectorArrayExp(e: VectorArrayExp): void {
        // dropped: `debug (LOG)` block (dinterpret.d:5022) — debug OFF (_config §3)
        const e1 = interpret(this.pue, e.e1, this.istate);
        assert(e1);
        if (this.exceptionOrCant(e1))
            return;
        const ve = e1.isVectorExp();
        if (ve !== null) {
            this.result = Interpreter.interpretVectorToArray(this.pue, ve);
            if (this.result.op !== EXP.vector)
                return;
        }
        error(e.loc, ds("`%s` cannot be evaluated at compile time"), e.toChars());
        this.result = CTFEExp.cantexp!;
    }

    /// dmd/dinterpret.d:5040 — `override void visit(DelegatePtrExp e)`
    override visitDelegatePtrExp(e: DelegatePtrExp): void {
        // dropped: `debug (LOG)` block (dinterpret.d:5042) — debug OFF (_config §3)
        const e1 = interpret(this.pue, e.e1, this.istate);
        assert(e1);
        if (this.exceptionOrCant(e1))
            return;
        error(e.loc, ds("`%s` cannot be evaluated at compile time"), e.toChars());
        this.result = CTFEExp.cantexp!;
    }

    /// dmd/dinterpret.d:5054 — `override void visit(DelegateFuncptrExp e)`
    override visitDelegateFuncptrExp(e: DelegateFuncptrExp): void {
        // dropped: `debug (LOG)` block (dinterpret.d:5056) — debug OFF (_config §3)
        const e1 = interpret(this.pue, e.e1, this.istate);
        assert(e1);
        if (this.exceptionOrCant(e1))
            return;
        error(e.loc, ds("`%s` cannot be evaluated at compile time"), e.toChars());
        this.result = CTFEExp.cantexp!;
    }

    /**
     * dmd/dinterpret.d:5068 — `static bool resolveIndexing(IndexExp e, InterState* istate, Expression* pagg,`
     *
     * `Expression* pagg` / `uinteger_t* pidx` are out-slots -> `Ref` boxes (03 §7.2). Every `uinteger_t` /
     * `dinteger_t` local reads the signed-normalized bigint carrier as UNSIGNED 64-bit (`toUint64`,
     * 09 §3.1): D compares and adds them as `ulong`.
     */
    static resolveIndexing(e: IndexExp, istate: InterState | null, pagg: Ref<Expression | null>,
                           pidx: Ref<uinteger_t>, modify: boolean): boolean {
        assert(toBasetype(e.e1!.type!).ty !== TY.Taarray);

        if (toBasetype(e.e1!.type!).ty === TY.Tpointer) {
            // Indexing a pointer. Note that there is no $ in this case.
            const e1 = interpretRegion(e.e1, istate);
            if (exceptionOrCantInterpret(e1))
                return false;

            const e2 = interpretRegion(e.e2, istate);
            if (exceptionOrCantInterpret(e2))
                return false;
            const indx: sinteger_t = toInt64(toInteger(e2!));

            const ofs: Ref<dinteger_t> = { value: 0n }; // `dinteger_t ofs;` passed as `&ofs`
            const agg = getAggregateFromPointer(e1!, ofs);

            // Pointer to a non-array variable
            if (agg.op === EXP.symbolOffset) {
                error(e.loc, ds("mutable variable `%s` cannot be %s at compile time, even through a pointer"),
                    ds(modify ? "modified" : "read"), agg.isSymOffExp()!.var_.toChars());
                return false;
            }

            // `ofs + indx`: ulong + long -> ulong (D usual arithmetic conversions)
            if (agg.op === EXP.arrayLiteral || agg.op === EXP.string_) {
                const len: dinteger_t = toUint64(resolveArrayLength(agg));
                if (toUint64(ofs.value + indx) >= len) {
                    error(e.loc, ds("pointer index `[%lld]` exceeds allocated memory block `[0..%lld]`"),
                        toInt64(ofs.value + indx), toInt64(len));
                    return false;
                }
            } else {
                // agg is the value accessed, it is not dereferenced again, so offset 0 is always ok
                if (toUint64(ofs.value + indx) !== 0n) {
                    if (agg.op === EXP.null_)
                        error(e.loc, ds("cannot index through null pointer `%s`"), e.e1!.toChars());
                    else if (agg.op === EXP.int64)
                        error(e.loc, ds("cannot index through invalid pointer `%s` of value `%s`"),
                            e.e1!.toChars(), e1!.toChars());
                    else
                        error(e.loc, ds("pointer index `[%lld]` lies outside memory block `[0..1]`"),
                            toInt64(ofs.value + indx));
                    return false;
                }
            }
            pagg.value = agg;
            pidx.value = toUint64(ofs.value + indx);
            return true;
        }

        let e1 = interpretRegion(e.e1, istate);
        if (exceptionOrCantInterpret(e1))
            return false;
        if (e1!.op === EXP.null_) {
            error(e.loc, ds("cannot index null array `%s`"), e.e1!.toChars());
            return false;
        }
        const ve = e1!.isVectorExp();
        if (ve !== null) {
            const ue = new UnionExp(); // `UnionExp ue = void;`
            e1 = Interpreter.interpretVectorToArray(ue, ve);
            e1 = (e1 === ue.exp()) ? ue.copy() : e1;
        }

        // Set the $ variable, and find the array literal to modify
        let len: dinteger_t;
        if (e1!.op === EXP.variable && toBasetype(e1!.type!).ty === TY.Tsarray)
            len = toUint64(toInteger(toBasetype(e1!.type!).isTypeSArray()!.dim!));
        else {
            if (e1!.op !== EXP.arrayLiteral && e1!.op !== EXP.string_ && e1!.op !== EXP.slice &&
                e1!.op !== EXP.vector) {
                error(e.loc, ds("cannot determine length of `%s` at compile time"), e.e1!.toChars());
                return false;
            }
            len = toUint64(resolveArrayLength(e1!));
        }

        // Paired state (11 §2.5): D releases the `$` push at ONE line (D:5159) with no early exit in between, so the
        // release moves into `finally` (single-release form); catch-repair-rethrow is kept only where D releases at
        // several lines (visitSliceExp, visitCommaExp) or where D's early returns skip the release (interpretFunction).
        let e2: Expression | null;
        try {
            if (e.lengthVar !== null) {
                const dollarExp = ctfeEmplaceExp(() => new IntegerExp(e.loc, len, Type.tsize_t));
                ctfeGlobals.stack.push(e.lengthVar);
                setValue(e.lengthVar, dollarExp);
            }
            e2 = interpretRegion(e.e2, istate);
        } finally {
            if (e.lengthVar !== null)
                ctfeGlobals.stack.pop(e.lengthVar); // $ is defined only inside []
        }
        if (exceptionOrCantInterpret(e2))
            return false;
        if (e2!.op !== EXP.int64) {
            error(e.loc, ds("CTFE internal error: non-integral index `[%s]`"), e.e2!.toChars());
            return false;
        }

        const se = e1!.isSliceExp();
        if (se !== null) {
            // Simplify index of slice: agg[lwr..upr][indx] --> agg[indx']
            const index: uinteger_t = toUint64(toInteger(e2!));
            const ilwr: uinteger_t = toUint64(toInteger(se.lwr!));
            const iupr: uinteger_t = toUint64(toInteger(se.upr!));

            if (index > toUint64(iupr - ilwr)) {
                error(e.loc, ds("index %llu exceeds array length %llu"), index, toUint64(iupr - ilwr));
                return false;
            }
            pagg.value = e1!.isSliceExp()!.e1;
            pidx.value = toUint64(index + ilwr);
        } else {
            pagg.value = e1;
            pidx.value = toUint64(toInteger(e2!));
            if (len <= pidx.value) {
                error(e.loc, ds("array index %lld is out of bounds `[0..%lld]`"), toInt64(pidx.value), toInt64(len));
                return false;
            }
        }
        return true;
    }

    /// dmd/dinterpret.d:5196 — `override void visit(IndexExp e)`
    override visitIndexExp(e: IndexExp): void {
        // dropped: `debug (LOG)` block (dinterpret.d:5198) — debug OFF (_config §3)
        if (toBasetype(e.e1!.type!).ty === TY.Tpointer) {
            const agg: Ref<Expression | null> = { value: null }; // `Expression agg;` passed as `&agg`
            const indexToAccess: Ref<uinteger_t> = { value: 0n }; // `uinteger_t indexToAccess;`
            if (!Interpreter.resolveIndexing(e, this.istate, agg, indexToAccess, false)) {
                this.result = CTFEExp.cantexp!;
                return;
            }
            if (agg.value!.op === EXP.arrayLiteral || agg.value!.op === EXP.string_) {
                if (this.goal === CTFEGoal.LValue) {
                    // if we need a reference, IndexExp shouldn't be interpreting
                    // the expression to a value, it should stay as a reference
                    this.pue.emplace(new IndexExp(e.loc, agg.value,
                        ctfeEmplaceExp(() => new IntegerExp(e.e2!.loc, indexToAccess.value, e.e2!.type!))));
                    this.result = this.pue.exp();
                    this.result.type = e.type;
                    return;
                }
                this.result = ctfeIndex(this.pue, e.loc, e.type!, agg.value!, indexToAccess.value);
                return;
            } else {
                assert(indexToAccess.value === 0n);
                this.result = interpretRegion(agg.value, this.istate, this.goal);
                if (this.exceptionOrCant(this.result))
                    return;
                this.result = paintTypeOntoLiteral(this.pue, e.type!, this.result!);
                return;
            }
        }

        if (toBasetype(e.e1!.type!).ty === TY.Taarray) {
            assertUnreachable("indexing AA should have been lowered in semantic analysis");
        }

        const agg: Ref<Expression | null> = { value: null }; // `Expression agg;` passed as `&agg`
        const indexToAccess: Ref<uinteger_t> = { value: 0n }; // `uinteger_t indexToAccess;`
        if (!Interpreter.resolveIndexing(e, this.istate, agg, indexToAccess, false)) {
            this.result = CTFEExp.cantexp!;
            return;
        }

        if (this.goal === CTFEGoal.LValue) {
            const e2 = ctfeEmplaceExp(() => new IntegerExp(e.e2!.loc, indexToAccess.value, Type.tsize_t));
            this.pue.emplace(new IndexExp(e.loc, agg.value, e2));
            this.result = this.pue.exp();
            this.result.type = e.type;
            return;
        }

        this.result = ctfeIndex(this.pue, e.loc, e.type!, agg.value!, indexToAccess.value);
        if (this.exceptionOrCant(this.result))
            return;
        if (this.result.op === EXP.void_) {
            error(e.loc, ds("`%s` is used before initialized"), e.toChars());
            errorSupplemental(this.result.loc, ds("originally uninitialized here"));
            this.result = CTFEExp.cantexp!;
            return;
        }
        if (this.result === this.pue.exp())
            this.result = this.result.copy();
    }

    /// dmd/dinterpret.d:5272 — `override void visit(SliceExp e)`
    override visitSliceExp(e: SliceExp): void {
        // dropped: `debug (LOG)` block (dinterpret.d:5274) — debug OFF (_config §3)
        if (toBasetype(e.e1!.type!).ty === TY.Tpointer) {
            // Slicing a pointer. Note that there is no $ in this case.
            const e1 = interpretRegion(e.e1, this.istate);
            if (this.exceptionOrCant(e1))
                return;
            if (e1!.op === EXP.int64) {
                error(e.loc, ds("cannot slice invalid pointer `%s` of value `%s`"), e.e1!.toChars(), e1!.toChars());
                this.result = CTFEExp.cantexp!;
                return;
            }

            /* Evaluate lower and upper bounds of slice
             */
            let lwr = interpretRegion(e.lwr, this.istate);
            if (this.exceptionOrCant(lwr))
                return;
            let upr = interpretRegion(e.upr, this.istate);
            if (this.exceptionOrCant(upr))
                return;
            let ilwr: uinteger_t = toUint64(toInteger(lwr!));
            let iupr: uinteger_t = toUint64(toInteger(upr!));

            const ofs: Ref<dinteger_t> = { value: 0n }; // `dinteger_t ofs;` passed as `&ofs`
            const agg = getAggregateFromPointer(e1!, ofs);
            ilwr = toUint64(ilwr + ofs.value);
            iupr = toUint64(iupr + ofs.value);
            if (agg.op === EXP.null_) {
                if (iupr === ilwr) {
                    this.result = ctfeEmplaceExp(() => new NullExp(e.loc));
                    this.result.type = e.type;
                    return;
                }
                error(e.loc, ds("cannot slice null pointer `%s`"), e.e1!.toChars());
                this.result = CTFEExp.cantexp!;
                return;
            }
            if (agg.op === EXP.symbolOffset) {
                error(e.loc, ds("slicing pointers to static variables is not supported in CTFE"));
                this.result = CTFEExp.cantexp!;
                return;
            }
            if (agg.op !== EXP.arrayLiteral && agg.op !== EXP.string_) {
                error(e.loc, ds("pointer `%s` cannot be sliced at compile time (it does not point to an array)"),
                    e.e1!.toChars());
                this.result = CTFEExp.cantexp!;
                return;
            }
            assert(agg.op === EXP.arrayLiteral || agg.op === EXP.string_);
            const len: dinteger_t = toUint64(toInteger(ArrayLength(Type.tsize_t, agg).exp()));
            //Type *pointee = ((TypePointer *)agg.type)->next;
            if (sliceBoundsCheck(0n, len, ilwr, iupr)) {
                error(e.loc, ds("pointer slice `[%lld..%lld]` exceeds allocated memory block `[0..%lld]`"),
                    toInt64(ilwr), toInt64(iupr), toInt64(len));
                this.result = CTFEExp.cantexp!;
                return;
            }
            if (ofs.value !== 0n) {
                lwr = ctfeEmplaceExp(() => new IntegerExp(e.loc, ilwr, lwr!.type!));
                upr = ctfeEmplaceExp(() => new IntegerExp(e.loc, iupr, upr!.type!));
            }
            this.pue.emplace(new SliceExp(e.loc, agg, lwr, upr));
            this.result = this.pue.exp();
            this.result.type = e.type;
            return;
        }

        let goal1: CTFEGoal = CTFEGoal.RValue;
        if (this.goal === CTFEGoal.LValue) {
            if (toBasetype(e.e1!.type!).ty === TY.Tsarray) {
                const ve = e.e1!.isVarExp();
                if (ve !== null) {
                    const vd = ve.var_.isVarDeclaration();
                    if (vd !== null)
                        if ((vd.storage_class & STC.ref_) !== 0n)
                            goal1 = CTFEGoal.LValue;
                }
            }
        }
        let e1 = interpretNoPue(e.e1, this.istate, goal1);
        if (this.exceptionOrCant(e1))
            return;

        if (e.lwr === null) {
            this.result = paintTypeOntoLiteral(this.pue, e.type!, e1!);
            return;
        }
        const ve = e1!.isVectorExp();
        if (ve !== null) {
            e1 = Interpreter.interpretVectorToArray(this.pue, ve);
            e1 = (e1 === this.pue.exp()) ? this.pue.copy() : e1;
        }

        /* Set dollar to the length of the array
         */
        let dollar: uinteger_t;
        if ((e1!.op === EXP.variable || e1!.op === EXP.dotVariable) && toBasetype(e1!.type!).ty === TY.Tsarray)
            dollar = toUint64(toInteger(toBasetype(e1!.type!).isTypeSArray()!.dim!));
        else {
            if (e1!.op !== EXP.arrayLiteral && e1!.op !== EXP.string_ && e1!.op !== EXP.null_ && e1!.op !== EXP.slice &&
                e1!.op !== EXP.vector) {
                error(e.loc, ds("cannot determine length of `%s` at compile time"), e1!.toChars());
                this.result = CTFEExp.cantexp!;
                return;
            }
            dollar = toUint64(resolveArrayLength(e1!));
        }

        // Paired state (11 §2.5): the `$` push below is released at three D lines (5405, 5412, 5416) and the
        // two `interpretRegion` calls in between reach walls transitively (rule (a)): catch-repair-rethrow,
        // opened on the region's first statement, D's own release lines kept verbatim.
        let lwr: Expression | null;
        let upr: Expression | null;
        try {
            /* Set the $ variable
             */
            if (e.lengthVar !== null) {
                const dollarExp = ctfeEmplaceExp(() => new IntegerExp(e.loc, dollar, Type.tsize_t));
                ctfeGlobals.stack.push(e.lengthVar);
                setValue(e.lengthVar, dollarExp);
            }

            /* Evaluate lower and upper bounds of slice
             */
            lwr = interpretRegion(e.lwr, this.istate);
            if (this.exceptionOrCant(lwr)) {
                if (e.lengthVar !== null)
                    ctfeGlobals.stack.pop(e.lengthVar);
                return;
            }
            upr = interpretRegion(e.upr, this.istate);
            if (this.exceptionOrCant(upr)) {
                if (e.lengthVar !== null)
                    ctfeGlobals.stack.pop(e.lengthVar);
                return;
            }
            if (e.lengthVar !== null)
                ctfeGlobals.stack.pop(e.lengthVar); // $ is defined only inside [L..U]
        } catch (ex) {
            if (e.lengthVar !== null)
                ctfeGlobals.stack.pop(e.lengthVar); // repair on a wall's exit path D does not have (11 §2.5)
            throw ex;
        }

        let ilwr: uinteger_t = toUint64(toInteger(lwr!));
        let iupr: uinteger_t = toUint64(toInteger(upr!));
        if (e1!.op === EXP.null_) {
            if (ilwr === 0n && iupr === 0n) {
                this.result = e1;
                return;
            }
            error(e1!.loc, ds("slice `[%llu..%llu]` is out of bounds"), ilwr, iupr);
            this.result = CTFEExp.cantexp!;
            return;
        }
        const se = e1!.isSliceExp();
        if (se !== null) {
            // Simplify slice of slice:
            //  aggregate[lo1..up1][lwr..upr] ---> aggregate[lwr'..upr']
            const lo1: uinteger_t = toUint64(toInteger(se.lwr!));
            const up1: uinteger_t = toUint64(toInteger(se.upr!));
            if (sliceBoundsCheck(0n, toUint64(up1 - lo1), ilwr, iupr)) {
                error(e.loc, ds("slice `[%llu..%llu]` exceeds array bounds `[0..%llu]`"),
                    ilwr, iupr, toUint64(up1 - lo1));
                this.result = CTFEExp.cantexp!;
                return;
            }
            ilwr = toUint64(ilwr + lo1);
            iupr = toUint64(iupr + lo1);
            this.pue.emplace(new SliceExp(e.loc, se.e1,
                ctfeEmplaceExp(() => new IntegerExp(e.loc, ilwr, lwr!.type!)),
                ctfeEmplaceExp(() => new IntegerExp(e.loc, iupr, upr!.type!))));
            this.result = this.pue.exp();
            this.result.type = e.type;
            return;
        }
        if (e1!.op === EXP.arrayLiteral || e1!.op === EXP.string_) {
            if (sliceBoundsCheck(0n, dollar, ilwr, iupr)) {
                error(e.loc, ds("slice `[%lld..%lld]` exceeds array bounds `[0..%lld]`"),
                    toInt64(ilwr), toInt64(iupr), toInt64(dollar));
                this.result = CTFEExp.cantexp!;
                return;
            }
        }
        this.pue.emplace(new SliceExp(e.loc, e1, lwr, upr));
        this.result = this.pue.exp();
        this.result.type = e.type;
    }

    /// dmd/dinterpret.d:5466 — `override void visit(CatExp e)`
    override visitCatExp(e: CatExp): void {
        // dropped: `debug (LOG)` block (dinterpret.d:5468) — debug OFF (_config §3)

        const ue1 = new UnionExp(); // `UnionExp ue1 = void;`
        let e1 = interpret(ue1, e.e1, this.istate);
        if (this.exceptionOrCant(e1))
            return;

        const ue2 = new UnionExp(); // `UnionExp ue2 = void;`
        let e2 = interpret(ue2, e.e2, this.istate);
        if (this.exceptionOrCant(e2))
            return;

        const e1tmp = new UnionExp(); // `UnionExp e1tmp = void;`
        e1 = resolveSlice(e1!, e1tmp);

        const e2tmp = new UnionExp(); // `UnionExp e2tmp = void;`
        e2 = resolveSlice(e2!, e2tmp);

        /* e1 and e2 can't go on the stack because of x~[y] and [x]~y will
         * result in [x,y] and then x or y is on the stack.
         * But if they are both strings, we can, because it isn't the x~[y] case.
         */
        if (!(e1.op === EXP.string_ && e2.op === EXP.string_)) {
            if (e1 === ue1.exp())
                e1 = ue1.copy();
            if (e2 === ue2.exp())
                e2 = ue2.copy();
        }

        // dmd/dinterpret.d:5501 — `Expression prepareCatOperand(Expression exp)`: nested helper (04 §5)
        const prepareCatOperand = (exp: Expression): Expression => {
            /* Convert `elem ~ array` to `[elem] ~ array` if `elem` is itself an
             * array. This is needed because interpreting the `CatExp` calls
             * `Cat()`, which cannot handle concatenations between different
             * types, except for strings and chars.
             */
            const tb = toBasetype(e.type!);
            const tbNext = nextOf(tb);
            const expTb = toBasetype(exp.type!);

            if (implicitConvToType(exp.type!, tbNext!) >= MATCH.convert &&
                tb.isStaticOrDynamicArray() && expTb.isStaticOrDynamicArray())
                return ArrayLiteralExp.fromExp(exp.loc, e.type, exp); // `new ArrayLiteralExp(exp.loc, e.type, exp)`
            return exp;
        };

        // `*pue = ctfeCat(...)` -> `pue.emplace(<call>.exp())` (02 §11.1)
        this.pue.emplace(ctfeCat(e.loc, e.type!, prepareCatOperand(e1), prepareCatOperand(e2)).exp());
        this.result = this.pue.exp();

        if (CTFEExp.isCantExp(this.result)) {
            error(e.loc, ds("`%s` cannot be interpreted at compile time"), e.toChars());
            return;
        }
        // We know we still own it, because we interpreted both e1 and e2
        const ale = this.result.isArrayLiteralExp();
        if (ale !== null) {
            ale.ownedByCtfe = OwnedBy.ctfe;

            // https://issues.dlang.org/show_bug.cgi?id=14686
            for (const elem of ale.elements!) {
                const ex = evaluatePostblit(this.istate, elem!);
                if (this.exceptionOrCant(ex))
                    return;
            }
        } else {
            const se = this.result.isStringExp();
            if (se !== null)
                se.ownedByCtfe = OwnedBy.ctfe;
        }
    }

    /// dmd/dinterpret.d:5543 — `override void visit(DeleteExp e)`
    override visitDeleteExp(e: DeleteExp): void {
        // dropped: `debug (LOG)` block (dinterpret.d:5545) — debug OFF (_config §3)
        this.result = interpretRegion(e.e1, this.istate);
        if (this.exceptionOrCant(this.result))
            return;

        if (this.result!.op === EXP.null_) {
            this.result = CTFEExp.voidexp!;
            return;
        }

        const tb = toBasetype(e.e1!.type!);
        switch (tb.ty) {
            case TY.Tclass: {
                if (this.result!.op !== EXP.classReference) {
                    error(e.loc, ds("`delete` on invalid class reference `%s`"), this.result!.toChars());
                    this.result = CTFEExp.cantexp!;
                    return;
                }

                const cre = this.result!.isClassReferenceExp()!;
                let cd = cre.originalClass();

                // Find dtor(s) in inheritance chain
                do {
                    if (cd!.dtor !== null) {
                        this.result = interpretFunction(this.pue, cd!.dtor, this.istate, null, cre);
                        if (this.exceptionOrCant(this.result))
                            return;

                        // Dtors of Non-extern(D) classes use implicit chaining (like structs)
                        // hoisted: fn-local `import dmd.aggregate : ClassKind;` (dinterpret.d:5583) -> module import
                        if (cd!.classKind !== ClassKind.d)
                            break;
                    }

                    // Emulate manual chaining as done in rt_finalize2
                    cd = cd!.baseClass;

                } while (cd !== null); // Stop after Object

                break;
            }

            default:
                assertUnreachable();
        }
        this.result = CTFEExp.voidexp!;
    }

    /// dmd/dinterpret.d:5601 — `override void visit(CastExp e)`
    override visitCastExp(e: CastExp): void {
        // dropped: `debug (LOG)` block (dinterpret.d:5603) — debug OFF (_config §3)
        let e1 = interpretRegion(e.e1, this.istate, this.goal);
        if (this.exceptionOrCant(e1))
            return;
        // If the expression has been cast to void, do nothing.
        if (e.to!.ty === TY.Tvoid) {
            this.result = CTFEExp.voidexp!;
            return;
        }
        if (e.to!.ty === TY.Tpointer && e1!.op !== EXP.null_) {
            // D `(cast(TypePointer)e.type).next`: the cast's own type is the pointer `e.to` tested above
            const pointee = e.type!.isTypePointer()!.next!;
            // Implement special cases of normally-unsafe casts
            if (e1!.op === EXP.int64) {
                // Happens with Windows HANDLEs, for example.
                this.result = paintTypeOntoLiteral(this.pue, e.to!, e1!);
                return;
            }

            let castToSarrayPointer = false;
            let castBackFromVoid = false;
            if (e1!.type!.isStaticOrDynamicArray() || e1!.type!.ty === TY.Tpointer) {
                // Check for unsupported type painting operations
                // For slices, we need the type being sliced,
                // since it may have already been type painted
                let elemtype = nextOf(e1!.type!)!;
                const se = e1!.isSliceExp();
                if (se !== null)
                    elemtype = nextOf(se.e1!.type!)!;

                // Allow casts from X* to void *, and X** to void** for any X.
                // But don't allow cast from X* to void**.
                // So, we strip all matching * from source and target to find X.
                // Allow casts to X* from void* only if the 'void' was originally an X;
                // we check this later on.
                let ultimatePointee = pointee;
                let ultimateSrc = elemtype;
                while (ultimatePointee.ty === TY.Tpointer && ultimateSrc.ty === TY.Tpointer) {
                    ultimatePointee = nextOf(ultimatePointee)!;
                    ultimateSrc = nextOf(ultimateSrc)!;
                }
                if (ultimatePointee.ty === TY.Tsarray && equivalent(nextOf(ultimatePointee)!, ultimateSrc)) {
                    castToSarrayPointer = true;
                } else if (ultimatePointee.ty !== TY.Tvoid && ultimateSrc.ty !== TY.Tvoid &&
                    !isSafePointerCast(elemtype, pointee)) {
                    error(e.loc, ds("reinterpreting cast from `%s*` to `%s*` is not supported in CTFE"),
                        elemtype.toChars(), pointee.toChars());
                    this.result = CTFEExp.cantexp!;
                    return;
                }
                if (ultimateSrc.ty === TY.Tvoid)
                    castBackFromVoid = true;
            }

            const se = e1!.isSliceExp();
            if (se !== null) {
                if (se.e1!.op === EXP.null_) {
                    this.result = paintTypeOntoLiteral(this.pue, e.type!, se.e1!);
                    return;
                }
                // Create a CTFE pointer &aggregate[1..2]
                const ei = ctfeEmplaceExp(() => new IndexExp(e.loc, se.e1, se.lwr));
                ei.type = nextOf(e.type!);
                this.pue.emplace(new AddrExp(e.loc, ei, e.type));
                this.result = this.pue.exp();
                return;
            }
            if (e1!.op === EXP.arrayLiteral || e1!.op === EXP.string_) {
                // Create a CTFE pointer &[1,2,3][0] or &"abc"[0]
                const ei = ctfeEmplaceExp(() =>
                    new IndexExp(e.loc, e1, ctfeEmplaceExp(() => new IntegerExp(e.loc, 0n, Type.tsize_t))));
                ei.type = nextOf(e.type!);
                this.pue.emplace(new AddrExp(e.loc, ei, e.type));
                this.result = this.pue.exp();
                return;
            }
            if (e1!.op === EXP.index && !e1!.isIndexExp()!.e1!.type!.equals(e1!.type)) {
                // type painting operation
                const ie = e1!.isIndexExp()!;
                if (castBackFromVoid) {
                    // get the original type. For strings, it's just the type...
                    let origType = nextOf(ie.e1!.type!)!;
                    // ..but for arrays of type void*, it's the type of the element
                    if (ie.e1!.op === EXP.arrayLiteral && ie.e2!.op === EXP.int64) {
                        const ale = ie.e1!.isArrayLiteralExp()!;
                        // `cast(size_t)ie.e2.toInteger()`: into the index domain (09 §1.1), as the tree does
                        // (ctfeexpr.ts:291); a value past 2^53 still compares >= every length, as in D
                        const indx = Number(toUint64(toInteger(ie.e2!)));
                        if (indx < ale.elements!.length) {
                            const xx = ale.elements!.opIndex(indx);
                            if (xx !== null) {
                                const iex = xx.isIndexExp();
                                if (iex !== null)
                                    origType = nextOf(iex.e1!.type!)!;
                                else {
                                    const ae = xx.isAddrExp();
                                    if (ae !== null)
                                        origType = ae.e1!.type!;
                                    else {
                                        const ve = xx.isVarExp();
                                        if (ve !== null)
                                            origType = ve.var_.type!;
                                    }
                                }
                            }
                        }
                    }
                    if (!isSafePointerCast(origType, pointee)) {
                        error(e.loc,
                            ds("using `void*` to reinterpret cast from `%s*` to `%s*` is not supported in CTFE"),
                            origType.toChars(), pointee.toChars());
                        this.result = CTFEExp.cantexp!;
                        return;
                    }
                }
                this.pue.emplace(new IndexExp(e1!.loc, ie.e1, ie.e2));
                this.result = this.pue.exp();
                this.result.type = e.type;
                return;
            }

            const ae = e1!.isAddrExp();
            if (ae !== null) {
                const origType = ae.e1!.type!;
                if (isSafePointerCast(origType, pointee)) {
                    this.pue.emplace(new AddrExp(e.loc, ae.e1, e.type));
                    this.result = this.pue.exp();
                    return;
                }

                if (castToSarrayPointer && toBasetype(pointee).ty === TY.Tsarray && ae.e1!.op === EXP.index) {
                    // &val[idx]
                    // D `(cast(TypeSArray)pointee.toBasetype())`, tag-proved by the `Tsarray` test on this `if`
                    const dim: dinteger_t = toInteger(toBasetype(pointee).isTypeSArray()!.dim!);
                    const ie = ae.e1!.isIndexExp()!;
                    const lwr = ie.e2;
                    // ulong addition; IntegerExp's constructor normalizes to `size_t`
                    const upr = ctfeEmplaceExp(() => new IntegerExp(ie.e2!.loc, toInteger(ie.e2!) + dim, Type.tsize_t));

                    // Create a CTFE pointer &val[idx..idx+dim]
                    const er = ctfeEmplaceExp(() => new SliceExp(e.loc, ie.e1, lwr, upr));
                    er.type = pointee;
                    this.pue.emplace(new AddrExp(e.loc, er, e.type));
                    this.result = this.pue.exp();
                    return;
                }
            }

            if (e1!.op === EXP.variable || e1!.op === EXP.symbolOffset) {
                // type painting operation
                // D `(cast(SymbolExp)e1)` — tag-proved downcast (02 §11.5c item 3): the tag set
                // {variable, symbolOffset} tested on this `if` proves a SymbolExp (VarExp / SymOffExp)
                const origType = (e1 as unknown as SymbolExp).var_.type!;
                if (castBackFromVoid && !isSafePointerCast(origType, pointee)) {
                    error(e.loc, ds("using `void*` to reinterpret cast from `%s*` to `%s*` is not supported in CTFE"),
                        origType.toChars(), pointee.toChars());
                    this.result = CTFEExp.cantexp!;
                    return;
                }
                const ve = e1!.isVarExp();
                if (ve !== null)
                    this.pue.emplace(new VarExp(e.loc, ve.var_));
                else
                    this.pue.emplace(new SymOffExp(e.loc, e1!.isSymOffExp()!.var_, e1!.isSymOffExp()!.offset));
                this.result = this.pue.exp();
                this.result.type = e.to;
                return;
            }

            // Check if we have a null pointer (eg, inside a struct)
            e1 = interpretRegion(e1, this.istate);
            if (e1!.op !== EXP.null_) {
                error(e.loc, ds("pointer cast from `%s` to `%s` is not supported at compile time"),
                    e1!.type!.toChars(), e.to!.toChars());
                this.result = CTFEExp.cantexp!;
                return;
            }
        }
        if (e.to!.ty === TY.Tsarray && e.e1!.type!.ty === TY.Tvector) {
            // Special handling for: cast(float[4])__vector([w, x, y, z])
            e1 = interpretRegion(e.e1, this.istate);
            if (this.exceptionOrCant(e1))
                return;
            assert(e1!.op === EXP.vector);
            e1 = Interpreter.interpretVectorToArray(this.pue, e1!.isVectorExp()!);
        }
        if (e.to!.ty === TY.Tarray && e1!.op === EXP.slice) {
            // Note that the slice may be void[], so when checking for dangerous
            // casts, we need to use the original type, which is se.e1.
            const se = e1!.isSliceExp()!;
            if (!isSafePointerCast(nextOf(se.e1!.type!)!, nextOf(e.to!)!)) {
                error(e.loc, ds("array cast from `%s` to `%s` is not supported at compile time"),
                    se.e1!.type!.toChars(), e.to!.toChars());
                this.result = CTFEExp.cantexp!;
                return;
            }
            this.pue.emplace(new SliceExp(e1!.loc, se.e1, se.lwr, se.upr));
            this.result = this.pue.exp();
            this.result.type = e.to;
            return;
        }

        // Disallow array type painting, except for conversions between built-in
        // types of identical size.
        if (e.to!.isStaticOrDynamicArray() && e1!.type!.isStaticOrDynamicArray() &&
            !isSafePointerCast(nextOf(e1!.type!)!, nextOf(e.to!)!)) {
            const se = e1!.isStringExp();
            // Allow casting a hex string literal to short[], int[] or long[]
            if (se !== null && se.hexString && se.postfix === StringExp_NoPostfix && isIntegral(nextOf(e.to!)!)) {
                // `cast(size_t) e.to.nextOf().size`: the element type was just tested integral, so the size is
                // 1, 2, 4 or 8 and never the SIZE_INVALID sentinel (09 §1.3.1)
                const sz = Number(size(nextOf(e.to!)!));
                if ((se.len % sz) !== 0) {
                    error(e.loc, ds("hex string length %d must be a multiple of %d to cast to `%s`"),
                        toInt32(se.len), toInt32(sz), e.to!.toChars());
                    this.result = CTFEExp.cantexp!;
                    return;
                }

                const str = arrayCastBigEndian(se.peekData(), sz);
                // `se.len / sz`: size_t division, exact (the remainder was just checked to be 0)
                this.pue.emplace(new StringExp(e1!.loc, Array.from(str), Math.trunc(se.len / sz), toUint8(sz)));
                this.result = this.pue.exp();
                this.result.type = e.to;
                return;
            }
            error(e.loc, ds("array cast from `%s` to `%s` is not supported at compile time"),
                e1!.type!.toChars(), e.to!.toChars());
            if (se !== null && se.hexString && se.postfix !== StringExp_NoPostfix)
                // `%.*s` of `1, &se.postfix`: the one postfix byte as a DString
                errorSupplemental(e.loc, ds("perhaps remove postfix `%.*s` from hex string"), 1,
                    Uint8Array.of(se.postfix));

            this.result = CTFEExp.cantexp!;
            return;
        }
        if (e.to!.ty === TY.Tsarray)
            e1 = resolveSlice(e1!);

        const tobt = toBasetype(e.to!);
        if (tobt.ty === TY.Tbool && e1!.type!.ty === TY.Tpointer) {
            this.pue.emplace(new IntegerExp(e.loc, e1!.op !== EXP.null_ ? 1n : 0n, e.to!)); // bool -> dinteger_t
            this.result = this.pue.exp();
            return;
        } else if (tobt.isTypeBasic() !== null && e1!.op === EXP.null_) {
            if (isIntegral(tobt))
                this.pue.emplace(new IntegerExp(e.loc, 0n, e.to!));
            else if (isReal(tobt))
                this.pue.emplace(new RealExp(e.loc, CTFloat.zero, e.to));
            this.result = this.pue.exp();
            return;
        }
        this.result = ctfeCast(this.pue, e.loc, e.type!, e.to!, e1!, true);
    }

    /// dmd/dinterpret.d:5859 — `override void visit(AssertExp e)`
    override visitAssertExp(e: AssertExp): void {
        // dropped: `debug (LOG)` block (dinterpret.d:5861) — debug OFF (_config §3)
        const e1 = interpret(this.pue, e.e1, this.istate);
        if (this.exceptionOrCant(e1))
            return;
        if (isTrueBool(e1!)) {
        } else if (toBool(e1!).hasValue(false)) {
            if (e.msg !== null) {
                const ue = new UnionExp(); // `UnionExp ue = void;`
                this.result = interpret(ue, e.msg, this.istate);
                if (this.exceptionOrCant(this.result))
                    return;
                this.result = scrubReturnValue(e.loc, this.result!);
                const se = toStringExp(this.result!);
                if (se !== null)
                    error(e.loc, ds("%s"), se.toStringz()); // `se.toStringz().ptr`
                else
                    error(e.loc, ds("%s"), this.result!.toChars());
            } else
                error(e.loc, ds("`%s` failed"), e.toChars());
            this.result = CTFEExp.cantexp!;
            return;
        } else {
            error(e.loc, ds("`%s` is not a compile time boolean expression"), e1!.toChars());
            this.result = CTFEExp.cantexp!;
            return;
        }
        this.result = e1;
        return;
    }

    /// dmd/dinterpret.d:5900 — `override void visit(ThrowExp te)`
    override visitThrowExp(te: ThrowExp): void {
        // dropped: `debug (LOG)` block (dinterpret.d:5902) — debug OFF (_config §3)
        // `ref Expression result` (dinterpret.d:6200) -> a Ref box over this.result, written back (03 §3.2)
        const result: Ref<Expression | null> = { value: this.result };
        interpretThrow(result, te.e1!, te.loc, this.istate);
        this.result = result.value;
    }

    /// dmd/dinterpret.d:5909 — `override void visit(PtrExp e)`
    override visitPtrExp(e: PtrExp): void {
        // Called for both lvalues and rvalues
        const lvalue = this.goal === CTFEGoal.LValue;
        // dropped: `debug (LOG)` block (dinterpret.d:5913) — debug OFF (_config §3)

        // Check for int<->float and long<->double casts.
        const soe1 = e.e1!.isSymOffExp();
        if (soe1 !== null)
            if (soe1.offset === 0n && soe1.var_.isVarDeclaration() !== null &&
                isFloatIntPaint(e.type!, soe1.var_.type!)) {
                // *(cast(int*)&v), where v is a float variable
                this.result = paintFloatInt(this.pue,
                    Interpreter.getVarExp(e.loc, this.istate, soe1.var_, CTFEGoal.RValue)!, e.type!);
                return;
            }

        const ce1 = e.e1!.isCastExp();
        if (ce1 !== null) {
            const ae11 = ce1.e1!.isAddrExp();
            if (ae11 !== null) {
                // *(cast(int*)&x), where x is a float expression
                const x = ae11.e1!;
                if (isFloatIntPaint(e.type!, x.type!)) {
                    this.result = paintFloatInt(this.pue, interpretRegion(x, this.istate)!, e.type!);
                    return;
                }
            }
        }

        // Constant fold *(&structliteral + offset)
        const ae = e.e1!.isAddExp();
        if (ae !== null) {
            if (ae.e1!.op === EXP.address && ae.e2!.op === EXP.int64) {
                const ade = ae.e1!.isAddrExp()!;
                const ex = interpretRegion(ade.e1, this.istate);
                if (this.exceptionOrCant(ex))
                    return;
                const se = ex!.isStructLiteralExp();
                if (se !== null) {
                    const offset: dinteger_t = toInteger(ae.e2!);
                    // `se.getField(e.type, cast(uint)offset)`: `cast(uint)` keeps the low 32 bits (09 §2)
                    this.result = getField(se, e.type!, Number(maskUnsignedN(32, offset)));
                    if (this.result !== null)
                        return;
                }
            }
        }

        // It's possible we have an array bounds error. We need to make sure it
        // errors with this line number, not the one where the pointer was set.
        this.result = interpretRegion(e.e1, this.istate);
        if (this.exceptionOrCant(this.result))
            return;

        if (this.result!.op === EXP.function_)
            return;
        const soe = this.result!.isSymOffExp();
        if (soe !== null) {
            if (soe.offset === 0n && soe.var_.isFuncDeclaration() !== null)
                return;
            if (soe.offset === 0n && soe.var_.isVarDeclaration() !== null && soe.var_.isImmutable()) {
                this.result = Interpreter.getVarExp(e.loc, this.istate, soe.var_, CTFEGoal.RValue);
                return;
            }
            error(e.loc, ds("cannot dereference pointer to static variable `%s` at compile time"), soe.var_.toChars());
            this.result = CTFEExp.cantexp!;
            return;
        }

        if (!lvalue && this.result!.isArrayLiteralExp() !== null &&
            this.result!.type!.isTypePointer() !== null) {
            /* A pointer variable can point to an array literal like `[3]`.
             * Dereferencing it means accessing the first element value.
             * Dereference it only if result should be an rvalue
             */
            const ae = this.result!.isArrayLiteralExp()!;
            if (ae.elements!.length === 1) {
                this.result = ae.elements!.opIndex(0);
                return;
            }
        }
        if (this.result!.isStringExp() !== null || this.result!.isArrayLiteralExp() !== null)
            return;

        if (this.result!.op !== EXP.address) {
            if (this.result!.op === EXP.null_)
                error(e.loc, ds("dereference of null pointer `%s`"), e.e1!.toChars());
            else
                error(e.loc, ds("dereference of invalid pointer `%s`"), this.result!.toChars());
            this.result = CTFEExp.cantexp!;
            return;
        }

        // *(&x) ==> x
        this.result = this.result!.isAddrExp()!.e1;

        if (this.result!.op === EXP.slice && toBasetype(e.type!).ty === TY.Tsarray) {
            /* aggr[lwr..upr]
             * upr may exceed the upper boundary of aggr, but the check is deferred
             * until those out-of-bounds elements will be touched.
             */
            return;
        }
        this.result = interpret(this.pue, this.result, this.istate, this.goal);
        if (this.exceptionOrCant(this.result))
            return;

        // dropped: `debug (LOG)` block (dinterpret.d:6022) — debug OFF (_config §3)
    }

    /// dmd/dinterpret.d:6029 — `override void visit(DotVarExp e)`
    override visitDotVarExp(e: DotVarExp): void {
        // dmd/dinterpret.d:6031 — `void notImplementedYet()`: nested helper (04 §5), writes this.result
        const notImplementedYet = (): void => {
            error(e.loc, ds("`%s.%s` is not yet implemented at compile time"), e.e1!.toChars(), e.var_.toChars());
            this.result = CTFEExp.cantexp!;
            return;
        };

        // dropped: `debug (LOG)` block (dinterpret.d:6038) — debug OFF (_config §3)
        const ex = interpretRegion(e.e1, this.istate);
        if (this.exceptionOrCant(ex))
            return;

        const f = e.var_.isFuncDeclaration();
        if (f !== null) {
            if (ex === e.e1)
                this.result = e; // optimize: reuse this CTFE reference
            else {
                this.pue.emplace(new DotVarExp(e.loc, ex, f, false));
                this.result = this.pue.exp();
                this.result.type = e.type;
            }
            return;
        }

        const v = e.var_.isVarDeclaration();
        if (v === null) {
            error(e.loc, ds("CTFE internal error: `%s`"), e.toChars());
            this.result = CTFEExp.cantexp!;
            return;
        }

        if (ex!.op === EXP.null_) {
            if (toBasetype(ex!.type!).ty === TY.Tclass)
                error(e.loc, ds("class `%s` is `null` and cannot be dereferenced"), e.e1!.toChars());
            else
                error(e.loc, ds("CTFE internal error: null this `%s`"), e.e1!.toChars());
            this.result = CTFEExp.cantexp!;
            return;
        }

        let se: StructLiteralExp | null = null; // `StructLiteralExp se;`
        let i = 0; // `int i;`

        if (ex!.op !== EXP.structLiteral && ex!.op !== EXP.classReference && ex!.op !== EXP.typeid_) {
            return notImplementedYet();
        }

        // We can't use getField, because it makes a copy
        if (ex!.op === EXP.classReference) {
            se = ex!.isClassReferenceExp()!.value;
            i = ex!.isClassReferenceExp()!.findFieldIndexByName(v);
        } else if (ex!.op === EXP.typeid_) {
            if (v.ident === Identifier.idPool(ds("name"))) {
                const t = isType(ex!.isTypeidExp()!.obj);
                if (t !== null) {
                    // hoisted: fn-local `import dmd.typesem : toDsymbol;` (dinterpret.d:6097) -> module import
                    const sym = toDsymbol(t, null);
                    const ident = (sym !== null ? sym.ident : null);
                    if (ident !== null) {
                        this.result = new StringExp(e.loc, Array.from(ident.toString()));
                        // D discards the returned expression: `result.expressionSemantic(null);`
                        expressionSemantic(this.result, null);
                        return ;
                    }
                }
            }
            return notImplementedYet();
        } else {
            se = ex!.isStructLiteralExp();
            i = findFieldIndexByName(se!.sd!, v);
        }
        if (i === -1) {
            error(e.loc, ds("couldn't find field `%s` of type `%s` in `%s`"),
                v.toChars(), e.type!.toChars(), se!.toChars());
            this.result = CTFEExp.cantexp!;
            return;
        }

        // https://issues.dlang.org/show_bug.cgi?id=19897
        // https://issues.dlang.org/show_bug.cgi?id=20710
        // Zero-elements fields don't have an initializer. See: scrubArray function
        if (se!.elements!.opIndex(i) === null)
            se!.elements!.opIndexAssign(voidInitLiteral(e.type!, v).copy(), i);

        if (this.goal === CTFEGoal.LValue) {
            // just return the (simplified) dotvar expression as a CTFE reference
            if (e.e1 === ex)
                this.result = e;
            else {
                this.pue.emplace(new DotVarExp(e.loc, ex, v));
                this.result = this.pue.exp();
                this.result.type = e.type;
            }
            return;
        }

        this.result = se!.elements!.opIndex(i);
        if (this.result === null) {
            error(e.loc, ds("internal compiler error: null field `%s`"), v.toChars());
            this.result = CTFEExp.cantexp!;
            return;
        }
        const vie = this.result.isVoidInitExp();
        if (vie !== null) {
            const s = vie.var_.toChars();
            if (v.overlapped) {
                error(e.loc, ds("reinterpretation through overlapped field `%s` is not allowed in CTFE"), s);
                this.result = CTFEExp.cantexp!;
                return;
            }
            error(e.loc, ds("cannot read uninitialized variable `%s` in CTFE"), s);
            this.result = CTFEExp.cantexp!;
            return;
        }

        if (v.type!.ty !== this.result.type!.ty && v.type!.ty === TY.Tsarray) {
            // Block assignment from inside struct literals
            const tsa = v.type!.isTypeSArray()!; // D `cast(TypeSArray)v.type`, tag-proved by the `Tsarray` test above
            // `cast(size_t)tsa.dim.toInteger()`: into the index domain (09 §1.1), as ctfeexpr.ts:291 does
            const len = Number(toInteger(tsa.dim!));
            const ue = new UnionExp(); // `UnionExp ue = void;`
            this.result = createBlockDuplicatedArrayLiteral(ue, e.loc, v.type!, this.result, len);
            if (this.result === ue.exp())
                this.result = ue.copy();
            se!.elements!.opIndexAssign(this.result, i);
        }
        // dropped: `debug (LOG)` block (dinterpret.d:6173) — debug OFF (_config §3)
    }

    /// dmd/dinterpret.d:6180 — `override void visit(ClassReferenceExp e)`
    override visitClassReferenceExp(e: ClassReferenceExp): void {
        //printf("ClassReferenceExp::interpret() %s\n", e.value.toChars());
        this.result = e;
    }

    /// dmd/dinterpret.d:6186 — `override void visit(VoidInitExp e)`
    override visitVoidInitExp(e: VoidInitExp): void {
        error(e.loc, ds("CTFE internal error: trying to read uninitialized variable"));
        assertUnreachable();
    }

    /// dmd/dinterpret.d:6192 — `override void visit(ThrownExceptionExp e)`
    override visitThrownExceptionExp(_e: ThrownExceptionExp): void {
        assertUnreachable(); // This should never be interpreted
    }
}

/// dmd/dinterpret.d:6200 — `void interpretThrow(ref Expression result, Expression exp, Loc loc, InterState* istate)`.
/// Interpret `throw <exp>` found at the specified location `loc`.
/// `ref Expression result` -> the `Ref` box (03 §3.2 / §7.2); callers box, call, and write back.
function interpretThrow(result: Ref<Expression | null>, exp: Expression, loc: Loc, istate: InterState | null): void {
    incUsageCtfe(istate, loc);

    const e = interpretRegion(exp, istate)!; // D dereferences `e` below on every path
    if (exceptionOrCantInterpret(e)) {
        // Make sure e is not pointing to a stack temporary
        result.value = (e.op === EXP.cantExpression) ? CTFEExp.cantexp! : e;
    } else if (e.op === EXP.classReference) {
        result.value = ctfeEmplaceExp(() => new ThrownExceptionExp(loc, e.isClassReferenceExp()!));
    } else {
        error(exp.loc, ds("to be thrown `%s` must be non-null"), exp.toChars());
        result.value = ErrorExp.get();
    }
}

/*********************************************
 * dmd/dinterpret.d:6230 — `public CallExp isRuntimeHook(Expression e, Identifier id)`.
 * Checks if the given expresion is a call to the runtime hook `id`.
 *
 * Params:
 *    e = the expression to check
 *    id = the identifier of the runtime hook
 * Returns:
 *    `e` cast to `CallExp` if it's the hook, `null` otherwise
 */
export function isRuntimeHook(e: Expression, id: Identifier): CallExp | null {
    let ce = e.isCallExp();
    if (ce !== null) {
        const ve = ce.e1!.isVarExp();
        if (ve !== null) {
            let fd = ve.var_.isFuncDeclaration();
            if (fd !== null) {
                // If `_d_HookTraceImpl` is found, resolve the underlying hook
                // and replace `e` and `fd` with it.
                // `removeHookTraceImpl(ce, fd)` rebinds both locals through `ref` (03 §3.2): box, call, write back.
                const ceRef: Ref<CallExp> = { value: ce };
                const fdRef: Ref<FuncDeclaration> = { value: fd };
                removeHookTraceImpl(ceRef, fdRef);
                ce = ceRef.value;
                fd = fdRef.value;
                return fd.ident === id ? ce : null;
            }
        }
    }

    return null;
}

/********************************************
 * dmd/dinterpret.d:6260 — `Expression interpret(UnionExp* pue, Expression e, InterState* istate, CTFEGoal goal`.
 * Interpret the expression.
 * Form B (04 §1, SCOUT alias table): this pue form keeps the bare name, the pue-less one is `interpretNoPue`.
 * Params:
 *    pue = non-null pointer to temporary storage that can be used to store the return value
 *    e = Expression to interpret
 *    istate = context
 *    goal = what the result will be used for
 * Returns:
 *    resulting expression
 */
function interpret(pue: UnionExp, e: Expression | null, istate: InterState | null,
                   goal: CTFEGoal = CTFEGoal.RValue): Expression | null {
    if (e === null)
        return null;
    //printf("+interpret() e : %s, %s\n", e.type.toChars(), e.toChars());
    const v = new Interpreter(pue, istate, goal); // `scope` erased (04 §8)
    e.accept(v);
    const ex = v.result;
    assert(goal === CTFEGoal.Nothing || ex !== null);
    //if (ex) printf("-interpret() ex: %s, %s\n", ex.type.toChars(), ex.toChars()); else printf("-interpret()\n");
    return ex;
}

/// dmd/dinterpret.d:6274 — `Expression interpret(Expression e, InterState* istate, CTFEGoal goal = CTFEGoal.RValue)`.
/// Form B (04 §1): the overload lacking the inserted `pue` parameter -> `interpretNoPue`.
function interpretNoPue(e: Expression | null, istate: InterState | null,
                        goal: CTFEGoal = CTFEGoal.RValue): Expression | null {
    const ue = new UnionExp(); // `UnionExp ue = void;`
    let result = interpret(ue, e, istate, goal);
    if (result === ue.exp())
        result = ue.copy();
    return result;
}

/*****************************
 * dmd/dinterpret.d:6292 — `Expression interpretRegion(Expression e, InterState* istate, CTFEGoal goal`.
 * Same as interpret(), but return result allocated in Region.
 * Params:
 *    e = Expression to interpret
 *    istate = context
 *    goal = what the result will be used for
 * Returns:
 *    resulting expression
 */
function interpretRegion(e: Expression | null, istate: InterState | null,
                         goal: CTFEGoal = CTFEGoal.RValue): Expression | null {
    const ue = new UnionExp(); // `UnionExp ue = void;`
    const result = interpret(ue, e, istate, goal);
    const uexp = ue.exp();
    if (result !== uexp)
        return result;
    if (mem.isGCEnabled())
        return ue.copy();

    // dinterpret.d:6302-6313 — the non-GC tail ("mimicking UnionExp.copy, but with region allocation": the
    // five-sentinel switch, then `ctfeGlobals.region.malloc(uexp.size)` + `memcpy` of the node's bytes) has no
    // analog under GC (07 §7.1, 08 §13, SCOUT §6.2); mem.isGCEnabled() is always true in the port.
    return assertUnreachable("interpretRegion: CTFE region allocation has no analog under GC (dinterpret.d:6312)");
}

/// dmd/dinterpret.d:6317 — `Expressions* copyArrayOnWrite(Expressions* exps, Expressions* original)`.
function copyArrayOnWrite(exps: Expressions | null, original: Expressions | null): Expressions {
    if (exps === original) {
        if (original === null)
            exps = new DArray<Expression | null>();
        else
            exps = original.copy();
        ++ctfeGlobals.numArrayAllocs;
    }
    // non-null: every D caller passes `exps` either identical to `original` (handled above) or a copy
    // already returned by this function (SCOUT §4 binds the `Expressions` return).
    return exps!;
}

/**
 * dmd/dinterpret.d:6341 — `bool stopPointersEscaping(Loc loc, Expression e)`.
 * Given an expression e which is about to be returned from the current
 * function, generate an error if it contains pointers to local variables.
 *
 * Only checks expressions passed by value (pointers to local variables
 * may already be stored in members of classes, arrays, or AAs which
 * were passed as mutable function parameters).
 * Returns:
 *    true if it is safe to return, false if an error was generated.
 */
function stopPointersEscaping(loc: Loc, e: Expression): boolean {
    // hoisted: `import dmd.typesem : hasPointers;` (dinterpret.d:6343) — a module-level import (SCOUT §1.1)
    if (!hasPointers(e.type!))
        return true;
    if (isPointer(e.type!)) {
        let x = e;
        {
            const eaddr = e.isAddrExp();
            if (eaddr !== null)
                x = eaddr.e1!;
        }
        let v: VarDeclaration | null;
        while (x.op === EXP.variable && (v = x.isVarExp()!.var_.isVarDeclaration()) !== null) {
            if ((v.storage_class & STC.ref_) !== 0n) {
                x = getValue(v)!; // D dereferences `x` at the loop test
                const eaddr = e.isAddrExp();
                if (eaddr !== null)
                    eaddr.e1 = x;
                continue;
            }
            if (ctfeGlobals.stack.isInCurrentFrame(v)) {
                error(loc, ds("returning a pointer to a local stack variable"));
                return false;
            } else
                break;
        }
        // TODO: If it is a EXP.dotVariable or EXP.index, we should check that it is not
        // pointing to a local struct or static array.
    }
    {
        const se = e.isStructLiteralExp();
        if (se !== null) {
            return stopPointersEscapingFromArray(loc, se.elements!);
        }
    }
    {
        const ale = e.isArrayLiteralExp();
        if (ale !== null) {
            return stopPointersEscapingFromArray(loc, ale.elements!);
        }
    }
    {
        const aae = e.isAssocArrayLiteralExp();
        if (aae !== null) {
            if (!stopPointersEscapingFromArray(loc, aae.keys!))
                return false;
            return stopPointersEscapingFromArray(loc, aae.values!);
        }
    }
    return true;
}

/// dmd/dinterpret.d:6391 — `bool stopPointersEscapingFromArray(Loc loc, Expressions* elems)`.
/// Check all elements of an array for escaping local variables. Return false if error
function stopPointersEscapingFromArray(loc: Loc, elems: Expressions): boolean {
    for (const e of elems) {
        if (e !== null && !stopPointersEscaping(loc, e))
            return false;
    }
    return true;
}

/// dmd/dinterpret.d:6402 — `Statement findGotoTarget(InterState* istate, Identifier ident)`.
/// `ident` is `Identifier | null`: the body null-tests it (02 §10.1).
function findGotoTarget(istate: InterState, ident: Identifier | null): Statement | null {
    let target: Statement | null = null;
    if (ident !== null) {
        const label = istate.fd!.searchLabel(ident, Loc.initial);
        assert(label !== null && label.statement !== null);
        const ls = label.statement;
        target = ls.gotoTarget !== null ? ls.gotoTarget : ls.statement;
    }
    return target;
}

/// dmd/dinterpret.d:6416 — `ThrownExceptionExp chainExceptions(ThrownExceptionExp oldest`.
function chainExceptions(oldest: ThrownExceptionExp, newest: ThrownExceptionExp): ThrownExceptionExp {
    // dropped: `debug (LOG)` block (dinterpret.d:6418-6421) — debug OFF (_config §3)
    // Little sanity check to make sure it's really a Throwable
    let boss = oldest.thrown!;
    const next = 5;                          // index of Throwable._nextInChainPtr
    const _w = boss.value!.elements!.opIndex(next)!.type!; // `with ((*boss.value.elements)[next].type)` (06 §5)
    assert(_w.ty === TY.Tpointer || _w.ty === TY.Tclass); // Throwable._nextInChainPtr
    const collateral = newest.thrown!;
    if (collateral.originalClass()!.isErrorException() && !boss.originalClass()!.isErrorException()) {
        /* Find the index of the Error.bypassException field
         */
        let bypass = next + 1;
        if (collateral.value!.elements!.opIndex(bypass)!.type!.ty === TY.Tuns32)
            bypass += 1;  // skip over _refcount field
        assert(collateral.value!.elements!.opIndex(bypass)!.type!.ty === TY.Tclass);

        // The new exception bypass the existing chain
        collateral.value!.elements!.opIndexAssign(boss, bypass);
        return newest;
    }
    while (boss.value!.elements!.opIndex(next)!.op === EXP.classReference) {
        boss = boss.value!.elements!.opIndex(next)!.isClassReferenceExp()!;
    }
    boss.value!.elements!.opIndexAssign(collateral, next);
    return oldest;
}

/**
 * dmd/dinterpret.d:6456 — `private Expression scrubReturnValue(Loc loc, Expression e)`.
 * All results destined for use outside of CTFE need to have their CTFE-specific
 * features removed.
 * In particular,
 * 1. all slices must be resolved.
 * 2. all .ownedByCtfe set to OwnedBy.code
 */
function scrubReturnValue(loc: Loc, e: Expression): Expression {
    /* dmd/dinterpret.d:6461 — `static bool isVoid(const Expression e, bool checkArrayType = false) pure`.
     * Returns: true if e is void,
     * or is an array literal or struct literal of void elements.
     */
    const isVoid = (e: Expression, checkArrayType = false): boolean => {
        if (e.op === EXP.void_)
            return true;

        // dmd/dinterpret.d:6466 — `static bool isEntirelyVoid(const Expressions* elems)`
        const isEntirelyVoid = (elems: Expressions): boolean => {
            for (const e of elems) {
                // It can be NULL for performance reasons,
                // see StructLiteralExp::interpret().
                if (e !== null && !isVoid(e))
                    return false;
            }
            return true;
        };

        {
            const sle = e.isStructLiteralExp();
            if (sle !== null)
                return isEntirelyVoid(sle.elements!);
        }

        if (checkArrayType && e.type!.ty !== TY.Tsarray)
            return false;

        {
            const ale = e.isArrayLiteralExp();
            if (ale !== null)
                return isEntirelyVoid(ale.elements!);
        }

        return false;
    };


    /* dmd/dinterpret.d:6494 — `Expression scrubArray(Expressions* elems, bool structlit = false)`.
     * Scrub all elements of elems[].
     * Returns: null for success, error Expression for failure
     */
    const scrubArray = (elems: Expressions, structlit = false): Expression | null => {
        // `foreach (ref e; *elems)`: every `e = …` is an index write (03 §4)
        for (let i = 0; i < elems.length; i++) {
            const e = elems.opIndex(i);
            // It can be NULL for performance reasons,
            // see StructLiteralExp::interpret().
            if (e === null)
                continue;

            // A struct .init may contain void members.
            // Static array members are a weird special case https://issues.dlang.org/show_bug.cgi?id=10994
            if (structlit && isVoid(e, true)) {
                elems.opIndexAssign(null, i); // `e = null;`
            } else {
                const scrubbed = scrubReturnValue(loc, e);
                elems.opIndexAssign(scrubbed, i); // `e = scrubReturnValue(loc, e);`
                if (CTFEExp.isCantExp(scrubbed) || scrubbed.op === EXP.error)
                    return scrubbed;
            }
        }
        return null;
    };

    // dmd/dinterpret.d:6519 — `Expression scrubSE(StructLiteralExp sle)`
    const scrubSE = (sle: StructLiteralExp): Expression | null => {
        sle.ownedByCtfe = OwnedBy.code;
        if ((sle.stageflags & StructLiteralExpStageFlags.scrub) === 0) {
            const old = sle.stageflags;
            sle.stageflags |= StructLiteralExpStageFlags.scrub; // prevent infinite recursion
            // Paired state (11 §2.5): D restores `stageflags` on the normal path only (its error return keeps the
            // flag); a throw is an exit D does not have, so it repairs and rethrows — catch-repair-rethrow.
            let ex: Expression | null;
            try {
                ex = scrubArray(sle.elements!, true);
            } catch (thrown) {
                sle.stageflags = old;
                throw thrown;
            }
            if (ex !== null)
                return ex;
            sle.stageflags = old;
        }
        return null;
    };

    if (e.op === EXP.classReference) {
        const sle = e.isClassReferenceExp()!.value!;
        const ex = scrubSE(sle);
        if (ex !== null)
            return ex;
    } else {
        const vie = e.isVoidInitExp();
        if (vie !== null) {
            error(loc, ds("uninitialized variable `%s` cannot be returned from CTFE"), vie.var_.toChars());
            return ErrorExp.get();
        }
    }

    e = resolveSlice(e);

    // `else if (auto x = …)` chain: each declaration nested into the prior `else` (06 §2.6)
    const sle = e.isStructLiteralExp();
    if (sle !== null) {
        const ex = scrubSE(sle);
        if (ex !== null)
            return ex;
    } else {
        const se = e.isStringExp();
        if (se !== null) {
            se.ownedByCtfe = OwnedBy.code;
        } else {
            const ale = e.isArrayLiteralExp();
            if (ale !== null) {
                ale.ownedByCtfe = OwnedBy.code;
                const ex = scrubArray(ale.elements!);
                if (ex !== null)
                    return ex;
            } else {
                const aae = e.isAssocArrayLiteralExp();
                if (aae !== null) {
                    aae.ownedByCtfe = OwnedBy.code;
                    {
                        const ex = scrubArray(aae.keys!);
                        if (ex !== null)
                            return ex;
                    }
                    {
                        const ex = scrubArray(aae.values!);
                        if (ex !== null)
                            return ex;
                    }
                    aae.type = toBuiltinAAType(aae.type!);
                } else {
                    const ve = e.isVectorExp();
                    if (ve !== null) {
                        ve.ownedByCtfe = OwnedBy.code;
                        const ale = ve.e1!.isArrayLiteralExp();
                        if (ale !== null) {
                            ale.ownedByCtfe = OwnedBy.code;
                            const ex = scrubArray(ale.elements!);
                            if (ex !== null)
                                return ex;
                        }
                    }
                }
            }
        }
    }
    return e;
}

/**************************************
 * dmd/dinterpret.d:6587 — `private Expression scrubCacheValue(Expression e)`.
 * Transitively set all .ownedByCtfe to OwnedBy.cache
 */
function scrubCacheValue(e: Expression | null): Expression | null {
    if (e === null)
        return e;

    // dmd/dinterpret.d:6592 — `Expression scrubArrayCache(Expressions* elems)`
    const scrubArrayCache = (elems: Expressions): Expression | null => {
        for (let i = 0; i < elems.length; i++) // `foreach (ref e; *elems)`: the write is an index write (03 §4)
            elems.opIndexAssign(scrubCacheValue(elems.opIndex(i)), i);
        return null;
    };

    // dmd/dinterpret.d:6599 — `Expression scrubSE(StructLiteralExp sle)`
    const scrubSE = (sle: StructLiteralExp): Expression | null => {
        sle.ownedByCtfe = OwnedBy.cache;
        if ((sle.stageflags & StructLiteralExpStageFlags.scrub) === 0) {
            const old = sle.stageflags;
            sle.stageflags |= StructLiteralExpStageFlags.scrub;  // prevent infinite recursion
            // Paired state (11 §2.5): as in scrubReturnValue's scrubSE — catch-repair-rethrow.
            let ex: Expression | null;
            try {
                ex = scrubArrayCache(sle.elements!);
            } catch (thrown) {
                sle.stageflags = old;
                throw thrown;
            }
            if (ex !== null)
                return ex;
            sle.stageflags = old;
        }
        return null;
    };

    // `else if (auto x = …)` chain: each declaration nested into the prior `else` (06 §2.6)
    if (e.op === EXP.classReference) {
        const ex = scrubSE(e.isClassReferenceExp()!.value!);
        if (ex !== null)
            return ex;
    } else {
        const sle = e.isStructLiteralExp();
        if (sle !== null) {
            const ex = scrubSE(sle);
            if (ex !== null)
                return ex;
        } else {
            const se = e.isStringExp();
            if (se !== null) {
                se.ownedByCtfe = OwnedBy.cache;
            } else {
                const ale = e.isArrayLiteralExp();
                if (ale !== null) {
                    ale.ownedByCtfe = OwnedBy.cache;
                    const ex = scrubArrayCache(ale.elements!);
                    if (ex !== null)
                        return ex;
                } else {
                    const aae = e.isAssocArrayLiteralExp();
                    if (aae !== null) {
                        aae.ownedByCtfe = OwnedBy.cache;
                        {
                            const ex = scrubArrayCache(aae.keys!);
                            if (ex !== null)
                                return ex;
                        }
                        {
                            const ex = scrubArrayCache(aae.values!);
                            if (ex !== null)
                                return ex;
                        }
                    } else {
                        const ve = e.isVectorExp();
                        if (ve !== null) {
                            ve.ownedByCtfe = OwnedBy.cache;
                            const ale = ve.e1!.isArrayLiteralExp();
                            if (ale !== null) {
                                ale.ownedByCtfe = OwnedBy.cache;
                                const ex = scrubArrayCache(ale.elements!);
                                if (ex !== null)
                                    return ex;
                            }
                        }
                    }
                }
            }
        }
    }
    return e;
}

/********************************************
 * dmd/dinterpret.d:6662 — `private Expression copyRegionExp(Expression e)`.
 * Transitively replace all Expressions allocated in ctfeGlobals.region
 * with Mem owned copies.
 * Params:
 *      e = possible ctfeGlobals.region owned expression
 * Returns:
 *      Mem owned expression
 * `ctfeGlobals.region.contains(...)` is kept as a call (SCOUT §6.2): Region.contains is identity-based and
 * answers false for every Expression, which is the GC-path behaviour.
 */
function copyRegionExp(e: Expression | null): Expression | null {
    if (e === null)
        return e;

    // dmd/dinterpret.d:6667 — `static void copyArray(Expressions* elems)`
    const copyArray = (elems: Expressions): void => {
        for (let i = 0; i < elems.length; i++) { // `foreach (ref e; *elems)`: each `e = …` is an index write (03 §4)
            const ex = elems.opIndex(i);
            elems.opIndexAssign(null, i); // `e = null;`
            elems.opIndexAssign(copyRegionExp(ex), i);
        }
    };

    // dmd/dinterpret.d:6677 — `static void copySE(StructLiteralExp sle)`
    const copySE = (sle: StructLiteralExp): void => {
        if (true || (sle.stageflags & StructLiteralExpStageFlags.scrub) === 0) { // D: `if (1 || !(...))`
            const old = sle.stageflags;
            sle.stageflags |= StructLiteralExpStageFlags.scrub; // prevent infinite recursion
            // Paired state (11 §2.5): a throw out of copyArray is an exit D does not have — catch-repair-rethrow,
            // keeping D's own restore at its line.
            try {
                copyArray(sle.elements!);
            } catch (thrown) {
                sle.stageflags = old;
                throw thrown;
            }
            sle.stageflags = old;
        }
    };

    switch (e.op) {
        case EXP.classReference: {
            const cre = e.isClassReferenceExp()!;
            cre.value = copyRegionExp(cre.value)!.isStructLiteralExp();
            break;
        }

        case EXP.structLiteral: {
            const sle = e.isStructLiteralExp()!;

            /* The following is to take care of updating sle.origin correctly,
             * which may have multiple objects pointing to it.
             */
            if (sle.isOriginal && !ctfeGlobals.region.contains(sle.origin)) { // `cast(void*)sle.origin`
                /* This means sle has already been moved out of the region,
                 * and sle.origin is the new location.
                 */
                return sle.origin;
            }
            copySE(sle);
            sle.isOriginal = sle === sle.origin;

            const slec = ctfeGlobals.region.contains(e) // `cast(void*)e`
                ? e.copy().isStructLiteralExp()!        // move sle out of region to slec
                : sle;

            if (ctfeGlobals.region.contains(sle.origin)) { // `cast(void*)sle.origin`
                const sleo = sle.origin === sle ? slec : sle.origin!.copy().isStructLiteralExp();
                sle.origin = sleo;
                slec.origin = sleo;
            }
            return slec;
        }

        case EXP.arrayLiteral: {
            const ale = e.isArrayLiteralExp()!;
            ale.basis = copyRegionExp(ale.basis);
            copyArray(ale.elements!);
            break;
        }

        case EXP.assocArrayLiteral:
            copyArray(e.isAssocArrayLiteralExp()!.keys!);
            copyArray(e.isAssocArrayLiteralExp()!.values!);
            break;

        case EXP.slice: {
            const se = e.isSliceExp()!;
            se.e1  = copyRegionExp(se.e1);
            se.upr = copyRegionExp(se.upr);
            se.lwr = copyRegionExp(se.lwr);
            break;
        }

        case EXP.tuple: {
            const te = e.isTupleExp()!;
            te.e0 = copyRegionExp(te.e0);
            copyArray(te.exps!);
            break;
        }

        case EXP.address:
        case EXP.delegate_:
        case EXP.vector:
        case EXP.dotVariable: {
            const ue = e.isUnaExp()!;
            ue.e1 = copyRegionExp(ue.e1);
            break;
        }

        case EXP.index: {
            const be = e.isBinExp()!;
            be.e1 = copyRegionExp(be.e1);
            be.e2 = copyRegionExp(be.e2);
            break;
        }

        case EXP.this_:
        case EXP.super_:
        case EXP.variable:
        case EXP.type:
        case EXP.function_:
        case EXP.typeid_:
        case EXP.string_:
        case EXP.int64:
        case EXP.error:
        case EXP.float64:
        case EXP.complex80:
        case EXP.null_:
        case EXP.void_:
        case EXP.symbolOffset:
            break;

        case EXP.cantExpression:
        case EXP.voidExpression:
        case EXP.showCtfeContext:
            return e;

        default:
            // dropped: `printf("e: %s, %s\n", EXPtoString(e.op).ptr, e.toChars());` (dinterpret.d:6797) — a bare
            // trace before `assert(0)` (07 §2.1, SCOUT §6.13)
            assertUnreachable();
    }

    if (ctfeGlobals.region.contains(e)) { // `cast(void*)e`
        return e.copy();
    }
    return e;
}

/******************************* Special Functions ***************************/

/// dmd/dinterpret.d:6810 — `private Expression interpret_length(UnionExp* pue, InterState* istate, Expression earg)`.
function interpret_length(pue: UnionExp, istate: InterState | null, earg: Expression): Expression | null {
    //printf("interpret_length()\n");
    earg = interpret(pue, earg, istate)!; // D dereferences `earg` below
    if (exceptionOrCantInterpret(earg))
        return earg;
    let len: dinteger_t = 0n;
    const aae = earg.isAssocArrayLiteralExp();
    if (aae !== null)
        len = BigInt(aae.keys!.length); // size_t length widened into the `dinteger_t` carrier (09 §5)
    else
        assert(earg.op === EXP.null_);
    pue.emplace(new IntegerExp(earg.loc, len, Type.tsize_t));
    return pue.exp();
}

/// dmd/dinterpret.d:6825 — `private Expression interpret_keys(UnionExp* pue, InterState* istate, Expression earg`.
function interpret_keys(pue: UnionExp, istate: InterState | null, earg: Expression,
                        returnType: Type): Expression | null {
    // dropped: `debug (LOG)` block (dinterpret.d:6827-6830) — debug OFF (_config §3)
    earg = interpret(pue, earg, istate)!; // D dereferences `earg` below
    if (exceptionOrCantInterpret(earg))
        return earg;
    if (earg.op === EXP.null_) {
        pue.emplace(new NullExp(earg.loc, returnType));
        return pue.exp();
    }
    if (earg.op !== EXP.assocArrayLiteral && toBasetype(earg.type!).ty !== TY.Taarray)
        return null;
    const aae = earg.isAssocArrayLiteralExp()!;
    const ae = ctfeEmplaceExp(() => new ArrayLiteralExp(aae.loc, returnType, aae.keys));
    ae.ownedByCtfe = aae.ownedByCtfe;
    pue.emplace(copyLiteral(ae).exp()); // `*pue = copyLiteral(ae);`
    return pue.exp();
}

/// dmd/dinterpret.d:6848 — `private Expression interpret_values(UnionExp* pue, InterState* istate, Expression earg`.
function interpret_values(pue: UnionExp, istate: InterState | null, earg: Expression,
                          returnType: Type): Expression | null {
    // dropped: `debug (LOG)` block (dinterpret.d:6850-6853) — debug OFF (_config §3)
    earg = interpret(pue, earg, istate)!; // D dereferences `earg` below
    if (exceptionOrCantInterpret(earg))
        return earg;
    if (earg.op === EXP.null_) {
        pue.emplace(new NullExp(earg.loc, returnType));
        return pue.exp();
    }
    if (earg.op !== EXP.assocArrayLiteral && toBasetype(earg.type!).ty !== TY.Taarray)
        return null;
    const aae = earg.isAssocArrayLiteralExp()!;
    const ae = ctfeEmplaceExp(() => new ArrayLiteralExp(aae.loc, returnType, aae.values));
    ae.ownedByCtfe = aae.ownedByCtfe;
    //printf("result is %s\n", e.toChars());
    pue.emplace(copyLiteral(ae).exp()); // `*pue = copyLiteral(ae);`
    return pue.exp();
}

/// dmd/dinterpret.d:6873 — `private Expression interpret_aaDel(UnionExp* pue, InterState* istate, Expression aa`.
/// signature is bool _d_aaDel(V[K] aa, K key)
/// `_pue`: the D parameter `pue` is unused by the D body (noUnusedParameters).
function interpret_aaDel(_pue: UnionExp, istate: InterState | null, aa: Expression,
                         key: Expression): Expression | null {
    const agg = interpretNoPue(aa, istate)!; // D dereferences `agg` below
    if (exceptionOrCantInterpret(agg))
        return agg;
    const index = interpretNoPue(key, istate)!; // D passes `index` on to ctfeEqual, which dereferences it
    if (exceptionOrCantInterpret(index))
        return index;
    if (agg.op === EXP.null_)
        return CTFEExp.voidexp!; //???

    const aae = agg.isAssocArrayLiteralExp()!;
    const keysx = aae.keys!;
    const valuesx = aae.values!;
    let removed = 0;
    // `foreach (j, evalue; *valuesx)` (06 §1.9 index form): the writes below land on indices already visited,
    // so the element view read here equals D's live slice at every step.
    for (const [j, evalue] of valuesx.opSlice().entries()) {
        const ekey = keysx.opIndex(j);
        const eq = ctfeEqual(aa.loc, EXP.equal, ekey!, index); // D `int eq`: only its truthiness is read
        if (eq)
            ++removed;
        else if (removed !== 0) {
            keysx.opIndexAssign(ekey, j - removed);
            valuesx.opIndexAssign(evalue, j - removed);
        }
    }
    valuesx.length = valuesx.length - removed;
    keysx.length = keysx.length - removed;
    return IntegerExp.createBool(removed !== 0);
}

/// dmd/dinterpret.d:6906 — `private Expression interpret_aaEqual(UnionExp* pue, InterState* istate, Expression aa1`.
/// signature is bool _d_aaDel(V[K] aa1, V[K] aa2)
/// `_pue`: the D parameter `pue` is unused by the D body (noUnusedParameters).
function interpret_aaEqual(_pue: UnionExp, istate: InterState | null, aa1: Expression,
                           aa2: Expression): Expression | null {
    const e1 = interpretNoPue(aa1, istate)!; // D passes `e1`/`e2` on to ctfeEqual, which dereferences them
    if (exceptionOrCantInterpret(e1))
        return e1;
    const e2 = interpretNoPue(aa2, istate)!;
    if (exceptionOrCantInterpret(e2))
        return e2;

    const equal = ctfeEqual(aa1.loc, EXP.equal, e1, e2);
    return IntegerExp.createBool(equal);
}

/// dmd/dinterpret.d:6919 — `private Expression interpret_dup(UnionExp* pue, InterState* istate, Expression earg)`.
function interpret_dup(pue: UnionExp, istate: InterState | null, earg: Expression): Expression | null {
    // dropped: `debug (LOG)` block (dinterpret.d:6921-6924) — debug OFF (_config §3)
    earg = interpret(pue, earg, istate)!; // D dereferences `earg` below
    if (exceptionOrCantInterpret(earg))
        return earg;
    if (earg.op === EXP.null_) {
        pue.emplace(new NullExp(earg.loc, earg.type));
        return pue.exp();
    }
    if (earg.op !== EXP.assocArrayLiteral && toBasetype(earg.type!).ty !== TY.Taarray)
        return null;
    const aae = copyLiteral(earg).copy().isAssocArrayLiteralExp()!;
    for (let i = 0; i < aae.keys!.length; i++) {
        {
            const e = evaluatePostblit(istate, aae.keys!.opIndex(i)!);
            if (e !== null)
                return e;
        }
        {
            const e = evaluatePostblit(istate, aae.values!.opIndex(i)!);
            if (e !== null)
                return e;
        }
    }
    // repaint type from const(int[int]) to int[int]
    const taa = toBasetype(earg.type!).isTypeAArray();
    if (taa !== null) {
        const aatype = new TypeAArray(mutableOf(taa.next!), taa.index);
        aae.type = merge(aatype);
    } else
        aae.type = mutableOf(earg.type!);
    //printf("result is %s\n", aae.toChars());
    return aae;
}

/// dmd/dinterpret.d:6956 — `private Expression interpret_aaIn(UnionExp* pue, InterState* istate, Expression aa`.
/// signature is bool V* _d_aaIn(V[K] aa, K key)
function interpret_aaIn(pue: UnionExp, istate: InterState | null, aa: Expression, key: Expression): Expression | null {
    // dropped: `debug (LOG)` block (dinterpret.d:6958-6961) — debug OFF (_config §3)
    const eaa = interpretRegion(aa, istate)!; // D dereferences `eaa` below
    if (exceptionOrCantInterpret(eaa))
        return eaa;
    const ekey = interpretRegion(key, istate)!; // D passes `ekey` on to findKeyInAA, which dereferences it
    if (exceptionOrCantInterpret(ekey))
        return ekey;

    if (eaa.op !== EXP.null_) {
        const aalit = eaa.isAssocArrayLiteralExp();
        if (aalit === null) {
            error(aa.loc, ds("`%s` cannot be interpreted at compile time"), aa.toChars());
            return CTFEExp.cantexp!;
        }

        const idx: Ref<number> = { value: 0 }; // `size_t idx;` (09 §1.0: size_t.init is 0); `&idx` -> the box
        const result = findKeyInAA(aa.loc, aalit, ekey, idx);
        if (exceptionOrCantInterpret(result))
            return result;
        if (result !== null)
            return pointerToAAValue(pue, aa, aalit, idx.value);
    }
    pue.emplace(new NullExp(aa.loc, pointerTo(nextOf(aa.type!)!)));
    return pue.exp();
}

/// dmd/dinterpret.d:6990 — `private Expression interpret_aaGetRvalueX(UnionExp* pue, InterState* istate`.
/// signature is V* _d_aaGetRvalueX(V[K] aa, K key)
function interpret_aaGetRvalueX(pue: UnionExp, istate: InterState | null, aa: Expression,
                                key: Expression): Expression | null {
    const e1 = interpretNoPue(aa, istate)!; // D dereferences `e1` below
    if (exceptionOrCantInterpret(e1))
        return e1;
    const e2 = interpretRegion(key, istate)!; // D passes `e2` on to findKeyInAA, which dereferences it
    if (exceptionOrCantInterpret(e2))
        return e2;

    const aalit = e1.isAssocArrayLiteralExp();
    if (aalit === null) {
        error(aa.loc, ds("cannot index null array `%s`"), aa.toChars());
        return CTFEExp.cantexp!;
    }
    const idx: Ref<number> = { value: 0 }; // `size_t idx;` (09 §1.0); `&idx` -> the box
    const result = findKeyInAA(aa.loc, aalit, e2, idx);
    if (result === null) {
        error(aa.loc, ds("key `%s` not found in associative array `%s`"), key.toChars(), aa.toChars());
        return  CTFEExp.cantexp!;
    }

    return pointerToAAValue(pue, aa, aalit, idx.value);
}

/// dmd/dinterpret.d:7017 — `private Expression interpret_aaGetY(UnionExp* pue, InterState* istate, Expression aa`.
/// signature is V* _d_aaGetY(ref V[K] aa, K key, out bool found)
/// `found` is `Expression | null`: the body null-tests it (02 §10.1).
function interpret_aaGetY(pue: UnionExp, istate: InterState | null, aa: Expression, key: Expression,
                          found: Expression | null): Expression | null {
    // non-null: interpret asserts a result for any goal but Nothing (dinterpret.d:6268)
    const eaa = interpretRegion(aa, istate, CTFEGoal.LValue)!;
    if (exceptionOrCantInterpret(eaa))
        return eaa;
    const ekey = interpretRegion(key, istate)!; // D passes `ekey` on to findKeyInAA, which dereferences it
    if (exceptionOrCantInterpret(ekey))
        return ekey;
    const efound = interpretRegion(found, istate, CTFEGoal.LValue);
    if (exceptionOrCantInterpret(efound))
        return efound;

    const ie = ctfeEmplaceExp(() => new IndexExp(aa.loc, aa, key)); // any BinExp for location in assignToLvalue
    const evalaa = interpretRegion(eaa, istate)!; // D dereferences `evalaa` below
    let aalit = evalaa.isAssocArrayLiteralExp();
    if (aalit === null) {
        const keysx = new DArray<Expression | null>();
        const valuesx = new DArray<Expression | null>();
        aalit = ctfeEmplaceExp(() => new AssocArrayLiteralExp(aa.loc, keysx, valuesx));
        aalit.type = aa.type;
        aalit.ownedByCtfe = OwnedBy.ctfe;
        Interpreter.assignToLvalue(ie, eaa, aalit, istate);
    }
    const idx: Ref<number> = { value: 0 }; // `size_t idx;` (09 §1.0); `&idx` -> the box
    let result = findKeyInAA(aa.loc, aalit, ekey, idx);
    if (found !== null)
        Interpreter.assignToLvalue(ie, efound!, IntegerExp.createBool(result !== null), istate);
    if (result === null) {
        aalit.keys!.push(ekey);
        result = copyLiteral(defaultInitLiteral(nextOf(aa.type!)!, aa.loc)!).copy();
        idx.value = aalit.values!.length;
        aalit.values!.push(result);
    }
    return pointerToAAValue(pue, aa, aalit, idx.value);
}

/// dmd/dinterpret.d:7055 — `private Expression pointerToAAValue(UnionExp* pue, Expression aa`.
function pointerToAAValue(pue: UnionExp, aa: Expression, aalit: AssocArrayLiteralExp, idx: number): Expression {
    const arr = ctfeEmplaceExp(() => new ArrayLiteralExp(aa.loc, arrayOf(nextOf(aa.type!)!), aalit.values));
    arr.ownedByCtfe = aalit.ownedByCtfe;
    arr.aaLiteral = aalit;
    // `size_t idx` into the `dinteger_t` carrier of an IntegerExp (09 §5)
    const len = ctfeEmplaceExp(() => new IntegerExp(aa.loc, BigInt(idx), Type.tsize_t));
    const idxexp = ctfeEmplaceExp(() => new IndexExp(aa.loc, arr, len));
    idxexp.type = nextOf(arr.type!);
    pue.emplace(new AddrExp(aa.loc, idxexp));
    pue.exp().type = pointerTo(idxexp.type!);
    return pue.exp();
}

/// dmd/dinterpret.d:7069 — `private Expression interpret_aaApply(UnionExp* pue, InterState* istate, Expression aa`.
/// signature is int delegate(ref Value) OR int delegate(ref Key, ref Value)
function interpret_aaApply(pue: UnionExp, istate: InterState | null, aa: Expression,
                           deleg: Expression): Expression | null {
    aa = interpretNoPue(aa, istate)!; // D dereferences `aa` below
    if (exceptionOrCantInterpret(aa))
        return aa;
    if (aa.op !== EXP.assocArrayLiteral) {
        pue.emplace(new IntegerExp(deleg.loc, 0n, Type.tsize_t));
        return pue.exp();
    }

    let fd: FuncDeclaration | null = null;
    let pthis: Expression | null = null;
    const de = deleg.isDelegateExp();
    if (de !== null) {
        fd = de.func;
        pthis = de.e1;
    } else {
        const fe = deleg.isFuncExp();
        if (fe !== null)
            fd = fe.fd;
    }

    assert(fd !== null && fd.fbody !== null);
    assert(fd.parameters !== null);
    const numParams = fd.parameters.length;
    assert(numParams === 1 || numParams === 2);

    const fparam = fd.type!.isTypeFunction()!.parameterList.opIndex(numParams - 1)!;
    const wantRefValue = fparam.isReference();

    const args: Expressions = new DArray<Expression | null>(numParams); // `Expressions args = Expressions(numParams);`

    const ae = aa.isAssocArrayLiteralExp()!;
    if (ae.keys === null || ae.keys.length === 0)
        return ctfeEmplaceExp(() => new IntegerExp(deleg.loc, 0n, Type.tsize_t));
    let eresult: Expression | null = null; // `Expression eresult;` (null init)

    for (let i = 0; i < ae.keys.length; ++i) {
        const ekey = ae.keys.opIndex(i);
        let evalue = ae.values!.opIndex(i);
        if (wantRefValue) {
            const t = evalue!.type!;
            const arr = ctfeEmplaceExp(() => new ArrayLiteralExp(aa.loc, arrayOf(t), ae.values));
            arr.ownedByCtfe = ae.ownedByCtfe;
            // `size_t i` into the `dinteger_t` carrier of an IntegerExp (09 §5)
            const idx = ctfeEmplaceExp(() => new IntegerExp(aa.loc, BigInt(i), Type.tsize_t));
            evalue = ctfeEmplaceExp(() => new IndexExp(aa.loc, arr, idx));
            evalue.type = t;
        }
        args.opIndexAssign(evalue, numParams - 1);
        if (numParams === 2)
            args.opIndexAssign(ekey, 0);

        const ue = new UnionExp(); // `UnionExp ue = void;` — a fresh one per iteration (SCOUT §6.1)
        eresult = interpretFunction(ue, fd, istate, args, pthis);
        if (eresult === ue.exp())
            eresult = ue.copy();
        if (exceptionOrCantInterpret(eresult))
            return eresult;

        if (eresult!.isIntegerExp()!.getInteger() !== 0n)
            return eresult;
    }
    return eresult;
}

/// dmd/dinterpret.d:7136 — `StringExp arrayLiteralToString(ArrayLiteralExp ale)`.
/// Returns: equivalent `StringExp` from `ArrayLiteralExp ale` containing only `IntegerExp` elements
function arrayLiteralToString(ale: ArrayLiteralExp): StringExp {
    const len = ale.elements !== null ? ale.elements.length : 0;
    const size_ = size(nextOf(ale.type!)!); // D local `size` -> `size_` (01 Rule 2.3; SCOUT alias table)

    // dmd/dinterpret.d:7141 — `StringExp impl(T)()`: a nested template, MONOMORPHIZED per instantiation
    // (07 §3.4): one nested function per `T` the switch below instantiates (char, wchar, dchar).
    // `new T[len]` fills with `T.init`; every slot is overwritten by the loop before it is read.

    const impl_char = (): StringExp => {
        const result = new Uint8Array(len); // `char[] result = new char[len];`
        for (let i = 0; i < len; i++)
            // `cast(char)` of the `dinteger_t` carrier: mask in bigint first (09 §2), then the byte is exact
            result[i] = Number(maskUnsignedN(8, ale.elements!.opIndex(i)!.isIntegerExp()!.getInteger()));
        // `result[]` passed as the ctor's `const(void)[]`: for T = char the bytes ARE the code units
        return new StringExp(ale.loc, Array.from(result), len, Number(maskUnsignedN(8, size_))); // `cast(ubyte) size`
    };

    const impl_wchar = (): StringExp => {
        const result = new Uint16Array(len); // `wchar[] result = new wchar[len];`
        for (let i = 0; i < len; i++)
            // `cast(wchar)` of the `dinteger_t` carrier (09 §2)
            result[i] = Number(maskUnsignedN(16, ale.elements!.opIndex(i)!.isIntegerExp()!.getInteger()));
        // `result[]` passed as the ctor's `const(void)[]`: the payload is the wchar array's bytes, little-endian
        // (the StringExp payload model, expression.ts class doc)
        return new StringExp(ale.loc, Array.from(new Uint8Array(result.buffer)), len, Number(maskUnsignedN(8, size_)));
    };

    const impl_dchar = (): StringExp => {
        const result = new Uint32Array(len); // `dchar[] result = new dchar[len];`
        for (let i = 0; i < len; i++)
            // `cast(dchar)` of the `dinteger_t` carrier (09 §2)
            result[i] = Number(maskUnsignedN(32, ale.elements!.opIndex(i)!.isIntegerExp()!.getInteger()));
        // `result[]` as the payload: the dchar array's bytes, little-endian (see impl_wchar)
        return new StringExp(ale.loc, Array.from(new Uint8Array(result.buffer)), len, Number(maskUnsignedN(8, size_)));
    };

    switch (size_) {
        case 1n:
            return impl_char();
        case 2n:
            return impl_wchar();
        case 4n:
            return impl_dchar();
        default:
            assertUnreachable();
    }
}

/* dmd/dinterpret.d:7165 — `private Expression foreachApplyUtf(UnionExp* pue, InterState* istate, Expression str`.
 * Decoding UTF strings for foreach loops. Duplicates the functionality of
 * the twelve _aApplyXXn functions in aApply.d in the runtime.
 */
function foreachApplyUtf(pue: UnionExp, istate: InterState | null, str: Expression, deleg: Expression,
                         rvs: boolean): Expression | null {
    // dropped: `debug (LOG)` block (dinterpret.d:7167-7170) — debug OFF (_config §3)
    let fd: FuncDeclaration | null = null;
    let pthis: Expression | null = null;
    const de = deleg.isDelegateExp();
    if (de !== null) {
        fd = de.func;
        pthis = de.e1;
    } else {
        const fe = deleg.isFuncExp();
        if (fe !== null)
            fd = fe.fd;
    }

    assert(fd !== null && fd.fbody !== null);
    assert(fd.parameters !== null);
    const numParams = fd.parameters.length;
    assert(numParams === 1 || numParams === 2);
    const charType = fd.parameters.opIndex(numParams - 1)!.type!;
    const indexType = numParams === 2 ? fd.parameters.opIndex(0)!.type! : Type.tsize_t;
    // `cast(size_t)resolveArrayLength(str)` — an array length: the index/length domain (09 §1.1)
    const len = Number(resolveArrayLength(str));
    if (len === 0) {
        pue.emplace(new IntegerExp(deleg.loc, 0n, indexType));
        return pue.exp();
    }

    const strTmp = new UnionExp(); // `UnionExp strTmp = void;`
    str = resolveSlice(str, strTmp);

    let se = str.isStringExp();
    {
        const ale = str.isArrayLiteralExp();
        if (ale !== null)
            se = arrayLiteralToString(ale);
    }

    if (se === null) {
        error(str.loc, ds("CTFE internal error: cannot foreach `%s`"), str.toChars());
        return CTFEExp.cantexp!;
    }
    const args: Expressions = new DArray<Expression | null>(numParams); // `Expressions args = Expressions(numParams);`

    let eresult: Expression | null = null; // ded-store to prevent spurious warning

    // Buffers for encoding
    const utf8buf = new Uint8Array(4);   // `char[4] utf8buf = void;`
    const utf16buf = new Uint16Array(2); // `wchar[2] utf16buf = void;`

    const start = rvs ? len : 0;
    const end = rvs ? 0 : len;
    for (let indx = start; indx !== end;) {
        // Step 1: Decode the next dchar from the string.

        let errmsg: DString | null = null; // Used for reporting decoding errors
        let rawvalue = 0xFFFF; // Holds the decoded dchar (`dchar rawvalue;`: dchar.init, 09 §1.0)
        let currentIndex = indx; // The index of the decoded character

        // String literals
        let saveindx = 0; // used for reverse iteration (`size_t saveindx;`: size_t.init, 09 §1.0)

        switch (se.sz) {
            case 1: {
                if (rvs) {
                    // find the start of the string
                    --indx;
                    while (indx > 0 && ((se.getCodeUnit(indx) & 0xC0) === 0x80))
                        --indx;
                    saveindx = indx;
                }
                const slice = se.peekString();
                // `errmsg = utf_decodeChar(slice, indx, rawvalue);` — ref cursor + out dchar (06 §5.5, 08 §7.2)
                const r = utf_decodeChar(slice, indx);
                indx = r.nextIdx;
                rawvalue = r.dchar;
                errmsg = r.error;
                if (rvs)
                    indx = saveindx;
                break;
            }

            case 2: {
                if (rvs) {
                    // find the start
                    --indx;
                    const wc = se.getCodeUnit(indx);
                    if (wc >= 0xDC00 && wc <= 0xDFFF)
                        --indx;
                    saveindx = indx;
                }
                const slice = se.peekWstring();
                // `errmsg = utf_decodeWchar(slice, indx, rawvalue);` — ref cursor + out dchar (08 §7.2)
                const r = utf_decodeWchar(slice, indx);
                indx = r.nextIdx;
                rawvalue = r.dchar;
                errmsg = r.error;
                if (rvs)
                    indx = saveindx;
                break;
            }

            case 4:
                if (rvs)
                    --indx;
                rawvalue = se.getCodeUnit(indx);
                if (!rvs)
                    ++indx;
                break;

            default:
                assertUnreachable();
        }

        if (errmsg !== null) {
            error(deleg.loc, ds("`%.*s`"), errmsg.length, errmsg); // `cast(int)errmsg.length, errmsg.ptr`
            return CTFEExp.cantexp!;
        }

        // Step 2: encode the dchar in the target encoding

        let charlen = 1; // How many codepoints are involved?
        switch (size(charType)) {
            case 1n:
                charlen = utf_codeLengthChar(rawvalue);
                utf_encodeChar(utf8buf, 0, rawvalue); // `&utf8buf[0]`
                break;
            case 2n:
                charlen = utf_codeLengthWchar(rawvalue);
                utf_encodeWchar(utf16buf, 0, rawvalue); // `&utf16buf[0]`
                break;
            case 4n:
                break;
            default:
                assertUnreachable();
        }
        if (rvs)
            currentIndex = indx;

        // Step 3: call the delegate once for each code point

        // The index only needs to be set once
        if (numParams === 2)
            // `size_t currentIndex` into the `dinteger_t` carrier of an IntegerExp (09 §5)
            args.opIndexAssign(ctfeEmplaceExp(() => new IntegerExp(deleg.loc, BigInt(currentIndex), indexType)), 0);

        let val: Expression | null = null;

        for (let k = 0; k < charlen; k++) {
            let codepoint = 0xFFFF; // `dchar codepoint;` (dchar.init, 09 §1.0)
            switch (size(charType)) {
                case 1n:
                    codepoint = utf8buf[k];
                    break;
                case 2n:
                    codepoint = utf16buf[k];
                    break;
                case 4n:
                    codepoint = rawvalue;
                    break;
                default:
                    assertUnreachable();
            }
            // `dchar codepoint` into the `dinteger_t` carrier of an IntegerExp (09 §5)
            val = ctfeEmplaceExp(() => new IntegerExp(str.loc, BigInt(codepoint), charType));

            args.opIndexAssign(val, numParams - 1);

            const ue = new UnionExp(); // `UnionExp ue = void;` — a fresh one per iteration (SCOUT §6.1)
            eresult = interpretFunction(ue, fd, istate, args, pthis);
            if (eresult === ue.exp())
                eresult = ue.copy();
            if (exceptionOrCantInterpret(eresult))
                return eresult;
            if (eresult!.isIntegerExp()!.getInteger() !== 0n)
                return eresult;
        }
    }
    return eresult;
}

/* dmd/dinterpret.d:7346 — `private Expression evaluateIfBuiltin(UnionExp* pue, InterState* istate, Loc loc`.
 * If this is a built-in function, return the interpreted result,
 * Otherwise, return NULL.
 */
function evaluateIfBuiltin(pue: UnionExp, istate: InterState | null, loc: Loc, fd: FuncDeclaration,
                           arguments_: Expressions | null, pthis: Expression | null): Expression | null {
    let e: Expression | null = null;
    const nargs = arguments_ !== null ? arguments_.length : 0;
    if (pthis === null) {
        if (isBuiltin(fd) !== BUILTIN.unimp) {
            const args: Expressions = new DArray<Expression | null>(nargs); // `Expressions args = Expressions(nargs);`
            // `foreach (i, ref arg; args)`: `arg = …` is an index write (03 §4)
            for (let i = 0; i < args.length; i++) {
                let earg = arguments_!.opIndex(i);
                earg = interpretNoPue(earg, istate);
                if (exceptionOrCantInterpret(earg))
                    return earg;
                args.opIndexAssign(earg, i); // `arg = earg;`
            }
            e = eval_builtin(loc, fd, args); // `&args`
            if (e === null) {
                error(loc, ds("cannot evaluate unimplemented builtin `%s` at compile time"), fd.toChars());
                e = CTFEExp.cantexp!;
            }
        }
    }
    if (pthis === null) {
        if (nargs >= 1 && nargs <= 3) {
            const firstarg = arguments_!.opIndex(0)!;
            const firstAAtype = toBasetype(firstarg.type!).isTypeAArray();
            if (firstAAtype !== null) {
                const id = fd.ident;
                if (nargs === 1) {
                    if (id === Id._d_aaLen)
                        return interpret_length(pue, istate, firstarg);

                    if (fd.toParent2()!.ident === Id.object) {
                        if (id === Id.keys)
                            return interpret_keys(pue, istate, firstarg, arrayOf(firstAAtype.index!));
                        if (id === Id.values)
                            return interpret_values(pue, istate, firstarg, arrayOf(nextOf(firstAAtype)!));
                        if (id === Id.rehash)
                            return interpret(pue, firstarg, istate);
                        if (id === Id.dup)
                            return interpret_dup(pue, istate, firstarg);
                    }
                } else if (nargs === 2) {
                    if (id === Id._d_aaGetRvalueX)
                        return interpret_aaGetRvalueX(pue, istate, firstarg, arguments_!.opIndex(1)!);
                    if (id === Id._d_aaIn)
                        return interpret_aaIn(pue, istate, firstarg, arguments_!.opIndex(1)!);
                    if (id === Id._d_aaDel)
                        return interpret_aaDel(pue, istate, firstarg, arguments_!.opIndex(1)!);
                    if (id === Id._d_aaEqual)
                        return interpret_aaEqual(pue, istate, firstarg, arguments_!.opIndex(1)!);
                    if (id === Id._d_aaApply)
                        return interpret_aaApply(pue, istate, firstarg, arguments_!.opIndex(1)!);
                    if (id === Id._d_aaApply2)
                        return interpret_aaApply(pue, istate, firstarg, arguments_!.opIndex(1)!);
                } else { // (nargs == 3)
                    if (id === Id._d_aaGetY)
                        return interpret_aaGetY(pue, istate, firstarg, arguments_!.opIndex(1)!, arguments_!.opIndex(2));
                }
            }
        }
    }
    if (pthis !== null && fd.fbody === null && fd.isCtorDeclaration() !== null && fd.parent !== null &&
        fd.parent.parent !== null && fd.parent.parent.ident === Id.object) {
        if (pthis.op === EXP.classReference && fd.parent.ident === Id.Throwable) {
            // At present, the constructors just copy their arguments into the struct.
            // But we might need some magic if stack tracing gets added to druntime.
            const se = pthis.isClassReferenceExp()!.value!;
            assert(arguments_!.length <= se.elements!.length);
            for (const [i, arg] of arguments_!.opSlice().entries()) { // `foreach (i, arg; *arguments)` (06 §1.9)
                const elem = interpretNoPue(arg, istate);
                if (exceptionOrCantInterpret(elem))
                    return elem;
                se.elements!.opIndexAssign(elem, i);
            }
            return CTFEExp.voidexp!;
        }
    }
    if (nargs === 1 && pthis === null && (fd.ident === Id.criticalenter || fd.ident === Id.criticalexit)) {
        // Support synchronized{} as a no-op
        return CTFEExp.voidexp!;
    }
    if (pthis === null) {
        const idlen = fd.ident!.toString().length;
        const id = fd.ident!.toChars();
        // `!strncmp(id, "_aApply", 7)` — a byte compare of the first 7 bytes (`idlen >= 10` guarantees them)
        if (nargs === 2 && (idlen === 10 || idlen === 11) && dsEquals(dsSubslice(id, 0, 7), ds("_aApply"))) {
            // Functions from aApply.d and aApplyR.d in the runtime
            const rvs = (idlen === 11); // true if foreach_reverse
            const c = id[idlen - 3]; // char width: 'c', 'w', or 'd'
            const s = id[idlen - 2]; // string width: 'c', 'w', or 'd'
            const n = id[idlen - 1]; // numParams: 1 or 2.
            // There are 12 combinations
            if ((n === 0x31 /* '1' */ || n === 0x32 /* '2' */) &&
                (c === 0x63 /* 'c' */ || c === 0x77 /* 'w' */ || c === 0x64 /* 'd' */) &&
                (s === 0x63 /* 'c' */ || s === 0x77 /* 'w' */ || s === 0x64 /* 'd' */) &&
                c !== s) {
                let str = arguments_!.opIndex(0)!;
                str = interpretNoPue(str, istate)!; // D passes `str` on to foreachApplyUtf, which dereferences it
                if (exceptionOrCantInterpret(str))
                    return str;
                return foreachApplyUtf(pue, istate, str, arguments_!.opIndex(1)!, rvs);
            }
        }
    }
    return e;
}

/// dmd/dinterpret.d:7470 — `private Expression evaluatePostblit(InterState* istate, Expression e)`.
function evaluatePostblit(istate: InterState | null, e: Expression): Expression | null {
    const ts = baseElemOf(e.type!).isTypeStruct();
    if (ts === null)
        return null;
    const sd = ts.sym!;
    if (sd.postblit === null)
        return null;

    const ale = e.isArrayLiteralExp();
    if (ale !== null) {
        for (const elem of ale.elements!) {
            const ex = evaluatePostblit(istate, elem!);
            if (ex !== null)
                return ex;
        }
        return null;
    }
    if (e.op === EXP.structLiteral) {
        // e.__postblit()
        const ue = new UnionExp(); // `UnionExp ue = void;`
        // `e = interpretFunction(...)`: D reassigns the parameter to a nullable result -> the widened local `cur`
        // (02 §10.1)
        let cur = interpretFunction(ue, sd.postblit, istate, null, e);
        if (cur === ue.exp())
            cur = ue.copy();
        if (exceptionOrCantInterpret(cur))
            return cur;
        return null;
    }
    assertUnreachable();
}

/// dmd/dinterpret.d:7502 — `private Expression evaluateDtor(InterState* istate, Expression e)`.
function evaluateDtor(istate: InterState | null, e: Expression): Expression | null {
    const ts = baseElemOf(e.type!).isTypeStruct();
    if (ts === null)
        return null;
    const sd = ts.sym!;
    if (sd.dtor === null)
        return null;

    const ue = new UnionExp(); // `UnionExp ue = void;`
    // D reassigns the parameter `e` to nullable results below -> the widened local `cur` (02 §10.1)
    let cur: Expression | null = e;
    const ale = e.isArrayLiteralExp();
    if (ale !== null) {
        const elems = ale.elements!;
        for (let _i = elems.length - 1; _i >= 0; _i--) { // `foreach_reverse (elem; *ale.elements)` (06 §2)
            const elem = elems.opIndex(_i);
            cur = evaluateDtor(istate, elem!);
        }
    } else if (e.op === EXP.structLiteral) {
        // e.__dtor()
        cur = interpretFunction(ue, sd.dtor, istate, null, e);
    } else
        assertUnreachable();
    if (exceptionOrCantInterpret(cur)) {
        if (cur === ue.exp())
            cur = ue.copy();
        return cur;
    }
    return null;
}

/*************************** CTFE Sanity Checks ***************************/
/* Setter functions for CTFE variable values.
 * These functions exist to check for compiler CTFE bugs.
 */
/// dmd/dinterpret.d:7537 — `private bool hasValue(VarDeclaration vd)`.
function hasValue(vd: VarDeclaration): boolean {
    return vd.ctfeAdrOnStack !== VarDeclaration.AdrOnStackNone &&
           getValue(vd) !== null;
}

/// dmd/dinterpret.d:7544 — `private void setValueWithoutChecking(VarDeclaration vd, Expression newval)`.
/// Don't check for validity
function setValueWithoutChecking(vd: VarDeclaration, newval: Expression | null): void {
    ctfeGlobals.stack.setValue(vd, newval);
}

/// dmd/dinterpret.d:7549 — `private void setValue(VarDeclaration vd, Expression newval)`.
/// `newval` is non-null: the body dereferences it through isCtfeReferenceValid / isCtfeValueValid (02 §10.1).
function setValue(vd: VarDeclaration, newval: Expression): void {
    //printf("setValue() vd: %s newval: %s\n", vd.toChars(), newval.toChars());
    // dropped: `version (none)` block (dinterpret.d:7552-7558) — never compiled (07 §1)
    assert((vd.storage_class & (STC.out_ | STC.ref_)) !== 0n ? isCtfeReferenceValid(newval) : isCtfeValueValid(newval));
    ctfeGlobals.stack.setValue(vd, newval);
}

/**
 * dmd/dinterpret.d:7573 — `private void removeHookTraceImpl(ref CallExp ce, ref FuncDeclaration fd)`.
 * Removes `_d_HookTraceImpl` if found from `ce` and `fd`.
 * This is needed for the CTFE interception code to be able to find hooks that are called though the hook's `*Trace`
 * wrapper.
 *
 * This is done by replacing `_d_HookTraceImpl!(T, Hook, errMsg)(..., parameters)` with `Hook(parameters)`.
 * Parameters:
 *  ce = The CallExp that possible will be be replaced
 *  fd = Fully resolve function declaration that `ce` would call
 * `ref CallExp ce` / `ref FuncDeclaration fd` -> `Ref` boxes (03 §3.2 / §7.2); callers box, call, write back.
 */
function removeHookTraceImpl(ce: Ref<CallExp>, fd: Ref<FuncDeclaration>): void {
    if (fd.value.ident !== Id._d_HookTraceImpl)
        return;

    const oldCE = ce.value;

    // Get the Hook from the second template parameter
    const templateInstance = fd.value.parent!.isTemplateInstance()!;
    const hook = templateInstance.tiargs!.opIndex(1)!;
    assert(isDsymbol(hook) !== null,
           "Expected _d_HookTraceImpl's second template parameter to be an alias to the hook!");
    // `(cast(Dsymbol)hook).isFuncDeclaration` — the checked downcast is isDsymbol (the assert above proved it);
    // non-null: D's VarExp constructor below dereferences `fd`
    fd.value = isDsymbol(hook)!.isFuncDeclaration()!;

    // Remove the first three trace parameters
    const arguments_ = new DArray<Expression | null>();
    arguments_.reserve(ce.value.arguments_!.length - 3);
    arguments_.pushSlice(ce.value.arguments_!.opSlice(3, ce.value.arguments_!.opDollar())); // `(*ce.arguments)[3 .. $]`

    ce.value = ctfeEmplaceExp(() => new CallExp(ce.value.loc,
                                                ctfeEmplaceExp(() => new VarExp(ce.value.loc, fd.value, false)),
                                                arguments_));

    if (global.params.v.verbose)
        messageNoLoc(ds("strip     %s =>\n          %s"), oldCE.toChars(), ce.value.toChars());
}
