// Ported from dmd/tokens.d (module dmd.tokens).
//
// Defines the lexer's core token types: the TOK enum, the EXP (expression-op) enum, the keyword
// table, the per-TOK display-string table, and the value-semantics `Token` struct.
//
// CYCLE A (id <-> identifier <-> tokens): this module value-imports `Identifier` (used only inside
// `initTokens()` and `Token.isKeyword`/`toString`, which run post-load) and type-imports the rest.
// Per 01 §4.3 a value import across the cycle is safe as long as nothing is read/constructed at the
// top level of this module — and nothing is (the keyword-pool build is in the init function, 01 §5.2).

import type { Loc } from "./location.js";
import { OutBuffer } from "./common/outbuffer.js";
import { CTFloat } from "./root/ctfloat.js";
import type { real_t } from "./root/ctfloat.js";
import { utf_decodeChar } from "./root/utf.js";
import { Identifier } from "./identifier.js";
import { Loc as LocCtor } from "./location.js"; // value import: Token.loc default = new Loc()
import { ds, dsConcat } from "../dstring.js";
import type { DString } from "../dstring.js";
import { toInt64, toUint64, toUint32, maskSignedN, maskUnsignedN } from "../numeric.js";
import { assert } from "../assert.js";

/**
 * Token kinds (dmd/tokens.d:26, `enum TOK : ubyte`).
 *
 * Base is `ubyte` (≤32-bit) -> TS numeric enum (02 §4.2), `number` domain. The members are
 * consecutive from 0 (`reserved`) in declaration order; their integer values are OBSERVABLE — they
 * index `Token.tochars`/`Ckeywords` and are compared against named members throughout the lexer —
 * so the ORDER is contract. Do not reorder or insert. (The `tokens.h`/cxxfrontend cross-file
 * consecutiveness invariant is checked by a CT static-assert in the source — see the resolved note
 * below; it emits no runtime code.)
 *
 * D-keyword spellings carry their D source escaping verbatim (01 §2.1): `cast_`, `null_`, `this_`,
 * etc. — these are already-valid TS identifiers; do not "tidy" them.
 */
export enum TOK {
    reserved,

    // if this list changes, update
    // tokens.h, ../tests/cxxfrontend.cc and ../../test/unit/lexer/location_offset.d to match

    // Other
    leftParenthesis,
    rightParenthesis,
    leftBracket,
    rightBracket,
    leftCurly,
    rightCurly,
    colon,
    semicolon,
    dotDotDot,
    endOfFile,
    cast_,
    null_,
    assert_,
    true_,
    false_,
    throw_,
    new_,
    variable,
    slice,
    version_,
    module_,
    dollar,
    template_,
    typeof_,
    pragma_,
    typeid_,
    comment,

    // Operators
    lessThan,
    greaterThan,
    lessOrEqual,
    greaterOrEqual,
    equal,
    notEqual,
    identity,
    notIdentity,
    is_,

    leftShift,
    rightShift,
    leftShiftAssign,
    rightShiftAssign,
    unsignedRightShift,
    unsignedRightShiftAssign,
    concatenateAssign, // ~=
    add,
    min,
    addAssign,
    minAssign,
    mul,
    div,
    mod,
    mulAssign,
    divAssign,
    modAssign,
    and,
    or,
    xor,
    andAssign,
    orAssign,
    xorAssign,
    assign,
    not,
    tilde,
    plusPlus,
    minusMinus,
    dot,
    comma,
    question,
    andAnd,
    orOr,

    // Numeric literals
    int32Literal,
    uns32Literal,
    int64Literal,
    uns64Literal,
    int128Literal,
    uns128Literal,
    float32Literal,
    float64Literal,
    float80Literal,
    imaginary32Literal,
    imaginary64Literal,
    imaginary80Literal,

    // Char constants
    charLiteral,
    wcharLiteral,
    dcharLiteral,

    // Leaf operators
    identifier,
    string_,
    interpolated,
    hexadecimalString,
    this_,
    super_,
    error,

    // Basic types
    void_,
    int8,
    uns8,
    int16,
    uns16,
    int32,
    uns32,
    int64,
    uns64,
    int128,
    uns128,
    float32,
    float64,
    float80,
    imaginary32,
    imaginary64,
    imaginary80,
    complex32,
    complex64,
    complex80,
    char_,
    wchar_,
    dchar_,
    bool_,

    // Aggregates
    struct_,
    class_,
    interface_,
    union_,
    enum_,
    import_,
    alias_,
    override_,
    delegate_,
    function_,
    mixin_,
    align_,
    extern_,
    private_,
    protected_,
    public_,
    export_,
    static_,
    final_,
    const_,
    abstract_,
    debug_,
    deprecated_,
    in_,
    out_,
    inout_,
    lazy_,
    auto_,
    package_,
    immutable_,

    // Statements
    if_,
    else_,
    while_,
    for_,
    do_,
    switch_,
    case_,
    default_,
    break_,
    continue_,
    with_,
    synchronized_,
    return_,
    goto_,
    try_,
    catch_,
    finally_,
    asm_,
    foreach_,
    foreach_reverse_,
    scope_,
    onScopeExit,
    onScopeFailure,
    onScopeSuccess,

    // Contracts
    invariant_,

    // Testing
    unittest_,

    // Added after 1.0
    argumentTypes,
    ref_,
    macro_,

    parameters,
    traits,
    pure_,
    nothrow_,
    gshared,
    line,
    file,
    fileFullPath,
    moduleString, // __MODULE__
    functionString, // __FUNCTION__
    prettyFunction, // __PRETTY_FUNCTION__
    shared_,
    at,
    pow,
    powAssign,
    goesTo,
    vector,
    pound,

    arrow, // ->
    colonColon, // ::
    wchar_tLiteral,
    endOfLine, // \n, \r, U+2028, U+2029
    whitespace,
    rvalue,

    // C only keywords
    inline,
    register,
    restrict,
    signed,
    sizeof_,
    typedef_,
    unsigned,
    volatile,
    _Alignas,
    _Alignof,
    _Atomic,
    _Bool,
    _Complex,
    _Generic,
    _Imaginary,
    _Noreturn,
    _Static_assert,
    _Thread_local,

    // C only extended keywords
    _assert,
    _import,
    _module,
    __cdecl,
    __declspec,
    __stdcall,
    __thread,
    __pragma,
    __int128,
    __attribute__,
}

/// The highest TOK enum value (D `TOK.max`). Used to size `tochars` / `Ckeywords` (`TOK.max + 1`).
const TOK_max = TOK.__attribute__;

/**
 * Expression-operator kinds (dmd/tokens.d:290, `enum EXP : ubyte`).
 *
 * Base `ubyte` -> TS numeric enum (02 §4.2). Consecutive from 0 (`reserved`); values are observable
 * (CTFE/sema switch on `e.op`), so the order is contract. Do not reorder. Carried verbatim into this
 * batch because `EXP` is declared in `tokens.d`; the AST nodes that read it are translated later.
 */
export enum EXP {
    reserved,

    // Other
    negate,
    cast_,
    null_,
    assert_,
    array,
    call,
    address,
    type,
    throw_,
    new_,
    delete_,
    star,
    symbolOffset,
    variable,
    dotVariable,
    dotIdentifier,
    dotTemplateInstance,
    dotType,
    slice,
    arrayLength,
    dollar,
    template_,
    dotTemplateDeclaration,
    declaration,
    dSymbol,
    typeid_,
    uadd,
    remove,
    newAnonymousClass,
    arrayLiteral,
    assocArrayLiteral,
    structLiteral,
    classReference,
    thrownException,
    delegatePointer,
    delegateFunctionPointer,

    // Operators
    lessThan,
    greaterThan,
    lessOrEqual,
    greaterOrEqual,
    equal,
    notEqual,
    identity,
    notIdentity,
    index,
    is_,

    leftShift,
    rightShift,
    leftShiftAssign,
    rightShiftAssign,
    unsignedRightShift,
    unsignedRightShiftAssign,
    concatenate,
    concatenateAssign, // ~=
    concatenateElemAssign,
    concatenateDcharAssign,
    add,
    min,
    addAssign,
    minAssign,
    mul,
    div,
    mod,
    mulAssign,
    divAssign,
    modAssign,
    and,
    or,
    xor,
    andAssign,
    orAssign,
    xorAssign,
    assign,
    not,
    tilde,
    plusPlus,
    minusMinus,
    construct,
    blit,
    dot,
    comma,
    question,
    andAnd,
    orOr,
    prePlusPlus,
    preMinusMinus,

    // Leaf operators
    identifier,
    string_,
    interpolated,
    this_,
    super_,
    halt,
    tuple,
    error,

    // Basic types
    void_,
    int64,
    float64,
    complex80,
    import_,
    delegate_,
    function_,
    mixin_,
    in_,
    break_,
    continue_,
    goto_,
    scope_,

    traits,
    overloadSet,
    line,
    file,
    fileFullPath,
    moduleString, // __MODULE__
    functionString, // __FUNCTION__
    prettyFunction, // __PRETTY_FUNCTION__
    pow,
    powAssign,
    vector,

    voidExpression,
    cantExpression,
    showCtfeContext,
    objcClassReference,
    vectorArray,
    compoundLiteral, // ( type-name ) { initializer-list }
    _Generic,
    interval,

    loweredAssignExp,
    rvalue,
}

/// dmd/tokens.d:435 — `enum FirstCKeyword = TOK.inline;` (manifest constant, 02 §4.1 -> const).
export const FirstCKeyword = TOK.inline;

// resolved: static assert (TOK members consecutive, tokens.d:439) -> holds at translation time
// (the enum is declared consecutively from 0); the CT `foreach`+`__traits(allMembers/getMember)`
// invariant check emits NO runtime code (07 §7.2).

/****************************************
 */

/// The keyword TOKs, in source order (dmd/tokens.d:454). `initTokens()` interns one Identifier per
/// keyword. `private immutable` in D -> module-private here.
const keywords: TOK[] = [
    TOK.this_,
    TOK.super_,
    TOK.assert_,
    TOK.null_,
    TOK.true_,
    TOK.false_,
    TOK.cast_,
    TOK.new_,
    TOK.throw_,
    TOK.module_,
    TOK.pragma_,
    TOK.typeof_,
    TOK.typeid_,
    TOK.template_,
    TOK.void_,
    TOK.int8,
    TOK.uns8,
    TOK.int16,
    TOK.uns16,
    TOK.int32,
    TOK.uns32,
    TOK.int64,
    TOK.uns64,
    TOK.int128,
    TOK.uns128,
    TOK.float32,
    TOK.float64,
    TOK.float80,
    TOK.bool_,
    TOK.char_,
    TOK.wchar_,
    TOK.dchar_,
    TOK.imaginary32,
    TOK.imaginary64,
    TOK.imaginary80,
    TOK.complex32,
    TOK.complex64,
    TOK.complex80,
    TOK.delegate_,
    TOK.function_,
    TOK.is_,
    TOK.if_,
    TOK.else_,
    TOK.while_,
    TOK.for_,
    TOK.do_,
    TOK.switch_,
    TOK.case_,
    TOK.default_,
    TOK.break_,
    TOK.continue_,
    TOK.synchronized_,
    TOK.return_,
    TOK.goto_,
    TOK.try_,
    TOK.catch_,
    TOK.finally_,
    TOK.with_,
    TOK.asm_,
    TOK.foreach_,
    TOK.foreach_reverse_,
    TOK.scope_,
    TOK.struct_,
    TOK.class_,
    TOK.interface_,
    TOK.union_,
    TOK.enum_,
    TOK.import_,
    TOK.mixin_,
    TOK.static_,
    TOK.final_,
    TOK.const_,
    TOK.alias_,
    TOK.override_,
    TOK.abstract_,
    TOK.debug_,
    TOK.deprecated_,
    TOK.in_,
    TOK.out_,
    TOK.inout_,
    TOK.lazy_,
    TOK.auto_,
    TOK.align_,
    TOK.extern_,
    TOK.private_,
    TOK.package_,
    TOK.protected_,
    TOK.public_,
    TOK.export_,
    TOK.invariant_,
    TOK.unittest_,
    TOK.version_,
    TOK.argumentTypes,
    TOK.parameters,
    TOK.ref_,
    TOK.macro_,
    TOK.pure_,
    TOK.nothrow_,
    TOK.gshared,
    TOK.traits,
    TOK.vector,
    TOK.file,
    TOK.fileFullPath,
    TOK.line,
    TOK.moduleString,
    TOK.functionString,
    TOK.prettyFunction,
    TOK.shared_,
    TOK.immutable_,
    TOK.rvalue,

    // C only keywords
    TOK.inline,
    TOK.register,
    TOK.restrict,
    TOK.signed,
    TOK.sizeof_,
    TOK.typedef_,
    TOK.unsigned,
    TOK.volatile,
    TOK._Alignas,
    TOK._Alignof,
    TOK._Atomic,
    TOK._Bool,
    TOK._Complex,
    TOK._Generic,
    TOK._Imaginary,
    TOK._Noreturn,
    TOK._Static_assert,
    TOK._Thread_local,

    // C only extended keywords
    TOK._assert,
    TOK._import,
    TOK._module,
    TOK.__cdecl,
    TOK.__declspec,
    TOK.__stdcall,
    TOK.__thread,
    TOK.__pragma,
    TOK.__int128,
    TOK.__attribute__,
];

/**
 * Initialize the identifier pool with the keyword identifiers (dmd/tokens.d:601,
 * `shared static this()`). Ported to an exported init function per 01 §5: the CLI shim calls it
 * once, in import-graph order, AFTER the identifier module is ready (tokens' ctor calls
 * `Identifier.initTable()`/`idPool`, so `initIdentifier` — if any — precedes this; 01 §5.2).
 *
 * ORDER CONTRACT: this MUST run BEFORE `Id.initialize()`. `Identifier.initTable()` re-creates the
 * interning table, orphaning every previously-interned singleton — `Id.*` identity compares
 * (`ident === Id.stringof` etc.) silently go dead if `Id.initialize()` ran first. D's module-ctor
 * sequencing guarantees this order (tokens.d:601 runs before runtime init); in TS it is manual.
 * Regression pin: sema.fieldaccess.test.ts "harness init order keeps Id.* identity live".
 *
 * Idempotent-by-reconstruction (crash-only): re-running rebuilds the pool from scratch (but a
 * re-run AFTER `Id.initialize()` re-orphans the Id singletons — same contract as above).
 */
export function initTokens(): void {
    // resolved: shared static this() (tokens.d:601) -> init function (01 §5.2)
    Identifier.initTable();
    for (const kw of keywords) {
        // D `Identifier.idPool(Token.tochars[kw], kw)` -> the TOK-value keyword overload
        // (identifier.d:314), renamed `idPoolKeyword` per 04 §1B (same name, different 2nd-param type).
        Identifier.idPoolKeyword(Token.tochars[kw], kw);
    }
}

/************************************
 * This is used to pick the C keywords out of the tokens.
 * If it's not a C keyword, then it's an identifier.
 *
 * dmd/tokens.d:615 — `static immutable TOK[TOK.max + 1] Ckeywords = () { ... }();`. The CTFE lambda
 * builds a table defaulting every slot to `TOK.identifier`, then overwrites the C-keyword slots with
 * their own TOK. Resolved at translation time (07 §4): we build the same table eagerly at module
 * load (a plain array, no other-module value read -> safe at top level, 01 §4.5).
 */
export const Ckeywords: TOK[] = (() => {
    // resolved: CTFE lambda (tokens.d:616) -> eager table build at load
    const tab: TOK[] = new Array(TOK_max + 1).fill(TOK.identifier); // default to identifier
    const Ckwds: TOK[] = [
        TOK.auto_, TOK.break_, TOK.case_, TOK.char_, TOK.const_, TOK.continue_, TOK.default_, TOK.do_, TOK.float64, TOK.else_,
        TOK.enum_, TOK.extern_, TOK.float32, TOK.for_, TOK.goto_, TOK.if_, TOK.inline, TOK.int32, TOK.int64, TOK.register,
        TOK.restrict, TOK.return_, TOK.int16, TOK.signed, TOK.sizeof_, TOK.static_, TOK.struct_, TOK.switch_, TOK.typedef_,
        TOK.union_, TOK.unsigned, TOK.void_, TOK.volatile, TOK.while_, TOK.asm_, TOK.typeof_,
        TOK._Alignas, TOK._Alignof, TOK._Atomic, TOK._Bool, TOK._Complex, TOK._Generic, TOK._Imaginary, TOK._Noreturn,
        TOK._Static_assert, TOK._Thread_local,
        TOK._import, TOK._module, TOK.__cdecl, TOK.__declspec, TOK.__stdcall, TOK.__thread, TOK.__pragma, TOK.__int128, TOK.__attribute__,
        TOK._assert,
    ];
    for (const kw of Ckwds) {
        tab[kw] = kw; // `cast(TOK) kw` is a no-op here (already a TOK)
    }
    return tab;
})();

/**
 * dmd/tokens.d:636 — `struct InterpolatedSet { string[] parts; }`. A reference-collection wrapper
 * (it holds an appendable list of zero-terminated parts). In D it is a `struct` heap-allocated via
 * `new` (`new InterpolatedSet`, tokens.d:947) and only ever used through a pointer, so it behaves as
 * a reference; modeled as a plain class with a public `parts` array of byte-strings.
 */
export class InterpolatedSet {
    // all strings in the parts are zero terminated at length+1
    parts: DString[] = [];
}

/***********************************************************
 * dmd/tokens.d:643 — `extern (C++) struct Token`.
 *
 * VALUE struct (02 §2 / 03): copies on assignment/by-value/return. `.copy()` recurses per field.
 *
 * ESCALATED — the payload union (tokens.d:652). The D `Token` overlaps, in one set of bits:
 *   `long intvalue` / `ulong unsvalue` / `real_t floatvalue` / a nested `struct { union { const(char)*
 *   ustring; InterpolatedSet* interpolatedSet; } uint len; ubyte postfix; }` / `Identifier ident`.
 * This is a GENUINE layout-dependent union (11-escalate §3.5): the lexer writes `t.unsvalue`
 * (lexer.d:461) and the parser reads `token.intvalue` (parse.d:8184) of the SAME bits — verified
 * (ldc2): writing -1 to the signed member reads `18446744073709551615` through the unsigned member,
 * and writing `floatvalue=1.5` reads `0x3ff8000000000000` through the int member.
 *
 * TARGETED CARVE-OUT (resolution #3, doc home 11 + referenced from 02) — like UnionExp, NOT a
 * blanket escalate: ONLY int<->uint share bits. The faithful carrier model:
 *   - `intvalue` / `unsvalue` are the SAME 64-bit carrier read signed vs unsigned — exactly the
 *     09-numerics §0 carrier. They share one raw field `intUnsValue: bigint` (the 64 bits); the two
 *     names are accessors applying `toInt64` / `toUint64`, and writing either sets the raw. This
 *     reproduces the lexer/parser pun precisely (writing -1 signed reads 2^64-1 unsigned).
 *   - `floatvalue` is a SEPARATE slot (a genuinely-different bit interpretation). Within `tokens.d`'s
 *     own code int and float members are NEVER cross-read (each `toString` case reads only the member
 *     matching `value`), and the int<->float pun occurs only in the lexer/parser. Modeled as a
 *     separate `number` field — exactly one of {carrier, float, string-struct, ident} is meaningful
 *     per token, selected by `value` (TOK).
 *   - the string-literal struct (`ustring`/`interpolatedSet`/`len`/`postfix`) and `ident` are likewise
 *     selected by `value` and never cross-read against the numeric carrier; modeled as separate fields.
 */
export class Token {
    next: Token | null = null; // Token* next;
    loc: Loc = new LocCtor(); // Loc loc;  (value struct; default-init = Loc())
    ptr: DString | null = null; // const(char)* ptr; pointer to first character of this token within buffer
    value: TOK = TOK.reserved; // TOK value;
    blockComment: DString | null = null; // const(char)[] blockComment; doc comment string prior to this token
    lineComment: DString | null = null; // const(char)[] lineComment; doc comment for previous token

    // --- payload union (targeted int<->uint carve-out, resolution #3 — see class header) ---

    // The shared 64-bit integer carrier (`long intvalue` / `ulong unsvalue` overlap, 09 §0): the raw
    // 64 bits. Held as an unsigned-normalized bigint; the two D field names are signed/unsigned VIEWS
    // of it. Writing either `intvalue` or `unsvalue` sets this raw slot (intUnsValue).
    // D module-private to the Token model (TS has no module visibility); only this class touches it.
    private intUnsValue = 0n;

    /** `long intvalue` — the carrier read as signed 64-bit (09 §1, `toInt64`). */
    get intvalue(): bigint {
        return toInt64(this.intUnsValue);
    }
    set intvalue(v: bigint) {
        this.intUnsValue = toUint64(v); // store the bit pattern (unsigned-normalized)
    }

    /** `ulong unsvalue` — the SAME carrier read as unsigned 64-bit (09 §1, `toUint64`). */
    get unsvalue(): bigint {
        return toUint64(this.intUnsValue);
    }
    set unsvalue(v: bigint) {
        this.intUnsValue = toUint64(v);
    }

    floatvalue: real_t = 0; // real_t floatvalue;  (separate bit-interpretation — see header)

    // nested anonymous struct of the union: { union { ustring; interpolatedSet } len; postfix }
    ustring: DString | null = null; // const(char)* ustring; UTF8 string
    interpolatedSet: InterpolatedSet | null = null; // InterpolatedSet* interpolatedSet;
    len = 0; // uint len;
    postfix = 0; // ubyte postfix; 'c', 'w', 'd'

    ident: Identifier | null = null; // Identifier ident;

    /**
     * Per-field clone (03 §2). Primitives (intUnsValue/float/len/postfix/value) by value; `loc` is a
     * nested value struct -> recurse `.copy()`; class refs (`next`, `ident`, `interpolatedSet`) and
     * char-slices (`ptr`, comments, `ustring`) are SHARED (D struct copy is shallow over class
     * members and slices, 03 §2). No `opAssign`/postblit on `Token` -> plain field copy.
     */
    copy(): Token {
        const c = new Token();
        c.next = this.next;
        c.loc = this.loc.copy();
        c.ptr = this.ptr;
        c.value = this.value;
        c.blockComment = this.blockComment;
        c.lineComment = this.lineComment;
        c.intUnsValue = this.intUnsValue; // copies the raw 64-bit carrier (both intvalue & unsvalue)
        c.floatvalue = this.floatvalue;
        c.ustring = this.ustring;
        c.interpolatedSet = this.interpolatedSet;
        c.len = this.len;
        c.postfix = this.postfix;
        c.ident = this.ident;
        return c;
    }

    /**
     * Per-TOK display strings (dmd/tokens.d:674, `tochars[TOK.max + 1]`). `extern (D) private static
     * immutable` -> a static byte-string table; sized `TOK_max + 1`. Built eagerly at load (no
     * other-module value read). Every slot must be non-empty — D asserts this at CT (tokens.d:915);
     * the slots not listed in the D initializer keep the source's implicit gaps filled below so the
     * table is dense (the C-keyword & literal-debug rows in the source cover them all).
     *
     * The values are DStrings (byte-strings, 08 §11) — they feed `Identifier.idPool`, byte-keyed.
     */
    static readonly tochars: DString[] = Token.buildTochars();

    private static buildTochars(): DString[] {
        const tab: DString[] = new Array(TOK_max + 1);
        // Initialize via the D positional initializer (tokens.d:674). Every entry is set explicitly.
        const set = (t: TOK, s: string): void => {
            tab[t] = ds(s);
        };

        // Keywords
        set(TOK.this_, "this");
        set(TOK.super_, "super");
        set(TOK.assert_, "assert");
        set(TOK.null_, "null");
        set(TOK.true_, "true");
        set(TOK.false_, "false");
        set(TOK.cast_, "cast");
        set(TOK.new_, "new");
        set(TOK.throw_, "throw");
        set(TOK.module_, "module");
        set(TOK.pragma_, "pragma");
        set(TOK.typeof_, "typeof");
        set(TOK.typeid_, "typeid");
        set(TOK.rvalue, "__rvalue");
        set(TOK.template_, "template");
        set(TOK.void_, "void");
        set(TOK.int8, "byte");
        set(TOK.uns8, "ubyte");
        set(TOK.int16, "short");
        set(TOK.uns16, "ushort");
        set(TOK.int32, "int");
        set(TOK.uns32, "uint");
        set(TOK.int64, "long");
        set(TOK.uns64, "ulong");
        set(TOK.int128, "cent");
        set(TOK.uns128, "ucent");
        set(TOK.float32, "float");
        set(TOK.float64, "double");
        set(TOK.float80, "real");
        set(TOK.bool_, "bool");
        set(TOK.char_, "char");
        set(TOK.wchar_, "wchar");
        set(TOK.dchar_, "dchar");
        set(TOK.imaginary32, "ifloat");
        set(TOK.imaginary64, "idouble");
        set(TOK.imaginary80, "ireal");
        set(TOK.complex32, "cfloat");
        set(TOK.complex64, "cdouble");
        set(TOK.complex80, "creal");
        set(TOK.delegate_, "delegate");
        set(TOK.function_, "function");
        set(TOK.is_, "is");
        set(TOK.if_, "if");
        set(TOK.else_, "else");
        set(TOK.while_, "while");
        set(TOK.for_, "for");
        set(TOK.do_, "do");
        set(TOK.switch_, "switch");
        set(TOK.case_, "case");
        set(TOK.default_, "default");
        set(TOK.break_, "break");
        set(TOK.continue_, "continue");
        set(TOK.synchronized_, "synchronized");
        set(TOK.return_, "return");
        set(TOK.goto_, "goto");
        set(TOK.try_, "try");
        set(TOK.catch_, "catch");
        set(TOK.finally_, "finally");
        set(TOK.with_, "with");
        set(TOK.asm_, "asm");
        set(TOK.foreach_, "foreach");
        set(TOK.foreach_reverse_, "foreach_reverse");
        set(TOK.scope_, "scope");
        set(TOK.struct_, "struct");
        set(TOK.class_, "class");
        set(TOK.interface_, "interface");
        set(TOK.union_, "union");
        set(TOK.enum_, "enum");
        set(TOK.import_, "import");
        set(TOK.mixin_, "mixin");
        set(TOK.static_, "static");
        set(TOK.final_, "final");
        set(TOK.const_, "const");
        set(TOK.alias_, "alias");
        set(TOK.override_, "override");
        set(TOK.abstract_, "abstract");
        set(TOK.debug_, "debug");
        set(TOK.deprecated_, "deprecated");
        set(TOK.in_, "in");
        set(TOK.out_, "out");
        set(TOK.inout_, "inout");
        set(TOK.lazy_, "lazy");
        set(TOK.auto_, "auto");
        set(TOK.align_, "align");
        set(TOK.extern_, "extern");
        set(TOK.private_, "private");
        set(TOK.package_, "package");
        set(TOK.protected_, "protected");
        set(TOK.public_, "public");
        set(TOK.export_, "export");
        set(TOK.invariant_, "invariant");
        set(TOK.unittest_, "unittest");
        set(TOK.version_, "version");
        set(TOK.argumentTypes, "__argTypes");
        set(TOK.parameters, "__parameters");
        set(TOK.ref_, "ref");
        set(TOK.macro_, "macro");
        set(TOK.pure_, "pure");
        set(TOK.nothrow_, "nothrow");
        set(TOK.gshared, "__gshared");
        set(TOK.traits, "__traits");
        set(TOK.vector, "__vector");
        set(TOK.file, "__FILE__");
        set(TOK.fileFullPath, "__FILE_FULL_PATH__");
        set(TOK.line, "__LINE__");
        set(TOK.moduleString, "__MODULE__");
        set(TOK.functionString, "__FUNCTION__");
        set(TOK.prettyFunction, "__PRETTY_FUNCTION__");
        set(TOK.shared_, "shared");
        set(TOK.immutable_, "immutable");

        set(TOK.endOfFile, "End of File");
        set(TOK.leftCurly, "{");
        set(TOK.rightCurly, "}");
        set(TOK.leftParenthesis, "(");
        set(TOK.rightParenthesis, ")");
        set(TOK.leftBracket, "[");
        set(TOK.rightBracket, "]");
        set(TOK.semicolon, ";");
        set(TOK.colon, ":");
        set(TOK.comma, ",");
        set(TOK.dot, ".");
        set(TOK.xor, "^");
        set(TOK.xorAssign, "^=");
        set(TOK.assign, "=");
        set(TOK.lessThan, "<");
        set(TOK.greaterThan, ">");
        set(TOK.lessOrEqual, "<=");
        set(TOK.greaterOrEqual, ">=");
        set(TOK.equal, "==");
        set(TOK.notEqual, "!=");
        set(TOK.not, "!");
        set(TOK.leftShift, "<<");
        set(TOK.rightShift, ">>");
        set(TOK.unsignedRightShift, ">>>");
        set(TOK.add, "+");
        set(TOK.min, "-");
        set(TOK.mul, "*");
        set(TOK.div, "/");
        set(TOK.mod, "%");
        set(TOK.slice, "..");
        set(TOK.dotDotDot, "...");
        set(TOK.and, "&");
        set(TOK.andAnd, "&&");
        set(TOK.or, "|");
        set(TOK.orOr, "||");
        set(TOK.tilde, "~");
        set(TOK.dollar, "$");
        set(TOK.plusPlus, "++");
        set(TOK.minusMinus, "--");
        set(TOK.question, "?");
        set(TOK.variable, "var");
        set(TOK.addAssign, "+=");
        set(TOK.minAssign, "-=");
        set(TOK.mulAssign, "*=");
        set(TOK.divAssign, "/=");
        set(TOK.modAssign, "%=");
        set(TOK.leftShiftAssign, "<<=");
        set(TOK.rightShiftAssign, ">>=");
        set(TOK.unsignedRightShiftAssign, ">>>=");
        set(TOK.andAssign, "&=");
        set(TOK.orAssign, "|=");
        set(TOK.concatenateAssign, "~=");
        set(TOK.identity, "is");
        set(TOK.notIdentity, "!is");
        set(TOK.identifier, "identifier");
        set(TOK.at, "@");
        set(TOK.pow, "^^");
        set(TOK.powAssign, "^^=");
        set(TOK.goesTo, "=>");
        set(TOK.pound, "#");
        set(TOK.arrow, "->");
        set(TOK.colonColon, "::");

        // For debugging
        set(TOK.error, "error");
        set(TOK.string_, "string");
        set(TOK.interpolated, "interpolated string");
        set(TOK.onScopeExit, "scope(exit)");
        set(TOK.onScopeSuccess, "scope(success)");
        set(TOK.onScopeFailure, "scope(failure)");

        // Finish up
        set(TOK.reserved, "reserved");
        set(TOK.comment, "comment");
        set(TOK.int32Literal, "int32v");
        set(TOK.uns32Literal, "uns32v");
        set(TOK.int64Literal, "int64v");
        set(TOK.uns64Literal, "uns64v");
        set(TOK.int128Literal, "int128v");
        set(TOK.uns128Literal, "uns128v");
        set(TOK.float32Literal, "float32v");
        set(TOK.float64Literal, "float64v");
        set(TOK.float80Literal, "float80v");
        set(TOK.imaginary32Literal, "imaginary32v");
        set(TOK.imaginary64Literal, "imaginary64v");
        set(TOK.imaginary80Literal, "imaginary80v");
        set(TOK.charLiteral, "charv");
        set(TOK.wcharLiteral, "wcharv");
        set(TOK.dcharLiteral, "dcharv");
        set(TOK.wchar_tLiteral, "wchar_tv");
        set(TOK.hexadecimalString, "xstring");
        set(TOK.endOfLine, "\\n");
        set(TOK.whitespace, "whitespace");

        // C only keywords
        set(TOK.inline, "inline");
        set(TOK.register, "register");
        set(TOK.restrict, "restrict");
        set(TOK.signed, "signed");
        set(TOK.sizeof_, "sizeof");
        set(TOK.typedef_, "typedef");
        set(TOK.unsigned, "unsigned");
        set(TOK.volatile, "volatile");
        set(TOK._Alignas, "_Alignas");
        set(TOK._Alignof, "_Alignof");
        set(TOK._Atomic, "_Atomic");
        set(TOK._Bool, "_Bool");
        set(TOK._Complex, "_Complex");
        set(TOK._Generic, "_Generic");
        set(TOK._Imaginary, "_Imaginary");
        set(TOK._Noreturn, "_Noreturn");
        set(TOK._Static_assert, "_Static_assert");
        set(TOK._Thread_local, "_Thread_local");

        // C only extended keywords
        set(TOK._assert, "__check");
        set(TOK._import, "__import");
        set(TOK._module, "__module");
        set(TOK.__cdecl, "__cdecl");
        set(TOK.__declspec, "__declspec");
        set(TOK.__stdcall, "__stdcall");
        set(TOK.__thread, "__thread");
        set(TOK.__pragma, "__pragma");
        set(TOK.__int128, "__int128");
        set(TOK.__attribute__, "__attribute__");

        // resolved: static assert (tochars all non-empty, tokens.d:915) -> verify at build time
        for (const s of tab) {
            assert(s !== undefined && s.length > 0); // every slot non-empty
        }
        return tab;
    }

    // nothrow: (tokens.d:921) — ERASE (04 §8).

    /** dmd/tokens.d:923 — true if `value` is a keyword TOK. `int` return (0/1) kept as D's `number`. */
    isKeyword(): number {
        for (const kw of keywords) {
            if (kw === this.value) {
                return 1;
            }
        }
        return 0;
    }

    /**
     * dmd/tokens.d:933 — append an interpolated part from an OutBuffer. The D overloads
     * (`const ref OutBuffer` / `const(char)[]` / `const(char)* + length`) collapse: a `DString` IS a
     * length-carrying byte-slice, so all three forms are one method taking a `DString`. The
     * `const ref OutBuffer` overload forwards `buf[]` (the buffer's bytes).
     */
    appendInterpolatedPartFromBuffer(buf: OutBuffer): void {
        // D reads `buf[]` (the non-destructive `opSlice()` view, tokens.d:935), NOT a consuming
        // extract — `appendInterpolatedPart` copies the bytes itself, leaving `buf` intact.
        this.appendInterpolatedPart(buf.opSliceAll());
    }

    /** ditto (tokens.d:938/943) — append the part bytes. */
    appendInterpolatedPart(str: DString): void {
        assert(this.value === TOK.interpolated);
        if (this.interpolatedSet === null) {
            this.interpolatedSet = new InterpolatedSet(); // new InterpolatedSet (heap)
        }
        // D copies the bytes (xmalloc_noscan + memcpy + NUL); JS GC owns the copy. `slice()` makes an
        // independent owned buffer so later mutation of the source can't corrupt the stored part.
        // erased: mem.xmalloc_noscan -> JS GC (no manual allocation)
        this.interpolatedSet.parts.push(str.slice());
    }

    /****
     * Set to contents of ptr[0..length] (dmd/tokens.d:962). The two D overloads (`const(char)* +
     * length` / `const ref OutBuffer`) collapse to one `DString` form.
     */
    setString(str: DString): void {
        this.value = TOK.string_;
        // erased: mem.xmalloc_noscan + memcpy + NUL -> store an independent owned copy (JS GC)
        this.ustring = str.slice();
        this.len = toUint32(str.length); // cast(uint)length
        this.postfix = 0;
    }

    /****
     * Set to contents of buf (dmd/tokens.d:978, `setString(const ref OutBuffer buf)`). Reads the
     * buffer's non-destructive `buf[]` view (NOT a consuming extract) and stores an owned copy.
     */
    setStringFromBuffer(buf: OutBuffer): void {
        this.setString(buf.opSliceAll());
    }

    /****
     * Set to empty string (dmd/tokens.d:986).
     */
    setStringEmpty(): void {
        this.value = TOK.string_;
        this.ustring = ds("");
        this.len = 0;
        this.postfix = 0;
    }

    /** dmd/tokens.d:994 — `extern (C++) const(char)* toChars()`. Returns the display bytes. */
    toChars(): DString {
        return this.toString();
    }

    /*********************************
     * dmd/tokens.d:1004 — `extern (D) const(char)[] toString()`.
     * Returns a display representation of the token, building literal text from the payload.
     *
     * Per-`case` the member read is the one matching `value`, so the union overlap is not exercised
     * here (see class header).
     */
    toString(): DString {
        switch (this.value) {
            case TOK.int32Literal:
                // %d of cast(int)intvalue — truncate the 64-bit carrier to 32-bit signed (09 §2)
                return ds(String(Number(maskSignedN(32, this.intUnsValue))));

            case TOK.uns32Literal:
            case TOK.wchar_tLiteral:
                // %uU of cast(uint)unsvalue — low 32 bits, unsigned (09 §2)
                return ds(String(Number(maskUnsignedN(32, this.intUnsValue))) + "U");

            case TOK.wcharLiteral:
            case TOK.dcharLiteral:
            case TOK.charLiteral: {
                const buf = new OutBuffer();
                writeSingleCharLiteral(buf, Number(maskUnsignedN(32, this.intUnsValue))); // cast(dchar) intvalue
                return buf.extractSlice(true);
            }

            case TOK.int64Literal:
                // %lldL of cast(long)intvalue
                return ds(String(toInt64(this.intvalue)) + "L");

            case TOK.uns64Literal:
                // %lluUL of cast(ulong)unsvalue
                return ds(String(toUint64(this.unsvalue)) + "UL");

            case TOK.float32Literal: {
                // `CTFloat.sprint(p, bufflen, 'g', floatvalue)` then `strcat(p, "f")`: the suffix is appended to the
                // bytes sprint wrote.
                return dsConcat(CTFloat.sprint("g", this.floatvalue), ds("f"));
            }

            case TOK.float64Literal:
                return CTFloat.sprint("g", this.floatvalue);

            case TOK.float80Literal:
                return dsConcat(CTFloat.sprint("g", this.floatvalue), ds("L"));

            case TOK.imaginary32Literal:
                return dsConcat(CTFloat.sprint("g", this.floatvalue), ds("fi"));

            case TOK.imaginary64Literal:
                return dsConcat(CTFloat.sprint("g", this.floatvalue), ds("i"));

            case TOK.imaginary80Literal:
                return dsConcat(CTFloat.sprint("g", this.floatvalue), ds("Li"));

            case TOK.string_: {
                const buf = new OutBuffer();
                buf.writeByte(0x22); // '"'
                const ustr = this.ustring!;
                for (let i = 0; i < this.len; ) {
                    const r = utf_decodeChar(ustr.subarray(0, this.len), i);
                    i = r.nextIdx;
                    writeCharLiteral(buf, r.dchar);
                }
                buf.writeByte(0x22); // '"'
                if (this.postfix) {
                    buf.writeByte(this.postfix);
                }
                return buf.extractSlice(true);
            }

            case TOK.hexadecimalString: {
                const buf = new OutBuffer();
                buf.writeByte(0x78); // 'x'
                buf.writeByte(0x22); // '"'
                const ustr = this.ustring!;
                for (let i = 0; i < this.len; i++) {
                    if (i) {
                        buf.writeByte(0x20); // ' '
                    }
                    buf.printf(ds("%02x"), ustr[i]);
                }
                buf.writeByte(0x22); // '"'
                if (this.postfix) {
                    buf.writeByte(this.postfix);
                }
                return buf.extractSlice(true);
            }

            case TOK.identifier:
            case TOK.enum_:
            case TOK.struct_:
            case TOK.import_:
            case TOK.wchar_:
            case TOK.dchar_:
            case TOK.bool_:
            case TOK.char_:
            case TOK.int8:
            case TOK.uns8:
            case TOK.int16:
            case TOK.uns16:
            case TOK.int32:
            case TOK.uns32:
            case TOK.int64:
            case TOK.uns64:
            case TOK.int128:
            case TOK.uns128:
            case TOK.float32:
            case TOK.float64:
            case TOK.float80:
            case TOK.imaginary32:
            case TOK.imaginary64:
            case TOK.imaginary80:
            case TOK.complex32:
            case TOK.complex64:
            case TOK.complex80:
            case TOK.void_:
                return this.ident!.toString();

            default:
                return Token.tochars[this.value];
        }
    }

    /** dmd/tokens.d:1135 — `static const(char)* toChars(TOK value)`. Static spelling lookup. */
    static toCharsValue(value: TOK): DString {
        return Token.toStringValue(value);
    }

    /** dmd/tokens.d:1140 — `static string toString(TOK value)`. The spelling of a TOK. */
    static toStringValue(value: TOK): DString {
        return Token.tochars[value];
    }
}

/**
 * Write a character, using a readable escape sequence if needed (dmd/tokens.d:1156).
 *
 * Free function (not a `Token` member); a UFCS call `buf.writeCharLiteral(c)` in D becomes
 * `writeCharLiteral(buf, c)` here (04 §6). Useful for printing "" string literals in error messages,
 * ddoc, or `.stringof`.
 *
 * Params:
 *   buf = buffer to append character in
 *   c = code point to write (a `dchar` -> number)
 */
export function writeCharLiteral(buf: OutBuffer, c: number): void {
    switch (c) {
        case 0x00: // '\0'
            buf.writestring(ds("\\0"));
            break;
        case 0x0a: // '\n'
            buf.writestring(ds("\\n"));
            break;
        case 0x0d: // '\r'
            buf.writestring(ds("\\r"));
            break;
        case 0x09: // '\t'
            buf.writestring(ds("\\t"));
            break;
        case 0x08: // '\b'
            buf.writestring(ds("\\b"));
            break;
        case 0x0c: // '\f'
            buf.writestring(ds("\\f"));
            break;
        case 0x22: // '"'
        case 0x5c: // '\\'
            buf.writeByte(0x5c); // '\\'
            // goto default;
            writeCharLiteralDefault(buf, c);
            break;
        default:
            writeCharLiteralDefault(buf, c);
            break;
    }
}

/// The `default:` body of `writeCharLiteral` (tokens.d:1182), extracted so the `goto default;` at the
/// `'"'`/`'\\'` case (which first writes a backslash) can re-enter it (06 §3.6 goto-default ->
/// extract-to-closure + call).
function writeCharLiteralDefault(buf: OutBuffer, c: number): void {
    if (c <= 0xff) {
        if (isprint(c)) {
            buf.writeByte(c); // cast(char)c
        } else {
            buf.printf(ds("\\x%02x"), c);
        }
    } else if (c <= 0xffff) {
        buf.printf(ds("\\u%04x"), c);
    } else {
        buf.printf(ds("\\U%08x"), c);
    }
}

/// C `isprint` over a single byte (core.stdc.ctype, 01 §3.7 -> inline). True for the printable ASCII
/// range [0x20, 0x7e]. Only reached for `c <= 0xFF` (the byte branch of `writeCharLiteralDefault`).
function isprint(c: number): boolean {
    return c >= 0x20 && c <= 0x7e;
}

/**
 * Write a single-quoted character literal (dmd/tokens.d:1218). Free function; UFCS
 * `buf.writeSingleCharLiteral(c)` -> `writeSingleCharLiteral(buf, c)` (04 §6).
 *
 * Params:
 *   buf = buffer to append character in
 *   c = code point to write (a `dchar` -> number)
 */
export function writeSingleCharLiteral(buf: OutBuffer, c: number): void {
    buf.writeByte(0x27); // '\''
    if (c === 0x27 /* '\'' */) {
        buf.writeByte(0x5c); // '\\'
    }

    if (c === 0x22 /* '"' */) {
        buf.writeByte(0x22); // '"'
    } else {
        writeCharLiteral(buf, c);
    }

    buf.writeByte(0x27); // '\''
}
