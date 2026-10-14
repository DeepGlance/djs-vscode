/**
 * Defines a `Dsymbol` representing an aggregate, which is a `struct`, `union` or `class`.
 *
 * Ported 1:1 from dmd/aggregate.d (module dmd.aggregate), LDC 1.43.0-beta1 / DMD 2.113.
 *
 * Specification: https://dlang.org/spec/struct.html, https://dlang.org/spec/class.html
 */

// dmd/aggregate.d:17 — `import core.stdc.stdio;`. Its only use in this module is the `printf` block
// under `static if (0)` in `placeField` (aggregate.d:277-286), which resolves to nothing (07 §3) —
// so the import has no live consumer and is dropped.
// dmd/aggregate.d:18 — `import core.checkedint;`. druntime, not a project module: reproduced as the
// local `addu` shim below (08 "core.* → runtime shim").
import { assert, SwitchError } from "../assert.js";
import { ds, type DString } from "../dstring.js";
import { Array as Array_ } from "./root/array.js";
import { CPPMANGLE, STC, Sizeok } from "./astenums.js";
import { ScopeDsymbol, Visibility } from "./dsymbol.js";
import { error } from "./errors.js";
import type { AliasThis } from "./aliasthis.js";
import type { DtorDeclarations, FuncDeclarations, VarDeclarations } from "./arraytypes.js";
import type { structalign_t } from "./astenums.js";
import type { VarDeclaration } from "./declaration.js";
import type { Scope } from "./dscope.js";
import type { Dsymbol } from "./dsymbol.js";
import type { Expression } from "./expression.js";
// CtorDeclaration/DtorDeclaration live in func.d (func.d:938/:995), not declaration.d.
import type { CtorDeclaration, DtorDeclaration, FuncDeclaration } from "./func.js";
import type { Identifier } from "./identifier.js";
import type { Loc } from "./location.js";
import type { Type } from "./mtype.js";
import type { Visitor } from "./visitor/index.js";

/**
 * `core.checkedint`'s `uint addu(uint x, uint y, ref bool overflow)` (druntime
 * `core/checkedint.d:209`): a 32-bit wrapping add that **sets** `overflow` on carry and never
 * clears it, so a chain of calls accumulates into one flag. `ref bool` → a `{ value }` box
 * (03 §3.2/§7.2). Local to this module: it is the only `core.checkedint` use here.
 *
 * resolved: `version (LDC) { if (!__ctfe) { … llvm_uadd_with_overflow … return res.result; } }`
 * (checkedint.d:211-218) — `LDC` is ON (_config.md §1) and `placeField` runs at compiler runtime,
 * so the LIVE branch is the intrinsic one and it RETURNS before the generic fallback
 * (checkedint.d:220-225). The intrinsic's contract is exactly "wrapping 32-bit sum + carry-out",
 * reproduced here (for an unsigned add, carry holds exactly when `r < x`). The fallback's
 * `assert(o == (r < y))`
 * sits on a path LDC does not take at runtime, so it is NOT emitted: it would be an exit path D
 * does not have (11 §2.5).
 */
function addu(x: number, y: number, overflow: { value: boolean }): number {
    const r = (x + y) >>> 0;                    // druntime: `res.result` — the wrapping sum
    overflow.value = overflow.value || r < x;   // druntime: `overflow |= res.overflow;` (sticky)
    return r;
}

/**
 * The ClassKind enum is used in AggregateDeclaration AST nodes to
 * specify the linkage type of the struct/class/interface or if it
 * is an anonymous class. If the class is anonymous it is also
 * considered to be a D class.
 *
 * dmd/aggregate.d:40 — `enum ClassKind : ubyte` (≤32-bit base → TS numeric enum, 02 §4.2).
 */
export enum ClassKind {
    /// the aggregate is a d(efault) class
    d,
    /// the aggregate is a C++ struct/class/interface
    cpp,
    /// the aggregate is an Objective-C class/interface
    objc,
    /// the aggregate is a C struct
    c,
}

/**
 * Give a nice string for a class kind for error messages.
 *
 * dmd/aggregate.d:59 — `const(char)* ClassKindToChars(ClassKind c)`. The result is consumed as a
 * `%s` argument of `error()` (dsymbolsem.d:5545), so the return domain is `DString`, not a JS
 * string (02 §1.3, 08 §11).
 *
 * Params:
 *     c = class kind
 * Returns:
 *     0-terminated string for `c`
 */
export function ClassKindToChars(c: ClassKind): DString {
    // dmd/aggregate.d:61 — `final switch (c)`: exhaustive + SwitchError default (06 §3.2).
    switch (c) {
        case ClassKind.d:
            return ds("D");
        case ClassKind.cpp:
            return ds("C++");
        case ClassKind.objc:
            return ds("Objective-C");
        case ClassKind.c:
            return ds("C");
        default: {
            // final switch: D throws SwitchError on an unhandled value
            const _exhaustive: never = c; void _exhaustive;   // static exhaustiveness check
            throw new SwitchError();
        }
    }
}

/**
 * If an aggregate has a pargma(mangle, ...) this holds the information
 * to mangle.
 *
 * dmd/aggregate.d:78 — `struct MangleOverride` (VALUE type, 02 §2 / 03). Plain copyability:
 * field-wise `.copy()` (03 §2), both fields being class references that are SHARED on copy.
 */
export class MangleOverride {
    agg: Dsymbol | null = null;   // The symbol to copy template parameters from (if any)
    id: Identifier | null = null; // the name to override the aggregate's with, defaults to agg.ident

    /// Value-struct copy (03 §2): both fields are class refs → shared, not cloned.
    copy(): MangleOverride {
        const c = new MangleOverride();
        c.agg = this.agg;
        c.id = this.id;
        return c;
    }
}

/***********************************************************
 * Abstract aggregate as a common ancestor for Class- and StructDeclaration.
 *
 * dmd/aggregate.d:87 — `extern (C++) abstract class AggregateDeclaration : ScopeDsymbol`.
 * `extern (C++)` erased (04 §8).
 */
export abstract class AggregateDeclaration extends ScopeDsymbol {
    type: Type | null = null;                    ///
    storage_class: STC = STC.none;               ///
    structsize = 0;                              /// size of struct
    alignsize = 0;                               /// size of struct for alignment purposes
    /// VarDeclaration fields including flattened AnonDeclaration members
    // dmd/aggregate.d:93 — `VarDeclarations fields;`. An `Array!VarDeclaration` VALUE struct that D
    // default-initializes empty; constructed empty here, AS the alias's element type (08 §3).
    fields: VarDeclarations = new Array_<VarDeclaration | null>();
    // dmd/aggregate.d:94 — `Dsymbol deferred;`. D redeclares `Dsymbol.deferred` (bool, dsymbol.d:396)
    // at a different type, and BOTH slots are live on aggregate objects: the bool is the
    // `Module.deferred` queue flag (dsymbolsem.d:730-732 set, :789 clear, reached with `tc.sym`, a
    // ClassDeclaration), this slot the template instance to run semantic2/3 on (templatesem.d:1349,
    // read at dsymbolsem.d:4944-4951 and :5847-5868). D picks the slot by the reference's static type.
    // shadow-split: D redeclares Dsymbol.deferred; this is the DERIVED slot (02 §11.5b registry)
    deferredTI: Dsymbol | null = null;           /// any deferred semantic2() or semantic3() symbol

    /// specifies whether this is a D, C++, Objective-C or anonymous struct/class/interface
    // `.init` of a named enum is its FIRST member (09 §1.0), not a bare 0 cast.
    classKind: ClassKind = ClassKind.d;
    /// Specify whether to mangle the aggregate as a `class` or a `struct`
    /// This information is used by the MSVC mangler
    /// Only valid for class and struct. TODO: Merge with ClassKind ?
    cppmangle: CPPMANGLE = CPPMANGLE.def;

    /// overridden symbol with pragma(mangle, "...") if not null
    // `MangleOverride*` — a pointer to a VALUE struct → the struct as a reference, never copied
    // (02 §10 case 2, 03 §7).
    pMangleOverride: MangleOverride | null = null;

    /**
     * !=null if is nested
     * pointing to the dsymbol that directly enclosing it.
     * 1. The function that enclosing it (nested struct and class)
     * 2. The class that enclosing it (nested class only)
     * 3. If enclosing aggregate is template, its enclosing dsymbol.
     *
     * See AggregateDeclaraton::makeNested for the details.
     */
    enclosing: Dsymbol | null = null;

    vthis: VarDeclaration | null = null;   /// 'this' parameter if this aggregate is nested
    vthis2: VarDeclaration | null = null;  /// 'this' parameter if this aggregate is a template and is nested

    // Special member functions
    invs: FuncDeclarations = new Array_<FuncDeclaration | null>();  /// Array of invariants
    inv: FuncDeclaration | null = null;    /// Merged invariant calling all members of invs

    /// CtorDeclaration or TemplateDeclaration
    ctor: Dsymbol | null = null;

    /// default constructor - should have no arguments, because
    /// it would be stored in TypeInfo_Class.defaultConstructor
    defaultCtor: CtorDeclaration | null = null;

    aliasthis: AliasThis | null = null;    /// forward unresolved lookups to aliasthis

    /// user-defined destructors (`~this()`) - mixins can yield multiple ones
    userDtors: DtorDeclarations = new Array_<DtorDeclaration | null>();
    /// aggregate destructor calling userDtors and fieldDtor (and base class aggregate dtor for C++ classes)
    aggrDtor: DtorDeclaration | null = null;
    /// the aggregate destructor exposed as `__xdtor` alias
    /// (same as aggrDtor, except for C++ classes with virtual dtor on Windows)
    dtor: DtorDeclaration | null = null;
    tidtor: DtorDeclaration | null = null;     /// aggregate destructor used in TypeInfo (must have extern(D) ABI)
    fieldDtor: DtorDeclaration | null = null;  /// function destructing (non-inherited) fields

    getRTInfo: Expression | null = null;   /// pointer to GC info generated by object.RTInfo(this)
    // `Scope*` — pointer to a VALUE struct → the reference itself (02 §10 case 2).
    rtInfoScope: Scope | null = null;      /// scope to be used when evaluating getRTInfo

    ///
    // dmd/aggregate.d:144 — `Visibility visibility;` default-initializes to `Visibility.init`:
    // `kind` takes its enum's FIRST member (`undefined`) and `pkg` is null (09 §1.0). That is the
    // DEFAULT-INIT birth of the 03 §6.4 dual-birth ctor, spelled `new Visibility()` — the
    // zero-argument branch dsymbol.ts:329-342 names this very D line as its example. (The
    // constructor overwrites it; the field initializer still has to reproduce `.init` faithfully.)
    visibility: Visibility = new Visibility();
    noDefaultCtor = false;             /// no default construction
    disableNew = false;                /// disallow allocations using `new`
    sizeok: Sizeok = Sizeok.none;      /// set when structsize contains valid data

    // dmd/aggregate.d:149 — `final extern (D) this(Loc loc, Identifier id)`. `final`/`extern (D)`
    // erased (04 §8). `Loc` is passed by value in D; it is an ALIAS-SAFE REGISTER type, so the
    // share needs no per-site copy comment (03 §9.1).
    constructor(loc: Loc, id: Identifier | null) {
        super(loc, id);
        // dmd/aggregate.d:152 — `visibility = Visibility(Visibility.Kind.public_);` — fresh value
        // construction, not a copy point (03 §1).
        this.visibility = new Visibility(Visibility.Kind.public_);
    }

    /***************************************
     * Returns:
     *      The total number of fields minus the number of hidden fields.
     */
    nonHiddenFields(): number {
        // dmd/aggregate.d:161 — `fields.length - isNested() - (vthis2 !is null)`. Both D `bool`
        // operands implicitly convert to 0/1 inside the `size_t` arithmetic; made explicit here
        // (number domain, 09 §1.1 — an index/length role, so `size_t` → `number`).
        //
        // Domain note: D's `size_t` WRAPS, so an underflow there would read 2^64-1, while `number`
        // goes negative — the two differ in sign, and both consumers use the result as a bound
        // (`i >= sd.nonHiddenFields()`, expressionsem.d:908/:1750). The subtraction never underflows
        // in practice: `fields` INCLUDES the hidden members (aggregate.d:93). `makeNested` creates
        // `vthis`/`vthis2` as `STC.field` VarDeclarations alongside `enclosing`/`vthis2` and pushes
        // them into `fields` on the forward-ref path (dsymbolsem.d:365, :411) or into `members`, from
        // where the ordinary field collection takes them (dsymbolsem.d:7293) — so each subtrahend has
        // its own entry in `fields` by the time a caller asks. No guard is added: D has none, and
        // inventing one would not be a faithful port.
        return this.fields.length - (this.isNested() ? 1 : 0) - (this.vthis2 !== null ? 1 : 0);
    }

    // is aggregate deprecated?
    override isDeprecated(): boolean {
        // dmd/aggregate.d:167 — `!!(this.storage_class & STC.deprecated_)`; STC is a branded
        // bigint, so the truthiness is spelled `!== 0n` (09 §9).
        return (this.storage_class & STC.deprecated_) !== 0n;
    }

    /// Flag this aggregate as deprecated
    setDeprecated(): void {
        // dmd/aggregate.d:173 — `this.storage_class |= STC.deprecated_;`
        this.storage_class = (this.storage_class | STC.deprecated_) as STC; // branded STC: re-cast after |
    }

    /****************************************
     * Returns true if there's an extra member which is the 'this'
     * pointer to the enclosing context (enclosing aggregate or function)
     */
    isNested(): boolean {
        // dmd/aggregate.d:182 — `return enclosing !is null;` (06 §2.7).
        return this.enclosing !== null;
    }

    override isExport(): boolean {
        // dmd/aggregate.d:187 — `return visibility.kind == Visibility.Kind.export_;`. `kind` is a
        // plain numeric enum value → `===` (no opEquals involved).
        return this.visibility.kind === Visibility.Kind.export_;
    }

    override visible(): Visibility {
        // dmd/aggregate.d:192 — `return visibility;` returns the value struct BY VALUE, so D hands
        // the caller a copy (03 §1 #3). No elision: `Visibility` is not an alias-safe register type
        // and callers of `visible()` are outside this file.
        return this.visibility.copy();
    }

    // 'this' type
    handleType(): Type | null {
        // dmd/aggregate.d:198 — `return type;` (class reference, no copy).
        return this.type;
    }

    // Does this class have an invariant function?
    hasInvariant(): boolean {
        // dmd/aggregate.d:204 — `return invs.length != 0;`
        return this.invs.length !== 0;
    }

    // resolved: `version (IN_LLVM) {} else { void* sinit; }` (aggregate.d:207-211) — IN_LLVM is ON
    // (_config.md §1), so the taken branch is the EMPTY one: the back-end initializer-symbol field
    // `sinit` does not exist in this port.

    override accept(v: Visitor): void {
        // dmd/aggregate.d:215 — `v.visit(this)` dispatches on this node's OWN class (13 §2).
        v.visitAggregateDeclaration(this);
    }
}

/****************************
 * Do byte or word alignment as necessary.
 * Align sizes of 0, as we may not know array sizes yet.
 *
 * dmd/aggregate.d:229 — `public uint alignmember(structalign_t alignment, uint memalignsize,
 * uint offset)`. `alignment` is a BY-VALUE struct parameter: the copy is emitted at every CALL
 * SITE, never inside the callee (03 §3.1).
 *
 * Params:
 *   alignment = struct alignment that is in effect
 *   memalignsize = natural alignment of field
 *   offset = offset to be aligned
 * Returns:
 *   aligned offset
 */
export function alignmember(alignment: structalign_t, memalignsize: number, offset: number): number {
    // dmd/aggregate.d:231 — the `//debug printf(...)` trace is a comment in the source; not ported.
    let alignvalue: number;

    if (alignment.isDefault()) {
        // Alignment in Target::fieldalignsize must match what the
        // corresponding C compiler's default alignment behavior is.
        alignvalue = memalignsize;
    } else if (alignment.isPack()) {    // #pragma pack semantics
        alignvalue = alignment.get();
        if (memalignsize < alignvalue)
            alignvalue = memalignsize;      // align to min(memalignsize, alignment)
    } else if (alignment.get() > 1) {
        // Align on alignment boundary, which must be a positive power of 2
        alignvalue = alignment.get();
    } else
        return offset;

    // dmd/aggregate.d:254 — `assert(alignvalue && !(alignvalue & (alignvalue - 1)));`. Numeric
    // truthiness feeding `&&`/`!` is expanded (09 §9).
    assert(alignvalue !== 0 && (alignvalue & (alignvalue - 1)) === 0); // non-zero and power of 2
    // dmd/aggregate.d:255 — uint arithmetic: `&` yields an int32 in JS, so the uint result is
    // re-truncated with `>>> 0` (09 §4.1).
    return ((offset + alignvalue - 1) & ~(alignvalue - 1)) >>> 0;
}

/****************************************
 * Place a field (mem) into an aggregate (agg), which can be a struct, union or class
 *
 * dmd/aggregate.d:274 — `public uint placeField(Loc loc, ref uint nextoffset, uint memsize,
 * uint memalignsize, structalign_t alignment, ref uint aggsize, ref uint aggalignsize,
 * bool isunion)`. The three `ref uint` parameters become `{ value }` boxes (03 §3.2/§7.2);
 * `alignment` is by-value, so CALLERS emit `.copy()` (03 §3.1).
 *
 * Params:
 *    loc           = source location for error messages
 *    nextoffset    = location just past the end of the previous field in the aggregate.
 *                    Updated to be just past the end of this field to be placed, i.e. the future nextoffset
 *    memsize       = size of field
 *    memalignsize  = natural alignment of field
 *    alignment     = alignment in effect for this field
 *    aggsize       = size of aggregate (updated)
 *    aggalignsize  = alignment of aggregate (updated)
 *    isunion       = the aggregate is a union
 * Returns:
 *    aligned offset to place field at
 */
export function placeField(
    loc: Loc,
    nextoffset: { value: number },
    memsize: number,
    memalignsize: number,
    alignment: structalign_t,
    aggsize: { value: number },
    aggalignsize: { value: number },
    isunion: boolean,
): number {
    // resolved: `static if (0) { printf(...) x7 }` (aggregate.d:277-286) — the condition is a
    // compile-time `0`, so NOTHING is emitted (07 §3).

    let ofs = nextoffset.value;                 // dmd/aggregate.d:288

    // dmd/aggregate.d:290-292 — `&&` binds tighter than `||`; parenthesized here to keep the D
    // grouping visible.
    const actualAlignment =
        alignment.isDefault() || (alignment.isPack() && memalignsize < alignment.get())
                    ? memalignsize : alignment.get();

    // Ensure no overflow for (memsize + actualAlignment + ofs)
    const overflow = { value: false };           // dmd/aggregate.d:295 — `bool overflow;`
    const sz = addu(memsize, actualAlignment, overflow);   // dmd/aggregate.d:296
    addu(ofs, sz, overflow);                     // dmd/aggregate.d:297 — result discarded, flag kept
    if (overflow.value) {
        // dmd/aggregate.d:300-302 — `uint.max` folds to the literal 0xffffffff (09).
        error(loc, ds("max object size %u exceeded from adding field size %u + alignment adjustment %u + field offset %u when placing field in aggregate"),
                0xffffffff, memsize, actualAlignment, ofs);
        return 0;
    }

    // Skip no-op for noreturn without custom aligment
    if (memalignsize !== 0 || !alignment.isDefault())
        // dmd/aggregate.d:307 — `alignment` is a by-value struct param → the copy is emitted at the
        // CALL SITE (03 §3.1).
        ofs = alignmember(alignment.copy(), memalignsize, ofs);

    const memoffset = ofs;                       // dmd/aggregate.d:309
    ofs = (ofs + memsize) >>> 0;                 // dmd/aggregate.d:310 — `ofs += memsize;` (uint, 09 §3)
    if (ofs > aggsize.value)
        aggsize.value = ofs;
    if (!isunion) {
        nextoffset.value = ofs;
        // dmd/aggregate.d:316 — `//printf("     revised nextoffset:   %u\n", ofs);` is a comment.
    }

    if (aggalignsize.value < actualAlignment)
        aggalignsize.value = actualAlignment;

    return memoffset;
}
