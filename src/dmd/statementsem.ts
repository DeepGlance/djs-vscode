// Ported from dmd/statementsem.d (module dmd.statementsem), LDC 1.43.0-beta1 / DMD 2.113.
//
// Semantic analysis (pass 3) for Statement nodes.
//   statementSemantic          : public entry (dmd/statementsem.d:164)
//   statementSemanticVisit     : package(dmd) dispatcher (dmd/statementsem.d:180)
//   throwSemantic / catchSemantic / makeTupleForeach / scopeCode / semanticNoScope : public surface
// Spec: https://dlang.org/spec/statement.html
//
// VISITOR IDIOM: C (13 §7.6). `grep 'class .*Visitor' dmd/statementsem.d` yields exactly ONE hit, and
// it is the function-LOCAL `DebugWalker : SemanticTimeTransitiveVisitor` inside debugThrowWalker
// (dmd/statementsem.d:5073) — that one IS Idiom A. The pass itself has no visitor class:
// `statementSemanticVisit` declares 42 nested handlers and drives them through
// `mixin VisitStatement!void visit;` (:3823) + `visit.VisitStatement(s);` (:3824), whose CTFE
// expansion (statement.d:1981 via `visitStmtCase`) is resolved at translation time and emitted
// inline as the trailing dispatch switch, IN FULL.
//
// 1.42 -> 1.43 reconciliation carried forward from the previous partial port: D 1.42's
// `Expression.checkType()` is 1.43's free function `hasValidType` (dmd/expressionsem.d).
//
// resolved: version (DMDLIB) (dmd/statementsem.d:76-78) -> OFF, so `version = CallbackAPI;` never
//   fires; the two `version (CallbackAPI)` blocks (:168, :173) and the function-local
//   `import dmd.compiler;` (:165) are dropped with them.
// resolved: version (IN_LLVM) (dmd/statementsem.d:70-73) -> ON: the block declares the
//   `extern(C++) Statement asmSemantic(AsmStatement, Scope*)` prototype, implemented in LDC's
//   gen/asmstmt.cpp and ported in src/gen/asmstmt.ts (11 §3.2), imported last below.
// dmd/statementsem.d:48 `import dmd.importc;`: its sole use is `rs.exp.arrayFuncConv(sc)` at dmd/statementsem.d:2644;
//   imported last (01 §4.8).
//
// MODULE-LEVEL STATE: none. No `__gshared`, no module-scope manifest `enum`, no `static this()`.
// CYCLE TREATMENT (01 §4.7): this file sits in the core SCC but has zero module-level `new`, zero
// top-level value reads and no module init state, so plain value imports are safe (every use is
// inside a function body); `import type` is used where the binding is type-only.

import { AggregateDeclaration } from "./aggregate.js";
import { checkNonAssignmentArrayOp } from "./arrayop.js";
import type {
    CaseStatements, Catches, Dsymbols, Expressions, Objects, Parameters, Statements,
} from "./arraytypes.js";
import {
    CHECKACTION, CHECKENABLE, LINK, MATCH, MODFlags, STC, STMT, TY,
} from "./astenums.js";
import { ForwardingAttribDeclaration } from "./attrib.js";
import { BE, blockExit } from "./blockexit.js";
import { mergeFuncAttrs } from "./clone.js";
import { DebugCondition, StaticForeach } from "./cond.js";
import { CSX, CtorFlow } from "./ctorflow.js";
import {
    _cast, castTo, getIntRange, implicitCastTo, implicitConvTo, implicitConvToType, inferType,
    intRangeFromType, integralPromotions, typeCombine,
} from "./dcast.js";
import { ClassDeclaration } from "./dclass.js";
import { AliasDeclaration, Declaration, ObjectNotFound, VarDeclaration } from "./declaration.js";
import { EnumDeclaration } from "./denum.js";
import { Import } from "./dimport.js";
import { Contract } from "./dscope.js";
import type { Scope } from "./dscope.js";
import { Dsymbol, PASS, ScopeDsymbol, WithScopeSymbol } from "./dsymbol.js";
import {
    addDeferredSemantic2, adjustLocForMixin, dsymbolSemantic, include as dsymbolInclude,
    resolveAliasThis, search, setScope, toAlias, searchScope, insert } from "./dsymbolsem.js";
import { deprecation, deprecationSupplemental, error, errorSupplemental } from "./errors.js";
import {
    AddAssignExp, AddExp, AddrExp, ArgumentList, AssertExp, AssignExp, CallExp, CastExp, CmpExp,
    CommaExp, DeclarationExp, DotIdExp, DotTemplateInstanceExp, EqualExp, ErrorExp, Expression, FuncExp,
    HaltExp, IdentifierExp, IndexExp, IntegerExp, MinExp, NotExp, PostExp, PreExp, PtrExp,
    SliceExp, StringExp, ThisExp, TupleExp, TypeExp, VarExp, VectorArrayExp, WANTexpand,
    WANTvalue, isFuncAddress, lastComma,
} from "./expression.js";
import {
    addDtorHook, addressOf, checkAddressable, checkModifiable, checkNoreturnVarAccess,
    checkSharedAccess, equals as expEquals, expandAliasThisTuples, expressionSemantic,
    expressionsToString, hasValidType, include as conditionInclude, isLvalue, Modifiable,
    ModifyFlags, prepare, resolveProperties, toBoolean, toInteger, toStringExp, valueNoDtor,
    verifyHookExist, merge } from "./expressionsem.js";
import { FuncDeclaration, FuncLiteralDeclaration } from "./func.js";
import {
    buildResultVar, checkForwardRef, checkNestedReference, functionSemantic, FuncResolveFlag,
    genCfunc, genCfuncFromName, resolveFuncCall, setImpure,
} from "./funcsem.js";
import { FeatureState, global } from "./globals.js";
import { initializerToChars, stcToString, toErrMsg } from "./hdrgen.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { ExpInitializer, Initializer } from "./init.js";
import { IntRange, SignExtendedNumber } from "./intrange.js";
import { Loc } from "./location.js";
import {
    MODmethodConv, Parameter, ParameterList, Type, TypeDelegate, TypeEnum, TypeFunction,
    TypeIdentifier, TypeTuple, getThrowable, isSomeChar,
} from "./mtype.js";
import { checkGC, setGC } from "./nogc.js";
import { optimize } from "./optimize.js";
import { inferApplyArgTypes, inferForeachAggregate } from "./opover.js";
import { ParseStatementFlags, Parser } from "./parse.js";
import { pragmaStmtSemantic } from "./pragmasem.js";
import { isSafe, isSaferD, setUnsafe } from "./safe.js";
import {
    AsmStatement, BreakStatement, CaseRangeStatement, CaseStatement, Catch, CompoundAsmStatement,
    CompoundDeclarationStatement, CompoundStatement, ConditionalStatement, ContinueStatement,
    DebugStatement, DefaultStatement, DoStatement, DtorExpStatement, ErrorStatement, ExpStatement,
    ForStatement, ForeachRangeStatement, ForeachStatement, ForwardingStatement,
    GotoCaseStatement, GotoDefaultStatement, GotoStatement, IfStatement, ImportStatement,
    LabelDsymbol, LabelStatement, MixinStatement, PeelStatement, PragmaStatement, ReturnStatement,
    ScopeGuardStatement, ScopeStatement, Statement, StaticAssertStatement, SwitchErrorStatement,
    SwitchStatement, SynchronizedStatement, ThrowStatement, TryCatchStatement, TryFinallyStatement,
    UnrolledLoopStatement, WhileStatement, WithStatement,
} from "./statement.js";
import { SwitchExceptions, SwitchScopeGuard } from "./targetcompiler.js";
import { EXP, TOK, Token } from "./tokens.js";
import {
    addMod, addStorageClass, arrayOf, constConv, constOf, isAggregate, isIntegral,
    isRecursiveAliasThis, isScalar, isString, isUnsigned, mutableOf, needsDestruction, needsNested,
    nextOf, pointerTo, sarrayOf, substWildTo, toBasetype, toDsymbol, typeSemantic,
} from "./typesem.js";
import { SemanticTimeTransitiveVisitor } from "./visitor/index.js";
import { OutBuffer } from "./common/outbuffer.js";
import { Array as DArray } from "./root/array.js";
import { dmdformat } from "./root/dmdformat.js";
import { toDString } from "./root/string.js";
import { RootObject } from "./rootobject.js";
import { SwitchError, assert, assertUnreachable } from "../assert.js";
import { ds } from "../dstring.js";
import type { DString } from "../dstring.js";
import { toInt64, toUint64 } from "../numeric.js";
// last (01 §4.8): the two value imports added by the end-of-wave wall sweep. `mustuse.ts` and
// `semantic2.ts` are both core-SCC members, so they sit at LAST position with the rest of the SCC
// already loaded — entering the SCC through a `*sem` pass is the load-order failure Rule 4.8 names.
import { checkMustUse } from "./mustuse.js";
import { semantic2 } from "./semantic2.js";
import { copyToTemp, discardValue } from "./sideeffect.js";
import { checkReturnEscapeRef, checkThrowEscape } from "./escape.js";
// last (01 §4.8), wave-14 sweep: target.ts value-imports typesem/expression/hdrgen, and dinterpret.ts drags the
// CTFE world (ctfeexpr, constfold) plus every *sem pass; both enter the SCC only after the rest is loaded.
import { target } from "./target.js";
import { ctfeInterpret } from "./dinterpret.js";
// last (01 §4.8): dmd/statementsem.d:73 (`Statement asmSemantic(AsmStatement s, Scope* sc);`). asmstmt.ts
// value-imports iasm/gcc.ts, which value-imports this module and the other *sem passes back.
import { asmSemantic } from "../gen/asmstmt.js";
// last (01 §4.8): dmd/statementsem.d:48 `import dmd.importc;` (arrayFuncConv). importc.ts value-imports typesem,
// dcast, dsymbolsem and expressionsem back, so entering the core SCC through it from an earlier position would make
// it the entry.
import { arrayFuncConv } from "./importc.js";


/*****************************************
 * dmd/statementsem.d:85 — `bool ready(StaticForeach _this)`.
 *
 * Returns: `true` iff ready to call `dmd.statementsem.makeTupleForeach`.
 *
 * NEW HOME in 1.43: 1.42 spelled this `StaticForeach.ready()` (cond.d:242); the body is unchanged
 * modulo the `_this.` prefix. Exported because dsymbolsem.d:9244 calls it (and so does
 * `flatten` at :4912).
 */
export function ready(_this: StaticForeach): boolean {
    // Three nullable-reference truthiness tests (06 §2.7), then a tag compare.
    return _this.aggrfe !== null && _this.aggrfe.aggr !== null && _this.aggrfe.aggr.type !== null &&
        toBasetype(_this.aggrfe.aggr.type).ty === TY.Ttuple;
}

/*****************************************
 * dmd/statementsem.d:100 — `private Identifier fixupLabelName(Scope* sc, Identifier ident)`.
 *
 * CTFE requires FuncDeclaration::labtab for the interpretation, so fixing the label name inside
 * in/out contracts is necessary for uniqueness in labtab.
 *
 * Params:
 *      sc = context
 *      ident = statement label name to be adjusted
 * Returns: adjusted label name
 *
 * D `private` is MODULE-scoped and statementSemanticVisit (a sibling in this module) calls it, so
 * the port emits it without any visibility keyword (01 §2 / 10 §1.7). // D module-private
 */
function fixupLabelName(sc: Scope, ident: Identifier): Identifier {
    const c: Contract = sc.contract;
    const id = ident.toString();
    // `id[0] == '_'` is a BYTE compare over the interned name (08 §11): '_' is 0x5F.
    if (c !== Contract.none && c !== Contract.invariant_ &&
        !(id.length >= 2 && id[0] === 0x5F && id[1] === 0x5F))  // does not start with "__"
    {
        const buf = new OutBuffer();
        buf.writestring(c === Contract.require ? ds("__in_") : ds("__out_"));
        buf.writestring(ident.toString());

        // `buf[]` is a VIEW of the buffer, not `extract*` (08 §13a.2); idPool copies the key bytes.
        ident = Identifier.idPool(buf.opSliceAll());
    }
    return ident;
}

/*******************************************
 * dmd/statementsem.d:124 — `private LabelStatement checkLabeledLoop(Scope* sc, Statement statement)`.
 *
 * Check to see if `statement` is the innermost labeled statement.
 * Params:
 *      sc = context
 *      statement = Statement to check
 * Returns: the `LabelStatement` if it is, otherwise `null`
 *
 * `@safe` erased (04 §8). // D module-private (also called from makeTupleForeach, :4783)
 */
function checkLabeledLoop(sc: Scope, statement: Statement): LabelStatement | null {
    if (sc.slabel !== null && sc.slabel.statement === statement) {
        return sc.slabel;
    }
    return null;
}

/***********************************************************
 * dmd/statementsem.d:141 — `private Expression checkAssignmentAsCondition(Expression e, Scope* sc)`.
 *
 * Check an assignment is used as a condition. Intended to be used BEFORE the `semantic` call on `e`.
 * Params:
 *  e = condition expression which has not yet run semantic analysis
 * Returns: `e` or `ErrorExp`.
 *
 * // D module-private
 */
function checkAssignmentAsCondition(e: Expression, sc: Scope): Expression {
    if (sc.inCfile)
        return e;
    const ec = lastComma(e);
    if (ec.op === EXP.assign) {
        error(ec.loc, ds("assignment cannot be used as a condition, perhaps `==` was meant?"));
        return ErrorExp.get();
    }
    return e;
}

/**
 * No D counterpart: notes the conditional statement `cs`, just decided, on the function being analysed
 * (`FuncDeclaration.djsConditionals`, for the djs host's queries). Called where D decides one: `visitConditional`
 * and `flatten`. A statement is analysed inside a function, whose scope sets `sc.func`; a scope without one has no
 * owner to note it on, and the note is skipped (the queries then do not dim that statement's branch).
 */
function recordConditional(cs: ConditionalStatement, sc: Scope): void {
    if (sc.func !== null)
        (sc.func.djsConditionals ??= []).push(cs);
}

/**
 * dmd/statementsem.d:164 — `Statement statementSemantic(Statement s, Scope* sc)`.
 *
 * Performs semantic analysis in Statement AST nodes.
 *
 * Params:
 *   s = statement to perform semantic analysis on
 *   sc = scope in which statement resides
 *
 * Returns: statement `s` after semantic analysis. Can be `null`, for example with `pragma(msg, "")`.
 */
export function statementSemantic(s: Statement, sc: Scope): Statement | null {
    // dropped: `import dmd.compiler;` (:166) and the two `version (CallbackAPI)` hooks (:168, :173)
    // — CallbackAPI is OFF (see the file-top resolution note).
    const result = statementSemanticVisit(s, sc);
    return result;
}

/**
 * dmd/statementsem.d:180 — `package (dmd) Statement statementSemanticVisit(Statement s, Scope* sc)`.
 *
 * IDIOM C (13 §7.6): 42 nested `visitXxx` handlers driven by `mixin VisitStatement!void visit;`
 * (:3823) + `visit.VisitStatement(s);` (:3824). The mixin's CTFE expansion — the `final switch
 * (s.stmt)` generated by statement.d:1981 via `visitStmtCase` — is resolved at translation time and
 * emitted INLINE as the trailing dispatch switch, IN FULL (all 44 arms). Arms whose `visitXxx`
 * handler does not exist in this function route to `visitDefaultCase`, never to a "related" handler.
 *
 * `sc` is D's own parameter slot, freely reassigned by 12 handlers, so it is a mutable local here.
 *
 * IDENTIFIER NOTE: D locals/parameters named `ds` (visitDo's `DoStatement ds`, visitDefault's
 * `DefaultStatement ds`, visitDebug's `DebugStatement ds`, visitForeach's `Statement ds`) are
 * emitted as `ds_`: the module-level DString literal helper `ds(...)` is in scope throughout this
 * file and a local `ds` would shadow it in every diagnostic below the declaration (01 §2.3, the
 * JS-reserved-name carve-out applied to a port-side collision). Likewise visitForeach's inner
 * `auto sc = p.storageClass;` (dmd:1410) becomes `stcLocal`, because the enclosing `Scope sc` must
 * stay reachable in the same block.
 */
export function statementSemanticVisit(s: Statement, scIn: Scope): Statement | null {
    let result: Statement | null = null;
    let sc: Scope = scIn;

    // dmd/statementsem.d:184.
    const setError = (): void => {
        result = new ErrorStatement();
    };

    // dmd/statementsem.d:189 — the pass-through arm the generated switch routes an unhandled
    // statement kind to. NOTE: it is `result = s;`, NOT `assert(0)` — do not substitute
    // assertUnreachable() (13 §7.6).
    const visitDefaultCase = (s: Statement): void => {
        result = s;
    };

    // dmd/statementsem.d:194.
    const visitError = (s: ErrorStatement): void => {
        result = s;
    };

    // dmd/statementsem.d:199.
    const visitPeel = (s: PeelStatement): void => {
        /* "peel" off this wrapper, and don't run semantic()
         * on the result.
         */
        result = s.s;
    };

    // dmd/statementsem.d:207 — https://dlang.org/spec/statement.html#expression-statement
    const visitExp = (s: ExpStatement): void => {
        if (s.exp === null) {
            result = s;
            return;
        }
        //printf("ExpStatement::semantic() %s\n", exp.toChars());

        // Allow CommaExp in ExpStatement because return isn't used
        CommaExp.allow(s.exp);

        s.exp = expressionSemantic(s.exp, sc);
        s.exp = resolveProperties(sc, s.exp);
        s.exp = addDtorHook(s.exp, sc);
        // dmd/statementsem.d:225 — swept: `checkNonAssignmentArrayOp` is live (dmd/arrayop.d:90).
        if (checkNonAssignmentArrayOp(s.exp))
            s.exp = ErrorExp.get();
        const f = isFuncAddress(s.exp);
        if (f !== null) {
            if (checkForwardRef(f, s.exp.loc))
                s.exp = ErrorExp.get();
        }
        // dmd/statementsem.d:232 — swept: `checkMustUse` is live (dmd/mustuse.d:30 `bool
        // checkMustUse(Expression e, Scope* sc)`, exported by mustuse.ts with the same signature).
        if (checkMustUse(s.exp, sc))
            s.exp = ErrorExp.get();
        // dmd/statementsem.d:234 — swept: `discardValue` is live (dmd/sideeffect.d:242 `bool
        // discardValue(Expression e)`, exported by sideeffect.ts with the same signature).
        if (!sc.inCfile && discardValue(s.exp))
            s.exp = ErrorExp.get();

        s.exp = optimize(s.exp, WANTvalue);
        // dmd/statementsem.d:238 — swept: `checkGC` is live (dmd/nogc.d:268 `Expression
        // checkGC(Expression e, Scope* sc)`, exported by nogc.ts with the same signature).
        s.exp = checkGC(s.exp, sc);
        if (s.exp.op === EXP.error)
            return setError();
        result = s;
    };

    // dmd/statementsem.d:244.
    const visitDtorExp = (s: DtorExpStatement): void => {
        visitExp(s);
    };

    // dmd/statementsem.d:249 — https://dlang.org/spec/statement.html#mixin-statement
    const visitMixin = (cs: MixinStatement): void => {
        //printf("MixinStatement::semantic() %s\n", exp.toChars());
        const a: Statements | null = flatten(cs, sc);
        if (a === null)
            return;
        const s: Statement = new CompoundStatement(cs.loc, a);
        result = statementSemantic(s, sc);
    };

    // dmd/statementsem.d:262.
    const visitCompound = (cs: CompoundStatement): void => {
        //printf("CompoundStatement::semantic(this = %p, sc = %p)\n", cs, sc);
        // resolved: version (none) printf loop (dmd/statementsem.d:265-272) -> OFF, dropped (07 §1).

        for (let i = 0; i < cs.statements!.length;) {
            let s: Statement | null = cs.statements!.opIndex(i);
            if (s === null) {
                ++i;
                continue;
            }

            const flt = flatten(s, sc);
            if (flt !== null) {
                cs.statements!.remove(i);
                cs.statements!.insert(i, flt);
                continue;
            }
            s = statementSemantic(s, sc);
            cs.statements!.opIndexAssign(s, i);
            if (s === null) {
                /* Remove NULL statements from the list.
                 */
                cs.statements!.remove(i);
                continue;
            }
            if (s.isErrorStatement() !== null) {
                result = s;     // propagate error up the AST
                ++i;
                continue;       // look for errors in rest of statements
            }

            // expand tuple variables in order to attach destruction/exception logic
            const es = s.isExpStatement();
            if (es !== null) {
                if (es.exp !== null && es.exp.isDeclarationExp() !== null) {
                    const de = es.exp.isDeclarationExp()!;
                    const vd = de.declaration!.isVarDeclaration();
                    if (vd !== null && vd.aliasTuple !== null && vd.aliasTuple.objects!.length !== 0) {
                        let j = i;
                        cs.statements!.insert(i, vd.aliasTuple.objects!.length - 1, null);
                        vd.aliasTuple.foreachVar((v) => { cs.statements!.opIndexAssign(toStatement(v), j++); });
                        s = cs.statements!.opIndex(i);
                    }
                }
            }

            // `out Statement sentry/sexception/sfinally` -> boxes, reset on entry by scopeCode (03 §3.3).
            const sentry: { value: Statement | null } = { value: null };
            const sexception: { value: Statement | null } = { value: null };
            const sfinally: { value: Statement | null } = { value: null };

            // `s!` is a NARROWING artifact, not an invented guard: D reaches this line only with a
            // non-null `s` (the `if (!s) continue;` at dmd/statementsem.d:286 and the tuple-expansion
            // re-read at :372 both keep it live); the `!` marks the exact site D would fault (02 §10.1).
            cs.statements!.opIndexAssign(scopeCode(s!, sc, sentry, sexception, sfinally), i);
            if (sentry.value !== null) {
                sentry.value = statementSemantic(sentry.value, sc);
                cs.statements!.insert(i, sentry.value);
                i++;
            }
            if (sexception.value !== null)
                sexception.value = statementSemantic(sexception.value, sc);
            if (sexception.value !== null) {
                /* dmd/statementsem.d:339 — `static bool isEmpty(const Statement[] statements)`.
                 * Returns: true if statements[] are empty statements
                 */
                const isEmpty = (statements: readonly (Statement | null)[]): boolean => {
                    for (const s of statements) {
                        const cs = s!.isCompoundStatement();
                        if (cs !== null) {
                            if (!isEmpty(cs.statements!.opSlice()))
                                return false;
                        } else
                            return false;
                    }
                    return true;
                };

                if (sfinally.value === null && isEmpty(cs.statements!.opSlice(i + 1, cs.statements!.length))) {
                } else {
                    /* Rewrite:
                     *      s; s1; s2;
                     * As:
                     *      s;
                     *      try { s1; s2; }
                     *      catch (Throwable __o)
                     *      { sexception; throw __o; }
                     */
                    const a: Statements = new DArray<Statement | null>();
                    a.pushSlice(cs.statements!.opSlice(i + 1, cs.statements!.length));
                    cs.statements!.setDim(i + 1);

                    let _body: Statement = new CompoundStatement(Loc.initial, a);
                    _body = new ScopeStatement(Loc.initial, _body, Loc.initial);

                    const id: Identifier = Identifier.generateId(ds("__o"));

                    let handler: Statement = new PeelStatement(sexception.value);
                    if ((blockExit(sexception.value, sc.func, null) & BE.fallthru) !== 0) {
                        const ts = new ThrowStatement(Loc.initial, new IdentifierExp(Loc.initial, id));
                        ts.internalThrow = true;
                        handler = CompoundStatement.fromStatementList(Loc.initial, handler, ts);
                    }

                    const ctch = new Catch(Loc.initial, getThrowable(), id, handler);
                    ctch.internalCatch = true;
                    const catches: Catches = DArray.from<Catch | null>(ctch);

                    let st: Statement | null = new TryCatchStatement(Loc.initial, _body, catches);
                    if (sfinally.value !== null)
                        st = new TryFinallyStatement(Loc.initial, st, sfinally.value);
                    st = statementSemantic(st, sc);

                    cs.statements!.push(st);
                    break;
                }
            } else if (sfinally.value !== null) {
                // resolved: `if (0 && i + 1 == cs.statements.length)` (dmd/statementsem.d:399) — the
                // `0 &&` short-circuits at compile time, so the `cs.statements.push(sfinally)` arm is
                // dead and only the else arm is emitted (07 §3).
                {
                    /* Rewrite:
                     *      s; s1; s2;
                     * As:
                     *      s; try { s1; s2; } finally { sfinally; }
                     */
                    const a: Statements = new DArray<Statement | null>();
                    a.pushSlice(cs.statements!.opSlice(i + 1, cs.statements!.length));
                    cs.statements!.setDim(i + 1);

                    const _body = new CompoundStatement(Loc.initial, a);
                    let stf: Statement | null = new TryFinallyStatement(Loc.initial, _body, sfinally.value);
                    stf = statementSemantic(stf, sc);
                    cs.statements!.push(stf);
                    break;
                }
            }
            i++;
        }

        /* dmd/statementsem.d:426 — Flatten them in place.
         * `ref Statements statements` is an ALIAS of the container (03 §3.2): no copy.
         */
        const flattenStatements = (statements: Statements): void => {
            for (let i = 0; i < statements.length;) {
                const s = statements.opIndex(i);
                if (s !== null) {
                    const flt = flatten(s, sc);
                    if (flt !== null) {
                        statements.remove(i);
                        statements.insert(i, flt);
                        continue;
                    }
                }
                ++i;
            }
        };

        /* https://issues.dlang.org/show_bug.cgi?id=11653
         * 'semantic' may return another CompoundStatement
         * (eg. CaseRangeStatement), so flatten it here.
         */
        flattenStatements(cs.statements!);

        for (const s of cs.statements!) {
            if (s === null)
                continue;

            const se = s.isErrorStatement();
            if (se !== null) {
                result = se;
                return;
            }
        }

        // resolved: `!IN_LLVM || !cs.isCompoundAsmStatement()` (dmd/statementsem.d:461) — IN_LLVM is
        // ON (07 §1.2), so the disjunction reduces to the second operand.
        if (cs.statements!.length === 1 && cs.isCompoundAsmStatement() === null) {
            result = cs.statements!.opIndex(0);
            return;
        }
        result = cs;
    };

    // dmd/statementsem.d:469.
    const visitUnrolledLoop = (uls: UnrolledLoopStatement): void => {
        //printf("UnrolledLoopStatement::semantic(this = %p, sc = %p)\n", uls, sc);
        const scd: Scope = sc.push();
        scd.sbreak = uls;
        scd.scontinue = uls;

        let serror: Statement | null = null;
        // `foreach (i, ref s; *uls.statements)` — `ref s` writes back into the slot (03 §4); the
        // unused index `i` only feeds the dropped printf, so the loop is an index walk.
        for (let i = 0; i < uls.statements!.length; i++) {
            let s = uls.statements!.opIndex(i);
            if (s !== null) {
                //printf("[%d]: %s\n", i, s.toChars());
                s = statementSemantic(s, scd);
                uls.statements!.opIndexAssign(s, i);
                if (s !== null && serror === null)
                    serror = s.isErrorStatement();
            }
        }

        scd.pop();
        result = serror !== null ? serror : uls;
    };

    // dmd/statementsem.d:492.
    const visitScope = (ss: ScopeStatement): void => {
        //printf("ScopeStatement::semantic(sc = %p)\n", sc);
        if (ss.statement === null) {
            result = ss;
            return;
        }

        const sym = new ScopeDsymbol();
        sym.parent = sc.scopesym;
        sym.endlinnum = ss.endloc.linnum();
        sc = sc.push(sym);

        const a: Statements | null = flatten(ss.statement, sc);
        if (a !== null) {
            ss.statement = new CompoundStatement(ss.loc, a);
        }

        ss.statement = statementSemantic(ss.statement!, sc);
        if (ss.statement !== null) {
            if (ss.statement.isErrorStatement() !== null) {
                sc.pop();
                result = ss.statement;
                return;
            }

            const sentry: { value: Statement | null } = { value: null };
            const sexception: { value: Statement | null } = { value: null };
            const sfinally: { value: Statement | null } = { value: null };
            ss.statement = scopeCode(ss.statement, sc, sentry, sexception, sfinally);
            assert(sentry.value === null);
            assert(sexception.value === null);
            if (sfinally.value !== null) {
                //printf("adding sfinally\n");
                sfinally.value = statementSemantic(sfinally.value, sc);
                ss.statement = CompoundStatement.fromStatementList(ss.loc, ss.statement, sfinally.value);
            }
        }
        sc.pop();
        result = ss;
    };

    // dmd/statementsem.d:539.
    const visitForwarding = (ss: ForwardingStatement): void => {
        assert(ss.sym !== null);
        for (let csc: Scope | null = sc; ss.sym.parent === null; csc = csc!.enclosing) {
            assert(csc !== null);
            ss.sym.parent = csc!.scopesym;
        }
        sc = sc.push(ss.sym);
        sc.sbreak = ss;
        sc.scontinue = ss;
        ss.statement = statementSemantic(ss.statement, sc)!;
        sc = sc.pop()!;
        result = ss.statement;
    };

    // dmd/statementsem.d:555.
    const visitWhile = (ws: WhileStatement): void => {
        /* Rewrite as a for(;condition;) loop
         * https://dlang.org/spec/statement.html#while-statement
         */
        let cond: Expression | null = ws.condition;
        let _body: Statement | null = ws._body;
        if (ws.param !== null) {
            /**
             * If the while loop is of form `while(auto a = exp) { loop_body }`,
             * rewrite to:
             *
             * while(true)
             *     if (auto a = exp)
             *     { loop_body }
             *     else
             *     { break; }
             */
            _body = new IfStatement(ws.loc, ws.param, ws.condition, ws._body, new BreakStatement(ws.loc, null), ws.endloc);
            cond = IntegerExp.createBool(true);
        }
        let s: Statement | null = new ForStatement(ws.loc, null, cond, null, _body, ws.endloc);
        s = statementSemantic(s, sc);
        result = s;
    };

    // dmd/statementsem.d:582 — https://dlang.org/spec/statement.html#do-statement
    const visitDo = (ds_: DoStatement): void => {
        const inLoopSave = sc.inLoop;
        sc.inLoop = true;
        if (ds_._body !== null)
            ds_._body = semanticScope(ds_._body, sc, ds_, ds_, null);
        sc.inLoop = inLoopSave;

        const dotid = ds_.condition!.isDotIdExp();
        if (dotid !== null)
            dotid.noderef = true;

        // check in syntax level
        ds_.condition = checkAssignmentAsCondition(ds_.condition!, sc);

        ds_.condition = expressionSemantic(ds_.condition, sc);
        ds_.condition = resolveProperties(sc, ds_.condition);
        // dmd/statementsem.d:600 — swept: `checkNonAssignmentArrayOp` is live (dmd/arrayop.d:90).
        if (checkNonAssignmentArrayOp(ds_.condition))
            ds_.condition = ErrorExp.get();
        ds_.condition = optimize(ds_.condition, WANTvalue);
        // dmd/statementsem.d:603 — swept: `checkGC` is live (dmd/nogc.d:268).
        ds_.condition = checkGC(ds_.condition, sc);

        ds_.condition = toBoolean(ds_.condition, sc);

        if (ds_.condition.op === EXP.error)
            return setError();
        if (ds_._body !== null && ds_._body.isErrorStatement() !== null) {
            result = ds_._body;
            return;
        }

        result = ds_;
    };

    // dmd/statementsem.d:618 — https://dlang.org/spec/statement.html#for-statement
    const visitFor = (fs: ForStatement): void => {
        //printf("ForStatement::semantic %s\n", fs.toChars());

        if (fs._init !== null) {
            /* Rewrite:
             *  for (auto v1 = i1, v2 = i2; condition; increment) { ... }
             * to:
             *  { auto v1 = i1, v2 = i2; for (; condition; increment) { ... } }
             * then lowered to:
             *  auto v1 = i1;
             *  try {
             *    auto v2 = i2;
             *    try {
             *      for (; condition; increment) { ... }
             *    } finally { v2.~this(); }
             *  } finally { v1.~this(); }
             */
            const ainit: Statements = DArray.from<Statement | null>(fs._init);
            fs._init = null;
            ainit.push(fs);
            let s: Statement | null = new CompoundStatement(fs.loc, ainit);
            s = new ScopeStatement(fs.loc, s, fs.endloc);
            s = statementSemantic(s, sc);
            if (s!.isErrorStatement() === null) {
                const ls = checkLabeledLoop(sc, fs);
                if (ls !== null)
                    ls.gotoTarget = fs;
                fs.relatedLabeled = s;
            }
            result = s;
            return;
        }
        assert(fs._init === null);

        const sym = new ScopeDsymbol();
        sym.parent = sc.scopesym;
        sym.endlinnum = fs.endloc.linnum();
        sc = sc.push(sym);
        sc.inLoop = true;

        if (fs.condition !== null) {
            const dotid = fs.condition.isDotIdExp();
            if (dotid !== null)
                dotid.noderef = true;

            // check in syntax level
            fs.condition = checkAssignmentAsCondition(fs.condition, sc);

            fs.condition = expressionSemantic(fs.condition, sc);
            fs.condition = resolveProperties(sc, fs.condition);
            // dmd/statementsem.d:672 — swept: `checkNonAssignmentArrayOp` is live (dmd/arrayop.d:90).
            if (checkNonAssignmentArrayOp(fs.condition))
                fs.condition = ErrorExp.get();
            fs.condition = optimize(fs.condition, WANTvalue);
            // dmd/statementsem.d:675 — swept: `checkGC` is live (dmd/nogc.d:268).
            fs.condition = checkGC(fs.condition, sc);

            fs.condition = toBoolean(fs.condition, sc);
        }
        if (fs.increment !== null) {
            CommaExp.allow(fs.increment);
            fs.increment = expressionSemantic(fs.increment, sc);
            fs.increment = resolveProperties(sc, fs.increment);
            // @@@DEPRECATED_2.112@@@
            // remove gagging and deprecation() to turn deprecation into an error when
            // deprecation cycle is over
            const olderrors = global.startGagging();
            // dmd/statementsem.d:688 — swept: `discardValue` is live (dmd/sideeffect.d:242 `bool
            // discardValue(Expression e)`, exported by sideeffect.ts with the same signature). The
            // wall's `try`/`finally` gag release is gone with it: it guarded an exit path D does not
            // have, and D's order here is straight-line (discardValue -> endGagging -> deprecation).
            discardValue(fs.increment);
            if (global.endGagging(olderrors))
                deprecation(fs.increment.loc, ds("`%s` has no effect"), toErrMsg(fs.increment));
            // dmd/statementsem.d:691 — swept: `checkNonAssignmentArrayOp` is live (dmd/arrayop.d:90).
            if (checkNonAssignmentArrayOp(fs.increment))
                fs.increment = ErrorExp.get();
            fs.increment = optimize(fs.increment, WANTvalue);
            // dmd/statementsem.d:694 — swept: `checkGC` is live (dmd/nogc.d:268).
            fs.increment = checkGC(fs.increment, sc);
        }

        sc.sbreak = fs;
        sc.scontinue = fs;
        if (fs._body !== null)
            fs._body = semanticNoScope(fs._body, sc);

        sc.pop();

        if ((fs.condition !== null && fs.condition.op === EXP.error) ||
            (fs.increment !== null && fs.increment.op === EXP.error) ||
            (fs._body !== null && fs._body.isErrorStatement() !== null))
            return setError();
        result = fs;
    };

    // dmd/statementsem.d:711 — https://dlang.org/spec/statement.html#foreach-statement
    const visitForeach = (fs: ForeachStatement): void => {
        //printf("ForeachStatement::semantic() %p\n", fs);

        /******
         * dmd/statementsem.d:723 — `static bool checkForArgTypes(ForeachStatement fs)`.
         * Issue error if any of the ForeachTypes were not supplied and could not be inferred.
         * Returns: true if error issued
         */
        const checkForArgTypes = (fs: ForeachStatement): boolean => {
            let result = false;
            for (const p of fs.parameters!) {
                if (p!.type === null) {
                    error(fs.loc, ds("cannot infer type for `foreach` variable `%s`, perhaps set it explicitly"), p!.ident!.toChars());
                    p!.type = Type.terror;
                    result = true;
                }
            }
            return result;
        };

        const loc = fs.loc;                       // Loc: ALIAS-SAFE REGISTER (03 §9.1), plain share
        const dim = fs.parameters!.length;

        fs.func = sc.func;
        if (fs.func!.fes !== null)
            fs.func = fs.func!.fes!.func;

        let vinit: VarDeclaration | null = null;
        fs.aggr = expressionSemantic(fs.aggr!, sc);
        fs.aggr = resolveProperties(sc, fs.aggr);
        fs.aggr = optimize(fs.aggr, WANTvalue);
        if (fs.aggr.op === EXP.error)
            return setError();
        const oaggr: Expression = fs.aggr;     // remember original for error messages
        if (fs.aggr.type !== null && toBasetype(fs.aggr.type).isTypeStruct() !== null &&
            toBasetype(fs.aggr.type).isTypeStruct()!.sym!.dtor !== null &&
            fs.aggr.isTypeExp() === null && !isLvalue(fs.aggr))
        {
            // https://issues.dlang.org/show_bug.cgi?id=14653
            // Extend the life of rvalue aggregate till the end of foreach.
            // dmd/statementsem.d:758 — swept: `copyToTemp` is live (dmd/sideeffect.d:410
            // `VarDeclaration copyToTemp(STC stc, const char[] name, Expression e)`, exported by
            // sideeffect.ts with the same signature).
            vinit = copyToTemp(STC.rvalue, ds("__aggr"), fs.aggr);
            vinit.endlinnum = fs.endloc.linnum();
            dsymbolSemantic(vinit, sc);
            fs.aggr = new VarExp(fs.aggr.loc, vinit);
        }

        /* If aggregate is a vector type, add the .array to make it a static array
         */
        if (fs.aggr.type !== null) {
            const tv = toBasetype(fs.aggr.type).isTypeVector();
            if (tv !== null) {
                const vae = new VectorArrayExp(fs.aggr.loc, fs.aggr);
                vae.type = tv.basetype;
                fs.aggr = vae;
            }
        }

        // D: `Dsymbol sapply = null;` — passed as `out` to inferForeachAggregate and as `ref` to
        // inferApplyArgTypes, so the local IS the box (03 §3.2/§3.3) and every read is `.value`.
        const sapply: { value: Dsymbol | null } = { value: null };  // the inferred opApply() or front() function
        {
            // `ref Expression feaggr` -> box; written back immediately so the error arm below reads
            // the same `fs.aggr` D would (03 §3.2).
            const feaggr: { value: Expression } = { value: fs.aggr };
            const ok = inferForeachAggregate(sc, fs.op === TOK.foreach_, feaggr, sapply);
            fs.aggr = feaggr.value;
            if (!ok) {
                assert(oaggr.type !== null);

                error(fs.loc, ds("invalid `%s` aggregate `%s` of type `%s`"),
                    Token.toCharsValue(fs.op), oaggr.toChars(), oaggr.type!.toPrettyChars());

                const ad = isAggregate(fs.aggr.type!);
                if (ad !== null) {
                    if (fs.op === TOK.foreach_reverse_) {
                        errorSupplemental(fs.loc, ds("`foreach_reverse` works with bidirectional ranges" +
                            " (implementing `back` and `popBack`), aggregates implementing" +
                            " `opApplyReverse`, or the result of an aggregate's `.tupleof` property"));
                        errorSupplemental(fs.loc, ds("https://dlang.org/phobos/std_range_primitives.html#isBidirectionalRange"));
                    } else {
                        errorSupplemental(fs.loc, ds("`foreach` works with input ranges" +
                            " (implementing `front` and `popFront`), aggregates implementing" +
                            " `opApply`, or the result of an aggregate's `.tupleof` property"));
                        errorSupplemental(fs.loc, ds("https://dlang.org/phobos/std_range_primitives.html#isInputRange"));
                    }
                }

                return setError();
            }
        }

        const sapplyOld: Dsymbol | null = sapply.value; // 'sapply' will be NULL if and after 'inferApplyArgTypes' errors

        /* Check for inference errors and apply modifier checks inline */
        if (!inferApplyArgTypes(fs, sc, sapply)) {
            let foundMismatch = false;
            let foreachParamCount = 0;

            if (sapplyOld !== null) {
                const fd = sapplyOld.isFuncDeclaration();
                if (fd !== null) {
                    const fparameters = fd.getParameterList();

                    // ignore overloads, can't determine which non-matching is closest
                    if (fd.overnext === null && fparameters.length() === 1) {
                        // first param should be the callback function
                        const fparam = fparameters.opIndex(0)!;
                        if ((fparam.type!.ty === TY.Tpointer ||
                             fparam.type!.ty === TY.Tdelegate) &&
                            nextOf(fparam.type!)!.isTypeFunction() !== null)
                        {
                            const tf = nextOf(fparam.type!)!.isTypeFunction()!;
                            foreachParamCount = tf.parameterList.length();
                            foundMismatch = true;

                            if (fd.isThis() !== null &&
                                MODmethodConv(fs.aggr.type!.mod, fd.type!.mod) === MATCH.nomatch)
                            {
                                error(fs.aggr.loc, ds("%s method `%s` is not callable using a `%s` foreach aggregate"),
                                    fd.type!.mod === 0 ? ds("mutable") : fd.type!.modToChars(),
                                    fd.toPrettyChars(),
                                    fs.aggr.type!.toChars());
                                errorSupplemental(fd.loc, ds("Consider adding a method type qualifier here"));
                                return setError();
                            }
                        }
                    }
                }
            }

            //printf("dim = %d, parameters.length = %d\n", dim, parameters.length);
            if (foundMismatch && dim !== foreachParamCount) {
                const plural: DString = foreachParamCount > 1 ? ds("s") : ds("");
                error(fs.loc, ds("cannot infer argument types, expected %llu argument%s, not %llu"),
                    BigInt(foreachParamCount), plural, BigInt(dim));
            } else
                error(fs.loc, ds("cannot uniquely infer `foreach` argument types"));

            return setError();
        }

        const tab: Type = toBasetype(fs.aggr.type!);

        if (tab.ty === TY.Ttuple) // don't generate new scope for tuple loops
        {
            let s: Statement | null = makeTupleForeach(sc, false, false, fs, null, false).statement;
            if (vinit !== null)
                s = CompoundStatement.fromStatementList(loc, ExpStatement.fromDsymbol(loc, vinit), s);
            result = statementSemantic(s!, sc);
            return;
        }

        const sym = new ScopeDsymbol();
        sym.parent = sc.scopesym;
        sym.endlinnum = fs.endloc.linnum();
        const sc2: Scope = sc.push(sym);
        sc2.inLoop = true;

        for (const p of fs.parameters!) {
            if ((p!.storageClass & STC.manifest) !== 0n) {
                error(fs.loc, ds("cannot declare `enum` loop variables for non-unrolled foreach"));
            }
            if ((p!.storageClass & STC.alias_) !== 0n) {
                error(fs.loc, ds("cannot declare `alias` loop variables for non-unrolled foreach"));
            }
        }

        // dmd/statementsem.d:887.
        const retError = (): void => {
            sc2.pop();
            result = new ErrorStatement();
        };

        // dmd/statementsem.d:893.
        const rangeError = (): void => {
            error(fs.loc, ds("cannot infer argument types"));
            return retError();
        };

        // dmd/statementsem.d:899.
        const retStmt = (s: Statement | null): void => {
            if (s === null)
                return retError();
            s = statementSemantic(s, sc2);
            sc2.pop();
            result = s;
        };

        let tn: Type | null = null;
        let tnv: Type | null = null;
        // dmd/statementsem.d:910 — `Statement apply()`. Closes over tn/tnv/sapply/tab/vinit/sc2/loc.
        const apply = (): Statement | null => {
            if (checkForArgTypes(fs))
                return null;

            let tfld: TypeFunction | null = null;
            // goto Lget (dmd/statementsem.d:922) / Lget: (dmd/statementsem.d:927) — a forward jump
            // INTO the else-branch's tail, shared by both arms. 06 §4 BAIL form: a zero-parameter
            // named arrow declared before its first use, capturing `tfld` (never positional params).
            const LgetTail = (): void => {
                //printf("tfld = %s\n", tfld.toChars());
                if (tfld!.parameterList.parameters!.length === 1) {
                    const p = tfld!.parameterList.opIndex(0)!;
                    if (p.type !== null && p.type.isTypeDelegate() !== null) {
                        const t = typeSemantic(p.type, loc, sc2);
                        assert(t.ty === TY.Tdelegate);
                        tfld = nextOf(t)!.isTypeFunction();
                    }
                }
            };
            if (sapply.value !== null) {
                const fdapply = sapply.value.isFuncDeclaration();
                if (fdapply !== null) {
                    assert(fdapply.type !== null && fdapply.type.isTypeFunction() !== null);
                    tfld = typeSemantic(fdapply.type, loc, sc2).isTypeFunction();
                    LgetTail();                       // goto Lget;
                } else if (tab.isTypeDelegate() !== null) {
                    tfld = nextOf(tab)!.isTypeFunction();
                    LgetTail();                       // Lget:
                }
            }

            const flde: FuncExp | null = foreachBodyToFunction(sc2, fs, tfld);
            if (flde === null)
                return null;

            // Resolve any forward referenced goto's
            for (const ss of fs.gotos!) {
                const gs = ss!.statement!.isGotoStatement()!;
                if (gs.label!.statement === null) {
                    // 'Promote' it to this scope, and replace with a return
                    fs.cases!.push(gs);
                    ss!.statement = new ReturnStatement(Loc.initial, IntegerExp.fromValue(BigInt(fs.cases!.length + 1)));
                }
            }

            let e: Expression | null = null;
            if (vinit !== null) {
                e = new DeclarationExp(loc, vinit);
                e = expressionSemantic(e, sc2);
                if (e.op === EXP.error)
                    return null;
            }

            let ec: Expression | null;
            switch (tab.ty) {
                case TY.Tarray:
                // `tn!`/`tnv!`: both are assigned on the Tarray/Tsarray path before `apply()` is
                // reached (dmd/statementsem.d:953 / :995), so the `!` marks D's own fault point.
                case TY.Tsarray:   ec = applyArray     (fs, flde, tab, sc2, tn!, tnv!); break;
                case TY.Tdelegate: ec = applyDelegate  (fs, flde, tab, sc2);          break;
                case TY.Taarray:   ec = applyAssocArray(fs, flde, tab);               break;
                default:           ec = applyOpApply   (fs, flde, tab, sc2, sapply.value); break;
            }
            if (ec === null)
                return null;

            e = Expression.combine(e, ec);
            // `e!`: `ec` is non-null above, so `combine` returns non-null; the TS overload is
            // declared nullable, hence the assertion (02 §10.1).
            return loopReturn(e!, fs.cases, loc);
        };

        switch (tab.ty) {
        case TY.Tarray:
        case TY.Tsarray:
            {
                if (checkForArgTypes(fs))
                    return retError();

                if (dim < 1 || dim > 2) {
                    error(fs.loc, ds("only one or two arguments for array `foreach`"));
                    return retError();
                }

                // Finish semantic on all foreach parameter types.
                for (let i = 0; i < dim; i++) {
                    const p = fs.parameters!.opIndex(i)!;
                    p.type = typeSemantic(p.type!, loc, sc2);
                    p.type = addStorageClass(p.type, p.storageClass);
                }

                tn = toBasetype(nextOf(tab)!);

                if (dim === 2) {
                    const tindex = fs.parameters!.opIndex(0)!.type!;
                    if (!isIntegral(tindex)) {
                        error(fs.loc, ds("foreach: index cannot be of non-integral type `%s`"), tindex.toChars());
                        return retError();
                    }
                    /* What cases to deprecate implicit conversions for:
                     *  1. foreach aggregate is a dynamic array
                     *  2. foreach body is lowered to _aApply (see special case below).
                     */
                    const tv = toBasetype(fs.parameters!.opIndex(1)!.type!);
                    if ((tab.isTypeDArray() !== null ||
                         (tn.ty !== tv.ty && isSomeChar(tn.ty) && isSomeChar(tv.ty))) &&
                        implicitConvToType(Type.tsize_t, tindex) === MATCH.nomatch)
                    {
                        let err = true;
                        if (tab.isTypeDArray() !== null) {
                            // check if overflow is possible
                            // `SignExtendedNumber.value` is `uinteger_t` (ulong), so D's `+ 1`
                            // is UNSIGNED 64-bit and wraps (09 §3): re-truncate.
                            const maxLen: bigint = toUint64(intRangeFromType(tindex).imax.value + 1n);
                            const ale = fs.aggr.isArrayLiteralExp();
                            if (ale !== null)
                                err = BigInt(ale.elements!.length) > maxLen;
                            else {
                                const se = fs.aggr.isSliceExp();
                                if (se !== null)
                                    err = !(se.upr !== null && se.upr.isConst() !== 0 && toInteger(se.upr) <= maxLen);
                            }
                        }
                        if (err)
                            deprecation(fs.loc, ds("foreach: loop index implicitly converted from `size_t` to `%s`"),
                                       tindex.toChars());
                    }
                }

                /* Look for special case of parsing char types out of char type
                 * array.
                 */
                if (isSomeChar(tn.ty)) {
                    const i = (dim === 1) ? 0 : 1; // index of value
                    let p = fs.parameters!.opIndex(i)!;
                    tnv = toBasetype(p.type!);
                    if (tnv.ty !== tn.ty && isSomeChar(tnv.ty)) {
                        if ((p.storageClass & STC.ref_) !== 0n) {
                            error(fs.loc, ds("`foreach`: value of UTF conversion cannot be `ref`"));
                            return retError();
                        }
                        if (dim === 2) {
                            p = fs.parameters!.opIndex(0)!;
                            if ((p.storageClass & STC.ref_) !== 0n) {
                                error(fs.loc, ds("`foreach`: key cannot be `ref`"));
                                return retError();
                            }
                        }
                        return retStmt(apply());
                    }
                }

                // Declare the key
                if (dim === 2) {
                    const p = fs.parameters!.opIndex(0)!;
                    fs.key = new VarDeclaration(loc, mutableOf(p.type!), Identifier.generateId(ds("__key")), null);
                    fs.key.storage_class = (fs.key.storage_class | STC.temp | STC.foreach_) as STC;
                    if (fs.key.isReference())
                        fs.key.storage_class = (fs.key.storage_class | STC.nodtor) as STC;

                    if ((p.storageClass & STC.ref_) !== 0n) {
                        if (constConv(fs.key.type!, p.type!) === MATCH.nomatch) {
                            error(fs.loc, ds("key type mismatch, `%s` to `ref %s`"),
                                     fs.key.type!.toChars(), p.type!.toChars());
                            return retError();
                        }
                    }
                    const ta = tab.isTypeSArray();
                    if (ta !== null) {
                        const dimrange: IntRange = getIntRange(ta.dim!);
                        // https://issues.dlang.org/show_bug.cgi?id=12504
                        // `SignExtendedNumber.value` is `uinteger_t` (ulong): D's `- 1` is UNSIGNED
                        // 64-bit and wraps to `ulong.max` when the dim is 0 (09 §3) — re-truncate.
                        dimrange.imax = new SignExtendedNumber(toUint64(dimrange.imax.value - 1n));
                        // `contains` does not mutate its by-value argument: copy elided (03 §9).
                        if (!intRangeFromType(fs.key.type!).contains(dimrange)) {
                            error(fs.loc, ds("index type `%s` cannot cover index range 0..%llu"),
                                     p.type!.toChars(), toInteger(ta.dim!));
                            return retError();
                        }
                        fs.key.range = new IntRange(new SignExtendedNumber(0n), dimrange.imax);
                    }
                }
                // Now declare the value
                {
                    const p = fs.parameters!.opIndex(dim - 1)!;
                    fs.value = new VarDeclaration(loc, p.type, p.ident!, null);
                    fs.value.storage_class = (fs.value.storage_class | STC.foreach_) as STC;
                    fs.value.storage_class =
                        (fs.value.storage_class | (p.storageClass & (STC.scope_ | STC.IOR | STC.TYPECTOR))) as STC;
                    if (fs.value.isReference()) {
                        fs.value.storage_class = (fs.value.storage_class | STC.nodtor) as STC;

                        // dmd/statementsem.d:1110 — UFCS `fs.aggr.checkModifiable(...)` -> receiver
                        // first (04 §6).
                        if (checkModifiable(fs.aggr!, sc2, ModifyFlags.noError) === Modifiable.initialization)
                            fs.value.setInCtorOnly = true;

                        const t = nextOf(tab)!;
                        if (constConv(t, p.type!) === MATCH.nomatch) {
                            error(fs.loc, ds("argument type mismatch, `%s` to `ref %s`"),
                                     t.toChars(), p.type!.toChars());
                            return retError();
                        }
                    }
                }

                /* Convert to a ForStatement
                 *   foreach (key, value; a) body =>
                 *   for (T[] tmp = a[], size_t key; key < tmp.length; ++key)
                 *   { T value = tmp[k]; body }
                 *
                 *   foreach_reverse (key, value; a) body =>
                 *   for (T[] tmp = a[], size_t key = tmp.length; key--; )
                 *   { T value = tmp[k]; body }
                 */
                const id = Identifier.generateId(ds("__r"));
                const ie = new ExpInitializer(loc, new SliceExp(loc, fs.aggr, null, null));
                // `$` on the raw Parameters container is its length (05 §7 opDollar).
                const valueIsRef = fs.parameters!.opIndex(fs.parameters!.length - 1)!.isReference();
                let tmp: VarDeclaration;
                if (fs.aggr.isArrayLiteralExp() !== null && !valueIsRef) {
                    const ale = fs.aggr.isArrayLiteralExp()!;
                    const edim = ale.elements !== null ? ale.elements.length : 0;
                    const telem = fs.parameters!.opIndex(dim - 1)!.type!;

                    // https://issues.dlang.org/show_bug.cgi?id=12936
                    // if telem has been specified explicitly,
                    // converting array literal elements to telem might make it @nogc.
                    // `sarrayOf`'s `dim` is the CTFE size domain -> bigint (09 §8); `edim` is a JS
                    // container length, widened at the boundary (09 §5), never a narrowing.
                    fs.aggr = implicitCastTo(fs.aggr, sc, sarrayOf(telem, BigInt(edim)));
                    if (fs.aggr.op === EXP.error)
                        return retError();

                    // for (T[edim] tmp = a, ...)
                    tmp = new VarDeclaration(loc, fs.aggr.type, id, ie);
                } else {
                    tmp = new VarDeclaration(loc, arrayOf(nextOf(tab)!), id, ie);
                    if (!valueIsRef)
                        tmp.storage_class = (tmp.storage_class | STC.scope_) as STC;
                }
                tmp.storage_class = (tmp.storage_class | STC.temp) as STC;

                let tmp_length: Expression = new DotIdExp(loc, new VarExp(loc, tmp), Id.length);

                if (fs.key === null) {
                    const idkey = Identifier.generateId(ds("__key"));
                    fs.key = new VarDeclaration(loc, Type.tsize_t, idkey, null);
                    fs.key.storage_class = (fs.key.storage_class | STC.temp) as STC;
                } else if (fs.key.type!.ty !== Type.tsize_t.ty) {
                    tmp_length = new CastExp(loc, tmp_length, fs.key.type);
                }
                if (fs.op === TOK.foreach_reverse_)
                    fs.key._init = new ExpInitializer(loc, tmp_length);
                else
                    fs.key._init = new ExpInitializer(loc, new IntegerExp(loc, 0n, fs.key.type!));

                const cs: Statements = new DArray<Statement | null>();
                if (vinit !== null)
                    cs.push(ExpStatement.fromDsymbol(loc, vinit));
                cs.push(ExpStatement.fromDsymbol(loc, tmp));
                cs.push(ExpStatement.fromDsymbol(loc, fs.key));
                const forinit: Statement = new CompoundDeclarationStatement(loc, cs);

                let cond: Expression;
                if (fs.op === TOK.foreach_reverse_) {
                    // key--
                    cond = new PostExp(EXP.minusMinus, loc, new VarExp(loc, fs.key));
                } else {
                    // key < tmp.length
                    cond = new CmpExp(EXP.lessThan, loc, new VarExp(loc, fs.key), tmp_length);
                }

                let increment: Expression | null = null;
                if (fs.op === TOK.foreach_) {
                    // key += 1
                    increment = new AddAssignExp(loc, new VarExp(loc, fs.key), new IntegerExp(loc, 1n, fs.key.type!));
                }

                // T value = tmp[key];
                const indexExp = new IndexExp(loc, new VarExp(loc, tmp), new VarExp(loc, fs.key));
                indexExp.indexIsInBounds = true; // disabling bounds checking in foreach statements.
                fs.value!._init = new ExpInitializer(loc, indexExp);
                const ds_: Statement = ExpStatement.fromDsymbol(loc, fs.value);

                if (dim === 2) {
                    const p = fs.parameters!.opIndex(0)!;
                    if ((p.storageClass & STC.ref_) !== 0n && p.type!.equals(fs.key.type)) {
                        fs.key.range = null;
                        const v = AliasDeclaration.fromDsymbol(loc, p.ident!, fs.key);
                        fs._body = CompoundStatement.fromStatementList(loc, ExpStatement.fromDsymbol(loc, v), fs._body);
                    } else {
                        const ei = new ExpInitializer(loc, new IdentifierExp(loc, fs.key.ident));
                        const v = new VarDeclaration(loc, p.type, p.ident!, ei);
                        v.storage_class = (v.storage_class | STC.foreach_ | (p.storageClass & STC.ref_)) as STC;
                        fs._body = CompoundStatement.fromStatementList(loc, ExpStatement.fromDsymbol(loc, v), fs._body);
                        if (fs.key.range !== null && !p.type!.isMutable()) {
                            /* Limit the range of the key to the specified range
                             */
                            v.range = new IntRange(fs.key.range.imin,
                                fs.key.range.imax.opSub(new SignExtendedNumber(1n)));
                        }
                    }
                }
                fs._body = CompoundStatement.fromStatementList(loc, ds_, fs._body);

                const s: Statement = new ForStatement(loc, forinit, cond, increment, fs._body, fs.endloc);
                const ls = checkLabeledLoop(sc, fs);      // https://issues.dlang.org/show_bug.cgi?id=15450
                if (ls !== null)                          // don't use sc2
                    ls.gotoTarget = s;
                return retStmt(s);
            }
        case TY.Taarray:
            if (fs.op === TOK.foreach_reverse_)
                error(fs.loc, ds("cannot use `foreach_reverse` with an associative array"));
            if (checkForArgTypes(fs))
                return retError();

            if (dim < 1 || dim > 2) {
                error(fs.loc, ds("only one or two arguments for associative array `foreach`"));
                return retError();
            }
            return retStmt(apply());

        case TY.Tclass:
        case TY.Tstruct:
            /* Prefer using opApply, if it exists
             */
            if (sapply.value !== null)
                return retStmt(apply());
            {
                /* Look for range iteration, i.e. the properties
                 * .empty, .popFront, .popBack, .front and .back
                 *    foreach (e; aggr) { ... }
                 * translates to:
                 *    for (auto __r = aggr[]; !__r.empty; __r.popFront()) {
                 *        auto e = __r.front;
                 *        ...
                 *    }
                 */
                const ad: AggregateDeclaration = (tab.ty === TY.Tclass) ?
                    tab.isTypeClass()!.sym! :
                    tab.isTypeStruct()!.sym!;
                let idfront: Identifier | null;
                let idpopFront: Identifier | null;
                if (fs.op === TOK.foreach_) {
                    idfront = Id.Ffront;
                    idpopFront = Id.FpopFront;
                } else {
                    idfront = Id.Fback;
                    idpopFront = Id.FpopBack;
                }
                const sfront = search(ad, Loc.initial, idfront!);
                if (sfront === null)
                    return retStmt(apply());

                /* Generate a temporary __r and initialize it with the aggregate.
                 */
                let r: VarDeclaration;
                let _init: Statement;
                if (vinit !== null && fs.aggr.isVarExp() !== null && fs.aggr.isVarExp()!.var_ === vinit) {
                    r = vinit;
                    _init = ExpStatement.fromDsymbol(loc, vinit);
                } else {
                    // dmd/statementsem.d:1299 — swept: `copyToTemp` is live (dmd/sideeffect.d:410).
                    r = copyToTemp(STC.none, ds("__r"), fs.aggr);
                    dsymbolSemantic(r, sc);
                    _init = ExpStatement.fromDsymbol(loc, r);
                    if (vinit !== null)
                        _init = CompoundStatement.fromStatementList(loc, ExpStatement.fromDsymbol(loc, vinit), _init);
                }

                // !__r.empty
                let e: Expression = new VarExp(loc, r);
                e = new DotIdExp(loc, e, Id.Fempty);
                const condition: Expression = new NotExp(loc, e);

                // __r.idpopFront()
                e = new VarExp(loc, r);
                const increment: Expression = new CallExp(loc, new DotIdExp(loc, e, idpopFront));

                /* Declaration statement for e:
                 *    auto e = __r.idfront;
                 */
                e = new VarExp(loc, r);
                const einit: Expression = new DotIdExp(loc, e, idfront);
                let makeargs: Statement | null = null;
                let forbody: Statement;
                let ignoreRef = false; // If a range returns a non-ref front we ignore ref on foreach

                let tfront: Type | null = null;
                {
                    const fd = sfront.isFuncDeclaration();
                    if (fd !== null) {
                        if (!functionSemantic(fd))
                            return rangeError();
                        tfront = fd.type;
                    } else {
                        const td = sfront.isTemplateDeclaration();
                        if (td !== null) {
                            // dmd/statementsem.d:1332.
                            const f = resolveFuncCall(loc, sc, td, null, tab, new ArgumentList(),
                                FuncResolveFlag.quiet);
                            if (f !== null)
                                tfront = f.type;
                        } else {
                            const d = toAlias(sfront).isDeclaration();
                            if (d !== null) {
                                tfront = d.type;
                            }
                        }
                    }
                }
                if (tfront === null || tfront.ty === TY.Terror)
                    return rangeError();
                {
                    const ftt = toBasetype(tfront).isTypeFunction();
                    if (ftt !== null) {
                        tfront = nextOf(toBasetype(tfront));
                        if (!ftt.isRef) {
                            // .front() does not return a ref. We ignore ref on foreach arg.
                            // see https://issues.dlang.org/show_bug.cgi?id=11934
                            if (needsDestruction(tfront!)) ignoreRef = true;
                        }
                    }
                }
                if (tfront!.ty === TY.Tvoid) {
                    error(fs.loc, ds("`%s.front` is `void` and has no value"), oaggr.toChars());
                    return retError();
                }

                if (dim === 1) {
                    const p = fs.parameters!.opIndex(0)!;
                    const ve = new VarDeclaration(loc, p.type, p.ident!, new ExpInitializer(loc, einit));
                    ve.storage_class = (ve.storage_class | STC.foreach_) as STC;
                    ve.storage_class =
                        (ve.storage_class | (p.storageClass & (STC.scope_ | STC.IOR | STC.TYPECTOR))) as STC;

                    if (ignoreRef)
                        ve.storage_class = (ve.storage_class & ~STC.ref_) as STC;

                    makeargs = ExpStatement.fromDsymbol(loc, ve);
                } else {
                    // dmd/statementsem.d:1371 — swept: `copyToTemp` is live (dmd/sideeffect.d:410).
                    const vd = copyToTemp(STC.ref_, ds("__front"), einit);
                    dsymbolSemantic(vd, sc);
                    makeargs = ExpStatement.fromDsymbol(loc, vd);

                    // Resolve inout qualifier of front type
                    tfront = substWildTo(tfront!, tab.mod);

                    const ve: Expression = new VarExp(loc, vd);
                    ve.type = tfront;

                    const exps: Expressions = DArray.from<Expression | null>(ve);
                    let pos = 0;
                    while (exps.length < dim) {
                        // dmd/statementsem.d:1385.
                        pos = expandAliasThisTuples(exps, pos);
                        if (pos === -1)
                            break;
                    }
                    if (exps.length !== dim) {
                        const plural: DString = exps.length > 1 ? ds("s") : ds("");
                        error(fs.loc, ds("cannot infer argument types, expected %llu argument%s, not %llu"),
                            BigInt(exps.length), plural, BigInt(dim));
                        return retError();
                    }

                    for (let i = 0; i < dim; i++) {
                        const p = fs.parameters!.opIndex(i)!;
                        const exp = exps.opIndex(i)!;
                        // resolved: version (none) printf block (dmd/statementsem.d:1401-1406) -> OFF.
                        if (p.type === null)
                            p.type = exp.type;

                        // D shadows the enclosing `sc` with a local `auto sc = p.storageClass;` — the
                        // port renames it to `stcLocal` (the enclosing `Scope sc` must stay reachable).
                        let stcLocal: STC = p.storageClass;
                        if (ignoreRef) stcLocal = (stcLocal & ~STC.ref_) as STC;
                        p.type = typeSemantic(addStorageClass(p.type!, stcLocal), loc, sc2);
                        if (implicitConvTo(exp, p.type) === MATCH.nomatch) {
                            error(fs.loc, ds("cannot implicitly convert tuple element of type `%s` to variable `%s` of type `%s`"),
                                exp.type!.toChars(), p.toChars(), p.type.toChars());
                            return retError();
                        }

                        const var_ = new VarDeclaration(loc, p.type, p.ident!, new ExpInitializer(loc, exp));
                        var_.storage_class = (var_.storage_class | STC.ctfe | STC.ref_ | STC.foreach_) as STC;
                        makeargs = CompoundStatement.fromStatementList(loc, makeargs, ExpStatement.fromDsymbol(loc, var_));
                    }
                }

                forbody = CompoundStatement.fromStatementList(loc, makeargs, fs._body);

                const s: Statement = new ForStatement(loc, _init, condition, increment, forbody, fs.endloc);
                const ls = checkLabeledLoop(sc, fs);
                if (ls !== null)
                    ls.gotoTarget = s;

                // resolved: version (none) printf block (dmd/statementsem.d:1432-1438) -> OFF.
                return retStmt(s);
            }
        case TY.Tdelegate:
            if (fs.op === TOK.foreach_reverse_)
                error(fs.loc, ds("cannot use `foreach_reverse` with a delegate"));
            return retStmt(apply());
        case TY.Terror:
            return retError();
        default:
            error(fs.loc, ds("`foreach`: `%s` is not an aggregate type"), fs.aggr.type!.toChars());
            return retError();
        }
    };

    // dmd/statementsem.d:1453 — https://dlang.org/spec/statement.html#foreach-range-statement
    const visitForeachRange = (fs: ForeachRangeStatement): void => {
        //printf("ForeachRangeStatement::semantic() %p\n", fs);

        if ((fs.param!.storageClass & STC.manifest) !== 0n) {
            error(fs.loc, ds("cannot declare `enum` loop variables for non-unrolled foreach"));
        }
        if ((fs.param!.storageClass & STC.alias_) !== 0n) {
            error(fs.loc, ds("cannot declare `alias` loop variables for non-unrolled foreach"));
        }

        const loc = fs.loc;                       // Loc: ALIAS-SAFE REGISTER (03 §9.1)
        fs.lwr = expressionSemantic(fs.lwr!, sc);
        fs.lwr = resolveProperties(sc, fs.lwr);
        fs.lwr = optimize(fs.lwr, WANTvalue);
        if (fs.lwr.type === null) {
            error(fs.loc, ds("invalid range lower bound `%s`"), fs.lwr.toChars());
            return setError();
        }

        fs.upr = expressionSemantic(fs.upr!, sc);
        fs.upr = resolveProperties(sc, fs.upr);
        fs.upr = optimize(fs.upr, WANTvalue);
        if (fs.upr.type === null) {
            error(fs.loc, ds("invalid range upper bound `%s`"), fs.upr.toChars());
            return setError();
        }

        if (fs.param!.type !== null) {
            fs.param!.type = typeSemantic(fs.param!.type!, loc, sc);
            fs.param!.type = addStorageClass(fs.param!.type!, fs.param!.storageClass);
            fs.lwr = implicitCastTo(fs.lwr, sc, fs.param!.type!);

            if (implicitConvTo(fs.upr, fs.param!.type!) !== MATCH.nomatch ||
                (fs.param!.storageClass & STC.ref_) !== 0n)
            {
                fs.upr = implicitCastTo(fs.upr, sc, fs.param!.type!);
            } else {
                // See if upr-1 fits in param.type
                let limit: Expression = new MinExp(loc, fs.upr, IntegerExp.literal(1));
                limit = expressionSemantic(limit, sc);
                limit = optimize(limit, WANTvalue);
                if (implicitConvTo(limit, fs.param!.type!) === MATCH.nomatch) {
                    fs.upr = implicitCastTo(fs.upr, sc, fs.param!.type!);
                }
            }
        } else {
            /* Must infer types from lwr and upr
             */
            const tlwr = toBasetype(fs.lwr.type);
            if (tlwr.ty === TY.Tstruct || tlwr.ty === TY.Tclass) {
                /* Just picking the first really isn't good enough.
                 */
                fs.param!.type = fs.lwr.type;
            } else if (fs.lwr.type === fs.upr.type) {
                /* Same logic as CondExp ?lwr:upr
                 */
                fs.param!.type = fs.lwr.type;
            } else {
                // `scope AddExp ea = ...` — `scope` ERASED (04 §8, 03 §8).
                const ea = new AddExp(loc, fs.lwr, fs.upr);
                if (typeCombine(ea, sc) !== null)
                    return setError();
                fs.param!.type = ea.type;
                fs.lwr = ea.e1!;
                fs.upr = ea.e2!;
            }
            fs.param!.type = addStorageClass(fs.param!.type!, fs.param!.storageClass);
        }
        if (fs.param!.type!.ty === TY.Terror || fs.lwr.op === EXP.error || fs.upr.op === EXP.error) {
            return setError();
        }

        /* Convert to a for loop:
         *  foreach (key; lwr .. upr) =>
         *  for (auto key = lwr, auto tmp = upr; key < tmp; ++key)
         *
         *  foreach_reverse (key; lwr .. upr) =>
         *  for (auto tmp = lwr, auto key = upr; key-- > tmp;)
         */
        let ie = new ExpInitializer(loc, (fs.op === TOK.foreach_) ? fs.lwr : fs.upr);
        fs.key = new VarDeclaration(loc, mutableOf(fs.upr.type!), Identifier.generateId(ds("__key")), ie);
        fs.key.storage_class = (fs.key.storage_class | STC.temp) as STC;
        const lower: SignExtendedNumber = getIntRange(fs.lwr).imin.copy();
        const upper: SignExtendedNumber = getIntRange(fs.upr).imax.copy();
        if (lower.opCmp(upper) <= 0) {
            fs.key.range = new IntRange(lower, upper);
        }

        const id = Identifier.generateId(ds("__limit"));
        ie = new ExpInitializer(loc, (fs.op === TOK.foreach_) ? fs.upr : fs.lwr);
        const tmp = new VarDeclaration(loc, fs.upr.type, id, ie);
        tmp.storage_class = (tmp.storage_class | STC.temp) as STC;

        const cs: Statements = new DArray<Statement | null>();
        // Keep order of evaluation as lwr, then upr
        if (fs.op === TOK.foreach_) {
            cs.push(ExpStatement.fromDsymbol(loc, fs.key));
            cs.push(ExpStatement.fromDsymbol(loc, tmp));
        } else {
            cs.push(ExpStatement.fromDsymbol(loc, tmp));
            cs.push(ExpStatement.fromDsymbol(loc, fs.key));
        }
        const forinit: Statement = new CompoundDeclarationStatement(loc, cs);

        let cond: Expression;
        if (fs.op === TOK.foreach_reverse_) {
            cond = new PostExp(EXP.minusMinus, loc, new VarExp(loc, fs.key));
            if (isScalar(fs.param!.type!)) {
                // key-- > tmp
                cond = new CmpExp(EXP.greaterThan, loc, cond, new VarExp(loc, tmp));
            } else {
                // key-- != tmp
                cond = new EqualExp(EXP.notEqual, loc, cond, new VarExp(loc, tmp));
            }
        } else {
            if (isScalar(fs.param!.type!)) {
                // key < tmp
                cond = new CmpExp(EXP.lessThan, loc, new VarExp(loc, fs.key), new VarExp(loc, tmp));
            } else {
                // key != tmp
                cond = new EqualExp(EXP.notEqual, loc, new VarExp(loc, fs.key), new VarExp(loc, tmp));
            }
        }

        let increment: Expression | null = null;
        if (fs.op === TOK.foreach_) {
            // key += 1
            //increment = new AddAssignExp(loc, new VarExp(loc, fs.key), IntegerExp.literal!1);
            increment = new PreExp(EXP.prePlusPlus, loc, new VarExp(loc, fs.key));
        }
        if ((fs.param!.storageClass & STC.ref_) !== 0n && fs.param!.type!.equals(fs.key.type)) {
            fs.key.range = null;
            const v = AliasDeclaration.fromDsymbol(loc, fs.param!.ident!, fs.key);
            fs._body = CompoundStatement.fromStatementList(loc, ExpStatement.fromDsymbol(loc, v), fs._body);
        } else {
            ie = new ExpInitializer(loc, new CastExp(loc, new VarExp(loc, fs.key), fs.param!.type));
            const v = new VarDeclaration(loc, fs.param!.type, fs.param!.ident!, ie);
            v.storage_class = (v.storage_class | STC.temp | STC.foreach_ | (fs.param!.storageClass & STC.ref_)) as STC;
            fs._body = CompoundStatement.fromStatementList(loc, ExpStatement.fromDsymbol(loc, v), fs._body);
            if (fs.key.range !== null && !fs.param!.type!.isMutable()) {
                /* Limit the range of the key to the specified range
                 */
                v.range = new IntRange(fs.key.range.imin, fs.key.range.imax.opSub(new SignExtendedNumber(1n)));
            }
        }
        if ((fs.param!.storageClass & STC.ref_) !== 0n) {
            if (constConv(fs.key.type!, fs.param!.type!) === MATCH.nomatch) {
                error(fs.loc, ds("argument type mismatch, `%s` to `ref %s`"), fs.key.type!.toChars(), fs.param!.type!.toChars());
                return setError();
            }
        }

        const s = new ForStatement(loc, forinit, cond, increment, fs._body, fs.endloc);
        const ls = checkLabeledLoop(sc, fs);
        if (ls !== null)
            ls.gotoTarget = s;
        result = statementSemantic(s, sc);
    };

    // dmd/statementsem.d:1649 — https://dlang.org/spec/statement.html#IfStatement
    const visitIf = (ifs: IfStatement): void => {
        // check in syntax level
        ifs.condition = checkAssignmentAsCondition(ifs.condition!, sc);

        const sym = new ScopeDsymbol();
        sym.parent = sc.scopesym;
        sym.endlinnum = ifs.endloc.linnum();
        const scd: Scope = sc.push(sym);
        if (ifs.param !== null) {
            /* Declare param, which we will set to be the
             * result of condition.
             */
            // Make sure the location of the initializer reflects the condition, not the if statement.
            // (1.43 delta: the ExpInitializer loc moved from `ifs.loc` to `ifs.condition.loc`.)
            const ei = new ExpInitializer(ifs.condition.loc, ifs.condition);
            ifs.match = new VarDeclaration(ifs.loc, ifs.param.type, ifs.param.ident!, ei);
            ifs.match.parent = scd.func;
            ifs.match.storage_class = (ifs.match.storage_class | ifs.param.storageClass) as STC;
            dsymbolSemantic(ifs.match, scd);

            const de = new DeclarationExp(ifs.loc, ifs.match);
            const ve = new VarExp(ifs.loc, ifs.match);
            ifs.condition = new CommaExp(ifs.loc, de, ve);
            ifs.condition = expressionSemantic(ifs.condition, scd);

            if (ifs.match.edtor !== null) {
                let sdtor: Statement = new DtorExpStatement(ifs.loc, ifs.match.edtor, ifs.match);
                sdtor = new ScopeGuardStatement(ifs.loc, TOK.onScopeExit, sdtor);
                ifs.ifbody = CompoundStatement.fromStatementList(ifs.loc, sdtor, ifs.ifbody);
                ifs.match.storage_class = (ifs.match.storage_class | STC.nodtor) as STC;

                // the destructor is always called
                // whether the 'ifbody' is executed or not
                const sdtor2: Statement = new DtorExpStatement(ifs.loc, ifs.match.edtor, ifs.match);
                if (ifs.elsebody !== null)
                    ifs.elsebody = CompoundStatement.fromStatementList(ifs.loc, sdtor2, ifs.elsebody);
                else
                    ifs.elsebody = sdtor2;
            }
        } else {
            const dotid = ifs.condition.isDotIdExp();
            if (dotid !== null)
                dotid.noderef = true;

            ifs.condition = expressionSemantic(ifs.condition, scd);
            ifs.condition = resolveProperties(scd, ifs.condition);
            ifs.condition = addDtorHook(ifs.condition, scd);
        }
        // dmd/statementsem.d:1703 — swept: `checkNonAssignmentArrayOp` is live (dmd/arrayop.d:90).
        if (checkNonAssignmentArrayOp(ifs.condition!))
            ifs.condition = ErrorExp.get();

        // Convert to boolean after declaring param so this works:
        //  if (S param = S()) {}
        // where S is a struct that defines opCast!bool.
        ifs.condition = toBoolean(ifs.condition!, scd);

        // If we can short-circuit evaluate the if statement, don't do the
        // semantic analysis of the skipped code.
        // This feature allows a limited form of conditional compilation.
        ifs.condition = optimize(ifs.condition, WANTvalue);

        // checkGC after optimizing the condition so that
        // compile time constants are reduced.
        // dmd/statementsem.d:1718 — swept: `checkGC` is live (dmd/nogc.d:268). The scope argument is
        // `scd` (the if-statement's own scope), not `sc`, exactly as D spells it.
        ifs.condition = checkGC(ifs.condition, scd);

        // Save 'root' of two branches (then and else) at the point where it forks
        const ctorflow_root: CtorFlow = scd.ctorflow.clone();

        /* Rewrite `if (!__ctfe) A else B` as `if (__ctfe) B else A`
         */
        // `NotExp notExp;` + `(notExp = …) !is null` — the assignment-in-condition hoists to a const
        // and the test becomes an explicit null test (06 §2.6/§2.7).
        const notExp: NotExp | null = ifs.condition!.isNotExp();
        if (ifs.elsebody !== null &&
            notExp !== null &&
            notExp.e1!.isVarExp() !== null &&
            notExp.e1!.isVarExp()!.var_.ident === Id.ctfe)
        {
            ifs.condition = notExp.e1;
            const sbody = ifs.ifbody;
            ifs.ifbody = ifs.elsebody;
            ifs.elsebody = sbody;
        }

        /* Detect `if (__ctfe)`
         */
        if (ifs.isIfCtfeBlock()) {
            const scd2: Scope = scd.push();
            scd2.ctfeBlock = true;
            ifs.ifbody = semanticNoScope(ifs.ifbody!, scd2);
            scd2.pop();
        } else
            ifs.ifbody = semanticNoScope(ifs.ifbody!, scd);
        scd.pop();

        const ctorflow_then: CtorFlow = sc.ctorflow.copy();   // move flow results
        // D struct assignment into a field: the field gets a COPY (03 §1#5). `.copy()` shares the
        // `fieldinit` slice exactly as D's struct copy does (ctorflow.ts `copy()` vs `clone()`).
        sc.ctorflow = ctorflow_root.copy();                    // reset flow analysis back to root
        if (ifs.elsebody !== null)
            ifs.elsebody = semanticScope(ifs.elsebody, sc, null, null, null);

        // Merge 'then' results into 'else' results
        merge(sc, ifs.loc, ctorflow_then);

        ctorflow_then.freeFieldinit();          // free extra copy of the data

        if (ifs.condition!.op === EXP.error ||
            (ifs.ifbody !== null && ifs.ifbody.isErrorStatement() !== null) ||
            (ifs.elsebody !== null && ifs.elsebody.isErrorStatement() !== null))
        {
            return setError();
        }
        result = ifs;
    };

    // dmd/statementsem.d:1769.
    const visitConditional = (cs: ConditionalStatement): void => {
        //printf("ConditionalStatement::semantic()\n");

        // If we can short-circuit evaluate the if statement, don't do the
        // semantic analysis of the skipped code.
        // This feature allows a limited form of conditional compilation.
        // dmd/statementsem.d:1776 — `cs.condition.include(sc)` is UFCS for the free function
        // `int include(Condition, Scope*)` (expressionsem.d:19582), import-aliased to keep it
        // apart from dsymbolsem's `include(Dsymbol, Scope*)`. The callee returns `int`, so the
        // D truthiness test is spelled `!== 0` (09 §9 / 06 §2.5).
        if (conditionInclude(cs.condition!, sc) !== 0) {
            recordConditional(cs, sc);
            const dc: DebugCondition | null = cs.condition!.isDebugCondition();
            if (dc !== null) {
                sc = sc.push();
                sc.debug_ = true;
                cs.ifbody = statementSemantic(cs.ifbody!, sc);
                sc.pop();
            } else
                cs.ifbody = statementSemantic(cs.ifbody!, sc);
            result = cs.ifbody;
        } else {
            recordConditional(cs, sc);
            if (cs.elsebody !== null)
                cs.elsebody = statementSemantic(cs.elsebody, sc);
            result = cs.elsebody;
        }
    };

    // dmd/statementsem.d:1797 — https://dlang.org/spec/statement.html#pragma-statement
    const visitPragma = (ps: PragmaStatement): void => {
        // dropped: the function-local `import dmd.pragmasem : pragmaStmtSemantic;` (:1801) —
        // module-level in TS (01 §3).
        // dmd/statementsem.d:1802.
        if (!pragmaStmtSemantic(ps, sc))
            return setError();

        result = ps._body;
    };

    // dmd/statementsem.d:1808.
    const visitStaticAssert = (s: StaticAssertStatement): void => {
        // dmd/statementsem.d:1810 — swept: `s.sa.semantic2(sc)` is live (dmd/semantic2.d:79 `void
        // semantic2(Dsymbol dsym, Scope* sc)`, exported by semantic2.ts with the same signature; its
        // `visit(StaticAssert)` arm is what runs here). UFCS receiver becomes the first argument (04 §6).
        semantic2(s.sa!, sc);
        if (s.sa!.errors)
            return setError();
    };

    // dmd/statementsem.d:1815 — https://dlang.org/spec/statement.html#switch-statement
    const visitSwitch = (ss: SwitchStatement): void => {
        //printf("SwitchStatement::semantic(%p)\n", ss);
        ss.tryBody = sc.tryBody;
        ss.tryFinally = sc.tryFinally;
        if (ss.cases !== null) {
            result = ss; // already run
            return;
        }

        if (ss.param !== null) {
            /**
             * If the switch statement is of form `switch(auto a = exp) { body }`,
             * rewrite to the following inside it's own scope:
             *
             * auto a = exp
             * switch(a)
             *     { body }
             */
            const statements: Statements = new DArray<Statement | null>();
            const vardecl = new VarDeclaration(ss.param.loc,
                ss.param.type,
                ss.param.ident!,
                new ExpInitializer(ss.condition!.loc, ss.condition),
                ss.param.storageClass);

            statements.push(ExpStatement.fromDsymbol(ss.param.loc, vardecl));

            ss.condition = new VarExp(ss.param.loc, vardecl, false);
            ss.param = null;

            statements.push(ss);

            let s: Statement | null = new CompoundStatement(ss.loc, statements);
            s = new ScopeStatement(ss.loc, s, ss.endloc);
            s = statementSemantic(s, sc);
            result = s;
            return;
        }

        let conditionError = false;
        ss.condition = expressionSemantic(ss.condition!, sc);
        ss.condition = resolveProperties(sc, ss.condition);

        // `Type att = null;` is passed as `ref` to isRecursiveAliasThis -> the local IS the box (03 §3.3).
        const att: { value: Type | null } = { value: null };
        let te: TypeEnum | null = null;
        while (ss.condition!.isErrorExp() === null) {
            // preserve enum type for final switches
            const tenum = ss.condition!.type!.isTypeEnum();
            if (tenum !== null)
                te = tenum;
            if (isString(ss.condition!.type!)) {
                // If it's not an array, cast it to one
                if (ss.condition!.type!.ty !== TY.Tarray) {
                    ss.condition = implicitCastTo(ss.condition!, sc, arrayOf(nextOf(ss.condition!.type!)!));
                }
                ss.condition!.type = constOf(ss.condition!.type!);
                break;
            }
            ss.condition = integralPromotions(ss.condition!, sc);
            if (ss.condition.isErrorExp() === null && isIntegral(ss.condition.type!))
                break;

            const ad = isAggregate(ss.condition.type!);
            if (ad !== null && ad.aliasthis !== null && !isRecursiveAliasThis(att, ss.condition.type!)) {
                const e = resolveAliasThis(sc, ss.condition, true);
                if (e !== null) {
                    ss.condition = e;
                    continue;
                }
            }

            if (ss.condition.isErrorExp() === null) {
                error(ss.loc, ds("`%s` must be of integral or string type, it is a `%s`"),
                    ss.condition.toChars(), ss.condition.type!.toChars());
                conditionError = true;
                break;
            }
        }
        // dmd/statementsem.d:1903 — swept: `checkNonAssignmentArrayOp` is live (dmd/arrayop.d:90).
        if (checkNonAssignmentArrayOp(ss.condition!))
            ss.condition = ErrorExp.get();
        ss.condition = optimize(ss.condition!, WANTvalue);
        // dmd/statementsem.d:1906 — swept: `checkGC` is live (dmd/nogc.d:268).
        ss.condition = checkGC(ss.condition!, sc);
        // 1.43 delta: the condition-error bail moved BEFORE the scope push (1.42 deferred it past the
        // body's semantic), so on a bad condition the body is no longer analyzed and no sc.pop() runs.
        if (conditionError || ss.condition.op === EXP.error)
            return setError();

        let needswitcherror = false;

        ss.lastVar = sc.lastVar;

        sc = sc.push();
        sc.sbreak = ss;
        sc.switchStatement = ss;

        ss.cases = new DArray<CaseStatement | null>();
        const inLoopSave = sc.inLoop;
        sc.inLoop = true;        // BUG: should use Scope::mergeCallSuper() for each case instead
        ss._body = statementSemantic(ss._body!, sc);
        sc.inLoop = inLoopSave;

        if (ss._body !== null && ss._body.isErrorStatement() !== null) {
            sc.pop();
            return setError();
        }

        // Resolve any goto case's with exp
        Lgotocase:
        for (const gcs of ss.gotoCases) {
            if (gcs!.exp === null) {
                error(gcs!.loc, ds("no `case` statement following `goto case;`"));
                sc.pop();
                return setError();
            }

            for (let scx: Scope | null = sc; scx !== null; scx = scx.enclosing) {
                if (scx.switchStatement === null)
                    continue;
                for (const cs of scx.switchStatement.cases!) {
                    // dmd/statementsem.d:1947 — UFCS `cs.exp.equals(gcs.exp)` for the free function
                    // `equals(Expression, Expression)` (expressionsem.d:919), import-aliased to
                    // `expEquals` (04 §6; the tree convention recorded at dsymbolsem.ts:1278).
                    if (expEquals(cs!.exp!, gcs!.exp)) {
                        gcs!.cs = cs;
                        // resolved: version (IN_LLVM) (dmd/statementsem.d:1950) -> ON, body kept.
                        cs!.gototarget = true;
                        continue Lgotocase;
                    }
                }
            }
            error(gcs!.loc, ds("`case %s` not found"), gcs!.exp.toChars());
            sc.pop();
            return setError();
        }

        if (ss.isFinal) {
            const t = ss.condition.type;
            let ds_: Dsymbol | null;
            let ed: EnumDeclaration | null = null;
            if (t !== null && ((ds_ = toDsymbol(t, sc)) !== null))
                ed = ds_.isEnumDeclaration(); // typedef'ed enum
            if (ed === null && te !== null && ((ds_ = toDsymbol(te, sc)) !== null))
                ed = ds_.isEnumDeclaration();

            // Circular references
            // Check if enum semantic analysis is not yet complete
            if (ed !== null && ed.semanticRun < PASS.semantic2done) {
                error(ss.loc, ds("cannot use `final switch` on enum `%s` while it is being defined"), ed.toChars());
                sc.pop();
                return setError();
            }

            if (ed !== null && ss.cases!.length < ed.members!.length) {
                let missingMembers = 0;
                const maxShown = global.params.v.errorSupplementCount();
            Lmembers:
                for (const es of ed.members!) {
                    const em = es!.isEnumMember();
                    if (em !== null) {
                        for (const cs of ss.cases!) {
                            // dmd/statementsem.d:1994 — UFCS `cs.exp.equals(em.value)`.
                            if (expEquals(cs!.exp!, em.value!) || (!isString(cs!.exp!.type!) &&
                                !isString(em.value!.type!) && toInteger(cs!.exp!) === toInteger(em.value!)))
                                continue Lmembers;
                        }
                        if (missingMembers === 0)
                            error(ss.loc, ds("missing cases for `enum` members in `final switch`:"));

                        if (missingMembers < maxShown)
                            errorSupplemental(ss.loc, ds("`%s`"), em.toChars());
                        missingMembers++;
                    }
                }
                if (missingMembers > 0) {
                    if (missingMembers > maxShown)
                        errorSupplemental(ss.loc, ds("... (%d more, -v to show) ..."), missingMembers - maxShown);
                    sc.pop();
                    return setError();
                }
            } else
                needswitcherror = true;
        }

        ss.hasDefault = sc.switchStatement!.sdefault !== null ||
            !(!ss.isFinal || needswitcherror || global.params.useAssert === CHECKENABLE.on ||
              isSafe(sc.func!) || isSaferD(sc.func!));
        if (!ss.hasDefault) {
            if (!ss.isFinal && (ss._body === null || ss._body.isErrorStatement() === null) && !sc.inCfile)
                error(ss.loc, ds("`switch` statement without a `default`; use `final switch` or add `default: assert(0);` or add `default: break;`"));

            // Generate runtime error if the default is hit
            const a: Statements = new DArray<Statement | null>();
            let cs: CompoundStatement;
            let s: Statement;

            if (sc.inCfile) {
                s = new BreakStatement(ss.loc, null);   // default for C is `default: break;`
            } else if (!sc.needsCodegen()) {
                // something for the interpreter to deal with
                s = new ExpStatement(ss.loc, new AssertExp(ss.loc, IntegerExp.literal(0)));
            } else if (global.params.useSwitchError === CHECKENABLE.on &&
                global.params.checkAction !== CHECKACTION.halt)
            {
                if (global.params.checkAction === CHECKACTION.C) {
                    /* Rewrite as an assert(0) and let e2ir generate
                     * the call to the C assert failure function
                     */
                    s = new ExpStatement(ss.loc, new AssertExp(ss.loc, IntegerExp.literal(0)));
                } else {
                    // dmd/statementsem.d:2051 — `*sc` is a `ref Scope` parameter: alias, no copy
                    // (03 §3.2).
                    if (!verifyHookExist(ss.loc, sc, Id.__switch_error!, ds("generating assert messages")))
                        return setError();

                    let sl: Expression = new IdentifierExp(ss.loc, Id.empty);
                    sl = new DotIdExp(ss.loc, sl, Id.object);
                    sl = new DotIdExp(ss.loc, sl, Id.__switch_error);

                    const args: Expressions = new DArray<Expression | null>(2);
                    // `ss.loc.filename.toDString()` — toDString is the identity pass in djs (08 §11);
                    // StringExp's payload slot is a code-unit array, so the bytes are copied into one.
                    args.opIndexAssign(new StringExp(ss.loc, Array.from(toDString(ss.loc.filename()) ?? [])), 0);
                    args.opIndexAssign(IntegerExp.fromValue(BigInt(ss.loc.linnum())), 1);

                    sl = new CallExp(ss.loc, sl, args);
                    sl = expressionSemantic(sl, sc);

                    s = new SwitchErrorStatement(ss.loc, sl);
                }
            } else
                s = new ExpStatement(ss.loc, new HaltExp(ss.loc));

            a.reserve(2);
            sc.switchStatement!.sdefault = new DefaultStatement(ss.loc, s);
            a.push(ss._body);
            if ((blockExit(ss._body, sc.func, null) & BE.fallthru) !== 0)
                a.push(new BreakStatement(Loc.initial, null));
            a.push(sc.switchStatement!.sdefault);
            cs = new CompoundStatement(ss.loc, a);
            ss._body = cs;
        }

        if (!sc.inCfile && checkLabelSwitchStatement(ss)) {
            sc.pop();
            return setError();
        }

        // resolved: version (IN_LLVM) (dmd/statementsem.d:2087-2098) -> ON, body kept.
        /* hasGotoDefault is set by GotoDefaultStatement.semantic
         * at which point sdefault may still be null, therefore
         * set sdefault.gototarget here.
         */
        if (ss.hasGotoDefault) {
            assert(ss.sdefault !== null);
            ss.sdefault.gototarget = true;
        }

        if (!(isString(ss.condition!.type!) && sc.needsCodegen())) {
            sc.pop();
            result = ss;
            return;
        }

        // Transform a switch with string labels into a switch with integer labels.

        // The integer value of each case corresponds to the index of each label
        // string in the sorted array of label strings.

        // The value of the integer condition is obtained by calling the druntime template
        // switch(object.__switch(cond, options...)) {0: {...}, 1: {...}, ...}

        // We sort a copy of the array of labels because we want to do a binary search in object.__switch,
        // without modifying the order of the case blocks here in the compiler.

        // dmd/statementsem.d:2118.
        if (!verifyHookExist(ss.loc, sc, Id.__switch!, ds("switch cases on strings")))
            return setError();

        let numcases = 0;
        if (ss.cases !== null)
            numcases = ss.cases.length;

        for (let i = 0; i < numcases; i++) {
            const cs = ss.cases!.opIndex(i)!;
            cs.index = i;
        }

        // Make a copy of all the cases so that qsort doesn't scramble the actual
        // data we pass to codegen (the order of the cases in the switch).
        const csCopy: CaseStatements = ss.cases!.copy();     // shallow container clone (08 §2.3)

        if (numcases !== 0) {
            /* dmd/statementsem.d:2137 — `static int sort_compare(in CaseStatement* x, in CaseStatement* y)`.
             * `in ... *` is a read-only alias of the element (03 §3.4/§7.2), so the port takes the
             * element references directly; `@trusted` erased (04 §8).
             */
            const sort_compare = (x: CaseStatement | null, y: CaseStatement | null): number => {
                const se1 = x!.exp!.isStringExp();
                const se2 = y!.exp!.isStringExp();
                return (se1 !== null && se2 !== null) ? se1.compare(se2) : 0;
            };
            // Sort cases for efficient lookup
            csCopy.sort(sort_compare);
        }

        // The actual lowering
        const arguments_: Expressions = new DArray<Expression | null>();
        arguments_.push(ss.condition);


        // The type & label no.
        const compileTimeArgs: Objects = DArray.from<RootObject | null>(new TypeExp(ss.loc, nextOf(ss.condition!.type!)));

        // The switch labels
        for (const caseString of csCopy) {
            compileTimeArgs.push(caseString!.exp);
        }

        let sl: Expression = new IdentifierExp(ss.loc, Id.empty);
        sl = new DotIdExp(ss.loc, sl, Id.object);
        sl = DotTemplateInstanceExp.fromName(ss.loc, sl, Id.__switch, compileTimeArgs);

        sl = new CallExp(ss.loc, sl, arguments_);
        sl = expressionSemantic(sl, sc);
        ss.condition = sl;

        let i = 0;
        for (const c of csCopy) {
            ss.cases!.opIndex(c!.index)!.exp = IntegerExp.fromValue(BigInt(i++));
        }

        //printf("%s\n", ss._body.toChars());
        statementSemantic(ss, sc);

        sc.pop();
        result = ss;
    };

    // dmd/statementsem.d:2182.
    const visitCase = (cs: CaseStatement): void => {
        const sw: SwitchStatement | null = sc.switchStatement;
        let errors = false;

        //printf("CaseStatement::semantic() %s\n", toChars());
        sc = sc.startCTFE();
        cs.exp = expressionSemantic(cs.exp!, sc);
        cs.exp = resolveProperties(sc, cs.exp);
        // The `!` is a NARROWING artifact: endCTFE()/pop() return `Scope | null`, and a pushed CTFE
        // scope always has an enclosing one.
        sc = sc.endCTFE()!;

        if (sw !== null) {
            const initialExp: Expression = cs.exp;

            // The switch'ed value has errors and doesn't provide the actual type
            // Omit the cast to enable further semantic (exluding the check for matching types)
            if (sw.condition!.type !== null && sw.condition!.type.isTypeError() === null)
                cs.exp = implicitCastTo(cs.exp!, sc, sw.condition!.type);
            cs.exp = optimize(cs.exp!, WANTvalue | WANTexpand);

            let e: Expression = cs.exp;
            // Remove all the casts the user and/or implicitCastTo may introduce
            // otherwise we'd sometimes fail the check below.
            while (e.isCastExp() !== null)
                e = e.isCastExp()!.e1!;

            // goto L1 (dmd/statementsem.d:2253) — the `L1:` label at :2267 is reached BOTH by
            // fall-through and by this jump, so it takes the 06 §4.1 SKIP FLAG form: every statement
            // between the jump site and the label is gated on `!gotoL1`; the tail stays un-gated.
            let gotoL1 = false;

            /* This is where variables are allowed as case expressions.
            */
            const ve = e.isVarExp();
            if (ve !== null) {
                const v = ve.var_.isVarDeclaration();
                const t = toBasetype(cs.exp!.type!);
                if (v !== null && (isIntegral(t) || t.ty === TY.Tclass)) {
                    /* Flag that we need to do special code generation
                    * for this, i.e. generate a sequence of if-then-else
                    */
                    sw.hasVars = true;

                    /* TODO check if v can be uninitialized at that point.
                    */
                    if (!v.isConst() && !v.isImmutable()) {
                        error(cs.loc, ds("`case` variables have to be `const` or `immutable`"));
                    }

                    if (sw.isFinal) {
                        error(cs.loc, ds("`case` variables not allowed in `final switch` statements"));
                        errors = true;
                    }

                    /* Find the outermost scope `scx` that set `sw`.
                    * Then search scope `scx` for a declaration of `v`.
                    */
                    for (let scx: Scope | null = sc; scx !== null; scx = scx.enclosing) {
                        if (scx.enclosing !== null && scx.enclosing.switchStatement === sw)
                            continue;
                        assert(scx.switchStatement === sw);

                        const pscopesym: { value: Dsymbol | null } = { value: null };
                        if (searchScope(scx, cs.exp!.loc, v.ident!, pscopesym) === null) {
                            error(cs.loc, ds("`case` variable `%s` declared at %s cannot be declared in `switch` body"),
                                v.toChars(), v.loc.toChars());
                            errors = true;
                        }
                        break;
                    }
                    gotoL1 = true;                     // goto L1;
                }
            } else {
                cs.exp = ctfeInterpret(cs.exp!);
            }

            if (!gotoL1) {
                // dmd/statementsem.d:2259 — UFCS `cs.exp.toStringExp()`.
                const se = toStringExp(cs.exp!);
                if (se !== null)
                    cs.exp = se;
                else if (cs.exp!.isIntegerExp() === null && cs.exp!.isErrorExp() === null) {
                    error(cs.loc, ds("`case` expression must be a compile-time `string` or an integral constant, not `%s`"), cs.exp!.toChars());
                    errors = true;
                }
            }

            // L1: — the shared tail, reached by fall-through AND by the jump above (un-gated).
            // // Don't check other cases if this has errors
            if (cs.exp!.isErrorExp() === null)
            for (const cs2 of sw.cases!) {
                //printf("comparing '%s' with '%s'\n", exp.toChars(), cs.exp.toChars());
                // dmd/statementsem.d:2273 — UFCS `cs2.exp.equals(cs.exp)`.
                if (expEquals(cs2!.exp!, cs.exp!)) {
                    // https://issues.dlang.org/show_bug.cgi?id=15909
                    error(cs.loc, ds("duplicate `case %s` in `switch` statement"), initialExp.toChars());
                    errors = true;
                    break;
                }
            }

            sw.cases!.push(cs);

            // Resolve any goto case's with no exp to this case statement
            for (let i = 0; i < sw.gotoCases.length;) {
                const gcs = sw.gotoCases.opIndex(i)!;
                if (gcs.exp === null) {
                    gcs.cs = cs;
                    sw.gotoCases.remove(i); // remove from array
                    continue;
                }
                i++;
            }

            if (sc.switchStatement!.tryFinally !== sc.tryFinally) {
                error(cs.loc, ds("`switch` and `case` are in different `finally` blocks"));
                errors = true;
            }
            if (sc.switchStatement!.tryBody !== sc.tryBody) {
                error(cs.loc, ds("case cannot be in different `try` block level from `switch`"));
                errors = true;
            }
        } else {
            error(cs.loc, ds("`case` not in `switch` statement"));
            errors = true;
        }

        sc.ctorflow.orCSX(CSX.label);
        cs.statement = statementSemantic(cs.statement!, sc);
        if (cs.statement!.isErrorStatement() !== null) {
            result = cs.statement;
            return;
        }
        if (errors || cs.exp!.op === EXP.error)
            return setError();

        cs.lastVar = sc.lastVar;
        result = cs;
    };

    // dmd/statementsem.d:2328.
    const visitCaseRange = (crs: CaseRangeStatement): void => {
        const sw: SwitchStatement | null = sc.switchStatement;
        if (sw === null) {
            error(crs.loc, ds("case range not in `switch` statement"));
            return setError();
        }

        //printf("CaseRangeStatement::semantic() %s\n", toChars());
        let errors = false;
        if (sw.isFinal) {
            error(crs.loc, ds("case ranges not allowed in `final switch`"));
            errors = true;
        }

        sc = sc.startCTFE();
        crs.first = expressionSemantic(crs.first!, sc);
        crs.first = resolveProperties(sc, crs.first);
        sc = sc.endCTFE()!;
        crs.first = implicitCastTo(crs.first!, sc, sw.condition!.type!);
        crs.first = ctfeInterpret(crs.first!);

        sc = sc.startCTFE();
        crs.last_ = expressionSemantic(crs.last_!, sc);   // ported: D field `last` -> `last_`
        crs.last_ = resolveProperties(sc, crs.last_);
        sc = sc.endCTFE()!;
        crs.last_ = implicitCastTo(crs.last_!, sc, sw.condition!.type!);
        crs.last_ = ctfeInterpret(crs.last_!);

        if (crs.first!.op === EXP.error || crs.last_!.op === EXP.error || errors) {
            if (crs.statement !== null)
                statementSemantic(crs.statement, sc);
            return setError();
        }

        // `uinteger_t` -> bigint carrier (09 §1); the signed compare below reads the SIGNED carrier.
        const fval: bigint = toInteger(crs.first!);
        let lval: bigint = toInteger(crs.last_!);
        if ((isUnsigned(crs.first!.type!) && fval > lval) ||
            (!isUnsigned(crs.first!.type!) && toInt64(fval) > toInt64(lval)))
        {
            error(crs.loc, ds("first `case %s` is greater than last `case %s`"), crs.first!.toChars(), crs.last_!.toChars());
            errors = true;
            lval = fval;
        }

        if (lval - fval > 256n) {
            error(crs.loc, ds("had %llu cases which is more than 257 cases in case range"), 1n + lval - fval);
            errors = true;
            lval = fval + 256n;
        }

        // If the first and last values aren't integer types, then the toInteger()
        // call above would have resulted in an error.
        // (1.43 delta: this guard is new.)
        if (!isIntegral(crs.first!.type!) || !isIntegral(crs.last_!.type!)) {
            errors = true;
        }

        if (errors)
            return setError();

        /* This works by replacing the CaseRange with an array of Case's.
         *
         * case a: .. case b: s;
         *    =>
         * case a:
         *   [...]
         * case b:
         *   s;
         */

        const statements: Statements = new DArray<Statement | null>();
        // D declares `uinteger_t i` (statementsem.d:2403), so BOTH `lval + 1` and `i++` are 64-bit
        // ops that WRAP; bigint does not (09 §3) — re-truncate each. `toInt64` keeps the file's
        // signed-normalized carrier: two's-complement `+ 1` is the same bit operation in either
        // interpretation, and the `!==` tests are interpretation-independent, so this reproduces
        // D's `ulong.max + 1 == 0` termination exactly.
        for (let i = fval; i !== toInt64(lval + 1n); i = toInt64(i + 1n)) {
            let s: Statement | null = crs.statement;
            if (i !== lval) // if not last case
                s = new ExpStatement(crs.loc, null);
            const e: Expression = new IntegerExp(crs.loc, i, crs.first!.type!);
            const cs: Statement = new CaseStatement(crs.loc, e, s);
            statements.push(cs);
        }
        let s: Statement | null = new CompoundStatement(crs.loc, statements);
        sc.ctorflow.orCSX(CSX.label);
        s = statementSemantic(s, sc);
        result = s;
    };

    // dmd/statementsem.d:2418.
    const visitDefault = (ds_: DefaultStatement): void => {
        //printf("DefaultStatement::semantic()\n");
        let errors = false;
        if (sc.switchStatement !== null) {
            if (sc.switchStatement.sdefault !== null) {
                error(ds_.loc, ds("`switch` statement already has a default"));
                errors = true;
            }
            sc.switchStatement.sdefault = ds_;

            if (sc.switchStatement.tryFinally !== sc.tryFinally) {
                error(ds_.loc, ds("`switch` and `default` are in different `finally` blocks"));
                errors = true;
            }
            if (sc.switchStatement.tryBody !== sc.tryBody) {
                error(ds_.loc, ds("default cannot be in different `try` block level from `switch`"));
                errors = true;
            }
            if (sc.switchStatement.isFinal) {
                error(ds_.loc, ds("`default` statement not allowed in `final switch` statement"));
                errors = true;
            }
        } else {
            error(ds_.loc, ds("`default` not in `switch` statement"));
            errors = true;
        }

        sc.ctorflow.orCSX(CSX.label);
        ds_.statement = statementSemantic(ds_.statement!, sc);
        if (errors || ds_.statement!.isErrorStatement() !== null)
            return setError();

        ds_.lastVar = sc.lastVar;
        result = ds_;
    };

    // dmd/statementsem.d:2462 — https://dlang.org/spec/statement.html#goto-statement
    const visitGotoDefault = (gds: GotoDefaultStatement): void => {
        gds.sw = sc.switchStatement;
        if (gds.sw === null) {
            error(gds.loc, ds("`goto default` not in `switch` statement"));
            return setError();
        }
        if (gds.sw.isFinal) {
            error(gds.loc, ds("`goto default` not allowed in `final switch` statement"));
            return setError();
        }

        // resolved: version (IN_LLVM) (dmd/statementsem.d:2479) -> ON, body kept.
        gds.sw.hasGotoDefault = true;

        result = gds;
    };

    // dmd/statementsem.d:2487 — https://dlang.org/spec/statement.html#goto-statement
    const visitGotoCase = (gcs: GotoCaseStatement): void => {
        if (sc.switchStatement === null) {
            error(gcs.loc, ds("`goto case` not in `switch` statement"));
            return setError();
        }

        // resolved: version (IN_LLVM) (dmd/statementsem.d:2498) -> ON, body kept.
        gcs.sw = sc.switchStatement;

        if (gcs.exp !== null) {
            gcs.exp = expressionSemantic(gcs.exp, sc);
            gcs.exp = implicitCastTo(gcs.exp, sc, sc.switchStatement.condition!.type!);
            gcs.exp = optimize(gcs.exp, WANTvalue);
            if (gcs.exp.op === EXP.error)
                return setError();
        }

        sc.switchStatement.gotoCases.push(gcs);
        result = gcs;
    };

    // dmd/statementsem.d:2516 — https://dlang.org/spec/statement.html#return-statement
    const visitReturn = (rs: ReturnStatement): void => {
        //printf("ReturnStatement.dsymbolSemantic() %s\n", toChars(rs));

        let fd: FuncDeclaration = sc.parent!.isFuncDeclaration()!;

        if (fd.fes !== null) {
            rs.fesFunc = fd;                 // 1.43 delta: new assignment
            fd = fd.fes.func!; // fd is now function enclosing foreach
        }

        const tf: TypeFunction | null = fd.type!.isTypeFunction();

        if (rs.exp !== null && rs.exp.isVarExp() !== null && rs.exp.isVarExp()!.var_ === fd.vresult) {
            // return vresult;
            if (sc.fes !== null) {
                assert(rs.caseDim === 0);
                sc.fes.cases!.push(rs);
                result = new ReturnStatement(Loc.initial, IntegerExp.fromValue(BigInt(sc.fes.cases!.length + 1)));
                return;
            }
            if (fd.returnLabel !== null) {
                const gs = new GotoStatement(rs.loc, Id.returnLabel);
                gs.label = fd.returnLabel;
                result = gs;
                return;
            }

            if (fd.returns === null)
                fd.returns = new DArray<ReturnStatement | null>();
            fd.returns.push(rs);
            result = rs;
            return;
        }

        let tret: Type | null = tf!.next;
        let tbret: Type | null = tret !== null ? toBasetype(tret) : null;

        const inferRef: boolean = tf!.isRef && (fd.storage_class & STC.auto_) !== 0n;
        let e0: Expression | null = null;

        let errors = false;
        if (sc.contract !== Contract.none) {
            error(rs.loc, ds("`return` statements cannot be in contracts"));
            errors = true;
        }
        if (sc.scopeGuard !== null) {
            // @@@DEPRECATED_2.112@@@
            // Deprecated in 2.100, transform into an error in 2.112
            if (sc.scopeGuard.tok === TOK.onScopeFailure) {
                deprecation(rs.loc, ds("`return` statements cannot be in `scope(failure)` bodies."));
                deprecationSupplemental(rs.loc, ds("Use try-catch blocks for this purpose"));
            } else {
                error(rs.loc, ds("`return` statements cannot be in `%s` bodies"), Token.toCharsValue(sc.scopeGuard.tok));
                errors = true;
            }
        }
        if (sc.tryFinally !== null) {
            error(rs.loc, ds("`return` statements cannot be in `finally` bodies"));
            errors = true;
        }

        if (fd.isCtorDeclaration() !== null) {
            // Constructors implicitly do:
            //      return this;
            const ctorReturn = new ThisExp(Loc.initial);
            ctorReturn.type = tret;

            // dmd/statementsem.d:2598.
            const isConstructorCall = (e: Expression): boolean => {
                const ce = e.isCallExp();
                if (ce === null)
                    return false;

                const dve = ce.e1!.isDotVarExp();
                if (dve === null)
                    return false;

                return dve.var_.isThis() !== null;
            };

            if (rs.exp !== null) {
                rs.exp = expressionSemantic(rs.exp, sc);

                if (rs.exp.type!.ty !== TY.Tvoid && !isConstructorCall(rs.exp)) {

                    error(rs.loc, ds("can only return void expression, `this` call or `super` call from constructor"));
                    errors = true;
                    rs.exp = ErrorExp.get();
                } else {
                    rs.exp = expressionSemantic(new CommaExp(rs.loc, rs.exp, ctorReturn), sc);
                }
            } else {
                rs.exp = ctorReturn;
            }
        } else if (rs.exp !== null) {
            fd.hasMultipleReturnExp = fd.hasReturnExp;
            fd.hasReturnExp = true;

            const fld: FuncLiteralDeclaration | null = fd.isFuncLiteralDeclaration();
            if (tret !== null)
                rs.exp = inferType(rs.exp, tret);
            else if (fld !== null && fld.treq !== null)
                rs.exp = inferType(rs.exp, nextOf(nextOf(fld.treq)!)!);

            rs.exp = expressionSemantic(rs.exp, sc);
            // dmd/statementsem.d:2644 — `rs.exp = rs.exp.arrayFuncConv(sc);`
            rs.exp = arrayFuncConv(rs.exp, sc);

            // If we're returning by ref, allow the expression to be `shared`
            const returnSharedRef: boolean = tf!.isRef && (fd.inferRetType || tret!.isShared());
            // dmd/statementsem.d:2647 — UFCS `rs.exp.checkSharedAccess(sc, returnSharedRef)`; D
            // discards the `bool` result.
            checkSharedAccess(rs.exp!, sc, returnSharedRef);

            // for static alias this: https://issues.dlang.org/show_bug.cgi?id=17684
            if (rs.exp!.isTypeExp() !== null)
                rs.exp = resolveAliasThis(sc, rs.exp!);

            rs.exp = resolveProperties(sc, rs.exp!);
            // 1.43 delta: 1.42's `Expression.checkType()` returned TRUE on error; 1.43's free function
            // `hasValidType` returns TRUE on VALID, and the call site gained the `!`. Both the polarity
            // and the free-function form are carried here — dropping the `!` inverts the error path.
            if (!hasValidType(rs.exp))
                rs.exp = ErrorExp.get();
            {
                const f = isFuncAddress(rs.exp!);
                if (f !== null) {
                    if (fd.inferRetType && checkForwardRef(f, rs.exp!.loc))
                        rs.exp = ErrorExp.get();
                }
            }
            // dmd/statementsem.d:2661 — swept: `checkNonAssignmentArrayOp` is live (dmd/arrayop.d:90).
            if (checkNonAssignmentArrayOp(rs.exp!))
                rs.exp = ErrorExp.get();

            if (fd.ident === Id.apply && rs.exp!.isConst() !== 0 && toInteger(rs.exp!) !== 0n) {
                // @@@DEPRECATED_2.121
                // uncomment ErrorExp and call `error`
                deprecation(rs.exp!.loc, ds("cannot return non-zero compile-time value from `opApply`"));
                deprecationSupplemental(rs.exp!.loc, ds("Any non-zero value must be the result of calling its delegate"));
                //rs.exp = ErrorExp.get();
            }

            // Extract side-effect part
            // `out Expression e0` -> a one-slot box, written back into the local (03 §3.3).
            const e0Box: { value: Expression | null } = { value: e0 };
            rs.exp = Expression.extractLast(rs.exp!, e0Box);
            e0 = e0Box.value;
            if (rs.exp!.isCallExp() !== null)
                rs.exp = valueNoDtor(rs.exp!);

            /* Void-return function can have void / noreturn typed expression
             * on return statement.
             */
            const texp: Type = rs.exp!.type!;
            const convToVoid: boolean = texp.ty === TY.Tvoid || texp.isTypeNoreturn() !== null;

            if ((tbret !== null && tbret.ty === TY.Tvoid) || convToVoid) {
                if (!convToVoid && texp.isTypeError() === null) {
                    error(rs.loc, ds("cannot return non-void from `void` function"));
                    errors = true;
                    rs.exp = new CastExp(rs.loc, rs.exp, Type.tvoid);
                    rs.exp = expressionSemantic(rs.exp, sc);   // narrowing: CastExp is non-null
                }

                // https://issues.dlang.org/show_bug.cgi?id=23063
                rs.exp = checkNoreturnVarAccess(rs.exp!);

                // @@@DEPRECATED_2.111@@@
                const olderrors = global.startGagging();
                // uncomment to turn deprecation into an error when
                // deprecation cycle is over
                // dmd/statementsem.d:2701 — swept: `discardValue` is live (dmd/sideeffect.d:242).
                // The wall's `try`/`finally` gag release is gone with it: it guarded an exit path D
                // does not have, and D's order here is straight-line.
                if (discardValue(rs.exp!)) {
                    //errors = true;
                }
                if (global.endGagging(olderrors))
                    deprecation(rs.exp!.loc, ds("`%s` has no effect"), toErrMsg(rs.exp!));

                /* Replace:
                 *      return exp;
                 * with:
                 *      exp; return;
                 */
                e0 = Expression.combine(e0, rs.exp);
                rs.exp = null;
            }
            if (e0 !== null) {
                e0 = optimize(e0, WANTvalue);
                // dmd/statementsem.d:2719 — swept: `checkGC` is live (dmd/nogc.d:268).
                e0 = checkGC(e0, sc);
            }
        }

        if (rs.exp !== null) {
            if (fd.inferRetType) // infer return type
            {
                if (tret === null) {
                    tf!.next = rs.exp.type;
                } else if (tret.isTypeError() === null && !rs.exp.type!.equals(tret)) {
                    const m1: MATCH = implicitConvToType(rs.exp.type!, tret);
                    const m2: MATCH = implicitConvToType(tret, rs.exp.type!);
                    //printf("exp.type = %s m2<-->m1 tret %s\n", exp.type.toChars(), tret.toChars());
                    //printf("m1 = %d, m2 = %d\n", m1, m2);

                    if (m1 !== MATCH.nomatch && m2 !== MATCH.nomatch) {
                    } else if (m1 === MATCH.nomatch && m2 !== MATCH.nomatch)
                        tf!.next = rs.exp.type;
                    else if (m1 !== MATCH.nomatch && m2 === MATCH.nomatch) {
                    } else if (rs.exp.isErrorExp() === null) {
                        error(rs.loc, ds("expected return type of `%s`, not `%s`:"),
                                 tret.toChars(),
                                 rs.exp.type!.toChars());
                        errorSupplemental((fd.returns !== null) ? fd.returns.opIndex(0)!.loc : fd.loc,
                                          ds("Return type of `%s` inferred here."),
                                          tret.toChars());

                        errors = true;
                        tf!.next = Type.terror;
                    }
                }

                tret = tf!.next;
                tbret = toBasetype(tret!);
            }

            if (inferRef) // deduce 'auto ref'
            {
                /* Determine "refness" of function return:
                 * if it's an lvalue, return by ref, else return by value
                 * https://dlang.org/spec/function.html#auto-ref-functions
                 */

                // dmd/statementsem.d:2771 — `scope void delegate() supplemental` -> a closure param
                // (04 §4.1); `scope` erased.
                const turnOffRef = (supplemental: () => void): void => {
                    tf!.isRef = false;    // return by value
                    tf!.isReturn = false; // ignore 'return' attribute, whether explicit or inferred
                    fd.storage_class = (fd.storage_class & ~STC.return_) as STC;

                    // If we previously assumed the function could be ref when
                    // checking for `shared`, make sure we were right
                    if (sc.previews.noSharedAccess && rs.exp!.type!.isShared()) {
                        error(fd.loc, ds("%s `%s` function returns `shared` but cannot be inferred `ref`"),
                            fd.kind(), fd.toPrettyChars());
                        supplemental();
                    }
                };

                if (isLvalue(rs.exp)) {
                    /* May return by ref
                     */
                    const sc2: Scope = sc.push();
                    sc2.eSink = global.errorSinkNull;
                    // dmd/statementsem.d:2792.
                    const addressable = checkAddressable(rs.exp!, sc2, ds("`ref` return"));
                    // dmd/statementsem.d:2793 — swept: `checkReturnEscapeRef` is live and exported
                    // (dmd/escape.d:1124 `bool checkReturnEscapeRef(ref Scope sc, Expression e, bool gag)`).
                    const escapes = checkReturnEscapeRef(sc2, rs.exp!, true);
                    sc2.pop();

                    if (!addressable)
                        turnOffRef(() => { checkAddressable(rs.exp!, sc, ds("`ref` return")); });
                    else if (escapes)
                        // dmd/statementsem.d:2799 — swept: `checkReturnEscapeRef` is live
                        // (dmd/escape.d:1124), exported by escape.ts with the same signature.
                        turnOffRef(() => { checkReturnEscapeRef(sc, rs.exp!, false); });
                    else if (constConv(rs.exp.type!, tf!.next!) === MATCH.nomatch)
                        turnOffRef(
                            () => errorSupplemental(rs.loc, ds("cannot implicitly convert `%s` of type `%s` to `%s`"),
                                      rs.exp!.toChars(), rs.exp!.type!.toChars(), tf!.next!.toChars())
                        );
                } else
                    turnOffRef(
                        () => errorSupplemental(rs.loc, ds("return value `%s` is not an lvalue"), rs.exp!.toChars())
                    );

                /* The "refness" is determined by all of return statements.
                 * This means:
                 *    return 3; return x;  // ok, x can be a value
                 *    return x; return 3;  // ok, x can be a value
                 */
            }
        } else {
            // Type of the returned expression (if any), might've been moved to e0
            const resType: Type = e0 !== null ? e0.type! : Type.tvoid;

            // infer return type
            if (fd.inferRetType) {
                // 1. First `return <noreturn exp>?`
                // 2. Potentially found a returning branch, update accordingly
                if (tf!.next === null || toBasetype(tf!.next).isTypeNoreturn() !== null) {
                    tf!.next = resType; // infer void or noreturn
                }
                // Found an actual return value before
                else if (tf!.next.ty !== TY.Tvoid && toBasetype(resType).isTypeNoreturn() === null) {
                    if (tf!.next.isTypeError() === null) {
                        error(rs.loc, ds("mismatched function return type inference of `void` and `%s`"), tf!.next.toChars());
                    }
                    errors = true;
                    tf!.next = Type.terror;
                }

                tret = tf!.next;
                tbret = toBasetype(tret!);
            }

            // https://issues.dlang.org/show_bug.cgi?id=23914
            if (inferRef && resType.isTypeNoreturn() === null) // deduce 'auto ref'
                tf!.isRef = false;

            if (tbret!.ty !== TY.Tvoid && resType.isTypeNoreturn() === null) // if non-void return
            {
                if (tbret!.isTypeError() === null) {
                    if (e0 !== null)
                        error(rs.loc, ds("expected return type of `%s`, not `%s`"), tret!.toChars(), resType.toChars());
                    else if (tbret!.isTypeNoreturn() !== null) {
                        error(rs.loc, ds("cannot return from `noreturn` function"));
                        errorSupplemental(rs.loc,
                            ds("Consider adding an endless loop, `assert(0)`, or another `noreturn` expression"));
                    } else
                        error(rs.loc, ds("`return` expression expected"));
                }
                errors = true;
            } else if (fd.isMain()) {
                // main() returns 0, even if it returns void
                rs.exp = IntegerExp.literal(0);
            }
        }

        // If any branches have called a ctor, but this branch hasn't, it's an error
        if ((sc.ctorflow.callSuper & CSX.any_ctor) !== 0 &&
            (sc.ctorflow.callSuper & (CSX.this_ctor | CSX.super_ctor)) === 0)
        {
            error(rs.loc, ds("`return` without calling constructor"));
            errors = true;
        }

        if (sc.ctorflow.fieldinit.length !== 0)       // if aggregate fields are being constructed
        {
            const ad = fd.isMemberLocal();
            assert(ad !== null);
            for (let i = 0; i < ad.fields.length; i++) {
                const v = ad.fields.opIndex(i)!;
                const mustInit = ((v.storage_class & STC.nodefaultctor) !== 0n || needsNested(v.type!));
                if (mustInit && (sc.ctorflow.fieldinit[i].csx & CSX.this_ctor) === 0) {
                    error(rs.loc, ds("an earlier `return` statement skips field `%s` initialization"), v.toChars());
                    errors = true;
                }
            }
        }
        sc.ctorflow.orCSX(CSX.return_);

        if (errors)
            return setError();

        if (sc.fes !== null) {
            if (rs.exp === null) {
                // Send out "case receiver" statement to the foreach.
                //  return exp;
                const s: Statement = new ReturnStatement(Loc.initial, rs.exp);
                sc.fes.cases!.push(s);

                // Immediately rewrite "this" return statement as:
                //  return cases.length+1;
                rs.exp = IntegerExp.fromValue(BigInt(sc.fes.cases!.length + 1));
                if (e0 !== null) {
                    result = CompoundStatement.fromStatementList(rs.loc, new ExpStatement(rs.loc, e0), rs);
                    return;
                }
                result = rs;
                return;
            } else {
                // dmd/statementsem.d:2923 — UFCS `fd.buildResultVar(null, rs.exp.type)`.
                buildResultVar(fd, null, rs.exp!.type!);
                const r = checkNestedReference(fd.vresult!, sc, Loc.initial);
                assert(!r); // vresult should be always accessible

                // Send out "case receiver" statement to the foreach.
                //  return vresult;
                const s: Statement = new ReturnStatement(Loc.initial, new VarExp(Loc.initial, fd.vresult!));
                sc.fes.cases!.push(s);

                // Save receiver index for the later rewriting from:
                //  return exp;
                // to:
                //  vresult = exp; retrun caseDim;
                rs.caseDim = sc.fes.cases!.length + 1;
            }
        }
        if (rs.exp !== null) {
            if (fd.returns === null)
                fd.returns = new DArray<ReturnStatement | null>();
            fd.returns.push(rs);
        }
        if (e0 !== null) {
            if (e0.isDeclarationExp() !== null || e0.isCommaExp() !== null) {
                rs.exp = Expression.combine(e0, rs.exp);
            } else {
                const es = new ExpStatement(rs.loc, e0);
                if (e0.type!.isTypeNoreturn() !== null)
                    result = es; // Omit unreachable return;
                else
                    result = CompoundStatement.fromStatementList(rs.loc, es, rs);

                return;
            }
        }
        result = rs;
    };

    // dmd/statementsem.d:2965 — https://dlang.org/spec/statement.html#break-statement
    const visitBreak = (bs: BreakStatement): void => {
        //printf("BreakStatement::semantic()\n");

        // If:
        //  break Identifier;
        if (bs.ident !== null) {
            bs.ident = fixupLabelName(sc, bs.ident);

            const thisfunc: FuncDeclaration | null = sc.func;

            for (let scx: Scope | null = sc; scx !== null; scx = scx.enclosing) {
                if (scx.func !== thisfunc) // if in enclosing function
                {
                    if (sc.fes !== null) // if this is the body of a foreach
                    {
                        /* Post this statement to the fes, and replace
                         * it with a return value that caller will put into
                         * a switch. Caller will figure out where the break
                         * label actually is.
                         * Case numbers start with 2, not 0, as 0 is continue
                         * and 1 is break.
                         */
                        sc.fes.cases!.push(bs);
                        result = new ReturnStatement(Loc.initial, IntegerExp.fromValue(BigInt(sc.fes.cases!.length + 1)));
                        return;
                    }
                    break; // can't break to it
                }

                const ls: LabelStatement | null = scx.slabel;
                if (ls !== null && ls.ident === bs.ident) {
                    const s: Statement | null = ls.statement;
                    if (s === null || !s.hasBreak())
                        error(bs.loc, ds("label `%s` has no `break`"), bs.ident.toChars());
                    else if (ls.tf !== sc.tryFinally)
                        error(bs.loc, ds("cannot break out of `finally` block"));
                    else {
                        // resolved: version (IN_LLVM) (dmd/statementsem.d:3010) -> ON, body kept.
                        bs.target = ls;
                        ls.breaks = true;
                        result = bs;
                        return;
                    }
                    return setError();
                }
            }
            error(bs.loc, ds("enclosing label `%s` for `break` not found"), bs.ident.toChars());
            return setError();
        } else if (sc.sbreak === null) {
            if (sc.scopeGuard !== null && sc.scopeGuard.tok !== TOK.onScopeFailure) {
                error(bs.loc, ds("`break` is not allowed inside `%s` bodies"), Token.toCharsValue(sc.scopeGuard.tok));
            } else if (sc.fes !== null) {
                // Replace break; with return 1;
                result = new ReturnStatement(Loc.initial, IntegerExp.literal(1));
                return;
            } else
                error(bs.loc, ds("`break` is not inside a loop or `switch`"));
            return setError();
        } else if (sc.sbreak.isForwardingStatement() !== null) {
            error(bs.loc, ds("must use labeled `break` within `static foreach`"));
        }
        result = bs;
    };

    // dmd/statementsem.d:3047 — https://dlang.org/spec/statement.html#continue-statement
    const visitContinue = (cs: ContinueStatement): void => {
        //printf("ContinueStatement::semantic() %p\n", cs);
        if (cs.ident !== null) {
            cs.ident = fixupLabelName(sc, cs.ident);

            const thisfunc: FuncDeclaration | null = sc.func;

            for (let scx: Scope | null = sc; scx !== null; scx = scx.enclosing) {
                let ls: LabelStatement | null;
                if (scx.func !== thisfunc) // if in enclosing function
                {
                    if (sc.fes !== null) // if this is the body of a foreach
                    {
                        for (; scx !== null; scx = scx.enclosing) {
                            ls = scx.slabel;
                            if (ls !== null && ls.ident === cs.ident && ls.statement === sc.fes) {
                                // Replace continue ident; with return 0;
                                result = new ReturnStatement(Loc.initial, IntegerExp.literal(0));
                                return;
                            }
                        }

                        /* Post this statement to the fes, and replace
                         * it with a return value that caller will put into
                         * a switch. Caller will figure out where the break
                         * label actually is.
                         * Case numbers start with 2, not 0, as 0 is continue
                         * and 1 is break.
                         */
                        sc.fes.cases!.push(cs);
                        result = new ReturnStatement(Loc.initial, IntegerExp.fromValue(BigInt(sc.fes.cases!.length + 1)));
                        return;
                    }
                    break; // can't continue to it
                }

                ls = scx.slabel;
                if (ls !== null && ls.ident === cs.ident) {
                    const s: Statement | null = ls.statement;
                    if (s === null || !s.hasContinue())
                        error(cs.loc, ds("label `%s` has no `continue`"), cs.ident.toChars());
                    else if (ls.tf !== sc.tryFinally)
                        error(cs.loc, ds("cannot continue out of `finally` block"));
                    else {
                        // resolved: version (IN_LLVM) (dmd/statementsem.d:3102) -> ON, body kept.
                        cs.target = ls;
                        result = cs;
                        return;
                    }
                    return setError();
                }
            }
            error(cs.loc, ds("enclosing label `%s` for `continue` not found"), cs.ident.toChars());
            return setError();
        } else if (sc.scontinue === null) {
            if (sc.scopeGuard !== null && sc.scopeGuard.tok !== TOK.onScopeFailure) {
                error(cs.loc, ds("`continue` is not allowed inside `%s` bodies"), Token.toCharsValue(sc.scopeGuard.tok));
            } else if (sc.fes !== null) {
                // Replace continue; with return 0;
                result = new ReturnStatement(Loc.initial, IntegerExp.literal(0));
                return;
            } else
                error(cs.loc, ds("`continue` is not inside a loop"));
            return setError();
        } else if (sc.scontinue.isForwardingStatement() !== null) {
            error(cs.loc, ds("must use labeled `continue` within `static foreach`"));
        }
        result = cs;
    };

    // dmd/statementsem.d:3138 — https://dlang.org/spec/statement.html#synchronized-statement
    const visitSynchronized = (ss: SynchronizedStatement): void => {
        if (ss.exp !== null) {
            ss.exp = expressionSemantic(ss.exp, sc);
            ss.exp = resolveProperties(sc, ss.exp);
            ss.exp = optimize(ss.exp, WANTvalue);
            // dmd/statementsem.d:3148 — swept: `checkGC` is live (dmd/nogc.d:268).
            ss.exp = checkGC(ss.exp, sc);
            if (ss.exp.op === EXP.error) {
                if (ss._body !== null)
                    ss._body = statementSemantic(ss._body, sc);
                return setError();
            }

            const cd: ClassDeclaration | null = ss.exp.type!.isClassHandle();
            if (cd === null) {
                error(ss.loc, ds("can only `synchronize` on class objects, not `%s`"), ss.exp.type!.toChars());
                return setError();
            } else if (cd.isInterfaceDeclaration() !== null) {
                /* Cast the interface to an object, as the object has the monitor,
                 * not the interface.
                 */
                if (ClassDeclaration.object === null) {
                    ObjectNotFound(ss.loc, Id.Object!);
                    return setError();
                }

                let t: Type = ClassDeclaration.object.type!;
                t = toBasetype(typeSemantic(t, Loc.initial, sc));
                assert(t.ty === TY.Tclass);

                ss.exp = new CastExp(ss.loc, ss.exp, t);
                ss.exp = expressionSemantic(ss.exp, sc);
            }
            // resolved: version (all) (dmd/statementsem.d:3180) -> ON, branch kept inline.
            {
                /* Rewrite as:
                 *  auto tmp = exp;
                 *  _d_monitorenter(tmp);
                 *  try { body } finally { _d_monitorexit(tmp); }
                 */
                // dmd/statementsem.d:3187 — swept: `copyToTemp` is live (dmd/sideeffect.d:410).
                const tmp = copyToTemp(STC.none, ds("__sync"), ss.exp!);
                dsymbolSemantic(tmp, sc);

                const cs: Statements = DArray.from<Statement | null>(ExpStatement.fromDsymbol(ss.loc, tmp));
                const args: Parameters = DArray.from<Parameter | null>(
                    new Parameter(Loc.initial, STC.none, ClassDeclaration.object!.type, null, null, null));

                // dmd/statementsem.d:3194 — the `Identifier` form of `genCfunc` (funcsem.ts:327);
                // its Form-B sibling `genCfuncFromName` is already imported (04 §1B).
                const fdenter: FuncDeclaration = genCfunc(args, Type.tvoid, Id.monitorenter!);
                let e: Expression = CallExp.fromFunc(ss.loc, fdenter, new VarExp(ss.loc, tmp));
                e.type = Type.tvoid; // do not run semantic on e

                cs.push(new ExpStatement(ss.loc, e));
                // dmd/statementsem.d:3199.
                const fdexit: FuncDeclaration = genCfunc(args, Type.tvoid, Id.monitorexit!);
                e = CallExp.fromFunc(ss.loc, fdexit, new VarExp(ss.loc, tmp));
                e.type = Type.tvoid; // do not run semantic on e
                let s: Statement | null = new ExpStatement(ss.loc, e);
                s = new TryFinallyStatement(ss.loc, ss._body, s);
                cs.push(s);

                s = new CompoundStatement(ss.loc, cs);
                result = statementSemantic(s, sc);
            }
        } else {
            /* Generate our own critical section, then rewrite as:
             *  static shared void* __critsec;
             *  _d_criticalenter2(&__critsec);
             *  try { body } finally { _d_criticalexit(__critsec); }
             */
            const id = Identifier.generateId(ds("__critsec"));
            const t = Type.tvoidptr;
            const tmp = new VarDeclaration(ss.loc, t, id, null);
            tmp.storage_class = (tmp.storage_class | STC.temp | STC.shared_ | STC.static_) as STC;
            const tmpExp: Expression = new VarExp(ss.loc, tmp);

            const cs: Statements = DArray.from<Statement | null>(ExpStatement.fromDsymbol(ss.loc, tmp));

            /* This is just a dummy variable for "goto skips declaration" error.
             * Backend optimizer could remove this unused variable.
             */
            const v = new VarDeclaration(ss.loc, Type.tvoidptr, Identifier.generateId(ds("__sync")), null);
            dsymbolSemantic(v, sc);
            cs.push(ExpStatement.fromDsymbol(ss.loc, v));

            const enterArgs: Parameters = DArray.from<Parameter | null>(
                new Parameter(Loc.initial, STC.none, pointerTo(t), null, null, null));

            // dmd/statementsem.d:3234.
            const fdenter: FuncDeclaration = genCfunc(enterArgs, Type.tvoid, Id.criticalenter!, STC.nothrow_);
            let e: Expression = new AddrExp(ss.loc, tmpExp);
            e = expressionSemantic(e, sc);
            e = CallExp.fromFunc(ss.loc, fdenter, e);
            e.type = Type.tvoid; // do not run semantic on e
            cs.push(new ExpStatement(ss.loc, e));

            const exitArgs: Parameters = DArray.from<Parameter | null>(
                new Parameter(Loc.initial, STC.none, t, null, null, null));

            // dmd/statementsem.d:3243.
            const fdexit: FuncDeclaration = genCfunc(exitArgs, Type.tvoid, Id.criticalexit!, STC.nothrow_);
            e = CallExp.fromFunc(ss.loc, fdexit, tmpExp);
            e.type = Type.tvoid; // do not run semantic on e
            let s: Statement | null = new ExpStatement(ss.loc, e);
            s = new TryFinallyStatement(ss.loc, ss._body, s);
            cs.push(s);

            s = new CompoundStatement(ss.loc, cs);
            result = statementSemantic(s, sc);
        }
    };

    // dmd/statementsem.d:3255 — https://dlang.org/spec/statement.html#with-statement
    const visitWith = (ws: WithStatement): void => {
        let sym: ScopeDsymbol | null = null;
        let _init: Initializer | null = null;

        //printf("WithStatement::semantic()\n");
        ws.exp = expressionSemantic(ws.exp!, sc);
        ws.exp = resolveProperties(sc, ws.exp);
        ws.exp = optimize(ws.exp, WANTvalue);
        // dmd/statementsem.d:3267 — swept: `checkGC` is live (dmd/nogc.d:268).
        ws.exp = checkGC(ws.exp, sc);
        if (ws.exp.op === EXP.error)
            return setError();
        if (ws.exp.op === EXP.scope_) {
            sym = new WithScopeSymbol(ws);
            sym.parent = sc.scopesym;
            sym.endlinnum = ws.endloc.linnum();
        } else if (ws.exp.isTypeExp() !== null) {
            const et = ws.exp.isTypeExp()!;
            const s = toDsymbol(et.type!, sc);
            if (s === null || s.isScopeDsymbol() === null) {
                error(ws.loc, ds("`with` type `%s` has no members"), ws.exp.toChars());
                return setError();
            }
            sym = new WithScopeSymbol(ws);
            sym.parent = sc.scopesym;
            sym.endlinnum = ws.endloc.linnum();
        } else if (ws.prm !== null) {
            /* 1.43: NEW branch. Re-write to
             * {
             *   auto prm = exp
             *   with(prm)
             *   {
             *     ...
             *   }
             * }
             */
            const tmp_init = new ExpInitializer(ws.loc, ws.exp);
            const tmp = new VarDeclaration(ws.loc, ws.prm.type, ws.prm.ident!, tmp_init);
            // tmp.storage_class |= STC.temp; //NOTE(mojo): idk
            dsymbolSemantic(tmp, sc);

            const es = ExpStatement.fromDsymbol(ws.loc, tmp);
            ws.exp = new VarExp(ws.loc, tmp);

            ws.prm = null;
            const cs = CompoundStatement.fromStatementList(ws.loc, es, ws);
            const ss: Statement = new ScopeStatement(ws.loc, cs, ws.endloc);
            result = statementSemantic(ss, sc);

            return;
        } else {
            let texp: Type = ws.exp.type!;
            let t: Type = toBasetype(texp);

            const olde: Expression = ws.exp;
            if (t.ty === TY.Tpointer) {
                ws.exp = new PtrExp(ws.loc, ws.exp);
                ws.exp = expressionSemantic(ws.exp, sc);
                texp = ws.exp.type!;
                t = toBasetype(texp);
            }

            assert(t !== null);
            t = toBasetype(t);
            if (t.isClassHandle() !== null) {
                _init = new ExpInitializer(ws.loc, ws.exp);
                ws.wthis = new VarDeclaration(ws.loc, ws.exp.type, Id.withSym!, _init);
                ws.wthis.storage_class = (ws.wthis.storage_class | STC.temp) as STC;
                dsymbolSemantic(ws.wthis, sc);

                sym = new WithScopeSymbol(ws);
                sym.parent = sc.scopesym;
                sym.endlinnum = ws.endloc.linnum();
            } else if (t.ty === TY.Tstruct) {
                if (!isLvalue(ws.exp)) {
                    /* Re-write to
                     * {
                     *   auto __withtmp = exp
                     *   with(__withtmp)
                     *   {
                     *     ...
                     *   }
                     * }
                     */
                    // dmd/statementsem.d:3354 — swept: `copyToTemp` is live (dmd/sideeffect.d:410).
                    const tmp = copyToTemp(STC.none, ds("__withtmp"), ws.exp);
                    dsymbolSemantic(tmp, sc);
                    const es = ExpStatement.fromDsymbol(ws.loc, tmp);
                    ws.exp = new VarExp(ws.loc, tmp);
                    const ss: Statement = new ScopeStatement(ws.loc,
                        CompoundStatement.fromStatementList(ws.loc, es, ws), ws.endloc);
                    result = statementSemantic(ss, sc);

                    return;
                }
                // dmd/statementsem.d:3362 — UFCS `ws.exp.addressOf()`.
                const e: Expression = addressOf(ws.exp);
                _init = new ExpInitializer(ws.loc, e);
                ws.wthis = new VarDeclaration(ws.loc, e.type, Id.withSym!, _init);
                ws.wthis.storage_class = (ws.wthis.storage_class | STC.temp) as STC;
                dsymbolSemantic(ws.wthis, sc);
                sym = new WithScopeSymbol(ws);
                // Need to set the scope to make use of resolveAliasThis
                // dmd/statementsem.d:3369 — UFCS `sym.setScope(sc)`.
                setScope(sym, sc);
                sym.parent = sc.scopesym;
                sym.endlinnum = ws.endloc.linnum();
            } else {
                const tenum = texp.isTypeEnum();
                if (tenum !== null) {
                    ws.exp = new TypeExp(ws.exp.loc, tenum);
                    sym = new WithScopeSymbol(ws);
                    sym.parent = sc.scopesym;
                    sym.endlinnum = ws.endloc.linnum();
                } else {
                    error(ws.loc, ds("`with` expression types must be enums or aggregates or pointers to them, not `%s`"),
                        olde.type!.toChars());
                    return setError();
                }
            }
        }

        if (ws._body !== null) {
            sym!._scope = sc;
            sc = sc.push(sym!);
            insert(sc, sym!);
            ws._body = statementSemantic(ws._body, sc);
            sc.pop();
            if (ws._body !== null && ws._body.isErrorStatement() !== null) {
                result = ws._body;
                return;
            }
        }

        result = ws;
    };

    // dmd/statementsem.d:3405 — https://dlang.org/spec/statement.html#TryStatement
    const visitTryCatch = (tcs: TryCatchStatement): void => {
        //printf("TryCatchStatement.semantic()\n");

        if (!global.params.useExceptions) {
            error(tcs.loc, ds("cannot use try-catch statements with `%s`"),
                global.params.betterC ? ds("-betterC") : ds("-nothrow"));
            return setError();
        }

        if (ClassDeclaration.throwable === null) {
            error(tcs.loc, ds("cannot use try-catch statements because `object.Throwable` was not declared"));
            return setError();
        }

        let flags = 0;                    // D `uint flags;` -> 0 (09 §1.0)
        const FLAGcpp = 1;                // D function-local manifest enum (02 §4.1)
        const FLAGd = 2;

        tcs.tryBody = sc.tryBody;   // chain on the in-flight tryBody
        tcs._body = semanticScope(tcs._body!, sc, null, null, tcs);

        /* Even if body is empty, still do semantic analysis on catches
         */
        let catchErrors = false;
        for (let i = 0; i < tcs.catches!.length; i++) {
            const c = tcs.catches!.opIndex(i)!;
            catchSemantic(c, sc);
            if (c.errors) {
                catchErrors = true;
                continue;
            }
            const cd = toBasetype(c.type!).isClassHandle()!;
            flags |= cd.isCPPclass() ? FLAGcpp : FLAGd;

            // Determine if current catch 'hides' any previous catches
            for (let j = 0; j < i; j++) {
                const cj = tcs.catches!.opIndex(j)!;
                const si = c.loc.toChars();
                const sj = cj.loc.toChars();
                if (implicitConvToType(toBasetype(c.type!), toBasetype(cj.type!)) !== MATCH.nomatch) {
                    error(tcs.loc, ds("`catch` at %s hides `catch` at %s"), sj, si);
                    catchErrors = true;
                }
            }
        }

        if (sc.func !== null) {
            sc.func.hasCatches = true;
            if (flags === (FLAGcpp | FLAGd)) {
                error(tcs.loc, ds("cannot mix catching D and C++ exceptions in the same try-catch"));
                catchErrors = true;
            }
        }

        if (catchErrors)
            return setError();

        // No actual code in the try (i.e. omitted any conditionally compiled code)
        // Could also be extended to check for hasCode
        if (tcs._body === null)
            return;

        if (tcs._body.isErrorStatement() !== null) {
            result = tcs._body;
            return;
        }

        /* If the try body never throws, we can eliminate any catches
         * of recoverable exceptions.
         */
        if ((blockExit(tcs._body, sc.func, null) & BE.throw_) === 0 && ClassDeclaration.exception !== null) {
            // `foreach_reverse (i; 0 .. tcs.catches.length)` -> descending counter for (06 §2).
            for (let i = tcs.catches!.length - 1; i >= 0; i--) {
                const c = tcs.catches!.opIndex(i)!;

                /* If catch exception type is derived from Exception
                 */
                if (implicitConvToType(toBasetype(c.type!), ClassDeclaration.exception.type!) !== MATCH.nomatch &&
                    (c.handler === null || !c.handler.comeFrom()) && !sc.debug_)
                {
                    // Remove c from the array of catches
                    tcs.catches!.remove(i);
                }
            }
        }

        if (tcs.catches!.length === 0) {
            result = tcs._body.hasCode() ? tcs._body : null;
            return;
        }

        result = tcs;
    };

    // dmd/statementsem.d:3509.
    const visitTryFinally = (tfs: TryFinallyStatement): void => {
        //printf("TryFinallyStatement::semantic()\n");
        tfs.tryBody = sc.tryBody;   // chain on in-flight tryBody
        tfs._body = semanticScope(tfs._body!, sc, null, null, tfs);

        sc = sc.push();
        sc.tryFinally = tfs;
        sc.sbreak = null;
        sc.scontinue = null; // no break or continue out of finally block
        tfs.finalbody = semanticNoScope(tfs.finalbody!, sc);
        sc.pop();

        if (tfs._body === null) {
            result = tfs.finalbody;
            return;
        }
        if (tfs.finalbody === null) {
            result = tfs._body;
            return;
        }

        let blockexit = blockExit(tfs._body, sc.func, null);

        // if not worrying about exceptions
        if (!(global.params.useExceptions && ClassDeclaration.throwable !== null))
            blockexit &= ~BE.throw_;            // don't worry about paths that otherwise may throw

        // Don't care about paths that halt, either
        // Only rewrite if it was requested.
        // This has side effects where Error will not run destructors, unsafe.
        // (1.43 delta: the rewrite is now gated on `global.params.nothrowOptimizations`.)
        if (global.params.nothrowOptimizations && (blockexit & ~BE.halt) === BE.fallthru) {
            result = CompoundStatement.fromStatementList(tfs.loc, tfs._body, tfs.finalbody);
            return;
        }

        tfs.bodyFallsThru = (blockexit & BE.fallthru) !== 0;
        result = tfs;
    };

    // dmd/statementsem.d:3552 — https://dlang.org/spec/statement.html#scope-guard-statement
    const visitScopeGuard = (oss: ScopeGuardStatement): void => {
        if (oss.tok !== TOK.onScopeExit) {
            // https://issues.dlang.org/show_bug.cgi?id=23159
            if (!global.params.useExceptions) {
                error(oss.loc, ds("`%s` cannot be used with `-%s`"), Token.toCharsValue(oss.tok), SwitchScopeGuard);
                return setError();
            }

            // scope(success) and scope(failure) are rewritten to try-catch(-finally) statement,
            // so the generated catch block cannot be placed in finally block.
            // See also Catch::semantic.
            if (sc.scopeGuard !== null && sc.scopeGuard.tok !== TOK.onScopeFailure) {
                // If enclosing is scope(success) or scope(exit), this will be placed in finally block.
                error(oss.loc, ds("cannot put `%s` statement inside `%s`"),
                    Token.toCharsValue(oss.tok), Token.toCharsValue(sc.scopeGuard.tok));
                return setError();
            }
            if (sc.tryFinally !== null) {
                error(oss.loc, ds("cannot put `%s` statement inside `finally` block"), Token.toCharsValue(oss.tok));
                return setError();
            }
        }

        sc = sc.push();
        sc.tryFinally = null;
        sc.scopeGuard = oss;
        if (oss.tok !== TOK.onScopeFailure) {
            // Jump out from scope(failure) block is allowed.
            sc.sbreak = null;
            sc.scontinue = null;
        }
        oss.statement = semanticNoScope(oss.statement!, sc);
        sc.pop();

        if (oss.statement === null || oss.statement.isErrorStatement() !== null) {
            result = oss.statement;
            return;
        }
        result = oss;
    };

    // dmd/statementsem.d:3602 — https://dlang.org/spec/statement.html#throw-statement
    const visitThrow = (ts: ThrowStatement): void => {
        //printf("ThrowStatement::semantic()\n");
        // `ref Expression exp` -> a one-slot box written back into the field (03 §3.2/§7.2).
        // `ts.exp!`: `throwSemantic` dereferences the slot unconditionally (dmd/statementsem.d:3859),
        // so the box is non-null-typed and the `!` marks D's own fault point (02 §10.1).
        const expRef: { value: Expression } = { value: ts.exp! };
        const ok = throwSemantic(ts.loc, expRef, sc);
        ts.exp = expRef.value;
        if (ok)
            result = ts;
        else
            setError();
    };

    // dmd/statementsem.d:3615.
    const visitDebug = (ds_: DebugStatement): void => {
        if (ds_.statement !== null) {
            sc = sc.push();
            sc.debug_ = true;
            ds_.statement = statementSemantic(ds_.statement, sc);
            debugThrowWalker(ds_.statement);
            sc.pop();
        }
        result = ds_.statement;
    };

    // dmd/statementsem.d:3628 — https://dlang.org/spec/statement.html#goto-statement
    const visitGoto = (gs: GotoStatement): void => {
        //printf("GotoStatement::semantic()\n");
        const fd: FuncDeclaration = sc.func!;

        gs.ident = fixupLabelName(sc, gs.ident!);
        gs.label = fd.searchLabel(gs.ident, gs.loc);
        gs.tryBody = sc.tryBody;
        gs.tf = sc.tryFinally;
        gs.os = sc.scopeGuard;
        gs.lastVar = sc.lastVar;
        gs.inCtfeBlock = sc.ctfeBlock;

        if (gs.label.statement === null && sc.fes !== null) {
            /* Either the goto label is forward referenced or it
             * is in the function that the enclosing foreach is in.
             * Can't know yet, so wrap the goto in a scope statement
             * so we can patch it later, and add it to a 'look at this later'
             * list.
             */
            gs.label.deleted = true;
            const ss = new ScopeStatement(gs.loc, gs, gs.loc);
            sc.fes.gotos!.push(ss); // 'look at this later' list
            result = ss;
            return;
        }

        // Add to fwdref list to check later
        if (gs.label.statement === null) {
            if (fd.gotos === null)
                fd.gotos = new DArray<GotoStatement | null>();
            fd.gotos.push(gs);
        } else if (!sc.inCfile && checkLabel(gs))
            return setError();

        result = gs;
    };

    // dmd/statementsem.d:3672.
    const visitLabel = (ls: LabelStatement): void => {
        //printf("LabelStatement::semantic()\n");
        const fd: FuncDeclaration = sc.parent!.isFuncDeclaration()!;

        ls.ident = fixupLabelName(sc, ls.ident!);
        ls.tryBody = sc.tryBody;
        ls.tf = sc.tryFinally;
        ls.os = sc.scopeGuard;
        ls.lastVar = sc.lastVar;
        ls.inCtfeBlock = sc.ctfeBlock;

        const ls2: LabelDsymbol = fd.searchLabel(ls.ident, ls.loc);
        if (ls2.statement !== null && !ls2.duplicated) {
            // dmd/statementsem.d:3687 `ls.loc == ls2.loc`. `Loc` declares BOTH `equals` (an
            // extern(C++) SourceLoc filename/line compare, location.d:148) and `opEquals`
            // (extern(D), `this.index == loc.index`, location.d:165). D's `==` binds to
            // `opEquals` (05 §2), NOT to the same-named `equals` method.
            if (ls.loc.opEquals(ls2.loc)) {
                ls2.duplicated = true;
                error(ls.loc, ds("label `%s` is duplicated"), ls2.toChars());
                errorSupplemental(ls2.loc, ds("labels cannot be used in a static foreach with more than 1 iteration"));
            } else {
                error(ls.loc, ds("label `%s` is already defined"), ls2.toChars());
                errorSupplemental(ls2.loc, ds("first definition is here"));
            }
            return setError();
        } else
            ls2.statement = ls;

        sc = sc.push();
        sc.lastVar = sc.enclosing!.lastVar;
        sc.scopesym = sc.enclosing!.scopesym;

        sc.ctorflow.orCSX(CSX.label);

        sc.slabel = ls;
        if (ls.statement !== null)
            ls.statement = statementSemantic(ls.statement, sc);

        //issue 24534: lastVar may have been updated in the nested scope
        sc.enclosing!.lastVar = sc.lastVar;

        sc.pop();

        result = ls;
    };

    // dmd/statementsem.d:3721 — https://dlang.org/spec/statement.html#asm
    const visitAsm = (s: AsmStatement): void => {
        //printf("AsmStatement()::semantic()\n");
        result = asmSemantic(s, sc);
    };

    // dmd/statementsem.d:3730.
    const visitCompoundAsm = (cas: CompoundAsmStatement): void => {
        //printf("CompoundAsmStatement()::semantic()\n");
        // Apply postfix attributes of the asm block to each statement.
        sc = sc.push();
        sc.stc = (sc.stc | cas.stc) as STC;

        /* Go through the statements twice, first to declare any labels,
         * second for anything else.
         */

        for (let i = 0; i < cas.statements!.length; i++) {
            const s = cas.statements!.opIndex(i);
            if (s !== null) {
                const ls = s.isLabelStatement();
                if (ls !== null) {
                    sc.func!.searchLabel(ls.ident!, ls.loc);

                    // resolved: version (IN_LLVM) (dmd/statementsem.d:3749) -> ON, body kept.
                    if (sc.func!.asmLabels === null)
                        sc.func!.asmLabels = new DArray<Identifier | null>();
                    sc.func!.asmLabels.push(ls.ident);
                }
            }
        }

        // `foreach (ref s; *cas.statements)` — `ref s` writes the analyzed statement back (03 §4).
        for (let i = 0; i < cas.statements!.length; i++) {
            const s = cas.statements!.opIndex(i);
            cas.statements!.opIndexAssign(s !== null ? statementSemantic(s, sc) : null, i);
        }

        assert(sc.func !== null);
        // dmd/statementsem.d:3765 — UFCS `sc.func.setImpure(cas.loc, "…")`.
        if ((cas.stc & STC.pure_) === 0n &&
            setImpure(sc.func!, cas.loc, ds("executing an `asm` statement without `pure` annotation")))
            error(cas.loc, ds("`asm` statement is assumed to be impure - mark it with `pure` if it is not"));
        if ((cas.stc & STC.nogc) === 0n &&
            setGC(sc, sc.func!, cas.loc, ds("executing an `asm` statement without `@nogc` annotation")))
            error(cas.loc, ds("`asm` statement is assumed to use the GC - mark it with `@nogc` if it does not"));
        // @@@DEPRECATED_2.114@@@
        // change deprecation() to error(), add `else` and remove `| STC.safe`
        // to turn deprecation into an error when deprecation cycle is over
        if ((cas.stc & STC.safe) !== 0n)
            deprecation(cas.loc, ds("`asm` statement cannot be marked `@safe`, use `@system` or `@trusted` instead"));
        if ((cas.stc & (STC.trusted | STC.safe)) === 0n) {
            setUnsafe(sc, false, cas.loc, ds("executing an `asm` statement without `@trusted` annotation"));
        }

        sc.pop();
        result = cas;
    };

    // dmd/statementsem.d:3783 — https://dlang.org/spec/module.html#ImportDeclaration
    const visitImport = (imps: ImportStatement): void => {
        for (let i = 0; i < imps.imports!.length; i++) {
            const s: Import = imps.imports!.opIndex(i)!.isImport()!;
            assert(s.aliasdecls.length === 0);
            for (let j = 0; j < s.names.length; j++) {
                const name = s.names.opIndex(j);
                let _alias = s.aliases.opIndex(j);
                if (_alias === null)
                    _alias = name;

                const tname = new TypeIdentifier(s.loc, name);
                const ad = AliasDeclaration.fromType(s.loc, _alias!, tname);
                ad._import = s;
                s.aliasdecls.push(ad);
            }

            dsymbolSemantic(s, sc);

            // https://issues.dlang.org/show_bug.cgi?id=19942
            // If the module that's being imported doesn't exist, don't add it to the symbol table
            // for the current scope.
            if (s.mod !== null) {
                addDeferredSemantic2(s);     // https://issues.dlang.org/show_bug.cgi?id=14666
                insert(sc, s);

                for (const aliasdecl of s.aliasdecls) {
                    insert(sc, aliasdecl!);
                }
            }
        }
        result = imps;
    };

    // dmd/statementsem.d:3823-3824 — `mixin VisitStatement!void visit;` + `visit.VisitStatement(s);`.
    // resolved: mixin VisitStatement!void + visitStmtCase (dmd/statement.d:1981) -> inlined dispatch
    // switch, ALL 44 arms (13 §7.6). An arm whose `visitXxx` handler does not exist in this function
    // routes to `visitDefaultCase` — never to a "related" handler. In particular STMT.CompoundDeclaration
    // routes to visitDefaultCase even though CompoundDeclarationStatement derives from CompoundStatement:
    // D generates `visitCompoundDeclaration`, which does not exist here, so `__traits(compiles, ...)`
    // is false. Routing it to visitCompound is the shipped blockexit.ts miscompile.
    switch (s.stmt) {
        case STMT.Error:               visitError(s.isErrorStatement()!); break;
        case STMT.Scope:               visitScope(s.isScopeStatement()!); break;
        case STMT.Exp:                 visitExp(s.isExpStatement()!); break;
        case STMT.Compound:            visitCompound(s.isCompoundStatement()!); break;
        case STMT.Return:              visitReturn(s.isReturnStatement()!); break;
        case STMT.If:                  visitIf(s.isIfStatement()!); break;
        case STMT.Conditional:         visitConditional(s.isConditionalStatement()!); break;
        case STMT.StaticForeach:       visitDefaultCase(s.isStaticForeachStatement()!); break;
        case STMT.Case:                visitCase(s.isCaseStatement()!); break;
        case STMT.Default:             visitDefault(s.isDefaultStatement()!); break;
        case STMT.Label:               visitLabel(s.isLabelStatement()!); break;
        case STMT.Goto:                visitGoto(s.isGotoStatement()!); break;
        case STMT.GotoDefault:         visitGotoDefault(s.isGotoDefaultStatement()!); break;
        case STMT.GotoCase:            visitGotoCase(s.isGotoCaseStatement()!); break;
        case STMT.Break:               visitBreak(s.isBreakStatement()!); break;
        case STMT.DtorExp:             visitDtorExp(s.isDtorExpStatement()!); break;
        case STMT.Mixin:               visitMixin(s.isMixinStatement()!); break;
        case STMT.Forwarding:          visitForwarding(s.isForwardingStatement()!); break;
        case STMT.Do:                  visitDo(s.isDoStatement()!); break;
        case STMT.While:               visitWhile(s.isWhileStatement()!); break;
        case STMT.For:                 visitFor(s.isForStatement()!); break;
        case STMT.Foreach:             visitForeach(s.isForeachStatement()!); break;
        case STMT.Switch:              visitSwitch(s.isSwitchStatement()!); break;
        case STMT.Continue:            visitContinue(s.isContinueStatement()!); break;
        case STMT.With:                visitWith(s.isWithStatement()!); break;
        case STMT.TryCatch:            visitTryCatch(s.isTryCatchStatement()!); break;
        case STMT.Throw:               visitThrow(s.isThrowStatement()!); break;
        case STMT.Debug:               visitDebug(s.isDebugStatement()!); break;
        case STMT.TryFinally:          visitTryFinally(s.isTryFinallyStatement()!); break;
        case STMT.ScopeGuard:          visitScopeGuard(s.isScopeGuardStatement()!); break;
        case STMT.SwitchError:         visitDefaultCase(s.isSwitchErrorStatement()!); break;
        case STMT.UnrolledLoop:        visitUnrolledLoop(s.isUnrolledLoopStatement()!); break;
        case STMT.ForeachRange:        visitForeachRange(s.isForeachRangeStatement()!); break;
        case STMT.CompoundDeclaration: visitDefaultCase(s.isCompoundDeclarationStatement()!); break;
        case STMT.Peel:                visitPeel(s.isPeelStatement()!); break;
        case STMT.CompoundAsm:         visitCompoundAsm(s.isCompoundAsmStatement()!); break;
        case STMT.Pragma:              visitPragma(s.isPragmaStatement()!); break;
        case STMT.StaticAssert:        visitStaticAssert(s.isStaticAssertStatement()!); break;
        case STMT.CaseRange:           visitCaseRange(s.isCaseRangeStatement()!); break;
        case STMT.Synchronized:        visitSynchronized(s.isSynchronizedStatement()!); break;
        case STMT.Asm:                 visitAsm(s.isAsmStatement()!); break;
        // statementsem.d has no visitInlineAsm/visitGccAsm, so visitStmtCase falls to visitDefaultCase for both
        // (dmd/statement.d:2063); asmSemantic (gen/asmstmt.ts) is what builds these two classes, from an
        // AsmStatement.
        case STMT.InlineAsm:           visitDefaultCase(s.isInlineAsmStatement()!); break;
        case STMT.GccAsm:              visitDefaultCase(s.isGccAsmStatement()!); break;
        case STMT.Import:              visitImport(s.isImportStatement()!); break;
        default: { const _e: never = s.stmt; throw new SwitchError(_e); }   // D `final switch` (06 §3.2)
    }
    return result;
}

/**
 * dmd/statementsem.d:3829 — `public bool throwSemantic(Loc loc, ref Expression exp, Scope* sc)`.
 * Run semantic on `throw <exp>`.
 *
 * Params:
 *   loc = location of the `throw`
 *   exp = value to be thrown — D `ref Expression`: the callee REBINDS the caller's slot
 *         (`exp = exp.expressionSemantic(sc)` …), so it is a single-slot box (03 §3.3), not a plain
 *         reference. The parameter type is spelled structurally (`{ value: Expression }`) so any
 *         `Ref<Expression>`-shaped box a caller builds is accepted.
 *   sc  = enclosing scope
 *
 * Returns: true if the `throw` is valid, or false if an error was found
 */
export function throwSemantic(loc: Loc, exp: { value: Expression }, sc: Scope): boolean {
    if (!global.params.useExceptions) {
        // dmd/statementsem.d:3842 — `SwitchExceptions ? SwitchExceptions : betterC ? "betterC" : "nothrow"`.
        // D's `SwitchExceptions` is a `const(char)*` manifest constant (dmd/targetcompiler.d:34) and the
        // test is POINTER truthiness (06 §2.8). `targetcompiler.ts` models it as a NON-NULLABLE
        // `DString` (`ds("fno-exceptions")` for the IN_LLVM build we compile), so `!== null` is not
        // expressible here — the nullability collapse is UPSTREAM of this file (06 §2.8 keeper clause;
        // filed as a `dependency signature` escalation). Equivalence on today's writer: for the LDC
        // build the D pointer is non-null, so the ternary always selects `SwitchExceptions` and the
        // betterC/nothrow arms are dead in this configuration.
        const s: DString = SwitchExceptions;
        error(loc, ds("cannot use `throw` statements with `-%s`"), s);
        return false;
    }

    if (ClassDeclaration.throwable === null) {
        error(loc, ds("cannot use `throw` statements because `object.Throwable` was not declared"));
        return false;
    }

    const ne = exp.value.isNewExp();               // `if (auto ne = exp.isNewExp())` (06 §2.6/§2.7)
    if (ne !== null) {
        ne.thrownew = true;
    }

    exp.value = expressionSemantic(exp.value, sc);
    exp.value = resolveProperties(sc, exp.value);
    // dmd/statementsem.d:3860 — `exp = exp.checkGC(sc)`. Swept: `checkGC` is live at dmd/nogc.d:268
    // (`Expression checkGC(Expression e, Scope* sc)`), exported by nogc.ts with the same signature.
    // The `ref Expression exp` parameter is the single-slot box, so the rebind writes `exp.value`.
    exp.value = checkGC(exp.value, sc);
    if (exp.value.isErrorExp() !== null)
        return false;
    if (!exp.value.type!.isNaked()) {
        // @@@DEPRECATED_2.112@@@
        // Deprecated in 2.102, change into an error & return false in 2.112
        deprecation(exp.value.loc, ds("cannot throw object of qualified type `%s`"), exp.value.type!.toChars());
        //return false;
    }
    // dmd/statementsem.d:3870 — swept: `checkThrowEscape` is live and exported (dmd/escape.d:928
    // `bool checkThrowEscape(ref Scope sc, Expression e, bool gag)`). `exp` is the single-slot box
    // for D's `ref Expression exp`, so the argument is `exp.value`.
    checkThrowEscape(sc, exp.value, false);

    const cd: ClassDeclaration | null = toBasetype(exp.value.type!).isClassHandle();
    if (cd === null || (cd !== ClassDeclaration.throwable && !ClassDeclaration.throwable!.isBaseOf(cd, null))) {
        error(loc, ds("can only throw class objects derived from `Throwable`, not type `%s`"),
            exp.value.type!.toChars());
        return false;
    }
    return true;
}

/**
 * dmd/statementsem.d:3881 — `private extern(D) Expression applyOpApply(ForeachStatement fs,
 * Expression flde, Type tab, Scope* sc2, Dsymbol sapply)`. D module-private; emitted without `private`
 * (01/10 module-private rule) because `apply()` in `statementSemanticVisit` (dmd:974) calls it.
 *
 * Returns the semantically-analyzed `aggr.opApply(flde)` call, or null on error.
 */
export function applyOpApply(fs: ForeachStatement, flde: Expression, tab: Type, sc2: Scope,
                             sapply: Dsymbol | null): Expression | null {
    // resolved: version(none){…}else{…} (dmd/statementsem.d:3884) -> OFF, the `else` branch is live.
    if (sc2.useDIP1000() === FeatureState.enabled)
        ++flde.isFuncExp()!.fd!.tookAddressOf;  // allocate a closure unless the opApply() uses 'scope'
    assert(tab.ty === TY.Tstruct || tab.ty === TY.Tclass);
    assert(sapply !== null);
    /* Call:
     *  aggr.apply(flde)
     */
    let ec: Expression;
    ec = new DotIdExp(fs.loc, fs.aggr, sapply.ident);
    ec = CallExp.fromArg(fs.loc, ec, flde);
    ec = expressionSemantic(ec, sc2);
    if (ec.isErrorExp() !== null)
        return null;
    if (ec.type !== Type.tint32) {
        error(fs.loc, ds("`opApply()` function for `%s` must return an `int`"), tab.toChars());
        return null;
    }
    return ec;
}

/**
 * dmd/statementsem.d:3916 — `private extern(D) Expression applyDelegate(ForeachStatement fs,
 * Expression flde, Type tab, Scope* sc2)`. D module-private; called from `apply()` in statementSemanticVisit (dmd:972).
 *
 * Returns the semantically-analyzed `aggr(flde)` call, or null on error.
 */
export function applyDelegate(fs: ForeachStatement, flde: Expression, tab: Type, sc2: Scope): Expression | null {
    let ec: Expression;
    /* Call:
     *      aggr(flde)
     */
    const de = fs.aggr!.isDelegateExp();                 // `if (auto de = fs.aggr.isDelegateExp())`
    if (de !== null)
        if (de.func!.isNested() && !de.func!.needThis()) {
            // https://issues.dlang.org/show_bug.cgi?id=3560
            fs.aggr = de.e1;
        }
    ec = CallExp.fromArg(fs.loc, fs.aggr, flde);
    ec = expressionSemantic(ec, sc2);
    if (ec.op === EXP.error)
        return null;
    if (ec.type !== Type.tint32) {
        error(fs.loc, ds("`opApply()` function for `%s` must return an `int`"), tab.toChars());
        return null;
    }
    return ec;
}

/**
 * dmd/statementsem.d:3942 — `private extern(D) Expression applyArray(ForeachStatement fs,
 * Expression flde, Type tab, Scope* sc2, Type tn, Type tnv)`. D module-private; called from `apply()`
 * in statementSemanticVisit (dmd:971).
 *
 * Builds the `_aApply<R><char-pair><dim>(aggr, flde)` druntime call. Never returns null (the D
 * declared return type is `Expression`); no `semantic()` is run on the result (its type is painted).
 */
export function applyArray(fs: ForeachStatement, flde: Expression, tab: Type, sc2: Scope,
                           tn: Type, tnv: Type): Expression {
    let ec: Expression;
    const dim = fs.parameters!.length;
    const loc = fs.loc;
    /* Call:
     *      _aApply(aggr, flde)
     */
    // D `static immutable fntab = [...]` — a function-local immutable table (02 §4.1 manifest form).
    const fntab: DString[] = [
        ds("cc"), ds("cw"), ds("cd"),
        ds("wc"), ds("cc"), ds("wd"),
        ds("dc"), ds("dw"), ds("dd"),
    ];

    // `7 + 1 + 2 + dim.sizeof * 3 + 1`; `size_t.sizeof` folds to the fixed target width 8 (09 §1.4).
    const BUFFER_LEN = 7 + 1 + 2 + 8 * 3 + 1;
    let flag: number;

    switch (tn.ty) {
        case TY.Tchar:   flag = 0; break;
        case TY.Twchar:  flag = 3; break;
        case TY.Tdchar:  flag = 6; break;
        default:
            assertUnreachable();
    }
    switch (tnv.ty) {
        case TY.Tchar:   flag += 0; break;
        case TY.Twchar:  flag += 1; break;
        case TY.Tdchar:  flag += 2; break;
        default:
            assertUnreachable();
    }
    const r: DString = (fs.op === TOK.foreach_reverse_) ? ds("R") : ds("");
    // D `char[BUFFER_LEN] fdname; int j = snprintf(fdname.ptr, BUFFER_LEN, "_aApply%s%.*s%llu", …)`.
    // The fixed-size stack buffer + snprintf becomes one `dmdformat` render (08 §3 / 10 §3.5); the
    // D assert on the produced length is kept (`j` is the byte count snprintf would write).
    const fdname: DString = dmdformat(ds("_aApply%s%.*s%llu"), [r, 2, fntab[flag], BigInt(dim)]);
    assert(fdname.length < BUFFER_LEN);

    let fdapply: FuncDeclaration;
    let dgty: TypeDelegate;
    const params: Parameters = DArray.from<Parameter | null>(
        new Parameter(Loc.initial, STC.in_, arrayOf(tn), null, null, null));
    const dgparams: Parameters = DArray.from<Parameter | null>(
        new Parameter(Loc.initial, STC.none, Type.tvoidptr, null, null, null));
    if (dim === 2)
        dgparams.push(new Parameter(Loc.initial, STC.none, Type.tvoidptr, null, null, null));
    dgty = new TypeDelegate(new TypeFunction(new ParameterList(dgparams), Type.tint32, LINK.d));
    params.push(new Parameter(Loc.initial, STC.none, dgty, null, null, null));
    // 1.42 `FuncDeclaration.genCfunc(...)` -> 1.43 free fn `genCfunc` (dmd/funcsem.d:262); the
    // `const(char)* name` overload is `genCfuncFromName` in the tree (04 §1B receiver/param suffix).
    fdapply = genCfuncFromName(params, Type.tint32, fdname);

    if (tab.isTypeSArray() !== null)
        fs.aggr = castTo(fs.aggr!, sc2, arrayOf(tn));
    // paint delegate argument to the type runtime expects
    let fexp: Expression = flde;
    if (!dgty.equals(flde.type)) {
        fexp = new CastExp(loc, flde, flde.type);
        fexp.type = dgty;
    }
    ec = new VarExp(Loc.initial, fdapply, false);
    ec = CallExp.fromArgs(loc, ec, fs.aggr, fexp);
    ec.type = Type.tint32; // don't run semantic() on ec
    return ec;
}

/**
 * dmd/statementsem.d:4007 — `private extern(D) Expression applyAssocArray(ForeachStatement fs,
 * Expression flde, Type tab)`. D module-private; called from `apply()` in statementSemanticVisit (dmd:973).
 *
 * Builds the `object._d_aaApply!(K, V, Dg)(aa, flde)` (or `_d_aaApply2`) template call, or returns
 * null after diagnosing an index/value parameter type mismatch.
 */
export function applyAssocArray(fs: ForeachStatement, flde: Expression, tab: Type): Expression | null {
    const taa = tab.isTypeAArray()!;
    const dim = fs.parameters!.length;
    // Check types
    let p: Parameter = fs.parameters!.opIndex(0)!;
    let isRef = (p.storageClass & STC.ref_) !== 0n;
    let ta: Type = p.type!;
    if (dim === 2) {
        const ti: Type = (isRef ? addMod(taa.index!, MODFlags.const_) : taa.index!);
        if (isRef ? constConv(ti, ta) === MATCH.nomatch : implicitConvToType(ti, ta) === MATCH.nomatch) {
            error(fs.loc, ds("`foreach`: index parameter `%s%s` must be type `%s`, not `%s`"),
                isRef ? ds("ref ") : ds(""), p.toChars(), ti.toChars(), ta.toChars());
            return null;
        }
        p = fs.parameters!.opIndex(1)!;
        isRef = (p.storageClass & STC.ref_) !== 0n;
        ta = p.type!;
    }
    const taav: Type = nextOf(taa)!;
    if (isRef ? constConv(taav, ta) === MATCH.nomatch : implicitConvToType(taav, ta) === MATCH.nomatch) {
        error(fs.loc, ds("`foreach`: value parameter `%s%s` must be type `%s`, not `%s`"),
            isRef ? ds("ref ") : ds(""), p.toChars(), taav.toChars(), ta.toChars());
        return null;
    }

    /* Call:
     *   int _d_aaApply(V[K] aa, int delegate(V*))
     * or
     *   int _d_aaApply2(V[K] aa, int delegate(K*, V*))
     */
    const loc = fs.loc;
    const hook: Identifier | null = dim === 2 ? Id._d_aaApply2 : Id._d_aaApply;
    let func: Expression = new IdentifierExp(loc, Id.empty);
    func = new DotIdExp(loc, func, Id.object);
    const tiargs: Objects = DArray.from<RootObject | null>(
        substWildTo(taa.index!, MODFlags.const_),
        substWildTo(taav, MODFlags.const_),
        substWildTo(flde.type!, MODFlags.const_));
    func = DotTemplateInstanceExp.fromName(loc, func, hook, tiargs);

    const arguments_: Expressions = DArray.from<Expression | null>(fs.aggr, flde);
    const call = new CallExp(loc, func, arguments_);
    return call;
}

/**
 * dmd/statementsem.d:4055 — `private extern(D) Statement loopReturn(Expression e, Statements* cases,
 * Loc loc)`. D module-private; called from `apply()` in statementSemanticVisit (dmd:980).
 *
 * Wraps the `_aApply`/`opApply` return value in a `switch` that dispatches to the break/continue/goto/
 * return statements collected in `cases`; with no cases it is a plain `cast(void) e;`.
 */
export function loopReturn(e: Expression, cases: Statements | null, loc: Loc): Statement {
    if (cases!.length === 0) {
        // Easy case, a clean exit from the loop
        // https://issues.dlang.org/show_bug.cgi?id=13899
        const ev: Expression = new CastExp(loc, e, Type.tvoid);
        return new ExpStatement(loc, ev);
    }
    // Construct a switch statement around the return value
    // of the apply function.
    let s: Statement;

    // default: break; takes care of cases 0 and 1
    s = new BreakStatement(Loc.initial, null);
    s = new DefaultStatement(Loc.initial, s);
    const a: Statements = DArray.from<Statement | null>(s);

    // cases 2...
    for (const [i, c] of cases!.opSlice().entries()) {
        s = new CaseStatement(Loc.initial, IntegerExp.fromValue(BigInt(i + 2)), c);
        a.push(s);
    }

    s = new CompoundStatement(loc, a);
    return new SwitchStatement(loc, null, e, s, false, loc);
}

/*************************************
 * dmd/statementsem.d:4094 — `private FuncExp foreachBodyToFunction(Scope* sc, ForeachStatement fs,
 * TypeFunction tfld)`. D module-private; called from `apply()` in statementSemanticVisit (dmd:942).
 *
 * Turn foreach body into the function literal:
 *  int delegate(ref T param) { body }
 * Params:
 *  sc = context
 *  fs = ForeachStatement
 *  tfld = type of function literal to be created (type of opApply() function if any), can be null
 * Returns:
 *  Function literal created, as an expression
 *  null if error.
 */
export function foreachBodyToFunction(sc: Scope, fs: ForeachStatement, tfld: TypeFunction | null): FuncExp | null {
    const tab: Type = toBasetype(fs.aggr!.type!);
    const taa = tab.isTypeAArray();
    const isStaticOrDynamicArray = tab.isTypeSArray() !== null || tab.isTypeDArray() !== null;

    const params: Parameters = new DArray<Parameter | null>();
    for (const [i, pSlot] of fs.parameters!.opSlice().entries()) {
        const p: Parameter = pSlot!;
        let stc: STC = (STC.ref_ | (p.storageClass & STC.scope_)) as STC;
        let id: Identifier | null = null;                 // D `Identifier id;` -> .init null (09 §1.0)

        p.type = typeSemantic(p.type!, fs.loc, sc);
        p.type = addStorageClass(p.type, p.storageClass);
        p.type = substWildTo(p.type, MODFlags.const_);

        /* goto LcopyArg (dmd/statementsem.d:4128 -> label dmd/statementsem.d:4135) — SHARED-ARM shape
         * (06 §4): the `LcopyArg:` label IS the body of the final `else` arm, reached both by
         * fall-through and by the `ref`-mismatch branch inside the `if (tfld)` arm. The arm is
         * extracted as a ZERO-PARAM nested arrow declared before its first use; it captures every
         * loop-carried local it touches (p, i, stc, taa, …) and RETURNS the one local it writes
         * (`id`), so no positional parameter list is invented (06 §4 tail rule).
         */
        const LcopyArg = (): Identifier => {
            // Make a copy of the ref argument so it isn't a reference.
            const idNew = Identifier.generateIdWithSuffix(ds("__applyArg"), i);

            // Make sure `p.type` matches the signature expected by the druntime helpers.
            const isIndexParam = i === 0 && fs.parameters!.length === 2;
            const userType: Type = p.type!;
            let initExp: Expression = new IdentifierExp(fs.loc, idNew);
            if (taa !== null) {
                p.type = isIndexParam ? taa.index : nextOf(taa);
                p.type = substWildTo(p.type!, MODFlags.const_);
            } else if (isStaticOrDynamicArray && isIndexParam) {
                p.type = Type.tsize_t;
                // If the user used an incompatible index type (e.g., `int` instead
                // of `size_t` - which is deprecated nowadays), then add a cast.
                if (implicitConvToType(p.type, userType) === MATCH.nomatch)
                    initExp = new CastExp(fs.loc, initExp, userType);
            }

            const initializer: Initializer = new ExpInitializer(fs.loc, initExp);
            const v = new VarDeclaration(fs.loc, userType, p.ident!, initializer);
            v.storage_class = (v.storage_class | STC.temp | (stc & STC.scope_)) as STC;
            const s: Statement = ExpStatement.fromDsymbol(fs.loc, v);  // D `new ExpStatement(loc, Dsymbol)`
            fs._body = CompoundStatement.fromStatementList(fs.loc, s, fs._body);
            return idNew;
        };

        if (tfld !== null) {
            const param: Parameter = tfld.parameterList.opIndex(i)!;
            //printf("\tparam = %s%s\n", (param.storageClass&STC.ref_?"ref ":"").ptr, param.ident.toChars());
            stc = ((param.storageClass & STC.ref_) | (p.storageClass & STC.scope_)) as STC;
            if ((p.storageClass & STC.ref_) !== (param.storageClass & STC.ref_)) {
                if ((param.storageClass & STC.ref_) === 0n) {
                    error(fs.loc, ds("`foreach`: cannot make `%s` `ref`"), p.ident!.toChars());
                    return null;
                }
                id = LcopyArg();          // goto LcopyArg (dmd/statementsem.d:4128)
            } else {
                id = p.ident;             // argument copy is not need.
            }
        } else if ((p.storageClass & STC.ref_) !== 0n) {
            // default delegate parameters are marked as ref, then
            // argument copy is not need.
            id = p.ident;
        } else {
            id = LcopyArg();              // fall-through into `LcopyArg:` (dmd/statementsem.d:4135)
        }
        params.push(new Parameter(fs.loc, stc, p.type, id, null, null));
    }
    // https://issues.dlang.org/show_bug.cgi?id=13840
    // Throwable nested function inside nothrow function is acceptable.
    const stc: STC = mergeFuncAttrs((STC.safe | STC.pure_ | STC.nogc) as STC, fs.func);
    const tf = new TypeFunction(new ParameterList(params), Type.tint32, LINK.d, stc);
    fs.cases = new DArray<Statement | null>();
    fs.gotos = new DArray<ScopeStatement | null>();
    const fld = new FuncLiteralDeclaration(fs.loc, fs.endloc, tf, TOK.delegate_, fs);
    fld.fbody = fs._body;
    let flde: Expression = new FuncExp(fs.loc, fld);
    flde = expressionSemantic(flde, sc);
    fld.tookAddressOf = 0;
    if (flde.op === EXP.error)
        return null;
    return flde.isFuncExp();
}

/**
 * dmd/statementsem.d:4181 — `void catchSemantic(Catch c, Scope* sc)`.
 *
 * Semantic pass for one `catch` clause: validates the placement (not inside `scope(exit|success)`
 * nor a `finally` block), resolves and checks the caught type, declares the catch variable and (under
 * `-preview=dip1008`) wraps the handler in the `_d_delThrowable` finalizer. Errors are reported on the
 * `Catch` node itself (`c.errors`); this function does not throw.
 *
 * `sc` is a mutable local here (the body pushes/pops a scope onto it) — matching dmd's `Scope* sc`
 * parameter slot.
 */
export function catchSemantic(c: Catch, scIn: Scope): void {
    let sc: Scope = scIn;
    //printf("Catch::semantic(%s)\n", ident.toChars());

    if (sc.scopeGuard !== null && sc.scopeGuard.tok !== TOK.onScopeFailure) {
        // If enclosing is scope(success) or scope(exit), this will be placed in finally block.
        error(c.loc, ds("cannot put `catch` statement inside `%s`"), Token.toCharsValue(sc.scopeGuard.tok));
        c.errors = true;
    }
    if (sc.tryFinally !== null) {
        /* This is because the _d_local_unwind() gets the stack munged
         * up on this. The workaround is to place any try-catches into
         * a separate function, and call that.
         * To fix, have the compiler automatically convert the finally
         * body into a nested function.
         */
        error(c.loc, ds("cannot put `catch` statement inside `finally` block"));
        c.errors = true;
    }

    const sym = new ScopeDsymbol();
    sym.parent = sc.scopesym;
    sc = sc.push(sym);

    if (c.type === null) {
        error(c.loc, ds("`catch` statement without an exception specification is deprecated"));
        errorSupplemental(c.loc, ds("use `catch(Throwable)` for old behavior"));
        c.errors = true;

        // reference .object.Throwable
        c.type = getThrowable();
    } else if (!c.type.isNaked() && !c.type.isConst()) {
        // @@@DEPRECATED_2.115@@@
        // Deprecated in 2.105, change into an error & uncomment assign in 2.115
        deprecation(c.loc, ds("can only catch mutable or const qualified types, not `%s`"), c.type.toChars());
        //c.errors = true;
    }
    c.type = typeSemantic(c.type!, c.loc, sc);
    if (c.type === Type.terror) {
        c.errors = true;
        sc.pop();
        return;
    }

    let stc: STC = STC.none;
    const cd: ClassDeclaration | null = toBasetype(c.type!).isClassHandle();

    if (cd === null) {
        error(c.loc, ds("can only catch class objects, not `%s`"), c.type!.toChars());
        c.errors = true;
    } else if (cd.isCPPclass()) {
        if (!target.cpp.exceptions) {
            error(c.loc, ds("catching C++ class objects not supported for this target"));
            c.errors = true;
        }
        if (!c.internalCatch) {
            if (setUnsafe(sc, false, c.loc, ds("catching C++ class objects")))
                c.errors = true;
        }
    } else if (cd !== ClassDeclaration.throwable && !ClassDeclaration.throwable!.isBaseOf(cd, null)) {
        error(c.loc, ds("can only catch class objects derived from `Throwable`, not `%s`"), c.type!.toChars());
        c.errors = true;
    } else if (!c.internalCatch && ClassDeclaration.exception !== null &&
               cd !== ClassDeclaration.exception && !ClassDeclaration.exception.isBaseOf(cd, null) &&
               setUnsafe(sc, false, c.loc,
                   ds("catching class objects derived from `%s` instead of `Exception`"), c.type)) {
        c.errors = true;
    } else if (sc.previews.dip1008) {
        stc = (stc | STC.scope_) as STC;
    }

    // DIP1008 requires destruction of the Throwable, even if the user didn't specify an identifier
    let ident: Identifier | null = c.ident;
    if (ident === null && sc.previews.dip1008)
        ident = Identifier.generateAnonymousId(ds("var"));

    if (ident !== null) {
        c.var_ = new VarDeclaration(c.loc, c.type, ident, null, stc);
        c.var_.iscatchvar = true;
        dsymbolSemantic(c.var_, sc);
        insert(sc, c.var_);

        if (sc.previews.dip1008 && (stc & STC.scope_) !== 0n) {
            /* Add a destructor for c.var
             * try { handler } finally { if (!__ctfe) _d_delThrowable(var); }
             */
            assert(c.var_.edtor === null);           // ensure we didn't create one in callScopeDtor()

            const loc = c.loc;
            let e: Expression = new VarExp(loc, c.var_!);
            e = CallExp.fromArg(loc, new IdentifierExp(loc, Id._d_delThrowable), e);

            let ec: Expression = new IdentifierExp(loc, Id.ctfe);
            ec = new NotExp(loc, ec);
            const s: Statement = new IfStatement(loc, null, ec, new ExpStatement(loc, e), null, loc);
            c.handler = new TryFinallyStatement(loc, c.handler, s);
        }
    }
    c.handler = statementSemantic(c.handler!, sc);
    if (c.handler !== null && c.handler.isErrorStatement() !== null)
        c.errors = true;

    sc.pop();
}

/**
 * dmd/statementsem.d:4305 — `Statement semanticNoScope(Statement s, Scope* sc)`.
 *
 * Analyze `s` in the CURRENT scope, wrapping it in a `CompoundStatement` first when it is neither a
 * compound nor a scope statement — so that `scopeCode()` gets a chance to run on it.
 * Returns the analyzed statement (may be null, as `statementSemantic` may drop a statement).
 */
export function semanticNoScope(s: Statement, sc: Scope): Statement | null {
    //printf("Statement::semanticNoScope() %s\n", toChars());
    let sCur: Statement | null = s;
    if (sCur.isCompoundStatement() === null && sCur.isScopeStatement() === null) {
        sCur = CompoundStatement.fromStatementList(sCur.loc, sCur); // so scopeCode() gets called
    }
    sCur = statementSemantic(sCur, sc);
    return sCur;
}

/**
 * dmd/statementsem.d:4317 — `private Statement semanticScope(Statement s, Scope* sc, Statement sbreak,
 * Statement scontinue, Statement tryBody)`. D module-private; called from statementSemanticVisit (dmd:589/:1753/
 * :3426/:3513).
 *
 * Same as semanticNoScope(), but do create a new scope. `sbreak`/`scontinue`/`tryBody` are installed
 * on the pushed scope only when non-null (D's truthiness-of-a-class-reference tests, 06 §2.7).
 */
export function semanticScope(s: Statement, sc: Scope, sbreak: Statement | null,
                              scontinue: Statement | null, tryBody: Statement | null): Statement | null {
    const sym = new ScopeDsymbol();
    sym.parent = sc.scopesym;
    const scd: Scope = sc.push(sym);
    if (sbreak !== null)
        scd.sbreak = sbreak;
    if (scontinue !== null)
        scd.scontinue = scontinue;
    if (tryBody !== null)
        scd.tryBody = tryBody;
    const sOut: Statement | null = semanticNoScope(s, scd);
    scd.pop();
    return sOut;
}

/****************************************
 * dmd/statementsem.d:4347 — `Statement scopeCode(Statement statement, Scope* sc, out Statement sentry,
 * out Statement sexception, out Statement sfinally)`.
 *
 * If `statement` has code that needs to run in a finally clause
 * at the end of the current scope, return that code in the form of
 * a Statement.
 * Params:
 *     statement = the statement
 *     sc = context
 *     sentry     = set to code executed upon entry to the scope
 *     sexception = set to code executed upon exit from the scope via exception
 *     sfinally   = set to code executed in finally block
 *
 * The three D `out` parameters become single-slot boxes RESET ON ENTRY (03 §3.3); the parameter types
 * are spelled structurally so any `Ref<Statement | null>`-shaped box is accepted.
 *
 * Returns:
 *    code to be run in the finally clause
 */
export function scopeCode(statement: Statement, sc: Scope,
                          sentry: { value: Statement | null },
                          sexception: { value: Statement | null },
                          sfinally: { value: Statement | null }): Statement | null {
    // D default-initializes every `out` parameter on entry (03 §3.3); `Statement.init` is null.
    sentry.value = null;
    sexception.value = null;
    sfinally.value = null;

    const es = statement.isExpStatement();
    if (es !== null) {
        if (es.exp !== null && es.exp.isDeclarationExp() !== null) {
            const de = es.exp.isDeclarationExp()!;
            // dmd/statementsem.d:4354 dereferences `de.declaration` unconditionally: `!` at exactly
            // the site where D would fault (08 §3), never a defensive guard.
            const v = de.declaration!.isVarDeclaration();
            if (v !== null && !v.isDataseg()) {
                if (v.needsScopeDtor()) {
                    sfinally.value = new DtorExpStatement(es.loc, v.edtor, v);
                    v.storage_class = (v.storage_class | STC.nodtor) as STC; // don't add in dtor again
                }
            }
        }
        return es;
    }

    const sgs = statement.isScopeGuardStatement();
    if (sgs !== null) {
        const s: Statement = new PeelStatement(sgs.statement!);

        switch (sgs.tok) {
            case TOK.onScopeExit:
                sfinally.value = s;
                break;

            case TOK.onScopeFailure:
                sexception.value = s;
                break;

            case TOK.onScopeSuccess: {
                /* Create:
                 *  sentry:   bool x = false;
                 *  sexception:    x = true;
                 *  sfinally: if (!x) statement;
                 */
                // dmd/statementsem.d:4388 — swept: `copyToTemp` is live (dmd/sideeffect.d:410).
                const v: VarDeclaration = copyToTemp(STC.none, ds("__os"), IntegerExp.createBool(false));
                dsymbolSemantic(v, sc);
                sentry.value = ExpStatement.fromDsymbol(statement.loc, v);

                let e: Expression = IntegerExp.createBool(true);
                e = new AssignExp(Loc.initial, new VarExp(Loc.initial, v), e);
                sexception.value = new ExpStatement(Loc.initial, e);

                e = new VarExp(Loc.initial, v);
                e = new NotExp(Loc.initial, e);
                sfinally.value = new IfStatement(Loc.initial, null, e, s, null, Loc.initial);

                break;
            }
            default:
                assertUnreachable();
        }
        return null;
    }

    const ls = statement.isLabelStatement();
    if (ls !== null) {
        if (ls.statement !== null)
            ls.statement = scopeCode(ls.statement, sc, sentry, sexception, sfinally);
        return ls;
    }

    return statement;
}

/***********************************************************
 * The Voldemort return type of `makeTupleForeach` (dmd/statementsem.d:4442 `union U { Statement
 * statement; Dsymbols* decl; }`).
 *
 * NOT a layout-significant union (02 §11.3 step 2): the discriminant is the caller's own `isDecl`
 * argument, the two members are mutually exclusive, and no site ever reads the member the call did
 * not write. Modeled as a two-slot value carrier — `.statement` is read by statementSemanticVisit (dmd:862) and by
 * `flatten` (dmd:4914); `.decl` by dsymbolsem.d:9252.
 */
export class MakeTupleForeachResult {
    statement: Statement | null = null;
    decl: Dsymbols | null = null;
}

/*******************
 * dmd/statementsem.d:4439 — `public auto makeTupleForeach(Scope* sc, bool isStatic, bool isDecl,
 * ForeachStatement fs, Dsymbols* dbody, bool needExpansion)`.
 *
 * Type check and unroll `foreach` over an expression tuple as well
 * as `static foreach` statements and `static foreach`
 * declarations. For `static foreach` statements and `static
 * foreach` declarations, the visitor interface is used (and the
 * result is written into the `result` field.) For `static
 * foreach` declarations, the resulting Dsymbols* are returned
 * directly.
 *
 * The unrolled body is wrapped into a
 *  - UnrolledLoopStatement, for `foreach` over an expression tuple.
 *  - ForwardingStatement, for `static foreach` statements.
 *  - ForwardingAttribDeclaration, for `static foreach` declarations.
 *
 * `static foreach` variables are declared as `STC.local`, such
 * that they are inserted into the local symbol tables of the
 * forwarding constructs instead of forwarded. For `static
 * foreach` with multiple foreach loop variables whose aggregate
 * has been lowered into a sequence of tuples, this function
 * expands the tuples into multiple `STC.local` `static foreach`
 * variables.
 */
export function makeTupleForeach(sc: Scope, isStatic: boolean, isDecl: boolean, fs: ForeachStatement,
                                 dbody: Dsymbols | null, needExpansion: boolean): MakeTupleForeachResult {
    const result = new MakeTupleForeachResult();

    const returnEarly = (): MakeTupleForeachResult => {
        if (isDecl)
            result.decl = null;
        else
            result.statement = new ErrorStatement();
        return result;
    };

    const loc = fs.loc;
    const dim: number = fs.parameters!.length;
    const skipCheck = isStatic && needExpansion;
    if (!skipCheck && (dim < 1 || dim > 2)) {
        error(fs.loc, ds("only one (element) or two (index, element) arguments allowed for sequence `foreach`, not %llu"),
            BigInt(dim));
        return returnEarly();
    }

    let paramtype: Type | null = fs.parameters!.opIndex(dim - 1)!.type;
    if (paramtype !== null) {
        paramtype = typeSemantic(paramtype, loc, sc);
        if (paramtype.ty === TY.Terror) {
            return returnEarly();
        }
    }

    const tab: Type = toBasetype(fs.aggr!.type!);
    const tuple: TypeTuple | null = tab.isTypeTuple();

    let statements: Statements | null = null;
    let declarations: Dsymbols | null = null;
    if (isDecl)
        declarations = new DArray<Dsymbol | null>();
    else
        statements = new DArray<Statement | null>();

    //printf("aggr: op = %d, %s\n", fs.aggr.op, fs.aggr.toChars());
    let n: number;
    let te: TupleExp | null = null;
    const ate = fs.aggr!.isTupleExp();      // `if (auto ate = fs.aggr.isTupleExp())` (06 §2.6)
    if (ate !== null) {                     // expression tuple
        te = ate;
        n = te.exps!.length;
    } else if (fs.aggr!.isTypeExp() !== null) {  // type tuple
        n = Parameter.dim(tuple!.arguments);
    } else
        assertUnreachable();

    for (let j = 0; j < n; j++) {
        const k: number = (fs.op === TOK.foreach_) ? j : n - 1 - j;
        let e: Expression | null = null;
        let t: Type | null = null;
        if (te !== null)
            e = te.exps!.opIndex(k);
        else
            t = Parameter.getNth(tuple!.arguments, k)!.type;
        let p: Parameter = fs.parameters!.opIndex(0)!;

        let stmts: Statements | null = null;
        let decls: Dsymbols | null = null;
        if (isDecl)
            decls = new DArray<Dsymbol | null>();
        else
            stmts = new DArray<Statement | null>();

        const skip = isStatic && needExpansion;
        if (!skip && dim === 2) {
            // Declare index
            if (p.isReference() || p.isLazy()) {
                // dmd/statementsem.d:4528 — swept: `stcToString` is live (dmd/hdrgen.d:3435). It is a
                // DISTINCT function from `stcToBuffer` (dmd/hdrgen.d:3367). D passes `p.storageClass`
                // by REF and the callee REDUCES it (`stc &= ~tbl`), so the one-slot box is written
                // back into the field D aliases (the ctorflow.ts `Ref<T>` idiom, 03 §3.2 / 04 §7).
                // `.ptr` in D is the char* of the same NUL-terminated literal — the DString is it.
                // hdrgen.ts returns an EMPTY DString where D returns `null`: inert here, because the
                // guard implies STC.ref_/out_/lazy_, all three in hdrgen's table (dmd/hdrgen.d:3443).
                const stcBox = { value: p.storageClass };
                const stcStr: DString = stcToString(stcBox);
                p.storageClass = stcBox.value;
                error(fs.loc, ds("invalid storage class `%s` for index `%s`"),
                    stcStr, p.ident!.toChars());
                return returnEarly();
            }

            if (isStatic) {
                if (p.type === null) {
                    p.type = Type.tsize_t;
                }
            }
            p.type = typeSemantic(p.type!, loc, sc);

            if (!isIntegral(p.type)) {
                error(fs.loc, ds("foreach: index cannot be of non-integral type `%s`"), p.type.toChars());
                return returnEarly();
            }

            const length: number = te !== null ? te.exps!.length : tuple!.arguments!.length;
            // dmd/statementsem.d:4549 — `._cast` here is not an intrange.d method but the UFCS free
            // function `IntRange _cast(IntRange _this, Type type)` at dmd/dcast.d:53 (dcast.ts).
            const dimrange: IntRange = _cast(
                new IntRange(new SignExtendedNumber(BigInt(length))), Type.tsize_t);
            // https://issues.dlang.org/show_bug.cgi?id=12504
            // `SignExtendedNumber.value` is `uinteger_t` (ulong): D's `- 1` is UNSIGNED 64-bit and
            // wraps to `ulong.max` for a zero-length tuple (09 §3) — re-truncate.
            dimrange.imax = new SignExtendedNumber(toUint64(dimrange.imax.value - 1n));
            // `contains` does not mutate its by-value argument: copy elided (03 §9).
            if (!intRangeFromType(p.type).contains(dimrange)) {
                error(fs.loc, ds("index type `%s` cannot cover index range 0..%llu"),
                    p.type.toChars(), BigInt(length));
                return returnEarly();
            }
            const ie: Initializer = new ExpInitializer(Loc.initial, IntegerExp.fromValue(BigInt(k)));
            const varIdx = new VarDeclaration(loc, p.type, p.ident!, ie);
            varIdx.storage_class = (varIdx.storage_class | STC.foreach_ | STC.manifest) as STC;
            if (isStatic)
                varIdx.storage_class = (varIdx.storage_class | STC.local) as STC;

            if (isDecl)
                decls!.push(varIdx);
            else
                stmts!.push(ExpStatement.fromDsymbol(loc, varIdx));

            p = fs.parameters!.opIndex(1)!; // value
        }
        /***********************
         * dmd/statementsem.d:4583 — nested `bool declareVariable(STC storageClass, Type type,
         * Identifier ident, Expression e, Type t)` (04 §5 -> inner `const` arrow).
         *
         * Declares a unrolled `foreach` loop variable or a `static foreach` variable.
         *
         * Params:
         *     storageClass = The storage class of the variable.
         *     type = The declared type of the variable.
         *     ident = The name of the variable.
         *     e = The initializer of the variable (i.e. the current element of the looped over aggregate).
         *     t = The type of the initializer.
         * Returns:
         *     `true` iff the declaration was successful.
         */
        const declareVariable = (storageClass: STC, type: Type | null, ident: Identifier,
                                 e: Expression | null, t: Type | null): boolean => {
            if ((storageClass & (STC.out_ | STC.lazy_)) !== 0n ||
                ((storageClass & STC.ref_) !== 0n && te === null)) {
                // dmd/statementsem.d:4589 — swept: `stcToString` is live (dmd/hdrgen.d:3435). D reads
                // and reduces the OUTER `p.storageClass` here, NOT the `storageClass` parameter; the
                // ref box is written back to that same field (see the note at dmd:4528). Same empty-
                // vs-`null` caveat: every D caller passes `p.storageClass` as `storageClass`
                // (dmd:4712/4722/4745 — the `STC.none` call at dmd:4731 cannot enter this branch), so
                // the guard implies a table bit in the value formatted here too.
                // Unreachable today when `dim == 2`: that path halts above at the `IntRange._cast` wall
                // (dmd/statementsem.d:4549) before `p` is reassigned to `parameters[1]`.
                const stcBox = { value: p.storageClass };
                const stcStr: DString = stcToString(stcBox);
                p.storageClass = stcBox.value;
                error(fs.loc, ds("invalid storage class `%s` for element `%s`"),
                    stcStr, ident.toChars());
                return false;
            }
            let var_: Declaration;
            if (e !== null) {
                const tb: Type = toBasetype(e.type!);
                // D `Dsymbol ds` — RENAMED: a local `ds` would put the module-scope `ds()` DString
                // helper (used by every diagnostic in this body) into the TDZ for the whole function.
                let dsym: Dsymbol | null = null;
                if ((storageClass & STC.manifest) === 0n) {
                    if (isStatic || tb.ty === TY.Tfunction || (storageClass & STC.alias_) !== 0n) {
                        const ve = e.isVarExp();
                        if (ve !== null)
                            dsym = ve.var_;
                        else {
                            const dve = e.isDotVarExp();
                            if (dve !== null)
                                dsym = dve.var_;
                        }
                    }
                    // NOTE: D's nested `te` here SHADOWS the enclosing TupleExp `te` (block-scoped in
                    // TS exactly as in D; the outer `te` is read above, before this block).
                    const te = e.isTemplateExp();
                    if (te !== null)
                        dsym = te.td;
                    else {
                        const se = e.isScopeExp();
                        if (se !== null)
                            dsym = se.sds;
                        else {
                            const fe = e.isFuncExp();
                            if (fe !== null)
                                dsym = fe.td !== null ? fe.td : fe.fd;
                            else {
                                const oe = e.isOverExp();
                                if (oe !== null)
                                    dsym = oe.vars;
                            }
                        }
                    }
                } else if ((storageClass & STC.alias_) !== 0n) {
                    error(fs.loc, ds("`foreach` loop variable cannot be both `enum` and `alias`"));
                    return false;
                }

                if (dsym !== null) {
                    var_ = AliasDeclaration.fromDsymbol(loc, ident, dsym);
                    if ((storageClass & STC.ref_) !== 0n) {
                        error(fs.loc, ds("symbol `%s` cannot be `ref`"), dsym.toChars());
                        return false;
                    }
                    if (paramtype !== null) {
                        error(fs.loc, ds("cannot specify element type for symbol `%s`"), dsym.toChars());
                        return false;
                    }
                } else if (e.op === EXP.type) {
                    var_ = AliasDeclaration.fromType(loc, ident, e.type!);
                    if (paramtype !== null) {
                        error(fs.loc, ds("cannot specify element type for type `%s`"), e.type!.toChars());
                        return false;
                    }
                } else {
                    e = resolveProperties(sc, e);
                    const ie: Initializer = new ExpInitializer(Loc.initial, e);
                    const v = new VarDeclaration(loc, type, ident, ie, storageClass);
                    v.storage_class = (v.storage_class | STC.foreach_) as STC;
                    if ((storageClass & STC.ref_) !== 0n)
                        v.storage_class = (v.storage_class | STC.ref_) as STC;
                    if (isStatic || (storageClass & STC.manifest) !== 0n || e.isConst() !== 0 ||
                        e.op === EXP.string_ ||
                        e.op === EXP.structLiteral ||
                        e.op === EXP.arrayLiteral) {
                        if ((v.storage_class & STC.ref_) !== 0n) {
                            if (!isStatic) {
                                // dmd/statementsem.d:4661 — `toChars(ie)` (hdrgen.d:212) is `initializerToChars`.
                                error(fs.loc, ds("constant value `%s` cannot be `ref`"), initializerToChars(ie));
                            } else {
                                if (!needExpansion) {
                                    // dmd/statementsem.d:4667 — `toChars(ie)`, as at :4661.
                                    error(fs.loc, ds("constant value `%s` cannot be `ref`"), initializerToChars(ie));
                                } else {
                                    error(fs.loc, ds("constant value `%s` cannot be `ref`"), ident.toChars());
                                }
                            }
                            return false;
                        } else
                            v.storage_class = (v.storage_class | STC.manifest) as STC;
                    }
                    var_ = v;
                }
            } else {
                var_ = AliasDeclaration.fromType(loc, ident, t!);
                if (paramtype !== null) {
                    error(fs.loc, ds("cannot specify element type for symbol `%s`"), ident.toChars());
                    return false;
                }
                if ((storageClass & STC.manifest) !== 0n) {
                    error(fs.loc, ds("invalid storage class `enum` for element `%s`"), ident.toChars());
                    return false;
                }
            }
            if (isStatic) {
                var_.storage_class = (var_.storage_class | STC.local) as STC;
            }

            if (isDecl)
                decls!.push(var_);
            else
                stmts!.push(ExpStatement.fromDsymbol(loc, var_));
            return true;
        };

        if (!isStatic) {
            // Declare value
            if (!declareVariable(p.storageClass, p.type, p.ident!, e, t)) {
                return returnEarly();
            }
        } else {
            if (!needExpansion) {
                // Declare value
                if (!declareVariable(p.storageClass, p.type, p.ident!, e, t)) {
                    return returnEarly();
                }
            } else {
                // expand tuples into multiple `static foreach` variables.
                assert(e !== null && t === null);
                const identValue = Identifier.generateId(ds("__value"));
                declareVariable(STC.none, e!.type, identValue, e, null);
                // `import dmd.cond: StaticForeach;` (dmd/statementsem.d:4732) — already at file scope.
                const field = Identifier.idPoolLen(StaticForeach.tupleFieldName,
                    StaticForeach.tupleFieldName.length);
                let access: Expression = new DotIdExp(loc, e, field);
                access = expressionSemantic(access, sc);
                access = optimize(access, WANTvalue);
                if (tuple === null) return returnEarly();
                //printf("%s\n",tuple.toChars());
                for (let l = 0; l < dim; l++) {
                    const cp: Parameter = fs.parameters!.opIndex(l)!;
                    let init_: Expression = new IndexExp(loc,
                        access, new IntegerExp(loc, BigInt(l), Type.tsize_t));
                    init_ = expressionSemantic(init_, sc);
                    assert(init_.type !== null);
                    declareVariable(p.storageClass, init_.type, cp.ident!, init_, null);
                }
            }
        }

        let s: Statement | null = null;
        let d: Dsymbol | null = null;
        if (isDecl)
            decls!.append(Dsymbol.arraySyntaxCopy(dbody));
        else {
            stmts!.push(fs._body!.syntaxCopy());
            s = new CompoundStatement(loc, stmts);
        }

        if (!isStatic) {
            s = new ScopeStatement(loc, s, fs.endloc);
        } else if (isDecl) {
            // `import dmd.attrib: ForwardingAttribDeclaration;` (dmd/statementsem.d:4766).
            d = new ForwardingAttribDeclaration(decls);
        } else {
            s = ForwardingStatement.fromStatement(loc, s);
        }

        if (isDecl)
            declarations!.push(d);
        else
            statements!.push(s);
    }

    if (!isStatic) {
        let res: Statement = new UnrolledLoopStatement(loc, statements);
        const ls = checkLabeledLoop(sc, fs);         // `if (LabelStatement ls = …)` (06 §2.6/§2.7)
        if (ls !== null)
            ls.gotoTarget = res;
        if (te !== null && te.e0 !== null)
            res = CompoundStatement.fromStatementList(loc, new ExpStatement(te.e0.loc, te.e0), res);
        result.statement = res;
    } else if (isDecl)
        result.decl = declarations;
    else
        result.statement = new CompoundStatement(loc, statements);

    return result;
}

/*********************************
 * dmd/statementsem.d:4806 — `private Statements* flatten(Statement statement, Scope* sc)`. D
 * module-private; emitted without `private` (01/10) — statementSemanticVisit calls it (dmd:255/:283/:432/:506) and
 * so does `makeTupleForeach`'s `static foreach` arm below.
 *
 * Flatten out the scope by presenting `statement`
 * as an array of statements.
 * Params:
 *     statement = the statement to flatten
 *     sc = context
 * Returns:
 *     The array of `Statements`, or `null` if no flattening necessary
 */
export function flatten(statement: Statement, sc: Scope): Statements | null {
    const errorStatements = (): Statements => {
        const a: Statements = DArray.from<Statement | null>(new ErrorStatement());
        return a;
    };

    /*compound and expression statements have classes that inherit from them with the same
     *flattening behavior, so the isXXX methods won't work
     */
    switch (statement.stmt) {
        case STMT.Compound:
        case STMT.CompoundDeclaration:
            // tag-proved RTTI downcast (02 §11.5c #3): the `case STMT.Compound / STMT.CompoundDeclaration`
            // labels immediately above ARE the tag proof, exactly as in D's `cast(CompoundStatement)
            // statement` — `isCompoundStatement()` cannot be used because a CompoundDeclarationStatement
            // carries its own STMT tag (that is what the D comment above says).
            return (statement as unknown as CompoundStatement).statements;

        case STMT.Exp:
        case STMT.DtorExp: {
            // tag-proved RTTI downcast (02 §11.5c #3): the two `case` labels are the tag proof for D's
            // `cast(ExpStatement)statement`; `isExpStatement()` misses the DtorExpStatement subclass.
            const es = statement as unknown as ExpStatement;
            /* https://issues.dlang.org/show_bug.cgi?id=14243
             * expand template mixin in statement scope
             * to handle variable destructors.
             */
            if (es.exp === null || es.exp.isDeclarationExp() === null)
                return null;

            const d: Dsymbol | null = es.exp.isDeclarationExp()!.declaration;
            const tm = d!.isTemplateMixin();
            if (tm === null)
                return null;

            const e: Expression = expressionSemantic(es.exp, sc);
            if (e.op === EXP.error || tm.errors)
                return errorStatements();
            assert(tm.members !== null);

            const s: Statement | null = toStatement(tm);
            // resolved: version(none){ OutBuffer/HdrGenState/toCBuffer/printf dump }
            // (dmd/statementsem.d:4845) -> OFF.
            const a: Statements = DArray.from<Statement | null>(s);
            return a;
        }

        case STMT.Forwarding: {
            /***********************
             * ForwardingStatements are distributed over the flattened
             * sequence of statements. This prevents flattening to be
             * "blocked" by a ForwardingStatement and is necessary, for
             * example, to support generating scope guards with `static
             * foreach`:
             *
             *     static foreach(i; 0 .. 10) scope(exit) writeln(i);
             *     writeln("this is printed first");
             *     // then, it prints 10, 9, 8, 7, ...
             */
            const fs = statement.isForwardingStatement()!;
            if (fs.statement === null) {
                return null;
            }
            // D `sc.push(fs.sym)` with a possibly-null `ss`: the no-arg push and a null `ss` both
            // leave `scopesym` null, so `?? undefined` is exact (dscope.ts push only assigns when
            // the argument is present).
            sc = sc.push(fs.sym ?? undefined);
            const a: Statements | null = flatten(fs.statement, sc);
            sc = sc.pop()!;   // the matching push() above guarantees an enclosing scope
            if (a === null) {
                return a;
            }
            const b: Statements = new DArray<Statement | null>(a.length);
            for (let i = 0; i < a.length; i++) {
                const s = a.opIndex(i);
                b.opIndexAssign(s !== null ? new ForwardingStatement(s.loc, fs.sym, s) : null, i);
            }
            return b;
        }

        case STMT.Conditional: {
            const cs = statement.isConditionalStatement()!;
            let s: Statement | null;

            //printf("ConditionalStatement::flatten()\n");
            // dmd/statementsem.d:4893 — `cs.condition.include(sc)` is UFCS for the free fn
            // `int include(Condition, Scope*)` (expressionsem.d:19582), import-aliased to keep it
            // apart from dsymbolsem's `include(Dsymbol, Scope*)`. `int` truthiness -> `!== 0`.
            if (conditionInclude(cs.condition!, sc) !== 0) {
                const dc = cs.condition!.isDebugCondition();
                if (dc !== null) {
                    s = new DebugStatement(cs.loc, cs.ifbody);
                } else
                    s = cs.ifbody;
            } else
                s = cs.elsebody;
            recordConditional(cs, sc);

            const a: Statements = DArray.from<Statement | null>(s);
            return a;
        }

        case STMT.StaticForeach: {
            const sfs = statement.isStaticForeachStatement()!;
            // dmd/statementsem.d:4911 — UFCS `sfs.sfe.prepare(sc)`.
            prepare(sfs.sfe!, sc);
            if (ready(sfs.sfe!)) {     // `sfs.sfe.ready()` UFCS -> the free fn at dmd:85
                const s: Statement | null =
                    makeTupleForeach(sc, true, false, sfs.sfe!.aggrfe!, null, sfs.sfe!.needExpansion).statement;
                let result: Statements | null = flatten(s!, sc);
                if (result !== null) {
                    return result;
                }
                result = DArray.from<Statement | null>(s);
                return result;
            } else
                return errorStatements();
        }

        case STMT.Debug: {
            const dbgs = statement.isDebugStatement()!;
            const a: Statements | null = dbgs.statement !== null ? flatten(dbgs.statement, sc) : null;
            if (a === null)
                return null;

            // `foreach (ref s; *a)` — a REF element loop: write back through the container (03 §4).
            for (let i = 0; i < a.length; i++) {
                a.opIndexAssign(new DebugStatement(dbgs.loc, a.opIndex(i)), i);
            }
            return a;
        }

        case STMT.Label: {
            const ls = statement.isLabelStatement()!;
            if (ls.statement === null)
                return null;

            let a: Statements | null = null;
            a = flatten(ls.statement, sc);
            if (a === null)
                return null;

            if (a.length === 0) {
                a.push(new ExpStatement(ls.loc, null));   // D `cast(Expression)null` selects this ctor
            }

            // reuse 'this' LabelStatement
            ls.statement = a.opIndex(0);
            a.opIndexAssign(ls, 0);
            return a;
        }

        case STMT.Mixin: {
            const cs = statement.isMixinStatement()!;

            const buf = new OutBuffer();
            // dmd/statementsem.d:4963.
            if (expressionsToString(buf, sc, cs.exps, cs.loc, null, true))
                return errorStatements();

            const errors = global.errors;
            const len = buf.length();
            buf.writeByte(0);
            const str: DString = buf.extractSlice().subarray(0, len);
            const doUnittests = global.params.parsingUnittestsRequired();
            // resolved: `new Parser!ASTCodegen(...)` -> the non-generic ported `Parser` (13 §3: the
            // `AST` template parameter is dropped). D's 6-arg ctor is the TS ctor with `loc = null`.
            const p = new Parser(null, sc._module, str, false, global.errorSink!, global.compileEnv,
                doUnittests);
            // dmd/statementsem.d:4972 — `*p.baseLoc` is a `ref BaseLoc` argument: alias, no copy
            // (03 §3.2).
            adjustLocForMixin(str, cs.loc, p.baseLoc!, global.params.mixinOut);
            p.linnum = p.baseLoc!.startLine;
            p.nextToken();

            const a: Statements = new DArray<Statement | null>();
            while (p.token.value !== TOK.endOfFile) {
                // parse.ts declares `parseStatement` non-null while D's can return null; the local is
                // widened so D's `if (!s || …)` test stays expressible and `s.loc` keeps D's own
                // fault point (02 §10.1).
                const s: Statement | null = p.parseStatement(ParseStatementFlags.curlyScope);
                if (s === null || global.errors !== errors) {
                    errorSupplemental(s!.loc, ds("while parsing string mixin statement"));
                    return errorStatements();
                }
                a.push(s);
            }
            return a;
        }
        default:
            return null;
    }
}

/***********************************************************
 * dmd/statementsem.d:5000 — `private Statement toStatement(Dsymbol s)`. D module-private; emitted
 * without `private` (01/10) — statementSemanticVisit calls it (dmd:316) and so does `flatten` above.
 *
 * Convert TemplateMixin members (which are Dsymbols) to Statements.
 * Params:
 *    s = the symbol to convert to a Statement
 * Returns:
 *    s redone as a Statement (null for symbols that are not statements at all)
 */
export function toStatement(s: Dsymbol): Statement | null {
    let result: Statement | null = null;

    const tm = s.isTemplateMixin();
    if (tm !== null) {
        const a: Statements = new DArray<Statement | null>();
        for (const m of tm.members!) {
            const sx: Statement | null = toStatement(m!);    // `if (Statement sx = toStatement(m))`
            if (sx !== null)
                a.push(sx);
        }
        result = new CompoundStatement(tm.loc, a);
    } else if (s.isVarDeclaration() !== null ||
               s.isAggregateDeclaration() !== null ||
               s.isFuncDeclaration() !== null ||
               s.isEnumDeclaration() !== null ||
               s.isAliasDeclaration() !== null ||
               s.isTemplateDeclaration() !== null) {
        /* Perhaps replace the above with isScopeDsymbol() || isDeclaration()
         */
        /* An actual declaration symbol will be converted to DeclarationExp
         * with ExpStatement.
         */
        const de = new DeclarationExp(s.loc, s);
        de.type = Type.tvoid; // avoid repeated semantic
        result = new ExpStatement(s.loc, de);
    } else {
        const d = s.isAttribDeclaration();
        if (d !== null) {
            /* All attributes have been already picked by the semantic analysis of
             * 'bottom' declarations (function, struct, class, etc).
             * So we don't have to copy them.
             */
            // dmd/statementsem.d:5036 — UFCS `d.include(null)` for the free fn
            // `include(Dsymbol, Scope*)` (dsymbolsem.d), import-aliased apart from
            // expressionsem's `include(Condition, Scope*)`.
            const a: Dsymbols | null = dsymbolInclude(d, null);
            if (a !== null) {
                const statements: Statements = new DArray<Statement | null>();
                for (const sx of a) {
                    statements.push(toStatement(sx!));
                }
                result = new CompoundStatement(d.loc, statements);
            }
        } else if (s.isStaticAssert() !== null ||
                   s.isImport() !== null) {
            /* Ignore as they are not Statements
             */
        } else {
            // `.error(...)` — the module-scope `error`, explicitly qualified in D.
            error(Loc.initial, ds("internal compiler error: cannot mixin %s `%s`\n"), s.kind(), s.toChars());
            result = new ErrorStatement();
        }
    }

    return result;
}

/**
 * dmd/statementsem.d:5069 — `private void debugThrowWalker(Statement s)`. D module-private; emitted
 * without `private` (01/10) — `visitDebug` calls it (dmd:3622).
 *
 * Marks all occurring ThrowStatements as internalThrows.
 * This is intended to be called from a DebugStatement as it allows
 * to mark all its nodes as nothrow.
 *
 * Params:
 *     s = AST Node to traverse
 */
export function debugThrowWalker(s: Statement | null): void {
    if (s === null)
        return;
    // dmd/statementsem.d:5073 — `extern(C++) final class DebugWalker : SemanticTimeTransitiveVisitor`,
    // a FUNCTION-LOCAL Idiom-A visitor (13 §1/§2): one named method per `visit` overload, `final`
    // erased (04 §8), and `alias visit = SemanticTimeTransitiveVisitor.visit;` dropped (13 §1).
    class DebugWalker extends SemanticTimeTransitiveVisitor {
        override visitThrowStatement(st: ThrowStatement): void {
            st.internalThrow = true;
        }

        override visitCallExp(e: CallExp): void {
            e.inDebugStatement = true;
        }
    }

    const walker = new DebugWalker();
    s.accept(walker);
}

/************************************
 * dmd/statementsem.d:5100 — `private bool checkLabel(SwitchStatement ss)`.
 *
 * 04 §1B Form-B overload set: `checkLabel(SwitchStatement)` and `checkLabel(GotoStatement)`
 * (dmd:5144) share arity and differ only by the receiver type, so ONE keeps the bare name and the
 * other takes the receiver-type suffix (04 §1B rule 1/2, the `hasPointers`/`hasPointersDsymbol`
 * shape). The Goto form keeps `checkLabel` — it is the form with the out-of-module dependent
 * (semantic3.d:1340). This one models `checkLabel(SwitchStatement)`; `visitSwitch` (dmd:2081
 * `ss.checkLabel()`) calls it as `checkLabelSwitchStatement(ss)`.
 *
 * Check for skipped variable declarations.
 * Params:
 *      ss = statement to check
 * Returns:
 *  true if error
 */
export function checkLabelSwitchStatement(ss: SwitchStatement): boolean {
    /*
     * Checks the scope of a label for existing variable declaration.
     * Params:
     *   vd = last variable declared before this case/default label
     * Returns: `true` if the variables declared in this label would be skipped.
     */
    const checkVar = (vd: VarDeclaration | null): boolean => {
        for (let v: VarDeclaration | null = vd; v !== null && v !== ss.lastVar; v = v.lastVar) {
            if (v.isDataseg() ||
                ((v.storage_class & ((STC.manifest | STC.temp) as STC)) !== 0n && vd!.ident !== Id.withSym) ||
                v._init!.isVoidInitializer() !== null)
                continue;
            if (vd!.ident === Id.withSym)
                error(ss.loc, ds("`switch` skips declaration of `with` temporary"));
            else
                error(ss.loc, ds("`switch` skips declaration of variable `%s`"), v.toPrettyChars());
            errorSupplemental(v.loc, ds("declared here"));
            return true;
        }
        return false;
    };

    // dmd/statementsem.d:5124 `enum error = true;` — RENAMED. A local `error` would put the module
    // import `error` (used by `checkVar` above) into the TDZ for this whole function body; the D name
    // is recorded here instead (02 §4.1 manifest constant -> `const`).
    const errorRet = true;

    if (ss.sdefault !== null && checkVar(ss.sdefault.lastVar))
        return !errorRet; // return error once fully deprecated

    for (const scase of ss.cases!) {
        if (scase !== null && checkVar(scase.lastVar))
            return !errorRet; // return error once fully deprecated
    }
    return !errorRet;
}

/**************
 * dmd/statementsem.d:5144 — `bool checkLabel(GotoStatement gs)`. Form-B sibling of
 * `checkLabelSwitchStatement` above (see its comment for the naming rule); this one KEEPS the bare
 * D name per 04 §1B rule 1 (it is the form with the out-of-module dependent). Exported:
 * semantic3.d:1340 calls it, as does `visitGoto` (dmd:3666).
 *
 * Check for skipped variable declarations.
 * Params:
 *      gs = statement to check
 * Returns: true for error
 */
export function checkLabel(gs: GotoStatement): boolean {
    if (gs.label!.statement === null)
        return true;        // error should have been issued for this already

    if (gs.label!.statement!.os !== gs.os) {
        if (gs.os !== null && gs.os.tok === TOK.onScopeFailure && gs.label!.statement!.os === null) {
            // Jump out from scope(failure) block is allowed.
        } else {
            if (gs.label!.statement!.os !== null)
                error(gs.loc, ds("cannot `goto` in to `%s` block"),
                    Token.toCharsValue(gs.label!.statement!.os!.tok));
            else
                error(gs.loc, ds("cannot `goto` out of `%s` block"), Token.toCharsValue(gs.os!.tok));
            return true;
        }
    }

    if (gs.label!.statement!.tf !== gs.tf) {
        error(gs.loc, ds("cannot `goto` in or out of `finally` block"));
        return true;
    }

    if (gs.label!.statement!.inCtfeBlock && !gs.inCtfeBlock) {
        error(gs.loc, ds("cannot `goto` into `if (__ctfe)` block"));
        return true;
    }

    let stbnext: Statement | null = null;
    for (let stb: Statement | null = gs.tryBody; stb !== gs.label!.statement!.tryBody; stb = stbnext) {
        if (stb === null) {
            error(gs.loc, ds("cannot `goto` into `try` block"));
            return true;
        }
        const stf = stb.isTryFinallyStatement();
        if (stf !== null)
            stbnext = stf.tryBody;
        else {
            const stc = stb.isTryCatchStatement();
            if (stc !== null)
                stbnext = stc.tryBody;
            else
                assertUnreachable();
        }
    }

    const vd: VarDeclaration | null = gs.label!.statement!.lastVar;
    if (vd === null || vd.isDataseg() || (vd.storage_class & STC.manifest) !== 0n)
        return false;

    let last: VarDeclaration | null = gs.lastVar;
    while (last !== null && last !== vd)
        last = last.lastVar;
    if (last === vd) {
        // All good, the label's scope has no variables
    } else if ((vd.storage_class & STC.exptemp) !== 0n) {
        // Lifetime ends at end of expression, so no issue with skipping the statement
    } else {
        if (vd.ident === Id.withSym)
            error(gs.loc, ds("`goto` skips declaration of `with` temporary"));
        else
            error(gs.loc, ds("`goto` skips declaration of variable `%s`"), vd.toPrettyChars());
        errorSupplemental(vd.loc, ds("declared here"));
        return true;
    }
    return false;
}
