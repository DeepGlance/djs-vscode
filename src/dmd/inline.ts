// Ported from dmd/inline.d (module dmd.inline).
//
// "Performs inlining, which is an optimization pass enabled with the `-inline` flag. The AST is
// traversed, and every function call is considered for inlining using `inlinecost.d`. The function
// call is then inlined if this cost is below a threshold."
//
// Top-level D declarations, in source order: the three public entry points `inlineScanPragmaInline`
// (:62), `inlineScanAllFunctions` (:77) and `inlineCopy` (:92); after `private:` (:123) the gate
// constants `LOG`/`CANINLINE_LOG`/`EXPANDINLINE_LOG` (:127-129), `InlineDoState` (:141), the class
// template `DoInlineAs(Result)` (:169), the two `doInlineAs(Result)` function templates (:1097,
// :1108), `InlineScanVisitor` (:1122), `InlineScanVisitorDsymbol` (:1820), `inlineScanModule`
// (:1945), `canInline` (:1979), `expandInline` (:2235), `onlyOneAssign` (:2531),
// `argumentsNeedDtors` (:2547) and `expNeedsDtor` (:2569, with its nested `NeedsDtor` class).
// No unittest blocks.
//
// LIVENESS (ldc2 1.43.0) — every declaration is translated; only this subset runs under LDC:
//   - LIVE: `inlineCopy` (:92), called from the default-argument leg of `functionParameters`
//     (expressionsem.d:4253) for every call that supplies a default argument. It drives
//     `inlineCostExpression` (inlinecost.d:69) and `DoInlineAs!Expression` over an Expression.
//     With `InlineDoState.fd === null`, `eret === null` and `vthis === null`, the NRVO legs, the
//     `this`/`super` rewrites and the context-pointer walk of `visitVarExp` are not reached from it;
//     the copy legs (every `e.copy()` visit, the `lengthVar`/`DeclarationExp` renames, the
//     `semanticTypeInfo` calls) are.
//   - NOT RUN by ldc2: the whole scan — `inlineScanPragmaInline`, `inlineScanAllFunctions`,
//     `inlineScanModule`, `canInline`, `expandInline`, both scan visitors, `onlyOneAssign`,
//     `argumentsNeedDtors`, `expNeedsDtor`, and `DoInlineAs_Statement`. Their only callers are
//     dmd/main.d:777-797, which sits in the `else` arm of `version (IN_LLVM)` (main.d:771); LDC
//     runs `extraLDCSpecificSemanticAnalysis` there instead, and driver/main.cpp calls neither scan
//     (LLVM does the inlining). They are ported 1:1 anyway: nothing in inline.d itself is versioned
//     out, and no guide rule sanctions a whole-declaration drop of reachable-by-signature code.
//
// TEMPLATE MONOMORPHIZED (07 §3.4 / §9, the `enum asStatements` worked example is this file).
// `DoInlineAs(Result)` is instantiated at `Result == Statement` and `Result == Expression`; each is
// emitted as a concrete class, `DoInlineAs_Statement` / `DoInlineAs_Expression` (the arrayop.ts
// `_<Arg>` suffix precedent), with every `static if (asStatements)` resolved in place. The statement
// visits appear in both classes, each resolved for its `Result`. The two `doInlineAs(Result)`
// function templates split on their FIRST parameter (Statement / Expression) and on `Result`; three
// instantiations occur in inline.d, and `doInlineAs!Statement(Expression)` never does:
//   - `doInlineAs!Expression(Expression)` -> `doInlineAs_Expression` (bare receiver name: the
//     Expression-receiver form is the most-called, 04 §1 rule 1),
//   - `doInlineAs!Expression(Statement)`  -> `doInlineAsStatement_Expression` (rule 2 receiver suffix),
//   - `doInlineAs!Statement(Statement)`   -> `doInlineAsStatement_Statement`.
//
// VISITOR IDIOM (13-visitor.md): Idiom A. `DoInlineAs`, `InlineScanVisitor`,
// `InlineScanVisitorDsymbol` and `NeedsDtor` are real classes; `visit(X)` -> `visitX` (§1); every
// `alias visit = …` is dropped (§1); `visit(cast(Base)e)` -> `this.visitBase(e)` (§4).
// HELPER-NAME COLLISION (13 §5, a new case): InlineScanVisitor's four-parameter helper
// `void visitCallExp(CallExp e, Expression eret, bool asStatements, bool propagateNRVO)` (inline.d:1593)
// shares its name with the §1 slot `visitCallExp` of `visit(CallExp)` (inline.d:1574), which calls it.
// The slot keeps the bare name; the helper is `visitCallExpHelper`, and every D call of the helper
// (inline.d:1171, :1327, :1520, :1577) is rewritten to it.
//
// REF SLOTS (03 §7.3). `InlineScanVisitor.inlineScan(ref Statement)` / `inlineScan(ref Expression)`
// and the nested `inlineScanExpAsStatement(ref Expression)` write a replacement node back into the
// caller's slot, which is a field of an AST node, an array element or a local. Each `ref` parameter
// is an accessor pair (`StatementSlot`, precedent statement_rewrite_walker.ts; `ExpressionSlot` here),
// built at the call site with `fieldSlot` / `elementSlot`. The two `inlineScan` overloads are Form B
// (04 §1, same arity, different types): the Expression form keeps the bare name (most-called), the
// Statement form is `inlineScanStatement`.
//
// OUT PARAMETERS (03 §3.3): `expandInline`'s `out eresult/sresult/again` and `resolveCallTarget`'s
// `out explicitThis` are `{ value }` boxes, reset on entry by the callee as D resets them.
//
// VERSION / DEBUG RESOLUTION (07): the gate constants are dropped with all their `static if`
// blocks; the three `version (IN_LLVM) {} else { vto.csym = null; }` blocks (:764, :982, :1013) are
// dropped (the backend `csym` field does not exist under LDC); the `version (none)` block at :732 is
// dropped (07 §1.4). The `printf`/`fflush` before `assert(0)` in `visit(Statement)` (:188-189) is
// the developer trace of 07 §2.1 and is dropped.
//
// MEMCPY CLONES (inline.d:762, :980, :1011): `new VarDeclaration(...)` followed by
// `memcpy(vto, vd, __traits(classInstanceSize, VarDeclaration))` is ported as `Object.assign(vto,
// vd)` plus a fresh copy of each INLINE value struct of the Dsymbol/Declaration/VarDeclaration
// hierarchy (`visibility`, `nestedrefs`, `alignment`), which a byte copy duplicates and
// `Object.assign` would alias (the mtype.ts `Type.copy` precedent). `loc` is shared (03 §9.1).
//
// PAIRED STATE (11 §2.5): five set/reset regions (three fields) live on AST nodes that outlive a throw —
// `StructLiteralExp.inlinecopy` (inline.d:1074-1076, LIVE under inlineCopy), `stageflags`
// (:1777-1779) and `FuncDeclaration.inlineNest` (:1877-1880, :2451-2453, :2475-2477). Each region is a
// `try { … } finally { <D's release> }`: on the normal path the release runs exactly where D runs it,
// and a wall thrown by a callee (semanticTypeInfo, initializerToExpression, …) cannot leak the state.
//
// DEFERRED CALLEES: none. This module carries no wall.

import { STC, LINK, VarArg, PINLINE } from "./astenums.js";
import { Taarray, Tclass, Tdelegate, Tnoreturn, Tpointer, Tsarray, Tstruct, Ttuple, Tvoid } from "./astenums.js";
import type { Dsymbol } from "./dsymbol.js";
import type { Dsymbols, Expressions, Statements } from "./arraytypes.js";
import type { AggregateDeclaration } from "./aggregate.js";
import type { AttribDeclaration } from "./attrib.js";
import type { Module } from "./dmodule.js";
import type { Scope } from "./dscope.js";
import type { TemplateInstance } from "./dtemplate.js";
import type { ErrorSink } from "./errorsink.js";
import type {
    ArrayExp,
    AssertExp,
    AssignExp,
    AssocArrayLiteralExp,
    BinExp,
    CallExp,
    CatAssignExp,
    CatExp,
    EqualExp,
    LoweredAssignExp,
    NewExp,
    SliceExp,
    StructLiteralExp,
    SuperExp,
    SymOffExp,
    ThisExp,
    TupleExp,
    TypeidExp,
    UnaExp,
} from "./expression.js";
import type { FuncDeclaration } from "./func.js";
import type { TypeFunction } from "./mtype.js";
import type {
    CaseStatement,
    DefaultStatement,
    DoStatement,
    ForeachRangeStatement,
    ForeachStatement,
    LabelStatement,
    SwitchStatement,
    SynchronizedStatement,
    TryCatchStatement,
    WhileStatement,
    WithStatement,
    ImportStatement,
} from "./statement.js";
import type { StatementSlot } from "./visitor/statement_rewrite_walker.js";
import { assert, assertUnreachable } from "../assert.js";
import { ds } from "../dstring.js";
// Value imports, AST-node modules first and the visitor base LAST among the load-time ones
// (01 §4.8): `Visitor`/`StoppableVisitor` are the `extends` operands of the module-level classes.
import {
    AddExp,
    AddrExp,
    ArrayLiteralExp,
    BlitExp,
    CastExp,
    CondExp,
    ConstructExp,
    DeclarationExp,
    DotVarExp,
    ErrorExp,
    Expression,
    IndexExp,
    IntegerExp,
    LogicalExp,
    NullExp,
    PtrExp,
    StructLiteralExpStageFlags,
    ThrowExp,
    VarExp,
} from "./expression.js";
import {
    CompoundStatement,
    DtorExpStatement,
    ExpStatement,
    ForStatement,
    IfStatement,
    ReturnStatement,
    ScopeStatement,
    Statement,
    ThrowStatement,
    TryFinallyStatement,
    UnrolledLoopStatement,
} from "./statement.js";
import { VarDeclaration } from "./declaration.js";
import { ExpInitializer, VoidInitializer } from "./init.js";
import { Type } from "./mtype.js";
import { Identifier } from "./identifier.js";
import { Id } from "./id.js";
import { Loc } from "./location.js";
import { EXP } from "./tokens.js";
import { Array as DArray } from "./root/array.js";
import { global, DiagnosticReporting } from "./globals.js";
import { ILS } from "./func.js";
import { messageNoLoc } from "./errors.js";
import { StoppableVisitor, Visitor } from "./visitor/index.js";
import { PASS, foreachDsymbolVoid } from "./dsymbol.js";
import { include, toAlias, followInstantiationContext, toParentP, runDeferredSemantic3 } from "./dsymbolsem.js";
import { isExpression, isType } from "./dtemplate.js";
import { canElideCopy, semanticTypeInfo, toLvalue } from "./expressionsem.js";
import { functionSemantic3, hasNestedFrameRefs, isVirtual } from "./funcsem.js";
import { initializerToExpression } from "./initsem.js";
import { baseElemOf, nextOf, pointerTo, sarrayOf, toBasetype } from "./typesem.js";
import { walkPostorder } from "./visitor/postorder.js";
import {
    COST_MAX, inlineCostExpression, inlineCostFunction, isInlinableNestedAggregate, tooCostly,
} from "./inlinecost.js";

/**
 * The accessor pair for a D `ref Expression` bound to a slot (03 §7.3): `get` reads the slot, `set`
 * writes it. Method shorthand keeps the parameter bivariant, so a slot over a non-null field is
 * accepted where D's `ref Expression` would be.
 */
interface ExpressionSlot {
    get(): Expression | null;
    set(v: Expression | null): void;
}

/**
 * Port-invented (no D symbol: D passes the field lvalue itself to a `ref` parameter). Builds the
 * accessor pair over `o[k]` for a `ref` argument that names a field.
 */
function fieldSlot<O, K extends keyof O>(o: O, k: K): { get(): O[K]; set(v: O[K]): void } {
    return { get: () => o[k], set: (v: O[K]) => { o[k] = v; } };
}

/**
 * Port-invented (no D symbol: D passes `(*arr)[i]`, a `ref`-returning index, to a `ref` parameter).
 * Builds the accessor pair over element `i` of `arr`.
 */
function elementSlot<T>(arr: DArray<T>, i: number): { get(): T; set(v: T): void } {
    return { get: () => arr.opIndex(i), set: (v: T) => { arr.opIndexAssign(v, i); } };
}

/***********************************************************
 * dmd/inline.d:62 — `public void inlineScanPragmaInline(Module m, ErrorSink eSink)`.
 * Scan for always-inline functions in Module m to be inlined,
 * and inline them in situ.
 *
 * Not run by ldc2 (see the file header): its only caller is dmd/main.d:784, in the `!IN_LLVM` arm.
 * Precondition: none; a module not yet through semantic3 is skipped.
 */
export function inlineScanPragmaInline(m: Module, eSink: ErrorSink): void {
    if (m.semanticRun !== PASS.semantic3done)
        return;

    inlineScanModule(m, PASS.inlinePragma, eSink);
}

/***********************************************************
 * dmd/inline.d:77 — `public void inlineScanAllFunctions(Module m, ErrorSink eSink)`.
 * Scan all functions in Module m and try to inline them in situ.
 *
 * Not run by ldc2 (see the file header): its only caller is dmd/main.d:795, in the `!IN_LLVM` arm.
 */
export function inlineScanAllFunctions(m: Module, eSink: ErrorSink): void {
    if (m.semanticRun !== PASS.semantic3done && m.semanticRun !== PASS.inlinePragma)
        return;

    inlineScanModule(m, PASS.inlineAll, eSink);
}

/***********************************************************
 * dmd/inline.d:92 — `public Expression inlineCopy(Expression e, Scope* sc)`.
 * Perform the "inline copying" of a default argument for a function parameter.
 *
 * Returns a copy of `e` whose declarations and `lengthVar`s are renamed into `sc.parent`, or
 * `ErrorExp` after reporting "cannot inline default argument" when `e` costs `COST_MAX` or more
 * (a nested function literal, a `this` reference, …). A delegate to a nested function is copied
 * shallowly, its `this` check deferred.
 * Live under LDC: the default-argument leg of `functionParameters` (expressionsem.d:4253).
 *
 * Todo:
 *  The hack for https://issues.dlang.org/show_bug.cgi?id=4820 case is still questionable.
 *  Perhaps would have to handle a delegate expression with 'null' context properly in front-end.
 */
export function inlineCopy(e: Expression, sc: Scope): Expression {
    /* See https://issues.dlang.org/show_bug.cgi?id=2935
     * for explanation of why just a copy() is broken
     */
    const de = e.isDelegateExp();
    if (de !== null) {
        if (de.func!.isNested()) {
            /* https://issues.dlang.org/show_bug.cgi?id=4820
             * Defer checking until later if we actually need the 'this' pointer
             */
            return de.copy();
        }
    }
    const cost = inlineCostExpression(e);
    if (cost >= COST_MAX) {
        sc.eSink!.error(e.loc, ds("cannot inline default argument `%s`"), e.toChars());
        return ErrorExp.get();
    }
    const ids = new InlineDoState(sc.parent, null);
    return doInlineAs_Expression(e, ids)!;
}

// inline.d:123 `private:` — everything below is module-private and not exported.

// dropped: enum LOG = false; enum CANINLINE_LOG = false; enum EXPANDINLINE_LOG = false (gate
// constants; all static-if(LOG/CANINLINE_LOG/EXPANDINLINE_LOG) blocks dropped — dmd/inline.d:127-129)

/***********************************************************
 * dmd/inline.d:141 — `private final class InlineDoState`.
 * Represent a context to inline statements and expressions.
 *
 * Todo:
 *  It would be better to make foundReturn an instance field of DoInlineAs visitor class,
 *  like as DoInlineAs!Result.result field, because it's one another result of inlining.
 *  The best would be to return a pair of result Expression and a bool value as foundReturn
 *  from doInlineAs function.
 */
class InlineDoState {
    // inline context
    eret: Expression | null = null;    // expression returned to in case of NRVO
    vthis: VarDeclaration | null = null;
    from: Dsymbols = new DArray<Dsymbol | null>();      // old Dsymbols
    to: Dsymbols = new DArray<Dsymbol | null>();        // parallel array of new Dsymbols
    parent: Dsymbol | null;     // new parent
    fd: FuncDeclaration | null; // function being inlined (old parent)
    // inline result
    foundReturn = false;
    propagateNRVO = false;

    /// dmd/inline.d:154 — `this(Dsymbol parent, FuncDeclaration fd) scope`.
    constructor(parent: Dsymbol | null, fd: FuncDeclaration | null) {
        this.parent = parent;
        this.fd = fd;
    }
}

/**
 * Port-invented (no D symbol: D writes the three statements inline at inline.d:761-764, :979-983
 * and :1010-1014). The byte clone `new VarDeclaration(vd.loc, vd.type, vd.ident, vd._init)` +
 * `memcpy(vto, vd, __traits(classInstanceSize, VarDeclaration))` (07 §7.1 elides the size): every
 * field is copied by reference, and each inline value struct gets its own copy (file header).
 */
function cloneVarDeclaration(vd: VarDeclaration): VarDeclaration {
    const vto = new VarDeclaration(vd.loc, vd.type, vd.ident!, vd._init);
    Object.assign(vto, vd);
    vto.visibility = vd.visibility.copy();
    vto.nestedrefs = vd.nestedrefs.copy();
    vto.alignment = vd.alignment.copy();
    return vto;
}

/***********************************************************
 * dmd/inline.d:169 — `private extern (C++) final class DoInlineAs(Result) : Visitor`, instantiation
 * `Result == Statement` (07 §3.4; `enum asStatements = is(Result == Statement)` (:177) resolved to
 * `true` throughout).
 * Perform the inlining from (Statement or Expression) to Statement.
 *
 * Inlining is done by:
 *  - Converting to an Expression
 *  - Copying the trees of the function to be inlined
 *  - Renaming the variables
 */
class DoInlineAs_Statement extends Visitor {
    // dropped: alias visit = Visitor.visit — no overload hiding in TS (13 §1)
    ids: InlineDoState;
    result: Statement | null = null;

    /// dmd/inline.d:179 — `extern (D) this(InlineDoState ids) scope`.
    constructor(ids: InlineDoState) {
        super();
        this.ids = ids;
    }

    // Statement -> (Statement | Expression)

    override visitStatement(_s: Statement): void {
        // dropped: printf/fflush developer trace before assert(0) (07 §2.1) — dmd/inline.d:188-189
        assertUnreachable(); // default is we can't inline it
    }

    override visitExpStatement(s: ExpStatement): void {
        const exp = doInlineAs_Expression(s.exp, this.ids);
        // resolved: static if (asStatements) -> true (Result=Statement) — dmd/inline.d:202
        this.result = new ExpStatement(s.loc, exp);
    }

    override visitCompoundStatement(s: CompoundStatement): void {
        // resolved: static if (asStatements) -> true (Result=Statement) — dmd/inline.d:211
        const as: Statements = new DArray<Statement | null>();
        as.reserve(s.statements!.length);

        for (let i = 0; i < s.statements!.length; i++) {
            const sx = s.statements!.opIndex(i);
            if (sx === null)
                continue;
            // resolved: static if (asStatements) -> true (Result=Statement) — dmd/inline.d:221
            as.push(doInlineAsStatement_Statement(sx, this.ids));

            if (this.ids.foundReturn)
                break;
        }

        this.result = new CompoundStatement(s.loc, as);
    }

    override visitUnrolledLoopStatement(s: UnrolledLoopStatement): void {
        const as: Statements = new DArray<Statement | null>();
        as.reserve(s.statements!.length);

        for (const sx of s.statements!) {
            if (sx === null)
                continue;
            const r = doInlineAsStatement_Statement(sx, this.ids);
            as.push(r);

            if (this.ids.foundReturn)
                break;
        }

        this.result = new UnrolledLoopStatement(s.loc, as);
    }

    override visitScopeStatement(s: ScopeStatement): void {
        const r = doInlineAsStatement_Statement(s.statement, this.ids);
        this.result = new ScopeStatement(s.loc, r, s.endloc);
    }

    override visitIfStatement(s: IfStatement): void {
        assert(s.param === null);
        const econd = doInlineAs_Expression(s.condition, this.ids);
        assert(econd !== null);

        const ifbody = doInlineAsStatement_Statement(s.ifbody, this.ids);
        const bodyReturn = this.ids.foundReturn;

        this.ids.foundReturn = false;
        const elsebody = doInlineAsStatement_Statement(s.elsebody, this.ids);

        this.result = new IfStatement(s.loc, s.param, econd, ifbody, elsebody, s.endloc);
        this.ids.foundReturn = this.ids.foundReturn && bodyReturn;
    }

    override visitReturnStatement(s: ReturnStatement): void {
        this.ids.foundReturn = true;

        const exp = doInlineAs_Expression(s.exp, this.ids);
        if (exp === null) // https://issues.dlang.org/show_bug.cgi?id=14560
                          // 'return' must not leave in the expand result
            return;
        /* Any return statement should be the last statement in the function being
         * inlined, otherwise things shouldn't have gotten this far. Since the
         * return value is being ignored (otherwise it wouldn't be inlined as a statement)
         * we only need to evaluate `exp` for side effects.
         * Already disallowed this if `exp` produces an object that needs destruction -
         * an enhancement would be to do the destruction here.
         */
        this.result = new ExpStatement(s.loc, exp);
    }

    override visitImportStatement(_s: ImportStatement): void {
    }

    override visitForStatement(s: ForStatement): void {
        const sinit = doInlineAsStatement_Statement(s._init, this.ids);
        const scond = doInlineAs_Expression(s.condition, this.ids);
        const sincr = doInlineAs_Expression(s.increment, this.ids);
        const sbody = doInlineAsStatement_Statement(s._body, this.ids);
        this.result = new ForStatement(s.loc, sinit, scond, sincr, sbody, s.endloc);
    }

    override visitThrowStatement(s: ThrowStatement): void {
        this.result = new ThrowStatement(s.loc, doInlineAs_Expression(s.exp, this.ids));
    }

    // Expression -> (Statement | Expression)

    // resolved: static if (asStatements) -> true (Result=Statement) — dmd/inline.d:482; the else
    // arm (:489-1094, the expression visits) belongs to DoInlineAs_Expression below
    override visitExpression(e: Expression): void {
        this.result = new ExpStatement(e.loc, doInlineAs_Expression(e, this.ids));
    }
}

/***********************************************************
 * dmd/inline.d:169 — `private extern (C++) final class DoInlineAs(Result) : Visitor`, instantiation
 * `Result == Expression` (07 §3.4; `enum asStatements = is(Result == Statement)` (:177) resolved to
 * `false` throughout).
 * Perform the inlining from (Statement or Expression) to Expression.
 */
class DoInlineAs_Expression extends Visitor {
    // dropped: alias visit = Visitor.visit — no overload hiding in TS (13 §1)
    ids: InlineDoState;
    result: Expression | null = null;

    /// dmd/inline.d:179 — `extern (D) this(InlineDoState ids) scope`.
    constructor(ids: InlineDoState) {
        super();
        this.ids = ids;
    }

    // Statement -> (Statement | Expression)

    override visitStatement(_s: Statement): void {
        // dropped: printf/fflush developer trace before assert(0) (07 §2.1) — dmd/inline.d:188-189
        assertUnreachable(); // default is we can't inline it
    }

    override visitExpStatement(s: ExpStatement): void {
        const exp = doInlineAs_Expression(s.exp, this.ids);
        // resolved: static if (asStatements) -> false (Result=Expression) — dmd/inline.d:202
        this.result = exp;
    }

    override visitCompoundStatement(s: CompoundStatement): void {
        // resolved: static if (asStatements) -> false (Result=Expression) — dmd/inline.d:211, :221, :273
        for (let i = 0; i < s.statements!.length; i++) {
            const sx = s.statements!.opIndex(i);
            if (sx === null)
                continue;
            /* Specifically allow:
             *  if (condition)
             *      return exp1;
             *  return exp2;
             */
            let ifs: IfStatement | null;
            let s3: Statement | null;
            if ((ifs = sx.isIfStatement()) !== null &&
                ifs.ifbody !== null &&
                ifs.ifbody.endsWithReturnStatement() !== null &&
                ifs.elsebody === null &&
                i + 1 < s.statements!.length &&
                (s3 = s.statements!.opIndex(i + 1)) !== null &&
                s3.endsWithReturnStatement() !== null
            ) {
                /* Rewrite as ?:
                 */
                const econd = doInlineAs_Expression(ifs.condition, this.ids);
                assert(econd !== null);
                const e1 = doInlineAsStatement_Expression(ifs.ifbody, this.ids);
                assert(this.ids.foundReturn);
                const e2 = doInlineAsStatement_Expression(s3, this.ids);
                assert(e2 !== null);
                const e: Expression = new CondExp(econd!.loc, econd, e1, e2);
                e.type = e1!.type;
                if (e.type!.ty === Ttuple) {
                    e1!.type = Type.tvoid;
                    e2!.type = Type.tvoid;
                    e.type = Type.tvoid;
                }
                this.result = Expression.combine(this.result, e);
            } else {
                this.ids.foundReturn = false;
                const e = doInlineAsStatement_Expression(sx, this.ids);
                this.result = Expression.combine(this.result, e);
            }

            if (this.ids.foundReturn)
                break;
        }
    }

    override visitUnrolledLoopStatement(s: UnrolledLoopStatement): void {
        for (const sx of s.statements!) {
            if (sx === null)
                continue;
            const r = doInlineAsStatement_Expression(sx, this.ids);
            this.result = Expression.combine(this.result, r);

            if (this.ids.foundReturn)
                break;
        }
    }

    override visitScopeStatement(s: ScopeStatement): void {
        const r = doInlineAsStatement_Expression(s.statement, this.ids);
        this.result = r;
    }

    override visitIfStatement(s: IfStatement): void {
        assert(s.param === null);
        const econd = doInlineAs_Expression(s.condition, this.ids);
        assert(econd !== null);

        const ifbody = doInlineAsStatement_Expression(s.ifbody, this.ids);
        const bodyReturn = this.ids.foundReturn;

        this.ids.foundReturn = false;
        const elsebody = doInlineAsStatement_Expression(s.elsebody, this.ids);

        // resolved: static if (asStatements) -> false (Result=Expression) — dmd/inline.d:326
        const e1 = ifbody;   // `alias e1 = ifbody;`
        const e2 = elsebody; // `alias e2 = elsebody;`
        if (e1 !== null && e2 !== null) {
            this.result = new CondExp(econd!.loc, econd, e1, e2);
            this.result.type = e1.type;
            if (this.result.type!.ty === Ttuple) {
                e1.type = Type.tvoid;
                e2.type = Type.tvoid;
                this.result.type = Type.tvoid;
            }
        } else if (e1 !== null) {
            this.result = new LogicalExp(econd!.loc, EXP.andAnd, econd, e1);
            this.result.type = Type.tvoid;
        } else if (e2 !== null) {
            this.result = new LogicalExp(econd!.loc, EXP.orOr, econd, e2);
            this.result.type = Type.tvoid;
        } else {
            this.result = econd;
        }
        this.ids.foundReturn = this.ids.foundReturn && bodyReturn;
    }

    override visitReturnStatement(s: ReturnStatement): void {
        this.ids.foundReturn = true;

        let exp = doInlineAs_Expression(s.exp, this.ids);
        if (exp === null) // https://issues.dlang.org/show_bug.cgi?id=14560
                          // 'return' must not leave in the expand result
            return;
        // resolved: static if (asStatements) -> false (Result=Expression) — dmd/inline.d:372
        if (this.ids.fd === null || this.ids.fd.isNRVO) {
            this.result = exp;
            return;
        }

        if (this.ids.eret !== null) {
            /* Perform RVO emplacement into eret.
             * Generate:
             *   ( eret ) = ( exp ), ( eret )
             */
            const ce = new ConstructExp(s.loc, this.ids.eret.copy(), exp);
            ce.type = exp.type;
            this.result = Expression.combine(ce, this.ids.eret.copy());
            return;
        }

        const tf: TypeFunction = this.ids.fd.type!.isTypeFunction()!;

        if (exp.type!.ty === Tstruct && !tf.isRef &&
            this.ids.fd.isCtorDeclaration() === null && !canElideCopy(s.exp!, nextOf(tf)!, true)) {
            /* If the inlined function returns a copy of a struct,
             * and then the return value is used subsequently as an
             * lvalue, as in a struct return that is then used as a 'this'.
             * Taking the address of the return value will be taking the address
             * of the original, not the copy. Fix this by assigning the return value to
             * a temporary, then returning the temporary. If the temporary is used as an
             * lvalue, it will work.
             * This only happens with struct returns.
             * See https://issues.dlang.org/show_bug.cgi?id=2127 for an example.
             *
             * On constructor call making __inlineretval is merely redundant, because
             * the returned reference is exactly same as vthis, and the 'this' variable
             * already exists at the caller side.
             *
             * Generate a new variable to hold the result and initialize it with the
             * inlined body of the function:
             *   tret __inlineretval = e;
             */
            const ei = new ExpInitializer(s.loc, exp);
            const tmp = Identifier.generateId(ds("__inlineretval"));
            const vd = new VarDeclaration(s.loc, tf.next, tmp, ei);
            vd.storage_class = (STC.temp | (tf.isRef ? STC.ref_ : STC.rvalue)) as STC; // branded STC re-cast (02 §4.2)
            vd._linkage = tf.linkage;
            vd.parent = this.ids.parent;

            ei.exp = ConstructExp.fromVar(s.loc, vd, exp);
            ei.exp.type = vd.type;

            const de = new DeclarationExp(s.loc, vd);
            de.type = Type.tvoid;

            // Chain the two together:
            //   ( typeof(return) __inlineretval = ( inlined body )) , __inlineretval
            exp = Expression.combine(de, new VarExp(s.loc, vd))!;
        }

        this.result = exp;
    }

    override visitImportStatement(_s: ImportStatement): void {
    }

    override visitForStatement(_s: ForStatement): void {
        // resolved: static if (asStatements) -> false (Result=Expression) — dmd/inline.d:456
        this.result = null;  // cannot be inlined as an Expression
    }

    override visitThrowStatement(s: ThrowStatement): void {
        // resolved: static if (asStatements) -> false (Result=Expression) — dmd/inline.d:471
        this.result = new ThrowExp(s.loc, doInlineAs_Expression(s.exp, this.ids));
        this.result.type = Type.tnoreturn;
    }

    // Expression -> (Statement | Expression)
    // resolved: static if (asStatements) -> false (Result=Expression) — dmd/inline.d:482; the
    // expression visits of the else arm (:489-1094) follow

    /******************************
     * dmd/inline.d:494 — `Expressions* arrayExpressionDoInline(Expressions* a)`.
     * Perform doInlineAs() on an array of Expressions; a null `a` yields null.
     */
    arrayExpressionDoInline(a: Expressions | null): Expressions | null {
        if (a === null)
            return null;

        const newa: Expressions = new DArray<Expression | null>(a.length);

        for (let i = 0; i < a.length; i++) {
            newa.opIndexAssign(doInlineAs_Expression(a.opIndex(i), this.ids), i);
        }
        return newa;
    }

    override visitExpression(e: Expression): void {
        this.result = e.copy();
    }

    override visitSymOffExp(e: SymOffExp): void {
        const ids = this.ids;
        if (ids.eret !== null && ids.fd !== null &&
            (ids.fd.isNRVO && e.var_ === ids.fd.nrvo_var || e.var_.nrvo)) {
            // Deoptimize here and turn SymOffExp back into (&( eret ) + offset),
            // because eret might have no symbol.
            this.result = new AddrExp(e.loc, ids.eret.copy());
            this.result.type = e.type;

            if (e.offset !== 0n) {
                const ie = new IntegerExp(e.loc, e.offset, Type.tsize_t);
                this.result = new AddExp(e.loc, this.result, ie);
                this.result.type = e.type;
            }

            return;
        }
        for (let i = 0; i < ids.from.length; i++) {
            if (e.var_ !== ids.from.opIndex(i))
                continue;
            const se = e.copy().isSymOffExp()!;
            se.var_ = ids.to.opIndex(i)!.isDeclaration()!;
            this.result = se;
            return;
        }
        this.result = e;
    }

    override visitVarExp(e: VarExp): void {
        const ids = this.ids;
        if (ids.eret !== null && ids.fd !== null &&
            (ids.fd.isNRVO && e.var_ === ids.fd.nrvo_var || e.var_.nrvo)) {
            this.result = ids.eret.copy();
            return;
        }
        for (let i = 0; i < ids.from.length; i++) {
            if (e.var_ !== ids.from.opIndex(i))
                continue;
            const ve = e.copy().isVarExp()!;
            ve.var_ = ids.to.opIndex(i)!.isDeclaration()!;
            this.result = ve;
            return;
        }
        if (ids.fd !== null && e.var_ === ids.fd.vthis) {
            this.result = new VarExp(e.loc, ids.vthis!);
            if (ids.fd.hasDualContext)
                this.result = new AddrExp(e.loc, this.result);
            this.result.type = e.type;
            return;
        }

        /* Inlining context pointer access for nested referenced variables.
         * For example:
         *      auto fun() {
         *        int i = 40;
         *        auto foo() {
         *          int g = 2;
         *          struct Result {
         *            auto bar() { return i + g; }
         *          }
         *          return Result();
         *        }
         *        return foo();
         *      }
         *      auto t = fun();
         * 'i' and 'g' are nested referenced variables in Result.bar(), so:
         *      auto x = t.bar();
         * should be inlined to:
         *      auto x = *(t.vthis.vthis + i.voffset) + *(t.vthis + g.voffset)
         */
        const v = e.var_.isVarDeclaration();
        if (v !== null && v.nestedrefs.length && ids.vthis !== null) {
            let s: Dsymbol | null = ids.fd;
            const fdv = v.toParent()!.isFuncDeclaration();
            assert(fdv !== null);
            this.result = new VarExp(e.loc, ids.vthis);
            this.result.type = ids.vthis.type;
            if (ids.fd!.hasDualContext) {
                // &__this
                this.result = new AddrExp(e.loc, this.result);
                this.result.type = pointerTo(ids.vthis.type!);
            }
            while (s !== fdv) {
                const f = s!.isFuncDeclaration();
                let ad: AggregateDeclaration | null = null;
                // `Lad:` — SHARED-ARM (06 §4): the jump at :635 lands in the body of the
                // `else if ((ad = s.isThis()) !is null)` arm; both routes run this loop and then
                // continue after the if-chain.
                const ladArm = (): void => {
                    while (ad !== null) {
                        assert(ad.vthis !== null);
                        // `as unknown as Dsymbol`: audited upcast cascade (02 §11.5) of the `deferred`
                        // field shadow (aggregate.ts) — an AggregateDeclaration IS a Dsymbol.
                        const adSym = ad as unknown as Dsymbol;
                        const i = followInstantiationContext(adSym, fdv);
                        const vthis = i ? ad.vthis2! : ad.vthis!;
                        this.result = new DotVarExp(e.loc, this.result, vthis);
                        this.result.type = vthis.type;
                        s = toParentP(adSym, fdv);
                        ad = s!.isAggregateDeclaration();
                    }
                };
                if (f !== null && f.hasDualContext) {
                    if (hasNestedFrameRefs(f)) {
                        this.result = new DotVarExp(e.loc, this.result, f.vthis!);
                        this.result.type = f.vthis!.type;
                    }
                    // (*__this)[i]
                    const i = followInstantiationContext(f, fdv) ? 1 : 0; // `uint i = <bool>`
                    if (i === 1 && f === ids.fd) {
                        const ve = e.copy().isVarExp()!;
                        ve.originalScope = ids.fd;
                        this.result = ve;
                        return;
                    }
                    this.result = new PtrExp(e.loc, this.result);
                    this.result.type = sarrayOf(Type.tvoidptr, 2n);
                    const ie: IndexExp = new IndexExp(e.loc, this.result, IntegerExp.fromValue(BigInt(i)));
                    ie.indexIsInBounds = true; // no runtime bounds checking
                    this.result = ie;
                    this.result.type = Type.tvoidptr;
                    s = toParentP(f, fdv);
                    ad = s!.isAggregateDeclaration();
                    if (ad !== null)
                        ladArm(); // `goto Lad;` (dmd/inline.d:635)
                    else
                        continue;
                } else if ((ad = s!.isThis()) !== null) {
                    ladArm();
                } else if (f !== null && f.isNested()) {
                    assert(f.vthis !== null);
                    if (hasNestedFrameRefs(f)) {
                        this.result = new DotVarExp(e.loc, this.result, f.vthis!);
                        this.result.type = f.vthis!.type;
                    }
                    s = f.toParent2();
                } else
                    assertUnreachable();
                assert(s !== null);
            }
            this.result = new DotVarExp(e.loc, this.result, v);
            this.result.type = v.type;
            return;
        } else if (v !== null && v.nestedrefs.length) {
            const ve = e.copy().isVarExp()!;
            ve.originalScope = ids.fd;
            this.result = ve;
            return;
        }

        this.result = e;
    }

    override visitThisExp(e: ThisExp): void {
        const ids = this.ids;
        //if (!ids.vthis)
        //    e.error("no `this` when inlining `%s`", ids.parent.toChars());
        if (ids.vthis === null) {
            this.result = e;
            return;
        }
        this.result = new VarExp(e.loc, ids.vthis);
        if (ids.fd!.hasDualContext) {
            // __this[0]
            this.result.type = ids.vthis.type;
            const ie = new IndexExp(e.loc, this.result, IntegerExp.literal(0));
            ie.indexIsInBounds = true; // no runtime bounds checking
            this.result = ie;
            if (e.type!.ty === Tstruct) {
                this.result.type = pointerTo(e.type!);
                this.result = new PtrExp(e.loc, this.result);
            }
        }
        this.result.type = e.type;
    }

    override visitSuperExp(e: SuperExp): void {
        const ids = this.ids;
        if (ids.vthis === null) {
            this.result = e;
            return;
        }
        this.result = new VarExp(e.loc, ids.vthis);
        if (ids.fd!.hasDualContext) {
            // __this[0]
            this.result.type = ids.vthis.type;
            const ie = new IndexExp(e.loc, this.result, IntegerExp.literal(0));
            ie.indexIsInBounds = true; // no runtime bounds checking
            this.result = ie;
        }
        this.result.type = e.type;
    }

    override visitDeclarationExp(e: DeclarationExp): void {
        const ids = this.ids;
        const vd = e.declaration!.isVarDeclaration();
        if (vd !== null) {
            // dropped: version (none) block (disabled upstream: tuple inlining) — dmd/inline.d:732-741

            if (vd.isStatic() || (vd.storage_class & STC.manifest) !== 0n)
                return;

            const varIsNRVO = ids.fd !== null && (ids.fd.isNRVO && vd === ids.fd.nrvo_var || vd.nrvo);

            if (ids.eret !== null && varIsNRVO) {
                if (vd._init !== null && vd._init.isVoidInitializer() === null) {
                    this.result = initializerToExpression(vd._init);
                    assert(this.result !== null);
                    this.result = doInlineAs_Expression(this.result, ids);
                } else
                    this.result = IntegerExp.literal(0);
                return;
            }

            const vto = cloneVarDeclaration(vd); // inline.d:761-762 (file header, MEMCPY CLONES)
            vto.parent = ids.parent;
            // dropped: version (IN_LLVM) {} else { vto.csym = null; } (backend symbol, not in LDC)
            // — dmd/inline.d:764-767
            vto.nrvo = ids.propagateNRVO && varIsNRVO;

            ids.from.push(vd);
            ids.to.push(vto);

            if (vd._init !== null) {
                if (vd._init.isVoidInitializer() !== null) {
                    vto._init = new VoidInitializer(vd._init.loc);
                } else {
                    const ei = initializerToExpression(vd._init);
                    assert(ei !== null);
                    vto._init = new ExpInitializer(ei!.loc, doInlineAs_Expression(ei, ids));
                }
            }
            if (vd.edtor !== null) {
                vto.edtor = doInlineAs_Expression(vd.edtor, ids);
            }
            const de = e.copy().isDeclarationExp()!;
            de.declaration = vto;
            this.result = de;
            return;
        }

        // Prevent the copy of the aggregates allowed in inlineable funcs
        if (isInlinableNestedAggregate(e) !== null)
            return;

        /* This needs work, like DeclarationExp.toElem(), if we are
         * to handle TemplateMixin's. For now, we just don't inline them.
         */
        this.visitExpression(e);
    }

    override visitTypeidExp(e: TypeidExp): void {
        const te = e.copy().isTypeidExp()!;
        const ex = isExpression(te.obj);
        if (ex !== null) {
            te.obj = doInlineAs_Expression(ex, this.ids);
        } else
            assert(isType(te.obj) !== null);
        this.result = te;
    }

    override visitNewExp(e: NewExp): void {
        const ne = e.copy().isNewExp()!;
        const lowering = ne.lowering;
        // `LhasLowering:` — SKIP-FLAG, if/else sub-case (06 §4): the jump at :831 skips exactly the
        // four operand copies, so they become the else arm of the flag.
        let gotoLhasLowering = false;
        if (lowering !== null) {
            const ce = lowering.isCallExp();
            if (ce !== null)
                if (ce.f!.ident === Id._d_newarrayT ||
                    ce.f!.ident === Id._d_newarraymTX ||
                    ce.f!.ident === Id._d_aaNew) {
                    ne.lowering = doInlineAs_Expression(lowering, this.ids);
                    gotoLhasLowering = true; // `goto LhasLowering;` (dmd/inline.d:831)
                }
        }

        if (!gotoLhasLowering) {
            ne.placement = doInlineAs_Expression(e.placement, this.ids);
            ne.thisexp = doInlineAs_Expression(e.thisexp, this.ids);
            ne.argprefix = doInlineAs_Expression(e.argprefix, this.ids);
            ne.arguments_ = this.arrayExpressionDoInline(e.arguments_);
        }

        // LhasLowering:
        this.result = ne;

        semanticTypeInfo(null, e.type);
    }

    override visitUnaExp(e: UnaExp): void {
        // D: `cast(UnaExp)e.copy()` — `copy()` preserves the prototype of `e` (expression.ts), so the
        // clone IS a UnaExp: the same-class copy() re-cast (02 §11.5c rule 5).
        const ue = e.copy() as unknown as UnaExp;
        ue.e1 = doInlineAs_Expression(e.e1, this.ids);
        this.result = ue;
    }

    override visitCastExp(e: CastExp): void {
        // D: `cast(CastExp)e.copy()` — copy() preserves the prototype (02 §11.5c rule 5).
        const ce = e.copy() as unknown as CastExp;
        const lowering = ce.lowering;
        if (lowering !== null) {
            ce.lowering = doInlineAs_Expression(lowering, this.ids);
        } else {
            ce.e1 = doInlineAs_Expression(e.e1, this.ids);
        }

        this.result = ce;
    }

    override visitAssertExp(e: AssertExp): void {
        const ae = e.copy().isAssertExp()!;
        ae.e1 = doInlineAs_Expression(e.e1, this.ids);
        ae.msg = doInlineAs_Expression(e.msg, this.ids);
        this.result = ae;
    }

    override visitCatExp(e: CatExp): void {
        const ce = e.copy().isCatExp()!;

        const lowering = ce.lowering;
        if (lowering !== null)
            ce.lowering = doInlineAs_Expression(lowering, this.ids);
        else {
            ce.e1 = doInlineAs_Expression(e.e1, this.ids);
            ce.e2 = doInlineAs_Expression(e.e2, this.ids);
        }

        this.result = ce;
    }

    override visitCatAssignExp(e: CatAssignExp): void {
        // D: `cast(CatAssignExp) e.copy()` — copy() preserves the prototype (02 §11.5c rule 5).
        const cae = e.copy() as unknown as CatAssignExp;

        const lowering = cae.lowering;
        if (lowering !== null)
            cae.lowering = doInlineAs_Expression(cae.lowering, this.ids);
        else {
            cae.e1 = doInlineAs_Expression(e.e1, this.ids);
            cae.e2 = doInlineAs_Expression(e.e2, this.ids);
        }

        this.result = cae;
    }

    override visitBinExp(e: BinExp): void {
        // D: `cast(BinExp)e.copy()` — copy() preserves the prototype (02 §11.5c rule 5).
        const be = e.copy() as unknown as BinExp;
        be.e1 = doInlineAs_Expression(e.e1, this.ids);
        be.e2 = doInlineAs_Expression(e.e2, this.ids);
        this.result = be;
    }

    override visitCallExp(e: CallExp): void {
        const ce = e.copy().isCallExp()!;
        ce.e1 = doInlineAs_Expression(e.e1, this.ids);
        ce.arguments_ = this.arrayExpressionDoInline(e.arguments_);
        this.result = ce;
    }

    override visitAssignExp(e: AssignExp): void {
        this.visitBinExp(e);
    }

    override visitConstructExp(e: ConstructExp): void {
        if (e.lowering !== null) {
            // D: `cast(ConstructExp)e.copy()` — copy() preserves the prototype (02 §11.5c rule 5).
            const ce = e.copy() as unknown as ConstructExp;
            ce.lowering = doInlineAs_Expression(ce.lowering, this.ids);
            this.result = ce;
        } else
            this.visitAssignExp(e);
    }

    override visitLoweredAssignExp(e: LoweredAssignExp): void {
        this.result = doInlineAs_Expression(e.lowering, this.ids);
    }

    override visitEqualExp(e: EqualExp): void {
        // D: `cast(EqualExp)e.copy()` — copy() preserves the prototype (02 §11.5c rule 5).
        const ee = e.copy() as unknown as EqualExp;
        const lowering = ee.lowering;
        if (lowering !== null) {
            ee.lowering = doInlineAs_Expression(lowering, this.ids);
        }

        ee.e1 = doInlineAs_Expression(e.e1, this.ids);
        ee.e2 = doInlineAs_Expression(e.e2, this.ids);

        this.result = ee;

        const t1: Type = toBasetype(e.e1!.type!);
        if (t1.isStaticOrDynamicArray()) {
            let t: Type = toBasetype(nextOf(t1)!);
            while (nextOf(toBasetype(t)) !== null)
                t = toBasetype(nextOf(t)!);
            if (t.ty === Tstruct)
                semanticTypeInfo(null, t);
        } else if (t1.ty === Taarray) {
            semanticTypeInfo(null, t1);
        }
    }

    override visitIndexExp(e: IndexExp): void {
        const ids = this.ids;
        const are = e.copy().isIndexExp()!;
        are.e1 = doInlineAs_Expression(e.e1, ids);
        if (e.lengthVar !== null) {
            const vd = e.lengthVar;
            const vto = cloneVarDeclaration(vd); // inline.d:979-980 (file header, MEMCPY CLONES)
            vto.parent = ids.parent;
            // dropped: version (IN_LLVM) {} else { vto.csym = null; } (backend symbol, not in LDC)
            // — dmd/inline.d:982-985

            ids.from.push(vd);
            ids.to.push(vto);

            if (vd._init !== null && vd._init.isVoidInitializer() === null) {
                const ie = vd._init.isExpInitializer();
                assert(ie !== null);
                vto._init = new ExpInitializer(ie!.loc, doInlineAs_Expression(ie!.exp, ids));
            }
            are.lengthVar = vto;
        }
        are.e2 = doInlineAs_Expression(e.e2, ids);
        this.result = are;
    }

    override visitSliceExp(e: SliceExp): void {
        const ids = this.ids;
        const are = e.copy().isSliceExp()!;
        are.e1 = doInlineAs_Expression(e.e1, ids);
        if (e.lengthVar !== null) {
            const vd = e.lengthVar;
            const vto = cloneVarDeclaration(vd); // inline.d:1010-1011 (file header, MEMCPY CLONES)
            vto.parent = ids.parent;
            // dropped: version (IN_LLVM) {} else { vto.csym = null; } (backend symbol, not in LDC)
            // — dmd/inline.d:1013-1016

            ids.from.push(vd);
            ids.to.push(vto);

            if (vd._init !== null && vd._init.isVoidInitializer() === null) {
                const ie = vd._init.isExpInitializer();
                assert(ie !== null);
                vto._init = new ExpInitializer(ie!.loc, doInlineAs_Expression(ie!.exp, ids));
            }

            are.lengthVar = vto;
        }
        are.lwr = doInlineAs_Expression(e.lwr, ids);
        are.upr = doInlineAs_Expression(e.upr, ids);
        this.result = are;
    }

    override visitTupleExp(e: TupleExp): void {
        const ce = e.copy().isTupleExp()!;
        ce.e0 = doInlineAs_Expression(e.e0, this.ids);
        ce.exps = this.arrayExpressionDoInline(e.exps);
        this.result = ce;
    }

    override visitArrayLiteralExp(e: ArrayLiteralExp): void {
        const ce = e.copy().isArrayLiteralExp()!;
        ce.basis = doInlineAs_Expression(e.basis, this.ids);
        ce.elements = this.arrayExpressionDoInline(e.elements);
        this.result = ce;

        semanticTypeInfo(null, e.type);
    }

    override visitAssocArrayLiteralExp(e: AssocArrayLiteralExp): void {
        const ce = e.copy().isAssocArrayLiteralExp()!;
        ce.keys = this.arrayExpressionDoInline(e.keys);
        ce.values = this.arrayExpressionDoInline(e.values);
        if (e.lowering !== null)
            ce.lowering = doInlineAs_Expression(e.lowering, this.ids);

        this.result = ce;

        semanticTypeInfo(null, e.type);
    }

    override visitStructLiteralExp(e: StructLiteralExp): void {
        if (e.inlinecopy !== null) {
            this.result = e.inlinecopy;
            return;
        }
        const ce = e.copy().isStructLiteralExp()!;
        e.inlinecopy = ce;
        // Paired state on the AST node (11 §2.5): the reset at inline.d:1076 is guarded so a throw from
        // a callee's wall cannot leave `e.inlinecopy` set; the normal path runs D's reset in place.
        try {
            ce.elements = this.arrayExpressionDoInline(e.elements);
        } finally {
            e.inlinecopy = null;
        }
        this.result = ce;
    }

    override visitArrayExp(_e: ArrayExp): void {
        assertUnreachable(); // this should have been lowered to something else
    }

    override visitCondExp(e: CondExp): void {
        const ce = e.copy().isCondExp()!;
        ce.econd = doInlineAs_Expression(e.econd, this.ids);
        ce.e1 = doInlineAs_Expression(e.e1, this.ids);
        ce.e2 = doInlineAs_Expression(e.e2, this.ids);
        this.result = ce;
    }
}

/// dmd/inline.d:1097 — `private Result doInlineAs(Result)(Statement s, InlineDoState ids)`, instantiation
/// `Result == Statement` (file header). A null `s` yields null.
function doInlineAsStatement_Statement(s: Statement | null, ids: InlineDoState): Statement | null {
    if (s === null)
        return null;

    const v = new DoInlineAs_Statement(ids);
    s.accept(v);
    return v.result;
}

/// dmd/inline.d:1097 — `private Result doInlineAs(Result)(Statement s, InlineDoState ids)`, instantiation
/// `Result == Expression` (file header). A null `s` yields null.
function doInlineAsStatement_Expression(s: Statement | null, ids: InlineDoState): Expression | null {
    if (s === null)
        return null;

    const v = new DoInlineAs_Expression(ids);
    s.accept(v);
    return v.result;
}

/// dmd/inline.d:1108 — `private Result doInlineAs(Result)(Expression e, InlineDoState ids)`, instantiation
/// `Result == Expression` (file header). A null `e` yields null.
function doInlineAs_Expression(e: Expression | null, ids: InlineDoState): Expression | null {
    if (e === null)
        return null;

    const v = new DoInlineAs_Expression(ids);
    e.accept(v);
    return v.result;
}

/***********************************************************
 * dmd/inline.d:1122 — `private extern (C++) final class InlineScanVisitor : Visitor`.
 * Walk the trees, looking for functions to inline.
 * Inline any that can be.
 *
 * Not run by ldc2 (file header). Protocol: `inlineScan(slot)` / `inlineScanStatement(slot)` visit
 * the node in the slot and, when a visit left a replacement in `eresult` / `sresult`, write it back
 * into the slot and clear the field.
 */
class InlineScanVisitor extends Visitor {
    // dropped: alias visit = Visitor.visit — no overload hiding in TS (13 §1)
    parent: FuncDeclaration;     // function being scanned
    pass: PASS;
    eSink: ErrorSink;

    // As the visit method cannot return a value, these variables
    // are used to pass the result from 'visit' back to 'inlineScan'
    sresult: Statement | null = null;
    eresult: Expression | null = null;
    again = false;

    /// dmd/inline.d:1137 — `extern (D) this(FuncDeclaration parent, PASS pass, ErrorSink eSink) scope @safe`.
    constructor(parent: FuncDeclaration, pass: PASS, eSink: ErrorSink) {
        super();
        this.parent = parent;
        this.pass = pass;
        this.eSink = eSink;
    }

    /// dmd/inline.d:1144 — `void reset()`.
    reset(): void {
        this.sresult = null;
        this.eresult = null;
        this.again = false;
    }

    override visitStatement(_s: Statement): void {
    }

    override visitExpStatement(s: ExpStatement): void {
        if (s.exp === null)
            return;

        // inline.d:1164 — nested `Statement inlineScanExpAsStatement(ref Expression exp)` (04 §5:
        // inner const arrow; recursive, so declared before its first call). `ref` -> accessor pair.
        const inlineScanExpAsStatement = (exp: ExpressionSlot): Statement | null => {
            /* If there's a EXP.call at the top, then it may fail to inline
             * as an Expression. Try to inline as a Statement instead.
             */
            const ce = exp.get()!.isCallExp();
            if (ce !== null) {
                this.visitCallExpHelper(ce, null, true, false);
                if (this.eresult !== null)
                    exp.set(this.eresult);
                const s = this.sresult;
                this.sresult = null;
                this.eresult = null;
                return s;
            }

            /* If there's a CondExp or CommaExp at the top, then its
             * sub-expressions may be inlined as statements.
             */
            const ec = exp.get()!.isCondExp();
            if (ec !== null) {
                const e = ec;
                this.inlineScan(fieldSlot(e, "econd"));
                const s1 = inlineScanExpAsStatement(fieldSlot(e, "e1"));
                const s2 = inlineScanExpAsStatement(fieldSlot(e, "e2"));
                if (s1 === null && s2 === null)
                    return null;
                const ifbody   = s1 === null ? new ExpStatement(e.e1!.loc, e.e1) : s1;
                const elsebody = s2 === null ? new ExpStatement(e.e2!.loc, e.e2) : s2;
                return new IfStatement(exp.get()!.loc, null, e.econd, ifbody, elsebody, exp.get()!.loc);
            }
            const ecomma = exp.get()!.isCommaExp();
            if (ecomma !== null) {
                const e = ecomma;
                /* If expression declares temporaries which have to be destructed
                 * at the end of the scope then it is better handled as an expression.
                 */
                if (expNeedsDtor(e.e1!)) {
                    this.inlineScan(exp);
                    return null;
                }

                const s1 = inlineScanExpAsStatement(fieldSlot(e, "e1"));
                const s2 = inlineScanExpAsStatement(fieldSlot(e, "e2"));
                if (s1 === null && s2 === null)
                    return null;
                // `new Statements(a, b)` — the two-element variadic Array constructor.
                const a: Statements = new DArray<Statement | null>();
                a.push(s1 === null ? new ExpStatement(e.e1!.loc, e.e1) : s1);
                a.push(s2 === null ? new ExpStatement(e.e2!.loc, e.e2) : s2);
                return new CompoundStatement(exp.get()!.loc, a);
            }

            // inline as an expression
            this.inlineScan(exp);
            return null;
        };

        this.sresult = inlineScanExpAsStatement(fieldSlot(s, "exp"));
    }

    override visitCompoundStatement(s: CompoundStatement): void {
        for (let i = 0; i < s.statements!.length; i++) {
            this.inlineScanStatement(elementSlot(s.statements!, i));
        }
    }

    override visitUnrolledLoopStatement(s: UnrolledLoopStatement): void {
        for (let i = 0; i < s.statements!.length; i++) {
            this.inlineScanStatement(elementSlot(s.statements!, i));
        }
    }

    override visitScopeStatement(s: ScopeStatement): void {
        this.inlineScanStatement(fieldSlot(s, "statement"));
    }

    override visitWhileStatement(s: WhileStatement): void {
        this.inlineScan(fieldSlot(s, "condition"));
        this.inlineScanStatement(fieldSlot(s, "_body"));
    }

    override visitDoStatement(s: DoStatement): void {
        this.inlineScanStatement(fieldSlot(s, "_body"));
        this.inlineScan(fieldSlot(s, "condition"));
    }

    override visitForStatement(s: ForStatement): void {
        this.inlineScanStatement(fieldSlot(s, "_init"));
        this.inlineScan(fieldSlot(s, "condition"));
        this.inlineScan(fieldSlot(s, "increment"));
        this.inlineScanStatement(fieldSlot(s, "_body"));
    }

    override visitForeachStatement(s: ForeachStatement): void {
        this.inlineScan(fieldSlot(s, "aggr"));
        this.inlineScanStatement(fieldSlot(s, "_body"));
    }

    override visitForeachRangeStatement(s: ForeachRangeStatement): void {
        this.inlineScan(fieldSlot(s, "lwr"));
        this.inlineScan(fieldSlot(s, "upr"));
        this.inlineScanStatement(fieldSlot(s, "_body"));
    }

    override visitIfStatement(s: IfStatement): void {
        this.inlineScan(fieldSlot(s, "condition"));
        this.inlineScanStatement(fieldSlot(s, "ifbody"));
        this.inlineScanStatement(fieldSlot(s, "elsebody"));
    }

    override visitSwitchStatement(s: SwitchStatement): void {
        this.inlineScan(fieldSlot(s, "condition"));
        this.inlineScanStatement(fieldSlot(s, "_body"));
        let sdefault: Statement | null = s.sdefault;
        this.inlineScanStatement({ get: () => sdefault, set: (v) => { sdefault = v; } });
        // `cast(DefaultStatement)sdefault` — a D class cast, null on a mismatch: `isDefaultStatement`.
        s.sdefault = sdefault === null ? null : sdefault.isDefaultStatement();
        if (s.cases !== null) {
            for (let i = 0; i < s.cases.length; i++) {
                let scase: Statement | null = s.cases.opIndex(i);
                this.inlineScanStatement({ get: () => scase, set: (v) => { scase = v; } });
                // `cast(CaseStatement)scase` — a D class cast, null on a mismatch: `isCaseStatement`.
                s.cases.opIndexAssign(scase === null ? null : scase.isCaseStatement(), i);
            }
        }
    }

    override visitCaseStatement(s: CaseStatement): void {
        this.inlineScan(fieldSlot(s, "exp"));
        this.inlineScanStatement(fieldSlot(s, "statement"));
    }

    override visitDefaultStatement(s: DefaultStatement): void {
        this.inlineScanStatement(fieldSlot(s, "statement"));
    }

    override visitReturnStatement(s: ReturnStatement): void {
        if (s.exp === null)
            return;

        const e0: { value: Expression | null } = { value: null };
        let elast: Expression = Expression.extractLast(s.exp, e0);
        this.inlineScan({ get: () => e0.value, set: (v) => { e0.value = v; } });

        const ce = elast.isCallExp();
        if (ce !== null) {
            this.visitCallExpHelper(ce, null, false, true);

            if (this.eresult !== null) {
                elast = this.eresult;
                this.eresult = null;
            }
        } else {
            this.inlineScan({ get: () => elast, set: (v) => { elast = v!; } });
        }

        s.exp = Expression.combine(e0.value, elast);
    }

    override visitSynchronizedStatement(s: SynchronizedStatement): void {
        this.inlineScan(fieldSlot(s, "exp"));
        this.inlineScanStatement(fieldSlot(s, "_body"));
    }

    override visitWithStatement(s: WithStatement): void {
        if (s.wthis !== null && s.wthis._init !== null) {
            const ie = s.wthis._init.isExpInitializer();
            if (ie !== null) {
                this.inlineScan(fieldSlot(ie, "exp"));
            }
        }
        this.inlineScanStatement(fieldSlot(s, "_body"));
    }

    override visitTryCatchStatement(s: TryCatchStatement): void {
        this.inlineScanStatement(fieldSlot(s, "_body"));
        if (s.catches !== null) {
            for (const c of s.catches) {
                this.inlineScanStatement(fieldSlot(c!, "handler"));
            }
        }
    }

    override visitTryFinallyStatement(s: TryFinallyStatement): void {
        this.inlineScanStatement(fieldSlot(s, "_body"));
        this.inlineScanStatement(fieldSlot(s, "finalbody"));
    }

    override visitThrowStatement(s: ThrowStatement): void {
        this.inlineScan(fieldSlot(s, "exp"));
    }

    override visitLabelStatement(s: LabelStatement): void {
        this.inlineScanStatement(fieldSlot(s, "statement"));
    }

    /********************************
     * dmd/inline.d:1395 — `void inlineScan(ref Statement s)`.
     * Scan Statement s for inlining opportunities,
     * and if found replace s with an inlined one.
     * Params:
     *  s = Statement to be scanned and updated (the accessor pair of the D `ref` slot)
     * Form B rename (04 §1): the `ref Expression` overload keeps the bare name.
     */
    inlineScanStatement(s: StatementSlot): void {
        const st = s.get();
        if (st === null)
            return;
        assert(this.sresult === null);
        st.accept(this);
        if (this.sresult !== null) {
            s.set(this.sresult);
            this.sresult = null;
        }
    }

    /* -------------------------- */
    /// dmd/inline.d:1409 — `void arrayInlineScan(Expressions* arguments)`.
    arrayInlineScan(arguments_: Expressions | null): void {
        if (arguments_ !== null) {
            for (let i = 0; i < arguments_.length; i++) {
                this.inlineScan(elementSlot(arguments_, i));
            }
        }
    }

    override visitExpression(_e: Expression): void {
    }

    override visitDeclarationExp(e: DeclarationExp): void {
        const vd = e.declaration!.isVarDeclaration();
        if (vd !== null) {
            const td = toAlias(vd).isTupleDeclaration();
            if (td !== null) {
                for (let i = 0; i < td.objects!.length; i++) {
                    const o = td.objects!.opIndex(i);
                    const te = isExpression(o); // UFCS `o.isExpression()` -> dtemplate.d isExpression
                    if (te !== null) {
                        // D: `foreach (o; *td.objects) … inlineScan(te);` — `te` is a LOCAL copy of
                        // the element, so the write-back lands in the local and is discarded.
                        let tel: Expression | null = te;
                        this.inlineScan({ get: () => tel, set: (v) => { tel = v; } });
                    }
                }
            } else if (vd._init !== null) {
                const ie = vd._init.isExpInitializer();
                if (ie !== null) {
                    this.inlineScan(fieldSlot(ie, "exp"));
                }
            }
        }
    }

    override visitUnaExp(e: UnaExp): void {
        this.inlineScan(fieldSlot(e, "e1"));
    }

    override visitCastExp(e: CastExp): void {
        let lowering = e.lowering;
        if (lowering !== null) {
            // D: `if (auto lowering = e.lowering) inlineScan(lowering);` — the write-back lands in
            // the local `lowering`, not in `e.lowering`.
            this.inlineScan({ get: () => lowering, set: (v) => { lowering = v; } });
        } else {
            this.inlineScan(fieldSlot(e, "e1"));
        }
    }

    override visitAssertExp(e: AssertExp): void {
        this.inlineScan(fieldSlot(e, "e1"));
        this.inlineScan(fieldSlot(e, "msg"));
    }

    override visitCatExp(e: CatExp): void {
        let lowering = e.lowering;
        if (lowering !== null) {
            // write-back into the local, as D's `auto lowering` (see visitCastExp)
            this.inlineScan({ get: () => lowering, set: (v) => { lowering = v; } });
            return;
        }

        this.inlineScan(fieldSlot(e, "e1"));
        this.inlineScan(fieldSlot(e, "e2"));
    }

    override visitCatAssignExp(e: CatAssignExp): void {
        let lowering = e.lowering;
        if (lowering !== null)
            // write-back into the local, as D's `auto lowering` (see visitCastExp)
            this.inlineScan({ get: () => lowering, set: (v) => { lowering = v; } });
        else
            this.visitBinExp(e);
    }

    override visitBinExp(e: BinExp): void {
        this.inlineScan(fieldSlot(e, "e1"));
        this.inlineScan(fieldSlot(e, "e2"));
    }

    override visitEqualExp(e: EqualExp): void {
        let lowering = e.lowering;
        if (lowering !== null) {
            // write-back into the local, as D's `auto lowering` (see visitCastExp)
            this.inlineScan({ get: () => lowering, set: (v) => { lowering = v; } });
        } else {
            this.visitBinExp(e);
        }
    }

    override visitAssignExp(e: AssignExp): void {
        // inline.d:1511 — nested `void inlineConstruction(AssignExp e)` (04 §5: inner const arrow).
        const inlineConstruction = (e: AssignExp): void => {
            const e0: { value: Expression | null } = { value: null };
            let elast: Expression = Expression.extractLast(e.e2!, e0);
            this.inlineScan({ get: () => e0.value, set: (v) => { e0.value = v; } });   // Side effects

            const ce = elast.isCallExp();
            if (ce !== null && ce.f !== null) {
                this.visitCallExpHelper(ce, e.e1, false, false);

                if (this.eresult !== null) {
                    this.eresult = Expression.combine(e0.value, this.eresult);
                    return;
                }
            }

            this.inlineScan({ get: () => elast, set: (v) => { elast = v!; } });
            e.e2 = Expression.combine(e0.value, elast);
        };

        this.inlineScan(fieldSlot(e, "e1")); // LHS

        // Look for NRVO and emplace the return value into LHS directly
        // when expanding the function call on RHS.
        if (e.op === EXP.construct &&
            (e.e2!.type!.ty === Tstruct || e.e2!.type!.ty === Tsarray)) {
            let refInit = false;

            /* Inlining:
             *   S s = ...;    // initializing by rvalue
             * No NRVO on:
             *   ref S s = ...;
             */
            const ve = e.e1!.isVarExp();
            if (ve !== null)
                refInit = (ve.var_.storage_class & (STC.out_ | STC.ref_)) !== 0n;

            if (!refInit) {
                inlineConstruction(e);
                return;
            }
        }

        this.inlineScan(fieldSlot(e, "e2")); // RHS if not construction
    }

    override visitConstructExp(e: ConstructExp): void {
        let lowering = e.lowering;
        if (lowering !== null)
            // write-back into the local, as D's `auto lowering` (see visitCastExp)
            this.inlineScan({ get: () => lowering, set: (v) => { lowering = v; } });
        else
            this.visitAssignExp(e);
    }

    override visitLoweredAssignExp(e: LoweredAssignExp): void {
        this.inlineScan(fieldSlot(e, "lowering"));
    }

    override visitCallExp(e: CallExp): void {
        this.visitCallExpHelper(e, null, false, false);
    }

    /**************************************
     * dmd/inline.d:1593 — `void visitCallExp(CallExp e, Expression eret, bool asStatements,`
     * `bool propagateNRVO)`.
     * Check function call to see if can be inlined,
     * and then inline it if it can.
     * Params:
     *  e = the function call
     *  eret = if !null, then this is the lvalue of the nrvo function result
     *  asStatements = if inline as statements rather than as an Expression
     *  propagateNRVO = if the parent function returns the result immediately,
     *      so NRVO variables have to be preserved in the parent
     * Returns:
     *  this.eresult if asStatements == false
     *  this.sresult if asStatements == true
     *
     * renamed: D helper visitCallExp (inline.d:1593) — collides with the §1 virtual slot of
     * `visit(CallExp)` in this class, so the helper takes the `Helper` suffix (13 §5 collision rule).
     */
    visitCallExpHelper(e: CallExp, eret: Expression | null, asStatements: boolean, propagateNRVO: boolean): void {
        this.inlineScan(fieldSlot(e, "e1"));
        this.arrayInlineScan(e.arguments_);

        // inline.d:1598 — nested `void inlineFd(FuncDeclaration fd, Expression explicitThis)`.
        const inlineFd = (fd: FuncDeclaration, explicitThis: Expression | null): void => {
            /* If the arguments generate temporaries that need destruction, the destruction
             * must be done after the function body is executed.
             * The easiest way to accomplish that is to do the inlining as an Expression.
             * https://issues.dlang.org/show_bug.cgi?id=16652
             */
            let asStates = asStatements;
            if (asStates) {
                if (fd.semanticRun === this.pass && fd.inlineStatusExp === ILS.yes)
                    asStates = false;           // inline as expressions
                                                // so no need to recompute argumentsNeedDtors()
                else if (argumentsNeedDtors(e.arguments_))
                    asStates = false;
            }

            let hasThis: boolean;
            if (explicitThis !== null) {
                /* If ethis is explicitly given by a DotVarExp, fd can be inlined
                 * as long as it does not require another `this` pointer.
                 * Inlining the case where one pointer can be accessed from another
                 * is not implemented yet.
                 */
                hasThis = !fd.isNested();
            } else {
                /* Otherwise, `this` pointer is captured from parent. Only allow
                 * immediate nested functions to reference `this` pointer.
                 */
                hasThis = this.parent === fd.toParent2();
            }

            if (canInline(fd, hasThis, asStates, this.pass, this.eSink)) {
                // `out` arguments (03 §3.3): boxes over the three fields, written back at once;
                // expandInline resets them on entry, as D's `out` does.
                const eresultBox: { value: Expression | null } = { value: this.eresult };
                const sresultBox: { value: Statement | null } = { value: this.sresult };
                const againBox: { value: boolean } = { value: this.again };
                expandInline(e, fd, this.parent, eret, explicitThis, asStates, propagateNRVO,
                             eresultBox, sresultBox, againBox);
                this.eresult = eresultBox.value;
                this.sresult = sresultBox.value;
                this.again = againBox.value;
                if (asStatements && this.eresult !== null) {
                    this.sresult = new ExpStatement(this.eresult.loc, this.eresult);
                    this.eresult = null;
                }
            }
        };

        // inline.d:1645 — nested `FuncDeclaration resolveCallTarget(Expression e, out Expression
        // explicitThis)`. `out` -> a box reset on entry (03 §3.3).
        const resolveCallTarget = (e: Expression,
                                   explicitThis: { value: Expression | null }): FuncDeclaration | null => {
            explicitThis.value = null;
            /* Peel exactly one layer of (*fptr)() or (*&f)().
             */
            const pe = e.isPtrExp();
            if (pe !== null) {
                if (pe.e1!.isVarExp() !== null)
                    e = pe.e1!;
                else {
                    const se = pe.e1!.isSymOffExp();
                    if (se !== null)
                        return se.var_.isFuncDeclaration();
                    else
                        return null;
                }
            }

            /* Pattern match various ASTs looking for indirect function calls, delegate calls,
             * function literal calls, delegate literal calls, and dot member calls.
             * If so, and that is only assigned its _init.
             * If so, do 'copy propagation' of the _init value and try to inline it.
             */
            const ve = e.isVarExp();
            if (ve !== null) {
                const fd = ve.var_.isFuncDeclaration();
                if (fd !== null)
                    return fd;

                const v = ve.var_.isVarDeclaration();
                if (v === null || v._init === null || !onlyOneAssign(v, this.parent))
                    return null;

                const ei = v._init.isExpInitializer();
                if (ei === null || (ei.exp!.op !== EXP.blit && ei.exp!.op !== EXP.construct))
                    return null;

                // D: `(cast(AssignExp)ei.exp).e2` — the tag test just above (`op` is `blit` or
                // `construct`) proves an AssignExp subclass (02 §11.5c rule 3, superclass form).
                const e2: Expression = (ei.exp as unknown as AssignExp).e2!;
                const se = e2.isSymOffExp();
                if (se !== null) {
                    // function pointer call
                    return se.var_.isFuncDeclaration();
                }
                const fe = e2.isFuncExp();
                if (fe !== null) {
                    // function/delegate literal call
                    return fe.fd;
                }
                const de = e2.isDelegateExp();
                if (de !== null) {
                    const ve2 = de.e1!.isVarExp();
                    if (ve2 !== null) {
                        return ve2.var_.isFuncDeclaration();
                    }
                }
            } else {
                const dve = e.isDotVarExp();
                if (dve !== null) {
                    if (dve.e1!.op === EXP.call && toBasetype(dve.e1!.type!).ty === Tstruct) {
                        /* To create ethis, we'll need to take the address
                         * of dve.e1, but this won't work if dve.e1 is
                         * a function call.
                         */
                        return null;
                    }

                    explicitThis.value = dve.e1;
                    return dve.var_.isFuncDeclaration();
                } else {
                    const fe = e.isFuncExp();
                    if (fe !== null) {
                        return fe.fd;
                    }
                }
            }

            return null;
        };

        const explicitThis: { value: Expression | null } = { value: null };
        const fd = resolveCallTarget(e.e1!, explicitThis);

        if (fd === null || fd === this.parent)
            return;

        inlineFd(fd, explicitThis.value);

        if (global.params.v.verbose && (this.eresult !== null || this.sresult !== null))
            messageNoLoc(ds("inlined   %s =>\n          %s"), fd.toPrettyChars(), this.parent.toPrettyChars());

        if (this.eresult !== null && e.type!.ty !== Tvoid) {
            let ex: Expression = this.eresult;
            while (ex.op === EXP.comma) {
                ex.type = e.type;
                ex = ex.isCommaExp()!.e2!;
            }
            ex.type = e.type;
        }
    }

    override visitSliceExp(e: SliceExp): void {
        this.inlineScan(fieldSlot(e, "e1"));
        this.inlineScan(fieldSlot(e, "lwr"));
        this.inlineScan(fieldSlot(e, "upr"));
    }

    override visitTupleExp(e: TupleExp): void {
        this.inlineScan(fieldSlot(e, "e0"));
        this.arrayInlineScan(e.exps);
    }

    override visitArrayLiteralExp(e: ArrayLiteralExp): void {
        this.inlineScan(fieldSlot(e, "basis"));
        this.arrayInlineScan(e.elements);
    }

    override visitAssocArrayLiteralExp(e: AssocArrayLiteralExp): void {
        this.arrayInlineScan(e.keys);
        this.arrayInlineScan(e.values);
    }

    override visitStructLiteralExp(e: StructLiteralExp): void {
        if (e.stageflags & StructLiteralExpStageFlags.inlineScan)
            return;
        const old = e.stageflags;
        e.stageflags |= StructLiteralExpStageFlags.inlineScan;
        // Paired state on the AST node (11 §2.5): the restore at inline.d:1779 is guarded against a
        // throw from a callee's wall; the normal path runs D's restore in place.
        try {
            this.arrayInlineScan(e.elements);
        } finally {
            e.stageflags = old;
        }
    }

    override visitArrayExp(e: ArrayExp): void {
        this.inlineScan(fieldSlot(e, "e1"));
        this.arrayInlineScan(e.arguments_);
    }

    override visitCondExp(e: CondExp): void {
        this.inlineScan(fieldSlot(e, "econd"));
        this.inlineScan(fieldSlot(e, "e1"));
        this.inlineScan(fieldSlot(e, "e2"));
    }

    /********************************
     * dmd/inline.d:1802 — `void inlineScan(ref Expression e)`.
     * Scan Expression e for inlining opportunities,
     * and if found replace e with an inlined one.
     * Params:
     *  e = Expression to be scanned and updated (the accessor pair of the D `ref` slot)
     */
    inlineScan(e: ExpressionSlot): void {
        const ex = e.get();
        if (ex === null)
            return;
        assert(this.eresult === null);
        ex.accept(this);
        if (this.eresult !== null) {
            e.set(this.eresult);
            this.eresult = null;
        }
    }
}

/***********************************************************
 * dmd/inline.d:1820 — `private extern (C++) final class InlineScanVisitorDsymbol : Visitor`.
 * Walk the trees, looking for functions to inline.
 * Inline any that can be.
 *
 * Not run by ldc2 (file header).
 */
class InlineScanVisitorDsymbol extends Visitor {
    // dropped: alias visit = Visitor.visit — no overload hiding in TS (13 §1)
    pass: PASS;
    eSink: ErrorSink;

    /// dmd/inline.d:1828 — `extern (D) this(PASS pass, ErrorSink eSink) scope @safe`.
    constructor(pass: PASS, eSink: ErrorSink) {
        super();
        this.pass = pass;
        this.eSink = eSink;
    }

    /*************************************
     * Look for function inlining possibilities.
     */
    override visitDsymbol(_d: Dsymbol): void {
        // Most Dsymbols aren't functions
    }

    override visitFuncDeclaration(fd: FuncDeclaration): void {
        if (fd.fbody === null || fd.isNaked || fd.skipCodegen)
            return;

        if (fd.semanticRun < PASS.semantic3done)
            return;

        if (fd.semanticRun === this.pass && fd.inlineScanned)
            return;

        if (fd.isUnitTestDeclaration() !== null && !global.params.useUnitTests)
            return;

        if (!fd.hasAlwaysInlines && this.pass === PASS.inlinePragma)
            return;

        if (fd.semanticRun !== this.pass) {
            fd.inlineStatusExp = ILS.uninitialized;
            fd.inlineStatusStmt = ILS.uninitialized;
        }

        fd.inlineScanned = true;
        fd.semanticRun = this.pass;

        const v = new InlineScanVisitor(fd, this.pass, this.eSink);

        do {
            fd.inlineNest++;
            // Paired counter on the AST node (11 §2.5): the decrement at inline.d:1880 is guarded
            // against a throw from a callee's wall; the normal path runs D's decrement in place.
            try {
                v.reset();
                v.inlineScanStatement(fieldSlot(fd, "fbody"));
            } finally {
                fd.inlineNest--;
            }
        } while (v.again);

        if (fd.localsymtab !== null) {
            for (const keyValue of fd.localsymtab.tab.asRange()) {
                keyValue[1].accept(this); // `keyValue.value.accept(this)`
            }
        }
    }

    override visitAttribDeclaration(d: AttribDeclaration): void {
        const decls = include(d, null);
        if (decls !== null) {
            for (let i = 0; i < decls.length; i++) {
                const s = decls.opIndex(i)!;
                s.accept(this);
            }
        }
    }

    override visitAggregateDeclaration(ad: AggregateDeclaration): void {
        if (ad.members !== null) {
            for (let i = 0; i < ad.members.length; i++) {
                const s = ad.members.opIndex(i)!;
                s.accept(this);
            }
        }
    }

    override visitTemplateInstance(ti: TemplateInstance): void {
        if (!ti.errors && ti.members !== null) {
            for (let i = 0; i < ti.members.length; i++) {
                const s = ti.members.opIndex(i)!;
                s.accept(this);
            }
        }
    }
}

/***********************************************************
 * dmd/inline.d:1945 — `private void inlineScanModule(Module m, PASS pass, ErrorSink eSink)`.
 * Scan function implementations in Module m looking for functions that can be inlined,
 * and inline them in situ.
 *
 * Params:
 *    m = module to scan
 *    pass = the current pass (inline1 or inline2)
 *    eSink = where to report errors
 */
function inlineScanModule(m: Module, pass: PASS, eSink: ErrorSink): void {
    assert(pass === PASS.inlinePragma || pass === PASS.inlineAll);

    // Note that modules get their own scope, from scratch.
    // This is so regardless of where in the syntax a module
    // gets imported, it is unaffected by context.

    const v = new InlineScanVisitorDsymbol(pass, eSink);

    for (let i = 0; i < m.members!.length; i++) {
        const s = m.members!.opIndex(i)!;
        s.accept(v);
    }

    m.semanticRun = pass;
}

/***********************************************************
 * dmd/inline.d:1979 — `private bool canInline(FuncDeclaration fd, bool hasThis, bool statementsToo,`
 * `PASS pass, ErrorSink eSink)`.
 * Test that `fd` can be inlined.
 *
 * Params:
 *  hasThis = `true` if the caller can access the callee's this pointer.
 *  statementsToo = `true` if the function call is placed on ExpStatement.
 *      It means more code-block dependent statements in fd body - ForStatement,
 *      ThrowStatement, etc. can be inlined.
 *  eSink = where to report errors
 *
 * Returns:
 *  true if the function body can be expanded. Caches the verdict in `fd.inlineStatusStmt` /
 *  `fd.inlineStatusExp`, and may run semantic3 on `fd`.
 */
function canInline(fd: FuncDeclaration, hasThis: boolean, statementsToo: boolean, pass: PASS,
                   eSink: ErrorSink): boolean {
    let cost: number;

    // `Lno:` — BAIL (06 §4): every jump to `Lno` lands in this terminal tail, which records the
    // negative verdict and returns false.
    const LnoTail = (): boolean => {
        if (fd.inlining === PINLINE.always && pass === PASS.inlinePragma &&
            global.params.useWarnings === DiagnosticReporting.inform) {
            eSink.warning(fd.loc, ds("cannot inline function `%s`"), fd.toPrettyChars());
        }

        if (statementsToo)
            fd.inlineStatusStmt = ILS.no;
        else
            fd.inlineStatusExp = ILS.no;

        return false;
    };

    if (fd.needThis() && !hasThis)
        return false;

    if (fd.inlineNest) {
        return false;
    }

    if (fd.semanticRun < PASS.semantic3) {
        if (fd.fbody === null)
            return false;
        if (!functionSemantic3(fd))
            return false;
        runDeferredSemantic3();
        if (global.errors)
            return false;
        assert(fd.semanticRun >= PASS.semantic3done);
    }

    if (fd.skipCodegen)
        return false;

    // Reset ILS if the decision was made in another pass
    if (fd.semanticRun !== pass) {
        fd.inlineScanned = false;
        fd.inlineStatusExp = ILS.uninitialized;
        fd.inlineStatusStmt = ILS.uninitialized;
        fd.semanticRun = pass;
    }

    // `final switch` (06): every ILS member has an arm.
    switch (statementsToo ? fd.inlineStatusStmt : fd.inlineStatusExp) {
    case ILS.yes:
        return true;
    case ILS.no:
        return false;
    case ILS.uninitialized:
        break;
    default:
        assertUnreachable();
    }

    // `final switch` (06): every PINLINE member has an arm.
    switch (fd.inlining) {
    case PINLINE.default_:
        if (pass !== PASS.inlineAll)
            return false;
        break;
    case PINLINE.always:
        break;
    case PINLINE.never:
        return false;
    default:
        assertUnreachable();
    }

    if (fd.type !== null) {
        const tf: TypeFunction = fd.type.isTypeFunction()!;

        // no variadic parameter lists
        if (tf.parameterList.varargs === VarArg.variadic ||
            tf.parameterList.varargs === VarArg.KRvariadic)
            return LnoTail();

        /* No lazy parameters when inlining by statement, as the inliner tries to
         * operate on the created delegate itself rather than the return value.
         * Discussion: https://github.com/dlang/dmd/pull/6815
         */
        if (statementsToo && fd.parameters !== null) {
            for (const param of fd.parameters) {
                if ((param!.storage_class & STC.lazy_) !== 0n)
                    return LnoTail();
            }
        }

        // inline.d:2077 — nested `static bool hasDtor(Type t)` (04 §5: inner const arrow).
        const hasDtor = (t: Type): boolean => {
            const tv = baseElemOf(t);
            return tv.ty === Tstruct || tv.ty === Tclass; // for now assume these might have a destructor
        };

        /* Don't inline a function that returns non-void, but has
         * no or multiple return expression.
         * When inlining as a statement:
         * 1. don't inline array operations, because the order the arguments
         *    get evaluated gets reversed. This is the same issue that e2ir.callfunc()
         *    has with them
         * 2. don't inline when the return value has a destructor, as it doesn't
         *    get handled properly
         */
        const tfnext = tf.next;
        if (tfnext !== null) {
            /* for the isTypeSArray() case see https://github.com/dlang/dmd/pull/16145#issuecomment-1932776873
             */
            if (tfnext.ty !== Tvoid && tfnext.ty !== Tnoreturn &&
                (!fd.hasReturnExp ||
                 hasDtor(tfnext) && (statementsToo || tfnext.isTypeSArray() !== null))) {
                return LnoTail();
            }
        }

        /* https://issues.dlang.org/show_bug.cgi?id=14560
         * If fd returns void, all explicit `return;`s
         * must not appear in the expanded result.
         * See also ReturnStatement.doInlineAs!Statement().
         */
    }

    // cannot inline constructor calls because we need to convert:
    //      return;
    // to:
    //      return this;
    // ensure() has magic properties the inliner loses
    // require() has magic properties too
    // see bug 7699
    // no nested references to this frame
    if (fd.fbody === null ||
        fd.ident === Id.ensure ||
        (fd.ident === Id.require &&
         fd.toParent()!.isFuncDeclaration() !== null &&
         fd.toParent()!.isFuncDeclaration()!.needThis()) ||
         (fd.isSynchronized() ||
          fd.isImportedSymbol() ||
          hasNestedFrameRefs(fd) ||
          (isVirtual(fd) && !fd.isFinalFunc()))) {
        return LnoTail();
    }

    // cannot inline functions as statement if they have multiple
    //  return statements
    if (fd.hasMultipleReturnExp && statementsToo) {
        return LnoTail();
    }

    {
        cost = inlineCostFunction(fd, hasThis);
    }

    if (tooCostly(cost))
        return LnoTail();
    if (!statementsToo && cost > COST_MAX)
        return LnoTail();

    if (statementsToo)
        fd.inlineStatusStmt = ILS.yes;
    else
        fd.inlineStatusExp = ILS.yes;

    {
        const v = new InlineScanVisitorDsymbol(pass, eSink);
        fd.accept(v);
    }

    if (fd.inlineStatusExp === ILS.uninitialized) {
        // Need to redo cost computation, as some statements or expressions have been inlined
        cost = inlineCostFunction(fd, hasThis);

        if (tooCostly(cost))
            return LnoTail();
        if (!statementsToo && cost > COST_MAX)
            return LnoTail();

        if (statementsToo)
            fd.inlineStatusStmt = ILS.yes;
        else
            fd.inlineStatusExp = ILS.yes;
    }

    return true;
}

/***********************************************************
 * dmd/inline.d:2235 — `private void expandInline(CallExp ecall, FuncDeclaration fd, FuncDeclaration parent,`
 * with `Expression eret, Expression ethis, bool asStatements, bool propagateNRVO, out Expression eresult,
 * out Statement sresult, out bool again)`.
 * Expand a function call inline,
 *      ethis.fd(arguments)
 *
 * Params:
 *      ecall = original CallExp
 *      fd = function to expand
 *      parent = function that the call to fd is being expanded into
 *      eret = if !null then the lvalue of where the nrvo return value goes
 *      asStatements = expand to Statements rather than Expressions
 *      propagateNRVO = preserve NRVO status of variables
 *      eresult = if expanding to an expression, this is where the expression is written to
 *      sresult = if expanding to a statement, this is where the statement is written to
 *      again = if true, then fd can be inline scanned again because there may be
 *           more opportunities for inlining
 * The three `out` parameters are `{ value }` boxes, reset on entry (03 §3.3).
 */
function expandInline(ecall: CallExp, fd: FuncDeclaration, parent: FuncDeclaration,
        eret: Expression | null, ethis: Expression | null, asStatements: boolean, propagateNRVO: boolean,
        eresult: { value: Expression | null }, sresult: { value: Statement | null },
        again: { value: boolean }): void {
    eresult.value = null; // D default-initializes the `out` parameters on entry
    sresult.value = null;
    again.value = false;

    const callLoc: Loc = ecall.loc;
    const tf: TypeFunction = fd.type!.isTypeFunction()!;
    const ids = new InlineDoState(parent, fd);
    ids.propagateNRVO = propagateNRVO;

    if (fd.isNested()) {
        if (parent.inlinedNestedCallees === null)
            parent.inlinedNestedCallees = new DArray<FuncDeclaration | null>();
        parent.inlinedNestedCallees.push(fd);
    }

    // Set up eret
    if (eret !== null) {
        if (eret.isVarExp() !== null) {
            ids.eret = eret;
            eret = null;
        } else {
            // Use a pointer to the expression (field or static array) to be initialized.

            const ei = new ExpInitializer(callLoc, null);
            const tmp = Identifier.generateId(ds("__retptr"));
            const vd = new VarDeclaration(fd.loc, pointerTo(eret.type!), tmp, ei);
            vd.storage_class = (vd.storage_class | STC.temp) as STC; // branded STC re-cast (02 §4.2)
            vd._linkage = LINK.d;
            vd.parent = parent;

            ei.exp = ConstructExp.fromVar(fd.loc, vd, new AddrExp(fd.loc, eret, vd.type));
            ei.exp.type = vd.type;

            const de = new DeclarationExp(fd.loc, vd);
            de.type = Type.tvoid;

            ids.eret = new PtrExp(fd.loc, new VarExp(fd.loc, vd));
            ids.eret.type = eret.type;
            eret = de;
        }
    }

    // Set up vthis
    let vthis: VarDeclaration | null = null;
    if (ethis !== null) {
        const e0: { value: Expression | null } = { value: null };
        ethis = Expression.extractLast(ethis, e0);

        const vthis2 = ecall.vthis2;
        if (vthis2 !== null) {
            // void*[2] __this = [ethis, this]
            if (ethis.type!.ty === Tstruct) {
                // &ethis
                const t: Type = pointerTo(ethis.type!);
                ethis = new AddrExp(ethis.loc, ethis);
                ethis.type = t;
            }
            const elements: Expressions = new DArray<Expression | null>(2);
            elements.opIndexAssign(ethis, 0);
            elements.opIndexAssign(new NullExp(Loc.initial, Type.tvoidptr), 1);
            const ae: Expression = new ArrayLiteralExp(vthis2.loc, vthis2.type, elements);
            const ce: Expression = ConstructExp.fromVar(vthis2.loc, vthis2, ae);
            ce.type = vthis2.type;
            vthis2._init = new ExpInitializer(vthis2.loc, ce);
            vthis = vthis2;
        } else {
            const ve = ethis.isVarExp();
            if (ve !== null) {
                vthis = ve.var_.isVarDeclaration();
            } else {
                if (ethis.type!.ty === Tpointer) {
                    const t: Type | null = nextOf(ethis.type!);
                    ethis = new PtrExp(ethis.loc, ethis);
                    ethis.type = t;
                }

                const ei = new ExpInitializer(fd.loc, null);
                vthis = new VarDeclaration(fd.loc, ethis.type, Id.This!, ei);
                vthis._linkage = LINK.d;
                vthis.parent = parent;

                if (ethis.isStructLiteralExp() !== null) {
                    vthis.storage_class = STC.rvalue;

                    if (fd.isCtorDeclaration() !== null && propagateNRVO)
                        vthis.nrvo = true;
                } else if (ethis.type!.ty !== Tclass) {
                    vthis.storage_class = STC.ref_;
                }

                ei.exp = ConstructExp.fromVar(fd.loc, vthis, ethis);
                ei.exp.type = vthis.type;

                const de = new DeclarationExp(fd.loc, vthis);
                de.type = Type.tvoid;
                e0.value = Expression.combine(e0.value, de);
            }
        }
        ethis = e0.value;

        ids.vthis = vthis;
    }

    // Set up parameters
    let eparams: Expression | null = null;
    if (ecall.arguments_ !== null && ecall.arguments_.length) {
        assert(fd.parameters!.length === ecall.arguments_.length);
        for (let i = 0; i < ecall.arguments_.length; i++) {
            const vfrom = fd.parameters!.opIndex(i)!;
            const arg = ecall.arguments_.opIndex(i)!;

            const ei = new ExpInitializer(vfrom.loc, arg);
            const vto = new VarDeclaration(vfrom.loc, vfrom.type, vfrom.ident!, ei);
            // branded STC re-cast after the bitwise ops (02 §4.2)
            vto.storage_class = (vto.storage_class |
                (vfrom.storage_class & (STC.temp | STC.IOR | STC.lazy_ | STC.nodtor))) as STC;
            vto._linkage = vfrom._linkage;
            vto.parent = parent;

            const ve = arg.isVarExp();
            if (ve !== null) {
                const va = ve.var_.isVarDeclaration();
                if (va !== null && va.isArgDtorVar) {
                    assert((vto.storage_class & STC.nodtor) !== 0n);
                    // The destructor is called on va so take it by ref
                    vto.storage_class = (vto.storage_class | STC.ref_) as STC; // branded STC re-cast (02 §4.2)
                }
            }

            if (arg.rvalue)
                vto.storage_class = (vto.storage_class | STC.ref_) as STC; // branded STC re-cast (02 §4.2)

            // Even if vto is STC.lazy_, `vto = arg` is handled correctly in glue layer.
            ei.exp = BlitExp.fromVar(vto.loc, vto, arg);
            ei.exp.type = vto.type;

            ids.from.push(vfrom);
            ids.to.push(vto);

            const de = new DeclarationExp(vto.loc, vto);
            de.type = Type.tvoid;
            eparams = Expression.combine(eparams, de);

            /* If function pointer or delegate parameters are present,
             * inline scan again because if they are initialized to a symbol,
             * any calls to the fp or dg can be inlined.
             */
            if (vfrom.type!.ty === Tdelegate ||
                vfrom.type!.isPtrToFunction() !== null) {
                const ve2 = arg.isVarExp();
                if (ve2 !== null) {
                    if (ve2.var_.isFuncDeclaration() !== null)
                        again.value = true;
                } else {
                    const se = arg.isSymOffExp();
                    if (se !== null) {
                        if (se.var_.isFuncDeclaration() !== null)
                            again.value = true;
                    } else if (arg.op === EXP.function_ || arg.op === EXP.delegate_)
                        again.value = true;
                }
            }
        }
    }

    if (asStatements) {
        /* Construct:
         *  { eret; ethis; eparams; fd.fbody; }
         * or:
         *  { eret; ethis; try { eparams; fd.fbody; } finally { vthis.edtor; } }
         */

        const as: Statements = new DArray<Statement | null>();
        if (eret !== null)
            as.push(new ExpStatement(callLoc, eret));
        if (ethis !== null)
            as.push(new ExpStatement(callLoc, ethis));

        let as2 = as;
        if (vthis !== null && !vthis.isDataseg()) {
            if (vthis.needsScopeDtor()) {
                // same with ExpStatement.scopeCode()
                as2 = new DArray<Statement | null>();
                vthis.storage_class = (vthis.storage_class | STC.nodtor) as STC; // branded STC re-cast (02 §4.2)
            }
        }

        if (eparams !== null)
            as2.push(new ExpStatement(callLoc, eparams));

        fd.inlineNest++;
        // Paired counter (11 §2.5): the decrement at inline.d:2453 is guarded against a callee's wall.
        let s: Statement | null;
        try {
            s = doInlineAsStatement_Statement(fd.fbody, ids);
        } finally {
            fd.inlineNest--;
        }
        as2.push(s);

        if (as2 !== as) {
            as.push(new TryFinallyStatement(callLoc,
                        new CompoundStatement(callLoc, as2),
                        new DtorExpStatement(callLoc, vthis!.edtor, vthis)));
        }

        sresult.value = new ScopeStatement(callLoc, new CompoundStatement(callLoc, as), callLoc);
    } else {
        /* Construct:
         *  (eret, ethis, eparams, fd.fbody)
         */

        fd.inlineNest++;
        // Paired counter (11 §2.5): the decrement at inline.d:2477 is guarded against a callee's wall.
        let e: Expression | null;
        try {
            e = doInlineAsStatement_Expression(fd.fbody, ids);
        } finally {
            fd.inlineNest--;
        }

        // `import dmd.expressionsem : toLvalue;` (function-local import, hoisted to the module
        // imports — 01 §4.4)
        // https://issues.dlang.org/show_bug.cgi?id=11322
        if (tf.isRef)
            e = toLvalue(e!, null, ds("`ref` return"));

        // https://issues.dlang.org/show_bug.cgi?id=15210
        if (tf.next!.ty === Tvoid && e !== null && e.type!.ty !== Tvoid && e.type!.ty !== Tnoreturn) {
            e = new CastExp(callLoc, e, Type.tvoid);
            e.type = Type.tvoid;
        }

        eresult.value = Expression.combine(eresult.value, eret, ethis, eparams);
        eresult.value = Expression.combine(eresult.value, e);

        if (ecall.rvalue || tf.isRvalue)
            eresult.value!.rvalue = true;
    }

    // Need to reevaluate whether parent can now be inlined
    // in expressions, as we might have inlined statements
    parent.inlineStatusExp = ILS.uninitialized;
}

/***********************************************************
 * dmd/inline.d:2531 — `private bool onlyOneAssign(VarDeclaration v, FuncDeclaration fd) @safe`.
 * Determine if v is 'head const', meaning
 * that once it is initialized it is not changed
 * again.
 *
 * This is done using a primitive flow analysis.
 *
 * v is head const if v is const or immutable.
 * Otherwise, v is assumed to be head const unless one of the
 * following is true:
 *      1. v is a `ref` or `out` variable
 *      2. v is a parameter and fd is a variadic function
 *      3. v is assigned to again
 *      4. the address of v is taken
 *      5. v is referred to by a function nested within fd
 *      6. v is ever assigned to a `ref` or `out` variable
 *      7. v is ever passed to another function as `ref` or `out`
 *
 * Params:
 *      v       variable to check
 *      fd      function that v is local to (unused by the D body)
 * Returns:
 *      true if v's initializer is the only value assigned to v
 */
function onlyOneAssign(v: VarDeclaration, _fd: FuncDeclaration): boolean {
    if (!v.type!.isMutable())
        return true;            // currently the only case handled atm
    return false;
}

/************************************************************
 * dmd/inline.d:2547 — `private bool argumentsNeedDtors(Expressions* arguments)`.
 * See if arguments to a function are creating temporaries that
 * will need destruction after the function is executed.
 * Params:
 *      arguments = arguments to function
 * Returns:
 *      true if temporaries need destruction
 */
function argumentsNeedDtors(arguments_: Expressions | null): boolean {
    if (arguments_ !== null) {
        for (const arg of arguments_) {
            if (expNeedsDtor(arg!))
                return true;
        }
    }
    return false;
}

/************************************************************
 * dmd/inline.d:2569 — `private bool expNeedsDtor(Expression exp)`.
 * See if expression is creating temporaries that
 * will need destruction at the end of the scope.
 * Params:
 *      exp = expression
 * Returns:
 *      true if temporaries need destruction
 */
function expNeedsDtor(exp: Expression): boolean {
    // inline.d:2571 — `extern (C++) final class NeedsDtor : StoppableVisitor`, nested in D and
    // nested here. `alias visit = typeof(super).visit;` (:2573) dropped (13 §1).
    class NeedsDtor extends StoppableVisitor {
        exp: Expression;

        /// inline.d:2577 — `extern (D) this(Expression exp) scope @safe`.
        constructor(exp: Expression) {
            super();
            this.exp = exp;
        }

        override visitExpression(_e: Expression): void {
        }

        override visitDeclarationExp(de: DeclarationExp): void {
            this.Dsymbol_needsDtor(de.declaration!);
        }

        /// inline.d:2591 — `void Dsymbol_needsDtor(Dsymbol s)`.
        Dsymbol_needsDtor(s: Dsymbol): void {
            /* This mirrors logic of Dsymbol_toElem() in e2ir.d
             * perhaps they can be combined.
             */

            // inline.d:2597 — nested `void symbolDg(Dsymbol s)` (04 §5: inner const arrow).
            const symbolDg = (s: Dsymbol): void => {
                this.Dsymbol_needsDtor(s);
            };

            const vd = s.isVarDeclaration();
            if (vd !== null) {
                s = toAlias(s);
                if (s !== vd)
                    return this.Dsymbol_needsDtor(s);
                if (vd.isStatic() || (vd.storage_class & (STC.extern_ | STC.gshared | STC.manifest)) !== 0n)
                    return;
                if (vd.needsScopeDtor()) {
                    this.stop = true;
                }
            } else {
                const tm = s.isTemplateMixin();
                if (tm !== null) {
                    // `foreachDsymbol` with a `void delegate` — the void overload (dsymbol.d:99).
                    foreachDsymbolVoid(tm.members, symbolDg);
                } else {
                    const ad = s.isAttribDeclaration();
                    if (ad !== null) {
                        foreachDsymbolVoid(include(ad, null), symbolDg);
                    } else {
                        const td = s.isTupleDeclaration();
                        if (td !== null) {
                            // `td.foreachVar(&symbolDg)` with a `void delegate` — the bare overload.
                            td.foreachVar(symbolDg);
                        }
                    }
                }
            }
        }
    }

    const ct = new NeedsDtor(exp);
    return walkPostorder(exp, ct);
}
