// Ported from dmd/objc.d (module dmd.objc).
//
// Interfacing with Objective-C: the selector table, the per-class and per-function Objective-C
// data carried by `ClassDeclaration.objc` / `FuncDeclaration.objc`, and the `Objc` strategy
// object behind the module-level `objc()` accessor, which the semantic passes call.
//
// TARGET SELECTION. `Objc._init()` (objc.d:230) installs `Supported` when `target.objc.supported`
// holds and `Unsupported` otherwise. target.ts sets `objc.supported` from the triple (gen/target.cpp:183
// via gen/objcgen.cpp:21-36): true on the host arm64-apple-darwin, so the driver's `Objc._init()`
// (main.d:445) installs `Supported` (ldc2 probe: `version (D_ObjectiveC)` is set by default), false under
// `-mtriple=aarch64-linux-gnu` / `x86_64-linux-gnu` (10 §4.8), which installs `Unsupported`. Both classes are
// ported: the selection reads the target at call time.
//
// ORDER CONTRACT (01 §5.2). `objc()` returns null until `Objc._init()` has run, exactly as D's
// `_objc` is null before main.d:445. D calls it after `Id.initialize()` and `Module._init()`
// (main.d:441-445): `Supported`'s constructor interns `D_ObjectiveC` through `Identifier.idPool`
// and pushes it onto `global.versionids`, so the identifier table must exist. A test harness that
// resets `global.versionids` or the identifier table re-runs `Objc._init()` after that reset.
//
// LOAD ORDER (01 §4.8). func.ts and dclass.ts value-import this module (they construct the inline
// `ObjcFuncDeclaration` / `ObjcClassDeclaration`), so this module is reached while those two are
// mid-evaluation. It holds no top-level `extends` of an imported class. Its one top-level read of an
// imported binding is `ObjcSelector.stringtable`'s initializer (`new StringTable`), which runs at
// class definition; it is safe because root/stringtable.ts imports types only and so is fully
// evaluated first. Every other cross-module value is read inside a method body. The semantic-pass
// imports sit LAST, after the AST-node modules, per the rule 4.8 remedy.
//
// Language constructs resolved at translation time:
// resolved: version(IN_LLVM) -> ON (_config.md §1): `ObjcClassDeclaration.isSwiftStub`,
//   `Objc.setAsSwiftStub` and its two overrides, and `Supported.declaredAsSwiftStubCount` are kept.
// resolved: `static if (is(T == ClassDeclaration))` in the `setMetaclass` template (objc.d:925) ->
//   monomorphized per instantiation (07 §3.4): `setMetaclass` (T = ClassDeclaration, errorType
//   "class") and `setMetaclassInterfaceDeclaration` (T = InterfaceDeclaration, "interface").
//
// Overload sets (04 §1):
// - `ObjcSelector.lookup(s)` / `lookup(s, len, pcount)` — Form A: the short form computes `len`
//   and `pcount` and forwards, so it is one method with the two trailing parameters optional.
// - `Objc.setObjc`, `Objc.setMetaclass`, `Objc.addSymbols` — Form B pairs split by the first
//   parameter's type. Each D form is called once, cross-module (dsymbolsem.d:141/:143/:5283/:5617/
//   :6009/:6113), so rule 1 does not decide the bare name. The `ClassDeclaration` form keeps it and
//   the other form takes the receiver-type suffix (rule 2): `setObjcInterfaceDeclaration`,
//   `setMetaclassInterfaceDeclaration`, `addSymbolsAttribDeclaration`. `InterfaceDeclaration`
//   extends `ClassDeclaration` in TS as in D, so a caller holding an `InterfaceDeclaration`
//   reproduces D's static overload choice by calling the suffixed name.

import { ds, dsConcat, dsSubslice } from "../dstring.js";
import type { DString } from "../dstring.js";
import { assert, assertUnreachable } from "../assert.js";
import { StringTable } from "./root/stringtable.js";
import { Array as DArray } from "./root/array.js";
import { OutBuffer } from "./common/outbuffer.js";
import { error, errorSupplemental } from "./errors.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { LINK, STC, Tclass, Tenum } from "./astenums.js";
import { target } from "./target.js";
import type { Loc } from "./location.js";
import type { Scope } from "./dscope.js";
import type { Expression, StringExp } from "./expression.js";
import type { TypeClass, TypeFunction } from "./mtype.js";
import type { AggregateDeclaration } from "./aggregate.js";
import type { AttribDeclaration } from "./attrib.js";
import type { FuncDeclaration } from "./func.js";
import type { Dsymbol, ScopeDsymbol } from "./dsymbol.js";
import type { BaseClasses, ClassDeclarations } from "./arraytypes.js";
// AST-node modules (values read inside method bodies only) — named before the semantic passes (01 §4.8).
import { ClassKind } from "./aggregate.js";
import { Visibility } from "./dsymbol.js";
import { VarDeclaration } from "./declaration.js";
import { Type } from "./mtype.js";
import { BaseClass, ClassDeclaration, InterfaceDeclaration } from "./dclass.js";
import { VersionCondition } from "./cond.js";
import { isCoreUda } from "./attrib.js";
// last: semantic-pass value imports (01 §4.8). This module is entered from func.ts/dclass.ts
// mid-evaluation; the passes are named after every AST-node module so they evaluate last.
import { linkageToString } from "./hdrgen.js";
import { foreachUda } from "./attribsem.js";
import { toStringExp, toUTF8 } from "./expressionsem.js";
import { addMember, addObjcSymbols, dsymbolSemantic, include, insert } from "./dsymbolsem.js";

/***********************************************************
 * The selector of an Objective-C method: the interned selector string plus its parameter count.
 *
 * dmd/objc.d:45 — `struct ObjcSelector` (VALUE type, 03). Selectors are interned: every
 * `lookup` of the same bytes returns the SAME `ObjcSelector` object, held by reference
 * (`ObjcSelector*` in D, 02 §10), so `FuncDeclaration.objc.selector` is shared, never copied.
 */
export class ObjcSelector {
    // MARK: Selector
    // dmd/objc.d:48 — `private __gshared StringTable!(ObjcSelector*) stringtable;`. D-private,
    // reached by `_init` and `lookup` only. The table is replaced by `_init` (see there).
    private static stringtable: StringTable<ObjcSelector | null> = new StringTable<ObjcSelector | null>();
    // dmd/objc.d:49 — `private __gshared int incnum = 0;`. No reader anywhere in dmd/ or gen/;
    // kept as declared, never read. TS `private` would trip TS6133 (unused), so it is emitted bare.
    static incnum = 0; // D module-private
    stringvalue: DString | null = null;      // const(char)* — the interned key bytes (no trailing NUL)
    stringlen = 0;                           // size_t
    paramCount = 0;                          // size_t

    /**
     * dmd/objc.d:54 — `extern (C++) static void _init()`. Empties the selector table.
     *
     * D's `StringTable._init` allocates a fresh, empty table (root/stringtable.d:97); the djs
     * StringTable's `_init` is a capacity no-op, so a new table stands in for the fresh
     * allocation, as `Identifier.initTable` does. Called by `Supported`'s constructor.
     */
    static _init(): void {
        ObjcSelector.stringtable = new StringTable<ObjcSelector | null>();
    }

    /**
     * dmd/objc.d:59 — `extern (D) this(const(char)* sv, size_t len, size_t pcount) @safe`.
     * The no-argument form is D's default-initialized `ObjcSelector.init` (null, 0, 0).
     */
    constructor(sv: DString | null = null, len = 0, pcount = 0) {
        this.stringvalue = sv;
        this.stringlen = len;
        this.paramCount = pcount;
    }

    copy(): ObjcSelector {
        return new ObjcSelector(this.stringvalue, this.stringlen, this.paramCount); // view: shared (03 §2)
    }

    /**
     * Returns the interned selector for `s`, creating it on first use.
     *
     * Form A collapse (04 §1) of two D overloads:
     * - dmd/objc.d:66 — `extern (D) static ObjcSelector* lookup(const(char)* s)`: `len` and
     *   `pcount` omitted; the selector is the C string `s` (the bytes before its first NUL, or all
     *   of `s` when it holds none — 02 §11) and `pcount` is its number of `':'`.
     * - dmd/objc.d:81 — `extern (D) static ObjcSelector* lookup(const(char)* s, size_t len, size_t pcount)`:
     *   the selector is `s[0 .. len]` and `pcount` is taken as given.
     *
     * The table stores its own copy of the key bytes; the returned selector's `stringvalue` is that
     * copy, so `s` may be a transient buffer.
     */
    static lookup(s: DString, len?: number, pcount?: number): ObjcSelector {
        if (len === undefined) {
            // dmd/objc.d:68-78 — count bytes and colons up to the terminating NUL.
            let n = 0;
            let colons = 0;
            let i = 0;
            while (i < s.length && s[i] !== 0) {
                ++n;
                if (s[i] === 0x3A) // ':'
                    ++colons;
                ++i;
            }
            return ObjcSelector.lookup(s, n, colons);
        }

        // `null` is the `T.init` of `ObjcSelector*` that `update` stores in a new entry (08 §5).
        const sv = ObjcSelector.stringtable.update(dsSubslice(s, 0, len), null);
        // `pcount` accompanies `len` in D's three-argument form (there is no two-argument one).
        let sel = sv.value;
        if (sel === null) {
            sel = new ObjcSelector(sv.toDchars(), len, pcount!);
            sv.value = sel;
        }
        return sel;
    }

    /**
     * dmd/objc.d:93 — `static const(char)[] toPascalCase(const(char)[] id) {`.
     * Returns a fresh buffer: `id` with its first byte upper-cased when it is an ASCII lower-case
     * letter. Precondition: `id` is non-empty (D indexes `id[0]`).
     */
    static toPascalCase(id: DString): DString {
        const buf = new OutBuffer();
        let firstChar = id[0];
        if (firstChar >= 0x61 && firstChar <= 0x7A) // 'a' .. 'z'
            firstChar = (firstChar - 0x61 + 0x41) & 0xFF; // D `cast(char)(firstChar - 'a' + 'A')`

        buf.writeByte(firstChar);
        buf.writestring(dsSubslice(id, 1));
        return buf.extractSlice(false);
    }

    /**
     * dmd/objc.d:104 — `extern (C++) static ObjcSelector* create(FuncDeclaration fdecl)`.
     *
     * Generates the selector D derives for a method with no `@selector` UDA:
     * - a `@property` setter (one parameter) `foo` -> `setFoo:`, and `isFoo` -> `setFoo:`;
     * - otherwise the identifier, then for two or more parameters `:` and each further
     *   parameter's NAME followed by `:` (`f(int a, int b, int c)` -> `f:b:c:`), and for exactly
     *   one parameter a single `:`.
     * ldc2 probe (the object file's selector strings): `f1`, `f2:`, `f3:b:c:`, `setFoo:` for
     * `isFoo`, `setBar:`, `set_:` for `is_`, `setZed:`, `sm:r:` for a static method.
     *
     * Precondition: `fdecl.type` is a `TypeFunction`, and every parameter after the first is named
     * (D dereferences `ident` with no check).
     */
    static create(fdecl: FuncDeclaration): ObjcSelector {
        const buf = new OutBuffer();
        // D `cast(TypeFunction)fdecl.type` — the isXxx() downcast (05 §10); D faults on a mismatch.
        const ftype: TypeFunction = fdecl.type!.isTypeFunction()!;
        const id = fdecl.ident!.toString();
        const nparams = ftype.parameterList.length();

        // Lcomplete: SKIP-FLAG, if/else sub-case (06 §4). The property-setter arm jumps over the
        // generic selector writing, which becomes the `else` arm; `Lcomplete:` follows that arm
        // directly, so no statement needs the flag and none is emitted.
        // Special case: property setter
        if (ftype.isProperty && nparams === 1) {
            // Special case: "isXYZ:"
            if (id.length >= 2 && id[0] === 0x69 && id[1] === 0x73) { // `id[0..2] == "is"`
                buf.writestring(ds("set"));
                buf.write(ObjcSelector.toPascalCase(dsSubslice(id, 2)));
            } else {
                buf.writestring(ds("set"));
                buf.write(ObjcSelector.toPascalCase(id));
            }
            buf.writeByte(0x3A); // ':'
            // goto Lcomplete (dmd/objc.d:127)
        } else {
            // write identifier in selector
            buf.write(id);

            // To make it easier to match the selectors of objects nicely,
            // the implementation has been replaced so that the parameter name followed by a colon
            // is used instead.
            // eg. void myFunction(int a, int b, int c) would be mangled to a selector as `myFunction:b:c:
            if (nparams > 1) {
                buf.writeByte(0x3A); // ':'
                for (let i = 1; i < nparams; i++) {
                    buf.write(ftype.parameterList.opIndex(i)!.ident!.toString());
                    buf.writeByte(0x3A); // ':'
                }
            } else if (nparams === 1) {
                buf.writeByte(0x3A); // ':'
            }
        }
        // Lcomplete:
        buf.writeByte(0);

        // the slice is not expected to include a terminating 0
        return ObjcSelector.lookup(buf.opSliceAll(), buf.length() - 1, nparams);
    }

    /// dmd/objc.d:157 — `extern (D) const(char)[] toString() const pure`. A view of the interned bytes.
    toString(): DString {
        return dsSubslice(this.stringvalue!, 0, this.stringlen);
    }
}

// dmd/objc.d:163 — `private __gshared Objc _objc;`. Null until `Objc._init()` (see the ORDER CONTRACT above).
let _objc: Objc | null = null;

/**
 * dmd/objc.d:165 — `Objc objc()`. The Objective-C strategy the driver installed with
 * `Objc._init()`: `Supported` on a Darwin triple, `Unsupported` otherwise. Null before `Objc._init()` and after
 * `Objc.deinitialize()`, as in D; every D caller dereferences the result unchecked, so a caller
 * writes `objc()!.method(...)`, the `!` marking where D would fault on a missing `_init`.
 */
export function objc(): Objc | null {
    return _objc;
}

/**
 * Contains all data for a class declaration that is needed for the Objective-C
 * integration.
 *
 * dmd/objc.d:175 — `extern (C++) struct ObjcClassDeclaration` (VALUE type), embedded inline in
 * `ClassDeclaration` and built by its constructor (dclass.d:154).
 */
export class ObjcClassDeclaration {
    /// `true` if this class is a metaclass.
    isMeta = false;

    /// `true` if this class is externally defined.
    isExtern = false;

    /// `true` if this class is a Swift stub
    isSwiftStub = false;                     // version(IN_LLVM): ON

    /// Name of this class.
    identifier: Identifier | null = null;

    /// The class declaration this belongs to.
    classDeclaration: ClassDeclaration | null = null;

    /// The metaclass of this class.
    metaclass: ClassDeclaration | null = null;

    /// List of non-inherited methods.
    // D `FuncDeclaration[]` is a slice, not an `Array!T` (02 §8); its `.init` is the empty slice.
    methodList: FuncDeclaration[] = [];

    /// dmd/objc.d:198 — `extern (D) this(ClassDeclaration classDeclaration) @safe`. The no-argument
    /// form is D's default-initialized struct (`classDeclaration` null).
    constructor(classDeclaration: ClassDeclaration | null = null) {
        this.classDeclaration = classDeclaration;
    }

    /**
     * dmd/objc.d:203 — `bool isRootClass() const @safe`.
     * True when the class kind is `ClassKind.objc`, `metaclass` is null and the class's `baseClass`
     * is null. Precondition: `classDeclaration` is set (D dereferences it).
     */
    isRootClass(): boolean {
        return this.classDeclaration!.classKind === ClassKind.objc &&
            this.metaclass === null &&
            this.classDeclaration!.baseClass === null;
    }

    copy(): ObjcClassDeclaration {
        const c = new ObjcClassDeclaration(this.classDeclaration);
        c.isMeta = this.isMeta;
        c.isExtern = this.isExtern;
        c.isSwiftStub = this.isSwiftStub;
        c.identifier = this.identifier;      // class reference: share (03 §2)
        c.metaclass = this.metaclass;        // class reference: share
        c.methodList = this.methodList;      // slice: share (03 §2)
        return c;
    }
}

/**
 * Contains all data for a function declaration that is needed for the
 * Objective-C integration.
 *
 * dmd/objc.d:215 — `extern (C++) struct ObjcFuncDeclaration` (VALUE type), embedded inline in
 * `FuncDeclaration`.
 */
export class ObjcFuncDeclaration {
    /// The method selector (member functions only).
    selector: ObjcSelector | null = null;            // `ObjcSelector*` -> the interned reference

    /// The implicit selector parameter.
    selectorParameter: VarDeclaration | null = null;

    /// `true` if this function declaration is declared optional.
    isOptional = false;

    copy(): ObjcFuncDeclaration {
        const c = new ObjcFuncDeclaration();
        c.selector = this.selector;          // reference: share (03 §2)
        c.selectorParameter = this.selectorParameter; // class reference: share
        c.isOptional = this.isOptional;
        return c;
    }
}

/**
 * The Objective-C strategy of the semantic passes, reached through `objc()`.
 *
 * dmd/objc.d:228 — `extern(C++) abstract class Objc` ("Should be an interface"). Two
 * implementations: `Supported` (a Darwin triple) and `Unsupported`.
 */
export abstract class Objc {
    /**
     * dmd/objc.d:230 — `static void _init()`. Installs `Supported` when `target.objc.supported`
     * holds, `Unsupported` otherwise. Each call builds a NEW strategy; `Supported`'s constructor
     * re-registers `D_ObjectiveC` and empties the selector table. ORDER CONTRACT: see the header.
     */
    static _init(): void {
        if (target.objc.supported)
            _objc = new Supported();
        else
            _objc = new Unsupported();
    }

    /**
     * Deinitializes the global state of the compiler.
     *
     * This can be used to restore the state set by `_init` to its original
     * state.
     *
     * dmd/objc.d:244 — `static void deinitialize()`. `_objc.init` of a class reference is null.
     */
    static deinitialize(): void {
        _objc = null;
    }

    /// dmd/objc.d:249 — `abstract void setObjc(ClassDeclaration cd);` (Form B: keeps the bare name).
    abstract setObjc(cd: ClassDeclaration): void;
    /// dmd/objc.d:250 — `abstract void setObjc(InterfaceDeclaration);` (Form B, receiver-type suffix).
    abstract setObjcInterfaceDeclaration(id: InterfaceDeclaration): void;

    /**
     * Returns a pretty textual representation of the given class declaration.
     *
     * Params:
     *  classDeclaration = the class declaration to return the textual representation for
     *  qualifyTypes = `true` if types should be qualified in the result
     *
     * Returns: the textual representation
     *
     * dmd/objc.d:261 — `abstract const(char)* toPrettyChars(ClassDeclaration classDeclaration, bool qualifyTypes)`
     */
    abstract toPrettyChars(classDeclaration: ClassDeclaration, qualifyTypes: boolean): DString;

    /// dmd/objc.d:263 — `abstract void setSelector(FuncDeclaration, Scope* sc);`
    abstract setSelector(fd: FuncDeclaration, sc: Scope): void;
    /// dmd/objc.d:264 — `abstract void validateSelector(FuncDeclaration fd);`
    abstract validateSelector(fd: FuncDeclaration): void;
    /// dmd/objc.d:265 — `abstract void checkLinkage(FuncDeclaration fd);`
    abstract checkLinkage(fd: FuncDeclaration): void;

    /**
     * Returns `true` if the given function declaration is virtual.
     *
     * Function declarations with Objective-C linkage and which are static or
     * final are considered virtual.
     *
     * Params:
     *  fd = the function declaration to check if it's virtual
     *
     * Returns: `true` if the given function declaration is virtual
     *
     * dmd/objc.d:278 — `abstract bool isVirtual(const FuncDeclaration fd) const;`
     */
    abstract isVirtual(fd: FuncDeclaration): boolean;

    /**
     * Marks the given function declaration as optional.
     *
     * A function declaration is considered optional if it's annotated with the
     * UDA: `@(core.attribute.optional)`. Only function declarations inside
     * interface declarations and with Objective-C linkage can be declared as
     * optional.
     *
     * Params:
     *  functionDeclaration = the function declaration to be set as optional
     *  sc = the scope from the semantic phase
     *
     * dmd/objc.d:292 — `abstract void setAsOptional(FuncDeclaration functionDeclaration, Scope* sc) const;`
     */
    abstract setAsOptional(functionDeclaration: FuncDeclaration, sc: Scope): void;

    /**
     * Marks the given class as a Swift stub class.
     *
     * Params:
     *  cd = the class declaration to set as a swift stub
     *  sc = the scope from the semantic phase
     *
     * dmd/objc.d:302 — `abstract void setAsSwiftStub(ClassDeclaration cd, Scope* sc) const;` (version(IN_LLVM): ON)
     */
    abstract setAsSwiftStub(cd: ClassDeclaration, sc: Scope): void;

    /**
     * Validates function declarations declared optional.
     *
     * Params:
     *  functionDeclaration = the function declaration to validate
     *
     * dmd/objc.d:310 — `abstract void validateOptional(FuncDeclaration functionDeclaration) const;`
     */
    abstract validateOptional(functionDeclaration: FuncDeclaration): void;

    /**
     * Gets the parent of the given function declaration.
     *
     * Handles Objective-C static member functions, which are virtual functions
     * of the metaclass, by returning the parent class declaration to the
     * metaclass.
     *
     * Params:
     *  fd = the function declaration to get the parent of
     *  cd = the current parent, i.e. the class declaration the given function
     *      declaration belongs to
     *
     * Returns: the parent
     *
     * dmd/objc.d:326 — `abstract ClassDeclaration getParent(FuncDeclaration fd,`
     */
    abstract getParent(fd: FuncDeclaration, cd: ClassDeclaration): ClassDeclaration;

    /**
     * Adds the given function to the list of Objective-C methods.
     *
     * This list will later be used output the necessary Objective-C module info.
     *
     * Params:
     *  fd = the function declaration to be added to the list
     *  cd = the class declaration the function belongs to
     *
     * dmd/objc.d:338 — `abstract void addToClassMethodList(FuncDeclaration fd,`
     */
    abstract addToClassMethodList(fd: FuncDeclaration, cd: ClassDeclaration): void;

    /**
     * Returns the `this` pointer of the given function declaration.
     *
     * This is only used for class/static methods. For instance methods, no
     * Objective-C specialization is necessary.
     *
     * Params:
     *  funcDeclaration = the function declaration to get the `this` pointer for
     *
     * Returns: the `this` pointer of the given function declaration, or `null`
     *  if the given function declaration is not an Objective-C method.
     *
     * dmd/objc.d:353 — `abstract inout(AggregateDeclaration) isThis(inout FuncDeclaration funcDeclaration) const;`
     */
    abstract isThis(funcDeclaration: FuncDeclaration): AggregateDeclaration | null;

    /**
     * Creates the selector parameter for the given function declaration.
     *
     * Objective-C methods has an extra hidden parameter that comes after the
     * `this` parameter. The selector parameter is of the Objective-C type `SEL`
     * and contains the selector which this method was called with.
     *
     * Params:
     *  fd = the function declaration to create the parameter for
     *  sc = the scope from the semantic phase
     *
     * Returns: the newly created selector parameter or `null` for
     *  non-Objective-C functions
     *
     * dmd/objc.d:369 — `abstract VarDeclaration createSelectorParameter(FuncDeclaration fd, Scope* sc) const;`
     */
    abstract createSelectorParameter(fd: FuncDeclaration, sc: Scope): VarDeclaration | null;

    /**
     * Creates and sets the metaclass on the given class/interface declaration.
     *
     * Will only be performed on regular Objective-C classes, not on metaclasses.
     *
     * Params:
     *  classDeclaration = the class/interface declaration to set the metaclass on
     *
     * dmd/objc.d:379 — `abstract void setMetaclass(InterfaceDeclaration interfaceDeclaration, Scope* sc) const;`
     * (Form B, receiver-type suffix.)
     */
    abstract setMetaclassInterfaceDeclaration(interfaceDeclaration: InterfaceDeclaration, sc: Scope | null): void;

    /// ditto
    /// dmd/objc.d:382 — `abstract void setMetaclass(ClassDeclaration classDeclaration, Scope* sc) const;` (bare name)
    abstract setMetaclass(classDeclaration: ClassDeclaration, sc: Scope | null): void;

    /**
     * Returns Objective-C runtime metaclass of the given class declaration.
     *
     * `ClassDeclaration.ObjcClassDeclaration.metaclass` contains the metaclass
     * from the semantic point of view. This function returns the metaclass from
     * the Objective-C runtime's point of view. Here, the metaclass of a
     * metaclass is the root metaclass, not `null`. The root metaclass's
     * metaclass is itself.
     *
     * Params:
     *  classDeclaration = The class declaration to return the metaclass of
     *
     * Returns: the Objective-C runtime metaclass of the given class declaration
     *
     * dmd/objc.d:398 — `abstract ClassDeclaration getRuntimeMetaclass(ClassDeclaration classDeclaration) const;`
     */
    abstract getRuntimeMetaclass(classDeclaration: ClassDeclaration): ClassDeclaration | null;

    /// dmd/objc.d:401 — `abstract void addSymbols(AttribDeclaration attribDeclaration,`
    /// (Form B, receiver-type suffix).
    abstract addSymbolsAttribDeclaration(attribDeclaration: AttribDeclaration,
        classes: ClassDeclarations | null, categories: ClassDeclarations | null): void;

    /// dmd/objc.d:405 — `abstract void addSymbols(ClassDeclaration classDeclaration,` (bare name).
    /// `classes` is D's nullable `ClassDeclarations*`, as in the sibling; `Supported` pushes into it
    /// unchecked, so its body carries the `!` at D's fault point.
    abstract addSymbols(classDeclaration: ClassDeclaration,
        classes: ClassDeclarations | null, categories: ClassDeclarations | null): void;

    /**
     * Issues a compile time error if the `.offsetof`/`.tupleof` property is
     * used on a field of an Objective-C class.
     *
     * To solve the fragile base class problem in Objective-C, fields have a
     * dynamic offset instead of a static offset. The compiler outputs a
     * statically known offset which later the dynamic loader can update, if
     * necessary, when the application is loaded. Due to this behavior it
     * doesn't make sense to be able to get the offset of a field at compile
     * time, because this offset might not actually be the same at runtime.
     *
     * To get the offset of a field that is correct at runtime, functionality
     * from the Objective-C runtime can be used instead.
     *
     * Params:
     *  expression = the `.offsetof`/`.tupleof` expression
     *  aggregateDeclaration = the aggregate declaration the field of the
     *      `.offsetof`/`.tupleof` expression belongs to
     *  type = the type of the receiver of the `.tupleof` expression
     *
     * See_Also:
     *  $(LINK2 https://en.wikipedia.org/wiki/Fragile_binary_interface_problem,
     *      Fragile Binary Interface Problem)
     *
     * See_Also:
     *  $(LINK2 https://developer.apple.com/documentation/objectivec/objective_c_runtime,
     *      Objective-C Runtime)
     *
     * dmd/objc.d:436 — `abstract void checkOffsetof(Expression expression, AggregateDeclaration`
     */
    abstract checkOffsetof(expression: Expression, aggregateDeclaration: AggregateDeclaration): void;

    /// ditto
    /// dmd/objc.d:439 — `abstract void checkTupleof(Expression expression, TypeClass type) const;`
    abstract checkTupleof(expression: Expression, type: TypeClass): void;
}

/**
 * dmd/objc.d:442 — `extern(C++) private final class Unsupported : Objc`. D module-private (not
 * exported); reached through `Objc._init()` when the target lacks Objective-C. The class and
 * interface arms report the one diagnostic; the rest are no-ops, or `assert(0)` for the queries
 * only an Objective-C declaration can reach.
 */
class Unsupported extends Objc {
    // dmd/objc.d:444 — `extern(D) final this()`: empty body.
    constructor() {
        super();
    }

    override setObjc(cd: ClassDeclaration): void {
        // dmd/objc.d:450 — `Objective-C classes not supported`
        error(cd.loc, ds("%s `%s` Objective-C classes not supported"), cd.kind(), cd.toPrettyChars());
    }

    override setObjcInterfaceDeclaration(id: InterfaceDeclaration): void {
        // dmd/objc.d:455 — `Objective-C interfaces not supported`
        error(id.loc, ds("%s `%s` Objective-C interfaces not supported"), id.kind(), id.toPrettyChars());
    }

    override toPrettyChars(_classDeclaration: ClassDeclaration, _qualifyTypes: boolean): DString {
        assertUnreachable("Should never be called when Objective-C is not supported"); // dmd/objc.d:460
    }

    override setSelector(_fd: FuncDeclaration, _sc: Scope): void {
        // noop
    }

    override validateSelector(_fd: FuncDeclaration): void {
        // noop
    }

    override checkLinkage(_fd: FuncDeclaration): void {
        // noop
    }

    override isVirtual(_fd: FuncDeclaration): boolean {
        assertUnreachable("Should never be called when Objective-C is not supported"); // dmd/objc.d:480
    }

    override setAsOptional(_fd: FuncDeclaration, _sc: Scope): void {
        // noop
    }

    // version(IN_LLVM): ON
    override setAsSwiftStub(_cd: ClassDeclaration, _sc: Scope): void {
        // noop
    }

    override validateOptional(_fd: FuncDeclaration): void {
        // noop
    }

    override getParent(_fd: FuncDeclaration, cd: ClassDeclaration): ClassDeclaration {
        return cd;
    }

    override addToClassMethodList(_fd: FuncDeclaration, _cd: ClassDeclaration): void {
        // noop
    }

    override isThis(_funcDeclaration: FuncDeclaration): AggregateDeclaration | null {
        return null;
    }

    override createSelectorParameter(_fd: FuncDeclaration, _sc: Scope): VarDeclaration | null {
        return null;
    }

    override setMetaclassInterfaceDeclaration(_interfaceDeclaration: InterfaceDeclaration, _sc: Scope | null): void {
        // noop
    }

    override setMetaclass(_classDeclaration: ClassDeclaration, _sc: Scope | null): void {
        // noop
    }

    override getRuntimeMetaclass(_classDeclaration: ClassDeclaration): ClassDeclaration | null {
        assertUnreachable("Should never be called when Objective-C is not supported"); // dmd/objc.d:531
    }

    override addSymbolsAttribDeclaration(_attribDeclaration: AttribDeclaration,
        _classes: ClassDeclarations | null, _categories: ClassDeclarations | null): void {
        // noop
    }

    override addSymbols(_classDeclaration: ClassDeclaration,
        _classes: ClassDeclarations | null, _categories: ClassDeclarations | null): void {
        // noop
    }

    override checkOffsetof(_expression: Expression, _aggregateDeclaration: AggregateDeclaration): void {
        // noop
    }

    override checkTupleof(_expression: Expression, _type: TypeClass): void {
        // noop
    }
}

/**
 * dmd/objc.d:557 — `extern(C++) private final class Supported : Objc`. D module-private (not
 * exported); the strategy `Objc._init()` installs on a Darwin triple.
 *
 * CONTRACTS. The `in` contracts of `isVirtual` (objc.d:640), `addToClassMethodList` (objc.d:737)
 * and `createSelectorParameter` (objc.d:775) are DROPPED, because D never evaluates them: an
 * overriding method's `in` contract is OR-ed with the overridden one's, and the abstract `Objc`
 * methods declare none, so the precondition is always satisfied and the contract body is not
 * even semantically analysed. ldc2 probes: an override `in { assert(fd.selector); }` naming a
 * member that does not exist compiles cleanly (the two `isVirtual`/`createSelectorParameter`
 * contracts do exactly that: `FuncDeclaration` has no `selector`/`selectorParameter`), and an
 * override `in { assert(x > 0); }` called with `x = -1` runs its body without an AssertError.
 * The `out` contract of `getParent` (objc.d:724) IS evaluated (out contracts are AND-ed; the same
 * probe's `out` fired) and is ported as a trailing assert (04 §7).
 */
class Supported extends Objc {
    /// dmd/objc.d:559 — `extern(D) final this()`. Predefines `version (D_ObjectiveC)` and empties
    /// the selector table.
    constructor() {
        super();
        VersionCondition.addPredefinedGlobalIdent(ds("D_ObjectiveC"));

        ObjcSelector._init();
    }

    override setObjc(cd: ClassDeclaration): void {
        cd.classKind = ClassKind.objc;
        cd.objc.isExtern = (cd.storage_class & STC.extern_) > 0n;
        // `cd._scope` may be null; D forwards it as is, and `foreachUda` reads the scope only when
        // the class carries UDAs (attribsem.d:64), so the `!` marks the same fault point as D.
        this.setAsSwiftStub(cd, cd._scope!);
    }

    override setObjcInterfaceDeclaration(id: InterfaceDeclaration): void {
        id.classKind = ClassKind.objc;
        id.objc.isExtern = true;
    }

    override toPrettyChars(cd: ClassDeclaration, qualifyTypes: boolean): DString {
        return cd.parent!.toPrettyChars(qualifyTypes);
    }

    /**
     * dmd/objc.d:584 — `override void setSelector(FuncDeclaration fd, Scope* sc)`.
     * Attaches the selector of the `@selector("...")` UDA to `fd`, diagnosing a second one; for an
     * Objective-C function with none (and not a template-instance member) generates one with
     * `ObjcSelector.create`.
     */
    override setSelector(fd: FuncDeclaration, sc: Scope): void {
        foreachUda(fd, sc, (e: Expression): number => {
            if (e.isStructLiteralExp() === null)
                return 0;

            const literal = e.isStructLiteralExp()!;
            assert(literal.sd !== null);

            // upcast cascade (02 §11.5): AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool)
            if (!isCoreUda(literal.sd as unknown as Dsymbol, Id.udaSelector!))
                return 0;

            if (fd.objc.selector !== null) {
                // dmd/objc.d:598 — `can only have one Objective-C selector per method`
                error(fd.loc, ds("%s `%s` can only have one Objective-C selector per method"),
                    fd.kind(), fd.toPrettyChars());
                return 1;
            }

            assert(literal.elements!.length === 1);
            const se: StringExp | null = toStringExp(literal.elements!.opIndex(0)!);
            assert(se !== null);

            // D `se.toUTF8(sc).peekString().ptr` — the `const(char)*` view of the UTF-8 payload.
            // Halts today: StringExp.peekString is the payload-representation escalation (expression.ts:1219).
            fd.objc.selector = ObjcSelector.lookup(toUTF8(se, sc).peekString());

            return 0;
        });

        // Avoid attempting to generate selectors for template instances.
        if (fd.parent !== null && fd.parent.isTemplateInstance() !== null)
            return;

        // No selector declared, generate one.
        if (fd._linkage === LINK.objc && fd.objc.selector === null) {
            fd.objc.selector = ObjcSelector.create(fd);
        }
    }

    override validateSelector(fd: FuncDeclaration): void {
        if (fd.objc.selector === null)
            return;
        // D `cast(TypeFunction)fd.type` — the isXxx() downcast (05 §10); D faults on a mismatch.
        const tf = fd.type!.isTypeFunction()!;
        if (fd.objc.selector.paramCount !== tf.parameterList.parameters!.length) // the RAW `Parameters` length
            // dmd/objc.d:628 — `number of colons in Objective-C selector must match number of parameters`
            error(fd.loc, ds("%s `%s` number of colons in Objective-C selector must match number of parameters"),
                fd.kind(), fd.toPrettyChars());
        if (fd.parent !== null && fd.parent.isTemplateInstance() !== null)
            // dmd/objc.d:630 — `template cannot have an Objective-C selector attached`
            error(fd.loc, ds("%s `%s` template cannot have an Objective-C selector attached"),
                fd.kind(), fd.toPrettyChars());
    }

    override checkLinkage(fd: FuncDeclaration): void {
        if (fd._linkage !== LINK.objc && fd.objc.selector !== null)
            // dmd/objc.d:636 — `must have Objective-C linkage to attach a selector`
            error(fd.loc, ds("%s `%s` must have Objective-C linkage to attach a selector"),
                fd.kind(), fd.toPrettyChars());
    }

    /// dmd/objc.d:639 — `override bool isVirtual(const FuncDeclaration fd) const`. The `in` contract
    /// is dropped (never evaluated by D — see the class comment).
    override isVirtual(fd: FuncDeclaration): boolean {
        if (fd.toParent()!.isInterfaceDeclaration() !== null && fd.isFinal())
            return false;

        // * final member functions are kept virtual with Objective-C linkage
        //   because the Objective-C runtime always use dynamic dispatch.
        // * static member functions are kept virtual too, as they represent
        //   methods of the metaclass.
        const _w = fd.visibility; // D `with (fd.visibility)` (06 §5)
        return !(_w.kind === Visibility.Kind.private_ || _w.kind === Visibility.Kind.package_);
    }

    override setAsOptional(fd: FuncDeclaration, sc: Scope): void {
        const count = this.declaredAsOptionalCount(fd, sc);
        fd.objc.isOptional = count > 0;

        if (count > 1)
            // dmd/objc.d:664 — `can only declare a function as optional once`
            error(fd.loc, ds("%s `%s` can only declare a function as optional once"), fd.kind(), fd.toPrettyChars());
    }

    /// Returns: the number of times `fd` has been declared as optional.
    /// dmd/objc.d:668 — `private int declaredAsOptionalCount(FuncDeclaration fd , Scope* sc) const`
    private declaredAsOptionalCount(fd: FuncDeclaration, sc: Scope): number {
        let count = 0;

        foreachUda(fd, sc, (e: Expression): number => {
            if (e.isTypeExp() === null)
                return 0;

            const typeExp = e.isTypeExp()!;

            if (typeExp.type!.ty !== Tenum)
                return 0;

            // D `cast(TypeEnum) typeExp.type` — non-null: `ty == Tenum` was checked just above.
            const typeEnum = typeExp.type!.isTypeEnum()!;

            if (isCoreUda(typeEnum.sym!, Id.udaOptional!))
                count++;

            return 0;
        });

        return count;
    }

    override validateOptional(fd: FuncDeclaration): void {
        if (!fd.objc.isOptional)
            return;

        if (fd._linkage !== LINK.objc) {
            // dmd/objc.d:699 — `only functions with Objective-C linkage can be declared as optional`
            error(fd.loc, ds("%s `%s` only functions with Objective-C linkage can be declared as optional"),
                fd.kind(), fd.toPrettyChars());

            const linkage = linkageToString(fd._linkage);

            // dmd/objc.d:703 — `errorSupplemental(fd.loc, "function is declared with %.*s linkage",`
            errorSupplemental(fd.loc, ds("function is declared with %.*s linkage"), linkage.length, linkage);
        }

        let parent = fd.parent;

        if (parent !== null && parent.isTemplateInstance() !== null) {
            // dmd/objc.d:711 — `template cannot be optional`
            error(fd.loc, ds("%s `%s` template cannot be optional"), fd.kind(), fd.toPrettyChars());
            parent = parent.parent;
            assert(parent !== null);
        }

        if (parent !== null && parent.isInterfaceDeclaration() === null) {
            // dmd/objc.d:718 — `only functions declared inside interfaces can be optional`
            error(fd.loc, ds("%s `%s` only functions declared inside interfaces can be optional"),
                fd.kind(), fd.toPrettyChars());
            // dmd/objc.d:719 — `errorSupplemental(fd.loc, "function is declared inside %s", fd.parent.kind);`
            errorSupplemental(fd.loc, ds("function is declared inside %s"), fd.parent!.kind());
        }
    }

    /// dmd/objc.d:723 — `override ClassDeclaration getParent(FuncDeclaration fd, ClassDeclaration cd) const`.
    /// `out(metaclass) { assert(metaclass); }` runs on the single exit (04 §7).
    override getParent(fd: FuncDeclaration, cd: ClassDeclaration): ClassDeclaration {
        const metaclass: ClassDeclaration | null =
            (cd.classKind === ClassKind.objc && fd.isStatic() && !cd.objc.isMeta) ? cd.objc.metaclass : cd;
        assert(metaclass !== null); // from `out(metaclass)` contract (dmd/objc.d:726)
        return metaclass;
    }

    /// dmd/objc.d:736 — `override void addToClassMethodList(FuncDeclaration fd, ClassDeclaration cd) const`.
    /// The `in` contract is dropped (never evaluated by D — see the class comment).
    override addToClassMethodList(fd: FuncDeclaration, cd: ClassDeclaration): void {
        if (cd.classKind !== ClassKind.objc)
            return;

        if (fd.objc.selector === null)
            return;

        assert(fd.isStatic() ? cd.objc.isMeta : !cd.objc.isMeta);

        cd.objc.methodList.push(fd); // D `~=` on the owned slice
    }

    /// dmd/objc.d:754 — `override inout(AggregateDeclaration) isThis(inout FuncDeclaration funcDeclaration) const`.
    /// The metaclass of the enclosing Objective-C class for a selector-carrying member, else null.
    override isThis(funcDeclaration: FuncDeclaration): AggregateDeclaration | null {
        const _w = funcDeclaration; // D `with(funcDeclaration)` (06 §5)
        if (_w.objc.selector === null)
            return null;

        // Use Objective-C class object as 'this'
        // D dereferences both results unchecked: a selector-carrying function is a class member.
        const cd = _w.isMember2()!.isClassDeclaration()!;

        if (cd.classKind === ClassKind.objc) {
            if (!cd.objc.isMeta)
                // upcast cascade (02 §11.5): ClassDeclaration.syntaxCopy's covariant return carries the
                // AggregateDeclaration.deferred (Dsymbol) / Dsymbol.deferred (bool) shadow.
                return cd.objc.metaclass as unknown as AggregateDeclaration | null;
        }

        return null;
    }

    /// dmd/objc.d:774 — `override VarDeclaration createSelectorParameter(FuncDeclaration fd, Scope* sc) const`.
    /// The `in` contract is dropped (never evaluated by D — see the class comment).
    override createSelectorParameter(fd: FuncDeclaration, sc: Scope): VarDeclaration | null {
        if (fd.objc.selector === null)
            return null;

        const ident = Identifier.generateAnonymousId(ds("_cmd"));
        const var_ = new VarDeclaration(fd.loc, Type.tvoidptr, ident, null);
        var_.storage_class = (var_.storage_class | STC.parameter) as STC; // STC brand re-applied (02 §4.2)
        dsymbolSemantic(var_, sc);
        if (insert(sc, var_) === null)
            assertUnreachable(); // D `assert(false)`
        var_.parent = fd;

        return var_;
    }

    override setMetaclassInterfaceDeclaration(interfaceDeclaration: InterfaceDeclaration, sc: Scope | null): void {
        const newMetaclass = (loc: Loc, metaBases: BaseClasses): InterfaceDeclaration => {
            const ident = createMetaclassIdentifier(interfaceDeclaration);
            return new InterfaceDeclaration(loc, ident, metaBases);
        };

        setMetaclassInterfaceDeclaration(newMetaclass, interfaceDeclaration, sc);
    }

    override setMetaclass(classDeclaration: ClassDeclaration, sc: Scope | null): void {
        const newMetaclass = (loc: Loc, metaBases: BaseClasses): ClassDeclaration => {
            const ident = createMetaclassIdentifier(classDeclaration);
            return new ClassDeclaration(loc, ident, metaBases, new DArray<Dsymbol | null>(), false); // D `0` -> bool
        };

        setMetaclass(newMetaclass, classDeclaration, sc);
    }

    override getRuntimeMetaclass(classDeclaration: ClassDeclaration): ClassDeclaration | null {
        if (classDeclaration.objc.metaclass === null && classDeclaration.objc.isMeta) {
            if (classDeclaration.baseClass !== null)
                return this.getRuntimeMetaclass(classDeclaration.baseClass);

            return classDeclaration;
        }
        return classDeclaration.objc.metaclass;
    }

    override addSymbolsAttribDeclaration(attribDeclaration: AttribDeclaration,
        classes: ClassDeclarations | null, categories: ClassDeclarations | null): void {
        const symbols = include(attribDeclaration, null);

        if (symbols === null)
            return;

        for (const symbol of symbols)
            addObjcSymbols(symbol!, classes, categories);
    }

    override addSymbols(classDeclaration: ClassDeclaration,
        classes: ClassDeclarations | null, _categories: ClassDeclarations | null): void {
        const _w = classDeclaration; // D `with (classDeclaration)` (06 §5)
        if (_w.classKind === ClassKind.objc && !_w.objc.isExtern && !_w.objc.isMeta)
            classes!.push(classDeclaration); // D dereferences `classes` unchecked
    }

    override checkOffsetof(expression: Expression, aggregateDeclaration: AggregateDeclaration): void {
        if (aggregateDeclaration.classKind !== ClassKind.objc)
            return;

        const errorMessage = ds("no property `offsetof` for member `%s` of type " +
            "`%s`");

        const supplementalMessage = ds("`offsetof` is not available for members " +
            "of Objective-C classes. Please use the Objective-C runtime instead");

        error(expression.loc, errorMessage, expression.toChars(),
            expression.type!.toChars());
        errorSupplemental(expression.loc, supplementalMessage);
    }

    override checkTupleof(expression: Expression, type: TypeClass): void {
        if (type.sym!.classKind !== ClassKind.objc)
            return;

        // dmd/objc.d:870 — `error(expression.loc, "no property `
        error(expression.loc, ds("no property `tupleof` for type `%s`"), type.toChars());
        errorSupplemental(expression.loc, ds("`tupleof` is not available for members " +
            "of Objective-C classes. Please use the Objective-C runtime instead"));
    }

    // version(IN_LLVM): ON (objc.d:875)
    override setAsSwiftStub(cd: ClassDeclaration, sc: Scope): void {
        const count = this.declaredAsSwiftStubCount(cd, sc);
        cd.objc.isSwiftStub = count > 0;

        if (count > 1)
            // dmd/objc.d:882 — `can only declare a class as a swift stub once`
            error(cd.loc, ds("%s `%s` can only declare a class as a swift stub once"), cd.kind(), cd.toPrettyChars());
    }

    /// Returns: the number of times `cd` has been declared as optional.
    /// dmd/objc.d:886 — `private int declaredAsSwiftStubCount(ClassDeclaration cd, Scope* sc) const`
    private declaredAsSwiftStubCount(cd: ClassDeclaration, sc: Scope): number {
        let count = 0;

        // upcast cascade (02 §11.5): AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool)
        foreachUda(cd as unknown as Dsymbol, sc, (e: Expression): number => {
            if (e.isTypeExp() === null)
                return 0;

            const typeExp = e.isTypeExp()!;

            if (typeExp.type!.ty !== Tenum)
                return 0;

            // D `cast(TypeEnum) typeExp.type` — non-null: `ty == Tenum` was checked just above.
            const typeEnum = typeExp.type!.isTypeEnum()!;

            if (isCoreUda(typeEnum.sym!, Id.udaSwiftStub!))
                count++;

            return 0;
        });

        return count;
    }
}

/*
 * Creates and sets the metaclass on the given class/interface declaration.
 *
 * Will only be performed on regular Objective-C classes, not on metaclasses.
 *
 * Params:
 *  newMetaclass = a function that returns the metaclass to set. This should
 *      return the same type as `T`.
 *  classDeclaration = the class/interface declaration to set the metaclass on
 *
 * dmd/objc.d:922 — `private void setMetaclass(alias newMetaclass, T)(T classDeclaration, Scope* sc)`.
 * Monomorphized per instantiation (07 §3.4): this function is `T = ClassDeclaration`;
 * `setMetaclassInterfaceDeclaration` below is `T = InterfaceDeclaration`. The two bodies are the
 * one D template body and differ only in `T` and the folded `errorType`: an edit to one is an
 * edit to both. The `alias` parameter, bound in D to the calling method's nested function, is
 * passed as a function value (04 §4.4). The local `metaclass` names D's `objc.metaclass`, which
 * `newMetaclass` just assigned; TS cannot narrow the field itself.
 */
function setMetaclass(newMetaclass: (loc: Loc, metaBases: BaseClasses) => ClassDeclaration,
    classDeclaration: ClassDeclaration, sc: Scope | null): void {
    // resolved: static if (is(T == ClassDeclaration)) -> true (T = ClassDeclaration, objc.d:925)
    const errorType = "class";

    const _w = classDeclaration; // D `with (classDeclaration)` (06 §5)
    if (_w.classKind !== ClassKind.objc || _w.objc.isMeta || _w.objc.metaclass !== null)
        return;

    if (_w.objc.identifier === null)
        _w.objc.identifier = classDeclaration.ident;

    const metaBases: BaseClasses = new DArray<BaseClass | null>();

    for (const base of _w.baseclasses.opSlice()) {
        const baseCd = base!.sym;
        assert(baseCd !== null);

        if (baseCd.classKind === ClassKind.objc) {
            assert(baseCd.objc.metaclass !== null);
            assert(baseCd.objc.metaclass.objc.isMeta);
            assert(baseCd.objc.metaclass.type!.ty === Tclass);

            const metaBase = new BaseClass(baseCd.objc.metaclass.type!);
            metaBase.sym = baseCd.objc.metaclass;
            metaBases.push(metaBase);
        } else {
            // dmd/objc.d:957 — `" ~ errorType ~ " for an Objective-C " ~`
            error(classDeclaration.loc, ds("%s `%s` base " + errorType + " for an Objective-C " +
                errorType + " must be `extern (Objective-C)`"),
                classDeclaration.kind(), classDeclaration.toPrettyChars());
        }
    }

    const metaclass = newMetaclass(_w.loc, metaBases); // D `objc.metaclass = newMetaclass(loc, metaBases);`
    _w.objc.metaclass = metaclass;
    metaclass.storage_class = (metaclass.storage_class | STC.static_) as STC; // STC brand re-applied (02 §4.2)
    metaclass.classKind = ClassKind.objc;
    metaclass.objc.isMeta = true;
    metaclass.objc.isExtern = _w.objc.isExtern;
    metaclass.objc.identifier = _w.objc.identifier;

    if (_w.baseClass !== null)
        metaclass.baseClass = _w.baseClass.objc.metaclass;

    // upcast cascades (02 §11.5): AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool)
    _w.members!.push(metaclass as unknown as Dsymbol);
    addMember(metaclass as unknown as Dsymbol, sc, classDeclaration as unknown as ScopeDsymbol);

    metaclass.members = new DArray<Dsymbol | null>();
    dsymbolSemantic(metaclass as unknown as Dsymbol, sc);
}

/// `setMetaclass!(newMetaclass, InterfaceDeclaration)` — the `T = InterfaceDeclaration` instantiation
/// of the dmd/objc.d:922 template; see `setMetaclass` above.
function setMetaclassInterfaceDeclaration(newMetaclass: (loc: Loc, metaBases: BaseClasses) => InterfaceDeclaration,
    classDeclaration: InterfaceDeclaration, sc: Scope | null): void {
    // resolved: static if (is(T == ClassDeclaration)) -> false (T = InterfaceDeclaration, objc.d:925)
    const errorType = "interface";

    const _w = classDeclaration; // D `with (classDeclaration)` (06 §5)
    if (_w.classKind !== ClassKind.objc || _w.objc.isMeta || _w.objc.metaclass !== null)
        return;

    if (_w.objc.identifier === null)
        _w.objc.identifier = classDeclaration.ident;

    const metaBases: BaseClasses = new DArray<BaseClass | null>();

    for (const base of _w.baseclasses.opSlice()) {
        const baseCd = base!.sym;
        assert(baseCd !== null);

        if (baseCd.classKind === ClassKind.objc) {
            assert(baseCd.objc.metaclass !== null);
            assert(baseCd.objc.metaclass.objc.isMeta);
            assert(baseCd.objc.metaclass.type!.ty === Tclass);

            const metaBase = new BaseClass(baseCd.objc.metaclass.type!);
            metaBase.sym = baseCd.objc.metaclass;
            metaBases.push(metaBase);
        } else {
            // dmd/objc.d:957 — `" ~ errorType ~ " for an Objective-C " ~`
            error(classDeclaration.loc, ds("%s `%s` base " + errorType + " for an Objective-C " +
                errorType + " must be `extern (Objective-C)`"),
                classDeclaration.kind(), classDeclaration.toPrettyChars());
        }
    }

    const metaclass = newMetaclass(_w.loc, metaBases); // D `objc.metaclass = newMetaclass(loc, metaBases);`
    _w.objc.metaclass = metaclass;
    metaclass.storage_class = (metaclass.storage_class | STC.static_) as STC; // STC brand re-applied (02 §4.2)
    metaclass.classKind = ClassKind.objc;
    metaclass.objc.isMeta = true;
    metaclass.objc.isExtern = _w.objc.isExtern;
    metaclass.objc.identifier = _w.objc.identifier;

    if (_w.baseClass !== null)
        metaclass.baseClass = _w.baseClass.objc.metaclass;

    // upcast cascades (02 §11.5): AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool)
    _w.members!.push(metaclass as unknown as Dsymbol);
    addMember(metaclass as unknown as Dsymbol, sc, classDeclaration as unknown as ScopeDsymbol);

    metaclass.members = new DArray<Dsymbol | null>();
    dsymbolSemantic(metaclass as unknown as Dsymbol, sc);
}

/// dmd/objc.d:980 — `private Identifier createMetaclassIdentifier(ClassDeclaration classDeclaration)`.
/// `class_<ident>_Meta`, made unique by `generateAnonymousId` (ldc2 -vcg-ast: `__anonclass_C_Meta4`).
function createMetaclassIdentifier(classDeclaration: ClassDeclaration): Identifier {
    const name = dsConcat(ds("class_"), classDeclaration.ident!.toString(), ds("_Meta"));
    return Identifier.generateAnonymousId(name);
}
