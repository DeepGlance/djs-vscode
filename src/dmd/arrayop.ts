// Ported from dmd/arrayop.d (module dmd.arrayop) —
// "Implement array operations, such as `a[] = b[] + c[]`."
//
// Specification: https://dlang.org/spec/arrays.html#array-operations
//
// WHOLE-FILE TRANSLATION. Every top-level D declaration of arrayop.d is present here, in SOURCE
// ORDER, fully translated. Nothing walled (see WALLS below), nothing dropped.
//
// IDIOM A (13 §7). `grep 'class .*Visitor' dmd/arrayop.d` -> 1 hit: `BuildArrayOpVisitor`
// (arrayop.d:192), a `final class : Visitor` declared INSIDE `buildArrayOp`. It is emitted as a
// class declared inside the same function body — that is what D writes, and it also keeps this
// module free of any top-level VALUE read of a core-SCC class (01 §4.1): nothing here `extends`
// anything at module scope, so arrayop.ts adds no `Class extends value undefined` hazard when the
// integrator wires expressionsem.ts/typesem.ts to it.
//
// OVERLOAD SET RESOLVED (04 §1). `arrayOp(BinExp, Scope*)` (arrayop.d:118) and
// `arrayOp(BinAssignExp, Scope*)` (arrayop.d:162) are same-arity / different-FIRST-parameter ->
// Form B, bare receiver-type suffix (04 §1B rule 2 / §6.1).
// WHICH FORM KEEPS THE BARE NAME is rule 1, and it is decided, not improvised: no TS dependent
// imports either form yet (`grep -rn arrayop.js src/` -> nothing outside arrayop.test.ts), so the
// tie-break falls to the D call counts, where "a CROSS-MODULE D caller outranks an in-module one".
// The **BinAssignExp** form has TWO cross-module callers — expressionsem.d:9307 (inside
// `visit(BinAssignExp)` at :9272) and :13393 (inside `visit(PowAssignExp)` at :13358,
// `PowAssignExp : BinAssignExp`); the BinExp form has ONE — expressionsem.d:13136 (inside
// `visit(AssignExp)` at :11981, `AssignExp : BinExp`) — plus the in-module tail call at
// arrayop.d:182, which rule 1 discounts. So the BinAssignExp form keeps `arrayOp` and the BinExp
// form becomes `arrayOpBinExp`, exactly as 04 §6.1 records for `checkLabel` ("the Goto form keeps
// the bare name, being the cross-module contract").
// D call sites, for the integrator's sweep: expressionsem.d:9307 and :13393 -> `arrayOp`;
// expressionsem.d:13136 -> `arrayOpBinExp`.
//
// TEMPLATE MONOMORPHIZED (07 §3.4). `private void checkPossibleAddCatError(AddT, CatT)(AddT ae)`
// (arrayop.d:383) has exactly THREE instantiations in the tree, over TWO argument pairs:
// `!(AddExp, CatExp)` (arrayop.d:377) and `!(AddAssignExp, CatAssignExp)` (arrayop.d:174, :379).
// Emitted as the two concrete functions `checkPossibleAddCatError_AddExp` /
// `checkPossibleAddCatError_AddAssignExp`; no generic is emitted (`new CatT(...)` needs the
// concrete constructor, which a TS generic cannot name).
//
// FUNCTION-LOCAL `__gshared` HOISTED (01 §5.5). `__gshared TemplateDeclaration arrayOp;`
// (arrayop.d:136) is declared inside `arrayOp(BinExp, Scope*)` but has PROGRAM lifetime — a
// body-local `let` would reset on every call and the cache would never cache. It is hoisted to
// module state as `arrayOpTemplate`; the name differs from D's only because D's function-local
// declaration SHADOWS the module-level function `arrayOp`, which TS cannot reproduce at module
// scope. `_resetArrayOpTemplate()` is the harness reset required by 01 §5.5 rule 3 (no D
// counterpart, never called by compiler code).
//
// UFCS RESOLVED (04 §6): `t.toBasetype()`, `t.nextOf()`, `t.isAssignable()` are FREE functions in
// typesem.d (:1249 / :344 / :2029 in typesem.ts) — called in the free form. `e.modifiableLvalue(sc)`
// is the free `modifiableLvalue(Expression, Scope*, Expression = null)` of expressionsem.d:17764.
// `t.implicitConvTo(t2)` at arrayop.d:385 has a **Type** receiver, so it is dcast.ts's
// `implicitConvToType` (04 §6.1 REGISTERED FAMILIES), not the Expression-receiver `implicitConvTo`.
// `t.isMutable()` and `t.isStaticOrDynamicArray()` really are `Type` METHODS (mtype.d) — method form.
//
// WALLS (11 §2.5): NONE. The two `EXPtoString` sites (arrayop.d:235, :253) were the only
// candidates; `EXPtoString` is LIVE — `hdrgen.ts` exports the full port of the D function
// AUTHORISED at dmd/hdrgen.d:4602 (`string EXPtoString(EXP op)`), so both call the faithful export.
// Verified at self-gate (11 §2.5: a wall's "not exported" claim is verifiable, and hdrgen.ts landed
// mid-wave and is still growing — hence the grep, not a line number, as the pointer):
// `grep -n "export function EXPtoString(" src/dmd/hdrgen.ts` -> one hit.
//
// Every top-level declaration of arrayop.d is therefore TRANSLATED — nothing walled, nothing
// dropped. In particular the 26 `checkNonAssignmentArrayOp` walls standing across the tree
// (expressionsem.ts 18, statementsem.ts 7, typesem.ts 1 — counted as `const
// checkNonAssignmentArrayOp` closures in non-test files; the 9 further grep hits are
// `.toThrow(...)` assertions in .test.ts files PINNING those walls, not walls) now have a fully
// translated callee to be swept onto. They still THROW until the integrator rewires each site —
// landing this file changes none of them.

import { assert } from "../assert.js";
import { ds, type DString } from "../dstring.js";
import { Array as DArray } from "./root/array.js"; // value: `new Objects()` / `new Expressions()`
import { OutBuffer } from "./common/outbuffer.js";

import { Tarray, Tfloat64, Tint32, Tsarray, Tvoid, MATCH } from "./astenums.js";
import { EXP } from "./tokens.js";
import { Loc } from "./location.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { error, errorSupplemental } from "./errors.js";
// 01 §4.8 — the AST-NODE module is named BEFORE any `*sem` / `dsymbol` / `declaration` module:
// entering the core SCC through a node file works, entering it through a semantic pass does not.
// This block therefore stays ahead of declaration.js / dcast.js / expressionsem.js / funcsem.js /
// typesem.js below, whatever alphabetical order would suggest.
import {
    ArgumentList,
    CallExp,
    CatAssignExp,
    CatExp,
    DotIdExp,
    ErrorExp,
    IdentifierExp,
    StringExp,
    VarExp,
} from "./expression.js";
import { ObjectNotFound } from "./declaration.js";
import { implicitConvToType } from "./dcast.js";
import { EXPtoString } from "./hdrgen.js";
import { expressionSemantic, modifiableLvalue } from "./expressionsem.js";
import { FuncResolveFlag, resolveFuncCall } from "./funcsem.js";
import { isAssignable, nextOf, toBasetype } from "./typesem.js";
import { Visitor } from "./visitor/index.js";

import type { Expressions, Objects } from "./arraytypes.js";
import type { RootObject } from "./rootobject.js";
import type { Scope } from "./dscope.js";
import type { TemplateDeclaration } from "./dtemplate.js";
import type { Type, TypeDArray } from "./mtype.js";
import type {
    AddAssignExp,
    AddExp,
    BinAssignExp,
    BinExp,
    CastExp,
    Expression,
    SliceExp,
    UnaExp,
} from "./expression.js";

// dropped: import core.stdc.stdio (arrayop.d:16) — the only uses are the commented-out
//          `//printf(...)` trace lines, which are carried as comments below.

/**********************************************
 * dmd/arrayop.d:39 — `bool isArrayOpValid(Expression e)`.
 * Check that there are no uses of arrays without [].
 */
export function isArrayOpValid(e: Expression): boolean {
    //printf("isArrayOpValid() %s\n", e.toChars());
    if (e.op === EXP.slice)
        return true;
    if (e.op === EXP.arrayLiteral) {
        let t: Type = toBasetype(e.type!);
        while (t.isStaticOrDynamicArray())
            t = toBasetype(nextOf(t)!);
        return (t.ty !== Tvoid);
    }
    const tb: Type = toBasetype(e.type!);
    if (tb.isStaticOrDynamicArray()) {
        if (isUnaArrayOp(e.op)) {
            return isArrayOpValid(e.isUnaExp()!.e1!);
        }
        if (isBinArrayOp(e.op) || isBinAssignArrayOp(e.op) || e.op === EXP.assign) {
            const be: BinExp = e.isBinExp()!;
            return isArrayOpValid(be.e1!) && isArrayOpValid(be.e2!);
        }
        if (e.op === EXP.construct) {
            const be: BinExp = e.isBinExp()!;
            return be.e1!.op === EXP.slice && isArrayOpValid(be.e2!);
        }
        // if (e.op == EXP.call)
        // {
        // TODO: Decide if [] is required after arrayop calls.
        // }
        return false;
    }
    return true;
}

/// dmd/arrayop.d:77 — `bool isNonAssignmentArrayOp(Expression e)`.
export function isNonAssignmentArrayOp(e: Expression): boolean {
    if (e.op === EXP.slice)
        return isNonAssignmentArrayOp(e.isSliceExp()!.e1!);

    const tb: Type = toBasetype(e.type!);
    if (tb.isStaticOrDynamicArray()) {
        return (isUnaArrayOp(e.op) || isBinArrayOp(e.op));
    }
    return false;
}

/**
 * dmd/arrayop.d:90 — `bool checkNonAssignmentArrayOp(Expression e, bool suggestion = false)`.
 *
 * Diagnose an array operation whose result has nowhere to go (`a[] + b[];` as a statement).
 * Preconditions: `e.type` is set (D dereferences it unconditionally at arrayop.d:82).
 * Returns: true IF the error was emitted — the caller then bails out.
 * Cost: `isNonAssignmentArrayOp` only; the `%s` rendering runs only on the error path.
 */
export function checkNonAssignmentArrayOp(e: Expression, suggestion = false): boolean {
    if (isNonAssignmentArrayOp(e)) {
        let s: DString = ds("");
        if (suggestion)
            s = ds(" (possible missing [])");
        error(e.loc, ds("array operation `%s` without destination memory not allowed%s"), e.toChars(), s);
        return true;
    }
    return false;
}

// dmd/arrayop.d:136 — `__gshared TemplateDeclaration arrayOp;`, declared INSIDE
// `arrayOp(BinExp, Scope*)` (arrayop.d:118). Hoisted to module state per 01 §5.5 ("a
// FUNCTION-LOCAL `__gshared` is module state, not a local"): program lifetime, shared across
// calls, filled once with `object._arrayOp`. Renamed only because D's declaration shadows the
// module-level function `arrayOp`, which TS cannot express at module scope.
let arrayOpTemplate: TemplateDeclaration | null = null;

/// Reset of the `arrayOpTemplate` cache (01 §5.5 rule 3). No D counterpart — D is a one-shot process; called
/// by the test harness and by the djs driver between two compiles (src/djs.ts `deinitializeFrontend`), never by
/// frontend code.
export function _resetArrayOpTemplate(): void {
    arrayOpTemplate = null;
}

/***********************************
 * dmd/arrayop.d:118 — `Expression arrayOp(BinExp e, Scope* sc)`.
 * Form-B sibling of `arrayOp` (the BinAssignExp form) below; see the file header for which side
 * keeps the bare name and why. D call site: expressionsem.d:13136 (`visit(AssignExp)`).
 * Construct the array operation expression, call object._arrayOp!(tiargs)(args).
 *
 * Encode operand types and operations into tiargs using reverse polish notation (RPN) to preserve
 * precedence. Unary operations are prefixed with "u" (e.g. "u~").
 * Pass operand values (slices or scalars) as args.
 *
 * Scalar expression sub-trees of `e` are evaluated before calling
 * into druntime to hoist them out of the loop. This is a valid
 * evaluation order as the actual array operations have no
 * side-effect.
 * References:
 * https://github.com/dlang/dmd/blob/cdfadf8a18f474e6a1b8352af2541efe3e3467cc/druntime/src/object.d#L4694
 * https://github.com/dlang/dmd/blob/master/druntime/src/core/internal/array/operations.d
 */
export function arrayOpBinExp(e: BinExp, sc: Scope): Expression {
    //printf("BinExp.arrayOp() %s\n", e.toChars());
    const tb: Type = toBasetype(e.type!);
    assert(tb.isStaticOrDynamicArray());
    const tbn: Type = toBasetype(nextOf(tb)!);
    if (tbn.ty === Tvoid) {
        error(e.loc, ds("cannot perform array operations on `void[]` arrays"));
        return ErrorExp.get();
    }
    if (!isArrayOpValid(e))
        return arrayOpInvalidError(e);

    const tiargs: Objects = new DArray<RootObject | null>(); // `auto tiargs = new Objects();`
    const args: Expressions = buildArrayOp(sc, e, tiargs);

    // `import dmd.dtemplate : TemplateDeclaration;` (arrayop.d:135) — a function-local selective
    // import; the type is imported at module scope here (`import type`).
    if (arrayOpTemplate === null) {
        // Create .object._arrayOp
        const idArrayOp: Identifier = Identifier.idPool(ds("_arrayOp"));
        let id: Expression = new IdentifierExp(e.loc, Id.empty);
        id = new DotIdExp(e.loc, id, Id.object);
        id = new DotIdExp(e.loc, id, idArrayOp);

        id = expressionSemantic(id, sc);
        const te = id.isTemplateExp();
        if (te !== null)
            arrayOpTemplate = te.td;
        else {
            ObjectNotFound(e.loc, idArrayOp); // fatal error
            return ErrorExp.get();
        }
    }

    const fd = resolveFuncCall(e.loc, sc, arrayOpTemplate, tiargs, null, new ArgumentList(args),
        FuncResolveFlag.standard);
    if (!fd || fd.errors)
        return ErrorExp.get();
    return expressionSemantic(new CallExp(e.loc, new VarExp(e.loc, fd, false), args), sc);
}

/// ditto — dmd/arrayop.d:162 — `Expression arrayOp(BinAssignExp e, Scope* sc)`.
/// Form-B sibling of `arrayOpBinExp` above (04 §1B); this form keeps the BARE name, being the
/// cross-module contract (04 §1B rule 1 — see the file header). D call sites:
/// expressionsem.d:9307 (`visit(BinAssignExp)`) and :13393 (`visit(PowAssignExp)`).
export function arrayOp(e: BinAssignExp, sc: Scope): Expression {
    //printf("BinAssignExp.arrayOp() %s\n", e.toChars());

    /* Check that the elements of e1 can be assigned to
     */
    const tn: Type | null = nextOf(toBasetype(e.e1!.type!));

    if (tn && (!tn.isMutable() || !isAssignable(tn))) {
        error(e.loc, ds("slice `%s` is not mutable"), e.e1!.toChars());
        if (e.op === EXP.addAssign)
            checkPossibleAddCatError_AddAssignExp(e.isAddAssignExp()!);
        return ErrorExp.get();
    }
    if (e.e1!.op === EXP.arrayLiteral) {
        return modifiableLvalue(e.e1!, sc);
    }

    return arrayOpBinExp(e.isBinExp()!, sc);
}

/******************************************
 * dmd/arrayop.d:190 — `private Expressions* buildArrayOp(Scope* sc, Expression e, Objects* tiargs)`.
 * Convert the expression tree e to template and function arguments,
 * using reverse polish notation (RPN) to encode order of operations.
 * Encode operations as string arguments, using a "u" prefix for unary operations.
 *
 * D module-private (10 §1.7): reachable from this module's own top-level functions only, and
 * exported here so arrayop.test.ts can pin the visitor's dispatch.
 */
export function buildArrayOp(sc: Scope, e: Expression, tiargs: Objects): Expressions {
    // dmd/arrayop.d:192 — `extern (C++) final class BuildArrayOpVisitor : Visitor`, declared inside
    // this function in D and inside it here. `alias visit = Visitor.visit;` (arrayop.d:194) is
    // DROPPED (13 §1 — no overload hiding in TS); each `visit(X)` overload becomes `visitX`.
    class BuildArrayOpVisitor extends Visitor {
        sc: Scope;
        tiargs: Objects;
        args: Expressions;

        // dmd/arrayop.d:200 — `extern (D) this(Scope* sc, Objects* tiargs) scope @safe`
        // (`scope`/`@safe` erased, 04 attribute erasure).
        constructor(sc: Scope, tiargs: Objects) {
            super();
            this.sc = sc;
            this.tiargs = tiargs;
            this.args = new DArray<Expression | null>(); // `new Expressions()`
        }

        /// dmd/arrayop.d:207 — `override void visit(Expression e)`.
        override visitExpression(e: Expression): void {
            this.tiargs.push(e.type);
            this.args.push(e);
        }

        /// dmd/arrayop.d:213 — `override void visit(SliceExp e)`.
        override visitSliceExp(e: SliceExp): void {
            this.visitExpression(e); // `visit(cast(Expression) e)` (13 §4)
        }

        /// dmd/arrayop.d:218 — `override void visit(CastExp e)`.
        override visitCastExp(e: CastExp): void {
            this.visitExpression(e); // `visit(cast(Expression) e)` (13 §4)
        }

        /// dmd/arrayop.d:223 — `override void visit(UnaExp e)`.
        override visitUnaExp(e: UnaExp): void {
            const tb: Type = toBasetype(e.type!);
            if (tb.ty !== Tarray && tb.ty !== Tsarray) { // hoist scalar expressions
                this.visitExpression(e); // `visit(cast(Expression) e)` (13 §4)
            } else {
                // RPN, prefix unary ops with u
                const buf = new OutBuffer();
                buf.writestring(ds("u"));
                buf.writestring(EXPtoString(e.op));
                e.e1!.accept(this);
                // `buf.extractSlice()` CONSUMES the buffer here exactly as D does (08 §13a.2):
                // `buf` dies at the end of this branch, so the view-vs-consume choice is D's own.
                this.tiargs.push(expressionSemantic(new StringExp(Loc.initial, [...buf.extractSlice()]), this.sc));
            }
        }

        /// dmd/arrayop.d:241 — `override void visit(BinExp e)`.
        override visitBinExp(e: BinExp): void {
            const tb: Type = toBasetype(e.type!);
            if (tb.ty !== Tarray && tb.ty !== Tsarray) { // hoist scalar expressions
                this.visitExpression(e); // `visit(cast(Expression) e)` (13 §4)
            } else {
                // RPN
                e.e1!.accept(this);
                e.e2!.accept(this);
                this.tiargs.push(expressionSemantic(new StringExp(Loc.initial, [...EXPtoString(e.op)]), this.sc));
            }
        }
    }

    const v = new BuildArrayOpVisitor(sc, tiargs); // `scope v = ...` — `scope` erased (04)
    e.accept(v);
    return v.args;
}

/***********************************************
 * dmd/arrayop.d:271 — `bool isArrayOpImplicitCast(TypeDArray tfrom, TypeDArray tto)`.
 * Some implicit casting can be performed by the _arrayOp template.
 * Params:
 *      tfrom = type converting from
 *      tto   = type converting to
 * Returns:
 *      true if can be performed by _arrayOp
 */
export function isArrayOpImplicitCast(tfrom: TypeDArray, tto: TypeDArray): boolean {
    const tyf = toBasetype(nextOf(tfrom)!).ty;
    const tyt = toBasetype(nextOf(tto)!).ty;
    // D `||`/`&&` precedence: `&&` binds tighter, so this is `tyf == tyt || (tyf == Tint32 && tyt == Tfloat64)`.
    return tyf === tyt ||
        (tyf === Tint32 && tyt === Tfloat64);
}

/***********************************************
 * dmd/arrayop.d:282 — `bool isUnaArrayOp(EXP op) @safe`.
 * Test if expression is a unary array op.
 */
export function isUnaArrayOp(op: EXP): boolean {
    switch (op) {
        case EXP.negate:
        case EXP.tilde:
            return true;
        default:
            return false;
    }
}

/***********************************************
 * dmd/arrayop.d:297 — `bool isBinArrayOp(EXP op) @safe`.
 * Test if expression is a binary array op.
 */
export function isBinArrayOp(op: EXP): boolean {
    switch (op) {
        case EXP.add:
        case EXP.min:
        case EXP.mul:
        case EXP.div:
        case EXP.mod:
        case EXP.xor:
        case EXP.and:
        case EXP.or:
        case EXP.pow:
            return true;
        default:
            return false;
    }
}

/***********************************************
 * dmd/arrayop.d:319 — `bool isBinAssignArrayOp(EXP op) @safe`.
 * Test if expression is a binary assignment array op.
 */
export function isBinAssignArrayOp(op: EXP): boolean {
    switch (op) {
        case EXP.addAssign:
        case EXP.minAssign:
        case EXP.mulAssign:
        case EXP.divAssign:
        case EXP.modAssign:
        case EXP.xorAssign:
        case EXP.andAssign:
        case EXP.orAssign:
        case EXP.powAssign:
            return true;
        default:
            return false;
    }
}

/***********************************************
 * dmd/arrayop.d:341 — `bool isArrayOpOperand(Expression e)`.
 * Test if operand is a valid array op operand.
 */
export function isArrayOpOperand(e: Expression): boolean {
    //printf("Expression.isArrayOpOperand() %s\n", e.toChars());
    if (e.op === EXP.slice)
        return true;
    if (e.op === EXP.arrayLiteral) {
        let t: Type = toBasetype(e.type!);
        while (t.isStaticOrDynamicArray())
            t = toBasetype(nextOf(t)!);
        return (t.ty !== Tvoid);
    }
    const tb: Type = toBasetype(e.type!);
    if (tb.ty === Tarray) {
        return (isUnaArrayOp(e.op) ||
            isBinArrayOp(e.op) ||
            isBinAssignArrayOp(e.op) ||
            e.op === EXP.assign);
    }
    return false;
}

/***************************************************
 * dmd/arrayop.d:373 — `ErrorExp arrayOpInvalidError(Expression e)`.
 * Print error message about invalid array operation.
 * Params:
 *      e = expression with the invalid array operation
 * Returns:
 *      instance of ErrorExp
 */
export function arrayOpInvalidError(e: Expression): ErrorExp {
    error(e.loc, ds("invalid array operation `%s` (possible missing [])"), e.toChars());
    if (e.op === EXP.add)
        checkPossibleAddCatError_AddExp(e.isAddExp()!);
    else if (e.op === EXP.addAssign)
        checkPossibleAddCatError_AddAssignExp(e.isAddAssignExp()!);
    return ErrorExp.get();
}

/**
 * dmd/arrayop.d:383 — `private void checkPossibleAddCatError(AddT, CatT)(AddT ae)`,
 * instantiation `!(AddExp, CatExp)` (arrayop.d:377). Monomorphized per 07 §3.4.
 *
 * D module-private, and NOT exported: its only caller is `arrayOpInvalidError` above, a sibling in
 * this same module — a non-exported TS module-level function reproduces D's module scope exactly.
 */
function checkPossibleAddCatError_AddExp(ae: AddExp): void {
    if (!ae.e2!.type || ae.e2!.type.ty !== Tarray || implicitConvToType(ae.e2!.type, ae.e1!.type!) === MATCH.nomatch)
        return;
    const ce: CatExp = new CatExp(ae.loc, ae.e1, ae.e2);
    errorSupplemental(ae.loc, ds("did you mean to concatenate (`%s`) instead ?"), ce.toChars());
}

/**
 * dmd/arrayop.d:383 — `private void checkPossibleAddCatError(AddT, CatT)(AddT ae)`,
 * instantiation `!(AddAssignExp, CatAssignExp)` (arrayop.d:174, arrayop.d:379).
 * Monomorphized per 07 §3.4.
 *
 * D module-private, and NOT exported: its only callers are `arrayOp` and `arrayOpInvalidError`
 * above, siblings in this same module — a non-exported TS module-level function reproduces D's
 * module scope exactly.
 */
function checkPossibleAddCatError_AddAssignExp(ae: AddAssignExp): void {
    if (!ae.e2!.type || ae.e2!.type.ty !== Tarray || implicitConvToType(ae.e2!.type, ae.e1!.type!) === MATCH.nomatch)
        return;
    const ce: CatAssignExp = new CatAssignExp(ae.loc, ae.e1, ae.e2);
    errorSupplemental(ae.loc, ds("did you mean to concatenate (`%s`) instead ?"), ce.toChars());
}
