// Ported from dmd/delegatize.d (module dmd.delegatize).
//
// "Implements conversion from expressions to delegates for lazy parameters."
//
// Four top-level D declarations, in source order, all translated whole — no wall, no escalation:
//   - `toDelegate`              (delegatize.d:48)  — exported; builds the lazy-argument delegate literal.
//   - `lambdaSetParent`         (delegatize.d:86)  — D `private`, so NOT exported (01 §2.5); its
//     nested `LambdaSetParent` visitor class sits at :88.
//   - `lambdaCheckForNestedRef` (delegatize.d:205) — exported (funcsem.d:4279 calls it); its nested
//     `LambdaCheckForNestedRef` visitor class sits at :207.
//   - `ensureStaticLinkTo`      (delegatize.d:284) — exported (expressionsem.d and funcsem.d call it).
// No `version`/`debug`/`static if` sites, no structs of our own, no unions, no jumps, no unittest
// blocks (verified: `grep -c unittest delegatize.d` -> 0).
//
// VISITOR CENSUS (13-visitor.md §7, recorded on a code-free header line): the D module declares two
// `extern (C++) final class` types extending `StoppableVisitor`, each NESTED inside the function that
// drives it (delegatize.d:88, :207). They are real class declarations, so 13 §1's named-method rename
// applies (Idiom A), not 13 §7.5's nested-function idiom: each `override void visit(X)` becomes
// `visitX`, and both `alias visit = typeof(super).visit;` lines (:90, :209) are DROPPED — no overload
// hiding in TS. The classes stay nested exactly as in D (tree precedent: sideeffect.ts). That also
// keeps this module free of a load-time class-extends-value edge into the visitor root (01 §4.1,
// §4.7): `extends StoppableVisitor` is evaluated at CALL time.
//
// DISPATCH NOTES (13 §4 — which named method a D `visit`/`accept` binds):
//   - Every intra-visitor traversal in D goes through `accept(this)` (never an explicit
//     `visit(x)` call), so dispatch is by the node's own `accept` (13 §2) and nothing here names a
//     base method.
//   - `LambdaSetParent` overrides the two ROOT slots `visit(Dsymbol)` (:148) and `visit(Initializer)`
//     (:158) with empty bodies. Every Dsymbol / Initializer kind it does not name therefore routes
//     through the base forwarding chain (`visitFuncDeclaration` -> `visitDeclaration` ->
//     `visitDsymbol`, `visitVoidInitializer` -> `visitInitializer`, …) to those empty bodies, exactly
//     as D's overload inheritance does. `VarDeclaration` subclasses (`EnumMember`,
//     `BitFieldDeclaration`, the `TypeInfo*Declaration` family) reach `visitVarDeclaration` the same
//     way. One exception: `CInitializer` does NOT reach `visitInitializer` — its base overload is
//     upstream's self-forward (dmd/visitor/parsetime.d:304 — `void visit(AST.CInitializer i) {
//     visit(cast(AST.CInitializer)i); }`), which parsetime.ts escalates. It is unreachable here: a
//     CInitializer is ImportC-only (excluded), so none occurs in the AST of a D source.
//   - `LambdaCheckForNestedRef` overrides only `visit(Expression)` among the roots; it is driven by
//     `walkPostorder` over expressions alone, so no other root is reachable from it.
//
// FAITHFUL QUIRK, kept verbatim: `LambdaCheckForNestedRef` never sets `stop`, so the postorder walk
// visits EVERY node, and each `VarExp`/`SymOffExp`/`ThisExp`/`DeclarationExp` visit OVERWRITES
// `result`. A `true` recorded by an early node can be reset to `false` by a later one; the function
// reports the verdict of the LAST such node in postorder (the diagnostics themselves are already
// emitted by `checkNestedReference`). The early `return` at :247 exits only that one visit.
//
// RESOLVED CONSTRUCTS (each a translation decision, listed for review):
//   - `Loc loc = e.loc;` (:51) is a plain share: `Loc` is an alias-safe register member (03 §9.1).
//   - `ParameterList()` (:52), D's default-initialized struct, is `new ParameterList(null)`
//     (construction, not a copy; tree precedent clone.test.ts).
//   - `t.hasWild()` (:53) returns `int`; the condition is made explicit as `!== 0` (06 §2.5).
//   - D field `var` of `SymOffExp`/`VarExp`/`ThisExp` is `var_` in the port (01 §2.3).
//   - `foreach (i; 0 .. pfd.closureVars.length)` (:101) and the two `Array!T` index loops (:169,
//     :176) follow 06 §1.3 and §1.9 (`opSlice().entries()` for the indexed form).
//
// ERASED (04-functions.md attribute erasure): `extern (C++) final`, `extern (D)`, `scope` (the ctor
// attribute and the storage class on `lsp`/`v` at :191/:266), `@safe`. The `public:` labels
// (:112, :210) are the default TS visibility. `import core.stdc.stdio` is dropped (01 §3.7): its only
// uses are commented-out `printf` traces, kept as comments.

import { LINK, MODFlags, STC, Tvoid } from "./astenums.js";
import type { VarDeclaration } from "./declaration.js";
import type { Scope } from "./dscope.js";
import type { Dsymbol } from "./dsymbol.js";
import { ErrorExp, FuncExp } from "./expression.js";
import type {
    AssocArrayLiteralExp,
    DeclarationExp,
    Expression,
    IndexExp,
    SliceExp,
    SymOffExp,
    ThisExp,
    VarExp,
} from "./expression.js";
import { FuncLiteralDeclaration } from "./func.js";
import type { FuncDeclaration } from "./func.js";
import type { ArrayInitializer, ExpInitializer, Initializer, StructInitializer } from "./init.js";
import { Loc } from "./location.js";
import { ParameterList, TypeFunction } from "./mtype.js";
import type { Type } from "./mtype.js";
import { ExpStatement, ReturnStatement } from "./statement.js";
import type { Statement } from "./statement.js";
import { TOK } from "./tokens.js";
import { StoppableVisitor } from "./visitor/index.js";
import { walkPostorder } from "./visitor/postorder.js";
// last (01 §4.8): the semantic passes come after every AST-node module, so a module that enters the
// core SCC through this file enters it through a node file, never through a `*sem` pass. All four
// are body-phase value imports (01 §4.3), read only inside function bodies.
import { toParentP } from "./dsymbolsem.js";
import { expressionSemantic } from "./expressionsem.js";
import { checkNestedReference } from "./funcsem.js";
import { initializerToExpression } from "./initsem.js";

/*********************************
 * dmd/delegatize.d:48 — `Expression toDelegate(Expression e, Type t, Scope* sc)`.
 *
 * Convert expression into a delegate.
 *
 * Used to convert the argument to a lazy parameter.
 *
 * Params:
 *  e = argument to convert to a delegate
 *  t = the type to be returned by the delegate
 *  sc = context
 * Returns:
 *  A delegate literal
 *
 * Contract: `e` has already been through semantic (its declarations get re-parented). The result is
 * the semantically analysed `FuncExp` wrapping a `delegate` literal whose body is `return e;`
 * (`t` not void) or the expression statement `e;` (`t` void) — the shape ldc2 -vcg-ast prints for
 * `take(a + 1)` as `take(delegate int() … => a + 1)`. Returns the shared `ErrorExp` when a variable
 * reference in `e` cannot be reached from the new literal (the diagnostic is already emitted).
 * `sc` is pushed and popped around the nested-reference check; on return it is balanced.
 */
export function toDelegate(e: Expression, t: Type, sc: Scope): Expression {
    //printf("Expression::toDelegate(t = %s) %s\n", t.toChars(), e.toChars());
    const loc: Loc = e.loc;
    const tf = new TypeFunction(new ParameterList(null), t, LINK.d);
    if (t.hasWild() !== 0)
        tf.mod = MODFlags.wild;
    const fld = new FuncLiteralDeclaration(loc, loc, tf, TOK.delegate_, null);
    lambdaSetParent(e, fld);

    // delegatize.d:58-61 (`sc = sc.push();` … `sc = sc.pop();`). D needs no try/finally; the PORT
    // does (11 §2.5, "protect paired state"): `checkNestedReference` (funcsem.ts) still walls on the
    // walk below, and a throw out of this region would skip the `pop()` that folds the pushed scope's
    // ctorflow into the enclosing one (dmd/dscope.d:302 — `extern (D) Scope* pop()`). D's
    // `sc = sc.pop()` consumes the release's return at region end, so the capture-in-finally form
    // applies. On the non-throwing path the statements are D's, in D's order.
    let r: boolean;
    sc = sc.push();
    try {
        sc.parent = fld; // set current function to be the delegate
        r = lambdaCheckForNestedRef(e, sc);
    } finally {
        sc = sc.pop()!; // non-null: paired with sc.push() above
    }
    if (r)
        return ErrorExp.get();

    let s: Statement;
    if (t.ty === Tvoid)
        s = new ExpStatement(loc, e);
    else
        s = new ReturnStatement(loc, e);
    fld.fbody = s;
    e = new FuncExp(loc, fld);
    e = expressionSemantic(e, sc);
    return e;
}

/******************************************
 * dmd/delegatize.d:86 — `private void lambdaSetParent(Expression e, FuncDeclaration fd)`.
 *
 * Patch the parent of declarations to be the new function literal.
 *
 * Since the expression is going to be moved into a function literal,
 * the parent for declarations in the expression needs to be
 * reset to that function literal.
 * Params:
 *   e = expression to check
 *   fd = function literal symbol (the new parent)
 *
 * D `private` at module scope: not exported (01 §2.5). Its one caller is `toDelegate` above.
 */
function lambdaSetParent(e: Expression, fd: FuncDeclaration): void {
    // delegatize.d:88 — `extern (C++) final class LambdaSetParent : StoppableVisitor`. Nested in D
    // and nested here (file header).
    // dropped: alias visit = super.visit — no overload hiding in TS (delegatize.d:90)
    class LambdaSetParent extends StoppableVisitor {
        fd: FuncDeclaration;

        // delegatize.d:93 — `private void setParent(Dsymbol s)`. D `private` in a nested class is
        // module-scoped, but nothing outside the class touches it, so TS `private` is faithful.
        private setParent(s: Dsymbol): void {
            const vd: VarDeclaration | null = s.isVarDeclaration();
            const pfd: FuncDeclaration | null = s.parent !== null ? s.parent.isFuncDeclaration() : null;
            s.parent = this.fd;
            if (vd === null || pfd === null)
                return;
            // move to fd's closure when applicable
            // `foreach (i; 0 .. pfd.closureVars.length)`: the bound is read once at entry (06 §1.3);
            // the body `break`s right after the only mutation, so the live read is equivalent.
            for (let i = 0; i < pfd.closureVars.length; i++) {
                if (vd === pfd.closureVars.opIndex(i)) {
                    pfd.closureVars.remove(i);
                    this.fd.closureVars.push(vd);
                    break;
                }
            }
        }

        // delegatize.d:113 — `extern (D) this(FuncDeclaration fd) scope @safe`.
        constructor(fd: FuncDeclaration) {
            super();
            this.fd = fd;
        }

        // delegatize.d:118 — `override void visit(Expression)`.
        override visitExpression(_e: Expression): void {
        }

        // delegatize.d:122 — `override void visit(DeclarationExp e)`.
        override visitDeclarationExp(e: DeclarationExp): void {
            // `e.declaration!` (twice): D dereferences the field unconditionally (02 §10.1).
            this.setParent(e.declaration!);
            e.declaration!.accept(this);
        }

        // delegatize.d:128 — `override void visit(IndexExp e)`.
        override visitIndexExp(e: IndexExp): void {
            if (e.lengthVar !== null) {
                //printf("lengthVar\n");
                this.setParent(e.lengthVar);
                e.lengthVar.accept(this);
            }
        }

        // delegatize.d:138 — `override void visit(SliceExp e)`.
        override visitSliceExp(e: SliceExp): void {
            if (e.lengthVar !== null) {
                //printf("lengthVar\n");
                this.setParent(e.lengthVar);
                e.lengthVar.accept(this);
            }
        }

        // delegatize.d:148 — `override void visit(Dsymbol)`.
        override visitDsymbol(_s: Dsymbol): void {
        }

        // delegatize.d:152 — `override void visit(VarDeclaration v)`.
        override visitVarDeclaration(v: VarDeclaration): void {
            if (v._init !== null)
                v._init.accept(this);
        }

        // delegatize.d:158 — `override void visit(Initializer)`.
        override visitInitializer(_i: Initializer): void {
        }

        // delegatize.d:162 — `override void visit(ExpInitializer ei)`. `ei.exp!`: D passes the field
        // straight to `walkPostorder`, which dereferences it — the `!` marks D's own fault point.
        override visitExpInitializer(ei: ExpInitializer): void {
            walkPostorder(ei.exp!, this);
        }

        // delegatize.d:167 — `override void visit(StructInitializer si)`. `foreach (i, const id;
        // si.field)` over an `Array!T` value takes the element view (06 §1.9); `id` is unused in D
        // and is not bound here (noUnusedLocals).
        override visitStructInitializer(si: StructInitializer): void {
            for (const [i] of si.field.opSlice().entries()) {
                const iz = si.value.opIndex(i);
                if (iz !== null)
                    iz.accept(this);
            }
        }

        // delegatize.d:174 — `override void visit(ArrayInitializer ai)`.
        override visitArrayInitializer(ai: ArrayInitializer): void {
            for (const [i, ex] of ai.index.opSlice().entries()) {
                if (ex !== null)
                    walkPostorder(ex, this);
                const iz = ai.value.opIndex(i);
                if (iz !== null)
                    iz.accept(this);
            }
        }

        // delegatize.d:184 — `override void visit(AssocArrayLiteralExp e)`.
        override visitAssocArrayLiteralExp(e: AssocArrayLiteralExp): void {
            if (e.lowering !== null)
                walkPostorder(e.lowering, this);
        }
    }

    const lsp = new LambdaSetParent(fd);
    walkPostorder(e, lsp);
}

/*******************************************
 * dmd/delegatize.d:205 — `bool lambdaCheckForNestedRef(Expression e, Scope* sc)`.
 *
 * Look for references to variables in a scope enclosing the new function literal.
 *
 * Essentially just calls `checkNestedReference() for each variable reference in `e`.
 * Params:
 *      sc = context
 *      e = expression to check
 * Returns:
 *      true if error occurs.
 *
 * The verdict is the one recorded by the LAST variable-bearing node in postorder (file header,
 * FAITHFUL QUIRK): the walk never stops early, and each visit overwrites `result`.
 */
export function lambdaCheckForNestedRef(e: Expression, sc: Scope): boolean {
    // delegatize.d:207 — `extern (C++) final class LambdaCheckForNestedRef : StoppableVisitor`.
    // dropped: alias visit = super.visit — no overload hiding in TS (delegatize.d:209)
    class LambdaCheckForNestedRef extends StoppableVisitor {
        sc: Scope;
        result: boolean = false;

        // delegatize.d:214 — `extern (D) this(Scope* sc) scope @safe`.
        constructor(sc: Scope) {
            super();
            this.sc = sc;
        }

        // delegatize.d:219 — `override void visit(Expression)`.
        override visitExpression(_e: Expression): void {
        }

        // delegatize.d:223 — `override void visit(SymOffExp e)`.
        override visitSymOffExp(e: SymOffExp): void {
            const v = e.var_.isVarDeclaration();
            if (v !== null)
                this.result = checkNestedReference(v, this.sc, Loc.initial);
        }

        // delegatize.d:229 — `override void visit(VarExp e)`.
        override visitVarExp(e: VarExp): void {
            const v = e.var_.isVarDeclaration();
            if (v !== null)
                this.result = checkNestedReference(v, this.sc, Loc.initial);
        }

        // delegatize.d:235 — `override void visit(ThisExp e)`.
        override visitThisExp(e: ThisExp): void {
            if (e.var_ !== null)
                this.result = checkNestedReference(e.var_, this.sc, Loc.initial);
        }

        // delegatize.d:241 — `override void visit(DeclarationExp e)`.
        override visitDeclarationExp(e: DeclarationExp): void {
            const v = e.declaration!.isVarDeclaration(); // D dereferences unconditionally
            if (v !== null) {
                this.result = checkNestedReference(v, this.sc, Loc.initial);
                if (this.result)
                    return;
                /* Some expressions cause the frontend to create a temporary.
                 * For example, structs with cpctors replace the original
                 * expression e with:
                 *  __cpcttmp = __cpcttmp.cpctor(e);
                 *
                 * In this instance, we need to ensure that the original
                 * expression e does not have any nested references by
                 * checking the declaration initializer too.
                 */
                if (v._init !== null && v._init.isExpInitializer() !== null) {
                    // `ie!`: for an ExpInitializer with no `itype`, `initializerToExpression` returns
                    // its `exp` (dmd/initsem.d:1562 — `Expression visitExp(ExpInitializer i)`, the
                    // `return i.exp;` at :1580); D hands it to the recursive walk, which dereferences
                    // it — the `!` marks D's own fault point.
                    const ie = initializerToExpression(v._init);
                    this.result = lambdaCheckForNestedRef(ie!, this.sc);
                }
            }
        }
    }

    const v = new LambdaCheckForNestedRef(sc);
    walkPostorder(e, v);
    return v.result;
}

/*****************************************
 * dmd/delegatize.d:284 — `bool ensureStaticLinkTo(Dsymbol s, Dsymbol p)`.
 *
 * See if context `s` is nested within context `p`, meaning
 * it `p` is reachable at runtime by walking the static links.
 * If any of the intervening contexts are function literals,
 * make sure they are delegates.
 * Params:
 *      s = inner context
 *      p = outer context
 * Returns:
 *      true means it is accessible by walking the context pointers at runtime
 * References:
 *      for static links see https://en.wikipedia.org/wiki/Call_stack#Functions_of_the_call_stack
 *
 * Side effect: every `FuncLiteralDeclaration` passed on the way up — including one where the walk
 * then fails — has its `tok` set to `TOK.delegate_` (issue 15332). Walking stops (false) at a
 * function that is neither a member nor nested, and at a `static` aggregate.
 *
 * Nullability (02 §10.1): `s` is null-tested by the loop, so `s: Dsymbol | null`, reassigned in place
 * as D does. `p` is only identity-compared and forwarded to `toParentP`'s nullable `p1`, never
 * dereferenced here, so it is `Dsymbol | null` too. A null `p` is NOT a free "walk to the root":
 * `toParentP` -> `followInstantiationContext` asserts `p1` as soon as the symbol being stepped over
 * has a dual context (dmd/dsymbolsem.d:6645 — `assert(p1);`, after the `has2This` early-out at
 * :6642-6643). Contract: `p` may be null only when no symbol on the walk has a dual context; then the
 * walk runs to the root (or a break) and answers false, as in D.
 */
export function ensureStaticLinkTo(s: Dsymbol | null, p: Dsymbol | null): boolean {
    while (s !== null) {
        if (s === p) // hit!
            return true;

        const fd = s.isFuncDeclaration();
        if (fd !== null) {
            if (fd.isThis() === null && !fd.isNested())
                break;

            // https://issues.dlang.org/show_bug.cgi?id=15332
            // change to delegate if fd is actually nested.
            const fld = fd.isFuncLiteralDeclaration();
            if (fld !== null)
                fld.tok = TOK.delegate_;
        }
        const ad = s.isAggregateDeclaration();
        if (ad !== null) {
            if ((ad.storage_class & STC.static_) !== 0n)
                break;
        }
        s = toParentP(s, p);
    }
    return false;
}
