// Ported from dmd/blockexit.d (module dmd.blockexit).
//
// Find out in what ways control flow can exit a statement block.
//
// dropped: `import core.stdc.stdio;` (blockexit.d:14) — its only use is the debug `printf` pair in
// `visitDefaultCase` (blockexit.d:72-73), dropped with that body (see there).
// dropped: `import dmd.arraytypes;` (blockexit.d:16) and `import dmd.declaration;` (blockexit.d:20) —
// this file names no symbol from either, runtime or type (01 §3.1: import only what is used).
// KEPT, in the deferred type-only form (01 §4.2 — every one of these is needed in TYPE positions only):
// `dmd.errorsink` (d:21), `dmd.expression` (d:22), `dmd.func` (d:25), `dmd.identifier` (d:28),
// `dmd.location` (d:29), `dmd.dclass` (d:19), `dmd.statement` (d:31, the ~35 node classes are named in
// parameter positions only) → `import type`. A type-only import is a KEPT edge in the deferred form, not
// a dropped one. KEPT as value imports: `dmd.astenums` (d:17), `dmd.canthrow` (d:18), `dmd.globals`
// (d:26), `dmd.id` (d:27), `dmd.mtype` (d:30, `Type.terror`), `dmd.tokens` (d:32).
//
// OPEN ESCALATION — 04 §6 re-homing anti-pattern, INHERITED, not settled by this file. `toBool`
// (blockexit.d:23) and `toBasetype` (blockexit.d:24) are FREE functions in D, reached here through two
// selective imports, with the receiver as an explicit `_this` first parameter: expressionsem.d:499
// `Optional!bool toBool(Expression _this)`, typesem.d:1140 `Type toBasetype(Type _this)`. Neither name
// exists as a member of the D class (`grep toBool dmd/expression.d` and `grep toBasetype dmd/mtype.d`
// are both empty). The guide-conforming port is therefore `toBool(a.e1)` / `toBasetype(exp.type)`,
// imported from expressionsem.ts / typesem.ts (04 §6 "canonical rule", 01 Rule 1.1). Those free
// functions DO NOT EXIST in this tree: expression.ts:392 and mtype.ts:1795 re-homed both as METHODS on
// Expression/Type — the exact move 04 §6 calls an ABSOLUTE anti-pattern and 11 §1 makes a STOP trigger.
// The call sites below use the only form that resolves here; expressionsem.ts / mtype.ts are not this
// file's to change. Escalated to the integrator — do not read the method form as ratified.
// Beyond the spelling, the DISPATCH SHAPE also diverges: D's `toBool` is a non-virtual
// `switch (_this.op)` whose `default: return typeof(return)();` yields an EMPTY optional for any
// unlisted op (expressionsem.d:526-561); the TS method reaches whichever subclass override exists.
//
// walls — deferred callees this file reaches. Each is a loud throw in ITS file (11 §2.5: the wall lives
// at the deferred site), so there is no silent divergence, but these D paths are NOT executable yet:
//   `toBool` on IntegerExp/StringExp/ArrayLiteralExp (expression.ts) → the `assert(0)` recognition at
//   blockexit.d:95 and the literal-condition folds at d:205/224/264;
//   `Statement.hasCode` (d:139) and `Statement.comeFrom` (d:151) → `visitCompound` past the trivial case;
//   `FuncDeclaration.setThrow` (d:483, d:528).

import { STC, STMT, FileType } from "./astenums.js";
import { canThrow } from "./canthrow.js";
import { global } from "./globals.js";
import { Id } from "./id.js";
import { Type } from "./mtype.js";
import { EXP } from "./tokens.js";
// reconciled to faithful surface (W2); sweeps at this file's retranslation:
// DMD 2.113 moved `toBool` from expression.d into expressionsem.d:499 as a UFCS free function.
import { toBool } from "./expressionsem.js";
import { assert, assertUnreachable, SwitchError } from "../assert.js";
import { ds } from "../dstring.js";
import type { ErrorSink } from "./errorsink.js";
import type { Expression } from "./expression.js";
import type { FuncDeclaration } from "./func.js";
import type { Identifier } from "./identifier.js";
import type { ClassDeclaration } from "./dclass.js";
import type { Loc } from "./location.js";
import { toBasetype } from "./typesem.js";
import type {
    Statement,
    ErrorStatement,
    ExpStatement,
    DtorExpStatement,
    MixinStatement,
    CompoundStatement,
    UnrolledLoopStatement,
    ScopeStatement,
    WhileStatement,
    DoStatement,
    ForStatement,
    ForeachStatement,
    ForeachRangeStatement,
    IfStatement,
    ConditionalStatement,
    PragmaStatement,
    StaticAssertStatement,
    SwitchStatement,
    CaseStatement,
    DefaultStatement,
    GotoDefaultStatement,
    GotoCaseStatement,
    SwitchErrorStatement,
    ReturnStatement,
    BreakStatement,
    ContinueStatement,
    SynchronizedStatement,
    WithStatement,
    TryCatchStatement,
    TryFinallyStatement,
    ScopeGuardStatement,
    ThrowStatement,
    GotoStatement,
    LabelStatement,
    CompoundAsmStatement,
    ImportStatement,
} from "./statement.js";

/**
 * BE stands for BlockExit.
 *
 * It indicates if a statement does transfer control to another block.
 * A block is a sequence of statements enclosed in { }
 *
 * dmd/blockexit.d:40 — `enum BE : int`. A 32-bit-based enum → TS `enum` (02 §4.2); the members keep
 * D's trailing-underscore keyword escapes verbatim (01 §2.1).
 */
export enum BE {
    none = 0,
    fallthru = 1,
    throw_ = 2,
    return_ = 4,
    goto_ = 8,
    halt = 0x10,
    break_ = 0x20,
    continue_ = 0x40,
    errthrow = 0x80,
    any = fallthru | throw_ | return_ | goto_ | halt,
}

/*********************************************
 * Determine mask of ways that a statement can exit.
 *
 * Only valid after semantic analysis.
 * Params:
 *   s = statement to check for block exit status
 *   func = function that statement s is in
 *   eSink = generate an error if it throws
 * Returns:
 *   BE.xxxx
 *
 * dmd/blockexit.d:66. `s` is nullable (the `if (!s)` guard at blockexit.d:496 is the boundary check;
 * every arm below may hand a null sub-statement straight back in). The nested `visitXxx` arms are
 * inner arrows sharing the closure-captured `result` (04 §5), exactly as in D.
 */
export function blockExit(s: Statement | null, func: FuncDeclaration | null, eSink: ErrorSink | null): number {
    let result: number = BE.none;

    // blockexit.d:70 — the mixin's fall-back arm for every STMT with no `visitXxx` here.
    // dropped: `printf("Statement::blockExit(%p)\n", s); printf("%s\n", s.toChars());`
    // (blockexit.d:72-73) — a debug trace preceding the load-bearing `assert(0)`; same disposition as
    // `Dsymbol.syntaxCopy` (dsymbol.d:853 → dsymbol.ts). D's `assert(0)` carries NO message, so this is
    // a bare `assertUnreachable()` per the guide's decisive row (10 §2.2: `assert(0);` →
    // `assertUnreachable();`, a message only for `assert(0, "...")`); the dropped printf's text is not
    // reconstructed into one — that would synthesize diagnostic bytes dmd never produces.
    const visitDefaultCase = (_s: Statement): void => {
        assertUnreachable(); // blockexit.d:74 — assert(0)
    };

    // blockexit.d:77
    const visitError = (_s: ErrorStatement): void => {
        result = BE.none;
    };

    // blockexit.d:82
    const visitExp = (s: ExpStatement): void => {
        result = BE.fallthru;
        if (s.exp === null)
            return;

        if (s.exp.op === EXP.halt) {
            result = BE.halt;
            return;
        }
        const a = s.exp.isAssertExp(); // blockexit.d:93 — decl-in-condition hoisted (06 §2.6)
        if (a !== null) {
            if (toBool(a.e1!).hasValue(false)) { // if it's an assert(0)
                result = BE.halt;
                return;
            }
        }
        if (s.exp.type !== null && toBasetype(s.exp.type).isTypeNoreturn() !== null)
            result = BE.halt;
        result |= canThrow(s.exp, func, eSink);
    };

    // blockexit.d:106
    const visitDtorExp = (s: DtorExpStatement): void => {
        visitExp(s);
    };

    // blockexit.d:111
    const visitMixin = (_s: MixinStatement): void => {
        assert(global.errors !== 0);
        result = BE.fallthru;
    };

    // blockexit.d:117
    const visitCompound = (cs: CompoundStatement): void => {
        //printf("CompoundStatement.blockExit(%p) %d result = x%X\n", cs, cs.statements.length, result);
        result = BE.fallthru;
        let slast: Statement | null = null;
        // A `Statements` slot is genuinely nullable in D — blockexit.d:124 exists precisely to skip the
        // null ones, and statement.ts:115 documents the same invariant ("null entries stay null"). The
        // alias carries it (`Statements = Array<Statement | null>`, 08 §3), so this is the ordinary
        // explicit slot-null test of 06 §2.7 — never a bare `if (!s)`.
        for (const s of cs.statements!) {
            if (s === null)
                continue;

            //printf("result = x%x\n", result);
            //printf("s: %s\n", s.toChars());
            if ((result & BE.fallthru) !== 0 && slast !== null) {
                slast = slast.last();
                if (slast !== null && (slast.isCaseStatement() !== null || slast.isDefaultStatement() !== null)
                    && (s.isCaseStatement() !== null || s.isDefaultStatement() !== null)) {
                    // Allow if last case/default was empty
                    const sc = slast.isCaseStatement();
                    const sd = slast.isDefaultStatement();
                    const sl = (sc !== null ? sc.statement : (sd !== null ? sd.statement : null));

                    if (sl !== null && (!sl.hasCode() || sl.isErrorStatement() !== null)) {
                        // blockexit.d:140-141 — deliberately empty: an empty previous case/default is
                        // legal fallthrough, so no diagnostic.
                    } else if (func!.getModule()!.filetype !== FileType.c) {
                        const gototype = s.isCaseStatement() !== null ? ds("case") : ds("default");
                        // https://issues.dlang.org/show_bug.cgi?id=22999
                        global.errorSink!.error(s.loc, ds("switch case fallthrough - use 'goto %s;' if intended"),
                            gototype);
                    }
                }
            }

            if ((result & BE.fallthru) !== 0 || s.comeFrom()) {
                result &= ~BE.fallthru;
                result |= blockExit(s, func, eSink);
            }
            slast = s;
        }
    };

    // blockexit.d:160
    const visitUnrolledLoop = (uls: UnrolledLoopStatement): void => {
        result = BE.fallthru;
        // Element widened to D's nullable slot type, as in `visitCompound` above (blockexit.d:164).
        for (const sSlot of uls.statements!) {
            const s: Statement | null = sSlot;
            if (s === null)
                continue;
            const r = blockExit(s, func, eSink);
            result |= r & ~(BE.break_ | BE.continue_ | BE.fallthru);
            if ((r & (BE.fallthru | BE.continue_ | BE.break_)) === 0)
                result &= ~BE.fallthru;
        }
    };

    // blockexit.d:174
    const visitScope = (s: ScopeStatement): void => {
        //printf("ScopeStatement::blockExit(%p)\n", s.statement);
        result = blockExit(s.statement, func, eSink);
    };

    // blockexit.d:180
    const visitWhile = (_s: WhileStatement): void => {
        assert(global.errors !== 0);
        result = BE.fallthru;
    };

    // blockexit.d:186
    const visitDo = (s: DoStatement): void => {
        if (s._body !== null) {
            result = blockExit(s._body, func, eSink);
            if (result === BE.break_) {
                result = BE.fallthru;
                return;
            }
            if ((result & BE.continue_) !== 0)
                result |= BE.fallthru;
        } else
            result = BE.fallthru;
        if ((result & BE.fallthru) !== 0) {
            result |= canThrow(s.condition!, func, eSink);

            if ((result & BE.break_) === 0 && toBool(s.condition!).hasValue(true))
                result &= ~BE.fallthru;
        }
        result &= ~(BE.break_ | BE.continue_);
    };

    // blockexit.d:211
    const visitFor = (s: ForStatement): void => {
        result = BE.fallthru;
        if (s._init !== null) {
            result = blockExit(s._init, func, eSink);
            if ((result & BE.fallthru) === 0)
                return;
        }
        if (s.condition !== null) {
            result |= canThrow(s.condition, func, eSink);

            const opt = toBool(s.condition); // copy elided: fresh rvalue, read-only (03 §9)
            if (opt.hasValue(true))
                result &= ~BE.fallthru;
            else if (opt.hasValue(false))
                return;
        } else
            result &= ~BE.fallthru; // the body must do the exiting
        if (s._body !== null) {
            const r = blockExit(s._body, func, eSink);
            if ((r & (BE.break_ | BE.goto_)) !== 0)
                result |= BE.fallthru;
            result |= r & ~(BE.fallthru | BE.break_ | BE.continue_);
        }
        if (s.increment !== null)
            result |= canThrow(s.increment, func, eSink);
    };

    // blockexit.d:243
    const visitForeach = (s: ForeachStatement): void => {
        result = BE.fallthru;
        result |= canThrow(s.aggr!, func, eSink);

        if (s._body !== null)
            result |= blockExit(s._body, func, eSink) & ~(BE.break_ | BE.continue_);
    };

    // blockexit.d:252
    const visitForeachRange = (_s: ForeachRangeStatement): void => {
        assert(global.errors !== 0);
        result = BE.fallthru;
    };

    // blockexit.d:258
    const visitIf = (s: IfStatement): void => {
        //printf("IfStatement::blockExit(%p)\n", s);
        result = BE.none;
        result |= canThrow(s.condition!, func, eSink);

        const opt = toBool(s.condition!); // copy elided: fresh rvalue, read-only (03 §9)
        if (opt.hasValue(true)) {
            result |= blockExit(s.ifbody, func, eSink);
        } else if (opt.hasValue(false)) {
            result |= blockExit(s.elsebody, func, eSink);
        } else {
            result |= blockExit(s.ifbody, func, eSink);
            result |= blockExit(s.elsebody, func, eSink);
        }
        //printf("IfStatement::blockExit(%p) = x%x\n", s, result);
    };

    // blockexit.d:281
    const visitConditional = (s: ConditionalStatement): void => {
        result = blockExit(s.ifbody, func, eSink);
        if (s.elsebody !== null)
            result |= blockExit(s.elsebody, func, eSink);
    };

    // blockexit.d:288
    const visitPragma = (_s: PragmaStatement): void => {
        result = BE.fallthru;
    };

    // blockexit.d:293
    const visitStaticAssert = (_s: StaticAssertStatement): void => {
        result = BE.fallthru;
    };

    // blockexit.d:298
    const visitSwitch = (s: SwitchStatement): void => {
        result = BE.none;
        result |= canThrow(s.condition!, func, eSink);

        if (s._body !== null) {
            result |= blockExit(s._body, func, eSink);
            if ((result & BE.break_) !== 0) {
                result |= BE.fallthru;
                result &= ~BE.break_;
            }
        } else
            result |= BE.fallthru;
    };

    // blockexit.d:316
    const visitCase = (s: CaseStatement): void => {
        result = blockExit(s.statement, func, eSink);
    };

    // blockexit.d:321
    const visitDefault = (s: DefaultStatement): void => {
        result = blockExit(s.statement, func, eSink);
    };

    // blockexit.d:326
    const visitGotoDefault = (_s: GotoDefaultStatement): void => {
        result = BE.goto_;
    };

    // blockexit.d:331
    const visitGotoCase = (_s: GotoCaseStatement): void => {
        result = BE.goto_;
    };

    // blockexit.d:336
    const visitSwitchError = (_s: SwitchErrorStatement): void => {
        // Switch errors are non-recoverable
        result = BE.halt;
    };

    // blockexit.d:342
    const visitReturn = (s: ReturnStatement): void => {
        result = BE.return_;
        if (s.exp !== null)
            result |= canThrow(s.exp, func, eSink);
    };

    // blockexit.d:349
    const visitBreak = (s: BreakStatement): void => {
        //printf("BreakStatement::blockExit(%p) = x%x\n", s, s.ident ? BE.goto_ : BE.break_);
        result = s.ident !== null ? BE.goto_ : BE.break_;
    };

    // blockexit.d:355
    const visitContinue = (s: ContinueStatement): void => {
        result = s.ident !== null ? BE.continue_ | BE.goto_ : BE.continue_;
    };

    // blockexit.d:360
    const visitSynchronized = (s: SynchronizedStatement): void => {
        result = blockExit(s._body, func, eSink);
    };

    // blockexit.d:365
    const visitWith = (s: WithStatement): void => {
        result = BE.none;
        result |= canThrow(s.exp!, func, eSink);
        result |= blockExit(s._body, func, eSink);
    };

    // blockexit.d:372
    const visitTryCatch = (s: TryCatchStatement): void => {
        assert(s._body !== null);
        result = blockExit(s._body, func, null);

        let catchresult = 0;
        // `Catches` slots are `Catch | null` (08 §3); blockexit.d:378 dereferences `c` with no null
        // test, so each read is `c!` — the `!` marks the exact point D would fault.
        for (const c of s.catches!) {
            if (c!.type === Type.terror)
                continue;

            let cresult = blockExit(c!.handler, func, eSink);

            /* If we're catching Object, then there is no throwing
             */
            const id: Identifier | null = toBasetype(c!.type!).isClassHandle()!.ident;
            if (c!.internalCatch && (cresult & BE.fallthru) !== 0) {
                // https://issues.dlang.org/show_bug.cgi?id=11542
                // leave blockExit flags of the body
                cresult &= ~BE.fallthru;
            } else if (id === Id.Object || id === Id.Throwable) {
                result &= ~(BE.throw_ | BE.errthrow);
            } else if (id === Id.Exception) {
                result &= ~BE.throw_;
            }
            catchresult |= cresult;
        }
        if (eSink !== null && (result & BE.throw_) !== 0) {
            // now explain why this is nothrow
            blockExit(s._body, func, eSink);
        }
        result |= catchresult;
    };

    // blockexit.d:412
    const visitTryFinally = (s: TryFinallyStatement): void => {
        result = BE.fallthru;
        if (s._body !== null)
            result = blockExit(s._body, func, null);

        // check finally body as well, it may throw (bug #4082)
        let finalresult: number = BE.fallthru;
        if (s.finalbody !== null)
            finalresult = blockExit(s.finalbody, func, null);

        // If either body or finalbody halts
        if (result === BE.halt)
            finalresult = BE.none;
        if (finalresult === BE.halt)
            result = BE.none;

        if (eSink !== null) {
            // now explain why this is nothrow
            if (s._body !== null && (result & BE.throw_) !== 0)
                blockExit(s._body, func, eSink);
            if (s.finalbody !== null && (finalresult & BE.throw_) !== 0)
                blockExit(s.finalbody, func, eSink);
        }

        if ((finalresult & BE.fallthru) === 0)
            result &= ~BE.fallthru;
        result |= finalresult & ~BE.fallthru;
    };

    // blockexit.d:443
    const visitScopeGuard = (_s: ScopeGuardStatement): void => {
        // At this point, this statement is just an empty placeholder
        result = BE.fallthru;
    };

    // blockexit.d:449
    const visitThrow = (s: ThrowStatement): void => {
        if (s.internalThrow) {
            // https://issues.dlang.org/show_bug.cgi?id=8675
            // Allow throwing 'Throwable' object even if eSink.
            result = BE.fallthru;
            return;
        }

        result = checkThrow(s.loc, s.exp!, func, eSink);
    };

    // blockexit.d:462
    const visitGoto = (_s: GotoStatement): void => {
        //printf("GotoStatement::blockExit(%p)\n", s);
        result = BE.goto_;
    };

    // blockexit.d:468
    const visitLabel = (s: LabelStatement): void => {
        //printf("LabelStatement::blockExit(%p)\n", s);
        result = blockExit(s.statement, func, eSink);
        if (s.breaks)
            result |= BE.fallthru;
    };

    // blockexit.d:476
    const visitCompoundAsm = (s: CompoundAsmStatement): void => {
        // Assume the worst
        result = BE.fallthru | BE.return_ | BE.goto_ | BE.halt;
        if ((s.stc & STC.nothrow_) === 0n) {
            if (func !== null)
                func.setThrow(s.loc, ds("executing an `asm` statement without a `nothrow` annotation"));
            if (eSink !== null)
                eSink.error(s.loc,
                    ds("`asm` statement is assumed to throw - mark it with `nothrow` if it does not")); // TODO
            else
                result |= BE.throw_;
        }
    };

    // blockexit.d:491
    const visitImport = (_s: ImportStatement): void => {
        result = BE.fallthru;
    };

    if (s === null)
        return BE.fallthru;
    // resolved: `mixin VisitStatement!void visit; visit.VisitStatement(s);` (blockexit.d:498-499) ->
    // the `final switch (s.stmt)` the mixin template expands to (statement.d:1981-2033), one arm per
    // STMT via the `visitStmtCase` CTFE string mixin (statement.d:2041-2081). Each arm's expansion is
    // `auto sx = s.isXxxStatement(); static if (__traits(compiles, visitXxx(sx))) visitXxx(sx);
    // else visitDefaultCase(sx);` — so a STMT with no `visitXxx` above routes to `visitDefaultCase`
    // (which is `assert(0)`), NEVER to a related arm. Emitted IN FULL, arm order and all, per
    // 13-visitor.md §5/§7.5 — a dropped arm would silently collapse that node kind onto another.
    // `visitDefaultCase(s)` is `visitDefaultCase(sx)` in D: `sx` is the same object, downcast.
    switch (s.stmt) {
        case STMT.Error:         visitError(s.isErrorStatement()!); break;
        case STMT.Scope:         visitScope(s.isScopeStatement()!); break;
        case STMT.Exp:           visitExp(s.isExpStatement()!); break;
        case STMT.Compound:      visitCompound(s.isCompoundStatement()!); break;
        case STMT.Return:        visitReturn(s.isReturnStatement()!); break;
        case STMT.If:            visitIf(s.isIfStatement()!); break;
        case STMT.Conditional:   visitConditional(s.isConditionalStatement()!); break;
        case STMT.StaticForeach: visitDefaultCase(s); break;
        case STMT.Case:          visitCase(s.isCaseStatement()!); break;
        case STMT.Default:       visitDefault(s.isDefaultStatement()!); break;
        case STMT.Label:         visitLabel(s.isLabelStatement()!); break;
        case STMT.Goto:          visitGoto(s.isGotoStatement()!); break;
        case STMT.GotoDefault:   visitGotoDefault(s.isGotoDefaultStatement()!); break;
        case STMT.GotoCase:      visitGotoCase(s.isGotoCaseStatement()!); break;
        case STMT.Break:         visitBreak(s.isBreakStatement()!); break;
        case STMT.DtorExp:       visitDtorExp(s.isDtorExpStatement()!); break;
        case STMT.Mixin:         visitMixin(s.isMixinStatement()!); break;
        case STMT.Forwarding:    visitDefaultCase(s); break;
        case STMT.Do:            visitDo(s.isDoStatement()!); break;
        case STMT.While:         visitWhile(s.isWhileStatement()!); break;
        case STMT.For:           visitFor(s.isForStatement()!); break;
        case STMT.Foreach:       visitForeach(s.isForeachStatement()!); break;
        case STMT.Switch:        visitSwitch(s.isSwitchStatement()!); break;
        case STMT.Continue:      visitContinue(s.isContinueStatement()!); break;
        case STMT.With:          visitWith(s.isWithStatement()!); break;
        case STMT.TryCatch:      visitTryCatch(s.isTryCatchStatement()!); break;
        case STMT.Throw:         visitThrow(s.isThrowStatement()!); break;
        case STMT.Debug:         visitDefaultCase(s); break;
        case STMT.TryFinally:    visitTryFinally(s.isTryFinallyStatement()!); break;
        case STMT.ScopeGuard:    visitScopeGuard(s.isScopeGuardStatement()!); break;
        case STMT.SwitchError:   visitSwitchError(s.isSwitchErrorStatement()!); break;
        case STMT.UnrolledLoop:  visitUnrolledLoop(s.isUnrolledLoopStatement()!); break;
        case STMT.ForeachRange:  visitForeachRange(s.isForeachRangeStatement()!); break;
        case STMT.CompoundDeclaration: visitDefaultCase(s); break;
        case STMT.Peel:          visitDefaultCase(s); break;
        case STMT.CompoundAsm:   visitCompoundAsm(s.isCompoundAsmStatement()!); break;
        case STMT.Pragma:        visitPragma(s.isPragmaStatement()!); break;
        case STMT.StaticAssert:  visitStaticAssert(s.isStaticAssertStatement()!); break;
        case STMT.CaseRange:     visitDefaultCase(s); break;
        case STMT.Synchronized:  visitSynchronized(s.isSynchronizedStatement()!); break;
        case STMT.Asm:           visitDefaultCase(s); break;
        case STMT.InlineAsm:     visitDefaultCase(s); break;
        case STMT.GccAsm:        visitDefaultCase(s); break;
        case STMT.Import:        visitImport(s.isImportStatement()!); break;
        default: {
            // final switch: D throws SwitchError on an unhandled value (06 §3.2).
            const _exhaustive: never = s.stmt;
            throw new SwitchError(_exhaustive);
        }
    }
    return result;
}

/**
 * Checks whether `throw <exp>` throws an `Exception` or an `Error`
 * and raises an error if this violates `nothrow`.
 *
 * Params:
 *   loc          = location of the `throw`
 *   exp          = expression yielding the throwable
 *   eSink        = if !null then inside of a `nothrow` scope
 *   func         = function containing the `throw`
 *
 * Returns: `BE.[err]throw` depending on the type of `exp`
 *
 * dmd/blockexit.d:515. Precondition (D `assert(cd)`): `exp.type` resolves to a class handle.
 */
export function checkThrow(loc: Loc, exp: Expression, func: FuncDeclaration | null, eSink: ErrorSink | null): BE {
    const t: Type = toBasetype(exp.type!);
    const cd: ClassDeclaration | null = t.isClassHandle();
    assert(cd !== null); // blockexit.d:519 `assert(cd)` — nullable ref, explicit form (06 §2.7)

    if (cd.isErrorException()) {
        return BE.errthrow;
    }
    if (eSink !== null)
        eSink.error(loc, ds("`%s` is thrown but not caught"), exp.type!.toChars());
    else if (func !== null)
        func.setThrow(loc, ds("`%s` being thrown but not caught"), exp.type!);

    return BE.throw_;
}
