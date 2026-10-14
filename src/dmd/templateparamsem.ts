/**
 * Semantic analysis of template parameters.
 *
 * Ported 1:1 from dmd/templateparamsem.d (module dmd.templateparamsem), LDC 1.43.0-beta1 / DMD 2.113.
 *
 * VISITOR IDIOM (13 §7 census): this module DOES declare a visitor class
 * (`TemplateParameterSemanticVisitor : Visitor`, dmd/templateparamsem.d:47), so it is **Idiom A** —
 * one named `visit<NodeType>` method per D `visit` overload (13 §1), driven by `tp.accept(v)`
 * (13 §2). There is no nested-function + trailing-dispatch-switch shape here, and none is invented.
 *
 * Every D import maps to a live TS module below. `dmd.templatesem` (`reliesOnTident`) and
 * `dmd.dinterpret` (`ctfeInterpret`) are value imports placed LAST (01 §4.8).
 *
 * UFCS (04 §6): `t.typeSemantic(loc, sc)`, `t.toDsymbol(sc)`, `t.resolve(...)` and
 * `e.expressionSemantic(sc)` are FREE functions in dmd/typesem.d / dmd/expressionsem.d, so they are
 * emitted as free calls with the receiver first — never promoted to methods on `Type`/`Expression`.
 */

import { Visitor } from "./visitor/index.js";
import { error } from "./errors.js";
import { ds } from "../dstring.js";
import { assertUnreachable } from "../assert.js";
import { global } from "./globals.js";
import { isExpression, isType, isError } from "./dtemplate.js";
import { typeSemantic, toDsymbol, resolve } from "./typesem.js";
import { expressionSemantic } from "./expressionsem.js";
// Value import: `Type.terror` is read inside `aliasParameterSemantic`'s body only (load-safe).
import { Type } from "./mtype.js";

import type { TemplateParameters } from "./arraytypes.js";
import type { Scope } from "./dscope.js";
import type { Dsymbol } from "./dsymbol.js";
import type {
    TemplateParameter,
    TemplateTypeParameter,
    TemplateThisParameter,
    TemplateValueParameter,
    TemplateAliasParameter,
    TemplateTupleParameter,
} from "./dtemplate.js";
import type { Expression } from "./expression.js";
import type { Loc } from "./location.js";
import type { RootObject } from "./rootobject.js";
// last (01 §4.8): both are *sem-grade modules inside the core SCC (templatesem value-imports this
// file; dinterpret value-imports dsymbolsem/funcsem/initsem/semantic2). Entered earlier, either
// would become the entry point of that chain.
import { reliesOnTident } from "./templatesem.js";
import { ctfeInterpret } from "./dinterpret.js";

/**
 * The canonical box / ref-cell for a D `out`/reassigned-through-a-closure slot (03 §3.3): the callee
 * RESETS each slot on entry, and a nested function that reassigns the D local reassigns `.value`.
 * Structurally identical to the private `Ref` of typesem.ts, so `resolve`'s out-triple accepts it.
 */
interface Ref<T> {
    value: T;
}

/************************************************
 * dmd/templateparamsem.d:39 — Performs semantic on TemplateParameter AST nodes.
 *
 * Params:
 *      tp = element of `parameters` to be semantically analyzed. D dereferences it unconditionally
 *           (`tp.accept(v)`), so the port types it non-null (02 §10.1).
 *      sc = context. `Scope*` -> the class reference (02 §10); dereferenced unconditionally by the
 *           visitor bodies, so non-null.
 *      parameters = array of `TemplateParameters` supplied to the `TemplateDeclaration`.
 *           `TemplateParameters*` -> nullable: `aliasParameterSemantic` (the forwarding target)
 *           null-tests it at dmd/templateparamsem.d:169, so the whole chain carries `| null`.
 * Returns:
 *      `true` if no errors
 *
 * Cost: allocates one visitor per call, exactly as D's `scope v = new ...` does (`scope` erased,
 * 04 §8 — it is a stack-allocation hint with no observable effect under GC).
 */
export function tpsemantic(tp: TemplateParameter, sc: Scope, parameters: TemplateParameters | null): boolean {
    const v = new TemplateParameterSemanticVisitor(sc, parameters);
    tp.accept(v);
    return v.result;
}

/**
 * dmd/templateparamsem.d:47 — `private extern (C++) final class TemplateParameterSemanticVisitor :
 * Visitor`. D `private` is MODULE-scoped and the sibling free function `tpsemantic` constructs it,
 * so the TS module-private form is "declared but not exported" (01 conventions); `extern (C++)` and
 * `final` erase (04 §8).
 *
 * Contract: one instance per `tpsemantic` call. `result` is the visitor's out-slot, written by every
 * `visit*` body; it is `false` until a body runs (D `bool.init`, 09 §1.0).
 */
class TemplateParameterSemanticVisitor extends Visitor {
    // dropped: alias visit = Visitor.visit — no overload hiding in TS (13 §1)

    sc: Scope;
    parameters: TemplateParameters | null;
    result = false;

    // dmd/templateparamsem.d:55 — `this(Scope* sc, TemplateParameters* parameters) scope @safe`
    // (`scope`/`@safe` erased, 04 §8).
    constructor(sc: Scope, parameters: TemplateParameters | null) {
        super();
        this.sc = sc;
        this.parameters = parameters;
    }

    // dmd/templateparamsem.d:61 — `override void visit(TemplateTypeParameter ttp)`.
    override visitTemplateTypeParameter(ttp: TemplateTypeParameter): void {
        //printf("TemplateTypeParameter.semantic('%s')\n", ident.toChars());

        // dmd/templateparamsem.d:64 — `reliesOnTident(ttp.specType, parameters)`. The callee
        // dereferences `tparams` unconditionally (dmd/templatesem.d:75), so the `!` marks D's own
        // fault point (02 §10.1).
        if (ttp.specType !== null && !reliesOnTident(ttp.specType, this.parameters!)) {
            ttp.specType = typeSemantic(ttp.specType, ttp.loc, this.sc);
        }
        // dropped: version(none) block (disabled upstream) — dmd/templateparamsem.d:68-75, defaultType
        this.result = !(ttp.specType !== null && isError(ttp.specType));
    }

    // dmd/templateparamsem.d:79 — `override void visit(TemplateThisParameter ttp)`. The D body's
    // function-local `import dmd.errors;` is hoisted to this module's top-level imports — the preferred
    // branch of 01 Rule 4.4 (a value used at call time whose module is not in this leaf file's cycle).
    override visitTemplateThisParameter(ttp: TemplateThisParameter): void {
        if (this.sc.getStructClassScope() === null)
            error(ttp.loc, ds("cannot use `this` outside an aggregate type"));
        // dmd/templateparamsem.d:85 — `visit(cast(TemplateTypeParameter)ttp)`: the base overload on
        // the SAME visitor; the cast vanishes, the base's NAMED method is what routes (13 §4).
        this.visitTemplateTypeParameter(ttp);
    }

    // dmd/templateparamsem.d:88 — `override void visit(TemplateValueParameter tvp)`.
    override visitTemplateValueParameter(tvp: TemplateValueParameter): void {
        // D dereferences `valType` unconditionally; the `!` marks the same fault point (02 §10.1).
        tvp.valType = typeSemantic(tvp.valType!, tvp.loc, this.sc);
        // dropped: version(none) block (disabled upstream) — dmd/templateparamsem.d:91-118, specValue
        this.result = !isError(tvp.valType);
    }

    // dmd/templateparamsem.d:122 — `override void visit(TemplateAliasParameter tap)`.
    override visitTemplateAliasParameter(tap: TemplateAliasParameter): void {
        // dmd/templateparamsem.d:124 — same `!` as at :64.
        if (tap.specType !== null && !reliesOnTident(tap.specType, this.parameters!)) {
            tap.specType = typeSemantic(tap.specType, tap.loc, this.sc);
        }
        tap.specAlias = aliasParameterSemantic(tap.loc, this.sc, tap.specAlias, this.parameters);
        // dropped: version(none) block (disabled upstream) — dmd/templateparamsem.d:129-134, defaultAlias
        this.result = !(tap.specType !== null && isError(tap.specType))
            && !(tap.specAlias !== null && isError(tap.specAlias));
    }

    // dmd/templateparamsem.d:138 — `override void visit(TemplateTupleParameter ttp)`. The parameter is
    // unused in D too; the `_` prefix is the tree's `noUnusedParameters` convention
    // (cf. visitor/parsetime.ts:310).
    override visitTemplateTupleParameter(_ttp: TemplateTupleParameter): void {
        this.result = true;
    }
}

/***********************************************
 * dmd/templateparamsem.d:155 — Support function for performing semantic analysis on
 * `TemplateAliasParameter`.
 *
 * Params:
 *      loc = location (for error messages). `Loc` is a value struct on the 03 §9.1 ALIAS-SAFE
 *            REGISTER, so it is shared, not copied.
 *      sc = context. Reassigned by the nested `eaCTFE` (D nested functions capture by reference);
 *           the TS parameter binding gives the identical aliasing (04 §5).
 *      o = object to run semantic() on, the `TemplateAliasParameter`s `specAlias` or `defaultAlias`.
 *          Null-tested at :157, hence `RootObject | null` (02 §10.1).
 *      parameters = array of `TemplateParameters` supplied to the `TemplateDeclaration`; null-tested
 *          at :169, hence nullable.
 * Returns:
 *      object resulting from running `semantic` on `o` (null when `o` is null)
 */
export function aliasParameterSemantic(loc: Loc, sc: Scope, o: RootObject | null,
    parameters: TemplateParameters | null): RootObject | null {
    if (o === null)
        return null;

    // `ea` is a plain D local that is ALSO passed as the `out Expression pe` argument of `resolve`
    // (:178) and reassigned inside the nested `eaCTFE` — both need the one-slot box (03 §3.3).
    const ea: Ref<Expression | null> = { value: isExpression(o) };
    const eaCTFE = (): RootObject => {
        // dmd/templateparamsem.d:163-165 — `sc = sc.startCTFE(); ea = ea.expressionSemantic(sc);
        // sc = sc.endCTFE();`. D needs no try/finally; the PORT does. `expressionSemantic` is a partial
        // port whose walls throw, and a throw out of this region would skip the `pop()` that folds the
        // CTFE sub-scope's ctorflow into the enclosing `sc` (dmd/dscope.d:302) and would leave the
        // by-reference `sc` binding pointing at the dead CTFE scope — 11 §2.5 "walls add exit paths D
        // does not have — protect paired state". On the non-throwing path the statements are D's, in
        // D's order.
        sc = sc.startCTFE();
        try {
            // D dereferences `ea` unconditionally here; every call site of `eaCTFE` is guarded by
            // `if (ea)` (:187, :198), so the `!` sits exactly where D would fault.
            ea.value = expressionSemantic(ea.value!, sc);
        } finally {
            // The `!` here is a NARROWING artifact, not a D fault site: d:165 is a plain `Scope*`
            // assignment that tolerates null. `endCTFE()` pops the scope `startCTFE()` pushed, so it
            // returns that push's `enclosing` — the `sc` we came in with, non-null because the port
            // spells this parameter non-null (02 §10.1).
            sc = sc.endCTFE()!;
        }
        // dmd/templateparamsem.d:166 — `return ea.ctfeInterpret();`
        return ctfeInterpret(ea.value);
    };
    const ta = isType(o);
    // dmd/templateparamsem.d:169 — D's `||` short-circuit means a null `parameters` never reaches
    // `reliesOnTident`.
    if (ta !== null && (parameters === null || !reliesOnTident(ta, parameters))) {
        // `s` is written by `resolve`'s `out Dsymbol ps` at :178, so it is a box from birth (03 §3.3).
        const s: Ref<Dsymbol | null> = { value: toDsymbol(ta, sc) };
        if (s.value !== null)
            return s.value;
        // dmd/templateparamsem.d:174 — declaration in a condition -> hoist + explicit null test
        // (06 §2.6/§2.7). D binds `ti` and never reads it beyond the test; the name is kept for 1:1
        // fidelity and the null test is itself the use that satisfies `noUnusedLocals`.
        const ti = ta.isTypeInstance();
        if (ti !== null) {
            // `Type t;` — a class reference default-inits to null (09 §1.0); box for `out Type pt`.
            const t: Ref<Type | null> = { value: null };
            const errors = global.errors;
            resolve(ta, loc, sc, ea, t, s);
            // if we had an error evaluating the symbol, suppress further errors
            if (t.value === null && errors !== global.errors)
                return Type.terror;
            // We might have something that looks like a type
            // but is actually an expression or a dsymbol
            // see https://issues.dlang.org/show_bug.cgi?id=16472
            if (t.value !== null)
                return typeSemantic(t.value, loc, sc);
            if (ea.value !== null) {
                return eaCTFE();
            }
            if (s.value !== null)
                return s.value;
            return assertUnreachable();
        }
        else
            return typeSemantic(ta, loc, sc);
    }
    else if (ea.value !== null)
        return eaCTFE();
    return o;
}
