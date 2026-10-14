// Ported from dmd/statement.d (module dmd.statement) — LDC 1.43.0-beta1 / DMD 2.113.
//
// Whole-file structural 1:1 translation of the `Statement` AST-node hierarchy, plus the two
// non-Statement helpers the module declares (`Catch : RootObject`, `LabelDsymbol : Dsymbol`).
// Every D top-level declaration in statement.d is translated here, walled (11 §2.5), or dropped
// with an audit comment (07); the drop record for the two compile-time declarations
// (`mixin template VisitStatement`, `visitStmtCase`) sits at the bottom of the file.
//
// VISITOR (13 §1/§2): every `override void accept(Visitor v) { v.visit(this); }` becomes
// `override accept(v: Visitor): void { v.visit<ThisNodeClass>(this); }` — the node calls its OWN
// named visit method, which is how D's compile-time overload selection is preserved.
//
// OVERLOAD SETS (04 §1). D picks a ctor by the STATIC type of its arguments; TS cannot, so a
// same-arity/different-type ctor pair is NEVER discriminated at runtime (04 §1.1c — the `null`
// trap: `null` satisfies both D overloads but `null instanceof T` is false, so an
// `instanceof`-collapsed ctor routes every null argument to the WRONG branch and builds a
// wrong-but-valid node with no diagnostic; this shipped once in this very file). The Form-B
// ctors of statement.d are therefore split into one `constructor` + one named static factory:
//   ExpStatement         : ctor(Loc, Expression, STMT=Exp)      + ExpStatement.fromDsymbol       (:396)
//   MixinStatement       : ctor(Loc, Expressions)               + MixinStatement.fromExpression  (:450)
//   CompoundStatement    : ctor(Loc, Statements, STMT=Compound) + CompoundStatement.fromStatementList (:507)
//   ForwardingStatement  : ctor(Loc, ForwardingScopeDsymbol, Statement) + ForwardingStatement.fromStatement (:696)
// In each case the surviving `constructor` is the FIELD/data form — mandatory here, because
// subclasses reach it through `super(...)` (CompoundDeclarationStatement / CompoundAsmStatement
// pass their own STMT tag; DtorExpStatement and the two asm subclasses do the same).
// The arity-distinct pairs stay ONE ctor with an optional trailing param (04 §1 Form A):
// ExpStatement(:380/:386), CompoundStatement(:487/:493), SwitchErrorStatement(:1327/:1332),
// AsmStatement(:1815/:1821).
//
// version(IN_LLVM) -> ON (_config.md §1), split per _config.md §2:
//   - AST / FE-bookkeeping IN_LLVM fields KEPT: `SwitchStatement.hasGotoDefault` (:1139),
//     `CaseStatement.gototarget` (:1187), `DefaultStatement.gototarget` (:1247),
//     `GotoCaseStatement.sw` (:1301), `BreakStatement.target` (:1385),
//     `ContinueStatement.target` (:1415), `InlineAsmStatement.isBranchToLabel` (:1852).
//   - FE-shaping IN_LLVM methods KEPT: `Statement.endsWithAsm` (:272),
//     `CompoundStatement.endsWithAsm` (:562), `CompoundAsmStatement.endsWithAsm` (:1943), and the
//     IN_LLVM branch of `InlineAsmStatement.syntaxCopy` (:1862).
//   - codegen-payload IN_LLVM field DROPPED: `CompoundAsmStatement.abiret` (llvm::Value*, :1922).
//
// Loc is a value struct but sits in the ALIAS-SAFE REGISTER (03 §9.1): it has no live in-scope
// mutator, so sharing on read is licensed with no per-site `.copy()` and no per-site comment.

import { ASTNode } from "./ast_node.js";
import { Dsymbol } from "./dsymbol.js";
import { RootObject } from "./rootobject.js";
import { DYNCAST } from "./rootobject.js";
import { STMT } from "./astenums.js";
// DSYM is a VALUE import: `DSYM.labelDsymbol` is passed to super() in LabelDsymbol's ctor. DSYM is
// a TS numeric enum (a runtime value) declared in dsymbol.ts; the value import is safe (the enum
// object is fully evaluated by the time any ctor runs).
import { DSYM } from "./dsymbol.js";
import { assert } from "../assert.js";
import { assertUnreachable } from "../assert.js";
// Array is the runtime growable container (08-runtime-lib.md); value import (constructs the inline
// Expressions/Statements/Catches/Dsymbols a few ctors/syntaxCopy bodies build). Foundation module,
// imports NO core-SCC module -> cycle-safe (01 §4.1).
import { Array as DArray } from "./root/array.js";
// global carries the gagged/error counters asserted in ErrorStatement's ctor (statement.d:340).
// globals.ts is a foundation module (no core-SCC import) -> cycle-safe.
import { global } from "./globals.js";
// Id is the interned-identifier table; `Id.ctfe` is read in IfStatement.isIfCtfeBlock. Value import
// used only inside a method body (post-load, 01 §4.3) -> cycle-safe.
import { Id } from "./id.js";
// VALUE imports used ONLY inside method bodies / ctors (post-load, 01 §4.3): `Expression
// .arraySyntaxCopy` (Mixin/Pragma syntaxCopy), `DeclarationExp` (ExpStatement.fromDsymbol),
// `Parameter.arraySyntaxCopy` (ForeachStatement.syntaxCopy), `ForwardingScopeDsymbol`/
// `DsymbolTable` (ForwardingStatement.fromStatement), `getThrowable` (Catch.syntaxCopy fallback).
// None are referenced at module-evaluation time, so the SCC cycle holds.
import { Expression } from "./expression.js";
import { DeclarationExp } from "./expression.js";
import { Parameter } from "./mtype.js";
import { getThrowable } from "./mtype.js";
import { ForwardingScopeDsymbol } from "./dsymbol.js";
import { DsymbolTable } from "./dsymbol.js";
// StoppableVisitor is a VALUE import: usesEH/comeFrom/hasCode declare local subclasses of it
// (statement.d:114/:153/:192). The subclass declarations live INSIDE method bodies, so the binding
// is read post-load (01 §4.3); visitor/index.ts imports statement.ts type-only, so no cycle.
import { StoppableVisitor } from "./visitor/index.js";

import type { Visitor } from "./visitor/index.js";
// Loc is a VALUE import: `Loc.initial` is read in ErrorStatement/LabelDsymbol ctors. Safe across
// the SCC: `location.ts` is a foundation module that imports NO core-SCC module, so no load cycle.
import { Loc } from "./location.js";
// STC is a VALUE import: `STC.none` is the field default for GccAsmStatement.stc (D `STC stc;` with
// no initializer -> STC.init, 09 §1.0). astenums.ts is a foundation module -> cycle-safe.
import { STC } from "./astenums.js";
// last: 01 §4.8 — `walkPostorderStatement` is a VALUE import and `visitor/postorder.ts` carries its
// own top-level value edges into the core SCC (`expression.js` for StructLiteralExpStageFlags,
// `dtemplate.js` for isExpression). LAST position keeps this module's SCC entry where it already is
// (`dsymbol.js`, the second import), so postorder evaluates after expression/dtemplate are already
// under way rather than becoming the chain's entry point. Read only inside usesEH/comeFrom/hasCode,
// i.e. post-load (01 §4.3).
import { walkPostorderStatement } from "./visitor/postorder.js";
import type { TOK } from "./tokens.js";
import type { Token } from "./tokens.js";
import type { Identifier } from "./identifier.js";
import type { Type } from "./mtype.js";
import type { VarDeclaration } from "./declaration.js";
import type { FuncDeclaration } from "./func.js";
import type { StaticForeach } from "./cond.js";
import type { Condition } from "./cond.js";
import type { StaticAssert } from "./staticassert.js";
import type {
    Statements,
    ScopeStatements,
    GotoStatements,
    GotoCaseStatements,
    CaseStatements,
    Catches,
    Parameters,
    Expressions,
    Identifiers,
    Dsymbols,
} from "./arraytypes.js";

/***********************************************************
 * Base of every statement node — statement.d:40.
 * Specification: https://dlang.org/spec/statement.html
 *
 * Inheritance: `Statement : ASTNode` (02 §2); `abstract` in D, `abstract` here.
 * `loc`/`stmt` are `const` in D — write-once at construction; kept as `readonly` fields.
 * `stmt` is the discriminant every `isXxx()` downcast and every `VisitStatement` dispatch reads.
 */
export abstract class Statement extends ASTNode {
    readonly loc: Loc;        // const Loc (statement.d:42)
    readonly stmt: STMT;      // const STMT (statement.d:43)

    // statement.d:45 — `override final DYNCAST dyncast() const`.
    override dyncast(): DYNCAST {
        return DYNCAST.statement;
    }

    // statement.d:50 — `final this(Loc loc, STMT stmt)`.
    constructor(loc: Loc, stmt: STMT) {
        super();
        this.loc = loc;
        this.stmt = stmt;
        // If this is an in{} contract scope statement (skip for determining
        //  inlineStatus of a function body for header content)
    }

    /**
     * statement.d:58 — the base `syntaxCopy()` is `assert(0)`: every concrete node that can be
     * syntax-copied overrides it. `assertUnreachable()` is the faithful port of D `assert(0)`
     * (10 §2) — it is NOT a wall (11 §2.5 accounting rule).
     */
    syntaxCopy(): Statement {
        return assertUnreachable();
    }

    /*************************************
     * statement.d:66 — Do syntax copy of an array of Statement's.
     * The container is shallow-cloned first, then every slot is replaced by a deep node copy;
     * null slots stay null (a Statements genuinely holds nulls — 08 §3).
     */
    static arraySyntaxCopy(a: Statements | null): Statements | null {
        let b: Statements | null = null;
        if (a !== null) {
            b = a.copy();                                   // Array.copy — shallow clone (08 §2.3)
            for (let i = 0; i < a.length; i++) {            // foreach (i, s; *a)
                const s = a.opIndex(i);
                b.opIndexAssign(s !== null ? s.syntaxCopy() : null, i);
            }
        }
        return b;
    }

    // statement.d:80 — the base returns `this`; only ForStatement overrides.
    getRelatedLabeled(): Statement {
        return this;
    }

    /****************************
     * statement.d:91 — Determine if an enclosed `break` would apply to this statement, such as if
     * it is a loop or switch statement.
     * Returns: `true` if it does
     */
    hasBreak(): boolean {
        //printf("Statement::hasBreak()\n");
        return false;
    }

    /****************************
     * statement.d:103 — Determine if an enclosed `continue` would apply to this statement, such as
     * if it is a loop statement.
     * Returns: `true` if it does
     */
    hasContinue(): boolean {
        return false;
    }

    /**********************************
     * statement.d:112 — Returns: `true` if statement uses exception handling.
     *
     * The traversal is `walkPostorderStatement` — the `Statement` half of D's `walkPostorder`
     * overload pair, which carries the receiver-type suffix per 04 §1 Form B rule 2 (the
     * `Expression` half keeps the bare name).
     */
    usesEH(): boolean {
        // statement.d:114 — `extern (C++) final class UsesEH : StoppableVisitor`.
        // `alias visit = typeof(super).visit;` DROPPED — no overload hiding in TS (13 §1).
        class UsesEH extends StoppableVisitor {
            override visitStatement(_s: Statement): void {
            }

            override visitTryCatchStatement(_s: TryCatchStatement): void {
                this.stop = true;
            }

            override visitTryFinallyStatement(_s: TryFinallyStatement): void {
                this.stop = true;
            }

            override visitScopeGuardStatement(_s: ScopeGuardStatement): void {
                this.stop = true;
            }

            override visitSynchronizedStatement(_s: SynchronizedStatement): void {
                this.stop = true;
            }
        }

        const ueh = new UsesEH();                           // statement.d:143 `scope UsesEH ueh = new UsesEH();`
        // swept: live and faithful at visitor/postorder.ts:152, AUTHORISED by
        // `bool walkPostorder(Statement s, StoppableVisitor v)` (dmd/visitor/postorder.d:27).
        return walkPostorderStatement(this, ueh);           // dmd/statement.d:144
    }

    /**********************************
     * statement.d:151 — Returns: `true` if statement 'comes from' somewhere else, like a goto.
     *
     * Same traversal as usesEH (see there for the Form-B rename).
     */
    comeFrom(): boolean {
        // statement.d:153 — `extern (C++) final class ComeFrom : StoppableVisitor`.
        class ComeFrom extends StoppableVisitor {
            override visitStatement(_s: Statement): void {
            }

            override visitCaseStatement(_s: CaseStatement): void {
                this.stop = true;
            }

            override visitDefaultStatement(_s: DefaultStatement): void {
                this.stop = true;
            }

            override visitLabelStatement(_s: LabelStatement): void {
                this.stop = true;
            }

            override visitAsmStatement(_s: AsmStatement): void {
                this.stop = true;
            }
        }

        const cf = new ComeFrom();                          // statement.d:182
        // swept: AUTHORISED by `bool walkPostorder(Statement s, StoppableVisitor v)`
        // (dmd/visitor/postorder.d:27) — see usesEH above.
        return walkPostorderStatement(this, cf);            // dmd/statement.d:183
    }

    /**********************************
     * statement.d:190 — Returns: `true` if statement has executable code.
     *
     * Same traversal as usesEH (see there for the Form-B rename).
     */
    hasCode(): boolean {
        // statement.d:192 — `extern (C++) final class HasCode : StoppableVisitor`.
        class HasCode extends StoppableVisitor {
            override visitStatement(_s: Statement): void {
                this.stop = true;
            }

            override visitExpStatement(s: ExpStatement): void {
                if (s.exp !== null) {                       // `s.exp !is null` (06 §2.7)
                    this.stop = s.exp.hasCode();
                }
            }

            override visitCompoundStatement(_s: CompoundStatement): void {
            }

            override visitScopeStatement(_s: ScopeStatement): void {
            }

            override visitImportStatement(_s: ImportStatement): void {
            }

            override visitCaseStatement(_s: CaseStatement): void {
            }

            override visitDefaultStatement(_s: DefaultStatement): void {
            }

            override visitLabelStatement(_s: LabelStatement): void {
            }
        }

        const hc = new HasCode();                           // statement.d:234
        // swept: AUTHORISED by `bool walkPostorder(Statement s, StoppableVisitor v)`
        // (dmd/visitor/postorder.d:27) — see usesEH above.
        return walkPostorderStatement(this, hc);            // dmd/statement.d:235
    }

    /*******************************
     * statement.d:243 — Find last statement in a sequence of statements.
     * Returns: the last statement, or `null` if there isn't one.
     * (The base returns `this`; only CompoundStatement can yield null — hence the nullable return.)
     */
    last(): Statement | null {
        return this;
    }

    /**************************
     * statement.d:253 — Support Visitor Pattern.
     * Params:
     *  v = visitor
     */
    override accept(v: Visitor): void {
        v.visitStatement(this);
    }

    /************************************
     * statement.d:267 — Does this statement end with a return statement?
     *
     * I.e. is it a single return statement or some compound statement that unconditionally hits a
     * return statement.
     * Returns: return statement it ends with, otherwise null.
     */
    endsWithReturnStatement(): ReturnStatement | null {
        return null;
    }

    // statement.d:269-273 — `version (IN_LLVM) { inout(CompoundAsmStatement) endsWithAsm() inout }`.
    // resolved: version(IN_LLVM) -> ON (_config §1); FE-shaping method -> KEPT (_config §2).
    endsWithAsm(): CompoundAsmStatement | null {
        return null;
    }

    /********************
     * statement.d:275-326 — `final pure inout nothrow @nogc @trusted { ... }`, the cheap
     * downcast block. Each member is `stmt == STMT.x ? cast(typeof(return))this : null`, i.e. the
     * STMT tag is the proof and D performs the cast on the strength of it.
     *
     * `as unknown as X` here is the TAG-PROVED DOWNCAST of the `isXxx()` RTTI family — the same
     * shape and the same justification as dsymbol.ts:1076-1085 (the DSYM block), which is the
     * tree precedent. It is NOT the 02 §11.5 upcast cascade: that shape is an UPCAST forced by a
     * subclass field shadowing a base field, and requires the comment to name the shadowing pair.
     * No field pair shadows in this module — the one name collision, D's `CaseRangeStatement.last`
     * against `Statement.last()`, is resolved by the `last_` rename at its declaration, not by a
     * cast. The double assertion is instead forced by TS's polymorphic `this` type: from an
     * abstract base, `this as ErrorStatement` is rejected outright (TS2352, "convert to unknown
     * first"), so `unknown` is the only spelling available. Nothing is reinterpreted at runtime —
     * the object IS the subclass, exactly as under D's cast.
     * Returns: the downcast statement if it can be downcasted, otherwise `null`.
     */
    isErrorStatement(): ErrorStatement | null { return this.stmt === STMT.Error ? (this as unknown as ErrorStatement) : null; }
    isPeelStatement(): PeelStatement | null { return this.stmt === STMT.Peel ? (this as unknown as PeelStatement) : null; }
    isScopeStatement(): ScopeStatement | null { return this.stmt === STMT.Scope ? (this as unknown as ScopeStatement) : null; }
    isExpStatement(): ExpStatement | null { return this.stmt === STMT.Exp ? (this as unknown as ExpStatement) : null; }
    isCompoundStatement(): CompoundStatement | null { return this.stmt === STMT.Compound ? (this as unknown as CompoundStatement) : null; }
    isReturnStatement(): ReturnStatement | null { return this.stmt === STMT.Return ? (this as unknown as ReturnStatement) : null; }
    isIfStatement(): IfStatement | null { return this.stmt === STMT.If ? (this as unknown as IfStatement) : null; }
    isConditionalStatement(): ConditionalStatement | null { return this.stmt === STMT.Conditional ? (this as unknown as ConditionalStatement) : null; }
    isStaticForeachStatement(): StaticForeachStatement | null { return this.stmt === STMT.StaticForeach ? (this as unknown as StaticForeachStatement) : null; }
    isCaseStatement(): CaseStatement | null { return this.stmt === STMT.Case ? (this as unknown as CaseStatement) : null; }
    isDefaultStatement(): DefaultStatement | null { return this.stmt === STMT.Default ? (this as unknown as DefaultStatement) : null; }
    isLabelStatement(): LabelStatement | null { return this.stmt === STMT.Label ? (this as unknown as LabelStatement) : null; }
    isGotoStatement(): GotoStatement | null { return this.stmt === STMT.Goto ? (this as unknown as GotoStatement) : null; }
    isGotoDefaultStatement(): GotoDefaultStatement | null { return this.stmt === STMT.GotoDefault ? (this as unknown as GotoDefaultStatement) : null; }
    isGotoCaseStatement(): GotoCaseStatement | null { return this.stmt === STMT.GotoCase ? (this as unknown as GotoCaseStatement) : null; }
    isBreakStatement(): BreakStatement | null { return this.stmt === STMT.Break ? (this as unknown as BreakStatement) : null; }
    isDtorExpStatement(): DtorExpStatement | null { return this.stmt === STMT.DtorExp ? (this as unknown as DtorExpStatement) : null; }
    isMixinStatement(): MixinStatement | null { return this.stmt === STMT.Mixin ? (this as unknown as MixinStatement) : null; }
    isForwardingStatement(): ForwardingStatement | null { return this.stmt === STMT.Forwarding ? (this as unknown as ForwardingStatement) : null; }
    isDoStatement(): DoStatement | null { return this.stmt === STMT.Do ? (this as unknown as DoStatement) : null; }
    isWhileStatement(): WhileStatement | null { return this.stmt === STMT.While ? (this as unknown as WhileStatement) : null; }
    isForStatement(): ForStatement | null { return this.stmt === STMT.For ? (this as unknown as ForStatement) : null; }
    isForeachStatement(): ForeachStatement | null { return this.stmt === STMT.Foreach ? (this as unknown as ForeachStatement) : null; }
    isSwitchStatement(): SwitchStatement | null { return this.stmt === STMT.Switch ? (this as unknown as SwitchStatement) : null; }
    isContinueStatement(): ContinueStatement | null { return this.stmt === STMT.Continue ? (this as unknown as ContinueStatement) : null; }
    isWithStatement(): WithStatement | null { return this.stmt === STMT.With ? (this as unknown as WithStatement) : null; }
    isTryCatchStatement(): TryCatchStatement | null { return this.stmt === STMT.TryCatch ? (this as unknown as TryCatchStatement) : null; }
    isThrowStatement(): ThrowStatement | null { return this.stmt === STMT.Throw ? (this as unknown as ThrowStatement) : null; }
    isDebugStatement(): DebugStatement | null { return this.stmt === STMT.Debug ? (this as unknown as DebugStatement) : null; }
    isTryFinallyStatement(): TryFinallyStatement | null { return this.stmt === STMT.TryFinally ? (this as unknown as TryFinallyStatement) : null; }
    isScopeGuardStatement(): ScopeGuardStatement | null { return this.stmt === STMT.ScopeGuard ? (this as unknown as ScopeGuardStatement) : null; }
    isSwitchErrorStatement(): SwitchErrorStatement | null { return this.stmt === STMT.SwitchError ? (this as unknown as SwitchErrorStatement) : null; }
    isUnrolledLoopStatement(): UnrolledLoopStatement | null { return this.stmt === STMT.UnrolledLoop ? (this as unknown as UnrolledLoopStatement) : null; }
    isForeachRangeStatement(): ForeachRangeStatement | null { return this.stmt === STMT.ForeachRange ? (this as unknown as ForeachRangeStatement) : null; }
    isCompoundDeclarationStatement(): CompoundDeclarationStatement | null { return this.stmt === STMT.CompoundDeclaration ? (this as unknown as CompoundDeclarationStatement) : null; }
    isCompoundAsmStatement(): CompoundAsmStatement | null { return this.stmt === STMT.CompoundAsm ? (this as unknown as CompoundAsmStatement) : null; }
    isPragmaStatement(): PragmaStatement | null { return this.stmt === STMT.Pragma ? (this as unknown as PragmaStatement) : null; }
    isStaticAssertStatement(): StaticAssertStatement | null { return this.stmt === STMT.StaticAssert ? (this as unknown as StaticAssertStatement) : null; }
    isCaseRangeStatement(): CaseRangeStatement | null { return this.stmt === STMT.CaseRange ? (this as unknown as CaseRangeStatement) : null; }
    isSynchronizedStatement(): SynchronizedStatement | null { return this.stmt === STMT.Synchronized ? (this as unknown as SynchronizedStatement) : null; }
    isAsmStatement(): AsmStatement | null { return this.stmt === STMT.Asm ? (this as unknown as AsmStatement) : null; }
    isInlineAsmStatement(): InlineAsmStatement | null { return this.stmt === STMT.InlineAsm ? (this as unknown as InlineAsmStatement) : null; }
    isGccAsmStatement(): GccAsmStatement | null { return this.stmt === STMT.GccAsm ? (this as unknown as GccAsmStatement) : null; }
    isImportStatement(): ImportStatement | null { return this.stmt === STMT.Import ? (this as unknown as ImportStatement) : null; }
}

/***********************************************************
 * statement.d:333 — Any Statement that fails semantic() or has a component that is an ErrorExp or
 * a TypeError should return an ErrorStatement from semantic().
 */
export class ErrorStatement extends Statement {
    // statement.d:335 — `super(Loc.initial, STMT.Error)` then assert an error was already reported.
    constructor() {
        super(Loc.initial, STMT.Error);
        // `import dmd.globals;` (statement.d:339) — a function-local import, no TS counterpart.
        // gaggedErrors/errors are uint counters -> explicit `!= 0` (09 §9 / 06 §2.5).
        assert(global.gaggedErrors !== 0 || global.errors !== 0);
    }

    // statement.d:343 — an ErrorStatement is never re-copied; it returns itself.
    override syntaxCopy(): ErrorStatement {
        return this;
    }

    override accept(v: Visitor): void {
        v.visitErrorStatement(this);
    }
}

/***********************************************************
 * statement.d:356.
 */
export class PeelStatement extends Statement {
    s: Statement;

    // statement.d:360 — `s` is dereferenced (`s.loc`) -> non-null param (02 §10.1).
    constructor(s: Statement) {
        super(s.loc, STMT.Peel);
        this.s = s;
    }

    // No syntaxCopy override in D: a PeelStatement inherits the base `assert(0)`.

    override accept(v: Visitor): void {
        v.visitPeelStatement(this);
    }
}

/***********************************************************
 * statement.d:376 — https://dlang.org/spec/statement.html#ExpressionStatement
 * NOT final in D — DtorExpStatement extends it.
 */
export class ExpStatement extends Statement {
    exp: Expression | null;

    /**
     * statement.d:380 + :386 — `this(Loc, Expression)` and `this(Loc, Expression, STMT)` are
     * arity-distinct prefixes, so they collapse to ONE ctor with the trailing STMT defaulted
     * (04 §1 Form A). This is the FIELD ctor and the one DtorExpStatement reaches via `super`.
     */
    constructor(loc: Loc, exp: Expression | null, stmt: STMT = STMT.Exp) {
        super(loc, stmt);
        this.exp = exp;
    }

    /*******************************
     * statement.d:396 — `this(Loc loc, Dsymbol declaration)`: creates a DeclarationExp inside a
     * statement. Use in place of *DeclarationStatement* from D grammar.
     *
     * Same arity as the (Loc, Expression) ctor and a different param type -> named static factory
     * (04 §1.1c); rewrite each D call site to the form D selected statically. `declaration` is a
     * bare class ref the D body neither dereferences nor null-tests, so it stays nullable
     * (02 §10.1) — the two D call sites of THIS overload, parse.d:6142 and parse.d:6169, both hand
     * it a raw `Dsymbols` slot (`AST.Dsymbol d = (*a)[0];`). Do not confuse them with
     * parse.d:6145/:6264, which are `cast(AST.Expression)null` and select the sibling ctor.
     */
    static fromDsymbol(loc: Loc, declaration: Dsymbol | null): ExpStatement {
        return new ExpStatement(loc, new DeclarationExp(loc, declaration), STMT.Exp);
    }

    // statement.d:402 — `static ExpStatement create(Loc loc, Expression exp)`. The body only
    // forwards to the ctor: no dereference, no null test, so the bare class ref stays nullable
    // (02 §10.1, the same no-body-signal reading as `fromDsymbol` above and as
    // CompoundStatement.create / TryFinallyStatement.create).
    static create(loc: Loc, exp: Expression | null): ExpStatement {
        return new ExpStatement(loc, exp);
    }

    // statement.d:407 — deep node copy (exp nullable).
    override syntaxCopy(): ExpStatement {
        return new ExpStatement(this.loc, this.exp !== null ? this.exp.syntaxCopy() : null);
    }

    override accept(v: Visitor): void {
        v.visitExpStatement(this);
    }
}

/***********************************************************
 * statement.d:420.
 */
export class DtorExpStatement extends ExpStatement {
    // statement.d:423 — wraps an expression that is the destruction of 'var'.
    var_: VarDeclaration | null = null;   // ported: D field `var` (JS-reserved) -> var_ (01 §2.3)

    // statement.d:425.
    constructor(loc: Loc, exp: Expression | null, var_: VarDeclaration | null) {
        super(loc, exp, STMT.DtorExp);
        this.var_ = var_;
    }

    // statement.d:431 — deep node copy (exp nullable; `var` shared — a class ref).
    override syntaxCopy(): DtorExpStatement {
        return new DtorExpStatement(this.loc, this.exp !== null ? this.exp.syntaxCopy() : null, this.var_);
    }

    override accept(v: Visitor): void {
        v.visitDtorExpStatement(this);
    }
}

/***********************************************************
 * statement.d:446 — https://dlang.org/spec/statement.html#mixin-statement
 * Note: was called CompileStatement.
 */
export class MixinStatement extends Statement {
    exps: Expressions | null;

    /**
     * statement.d:456 — `this(Loc loc, Expressions* exps)`, the FIELD ctor. Kept as the TS
     * `constructor` (04 §1.1c): it is also the form the ported dependents already call
     * (parse.ts, from parse.d:6187).
     */
    constructor(loc: Loc, exps: Expressions | null) {
        super(loc, STMT.Mixin);
        this.exps = exps;
    }

    /**
     * statement.d:450 — `this(Loc loc, Expression exp)`: wraps the single expression in a fresh
     * one-element `Expressions` and delegates. Same arity as the field ctor with a different param
     * type -> named static factory (04 §1.1c). Sole D call site: clone.d:879.
     */
    static fromExpression(loc: Loc, exp: Expression): MixinStatement {
        const exps: Expressions = DArray.from<Expression | null>(exp);  // `new Expressions(exp)` (08 §3)
        return new MixinStatement(loc, exps);
    }

    // statement.d:462 — deep node copy via Expression.arraySyntaxCopy.
    override syntaxCopy(): MixinStatement {
        return new MixinStatement(this.loc, Expression.arraySyntaxCopy(this.exps));
    }

    override accept(v: Visitor): void {
        v.visitMixinStatement(this);
    }
}

/***********************************************************
 * statement.d:475. NOT final in D — CompoundDeclarationStatement / CompoundAsmStatement extend it.
 */
export class CompoundStatement extends Statement {
    statements: Statements | null;

    /**
     * statement.d:487 + :493 — construct a `CompoundStatement` using an already existing array of
     * `Statement`s, optionally under a different STMT tag. Arity-distinct prefixes -> ONE ctor
     * with the trailing STMT defaulted (04 §1 Form A). This is the FIELD ctor, and the one
     * CompoundDeclarationStatement / CompoundAsmStatement reach through `super`.
     *
     * Params:
     *   loc = Instantiation information
     *   statements = An array of `Statement`s, that will be referenced by this class
     *   stmt = the node tag (defaults to STMT.Compound)
     */
    constructor(loc: Loc, statements: Statements | null, stmt: STMT = STMT.Compound) {
        super(loc, stmt);
        this.statements = statements;
    }

    /**
     * statement.d:507 — `this(Loc loc, Statement[] sts...)`: construct a `CompoundStatement` from a
     * loose list of `Statement`s, that will be copied into a fresh container in this class (the
     * entries themselves are not copied).
     *
     * Same arity as the field ctor with a different second-param type -> named static factory
     * (04 §1.1c). The Form-B split is load-bearing here, not cosmetic: D disambiguates with an
     * explicit `cast(AST.Statement)null` (parse.d:5518) and `null` satisfies BOTH overloads, so an
     * `instanceof`-discriminated collapse would route that call to the container branch and build a
     * CompoundStatement with `statements == null` instead of a one-null-element array.
     * Element type is `Statement | null` for exactly that call site.
     *
     * D's typesafe variadic also accepts a whole array; a TS rest param needs the spread at such a
     * call site (04 §3.2).
     */
    static fromStatementList(loc: Loc, ...sts: (Statement | null)[]): CompoundStatement {
        const statements: Statements = new DArray<Statement | null>();  // `new Statements()` (08 §3)
        statements.reserve(sts.length);
        for (const s of sts)
            statements.push(s);
        return new CompoundStatement(loc, statements, STMT.Compound);
    }

    // statement.d:516 — `static CompoundStatement create(Loc loc, Statement s1, Statement s2)`,
    // which in D selects the variadic ctor -> routed through the factory above. The body only
    // forwards, so both bare class refs stay nullable (02 §10.1 no-body-signal, matching
    // ExpStatement.create / TryFinallyStatement.create).
    static create(loc: Loc, s1: Statement | null, s2: Statement | null): CompoundStatement {
        return CompoundStatement.fromStatementList(loc, s1, s2);
    }

    // statement.d:521 — deep node copy via Statement.arraySyntaxCopy.
    override syntaxCopy(): CompoundStatement {
        return new CompoundStatement(this.loc, Statement.arraySyntaxCopy(this.statements));
    }

    // statement.d:526 — the first inner statement that unconditionally ends with a return.
    // `*statements` is dereferenced without a null test in D -> `!` at the same fault point.
    override endsWithReturnStatement(): ReturnStatement | null {
        for (const s of this.statements!) {                 // foreach (s; *statements)
            if (s !== null) {
                const rs = s.endsWithReturnStatement();     // `if (inout rs = ...)` (06 §2.6)
                if (rs !== null)
                    return rs;
            }
        }
        return null;
    }

    // statement.d:539 — the last executable statement: walk from the end, recursing via `.last()`.
    override last(): Statement | null {
        let s: Statement | null = null;
        for (let i = this.statements!.length; i !== 0; --i) {   // `i` is size_t -> `i !== 0` (09 §9)
            s = this.statements!.opIndex(i - 1);
            if (s !== null) {
                s = s.last();
                if (s !== null)
                    break;
            }
        }
        return s;
    }

    override accept(v: Visitor): void {
        v.visitCompoundStatement(this);
    }

    // statement.d:560-573 — `version (IN_LLVM)` override. resolved: IN_LLVM -> ON, FE-shaping -> KEPT.
    override endsWithAsm(): CompoundAsmStatement | null {
        // make the last inner statement decide
        if (this.statements !== null && this.statements.length !== 0) {   // `length` -> `!== 0` (09 §9)
            const last = this.statements.length - 1;
            const s = this.statements.opIndex(last);        // `if (auto s = (*statements)[last])` (06 §2.6)
            if (s !== null)
                return s.endsWithAsm();
        }
        return null;
    }
}

/***********************************************************
 * statement.d:578.
 */
export class CompoundDeclarationStatement extends CompoundStatement {
    // statement.d:580.
    constructor(loc: Loc, statements: Statements | null) {
        super(loc, statements, STMT.CompoundDeclaration);
    }

    // statement.d:585 — deep node copy via Statement.arraySyntaxCopy.
    override syntaxCopy(): CompoundDeclarationStatement {
        return new CompoundDeclarationStatement(this.loc, Statement.arraySyntaxCopy(this.statements));
    }

    override accept(v: Visitor): void {
        v.visitCompoundDeclarationStatement(this);
    }
}

/***********************************************************
 * statement.d:600 — The purpose of this is so that continue will go to the next of the statements,
 * and break will go to the end of the statements.
 */
export class UnrolledLoopStatement extends Statement {
    statements: Statements | null;

    // statement.d:604.
    constructor(loc: Loc, statements: Statements | null) {
        super(loc, STMT.UnrolledLoop);
        this.statements = statements;
    }

    // statement.d:610 — deep node copy via Statement.arraySyntaxCopy.
    override syntaxCopy(): UnrolledLoopStatement {
        return new UnrolledLoopStatement(this.loc, Statement.arraySyntaxCopy(this.statements));
    }

    // statement.d:615 / :620.
    override hasBreak(): boolean { return true; }
    override hasContinue(): boolean { return true; }

    override accept(v: Visitor): void {
        v.visitUnrolledLoopStatement(this);
    }
}

/***********************************************************
 * statement.d:633.
 */
export class ScopeStatement extends Statement {
    statement: Statement | null;
    endloc: Loc;                // statement.d:636 — location of closing curly bracket

    // statement.d:638.
    constructor(loc: Loc, statement: Statement | null, endloc: Loc) {
        super(loc, STMT.Scope);
        this.statement = statement;
        this.endloc = endloc;
    }

    // statement.d:645 — deep node copy (statement nullable).
    override syntaxCopy(): ScopeStatement {
        return new ScopeStatement(this.loc, this.statement !== null ? this.statement.syntaxCopy() : null, this.endloc);
    }

    // statement.d:650 — delegate to the wrapped statement.
    override endsWithReturnStatement(): ReturnStatement | null {
        if (this.statement !== null)
            return this.statement.endsWithReturnStatement();
        return null;
    }

    // statement.d:657.
    override hasBreak(): boolean {
        //printf("ScopeStatement::hasBreak() %s\n", toChars());
        return this.statement !== null ? this.statement.hasBreak() : false;
    }

    // statement.d:663.
    override hasContinue(): boolean {
        return this.statement !== null ? this.statement.hasContinue() : false;
    }

    override accept(v: Visitor): void {
        v.visitScopeStatement(this);
    }
}

/***********************************************************
 * statement.d:681 — Statement whose symbol table contains foreach index variables in a local scope
 * and forwards other members to the parent scope. This wraps a statement.
 *
 * Also see: `dmd.attrib.ForwardingAttribDeclaration`
 */
export class ForwardingStatement extends Statement {
    /// statement.d:684 — the symbol containing the `static foreach` variables.
    sym: ForwardingScopeDsymbol | null = null;
    /// statement.d:686 — the wrapped statement.
    statement: Statement;

    /**
     * statement.d:688 — the FIELD ctor, kept as the TS `constructor`. (The sibling `this(Loc,
     * Statement)` is arity-distinct but NOT a prefix of this one — its `statement` sits at a
     * different position — so collapsing the pair would need a union-typed second parameter, the
     * shape 04 §1.1c forbids. It becomes `fromStatement` below.)
     *
     * `statement` is `Statement | null`: the D body NULL-TESTS it (`assert(statement)`,
     * statement.d:692, D's truthiness-of-a-class-reference form -> `!== null`, 06 §2.7), which is
     * the 02 §10.1 signal for a nullable parameter. Typing it non-null would make the ported assert
     * unfireable — dead code guarding exactly the value D wrote it to catch. The assert is what
     * establishes the non-null `statement` FIELD invariant, so it narrows before the store.
     */
    constructor(loc: Loc, sym: ForwardingScopeDsymbol | null, statement: Statement | null) {
        super(loc, STMT.Forwarding);
        this.sym = sym;
        assert(statement !== null);                         // statement.d:692
        this.statement = statement;
    }

    /**
     * statement.d:696 — `this(Loc loc, Statement statement)`: synthesizes the forwarding scope
     * symbol (with a fresh empty symtab) and delegates to the field ctor. Named static factory per
     * 04 §1.1c. Sole D call site: statementsem.d:4771. `statement` is nullable for the same reason
     * as the field ctor it delegates to: D routes it straight into that `assert(statement)`, and a
     * non-null parameter here would put the assert out of reach from this D entry point too.
     */
    static fromStatement(loc: Loc, statement: Statement | null): ForwardingStatement {
        const sym = new ForwardingScopeDsymbol();
        sym.symtab = new DsymbolTable();
        return new ForwardingStatement(loc, sym, statement);
    }

    // statement.d:703 — deep node copy; D routes through the (Loc, Statement) ctor, so the copy
    // regenerates a fresh `sym` rather than sharing this one.
    override syntaxCopy(): ForwardingStatement {
        return ForwardingStatement.fromStatement(this.loc, this.statement.syntaxCopy());
    }

    override accept(v: Visitor): void {
        v.visitForwardingStatement(this);
    }
}

/***********************************************************
 * statement.d:718 — https://dlang.org/spec/statement.html#while-statement
 */
export class WhileStatement extends Statement {
    param: Parameter | null;
    condition: Expression | null;
    _body: Statement | null;
    endloc: Loc;                // statement.d:723 — location of closing curly bracket

    // statement.d:725 — `param` carries D's `= null` default (04 §2).
    constructor(loc: Loc, condition: Expression | null, _body: Statement | null, endloc: Loc,
                param: Parameter | null = null) {
        super(loc, STMT.While);
        this.condition = condition;
        this._body = _body;
        this.endloc = endloc;
        this.param = param;
    }

    // statement.d:734 — deep node copy (condition dereferenced unconditionally by D; body/param nullable).
    override syntaxCopy(): WhileStatement {
        return new WhileStatement(this.loc,
            this.condition!.syntaxCopy(),
            this._body !== null ? this._body.syntaxCopy() : null,
            this.endloc, this.param !== null ? this.param.syntaxCopy() : null);
    }

    // statement.d:742 / :747.
    override hasBreak(): boolean { return true; }
    override hasContinue(): boolean { return true; }

    override accept(v: Visitor): void {
        v.visitWhileStatement(this);
    }
}

/***********************************************************
 * statement.d:761 — https://dlang.org/spec/statement.html#do-statement
 */
export class DoStatement extends Statement {
    _body: Statement | null;
    condition: Expression | null;
    endloc: Loc;                // statement.d:765 — location of ';' after while

    // statement.d:767.
    constructor(loc: Loc, _body: Statement | null, condition: Expression | null, endloc: Loc) {
        super(loc, STMT.Do);
        this._body = _body;
        this.condition = condition;
        this.endloc = endloc;
    }

    // statement.d:775 — deep node copy (body nullable; condition dereferenced unconditionally).
    override syntaxCopy(): DoStatement {
        return new DoStatement(this.loc,
            this._body !== null ? this._body.syntaxCopy() : null,
            this.condition!.syntaxCopy(),
            this.endloc);
    }

    // statement.d:783 / :788.
    override hasBreak(): boolean { return true; }
    override hasContinue(): boolean { return true; }

    override accept(v: Visitor): void {
        v.visitDoStatement(this);
    }
}

/***********************************************************
 * statement.d:802 — https://dlang.org/spec/statement.html#for-statement
 */
export class ForStatement extends Statement {
    _init: Statement | null;
    condition: Expression | null;
    increment: Expression | null;
    _body: Statement | null;
    endloc: Loc;                // statement.d:808 — location of closing curly bracket

    // statement.d:813 — When wrapped in try/finally clauses, this points to the outermost one,
    // which may have an associated label. Internal break/continue statements treat that label as
    // referring to this loop.
    relatedLabeled: Statement | null = null;

    // statement.d:815.
    constructor(loc: Loc, _init: Statement | null, condition: Expression | null,
                increment: Expression | null, _body: Statement | null, endloc: Loc) {
        super(loc, STMT.For);
        this._init = _init;
        this.condition = condition;
        this.increment = increment;
        this._body = _body;
        this.endloc = endloc;
    }

    // statement.d:825 — deep node copy (init/condition/increment nullable; body dereferenced).
    override syntaxCopy(): ForStatement {
        return new ForStatement(this.loc,
            this._init !== null ? this._init.syntaxCopy() : null,
            this.condition !== null ? this.condition.syntaxCopy() : null,
            this.increment !== null ? this.increment.syntaxCopy() : null,
            this._body!.syntaxCopy(),
            this.endloc);
    }

    // statement.d:835 — the outermost related try/finally label, or `this`.
    override getRelatedLabeled(): Statement {
        return this.relatedLabeled !== null ? this.relatedLabeled : this;
    }

    // statement.d:840 / :846.
    override hasBreak(): boolean {
        //printf("ForStatement::hasBreak()\n");
        return true;
    }
    override hasContinue(): boolean { return true; }

    override accept(v: Visitor): void {
        v.visitForStatement(this);
    }
}

/***********************************************************
 * statement.d:860 — https://dlang.org/spec/statement.html#foreach-statement
 */
export class ForeachStatement extends Statement {
    op: TOK;                          // statement.d:862 — TOK.foreach_ or TOK.foreach_reverse_
    parameters: Parameters | null;    // array of Parameters, one for each ForeachType
    aggr: Expression | null;          // ForeachAggregate
    _body: Statement | null;          // NoScopeNonEmptyStatement
    endloc: Loc;                      // statement.d:866 — location of closing curly bracket

    key: VarDeclaration | null = null;
    value: VarDeclaration | null = null;

    func: FuncDeclaration | null = null;        // statement.d:871 — function we're lexically in

    cases: Statements | null = null;            // put breaks, continues, gotos and returns here
    gotos: ScopeStatements | null = null;       // forward referenced goto's go here

    // statement.d:876.
    constructor(loc: Loc, op: TOK, parameters: Parameters | null, aggr: Expression | null,
                _body: Statement | null, endloc: Loc) {
        super(loc, STMT.Foreach);
        this.op = op;
        this.parameters = parameters;
        this.aggr = aggr;
        this._body = _body;
        this.endloc = endloc;
    }

    // statement.d:886 — deep node copy (parameters via Parameter.arraySyntaxCopy; aggr dereferenced).
    override syntaxCopy(): ForeachStatement {
        return new ForeachStatement(this.loc, this.op,
            Parameter.arraySyntaxCopy(this.parameters),
            this.aggr!.syntaxCopy(),
            this._body !== null ? this._body.syntaxCopy() : null,
            this.endloc);
    }

    // statement.d:895 / :900.
    override hasBreak(): boolean { return true; }
    override hasContinue(): boolean { return true; }

    override accept(v: Visitor): void {
        v.visitForeachStatement(this);
    }
}

/***********************************************************
 * statement.d:914 — https://dlang.org/spec/statement.html#foreach-range-statement
 */
export class ForeachRangeStatement extends Statement {
    op: TOK;                  // statement.d:916 — TOK.foreach_ or TOK.foreach_reverse_
    param: Parameter | null;  // loop index variable
    lwr: Expression | null;
    upr: Expression | null;
    _body: Statement | null;
    endloc: Loc;              // statement.d:921 — location of closing curly bracket

    key: VarDeclaration | null = null;

    // statement.d:925.
    constructor(loc: Loc, op: TOK, param: Parameter | null, lwr: Expression | null,
                upr: Expression | null, _body: Statement | null, endloc: Loc) {
        super(loc, STMT.ForeachRange);
        this.op = op;
        this.param = param;
        this.lwr = lwr;
        this.upr = upr;
        this._body = _body;
        this.endloc = endloc;
    }

    // statement.d:936 — deep node copy (param/lwr/upr dereferenced unconditionally; body nullable).
    override syntaxCopy(): ForeachRangeStatement {
        return new ForeachRangeStatement(this.loc, this.op, this.param!.syntaxCopy(),
            this.lwr!.syntaxCopy(), this.upr!.syntaxCopy(),
            this._body !== null ? this._body.syntaxCopy() : null, this.endloc);
    }

    // statement.d:941 / :946.
    override hasBreak(): boolean { return true; }
    override hasContinue(): boolean { return true; }

    override accept(v: Visitor): void {
        v.visitForeachRangeStatement(this);
    }
}

/***********************************************************
 * statement.d:960 — https://dlang.org/spec/statement.html#if-statement
 */
export class IfStatement extends Statement {
    param: Parameter | null;
    condition: Expression | null;
    ifbody: Statement | null;
    elsebody: Statement | null;
    match: VarDeclaration | null = null;   // statement.d:966 — for MatchExpression results
    endloc: Loc;                           // location of closing curly bracket

    // statement.d:969.
    constructor(loc: Loc, param: Parameter | null, condition: Expression | null,
                ifbody: Statement | null, elsebody: Statement | null, endloc: Loc) {
        super(loc, STMT.If);
        this.param = param;
        this.condition = condition;
        this.ifbody = ifbody;
        this.elsebody = elsebody;
        this.endloc = endloc;
    }

    // statement.d:979 — deep node copy (param/ifbody/elsebody nullable; condition dereferenced).
    override syntaxCopy(): IfStatement {
        return new IfStatement(this.loc,
            this.param !== null ? this.param.syntaxCopy() : null,
            this.condition!.syntaxCopy(),
            this.ifbody !== null ? this.ifbody.syntaxCopy() : null,
            this.elsebody !== null ? this.elsebody.syntaxCopy() : null,
            this.endloc);
    }

    override accept(v: Visitor): void {
        v.visitIfStatement(this);
    }

    /******
     * statement.d:997 — Returns: true if `if (__ctfe)`.
     */
    isIfCtfeBlock(): boolean {
        const cv = this.condition!.isVarExp();              // `if (auto cv = ...)` (06 §2.6)
        if (cv !== null)
            return cv.var_!.ident === Id.ctfe;              // interned identifier identity
        return false;
    }
}

/***********************************************************
 * statement.d:1008 — https://dlang.org/spec/version.html#ConditionalStatement
 */
export class ConditionalStatement extends Statement {
    condition: Condition | null;
    ifbody: Statement | null;
    elsebody: Statement | null;

    // statement.d:1014.
    constructor(loc: Loc, condition: Condition | null, ifbody: Statement | null,
                elsebody: Statement | null) {
        super(loc, STMT.Conditional);
        this.condition = condition;
        this.ifbody = ifbody;
        this.elsebody = elsebody;
    }

    // statement.d:1022 — deep node copy (condition/ifbody dereferenced; elsebody nullable).
    override syntaxCopy(): ConditionalStatement {
        return new ConditionalStatement(this.loc, this.condition!.syntaxCopy(),
            this.ifbody!.syntaxCopy(), this.elsebody !== null ? this.elsebody.syntaxCopy() : null);
    }

    override accept(v: Visitor): void {
        v.visitConditionalStatement(this);
    }
}

/***********************************************************
 * statement.d:1045 — https://dlang.org/spec/version.html#StaticForeachStatement
 * Static foreach statements, like:
 *      void main()
 *      {
 *           static foreach(i; 0 .. 10)
 *           {
 *               pragma(msg, i);
 *           }
 *      }
 */
export class StaticForeachStatement extends Statement {
    sfe: StaticForeach | null;

    // statement.d:1049.
    constructor(loc: Loc, sfe: StaticForeach | null) {
        super(loc, STMT.StaticForeach);
        this.sfe = sfe;
    }

    // statement.d:1055 — deep node copy (sfe dereferenced unconditionally).
    override syntaxCopy(): StaticForeachStatement {
        return new StaticForeachStatement(this.loc, this.sfe!.syntaxCopy());
    }

    override accept(v: Visitor): void {
        v.visitStaticForeachStatement(this);
    }
}

/***********************************************************
 * statement.d:1069 — https://dlang.org/spec/statement.html#pragma-statement
 */
export class PragmaStatement extends Statement {
    readonly ident: Identifier | null;    // statement.d:1071 — `const Identifier ident`
    args: Expressions | null;             // array of Expression's
    _body: Statement | null;

    // statement.d:1075.
    constructor(loc: Loc, ident: Identifier | null, args: Expressions | null, _body: Statement | null) {
        super(loc, STMT.Pragma);
        this.ident = ident;
        this.args = args;
        this._body = _body;
    }

    // statement.d:1083 — deep node copy (ident shared — interned; args via Expression.arraySyntaxCopy).
    override syntaxCopy(): PragmaStatement {
        return new PragmaStatement(this.loc, this.ident, Expression.arraySyntaxCopy(this.args),
            this._body !== null ? this._body.syntaxCopy() : null);
    }

    override accept(v: Visitor): void {
        v.visitPragmaStatement(this);
    }
}

/***********************************************************
 * statement.d:1097 — https://dlang.org/spec/version.html#StaticAssert
 */
export class StaticAssertStatement extends Statement {
    sa: StaticAssert | null;

    // statement.d:1101 — `sa` is dereferenced (`sa.loc`) -> non-null param (02 §10.1).
    constructor(sa: StaticAssert) {
        super(sa.loc, STMT.StaticAssert);
        this.sa = sa;
    }

    // statement.d:1107 — deep node copy (StaticAssert is a Dsymbol: `syntaxCopy(null)`).
    override syntaxCopy(): StaticAssertStatement {
        return new StaticAssertStatement(this.sa!.syntaxCopy(null));
    }

    override accept(v: Visitor): void {
        v.visitStaticAssertStatement(this);
    }
}

/***********************************************************
 * statement.d:1121 — https://dlang.org/spec/statement.html#switch-statement
 */
export class SwitchStatement extends Statement {
    param: Parameter | null;
    condition: Expression | null;       /// switch(condition)
    _body: Statement | null;            ///
    isFinal: boolean = false;           /// https://dlang.org/spec/statement.html#final-switch-statement
    endloc: Loc;

    hasDefault: boolean = false;        /// true if has default statement
    hasVars: boolean = false;           /// true if has variable case values
    sdefault: DefaultStatement | null = null;       /// default:
    tryBody: Statement | null = null;               /// set to TryCatchStatement or TryFinallyStatement if in _body portion
    tryFinally: TryFinallyStatement | null = null;  /// set if in the 'finally' block of a TryFinallyStatement
    // statement.d:1134 `GotoCaseStatements gotoCases;` — the ONLY BY-VALUE container field in the
    // module (its neighbour :1135 `CaseStatements* cases;` carries the `*`). A value `Array!T`
    // field's `.init` is an EMPTY container, never null (09 §1.0), and every D consumer indexes it
    // with no null test (statementsem.d:1932/:2285-2291/:2512). Typed non-nullable and constructed
    // AS the alias (08 §3), same shape as func.ts:235/:313 for func.d:247 `FuncDeclarations
    // foverrides;`. Making it nullable would force either a `!` that faults on the first
    // `goto case` (nothing ever allocates it) or a null-guard D does not have.
    gotoCases: GotoCaseStatements = new DArray<GotoCaseStatement | null>();
    cases: CaseStatements | null = null;            /// array of CaseStatement's (D: `CaseStatements*`)
    lastVar: VarDeclaration | null = null;          /// last observed variable declaration in this statement

    // statement.d:1137-1140 — `version (IN_LLVM)` field. resolved: IN_LLVM -> ON, FE bookkeeping -> KEPT.
    hasGotoDefault: boolean = false;    // true iff there is a `goto default` statement for this switch

    // statement.d:1142.
    constructor(loc: Loc, param: Parameter | null, condition: Expression | null,
                _body: Statement | null, isFinal: boolean, endloc: Loc) {
        super(loc, STMT.Switch);
        this.param = param;
        this.condition = condition;
        this._body = _body;
        this.isFinal = isFinal;
        this.endloc = endloc;
    }

    // statement.d:1152 — deep node copy (param nullable; condition/body dereferenced).
    override syntaxCopy(): SwitchStatement {
        return new SwitchStatement(this.loc,
            this.param !== null ? this.param.syntaxCopy() : null,
            this.condition!.syntaxCopy(),
            this._body!.syntaxCopy(),
            this.isFinal,
            this.endloc);
    }

    // statement.d:1162.
    override hasBreak(): boolean { return true; }

    override accept(v: Visitor): void {
        v.visitSwitchStatement(this);
    }
}

/***********************************************************
 * statement.d:1176 — https://dlang.org/spec/statement.html#CaseStatement
 */
export class CaseStatement extends Statement {
    exp: Expression | null;
    statement: Statement | null;

    index: number = 0;                    // statement.d:1181 — which case it is (since we sort this)
    lastVar: VarDeclaration | null = null;
    extra: unknown = null;                // `void* extra` — for use by Statement_toIR() (02 §10 opaque)

    // statement.d:1185-1188 — `version (IN_LLVM)` field. resolved: IN_LLVM -> ON, FE bookkeeping -> KEPT.
    gototarget: boolean = false;          // true iff this is the target of a 'goto case'

    // statement.d:1190.
    constructor(loc: Loc, exp: Expression | null, statement: Statement | null) {
        super(loc, STMT.Case);
        this.exp = exp;
        this.statement = statement;
    }

    // statement.d:1197 — deep node copy (exp/statement dereferenced unconditionally).
    override syntaxCopy(): CaseStatement {
        return new CaseStatement(this.loc, this.exp!.syntaxCopy(), this.statement!.syntaxCopy());
    }

    override accept(v: Visitor): void {
        v.visitCaseStatement(this);
    }
}

/***********************************************************
 * statement.d:1211 — https://dlang.org/spec/statement.html#CaseRangeStatement
 */
export class CaseRangeStatement extends Statement {
    first: Expression | null;
    // ported: D field `last` (statement.d:1214). Renamed `last_` ONLY because `Statement.last()`
    // (statement.d:243) is a method on the same class in TS — a field and a method cannot share a
    // name. Not a JS-reserved-word rename (01 §2.3), and no other field is renamed for this reason.
    last_: Expression | null;
    statement: Statement | null;

    // statement.d:1217.
    constructor(loc: Loc, first: Expression | null, last_: Expression | null, statement: Statement | null) {
        super(loc, STMT.CaseRange);
        this.first = first;
        this.last_ = last_;
        this.statement = statement;
    }

    // statement.d:1225 — deep node copy (first/last/statement dereferenced unconditionally).
    override syntaxCopy(): CaseRangeStatement {
        return new CaseRangeStatement(this.loc, this.first!.syntaxCopy(), this.last_!.syntaxCopy(),
            this.statement!.syntaxCopy());
    }

    override accept(v: Visitor): void {
        v.visitCaseRangeStatement(this);
    }
}

/***********************************************************
 * statement.d:1239 — https://dlang.org/spec/statement.html#DefaultStatement
 */
export class DefaultStatement extends Statement {
    statement: Statement | null;

    lastVar: VarDeclaration | null = null;

    // statement.d:1245-1248 — `version (IN_LLVM)` field. resolved: IN_LLVM -> ON, FE bookkeeping -> KEPT.
    gototarget: boolean = false;          // true iff this is the target of a 'goto default'

    // statement.d:1250.
    constructor(loc: Loc, statement: Statement | null) {
        super(loc, STMT.Default);
        this.statement = statement;
    }

    // statement.d:1256 — deep node copy (statement dereferenced unconditionally).
    override syntaxCopy(): DefaultStatement {
        return new DefaultStatement(this.loc, this.statement!.syntaxCopy());
    }

    override accept(v: Visitor): void {
        v.visitDefaultStatement(this);
    }
}

/***********************************************************
 * statement.d:1270 — https://dlang.org/spec/statement.html#GotoStatement
 */
export class GotoDefaultStatement extends Statement {
    sw: SwitchStatement | null = null;

    // statement.d:1274.
    constructor(loc: Loc) {
        super(loc, STMT.GotoDefault);
    }

    // statement.d:1279 — deep node copy (no children).
    override syntaxCopy(): GotoDefaultStatement {
        return new GotoDefaultStatement(this.loc);
    }

    override accept(v: Visitor): void {
        v.visitGotoDefaultStatement(this);
    }
}

/***********************************************************
 * statement.d:1293 — https://dlang.org/spec/statement.html#GotoStatement
 */
export class GotoCaseStatement extends Statement {
    exp: Expression | null;             // statement.d:1295 — null, or which case to goto
    cs: CaseStatement | null = null;    // case statement it resolves to

    // statement.d:1299-1302 — `version (IN_LLVM)` field. resolved: IN_LLVM -> ON, FE bookkeeping -> KEPT.
    sw: SwitchStatement | null = null;

    // statement.d:1304.
    constructor(loc: Loc, exp: Expression | null) {
        super(loc, STMT.GotoCase);
        this.exp = exp;
    }

    // statement.d:1310 — deep node copy (exp nullable).
    override syntaxCopy(): GotoCaseStatement {
        return new GotoCaseStatement(this.loc, this.exp !== null ? this.exp.syntaxCopy() : null);
    }

    override accept(v: Visitor): void {
        v.visitGotoCaseStatement(this);
    }
}

/***********************************************************
 * statement.d:1323.
 */
export class SwitchErrorStatement extends Statement {
    exp: Expression | null = null;

    // statement.d:1327 + :1332 — `this(Loc)` and `this(Loc, Expression)` are arity-distinct
    // prefixes -> ONE ctor with the trailing param defaulted (04 §1 Form A). Omitting `exp`
    // leaves the field at its D `.init` (null, 09 §1.0), exactly as the 1-arg ctor does.
    constructor(loc: Loc, exp: Expression | null = null) {
        super(loc, STMT.SwitchError);
        this.exp = exp;
    }

    // No syntaxCopy override in D: inherits the base `assert(0)`.

    override accept(v: Visitor): void {
        v.visitSwitchErrorStatement(this);
    }
}

/***********************************************************
 * statement.d:1347 — https://dlang.org/spec/statement.html#return-statement
 */
export class ReturnStatement extends Statement {
    exp: Expression | null;
    caseDim: number = 0;        // `size_t caseDim` — index domain -> number (02 §1, 09 §1.1)
    fesFunc: FuncDeclaration | null = null;   // statement.d:1351 — nested function for foreach it is in

    // statement.d:1353.
    constructor(loc: Loc, exp: Expression | null) {
        super(loc, STMT.Return);
        this.exp = exp;
    }

    // statement.d:1359 — deep node copy (exp nullable).
    override syntaxCopy(): ReturnStatement {
        return new ReturnStatement(this.loc, this.exp !== null ? this.exp.syntaxCopy() : null);
    }

    // statement.d:1364.
    override endsWithReturnStatement(): ReturnStatement | null {
        return this;
    }

    override accept(v: Visitor): void {
        v.visitReturnStatement(this);
    }
}

/***********************************************************
 * statement.d:1378 — https://dlang.org/spec/statement.html#break-statement
 */
export class BreakStatement extends Statement {
    ident: Identifier | null;

    // statement.d:1382-1386 — `version (IN_LLVM)` field. resolved: IN_LLVM -> ON, FE bookkeeping -> KEPT.
    // LDC: only set if ident is set: label statement to jump to
    target: LabelStatement | null = null;

    // statement.d:1388.
    constructor(loc: Loc, ident: Identifier | null) {
        super(loc, STMT.Break);
        this.ident = ident;
    }

    // statement.d:1394 — deep node copy (ident shared — interned).
    override syntaxCopy(): BreakStatement {
        return new BreakStatement(this.loc, this.ident);
    }

    override accept(v: Visitor): void {
        v.visitBreakStatement(this);
    }
}

/***********************************************************
 * statement.d:1408 — https://dlang.org/spec/statement.html#continue-statement
 */
export class ContinueStatement extends Statement {
    ident: Identifier | null;

    // statement.d:1412-1416 — `version (IN_LLVM)` field. resolved: IN_LLVM -> ON, FE bookkeeping -> KEPT.
    // LDC: only set if ident is set: label statement to jump to
    target: LabelStatement | null = null;

    // statement.d:1418.
    constructor(loc: Loc, ident: Identifier | null) {
        super(loc, STMT.Continue);
        this.ident = ident;
    }

    // statement.d:1424 — deep node copy (ident shared — interned).
    override syntaxCopy(): ContinueStatement {
        return new ContinueStatement(this.loc, this.ident);
    }

    override accept(v: Visitor): void {
        v.visitContinueStatement(this);
    }
}

/***********************************************************
 * statement.d:1438 — https://dlang.org/spec/statement.html#SynchronizedStatement
 */
export class SynchronizedStatement extends Statement {
    exp: Expression | null;
    _body: Statement | null;

    // statement.d:1443.
    constructor(loc: Loc, exp: Expression | null, _body: Statement | null) {
        super(loc, STMT.Synchronized);
        this.exp = exp;
        this._body = _body;
    }

    // statement.d:1450 — deep node copy (exp/body nullable).
    override syntaxCopy(): SynchronizedStatement {
        return new SynchronizedStatement(this.loc, this.exp !== null ? this.exp.syntaxCopy() : null,
            this._body !== null ? this._body.syntaxCopy() : null);
    }

    // statement.d:1455 / :1460 — D returns false with the `//true;` comment kept verbatim.
    override hasBreak(): boolean { return false; /*true;*/ }
    override hasContinue(): boolean { return false; /*true;*/ }

    override accept(v: Visitor): void {
        v.visitSynchronizedStatement(this);
    }
}

/***********************************************************
 * statement.d:1474 — https://dlang.org/spec/statement.html#with-statement
 */
export class WithStatement extends Statement {
    prm: Parameter | null;
    exp: Expression | null;
    _body: Statement | null;
    wthis: VarDeclaration | null = null;
    endloc: Loc;

    // statement.d:1482.
    constructor(loc: Loc, prm: Parameter | null, exp: Expression | null, _body: Statement | null, endloc: Loc) {
        super(loc, STMT.With);
        this.prm = prm;
        this.exp = exp;
        this._body = _body;
        this.endloc = endloc;
    }

    // statement.d:1491 — deep node copy (prm/body nullable; exp dereferenced unconditionally).
    override syntaxCopy(): WithStatement {
        return new WithStatement(this.loc,
                                 this.prm !== null ? this.prm.syntaxCopy() : null,
                                 this.exp!.syntaxCopy(),
                                 this._body !== null ? this._body.syntaxCopy() : null,
                                 this.endloc);
    }

    override accept(v: Visitor): void {
        v.visitWithStatement(this);
    }
}

/***********************************************************
 * statement.d:1509 — https://dlang.org/spec/statement.html#try-statement
 */
export class TryCatchStatement extends Statement {
    _body: Statement | null;
    catches: Catches | null;

    /// statement.d:1514 — set to enclosing TryCatchStatement or TryFinallyStatement if in _body portion
    tryBody: Statement | null = null;

    // statement.d:1516.
    constructor(loc: Loc, _body: Statement | null, catches: Catches | null) {
        super(loc, STMT.TryCatch);
        this._body = _body;
        this.catches = catches;
    }

    // statement.d:1523 — deep node copy: clone every Catch into a pre-sized array; body dereferenced.
    override syntaxCopy(): TryCatchStatement {
        const a: Catches = new DArray<Catch | null>(this.catches!.length);   // `new Catches(len)` (08 §3)
        for (let i = 0; i < this.catches!.length; i++) {    // foreach (i, c; *catches)
            // The slot is `Catch | null` (08 §3); statement.d:1528 calls through it with no null
            // test, so the `!` sits at exactly the point D would fault.
            a.opIndexAssign(this.catches!.opIndex(i)!.syntaxCopy(), i);
        }
        return new TryCatchStatement(this.loc, this._body!.syntaxCopy(), a);
    }

    // statement.d:1533.
    override hasBreak(): boolean { return false; }

    override accept(v: Visitor): void {
        v.visitTryCatchStatement(this);
    }
}

/***********************************************************
 * statement.d:1547 — https://dlang.org/spec/statement.html#Catch
 *
 * NOTE: `Catch : RootObject` (NOT Statement, NOT ASTNode) and has NO `accept` — it is not a
 * visited AST node, just a syntax-tree helper held in TryCatchStatement.catches.
 */
export class Catch extends RootObject {
    readonly loc: Loc;          // statement.d:1549 — `const Loc loc`
    type: Type | null;
    ident: Identifier | null;
    handler: Statement | null;

    var_: VarDeclaration | null = null;   // ported: D field `var` (JS-reserved) -> var_ (01 §2.3)
    errors: boolean = false;              // statement.d:1555 — set if semantic processing errors

    // statement.d:1558 — was generated by the compiler, wasn't present in source code
    internalCatch: boolean = false;

    // statement.d:1560.
    constructor(loc: Loc, type: Type | null, ident: Identifier | null, handler: Statement | null) {
        super();
        //printf("Catch(%s, loc = %s)\n", id.toChars(), loc.toChars());
        this.loc = loc;
        this.type = type;
        this.ident = ident;
        this.handler = handler;
    }

    // statement.d:1569 — deep node copy. A null type defaults to the Throwable type (getThrowable);
    // ident shared (interned); handler nullable; the internalCatch flag is carried across.
    syntaxCopy(): Catch {
        const c = new Catch(this.loc, this.type !== null ? this.type.syntaxCopy() : getThrowable(),
            this.ident, (this.handler !== null ? this.handler.syntaxCopy() : null));
        c.internalCatch = this.internalCatch;
        return c;
    }
}

/***********************************************************
 * statement.d:1580 — https://dlang.org/spec/statement.html#try-statement
 */
export class TryFinallyStatement extends Statement {
    _body: Statement | null;
    finalbody: Statement | null;

    /// statement.d:1585 — set to enclosing TryCatchStatement or TryFinallyStatement if in _body portion
    tryBody: Statement | null = null;
    // statement.d:1586 `bool bodyFallsThru;` — the field's `.init` is FALSE (09 §1.0); the ctor is
    // what raises it to true. The declaration carries `.init`, never a value hoisted from a ctor.
    bodyFallsThru: boolean = false;      /// true if _body falls through to finally

    // statement.d:1588.
    constructor(loc: Loc, _body: Statement | null, finalbody: Statement | null) {
        super(loc, STMT.TryFinally);
        this._body = _body;
        this.finalbody = finalbody;
        this.bodyFallsThru = true;       // assume true until statementSemantic()
    }

    // statement.d:1596.
    static create(loc: Loc, _body: Statement | null, finalbody: Statement | null): TryFinallyStatement {
        return new TryFinallyStatement(loc, _body, finalbody);
    }

    // statement.d:1601 — deep node copy (body/finalbody dereferenced unconditionally).
    override syntaxCopy(): TryFinallyStatement {
        return new TryFinallyStatement(this.loc, this._body!.syntaxCopy(), this.finalbody!.syntaxCopy());
    }

    // statement.d:1606 / :1611 — D returns false with the `//true;` comment kept verbatim.
    override hasBreak(): boolean { return false; /*true;*/ }
    override hasContinue(): boolean { return false; /*true;*/ }

    override accept(v: Visitor): void {
        v.visitTryFinallyStatement(this);
    }
}

/***********************************************************
 * statement.d:1625 — https://dlang.org/spec/statement.html#scope-guard-statement
 */
export class ScopeGuardStatement extends Statement {
    tok: TOK;
    statement: Statement | null;

    // statement.d:1630.
    constructor(loc: Loc, tok: TOK, statement: Statement | null) {
        super(loc, STMT.ScopeGuard);
        this.tok = tok;
        this.statement = statement;
    }

    // statement.d:1637 — deep node copy (statement dereferenced unconditionally; tok carried).
    override syntaxCopy(): ScopeGuardStatement {
        return new ScopeGuardStatement(this.loc, this.tok, this.statement!.syntaxCopy());
    }

    override accept(v: Visitor): void {
        v.visitScopeGuardStatement(this);
    }
}

/***********************************************************
 * statement.d:1651 — https://dlang.org/spec/statement.html#throw-statement
 */
export class ThrowStatement extends Statement {
    exp: Expression | null;

    // statement.d:1656 — was generated by the compiler, wasn't present in source code
    internalThrow: boolean = false;

    // statement.d:1658.
    constructor(loc: Loc, exp: Expression | null) {
        super(loc, STMT.Throw);
        this.exp = exp;
    }

    // statement.d:1664 — deep node copy (exp dereferenced; internalThrow flag carried across).
    override syntaxCopy(): ThrowStatement {
        const s = new ThrowStatement(this.loc, this.exp!.syntaxCopy());
        s.internalThrow = this.internalThrow;
        return s;
    }

    override accept(v: Visitor): void {
        v.visitThrowStatement(this);
    }
}

/***********************************************************
 * statement.d:1679.
 */
export class DebugStatement extends Statement {
    statement: Statement | null;

    // statement.d:1683.
    constructor(loc: Loc, statement: Statement | null) {
        super(loc, STMT.Debug);
        this.statement = statement;
    }

    // statement.d:1689 — deep node copy (statement nullable).
    override syntaxCopy(): DebugStatement {
        return new DebugStatement(this.loc, this.statement !== null ? this.statement.syntaxCopy() : null);
    }

    override accept(v: Visitor): void {
        v.visitDebugStatement(this);
    }
}

/***********************************************************
 * statement.d:1703 — https://dlang.org/spec/statement.html#goto-statement
 */
export class GotoStatement extends Statement {
    ident: Identifier | null;
    label: LabelDsymbol | null = null;
    /// statement.d:1707 — set to TryCatchStatement or TryFinallyStatement if in _body portion
    tryBody: Statement | null = null;
    tf: TryFinallyStatement | null = null;
    os: ScopeGuardStatement | null = null;
    lastVar: VarDeclaration | null = null;
    inCtfeBlock: boolean = false;                   /// set if goto is inside an `if (__ctfe)` block

    // statement.d:1713.
    constructor(loc: Loc, ident: Identifier | null) {
        super(loc, STMT.Goto);
        this.ident = ident;
    }

    // statement.d:1719 — deep node copy (ident shared — interned).
    override syntaxCopy(): GotoStatement {
        return new GotoStatement(this.loc, this.ident);
    }

    override accept(v: Visitor): void {
        v.visitGotoStatement(this);
    }
}

/***********************************************************
 * statement.d:1733 — https://dlang.org/spec/statement.html#LabeledStatement
 */
export class LabelStatement extends Statement {
    ident: Identifier | null;
    statement: Statement | null;

    /// statement.d:1738 — set to TryCatchStatement or TryFinallyStatement if in _body portion
    tryBody: Statement | null = null;
    tf: TryFinallyStatement | null = null;
    os: ScopeGuardStatement | null = null;
    lastVar: VarDeclaration | null = null;
    gotoTarget: Statement | null = null;            // interpret
    extra: unknown = null;                          // `void* extra` — used by Statement_toIR() (02 §10)
    breaks: boolean = false;                        // someone did a 'break ident'
    inCtfeBlock: boolean = false;                   // inside a block dominated by `if (__ctfe)`

    // statement.d:1747.
    constructor(loc: Loc, ident: Identifier | null, statement: Statement | null) {
        super(loc, STMT.Label);
        this.ident = ident;
        this.statement = statement;
    }

    // statement.d:1754 — deep node copy (ident shared; statement nullable).
    override syntaxCopy(): LabelStatement {
        return new LabelStatement(this.loc, this.ident,
            this.statement !== null ? this.statement.syntaxCopy() : null);
    }

    override accept(v: Visitor): void {
        v.visitLabelStatement(this);
    }
}

/***********************************************************
 * statement.d:1767.
 *
 * NOTE: `LabelDsymbol : Dsymbol` (NOT Statement) — it is the symbol-table entry for a label.
 */
export class LabelDsymbol extends Dsymbol {
    statement: LabelStatement | null = null;

    deleted: boolean = false;       // statement.d:1771 — set if rewritten to return in foreach delegate
    iasm: boolean = false;          // set if used by inline assembler

    // set if label was defined multiple times, to avoid duplicate errors
    // can be removed if generic error message deduplication is implemented
    duplicated: boolean = false;

    // statement.d:1778 — `super(DSYM.labelDsymbol, loc, ident)`; `loc` defaults to Loc.initial.
    constructor(ident: Identifier, loc: Loc = Loc.initial) {
        super(DSYM.labelDsymbol, loc, ident);
    }

    // statement.d:1783 — hides the static `Dsymbol.create(ident)` with a covariant return.
    static override create(ident: Identifier): LabelDsymbol {
        return new LabelDsymbol(ident);
    }

    // statement.d:1789 — is this a LabelDsymbol()? (overrides Dsymbol.isLabel)
    override isLabel(): LabelDsymbol | null {
        return this;
    }

    override accept(v: Visitor): void {
        v.visitLabelDsymbol(this);
    }
}

/***********************************************************
 * statement.d:1803 — https://dlang.org/spec/statement.html#asm
 * NOT final in D — InlineAsmStatement / GccAsmStatement extend it.
 *
 * CLASS SHELL ONLY (11 §3.1/§3.2): the asm-statement NODES live in this in-scope file and are
 * carried as ordinary AST nodes, but the `iasm/` module that semantically processes them is
 * EXCLUDED. Nothing here processes an asm block; the excluded dispatch is stubbed in its own file.
 *
 * statement.d:1806-1813 — `static struct BitFields { bool caseSensitive, isVolatile, isInline; }`
 * packed via `mixin(generateBitFields!(BitFields, ubyte))`. `Has_Bitfields` is OFF (_config.md §1),
 * so the mixin resolves to the shift/mask getter-setter form (07 §5/§6); per 11 §3.6 the packed
 * storage may be discarded IF AND ONLY IF nothing reads the backing integer or its sizeof.
 * Full frontend writer inventory (verified by tree-wide grep of 1.43.0-beta1/dmd), all of which go
 * through the generated per-flag setter and none of which touch the backing ubyte:
 *   - parse.d:7189 `as.caseSensitive = !endOfLine;` — IN SCOPE, already ported at parse.ts:6674;
 *   - cparse.d:3583/:3585 (`isVolatile`/`isInline`) — ported at cparse.ts:3784/:3786, plain field writes;
 *   - the C++ header accessors (statement.h).
 * Modelled as three plain boolean fields, the same shape expression.ts uses for its BitFields —
 * which serves the in-scope parse.d writer exactly as the generated setter does.
 */
export class AsmStatement extends Statement {
    tokens: Token | null;           // statement.d:1805 — linked list of tokens for one instruction/pseudo op

    caseSensitive: boolean = false; // for register names, on only when doing MASM style inline asm
    isVolatile: boolean = false;    // ImportC asm "volatile"
    isInline: boolean = false;      // ImportC asm "inline"

    // statement.d:1815 + :1821 — arity-distinct prefixes -> ONE ctor with the trailing STMT
    // defaulted (04 §1 Form A). This is the ctor InlineAsmStatement / GccAsmStatement reach
    // through `super` with their own tag.
    constructor(loc: Loc, tokens: Token | null, stmt: STMT = STMT.Asm) {
        super(loc, stmt);
        this.tokens = tokens;
    }

    // statement.d:1827 — deep node copy (tokens shared — it is the parse-time token list).
    override syntaxCopy(): AsmStatement {
        return new AsmStatement(this.loc, this.tokens);
    }

    override accept(v: Visitor): void {
        v.visitAsmStatement(this);
    }
}

/***********************************************************
 * statement.d:1841 — https://dlang.org/spec/iasm.html
 * Class shell only — see the AsmStatement note above.
 */
export class InlineAsmStatement extends AsmStatement {
    asmcode: unknown = null;        // `void* asmcode` — opaque (02 §10)
    regs: bigint = 0n;              // `ulong regs` — mask of registers modified -> bigint (09 §1)
    asmalign: number = 0;           // `uint asmalign` — alignment of this statement
    refparam: boolean = false;      // true if function parameter is referenced
    naked: boolean = false;         // true if function is to be naked (no prolog/epilog)

    // statement.d:1849-1853 — `version (IN_LLVM)` field. resolved: IN_LLVM -> ON, FE bookkeeping -> KEPT.
    // non-zero if this is a branch, contains the target label
    isBranchToLabel: LabelDsymbol | null = null;

    // statement.d:1855.
    constructor(loc: Loc, tokens: Token | null) {
        super(loc, tokens, STMT.InlineAsm);
    }

    // statement.d:1860 — deep node copy. resolved: version(IN_LLVM) -> ON (_config §1), so the
    // IN_LLVM branch (statement.d:1864-1867, which carries refparam/naked across) is taken and the
    // `else` branch (statement.d:1871) is dead.
    override syntaxCopy(): InlineAsmStatement {
        const a_s = new InlineAsmStatement(this.loc, this.tokens);
        a_s.refparam = this.refparam;
        a_s.naked = this.naked;
        return a_s;
    }

    override accept(v: Visitor): void {
        v.visitInlineAsmStatement(this);
    }
}

/***********************************************************
 * statement.d:1885 — https://gcc.gnu.org/onlinedocs/gcc/Extended-Asm.html
 * Assembler instructions with D expression operands. Class shell only — see AsmStatement above.
 */
export class GccAsmStatement extends AsmStatement {
    stc: STC = STC.none;                     // attributes of the asm {} block (D `STC stc;` -> STC.init)
    insn: Expression | null = null;          // string expression that is the template for assembler code
    args: Expressions | null = null;         // input and output operands of the statement
    outputargs: number = 0;                  // `uint` — of the operands in 'args', the number of output operands
    names: Identifiers | null = null;        // list of symbolic names for the operands
    constraints: Expressions | null = null;  // list of string constants specifying constraints on operands
    clobbers: Expressions | null = null;     // list of string constants specifying clobbers and scratch registers
    labels: Identifiers | null = null;       // list of goto labels
    gotos: GotoStatements | null = null;     // of the goto labels, the equivalent statements they represent

    // statement.d:1897 — `super(loc, tokens, STMT.GccAsm)` IS the whole ctor body; every other
    // field keeps its D `.init` (09 §1.0).
    constructor(loc: Loc, tokens: Token | null) {
        super(loc, tokens, STMT.GccAsm);
    }

    // statement.d:1902 — deep node copy. Faithful to D: only loc+tokens are carried; the operand
    // fields are filled by statementSemantic, not copied here.
    override syntaxCopy(): GccAsmStatement {
        return new GccAsmStatement(this.loc, this.tokens);
    }

    override accept(v: Visitor): void {
        v.visitGccAsmStatement(this);
    }
}

/***********************************************************
 * statement.d:1916 — a complete asm {} block.
 */
export class CompoundAsmStatement extends CompoundStatement {
    stc: STC;                       // postfix attributes like nothrow/pure/@trusted

    // dropped: IN_LLVM codegen field `void* abiret; // llvm::Value*` (statement.d:1920-1923) —
    // pure codegen payload, no codegen in this port (_config.md §2).

    // statement.d:1925.
    constructor(loc: Loc, statements: Statements | null, stc: STC) {
        super(loc, statements, STMT.CompoundAsm);
        this.stc = stc;
    }

    // statement.d:1931 — deep node copy (statements via Statement.arraySyntaxCopy; stc carried).
    override syntaxCopy(): CompoundAsmStatement {
        return new CompoundAsmStatement(this.loc, Statement.arraySyntaxCopy(this.statements), this.stc);
    }

    override accept(v: Visitor): void {
        v.visitCompoundAsmStatement(this);
    }

    // statement.d:1941-1948 — `version (IN_LLVM)` override. resolved: IN_LLVM -> ON, FE-shaping -> KEPT.
    override endsWithAsm(): CompoundAsmStatement | null {
        // yes this is inline asm
        return this;
    }
}

/***********************************************************
 * statement.d:1954 — https://dlang.org/spec/module.html#ImportDeclaration
 */
export class ImportStatement extends Statement {
    imports: Dsymbols | null;       // statement.d:1956 — Array of Import's

    // statement.d:1958.
    constructor(loc: Loc, imports: Dsymbols | null) {
        super(loc, STMT.Import);
        this.imports = imports;
    }

    // statement.d:1964 — deep node copy: clone every Import (a Dsymbol) into a pre-sized array.
    override syntaxCopy(): ImportStatement {
        const m: Dsymbols = new DArray<Dsymbol | null>(this.imports!.length);  // `new Dsymbols(len)` (08 §3)
        for (let i = 0; i < this.imports!.length; i++) {    // foreach (i, s; *imports)
            // The slot is `Dsymbol | null` (08 §3); statement.d:1969 calls through it with no null
            // test, so the `!` sits at exactly the point D would fault.
            m.opIndexAssign(this.imports!.opIndex(i)!.syntaxCopy(null), i);
        }
        return new ImportStatement(this.loc, m);
    }

    override accept(v: Visitor): void {
        v.visitImportStatement(this);
    }
}

// dropped: `mixin template VisitStatement(Result)` (statement.d:1981) and the CTFE-only helper
// `pure string visitStmtCase(string handler)` (statement.d:2041). Both are COMPILE-TIME
// code-generation constructs (07 §5/§6), not runtime declarations: the mixin expands, at each
// `mixin VisitStatement!void visit;` site, into a `final switch (s.stmt)` dispatcher whose arms are
// built by `visitStmtCase` (itself guarded by `if (__ctfe)` and ending in `assert(0)`, so it has no
// runtime existence at all). They produce no AST node and no type-graph symbol, so nothing is
// emitted here; each instantiation site resolves the expansion in its own file — the four D sites
// are blockexit.d:498, statementsem.d:3823, hdrgen.d:971, dinterpret.d:1677 (13 §7.5 governs the
// shape of the emitted dispatch: every arm present, unfilled arms as inline walls).
