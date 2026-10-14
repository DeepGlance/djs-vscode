// Behavioral pins for `walkPostorder` / `walkPostorderStatement` (dmd/visitor/postorder.d).
//
// postorder.d carries ZERO `unittest` blocks, so this suite is the 10-tests-diagnostics.md §1.6b
// artifact: one module-load smoke test plus one pin per risky resolved construct. The constructs
// pinned here, each a judgment the translation had to make:
//   1. the Form-B split of the `walkPostorder` overload pair (04 §1) — both halves work, and the
//      `Expression` half keeps the bare name (the tie-break is recorded in postorder.ts's header);
//   2. the `doCond(a) || doCond(b) || applyTo(e);` short-circuit chain — children before self
//      (postorder), and a stop mid-chain suppresses both the remaining children AND `applyTo`;
//   3. `doCondExpressionSlice` (the Form-B rename of `doCond(Expression[])`, postorder.d:63) over a
//      null container, i.e. `peekSlice(null)`;
//   4. the `lowering`-vs-`visit(cast(BinExp)e)` fork of CatExp/CatAssignExp/EqualExp
//      (postorder.d:109/:121/:133);
//   5. the `StageFlags.apply` re-entrancy guard and its save/restore (postorder.d:178-186);
//   6. the two counted loops with an early `return` — CompoundStatement (postorder.d:244) and
//      TryCatchStatement's catch handlers (postorder.d:325).
//
// The AST is built by hand through real node constructors, as `visitor/index.test.ts` does and for
// the same reason: `Type._init()` currently throws inside mtype.ts, so a parser-driven fixture
// would pin another file's breakage. `IdentifierExp` needs no `Type`, so it serves as the leaf.

import { describe, test, expect } from "vitest";

// Import an SCC member FIRST (01-conventions.md §4.5 — the load-order invariant in index.ts).
import {
    AddExp,
    CatExp,
    CallExp,
    IdentifierExp,
    StructLiteralExp,
    StructLiteralExpStageFlags,
} from "../expression.js";
import type { Expression } from "../expression.js";
import { Catch, CompoundStatement, ExpStatement, TryCatchStatement } from "../statement.js";
import type { Statement } from "../statement.js";
import { Identifier } from "../identifier.js";
import { TOK } from "../tokens.js";
import { ds, dsToJs } from "../../dstring.js";
import { Loc } from "../location.js";
import { Array as DArray } from "../root/array.js";
import type { Catches, Expressions, Statements } from "../arraytypes.js";

import { StoppableVisitor } from "./index.js";
import { walkPostorder, walkPostorderStatement } from "./postorder.js";

/**
 * A recorder for the visitor `walkPostorder` drives. It customizes only the two ROOT slots, which
 * every node forwards to through the parsetime/semantic forwarding chain (13 §4), so the recorded
 * sequence is produced by the traversal under test, not by the test.
 */
class Recorder extends StoppableVisitor {
    seen: string[] = [];
    /** Record this label and then stop the walk (null = never stop). */
    stopAt: string | null = null;

    private record(label: string): void {
        this.seen.push(label);
        if (this.stopAt !== null && label === this.stopAt) this.stop = true;
    }

    override visitExpression(e: Expression): void {
        const ie = e.isIdentifierExp();
        this.record(ie !== null ? `Ident:${dsToJs(ie.ident!.toString())}` : e.constructor.name);
    }

    override visitStatement(s: Statement): void {
        this.record(s.constructor.name);
    }
}

function leaf(name: string): IdentifierExp {
    return new IdentifierExp(Loc.initial, new Identifier(ds(name), TOK.identifier));
}

describe("postorder.d", () => {
    test("module load executes the top level (load-order / cycle regression)", () => {
        expect(typeof walkPostorder).toBe("function");
        expect(typeof walkPostorderStatement).toBe("function");
    });

    test("walkPostorder visits children before the node itself (postorder.d:20/:104)", () => {
        const v = new Recorder();
        const sum = new AddExp(Loc.initial, leaf("a"), leaf("b"));

        expect(walkPostorder(sum, v)).toBe(false);          // `return v.stop` — nothing stopped
        expect(v.seen).toEqual(["Ident:a", "Ident:b", "AddExp"]);
    });

    test("a stop mid-chain suppresses the later children AND applyTo (postorder.d:56/:70)", () => {
        const v = new Recorder();
        v.stopAt = "Ident:a";                               // the FIRST child stops the walk
        const sum = new AddExp(Loc.initial, leaf("a"), leaf("b"));

        expect(walkPostorder(sum, v)).toBe(true);           // `walkPostorder` returns `v.stop`
        expect(v.seen).toEqual(["Ident:a"]);                // no `b`, and no `AddExp`
    });

    test("a null child is skipped, not dereferenced (postorder.d:58 `if (!stop && e)`)", () => {
        const v = new Recorder();
        // CallExp built through the 2-arg ctor: `arguments_` stays null, so `doCondExpressionSlice`
        // iterates `peekSlice(null)` == [] and the walk falls straight through to `applyTo`.
        const call = new CallExp(Loc.initial, leaf("f"));

        expect(walkPostorder(call, v)).toBe(false);
        expect(v.seen).toEqual(["Ident:f", "CallExp"]);
    });

    test("CatExp with no lowering walks e1/e2 via visitBinExp (postorder.d:117)", () => {
        const v = new Recorder();
        const cat = new CatExp(Loc.initial, leaf("x"), leaf("y"));
        expect(cat.lowering).toBe(null);

        expect(walkPostorder(cat, v)).toBe(false);
        expect(v.seen).toEqual(["Ident:x", "Ident:y", "CatExp"]);
    });

    test("CatExp WITH a lowering walks the lowering only (postorder.d:111-114)", () => {
        const v = new Recorder();
        const cat = new CatExp(Loc.initial, leaf("x"), leaf("y"));
        cat.lowering = leaf("lowered");

        expect(walkPostorder(cat, v)).toBe(false);
        // D takes the `doCond(lowering) || applyTo(e)` arm: e1 and e2 are NOT walked.
        expect(v.seen).toEqual(["Ident:lowered", "CatExp"]);
    });

    test("StructLiteralExp: elements walked, stageflags restored, re-entry guarded (postorder.d:178)", () => {
        const v = new Recorder();
        const els: Expressions = new DArray<Expression | null>();
        els.push(leaf("f0"));
        els.push(null);                                     // a null element is skipped
        els.push(leaf("f1"));

        const sle = new StructLiteralExp(Loc.initial, null, els, null);
        sle.stageflags = StructLiteralExpStageFlags.optimize;   // an unrelated bit must survive

        expect(walkPostorder(sle, v)).toBe(false);
        expect(v.seen).toEqual(["Ident:f0", "Ident:f1", "StructLiteralExp"]);
        expect(sle.stageflags).toBe(StructLiteralExpStageFlags.optimize);   // `e.stageflags = old`

        // The guard: a node already being applied is walked no further (postorder.d:180-181).
        v.seen = [];
        sle.stageflags = StructLiteralExpStageFlags.apply;
        expect(walkPostorder(sle, v)).toBe(false);
        expect(v.seen).toEqual([]);
        expect(sle.stageflags).toBe(StructLiteralExpStageFlags.apply);      // early `return`, no restore
    });

    test("a throw inside the walk does not leak the apply bit (11 §2.5 paired state)", () => {
        // The wrapped visitor stands in for another file's deferral: it throws from inside the
        // element walk. D needs no guard (its release is a plain statement); the port's `finally`
        // keeps the set/reset pair intact so a later walk of the same literal is not silently a
        // no-op. This pin therefore encodes the SHAPE choice documented at the site, which §2.5
        // does not enumerate: whoever removes the protection must delete this pin with it, and that
        // is the integrator's ruling to make, not a sweeper's.
        class Thrower extends StoppableVisitor {
            override visitExpression(_e: Expression): void {
                throw new Error("stand-in for a walled callee");
            }
        }
        const els: Expressions = new DArray<Expression | null>();
        els.push(leaf("f0"));
        const sle = new StructLiteralExp(Loc.initial, null, els, null);

        expect(() => walkPostorder(sle, new Thrower())).toThrow("stand-in for a walled callee");
        expect(sle.stageflags).toBe(StructLiteralExpStageFlags.none);

        // Proof the pin is not vacuous: the literal is still walkable afterwards.
        const v = new Recorder();
        expect(walkPostorder(sle, v)).toBe(false);
        expect(v.seen).toEqual(["Ident:f0", "StructLiteralExp"]);
    });

    test("walkPostorderStatement walks a CompoundStatement's statements then itself (postorder.d:27/:244)", () => {
        const v = new Recorder();
        const stmts: Statements = new DArray<Statement | null>();
        stmts.push(new ExpStatement(Loc.initial, leaf("a")));
        stmts.push(new ExpStatement(Loc.initial, null));
        const cs = new CompoundStatement(Loc.initial, stmts);

        expect(walkPostorderStatement(cs, v)).toBe(false);
        // Each ExpStatement reaches `visitStatement` -> applyTo; `s.exp` is NOT walked here (the
        // statement walker has no ExpStatement override — D's postorder.d has none either).
        expect(v.seen).toEqual(["ExpStatement", "ExpStatement", "CompoundStatement"]);
    });

    test("CompoundStatement returns early when a child stops the walk (postorder.d:246-249)", () => {
        const v = new Recorder();
        v.stopAt = "ExpStatement";                          // the first child stops it
        const stmts: Statements = new DArray<Statement | null>();
        stmts.push(new ExpStatement(Loc.initial, leaf("a")));
        stmts.push(new ExpStatement(Loc.initial, leaf("b")));

        expect(walkPostorderStatement(new CompoundStatement(Loc.initial, stmts), v)).toBe(true);
        expect(v.seen).toEqual(["ExpStatement"]);           // no second child, no CompoundStatement
    });

    test("TryCatchStatement walks the body then every catch handler (postorder.d:325)", () => {
        const v = new Recorder();
        const catches: Catches = new DArray<Catch | null>();
        catches.push(new Catch(Loc.initial, null, null, new ExpStatement(Loc.initial, leaf("h0"))));
        catches.push(new Catch(Loc.initial, null, null, new ExpStatement(Loc.initial, leaf("h1"))));
        const tc = new TryCatchStatement(Loc.initial, new ExpStatement(Loc.initial, leaf("t")), catches);

        expect(walkPostorderStatement(tc, v)).toBe(false);
        expect(v.seen).toEqual(["ExpStatement", "ExpStatement", "ExpStatement", "TryCatchStatement"]);
    });
});
