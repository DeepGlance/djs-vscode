// Ported from dmd/func.d (module dmd.func).
//
// Defines a function declaration. Includes: function/delegate literals, function aliases,
// (static/shared) constructors/destructors/post-blits, `invariant`, `unittest`.
//
// Copyright: Copyright (C) 1999-2026 by The D Language Foundation, All Rights Reserved.
// Authors:   Walter Bright.  License: Boost License 1.0.
//
// ---------------------------------------------------------------------------------------------
// FILE-LEVEL RESOLUTIONS (07-compile-time.md audit convention)
// ---------------------------------------------------------------------------------------------
// resolved: version (IN_LLVM) at func.d:253, :282, :447 -> ON (_config.md §1) — the guarded members
//   (`priority`, `allowInlining`, `neverInline`, `emitInstrumentation`, `asmLabels`) and the
//   `f.mangleOverride = mangleOverride;` line in `syntaxCopy` are KEPT.
// resolved: version (IN_LLVM) {} else { void* shidden; } at func.d:310-313 -> the `else` branch is
//   OFF, so `shidden` is DROPPED (a codegen-payload pointer with no frontend reader).
// resolved: mixin FuncDeclarationExtra; (func.d:319) -> expands to NOTHING for LDC
//   (targetcompiler.d:80 `mixin template FuncDeclarationExtra() { }`); the populated MARS form
//   (`alignSectionVars`/`salignSection`) is OFF. No members added.
// resolved: version (none) at func.d:540 -> OFF; the `else` branch of `isWinMain` is emitted.
// resolved: version (none) at func.d:695 -> OFF; the `printf` debug block inside `isFinalFunc` is
//   dropped (no `else` branch exists).
// dropped: `private struct FUNCFLAG` (func.d:124-159) — it is a COMPILE-TIME descriptor whose only
//   consumer is `mixin(generateBitFields!(FUNCFLAG, uint))` (func.d:359). Per 07 §5/§6 the mixin is
//   resolved at translation time and the struct itself emits nothing; its 30 `bool` members become
//   the packed word + accessors below (see the FUNCFLAG note on `funcBitFields`).
// dropped: `import core.stdc.stdio` / `core.stdc.string` (func.d:21-22) — runtime C headers, only
//   reached by the commented-out `printf` traces and the dropped `version(none)` block (01 §3.7).

import {
    bitFieldGet,
    bitFieldSet,
} from "./common/bitfields.js";
import {
    LINK,
    MODFlags,
    PINLINE,
    STC,
    VarArg,
    type StorageClass,
} from "./astenums.js";
// `Declaration` is the `extends` base — a runtime value, so a value import (safe across the core
// SCC cycle: `extends` resolves post-load, 01 §4.1).
import { Declaration } from "./declaration.js";
// Value imports used inside constructors/method bodies (all resolve post-load, 01 §4.3):
// `ds` builds a DString from an ASCII literal, `assert`/`assertUnreachable` are the runtime helpers
// (10 §2), `Visibility`/`DSYM`/`PASS` are runtime enums/classes, `DsymbolTable` is `new`-ed by
// `searchLabel`, `Dsymbol` is needed for the base-skipping `toPrettyChars` call in
// FuncLiteralDeclaration, `Id`/`Identifier` supply interned identifiers.
import { ds } from "../dstring.js";
import { assert, assertUnreachable } from "../assert.js";
import { Dsymbol, DsymbolTable, DSYM, PASS, Visibility } from "./dsymbol.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
// `Loc` is value-imported for `Loc.initial` (NewDeclaration ctor) and `new Loc()` (the
// AttributeViolation default-init). location.js has no runtime back-edge into the func/declaration/
// dsymbol SCC, so this is cycle-safe.
import { Loc } from "./location.js";
// `TOK` is value-imported for the `tok === TOK.delegate_`/`TOK.function_` comparisons.
import { TOK } from "./tokens.js";
// `OutBuffer` is `new`-ed inside AttributeViolation's format ctor (method-body use, cycle-safe).
import { OutBuffer } from "./common/outbuffer.js";
// `ParameterList` is `new`-ed by `getParameterList` (method-body use, cycle-safe: mtype.ts has no
// runtime import of func.ts).
import { ParameterList } from "./mtype.js";
// `ObjcFuncDeclaration` is default-constructed as an inline value-struct member by the ctor.
// `objc()` is read only inside method bodies; it is non-null there because the driver runs `Objc._init()`
// at startup (main.d:445), hence `objc()!`.
import { ObjcFuncDeclaration, objc } from "./objc.js";
// The inline `Array!T` value members (`foverrides`/`closureVars`/`outerVars`/`siblingCallers`/
// `deferredNested`) start empty and must be built by the ctor.
import { Array as DArray } from "./root/array.js";
// `Statement` is value-imported for its static `arraySyntaxCopy` (used by syntaxCopy);
// `LabelDsymbol` is `new`-ed by `searchLabel`. statement.js has no runtime back-edge to func.js.
import { LabelDsymbol, Statement } from "./statement.js";
// hdrgen printers, called only inside method bodies (toFullSignature, AttributeViolation.fromFormat).
// Last value import (01 §4.8): hdrgen.js reaches mtype/dtemplate, so it must not be evaluated first.
import { functionToBufferWithIdent, rootObjectToErrMsg } from "./hdrgen.js";

// Cross-core type-only references (import type — erased, breaks the SCC load cycle, 01 §4.2/§4.5).
import type { DString } from "../dstring.js";
import type { RootObject } from "./rootobject.js";
import type { Type, TypeFunction } from "./mtype.js";
import type { VarDeclaration } from "./declaration.js";
import type { AggregateDeclaration } from "./aggregate.js";
import type { TemplateDeclaration } from "./dtemplate.js";
import type { BaseClass } from "./dclass.js";
import type { ConditionalStatement, ForeachStatement } from "./statement.js";
import type { Visitor } from "./visitor/index.js";
import type {
    Ensures,
    Expressions,
    FuncDeclarations,
    GotoStatements,
    Identifiers,
    ReturnStatements,
    Statements,
    VarDeclarations,
} from "./arraytypes.js";

/// Inline Status
/// dmd/func.d:45 — `enum ILS : ubyte` (ubyte base, <= 32 bits -> TS numeric enum, 02 §4.2).
export enum ILS {
    uninitialized,  /// not computed yet
    no,             /// cannot inline
    yes,            /// can inline
}

/// dmd/func.d:52 — `enum BUILTIN : ubyte`. `unknown = 255`, `unimp = 0`, then the named builtins
/// continuing from 1. The `// IN_LLVM:` llvm_* members are KEPT (we are LDC, _config.md §1).
export enum BUILTIN {
    unknown = 255,  /// not known if this is a builtin
    unimp = 0,      /// this is not a builtin
    gcc,            /// this is a GCC builtin
    llvm,           /// this is an LLVM builtin
    sin,
    cos,
    tan,
    sqrt,
    fabs,
    ldexp,
    log,
    log2,
    log10,
    exp,
    expm1,
    exp2,
    round,
    floor,
    ceil,
    trunc,
    copysign,
    pow,
    fmin,
    fmax,
    fma,
    isnan,
    isinfinity,
    isfinite,
    bsf,
    bsr,
    bswap,
    popcnt,
    yl2x,
    yl2xp1,
    toPrecFloat,
    toPrecDouble,
    toPrecReal,
    ctfeWrite,

    // IN_LLVM:
    llvm_sin,
    llvm_cos,
    llvm_sqrt,
    llvm_exp,
    llvm_exp2,
    llvm_log,
    llvm_log2,
    llvm_log10,
    llvm_fabs,
    llvm_minnum,
    llvm_maxnum,
    llvm_floor,
    llvm_ceil,
    llvm_trunc,
    llvm_rint,
    llvm_nearbyint,
    llvm_round,
    llvm_lround,
    llvm_llround,
    llvm_lrint,
    llvm_llrint,
    llvm_fma,
    llvm_copysign,
    llvm_bswap,
    llvm_cttz,
    llvm_ctlz,
    llvm_ctpop,
    llvm_expect,
}

/***********************************************************
 * dmd/func.d:165 — `extern (C++) struct Ensure`.
 *
 * Tuple of result identifier (possibly null) and statement. This is used to store out contracts:
 * `out(id){ ensure }`.
 *
 * VALUE struct (02 §2 / 03): both fields are class references, so `.copy()` shares them (03 §2).
 * `Ensures` (`arraytypes.d`) holds these BY VALUE — the alias is `Array<Ensure>`, not
 * `Array<Ensure | null>` (08 §3).
 */
export class Ensure {
    id: Identifier | null;
    ensure: Statement | null;

    /// D declares no constructor, so `Ensure(id, ensure)` is the implicit field-wise literal and
    /// `Ensure e;` default-initializes both fields to `null` (class-ref `.init`, 09 §1.0). One
    /// constructor covers both births (03 §6.4).
    constructor(id: Identifier | null = null, ensure: Statement | null = null) {
        this.id = id;
        this.ensure = ensure;
    }

    /// func.d:170 — `Ensure syntaxCopy()`. Fresh `Ensure` sharing `id`, deep-copying the statement.
    /// `ensure.syntaxCopy()` dereferences unconditionally in D, so the port faults at the same site
    /// (02 §10.1 `!` discipline).
    syntaxCopy(): Ensure {
        return new Ensure(this.id, this.ensure!.syntaxCopy()); // construction, not a copy point
    }

    /*****************************************
     * func.d:178 — `static Ensures* arraySyntaxCopy(Ensures* a)`.
     * Do syntax copy of an array of Ensure's: a fresh container (shallow `Array.copy()`), each slot
     * replaced by the element's `syntaxCopy()`.
     */
    static arraySyntaxCopy(a: Ensures | null): Ensures | null {
        if (a === null)
            return null;

        const b: Ensures = a.copy();
        // D `foreach (i, e; *a)` over a container VALUE with an index -> indexed `for` (06 §1.6);
        // `a.opIndex(i)` is read only to call `syntaxCopy()` on it, so the element copy of the
        // `foreach` value variable is elided (03 §9: the value is never mutated). The store into
        // `b[i]` takes a fresh rvalue, so no store-copy either (03 §9).
        for (let i = 0; i < a.length; i++)
            b.opIndexAssign(a.opIndex(i).syntaxCopy(), i);
        return b;
    }

    /// Value-struct copy (03 §2): both fields are class references -> share.
    copy(): Ensure {
        return new Ensure(this.id, this.ensure);
    }
}

/***********************************************************
 * dmd/func.d:195 — `private struct ContractInfo`.
 *
 * Most functions don't have contracts, so save memory by grouping this information into a separate
 * struct. VALUE struct; every field is a class reference or a container reference -> shared on copy
 * (03 §2). D `private` is MODULE-scoped and `FuncDeclaration` (same module) holds and allocates it,
 * so the class is emitted without `export` — module-local, exactly like D (01 §2.5).
 */
class ContractInfo {
    frequires: Statements | null = null;            /// in contracts
    fensures: Ensures | null = null;                /// out contracts
    frequire: Statement | null = null;              /// lowered in contract
    fensure: Statement | null = null;               /// lowered out contract
    fdrequire: FuncDeclaration | null = null;       /// function that does the in contract
    fdensure: FuncDeclaration | null = null;        /// function that does the out contract
    fdrequireParams: Expressions | null = null;     /// argument list for __require
    fdensureParams: Expressions | null = null;      /// argument list for __ensure

    copy(): ContractInfo {
        const c = new ContractInfo();
        c.frequires = this.frequires;
        c.fensures = this.fensures;
        c.frequire = this.frequire;
        c.fensure = this.fensure;
        c.fdrequire = this.fdrequire;
        c.fdensure = this.fdensure;
        c.fdrequireParams = this.fdrequireParams;
        c.fdensureParams = this.fdensureParams;
        return c;
    }
}

/// dmd/func.d:208 — `extern(D) struct ParametersDFAInfo`.
/// Information for data flow analysis regarding parameters. VALUE struct (03): the two inline
/// `ParameterDFAInfo` members are nested value structs (recurse on copy); `parameters` is a D slice
/// (`ParameterDFAInfo[]`), whose `.init` is `null` — a null slice, not an empty one (09 §1.0,
/// 06 §2.8) — and whose copy SHARES the backing store (03 §2).
export class ParametersDFAInfo {
    thisPointer: ParameterDFAInfo;
    returnValue: ParameterDFAInfo;
    parameters: ParameterDFAInfo[] | null = null;

    constructor() {
        this.thisPointer = new ParameterDFAInfo();
        this.returnValue = new ParameterDFAInfo();
    }

    copy(): ParametersDFAInfo {
        const c = new ParametersDFAInfo();
        c.thisPointer = this.thisPointer.copy();   // nested value struct: recurse
        c.returnValue = this.returnValue.copy();   // nested value struct: recurse
        c.parameters = this.parameters;            // D slice: shares the backing store
        return c;
    }
}

/// dmd/func.d:216 — `extern(D) struct ParameterDFAInfo`.
/// Information for data flow analysis per parameter. VALUE struct; all fields primitive/enum.
export class ParameterDFAInfo {
    /// Parameter id: -1 this, -2 return, otherwise it is FuncDeclaration.parameters index
    parameterId: number = 0;

    /// Is the parameter non-null upon input, only applies to pointers.
    /// `.init` of a named enum is its FIRST member (09 §1.0) -> `Fact.Unspecified`.
    notNullIn: ParameterDFAInfo.Fact = ParameterDFAInfo.Fact.Unspecified;
    /// Is the parameter non-null, applies only for by-ref parameters that are pointers.
    notNullOut: ParameterDFAInfo.Fact = ParameterDFAInfo.Fact.Unspecified;

    /// Was the attributes for this parameter specified by the user?
    specifiedByUser: boolean = false;

    copy(): ParameterDFAInfo {
        const c = new ParameterDFAInfo();
        c.parameterId = this.parameterId;
        c.notNullIn = this.notNullIn;
        c.notNullOut = this.notNullOut;
        c.specifiedByUser = this.specifiedByUser;
        return c;
    }
}

/// dmd/func.d:230 — `enum Fact : ubyte` declared INSIDE `struct ParameterDFAInfo`. TS has no enum
/// in a class body, so it lives in a namespace that merges with the class above — which keeps
/// `ParameterDFAInfo.Fact.Guaranteed` spelled exactly as D spells it (same shape as
/// `Visibility.Kind`, dsymbol.ts).
export namespace ParameterDFAInfo {
    /// Given a property, has it been specificed and is it guaranteed?
    export enum Fact {
        ///
        Unspecified,
        ///
        NotGuaranteed,
        ///
        Guaranteed,
    }
}

/***********************************************************
 * dmd/func.d:243 — `extern (C++) class FuncDeclaration : Declaration`.
 *
 * A function/delegate declaration — the base of constructors, destructors, literals, invariants,
 * unittests and allocators.
 *
 * FUNCFLAG BIT-FIELD GROUP (func.d:124-159 + :359, `mixin(generateBitFields!(FUNCFLAG, uint))`):
 * the `FUNCFLAG` struct's 30 `bool` members are packed into ONE `uint`-width unsigned word and
 * exposed via shift/mask accessors. The PACKING IS OBSERVABLE — `saveFlags()` returns the word and
 * `restoreFlags()` writes it (func.d:607-616) — so the packed integer is preserved rather than
 * discarded (11 §3.6 criterion; the resolution is the one documented in common/bitfields.ts).
 * Declaration order = bit offset, 1 bit each (bits 0..29). Only `isNRVO = true` carries a non-zero
 * `.init`, at bit 12 -> the initial packed word is `1 << 12` = 4096.
 *
 * The D field generated by the mixin is named `bitFields`, but `Declaration` already emits a
 * TS-`private bitFields` for its own bit-field group (declaration.ts) and TypeScript forbids a
 * subclass from redeclaring a base class's private property. D's shadowing is therefore not
 * expressible; the word is named `funcBitFields` here — the ONE identifier in this file that
 * departs from verbatim D naming (01 §2), and only because the TS type system leaves no choice.
 */
// D's `static create` factories are NON-VIRTUAL and independent per class (dsymbol.d:397 vs
// func.d:396) — they merely share a name. TS models statics as an inherited "static side" and
// rejects the differing signature (TS2417, reported on the class line). Localized, audited
// suppression; the `static override create` member below keeps noImplicitOverride satisfied.
// @ts-expect-error D non-virtual static factory: FuncDeclaration.create signature differs from Dsymbol.create.
export class FuncDeclaration extends Declaration {
    fbody: Statement | null = null;                 /// function body

    foverrides!: FuncDeclarations;                  /// functions this function overrides

    /// contract information. D `private` is MODULE-scoped, so the de-privatizing trigger is
    /// module-level reachability in D (01 §2.5 / 10 §1.7): a sibling module-level function or the
    /// module's own `unittest{}` touching the member. func.d has neither — `contracts` is touched
    /// only from FuncDeclaration's own methods (`getContracts`, the 8 getters, the 8
    /// mixin-generated setters), and func.d's single unittest (:801) exercises MODMatchToBuffer
    /// only. The faithful emission is therefore TS `private`; func.test.ts observes the lazy
    /// allocation through the accessors instead (10 §1.9 — tests adapt to the code).
    private contracts: ContractInfo | null = null;

    mangleString: DString | null = null;            /// mangled symbol created from mangleExact()

    // version (IN_LLVM) — ON (_config.md §1). LDC pragma-driven frontend state (func.d:253-266).
    priority: number = 0;                           // uint

    // true if overridden with the pragma(LDC_allow_inline); statement
    allowInlining: boolean = false;

    // true if set with the pragma(LDC_never_inline); statement
    neverInline: boolean = false;

    // Whether to emit instrumentation code if -fprofile-instr-generate is specified,
    // the value is set with pragma(LDC_profile_instr, true|false)
    emitInstrumentation: boolean = true;

    vresult: VarDeclaration | null = null;          /// result variable for out contracts
    returnLabel: LabelDsymbol | null = null;        /// where the return goes

    /// cache for the potentially very expensive isTypeIsolated check. D `bool[size_t]` -> `Map`
    /// (02 §9); the key domain is `size_t` -> `number` (09 §1.1).
    isTypeIsolatedCache: Map<number, boolean> = new Map();

    // used to prevent symbols in different
    // scopes from having the same name
    localsymtab: DsymbolTable | null = null;
    vthis: VarDeclaration | null = null;            /// 'this' parameter (member and nested)
    v_arguments: VarDeclaration | null = null;      /// '_arguments' parameter

    v_argptr: VarDeclaration | null = null;         /// '_argptr' variable
    parameters: VarDeclarations | null = null;      /// Array of VarDeclaration's for parameters
    labtab: DsymbolTable | null = null;             /// statement label symbol table

    // version (IN_LLVM) — ON (func.d:282-285).
    asmLabels: Identifiers | null = null;           /// identifiers of labels defined in DMD-style inline assembly

    overnext: Dsymbol | null = null;                /// next in overload list
    overnext0: FuncDeclaration | null = null;       /// next in overload list (only used during IFTI)
    endloc!: Loc;                                   /// location of closing curly bracket (value struct)
    vtblIndex: number = -1;                         /// for member functions, index into vtbl[]

    inlineStatusStmt: ILS = ILS.uninitialized;
    inlineStatusExp: ILS = ILS.uninitialized;
    inlining: PINLINE = PINLINE.default_;

    inlineNest: number = 0;                         /// !=0 if nested inline

    fes: ForeachStatement | null = null;            /// if foreach body, this is the foreach
    interfaceVirtual: BaseClass | null = null;      /// if virtual, but only appears in base interface vtbl[]
    /** if !=NULL, then this is the type
    of the 'introducing' function
    this one is overriding
    */
    tintro: Type | null = null;

    storage_class2: STC = STC.none;                 /// storage class for template onemember's

    // Things that should really go into Scope

    nrvo_var: VarDeclaration | null = null;         /// variable to replace with shidden
    // dropped: `void* shidden;` (func.d:312) — the `version (IN_LLVM) {} else` branch is OFF.

    returns: ReturnStatements | null = null;

    gotos: GotoStatements | null = null;            /// Gotos with forward references

    // resolved: `mixin FuncDeclarationExtra;` (func.d:319) -> empty for LDC (targetcompiler.d:80).

    /// set if this is a known, builtin function we can evaluate at compile time
    builtin: BUILTIN = BUILTIN.unknown;

    /// set if someone took the address of this function
    tookAddressOf: number = 0;

    requiresClosure: boolean = false;               // this function needs a closure

    /** local variables in this function which are referenced by nested functions
     * (They'll get put into the "closure" for this function.)
     */
    closureVars!: VarDeclarations;

    /** Outer variables which are referenced by this nested function
     * (the inverse of closureVars)
     */
    outerVars!: VarDeclarations;

    // Most recent encountered `main` (`WinMain` or `DllMain`) function.
    // Track it to give error messages for multiple entrypoints.
    // D `__gshared` -> a class static (04 §8).
    static lastMain: FuncDeclaration | null = null;

    /// Sibling nested functions which called this one
    siblingCallers!: FuncDeclarations;

    inlinedNestedCallees: FuncDeclarations | null = null;

    /// In case of failed `@safe` inference, store the error that made the function `@system` for
    /// better diagnostics. `AttributeViolation*` is a pointer to a VALUE struct -> the object as a
    /// nullable reference, never copied (02 §10 case 2).
    safetyViolation: AttributeViolation | null = null;
    nogcViolation: AttributeViolation | null = null;
    pureViolation: AttributeViolation | null = null;
    nothrowViolation: AttributeViolation | null = null;

    parametersDFAInfo: ParametersDFAInfo | null = null;

    /// See the `FUNCFLAG` struct. Packed word for `mixin(generateBitFields!(FUNCFLAG, uint))`
    /// (func.d:357-359). `uint` storage -> `number` domain, held unsigned (09 §0/§1).
    /// Init = isNRVO (bit 12) -> 4096. D names the generated field `bitFields`; see the class
    /// doc-comment for why it must be renamed here.
    funcBitFields: number = 1 << 12;

    /**
     * Data for a function declaration that is needed for the Objective-C
     * integration.
     */
    objc!: ObjcFuncDeclaration;

    /**
     * No D counterpart: the `version`, `debug` and `static if` statements of this function's body that its analysis
     * decided, for the djs host's queries (src/query.ts, the inactive ranges; 10 §4.7, "Queries"). Semantic replaces
     * a ConditionalStatement by the branch it chose (dmd/statementsem.d:1769, and its `flatten` at :4893), so the
     * analysed body keeps no trace of the condition; this list keeps the statements, whose `condition.inc` says what
     * was chosen. Appended by statementsem.ts where it decides one (null until the first), read by nothing else of
     * the frontend; a template instance's copy of the function has its own.
     */
    djsConditionals: ConditionalStatement[] | null = null;

    // func.d:367 — `extern (D) this(Loc loc, Loc endloc, Identifier ident, STC storage_class,
    //                               Type type, bool noreturn = false)`.
    constructor(loc: Loc, endloc: Loc, ident: Identifier | null, storage_class: STC, type: Type | null,
                noreturn: boolean = false) {
        super(DSYM.funcDeclaration, loc, ident);
        // D's inline `Array!T` value members start empty; the JS port must build them (the `!`
        // declared fields are not auto-constructed). Constructed AS the arraytypes alias (08 §3).
        this.foverrides = new DArray<FuncDeclaration | null>();
        this.closureVars = new DArray<VarDeclaration | null>();
        this.outerVars = new DArray<VarDeclaration | null>();
        this.siblingCallers = new DArray<FuncDeclaration | null>();
        this.objc = new ObjcFuncDeclaration(); // inline value-struct member, default-constructed
        //.printf("FuncDeclaration(id = '%s', type = %s)\n", ident.toChars(), type.toChars());
        //.printf("storage_class = x%llx\n", storage_class);
        this.storage_class = storage_class;
        this.type = type;
        if (type !== null) {
            // Normalize storage_class, because function-type related attributes
            // are already set in the 'type' in parsing phase.
            this.storage_class = (this.storage_class & ~(STC.TYPECTOR | STC.FUNCATTR)) as STC;
        }
        this.endloc = endloc.copy(); // value struct stored into a class field (03 §1 #5)
        if (noreturn)
            this.noreturn = true;

        /* The type given for "infer the return type" is a TypeFunction with
         * NULL for the return type.
         */
        if (type !== null) {
            const tf = type.isTypeFunction();
            if (tf !== null)
                this.inferRetType = tf.next === null;
            else
                assertUnreachable(); // func.d:392 — `assert(0); // unreachable`
        }
    }

    // func.d:396 — `static FuncDeclaration create(Loc, Loc, Identifier, StorageClass, Type, bool)`.
    // `static override`: shadows the inherited `Dsymbol.create` (D static-factory hiding).
    static override create(loc: Loc, endloc: Loc, id: Identifier, storage_class: StorageClass,
                           type: Type | null, noreturn: boolean = false): FuncDeclaration {
        return new FuncDeclaration(loc, endloc, id, storage_class as STC, type, noreturn);
    }

    // ── FUNCFLAG accessors (funcBitFields, 1 bit each; offset = FUNCFLAG declaration order) ─────
    // Generated by `mixin(generateBitFields!(FUNCFLAG, uint))` (func.d:359), resolved per 07 §5.
    get purityInprocess(): boolean { return bitFieldGet(this.funcBitFields, 0, 0x1) !== 0; }
    set purityInprocess(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 0, 0x1, v ? 1 : 0); }
    get safetyInprocess(): boolean { return bitFieldGet(this.funcBitFields, 1, 0x1) !== 0; }
    set safetyInprocess(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 1, 0x1, v ? 1 : 0); }
    get nothrowInprocess(): boolean { return bitFieldGet(this.funcBitFields, 2, 0x1) !== 0; }
    set nothrowInprocess(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 2, 0x1, v ? 1 : 0); }
    get nogcInprocess(): boolean { return bitFieldGet(this.funcBitFields, 3, 0x1) !== 0; }
    set nogcInprocess(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 3, 0x1, v ? 1 : 0); }
    get saferD(): boolean { return bitFieldGet(this.funcBitFields, 4, 0x1) !== 0; }
    set saferD(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 4, 0x1, v ? 1 : 0); }
    get scopeInprocess(): boolean { return bitFieldGet(this.funcBitFields, 5, 0x1) !== 0; }
    set scopeInprocess(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 5, 0x1, v ? 1 : 0); }
    get inlineScanned(): boolean { return bitFieldGet(this.funcBitFields, 6, 0x1) !== 0; }
    set inlineScanned(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 6, 0x1, v ? 1 : 0); }
    get hasCatches(): boolean { return bitFieldGet(this.funcBitFields, 7, 0x1) !== 0; }
    set hasCatches(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 7, 0x1, v ? 1 : 0); }
    get skipCodegen(): boolean { return bitFieldGet(this.funcBitFields, 8, 0x1) !== 0; }
    set skipCodegen(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 8, 0x1, v ? 1 : 0); }
    get printf(): boolean { return bitFieldGet(this.funcBitFields, 9, 0x1) !== 0; }
    set printf(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 9, 0x1, v ? 1 : 0); }
    get scanf(): boolean { return bitFieldGet(this.funcBitFields, 10, 0x1) !== 0; }
    set scanf(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 10, 0x1, v ? 1 : 0); }
    get noreturn(): boolean { return bitFieldGet(this.funcBitFields, 11, 0x1) !== 0; }
    set noreturn(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 11, 0x1, v ? 1 : 0); }
    get isNRVO(): boolean { return bitFieldGet(this.funcBitFields, 12, 0x1) !== 0; }
    set isNRVO(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 12, 0x1, v ? 1 : 0); }
    get isNaked(): boolean { return bitFieldGet(this.funcBitFields, 13, 0x1) !== 0; }
    set isNaked(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 13, 0x1, v ? 1 : 0); }
    get isGenerated(): boolean { return bitFieldGet(this.funcBitFields, 14, 0x1) !== 0; }
    set isGenerated(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 14, 0x1, v ? 1 : 0); }
    get isIntroducing(): boolean { return bitFieldGet(this.funcBitFields, 15, 0x1) !== 0; }
    set isIntroducing(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 15, 0x1, v ? 1 : 0); }
    get hasSemantic3Errors(): boolean { return bitFieldGet(this.funcBitFields, 16, 0x1) !== 0; }
    set hasSemantic3Errors(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 16, 0x1, v ? 1 : 0); }
    get hasNoEH(): boolean { return bitFieldGet(this.funcBitFields, 17, 0x1) !== 0; }
    set hasNoEH(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 17, 0x1, v ? 1 : 0); }
    get inferRetType(): boolean { return bitFieldGet(this.funcBitFields, 18, 0x1) !== 0; }
    set inferRetType(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 18, 0x1, v ? 1 : 0); }
    get hasDualContext(): boolean { return bitFieldGet(this.funcBitFields, 19, 0x1) !== 0; }
    set hasDualContext(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 19, 0x1, v ? 1 : 0); }
    get hasAlwaysInlines(): boolean { return bitFieldGet(this.funcBitFields, 20, 0x1) !== 0; }
    set hasAlwaysInlines(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 20, 0x1, v ? 1 : 0); }
    get isCrtCtor(): boolean { return bitFieldGet(this.funcBitFields, 21, 0x1) !== 0; }
    set isCrtCtor(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 21, 0x1, v ? 1 : 0); }
    get isCrtDtor(): boolean { return bitFieldGet(this.funcBitFields, 22, 0x1) !== 0; }
    set isCrtDtor(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 22, 0x1, v ? 1 : 0); }
    get hasEscapingSiblings(): boolean { return bitFieldGet(this.funcBitFields, 23, 0x1) !== 0; }
    set hasEscapingSiblings(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 23, 0x1, v ? 1 : 0); }
    get computedEscapingSiblings(): boolean { return bitFieldGet(this.funcBitFields, 24, 0x1) !== 0; }
    set computedEscapingSiblings(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 24, 0x1, v ? 1 : 0); }
    get dllImport(): boolean { return bitFieldGet(this.funcBitFields, 25, 0x1) !== 0; }
    set dllImport(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 25, 0x1, v ? 1 : 0); }
    get dllExport(): boolean { return bitFieldGet(this.funcBitFields, 26, 0x1) !== 0; }
    set dllExport(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 26, 0x1, v ? 1 : 0); }
    get hasReturnExp(): boolean { return bitFieldGet(this.funcBitFields, 27, 0x1) !== 0; }
    set hasReturnExp(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 27, 0x1, v ? 1 : 0); }
    get hasInlineAsm(): boolean { return bitFieldGet(this.funcBitFields, 28, 0x1) !== 0; }
    set hasInlineAsm(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 28, 0x1, v ? 1 : 0); }
    get hasMultipleReturnExp(): boolean { return bitFieldGet(this.funcBitFields, 29, 0x1) !== 0; }
    set hasMultipleReturnExp(v: boolean) { this.funcBitFields = bitFieldSet(this.funcBitFields, 29, 0x1, v ? 1 : 0); }

    // ── ContractInfo accessor group (func.d:401-437, inside `final nothrow pure @safe { … }`) ────
    // The D attributes on the group are erased (04 §8). Each contract slot has a GETTER
    // (`inout(T) name() inout`) and a SETTER generated by the `generateContractSetter` CTFE mixin
    // (func.d:420-436), which in D is a same-named overload `T name(T param)` reached as
    // `f.name = param`. TS cannot carry a getter method and a setter method under one name, so the
    // setter takes the `set` prefix (04 §1B rename; the getter keeps the bare D name because every
    // dependent already reads `f.frequires()`), and every `f.name = x` D site becomes
    // `f.setName(x)`.

    /// func.d:403 — `private ref ContractInfo getContracts()`. Lazily allocates the group.
    /// Touched only by this class's own setters — no sibling module-level function, no unittest —
    /// so the faithful emission of D's module-`private` is TS `private` (01 §2.5 table, row 1).
    private getContracts(): ContractInfo {
        if (this.contracts === null)
            this.contracts = new ContractInfo();
        return this.contracts;
    }

    // getters (func.d:411-418). D's `contracts ? contracts.x : null` tests a nullable pointer ->
    // the canonical explicit null test (06 "Truthiness of a nullable reference"), matching the
    // `this.contracts === null` spelling the setters below already use.
    frequires(): Statements | null { return this.contracts !== null ? this.contracts.frequires : null; }
    fensures(): Ensures | null { return this.contracts !== null ? this.contracts.fensures : null; }
    frequire(): Statement | null { return this.contracts !== null ? this.contracts.frequire : null; }
    fensure(): Statement | null { return this.contracts !== null ? this.contracts.fensure : null; }
    fdrequire(): FuncDeclaration | null { return this.contracts !== null ? this.contracts.fdrequire : null; }
    fdensure(): FuncDeclaration | null { return this.contracts !== null ? this.contracts.fdensure : null; }
    fdrequireParams(): Expressions | null { return this.contracts !== null ? this.contracts.fdrequireParams : null; }
    fdensureParams(): Expressions | null { return this.contracts !== null ? this.contracts.fdensureParams : null; }

    // setters — the eight `mixin(generateContractSetter(...))` expansions (func.d:429-436). The
    // generated body is verbatim: `if (!param && !contracts) return null; return
    // getContracts().<field> = param;` — clearing an empty slot never allocates the group.
    setFrequires(param: Statements | null): Statements | null {
        if (param === null && this.contracts === null) return null;
        return this.getContracts().frequires = param;
    }
    setFensures(param: Ensures | null): Ensures | null {
        if (param === null && this.contracts === null) return null;
        return this.getContracts().fensures = param;
    }
    setFrequire(param: Statement | null): Statement | null {
        if (param === null && this.contracts === null) return null;
        return this.getContracts().frequire = param;
    }
    setFensure(param: Statement | null): Statement | null {
        if (param === null && this.contracts === null) return null;
        return this.getContracts().fensure = param;
    }
    setFdrequire(param: FuncDeclaration | null): FuncDeclaration | null {
        if (param === null && this.contracts === null) return null;
        return this.getContracts().fdrequire = param;
    }
    setFdensure(param: FuncDeclaration | null): FuncDeclaration | null {
        if (param === null && this.contracts === null) return null;
        return this.getContracts().fdensure = param;
    }
    setFdrequireParams(param: Expressions | null): Expressions | null {
        if (param === null && this.contracts === null) return null;
        return this.getContracts().fdrequireParams = param;
    }
    setFdensureParams(param: Expressions | null): Expressions | null {
        if (param === null && this.contracts === null) return null;
        return this.getContracts().fdensureParams = param;
    }

    /// func.d:439 — `override FuncDeclaration syntaxCopy(Dsymbol s)`.
    /// When `s` is non-null a subclass already allocated the target and calls this to copy the
    /// contracts/body INTO it; otherwise build a fresh FuncDeclaration from a copy of `type`.
    /// The D `f.frequires = …` field-writes are setter calls in the port (see the accessor note).
    /// `f.mangleOverride = mangleOverride;` is the version (IN_LLVM) branch — KEPT (we are LDC).
    override syntaxCopy(s: Dsymbol | null): FuncDeclaration {
        //printf("FuncDeclaration::syntaxCopy('%s')\n", toChars());
        const f = s !== null
            ? (s as FuncDeclaration)   // D `cast(FuncDeclaration)s` — downcast, exactly as D spells it
            : new FuncDeclaration(this.loc, this.endloc, this.ident, this.storage_class,
                this.type!.syntaxCopy(), this.noreturn);
        f.setFrequires(this.frequires() !== null ? Statement.arraySyntaxCopy(this.frequires()) : null);
        f.setFensures(this.fensures() !== null ? Ensure.arraySyntaxCopy(this.fensures()) : null);
        f.fbody = this.fbody !== null ? this.fbody.syntaxCopy() : null;
        f.mangleOverride = this.mangleOverride;
        return f;
    }

    /********************************************
     * func.d:457 — `extern (D) final TemplateDeclaration findTemplateDeclRoot()`.
     * find function template root in overload list
     */
    findTemplateDeclRoot(): TemplateDeclaration | null {
        let f: FuncDeclaration | null = this;
        while (f !== null && f.overnext !== null) {
            //printf("f.overnext = %p %s\n", f.overnext, f.overnext.toChars());
            const td = f.overnext.isTemplateDeclaration();
            if (td !== null)
                return td;
            f = f.overnext.isFuncDeclaration();
        }
        return null;
    }

    /********************************************
     * func.d:474 — `final bool inUnittest()`.
     * Returns true if function was declared
     * directly or indirectly in a unittest block
     */
    inUnittest(): boolean {
        // D reassigns the loop variable up the parent chain -> widened local cursor (02 §10.1).
        let cur: Dsymbol | null = this;
        do {
            if (cur.isUnitTestDeclaration() !== null)
                return true;
            cur = cur.toParent();
        }
        while (cur !== null);
        return false;
    }

    /********************************
     * func.d:497 — `final LabelDsymbol searchLabel(Identifier ident, Loc loc)`.
     *
     * Searches for a label with the given identifier. This function will insert a new
     * `LabelDsymbol` into `labtab` if it does not contain a mapping for `ident`.
     *
     * Params:
     *   ident = identifier of the requested label
     *   loc   = location used when creating a new `LabelDsymbol`
     *
     * Returns: the `LabelDsymbol` for `ident`
     */
    searchLabel(ident: Identifier, loc: Loc): LabelDsymbol {
        let s: Dsymbol | null;
        if (this.labtab === null)
            this.labtab = new DsymbolTable(); // guess we need one

        s = this.labtab.lookup(ident);
        if (s === null) {
            s = new LabelDsymbol(ident, loc);
            this.labtab.insert(s);
        }
        return s as LabelDsymbol;  // D `cast(LabelDsymbol)s` — downcast, exactly as D spells it
    }

    /// func.d:512 — `override const(char)* toPrettyChars(bool QualifyTypes = false)`.
    /// "D main" for the program entry point, else the generic Dsymbol pretty name. D names
    /// `Dsymbol.toPrettyChars` explicitly; `Declaration` does not override it, so `super.` resolves
    /// to exactly that method.
    override toPrettyChars(QualifyTypes: boolean = false): DString {
        if (this.isMain())
            return ds("D main");
        return super.toPrettyChars(QualifyTypes);
    }

    /** func.d:520 — `final const(char)* toFullSignature()`.
     * for diagnostics, e.g. 'int foo(int x, int y) pure' */
    toFullSignature(): DString {
        const buf = new OutBuffer(); // func.d:522
        functionToBufferWithIdent(this.type!.toTypeFunction(), buf, this.toChars(), this.isStatic()); // func.d:523
        return buf.extractChars(); // func.d:524
    }

    // func.d:527-560 — the entry-point predicates: identity + linkage + member/nested checks.
    isMain(): boolean {
        return this.ident === Id.main && this.resolvedLinkage() !== LINK.c && this.isMember() === null
            && !this.isNested();
    }

    isCMain(): boolean {
        return this.ident === Id.main && this.resolvedLinkage() === LINK.c && this.isMember() === null
            && !this.isNested();
    }

    isWinMain(): boolean {
        //printf("FuncDeclaration::isWinMain() %s\n", toChars());
        // resolved: version (none) (func.d:540) -> OFF; the `else` branch is emitted.
        return this.ident === Id.WinMain && this.resolvedLinkage() !== LINK.c && this.isMember() === null;
    }

    isDllMain(): boolean {
        return this.ident === Id.DllMain && this.resolvedLinkage() !== LINK.c && this.isMember() === null;
    }

    isRtInit(): boolean {
        return this.ident === Id.rt_init && this.resolvedLinkage() === LINK.c && this.isMember() === null
            && !this.isNested();
    }

    // func.d:562 — exported if visibility is `export` or it carries dllExport.
    override isExport(): boolean {
        return this.visibility.kind === Visibility.Kind.export_ || this.dllExport;
    }

    // func.d:567 — imported if (export || dllImport) AND it has no body (a declaration, not a definition).
    override isImportedSymbol(): boolean {
        //printf("isImportedSymbol()\n");
        //printf("protection = %d\n", visibility);
        return (this.visibility.kind === Visibility.Kind.export_ || this.dllImport) && this.fbody === null;
    }

    override isCodeseg(): boolean {
        return true; // functions are always in the code segment
    }

    override isOverloadable(): boolean {
        return true; // functions can be overloaded
    }

    /***********************************
     * func.d:588 — `override final bool isAbstract()`.
     * Override so it can work even if semantic() hasn't yet
     * been run.
     */
    override isAbstract(): boolean {
        if ((this.storage_class & STC.abstract_) !== 0n)
            return true;
        if (this.semanticRun >= PASS.semanticdone)
            return false;

        if (this._scope !== null) {
            if ((this._scope.stc & STC.abstract_) !== 0n)
                return true;
            this.parent = this._scope.parent;
            const parent = this.toParent();
            if (parent!.isInterfaceDeclaration() !== null)
                return true;
        }
        return false;
    }

    // func.d:607 — `extern (D) final uint saveFlags()`.
    saveFlags(): number {
        return this.funcBitFields;
    }

    // func.d:612 — `extern (D) final uint restoreFlags(uint f)`.
    restoreFlags(f: number): number {
        this.funcBitFields = f;
        return this.funcBitFields;
    }

    /**************************************
     * func.d:627 — `extern (D) final void setThrow(Loc loc, const(char)* format, RootObject[] args...)`.
     * The function is doing something that may throw an exception, register that in case nothrow is
     * being inferred.
     *
     * Params:
     *     loc = location of action
     *     format = format string for error message
     *     args = arguments to format string
     *
     * D typesafe variadic `RootObject[] args...` -> TS rest parameter (04 §3.2); call sites that
     * already hold an array SPREAD it.
     */
    setThrow(loc: Loc, format: DString, ...args: (RootObject | null)[]): void {
        if (this.nothrowInprocess && this.nothrowViolation === null) {
            // action that requires GC
            this.nothrowViolation = AttributeViolation.fromFormat(loc, format, args);
        }
    }

    /**************************************
     * func.d:641 — `extern (D) final void setThrowCall(Loc loc, FuncDeclaration fd)`.
     * The function calls non-`nothrow` function f, register that in case nothrow is being inferred.
     * Params:
     *     loc = location of call
     *     fd = function being called
     */
    setThrowCall(loc: Loc, fd: FuncDeclaration): void {
        if (this.nothrowInprocess && this.nothrowViolation === null) {
            // action that requires GC
            this.nothrowViolation = AttributeViolation.fromFuncDeclaration(loc, fd);
        }
    }

    /****************************************
     * func.d:657 — `bool isNested() const`.
     * Determine if function needs a static frame pointer.
     * Returns:
     *  `true` if function is really nested within other function.
     * Contracts:
     *  If isNested() returns true, isThis() should return false,
     *  unless the function needs a dual-context pointer.
     */
    isNested(): boolean {
        const f = this.toAliasFunc();
        //printf("\ttoParent2() = '%s'\n", f.toParent2().toChars());
        return ((f.storage_class & STC.static_) === 0n) &&
                (f._linkage === LINK.d) &&
                (f.toParent2()!.isFuncDeclaration() !== null ||
                 f.toParent2() !== f.toParentLocal());
    }

    /****************************************
     * func.d:676 — `override inout(AggregateDeclaration) isThis() inout`.
     * Determine if function is a non-static member function
     * that has an implicit 'this' expression.
     * Returns:
     *  The aggregate it is a member of, or null.
     * Contracts:
     *  Both isThis() and isNested() should return true if function needs a dual-context pointer,
     *  otherwise if isThis() returns true, isNested() should return false.
     */
    override isThis(): AggregateDeclaration | null {
        //printf("+FuncDeclaration::isThis() '%s'\n", toChars());
        // func.d:679 — D's `.objc` is the module-level accessor `objc()` of dmd.objc, not `this.objc`.
        const ad = (this.storage_class & STC.static_) !== 0n ? objc()!.isThis(this) : this.isMemberLocal();
        //printf("-FuncDeclaration::isThis() %p\n", ad);
        return ad;
    }

    // func.d:684 — `override final bool needThis()`.
    override needThis(): boolean {
        //printf("FuncDeclaration::needThis() '%s'\n", toChars());
        return this.toAliasFunc().isThis() !== null;
    }

    // func.d:690 — `final bool isFinalFunc() const`. A member that is `final` itself, or whose
    // enclosing class is `final`. A non-member is never final.
    isFinalFunc(): boolean {
        if (this.toAliasFunc() !== this)
            return this.toAliasFunc().isFinalFunc();

        // resolved: version (none) (func.d:695-703) -> OFF; the printf debug block is dropped.
        if (this.isMember() === null)
            return false;
        if (super.isFinal())   // D `Declaration.isFinal()` — the explicit base-class call
            return true;
        const cd = this.toParent()!.isClassDeclaration();
        return (cd !== null) && (cd.storage_class & STC.final_) !== 0n;
    }

    // func.d:712 — `override const(char)* kind() const`.
    override kind(): DString {
        return this.isGenerated ? ds("generated function") : ds("function");
    }

    /*********************************************
     * func.d:721 — `final ParameterList getParameterList()`.
     * Returns: the function's parameter list, and whether
     * it is variadic or not.
     */
    getParameterList(): ParameterList {
        if (this.type !== null) {
            const fdtype: TypeFunction | null = this.type.isTypeFunction(); // Could also be TypeError
            if (fdtype !== null)
                // D returns `ParameterList` BY VALUE, so the caller gets an independent struct
                // (03 §1 #3/#6). The §9 elision does NOT apply: the source alias — the
                // `TypeFunction.parameterList` field — outlives the return and is mutable in-scope
                // (mtype.ts re-copies it before rewriting `parameters`), so handing out the live
                // field would let any caller's `varargs`/`stc`/`parameters` write rewrite the
                // function type. ParameterList is not in the alias-safe register (03 §9.1).
                return fdtype.parameterList.copy();
        }

        return new ParameterList(null, VarArg.none); // fresh construction — no copy (03 §1)
    }

    // func.d:732 — `inout(FuncDeclaration) toAliasFunc() inout @safe`.
    toAliasFunc(): FuncDeclaration {
        return this;
    }

    // func.d:737 — `override void accept(Visitor v) { v.visit(this); }` (13 §2).
    override accept(v: Visitor): void {
        v.visitFuncDeclaration(this);
    }
}

/// dmd/func.d:762 — `static struct Mismatches` declared INSIDE `MODMatchToBuffer`. TS has no
/// function-local class that a caller can name, so the struct is hoisted to module scope (its D
/// name is preserved verbatim). VALUE struct; both fields are `bool` primitives.
///
/// NOT exported: the hoist is forced by TS, the widening is not. D declares this inside the body of
/// `MODMatchToBuffer`, which returns it as `auto` — no importer can name the type, so no in-scope
/// caller ever needs the name (01 §2 no-widening). Callers read the returned value structurally.
class Mismatches {
    isNotShared: boolean = false;
    isMutable: boolean = false;

    copy(): Mismatches {
        const c = new Mismatches();
        c.isNotShared = this.isNotShared;
        c.isMutable = this.isMutable;
        return c;
    }
}

/**
dmd/func.d:760 — `auto MODMatchToBuffer(OutBuffer* buf, ubyte lhsMod, ubyte rhsMod)`.

Checks for mismatching modifiers between `lhsMod` and `rhsMod` and prints the
mismatching modifiers to `buf`.

The modifiers of the `lhsMod` mismatching the ones with the `rhsMod` are printed, i.e.
lhs(shared) vs. rhs() prints "`shared`", wheras lhs() vs rhs(shared) prints "non-shared".

Params:
    buf = output buffer to write to
    lhsMod = modifier on the left-hand side
    lhsMod = modifier on the right-hand side

Returns:

A tuple with `isMutable` and `isNotShared` set
if the `lhsMod` is missing those modifiers (compared to rhs).

`OutBuffer* buf` is a pointer to a value struct -> the object as a reference, never copied
(02 §10 case 2). `ubyte` operands are the `number` domain (09 §1).
*/
export function MODMatchToBuffer(buf: OutBuffer, lhsMod: number, rhsMod: number): Mismatches {
    const mismatches = new Mismatches();

    const bothMutable: boolean = ((lhsMod & rhsMod) === 0);
    const sharedMismatch: boolean = ((lhsMod ^ rhsMod) & MODFlags.shared_) !== 0;
    const sharedMismatchOnly: boolean = ((lhsMod ^ rhsMod) === MODFlags.shared_);

    if ((lhsMod & MODFlags.shared_) !== 0)
        buf.writestring(ds("`shared` "));
    else if (sharedMismatch && !((lhsMod & MODFlags.immutable_) !== 0)) {
        buf.writestring(ds("non-shared "));
        mismatches.isNotShared = true;
    }

    if (bothMutable && sharedMismatchOnly) {
    }
    else if ((lhsMod & MODFlags.immutable_) !== 0)
        buf.writestring(ds("`immutable` "));
    else if ((lhsMod & MODFlags.const_) !== 0)
        buf.writestring(ds("`const` "));
    else if ((lhsMod & MODFlags.wild) !== 0)
        buf.writestring(ds("`inout` "));
    else {
        buf.writestring(ds("mutable "));
        mismatches.isMutable = true;
    }

    return mismatches; // copy elided (03 §9): a fresh local returned once, no surviving alias
}

/***********************************************************
 * dmd/func.d:827 — `extern (C++) final class FuncAliasDeclaration : FuncDeclaration`.
 * Used as a way to import a set of functions from another scope into this one.
 * D `final` on the class is ERASED (04 §8).
 */
export class FuncAliasDeclaration extends FuncDeclaration {
    funcalias: FuncDeclaration | null = null;
    hasOverloads: boolean = false;

    // func.d:832 — `extern (D) this(Identifier ident, FuncDeclaration funcalias, bool hasOverloads = true)`.
    constructor(ident: Identifier, funcalias: FuncDeclaration, hasOverloads: boolean = true) {
        super(funcalias.loc, funcalias.endloc, ident, funcalias.storage_class, funcalias.type);
        assert(funcalias !== this);
        this.funcalias = funcalias;
        this.dsym = DSYM.funcAliasDeclaration;

        this.hasOverloads = hasOverloads;
        if (hasOverloads) {
            const fad = funcalias.isFuncAliasDeclaration();
            if (fad !== null)
                this.hasOverloads = fad.hasOverloads;
        }
        else {
            // for internal use
            assert(funcalias.isFuncAliasDeclaration() === null);
            this.hasOverloads = false;
        }
        // D `userAttribDecl = funcalias.userAttribDecl;` — getter/setter pair on Dsymbol.
        this.userAttribDecl_set(funcalias.userAttribDecl());
    }

    // func.d:854
    override kind(): DString {
        return ds("function alias");
    }

    // func.d:859
    override toAliasFunc(): FuncDeclaration {
        return this.funcalias!.toAliasFunc();
    }

    // func.d:864
    override accept(v: Visitor): void {
        v.visitFuncAliasDeclaration(this);
    }
}

/***********************************************************
 * dmd/func.d:872 — `extern (C++) final class FuncLiteralDeclaration : FuncDeclaration`.
 */
export class FuncLiteralDeclaration extends FuncDeclaration {
    tok: TOK;        // TOK.function_ or TOK.delegate_
    treq: Type | null = null;      // target of return type inference

    // backend
    deferToObj: boolean = false;

    // func.d:880 — `extern (D) this(Loc loc, Loc endloc, Type type, TOK tok, ForeachStatement fes,
    //                               Identifier id = null, STC storage_class = STC.none)`.
    constructor(loc: Loc, endloc: Loc, type: Type | null, tok: TOK, fes: ForeachStatement | null,
                id: Identifier | null = null, storage_class: STC = STC.none) {
        super(loc, endloc, null, storage_class, type);
        this.dsym = DSYM.funcLiteralDeclaration;
        this.ident = id !== null ? id : Id.empty;
        this.tok = tok;
        this.fes = fes;
        // Always infer scope for function literals
        // See https://issues.dlang.org/show_bug.cgi?id=20362
        this.scopeInprocess = true;
        //printf("FuncLiteralDeclaration() id = '%s', type = '%s'\n", this.ident.toChars(), type.toChars());
    }

    // func.d:893 — `override FuncLiteralDeclaration syntaxCopy(Dsymbol s)`.
    override syntaxCopy(s: Dsymbol | null): FuncLiteralDeclaration {
        //printf("FuncLiteralDeclaration::syntaxCopy('%s')\n", toChars());
        assert(s === null);
        const f = new FuncLiteralDeclaration(this.loc, this.endloc, this.type!.syntaxCopy(), this.tok,
            this.fes, this.ident, (this.storage_class & STC.auto_) as STC);
        f.treq = this.treq; // don't need to copy
        super.syntaxCopy(f); // D `FuncDeclaration.syntaxCopy(f)` — copies the contracts/body into f
        return f;
    }

    // func.d:903
    override isNested(): boolean {
        //printf("FuncLiteralDeclaration::isNested() '%s'\n", toChars());
        return (this.tok !== TOK.function_) && this.isThis() === null;
    }

    // func.d:909 — only a `delegate` literal can have a `this`.
    override isThis(): AggregateDeclaration | null {
        return this.tok === TOK.delegate_ ? super.isThis() : null;
    }

    // func.d:914
    override kind(): DString {
        // GCC requires the (char*) casts
        return (this.tok !== TOK.function_) ? ds("delegate") : ds("function");
    }

    // func.d:920 — a template-instance literal uses the template's pretty name; else the DSYMBOL
    // one. D names `Dsymbol.toPrettyChars` explicitly, SKIPPING `FuncDeclaration.toPrettyChars`
    // (which would answer "D main" for an entry point); `super.` would resolve to the skipped
    // override, so the base method is invoked directly (tree precedent: dtemplate.ts:780).
    override toPrettyChars(QualifyTypes: boolean = false): DString {
        if (this.parent !== null) {
            const ti = this.parent.isTemplateInstance();
            if (ti !== null)
                return ti.tempdecl!.toPrettyChars(QualifyTypes);
        }
        return Dsymbol.prototype.toPrettyChars.call(this, QualifyTypes);
    }

    // func.d:930
    override accept(v: Visitor): void {
        v.visitFuncLiteralDeclaration(this);
    }
}

/***********************************************************
 * dmd/func.d:938 — `extern (C++) final class CtorDeclaration : FuncDeclaration`.
 */
export class CtorDeclaration extends FuncDeclaration {
    isCpCtor: boolean = false;    // copy constructor
    isMoveCtor: boolean = false;  // move constructor (aka rvalue constructor)

    // func.d:942 — `extern (D) this(Loc loc, Loc endloc, STC stc, Type type)`.
    constructor(loc: Loc, endloc: Loc, stc: STC, type: Type | null) {
        super(loc, endloc, Id.ctor, stc, type);
        this.dsym = DSYM.ctorDeclaration;
        //printf("CtorDeclaration(loc = %s) %s %p\n", loc.toChars(), toChars(), this);
    }

    // func.d:949
    override syntaxCopy(s: Dsymbol | null): CtorDeclaration {
        assert(s === null);
        const f = new CtorDeclaration(this.loc, this.endloc, this.storage_class, this.type!.syntaxCopy());
        super.syntaxCopy(f);
        return f;
    }

    // func.d:957
    override kind(): DString {
        return this.isCpCtor ? ds("copy constructor") :
             this.isMoveCtor ? ds("move constructor") : ds("constructor");
    }

    // func.d:963
    override accept(v: Visitor): void {
        v.visitCtorDeclaration(this);
    }
}

/***********************************************************
 * dmd/func.d:971 — `extern (C++) final class PostBlitDeclaration : FuncDeclaration`.
 */
export class PostBlitDeclaration extends FuncDeclaration {
    // func.d:973 — `extern (D) this(Loc loc, Loc endloc, STC stc, Identifier id)`.
    constructor(loc: Loc, endloc: Loc, stc: STC, id: Identifier) {
        super(loc, endloc, id, stc, null);
        this.dsym = DSYM.postBlitDeclaration;
    }

    // func.d:979
    override syntaxCopy(s: Dsymbol | null): PostBlitDeclaration {
        assert(s === null);
        const dd = new PostBlitDeclaration(this.loc, this.endloc, this.storage_class, this.ident!);
        super.syntaxCopy(dd);
        return dd;
    }

    // func.d:987
    override accept(v: Visitor): void {
        v.visitPostBlitDeclaration(this);
    }
}

/***********************************************************
 * dmd/func.d:995 — `extern (C++) final class DtorDeclaration : FuncDeclaration`.
 */
export class DtorDeclaration extends FuncDeclaration {
    // CONSTRUCTOR OVERLOAD SET (04 §1 Form A — arity dispatch): D declares `this(Loc, Loc)`
    // (func.d:997) and `this(Loc, Loc, STC, Identifier)` (func.d:1003). The 2-arg form is exactly
    // the 4-arg form with `stc = STC.none` and `id = Id.dtor`, so the two collapse into one
    // constructor with optional trailing parameters carrying those defaults.
    constructor(loc: Loc, endloc: Loc, stc: STC = STC.none, id: Identifier | null = Id.dtor) {
        super(loc, endloc, id, stc, null);
        this.dsym = DSYM.dtorDeclaration;
    }

    // func.d:1009
    override syntaxCopy(s: Dsymbol | null): DtorDeclaration {
        assert(s === null);
        const dd = new DtorDeclaration(this.loc, this.endloc, this.storage_class, this.ident!);
        super.syntaxCopy(dd);
        return dd;
    }

    // func.d:1017
    override kind(): DString {
        return ds("destructor");
    }

    // func.d:1022
    override accept(v: Visitor): void {
        v.visitDtorDeclaration(this);
    }
}

/***********************************************************
 * dmd/func.d:1030 — `extern (C++) class StaticCtorDeclaration : FuncDeclaration`.
 */
export class StaticCtorDeclaration extends FuncDeclaration {
    // CONSTRUCTOR OVERLOAD SET: D declares `this(Loc, Loc, STC)` (func.d:1032, id prefix
    // "_staticCtor") and `this(Loc, Loc, string name, STC)` (func.d:1038, caller-supplied prefix).
    // The forms differ by argument COUNT (3 vs 4), but the extra parameter sits at a MIDDLE
    // position, so 04 §1 Form A's canonical "one function with optional TRAILING params" emission
    // is not expressible and Form B (same arity, different types) does not apply either — the guide
    // has no rule for this shape. Resolution: the declared call signatures below reproduce D's two
    // forms exactly, and the implementation decodes the union-typed third parameter by its RUNTIME
    // DOMAIN (`STC` is a branded `bigint`; a name prefix is a `DString`/Uint8Array — disjoint,
    // total, and neither is ever null in either D form). NOT `arguments.length`: an explicit
    // `undefined` fourth argument would take the named branch with `prefix === undefined` and mint
    // a corrupt identifier with no diagnostic (04 §1.1(c) forbids exactly that silent-miscompile
    // shape); with the domain test that call is a loud TypeError instead. This decodes an overload
    // D already chose by arity — it is not a Form-B runtime test standing in for static resolution.
    constructor(loc: Loc, endloc: Loc, stc: STC);
    constructor(loc: Loc, endloc: Loc, name: DString, stc: STC);
    constructor(loc: Loc, endloc: Loc, nameOrStc: DString | STC, stc?: STC) {
        const named = typeof nameOrStc !== "bigint";
        const prefix = named ? (nameOrStc as DString) : ds("_staticCtor");
        const sc = named ? (stc as STC) : (nameOrStc as STC);
        super(loc, endloc, Identifier.generateIdWithLoc(prefix, loc), (STC.static_ | sc) as STC, null);
        this.dsym = DSYM.staticCtorDeclaration;
    }

    // func.d:1044
    override syntaxCopy(s: Dsymbol | null): StaticCtorDeclaration {
        assert(s === null);
        const scd = new StaticCtorDeclaration(this.loc, this.endloc, this.storage_class);
        super.syntaxCopy(scd);
        return scd;
    }

    // func.d:1052 — `override final inout(AggregateDeclaration) isThis() inout`.
    override isThis(): AggregateDeclaration | null {
        return null;
    }

    // func.d:1057
    override accept(v: Visitor): void {
        v.visitStaticCtorDeclaration(this);
    }
}

/***********************************************************
 * dmd/func.d:1065 — `extern (C++) final class SharedStaticCtorDeclaration : StaticCtorDeclaration`.
 */
export class SharedStaticCtorDeclaration extends StaticCtorDeclaration {
    /// Exclude this constructor from cyclic dependency check
    standalone: boolean = false;

    // func.d:1070 — `super(loc, endloc, "_sharedStaticCtor", stc)`: the NAMED StaticCtor form.
    constructor(loc: Loc, endloc: Loc, stc: STC) {
        super(loc, endloc, ds("_sharedStaticCtor"), stc);
        this.dsym = DSYM.sharedStaticCtorDeclaration;
    }

    // func.d:1076
    override syntaxCopy(s: Dsymbol | null): SharedStaticCtorDeclaration {
        assert(s === null);
        const scd = new SharedStaticCtorDeclaration(this.loc, this.endloc, this.storage_class);
        // D writes `FuncDeclaration.syntaxCopy(scd);` (func.d:1080) — an EXPLICIT non-virtual
        // base-class call that names `FuncDeclaration`, SKIPPING `StaticCtorDeclaration.syntaxCopy`.
        // TS `super.` is the IMMEDIATE base, so it would re-enter StaticCtorDeclaration.syntaxCopy,
        // whose first statement is `assert(s === null)` against the freshly built `scd` — every copy
        // of a `shared static this` would die with an AssertError. Invoke the named base directly
        // (same idiom as FuncLiteralDeclaration.toPrettyChars above; tree precedent dtemplate.ts).
        FuncDeclaration.prototype.syntaxCopy.call(this, scd);
        return scd;
    }

    // func.d:1084
    override accept(v: Visitor): void {
        v.visitSharedStaticCtorDeclaration(this);
    }
}

/***********************************************************
 * dmd/func.d:1092 — `extern (C++) class StaticDtorDeclaration : FuncDeclaration`.
 */
export class StaticDtorDeclaration extends FuncDeclaration {
    vgate: VarDeclaration | null = null; // 'gate' variable

    // CONSTRUCTOR OVERLOAD SET (04 §1 Form A — arity dispatch): D declares `this(Loc, Loc, STC)`
    // (func.d:1096, id prefix "_staticDtor") and `this(Loc, Loc, string name, STC)` (func.d:1102).
    // Same shape as StaticCtorDeclaration above.
    constructor(loc: Loc, endloc: Loc, stc: STC);
    constructor(loc: Loc, endloc: Loc, name: DString, stc: STC);
    constructor(loc: Loc, endloc: Loc, nameOrStc: DString | STC, stc?: STC) {
        // Runtime-domain decode of the union-typed third parameter — see StaticCtorDeclaration above.
        const named = typeof nameOrStc !== "bigint";
        const prefix = named ? (nameOrStc as DString) : ds("_staticDtor");
        const sc = named ? (stc as STC) : (nameOrStc as STC);
        super(loc, endloc, Identifier.generateIdWithLoc(prefix, loc), (STC.static_ | sc) as STC, null);
        this.dsym = DSYM.staticDtorDeclaration;
    }

    // func.d:1108
    override syntaxCopy(s: Dsymbol | null): StaticDtorDeclaration {
        assert(s === null);
        const sdd = new StaticDtorDeclaration(this.loc, this.endloc, this.storage_class);
        super.syntaxCopy(sdd);
        return sdd;
    }

    // func.d:1116 — `override final inout(AggregateDeclaration) isThis() inout`.
    override isThis(): AggregateDeclaration | null {
        return null;
    }

    // func.d:1121
    override accept(v: Visitor): void {
        v.visitStaticDtorDeclaration(this);
    }
}

/***********************************************************
 * dmd/func.d:1129 — `extern (C++) final class SharedStaticDtorDeclaration : StaticDtorDeclaration`.
 */
export class SharedStaticDtorDeclaration extends StaticDtorDeclaration {
    // func.d:1131 — `super(loc, endloc, "_sharedStaticDtor", stc)`: the NAMED StaticDtor form.
    constructor(loc: Loc, endloc: Loc, stc: STC) {
        super(loc, endloc, ds("_sharedStaticDtor"), stc);
        this.dsym = DSYM.sharedStaticDtorDeclaration;
    }

    // func.d:1137
    override syntaxCopy(s: Dsymbol | null): SharedStaticDtorDeclaration {
        assert(s === null);
        const sdd = new SharedStaticDtorDeclaration(this.loc, this.endloc, this.storage_class);
        // D writes `FuncDeclaration.syntaxCopy(sdd);` (func.d:1141) — the explicit non-virtual base
        // call, skipping `StaticDtorDeclaration.syntaxCopy`; see SharedStaticCtorDeclaration above.
        FuncDeclaration.prototype.syntaxCopy.call(this, sdd);
        return sdd;
    }

    // func.d:1145
    override accept(v: Visitor): void {
        v.visitSharedStaticDtorDeclaration(this);
    }
}

/***********************************************************
 * dmd/func.d:1153 — `extern (C++) final class InvariantDeclaration : FuncDeclaration`.
 */
export class InvariantDeclaration extends FuncDeclaration {
    // func.d:1155 — `extern (D) this(Loc loc, Loc endloc, STC stc, Identifier id, Statement fbody)`.
    constructor(loc: Loc, endloc: Loc, stc: STC, id: Identifier | null, fbody: Statement | null) {
        // Make a unique invariant for now; we'll fix it up as we add it to the aggregate invariant list.
        super(loc, endloc, id !== null ? id : Identifier.generateId(ds("__invariant")), stc, null);
        this.fbody = fbody;
        this.dsym = DSYM.invariantDeclaration;
    }

    // func.d:1163
    override syntaxCopy(s: Dsymbol | null): InvariantDeclaration {
        assert(s === null);
        const id = new InvariantDeclaration(this.loc, this.endloc, this.storage_class, null, null);
        super.syntaxCopy(id);
        return id;
    }

    // func.d:1171
    override accept(v: Visitor): void {
        v.visitInvariantDeclaration(this);
    }
}

/***********************************************************
 * dmd/func.d:1180 — `extern (C++) final class UnitTestDeclaration : FuncDeclaration`.
 */
export class UnitTestDeclaration extends FuncDeclaration {
    codedoc: DString | null = null;     // for documented unittest (D `char*` -> byte buffer, 02 §10)

    // toObjFile() these nested functions after this one
    deferredNested!: FuncDeclarations;

    // func.d:1187 — `extern (D) this(Loc loc, Loc endloc, STC stc, char* codedoc)`.
    constructor(loc: Loc, endloc: Loc, stc: STC, codedoc: DString | null) {
        super(loc, endloc, Identifier.generateIdWithLoc(ds("__unittest"), loc), stc, null);
        // D's inline `Array!T` value member starts empty (constructed AS the alias, 08 §3).
        this.deferredNested = new DArray<FuncDeclaration | null>();
        this.codedoc = codedoc;
        this.dsym = DSYM.unitTestDeclaration;
    }

    // func.d:1194
    override syntaxCopy(s: Dsymbol | null): UnitTestDeclaration {
        assert(s === null);
        const utd = new UnitTestDeclaration(this.loc, this.endloc, this.storage_class, this.codedoc);
        super.syntaxCopy(utd);
        return utd;
    }

    // func.d:1202 — `override inout(AggregateDeclaration) isThis() inout`.
    override isThis(): AggregateDeclaration | null {
        return null;
    }

    // func.d:1207
    override accept(v: Visitor): void {
        v.visitUnitTestDeclaration(this);
    }
}

/***********************************************************
 * dmd/func.d:1215 — `extern (C++) final class NewDeclaration : FuncDeclaration`.
 */
export class NewDeclaration extends FuncDeclaration {
    // func.d:1217 — `extern (D) this(Loc loc, STC stc)`.
    constructor(loc: Loc, stc: STC) {
        super(loc, Loc.initial, Id.classNew, (STC.static_ | stc) as STC, null);
        this.dsym = DSYM.newDeclaration;
    }

    // func.d:1223
    override syntaxCopy(s: Dsymbol | null): NewDeclaration {
        assert(s === null);
        const f = new NewDeclaration(this.loc, this.storage_class);
        super.syntaxCopy(f);
        return f;
    }

    // func.d:1231
    override kind(): DString {
        return ds("allocator");
    }

    // func.d:1236
    override accept(v: Visitor): void {
        v.visitNewDeclaration(this);
    }
}

/// dmd/func.d:1249 — `struct AttributeViolation`.
///
/// Stores a reason why a function failed to infer a function attribute like `@safe` or `pure`
///
/// Has two modes:
/// - a regular safety error, stored in `action`
/// - a call to a function without the attribute, which is a special case, because in that case,
///   that function might recursively also have a `AttributeViolation`. This way, in case
///   of a big call stack, the error can go down all the way to the root cause.
///
/// CONSTRUCTOR OVERLOAD SET (04 §1B / §1.1(c)): D declares three constructors whose bodies set
/// DISJOINT fields — `this(Loc, FuncDeclaration)` (func.d:1261), `this(Loc, const(char)*,
/// RootObject[])` (func.d:1263), `this(Loc, const(char)*, VarDeclaration, RootObject[])`
/// (func.d:1277). They are not "the same logic on a prefix of the parameters", so Form-A arity
/// dispatch does not apply; each is promoted to a named static factory and the TS constructor keeps
/// only the D default-initialization path (`AttributeViolation x;`, 03 §6.4) that `copy()` needs.
/// Call sites are rewritten to the factory D's overload resolution already picked.
export class AttributeViolation {
    loc: Loc;                          /// location of error

    fd: FuncDeclaration | null = null; /// function is the focus of the violation

    // -- OR --

    action: DString | null = null;     /// Action that made the attribute fail to get inferred

    scopeVar: VarDeclaration | null = null;  /// For scope violations: the parameter whose scope status caused the issue

    /// D `AttributeViolation x;` — field-wise default init (09 §1.0): `loc` is a value struct
    /// (its own `.init`), the three references are `null`. No D constructor runs on this path.
    constructor() {
        this.loc = new Loc();
    }

    /// func.d:1261 — `this(Loc loc, FuncDeclaration fd)`.
    static fromFuncDeclaration(loc: Loc, fd: FuncDeclaration): AttributeViolation {
        const v = new AttributeViolation();
        v.loc = loc.copy();   // value struct stored into a field (03 §1 #5)
        v.fd = fd;
        return v;
    }

    /// func.d:1263 — `this(Loc loc, const(char)* fmt, RootObject[] args)`.
    static fromFormat(loc: Loc, fmt: DString, args: (RootObject | null)[]): AttributeViolation {
        const v = new AttributeViolation();
        v.loc = loc.copy();   // value struct stored into a field (03 §1 #5)
        assert(args.length <= 4); // expand if necessary
        const buf = new OutBuffer();
        // func.d:1268-1273 — `buf.printf(fmt, <four toErrMsg-or-empty arguments>)`. Each argument
        // is `args[i].toErrMsg()`, the RootObject overload of hdrgen's `toErrMsg` (hdrgen.d:112),
        // reached by UFCS -> `rootObjectToErrMsg` (04 §6.1). An empty/absent argument renders `""`.
        const a0: DString = args.length > 0 && args[0] !== null ? rootObjectToErrMsg(args[0]) : ds(""); // func.d:1269
        const a1: DString = args.length > 1 && args[1] !== null ? rootObjectToErrMsg(args[1]) : ds(""); // func.d:1270
        const a2: DString = args.length > 2 && args[2] !== null ? rootObjectToErrMsg(args[2]) : ds(""); // func.d:1271
        const a3: DString = args.length > 3 && args[3] !== null ? rootObjectToErrMsg(args[3]) : ds(""); // func.d:1272
        buf.printf(fmt, a0, a1, a2, a3);
        v.action = buf.extractSlice();
        return v;
    }

    /// func.d:1277 — `this(Loc loc, const(char)* fmt, VarDeclaration scopeVar, RootObject[] args)`;
    /// the body delegates to the format form and then stores `scopeVar`.
    static fromFormatScopeVar(loc: Loc, fmt: DString, scopeVar: VarDeclaration | null,
                              args: (RootObject | null)[]): AttributeViolation {
        const v = AttributeViolation.fromFormat(loc, fmt, args);
        v.scopeVar = scopeVar;
        return v;
    }

    /// Value-struct copy (03 §2): `loc` is a nested value struct (recurse), the rest are references
    /// / byte slices (share).
    copy(): AttributeViolation {
        const c = new AttributeViolation();
        c.loc = this.loc.copy();
        c.fd = this.fd;
        c.action = this.action;
        c.scopeVar = this.scopeVar;
        return c;
    }
}
