// Ported from dmd/dscope.d (module dmd.dscope) — LDC 1.43.0-beta1 / DMD 2.113.
//
// WHOLE-FILE 1:1. dscope.d declares FIVE top-level entities (Contract, FlagBitFields,
// NonFlagBitFields, Previews, Scope) plus the nested Previews.BitFields; every one is emitted
// below in D source order, and every member of `Scope` in D declaration order.
//
// Compile-time resolutions in this file (07 convention — the emitted TS carries no
// `version`/`static if`/`mixin` token):
//   - resolved: `//version=LOGSEARCH;` (dscope.d:35) -> the version is never SET (the line is
//     commented out upstream) and dscope.d has no `version (LOGSEARCH)` block left in 1.43-beta1.
//   - resolved: `version (IN_LLVM)` (dscope.d:183) -> ON (_config.md §1): the
//     `emitInstrumentation` field is emitted.
//   - resolved: `debug { ... }` (dscope.d:249-258) -> OFF (_config.md §3, bare `debug` block in a
//     non-debug build): the printf + the two enclosing-identity asserts are dropped. The
//     `assert(&this != s)` at dscope.d:278 is OUTSIDE the debug block and is kept.
//   - resolved: `version (none) { ... }` (dscope.d:337-360) -> OFF (built-in, _config.md §1): the
//     `sc.tinst = null; sc.minst = null;` leg inside `startCTFE` is dropped (upstream keeps it
//     disabled behind a long TODO comment).
//   - resolved: `mixin(generateBitFields!(FlagBitFields, ushort))` (dscope.d:199),
//     `mixin(generateBitFields!(NonFlagBitFields, ushort, "bitFields2"))` (dscope.d:201) and
//     `mixin(generateBitFields!(BitFields, ushort))` (dscope.d:118) -> EXPANDED (07 §5/§6) to the
//     packed `ushort` word + one accessor pair per member, exactly as common/bitfields.d generates
//     them. The packed word is REAL state here (not a flattening): `copyFlagsFrom` assigns
//     `bitFields` wholesale and `resetAllFlags` zeroes it, and NonFlagBitFields deliberately lives
//     in a SECOND word so those two operations do not touch it.
//
// Imports dropped with reason (01 §3):
//   - `core.stdc.stdio` (dscope.d:16): only user was the `printf` in the dropped `debug` block.
//   - `core.stdc.string` (dscope.d:17): no surviving user in 1.43-beta1.
//   - `dmd.root.rmem` (dscope.d:32): users were `mem.isGCEnabled` (inside the erased freelist leg
//     of `pop`) and `.arraydup` in `push` (-> per-element `.copy()`, 03 §4). Both erased (03 §8).
//   - `dmd.common.bitfields : generateBitFields` (dscope.d:117, 198): the mixin is expanded here,
//     so the import has no runtime analogue.
//
// `DocComment*` (dscope.d:207 `lastdc`, declared `void*`) is doc.d's DocComment; the slot is typed through an
// `import type` of doc.ts (02 §11.5c #6, the preferred form), so doc.ts reads it without a cast.
//
// EXPORT SURFACE: D's `push` overload set is ARITY-distinct (`Scope* push()` dscope.d:242 and
// `Scope* push(ScopeDsymbol ss)` dscope.d:294, whose whole body is
// `Scope* s = push(); s.scopesym = ss; return s;`), so 04 §1A Form A applies: ONE method with one
// optional trailing param. The rung-era second name `pushDsymbol` is gone and every call site uses
// `push(ss)`.

import { Module } from "./dmodule.js";
import { ScopeDsymbol } from "./dsymbol.js";
import type { Dsymbol } from "./dsymbol.js";
import { Visibility } from "./dsymbol.js"; // value: field default Visibility(public_)
import type { FuncDeclaration } from "./func.js";
import type { VarDeclaration } from "./declaration.js";
import type { AliasDeclaration } from "./declaration.js";
import type { LabelStatement } from "./statement.js";
import type { SwitchStatement } from "./statement.js";
import type { Statement } from "./statement.js";
import type { TryFinallyStatement } from "./statement.js";
import type { ScopeGuardStatement } from "./statement.js";
import type { ForeachStatement } from "./statement.js";
import type { TemplateInstance } from "./dtemplate.js";
import type { AlignDeclaration } from "./attrib.js";
import type { CPPNamespaceDeclaration } from "./attrib.js";
import type { PragmaDeclaration } from "./attrib.js";
import type { DocComment } from "./doc.js";
import type { DeprecatedDeclaration } from "./attrib.js";
import type { UserAttributeDeclaration } from "./attrib.js";
import type { StructDeclaration } from "./dstruct.js";
import type { ClassDeclaration } from "./dclass.js";
import type { AggregateDeclaration } from "./aggregate.js";
import { Identifier } from "./identifier.js";

import type { ErrorSink } from "./errorsink.js";
import { CtorFlow } from "./ctorflow.js"; // value: `Scope.ctorflow` is an inline CtorFlow value
import type { Param } from "./globals.js";
import { LINK, CPPMANGLE, Edition, STC } from "./astenums.js";
import { FeatureState } from "./globals.js";
import { assert } from "../assert.js";

/// dmd/dscope.d:38 — `enum Contract : ubyte`. What kind of contract function we're in, if any.
/// (ubyte base is <= 32 bits -> TS numeric enum, 02 §4.2.)
export enum Contract {
    none = 0,
    invariant_ = 1,
    require = 2, // in contract
    ensure = 3, // out contract
}

/**
 * dmd/dscope.d:47 — `private extern (D) struct FlagBitFields`.
 *
 * Bitfield for settable/copyable flags, see `Scope.copyFlagsFrom`, `Scope.resetAllFlags`.
 *
 * In D this struct is never instantiated: it is the TYPE ARGUMENT of
 * `mixin(generateBitFields!(FlagBitFields, ushort))` (dscope.d:199), i.e. a declarative spec of the
 * member names, their types and their `.init` values, from which common/bitfields.d generates the
 * packed `ushort bitFields` plus one accessor pair per member. It is emitted here verbatim (every D
 * declaration is translated — 14 §3.2) as the readable, testable statement of that layout; the
 * generated accessors live on `Scope`.
 *
 * D `private` here is MODULE-private; exported so the module test can pin the layout (01 §2, 10 §1.7).
 */
export class FlagBitFields {
    ctor = false;              /// constructor type
    noAccessCheck = false;     /// don't do access checks
    condition = false;         /// inside static if/assert condition
    debug_ = false;            /// inside debug conditional
    inTemplateConstraint = false; /// inside template constraint
    contract: Contract = Contract.none;
    ctfe = false;              /// inside a ctfe-only expression
    traitsCompiles = false;    /// inside __traits(compile) or is-expression
    /// ignore symbol visibility
    /// https://issues.dlang.org/show_bug.cgi?id=15907
    ignoresymbolvisibility = false;
    inCfile = false;           /// C semantics apply
    canFree = false;           /// is on free list
    fullinst = false;          /// fully instantiate templates
    ctfeBlock = false;         /// inside a `if (__ctfe)` block

    /**
    Is any symbol this scope is applied to known to have a compile time only accessible context.
    This is not the same as `skipCodegen` nor can it be used to contribute to this.
    It is meant for analysis engines to be conservative in what functions they analyse,
      to prevent perceived false positives for meta-programming heavy code.
    */
    knownACompileTimeOnlyContext = false;

    /**
    When lowering builtin operations to druntime implementations, some assumptions
    made by the previous implementations might no longer hold or have to be inferred
    from the code. With recursive data structures this can easily hit limitations
    of the semantic analysis. To help with backward compatibility, this flag will
    cause semantic analysis of function bodies and template instances to be delayed
    assuming that attribute inference is not necessary.
    */
    deferSemantic3InCompilerHook = false;

    /// Value-struct copy (03 §2 — "every TS class that backs a D struct MUST provide a copy()").
    /// Synthesized, no D counterpart: D never copies this struct (it exists only as the type
    /// argument of `generateBitFields`). Every field is a primitive or an enum, so the copy is
    /// field-wise by value.
    copy(): FlagBitFields {
        const c = new FlagBitFields();
        c.ctor = this.ctor;
        c.noAccessCheck = this.noAccessCheck;
        c.condition = this.condition;
        c.debug_ = this.debug_;
        c.inTemplateConstraint = this.inTemplateConstraint;
        c.contract = this.contract;
        c.ctfe = this.ctfe;
        c.traitsCompiles = this.traitsCompiles;
        c.ignoresymbolvisibility = this.ignoresymbolvisibility;
        c.inCfile = this.inCfile;
        c.canFree = this.canFree;
        c.fullinst = this.fullinst;
        c.ctfeBlock = this.ctfeBlock;
        c.knownACompileTimeOnlyContext = this.knownACompileTimeOnlyContext;
        c.deferSemantic3InCompilerHook = this.deferSemantic3InCompilerHook;
        return c;
    }
}

/**
 * dmd/dscope.d:84 — `private extern (D) struct NonFlagBitFields`.
 *
 * Spec for the SECOND packed word (`Scope.bitFields2`, dscope.d:200-201). Deliberately separate
 * from `FlagBitFields`: `copyFlagsFrom`/`resetAllFlags` operate on `bitFields` only, so these
 * members survive both. Same "never instantiated, layout spec" role as `FlagBitFields` above.
 *
 * D `private` here is MODULE-private; exported so the module test can pin the layout (01 §2, 10 §1.7).
 */
export class NonFlagBitFields {
    intypeof = 0;                   /// ubyte — in typeof(exp)
    nofree = false;                 /// true if shouldn't free it
    inLoop = false;                 /// true if inside a loop (where constructor calls aren't allowed)
    inDefaultArg = false;           /// true if inside a default argument (where __FILE__, etc are evaluated at the call site)
    explicitVisibility = false;     /// set if in an explicit visibility attribute

    /// Value-struct copy (03 §2). Synthesized, no D counterpart — same "layout spec, never
    /// instantiated" role as `FlagBitFields.copy` above. All fields primitive.
    copy(): NonFlagBitFields {
        const c = new NonFlagBitFields();
        c.intypeof = this.intypeof;
        c.nofree = this.nofree;
        c.inLoop = this.inLoop;
        c.inDefaultArg = this.inDefaultArg;
        c.explicitVisibility = this.explicitVisibility;
        return c;
    }
}

/**
 * dmd/dscope.d:96 — `private struct Previews`. State of -preview switches.
 *
 * By making them part of a Scope, we reduce reliance on dmd.globals, and can enable/disable them
 * per module / edition.
 *
 * VALUE struct (02 §2, 03 §2): `Scope.previews` is an inline value, so a `.copy()` is emitted and
 * called at every D copy point (`*sc = this` in `Scope.copy`, `s.previews = this.previews` in
 * `Scope.push`).
 *
 * D `private` here is MODULE-private; exported because `Scope.previews` is public API and every
 * consumer reads `sc.previews.<switch>` (01 §2).
 */
export class Previews {
    // dscope.d:118 — resolved: mixin(generateBitFields!(BitFields, ushort)).
    // Generated layout (common/bitfields.d: bit size = bsr(memType.max | 1) + 1, offsets in
    // declaration order; initial value = OR of each member's .init, all zero here):
    //   bitfields 0(1) dip1000 1(1) dip1008 2(1) dip1021 3(1) dip25 4(1) fieldwise 5(1)
    //   fixAliasThis 6(1) fixImmutableConv 7(1) in_ 8(1) inclusiveInContracts 9(1)
    //   noSharedAccess 10(1) rvalueRefParam 11(1) safer 12(1) systemVariables 13(2)  => 15 of 16 bits.
    // D emits `private ushort bitFields = 0;`; module-private, kept accessible for the layout pins
    // (01 §2, 10 §1.7). `ushort` -> `number` (02 §1); every store below provably stays in [0, 0xFFFF],
    // so no extra 16-bit re-truncation is needed (09 §3).
    bitFields = 0; // D module-private

    get bitfields(): boolean { return ((this.bitFields >>> 0) & 0x1) !== 0; }
    set bitfields(v: boolean) { this.bitFields &= ~(0x1 << 0); this.bitFields |= (v ? 1 : 0) << 0; }
    get dip1000(): boolean { return ((this.bitFields >>> 1) & 0x1) !== 0; }
    set dip1000(v: boolean) { this.bitFields &= ~(0x1 << 1); this.bitFields |= (v ? 1 : 0) << 1; }
    get dip1008(): boolean { return ((this.bitFields >>> 2) & 0x1) !== 0; }
    set dip1008(v: boolean) { this.bitFields &= ~(0x1 << 2); this.bitFields |= (v ? 1 : 0) << 2; }
    get dip1021(): boolean { return ((this.bitFields >>> 3) & 0x1) !== 0; }
    set dip1021(v: boolean) { this.bitFields &= ~(0x1 << 3); this.bitFields |= (v ? 1 : 0) << 3; }
    get dip25(): boolean { return ((this.bitFields >>> 4) & 0x1) !== 0; }
    set dip25(v: boolean) { this.bitFields &= ~(0x1 << 4); this.bitFields |= (v ? 1 : 0) << 4; }
    get fieldwise(): boolean { return ((this.bitFields >>> 5) & 0x1) !== 0; }
    set fieldwise(v: boolean) { this.bitFields &= ~(0x1 << 5); this.bitFields |= (v ? 1 : 0) << 5; }
    get fixAliasThis(): boolean { return ((this.bitFields >>> 6) & 0x1) !== 0; }
    set fixAliasThis(v: boolean) { this.bitFields &= ~(0x1 << 6); this.bitFields |= (v ? 1 : 0) << 6; }
    get fixImmutableConv(): boolean { return ((this.bitFields >>> 7) & 0x1) !== 0; }
    set fixImmutableConv(v: boolean) { this.bitFields &= ~(0x1 << 7); this.bitFields |= (v ? 1 : 0) << 7; }
    get in_(): boolean { return ((this.bitFields >>> 8) & 0x1) !== 0; }
    set in_(v: boolean) { this.bitFields &= ~(0x1 << 8); this.bitFields |= (v ? 1 : 0) << 8; }
    get inclusiveInContracts(): boolean { return ((this.bitFields >>> 9) & 0x1) !== 0; }
    set inclusiveInContracts(v: boolean) { this.bitFields &= ~(0x1 << 9); this.bitFields |= (v ? 1 : 0) << 9; }
    get noSharedAccess(): boolean { return ((this.bitFields >>> 10) & 0x1) !== 0; }
    set noSharedAccess(v: boolean) { this.bitFields &= ~(0x1 << 10); this.bitFields |= (v ? 1 : 0) << 10; }
    get rvalueRefParam(): boolean { return ((this.bitFields >>> 11) & 0x1) !== 0; }
    set rvalueRefParam(v: boolean) { this.bitFields &= ~(0x1 << 11); this.bitFields |= (v ? 1 : 0) << 11; }
    get safer(): boolean { return ((this.bitFields >>> 12) & 0x1) !== 0; }
    set safer(v: boolean) { this.bitFields &= ~(0x1 << 12); this.bitFields |= (v ? 1 : 0) << 12; }
    /// `cast(FeatureState)((bitFields >>> 13) & 0x3)` — unchecked base-integer -> enum cast (02 §4.2);
    /// the port adds NO range validation the frontend does not have.
    get systemVariables(): FeatureState { return (((this.bitFields >>> 13) & 0x3) as FeatureState); }
    set systemVariables(v: FeatureState) { this.bitFields &= ~(0x3 << 13); this.bitFields |= v << 13; }

    /// dmd/dscope.d:120 — `void setFromParams(ref Param params)`. `ref Param` is an alias, NO copy
    /// (03 §3.2); `@nogc nothrow pure @safe` erased (04 §8).
    setFromParams(params: Param): void {
        this.bitfields = params.bitfields;
        this.dip1000 = params.useDIP1000 === FeatureState.enabled;
        this.dip1008 = params.ehnogc;
        this.dip1021 = params.useDIP1021; //  == FeatureState.enabled;
        this.dip25 = params.useDIP25 === FeatureState.enabled;
        this.fixAliasThis = params.fixAliasThis;
        this.fixImmutableConv = params.fixImmutableConv;
        this.in_ = params.previewIn;
        this.inclusiveInContracts = params.inclusiveInContracts;
        this.noSharedAccess = params.noSharedAccess === FeatureState.enabled;
        this.rvalueRefParam = params.rvalueRefParam === FeatureState.enabled;
        this.safer = params.safer === FeatureState.enabled;
        this.systemVariables = params.systemVariables;
        this.fieldwise = params.fieldwise === FeatureState.enabled;
    }

    /// Value-struct copy (03 §2) — synthesized, no D counterpart: D copies a `Previews` with a plain
    /// struct assignment. The whole state is the one packed word, so the copy is that one number.
    copy(): Previews {
        const c = new Previews();
        c.bitFields = this.bitFields;
        return c;
    }
}

/**
 * dmd/dscope.d:99 — `private extern (D) static struct BitFields`, nested inside `Previews`.
 *
 * Run `dmd -preview=h` for the meaning of these switches.
 *
 * Same role as `FlagBitFields`: never instantiated, it is the type argument of
 * `generateBitFields!(BitFields, ushort)` (dscope.d:118). TS cannot nest a class inside a class, so
 * it is declared in the namespace that merges with `class Previews` above — which keeps the D
 * spelling `Previews.BitFields` at every reference (the same device dsymbol.ts uses for
 * `Visibility.Kind`).
 */
export namespace Previews {
    export class BitFields {
        bitfields = false;
        dip1000 = false;
        dip1008 = false;
        dip1021 = false;
        dip25 = false;
        fieldwise = false;
        fixAliasThis = false;
        fixImmutableConv = false;
        in_ = false;
        inclusiveInContracts = false;
        noSharedAccess = false;
        rvalueRefParam = false;
        safer = false;
        systemVariables: FeatureState = FeatureState.default_;

        /// Value-struct copy (03 §2). Synthesized, no D counterpart — same "layout spec, never
        /// instantiated" role as `FlagBitFields.copy`. All fields primitive or enum.
        copy(): Previews.BitFields {
            const c = new Previews.BitFields();
            c.bitfields = this.bitfields;
            c.dip1000 = this.dip1000;
            c.dip1008 = this.dip1008;
            c.dip1021 = this.dip1021;
            c.dip25 = this.dip25;
            c.fieldwise = this.fieldwise;
            c.fixAliasThis = this.fixAliasThis;
            c.fixImmutableConv = this.fixImmutableConv;
            c.in_ = this.in_;
            c.inclusiveInContracts = this.inclusiveInContracts;
            c.noSharedAccess = this.noSharedAccess;
            c.rvalueRefParam = this.rvalueRefParam;
            c.safer = this.safer;
            c.systemVariables = this.systemVariables;
            return c;
        }
    }
}

/***********************************************************
 * dmd/dscope.d:139 — `extern (C++) struct Scope`. A scope as defined by curly braces `{}`.
 * (Not to be confused with the `scope` storage class.)
 *
 * VALUE struct -> class (02 §2). The frontend never passes a `Scope` by value: every declaration,
 * field and parameter in the frontend is `Scope*`, i.e. a reference to this value, and the canonical
 * mapping of `Struct*` is the class reference itself with NO copy (02 §10, 03 §7). `copy()` is D's
 * own member (dscope.d:231) and doubles as the 03 §2 value-copy helper.
 *
 * LIFETIME: D recycles popped scopes through the `freelist` (a hand-rolled arena). That allocator is
 * erased to the JS GC (03 §8) — see `pop()` for the full statement of what that changes.
 */
export class Scope {
    enclosing: Scope | null = null;               /// enclosing Scope

    _module: Module | null = null;                /// Root module
    scopesym: ScopeDsymbol | null = null;         /// current symbol
    func: FuncDeclaration | null = null;          /// function we are in
    varDecl: VarDeclaration | null = null;        /// variable we are in during semantic2
    parent: Dsymbol | null = null;                /// parent to use
    slabel: LabelStatement | null = null;         /// enclosing labelled statement
    switchStatement: SwitchStatement | null = null; /// enclosing switch statement
    tryBody: Statement | null = null;             /// enclosing _body of TryCatchStatement or TryFinallyStatement
    tryFinally: TryFinallyStatement | null = null; /// enclosing try finally statement
    scopeGuard: ScopeGuardStatement | null = null; /// enclosing scope(xxx) statement
    sbreak: Statement | null = null;              /// enclosing statement that supports "break"
    scontinue: Statement | null = null;           /// enclosing statement that supports "continue"
    fes: ForeachStatement | null = null;          /// if nested function for ForeachStatement, this is it
    callsc: Scope | null = null;                  /// used for __FUNCTION__, __PRETTY_FUNCTION__ and __MODULE__
    inunion: Dsymbol | null = null;               /// != null if processing members of a union
    lastVar: VarDeclaration | null = null;        /// Previous symbol used to prevent goto-skips-init
    eSink: ErrorSink | null = null;               /// sink for error messages

    /* If  minst && !tinst, it's in definitely non-speculative scope (eg. module member scope).
     * If !minst && !tinst, it's in definitely speculative scope (eg. template constraint).
     * If  minst &&  tinst, it's in instantiated code scope without speculation.
     * If !minst &&  tinst, it's in instantiated code scope with speculation.
     */
    minst: Module | null = null;                  /// root module where the instantiated templates should belong to
    tinst: TemplateInstance | null = null;        /// enclosing template instance

    ctorflow: CtorFlow = new CtorFlow();          /// flow analysis for constructors

    /// alignment for struct members
    aligndecl: AlignDeclaration | null = null;

    /// C++ namespace this symbol is in
    namespace: CPPNamespaceDeclaration | null = null;

    /// linkage for external functions
    linkage: LINK = LINK.d;

    /// mangle type
    cppmangle: CPPMANGLE = CPPMANGLE.def;

    // resolved: version (IN_LLVM) (dscope.d:183) -> ON (_config.md §1).
    emitInstrumentation = true;   // whether to emit instrumentation with -fprofile-instr-generate

    /// inlining strategy for functions
    inlining: PragmaDeclaration | null = null;

    /// visibility for class members
    visibility: Visibility = new Visibility(Visibility.Kind.public_);

    stc: STC = STC.none;                          /// storage class

    depdecl: DeprecatedDeclaration | null = null; /// customized deprecation message

    // dscope.d:199 — resolved: mixin(generateBitFields!(FlagBitFields, ushort)).
    // Generated layout (bit size = bsr(memType.max | 1) + 1; offsets in FlagBitFields declaration
    // order; initial value = OR of each member's .init, all zero here):
    //   ctor 0(1) noAccessCheck 1(1) condition 2(1) debug_ 3(1) inTemplateConstraint 4(1)
    //   contract 5(2) ctfe 7(1) traitsCompiles 8(1) ignoresymbolvisibility 9(1) inCfile 10(1)
    //   canFree 11(1) fullinst 12(1) ctfeBlock 13(1) knownACompileTimeOnlyContext 14(1)
    //   deferSemantic3InCompilerHook 15(1)  => exactly 16 of 16 bits.
    // D emits `private ushort bitFields = 0;` (module-private; kept accessible here because
    // `copyFlagsFrom`/`resetAllFlags` assign it wholesale and the module test pins the layout —
    // 01 §2, 10 §1.7). `ushort` -> `number` (02 §1); every store provably stays in [0, 0xFFFF] so no
    // extra 16-bit re-truncation is emitted (09 §3).
    bitFields = 0; // D module-private

    get ctor(): boolean { return ((this.bitFields >>> 0) & 0x1) !== 0; }
    set ctor(v: boolean) { this.bitFields &= ~(0x1 << 0); this.bitFields |= (v ? 1 : 0) << 0; }
    get noAccessCheck(): boolean { return ((this.bitFields >>> 1) & 0x1) !== 0; }
    set noAccessCheck(v: boolean) { this.bitFields &= ~(0x1 << 1); this.bitFields |= (v ? 1 : 0) << 1; }
    get condition(): boolean { return ((this.bitFields >>> 2) & 0x1) !== 0; }
    set condition(v: boolean) { this.bitFields &= ~(0x1 << 2); this.bitFields |= (v ? 1 : 0) << 2; }
    get debug_(): boolean { return ((this.bitFields >>> 3) & 0x1) !== 0; }
    set debug_(v: boolean) { this.bitFields &= ~(0x1 << 3); this.bitFields |= (v ? 1 : 0) << 3; }
    get inTemplateConstraint(): boolean { return ((this.bitFields >>> 4) & 0x1) !== 0; }
    set inTemplateConstraint(v: boolean) { this.bitFields &= ~(0x1 << 4); this.bitFields |= (v ? 1 : 0) << 4; }
    /// `cast(Contract)((bitFields >>> 5) & 0x3)` — unchecked base-integer -> enum cast (02 §4.2);
    /// the port adds NO range validation the frontend does not have.
    get contract(): Contract { return (((this.bitFields >>> 5) & 0x3) as Contract); }
    set contract(v: Contract) { this.bitFields &= ~(0x3 << 5); this.bitFields |= v << 5; }
    get ctfe(): boolean { return ((this.bitFields >>> 7) & 0x1) !== 0; }
    set ctfe(v: boolean) { this.bitFields &= ~(0x1 << 7); this.bitFields |= (v ? 1 : 0) << 7; }
    get traitsCompiles(): boolean { return ((this.bitFields >>> 8) & 0x1) !== 0; }
    set traitsCompiles(v: boolean) { this.bitFields &= ~(0x1 << 8); this.bitFields |= (v ? 1 : 0) << 8; }
    get ignoresymbolvisibility(): boolean { return ((this.bitFields >>> 9) & 0x1) !== 0; }
    set ignoresymbolvisibility(v: boolean) { this.bitFields &= ~(0x1 << 9); this.bitFields |= (v ? 1 : 0) << 9; }
    get inCfile(): boolean { return ((this.bitFields >>> 10) & 0x1) !== 0; }
    set inCfile(v: boolean) { this.bitFields &= ~(0x1 << 10); this.bitFields |= (v ? 1 : 0) << 10; }
    get canFree(): boolean { return ((this.bitFields >>> 11) & 0x1) !== 0; }
    set canFree(v: boolean) { this.bitFields &= ~(0x1 << 11); this.bitFields |= (v ? 1 : 0) << 11; }
    get fullinst(): boolean { return ((this.bitFields >>> 12) & 0x1) !== 0; }
    set fullinst(v: boolean) { this.bitFields &= ~(0x1 << 12); this.bitFields |= (v ? 1 : 0) << 12; }
    get ctfeBlock(): boolean { return ((this.bitFields >>> 13) & 0x1) !== 0; }
    set ctfeBlock(v: boolean) { this.bitFields &= ~(0x1 << 13); this.bitFields |= (v ? 1 : 0) << 13; }
    get knownACompileTimeOnlyContext(): boolean { return ((this.bitFields >>> 14) & 0x1) !== 0; }
    set knownACompileTimeOnlyContext(v: boolean) { this.bitFields &= ~(0x1 << 14); this.bitFields |= (v ? 1 : 0) << 14; }
    get deferSemantic3InCompilerHook(): boolean { return ((this.bitFields >>> 15) & 0x1) !== 0; }
    set deferSemantic3InCompilerHook(v: boolean) { this.bitFields &= ~(0x1 << 15); this.bitFields |= (v ? 1 : 0) << 15; }

    // dscope.d:200 — `private ushort bitFields2;` (D module-private; `.init` = 0, 09 §1.0).
    bitFields2 = 0; // D module-private

    // dscope.d:201 — resolved: mixin(generateBitFields!(NonFlagBitFields, ushort, "bitFields2")).
    // The `field` argument is non-empty, so the mixin declares NO storage of its own; it only emits
    // accessors over the `bitFields2` word declared above. Generated layout:
    //   intypeof 0(8) nofree 8(1) inLoop 9(1) inDefaultArg 10(1) explicitVisibility 11(1) => 12 of 16.
    // These flags deliberately do NOT live in `bitFields`, so `copyFlagsFrom`/`resetAllFlags` leave
    // them untouched.
    get intypeof(): number { return (this.bitFields2 >>> 0) & 0xFF; }
    set intypeof(v: number) { this.bitFields2 &= ~(0xFF << 0); this.bitFields2 |= v << 0; }
    get nofree(): boolean { return ((this.bitFields2 >>> 8) & 0x1) !== 0; }
    set nofree(v: boolean) { this.bitFields2 &= ~(0x1 << 8); this.bitFields2 |= (v ? 1 : 0) << 8; }
    get inLoop(): boolean { return ((this.bitFields2 >>> 9) & 0x1) !== 0; }
    set inLoop(v: boolean) { this.bitFields2 &= ~(0x1 << 9); this.bitFields2 |= (v ? 1 : 0) << 9; }
    get inDefaultArg(): boolean { return ((this.bitFields2 >>> 10) & 0x1) !== 0; }
    set inDefaultArg(v: boolean) { this.bitFields2 &= ~(0x1 << 10); this.bitFields2 |= (v ? 1 : 0) << 10; }
    get explicitVisibility(): boolean { return ((this.bitFields2 >>> 11) & 0x1) !== 0; }
    set explicitVisibility(v: boolean) { this.bitFields2 &= ~(0x1 << 11); this.bitFields2 |= (v ? 1 : 0) << 11; }

    previews: Previews = new Previews(); // dscope.d:202 — inline VALUE struct (03 §2)

    // user defined attributes
    userAttribDecl: UserAttributeDeclaration | null = null;

    lastdc: DocComment | null = null;  /// documentation comment for last symbol at this scope (DocComment*)

    /// dscope.d:208 `uint[void*] anchorCounts;` — lookup duplicate anchor name count.
    ///
    /// A D associative array is a reference whose `.init` is NULL; the table is allocated on the first
    /// insert, bound to the variable written (doc.d:1147 `sc.anchorCounts[cast(void*)ident] = 1;`). A
    /// struct copy (`copy()`, and so `push()`) therefore shares an allocated table and duplicates a
    /// null one, after which the two scopes allocate independent tables. `null` models the unallocated
    /// AA, and doc.ts allocates on the scope it inserts through; the key is the Identifier.
    anchorCounts: Map<object, number> | null = null;
    prevAnchor: Identifier | null = null;     /// qualified symbol name of last doc anchor

    aliasAsg: AliasDeclaration | null = null; /// if set, then aliasAsg is being assigned a new value,
                                              /// do not set wasRead for it
    argStruct: StructDeclaration | null = null;    /// elimiate recursion when looking for rvalue construction

    // dmd/dscope.d:215 — `extern (D) __gshared Scope* freelist;`
    static freelist: Scope | null = null;

    /// dmd/dscope.d:217 — pop the freelist head if non-empty, else allocate a fresh Scope.
    /// Ported verbatim. NOTE the freelist is never populated in this port: `pop()` no longer pushes
    /// onto it (03 §8, see there), so control always reaches `new Scope()`. The recycling leg is kept
    /// 1:1 rather than dropped so that re-enabling the arena is a one-site change.
    static alloc(): Scope {
        if (Scope.freelist) {
            const s = Scope.freelist;
            Scope.freelist = s.enclosing;
            //printf("freelist %p\n", s);
            assert(s.canFree);
            s.canFree = false;
            return s;
        }
        return new Scope();
    }

    /// dmd/dscope.d:231 — `extern (D) Scope* copy()`.
    ///
    /// D's body is `Scope* sc = Scope.alloc(); *sc = this; sc.ctorflow.fieldinit = null; return sc;`.
    /// `*sc = this` is a WHOLE-STRUCT copy, expanded here field by field in declaration order
    /// (03 §2): class-reference fields SHARE the referent (02 §10); inline value structs
    /// (`ctorflow`, `visibility`, `previews`) recurse via `.copy()`; primitives / enums / the two
    /// packed bitfield words copy by value; the `anchorCounts` associative array copies its
    /// reference, null while unallocated (see the field declaration).
    /// This member doubles as the 03 §2 value-copy helper for `Scope`.
    copy(): Scope {
        const sc = Scope.alloc();
        // --- class-reference fields: share the referent (02 §10) ---
        sc.enclosing = this.enclosing;
        sc._module = this._module;
        sc.scopesym = this.scopesym;
        sc.func = this.func;
        sc.varDecl = this.varDecl;
        sc.parent = this.parent;
        sc.slabel = this.slabel;
        sc.switchStatement = this.switchStatement;
        sc.tryBody = this.tryBody;
        sc.tryFinally = this.tryFinally;
        sc.scopeGuard = this.scopeGuard;
        sc.sbreak = this.sbreak;
        sc.scontinue = this.scontinue;
        sc.fes = this.fes;
        sc.callsc = this.callsc;
        sc.inunion = this.inunion;
        sc.lastVar = this.lastVar;
        sc.eSink = this.eSink;
        sc.minst = this.minst;
        sc.tinst = this.tinst;
        sc.aligndecl = this.aligndecl;
        sc.namespace = this.namespace;
        sc.inlining = this.inlining;
        sc.depdecl = this.depdecl;
        sc.userAttribDecl = this.userAttribDecl;
        sc.lastdc = this.lastdc;
        sc.prevAnchor = this.prevAnchor;
        sc.aliasAsg = this.aliasAsg;
        sc.argStruct = this.argStruct;
        // --- inline value structs: recurse (03 §2) ---
        sc.ctorflow = this.ctorflow.copy();
        sc.visibility = this.visibility.copy();
        sc.previews = this.previews.copy();
        // --- enums / bigint / primitives / the packed bitfield words: value copy ---
        sc.linkage = this.linkage;
        sc.cppmangle = this.cppmangle;
        sc.emitInstrumentation = this.emitInstrumentation;
        sc.stc = this.stc;
        sc.bitFields = this.bitFields;
        sc.bitFields2 = this.bitFields2;
        // --- associative array: the reference is copied, a null (unallocated) AA as null (see the field) ---
        sc.anchorCounts = this.anchorCounts;

        /* https://issues.dlang.org/show_bug.cgi?id=11777
         * The copied scope should not inherit fieldinit.
         */
        sc.ctorflow.fieldinit = []; // `sc.ctorflow.fieldinit = null;` (a null slice reads as empty, 02 §8)
        return sc;
    }

    /// dmd/dscope.d:242 + dmd/dscope.d:294 — the `push()` / `push(ScopeDsymbol ss)` overload set,
    /// collapsed by ARITY into one method with an optional trailing param (04 §1A Form A: the
    /// 1-arg overload is literally `push()` plus one assignment).
    ///
    /// Pushes a fresh nested scope: clone `this`, link it back to `this`, deep-dup the fieldinit
    /// array, then reset all flags and re-apply only the persistent ones.
    push(ss?: ScopeDsymbol): Scope {
        const s = this.copy();
        //printf("Scope::push(this = %p) new = %p\n", this, s);
        assert(!this.canFree);
        s.scopesym = null;
        s.enclosing = this; // `s.enclosing = &this` — the class reference IS the address (02 §10)
        // resolved: debug { printf + assert(!enclosing.canFree) + assert(s != enclosing) }
        // (dscope.d:249-258) -> OFF (_config.md §3, bare `debug` in a non-debug build).
        s.slabel = null;
        s.nofree = false;
        // `s.ctorflow.fieldinit = ctorflow.fieldinit.arraydup` — `arraydup` of an array of VALUE
        // structs copies each element independently (03 §4); the shallow copy would alias the
        // FieldInit objects.
        s.ctorflow.fieldinit = this.ctorflow.fieldinit.map((fi) => fi.copy());

        // Only keep persistent flags
        s.resetAllFlags();
        s.contract = this.contract;
        s.debug_ = this.debug_;
        s.ctfe = this.ctfe;
        s.traitsCompiles = this.traitsCompiles;
        s.inTemplateConstraint = this.inTemplateConstraint;
        s.noAccessCheck = this.noAccessCheck;
        s.ignoresymbolvisibility = this.ignoresymbolvisibility;
        s.inCfile = this.inCfile;
        s.ctfeBlock = this.ctfeBlock;
        s.previews = this.previews.copy(); // inline value struct (03 §2)
        s.lastdc = null;
        s.knownACompileTimeOnlyContext = this.knownACompileTimeOnlyContext;
        s.deferSemantic3InCompilerHook = this.deferSemantic3InCompilerHook;
        assert(this !== s); // `assert(&this != s)`
        // dscope.d:294 leg — `Scope* push(ScopeDsymbol ss) { Scope* s = push(); s.scopesym = ss; return s; }`
        //printf("Scope::push(%s)\n", ss.toChars());
        if (ss !== undefined)
            s.scopesym = ss;
        return s;
    }

    /// dmd/dscope.d:283 — Copy flags from scope `other`. `@safe` erased (04 §8).
    /// One word assignment: exactly the FlagBitFields members, NOT the `bitFields2` group.
    copyFlagsFrom(other: Scope): void {
        this.bitFields = other.bitFields;
    }

    /// dmd/dscope.d:289 — Set all scope flags to their initial value. `@safe` erased (04 §8).
    /// Every FlagBitFields member's `.init` is zero (bools `false`, `Contract.none == 0`), so the
    /// generated initial word is 0 and D writes it directly.
    resetAllFlags(): void {
        this.bitFields = 0;
    }

    /// dmd/dscope.d:302 — pop this scope: fold its constructor flow into the enclosing scope, release
    /// the fieldinit storage, and return the enclosing scope.
    ///
    /// erased: the freelist recycling leg (dscope.d:310-317) -> JS GC (03 §8). D's
    /// `if (!nofree) { if (mem.isGCEnabled) this = this.init; enclosing = freelist; freelist = &this;
    /// this.canFree = true; }` is arena bookkeeping for a hand-rolled allocator; the popped Scope is
    /// simply dropped here and the GC reclaims it. Stated consequences (not hidden): `canFree` is
    /// never set, so `alloc()` never takes its recycling branch and the `assert(!this.canFree)` in
    /// `push`/`setNoFree` always holds — which is what D observes for every scope still reachable.
    /// The self-reset `this = this.init` likewise disappears: in D it scrubs a scope that is being
    /// handed back to the arena, and here nothing is handed back.
    pop(): Scope | null {
        //printf("Scope::pop() %p nofree = %d\n", this, nofree);
        if (this.enclosing)
            this.enclosing.ctorflow.OR(this.ctorflow);
        this.ctorflow.freeFieldinit();

        const enc = this.enclosing;
        return enc;
    }

    /*************************
     * dmd/dscope.d:325 — Similar to pop(), but the results in `this` are not folded
     * into `enclosing`.
     */
    detach(): void {
        this.ctorflow.freeFieldinit();
        this.enclosing = null;
        this.pop();
    }

    /// dmd/dscope.d:332 — push a CTFE sub-scope.
    /// resolved: the `version (none)` block (dscope.d:337-360, `sc.tinst = null; sc.minst = null;`)
    /// -> OFF (built-in, _config.md §1); dropped together with its explanatory TODO comment.
    startCTFE(): Scope {
        const sc = this.push();
        sc.copyFlagsFrom(this); // `sc.copyFlagsFrom(&this)` — the class reference IS `&this` (02 §10)
        sc.ctfe = true;
        return sc;
    }

    /// dmd/dscope.d:364.
    endCTFE(): Scope | null {
        assert(this.ctfe);
        return this.pop();
    }

    /***************************
     * dmd/dscope.d:375 — Find the innermost scope with a symbol table.
     * Returns:
     *  innermost scope, null if none
     *
     * `return @safe` erased (04 §8).
     */
    inner(): Scope | null {
        for (let sc: Scope | null = this; sc; sc = sc.enclosing) {
            if (sc.scopesym)
                return sc;
        }
        return null;
    }

    /********************************************
     * dmd/dscope.d:388 — Search enclosing scopes for ScopeDsymbol.
     */
    getScopesym(): ScopeDsymbol | null {
        for (let sc: Scope | null = this; sc; sc = sc.enclosing) {
            if (sc.scopesym)
                return sc.scopesym;
        }
        return null; // not found
    }

    /********************************************
     * dmd/dscope.d:401 — Search enclosing scopes for ClassDeclaration.
     *
     * `if (ClassDeclaration cd = sc.scopesym.isClassDeclaration())` is a declaration-in-condition:
     * hoist the decl, test the value (06 "Declaration in a condition").
     */
    getClassScope(): ClassDeclaration | null {
        for (let sc: Scope | null = this; sc; sc = sc.enclosing) {
            if (!sc.scopesym)
                continue;
            const cd = sc.scopesym.isClassDeclaration();
            if (cd)
                return cd;
        }
        return null;
    }

    /********************************************
     * dmd/dscope.d:416 — Search enclosing scopes for ClassDeclaration or StructDeclaration.
     *
     * D's `AggregateDeclaration ad = sc.scopesym.isClassDeclaration()` is an implicit UPCAST. In TS
     * the audited field shadow `AggregateDeclaration.deferred (Dsymbol | null)` over
     * `Dsymbol.deferred (bool)` (aggregate.ts:162 / dsymbol.ts, declared with `@ts-expect-error`)
     * breaks structural assignability of every AggregateDeclaration subclass to the base, so each
     * upcast is spelled with the audited cascade (02 §11.5) — the same one the sibling sema modules
     * use for that shadow.
     */
    getStructClassScope(): AggregateDeclaration | null {
        for (let sc: Scope | null = this; sc; sc = sc.enclosing) {
            if (!sc.scopesym)
                continue;
            const adC = sc.scopesym.isClassDeclaration();
            if (adC)
                // audited upcast cascade (02 §11.5): AggregateDeclaration.deferred (Dsymbol|null)
                // shadows Dsymbol.deferred (bool).
                return adC as unknown as AggregateDeclaration;
            const adS = sc.scopesym.isStructDeclaration();
            if (adS)
                // audited upcast cascade (02 §11.5): AggregateDeclaration.deferred (Dsymbol|null)
                // shadows Dsymbol.deferred (bool).
                return adS as unknown as AggregateDeclaration;
        }
        return null;
    }

    /********************************************
     * dmd/dscope.d:438 — Find the lexically enclosing function (if any).
     *
     * This function skips through generated FuncDeclarations,
     * e.g. rewritten foreach bodies.
     *
     * Returns: the function or null
     *
     * `inout(FuncDeclaration) ... inout` — the const-transfer qualifier and its wrapper both erase
     * (04 attributes), as does the `cast(inout(FuncDeclaration))` on the return. The
     * `cast(FuncDeclaration) this.func` is a same-type cast (the field is already a
     * FuncDeclaration) — nothing to emit.
     */
    getEnclosingFunction(): FuncDeclaration | null {
        if (!this.func)
            return null;

        let fd = this.func;

        // Look through foreach bodies rewritten as delegates
        while (fd.fes) {
            assert(fd.fes.func);
            fd = fd.fes.func!; // D dereferences unconditionally right after the assert (02 §10.1)
        }

        return fd;
    }

    /*******************************************
     * dmd/dscope.d:460 — For TemplateDeclarations, we need to remember the Scope
     * where it was declared. So mark the Scope as not
     * to be free'd.
     */
    setNoFree(): void {
        //int i = 0;
        //printf("Scope::setNoFree(this = %p)\n", this);
        for (let sc: Scope | null = this; sc; sc = sc.enclosing) {
            //printf("\tsc = %p\n", sc);
            sc.nofree = true;
            assert(!this.canFree);
            //assert(sc != sc.enclosing);
            //assert(!sc.enclosing || sc != sc.enclosing.enclosing);
            //if (++i == 10)
            //    assert(0);
        }
    }

    // dscope.d:476 — `@safe @nogc pure nothrow const:` attribute label governing everything below.
    // All five attributes ERASE (04 §8); the label itself leaves no TS token.

    /**********************************
    * dmd/dscope.d:482 — Checks whether the current scope (or any of its parents) is deprecated.
    *
    * Returns: `true` if this or any parent scope is deprecated, `false` otherwise`
    *
    * D walks `for (const(Dsymbol)* sp = &(this.parent); *sp; sp = &(sp.parent))`: a pointer to the
    * `parent` FIELD, dereferenced each iteration. That is exactly iteration over the parent chain
    * (03 §7.2), so it is emitted as the plain chain walk.
    */
    isDeprecated(): boolean {
        for (let sp: Dsymbol | null = this.parent; sp; sp = sp.parent) {
            if (sp.isDeprecated())
                return true;
        }
        for (let sc2: Scope | null = this; sc2; sc2 = sc2.enclosing) {
            if (sc2.scopesym && sc2.scopesym.isDeprecated())
                return true;

            // If inside a StorageClassDeclaration that is deprecated
            if ((sc2.stc & STC.deprecated_) !== 0n)
                return true;
        }
        // D dereferences `_module` with NO null test here (a null `_module` faults); the port keeps
        // that contract with `!` rather than inventing a guard (02 §10.1).
        if (this._module!.md && this._module!.md!.isdeprecated) {
            return true;
        }
        return false;
    }

    /**
     * dmd/dscope.d:512 — dmd relies on mutation of state during semantic analysis, however
     * sometimes semantic is being performed in a speculative context that should
     * not have any visible effect on the rest of the compilation: for example when compiling
     * a typeof() or __traits(compiles).
     *
     * Returns: `true` if this `Scope` is known to be from one of these speculative contexts
     *
     * `intypeof` is a `ubyte`, so its truthiness is expanded to `!== 0` (09 §9); `traitsCompiles` is
     * already a bool. Trailing `scope` erased (04 §8).
     */
    isFromSpeculativeSemanticContext(): boolean {
        return this.intypeof !== 0 || this.traitsCompiles;
    }

    /**
     * dmd/dscope.d:522 — Returns: true if the code needs to go all the way through to code
     * generation. This implies things like needing lowering to simpler forms.
     */
    needsCodegen(): boolean {
        return !this.ctfe && !this.ctfeBlock && !this.traitsCompiles;
    }

    /// dmd/dscope.d:528 — Returns: whether to raise DIP1000 warnings (FeatureStabe.default) or
    /// errors (FeatureState.enabled)
    useDIP1000(): FeatureState {
        return (this.previews.dip1000 || this.hasEdition(Edition.v2024)) ? FeatureState.enabled : FeatureState.disabled;
    }

    /// dmd/dscope.d:534 — Returns: whether to raise DIP25 warnings (FeatureStabe.default) or errors
    /// (FeatureState.enabled)
    useDIP25(): FeatureState {
        return (this.previews.dip25 || this.hasEdition(Edition.v2024)) ? FeatureState.enabled : FeatureState.disabled;
    }

    /// dmd/dscope.d:540 — Returns: whether this scope compiles with `edition` or later.
    /// `_module && ...` is the truthiness of a nullable reference -> `!== null` (06).
    hasEdition(edition: Edition): boolean {
        return this._module !== null && this._module.edition >= edition;
    }

    /// dmd/dscope.d:545.
    isKnownToHaveACompileTimeContext(): boolean {
        return this.knownACompileTimeOnlyContext || this.intypeof !== 0 || this.traitsCompiles || this.ctfe ||
            this.condition || this.inTemplateConstraint || this.ctfeBlock;
    }
}
