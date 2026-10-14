/**
 * Does semantic analysis for functions.
 *
 * Ported 1:1 from dmd/funcsem.d (module dmd.funcsem), ldc 1.43.0-beta1 / DMD 2.113.
 *
 * IDIOM CHECK (13 §7): `grep 'class .*Visitor' dmd/funcsem.d` -> ZERO hits. This module uses
 * NEITHER visitor idiom for its own dispatch: the `switch (_this.dsym)` tails in
 * `addPostInvariant` / `addPreInvariant` / `isVirtual` are D's own RTTI-tag dispatches over a
 * nested `visitFuncDeclaration` default (13 §7.5's shape, emitted IN FULL, arm for arm). The two
 * `StatementRewriteWalker` subclasses (`NrvoWalker`, and `RetWalker` nested in `modifyReturns`)
 * ARE Idiom-A visitor classes over the base in visitor/statement_rewrite_walker.ts.
 *
 * D module-level free functions are emitted as FREE FUNCTIONS here (04 §6): none of them is
 * promoted onto `FuncDeclaration`. Consumers written against the rung-era method forms are listed
 * in the translation report.
 */

import { ds, cstr } from "../dstring.js";
import type { DString } from "../dstring.js";
import { assert, assertUnreachable, SwitchError } from "../assert.js";
import { K, KeepUnit, keepAppend, keepInfers, keepReq } from "../keep.js";

import { global } from "./globals.js";
import { error, errorSupplemental, deprecation, deprecationSupplemental, messageNoLoc, tip } from "./errors.js";
import { Loc } from "./location.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { Array as DArray } from "./root/array.js";
import { OutBuffer } from "./common/outbuffer.js";
import { StringTable } from "./root/stringtable.js";
import { AssocArray } from "./root/aav.js";
import { FileName } from "./root/filename.js";

import {
    CHECKENABLE, LINK, MATCH, MODFlags, PURE, Sizeok, STC, ThreeState, TRUST, TY, VarArg,
} from "./astenums.js";
import { ClassKind } from "./aggregate.js";
import { Covariant, MODimplicitConv, MODmethodConv, MODtoBuffer, MODtoChars, Parameter, ParameterList,
    Type, TypeFunction, TypeIdentifier, getThrowable } from "./mtype.js";
import { DSYM, DsymbolTable, PASS, Visibility } from "./dsymbol.js";
import { MatchAccumulator, ThisDeclaration, VarDeclaration } from "./declaration.js";
import type { AggregateDeclaration } from "./aggregate.js";
import { FuncDeclaration, MODMatchToBuffer } from "./func.js";
import type { FuncLiteralDeclaration } from "./func.js";
import { AttributeViolation } from "./func.js";
import { OS, target } from "./target.js";
import { EXP, TOK } from "./tokens.js";

import {
    ArgumentList, AssertExp, CallExp, CommaExp, DeclarationExp, DotVarExp, Expression, IdentifierExp,
    IntegerExp, StringExp, ThisExp, VarExp,
} from "./expression.js";
import type { AssignExp } from "./expression.js";
import { arrayObjectIsError, isDsymbol, isError } from "./dtemplate.js";
import { ExpInitializer, VoidInitializer } from "./init.js";
import {
    Catch, CompoundStatement, DtorExpStatement, ExpStatement, GotoStatement, PeelStatement, ScopeStatement,
    ThrowStatement, TryCatchStatement,
} from "./statement.js";
import type { ReturnStatement, Statement, TryFinallyStatement } from "./statement.js";
import { checkSymbolAccess } from "./access.js";
import { search_function } from "./opover.js";
import { semantic3 } from "./semantic3.js";
import { argExpTypesToCBuffer, arrayObjectsToBuffer, functionToBufferFull, linkageToChars, parametersTypeToChars,
    toCharsMaybeConstraints, visibilityToChars, HdrGenState } from "./hdrgen.js";
import {
    addDeferredSemantic3, allowsContractWithoutBody, checkGNUABITag, dsymbolSemantic, getType, makeNested,
    search, search_correct, toAlias, toParentP, searchScope, insert } from "./dsymbolsem.js";
import { checkDisabled } from "./expressionsem.js";
import { evalPragmaInline } from "./pragmasem.js";
import {
    addMod, addSTC, addStorageClass, baseElemOf, callMatch, constConv, covariant, defaultInitLiteral,
    equivalent, hasPointers, isBaseOf, nextOf, pointerTo, purityLevel, resolveNamedArgs, sarrayOf,
    toBasetype, toDsymbol, typeSemantic,
} from "./typesem.js";

// Load order (01 §4.8): the two SWEPT-WALL edges enter the SCC in LAST import position, so the
// module entry order established by every import above is unchanged. Both are value imports used
// only at call time (01 §4.3) — nothing at this module's top level reads either binding.
import { checkMustUseReserved } from "./mustuse.js";
import { computeOneMember, functionResolve, getConstraintEvalError } from "./templatesem.js";

import type { BaseClass } from "./dclass.js";
import type { Declaration } from "./declaration.js";
import type { Dsymbol } from "./dsymbol.js";
import type { OverDeclaration } from "./declaration.js";
import type { Module } from "./dmodule.js";
import type { RootObject } from "./rootobject.js";
import type { Scope } from "./dscope.js";
import type { TemplateDeclaration, TemplateInstance } from "./dtemplate.js";
import { TemplateMixin } from "./dtemplate.js";
import type { Catches, Dsymbols, Expressions, Objects, Parameters, Statements } from "./arraytypes.js";
import type { ArgumentLabels } from "./arraytypes.js";
import { implicitCastTo, implicitConvToType } from "./dcast.js";
// last (01 §4.8), wave-9 swept walls: safe.ts value-imports `isRootTraitsCompilesScope` from this module and
// delegatize.ts value-imports `checkNestedReference`, so both edges close a cycle back here. Entering
// either module from an earlier position would make it the SCC entry ahead of the node modules above.
// Both are called only inside function bodies (01 §4.3); nothing at this module's top level reads them.
import { isSafeBypassingInference } from "./safe.js";
import { ensureStaticLinkTo, lambdaCheckForNestedRef } from "./delegatize.js";
// last (01 §4.8): objc.ts value-imports dsymbolsem/expressionsem, which close the core SCC back here, so
// entering it from an earlier position would make it the SCC's entry. `objc()` is read only inside
// bodies; it is non-null there because the driver runs `Objc._init()` at startup (main.d:445), hence `objc()!`.
import { objc } from "./objc.js";
// last (01 §4.8), wave-16 NrvoWalker/RetWalker fill: statementsem (catchSemantic, funcsem.d:61), blockexit
// (blockExit/BE, funcsem.d:23) and dclass (ClassDeclaration.throwable) are core-SCC modules read only
// inside method bodies. statement_rewrite_walker is outside the SCC (it value-imports only visitor/index.ts,
// a load-order root), so NrvoWalker's top-level `extends` finds it evaluated in every entry order.
import { catchSemantic } from "./statementsem.js";
import { BE, blockExit } from "./blockexit.js";
import { ClassDeclaration } from "./dclass.js";
import { StatementRewriteWalker } from "./visitor/statement_rewrite_walker.js";
// last (01 §4.8): dmd/funcsem.d:43 `import dmd.importc;`. importc.ts value-imports typesem, dcast, dsymbolsem and
// expressionsem, so entering the core SCC through it from an earlier position would make it the entry.
import { cFuncEquivalence, cTypeEquivalence } from "./importc.js";

/**
 * The `ref`/`out` parameter box (03 §3.3 / §7.2). D has no such type: it is the port's carrier for a
 * D `ref T` parameter whose callee REASSIGNS the caller's variable (`classFuncSemantic`'s
 * `ref Dsymbol parent`) and for the `&stc` / `&offset` out-pointers of `covariant`/`isBaseOf`.
 */
interface Ref<T> {
    value: T;
}

/**
 * `core.bitop.popcnt` (funcsem.d:678, a function-local import). The port has no `core.bitop` shim;
 * this is the 32-bit population count, the same value D's intrinsic returns for a `MOD` (a ubyte).
 * Runtime-library replacement per 08 §0, not a domain stand-in.
 */
function popcnt(x: number): number {
    let v = x >>> 0;
    v = v - ((v >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    v = (v + (v >>> 4)) & 0x0f0f0f0f;
    return (Math.imul(v, 0x01010101) >>> 24);
}

/**
 * dmd/funcsem.d:70 — `bool addPostInvariant(FuncDeclaration _this)`.
 *
 * Whether a call to the enclosing aggregate's `invariant` must be APPENDED to this function's body.
 * Preconditions: none. No side effects. The trailing `switch (_this.dsym)` is D's own RTTI-tag
 * dispatch and is emitted arm for arm (13 §7.5 rule 1).
 */
export function addPostInvariant(_this: FuncDeclaration): boolean {
    // funcsem.d:72 — nested `static bool visitFuncDeclaration(FuncDeclaration _this)` (04 §5:
    // inner `const` arrow; `static` erases — it captures nothing).
    const visitFuncDeclaration = (fd: FuncDeclaration): boolean => {
        const ad = fd.isThis();
        return (
            ad !== null &&
            ad.inv !== null &&
            global.params.useInvariants === CHECKENABLE.on &&
            (fd.visibility.kind === Visibility.Kind.protected_ ||
                fd.visibility.kind === Visibility.Kind.public_ ||
                fd.visibility.kind === Visibility.Kind.export_) &&
            !fd.isNaked
        );
    };

    switch (_this.dsym) {
        case DSYM.funcLiteralDeclaration:
        case DSYM.dtorDeclaration:
        case DSYM.staticCtorDeclaration:
        case DSYM.sharedStaticCtorDeclaration:
        case DSYM.staticDtorDeclaration:
        case DSYM.sharedStaticDtorDeclaration:
        case DSYM.invariantDeclaration:
        case DSYM.unitTestDeclaration:
        case DSYM.newDeclaration:
            return false;
        case DSYM.ctorDeclaration: {
            const cd = _this.isCtorDeclaration()!;   // tag-proved RTTI downcast (02 §11.5c #3)
            return cd.isThis() !== null && cd.vthis !== null && global.params.useInvariants === CHECKENABLE.on;
        }
        case DSYM.postBlitDeclaration: {
            const dd = _this.isPostBlitDeclaration()!;   // tag-proved RTTI downcast (02 §11.5c #3)
            return dd.isThis() !== null && dd.vthis !== null && global.params.useInvariants === CHECKENABLE.on;
        }
        default:
            return visitFuncDeclaration(_this);
    }
}

/**
 * dmd/funcsem.d:112 — `bool addPreInvariant(FuncDeclaration _this)`.
 *
 * Whether a call to the enclosing aggregate's `invariant` must be PREPENDED to this function's body.
 * Preconditions: none. No side effects.
 */
export function addPreInvariant(_this: FuncDeclaration): boolean {
    // funcsem.d:114 — nested `static bool visitFuncDeclaration(FuncDeclaration _this)` (04 §5).
    const visitFuncDeclaration = (fd: FuncDeclaration): boolean => {
        return (
            fd.isThis() !== null &&
            global.params.useInvariants === CHECKENABLE.on &&
            (fd.visibility.kind === Visibility.Kind.protected_ ||
                fd.visibility.kind === Visibility.Kind.public_ ||
                fd.visibility.kind === Visibility.Kind.export_) &&
            !fd.isNaked
        );
    };

    switch (_this.dsym) {
        case DSYM.funcLiteralDeclaration:
        case DSYM.ctorDeclaration:
        case DSYM.postBlitDeclaration:
        case DSYM.staticCtorDeclaration:
        case DSYM.sharedStaticCtorDeclaration:
        case DSYM.staticDtorDeclaration:
        case DSYM.sharedStaticDtorDeclaration:
        case DSYM.invariantDeclaration:
        case DSYM.unitTestDeclaration:
        case DSYM.newDeclaration:
            return false;
        case DSYM.dtorDeclaration: {
            const dd = _this.isDtorDeclaration()!;   // tag-proved RTTI downcast (02 §11.5c #3)
            return dd.isThis() !== null && dd.vthis !== null && global.params.useInvariants === CHECKENABLE.on;
        }
        default:
            return visitFuncDeclaration(_this);
    }
}

/**
 * dmd/funcsem.d:149 — `bool isVirtual(const FuncDeclaration _this)`.
 * Determine if function goes into virtual function pointer table.
 *
 * Preconditions: none. No side effects. Trailing `const` and the `const` on the parameter erase (04 §8).
 */
export function isVirtual(_this: FuncDeclaration): boolean {
    // funcsem.d:151 — nested `static bool visitFuncDeclaration(const FuncDeclaration _this)` (04 §5).
    const visitFuncDeclaration = (fd: FuncDeclaration): boolean => {
        if (fd.toAliasFunc() !== fd)
            return isVirtual(fd.toAliasFunc());

        const p = fd.toParent();

        // D `if (!_this.isMember || !p.isClassDeclaration)` — property-call syntax on two methods
        // (04 §9); each yields a nullable reference, so the truthiness is the explicit null test
        // (06 §2.7). `p` is non-null whenever `isMember()` is, so D's unguarded `p.` is matched by `!`.
        if (fd.isMember() === null || p!.isClassDeclaration() === null)
            return false;

        if (p!.isClassDeclaration()!.classKind === ClassKind.objc)
            return objc()!.isVirtual(fd); // funcsem.d:162

        // resolved: version (none) (funcsem.d:164-180) -> OFF; the printf debug block is dropped.

        return !(fd.isStatic() ||
                 fd.visibility.kind === Visibility.Kind.private_ ||
                 fd.visibility.kind === Visibility.Kind.package_) &&
               !(p!.isInterfaceDeclaration() !== null && fd.isFinalFunc());
    };

    switch (_this.dsym) {
        case DSYM.funcLiteralDeclaration:
        case DSYM.ctorDeclaration:
        case DSYM.postBlitDeclaration:
        case DSYM.staticCtorDeclaration:
        case DSYM.sharedStaticCtorDeclaration:
        case DSYM.staticDtorDeclaration:
        case DSYM.sharedStaticDtorDeclaration:
        case DSYM.invariantDeclaration:
        case DSYM.unitTestDeclaration:
        case DSYM.newDeclaration:
            return false;
        // D dtor's don't get put into the vtbl[]
        // this is a hack so that extern(C++) destructors report as virtual
        // which are manually added to the vtable
        case DSYM.dtorDeclaration:
            return _this.vtblIndex !== -1;
        default:
            return visitFuncDeclaration(_this);
    }
}

/**
 * dmd/funcsem.d:210 — `bool isVirtualMethod(FuncDeclaration _this)`.
 * Determine if a function is pedantically virtual.
 */
export function isVirtualMethod(_this: FuncDeclaration): boolean {
    if (_this.toAliasFunc() !== _this)
        return isVirtualMethod(_this.toAliasFunc());

    //printf("FuncDeclaration::isVirtualMethod() %s\n", toChars());
    if (!isVirtual(_this))
        return false;

    // If it's a final method, and does not override anything, then it is not virtual
    if (_this.isFinalFunc() && _this.foverrides.length === 0) {
        return false;
    }
    return true;
}

/***********************************************
 * dmd/funcsem.d:231 — `bool hasNestedFrameRefs(FuncDeclaration _this)`.
 * Determine if function's variables are referenced by a function nested within it.
 */
export function hasNestedFrameRefs(_this: FuncDeclaration): boolean {
    if (_this.closureVars.length !== 0)
        return true;

    /* If a virtual function has contracts, assume its variables are referenced
     * by those contracts, even if they aren't. Because they might be referenced
     * by the overridden or overriding function's contracts.
     * This can happen because frequire and fensure are implemented as nested functions,
     * and they can be called directly by an overriding function and the overriding function's
     * context had better match, or
     * https://issues.dlang.org/show_bug.cgi?id=7335 will bite.
     */
    // `fdrequire`/`fdensure` are D fields behind the lazily-allocated `contracts` block; the port
    // exposes them as accessor METHODS (func.ts) — nullable references, tested per 06 §2.7.
    if (_this.fdrequire() !== null || _this.fdensure() !== null)
        return true;

    if (_this.foverrides.length !== 0 && isVirtualMethod(_this)) {
        for (let i = 0; i < _this.foverrides.length; i++) {
            // `foverrides` is `Array<FuncDeclaration | null>` (08 §3); D dereferences the slot
            // unconditionally, so `!` marks the same fault point (02 §10.1).
            const fdv: FuncDeclaration = _this.foverrides.opIndex(i)!;
            if (hasNestedFrameRefs(fdv))
                return true;
        }
    }
    return false;
}

/**
 * funcsem.d:272 — `__gshared DsymbolTable st = null;` inside `genCfunc`. A function-`static`
 * in D is module-level mutable state in the port (there is no TS equivalent of a function static).
 */
let genCfuncSt: DsymbolTable | null = null;

/**********************************
 * dmd/funcsem.d:262 — `FuncDeclaration genCfunc(Parameters*, Type, const(char)* name, STC = none)`.
 * Generate a FuncDeclaration for a runtime library function.
 *
 * Overload pair (04 §1.1(b)): `genCfunc(…, const(char)* name, …)` and
 * `genCfunc(…, Identifier id, …)` share arity and differ only by the third parameter's type. The
 * `Identifier` form is the primary (it holds the implementation; this one forwards to it), so it
 * keeps the bare name and THIS one takes the distinguishing suffix `FromName`.
 */
export function genCfuncFromName(fparams: Parameters | null, treturn: Type, name: DString,
                                 stc: STC = STC.none): FuncDeclaration {
    // D `name[0 .. strlen(name)]` — the logical string of a NUL-terminated `const(char)*` is the
    // bytes before the first NUL; `cstr` is the port's spelling of that view (02 §11.2).
    return genCfunc(fparams, treturn, Identifier.idPool(cstr(name)), stc);
}

/// dmd/funcsem.d:267 — `FuncDeclaration genCfunc(Parameters*, Type, Identifier id, STC = none)`.
/// The primary form (see `genCfuncFromName` for the overload-pair naming).
export function genCfunc(fparams: Parameters | null, treturn: Type, id: Identifier,
                         stc: STC = STC.none): FuncDeclaration {
    let fd: FuncDeclaration;

    //printf("genCfunc(name = '%s')\n", id.toChars());
    //printf("treturn\n\t"); treturn.print();

    // See if already in table
    if (genCfuncSt === null)
        genCfuncSt = new DsymbolTable();
    const s: Dsymbol | null = genCfuncSt.lookup(id);
    if (s !== null) {
        fd = s.isFuncDeclaration()!;
        assert(fd !== null);
        assert(nextOf(fd.type!)!.equals(treturn));
    } else {
        const tf = new TypeFunction(new ParameterList(fparams), treturn, LINK.c, stc);
        fd = new FuncDeclaration(Loc.initial, Loc.initial, id, STC.static_, tf);
        fd.visibility = new Visibility(Visibility.Kind.public_);
        fd._linkage = LINK.c;

        genCfuncSt.insert(fd);
    }
    return fd;
}

/* Tweak all return statements and dtor call for nrvo_var, for correct NRVO.
 */
/**
 * dmd/funcsem.d:301 — `extern (C++) final class NrvoWalker : StatementRewriteWalker`.
 *
 * `visit(ReturnStatement)` rewrites `return exp;` to `vresult = exp; goto Lresult;` when
 * `fd.returnLabel` is set; `visit(TryFinallyStatement)` turns the NRVO variable's
 * `finally { nrvo_var.edtor; }` into `catch (Throwable __o) { nrvo_var.edtor; throw __o; }` (or drops
 * the dtor entirely when exceptions are off), else forwards to the base walk.
 * Preconditions: the caller (semantic3.d:1020) sets `fd` and `sc` before `visitStmt`.
 * `final` erases (04 §8); `alias visit = typeof(super).visit;` (funcsem.d:303) is dropped (13 §1).
 * LOAD ORDER: the top-level `extends` reads `StatementRewriteWalker` at class definition; its module
 * value-imports only visitor/index.ts, a load-order root outside the core SCC, so it is fully
 * evaluated before this module's body runs, in every entry order.
 */
export class NrvoWalker extends StatementRewriteWalker {
    fd: FuncDeclaration | null = null;
    sc: Scope | null = null;

    /// funcsem.d:308 — `override void visit(ReturnStatement s)` (13 §1 renaming).
    override visitReturnStatement(s: ReturnStatement): void {
        const fd = this.fd!;
        // See if all returns are instead to be replaced with a goto returnLabel;
        if (fd.returnLabel !== null) {
            /* Rewrite:
             *  return exp;
             * as:
             *  vresult = exp; goto Lresult;
             */
            const gs = new GotoStatement(s.loc, Id.returnLabel);
            gs.label = fd.returnLabel;

            let s1: Statement = gs;
            if (s.exp !== null)
                s1 = CompoundStatement.fromStatementList(s.loc, new ExpStatement(s.loc, s.exp), gs);

            this.replaceCurrent(s1);
        }
    }

    /// funcsem.d:329 — `override void visit(TryFinallyStatement s)` (13 §1 renaming).
    override visitTryFinallyStatement(s: TryFinallyStatement): void {
        const fd = this.fd!;
        let des: DtorExpStatement | null;
        if (fd.isNRVO && s.finalbody !== null && (des = s.finalbody.isDtorExpStatement()) !== null &&
            fd.nrvo_var === des.var_) {
            if (!(global.params.useExceptions && ClassDeclaration.throwable !== null)) {
                /* Don't need to call destructor at all, since it is nrvo
                 */
                this.replaceCurrent(s._body);
                s._body!.accept(this);
                return;
            }

            /* Normally local variable dtors are called regardless exceptions.
             * But for nrvo_var, its dtor should be called only when exception is thrown.
             *
             * Rewrite:
             *      try { s.body; } finally { nrvo_var.edtor; }
             *      // equivalent with:
             *      //    s.body; scope(exit) nrvo_var.edtor;
             * as:
             *      try { s.body; } catch(Throwable __o) { nrvo_var.edtor; throw __o; }
             *      // equivalent with:
             *      //    s.body; scope(failure) nrvo_var.edtor;
             */
            const sexception: Statement = new DtorExpStatement(Loc.initial, fd.nrvo_var!.edtor, fd.nrvo_var);
            const id = Identifier.generateId(ds("__o"));

            let handler: Statement = new PeelStatement(sexception);
            if ((blockExit(sexception, fd, null) & BE.fallthru) !== 0) {
                const ts = new ThrowStatement(Loc.initial, new IdentifierExp(Loc.initial, id));
                ts.internalThrow = true;
                handler = CompoundStatement.fromStatementList(Loc.initial, handler, ts);
            }

            const ctch = new Catch(Loc.initial, getThrowable(), id, handler);
            ctch.internalCatch = true;
            catchSemantic(ctch, this.sc!); // Run semantic to resolve identifier '__o'
            const catches: Catches = DArray.from<Catch | null>(ctch); // D `new Catches(ctch)`

            const s2: Statement = new TryCatchStatement(Loc.initial, s._body, catches);
            fd.hasNoEH = false;
            this.replaceCurrent(s2);
            s2.accept(this);
        } else
            super.visitTryFinallyStatement(s); // D `StatementRewriteWalker.visit(s)`
    }
}

/****************************************
 * dmd/funcsem.d:389 — `extern (C++) bool onlyOneMain(FuncDeclaration fd)`.
 * Only one entry point function is allowed. Print error if more than one.
 * Params:
 *      fd = a "main" function
 * Returns:
 *      true if haven't seen "main" before
 */
export function onlyOneMain(fd: FuncDeclaration): boolean {
    const lastMain = FuncDeclaration.lastMain;
    if (lastMain !== null) {
        const format: DString = (target.os === OS.Windows)
            ? ds("only one entry point `main`, `WinMain` or `DllMain` is allowed")
            : ds("only one entry point `main` is allowed");
        error(fd.loc, format);
        errorSupplemental(lastMain.loc, ds("previously found `%s` here"), lastMain.toFullSignature());
        return false;
    }
    FuncDeclaration.lastMain = fd;
    return true;
}

/********************************************
 * dmd/funcsem.d:408 — `bool isUnique(const FuncDeclaration fd)`.
 * Returns: true if there are no overloads of this function.
 *
 * Overload pair (04 §1.1(b)): `isUnique(FuncDeclaration)` and `isUnique(OverDeclaration)`
 * (funcsem.d:4189) share arity and differ by parameter and return type. This one keeps the bare
 * name; the other takes the distinguishing suffix — see `isUniqueOverDeclaration`.
 */
export function isUnique(fd: FuncDeclaration): boolean {
    let result = false;
    // D `cast() fd` strips `const` from the parameter — a qualifier cast with no runtime effect (04 §8).
    overloadApply(fd, (s: Dsymbol): number => {
        const f = s.isFuncDeclaration();
        const td = s.isTemplateDeclaration();
        if (f === null && td === null)
            return 0;
        if (result) {
            result = false;
            return 1; // ambiguous, done
        } else {
            result = true;
            return 0;
        }
    });
    return result;
}

/**********************************
 * dmd/funcsem.d:434 — `void funcDeclarationSemantic(Scope* sc, FuncDeclaration funcdecl)`.
 * Main semantic routine for functions (pass 1): resolve the signature (`TypeFunction`), fold the
 * scope's storage classes / linkage / visibility onto the declaration, wire the vtbl for a class
 * member, and mark pass-1 done. The BODY is left to semantic3.
 *
 * Preconditions: `funcdecl.semanticRun <= PASS.semantic` when it has not run yet (asserted).
 * Postconditions: on the non-error path `funcdecl.semanticRun == PASS.semanticdone` and
 * `funcdecl._scope` holds a no-free copy of the analysis scope for semantic3.
 */
export function funcDeclarationSemantic(sc: Scope | null, funcdecl: FuncDeclaration): void {
    // resolved: version (none) (funcsem.d:436-443) -> OFF; the printf trace block is dropped.

    // dropped: `import dmd.timetrace; timeTraceBeginEvent(...); scope (exit) timeTraceEndEvent(...)`
    // (funcsem.d:445-447) — dmd.timetrace is a PROFILING module with no semantic effect and no port.

    if (funcdecl.semanticRun !== PASS.initial && funcdecl.isFuncLiteralDeclaration() !== null) {
        /* Member functions that have return types that are
         * forward references can have semantic() run more than
         * once on them.
         * See test\interface2.d, test20
         */
        return;
    }

    if (funcdecl.semanticRun >= PASS.semanticdone)
        return;
    assert(funcdecl.semanticRun <= PASS.semantic);
    funcdecl.semanticRun = PASS.semantic;

    if (funcdecl._scope !== null) {
        sc = funcdecl._scope;
        funcdecl._scope = null;
    }

    if (sc === null || funcdecl.errors)
        return;

    funcdecl.cppnamespace_set(sc.namespace);
    funcdecl.parent = sc.parent;
    // D `Dsymbol parent = funcdecl.toParent();` — a plain local that `classFuncSemantic` takes by
    // `ref` and REASSIGNS (funcsem.d:960), so it is carried in the out-param box (03 §3.3).
    const parent: Ref<Dsymbol> = { value: funcdecl.toParent()! };

    funcdecl.foverrides.setDim(0); // reset in case semantic() is being retried for this function

    funcdecl.storage_class = (funcdecl.storage_class | (sc.stc & ~STC.ref_)) as STC;
    const ad: AggregateDeclaration | null = funcdecl.isThis();
    // Don't nest structs b/c of generated methods which should not access the outer scopes.
    // https://issues.dlang.org/show_bug.cgi?id=16627
    if (ad !== null && !funcdecl.isGenerated) {
        funcdecl.storage_class =
            (funcdecl.storage_class | (ad.storage_class & (STC.TYPECTOR | STC.synchronized_))) as STC;
        // funcsem.d:486 — `ad.makeNested();`. UFCS (04 §6/§6.1): `ad` is an AggregateDeclaration, so
        // the callee is dsymbolsem.d:299 `makeNested(AggregateDeclaration _this)` — ported and
        // exported at dsymbolsem.ts, receiver first.
        makeNested(ad);
    }
    if (sc.func !== null)
        funcdecl.storage_class = (funcdecl.storage_class | (sc.func.storage_class & STC.disable)) as STC;
    // Remove prefix storage classes silently.
    if ((funcdecl.storage_class & STC.TYPECTOR) !== 0n && !(ad !== null || funcdecl.isNested()))
        funcdecl.storage_class = (funcdecl.storage_class & ~STC.TYPECTOR) as STC;

    const tf = funcdecl.type!.isTypeFunction();
    if ((funcdecl.storage_class & STC.auto_) !== 0n && tf!.isRef && !funcdecl.inferRetType) {
        if ((funcdecl.storage_class & STC.autoref) === 0n) {
            // @@@DEPRECATED_2.122@@@
            // Deprecated in 2.112, turn into an error in 2.122
            deprecation(funcdecl.loc, ds("`auto ref` return type must have `auto` and `ref` adjacent"));
            funcdecl.storage_class = (funcdecl.storage_class | STC.autoref) as STC;
        }
    }
    //printf("function storage_class = x%llx, sc.stc = x%llx, %x\n", storage_class, sc.stc, Declaration.isFinal());

    if (sc.traitsCompiles)
        funcdecl.skipCodegen = true;

    funcdecl._linkage = sc.linkage;
    if (sc.inCfile && funcdecl.isFuncLiteralDeclaration() !== null)
        funcdecl._linkage = LINK.d; // so they are uniquely mangled

    const fld: FuncLiteralDeclaration | null = funcdecl.isFuncLiteralDeclaration();
    if (fld !== null) {
        if (fld.treq !== null) {
            const treq: Type = fld.treq;
            assert(nextOf(treq)!.ty === TY.Tfunction);
            if (treq.ty === TY.Tdelegate)
                fld.tok = TOK.delegate_;
            else if (treq.isPtrToFunction() !== null)
                fld.tok = TOK.function_;
            else
                assertUnreachable();
            funcdecl._linkage = nextOf(treq)!.toTypeFunction().linkage;
        }
    }

    // evaluate pragma(inline)
    const pragmadecl = sc.inlining;
    if (pragmadecl !== null) {
        // funcsem.d:532 — `funcdecl.inlining = evalPragmaInline(pragmadecl.loc, sc, pragmadecl.args);`
        // (dmd.pragmasem free function, ported at pragmasem.ts).
        funcdecl.inlining = evalPragmaInline(pragmadecl.loc, sc, pragmadecl.args);
    }

    funcdecl.visibility = sc.visibility.copy();   // struct store into a field (03 §1 #5)
    funcdecl.userAttribDecl_set(sc.userAttribDecl);
    checkGNUABITag(funcdecl, funcdecl._linkage);
    // funcsem.d:537 — `checkMustUseReserved(funcdecl);`; callee live at dmd/mustuse.d:58
    // (`void checkMustUseReserved(Dsymbol sym)`), exported by mustuse.ts:143.
    checkMustUseReserved(funcdecl);

    // resolved: version (IN_LLVM) (funcsem.d:539-542) -> ON (we are LDC, _config.md).
    funcdecl.emitInstrumentation = sc.emitInstrumentation;

    if (funcdecl.originalType === null)
        funcdecl.originalType = funcdecl.type!.syntaxCopy();

    if (sc.inCfile) {
        /* C11 allows a function to be declared with a typedef, D does not.
         */
        const ti = funcdecl.type!.isTypeIdentifier();
        if (ti !== null) {
            const tj = typeSemantic(ti, funcdecl.loc, sc);
            const tjf = tj.isTypeFunction();
            if (tjf !== null) {
                /* Copy the type instead of just pointing to it,
                 * as we don't merge function types
                 */
                const tjf2 = new TypeFunction(tjf.parameterList, tjf.next, tjf.linkage);
                funcdecl.type = tjf2;
                funcdecl.originalType = tjf2;
            }
        }
    }

    if (getFunctionType(funcdecl) === null)
        return;

    if (funcdecl.type!.deco === null) {
        sc = sc.push();
        // forward to function type
        sc.stc = (sc.stc | (funcdecl.storage_class & (STC.disable | STC.deprecated_))) as STC;

        // Parameters don't inherit UDAs from outside, https://github.com/dlang/dmd/issues/19788
        sc.userAttribDecl = null;

        if (sc.func !== null) {
            /* If the nesting parent is pure without inference,
             * then this function defaults to pure too.
             *
             *  auto foo() pure {
             *    auto bar() {}     // become a weak purity function
             *    class C {         // nested class
             *      auto baz() {}   // become a weak purity function
             *    }
             *
             *    static auto boo() {}   // typed as impure
             *    // Even though, boo cannot call any impure functions.
             *    // See also Expression::checkPurity().
             *  }
             */
            if (tf!.purity === PURE.impure && (funcdecl.isNested() || funcdecl.isThis() !== null)) {
                let fd: FuncDeclaration | null = null;
                // D `for (Dsymbol p = funcdecl.toParent2(); p; p = p.toParent2())` — the parameter-free
                // chain walk gets the widened cursor of 02 §10.1.
                for (let p: Dsymbol | null = funcdecl.toParent2(); p !== null; p = p.toParent2()) {
                    const adx = p.isAggregateDeclaration();
                    if (adx !== null) {
                        if (adx.isNested())
                            continue;
                        break;
                    }
                    fd = p.isFuncDeclaration();
                    if (fd !== null)
                        break;
                }

                /* If the parent's purity is inferred, then this function's purity needs
                 * to be inferred first.
                 */
                if (fd !== null && isPureBypassingInference(fd) >= PURE.weak && funcdecl.isInstantiated() === null) {
                    tf!.purity = PURE.fwdref; // default to pure
                }
            }
        }

        if (tf!.isRef)
            sc.stc = (sc.stc | STC.ref_) as STC;
        if (tf!.isScopeQual)
            sc.stc = (sc.stc | STC.scope_) as STC;
        if (tf!.isNothrow)
            sc.stc = (sc.stc | STC.nothrow_) as STC;
        if (tf!.isNogc)
            sc.stc = (sc.stc | STC.nogc) as STC;
        if (tf!.isProperty)
            sc.stc = (sc.stc | STC.property) as STC;
        if (tf!.purity === PURE.fwdref)
            sc.stc = (sc.stc | STC.pure_) as STC;

        if (tf!.trust !== TRUST.default_) {
            sc.stc = (sc.stc & ~STC.safeGroup) as STC;
            if (tf!.trust === TRUST.safe)
                sc.stc = (sc.stc | STC.safe) as STC;
            else if (tf!.trust === TRUST.system)
                sc.stc = (sc.stc | STC.system) as STC;
            else if (tf!.trust === TRUST.trusted)
                sc.stc = (sc.stc | STC.trusted) as STC;
        }

        if (funcdecl.isCtorDeclaration() !== null) {
            tf!.isCtor = true;
            // `ad` is non-null on this path: a ctor is always a member (D dereferences it unguarded).
            let tret: Type = ad!.handleType()!;
            assert(tret !== null);
            tret = addStorageClass(tret, (funcdecl.storage_class | sc.stc) as STC);
            tret = addMod(tret, funcdecl.type!.mod);
            tf!.next = tret;
            if (ad!.isStructDeclaration() !== null)
                sc.stc = (sc.stc | STC.ref_) as STC;
        }

        // 'return' on a non-static class member function implies 'scope' as well
        if (ad !== null && ad.isClassDeclaration() !== null &&
            (tf!.isReturn || (sc.stc & STC.return_) !== 0n) && (sc.stc & STC.static_) === 0n)
            sc.stc = (sc.stc | STC.scope_) as STC;

        // If 'this' has no pointers, remove 'scope' as it has no meaning
        // Note: this is already covered by semantic of `VarDeclaration` and `TypeFunction`,
        // but existing code relies on `hasPointers()` being called here to resolve forward references:
        // https://github.com/dlang/dmd/pull/14232#issuecomment-1162906573
        if ((sc.stc & STC.scope_) !== 0n && ad !== null && ad.isStructDeclaration() !== null &&
            !hasPointers(ad.type!)) {
            sc.stc = (sc.stc & ~STC.scope_) as STC;
            tf!.isScopeQual = false;
            if (tf!.isReturnScope) {
                sc.stc = (sc.stc & ~(STC.return_ | STC.returnScope)) as STC;
                tf!.isReturn = false;
                tf!.isReturnScope = false;
            }
        }

        sc.linkage = funcdecl._linkage;

        if (!tf!.isNaked() && !(funcdecl.isThis() !== null || funcdecl.isNested())) {
            const mods = MODtoChars(tf!.mod);
            error(funcdecl.loc, ds("%s `%s` without `this` cannot be `%s`"),
                funcdecl.kind(), funcdecl.toPrettyChars(), mods);
            if (tf!.next !== null && tf!.next.ty !== TY.Tvoid && popcnt(tf!.mod) === 1)
                errorSupplemental(funcdecl.loc,
                    ds("did you mean to use `%s(%s)` as the return type?"), mods, tf!.next.toChars());

            tf!.mod = 0; // remove qualifiers
        }

        /* Apply const, immutable, wild and shared storage class
         * to the function type. Do this before type semantic.
         */
        let stc: STC = funcdecl.storage_class;
        if (funcdecl.type!.isImmutable())
            stc = (stc | STC.immutable_) as STC;
        if (funcdecl.type!.isConst())
            stc = (stc | STC.const_) as STC;
        if (funcdecl.type!.isShared() || (funcdecl.storage_class & STC.synchronized_) !== 0n)
            stc = (stc | STC.shared_) as STC;
        if (funcdecl.type!.isWild())
            stc = (stc | STC.wild) as STC;
        funcdecl.type = addSTC(funcdecl.type!, stc);

        funcdecl.type = typeSemantic(funcdecl.type!, funcdecl.loc, sc);

        // semantic for parameters' UDAs
        const fUda = getFunctionType(funcdecl);
        if (fUda !== null) {
            // D `foreach (i, param; f.parameterList)` — the expanded-parameter iteration goes through
            // ParameterList.opApply with D's 0=continue control code (05 §11 / 06 §1.8).
            const scUda: Scope = sc;
            fUda.parameterList.opApply((_i: number, param: Parameter | null): number => {
                scUda.userAttribDecl = null;
                if (param !== null && param.userAttribDecl !== null)
                    dsymbolSemantic(param.userAttribDecl, scUda);
                return 0;
            });
        }

        sc = sc.pop()!;
    }

    let f = getFunctionType(funcdecl);
    if (f === null)
        return;     // funcdecl's type is not a function

    {
        // Merge back function attributes into 'originalType'.
        // It's used for mangling, ddoc, and json output.
        const tfo: TypeFunction = funcdecl.originalType!.toTypeFunction();
        tfo.mod = f.mod;
        tfo.isScopeQual = f.isScopeQual;
        tfo.isReturnInferred = f.isReturnInferred;
        tfo.isScopeInferred = f.isScopeInferred;
        tfo.isRef = f.isRef;
        tfo.isNothrow = f.isNothrow;
        tfo.isNogc = f.isNogc;
        tfo.isProperty = f.isProperty;
        tfo.purity = f.purity;
        tfo.trust = f.trust;

        funcdecl.storage_class = (funcdecl.storage_class & ~(STC.TYPECTOR | STC.FUNCATTR)) as STC;
    }

    // check pragma(crt_constructor) signature
    if (funcdecl.isCrtCtor || funcdecl.isCrtDtor) {
        const idStr: DString = funcdecl.isCrtCtor ? ds("crt_constructor") : ds("crt_destructor");
        if (nextOf(f)!.ty !== TY.Tvoid)
            error(funcdecl.loc, ds("%s `%s` must return `void` for `pragma(%s)`"),
                funcdecl.kind(), funcdecl.toPrettyChars(), idStr);
        if (funcdecl._linkage !== LINK.c && f.parameterList.length() !== 0)
            error(funcdecl.loc, ds("%s `%s` must be `extern(C)` for `pragma(%s)` when taking parameters"),
                funcdecl.kind(), funcdecl.toPrettyChars(), idStr);
        if (funcdecl.isThis() !== null)
            error(funcdecl.loc, ds("%s `%s` cannot be a non-static member function for `pragma(%s)`"),
                funcdecl.kind(), funcdecl.toPrettyChars(), idStr);
    }

    if (funcdecl.overnext !== null && funcdecl.isCsymbol()) {
        /* C does not allow function overloading, but it does allow
         * redeclarations of the same function. If .overnext points
         * to a redeclaration, ok. Error if it is an overload.
         */
        const fnext = funcdecl.overnext.isFuncDeclaration()!;
        funcDeclarationSemantic(sc, fnext);
        // `fnext.type!`: funcDeclarationSemantic just ran on fnext, which leaves its type set.
        const fn = fnext.type!.isTypeFunction();
        // dmd/funcsem.d:759 — `if (!fn || !cFuncEquivalence(f, fn) || !cTypeEquivalence(f.next, fn.next))`.
        // `.next!`: a C function type always carries its return type (the importc.ts reading of the same field).
        if (fn === null || !cFuncEquivalence(f, fn) || !cTypeEquivalence(f.next!, fn.next!)) {
            error(funcdecl.loc, ds("%s `%s` redeclaration with different type"),
                funcdecl.kind(), funcdecl.toPrettyChars());
            // dropped: two commented-out printf traces (dmd/funcsem.d:762-763)
        }
        funcdecl.overnext = null;   // don't overload the redeclarations
    }

    if ((funcdecl.storage_class & STC.auto_) !== 0n && !f.isRef && !funcdecl.inferRetType)
        error(funcdecl.loc, ds("%s `%s` storage class `auto` has no effect if return type is not inferred"),
            funcdecl.kind(), funcdecl.toPrettyChars());

    if (f.isReturn && !funcdecl.needThis() && !funcdecl.isNested()) {
        /* Non-static nested functions have a hidden 'this' pointer to which
         * the 'return' applies
         */
        if (sc.scopesym !== null && sc.scopesym.isAggregateDeclaration() !== null)
            error(funcdecl.loc, ds("%s `%s` `static` member has no `this` to which `return` can apply"),
                funcdecl.kind(), funcdecl.toPrettyChars());
        else
            error(funcdecl.loc, ds("top-level function `%s` has no `this` to which `return` can apply"),
                funcdecl.toChars());
    }

    if (funcdecl.isAbstract() && !isVirtual(funcdecl)) {
        let sfunc: DString;
        if (funcdecl.isStatic())
            sfunc = ds("static");
        else if (funcdecl.visibility.kind === Visibility.Kind.private_ ||
                 funcdecl.visibility.kind === Visibility.Kind.package_)
            sfunc = visibilityToChars(funcdecl.visibility.kind);
        else
            sfunc = ds("final");
        error(funcdecl.loc, ds("%s `%s` `%s` functions cannot be `abstract`"),
            funcdecl.kind(), funcdecl.toPrettyChars(), sfunc);
    }

    if (funcdecl.isOverride() && !isVirtual(funcdecl) && funcdecl.isFuncLiteralDeclaration() === null) {
        const kind: Visibility.Kind = funcdecl.visible().kind;
        if ((kind === Visibility.Kind.private_ || kind === Visibility.Kind.package_) &&
            funcdecl.isMember() !== null)
            error(funcdecl.loc, ds("%s `%s` `%s` method is not virtual and cannot override"),
                funcdecl.kind(), funcdecl.toPrettyChars(), visibilityToChars(kind));
        else
            error(funcdecl.loc, ds("%s `%s` cannot override a non-virtual function"),
                funcdecl.kind(), funcdecl.toPrettyChars());
    }

    if (funcdecl.isAbstract() && funcdecl.isFinalFunc())
        error(funcdecl.loc, ds("%s `%s` cannot be both `final` and `abstract`"),
            funcdecl.kind(), funcdecl.toPrettyChars());

    if (funcdecl.printf || funcdecl.scanf) {
        checkPrintfScanfSignature(funcdecl, f, sc);
    }

    const idIface = parent.value.isInterfaceDeclaration();
    if (idIface !== null) {
        funcdecl.storage_class = (funcdecl.storage_class | STC.abstract_) as STC;
        if (funcdecl.isCtorDeclaration() !== null || funcdecl.isPostBlitDeclaration() !== null ||
            funcdecl.isDtorDeclaration() !== null || funcdecl.isInvariantDeclaration() !== null ||
            funcdecl.isNewDeclaration() !== null || funcdecl.isDelete())
            error(funcdecl.loc,
                ds("%s `%s` constructors, destructors, postblits, invariants, new and delete functions are not allowed in interface `%s`"),
                funcdecl.kind(), funcdecl.toPrettyChars(), idIface.toChars());
        if (funcdecl.fbody !== null && isVirtual(funcdecl))
            error(funcdecl.loc, ds("%s `%s` function body only allowed in `final` functions in interface `%s`"),
                funcdecl.kind(), funcdecl.toPrettyChars(), idIface.toChars());
    }

    const ud = parent.value.isUnionDeclaration();
    if (ud !== null) {
        if (funcdecl.isPostBlitDeclaration() !== null || funcdecl.isDtorDeclaration() !== null ||
            funcdecl.isInvariantDeclaration() !== null)
            error(funcdecl.loc, ds("%s `%s` destructors, postblits and invariants are not allowed in union `%s`"),
                funcdecl.kind(), funcdecl.toPrettyChars(), ud.toChars());
    }

    // goto Ldone (funcsem.d:830 / :839) — the SKIP-FLAG shape of 06 §4.1: the `Ldone:` label at
    // funcsem.d:858 is reached BOTH by these two jumps and by fall-through, so every statement
    // between the first jump site and the label is gated on `!gotoLdone`.
    let gotoLdone = false;

    const sd = parent.value.isStructDeclaration();
    if (sd !== null) {
        if (funcdecl.isCtorDeclaration() !== null) {
            gotoLdone = true;                       // goto Ldone (dmd/funcsem.d:830)
        }
    }

    if (!gotoLdone) {
        const cd = parent.value.isClassDeclaration();
        if (cd !== null) {
            switch (classFuncSemantic(cd, funcdecl, parent, sc, f)) {
                case 0: break;
                case 1: gotoLdone = true; break;    // goto Ldone (dmd/funcsem.d:839)
                case 2: return;
                default: assertUnreachable();
            }
        } else if (funcdecl.isOverride() && parent.value.isTemplateInstance() === null)
            error(funcdecl.loc, ds("%s `%s` `override` only applies to class member functions"),
                funcdecl.kind(), funcdecl.toPrettyChars());
    }

    if (!gotoLdone) {
        if (parent.value.isTemplateInstance() !== null) {
            objc()!.setSelector(funcdecl, sc);      // funcsem.d:849
            objc()!.setAsOptional(funcdecl, sc);    // funcsem.d:850
        }

        objc()!.validateSelector(funcdecl);         // funcsem.d:853
        objc()!.validateOptional(funcdecl);         // funcsem.d:854
        // Reflect this.type to f because it could be changed by findVtblIndex
        f = funcdecl.type!.toTypeFunction();
    }

    // Ldone: (funcsem.d:858) — the tail is NOT gated: both routes execute it (06 §4.1 rule ii).
    if (funcdecl.fbody === null) {
        // funcsem.d:859 — `!funcdecl.allowsContractWithoutBody()`. UFCS (04 §6) to the dmd.dsymbolsem
        // free function `allowsContractWithoutBody(FuncDeclaration)`, receiver first. D short-circuits
        // on `!fbody`, so the call stays inside this guard (its own body asserts `fbody is null`).
        if (!allowsContractWithoutBody(funcdecl))
            error(funcdecl.loc,
                ds("%s `%s` `in` and `out` contracts can only appear without a body when they are virtual interface functions or abstract"),
                funcdecl.kind(), funcdecl.toPrettyChars());
    }

    /* Do not allow template instances to add virtual functions
     * to a class.
     */
    if (isVirtual(funcdecl)) {
        let ti = parent.value.isTemplateInstance();
        if (ti !== null) {
            // Take care of nested templates
            while (true) {
                const ti2: TemplateInstance | null = ti!.tempdecl!.parent!.isTemplateInstance();
                if (ti2 === null)
                    break;
                ti = ti2;
            }

            // If it's a member template
            const cdMember = ti!.tempdecl!.isClassMember();
            if (cdMember !== null) {
                error(funcdecl.loc, ds("%s `%s` cannot use template to add virtual function to class `%s`"),
                    funcdecl.kind(), funcdecl.toPrettyChars(), cdMember.toChars());
            }
        }
    }

    checkMain(funcdecl);       // Check main() parameters and return type

    /* Purity and safety can be inferred for some functions by examining
     * the function body.
     */
    if (canInferAttributes(funcdecl, sc))
        initInferAttributes(funcdecl);

    // LDC relies on semanticRun variable not being reset here
    // resolved: `!IN_LLVM || ...` (funcsem.d:895) — IN_LLVM is ON, so only the right operand survives.
    if (funcdecl.semanticRun < PASS.semanticdone)
        funcdecl.semanticRun = PASS.semanticdone;

    /* Save scope for possible later use (if we need the
     * function internals)
     */
    funcdecl._scope = sc.copy();
    funcdecl._scope.setNoFree();

    if (global.params.v.verbose && !printedMain) {
        const type: DString | null = funcdecl.isMain() ? ds("main")
            : funcdecl.isWinMain() ? ds("winmain")
            : funcdecl.isDllMain() ? ds("dllmain") : null;
        const mod: Module | null = sc._module;

        if (type !== null && mod !== null) {
            printedMain = true;
            const name = mod.srcfile.toChars();
            const path = FileName.searchPath(global.importPaths.opSlice(), name, true);
            messageNoLoc(ds("entry     %-10s\t%s"), type, path !== null ? path : name);
        }
    }

    if (funcdecl.fbody !== null && sc._module!.isRoot() &&
        (funcdecl.isMain() || funcdecl.isWinMain() || funcdecl.isDllMain() || funcdecl.isCMain()))
        global.hasMainFunction = true;

    if (funcdecl.fbody !== null && funcdecl.isMain() && sc._module!.isRoot()) {
        // check if `_d_cmain` is defined
        // funcsem.d:926 — nested `bool cmainTemplateExists()` (04 §5: inner `const` arrow, captures sc/funcdecl).
        const scCmain: Scope = sc;
        const cmainTemplateExists = (): boolean => {
            const pscopesym: { value: Dsymbol | null } = { value: null };
            const rootSymbol = searchScope(scCmain, funcdecl.loc, Id.empty!, pscopesym);
            const moduleSymbol = search(rootSymbol!, funcdecl.loc, Id.object!);
            if (moduleSymbol !== null)
                if (search(moduleSymbol, funcdecl.loc, Id.CMain!) !== null)
                    return true;

            return false;
        };

        // Only mixin `_d_cmain` if it is defined
        if (cmainTemplateExists()) {
            // add `mixin _d_cmain!();` to the declaring module
            const tqual = new TypeIdentifier(funcdecl.loc, Id.CMain!);
            const tm = new TemplateMixin(funcdecl.loc, null, tqual, null);
            sc._module!.members!.push(tm);
            if (K.on) keepAppend(sc._module!, tm);   // the kept-module engine: appended again by a replay
        }
    }

    assert(funcdecl.type!.ty !== TY.Terror || funcdecl.errors);
}

/**
 * funcsem.d:904 — `__gshared bool printedMain = false;` inside `funcDeclarationSemantic`
 * ("semantic might run more than once"). Function-`static` becomes module-level state in the port.
 */
let printedMain = false;

/**
 * No D counterpart: the djs driver's reset between two compiles in one process (src/djs.ts
 * `deinitializeFrontend`). `genCfunc`'s table holds functions typed in the finished compile, and
 * `printedMain` would suppress the next compile's `-v` `entry` line.
 */
export function resetFuncsemState(): void {
    genCfuncSt = null;
    printedMain = false;
}

/**
 * dmd/funcsem.d:957 — `private int classFuncSemantic(ClassDeclaration cd, FuncDeclaration funcdecl,
 * ref Dsymbol parent, Scope* sc, TypeFunction f)`.
 *
 * The class-member half of `funcDeclarationSemantic`: vtbl slot assignment, override checking and
 * the interface covariance walk.
 * Returns:
 *    0 if semantic analysis in `funcDeclarationSemantic` should continue as normal
 *    1 if it should skip over some analysis and `goto Ldone;`
 *    2 if `funcDeclarationSemantic` should return early because of forward reference error or
 *        the derived class cd doesn't have its vtbl[] allocated yet
 *
 * `ref Dsymbol parent` is the caller's local, REASSIGNED here (funcsem.d:960) — carried as the
 * out-param box (03 §3.3). Emitted WITHOUT `private`: it is D module-private, reached by this
 * module's own `funcDeclarationSemantic` (01-conventions / 10 §1.7).
 */
function classFuncSemantic(cd: ClassDeclaration, funcdecl: FuncDeclaration,
                           parent: Ref<Dsymbol>, sc: Scope, f: TypeFunction): number {
    // funcsem.d:960 — `parent = cd = objc.getParent(funcdecl, cd);`. D reassigns its parameter `cd`;
    // the port carries the reassigned value in `cdCur`.
    const cdCur: ClassDeclaration = objc()!.getParent(funcdecl, cd);
    parent.value = cdCur;

    if (funcdecl.isCtorDeclaration() !== null) {
        return 1;
    }

    if ((funcdecl.storage_class & STC.abstract_) !== 0n)
        cdCur.isabstract = ThreeState.yes;

    // if static function, do not put in vtbl[]
    if (!isVirtual(funcdecl)) {
        //printf("\tnot virtual\n");
        return 1;
    }
    // Suppress further errors if the return type is an error
    if (nextOf(funcdecl.type!) === Type.terror)
        return 1;

    let may_override = false;
    for (let i = 0; i < cdCur.baseclasses.length; i++) {
        const b: BaseClass = cdCur.baseclasses.opIndex(i)!;
        const cbd = toBasetype(b.type!).isClassHandle();
        if (cbd === null)
            continue;
        for (let j = 0; j < cbd.vtbl.length; j++) {
            const f2 = cbd.vtbl.opIndex(j)!.isFuncDeclaration();
            if (f2 === null || f2.ident !== funcdecl.ident)
                continue;
            if (cbd.parent !== null && cbd.parent.isTemplateInstance() !== null) {
                if (!functionSemantic(f2))
                    return 1;
            }
            may_override = true;
        }
    }
    if (may_override && nextOf(funcdecl.type!) === null) {
        /* If same name function exists in base class but 'this' is auto return,
         * cannot find index of base class's vtbl[] to override.
         */
        error(funcdecl.loc,
            ds("%s `%s` return type inference is not supported if may override base class function"),
            funcdecl.kind(), funcdecl.toPrettyChars());
    }

    /* Find index of existing function in base class's vtbl[] to override
     * (the index will be the same as in cd's current vtbl[])
     */
    let vi: number = cdCur.baseClass !== null ? findVtblIndex(funcdecl, cdCur.baseClass.vtbl.opSlice()) : -1;

    let doesoverride = false;

    /* `Lintro:` (funcsem.d:1017) — the RETRY/shared-arm target of two `goto Lintro;` in the
     * `default:` arm (funcsem.d:1151, :1171). Both jumps enter the top of `case -1:`'s body and then
     * fall out of the switch at the `break` on funcsem.d:1109, so the label's body is extracted to a
     * zero-param nested arrow (06 §4 BAIL spelling — it captures every loop-carried local, never
     * takes them positionally) and each jump site becomes `Lintro(); break;`.
     */
    const Lintro = (): void => {
        /* Didn't find one, so
         * This is an 'introducing' function which gets a new
         * slot in the vtbl[].
         */

        // Verify this doesn't override previous final function
        if (cdCur.baseClass !== null) {
            const s = search(cdCur.baseClass, funcdecl.loc, funcdecl.ident!);
            if (s !== null) {
                let f2 = s.isFuncDeclaration();
                if (f2 !== null) {
                    f2 = overloadExactMatch(f2, funcdecl.type!);
                    if (f2 !== null && f2.isFinalFunc() && f2.visible().kind !== Visibility.Kind.private_)
                        error(funcdecl.loc, ds("%s `%s` cannot override `final` function `%s`"),
                            funcdecl.kind(), funcdecl.toPrettyChars(), f2.toPrettyChars());
                }
            }
        }

        /* These quirky conditions mimic what happens when virtual
           inheritance is implemented by producing a virtual base table
           with offsets to each of the virtual bases.
         */
        if (target.cpp.splitVBasetable && cdCur.classKind === ClassKind.cpp &&
            cdCur.baseClass !== null && cdCur.baseClass.vtbl.length !== 0) {
            /* if overriding an interface function, then this is not
             * introducing and don't put it in the class vtbl[]
             */
            funcdecl.interfaceVirtual = overrideInterface(funcdecl);
            if (funcdecl.interfaceVirtual !== null) {
                //printf("\tinterface function %s\n", toChars());
                cdCur.vtblFinal.push(funcdecl);
                // goto Linterfaces (dmd/funcsem.d:1053): `Linterfaces:` is the switch's own
                // fall-through continuation, so leaving this arm IS the jump.
                return;
            }
        }

        if (funcdecl.isFinalFunc()) {
            // Don't check here, as it may override an interface function
            //if (isOverride())
            //    error("is marked as override, but does not override any function");
            cdCur.vtblFinal.push(funcdecl);
        } else {
            //printf("\tintroducing function %s\n", funcdecl.toChars());
            funcdecl.isIntroducing = true;
            if (cdCur.classKind === ClassKind.cpp && target.cpp.reverseOverloads) {
                /* Overloaded functions with same name are grouped and in reverse order.
                 * Search for first function of overload group, and insert
                 * funcdecl into vtbl[] immediately before it.
                 */
                funcdecl.vtblIndex = cdCur.vtbl.length;
                let found = false;
                for (const [i, s] of cdCur.vtbl.opSlice().entries()) {
                    if (found)
                        // the rest get shifted forward
                        ++s!.isFuncDeclaration()!.vtblIndex;
                    else if (s!.ident === funcdecl.ident && s!.parent === parent.value) {
                        // found first function of overload group
                        funcdecl.vtblIndex = i;
                        found = true;
                        ++s!.isFuncDeclaration()!.vtblIndex;
                    }
                }
                cdCur.vtbl.insert(funcdecl.vtblIndex, funcdecl);

                // dropped: `debug foreach (const i, s; cd.vtbl) { assert(...) }` (funcsem.d:1091-1099)
                // — a `debug` block; debug is OFF for this port (_config.md §3).
            } else {
                // Append to end of vtbl[]
                vi = cdCur.vtbl.length;
                cdCur.vtbl.push(funcdecl);
                funcdecl.vtblIndex = vi;
            }
        }
    };

    switch (vi) {
    case -1:
        Lintro();
        break;

    case -2:
        // can't determine because of forward references
        funcdecl.errors = true;
        return 2;

    default:
        {
            if (vi >= cdCur.vtbl.length) {
                /* the derived class cd doesn't have its vtbl[] allocated yet.
                 * https://issues.dlang.org/show_bug.cgi?id=21008
                 */
                error(funcdecl.loc, ds("%s `%s` circular reference to class `%s`"),
                    funcdecl.kind(), funcdecl.toPrettyChars(), cdCur.toChars());
                funcdecl.errors = true;
                return 2;
            }
            const fdv = cdCur.baseClass!.vtbl.opIndex(vi)!.isFuncDeclaration()!;
            const fdc = cdCur.vtbl.opIndex(vi)!.isFuncDeclaration()!;
            // This function is covariant with fdv

            if (fdc === funcdecl) {
                doesoverride = true;
                break;
            }

            const vtf = getFunctionType(fdv)!;
            if (vtf.trust > TRUST.system && f.trust === TRUST.system)
                error(funcdecl.loc, ds("%s `%s` cannot override `@safe` method `%s` with a `@system` attribute"),
                    funcdecl.kind(), funcdecl.toPrettyChars(), fdv.toPrettyChars());

            if (fdc.toParent() === parent.value) {
                // fdc overrides fdv exactly, then this introduces new function.
                if (fdc.type!.mod === fdv.type!.mod && funcdecl.type!.mod !== fdv.type!.mod) {
                    Lintro();                       // goto Lintro (dmd/funcsem.d:1151)
                    break;
                }
            }

            if (fdv.isDeprecated() && !funcdecl.isDeprecated())
                deprecation(funcdecl.loc, ds("`%s` is overriding the deprecated method `%s`"),
                    funcdecl.toPrettyChars(), fdv.toPrettyChars());

            // This function overrides fdv
            if (fdv.isFinalFunc())
                error(funcdecl.loc, ds("%s `%s` cannot override `final` function `%s`"),
                    funcdecl.kind(), funcdecl.toPrettyChars(), fdv.toPrettyChars());

            if (!funcdecl.isOverride()) {
                if (fdv.isFuture()) {
                    deprecation(funcdecl.loc,
                        ds("method `%s` implicitly overrides `@__future` base class method; rename the former"),
                        funcdecl.toPrettyChars());
                    deprecationSupplemental(fdv.loc, ds("base method `%s` defined here"), fdv.toPrettyChars());
                    // Treat 'this' as an introducing function, giving it a separate hierarchy in the vtbl[]
                    Lintro();                       // goto Lintro (dmd/funcsem.d:1171)
                    break;
                } else {
                    // https://issues.dlang.org/show_bug.cgi?id=17349
                    error(funcdecl.loc,
                        ds("cannot implicitly override base class method `%s` with `%s`; add `override` attribute"),
                        fdv.toPrettyChars(), funcdecl.toPrettyChars());
                }
            }
            doesoverride = true;
            let brokeOut = false;
            if (fdc.toParent() === parent.value) {
                // If both are mixins, or both are not, then error.
                // If either is not, the one that is not overrides the other.
                const thismixin = funcdecl.parent!.isClassDeclaration() !== null;
                const fdcmixin = fdc.parent!.isClassDeclaration() !== null;
                if (thismixin === fdcmixin) {
                    error(funcdecl.loc, ds("%s `%s` multiple overrides of same function"),
                        funcdecl.kind(), funcdecl.toPrettyChars());
                }
                /*
                 * https://issues.dlang.org/show_bug.cgi?id=711
                 *
                 * If an overriding method is introduced through a mixin,
                 * we need to update the vtbl so that both methods are
                 * present.
                 */
                else if (thismixin) {
                    /* if the mixin introduced the overriding method, then reintroduce it
                     * in the vtbl. The initial entry for the mixined method
                     * will be updated at the end of the enclosing `if` block
                     * to point to the current (non-mixined) function.
                     */
                    const vitmp = cdCur.vtbl.length;
                    cdCur.vtbl.push(fdc);
                    fdc.vtblIndex = vitmp;
                } else if (fdcmixin) {
                    /* if the current overriding function is coming from a
                     * mixined block, then push the current function in the
                     * vtbl, but keep the previous (non-mixined) function as
                     * the overriding one.
                     */
                    const vitmp = cdCur.vtbl.length;
                    cdCur.vtbl.push(funcdecl);
                    funcdecl.vtblIndex = vitmp;
                    brokeOut = true;                // D `break;` out of the switch (funcsem.d:1219)
                } else { // fdc overrides fdv
                    // this doesn't override any function
                    brokeOut = true;                // D `break;` out of the switch (funcsem.d:1224)
                }
            }
            if (!brokeOut) {
                cdCur.vtbl.opIndexAssign(funcdecl, vi);
                funcdecl.vtblIndex = vi;

                /* Remember which functions this overrides
                 */
                funcdecl.foverrides.push(fdv);

                /* This works by whenever this function is called,
                 * it actually returns tintro, which gets dynamically
                 * cast to type. But we know that tintro is a base
                 * of type, so we could optimize it by not doing a
                 * dynamic cast, but just subtracting the isBaseOf()
                 * offset if the value is != null.
                 */

                if (fdv.tintro !== null)
                    funcdecl.tintro = fdv.tintro;
                else if (!funcdecl.type!.equals(fdv.type)) {
                    const tnext = nextOf(funcdecl.type!);
                    const handle = tnext!.isClassHandle();
                    if (handle !== null) {
                        if (handle.semanticRun < PASS.semanticdone && !handle.isBaseInfoComplete())
                            dsymbolSemantic(handle, null);
                    }
                    /* Only need to have a tintro if the vptr
                     * offsets differ
                     */
                    const offset: Ref<number> = { value: 0 };
                    if (isBaseOf(nextOf(fdv.type!)!, tnext, offset)) {
                        funcdecl.tintro = fdv.type;
                    }
                }
            }
            break;
        }
    }

    /* Go through all the interface bases.
     * If this function is covariant with any members of those interface
     * functions, set the tintro.
     */
    // Linterfaces: (funcsem.d:1269) — reached by fall-through and by the `goto` inside `Lintro`.
    let foundVtblMatch = false;

    for (let bcd: ClassDeclaration | null = cdCur; !foundVtblMatch && bcd !== null; bcd = bcd.baseClass) {
        // D `foreach (b; bcd.interfaces)` over a possibly-null slice: 0 iterations if null (06 §2.7).
        for (const b of bcd.interfaces ?? []) {
            vi = findVtblIndex(funcdecl, b!.sym!.vtbl.opSlice());
            switch (vi) {
            case -1:
                break;

            case -2:
                // can't determine because of forward references
                funcdecl.errors = true;
                return 2;

            default:
                {
                    // D `cast(FuncDeclaration)b.sym.vtbl[vi]` — the checked downcast (05 §10).
                    const fdv = b!.sym!.vtbl.opIndex(vi)!.isFuncDeclaration()!;
                    let ti: Type | null = null;

                    foundVtblMatch = true;

                    /* Remember which functions this overrides
                     */
                    funcdecl.foverrides.push(fdv);

                    if (fdv.tintro !== null)
                        ti = fdv.tintro;
                    else if (!funcdecl.type!.equals(fdv.type)) {
                        /* Only need to have a tintro if the vptr
                         * offsets differ
                         */
                        const offset: Ref<number> = { value: 0 };
                        if (isBaseOf(nextOf(fdv.type!)!, nextOf(funcdecl.type!), offset)) {
                            ti = fdv.type;
                        }
                    }
                    if (ti !== null) {
                        if (funcdecl.tintro !== null) {
                            if (!nextOf(funcdecl.tintro)!.equals(nextOf(ti)) &&
                                !isBaseOf(nextOf(funcdecl.tintro)!, nextOf(ti), null) &&
                                !isBaseOf(nextOf(ti)!, nextOf(funcdecl.tintro), null)) {
                                error(funcdecl.loc, ds("%s `%s` incompatible covariant types `%s` and `%s`"),
                                    funcdecl.kind(), funcdecl.toPrettyChars(),
                                    funcdecl.tintro.toChars(), ti.toChars());
                            }
                        } else {
                            funcdecl.tintro = ti;
                        }
                    }
                }
            }
        }
    }

    // goto L2 (funcsem.d:1331) — the SKIP-FLAG shape (06 §4.1): `L2:` at funcsem.d:1461 is reached
    // both by this jump and by fall-through, so the single statement between them is gated.
    let gotoL2 = false;
    if (foundVtblMatch) {
        gotoL2 = true;
    }

    if (!gotoL2 && !doesoverride && funcdecl.isOverride() &&
        (nextOf(funcdecl.type!) !== null || !may_override)) {
        let bc: BaseClass | null = null;
        let s: Dsymbol | null = null;
        for (let i = 0; i < cdCur.baseclasses.length; i++) {
            bc = cdCur.baseclasses.opIndex(i);
            s = search_correct(bc!.sym!, funcdecl.ident!);
            if (s !== null)
                break;
        }

        if (s !== null) {
            const hgs = new HdrGenState();
            const buf = new OutBuffer();

            const fd = s.isFuncDeclaration();
            // funcsem.d:1352 — `functionToBufferFull(cast(TypeFunction)(funcdecl.type), buf,`; callee live
            // at dmd/hdrgen.d:3565.
            // D's `cast(TypeFunction)` is an unchecked RTTI downcast (02 §11.5c #3): every
            // FuncDeclaration's type is a TypeFunction. `new Identifier(const(char)*)` is the
            // non-interned ctor, whose TS spelling is the `Identifier.create` factory (identifier.d:86).
            functionToBufferFull(funcdecl.type!.isTypeFunction()!, buf, Identifier.create(funcdecl.toPrettyChars()),
                hgs, null);
            const funcdeclToChars = buf.peekChars();

            if (fd !== null) {
                const buf1 = new OutBuffer();

                if (fd.ident === funcdecl.ident)
                    hgs.fullQual = true;

                // https://issues.dlang.org/show_bug.cgi?id=23745
                // If the potentially overridden function contains errors,
                // inform the user to fix that one first
                if (fd.errors) {
                    error(funcdecl.loc,
                        ds("function `%s` does not override any function, did you mean to override `%s`?"),
                        funcdecl.toChars(), fd.toPrettyChars());
                    errorSupplemental(fd.loc,
                        ds("Function `%s` contains errors in its declaration, therefore it cannot be correctly overridden"),
                        fd.toPrettyChars());
                } else if (fd.isFinalFunc()) {
                    // When trying to override a final method, don't suggest it as a candidate(Issue #19613)
                    error(funcdecl.loc, ds("%s `%s` does not override any function"),
                        funcdecl.kind(), funcdecl.toPrettyChars());

                    // Look for a non-final method with the same name to suggest as an alternative
                    const cdparent = fd.parent !== null ? fd.parent.isClassDeclaration() : null;
                    if (cdparent !== null) {
                        // D's `Dsymbol nonFinalAlt` is written from inside the overloadApply closure, so
                        // it is a one-slot box (02 §11.4): a plain local keeps its `null` flow type.
                        const nonFinalAlt: { value: Dsymbol | null } = { value: null };

                        const overloadableSyms = cdparent.symtab!.lookup(fd.ident!);
                        if (overloadableSyms !== null) {
                            // Check each overload to find one that's not final
                            overloadApply(overloadableSyms, (sOv: Dsymbol): number => {
                                const funcAlt = sOv.isFuncDeclaration();
                                if (funcAlt !== null) {
                                    if (funcAlt !== fd && !funcAlt.isFinalFunc()) {
                                        nonFinalAlt.value = funcAlt;
                                        return 1;
                                    }
                                }
                                return 0;
                            });

                            // Provide a helpful suggestion if we found a viable alternative
                            if (nonFinalAlt.value !== null) {
                                const funcAlt = nonFinalAlt.value.isFuncDeclaration()!;
                                const buf2 = new OutBuffer();
                                // funcsem.d:1406 — `functionToBufferFull(cast(TypeFunction)(funcAlt.type), buf2,`
                                // (as at :1352).
                                functionToBufferFull(funcAlt.type!.isTypeFunction()!, buf2,
                                    Identifier.create(funcAlt.toPrettyChars()), hgs, null);
                                errorSupplemental(funcdecl.loc, ds("Did you mean to override `%s`?"),
                                    buf2.peekChars());
                            }
                        }
                    }
                } else {
                    // funcsem.d:1415 — `functionToBufferFull(cast(TypeFunction)(fd.type), buf1,` (as at :1352).
                    functionToBufferFull(fd.type!.isTypeFunction()!, buf1, Identifier.create(fd.toPrettyChars()), hgs,
                        null);

                    error(funcdecl.loc, ds("function `%s` does not override any function"), funcdeclToChars);
                    errorSupplemental(fd.loc, ds("did you mean to override `%s`?"), buf1.peekChars());

                    // Supplemental error for parameter scope differences
                    const tf1 = funcdecl.type!.isTypeFunction();
                    const tf2 = fd.type!.isTypeFunction();

                    if (tf1 !== null && tf2 !== null) {
                        // struct read out of a class field (03 §1 #6). `ParameterList` is a value
                        // struct with live in-scope mutators (mtype.ts `parameters`/`hasIdentifierList`),
                        // so it is NOT a 03 §9.1 register member and the copy is emitted, not elided.
                        const params1 = tf1.parameterList.copy();
                        const params2 = tf2.parameterList.copy();

                        if (params1.length() === params2.length()) {
                            for (let i = 0; i < params1.length(); i++) {
                                const p1 = params1.opIndex(i)!;
                                const p2 = params2.opIndex(i)!;

                                if ((p1.storageClass & STC.scope_) === (p2.storageClass & STC.scope_))
                                    continue;

                                if ((p2.storageClass & STC.scope_) === 0n)
                                    continue;

                                errorSupplemental(funcdecl.loc, ds("parameter %d is missing `scope`"), i + 1);
                            }
                        }
                    }
                }
            } else {
                error(funcdecl.loc,
                    ds("function `%s` does not override any function, did you mean to override %s `%s`?"),
                    funcdeclToChars, s.kind(), s.toPrettyChars());
                errorSupplemental(funcdecl.loc,
                    ds("Functions are the only declarations that may be overridden"));
            }
        } else
            error(funcdecl.loc, ds("%s `%s` does not override any function"),
                funcdecl.kind(), funcdecl.toPrettyChars());
    }

    // L2: (funcsem.d:1461) — the shared tail; not gated (06 §4.1 rule ii).
    objc()!.setSelector(funcdecl, sc);             // funcsem.d:1462
    objc()!.checkLinkage(funcdecl);                // funcsem.d:1463
    objc()!.addToClassMethodList(funcdecl, cdCur); // funcsem.d:1464
    objc()!.setAsOptional(funcdecl, sc);           // funcsem.d:1465

    /* Go through all the interface bases.
     * Disallow overriding any final functions in the interface(s).
     */
    for (const b of cdCur.interfaces ?? []) {
        if (b!.sym !== null) {
            const s = search_function(b!.sym!, funcdecl.ident!);
            if (s !== null) {
                let f2 = s.isFuncDeclaration();
                if (f2 !== null) {
                    f2 = overloadExactMatch(f2, funcdecl.type!);
                    if (f2 !== null && f2.isFinalFunc() && f2.visible().kind !== Visibility.Kind.private_)
                        error(funcdecl.loc, ds("%s `%s` cannot override `final` function `%s.%s`"),
                            funcdecl.kind(), funcdecl.toPrettyChars(), b!.sym!.toChars(), f2.toPrettyChars());
                }
            }
        }
    }

    if (funcdecl.isOverride()) {
        if ((funcdecl.storage_class & STC.disable) !== 0n)
            deprecation(funcdecl.loc,
                ds("`%s` cannot be annotated with `@disable` because it is overriding a function in the base class"),
                funcdecl.toPrettyChars());

        if (funcdecl.isDeprecated() &&
            !(funcdecl.foverrides.length !== 0 && funcdecl.foverrides.opIndex(0)!.isDeprecated()))
            deprecation(funcdecl.loc,
                ds("`%s` cannot be marked as `deprecated` because it is overriding a function in the base class"),
                funcdecl.toPrettyChars());
    }
    return 0;
}

/**
 * dmd/funcsem.d:1501 — `private TypeFunction getFunctionType(FuncDeclaration fd)`.
 * Return `fd.type` as a TypeFunction, or null after flagging an error if it is not a function type.
 * Emitted WITHOUT `private`: D module-private, reached by sibling functions in this module.
 */
function getFunctionType(fd: FuncDeclaration): TypeFunction | null {
    const tf = fd.type!.isTypeFunction();
    if (tf !== null)
        return tf;

    if (fd.type!.isTypeError() === null) {
        error(fd.loc, ds("%s `%s` `%s` must be a function instead of `%s`"),
            fd.kind(), fd.toPrettyChars(), fd.toChars(), fd.type!.toChars());
        fd.type = Type.terror;
    }
    fd.errors = true;
    return null;
}

/*****************************************
 * dmd/funcsem.d:1518 — `private void initInferAttributes(FuncDeclaration fd)`.
 * Initialize for inferring the attributes of this function.
 */
function initInferAttributes(fd: FuncDeclaration): void {
    //printf("initInferAttributes() for %s (%s)\n", toPrettyChars(), ident.toChars());
    const tf: TypeFunction = fd.type!.toTypeFunction();
    if (tf.purity === PURE.impure) // purity not specified
        fd.purityInprocess = true;

    if (tf.trust === TRUST.default_)
        fd.safetyInprocess = true;

    if (!tf.isNothrow)
        fd.nothrowInprocess = true;

    if (!tf.isNogc)
        fd.nogcInprocess = true;

    // Initialize for inferring STC.scope_
    fd.scopeInprocess = true;
}

/****************************************************
 * dmd/funcsem.d:1547 — `public bool functionSemantic(FuncDeclaration fd)`.
 * Resolve forward reference of function signature — parameter types, return type, and attributes.
 * Params:
 *  fd = function declaration
 * Returns:
 *  false if any errors exist in the signature.
 */
export function functionSemantic(fd: FuncDeclaration): boolean {
    //printf("functionSemantic() %p %s\n", this, toChars());
    if (fd._scope === null)
        return !fd.errors;

    fd.cppnamespace_set(fd._scope.namespace);

    if (fd.originalType === null) { // semantic not yet run
        const spec: TemplateInstance | null = fd.isSpeculative();
        const olderrs = global.errors;
        const oldgag = global.gag;
        if (global.gag !== 0 && spec === null)
            global.gag = 0;
        // 11 §2.5: the guarded region calls into a file that still carries walls, and a wall throw is
        // an exit path D does not have — a set/reset pair whose region can contain a wall MUST be a
        // `try`/`finally` in the port, or the leaked `global.gag = 0` poisons every later gagged
        // speculation in the process. D needs no guard here (funcsem.d:1561-1563).
        try {
            dsymbolSemantic(fd, fd._scope);
        } finally {
            global.gag = oldgag;
        }
        if (spec !== null && global.errors !== olderrs)
            spec.errors = (global.errors - olderrs !== 0);
        if (olderrs !== global.errors) // if errors compiling this function
            return false;
    }

    if (fd.deferred3) // wait until final round of deferred semantic
        return !fd.errors;
    if (fd._scope !== null && fd._scope.deferSemantic3InCompilerHook && !fd.errors) {
        fd._scope.deferSemantic3InCompilerHook = false;
        addDeferredSemantic3(fd);
        return !fd.errors;
    }

    // if inferring return type, sematic3 needs to be run
    // - When the function body contains any errors, we cannot assume
    //   the inferred return type is valid.
    //   So, the body errors should become the function signature error.
    // the kept-module engine: a kept function's type holds the return type its pending semantic3 infers (keepInfers)
    if (fd.inferRetType && fd.type !== null && (nextOf(fd.type) === null || (K.on && keepInfers(fd))))
        return functionSemantic3(fd);

    let ti: TemplateInstance | null;
    if (fd.isInstantiated() !== null && !isVirtualMethod(fd) &&
        ((ti = fd.parent!.isTemplateInstance()) === null || ti.isTemplateMixin() !== null ||
         ti.tempdecl!.ident === fd.ident)) {
        const ad: AggregateDeclaration | null = fd.isMemberLocal();
        if (ad !== null && ad.sizeok !== Sizeok.done) {
            /* Currently dmd cannot resolve forward references per methods,
             * then setting SIZOKfwd is too conservative and would break existing code.
             * So, just stop method attributes inference until ad.dsymbolSemantic() done.
             */
            //ad.sizeok = Sizeok.fwd;
        } else
            return functionSemantic3(fd) || !fd.errors;
    }

    if ((fd.storage_class & STC.inference) !== 0n)
        return functionSemantic3(fd) || !fd.errors;

    return !fd.errors;
}

/****************************************************
 * dmd/funcsem.d:1614 — `public bool functionSemantic3(FuncDeclaration fd)`.
 * Resolve forward reference of function body.
 * Returns false if any errors exist in the body.
 */
export function functionSemantic3(fd: FuncDeclaration): boolean {
    if (!fd.deferred3 && fd.semanticRun < PASS.semantic3 && fd._scope !== null) {
        /* Forward reference - we need to run semantic3 on this function.
         * If errors are gagged, and it's not part of a template instance,
         * we need to temporarily ungag errors.
         */
        const spec: TemplateInstance | null = fd.isSpeculative();
        const olderrs = global.errors;
        const oldgag = global.gag;
        // resolved: `(!IN_LLVM || !global.gaggedForInlining)` (funcsem.d:1625) — IN_LLVM is ON, so
        // only the right operand survives.
        if (global.gag !== 0 && spec === null && !global.gaggedForInlining)
            global.gag = 0;
        // 11 §2.5 set/reset pair over a wall-bearing region — see the twin in `functionSemantic`.
        // D needs no guard here (funcsem.d:1626-1628).
        try {
            semantic3(fd, fd._scope);
        } finally {
            global.gag = oldgag;
        }

        // If it is a speculatively-instantiated template, and errors occur,
        // we need to mark the template as having errors.
        if (spec !== null && global.errors !== olderrs)
            spec.errors = (global.errors - olderrs !== 0);
        if (olderrs !== global.errors) // if errors compiling this function
            return false;
    } else if (K.on)
        keepReq(fd, KeepUnit.fsem3);   // the kept-module engine: a request of a unit that ran

    return !fd.errors && !fd.hasSemantic3Errors;
}

// called from semantic3
/**
 * dmd/funcsem.d:1648 — `extern (D) void declareThis(FuncDeclaration fd, Scope* sc)`.
 *
 * Creates and returns the hidden parameters for this function declaration.
 *
 * Hidden parameters include the `this` parameter of a class, struct or
 * nested function and the selector parameter for Objective-C methods.
 */
export function declareThis(fd: FuncDeclaration, sc: Scope): void {
    const dualCtx = (fd.toParent2() !== fd.toParentLocal());
    if (dualCtx)
        fd.hasDualContext = true;

    const ad: AggregateDeclaration | null = fd.isThis();
    if (!dualCtx && ad === null && !fd.isNested()) {
        fd.vthis = null;
        fd.objc.selectorParameter = null;
        return;
    }

    // funcsem.d:1662 — nested `Type addModStc(Type t)` (04 §5: inner `const` arrow, captures `fd`).
    const addModStc = (t: Type): Type => {
        return addStorageClass(addMod(t, fd.type!.mod), fd.storage_class);
    };

    if (dualCtx || fd.isNested()) {
        /* The 'this' for a nested function is the link to the
         * enclosing function's stack frame.
         * Note that nested functions and member functions are disjoint.
         */
        const tthis: Type = addModStc(dualCtx
            ? pointerTo(sarrayOf(Type.tvoidptr, 2n))
            : pointerTo(Type.tvoid));
        fd.vthis = new VarDeclaration(fd.loc, tthis, (dualCtx ? Id.this2 : Id.capture)!, null);
        fd.vthis.storage_class = (fd.vthis.storage_class | STC.parameter | STC.nodtor) as STC;
    } else if (ad !== null) {
        const thandle: Type = addModStc(ad.handleType()!);
        fd.vthis = new ThisDeclaration(fd.loc, thandle);
        fd.vthis.storage_class = (fd.vthis.storage_class | STC.parameter) as STC;
        if (thandle.ty === TY.Tstruct) {
            fd.vthis.storage_class = (fd.vthis.storage_class | STC.ref_) as STC;
        }
    }

    const tf = fd.type!.isTypeFunction();
    if (tf !== null) {
        if (tf.isReturn)
            fd.vthis!.storage_class = (fd.vthis!.storage_class | STC.return_) as STC;
        if (tf.isScopeQual)
            fd.vthis!.storage_class = (fd.vthis!.storage_class | STC.scope_) as STC;
        if (tf.isReturnScope)
            fd.vthis!.storage_class = (fd.vthis!.storage_class | STC.returnScope) as STC;
    }

    dsymbolSemantic(fd.vthis!, sc);
    if (insert(sc, fd.vthis!) === null)
        assertUnreachable();
    fd.vthis!.parent = fd;
    if (ad !== null)
        fd.objc.selectorParameter = objc()!.createSelectorParameter(fd, sc); // funcsem.d:1705
}

/****************************************************
 * dmd/funcsem.d:1712 — `extern (D) bool checkForwardRef(FuncDeclaration fd, Loc loc)`.
 * Check that this function type is properly resolved.
 * If not, report "forward reference error" and return true.
 */
export function checkForwardRef(fd: FuncDeclaration, loc: Loc): boolean {
    if (!functionSemantic(fd))
        return true;

    /* No deco means the functionSemantic() call could not resolve
     * forward referenes in the type of this function.
     */
    if (fd.type!.deco === null) {
        const inSemantic3 = (fd.inferRetType && fd.semanticRun >= PASS.semantic3);
        error(loc, ds("forward reference to %s`%s`"),
            inSemantic3 ? ds("inferred return type of function ") : ds(""),
            fd.toChars());
        return true;
    }
    return false;
}

/*************************************************
 * dmd/funcsem.d:1742 — `int findVtblIndex(FuncDeclaration fd, Dsymbol[] vtbl)`.
 * Find index of function in vtbl[0..length] that this function overrides.
 * Prefer an exact match to a covariant one.
 * Params:
 *      fd       = function
 *      vtbl     = vtable to use
 * Returns:
 *      -1      didn't find one
 *      -2      can't determine because of forward references
 */
export function findVtblIndex(fd: FuncDeclaration, vtbl: (Dsymbol | null)[]): number {
    //printf("findVtblIndex() %s\n", toChars());
    // (funcsem.d:1745 `import dmd.typesem : covariant;` — resolved by the module-level import here.)

    let mismatch: FuncDeclaration | null = null;
    let mismatchstc: STC = STC.none;
    let mismatchvi = -1;
    let exactvi = -1;
    let bestvi = -1;
    for (let vi = 0; vi < vtbl.length; vi++) {
        const fdv = vtbl[vi]!.isFuncDeclaration();
        if (fdv === null || fdv.ident !== fd.ident)
            continue;

        if (fd.type!.equals(fdv.type)) { // if exact match
            if (fdv.parent!.isClassDeclaration() !== null) {
                if (fdv.isFuture()) {
                    bestvi = vi;
                    continue;           // keep looking
                }
                return vi; // no need to look further
            }

            if (exactvi >= 0) {
                error(fd.loc, ds("%s `%s` cannot determine overridden function"),
                    fd.kind(), fd.toPrettyChars());
                return exactvi;
            }
            exactvi = vi;
            bestvi = vi;
            continue;
        }

        const stc: Ref<STC> = { value: STC.none };
        const cov = covariant(fd.type!, fdv.type!, stc);
        //printf("\tbaseclass cov = %d\n", cov);
        switch (cov) {
        case Covariant.distinct:
            // types are distinct
            break;

        case Covariant.yes:
            bestvi = vi; // covariant, but not identical
            break;
            // keep looking for an exact match

        case Covariant.no:
            mismatchvi = vi;
            mismatchstc = stc.value;
            mismatch = fdv; // overrides, but is not covariant
            break;
            // keep looking for an exact match

        case Covariant.fwdref:
            return -2; // forward references

        default: { // D `final switch` exhaustiveness (06 §3.2)
            const _e: never = cov;
            void _e;
            throw new SwitchError();   // D default message: "No appropriate switch clause found"
        }
        }
    }
    if (fd._linkage === LINK.cpp && bestvi !== -1) {
        const stc: Ref<STC> = { value: STC.none };
        const fdv = vtbl[bestvi]!.isFuncDeclaration();
        assert(fdv !== null && fdv.ident === fd.ident);
        if (covariant(fd.type!, fdv!.type!, stc, /*cppCovariant=*/true) === Covariant.no) {
            /* https://issues.dlang.org/show_bug.cgi?id=22351
             * Under D rules, `type` and `fdv.type` are covariant, but under C++ rules, they are not.
             * For now, continue to allow D covariant rules to apply when `override` has been used,
             * but issue a deprecation warning that this behaviour will change in the future.
             * Otherwise, follow the C++ covariant rules, which will create a new vtable entry.
             */
            if (fd.isOverride()) {
                /* @@@DEPRECATED_2.110@@@
                 * After deprecation period has ended, be sure to remove this entire `LINK.cpp` branch,
                 * but also the `cppCovariant` parameter from Type.covariant, and update the function
                 * so that both `LINK.cpp` covariant conditions within are always checked.
                 */
                // funcsem.d:1826/:1827 — `…parameterList.parametersTypeToChars()` twice, on DIFFERENT
                // receivers. UFCS onto the free function authorised by hdrgen.d:3618 (04 §6); D takes
                // `ParameterList` BY VALUE, so the call site copies (03 §1 #2).
                deprecation(fd.loc,
                    ds("overriding `extern(C++)` function `%s%s` with `const` qualified function `%s%s%s` is deprecated"),
                    fdv!.toPrettyChars(), parametersTypeToChars(fdv!.type!.toTypeFunction().parameterList.copy()),
                    fd.toPrettyChars(), parametersTypeToChars(fd.type!.toTypeFunction().parameterList.copy()),
                    fd.type!.modToChars());

                const where: DString = fd.type!.isNaked() ? ds("parameters") : ds("type");
                deprecationSupplemental(fd.loc,
                    ds("Either remove `override`, or adjust the `const` qualifiers of the overriding function %s"),
                    where);
            } else {
                // Treat as if Covariant.no
                mismatchvi = bestvi;
                mismatchstc = stc.value;
                mismatch = fdv;
                bestvi = -1;
            }
        }
    }
    if (bestvi === -1 && mismatch !== null) {
        //type.print();
        //mismatch.type.print();
        //printf("%s %s\n", type.deco, mismatch.type.deco);
        //printf("stc = %llx\n", mismatchstc);
        if (mismatchstc !== 0n) {
            // Fix it by modifying the type to add the storage classes
            fd.type = addStorageClass(fd.type!, mismatchstc);
            bestvi = mismatchvi;
        }
    }
    return bestvi;
}

/*********************************
 * dmd/funcsem.d:1867 — `BaseClass* overrideInterface(FuncDeclaration fd)`.
 * If function is a function in a base class, return that base class.
 * Params:
 *  fd = function
 * Returns:
 *  base class if overriding, null if not
 */
export function overrideInterface(fd: FuncDeclaration): BaseClass | null {
    for (let cd: ClassDeclaration | null = fd.toParent2()!.isClassDeclaration();
         cd !== null; cd = cd.baseClass) {
        for (const b of cd.interfaces ?? []) {
            const v = findVtblIndex(fd, b!.sym!.vtbl.opSlice());
            if (v >= 0)
                return b;
        }
    }
    return null;
}

/// Flag used by $(LREF resolveFuncCall). dmd/funcsem.d:1882 — `enum FuncResolveFlag : ubyte`.
export enum FuncResolveFlag {
    standard = 0,       /// issue error messages, solve the call.
    quiet = 1,          /// do not issue error message on no match, just return `null`.
    overloadOnly = 2,   /// only resolve overloads, i.e. do not issue error on ambiguous
                        /// matches and need explicit this.
    ufcs = 4,           /// trying to resolve UFCS call
}

/*******************************************
 * dmd/funcsem.d:1905 — `FuncDeclaration resolveFuncCall(Loc loc, Scope* sc, Dsymbol s,
 * Objects* tiargs, Type tthis, ArgumentList argumentList, FuncResolveFlag flags)`.
 *
 * Given a symbol that could be either a FuncDeclaration or a function template, resolve it to a
 * function symbol.
 * Params:
 *      loc =           instantiation location
 *      sc =            instantiation scope
 *      s =             instantiation symbol
 *      tiargs =        initial list of template arguments
 *      tthis =         if !NULL, the `this` argument type
 *      argumentList =  arguments to function
 *      flags =         see FuncResolveFlag.
 * Returns:
 *      if match is found, then function symbol, else null
 *
 * `sc` is nullable (02 §10.1): D passes null at typesem.d:1813 (isCopyable) and :8852 (aliasthisOf).
 * The body forwards it to `functionResolve` (whose `sc` is `Scope | null`) and dereferences it only
 * past the `FuncResolveFlag.quiet` return at funcsem.d:1967; both null-passing callers set `quiet`,
 * so each dereference below carries `!` at the point where D would fault on a null `sc`.
 */
export function resolveFuncCall(loc: Loc, sc: Scope | null, s: Dsymbol | null,
    tiargs: Objects | null, tthis: Type | null, argumentList: ArgumentList,
    flags: FuncResolveFlag): FuncDeclaration | null {
    //printf("resolveFuncCall() %s\n", s.toChars());
    const fargs: Expressions | null = argumentList.arguments_;
    if (s === null)
        return null; // no match

    // resolved: version (none) (funcsem.d:1913-1927) -> OFF; the printf trace block is dropped.

    if (tiargs !== null && arrayObjectIsError(tiargs))
        return null;
    if (fargs !== null)
        for (const arg of fargs.opSlice())
            if (isError(arg))
                return null;

    const m = new MatchAccumulator();
    // funcsem.d:1937 — `functionResolve(m, s, loc, sc, tiargs, tthis, argumentList);`; callee live
    // at dmd/templatesem.d:5672 (`void functionResolve(ref MatchAccumulator m, Dsymbol dstart, Loc
    // loc, Scope* sc, Objects* tiargs, Type tthis, ArgumentList argumentList, void delegate(...)
    // errorHelper = null)`), exported by templatesem.ts:6040. D's `ref MatchAccumulator` is the
    // class instance passed by reference; `m` is read below exactly as D reads it.
    functionResolve(m, s, loc, sc, tiargs, tthis, argumentList);
    const orig_s = s;

    if (m.last > MATCH.nomatch && m.lastf !== null) {
        if (m.count === 1) { // exactly one match
            if ((flags & FuncResolveFlag.quiet) === 0)
                functionSemantic(m.lastf);
            return m.lastf;
        }
        if ((flags & FuncResolveFlag.overloadOnly) !== 0 && tthis === null && m.lastf.needThis()) {
            return m.lastf;
        }
    }

    /* Failed to find a best match.
     * Do nothing or print error.
     */
    if (m.last === MATCH.nomatch) {
        // error was caused on matched function, not on the matching itself,
        // so return the function to produce a better diagnostic
        if (m.count === 1)
            return m.lastf;
    }

    // We are done at this point, as the rest of this function generate
    // a diagnostic on invalid match
    if ((flags & FuncResolveFlag.quiet) !== 0)
        return null;

    let fd = s.isFuncDeclaration();
    const od = s.isOverDeclaration();
    const td = s.isTemplateDeclaration();
    if (td !== null && td.funcroot !== null) {
        fd = td.funcroot.isFuncDeclaration();
        s = td.funcroot;
    }

    const tiargsBuf = new OutBuffer();
    // funcsem.d:1977 — `arrayObjectsToBuffer(tiargsBuf, tiargs);`, authorised by hdrgen.d:3599.
    arrayObjectsToBuffer(tiargsBuf, tiargs);

    const fargsBuf = new OutBuffer();
    fargsBuf.writeByte(0x28 /* '(' */);
    // funcsem.d:1981 — `argExpTypesToCBuffer(fargsBuf, fargs);`, authorised by hdrgen.d:3586.
    argExpTypesToCBuffer(fargsBuf, fargs);
    fargsBuf.writeByte(0x29 /* ')' */);
    if (tthis !== null)
        tthis.modToBuffer(fargsBuf);

    // The call is ambiguous
    if (m.lastf !== null && m.nextf !== null) {
        const tf1: TypeFunction = m.lastf.type!.toTypeFunction();
        const tf2: TypeFunction = m.nextf.type!.toTypeFunction();
        // funcsem.d:1991/:1992 — `parametersTypeToChars(tf1/tf2.parameterList)`, authorised by
        // hdrgen.d:3618; by-value `ParameterList`, so copy at each call site (03 §1 #2).
        const lastprms = parametersTypeToChars(tf1.parameterList.copy());
        const nextprms = parametersTypeToChars(tf2.parameterList.copy());

        let match: DString = ds("");
        switch (m.last) {
            case MATCH.convert:
                match = ds("after implicit conversions");
                break;
            case MATCH.constant:
                match = ds("after qualifier conversion");
                break;
            case MATCH.exact:
                match = ds("exactly");
                break;
            case MATCH.nomatch:
                return assertUnreachable();
            default: { // D `final switch` exhaustiveness (06 §3.2)
                const _e: never = m.last;
                void _e;
                throw new SwitchError();   // D default message: "No appropriate switch clause found"
            }
        }

        // D `match.fTuple.expand` expands a `const(char)[]` into the (length, ptr) pair `%.*s` wants;
        // the port's `%.*s` takes exactly those two arguments (10 §3.5).
        error(loc,
            ds("`%s.%s` called with argument types `%s` matches multiple overloads %.*s:\n%s:     `%s%s%s`\nand:\n%s:     `%s%s%s`"),
            s.parent!.toPrettyChars(), s.ident!.toChars(),
            fargsBuf.peekChars(),
            match.length, match,
            m.lastf.loc.toChars(), m.lastf.toPrettyChars(), lastprms, tf1.modToChars(),
            m.nextf.loc.toChars(), m.nextf.toPrettyChars(), nextprms, tf2.modToChars());
        return null;
    }

    // no match, generate an error messages
    if ((flags & FuncResolveFlag.ufcs) !== 0) {
        const arg = fargs!.opIndex(0)!;
        error(loc, ds("no property `%s` for `%s` of type `%s`"),
            s.ident!.toChars(), arg.toChars(), arg.type!.toChars());
        errorSupplemental(loc, ds("the following error occured while looking for a UFCS match"));
    }

    if (fd === null) {
        // all of overloads are templates
        if (td !== null) {
            if (od === null && td.overnext === null) {
                error(loc, ds("%s `%s` is not callable using argument types `!(%s)%s`"),
                    td.kind(), td.ident!.toChars(), tiargsBuf.peekChars(), fargsBuf.peekChars());

                checkNamedArgErrorAndReport(td, argumentList, loc);
            } else {
                error(loc, ds("none of the overloads of %s `%s.%s` are callable using argument types `!(%s)%s`"),
                    td.kind(), td.parent!.toPrettyChars(), td.ident!.toChars(),
                    tiargsBuf.peekChars(), fargsBuf.peekChars());

                checkNamedArgErrorAndReport(td, argumentList, loc);
            }

            if (global.gag === 0 || global.params.v.showGaggedErrors)
                printCandidates(loc, td, sc!.isDeprecated()); // sc!: past the quiet return (funcsem.d:1967)
            return null;
        }
        /* This case used to happen when several ctors are mixed in an agregate.
           A (bad) error message is already generated in overloadApply().
           see https://issues.dlang.org/show_bug.cgi?id=19729
           and https://issues.dlang.org/show_bug.cgi?id=17259
        */
        if (od === null)
            return null;
    }

    if (od !== null) {
        error(loc, ds("none of the overloads of `%s` are callable using argument types `!(%s)%s`"),
            od.ident!.toChars(), tiargsBuf.peekChars(), fargsBuf.peekChars());

        checkNamedArgErrorAndReportOverload(od, argumentList, loc);
        if (global.gag === 0 || global.params.v.showGaggedErrors)
            printCandidates(loc, od, sc!.isDeprecated()); // sc!: past the quiet return (funcsem.d:1967)
        return null;
    }

    // (funcsem.d:2073 `import dmd.expressionsem : checkDisabled;` — resolved by the import below.)
    // remove when deprecation period of class allocators and deallocators is over
    if (fd!.isNewDeclaration() !== null && checkDisabled(fd!, loc, sc!)) // sc!: past the quiet return (funcsem.d:1967)
        return null;

    const hasOverloads = fd!.overnext !== null;
    let tf = fd!.type!.isTypeFunction();
    // if type is an error, the original type should be there for better diagnostics
    if (tf === null)
        tf = fd!.originalType!.toTypeFunction();

    // modifier mismatch
    if (tthis !== null && (fd!.isCtorDeclaration() !== null
        ? !MODimplicitConv(tf.mod, tthis.mod)
        : !MODimplicitConv(tthis.mod, tf.mod))) {
        const thisBuf = new OutBuffer();
        const funcBuf = new OutBuffer();
        MODMatchToBuffer(thisBuf, tthis.mod, tf.mod);
        const mismatches = MODMatchToBuffer(funcBuf, tf.mod, tthis.mod);
        if (hasOverloads) {
            const buf = new OutBuffer();
            // funcsem.d:2095 — `buf.argExpTypesToCBuffer(fargs);`, UFCS onto the free function
            // authorised by hdrgen.d:3586 (04 §6).
            argExpTypesToCBuffer(buf, fargs);
            if (fd!.isCtorDeclaration() !== null) {
                if ((tthis.mod & MODFlags.immutable_) !== 0)
                    error(loc,
                        ds("none of the overloads of `%s` can construct an immutable object with argument types `(%s)`. Expected `immutable(%s)`"),
                        fd!.toChars(), buf.peekChars(), buf.peekChars());
                else
                    error(loc,
                        ds("none of the overloads of `%s` can construct a %sobject with argument types `(%s)`"),
                        fd!.toChars(), thisBuf.peekChars(), buf.peekChars());
            } else
                error(loc, ds("none of the overloads of `%s` are callable using a %sobject with argument types `(%s)`"),
                    fd!.toChars(), thisBuf.peekChars(), buf.peekChars());

            if (global.gag === 0 || global.params.v.showGaggedErrors)
                printCandidates(loc, fd!, sc!.isDeprecated()); // sc!: past the quiet return (funcsem.d:1967)
            return null;
        }

        let calledHelper = false;
        // funcsem.d:2115 — nested `void errorHelper(const(char)* failMessage, Loc argloc = Loc.initial) scope`
        // (04 §5: inner `const` arrow; `scope` erases, 04 §8).
        const tfErr = tf;
        const errorHelper = (failMessage: DString, argloc: Loc = Loc.initial): void => {
            // funcsem.d:2118 — `parametersTypeToChars(tf.parameterList)`, authorised by hdrgen.d:3618;
            // by-value `ParameterList`, so copy at the call site (03 §1 #2).
            error(loc, ds("%s `%s%s%s` is not callable using argument types `%s`"),
                fd!.kind(), fd!.toPrettyChars(), parametersTypeToChars(tfErr.parameterList.copy()),
                tfErr.modToChars(), fargsBuf.peekChars());
            // funcsem.d:2120 the `const(char)*` format ends at the NUL; getParamError's buffer carries one
            errorSupplemental(!argloc.opEquals(Loc.initial) ? argloc : loc, cstr(failMessage));
            calledHelper = true;
        };

        // funcsem.d:2124 — `functionResolve(m, orig_s, loc, sc, tiargs, tthis, argumentList,
        // &errorHelper);`; callee live at dmd/templatesem.d:5672, exported by templatesem.ts:6040.
        // D's `&errorHelper` delegate is the arrow above; `orig_s` (not `s`) is D's own dstart here.
        functionResolve(m, orig_s, loc, sc, tiargs, tthis, argumentList, errorHelper);
        if (calledHelper)
            return null;

        if (fd!.isCtorDeclaration() !== null)
            error(loc, ds("%s%s `%s` cannot construct a %sobject"),
                funcBuf.peekChars(), fd!.kind(), fd!.toPrettyChars(), thisBuf.peekChars());
        else
            error(loc, ds("%smethod `%s` is not callable using a %sobject"),
                funcBuf.peekChars(), fd!.toPrettyChars(), thisBuf.peekChars());

        if (mismatches.isNotShared)
            errorSupplemental(fd!.loc, ds("Consider adding `shared` here"));
        else if (mismatches.isMutable)
            errorSupplemental(fd!.loc, ds("Consider adding `const` or `inout` here"));
        return null;
    }

    //printf("tf = %s, args = %s\n", tf.deco, (*fargs)[0].type.deco);
    if (hasOverloads) {
        error(loc, ds("none of the overloads of `%s` are callable using argument types `%s`"),
            fd!.toChars(), fargsBuf.peekChars());
        if (global.gag === 0 || global.params.v.showGaggedErrors)
            printCandidates(loc, fd!, sc!.isDeprecated()); // sc!: past the quiet return (funcsem.d:1967)
        return null;
    }

    // funcsem.d:2153 — `parametersTypeToChars(tf.parameterList)`, authorised by hdrgen.d:3618;
    // by-value `ParameterList`, so copy at the call site (03 §1 #2).
    error(loc, ds("%s `%s%s%s` is not callable using argument types `%s`"),
        fd!.kind(), fd!.toPrettyChars(), parametersTypeToChars(tf.parameterList.copy()),
        tf.modToChars(), fargsBuf.peekChars());

    if (global.gag !== 0 && !global.params.v.showGaggedErrors)
        return null;

    // re-resolve to check for supplemental message
    if (tthis !== null) {
        const classType = tthis.isTypeClass();
        if (classType !== null) {
            const baseClass = classType.sym!.baseClass;
            if (baseClass !== null) {
                const baseFunction = search(baseClass, baseClass.loc, fd!.ident!);
                if (baseFunction !== null) {
                    const mErr = new MatchAccumulator();
                    // funcsem.d:2169 — `functionResolve(mErr, baseFunction, loc, sc, tiargs,
                    // baseClass.type, argumentList);`; callee live at dmd/templatesem.d:5672,
                    // exported by templatesem.ts:6040.
                    functionResolve(mErr, baseFunction, loc, sc, tiargs, baseClass.type, argumentList);
                    if (mErr.last > MATCH.nomatch && mErr.lastf !== null) {
                        errorSupplemental(loc, ds("Note: %s `%s` hides base class %s `%s`"),
                            fd!.kind(), fd!.toPrettyChars(),
                            mErr.lastf.kind(), mErr.lastf.toPrettyChars());

                        if (fd!.isCtorDeclaration() === null) {
                            errorSupplemental(loc,
                                ds("Add `alias %s = %s;` to `%s`'s body to merge the overload sets"),
                                fd!.toChars(), mErr.lastf.toPrettyChars(), tthis.toChars());
                        }
                        return null;
                    }
                }
            }
        }
    }

    // funcsem.d:2188 — nested `void errorHelper2(const(char)* failMessage, Loc argloc = Loc.initial) scope`.
    const errorHelper2 = (failMessage: DString, argloc: Loc = Loc.initial): void => {
        // funcsem.d:2190 the `const(char)*` format ends at the NUL; getParamError's buffer carries one
        errorSupplemental(!argloc.opEquals(Loc.initial) ? argloc : loc, cstr(failMessage));
    };

    // funcsem.d:2193 — `functionResolve(m, orig_s, loc, sc, tiargs, tthis, argumentList,
    // &errorHelper2);`; callee live at dmd/templatesem.d:5672, exported by templatesem.ts:6040.
    functionResolve(m, orig_s, loc, sc, tiargs, tthis, argumentList, errorHelper2);

    return null;
}

/********************************************************
 * dmd/funcsem.d:2205 — `private void checkNamedArgErrorAndReport(TemplateDeclaration td,
 * ArgumentList argumentList, Loc loc)`.
 * Check for named argument errors in template declarations and report them.
 * Emitted WITHOUT `private`: D module-private, reached by this module's `resolveFuncCall`.
 */
function checkNamedArgErrorAndReport(td: TemplateDeclaration, argumentList: ArgumentList, loc: Loc): void {
    if (!argumentList.hasArgNames())
        return;
    // funcsem.d:2209 — `td.computeOneMember();` (UFCS, 04 §6); callee live at
    // dmd/templatesem.d:441 (`void computeOneMember(TemplateDeclaration td)`), exported by
    // templatesem.ts:761.
    computeOneMember(td);
    const tf = td.onemember !== null ? td.onemember.isFuncDeclaration() : null;
    if (tf !== null && tf.type !== null && tf.type.ty === TY.Tfunction) {
        const buf = new OutBuffer();
        const resolvedArgs = resolveNamedArgs(tf.type.isTypeFunction()!, argumentList, buf);
        if (!resolvedArgs && buf.length() !== 0)
            errorSupplemental(loc, ds("%s"), buf.peekChars());
    }
}

/******************************************
 * dmd/funcsem.d:2227 — `private void checkNamedArgErrorAndReportOverload(Dsymbol od,
 * ArgumentList argumentList, Loc loc)`.
 * Check for named argument errors in overload sets and report them.
 * Emitted WITHOUT `private`: D module-private, reached by this module's `resolveFuncCall`.
 */
function checkNamedArgErrorAndReportOverload(od: Dsymbol, argumentList: ArgumentList, loc: Loc): void {
    if (!argumentList.hasArgNames())
        return;

    const tfBox: Ref<FuncDeclaration | null> = { value: null };
    overloadApply(od, (s: Dsymbol): number => {
        if (tfBox.value === null) {
            const fd = s.isFuncDeclaration();
            if (fd !== null)
                tfBox.value = fd;
            else {
                const td = s.isTemplateDeclaration();
                if (td !== null) {
                    // funcsem.d:2240 — `td.computeOneMember();` (UFCS, 04 §6); callee live at
                    // dmd/templatesem.d:441, exported by templatesem.ts:761.
                    computeOneMember(td);
                    if (td.onemember !== null)
                        tfBox.value = td.onemember.isFuncDeclaration();
                }
            }
        }
        return 0;
    });

    const tfLocal: FuncDeclaration | null = tfBox.value;
    if (tfLocal !== null && tfLocal.type !== null && tfLocal.type.ty === TY.Tfunction) {
        const buf = new OutBuffer();
        const resolvedArgs = resolveNamedArgs(tfLocal.type.isTypeFunction()!, argumentList, buf);
        if (!resolvedArgs && buf.length() !== 0)
            errorSupplemental(loc, ds("%s"), buf.peekChars());
    }
}

/*******************************************
 * dmd/funcsem.d:2264 — `private void printCandidates(Decl)(Loc loc, Decl declaration,
 * bool showDeprecated)`.
 * Prints template and function overload candidates as supplemental errors.
 *
 * resolved (07 §8): the template parameter `Decl` is instantiated at three call sites with
 * `TemplateDeclaration`, `Dsymbol` (the OverDeclaration) and `FuncDeclaration` — the body only ever
 * passes `declaration` to `overloadApply(Dsymbol, …)`, so the three instantiations MONOMORPHIZE to
 * one `Dsymbol`-typed function. Emitted WITHOUT `private` (D module-private).
 *
 * Params:
 *      loc =            instantiation location
 *      declaration =    the declaration to print overload candidates for
 *      showDeprecated = If `false`, `deprecated` function won't be shown
 */
function printCandidates(loc: Loc, declaration: Dsymbol, showDeprecated: boolean): void {
    // max num of overloads to print (-v or -verror-supplements overrides this).
    const DisplayLimit: number = global.params.v.errorSupplementCount();
    const constraintsTip: { value: DString | null } = { value: null };

    let printed = 0; // number of candidates printed
    let count = 0; // total candidates
    let child = false; // true if inside an eponymous template
    // funcsem.d:2273 — nested `const(char)* errorPrefix() @safe` (04 §5).
    const errorPrefix = (): DString => {
        if (child)
            return ds("  - Containing: ");

        // align with blank spaces after first message
        const plural = ds("Candidates are: ");
        const spaces = ds("                ");
        if (printed !== 0)
            return spaces;

        return (count === 1) ? ds("Candidate is: ") : plural;
    };
    // funcsem.d:2286 — nested `bool matchSymbol(Dsymbol s, bool print)` (04 §5; self-recursive).
    const matchSymbol = (s: Dsymbol, print: boolean): boolean => {
        const fd = s.isFuncDeclaration();
        if (fd !== null) {
            // Don't print overloads which have errors.
            // Not that if the whole overload set has errors, we'll never reach
            // this point so there's no risk of printing no candidate
            if (fd.errors || fd.type!.ty === TY.Terror)
                return false;
            // Don't print disabled functions, or `deprecated` outside of deprecated scope
            if ((fd.storage_class & STC.disable) !== 0n || (fd.isDeprecated() && !showDeprecated))
                return false;
            if (!print)
                return true;
            // D `cast(TypeFunction) fd.type` — tag-proved RTTI downcast (02 §11.5c #3); the arm
            // above already rejected `fd.type.ty == Terror`, and D dereferences it unguarded.
            const tf: TypeFunction = fd.type!.isTypeFunction()!;
            const buf = new OutBuffer();
            buf.writestring(child ? fd.toChars() : fd.toPrettyChars());
            // funcsem.d:2303 — `parametersTypeToChars(tf.parameterList)`, authorised by hdrgen.d:3618;
            // by-value `ParameterList`, so copy at the call site (03 §1 #2).
            // `writestring(const(char)*)`: the bytes before the NUL
            buf.writestring(cstr(parametersTypeToChars(tf.parameterList.copy())));
            if (tf.mod !== 0) {
                buf.writeByte(0x20 /* ' ' */);
                MODtoBuffer(buf, tf.mod);
            }
            errorSupplemental(fd.loc, ds("%s`%s`"), errorPrefix(), buf.peekChars());
        } else {
            const td = s.isTemplateDeclaration();
            if (td !== null) {
                // (funcsem.d:2313 `import dmd.staticcond;` — used only by getConstraintEvalError below.)

                if (!print)
                    return true;

                // if td.onemember is a function, toCharsMaybeConstraints can print it
                // without us recursing, otherwise we have to handle it.
                // td.onemember may not have overloads set
                // (see fail_compilation/onemember_overloads.d)
                // assume if more than one member it is overloaded internally
                // funcsem.d:2323 — `td.computeOneMember();` (UFCS, 04 §6); callee live at
                // dmd/templatesem.d:441, exported by templatesem.ts:761.
                computeOneMember(td);
                const recurse = td.onemember !== null &&
                    (td.onemember.isFuncDeclaration() === null || td.members!.length > 1);
                const buf = new OutBuffer();
                const hgs = new HdrGenState();
                hgs.skipConstraints = true; // failing constraint should get printed below
                hgs.showOneMember = !recurse;
                // funcsem.d:2330 — `toCharsMaybeConstraints(td, buf, hgs);`; callee live at dmd/hdrgen.d:2067.
                toCharsMaybeConstraints(td, buf, hgs);
                const tmsg = buf.peekChars();
                // funcsem.d:2332 — `td.getConstraintEvalError(constraintsTip)` (UFCS, 04 §6); callee
                // live at dmd/templatesem.d:3615 (`const(char)* getConstraintEvalError(
                // TemplateDeclaration td, ref const(char)* tip)`), exported by templatesem.ts:3897;
                // D's `ref const(char)* tip` is the one-slot box `constraintsTip` (03 §3.3). The
                // callee itself still walls `staticcond.visualizeStaticCondition`, so this path stays
                // dark — now at the callee's own wall, which is where the deferral belongs.
                const cmsg = child ? null : getConstraintEvalError(td, constraintsTip);

                if (cmsg !== null)
                    errorSupplemental(td.loc, ds("%s`%s`\n%s"), errorPrefix(), tmsg, cmsg);
                else
                    errorSupplemental(td.loc, ds("%s`%s`"), errorPrefix(), tmsg);

                if (recurse) {
                    child = true;
                    for (const d of td.members!.opSlice()) {
                        if (d!.ident !== td.ident)
                            continue;

                        const fd2 = d!.isFuncDeclaration();
                        if (fd2 !== null)
                            matchSymbol(fd2, print);
                        else {
                            const td2 = d!.isTemplateDeclaration();
                            if (td2 !== null)
                                matchSymbol(td2, print);
                        }
                    }
                    child = false;
                }
            }
        }
        return true;
    };
    // determine if there's > 1 candidate
    overloadApply(declaration, (s: Dsymbol): number => {
        if (matchSymbol(s, false))
            count++;
        return count > 1 ? 1 : 0;
    });
    let skipped = 0;
    overloadApply(declaration, (s: Dsymbol): number => {
        if (global.params.v.verbose || printed < DisplayLimit) {
            if (matchSymbol(s, true))
                printed++;
        } else {
            // Too many overloads to sensibly display.
            // Just show count of remaining overloads.
            if (matchSymbol(s, false))
                skipped++;
        }
        return 0;
    });
    if (skipped > 0)
        errorSupplemental(loc, ds("... (%d more, -v to show) ..."), skipped);

    // Nothing was displayed, all overloads are either disabled or deprecated
    if (printed === 0)
        errorSupplemental(loc, ds("All possible candidates are marked as `deprecated` or `@disable`"));
    // should be only in verbose mode
    if (constraintsTip.value !== null)
        tip(constraintsTip.value);
}

/********************************************************
 * dmd/funcsem.d:2398 — `Expression addInvariant(AggregateDeclaration ad, VarDeclaration vthis)`.
 * Generate Expression to call the invariant.
 * Input:
 *      ad      aggregate with the invariant
 *      vthis   variable with 'this'
 * Returns:
 *      void expression that calls the invariant
 */
export function addInvariant(ad: AggregateDeclaration, vthis: VarDeclaration): Expression | null {
    let e: Expression | null = null;
    // Call invariant directly only if it exists
    let inv: FuncDeclaration | null = ad.inv;
    let cd: ClassDeclaration | null = ad.isClassDeclaration();

    while (inv === null && cd !== null) {
        cd = cd.baseClass;
        if (cd === null)
            break;
        inv = cd.inv;
    }
    if (inv === null)
        return e;

    // resolved: version (all) (funcsem.d:2415) -> ON; the body below is kept.
    // Workaround for https://issues.dlang.org/show_bug.cgi?id=13394
    // For the correct mangling,
    // run attribute inference on inv if needed.
    functionSemantic(inv);

    //e = new DsymbolExp(Loc.initial, inv);
    //e = new CallExp(Loc.initial, e);
    //e = e.semantic(sc2);

    /* https://issues.dlang.org/show_bug.cgi?id=13113
     * Currently virtual invariant calls completely
     * bypass attribute enforcement.
     * Change the behavior of pre-invariant call by following it.
     */
    e = new ThisExp(Loc.initial);
    e.type = addMod(ad.type!, vthis.type!.mod);
    e = new DotVarExp(Loc.initial, e, inv, false);
    e.type = inv.type;
    e = new CallExp(Loc.initial, e);
    e.type = Type.tvoid;
    return e;
}

/********************************************
 * dmd/funcsem.d:2444 — `FuncDeclaration overloadExactMatch(FuncDeclaration thisfd, Type t)`.
 * Find function in overload list that exactly matches t.
 */
export function overloadExactMatch(thisfd: FuncDeclaration, t: Type): FuncDeclaration | null {
    let fd: FuncDeclaration | null = null;
    overloadApply(thisfd, (s: Dsymbol): number => {
        const f = s.isFuncDeclaration();
        if (f === null)
            return 0;
        if ((f.storage_class & STC.disable) !== 0n)
            return 0;
        if (t.equals(f.type)) {
            fd = f;
            return 1;
        }
        /* Allow covariant matches, as long as the return type
         * is just a const conversion.
         * This allows things like pure functions to match with an impure function type.
         */
        if (t.ty === TY.Tfunction) {
            // D `cast(TypeFunction)f.type` (funcsem.d:2465) is a static cast with NO tag test behind it (the
            // `t.ty` test above is about `t`): a function whose declaration failed semantic has
            // `f.type == Type.terror`, and D passes that TypeError on, where covariant() answers `distinct`
            // (its `isTypeFunction()` is null) and the `&&` never reaches nextOf(). Only Type members are read,
            // so tf stays a Type; isTypeFunction()! handed covariant() a null for that function.
            const tf: Type = f.type!;
            // `MATCH implicitConvTo(Type from, Type to)` (dcast.d:1558) — the Type-receiver member
            // of the overload pair; dcast.ts spells it `implicitConvToType` (04 §6.1), the
            // Expression-receiver form (dcast.d:312) keeping the bare name.
            if (covariant(tf, t) === Covariant.yes &&
                implicitConvToType(nextOf(tf)!, nextOf(t)!) >= MATCH.constant) {
                fd = f;
                return 1;
            }
        }
        return 0;
    });
    return fd;
}

/****************************************************
 * dmd/funcsem.d:2482 — `int overrides(FuncDeclaration fd1, FuncDeclaration fd2)`.
 * Determine if fd1 overrides fd2.
 * Return !=0 if it does.
 */
export function overrides(fd1: FuncDeclaration, fd2: FuncDeclaration): number {
    if (fd1.ident !== fd2.ident)
        return 0;

    const cov = covariant(fd1.type!, fd2.type!);
    if (cov === Covariant.distinct)
        return 0;

    const cd1 = fd1.toParent()!.isClassDeclaration();
    const cd2 = fd2.toParent()!.isClassDeclaration();

    // `ClassDeclaration.isBaseOf(ClassDeclaration, int*)` is a dclass.d member; the typesem free
    // function of the same name takes a `Type` first argument (04 §6.1) — this call site is the
    // CLASS one, resolved by first-parameter type.
    if (cd1 !== null && cd2 !== null && cd2.isBaseOf(cd1, null))
        return 1;
    return 0;
}

/*************************************
 * dmd/funcsem.d:2510 — `MATCH leastAsSpecialized(FuncDeclaration f, FuncDeclaration g,
 * ArgumentLabels* names)`.
 * Determine partial specialization order of functions `f` vs `g`.
 * This is very similar to TemplateDeclaration::leastAsSpecialized().
 * Params:
 *  f = first function
 *  g = second function
 *  names = argument Labels of parameters(name and location of the name)
 * Returns:
 *      match   'this' is at least as specialized as g
 *      0       g is more specialized than 'this'
 */
export function leastAsSpecialized(f: FuncDeclaration, g: FuncDeclaration,
                                   names: ArgumentLabels | null): MATCH {
    // resolved: `enum LOG_LEASTAS = 0;` -> every `static if (LOG_LEASTAS)` in this function is OFF
    // (funcsem.d:2513-2519, :2571-2574, :2578-2581); the printf blocks are dropped.

    /* This works by calling g() with f()'s parameters, and
     * if that is possible, then f() is at least as specialized
     * as g() is.
     */

    const tf: TypeFunction = f.type!.toTypeFunction();
    const tg: TypeFunction = g.type!.toTypeFunction();

    // `L1:` (funcsem.d:2577) is a terminal BAIL tail — the zero-param nested arrow of 06 §4.
    const L1Tail = (): MATCH => {
        return MATCH.nomatch;
    };

    /* If both functions have a 'this' pointer, and the mods are not
     * the same and g's is not const, then this is less specialized.
     */
    if (f.needThis() && g.needThis() && tf.mod !== tg.mod) {
        if (f.isCtorDeclaration() !== null) {
            if (!MODimplicitConv(tg.mod, tf.mod))
                return MATCH.nomatch;
        } else {
            if (!MODimplicitConv(tf.mod, tg.mod))
                return MATCH.nomatch;
        }
    }

    /* Create a dummy array of arguments out of the parameters to f()
     */
    // D `Expressions args;` — an inline BY-VALUE `Array!T` field is born EMPTY and usable (09 §1.0).
    const args: Expressions = new DArray<Expression | null>();
    tf.parameterList.opApply((_u: number, p: Parameter | null): number => {
        let e: Expression | null;
        if (p!.isReference()) {
            e = new IdentifierExp(Loc.initial, p!.ident!);
            e.type = p!.type;
        } else
            e = defaultInitLiteral(p!.type!, Loc.initial);
        args.push(e);
        return 0;
    });

    const m: MATCH = callMatch(g, tg, null, new ArgumentList(args, names), 1);
    if (m > MATCH.nomatch) {
        /* A variadic parameter list is less specialized than a
         * non-variadic one.
         */
        if (tf.parameterList.varargs !== VarArg.none && tg.parameterList.varargs === VarArg.none)
            return L1Tail();    // goto L1 (dmd/funcsem.d:2569) — less specialized

        return m;
    }
    return L1Tail();
}

/********************************************
 * dmd/funcsem.d:2603 — `FuncDeclaration overloadModMatch(FuncDeclaration thisfd, Loc loc,
 * Type tthis, ref bool hasOverloads)`.
 * Find function in overload list that matches to the 'this' modifier.
 * There's four result types.
 *
 * 1. If the 'tthis' matches only one candidate, it's an "exact match".
 *    Returns the function and 'hasOverloads' is set to false.
 * 2. If there's two or more match candidates, but a candidate function will be a "better match".
 *    Returns the better match function but 'hasOverloads' is set to true.
 * 3. If there's two or more match candidates, but there's no better match,
 *    Returns null and 'hasOverloads' is set to true to represent "ambiguous match".
 * 4. If there's no candidates, it's "no match" and returns null with error report.
 *
 * `ref bool hasOverloads` is the caller's variable, written here — the out-param box (03 §3.3).
 */
export function overloadModMatch(thisfd: FuncDeclaration, loc: Loc, tthis: Type | null,
                                 hasOverloads: Ref<boolean>): FuncDeclaration | null {
    //printf("FuncDeclaration::overloadModMatch('%s')\n", toChars());
    const m = new MatchAccumulator();
    overloadApply(thisfd, (s: Dsymbol): number => {
        const f = s.isFuncDeclaration();
        if (f === null || f === m.lastf) // skip duplicates
            return 0;
        const tf: TypeFunction = f.type!.toTypeFunction();
        //printf("tf = %s\n", tf.toChars());
        let match: MATCH = MATCH.nomatch;
        // funcsem.d:2615 / :2621 — the two nested `int` helpers (04 §5: inner `const` arrows).
        const lastIsBetter = (): number => {
            //printf("\tlastbetter\n");
            m.count++; // count up
            return 0;
        };
        const currIsBetter = (): number => {
            //printf("\tisbetter\n");
            if (m.last <= MATCH.convert) {
                // clear last secondary matching
                m.nextf = null;
                m.count = 0;
            }
            m.last = match;
            m.lastf = f;
            m.count++; // count up
            return 0;
        };
        if (tthis !== null) { // non-static functions are preferred than static ones
            if (f.needThis())
                match = f.isCtorDeclaration() !== null ? MATCH.exact : MODmethodConv(tthis.mod, tf.mod);
            else
                match = MATCH.constant; // keep static function in overload candidates
        } else { // static functions are preferred than non-static ones
            if (f.needThis())
                match = MATCH.convert;
            else
                match = MATCH.exact;
        }
        if (match === MATCH.nomatch)
            return 0;
        if (match > m.last) return currIsBetter();
        if (match < m.last) return lastIsBetter();
        // See if one of the matches overrides the other.
        if (overrides(m.lastf!, f) !== 0) return lastIsBetter();
        if (overrides(f, m.lastf!) !== 0) return currIsBetter();
        //printf("\tambiguous\n");
        m.nextf = f;
        m.count++;
        return 0;
    });
    if (m.count === 1) {        // exact match
        hasOverloads.value = false;
    } else if (m.count > 1) {   // better or ambiguous match
        hasOverloads.value = true;
    } else {                    // no match
        hasOverloads.value = true;
        const tf: TypeFunction = thisfd.type!.toTypeFunction();
        assert(tthis !== null);
        assert(!MODimplicitConv(tthis!.mod, tf.mod)); // modifier mismatch
        {
            const thisBuf = new OutBuffer();
            const funcBuf = new OutBuffer();
            MODMatchToBuffer(thisBuf, tthis!.mod, tf.mod);
            MODMatchToBuffer(funcBuf, tf.mod, tthis!.mod);
            error(loc, ds("%smethod %s is not callable using a %sobject"), thisfd.kind(),
                thisfd.toPrettyChars(), funcBuf.peekChars(), thisfd.toPrettyChars(), thisBuf.peekChars());
        }
    }
    return m.lastf;
}

/***********************************
 * dmd/funcsem.d:2703 — `int getLevelAndCheck(FuncDeclaration fd, Loc loc, Scope* sc,
 * FuncDeclaration target, Declaration decl)`.
 * Determine lexical level difference from `fd` to nested function `target`.
 * Issue error if `fd` cannot call `target`.
 * Returns:
 *      0       same level
 *      >0      decrease nesting by number
 *      -1      increase nesting by 1 (`target` is nested within 'fd')
 *      LevelError  error
 */
export function getLevelAndCheck(fd: FuncDeclaration, loc: Loc, sc: Scope, target: FuncDeclaration,
                                 decl: Declaration): number {
    // NOTE: the D parameter is named `target` and shadows this module's `dmd.target` singleton
    // import inside this body — the name is carried verbatim (01 §2); the singleton is not used here.
    const level = getLevel(fd, target, sc.intypeof);
    if (level !== LevelError)
        return level;
    // Don't give error if in template constraint
    if (!sc.inTemplateConstraint) {
        const xstatic: DString = fd.isStatic() ? ds("`static` ") : ds("");
        // better diagnostics for static functions
        error(loc, ds("%s%s `%s` cannot access %s `%s` in frame of function `%s`"),
            xstatic, fd.kind(), fd.toPrettyChars(), decl.kind(), decl.toChars(),
            target.toPrettyChars());
        errorSupplemental(decl.loc, ds("`%s` declared here"), decl.toChars());
        return LevelError;
    }
    return 1;
}

/**********************************
 * dmd/funcsem.d:2732 — `private bool canInferAttributes(FuncDeclaration fd, Scope* sc)`.
 * Decide if attributes for this function can be inferred from examining the function body.
 * Emitted WITHOUT `private`: D module-private, reached by `funcDeclarationSemantic`.
 */
function canInferAttributes(fd: FuncDeclaration, sc: Scope): boolean {
    if (fd.fbody === null)
        return false;
    if (isVirtualMethod(fd) &&
        /*
         * https://issues.dlang.org/show_bug.cgi?id=21719
         *
         * If we have an auto virtual function we can infer
         * the attributes.
         */
        !(fd.inferRetType && fd.isCtorDeclaration() === null))
        return false;               // since they may be overridden
    // funcsem.d:2747 — `sc.func.isSafeBypassingInference()` (UFCS, 04 §6); callee live at dmd/safe.d:348.
    if (sc.func !== null &&
        /********** this is for backwards compatibility for the moment ********/
        (fd.isMember() === null || isSafeBypassingInference(sc.func) && fd.isInstantiated() === null))
        return true;
    if (fd.isFuncLiteralDeclaration() !== null ||        // externs are not possible with literals
        (fd.storage_class & STC.inference) !== 0n ||     // do attribute inference
        fd.isGenerated ||                                // compiler generated function
        (fd.inferRetType && fd.isCtorDeclaration() === null))
        return true;
    if (fd.isInstantiated() !== null) {
        const ti = fd.parent!.isTemplateInstance();
        if (ti === null || ti.isTemplateMixin() !== null || ti.tempdecl!.ident === fd.ident)
            return true;
    }
    return false;
}

/****************************************************
 * dmd/funcsem.d:2769 — `private bool canBuildResultVar(FuncDeclaration fd)`.
 * Check whether result variable can be built.
 * Returns: `true` if the function has a return type that is different from `void`.
 * Emitted WITHOUT `private`: D module-private, reached by sibling functions in this module.
 */
function canBuildResultVar(fd: FuncDeclaration): boolean {
    // D `auto f = cast(TypeFunction)fd.type;` — a class downcast that yields null on a mismatch,
    // which is exactly `isTypeFunction()` (02 §11.5c #3); the `f &&` test below is D's own.
    const f: TypeFunction | null = fd.type !== null ? fd.type.isTypeFunction() : null;
    return f !== null && nextOf(f) !== null && toBasetype(nextOf(f)!).ty !== TY.Tvoid;
}

/****************************************************
 * dmd/funcsem.d:2778 — `void buildResultVar(FuncDeclaration fd, Scope* sc, Type tret)`.
 * Declare result variable lazily.
 */
export function buildResultVar(fd: FuncDeclaration, sc: Scope | null, tret: Type): void {
    if (fd.vresult === null) {
        const loc: Loc = fd.fensure() !== null ? fd.fensure()!.loc : fd.loc;
        /* If inferRetType is true, tret may not be a correct return type yet.
         * So, in here it may be a temporary type for vresult, and after
         * fbody.dsymbolSemantic() running, vresult.type might be modified.
         */
        fd.vresult = new VarDeclaration(loc, tret, Id.result!, null);
        fd.vresult._init = new VoidInitializer(loc); // hdrgen requires _init
        fd.vresult.storage_class = (fd.vresult.storage_class | STC.nodtor | STC.temp) as STC;
        if (!isVirtual(fd))
            fd.vresult.storage_class = (fd.vresult.storage_class | STC.const_) as STC;
        fd.vresult.storage_class = (fd.vresult.storage_class | STC.result) as STC;
        // set before the semantic() for checkNestedReference()
        fd.vresult.parent = fd;
    }
    if (sc !== null && fd.vresult.semanticRun === PASS.initial) {
        const tf: TypeFunction = fd.type!.toTypeFunction();
        if (fd.isNRVO || tf.isRef)
            fd.vresult.storage_class = (fd.vresult.storage_class | STC.ref_) as STC;
        else {
            if (target.isReturnOnStack(tf, fd.needThis()))
                fd.vresult.nrvo = true;
        }
        fd.vresult.type = tret;
        dsymbolSemantic(fd.vresult, sc);
        if (insert(sc, fd.vresult) === null)
            error(fd.loc, ds("%s `%s` out result %s is already defined"),
                fd.kind(), fd.toPrettyChars(), fd.vresult.toChars());
        assert(fd.vresult.parent === fd);
    }
}

/****************************************************
 * dmd/funcsem.d:2815 — `Statement mergeFrequire(FuncDeclaration fd, Statement sf, Expressions* params)`.
 * Merge into this function the 'in' contracts of all it overrides.
 * 'in's are OR'd together, i.e. only one of them needs to pass.
 */
export function mergeFrequire(fd: FuncDeclaration, sf: Statement | null,
                              params: Expressions | null): Statement | null {
    /* If a base function and its override both have an IN contract, then
     * only one of them needs to succeed. This is done by generating:
     *
     * void derived.in() {
     *  try {
     *    base.in();
     *  }
     *  catch () {
     *    ... body of derived.in() ...
     *  }
     * }
     *
     * So if base.in() doesn't throw, derived.in() need not be executed, and the contract is valid.
     * If base.in() throws, then derived.in()'s body is executed.
     */
    for (const fdv of fd.foverrides.opSlice()) {
        /* The semantic pass on the contracts of the overridden functions must
         * be completed before code generation occurs.
         * https://issues.dlang.org/show_bug.cgi?id=3602
         */
        if (fdv!.frequires() !== null && fdv!.semanticRun !== PASS.semantic3done) {
            assert(fdv!._scope !== null);
            const sc: Scope = fdv!._scope!.push();
            sc.stc = (sc.stc & ~STC.override_) as STC;
            semantic3(fdv!, sc);
            sc.pop();
        }
        sf = mergeFrequire(fdv!, sf, params);
        if (sf === null || fdv!.fdrequire() === null)
            return null;
        //printf("fdv.frequire: %s\n", fdv.frequire.toChars());
        /* Make the call:
            *   try { __require(params); }
            *   catch (Throwable) { frequire; }
            */
        params = Expression.arraySyntaxCopy(params);
        const e: Expression = new CallExp(fd.loc, new VarExp(fd.loc, fdv!.fdrequire()!, false), params);
        const s2: Statement = new ExpStatement(fd.loc, e);
        const c = new Catch(fd.loc, getThrowable(), null, sf);
        c.internalCatch = true;
        const catches = DArray.from<Catch | null>(c);
        sf = new TryCatchStatement(fd.loc, s2, catches);
    }
    return sf;
}

/****************************************************
 * dmd/funcsem.d:2868 — `Statement mergeFrequireInclusivePreview(FuncDeclaration fd, Statement sf,
 * Expressions* params)`.
 * Merge into this function the 'in' contracts of all it overrides.
 */
export function mergeFrequireInclusivePreview(fd: FuncDeclaration, sf: Statement | null,
                                              params: Expressions | null): Statement | null {
    /* If a base function and its override both have an IN contract, then
     * the override in contract must widen the guarantee of the base contract.
     * This is checked by generating:
     *
     * void derived.in() {
     *  try {
     *    ... body of derived.in() ...
     *  }
     *  catch () {
     *    // derived in rejected this argument. so parent must also reject it, or we've tightened the contract.
     *    base.in();
     *    assert(false, "Logic error: " ~ thr.msg);
     *  }
     * }
     */
    for (const fdv of fd.foverrides.opSlice()) {
        /* The semantic pass on the contracts of the overridden functions must
         * be completed before code generation occurs.
         * https://issues.dlang.org/show_bug.cgi?id=3602
         */
        if (fdv!.frequires() !== null && fdv!.semanticRun !== PASS.semantic3done) {
            assert(fdv!._scope !== null);
            const sc: Scope = fdv!._scope!.push();
            sc.stc = (sc.stc & ~STC.override_) as STC;
            semantic3(fdv!, sc);
            sc.pop();
        }
        sf = mergeFrequireInclusivePreview(fdv!, sf, params);
        if (sf === null || fdv!.fdrequire() === null)
            return null;

        const loc: Loc = fd.fdrequire()!.loc;
        //printf("fdv.frequire: %s\n", fdv.frequire.toChars());
        /* Make the call:
         *   try { frequire; }
         *   catch (Throwable thr) { __require(params); assert(false, "Logic error: " ~ thr.msg); }
         */
        const id = Identifier.generateId(ds("thr"));
        params = Expression.arraySyntaxCopy(params);
        const e: Expression = new CallExp(loc, new VarExp(loc, fdv!.fdrequire()!, false), params);
        const s2: Statement = new ExpStatement(loc, e);
        // assert(false, ...)
        // TODO make this a runtime helper to allow:
        // - chaining the original expression
        // - nogc concatenation
        const msg: Expression = new StringExp(loc,
            [...ds("Logic error: in-contract was tighter than parent in-contract")]);
        const fail: Statement = new ExpStatement(loc, new AssertExp(loc, IntegerExp.literal(0), msg));
        const s3: Statement = CompoundStatement.fromStatementList(loc, s2, fail);
        const c = new Catch(loc, getThrowable(), id, s3);
        c.internalCatch = true;
        const catches = DArray.from<Catch | null>(c);
        sf = new TryCatchStatement(loc, sf, catches);
    }
    return sf;
}

/****************************************************
 * dmd/funcsem.d:2931 — `void buildEnsureRequire(FuncDeclaration thisfd)`.
 * Rewrite contracts as statements.
 */
export function buildEnsureRequire(thisfd: FuncDeclaration): void {
    if (thisfd.frequires() !== null) {
        /*   in { statements1... }
         *   in { statements2... }
         *   ...
         * becomes:
         *   in { { statements1... } { statements2... } ... }
         */
        assert(thisfd.frequires()!.length !== 0);
        const loc: Loc = thisfd.frequires()!.opIndex(0)!.loc;
        const s: Statements = new DArray<Statement | null>();
        for (const r of thisfd.frequires()!.opSlice()) {
            s.push(new ScopeStatement(r!.loc, r, r!.loc));
        }
        thisfd.setFrequire(new CompoundStatement(loc, s));
    }
    if (thisfd.fensures() !== null) {
        /*   out(id1) { statements1... }
         *   out(id2) { statements2... }
         *   ...
         * becomes:
         *   out(__result) { { ref id1 = __result; { statements1... } }
         *                   { ref id2 = __result; { statements2... } } ... }
         */
        assert(thisfd.fensures()!.length !== 0);
        const loc: Loc = thisfd.fensures()!.opIndex(0).ensure!.loc;
        const s: Statements = new DArray<Statement | null>();
        for (const r of thisfd.fensures()!.opSlice()) {
            if (r.id !== null && canBuildResultVar(thisfd)) {
                const rloc: Loc = r.ensure!.loc;
                const resultId = new IdentifierExp(rloc, Id.result!);
                const init = new ExpInitializer(rloc, resultId);
                const stc = (STC.ref_ | STC.temp | STC.result) as STC;
                const decl = new VarDeclaration(rloc, null, r.id, init, stc);
                const sdecl: Statement = ExpStatement.fromDsymbol(rloc, decl);
                s.push(new ScopeStatement(rloc, CompoundStatement.fromStatementList(rloc, sdecl, r.ensure), rloc));
            } else {
                s.push(r.ensure);
            }
        }
        thisfd.setFensure(new CompoundStatement(loc, s));
    }
    if (!isVirtual(thisfd))
        return;
    /* Rewrite contracts as nested functions, then call them. Doing it as nested
     * functions means that overriding functions can call them.
     */
    // D `cast(TypeFunction) thisfd.type` — tag-proved RTTI downcast (02 §11.5c #3).
    const f: TypeFunction = thisfd.type!.isTypeFunction()!;
    /* Make a copy of the parameters and make them all ref */
    // funcsem.d:2988 — nested `static Parameters* toRefCopy(ParameterList parameterList)` (04 §5).
    const toRefCopy = (parameterList: ParameterList): Parameters => {
        const result: Parameters = new DArray<Parameter | null>();
        parameterList.opApply((_n: number, p0: Parameter | null): number => {
            const p = p0!.syntaxCopy();
            if (!p.isLazy())
                p.storageClass = ((p.storageClass | STC.ref_) & ~STC.out_) as STC;
            p.defaultArg = null; // won't be the same with ref
            result.push(p);
            return 0;
        });
        return result;
    };
    if (thisfd.frequire() !== null) {
        /*   in { ... }
         * becomes:
         *   void __require(ref params) { ... }
         *   __require(params);
         */
        const loc: Loc = thisfd.frequire()!.loc;
        thisfd.setFdrequireParams(new DArray<Expression | null>());
        if (thisfd.parameters !== null) {
            for (const vd of thisfd.parameters.opSlice())
                thisfd.fdrequireParams()!.push(new VarExp(loc, vd!));
        }
        // D `cast(TypeFunction)(thisfd.originalType ? thisfd.originalType : f)` (02 §11.5c #3).
        const fo: TypeFunction = (thisfd.originalType !== null ? thisfd.originalType : f).isTypeFunction()!;
        // `toRefCopy(ParameterList)` takes the list BY VALUE (funcsem.d:2988) -> copy at the call
        // site (03 §3.1). `ParameterList` is not a 03 §9.1 register member, so no elision.
        const fparams = toRefCopy(fo.parameterList.copy());
        const tf = new TypeFunction(new ParameterList(fparams), Type.tvoid, LINK.d);
        tf.isNothrow = f.isNothrow;
        tf.isNogc = f.isNogc;
        tf.purity = f.purity;
        tf.trust = f.trust;
        const fd = new FuncDeclaration(loc, loc, Id.require!, STC.none, tf);
        fd.fbody = thisfd.frequire();
        const s1: Statement = ExpStatement.fromDsymbol(loc, fd);
        const e: Expression = new CallExp(loc, new VarExp(loc, fd, false),
            thisfd.fdrequireParams());
        const s2: Statement = new ExpStatement(loc, e);
        thisfd.setFrequire(CompoundStatement.fromStatementList(loc, s1, s2));
        thisfd.setFdrequire(fd);
    }
    /* We need to set fdensureParams here and not in the block below to
     * have the parameters available when calling a base class ensure(),
     * even if this function doesn't have an out contract.
     */
    thisfd.setFdensureParams(new DArray<Expression | null>());
    if (canBuildResultVar(thisfd))
        thisfd.fdensureParams()!.push(new IdentifierExp(thisfd.loc, Id.result!));
    if (thisfd.parameters !== null) {
        for (const vd of thisfd.parameters.opSlice())
            thisfd.fdensureParams()!.push(new VarExp(thisfd.loc, vd!));
    }
    if (thisfd.fensure() !== null) {
        /*   out (result) { ... }
         * becomes:
         *   void __ensure(ref tret result, ref params) { ... }
         *   __ensure(result, params);
         */
        const loc: Loc = thisfd.fensure()!.loc;
        const fparams: Parameters = new DArray<Parameter | null>();
        if (canBuildResultVar(thisfd)) {
            const p = new Parameter(loc, (STC.ref_ | STC.const_) as STC, nextOf(f), Id.result!, null, null);
            fparams.push(p);
        }
        // D `cast(TypeFunction)(thisfd.originalType ? thisfd.originalType : f)` (02 §11.5c #3).
        const fo: TypeFunction = (thisfd.originalType !== null ? thisfd.originalType : f).isTypeFunction()!;
        // by-value `ParameterList` argument -> copy at the call site (03 §3.1), as above.
        fparams.pushSlice(toRefCopy(fo.parameterList.copy()).opSlice());
        const tf = new TypeFunction(new ParameterList(fparams), Type.tvoid, LINK.d);
        tf.isNothrow = f.isNothrow;
        tf.isNogc = f.isNogc;
        tf.purity = f.purity;
        tf.trust = f.trust;
        const fd = new FuncDeclaration(loc, loc, Id.ensure!, STC.none, tf);
        fd.fbody = thisfd.fensure();
        const s1: Statement = ExpStatement.fromDsymbol(loc, fd);
        const e: Expression = new CallExp(loc, new VarExp(loc, fd, false),
            thisfd.fdensureParams());
        const s2: Statement = new ExpStatement(loc, e);
        thisfd.setFensure(CompoundStatement.fromStatementList(loc, s1, s2));
        thisfd.setFdensure(fd);
    }
}

/****************************************************
 * dmd/funcsem.d:3081 — `bool needsFensure(FuncDeclaration fd) @safe`.
 * Determine whether an 'out' contract is declared inside the given function or any of its overrides.
 * Params:
 *      fd = the function to search
 * Returns:
 *      true    found an 'out' contract
 */
export function needsFensure(fd: FuncDeclaration): boolean {
    if (fd.fensures() !== null)
        return true;

    for (const fdv of fd.foverrides.opSlice()) {
        if (needsFensure(fdv!))
            return true;
    }
    return false;
}

/****************************************************
 * dmd/funcsem.d:3098 — `Statement mergeFensure(FuncDeclaration fd, Statement sf, Identifier oid,
 * Expressions* params)`.
 * Merge into this function the 'out' contracts of all it overrides.
 * 'out's are AND'd together, i.e. all of them need to pass.
 */
export function mergeFensure(fd: FuncDeclaration, sf: Statement | null, oid: Identifier,
                             params: Expressions | null): Statement | null {
    /* Same comments as for mergeFrequire(), except that we take care
     * of generating a consistent reference to the 'result' local by
     * explicitly passing 'result' to the nested function as a reference
     * argument.
     * This won't work for the 'this' parameter as it would require changing
     * the semantic code for the nested function so that it looks on the parameter
     * list for the 'this' pointer, something that would need an unknown amount
     * of tweaking of various parts of the compiler that I'd rather leave alone.
     */
    for (const fdv of fd.foverrides.opSlice()) {
        /* The semantic pass on the contracts of the overridden functions must
         * be completed before code generation occurs.
         * https://issues.dlang.org/show_bug.cgi?id=3602 and
         * https://issues.dlang.org/show_bug.cgi?id=5230
         */
        if (needsFensure(fdv!) && fdv!.semanticRun !== PASS.semantic3done) {
            assert(fdv!._scope !== null);
            const sc: Scope = fdv!._scope!.push();
            sc.stc = (sc.stc & ~STC.override_) as STC;
            semantic3(fdv!, sc);
            sc.pop();
        }
        sf = mergeFensure(fdv!, sf, oid, params);
        if (fdv!.fdensure() === null)
            continue;

        //printf("fdv.fensure: %s\n", fdv.fensure.toChars());
        // Make the call: __ensure(result, params)
        params = Expression.arraySyntaxCopy(params);
        if (canBuildResultVar(fd)) {
            const t1: Type = toBasetype(nextOf(fdv!.type!)!);
            const t2: Type = toBasetype(nextOf(fd.type!)!);
            if (isBaseOf(t1, t2, null)) {
                /* Making temporary reference variable is necessary
                 * in covariant return.
                 * https://issues.dlang.org/show_bug.cgi?id=5204
                 * https://issues.dlang.org/show_bug.cgi?id=10479
                 */
                // D `Expression* eresult = &(*params)[0];` — a POINTER to the slot, written through
                // below. The port writes the slot directly (02 §10 pointer-to-element by role).
                const eresult: Expression | null = params!.opIndex(0);
                const ei = new ExpInitializer(Loc.initial, eresult);
                const v = new VarDeclaration(Loc.initial, t1, Identifier.generateId(ds("__covres")), ei);
                v.storage_class = (v.storage_class | STC.temp) as STC;
                const de = new DeclarationExp(Loc.initial, v);
                const ve = new VarExp(Loc.initial, v);
                params!.opIndexAssign(new CommaExp(Loc.initial, de, ve), 0);
            }
        }
        const e: Expression = new CallExp(fd.loc, new VarExp(fd.loc, fdv!.fdensure()!, false), params);
        const s2: Statement = new ExpStatement(fd.loc, e);
        if (sf !== null) {
            sf = CompoundStatement.fromStatementList(sf.loc, s2, sf);
        } else
            sf = s2;
    }
    return sf;
}

/*******************************
 * dmd/funcsem.d:3174 — `void modifyReturns(FuncLiteralDeclaration fld, Scope* sc, Type tret)`.
 * Modify all expression type of return statements to tret.
 *
 * On function literals, return type may be modified based on the context type
 * after its semantic3 is done, in FuncExp::implicitCastTo.
 *
 *  A function() dg = (){ return new B(); } // OK if is(B : A) == true
 *
 * If B to A conversion is convariant that requires offseet adjusting,
 * all return statements should be adjusted to return expressions typed A.
 *
 * The nested `extern (C++) final class RetWalker : StatementRewriteWalker` (funcsem.d:3176) is
 * hoisted to module level as `RetWalker` below (it captures nothing of `modifyReturns`' frame).
 */
export function modifyReturns(fld: FuncLiteralDeclaration, sc: Scope, tret: Type): void {
    if (fld.semanticRun < PASS.semantic3done)
        return;
    if (fld.fes !== null)
        return;
    const w = new RetWalker(); // `scope RetWalker w = ...` — scope erased (04 §8)
    w.sc = sc;
    w.tret = tret;
    w.fld = fld;
    fld.fbody!.accept(w);
    // Also update the inferred function type to match the new return type.
    // This is required so the code generator does not try to cast the
    // modified returns back to the original type.
    if (fld.inferRetType && nextOf(fld.type!) !== tret)
        fld.type!.toTypeFunction().next = tret;
}

/// dmd/funcsem.d:3176 — `extern (C++) final class RetWalker : StatementRewriteWalker`, nested in
/// `modifyReturns` in D. Rewrites each `return exp;` whose `exp.type` differs from `tret` to
/// `exp.implicitCastTo(sc, tret)`. `alias visit = typeof(super).visit;` (funcsem.d:3178) is dropped (13 §1).
class RetWalker extends StatementRewriteWalker {
    sc: Scope | null = null;
    tret: Type | null = null;
    fld: FuncLiteralDeclaration | null = null;

    /// funcsem.d:3183 — `override void visit(ReturnStatement s)` (13 §1 renaming).
    override visitReturnStatement(s: ReturnStatement): void {
        const exp = s.exp;
        if (exp !== null && !exp.type!.equals(this.tret!))
            s.exp = implicitCastTo(exp, this.sc, this.tret!);
    }
}

/**************************************
 * dmd/funcsem.d:3221 — `bool isRootTraitsCompilesScope(Scope* sc) @safe`.
 * When a traits(compiles) is used on a function literal call
 * we need to take into account if the body of the function
 * violates any attributes, however, we must not affect the
 * attribute inference on the outer function. The attributes
 * of the function literal still need to be inferred, therefore
 * we need a way to check for the scope that the traits compiles
 * introduces.
 *
 * Params:
 *   sc = scope to be checked for
 *
 * Returns: `true` if the provided scope is the root of the traits compiles list of scopes.
 */
export function isRootTraitsCompilesScope(sc: Scope): boolean {
    return (sc.traitsCompiles) && !sc.func!.skipCodegen;
}

/**
 * dmd/funcsem.d:3243 — `extern (D) void checkMain(FuncDeclaration fd)`.
 *
 * Checks the parameter and return types iff this is a `main` function.
 *
 * The following signatures are allowed for a `D main`:
 * - Either no or a single parameter of type `string[]`
 * - Return type is either `void`, `int` or `noreturn`
 *
 * The following signatures are standard C:
 * - `int main()`
 * - `int main(int, char**)`
 *
 * This function accepts the following non-standard extensions:
 * - `char** envp` as a third parameter
 * - `void` / `noreturn` as return type
 *
 * This function will issue errors for unexpected arguments / return types.
 */
export function checkMain(fd: FuncDeclaration): void {
    if (fd.ident !== Id.main || fd.isMember() !== null || fd.isNested())
        return; // Not a main function

    const tf: TypeFunction = fd.type!.toTypeFunction();

    let retType: Type | null = nextOf(tf);
    if (retType === null) {
        // auto main(), check after semantic
        assert(fd.inferRetType);
        return;
    }

    /// funcsem.d:3260 — nested `static bool isCharPtrPtr(Type t)` (04 §5).
    /// Checks whether `t` is equivalent to `char**`
    /// Ignores qualifiers and treats enums according to their base type
    const isCharPtrPtr = (t: Type): boolean => {
        let tp = toBasetype(t).isTypePointer();
        if (tp === null)
            return false;

        tp = toBasetype(tp.next!).isTypePointer();
        if (tp === null)
            return false;

        return toBasetype(tp.next!).ty === TY.Tchar;
    };

    // Neither of these qualifiers is allowed because they affect the ABI
    const invalidSTC = (STC.out_ | STC.ref_ | STC.lazy_) as STC;

    const nparams = tf.parameterList.length();
    let argerr = false;

    const linkage = fd.resolvedLinkage();
    if (linkage === LINK.d) {
        if (nparams === 1) {
            const fparam0 = tf.parameterList.opIndex(0)!;
            const t = toBasetype(fparam0.type!);
            if (t.ty !== TY.Tarray ||
                nextOf(t)!.ty !== TY.Tarray ||
                nextOf(nextOf(t)!)!.ty !== TY.Tchar ||
                (fparam0.storageClass & invalidSTC) !== 0n) {
                argerr = true;
            }
        }

        if (tf.parameterList.varargs !== VarArg.none || nparams >= 2 || argerr)
            error(fd.loc, ds("%s `%s` parameter list must be empty or accept one parameter of type `string[]`"),
                fd.kind(), fd.toPrettyChars());
    } else if (linkage === LINK.c) {
        // The six accumulations below port D's `argerr |= <expr>` (funcsem.d:3305-3318). `|=` on a
        // bool ALWAYS evaluates its right-hand side, so the predicate is written FIRST and `argerr`
        // second: `argerr = argerr || <expr>` would short-circuit and skip the `toBasetype()` /
        // `isCharPtrPtr()` walks D performs unconditionally. `argerr` is a plain local read, so
        // putting it last changes no evaluation order D observes.
        if (nparams === 2 || nparams === 3) {
            // Argument count must be int
            const argCount = tf.parameterList.opIndex(0)!;
            argerr = ((argCount.storageClass & invalidSTC) !== 0n) || argerr;
            argerr = (toBasetype(argCount.type!).ty !== TY.Tint32) || argerr;

            // Argument pointer must be char**
            const argPtr = tf.parameterList.opIndex(1)!;
            argerr = ((argPtr.storageClass & invalidSTC) !== 0n) || argerr;
            argerr = !isCharPtrPtr(argPtr.type!) || argerr;

            // `char** environ` is a common extension, see J.5.1 of the C standard
            if (nparams === 3) {
                const envPtr = tf.parameterList.opIndex(2)!;
                argerr = ((envPtr.storageClass & invalidSTC) !== 0n) || argerr;
                argerr = !isCharPtrPtr(envPtr.type!) || argerr;
            }
        } else
            argerr = nparams !== 0;

        // Disallow variadic main() - except for K&R declarations in C files.
        // E.g. int main(), int main(argc, argv) int argc, char** argc { ... }
        if (tf.parameterList.varargs !== VarArg.none &&
            (!fd.isCsymbol() || (!tf.parameterList.hasIdentifierList && nparams !== 0)))
            argerr = true;

        if (argerr) {
            error(fd.loc, ds("%s `%s` parameters must match one of the following signatures"),
                fd.kind(), fd.toPrettyChars());
            errorSupplemental(fd.loc, ds("`main()`"));
            errorSupplemental(fd.loc, ds("`main(int argc, char** argv)`"));
            errorSupplemental(fd.loc, ds("`main(int argc, char** argv, char** environ)` [POSIX extension]"));
        }
    } else
        return; // Neither C nor D main, ignore (should probably be an error)

    // Allow enums with appropriate base types (same ABI)
    retType = toBasetype(retType);

    if (retType.ty !== TY.Tint32 && retType.ty !== TY.Tvoid && retType.ty !== TY.Tnoreturn)
        error(fd.loc, ds("%s `%s` must return `int`, `void` or `noreturn`, not `%s`"),
            fd.kind(), fd.toPrettyChars(), nextOf(tf)!.toChars());
}

/// dmd/funcsem.d:3347 — `enum LevelError = -2;` (a manifest constant, 02 §4.1).
export const LevelError = -2;

/*****************************************
 * dmd/funcsem.d:3361 — `extern (D) int getLevel(FuncDeclaration fd1, FuncDeclaration fd2,
 * int intypeof)`.
 * Determine lexical level difference from `fd1` to nested function `fd2`.
 * Returns:
 *      0       same level
 *      >0      decrease nesting by number
 *      -1      increase nesting by 1 (`fd2` is nested within `fd1`)
 *      LevelError  error, `this` cannot call `fd2`
 */
export function getLevel(fd1: FuncDeclaration, fd2: FuncDeclaration, intypeof: number): number {
    //printf("FuncDeclaration::getLevel(fd2 = '%s')\n", fd2.toChars());
    const fd2parent = fd2.toParent2();
    if (fd2parent === (fd1))
        return -1;

    let s: Dsymbol = fd1;
    let level = 0;
    while ((fd2) !== s && fd2parent !== s.toParent2()) {
        //printf("\ts = %s, '%s'\n", s.kind(), s.toChars());
        const thisfd = s.isFuncDeclaration();
        if (thisfd !== null) {
            if (!thisfd.isNested() && thisfd.vthis === null && intypeof === 0)
                return LevelError;
        } else {
            const thiscd = s.isAggregateDeclaration();
            if (thiscd !== null) {
                /* AggregateDeclaration::isNested returns true only when
                 * it has a hidden pointer.
                 * But, calling the function belongs unrelated lexical scope
                 * is still allowed inside typeof.
                 *
                 * struct Map(alias fun) {
                 *   typeof({ return fun(); }) RetType;
                 *   // No member function makes Map struct 'not nested'.
                 * }
                 */
                if (!thiscd.isNested() && intypeof === 0)
                    return LevelError;
            } else
                return LevelError;
        }

        // funcsem.d:3399 — `s = s.toParentP(fd2);` UFCS (04 §6) to the dmd.dsymbolsem free function,
        // receiver first. D's `assert(s)` on the next line is the real runtime check, so the result is
        // held nullable until it has passed (a `!` here would make the assert vacuous).
        const sParent = toParentP(s, fd2);
        assert(sParent !== null);
        s = sParent;
        level++;
    }
    return level;
}

/* For all functions between outerFunc and f, mark them as needing a closure.
 * dmd/funcsem.d:3409 — `private void markAsNeedingClosure(Dsymbol f, FuncDeclaration outerFunc)`.
 * Emitted WITHOUT `private`: D module-private, reached by siblings in this module.
 */
function markAsNeedingClosure(f: Dsymbol | null, outerFunc: FuncDeclaration): void {
    // `f` is `Dsymbol | null` because the body NULL-TESTS it (02 §10.1): D's caller at funcsem.d:3562
    // passes `fx.toParentP(fd)`, which is nullable, and D's loop head simply ends on null.
    for (let sx: Dsymbol | null = f; sx !== null && sx !== (outerFunc);
         // funcsem.d:3411 — `sx = sx.toParentP(outerFunc)`; UFCS (04 §6), receiver first.
         sx = toParentP(sx, outerFunc)) {
        const fy = sx.isFuncDeclaration();
        if (fy !== null && fy.closureVars.length !== 0) {
            /* fy needs a closure if it has closureVars[],
             * because the frame pointer in the closure will be accessed.
             */
            fy.requiresClosure = true;
        }
    }
}

/**
 * dmd/funcsem.d:3440 — `static struct PrevSibling { PrevSibling* p; FuncDeclaration f; }`.
 * D nests this struct inside `checkEscapingSiblings`; the port hoists it to module scope because
 * the enclosing function's OWN parameter type names it (TS cannot reference a type declared inside
 * the function body from that function's signature). Plain field-wise value struct (03 §2).
 */
class PrevSibling {
    // D `PrevSibling* p` — a pointer to a value struct is the object reference (02 §10, 03 §7).
    p: PrevSibling | null = null;
    f: FuncDeclaration | null = null;

    copy(): PrevSibling {
        const c = new PrevSibling();
        c.p = this.p;   // pointer field: share the reference
        c.f = this.f;   // class reference: share
        return c;
    }
}

/********
 * dmd/funcsem.d:3438 — `bool checkEscapingSiblings(FuncDeclaration f, FuncDeclaration outerFunc,
 * void* p = null)`.
 * Given a nested function f inside a function outerFunc, check
 * if any sibling callers of f have escaped. If so, mark
 * all the enclosing functions as needing closures.
 * This is recursive: we need to check the callers of our siblings.
 * Note that nested functions can only call lexically earlier nested
 * functions, so loops are impossible.
 * Params:
 *      f = inner function (nested within outerFunc)
 *      outerFunc = outer function
 *      p = for internal recursion use
 * Returns:
 *      true if any closures were needed
 *
 * D's `void* p` is typed BY ROLE (02 §10 / cheatsheet): the only value ever stored in it is a
 * `PrevSibling*` (D's own `cast(PrevSibling*)p` round-trips it), so the port names the concrete
 * type and no reinterpret cast is needed.
 */
export function checkEscapingSiblings(f: FuncDeclaration, outerFunc: FuncDeclaration,
                                      p: PrevSibling | null = null): boolean {
    if (f.computedEscapingSiblings)
        return f.hasEscapingSiblings;

    const ps = new PrevSibling();
    ps.p = p;
    ps.f = f;

    //printf("checkEscapingSiblings(f = %s, outerfunc = %s)\n", f.toChars(), outerFunc.toChars());
    let bAnyClosures = false;
    for (let i = 0; i < f.siblingCallers.length; ++i) {
        const g: FuncDeclaration = f.siblingCallers.opIndex(i)!;
        if (g.isThis() !== null || g.tookAddressOf !== 0) {
            markAsNeedingClosure(g, outerFunc);
            bAnyClosures = true;
        }

        // funcsem.d:3464 — `for (auto parent = g.toParentP(outerFunc); parent && parent !is outerFunc;
        // parent = parent.toParentP(outerFunc))`. UFCS (04 §6), receiver first — note the two calls
        // have DIFFERENT receivers (`g` in the init, `parent` in the increment).
        for (let parent: Dsymbol | null = toParentP(g, outerFunc);
             parent !== null && parent !== (outerFunc);
             parent = toParentP(parent, outerFunc)) {
            // A parent of the sibling had its address taken.
            // Assume escaping of parent affects its children, so needs propagating.
            // see https://issues.dlang.org/show_bug.cgi?id=19679
            const parentFunc = parent.isFuncDeclaration();
            if (parentFunc !== null && parentFunc.tookAddressOf !== 0) {
                markAsNeedingClosure(parentFunc, outerFunc);
                bAnyClosures = true;
            }
        }

        let prev: PrevSibling | null = p;
        for (;;) {
            if (prev === null) {
                bAnyClosures = checkEscapingSiblings(g, outerFunc, ps) || bAnyClosures;
                break;
            }
            if (prev.f === g)
                break;
            prev = prev.p;
        }
    }
    f.hasEscapingSiblings = bAnyClosures;
    f.computedEscapingSiblings = true;
    //printf("\t%d\n", bAnyClosures);
    return bAnyClosures;
}

/*******************************
 * dmd/funcsem.d:3501 — `bool needsClosure(FuncDeclaration fd)`.
 * Look at all the variables in this function that are referenced
 * by nested functions, and determine if a closure needs to be
 * created for them.
 */
export function needsClosure(fd: FuncDeclaration): boolean {
    /* Need a closure for all the closureVars[] if any of the
     * closureVars[] are accessed by a
     * function that escapes the scope of this function.
     * We take the conservative approach and decide that a function needs
     * a closure if it:
     * 1) is a virtual function
     * 2) has its address taken
     * 3) has a parent that escapes
     * 4) calls another nested function that needs a closure
     *
     * Note that since a non-virtual function can be called by
     * a virtual one, if that non-virtual function accesses a closure
     * var, the closure still has to be taken. Hence, we check for isThis()
     * instead of isVirtual(). (thanks to David Friedman)
     *
     * When the function returns a local struct or class, `requiresClosure`
     * is already set to `true` upon entering this function when the
     * struct/class refers to a local variable and a closure is needed.
     */
    //printf("FuncDeclaration::needsClosure() %s\n", toPrettyChars());

    // `Lyes:` (funcsem.d:3585) is a terminal BAIL tail — the zero-param nested arrow of 06 §4.
    const LyesTail = (): boolean => {
        return true;
    };

    if (fd.requiresClosure)
        return LyesTail();          // goto Lyes (dmd/funcsem.d:3525)

    for (let i = 0; i < fd.closureVars.length; i++) {
        const v: VarDeclaration = fd.closureVars.opIndex(i)!;
        //printf("\tv = %s\n", v.toChars());

        for (let j = 0; j < v.nestedrefs.length; j++) {
            const f: FuncDeclaration = v.nestedrefs.opIndex(j)!;
            assert(f !== fd);

            /* __require and __ensure will always get called directly,
             * so they never make outer functions closure.
             */
            if (f.ident === Id.require || f.ident === Id.ensure)
                continue;

            //printf("\t\tf = %p, %s, isVirtual=%d, isThis=%p, tookAddressOf=%d\n", …);

            /* Look to see if f escapes. We consider all parents of f within
             * this, and also all siblings which call f; if any of them escape,
             * so does f.
             * Mark all affected functions as requiring closures.
             */
            // funcsem.d:3550 — `for (Dsymbol s = f; s && s != fd; s = s.toParentP(fd))`.
            // UFCS (04 §6), receiver first.
            for (let s: Dsymbol | null = f;
                 s !== null && s !== (fd);
                 s = toParentP(s, fd)) {
                const fx = s.isFuncDeclaration();
                if (fx === null)
                    continue;
                if (fx.isThis() !== null || fx.tookAddressOf !== 0) {
                    /* Mark as needing closure any functions between this and f
                     */
                    // funcsem.d:3561 — `markAsNeedingClosure((fx == f) ? fx.toParentP(fd) : fx, fd);`
                    // UFCS (04 §6), receiver `fx` — a DIFFERENT call site from the loop increment above.
                    markAsNeedingClosure((fx === f) ? toParentP(fx, fd) : (fx), fd);

                    fd.requiresClosure = true;
                }

                /* We also need to check if any sibling functions that
                 * called us, have escaped. This is recursive: we need
                 * to check the callers of our siblings.
                 */
                if (checkEscapingSiblings(fx, fd))
                    fd.requiresClosure = true;

                /* https://issues.dlang.org/show_bug.cgi?id=12406
                 * Iterate all closureVars to mark all descendant
                 * nested functions that access to the closing context of this function.
                 */
            }
        }
    }
    if (fd.requiresClosure)
        return LyesTail();          // goto Lyes (dmd/funcsem.d:3581)

    return false;
}

/***********************************************
 * dmd/funcsem.d:3596 — `extern (D) bool checkNRVO(FuncDeclaration fd)`.
 * Check all return statements for a function to verify that returning using NRVO is possible.
 * Returns:
 *      `false` if the result cannot be returned by hidden reference.
 */
export function checkNRVO(fd: FuncDeclaration): boolean {
    //printf("checkNRVO*() %s\n", fd.ident.toChars());
    if (!fd.isNRVO || fd.returns === null)
        return false;

    const tf: TypeFunction = fd.type!.toTypeFunction();
    if (tf.isRef)
        return false;

    for (const rs of fd.returns.opSlice()) {
        const ve = rs!.exp!.isVarExp();
        if (ve !== null) {
            const v = ve.var_!.isVarDeclaration();
            if (v === null || v.isReference())
                return false;
            if (fd.nrvo_var === null) {
                // Variables in the data segment (e.g. globals, TLS or not),
                // parameters and closure variables cannot be NRVOed.
                if (v.isDataseg() || v.isParameter() || v.toParent2() !== (fd))
                    return false;
                if (v.nestedrefs.length !== 0 && needsClosure(fd))
                    return false;

                // don't know if the return storage is aligned
                // resolved: `mixin alignSectionVarsContains;` (funcsem.d:3623 -> targetcompiler.d:132)
                // under IN_LLVM -> `bool isAlignSectionVar(VarDeclaration v) { return false; }`.
                const isAlignSectionVar = (_v: VarDeclaration): boolean => false;
                if (isAlignSectionVar(v))
                    return false;

                // The variable type needs to be equivalent to the return type.
                if (!equivalent(v.type!, tf.next!))
                    return false;
                //printf("Setting nrvo to %s\n", v.toChars());
                fd.nrvo_var = v;
            } else if (fd.nrvo_var !== v)
                return false;
        } else //if (!exp.isLvalue())    // keep NRVO-ability
            return false;
    }
    return true;
}

/**************************************
 * dmd/funcsem.d:3653 — `extern (D) bool setImpure(FuncDeclaration fd, Loc loc, const(char)* fmt,
 * RootObject[] args...)`.
 * The function is doing something impure, so mark it as impure.
 *
 * Params:
 *     fd = function declaration to mark
 *     loc = location of impure action
 *     fmt = format string for error message
 *     args = argument to format string
 *
 * Returns: `true` if there's a purity error
 *
 * Typesafe variadic (04 §3.2): `RootObject[] args...` becomes `...args: RootObject[]`; every call
 * site spreads an existing array.
 */
export function setImpure(fd: FuncDeclaration, loc: Loc, fmt: DString | null,
                          ...args: (RootObject | null)[]): boolean {
    if (fd.purityInprocess) {
        fd.purityInprocess = false;
        if (fmt !== null)
            fd.pureViolation = AttributeViolation.fromFormat(loc, fmt, args); // impure action
        else if (args.length > 0) {
            const sa = isDsymbol(args[0]);
            if (sa !== null) {
                const fd2 = sa.isFuncDeclaration();
                if (fd2 !== null) {
                    fd.pureViolation = AttributeViolation.fromFuncDeclaration(loc, fd2); // call to impure function
                }
            }
        }

        if (fd.fes !== null)
            setImpure(fd.fes.func!, loc, fmt, ...args);
    } else if (isPure(fd) !== PURE.impure)
        // D `else if (fd.isPure())` reads the PURE enum in a boolean context: `PURE.impure == 0` is
        // false, weak/const/strong are true — the mandatory enum-truthiness expansion (09 §9.1).
        return true;
    return false;
}

/**
 * dmd/funcsem.d:3679 — `PURE isPure(FuncDeclaration fd)`.
 * The purity of `fd`, after folding in the strength reductions a nested function / a non-immutable
 * `this` impose.
 */
export function isPure(fd: FuncDeclaration): PURE {
    //printf("FuncDeclaration::isPure() '%s'\n", toChars());

    const tf: TypeFunction = fd.type!.toTypeFunction();
    if (fd.purityInprocess)
        setImpure(fd, Loc.initial, null);
    if (tf.purity === PURE.fwdref)
        purityLevel(tf);
    let purity: PURE = tf.purity;
    if (purity > PURE.weak && fd.isNested())
        purity = PURE.weak;
    if (purity > PURE.weak && fd.needThis()) {
        // The attribute of the 'this' reference affects purity strength
        if ((fd.type!.mod & MODFlags.immutable_) !== 0) {
            // (empty in D — an immutable `this` does not weaken purity)
        } else if ((fd.type!.mod & (MODFlags.const_ | MODFlags.wild)) !== 0 && purity >= PURE.const_)
            purity = PURE.const_;
        else
            purity = PURE.weak;
    }
    tf.purity = purity;
    // ^ This rely on the current situation that every FuncDeclaration has a
    //   unique TypeFunction.
    return purity;
}

/// dmd/funcsem.d:3709 — `extern (D) PURE isPureBypassingInference(FuncDeclaration fd)`.
export function isPureBypassingInference(fd: FuncDeclaration): PURE {
    if (fd.purityInprocess)
        return PURE.fwdref;
    else
        return isPure(fd);
}

/**************************************
 * dmd/funcsem.d:3745 — `private bool traverseIndirections(Type ta, Type tb)`.
 * Performs type-based alias analysis between a newly created value and a pre-existing memory
 * reference. Returns true if reference to `tb` is isolated from reference to `ta`.
 * Emitted WITHOUT `private`: D module-private, reached by siblings in this module.
 */
function traverseIndirections(ta: Type, tb: Type): boolean {
    //printf("traverseIndirections(%s, %s)\n", ta.toChars(), tb.toChars());

    // funcsem.d:3749 — nested `static bool traverse(Type ta, Type tb,
    //   ref scope AssocArray!(const(char)*, bool) table, bool reversePass)` (04 §5; `scope` erases).
    // The `ref` table is an object reference in the port — no box needed (03 §3.2 alias).
    const traverse = (taIn: Type, tbIn: Type, table: AssocArray<string, boolean>,
                      reversePass: boolean): boolean => {
        //printf("traverse(%s, %s)\n", ta.toChars(), tb.toChars());
        const taB = baseElemOf(taIn);
        const tbB = baseElemOf(tbIn);

        // First, check if the pointed-to types are convertible to each other such
        // that they might alias directly.
        // funcsem.d:3757 — nested `static bool mayAliasDirect(Type source, Type target)`.
        const mayAliasDirect = (source: Type, targetT: Type): boolean => {
            return (
                // if source is the same as target or can be const-converted to target
                constConv(source, targetT) !== MATCH.nomatch ||
                // if target is void and source can be const-converted to target
                (targetT.ty === TY.Tvoid && MODimplicitConv(source.mod, targetT.mod)));
        };

        if (mayAliasDirect(reversePass ? tbB : taB, reversePass ? taB : tbB)) {
            //printf(" true  mayalias %s %s %d\n", ta.toChars(), tb.toChars(), reversePass);
            return false;
        }
        if (nextOf(taB) !== null && nextOf(taB) === nextOf(tbB)) {
            //printf(" next==next %s %s %d\n", ta.toChars(), tb.toChars(), reversePass);
            return true;
        }

        if (tbB.ty === TY.Tclass || tbB.ty === TY.Tstruct) {
            /* Traverse the type of each field of the aggregate
             */
            // D `bool* found = table.getLvalue(tb.deco); if (*found) return true; else *found = true;`
            // — the port's AssocArray has no `getLvalue`; get/set express the same slot semantics
            // (an absent key reads as the `bool.init` false).
            if (table.get(tbB.deco!) === true)
                return true; // We have already seen this symbol, break the cycle
            else
                table.set(tbB.deco!, true);

            const sym: AggregateDeclaration = toDsymbol(tbB, null)!.isAggregateDeclaration()!;
            for (const v of sym.fields.opSlice()) {
                const tprmi = addMod(v!.type!, tbB.mod);
                //printf("\ttb = %s, tprmi = %s\n", tb.toChars(), tprmi.toChars());
                if (!traverse(taB, tprmi, table, reversePass))
                    return false;
            }
        } else if (tbB.ty === TY.Tarray || tbB.ty === TY.Taarray || tbB.ty === TY.Tpointer) {
            const tind = nextOf(tbB);
            if (!traverse(taB, tind!, table, reversePass))
                return false;
        } else if (hasPointers(tbB)) {
            // BUG: consider the context pointer of delegate types
            return false;
        }

        // Still no match, so try breaking up ta if we have not done so yet.
        if (!reversePass) {
            const newTable = new AssocArray<string, boolean>();
            return traverse(tbB, taB, newTable, true);
        }

        return true;
    };

    // To handle arbitrary levels of indirections in both parameters, we
    // recursively descend into aggregate members/levels of indirection in both
    // `ta` and `tb` while avoiding cycles. Start with the original types.
    const table = new AssocArray<string, boolean>();
    const result = traverse(ta, tb, table, false);
    //printf("  returns %d\n", result);
    return result;
}

/********************************************
 * dmd/funcsem.d:3836 — `private bool isTypeIsolatedIndirect(FuncDeclaration fd, Type t)`.
 * Returns: true if an object typed `t` has no indirections which could have come from the
 * function's parameters, mutable globals, or uplevel functions.
 * Emitted WITHOUT `private`: D module-private, reached by siblings in this module.
 */
function isTypeIsolatedIndirect(fd: FuncDeclaration, t: Type): boolean {
    //printf("isTypeIsolatedIndirect(t: %s)\n", t.toChars());
    assert(t !== null);

    /* Since `t` is one level down from an indirection, it could pick
     * up a reference to a mutable global or an outer function, so
     * return false.
     */
    if (isPureBypassingInference(fd) === PURE.impure || fd.isNested())
        return false;

    const tf: TypeFunction = fd.type!.toTypeFunction();

    //printf("isTypeIsolatedIndirect(%s) t = %s\n", tf.toChars(), t.toChars());

    // funcsem.d:3870 — nested `static bool traverse(Type tp, Type t)` (04 §5), declared inside the
    // parameter loop in D; hoisted above the loop here (it captures nothing loop-carried).
    const traverse = (tpIn: Type, tIn: Type): boolean => {
        const tp = baseElemOf(tpIn);
        switch (tp.ty) {
            case TY.Tarray:
            case TY.Tpointer:
                return traverseIndirections(nextOf(tp)!, tIn);

            case TY.Taarray:
            case TY.Tclass:
                return traverseIndirections(tp, tIn);

            case TY.Tstruct: {
                /* Drill down and check the struct's fields
                 */
                const sym = toDsymbol(tp, null)!.isStructDeclaration()!;
                for (const v of sym.fields.opSlice()) {
                    const tprmi = addMod(v!.type!, tp.mod);
                    //printf("\ttp = %s, tprmi = %s\n", tp.toChars(), tprmi.toChars());
                    if (!traverse(tprmi, tIn))
                        return false;
                }
                return true;
            }

            default:
                return true;
        }
    };

    let isolated = true;
    tf.parameterList.opApply((_i: number, fparam: Parameter | null): number => {
        const tp = fparam!.type;
        if (tp === null)
            return 0;   // D `continue`

        if (fparam!.isLazy() || fparam!.isReference()) {
            if (!traverseIndirections(tp, t)) {
                isolated = false;
                return 1;   // D `return false` from the enclosing function
            }
            return 0;       // D `continue`
        }

        /* Goes down one level of indirection, then calls traverseIndirection() on
         * the result. (the nested `traverse` above)
         */
        if (!traverse(tp, t)) {
            isolated = false;
            return 1;       // D `return false` from the enclosing function
        }
        return 0;
    });
    if (!isolated)
        return false;

    // The 'this' reference is a parameter, too
    const ad: AggregateDeclaration | null = fd.isCtorDeclaration() !== null ? null : fd.isThis();
    if (ad !== null) {
        // funcsem.d:3907 — `dmd.dsymbolsem.getType(ad)`, the fully-qualified free function (04 §6.1).
        const tthis = addMod(getType(ad)!, tf.mod);
        //printf("\ttthis = %s\n", tthis.toChars());
        if (!traverseIndirections(tthis, t))
            return false;
    }

    return true;
}

/********************************************
 * dmd/funcsem.d:3923 — `extern (D) bool isReturnIsolated(FuncDeclaration fd)`.
 * See if pointers from function parameters, mutable globals, or uplevel functions
 * could leak into return value.
 * Returns:
 *   true if the function return value is isolated from any inputs to the function
 */
export function isReturnIsolated(fd: FuncDeclaration): boolean {
    //printf("isReturnIsolated(this: %s)\n", this.toChars);
    const tf: TypeFunction = fd.type!.toTypeFunction();
    assert(tf.next !== null);

    const treti: Type = tf.next!;
    if (tf.isRef)
        return isTypeIsolatedIndirect(fd, treti);              // check influence from parameters

    return isTypeIsolated(fd, treti);
}

/********************
 * dmd/funcsem.d:3945 — `extern (D) bool isTypeIsolated(FuncDeclaration fd, Type t)`.
 * See if pointers from function parameters, mutable globals, or uplevel functions
 * could leak into type `t`.
 * Params:
 *   t = type to check if it is isolated
 * Returns:
 *   true if `t` is isolated from any inputs to the function
 *
 * Overload pair (04 §1.1(b)): the 3-parameter `isTypeIsolated(fd, t, ref parentTypes)` at
 * funcsem.d:3968 has a DIFFERENT body (this one is the caching entry point), so Form A's
 * optional-trailing-parameter merge does not apply — the longer form takes the distinguishing
 * suffix `ParentTypes`. This entry point keeps the bare name.
 */
export function isTypeIsolated(fd: FuncDeclaration, t: Type): boolean {
    const parentTypes = new StringTable<Type>();
    const uniqueTypeID = t.getUniqueID();
    if (uniqueTypeID !== 0) {
        // D `const cacheResultPtr = uniqueTypeID in fd.isTypeIsolatedCache;` — the AA `in`
        // expression yields a pointer-or-null; `Map.get` is the port's spelling (02 §9, 08 §5).
        const cacheResult = fd.isTypeIsolatedCache.get(uniqueTypeID);
        if (cacheResult !== undefined)
            return cacheResult;

        parentTypes._init();
        const isIsolated = isTypeIsolatedParentTypes(fd, t, parentTypes);
        fd.isTypeIsolatedCache.set(uniqueTypeID, isIsolated);
        return isIsolated;
    } else {
        parentTypes._init();
        return isTypeIsolatedParentTypes(fd, t, parentTypes);
    }
}

///ditto — dmd/funcsem.d:3968 — `extern (D) bool isTypeIsolated(FuncDeclaration fd, Type t,
/// ref StringTable!Type parentTypes)`. See the overload note on `isTypeIsolated`.
export function isTypeIsolatedParentTypes(fd: FuncDeclaration, t: Type,
                                          parentTypes: StringTable<Type>): boolean {
    //printf("this: %s, isTypeIsolated(t: %s)\n", this.toChars(), t.toChars());

    const tb = baseElemOf(t);
    switch (tb.ty) {
        case TY.Tarray:
        case TY.Tpointer:
            return isTypeIsolatedIndirect(fd, nextOf(tb)!); // go down one level

        case TY.Taarray:
        case TY.Tclass:
            return isTypeIsolatedIndirect(fd, tb);

        case TY.Tstruct: {
            /* Drill down and check the struct's fields
             */
            const sym = toDsymbol(tb, null)!.isStructDeclaration()!;
            // D `t.toChars.toDString` — `toChars()` returns a NUL-terminated view; `toDString`
            // trims it to the logical string (02 §11.2 / cheatsheet C-string view).
            const tName = cstr(tb.toChars());
            const entry = parentTypes.insert(tName, tb);
            if (entry === null) {
                //we've already seen this type in a parent, not isolated
                return false;
            }
            for (const v of sym.fields.opSlice()) {
                const tmi = addMod(v!.type!, tb.mod);
                //printf("\tt = %s, v: %s, vtype: %s,  tmi = %s\n", …);
                if (!isTypeIsolatedParentTypes(fd, tmi, parentTypes))
                    return false;
            }
            return true;
        }

        default:
            return true;
    }
}

/**
 * dmd/funcsem.d:4022 — `private void checkPrintfScanfSignature(FuncDeclaration funcdecl,
 * TypeFunction f, Scope* sc)`.
 * Check signature of `pragma(printf)` function, print error if invalid.
 *
 * printf/scanf-like functions must be of the form:
 *    extern (C/C++) T printf([parameters...], const(char)* format, ...);
 * or:
 *    extern (C/C++) T vprintf([parameters...], const(char)* format, va_list);
 *
 * Emitted WITHOUT `private`: D module-private, reached by `funcDeclarationSemantic`.
 */
function checkPrintfScanfSignature(funcdecl: FuncDeclaration, f: TypeFunction, sc: Scope): void {
    // funcsem.d:4024 — nested `static bool isPointerToChar(Parameter p)` (04 §5).
    const isPointerToChar = (p: Parameter): boolean => {
        const tptr = p.type!.isTypePointer();
        if (tptr !== null) {
            return tptr.next!.ty === TY.Tchar;
        }
        return false;
    };

    // funcsem.d:4033 — nested `bool isVa_list(Parameter p)` (04 §5; captures funcdecl/sc).
    const isVa_list = (p: Parameter): boolean => {
        return p.type!.equals(target.va_listType(funcdecl.loc, sc));
    };

    const nparams = f.parameterList.length();
    const p = (funcdecl.printf ? Id.printf : Id.scanf)!.toChars();
    if (!(f.linkage === LINK.c || f.linkage === LINK.cpp)) {
        error(funcdecl.loc,
            ds("`pragma(%s)` function `%s` must have `extern(C)` or `extern(C++)` linkage, not `extern(%s)`"),
            p, funcdecl.toChars(), linkageToChars(f.linkage));
    }
    if (f.parameterList.varargs === VarArg.variadic) {
        if (!(nparams >= 1 && isPointerToChar(f.parameterList.opIndex(nparams - 1)!))) {
            error(funcdecl.loc,
                ds("`pragma(%s)` function `%s` must have signature `%s %s([parameters...], const(char)*, ...)` not `%s`"),
                p, funcdecl.toChars(), f.next!.toChars(), funcdecl.toChars(), funcdecl.type!.toChars());
        }
    } else if (f.parameterList.varargs === VarArg.none) {
        if (!(nparams >= 2 && isPointerToChar(f.parameterList.opIndex(nparams - 2)!) &&
            isVa_list(f.parameterList.opIndex(nparams - 1)!)))
            error(funcdecl.loc,
                ds("`pragma(%s)` function `%s` must have signature `%s %s([parameters...], const(char)*, va_list)`"),
                p, funcdecl.toChars(), f.next!.toChars(), funcdecl.toChars());
    } else {
        error(funcdecl.loc,
            ds("`pragma(%s)` function `%s` must have C-style variadic `...` or `va_list` parameter"),
            p, funcdecl.toChars());
    }
    void sc;   // read only inside the walled `isVa_list` (funcsem.d:4035)
}

/***************************************************
 * dmd/funcsem.d:4084 — `extern (D) int overloadApply(Dsymbol fstart,
 * scope int delegate(Dsymbol) dg, Scope* sc = null)`.
 * Visit each overloaded function/template in turn, and call dg(s) on it.
 * Exit when no more, or dg(s) returns nonzero.
 *
 * Params:
 *  fstart = symbol to start from
 *  dg = the delegate to be called on the overload
 *  sc = context used to check if symbol is accessible (and therefore visible), can be null
 *
 * Returns:
 *      ==0     continue
 *      !=0     done (and the return value from the last dg() call)
 */
export function overloadApply(fstart: Dsymbol | null, dg: (s: Dsymbol) => number,
                              sc: Scope | null = null): number {
    // D `Dsymbols visited;` — an inline BY-VALUE `Array!T` is born EMPTY and usable (09 §1.0).
    const visited: Dsymbols = new DArray<Dsymbol | null>();

    // funcsem.d:4088 — nested `int overloadApplyRecurse(Dsymbol fstart, …)` (04 §5; captures `visited`).
    const overloadApplyRecurse = (fstartIn: Dsymbol | null, dgIn: (s: Dsymbol) => number,
                                  scIn: Scope | null): number => {
        // D declares `Dsymbol next;` ONCE outside the loop and does NOT reset it per iteration —
        // the `isOverloadSet` arm leaves it at its previous value on purpose (1:1).
        let next: Dsymbol | null = null;
        for (let d: Dsymbol | null = fstartIn; d !== null; d = next) {
            // Detect cyclic calls.
            if (visited.contains(d))
                return 0;
            visited.push(d);

            // (funcsem.d:4098 `import dmd.access : checkSymbolAccess;` — module-level import here.)
            const od = d.isOverDeclaration();
            const fa = od === null ? d.isFuncAliasDeclaration() : null;
            const ad = (od === null && fa === null) ? d.isAliasDeclaration() : null;
            const td = (od === null && fa === null && ad === null) ? d.isTemplateDeclaration() : null;
            const fd = (od === null && fa === null && ad === null && td === null)
                ? d.isFuncDeclaration() : null;
            const os = (od === null && fa === null && ad === null && td === null && fd === null)
                ? d.isOverloadSet() : null;

            if (od !== null) {
                /* The scope is needed here to check whether a function in
                 an overload set was added by means of a private alias (or a
                 selective import). If the scope where the alias is created
                 is imported somewhere, the overload set is visible, but the private
                 alias is not.
                 */
                if (scIn !== null) {
                    if (checkSymbolAccess(scIn, d)) {
                        const r = overloadApplyRecurse(od.aliassym, dgIn, scIn);
                        if (r !== 0)
                            return r;
                    }
                } else {
                    const r = overloadApplyRecurse(od.aliassym, dgIn, scIn);
                    if (r !== 0)
                        return r;
                }
                next = od.overnext;
            } else if (fa !== null) {
                if (fa.hasOverloads) {
                    const r = overloadApplyRecurse(fa.funcalias, dgIn, scIn);
                    if (r !== 0)
                        return r;
                } else {
                    const fdAlias = fa.toAliasFunc();
                    // D `else if (auto fd = fa.toAliasFunc())` — `toAliasFunc()` is non-null here in
                    // the port's model, so the else-arm below is D's "aliased to a function" error.
                    if (fdAlias !== null) {
                        const r = dgIn(fdAlias);
                        if (r !== 0)
                            return r;
                    } else {
                        error(d.loc, ds("%s `%s` is aliased to a function"), d.kind(), d.toPrettyChars());
                        break;
                    }
                }
                next = fa.overnext;
            } else if (ad !== null) {
                if (scIn !== null) {
                    // NOTE (1:1): D's `if (checkSymbolAccess(sc, ad)) next = ad.toAlias();` has no
                    // braces, so ONLY the assignment is guarded — reproduced verbatim.
                    if (checkSymbolAccess(scIn, ad))
                        next = toAlias(ad);
                } else
                    next = toAlias(ad);
                if (next === (ad))
                    break;
                if (next === fstartIn)
                    break;
            } else if (td !== null) {
                // Sometimes funcroot is not in the .overnext chain
                // in such case we have to recurse into it
                if (td.funcroot !== null) {
                    const r = overloadApplyRecurse(td.funcroot, dgIn, scIn);
                    if (r !== 0)
                        return r;
                }
                const r = dgIn(td);
                if (r !== 0)
                    return r;
                next = td.overnext;
            } else if (fd !== null) {
                const r = dgIn(fd);
                if (r !== 0)
                    return r;
                next = fd.overnext;
            } else if (os !== null) {
                for (const dsSym of os.a.opSlice()) {
                    const r = dgIn(dsSym!);
                    if (r !== 0)
                        return r;
                }
            } else {
                error(d.loc, ds("%s `%s` is aliased to a function"), d.kind(), d.toPrettyChars());
                break;
                // BUG: should print error message?
            }
        }
        return 0;
    };
    return overloadApplyRecurse(fstart, dg, sc);
}

/**
 * dmd/funcsem.d:4189 — `Dsymbol isUnique(OverDeclaration od)`.
 * Overload pair (04 §1.1(b)) with `isUnique(FuncDeclaration)` at funcsem.d:408 — same arity,
 * different parameter and return type; this form takes the distinguishing suffix.
 */
export function isUniqueOverDeclaration(od: OverDeclaration): Dsymbol | null {
    let result: Dsymbol | null = null;
    overloadApply(od.aliassym, (s: Dsymbol): number => {
        if (result !== null) {
            result = null;
            return 1; // ambiguous, done
        } else {
            result = s;
            return 0;
        }
    });
    return result;
}

/************************************
 * dmd/funcsem.d:4214 — `extern (D) bool checkNestedReference(VarDeclaration vd, Scope* sc, Loc loc)`.
 * Check to see if this variable is actually in an enclosing function rather than the current one.
 * Update nestedrefs[], closureVars[] and outerVars[].
 * Returns: true if error occurs.
 */
export function checkNestedReference(vd: VarDeclaration, sc: Scope, loc: Loc): boolean {
    //printf("VarDeclaration::checkNestedReference() %s\n", toChars());
    if (sc.intypeof === 1 || sc.ctfe)
        return false;
    if (vd.parent === null || vd.parent === sc.parent)
        return false;
    if (vd.isDataseg() || (vd.storage_class & STC.manifest) !== 0n)
        return false;

    // The current function
    const fdthis = sc.parent!.isFuncDeclaration();
    if (fdthis === null)
        return false; // out of function scope

    const p = vd.toParent2();

    // Function literals from fdthis to p must be delegates
    // funcsem.d:4232 — `ensureStaticLinkTo(fdthis, p);`; callee live at dmd/delegatize.d:284. D
    // discards its bool result.
    ensureStaticLinkTo(fdthis, p);

    // The function that this variable is in
    const fdv = p!.isFuncDeclaration();
    if (fdv === null || fdv === fdthis)
        return false;

    //printf("\tfdv = %s\n", fdv.toChars());
    //printf("\tfdthis = %s\n", fdthis.toChars());
    if (loc.isValid()) {
        if (getLevelAndCheck(fdthis, loc, sc, fdv, vd) === LevelError)
            return true;
    }

    if (sc.intypeof === 0 && !sc.traitsCompiles &&
        // https://issues.dlang.org/show_bug.cgi?id=17605
        (fdv.skipCodegen || !fdthis.skipCodegen)) {
        // Add fdthis to nestedrefs[] if not already there
        if (!vd.nestedrefs.contains(fdthis))
            vd.nestedrefs.push(fdthis);

        // Add this VarDeclaration to fdv.closureVars[] if not already there
        if (!fdv.closureVars.contains(vd))
            fdv.closureVars.push(vd);
    }

    if (!fdthis.outerVars.contains(vd))
        fdthis.outerVars.push(vd);

    //printf("fdthis is %s\n", fdthis.toChars());
    //printf("var %s in function %s is nested ref\n", toChars(), fdv.toChars());
    // __dollar creates problems because it isn't a real variable
    // https://issues.dlang.org/show_bug.cgi?id=3326
    if (vd.ident === Id.dollar) {
        error(loc, ds("cannnot use `$` inside a function literal"));
        return true;
    }
    if (vd.ident === Id.withSym) { // https://issues.dlang.org/show_bug.cgi?id=1759
        const ez = vd._init!.isExpInitializer();
        assert(ez !== null);
        let e: Expression = ez!.exp!;
        // `(cast(AssignExp)e).e2` (funcsem.d:4278) — tag-proved RTTI downcast (02 §11.5c item 3): the `op`
        // test proves a ConstructExp/BlitExp, both AssignExp subclasses. `isAssignExp()` cannot be used — it
        // tests `EXP.assign` only, and returned null here.
        if (e.op === EXP.construct || e.op === EXP.blit)
            e = (e as unknown as AssignExp).e2!;
        // funcsem.d:4279 — callee live at dmd/delegatize.d:205.
        return lambdaCheckForNestedRef(e, sc);
    }

    return false;
}

/**********************
 * dmd/funcsem.d:4293 — `bool arrayBoundsCheck(FuncDeclaration fd)`.
 * Check to see if array bounds checking code has to be generated
 * Params:
 *  fd = function for which code is to be generated
 * Returns:
 *  true if do array bounds checking for the given function
 */
export function arrayBoundsCheck(fd: FuncDeclaration | null): boolean {
    switch (global.params.useArrayBounds) {
    case CHECKENABLE.off:
        return false;
    case CHECKENABLE.on:
        return true;
    case CHECKENABLE.safeonly:
        if (fd !== null) {
            const t: Type = fd.type!;
            if (t.isTypeFunction() !== null && t.isTypeFunction()!.trust === TRUST.safe)
                return true;
        }
        return false;
    case CHECKENABLE._default:
        return assertUnreachable();
    default: { // D `final switch` exhaustiveness (06 §3.2)
        const _e: never = global.params.useArrayBounds;
        void _e;
        throw new SwitchError();   // D default message: "No appropriate switch clause found"
    }
    }
}

/**********************
 * dmd/funcsem.d:4322 — `bool nullDerefCheck(FuncDeclaration fd)`.
 * Check to see if null dereference checking code has to be generated
 * Params:
 *  fd = function for which code is to be generated
 * Returns:
 *  true if do null dereference checking for the given function
 */
export function nullDerefCheck(fd: FuncDeclaration | null): boolean {
    switch (global.params.useNullCheck) {
        case CHECKENABLE.off:
            return false;
        case CHECKENABLE.on:
            return true;
        case CHECKENABLE.safeonly:
            if (fd !== null) {
                const t: Type = fd.type!;
                if (t.isTypeFunction() !== null && t.isTypeFunction()!.trust === TRUST.safe)
                    return true;
            }
            return false;
        case CHECKENABLE._default:
            return assertUnreachable();
        default: { // D `final switch` exhaustiveness (06 §3.2)
            const _e: never = global.params.useNullCheck;
            void _e;
            throw new SwitchError();   // D default message: "No appropriate switch clause found"
        }
    }
}

