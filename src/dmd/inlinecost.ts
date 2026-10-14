// Ported from dmd/inlinecost.d (module dmd.inlinecost).
//
// "Compute the cost of inlining a function call by counting expressions."
//
// Top-level D declarations, in source order: `COST_MAX` (:41), the private `STATEMENT_COST` (:43)
// and `STATEMENT_COST_MAX` (:44), two `static assert`s (:47-48), `tooCostly` (:57),
// `inlineCostExpression` (:69), `inlineCostFunction` (:85), `isInlinableNestedAggregate` (:103) and,
// after `private:` (:140), the `InlineCostVisitor` class (:148) with its method-nested
// `LambdaInlineCost` class (:337). No unittest blocks, no `goto`, no structs, no unions.
//
// LIVENESS (ldc2 1.43.0). LDC's driver never runs dmd's inline scan (dmd/main.d:771-797 is
// `version (IN_LLVM) extraLDCSpecificSemanticAnalysis(modules); else { …inlineScan… }`, and
// driver/main.cpp calls neither scan), so the only LIVE consumer of this module is
// `inline.d`'s `inlineCopy` (inline.d:92), reached from the default-argument leg of
// `functionParameters` (expressionsem.d:4253): `inlineCostExpression` is live on every call that
// supplies a default argument. `inlineCostFunction` is reached only from `canInline`
// (inline.d:2152, :2177), i.e. from the dead scan; it is translated in full all the same (1:1 rule).
//
// VISITOR IDIOM (13-visitor.md): Idiom A. `InlineCostVisitor : Visitor` and
// `LambdaInlineCost : StoppableVisitor` are real classes; every `visit(X)` overload becomes the
// named slot `visitX` (§1) and both `alias visit = …` lines (:150, :339) are dropped (§1).
// Intra-visitor forwards bind by the argument's static type (§4).
//
// CONSTRUCTOR OVERLOAD (04 §1 Form B). `InlineCostVisitor` has `this(bool callerCopy, bool hasThis)`
// (:163) and the copy constructor `this(InlineCostVisitor icv)` (:169): different arities that are
// NOT prefix forms of one body, so arity dispatch does not apply. The two-`bool` form keeps the TS
// `constructor`; the copy form is the static factory `InlineCostVisitor.fromInlineCostVisitor`
// (rule 3, `<name>From<DistinguishingType>`, precedent `AttributeViolation.fromFormatScopeVar`).
//
// VERSION RESOLUTION (07 §1.3): the one `version (IN_LLVM)` site, `visit(CallExp)` (:495), takes
// the IN_LLVM arm (`cost++`, "in LDC, we only use the inliner for default arguments"); the three
// `else` legs (the super-call and `__alloca` checks) are dropped at the site (:497-505).
//
// DEFERRED CALLEES: none. This module carries no wall.

import { STC } from "./astenums.js";
import type { AggregateDeclaration } from "./aggregate.js";
import type { AttribDeclaration } from "./attrib.js";
import type { StructDeclaration, UnionDeclaration } from "./dstruct.js";
import type {
    CompoundStatement,
    ExpStatement,
    ForStatement,
    IfStatement,
    ImportStatement,
    ReturnStatement,
    ScopeStatement,
    Statement,
    ThrowStatement,
    UnrolledLoopStatement,
} from "./statement.js";
import type {
    CallExp,
    DeclarationExp,
    DelegateExp,
    Expression,
    FuncExp,
    NewExp,
    StructLiteralExp,
    ThisExp,
    VarExp,
} from "./expression.js";
import type { FuncDeclaration } from "./func.js";
import type { Type } from "./mtype.js";
// Value imports, LAST (01 §4.8): `Visitor`/`StoppableVisitor` are `extends` operands evaluated at
// module load (InlineCostVisitor is module-level, as in D); the rest are read only inside bodies.
import { StoppableVisitor, Visitor } from "./visitor/index.js";
import { walkPostorder } from "./visitor/postorder.js";
import { toAlias } from "./dsymbolsem.js";
import { isAggregate, toBasetype } from "./typesem.js";

/// dmd/inlinecost.d:41 — `enum COST_MAX = 250;`
export const COST_MAX = 250;

/// dmd/inlinecost.d:43 — `private enum STATEMENT_COST = 0x1000;`
const STATEMENT_COST = 0x1000;
/// dmd/inlinecost.d:44 — `private enum STATEMENT_COST_MAX = 250 * STATEMENT_COST;`
const STATEMENT_COST_MAX = 250 * STATEMENT_COST;
void STATEMENT_COST_MAX; // no D readers; kept for 1:1 fidelity (04 §5)

// resolved: static assert((STATEMENT_COST & (STATEMENT_COST - 1)) == 0) -> true (0x1000 is a power
// of 2) — dmd/inlinecost.d:47; emits nothing (07 §7.2)
// resolved: static assert(STATEMENT_COST > COST_MAX) -> true (4096 > 250) — dmd/inlinecost.d:48

/**
 * dmd/inlinecost.d:57 — `bool tooCostly(int cost) pure nothrow @safe`.
 * Determine if too expensive to inline.
 *
 * The cost word packs two counters: the low 12 bits (below `STATEMENT_COST`) count expression
 * cost, the bits above count loop statements. Only the expression part is compared to `COST_MAX`,
 * so a cost of `COST_MAX + STATEMENT_COST` is too costly while `STATEMENT_COST` alone is not.
 * `cost` is a D `int`; every producer adds small positive integers, so number arithmetic is exact.
 * Returns: true if too costly.
 */
export function tooCostly(cost: number): boolean {
    return (cost & (STATEMENT_COST - 1)) >= COST_MAX;
}

/**
 * dmd/inlinecost.d:69 — `int inlineCostExpression(Expression e)`.
 * Determine cost of inlining Expression `e`, walking it in postorder with `callerCopy = true`
 * (the expression is a default argument, copied at the call site) and `hasThis = false`.
 * Live under LDC: `inlineCopy` (inline.d:92) calls it for every default argument.
 * Returns: the cost; `>= COST_MAX` means `e` cannot be inline-copied.
 */
export function inlineCostExpression(e: Expression): number {
    const icv = new InlineCostVisitor(true, false); // `scope` erased (03 §3.4)
    icv.expressionInlineCost(e);
    return icv.cost;
}

/**
 * dmd/inlinecost.d:85 — `int inlineCostFunction(FuncDeclaration fd, bool hasThis)`.
 * Determine cost of inlining function `fd`, whose body must be non-null.
 * `hasThis`: whether the caller can access the callee's this pointer.
 * Returns: the cost of inlining `fd` (compare with `tooCostly`).
 */
export function inlineCostFunction(fd: FuncDeclaration, hasThis: boolean): number {
    const icv = new InlineCostVisitor(false, hasThis);
    fd.fbody!.accept(icv);
    return icv.cost;
}

/**
 * dmd/inlinecost.d:103 — `AggregateDeclaration isInlinableNestedAggregate(DeclarationExp e)`.
 *
 * Indicates if a nested aggregate prevents or not a function to be inlined.
 * It's used to compute the cost but also to avoid a copy of the aggregate
 * while the inliner processes.
 *
 * Returns: `null` if `e` is not an aggregate or if it is an aggregate that
 *      doesn't permit inlining, and the aggregate otherwise.
 */
export function isInlinableNestedAggregate(e: DeclarationExp): AggregateDeclaration | null {
    let result: AggregateDeclaration | null;
    if (e.declaration!.isAnonymous() && e.declaration!.isAttribDeclaration()) {
        const ad: AttribDeclaration = e.declaration!.isAttribDeclaration()!;
        if (ad.decl!.length === 1) {
            if ((result = ad.decl!.opIndex(0)!.isAggregateDeclaration()) !== null) {
                // classes would have to be destroyed
                const cdecl = result.isClassDeclaration();
                if (cdecl !== null)
                    return null;
                // if it's a struct: must not have dtor
                const sdecl: StructDeclaration | null = result.isStructDeclaration();
                if (sdecl !== null && (sdecl.fieldDtor !== null || sdecl.dtor !== null))
                    return null;
                // the aggregate must be static
                const udecl: UnionDeclaration | null = result.isUnionDeclaration();
                if ((sdecl !== null || udecl !== null) && (result.storage_class & STC.static_) === 0n)
                    return null;

                return result;
            }
        }
    // `as unknown as AggregateDeclaration` (both arms below): cascade of the audited `deferred` field
    // shadow (AggregateDeclaration.deferred: Dsymbol hides Dsymbol.deferred: bool, aggregate.ts), which
    // blocks structural subtyping of `StructDeclaration : AggregateDeclaration`. Same spelling as
    // access.ts. NOT a semantic cast — a struct/union declaration IS an AggregateDeclaration.
    } else if ((result = e.declaration!.isStructDeclaration() as unknown as AggregateDeclaration | null) !== null) {
        return result;
    } else if ((result = e.declaration!.isUnionDeclaration() as unknown as AggregateDeclaration | null) !== null) {
        return result;
    }
    return null;
}

// inlinecost.d:140 `private:` — the visitor below is module-private; it is not exported.

/**
 * dmd/inlinecost.d:148 — `extern (C++) final class InlineCostVisitor : Visitor`.
 *
 * Compute cost of inlining.
 *
 * Walk trees to determine if inlining can be done, and if so,
 * if it is too complex to be worth inlining or not.
 *
 * Contract: `cost` starts at 0 and only grows (or is pinned to `COST_MAX` by a node the inliner
 * cannot copy); `nested` counts enclosing `if`/`for` bodies, inside which a `return` is fatal.
 */
class InlineCostVisitor extends Visitor {
    // dropped: alias visit = Visitor.visit — no overload hiding in TS (13 §1)

    // if the expression being visited is a default argument, which is
    // specified to be copied at call site and can contain more types of
    // expression (like alloca) than regular inlining
    readonly callerCopy: boolean;

    // if the caller can access the callee's this pointer
    readonly hasThis: boolean;

    nested = 0;  // int
    cost = 0;    // int — zero start for subsequent AST

    /// dmd/inlinecost.d:163 — `extern (D) this(bool callerCopy, bool hasThis) scope @safe`.
    constructor(callerCopy: boolean, hasThis: boolean) {
        super();
        this.callerCopy = callerCopy;
        this.hasThis = hasThis;
    }

    /// dmd/inlinecost.d:169 — `extern (D) this(InlineCostVisitor icv) scope @safe`: copies
    /// `nested`, `callerCopy` and `hasThis`; `cost` restarts at 0. Form B factory (file header).
    static fromInlineCostVisitor(icv: InlineCostVisitor): InlineCostVisitor {
        const v = new InlineCostVisitor(icv.callerCopy, icv.hasThis);
        v.nested = icv.nested;
        return v;
    }

    override visitStatement(_s: Statement): void {
        this.cost += COST_MAX; // default is we can't inline it
    }

    override visitExpStatement(s: ExpStatement): void {
        this.expressionInlineCost(s.exp);
    }

    override visitCompoundStatement(s: CompoundStatement): void {
        const icv = InlineCostVisitor.fromInlineCostVisitor(this);
        for (let i = 0; i < s.statements!.length; i++) {
            const s2 = s.statements!.opIndex(i);
            if (s2 !== null) {
                /* Specifically allow:
                 *  if (condition)
                 *      return exp1;
                 *  return exp2;
                 */
                let ifs: IfStatement | null;
                let s3: Statement | null;
                if ((ifs = s2.isIfStatement()) !== null &&
                    ifs.ifbody !== null &&
                    ifs.ifbody.endsWithReturnStatement() !== null &&
                    ifs.elsebody === null &&
                    i + 1 < s.statements!.length &&
                    (s3 = s.statements!.opIndex(i + 1)) !== null &&
                    s3.endsWithReturnStatement() !== null
                ) {
                    if (ifs.param !== null) { // if variables are declared
                        this.cost = COST_MAX;
                        return;
                    }
                    this.expressionInlineCost(ifs.condition);
                    ifs.ifbody.accept(this);
                    s3.accept(this);
                } else
                    s2.accept(icv);
                if (tooCostly(icv.cost))
                    break;
            }
        }
        this.cost += icv.cost;
    }

    override visitUnrolledLoopStatement(s: UnrolledLoopStatement): void {
        const icv = InlineCostVisitor.fromInlineCostVisitor(this);
        for (const s2 of s.statements!) {
            if (s2 !== null) {
                s2.accept(icv);
                if (tooCostly(icv.cost))
                    break;
            }
        }
        this.cost += icv.cost;
    }

    override visitScopeStatement(s: ScopeStatement): void {
        this.cost++;
        if (s.statement !== null)
            s.statement.accept(this);
    }

    override visitIfStatement(s: IfStatement): void {
        /* Can't declare variables inside ?: expressions, so
         * we cannot inline if a variable is declared.
         */
        if (s.param !== null) {
            this.cost = COST_MAX;
            return;
        }
        this.expressionInlineCost(s.condition);

        /* Specifically allow:
         *  if (condition)
         *      return exp1;
         *  else
         *      return exp2;
         * Otherwise, we can't handle return statements nested in if's.
         */
        if (s.elsebody !== null && s.ifbody !== null && s.ifbody.endsWithReturnStatement() !== null &&
            s.elsebody.endsWithReturnStatement() !== null) {
            s.ifbody.accept(this);
            s.elsebody.accept(this);
        } else {
            this.nested += 1;
            if (s.ifbody !== null)
                s.ifbody.accept(this);
            if (s.elsebody !== null)
                s.elsebody.accept(this);
            this.nested -= 1;
        }
    }

    override visitReturnStatement(s: ReturnStatement): void {
        // Can't handle return statements nested in if's
        if (this.nested) {
            this.cost = COST_MAX;
        } else {
            this.expressionInlineCost(s.exp);
        }
    }

    override visitImportStatement(_s: ImportStatement): void {
    }

    override visitForStatement(s: ForStatement): void {
        this.cost += STATEMENT_COST;
        if (s._init !== null)
            s._init.accept(this);
        if (s.condition !== null)
            s.condition.accept(this);
        if (s.increment !== null)
            s.increment.accept(this);
        if (s._body !== null) {
            this.nested += 1;
            s._body.accept(this);
            this.nested -= 1;
        }
    }

    override visitThrowStatement(s: ThrowStatement): void {
        this.cost++;
        this.expressionInlineCost(s.exp);
    }

    /* -------------------------- */
    /// dmd/inlinecost.d:331 — `void expressionInlineCost(Expression e)`: adds the postorder cost
    /// of `e` (a null `e` costs nothing); the walk stops as soon as the running cost reaches
    /// `COST_MAX`.
    expressionInlineCost(e: Expression | null): void {
        if (e !== null) {
            // inlinecost.d:337 — `extern (C++) final class LambdaInlineCost : StoppableVisitor`,
            // nested in D and nested here. `alias visit = typeof(super).visit;` (:339) dropped (13 §1).
            class LambdaInlineCost extends StoppableVisitor {
                icv: InlineCostVisitor;

                /// inlinecost.d:343 — `extern (D) this(InlineCostVisitor icv) @safe`.
                constructor(icv: InlineCostVisitor) {
                    super();
                    this.icv = icv;
                }

                override visitExpression(e: Expression): void {
                    e.accept(this.icv);
                    this.stop = this.icv.cost >= COST_MAX;
                }
            }

            const icv = InlineCostVisitor.fromInlineCostVisitor(this);
            const lic = new LambdaInlineCost(icv);
            walkPostorder(e, lic);
            this.cost += icv.cost;
        }
    }

    override visitExpression(_e: Expression): void {
        this.cost++;
    }

    override visitVarExp(e: VarExp): void {
        const tb: Type = toBasetype(e.type!);
        const ts = tb.isTypeStruct();
        if (ts !== null) {
            const sd: StructDeclaration = ts.sym!;
            if (sd.isNested()) {
                /* An inner struct will be nested inside another function hierarchy than where
                 * we're inlining into, so don't inline it.
                 * At least not until we figure out how to 'move' the struct to be nested
                 * locally. Example:
                 *   struct S(alias pred) { void unused_func(); }
                 *   void abc() { int w; S!(w) m; }
                 *   void bar() { abc(); }
                 */
                this.cost = COST_MAX;
                return;
            }
        }
        const fd: FuncDeclaration | null = e.var_.isFuncDeclaration();
        if (fd !== null && fd.isNested()) // https://issues.dlang.org/show_bug.cgi?id=7199 for test case
            this.cost = COST_MAX;
        else
            this.cost++;
    }

    override visitThisExp(_e: ThisExp): void {
        if (!this.hasThis) {
            this.cost = COST_MAX;
            return;
        }
        this.cost++;
    }

    override visitStructLiteralExp(e: StructLiteralExp): void {
        if (e.sd!.isNested())
            this.cost = COST_MAX;
        else
            this.cost++;
    }

    override visitNewExp(e: NewExp): void {
        const ad: AggregateDeclaration | null = isAggregate(e.newtype!);
        if (ad !== null && ad.isNested() || e.placement !== null)
            this.cost = COST_MAX;
        else
            this.cost++;
    }

    override visitFuncExp(_e: FuncExp): void {
        // Right now, this makes the function be output to the .obj file twice.
        this.cost = COST_MAX;
    }

    override visitDelegateExp(_e: DelegateExp): void {
        this.cost = COST_MAX;
    }

    override visitDeclarationExp(e: DeclarationExp): void {
        const vd = e.declaration!.isVarDeclaration();
        if (vd !== null) {
            const td = toAlias(vd).isTupleDeclaration();
            if (td !== null) {
                this.cost = COST_MAX; // finish DeclarationExp.doInlineAs
                return;
            }
            if (!this.callerCopy && vd.isDataseg()) {
                this.cost = COST_MAX;
                return;
            }
            if (vd.edtor !== null) {
                // if destructor required
                // needs work to make this work
                this.cost = COST_MAX;
                return;
            }
            // Scan initializer (vd.init)
            if (vd._init !== null) {
                const ie = vd._init.isExpInitializer();
                if (ie !== null) {
                    this.expressionInlineCost(ie.exp);
                }
            }
            ++this.cost;
        }

        // aggregates are accepted under certain circumstances
        if (isInlinableNestedAggregate(e) !== null) {
            this.cost++;
            return;
        }

        // These can contain functions, which when copied, get output twice.
        if (e.declaration!.isStructDeclaration() !== null ||
            e.declaration!.isClassDeclaration() !== null ||
            e.declaration!.isFuncDeclaration() !== null ||
            e.declaration!.isAttribDeclaration() !== null ||
            e.declaration!.isTemplateMixin() !== null) {
            this.cost = COST_MAX;
            return;
        }
    }

    override visitCallExp(_e: CallExp): void {
        // in LDC, we only use the inliner for default arguments
        // resolved: version (IN_LLVM) -> true (LDC) — dmd/inlinecost.d:495
        this.cost++;
        // dropped: !IN_LLVM else-legs — the super.func() devirtualization check and the
        // `__alloca` stack-overflow check (dmd/inlinecost.d:497-505)
    }
}
