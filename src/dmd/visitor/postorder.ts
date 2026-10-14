// Ported from dmd/visitor/postorder.d (module dmd.visitor.postorder).
//
// "A depth-first visitor for expressions and statements."
//
// The module is TWO public entry points plus the two module-private visitor classes they drive:
// `walkPostorder(Expression, StoppableVisitor)` (postorder.d:20) and
// `walkPostorder(Statement, StoppableVisitor)` (postorder.d:27), over
// `PostorderExpressionVisitor` (postorder.d:45) and `PostorderStatementVisitor` (postorder.d:209).
//
// VISITOR TRANSLATION (13-visitor.md), Idiom A — both classes ARE `class .*Visitor` declarations in
// the D source, so the §1 rename scheme applies, not §7.5's nested-function idiom:
//   §1 — each `override void visit(X)` becomes `visitX`; the two `alias visit = typeof(super).visit;`
//        lines (postorder.d:47, :211) are DROPPED (no overload hiding in TS).
//   §2 — the traversal is driven by each node's own `accept`, which calls ITS OWN `visitX`; nothing
//        in this file dispatches by hand.
//   §4 — `visit(cast(BinExp)e)` (postorder.d:117/:129/:141) becomes `this.visitBinExp(e)`.
//
// OVERLOAD SETS — two Form-B renames (04-functions.md §1 Form B, suffix rule 2: a FIRST-parameter
// receiver split takes the bare receiver-type suffix):
//   - `walkPostorder(Expression, …)` (postorder.d:20) keeps the BARE name. Rule 1's first test is
//     inapplicable: no TS dependent IMPORTS either form (the deferrals in nogc.ts/expressionsem.ts/
//     statement.ts name it in string literals only), so the tie-break falls to the cross-module
//     D-caller count — the Expression form is called from EIGHT D modules (delegatize.d:164/:179/
//     :187/:192/:267, inlinecost.d:357, nogc.d:70/:283, canthrow.d:216, inline.d:2632,
//     sideeffect.d:65/:94, expressionsem.d:2288/:2292/:2323/:2325/:19045, visitor/foreachvar.d:102),
//     the Statement form from statement.d alone (:144/:183/:235). `walkPostorder(Statement, …)`
//     (postorder.d:27) therefore becomes `walkPostorderStatement`.
//   - `PostorderExpressionVisitor.doCond(Expression)` (postorder.d:56) keeps the bare name (the
//     form called from every traversal body); the `extern(D) doCond(Expression[])` overload
//     (postorder.d:63) becomes `doCondExpressionSlice`. Rule 2 asks for the bare receiver-type
//     suffix and its registered precedents are all class receivers, so a SLICE receiver has no
//     spelling in the guide: `Expressions` was rejected because arraytypes.ts already binds that
//     name to `Array<Expression | null>` — D's `Expressions`, which is what the containers are
//     BEFORE `peekSlice` unwraps them, i.e. the one type this parameter is not. `…Slice` follows
//     root/array.ts's own vocabulary for a `T[]`. Module-private, so nothing outside depends on it;
//     the spelling is an open item for the integrator to register as the slice-receiver precedent.
//
// THE DEFERRALS THIS FILE MAKES SWEEPABLE (for the wave reconciler, 14 §8; not this file's to fix
// under 14 §2 rule 1). Both entry points below are live and faithful, which makes every §2.5
// deferral naming them a deferral over an available export — CRITICAL per 11 §2.5, and two of them
// carry a comment positively asserting `src/dmd/visitor/postorder.ts` is absent, which as of this
// file's landing is FALSE. The 10 code sites and 3 test pins, by D line:
//   - `statement.ts:219/:253/:296` (statement.d:144/:183/:235) — all three are the Statement half,
//     so they sweep to `walkPostorderStatement`; their cites name the CALL site, where 11 §2.5
//     requires the definition (postorder.d:27), and their shape is the forbidden `(): never` IIFE.
//   - `nogc.ts:132/:375` (nogc.d:70/:283) and `expressionsem.ts:2696/:2704/:2745/:2750/:21370`
//     (expressionsem.d:2288/:2292/:2323/:2325/:19045) — all seven sweep to the bare `walkPostorder`.
//   - `nogc.test.ts:249/:259/:361` pin three of those messages; per 10 §1.8 rule 2 they are
//     CONVERTED to behaviour pins by whoever sweeps, never deleted.
// Until that sweep lands, nothing in the tree calls this file except its own test suite.
//
// `peekSlice` — A READ-SIDE DIVERGENCE INHERITED FROM THE RUNTIME LAYER, recorded once for all nine
// sites (postorder.d:85, :91, :154, :160, :170, :175 ×2, :184, :190). D's `peekSlice`
// (root/array.d:515) returns `(*array)[]`, a live VIEW onto the backing store; the port's
// (root/array.ts:364, via `opSlice()`) returns a COPY, under the root-runtime exemption that
// replaces contracts rather than bodies (00-how-to-use.md §0.1, `08-runtime-lib.md`). No call site
// here mutates through the slice, so array.ts's STOP clause (which fires on mutation through the
// slice) is not triggered; what is lost is the read side: if the CALLER's visitor replaced element
// k > i of the same container mid-walk, D would read the new element and the port reads the
// snapshot. No client in the `walkPostorder` set does that today (they mutate
// node fields, not array slots), so the divergence is latent, not live.
//
// VISIBILITY: `private:` at postorder.d:34 makes both classes MODULE-private, so they are NOT
// exported — D gives no other module access to them, and the two `walkPostorder` functions are the
// whole public surface. The co-located test drives them through those functions, exactly as a D
// caller does.
//
// ERASED (04-functions.md attribute erasure): `extern (C++) final`, `extern (D)`, `scope` (both the
// storage class on `pv` at postorder.d:22/:29 and the ctor attribute), `@safe`.
//
// Kept verbatim: the `doCond(a) || doCond(b) || applyTo(e);` short-circuit chains. The chain IS the
// postorder algorithm — each `doCond` returns `stop`, so the first child that stops the walk
// prevents both the remaining children and `applyTo`; only a fully-walked child list reaches
// `applyTo`, which is why `applyTo` returns a constant `true` (postorder.d:70-75).

import { StoppableVisitor } from "./index.js";
import { isExpression } from "../dtemplate.js";
import { peekSlice } from "../root/array.js";
// A VALUE import: `StructLiteralExp.StageFlags` (expression.d:1498) is hoisted out of the class as
// `StructLiteralExpStageFlags` and is read at run time by `visitStructLiteralExp` (postorder.d:180).
// It is read inside a method, never at this module's top level, so it is safe against the SCC
// load-order invariant recorded in index.ts's header (01-conventions.md §4.5).
import { StructLiteralExpStageFlags } from "../expression.js";

import type {
    ArrayExp,
    ArrayLiteralExp,
    AssertExp,
    AssocArrayLiteralExp,
    BinExp,
    CallExp,
    CatAssignExp,
    CatExp,
    CondExp,
    EqualExp,
    Expression,
    NewAnonClassExp,
    NewExp,
    SliceExp,
    StructLiteralExp,
    TupleExp,
    TypeidExp,
    UnaExp,
} from "../expression.js";
import type {
    CaseStatement,
    CompoundStatement,
    DebugStatement,
    DefaultStatement,
    DoStatement,
    ForStatement,
    ForeachRangeStatement,
    ForeachStatement,
    IfStatement,
    LabelStatement,
    PeelStatement,
    PragmaStatement,
    ScopeGuardStatement,
    ScopeStatement,
    Statement,
    SwitchStatement,
    SynchronizedStatement,
    TryCatchStatement,
    TryFinallyStatement,
    UnrolledLoopStatement,
    WhileStatement,
    WithStatement,
} from "../statement.js";

/**
 * dmd/visitor/postorder.d:20 — `bool walkPostorder(Expression e, StoppableVisitor v)`.
 *
 * Walks the expression tree rooted at `e` in depth-first (postorder) evaluation order, calling
 * `v` on each sub-expression through its own `accept`. Returns `v.stop` — true when `v` asked the
 * walk to end early.
 *
 * Form B (04 §1): this is the `Expression` half of the `walkPostorder` overload pair and keeps the
 * bare name; the `Statement` half is `walkPostorderStatement` below.
 */
export function walkPostorder(e: Expression, v: StoppableVisitor): boolean {
    const pv = new PostorderExpressionVisitor(v);   // postorder.d:22 (`scope` erased)
    e.accept(pv);
    return v.stop;
}

/**
 * dmd/visitor/postorder.d:27 — `bool walkPostorder(Statement s, StoppableVisitor v)`.
 *
 * The statement counterpart of `walkPostorder`: same contract, same return, over the statement
 * tree. Renamed per 04 §1 Form B (receiver-type suffix); D spells both `walkPostorder`.
 */
export function walkPostorderStatement(s: Statement, v: StoppableVisitor): boolean {
    const pv = new PostorderStatementVisitor(v);    // postorder.d:29 (`scope` erased)
    s.accept(pv);
    return v.stop;
}

// postorder.d:34 `private:` — everything below is module-private (see the header).

/**************************************
 * dmd/visitor/postorder.d:45 — `extern (C++) final class PostorderExpressionVisitor : StoppableVisitor`.
 *
 * An Expression tree walker that will visit each Expression e in the tree,
 * in depth-first evaluation order, and call fp(e,param) on it.
 * fp() signals whether the walking continues with its return value:
 * Returns:
 *      0       continue
 *      1       done
 * It's a bit slower than using virtual functions, but more encapsulated and less brittle.
 * Creating an iterator for this would be much more complex.
 */
class PostorderExpressionVisitor extends StoppableVisitor {
    // dropped: alias visit = typeof(super).visit (postorder.d:47) — no overload hiding in TS (13 §1).
    v: StoppableVisitor;                            // postorder.d:49

    // postorder.d:51 — `extern (D) this(StoppableVisitor v) scope @safe`.
    constructor(v: StoppableVisitor) {
        super();
        this.v = v;
    }

    /// postorder.d:56 — recurse into a child unless the walk has already stopped. Returns `stop`.
    doCond(e: Expression | null): boolean {
        if (!this.stop && e !== null)               // `if (!stop && e)` (06 §2.7)
            e.accept(this);
        return this.stop;
    }

    /// postorder.d:63 — `extern(D) bool doCond(Expression[] e)`; Form-B rename (04 §1, header).
    doCondExpressionSlice(e: (Expression | null)[]): boolean {
        for (let i = 0; i < e.length && !this.stop; i++)
            this.doCond(e[i]);
        return this.stop;
    }

    /// postorder.d:70 — hand the node to the wrapped visitor, then adopt its `stop`. Always true,
    /// so an `|| applyTo(e)` tail runs exactly once and terminates the chain.
    applyTo(e: Expression): boolean {
        e.accept(this.v);
        this.stop = this.v.stop;
        return true;
    }

    override visitExpression(e: Expression): void {  // postorder.d:77
        this.applyTo(e);
    }

    override visitNewExp(e: NewExp): void {          // postorder.d:82
        //printf("NewExp::apply(): %s\n", toChars());
        this.doCond(e.placement) || this.doCond(e.thisexp) || this.doCondExpressionSlice(peekSlice(e.arguments_)) ||
            this.applyTo(e);
    }

    override visitNewAnonClassExp(e: NewAnonClassExp): void {   // postorder.d:88
        //printf("NewAnonClassExp::apply(): %s\n", toChars());
        this.doCond(e.placement) || this.doCond(e.thisexp) || this.doCondExpressionSlice(peekSlice(e.arguments_)) ||
            this.applyTo(e);
    }

    override visitTypeidExp(e: TypeidExp): void {    // postorder.d:94
        // `isExpression` is the FREE function at dtemplate.d:78, reached by UFCS in D (04 §6.1).
        this.doCond(isExpression(e.obj)) || this.applyTo(e);
    }

    override visitUnaExp(e: UnaExp): void {          // postorder.d:99
        this.doCond(e.e1) || this.applyTo(e);
    }

    override visitBinExp(e: BinExp): void {          // postorder.d:104
        this.doCond(e.e1) || this.doCond(e.e2) || this.applyTo(e);
    }

    override visitCatExp(e: CatExp): void {          // postorder.d:109
        const lowering = e.lowering;                 // `if (auto lowering = e.lowering)` (06 §2.6)
        if (lowering !== null) {
            this.doCond(lowering) || this.applyTo(e);
        } else {
            this.visitBinExp(e);                     // postorder.d:117 `visit(cast(BinExp)e)` (13 §4)
        }
    }

    override visitCatAssignExp(e: CatAssignExp): void {   // postorder.d:121
        const lowering = e.lowering;
        if (lowering !== null) {
            this.doCond(lowering) || this.applyTo(e);
        } else {
            this.visitBinExp(e);                     // postorder.d:129 `visit(cast(BinExp)e)` (13 §4)
        }
    }

    override visitEqualExp(e: EqualExp): void {      // postorder.d:133
        const lowering = e.lowering;
        if (lowering !== null) {
            this.doCond(lowering) || this.applyTo(e);
        } else {
            this.visitBinExp(e);                     // postorder.d:141 `visit(cast(BinExp)e)` (13 §4)
        }
    }

    override visitAssertExp(e: AssertExp): void {    // postorder.d:145
        //printf("CallExp::apply(apply_fp_t fp, void *param): %s\n", toChars());
        this.doCond(e.e1) || this.doCond(e.msg) || this.applyTo(e);
    }

    override visitCallExp(e: CallExp): void {        // postorder.d:151
        //printf("CallExp::apply(apply_fp_t fp, void *param): %s\n", toChars());
        this.doCond(e.e1) || this.doCondExpressionSlice(peekSlice(e.arguments_)) || this.applyTo(e);
    }

    override visitArrayExp(e: ArrayExp): void {      // postorder.d:157
        //printf("ArrayExp::apply(apply_fp_t fp, void *param): %s\n", toChars());
        this.doCond(e.e1) || this.doCondExpressionSlice(peekSlice(e.arguments_)) || this.applyTo(e);
    }

    override visitSliceExp(e: SliceExp): void {      // postorder.d:163
        this.doCond(e.e1) || this.doCond(e.lwr) || this.doCond(e.upr) || this.applyTo(e);
    }

    override visitArrayLiteralExp(e: ArrayLiteralExp): void {   // postorder.d:168
        this.doCond(e.basis) || this.doCondExpressionSlice(peekSlice(e.elements)) || this.applyTo(e);
    }

    override visitAssocArrayLiteralExp(e: AssocArrayLiteralExp): void {   // postorder.d:173
        this.doCondExpressionSlice(peekSlice(e.keys)) || this.doCondExpressionSlice(peekSlice(e.values)) ||
            this.applyTo(e);
    }

    override visitStructLiteralExp(e: StructLiteralExp): void {   // postorder.d:178
        // The re-entrancy guard: a struct literal reachable from its own elements is walked once.
        if ((e.stageflags & StructLiteralExpStageFlags.apply) !== 0)   // postorder.d:180 (06 §2.5)
            return;
        const old = e.stageflags;
        e.stageflags |= StructLiteralExpStageFlags.apply;
        // PAIRED STATE (11 §2.5): `stageflags |= apply` … `stageflags = old` is a set/reset pair on
        // state that outlives a throw (scope rule (d)), and the walk hands every node to the
        // CALLER's visitor, which in this tree reaches another file's deferral (nogc.ts,
        // statement.ts) — scope rule (a), a throw in a transitively-called module counts. A leaked
        // `apply` bit would silently make every later walk of the same literal a no-op, in the same
        // process, which is the defect class the rule cites, and §2.5 makes the protection mandatory
        // "even when the region provably has no early exit today".
        // SHAPE, and it matches none of §2.5's three enumerated forms literally: D's release is a
        // plain trailing statement on its only path, not `scope(exit)`, not a return the normal path
        // consumes, not repeated at several D lines. The plain `finally` is the nearest and is safe
        // for exactly the reasons §2.5 keys the other two on — the release consumes no value (so
        // `finally` swallows nothing) and is idempotent, and it was moved OUT of the try body (so it
        // cannot double-release). OPEN FOR THE INTEGRATOR: ratify this as a fourth form ("trailing
        // plain release, value not consumed -> plain finally"); every set/reset pair of this shape
        // in the port hits the same gap. The divergence is confined to the throw path, where D
        // leaves the bit set and the port restores it; the pin below is what records it.
        try {
            this.doCondExpressionSlice(peekSlice(e.elements)) || this.applyTo(e);
        } finally {
            e.stageflags = old;                     // postorder.d:185
        }
    }

    override visitTupleExp(e: TupleExp): void {      // postorder.d:188
        this.doCond(e.e0) || this.doCondExpressionSlice(peekSlice(e.exps)) || this.applyTo(e);
    }

    override visitCondExp(e: CondExp): void {        // postorder.d:193
        this.doCond(e.econd) || this.doCond(e.e1) || this.doCond(e.e2) || this.applyTo(e);
    }
}

/**************************************
 * dmd/visitor/postorder.d:209 — `extern (C++) final class PostorderStatementVisitor : StoppableVisitor`.
 *
 * A Statement tree walker that will visit each Statement s in the tree,
 * in depth-first evaluation order, and call fp(s,param) on it.
 * fp() signals whether the walking continues with its return value:
 * Returns:
 *      0       continue
 *      1       done
 * It's a bit slower than using virtual functions, but more encapsulated and less brittle.
 * Creating an iterator for this would be much more complex.
 */
class PostorderStatementVisitor extends StoppableVisitor {
    // dropped: alias visit = typeof(super).visit (postorder.d:211) — no overload hiding in TS (13 §1).
    v: StoppableVisitor;                            // postorder.d:213

    // postorder.d:215 — `extern (D) this(StoppableVisitor v) scope @safe`.
    constructor(v: StoppableVisitor) {
        super();
        this.v = v;
    }

    /// postorder.d:220 — recurse into a child unless the walk has already stopped. Returns `stop`.
    doCond(s: Statement | null): boolean {
        if (!this.stop && s !== null)               // `if (!stop && s)` (06 §2.7)
            s.accept(this);
        return this.stop;
    }

    /// postorder.d:227 — see `PostorderExpressionVisitor.applyTo`; always true.
    applyTo(s: Statement): boolean {
        s.accept(this.v);
        this.stop = this.v.stop;
        return true;
    }

    override visitStatement(s: Statement): void {    // postorder.d:234
        this.applyTo(s);
    }

    override visitPeelStatement(s: PeelStatement): void {   // postorder.d:239
        this.doCond(s.s) || this.applyTo(s);
    }

    // The `!` on `s.statements` is FAITHFUL, not a narrowing convenience: D dereferences the
    // `Statements*` unguarded (`s.statements.length`, postorder.d:246) where it goes through
    // `peekSlice` on the expression side, and a null container faults in D too. Same at :254/:329.
    override visitCompoundStatement(s: CompoundStatement): void {   // postorder.d:244
        for (let i = 0; i < s.statements!.length; i++)              // `s.statements.length`
            if (this.doCond(s.statements!.opIndex(i)))              // `(*s.statements)[i]`
                return;
        this.applyTo(s);
    }

    override visitUnrolledLoopStatement(s: UnrolledLoopStatement): void {   // postorder.d:252
        for (let i = 0; i < s.statements!.length; i++)
            if (this.doCond(s.statements!.opIndex(i)))
                return;
        this.applyTo(s);
    }

    override visitScopeStatement(s: ScopeStatement): void {   // postorder.d:260
        this.doCond(s.statement) || this.applyTo(s);
    }

    override visitWhileStatement(s: WhileStatement): void {   // postorder.d:265
        this.doCond(s._body) || this.applyTo(s);
    }

    override visitDoStatement(s: DoStatement): void {         // postorder.d:270
        this.doCond(s._body) || this.applyTo(s);
    }

    override visitForStatement(s: ForStatement): void {       // postorder.d:275
        this.doCond(s._init) || this.doCond(s._body) || this.applyTo(s);
    }

    override visitForeachStatement(s: ForeachStatement): void {   // postorder.d:280
        this.doCond(s._body) || this.applyTo(s);
    }

    override visitForeachRangeStatement(s: ForeachRangeStatement): void {   // postorder.d:285
        this.doCond(s._body) || this.applyTo(s);
    }

    override visitIfStatement(s: IfStatement): void {         // postorder.d:290
        this.doCond(s.ifbody) || this.doCond(s.elsebody) || this.applyTo(s);
    }

    override visitPragmaStatement(s: PragmaStatement): void { // postorder.d:295
        this.doCond(s._body) || this.applyTo(s);
    }

    override visitSwitchStatement(s: SwitchStatement): void { // postorder.d:300
        this.doCond(s._body) || this.applyTo(s);
    }

    override visitCaseStatement(s: CaseStatement): void {     // postorder.d:305
        this.doCond(s.statement) || this.applyTo(s);
    }

    override visitDefaultStatement(s: DefaultStatement): void {   // postorder.d:310
        this.doCond(s.statement) || this.applyTo(s);
    }

    override visitSynchronizedStatement(s: SynchronizedStatement): void {   // postorder.d:315
        this.doCond(s._body) || this.applyTo(s);
    }

    override visitWithStatement(s: WithStatement): void {     // postorder.d:320
        this.doCond(s._body) || this.applyTo(s);
    }

    override visitTryCatchStatement(s: TryCatchStatement): void {   // postorder.d:325
        if (this.doCond(s._body))
            return;
        // Two faithful unguarded derefs: the outer `!` mirrors D's `Catches*` dereference, the inner
        // one its unchecked element read — D would fault on either, so neither is a narrowed guess.
        for (let i = 0; i < s.catches!.length; i++)           // `s.catches.length`
            if (this.doCond(s.catches!.opIndex(i)!.handler))  // `(*s.catches)[i].handler`
                return;
        this.applyTo(s);
    }

    override visitTryFinallyStatement(s: TryFinallyStatement): void {   // postorder.d:335
        this.doCond(s._body) || this.doCond(s.finalbody) || this.applyTo(s);
    }

    override visitScopeGuardStatement(s: ScopeGuardStatement): void {   // postorder.d:340
        this.doCond(s.statement) || this.applyTo(s);
    }

    override visitDebugStatement(s: DebugStatement): void {   // postorder.d:345
        this.doCond(s.statement) || this.applyTo(s);
    }

    override visitLabelStatement(s: LabelStatement): void {   // postorder.d:350
        this.doCond(s.statement) || this.applyTo(s);
    }
}
