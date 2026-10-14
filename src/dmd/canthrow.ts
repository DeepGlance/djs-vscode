// Ported from dmd/canthrow.d (module dmd.canthrow).
//
// Perform checks for `nothrow`.
//
// WHOLE-FILE retranslation (P5.0 wave 16): replaces the rung-era hand-rolled descent, which walked
// Bin/Una operands only and walled NewExp, DeleteExp and five further arms. Three top-level D
// declarations, in source order: `enum CT` (:37), `canThrow` (:57) with its nested `CanThrow` visitor
// class (:61), and the module-private `Dsymbol_canThrow` (:224). No `version`/`debug`/`static if`
// sites, no structs, no unions, no `goto`, no unittest blocks.
//
// VISITOR CENSUS (13-visitor.md §0(a)): the D module declares ONE visitor class, the
// `extern (C++) final class` extending `StoppableVisitor`, nested INSIDE `canThrow`
// (canthrow.d:61). It is a real class declaration, so 13 §1's named-method rename applies (Idiom A):
// each `override void visit(X)` becomes `visitX`, and `alias visit = typeof(super).visit;` (:63) is
// DROPPED. The class stays NESTED, exactly as in D: `checkFuncThrows` and three visit methods read
// `func` and `eSink`, the enclosing function's parameters, so the class body is a closure over them
// (the sideeffect.ts precedent). Its `extends StoppableVisitor` is therefore evaluated at call time,
// which also keeps this module's top level free of a class-extends-value edge into the core SCC.
// Dispatch arrives through each node's own `accept`, driven by `walkPostorder` — every
// sub-expression is visited, and the base `Visitor` forwards ConstructExp/BlitExp to `visitAssignExp`
// (13 §4), which is where D's `ae.op == EXP.blit` test comes from.
//
// DEFERRED CALLEES: none. Every callee is live in the tree; this file carries no wall.

import { STC, Tclass, Tsarray } from "./astenums.js";
import { isArrayConstruction } from "./expression.js";
import { foreachDsymbol } from "./dsymbol.js";
import { include, toAlias } from "./dsymbolsem.js";
import { calledFunctionType, checkOverriddenDtor, errorSupplementalInferredAttr, isLvalue } from "./expressionsem.js";
import { global } from "./globals.js";
import { EXP } from "./tokens.js";
import { baseElemOf, nextOf, toBasetype } from "./typesem.js";
import { StoppableVisitor } from "./visitor/index.js";
import { walkPostorder } from "./visitor/postorder.js";
import { assert, assertUnreachable } from "../assert.js";
import { ds } from "../dstring.js";
// last: 01 §4.8 — blockexit.ts imports this module (`canThrow`, blockexit.d:18 is the reverse edge), so
// the pair is a cycle; at last position the edge is only reached after every AST/sema module above has
// been entered. `checkThrow` is read at call time only (in `visitThrowExp`), never at module init.
import { checkThrow } from "./blockexit.js";

import type { AggregateDeclaration } from "./aggregate.js";
import type { DtorDeclaration } from "./func.js";
import type { Dsymbol } from "./dsymbol.js";
import type { ErrorSink } from "./errorsink.js";
import type {
    AssignExp, CallExp, DeclarationExp, DeleteExp, Expression, NewAnonClassExp, NewExp, ThrowExp,
} from "./expression.js";
import type { FuncDeclaration } from "./func.js";
import type { Type } from "./mtype.js";

// dropped: import dmd.aggregate (canthrow.d:16) as a value — `AggregateDeclaration` names a local's type
//          only (canthrow.d:163), so the edge is type-only.
// dropped: import dmd.mtype (canthrow.d:27) as a value — `Type` names locals' types only.
// dropped: import dmd.visitor (canthrow.d:29) re-exports — only `StoppableVisitor` is used.

/**
 * Status indicating what kind of throwable might be caused by an expression.
 *
 * This is a subset of `BE` restricted to the values actually used by `canThrow`.
 *
 * dmd/canthrow.d:37 — `enum CT : BE`. The values mirror the BE bits (none=0, throw_=2, errthrow=0x80)
 * inline rather than reading `BE.*`: blockexit.ts imports this module (canThrow), so reading `BE.*` at
 * this module's init time would observe an undefined `BE` under the ESM import cycle. The numeric values
 * are fixed by the BE enum (blockexit.ts) and pinned against it by canthrow.test.ts.
 */
export const CT = {
    /// Never throws an `Exception` or `Throwable`
    none: 0, // BE.none
    /// Might throw an `Exception`
    exception: 2, // BE.throw_
    // Might throw an `Error`
    error: 0x80, // BE.errthrow
} as const;
export type CT = number;

/********************************************
 * If `eSink` is not null, generate an error if `e` throws
 * Params:
 *      e = expression to check for throwing
 *      func = function
 *      eSink = if !null, then send error messages to eSink
 * Returns: `CT.exception` or `CT.error` if the expression may throw exceptions.
 *
 * dmd/canthrow.d:57 — `CT canThrow(Expression e, FuncDeclaration func, ErrorSink eSink)`.
 *
 * `func` and `eSink` are nullable: D tests both (canthrow.d:76 `if (eSink)`, :85 `else if (func)`).
 * With `eSink` null and `func` set, every throwing callee is recorded on `func` for nothrow inference
 * (`setThrowCall`); with `eSink` set, each is reported as a "not nothrow" error instead.
 */
export function canThrow(e: Expression, func: FuncDeclaration | null, eSink: ErrorSink | null): CT {
    //printf("Expression::canThrow(%d) %s\n", mustNotThrow, e.toChars());
    // stop walking if we determine this expression can throw

    // canthrow.d:61 — `extern (C++) final class CanThrow : StoppableVisitor`. Nested in D and nested here
    // (see the file header). `alias visit = typeof(super).visit;` (:63) is DROPPED (13 §1).
    class CanThrow extends StoppableVisitor {
        result: CT = CT.none;

        // canthrow.d:66 `public:` — TS default visibility is public, so the label has no analogue.

        // canthrow.d:67 — `extern (D) this() scope @safe`, empty body; `scope`/`@safe` erase (04 §8).
        constructor() {
            super();
        }

        /// canthrow.d:71 — `void checkFuncThrows(Expression e, FuncDeclaration f)`. If `f` is not
        /// `nothrow`: report it through `eSink`, or record it on `func` for inference, and OR in
        /// `CT.exception`.
        checkFuncThrows(e: Expression, f: FuncDeclaration): void {
            const tf = toBasetype(f.type!).isTypeFunction();
            if (tf && !tf.isNothrow) {
                if (eSink) {
                    eSink.error(e.loc, ds("%s `%s` is not `nothrow`"), f.kind(), f.toPrettyChars());
                    if (!f.isDtorDeclaration())
                        errorSupplementalInferredAttr(f, 10, false, STC.nothrow_, eSink);

                    // dropped: the function-local `import dmd.expressionsem : checkOverriddenDtor;`
                    //          (canthrow.d:82) — folded into the file's expressionsem import.
                    checkOverriddenDtor(f, null, e.loc,
                        (dd: DtorDeclaration) => dd.type!.toTypeFunction().isNothrow, ds("not nothrow"));
                }
                else if (func) {
                    func.setThrowCall(e.loc, f);
                }
                this.result |= CT.exception;
            }
        }

        /// canthrow.d:93 — `override void visit(Expression)`: a node contributes nothing by itself;
        /// `walkPostorder` still descends into its operands.
        override visitExpression(_e: Expression): void {
        }

        /// canthrow.d:97 — `override void visit(DeclarationExp de)`.
        override visitDeclarationExp(de: DeclarationExp): void {
            this.result |= Dsymbol_canThrow(de.declaration!, func, eSink);
        }

        /// canthrow.d:102 — `override void visit(CallExp ce)`.
        override visitCallExp(ce: CallExp): void {
            if (ce.inDebugStatement)
                return;

            if (global.errors && !ce.e1!.type)
                return; // error recovery

            // `ce.arguments.length` dereferences the `Expressions*` unconditionally, as D does
            // (CallExp semantic allocates it, expressionsem.d:2472).
            if (ce.f && ce.arguments_!.length > 0) {
                const tb: Type = toBasetype(ce.arguments_!.opIndex(0)!.type!);
                const tbNext = nextOf(tb);
                if (tbNext) {
                    const ts = baseElemOf(tbNext).isTypeStruct();
                    if (ts) {
                        const sd = ts.sym!;
                        const id = ce.f.ident;
                        if (sd.postblit && isArrayConstruction(id)) {
                            this.checkFuncThrows(ce, sd.postblit);
                            return;
                        }
                    }
                }
            }

            /* If calling a function or delegate that is typed as nothrow,
             * then this expression cannot throw.
             * Note that pure functions can throw.
             */
            if (ce.f && ce.f === func)
                return;
            const tf = calledFunctionType(ce);
            if (tf && tf.isNothrow)
                return;

            if (ce.f)
                this.checkFuncThrows(ce, ce.f);
            else if (eSink) {
                let e1 = ce.e1!;
                const pe = e1.isPtrExp();
                if (pe)   // print 'fp' if e1 is (*fp)
                    e1 = pe.e1!;
                eSink.error(ce.loc, ds("`%s` is not `nothrow`"), e1.toChars());
            }
            this.result |= CT.exception;
        }

        /// canthrow.d:150 — `override void visit(NewExp ne)`.
        override visitNewExp(ne: NewExp): void {
            if (ne.member) {
                // See if constructor call can throw
                this.checkFuncThrows(ne, ne.member);
            }
            // regard storage allocation failures as not recoverable
        }

        /// canthrow.d:160 — `override void visit(DeleteExp de)`.
        override visitDeleteExp(de: DeleteExp): void {
            const tb: Type = toBasetype(de.e1!.type!);
            let ad: AggregateDeclaration | null = null;
            switch (tb.ty) {
                case Tclass:
                    // `as unknown as AggregateDeclaration`: audited upcast cascade (02 §11.5) of the
                    // `deferred` field shadow (AggregateDeclaration.deferred: Dsymbol over
                    // Dsymbol.deferred: bool, aggregate.ts); a ClassDeclaration IS an AggregateDeclaration.
                    ad = tb.isTypeClass()!.sym as unknown as AggregateDeclaration;
                    break;

                default:
                    assertUnreachable("canthrow.d:171 — error should have been detected by semantic()");
            }

            if (ad!.dtor)
                this.checkFuncThrows(de, ad!.dtor);
        }

        /// canthrow.d:178 — `override void visit(AssignExp ae)`. Also reached for ConstructExp and
        /// BlitExp through the base Visitor's forwarding (13 §4).
        override visitAssignExp(ae: AssignExp): void {
            // blit-init cannot throw
            if (ae.op === EXP.blit)
                return;
            /* Element-wise assignment could invoke postblits.
             */
            let t: Type;
            if (toBasetype(ae.type!).ty === Tsarray) {
                if (!isLvalue(ae.e2!))
                    return;
                t = ae.type!;
            }
            else {
                const se = ae.e1!.isSliceExp();
                if (se)
                    t = se.e1!.type!;
                else
                    return;
            }

            const ts = baseElemOf(t).isTypeStruct();
            if (ts) {
                const postblit = ts.sym!.postblit;
                if (postblit)
                    this.checkFuncThrows(ae, postblit);
            }
        }

        /// canthrow.d:202 — `override void visit(ThrowExp te)`.
        override visitThrowExp(te: ThrowExp): void {
            const res = checkThrow(te.loc, te.e1!, func, eSink);
            assert((res & ~(CT.exception | CT.error)) === 0);
            this.result |= res;
        }

        /// canthrow.d:209 — `override void visit(NewAnonClassExp)`.
        override visitNewAnonClassExp(_e: NewAnonClassExp): void {
            assertUnreachable("canthrow.d:211 — should have been lowered by semantic()");
        }
    }

    const ct = new CanThrow();   // canthrow.d:215 (`scope` erased)
    walkPostorder(e, ct);
    return ct.result;
}

/**************************************
 * Does symbol `s`, when initialized, throw?
 * Mirrors logic in Dsymbol_toElem().
 *
 * dmd/canthrow.d:224 — `private CT Dsymbol_canThrow(Dsymbol s, FuncDeclaration func, ErrorSink eSink)`.
 * Module-private in D and here (no reader outside this module, 01 §2.5).
 */
function Dsymbol_canThrow(s: Dsymbol, func: FuncDeclaration | null, eSink: ErrorSink | null): CT {
    let result: CT = CT.none;

    // canthrow.d:228 — nested `int symbolDg(Dsymbol s)` -> inner arrow (04 §5). The slot is forwarded
    // raw by foreachDsymbol / foreachVar and dereferenced unconditionally, as in D (the `!`).
    const symbolDg = (s: Dsymbol | null): number => {
        result |= Dsymbol_canThrow(s!, func, eSink);
        return 0;
    };

    //printf("Dsymbol_toElem() %s\n", s.toChars());
    const vd = s.isVarDeclaration();
    if (vd) {
        s = toAlias(s);
        if (s !== vd)
            return Dsymbol_canThrow(s, func, eSink);
        if (vd.storage_class & STC.manifest) {
        }
        else if (vd.isStatic() || vd.storage_class & (STC.extern_ | STC.gshared)) {
        }
        else {
            if (vd._init) {
                const ie = vd._init.isExpInitializer();
                if (ie)
                    result |= canThrow(ie.exp!, func, eSink);
            }
            if (vd.needsScopeDtor())
                result |= canThrow(vd.edtor!, func, eSink);
        }
    }
    else {
        const ad = s.isAttribDeclaration();
        if (ad) {
            foreachDsymbol(include(ad, null), symbolDg);
        }
        else {
            const tm = s.isTemplateMixin();
            if (tm) {
                foreachDsymbol(tm.members, symbolDg);
            }
            else {
                const td = s.isTupleDeclaration();
                if (td) {
                    // `td.foreachVar(&symbolDg)` with an `int delegate` resolves to the int-returning
                    // overload (declaration.d), `foreachVarFromIntDelegate` per 04 §1 Form B.
                    td.foreachVarFromIntDelegate(symbolDg);
                }
            }
        }
    }
    return result;
}
