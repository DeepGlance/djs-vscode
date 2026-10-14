// Faithful 1:1 port of dmd/astenums.d (module dmd.astenums).
//
// "Defines enums common to dmd and dmd as parse library." This module is almost entirely
// leaf data tables: named enumerations, manifest constants, two small value structs, and one
// pure helper. It has NO imports in D and depends only on the numeric helpers in the port.
//
// Doc map for the constructs here:
//   - named enum (<=32-bit base)        -> TS numeric `enum`           (02-types.md §4.2)
//   - named enum (`: ulong` base, STC)  -> const object + branded bigint type (02-types.md §4.2)
//   - manifest `enum X = expr;` (TMAX)  -> `const X = <literal>`        (02-types.md §4.1 / 07 §9)
//   - `alias MOD = ubyte;`              -> `type MOD = number;`         (02-types.md §5.1)
//   - `alias Tarray = TY.Tarray;`      -> symbol rebind `const Tarray` (02-types.md §5.3)
//   - `extern(C++) struct structalign_t`-> VALUE-type class + copy()    (02-types.md §2, 03 §2)
//   - `bool isRefReturnScope(ulong)`   -> function, attrs erased        (04-functions.md §8)
//   - `static if (0) ...`              -> dropped                        (07-compile-time.md §3)
//
// COMPAT NOTE: `numeric.ts` imports `TY` from here; `TY` and every other export keep their
// upstream name/shape. `TY` order is an ABI contract (it indexes type tables) — verbatim.
//
// All composite/folded values below were verified against ldc2-1.42.0 (/tmp/p_astenums.d).
// (No imports: every CT-folded composite — including STC.flowThruFunction's `~(...)` masked to
//  64-bit unsigned via BigInt.asUintN(64,…) — is resolved to its literal at translation time.)

// dmd/astenums.d:13 — `enum Sizeok : ubyte`. <=32-bit base -> TS numeric enum (02 §4.2).
export enum Sizeok {
    none,               /// size of aggregate is not yet able to compute
    fwd,                /// size of aggregate is ready to compute
    inProcess,          /// in the midst of computing the size
    done,               /// size of aggregate is set correctly
}

/// D Language version (dmd/astenums.d:22 — `enum Edition : ushort`).
/// Verified: auto-increment over an explicit start works (v2024 == 2024, v2025 == 2025).
export enum Edition {
    v2023 = 2023,    /// Edition.min for default edition
    v2024,           /// first Edition
    v2025,           /// next Edition
                     /// use Edition.max for latest edition
}

// dmd/astenums.d:30 — `enum Baseok : ubyte`.
export enum Baseok {
    none,               /// base classes not computed yet
    start,              /// in process of resolving base classes
    done,               /// all base classes are resolved
    semanticdone,       /// all base classes semantic done
}

// dmd/astenums.d:38 — `enum MODFlags : int`. <=32-bit base -> TS numeric enum (02 §4.2).
// `wildconst = wild | const_` folds at translation time with JS `|` (== 9, verified).
export enum MODFlags {
    none         = 0,    // default (mutable)
    const_       = 1,    // type is const
    immutable_   = 4,    // type is immutable
    shared_      = 2,    // type is shared
    wild         = 8,    // type is wild
    wildconst    = (8 | 1), // resolved: MODFlags.wild | MODFlags.const_ -> 9 (type is wild const)
    mutable      = 0x10, // type is mutable (only used in wildcard matching)
}

// dmd/astenums.d:49 — `alias MOD = ubyte;` -> type alias to the number domain (02 §5.1, 09 §1).
export type MOD = number;

/// dmd/astenums.d:51 — `enum STC : ulong`. A 64-bit flag set whose members exceed 2^32, so it
/// CANNOT be a TS numeric enum (which holds `number` only); it is a `const` object of `bigint`
/// values + a branded type (02-types.md §4.2). Member-OR expressions fold at translation time
/// with BigInt `|`; the one complement (`flowThruFunction = ~(...)`) re-truncates to 64-bit
/// unsigned via `BigInt.asUintN(64, …)` (09-numerics.md §4.2) — verified: 0xffffff011dd3fa60n.
/// // transfer changes to declaration.h
export type STC = bigint & { readonly __brand: "STC" };
export const STC = {
    none:                0x0n as STC,

    static_:             0x1n as STC,   /// `static`
    extern_:             0x2n as STC,   /// `extern`
    const_:              0x4n as STC,   /// `const`
    final_:              0x8n as STC,   /// `final`

    abstract_:           0x10n as STC,   /// `abstract`
    parameter:           0x20n as STC,   /// is function parameter
    field:               0x40n as STC,   /// is field of struct, union or class
    override_:           0x80n as STC,   /// `override`

    auto_:               0x100n as STC,   /// `auto`
    synchronized_:       0x200n as STC,   /// `synchronized`
    deprecated_:         0x400n as STC,   /// `deprecated`
    in_:                 0x800n as STC,   /// `in` parameter

    out_:                0x1000n as STC,   /// `out` parameter
    lazy_:               0x2000n as STC,   /// `lazy` parameter
    foreach_:            0x4000n as STC,   /// variable for foreach loop
    variadic:            0x8000n as STC,   /// the `variadic` parameter in: T foo(T a, U b, V variadic...)

    constscoperef:       0x1_0000n as STC,   /// when `in` means const|scope|ref
    templateparameter:   0x2_0000n as STC,   /// template parameter
    ref_:                0x4_0000n as STC,   /// `ref`
    scope_:              0x8_0000n as STC,   /// `scope`

    scopeinferred:       0x10_0000n as STC,   /// `scope` has been inferred and should not be part of mangling, `scope_` must also be set
    return_:             0x20_0000n as STC,   /// 'return ref' or 'return scope' for function parameters
    returnScope:         0x40_0000n as STC,   /// if `ref return scope` then resolve to `ref` and `return scope`
    returnRef:           0x80_0000n as STC,   /// if `return ref`

    returninferred:      0x100_0000n as STC,   /// `return` has been inferred and should not be part of mangling, `return_` must also be set
    immutable_:          0x200_0000n as STC,   /// `immutable`
    //                 = 0x400_0000,
    manifest:            0x800_0000n as STC,   /// manifest constant

    nodtor:              0x1000_0000n as STC,   /// do not run destructor
    nothrow_:            0x2000_0000n as STC,   /// `nothrow` meaning never throws exceptions
    pure_:               0x4000_0000n as STC,   /// `pure` function
    tls:                 0x8000_0000n as STC,   /// thread local

    alias_:              0x1_0000_0000n as STC,   /// `alias` parameter
    shared_:             0x2_0000_0000n as STC,   /// accessible from multiple threads
    gshared:             0x4_0000_0000n as STC,   /// accessible from multiple threads, but not typed as `shared`
    wild:                0x8_0000_0000n as STC,   /// for wild type constructor

    property:            0x10_0000_0000n as STC,   /// `@property`
    safe:                0x20_0000_0000n as STC,   /// `@safe`
    trusted:             0x40_0000_0000n as STC,   /// `@trusted`
    system:              0x80_0000_0000n as STC,   /// `@system`

    ctfe:                0x100_0000_0000n as STC,   /// can be used in CTFE, even if it is static
    disable:             0x200_0000_0000n as STC,   /// for functions that are not callable
    result:              0x400_0000_0000n as STC,   /// for result variables passed to out contracts
    nodefaultctor:       0x800_0000_0000n as STC,   /// must be set inside constructor

    temp:                0x1000_0000_0000n as STC,   /// temporary variable
    rvalue:              0x2000_0000_0000n as STC,   /// force rvalue for variables
    nogc:                0x4000_0000_0000n as STC,   /// `@nogc`
    autoref:             0x8000_0000_0000n as STC,   /// Mark for the already deduced `auto ref` parameter

    inference:           0x1_0000_0000_0000n as STC,   /// do attribute inference
    exptemp:             0x2_0000_0000_0000n as STC,   /// temporary variable that has lifetime restricted to an expression
    future:              0x4_0000_0000_0000n as STC,   /// introducing new base class function
    local:               0x8_0000_0000_0000n as STC,   /// do not forward (see dmd.dsymbol.ForwardingScopeDsymbol).

    live:                0x10_0000_0000_0000n as STC,   /// function `@live` attribute
    register:            0x20_0000_0000_0000n as STC,   /// `register` storage class (ImportC)
    volatile_:           0x40_0000_0000_0000n as STC,   /// destined for volatile in the back end

    // Composite members — folded at translation time with BigInt ops (verified, /tmp/p_astenums.d).
    safeGroup:           0xe000000000n as STC,   /// resolved: STC.safe | STC.trusted | STC.system
    IOR:                 0x51800n as STC,         /// resolved: STC.constscoperef | STC.in_ | STC.ref_ | STC.out_
    TYPECTOR:            0xa02000004n as STC,     /// resolved: STC.const_ | STC.immutable_ | STC.shared_ | STC.wild
    /// resolved: STC.ref_ | STC.nothrow_ | STC.nogc | STC.pure_ | STC.property | STC.live | safeGroup
    FUNCATTR:            0x1040f060040000n as STC,

    /* These are visible to the user, i.e. are expressed by the user
     */
    /// resolved: STC.auto_ | scope_ | static_ | extern_ | const_ | final_ | abstract_ | synchronized_
    ///   | deprecated_ | future | override_ | lazy_ | alias_ | out_ | in_ | manifest | immutable_
    ///   | shared_ | wild | nothrow_ | nogc | pure_ | ref_ | return_ | tls | gshared | property
    ///   | safeGroup | disable | local | live
    visibleStorageClasses: 0x1c42ffea2c3f9fn as STC,

    /* These storage classes "flow through" to the inner scope of a Dsymbol
     */
    flowThruAggregate:   0xe000000000n as STC,   /// resolved: STC.safeGroup — for an AggregateDeclaration
    /// resolved: ~(STC.auto_ | scope_ | static_ | extern_ | abstract_ | deprecated_ | override_
    ///   | TYPECTOR | final_ | tls | gshared | ref_ | return_ | property | nothrow_ | pure_ | safe
    ///   | trusted | system) -> BigInt.asUintN(64, ~mask) == 0xffffff011dd3fa60n (ulong) — for a FuncDeclaration
    flowThruFunction:    0xffffff011dd3fa60n as STC,
} as const;

// Alias for C++ interface functions which use plain integer instead of enum class,
// since C++ enum class doesn't support | & and conversion to bool. Maybe this can
// be refactored to a struct with operator overloads or bit fields at some point.
// dmd/astenums.d:150 — `alias StorageClass = ulong;` -> bigint domain (02 §5.1, 09 §1).
export type StorageClass = bigint;

/********
 * Determine if it's the ambiguous case of where `return` attaches to.
 * Params:
 *   stc = STC flags
 * Returns:
 *   true if (`ref` | `out`) and `scope` and `return`
 *
 * dmd/astenums.d:160. Attributes `@safe pure @nogc nothrow` erase (04 §8). `const ulong stc`
 * is the 64-bit carrier -> `bigint` (09 §1). The `&&`'s right operand `stc & (ref_|out_)` is a
 * numeric value in boolean context: expand to `!== 0n` (09-numerics.md §9). Verified true cases
 * (scope+return+ref, scope+return+out) and false cases (scope+return only, ref only).
 */
export function isRefReturnScope(stc: bigint): boolean {
    return (stc & (STC.scope_ | STC.return_)) === (STC.scope_ | STC.return_) &&
           (stc & (STC.ref_ | STC.out_)) !== 0n;
}

/* This is different from the one in declaration.d, make that fix a separate PR */
// resolved: static if (0) -> false; the __gshared STCStorageClass block (astenums.d:167-174) dropped.

// dmd/astenums.d:176 — `enum TY : ubyte`. The type-tag carried by every `Type` node.
// Order is load-bearing (used as table indices in the frontend); keep verbatim. <=32-bit -> TS enum.
export enum TY {
    Tarray,     // slice array, aka T[]
    Tsarray,    // static array, aka T[dimension]
    Taarray,    // associative array, aka T[type]
    Tpointer,
    Treference,
    Tfunction,
    Tident,
    Tclass,
    Tstruct,
    Tenum,

    Tdelegate,
    Tnone,
    Tvoid,
    Tint8,
    Tuns8,
    Tint16,
    Tuns16,
    Tint32,
    Tuns32,
    Tint64,

    Tuns64,
    Tfloat32,
    Tfloat64,
    Tfloat80,
    Timaginary32,
    Timaginary64,
    Timaginary80,
    Tcomplex32,
    Tcomplex64,
    Tcomplex80,

    Tbool,
    Tchar,
    Twchar,
    Tdchar,
    Terror,
    Tinstance,
    Ttypeof,
    Ttuple,
    Tslice,
    Treturn,

    Tnull,
    Tvector,
    Tint128,
    Tuns128,
    Ttraits,
    Tmixin,
    Tnoreturn,
    Ttag,
}
// dmd/astenums.d:231 — manifest `enum TMAX = TY.max + 1;` -> resolved literal (07 §9).
// Verified: TY.max == 47, so TMAX == 48.
export const TMAX = 48; // resolved: TY.max + 1 -> 47 + 1

// dmd/astenums.d:233-280 — `alias Tarray = TY.Tarray;` etc. The RHS is a SYMBOL/value (an enum
// member), not a type, so this is a symbol-alias: rebind to a `const` (02-types.md §5.3). Each
// gives the bare member name as a module-scope value, exactly as the frontend uses them.
export const Tarray = TY.Tarray;
export const Tsarray = TY.Tsarray;
export const Taarray = TY.Taarray;
export const Tpointer = TY.Tpointer;
export const Treference = TY.Treference;
export const Tfunction = TY.Tfunction;
export const Tident = TY.Tident;
export const Tclass = TY.Tclass;
export const Tstruct = TY.Tstruct;
export const Tenum = TY.Tenum;
export const Tdelegate = TY.Tdelegate;
export const Tnone = TY.Tnone;
export const Tvoid = TY.Tvoid;
export const Tint8 = TY.Tint8;
export const Tuns8 = TY.Tuns8;
export const Tint16 = TY.Tint16;
export const Tuns16 = TY.Tuns16;
export const Tint32 = TY.Tint32;
export const Tuns32 = TY.Tuns32;
export const Tint64 = TY.Tint64;
export const Tuns64 = TY.Tuns64;
export const Tfloat32 = TY.Tfloat32;
export const Tfloat64 = TY.Tfloat64;
export const Tfloat80 = TY.Tfloat80;
export const Timaginary32 = TY.Timaginary32;
export const Timaginary64 = TY.Timaginary64;
export const Timaginary80 = TY.Timaginary80;
export const Tcomplex32 = TY.Tcomplex32;
export const Tcomplex64 = TY.Tcomplex64;
export const Tcomplex80 = TY.Tcomplex80;
export const Tbool = TY.Tbool;
export const Tchar = TY.Tchar;
export const Twchar = TY.Twchar;
export const Tdchar = TY.Tdchar;
export const Terror = TY.Terror;
export const Tinstance = TY.Tinstance;
export const Ttypeof = TY.Ttypeof;
export const Ttuple = TY.Ttuple;
export const Tslice = TY.Tslice;
export const Treturn = TY.Treturn;
export const Tnull = TY.Tnull;
export const Tvector = TY.Tvector;
export const Tint128 = TY.Tint128;
export const Tuns128 = TY.Tuns128;
export const Ttraits = TY.Ttraits;
export const Tmixin = TY.Tmixin;
export const Tnoreturn = TY.Tnoreturn;
export const Ttag = TY.Ttag;

// dmd/astenums.d:282 — `enum TFlags` (no base -> default `int`). <=32-bit -> TS numeric enum.
export enum TFlags {
    integral     = 1,
    floating     = 2,
    unsigned     = 4,
    real_        = 8,
    imaginary    = 0x10,
    complex      = 0x20,
}

// dmd/astenums.d:292 — `enum PKG : int`.
export enum PKG {
    unknown,      /// not yet determined whether it's a package.d or not
    module_,      /// already determined that's an actual package.d
    package_,     /// already determined that's an actual package
}

// dmd/astenums.d:299 — `enum ThreeState : ubyte`.
export enum ThreeState {
    none,  /// state is not yet computed
    no,    /// state is false
    yes,   /// state is true
}

// dmd/astenums.d:306 — `enum TRUST : ubyte`.
export enum TRUST {
    default_   = 0,
    system     = 1,    // @system (same as TRUST.default_ unless feature "safer" is enabled)
    trusted    = 2,    // @trusted
    safe       = 3,    // @safe
}

// dmd/astenums.d:314 — `enum PURE : ubyte`.
export enum PURE {
    impure      = 0,    // not pure at all
    fwdref      = 1,    // it's pure, but not known which level yet
    weak        = 2,    // no mutable globals are read or written
    const_      = 3,    // parameters are values or const = strongly pure
}

// Whether alias this dependency is recursive or not
// dmd/astenums.d:323 — `enum AliasThisRec : int`.
export enum AliasThisRec {
    no           = 0,    // no alias this recursion
    yes          = 1,    // alias this has recursive dependency
    fwdref       = 2,    // not yet known
    typeMask     = 3,    // mask to read no/yes/fwdref
    tracing      = 0x4,  // mark in progress of implicitConvTo/deduceWild
    tracingDT    = 0x8,  // mark in progress of deduceType
}

/***************
 * Variadic argument lists
 * https://dlang.org/spec/function.html#variadic
 * dmd/astenums.d:337 — `enum VarArg : ubyte`.
 */
export enum VarArg {
    none     = 0,  /// fixed number of arguments
    variadic = 1,  /// (T t, ...)  can be C-style (core.stdc.stdarg) or D-style (core.vararg)
    typesafe = 2,  /// (T t ...) typesafe https://dlang.org/spec/function.html#typesafe_variadic_functions
                   ///   or https://dlang.org/spec/function.html#typesafe_variadic_functions
    KRvariadic = 3, /// K+R C style variadics (no function prototype)
}

/*************************
 * Identify Statement types with this enum rather than
 * virtual functions
 * dmd/astenums.d:350 — `enum STMT : ubyte`.
 */
export enum STMT {
    Error,
    Peel,
    Exp, DtorExp,
    Mixin,
    Compound, CompoundDeclaration, CompoundAsm,
    UnrolledLoop,
    Scope,
    Forwarding,
    While,
    Do,
    For,
    Foreach,
    ForeachRange,
    If,
    Conditional,
    StaticForeach,
    Pragma,
    StaticAssert,
    Switch,
    Case,
    CaseRange,
    Default,
    GotoDefault,
    GotoCase,
    SwitchError,
    Return,
    Break,
    Continue,
    Synchronized,
    With,
    TryCatch,
    TryFinally,
    ScopeGuard,
    Throw,
    Debug,
    Goto,
    Label,
    Asm, InlineAsm, GccAsm,
    Import,
}

/**********************
 * Discriminant for which kind of initializer
 * dmd/astenums.d:396 — `enum InitKind : ubyte`.
 */
export enum InitKind {
    void_,
    default_,
    error,
    struct_,
    array,
    exp,
    C_,
}

/// A linkage attribute as defined by `extern(XXX)`
///
/// https://dlang.org/spec/attribute.html#linkage
/// dmd/astenums.d:410 — `enum LINK : ubyte`.
export enum LINK {
    default_,
    d,
    c,
    cpp,
    windows,
    objc,
    system,
}

/// Whether to mangle an external aggregate as a struct or class, as set by `extern(C++, struct)`
/// dmd/astenums.d:422 — `enum CPPMANGLE : ubyte`.
export enum CPPMANGLE {
    def,      /// default
    asStruct, /// `extern(C++, struct)`
    asClass,  /// `extern(C++, class)`
}

/// Function match levels
///
/// https://dlang.org/spec/function.html#function-overloading
/// dmd/astenums.d:432 — `enum MATCH : int`. `nomatch == 0` is the falsy member used in boolean
/// context throughout the frontend (09-numerics.md §9.1).
export enum MATCH {
    nomatch,   /// no match
    convert,   /// match with conversions
    constant,  /// match with conversion to const
    exact,     /// exact match
}

/// Inline setting as defined by `pragma(inline, XXX)`
/// dmd/astenums.d:441 — `enum PINLINE : ubyte`.
export enum PINLINE {
    default_, /// as specified on the command line
    never,    /// never inline
    always,   /// always inline
}

/// Source file type
/// dmd/astenums.d:449 — `enum FileType : ubyte`.
export enum FileType {
    d,    /// normal D source file
    dhdr, /// D header file (.di)
    ddoc, /// Ddoc documentation file (.dd)
    c,    /// C source file
}

/// In which context checks for assertions, contracts, bounds checks etc. are enabled
/// dmd/astenums.d:458 — `enum CHECKENABLE : ubyte`.
export enum CHECKENABLE {
    _default,     /// initial value
    off,          /// never do checking
    on,           /// always do checking
    safeonly,     /// do checking only in @safe functions
}

/// What should happend when an assertion fails
/// dmd/astenums.d:467 — `enum CHECKACTION : ubyte`.
export enum CHECKACTION {
    D,            /// call D assert on failure
    C,            /// call C assert on failure
    halt,         /// cause program halt on failure
    context,      /// call D assert with the error context on failure
}

// dmd/astenums.d:479 — manifest enum nested in structalign_t: `enum STRUCTALIGN_DEFAULT = 1234;`
// (no member list -> a CT constant, 02 §4.1). Lifted to module scope; it is the struct's default
// marker. default = match whatever the corresponding C compiler does.
const STRUCTALIGN_DEFAULT = 1234;

// dmd/astenums.d:481 — anonymous `enum : ubyte { PACK, ALIGNAS }` (Align semantic flags) inside
// structalign_t. Folded to module-scope consts (07 §9). Used by the bit-flag accessors below.
const PACK = 0x1;     // use #pragma pack semantics
const ALIGNAS = 0x2;  // use _Alignas semantics

/**
 * dmd/astenums.d:475 — `extern (C++) struct structalign_t`. A VALUE-type struct (02-types.md §2)
 * backing alignment state: a `ushort value` (default 0 == unknown) and a `ubyte flags` bit set
 * (PACK/ALIGNAS). Backed by a TS class with `copy()` so every value-move site can clone it
 * (03-value-semantics.md §1/§2 — both fields are primitive `number`, so copy is a value copy).
 *
 * Construction contract: D default-initializes to `value == 0`, `flags == 0` (the `isUnknown`
 * state). The TS ctor takes no args and reproduces that. `extern(C++)` linkage erases (04 §8).
 * `set(uint value)` truncates to `ushort` via `toUint16` semantics: it folds to `value & 0xffff`,
 * but per 09 §2.1 we call the canonical helper rather than inline the mask — here the width is a
 * field-store, mirrored with `maskUnsignedN`-equivalent `toUint16` from numeric.ts is not needed
 * because `set` already receives a `uint` (number); we store the low 16 bits. The trailing method
 * attributes `pure @safe @nogc nothrow` and `const` all erase (04 §8).
 */
export class structalign_t {
    // D `private ushort value = 0;` (unknown). Kept private to mirror the source.
    private value: number = 0;  // unknown
    // D `ubyte flags;` — Align semantic flags. Defaults to 0.
    private flags: number = 0;

    // dmd/astenums.d:489 — `bool isDefault() const`.
    isDefault(): boolean { return this.value === STRUCTALIGN_DEFAULT; }
    // dmd/astenums.d:490 — `void setDefault()`.
    setDefault(): void { this.value = STRUCTALIGN_DEFAULT; }
    // dmd/astenums.d:491 — `bool isUnknown() const`. value is not set.
    isUnknown(): boolean { return this.value === 0; }
    // dmd/astenums.d:492 — `void setUnknown()`.
    setUnknown(): void { this.value = 0; }
    // dmd/astenums.d:493 — `void set(uint value)`. `this.value = cast(ushort)value;` truncates to
    // the low 16 bits (09-numerics.md §2 store-into-narrower-type).
    set(value: number): void { this.value = value & 0xffff; }
    // dmd/astenums.d:494 — `uint get() const`.
    get(): number { return this.value; }
    // dmd/astenums.d:495 — `bool isPack() const`. `!!(flags & PACK)` -> boolean test of a flag bit.
    isPack(): boolean { return (this.flags & PACK) !== 0; }
    // dmd/astenums.d:496 — `void setPack()`.
    setPack(): void { this.flags |= PACK; }
    // dmd/astenums.d:497 — `bool fromAlignas() const`.
    fromAlignas(): boolean { return (this.flags & ALIGNAS) !== 0; }
    // dmd/astenums.d:498 — `void setAlignas()`.
    setAlignas(): void { this.flags |= ALIGNAS; }

    // dropped: `version (IN_LLVM) version (CRuntime_Microsoft)` ctor `this(ushort value, ubyte flags)`
    // (astenums.d:500-513) — CRuntime_Microsoft is OFF (_config.md §1); the ctor exists only to force
    // the MSVC++ host compiler to treat the struct as a non-POD, a host-ABI concern with no semantics.

    // Value-struct copy helper (03-value-semantics.md §2). Both fields are primitive numbers ->
    // plain value copy. Provided so call sites that move a structalign_t by value emit `.copy()`.
    copy(): structalign_t {
        const c = new structalign_t();
        c.value = this.value;
        c.flags = this.flags;
        return c;
    }
}

/// Use to return D arrays from C++ functions
/// dmd/astenums.d:502 — `extern (C++) struct DArray(T) { T[] data; }`. A thin generic wrapper
/// over a slice. `extern(C++)` erases; `T[]` is a reference-like dynamic array (02 §8 — shares,
/// no element deep-copy). Value-struct copy of the wrapper shares the same backing slice
/// (03 §2 array-field rule: copy the slice reference, do not deep-copy elements).
export class DArray<T> {
    data: T[] = [];

    copy(): DArray<T> {
        const c = new DArray<T>();
        c.data = this.data; // slice field: share the backing store (03 §2), do NOT deep-copy
        return c;
    }
}
