/**
 * Lazily evaluate static conditions for `static if`, `static assert` and template constraints.
 *
 * Ported 1:1 from dmd/staticcond.d (module dmd.staticcond), ldc 1.43.0.
 *
 * In this DMD version the module holds only the visualizer of a failed constraint: the evaluator
 * `evalStaticCondition` lives in dmd/expressionsem.d:18439 (ported in expressionsem.ts), which fills
 * the `negatives` list this module reads.
 *
 * Load order (01 §4.5/§4.8): every value import below is a leaf or runtime module (tokens, the
 * OutBuffer, the root Array, assert); the expression classes are type-only, so this module adds no
 * value edge into the core SCC.
 */

import { assert } from "../assert.js";
import { cstr, ds } from "../dstring.js";
import type { DString } from "../dstring.js";
import { EXP } from "./tokens.js";
import { OutBuffer } from "./common/outbuffer.js";
import { Array as DArray } from "./root/array.js";
import type { Expression } from "./expression.js";

/// The canonical box for a D `ref`/`out` scalar (03 §3.3 / §7.2).
interface Ref<T> {
    value: T;
}

/********************************************
 * dmd/staticcond.d:35 — `const(char)* visualizeStaticCondition(Expression original, Expression instantiated,`
 * `const Expression[] negatives, bool full, ref uint itemCount)`.
 *
 * Format a static condition as a tree-like structure, marking failed and
 * bypassed expressions.
 * Params:
 *      original = original expression
 *      instantiated = instantiated expression
 *      negatives = array with negative clauses from `instantiated` expression
 *      full = controls whether it shows the full output or only failed parts
 *      itemCount = returns the number of written clauses (a `ref uint`: the box is written only
 *                  when a text is produced; on the `null` return it is left untouched, as in D)
 * Returns:
 *      formatted string or `null` if the expressions were `null`, or if the
 *      instantiated expression is not based on the original one
 *
 * `negatives` is the D slice `td.lastConstraintNegs[]` of the caller (templatesem.d:3621): pass
 * `Expressions.opSlice()`. Its elements are compared by identity only.
 */
export function visualizeStaticCondition(original: Expression | null, instantiated: Expression | null,
                                         negatives: readonly (Expression | null)[], full: boolean,
                                         itemCount: Ref<number>): DString | null {
    // D `original.loc !is instantiated.loc`: `is` on the `Loc` struct compares its one field
    // bitwise, which is `Loc.opEquals` (location.ts, index compare).
    if (!original || !instantiated || !original.loc.opEquals(instantiated.loc))
        return null;

    const buf = new OutBuffer();

    if (full)
        itemCount.value = visualizeFull(original, instantiated, negatives, buf);
    else
        itemCount.value = visualizeShort(original, instantiated, negatives, buf);

    return buf.extractChars();
}

// dmd/staticcond.d:51 — `private uint visualizeFull(Expression original, Expression instantiated,`
function visualizeFull(original: Expression, instantiated: Expression, negatives: readonly (Expression | null)[],
                       buf: OutBuffer): number {
    // tree-like structure; traverse and format simultaneously
    let count = 0;
    let indent = 0;

    // staticcond.d:58 — `static void printOr(uint indent, ref OutBuffer buf)` (no captures).
    const printOr = (indent: number, buf: OutBuffer): void => {
        buf.reserve(indent * 4 + 8);
        for (let i = 0; i < indent; i++)
            buf.writestring(ds("    "));
        buf.writestring(ds("    or:\n"));
    };

    // returns true if satisfied
    // staticcond.d:67 — `bool impl(Expression orig, Expression e, bool inverted, bool orOperand, bool unreached)`
    // (nested; captures `count`, `indent`, `buf`, `negatives`).
    // `orig` is dereferenced unconditionally (`orig.op`), so its operand arguments carry `!` where D
    // would fault on null; `e` is only down-cast and asserted (D `cast(X)null` is null, then the assert
    // fires) or compared by identity, so it is nullable (02 §10.1).
    const impl = (orig: Expression, e: Expression | null, inverted: boolean, orOperand: boolean,
                  unreached: boolean): boolean => {
        let op: EXP = orig.op;

        // lower all 'not' to the bottom
        // !(A && B) -> !A || !B
        // !(A || B) -> !A && !B
        if (inverted) {
            if (op === EXP.andAnd)
                op = EXP.orOr;
            else if (op === EXP.orOr)
                op = EXP.andAnd;
        }

        if (op === EXP.not) {
            // D `cast(NotExp)orig`, dereferenced unchecked: the tag test above proves it; `!` marks D's
            // crash point.
            const no = orig.isNotExp()!;
            const ne = e !== null ? e.isNotExp() : null;
            assert(ne !== null);
            return impl(no.e1!, ne!.e1, !inverted, orOperand, unreached);
        }
        else if (op === EXP.andAnd) {
            const bo = orig.isBinExp()!;
            const be = e !== null ? e.isBinExp() : null;
            assert(be !== null);
            const r1 = impl(bo.e1!, be!.e1, inverted, false, unreached);
            const r2 = impl(bo.e2!, be!.e2, inverted, false, unreached || !r1);
            return r1 && r2;
        }
        else if (op === EXP.orOr) {
            if (!orOperand) // do not indent A || B || C twice
                indent++;
            const bo = orig.isBinExp()!;
            const be = e !== null ? e.isBinExp() : null;
            assert(be !== null);
            const r1 = impl(bo.e1!, be!.e1, inverted, true, unreached);
            printOr(indent, buf);
            const r2 = impl(bo.e2!, be!.e2, inverted, true, unreached);
            if (!orOperand)
                indent--;
            return r1 || r2;
        }
        else if (op === EXP.question) {
            const co = orig.isCondExp()!;
            const ce = e !== null ? e.isCondExp() : null;
            assert(ce !== null);
            if (!inverted) {
                // rewrite (A ? B : C) as (A && B || !A && C)
                if (!orOperand)
                    indent++;
                const r1 = impl(co.econd!, ce!.econd, inverted, false, unreached);
                const r2 = impl(co.e1!, ce!.e1, inverted, false, unreached || !r1);
                printOr(indent, buf);
                const r3 = impl(co.econd!, ce!.econd, !inverted, false, unreached);
                const r4 = impl(co.e2!, ce!.e2, inverted, false, unreached || !r3);
                if (!orOperand)
                    indent--;
                return r1 && r2 || r3 && r4;
            }
            else {
                // rewrite !(A ? B : C) as (!A || !B) && (A || !C)
                if (!orOperand)
                    indent++;
                const r1 = impl(co.econd!, ce!.econd, inverted, false, unreached);
                printOr(indent, buf);
                const r2 = impl(co.e1!, ce!.e1, inverted, false, unreached);
                const r12 = r1 || r2;
                const r3 = impl(co.econd!, ce!.econd, !inverted, false, unreached || !r12);
                printOr(indent, buf);
                const r4 = impl(co.e2!, ce!.e2, inverted, false, unreached || !r12);
                if (!orOperand)
                    indent--;
                return (r1 || r2) && (r3 || r4);
            }
        }
        else { // 'primitive' expression
            buf.reserve(indent * 4 + 4);
            for (let i = 0; i < indent; i++)
                buf.writestring(ds("    "));

            // find its value; it may be not computed, if there was a short circuit,
            // but we handle this case with `unreached` flag
            let value = true;
            if (!unreached) {
                for (const fe of negatives) {
                    if (fe === e) {
                        value = false;
                        break;
                    }
                }
            }
            // write the marks first
            const satisfied = inverted ? !value : value;
            if (!satisfied && !unreached)
                buf.writestring(ds("  > "));
            else if (unreached)
                buf.writestring(ds("  - "));
            else
                buf.writestring(ds("    "));
            // then the expression itself
            if (inverted)
                buf.writeByte(0x21); // '!'
            buf.writestring(cstr(orig.toChars())); // D `writestring(const(char)*)` stops at the NUL
            buf.writenl();
            count++;
            return satisfied;
        }
    };

    impl(original, instantiated, false, true, false);
    return count;
}

// dmd/staticcond.d:196 — `static struct Item` local to `visualizeShort`, hoisted to module scope
// (a TS class cannot be declared inside the function that pushes it without re-creating it per call;
// it captures nothing). Value struct: `copy()` per 03 §2.
class Item {
    orig: Expression;
    inverted: boolean;

    constructor(orig: Expression, inverted: boolean) {
        this.orig = orig;
        this.inverted = inverted;
    }

    copy(): Item {
        return new Item(this.orig, this.inverted);
    }
}

// dmd/staticcond.d:190 — `private uint visualizeShort(Expression original, Expression instantiated,`
function visualizeShort(original: Expression, instantiated: Expression, negatives: readonly (Expression | null)[],
                        buf: OutBuffer): number {
    // simple list; somewhat similar to long version, so no comments
    // one difference is that it needs to hold items to display in a stack

    const stack = new DArray<Item>();

    // staticcond.d:204 — `bool impl(Expression orig, Expression e, bool inverted)` (nested; captures `stack`,
    // `negatives`).
    const impl = (orig: Expression, e: Expression | null, inverted: boolean): boolean => {
        let op: EXP = orig.op;

        if (inverted) {
            if (op === EXP.andAnd)
                op = EXP.orOr;
            else if (op === EXP.orOr)
                op = EXP.andAnd;
        }

        if (op === EXP.not) {
            const no = orig.isNotExp()!;
            const ne = e !== null ? e.isNotExp() : null;
            assert(ne !== null);
            return impl(no.e1!, ne!.e1, !inverted);
        }
        else if (op === EXP.andAnd) {
            const bo = orig.isBinExp()!;
            const be = e !== null ? e.isBinExp() : null;
            assert(be !== null);
            let r = impl(bo.e1!, be!.e1, inverted);
            r = r && impl(bo.e2!, be!.e2, inverted);
            return r;
        }
        else if (op === EXP.orOr) {
            const bo = orig.isBinExp()!;
            const be = e !== null ? e.isBinExp() : null;
            assert(be !== null);
            const lbefore = stack.length;
            let r = impl(bo.e1!, be!.e1, inverted);
            r = r || impl(bo.e2!, be!.e2, inverted);
            if (r)
                stack.setDim(lbefore); // purge added positive items
            return r;
        }
        else if (op === EXP.question) {
            const co = orig.isCondExp()!;
            const ce = e !== null ? e.isCondExp() : null;
            assert(ce !== null);
            if (!inverted) {
                const lbefore = stack.length;
                let a = impl(co.econd!, ce!.econd, inverted);
                a = a && impl(co.e1!, ce!.e1, inverted);
                let b = false;
                if (!a) {
                    b = impl(co.econd!, ce!.econd, !inverted);
                    b = b && impl(co.e2!, ce!.e2, inverted);
                }
                const r = a || b;
                if (r)
                    stack.setDim(lbefore);
                return r;
            }
            else {
                let a = false;
                {
                    const lbefore = stack.length;
                    a = impl(co.econd!, ce!.econd, inverted);
                    a = a || impl(co.e1!, ce!.e1, inverted);
                    if (a)
                        stack.setDim(lbefore);
                }
                let b = false;
                if (a) {
                    const lbefore = stack.length;
                    b = impl(co.econd!, ce!.econd, !inverted);
                    b = b || impl(co.e2!, ce!.e2, inverted);
                    if (b)
                        stack.setDim(lbefore);
                }
                return a && b;
            }
        }
        else { // 'primitive' expression
            let value = true;
            for (const fe of negatives) {
                if (fe === e) {
                    value = false;
                    break;
                }
            }
            const satisfied = inverted ? !value : value;
            if (!satisfied)
                stack.push(new Item(orig, inverted));
            return satisfied;
        }
    };

    impl(original, instantiated, false);

    for (let i = 0; i < stack.length; i++) {
        // write the expression only
        buf.writestring(ds("       "));
        if (stack.opIndex(i).inverted)
            buf.writeByte(0x21); // '!'
        buf.writestring(cstr(stack.opIndex(i).orig.toChars())); // ditto
        // here with no trailing newline
        if (i + 1 < stack.length)
            buf.writenl();
    }
    return stack.length;
}
