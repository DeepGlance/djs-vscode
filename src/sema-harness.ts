// Hand-written djs test harness (NOT a port of any dmd/ file): the compiler-startup state every
// sema-driver suite needs, plus the synthetic `object` module that stands in for druntime's
// object.d. Twelve suites ran a hand-copied version of this block; a harness change now costs one
// edit instead of twelve.
//
// Contract: 10-tests-diagnostics.md §1.5 owns the INIT ORDER and the reasons behind it. This file
// spells that order once for the sema suites; it does not replace §1.5 for harnesses that init
// only what they touch.

import "./dmd/parse.js";   // historical first import; dmd/loadorder.test.ts guards single-entry load tree-wide
import { Loc } from "./dmd/location.js";
import { initTokens } from "./dmd/tokens.js";
import { Id } from "./dmd/id.js";
import { Type_init } from "./dmd/typesem.js";
import { target } from "./dmd/target.js";
import { Objc } from "./dmd/objc.js";
import { ClassDeclaration } from "./dmd/dclass.js";
import { initImphint } from "./dmd/imphint.js";
import { Expression, IntegerExp } from "./dmd/expression.js";
import { ErrorSinkNull } from "./dmd/errorsink.js";
import { global } from "./dmd/globals.js";
import { Module } from "./dmd/dmodule.js";
import { Array as DArray } from "./dmd/root/array.js";
import type { Dsymbol } from "./dmd/dsymbol.js";
import type { FuncDeclaration } from "./dmd/func.js";
import type { Statement } from "./dmd/statement.js";
import { ds } from "./dstring.js";
import { initDtemplate } from "./dmd/dtemplate.js";

/**
 * Registers an empty module named `object` in `Module.modules`, and returns it.
 *
 * WHY IT EXISTS: `ImportAllVisitor.visitModule` (dmd/dsymbolsem.d:8400) injects an implicit
 * `import object;` into every module — an empty one included. In dmd that import resolves through
 * `Module.load()` -> `global.fileManager` -> druntime's `object.d` on disk. The sema suites are
 * hermetic: no druntime on disk, no file IO, no `fileManager`. Pre-registering the name short-
 * circuits the disk without bending the port, because `load()` looks the module table up FIRST
 * (`dst.lookup(imp.id)`, dsymbolsem.d:8481, over the table `Package.resolve` returns) and only
 * falls through to `Module.load()` when that lookup misses.
 *
 * WHAT IT IS NOT: druntime. The module is EMPTY, so anything a test does that genuinely needs
 * `Object`, `TypeInfo` or the other object.d declarations fails as "undefined identifier" — which
 * is the honest answer for a harness with no druntime, not a wall to fill.
 *
 * Preconditions, each of which has cost a debugging cycle:
 *  - call AFTER `Id.initialize()`: `Id.object` is null until then, and a module registered under a
 *    null ident is unfindable (`DsymbolTable.insert` keys on it).
 *  - call AFTER `Module._init()`: `Module.modules` is the table being inserted into.
 * The non-null empty `members` is load-bearing for the same reason: `importAll` recurses into the
 * module it just resolved and dereferences `m.members` with no null check (dsymbolsem.d:8405).
 */
export function registerSyntheticObjectModule(): Module {
    const m = new Module(Loc.initial, ds("object.d"), Id.object, 0, 0);
    m.members = new DArray<Dsymbol | null>();
    Module.modules!.insert(m as unknown as Dsymbol);   // upcast: Module.errors (uint) shadows Dsymbol.errors (bool)
    return m;
}

/**
 * The `beforeEach` body of every suite that drives `runSemantic`.
 *
 * Resets the process-global compiler tables D's unittest runner would rebuild per run (10 §1.5
 * "Invariant"), in the order 10 §1.5 fixes — `initTokens` before `Id.initialize`, because every
 * `Id.*` singleton interns through the table `initTokens` creates. `Module._init()` sits where
 * dmd's startup puts it (main.d:443, after `Id.initialize()`), and the synthetic `object` module
 * follows it.
 *
 * The error sink is `ErrorSinkNull`: hermetic, while `global.errors` stays the running count the
 * suites assert on. Suites that need the message TEXT install their own diagnostic handler after
 * this call — that is the one part deliberately left per-suite.
 */
export function initSemaHarness(): void {
    Loc._init();
    initTokens();
    Id.initialize();
    Type_init();
    target._resetVaListCache(); // va_listType caches a type built over Type.tchar (01 §5.5 rule 3)
    initImphint();      // imphint.d's `shared static this()` (01 §5.1) — the not-found tail reads its table
    Module._init();     // main.d:443 — `modules = new DsymbolTable()`; Package.resolve needs it
    Expression._init(); // main.d:444 — the CTFEExp singletons UnionExp.copy() returns for a cantexp fold
    Objc._init();       // main.d:445 — installs the Objective-C implementation target.objc selects (Supported)
    registerSyntheticObjectModule();
    // Process-static class singletons a suite sets by declaring `Object`/`Throwable`/… (dclass.d); D's process
    // starts with them null, so a leftover would push later suites onto the exception paths.
    ClassDeclaration.object = null;
    ClassDeclaration.throwable = null;
    ClassDeclaration.exception = null;
    ClassDeclaration.errorException = null;
    IntegerExp._resetLiteralCache();
    global.errorSink = new ErrorSinkNull();
    global.errors = 0;
    global.gag = 0;
    // The deferred-semantic queues are process-static (Module.deferred/2/3). Reset them so one
    // test's leftover deferrals cannot leak into the next.
    Module.deferred.setDim(0);
    Module.deferred2.setDim(0);
    Module.deferred3.setDim(0);
    initDtemplate(); // port-only (01 §4.1 lazy TypeDeduced), LAST (10 §1.5): template deduction needs it
}

/**
 * The members the source actually declared.
 *
 * Pass 0 prepends an implicit `import object;` to every module (dmd/dsymbolsem.d:8400-8410), so
 * after `runSemantic` the first declaration the source wrote sits at `members[1]`. This drops that
 * import, letting a test index what it wrote. A source that opens with an explicit `import object;`
 * is indistinguishable from the injected one — dmd does not add a second, and this drops the one
 * that is there; no sema suite writes that import.
 *
 * Only meaningful AFTER pass 0: on a parse-only module it returns the members unchanged.
 */
export function sourceMembers(m: Module): Dsymbol[] {
    const all: Dsymbol[] = [];
    for (let i = 0; i < m.members!.length; i++)
        all.push(m.members!.opIndex(i)!);
    const first = all[0];
    if (first !== undefined && first.isImport() !== null && first.ident === Id.object)
        all.shift();
    return all;
}

/**
 * The body the source wrote for `fd`, as statement sema left it.
 *
 * semantic3 never stores the analysed body bare: it collects the statements it emits (contracts, `out`
 * parameter inits, `_arguments`, the body itself, the return label, `return 0;`) into `a`
 * (dmd/semantic3.d:1189 — `a.push(funcdecl.fbody)`), wraps them in ONE fresh CompoundStatement
 * (semantic3.d:1240) and assigns that to `fbody` (semantic3.d:1320). For a plain function with none of
 * the extras, `a` holds the body alone, so post-sema `fbody` is `CompoundStatement([body])`. `-vcg-ast`
 * does not show the level: hdrgen prints a CompoundStatement without braces.
 *
 * `body` itself keeps the shape compoundStatementSemantic gave it: a ONE-statement body is that lone
 * statement (dmd/statementsem.d:452-456), a longer one is a CompoundStatement.
 *
 * Precondition: `fd` reached semantic3done and has no contracts, no `out` parameters, no variadic
 * `_arguments`, and is not a `main` that gains `return 0;`. The wrapper is asserted to hold exactly one
 * statement, so a caller that breaks the precondition fails here instead of reading the wrong node.
 */
export function userBody(fd: FuncDeclaration): Statement {
    const wrapper = fd.fbody!.isCompoundStatement();
    if (wrapper === null || wrapper.statements!.length !== 1)
        throw new Error("userBody: fbody is not semantic3's one-statement merge wrapper (dmd/semantic3.d:1240)");
    return wrapper.statements!.opIndex(0)!;
}
