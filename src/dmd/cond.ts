// Ported from dmd/cond.d (module dmd.cond).
//
// "Evaluate compile-time conditionals, such as `static if` `version` and `debug`."
//
// FEATURE CODE, NOT SELF-CONFIG (07-compile-time.md §0 discrimination table). Everything in this
// module models `version` / `debug` / `static if` as they appear in the USER's program: the AST
// nodes that represent them, the global identifier lists the driver feeds them, and the reserved-
// version-identifier table. None of it is a build-time directive addressed to the translator, so
// none of it is resolved away — it is ported as ordinary algorithm.
//
// VISITOR (13-visitor.md §1/§2): each `override void accept(Visitor v) { v.visit(this); }` becomes
// `v.visit<ThisNodeClass>(this)` — the node's OWN named method, never the base's. `StaticForeach`
// extends `RootObject` (it is not a visited AST node) and has no `accept`.
//
// EXPORT SURFACE vs the previous rung-era partial: unchanged except that `StaticForeach.ready()`
// is GONE. It does not exist in dmd/cond.d at 1.43.0-beta1 (verified: no `ready` token in the
// file; the old stub cited a line number from an earlier revision) and nothing in the tree
// referenced it. Every other exported symbol keeps its name, kind, and signature shape.
//
// CYCLES (01-conventions.md §4): the node classes this module CONSTRUCTS (mtype / expression /
// declaration / func / dstruct / statement) are value imports — legal across the core SCC because
// every construction happens inside a method body, never at module-evaluation time (Rule 4.3). Two
// top-level value reads exist — `ds("tuple")` (StaticForeach.tupleFieldName) and `ds("D_")`
// (D_prefix) — and both call `ds` from the leaf `dstring` module, which is outside the 76-module
// core SCC, so neither can observe a partially-initialized module. Symbols used solely in type
// positions stay `import type` (Rule 4.2).

import { ASTNode } from "./ast_node.js";
import { RootObject, DYNCAST } from "./rootobject.js";
import { assert } from "../assert.js";
import { ds, dsEquals, dsSubslice } from "../dstring.js";
import type { DString } from "../dstring.js";

import { Array as Array_ } from "./root/array.js";
import { LINK, STC } from "./astenums.js";
import { TOK } from "./tokens.js";
import { Loc } from "./location.js";
import { Identifier } from "./identifier.js";
import { global } from "./globals.js";
import { error } from "./errors.js";
import { escapePath } from "./utils.js";

import { CallExp, FuncExp, TupleExp, TypeExp } from "./expression.js";
import { ParameterList, Type, TypeFunction, TypeStruct, TypeTypeof } from "./mtype.js";
import { TypeInfoStructDeclaration, VarDeclaration } from "./declaration.js";
import { FuncLiteralDeclaration } from "./func.js";
import { StructDeclaration } from "./dstruct.js";
import { ForeachRangeStatement, ForeachStatement } from "./statement.js";

import type { Visitor } from "./visitor/index.js";
import type { Expression } from "./expression.js";
import type { Statement } from "./statement.js";
import type { Dsymbol } from "./dsymbol.js";
import type { Module } from "./dmodule.js";
import type { Scope } from "./dscope.js";
import type { OutBuffer } from "./common/outbuffer.js";
import type { Expressions, Identifiers, Parameters } from "./arraytypes.js";

/***********************************************************
 */

/// dmd/cond.d:42 — `enum Include : ubyte`. Base ≤32-bit -> TS numeric enum (02-types.md §4.2);
/// members are 0..2 in declaration order, so `Include.init` is `notComputed` (09 §1.0).
export enum Include {
    notComputed,        /// not computed yet
    yes,                /// include the conditional code
    no,                 /// do not include the conditional code
}

/// dmd/cond.d:49 — `extern (C++) abstract class Condition : ASTNode`.
export abstract class Condition extends ASTNode {
    loc: Loc;

    inc: Include = Include.notComputed;

    // dmd/cond.d:55 — `override final DYNCAST dyncast() const`. `final` has no TS spelling; the
    // `const` qualifier erases (04 §8).
    override dyncast(): DYNCAST {
        return DYNCAST.condition;
    }

    // dmd/cond.d:60 — `extern (D) this(Loc loc)`.
    constructor(loc: Loc) {
        super();
        // `Loc` is an ALIAS-SAFE REGISTER member (03 §9.1): no live in-scope mutator, so sharing
        // on store is indistinguishable from a copy — no `.copy()` and no per-site justification.
        this.loc = loc;
    }

    // dmd/cond.d:65 — `abstract Condition syntaxCopy();` (bodyless decl in an abstract class ->
    // TS `abstract` method, 02 §2).
    abstract syntaxCopy(): Condition;

    // dmd/cond.d:67/72/77 — `inout(X) isXCondition() inout { return null; }`. The `inout` wrapper
    // and the trailing `inout` both ERASE, keeping `X` (04 §8); the base returns null and each
    // concrete subclass overrides with `this`.
    isDebugCondition(): DebugCondition | null {
        return null;
    }

    isVersionCondition(): VersionCondition | null {
        return null;
    }

    isStaticIfCondition(): StaticIfCondition | null {
        return null;
    }

    // dmd/cond.d:82 — `override void accept(Visitor v) { v.visit(this); }`.
    override accept(v: Visitor): void {
        v.visitCondition(this);
    }
}

/***********************************************************
 * Implements common functionality for StaticForeachDeclaration and
 * StaticForeachStatement This performs the necessary lowerings before
 * dmd.statementsem.makeTupleForeach can be used to expand the
 * corresponding `static foreach` declaration or statement.
 */

/// dmd/cond.d:95 — `extern (C++) final class StaticForeach : RootObject`.
export class StaticForeach extends RootObject {
    // dmd/cond.d:97 — `extern(D) static immutable tupleFieldName = "tuple";` (used in lowering).
    // A D `string` is a UTF-8 byte slice -> `DString` (02 §1.3).
    //
    // GUIDE GAP (reported, not a per-site deviation): 01 §5.6 mandates deep-`Object.freeze` for a
    // `static immutable` VALUE STRUCT ("static immutable Loc x = …", immutable tables of value
    // structs) and forbids a per-site choice. It has no clause for the `static immutable` *string*
    // shape, which in this port is a `Uint8Array`, and its canonical form is not merely unhelpful
    // here — it is IMPOSSIBLE: `Object.freeze` on a typed array with elements THROWS in V8
    // ("Cannot freeze array buffer views with elements", verified on this Node). ES2022 offers no
    // other way to make a `Uint8Array`'s bytes immutable, so the only representable forms are
    // `readonly` + convention (chosen) or copy-on-read, which §5.6 explicitly rules out. The
    // immutability is therefore carried by `readonly` on the binding plus the convention that
    // nothing writes into an interning key — load-bearing here, since this value is handed to
    // `Identifier.idPool` (below) and becomes a `StringTable` key.
    static readonly tupleFieldName: DString = ds("tuple");

    loc: Loc;

    /***************
     * Not `null` iff the `static foreach` is over an aggregate. In
     * this case, it contains the corresponding ForeachStatement. For
     * StaticForeachDeclaration, the body is `null`.
     */
    aggrfe: ForeachStatement | null;
    /***************
     * Not `null` iff the `static foreach` is over a range. Exactly
     * one of the `aggrefe` and `rangefe` fields is not null. See
     * `aggrfe` field for more details.
     */
    rangefe: ForeachRangeStatement | null;

    /***************
     * true if it is necessary to expand a tuple into multiple
     * variables (see lowerNonArrayAggregate).
     */
    needExpansion: boolean = false;

    // dmd/cond.d:120 — `extern (D) this(Loc loc, ForeachStatement aggrfe, ForeachRangeStatement rangefe)`.
    constructor(loc: Loc, aggrfe: ForeachStatement | null, rangefe: ForeachRangeStatement | null) {
        super();
        // dmd/cond.d:122 — `assert(!!aggrfe ^ !!rangefe);` XOR: exactly one is non-null. An
        // INTERNAL invariant (not boundary validation): a loud crash-only assert, never a guard.
        assert((aggrfe !== null) !== (rangefe !== null));

        this.loc = loc;                 // alias-safe register (03 §9.1)
        this.aggrfe = aggrfe;
        this.rangefe = rangefe;
    }

    // dmd/cond.d:129 — `extern (D) StaticForeach syntaxCopy()`.
    syntaxCopy(): StaticForeach {
        return new StaticForeach(
            this.loc,
            this.aggrfe !== null ? this.aggrfe.syntaxCopy() : null,
            this.rangefe !== null ? this.rangefe.syntaxCopy() : null,
        );
    }

    /*****************************************
     * Wrap a statement into a function literal and call it.
     *
     * Params:
     *     loc = The source location.
     *     s  = The statement.
     * Returns:
     *     AST of the expression `(){ s; }()` with location loc.
     */
    // dmd/cond.d:147 — `extern(D) Expression wrapAndCall(Loc loc, Statement s)`.
    wrapAndCall(loc: Loc, s: Statement): Expression {
        // `ParameterList()` is D default-construction of a value struct: parameters = null,
        // varargs = VarArg.none, stc = STC.none (03 §6.4) — the TS ctor's defaults reproduce it.
        const tf = new TypeFunction(new ParameterList(null), null, LINK.default_, STC.none);
        const fd = new FuncLiteralDeclaration(loc, loc, tf, TOK.reserved, null);
        fd.fbody = s;
        fd.skipCodegen = true;
        const fe = new FuncExp(loc, fd);
        const ce = new CallExp(loc, fe, new Array_<Expression | null>());   // `new Expressions()`
        return ce;
    }

    /*****************************************
     * Create a `foreach` statement from `aggrefe/rangefe` with given
     * `foreach` variables and body `s`.
     *
     * Params:
     *     loc = The source location.
     *     parameters = The foreach variables.
     *     s = The `foreach` body.
     * Returns:
     *     `foreach (parameters; aggregate) s;` or
     *     `foreach (parameters; lower .. upper) s;`
     *     Where aggregate/lower, upper are as for the current StaticForeach.
     */
    // dmd/cond.d:171 — `extern(D) Statement createForeach(Loc loc, Parameters* parameters, Statement s)`.
    // `s` is nullable: D passes `null` for the gagged-typeof empty foreach (expressionsem.d:19460), and
    // the body only forwards it to the two statement constructors, whose `_body` is nullable too.
    createForeach(loc: Loc, parameters: Parameters | null, s: Statement | null): Statement {
        if (this.aggrfe !== null) {
            return new ForeachStatement(loc, this.aggrfe.op, parameters, this.aggrfe.aggr, s, loc);
        } else {
            // dmd/cond.d:179 — `assert(rangefe && parameters.length == 1);` (two conjuncts).
            // DEVIATION, recorded: the port adds a THIRD conjunct, `parameters !== null`. D's
            // `Parameters*` -> `Parameters | null` (02 §10) and D would fault on a null deref
            // inside the assert itself; the port needs the null excluded before `opIndex(0)` on
            // the next line. The added conjunct is inside the assert (loud, crash-only), never a
            // silent guard, so it can only turn a D segfault into a named AssertError — it can
            // never let a state through that D rejects.
            assert(this.rangefe !== null && parameters !== null && parameters.length === 1);
            // `(*parameters)[0]` -> `opIndex(0)` (05 §7).
            return new ForeachRangeStatement(loc, this.rangefe.op, parameters.opIndex(0),
                this.rangefe.lwr, this.rangefe.upr, s, loc);
        }
    }

    /*****************************************
     * For a `static foreach` with multiple loop variables, the
     * aggregate is lowered to an array of tuples. As D does not have
     * built-in tuples, we need a suitable tuple type. This generates
     * a `struct` that serves as the tuple type. This type is only
     * used during CTFE and hence its typeinfo will not go to the
     * object file.
     *
     * Params:
     *     loc = The source location.
     *     e = The expressions we wish to store in the tuple.
     *     sc  = The current scope.
     * Returns:
     *     A struct type of the form
     *         struct Tuple
     *         {
     *             typeof(AliasSeq!(e)) tuple;
     *         }
     */

    // dmd/cond.d:204 — `extern(D) TypeStruct createTupleType(Loc loc, Expressions* e, Scope* sc)`.
    // The `Scope* sc` parameter is unused in the D body (kept for signature fidelity).
    createTupleType(loc: Loc, e: Expressions | null, sc: Scope | null): TypeStruct {   // TODO: move to druntime?
        void sc;                        // D declares but never reads `sc` here — keep the signature
        const sid = Identifier.generateId(ds("Tuple"));
        const sdecl = new StructDeclaration(loc, sid, false);
        // `sdecl.storage_class |= STC.static_` — STC is a 64-bit flag set (bigint); the branded
        // alias needs the re-cast after `|` (02 §4.2).
        sdecl.storage_class = (sdecl.storage_class | STC.static_) as STC;
        const fid = Identifier.idPool(StaticForeach.tupleFieldName);
        // reconciled to faithful surface (W2); sweeps at this file's retranslation:
        // cond.d:209 passes `Expressions* e`, i.e. the expression.d:1306 overload, exposed by
        // expression.ts as `TupleExp.fromExps` (04 §1.1(c)).
        const ty = new TypeTypeof(loc, TupleExp.fromExps(loc, e));
        // `new Dsymbols(new VarDeclaration(...))` — the typesafe-variadic Array!T ctor (08 §2.9).
        sdecl.members = Array_.from<Dsymbol>(new VarDeclaration(loc, ty, fid, null, STC.none));
        // `cast(TypeStruct)sdecl.type` — the downcast idiom is the `isTypeXxx()` accessor (05 §10);
        // the StructDeclaration ctor sets `type = new TypeStruct(this)`, so it is never null.
        const r = sdecl.type!.isTypeStruct()!;
        // `Type.dtypeinfo` (mtype.ts:600) is declared `static dtypeinfo: ClassDeclaration` with no
        // initializer, so under `useDefineForClassFields` it exists and holds `undefined` until
        // dclass.ts:188 fills it from `object.d`. D's `if (Type.dtypeinfo)` is a nullable-reference
        // truthiness test, which 06 §2.7 requires be spelled explicitly — but `!== undefined` on
        // the declared non-nullable type is TS2367 (no overlap), so the optional-shape view is what
        // makes the §2.7 form expressible. Same cast, same reason, as dsymbolsem.ts:1521.
        if (global.params.useTypeInfo && (Type as { dtypeinfo?: unknown }).dtypeinfo !== undefined)
            r.vtinfo = TypeInfoStructDeclaration.create(r);  // prevent typeinfo from going to object file
        return r;
    }

    /*****************************************
     * Create the AST for an instantiation of a suitable tuple type.
     *
     * Params:
     *     loc = The source location.
     *     type = A Tuple type, created with createTupleType.
     *     e = The expressions we wish to store in the tuple.
     * Returns:
     *     An AST for the expression `Tuple(e)`.
     */

    // dmd/cond.d:229 — `extern(D) Expression createTuple(Loc loc, TypeStruct type, Expressions* e)`.
    createTuple(loc: Loc, type: TypeStruct, e: Expressions | null): Expression {   // TODO: move to druntime?
        return new CallExp(loc, new TypeExp(loc, type), e);
    }
}

/***********************************************************
 */
/// dmd/cond.d:237 — `extern (C++) class DVCondition : Condition` (NOT final: Debug/Version extend it).
export class DVCondition extends Condition {
    ident: Identifier | null;
    mod: Module | null;

    // dmd/cond.d:242 — `extern (D) this(Loc loc, Module mod, Identifier ident)`.
    constructor(loc: Loc, mod: Module | null, ident: Identifier | null) {
        super(loc);
        this.mod = mod;
        this.ident = ident;
    }

    // dmd/cond.d:249 — `override final DVCondition syntaxCopy() { return this; }` (don't need to copy).
    override syntaxCopy(): DVCondition {
        return this;
    }

    // dmd/cond.d:254 — `override void accept(Visitor v) { v.visit(this); }`.
    override accept(v: Visitor): void {
        v.visitDVCondition(this);
    }
}

/***********************************************************
 */
/// dmd/cond.d:262 — `extern (C++) final class DebugCondition : DVCondition`.
export class DebugCondition extends DVCondition {
    /**
     * Add an user-supplied identifier to the list of global debug identifiers
     *
     * Can be called from either the driver or a `debug = Ident;` statement.
     * Unlike version identifier, there isn't any reserved debug identifier
     * so no validation takes place.
     *
     * Params:
     *   ident = identifier to add
     */
    // dmd/cond.d:289 — `extern(D) static void addGlobalIdent(const(char)[] ident)`.
    //
    // The D overload SET collapses to this single method: `string` (cond.d:281) and
    // `const(char)[]` (cond.d:289) both map to `DString`, and the `string` form is a pure forward.
    // dropped: `deprecated static void addGlobalIdent(const(char)* ident)` (cond.d:274) — a C++ ABI
    //   compat shim (`ident[0 .. ident.strlen]` then forward). It is Form B (same arity, different
    //   param type), which 04 §1B would normally RENAME rather than drop; it is dropped instead
    //   because it is dead in the port's world — verified: its only caller in the whole tree is the
    //   C++ driver (`driver/main.cpp:163`, `Condition::addGlobalIdent(cstr)`), out of scope per
    //   _ground-truth.md §1, and a renamed-but-uncalled export is dead API. Dropped WITH it: the
    //   `strlen` truncation. This method interns the WHOLE slice, so a caller that ever hands in a
    //   NUL-TERMINATED `DString` (`toChars()`/`peekChars()`/`extractChars()`, 02 §11) would intern
    //   an Identifier containing the 0x00 and silently corrupt `global.debugids`. No live caller
    //   does: the sole in-scope D caller, mars.d:1788, passes `(p + 7).toDString()`, which already
    //   stops at the terminator. Recorded as an escalation, not decided here.
    static addGlobalIdent(ident: DString): void {
        global.debugids.push(Identifier.idPool(ident));
    }

    /**
     * Instantiate a new `DebugCondition`
     *
     * Params:
     *   mod = Module this node belongs to
     *   ident = Identifier required for this condition to pass.
     *           If `null`, this conditiion will use an integer level.
     *  loc = Location in the source file
     */
    // dmd/cond.d:304 — `extern (D) this(Loc loc, Module mod, Identifier ident)`.
    constructor(loc: Loc, mod: Module | null, ident: Identifier | null) {
        super(loc, mod, ident);
    }

    // dmd/cond.d:309 — `override inout(DebugCondition) isDebugCondition() inout { return this; }`.
    override isDebugCondition(): DebugCondition | null {
        return this;
    }

    // dmd/cond.d:314 — `override void accept(Visitor v) { v.visit(this); }`.
    override accept(v: Visitor): void {
        v.visitDebugCondition(this);
    }
}

/**
 * Injective Latin-1 key for a byte slice — the port's stand-in for D's content-comparing
 * `switch (const(char)[])`. `keyOf(a) === keyOf(b)` IFF `a` and `b` have identical length AND
 * bytes, because each byte (0..255) maps to exactly one BMP code unit. Same helper (and same
 * rationale) as `dmd/imphint.ts` / `dmd/root/stringtable.ts` use for byte-keyed maps.
 *
 * Why not `dsToJs`: that is a UTF-8 decode reserved for the display / Node-API boundary (08 §11)
 * and is NOT injective over arbitrary byte sequences. Why not a chain of `dsEquals`: it would
 * turn D's O(1)-dispatch `switch` into ~110 sequential comparisons and lose the 1:1 switch shape.
 *
 * NOT an upstream symbol — a house helper, deliberately named outside the D namespace (01 §1.1).
 * Cost: O(len); the idents it keys are short.
 */
function keyOf(str: DString): string {
    let s = "";
    for (let i = 0; i < str.length; i++) s += String.fromCharCode(str[i]);
    return s;
}

/// The `"D_"` prefix tested by `isReserved`'s default arm (cond.d:460). Hoisted so the byte slice
/// is built once rather than per call.
const D_prefix: DString = ds("D_");

/**
 * Node to represent a version condition
 *
 * A version condition is of the form:
 * ---
 * version (Identifier)
 * ---
 * In user code.
 * This class also provides means to add version identifier
 * to the list of global (cross module) identifiers.
 */
/// dmd/cond.d:331 — `extern (C++) final class VersionCondition : DVCondition`.
export class VersionCondition extends DVCondition {
    /**
     * Check if a given version identifier is reserved.
     *
     * Params:
     *   ident = identifier being checked
     *
     * Returns:
     *   `true` if it is reserved, `false` otherwise
     */
    // dmd/cond.d:342 — `extern(D) public static bool isReserved(const(char)[] ident)`.
    //
    // FEATURE data, not self-config: this is the list of version identifiers reserved in the USER's
    // program (07 §0), so the whole table is ported verbatim — never resolved against our own
    // target world.
    //
    // D's `switch` over a `const(char)[]` compares CONTENT. 06 §3.4 sanctions a JS string `switch`
    // "provided the switched value is a JS string" — an accessor that yields one makes the switch
    // direct — and reserves STOP-and-escalate for switching on a RAW byte buffer, whose stated
    // hazard is "byte-buffer equality != JS string equality". `keyOf` is that accessor: the switched
    // value is a JS string, and because the encoding is INJECTIVE (one byte -> exactly one BMP code
    // unit) JS string equality is byte equality, so the named hazard cannot arise. Escalating is
    // therefore not triggered here — nothing is guessed and no equality is weakened. Every case
    // label below is ASCII, so `keyOf(ds(label)) === label` for the matching bytes and for no
    // others; the labels are byte-identical to cond.d:347-455, in source order.
    static isReserved(ident: DString): boolean {
        // This list doesn't include "D_*" versions, see the last return
        switch (keyOf(ident)) {
            case "AArch64":
            case "AIX":
            case "all":
            case "Alpha":
            case "Alpha_HardFloat":
            case "Alpha_SoftFloat":
            case "Android":
            case "Apple":
            case "ARM":
            case "ARM_HardFloat":
            case "ARM_SoftFloat":
            case "ARM_SoftFP":
            case "ARM_Thumb":
            case "AsmJS":
            case "assert":
            case "AVR":
            case "BigEndian":
            case "BSD":
            case "CppRuntime_LLVM":
            case "CppRuntime_DigitalMars":
            case "CppRuntime_GNU":
            case "CppRuntime_Microsoft":
            case "CppRuntime_Sun":
            case "CRuntime_Bionic":
            case "CRuntime_DigitalMars":
            case "CRuntime_Glibc":
            case "CRuntime_Microsoft":
            case "CRuntime_Musl":
            case "CRuntime_Newlib":
            case "CRuntime_UClibc":
            case "CRuntime_WASI":
            case "Cygwin":
            case "DigitalMars":
            case "DragonFlyBSD":
            case "Emscripten":
            case "ELFv1":
            case "ELFv2":
            case "Epiphany":
            case "FreeBSD":
            case "FreeStanding":
            case "GNU":
            case "Haiku":
            case "HPPA":
            case "HPPA64":
            case "Hurd":
            case "IA64":
            case "iOS":
            case "LDC":
            case "linux":
            case "LittleEndian":
            case "LoongArch32":
            case "LoongArch64":
            case "LoongArch_HardFloat":
            case "LoongArch_SoftFloat":
            case "MinGW":
            case "MIPS32":
            case "MIPS64":
            case "MIPS_EABI":
            case "MIPS_HardFloat":
            case "MIPS_N32":
            case "MIPS_N64":
            case "MIPS_O32":
            case "MIPS_O64":
            case "MIPS_SoftFloat":
            case "MSP430":
            case "NetBSD":
            case "none":
            case "NVPTX":
            case "NVPTX64":
            case "OpenBSD":
            case "OSX":
            case "PlayStation":
            case "PlayStation4":
            case "Posix":
            case "PPC":
            case "PPC64":
            case "PPC_HardFloat":
            case "PPC_SoftFloat":
            case "RISCV32":
            case "RISCV64":
            case "S390":
            case "S390X":
            case "SDC":
            case "SH":
            case "SkyOS":
            case "Solaris":
            case "SPARC":
            case "SPARC64":
            case "SPARC_HardFloat":
            case "SPARC_SoftFloat":
            case "SPARC_V8Plus":
            case "SystemZ":
            case "SysV3":
            case "SysV4":
            case "TVOS":
            case "unittest":
            case "VisionOS":
            case "WASI":
            case "WASIp1":
            case "WASIp2":
            case "WASIp3":
            case "WatchOS":
            case "WebAssembly":
            case "Win32":
            case "Win64":
            case "Windows":
            case "Xtensa":
            case "X86":
            case "X86_64":
                return true;

            default:
                // Anything that starts with "D_" is reserved
                // `ident[0 .. 2] == "D_"` is a byte-slice content compare -> `dsEquals` (08 §11).
                return (ident.length >= 2 && dsEquals(dsSubslice(ident, 0, 2), D_prefix));
        }
    }

    /**
     * Raises an error if a version identifier is reserved.
     *
     * Called when setting a version identifier, e.g. `-version=identifier`
     * parameter to the compiler or `version = Foo` in user code.
     *
     * Params:
     *   loc = Where the identifier is set
     *   ident = identifier being checked (ident[$] must be '\0')
     */
    // dmd/cond.d:474 — `extern(D) static void checkReserved(Loc loc, const(char)[] ident)`.
    static checkReserved(loc: Loc, ident: DString): void {
        if (VersionCondition.isReserved(ident))
            // Diagnostic parity (10 §3): the format string is byte-identical to dmd's. D passes
            // `ident.ptr` (a C string); `%s` in `dmdformat` is NUL-aware, so the DString slice —
            // whose logical length already stops before any terminator — renders identically.
            error(loc, ds("version identifier `%s` is reserved and cannot be set"),
                  ident);
    }

    /**
     * Add an user-supplied global identifier to the list
     *
     * Only called from the driver for `-version=Ident` parameters.
     * Will raise an error if the identifier is reserved.
     *
     * Params:
     *   ident = identifier to add
     */
    // dmd/cond.d:505 — `extern(D) static void addGlobalIdent(const(char)[] ident)`.
    //
    // Overload set collapsed as in `DebugCondition.addGlobalIdent`: the `string` form (cond.d:497)
    // is a pure forward onto the same `DString`.
    // dropped: `deprecated static void addGlobalIdent(const(char)* ident)` (cond.d:490) — C++ ABI
    //   compat shim; same disposition and same dropped `strlen` truncation as
    //   `DebugCondition.addGlobalIdent` above (see the record there). No in-scope D caller:
    //   mars.d:1806 passes `(p+9).toDString()`, already NUL-stopped.
    static addGlobalIdent(ident: DString): void {
        VersionCondition.checkReserved(Loc.initial, ident);
        VersionCondition.addPredefinedGlobalIdent(ident);
    }

    /**
     * Add any global identifier to the list, without checking
     * if it's predefined
     *
     * Only called from the driver after platform detection,
     * and internally.
     *
     * Params:
     *   ident = identifier to add (ident[$] must be '\0')
     */
    // dmd/cond.d:536 — `extern(D) static void addPredefinedGlobalIdent(const(char)[] ident)`.
    //
    // Overload set collapsed: the `string` form (cond.d:528) is a pure forward.
    // dropped: `deprecated static void addPredefinedGlobalIdent(const(char)* ident)` (cond.d:521)
    //   — C++ ABI compat shim (`ident.toDString()`, which also stops at the first NUL); same
    //   disposition and same dropped truncation as `DebugCondition.addGlobalIdent` above. Every
    //   in-scope D caller (target.d:123-252, objc.d) passes a string literal.
    static addPredefinedGlobalIdent(ident: DString): void {
        global.versionids.push(Identifier.idPool(ident));
    }

    /**
     * Instantiate a new `VersionCondition`
     *
     * Params:
     *   mod = Module this node belongs to
     *   ident = Identifier required for this condition to pass.
     *           If `null`, this conditiion will use an integer level.
     *  loc = Location in the source file
     */
    // dmd/cond.d:550 — `extern (D) this(Loc loc, Module mod, Identifier ident)`.
    constructor(loc: Loc, mod: Module | null, ident: Identifier | null) {
        super(loc, mod, ident);
    }

    // dmd/cond.d:555 — `override inout(VersionCondition) isVersionCondition() inout { return this; }`.
    override isVersionCondition(): VersionCondition | null {
        return this;
    }

    // dmd/cond.d:560 — `override void accept(Visitor v) { v.visit(this); }`.
    override accept(v: Visitor): void {
        v.visitVersionCondition(this);
    }
}

/***********************************************************
 */
/// dmd/cond.d:568 — `extern (C++) final class StaticIfCondition : Condition`.
export class StaticIfCondition extends Condition {
    exp: Expression | null;

    // dmd/cond.d:572 — `extern (D) this(Loc loc, Expression exp)`.
    constructor(loc: Loc, exp: Expression | null) {
        super(loc);
        this.exp = exp;
    }

    // dmd/cond.d:578 — `override StaticIfCondition syntaxCopy()`. `exp` is non-null in a valid AST
    // (the parser always supplies one); D dereferences it unconditionally.
    override syntaxCopy(): StaticIfCondition {
        return new StaticIfCondition(this.loc, this.exp!.syntaxCopy());
    }

    // dmd/cond.d:583 — `override void accept(Visitor v) { v.visit(this); }`.
    override accept(v: Visitor): void {
        v.visitStaticIfCondition(this);
    }

    // dmd/cond.d:588 — `override inout(StaticIfCondition) isStaticIfCondition() inout { return this; }`.
    override isStaticIfCondition(): StaticIfCondition | null {
        return this;
    }
}


/****************************************
 * Find `ident` in an array of identifiers.
 * Params:
 *      ids = array of identifiers
 *      ident = identifier to search for
 * Returns:
 *      true if found
 */
// dmd/cond.d:603 — `bool findCondition(ref Identifiers ids, Identifier ident)`. `ref` is an ALIAS,
// so the container object is passed straight through — no `.copy()` (03 §3.2). `@safe nothrow pure`
// erase (04 §8).
export function findCondition(ids: Identifiers, ident: Identifier): boolean {
    for (const id of ids) {         // `foreach (id; ids)` over a container value (06 §1.9)
        // `id == ident` on interned `Identifier` CLASS references is reference identity (05 §2).
        if (id === ident)
            return true;
    }
    return false;
}

// Helper for printing dependency information
// dmd/cond.d:614 — `public void printDepsConditional(Scope* sc, DVCondition condition, const(char)[] depType)`.
export function printDepsConditional(sc: Scope | null, condition: DVCondition, depType: DString): void {
    // dmd/cond.d:616 — `if (!global.params.moduleDeps.buffer || global.params.moduleDeps.name) return;`
    //
    // `buffer` is `OutBuffer*` -> a nullable class ref: `=== null` (06 §2.7).
    //
    // `name` is a D `const(char)[]`, whose truthiness tests the SLICE POINTER (06 §2.8): a null
    // slice is falsy, an empty-NON-null one is TRUTHY. `Output.name` is modelled as
    // `DString | null` with `null` as the unset state, so the test is spelled `!== null`.
    if (global.params.moduleDeps.buffer === null || global.params.moduleDeps.name !== null)
        return;
    const ob: OutBuffer = global.params.moduleDeps.buffer;
    const imod: Module | null = sc !== null ? sc._module : condition.mod;
    if (imod === null)
        return;
    ob.writestring(depType);
    // cond.d:623 writes a `const(char)*`, which stops at the NUL. `imod` is a Module: with a parent its
    // `toPrettyChars()` ends in `extractSlice(true)`, whose slice excludes the NUL; without one it returns
    // `toChars()`, an identifier name (only template declarations, instances, mixins and TypeInfo
    // declarations carry an `extractChars` NUL, hdrgen.d:233-261).
    ob.writestring(imod.toPrettyChars());
    ob.writestring(ds(" ("));
    escapePath(ob, imod.srcfile.toChars());
    ob.writestring(ds(") : "));
    if (condition.ident !== null)
        ob.writestring(condition.ident.toString());
    ob.writeByte(0x0a);     // '\n'
}
