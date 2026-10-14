/**
 * Provides a visitor for statements that allows rewriting the currently visited node.
 *
 * Ported 1:1 from dmd/visitor/statement_rewrite_walker.d (module dmd.visitor.statement_rewrite_walker),
 * ldc 1.43.0.
 *
 * The D class keeps `Statement* ps`, a pointer to the SLOT that holds the statement being visited (a
 * field of the parent node, or an element of its `Statements` array), so `replaceCurrent` can write a
 * new statement into that slot. A slot inside another object cannot be aliased by a `Ref` box, so the
 * pointer is an accessor pair (03 §7.3): `ps.get()` reads `*ps`, `ps.set(v)` writes `*ps = v`. The
 * `ref Statement s` parameter of `visitStmt` is the same accessor pair, built by the caller over the
 * slot it passes.
 *
 * dropped: `import core.stdc.stdio;` (statement_rewrite_walker.d:14) — nothing in the module uses it.
 */

import { SemanticTimePermissiveVisitor } from "./index.js";
import type {
    Statement, PeelStatement, CompoundStatement, CompoundDeclarationStatement, UnrolledLoopStatement,
    ScopeStatement, WhileStatement, DoStatement, ForStatement, ForeachStatement, ForeachRangeStatement,
    IfStatement, SwitchStatement, CaseStatement, CaseRangeStatement, DefaultStatement, SynchronizedStatement,
    WithStatement, TryCatchStatement, TryFinallyStatement, DebugStatement, LabelStatement, Catch,
} from "../statement.js";
import type { Statements } from "../arraytypes.js";

/**
 * The accessor pair for a D `Statement*` / `ref Statement` bound to a slot (03 §7.3): `get` reads the
 * slot, `set` writes it. The slots the walker visits are nullable fields and `Statements` elements,
 * hence `Statement | null` on both sides; `visitStmt` is only ever handed a slot whose current
 * content is non-null (every D call site tests it first).
 */
export interface StatementSlot {
    get(): Statement | null;
    set(v: Statement | null): void;
}

/**
 * dmd/visitor/statement_rewrite_walker.d:22 — `extern (C++) class StatementRewriteWalker : SemanticTimePermissive`…
 *
 * A visitor to walk entire statements and provides ability to replace any sub-statements.
 * Entry point: `visitStmt(slot)`. During the walk, a subclass override calls `replaceCurrent(s)` to
 * write `s` into the slot of the statement being visited; the walk does not descend into the
 * replacement. Only the statement kinds with an override below are descended into; every other node
 * reaches the empty root `visitStatement` of the permissive base.
 *
 * dropped: alias visit = SemanticTimePermissiveVisitor.visit (statement_rewrite_walker.d:24) — no
 * overload hiding in TS (13 §1).
 */
export class StatementRewriteWalker extends SemanticTimePermissiveVisitor {
    /* Point the currently visited statement.
     * By using replaceCurrent() method, you can replace AST during walking.
     */
    // D declares the field without an initializer, so it is `null` until the first `visitStmt`.
    ps: StatementSlot | null = null;

    // statement_rewrite_walker.d:32 — `final void visitStmt(ref Statement s)`: records the slot, then
    // dispatches on the statement it holds (D dereferences it unconditionally).
    visitStmt(s: StatementSlot): void {
        this.ps = s;
        s.get()!.accept(this);
    }

    // statement_rewrite_walker.d:38 — `final void replaceCurrent(Statement s)`: `*ps = s`.
    replaceCurrent(s: Statement | null): void {
        this.ps!.set(s);
    }

    // statement_rewrite_walker.d:43
    override visitPeelStatement(s: PeelStatement): void {
        if (s.s)
            this.visitStmt({ get: () => s.s, set: (v) => { s.s = v!; } }); // `PeelStatement.s` is non-null
    }

    // statement_rewrite_walker.d:49
    override visitCompoundStatement(s: CompoundStatement): void {
        if (s.statements && s.statements.length) {
            const statements = s.statements;
            for (let i = 0; i < statements.length; i++) {
                if (statements.opIndex(i))
                    this.visitStmt(elementSlot(statements, i));
            }
        }
    }

    // statement_rewrite_walker.d:61
    override visitCompoundDeclarationStatement(s: CompoundDeclarationStatement): void {
        this.visitCompoundStatement(s);
    }

    // statement_rewrite_walker.d:66
    override visitUnrolledLoopStatement(s: UnrolledLoopStatement): void {
        if (s.statements && s.statements.length) {
            const statements = s.statements;
            for (let i = 0; i < statements.length; i++) {
                if (statements.opIndex(i))
                    this.visitStmt(elementSlot(statements, i));
            }
        }
    }

    // statement_rewrite_walker.d:78
    override visitScopeStatement(s: ScopeStatement): void {
        if (s.statement)
            this.visitStmt({ get: () => s.statement, set: (v) => { s.statement = v; } });
    }

    // statement_rewrite_walker.d:84
    override visitWhileStatement(s: WhileStatement): void {
        if (s._body)
            this.visitStmt({ get: () => s._body, set: (v) => { s._body = v; } });
    }

    // statement_rewrite_walker.d:90
    override visitDoStatement(s: DoStatement): void {
        if (s._body)
            this.visitStmt({ get: () => s._body, set: (v) => { s._body = v; } });
    }

    // statement_rewrite_walker.d:96
    override visitForStatement(s: ForStatement): void {
        if (s._init)
            this.visitStmt({ get: () => s._init, set: (v) => { s._init = v; } });
        if (s._body)
            this.visitStmt({ get: () => s._body, set: (v) => { s._body = v; } });
    }

    // statement_rewrite_walker.d:104
    override visitForeachStatement(s: ForeachStatement): void {
        if (s._body)
            this.visitStmt({ get: () => s._body, set: (v) => { s._body = v; } });
    }

    // statement_rewrite_walker.d:110
    override visitForeachRangeStatement(s: ForeachRangeStatement): void {
        if (s._body)
            this.visitStmt({ get: () => s._body, set: (v) => { s._body = v; } });
    }

    // statement_rewrite_walker.d:116
    override visitIfStatement(s: IfStatement): void {
        if (s.ifbody)
            this.visitStmt({ get: () => s.ifbody, set: (v) => { s.ifbody = v; } });
        if (s.elsebody)
            this.visitStmt({ get: () => s.elsebody, set: (v) => { s.elsebody = v; } });
    }

    // statement_rewrite_walker.d:124
    override visitSwitchStatement(s: SwitchStatement): void {
        if (s._body)
            this.visitStmt({ get: () => s._body, set: (v) => { s._body = v; } });
    }

    // statement_rewrite_walker.d:130
    override visitCaseStatement(s: CaseStatement): void {
        if (s.statement)
            this.visitStmt({ get: () => s.statement, set: (v) => { s.statement = v; } });
    }

    // statement_rewrite_walker.d:136
    override visitCaseRangeStatement(s: CaseRangeStatement): void {
        if (s.statement)
            this.visitStmt({ get: () => s.statement, set: (v) => { s.statement = v; } });
    }

    // statement_rewrite_walker.d:142
    override visitDefaultStatement(s: DefaultStatement): void {
        if (s.statement)
            this.visitStmt({ get: () => s.statement, set: (v) => { s.statement = v; } });
    }

    // statement_rewrite_walker.d:148
    override visitSynchronizedStatement(s: SynchronizedStatement): void {
        if (s._body)
            this.visitStmt({ get: () => s._body, set: (v) => { s._body = v; } });
    }

    // statement_rewrite_walker.d:154
    override visitWithStatement(s: WithStatement): void {
        if (s._body)
            this.visitStmt({ get: () => s._body, set: (v) => { s._body = v; } });
    }

    // statement_rewrite_walker.d:160
    override visitTryCatchStatement(s: TryCatchStatement): void {
        if (s._body)
            this.visitStmt({ get: () => s._body, set: (v) => { s._body = v; } });
        if (s.catches && s.catches.length) {
            const catches = s.catches;
            for (let i = 0; i < catches.length; i++) {
                const c: Catch | null = catches.opIndex(i);
                if (c && c.handler)
                    this.visitStmt({ get: () => c.handler, set: (v) => { c.handler = v; } });
            }
        }
    }

    // statement_rewrite_walker.d:175
    override visitTryFinallyStatement(s: TryFinallyStatement): void {
        if (s._body)
            this.visitStmt({ get: () => s._body, set: (v) => { s._body = v; } });
        if (s.finalbody)
            this.visitStmt({ get: () => s.finalbody, set: (v) => { s.finalbody = v; } });
    }

    // statement_rewrite_walker.d:183
    override visitDebugStatement(s: DebugStatement): void {
        if (s.statement)
            this.visitStmt({ get: () => s.statement, set: (v) => { s.statement = v; } });
    }

    // statement_rewrite_walker.d:189
    override visitLabelStatement(s: LabelStatement): void {
        if (s.statement)
            this.visitStmt({ get: () => s.statement, set: (v) => { s.statement = v; } });
    }
}

/// The slot `(*statements)[i]` (the `ref` element D passes to `visitStmt` at :56 and :73): reads go
/// through `opIndex`, writes through `opIndexAssign` (08 §2.0c).
function elementSlot(statements: Statements, i: number): StatementSlot {
    return { get: () => statements.opIndex(i), set: (v) => { statements.opIndexAssign(v, i); } };
}
