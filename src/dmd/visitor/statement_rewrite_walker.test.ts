// Goal tests for src/dmd/visitor/statement_rewrite_walker.ts.
//
// dmd/visitor/statement_rewrite_walker.d has ZERO in-source `unittest{}` blocks, so this file takes the
// 10 §1.6b shape: one module-load smoke test plus behaviour pins, each exercising the slot semantics
// the two consumers (funcsem.d:301 NrvoWalker, funcsem.d:3176 RetWalker) rely on:
//   1. `replaceCurrent` writes into the slot the visited statement came from — a `Statements` element,
//      a nullable field (`ifbody`/`elsebody`), a `Catch.handler`, a `PeelStatement.s`;
//   2. the walk does not descend into a replacement, and only the overridden statement kinds are
//      entered (a `ConditionalStatement` body is left alone: the permissive root is a no-op);
//   3. `CompoundDeclarationStatement` walks as a `CompoundStatement` (statement_rewrite_walker.d:61).

import { beforeEach, describe, expect, test } from "vitest";
import { StatementRewriteWalker } from "./statement_rewrite_walker.js";
import {
    Catch, CompoundDeclarationStatement, CompoundStatement, ConditionalStatement, ExpStatement, IfStatement,
    PeelStatement, ReturnStatement, Statement, TryCatchStatement,
} from "../statement.js";
import { Loc } from "../location.js";
import { initTokens } from "../tokens.js";
import { Array as DArray } from "../root/array.js";
import type { Catches, Statements } from "../arraytypes.js";
import { SemanticTimePermissiveVisitor } from "./index.js";

beforeEach(() => {
    Loc._init();
    initTokens();
});

/// Replaces every visited `ReturnStatement` by a fresh `ExpStatement` (whose body is a `ReturnStatement`
/// wrapped in a compound, to prove the walk does not descend into replacements) and counts visits.
class ReturnRewriter extends StatementRewriteWalker {
    visited = 0;
    replacements: Statement[] = [];

    override visitReturnStatement(_s: ReturnStatement): void {
        this.visited++;
        const inner: Statements = new DArray<Statement | null>();
        inner.push(new ReturnStatement(Loc.initial, null));
        const r = new CompoundStatement(Loc.initial, inner);
        this.replacements.push(r);
        this.replaceCurrent(r);
    }
}

function stmts(...xs: (Statement | null)[]): Statements {
    const a: Statements = new DArray<Statement | null>();
    for (const x of xs)
        a.push(x);
    return a;
}

describe("statement_rewrite_walker.ts", () => {
    test("SMOKE: the module loads and the walker is a SemanticTimePermissiveVisitor", () => {
        const w = new ReturnRewriter();
        expect(w instanceof SemanticTimePermissiveVisitor).toBe(true);
        expect(w.ps).toBe(null); // D field without initializer: null until the first visitStmt
    });

    test("PIN 1: replaceCurrent writes into array elements, if/else bodies, catch handlers, peel", () => {
        const handlerRet = new ReturnStatement(Loc.initial, null);
        const catches: Catches = new DArray<Catch | null>();
        catches.push(null); // a null element is skipped (statement_rewrite_walker.d:168)
        const c = new Catch(Loc.initial, null, null, handlerRet);
        catches.push(c);
        const tc = new TryCatchStatement(Loc.initial, new ExpStatement(Loc.initial, null), catches);
        const ifs = new IfStatement(Loc.initial, null, null, new ReturnStatement(Loc.initial, null),
                                    new ReturnStatement(Loc.initial, null), Loc.initial);
        const peel = new PeelStatement(new ReturnStatement(Loc.initial, null));
        const body = stmts(new ReturnStatement(Loc.initial, null), null, ifs, tc, peel);
        const root = new CompoundStatement(Loc.initial, body);

        let rootSlot: Statement | null = root;
        const w = new ReturnRewriter();
        w.visitStmt({ get: () => rootSlot, set: (v) => { rootSlot = v; } });

        expect(rootSlot).toBe(root); // the root itself is not a ReturnStatement
        expect(w.visited).toBe(5);
        expect(body.opIndex(0)).toBe(w.replacements[0]);
        expect(body.opIndex(1)).toBe(null);
        expect(ifs.ifbody).toBe(w.replacements[1]);
        expect(ifs.elsebody).toBe(w.replacements[2]);
        expect(c.handler).toBe(w.replacements[3]);
        expect(peel.s).toBe(w.replacements[4]);
    });

    test("PIN 2: the root slot itself is rewritten; replacements and unwalked kinds are not entered", () => {
        let slot: Statement | null = new ReturnStatement(Loc.initial, null);
        const w = new ReturnRewriter();
        w.visitStmt({ get: () => slot, set: (v) => { slot = v; } });
        expect(w.visited).toBe(1); // the ReturnStatement inside the replacement was not visited
        expect(slot).toBe(w.replacements[0]);

        // ConditionalStatement has no override (statement_rewrite_walker.d has none): the permissive
        // root `visitStatement` is empty, so its body is never reached.
        const condRet = new ReturnStatement(Loc.initial, null);
        const cond = new ConditionalStatement(Loc.initial, null, condRet, null);
        let slot2: Statement | null = cond;
        const w2 = new ReturnRewriter();
        w2.visitStmt({ get: () => slot2, set: (v) => { slot2 = v; } });
        expect(w2.visited).toBe(0);
        expect(cond.ifbody).toBe(condRet);
    });

    test("PIN 3: CompoundDeclarationStatement walks its elements like CompoundStatement (:61)", () => {
        const body = stmts(new ReturnStatement(Loc.initial, null));
        const cds = new CompoundDeclarationStatement(Loc.initial, body);
        let slot: Statement | null = cds;
        const w = new ReturnRewriter();
        w.visitStmt({ get: () => slot, set: (v) => { slot = v; } });
        expect(w.visited).toBe(1);
        expect(body.opIndex(0)).toBe(w.replacements[0]);
    });
});
