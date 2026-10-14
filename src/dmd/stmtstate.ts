// Ported from dmd/stmtstate.d (module dmd.stmtstate).
//
// "Used to help transform statement AST into flow graph."
//
// One top-level D declaration, translated whole: the struct template `StmtState(block)`
// (stmtstate.d:25). Its one in-scope instantiation is `StmtState!ObNode` (ob.d:85); the port keeps the
// template as a TS generic class over the flow-graph node type (02 §2, 07 §3.5: the type parameter is
// only ever used as `block*`, a reference to a node, so no per-instantiation dispatch exists). No
// `version`/`debug`/`static if` sites, no unittest blocks (verified: `grep -c unittest stmtstate.d`
// -> 0).
//
// RESOLVED CONSTRUCTS:
//   - `StmtState* prev` / `block* xxxBlock`: D pointers to a struct and to a node, both reached only by
//     reference (`&mystate`, `new ObNode`), so the port holds the TS object reference (02 §10). A null
//     pointer is `null`.
//   - `for (bc = &this; bc; bc = bc.prev)`: `&this` is the object itself; `bc` is a nullable reference
//     tested with `!== null` (06 §2.7).
//   - The D default-initialized `StmtState stmtstate;` (ob.d:864) is `new StmtState<T>(null, null)`:
//     every field is null, exactly D's `.init` (the constructor copies `tryBlock` only from a non-null
//     `prev`).
//   - `bc.statement == related` compares class references (`==` on classes without `opEquals` is
//     identity in the frontend: `Statement` does not override `opEquals`), so `===`.

import type { Identifier } from "./identifier.js";
import type { Statement } from "./statement.js";

/************************************************
 * dmd/stmtstate.d:25 — `struct StmtState(block)`.
 * Used to traverse the statement AST to transform it into
 * a flow graph.
 * Keeps track of things like "where does the `break` go".
 * Params:
 *      block = type of the flow graph node
 *
 * Instances are chained through `prev`, innermost first; every lookup walks the chain outward and
 * returns the first non-null block, so a nested statement inherits the targets of its enclosers.
 * ob.d uses the struct only through its address (`&mystate`), so no D copy point reaches `copy()`;
 * the struct is copyable (no `@disable this(this)`), so it carries `copy()` by the 03 §2 contract.
 */
export class StmtState<block> {
    prev: StmtState<block> | null;
    statement: Statement | null;

    ident: Identifier | null = null;
    breakBlock: block | null = null;
    contBlock: block | null = null;
    switchBlock: block | null = null;
    defaultBlock: block | null = null;
    finallyBlock: block | null = null;
    tryBlock: block | null = null;

    /// stmtstate.d:38 — `this(StmtState* prev, Statement statement)`. The default-initialized D form
    /// (`StmtState s;`) is `new StmtState(null, null)`.
    constructor(prev: StmtState<block> | null, statement: Statement | null) {
        this.prev = prev;
        this.statement = statement;
        if (prev !== null)
            this.tryBlock = prev.tryBlock;
    }

    /// 03 §2 — field-wise copy: every field is a class/node reference, so each is shared.
    copy(): StmtState<block> {
        const c = new StmtState<block>(this.prev, this.statement);
        c.ident = this.ident;
        c.breakBlock = this.breakBlock;
        c.contBlock = this.contBlock;
        c.switchBlock = this.switchBlock;
        c.defaultBlock = this.defaultBlock;
        c.finallyBlock = this.finallyBlock;
        c.tryBlock = this.tryBlock;
        return c;
    }

    /// stmtstate.d:46 — `block* getBreakBlock(Identifier ident)`. The target of a `break`, labelled or
    /// not; null when no enclosing state has one.
    getBreakBlock(ident: Identifier | null): block | null {
        let bc: StmtState<block> | null;
        if (ident !== null) {
            let related: Statement | null = null;
            let ret: block | null = null;
            for (bc = this; bc !== null; bc = bc.prev) {
                // The label for a breakBlock may actually be some levels up (e.g.
                // on a try/finally wrapping a loop). We'll see if this breakBlock
                // is the one to return once we reach that outer statement (which
                // in many cases will be this same statement).
                if (bc.breakBlock !== null) {
                    // `bc.statement!`: a state carrying a breakBlock was built with a statement
                    // (stmtstate.d:38); D dereferences it unconditionally (02 §10.1).
                    related = bc.statement!.getRelatedLabeled();
                    ret = bc.breakBlock;
                }
                // `bc.prev!`: D dereferences `bc.prev` unconditionally once `bc.statement == related`.
                if (bc.statement === related && bc.prev!.ident === ident)
                    return ret;
            }
        } else {
            for (bc = this; bc !== null; bc = bc.prev) {
                if (bc.breakBlock !== null)
                    return bc.breakBlock;
            }
        }
        return null;
    }

    /// stmtstate.d:79 — `block* getContBlock(Identifier ident)`. The target of a `continue`, labelled
    /// or not; null when no enclosing state has one.
    getContBlock(ident: Identifier | null): block | null {
        let bc: StmtState<block> | null;
        if (ident !== null) {
            let ret: block | null = null;
            for (bc = this; bc !== null; bc = bc.prev) {
                // The label for a contBlock may actually be some levels up (e.g.
                // on a try/finally wrapping a loop). We'll see if this contBlock
                // is the one to return once we reach that outer statement (which
                // in many cases will be this same statement).
                if (bc.contBlock !== null) {
                    ret = bc.contBlock;
                }
                if (bc.prev !== null && bc.prev.ident === ident)
                    return ret;
            }
        } else {
            for (bc = this; bc !== null; bc = bc.prev) {
                if (bc.contBlock !== null)
                    return bc.contBlock;
            }
        }
        return null;
    }

    /// stmtstate.d:110 — `block* getSwitchBlock()`.
    getSwitchBlock(): block | null {
        let bc: StmtState<block> | null;
        for (bc = this; bc !== null; bc = bc.prev) {
            if (bc.switchBlock !== null)
                return bc.switchBlock;
        }
        return null;
    }

    /// stmtstate.d:121 — `block* getDefaultBlock()`.
    getDefaultBlock(): block | null {
        let bc: StmtState<block> | null;
        for (bc = this; bc !== null; bc = bc.prev) {
            if (bc.defaultBlock !== null)
                return bc.defaultBlock;
        }
        return null;
    }

    /// stmtstate.d:132 — `block* getFinallyBlock()`.
    getFinallyBlock(): block | null {
        let bc: StmtState<block> | null;
        for (bc = this; bc !== null; bc = bc.prev) {
            if (bc.finallyBlock !== null)
                return bc.finallyBlock;
        }
        return null;
    }
}
