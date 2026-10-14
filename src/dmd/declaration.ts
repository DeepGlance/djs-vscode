// Ported from dmd/declaration.d (module dmd.declaration).
//
// "Miscellaneous declarations, including typedef, alias, variable declarations including the
// implicit this declaration, type tuples, ClassInfo, ModuleInfo and various TypeInfos."
//
// WHOLE-FILE FAITHFUL TRANSLATION (14 §3): every top-level D declaration of declaration.d is
// translated, walled (11 §2.5), or dropped-with-comment (07). The file declares the `Declaration`
// hierarchy — the AST nodes that carry a type + storage class.
//
// Cross-core references that are only needed as TYPES are `import type` (erased, breaks the
// core-SCC load cycle, 01 §4.2/§4.5); the ones this module DEREFERENCES at run time (`Type`'s
// TypeInfo statics, `Loc.initial`, `Identifier.idPool`, `OutBuffer`, `mangleToBuffer`, `global`,
// `error`/`fatal`, `FileName`) are value imports — all of them are read inside
// method/function BODIES, never at module top level, so they do not deepen the load cycle.
//
// resolved: version (IN_LLVM) -> ON (LDC build, _config.md §1) at declaration.d:299, :466, :741.
// resolved: version (none) -> OFF (built-in) at declaration.d:590 — the `printf` debug block dropped.
// dropped: bare `debug { … }` block (declaration.d:499-506) — non-debug build (_config.md §3); its
//   body is a commented-out printf plus a commented-out null-store, so nothing is lost.
// dropped: `ulong getMinMax(BitFieldDeclaration, Identifier)` — NOT in declaration.d 1.43.0-beta1;
//   it lives in dmd/dsymbolsem.d:279 as a UFCS free function, and belongs to that file's port.

import {
    bitFieldGet,
    bitFieldSet,
} from "./common/bitfields.js";
import {
    LINK,
    MATCH,
    STC,
    structalign_t,
    type StorageClass,
} from "./astenums.js";
// Dsymbol is the `extends` base for Declaration — a runtime value, so a value import (safe across
// the SCC cycle: `extends` is resolved post-load, 01 §4.1). `Visibility` is a value-struct
// constructed in the ctor (`Visibility(Visibility.Kind.undefined)`), so it is a value import too.
import { Dsymbol, Visibility, DSYM, PASS } from "./dsymbol.js";
// `ds()` builds a DString from an ASCII literal (diagnostics + the mechanical `kind()` accessors);
// `dsSlice` is the `name[0 .. length]` slice in getTypeInfoIdent.
import { ds, dsSlice } from "../dstring.js";
// `assert` reproduces D's `assert(cond)`; `assertUnreachable` is the `assert(0)` translation
// (10 §2 / cheatsheet marker table — NOT a wall).
import { assert, assertUnreachable } from "../assert.js";
// init.d's `Initializer.syntaxCopy()` is a UFCS free function `syntaxCopy(Initializer)` — aliased
// to `syntaxCopyInitializer` to avoid clashing with the `syntaxCopy` methods on the node classes.
import { syntaxCopy as syntaxCopyInitializer } from "./init.js";
// `Id` holds the interned compiler identifiers (`Id.This`, `Id.TypeInfo_*`) used by the ctors.
import { Id } from "./id.js";
// Runtime values dereferenced inside bodies only (no top-level use → no new load-order edge).
import { Loc } from "./location.js";
import { Identifier } from "./identifier.js";
import { Array as DArray } from "./root/array.js";
import { OutBuffer } from "./common/outbuffer.js";
// `./mangle/index.js` is NOT imported here — see the DEFERRED `dmd.mangle` EDGE block below.
import { dmdformat } from "./root/dmdformat.js";
import { global } from "./globals.js";
import { error, fatal } from "./errors.js";
import { FileName } from "./root/filename.js";
// `dmd.dtemplate.isExpression` (dtemplate.d:80), the `dynamic_cast` substitute the two `foreachVar`
// bodies call UFCS-style (04 §6). Read only inside those bodies, and dtemplate.js no longer reads an
// SCC value at load (01 §4.1), so this is an ordinary value import.
import { isExpression } from "./dtemplate.js";
import { Type } from "./mtype.js";

// Cross-core type-only references (import type — erased, breaks the SCC load cycle, 01 §4.2/§4.5).
import type { DString } from "../dstring.js";
import type { TypeTuple } from "./mtype.js";
import type { AggregateDeclaration } from "./aggregate.js";
import type { Expression } from "./expression.js";
import type { Initializer } from "./init.js";
import type { IntRange } from "./intrange.js";
import type { FuncDeclaration } from "./func.js";
import type { ErrorSink } from "./errorsink.js";
import type { Visitor } from "./visitor/index.js";
import type { Objects, FuncDeclarations } from "./arraytypes.js";
import type { Target } from "./target.js";

// ── DEFERRED `dmd.mangle` EDGE (01 §4.4 / translation-order.md §3) ────────────────────────────
// D's `import dmd.mangle;` at declaration.d:725 is FUNCTION-LOCAL: the mangler is needed only when
// `getTypeInfoIdent` actually runs, never at load. Rendering it as a top-level VALUE import is what
// made this module pull the entire semantic layer into its OWN evaluation
// (declaration -> mangle/index -> expressionsem -> canthrow -> dsymbolsem -> clone -> func), so
// func.ts's `class FuncDeclaration extends Declaration` read an undefined base — 01 §4.1's measured
// `TypeError: Class extends value undefined`, which cost 45 test files their collection step.
// ESM has no synchronous deferred import, and Rule 4.4's dynamic `import()` would make
// `getTypeInfoIdent` — and through it `TypeInfoDeclaration`'s CONSTRUCTOR — async, which Rule 4.4
// itself routes to escalation rather than a mechanical rewrite. The edge is therefore inverted:
// mangle/index.ts hands its `mangleToBuffer` to `registerMangleToBuffer` from its own module body.
//
// ORDER CONTRACT: `registerMangleToBuffer` is a hoisted function declaration, so it is callable
// even while this module is still evaluating; the slot it writes is read only at runtime, from
// `getTypeInfoIdent`. Any entry point that constructs a `TypeInfoDeclaration` must therefore have
// `./mangle/index.js` in its module graph — every semantic entry does (typesem, expressionsem and
// semantic2 all import it). If one ever does not, `getTypeInfoIdent` fails loudly rather than
// mangling wrong (there is no fallback). The slot is `var` with NO initializer (01 §4.4): measured, a
// `let … = null` slot here raises `Cannot access 'mangleToBufferDeferred' before initialization` from
// the registrar as soon as an entry evaluates mangle/index.ts before this module's body (the failed
// `import { target }` experiment recorded in the `dmd.target` block below did exactly that).
type MangleToBufferFn = (t: Type, buf: OutBuffer) => void;
var mangleToBufferDeferred: MangleToBufferFn | undefined;

/// Registration point for the deferred `dmd.mangle` edge described above. Called once, from
/// mangle/index.ts's module body. Not a D symbol.
export function registerMangleToBuffer(fn: MangleToBufferFn): void {
    mangleToBufferDeferred = fn;
}

// ── `dmd.target : target` THROUGH A REGISTRATION SLOT (01 §4.4, module-level-import extension) ────
// D imports `dmd.target` at module level (declaration.d:34) and dots into the `__gshared Target
// target` singleton (target.d:1876) at two sites: `target.systemLinkage()` in `resolvedLinkage`
// (declaration.d:111) and `target.ptrsize` in the `TypeInfoDeclaration` ctor (declaration.d:784).
// The faithful value import `import { target } from "./target.js"` breaks module load even at LAST
// position (01 §4.8). Measured on the wave-15 tree: 24 test files die at collect, most with `TypeError:
// Class extends value undefined` at func.ts:356 (`class FuncDeclaration extends Declaration`, entered
// via clone.ts, cond.ts and funcsem.ts: declaration -> target -> typesem -> access -> dsymbolsem ->
// clone -> func), and func.test.ts / semantic2.test.ts with the mangle-slot TDZ noted above. So the
// edge is inverted: the PROVIDER, target.ts, hands its `target` singleton over from its own module
// body (`registerTarget(target);` at its end), and both consuming sites fail LOUDLY while the slot is
// empty, never with a fallback.
//
// ORDER CONTRACT: only an entry whose module graph contains target.js fills the slot. Measured with
// single-entry probes: entries through target.js, parse.js, dmodule.js, dscope.js, typesem.js,
// expressionsem.js, dsymbolsem.js, statementsem.js, semantic3.js, clone.js and mangle/index.js fill
// it; entries through declaration.js, dsymbol.js, dtemplate.js, expression.js, mtype.js, func.js and
// hdrgen.js alone leave it EMPTY, and there `resolvedLinkage` on a `LINK.system` declaration and the
// `TypeInfoDeclaration` ctor raise the load-order error. (Every entry that fills the mangle slot
// fills this one too, so the ctor's new failure point sits behind `getTypeInfoIdent`'s existing
// one.) A test suite whose static imports do not reach target.js loads it (10 §1.5) before the
// first such call.
// The registrar is a hoisted function declaration and the slot is `var` with NO initializer, so a
// provider whose body runs before this module's body neither hits a TDZ nor has its registration
// reset.
var targetSlot: Target | undefined; // target.d:1876 `extern (C++) __gshared Target target;`

/// Registration point for the `dmd.target` edge described above: target.ts hands over its `target`
/// singleton (target.d:1876). Not a D symbol.
export function registerTarget(t: Target): void {
    targetSlot = t;
}

/// Every D read of `target` (target.d:1876) in this module, through the slot above. Not a D symbol:
/// the slot's one reader. `site` names the D function doing the read and `dline` its D line; an empty
/// slot (the load-order contract, not a D branch) raises `declaration.<site>: registerTarget not
/// called …`.
function targetAt(site: string, dline: string): Target {
    if (targetSlot === undefined)
        throw new Error(`declaration.${site}: registerTarget not called (dmd/declaration.d:${dline})`);
    return targetSlot;
}

/******************************************
 * declaration.d:41 — the runtime `object` module (or one of its TypeInfo classes) is missing.
 *
 * Ungags errors, prints the host-compiler-specific diagnostic, then aborts via `fatal()`.
 * Cost: emits a diagnostic and NEVER returns (fatal exits the process).
 */
export function ObjectNotFound(loc: Loc, id: Identifier): void {
    global.gag = 0; // never gag the fatal error
    const dmdConfFile: DString | null =
        global.inifilename.length !== 0 ? FileName.canonicalName(global.inifilename) : ds("not found");

    // resolved: mixin HostObjectNotFound (targetcompiler.d:189) -> the nested `hostObjectNotFound`
    // it declares, inlined here as a nested closure (04 §5).
    // resolved: version(IN_LLVM) inside it -> ON; the three ldc2 supplementals are the live arm.
    // dropped: version(MARS) supplementals (targetcompiler.d:205-206) — the only reader of
    //   `configFile`. The parameter is kept (leading `_` per TS unused-parameter convention) so the
    //   call at declaration.d:47 stays 1:1 with the D mixin's signature.
    const hostObjectNotFound = (loc: Loc, id: DString, _configFile: DString | null, eSink: ErrorSink): void => {
        eSink.error(loc, ds("`%s` not found. object.d may be incorrectly installed or corrupt."), id);
        eSink.errorSupplemental(loc, ds("ldc2 might not be correctly installed."));
        eSink.errorSupplemental(loc, ds("Please check your ldc2.conf configuration file."));
        eSink.errorSupplemental(loc, ds("Installation instructions can be found at http://wiki.dlang.org/LDC."));
    };
    hostObjectNotFound(loc, id.toChars(), dmdConfFile, global.errorSink!); // print host-specific diagnostic
    fatal();
}

/* Accumulator for successive matches.
 *
 * declaration.d:53 — plain value struct (03 §1/§6): field-wise `.copy()`, no postblit/opAssign.
 * `count` is `int` -> 0; `last` is declared `MATCH.nomatch`; `lastf`/`nextf` are class refs -> null.
 */
export class MatchAccumulator {
    count: number = 0;              // number of matches found so far — int
    last: MATCH = MATCH.nomatch;    // match level of lastf
    lastf: FuncDeclaration | null = null;  // last matching function we found
    nextf: FuncDeclaration | null = null;  // if ambiguous match, this is the "other" function

    /// Field-wise copy (03 §2): primitives/enums by value, class references SHARED.
    copy(): MatchAccumulator {
        const c = new MatchAccumulator();
        c.count = this.count;       // primitive
        c.last = this.last;         // enum value
        c.lastf = this.lastf;       // class reference: share (03 §2)
        c.nextf = this.nextf;       // class reference: share (03 §2)
        return c;
    }
}

/***********************************************************
 * declaration.d:63 — `extern (C++) abstract class Declaration : Dsymbol`.
 *
 * Base of every declared symbol carrying a type + storage class (variables, aliases, functions,
 * tuples, TypeInfos, …). Abstract: never instantiated directly.
 *
 * Bit-field group (declaration.d:73-84, `mixin(generateBitFields!(BitFields, ubyte))`): the nested
 * `BitFields` struct is packed into ONE `ubyte`-width unsigned word plus generated shift/mask
 * getter+setter pairs (07 §5/§6 resolves the CTFE string mixin; 11 §3.6; common/bitfields.ts holds
 * the two arithmetic primitives). Per-member bit size is `bsr(memType.max | 1) + 1`
 * (common/bitfields.d:51), offsets run in declaration order:
 *   _linkage     : off 0, size 3  (LINK : ubyte, max = LINK.system = 6 -> bsr(7)+1 = 3)
 *   wasRead      : off 3, size 1
 *   ignoreRead   : off 4, size 1
 *   noUnderscore : off 5, size 1
 *   hidden       : off 6, size 1
 *   nrvo         : off 7, size 1        (total 8 bits, fits `ubyte`)
 * Generated init value: `_linkage = LINK.default_` (0) and every bool false -> packed word 0.
 *
 * The generated storage field is `private ubyte bitFields` in BOTH `Declaration` and (as a
 * DIFFERENT, shadowing field) `VarDeclaration`. TS has one property slot per name, so the derived
 * word is renamed `varBitFields` there — see the note on VarDeclaration.
 */
export abstract class Declaration extends Dsymbol {
    type: Type | null = null;
    originalType: Type | null = null;   // before semantic analysis
    storage_class: STC = STC.none;
    // overridden symbol with pragma(mangle, "...") — const(char)[] -> DString (02 §1.3), .init null
    mangleOverride: DString | null = null;
    visibility!: Visibility;            // value struct (assigned in ctor)
    inuse: number = 0;                  // short — used to detect cycles

    // Packed bit-field word (declaration.d:84). `ubyte` storage -> number domain (09 §0/§1),
    // held unsigned. D marks the generated word `private` (common/bitfields.d:117) and NOTHING in
    // declaration.d reaches it from module scope — no sibling function, and the module has no
    // `unittest{}` (verified: `grep -c '^unittest' dmd/declaration.d` = 0). By 01 §2.5's table that
    // is the "touched only from within its own class" row, so TS `private` is the faithful emission.
    private bitFields: number = 0;

    // _linkage: may be `LINK.system`; use `resolvedLinkage()` to resolve it.
    get _linkage(): LINK { return bitFieldGet(this.bitFields, 0, 0x7) as LINK; }
    set _linkage(v: LINK) { this.bitFields = bitFieldSet(this.bitFields, 0, 0x7, v as number); }
    // wasRead: set if AliasDeclaration was read
    get wasRead(): boolean { return bitFieldGet(this.bitFields, 3, 0x1) !== 0; }
    set wasRead(v: boolean) { this.bitFields = bitFieldSet(this.bitFields, 3, 0x1, v ? 1 : 0); }
    // ignoreRead: ignore any reads of AliasDeclaration
    get ignoreRead(): boolean { return bitFieldGet(this.bitFields, 4, 0x1) !== 0; }
    set ignoreRead(v: boolean) { this.bitFields = bitFieldSet(this.bitFields, 4, 0x1, v ? 1 : 0); }
    // noUnderscore: don't prepend _ to mangled name
    get noUnderscore(): boolean { return bitFieldGet(this.bitFields, 5, 0x1) !== 0; }
    set noUnderscore(v: boolean) { this.bitFields = bitFieldSet(this.bitFields, 5, 0x1, v ? 1 : 0); }
    // hidden: don't print this in .di files
    get hidden(): boolean { return bitFieldGet(this.bitFields, 6, 0x1) !== 0; }
    set hidden(v: boolean) { this.bitFields = bitFieldSet(this.bitFields, 6, 0x1, v ? 1 : 0); }
    // nrvo: forward to fd.nrvo_var when generating code
    get nrvo(): boolean { return bitFieldGet(this.bitFields, 7, 0x1) !== 0; }
    set nrvo(v: boolean) { this.bitFields = bitFieldSet(this.bitFields, 7, 0x1, v ? 1 : 0); }

    // declaration.d:86 `this(DSYM tag, Identifier ident)` and :92 `this(DSYM tag, Loc loc,
    // Identifier ident)` — Form A arity dispatch (04 §1): the shorter form is the longer one with
    // `loc` defaulted, exactly as `Dsymbol`'s own ctor set is collapsed (dsymbol.ts). Both D ctors
    // set `visibility = Visibility(Visibility.Kind.undefined)`.
    protected constructor(tag: DSYM, loc: Loc | null = null, ident: Identifier | null = null) {
        super(tag, loc, ident);
        this.visibility = new Visibility(Visibility.Kind.undefined);
    }

    override kind(): DString { return ds("declaration"); }

    isStatic(): boolean { return (this.storage_class & STC.static_) !== 0n; }

    /// declaration.d:109 — the linkage, resolving the target-specific `System` one.
    resolvedLinkage(): LINK {
        // `target` is read through the registration slot (see the `dmd.target` block under the imports).
        return this._linkage === LINK.system ? targetAt("resolvedLinkage", "111").systemLinkage() : this._linkage;
    }

    isDelete(): boolean { return false; }
    isDataseg(): boolean { return false; }
    isThreadlocal(): boolean { return false; }
    isCodeseg(): boolean { return false; }

    isFinal(): boolean { return (this.storage_class & STC.final_) !== 0n; }
    isAbstract(): boolean { return (this.storage_class & STC.abstract_) !== 0n; }
    isConst(): boolean { return (this.storage_class & STC.const_) !== 0n; }
    isImmutable(): boolean { return (this.storage_class & STC.immutable_) !== 0n; }
    isWild(): boolean { return (this.storage_class & STC.wild) !== 0n; }
    isAuto(): boolean { return (this.storage_class & STC.auto_) !== 0n; }
    isScope(): boolean { return (this.storage_class & STC.scope_) !== 0n; }
    isReturn(): boolean { return (this.storage_class & STC.return_) !== 0n; }
    isSynchronized(): boolean { return (this.storage_class & STC.synchronized_) !== 0n; }
    isParameter(): boolean { return (this.storage_class & STC.parameter) !== 0n; }
    override isDeprecated(): boolean { return (this.storage_class & STC.deprecated_) !== 0n; }
    isDisabled(): boolean { return (this.storage_class & STC.disable) !== 0n; }
    isOverride(): boolean { return (this.storage_class & STC.override_) !== 0n; }
    isResult(): boolean { return (this.storage_class & STC.result) !== 0n; }
    isField(): boolean { return (this.storage_class & STC.field) !== 0n; }
    isIn(): boolean { return (this.storage_class & STC.in_) !== 0n; }
    isOut(): boolean { return (this.storage_class & STC.out_) !== 0n; }
    isRef(): boolean { return (this.storage_class & STC.ref_) !== 0n; }

    /// Returns: Whether the variable is a reference, annotated with `out` or `ref`
    isReference(): boolean { return (this.storage_class & (STC.ref_ | STC.out_)) !== 0n; }

    isFuture(): boolean { return (this.storage_class & STC.future) !== 0n; }
    isSystem(): boolean { return (this.storage_class & STC.system) !== 0n; }

    /// declaration.d:240 — `override final Visibility visible() { return visibility; }`. `Visibility`
    /// is a struct, so D returns a COPY (03 §1 #3). No elision: `Visibility` is NOT in the 03 §9.1
    /// alias-safe register (it has a live in-scope mutator, attrib.ts:296) and every caller
    /// (access.ts:257/:313/:442, dscope.ts:655) is outside this file, so condition §9.1 cannot be
    /// discharged here. Same shape as the sibling with the byte-identical D body, aggregate.ts:288.
    override visible(): Visibility { return this.visibility.copy(); }

    override accept(v: Visitor): void { v.visitDeclaration(this); }
}

/***********************************************************
 * declaration.d:253 — `extern (C++) final class TupleDeclaration : Declaration`.
 * `alias seq = AliasSeq!(...)` — a type tuple or an expression tuple of declarations.
 */
export class TupleDeclaration extends Declaration {
    objects: Objects | null;               // `Objects*` -> the container reference (02 §10 case 2)
    tupletype: TypeTuple | null = null;    // !=null if this is a type tuple
    isexp: boolean = false;                // true: expression tuple
    building: boolean = false;             // it's growing in AliasAssign semantic

    constructor(loc: Loc, ident: Identifier, objects: Objects | null) {
        super(DSYM.tupleDeclaration, loc, ident);
        this.objects = objects;
    }

    // declaration.d:266 — `syntaxCopy` is `assert(0)` (a sequence is never produced by syntax).
    override syntaxCopy(_s: Dsymbol | null): TupleDeclaration {
        return assertUnreachable();
    }

    override kind(): DString { return ds("sequence"); }

    override needThis(): boolean {
        //printf("TupleDeclaration::needThis(%s)\n", toChars());
        // declaration.d:279 — the delegate returns `bool`, implicitly converted to the `int`
        // overload's return type; reproduced as the explicit 1/0.
        return this.isexp ? this.foreachVarFromIntDelegate((s) => (s.needThis() ? 1 : 0)) !== 0 : false;
    }

    /***********************************************************
     * declaration.d:288 — calls dg(Dsymbol) for each Dsymbol, which should be a VarDeclaration
     * inside VarExp (isexp == true).
     *
     * Overload set (04 §1B, same arity / different parameter TYPE, so renamed — the bare name goes
     * to the most-called D form, this one): `foreachVar(void delegate(Dsymbol))` keeps `foreachVar`;
     * `foreachVar(Visitor)` -> `foreachVarFromVisitor`; `foreachVar(int delegate(Dsymbol))` ->
     * `foreachVarFromIntDelegate`. Every D call site resolves statically, so each is rewritten to
     * the renamed target — no runtime type test.
     *
     * `dg` is non-null-taking (02 §10.1 union-of-bodies rule). The D call sites that bind THIS
     * overload — the delegate returns `void` — are dsymbolsem.d:8599 (`s.setFieldOffset(…)`) and
     * :8965 (`s => s.adjustBaseOffset(offset)`), expressionsem.d:2494 (`s.isDeclaration()`),
     * inline.d:2624 and ob.d:1416/:2157 (`void symbolDg(Dsymbol)` / `void Dsymbol_visit(Dsymbol)`),
     * semantic2.d:749 (`s.accept(this)`), statementsem.d:316 (`toStatement(v)`),
     * visitor/foreachvar.d:77 (`dgVar(s.isVarDeclaration())`), plus dtoh.d:1733 (excluded module).
     * All of them dereference `s` unconditionally except inline.d:737 (`(s) { s; }`), which
     * dereferences nothing and therefore neither supports nor contradicts the non-null typing.
     * canthrow.d:267, dinterpret.d:2306 and dsymbolsem.d:7285 bind the `int delegate` overload
     * (`foreachVarFromIntDelegate` below), not this one.
     * Params:
     *    dg = delegate to call for each Dsymbol
     */
    foreachVar(dg: (s: Dsymbol) => void): void {
        assert(this.isexp);
        for (const o of this.objects!) {
            // `o.isExpression()` is UFCS for `dmd.dtemplate.isExpression(o)` (04 §6), receiver
            // first. `if (auto e = ...)` is a declaration in a condition: hoist the decl, test the
            // value (06 "Declaration in a condition").
            const e = isExpression(o);
            if (e !== null) {
                const ve = e.isVarExp();
                if (ve !== null)
                    dg(ve.var_);   // `ve.var` — SymbolExp.var_ is non-nullable (expression.ts:1692)
            }
        }
    }

    // resolved: version (IN_LLVM) -> ON (declaration.d:299). Visitor-driven form of foreachVar.
    foreachVarFromVisitor(v: Visitor): void {
        this.foreachVar((sym) => sym.accept(v));
    }

    /***********************************************************
     * declaration.d:314 — calls dg(Dsymbol) for each Dsymbol, which should be a VarDeclaration
     * inside VarExp (isexp == true).
     * If dg returns !=0, stops and returns that value else returns 0.
     * Params:
     *    dg = delegate to call for each Dsymbol
     * Returns:
     *    last value returned by dg()
     *
     * `dg` is non-null-taking (02 §10.1): the D call sites binding THIS overload are canthrow.d:267
     * (`int symbolDg(Dsymbol s)`, canthrow.d:228), dinterpret.d:2306 (`s.isVarDeclaration()`) and
     * dsymbolsem.d:7285 (`tv => tv.apply(…)`) — each dereferences `s` unconditionally.
     */
    foreachVarFromIntDelegate(dg: (s: Dsymbol) => number): number {
        assert(this.isexp);
        for (const o of this.objects!) {
            // `o.isExpression()` — same UFCS call as the void overload above (dmd/declaration.d:319).
            const e = isExpression(o);
            if (e !== null) {
                const ve = e.isVarExp();
                if (ve !== null) {
                    const ret = dg(ve.var_);
                    if (ret !== 0)
                        return ret;
                }
            }
        }
        return 0;
    }

    override accept(v: Visitor): void { v.visitTupleDeclaration(this); }
}

/***********************************************************
 * declaration.d:336 — `extern (C++) final class AliasDeclaration : Declaration`.
 * https://dlang.org/spec/declaration.html#AliasDeclaration
 *
 * CONSTRUCTOR OVERLOAD SET (Form B, 04 §1B): D declares `this(Loc, Identifier, Type)`
 * (declaration.d:343) and `this(Loc, Identifier, Dsymbol)` (declaration.d:351) — SAME arity,
 * different third-parameter type. TS cannot overload a constructor by parameter type, and a runtime
 * type test is explicitly forbidden (the D compiler already picked one statically at every call
 * site). So both are promoted to named static factories — `AliasDeclaration.fromType(...)` and
 * `AliasDeclaration.fromDsymbol(...)` — and the constructor itself is private, holding only the
 * shared `super(...)` prologue. D's own `static create` (declaration.d:360) is the Type form and
 * delegates to `fromType`.
 *
 * Why BOTH become factories rather than 04 §1B(c)'s "primary form keeps the `constructor`": §1B(c)
 * assumes the non-primary form can be EXPRESSED THROUGH the primary one (its own example,
 * `SourceLoc.fromLoc`, starts from a default `new SourceLoc(...)`). Here the two D ctor bodies set
 * DISJOINT fields — the Type form does `this.type = type; assert(type)`, the Dsymbol form does
 * `assert(s != this); this.aliassym = s; assert(s)` and never touches `type` — so routing the
 * Dsymbol form through a Type-form constructor would need a fabricated `Type` argument, which would
 * then have to be un-assigned (and `syntaxCopy` below branches on `type !== null`, so that transient
 * state is load-bearing, not cosmetic). Per 11 §1's operating rule a rule is not stretched past what
 * it literally addresses; the shape used instead is the tree's existing precedent for a
 * disjoint-field Form-B ctor set, `ArrayScopeSymbol` (dsymbol.ts:1597, three D ctors, private
 * prologue ctor + `fromExpression`/`fromTypeTuple`/`fromTupleDeclaration`).
 *
 * CALL-SITE REWRITES OWED (04 §1B: the rename is only half the rule). Three `new AliasDeclaration`
 * sites live in parse.ts, which this file may not edit (14 §2 single-writer), so they are filed as
 * an escalation for the integrator instead of being left to rot silently:
 *   parse.ts:4385  `new AliasDeclaration(aliasLoc, ident!, t)` (Type)    -> `AliasDeclaration.fromType(...)`
 *   parse.ts:4718  `new AliasDeclaration(loc, ident, s)`       (Dsymbol) -> `AliasDeclaration.fromDsymbol(...)`
 *   parse.ts:4777  `new AliasDeclaration(loc, ident, t)`       (Type)    -> `AliasDeclaration.fromType(...)`
 * Each target is the form D's overload resolution already picked at that site (parse.d), so the
 * rewrite is mechanical and needs no runtime test.
 */
// D's `static create` factories are NON-VIRTUAL and independent per class (dsymbol.d:397 vs
// declaration.d:360) — they merely share a name. TS models statics as an inherited "static side"
// and rejects the differing signature (TS2417, reported on the class line). Localized, audited
// suppression; the `static override create` member below keeps noImplicitOverride satisfied.
// @ts-expect-error D non-virtual static factory: AliasDeclaration.create signature differs from Dsymbol.create.
export class AliasDeclaration extends Declaration {
    aliassym: Dsymbol | null = null;   // alias ident = aliassym;
    overnext: Dsymbol | null = null;   // next in overload list
    _import: Dsymbol | null = null;    // !=null if unresolved internal alias for selective import

    // Shared prologue of the two D ctors (both call `super(DSYM.aliasDeclaration, loc, ident)`).
    private constructor(loc: Loc, ident: Identifier) {
        super(DSYM.aliasDeclaration, loc, ident);
    }

    /// declaration.d:343 — `this(Loc loc, Identifier ident, Type type)`.
    static fromType(loc: Loc, ident: Identifier, type: Type): AliasDeclaration {
        const a = new AliasDeclaration(loc, ident);
        //debug printf("AliasDeclaration(id = '%s', type = `%s`, %p)\n", …);
        a.type = type;
        assert(type !== null);   // D `assert(type)` — nullable-reference truthiness expanded (06 §2.7)
        return a;
    }

    /// declaration.d:351 — `this(Loc loc, Identifier ident, Dsymbol s)`.
    static fromDsymbol(loc: Loc, ident: Identifier, s: Dsymbol): AliasDeclaration {
        const a = new AliasDeclaration(loc, ident);
        //debug printf("AliasDeclaration(id = '%s', s = `%s`)\n", ident.toChars(), s.toChars());
        assert(s !== a);
        a.aliassym = s;
        assert(s !== null);      // D `assert(s)` — nullable-reference truthiness expanded (06 §2.7)
        return a;
    }

    // `static override`: shadows the inherited Dsymbol.create (D static factories hide the base;
    // TS requires `override`, noImplicitOverride). Signature intentionally differs from the base.
    static override create(loc: Loc, id: Identifier, type: Type): AliasDeclaration {
        return AliasDeclaration.fromType(loc, id, type);
    }

    // declaration.d:365 — deep parse-time clone: re-construct from a copy of `type` or `aliassym`,
    // then carry over comment + storage_class. `loc` is passed bare: the `Dsymbol` ctor copies the
    // value struct itself, so a call-site `.copy()` would be a provably-redundant second copy
    // (03 §9 licensed elision).
    override syntaxCopy(s: Dsymbol | null): AliasDeclaration {
        //printf("AliasDeclaration::syntaxCopy()\n");
        assert(s === null);
        const sa = this.type !== null
            ? AliasDeclaration.fromType(this.loc, this.ident!, this.type.syntaxCopy())
            : AliasDeclaration.fromDsymbol(this.loc, this.ident!, this.aliassym!.syntaxCopy(null));
        sa.addComment(this.comment());
        sa.storage_class = this.storage_class;
        return sa;
    }

    override kind(): DString { return ds("alias"); }

    override isOverloadable(): boolean {
        // assume overloadable until alias is resolved
        return this.semanticRun < PASS.semanticdone ||
            (this.aliassym !== null && this.aliassym.isOverloadable());
    }

    /** Returns: `true` if this instance was created to make a template parameter visible in the
     * scope of a template body, `false` otherwise */
    isAliasedTemplateParameter(): boolean {
        return (this.storage_class & STC.templateparameter) !== 0n;
    }

    override accept(v: Visitor): void { v.visitAliasDeclaration(this); }
}

/***********************************************************
 * declaration.d:402 — `extern (C++) final class OverDeclaration : Declaration`.
 */
export class OverDeclaration extends Declaration {
    overnext: Dsymbol | null = null;   // next in overload list
    aliassym: Dsymbol | null = null;

    constructor(ident: Identifier, s: Dsymbol | null) {
        super(DSYM.overDeclaration, null, ident); // declaration.d:409 — `super(tag, ident)` (no loc)
        this.aliassym = s;
    }

    override kind(): DString { return ds("overload alias"); } // todo

    override isOverloadable(): boolean { return true; }

    override accept(v: Visitor): void { v.visitOverDeclaration(this); }
}

/***********************************************************
 * declaration.d:433 — `extern (C++) class VarDeclaration : Declaration`.
 *
 * Note: dsymbolSemantic turns a VarDeclaration inside a function into
 * AssignExp(e1: VarExp, e2: ConstructExp or BlitExp).
 *
 * Bit-field group (declaration.d:453-485, `mixin(generateBitFields!(BitFields, uint))`): all 16
 * members are `bool` (1 bit each), offsets in declaration order, packed into ONE `uint` word.
 *   isargptr 0, ctorinit 1, iscatchvar 2, isowner 3, setInCtorOnly 4, onstack 5,
 *   onstackWithMatchingDynType 6, overlapped 7, overlapUnsafe 8, maybeScope 9, doNotInferReturn 10,
 *   isArgDtorVar 11, isCmacro 12, dllImport 13, dllExport 14, systemInferred 15.
 * resolved: version (IN_LLVM) (declaration.d:466) -> ON, so `onstackWithMatchingDynType` is present
 *   and occupies bit 6 (it would not exist in a MARS build — the layouts differ by design).
 * resolved: `mixin VarDeclarationExtra;` (declaration.d:480) -> EMPTY for IN_LLVM
 *   (targetcompiler.d:58 `mixin template VarDeclarationExtra() { }`); the populated MARS form
 *   (`inClosure`/`inAlignSection`) is the OFF branch, so no bits are contributed there.
 *
 * The generated storage field is named `bitFields` in D, which SHADOWS `Declaration.bitFields`
 * (a distinct `ubyte` slot). TS has a single property slot per name, and letting the two groups
 * share one word would silently overlap `_linkage`/`wasRead`/… with `isargptr`/`ctorinit`/… — so
 * the derived word is `varBitFields` here. It is a mixin-GENERATED name, `private` in D and read by
 * nothing but its own accessors, so the rename is invisible to any D call site.
 */
// @ts-expect-error D non-virtual static factory: VarDeclaration.create signature differs from Dsymbol.create (see AliasDeclaration).
export class VarDeclaration extends Declaration {
    _init: Initializer | null = null;
    // `FuncDeclarations nestedrefs;` — an `Array!T` VALUE field: default-constructed, not null
    // (09 §1.0 struct `.init` = field-wise). Constructed AS the alias's element type (08 §3).
    nestedrefs: FuncDeclarations = new DArray<FuncDeclaration | null>();
    aliasTuple: TupleDeclaration | null = null;  // when `this` is really a tuple of declarations
    lastVar: VarDeclaration | null = null;  // Linked list of variables for goto-skips-init detection
    edtor: Expression | null = null;        // if !=null, does the destruction of the variable
    range: IntRange | null = null;          // if !=null, the variable is known to be within the range

    endlinnum: number = 0;                  // line number of end of scope that this var lives in — uint
    offset: number = 0;                     // uint
    sequenceNumber: number = 0;             // order the variables are declared — uint
    alignment: structalign_t = new structalign_t();  // value struct, default-constructed (09 §1.0)

    // When interpreting, these point to the value (NULL if value not determinable)
    // The index of this variable on the CTFE stack, AdrOnStackNone if not allocated
    // declaration.d:449 — `enum AdrOnStackNone = ~0u;` manifest constant -> `const` (02 §4.1),
    // folded to the 32-bit unsigned literal (09 §4.1: `~0u` is 0xffffffff).
    static readonly AdrOnStackNone = 0xffffffff;
    ctfeAdrOnStack: number = 0;             // uint

    // Packed bit-field word (declaration.d:485). `uint` storage -> number domain, held unsigned (09).
    // `private` for the same reason as `Declaration.bitFields` above (01 §2.5).
    private varBitFields: number = 0;

    get isargptr(): boolean { return bitFieldGet(this.varBitFields, 0, 0x1) !== 0; }           /// if parameter that _argptr points to
    set isargptr(v: boolean) { this.varBitFields = bitFieldSet(this.varBitFields, 0, 0x1, v ? 1 : 0); }
    get ctorinit(): boolean { return bitFieldGet(this.varBitFields, 1, 0x1) !== 0; }           /// it has been initialized in a ctor
    set ctorinit(v: boolean) { this.varBitFields = bitFieldSet(this.varBitFields, 1, 0x1, v ? 1 : 0); }
    get iscatchvar(): boolean { return bitFieldGet(this.varBitFields, 2, 0x1) !== 0; }         /// this is the exception object variable in catch() clause
    set iscatchvar(v: boolean) { this.varBitFields = bitFieldSet(this.varBitFields, 2, 0x1, v ? 1 : 0); }
    get isowner(): boolean { return bitFieldGet(this.varBitFields, 3, 0x1) !== 0; }            /// this is an Owner, despite it being `scope`
    set isowner(v: boolean) { this.varBitFields = bitFieldSet(this.varBitFields, 3, 0x1, v ? 1 : 0); }
    get setInCtorOnly(): boolean { return bitFieldGet(this.varBitFields, 4, 0x1) !== 0; }      /// field can only be set in a constructor
    set setInCtorOnly(v: boolean) { this.varBitFields = bitFieldSet(this.varBitFields, 4, 0x1, v ? 1 : 0); }
    /// It is a class that was allocated on the stack: not rebindable once assigned, and the
    /// destructor gets run when it goes out of scope.
    get onstack(): boolean { return bitFieldGet(this.varBitFields, 5, 0x1) !== 0; }
    set onstack(v: boolean) { this.varBitFields = bitFieldSet(this.varBitFields, 5, 0x1, v ? 1 : 0); }
    // resolved: version (IN_LLVM) -> ON (declaration.d:466). And dynamic type is equivalent to static type.
    get onstackWithMatchingDynType(): boolean { return bitFieldGet(this.varBitFields, 6, 0x1) !== 0; }
    set onstackWithMatchingDynType(v: boolean) { this.varBitFields = bitFieldSet(this.varBitFields, 6, 0x1, v ? 1 : 0); }
    get overlapped(): boolean { return bitFieldGet(this.varBitFields, 7, 0x1) !== 0; }         /// if it is a field and has overlapping
    set overlapped(v: boolean) { this.varBitFields = bitFieldSet(this.varBitFields, 7, 0x1, v ? 1 : 0); }
    get overlapUnsafe(): boolean { return bitFieldGet(this.varBitFields, 8, 0x1) !== 0; }      /// if it is an overlapping field and the overlaps are unsafe
    set overlapUnsafe(v: boolean) { this.varBitFields = bitFieldSet(this.varBitFields, 8, 0x1, v ? 1 : 0); }
    get maybeScope(): boolean { return bitFieldGet(this.varBitFields, 9, 0x1) !== 0; }         /// allow inferring 'scope' for this variable
    set maybeScope(v: boolean) { this.varBitFields = bitFieldSet(this.varBitFields, 9, 0x1, v ? 1 : 0); }
    get doNotInferReturn(): boolean { return bitFieldGet(this.varBitFields, 10, 0x1) !== 0; }  /// do not infer 'return' for this variable
    set doNotInferReturn(v: boolean) { this.varBitFields = bitFieldSet(this.varBitFields, 10, 0x1, v ? 1 : 0); }
    get isArgDtorVar(): boolean { return bitFieldGet(this.varBitFields, 11, 0x1) !== 0; }      /// temporary created to handle scope destruction of a function argument
    set isArgDtorVar(v: boolean) { this.varBitFields = bitFieldSet(this.varBitFields, 11, 0x1, v ? 1 : 0); }
    get isCmacro(): boolean { return bitFieldGet(this.varBitFields, 12, 0x1) !== 0; }          /// it is a C macro turned into a C declaration
    set isCmacro(v: boolean) { this.varBitFields = bitFieldSet(this.varBitFields, 12, 0x1, v ? 1 : 0); }
    get dllImport(): boolean { return bitFieldGet(this.varBitFields, 13, 0x1) !== 0; }         /// __declspec(dllimport)
    set dllImport(v: boolean) { this.varBitFields = bitFieldSet(this.varBitFields, 13, 0x1, v ? 1 : 0); }
    get dllExport(): boolean { return bitFieldGet(this.varBitFields, 14, 0x1) !== 0; }         /// __declspec(dllexport)
    set dllExport(v: boolean) { this.varBitFields = bitFieldSet(this.varBitFields, 14, 0x1, v ? 1 : 0); }
    get systemInferred(): boolean { return bitFieldGet(this.varBitFields, 15, 0x1) !== 0; }    /// @system was inferred from initializer
    set systemInferred(v: boolean) { this.varBitFields = bitFieldSet(this.varBitFields, 15, 0x1, v ? 1 : 0); }

    canassign: number = 0;                  // byte — it can be assigned to
    // declaration.d:488 `ubyte isdataseg;` — private cache for isDataseg (0 unset, 1 true, 2 false).
    // Name carried verbatim (01 §2): TS member names are case-sensitive, so the field `isdataseg`
    // and the method `isDataseg()` (declaration.d:588) are distinct members and do NOT collide.
    isdataseg: number = 0;                  // ubyte

    // declaration.d:490 — `this(Loc loc, Type type, Identifier ident, Initializer _init,
    //   STC storage_class = STC.none)` with `in { assert(ident); }` (04 §7: leading assert).
    constructor(loc: Loc, type: Type | null, ident: Identifier, _init: Initializer | null,
                storage_class: STC = STC.none) {
        //printf("VarDeclaration('%s')\n", ident.toChars());
        assert(ident !== null);           // declaration.d:493 — `in` contract (06 §2.7 expansion)
        super(DSYM.varDeclaration, loc, ident);
        // dropped: `debug { if (!type && !_init) { … } }` (declaration.d:499-506) — non-debug build
        //   (_config.md §3); the guarded body is entirely commented out upstream.
        // declaration.d:508 `assert(type || _init)` — both operands are nullable class references,
        // so the `||` is expanded per 06 §2.7 (a non-null reference is D-truthy regardless of state).
        assert(type !== null || _init !== null);
        this.type = type;
        this._init = _init;
        this.ctfeAdrOnStack = VarDeclaration.AdrOnStackNone;
        this.storage_class = storage_class;
    }

    // declaration.d:515 — `new VarDeclaration(loc, type, ident, _init, cast(STC) storage_class)`.
    static override create(loc: Loc, type: Type | null, ident: Identifier, _init: Initializer | null,
                           storage_class: StorageClass = STC.none): VarDeclaration {
        // `cast(STC) storage_class` — D widens the `StorageClass` (ulong) parameter back to the
        // STC flag enum; the TS brand re-cast is the same no-op narrowing of the bigint domain.
        return new VarDeclaration(loc, type, ident, _init, storage_class as STC);
    }

    // declaration.d:520 — deep parse-time clone: copy `type`/`_init` if present, carry the comment.
    override syntaxCopy(s: Dsymbol | null): VarDeclaration {
        //printf("VarDeclaration::syntaxCopy(%s)\n", toChars());
        assert(s === null);
        const v = new VarDeclaration(this.loc, this.type !== null ? this.type.syntaxCopy() : null,
            this.ident!, this._init !== null ? syntaxCopyInitializer(this._init) : null, this.storage_class);
        v.addComment(this.comment());
        return v;
    }

    override kind(): DString { return ds("variable"); }

    // declaration.d:534 — a non-static field walks up `parent` to its enclosing aggregate. The
    // storage classes that make the var module/CTFE/template scoped exclude it from being a member.
    override isThis(): AggregateDeclaration | null {
        if (this.storage_class & (STC.static_ | STC.extern_ | STC.manifest | STC.templateparameter | STC.gshared | STC.ctfe))
            return null;

        /* The casting is necessary because `s = s.parent` is otherwise rejected
         */
        for (let s: Dsymbol | null = this; s !== null; s = s.parent) {
            const ad = s.isMember();
            if (ad !== null)
                return ad;
            if (s.parent === null || s.parent.isTemplateMixin() === null)
                break;
        }

        return null;
    }

    override needThis(): boolean {
        //printf("VarDeclaration::needThis(%s, x%x)\n", toChars(), storage_class);
        return this.isField();
    }

    override isExport(): boolean {
        return this.visibility.kind === Visibility.Kind.export_ || this.dllExport;
    }

    override isImportedSymbol(): boolean {
        /* If global variable has `export` and `extern` then it is imported
         *   export int sym1;            // definition:  exported
         *   export extern int sym2;     // declaration: imported
         *   export extern int sym3 = 0; // error, extern cannot have initializer
         */
        const result =
            this.dllImport ||
            this.visibility.kind === Visibility.Kind.export_ &&
            (this.storage_class & STC.extern_) !== 0n &&
            ((this.storage_class & STC.static_) !== 0n || this.parent!.isModule() !== null);
        //printf("isImportedSymbol() %s %d\n", toChars(), result);
        return result;
    }

    isCtorinit(): boolean { return this.setInCtorOnly; }

    /*******************************
     * declaration.d:588 — does symbol go into data segment? Includes extern variables.
     * Result is cached in `isdataseg` (0 unset, 1 true, 2 false).
     */
    override isDataseg(): boolean {
        // dropped: version (none) printf block (declaration.d:590-596) — `none` is OFF by definition.

        if (this.isdataseg === 0) { // the value is not cached
            this.isdataseg = 2; // The Variables does not go into the datasegment

            if (!this.canTakeAddressOf() || (this.storage_class & STC.exptemp)) {
                return false;
            }

            const parent = this.toParent();
            if (parent === null && !(this.storage_class & STC.static_)) {
                error(this.loc, ds("%s `%s` forward referenced"), this.kind(), this.toPrettyChars());
                this.type = Type.terror;
            } else if (this.storage_class & (STC.static_ | STC.extern_ | STC.gshared) ||
                // D short-circuits: when the storage-class test above is false, `parent` is non-null
                // (the `!parent` arm was taken otherwise), so `parent!` faults exactly where D would.
                parent!.isModule() !== null || parent!.isTemplateInstance() !== null ||
                parent!.isNspace() !== null) {
                assert(!this.isParameter() && !this.isResult());
                this.isdataseg = 1; // It is in the DataSegment
            }
        }

        return (this.isdataseg === 1);
    }

    /************************************
     * declaration.d:626 — does symbol go into thread local storage?
     */
    override isThreadlocal(): boolean {
        //printf("VarDeclaration::isThreadlocal(%p, '%s')\n", this, toChars());
        /* Data defaults to being thread-local. It is not thread-local
         * if it is immutable, const or shared.
         */
        const i = this.isDataseg() &&
            !(this.storage_class & (STC.immutable_ | STC.const_ | STC.shared_ | STC.gshared));
        //printf("\treturn %d\n", i);
        return i;
    }

    /********************************************
     * Can variable be read and written by CTFE?
     */
    isCTFE(): boolean {
        return (this.storage_class & STC.ctfe) !== 0n; // || !isDataseg();
    }

    /*************************************
     * Return true if we can take the address of this variable.
     */
    canTakeAddressOf(): boolean {
        return !(this.storage_class & STC.manifest);
    }

    /******************************************
     * Return true if variable needs to call the destructor.
     */
    needsScopeDtor(): boolean {
        //printf("VarDeclaration::needsScopeDtor() %s %d\n", toChars(), edtor && !(storage_class & STC.nodtor));
        return this.edtor !== null && !(this.storage_class & STC.nodtor);
    }

    override accept(v: Visitor): void { v.visitVarDeclaration(this); }
}

/*******************************************************
 * declaration.d:671 — `extern (C++) class BitFieldDeclaration : VarDeclaration`.
 * C11 6.7.2.1-4 bit fields
 */
export class BitFieldDeclaration extends VarDeclaration {
    width: Expression | null = null;

    fieldWidth: number = 0;   // uint
    bitOffset: number = 0;    // uint

    constructor(loc: Loc, type: Type | null, ident: Identifier, width: Expression,
                _init: Initializer | null = null) {
        super(loc, type, ident, _init);
        this.dsym = DSYM.bitFieldDeclaration; // declaration.d:681 — retag after the VarDeclaration ctor
        this.width = width;
        this.storage_class = (this.storage_class | STC.field) as STC; // branded STC: re-cast after `|`
    }

    // declaration.d:686 — deep parse-time clone: re-construct from copies of `type`/`width`/`_init`.
    override syntaxCopy(s: Dsymbol | null): BitFieldDeclaration {
        //printf("BitFieldDeclaration::syntaxCopy(%s)\n", toChars());
        assert(s === null);
        const bf = new BitFieldDeclaration(this.loc, this.type !== null ? this.type.syntaxCopy() : null,
            this.ident!, this.width!.syntaxCopy(),
            this._init !== null ? syntaxCopyInitializer(this._init) : null);
        bf.addComment(this.comment());
        return bf;
    }

    override accept(v: Visitor): void { v.visitBitFieldDeclaration(this); }
}

/***********************************************************
 * declaration.d:704 — `extern (C++) final class SymbolDeclaration : Declaration`.
 * This is a shell around a back end symbol.
 *
 * FIELD-SHADOWING RENAME: D declares `AggregateDeclaration dsym;` here (declaration.d:706), which
 * SHADOWS `Dsymbol.dsym` (the `DSYM` RTTI tag, dsymbol.d:402) — two distinct storage slots in D.
 * 02 §11.5's canonical remedy (keep the shadowing, use an audited upcast cascade at USE sites —
 * aggregate.ts:161, dmodule.ts:172) does NOT apply here: those pairs shadow a field nothing
 * dispatches on, whereas one property slot shared with the RTTI tag would be overwritten at
 * construction time, breaking `Dsymbol.isSymbolDeclaration()` and every other `dsym`-keyed query
 * (dsymbol.d:1084). Choosing a different representation for a public D field is a model decision no
 * amount of further porting resolves by itself, so it is a §2 blocker, not a §2.5 wall. The
 * aggregate slot is named `dsymAgg` and `dsym` keeps the tag; no TS consumer reads either spelling
 * today (the in-scope D users of the class — dinterpret.d:2183, dfa/fast/expression.d:736,
 * expressionsem.d:16825 — all go through `isSymbolDeclaration()` and none read the aggregate
 * field), so the port compiles either way, which is exactly why the marker below exists: a future
 * porter writing `sd.dsym` would silently bind the inherited numeric tag instead of erroring.
 */
export class SymbolDeclaration extends Declaration {
    // DJS-ESCALATE: `AggregateDeclaration dsym` shadows the `DSYM dsym` RTTI tag  (dmd/declaration.d:706)
    // No throw is emitted with this marker: the site is a FIELD declaration, and the only statement
    // position available is the constructor — where 11 §2 forbids a throw ("it falsifies verified
    // inherited behavior"). The marker + the escalation record carry the halt instead.
    dsymAgg: AggregateDeclaration;   // D field `dsym` (see the shadowing note above)

    constructor(loc: Loc, dsym: AggregateDeclaration) {
        super(DSYM.symbolDeclaration, loc, dsym.ident);
        this.dsymAgg = dsym;
        this.storage_class = (this.storage_class | STC.const_) as STC; // branded STC: re-cast after `|`
    }

    override accept(v: Visitor): void { v.visitSymbolDeclaration(this); }
}

/***********************************************************
 * declaration.d:723 — `private Identifier getTypeInfoIdent(Type t)`.
 *
 * The mangled `_D<len>TypeInfo_<deco>6__initZ` identifier of the TypeInfo symbol for `t`.
 * D module-private and it stays module-local here: the sole caller is `TypeInfoDeclaration`'s
 * constructor below, reaching it by UFCS (`tinfo.getTypeInfoIdent()`, declaration.d:778).
 * Cost: one mangling pass into a fresh OutBuffer + one idPool intern.
 */
function getTypeInfoIdent(t: Type): Identifier {
    // _init_10TypeInfo_%s
    const buf = new OutBuffer();
    buf.reserve(32);
    // D: `import dmd.mangle;` + `mangleToBuffer(t, buf);` (declaration.d:725/:731). The callee is
    // reached through the deferred edge declared at the top of this module; the empty test is the
    // load-order contract, not a D branch, so it raises instead of taking a fallback.
    if (mangleToBufferDeferred === undefined)
        throw new Error("declaration.getTypeInfoIdent: ./mangle/index.js is absent from this module graph");
    mangleToBufferDeferred(t, buf);

    const slice = buf.opSliceAll(); // `buf[]` — a non-owning VIEW (08 §13a.2), never `extract*`

    // dropped: `char[128] namebuf;` and the `Mem.check(malloc(namelen))` / `free(name)` fallback
    //   (declaration.d:736, :756, :767-768) — manual buffer management, erased under JS GC
    //   (03 §8, 08 §13). `namebuf.length` survived only as the test choosing WHICH buffer to use.

    let name: DString;
    let length: number;

    // LDC: hash long symbol names
    // resolved: `IN_LLVM &&` -> true (globals.d:34 `enum IN_LLVM = true`, _config.md §1).
    // Integral truthiness of `global.params.hashThreshold` made explicit (09 §9).
    if (global.params.hashThreshold !== 0 && slice.length > global.params.hashThreshold) {
        // `std.digest.md` (`md5Of` / `toHexString`) is PHOBOS: it has no D owner in
        // translation-order.md, so no future porting wave sweeps it — by 11 §2.5's one-line
        // decision test that makes it a §2 blocker (a hand-written-runtime model choice, 08),
        // not a §2.5 wall. Reachable only with `-hash-threshold=N` (globals.ts default 0 keeps
        // this arm dead).
        // DJS-ESCALATE: std.digest.md md5Of/toHexString has no runtime shim  (dmd/declaration.d:743)
        throw new Error("DJS-ESCALATE: not translated — see escalation report");
    } else {
        // else path is DMD original:

        // resolved: `size_t.sizeof` -> 8 (fixed 64-bit target, 09 §1.4).
        const namelen = 19 + 8 * 3 + slice.length + 1;
        // `snprintf(name, namelen, "_D%lluTypeInfo_%.*s6__initZ", cast(ulong)(9 + slice.length),
        //   cast(int) slice.length, slice.ptr)` — the printf subset is owned by `dmdformat` (10 §3.5);
        //   `%llu` takes a bigint, `%.*s` takes (precision, bytes) left-to-right.
        name = dmdformat(ds("_D%lluTypeInfo_%.*s6__initZ"),
            [BigInt(9 + slice.length), slice.length, slice]);
        length = name.length;
        //printf("%p %s, deco = %s, name = %s\n", this, toChars(), deco, name);
        assert(0 < length && length < namelen); // don't overflow the buffer
    }

    const id = Identifier.idPool(dsSlice(name, 0, length));

    return id;
}

/***********************************************************
 * declaration.d:772 — `extern (C++) class TypeInfoDeclaration : VarDeclaration`.
 * Base of the compiler-generated TypeInfo declarations.
 */
// @ts-expect-error D non-virtual static factory: TypeInfoDeclaration.create(Type) differs from VarDeclaration.create (see AliasDeclaration).
export class TypeInfoDeclaration extends VarDeclaration {
    tinfo: Type;

    constructor(tinfo: Type) {
        super(Loc.initial, Type.dtypeinfo.type, getTypeInfoIdent(tinfo), null);
        this.dsym = DSYM.typeInfoDeclaration;
        this.tinfo = tinfo;
        this.storage_class = (STC.static_ | STC.gshared) as STC;
        this.visibility = new Visibility(Visibility.Kind.public_);
        this._linkage = LINK.c;
        // `target` is read through the registration slot (see the `dmd.target` block under the imports).
        this.alignment.set(targetAt("TypeInfoDeclaration", "784").ptrsize);
    }

    static override create(tinfo: Type): TypeInfoDeclaration {
        return new TypeInfoDeclaration(tinfo);
    }

    // declaration.d:792 — `assert(0); // should never be produced by syntax`.
    override syntaxCopy(_s: Dsymbol | null): TypeInfoDeclaration {
        return assertUnreachable();
    }

    override accept(v: Visitor): void { v.visitTypeInfoDeclaration(this); }
}

/***********************************************************
 * declaration.d:805
 */
export class TypeInfoStructDeclaration extends TypeInfoDeclaration {
    constructor(tinfo: Type) {
        super(tinfo);
        // probe: Type.typeinfostruct is declared non-null but unset until sema; D tests `if (!Type.typeinfostruct)` (02 §11.4)
        if (!(Type as { typeinfostruct?: unknown }).typeinfostruct) {
            ObjectNotFound(this.loc, Id.TypeInfo_Struct!);
        }
        this.type = Type.typeinfostruct.type;
    }

    static override create(tinfo: Type): TypeInfoStructDeclaration {
        return new TypeInfoStructDeclaration(tinfo);
    }

    override accept(v: Visitor): void { v.visitTypeInfoStructDeclaration(this); }
}

/***********************************************************
 * declaration.d:830
 */
export class TypeInfoClassDeclaration extends TypeInfoDeclaration {
    constructor(tinfo: Type) {
        super(tinfo);
        // probe: Type.typeinfoclass is declared non-null but unset until sema; D tests `if (!Type.typeinfoclass)` (02 §11.4)
        if (!(Type as { typeinfoclass?: unknown }).typeinfoclass) {
            ObjectNotFound(this.loc, Id.TypeInfo_Class!);
        }
        this.type = Type.typeinfoclass.type;
    }

    static override create(tinfo: Type): TypeInfoClassDeclaration {
        return new TypeInfoClassDeclaration(tinfo);
    }

    override accept(v: Visitor): void { v.visitTypeInfoClassDeclaration(this); }
}

/***********************************************************
 * declaration.d:855
 */
export class TypeInfoInterfaceDeclaration extends TypeInfoDeclaration {
    constructor(tinfo: Type) {
        super(tinfo);
        // probe: Type.typeinfointerface is declared non-null but unset until sema; D tests `if (!Type.typeinfointerface)` (02 §11.4)
        if (!(Type as { typeinfointerface?: unknown }).typeinfointerface) {
            ObjectNotFound(this.loc, Id.TypeInfo_Interface!);
        }
        this.type = Type.typeinfointerface.type;
    }

    static override create(tinfo: Type): TypeInfoInterfaceDeclaration {
        return new TypeInfoInterfaceDeclaration(tinfo);
    }

    override accept(v: Visitor): void { v.visitTypeInfoInterfaceDeclaration(this); }
}

/***********************************************************
 * declaration.d:880
 */
export class TypeInfoPointerDeclaration extends TypeInfoDeclaration {
    constructor(tinfo: Type) {
        super(tinfo);
        // probe: Type.typeinfopointer is declared non-null but unset until sema; D tests `if (!Type.typeinfopointer)` (02 §11.4)
        if (!(Type as { typeinfopointer?: unknown }).typeinfopointer) {
            ObjectNotFound(this.loc, Id.TypeInfo_Pointer!);
        }
        this.type = Type.typeinfopointer.type;
    }

    static override create(tinfo: Type): TypeInfoPointerDeclaration {
        return new TypeInfoPointerDeclaration(tinfo);
    }

    override accept(v: Visitor): void { v.visitTypeInfoPointerDeclaration(this); }
}

/***********************************************************
 * declaration.d:905
 */
export class TypeInfoArrayDeclaration extends TypeInfoDeclaration {
    constructor(tinfo: Type) {
        super(tinfo);
        // probe: Type.typeinfoarray is declared non-null but unset until sema; D tests `if (!Type.typeinfoarray)` (02 §11.4)
        if (!(Type as { typeinfoarray?: unknown }).typeinfoarray) {
            ObjectNotFound(this.loc, Id.TypeInfo_Array!);
        }
        this.type = Type.typeinfoarray.type;
    }

    static override create(tinfo: Type): TypeInfoArrayDeclaration {
        return new TypeInfoArrayDeclaration(tinfo);
    }

    override accept(v: Visitor): void { v.visitTypeInfoArrayDeclaration(this); }
}

/***********************************************************
 * declaration.d:930
 */
export class TypeInfoStaticArrayDeclaration extends TypeInfoDeclaration {
    constructor(tinfo: Type) {
        super(tinfo);
        // probe: Type.typeinfostaticarray is declared non-null but unset until sema; D tests `if (!Type.typeinfostaticarray)` (02 §11.4)
        if (!(Type as { typeinfostaticarray?: unknown }).typeinfostaticarray) {
            ObjectNotFound(this.loc, Id.TypeInfo_StaticArray!);
        }
        this.type = Type.typeinfostaticarray.type;
    }

    static override create(tinfo: Type): TypeInfoStaticArrayDeclaration {
        return new TypeInfoStaticArrayDeclaration(tinfo);
    }

    override accept(v: Visitor): void { v.visitTypeInfoStaticArrayDeclaration(this); }
}

/***********************************************************
 * declaration.d:955
 */
export class TypeInfoAssociativeArrayDeclaration extends TypeInfoDeclaration {
    entry: Type | null = null;             // type of TypeInfo_AssociativeArray.Entry!(t.index, t.next)
    xopEqual: Declaration | null = null;   // implementation of TypeInfo_AssociativeArray.equals
    xtoHash: Declaration | null = null;    // implementation of TypeInfo_AssociativeArray.getHash

    constructor(tinfo: Type) {
        super(tinfo);
        // probe: Type.typeinfoassociativearray is declared non-null but unset until sema; D tests `if (!Type.typeinfoassociativearray)` (02 §11.4)
        if (!(Type as { typeinfoassociativearray?: unknown }).typeinfoassociativearray) {
            ObjectNotFound(this.loc, Id.TypeInfo_AssociativeArray!);
        }
        this.type = Type.typeinfoassociativearray.type;
    }

    static override create(tinfo: Type): TypeInfoAssociativeArrayDeclaration {
        return new TypeInfoAssociativeArrayDeclaration(tinfo);
    }

    override accept(v: Visitor): void { v.visitTypeInfoAssociativeArrayDeclaration(this); }
}

/***********************************************************
 * declaration.d:984
 */
export class TypeInfoEnumDeclaration extends TypeInfoDeclaration {
    constructor(tinfo: Type) {
        super(tinfo);
        // probe: Type.typeinfoenum is declared non-null but unset until sema; D tests `if (!Type.typeinfoenum)` (02 §11.4)
        if (!(Type as { typeinfoenum?: unknown }).typeinfoenum) {
            ObjectNotFound(this.loc, Id.TypeInfo_Enum!);
        }
        this.type = Type.typeinfoenum.type;
    }

    static override create(tinfo: Type): TypeInfoEnumDeclaration {
        return new TypeInfoEnumDeclaration(tinfo);
    }

    override accept(v: Visitor): void { v.visitTypeInfoEnumDeclaration(this); }
}

/***********************************************************
 * declaration.d:1009
 */
export class TypeInfoFunctionDeclaration extends TypeInfoDeclaration {
    constructor(tinfo: Type) {
        super(tinfo);
        // probe: Type.typeinfofunction is declared non-null but unset until sema; D tests `if (!Type.typeinfofunction)` (02 §11.4)
        if (!(Type as { typeinfofunction?: unknown }).typeinfofunction) {
            ObjectNotFound(this.loc, Id.TypeInfo_Function!);
        }
        this.type = Type.typeinfofunction.type;
    }

    static override create(tinfo: Type): TypeInfoFunctionDeclaration {
        return new TypeInfoFunctionDeclaration(tinfo);
    }

    override accept(v: Visitor): void { v.visitTypeInfoFunctionDeclaration(this); }
}

/***********************************************************
 * declaration.d:1034
 */
export class TypeInfoDelegateDeclaration extends TypeInfoDeclaration {
    constructor(tinfo: Type) {
        super(tinfo);
        // probe: Type.typeinfodelegate is declared non-null but unset until sema; D tests `if (!Type.typeinfodelegate)` (02 §11.4)
        if (!(Type as { typeinfodelegate?: unknown }).typeinfodelegate) {
            ObjectNotFound(this.loc, Id.TypeInfo_Delegate!);
        }
        this.type = Type.typeinfodelegate.type;
    }

    static override create(tinfo: Type): TypeInfoDelegateDeclaration {
        return new TypeInfoDelegateDeclaration(tinfo);
    }

    override accept(v: Visitor): void { v.visitTypeInfoDelegateDeclaration(this); }
}

/***********************************************************
 * declaration.d:1059
 */
export class TypeInfoTupleDeclaration extends TypeInfoDeclaration {
    constructor(tinfo: Type) {
        super(tinfo);
        // probe: Type.typeinfotypelist is declared non-null but unset until sema; D tests `if (!Type.typeinfotypelist)` (02 §11.4)
        if (!(Type as { typeinfotypelist?: unknown }).typeinfotypelist) {
            ObjectNotFound(this.loc, Id.TypeInfo_Tuple!);
        }
        this.type = Type.typeinfotypelist.type;
    }

    static override create(tinfo: Type): TypeInfoTupleDeclaration {
        return new TypeInfoTupleDeclaration(tinfo);
    }

    override accept(v: Visitor): void { v.visitTypeInfoTupleDeclaration(this); }
}

/***********************************************************
 * declaration.d:1084
 */
export class TypeInfoConstDeclaration extends TypeInfoDeclaration {
    constructor(tinfo: Type) {
        super(tinfo);
        // probe: Type.typeinfoconst is declared non-null but unset until sema; D tests `if (!Type.typeinfoconst)` (02 §11.4)
        if (!(Type as { typeinfoconst?: unknown }).typeinfoconst) {
            ObjectNotFound(this.loc, Id.TypeInfo_Const!);
        }
        this.type = Type.typeinfoconst.type;
    }

    static override create(tinfo: Type): TypeInfoConstDeclaration {
        return new TypeInfoConstDeclaration(tinfo);
    }

    override accept(v: Visitor): void { v.visitTypeInfoConstDeclaration(this); }
}

/***********************************************************
 * declaration.d:1109
 */
export class TypeInfoInvariantDeclaration extends TypeInfoDeclaration {
    constructor(tinfo: Type) {
        super(tinfo);
        // probe: Type.typeinfoinvariant is declared non-null but unset until sema; D tests `if (!Type.typeinfoinvariant)` (02 §11.4)
        if (!(Type as { typeinfoinvariant?: unknown }).typeinfoinvariant) {
            ObjectNotFound(this.loc, Id.TypeInfo_Invariant!);
        }
        this.type = Type.typeinfoinvariant.type;
    }

    static override create(tinfo: Type): TypeInfoInvariantDeclaration {
        return new TypeInfoInvariantDeclaration(tinfo);
    }

    override accept(v: Visitor): void { v.visitTypeInfoInvariantDeclaration(this); }
}

/***********************************************************
 * declaration.d:1134
 */
export class TypeInfoSharedDeclaration extends TypeInfoDeclaration {
    constructor(tinfo: Type) {
        super(tinfo);
        // probe: Type.typeinfoshared is declared non-null but unset until sema; D tests `if (!Type.typeinfoshared)` (02 §11.4)
        if (!(Type as { typeinfoshared?: unknown }).typeinfoshared) {
            ObjectNotFound(this.loc, Id.TypeInfo_Shared!);
        }
        this.type = Type.typeinfoshared.type;
    }

    static override create(tinfo: Type): TypeInfoSharedDeclaration {
        return new TypeInfoSharedDeclaration(tinfo);
    }

    override accept(v: Visitor): void { v.visitTypeInfoSharedDeclaration(this); }
}

/***********************************************************
 * declaration.d:1159
 */
export class TypeInfoWildDeclaration extends TypeInfoDeclaration {
    constructor(tinfo: Type) {
        super(tinfo);
        // probe: Type.typeinfowild is declared non-null but unset until sema; D tests `if (!Type.typeinfowild)` (02 §11.4)
        if (!(Type as { typeinfowild?: unknown }).typeinfowild) {
            ObjectNotFound(this.loc, Id.TypeInfo_Wild!);
        }
        this.type = Type.typeinfowild.type;
    }

    static override create(tinfo: Type): TypeInfoWildDeclaration {
        return new TypeInfoWildDeclaration(tinfo);
    }

    override accept(v: Visitor): void { v.visitTypeInfoWildDeclaration(this); }
}

/***********************************************************
 * declaration.d:1184
 */
export class TypeInfoVectorDeclaration extends TypeInfoDeclaration {
    constructor(tinfo: Type) {
        super(tinfo);
        // probe: Type.typeinfovector is declared non-null but unset until sema; D tests `if (!Type.typeinfovector)` (02 §11.4)
        if (!(Type as { typeinfovector?: unknown }).typeinfovector) {
            ObjectNotFound(this.loc, Id.TypeInfo_Vector!);
        }
        this.type = Type.typeinfovector.type;
    }

    static override create(tinfo: Type): TypeInfoVectorDeclaration {
        return new TypeInfoVectorDeclaration(tinfo);
    }

    override accept(v: Visitor): void { v.visitTypeInfoVectorDeclaration(this); }
}

/***********************************************************
 * declaration.d:1210 — `extern (C++) final class ThisDeclaration : VarDeclaration`.
 * For the "this" parameter to member functions.
 */
export class ThisDeclaration extends VarDeclaration {
    constructor(loc: Loc, t: Type) {
        super(loc, t, Id.This!, null);
        this.dsym = DSYM.thisDeclaration;  // declaration.d:1215 — retag after the VarDeclaration ctor
        this.storage_class = (this.storage_class | STC.nodtor) as STC; // branded STC: re-cast after `|`
    }

    // declaration.d:1219 — `assert(0); // should never be produced by syntax`.
    override syntaxCopy(_s: Dsymbol | null): ThisDeclaration {
        return assertUnreachable();
    }

    override accept(v: Visitor): void { v.visitThisDeclaration(this); }
}
