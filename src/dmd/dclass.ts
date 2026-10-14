// Ported from dmd/dclass.d (module dmd.dclass) — "Defines a `class` declaration."
//
// Faithful structural 1:1 translation of the WHOLE D module (dclass.d, 540 lines): the
// `BaseClass` value struct, the `ClassFlags` enum, `ClassDeclaration`, `InterfaceDeclaration`
// and the module-private `baseClassImplementsInterface`.
//
// Module-wide translation notes (each is re-stated at its site):
//   * `BaseClass` is a D **struct** (dclass.d:36) reached through pointers everywhere it is
//     stored: `BaseClasses = Array!(BaseClass*)` -> `Array<BaseClass | null>` and
//     `BaseClass*[] interfaces` -> `(BaseClass | null)[]` (08 §3, 02 §10). A `BaseClass*` is
//     the TS object reference itself — never a `.copy()` (03 §7.2).
//   * `mem.xcalloc` / `memcpy` (dclass.d:61,:70) are erased/rewritten per 03 §8 and 03 §1.1
//     (in-place value overwrite: fields are copied INTO the existing element object so the
//     `&baseInterfaces[i]` aliases D takes keep observing it).
//   * resolved: `version (IN_LLVM) { /* not needed */ } else { Dsymbol vtblsym; }`
//     (dclass.d:386-390) — IN_LLVM is ON (_config.md §1), so the back-end field `vtblsym`
//     in the `else` branch is DROPPED (07 §1).
//   * dclass.d has ZERO `unittest` blocks; dclass.test.ts takes the 10 §1.6b shape.

import { AggregateDeclaration, ClassKind } from "./aggregate.js";
import { Baseok, Sizeok, ThreeState, STC } from "./astenums.js";
import { DSYM, PASS } from "./dsymbol.js";
import { error } from "./errors.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { Type, TypeClass } from "./mtype.js";
// `objc()` is read only inside method bodies; it is non-null there because the driver runs `Objc._init()`
// at startup (main.d:445), hence `objc()!`.
import { ObjcClassDeclaration, objc } from "./objc.js";
import { Array as DArray } from "./root/array.js";
import { assert } from "../assert.js";
import { ds } from "../dstring.js";
import type { DString } from "../dstring.js";
import type { BaseClasses, Dsymbols, FuncDeclarations } from "./arraytypes.js";
// TypeInfoClassDeclaration lives in declaration.d (declaration.d:862), not mtype.d.
import type { TypeInfoClassDeclaration } from "./declaration.js";
import type { Dsymbol } from "./dsymbol.js";
import type { FuncDeclaration } from "./func.js";
import type { Loc } from "./location.js";
import type { Visitor } from "./visitor/index.js";

/**
 * The canonical one-slot box for a D pointer-to-primitive out-parameter (`int* poffset`),
 * 03 §7.2. File-local, as in dcast.ts / optimize.ts / typesem.ts.
 */
interface Ref<T> {
    value: T;
}

/***********************************************************
 * dmd/dclass.d:36 — `extern (C++) struct BaseClass` (a VALUE type: 02 §2, 03).
 *
 * Ownership/aliasing contract: every `BaseClasses`/`interfaces` slot holds a POINTER to a
 * `BaseClass` (dclass.d:117,:121), so the port stores the object reference and never copies
 * it at those sites (02 §10 rule 2). `copy()` below is the 03 §2 value-copy helper, used only
 * where D genuinely copies the struct by value.
 */
export class BaseClass {
    /// (before semantic processing)
    type: Type | null = null;

    sym: ClassDeclaration | null = null;
    /// 'this' pointer offset
    offset = 0;

    /// for interfaces: Array of FuncDeclaration's making up the vtbl[].
    /// An INLINE `Array!FuncDeclaration` value member (not a pointer) — constructed empty by
    /// the constructor, exactly as D default-initializes an inline `Array!T` (08 §2.0).
    vtbl!: FuncDeclarations;

    /// if BaseClass is an interface, these are a copy of the InterfaceDeclaration.interfaces.
    /// D `BaseClass[]` is a slice of BaseClass VALUES — value elements take no `| null`
    /// (08 §3). D's `.init` is the NULL slice; the port uses the empty array because the
    /// null-vs-empty distinction (06 §2.8) is not observable for THIS field: every read in
    /// the 1.43 tree is `.length` or an index (dclass.d:64,:518; dsymbolsem.d:10117;
    /// templatesem.d:7877) and D's `null.length` is 0 — there is no truthiness test on it.
    baseInterfaces: BaseClass[] = [];

    /**
     * dmd/dclass.d:50 — `extern (D) this(Type type)`.
     *
     * ONE constructor with two births (03 §6.4): the no-argument path reproduces D's default
     * initialization (`BaseClass` cells produced by `mem.xcalloc` in `copyBaseInterfaces`,
     * dclass.d:61) — every field keeps its declared `.init` (09 §1.0); the value path mirrors
     * `this(type)`.
     */
    constructor(type?: Type) {
        //printf("BaseClass(this = %p, '%s')\n", this, type.toChars());
        this.vtbl = new DArray<FuncDeclaration | null>(); // inline Array!T member: born empty
        if (arguments.length !== 0) {
            this.type = type!;
        }
    }

    /**
     * dmd/dclass.d:56 — `extern (D) void copyBaseInterfaces(BaseClasses* vtblInterfaces)`.
     *
     * Preconditions: `sym` is set (D dereferences it unconditionally at :61); every
     * `sym.interfaces[i]` has an empty vtbl (asserted at :69, as in D).
     * Postconditions: `baseInterfaces` holds one freshly-allocated `BaseClass` per interface of
     * `sym`, each overwritten in place from `sym.interfaces[i]`; every non-first one is pushed
     * onto `vtblInterfaces`; the walk recurses depth-first.
     * `BaseClasses* vtblInterfaces` -> the container reference (02 §10 rule 1); the body only
     * pushes to it, so it is non-null.
     */
    copyBaseInterfaces(vtblInterfaces: BaseClasses): void {
        //printf("+copyBaseInterfaces(), %s\n", sym.toChars());
        //    if (baseInterfaces.length)
        //      return;
        // `sym.interfaces` is a slice whose `.init` is null; a null slice has length 0 and
        // iterates zero times in D (09 §1.0, 06 §2.8) — `?? []` reproduces exactly that.
        const symInterfaces = this.sym!.interfaces ?? [];
        // erased: `cast(BaseClass*)mem.xcalloc(sym.interfaces.length, BaseClass.sizeof)` ->
        // JS GC (03 §8). xcalloc zeroes the cells, i.e. default-constructs each BaseClass;
        // `bc[0 .. n]` is then simply that array of fresh elements.
        const bc: BaseClass[] = [];
        for (let i = 0; i < symInterfaces.length; i++)
            bc.push(new BaseClass());
        this.baseInterfaces = bc;
        //printf("%s.copyBaseInterfaces()\n", sym.toChars());
        for (let i = 0; i < this.baseInterfaces.length; i++) {
            // `&baseInterfaces[i]` — address-of a value element IS the element object (03 §7.2).
            const b = this.baseInterfaces[i];
            // `sym.interfaces[i]` is a `BaseClass*` slot (08 §3); D dereferences it at :69
            // without a null test, so the read is `!` — the port faults exactly where D does.
            const b2 = symInterfaces[i]!;

            assert(b2.vtbl.length === 0); // should not be filled yet
            // `memcpy(b, b2, BaseClass.sizeof)` — an IN-PLACE value overwrite (03 §1.1): the
            // fields are copied INTO `b`, never `b = b2.copy()`, because `b` is the element
            // object that `baseInterfaces[i]` (and the pushes below) alias.
            b.type = b2.type;                     // class reference: share (03 §2)
            b.sym = b2.sym;                       // class reference: share
            b.offset = b2.offset;                 // primitive: value copy
            // `vtbl` is an inline `Array!T` VALUE member: D's memcpy duplicates the array
            // HEADER, leaving the two structs independent (a later push to one does not move
            // the other's length). `Array.copy()` is that fresh shallow header (08 §2.3);
            // sharing the container object instead would alias the length.
            b.vtbl = b2.vtbl.copy();
            b.baseInterfaces = b2.baseInterfaces; // slice: share the backing store (03 §2)

            if (i !== 0) // single inheritance is i==0
                vtblInterfaces.push(b); // only need for M.I.
            b.copyBaseInterfaces(vtblInterfaces);
        }
        //printf("-copyBaseInterfaces\n");
    }

    /// 03 §2 value-copy helper for the D struct `BaseClass`.
    copy(): BaseClass {
        const c = new BaseClass();
        c.type = this.type;                     // class reference: share (03 §2)
        c.sym = this.sym;                       // class reference: share
        c.offset = this.offset;                 // primitive: value copy
        c.vtbl = this.vtbl.copy();              // inline Array!T value member: fresh header (08 §2.3)
        c.baseInterfaces = this.baseInterfaces; // slice: share the backing store (03 §2)
        return c;
    }
}

// These must match the values in druntime/src/object.d.
// dmd/dclass.d:81 — `enum ClassFlags : uint` (<=32-bit base -> TS numeric enum, 02 §4.2).
export enum ClassFlags {
    none          = 0x0,
    isCOMclass    = 0x1,
    noPointers    = 0x2,
    hasOffTi      = 0x4,
    hasCtor       = 0x8,
    hasGetMembers = 0x10,
    hasTypeInfo   = 0x20,
    isAbstract    = 0x40,
    isCPPclass    = 0x80,
    hasDtor       = 0x100,
    hasNameSig    = 0x200,
}

/***********************************************************
 * dmd/dclass.d:98 — `extern (C++) class ClassDeclaration : AggregateDeclaration`.
 */
// @ts-expect-error D static-method hiding (class static side, TS2417): ClassDeclaration.create hides Dsymbol.create.
export class ClassDeclaration extends AggregateDeclaration {
    // dmd/dclass.d:100 — `extern (C++) __gshared { … }`. Names found by reading object.d in
    // druntime. Process-wide mutable globals -> static fields, `.init` null (09 §1.0).
    static object: ClassDeclaration | null = null;
    static throwable: ClassDeclaration | null = null;
    static exception: ClassDeclaration | null = null;
    static errorException: ClassDeclaration | null = null;
    static cpp_type_info_ptr: ClassDeclaration | null = null;   // Object.__cpp_type_info_ptr

    baseClass: ClassDeclaration | null = null; // NULL only if this is Object
    staticCtor: FuncDeclaration | null = null;
    staticDtor: FuncDeclaration | null = null;
    /// Array of FuncDeclaration's making up the vtbl[]. Inline `Array!Dsymbol` value member.
    vtbl!: Dsymbols;
    /// More FuncDeclaration's that aren't in vtbl[]. Inline `Array!Dsymbol` value member.
    vtblFinal!: Dsymbols;

    /// Array of BaseClass's; first is super, rest are Interface's.
    /// `BaseClasses*` -> the container reference (02 §10 rule 1); the constructor always sets it.
    baseclasses!: BaseClasses;

    /// Slice of baseclasses[] that does not include baseClass.
    /// D `BaseClass*[]`: a slice (`.init` == null, 09 §1.0) of nullable pointer slots (08 §3).
    /// The null-vs-empty distinction is KEPT here (06 §2.8) because the tree observes it —
    /// traits.d:1306 tests `ifd.interfaces` for truthiness before iterating it.
    interfaces: (BaseClass | null)[] | null = null;

    /// array of base interfaces that have their own vtbl[]. `BaseClasses*` -> reference; nullable,
    /// `.init` null.
    /// gap: written only at dsymbolsem.d:5211-5216 (`ClassDeclaration` semantic, which allocates it
    /// and fills it via `copyBaseInterfaces`) and read at dsymbolsem.d:10108-10110, unported.
    vtblInterfaces: BaseClasses | null = null;

    /// the ClassInfo object for this ClassDeclaration
    vclassinfo: TypeInfoClassDeclaration | null = null;

    /// true if this is a COM class
    com = false;

    /// true if this is a scope class
    stack = false;

    /// if this is a C++ class, this is the slot reserved for the virtual destructor
    cppDtorVtblIndex = -1;

    /// to prevent recursive attempts
    inuse = false;

    isabstract: ThreeState = ThreeState.none;

    /// set the progress of base classes resolving
    baseok: Baseok = Baseok.none;

    /**
     * Data for a class declaration that is needed for the Objective-C integration.
     * An inline value struct (objc.d) — constructed by the constructor (dclass.d:154).
     */
    objc!: ObjcClassDeclaration;

    // resolved: `version (IN_LLVM) { /* not needed */ } else { Dsymbol vtblsym; }`
    // (dmd/dclass.d:386-390). IN_LLVM is ON (_config.md §1) -> the `else` back-end field
    // `vtblsym` is DROPPED (07 §1).

    /**
     * dmd/dclass.d:152 — `final extern (D) this(Loc loc, Identifier id, BaseClasses* baseclasses,
     * Dsymbols* members, bool inObject)`.
     *
     * NOTE on statement order: D runs `objc = ObjcClassDeclaration(this)` and the anonymous-id
     * generation BEFORE `super(loc, id)`; TS requires `super()` first. The id generation is
     * hoisted above `super` (so the generated id still reaches the base constructor, as in D)
     * and the `objc` construction moved just after it — observationally identical, since
     * nothing between the two reads `objc`.
     */
    constructor(
        loc: Loc,
        id: Identifier | null,
        baseclasses: BaseClasses | null,
        members: Dsymbols | null,
        inObject: boolean,
    ) {
        if (id === null)
            id = Identifier.generateAnonymousId(ds("class"));

        super(loc, id);
        this.objc = new ObjcClassDeclaration(this); // dclass.d:154 — inline value struct
        this.vtbl = new DArray<Dsymbol | null>();       // inline Array!T member: born empty
        this.vtblFinal = new DArray<Dsymbol | null>();  // inline Array!T member: born empty
        this.dsym = DSYM.classDeclaration;

        // dmd/dclass.d:162 — `static immutable msg = "…";`
        const msg = ds("only object.d can define this reserved class name");

        if (baseclasses !== null) {
            // Actually, this is a transfer (the container reference is taken, never copied)
            this.baseclasses = baseclasses;
        } else {
            // Constructed AS the alias's element type (08 §3): BaseClasses = Array<BaseClass | null>.
            this.baseclasses = new DArray<BaseClass | null>();
        }

        this.members = members;

        //printf("ClassDeclaration(%s), dim = %d\n", ident.toChars(), this.baseclasses.length);

        // For forward references
        this.type = new TypeClass(this);

        // Look for special class names. `Identifier` has no `opEquals`, so D's `==` on these
        // class references is reference identity -> `===` (05 §2 / cheatsheet).
        if (id === Id.__sizeof || id === Id.__xalignof || id === Id._mangleof)
            this.classError(ds("%s `%s` illegal class name"), null);

        // dmd/dclass.d:183 — nested `void check(Identifier _id, ref ClassDeclaration cd)`, a
        // nested function -> inner arrow (04 §5). Its `ref ClassDeclaration cd` aliases a
        // STATIC SLOT (`Type.dtypeinfo`, `ClassDeclaration.object`, …), not an object, and is
        // WRITE-ONLY (`cd = this;`), so the alias is carried by a setter closure — the box form
        // of 03 §7.2 for a slot that is not itself an object.
        const check = (_id: Identifier | null, setCd: (cd: ClassDeclaration) => void): void => {
            if (id === _id) {
                if (!inObject)
                    this.classError(ds("%s `%s` %s"), msg);
                setCd(this);
            }
        };
        // BUG: What if this is the wrong TypeInfo, i.e. it is nested?
        // `id.toChars()[0] == 'T'` — DString is a byte buffer (08 §11), so the char literal is
        // its byte value.
        if (id.toChars()[0] === /* 'T' */ 0x54) {
            check(Id.TypeInfo,                  (cd) => { Type.dtypeinfo = cd; });
            check(Id.TypeInfo_Class,            (cd) => { Type.typeinfoclass = cd; });
            check(Id.TypeInfo_Interface,        (cd) => { Type.typeinfointerface = cd; });
            check(Id.TypeInfo_Struct,           (cd) => { Type.typeinfostruct = cd; });
            check(Id.TypeInfo_Pointer,          (cd) => { Type.typeinfopointer = cd; });
            check(Id.TypeInfo_Array,            (cd) => { Type.typeinfoarray = cd; });
            check(Id.TypeInfo_StaticArray,      (cd) => { Type.typeinfostaticarray = cd; });
            check(Id.TypeInfo_AssociativeArray, (cd) => { Type.typeinfoassociativearray = cd; });
            check(Id.TypeInfo_Enum,             (cd) => { Type.typeinfoenum = cd; });
            check(Id.TypeInfo_Function,         (cd) => { Type.typeinfofunction = cd; });
            check(Id.TypeInfo_Delegate,         (cd) => { Type.typeinfodelegate = cd; });
            check(Id.TypeInfo_Tuple,            (cd) => { Type.typeinfotypelist = cd; });
            check(Id.TypeInfo_Const,            (cd) => { Type.typeinfoconst = cd; });
            check(Id.TypeInfo_Invariant,        (cd) => { Type.typeinfoinvariant = cd; });
            check(Id.TypeInfo_Shared,           (cd) => { Type.typeinfoshared = cd; });
            check(Id.TypeInfo_Wild,             (cd) => { Type.typeinfowild = cd; });
            check(Id.TypeInfo_Vector,           (cd) => { Type.typeinfovector = cd; });
        }
        check(Id.Object,            (cd) => { ClassDeclaration.object = cd; });
        check(Id.Throwable,         (cd) => { ClassDeclaration.throwable = cd; });
        check(Id.Exception,         (cd) => { ClassDeclaration.exception = cd; });
        check(Id.Error,             (cd) => { ClassDeclaration.errorException = cd; });
        check(Id.cpp_type_info_ptr, (cd) => { ClassDeclaration.cpp_type_info_ptr = cd; });

        this.baseok = Baseok.none;
    }

    /**
     * dmd/dclass.d:223 — `extern (D) final void classError(const(char)* fmt, const(char)* arg)`.
     * The leading `.` in `.error(...)` is the module-scope `error()` of dmd.errors (10 §3);
     * `kind` / `toPrettyChars` are D paren-less calls feeding the first two `%s`.
     */
    classError(fmt: DString, arg: DString | null): void {
        error(this.loc, fmt, this.kind(), this.toPrettyChars(), arg);
    }

    /// dmd/dclass.d:228 — `static ClassDeclaration create(…)`.
    static override create(
        loc: Loc,
        id: Identifier | null,
        baseclasses: BaseClasses | null,
        members: Dsymbols | null,
        inObject: boolean,
    ): ClassDeclaration {
        return new ClassDeclaration(loc, id, baseclasses, members, inObject);
    }

    /**
     * dmd/dclass.d:233 — `override const(char)* toPrettyChars(bool qualifyTypes = false)`.
     *
     * The `objc.isMeta` arm forwards to `.objc.toPrettyChars(this, qualifyTypes)` (dclass.d:236):
     * D's `.objc` is the module-level accessor `objc()` of dmd.objc, not the `this.objc` field.
     */
    override toPrettyChars(qualifyTypes = false): DString {
        if (this.objc.isMeta)
            return objc()!.toPrettyChars(this, qualifyTypes);

        return super.toPrettyChars(qualifyTypes);
    }

    override syntaxCopy(s: Dsymbol | null): ClassDeclaration {
        //printf("ClassDeclaration.syntaxCopy('%s')\n", toChars());
        // `cast(ClassDeclaration)s` -> the isXxx() downcast (05 §10); D would produce null on a
        // mismatch and then fault, so the `!` marks the same crash point.
        const cd: ClassDeclaration =
            s !== null ? s.isClassDeclaration()!
                       : new ClassDeclaration(this.loc, this.ident, null, null, false);

        cd.storage_class = (cd.storage_class | this.storage_class) as STC; // branded STC: re-cast after |

        cd.baseclasses.setDim(this.baseclasses.length);
        for (let i = 0; i < cd.baseclasses.length; i++) {
            // `(*this.baseclasses)[i]` — a `BaseClass*` slot (08 §3); dclass.d:253-254
            // dereferences both it and `b.type` with no null test, so the reads are `!`.
            const b = this.baseclasses.opIndex(i);
            const b2 = new BaseClass(b!.type!.syntaxCopy());
            cd.baseclasses.opIndexAssign(b2, i); // `(*cd.baseclasses)[i] = b2` (05 §7, value-first)
        }

        // `ScopeDsymbol.syntaxCopy(cd)` — the explicit non-virtual base call. AggregateDeclaration
        // declares no syntaxCopy, so `super.` IS ScopeDsymbol.syntaxCopy.
        super.syntaxCopy(cd);
        return cd;
    }

    /*********************************************
     * Determine if 'this' is a base class of cd.
     * This is used to detect circular inheritance only.
     *
     * dmd/dclass.d:266 — `extern (D) final bool isBaseOf2(ClassDeclaration cd)`.
     */
    isBaseOf2(cd: ClassDeclaration | null): boolean {
        if (cd === null)
            return false;
        //printf("ClassDeclaration.isBaseOf2(this = '%s', cd = '%s')\n", toChars(), cd.toChars());
        for (let i = 0; i < cd.baseclasses.length; i++) {
            // `BaseClass*` slot (08 §3); dclass.d:274 dereferences it unconditionally -> `!`.
            const b = cd.baseclasses.opIndex(i);
            // `b.sym == this` is class-reference identity (05 §2).
            if (b!.sym === this || this.isBaseOf2(b!.sym))
                return true;
        }
        return false;
    }

    // dmd/dclass.d:280 — `enum OFFSET_FWDREF`, a ClassDeclaration-scoped manifest enum.
    // Hoisted to a module const (02 §4.1) — see below the class.

    /*******************************************
     * Determine if 'this' is a base class of cd.
     *
     * dmd/dclass.d:285 — `bool isBaseOf(ClassDeclaration cd, int* poffset)`.
     * `int* poffset` -> the `Ref<number>` out-box (03 §7.2); null means "caller doesn't want it".
     * The parameter is `ClassDeclaration | null` because this body null-tests it (02 §10.1).
     */
    isBaseOf(cd: ClassDeclaration | null, poffset: Ref<number> | null): boolean {
        //printf("ClassDeclaration.isBaseOf(this = '%s', cd = '%s')\n", toChars(), cd.toChars());
        if (poffset !== null)
            poffset.value = 0;
        // D reassigns the parameter while walking the chain (`cd = cd.baseClass;`, dclass.d:297);
        // the port walks the sanctioned `cur` cursor instead (02 §10.1), so the argument stays
        // readable next to the walked node.
        let cur: ClassDeclaration | null = cd;
        while (cur !== null) {
            assert(cur.baseClass !== null || cur.semanticRun >= PASS.semanticdone ||
                   cur.isInterfaceDeclaration() !== null);
            if (this === cur.baseClass) // class-reference identity (05 §2)
                return true;

            cur = cur.baseClass;
        }
        return false;
    }

    /*********************************************
     * Determine if 'this' has complete base class information.
     * This is used to detect forward references in covariant overloads.
     *
     * dmd/dclass.d:305 — `final bool isBaseInfoComplete() const`.
     */
    isBaseInfoComplete(): boolean {
        return this.baseok >= Baseok.done;
    }

    /************************************
     * Search base classes in depth-first, left-to-right order for
     * a class or interface named 'ident'.
     * Stops at first found. Does not look for additional matches.
     * Params:
     *  ident = identifier to search for
     * Returns:
     *  ClassDeclaration if found, null if not
     *
     * dmd/dclass.d:319 — `extern (D) final ClassDeclaration searchBase(Identifier ident)`.
     */
    searchBase(ident: Identifier): ClassDeclaration | null {
        // `foreach (b; *baseclasses)` over the container VALUE -> for…of (06 §1.9, 08 §2.0b).
        for (const b of this.baseclasses) {
            // `BaseClass*` slot and `b.type` are both dereferenced with no null test at
            // dclass.d:324 -> `!` (the port faults exactly where D does).
            const cdb = b!.type!.isClassHandle();
            if (cdb === null) // https://issues.dlang.org/show_bug.cgi?id=10616
                return null;
            // `cdb.ident.equals(ident)` — `equals` IS a member of Identifier (identifier.d, over
            // RootObject.equals), not the UFCS free function of dmd.dsymbolsem (04 §6.1).
            // `ident` on Dsymbol is nullable; D dereferences it here -> `!`.
            if (cdb.ident!.equals(ident))
                return cdb;
            // `if (auto result = cdb.searchBase(ident))` — declaration in a condition, hoisted
            // and tested explicitly (06 §2.6 + §2.7).
            const result = cdb.searchBase(ident);
            if (result !== null)
                return result;
        }
        return null;
    }

    /**************
     * Returns: true if there's a __monitor field
     *
     * dmd/dclass.d:337 — `final bool hasMonitor()`.
     */
    hasMonitor(): boolean {
        return this.classKind === ClassKind.d;
    }

    /****************************************
     * dmd/dclass.d:344 — `final bool isCOMclass() const`.
     */
    isCOMclass(): boolean {
        return this.com;
    }

    /// dmd/dclass.d:349 — `bool isCOMinterface() const` (virtual; overridden by InterfaceDeclaration).
    isCOMinterface(): boolean {
        return false;
    }

    /// dmd/dclass.d:354 — `final bool isCPPclass() const`.
    isCPPclass(): boolean {
        return this.classKind === ClassKind.cpp;
    }

    /// dmd/dclass.d:359 — `bool isCPPinterface() const` (virtual; overridden by InterfaceDeclaration).
    isCPPinterface(): boolean {
        return false;
    }

    /****************************************
     * Determine if slot 0 of the vtbl[] is reserved for something else.
     * For class objects, yes, this is where the classinfo ptr goes.
     * For COM interfaces, no.
     * For non-COM interfaces, yes, this is where the Interface ptr goes.
     * Returns:
     *      0       vtbl[0] is first virtual function pointer
     *      1       vtbl[0] is classinfo/interfaceinfo pointer
     *
     * dmd/dclass.d:373 — `int vtblOffset() const`.
     */
    vtblOffset(): number {
        return this.classKind === ClassKind.cpp ? 0 : 1;
    }

    /****************************************
     * dmd/dclass.d:380 — `override const(char)* kind() const`.
     */
    override kind(): DString {
        return ds("class");
    }

    /// dmd/dclass.d:391 — `extern (D) final bool isErrorException()`.
    isErrorException(): boolean {
        // `errorException && (this == errorException || errorException.isBaseOf(this, null))`:
        // a nullable-reference truthiness test made explicit (06 §2.7), then class-reference
        // identity (05 §2).
        const errorException = ClassDeclaration.errorException;
        return errorException !== null &&
            (this === errorException || errorException.isBaseOf(this, null));
    }

    /// dmd/dclass.d:396 — `override void accept(Visitor v) { v.visit(this); }` (13 §2).
    override accept(v: Visitor): void {
        v.visitClassDeclaration(this);
    }
}

// dmd/dclass.d:280 — `enum OFFSET_FWDREF = 0x76543211;`, a manifest enum declared inside the
// ClassDeclaration body. Manifest enums become plain consts (02 §4.1); class-scoped ones are
// hoisted to module scope, as elsewhere in the port (expression.ts:977, the StringExp-scoped
// `NoPostfix`).
//
// Export surface follows 02 §4.1, which keys it to foreign reads: the default is a file-private
// module const, and the re-export is reserved for a value read from another module. `OFFSET_FWDREF`
// has no foreign reader — its only occurrences in the whole frontend are its declaration
// (dclass.d:280) and the single in-module use at dclass.d:449 — so it stays file-private.
//
// Its sibling `OFFSET_RUNTIME = 0x76543210` was DELETED upstream in 1.43.0 final along with the
// `isBaseOf` offset protocol that read it (expressionsem.d `lowerCastExp` now branches on
// `classKind` instead). It survives only in the C++ header aggregate.h:281, which we do not port.
/// D ClassDeclaration-scoped manifest enum
const OFFSET_FWDREF = 0x76543211;

/***********************************************************
 * dmd/dclass.d:404 — `extern (C++) final class InterfaceDeclaration : ClassDeclaration`.
 * `final` on a class is ERASED (04 §8).
 */
export class InterfaceDeclaration extends ClassDeclaration {
    /// dmd/dclass.d:406 — `extern (D) this(Loc loc, Identifier id, BaseClasses* baseclasses)`.
    constructor(loc: Loc, id: Identifier | null, baseclasses: BaseClasses | null) {
        super(loc, id, baseclasses, null, false);
        this.dsym = DSYM.interfaceDeclaration;
        // `id == Id.IUnknown` — Identifier reference identity (05 §2).
        if (id === Id.IUnknown) { // IUnknown is the root of all COM interfaces
            this.com = true;
            this.classKind = ClassKind.cpp; // IUnknown is also a C++ interface
        }
    }

    /// dmd/dclass.d:417 — `override InterfaceDeclaration syntaxCopy(Dsymbol s)`.
    override syntaxCopy(s: Dsymbol | null): InterfaceDeclaration {
        // `cast(InterfaceDeclaration)s` -> the isXxx() downcast (05 §10); D would fault on a
        // mismatch, so the `!` marks the same point.
        const id: InterfaceDeclaration =
            s !== null ? s.isInterfaceDeclaration()!
                       : new InterfaceDeclaration(this.loc, this.ident, null);
        // `ClassDeclaration.syntaxCopy(id)` — the explicit base call, i.e. `super.`.
        super.syntaxCopy(id);
        return id;
    }

    /*******************************************
     * Determine if 'this' is a base class of cd.
     * (Actually, if it is an interface supported by cd)
     * Output:
     *      *poffset        offset to start of class
     * Returns:
     *      false   not a base
     *      true    is a base
     *
     * dmd/dclass.d:435 — `override bool isBaseOf(ClassDeclaration cd, int* poffset)`.
     * The parameter keeps the base's `ClassDeclaration | null` type (the override contract);
     * THIS body dereferences it unconditionally, so each read carries `!` — the port faults
     * exactly where D would (02 §10.1).
     */
    override isBaseOf(cd: ClassDeclaration | null, poffset: Ref<number> | null): boolean {
        //printf("%s.InterfaceDeclaration.isBaseOf(cd = '%s')\n", toChars(), cd.toChars());
        assert(this.baseClass === null);
        // `foreach (b; cd.interfaces)` — a null slice iterates zero times in D (09 §1.0,
        // 06 §2.8); `?? []` reproduces exactly that, it does not collapse the field's model.
        for (const b of cd!.interfaces ?? []) {
            //printf("\tX base %s\n", b.sym.toChars());
            // `BaseClass*` slot; D dereferences it at :444 with no null test -> `!`.
            if (this === b!.sym) { // class-reference identity (05 §2)
                //printf("\tfound at offset %d\n", b.offset);
                if (poffset !== null) {
                    // don't return incorrect offsets
                    // https://issues.dlang.org/show_bug.cgi?id=16980
                    poffset.value = cd!.sizeok === Sizeok.done ? b!.offset : OFFSET_FWDREF;
                }
                // printf("\tfound at offset %d\n", b.offset);
                return true;
            }
            if (baseClassImplementsInterface(this, b!, poffset))
                return true;
        }
        // Unqualified `isBaseOf(...)` inside the class is `this.isBaseOf(...)` — virtual, i.e.
        // this same override (05 §2 / 04 §6 receiver rules).
        if (cd!.baseClass !== null && this.isBaseOf(cd!.baseClass, poffset))
            return true;

        if (poffset !== null)
            poffset.value = 0;
        return false;
    }

    /*******************************************
     * dmd/dclass.d:467 — `override const(char)* kind() const`.
     */
    override kind(): DString {
        return ds("interface");
    }

    /****************************************
     * Determine if slot 0 of the vtbl[] is reserved for something else.
     * For class objects, yes, this is where the ClassInfo ptr goes.
     * For COM interfaces, no.
     * For non-COM interfaces, yes, this is where the Interface ptr goes.
     *
     * dmd/dclass.d:478 — `override int vtblOffset() const`.
     */
    override vtblOffset(): number {
        if (this.isCOMinterface() || this.isCPPinterface())
            return 0;
        return 1;
    }

    /// dmd/dclass.d:485 — `override bool isCPPinterface() const`.
    override isCPPinterface(): boolean {
        return this.classKind === ClassKind.cpp;
    }

    /// dmd/dclass.d:490 — `override bool isCOMinterface() const`.
    override isCOMinterface(): boolean {
        return this.com;
    }

    /// dmd/dclass.d:495 — `override void accept(Visitor v) { v.visit(this); }` (13 §2).
    override accept(v: Visitor): void {
        v.visitInterfaceDeclaration(this);
    }
}

/**
 * Returns whether `bc` implements `id`, including indirectly (`bc` implements an interfaces
 * that inherits from `id`)
 *
 * Params:
 *    id = the interface
 *    bc = the base class
 *    poffset = out parameter, offset of the interface in an object
 *
 * Returns:
 *    true if the `bc` implements `id`, false otherwise
 *
 * dmd/dclass.d:513 — `private bool baseClassImplementsInterface(InterfaceDeclaration id,
 * BaseClass* bc, int* poffset)`. D `private` is module-scoped; the TS equivalent is simply
 * not exporting it (01 §2.5). `BaseClass* bc` -> the object reference, non-null because this
 * body dereferences it unconditionally (02 §10.1); `int* poffset` -> the `Ref<number>` box.
 */
function baseClassImplementsInterface(
    id: InterfaceDeclaration,
    bc: BaseClass,
    poffset: Ref<number> | null,
): boolean {
    //printf("%s.InterfaceDeclaration.isBaseOf(bc = '%s')\n", id.toChars(), bc.sym.toChars());
    for (let j = 0; j < bc.baseInterfaces.length; j++) {
        // `&bc.baseInterfaces[j]` — address-of a value element IS the element object (03 §7.2).
        const b = bc.baseInterfaces[j];
        //printf("\tY base %s\n", b.sym.toChars());
        if (id === b.sym) { // class-reference identity (05 §2)
            //printf("\tfound at offset %d\n", b.offset);
            if (poffset !== null) {
                poffset.value = b.offset;
            }
            return true;
        }
        if (baseClassImplementsInterface(id, b, poffset)) {
            return true;
        }
    }

    if (poffset !== null)
        poffset.value = 0;
    return false;
}
