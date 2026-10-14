// Ported from dmd/init.d (module dmd.init).
//
// "Defines initializers of variables, e.g. the array literal in `int[3] x = [0, 1, 2]`."
// The WHOLE module: the `NeedInterpret` enum + its two member aliases, the `Initializer` class
// hierarchy (one final class per `InitKind` tag), the two C-initializer VALUE structs
// (`Designator`, `DesigInit`), and the free function `syntaxCopy`. The two remaining top-level
// declarations — `mixin template VisitInitializer(Result)` (init.d:369) and the CTFE helper
// `string visitCase(string)` (init.d:394) — are compile-time code generators that emit no runtime
// symbol; they are resolved at each instantiation site and dropped-with-comment (07 §6.2, see the
// note at the bottom of this file and the expanded dispatch inside `syntaxCopy`).
//
// CONTAINERS (08 §3): `Identifiers` / `Expressions` / `Initializers` are `Array<T | null>` and are
// CONSTRUCTED as their alias. The nullability is real here, not defensive: `StructInitializer`
// field names are absent for positional elements (parse.d passes a null `Identifier` to
// `addInit`), and an `ArrayInitializer` index slot is null for a plain (non-`[expr]:`) element —
// init.d:199 and init.d:322 both null-TEST those slots. `Designators` / `DesigInits` hold D structs
// BY VALUE, so their element types take no `| null`.
//
// VISITOR (13 §2): every `override void accept(Visitor v) { v.visit(this); }` becomes
// `v.visit<ThisNodeClass>(this)` — the node's OWN named method, never the base's.
//
// VALUE SEMANTICS (03): `Loc` is an ALIAS-SAFE REGISTER member (03 §9.1) — sharing it on read is
// licensed with no per-site comment. `Designator` / `DesigInit` are plain copyable structs (no
// `@disable this(this)`, no postblit/opAssign/copy-ctor), so each exports a per-field `.copy()`
// (03 §2/§6.6) whose fields are all references and are therefore SHARED.
//
// CYCLES (01 §4.2): `Type`, `Expression`, `Identifier`, `Visitor` and the array aliases appear only
// in type positions -> `import type` (erased, so they contribute nothing to the ESM evaluation
// cycle of the core SCC). `ASTNode` (the `extends` base), `Loc` (`Loc.initial` is READ in the
// `ErrorInitializer` ctor), `DYNCAST`, `InitKind`, the runtime `Array` and the assert helpers are
// value imports; none of those modules imports back into init.ts, so every edge is one-way (01 §4.1).

import { ASTNode } from "./ast_node.js";
import { DYNCAST } from "./rootobject.js";
import { InitKind } from "./astenums.js";
import { assert, SwitchError } from "../assert.js";
// `Loc` is a VALUE import: `Loc.initial` is read by the `ErrorInitializer` ctor (init.d:138).
import { Loc } from "./location.js";
// The runtime growable container (08 §2). Value import — the inline `Array!T` value members of
// `StructInitializer`/`ArrayInitializer`/`CInitializer` are constructed here.
import { Array as DArray } from "./root/array.js";

import type { Visitor } from "./visitor/index.js";
import type { Type } from "./mtype.js";
import type { Expression } from "./expression.js";
import type { Identifier } from "./identifier.js";
import type {
    Identifiers,
    Initializers,
    Expressions,
    Designators,
    DesigInits,
} from "./arraytypes.js";

/**
 * init.d:26 — `enum NeedInterpret : int`. Whether an initializer must be CTFE-interpreted.
 *
 * `int` base (<= 32 bit) -> a TS numeric enum (02 §4.2); members keep their declaration order,
 * so `INITnointerpret == 0` and `INITinterpret == 1`.
 */
export enum NeedInterpret {
    INITnointerpret,
    INITinterpret,
}

// init.d:32-33 — `alias INITnointerpret = NeedInterpret.INITnointerpret;` etc. These are SYMBOL
// aliases re-exposing the members as bare module-level names -> exported const re-bindings (02 §5.3).
export const INITnointerpret = NeedInterpret.INITnointerpret;
export const INITinterpret = NeedInterpret.INITinterpret;

/***********************************************************
 * init.d:37 — `extern (C++) class Initializer : ASTNode`. The base of every initializer node.
 *
 * NOT abstract in D: the base is concrete (its `accept` forwards to the visitor's
 * `visitInitializer`), so it stays a plain class here. `kind` is the discriminant every
 * `isXxxInitializer()` below tests and every dispatcher (`syntaxCopy`, `initializerSemantic`)
 * switches on — it is set once by this constructor and never rewritten.
 */
export class Initializer extends ASTNode {
    loc: Loc;
    kind: InitKind;
    /// initializerSemantic has been run on this
    semanticDone: boolean = false;

    /// init.d:43 — the RootObject RTTI tag: every Initializer answers `DYNCAST.initializer`.
    override dyncast(): DYNCAST {
        return DYNCAST.initializer;
    }

    /// init.d:49 — `extern (D) this(Loc loc, InitKind kind)`.
    constructor(loc: Loc, kind: InitKind) {
        super();
        this.loc = loc; // Loc: alias-safe register member (03 §9.1) — shared, no .copy()
        this.kind = kind;
    }

    // init.d:55-89 — the `isXxxInitializer()` tag-downcast block. Each is
    // `kind == InitKind.x ? cast(inout X)cast(void*)this : null` — a `void*` reinterpret used
    // deliberately to skip the dynamic-cast call, i.e. a pure TAG test, not an RTTI query. In TS
    // the runtime object already IS the subclass, so the D cast pair becomes the tree's standard
    // tag-downcast spelling `this as unknown as X` (precedent: expression.ts:415 `isIntegerExp`,
    // mtype.ts:2218 `isTypeSArray`). `final` and the `inout(...)` wrapper are erased (04 §8).
    isErrorInitializer(): ErrorInitializer | null { return this.kind === InitKind.error ? (this as unknown as ErrorInitializer) : null; }
    isVoidInitializer(): VoidInitializer | null { return this.kind === InitKind.void_ ? (this as unknown as VoidInitializer) : null; }
    isDefaultInitializer(): DefaultInitializer | null { return this.kind === InitKind.default_ ? (this as unknown as DefaultInitializer) : null; }
    isStructInitializer(): StructInitializer | null { return this.kind === InitKind.struct_ ? (this as unknown as StructInitializer) : null; }
    isArrayInitializer(): ArrayInitializer | null { return this.kind === InitKind.array ? (this as unknown as ArrayInitializer) : null; }
    isExpInitializer(): ExpInitializer | null { return this.kind === InitKind.exp ? (this as unknown as ExpInitializer) : null; }
    isCInitializer(): CInitializer | null { return this.kind === InitKind.C_ ? (this as unknown as CInitializer) : null; }

    /// init.d:91 — `override void accept(Visitor v) { v.visit(this); }` (13 §2).
    override accept(v: Visitor): void {
        v.visitInitializer(this);
    }
}

/***********************************************************
 * init.d:99 — `extern (C++) final class VoidInitializer : Initializer` (`= void`).
 */
export class VoidInitializer extends Initializer {
    /// type that this will initialize to
    type: Type | null = null;

    /// init.d:103 — `extern (D) this(Loc loc)`.
    constructor(loc: Loc) {
        super(loc, InitKind.void_);
    }

    override accept(v: Visitor): void {
        v.visitVoidInitializer(this);
    }
}

/***********************************************************
 * init.d:117 — the C23 default initializer `{ }`.
 */
export class DefaultInitializer extends Initializer {
    /// type that this will initialize to
    type: Type | null = null;

    /// init.d:121 — `extern (D) this(Loc loc)`.
    constructor(loc: Loc) {
        super(loc, InitKind.default_);
    }

    override accept(v: Visitor): void {
        v.visitDefaultInitializer(this);
    }
}

/***********************************************************
 * init.d:134 — the poisoned initializer produced after a semantic error.
 */
export class ErrorInitializer extends Initializer {
    /// init.d:136 — `extern (D) this()`; D passes `Loc.initial`, the shared no-location value.
    constructor() {
        super(Loc.initial, InitKind.error);
    }

    override accept(v: Visitor): void {
        v.visitErrorInitializer(this);
    }
}

/***********************************************************
 * init.d:149 — `S s = { a: 1, 2 }`: two PARALLEL arrays, `field[i]` naming `value[i]`.
 *
 * `field` / `value` are `Array!T` value members held INLINE by the class (D `Identifiers field;`,
 * not a pointer), default-constructed empty — reproduced by the declaration-site construction
 * below, which uses each alias's own element type (08 §3 construction rule).
 */
export class StructInitializer extends Initializer {
    /// of Identifier *'s
    field: Identifiers = new DArray<Identifier | null>();
    /// parallel array of Initializer *'s
    value: Initializers = new DArray<Initializer | null>();

    /// init.d:154 — `extern (D) this(Loc loc)`.
    constructor(loc: Loc) {
        super(loc, InitKind.struct_);
    }

    /**
     * init.d:159 — `extern (D) void addInit(Identifier field, Initializer value)`.
     *
     * `field` is genuinely NULLABLE: the positional (un-named) element of a struct initializer
     * has no field name and parse.d passes `null` there (parse.d's `_is.addInit(null, value)`
     * arm). The body neither dereferences nor null-tests it — it only pushes into `Identifiers`,
     * whose slots are `Identifier | null` (08 §3) — so the parameter carries the nullability
     * (02 §10.1). `value` stays non-null: every in-scope caller passes a parsed Initializer.
     */
    addInit(field: Identifier | null, value: Initializer): void {
        //printf("StructInitializer::addInit(field = %p, value = %p)\n", field, value);
        this.field.push(field);
        this.value.push(value);
    }

    override accept(v: Visitor): void {
        v.visitStructInitializer(this);
    }
}

/***********************************************************
 * init.d:174 — `int[3] x = [0, 1, 2]` / `int[3] x = [2: 7]`: parallel index/value arrays.
 */
export class ArrayInitializer extends Initializer {
    /// indices
    index: Expressions = new DArray<Expression | null>();
    /// of Initializer *'s
    value: Initializers = new DArray<Initializer | null>();
    /// length of array being initialized (`uint` -> number, 09 §1)
    dim: number = 0;
    /// type that array will be used to initialize
    type: Type | null = null;
    /// C array semantics
    isCarray: boolean = false;

    /// init.d:182 — `extern (D) this(Loc loc)`.
    constructor(loc: Loc) {
        super(loc, InitKind.array);
    }

    /**
     * init.d:187 — `extern (D) void addInit(Expression index, Initializer value)`.
     *
     * `index` is genuinely NULLABLE (a plain element has no `[expr]:` designator; parse.d passes
     * `null` and `isAssociativeArray` below null-TESTS the stored slots), so the parameter is
     * `Expression | null` (02 §10.1 + 08 §3). Appending invalidates the resolved shape: `dim` and
     * `type` are reset exactly as D does.
     */
    addInit(index: Expression | null, value: Initializer): void {
        this.index.push(index);
        this.value.push(value);
        this.dim = 0;
        this.type = null;
    }

    /// init.d:195 — true iff any element carries an index (`[k]: v`), i.e. this is an AA literal.
    isAssociativeArray(): boolean {
        for (const idx of this.index) { // foreach (idx; index) over an Array value (06 §1.9, 08 §2.0b)
            if (idx !== null) // nullable-reference truthiness -> explicit null test (06 §2.7)
                return true;
        }
        return false;
    }

    override accept(v: Visitor): void {
        v.visitArrayInitializer(this);
    }
}

/***********************************************************
 * init.d:213 — the ordinary `= expression` initializer.
 */
export class ExpInitializer extends Initializer {
    expandTuples: boolean = false;
    exp: Expression | null;

    /// init.d:218 — `extern (D) this(Loc loc, Expression exp)`.
    constructor(loc: Loc, exp: Expression | null) {
        super(loc, InitKind.exp);
        this.exp = exp;
    }

    override accept(v: Visitor): void {
        v.visitExpInitializer(this);
    }
}

/*********************************************
 * init.d:233 — holds the `designator` for C initializers. A plain VALUE struct (02 §2): copyable
 * (no `@disable this(this)`), so it exports `.copy()` (03 §2/§6.6).
 *
 * D declares TWO value constructors of the SAME arity distinguished only by the parameter TYPE
 * (init.d:238 `this(Expression)`, init.d:239 `this(Identifier)`). A TS `constructor` cannot be
 * overloaded by type, and a runtime `instanceof` discriminator is forbidden outright — `null`
 * satisfies the static type of BOTH D forms while `null instanceof T` is always false, so the
 * collapsed ctor would route every null argument to the wrong branch (04 §1.1(c) "the null trap",
 * 10 §1.9). Both value forms are therefore promoted to named static factories (Form B, 04 §1).
 *
 * DEVIATION FROM 04 §1.1(c), stated so it is auditable rather than silent: that rule keeps the
 * **field/primary** ctor as the TS `constructor` and promotes only the other form. It cannot be
 * followed literally here because NEITHER D ctor is the field/primary one — each sets exactly one
 * of the two fields and leaves the other at `.init`, so promoting one and keeping the other would
 * make an arbitrary choice look canonical. What must survive instead is 03 §6.4's invariant that
 * `new T()` with no arguments reproduces D's `T x;`: the implicit zero-argument constructor IS
 * D's DEFAULT-INIT path (every field takes its `.init`, here `null` for both class references —
 * 09 §1.0), and that is what a `Designators` array slot and `Designator.init` mean. Both value
 * forms therefore become factories and the zero-arg birth stays the constructor. The factory names
 * follow §1.1(c)'s naming rule (keyed to the distinguishing TYPE, as in `SourceLoc.fromLoc` /
 * `StringExp.fromCStr`), hence `fromExpression` / `fromIdentifier` — the spelling a later agent
 * porting cparse.d, the only module that constructs a `Designator`, will reach for.
 */
export class Designator {
    /// [ constant-expression ]
    exp: Expression | null = null;
    /// . identifier
    ident: Identifier | null = null;

    /// init.d:238 — `this(Expression exp)`. Form-B factory; `ident` keeps its `.init` (null).
    static fromExpression(exp: Expression): Designator {
        const d = new Designator();
        d.exp = exp;
        return d;
    }

    /// init.d:239 — `this(Identifier ident)`. Form-B factory; `exp` keeps its `.init` (null).
    static fromIdentifier(ident: Identifier): Designator {
        const d = new Designator();
        d.ident = ident;
        return d;
    }

    /// `.copy()` (03 §2): both fields are class references -> SHARE them (D's struct copy is
    /// shallow over class members). No postblit / opAssign / copy-ctor on this struct.
    copy(): Designator {
        const c = new Designator();
        c.exp = this.exp;
        c.ident = this.ident;
        return c;
    }
}

/*********************************************
 * init.d:245 — holds the `designation (opt) initializer` for C initializers. A plain VALUE struct
 * with no D constructor: `DesigInit.init` is both fields null, which is what the field
 * initializers below reproduce.
 */
export class DesigInit {
    /// designation (opt)
    designatorList: Designators | null = null;
    /// initializer
    initializer: Initializer | null = null;

    /// `.copy()` (03 §2): `designatorList` is a `Designators*` — a POINTER to the container, i.e.
    /// the Array reference itself (02 §10), shared; `initializer` is a class reference, shared.
    copy(): DesigInit {
        const c = new DesigInit();
        c.designatorList = this.designatorList;
        c.initializer = this.initializer;
        return c;
    }
}

/********************************
 * init.d:255 — C11 6.7.9 Initialization. Represents the C initializer-list.
 */
export class CInitializer extends Initializer {
    /// initializer-list (inline `Array!DesigInit` value member, constructed empty)
    initializerList: DesigInits = new DArray<DesigInit>();
    /// type that array will be used to initialize
    type: Type | null = null;

    /// init.d:260 — `extern (D) this(Loc loc)`.
    constructor(loc: Loc) {
        super(loc, InitKind.C_);
    }

    override accept(v: Visitor): void {
        v.visitCInitializer(this);
    }
}

/****************************************
 * init.d:278 — `Initializer syntaxCopy(Initializer inx)`: copy the AST for an Initializer.
 *
 * Params:
 *      inx = Initializer AST to copy
 * Returns:
 *      the copy
 *
 * A module-level FREE function (D call sites reach it by UFCS as `init.syntaxCopy()`); it is NOT a
 * method on `Initializer`, and the recursive `vi.value[i].syntaxCopy()` inside the nested visitors
 * is UFCS for this same function -> a plain recursive call here.
 *
 * Return type is `Initializer | null`: the expanded mixin's fall-through is `return Result.init;`
 * with `Result = Initializer`, and a class `.init` is `null` (09 §1.0). No nested visitor below
 * actually returns null, so the fall-through is unreachable in practice — but the D signature
 * permits it and every in-scope caller already stores into an `Initializer | null` slot.
 *
 * The nested `static` D functions become inner `const` arrows (04 §5), declared before the
 * dispatch, in D source order.
 */
export function syntaxCopy(inx: Initializer): Initializer | null {
    /// init.d:280 — a fresh `VoidInitializer`; no children to copy.
    const visitVoid = (vi: VoidInitializer): Initializer => new VoidInitializer(vi.loc);

    /// init.d:285 — a fresh `DefaultInitializer`; no children to copy.
    const visitDefault = (vi: DefaultInitializer): Initializer => new DefaultInitializer(vi.loc);

    /// init.d:290 — an ErrorInitializer copies to ITSELF (identity preserved, deliberately).
    const visitError = (vi: ErrorInitializer): Initializer => vi;

    /// init.d:295 — copy the wrapped expression through `Expression.syntaxCopy` (a METHOD on
    /// Expression, expression.d:197 — not this free function).
    const visitExp = (vi: ExpInitializer): Initializer =>
        // `vi.exp` is dereferenced unconditionally by D -> `!` marks the exact site D would fault (08 §3).
        new ExpInitializer(vi.loc, vi.exp!.syntaxCopy());

    /// init.d:300 — deep-copy the parallel field/value arrays of a struct initializer.
    const visitStruct = (vi: StructInitializer): Initializer => {
        const si = new StructInitializer(vi.loc);
        assert(vi.field.length === vi.value.length);
        si.field.setDim(vi.field.length);
        si.value.setDim(vi.value.length);
        // foreach (const i; 0 .. vi.field.length) — D evaluates the bound ONCE at loop entry, so it
        // is captured into a `const` here rather than re-read per iteration (06 §1.3).
        const nField = vi.field.length;
        for (let i = 0; i < nField; i++) {
            // `field` slots are `Identifier | null` and the Identifier is SHARED, not copied.
            si.field.opIndexAssign(vi.field.opIndex(i), i); // si.field[i] = vi.field[i]  (05 §7)
            // init.d:309 calls THROUGH the value slot with no null test -> `!` (08 §3). Contrast
            // `visitArray` below, where the sibling `index` array IS null-tested by D.
            si.value.opIndexAssign(syntaxCopy(vi.value.opIndex(i)!), i);
        }
        return si;
    };

    /// init.d:314 — deep-copy the parallel index/value arrays of an array initializer.
    const visitArray = (vi: ArrayInitializer): Initializer => {
        const ai = new ArrayInitializer(vi.loc);
        assert(vi.index.length === vi.value.length);
        ai.index.setDim(vi.index.length);
        ai.value.setDim(vi.value.length);
        const nValue = vi.value.length; // bound captured once at loop entry (06 §1.3)
        for (let i = 0; i < nValue; i++) { // foreach (const i; 0 .. vi.value.length)
            // init.d:322 — `ai.index[i] = vi.index[i] ? vi.index[i].syntaxCopy() : null;`. The D
            // source re-reads `vi.index[i]` in the true arm; `Array.opIndex` is a pure bounds-checked
            // read, so hoisting it into one `const` preserves evaluation exactly. The condition is a
            // nullable-reference truthiness test -> explicit `!== null` (06 §2.7); the null STORE is
            // direct because the `Expressions` alias carries the nullability (08 §3).
            const idx = vi.index.opIndex(i);
            ai.index.opIndexAssign(idx !== null ? idx.syntaxCopy() : null, i);
            // init.d:323 — the value slot is dereferenced unconditionally -> `!`.
            ai.value.opIndexAssign(syntaxCopy(vi.value.opIndex(i)!), i);
        }
        return ai;
    };

    /// init.d:328 — deep-copy a C initializer-list (designation + initializer per element).
    const visitC = (vi: CInitializer): Initializer => {
        const ci = new CInitializer(vi.loc);
        ci.initializerList.setDim(vi.initializerList.length);
        const nElem = vi.initializerList.length; // bound captured once at loop entry (06 §1.3)
        for (let i = 0; i < nElem; i++) {
            // init.d:334-335 — `DesigInit* cdi = &ci.initializerList[i];` and
            //                  `DesigInit* vdi = &ci.initializerList[i];`.
            // `&elem` of a by-value struct element is the element OBJECT itself (03 §7.2), so both
            // names alias the SAME slot. NOTE the D source reads `ci` on BOTH lines — `vdi`
            // evidently meant `&vi.initializerList[i]`. Reproduced VERBATIM (faithful 1:1, this is
            // not a wall): the loop therefore reads back the freshly-`setDim`'d DESTINATION slot.
            //
            // WHAT THAT SLOT HOLDS IN D — read out of root/array.d, not assumed. `Array!T` carries
            // INLINE storage `T[SMALLARRAYCAP] smallarray` with `SMALLARRAYCAP = 1` (array.d:36-37),
            // so it is NOT true that a grow always goes through `mem.xmalloc`: `setDim(n)`
            // (array.d:293) -> `reserve(n)` (array.d:165) -> `enlarge(n)` takes `data = smallarray[]`
            // whenever `n <= SMALLARRAYCAP` (array.d:176-178) and `mem.xmalloc` only above that
            // (array.d:182). `enlarge` then memsets `[length .. data.length)` to 0xFF — but ONLY
            // `if (mem.isGCEnabled)` (array.d:227-232), and the driver calls `mem.disableGC()`
            // unless `-lowmem` was passed (main.d:115-122, driver/main.cpp:1146-1147). So the slot is:
            //   len 1, GC off (the DEFAULT invocation): the class field's own inline `smallarray`,
            //     default-initialized -> `DesigInit.init` == `{null, null}`, a DETERMINISTIC DEFAULT;
            //   len 1 under `-lowmem`: all-0xFF bytes;
            //   len >= 2: raw `mem.xmalloc` bytes (GC off) or all-0xFF (`-lowmem`).
            //
            // 08 §2.0a escalates a grow whose result is READ BACK AS A DEFAULT, i.e. consumed as a
            // value. That trigger is NOT met in any of the four configurations above: the slot's
            // `initializer` is never used as a value — init.d:336 immediately dereferences it
            // (`vdi.initializer.syntaxCopy()` is UFCS for `syntaxCopy(vdi.initializer)`, whose first
            // act is `init.kind`). D therefore FAULTS on every non-empty list — a null-class-ref
            // deref in the default configuration, a wild deref in the other three. Nothing depends
            // on the default value, so there is no default to synthesize, nothing to special-case at
            // `T = DesigInit`, and nothing to escalate; the port keeps the plain grow-without-prefill.
            // ASYMMETRY worth naming: the two fault on DIFFERENT operations. D reads a valid slot and
            // faults one line later inside `syntaxCopy`; here `setDim` leaves a JS hole, so
            // `opIndex(i)` yields `undefined` and the fault is the member access on this line. Same
            // outcome for the same inputs (non-empty list => throw), different throwing operation.
            // An EMPTY list copies cleanly in both — the only shape the in-scope frontend produces
            // (`CInitializer` bodies come from the excluded ImportC parser, 11 §3.1).
            const cdi = ci.initializerList.opIndex(i);
            const vdi = ci.initializerList.opIndex(i);
            // init.d:336 — dereferenced unconditionally by D -> `!` (08 §3).
            cdi.initializer = syntaxCopy(vdi.initializer!);
            if (vdi.designatorList !== null) { // nullable pointer truthiness (06 §2.7)
                // `new Designators()` — the container is constructed AS its alias (08 §3).
                cdi.designatorList = new DArray<Designator>();
                cdi.designatorList.setDim(vdi.designatorList.length);
                // Bound captured once at loop entry (06 §1.3) — and here the hoist is what makes the
                // `cdi === vdi` aliasing readable: the two statements just above REPLACED the very
                // container this bound reads, so D's loop-entry evaluation yields the length of the
                // FRESH (empty) `Designators`, i.e. 0 iterations. Faithful, not an optimisation.
                const nDesig = vdi.designatorList.length;
                for (let j = 0; j < nDesig; j++) {
                    // init.d:343-344 — `&(*cdi.designatorList)[j]` / `&(*vdi.designatorList)[j]`:
                    // the `*` deref of the `Designators*` vanishes (02 §10), `&elem` is the element
                    // object (03 §7.2). Unreachable in D and here alike: `nDesig` is 0 (the fresh
                    // `Designators` above), and the enclosing element's own read already faulted.
                    const cdid = cdi.designatorList.opIndex(j);
                    const vdid = vdi.designatorList.opIndex(j);
                    cdid.exp = vdid.exp !== null ? vdid.exp.syntaxCopy() : null;
                    cdid.ident = vdid.ident; // Identifier: shared reference
                }
            }
        }
        return ci;
    };

    // init.d:353 — `mixin VisitInitializer!Initializer visit;` + init.d:354 `return
    // visit.VisitInitializer(inx);`.
    // resolved: mixin VisitInitializer!Initializer + visitCase -> inlined dispatch switch
    // (07 §6.2, 13 §7.6 rule 1: the generated switch is emitted INLINE at the call site, in FULL,
    // never behind a named wrapper). With `Result = Initializer` (a class), each generated case is
    //     auto ix = init.isXInitializer();
    //     Result r = visitX(ix); if (r !is Result.init) return r;
    // and `Result.init` is `null` (09 §1.0); the trailing `static if (is(Result == void))` of
    // init.d:383 resolves to its ELSE branch, i.e. `return Result.init;` -> `return null;`.
    // `final switch` -> switch + throwing `default` + the `never` exhaustiveness check (06 §3.2).
    // `ix!`: on each arm the tag test inside `isXInitializer()` has already matched, so the `!`
    // marks the same non-null guarantee D's `auto ix` carries.
    switch (inx.kind) {
        case InitKind.void_: {
            const ix = inx.isVoidInitializer();
            const r = visitVoid(ix!);
            if (r !== null) return r;
            break;
        }
        case InitKind.default_: {
            const ix = inx.isDefaultInitializer();
            const r = visitDefault(ix!);
            if (r !== null) return r;
            break;
        }
        case InitKind.error: {
            const ix = inx.isErrorInitializer();
            const r = visitError(ix!);
            if (r !== null) return r;
            break;
        }
        case InitKind.struct_: {
            const ix = inx.isStructInitializer();
            const r = visitStruct(ix!);
            if (r !== null) return r;
            break;
        }
        case InitKind.array: {
            const ix = inx.isArrayInitializer();
            const r = visitArray(ix!);
            if (r !== null) return r;
            break;
        }
        case InitKind.exp: {
            const ix = inx.isExpInitializer();
            const r = visitExp(ix!);
            if (r !== null) return r;
            break;
        }
        case InitKind.C_: {
            const ix = inx.isCInitializer();
            const r = visitC(ix!);
            if (r !== null) return r;
            break;
        }
        default: {
            // final switch: D throws SwitchError on an unhandled value
            const _exhaustive: never = inx.kind;
            void _exhaustive;
            throw new SwitchError();
        }
    }
    return null; // init.d:384 — `return Result.init;` with Result = Initializer (a class) -> null
}

// dropped (07 §6.2 / 07 §5): init.d:369 `mixin template VisitInitializer(Result)` and init.d:394
// `string visitCase(string handler) pure @safe`. Both are COMPILE-TIME code generators: the mixin
// template emits a `final switch (init.kind)` dispatcher per instantiation, and `visitCase` is a
// `__ctfe`-only string builder (its runtime tail is `assert(0)`) consumed exclusively by that
// template. Neither produces a runtime symbol, so neither is emitted — each instantiation resolves
// at its own site with its own `Result`. Emitting a `mixin`/`static if` token into TS would itself
// be a bug (07 §11).
//
// Because the generator is dropped, THIS COMMENT is the hand-off: the full instantiation set,
// from a tree-wide grep of `VisitInitializer` over ldc-1.43.0-beta1/dmd (frontend.h's `using`
// alias excluded — it is C++ glue, not an instantiation). Each site expands the switch INLINE in
// its own enclosing function (13 §7.6 rule 1), never behind a shared named wrapper:
//
//   D site           | Result       | enclosing D function          | TS home
//   init.d:353       | Initializer  | syntaxCopy (init.d:278)       | `syntaxCopy` above
//   initsem.d:1207   | Initializer  | initializerSemantic (:105)    | src/dmd/initsem.ts
//   initsem.d:1356   | Initializer  | inferType (:1221)             | src/dmd/initsem.ts
//   initsem.d:1589   | Expression   | initializerToExpression(:1370)| src/dmd/initsem.ts
//   hdrgen.d:4309    | void         | initializerToBuffer (:4220)   | src/dmd/hdrgen.ts
//
// Two of those rows are the ones the `static if (is(Result == void))` at init.d:383 exists for, so
// they cannot be expanded by copying this file's arms: hdrgen.d:4309 is the ONLY `!void`
// instantiation, taking the TRUE branch — no `Result r = …` capture, no early-exit test, and no
// trailing `return Result.init;` at all (`visit<X>(ix);` bare, then fall out). initsem.d:1589 is
// the only `!Expression` one, so its `Result.init` is a null EXPRESSION, not a null Initializer,
// and its fall-through is `return null` typed as `Expression | null`.
