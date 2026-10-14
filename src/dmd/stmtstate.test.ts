// Co-located tests for src/dmd/stmtstate.ts.
//
// dmd/stmtstate.d carries no in-source `unittest{}` block. The template is exercised end to end by
// ob.test.ts (its one instantiation, `StmtState!ObNode`); this file pins the lookup contract of each
// getter directly, with plain objects as the flow-graph blocks: the chain walk returns the innermost
// non-null block, the constructor inherits `tryBlock` only, and the labelled `break`/`continue`
// lookups stop at the state whose `prev` carries the label.

import "./parse.js"; // module-graph ROOT for a core-SCC test file (10 §1.5)

import { describe, expect, test } from "vitest";

import { StmtState } from "./stmtstate.js";
import { ExpStatement } from "./statement.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { ds } from "../dstring.js";

interface Block { name: string; }

const blk = (name: string): Block => ({ name });

describe("stmtstate.d:25 — StmtState(block)", () => {
    test("the default-initialized state has no targets", () => {
        const s = new StmtState<Block>(null, null);
        expect(s.getBreakBlock(null)).toBeNull();
        expect(s.getContBlock(null)).toBeNull();
        expect(s.getSwitchBlock()).toBeNull();
        expect(s.getDefaultBlock()).toBeNull();
        expect(s.getFinallyBlock()).toBeNull();
        expect(s.tryBlock).toBeNull();
    });

    test("stmtstate.d:38 — the constructor copies prev.tryBlock and nothing else", () => {
        const outer = new StmtState<Block>(null, null);
        outer.tryBlock = blk("try");
        outer.breakBlock = blk("brk");
        const inner = new StmtState<Block>(outer, null);
        expect(inner.tryBlock).toBe(outer.tryBlock);
        expect(inner.breakBlock).toBeNull();
        expect(inner.prev).toBe(outer);
    });

    test("unlabelled lookups return the innermost non-null block along the chain", () => {
        const outer = new StmtState<Block>(null, null);
        outer.breakBlock = blk("outerBreak");
        outer.contBlock = blk("outerCont");
        outer.switchBlock = blk("sw");
        outer.defaultBlock = blk("dflt");
        outer.finallyBlock = blk("fin");
        const mid = new StmtState<Block>(outer, null);
        mid.breakBlock = blk("midBreak");
        const inner = new StmtState<Block>(mid, null);
        expect(inner.getBreakBlock(null)!.name).toBe("midBreak");
        expect(inner.getContBlock(null)!.name).toBe("outerCont");
        expect(inner.getSwitchBlock()!.name).toBe("sw");
        expect(inner.getDefaultBlock()!.name).toBe("dflt");
        expect(inner.getFinallyBlock()!.name).toBe("fin");
    });

    test("stmtstate.d:46 — a labelled break returns the block of the statement right under the label", () => {
        // `L: loop { inner { break L; } }` as toObNodes builds it: the label's state carries the ident,
        // the loop's state (prev = label state) carries the break block.
        const L = Identifier.idPool(ds("L"));
        const loop = new ExpStatement(Loc.initial, null);
        const labelState = new StmtState<Block>(null, null);
        labelState.ident = L;
        const loopState = new StmtState<Block>(labelState, loop);
        loopState.breakBlock = blk("loopBreak");
        const innerLoop = new ExpStatement(Loc.initial, null);
        const innerState = new StmtState<Block>(loopState, innerLoop);
        innerState.breakBlock = blk("innerBreak");
        expect(innerState.getBreakBlock(L)!.name).toBe("loopBreak");
        expect(innerState.getBreakBlock(null)!.name).toBe("innerBreak");
    });

    test("stmtstate.d:79 — a labelled continue returns the last continue block seen below the label", () => {
        const L = Identifier.idPool(ds("L"));
        const labelState = new StmtState<Block>(null, null);
        labelState.ident = L;
        const loopState = new StmtState<Block>(labelState, null);
        loopState.contBlock = blk("loopCont");
        const innerState = new StmtState<Block>(loopState, null);
        innerState.contBlock = blk("innerCont");
        expect(innerState.getContBlock(L)!.name).toBe("loopCont");
        expect(innerState.getContBlock(null)!.name).toBe("innerCont");
    });
});
