// Ported from dmd/dimport.d (module dmd.dimport) — "A `Dsymbol` representing a renamed import."
//
// Faithful structural 1:1 translation of the WHOLE D module (dimport.d, 148 lines): the single
// top-level declaration `final class Import : Dsymbol` with its 10 fields, the constructor (and
// its nested `selectIdent()` helper), `kind`, `visible`, `syntaxCopy`, `addPackageAccess` and
// `accept`.
//
// Module-wide translation notes (each is re-stated at its site):
//   * dropped: `version (none) { import core.stdc.stdio; printf(...); }` (dimport.d:65-75) —
//     `version(none)` is a built-in always-OFF (_config.md §3, 07 §1). The function-local
//     `core.stdc.stdio` import goes with it (01 Rule 3.7).
//   * `Identifier[] packages` is a raw D SLICE, not an `Array!Identifier`: its `.init` is `null`
//     (09 §1.0) and D really does pass null for it (`new Import(m.loc, null, Id.object, null, 0)`,
//     dsymbolsem.d:8409), so the port carries the SLICE's nullability — but not its elements'
//     (08 §3's uniform element-null rule governs the `arraytypes.d` aliases, not a raw slice; see
//     the field). Never a `.copy()` — a slice is a reference (02 §8, 03 §1 "non-copy points").
//   * `Visibility` is a VALUE struct (dsymbol.d:165): the field default-inits to `Visibility.init`
//     (03 §6.4), `visible()` returns a `.copy()` (03 §1 #3) and every by-value hand-off to
//     `addAccessiblePackage(Package, Visibility)` copies at the call site (03 §1 #2).
//   * dimport.d has ZERO `unittest` blocks, so dimport.test.ts is a 10 §1.6b thin test file:
//     the module-load smoke test plus behavior pins (9 of them — above §1.6b's canonical 1-3; see
//     that file's header).
//
// Cross-core types are imported with `import type` to break the 76-module SCC load cycle
// (01 §4.2/§4.5); `Dsymbol` / `DSYM` / `Visibility` are value imports because `class Import extends
// Dsymbol` needs the runtime base and the ctor constructs a `Visibility`.

import { Dsymbol, DSYM, Visibility } from "./dsymbol.js";
import { Array as DArray } from "./root/array.js";
import { ds } from "../dstring.js"; // value: the two `kind()` string literals
import { assert } from "../assert.js";

import type { ScopeDsymbol } from "./dsymbol.js";
import type { Identifier } from "./identifier.js";
import type { Loc } from "./location.js";
import type { Module, Package } from "./dmodule.js";
import type { AliasDeclaration } from "./declaration.js";
import type { Identifiers, AliasDeclarations } from "./arraytypes.js";
import type { DString } from "../dstring.js";
import type { Visitor } from "./visitor/index.js";

/**
 * dmd/dimport.d:45-60 — the `Import` constructor's nested `Identifier selectIdent()`: select the
 * Dsymbol identifier (bracketed in the comments below).
 *
 * 04 §5's canonical form for a nested function is an inner `const` arrow, which is NOT expressible
 * here: D calls `selectIdent()` from inside the `super(...)` argument list (dimport.d:62) and TS
 * forbids every statement — a local declaration included — before `super()`. The function is
 * therefore relocated verbatim (same D name, same three-way body) to module scope, non-exported,
 * taking the three ctor parameters it closed over. Module scope rather than a static method: D's
 * `Import` has no static members, and this keeps the class's member set 1:1 with the D class.
 * Reported to the integrator — 04 §5 does not yet cover the "nested function called inside a
 * `super(...)` argument list" shape.
 */
function selectIdent(packages: Identifier[] | null, id: Identifier | null,
                     aliasId: Identifier | null): Identifier | null {
    // select Dsymbol identifier (bracketed)
    if (aliasId !== null) {
        // import [aliasId] = std.stdio;
        return aliasId;
    }
    // `packages.length` on a D null slice is 0, so the null test is part of `> 0` (06 §2.8).
    if (packages !== null && packages.length > 0) {
        // import [std].stdio;
        return packages[0];
    }
    // import [id];
    return id;
}

/***********************************************************
 * dmd/dimport.d:23 — `extern (C++) final class Import : Dsymbol`. `final` erases (04 §8); the
 * `extern (C++)` linkage attribute erases too.
 *
 * The node shape of `static import aliasId = pkg1.pkg2.id : alias1 = name1, alias2 = name2;`.
 */
export class Import extends Dsymbol {
    /* static import aliasId = pkg1.pkg2.id : alias1 = name1, alias2 = name2;
     */
    // dmd/dimport.d:27 — `Identifier[] packages;`. A raw D slice (02 §8: reference, shares, never
    // copied), NOT an `arraytypes.d` `Array!T` alias — so 08 §3's uniform `Array<T | null>` element
    // rule does not reach it, and the element type is decided here.
    //   * SLICE nullable: the `.init` of a D slice is null (09 §1.0) and dsymbolsem.d:8409 really
    //     does construct an `Import` with a literal `null` here.
    //   * ELEMENTS non-null: no frontend site stores a null element, and every reader dereferences
    //     the element with no null test — hdrgen.d:1044, deps.d:195 and json.d:516 (the last inside
    //     `visit(Import s)`) all do `foreach (pid; imp.packages) pid.toString()`, and dimport.d:124
    //     walks `packages[1 .. $]` the same way (doc.d:1198/:2556 too). The whole slice is also handed
    //     to `Package.resolve` (dsymbolsem.d:8471) and `Module.load` (dsymbolsem.d:8497/:8536), whose
    //     ports take `Identifier[] | null`
    //     (dmodule.ts:235/:587) — a `(Identifier | null)[]` would not be assignable to either.
    // Null-vs-empty (06 §2.8) is unobservable for THIS field: `imp.packages` is never truthiness-
    // tested anywhere in the frontend (the `!md.packages` tests at parse.d:3428/:3435 are
    // `ModuleDeclaration.packages`, a different field), only `.length`ed, iterated, and passed on.
    packages: Identifier[] | null = null;           // array of Identifier's representing packages
    id: Identifier | null = null;                   // module Identifier
    aliasId: Identifier | null = null;
    isstatic = 0;                                   // !=0 if static import
    // dmd/dimport.d:31 — `Visibility visibility;` default-initializes to `Visibility.init`
    // (kind = the enum's FIRST member `undefined`, pkg = null) — 03 §6.4 / 09 §1.0. The ctor
    // overwrites it with `private_`.
    visibility: Visibility = new Visibility();

    // Pairs of alias=name to bind into current namespace.
    // dmd/dimport.d:34-35 — `Identifiers` is a VALUE struct (`Array!Identifier`) whose default-init
    // is an empty container (03 §6.4). Constructed AS the alias's element type (08 §3).
    names: Identifiers = new DArray<Identifier | null>();
    aliases: Identifiers = new DArray<Identifier | null>();

    mod: Module | null = null;                      // dmd/dimport.d:37 — class ref, nullable
    pkg: Package | null = null;                     // leftmost package/module

    // corresponding AliasDeclarations for alias=name pairs — value struct, empty container.
    aliasdecls: AliasDeclarations = new DArray<AliasDeclaration | null>();

    /**
     * dmd/dimport.d:43 — `extern (D) this(Loc loc, Identifier[] packages, Identifier id,
     * Identifier aliasId, int isstatic)`.
     *
     * Preconditions: `id` is non-null (asserted, as in D at :64).
     * `packages` is aliased, never copied — a D slice is a reference (02 §8).
     * `id` is typed nullable because the body null-TESTS it (the `assert`), per 02 §10.1.
     *
     * The nested `Identifier selectIdent()` (dimport.d:45-60) is relocated to the module-scope
     * `selectIdent` below — see the note on it.
     */
    constructor(loc: Loc, packages: Identifier[] | null, id: Identifier | null,
                aliasId: Identifier | null, isstatic: number) {
        super(DSYM.import_, loc, selectIdent(packages, id, aliasId)); // dimport.d:62

        assert(id !== null);                        // dimport.d:64 — `assert(id)` (nullable ref, 06 §2.7)
        // dropped: `version (none) { import core.stdc.stdio; printf("Import::Import(" ...); }`
        //          (dimport.d:65-75) — version(none) is always OFF (_config.md §3).
        this.packages = packages;
        this.id = id;
        this.aliasId = aliasId;
        this.isstatic = isstatic;
        // dimport.d:80 — `this.visibility = Visibility.Kind.private_;`. D implicitly constructs a
        // `Visibility` from the Kind through its one-argument ctor; the port spells that out. A
        // fresh rvalue, so no `.copy()` (03 §1 "plain construction").
        this.visibility = new Visibility(Visibility.Kind.private_); // default to private
    }

    /// dmd/dimport.d:83 — `override const(char)* kind() const`. Trailing `const` erases (04 §8).
    override kind(): DString {
        // `isstatic` is an `int` used as a condition — expanded per 06 §2.5.
        return this.isstatic !== 0 ? ds("static import") : ds("import"); // dimport.d:85
    }

    /**
     * dmd/dimport.d:88 — `override Visibility visible()`. All of `pure nothrow @nogc @safe` erase.
     *
     * Returns the value struct BY VALUE, so D hands the caller a copy (03 §1 #3). No elision:
     * `Visibility` is not an alias-safe-register type (03 §9.1) and the callers live outside this
     * file — they must not be able to mutate this node's `visibility` through the result.
     */
    override visible(): Visibility {
        return this.visibility.copy();              // dimport.d:90
    }

    /// copy only syntax trees — dmd/dimport.d:93-108.
    override syntaxCopy(s: Dsymbol | null): Import {
        assert(s === null);                         // dimport.d:96 — `assert(!s)` (06 §2.7)
        // `loc` is a `Loc` value struct passed by value; `Loc` is an alias-safe-register type
        // (03 §9.1), so the share needs no per-site justification — and the Dsymbol ctor copies it.
        const si = new Import(this.loc, this.packages, this.id, this.aliasId, this.isstatic);
        si.addComment(this.comment());              // dimport.d:98 — `si.addComment(comment)`
        // dimport.d:99 — both operands are integral counts; expanded per 06 §2.5.
        assert(!(this.isstatic !== 0 && this.names.length !== 0));
        // dimport.d:100 — `names.length` is a count (`!== 0`), `si.aliasId` a nullable class ref.
        if (this.names.length !== 0 && si.aliasId === null)
            si.ident = null;
        for (let i = 0; i < this.names.length; i++) {
            si.names.push(this.names.opIndex(i));   // `names[i]` -> opIndex (05 §7)
            si.aliases.push(this.aliases.opIndex(i));
        }
        return si;
    }

    /*******************************
     * dmd/dimport.d:116 — `extern (D) void addPackageAccess(ScopeDsymbol scopesym)`.
     *
     * Mark the imported packages as accessible from the current scope. This access check is
     * necessary when using FQN b/c we're using a single global package tree.
     * https://issues.dlang.org/show_bug.cgi?id=313
     */
    addPackageAccess(scopesym: ScopeDsymbol): void {
        //printf("Import::addPackageAccess('%s') %p\n", toPrettyChars(), this);
        // `packages.length` is 0 for a D null slice, so the null test is part of the `> 0` test.
        if (this.packages !== null && this.packages.length > 0) {
            // import a.b.c.d;
            // D reassigns `p` while walking the package chain; the port keeps the same name because
            // it is a real D local (`auto p = pkg;`), widened to nullable by the `p = sym.isPackage()`
            // store below. `pkg` is dereferenced unconditionally by D here — `!` marks that fault
            // point (02 §10.1).
            let p: Package | null = this.pkg;       // a
            // `addAccessiblePackage(Package, Visibility)` takes the Visibility BY VALUE -> copy at
            // the call site (03 §1 #2).
            scopesym.addAccessiblePackage(p!, this.visibility.copy());
            // `packages[1 .. $]` is a D slice VIEW; `.slice(1)` copies the element references into a
            // fresh array, which is observationally identical here (the loop only reads). — [b, c]
            for (const id of this.packages.slice(1)) {
                // `p` and `p.symtab` are dereferenced by D with no null test — `!` at each of D's
                // own two fault points (02 §10.1). The element `id` is only passed on, so it needs
                // none (same shape as the sibling loop at dmodule.ts:958).
                const sym: Dsymbol | null = p!.symtab!.lookup(id);
                // https://issues.dlang.org/show_bug.cgi?id=17991
                // An import of truly empty file/package can happen
                // https://issues.dlang.org/show_bug.cgi?id=20151
                // Package in the path conflicts with a module name
                if (sym === null)
                    break;
                // https://issues.dlang.org/show_bug.cgi?id=23327
                // Package conflicts with symbol of the same name
                p = sym.isPackage();
                if (p === null)
                    break;
                scopesym.addAccessiblePackage(p, this.visibility.copy());
            }
        }
        // dimport.d:141 — `scopesym.addAccessiblePackage(mod, visibility);`. D upcasts `Module` to
        // `Package` implicitly; in TS that upcast is blocked by the audited field shadow
        // `Module.errors: uint` over `Dsymbol.errors: bool` (dmodule.ts:173), so this is the
        // audited upcast cascade of 02 §11.5 — a typing artifact only, the object IS a Package.
        // `mod` is dereferenced by the callee (`p.tag`), so `!` marks D's own fault point.
        scopesym.addAccessiblePackage(this.mod! as unknown as Package, this.visibility.copy()); // d
    }

    /// dmd/dimport.d:144 — `accept` dispatches to this node's own named method (13 §2).
    override accept(v: Visitor): void {
        v.visitImport(this);
    }
}
