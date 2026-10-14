/**
 * Struct and union declarations.
 *
 * Ported 1:1 from dmd/dstruct.d (module dmd.dstruct), LDC 1.43.0-beta1 / DMD 2.113.
 *
 * Specification: https://dlang.org/spec/struct.html
 *
 * Copyright:   Copyright (C) 1999-2026 by The D Language Foundation, All Rights Reserved
 * Authors:     Walter Bright
 * License:     Boost License 1.0
 *
 * dropped: `import core.stdc.stdio;` (dstruct.d:16) — the import is unused: `printf`/`stdio` occur
 *   nowhere else in the file (verified on 1.43-beta1: `grep -n 'printf\|stdio' dmd/dstruct.d` hits
 *   line 16 and nothing else, in code or comment). `core.*` is a runtime shim, never a ported
 *   module (01 §3.7).
 */

import { AggregateDeclaration } from "./aggregate.js";
import { Array as Array_ } from "./root/array.js"; // value: `postblits` begins as an empty Array!FuncDeclaration
import { bitFieldGet, bitFieldSet } from "./common/bitfields.js";
import { DSYM } from "./dsymbol.js";
import { Id } from "./id.js";
import { Module } from "./dmodule.js";
import { TypeStruct } from "./mtype.js";
import { ThreeState, structalign_t } from "./astenums.js"; // value: enum member + the ctor's fresh value struct
import { assert } from "../assert.js";
import { ds } from "../dstring.js";
import type { DString } from "../dstring.js";
import type { FuncDeclarations } from "./arraytypes.js";
import type { Dsymbol } from "./dsymbol.js";
import type { FuncDeclaration } from "./func.js";
import type { Identifier } from "./identifier.js";
import type { Loc } from "./location.js";
import type { Type, TypeTuple } from "./mtype.js";
import type { Visitor } from "./visitor/index.js";

// dmd/dstruct.d:30 — `enum StructFlags : int` (<=32-bit base -> TS numeric enum, 02 §4.2).
export enum StructFlags {
    none        = 0x0,
    hasPointers = 0x1, // NB: should use noPointers as in ClassFlags
}

/***********************************************************
 * All `struct` declarations are an instance of this.
 *
 * dmd/dstruct.d:39 — `extern (C++) class StructDeclaration : AggregateDeclaration`
 * (`extern (C++)` erased, 04 §8).
 */
// @ts-expect-error D static-method hiding (class static side, TS2417): StructDeclaration.create hides Dsymbol.create.
export class StructDeclaration extends AggregateDeclaration {
    // dmd/dstruct.d:41 — `FuncDeclarations postblits;`. An `Array!FuncDeclaration` VALUE struct that
    // D default-initializes empty; constructed empty here, AS the alias's element type (08 §3).
    postblits: FuncDeclarations = new Array_<FuncDeclaration | null>(); // Array of postblit functions
    // dmd/dstruct.d:42
    postblit: FuncDeclaration | null = null;   // aggregate postblit

    // dmd/dstruct.d:44-46
    xeq: FuncDeclaration | null = null;        // TypeInfo_Struct.xopEquals
    xcmp: FuncDeclaration | null = null;       // TypeInfo_Struct.xopCmp
    xhash: FuncDeclaration | null = null;      // TypeInfo_Struct.xtoHash
    // dmd/dstruct.d:47-48 — `extern (C++) __gshared FuncDeclaration xerreq/xerrcmp;`. `__gshared` is a
    // process-global slot -> a static field (01 §5); `extern (C++)` erases (04 §8).
    static xerreq: FuncDeclaration | null = null;   // object.xopEquals
    static xerrcmp: FuncDeclaration | null = null;  // object.xopCmp

    // ABI-specific type(s) if the struct can be passed in registers
    // dmd/dstruct.d:51 — `TypeTuple argTypes;` (class reference -> nullable, .init = null; 09 §1.0).
    argTypes: TypeTuple | null = null;

    // dmd/dstruct.d:53 — `structalign_t alignment;`. A VALUE struct whose D default-init is
    // `value == 0` (== isUnknown); each instance gets its own fresh object (03 §6.4).
    alignment: structalign_t = new structalign_t(); // alignment applied outside of the struct
    // dmd/dstruct.d:54 — `ThreeState ispod;`. A named enum's `.init` is its FIRST member (09 §1.0).
    ispod: ThreeState = ThreeState.none;       // if struct is POD

    // -----------------------------------------------------------------------------------------
    // `bool` fields that are compacted into bit fields in a string mixin.
    //
    // resolved: `private extern (D) static struct BitFields` (dstruct.d:57-78) +
    //   `mixin(generateBitFields!(BitFields, ushort))` (dstruct.d:80-81). The CT string-mixin
    //   generator DISAPPEARS at translation time (07 §5, common/bitfields.ts): what it emits for
    //   this site is a `private ushort bitFields = 0;` storage word plus one getter/setter pair per
    //   member, each doing `(bitFields >>> shift) & mask` / `bitFields &= ~(mask << shift);
    //   bitFields |= v << shift` (bitfields.d:91-98, the live `else` branch — `Has_Bitfields` and
    //   `Debugger_friendly` are both OFF per _config.md §1).
    //
    // resolved: `version (IN_LLVM) {} else { bool requestTypeInfo; }` (dstruct.d:71-77) -> the
    //   `else` is DEAD (IN_LLVM is ON, _config.md §1), so `requestTypeInfo` is NOT a member of
    //   `BitFields` here and takes no bit. The 12 live members therefore occupy bits 0..11 of the
    //   `ushort` word, one bit each (`bool.max | 1` -> bitSize 1), in declaration order:
    //     0 zeroInit, 1 hasIdentityAssign, 2 hasBlitAssign, 3 hasIdentityEquals, 4 hasNoFields,
    //     5 hasCopyCtor, 6 hasMoveCtor, 7 hasPointerField, 8 hasVoidInitPointers,
    //     9 hasUnsafeBitpatterns, 10 hasFieldWithInvariant, 11 computedTypeProperties.
    //   Initial word value is 0 (`BitFields.init` is all-`false`).
    //
    // The packed word is KEPT rather than flattened to plain booleans: it is the shape the mixin
    // emits, and keeping it makes the bit assignment auditable against the D declaration order.
    //
    // Visibility: common/bitfields.d:119 emits the storage word `private`, and D `private` is
    // MODULE-scoped (01 §2.5), so the question is whether anything in dstruct.d reaches it from
    // module scope. Nothing does: dstruct.d has no `unittest{}` block (`grep -c '^unittest'
    // dmd/dstruct.d` = 0) and no sibling module-level function (its only top-level declarations are
    // `StructFlags`, `StructDeclaration` and `UnionDeclaration`); the word is touched by nothing but
    // the generated accessors below. That is 01 §2.5's "touched only from within its own class" row
    // — and 10 §1.7's "neither use" case — so TS `private` is the faithful emission, the same call
    // as `Declaration.bitFields` / `VarDeclaration.varBitFields` (declaration.ts:162/:530).
    //
    // Consequence for the co-located tests (10 §1.9 — tests adapt to the code, never the reverse):
    // the bit INDEX a member occupies is not observable through the public surface, exactly as it
    // is not in D. The pins therefore assert read-back and member independence; the bit layout is
    // audited HERE, against the D declaration order, not through the private word.
    // Numeric domain: `ushort` is <= 32-bit -> `number` (09 §0/§1).
    // -----------------------------------------------------------------------------------------
    private bitFields = 0; // D `private ushort bitFields = 0;` (generated storage word)

    get zeroInit(): boolean { return bitFieldGet(this.bitFields, 0, 0x1) !== 0; }              // !=0 if initialize with 0 fill
    set zeroInit(v: boolean) { this.bitFields = bitFieldSet(this.bitFields, 0, 0x1, v ? 1 : 0); }
    get hasIdentityAssign(): boolean { return bitFieldGet(this.bitFields, 1, 0x1) !== 0; }     // true if has identity opAssign
    set hasIdentityAssign(v: boolean) { this.bitFields = bitFieldSet(this.bitFields, 1, 0x1, v ? 1 : 0); }
    get hasBlitAssign(): boolean { return bitFieldGet(this.bitFields, 2, 0x1) !== 0; }         // true if opAssign is a blit
    set hasBlitAssign(v: boolean) { this.bitFields = bitFieldSet(this.bitFields, 2, 0x1, v ? 1 : 0); }
    get hasIdentityEquals(): boolean { return bitFieldGet(this.bitFields, 3, 0x1) !== 0; }     // true if has identity opEquals
    set hasIdentityEquals(v: boolean) { this.bitFields = bitFieldSet(this.bitFields, 3, 0x1, v ? 1 : 0); }
    get hasNoFields(): boolean { return bitFieldGet(this.bitFields, 4, 0x1) !== 0; }           // has no fields
    set hasNoFields(v: boolean) { this.bitFields = bitFieldSet(this.bitFields, 4, 0x1, v ? 1 : 0); }
    get hasCopyCtor(): boolean { return bitFieldGet(this.bitFields, 5, 0x1) !== 0; }           // copy constructor
    set hasCopyCtor(v: boolean) { this.bitFields = bitFieldSet(this.bitFields, 5, 0x1, v ? 1 : 0); }
    get hasMoveCtor(): boolean { return bitFieldGet(this.bitFields, 6, 0x1) !== 0; }           // move constructor
    set hasMoveCtor(v: boolean) { this.bitFields = bitFieldSet(this.bitFields, 6, 0x1, v ? 1 : 0); }
    get hasPointerField(): boolean { return bitFieldGet(this.bitFields, 7, 0x1) !== 0; }       // members with indirections
    set hasPointerField(v: boolean) { this.bitFields = bitFieldSet(this.bitFields, 7, 0x1, v ? 1 : 0); }
    get hasVoidInitPointers(): boolean { return bitFieldGet(this.bitFields, 8, 0x1) !== 0; }   // void-initialized unsafe fields
    set hasVoidInitPointers(v: boolean) { this.bitFields = bitFieldSet(this.bitFields, 8, 0x1, v ? 1 : 0); }
    get hasUnsafeBitpatterns(): boolean { return bitFieldGet(this.bitFields, 9, 0x1) !== 0; }  // @system members, pointers, bool
    set hasUnsafeBitpatterns(v: boolean) { this.bitFields = bitFieldSet(this.bitFields, 9, 0x1, v ? 1 : 0); }
    get hasFieldWithInvariant(): boolean { return bitFieldGet(this.bitFields, 10, 0x1) !== 0; }// invariants
    set hasFieldWithInvariant(v: boolean) { this.bitFields = bitFieldSet(this.bitFields, 10, 0x1, v ? 1 : 0); }
    get computedTypeProperties(): boolean { return bitFieldGet(this.bitFields, 11, 0x1) !== 0; }// the above 3 fields are computed
    set computedTypeProperties(v: boolean) { this.bitFields = bitFieldSet(this.bitFields, 11, 0x1, v ? 1 : 0); }

    /**
     * dmd/dstruct.d:83 — `extern (D) this(Loc loc, Identifier id, bool inObject)`.
     *
     * Preconditions: none — `id` may be null (an anonymous struct), exactly as in D.
     * Postconditions: `dsym == DSYM.structDeclaration`, `type` is a fresh forward-reference
     *   `TypeStruct` pointing back at this declaration, `ispod == ThreeState.none`.
     * `inObject` is true only while parsing `object.d`; it is the hook that captures the one
     *   `ModuleInfo` declaration into the process-global `Module.moduleinfo`.
     * `loc` is passed on by reference (no `.copy()`): `Loc` is an alias-safe register type (03 §9.1).
     */
    constructor(loc: Loc, id: Identifier | null, inObject: boolean) {
        super(loc, id);
        this.dsym = DSYM.structDeclaration;
        this.zeroInit = false; // assume false until we do semantic processing
        this.ispod = ThreeState.none;
        // For forward references
        this.type = new TypeStruct(this);

        if (inObject) {
            // dmd/dstruct.d:94 — `if (id == Id.ModuleInfo && !Module.moduleinfo)`.
            // `==` on class references is identity -> `===` (05 §2); `!Module.moduleinfo` is a
            // nullable-reference truthiness test -> explicit `=== null` (06 §2.7).
            if (id === Id.ModuleInfo && Module.moduleinfo === null)
                Module.moduleinfo = this;
        }
    }

    /// dmd/dstruct.d:99 — `static StructDeclaration create(Loc loc, Identifier id, bool inObject)`.
    /// The C++-callable allocation helper; identical to the constructor.
    static override create(loc: Loc, id: Identifier | null, inObject: boolean): StructDeclaration {
        return new StructDeclaration(loc, id, inObject);
    }

    /**
     * dmd/dstruct.d:104 — `override StructDeclaration syntaxCopy(Dsymbol s)`.
     *
     * Reuses `s` when the caller supplied a pre-allocated destination (a subclass already built
     * it), otherwise allocates a fresh `StructDeclaration`; then delegates to the base
     * `ScopeDsymbol.syntaxCopy` to copy the members in. D's qualified call
     * `ScopeDsymbol.syntaxCopy(sd)` is non-virtual, and `AggregateDeclaration` does not override
     * `syntaxCopy`, so `super.syntaxCopy` reaches exactly that implementation.
     * `cast(StructDeclaration)s` is the unchecked downcast idiom -> `isStructDeclaration()!`
     * (02 §2): at this site `s` is known to be a StructDeclaration.
     */
    override syntaxCopy(s: Dsymbol | null): StructDeclaration {
        const sd: StructDeclaration =
            s !== null ? s.isStructDeclaration()!
                       : new StructDeclaration(this.loc, this.ident, false);
        super.syntaxCopy(sd);
        return sd;
    }

    /// dmd/dstruct.d:113 — `override const(char)* kind() const`.
    override kind(): DString {
        return ds("struct");
    }

    /***************************************
     * dmd/dstruct.d:123 — `final bool hasCopyConstruction()` (`final` erased, 04 §8).
     *
     * Determine if struct has copy construction (copy constructor or postblit)
     * Returns:
     *     true if struct has copy construction
     */
    hasCopyConstruction(): boolean {
        // dmd/dstruct.d:125 — `return postblit || hasCopyCtor;`. `postblit` is a nullable class
        // reference -> explicit `!== null` (06 §2.7); the `||` result feeds a `bool` slot, so both
        // operands are made boolean (09 §9).
        return this.postblit !== null || this.hasCopyCtor;
    }

    /// dmd/dstruct.d:128 — `override void accept(Visitor v) { v.visit(this); }`.
    /// The node dispatches to its OWN named visitor method (13 §2).
    override accept(v: Visitor): void {
        v.visitStructDeclaration(this);
    }

    /// dmd/dstruct.d:133 — `final uint numArgTypes() const`.
    /// Number of ABI register-passing types, or 0 when the layout has not been computed.
    numArgTypes(): number {
        // dmd/dstruct.d:135 — `argTypes && argTypes.arguments ? cast(uint) argTypes.arguments.length : 0`.
        // Both operands are nullable references -> explicit `!== null` (06 §2.7); `.length` is
        // already the `number` domain, so `cast(uint)` is a no-op (09 §1.1).
        return this.argTypes !== null && this.argTypes.arguments !== null
            ? this.argTypes.arguments.length
            : 0;
    }

    /// dmd/dstruct.d:138 — `final Type argType(uint index)`.
    /// The `index`-th ABI register-passing type, or null when `index` is out of range.
    argType(index: number): Type | null {
        // dmd/dstruct.d:140 — `index < numArgTypes() ? (*argTypes.arguments)[index].type : null`.
        // `(*p)[i]` is the Array opIndex rewrite (05 §7); the slots are `Parameter | null` (08 §3)
        // and D dereferences unconditionally, so `!` marks the exact site where D would fault.
        return index < this.numArgTypes() ? this.argTypes!.arguments!.opIndex(index)!.type : null;
    }
}


/***********************************************************
 * Unions are a variation on structs.
 *
 * dmd/dstruct.d:148 — `extern (C++) final class UnionDeclaration : StructDeclaration`
 * (`extern (C++)` and `final` both erased, 04 §8).
 */
export class UnionDeclaration extends StructDeclaration {
    /// dmd/dstruct.d:150 — `extern (D) this(Loc loc, Identifier id)`.
    /// A union is a StructDeclaration constructed with `inObject == false` (never `object.ModuleInfo`)
    /// and re-tagged `DSYM.unionDeclaration`.
    constructor(loc: Loc, id: Identifier | null) {
        super(loc, id, false);
        this.dsym = DSYM.unionDeclaration;
    }

    /**
     * dmd/dstruct.d:156 — `override UnionDeclaration syntaxCopy(Dsymbol s)`.
     *
     * Preconditions: `s` is null — a UnionDeclaration is never copied into a caller-supplied
     * destination (the D `assert(!s)` is ported verbatim, 10 §2).
     */
    override syntaxCopy(s: Dsymbol | null): UnionDeclaration {
        // dmd/dstruct.d:158 — `assert(!s);` (nullable-reference test, 06 §2.7).
        assert(s === null);
        const ud = new UnionDeclaration(this.loc, this.ident);
        // dmd/dstruct.d:160 — `StructDeclaration.syntaxCopy(ud)`: the qualified (non-virtual) call
        // to the base implementation == `super.syntaxCopy` here.
        super.syntaxCopy(ud);
        return ud;
    }

    /// dmd/dstruct.d:164 — `override const(char)* kind() const`.
    override kind(): DString {
        return ds("union");
    }

    /// dmd/dstruct.d:169 — `override void accept(Visitor v) { v.visit(this); }` (13 §2).
    override accept(v: Visitor): void {
        v.visitUnionDeclaration(this);
    }
}
