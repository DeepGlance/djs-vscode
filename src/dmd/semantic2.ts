// Ported from dmd/semantic2.d (module dmd.semantic2) — WHOLE-FILE faithful translation (W3/S3).
//
// "Performs the semantic2 stage, which deals with initializer expressions."
//
// ---------------------------------------------------------------------------------------------
// TRANSLATION NOTES (the decisions a reader/reviewer needs, keyed to the guide)
// ---------------------------------------------------------------------------------------------
// * IDIOM CHECK (13 §7, mandatory precondition): `grep -c 'class .*Visitor' dmd/semantic2.d` -> 2
//   (`Semantic2Visitor` at semantic2.d:85, `StaticAAVisitor` at :1003). This is **Idiom A**: real
//   visitor CLASSES driven through `accept`, so each `void visit(X)` overload becomes the named
//   method `visit<X>` (13 §1) and there is NO trailing node-tag dispatch switch to emit (§7.5 does
//   not apply to this file). Each `alias visit = …visit;` line is DROPPED (13 §1).
// * D free functions are emitted AS FREE FUNCTIONS in the TS module mirroring their D module
//   (04 §6 anti-pattern; this wave unwinds the old re-homes): `semantic2`, `doGNUABITagSemantic`,
//   `findFunc`, `lowerStaticAAs` (×2 overloads), `staticAssertFail`. Every D `x.foo(y)` whose
//   `foo` is a free function of another module is unwound to `foo(x, y)`.
// * OVERLOAD SPLIT (04 §1B Form B, receiver-type suffix per §6.1): D declares TWO same-arity
//   `lowerStaticAAs` overloads, split by first-parameter type — `(VarDeclaration, Scope*)`
//   (semantic2.d:980) and `(Expression, Scope*)` (semantic2.d:996). No existing TS dependent
//   imports either (both current consumers hold walls), so the BARE name goes to the most-called D
//   form: the VarDeclaration one (4 D call sites — semantic2.d:250, dsymbolsem.d:3229,
//   expressionsem.d:6833, expressionsem.d:18998) keeps `lowerStaticAAs`; the Expression one
//   (1 D call site — enumsem.d:486) becomes `lowerStaticAAsExpression`, following the tree's
//   `newScope`/`newScopeDsymbol` and `hasPointers`/`hasPointersDsymbol` convention.
// * UFCS resolution (04 §6/§6.1), decided per call site by the receiver's type + this module's
//   imports — never by repo-wide grep:
//     - `s.semantic2(sc)`                -> THIS module's free `semantic2` (dsymbol.d declares no
//       `semantic2` member; verified by grep on dsymbol.d, which only carries the PASS enum names)
//     - `vd.dsymbolSemantic(sc)`         -> dsymbolsem.d free fn
//     - `ad.newScope(sc)` with `ad: AttribDeclaration` -> dsymbolsem.d:8980 `newScope(Dsymbol, …)`
//       = TS `newScopeDsymbol`; `ad.newScope(sc)` with `ad: AggregateDeclaration` ->
//       dsymbolsem.d:90 `newScope(AggregateDeclaration, …)` = TS `newScope`. Two DIFFERENT D
//       overloads, resolved by first-parameter type (04 §6.1), never conflated.
//     - `ad.include(sc)`                 -> dsymbolsem.d:9137 free fn `include(Dsymbol, Scope*)`
//     - `ad.determineSize(loc)`          -> dsymbolsem.d free fn (result discarded, as in D)
//     - `bfd.getMinMax(Id.min)`          -> dsymbolsem.d free fn
//     - `cd.isAbstract()` (ClassDeclaration, semantic2.d:726) -> dsymbolsem.d:9764 free fn
//       `isAbstract(ClassDeclaration)`; `fd.isAbstract` (semantic2.d:709) is the METHOD
//       `Declaration.isAbstract()` (declaration.d:139) — same name, different homes (04 §6.1).
//     - `cd.findFunc(ident, tf)`         -> THIS module's free `findFunc` (semantic2.d:863)
//     - `f1.overrides(f2)`               -> funcsem.d free fn `overrides` (returns int)
//     - `fd.type.covariant(tf)`          -> typesem.d free fn `covariant`
//     - `bfd.type.isUnsigned()` / `t.nextOf()` / `t.toBasetype()` -> typesem.d free fns
//     - `t.isMutable()` / `t.isShared()` -> Type METHODS (mtype.d:675/:680)
//     - `tf.equals(fd.type)`             -> Type METHOD (mtype.d) — the `equals` families the
//       manifest's §9 hazard row names (dsymbolsem/expressionsem) do NOT apply here.
//     - `e.expressionSemantic(sc)` / `e.toStringExp()` / `se.toUTF8(sc)` -> expressionsem.d free fns
//     - `vd._init.initializerSemantic(...)` -> initsem.d free fn
//     - `c.isValidMangling()`            -> mangle/package.d free fn (D imports it selectively at
//       semantic2.d:772)
//     - `e.toString()`                   -> RootObject METHOD (rootobject.d:47), NOT hdrgen's
//       `toString(const Initializer)` (hdrgen.d:267) — the receiver is an Expression (04 §6.1).
// * `evalStaticCondition` is reached through the module-level `import dmd.expressionsem;`
//   (it is declared at expressionsem.d:18421 in 1.43-beta1). dropped: the FUNCTION-LOCAL
//   `import dmd.staticcond;` (semantic2.d:111) — staticcond.d declares only
//   `visualizeStaticCondition`/`formatStaticCondition`, none of which this file names; the import
//   is vestigial upstream since `evalStaticCondition` moved into expressionsem.d.
// * dropped: `enum LOG = false;` (semantic2.d:73) — a translation-time gate only. Its six
//   `static if (LOG)` blocks (semantic2.d:131, :156, :188, :204, :553, :567) are all `printf`
//   traces; each is dropped with a `resolved:` comment at its D line (07 §3). Two of them carry a
//   `scope(exit) printf(...)`; dropping the begin/end PAIR together keeps the guard balanced, so
//   no try/finally is synthesized for them.
// * dropped: `timeTraceBeginEvent(TimeTraceEventType.sema2)` + `scope (exit)
//   timeTraceEndEvent(TimeTraceEventType.sema2, fd)` (semantic2.d:412-413) — `dmd.timetrace` is a
//   profiling-only module outside the port perimeter with no effect on the AST; the pair is
//   dropped together so the guard stays balanced (same disposition as dsymbolsem.ts:4017 and
//   funcsem.ts:454).
// * dropped: `import core.stdc.stdio;` / `import core.stdc.string;` (semantic2.d:14-15) — pulled in
//   only for the `printf` traces above and the commented-out ones (01 §3.7).
// * POINTER MODEL: `Expression* lastTag` (semantic2.d:625/:770) is a pointer to a CLASS reference.
//   02 §10 rule 1 collapses `Class*` to the reference itself, so the slot holds
//   `Expression | null`. The `ref` on the PARAMETER (`ref Expression* lastTag`) is what needs a
//   box: `{ value: Expression | null }` (03 §3.2/§7.2). `lastTag = &e;` therefore becomes
//   `lastTag.value = e;` — faithful here because D never writes THROUGH `lastTag` and the array
//   slot `&e` aliases is never re-assigned after the store (the `e = e.expressionSemantic(sc)` /
//   `e = e.ctfeInterpret()` writes both precede the `doGNUABITagSemantic` call in the same
//   iteration, and each iteration binds a different slot).
// * `Loc` is an ALIAS-SAFE REGISTER member (03 §9.1): shared, never `.copy()`-ed, no per-site
//   comment. `IntRange`/`SignExtendedNumber` are CONSTRUCTED here, never copied out of a container
//   (the `IntRange` constructor copies both bounds it stores; intrange.ts COPY DISCIPLINE header).
//   BY-VALUE struct arguments: `IntRange` into `IntRange.contains` (intrange.d:420) elides the
//   call-site copy (03 §9: `contains` never mutates its argument, per the intrange.ts header);
//   `ParameterList` into `parametersTypeToChars` (hdrgen.d:3618) keeps the §1#2 call-site copy.
// * `ctfeInterpret` / `ctfeInterpretForPragmaMsg` (dmd/dinterpret.d) are live in dinterpret.ts and
//   called at D's positions; this file carries no wall of its own.
// * GAG PAIRING (11 §2.5, last bullet): `global.gag` is a process-global counter and walls reached
//   transitively through the callees are exit paths D does not have, so the `startGagging`/`endGagging` region in
//   `visitTemplateInstance` is wrapped in `try { … } catch (ex) { endGagging; throw ex; }` — the
//   same shape enumsem.ts/typesem.ts use. Likewise `vd.inuse++` … `vd.inuse--`
//   (semantic2.d:235/:251) is a set/reset pair whose region contains the `initializerSemantic`
//   call, so it becomes `try { … } finally { vd.inuse--; }` even though D needs no guard.
// * DEPENDENCY-SIGNATURE notes (11 §1, reported — NOT fixed here, 14 §2 rule 1):
//   (a) `ParameterList.opApply`'s delegate type is `ParameterForeachDg = (paramidx: number,
//       param: Parameter) => number` (mtype.ts:4219), but semantic2.d:528 NULL-TESTS `param`, so
//       by 02 §10.1 the delegate parameter should be `Parameter | null`. TS function-parameter
//       contravariance lets the faithful (widened) handler be passed anyway, so the body here is
//       written faithfully and the record is filed against mtype.ts.
//   (b) `Scope.push(ss?: ScopeDsymbol)` (dscope.ts:604) cannot express the null D passes at
//       semantic2.d:144 (`sc.push(tempinst.argsym)` with a null `argsym`). `?? undefined` would
//       DIVERGE (it leaves `scopesym` inherited instead of nulled), so the call keeps the D value
//       and bridges the type with `!`; at runtime `push` sees `null` and assigns
//       `scopesym = null`, exactly as D does.
//   (c) `RootObject.toString()` (rootobject.ts) forwards `toChars()` unchanged, but `toChars()` is
//       NUL-TERMINATED in this tree (`OutBuffer.extractChars`, outbuffer.ts:566-573), whereas D's
//       `toString()` (rootobject.d:45-51) slices at `strlen`. The `%.*s` windows at semantic2.d:807
//       are computed off `.length`, so they currently keep one byte too many. The site stays
//       D-faithful and the record is filed against rootobject.ts.

import { Visitor, SemanticTimeTransitiveVisitor } from "./visitor/index.js";
import { K, KeepUnit, keepMark, keepMember, keepPass, keepReq, keepRun, keepUnwind } from "../keep.js";
import { PASS, ScopeDsymbol } from "./dsymbol.js";
import { global } from "./globals.js";
import { error, errorSupplemental, deprecation, deprecationSupplemental, fatal } from "./errors.js";
import { STC, LINK, MATCH, Tclass, Tpointer, Tstruct, Tfunction } from "./astenums.js";
import { ClassKind } from "./aggregate.js";
import { Type, Covariant } from "./mtype.js";
import { EXP } from "./tokens.js";
import { Id } from "./id.js";
import { INITinterpret, INITnointerpret } from "./init.js";
import { IntRange, SignExtendedNumber } from "./intrange.js";
import { OutBuffer } from "./common/outbuffer.js";
import { assert } from "../assert.js";
import { ds } from "../dstring.js";
import {
    checkGNUABITag,
    determineSize,
    dsymbolSemantic,
    getAlignment,
    getMessage,
    getMinMax,
    include,
    isAbstract,
    isGNUABITag,
    newScope,
    newScopeDsymbol,
    scopeCreateGlobal,
} from "./dsymbolsem.js";
import {
    evalStaticCondition,
    expressionSemantic,
    resolveProperties,
    semanticTypeInfo,
    toStringExp,
    toUTF8,
} from "./expressionsem.js";
import { initializerSemantic } from "./initsem.js";
import { overloadApply, overrides } from "./funcsem.js";
import { getIntRange } from "./dcast.js";
import { linkageToChars, parametersTypeToChars } from "./hdrgen.js";
import { isValidMangling } from "./mangle/index.js";
import { definitelyValueParameter } from "./dtemplate.js";
import { covariant, isUnsigned, nextOf, toBasetype } from "./typesem.js";
// dmd/semantic2.d:31 (`import dmd.dinterpret;`) — added by the wave-14 sweep. LAST (01 §4.8):
// dinterpret.ts value-imports this module back (`findFunc`) and the core SCC.
import { ctfeInterpret, ctfeInterpretForPragmaMsg } from "./dinterpret.js";

import type { Dsymbol } from "./dsymbol.js";
import type { Dsymbols, Expressions } from "./arraytypes.js";
import type { Scope } from "./dscope.js";
import type { StaticAssert } from "./staticassert.js";
import type { TemplateInstance, TemplateMixin } from "./dtemplate.js";
import type { BitFieldDeclaration, TupleDeclaration, VarDeclaration } from "./declaration.js";
import type { Module } from "./dmodule.js";
import type { FuncDeclaration } from "./func.js";
import type { Import } from "./dimport.js";
import type { Nspace } from "./nspace.js";
import type {
    AlignDeclaration,
    AttribDeclaration,
    CPPNamespaceDeclaration,
    DeprecatedDeclaration,
    UserAttributeDeclaration,
} from "./attrib.js";
import type { AggregateDeclaration } from "./aggregate.js";
import type { ClassDeclaration, InterfaceDeclaration } from "./dclass.js";
import type { Expression, AssocArrayLiteralExp, ClassReferenceExp } from "./expression.js";
import type { Parameter, TypeFunction } from "./mtype.js";
import type { Identifier } from "./identifier.js";

/*************************************
 * dmd/semantic2.d:79 — `void semantic2(Dsymbol dsym, Scope* sc)`.
 *
 * Does semantic analysis on initializers and members of aggregates.
 *
 * Preconditions: `dsym` is non-null (every D call site dereferences it through `accept`).
 * `sc` may be null — `visit(Import)` (semantic2.d:539) calls `i.mod.semantic2(null)` deliberately.
 * Postconditions: `dsym` is routed to its `visit<X>` override (13 §2); most symbols are a no-op
 * (the base `visit(Dsymbol)` is empty).
 */
export function semantic2(dsym: Dsymbol, sc: Scope | null): void {
    const v = new Semantic2Visitor(sc);
    const k = K.on ? keepMark() : 0;     // the kept-module engine: closes the unit a visitor below opens
    dsym.accept(v);
    if (K.on) keepUnwind(k);
}

/***********************************************************
 * dmd/semantic2.d:85 — `private extern(C++) final class Semantic2Visitor : Visitor`.
 *
 * D module-private; emitted WITHOUT `private`/unexported-restriction so the co-located test file
 * can name it (01-conventions "D `private` member (MODULE-scoped)"). `final` erases (04 §8).
 */
export class Semantic2Visitor extends Visitor {
    // dropped: alias visit = Visitor.visit — no overload hiding in TS (13 §1)

    sc: Scope | null;

    /// dmd/semantic2.d:89 — `this(Scope* sc) scope @safe`. `scope`/`@safe` erase (04 §8).
    constructor(sc: Scope | null) {
        super();
        this.sc = sc;
    }

    /// dmd/semantic2.d:94 — `override void visit(Dsymbol) {}`. Most symbols have no semantic2 work.
    override visitDsymbol(_s: Dsymbol): void {}

    /// dmd/semantic2.d:96 — `override void visit(StaticAssert sa)`.
    override visitStaticAssert(sa: StaticAssert): void {
        // dropped: `//printf("StaticAssert::semantic2() %s\n", sa.toChars());` (semantic2.d:98)
        // 06 §2.6 — declaration in a condition is hoisted to a `const`, then null-tested (§2.7).
        const e = sa.exp!.isStringExp();
        if (e !== null) {
            // deprecated in 2.107
            deprecation(e.loc, ds("static assert condition cannot be a string literal"));
            deprecationSupplemental(e.loc,
                ds("If intentional, use `%s !is null` instead to preserve behaviour"),
                e.toChars());
        }
        const sds = new ScopeDsymbol();
        this.sc = this.sc!.push(sds);
        this.sc.tinst = null;
        this.sc.minst = null;

        // dropped: `import dmd.staticcond;` (semantic2.d:111) — see the file header.
        // `out bool errors` -> one-slot box, RESET on entry by the callee (03 §3.3).
        const errors = { value: false };
        const result = evalStaticCondition(this.sc, sa.exp!, sa.exp!, errors);
        this.sc = this.sc.pop();
        if (errors.value) {
            errorSupplemental(sa.loc, ds("while evaluating: `static assert(%s)`"), sa.exp!.toChars());
            return;
        } else if (result)
            return;

        staticAssertFail(sa, this.sc!);
    }

    /// dmd/semantic2.d:126 — `override void visit(TemplateInstance tempinst)`.
    override visitTemplateInstance(tempinst: TemplateInstance): void {
        if (tempinst.semanticRun >= PASS.semantic2) {
            if (K.on) keepReq(tempinst, KeepUnit.isem2);   // the kept-module engine: a request of a unit that ran
            return;
        }
        if (K.on && keepRun(tempinst, KeepUnit.isem2))     // the kept-module engine: replays a kept unit, or records
            return;
        tempinst.semanticRun = PASS.semantic2;
        // resolved: static if (LOG) (semantic2.d:131-135) -> LOG is false; the `+`/`-` printf pair
        // (a printf plus its `scope(exit)` printf) is dropped as a unit, so nothing is unbalanced.
        if (tempinst.errors || tempinst.members === null)
            return;

        const tempdecl = tempinst.tempdecl!.isTemplateDeclaration();
        assert(tempdecl !== null);

        this.sc = tempdecl._scope;
        assert(this.sc !== null);
        // `sc.push(tempinst.argsym)` — D's `argsym` may be null and `push` then nulls `scopesym`;
        // the `!` is the typing bridge for `push(ss?: ScopeDsymbol)` (header note (b)), not a
        // fault marker.
        this.sc = this.sc.push(tempinst.argsym!);
        this.sc = this.sc.push(tempinst);
        this.sc.tinst = tempinst;
        this.sc.minst = tempinst.minst;

        const needGagging = tempinst.gagged && global.gag === 0;
        const olderrors = global.errors;
        const oldGaggedErrors = needGagging ? global.startGagging() : -1;

        // 11 §2.5 (last bullet): the walls reachable through `semantic2(s, …)` are exit paths D does
        // not have; without this guard a throw would leak the gag and silence every later diagnostic.
        try {
            for (let i = 0; i < tempinst.members.length; i++) {
                const s = tempinst.members.opIndex(i);
                // resolved: static if (LOG) (semantic2.d:156-159) -> LOG is false; printf dropped.
                semantic2(s!, this.sc);
                if (tempinst.gagged && global.errors !== olderrors)
                    break;
            }

            if (global.errors !== olderrors) {
                if (!tempinst.errors) {
                    if (!tempdecl.literal)
                        error(tempinst.loc, ds("%s `%s` error instantiating"),
                            tempinst.kind(), tempinst.toPrettyChars());
                    if (tempinst.tinst !== null)
                        tempinst.tinst.printInstantiationTrace();
                }
                tempinst.errors = true;
            }
        } catch (ex) {
            if (needGagging)
                global.endGagging(oldGaggedErrors);
            throw ex;
        }
        if (needGagging)
            global.endGagging(oldGaggedErrors);

        this.sc = this.sc.pop();
        this.sc!.pop();
    }

    /// dmd/semantic2.d:183 — `override void visit(TemplateMixin tmix)`.
    override visitTemplateMixin(tmix: TemplateMixin): void {
        if (tmix.semanticRun >= PASS.semantic2)
            return;
        tmix.semanticRun = PASS.semantic2;
        // resolved: static if (LOG) (semantic2.d:188-192) -> LOG is false; the printf pair dropped.
        if (tmix.members === null)
            return;

        assert(this.sc !== null);
        // See the `argsym` note above.
        this.sc = this.sc.push(tmix.argsym!);
        this.sc = this.sc.push(tmix);
        this.sc.tinst = tmix;
        this.sc.minst = tmix.minst;
        for (let i = 0; i < tmix.members.length; i++) {
            const s = tmix.members.opIndex(i);
            // resolved: static if (LOG) (semantic2.d:204-207) -> LOG is false; printf dropped.
            semantic2(s!, this.sc);
        }
        this.sc = this.sc.pop();
        this.sc!.pop();
    }

    /// dmd/semantic2.d:214 — `override void visit(VarDeclaration vd)`.
    override visitVarDeclaration(vd: VarDeclaration): void {
        // `vd.inuse` is a counter (short) -> numeric truthiness made explicit (06 §2.5).
        if (vd.semanticRun < PASS.semanticdone && vd.inuse !== 0)
            return;

        // dropped: `//printf("VarDeclaration::semantic2('%s')\n", toChars());` (semantic2.d:219)
        this.sc = this.sc!.push();
        this.sc.varDecl = vd;
        // `scope(exit) sc = sc.pop();` (semantic2.d:222) -> try/finally (06 §7.1).
        try {
            if (vd.aliasTuple !== null) {       // if it's a tuple
                vd.aliasTuple.accept(this);
                vd.semanticRun = PASS.semantic2done;
                return;
            }

            checkGNUABITag(vd, vd._linkage);

            if (vd._init !== null && vd.toParent()!.isFuncDeclaration() === null) {
                vd.inuse++;
                // 11 §2.5: `inuse` is a set/reset pair whose region contains walls reachable through
                // `initializerSemantic`/`lowerStaticAAs`; D needs no guard, the port does.
                try {
                    /* https://issues.dlang.org/show_bug.cgi?id=20280
                     *
                     * Template instances may import modules that have not
                     * finished semantic1.
                     */
                    if (vd.type === null)
                        dsymbolSemantic(vd, this.sc);

                    // https://issues.dlang.org/show_bug.cgi?id=14166
                    // https://issues.dlang.org/show_bug.cgi?id=20417
                    // Don't run CTFE for the temporary variables inside typeof or __traits(compiles)
                    // `ref Type tx` (dmd/initsem.d:105) -> a LIVE alias to the field `vd.type`
                    // (03 §3.2/§7.2), not a snapshot: D binds the ref to the field itself, so the
                    // callee reads the CURRENT `vd.type` and `vd.type` is written ONLY when the
                    // callee writes `tx`. A snapshot + unconditional write-back would add a store D
                    // never performs and would clobber a type set through any other path re-entered
                    // from `initializerSemantic`. Same accessor-box shape as expressionsem.ts:7835.
                    const vdTypeRef: { value: Type } = {
                        get value(): Type { return vd.type!; },
                        set value(t: Type) { vd.type = t; },
                    };
                    vd._init = initializerSemantic(vd._init, this.sc, vdTypeRef,
                        this.sc.intypeof === 1 || this.sc.traitsCompiles ? INITnointerpret : INITinterpret);
                    lowerStaticAAs(vd, this.sc);
                } finally {
                    vd.inuse--;
                }
            }
            // `vd.storage_class & STC.manifest` — STC is the 64-bit branded flag set (bigint domain,
            // 02 §4.2 / 09 §4.2); numeric truthiness made explicit (06 §2.5).
            if (vd._init !== null && (vd.storage_class & STC.manifest) !== 0n) {
                /* Cannot initializer enums with CTFE classreferences and addresses of struct literals.
                 * Scan initializer looking for them. Issue error if found.
                 */
                const ei = vd._init.isExpInitializer();
                if (ei !== null) {
                    // semantic2.d:260 — nested `static bool hasInvalidEnumInitializer(Expression e)`,
                    // itself containing `static bool arrayHasInvalidEnumInitializer(Expressions*)`
                    // (semantic2.d:262). Both -> inner `const` arrows (04 §5); the inner one recurses
                    // back into the outer, which is legal because the call happens after definition.
                    const hasInvalidEnumInitializer = (e: Expression): boolean => {
                        const arrayHasInvalidEnumInitializer = (elems: Expressions | null): boolean => {
                            // `foreach (e; *elems)` — the inner `e` SHADOWS the outer parameter in D
                            // too; the name is kept verbatim (01 §2). Slots are nullable (08 §3).
                            // `*elems` DEREFERENCES an `Expressions*`, so a null pointer faults in D;
                            // the `!` marks that same crash point (02 §10.1) — this is NOT the
                            // null-slice case of 06 §2.7 (that one is a slice, not a pointer).
                            for (const e of elems!) {
                                if (e !== null && hasInvalidEnumInitializer(e))
                                    return true;
                            }
                            return false;
                        };

                        if (e.op === EXP.classReference)
                            return true;
                        if (e.op === EXP.address && e.isAddrExp()!.e1!.op === EXP.structLiteral)
                            return true;
                        if (e.op === EXP.arrayLiteral)
                            return arrayHasInvalidEnumInitializer(e.isArrayLiteralExp()!.elements);
                        if (e.op === EXP.structLiteral)
                            return arrayHasInvalidEnumInitializer(e.isStructLiteralExp()!.elements);
                        if (e.op === EXP.assocArrayLiteral) {
                            const ae = e.isAssocArrayLiteralExp()!;
                            return arrayHasInvalidEnumInitializer(ae.values) ||
                                   arrayHasInvalidEnumInitializer(ae.keys);
                        }
                        return false;
                    };

                    if (hasInvalidEnumInitializer(ei.exp!)) {
                        error(vd.loc,
                            ds("%s `%s` : Unable to initialize enum with class or pointer to struct"),
                            vd.kind(), vd.toPrettyChars());
                        errorSupplemental(vd.loc, ds("use static const variable instead"));
                    }
                }
            } else if (vd._init !== null && vd.isThreadlocal()) {
                // Cannot initialize a thread-local class or pointer to struct variable with a literal
                // that itself is a thread-local reference and would need dynamic initialization also.
                if (vd.type!.ty === Tclass && vd.type!.isMutable() && !vd.type!.isShared()) {
                    const ei = vd._init.isExpInitializer();
                    if (ei !== null && ei.exp!.op === EXP.classReference) {
                        error(vd.loc,
                            ds("%s `%s` is a thread-local class and cannot have a static initializer"),
                            vd.kind(), vd.toPrettyChars());
                        errorSupplemental(vd.loc, ds("use `static this()` to initialize instead"));
                    }
                } else if (vd.type!.ty === Tpointer && nextOf(vd.type!)!.ty === Tstruct &&
                           nextOf(vd.type!)!.isMutable() && !nextOf(vd.type!)!.isShared()) {
                    const ei = vd._init.isExpInitializer();
                    if (ei !== null && ei.exp!.op === EXP.address &&
                        ei.exp!.isAddrExp()!.e1!.op === EXP.structLiteral) {
                        error(vd.loc,
                            ds("%s `%s` is a thread-local pointer to struct and cannot have a static initializer"),
                            vd.kind(), vd.toPrettyChars());
                        errorSupplemental(vd.loc, ds("use `static this()` to initialize instead"));
                    }
                }
            }
            vd.semanticRun = PASS.semantic2done;
        } finally {
            this.sc = this.sc!.pop();
        }
    }

    /// dmd/semantic2.d:323 — `override void visit(BitFieldDeclaration bfd)`.
    override visitBitFieldDeclaration(bfd: BitFieldDeclaration): void {
        this.visitVarDeclaration(bfd);          // `visit(cast(VarDeclaration)bfd)` (13 §4)
        if (bfd.semanticRun !== PASS.semantic2done)
            return;

        if (bfd.fieldWidth === 0)
            return;

        if (bfd._init === null)
            return;

        const ei = bfd._init.isExpInitializer();
        if (ei === null)
            return;

        if (ei.exp!.isIntegerExp() === null)
            return;

        // dropped: `import dmd.intrange;` (semantic2.d:342) — a function-local import; `IntRange` and
        // `SignExtendedNumber` are imported at module level here (01 §3.5).
        const value = getIntRange(ei.exp!);

        const isUnsignedV = isUnsigned(bfd.type!);
        const bounds = new IntRange(
            new SignExtendedNumber(getMinMax(bfd, Id.min!), !isUnsignedV),
            new SignExtendedNumber(getMinMax(bfd, Id.max!), false),
        );

        // `contains` does not mutate its by-value argument: copy elided (03 §9).
        if (!bounds.contains(value)) {
            const uwidth = bfd.fieldWidth;
            error(ei.loc, ds("default initializer `%s` is not representable as bitfield type `%s:%lld`"),
                ei.exp!.toChars(), toBasetype(bfd.type!).toChars(), BigInt(uwidth));
            if (isUnsignedV)
                errorSupplemental(bfd.loc,
                    ds("bitfield `%s` default initializer must be a value between `%llu..%llu`"),
                    bfd.toChars(), bounds.imin.value, bounds.imax.value);
            else
                // `imin.value`/`imax.value` are `uinteger_t` (unsigned 64-bit patterns): `getMinMax`
                // stores the SIGNED minimum as `BigInt.asUintN(64, -(1n << (w-1n)))`
                // (dsymbolsem.d:279 returns `ulong`). D hands those bits to C `printf`, whose `%lld`
                // REINTERPRETS them as `long long` (`int x:8` prints `-128..127`). dmdformat's `%d`
                // reads the bigint's own sign and skips the `ll` length modifier, so the signed
                // reinterpretation must be explicit here (09 §2/§3.1). The `%llu` arm above is
                // genuinely unsigned and stays as-is.
                errorSupplemental(bfd.loc,
                    ds("bitfield `%s` default initializer must be a value between `%lld..%lld`"),
                    bfd.toChars(), BigInt.asIntN(64, bounds.imin.value), BigInt.asIntN(64, bounds.imax.value));
        }
    }

    /// dmd/semantic2.d:365 — `override void visit(Module mod)`.
    override visitModule(mod: Module): void {
        // dropped: `//printf("Module::semantic2('%s'): parent = %p\n", toChars(), parent);` (D:367)
        if (mod.semanticRun !== PASS.semanticdone) { // semantic() not completed yet - could be recursive call
            if (K.on) keepReq(mod, KeepUnit.sem2);   // the kept-module engine: a request of a unit that ran
            return;
        }
        // the kept-module engine: replays the kept loop over the parsed members, or records
        const from = K.on ? keepPass(mod, KeepUnit.sem2) : 0;
        mod.semanticRun = PASS.semantic2;
        // Note that modules get their own scope, from scratch.
        // This is so regardless of where in the syntax a module
        // gets imported, it is unaffected by context.
        // The D local `Scope* sc` SHADOWS the visitor's `sc` field for the rest of this method.
        let sc: Scope | null = scopeCreateGlobal(mod, global.errorSink!); // create root scope
        // dropped: `//printf("Module = %p\n", sc.scopesym);` (semantic2.d:375)
        if (mod.members !== null) {
            // Pass 2 semantic routines: do initializers and function bodies
            for (let i = from; i < mod.members.length; i++) {
                if (K.on) keepMember(mod, i);   // the kept-module engine: the members this compile appended
                const s = mod.members.opIndex(i);
                semantic2(s!, sc);
            }
        }
        // D writes `mod.userAttribDecl` twice (test + call); the accessor is a pure field read, so
        // the hoist is behaviour-preserving (same shape as semantic3.ts's `visitModule`).
        const uad = mod.userAttribDecl();
        if (uad !== null) {
            semantic2(uad, sc);
        }
        sc = sc.pop();
        sc!.pop();       // 2 pops because scopeCreateGlobal() created 2
        mod.semanticRun = PASS.semantic2done;
        // dropped: `//printf("-Module::semantic2('%s'): parent = %p\n", toChars(), parent);` (D:392)
    }

    /// dmd/semantic2.d:395 — `override void visit(FuncDeclaration fd)`.
    override visitFuncDeclaration(fd: FuncDeclaration): void {
        if (fd.semanticRun >= PASS.semantic2done)
            return;

        if (fd.semanticRun < PASS.semanticdone && !fd.errors) {
            /* https://issues.dlang.org/show_bug.cgi?id=21614
             *
             * Template instances may import modules that have not
             * finished semantic1.
             */
            dsymbolSemantic(fd, this.sc);
        }
        assert(fd.semanticRun <= PASS.semantic2);
        fd.semanticRun = PASS.semantic2;

        // dropped: timeTraceBeginEvent(TimeTraceEventType.sema2) + its `scope(exit)`
        // timeTraceEndEvent (semantic2.d:412-413) — see the file header.

        // dropped: `//printf("FuncDeclaration::semantic2 [%s] fd: %s type: %s\n", …);` (D:415)

        // Only check valid functions which have a body to avoid errors
        // for multiple declarations, e.g.
        // void foo();
        // void foo();
        if (fd.fbody !== null && fd.overnext !== null && !fd.errors) {
            // Always starts the lookup from 'this', because the conflicts with
            // previous overloads are already reported.
            const f1 = fd;                        // `alias f1 = fd;` -> local rebind (02 §5.3)
            // `cast(TypeFunction) f1.type` is a CLASS cast: a null or non-function `type` yields
            // null, it does not fault (05 §10). The dereferences below carry `!` at exactly the
            // sites where D would fault.
            const tf1: TypeFunction | null = f1.type === null ? null : f1.type.isTypeFunction();
            const parent1 = f1.toParent2();
            const linkage1 = f1.resolvedLinkage();

            overloadApply(f1, (s: Dsymbol): number => {
                const f2 = s.isFuncDeclaration();
                if (f2 === null || f1 === f2 || f2.errors)
                    return 0;

                // Don't have to check conflict between declaration and definition.
                if (f2.fbody === null)
                    return 0;

                // Functions with different manglings can never conflict
                if (linkage1 !== f2.resolvedLinkage())
                    return 0;

                // Functions with different names never conflict
                // (they can form overloads sets introduced by an alias)
                if (f1.ident !== f2.ident)
                    return 0;

                // Functions with different parents never conflict
                // (E.g. when aliasing a free function into a struct)
                if (parent1 !== f2.toParent2())
                    return 0;

                /* Check for overload merging with base class member functions.
                 *
                 *  class B { void foo() {} }
                 *  class D : B {
                 *    override void foo() {}    // B.foo appears as f2
                 *    alias foo = B.foo;
                 *  }
                 */
                if (overrides(f1, f2) !== 0)
                    return 0;

                const tf2: TypeFunction | null = f2.type === null ? null : f2.type.isTypeFunction();

                // Overloading based on storage classes
                if (tf1!.mod !== tf2!.mod ||
                    ((f1.storage_class ^ f2.storage_class) & STC.static_) !== 0n)
                    return 0;

                // @@@DEPRECATED_2.112@@@
                // This test doesn't catch identical functions that differ only
                // in explicit/implicit `@system` - a deprecation has now been
                // added below, remove `false` after deprecation period is over.
                const sameAttr = tf1!.attributesEqual(tf2!, false);
                const sameParams = tf1!.parameterList.opEquals(tf2!.parameterList);

                // Allow the hack to declare overloads with different parameters/STC's
                if (parent1!.isModule() !== null &&
                    linkage1 !== LINK.d && linkage1 !== LINK.cpp &&
                    (!sameAttr || !sameParams)
                ) {
                    error(f2.loc, ds("%s `%s` cannot overload `extern(%s)` function at %s"),
                        f2.kind(), f2.toPrettyChars(),
                        linkageToChars(f1._linkage),
                        f1.loc.toChars());
                    return 0;
                }

                // Different parameters don't conflict in extern(C++/D)
                if (!sameParams)
                    return 0;

                // Different attributes don't conflict in extern(D)
                if (!sameAttr && linkage1 === LINK.d) {
                    // @@@DEPRECATED_2.112@@@
                    // Same as 2.104 deprecation, but also catching explicit/implicit `@system`
                    // At the end of deprecation period, fix Type.attributesEqual and remove
                    // this condition, as well as the error for extern(C) functions above.
                    if (sameAttr !== tf1!.attributesEqual(tf2!)) {
                        deprecation(f2.loc, ds("%s `%s` cannot overload `extern(%s)` function at %s"),
                            f2.kind(), f2.toPrettyChars(),
                            linkageToChars(f1._linkage),
                            f1.loc.toChars());
                    }
                    return 0;
                }

                error(f2.loc, ds("%s `%s%s` conflicts with previous declaration at %s"),
                    f2.kind(),
                    f2.toPrettyChars(),
                    // `parametersTypeToChars(ParameterList pl)` (dmd/hdrgen.d:3618) takes `pl` BY
                    // VALUE and `ParameterList` is not an alias-safe register member (03 §9.1 lists
                    // `Loc` only) -> copy at the call site (03 §1#2/§3.1). Contrast the
                    // `opEquals(scope ref ParameterList)` call above (mtype.d:2233), a `ref` alias
                    // that correctly takes no copy (03 §3.2).
                    parametersTypeToChars(tf2!.parameterList.copy()),
                    f1.loc.toChars());
                f2.type = Type.terror;
                f2.errors = true;
                return 0;
            });
        }
        if (fd.type === null || fd.type.ty !== Tfunction)
            return;
        const f = fd.type.isTypeFunction()!;      // `cast(TypeFunction) fd.type`, ty proved above

        checkGNUABITag(fd, fd._linkage);
        //semantic for parameters' UDAs
        // `foreach (i, param; f.parameterList)` drives `ParameterList.opApply` (05 §11 / 06 §1.8):
        // the callback returns D's control code, 0 = continue. `param` is typed `Parameter | null`
        // because this body null-tests it (02 §10.1); see dependency-signature note (a).
        f.parameterList.opApply((_i: number, param: Parameter | null): number => {
            if (param !== null && param.userAttribDecl !== null)
                semantic2(param.userAttribDecl, this.sc);
            return 0;
        });
    }

    /// dmd/semantic2.d:533 — `override void visit(Import i)`.
    override visitImport(i: Import): void {
        // dropped: `//printf("Import::semantic2('%s')\n", toChars());` (semantic2.d:535)
        if (i.mod === null)
            return;

        // upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool)
        semantic2(i.mod as unknown as Dsymbol, null);
        if (i.mod.needmoduleinfo !== 0) {
            // dropped: `//printf("module5 %s because of %s\n", …);` (semantic2.d:542)
            if (this.sc !== null)
                this.sc._module!.needmoduleinfo = 1;
        }
    }

    /// dmd/semantic2.d:548 — `override void visit(Nspace ns)`.
    override visitNspace(ns: Nspace): void {
        if (ns.semanticRun >= PASS.semantic2)
            return;
        ns.semanticRun = PASS.semantic2;
        // resolved: static if (LOG) (semantic2.d:553-557) -> LOG is false; the printf pair dropped.
        checkGNUABITag(ns, LINK.cpp);
        if (ns.members === null)
            return;

        assert(this.sc !== null);
        this.sc = this.sc.push(ns);
        this.sc.linkage = LINK.cpp;
        for (const s of ns.members) {
            // resolved: static if (LOG) (semantic2.d:567-570) -> LOG is false; printf dropped.
            semantic2(s!, this.sc);
        }
        // D writes `sc.pop();` here (NOT `sc = sc.pop()`), so the field keeps pointing at the
        // pushed scope — reproduced verbatim.
        this.sc.pop();
    }

    /// dmd/semantic2.d:576 — `override void visit(AttribDeclaration ad)`.
    override visitAttribDeclaration(ad: AttribDeclaration): void {
        const d = include(ad, this.sc);
        if (d === null)
            return;

        const sc2 = newScopeDsymbol(ad, this.sc);
        for (let i = 0; i < d.length; i++) {
            const s = d.opIndex(i);
            semantic2(s!, sc2);
        }
        if (sc2 !== this.sc)
            sc2!.pop();
    }

    /**
     * dmd/semantic2.d:602 — `override void visit(DeprecatedDeclaration dd)`.
     *
     * Run the DeprecatedDeclaration's semantic2 phase then its members.
     *
     * The message set via a `DeprecatedDeclaration` can be either of:
     * - a string literal
     * - an enum
     * - a static immutable
     * So we need to call ctfe to resolve it.
     * Afterward forwards to the members' semantic2.
     */
    override visitDeprecatedDeclaration(dd: DeprecatedDeclaration): void {
        getMessage(dd);
        this.visitAttribDeclaration(dd);         // `visit(cast(AttribDeclaration)dd)` (13 §4)
    }

    /// dmd/semantic2.d:608 — `override void visit(AlignDeclaration ad)`.
    override visitAlignDeclaration(ad: AlignDeclaration): void {
        getAlignment(ad, this.sc!);
        this.visitAttribDeclaration(ad);         // `visit(cast(AttribDeclaration)ad)` (13 §4)
    }

    /// dmd/semantic2.d:614 — `override void visit(CPPNamespaceDeclaration decl)`.
    override visitCPPNamespaceDeclaration(decl: CPPNamespaceDeclaration): void {
        checkGNUABITag(decl, LINK.cpp);
        this.visitAttribDeclaration(decl);       // `visit(cast(AttribDeclaration)decl)` (13 §4)
    }

    /// dmd/semantic2.d:620 — `override void visit(UserAttributeDeclaration uad)`.
    override visitUserAttributeDeclaration(uad: UserAttributeDeclaration): void {
        // `!uad.decl` / `!uad.atts` / `!uad._scope` are POINTER tests (06 §2.7); `!uad.atts.length`
        // is a genuine LENGTH test — D spells the two differently and so does the port (06 §2.8).
        if (uad.decl === null || uad.attsUda === null || uad.attsUda.length === 0 || uad._scope === null) {
            this.visitAttribDeclaration(uad);
            return;
        }

        // `Expression* lastTag;` — 02 §10 collapses `Expression*` to the reference; the `ref` on
        // `eval`'s parameter needs the one-slot box (03 §3.2/§7.2). `.init` of a pointer is null.
        const lastTag: { value: Expression | null } = { value: null };
        // semantic2.d:626 — nested `static void eval(Scope*, Expressions*, ref Expression*)`.
        // `eval` is a JS reserved word -> one trailing underscore (01 §2.3).
        const eval_ = (sc: Scope | null, exps: Expressions | null,
                       lastTag: { value: Expression | null }): void => {
            // `foreach (ref Expression e; *exps)` — REF iteration: each assignment to `e` writes the
            // array slot back (03 §4, 06 §1.6).
            for (let idx = 0; idx < exps!.length; idx++) {
                let e = exps!.opIndex(idx);
                if (e === null)
                    continue;

                e = expressionSemantic(e, sc!);
                exps!.opIndexAssign(e, idx);
                if (definitelyValueParameter(e)) {
                    e = ctfeInterpret(e);
                    exps!.opIndexAssign(e, idx);
                }
                if (e.op === EXP.tuple) {
                    const te = e.isTupleExp()!;   // `cast(TupleExp)e`, tag-proved by the `op` test
                    eval_(sc, te.exps, lastTag);
                }

                // Handles compiler-recognized `core.attribute.gnuAbiTag`
                if (isGNUABITag(e))
                    doGNUABITagSemantic(e, lastTag);
            }
        };

        uad._scope = null;
        eval_(this.sc, uad.attsUda, lastTag);
        this.visitAttribDeclaration(uad);
    }

    /// dmd/semantic2.d:653 — `override void visit(AggregateDeclaration ad)`.
    override visitAggregateDeclaration(ad: AggregateDeclaration): void {
        // dropped: `//printf("AggregateDeclaration::semantic2(%s) type = %s, errors = %d\n", …);` (D:655)
        if (ad.members === null)
            return;

        if (ad._scope !== null) {
            error(ad.loc, ds("%s `%s` has forward references"), ad.kind(), ad.toPrettyChars());
            return;
        }

        checkGNUABITag(ad, ad.classKind === ClassKind.cpp ? LINK.cpp : LINK.d);

        const sc2 = newScope(ad, this.sc!);

        determineSize(ad, ad.loc);

        for (let i = 0; i < ad.members.length; i++) {
            const s = ad.members.opIndex(i);
            // dropped: `//printf("\t[%d] %s\n", i, s.toChars());` (semantic2.d:674)
            semantic2(s!, sc2);
        }

        sc2.pop();
    }

    /// dmd/semantic2.d:681 — `override void visit(ClassDeclaration cd)`.
    override visitClassDeclaration(cd: ClassDeclaration): void {
        /// Checks that the given class implements all methods of its interfaces.
        /// semantic2.d:684 — nested `static void checkInterfaceImplementations(ClassDeclaration cd)`
        /// -> inner `const` arrow (04 §5); its parameter SHADOWS the outer `cd`, as in D.
        const checkInterfaceImplementations = (cd: ClassDeclaration): void => {
            for (const base of cd.interfaces ?? []) {
                // https://issues.dlang.org/show_bug.cgi?id=22729
                // interfaces that have errors or that
                // inherit from interfaces that have errors
                // might have an uninitialized vtable
                if (base!.sym!.vtbl.length === 0)
                    continue;

                // first entry is ClassInfo reference
                const methods = base!.sym!.vtbl.opSlice(base!.sym!.vtblOffset(), base!.sym!.vtbl.length);

                for (const m of methods) {
                    const ifd = m!.isFuncDeclaration();
                    assert(ifd !== null);

                    if (ifd.objc.isOptional)
                        continue;

                    const type = ifd.type!.toTypeFunction();
                    const fd = findFunc(cd, ifd.ident!, type);

                    if (fd !== null && !fd.isAbstract()) {
                        // dropped: `//printf("            found\n");` (semantic2.d:711)
                        // Check that calling conventions match
                        if (fd._linkage !== ifd._linkage)
                            error(fd.loc, ds("%s `%s` linkage doesn't match interface function"),
                                fd.kind(), fd.toPrettyChars());

                        // Check that it is current
                        // dropped: `//printf("newinstance = %d fd.toParent() = %s …\n", …);` (D:717-718)
                        if (fd.toParent() !== cd && ifd.toParent() === base!.sym)
                            error(cd.loc, ds("%s `%s` interface function `%s` is not implemented"),
                                cd.kind(), cd.toPrettyChars(), ifd.toFullSignature());
                    } else {
                        // dropped: `//printf("            not found %p\n", fd);` (semantic2.d:724)
                        // BUG: should mark this class as abstract?
                        if (!isAbstract(cd))
                            error(cd.loc, ds("%s `%s` interface function `%s` is not implemented"),
                                cd.kind(), cd.toPrettyChars(), ifd.toFullSignature());
                    }
                }
            }
        };

        if (cd.semanticRun >= PASS.semantic2done)
            return;
        assert(cd.semanticRun <= PASS.semantic2);
        cd.semanticRun = PASS.semantic2;

        checkInterfaceImplementations(cd);
        // `visit(cast(AggregateDeclaration) cd)` (13 §4)
        this.visitAggregateDeclaration(cd);
    }

    /// dmd/semantic2.d:742 — `override void visit(InterfaceDeclaration cd)`.
    override visitInterfaceDeclaration(cd: InterfaceDeclaration): void {
        // `visit(cast(AggregateDeclaration) cd)` (13 §4)
        this.visitAggregateDeclaration(cd);
    }

    /// dmd/semantic2.d:747 — `override void visit(TupleDeclaration td)`.
    override visitTupleDeclaration(td: TupleDeclaration): void {
        td.foreachVar((s) => { s.accept(this); });
    }
}

/**
 * dmd/semantic2.d:770 — `private void doGNUABITagSemantic(ref Expression e, ref Expression* lastTag)`.
 *
 * Perform semantic analysis specific to the GNU ABI tags
 *
 * The GNU ABI tags are a feature introduced in C++11, specific to g++
 * and the Itanium ABI.
 * They are mandatory for C++ interfacing, simply because the templated struct
 *`std::basic_string`, of which the ubiquitous `std::string` is a instantiation
 * of, uses them.
 *
 * Params:
 *   e = Expression to perform semantic on
 *       See `Semantic2Visitor.visit(UserAttributeDeclaration)`
 *   lastTag = When `!is null`, we already saw an ABI tag.
 *            To simplify implementation and reflection code,
 *            only one ABI tag object is allowed per symbol
 *            (but it can have multiple tags as it's an array exp).
 *
 * `ref Expression e` is an alias to the caller's array slot; the body never assigns through it, so
 * the reference is passed directly (03 §3.2). `ref Expression* lastTag` IS assigned, so it is the
 * one-slot box (see the file header's POINTER MODEL note). D module-private -> not exported.
 */
function doGNUABITagSemantic(e: Expression, lastTag: { value: Expression | null }): void {
    // dropped: `import dmd.mangle : isValidMangling;` (semantic2.d:772) — a function-local selective
    // import; `isValidMangling` is imported at module level here (01 §3.5).
    // When `@gnuAbiTag` is used, the type will be the UDA, not the struct literal
    if (e.op === EXP.type) {
        error(e.loc, ds("`@%s` at least one argument expected"), Id.udaGNUAbiTag!.toChars());
        return;
    }

    // Definition is in `core.attributes`. If it's not a struct literal,
    // it shouldn't have passed semantic, hence the `assert`.
    const sle = e.isStructLiteralExp();
    if (sle === null) {
        assert(global.errors !== 0);
        return;
    }
    // The definition of `gnuAttributes` only have 1 member, `string[] tags`
    assert(sle.elements !== null && sle.elements.length === 1);
    // `gnuAbiTag`'s constructor is defined as `this(string[] tags...)`
    const ale = sle.elements.opIndex(0)!.isArrayLiteralExp();
    if (ale === null) {
        error(e.loc, ds("`@%s` at least one argument expected"), Id.udaGNUAbiTag!.toChars());
        return;
    }

    // Check that it's the only tag on the symbol
    if (lastTag.value !== null) {
        const str1 = lastTag.value.isStructLiteralExp()!.elements!.opIndex(0)!.toString();
        const str2 = ale.toString();
        error(e.loc, ds("only one `@%s` allowed per symbol"), Id.udaGNUAbiTag!.toChars());
        errorSupplemental(e.loc, ds("instead of `@%s @%s`, use `@%s(%.*s, %.*s)`"),
            lastTag.value.toChars(), e.toChars(), Id.udaGNUAbiTag!.toChars(),
            // Avoid [ ... ]
            // `str1.ptr + 1` is a byte cursor over the DString view (02 §11), not pointer arithmetic
            // over addressable memory: it drops the leading `[`, and `length - 2` drops the `]` too, since
            // `toString()` is NUL-free (rootobject.d:50-51 slices at strlen, and so does rootobject.ts).
            str1.length - 2, str1.subarray(1),
            str2.length - 2, str2.subarray(1));
        return;
    }
    lastTag.value = e;      // `lastTag = &e;` — see the file header's POINTER MODEL note

    // We already know we have a valid array literal of strings.
    // Now checks that elements are valid.
    for (const [idx, elem] of ale.elements!.opSlice().entries()) {
        const str = toStringExp(elem!)!.peekString();
        if (str.length === 0) {
            error(e.loc, ds("argument `%d` to `@%s` cannot be %s"), idx + 1,
                Id.udaGNUAbiTag!.toChars(),
                elem!.isNullExp() !== null ? ds("`null`") : ds("empty"));
            continue;
        }

        for (const c of str) {
            if (!isValidMangling(c)) {
                error(e.loc, ds("`@%s` char `0x%02x` not allowed in mangling"),
                    Id.udaGNUAbiTag!.toChars(), c);
                break;
            }
        }
        // Valid element
    }
    // Since ABI tags need to be sorted, we sort them in place
    // It might be surprising for users that inspects the UDAs,
    // but it's a concession to practicality.
    // Casts are unfortunately necessary as `implicitConvTo` is not
    // `const` (and nor is `StringExp`, by extension).
    // semantic2.d:842 — nested `static int predicate(const scope Expression*, const scope Expression*)`.
    // 08 §2.5: D's `sort` passes element POINTERS and the predicate derefs immediately; the port's
    // `Array.sort` hands the ELEMENTS over, so the two `*eN` derefs (and the `const` casts, which
    // erase per 04 §8) vanish.
    const predicate = (e1: Expression | null, e2: Expression | null): number => {
        const e11 = e1;
        const e22 = e2;
        return toStringExp(e11!)!.compare(toStringExp(e22!)!);
    };
    ale.elements!.sort(predicate);
}

/****************
 * dmd/semantic2.d:863 — `FuncDeclaration findFunc(ClassDeclaration _this, Identifier ident, TypeFunction tf)`.
 *
 * Find virtual function matching identifier and type.
 * Used to build virtual function tables for interface implementations.
 * Params:
 *  _this = ClassDeclaration's vtbl to search
 *  ident = function's identifier
 *  tf = function's type
 * Returns:
 *  function symbol if found, null if not
 * Errors:
 *  prints error message if more than one match
 */
export function findFunc(_this: ClassDeclaration, ident: Identifier, tf: TypeFunction): FuncDeclaration | null {
    // dropped: `//printf("ClassDeclaration.findFunc(%s, %s) %s\n", …);` (semantic2.d:865)
    //
    // 02 §11.4 (TS narrowing vs mutable state) — D's two plain locals `FuncDeclaration fdmatch/
    // fdambig = null;` are written ONLY inside the nested closures below, and TS's flow analysis
    // ignores closure assignments: a later `if (fdambig !== null)` would narrow to `never`
    // (reproduced with a minimal tsc probe; the §11.4 fresh-const re-read does NOT lift it here).
    // The tree's established device for exactly this shape is the one-slot box (funcsem.ts:2369
    // `tfBox` around an `overloadApply` callback) — a property read is re-widened after any call.
    // Purely a typing device: the closures still mutate the SAME storage D's nested functions do.
    const fdmatch: { value: FuncDeclaration | null } = { value: null };
    const fdambig: { value: FuncDeclaration | null } = { value: null };

    // semantic2.d:869 — nested `void updateBestMatch(FuncDeclaration fd)` -> inner arrow (04 §5).
    const updateBestMatch = (fd: FuncDeclaration): void => {
        fdmatch.value = fd;
        fdambig.value = null;
        // dropped: `//printf("Lfd fdmatch = %s %s [%s]\n", …);` (semantic2.d:873)
    };

    // semantic2.d:876 — nested `void searchVtbl(ref Dsymbols vtbl)`. `ref` on an `Array!T` (a value
    // struct) is an ALIAS; the port's `Array<T>` is already a reference, so it is passed as-is and
    // NOT copied (03 §3.2).
    const searchVtbl = (vtbl: Dsymbols): void => {
        let seenInterfaceVirtual = false;
        for (const s of vtbl) {
            // D:881 `auto fd = s.isFuncDeclaration();` dereferences the slot UNCONDITIONALLY, so a
            // null vtbl entry FAULTS in D. `Dsymbols` is `Array<Dsymbol | null>` (arraytypes.ts:90);
            // 08 §3 puts the `!` at exactly the site where D would fault — a `s === null` guard here
            // would silently SKIP a state D treats as impossible. Same form as `m!.isFuncDeclaration()`
            // in `checkInterfaceImplementations` above.
            const fd = s!.isFuncDeclaration();
            if (fd === null)
                continue;

            // the first entry might be a ClassInfo
            // dropped: `//printf("\t[%d] = %s\n", i, fd.toChars());` (semantic2.d:886)
            if (ident !== fd.ident || covariant(fd.type!, tf) !== Covariant.yes) {
                // dropped: `//printf("\t\t%d\n", fd.type.covariant(tf));` (semantic2.d:889)
                continue;
            }

            // dropped: `//printf("fd.parent.isClassDeclaration() = %p\n", …);` (semantic2.d:893)
            if (fdmatch.value === null) {
                updateBestMatch(fd);
                continue;
            }
            // D re-reads `fdmatch` at each use below; one read per ITERATION is equivalent because
            // the only writer, `updateBestMatch`, is always followed by `continue` (so `fdmatch`
            // cannot change between this read and the uses in the same iteration).
            const best: FuncDeclaration = fdmatch.value;
            if (fd === best)
                continue;

            /* Functions overriding interface functions for extern(C++) with VC++
             * are not in the normal vtbl, but in vtblFinal. If the implementation
             * is again overridden in a child class, both would be found here.
             * The function in the child class should override the function
             * in the base class, which is done here, because searchVtbl is first
             * called for the child class. Checking seenInterfaceVirtual makes
             * sure, that the compared functions are not in the same vtbl.
             */
            if (fd.interfaceVirtual !== null &&
                fd.interfaceVirtual === best.interfaceVirtual &&
                !seenInterfaceVirtual &&
                covariant(best.type!, fd.type!) === Covariant.yes) {
                seenInterfaceVirtual = true;
                continue;
            }

            {
                // Function type matching: exact > covariant
                const m1 = tf.equals(fd.type) ? MATCH.exact : MATCH.nomatch;
                const m2 = tf.equals(best.type) ? MATCH.exact : MATCH.nomatch;
                if (m1 > m2) {
                    updateBestMatch(fd);
                    continue;
                } else if (m1 < m2)
                    continue;
            }
            {
                const m1 = (tf.mod === fd.type!.mod) ? MATCH.exact : MATCH.nomatch;
                const m2 = (tf.mod === best.type!.mod) ? MATCH.exact : MATCH.nomatch;
                if (m1 > m2) {
                    updateBestMatch(fd);
                    continue;
                } else if (m1 < m2)
                    continue;
            }
            {
                // The way of definition: non-mixin > mixin
                const m1 = fd.parent!.isClassDeclaration() !== null ? MATCH.exact : MATCH.nomatch;
                const m2 = best.parent!.isClassDeclaration() !== null ? MATCH.exact : MATCH.nomatch;
                if (m1 > m2) {
                    updateBestMatch(fd);
                    continue;
                } else if (m1 < m2)
                    continue;
            }

            fdambig.value = fd;
            // dropped: `//printf("Lambig fdambig = %s %s [%s]\n", …);` (semantic2.d:956)
        }
    };

    searchVtbl(_this.vtbl);
    // `for (auto cd = _this; cd; cd = cd.baseClass)` — the reassigned walk uses the sanctioned
    // widened local cursor (02 §10.1); the D name `cd` is the cursor here.
    for (let cd: ClassDeclaration | null = _this; cd !== null; cd = cd.baseClass) {
        searchVtbl(cd.vtblFinal);
    }

    if (fdambig.value !== null)
        _this.classError(ds("%s `%s` ambiguous virtual function `%s`"), fdambig.value.toChars());

    return fdmatch.value;
}

/**
 * dmd/semantic2.d:980 — `void lowerStaticAAs(VarDeclaration vd, Scope* sc)`.
 *
 * Try lower a variable's Associative Array initializer to a newaa struct
 * so it can be put in static data.
 * Params:
 *   vd = Variable to lower
 *   sc = Scope
 *
 * Keeps the BARE name of the two-overload set (04 §1B; see the file header).
 */
export function lowerStaticAAs(vd: VarDeclaration, sc: Scope): void {
    // 06 §2.6 — declaration in a condition hoisted to a `const`, then null-tested.
    const ei = vd._init!.isExpInitializer();
    if (ei !== null) {
        const v = new StaticAAVisitor(sc, vd.storage_class);
        ei.exp!.accept(v);
    }
}

/**
 * dmd/semantic2.d:996 — `void lowerStaticAAs(Expression e, Scope* sc)`.
 *
 * Try lower all Associative Array literals in an expression to a newaa struct
 * so it can be put in static data.
 * Params:
 *   e = Expression to traverse
 *   sc = Scope
 *
 * Form-B rename of the `(Expression, Scope*)` overload (04 §1B / §6.1; see the file header).
 */
export function lowerStaticAAsExpression(e: Expression, sc: Scope): void {
    const v = new StaticAAVisitor(sc, STC.none);
    e.accept(v);
}

/***********************************************************
 * dmd/semantic2.d:1003 — `private extern(C++) final class StaticAAVisitor : SemanticTimeTransitiveVisitor`.
 *
 * Visit Associative Array literals and lower them to structs for static initialization.
 * D module-private; emitted WITHOUT `private` so the co-located test file can name it.
 */
export class StaticAAVisitor extends SemanticTimeTransitiveVisitor {
    // dropped: alias visit = SemanticTimeTransitiveVisitor.visit — no overload hiding in TS (13 §1)

    sc: Scope;
    storage_class: STC;

    /// dmd/semantic2.d:1009 — `this(Scope* sc, STC storage_class) scope @safe`.
    constructor(sc: Scope, storage_class: STC) {
        super();
        this.sc = sc;
        this.storage_class = storage_class;
    }

    /// dmd/semantic2.d:1015 — `override void visit(AssocArrayLiteralExp aaExp)`.
    override visitAssocArrayLiteralExp(aaExp: AssocArrayLiteralExp): void {
        if (aaExp.lowering === null)
            expressionSemantic(aaExp, this.sc);
        assert(aaExp.lowering !== null);
        if ((this.storage_class & STC.manifest) === 0n)  // manifest constants create runtime copies
            if (aaExp.loweringCtfe === null) {
                aaExp.loweringCtfe = ctfeInterpret(aaExp.lowering);
                aaExp.loweringCtfe.accept(this); // lower AAs in keys and values
            }
        semanticTypeInfo(this.sc, aaExp.lowering.type);
    }

    // https://issues.dlang.org/show_bug.cgi?id=24602
    // TODO: Is this intionally not visited by SemanticTimeTransitiveVisitor?
    /// dmd/semantic2.d:1031 — `override void visit(ClassReferenceExp crExp)`.
    override visitClassReferenceExp(crExp: ClassReferenceExp): void {
        // `this.visit(crExp.value)` resolves on the STATIC type `StructLiteralExp` (13 §1).
        this.visitStructLiteralExp(crExp.value!);
    }
}

/**
 * dmd/semantic2.d:1043 — `void staticAssertFail(StaticAssert sa, Scope* sc)`.
 *
 * Given a static assert with a failing condition, print an error
 * Params:
 *   sa = Static assert with failing condition
 *   sc = scope for evaluating assert message and printing context
 *
 * Cost: never returns normally outside a gagged context — the trailing `fatal()` halts the process
 * (errors.d), exactly as in D.
 */
export function staticAssertFail(sa: StaticAssert, sc: Scope): void {
    // D reassigns the `sc` parameter across startCTFE/endCTFE and READS it after the loop; the
    // sanctioned widened local cursor is `cur` (02 §10.1).
    let cur: Scope = sc;
    if (sa.msgs !== null) {
        const msgbuf = new OutBuffer();
        for (let i = 0; i < sa.msgs.length; i++) {
            let e = sa.msgs.opIndex(i);
            cur = cur.startCTFE();
            e = expressionSemantic(e!, cur);
            e = resolveProperties(cur, e);
            cur = cur.endCTFE()!;   // `endCTFE()`'s `pop()` is non-null here — D's fault point
            e = ctfeInterpretForPragmaMsg(e);
            if (e.op === EXP.error) {
                errorSupplemental(sa.loc, ds("while evaluating `static assert` argument `%s`"),
                    sa.msgs.opIndex(i)!.toChars());
                if (global.gag === 0)
                    fatal();
                return;
            }
            const se = toStringExp(e);
            if (se !== null) {
                const slice = toUTF8(se, cur).peekString();
                // Hack to keep old formatting to avoid changing error messages everywhere
                if (sa.msgs.length === 1)
                    msgbuf.printf(ds("\"%.*s\""), slice.length, slice);
                else
                    msgbuf.printf(ds("%.*s"), slice.length, slice);
            } else
                msgbuf.printf(ds("%s"), e.toChars());
        }
        // `extractChars()` CONSUMES the buffer — that is D's own call at semantic2.d:1075
        // (08 §13a.2); the buffer is dead after this statement in both languages.
        error(sa.loc, ds("static assert:  %s"), msgbuf.extractChars());
    } else
        error(sa.loc, ds("static assert:  `%s` is false"), sa.exp!.toChars());
    if (cur.tinst !== null)
        cur.tinst.printInstantiationTrace();
    if (global.gag === 0)
        fatal();
}
