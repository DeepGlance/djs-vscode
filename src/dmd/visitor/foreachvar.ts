// Ported from dmd/visitor/foreachvar.d (module dmd.visitor.foreachvar).
//
// "Utility to visit every variable in an expression."
//
// Two top-level D declarations, in source order, both translated whole — no wall, no escalation:
//   - `foreachVar`       (foreachvar.d:48)  — with its nested `VarWalker` visitor class (:53).
//   - `foreachExpAndVar` (foreachvar.d:112) — a nested-function statement walker.
// No `version`/`debug`/`static if` sites, no unittest blocks (verified: `grep -c unittest
// foreachvar.d` -> 0).
//
// VISITOR CENSUS (13-visitor.md §0(a), code-free header line): one `extern (C++) final class`
// extending `StoppableVisitor`, nested INSIDE `foreachVar` (:53), as in sideeffect.ts. It is a real
// class, so 13 §1's named-method rename applies (`visit(DeclarationExp)` -> `visitDeclarationExp`)
// and `alias visit = typeof(super).visit;` (:55) is dropped. Staying nested keeps `extends
// StoppableVisitor` a CALL-time read, so this module opens no class-extends-value edge (01 §4.1).
// `foreachExpAndVar` is 13 §7.5's nested-function idiom: plain closures dispatched on `s.stmt`.
//
// RESOLVED CONSTRUCTS:
//   - `td.foreachVar((s) { dgVar(s.isVarDeclaration()); })` (:77): D hands the possibly-null
//     `isVarDeclaration()` straight to `dgVar`, whose every consumer dereferences it; the port
//     keeps the unconditional dereference as `!` (02 §10.1).
//   - `s == v` (:79) compares class references without `opEquals` override: `===`.
//   - `final switch (s.stmt)` (:254) with `assert(0)` on the lowered kinds (:291-304) is a TS switch whose
//     rewritten-away arms call `assertUnreachable()`, closed by the throwing `SwitchError` default (06 §3.2).
//
// ERASED: `extern (C++) final`, `extern (D)`, `scope` (delegate storage class and the `scope`
// constructor attribute), `@safe`.
// dropped: `import dmd.printast;` (visitor/foreachvar.d:34) — no printast symbol is referenced here.
// dropped: the imports of `core.stdc.*`, `dmd.attrib`, `dmd.dclass`, `dmd.dstruct`, `dmd.dtemplate`,
// `dmd.func`, `dmd.id`, `dmd.identifier`, `dmd.initsem`, `dmd.mtype`, `dmd.root.array`, `dmd.rootobject`
// and `dmd.arraytypes` (visitor/foreachvar.d:14-37) — no symbol of theirs is referenced (01 §3.7).

import type { VarDeclaration } from "../declaration.js";
import type { Expression, DeclarationExp, IndexExp, SliceExp, ErrorExp } from "../expression.js";
import type {
    Statement, ExpStatement, DtorExpStatement, IfStatement, DoStatement, ForStatement, SwitchStatement,
    CaseStatement, ReturnStatement, CompoundStatement, CompoundDeclarationStatement, UnrolledLoopStatement,
    ScopeStatement, DefaultStatement, WithStatement, TryCatchStatement, TryFinallyStatement, ThrowStatement,
    LabelStatement,
} from "../statement.js";
import type { Dsymbol } from "../dsymbol.js";
import { STMT } from "../astenums.js";
import { EXP } from "../tokens.js";
import { assertUnreachable, SwitchError } from "../../assert.js";
import { StoppableVisitor } from "./index.js";
import { walkPostorder } from "./postorder.js";
// last: dsymbolsem is a core-SCC semantic module; entering the SCC here would make this walker its entry (01 §4.8)
import { toAlias } from "../dsymbolsem.js";

/*********************************************
 * dmd/visitor/foreachvar.d:48 — `void foreachVar(Expression e, scope void delegate(VarDeclaration) dgVar)`.
 * Visit each Expression in e, and call dgVar() on each variable declared in it.
 * Params:
 *      e = expression tree to visit
 *      dgVar = call when a variable is declared
 *
 * Walks `e` in postorder; `dgVar` sees every variable a `DeclarationExp` declares (each member of
 * a tuple declaration, and recursively those declared in a non-static variable's initializer) and
 * the `lengthVar` (`$`) of every `IndexExp`/`SliceExp`. A null `e` is a no-op.
 */
export function foreachVar(e: Expression | null, dgVar: (v: VarDeclaration) => void): void {
    if (e === null)
        return;

    // foreachvar.d:53 — `extern (C++) final class VarWalker : StoppableVisitor`, nested as in D.
    class VarWalker extends StoppableVisitor {
        dgVar: (v: VarDeclaration) => void;

        // foreachvar.d:58
        constructor(dgVar: (v: VarDeclaration) => void) {
            super();
            this.dgVar = dgVar;
        }

        // foreachvar.d:63
        override visitExpression(_e: Expression): void {
        }

        // foreachvar.d:67
        override visitErrorExp(_e: ErrorExp): void {
        }

        // foreachvar.d:71
        override visitDeclarationExp(e: DeclarationExp): void {
            const v = e.declaration!.isVarDeclaration();
            if (v === null)
                return;
            const td = toAlias(v).isTupleDeclaration();
            if (td !== null)
                td.foreachVar((s: Dsymbol) => { this.dgVar(s.isVarDeclaration()!); });
            else
                this.dgVar(v);
            const s = toAlias(v);
            if (s === v && !v.isStatic() && v._init !== null) {
                const ie = v._init.isExpInitializer();
                if (ie !== null)
                    foreachVar(ie.exp, this.dgVar);
            }
        }

        // foreachvar.d:89
        override visitIndexExp(e: IndexExp): void {
            if (e.lengthVar !== null)
                this.dgVar(e.lengthVar);
        }

        // foreachvar.d:95
        override visitSliceExp(e: SliceExp): void {
            if (e.lengthVar !== null)
                this.dgVar(e.lengthVar);
        }
    }

    const v = new VarWalker(dgVar);
    walkPostorder(e, v);
}

/***************
 * dmd/visitor/foreachvar.d:112 — `void foreachExpAndVar(Statement s,`.
 * Transitively walk Statement s, pass Expressions to dgExp(), VarDeclarations to dgVar().
 * Params:
 *      s = Statement to traverse
 *      dgExp = delegate to pass found Expressions to
 *      dgVar = delegate to pass found VarDeclarations to
 *
 * Precondition: `s` is a lowered (post-semantic3) body: `while`, `foreach`, `scope(...)`,
 * `synchronized` and the other rewritten kinds must not occur (asserted). `dgExp` may receive a
 * null expression where D passes an unchecked one (an `if`/`do`/`switch` condition, a `case`
 * expression, a `throw` operand); in a lowered body those are never null.
 */
export function foreachExpAndVar(s: Statement | null, dgExp: (e: Expression) => void,
                                 dgVar: (v: VarDeclaration) => void): void {
    function visit(s: Statement | null): void {
        function visitExp(s: ExpStatement): void {
            if (s.exp !== null)
                dgExp(s.exp);
        }

        function visitDtorExp(s: DtorExpStatement): void {
            if (s.exp !== null)
                dgExp(s.exp);
        }

        function visitIf(s: IfStatement): void {
            dgExp(s.condition!);
            visit(s.ifbody);
            visit(s.elsebody);
        }

        function visitDo(s: DoStatement): void {
            dgExp(s.condition!);
            visit(s._body);
        }

        function visitFor(s: ForStatement): void {
            visit(s._init);
            if (s.condition !== null)
                dgExp(s.condition);
            if (s.increment !== null)
                dgExp(s.increment);
            visit(s._body);
        }

        function visitSwitch(s: SwitchStatement): void {
            dgExp(s.condition!);
            // Note that the body contains the Case and Default
            // statements, so we only need to compile the expressions
            for (const cs of s.cases!.opSlice()) {
                dgExp(cs!.exp!);
            }
            visit(s._body);
        }

        function visitCase(s: CaseStatement): void {
            visit(s.statement);
        }

        function visitReturn(s: ReturnStatement): void {
            if (s.exp !== null)
                dgExp(s.exp);
        }

        function visitCompound(s: CompoundStatement): void {
            if (s.statements !== null) {
                for (const s2 of s.statements.opSlice()) {
                    visit(s2);
                }
            }
        }

        function visitCompoundDeclaration(s: CompoundDeclarationStatement): void {
            visitCompound(s);
        }

        function visitUnrolledLoop(s: UnrolledLoopStatement): void {
            for (const s2 of s.statements!.opSlice()) {
                visit(s2);
            }
        }

        function visitScope(s: ScopeStatement): void {
            visit(s.statement);
        }

        function visitDefault(s: DefaultStatement): void {
            visit(s.statement);
        }

        function visitWith(s: WithStatement): void {
            // If it is with(Enum) {...}, just execute the body.
            if (s.exp!.op === EXP.scope_ || s.exp!.op === EXP.type) {
            } else {
                dgVar(s.wthis!);
                dgExp(s.exp!);
            }
            visit(s._body);
        }

        function visitTryCatch(s: TryCatchStatement): void {
            visit(s._body);
            for (const ca of s.catches!.opSlice()) {
                if (ca!.var_ !== null)
                    dgVar(ca!.var_);
                visit(ca!.handler);
            }
        }

        function visitTryFinally(s: TryFinallyStatement): void {
            visit(s._body);
            visit(s.finalbody);
        }

        function visitThrow(s: ThrowStatement): void {
            dgExp(s.exp!);
        }

        function visitLabel(s: LabelStatement): void {
            visit(s.statement);
        }

        if (s === null)
            return;

        switch (s.stmt) {
            case STMT.Exp:                 visitExp(s.isExpStatement()!); break;
            case STMT.DtorExp:             visitDtorExp(s.isDtorExpStatement()!); break;
            case STMT.Compound:            visitCompound(s.isCompoundStatement()!); break;
            case STMT.CompoundDeclaration: visitCompoundDeclaration(s.isCompoundDeclarationStatement()!); break;
            case STMT.UnrolledLoop:        visitUnrolledLoop(s.isUnrolledLoopStatement()!); break;
            case STMT.Scope:               visitScope(s.isScopeStatement()!); break;
            case STMT.Do:                  visitDo(s.isDoStatement()!); break;
            case STMT.For:                 visitFor(s.isForStatement()!); break;
            case STMT.If:                  visitIf(s.isIfStatement()!); break;
            case STMT.Switch:              visitSwitch(s.isSwitchStatement()!); break;
            case STMT.Case:                visitCase(s.isCaseStatement()!); break;
            case STMT.Default:             visitDefault(s.isDefaultStatement()!); break;
            case STMT.Return:              visitReturn(s.isReturnStatement()!); break;
            case STMT.With:                visitWith(s.isWithStatement()!); break;
            case STMT.TryCatch:            visitTryCatch(s.isTryCatchStatement()!); break;
            case STMT.TryFinally:          visitTryFinally(s.isTryFinallyStatement()!); break;
            case STMT.Throw:               visitThrow(s.isThrowStatement()!); break;
            case STMT.Label:               visitLabel(s.isLabelStatement()!); break;

            case STMT.CompoundAsm:
            case STMT.Asm:
            case STMT.InlineAsm:
            case STMT.GccAsm:

            case STMT.Break:
            case STMT.Continue:
            case STMT.GotoDefault:
            case STMT.GotoCase:
            case STMT.SwitchError:
            case STMT.Goto:
            case STMT.Pragma:
            case STMT.Import:
            case STMT.Error:
                break;          // ignore these

            case STMT.ScopeGuard:
            case STMT.Foreach:
            case STMT.ForeachRange:
            case STMT.Debug:
            case STMT.CaseRange:
            case STMT.StaticForeach:
            case STMT.StaticAssert:
            case STMT.Conditional:
            case STMT.While:
            case STMT.Forwarding:
            case STMT.Mixin:
            case STMT.Peel:
            case STMT.Synchronized:
                assertUnreachable();    // should have been rewritten

            default: {
                // final switch: D throws SwitchError on an unhandled value
                const _exhaustive: never = s.stmt; void _exhaustive;
                throw new SwitchError();
            }
        }
    }

    visit(s);
}
