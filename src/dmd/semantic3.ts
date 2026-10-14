// Ported from dmd/semantic3.d (module dmd.semantic3).
//
// Performs the semantic3 stage of semantic analysis, which finalizes function bodies and late
// semantic checks for templates, mixins, aggregates, and special members.
//
// WHOLE-FILE FAITHFUL TRANSLATION (W3). Every top-level D declaration of semantic3.d is present:
// `LOG`, `semantic3`, `Semantic3Visitor`, `FuncDeclSem3`, `search_toString`,
// `semanticTypeInfoMembers`, `semanticRTInfo`, `checkClosure`, `findClosureVars`. The D module's
// FREE FUNCTIONS are emitted AS FREE FUNCTIONS (04 §6) — no re-homing onto Dsymbol/Type.
//
// VISITOR IDIOM (13 §7, verified by `grep -c 'class .*Visitor' semantic3.d` == 1): this module uses
// Idiom A — one `extern(C++) final class Semantic3Visitor : Visitor` whose `visit(X)` overloads are
// renamed to `visitX` (13 §1) and reached through each node's own `accept` (13 §2).
// `alias visit = Visitor.visit;` (semantic3.d:101) is DROPPED — no overload hiding in TS (13 §1).
//
// COMPILE-TIME RESOLUTION (07, _config.md):
//   - `version (IN_GCC)` OFF -> `version = FastDFA;` is SET, so `version (FastDFA)` is ON
//     (semantic3.d:81-85, :1476). The `import dmd.dfa.entry;` edge and the `dfaEntry` call site are
//     therefore LIVE: the function-local D import is a value import in LAST position (01 §4.4/§4.8).
//   - `enum LOG = false;` -> the three `static if (LOG)` printf blocks (:113, :179, :1599) are
//     resolved OFF and dropped.
//   - `static if (!IN_LLVM)` (:1158) is OFF -> the `_arguments = v_arguments.elements` lowering is
//     dropped (LDC handles D-style variadics itself); `version (IN_LLVM)` (:1204, :1695) is ON.
//   - `version (all)` (:1561) is ON -> the try/catch(Exception) field-dtor lowering is emitted, the
//     `scope(failure)` else-arm is dropped.
//
// WALLS (11 §2.5): none standing; the swept ones are listed under WALLS SWEPT below.
// The `target` members (`va_listType` :456, `isReturnOnStack` :666, `isCalleeDestroyingArgs` :1247,
// `libraryObjectMonitors` :1289, `cpp.parameterType` :1409) are live in target.ts and called at D's
// positions; `isReturnOnStack` answers a struct/static-array return through target.ts's `getArgTypes`
// (gen/abi/abi.cpp:78), which reads `sd.argTypes` (dsymbolsem.d:10290) or asks argtypes_aarch64.ts or
// argtypes_sysv_x64.ts, by the triple's arch.
//
// WALLS SWEPT (14 §8 end-of-wave sweep; the callee is now live, each call cites the authorising D
// definition line at the site):
//   - semantic3.d:124  `templateInstanceSemantic3` -> templatesem.ts (D def templatesem.d:1460)
//   - semantic3.d:1383 `finishScopeParamInference` -> escape.ts     (D def escape.d:2042; swept in
//                                                                    an earlier wave, see :1506)
//   - semantic3.d:856  `exp.checkGC(sc2)`          -> nogc.ts       (D def nogc.d:268)
//   - semantic3.d:981  `exp.checkGC(sc2)`          -> nogc.ts       (D def nogc.d:268)
//   - semantic3.d:1936 `printGCUsage`              -> nogc.ts       (D def nogc.d:307)
//   - semantic3.d:1473 `oblive`                    -> ob.ts         (D def ob.d:56)
//   - semantic3.d:1939 `vgcEnabled`                -> nogc.ts       (D def nogc.d:298)
//   - semantic3.d:1482 `dfaEntry`                  -> dfa/entry.ts  (D def dfa/entry.d:35)
//   - semantic3.d:927  `checkReturnEscapeRef`      -> escape.ts     (D def escape.d:1124)
//   - semantic3.d:978  `checkReturnEscape`         -> escape.ts     (D def escape.d:1106)
//   - semantic3.d:1895 `ctfeInterpret`             -> dinterpret.ts (D def dinterpret.d:67)
// The two `checkGC` sweeps do NOT make the return path throw-free: `nogc.checkGC` carries its own
// wall on `walkPostorder` (dmd/visitor/postorder.d:20, nogc.d:283) on its unconditional path, so the
// halt moved into its owner file. Every expression the nogc.d:271 early-outs let through still
// reaches it; the ones they filter (`gcPassDone`, CTFE blocks, `typeof`, scope-less) now return live.
//
// WALL-INDUCED try/finally (11 §2.5 "walls add exit paths D does not have"): `global.gag` is a
// process-global counter and `funcdecl.inuse` is a re-entry gate, so every startGagging/endGagging
// region that can reach a wall is a `try { … } finally { … }` here even though D needs none —
// semantic3.d:141-168 (template-instance members), :284-295 (generated opAssign, which also carries
// the `inuse` inc/dec), :936-938 (the gagged `implicitCastTo` probe) and :1826-1829
// (`semanticTypeInfoMembers.runSemantic`). Where D reads `endGagging`'s result at that position, the
// result is captured in the finally and tested after.
//
// TIMETRACE (semantic3.d:239-242): the function-local `import dmd.timetrace;` and the
// `timeTraceBeginEvent` / `scope (exit) timeTraceEndEvent` pair are DROPPED, not walled — profiling
// with no semantic effect and no port. Same disposition as the tree's other timetrace sites
// (dmodule.ts:828, dsymbolsem.ts:4017/:4466, funcsem.ts:454).

import { Visitor } from "./visitor/index.js";
import {
    K, KeepUnit, keepMark, keepMember, keepMinst, keepPass, keepReq, keepRTInfo, keepRun, keepUnwind,
} from "../keep.js";
import { Scope, Contract } from "./dscope.js";
import { PASS, DsymbolTable, ScopeDsymbol, Visibility, DSYM } from "./dsymbol.js";
import type { Dsymbol } from "./dsymbol.js";
import { global, FeatureState } from "./globals.js";
import { Id } from "./id.js";
import { STC, LINK, TY, VarArg, CHECKENABLE, TRUST, PURE, MATCH } from "./astenums.js";
import { CSX } from "./ctorflow.js";
import { EXP, TOK } from "./tokens.js";
import { Identifier } from "./identifier.js";
import { VarDeclaration, TupleDeclaration } from "./declaration.js";
import type { TypeInfoAssociativeArrayDeclaration } from "./declaration.js";
import {
    Statement, CompoundStatement, ExpStatement, ErrorStatement, ReturnStatement, TryCatchStatement,
    ThrowStatement, ScopeStatement, DtorExpStatement, TryFinallyStatement, PeelStatement,
    SynchronizedStatement, LabelStatement, Catch, LabelDsymbol,
} from "./statement.js";
import {
    Type, TypeFunction, Parameter, ParameterList, MODtoChars, MODimplicitConv, getException,
    toAutoQualChars,
} from "./mtype.js";
import { Loc } from "./location.js";
import { Array as DArray } from "./root/array.js";
import type { Objects, Statements, FuncDeclarations, Catches } from "./arraytypes.js";
import type { RootObject } from "./rootobject.js";
import { ds } from "../dstring.js";
import { assert, assertUnreachable } from "../assert.js";
import { error, errorSupplemental, deprecation, message, Classification } from "./errors.js";
import {
    Expression, VarExp, DotIdExp, ConstructExp, IntegerExp, SuperExp, CallExp, ThisExp, DotVarExp,
    IdentifierExp, DotTemplateInstanceExp, PtrExp, IndexExp, AssignExp, ArgumentList, WANTvalue,
} from "./expression.js";
import { VoidInitializer } from "./init.js";
import {
    dsymbolSemantic, runDeferredSemantic2, scopeCreateGlobal, newScope, newScopeDsymbol, include,
    checkCtorConstInit, toParentP, allowsContractWithoutBody, toAlias, insert, searchScope } from "./dsymbolsem.js";
import { semantic2 } from "./semantic2.js"; // D `import dmd.semantic2;` (semantic3.d:72)
import { statementSemantic, checkLabel } from "./statementsem.js";
import { blockExit, BE } from "./blockexit.js";
import {
    declareThis, needsFensure, addPreInvariant, addPostInvariant, buildEnsureRequire, mergeFrequire,
    mergeFensure, mergeFrequireInclusivePreview, buildResultVar, checkNRVO, checkMain,
    resolveFuncCall, addInvariant, NrvoWalker, needsClosure, checkEscapingSiblings,
    overloadExactMatch, isTypeIsolated, FuncResolveFlag,
} from "./funcsem.js";
import {
    expressionSemantic, symbolToExp, doCopyOrMove, isLvalue, checkAddressable, semanticTypeInfo,
    toLvalue,
} from "./expressionsem.js";
import {
    checkComplexTransition, checkRetType, hasPointers, isAggregate, immutableOf, wildOf, mutableOf,
    unSharedOf, addMod, arrayOf, merge, constConv, typeSemantic, toBasetype, nextOf, needsNested,
    implicitConvToWithoutAliasThisStruct, implicitConvToWithoutAliasThisClass,
} from "./typesem.js";
import { implicitConvTo, implicitConvToType, implicitCastTo, castTo } from "./dcast.js";
import { optimize } from "./optimize.js";
import { checkGC, printGCUsage, setGC, vgcEnabled } from "./nogc.js";
// Body-fill (01 §4.3): read only inside `funcDeclarationSemantic3`, never at load time.
import { checkReturnEscape, checkReturnEscapeRef, finishScopeParamInference } from "./escape.js";
import { stcToBuffer, toErrMsg, dsymbolToErrMsg } from "./hdrgen.js";
import { OutBuffer } from "./common/outbuffer.js";
import { SwitchVariadic } from "./targetcompiler.js";
import { search_function } from "./opover.js";
import { isError, TemplateInstance } from "./dtemplate.js";
import type { TemplateMixin, TemplateDeclaration } from "./dtemplate.js";
import type { Module } from "./dmodule.js";
import type { AggregateDeclaration } from "./aggregate.js";
import { StructDeclaration } from "./dstruct.js";
import type { Nspace } from "./nspace.js";
import type { AttribDeclaration } from "./attrib.js";
import type { FuncDeclaration, CtorDeclaration } from "./func.js";
// last (01 §4.8): a value import of templatesem.ts entering the SCC here would make this module the
// entry of templatesem -> semantic3; LAST position keeps the existing entry point. Read only inside
// `visitTemplateInstance`, never at load time (01 §4.3).
import { templateInstanceSemantic3 } from "./templatesem.js";
// dmd/semantic3.d:74 (`import dmd.target;`) and :33 (`import dmd.dinterpret;`) — added by the wave-14
// sweep. LAST for the same reason as templatesem above (01 §4.8): target.ts value-imports typesem, and
// dinterpret.ts value-imports the core SCC.
import { target } from "./target.js";
import { ctfeInterpret } from "./dinterpret.js";
// dmd/semantic3.d:57 (`import dmd.ob;`) — LAST for the same reason (01 §4.8): ob.ts value-imports escape,
// typesem and dsymbolsem.
import { oblive } from "./ob.js";
// dmd/semantic3.d:84 (`version (FastDFA) import dmd.dfa.entry;`) — LAST for the same reason (01 §4.8, the
// deferred-edge treatment of 01 §4.4): entry.ts value-imports dfa/fast/*, which enter the SCC through typesem,
// func and expressionsem.
import { dfaEntry } from "./dfa/entry.js";

/// The canonical one-slot box (03 §3.3/§7.2) for a D `ref`/`out` parameter over a FIELD slot.
interface Ref<T> { value: T; }

/// dmd/semantic3.d:87 — `enum LOG = false;` (a manifest constant, 02 §4.1). Exported because D
/// module-level `enum` without `private` is module-public; the three `static if (LOG)` sites are
/// resolved OFF at translation time (07 §3) and their printf blocks dropped.
export const LOG = false;

/*************************************
 * dmd/semantic3.d:93 — `void semantic3(Dsymbol dsym, Scope* sc)`.
 * Does semantic analysis on function bodies.
 *
 * Preconditions: `dsym` is a fully constructed AST node (its `accept` routes to the matching
 * `visitX` slot, 13 §2). `sc` may be null — `visit(AggregateDeclaration)` explicitly tests it
 * (the `runDeferredSemantic3` TypeInfo-generation entry, semantic3.d:1638).
 * Cost: this is the whole pass-3 body analysis for `dsym`; not cheap, not idempotent-free
 * (`semanticRun` gates re-entry per node kind).
 */
export function semantic3(dsym: Dsymbol, sc: Scope | null): void {
    const v = new Semantic3Visitor(sc); // `scope v = new ...` — the scope storage class is erased (04 §8)
    const k = K.on ? keepMark() : 0;     // the kept-module engine: closes the unit a visitor below opens
    dsym.accept(v);
    if (K.on) keepUnwind(k);
}

/***********************************************************
 * dmd/semantic3.d:99 — `private extern(C++) final class Semantic3Visitor : Visitor`.
 *
 * `final` erased (04 §8); `extern(C++)` erased (04 §8). D module-private, emitted WITHOUT `private`
 * (01-conventions / 10 §1.7): the module's own free functions and the co-located test reach it.
 */
export class Semantic3Visitor extends Visitor {
    // dropped: alias visit = Visitor.visit — no overload hiding in TS (13 §1)

    /// dmd/semantic3.d:103 — `Scope* sc;`. Mutated in place by several visit bodies (the D field IS
    /// the cursor the pass pushes/pops), so every write below is `this.sc = ...`, exactly as in D.
    sc: Scope | null;

    // dmd/semantic3.d:104 — `this(Scope* sc) scope @safe` (attributes erased, 04 §8).
    constructor(sc: Scope | null) {
        super();
        this.sc = sc;
    }

    // dmd/semantic3.d:109 — `override void visit(Dsymbol) {}`. Most symbols have no semantic3 work.
    override visitDsymbol(_s: Dsymbol): void {}

    // dmd/semantic3.d:111 — `override void visit(TemplateInstance tempinst)`.
    override visitTemplateInstance(tempinst: TemplateInstance): void {
        // resolved: static if (LOG) -> OFF (LOG === false) — printf block dropped (semantic3.d:113-116)
        //if (toChars()[0] == 'D') *(char*)0=0;
        if (tempinst.semanticRun >= PASS.semantic3) {
            if (K.on) keepReq(tempinst, KeepUnit.isem3);   // the kept-module engine: a request of a unit that ran
            return;
        }
        if (K.on && keepRun(tempinst, KeepUnit.isem3))     // the kept-module engine: replays a kept unit, or records
            return;
        tempinst.semanticRun = PASS.semantic3;
        if (tempinst._scope !== null && tempinst._scope.deferSemantic3InCompilerHook) {
            tempinst._scope.deferSemantic3InCompilerHook = false;
            // swept (11 §2.5): `templateInstanceSemantic3` is live in templatesem.ts with the D
            // signature — the authorising D line is dmd/templatesem.d:1460.
            templateInstanceSemantic3(tempinst, tempinst._scope, tempinst._scope);
        }

        if (tempinst.errors || tempinst.members === null)
            return;

        const tempdecl: TemplateDeclaration | null = tempinst.tempdecl!.isTemplateDeclaration();
        assert(tempdecl !== null); // semantic3.d:131 — `assert(tempdecl)` (06 §2.7: ref truthiness)

        this.sc = tempdecl!._scope;
        this.sc = this.sc!.push(tempinst.argsym!);
        this.sc = this.sc.push(tempinst);
        this.sc.tinst = tempinst;
        this.sc.minst = tempinst.minst;

        const needGagging = tempinst.gagged && global.gag === 0;
        const olderrors = global.errors;
        const oldGaggedErrors = needGagging ? global.startGagging() : -1;
        /* If this is a gagged instantiation, gag errors.
         * Future optimisation: If the results are actually needed, errors
         * would already be gagged, so we don't really need to run semantic
         * on the members.
         */

        // GAG PAIRING (11 §2.5): the member loop below reaches walls transitively — every
        // `semantic3` of a FuncDeclaration with a `return` runs `checkGC` (semantic3.d:981), which
        // halts inside nogc.ts on its own `walkPostorder` wall (dmd/visitor/postorder.d:20) — and
        // those are exit paths semantic3.d:141-168 does not have; `global.gag` is process-global, so
        // the startGagging/endGagging pair is a try/finally in the port. `endGagging`'s result is
        // discarded by D at this position, so nothing has to be carried out of the finally.
        // (The protection is required for the SHAPE, not for today's wall set — 11 §2.5.)
        try {
            for (let i = 0; i < tempinst.members.length; i++) {
                // `members` slots are `Dsymbol | null` (08 §3); semantic3.d:151 calls through the
                // element with no null test -> `!` at the D fault site (02 §10.1).
                const s = tempinst.members.opIndex(i);
                semantic3(s!, this.sc); // UFCS `s.semantic3(sc)` (04 §6)
                if (tempinst.gagged && global.errors !== olderrors)
                    break;
            }

            if (global.errors !== olderrors) {
                if (!tempinst.errors) {
                    if (!tempdecl!.literal)
                        error(tempinst.loc, ds("%s `%s` error instantiating"),
                            tempinst.kind(), tempinst.toPrettyChars());
                    if (tempinst.tinst !== null)
                        tempinst.tinst.printInstantiationTrace();
                }
                tempinst.errors = true;
            }
        } finally {
            if (needGagging)
                global.endGagging(oldGaggedErrors);
        }

        this.sc = this.sc.pop();
        this.sc!.pop();
    }

    // dmd/semantic3.d:174 — `override void visit(TemplateMixin tmix)`.
    override visitTemplateMixin(tmix: TemplateMixin): void {
        if (tmix.semanticRun >= PASS.semantic3)
            return;
        tmix.semanticRun = PASS.semantic3;
        // resolved: static if (LOG) -> OFF — printf block dropped (semantic3.d:179-182)
        if (tmix.members === null)
            return;

        this.sc = this.sc!.push(tmix.argsym!);
        this.sc = this.sc.push(tmix);

        const olderrors = global.errors;

        for (let i = 0; i < tmix.members.length; i++) {
            const s = tmix.members.opIndex(i);
            semantic3(s!, this.sc); // UFCS (04 §6); slot is `Dsymbol | null` (08 §3)
        }

        if (global.errors !== olderrors)
            errorSupplemental(tmix.loc, ds("parent scope from here: `mixin %s`"), tmix.toChars());

        this.sc = this.sc.pop();
        this.sc!.pop();
    }

    // dmd/semantic3.d:204 — `override void visit(Module mod)`.
    override visitModule(mod: Module): void {
        //printf("Module::semantic3('%s'): parent = %p\n", toChars(), parent);
        if (mod.semanticRun !== PASS.semantic2done) {
            if (K.on) keepReq(mod, KeepUnit.sem3);   // the kept-module engine: a request of a unit that ran
            return;
        }
        // the kept-module engine: replays the kept loop over the parsed members, or records
        const from = K.on ? keepPass(mod, KeepUnit.sem3) : 0;
        mod.semanticRun = PASS.semantic3;
        // Note that modules get their own scope, from scratch.
        // This is so regardless of where in the syntax a module
        // gets imported, it is unaffected by context.
        // NOTE: D declares a LOCAL `Scope* sc` here (semantic3.d:213) that SHADOWS the visitor
        // field; the field is untouched by this method. Reproduced as a local.
        let sc: Scope | null = scopeCreateGlobal(mod, global.errorSink!); // create root scope
        //printf("Module = %p\n", sc.scopesym);
        if (mod.members !== null) {
            // Pass 3 semantic routines: do initializers and function bodies
            for (let i = from; i < mod.members.length; i++) {
                if (K.on) keepMember(mod, i);   // the kept-module engine: the members this compile appended
                // slot `Dsymbol | null` (08 §3); semantic3.d:222 dereferences with no null test
                const s = mod.members.opIndex(i);
                //printf("Module %s: %s.semantic3()\n", toChars(), s.toChars());
                semantic3(s!, sc); // UFCS (04 §6)

                runDeferredSemantic2();
            }
        }
        const uad = mod.userAttribDecl();
        if (uad !== null) {
            semantic3(uad, sc); // UFCS (04 §6)
        }
        sc = sc.pop();
        sc!.pop();
        mod.semanticRun = PASS.semantic3done;
    }

    // dmd/semantic3.d:236 — `override void visit(FuncDeclaration funcdecl)`.
    override visitFuncDeclaration(funcdecl: FuncDeclaration): void {
        //printf("FuncDeclaration::semantic3(%s '%s', sc = %p)\n", funcdecl.kind(), funcdecl.toChars(), sc);
        // dropped: `import dmd.timetrace; import dmd.root.string : toDString;` +
        //          `timeTraceBeginEvent(TimeTraceEventType.sema3);`
        //          `scope (exit) timeTraceEndEvent(TimeTraceEventType.sema3, funcdecl);`
        //          (semantic3.d:239-242) — dmd.timetrace is profiling-only, no semantic effect, no
        //          port; `toDString` was imported solely for the event label. Same disposition as
        //          dmodule.ts:828 / dsymbolsem.ts:4017 / funcsem.ts:454.

        let _arguments: VarDeclaration | null = null;

        if (funcdecl.parent === null) {
            if (global.errors !== 0)
                return;
            //printf("FuncDeclaration::semantic3(%s '%s', sc = %p)\n", kind(), toChars(), sc);
            assertUnreachable(); // semantic3.d:251 — D `assert(0)`
        }
        if (funcdecl.errors || isError(funcdecl.parent)) {
            funcdecl.errors = true;

            // Mark that the return type could not be inferred
            if (funcdecl.inferRetType) {
                assert(funcdecl.type !== null); // semantic3.d:260
                const tf = funcdecl.type!.isTypeFunction();

                // Only change the return type s.t. other analysis is
                // still possible e.g. missmatched parameter types
                if (tf !== null && tf.next === null)
                    tf.next = Type.terror;
            }
            return;
        }

        if (funcdecl.ident === Id.opAssign && funcdecl.inuse === 0) {
            if ((funcdecl.storage_class & STC.inference) !== 0n) {
                /* https://issues.dlang.org/show_bug.cgi?id=15044
                 * For generated opAssign function, any errors
                 * from its body need to be gagged.
                 */
                const oldErrors0 = global.startGagging();
                ++funcdecl.inuse;
                // GAG/INUSE PAIRING (11 §2.5): the recursive `semantic3` reaches walls (an exit path
                // semantic3.d:284-295 does not have). `global.gag` is process-global and
                // `funcdecl.inuse` is the re-entry gate read at semantic3.d:276, so BOTH pairs are a
                // try/finally in the port. `endGagging`'s RESULT is read by D at this position, so it
                // is captured in the finally and tested after.
                let gaggedErrorsHappened = false;
                try {
                    semantic3(funcdecl, this.sc); // UFCS `funcdecl.semantic3(sc)` (04 §6)
                } finally {
                    --funcdecl.inuse;
                    gaggedErrorsHappened = global.endGagging(oldErrors0);
                }
                if (gaggedErrorsHappened) {  // if errors happened
                    // Disable generated opAssign, because some members forbid identity assignment.
                    funcdecl.storage_class = (funcdecl.storage_class | STC.disable) as STC;
                    funcdecl.fbody = null;   // remove fbody which contains the error
                    funcdecl.hasSemantic3Errors = false;
                }
                return;
            }
        }

        //printf(" sc.incontract = %d\n", sc.contract);
        if (funcdecl.semanticRun >= PASS.semantic3) {
            if (K.on) keepReq(funcdecl, KeepUnit.fsem3);   // the kept-module engine: a request of a unit that ran
            return;
        }
        if (K.on && keepRun(funcdecl, KeepUnit.fsem3))     // the kept-module engine: replays a kept unit, or records
            return;
        funcdecl.semanticRun = PASS.semantic3;
        funcdecl.hasSemantic3Errors = false;
        funcdecl.saferD = this.sc!.previews.safer && !this.sc!.inCfile;

        if (funcdecl.type === null || funcdecl.type.ty !== TY.Tfunction)
            return;
        // 02 §11.5c(3) tag-proved RTTI downcast — D `cast(TypeFunction)funcdecl.type`, proved by the
        // `ty != Tfunction` early return immediately above.
        let f: TypeFunction = funcdecl.type.isTypeFunction()!;
        if (!funcdecl.inferRetType && f.next!.ty === TY.Terror)
            return;

        if (funcdecl.fbody === null && funcdecl.inferRetType && f.next === null) {
            error(funcdecl.loc, ds("%s `%s` has no function body with return type inference"),
                funcdecl.kind(), funcdecl.toPrettyChars());
            return;
        }

        const oldErrors = global.errors;
        const fds = new FuncDeclSem3(funcdecl, this.sc); // construction — no copy (03 §1)

        fds.checkInContractOverrides();

        // Remember whether we need to generate an 'out' contract.
        const needEnsure: boolean = needsFensure(funcdecl); // UFCS (04 §6); `immutable` erased

        if (funcdecl.fbody !== null || funcdecl.frequires() !== null || needEnsure) {
            /* Symbol table into which we place parameters and nested functions,
             * solely to diagnose name collisions.
             */
            funcdecl.localsymtab = new DsymbolTable();

            // Establish function scope
            const ss = new ScopeDsymbol(funcdecl.loc, null);
            // find enclosing scope symbol, might skip symbol-less CTFE and/or FuncExp scopes
            ss.parent = this.sc!.inner()!.scopesym;
            ss.endlinnum = funcdecl.endloc.linnum();
            let sc2: Scope = this.sc!.push(ss);
            sc2.func = funcdecl;
            sc2.parent = funcdecl;
            sc2.ctorflow.callSuper = CSX.none;
            sc2.sbreak = null;
            sc2.scontinue = null;
            sc2.switchStatement = null;
            sc2.fes = funcdecl.fes;
            sc2.linkage = funcdecl.isCsymbol() ? LINK.c : LINK.d;
            sc2.stc = (sc2.stc & STC.flowThruFunction) as STC; // branded flag-enum re-cast (02 §4.2)
            sc2.visibility = new Visibility(Visibility.Kind.public_); // fresh construction (03 §1)
            sc2.explicitVisibility = false;
            sc2.aligndecl = null;
            if (funcdecl.ident !== Id.require && funcdecl.ident !== Id.ensure) {
                sc2.copyFlagsFrom(this.sc!);
                sc2.contract = Contract.none;
            }
            sc2.tryFinally = null;
            sc2.scopeGuard = null;
            sc2.inLoop = false;
            sc2.inDefaultArg = false;
            sc2.userAttribDecl = null;
            if (sc2.intypeof === 1)
                sc2.intypeof = 2;
            sc2.ctorflow.fieldinit = []; // D `fieldinit = null` empties the FieldInit value array

            /* Note: When a lambda is defined immediately under aggregate member
             * scope, it should be contextless due to prevent interior pointers.
             * e.g.
             *      // dg points 'this' - its interior pointer
             *      class C { int x; void delegate() dg = (){ this.x = 1; }; }
             *
             * However, lambdas could be used inside typeof, in order to check
             * some expressions validity at compile time. For such case the lambda
             * body can access aggregate instance members.
             * e.g.
             *      class C { int x; static assert(is(typeof({ this.x = 1; }))); }
             *
             * To properly accept it, mark these lambdas as member functions.
             */
            const fld = funcdecl.isFuncLiteralDeclaration(); // 06 §2.6 hoisted decl-in-condition
            if (fld !== null) {
                const ad = funcdecl.isMember2();
                if (ad !== null) {
                    if (this.sc!.intypeof === 0) {
                        if (fld.tok === TOK.delegate_)
                            error(funcdecl.loc, ds("%s `%s` cannot be %s members"),
                                funcdecl.kind(), dsymbolToErrMsg(funcdecl), ad.kind());
                        else
                            fld.tok = TOK.function_;
                    } else {
                        if (fld.tok !== TOK.function_)
                            fld.tok = TOK.delegate_;
                    }
                }
            }

            declareThis(funcdecl, sc2);

            // Reverts: https://issues.dlang.org/show_bug.cgi?id=5710
            // No compiler supports this, and there was never any spec for it.
            // @@@DEPRECATED_2.116@@@
            // Deprecated in 2.096, can be made an error in 2.116.
            // The deprecation period is longer than usual as dual-context
            // functions may be widely used by dmd-compiled projects.
            // It also gives more time for the implementation of dual-context
            // functions to be reworked as a frontend-only feature.
            if (funcdecl.hasDualContext) {
                deprecation(funcdecl.loc,
                    ds("%s `%s` function requires a dual-context, which is deprecated"),
                    funcdecl.kind(), funcdecl.toPrettyChars());
                // 06 §2.6 hoisted decl-in-condition over the ternary D writes inline
                const ti = sc2.parent !== null ? sc2.parent.isInstantiated() : null;
                if (ti !== null)
                    ti.printInstantiationTrace(Classification.deprecation);
            }

            //printf("[%s] ad = %p vthis = %p\n", loc.toChars(), ad, vthis);
            //if (vthis) printf("\tvthis.type = %s\n", vthis.type.toChars());

            // Declare hidden variable _arguments[] and _argptr
            if (f.parameterList.varargs === VarArg.variadic) {
                if (f.linkage === LINK.d) {
                    // Variadic arguments depend on Typeinfo being defined.
                    // probe (02 §11.4): Type.dtypeinfo / Type.typeinfotypelist are declared non-null
                    // but unset until `object` is read; D tests `if (!Type.dtypeinfo)`.
                    const noDtypeinfo = !(Type as { dtypeinfo?: unknown }).dtypeinfo;
                    const noTypeinfotypelist = !(Type as { typeinfotypelist?: unknown }).typeinfotypelist;
                    if (!global.params.useTypeInfo || noDtypeinfo || noTypeinfotypelist) {
                        if (!global.params.useTypeInfo)
                            error(funcdecl.loc,
                                ds("%s `%s` D-style variadic functions cannot be used with `-%s`"),
                                funcdecl.kind(), funcdecl.toPrettyChars(), SwitchVariadic);
                        else if (noTypeinfotypelist)
                            error(funcdecl.loc,
                                ds("%s `%s` `object.TypeInfo_Tuple` could not be found, but is implicitly used in D-style variadic functions"),
                                funcdecl.kind(), funcdecl.toPrettyChars());
                        else
                            error(funcdecl.loc,
                                ds("%s `%s` `object.TypeInfo` could not be found, but is implicitly used in D-style variadic functions"),
                                funcdecl.kind(), funcdecl.toPrettyChars());
                        funcdecl.errors = true;
                    }
                }

                if (!funcdecl.errors && f.linkage === LINK.d) {
                    // Declare _arguments[]
                    funcdecl.v_arguments = new VarDeclaration(funcdecl.loc,
                        Type.typeinfotypelist.type, Id._arguments_typeinfo!, null);
                    funcdecl.v_arguments.storage_class =
                        (funcdecl.v_arguments.storage_class | STC.temp | STC.parameter) as STC;
                    dsymbolSemantic(funcdecl.v_arguments, sc2); // UFCS (04 §6)
                    insert(sc2, funcdecl.v_arguments);
                    funcdecl.v_arguments.parent = funcdecl;

                    //Type t = Type.dtypeinfo.type.constOf().arrayOf();
                    const t = arrayOf(Type.dtypeinfo.type!); // UFCS `.arrayOf()` -> typesem free fn
                    _arguments = new VarDeclaration(funcdecl.loc, t, Id._arguments!, null);
                    _arguments.storage_class = (_arguments.storage_class | STC.temp) as STC;
                    dsymbolSemantic(_arguments, sc2);
                    insert(sc2, _arguments);
                    _arguments.parent = funcdecl;
                }
                if (!funcdecl.errors && (f.linkage === LINK.d || f.parameterList.length() !== 0)) {
                    // Declare _argptr
                    const t = target.va_listType(funcdecl.loc, this.sc);
                    // Init is handled in FuncDeclaration_toObjFile
                    funcdecl.v_argptr = new VarDeclaration(funcdecl.loc, t, Id._argptr!,
                        new VoidInitializer(funcdecl.loc));
                    funcdecl.v_argptr.storage_class = (funcdecl.v_argptr.storage_class | STC.temp) as STC;
                    dsymbolSemantic(funcdecl.v_argptr, sc2);
                    insert(sc2, funcdecl.v_argptr);
                    funcdecl.v_argptr.parent = funcdecl;
                }
            }

            /* Declare all the function parameters as variables
             * and install them in parameters[]
             */
            const nparams = f.parameterList.length(); // 06 §2.6 hoisted decl-in-condition
            if (nparams !== 0) {
                /* parameters[] has all the tuples removed, as the back end
                 * doesn't know about tuples
                 */
                funcdecl.parameters = new DArray<VarDeclaration | null>(); // `new VarDeclarations()`
                funcdecl.parameters.reserve(nparams);
                // 06 §1.8 — D `foreach (i, fparam; f.parameterList)` drives ParameterList.opApply.
                f.parameterList.opApply((i: number, fparam: Parameter): number => {
                    let id: Identifier | null = fparam.ident;
                    let stc: STC = STC.none;
                    if (id === null) {
                        /* Generate identifier for un-named parameter,
                         * because we need it later on.
                         */
                        fparam.ident = id = Identifier.generateIdWithSuffix(ds("__param_"), i);
                        stc = (stc | STC.temp) as STC;
                    }
                    const vtype = fparam.type;
                    const v = new VarDeclaration(fparam.loc!, vtype, id, null);
                    //printf("declaring parameter %s of type %s\n", v.toChars(), v.type.toChars());
                    stc = (stc | STC.parameter) as STC;
                    if (f.parameterList.varargs === VarArg.typesafe && i + 1 === nparams) {
                        stc = (stc | STC.variadic) as STC;
                    }

                    stc = (stc | (fparam.storageClass & (STC.IOR | STC.return_ | STC.scope_
                        | STC.lazy_ | STC.final_ | STC.TYPECTOR | STC.nodtor | STC.returnScope
                        | STC.register))) as STC;
                    v.storage_class = stc;
                    dsymbolSemantic(v, sc2); // UFCS (04 §6)
                    if (insert(sc2, v) === null) {
                        error(funcdecl.loc, ds("%s `%s` parameter `%s.%s` is already defined"),
                            funcdecl.kind(), funcdecl.toPrettyChars(), funcdecl.toChars(), v.toChars());
                        funcdecl.errors = true;
                    } else {
                        funcdecl.parameters!.push(v);
                    }
                    funcdecl.localsymtab!.insert(v);
                    v.parent = funcdecl;
                    if (fparam.userAttribDecl !== null)
                        v.userAttribDecl_set(fparam.userAttribDecl);
                    return 0; // opApply control code: continue (05 §11)
                });
            }

            // Declare the tuple symbols and put them in the symbol table,
            // but not in parameters[].
            if (f.parameterList.parameters !== null)
                for (const fparam of f.parameterList.parameters) {
                    // slot is `Parameter | null` (08 §3); D dereferences with no null test
                    if (fparam!.ident === null)
                        continue; // never used, so ignore
                    // expand any tuples
                    if (fparam!.type!.ty !== TY.Ttuple)
                        continue;

                    // 02 §11.5c(3) tag-proved RTTI downcast — D `cast(TypeTuple)fparam.type`, proved
                    // by the `ty != Ttuple` continue immediately above.
                    const t = fparam!.type!.isTypeTuple()!;
                    const dim = Parameter.dim(t.arguments);
                    const exps: Objects = new DArray<RootObject | null>(dim); // `new Objects(dim)`
                    for (let j = 0; j < dim; j++) {
                        const narg = Parameter.getNth(t.arguments, j);
                        assert(narg!.ident !== null); // semantic3.d:531
                        const pscopesym: Ref<Dsymbol | null> = { value: null }; // `out Dsymbol` box (03 §3.3)
                        const v = searchScope(sc2, Loc.initial, narg!.ident!, pscopesym)!.isVarDeclaration();
                        assert(v !== null); // semantic3.d:534
                        exps.opIndexAssign(new VarExp(v!.loc, v!), j);
                    }
                    assert(fparam!.ident !== null); // semantic3.d:537
                    const v = new TupleDeclaration(funcdecl.loc, fparam!.ident!, exps);
                    //printf("declaring tuple %s\n", v.toChars());
                    v.isexp = true;
                    if (insert(sc2, v) === null)
                        error(funcdecl.loc, ds("%s `%s` parameter `%s.%s` is already defined"),
                            funcdecl.kind(), funcdecl.toPrettyChars(), funcdecl.toChars(), v.toChars());
                    funcdecl.localsymtab!.insert(v);
                    v.parent = funcdecl;
                }

            // Precondition invariant
            let fpreinv: Statement | null = null;
            if (addPreInvariant(funcdecl)) { // UFCS (04 §6) -> funcsem.d:112
                const e = addInvariant(funcdecl.isThis()!, funcdecl.vthis!); // 06 §2.6 hoist
                if (e !== null)
                    fpreinv = new ExpStatement(Loc.initial, e);
            }

            // Postcondition invariant
            let fpostinv: Statement | null = null;
            if (addPostInvariant(funcdecl)) { // UFCS (04 §6) -> funcsem.d:70
                const e = addInvariant(funcdecl.isThis()!, funcdecl.vthis!);
                if (e !== null)
                    fpostinv = new ExpStatement(Loc.initial, e);
            }

            // Pre/Postcondition contract
            if (funcdecl.fbody === null)
                buildEnsureRequire(funcdecl); // UFCS (04 §6)

            let scout: Scope | null = null;
            if (needEnsure || addPostInvariant(funcdecl)) {
                /* https://issues.dlang.org/show_bug.cgi?id=3657
                 * Set the correct end line number for fensure scope.
                 */
                let fensure_endlin = funcdecl.endloc.linnum();
                if (funcdecl.fensure() !== null) {
                    const s = funcdecl.fensure()!.isScopeStatement(); // 06 §2.6 hoist
                    if (s !== null)
                        fensure_endlin = s.endloc.linnum();
                }

                if ((needEnsure && global.params.useOut === CHECKENABLE.on) || fpostinv !== null) {
                    funcdecl.returnLabel = funcdecl.searchLabel(Id.returnLabel!, Loc.initial);
                }

                // scope of out contract (need for vresult.semantic)
                const sym = new ScopeDsymbol(funcdecl.loc, null);
                sym.parent = sc2.scopesym;
                sym.endlinnum = fensure_endlin;
                scout = sc2.push(sym);
            }

            if (funcdecl.fbody !== null) {
                const sym = new ScopeDsymbol(funcdecl.loc, null);
                sym.parent = sc2.scopesym;
                sym.endlinnum = funcdecl.endloc.linnum();
                sc2 = sc2.push(sym);

                const ad2 = funcdecl.isMemberLocal();

                /* If this is a class constructor
                 */
                if (ad2 !== null && funcdecl.isCtorDeclaration() !== null) {
                    sc2.ctorflow.allocFieldinit(ad2.fields.length);
                    for (const v of ad2.fields) {
                        v!.ctorinit = false; // D `v.ctorinit = 0` — the port's slot is a bool bitfield
                    }
                }

                const inferRef = f.isRef && (funcdecl.storage_class & STC.auto_) !== 0n;

                funcdecl.fbody = statementSemantic(funcdecl.fbody, sc2); // UFCS (04 §6)
                if (funcdecl.fbody === null)
                    funcdecl.fbody = new CompoundStatement(Loc.initial, new DArray<Statement | null>());

                if (funcdecl.isNaked) {
                    fpreinv = null;         // can't accommodate with no stack frame
                    fpostinv = null;
                }

                assert(funcdecl.type === f
                    || (funcdecl.type!.ty === TY.Tfunction && f.purity === PURE.impure
                        && funcdecl.type!.isTypeFunction()!.purity >= PURE.fwdref)); // semantic3.d:622
                f = funcdecl.type!.isTypeFunction()!; // D `cast(TypeFunction)funcdecl.type` (tag-proved)

                if (funcdecl.inferRetType) {
                    // If no return type inferred yet, then infer a void
                    if (f.next === null)
                        f.next = Type.tvoid;
                    if (checkRetType(f, funcdecl.loc)) // UFCS (04 §6)
                        funcdecl.fbody = new ErrorStatement();
                    else
                        checkMain(funcdecl); // Check main() parameters and return type
                }

                if (f.next !== null)
                    checkComplexTransition(f.next, funcdecl.loc, this.sc!); // UFCS (04 §6)

                if (funcdecl.returns !== null && funcdecl.fbody.isErrorStatement() === null) {
                    for (let i = 0; i < funcdecl.returns.length; ) {
                        // slot `ReturnStatement | null` (08 §3); D dereferences with no null test
                        let exp: Expression = funcdecl.returns.opIndex(i)!.exp!;
                        if (exp.op === EXP.variable && exp.isVarExp()!.var_ === funcdecl.vresult) {
                            if (fds.addReturn0())
                                exp.type = Type.tint32;
                            else
                                exp.type = f.next;
                            // Remove `return vresult;` from returns
                            funcdecl.returns.remove(i);
                            continue;
                        }
                        // https://issues.dlang.org/show_bug.cgi?id=13336
                        if (inferRef && f.isRef && constConv(exp.type!, f.next!) === MATCH.nomatch)
                            f.isRef = false;
                        i++;
                    }
                }
                if (f.isRef) { // Function returns a reference
                    if ((funcdecl.storage_class & STC.auto_) !== 0n)
                        funcdecl.storage_class = (funcdecl.storage_class & ~STC.auto_) as STC;
                }

                // handle NRVO
                if (!target.isReturnOnStack(f, funcdecl.needThis()) || !checkNRVO(funcdecl))
                    funcdecl.isNRVO = false;

                if (funcdecl.fbody.isErrorStatement() !== null) {
                } else if (funcdecl.isStaticCtorDeclaration() !== null) {
                    /* It's a static constructor. Ensure that all
                     * ctor consts were initialized.
                     */
                    const pd = funcdecl.toParent()!.isScopeDsymbol();
                    for (let i = 0; i < pd!.members!.length; i++) {
                        const s = pd!.members!.opIndex(i); // slot `Dsymbol | null` (08 §3)
                        checkCtorConstInit(s!); // UFCS (04 §6)
                    }
                } else if (ad2 !== null && funcdecl.isCtorDeclaration() !== null) {
                    const cd = ad2.isClassDeclaration();

                    // Verify that all the ctorinit fields got initialized
                    if ((sc2.ctorflow.callSuper & CSX.this_ctor) === 0) {
                        for (const [i, v] of ad2.fields.opSlice().entries()) {
                            if (v!.isThisDeclaration() !== null)
                                continue;
                            if (!v!.ctorinit) {
                                /* Current bugs in the flow analysis:
                                 * 1. union members should not produce error messages even if
                                 *    not assigned to
                                 * 2. structs should recognize delegating opAssign calls as well
                                 *    as delegating calls to other constructors
                                 */
                                if (v!.isCtorinit() && !v!.type!.isMutable() && cd !== null)
                                    error(funcdecl.loc, ds("%s `%s` missing initializer for %s field `%s`"),
                                        funcdecl.kind(), funcdecl.toPrettyChars(),
                                        MODtoChars(v!.type!.mod), v!.toChars());
                                else if ((v!.storage_class & STC.nodefaultctor) !== 0n)
                                    error(funcdecl.loc, ds("field `%s` must be initialized in constructor"),
                                        v!.toChars());
                                else if (needsNested(v!.type!))
                                    error(funcdecl.loc,
                                        ds("field `%s` must be initialized in constructor, because it is nested struct"),
                                        v!.toChars());
                            } else {
                                const mustInit = ((v!.storage_class & STC.nodefaultctor) !== 0n
                                    || needsNested(v!.type!));
                                if (mustInit && (sc2.ctorflow.fieldinit[i].csx & CSX.this_ctor) === 0) {
                                    error(funcdecl.loc, ds("%s `%s` field `%s` must be initialized but skipped"),
                                        funcdecl.kind(), funcdecl.toPrettyChars(), v!.toChars());
                                }
                            }
                        }
                    }
                    sc2.ctorflow.freeFieldinit();

                    if (cd !== null && (sc2.ctorflow.callSuper & (CSX.any_ctor | CSX.halt)) === 0
                        && cd.baseClass !== null && cd.baseClass.ctor !== null) {
                        sc2.ctorflow.callSuper = CSX.none;

                        // Insert implicit super() at start of fbody
                        const tthis = addMod(ad2.type!, funcdecl.vthis!.type!.mod); // UFCS (04 §6)
                        const fd = resolveFuncCall(Loc.initial, sc2, cd.baseClass.ctor, null, tthis,
                            new ArgumentList(), FuncResolveFlag.quiet);
                        if (fd === null) {
                            error(funcdecl.loc, ds("%s `%s` no match for implicit `super()` call in constructor"),
                                funcdecl.kind(), funcdecl.toPrettyChars());
                        } else if ((fd.storage_class & STC.disable) !== 0n) {
                            error(funcdecl.loc,
                                ds("%s `%s` cannot call `super()` implicitly because it is annotated with `@disable`"),
                                funcdecl.kind(), funcdecl.toPrettyChars());
                        } else {
                            const e1: Expression = new SuperExp(Loc.initial);
                            let e: Expression = new CallExp(Loc.initial, e1);
                            e = expressionSemantic(e, sc2); // UFCS (04 §6)
                            const s: Statement = new ExpStatement(Loc.initial, e);
                            funcdecl.fbody = CompoundStatement.fromStatementList(Loc.initial, s, funcdecl.fbody);
                        }
                    }
                    //printf("ctorflow.callSuper = x%x\n", sc2.ctorflow.callSuper);
                }

                /* https://issues.dlang.org/show_bug.cgi?id=17502
                 * Wait until after the return type has been inferred before
                 * generating the contracts for this function, and merging contracts
                 * from overrides.
                 *
                 * https://issues.dlang.org/show_bug.cgi?id=17893
                 * However should take care to generate this before inferered
                 * function attributes are applied, such as 'nothrow'.
                 *
                 * This was originally at the end of the first semantic pass, but
                 * required a fix-up to be done here for the '__result' variable
                 * type of __ensure() inside auto functions, but this didn't work
                 * if the out parameter was implicit.
                 */
                buildEnsureRequire(funcdecl); // UFCS (04 §6)

                // Check for errors related to 'nothrow'.
                const blockexit0 = blockExit(funcdecl.fbody, funcdecl,
                    f.isNothrow ? global.errorSink : null); // UFCS (04 §6)
                if (f.isNothrow && (blockexit0 & BE.throw_) !== 0)
                    error(funcdecl.loc, ds("%s `%s` may throw but is marked as `nothrow`"),
                        funcdecl.kind(), funcdecl.toPrettyChars());

                if (!(((blockexit0 & (BE.throw_ | BE.halt)) !== 0) || funcdecl.hasCatches)) {
                    /* Don't generate unwind tables for this function
                     * https://issues.dlang.org/show_bug.cgi?id=17997
                     */
                    funcdecl.hasNoEH = true;
                }

                if (funcdecl.nothrowInprocess) {
                    if (funcdecl.type === f)
                        // D `cast(TypeFunction)f.copy()`: the copy of a TypeFunction IS one — 02 §11.5c(3)
                        f = f.copy().isTypeFunction()!;
                    f.isNothrow = (blockexit0 & BE.throw_) === 0;
                }

                if (funcdecl.fbody.isErrorStatement() !== null) {
                } else if (ad2 !== null && funcdecl.isCtorDeclaration() !== null) {
                    /* Append:
                     *  return this;
                     * to function body
                     */
                    if ((blockexit0 & BE.fallthru) !== 0) {
                        let s: Statement | null = new ReturnStatement(funcdecl.loc, null);
                        s = statementSemantic(s, sc2); // UFCS (04 §6)
                        funcdecl.fbody = CompoundStatement.fromStatementList(funcdecl.loc, funcdecl.fbody, s);
                        funcdecl.hasMultipleReturnExp = funcdecl.hasReturnExp;
                        funcdecl.hasReturnExp = true;
                    }
                } else if (funcdecl.fes !== null) {
                    // For foreach(){} body, append a return 0;
                    if ((blockexit0 & BE.fallthru) !== 0) {
                        const e: Expression = IntegerExp.literal(0);
                        const s: Statement = new ReturnStatement(Loc.initial, e);
                        funcdecl.fbody = CompoundStatement.fromStatementList(Loc.initial, funcdecl.fbody, s);
                        funcdecl.hasMultipleReturnExp = funcdecl.hasReturnExp;
                        funcdecl.hasReturnExp = true;
                    }
                    assert(funcdecl.returnLabel === null); // semantic3.d:814 (06 §2.7)
                } else if (toBasetype(f.next!).ty === TY.Tnoreturn) {
                    // Fallthrough despite being declared as noreturn? return is already rejected when evaluating the ReturnStatement
                    if ((blockexit0 & BE.fallthru) !== 0) {
                        error(funcdecl.loc, ds("%s `%s` is typed as `%s` but does return"),
                            funcdecl.kind(), funcdecl.toPrettyChars(), f.next!.toChars());
                        errorSupplemental(funcdecl.loc,
                            ds("`noreturn` functions must either throw, abort or loop indefinitely"));
                    }
                } else {
                    if ((blockexit0 & BE.fallthru) !== 0 && f.next!.ty !== TY.Tvoid
                        && !funcdecl.hasInlineAsm && !this.sc!.inCfile) {
                        if (!funcdecl.hasReturnExp)
                            error(funcdecl.loc,
                                ds("%s `%s` has no `return` statement, but is expected to return a value of type `%s`"),
                                funcdecl.kind(), funcdecl.toPrettyChars(), f.next!.toChars());
                        else
                            error(funcdecl.loc,
                                ds("%s `%s` no `return exp;` or `assert(0);` at end of function"),
                                funcdecl.kind(), funcdecl.toPrettyChars());
                    }
                }

                if (funcdecl.returns !== null) {
                    const implicit0 = fds.addReturn0();
                    const tret: Type = implicit0 ? Type.tint32 : f.next!;
                    assert(tret.ty !== TY.Tvoid); // semantic3.d:840
                    if (funcdecl.vresult !== null || funcdecl.returnLabel !== null)
                        buildResultVar(funcdecl, scout !== null ? scout : sc2, tret); // UFCS (04 §6)

                    /* Cannot move this loop into NrvoWalker, because
                     * returns[i] may be in the nested delegate for foreach-body.
                     */
                    for (let i = 0; i < funcdecl.returns.length; i++) {
                        const rs = funcdecl.returns.opIndex(i)!; // slot nullable (08 §3)
                        let exp: Expression = rs.exp!;
                        if (exp.op === EXP.error)
                            continue;
                        if (tret.ty === TY.Terror) {
                            // https://issues.dlang.org/show_bug.cgi?id=13702
                            // swept (11 §2.5): `checkGC` is live in nogc.ts with the D signature —
                            // the authorising D line is dmd/nogc.d:268. D calls it by UFCS (04 §6).
                            exp = checkGC(exp, sc2);
                            continue;
                        }

                        /* If the expression in the return statement (exp) cannot be implicitly
                         * converted to the return type (tret) of the function and if the
                         * type of the expression is type isolated, then it may be possible
                         * that a promotion to `immutable` or `inout` (through a cast) will
                         * match the return type.
                         */
                        if (implicitConvTo(exp, tret) === MATCH.nomatch
                            && isTypeIsolated(funcdecl, exp.type!)) { // UFCS (04 §6)
                            /* https://issues.dlang.org/show_bug.cgi?id=20073
                             *
                             * The problem is that if the type of the returned expression (exp.type)
                             * is an aggregated declaration with an alias this, the alias this may be
                             * used for the conversion testing without it being an isolated type.
                             *
                             * To make sure this does not happen, we can test here the implicit conversion
                             * only for the aggregated declaration type by using `implicitConvToWithoutAliasThis`.
                             * The implicit conversion with alias this is taken care of later.
                             */
                            const aggDecl = isAggregate(exp.type!);
                            let tstruct: Type | null = null;
                            let tclass: Type | null = null;
                            let hasAliasThis = false;
                            if (aggDecl !== null && aggDecl.aliasthis !== null) {
                                hasAliasThis = true;
                                tclass = exp.type!.isTypeClass();
                                if (tclass === null)
                                    tstruct = exp.type!.isTypeStruct();
                                assert(tclass !== null || tstruct !== null); // semantic3.d:888
                            }
                            if (hasAliasThis) {
                                // D's `implicitConvToWithoutAliasThis` is a pair of same-arity free
                                // functions in typesem.d (:9225 TypeStruct, :9272 TypeClass), ported
                                // under the §9-D5 Form-B receiver-type rename (04 §1B). D's
                                // `cast(TypeClass)`/`cast(TypeStruct)` downcast becomes `isTypeXxx()`
                                // (05 §10); the `!` is the D fault site (02 §10.1). The MATCH result is
                                // used as a D truthiness test -> `!== MATCH.nomatch` (09 §9).
                                if (tclass !== null) {
                                    if (implicitConvToWithoutAliasThisClass(
                                            immutableOf(exp.type!).isTypeClass()!, tret) !== MATCH.nomatch)
                                        exp = castTo(exp, sc2, immutableOf(exp.type!));
                                    else if (implicitConvToWithoutAliasThisClass(
                                            wildOf(exp.type!).isTypeClass()!, tret) !== MATCH.nomatch)
                                        exp = castTo(exp, sc2, wildOf(exp.type!));
                                } else {
                                    if (implicitConvToWithoutAliasThisStruct(
                                            immutableOf(exp.type!).isTypeStruct()!, tret) !== MATCH.nomatch)
                                        exp = castTo(exp, sc2, immutableOf(exp.type!));
                                    // semantic3.d:903 probes `immutableOf()` AGAIN (not `wildOf()`)
                                    // while casting to `wildOf()` — an upstream copy-paste defect.
                                    // Reproduced verbatim: the port never silently repairs D.
                                    else if (implicitConvToWithoutAliasThisStruct(
                                            immutableOf(exp.type!).isTypeStruct()!, tret) !== MATCH.nomatch)
                                        exp = castTo(exp, sc2, wildOf(exp.type!));
                                }
                            } else {
                                if (implicitConvToType(immutableOf(exp.type!), tret) !== MATCH.nomatch)
                                    exp = castTo(exp, sc2, immutableOf(exp.type!));
                                else if (implicitConvToType(wildOf(exp.type!), tret) !== MATCH.nomatch)
                                    exp = castTo(exp, sc2, wildOf(exp.type!));
                            }
                        }

                        // Function returns a reference
                        if (f.isRef) {
                            if (!MODimplicitConv(exp.type!.mod, tret.mod) && tret.isTypeSArray() === null)
                                error(exp.loc,
                                    ds("expression `%s` of type `%s` is not implicitly convertible to return type `ref %s`"),
                                    exp.toChars(), exp.type!.toChars(), tret.toChars());
                            else
                                exp = implicitCastTo(exp, sc2, tret); // UFCS (04 §6)

                            exp = toLvalue(exp, sc2, ds("`ref` return")); // UFCS (04 §6)
                            checkAddressable(exp, sc2, ds("`ref` return"));
                            checkReturnEscapeRef(sc2, exp, false); // semantic3.d:927 (D `*sc2`: 03 §3.2)
                            exp = optimize(exp, WANTvalue, /*keepLvalue*/ true); // UFCS (04 §6)
                        } else {
                            // if a copy constructor is present, the return type conversion will be handled by it
                            const hasCopyCtor = exp.type!.ty === TY.Tstruct
                                && exp.type!.isTypeStruct()!.sym!.hasCopyCtor;
                            if (!hasCopyCtor || !isLvalue(exp)) { // UFCS (04 §6)
                                const errors = global.startGagging();
                                // GAG PAIRING (11 §2.5): `implicitCastTo` reaches the alias-this wall
                                // at dcast.ts:307 — an exit path semantic3.d:936-938 does not have —
                                // and `global.gag` is process-global. `endGagging`'s result is
                                // discarded by D here, so nothing leaves the finally.
                                let implicitlyCastedExp: Expression;
                                try {
                                    implicitlyCastedExp = implicitCastTo(exp, sc2, tret);
                                } finally {
                                    global.endGagging(errors);
                                }

                                // <https://github.com/dlang/dmd/issues/20888>
                                if (implicitlyCastedExp.isErrorExp() !== null) {
                                    const types = toAutoQualChars(exp.type!, tret);
                                    error(
                                        exp.loc,
                                        ds("return value `%s` of type `%s` does not match return type `%s`"
                                            + ", and cannot be implicitly converted"),
                                        toErrMsg(exp),
                                        types[0],
                                        types[1],
                                    );

                                    const func = exp.type!.isFunction_Delegate_PtrToFunction(); // 06 §2.6 hoist
                                    if (func !== null)
                                        if (func.next!.equals(tret))
                                            errorSupplemental(
                                                exp.loc,
                                                ds("Did you intend to call the %s?"),
                                                (exp.type!.isPtrToFunction() !== null)
                                                    ? ds("function pointer")
                                                    : exp.type!.kind(),
                                            );
                                }

                                exp = implicitlyCastedExp;
                            }

                            exp = optimize(exp, WANTvalue);

                            /* https://issues.dlang.org/show_bug.cgi?id=10789
                             * If NRVO is not possible, all returned lvalues should call their postblits.
                             * For functions with a __result variable, postblits will be called later
                             * during initialization of __result.
                             */
                            if (!funcdecl.isNRVO && funcdecl.vresult === null)
                                exp = doCopyOrMove(sc2, exp, f.next, true, true);

                            if (hasPointers(tret)) { // UFCS (04 §6)
                                checkReturnEscape(sc2, exp, false); // semantic3.d:978 (D `*sc2`: 03 §3.2)
                            }
                        }

                        // swept (11 §2.5): `checkGC` is live in nogc.ts with the D signature — the
                        // authorising D line is dmd/nogc.d:268. D calls it by UFCS (04 §6). Note that
                        // nogc.ts carries its OWN wall on `walkPostorder` (dmd/visitor/postorder.d:20)
                        // inside `checkGC`, so this UNIVERSAL return path still halts for every
                        // expression that survives the nogc.d:271 early-outs — the wall moved into its
                        // owner file, it did not disappear.
                        exp = checkGC(exp, sc2);

                        if (funcdecl.vresult !== null) {
                            let scret: Scope = sc2;

                            if (rs.fesFunc !== null) {
                                // Create a scope with foreach body being `.parent`
                                // and `funcdecl` as `.func`. So the return value
                                // is aware of closure access, but picks up
                                // attributes and instantiates templated copy/move
                                // ctors in the context of `funcdecl`.
                                // BUG: remove this fragile hack
                                scret = rs.fesFunc._scope!.push();
                                scret.parent = rs.fesFunc;
                                scret.func = funcdecl;
                            }

                            // Create: return (vresult = exp, vresult);
                            exp = ConstructExp.fromVar(rs.loc, funcdecl.vresult, exp); // D `this(Loc, VarDeclaration, Expression)` (04 §1.1c)
                            exp = expressionSemantic(exp, scret);
                            exp = Expression.combine(exp,
                                new VarExp(rs.loc, funcdecl.vresult))!;

                            if (rs.caseDim !== 0)
                                exp = Expression.combine(exp, IntegerExp.fromValue(BigInt(rs.caseDim)))!;
                        } else if (funcdecl.tintro !== null && !tret.equals(nextOf(funcdecl.tintro)!)) {
                            exp = implicitCastTo(exp, sc2, nextOf(funcdecl.tintro)!);
                        }
                        rs.exp = exp;
                    }
                }
                if (funcdecl.nrvo_var !== null || funcdecl.returnLabel !== null) {
                    const nw = new NrvoWalker(); // `scope NrvoWalker nw = ...` — scope erased (04 §8)
                    nw.fd = funcdecl;
                    nw.sc = sc2;
                    // semantic3.d:1020 `nw.visitStmt(funcdecl.fbody)`: D's `ref Statement` is the slot pair.
                    nw.visitStmt({ get: () => funcdecl.fbody, set: (v) => { funcdecl.fbody = v; } });
                }

                sc2 = sc2.pop()!;
            }

            if (this.sc!.previews.inclusiveInContracts) {
                funcdecl.setFrequire(mergeFrequireInclusivePreview(funcdecl,
                    funcdecl.frequire(), funcdecl.fdrequireParams())); // UFCS (04 §6)
            } else {
                funcdecl.setFrequire(mergeFrequire(funcdecl, funcdecl.frequire(),
                    funcdecl.fdrequireParams()));
            }
            funcdecl.setFensure(mergeFensure(funcdecl, funcdecl.fensure(), Id.result!,
                funcdecl.fdensureParams()));

            let freq: Statement | null = funcdecl.frequire();
            let fens: Statement | null = funcdecl.fensure();

            /* Do the semantic analysis on the [in] preconditions and
             * [out] postconditions.
             */
            const isNothrow: boolean = f.isNothrow && !funcdecl.nothrowInprocess; // `immutable` erased
            if (freq !== null) {
                /* frequire is composed of the [in] contracts
                 */
                const sym = new ScopeDsymbol(funcdecl.loc, null);
                sym.parent = sc2.scopesym;
                sym.endlinnum = funcdecl.endloc.linnum();
                sc2 = sc2.push(sym);
                sc2.contract = Contract.require;

                // BUG: need to error if accessing out parameters
                // BUG: need to disallow returns
                // BUG: verify that all in and ref parameters are read
                freq = statementSemantic(freq, sc2); // UFCS (04 §6)

                const blockExitBits = blockExit(freq, funcdecl, null); // UFCS (04 §6)
                if ((blockExitBits & BE.throw_) !== 0) {
                    if (isNothrow)
                        error(funcdecl.loc,
                            ds("`%s`: `in` contract may throw but function is marked as `nothrow`"),
                            funcdecl.toPrettyChars());
                    else if (funcdecl.nothrowInprocess)
                        f.isNothrow = false;
                }

                funcdecl.hasNoEH = false;

                sc2 = sc2.pop()!;

                if (global.params.useIn === CHECKENABLE.off)
                    freq = null;
            }

            if (fens !== null) {
                /* fensure is composed of the [out] contracts
                 */
                if (f.next!.ty === TY.Tvoid && funcdecl.fensures() !== null) {
                    for (const e of funcdecl.fensures()!) {
                        if (e!.id !== null) {
                            error(e!.ensure!.loc, ds("%s `%s` `void` functions have no result"),
                                funcdecl.kind(), funcdecl.toPrettyChars());
                            //fens = null;
                        }
                    }
                }

                sc2 = scout!; //push
                sc2.contract = Contract.ensure;

                // BUG: need to disallow returns and throws

                if (funcdecl.fensure() !== null && f.next!.ty !== TY.Tvoid)
                    buildResultVar(funcdecl, scout, f.next!); // UFCS (04 §6)

                fens = statementSemantic(fens, sc2); // UFCS (04 §6)

                const blockExitBits = blockExit(fens, funcdecl, null);
                if ((blockExitBits & BE.throw_) !== 0) {
                    if (isNothrow)
                        error(funcdecl.loc,
                            ds("`%s`: `out` contract may throw but function is marked as `nothrow`"),
                            funcdecl.toPrettyChars());
                    else if (funcdecl.nothrowInprocess)
                        f.isNothrow = false;
                }

                funcdecl.hasNoEH = false;

                sc2 = sc2.pop()!;

                if (global.params.useOut === CHECKENABLE.off)
                    fens = null;
            }
            if (funcdecl.fbody !== null && funcdecl.fbody.isErrorStatement() !== null) {
            } else {
                const a: Statements = new DArray<Statement | null>(); // `new Statements()`

                const expectedSize = (funcdecl.parameters !== null ? funcdecl.parameters.length : 0) + 7;
                a.reserve(expectedSize);

                // Merge in initialization of 'out' parameters
                if (funcdecl.parameters !== null) {
                    for (let i = 0; i < funcdecl.parameters.length; i++) {
                        const v = funcdecl.parameters.opIndex(i)!; // slot nullable (08 §3)
                        if ((v.storage_class & STC.out_) !== 0n) {
                            if (v._init === null) {
                                error(v.loc, ds("%s `%s` zero-length `out` parameters are not allowed."),
                                    v.kind(), v.toPrettyChars());
                                return;
                            }
                            const ie = v._init.isExpInitializer();
                            assert(ie !== null); // semantic3.d:1144
                            const iec = ie!.exp!.isConstructExp(); // 06 §2.6 hoist
                            if (iec !== null) {
                                // construction occurred in parameter processing
                                const ec = new AssignExp(iec.loc, iec.e1!, iec.e2!);
                                ec.type = iec.type;
                                ie!.exp = ec;
                            }
                            a.push(new ExpStatement(Loc.initial, ie!.exp));
                        }
                    }
                }

                // resolved: `static if (!IN_LLVM)` (semantic3.d:1158) -> OFF (_config §1: IN_LLVM is
                // ON), so the `_arguments = v_arguments.elements` lowering at semantic3.d:1160-1173
                // is DROPPED — "we'll handle variadics ourselves" (the D comment at :1157). `_arguments`
                // therefore stays write-only in this port, exactly as under LDC.
                void _arguments;

                // Merge contracts together with body into one compound statement

                if (freq !== null || fpreinv !== null) {
                    if (freq === null)
                        freq = fpreinv;
                    else if (fpreinv !== null)
                        freq = CompoundStatement.fromStatementList(Loc.initial, freq, fpreinv);

                    a.push(freq);
                }

                if (funcdecl.fbody !== null)
                    a.push(funcdecl.fbody);

                if (fens !== null || fpostinv !== null) {
                    if (fens === null)
                        fens = fpostinv;
                    else if (fpostinv !== null)
                        fens = CompoundStatement.fromStatementList(Loc.initial, fpostinv, fens);

                    const ls = new LabelStatement(Loc.initial, Id.returnLabel!, fens);
                    funcdecl.returnLabel!.statement = ls;
                    a.push(funcdecl.returnLabel!.statement);

                    if (f.next!.ty !== TY.Tvoid && funcdecl.vresult !== null) {
                        // resolved: `version (IN_LLVM)` (semantic3.d:1204) -> ON (_config §1); the
                        // `else` arm (:1220-1223, the plain `return vresult;`) is dropped.
                        let e: Expression | null = null;
                        if (funcdecl.isCtorDeclaration() !== null) {
                            const te = new ThisExp(Loc.initial);
                            te.type = funcdecl.vthis!.type;
                            te.var_ = funcdecl.vthis;
                            e = te;
                        } else {
                            e = new VarExp(Loc.initial, funcdecl.vresult);
                        }
                        if (funcdecl.tintro !== null) {
                            e = implicitCastTo(e, this.sc!, nextOf(funcdecl.tintro)!);
                            e = expressionSemantic(e, this.sc!);
                        }
                        const s = new ReturnStatement(Loc.initial, e);
                        a.push(s);
                    }
                }
                if (fds.addReturn0()) {
                    // Add a return 0; statement
                    const s: Statement = new ReturnStatement(Loc.initial, IntegerExp.literal(0));
                    a.push(s);
                }

                let sbody: Statement = new CompoundStatement(Loc.initial, a);

                /* Append destructor calls for parameters as finally blocks.
                 */
                if (funcdecl.parameters !== null) {
                    // check if callee destroys arguments
                    const paramsNeedDtor: boolean = target.isCalleeDestroyingArgs(f);

                    for (const v of funcdecl.parameters) {
                        if (v!.isReference() || (v!.storage_class & STC.lazy_) !== 0n)
                            continue;
                        if (!v!.needsScopeDtor())
                            continue;
                        v!.storage_class = (v!.storage_class | STC.nodtor) as STC;
                        if (!paramsNeedDtor)
                            continue;

                        // same with ExpStatement.scopeCode()
                        let s: Statement | null = new DtorExpStatement(Loc.initial, v!.edtor, v!);

                        s = statementSemantic(s, sc2); // UFCS (04 §6)

                        const blockexit1 = blockExit(s, funcdecl, isNothrow ? global.errorSink : null);
                        if ((blockexit1 & BE.throw_) !== 0) {
                            funcdecl.hasNoEH = false;
                            if (isNothrow)
                                error(funcdecl.loc, ds("%s `%s` may throw but is marked as `nothrow`"),
                                    funcdecl.kind(), funcdecl.toPrettyChars());
                            else if (funcdecl.nothrowInprocess)
                                f.isNothrow = false;
                        }

                        if (blockExit(sbody, funcdecl, f.isNothrow ? global.errorSink : null) === BE.fallthru)
                            sbody = CompoundStatement.fromStatementList(Loc.initial, sbody, s);
                        else
                            sbody = new TryFinallyStatement(Loc.initial, sbody, s);
                    }
                }
                // from this point on all possible 'throwers' are checked
                funcdecl.nothrowInprocess = false;

                if (funcdecl.isSynchronized()) {
                    /* Wrap the entire function body in a synchronized statement
                     */
                    const cd = funcdecl.toParentDecl()!.isClassDeclaration(); // 06 §2.6 hoist
                    if (cd !== null) {
                        if (target.libraryObjectMonitors(funcdecl, sbody)) {
                            let vsync: Expression;
                            if (funcdecl.isStatic()) {
                                // The monitor is in the ClassInfo
                                vsync = new DotIdExp(funcdecl.loc,
                                    symbolToExp(cd, funcdecl.loc, sc2, false),
                                    Id.classinfo!);
                            } else {
                                // 'this' is the monitor
                                vsync = new VarExp(funcdecl.loc, funcdecl.vthis!);
                                if (funcdecl.hasDualContext) {
                                    vsync = new PtrExp(funcdecl.loc, vsync);
                                    vsync = new IndexExp(funcdecl.loc, vsync, IntegerExp.literal(0));
                                }
                            }
                            sbody = new PeelStatement(sbody); // don't redo semantic()
                            sbody = new SynchronizedStatement(funcdecl.loc, vsync, sbody);
                            sbody = statementSemantic(sbody, sc2)!;
                        }
                    } else {
                        error(funcdecl.loc,
                            ds("%s `%s` synchronized function `%s` must be a member of a class"),
                            funcdecl.kind(), funcdecl.toPrettyChars(), funcdecl.toChars());
                    }
                }

                // If declaration has no body, don't set sbody to prevent incorrect codegen.
                if (funcdecl.fbody !== null || allowsContractWithoutBody(funcdecl))
                    funcdecl.fbody = sbody;
            }

            // Check for undefined labels
            if (funcdecl.labtab !== null)
                for (const keyValue of funcdecl.labtab.tab.asRange()) {
                    //printf("  KV: %s = %s\n", keyValue.key.toChars(), keyValue.value.toChars());
                    // 02 §11.5c(3) tag-proved RTTI downcast — D `cast(LabelDsymbol)keyValue.value`;
                    // the DSYM tag compare adjacent IS the proof. D would fault on a non-label entry,
                    // so the `!` below marks exactly D's fault site (02 §10.1).
                    const kv1 = keyValue[1];
                    const label = kv1.dsym === DSYM.labelDsymbol ? (kv1 as unknown as LabelDsymbol) : null;
                    if (label!.statement === null && (!label!.deleted || label!.iasm)) {
                        error(label!.loc, ds("%s `%s` label `%s` is undefined"),
                            funcdecl.kind(), funcdecl.toPrettyChars(), label!.toChars());
                    }
                }

            // Fix up forward-referenced gotos
            if (funcdecl.gotos !== null && !funcdecl.isCsymbol()) {
                for (let i = 0; i < funcdecl.gotos.length; ++i) {
                    checkLabel(funcdecl.gotos.opIndex(i)!); // UFCS (04 §6); slot nullable (08 §3)
                }
            }

            if (funcdecl.isNaked && (funcdecl.fensures() !== null || funcdecl.frequires() !== null))
                error(funcdecl.loc,
                    ds("%s `%s` naked assembly functions with contracts are not supported"),
                    funcdecl.kind(), funcdecl.toPrettyChars());

            sc2.ctorflow.callSuper = CSX.none;
            sc2.pop();
        }

        if (checkClosure(funcdecl)) { // UFCS (04 §6) — this module's free function
            // We should be setting errors here instead of relying on the global error count.
            //errors = true;
        }

        /* If function survived being marked as impure, then it is pure
         */
        if (funcdecl.purityInprocess) {
            funcdecl.purityInprocess = false;
            if (funcdecl.type === f)
                f = f.copy().isTypeFunction()!; // D `cast(TypeFunction)f.copy()` (02 §11.5c(3))
            f.purity = PURE.fwdref;
        }

        if (funcdecl.safetyInprocess) {
            funcdecl.safetyInprocess = false;
            if (funcdecl.type === f)
                f = f.copy().isTypeFunction()!; // D `cast(TypeFunction)f.copy()` (02 §11.5c(3))
            f.trust = TRUST.safe;
        }

        if (funcdecl.nogcInprocess) {
            funcdecl.nogcInprocess = false;
            if (funcdecl.type === f)
                f = f.copy().isTypeFunction()!; // D `cast(TypeFunction)f.copy()` (02 §11.5c(3))
            f.isNogc = true;
        }

        // swept: `finishScopeParamInference` (dmd/escape.d:2042) is live in escape.ts — the call D
        // authorises at dmd/semantic3.d:1383 is written for real. `ref TypeFunction f` REASSIGNS the
        // caller's variable (escape.d:2051), so the argument is a one-slot box (03 §3.2/§3.3) and `f`
        // is restored from it immediately: the statements below (`if (funcdecl.type !== f)`, the
        // `f.deco` test, `typeSemantic(f, …)`) must see the copy, exactly as D's `f` does.
        const fRef: Ref<TypeFunction> = { value: f };
        finishScopeParamInference(funcdecl, fRef);
        f = fRef.value;

        // reset deco to apply inference result to mangled name
        if (funcdecl.type !== f)
            f.deco = null;

        // Do semantic type AFTER pure/nothrow inference.
        if (f.deco === null && funcdecl.ident !== Id.xopEquals && funcdecl.ident !== Id.xopCmp) {
            this.sc = this.sc!.push();
            if (funcdecl.isCtorDeclaration() !== null) // https://issues.dlang.org/show_bug.cgi?id=#15665
                f.isCtor = true;
            this.sc.stc = STC.none;
            this.sc.linkage = funcdecl._linkage; // https://issues.dlang.org/show_bug.cgi?id=8496
            funcdecl.type = typeSemantic(f, funcdecl.loc, this.sc); // UFCS (04 §6)
            this.sc = this.sc.pop();
        }

        // Check `extern(C++)` functions for invalid the return/parameter types
        if (funcdecl._linkage === LINK.cpp) {
            // semantic3.d:1404 — nested `static bool isCppNonMappableType(...)` -> inner arrow (04 §5).
            // `static` on a nested function only forbids capturing the enclosing frame; the arrow
            // captures nothing beyond module scope, so the contract is preserved.
            const isCppNonMappableType = (type: Type, param: Parameter | null = null,
                                          origType: Type | null = null): boolean => {
                // Don't allow D `immutable` and `shared` types to be interfaced with C++
                if (type.isImmutable() || type.isShared())
                    return true;
                const cpptype = target.cpp.parameterType(type); // 06 §2.6 hoist of `if (Type cpptype = ...)`
                if (cpptype !== null)
                    type = cpptype;

                if (origType === null)
                    origType = type;

                // Permit types that are handled by toCppMangle. This list should be kept in sync with
                // each visit method in dmd.cppmangle and dmd.cppmanglewin.
                switch (type.ty) {
                    case TY.Tnull:
                    case TY.Tnoreturn:
                    case TY.Tvector:
                    case TY.Tpointer:
                    case TY.Treference:
                    case TY.Tfunction:
                    case TY.Tstruct:
                    case TY.Tenum:
                    case TY.Tclass:
                    case TY.Tident:
                    case TY.Tinstance:
                        break;

                    case TY.Tsarray:
                        if (origType.isTypePointer() === null)
                            return true;
                        break;

                    default:
                        if (type.isTypeBasic() === null)
                            return true;
                        break;
                }

                // Descend to the enclosing type
                const tnext = nextOf(type); // 06 §2.6 hoist
                if (tnext !== null)
                    return isCppNonMappableType(tnext, param, origType);

                return false;
            };
            if (isCppNonMappableType(toBasetype(f.next!)) && !funcdecl.skipCodegen) {
                error(funcdecl.loc,
                    ds("%s `%s` cannot return type `%s` because its linkage is `extern(C++)`"),
                    funcdecl.kind(), dsymbolToErrMsg(funcdecl), f.next!.toChars());
                if (f.next!.isTypeDArray() !== null)
                    errorSupplemental(funcdecl.loc,
                        ds("slices are specific to D and do not have a counterpart representation in C++"),
                        f.next!.toChars());
                funcdecl.errors = true;
            }
            // 06 §1.8 — D `foreach (i, param; f.parameterList)`; `i` is unused in the body.
            f.parameterList.opApply((_i: number, param: Parameter): number => {
                if (isCppNonMappableType(toBasetype(param.type!), param)) {
                    error(funcdecl.loc,
                        ds("%s `%s` cannot have parameter of type `%s` because its linkage is `extern(C++)`"),
                        funcdecl.kind(), dsymbolToErrMsg(funcdecl), param.type!.toChars());
                    if (toBasetype(param.type!).isTypeSArray() !== null)
                        errorSupplemental(funcdecl.loc, ds("perhaps use a `%s*` type instead"),
                            unSharedOf(mutableOf(nextOf(param.type!)!)).toChars());
                    funcdecl.errors = true;
                }
                return 0; // opApply control code: continue (05 §11)
            });
        }

        // Do live analysis
        if (this.sc!.previews.dip1021 && funcdecl.fbody !== null
            && funcdecl.type!.ty !== TY.Terror
            && funcdecl.type!.isTypeFunction()!.isLive) {
            oblive(funcdecl); // dmd/ob.d:56 — `void oblive(FuncDeclaration funcdecl)`
        }

        // resolved: `version (FastDFA)` -> ON (semantic3.d:81-85: version(IN_GCC) is OFF, so
        // `version = FastDFA;` is set).
        if (global.params.useFastDFA && global.errors === oldErrors && funcdecl.fbody !== null
            && funcdecl.type!.ty !== TY.Terror) {
            // Don't run DFA if there are errors,
            //  this is a costly enough operation that it warrents the explicit check.
            dfaEntry(funcdecl, this.sc!); // dmd/dfa/entry.d:35 — `void dfaEntry(FuncDeclaration fd, Scope* sc)`
        }

        /* If this function had instantiated with gagging, error reproduction will be
         * done by TemplateInstance::semantic.
         * Otherwise, error gagging should be temporarily ungagged by functionSemantic3.
         */
        funcdecl.semanticRun = PASS.semantic3done;
        if ((global.errors !== oldErrors)
            || (funcdecl.fbody !== null && funcdecl.fbody.isErrorStatement() !== null))
            funcdecl.hasSemantic3Errors = true;
        else
            funcdecl.hasSemantic3Errors = false;
        if (funcdecl.type!.ty === TY.Terror)
            funcdecl.errors = true;
        //printf("-FuncDeclaration::semantic3('%s.%s', sc = %p, loc = %s)\n", funcdecl.parent.toChars(), funcdecl.toChars(), sc, funcdecl.loc.toChars());
        //fflush(stdout);
    }

    // dmd/semantic3.d:1501 — `override void visit(CtorDeclaration ctor)`.
    override visitCtorDeclaration(ctor: CtorDeclaration): void {
        //printf("CtorDeclaration()\n%s\n", ctor.fbody.toChars());
        if (ctor.semanticRun >= PASS.semantic3)
            return;

        if (ctor.fbody === null)
            return this.visitFuncDeclaration(ctor); // D `visit(cast(FuncDeclaration)ctor)` (13 §4)

        /* If any of the fields of the aggregate have a destructor, add
         *   scope (failure) { this.fieldDtor(); }
         * as the first statement of the constructor (unless the constructor
         * doesn't define a body - @disable, extern)
         *.It is not necessary to add it after
         * each initialization of a field, because destruction of .init constructed
         * structs should be benign.
         * https://issues.dlang.org/show_bug.cgi?id=14246
         */
        const ad = ctor.isMemberDecl();
        if (ad === null || ad.fieldDtor === null
            || global.params.dtorFields === FeatureState.disabled
            || !global.params.useExceptions
            || ctor.type!.toTypeFunction().isNothrow)
            return this.visitFuncDeclaration(ctor);

        /* Generate:
         *   this.fieldDtor()
         */
        let e: Expression = new ThisExp(ctor.loc);
        e.type = mutableOf(ad.type!); // UFCS (04 §6)
        e = new DotVarExp(ctor.loc, e, ad.fieldDtor, false);
        const ce = new CallExp(ctor.loc, e);
        const sexp = new ExpStatement(ctor.loc, ce);
        const ss = new ScopeStatement(ctor.loc, sexp, ctor.loc);

        if (global.params.dtorFields === FeatureState.default_) {
            const ctf = ctor.type!.isTypeFunction()!; // D `cast(TypeFunction) ctor.type`
            const dtf = ad.fieldDtor.type!.isTypeFunction()!;

            const ngErr = ctf.isNogc && !dtf.isNogc;
            const puErr = ctf.purity !== 0 && dtf.purity === 0; // D `ctf.purity && !dtf.purity` (09 §9)
            const saErr = ctf.trust === TRUST.safe && dtf.trust <= TRUST.system;

            if (ngErr || puErr || saErr) {
                // storage_class is apparently not set for dtor & ctor
                const ob = new OutBuffer();
                stcToBuffer(ob,
                    ((ngErr ? STC.nogc : STC.none)
                        | (puErr ? STC.pure_ : STC.none)
                        | (saErr ? STC.system : STC.none)) as STC,
                );
                // UFCS: D `ctor.loc.error(...)` is the free `error(Loc, ...)` of errors.d (04 §6)
                error(ctor.loc, ds("`%s` has stricter attributes than its destructor (`%s`)"),
                    ctor.toPrettyChars(), ob.peekChars());
                errorSupplemental(ctor.loc, ds("The destructor will be called if an exception is thrown"));
                errorSupplemental(ctor.loc,
                    ds("Either make the constructor `nothrow` or adjust the field destructors"));

                ce.ignoreAttributes = true;
            }
        }

        // resolved: `version (all)` -> ON (07 §1.2) — the try/catch lowering below is emitted and the
        // `else` arm (semantic3.d:1582-1590, the `scope(failure)` variant) is DROPPED.
        /* Generate:
         *   try { ctor.fbody; }
         *   catch (Exception __o)
         *   { this.fieldDtor(); throw __o; }
         * This differs from the alternate scope(failure) version in that an Exception
         * is caught rather than a Throwable. This enables the optimization whereby
         * the try-catch can be removed if ctor.fbody is nothrow. (nothrow only
         * applies to Exception.)
         */
        const id = Identifier.generateId(ds("__o"));
        const ts = new ThrowStatement(ctor.loc, new IdentifierExp(ctor.loc, id));
        const handler = CompoundStatement.fromStatementList(ctor.loc, ss, ts);

        const ctch = new Catch(ctor.loc, getException(), id, handler);
        const catches: Catches = DArray.from<Catch | null>(ctch); // `new Catches(ctch)` (08 §2.9)

        ctor.fbody = new TryCatchStatement(ctor.loc, ctor.fbody, catches);

        this.visitFuncDeclaration(ctor); // D `visit(cast(FuncDeclaration)ctor)` (13 §4)
    }

    // dmd/semantic3.d:1594 — `override void visit(Nspace ns)`.
    override visitNspace(ns: Nspace): void {
        if (ns.semanticRun >= PASS.semantic3)
            return;
        ns.semanticRun = PASS.semantic3;
        // resolved: static if (LOG) -> OFF — printf block dropped (semantic3.d:1599-1602)
        if (ns.members === null)
            return;

        this.sc = this.sc!.push(ns);
        this.sc.linkage = LINK.cpp;
        for (const s of ns.members) {
            semantic3(s!, this.sc); // UFCS (04 §6); slot `Dsymbol | null` (08 §3)
        }
        this.sc.pop();
    }

    // dmd/semantic3.d:1615 — `override void visit(AttribDeclaration ad)`.
    override visitAttribDeclaration(ad: AttribDeclaration): void {
        const d = include(ad, this.sc); // UFCS (04 §6) -> dsymbolsem.d:9726
        if (d === null)
            return;

        // UFCS `ad.newScope(sc)` -> the Dsymbol-receiver overload (dsymbolsem.d:8980), renamed
        // `newScopeDsymbol` in the port (04 §1B); the bare `newScope` is the AggregateDeclaration one.
        const sc2 = newScopeDsymbol(ad, this.sc);
        for (let i = 0; i < d.length; i++) {
            const s = d.opIndex(i); // slot `Dsymbol | null` (08 §3)
            semantic3(s!, sc2);
        }
        if (sc2 !== this.sc)
            sc2!.pop();
    }

    // dmd/semantic3.d:1631 — `override void visit(AggregateDeclaration ad)`.
    override visitAggregateDeclaration(ad: AggregateDeclaration): void {
        //printf("AggregateDeclaration::semantic3(sc=%p, %s) type = %s, errors = %d\n", sc, toChars(), type.toChars(), errors);
        if (ad.members === null)
            return;

        const sd = ad.isStructDeclaration();
        if (this.sc === null) { // from runDeferredSemantic3 for TypeInfo generation
            assert(sd !== null); // semantic3.d:1640
            semanticTypeInfoMembers(sd!); // UFCS (04 §6)
            return;
        }

        const sc2 = newScope(ad, this.sc); // UFCS (04 §6) -> dsymbolsem.d:90

        for (let i = 0; i < ad.members.length; i++) {
            const s = ad.members.opIndex(i); // slot `Dsymbol | null` (08 §3)
            semantic3(s!, sc2);
        }

        sc2.pop();

        if (sd !== null)
            semanticTypeInfoMembers(sd);
        else
            semanticRTInfo(ad); // UFCS (04 §6)
        ad.semanticRun = PASS.semantic3done;
    }

    // dmd/semantic3.d:1662 — `override void visit(TypeInfoAssociativeArrayDeclaration ti)`.
    override visitTypeInfoAssociativeArrayDeclaration(ti: TypeInfoAssociativeArrayDeclaration): void {
        if (ti.semanticRun >= PASS.semantic3) {
            if (K.on) keepReq(ti, KeepUnit.tinfo);   // the kept-module engine: a request of a unit that ran
            return;
        }
        if (K.on && keepRun(ti, KeepUnit.tinfo))     // the kept-module engine: replays a kept unit, or records
            return;
        ti.semanticRun = PASS.semantic3;

        const t = ti.tinfo!.isTypeAArray()!;
        const loc = t.loc; // `Loc` is an ALIAS-SAFE REGISTER member (03 §9.1) — plain share
        const sc2 = this.sc !== null ? this.sc : ti._scope;

        // semantic3.d:1672 — nested `auto makeDotExp(Identifier hook)` -> inner arrow (04 §5).
        const makeDotExp = (hook: Identifier): DotTemplateInstanceExp => {
            // always called with naked types
            const tiargs: Objects = DArray.from<RootObject | null>(t.index, t.next); // `new Objects(a,b)` (08 §2.9)

            let id: Expression = new IdentifierExp(loc, Id.empty!);
            id = new DotIdExp(loc, id, Id.object!);
            id = new DotIdExp(loc, id, Id.TypeInfo_AssociativeArray!);
            // D `this(Loc, Expression, Identifier, Objects*)` -> the named factory (04 §1.1c)
            return DotTemplateInstanceExp.fromName(loc, id, hook, tiargs);
        };

        // semantic3.d:1683 — nested `void notTemplateFunction(Loc loc, Identifier id)`.
        const notTemplateFunction = (loc_: Loc, id: Identifier): void => {
            error(loc_, ds("`%s` isn't a template function"), id.toChars());
        };

        // generate ti.entry
        const tempinst = makeDotExp(Id.Entry!);
        let e: Expression = expressionSemantic(tempinst, sc2!);
        assert(e.type !== null); // semantic3.d:1691
        ti.entry = e.type;
        const ts = ti.entry!.isTypeStruct(); // 06 §2.6 hoist
        if (ts !== null) {
            // resolved: `version (IN_LLVM) {} else { ts.sym.requestTypeInfo = true; }` (semantic3.d:1695)
            // -> IN_LLVM is ON, so the else-arm assignment is DROPPED (dstruct.ts carries the same
            // resolution at its `requestTypeInfo` field).
            const tmpl = ts.sym!.isInstantiated(); // 06 §2.6 hoist
            if (tmpl !== null) {
                tmpl.minst = sc2!._module!.importedFrom; // ensure it gets emitted
                if (K.on) keepMinst(tmpl);   // the kept-module engine: a write to the instance, replayed
            }
        }
        semanticTypeInfo(sc2, ti.entry); // might get deferred

        // generate ti.xtoHash
        const aaGetHash = Identifier.idPool(ds("aaGetHash"));
        const hashinst = makeDotExp(aaGetHash);
        e = expressionSemantic(hashinst, sc2!);
        if (e.isErrorExp() === null) {
            if (e.isVarExp() === null || e.type!.isTypeFunction() === null)
                notTemplateFunction(e.loc, aaGetHash);
            else {
                ti.xtoHash = e.isVarExp()!.var_;
                const tmpl = ti.xtoHash!.parent!.isTemplateInstance(); // 06 §2.6 hoist
                if (tmpl !== null) {
                    tmpl.minst = sc2!._module!.importedFrom; // ensure it gets emitted
                    if (K.on) keepMinst(tmpl);   // the kept-module engine: a write to the instance, replayed
                }
            }
        }

        // generate ti.xopEqual
        const aaOpEqual = Identifier.idPool(ds("aaOpEqual"));
        const equalinst = makeDotExp(aaOpEqual);
        e = expressionSemantic(equalinst, sc2!);
        if (e.isErrorExp() === null) {
            if (e.isVarExp() === null || e.type!.isTypeFunction() === null)
                notTemplateFunction(e.loc, aaOpEqual);
            else {
                ti.xopEqual = e.isVarExp()!.var_;
                const tmpl = ti.xopEqual!.parent!.isTemplateInstance(); // 06 §2.6 hoist
                if (tmpl !== null) {
                    tmpl.minst = sc2!._module!.importedFrom; // ensure it gets emitted
                    if (K.on) keepMinst(tmpl);   // the kept-module engine: a write to the instance, replayed
                }
            }
        }
        // D `visit(cast(ASTCodegen.TypeInfoDeclaration)ti)` — the `ASTCodegen.` namespace qualifier
        // vanishes with the monomorphized AST (13 §3); the cast is a plain upcast, so the call is the
        // BASE's named slot (13 §4).
        this.visitTypeInfoDeclaration(ti);
    }
}

/// Helper for semantic3 analysis of functions.
/// This struct is part of a WIP refactoring to simplify large `visit(FuncDeclaration)` logic.
///
/// dmd/semantic3.d:1741 — `private struct FuncDeclSem3`. A VALUE struct (02 §2, 03): plain (no
/// postblit / opAssign / copy-ctor), so `.copy()` is the per-field recursion of 03 §2 — both fields
/// are class/pointer references and are SHARED by the copy, exactly as D's shallow struct copy does.
/// D module-private; emitted WITHOUT `private` (01-conventions).
export class FuncDeclSem3 {
    // The FuncDeclaration subject to Semantic analysis
    funcdecl: FuncDeclaration;

    // Scope of analysis
    sc: Scope | null;

    // dmd/semantic3.d:1748 — `this(FuncDeclaration fd,Scope* s) scope @safe` (attributes erased).
    constructor(fd: FuncDeclaration, s: Scope | null) {
        this.funcdecl = fd;
        this.sc = s;
    }

    /// 03 §2 — per-field copy; both fields are references and are shared.
    copy(): FuncDeclSem3 {
        return new FuncDeclSem3(this.funcdecl, this.sc);
    }

    /* Checks that the overridden functions (if any) have in contracts if
     * funcdecl has an in contract.
     */
    checkInContractOverrides(): void {
        if (this.funcdecl.frequires() !== null) {
            for (let i = 0; i < this.funcdecl.foverrides.length; i++) {
                // slot `FuncDeclaration | null` (08 §3); D dereferences with no null test
                const fdv = this.funcdecl.foverrides.opIndex(i)!;
                if (fdv.fbody !== null && fdv.frequires() === null) {
                    error(this.funcdecl.loc,
                        ds("%s `%s` cannot have an in contract when overridden function `%s` does not have an in contract"),
                        this.funcdecl.kind(), this.funcdecl.toPrettyChars(), fdv.toPrettyChars());
                    break;
                }
            }
        }
    }

    /* Determine if function should add `return 0;`
     */
    addReturn0(): boolean {
        //printf("addReturn0()\n");
        const f = this.funcdecl.type!.isTypeFunction();
        if (f === null) return false;

        // C11 5.1.2.2.3
        if (this.sc!.inCfile && this.funcdecl.isCMain() && f.next!.ty === TY.Tint32)
            return true;

        return f.next!.ty === TY.Tvoid && (this.funcdecl.isMain() || this.funcdecl.isCMain());
    }
}

/// dmd/semantic3.d:1804 — `__gshared TypeFunction tftostring;`, a function-local static of
/// `search_toString`. One process-wide slot, hoisted to module scope (01 §5.5).
let tftostring: TypeFunction | null = null;

/**
 * No D counterpart: the djs driver's reset between two compiles in one process (src/djs.ts
 * `deinitializeFrontend`): `tftostring` is a type of the finished compile's type table.
 */
export function resetSemantic3State(): void {
    tftostring = null;
}

/***************************************
 * dmd/semantic3.d:1797 — `FuncDeclaration search_toString(StructDeclaration sd)`.
 * Search sd for a member function of the form:
 *   `extern (D) string toString();`
 * Params:
 *   sd = struct declaration to search
 * Returns:
 *   FuncDeclaration of `toString()` if found, `null` if not
 */
export function search_toString(sd: StructDeclaration): FuncDeclaration | null {
    const s = search_function(sd, Id.tostring!);
    const fd = s !== null ? s.isFuncDeclaration() : null;
    if (fd === null)
        return null;

    if (tftostring === null) {
        tftostring = new TypeFunction(new ParameterList(null), Type.tstring, LINK.d);
        tftostring = merge(tftostring).toTypeFunction(); // UFCS (04 §6) -> typesem.d:3514
    }
    return overloadExactMatch(fd, tftostring); // UFCS (04 §6)
}

/**
 * Ensures special members of a struct are fully analysed
 * before the backend emits TypeInfo.
 *
 * Handles late semantic analysis for members like `opEquals`, `opCmp`,
 * `toString`, `toHash`, postblit, and destructor.
 *
 * dmd/semantic3.d:1820 — `void semanticTypeInfoMembers(StructDeclaration sd)`.
 */
export function semanticTypeInfoMembers(sd: StructDeclaration): void {
    // semantic3.d:1822 — nested `void runSemantic(ref FuncDeclaration fd, ref FuncDeclaration errFd)`
    // -> inner arrow (04 §5). `fd` is a `ref` over a FIELD slot, so it takes the canonical one-slot
    // box (03 §3.3/§7.2); `errFd` is `ref` but only ever READ, so it is passed by value (03 §3.2).
    const runSemantic = (fd: Ref<FuncDeclaration | null>, errFd: FuncDeclaration | null): void => {
        if (fd.value !== null && fd.value._scope !== null
            && fd.value.semanticRun < PASS.semantic3done) {
            const errors = global.startGagging();
            // GAG PAIRING (11 §2.5): `semantic3` of a FuncDeclaration reaches walls — an exit path
            // semantic3.d:1826-1829 does not have — and `global.gag` is process-global.
            // `endGagging`'s RESULT is read by D here, so it is captured in the finally.
            let gaggedErrorsHappened = false;
            try {
                semantic3(fd.value, fd.value._scope); // UFCS (04 §6)
            } finally {
                gaggedErrorsHappened = global.endGagging(errors);
            }
            if (gaggedErrorsHappened)
                fd.value = errFd;
        } else if (K.on && fd.value !== null)
            keepReq(fd.value, KeepUnit.fsem3);   // the kept-module engine: a request of a unit that ran
    };

    // `sd.xerreq` / `sd.xerrcmp` are `__gshared` statics of StructDeclaration (dstruct.d:47) reached
    // through the instance in D; the port keeps them as class statics (clone.ts:681).
    const xeqBox: Ref<FuncDeclaration | null> = { value: sd.xeq };
    runSemantic(xeqBox, StructDeclaration.xerreq);
    sd.xeq = xeqBox.value;

    const xcmpBox: Ref<FuncDeclaration | null> = { value: sd.xcmp };
    runSemantic(xcmpBox, StructDeclaration.xerrcmp);
    sd.xcmp = xcmpBox.value;

    const ftostr = search_toString(sd);
    if (ftostr !== null
        && ftostr._scope !== null
        && ftostr.semanticRun < PASS.semantic3done) {
        semantic3(ftostr, ftostr._scope); // UFCS (04 §6)
    } else if (K.on && ftostr !== null)
        keepReq(ftostr, KeepUnit.fsem3);   // the kept-module engine: a request of a unit that ran

    if (sd.xhash !== null
        && sd.xhash._scope !== null
        && sd.xhash.semanticRun < PASS.semantic3done) {
        semantic3(sd.xhash, sd.xhash._scope);
    } else if (K.on && sd.xhash !== null)
        keepReq(sd.xhash, KeepUnit.fsem3);   // the kept-module engine: a request of a unit that ran

    if (sd.postblit !== null
        && sd.postblit._scope !== null
        && sd.postblit.semanticRun < PASS.semantic3done) {
        semantic3(sd.postblit, sd.postblit._scope);
    } else if (K.on && sd.postblit !== null)
        keepReq(sd.postblit, KeepUnit.fsem3);   // the kept-module engine: a request of a unit that ran

    if (sd.dtor !== null
        && sd.dtor._scope !== null
        && sd.dtor.semanticRun < PASS.semantic3done) {
        semantic3(sd.dtor, sd.dtor._scope);
    } else if (K.on && sd.dtor !== null)
        keepReq(sd.dtor, KeepUnit.fsem3);   // the kept-module engine: a request of a unit that ran
    semanticRTInfo(sd); // UFCS (04 §6)
}

/**
 * dmd/semantic3.d:1868 — `void semanticRTInfo(AggregateDeclaration ad)`.
 * Instantiate `RTInfo!S` to provide a pointer bitmap for the GC.
 */
export function semanticRTInfo(ad: AggregateDeclaration): void {
    // Instantiate RTInfo!S to provide a pointer bitmap for the GC
    // Don't do it in -betterC or on error types
    // probe (02 §11.4): Type.rtinfo is declared non-null but unset until `object` is read;
    // D tests `if (!Type.rtinfo)`.
    const noRtinfo = !(Type as { rtinfo?: unknown }).rtinfo;
    if (ad.getRTInfo !== null || !global.params.useTypeInfo || noRtinfo)
        return;
    if (ad.rtInfoScope === null || ad.type === null || ad.type.ty === TY.Terror)
        return;

    // Evaluate: RTinfo!type
    const tiargs: Objects = DArray.from<RootObject | null>(ad.type); // `new Objects(ad.type)` (08 §2.9)
    // D `new TemplateInstance(ad.loc, Type.rtinfo, tiargs)` selects the
    // `this(Loc, TemplateDeclaration, Objects*)` overload -> the named factory (04 §1.1c)
    const ti = TemplateInstance.fromTemplateDeclaration(ad.loc, Type.rtinfo, tiargs);

    const sc = ad.rtInfoScope;
    const sc3 = ti.tempdecl!._scope!.startCTFE();
    sc3.tinst = sc.tinst;
    sc3.minst = sc.minst;
    if (ad.isDeprecated())
        sc3.stc = (sc3.stc | STC.deprecated_) as STC;

    dsymbolSemantic(ti, sc3); // UFCS (04 §6)
    semantic2(ti, sc3); // UFCS (04 §6)
    semantic3(ti, sc3); // UFCS (04 §6)
    let e = symbolToExp(toAlias(ti), Loc.initial, sc3, false); // UFCS

    sc3.endCTFE();

    e = ctfeInterpret(e);
    ad.getRTInfo = e;
    if (K.on) keepRTInfo(ad);   // the kept-module engine: an RTInfo made outside every unit is made again
}

/**
 * Determine whether the given function will need to allocate a _closure_ and
 * verify that such an allocation is allowed under the current compilation
 * settings.
 *
 * Whenever an error is emitted, every nested function that actually closes
 * over a variable is listed in a supplemental diagnostic, together with the
 * location of the captured variable's declaration.  (This extra walk is
 * skipped when the compiler is gagged.)
 *
 * See_Also:
 *      $(UL
 *        $(LI `FuncDeclaration.needsClosure`)
 *        $(LI `FuncDeclaration.setGC`)
 *        $(LI `FuncDeclaration.printGCUsage`)
 *      )
 *
 * dmd/semantic3.d:1916 — `extern (D) bool checkClosure(FuncDeclaration fd)` (`extern (D)` erased).
 */
export function checkClosure(fd: FuncDeclaration): boolean {
    //printf("checkClosure() %s\n", toPrettyChars());
    if (!needsClosure(fd)) // UFCS (04 §6)
        return false;

    if (setGC(null, fd, fd.loc, ds("allocating a closure for `%s()`"), fd)) {
        error(fd.loc, ds("%s `%s` is `@nogc` yet allocates closure for `%s()` with the GC"),
            fd.kind(), fd.toPrettyChars(), fd.toChars());
        if (global.gag !== 0)     // need not report supplemental errors
            return true;
    } else if (!global.params.useGC) {
        error(fd.loc, ds("%s `%s` is `-betterC` yet allocates closure for `%s()` with the GC"),
            fd.kind(), fd.toPrettyChars(), fd.toChars());
        if (global.gag !== 0)     // need not report supplemental errors
            return true;
    } else {
        // swept (11 §2.5): `printGCUsage` is live in nogc.ts with the D signature — the authorising
        // D line is dmd/nogc.d:307. A free function D reaches by UFCS (04 §6).
        printGCUsage(fd, fd.loc, ds("using closure causes GC allocation"));

        findClosureVars(fd, (f: FuncDeclaration, v: VarDeclaration): void => {
            // swept (11 §2.5): `vgcEnabled` is live in nogc.ts with the D signature — the
            // authorising D line is dmd/nogc.d:298. D reads it off `fd`, the OUTER function of
            // `checkClosure`, not off the sink's own `f` (semantic3.d:1939).
            if (!vgcEnabled(fd))
                return;

            message(f.loc, ds("vgc: %s `%s` closes over variable `%s`"),
                f.kind(), dsymbolToErrMsg(f), dsymbolToErrMsg(v));
            if (v.ident !== Id.This)
                message(v.loc, ds("vgc: `%s` declared here"), dsymbolToErrMsg(v));
        });
        return false;
    }

    findClosureVars(fd, (f: FuncDeclaration, v: VarDeclaration): void => {
        errorSupplemental(f.loc, ds("%s `%s` closes over variable `%s`"),
            f.kind(), dsymbolToErrMsg(f), dsymbolToErrMsg(v));
        if (v.ident !== Id.This)
            errorSupplemental(v.loc, ds("`%s` declared here"), dsymbolToErrMsg(v));
    });
    return true;
}

/// For an outer function `fd`, find inner functions that cause a closure to be generated for it.
/// Pass to `sink` each nested function along with the local variable that closes over `fd`'s stackframe
///
/// dmd/semantic3.d:1961 — `private void findClosureVars(FuncDeclaration fd,`
/// `scope void delegate(FuncDeclaration, VarDeclaration) sink)`. D module-private; emitted WITHOUT
/// `private` (01-conventions) so the module's own callers and the co-located test reach it.
export function findClosureVars(fd: FuncDeclaration,
                                sink: (f: FuncDeclaration, v: VarDeclaration) => void): void {
    const a: FuncDeclarations = new DArray<FuncDeclaration | null>(); // D `FuncDeclarations a;` (by VALUE)

    if (fd.closureVars.length > 0)
        a.reserve(fd.closureVars.length);

    for (const v of fd.closureVars) {
        for (const f of v!.nestedrefs) { // slot `VarDeclaration | null` (08 §3)
            assert(f !== fd); // semantic3.d:1972 — `assert(f !is fd)`

            LcheckAncestorsOfANestedRef:
            // 02 §10.1 reassignment cursor: D walks `for (Dsymbol s = f; s && s !is fd; s = s.toParentP(fd))`
            for (let cur: Dsymbol | null = f;
                 cur !== null && cur !== fd;
                 cur = toParentP(cur, fd)) {
                const fx = cur.isFuncDeclaration();
                if (fx === null)
                    continue;
                if (fx.isThis() !== null || fx.tookAddressOf !== 0 || checkEscapingSiblings(fx, fd)) {
                    if (!a.contains(f)) {
                        a.push(f);
                        sink(f!, v!);
                    }
                    break LcheckAncestorsOfANestedRef;
                }
            }
        }
    }
}
