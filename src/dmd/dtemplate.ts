// Ported from dmd/dtemplate.d (module dmd.dtemplate) — faithful structural 1:1 of the WHOLE file.
//
// dtemplate.d holds the template DATA layer: the `dynamic_cast` substitutes (`isExpression` …
// `isTemplateParameter`), the small object helpers (`isError`, `arrayObjectIsError`, `getType`,
// `objectSyntaxCopy`), `Tuple`, `TemplatePrevious`, `TemplateDeclaration`, `TypeDeduced`, the
// `TemplateParameter` hierarchy, `TemplateInstance`, `TemplateMixin`, `definitelyValueParameter`,
// `TemplateStats` / `printTemplateStats`, and `write`. The MATCHING/deduction algorithms live in
// dmd/templatesem.d and are NOT part of this module.
//
// Compile-time resolutions (07-compile-time.md, _config.md):
//   - `private enum LOG = false;` (dtemplate.d:67) — a file-local manifest constant whose only use is
//     `static if (LOG)`. All three sites (dtemplate.d:278, :867, :883) resolve OFF, so their printf
//     traces are dropped and the constant itself is not emitted (it would be dead).
//   - `version (IN_LLVM)` (dtemplate.d:265, :317) — ON: the `intrinsicName` field is kept and
//     `syntaxCopy` copies it; the `else` (MARS) branch at dtemplate.d:325-328 is dead.
//   - `version (none)` (dtemplate.d:282) — OFF (built-in): the parameter-dump loop is dropped.
//
// Deferred callees (walls, 11 §2.5) — each is inline at its D statement and names the D file:line:
//   - `Array!T.toChars()` (root/array.ts drops the diagnostic helpers)   -> Tuple.toChars
//   (mangleToBuffer(TemplateInstance) is live: genIdent calls mangleToBufferTemplateInstance)
//                                                                        -> genIdent
//
// SHADOW-SPLIT (02 §11.5b registry): `TemplateInstance.deferred` (dtemplate.d:807) redeclares
// `Dsymbol.deferred` (dsymbol.d:396) and BOTH D slots are live, so the derived slot is the renamed
// field `deferredTI` (same row family as `AggregateDeclaration.deferredTI`, aggregate.ts).
//
// Excluded-module imports: none (dtemplate.d imports no cparse/importc/doc/dtoh/iasm).
//
// LOAD ORDER: this module is import-safe from anywhere in the core SCC. Its one top-level read of an
// SCC value — `class TypeDeduced extends Type` (dtemplate.d:386) — is deferred into `initDtemplate()`
// per 01 §4.1's ratified lazy-class shape; that function carries the ORDER CONTRACT (mtype.js
// finished evaluating — which every ordinary importer of dtemplate.js already gets) and the record of
// the one gap left open: the §5 init sequence it should be registered in does not exist yet (W6).
// Consumers therefore import dtemplate.js with ordinary VALUE imports.

// ── value imports (needed at runtime) ─────────────────────────────────────────────────────────
import { Dsymbol, ScopeDsymbol, DSYM, Visibility } from "./dsymbol.js";
import { K, keepTrace } from "../keep.js";
import { ASTNode } from "./ast_node.js";
import { RootObject, DYNCAST } from "./rootobject.js";
// value: `class TypeDeduced extends Type` (dtemplate.d:386) — read inside `initDtemplate()`, NOT at
// this module's top level (01 §4.1 lazy-class shape; the note at the declaration says why).
import { Type } from "./mtype.js";
import { TY, STC } from "./astenums.js"; // value: `Tnone`/`Terror` tags + the STC flag test
import { EXP } from "./tokens.js"; // value: definitelyValueParameter's op tests
import { Array as DArray, toCharsObjects } from "./root/array.js"; // the growable container (08-runtime-lib.md §2)
import { toErrMsg, dsymbolToErrMsg, HdrGenState, toCBufferInstance, toCharsMaybeConstraints } from "./hdrgen.js";
import { OutBuffer } from "./common/outbuffer.js"; // value: `OutBuffer buf;` in printTemplateStats
import { Classification, errorSupplemental, deprecationSupplemental } from "./errors.js";
import { global, DiagnosticReporting } from "./globals.js";
import { dmdformat } from "./root/dmdformat.js";
import { cstr, ds, dsToJs } from "../dstring.js";
import { assert, assertUnreachable, SwitchError } from "../assert.js";

// ── type-only imports (erased — these edges close a load cycle, 01 §4.2/§4.5) ─────────────────
import { Identifier } from "./identifier.js";
// `Loc` appears only in type positions (ctor parameters, the `loc` field, `printFn`'s signature):
// every value operation on it is an instance method call, so the edge stays erased (01 §4.2).
import type { Loc } from "./location.js";
import type { Visitor } from "./visitor/index.js";
import type { Scope } from "./dscope.js";
import type { Expression } from "./expression.js";
import type { TypeQualified, TypeIdentifier, Parameter } from "./mtype.js";
import type { FuncDeclaration } from "./func.js";
import type { VarDeclaration } from "./declaration.js";
import type { Module } from "./dmodule.js";
import type { ErrorSink } from "./errorsink.js";
import type { DString } from "../dstring.js";

import type {
    Objects,
    Types,
    Modules,
    Expressions,
    Dsymbols,
    ArgumentLabels,
    TemplateParameters,
    TemplateInstances,
} from "./arraytypes.js";
import type { OutBuffer as MangleOutBuffer } from "./common/outbuffer.js";

// dmd/dtemplate.d:58 `import dmd.mangle;` — a value import of mangle/index.js breaks module init even at the
// last position (measured: ~25 suites die at collect), so the edge is inverted (01 §4.4): this module owns the
// slot, mangle/index.ts fills it at its module end. ORDER CONTRACT: the slot is filled once mangle/index.js is in
// the entry's module graph (every *sem entry reaches it); genIdent fails loudly while it is empty.
var mangleToBufferTemplateInstanceSlot: ((ti: TemplateInstance, buf: MangleOutBuffer) => void) | undefined;

/// Registration point for the inverted `dmd.mangle` edge above: mangle/index.ts hands over
/// `mangleToBufferTemplateInstance` (mangle/package.d:64). Not a D symbol.
export function registerMangleToBufferTemplateInstance(fn: (ti: TemplateInstance, buf: MangleOutBuffer) => void): void {
    mangleToBufferTemplateInstanceSlot = fn;
}

/// dmd/dtemplate.d:69 — `enum IDX_NOTFOUND = 0x12345678;` (manifest constant, 02 §4.1).
export const IDX_NOTFOUND = 0x12345678;

/* ********************************************
 * dmd/dtemplate.d:71-132 — `pure nothrow @nogc @trusted { ... }`. All attributes erase (04 §8),
 * and the `inout(T)` wrapper on the returns erases while `T` is kept (04 attributes).
 *
 * These functions substitute for `dynamic_cast`: each gates on the hand-rolled DYNCAST tag
 * (08 §1) and returns the object typed, or null when the tag does not match. The `cast(inout(X))o`
 * is D's checked downcast on a tag the caller has already proved — the TS `as unknown as X`
 * cascade carries the same proof (nothing is reinterpreted at runtime).
 */

/// dmd/dtemplate.d:78 — `inout(Expression) isExpression(inout RootObject o)`.
export function isExpression(o: RootObject | null): Expression | null {
    //return dynamic_cast<Expression *>(o);
    if (o === null || o.dyncast() !== DYNCAST.expression) return null;
    return o as Expression; // D `cast(inout(Expression))o` — a downcast the tag above has proved
}

/// dmd/dtemplate.d:86 — `inout(Dsymbol) isDsymbol(inout RootObject o)`.
export function isDsymbol(o: RootObject | null): Dsymbol | null {
    //return dynamic_cast<Dsymbol *>(o);
    if (o === null || o.dyncast() !== DYNCAST.dsymbol) return null;
    return o as Dsymbol; // D `cast(inout(Dsymbol))o` — a downcast the tag above has proved
}

/// dmd/dtemplate.d:94 — `inout(Type) isType(inout RootObject o)`.
export function isType(o: RootObject | null): Type | null {
    //return dynamic_cast<Type *>(o);
    if (o === null || o.dyncast() !== DYNCAST.type) return null;
    return o as Type; // D `cast(inout(Type))o` — a downcast the tag above has proved
}

/// dmd/dtemplate.d:102 — `inout(Tuple) isTuple(inout RootObject o)`.
export function isTuple(o: RootObject | null): Tuple | null {
    //return dynamic_cast<Tuple *>(o);
    if (o === null || o.dyncast() !== DYNCAST.tuple) return null;
    return o as Tuple; // D `cast(inout(Tuple))o` — a downcast the tag above has proved
}

/// dmd/dtemplate.d:110 — `inout(Parameter) isParameter(inout RootObject o)`.
export function isParameter(o: RootObject | null): Parameter | null {
    //return dynamic_cast<Parameter *>(o);
    if (o === null || o.dyncast() !== DYNCAST.parameter) return null;
    return o as Parameter; // D `cast(inout(Parameter))o` — a downcast the tag above has proved
}

/// dmd/dtemplate.d:118 — `inout(Identifier) isIdentifier(inout RootObject o)`.
export function isIdentifier(o: RootObject | null): Identifier | null {
    if (o === null || o.dyncast() !== DYNCAST.identifier) return null;
    return o as Identifier; // D `cast(inout(Identifier))o` — a downcast the tag above has proved
}

/// dmd/dtemplate.d:125 — `inout(TemplateParameter) isTemplateParameter(inout RootObject o)`.
export function isTemplateParameter(o: RootObject | null): TemplateParameter | null {
    if (o === null || o.dyncast() !== DYNCAST.templateparameter) return null;
    return o as TemplateParameter; // D `cast(inout(TemplateParameter))o` — a downcast the tag above has proved
}

/* dmd/dtemplate.d:134-182 — `pure nothrow @nogc @safe { ... }`; attributes erase (04 §8). */

/**************************************
 * dmd/dtemplate.d:140 — Is this Object an error?
 *
 * The three `if (const x = isXxx(o))` declaration-in-condition arms hoist to a `const` + explicit
 * null test (06 §2.6/§2.7); each arm returns, so sequential hoisting preserves D's short-circuit
 * evaluation order exactly.
 */
export function isError(o: RootObject | null): boolean {
    const t = isType(o);
    if (t !== null) return t.ty === TY.Terror;
    const e = isExpression(o);
    if (e !== null) return e.op === EXP.error || e.type === null || e.type.ty === TY.Terror;
    const v = isTuple(o);
    if (v !== null) return arrayObjectIsError(v.objects);
    const s = isDsymbol(o);
    assert(s);
    if (s.errors) return true;
    return s.parent !== null ? isError(s.parent) : false;
}

/**************************************
 * dmd/dtemplate.d:158 — Are any of the Objects an error?
 *
 * `const ref Objects args` is a read-only alias — pass the container, NO `.copy()` (03 §3.4).
 * `foreach (const o; args)` iterates the container VALUE (06 §1.9): `for…of` over its
 * `[Symbol.iterator]`.
 */
export function arrayObjectIsError(args: Objects): boolean {
    for (const o of args) {
        if (isError(o)) return true;
    }
    return false;
}

/***********************
 * dmd/dtemplate.d:171 — Try to get `o` as a type: the type itself, else an expression's type.
 */
export function getType(o: RootObject | null): Type | null {
    const t = isType(o);
    if (t === null) {
        const e = isExpression(o);
        if (e !== null) return e.type;
    }
    return t;
}

/// dmd/dtemplate.d:184 — deep-copy a template-argument object (a Type or an Expression syntax-copies;
/// anything else — an alias symbol, an Identifier, a Tuple — is shared verbatim).
export function objectSyntaxCopy(o: RootObject | null): RootObject | null {
    if (o === null) return null;
    const t = isType(o);
    if (t !== null) return t.syntaxCopy();
    const e = isExpression(o);
    if (e !== null) return e.syntaxCopy();
    return o;
}

/***********************************************************
 * dmd/dtemplate.d:195 — `extern (C++) final class Tuple : RootObject`. A tuple of template
 * arguments. D declares NO `accept` override (it is not a visitable AST node).
 */
export class Tuple extends RootObject {
    // `Objects objects;` — an `Array!RootObject` held BY VALUE; constructed as the alias's element
    // type (08 §3 construction rule).
    objects: Objects = new DArray<RootObject | null>();

    /**
     * dmd/dtemplate.d:199 / :205 — the two ctors `this()` and `this(size_t numObjects)` are
     * arity-distinct prefixes -> ONE constructor with an optional trailing param (04 §1 Form A).
     *
     * Params:
     *   numObjects = The initial number of objects.
     */
    constructor(numObjects?: number) {
        super();
        if (numObjects !== undefined) this.objects.setDim(numObjects);
    }

    // kludge for template.isType()
    override dyncast(): DYNCAST {
        return DYNCAST.tuple;
    }

    override toChars(): DString {
        return toCharsObjects(this.objects); // dmd/dtemplate.d:218; the Objects variant, 07 §3.5(b)
    }
}

/***********************************************************
 * dmd/dtemplate.d:222 — `struct TemplatePrevious`: the threaded list of previous instantiation
 * attempts on the stack. A VALUE type (02 §2) with three POINTER fields, so `.copy()` shares all
 * three references (03 §2). D never copies it (it is only ever reached through `prev`), but the
 * emission checklist requires `copy()` on every struct without `@disable this(this)` (03 §6.3).
 */
export class TemplatePrevious {
    prev: TemplatePrevious | null = null;
    sc: Scope | null = null;
    dedargs: Objects | null = null;

    copy(): TemplatePrevious {
        const c = new TemplatePrevious();
        c.prev = this.prev; // pointer: share the reference (03 §2)
        c.sc = this.sc; // `Scope*` -> the class reference, no copy (02 §10 case 2)
        c.dedargs = this.dedargs; // `Objects*` -> the container reference
        return c;
    }
}

/***********************************************************
 * [mixin] template Identifier (parameters) [Constraint]
 * https://dlang.org/spec/template.html
 * https://dlang.org/spec/template-mixin.html
 *
 * dmd/dtemplate.d:234 — `extern (C++) final class TemplateDeclaration : ScopeDsymbol`.
 * (dtemplate.d:236 `import dmd.root.array : Array;` is a scope-local import — the container is
 * already imported module-wide here.)
 */
export class TemplateDeclaration extends ScopeDsymbol {
    parameters: TemplateParameters | null = null; // array of TemplateParameter's
    origParameters: TemplateParameters | null = null; // originals for Ddoc

    constraint: Expression | null = null;

    /**
     * dmd/dtemplate.d:244 — `void* instances;` — "Hash table to look up TemplateInstance's of this
     * TemplateDeclaration". The slot is an OPAQUE handle (02 §10 case 3): D stores a built-in AA
     * `TemplateInstance[TemplateInstanceBox]` in it and every access casts the slot back
     * (templatesem.d:1988, :2002, :2017, :1448). Keeping it opaque here leaves the container model
     * where D leaves it — in templatesem, the module that owns those casts. `void*.init` is null.
     *
     * gap: no in-scope reader yet; templatesem.ts (W3) owns `findExistingInstance`/`addInstance`/
     * `removeInstance` (dmd/templatesem.d:1988-2017), which are the only D entry points to it.
     */
    instances: unknown = null;

    overnext: TemplateDeclaration | null = null; // next overloaded TemplateDeclaration
    overroot: TemplateDeclaration | null = null; // first in overnext list
    funcroot: FuncDeclaration | null = null; // first function in unified overload list

    onemember: Dsymbol | null = null; // if !=null then one member of this template

    literal = false; // this template declaration is a literal
    ismixin = false; // this is a mixin template declaration
    isstatic = false; // this is static template declaration
    isTrivialAliasSeq = false; /// matches pattern `template AliasSeq(T...) { alias AliasSeq = T; }`
    isTrivialAlias = false; /// matches pattern `template Alias(T) { alias Alias = qualifiers(T); }`
    deprecated_ = false; /// this template declaration is deprecated
    isCmacro = false; /// Whether this template is a translation of a C macro
    haveComputedOneMember = false; /// Whether computeOneMeber has been called
    // `Visibility visibility;` — a value struct, D-default-initialized (03 §6.4).
    visibility: Visibility = new Visibility();

    // threaded list of previous instantiation attempts on stack (`TemplatePrevious*` -> reference)
    previous: TemplatePrevious | null = null;

    // resolved: version (IN_LLVM) -> ON (_config.md §1). `const(char)* intrinsicName;`
    // (dtemplate.d:267) is LDC front-end bookkeeping; `const(char)*` -> DString (02 §1.3/§11.2).
    intrinsicName: DString | null = null;

    lastConstraint: Expression | null = null; /// the constraint after the last failed evaluation
    /// its negative parts — `Array!Expression` held BY VALUE (dtemplate.d:271)
    lastConstraintNegs: Expressions = new DArray<Expression | null>();
    lastConstraintTiargs: Objects | null = null; /// template instance arguments for `lastConstraint`

    // dmd/dtemplate.d:274.
    constructor(
        loc: Loc,
        ident: Identifier | null,
        parameters: TemplateParameters | null,
        constraint: Expression | null,
        decldefs: Dsymbols | null,
        ismixin = false,
        literal = false,
    ) {
        super(loc, ident);
        this.dsym = DSYM.templateDeclaration;
        // resolved: static if (LOG) -> false (dtemplate.d:278) — the printf trace is dropped.
        // resolved: version (none) -> false (dtemplate.d:282) — the parameter-dump loop is dropped.
        this.parameters = parameters;
        this.origParameters = parameters;
        this.constraint = constraint;
        this.members = decldefs; // inherited ScopeDsymbol.members
        this.literal = literal;
        this.ismixin = ismixin;
        this.isstatic = true;
        this.haveComputedOneMember = false;
        this.visibility = new Visibility(Visibility.Kind.undefined);
    }

    // dmd/dtemplate.d:307 — `override TemplateDeclaration syntaxCopy(Dsymbol)`. The parameter is
    // UNNAMED in D (deliberately ignored); TS requires a name, so `_s`.
    override syntaxCopy(_s: Dsymbol | null): TemplateDeclaration {
        //printf("TemplateDeclaration.syntaxCopy()\n");
        let p: TemplateParameters | null = null;
        if (this.parameters !== null) {
            p = new DArray<TemplateParameter | null>(this.parameters.length);
            // `foreach (i, ref param; *p) param = (*parameters)[i].syntaxCopy();` — a by-reference
            // walk that WRITES each slot, so the port is an indexed write (05 §7 opIndexAssign).
            for (let i = 0; i < p.length; i++) {
                // slot is `TemplateParameter | null` (08 §3); D calls through it with no null test,
                // so `!` marks exactly the point D would fault (02 §10.1).
                p.opIndexAssign(this.parameters.opIndex(i)!.syntaxCopy(), i);
            }
        }
        // resolved: version (IN_LLVM) -> ON (dtemplate.d:317). The MARS `else` (dtemplate.d:325-328)
        // is dead; the live branch additionally propagates `intrinsicName`.
        const td = new TemplateDeclaration(
            this.loc,
            this.ident,
            p,
            this.constraint !== null ? this.constraint.syntaxCopy() : null,
            Dsymbol.arraySyntaxCopy(this.members),
            this.ismixin,
            this.literal,
        );
        td.intrinsicName = this.intrinsicName;
        return td;
    }

    // dmd/dtemplate.d:331 — an aggregate template reports its aggregate's kind, else "template".
    override kind(): DString {
        return this.onemember !== null && this.onemember.isAggregateDeclaration() !== null
            ? this.onemember.kind()
            : ds("template");
    }

    /****************************
     * Similar to `toChars`, but does not print the template constraints (dmd/dtemplate.d:339).
     */
    toCharsNoConstraints(): DString {
        const hgs = new HdrGenState(); // dmd/dtemplate.d:341 — `HdrGenState hgs = { skipConstraints: true };`
        hgs.skipConstraints = true;
        const buf = new OutBuffer(); // dmd/dtemplate.d:342
        toCharsMaybeConstraints(this, buf, hgs); // dmd/dtemplate.d:343
        return buf.extractChars(); // dmd/dtemplate.d:344
    }

    // dmd/dtemplate.d:347 — returns the value struct BY VALUE, so D hands the caller a copy
    // (03 §1 #3). No elision: `Visibility` is not an alias-safe register type and every caller of
    // `visible()` is outside this file.
    override visible(): Visibility {
        return this.visibility.copy();
    }

    /**
     * Check if the last template parameter is a tuple one, and returns it if so, else `null`.
     * (dmd/dtemplate.d:359)
     *
     * Returns:
     *   The last template parameter if it's a `TemplateTupleParameter`
     */
    isVariadic(): TemplateTupleParameter | null {
        // D dereferences `parameters` unconditionally here (dtemplate.d:361) — `!` marks that
        // fault point (02 §10.1).
        const dim = this.parameters!.length;
        if (dim === 0) return null;
        // slot `TemplateParameter | null` (08 §3); D calls through it with no null test.
        return this.parameters!.opIndex(dim - 1)!.isTemplateTupleParameter();
    }

    override isDeprecated(): boolean {
        return this.deprecated_;
    }

    /***********************************
     * We can overload templates.
     */
    override isOverloadable(): boolean {
        return true;
    }

    override accept(v: Visitor): void {
        v.visitTemplateDeclaration(this);
    }
}

/***********************************************************
 * dmd/dtemplate.d:386 — `extern (C++) final class TypeDeduced : Type`. A deduced template type,
 * internal to template matching. D declares no `accept` override (it inherits `Type`'s).
 *
 * THE LAZY-CLASS SHAPE (01-conventions.md §4.1, ratified). This is the ONE declaration in
 * dtemplate.ts that reads a core-SCC binding at MODULE-EVALUATION time: `class X extends Type` is a
 * top-level value read of `Type`. When any module reaches dtemplate.js while mtype.js is still on
 * the load stack (`mtype -> … -> dtemplate`), `Type` is still in its temporal dead zone and the
 * whole graph dies with `TypeError: Class extends value undefined` — measured at 20-33 test files,
 * and the reason six consumer sites across four modules were stubbed rather than written faithfully.
 * The fix is the ratified shape: the binding is DECLARED here and the class is DEFINED inside
 * `initDtemplate()`, which runs after every module has finished evaluating. Nothing else in this
 * file reads an SCC value at top level, so with this one deferral dtemplate.js is import-safe from
 * anywhere and its consumers use ordinary value imports.
 *
 * The type side is split in two because a `let` binding carries no instance type: `TypeDeduced` the
 * TYPE (the interface below, extending `Type` so every inherited member stays visible) and
 * `TypeDeducedCtor` the CONSTRUCTOR type of the `let`. Consumers write `new TypeDeduced(…)` and
 * `x: TypeDeduced` exactly as they would against a plain class — the split is invisible at use
 * sites, which is what keeps the port diff-able against dtemplate.d.
 */
export interface TypeDeduced extends Type {
    tded: Type;
    argexps: Expressions; // corresponding expressions
    tparams: Types; // tparams[i].mod

    /**
     * dmd/dtemplate.d:400 — `void update(Expression e, Type tparam)`.
     *
     * `update` is a SAME-NAME overload set with dtemplate.d:406 that arity dispatch cannot separate
     * (the 2-arg form's first parameter is an `Expression`, the 3-arg form's is a `Type` — the
     * shorter is not a prefix of the longer), so both are renamed per 04 §1 Form B, suffixed by the
     * distinguishing leading parameter type. This form appends without touching `tded`.
     */
    updateFromExpression(e: Expression, tparam: Type): void;

    /// dmd/dtemplate.d:406 — `void update(Type tt, Expression e, Type tparam)` (Form-B sibling of
    /// `updateFromExpression`): sets `tded`, then appends.
    updateFromType(tt: Type, e: Expression, tparam: Type): void;
}

/// Constructor type of the `TypeDeduced` binding — dmd/dtemplate.d:392 (`this(Type tt, Expression e,
/// Type tparam)`), the class's only ctor.
export interface TypeDeducedCtor {
    new (tt: Type, e: Expression, tparam: Type): TypeDeduced;
}

/// Assigned by `initDtemplate()`. Until then the binding holds `undefined`, so a premature
/// `new TypeDeduced(…)` fails LOUDLY ("TypeDeduced is not a constructor") at the call site instead
/// of corrupting anything.
export let TypeDeduced: TypeDeducedCtor;

/// One-shot latch for `initDtemplate()` (see its ONE-SHOT note). A separate boolean rather than a
/// `TypeDeduced === undefined` test, because the binding's declared type excludes `undefined` and
/// TS rejects that comparison as non-overlapping.
let typeDeducedInstalled = false;

/**
 * dtemplate's module constructor (01-conventions.md §5.1). D has no `static this()` in
 * dtemplate.d — this init function exists only to carry the §4.1 lazy class above, so its body is
 * one guarded assignment.
 *
 * ONE-SHOT (01 §5.2 "idempotent or called exactly once"): the class OBJECT is the whole of this
 * module's init state, and rebuilding it would install a SECOND class — every `TypeDeduced` built
 * before the rebuild would silently stop satisfying `instanceof TypeDeduced`. There is nothing here
 * to rebuild (no interning table, no `Id.*` singleton, no `global` state), so the guard below buys
 * the stronger property for free: repeated calls are no-ops and the class identity is stable for the
 * life of the module. That is a deliberate difference from `initTokens()` / `initImphint()`, whose
 * bodies reconstruct real tables and are idempotent BY RECONSTRUCTION. Consequence for callers: this
 * one may be called defensively — a harness `beforeEach` is safe, and so is a second shim call.
 *
 * ORDER CONTRACT (01 §5.2): the single requirement is that the mtype module has FINISHED EVALUATING
 * when this runs, since the class expression reads `Type` as a value. Any caller reached through an
 * ordinary import of dtemplate.js already has that (this module value-imports mtype.js), which is
 * why `initDtemplate()` claims no position relative to other modules' init functions. `Type._init()`
 * is a convenient anchor in the canonical harness order (10 §1.5) but is NOT required and must not
 * be stated as required: `Type`'s constructor (mtype.ts:809 — `super(); this.ty = ty;`) reads no
 * `_init` table, and dtemplate.test.ts builds a `TypeDeduced` without ever calling it. The one
 * ordering that IS load-bearing is local: `initDtemplate()` before the first `new TypeDeduced(…)`.
 * Nothing must run after it.
 *
 * NOT REGISTERED YET (open gap, integrator-owned): 01 §4.1 wants the lazy class "registered in the
 * §5 init order", and that order does not exist in the tree — there is no `src/init-order.ts` and no
 * `runModuleConstructors()` (01 §5.2's shim shape); the CLI shim is W6 work (14 §6), and today no
 * non-test file calls any `init*()`. The first compiler-path constructor of `TypeDeduced` is
 * templatesem's `deduceType` (W3), so until the shim exists a compiler path that reaches
 * `new TypeDeduced(…)` without an explicit `initDtemplate()` halts loudly at the call site.
 */
export function initDtemplate(): void {
    if (typeDeducedInstalled) return; // one-shot: see ONE-SHOT above
    typeDeducedInstalled = true;
    TypeDeduced = class TypeDeduced extends Type {
        tded: Type;
        argexps: Expressions = new DArray<Expression | null>(); // corresponding expressions
        tparams: Types = new DArray<Type | null>(); // tparams[i].mod

        // dmd/dtemplate.d:392.
        constructor(tt: Type, e: Expression, tparam: Type) {
            super(TY.Tnone);
            this.tded = tt;
            this.argexps.push(e);
            this.tparams.push(tparam);
        }

        // dmd/dtemplate.d:400 — see the doc-comment on the interface member.
        updateFromExpression(e: Expression, tparam: Type): void {
            this.argexps.push(e);
            this.tparams.push(tparam);
        }

        // dmd/dtemplate.d:406 — see the doc-comment on the interface member.
        updateFromType(tt: Type, e: Expression, tparam: Type): void {
            this.tded = tt;
            this.argexps.push(e);
            this.tparams.push(tparam);
        }
    };
}

/***********************************************************
 * https://dlang.org/spec/template.html#TemplateParameter
 *
 * dmd/dtemplate.d:417 — `extern (C++) class TemplateParameter : ASTNode`. D spells it a plain
 * class, but it declares four BODYLESS methods (dtemplate.d:464-470), which are D's pure virtuals:
 * the class cannot be instantiated in D either, so the TS form is `abstract class` with `abstract`
 * methods (02 §2).
 */
export abstract class TemplateParameter extends ASTNode {
    loc: Loc; // a value struct field (03 §5)
    ident: Identifier | null;

    /* True if this is a part of precedent parameter specialization pattern.
     *
     *  template A(T : X!TL, alias X, TL...) {}
     *  // X and TL are dependent template parameter
     *
     * A dependent template parameter should return MATCH.exact in matchArg()
     * to respect the match level of the corresponding precedent parameter.
     */
    dependent = false;

    /* ======================== TemplateParameter =============================== */
    // dmd/dtemplate.d:433 — `this(Loc loc, Identifier ident)`. `Loc` is a value struct and is never
    // null in D; this ctor is NOT part of an arity-collapsed overload set (unlike dsymbol.d:404/
    // :415/:427, whose 1- and 2-arg forms are what makes dsymbol.ts:616 nullable), so the parameter
    // stays non-null. Storing a value struct into a field copies (03 §1 #5).
    constructor(loc: Loc, ident: Identifier | null) {
        super();
        this.loc = loc.copy();
        this.ident = ident;
    }

    // dmd/dtemplate.d:439-462 — the RTTI downcasts: the base answers null, each concrete kind
    // overrides its own.
    isTemplateTypeParameter(): TemplateTypeParameter | null {
        return null;
    }

    isTemplateValueParameter(): TemplateValueParameter | null {
        return null;
    }

    isTemplateAliasParameter(): TemplateAliasParameter | null {
        return null;
    }

    isTemplateThisParameter(): TemplateThisParameter | null {
        return null;
    }

    isTemplateTupleParameter(): TemplateTupleParameter | null {
        return null;
    }

    // dmd/dtemplate.d:464-470 — bodyless in D (pure virtual) -> TS abstract; every subclass MUST
    // override (02 §2).
    abstract syntaxCopy(): TemplateParameter;

    abstract print(oarg: RootObject | null, oded: RootObject | null): void;

    abstract specialization(): RootObject | null;

    abstract hasDefaultArg(): boolean;

    // dmd/dtemplate.d:472 — D dereferences `ident` unconditionally.
    override toChars(): DString {
        return this.ident!.toChars();
    }

    override dyncast(): DYNCAST {
        return DYNCAST.templateparameter;
    }

    override accept(v: Visitor): void {
        v.visitTemplateParameter(this);
    }
}

/***********************************************************
 * https://dlang.org/spec/template.html#TemplateTypeParameter
 * Syntax:
 *  ident : specType = defaultType
 *
 * dmd/dtemplate.d:493 — `extern (C++) class TemplateTypeParameter : TemplateParameter`.
 */
export class TemplateTypeParameter extends TemplateParameter {
    specType: Type | null = null; // if !=null, this is the type specialization
    defaultType: Type | null = null;

    // dmd/dtemplate.d:498 — `extern (D) __gshared Type tdummy = null;` (a process-global slot) -> a
    // static field.
    static tdummy: Type | null = null;

    // dmd/dtemplate.d:500.
    constructor(loc: Loc, ident: Identifier | null, specType: Type | null, defaultType: Type | null) {
        super(loc, ident);
        this.specType = specType;
        this.defaultType = defaultType;
    }

    // `override final` — `final` erases (04 §8), `override` is kept.
    override isTemplateTypeParameter(): TemplateTypeParameter {
        return this;
    }

    // dmd/dtemplate.d:512.
    override syntaxCopy(): TemplateTypeParameter {
        return new TemplateTypeParameter(
            this.loc,
            this.ident,
            this.specType !== null ? this.specType.syntaxCopy() : null,
            this.defaultType !== null ? this.defaultType.syntaxCopy() : null,
        );
    }

    // dmd/dtemplate.d:517 — the `printf` debug dump. C stdio assembles its bytes through
    // `dmdformat` and flushes with one `process.stdout.write` (10 §3.5 / §4.4).
    override print(oarg: RootObject | null, oded: RootObject | null): void {
        process.stdout.write(dsToJs(dmdformat(ds(" %s\n"), [this.ident!.toChars()])));

        const t = isType(oarg);
        const ta = isType(oded);
        assert(ta);

        if (this.specType !== null)
            process.stdout.write(dsToJs(dmdformat(ds("\tSpecialization: %s\n"), [this.specType.toChars()])));
        if (this.defaultType !== null)
            process.stdout.write(dsToJs(dmdformat(ds("\tDefault:        %s\n"), [this.defaultType.toChars()])));
        process.stdout.write(
            dsToJs(dmdformat(ds("\tParameter:       %s\n"), [t !== null ? t.toChars() : ds("NULL")])),
        );
        process.stdout.write(dsToJs(dmdformat(ds("\tDeduced Type:   %s\n"), [ta.toChars()])));
    }

    override specialization(): RootObject | null {
        return this.specType;
    }

    override hasDefaultArg(): boolean {
        return this.defaultType !== null;
    }

    override accept(v: Visitor): void {
        v.visitTemplateTypeParameter(this);
    }
}

/***********************************************************
 * https://dlang.org/spec/template.html#TemplateThisParameter
 * Syntax:
 *  this ident : specType = defaultType
 *
 * dmd/dtemplate.d:554 — `extern (C++) final class TemplateThisParameter : TemplateTypeParameter`.
 */
export class TemplateThisParameter extends TemplateTypeParameter {
    // dmd/dtemplate.d:556.
    constructor(loc: Loc, ident: Identifier | null, specType: Type | null, defaultType: Type | null) {
        super(loc, ident, specType, defaultType);
    }

    override isTemplateThisParameter(): TemplateThisParameter {
        return this;
    }

    // dmd/dtemplate.d:566.
    override syntaxCopy(): TemplateThisParameter {
        return new TemplateThisParameter(
            this.loc,
            this.ident,
            this.specType !== null ? this.specType.syntaxCopy() : null,
            this.defaultType !== null ? this.defaultType.syntaxCopy() : null,
        );
    }

    override accept(v: Visitor): void {
        v.visitTemplateThisParameter(this);
    }
}

/***********************************************************
 * https://dlang.org/spec/template.html#TemplateValueParameter
 * Syntax:
 *  valType ident : specValue = defaultValue
 *
 * dmd/dtemplate.d:582 — `extern (C++) final class TemplateValueParameter : TemplateParameter`.
 */
export class TemplateValueParameter extends TemplateParameter {
    valType: Type | null = null;
    specValue: Expression | null = null;
    defaultValue: Expression | null = null;

    // dmd/dtemplate.d:588 — `extern (D) __gshared Expression[void*] edummies;`: a process-global AA
    // keyed on a POINTER. A TS Map keyed on the object reference is that same identity (the
    // Dsymbol.commentHashTable precedent, dsymbol.ts:603).
    static edummies: Map<object, Expression> = new Map();

    // dmd/dtemplate.d:590.
    constructor(
        loc: Loc,
        ident: Identifier | null,
        valType: Type | null,
        specValue: Expression | null,
        defaultValue: Expression | null,
    ) {
        super(loc, ident);
        this.valType = valType;
        this.specValue = specValue;
        this.defaultValue = defaultValue;
    }

    override isTemplateValueParameter(): TemplateValueParameter {
        return this;
    }

    // dmd/dtemplate.d:604 — D calls `valType.syntaxCopy()` UNCONDITIONALLY (no null guard), so `!`
    // marks that fault point (02 §10.1).
    override syntaxCopy(): TemplateValueParameter {
        return new TemplateValueParameter(
            this.loc,
            this.ident,
            this.valType!.syntaxCopy(),
            this.specValue !== null ? this.specValue.syntaxCopy() : null,
            this.defaultValue !== null ? this.defaultValue.syntaxCopy() : null,
        );
    }

    // dmd/dtemplate.d:612 — `oarg` is unused by D's body (only `oded` is read).
    override print(_oarg: RootObject | null, oded: RootObject | null): void {
        process.stdout.write(dsToJs(dmdformat(ds(" %s\n"), [this.ident!.toChars()])));
        const ea = isExpression(oded);
        if (this.specValue !== null)
            process.stdout.write(dsToJs(dmdformat(ds("\tSpecialization: %s\n"), [this.specValue.toChars()])));
        process.stdout.write(
            dsToJs(dmdformat(ds("\tParameter Value: %s\n"), [ea !== null ? ea.toChars() : ds("NULL")])),
        );
    }

    override specialization(): RootObject | null {
        return this.specValue;
    }

    override hasDefaultArg(): boolean {
        return this.defaultValue !== null;
    }

    override accept(v: Visitor): void {
        v.visitTemplateValueParameter(this);
    }
}

/***********************************************************
 * https://dlang.org/spec/template.html#TemplateAliasParameter
 * Syntax:
 *  specType ident : specAlias = defaultAlias
 *
 * dmd/dtemplate.d:642 — `extern (C++) final class TemplateAliasParameter : TemplateParameter`.
 */
export class TemplateAliasParameter extends TemplateParameter {
    specType: Type | null = null;
    specAlias: RootObject | null = null;
    defaultAlias: RootObject | null = null;

    // dmd/dtemplate.d:648 — `extern (D) __gshared Dsymbol sdummy = null;`.
    static sdummy: Dsymbol | null = null;

    // dmd/dtemplate.d:650.
    constructor(
        loc: Loc,
        ident: Identifier | null,
        specType: Type | null,
        specAlias: RootObject | null,
        defaultAlias: RootObject | null,
    ) {
        super(loc, ident);
        this.specType = specType;
        this.specAlias = specAlias;
        this.defaultAlias = defaultAlias;
    }

    override isTemplateAliasParameter(): TemplateAliasParameter {
        return this;
    }

    // dmd/dtemplate.d:663.
    override syntaxCopy(): TemplateAliasParameter {
        return new TemplateAliasParameter(
            this.loc,
            this.ident,
            this.specType !== null ? this.specType.syntaxCopy() : null,
            objectSyntaxCopy(this.specAlias),
            objectSyntaxCopy(this.defaultAlias),
        );
    }

    // dmd/dtemplate.d:668 — `oarg` is unused by D's body.
    override print(_oarg: RootObject | null, oded: RootObject | null): void {
        process.stdout.write(dsToJs(dmdformat(ds(" %s\n"), [this.ident!.toChars()])));
        const sa = isDsymbol(oded);
        assert(sa);
        process.stdout.write(dsToJs(dmdformat(ds("\tParameter alias: %s\n"), [sa.toChars()])));
    }

    override specialization(): RootObject | null {
        return this.specAlias;
    }

    override hasDefaultArg(): boolean {
        return this.defaultAlias !== null;
    }

    override accept(v: Visitor): void {
        v.visitTemplateAliasParameter(this);
    }
}

/***********************************************************
 * https://dlang.org/spec/template.html#TemplateSequenceParameter
 * Syntax:
 *  ident ...
 *
 * dmd/dtemplate.d:697 — `extern (C++) final class TemplateTupleParameter : TemplateParameter`.
 */
export class TemplateTupleParameter extends TemplateParameter {
    // dmd/dtemplate.d:699.
    constructor(loc: Loc, ident: Identifier | null) {
        super(loc, ident);
    }

    override isTemplateTupleParameter(): TemplateTupleParameter {
        return this;
    }

    // dmd/dtemplate.d:709.
    override syntaxCopy(): TemplateTupleParameter {
        return new TemplateTupleParameter(this.loc, this.ident);
    }

    // dmd/dtemplate.d:714 — `oarg` is unused by D's body.
    override print(_oarg: RootObject | null, oded: RootObject | null): void {
        process.stdout.write(dsToJs(dmdformat(ds(" %s... ["), [this.ident!.toChars()])));
        const v = isTuple(oded);
        assert(v);

        //printf("|%d| ", v.objects.length);
        // `foreach (i, o; v.objects)` — the INDEX form over a container value drives the index off
        // the element view (06 §1.9 "Index form" + §1.2).
        for (const [i, o] of v.objects.opSlice().entries()) {
            if (i !== 0) process.stdout.write(", ");

            const sa = isDsymbol(o);
            if (sa !== null) process.stdout.write(dsToJs(dmdformat(ds("alias: %s"), [sa.toChars()])));
            const ta = isType(o);
            if (ta !== null) process.stdout.write(dsToJs(dmdformat(ds("type: %s"), [ta.toChars()])));
            const ea = isExpression(o);
            if (ea !== null) process.stdout.write(dsToJs(dmdformat(ds("exp: %s"), [ea.toChars()])));

            assert(isTuple(o) === null); // no nested Tuple arguments
        }
        process.stdout.write("]\n");
    }

    override specialization(): RootObject | null {
        return null;
    }

    override hasDefaultArg(): boolean {
        return false;
    }

    override accept(v: Visitor): void {
        v.visitTemplateTupleParameter(this);
    }
}

/***********************************************************
 * https://dlang.org/spec/template.html#explicit_tmp_instantiation
 * Given:
 *  foo!(args) =>
 *      name = foo
 *      tiargs = args
 *
 * dmd/dtemplate.d:764 — `extern (C++) class TemplateInstance : ScopeDsymbol`.
 *
 * D field SHADOWING: `TemplateInstance.deferred` (a `TemplateInstances*`) redeclares
 * `Dsymbol.deferred` (a `bool`) — two distinct storage slots, both live. The derived slot is the
 * renamed field `deferredTI` (02 §11.5b); see its declaration below.
 *
 * D static-method HIDING: `TemplateInstance.arraySyntaxCopy(Objects*)` hides
 * `Dsymbol.arraySyntaxCopy(Dsymbols*)` (different element type). D allows it — statics hide, they
 * do not override — so the TS re-declaration is suppressed at the method, and the class static side
 * (TS2417) on the class line.
 */
// @ts-expect-error D static-method hiding (static side, TS2417): TemplateInstance.arraySyntaxCopy hides Dsymbol's.
export class TemplateInstance extends ScopeDsymbol {
    name: Identifier | null = null;

    // Array of Types/Expressions of template
    // instance arguments [int*, char, 10*10]
    tiargs: Objects | null = null;

    // Array of Types/Expressions corresponding
    // to TemplateDeclaration.parameters
    // [int, char, 100]
    tdtypes: Objects = new DArray<RootObject | null>();

    // Modules imported by this template instance
    importedModules: Modules = new DArray<Module | null>();

    tempdecl: Dsymbol | null = null; // referenced by foo.bar.abc
    enclosing: Dsymbol | null = null; // if referencing local symbols, this is the context
    aliasdecl: Dsymbol | null = null; // !=null if instance is an alias for its sole member

    /**
    If this is not null and it has a value that is not the current object,
     then this field points to an existing template instance
     and that object has been duplicated into us.

    If this object is a duplicate,
     the ``memberOf`` field will be set to a root module (passed on CLI).

    This information is useful to deduplicate analysis that may occur
     after semantic 3 has completed.

    See_Also: memberOf
    */
    inst: TemplateInstance | null = null;

    argsym: ScopeDsymbol | null = null; // argument symbol table

    /// For function template, these are the function fnames(name and loc of it) and arguments
    /// Relevant because different resolutions of `auto ref` parameters
    /// create different template instances even with the same template arguments
    fargs: Expressions | null = null;
    fnames: ArgumentLabels | null = null;

    // dmd/dtemplate.d:807 — `TemplateInstances* deferred;`. D redeclares `Dsymbol.deferred` (bool,
    // dsymbol.d:396) at a different type, and BOTH slots are live on TemplateInstance/TemplateMixin
    // objects: the bool is the `Module.deferred` queue flag (dsymbolsem.d:730-732 set, :789 clear,
    // reached with a TemplateMixin via dsymbolsem.d:3948), this slot the list of instances whose
    // semantic3 waits for this one (templatesem.d:1471 set, :1494 clear, :1550-1570 read and pushed).
    // D picks the slot by the reference's static type.
    // shadow-split: D redeclares Dsymbol.deferred; this is the DERIVED slot (02 §11.5b registry)
    deferredTI: TemplateInstances | null = null;

    /**
    If this is not null then this template instance appears in a root module's members.

    Note:   This is not useful for determining duplication status of this template instance.
            Use the field ``inst`` for determining if a template instance has been duplicated into this object.

    See_Also: inst
    */
    memberOf: Module | null = null;

    // Used to determine the instance needs code generation.
    // Note that these are inaccurate until semantic analysis phase completed.
    tinst: TemplateInstance | null = null; // enclosing template instance
    tnext: TemplateInstance | null = null; // non-first instantiated instances
    minst: Module | null = null; // the top module that instantiated this instance

    // dmd/dtemplate.d:825 — `private ushort _nest;` for recursive pretty printing detection, 3 MSBs
    // reserved for flags (the module-scope `Flag` enum below). D `private` is MODULE-scoped and
    // the file's own accessors are the only readers, so TS `private` is faithful here.
    private _nest = 0;
    inuse = 0; // ubyte — for recursive expansion detection

    // dmd/dtemplate.d:828 — `private enum Flag : uint {…}` hoisted to a module-scope TS enum
    // (02 §4.2); see its declaration below.

    /**
     * dmd/dtemplate.d:864 — `this(Loc loc, Identifier ident, Objects* tiargs) scope`
     * (`scope` is a lifetime annotation and erases, 03 §3.4).
     *
     * The second D ctor (dtemplate.d:880, `this(Loc, TemplateDeclaration, Objects*)`) has the SAME
     * arity and differs only in the 2nd parameter's type — a Form-B overload that a TS
     * `constructor` cannot express, so it is promoted to the named static factory
     * `fromTemplateDeclaration` below (04 §1.1, cheatsheet "ctor Form-B").
     */
    constructor(loc: Loc, ident: Identifier | null, tiargs: Objects | null) {
        super(loc, null);
        // resolved: static if (LOG) -> false (dtemplate.d:867) — the printf trace is dropped.
        this.dsym = DSYM.templateInstance;
        this.name = ident;
        this.tiargs = tiargs;
    }

    /*****************
     * dmd/dtemplate.d:880 — `this(Loc loc, TemplateDeclaration td, Objects* tiargs) scope`.
     * This constructor is only called when we figured out which function template to instantiate.
     *
     * Form-B ctor overload promoted to a static factory (04 §1.1): it reproduces the D body
     * field-for-field, including `super(loc, null)` via the sibling constructor and the trailing
     * `assert(tempdecl._scope)`.
     */
    static fromTemplateDeclaration(loc: Loc, td: TemplateDeclaration, tiargs: Objects | null): TemplateInstance {
        // resolved: static if (LOG) -> false (dtemplate.d:883) — the printf trace is dropped.
        // The sibling ctor already performs `super(loc, null)`, `dsym = DSYM.templateInstance`,
        // `name = ident` and `tiargs = tiargs` — the D body's first four field stores, with
        // `td.ident` supplying `name` exactly as dtemplate.d:888 does.
        const ti = new TemplateInstance(loc, td.ident, tiargs);
        ti.tempdecl = td;
        ti.semantictiargsdone = true;
        ti.havetempdecl = true;
        assert(td._scope);
        return ti;
    }

    // ── dmd/dtemplate.d:836-862 — the `_nest` bit-field accessors. The whole block is
    // `extern(D) final @safe @property pure nothrow @nogc`; the attributes erase (04 §8) and
    // `@property` decides the TS shape (04 §9): a zero-arg VALUE getter becomes a `get` accessor
    // (D reads it parenless at hdrgen.d:3984), a `(bool)` setter becomes a `set` accessor, and the
    // two zero-arg VOID mutators stay methods (D calls them `ti.nestUp()`, hdrgen.d:4018/:4025).

    /// dmd/dtemplate.d:838 — `ushort nest() const`.
    get nest(): number {
        return this._nest & Flag.available;
    }

    /// dmd/dtemplate.d:839 — `void nestUp()`. `++_nest` on a `ushort` re-truncates to 16 bits (09 §3).
    nestUp(): void {
        assert(this.nest < Flag.available);
        this._nest = (this._nest + 1) & 0xffff;
    }

    /// dmd/dtemplate.d:840 — `void nestDown()`.
    nestDown(): void {
        assert(this.nest > 0);
        this._nest = (this._nest - 1) & 0xffff;
    }

    /// has semanticTiargs() been done?
    get semantictiargsdone(): boolean {
        return (this._nest & Flag.semantictiargsdone) !== 0;
    }

    set semantictiargsdone(x: boolean) {
        if (x) this._nest |= Flag.semantictiargsdone;
        // `~Flag` on a `ushort` operand: mask back to 16 bits after the 32-bit JS complement (09 §3).
        else this._nest &= ~Flag.semantictiargsdone & 0xffff;
    }

    /// if used second constructor
    get havetempdecl(): boolean {
        return (this._nest & Flag.havetempdecl) !== 0;
    }

    set havetempdecl(x: boolean) {
        if (x) this._nest |= Flag.havetempdecl;
        else this._nest &= ~Flag.havetempdecl & 0xffff;
    }

    /// if the instantiation is done with error gagging
    get gagged(): boolean {
        return (this._nest & Flag.gagged) !== 0;
    }

    set gagged(x: boolean) {
        if (x) this._nest |= Flag.gagged;
        else this._nest &= ~Flag.gagged & 0xffff;
    }

    // dmd/dtemplate.d:896 — `extern (D) static Objects* arraySyntaxCopy(Objects* objs)`. Hides
    // Dsymbol.arraySyntaxCopy (see the class doc).
    // @ts-expect-error D static-method hiding: TemplateInstance.arraySyntaxCopy hides Dsymbol.arraySyntaxCopy.
    static arraySyntaxCopy(objs: Objects | null): Objects | null {
        let a: Objects | null = null;
        if (objs !== null) {
            a = new DArray<RootObject | null>(objs.length);
            // `foreach (i, o; *objs) (*a)[i] = objectSyntaxCopy(o);` — index form over the slice.
            for (const [i, o] of objs.opSlice().entries()) {
                a.opIndexAssign(objectSyntaxCopy(o), i);
            }
        }
        return a;
    }

    /**
     * dmd/dtemplate.d:908 — `override TemplateInstance syntaxCopy(Dsymbol s)`.
     *
     * `td.ScopeDsymbol.syntaxCopy(ti)` (dtemplate.d:914) is D's explicit base-method invocation with
     * an EXPLICIT receiver — it runs `ScopeDsymbol`'s body with `td` as `this`, NOT with `this`.
     * That is `ScopeDsymbol.prototype.syntaxCopy.call(td, ti)` in TS. The bare
     * `ScopeDsymbol.syntaxCopy(ti)` (dtemplate.d:916) is the ordinary `super` call.
     */
    override syntaxCopy(s: Dsymbol | null): TemplateInstance {
        // D `cast(TemplateInstance)s`: every caller passes a TemplateInstance or TemplateMixin, the two
        // tags `isTemplateInstance()` accepts; D would null-deref on anything else, so the `!` keeps that.
        const ti: TemplateInstance =
            s !== null ? s.isTemplateInstance()! : new TemplateInstance(this.loc, this.name, null);
        ti.tiargs = TemplateInstance.arraySyntaxCopy(this.tiargs);
        let td: TemplateDeclaration | null;
        if (this.inst !== null && this.tempdecl !== null && (td = this.tempdecl.isTemplateDeclaration()) !== null) {
            ScopeDsymbol.prototype.syntaxCopy.call(td, ti);
        } else {
            super.syntaxCopy(ti);
        }
        return ti;
    }

    override kind(): DString {
        return ds("template instance");
    }

    // dmd/dtemplate.d:925 — `override final const(char)* toPrettyCharsHelper()`.
    override toPrettyCharsHelper(): DString {
        const buf = new OutBuffer(); // dmd/dtemplate.d:927
        toCBufferInstance(this, buf, true); // dmd/dtemplate.d:928
        return buf.extractChars(); // dmd/dtemplate.d:929
    }

    /**************************************
     * dmd/dtemplate.d:940 — Given an error instantiating the TemplateInstance,
     * give the nested TemplateInstance instantiations that got
     * us here. Those are a list threaded into the nested scopes.
     * Params:
     *  cl = classification of this trace as printing either errors or deprecations
     *  max_shown = maximum number of trace elements printed (controlled with -v/-verror-limit)
     *
     * The `max_shown` default is a D expression evaluated per call — a TS default parameter is
     * evaluated per call too, so the shape carries over verbatim (04 §2).
     */
    printInstantiationTrace(
        cl: Classification = Classification.error,
        max_shown: number = global.params.v.errorSupplementCount(),
    ): void {
        if (global.gag !== 0) return;
        if (K.on && keepTrace(this, cl, max_shown))
            return;   // the kept-module engine recorded the call and made it

        // Print full trace for verbose mode, otherwise only short traces
        const format: DString = ds("instantiated from here: `%s`");

        // 02 §11.4 — TS analyses the `final switch` IIFE below INLINE, so its `assert(0)` arms narrow
        // `cl` to error-or-deprecation for the rest of this body and TS then rejects D's own
        // `cl == Classification.warning` test (dtemplate.d:971) as a no-overlap comparison. The
        // narrowing is CORRECT (that arm is dead in D too) but the D test is ported verbatim, so the
        // discriminant is re-read here — BEFORE the switch — into a const at its declared type.
        const clv: Classification = cl;

        // This returns a function pointer
        // `scope printFn = (){ ... }();` — an immediately-invoked lambda; `scope` erases (03 §3.4).
        // `&errorSupplemental` is a free-function pointer -> the function value itself (04 §4.4).
        const printFn: (loc: Loc, fmt: DString, ...args: unknown[]) => void = ((): ((
            loc: Loc,
            fmt: DString,
            ...args: unknown[]
        ) => void) => {
            // `final switch (cl)` -> switch + exhaustiveness guard (06 §3.2).
            switch (cl) {
                case Classification.error:
                    return errorSupplemental;
                case Classification.deprecation:
                    return deprecationSupplemental;
                case Classification.gagged:
                case Classification.tip:
                case Classification.warning:
                    assertUnreachable(); // faithful D `assert(0)` (dtemplate.d:958)
                default: {
                    const _e: never = cl;
                    throw new SwitchError(String(_e));
                }
            }
        })();

        // determine instantiation depth and number of recursive instantiations
        let n_instantiations = 1;
        let n_totalrecursions = 0;
        for (let cur: TemplateInstance | null = this; cur !== null; cur = cur.tinst) {
            ++n_instantiations;
            // Set error here as we don't want it to depend on the number of
            // entries that are being printed.
            // `clv` is the un-narrowed re-read of `cl` taken before the switch (see above).
            if (
                clv === Classification.error ||
                (clv === Classification.warning && global.params.useWarnings === DiagnosticReporting.error) ||
                (clv === Classification.deprecation && global.params.useDeprecated === DiagnosticReporting.error)
            )
                cur.errors = true;

            // If two instantiations use the same declaration, they are recursive.
            // (this works even if they are instantiated from different places in the
            // same template).
            // In principle, we could also check for multiple-template recursion, but it's
            // probably not worthwhile.
            if (
                cur.tinst !== null &&
                cur.tempdecl !== null &&
                cur.tinst.tempdecl !== null &&
                cur.tempdecl.loc.equals(cur.tinst.tempdecl.loc)
            )
                ++n_totalrecursions;
        }

        if (n_instantiations <= max_shown) {
            // `cur.toErrMsg()` is UFCS on the hdrgen free function; the D overload set is split by
            // operand type in the port, and a TemplateInstance is a Dsymbol -> dsymbolToErrMsg.
            for (let cur: TemplateInstance | null = this; cur !== null; cur = cur.tinst)
                printFn(cur.loc, format, dsymbolToErrMsg(cur));
        } else if (n_instantiations - n_totalrecursions <= max_shown) {
            // By collapsing recursive instantiations into a single line,
            // we can stay under the limit.
            let recursionDepth = 0;
            for (let cur: TemplateInstance | null = this; cur !== null; cur = cur.tinst) {
                if (
                    cur.tinst !== null &&
                    cur.tempdecl !== null &&
                    cur.tinst.tempdecl !== null &&
                    cur.tempdecl.loc.equals(cur.tinst.tempdecl.loc)
                ) {
                    ++recursionDepth;
                } else {
                    if (recursionDepth !== 0)
                        printFn(
                            cur.loc,
                            ds("%d recursive instantiations from here: `%s`"),
                            recursionDepth + 2,
                            cur.toChars(),
                        );
                    else printFn(cur.loc, format, cur.toChars());
                    recursionDepth = 0;
                }
            }
        } else {
            // Even after collapsing the recursions, the depth is too deep.
            // Just display the first few and last few instantiations.
            // `uint i` and `max_shown` are the unsigned domain: `max_shown / 2` is an integer
            // division and `n_instantiations - max_shown` is uint arithmetic (09 §1.1/§3). Both are
            // provably positive on this branch (n_instantiations > n_instantiations -
            // n_totalrecursions > max_shown), so the truncation is a no-op — kept explicit for audit.
            let i = 0;
            for (let cur: TemplateInstance | null = this; cur !== null; cur = cur.tinst) {
                if (i === Math.floor(max_shown / 2))
                    printFn(
                        cur.loc,
                        ds("... (%d instantiations, -v to show) ..."),
                        (n_instantiations - max_shown) >>> 0,
                    );

                if (
                    i < Math.floor(max_shown / 2) ||
                    i >= ((n_instantiations - max_shown + Math.floor(max_shown / 2)) >>> 0)
                )
                    printFn(cur.loc, format, cur.toChars());
                ++i;
            }
        }
    }

    /*************************************
     * dmd/dtemplate.d:1031 — Lazily generate identifier for template instance.
     * This is because 75% of the ident's are never needed.
     */
    override getIdent(): Identifier | null {
        if (this.ident === null && this.inst !== null && !this.errors)
            this.ident = this.genIdent(this.tiargs); // need an identifier for name mangling purposes.
        return this.ident;
    }

    /****************************************
     * dmd/dtemplate.d:1043 — This instance needs an identifier for name mangling purposes.
     * Create one by taking the template declaration name and adding
     * the type signature for it.
     */
    genIdent(args: Objects | null): Identifier {
        //printf("TemplateInstance.genIdent('%s')\n", tempdecl.ident.toChars());
        assert(args === this.tiargs);
        const buf = new OutBuffer();
        if (mangleToBufferTemplateInstanceSlot === undefined)
            throw new Error("genIdent: registerMangleToBufferTemplateInstance not called (dmd/dtemplate.d:1048)");
        mangleToBufferTemplateInstanceSlot(this, buf); // dmd/dtemplate.d:1048, mangle/package.d:64
        return Identifier.idPool(buf.peekSlice());
    }

    override accept(v: Visitor): void {
        v.visitTemplateInstance(this);
    }
}

// dmd/dtemplate.d:828 — `private enum Flag : uint { … }`, declared inside the TemplateInstance body.
// A NAMED member-list enum with a <=32-bit base -> a TS numeric `enum` (02 §4.2); the D member
// spelling `Flag.xxx` is preserved. A TS class body cannot carry an enum, so it is hoisted to module
// scope and left UNEXPORTED — D's `private` is module-scoped and no other module names `Flag`.
// The bits live in the 3 MSBs of the 16-bit `_nest`; the member expressions fold at translation
// time (07 §9): `1u << (_nest.sizeof * 8 - 1)` is `1 << 15` (`ushort.sizeof == 2`, 09 §1.4).
enum Flag {
    semantictiargsdone = 1 << 15, // MSB of the ushort
    havetempdecl = 1 << 14, // = semantictiargsdone >> 1
    gagged = 1 << 13, // = semantictiargsdone >> 2
    available = 0x1fff, // = gagged - 1 — 1s for all available bits
}

/**********************************
 * dmd/dtemplate.d:1064 — Return true if e could be valid only as a template value parameter.
 * Return false if it might be an alias or tuple.
 * (Note that even in this case, it could still turn out to be a value).
 */
export function definitelyValueParameter(e: Expression): boolean {
    // None of these can be value parameters
    if (
        e.op === EXP.tuple ||
        e.op === EXP.scope_ ||
        e.op === EXP.type ||
        e.op === EXP.dotType ||
        e.op === EXP.template_ ||
        e.op === EXP.dotTemplateDeclaration ||
        e.op === EXP.function_ ||
        e.op === EXP.error ||
        e.op === EXP.this_ ||
        e.op === EXP.super_ ||
        e.op === EXP.dot
    )
        return false;

    if (e.op !== EXP.dotVariable) return true;

    /* Template instantiations involving a DotVar expression are difficult.
     * In most cases, they should be treated as a value parameter, and interpreted.
     * But they might also just be a fully qualified name, which should be treated
     * as an alias.
     */

    // x.y.f cannot be a value
    const f: FuncDeclaration | null = e.isDotVarExp()!.var_.isFuncDeclaration();
    if (f !== null) return false;

    // D reassigns the parameter `e` while walking the `.`-chain; the port uses the sanctioned
    // widened local cursor `cur` (02 §10.1).
    let cur: Expression = e;
    while (cur.op === EXP.dotVariable) {
        cur = cur.isDotVarExp()!.e1!;
    }
    // 02 §11.4 — re-read the discriminant into a freshly-typed const after the mutating walk.
    const op: EXP = cur.op;
    // this.x.y and super.x.y couldn't possibly be valid values.
    if (op === EXP.this_ || op === EXP.super_) return false;

    // e.type.x could be an alias
    if (op === EXP.dotType) return false;

    // var.x.y is the only other possible form of alias
    if (op !== EXP.variable) return true;

    const v: VarDeclaration | null = cur.isVarExp()!.var_.isVarDeclaration();
    // func.x.y is not an alias
    if (v === null) return true;

    // https://issues.dlang.org/show_bug.cgi?id=16685
    // var.x.y where var is a constant available at compile time
    // `storage_class` is the 64-bit STC flag set -> bigint domain (02 §4.2, 09 §4.2).
    if ((v.storage_class & STC.manifest) !== 0n) return true;

    // TODO: Should we force CTFE if it is a global constant?
    return false;
}

/***********************************************************
 * https://dlang.org/spec/template-mixin.html
 * Syntax:
 *    mixin MixinTemplateName [TemplateArguments] [Identifier];
 *
 * dmd/dtemplate.d:1124 — `extern (C++) final class TemplateMixin : TemplateInstance`.
 */
export class TemplateMixin extends TemplateInstance {
    tqual: TypeQualified | null = null;

    // dmd/dtemplate.d:1128 — the super-call derives the instance name from `tqual`: the LAST
    // qualifier ident if there is one, else the leading TypeIdentifier's ident. D dereferences
    // `tqual` unconditionally, so `!` marks that fault point (02 §10.1).
    constructor(loc: Loc, ident: Identifier | null, tqual: TypeQualified | null, tiargs: Objects | null) {
        const q = tqual!;
        // `tqual.idents` is an `Objects` (Array!RootObject); the `cast(Identifier)` is D's checked
        // downcast on an element the parser guarantees is an Identifier.
        const name: Identifier | null =
            q.idents.length !== 0
                ? (q.idents.opIndex(q.idents.length - 1) as Identifier) // D `cast(Identifier)` downcast
                : (q as TypeIdentifier).ident; // D `cast(TypeIdentifier)` downcast
        super(loc, name, tiargs !== null ? tiargs : new DArray<RootObject | null>());
        //printf("TemplateMixin(ident = '%s')\n", ident ? ident.toChars() : "");
        this.dsym = DSYM.templateMixin;
        this.ident = ident;
        this.tqual = tqual;
    }

    // dmd/dtemplate.d:1139.
    override syntaxCopy(_s: Dsymbol | null): TemplateInstance {
        const tm = new TemplateMixin(this.loc, this.ident, this.tqual!.syntaxCopy(), this.tiargs);
        return super.syntaxCopy(tm);
    }

    override kind(): DString {
        return ds("mixin");
    }

    override accept(v: Visitor): void {
        v.visitTemplateMixin(this);
    }
}

/***********************************************
 * dmd/dtemplate.d:1159 — `struct TemplateStats`: collect and print statistics on template
 * instantiations. A VALUE type (02 §2): `.copy()` value-copies the two counters and SHARES the
 * `allInstances` container reference (03 §2).
 */
export class TemplateStats {
    // dmd/dtemplate.d:1161 — `__gshared TemplateStats[const void*] stats;`: a process-global AA
    // keyed on the TemplateDeclaration POINTER. A TS Map keyed on the object reference is that same
    // identity (the Dsymbol.commentHashTable precedent, dsymbol.ts:603).
    static stats: Map<TemplateDeclaration, TemplateStats> = new Map();

    numInstantiations = 0; // number of instantiations of the template
    uniqueInstantiations = 0; // number of unique instantiations of the template

    allInstances: TemplateInstances | null = null;

    // D builds this struct two ways (03 §6.4): default-init (`TemplateStats ts;` — all fields at
    // their `.init`) and the field-order value literal `TemplateStats(1, 0)` / `TemplateStats(0, 1)`
    // (dtemplate.d:1198/:1216). One constructor, both births.
    constructor(numInstantiations = 0, uniqueInstantiations = 0) {
        this.numInstantiations = numInstantiations;
        this.uniqueInstantiations = uniqueInstantiations;
    }

    copy(): TemplateStats {
        const c = new TemplateStats(this.numInstantiations, this.uniqueInstantiations);
        c.allInstances = this.allInstances; // container reference: share (03 §2)
        return c;
    }

    /*******************************
     * dmd/dtemplate.d:1175 — Add this instance
     * Params:
     *  td = template declaration
     *  ti = instance of td
     *  listInstances = keep track of instances of templates
     */
    static incInstance(
        td: TemplateDeclaration | null,
        ti: TemplateInstance | null,
        listInstances: boolean,
    ): void {
        // dmd/dtemplate.d:1179 — the nested `void log(ref TemplateStats ts)`: an inner arrow that
        // inherits `this`/the enclosing locals (04 §5). `ref` = alias, no `.copy()` (03 §3.2).
        const log = (ts: TemplateStats): void => {
            if (ts.allInstances === null) ts.allInstances = new DArray<TemplateInstance | null>();
            if (listInstances) ts.allInstances.push(ti); // `cast() ti` only strips const — erases
        };

        // message(ti.loc, "incInstance %p %p", td, ti);
        if (td === null) return;
        assert(ti);
        // `if (auto ts = <key> in stats)` — D's `in` yields a POINTER to the stored value (null when
        // absent), so mutations through it hit the stored struct. `Map.get` returns the stored
        // object reference, which is the same aliasing; the hoist + `!== undefined` test is
        // 06 §2.6/§2.7.
        const ts = TemplateStats.stats.get(td);
        if (ts !== undefined) {
            log(ts);
            ts.numInstantiations = (ts.numInstantiations + 1) >>> 0; // uint increment (09 §3)
        } else {
            TemplateStats.stats.set(td, new TemplateStats(1, 0));
            log(TemplateStats.stats.get(td)!);
        }
    }

    /*******************************
     * dmd/dtemplate.d:1206 — Add this unique instance
     */
    static incUnique(td: TemplateDeclaration | null, ti: TemplateInstance | null): void {
        // message(ti.loc, "incUnique %p %p", td, ti);
        if (td === null) return;
        assert(ti);
        const ts = TemplateStats.stats.get(td);
        if (ts !== undefined) ts.uniqueInstantiations = (ts.uniqueInstantiations + 1) >>> 0; // uint (09 §3)
        else TemplateStats.stats.set(td, new TemplateStats(0, 1));
    }
}

/**
 * dmd/dtemplate.d:1228 — `static struct TemplateDeclarationStats`, declared INSIDE
 * `printTemplateStats`. A function-local aggregate has no TS equivalent, so it is hoisted to a
 * file-private module-scope class (same disposition as a class-scoped manifest enum, 02 §4.1).
 * A plain VALUE struct: `.copy()` shares the `td` reference and recurses into the `ts` field.
 */
class TemplateDeclarationStats {
    td: TemplateDeclaration;
    ts: TemplateStats;

    // D builds it with the field-order value literal `TemplateDeclarationStats(td, ts)`
    // (dtemplate.d:1251).
    constructor(td: TemplateDeclaration, ts: TemplateStats) {
        this.td = td;
        this.ts = ts;
    }

    copy(): TemplateDeclarationStats {
        return new TemplateDeclarationStats(this.td, this.ts.copy()); // class ref shared, struct recursed
    }

    /**
     * dmd/dtemplate.d:1232 — `static int compare(scope const TemplateDeclarationStats* a, scope
     * const TemplateDeclarationStats* b)`. The `scope const ...*` parameters are pointers to the
     * value struct -> the object references (02 §10 case 2), and `Array.sort` hands the predicate
     * the ELEMENTS directly (08 §2.5), so D's implicit deref vanishes.
     *
     * `uniqueInstantiations`/`numInstantiations` are `uint`: the subtraction is unsigned arithmetic
     * (`>>> 0`), and returning it as `int` reinterprets the same bits (`| 0`) — exactly D's implicit
     * uint->int conversion (09 §3/§3.1).
     */
    static compare(a: TemplateDeclarationStats, b: TemplateDeclarationStats): number {
        const diff = (b.ts.uniqueInstantiations - a.ts.uniqueInstantiations) >>> 0;
        if (diff !== 0) return diff | 0;

        return ((b.ts.numInstantiations - a.ts.numInstantiations) >>> 0) | 0;
    }
}

/********************************
 * dmd/dtemplate.d:1226 — Print informational statistics on template instantiations.
 * Params:
 *      listInstances = list instances of templates
 *      eSink = where the print is sent
 */
export function printTemplateStats(listInstances: boolean, eSink: ErrorSink): void {
    const stats_length = TemplateStats.stats.size;
    if (stats_length === 0) return; // nothing to report

    // `Array!(TemplateDeclarationStats)` holds the struct BY VALUE, so the element type takes no
    // `| null` (08 §3 value-element rule).
    const sortedStats: DArray<TemplateDeclarationStats> = new DArray<TemplateDeclarationStats>();
    sortedStats.reserve(stats_length);
    // `foreach (td_, ref ts; TemplateStats.stats)` — built-in AA, key+value (06 §1.5); `ref ts` is
    // an alias, so no `.copy()` on the loop variable. D's AA iteration order is unspecified and the
    // result is sorted below.
    for (const [td_, ts] of TemplateStats.stats) {
        // storing `ts` into the struct's field copies it (03 §1 #5).
        sortedStats.push(new TemplateDeclarationStats(td_, ts.copy()));
    }

    sortedStats.sort(TemplateDeclarationStats.compare);

    // dmd/dtemplate.d:1256 — `OutBuffer buf;` (a value struct, D-default-initialized, 03 §6.4).
    const buf = new OutBuffer();
    // dmd/dtemplate.d:1257 — `foreach (const ref ss; sortedStats[])`. `sortedStats[]` is D's
    // no-arg `opSlice()` view (05 §7); `const ref ss` is an alias, so no per-element `.copy()`.
    for (const ss of sortedStats.opSlice()) {
        buf.reset();
        // dmd/dtemplate.d:1260-1261 — `HdrGenState hgs; hgs.skipConstraints = true;`
        const hgs = new HdrGenState();
        hgs.skipConstraints = true;
        toCharsMaybeConstraints(ss.td, buf, hgs); // dmd/dtemplate.d:1262
        const tchars = buf.peekChars(); // dmd/dtemplate.d:1263 — a view, read before the next reset
        if (listInstances && ss.ts.allInstances) { // dmd/dtemplate.d:1264
            eSink.message(ss.td.loc,
                ds("vtemplate: %u (%u distinct) instantiation(s) of template `%s` found, they are:"),
                ss.ts.numInstantiations,
                ss.ts.uniqueInstantiations,
                tchars);
            // dmd/dtemplate.d:1271 — `foreach (const ti; (*ss.ts.allInstances)[])`
            for (const ti of ss.ts.allInstances.opSlice()) {
                if (ti!.tinst) // if has enclosing instance
                    eSink.message(ti!.loc, ds("vtemplate: implicit instance `%s`"), ti!.toChars());
                else
                    eSink.message(ti!.loc, ds("vtemplate: explicit instance `%s`"), ti!.toChars());
            }
        } else {
            eSink.message(ss.td.loc,
                ds("vtemplate: %u (%u distinct) instantiation(s) of template `%s` found"),
                ss.ts.numInstantiations,
                ss.ts.uniqueInstantiations,
                tchars);
        }
    }
}

/// dmd/dtemplate.d:1290 — `void write(ref OutBuffer buf, RootObject obj)`. `ref OutBuffer` is an
/// alias, no copy (03 §3.2). `e.toErrMsg()` is UFCS on the hdrgen free function (04 §6): the D
/// overload set is split by operand type in the port, and this arm's operand is an Expression.
export function write(buf: OutBuffer, obj: RootObject | null): void {
    if (obj !== null) {
        const e = isExpression(obj);
        // dtemplate.d:1295/:1297 `writestring(const(char)*)`: the bytes before the NUL
        if (e !== null) buf.writestring(cstr(toErrMsg(e)));
        else buf.writestring(cstr(obj.toChars()));
    }
}
