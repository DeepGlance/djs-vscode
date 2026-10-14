// Ported from dmd/dsymbol.d (module dmd.dsymbol) — LDC 1.43.0-beta1 / DMD 2.113.
//
// WHOLE-FILE faithful structural translation (wave W2). Every top-level D declaration of
// dsymbol.d is present here in D SOURCE ORDER:
//   foreachDsymbol(int dg) :68 · foreachDsymbol(void dg) :94 · addComment :109 ·
//   AddCommentVisitor :115 · Visibility :165 · PASS :231 · SearchOptFlags :246 · SearchOpt :247 ·
//   FieldState :268 · DsymbolAttributes :291 · DSYM :301 · Dsymbol :373 (+ nested BitFields :390) ·
//   ScopeDsymbol :1122 · WithScopeSymbol :1322 · ArrayScopeSymbol :1341 · OverloadSet :1377 ·
//   ForwardingScopeDsymbol :1412 · ExpressionDsymbol :1493 · AliasAssign :1509 ·
//   DsymbolTable :1547 · CAsmDeclaration :1620.
//
// COMPILE-TIME RESOLUTION (07 / _config.md):
//   version (IN_LLVM) -> ON. dsymbol.d:50-55 declares the two `extern (C++)` codegen hooks
//     `newIrDsymbol`/`deleteIrDsymbol`; they live on LDC's C++ side and there is NO codegen in this
//     port, so both declarations and their three call sites (:411, :423, :435) plus the
//     `version (IN_LLVM) ~this()` (:441-446) are DROPPED. The two AST-bookkeeping FIELDS the LDC
//     frontend sets (`ir`, `llvmInternal`, :379-380) are KEPT; the `else` branch's `csym` (:384) is
//     dropped as the not-taken leg.
//   version (none) at :1245-1250 -> OFF (built-in): the multiplyDefined printf debug block is dropped.
//   static if (0) at :1257-1275 -> false: the OverloadSet dump inside multiplyDefined is dropped.
//   mixin(generateBitFields!(BitFields, ubyte)) at :401 -> resolved to the flattened plain fields
//     (11 §3.6): nothing in the frontend reads the packed byte or its `.sizeof`, only the named
//     members, so the packing is an unobservable implementation detail.
//
// `dmd.hdrgen` THROUGH A REGISTRATION SLOT (01 §4.4, third form): `Dsymbol.toChars()` (:453) imports
//   `dmd.hdrgen : toChars` function-locally (:455). hdrgen.ts registers its `dsymbolToChars`
//   (hdrgen.d:231) into the slot declared under the imports; see the ORDER CONTRACT there.
//
// SHADOW-SPLIT (02 §11.5b registry): `AliasAssign.ident` (:1511) redeclares `Dsymbol.ident` and the ctor gives
//   the two D slots DIFFERENT values, so the derived slot is the renamed field `identAssign`.
//
// EXPORT SURFACE — three members the rung-era tree carried on these classes are NOT members of
// dsymbol.d and are therefore absent here. Each is a D FREE function (or, for `comment`, not a D
// declaration at all), so re-adding them would re-commit the 04 §6 anti-pattern. Dependents this
// breaks, with the D-faithful replacement each should adopt in its own file:
//   `Dsymbol.addObjcSymbols`  -> free fn `addObjcSymbols(Dsymbol, …)` (dsymbolsem.d:138);
//                                breaks attrib.ts:97, dclass.ts:349 (both `override` declarations).
//   `Dsymbol.newScope`        -> free fn `newScope(AggregateDeclaration, Scope*)` (dsymbolsem.d:90)
//                                / `newScope(Dsymbol, Scope*)` (dsymbolsem.d:8980);
//                                breaks dclass.ts:266, dclass.ts:399, dsymbolsem.ts:1463.
//   `Dsymbol.comment_set`     -> dsymbol.d has NO comment setter; D writes `x.addComment(comment)`
//                                (aliasthis.d:44, dimport.d:98); breaks aliasthis.ts:45, dimport.ts:88.

import type { DString } from "../dstring.js";
import { ds, dsToJs, cstr, dsEquals } from "../dstring.js";
import { dmdformat } from "./root/dmdformat.js"; // value: FieldState.print / syntaxCopy printf (10 §3.5)
import { Lexer } from "./lexer.js"; // value: AddCommentVisitor concatenates via Lexer.combineComments
import { assert, assertUnreachable } from "../assert.js";
import { OutBuffer } from "./common/outbuffer.js"; // value: toPrettyChars/prettyFormatHelper buffers
import { FileType, STC } from "./astenums.js"; // value: isCsymbol vs FileType.c; STC.local test
import { EXP } from "./tokens.js"; // value: ArrayScopeSymbol.fromExpression asserts exp.op

// --- cross-core AST types: import type to break the 76-module load cycle (01 §4.2) ---
// ASTNode is a VALUE import: `class Dsymbol extends ASTNode` needs the runtime base. `extends`
// across a load cycle is verified safe (01 §4.1) — the base is read after all modules evaluate.
import { ASTNode } from "./ast_node.js";
// `Visitor` is a VALUE import: dsymbol.d:115's `AddCommentVisitor` is a real `: Visitor` subclass
// (13 §1 Idiom A), so the runtime base must be present. Verified safe: visitor/index.ts has exactly
// four VALUE imports (parsetime.js, ../../assert.js, ../rootobject.js, ../root/array.js) — every
// dtemplate.ts / expression.ts / mtype.ts edge it carries is `import type` and erases — so this edge
// pulls in no AST-SCC module and creates no load cycle back into dsymbol.js.
import { Visitor } from "./visitor/index.js";
import type { Identifier } from "./identifier.js";
import { DYNCAST } from "./rootobject.js";
import { RootObject } from "./rootobject.js"; // value import: DsymbolTable extends RootObject
import { Loc } from "./location.js"; // value: ctor default `this.loc = Loc.initial` (dsymbol.d:408)
import { error, errorSupplemental } from "./errors.js"; // value: ScopeDsymbol.multiplyDefined

import type { Scope } from "./dscope.js";
import type { Type } from "./mtype.js";
import type { TypeTuple } from "./mtype.js";
import type { Expression } from "./expression.js";
import type { WithStatement } from "./statement.js";
import type { LabelDsymbol } from "./statement.js";
import type { Package } from "./dmodule.js";
import type { Module } from "./dmodule.js";
import type { EnumMember } from "./denum.js";
import type { EnumDeclaration } from "./denum.js";
import type { TemplateDeclaration } from "./dtemplate.js";
import type { TemplateInstance } from "./dtemplate.js";
import type { TemplateMixin } from "./dtemplate.js";
import type { Nspace } from "./nspace.js";
import type { Import } from "./dimport.js";
import type { VersionSymbol } from "./dversion.js";
import type { DebugSymbol } from "./dversion.js";
import type { StaticAssert } from "./staticassert.js";

import type {
    Declaration,
    ThisDeclaration,
    BitFieldDeclaration,
    TypeInfoDeclaration,
    TupleDeclaration,
    AliasDeclaration,
    OverDeclaration,
    VarDeclaration,
    SymbolDeclaration,
} from "./declaration.js";

import type {
    FuncDeclaration,
    FuncAliasDeclaration,
    FuncLiteralDeclaration,
    CtorDeclaration,
    PostBlitDeclaration,
    DtorDeclaration,
    StaticCtorDeclaration,
    StaticDtorDeclaration,
    SharedStaticCtorDeclaration,
    SharedStaticDtorDeclaration,
    InvariantDeclaration,
    UnitTestDeclaration,
    NewDeclaration,
} from "./func.js";

import type { AggregateDeclaration } from "./aggregate.js";
import type { StructDeclaration, UnionDeclaration } from "./dstruct.js";
import type { ClassDeclaration, InterfaceDeclaration } from "./dclass.js";

import type {
    DeprecatedDeclaration,
    UserAttributeDeclaration,
    AttribDeclaration,
    ConditionalDeclaration,
    StaticForeachDeclaration,
    AlignDeclaration,
    AnonDeclaration,
    CPPNamespaceDeclaration,
    VisibilityDeclaration,
    MixinDeclaration,
    StaticIfDeclaration,
    StorageClassDeclaration,
    ForwardingAttribDeclaration,
} from "./attrib.js";

import type { Dsymbols } from "./arraytypes.js";

import { Array as DArray } from "./root/array.js";
import { AssocArray } from "./root/aav.js";
import { BitArray } from "./root/bitarray.js";

// ── `dmd.hdrgen : toChars` THROUGH A REGISTRATION SLOT (01 §4.4 registration-slot inversion) ──
// D imports it function-locally inside `Dsymbol.toChars` (dsymbol.d:455). A top-level value import of
// hdrgen.js from this module breaks the suite at collect (measured: 29 test files; an earlier tree
// died in 22 with `Class extends value undefined` at dtemplate.ts's `TemplateDeclaration extends
// ScopeDsymbol`), because entering hdrgen -> mtype -> … from here evaluates those modules before this
// module's classes exist. So the edge is inverted: the PROVIDER, hdrgen.ts, hands its `dsymbolToChars`
// (hdrgen.d:231) over from its own module body (`registerDsymbolToChars(dsymbolToChars);` at its
// end), and `Dsymbol.toChars` fails LOUDLY while the slot is empty, never with a fallback.
//
// ORDER CONTRACT: only an entry whose module graph contains hdrgen.js fills the slot. Measured: an
// entry through dsymbol.js alone does not load hdrgen.js, so there `Dsymbol.toChars` raises the
// load-order error, and so does everything that calls it (`toPrettyChars`, `toPrettyCharsHelper`,
// `ScopeDsymbol.multiplyDefined`, …). Entries through expression.js, mtype.js, declaration.js,
// dtemplate.js, func.js, dmodule.js, attrib.js, hdrgen.js and parse.js fill it (measured). A test
// suite whose static imports do not reach hdrgen.js must load `./parse.js` (10 §1.5) before its
// first `toChars`: first among its imports, or — to keep dsymbol.js as the entry under test, as
// dsymbol.test.ts does — by `await import("./parse.js")` in a `beforeAll`.
// The registrar is a hoisted function declaration and the slot is `var` with NO initializer, so a
// provider whose body runs before this module's body neither hits a TDZ nor has its registration
// reset.
var hdrgenToCharsSlot: ((d: Dsymbol) => DString) | undefined; // hdrgen.d:231 `toChars(const Dsymbol d)`

/// Registration point for the `dmd.hdrgen` edge described above: hdrgen.ts hands over
/// `dsymbolToChars` (hdrgen.d:231). Not a D symbol.
export function registerDsymbolToChars(fn: (d: Dsymbol) => DString): void {
    hdrgenToCharsSlot = fn;
}

// dropped: `version (IN_LLVM) { extern (C++) void* newIrDsymbol(); extern (C++) void
//          deleteIrDsymbol(void*); }` (dsymbol.d:50-55) — the LDC IrDsymbol allocator/deallocator
//          live in LDC's C++ codegen half. This port has no codegen, so neither the declarations
//          nor their call sites are emitted.

/***************************************
 * Calls dg(Dsymbol sym) for each Dsymbol.
 * If dg returns !=0, stops and returns that value else returns 0.
 *
 * dmd/dsymbol.d:68 — the `int delegate` member of the `foreachDsymbol` overload pair; the
 * `void delegate` member is `foreachDsymbolVoid` below (04 §1B: same arity, different delegate
 * type -> rename; this one keeps the bare name, it is the form dependents import).
 *
 * `dg` takes `Dsymbol | null` per the 02 §10.1 delegate UNION rule: D forwards the raw container
 * slot with no deref and no test (`Dsymbol s = (*symbols)[i]; const result = dg(s);`), and three
 * `int`-delegate bodies genuinely null-test it (dsymbolsem.d:7204/:7208/:7215). Bodies that DO
 * dereference unconditionally carry the `!` themselves — the fault site is the body, as in D.
 *
 * Params:
 *    symbols = Dsymbols
 *    dg = delegate to call for each Dsymbol
 * Returns:
 *    last value returned by dg()
 */
export function foreachDsymbol(symbols: Dsymbols | null, dg: (s: Dsymbol | null) => number): number {
    // `assert(dg)` (dsymbol.d:70) — a non-null delegate is guaranteed by the TS parameter type,
    // so the check has no runtime form here (boundary-validation.md: the type carries the invariant).
    if (symbols !== null) {
        /* Do not use foreach, as the size of the array may expand during iteration
         */
        for (let i = 0; i < symbols.length; ++i) {
            const s = symbols.opIndex(i);
            const result = dg(s);
            if (result !== 0) return result;
        }
    }
    return 0;
}

/***************************************
 * Calls dg(Dsymbol sym) for each Dsymbol.
 *
 * dmd/dsymbol.d:94 — the `void delegate` member of the overload pair (04 §1B rename).
 *
 * Unlike the `int` overload, EVERY `void`-delegate body bound to this function dereferences its
 * parameter unconditionally (enumsem.d:175, dsymbolsem.d:4788/:8854, templatesem.d:1838/:1879,
 * traits.d:1988, inline.d:2597) — none null-tests — so 02 §10.1 keeps the delegate parameter
 * non-null and the `!` sits here, at the site D would fault.
 *
 * Params:
 *    symbols = Dsymbols
 *    dg = delegate to call for each Dsymbol
 */
export function foreachDsymbolVoid(symbols: Dsymbols | null, dg: (s: Dsymbol) => void): void {
    // `assert(dg)` (dsymbol.d:96) — carried by the TS parameter type, as above.
    if (symbols !== null) {
        /* Do not use foreach, as the size of the array may expand during iteration
         */
        for (let i = 0; i < symbols.length; ++i) {
            const s = symbols.opIndex(i);
            dg(s!);
        }
    }
}

/**
 * dmd/dsymbol.d:109 — `private void addComment(Dsymbol d, const(char)* comment)`.
 *
 * D module-private and NOT exported: its only caller is `Dsymbol.addComment` below (the D
 * `.addComment(this, c)` at :870 names exactly this module-scope function, not the method).
 * `scope v = new ...` — the `scope` storage class is a lifetime hint with no value effect (03 §3.4).
 */
function addComment(d: Dsymbol, comment: DString | null): void {
    const v = new AddCommentVisitor(comment);
    d.accept(v);
}

/**
 * dmd/dsymbol.d:115 — `extern (C++) private class AddCommentVisitor : Visitor`.
 *
 * 13 §1 Idiom A: each `void visit(X)` overload becomes one named `visitX` method, and the dispatch
 * stays D's own double dispatch through `accept` — `Visitor`'s default forwards (parsetime.ts) route
 * StaticIfDeclaration -> visitConditionalDeclaration and every other AttribDeclaration subclass ->
 * visitAttribDeclaration -> visitDsymbol, exactly as D's overload resolution does.
 *
 * D module-private; emitted without `export` (01 §2.5).
 *
 * Each arm opens with `const comment = this.comment;` — a TS narrowing local only (the field is
 * `DString | null` and the closures passed to `foreachDsymbolVoid` capture it), with no D counterpart
 * and no effect: D reads the same field directly.
 */
// dropped: `alias visit = Visitor.visit;` (dsymbol.d:117) — TS has no overload hiding (13 §1).
class AddCommentVisitor extends Visitor {
    comment: DString | null;

    /// dmd/dsymbol.d:121
    constructor(comment: DString | null) {
        super();
        this.comment = comment;
    }

    /// dmd/dsymbol.d:126 — `override void visit(Dsymbol d)`.
    override visitDsymbol(d: Dsymbol): void {
        const comment = this.comment;
        // `if (!comment || !*comment) return;` — a null C string, or one whose first byte is the
        // terminating NUL (02 §11.2: `if (*p)` -> `p.length > 0 && p[0] !== 0`).
        if (comment === null || !(comment.length > 0 && comment[0] !== 0)) return;

        //printf("addComment '%s' to Dsymbol %p '%s'\n", comment, this, toChars());
        // `void* h = cast(void*)d;` — D keys the table on the symbol's POINTER. A TS object
        // reference IS that identity, so the Map is keyed by `d` (no `h` local is needed).
        const p = Dsymbol.commentHashTable.get(d);
        if (p === undefined) {
            Dsymbol.commentHashTable.set(d, comment);
            return;
        }
        // `if (strcmp(*p, comment) != 0)` — compare the LOGICAL C strings (bytes before the NUL).
        if (!dsEquals(cstr(p), cstr(comment))) {
            // Concatenate the two.
            // `*p = Lexer.combineComments((*p).toDString(), comment.toDString(), true)` — both
            // `const(char)*` operands become strlen-bounded slices first, i.e. `cstr()` (02 §11);
            // the result is written back through the AA slot, one re-set here.
            // combineComments returns null only when BOTH inputs are null; `p` and `comment` are
            // non-null on this path, so the result is non-null (`!`).
            Dsymbol.commentHashTable.set(d, Lexer.combineComments(cstr(p), cstr(comment), true)!);
        }
    }

    /// dmd/dsymbol.d:146 — `override void visit(AttribDeclaration atd)`.
    override visitAttribDeclaration(atd: AttribDeclaration): void {
        const comment = this.comment;
        // `if (comment && atd.decl)` — both are pointers; the test is non-null (06 §2.7). Note D
        // tests the comment POINTER only here, not its first byte.
        if (comment !== null && atd.decl !== null) {
            // UFCS: `atd.decl.foreachDsymbol(dg)` -> `foreachDsymbol(atd.decl, dg)` (04 §6); the
            // delegate returns void, so it resolves to the `void` overload (foreachDsymbolVoid).
            foreachDsymbolVoid(atd.decl, (s) => s.addComment(comment));
        }
    }

    /// dmd/dsymbol.d:153 — `override void visit(ConditionalDeclaration cd)`.
    override visitConditionalDeclaration(cd: ConditionalDeclaration): void {
        const comment = this.comment;
        if (comment !== null) {
            foreachDsymbolVoid(cd.decl, (s) => s.addComment(comment));
            foreachDsymbolVoid(cd.elsedecl, (s) => s.addComment(comment));
        }
    }

    /// dmd/dsymbol.d:161 — `override void visit(StaticForeachDeclaration sfd) {}` (deliberate no-op:
    /// a `static foreach` body is expanded later, so its members get no comment here).
    override visitStaticForeachDeclaration(_sfd: StaticForeachDeclaration): void {}
}

/***********************************************************
 * dmd/dsymbol.d:165 — `struct Visibility`: a VALUE struct (02 §2, 03 §2) carrying an access Kind
 * and, for `package(x)`, the Package it is scoped to.
 */
export class Visibility {
    kind: Visibility.Kind;
    pkg: Package | null;

    /**
     * dmd/dsymbol.d:182 — `extern(C++) this(Visibility.Kind kind, Package pkg = null)`.
     *
     * ONE constructor, two births (03 §6.4): `Visibility v;` (D default-init, used as a field
     * declaration at aggregate.d:144, attrib.d:315, declaration.d:70, dimport.d:31, denum.d:48,
     * dtemplate.d:260) takes each field's `.init` — a named enum inits to its FIRST member
     * (09 §1.0), i.e. `Kind.undefined`, and the class ref to null. `Visibility(k[, pkg])` runs
     * the value ctor.
     */
    constructor(kind?: Visibility.Kind, pkg: Package | null = null) {
        if (arguments.length === 0) {
            // default-init (`Visibility v;`): enum `.init` = first member; class ref `.init` = null.
            this.kind = Visibility.Kind.undefined;
            this.pkg = null;
        } else {
            // value path (`Visibility(kind, pkg)`).
            // `kind as Visibility.Kind` is the 03 §6.4 canonical shape for the value branch of a
            // dual-birth ctor (the optional param is `T | undefined` only on the default-init path).
            this.kind = kind as Visibility.Kind;
            this.pkg = pkg;
        }
    }

    /**
     * dmd/dsymbol.d:203 — `int opCmp(const Visibility other)`.
     *
     * Checks if `this` is less or more visible than `other`. Returns `< 0` when `this` is less
     * visible, `> 0` when more visible, `0` when at the same level. Note that `package` visibility
     * with different packages also returns `0`.
     *
     * Call sites rewrite `a < b` to `a.opCmp(b) < 0` etc. (05 §3).
     */
    opCmp(other: Visibility): number {
        return this.kind - other.kind;
    }

    /**
     * dmd/dsymbol.d:219 — `bool opEquals(ref const Visibility other)`.
     * Checks if `this` is an absolutely identical visibility attribute to `other`.
     * Call sites rewrite `a == b` to `a.opEquals(b)` (05 §2).
     */
    opEquals(other: Visibility): boolean {
        if (this.kind === other.kind) {
            // `pkg` is a class reference (Package): D `==` on class refs is identity here (05 §2).
            if (this.kind === Visibility.Kind.package_) return this.pkg === other.pkg;
            return true;
        }
        return false;
    }

    /// Value-struct copy (03 §2): `kind` primitive (value), `pkg` class ref (shared).
    copy(): Visibility {
        return new Visibility(this.kind, this.pkg);
    }
}

/**
 * dmd/dsymbol.d:168 — `enum Kind : ubyte`, a NAMED member-list enum declared INSIDE the struct.
 * A ubyte base is <= 32 bits, so the canonical form is a TS numeric `enum` (02 §4.2); TS cannot put
 * an `enum` in a class body, so it is declared in the namespace that merges with the class above —
 * which keeps `Visibility.Kind.public_` spelled exactly as D spells it at every call site, and keeps
 * the enum's TYPE identity (a bare `type Kind = number` would let any number flow into a `kind`).
 * (02 §4.1's hoist rule governs MANIFEST/anonymous aggregate-scoped enums, not this one.)
 */
export namespace Visibility {
    export enum Kind {
        undefined,
        none, // no access
        private_,
        package_,
        protected_,
        public_,
        export_,
    }
}

/// dmd/dsymbol.d:231 — `enum PASS : ubyte` (ubyte base, <= 32 bits -> TS numeric enum, 02 §4.2).
export enum PASS {
    initial,        // initial state
    semantic,       // semantic() started
    semanticdone,   // semantic() done
    semantic2,      // semantic2() started
    semantic2done,  // semantic2() done
    semantic3,      // semantic3() started
    semantic3done,  // semantic3() done
    inlinePragma,   // inline pragma(inline, true) functions started
    inlineAll,      // inline all functions started
    obj,            // toObjFile() run
}

// dmd/dsymbol.d:246 — `alias SearchOptFlags = uint;` (02 §5.1 type alias; uint -> number, 09 §1).
export type SearchOptFlags = number;

/// dmd/dsymbol.d:247 — `enum SearchOpt : SearchOptFlags`. uint base, <= 32 bits -> TS numeric enum.
export enum SearchOpt {
    all                  = 0x00, // search for all symbols
    ignorePrivateImports = 0x01, // don't search private imports
    ignoreErrors         = 0x02, // don't give error messages
    ignoreAmbiguous      = 0x04, // return NULL if ambiguous
    localsOnly           = 0x08, // only look at locals (don't search imports)
    importsOnly          = 0x10, // only look in imports
    unqualifiedModule    = 0x20, // the module scope search is unqualified, meaning don't search
                                 // imports in that scope, because qualified module searches search
                                 // their imports
    tagNameSpace         = 0x40, // search ImportC tag symbol table
    ignoreVisibility     = 0x80, // also find private and package protected symbols
}

/***********************************************************
 * dmd/dsymbol.d:268 — `struct FieldState`: Struct/Class/Union field state.
 * Used for transitory information when setting field offsets, such as bit fields.
 * A VALUE struct (02 §2, 03 §2).
 */
export class FieldState {
    offset = 0;        /// byte offset for next field

    fieldOffset = 0;   /// byte offset for the start of the bit field
    fieldSize = 0;     /// byte size of field
    fieldAlign = 0;    /// byte alignment of field
    bitOffset = 0;     /// bit offset for field

    inFlight = false;  /// bit field is in flight

    /**
     * dmd/dsymbol.d:279 — `void print() const`. Five C `printf`s to stdout; each becomes one
     * `dmdformat` + `process.stdout.write` (10 §3.5 / §4.4). `inFlight` is a `bool` widened to
     * `int` by C's default argument promotion before `%d` reads it.
     */
    print(): void {
        process.stdout.write(dsToJs(dmdformat("FieldState.offset      = %d bytes\n", [this.offset])));
        process.stdout.write(dsToJs(dmdformat("          .fieldOffset = %d bytes\n", [this.fieldOffset])));
        process.stdout.write(dsToJs(dmdformat("          .bitOffset   = %d bits\n", [this.bitOffset])));
        process.stdout.write(dsToJs(dmdformat("          .fieldSize   = %d bytes\n", [this.fieldSize])));
        process.stdout.write(dsToJs(dmdformat("          .inFlight    = %d\n", [this.inFlight ? 1 : 0])));
    }

    /// Value-struct copy (03 §2): every field is primitive -> value copy.
    copy(): FieldState {
        const c = new FieldState();
        c.offset = this.offset;
        c.fieldOffset = this.fieldOffset;
        c.fieldSize = this.fieldSize;
        c.fieldAlign = this.fieldAlign;
        c.bitOffset = this.bitOffset;
        c.inFlight = this.inFlight;
        return c;
    }
}

/***********************************************************
 * dmd/dsymbol.d:291 — `private struct DsymbolAttributes`.
 *
 * "99.9% of Dsymbols don't have attributes (at least in druntime and Phobos), so save memory by
 * grouping them into a separate struct."
 *
 * D module-private, so NOT exported (the D `private` on a top-level declaration is module scope, and
 * nothing outside dsymbol.d names this type); `Dsymbol.getAtts` (same module) reads and writes it, so
 * it is emitted without TS `private` on its members (10 §1.7 / 01 §2.5). Only ever reached through
 * `DsymbolAttributes* atts`, i.e. as a REFERENCE to the value (02 §10 case 2) — no `.copy()` is
 * emitted at those sites.
 */
class DsymbolAttributes {
    /// C++ namespace this symbol belongs to
    cppnamespace: CPPNamespaceDeclaration | null = null;
    /// customized deprecation message
    depdecl_: DeprecatedDeclaration | null = null;
    /// user defined attributes
    userAttribDecl: UserAttributeDeclaration | null = null;

    /// Value-struct copy (03 §2 emission checklist §6.3): three class refs -> shared.
    copy(): DsymbolAttributes {
        const c = new DsymbolAttributes();
        c.cppnamespace = this.cppnamespace;
        c.depdecl_ = this.depdecl_;
        c.userAttribDecl = this.userAttribDecl;
        return c;
    }
}

/// dmd/dsymbol.d:301 — `enum DSYM : ubyte`. The hand-rolled RTTI tag every Dsymbol carries.
export enum DSYM {
    none,
    dsymbol,
    linkDeclaration,
    cppMangleDeclaration,
    alignDeclaration,
    pragmaDeclaration,
    conditionalDeclaration,
    staticForeachDeclaration,
    userAttributeDeclaration,
    labelDsymbol,
    aliasThis,
    package_,
    module_,
    enumMember,
    templateDeclaration,
    templateInstance,
    templateMixin,
    forwardingAttribDeclaration,
    nspace,
    declaration,
    storageClassDeclaration,
    expressionDsymbol,
    aliasAssign,
    thisDeclaration,
    bitFieldDeclaration,
    typeInfoDeclaration,
    tupleDeclaration,
    aliasDeclaration,
    aggregateDeclaration,
    funcDeclaration,
    funcAliasDeclaration,
    overDeclaration,
    funcLiteralDeclaration,
    ctorDeclaration,
    postBlitDeclaration,
    dtorDeclaration,
    staticCtorDeclaration,
    staticDtorDeclaration,
    sharedStaticCtorDeclaration,
    sharedStaticDtorDeclaration,
    invariantDeclaration,
    unitTestDeclaration,
    newDeclaration,
    varDeclaration,
    versionSymbol,
    debugSymbol,
    classDeclaration,
    structDeclaration,
    unionDeclaration,
    interfaceDeclaration,
    scopeDsymbol,
    forwardingScopeDsymbol,
    withScopeSymbol,
    arrayScopeSymbol,
    import_,
    enumDeclaration,
    symbolDeclaration,
    attribDeclaration,
    anonDeclaration,
    cppNamespaceDeclaration,
    visibilityDeclaration,
    overloadSet,
    mixinDeclaration,
    staticAssert,
    staticIfDeclaration,
    cAsmDeclaration,
}

/***********************************************************
 * dmd/dsymbol.d:373 — `extern (C++) class Dsymbol : ASTNode`. Root of the symbol hierarchy.
 */
export class Dsymbol extends ASTNode {
    ident: Identifier | null = null;
    parent: Dsymbol | null = null;

    // version (IN_LLVM) -> ON: the two AST-bookkeeping fields the LDC frontend sets (dsymbol.d:379).
    // `void* ir` is an opaque handle (02 §10 case 3). The `else` leg's `void* csym` (:384) is the
    // not-taken branch and is dropped.
    // gap: `ir` has NO writer in this port — its three D assignments `this.ir = newIrDsymbol()`
    //      (dsymbol.d:411, :423, :435) and its release in `~this` (dsymbol.d:441-446) are codegen
    //      hooks into LDC's C++ half, dropped with the rest of codegen (see the file header). The
    //      field is kept because it is part of the D class shape, but it stays null forever.
    // `llvmInternal` (dsymbol.d:380) holds a C++ `LDCPragma` value (gen/pragma.h:25, `LDCPragmaCpp` in
    // gen/dpragma.ts): written by DtoCheckPragma (gen/dpragma.ts), copied to template instances at
    // templatesem.d:1273.
    ir: object | null = null;     // IrDsymbol*
    llvmInternal = 0;             // uint

    _scope: Scope | null = null;  // !=null means context to use for semantic()
    /// attached attribute declarations. D module-private; touched only by `getAtts` in this module,
    /// so it can stay TS-private (01 §2.5).
    private atts: DsymbolAttributes | null = null;
    loc: Loc;                     // where defined (D `const Loc`; set once by the ctors)
    localNum = 0;                 /// ushort — perturb mangled name to avoid collisions with those
                                  /// in FuncDeclaration.localsymtab

    // resolved: `static struct BitFields {...}` + `mixin(generateBitFields!(BitFields, ubyte))`
    // (dsymbol.d:390-401) -> the five generated getter/setter members flattened to plain fields.
    // Nothing in the frontend reads the packed ubyte or its `.sizeof` (only the named members), so
    // the packing is an unobservable implementation detail and may be discarded (11 §3.6).
    errors = false;                       // this symbol failed to pass semantic()
    semanticRun: PASS = PASS.initial;
    // Queued for deferred semantics:
    deferred = false;                     // In Module.deferred
    deferred2 = false;                    // In Module.deferred2
    deferred3 = false;                    // In Module.deferred3

    dsym: DSYM;

    // dmd/dsymbol.d:874 — `extern (D) __gshared const(char)*[void*] commentHashTable;`
    // A process-global AA keyed on the symbol POINTER; a TS map keyed on the object reference is
    // that same identity. Public in D (AddCommentVisitor reads it through `d.commentHashTable`).
    // A WeakMap: D never iterates the AA, and the kept-module engine keeps the table across kept compiles
    // (src/djs.ts `resetForKeptCompile`), so the entry of a symbol the engine drops goes with the symbol.
    static commentHashTable: WeakMap<Dsymbol, DString> = new WeakMap();
    // dmd/dsymbol.d:897 — `private extern (D) __gshared UnitTestDeclaration[void*] ddocUnittestHashTable;`
    private static ddocUnittestHashTable: Map<Dsymbol, UnitTestDeclaration> = new Map();

    /**
     * dmd/dsymbol.d:404/:415/:427 — the three `final extern (D) this(...)` ctors collapsed by ARITY
     * (04 §1A; this exact overload set is the guide's canonical Form-A example):
     *   this(tag)              -> new Dsymbol(tag)                 (loc = Loc.initial, ident = null)
     *   this(tag, ident)       -> new Dsymbol(tag, null, ident)    (loc = Loc.initial)
     *   this(tag, loc, ident)  -> new Dsymbol(tag, loc, ident)
     * `loc` is a value struct: a supplied one is copied (03 §1 #5) and the `Loc.initial` default is
     * copied too (it is `immutable` in D — never mutate the shared instance).
     */
    constructor(tag: DSYM, loc: Loc | null = null, ident: Identifier | null = null) {
        super();
        this.dsym = tag;
        this.loc = loc ? loc.copy() : Loc.initial.copy();
        this.ident = ident;
        // dropped: `version (IN_LLVM) { this.ir = newIrDsymbol(); }` (dsymbol.d:411/:423/:435) —
        //          codegen hook, no codegen in this port.
    }

    // dropped: `version (IN_LLVM) final extern (D) ~this() { deleteIrDsymbol(this.ir); this.ir = null; }`
    //          (dsymbol.d:441-446) — a destructor releasing the C++-side IrDsymbol. No codegen and no
    //          manual memory here; the JS GC reclaims (03 §8, 11 §3.7 — no finalization-order contract).

    /// dmd/dsymbol.d:448 — `static Dsymbol create(Identifier ident)`.
    static create(ident: Identifier): Dsymbol {
        return new Dsymbol(DSYM.dsymbol, null, ident);
    }

    /**
     * dmd/dsymbol.d:453 — `final override const(char)* toChars()`, whose whole body is
     * `import dmd.hdrgen : toChars; return toChars(this);` (the free function at hdrgen.d:231,
     * `dsymbolToChars` in hdrgen.ts), reached through the registration slot under the imports.
     *
     * Throws when hdrgen.js is not in the entry's module graph (the slot's ORDER CONTRACT); that is
     * a load-order defect of the caller's entry, not a D branch.
     */
    override toChars(): DString {
        if (hdrgenToCharsSlot === undefined)
            throw new Error("Dsymbol.toChars: registerDsymbolToChars not called (dmd/hdrgen.d:231)");
        return hdrgenToCharsSlot(this); // dmd/dsymbol.d:456
    }

    // --- Getters / setters for fields stored in `DsymbolAttributes` (dsymbol.d:459-493) ---
    // The whole group is `final nothrow pure @safe` — all attributes erase (04 §8).

    /// dmd/dsymbol.d:462 — `private ref DsymbolAttributes getAtts()`. D returns a `ref` to the
    /// value struct; a TS class instance IS that reference (03 §7.2), so no box is needed.
    private getAtts(): DsymbolAttributes {
        if (!this.atts) this.atts = new DsymbolAttributes();
        return this.atts;
    }

    /// dmd/dsymbol.d:469 — `inout(DeprecatedDeclaration) depdecl() inout` (inout erases, 04 §8).
    depdecl(): DeprecatedDeclaration | null { return this.atts ? this.atts.depdecl_ : null; }
    /// dmd/dsymbol.d:470
    cppnamespace(): CPPNamespaceDeclaration | null { return this.atts ? this.atts.cppnamespace : null; }
    /// dmd/dsymbol.d:471
    userAttribDecl(): UserAttributeDeclaration | null { return this.atts ? this.atts.userAttribDecl : null; }

    // The three property SETTERS (dsymbol.d:473/:480/:487) are same-name overloads of the getters
    // above, distinguished by arity; renamed with the `_set` suffix the tree's dependents already
    // import (04 §1B tie-break 1). Call sites spell `x.depdecl = dd` as `x.depdecl_set(dd)`.
    depdecl_set(dd: DeprecatedDeclaration | null): DeprecatedDeclaration | null {
        if (!dd && !this.atts) return null;
        return (this.getAtts().depdecl_ = dd);
    }
    cppnamespace_set(ns: CPPNamespaceDeclaration | null): CPPNamespaceDeclaration | null {
        if (!ns && !this.atts) return null;
        return (this.getAtts().cppnamespace = ns);
    }
    userAttribDecl_set(uad: UserAttributeDeclaration | null): UserAttributeDeclaration | null {
        if (!uad && !this.atts) return null;
        return (this.getAtts().userAttribDecl = uad);
    }

    /// dmd/dsymbol.d:496 — helper to print fully qualified (template) arguments.
    toPrettyCharsHelper(): DString {
        return this.toChars();
    }

    /// dmd/dsymbol.d:501 — `final bool isAnonymous() const`.
    isAnonymous(): boolean {
        return this.ident === null || this.ident.isAnonymous();
    }

    /**
     * dmd/dsymbol.d:506 — `extern(D) private const(char)[] prettyFormatHelper()`, whose body is
     * `` '`' ~ cstr.toDString() ~ "`\0" ``. D module-private, emitted non-private (01 §2.5).
     * The byte-concat is built through an OutBuffer; `extractChars()` supplies the trailing NUL.
     */
    prettyFormatHelper(): DString {
        const cstr_ = this.toPrettyChars();
        const buf = new OutBuffer();
        buf.writeByte(0x60); // '`'
        buf.writestring(cstr(cstr_)); // dsymbol.d:508 `cstr.toDString()`: the bytes before the NUL
        buf.writeByte(0x60); // '`'
        return buf.extractChars(); // ensures the trailing NUL ("`\0")
    }

    /**********************************
     * dmd/dsymbol.d:515 — Determine which Module a Dsymbol is in.
     */
    getModule(): Module | null {
        //printf("Dsymbol::getModule()\n");
        const ti = this.isInstantiated();               // `if (TemplateInstance ti = ...)` — 06 §2.6
        if (ti !== null) return ti.tempdecl!.getModule(); // D dereferences unconditionally
        let s: Dsymbol | null = this;
        while (s !== null) {
            //printf("\ts = %s '%s'\n", s.kind(), s.toPrettyChars());
            const m = s.isModule();
            if (m !== null) return m;
            s = s.parent;
        }
        return null;
    }

    /**************************************
     * dmd/dsymbol.d:536 — Does this Dsymbol come from a C file?
     * Returns: true if it does
     */
    isCsymbol(): boolean {
        const m = this.getModule();
        if (m !== null) return m.filetype === FileType.c;
        return false;
    }

    /**********************************
     * dmd/dsymbol.d:546 — Determine which Module a Dsymbol is in, as far as access rights go.
     */
    getAccessModule(): Module | null {
        //printf("Dsymbol::getAccessModule()\n");
        const ti0 = this.isInstantiated();
        if (ti0 !== null) return ti0.tempdecl!.getAccessModule();
        let s: Dsymbol | null = this;
        while (s !== null) {
            //printf("\ts = %s '%s'\n", s.kind(), s.toPrettyChars());
            const m = s.isModule();
            if (m !== null) return m;
            const ti = s.isTemplateInstance();
            if (ti !== null && ti.enclosing !== null) {
                /* Because of local template instantiation, the parent isn't where the access
                 * rights come from - it's the template declaration
                 */
                s = ti.tempdecl;
            } else {
                s = s.parent;
            }
        }
        return null;
    }

    /**
     * dmd/dsymbol.d:579 — `pastMixin` returns the enclosing symbol if this is a template mixin.
     * See also `parent`, `toParent` and `toParent2`.
     */
    pastMixin(): Dsymbol | null {
        //printf("Dsymbol::pastMixin() %s\n", toChars());
        if (this.isTemplateMixin() === null && this.isForwardingAttribDeclaration() === null &&
            this.isForwardingScopeDsymbol() === null)
            return this;
        if (this.parent === null) return null;
        return this.parent.pastMixin();
    }

    /**********************************
     * dmd/dsymbol.d:629 — `toParent()` returns a logically enclosing scope symbol this is a member
     * of. It skips over TemplateMixin's.
     */
    toParent(): Dsymbol | null {
        return this.parent !== null ? this.parent.pastMixin() : null;
    }

    /// ditto — dmd/dsymbol.d:635. `toParent2()` returns an enclosing scope symbol this is living at
    /// runtime; it skips over both TemplateInstance's and TemplateMixin's.
    toParent2(): Dsymbol | null {
        if (this.parent === null ||
            (this.parent.isTemplateInstance() === null &&
             this.parent.isForwardingAttribDeclaration() === null &&
             this.parent.isForwardingScopeDsymbol() === null))
            return this.parent;
        return this.parent.toParent2();
    }

    /// ditto — dmd/dsymbol.d:643. Always follows the template DECLARATION scope.
    toParentDecl(): Dsymbol | null {
        return this.toParentDeclImpl(false);
    }

    /// ditto — dmd/dsymbol.d:649. Follows the instantiation scope when the template declaration is
    /// non-local (global or static).
    toParentLocal(): Dsymbol | null {
        return this.toParentDeclImpl(true);
    }

    /// dmd/dsymbol.d:654 — `private inout(Dsymbol) toParentDeclImpl(bool localOnly) inout`.
    private toParentDeclImpl(localOnly: boolean): Dsymbol | null {
        const p = this.toParent();
        if (p === null || p.isTemplateInstance() === null) return p;
        const ti = p.isTemplateInstance()!;
        // `!(cast(TemplateDeclaration)ti.tempdecl).isstatic` — `tempdecl` is declared `Dsymbol`, so
        // D's `cast(TemplateDeclaration)` is a real downcast; the double assertion reproduces it
        // (the runtime object IS a TemplateDeclaration on this path, as in D).
        if (ti.tempdecl !== null &&
            (!localOnly || !(ti.tempdecl as unknown as TemplateDeclaration).isstatic))
            return ti.tempdecl.toParentDeclImpl(localOnly);
        return this.parent!.toParentDeclImpl(localOnly);
    }

    /// dmd/dsymbol.d:665 — the enclosing TemplateInstance this is part of (not a mixin), or null.
    isInstantiated(): TemplateInstance | null {
        if (this.parent === null) return null;
        const ti = this.parent.isTemplateInstance();
        if (ti !== null && ti.isTemplateMixin() === null) return ti;
        return this.parent.isInstantiated();
    }

    /// dmd/dsymbol.d:679 — Check if this function is a member of a template which has only been
    /// instantiated speculatively, eg from inside is(typeof()). Returns the speculative template
    /// instance it is part of, or NULL if not speculative.
    isSpeculative(): TemplateInstance | null {
        if (this.parent === null) return null;
        const ti = this.parent.isTemplateInstance();
        if (ti !== null && ti.gagged) return ti;
        if (this.parent.toParent() === null) return null;
        return this.parent.isSpeculative();
    }

    /// dmd/dsymbol.d:692 — kludge for template.isSymbol().
    override dyncast(): DYNCAST {
        return DYNCAST.dsymbol;
    }

    /*************************************
     * dmd/dsymbol.d:700 — Do syntax copy of an array of Dsymbol's.
     */
    static arraySyntaxCopy(a: Dsymbols | null): Dsymbols | null {
        let b: Dsymbols | null = null;
        if (a !== null) {
            b = a.copy(); // Array.copy(): fresh array, same element refs (each replaced below)
            for (let i = 0; i < b.length; i++) {
                // slot is `Dsymbol | null` (08 §3); D calls through it with no null test -> `!`.
                b.opIndexAssign(b.opIndex(i)!.syntaxCopy(null), i);
            }
        }
        return b;
    }

    /// dmd/dsymbol.d:714
    getIdent(): Identifier | null {
        return this.ident;
    }

    /**
     * dmd/dsymbol.d:719 — `const(char)* toPrettyChars(bool QualifyTypes = false)`. Fully qualified
     * name: walk up `parent`, joining with '.' into an OutBuffer; `QualifyTypes` selects
     * `toPrettyCharsHelper` over `toChars` at each level. `.ptr` on the extracted slice is a no-op
     * in the DString model (08 §11).
     */
    toPrettyChars(QualifyTypes = false): DString {
        //printf("Dsymbol::toPrettyChars() '%s'\n", toChars());
        if (this.parent === null) {
            const s = this.toChars();
            return s;
        }

        const buf = new OutBuffer();

        // dmd/dsymbol.d:730 — nested function -> inner arrow (04 §5), recursing on the parent chain.
        const addQualifiers = (p: Dsymbol): void => {
            if (p.parent !== null) {
                addQualifiers(p.parent);
                buf.writeByte(0x2e); // '.'
            }
            const s = QualifyTypes ? p.toPrettyCharsHelper() : p.toChars();
            // dsymbol.d:738: `s` is a `const(char)*`, so D picks `writestring(const(char)*)`
            // (outbuffer.d:316), which stops at the NUL. `toChars()` of a template instance is an
            // `extractChars()` buffer carrying that NUL; written whole, it cut every later qualifier
            // out of the printed name (`p5.t!()` for `p5.t!().t`), hence `cstr` (02 §11.2).
            buf.writestring(cstr(s));
        };

        addQualifiers(this);
        const s = buf.extractSlice(true);

        return s;
    }

    /// dmd/dsymbol.d:747
    kind(): DString {
        return ds("symbol");
    }

    /// dmd/dsymbol.d:752
    isforwardRef(): boolean {
        return false;
    }

    /// dmd/dsymbol.d:758 — is a 'this' required to access the member
    isThis(): AggregateDeclaration | null {
        return null;
    }

    /// dmd/dsymbol.d:764 — is Dsymbol exported?
    isExport(): boolean {
        return false;
    }

    /// dmd/dsymbol.d:770 — is Dsymbol imported?
    isImportedSymbol(): boolean {
        return false;
    }

    /// dmd/dsymbol.d:776 — is Dsymbol deprecated?
    isDeprecated(): boolean {
        return false;
    }

    /// dmd/dsymbol.d:781
    isOverloadable(): boolean {
        return false;
    }

    /// dmd/dsymbol.d:787 — is this a LabelDsymbol()?
    isLabel(): LabelDsymbol | null {
        return null;
    }

    /// dmd/dsymbol.d:793 — Returns an AggregateDeclaration when toParent() is that.
    isMember(): AggregateDeclaration | null {
        //printf("Dsymbol::isMember() %s\n", toChars());
        const p = this.toParent();
        //printf("parent is %s %s\n", p.kind(), p.toChars());
        return p !== null ? p.isAggregateDeclaration() : null;
    }

    /// dmd/dsymbol.d:802 — Returns an AggregateDeclaration when toParent2() is that.
    isMember2(): AggregateDeclaration | null {
        const p = this.toParent2();
        return p !== null ? p.isAggregateDeclaration() : null;
    }

    /// dmd/dsymbol.d:811 — Returns an AggregateDeclaration when toParentDecl() is that.
    isMemberDecl(): AggregateDeclaration | null {
        const p = this.toParentDecl();
        return p !== null ? p.isAggregateDeclaration() : null;
    }

    /// dmd/dsymbol.d:820 — Returns an AggregateDeclaration when toParentLocal() is that.
    isMemberLocal(): AggregateDeclaration | null {
        const p = this.toParentLocal();
        return p !== null ? p.isAggregateDeclaration() : null;
    }

    /// dmd/dsymbol.d:829 — is this a member of a ClassDeclaration?
    isClassMember(): ClassDeclaration | null {
        const ad = this.isMember();
        return ad !== null ? ad.isClassDeclaration() : null;
    }

    /// dmd/dsymbol.d:836 — need a 'this' pointer?
    needThis(): boolean {
        return false;
    }

    /*************************************
     * dmd/dsymbol.d:843
     */
    visible(): Visibility {
        return new Visibility(Visibility.Kind.public_);
    }

    /**************************************
     * dmd/dsymbol.d:853 — Copy the syntax. Used for template instantiations.
     * If s is NULL, allocate the new object, otherwise fill it in.
     *
     * The base is unreachable: concrete subclasses override it.
     * dropped: `printf("%s %s\n", kind(), toChars());` — a debug trace preceding the load-bearing
     * `assert(0)`; same disposition as blockexit.d:72-73 (blockexit.ts). D's `assert(0)` carries no
     * message, so this is a bare `assertUnreachable()` (10 §2.2) — reconstructing the dropped
     * printf's text into one would synthesize diagnostic bytes dmd never produces.
     */
    syntaxCopy(_s: Dsymbol | null): Dsymbol {
        return assertUnreachable(); // dsymbol.d:856 — assert(0)
    }

    // NOT a member: `addObjcSymbols`. dsymbol.d declares no such method — in 1.43 it is the UFCS
    // FREE function `addObjcSymbols(Dsymbol _this, ClassDeclarations*, ClassDeclarations*)` at
    // dsymbolsem.d:138, dispatched there by its own visitor. It belongs to dmd.dsymbolsem, never to
    // this class (04 §6: a UFCS free function is never promoted onto its receiver). Do not re-add it.

    /// dmd/dsymbol.d:860 — get documentation comment for this Dsymbol.
    comment(): DString | null {
        //printf("getcomment: %p '%s'\n", this, this.toChars());
        // `if (auto p = cast(void*)this in commentHashTable) return *p;` — AA `in` -> Map.get.
        const p = Dsymbol.commentHashTable.get(this);
        if (p !== undefined) {
            //printf("comment: '%s'\n", *p);
            return p;
        }
        return null;
    }

    /**
     * dmd/dsymbol.d:870 — `final void addComment(const(char)* c) { .addComment(this, c); }`.
     * The leading `.` names the MODULE-scope `addComment` free function (dsymbol.d:109), not this
     * method; in TS the bare call resolves to the module function for the same reason.
     */
    addComment(c: DString | null): void {
        addComment(this, c);
    }

    /**********************************
     * dmd/dsymbol.d:882 — Get ddoc unittest associated with this symbol (only use this with ddoc).
     * Returns: ddoc unittest, null if none
     */
    ddocUnittest(): UnitTestDeclaration | null {
        const p = Dsymbol.ddocUnittestHashTable.get(this);
        return p !== undefined ? p : null;
    }

    /**********************************
     * dmd/dsymbol.d:892 — Set ddoc unittest associated with this symbol. The `void ddocUnittest(...)`
     * setter overload of the getter above; renamed `_set` (04 §1B, the suffix dependents import).
     */
    ddocUnittest_set(utd: UnitTestDeclaration): void {
        Dsymbol.ddocUnittestHashTable.set(this, utd);
    }

    /****************************************
     * dmd/dsymbol.d:903 — Returns true if this symbol is defined in a non-root module without
     * instantiation.
     */
    inNonRoot(): boolean {
        let s: Dsymbol | null = this.parent;
        for (; s !== null; s = s.toParent()) {
            if (s.isTemplateInstance() !== null) {
                return false;
            }
            const m = s.isModule();
            if (m !== null) {
                if (!m.isRoot()) return true;
                break;
            }
        }
        return false;
    }

    /**
     * dmd/dsymbol.d:928 — Deinitializes the global state of the compiler. This can be used to
     * restore the state set by `_init` to its original state.
     * `commentHashTable.init` for an AA is the empty (null) map -> a fresh map.
     */
    static deinitialize(): void {
        Dsymbol.commentHashTable = new WeakMap();
        Dsymbol.ddocUnittestHashTable = new Map();
    }

    /************
     * dmd/dsymbol.d:936 — accept: dispatch to this node's OWN named method (13 §2).
     */
    accept(v: Visitor): void {
        v.visitDsymbol(this);
    }

    // ==========================================================================================
    // dmd/dsymbol.d:941-1116 — the `pure nothrow @trusted @nogc final:` block of DSYM-tag RTTI
    // downcasts. Each D body is `cast(inout(X)) cast(void*) this` — a deliberate TWO-STEP
    // reinterpret through `void*` that bypasses D's own class-cast check because the DSYM tag has
    // already proved the type. `x as unknown as X` is the faithful TS spelling of exactly that
    // two-step (and is required in any case wherever a subclass field shadows a base one, 02 §11.5:
    // AggregateDeclaration.deferred, Module.errors, ...). These are NOT narrowing assertions over
    // an unproven value: the DSYM comparison immediately to their left IS the proof, as in D.
    // All attributes erase (04 §8); `inout` on the return type erases too.
    // ==========================================================================================

    isPackage(): Package | null {
        return (this.dsym === DSYM.package_ || this.dsym === DSYM.module_)
            ? (this as unknown as Package) : null;
    }
    isModule(): Module | null {
        return this.dsym === DSYM.module_ ? (this as unknown as Module) : null;
    }
    isEnumMember(): EnumMember | null {
        return this.dsym === DSYM.enumMember ? (this as unknown as EnumMember) : null;
    }
    isTemplateDeclaration(): TemplateDeclaration | null {
        return this.dsym === DSYM.templateDeclaration ? (this as unknown as TemplateDeclaration) : null;
    }
    isTemplateInstance(): TemplateInstance | null {
        return (this.dsym === DSYM.templateInstance || this.dsym === DSYM.templateMixin)
            ? (this as unknown as TemplateInstance) : null;
    }
    isTemplateMixin(): TemplateMixin | null {
        return this.dsym === DSYM.templateMixin ? (this as unknown as TemplateMixin) : null;
    }
    isForwardingAttribDeclaration(): ForwardingAttribDeclaration | null {
        return this.dsym === DSYM.forwardingAttribDeclaration
            ? (this as unknown as ForwardingAttribDeclaration) : null;
    }
    isNspace(): Nspace | null {
        return this.dsym === DSYM.nspace ? (this as unknown as Nspace) : null;
    }
    isDeclaration(): Declaration | null {
        switch (this.dsym) {
            case DSYM.tupleDeclaration:
            case DSYM.aliasDeclaration:
            case DSYM.overDeclaration:
            case DSYM.varDeclaration:
            case DSYM.bitFieldDeclaration:
            case DSYM.typeInfoDeclaration:
            case DSYM.thisDeclaration:
            case DSYM.enumMember:
            case DSYM.symbolDeclaration:
            case DSYM.funcDeclaration:
            case DSYM.funcAliasDeclaration:
            case DSYM.funcLiteralDeclaration:
            case DSYM.ctorDeclaration:
            case DSYM.postBlitDeclaration:
            case DSYM.dtorDeclaration:
            case DSYM.staticCtorDeclaration:
            case DSYM.sharedStaticCtorDeclaration:
            case DSYM.staticDtorDeclaration:
            case DSYM.sharedStaticDtorDeclaration:
            case DSYM.invariantDeclaration:
            case DSYM.unitTestDeclaration:
            case DSYM.newDeclaration:
                return this as unknown as Declaration;
            default:
                return null;
        }
    }
    isStorageClassDeclaration(): StorageClassDeclaration | null {
        return this.dsym === DSYM.storageClassDeclaration
            ? (this as unknown as StorageClassDeclaration) : null;
    }
    isExpressionDsymbol(): ExpressionDsymbol | null {
        return this.dsym === DSYM.expressionDsymbol ? (this as unknown as ExpressionDsymbol) : null;
    }
    isAliasAssign(): AliasAssign | null {
        return this.dsym === DSYM.aliasAssign ? (this as unknown as AliasAssign) : null;
    }
    isThisDeclaration(): ThisDeclaration | null {
        return this.dsym === DSYM.thisDeclaration ? (this as unknown as ThisDeclaration) : null;
    }
    isBitFieldDeclaration(): BitFieldDeclaration | null {
        return this.dsym === DSYM.bitFieldDeclaration ? (this as unknown as BitFieldDeclaration) : null;
    }
    isTypeInfoDeclaration(): TypeInfoDeclaration | null {
        return this.dsym === DSYM.typeInfoDeclaration ? (this as unknown as TypeInfoDeclaration) : null;
    }
    isTupleDeclaration(): TupleDeclaration | null {
        return this.dsym === DSYM.tupleDeclaration ? (this as unknown as TupleDeclaration) : null;
    }
    isAliasDeclaration(): AliasDeclaration | null {
        return this.dsym === DSYM.aliasDeclaration ? (this as unknown as AliasDeclaration) : null;
    }
    isAggregateDeclaration(): AggregateDeclaration | null {
        switch (this.dsym) {
            case DSYM.aggregateDeclaration:
            case DSYM.structDeclaration:
            case DSYM.unionDeclaration:
            case DSYM.classDeclaration:
            case DSYM.interfaceDeclaration:
                return this as unknown as AggregateDeclaration;
            default:
                return null;
        }
    }
    isFuncDeclaration(): FuncDeclaration | null {
        switch (this.dsym) {
            case DSYM.funcDeclaration:
            case DSYM.funcAliasDeclaration:
            case DSYM.funcLiteralDeclaration:
            case DSYM.ctorDeclaration:
            case DSYM.postBlitDeclaration:
            case DSYM.dtorDeclaration:
            case DSYM.staticCtorDeclaration:
            case DSYM.sharedStaticCtorDeclaration:
            case DSYM.staticDtorDeclaration:
            case DSYM.sharedStaticDtorDeclaration:
            case DSYM.invariantDeclaration:
            case DSYM.unitTestDeclaration:
            case DSYM.newDeclaration:
                return this as unknown as FuncDeclaration;
            default:
                return null;
        }
    }
    isFuncAliasDeclaration(): FuncAliasDeclaration | null {
        return this.dsym === DSYM.funcAliasDeclaration ? (this as unknown as FuncAliasDeclaration) : null;
    }
    isOverDeclaration(): OverDeclaration | null {
        return this.dsym === DSYM.overDeclaration ? (this as unknown as OverDeclaration) : null;
    }
    isFuncLiteralDeclaration(): FuncLiteralDeclaration | null {
        return this.dsym === DSYM.funcLiteralDeclaration ? (this as unknown as FuncLiteralDeclaration) : null;
    }
    isCtorDeclaration(): CtorDeclaration | null {
        return this.dsym === DSYM.ctorDeclaration ? (this as unknown as CtorDeclaration) : null;
    }
    isPostBlitDeclaration(): PostBlitDeclaration | null {
        return this.dsym === DSYM.postBlitDeclaration ? (this as unknown as PostBlitDeclaration) : null;
    }
    isDtorDeclaration(): DtorDeclaration | null {
        return this.dsym === DSYM.dtorDeclaration ? (this as unknown as DtorDeclaration) : null;
    }
    isStaticCtorDeclaration(): StaticCtorDeclaration | null {
        return (this.dsym === DSYM.staticCtorDeclaration || this.dsym === DSYM.sharedStaticCtorDeclaration)
            ? (this as unknown as StaticCtorDeclaration) : null;
    }
    isStaticDtorDeclaration(): StaticDtorDeclaration | null {
        return (this.dsym === DSYM.staticDtorDeclaration || this.dsym === DSYM.sharedStaticDtorDeclaration)
            ? (this as unknown as StaticDtorDeclaration) : null;
    }
    isSharedStaticCtorDeclaration(): SharedStaticCtorDeclaration | null {
        return this.dsym === DSYM.sharedStaticCtorDeclaration
            ? (this as unknown as SharedStaticCtorDeclaration) : null;
    }
    isSharedStaticDtorDeclaration(): SharedStaticDtorDeclaration | null {
        return this.dsym === DSYM.sharedStaticDtorDeclaration
            ? (this as unknown as SharedStaticDtorDeclaration) : null;
    }
    isInvariantDeclaration(): InvariantDeclaration | null {
        return this.dsym === DSYM.invariantDeclaration ? (this as unknown as InvariantDeclaration) : null;
    }
    isUnitTestDeclaration(): UnitTestDeclaration | null {
        return this.dsym === DSYM.unitTestDeclaration ? (this as unknown as UnitTestDeclaration) : null;
    }
    isNewDeclaration(): NewDeclaration | null {
        return this.dsym === DSYM.newDeclaration ? (this as unknown as NewDeclaration) : null;
    }
    isVarDeclaration(): VarDeclaration | null {
        switch (this.dsym) {
            case DSYM.varDeclaration:
            case DSYM.bitFieldDeclaration:
            case DSYM.typeInfoDeclaration:
            case DSYM.thisDeclaration:
            case DSYM.enumMember:
                return this as unknown as VarDeclaration;
            default:
                return null;
        }
    }
    isVersionSymbol(): VersionSymbol | null {
        return this.dsym === DSYM.versionSymbol ? (this as unknown as VersionSymbol) : null;
    }
    isDebugSymbol(): DebugSymbol | null {
        return this.dsym === DSYM.debugSymbol ? (this as unknown as DebugSymbol) : null;
    }
    isClassDeclaration(): ClassDeclaration | null {
        return (this.dsym === DSYM.classDeclaration || this.dsym === DSYM.interfaceDeclaration)
            ? (this as unknown as ClassDeclaration) : null;
    }
    isStructDeclaration(): StructDeclaration | null {
        return (this.dsym === DSYM.structDeclaration || this.dsym === DSYM.unionDeclaration)
            ? (this as unknown as StructDeclaration) : null;
    }
    isUnionDeclaration(): UnionDeclaration | null {
        return this.dsym === DSYM.unionDeclaration ? (this as unknown as UnionDeclaration) : null;
    }
    isInterfaceDeclaration(): InterfaceDeclaration | null {
        return this.dsym === DSYM.interfaceDeclaration ? (this as unknown as InterfaceDeclaration) : null;
    }
    isScopeDsymbol(): ScopeDsymbol | null {
        switch (this.dsym) {
            case DSYM.enumDeclaration:
            case DSYM.scopeDsymbol:
            case DSYM.package_:
            case DSYM.module_:
            case DSYM.nspace:
            case DSYM.templateInstance:
            case DSYM.templateMixin:
            case DSYM.templateDeclaration:
            case DSYM.aggregateDeclaration:
            case DSYM.structDeclaration:
            case DSYM.unionDeclaration:
            case DSYM.classDeclaration:
            case DSYM.interfaceDeclaration:
            case DSYM.withScopeSymbol:
            case DSYM.arrayScopeSymbol:
            case DSYM.forwardingScopeDsymbol:
                return this as unknown as ScopeDsymbol;
            default:
                return null;
        }
    }
    isForwardingScopeDsymbol(): ForwardingScopeDsymbol | null {
        return this.dsym === DSYM.forwardingScopeDsymbol
            ? (this as unknown as ForwardingScopeDsymbol) : null;
    }
    isWithScopeSymbol(): WithScopeSymbol | null {
        return this.dsym === DSYM.withScopeSymbol ? (this as unknown as WithScopeSymbol) : null;
    }
    isArrayScopeSymbol(): ArrayScopeSymbol | null {
        return this.dsym === DSYM.arrayScopeSymbol ? (this as unknown as ArrayScopeSymbol) : null;
    }
    isImport(): Import | null {
        return this.dsym === DSYM.import_ ? (this as unknown as Import) : null;
    }
    isEnumDeclaration(): EnumDeclaration | null {
        return this.dsym === DSYM.enumDeclaration ? (this as unknown as EnumDeclaration) : null;
    }
    isSymbolDeclaration(): SymbolDeclaration | null {
        return this.dsym === DSYM.symbolDeclaration ? (this as unknown as SymbolDeclaration) : null;
    }
    isAttribDeclaration(): AttribDeclaration | null {
        switch (this.dsym) {
            case DSYM.attribDeclaration:
            case DSYM.storageClassDeclaration:
            case DSYM.linkDeclaration:
            case DSYM.cppMangleDeclaration:
            case DSYM.cppNamespaceDeclaration:
            case DSYM.visibilityDeclaration:
            case DSYM.alignDeclaration:
            case DSYM.anonDeclaration:
            case DSYM.pragmaDeclaration:
            case DSYM.conditionalDeclaration:
            case DSYM.staticIfDeclaration:
            case DSYM.staticForeachDeclaration:
            case DSYM.forwardingAttribDeclaration:
            case DSYM.mixinDeclaration:
            case DSYM.userAttributeDeclaration:
                return this as unknown as AttribDeclaration;
            default:
                return null;
        }
    }
    isAlignDeclaration(): AlignDeclaration | null {
        return this.dsym === DSYM.alignDeclaration ? (this as unknown as AlignDeclaration) : null;
    }
    isAnonDeclaration(): AnonDeclaration | null {
        return this.dsym === DSYM.anonDeclaration ? (this as unknown as AnonDeclaration) : null;
    }
    isCPPNamespaceDeclaration(): CPPNamespaceDeclaration | null {
        return this.dsym === DSYM.cppNamespaceDeclaration
            ? (this as unknown as CPPNamespaceDeclaration) : null;
    }
    isVisibilityDeclaration(): VisibilityDeclaration | null {
        return this.dsym === DSYM.visibilityDeclaration ? (this as unknown as VisibilityDeclaration) : null;
    }
    isOverloadSet(): OverloadSet | null {
        return this.dsym === DSYM.overloadSet ? (this as unknown as OverloadSet) : null;
    }
    isMixinDeclaration(): MixinDeclaration | null {
        return this.dsym === DSYM.mixinDeclaration ? (this as unknown as MixinDeclaration) : null;
    }
    isStaticAssert(): StaticAssert | null {
        return this.dsym === DSYM.staticAssert ? (this as unknown as StaticAssert) : null;
    }
    isStaticIfDeclaration(): StaticIfDeclaration | null {
        return this.dsym === DSYM.staticIfDeclaration ? (this as unknown as StaticIfDeclaration) : null;
    }
    isCAsmDeclaration(): CAsmDeclaration | null {
        return this.dsym === DSYM.cAsmDeclaration ? (this as unknown as CAsmDeclaration) : null;
    }
}

/***********************************************************
 * dmd/dsymbol.d:1122 — `extern (C++) class ScopeDsymbol : Dsymbol`. Dsymbol that generates a scope.
 */
export class ScopeDsymbol extends Dsymbol {
    members: Dsymbols | null = null;          // all Dsymbol's in this scope
    symtab: DsymbolTable | null = null;       // members[] sorted into table
    endlinnum = 0;                            // the linnumber of the statement after the scope (0 if unknown)
    /// symbols whose members have been imported, i.e. imported modules and template mixins
    importedScopes: Dsymbols | null = null;
    /// `Visibility.Kind* visibilities` — array of Visibility.Kind, one for each import. The raw
    /// pointer models a hand-realloc'd buffer; here a growable JS array (03 §8: allocator erases).
    visibilities: Visibility.Kind[] | null = null;

    // D `private:` + `import dmd.root.bitarray;` (dsymbol.d:1131-1134). Module-private in D, and in
    // fact touched ONLY by `addAccessiblePackage` / `isPackageAccessible` on this class — no module
    // sibling and no unittest reads them — so they are truly class-local and take TS `private`
    // (01 §2.5 / 10 §1.7: emit without `private` only when a sibling or a module unittest touches it).
    // whitelists of accessible (imported) packages
    private accessiblePackages: BitArray = new BitArray();
    private privateAccessiblePackages: BitArray = new BitArray();

    /**
     * dmd/dsymbol.d:1137/:1142/:1147 — the three `final extern (D) this(...)` ctors collapsed by
     * ARITY (04 §1A Form A — the guide's canonical example is exactly this set):
     *   this()             -> new ScopeDsymbol()
     *   this(ident)        -> new ScopeDsymbol(null, ident)
     *   this(loc, ident)   -> new ScopeDsymbol(loc, ident)
     */
    constructor(loc: Loc | null = null, ident: Identifier | null = null) {
        super(DSYM.scopeDsymbol, loc, ident);
    }

    /// dmd/dsymbol.d:1152 — `override ScopeDsymbol syntaxCopy(Dsymbol s)`.
    override syntaxCopy(s: Dsymbol | null): ScopeDsymbol {
        //printf("ScopeDsymbol::syntaxCopy('%s')\n", toChars());
        // `s ? cast(ScopeDsymbol)s : new ScopeDsymbol(ident)` — the cast is D's checked downcast on
        // a symbol the caller has already constructed as a ScopeDsymbol subclass.
        const sds: ScopeDsymbol = s !== null ? (s as ScopeDsymbol) : new ScopeDsymbol(null, this.ident);
        sds.addComment(this.comment());
        sds.members = Dsymbol.arraySyntaxCopy(this.members);
        sds.endlinnum = this.endlinnum;
        return sds;
    }

    /**
     * dmd/dsymbol.d:1162 — record `s` as an imported scope. No circular or redundant import's.
     * The `visibilities` array is kept parallel to `importedScopes`; D's
     * `mem.xrealloc(visibilities, n * Visibility.Kind.sizeof)` becomes a length set (03 §8).
     */
    importScope(s: Dsymbol, visibility: Visibility): void {
        //printf("%s.ScopeDsymbol::importScope(%s, %d)\n", toChars(), s.toChars(), visibility);
        // No circular or redundant import's
        if (s !== this) {
            if (this.importedScopes === null) {
                this.importedScopes = new DArray<Dsymbol | null>();
                // `visibilities` is null until the first xrealloc below; allocate the parallel array.
                this.visibilities = [];
            } else {
                for (let i = 0; i < this.importedScopes.length; i++) {
                    const ss = this.importedScopes.opIndex(i);
                    if (ss === s) {
                        // if already imported
                        if (visibility.kind > this.visibilities![i])
                            this.visibilities![i] = visibility.kind; // upgrade access
                        return;
                    }
                }
            }
            this.importedScopes.push(s);
            this.visibilities!.length = this.importedScopes.length;
            this.visibilities![this.importedScopes.length - 1] = visibility.kind;
        }
    }

    /*****************************************
     * dmd/dsymbol.d:1196 — Returns: the symbols whose members have been imported, i.e. imported
     * modules and template mixins.
     * See_Also: importScope
     */
    getImportedScopes(): Dsymbols | null {
        return this.importedScopes;
    }

    /*****************************************
     * dmd/dsymbol.d:1207 — Returns: the array of visibilities associated with each imported scope.
     * The length of the array matches the imported scopes array.
     * See_Also: getImportedScopes
     *
     * D returns the SLICE `visibilities[0 .. importedScopes.length]` — a LIVE view onto the buffer,
     * so a write through the result is visible on the ScopeDsymbol. The port keeps `visibilities`
     * exactly `importedScopes.length` long (`importScope` sets the length on every push, above), so
     * the array IS that slice and returning it reproduces the aliasing — no `.copy()`/`.slice()` is
     * emitted, which would silently turn D's view into a snapshot (03 §1: a D slice SHARES).
     */
    getImportVisibilities(): Visibility.Kind[] | null {
        if (this.importedScopes === null) return null;

        return this.visibilities!;
    }

    /// dmd/dsymbol.d:1215 — whitelist a package as accessible; private imports use the private list.
    /// `auto pary = cond ? &privateAccessiblePackages : &accessiblePackages;` — address-of a value
    /// struct field IS the object reference (03 §7.2), so `(*pary)[p.tag] = true` writes in place.
    addAccessiblePackage(p: Package, visibility: Visibility): void {
        const pary = visibility.kind === Visibility.Kind.private_
            ? this.privateAccessiblePackages : this.accessiblePackages;
        if (pary.length <= p.tag) pary.length = p.tag + 1;
        pary.opIndexAssign(true, p.tag);
    }

    /// dmd/dsymbol.d:1223 — is package `p` accessible from here (transitively through visible imports)?
    /// `flags` is part of the D signature (with its default) but is never read by the D body; the
    /// underscore prefix is this file's convention for such a parameter (see `_s` at symtabLookup).
    isPackageAccessible(p: Package, visibility: Visibility, _flags: SearchOptFlags = SearchOpt.all): boolean {
        if ((p.tag < this.accessiblePackages.length && this.accessiblePackages.opIndex(p.tag)) ||
            (visibility.kind === Visibility.Kind.private_ &&
                p.tag < this.privateAccessiblePackages.length &&
                this.privateAccessiblePackages.opIndex(p.tag)))
            return true;
        // `foreach (i, ss; importedScopes ? (*importedScopes)[] : null)` — an empty (null) slice
        // when there are no imported scopes, so the loop simply does not run.
        if (this.importedScopes !== null) {
            for (let i = 0; i < this.importedScopes.length; i++) {
                const ss = this.importedScopes.opIndex(i);
                // only search visible scopes && imported modules should ignore private imports
                // slot is `Dsymbol | null` (08 §3); D calls through it with no null test -> `!`.
                // `visibility` is a by-value struct PARAMETER of the callee, so the copy is emitted
                // at this call site (03 §1#2/§3.1). `Visibility` is not in the §9.1 alias-safe
                // register, so the copy is not licensed to be elided.
                if (visibility.kind <= this.visibilities![i] &&
                    ss!.isScopeDsymbol()!.isPackageAccessible(p, visibility.copy(), SearchOpt.ignorePrivateImports))
                    return true;
            }
        }
        return false;
    }

    /// dmd/dsymbol.d:1238
    override isforwardRef(): boolean {
        return this.members === null;
    }

    /**
     * dmd/dsymbol.d:1243 — report a redefinition: `s1` and `s2` are two symbols with the same name.
     * dropped: the `version (none)` printf debug block (dsymbol.d:1245-1250) — version `none` is
     *          always OFF (_config.md §1).
     * dropped: the `static if (0)` OverloadSet dump (dsymbol.d:1257-1275) — resolves false (07 §3).
     * The two diagnostic format strings are reproduced byte-for-byte (10 §3).
     */
    static multiplyDefined(loc: Loc, s1: Dsymbol, s2: Dsymbol): void {
        if (loc.isValid()) {
            error(loc, ds("`%s` matches conflicting symbols:"), s1.ident!.toChars());
            errorSupplemental(s1.loc, ds("%s `%s`"), s1.kind(), s1.toPrettyChars());
            errorSupplemental(s2.loc, ds("%s `%s`"), s2.kind(), s2.toPrettyChars());
        } else {
            error(s1.loc, ds("%s `%s` conflicts with %s `%s` at %s"),
                  s1.kind(), s1.toPrettyChars(), s2.kind(), s2.toPrettyChars(), s2.loc.toChars());
        }
    }

    /// dmd/dsymbol.d:1283
    override kind(): DString {
        return ds("ScopeDsymbol");
    }

    /********************************
     * dmd/dsymbol.d:1295 — Insert Dsymbol in table.
     * Params:
     *   s = symbol to add
     * Returns:
     *   null if already in table, `s` if inserted
     *
     * D dereferences `symtab` unconditionally; the `!` marks that same fault site.
     */
    symtabInsert(s: Dsymbol): Dsymbol | null {
        return this.symtab!.insert(s);
    }

    /****************************************
     * dmd/dsymbol.d:1308 — Look up identifier in symbol table.
     * Params:
     *  s = symbol
     *  id = identifier to look up
     * Returns:
     *   Dsymbol if found, null if not
     */
    symtabLookup(_s: Dsymbol, id: Identifier): Dsymbol | null {
        return this.symtab!.lookup(id);
    }

    /// dmd/dsymbol.d:1313
    override accept(v: Visitor): void {
        v.visitScopeDsymbol(this);
    }
}

/***********************************************************
 * dmd/dsymbol.d:1322 — `extern (C++) final class WithScopeSymbol : ScopeDsymbol`. With statement scope.
 */
export class WithScopeSymbol extends ScopeDsymbol {
    withstate: WithStatement;

    /// dmd/dsymbol.d:1326 — no explicit `super(...)`: D runs `ScopeDsymbol.this()`, which leaves
    /// `dsym == DSYM.scopeDsymbol`, and the body then overwrites it with `DSYM.withScopeSymbol`.
    constructor(withstate: WithStatement) {
        super();
        this.withstate = withstate;
        this.dsym = DSYM.withScopeSymbol;
    }

    /// dmd/dsymbol.d:1332
    override accept(v: Visitor): void {
        v.visitWithScopeSymbol(this);
    }
}

/***********************************************************
 * dmd/dsymbol.d:1341 — `extern (C++) final class ArrayScopeSymbol : ScopeDsymbol`.
 * Array Index/Slice scope.
 */
export class ArrayScopeSymbol extends ScopeDsymbol {
    // either a SliceExp, an IndexExp, an ArrayExp, a TypeTuple or a TupleDeclaration.
    // Discriminated using DYNCAST and, for expressions, also EXP
    arrayContent!: RootObject;

    /**
     * The three D ctors (dsymbol.d:1347/:1356/:1362) are Form B — SAME arity `(Scope*, X)`,
     * different `X` — so they become NAMED STATIC FACTORIES and every `new ArrayScopeSymbol(...)`
     * call site is rewritten to the factory D's overload resolution already chose (04 §1B).
     * Emitting a runtime type test instead is explicitly forbidden there.
     *
     * This private constructor exists only to carry the base-ctor arity the factories need;
     * `ArrayScopeSymbol` is `final` in D, so blocking external `new`/subclassing is faithful.
     */
    private constructor(loc: Loc | null = null, ident: Identifier | null = null) {
        super(loc, ident);
    }

    /// dmd/dsymbol.d:1347 — `this(Scope* sc, Expression exp)`. NOTE this is the only one of the
    /// three that calls `super(exp.loc, null)` and that sets `dsym = DSYM.arrayScopeSymbol`.
    static fromExpression(sc: Scope, exp: Expression): ArrayScopeSymbol {
        const self = new ArrayScopeSymbol(exp.loc, null); // super(exp.loc, null)
        assert(exp.op === EXP.index || exp.op === EXP.slice || exp.op === EXP.array);
        self._scope = sc;
        self.arrayContent = exp;
        self.dsym = DSYM.arrayScopeSymbol;
        return self;
    }

    /// dmd/dsymbol.d:1356 — `this(Scope* sc, TypeTuple type)`. No explicit `super(...)`, so D runs
    /// `ScopeDsymbol.this()` and `dsym` STAYS `DSYM.scopeDsymbol`; no `dsym` write follows. Faithful.
    static fromTypeTuple(sc: Scope, type: TypeTuple): ArrayScopeSymbol {
        const self = new ArrayScopeSymbol();
        self._scope = sc;
        self.arrayContent = type;
        return self;
    }

    /// dmd/dsymbol.d:1362 — `this(Scope* sc, TupleDeclaration td)`. Same `dsym` quirk as above.
    static fromTupleDeclaration(sc: Scope, td: TupleDeclaration): ArrayScopeSymbol {
        const self = new ArrayScopeSymbol();
        self._scope = sc;
        self.arrayContent = td;
        return self;
    }

    /// dmd/dsymbol.d:1368
    override accept(v: Visitor): void {
        v.visitArrayScopeSymbol(this);
    }
}

/***********************************************************
 * dmd/dsymbol.d:1377 — `extern (C++) final class OverloadSet : Dsymbol`. Overload Sets.
 */
export class OverloadSet extends Dsymbol {
    a: Dsymbols;  // array of Dsymbols — a BY-VALUE `Dsymbols` field (not a pointer)

    /// dmd/dsymbol.d:1381 — `this(Identifier ident, OverloadSet os = null)`.
    constructor(ident: Identifier, os: OverloadSet | null = null) {
        super(DSYM.overloadSet, null, ident);
        // Constructed AS the alias's element type (08 §3 construction rule).
        this.a = new DArray<Dsymbol | null>();
        if (os !== null) {
            this.a.pushSlice(os.a.opSlice()); // `a.pushSlice(os.a[])` — `[]` is the whole-array view
        }
    }

    /// dmd/dsymbol.d:1390
    push(s: Dsymbol): void {
        this.a.push(s);
    }

    /// dmd/dsymbol.d:1395
    override kind(): DString {
        return ds("overloadset");
    }

    /// dmd/dsymbol.d:1400
    override accept(v: Visitor): void {
        v.visitOverloadSet(this);
    }
}

/***********************************************************
 * dmd/dsymbol.d:1412 — `extern (C++) final class ForwardingScopeDsymbol : ScopeDsymbol`.
 * Forwarding ScopeDsymbol. Used by ForwardingAttribDeclaration and ForwardingScopeDeclaration to
 * forward symbol insertions to another scope. See `dmd.attrib.ForwardingAttribDeclaration`.
 */
export class ForwardingScopeDsymbol extends ScopeDsymbol {
    /// dmd/dsymbol.d:1414
    constructor() {
        super();
        this.dsym = DSYM.forwardingScopeDsymbol;
    }

    /// dmd/dsymbol.d:1420 — STC.local symbols stay local; everything else forwards to parent scope.
    override symtabInsert(s: Dsymbol): Dsymbol | null {
        const d = s.isDeclaration();
        if (d !== null) {
            // STC is a 64-bit flag set -> bigint (02 §4.2); the mask test is `!== 0n` (06 §2.5).
            if ((d.storage_class & STC.local) !== 0n) {
                // Symbols with storage class STC.local are not forwarded, but stored in the local
                // symbol table. (Those are the `static foreach` variables.)
                if (this.symtab === null) {
                    this.symtab = new DsymbolTable();
                }
                return super.symtabInsert(s); // insert locally
            }
        }
        const forward = this.parent!.isScopeDsymbol();
        assert(forward);
        if (forward!.symtab === null) {
            forward!.symtab = new DsymbolTable();
        }
        // Non-STC.local symbols are forwarded to `forward`.
        return forward!.symtabInsert(s);
    }

    /************************
     * dmd/dsymbol.d:1452 — This override handles the following two cases:
     *     static foreach (i, i; [0]) { ... }
     * and
     *     static foreach (i; [0]) { enum i = 2; }
     */
    override symtabLookup(s: Dsymbol, id: Identifier): Dsymbol | null {
        // correctly diagnose clashing foreach loop variables.
        const d = s.isDeclaration();
        if (d !== null) {
            if ((d.storage_class & STC.local) !== 0n) {
                if (this.symtab === null) {
                    this.symtab = new DsymbolTable();
                }
                return super.symtabLookup(s, id);
            }
        }
        // Declarations within `static foreach` do not clash with `static foreach` loop variables.
        const forward = this.parent!.isScopeDsymbol();
        assert(forward);
        if (forward!.symtab === null) {
            forward!.symtab = new DsymbolTable();
        }
        return forward!.symtabLookup(s, id);
    }

    /// dmd/dsymbol.d:1477
    override importScope(s: Dsymbol, visibility: Visibility): void {
        const forward = this.parent!.isScopeDsymbol();
        assert(forward);
        // `visibility` is a by-value struct parameter of `ScopeDsymbol.importScope` (dsymbol.d:1162),
        // so the copy is emitted at this call site (03 §1#2/§3.1); `Visibility` is not §9.1-registered.
        forward!.importScope(s, visibility.copy());
    }

    /// dmd/dsymbol.d:1484
    override kind(): DString {
        return ds("local scope");
    }
}

/**
 * dmd/dsymbol.d:1493 — `extern (C++) final class ExpressionDsymbol : Dsymbol`.
 * Class that holds an expression in a Dsymbol wrapper. This is not an AST node, but a class used to
 * pass an expression as a function parameter of type Dsymbol.
 * (No `accept` override in D — it inherits Dsymbol's.)
 */
export class ExpressionDsymbol extends Dsymbol {
    exp: Expression;

    /// dmd/dsymbol.d:1496
    constructor(exp: Expression) {
        super(DSYM.expressionDsymbol);
        this.exp = exp;
    }
}

/**********************************************
 * dmd/dsymbol.d:1509 — `extern (C++) final class AliasAssign : Dsymbol`.
 * Encapsulate assigning to an alias:
 *      `identifier = type;`
 *      `identifier = symbol;`
 * where `identifier` is an AliasDeclaration in scope.
 */
export class AliasAssign extends Dsymbol {
    /**
     * dmd/dsymbol.d:1511 — `Identifier ident;`: the name of the alias being assigned.
     *
     * D redeclares `Dsymbol.ident` here and the ctor passes `null` to `super`, so an AliasAssign is anonymous:
     * reads through a `Dsymbol` reference (`isAnonymous()`, the `addMember` gate that keeps it out of the symbol
     * table, `hdrgen.toChars` printing `__anonymous`) see the null base `ident`. Reads through an `AliasAssign`
     * reference (aliasAssignSemantic, hdrgen visitAliasAssign, syntaxCopy) see this slot.
     */
    // shadow-split: D redeclares Dsymbol.ident; this is the DERIVED slot (02 §11.5b registry)
    identAssign: Identifier | null;
    type: Type | null;        /// replace previous RHS of AliasDeclaration with `type`
    aliassym: Dsymbol | null; /// replace previous RHS of AliasDeclaration with `aliassym`
                              /// only one of type and aliassym can be != null

    /// dmd/dsymbol.d:1516
    constructor(loc: Loc, ident: Identifier, type: Type | null, aliassym: Dsymbol | null) {
        super(DSYM.aliasAssign, loc, null);
        this.identAssign = ident;
        this.type = type;
        this.aliassym = aliassym;
    }

    /// dmd/dsymbol.d:1524
    override syntaxCopy(s: Dsymbol | null): AliasAssign {
        assert(!s);
        const aa = new AliasAssign(
            this.loc,
            this.identAssign!,
            this.type !== null ? this.type.syntaxCopy() : null,
            this.aliassym !== null ? this.aliassym.syntaxCopy(null) : null,
        );
        return aa;
    }

    /// dmd/dsymbol.d:1533
    override kind(): DString {
        return ds("alias assignment");
    }

    /// dmd/dsymbol.d:1538
    override accept(v: Visitor): void {
        v.visitAliasAssign(this);
    }
}

/***********************************************************
 * dmd/dsymbol.d:1547 — `extern (C++) final class DsymbolTable : RootObject`. Table of Dsymbol's.
 * The whole body is under `nothrow:` (erases, 04 §8).
 */
export class DsymbolTable extends RootObject {
    tab: AssocArray<Identifier, Dsymbol> = new AssocArray<Identifier, Dsymbol>();

    /***************************
    * dmd/dsymbol.d:1560 — Look up Identifier in symbol table.
    * Params:
    *   ident = identifer to look up
    * Returns:
    *   Dsymbol if found, null if not
    */
    lookup(ident: Identifier): Dsymbol | null {
        //printf("DsymbolTable::lookup(%s)\n", ident.toChars());
        return this.tab.get(ident); // `tab[ident]` -> AssocArray.get (null on a miss)
    }

    /**********
     * dmd/dsymbol.d:1572 — Replace existing symbol in symbol table with `s`. If it's not there,
     * add it.
     * Params:
     *   s = replacement symbol with same identifier
     *
     * `*tab.getLvalue(s.ident) = s;` — the get-slot-then-write-through idiom collapses to one `set`.
     */
    update(s: Dsymbol): void {
        this.tab.set(s.ident!, s);
    }

    /**************************
     * dmd/dsymbol.d:1584 — Insert Dsymbol in table.
     * Params:
     *   s = symbol to add
     * Returns:
     *   null if already in table, `s` if inserted
     *
     * The `insert` overload pair splits on the FIRST parameter's type (`Dsymbol` vs `Identifier`),
     * so it is Form B: this one keeps the bare name and the two-arg form is `insertByIdent`
     * (04 §1B); every call site is rewritten to the target D resolved statically.
     */
    insert(s: Dsymbol): Dsymbol | null {
        return this.insertByIdent(s.ident!, s);
    }

    /**************************
     * dmd/dsymbol.d:1597 — Insert Dsymbol in table.
     * Params:
     *   ident = identifier to serve as index
     *   s = symbol to add
     * Returns:
     *   null if already in table, `s` if inserted
     *
     * `Dsymbol* ps = tab.getLvalue(ident); if (*ps) return null; *ps = s;` — the slot-pointer idiom
     * collapses to a presence check plus a set.
     */
    insertByIdent(ident: Identifier, s: Dsymbol): Dsymbol | null {
        //printf("DsymbolTable.insert(this = %p, '%s')\n", this, s.ident.toChars());
        if (this.tab.get(ident) !== null) return null; // already in table
        this.tab.set(ident, s);
        return s;
    }

    /*****************
     * dmd/dsymbol.d:1611 — Returns: number of symbols in symbol table
     */
    length(): number {
        return this.tab.length;
    }
}

/**
 * dmd/dsymbol.d:1620 — `extern (C++) final class CAsmDeclaration : Dsymbol`.
 * ImportC global `asm` definition.
 */
export class CAsmDeclaration extends Dsymbol {
    code: Expression;

    /// dmd/dsymbol.d:1623
    constructor(e: Expression) {
        super(DSYM.cAsmDeclaration);
        this.code = e;
    }

    /// dmd/dsymbol.d:1629
    override accept(v: Visitor): void {
        v.visitCAsmDeclaration(this);
    }
}
