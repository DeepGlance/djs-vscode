// Ported from dmd/nogc.d (module dmd.nogc).
//
// Checks that a function marked `@nogc` does not invoke the Garbage Collector.
//
// VISITOR IDIOM (13-visitor.md): `NOGCVisitor` is IDIOM A — a real `extern(C++) final class
// NOGCVisitor : StoppableVisitor` (nogc.d:51). Each `void visit(X)` overload becomes the named slot
// `visit` + X (§1); the `alias visit = typeof(super).visit;` (nogc.d:53) is DROPPED (§1). Dispatch
// arrives through each node's own `accept` (§2), which `walkPostorder` drives — so this file has NO
// dispatch switch of its own to emit and NOTHING is flattened (§4.1 does not apply: the class is
// preserved, not replaced by a hand-rolled descent).
//
// UFCS (04 §6): nogc.d reaches four of its OWN module-level functions through UFCS —
// `sc.setGC(...)` (nogc.d:124/:199/:389), `f.printGCUsage(...)` (eight sites), `fd.isNogc()`
// (nogc.d:199/:391/:420) and `sc.func.isNogcBypassingInference()` (nogc.d:360). All four resolve to
// the free functions at the bottom of THIS module, so each becomes a plain call with the receiver as
// first argument. NOTE the deliberate name overlap D relies on: the private METHOD
// `NOGCVisitor.setGC(Expression, const(char)*)` (nogc.d:115) and the module-level
// `setGC(Scope*, FuncDeclaration, Loc, const(char)*, RootObject[]...)` (nogc.d:349) are different
// functions. Inside the class, `this.setGC(...)` is the method and bare `setGC(...)` is the
// module-level one — the same split D gets from member-vs-UFCS lookup.
//
// DEFERRED CALLEES: none — the three wave-4 walls are SWEPT, both callees having landed with the D
// signature verbatim:
//   - `walkPostorder` — dmd/visitor/postorder.d:20 `bool walkPostorder(Expression e, StoppableVisitor v)`,
//     ported in `src/dmd/visitor/postorder.ts`. Authorises the calls at nogc.d:70 (`doCond`) and
//     nogc.d:283 (`checkGC`); the §2 record that reported nogc.d:283 as a darkened module entry point
//     is thereby closed.
//   - `checkArrayLiteralEscape` — dmd/escape.d:246 `bool checkArrayLiteralEscape(ref Scope sc,
//     ArrayLiteralExp ae, bool gag)`, exported by `src/dmd/escape.ts`. Authorises the call at
//     nogc.d:158; D's `*sc` deref of its `Scope*` is the plain `this.sc` here, the `ref Scope`
//     parameter being a reference either way.
// This file therefore carries NO wall: it adds no exit path D does not have, so the §2.5 paired-state
// shapes have nothing to protect (it acquires no releasable state anyway — no gagging, no counter, no
// push/pop), and `e.gcPassDone = true` (nogc.d:284) is now reached on every path D reaches it on.

import { STC, Taarray } from "./astenums.js";
import { PASS } from "./dsymbol.js";
import { isDsymbol } from "./dtemplate.js";
import { error, fTuple, message } from "./errors.js";
import { ErrorExp } from "./expression.js";
import { lowerArrayLiteral } from "./expressionsem.js";
import { AttributeViolation } from "./func.js";
import { isRootTraitsCompilesScope } from "./funcsem.js";
import { global } from "./globals.js";
import { Id } from "./id.js";
import { Loc } from "./location.js";
import { semantic2 } from "./semantic2.js";
import { semantic3 } from "./semantic3.js";
import { EXP } from "./tokens.js";
import { toBasetype } from "./typesem.js";
import { StoppableVisitor } from "./visitor/index.js";
import { assert, assertUnreachable } from "../assert.js";
import { ds } from "../dstring.js";
// last: 01 §4.8 — both are value imports into the sema half of the core SCC, and their alphabetical
// position would put `escape.js` ahead of the AST-node module `expression.js`, making this module the
// entry of escape → expression → declaration. Last position keeps the existing entry (astenums.js).
import { checkArrayLiteralEscape } from "./escape.js";
import { walkPostorder } from "./visitor/postorder.js";

import type { AttribDeclaration } from "./attrib.js";
import type { VarDeclaration } from "./declaration.js";
import type { Module } from "./dmodule.js";
import type { Scope } from "./dscope.js";
import type { Dsymbol } from "./dsymbol.js";
import type {
    ArrayLiteralExp, AssignExp, AssocArrayLiteralExp, CallExp, CatAssignExp, CatExp,
    DeclarationExp, DeleteExp, Expression, IndexExp, NewExp, VarExp,
} from "./expression.js";
import type { FuncDeclaration } from "./func.js";
import type { ExpInitializer } from "./init.js";
import type { Type } from "./mtype.js";
import type { RootObject } from "./rootobject.js";
import type { DString } from "../dstring.js";

// dropped: import core.stdc.stdio (nogc.d:16) and its function-local twin (nogc.d:136) — `printf`
//          appears only inside the commented-out trace lines (nogc.d:270, :351, :412).
// dropped: import dmd.aggregate (nogc.d:18) — no symbol of it is named in this file.
// dropped: import dmd.arraytypes (nogc.d:19) — `Expressions`/`Dsymbols` are only read off node
//          fields here, never named as types.
// dropped: import dmd.common.outbuffer (nogc.d:22) — the `OutBuffer` the AttributeViolation format
//          ctor uses is internal to func.ts.
// dropped: import dmd.identifier (nogc.d:36) — `fd.ident` is only compared against `Id.*`.
// dropped: DYNCAST of `import dmd.rootobject : RootObject, DYNCAST` (nogc.d:40) — unused; the tag
//          test lives inside dtemplate's `isDsymbol`.
// dropped: `unqualify` of `import dmd.typesem : unqualify, toBasetype` (nogc.d:44) — unused.

/**************************************
 * Look for GC-allocations
 *
 * dmd/nogc.d:51 — `extern (C++) final class NOGCVisitor : StoppableVisitor`. Driven by
 * `walkPostorder` over an expression tree; every node that may allocate with the GC either reports a
 * `@nogc` violation (`setGC`) or records the usage for `-vgc` (`printGCUsage`).
 *
 * Preconditions: `f` is the function the expression lives in; `sc` is the scope the GC action is in
 * (both non-null — `checkGC` filters `!sc.func` before constructing).
 * Postconditions: `err` is set iff a violation was reported (or `checkOnly` short-circuited one).
 */
export class NOGCVisitor extends StoppableVisitor {
    // dropped: alias visit = typeof(super).visit — no overload hiding in TS (13 §1)
    // nogc.d:54 `public:` — TS default visibility is public, so the label itself has no analogue.
    f: FuncDeclaration;
    sc: Scope;
    checkOnly = false; // don't print errors
    err = false;
    nogcExceptions = false; // -preview=dip1008 enabled

    /// nogc.d:61 — `extern (D) this(FuncDeclaration f, Scope* sc) scope @safe`. `scope`/`@safe` are
    /// erased (04 §8).
    constructor(f: FuncDeclaration, sc: Scope) {
        super();
        this.f = f;
        this.sc = sc;
    }

    /// nogc.d:67 — `void doCond(Expression exp)`. Walks `exp`'s subtree with this visitor.
    /// `Expression | null` is what 02 §10.1 mandates: the body NULL-TESTS the parameter
    /// (nogc.d:69 `if (exp)`), and its one D caller forwards `ei.exp`, itself nullable.
    doCond(exp: Expression | null): void {
        if (exp)
            // nogc.d:70 `walkPostorder(exp, this)` — swept: authorised by
            // dmd/visitor/postorder.d:20 `bool walkPostorder(Expression e, StoppableVisitor v)`.
            // D discards the `bool`, so the port discards it too.
            walkPostorder(exp, this);
    }

    /// nogc.d:73 — `override void visit(Expression e)`. A node contributes nothing by itself;
    /// `walkPostorder` still descends into it.
    override visitExpression(_e: Expression): void {
    }

    /// nogc.d:77 — `override void visit(DeclarationExp e)`.
    override visitDeclarationExp(e: DeclarationExp): void {
        // Note that, walkPostorder does not support DeclarationExp today.
        // nogc.d:80 — the nested `void visitDecl(Dsymbol d)`; an inner arrow per 04 §5, declared
        // before its one use, and self-recursive (nogc.d:101) so it needs the named-const form.
        // `d` is NON-NULL per 02 §10.1: the body dereferences it unconditionally (nogc.d:82), so the
        // two call sites carry the `!` — marking exactly the point D itself faults on a null member.
        const visitDecl = (d: Dsymbol): void => {
            const v: VarDeclaration | null = d.isVarDeclaration();
            if (v) {
                if ((v.storage_class & STC.manifest) === 0n && !v.isDataseg() && v._init && !v.isCsymbol()) {
                    const ei: ExpInitializer | null = v._init.isExpInitializer();
                    if (ei) {
                        this.doCond(ei.exp);
                    }
                }
            } else {
                const ad: AttribDeclaration | null = d.isAttribDeclaration();
                if (ad) {
                    // Don't recurse into anonymous declarations (unions/structs)
                    // as their members aren't meant to be processed here
                    if (ad.isAnonDeclaration())
                        return;
                    if (ad.decl) {
                        for (const s of ad.decl)
                            visitDecl(s!);
                    }
                }
            }
        };
        visitDecl(e.declaration!);
    }

    /**
     * Register that expression `e` requires the GC
     * Params:
     *   e = expression that uses GC
     *   msg = error message when `e` is used in a `@nogc` function.
     * Returns: `true` if `err` was set, `false` if it's not in a `@nogc` and not checkonly (-betterC)
     *
     * nogc.d:115 — `private bool setGC(Expression e, const(char)* msg)`. TS `private` is faithful
     * here: nothing outside the class touches it in nogc.d (01 §2.5 — no sibling function, no
     * unittest). Distinct from the module-level `setGC` below, which its body reaches by UFCS.
     */
    private setGC(e: Expression, msg: DString): boolean {
        if (this.sc.debug_)
            return false;
        if (this.checkOnly) {
            this.err = true;
            return true;
        }
        // nogc.d:124 `sc.setGC(f, e.loc, msg)` — UFCS onto the module-level setGC (nogc.d:349).
        if (setGC(this.sc, this.f, e.loc, msg)) {
            error(e.loc, ds("%s causes a GC allocation in `@nogc` %s `%s`"), msg, this.f.kind(), this.f.toChars());
            this.err = true;
            return true;
        }
        return false;
    }

    /// nogc.d:133 — `override void visit(CallExp e)`. A lowered `_d_arraysetlengthT` hook call is an
    /// array-`length` assignment in disguise.
    override visitCallExp(e: CallExp): void {
        // dropped: the function-local `import dmd.id : Id;` (nogc.d:135) — folded into the file's
        //          `Id` import; and `import core.stdc.stdio : printf;` (nogc.d:136) — unused.
        if (!e.f)
            return;

        // Treat lowered hook calls as their original expressions.
        const fd = stripHookTraceImpl(e.f);
        if (fd!.ident === Id._d_arraysetlengthT) {
            if (this.setGC(e, ds("setting this array's `length`")))
                return;
            // nogc.d:146 — UFCS onto the module-level printGCUsage (nogc.d:307).
            printGCUsage(this.f, e.loc, ds("setting `length` may cause a GC allocation"));
        }
    }

    /// nogc.d:150 — `override void visit(ArrayLiteralExp e)`.
    override visitArrayLiteralExp(e: ArrayLiteralExp): void {
        const dim: number = e.elements ? e.elements.length : 0;
        if (toBasetype(e.type!).isTypeSArray() !== null || dim === 0 || e.onstack)
            return;
        if (this.setGC(e, ds("this array literal")))
            return;

        // nogc.d:158 `checkArrayLiteralEscape(*sc, e, false)` — swept: authorised by
        // dmd/escape.d:246 `bool checkArrayLiteralEscape(ref Scope sc, ArrayLiteralExp ae, bool gag)`.
        // D's `*sc` dereferences its `Scope*` to hand the callee a `ref Scope`; both sides are a
        // reference in TS, so the argument is `this.sc` unchanged.
        if (checkArrayLiteralEscape(this.sc, e, false)) {
            this.err = true;
            return;
        }

        if (!global.params.useGC) {
            if (!this.checkOnly) {
                // resolved: version (IN_GCC) (nogc.d:168) -> false (_config.md §1; compiler identity
                // is LDC), so only the `else` arm (nogc.d:171) is emitted.
                error(e.loc, ds("this array literal requires the GC and cannot be used with `-betterC`"));
            }
            this.err = true;
            return;
        }

        // nogc.d:177 — expressionsem.d:5231 `Expression lowerArrayLiteral(ArrayLiteralExp ale, Scope* sc)`
        // returns a nullable Expression, so D's `!lowerArrayLiteral(e, sc)` is the null test.
        if (lowerArrayLiteral(e, this.sc) === null) {
            this.err = true;
            return;
        }

        printGCUsage(this.f, e.loc, ds("array literal may cause a GC allocation"));
    }

    /// nogc.d:186 — `override void visit(AssocArrayLiteralExp e)`.
    override visitAssocArrayLiteralExp(e: AssocArrayLiteralExp): void {
        if (!e.keys!.length)
            return;
        if (this.setGC(e, ds("this associative array literal")))
            return;
        printGCUsage(this.f, e.loc, ds("associative array literal may cause a GC allocation"));
    }

    /// nogc.d:195 — `override void visit(NewExp e)`.
    override visitNewExp(e: NewExp): void {
        if (e.placement)
            return;     // placement new doesn't use the GC
        // nogc.d:199 — `e.member.isNogc()` and `sc.setGC(...)` are both UFCS onto this module's own
        // free functions. `!is f` is reference identity (`!==`).
        if (e.member && e.member !== this.f && !isNogc(e.member) && setGC(this.sc, this.f, e.loc, null)) {
            // @nogc-ness is already checked in NewExp::semantic
            return;
        }
        if (e.onstack)
            return;
        if (this.nogcExceptions && e.thrownew)
            return;                     // separate allocator is called for this, not the GC

        if (this.setGC(e, ds("allocating with `new`")))
            return;
        printGCUsage(this.f, e.loc, ds("`new` causes a GC allocation"));
    }

    /// nogc.d:214 — `override void visit(DeleteExp e)`.
    override visitDeleteExp(e: DeleteExp): void {
        const ve: VarExp | null = e.e1!.isVarExp();
        if (ve) {
            const v: VarDeclaration | null = ve.var_.isVarDeclaration();
            if (v && v.onstack)
                return; // delete for scope allocated class object
        }

        // Semantic should have already handled this case.
        // nogc.d:224 `assert(0)` — faithful port, NOT a wall (11 §2.5 accounting rule).
        assertUnreachable();
    }

    /// nogc.d:227 — `override void visit(IndexExp e)`.
    override visitIndexExp(e: IndexExp): void {
        const t1b: Type = toBasetype(e.e1!.type!);
        if (e.modifiable && t1b.ty === Taarray) {
            if (this.setGC(e, ds("assigning this associative array element")))
                return;
            printGCUsage(this.f, e.loc, ds("assigning an associative array element may cause a GC allocation"));
        }
    }

    /// nogc.d:238 — `override void visit(AssignExp e)`.
    override visitAssignExp(e: AssignExp): void {
        if (e.e1!.op === EXP.arrayLength) {
            if (this.setGC(e, ds("setting this array's `length`")))
                return;
            printGCUsage(this.f, e.loc, ds("setting `length` may cause a GC allocation"));
        }
    }

    /// nogc.d:248 — `override void visit(CatAssignExp e)`.
    override visitCatAssignExp(e: CatAssignExp): void {
        if (this.checkOnly) {
            this.err = true;
            return;
        }
        if (this.setGC(e, ds("appending to this array with operator `~=`")))
            return;
        printGCUsage(this.f, e.loc, ds("operator `~=` may cause a GC allocation"));
    }

    /// nogc.d:260 — `override void visit(CatExp e)`.
    override visitCatExp(e: CatExp): void {
        if (this.setGC(e, ds("concatenating with operator `~`")))
            return;
        printGCUsage(this.f, e.loc, ds("operator `~` may cause a GC allocation"));
    }
}

/**
 * dmd/nogc.d:268 — `Expression checkGC(Expression e, Scope* sc)`. Runs the GC pass over `e` once,
 * reporting `@nogc` violations; returns `e` unchanged, or `ErrorExp.get()` when a violation was
 * reported outside `-betterC`.
 *
 * Preconditions: `e` is a semantically-analysed expression.
 * Postconditions: `e.gcPassDone` is set, so a second call is a no-op.
 * The `walkPostorder` call at nogc.d:283 sits on this function's UNCONDITIONAL path once the
 * early-outs at nogc.d:271 let the expression through; it was the wave-4 wall that darkened this
 * entry point and is now swept (dmd/visitor/postorder.d:20).
 */
export function checkGC(e: Expression, sc: Scope): Expression {
    // printf("%s checkGC(%s)\n", e.loc.toChars, e.toChars);
    if (e.gcPassDone || sc.ctfeBlock || sc.ctfe || sc.intypeof === 1 || !sc.func)
        return e;

    /* If betterC, allow GC to happen in non-CTFE code.
     * Just don't generate code for it.
     * Detect non-CTFE use of the GC in betterC code.
     */
    const betterC: boolean = !global.params.useGC;
    const f: FuncDeclaration = sc.func;
    // `scope NOGCVisitor gcv = new ...` — the `scope` storage class is erased (04 §8).
    const gcv: NOGCVisitor = new NOGCVisitor(f, sc);
    gcv.checkOnly = betterC && (f.type!.isTypeFunction()!.isNogc || f.nogcInprocess);
    gcv.nogcExceptions = sc.previews.dip1008;
    // nogc.d:283 `walkPostorder(e, gcv)` — swept: authorised by dmd/visitor/postorder.d:20
    // `bool walkPostorder(Expression e, StoppableVisitor v)`. D discards the `bool`.
    walkPostorder(e, gcv);
    e.gcPassDone = true;

    if (!gcv.err)
        return e;

    if (!betterC)
        return ErrorExp.get();

    // Allow ctfe to use the gc code, but don't let it into the runtime
    f.skipCodegen = true;
    return e;
}

/// Returns: whether GC usage inside `fd` should be printed for the -vgc flag
///
/// dmd/nogc.d:298 — `extern (D) bool vgcEnabled(FuncDeclaration fd)`.
export function vgcEnabled(fd: FuncDeclaration): boolean {
    if (!global.params.v.gc)
        return false;

    const m: Module | null = fd.getModule();
    return m !== null && m.isRoot() && !fd.inUnittest();
}

/// dmd/nogc.d:307 — `extern (D) void printGCUsage(FuncDeclaration fd, Loc loc, const(char)* warn)`.
/// Reached by UFCS as the receiver-first call from EIGHT of the eleven NOGCVisitor arms
/// (nogc.d:146, :183, :192, :211, :234, :244, :257, :264); the `Expression`, `DeclarationExp` and
/// `DeleteExp` arms never report usage.
export function printGCUsage(fd: FuncDeclaration, loc: Loc, warn: DString): void {
    if (vgcEnabled(fd))
        message(loc, ds("vgc: %s"), warn);
}

/**
 * Removes `_d_HookTraceImpl` if found from `fd`.
 * This is needed to be able to find hooks that are called though the hook's `*Trace` wrapper.
 * Parameters:
 *  fd = The function declaration to remove `_d_HookTraceImpl` from
 *
 * dmd/nogc.d:319 — `private FuncDeclaration stripHookTraceImpl(FuncDeclaration fd)`. D `private` is
 * MODULE visibility, so the port EXPORTS it with this marker (01 §2.5 / 10 §1.7) — nogc.test.ts
 * pins its identity path, which a non-exported function could not reach.
 */
// D module-private (touched by nogc.test.ts)
export function stripHookTraceImpl(fd: FuncDeclaration): FuncDeclaration | null {
    // dropped: the function-local `import dmd.id : Id;` / `import dmd.dsymbol : Dsymbol;`
    //          (nogc.d:321-322) — both names are already in this file's import block.
    if (fd.ident !== Id._d_HookTraceImpl)
        return fd;

    // Get the Hook from the second template parameter
    const templateInstance = fd.parent!.isTemplateInstance();
    const hook: RootObject | null = templateInstance!.tiargs!.opIndex(1);
    const s: Dsymbol | null = isDsymbol(hook);
    assert(s, "Expected _d_HookTraceImpl's second template parameter to be an alias to the hook!");
    return s.isFuncDeclaration();
}

/**************************************
 * The function is doing something that may allocate with the GC,
 * so mark it as not nogc (not no-how).
 *
 * Params:
 *     sc = scope that the GC action is in
 *     fd = function
 *     loc = location of GC action
 *     fmt = format string for error message. Must include "%s `%s`" for the function kind and name.
 *     args = arguments to format string
 *
 * Returns:
 *      true if function is marked as @nogc, meaning a user error occurred
 *
 * dmd/nogc.d:349 — `extern (D) bool setGC(Scope* sc, FuncDeclaration fd, Loc loc, const(char)* fmt,
 * RootObject[] args...)`. The typesafe-variadic tail is a TS rest parameter; its elements are
 * nullable class references in D (nogc.d:389 passes a literal `null` into it), so the element type
 * is `RootObject | null`.
 */
export function setGC(sc: Scope | null, fd: FuncDeclaration, loc: Loc, fmt: DString | null,
                      ...args: (RootObject | null)[]): boolean {
    //printf("setGC() %s\n", toChars());
    if (fd.nogcInprocess && fd.semanticRun < PASS.semantic3 && fd._scope) {
        // nogc.d:354-355 `fd.semantic2(fd._scope)` / `fd.semantic3(fd._scope)` — UFCS onto
        // dmd.semantic2 / dmd.semantic3 (04 §6).
        semantic2(fd, fd._scope);
        semantic3(fd, fd._scope);
    }

    if (sc && isRootTraitsCompilesScope(sc)) { // __traits(compiles, x)
        // nogc.d:360 `sc.func.isNogcBypassingInference()` — UFCS onto this module's own predicate.
        if (isNogcBypassingInference(sc.func!)) {
            // Message wil be gagged, but still call error() to update global.errors and for
            // -verrors=spec
            // nogc.d:364 — a struct LITERAL (`AttributeViolation(...)`, no `new`), so the value form:
            // the `this(Loc, const(char)*, RootObject[])` ctor is `fromFormat` (04 §1.1(c)). `fmt` is
            // handed over exactly as D hands over its raw `const(char)*` — a null here is D's own
            // `buf.printf(null, …)`, not a case the port invents a behaviour for.
            const action: DString = AttributeViolation.fromFormat(loc, fmt!, args).action!;
            // nogc.d:365 — the leading dot of D's `.error(...)` is module-scope qualification of the same
            // `dmd.errors.error`; `action.fTuple.expand` spreads the `%.*s` (length, ptr) pair.
            error(loc, ds("%.*s is not allowed in a `@nogc` function"), ...fTuple(action));
            return true;
        }
        return false;
    }

    if (fd.nogcInprocess) {
        fd.nogcInprocess = false;
        if (fmt)
            fd.nogcViolation = AttributeViolation.fromFormat(loc, fmt, args); // action that requires GC
        else if (args.length > 0) {
            // nogc.d:378 `args[0].isDsymbol()` — UFCS onto dmd.dtemplate's `isDsymbol`, which
            // tolerates a null receiver exactly as D's does.
            const sa: Dsymbol | null = isDsymbol(args[0]);
            if (sa) {
                const fd2: FuncDeclaration | null = sa.isFuncDeclaration();
                if (fd2) {
                    // call to non-@nogc function
                    fd.nogcViolation = AttributeViolation.fromFuncDeclaration(loc, fd2);
                }
            }
        }

        fd.type!.toTypeFunction().isNogc = false;
        // nogc.d:389 `sc.setGC(fd.fes.func, Loc.init, null, null)` — UFCS recursion into this same
        // function; `sc` may be null here and is only forwarded, never dereferenced, exactly as in D.
        // `Loc.init` is the type's default init — `Loc.initial` is that same value, shared per the
        // ALIAS-SAFE REGISTER (03 §9.1). The trailing `null` is the sole `args` element.
        if (fd.fes)
            setGC(sc, fd.fes.func!, Loc.initial, null, null);
    } else if (isNogc(fd))
        return true;
    return false;
}

/**************************************
 * The function calls non-`@nogc` function f, mark it as not nogc.
 * Params:
 *     sc = scope that the GC action is in
 *     fd = function doing the call
 *     f = function being called
 * Returns:
 *      true if function is marked as @nogc, meaning a user error occurred
 *
 * dmd/nogc.d:405 — `extern (D) bool setGCCall(Scope* sc, FuncDeclaration fd, FuncDeclaration f)`.
 * `sc` keeps D's nullable `Scope*`: the body neither dereferences nor null-tests it (nogc.d:407 is a
 * UFCS forward), and the `setGC` it forwards into is itself declared `Scope | null` — narrowing here
 * would make a future faithful caller holding a `Scope*` write a `!` the D source does not justify.
 */
export function setGCCall(sc: Scope | null, fd: FuncDeclaration, f: FuncDeclaration): boolean {
    return setGC(sc, fd, fd.loc, null, f);
}

/// dmd/nogc.d:410 — `bool isNogc(FuncDeclaration fd)`. Whether `fd` is `@nogc`; forces the pending
/// inference first when `fd`'s `@nogc`-ness is still in process.
export function isNogc(fd: FuncDeclaration): boolean {
    //printf("isNogc() %s, inprocess: %d\n", toChars(), !!(flags & FUNCFLAG.nogcInprocess));
    if (fd.nogcInprocess)
        setGC(null, fd, fd.loc, null);
    return fd.type!.toTypeFunction().isNogc;
}

/// dmd/nogc.d:418 — `extern (D) bool isNogcBypassingInference(FuncDeclaration fd)`. Whether `fd` is
/// `@nogc` WITHOUT triggering inference.
export function isNogcBypassingInference(fd: FuncDeclaration): boolean {
    return !fd.nogcInprocess && isNogc(fd);
}
