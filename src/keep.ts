// The kept-module engine: keeps parsed and analysed modules and template instances between in-process
// compiles of the same command line, so that an editor's save re-analyses only what the edit invalidates.
//
// Hand-written djs module, NOT a port of a dmd/ file. The host contract is 10 §4.7 ("The kept-module engine");
// the entry is `djsMainKept` in src/djs.ts, which calls `keepCompile` with the driver's part of a compile
// (`KeepHost`). The hooks in the dmd/ files call the exported functions of the later sections, each guarded by
// `K.on`, which is false outside a kept-capable compile: with the engine off every hook is one property read.
//
// THE MODEL. A UNIT is a piece of frontend work that D runs once and skips when requested again, each guarded
// by a state field of its owner:
//   - per module: its importAll (dmd/dsymbolsem.d:8379, guard `_scope`), semantic1 (dmd/dsymbolsem.d:3847), semantic2
//     (dmd/semantic2.d:365) and semantic3 (dmd/semantic3.d:204), guard `semanticRun`; under `-i` a compiled import's
//     semantic3 (dmd/main.d:753-764) too, whose role (a root) its registration gives it, as its parse would;
//   - per template instance (not a TemplateMixin, which is not cached): its creation (dmd/templatesem.d:1183-1324,
//     from the module append to the members' semantic1, guard: the instance table), its semantic2
//     (dmd/semantic2.d:126) and semantic3 (dmd/semantic3.d:111), guard `semanticRun`;
//   - per function: its semantic3 (dmd/semantic3.d:236, guard `semanticRun`, reached by `functionSemantic3`
//     (dmd/funcsem.d:1614), inference, CTFE and the TypeInfo members; inference also reads the return type, which
//     the shadow state does not take back: `keepInfers` stands for it);
//   - per alias of a non-root module: its analysis, which dmd/dsymbolsem.d:2127 leaves to the alias's first use
//     (`toAlias`, dmd/dsymbolsem.d:1508, guard `semanticRun`), wherever that use is; its shadow state also takes back
//     `overnext`, the overloads its analysis moves into the aliasee (`aliasNext`);
//   - per AA type's TypeInfo declaration: its semantic3 (dmd/semantic3.d:1662, guard `semanticRun`), run from the
//     end-of-compile semantic3 list; it reads the scope of the request that created the declaration and its type's
//     `loc`, and recorded with others it runs for real. The creation (dmd/typinf.d:177-191, guard: the naked type's
//     `vtinfo`) is a request event: before each kept compile the AA types' `vtinfo` and the declarations' scope are
//     emptied, and the first request, replayed or live, redoes the creation on the kept declaration, reused (the
//     `vtinfo`, the scope, the deferral), as instances get creation emulation. The type's `loc` is the type table
//     entry's, which a fresh compile takes from the type's first merge in the compile: the first merge of a kept AA
//     entry in each compile, live or replayed, sets it (`aaLoc`), also where the merge returns early, a type merged
//     already (`keepMergedAA`).
// While a unit runs for real, the engine keeps a stack of active units (FRAMES) and appends EVENTS to the innermost
// unit's LOG: every request of another unit (first or not, deduplicated per log; an instance request carries the
// creation fields it gives), every call into the reporting layer (with a snapshot of its arguments and the gag level),
// every instantiation trace (the call, re-rendered at replay from the instance's current chain), the
// generated-identifier numbers consumed, every raw write to stdout/stderr, every change to the module tree (package
// table inserts, package.d wrappers, the module list, `importedFrom`), the deferred symbols (Module.deferred) each
// request saw, every instance whose semantic3 joined an outer instance's deferred list, every symbol given to the
// end-of-compile lists of semantic2/semantic3 (Module.deferred2/3), every request of an AA type's TypeInfo, the `minst`
// an AA TypeInfo's semantic3 sets on the instances it made, and its first merge of each AA type table entry, with the
// merging type's `loc`. It also notes what the unit's result depends on outside the logs: the files its string imports
// found (or that none was found), the module imports that found no file, the clock (__DATE__ in a mixin) and the
// working directory (__FILE_FULL_PATH__); the generated-identifier counter at its entry, against which the names in its
// AST were numbered, and the generated identifiers it made, in the order of its counts (`keepGenerated`: the AST view
// of src/query.ts spells them as a fresh compile numbers them, `keepGeneratedNames`); the type table entries it creates
// over a non-canonical type (`keepType`); the C aggregates whose size it finalized (`keepSized`); and the symbols of
// another container it marked with errors (`keepForeignErrors`). A module that another module's name uses as its
// package (`module a.b;` with an `a.d`, an error) lends its symbol table to the module tree: the next kept compile
// drops the tree's entries from it, and the use puts them back (`keepModuleAsPackage`). An aggregate's RTInfo made
// outside every unit (the end-of-compile semantic3 of a library struct) is emptied before the next kept compile, whose
// run instantiates `RTInfo!T` again (`keepRTInfo`).
// In the next compile of the same command line, every kept unit's owner starts in the state its guard had
// before the unit ran (its SHADOW state), so every caller that would run the unit in a fresh compile reaches the
// guard again; there the first request REPLAYS the log instead of running the unit: each request event replays
// the requested unit if it is not yet requested in this compile, each report calls the same reporting function
// under the gag level the recording had relative to the unit's entry (so counters, limits, handlers and printing
// follow fresh semantics), each trace calls `printInstantiationTrace` on the live instance, each counter delta is
// added, each tree change and deferral is redone. A second request in the same compile does nothing, as in a
// fresh compile. A replay checks what its log depends on: the gag at its entry (zero or not), an instance's
// `gagged`, `-de`, the deferred symbols, a cycle entered from the other side, the generated-identifier counter;
// where it differs and the unit prints something it would change, the compile aborts (ABORT).
// Template instances get CREATION EMULATION: a kept instance's first request in a compile sets its creation
// fields from that request (loc, tinst, minst, gagged, the members' scope minst), appends it to its module as the
// creation path does, and replays its creation log; for a live request the rest of the creation path
// (semantic2/semantic3, which depend on the requesting scope) runs for real on the kept instance (templatesem.ts,
// `keptCreate`), for a replayed one its events follow in the requester's log. Module semantic2/semantic3 replay
// the part of their member loop over the parsed members and run the loop over the instances appended in this
// compile for real (the TAIL), since those depend on what this compile instantiated.
//
// THE DEAD SET (keepPlan). Before a kept compile the engine drops every unit whose replay would not be what a fresh
// compile does: the modules whose file changed (re-resolved through the import paths, stat, then content; a C module
// preprocessed again; a file the host overrides with a text, `DjsOptions.texts`, by the text's bytes against the
// module's `src`; a module read from an override by its bytes at every compile until it is parsed again, its record
// matching no stat: one read of the file per compile), whose role changed (root <-> imported), whose parse reported or
// read the clock, the containers whose symbol a unit of another container marked with errors (a fresh compile starts
// without the mark), the units whose string imports now find another file or other bytes, whose failed module imports
// now find a module, that read the clock, or the working directory when it changed, that reported an error ungagged,
// that reported a location in a dead file, and, to a fixpoint, every unit that requested a dead unit (a dead unit kills
// its whole owner module or instance: an analysed body cannot be un-analysed), every instance over a dead symbol
// (template, enclosing scope, argument), every AA TypeInfo declaration over one (key and value types, object.d's
// TypeInfo_AssociativeArray) or whose semantic3 ran from a dead scope (the requesting code's module, instance and root
// module: the scope must not keep them alive), every unit entered from a dead module's scope (`callsc`), every module
// whose analysis took the C types of a dead module (`keepMergeFound`: they are the dead module's declarations), every
// module whose C types a dead module's analysis read before their size was final (the kept declarations hold the final
// field lists), the instances no kept unit requests and no recent compile did, and the instances being matched that
// hold a unit (`F_EARLY`) no kept unit requests; then every AA TypeInfo declaration whose type left the table through
// an entry a dead unit created (`keepType`). Dead objects leave the engine, the instance tables, the type table (with
// the entries of `keepType`), the Loc file table, the generated-name counters and the CTFE global values; a dead AA
// TypeInfo declaration whose type stays in the table is not replaced, its semantic3 runs for real again on it. A C
// module whose preprocessor writes anything makes the compile fresh: a fresh compile's run writes it to the inherited
// stderr.
//
// ABORT. A kept compile buffers stdout, stderr and the diagnostic handler's calls and releases them at its end. Any
// invariant violation found while replaying (see above; also a request of an instance's semantic2/3 or of a deferral of
// a symbol not created or kept in this compile, of a function's semantic3 in an instance not created in this compile
// unless the function ran before the instance had a creation (`F_EARLY`, a constraint's lambda), a request that created
// an instance when recorded and matches it now or the reverse, where the instance's pending semantic2/3 prints, a C
// type merged into the table entry of a module not loaded or loaded after its own, or a module that took another's C
// types loaded without it (`keepMergeFound`), a merge reading a kept C aggregate whose size the unit that finalized it
// has not yet run or replayed in this compile, or no unit finalized, a module tree conflict, a kept module used as a
// package whose symbol table is not a fresh compile's there, or whose importAll replays without the use that made its
// table (`keepModuleAsPackage`), a request of an AA TypeInfo declaration not kept or first requested without a scope,
// or of its semantic3 from a unit, a lookup into a kept module before its semantic, a new module named as a kept one, a
// C preprocessor run that writes) throws `KeepAbort`, and so does any crash in a kept compile: `keepCompile` drops the
// kept state and compiles fresh, reporting the reason. Two differences go on on purpose, since they change nothing
// printed: a request found in another state than recorded (an import cycle entered from the other side) where neither
// unit nor what it requests prints, which then goes as a fresh compile's (the pending unit replays, the running one
// does not); and a replay under another gag state whose log prints nothing that the gag would change.
//
// This file imports no dmd/ module (only `import type`): the dmd/ files import it, and a runtime import would
// change the load order of the frontend graph (01 §4.5). The frontend functions it calls are bound by djs.ts
// (`keepBind`).

import { statSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { DString } from "./dstring.js";
import type { Module, Package } from "./dmd/dmodule.js";
import type { Dsymbol, DsymbolTable, ScopeDsymbol } from "./dmd/dsymbol.js";
import type { TemplateInstance, TemplateDeclaration } from "./dmd/dtemplate.js";
import type { FuncDeclaration } from "./dmd/func.js";
import type { AliasDeclaration, TypeInfoDeclaration } from "./dmd/declaration.js";
import type { Scope } from "./dmd/dscope.js";
import type { AggregateDeclaration } from "./dmd/aggregate.js";
import type { Identifier } from "./dmd/identifier.js";
import type { Loc, SourceLoc } from "./dmd/location.js";
import type { Global } from "./dmd/globals.js";
import type { DiagnosticHandler } from "./dmd/errors.js";
import type {
    Type, TypeAArray, TypeClass, TypeEnum, TypeFunction, TypeInstance, TypeNext, TypeStruct, TypeTuple, TypeVector,
} from "./dmd/mtype.js";
import type {
    ArrayLiteralExp, AssocArrayLiteralExp, BinExp, ClassReferenceExp, DotTypeExp, DsymbolExp, FuncExp, ScopeExp,
    StructLiteralExp, SymbolExp, TemplateExp, ThisExp, TupleExp, UnaExp,
} from "./dmd/expression.js";
import type { TemplateInstanceTable } from "./dmd/templatesem.js";

/** Field names read reflectively, each checked by tsc against the class that has it (a rename fails to compile). */
type Fields<T, K extends keyof T> = K;
/** The fields of the Type classes that the dead set reads: the symbols and types a type is built over. */
type TypeField = Fields<TypeStruct | TypeEnum | TypeClass, "sym"> | Fields<TypeNext, "next">
    | Fields<TypeAArray, "index"> | Fields<TypeVector, "basetype"> | Fields<TypeFunction, "parameterList">
    | Fields<TypeTuple, "arguments"> | Fields<TypeInstance, "tempinst">;
/** The fields of the expressions a template argument can be that name a symbol, a subexpression or a list. */
type ExpField = Fields<SymbolExp | ThisExp, "var_"> | Fields<FuncExp | TemplateExp, "fd" | "td">
    | Fields<ScopeExp, "sds"> | Fields<DsymbolExp, "s"> | Fields<UnaExp | BinExp, "e1"> | Fields<BinExp, "e2">
    | Fields<DotTypeExp, "sym"> | Fields<ArrayLiteralExp, "elements" | "basis">
    | Fields<AssocArrayLiteralExp, "keys" | "values"> | Fields<StructLiteralExp, "elements">
    | Fields<TupleExp, "exps" | "e0"> | Fields<ClassReferenceExp, "value">;
const EXP_FIELDS: readonly ExpField[] = ["var_", "fd", "td", "sds", "s", "e1", "e2", "sym", "elements", "basis", "keys",
    "values", "exps", "e0", "value"];
/** The ExpFields that hold a list of expressions. */
const LIST_FIELDS: Partial<Record<ExpField, true>> = { elements: true, keys: true, values: true, exps: true };

// ── the unit kinds and the per-compile switch ──────────────────────────────────────────────────────────────

/** The kinds of unit (see THE MODEL). The numbering is the order of a module's and an instance's passes. */
export enum KeepUnit { importAll, sem1, sem2, sem3, inst, isem2, isem3, fsem3, alias, tinfo }

/**
 * The engine's switch, read by every hook: `on` during a compile run by `djsMainKept` (recording, and replaying
 * when kept), false otherwise (`djsMain`, the CLI, the tests): then no hook does anything. `kept` is true when
 * the compile replays kept units: the driver then skips the inits that would replace the kept tables.
 */
export const K = { on: false, kept: false };

/** Thrown when the kept state is proven wrong during a kept compile; `djsMainKept` then compiles fresh. */
export class KeepAbort extends Error {
    constructor(readonly reason: string) {
        super(`kept compile aborted: ${reason}`);
        this.name = "KeepAbort";
    }
}

/**
 * The frontend functions and statics the engine calls, bound once by src/djs.ts (this file imports no dmd/
 * module, see the header). Each is the D entity named in its comment.
 */
export interface KeepBindings {
    global: Global;
    /** dmd/dmodule.d:285-290 statics: `modules`, `amodules`, `deferred`, `rootModule`. */
    Module: typeof Module;
    /** dmd/errors.d:472 / :600 — the reporting workers, called by a replayed report. */
    report(supplemental: boolean, loc: SourceLoc, format: DString, ap: readonly unknown[], kind: number,
        p1: DString | null, p2: DString | null): void;
    /** dmd/dtemplate.d:940 */
    printInstantiationTrace(ti: TemplateInstance, cl: number, maxShown: number): void;
    /** dmd/templatesem.d:1083 InstMemberWalker: every member's `_scope.minst` becomes `ti.minst`. */
    walkInstanceScopes(ti: TemplateInstance): void;
    /** dmd/templatesem.d:1745 `appendToModuleMember`. */
    appendToModuleMember(ti: TemplateInstance): void;
    /** templatesem.ts `keptInstanceMatch`: the match path of dmd/templatesem.d:1015-1158 for a replayed request. */
    instanceMatch(ti: TemplateInstance, minst: Module | null, tinst: TemplateInstance | null, gagged: boolean): void;
    /** templatesem.ts `deferSemantic3` (dmd/templatesem.d:1548-1574). */
    deferSemantic3(ti: TemplateInstance): void;
    /** dmd/semantic2.d:365 / dmd/semantic3.d:204 entry points (`mod.semantic2(null)`), for a replayed module pass. */
    semantic2(m: Module): void;
    semantic3(m: Module): void;
    /** dmd/identifier.d:199 `newSuffix`'s counter, and the generateIdWithLoc counters (dmd/identifier.d:257). */
    suffixCounter(n?: number): number;
    /** dinterpret.ts `keepDropCtfeGlobals`: empties the CTFE global values of the variables no longer kept. */
    dropCtfeGlobals(kept: (v: Dsymbol) => boolean): void;
    /** Drops the generateIdWithLoc counters keyed by a dead file or by a parent object no longer kept. */
    purgeLocCounters(deadFile: (filename: string) => boolean, kept: (parent: object) => boolean): void;
    /** dmd/location.d:584 the Loc file table: drop the entries of dead files. */
    purgeLocFiles(deadFile: (filename: string) => boolean): void;
    /** dmd/dmodule.d:505-509 `Module.find(getFilename(packages, ident))` through a fresh FileManager. */
    resolveModule(packages: readonly Identifier[], ident: Identifier): string | null;
    /** dmd/expressionsem.d:9471 `FileName.searchPath(global.filePath, name, false)`: a string import's file. */
    searchStringImport(name: DString): string | null;
    /** dmd/dsymbolsem.d:737 / :747 `addDeferredSemantic2` / `addDeferredSemantic3`, for a replayed deferral. */
    addDeferred(s: Dsymbol, pass: 2 | 3): void;
    /**
     * dmd/dmodule.d:783-787 `checkCompiledImport`, which a parse runs: under `-i` a module the patterns include is
     * pushed on `compiledImports` (dmd/compiler.d:140-153) and becomes a root (`importedFrom` is itself).
     */
    checkCompiledImport(m: Module): void;
    /**
     * The object.d declarations the frontend remembers in statics when it parses or analyses object.d
     * (dmd/mtype.d:473-494 `Type.dtypeinfo` ..., dmd/dclass.d:100-108 `ClassDeclaration.object` ...,
     * dmd/dstruct.d:47-48, dmd/dmodule.d:308): read them all, or (with `v`) write them all, in one fixed order.
     */
    objectStatics(v?: (Dsymbol | null)[]): (Dsymbol | null)[];
    /** cpreprocessor.ts `preprocessForKeep`: a C file's `.i` text now (or null), and whether cc wrote anything. */
    preprocess(path: string): { text: Uint8Array | null; printed: boolean };
    /** A fresh `AssocArray` for a cleared `DsymbolTable.tab` (the table object itself is kept). */
    clearTable(t: DsymbolTable): void;
    /** dmd/mtype.d:499 `Type.stringtable`, iterated and purged. */
    typeTable(): Map<string, { value: Type | null }>;
    DYNCAST: { expression: number; dsymbol: number; type: number; tuple: number };
    PASS: { initial: number; semantic: number; semanticdone: number; semantic2: number; semantic2done: number;
        semantic3: number; semantic3done: number };
    PKG: { unknown: number; module_: number; package_: number };
    Sizeok: { done: number };
    /** dmd/astenums.d `TY.Taarray`. */
    Taarray: number;
    ErrorKind: { warning: number; deprecation: number; error: number };
    DiagnosticReporting: { error: number };
}

let B: KeepBindings | null = null;

/** Binds the frontend for the engine; called once by src/djs.ts at load. */
export function keepBind(b: KeepBindings): void {
    B = b;
}

// ── records ────────────────────────────────────────────────────────────────────────────────────────────────

const OP_REQ = 1, OP_REQI = 2, OP_REP = 3, OP_TRACE = 4, OP_CNT = 5, OP_WRITE = 6, OP_TREE = 7, OP_PKG = 8,
    OP_AMOD = 9, OP_IFROM = 10, OP_DEFS = 11, OP_TIDEFER = 12, OP_DEFER = 13, OP_TINFO = 14, OP_MINST = 15,
    OP_AALOC = 16, OP_APPEND = 17;

const F_ERROR = 1;          // an error-class report was not gagged (it printed, or counts in the exit status)
const F_DEFERS = 2;         // the unit defers symbols (addDeferredSemantic) or retries them (runDeferredSemantic)
const F_OBS = 4;            // the log holds a write, a trace, or a report not gagged by the unit's own window
const F_GEN = 8;            // a printed report or write names what looks like a generated identifier (`__r3`)
const F_CLOCK = 16;         // the unit lexed __DATE__/__TIME__/__TIMESTAMP__ (a mixin): its AST holds that clock
const F_CWD = 32;           // the unit made a path absolute against the working directory (__FILE_FULL_PATH__)
const F_EARLY = 64;         // a function's semantic3 that ran before its instance had a creation (see `keepRun`)
const F_NOREPLAY = F_ERROR;

/**
 * A generated identifier a unit or a parse made (`keepGenerated`): the identifier, interned, the length of its prefix,
 * and the number it took from `newSuffix`'s counter, which follows the prefix.
 */
type GenId = [Identifier, number, number];

/** What a generated identifier looks like in printed text (dmd/identifier.d:177-210 `generateId` prefixes). */
const GENERATED = /(?:__\w*?|Tuple|thr)\d/;

/** One unit: its owner, its log and what its replay checks. See THE MODEL in the header. */
interface UnitRec {
    owner: object;
    kind: KeepUnit;
    log: unknown[];
    flags: number;
    e: number;              // global.gag at entry
    gagged: boolean;        // the owner instance's `gagged` at entry (instance units)
    dep: number;            // global.params.useDeprecated at entry
    pre: number;            // the owner's guard value before the unit (semanticRun)
    post: number;           // ... and after it
    errPre: number;         // an instance owner's `errors` before the unit (1), see `errFlags`
    errPost: number;        // ... and after it
    defIn: Dsymbol[] | null;    // Module.deferred at entry (F_DEFERS units; null: empty)
    defOut: Dsymbol[] | null;   // ... and at exit
    c0: number;             // the generated-identifier counter at entry (`newSuffix`)
    ids: GenId[];           // the generated identifiers it made, numbered from `c0` (`keepGenerated`), in the order
                            // of the log's OP_CNT segments
    born: number;           // the compile that ran it (a later one replays it)
    infers: boolean;        // a function's semantic3 that infers its return type (see `keepInfers`)
    gen: number;            // the compile in which `st` holds
    st: number;             // 0 pending, 1 running, 2 done (in compile `gen`)
    deps: Set<UnitRec>;     // the units whose logs request this one
    files: FileDep[] | null;
    strings: string[] | null;   // the strings it made that look like they name a generated identifier (`keepString`)
    misses: ModuleMiss[] | null;
    types: Type[] | null;       // the Type.stringtable entries it created over a non-canonical type (`keepType`)
}

/** A string import (`import("name")`): what the `-J` search found (null: nothing), and the file read. */
interface FileDep {
    name: DString;
    resolved: string | null;
    size: number;
    mtime: number;
    hash: string | null;    // null: not read (the read failed, an error the unit reported)
}

/** A module import that found no file (dmd/dmodule.d:508 and :519): a module appearing there changes the unit. */
interface ModuleMiss {
    packages: Identifier[];
    ident: Identifier;
}

/** A kept module: how it was found, what it was, and its part of the per-compile reset. */
interface ModRec {
    m: Module;
    path: string;                       // the resolved source path (Module.srcfile)
    packages: Identifier[] | null;      // the import name it was loaded by (null: a root)
    ident: Identifier | null;
    root: boolean;
    size: number;                       // -1: read from a host's text override (`Module.djsTextOf`)
    mtime: number;
    baseLen: number;                    // members after importAll: the parsed members (+ `import object`)
    scope: unknown;                     // `_scope` as its importAll unit's run left it, restored by its replay
    regGen: number;                     // the compile that registered it
    statics: Map<number, Dsymbol>;      // the object.d statics it set (`objectStatics` index -> value)
    parseIds: GenId[];                  // the generated identifiers its parse made (`keepParse`, `keepGenerated`)
    parseAt: number;                    // ... numbered from this counter value
    parseGen: number;                   // the compile that parsed it
    parseLive: number;                  // the counter where the registration of compile `regGen` numbered them
    parseReported: boolean;             // its parse called the reporting layer (`keepParse`)
    clock: boolean;                     // its lexer expanded __DATE__, __TIME__ or __TIMESTAMP__ (`keepClock`)
    asPackage: "resolve" | "importAll" | null;  // used as a package (`keepModuleAsPackage`): who made its table
    asPackageGen: number;               // ... and the last compile that used it so
}

interface Frame {
    u: UnitRec | null;      // null for a tail frame
    replay: boolean;
    win: number;            // gag windows opened inside the unit and not closed
    seen: Set<unknown> | null;
    locs: Set<Type> | null; // the AA type table entries whose merge the log has recorded (`aaLoc`)
    ids: GenId[];           // the generated identifiers made since the last event (`keepGenerated`)
    idsAt: number;          // ... numbered from this counter value
    def: Dsymbol[] | null;  // Module.deferred as this unit's log last knew it
}

function newFrame(u: UnitRec | null, replay: boolean): Frame {
    return { u, replay, win: 0, seen: null, locs: null, ids: [], idsAt: 0, def: u === null ? null : u.defIn };
}

const unitsOf = new Map<object, (UnitRec | undefined)[]>();
/**
 * An alias unit's `overnext` before and after its run, for an alias that had one at entry: the overloads that
 * addMember gave the unanalysed alias (dmd/dsymbolsem.d:1096-1100), which its analysis moves into the aliasee
 * (dmd/dsymbolsem.d:6695-6700). Part of its shadow state: `mostVisibleOverload` reads a pending alias's overloads
 * there (dmd/access.d:341-343), so a lookup through the alias finds its public overloads as in a fresh compile.
 */
const aliasNext = new WeakMap<UnitRec, { pre: Dsymbol; post: Dsymbol | null }>();
const mods = new Map<Module, ModRec>();
const modsByKey = new Map<string, ModRec>();
const fileUnits = new Map<string, Set<UnitRec>>();
const tds = new Set<TemplateDeclaration>();
const dormantPkgs = new Map<DsymbolTable, Map<Identifier, Package>>();
const pkgs = new Set<Package>();
let stack: Frame[] = [];
let compileNo = 0;
let kept = false;                   // the current compile replays kept units
let stateKey: string | null = null; // the command line the kept state belongs to
let stateOptions = "";              // the host options of the compile that left it (`KeepHost.options`)
let stateCwd = "";                  // the working directory of the compile that left it (see F_CWD)
let stateUnclean = "";              // why the kept state cannot be used ("" when it can)
let pendingLoad: { packages: Identifier[] | null; ident: Identifier; path: string } | null = null;
/**
 * The parse running now (`keepParse`): the counter at its start, the generated identifiers it consumed, whether it
 * reported and whether its lexer read the clock; or null.
 */
let parsing: { at: number; ids: GenId[]; reported: boolean; clock: boolean } | null = null;
/** The symbols given to addDeferredSemantic2/3 in this compile: their flags are cleared before the next one. */
const deferredSyms = new Set<Dsymbol>();
/**
 * In this compile, a replayed unit or registered parse that consumed generated identifiers started at another
 * counter value than when it was recorded: the names in its AST are not those a fresh compile gives (see `F_GEN`).
 */
let shifted = false;
/**
 * The units replayed in this compile that consumed generated identifiers: per OP_CNT segment of the log, the counter
 * where the replay numbered it and its length (`keepGeneratedNames`).
 */
const replayStarts = new Map<UnitRec, number[]>();
/** In this compile, a replayed segment or parse numbered its generated identifiers otherwise than when recorded. */
let renumbered = false;
/**
 * The first unit replayed in this compile that printed what looks like a generated name (F_GEN): a shift found after
 * its replay makes the compile fresh at its end (`generatedWrong`).
 */
let genReplayed: UnitRec | null = null;
/**
 * The strings this compile made, by a unit that ran or replayed or outside every unit, that look like they name a
 * generated identifier (`keepString`): one naming an identifier this compile numbered otherwise makes the compile
 * fresh at its end (`generatedWrong`).
 */
let madeStrings: string[] = [];
/** The members a unit's analysis appended to a module, logged as OP_APPEND (`keepAppend`). */
const appendLogged = new WeakSet<Dsymbol>();
/** The containers whose symbol a unit of another container marked with errors (`keepForeignErrors`). */
const errorMarked = new Set<Container>();
/**
 * The modules `m` whose analysis took the type of a declaration of module `w`, and whether it read one of them before
 * its size was final (`keepMergeFound`).
 */
const cShares: { m: Module; w: Module; early: boolean }[] = [];
/** The AA types' TypeInfo declarations (dmd/typinf.d:185), by their naked type (`keepTypeInfoDecl`). */
const tinfos = new Map<Type, TypeInfoDeclaration>();
/** The type table entries whose `vtinfo` is one of them (`keepTypeInfo`), emptied before each kept compile. */
const tinfoTypes = new Set<Type>();
/**
 * A TypeInfo declaration's semantic3 unit: at its entry, `_scope` (the scope of the request that created the
 * declaration) and its type's `loc` (`aaLoc`), what the semantic3 reads of this compile (dmd/semantic3.d:1669-1670).
 */
const tinfoRecs = new WeakMap<UnitRec, { scope: Scope | null; loc: Loc }>();
/** The aggregates whose RTInfo was made outside every unit (`keepRTInfo`), made again in the next compile. */
const rtinfoTop = new Set<AggregateDeclaration>();
/** The unit that finalized a C aggregate's size (`keepSized`; null: no unit recorded), for `keepMergeFound`. */
const sizers = new WeakMap<Dsymbol, UnitRec | null>();
/** The unit that created a type table entry over a symbol (`keepType`), for `keepMergeFound`. */
const entryCreators = new WeakMap<Type, UnitRec>();
/** The kept modules by their full name (`std.stdio`), for `keepParsed`. */
const keptNames = new Map<string, Module>();
let traceDepth = 0;
let reportDepth = 0;
let stats = newStats();

function newStats() {
    return { replayed: 0, run: 0, modulesKept: 0, modulesDead: 0, unitsKept: 0, unitsDead: 0, instancesKept: 0,
        instancesDead: 0, planMs: 0, seeds: {} as Record<string, number> };
}

const td = new TextDecoder();
const str = (d: DString | { toString(): DString }): string =>
    td.decode(d instanceof Uint8Array ? d : d.toString());

function unitOf(owner: object, kind: KeepUnit): UnitRec | undefined {
    return unitsOf.get(owner)?.[kind];
}

/** The unit's state in this compile: 0 pending, 1 running, 2 done. */
function stateOf(u: UnitRec): number {
    return u.gen === compileNo ? u.st : 0;
}

function setState(u: UnitRec, st: number): void {
    u.gen = compileNo;
    u.st = st;
}

// ── the host side: one entry, `keepCompile` ───────────────────────────────────────────────────────────────

/** Statistics of one `djsMainKept` call, for the host (10 §4.7). */
export interface KeepStats {
    replayed: number;
    run: number;
    modulesKept: number;
    modulesDead: number;
    unitsKept: number;
    unitsDead: number;
    instancesKept: number;
    instancesDead: number;
    planMs: number;
    /** Why the dead set started (before its closure): a changed file, a changed role, an error, ... */
    seeds: Record<string, number>;
}

/** The result of `djsMainKept` (src/djs.ts). */
export interface KeptCompile {
    /** The exit status, as `djsMain` returns it. */
    status: number;
    /** "kept": the compile replayed kept units; "fresh": it compiled from nothing (`reason` says why). */
    mode: "kept" | "fresh";
    /** Why the compile was fresh: the first call, a changed command line, a refused flag, an abort, ... */
    reason: string;
    /**
     * Of the compile that produced the output (after an abort, the fresh one; `planMs` and `seeds` are the
     * plan's): units replayed and run, modules and instances kept and dropped, wall time, the RSS after the call.
     */
    stats: KeepStats & { ms: number; rssMiB: number };
}

/** The driver's part of a compile, given to `keepCompile` by src/djs.ts. */
export interface KeepHost {
    /** Resets the frontend and the driver for a fresh compile (`deinitializeFrontend` and the per-call state). */
    resetFresh(): void;
    /** Resets them for a kept compile: what no kept object points to (`resetForKeptCompile`). */
    resetKept(): void;
    /** Runs the compile (`cppmain`): returns its status, or throws what escapes it. */
    run(): number;
    /** True when an escaped error is a crash: neither a `FatalError` nor an unsupported flag. */
    crashed(e: unknown): boolean;
    /** What `djsMain` does with an escaped error: prints what it calls for and returns the status. */
    escape(e: unknown): number;
    /**
     * The host's options that change what a compile records besides its command line (src/djs.ts `DjsOptions`,
     * serialized): part of the kept state's key, so a call with other options compiles fresh.
     */
    readonly options: string;
    /** errors.ts's diagnostic handler slot (dmd/errors.d:408), which a kept compile buffers. */
    getHandler(): DiagnosticHandler | null;
    setHandler(h: DiagnosticHandler | null): void;
}

/**
 * One compile of `args` that keeps what it parsed and analysed for the next call (the contract is `djsMainKept`'s,
 * src/djs.ts). Plans (refused cases, the command line, the dead set), runs a kept compile, and on an abort, or a
 * crash during a kept compile (stale kept state is its likeliest cause), drops the kept state and runs the same
 * call fresh, whose output alone the host sees; a fresh compile records for the next call.
 * Cost: the plan (`keepPlan`) plus the compile.
 */
export function keepCompile(args: readonly string[], host: KeepHost): KeptCompile {
    const t0 = performance.now();
    const plan = keepPlan(args, host.options);
    let mode: "kept" | "fresh" = plan.kept ? "kept" : "fresh";
    let reason = plan.reason;
    let status: number;
    if (plan.kept) {
        host.resetKept();
        const r = runCompile(args, host, true);
        status = r.status;
        if (r.abort !== null) {
            mode = "fresh";
            reason = `abort: ${r.abort}`;
            stats = { ...newStats(), planMs: stats.planMs, seeds: stats.seeds };
            status = compileFresh(args, host);
        }
    } else
        status = compileFresh(args, host);
    return { status, mode, reason, stats: { ...stats, seeds: { ...stats.seeds }, ms: performance.now() - t0,
        rssMiB: process.memoryUsage().rss / 2 ** 20 } };
}

/** A fresh compile that records for the next call. */
function compileFresh(args: readonly string[], host: KeepHost): number {
    dropKeptState();
    host.resetFresh();
    return runCompile(args, host, false).status;
}

/** Runs one compile with the hooks on; returns its status, or the reason a kept compile aborted. */
function runCompile(args: readonly string[], host: KeepHost,
    isKept: boolean): { status: number; abort: string | null } {
    keepBegin(isKept, host);
    try {
        if (isKept)
            keepPrepare();
        const status = host.run();
        const wrong = isKept ? sharesWrong() ?? generatedWrong() : null;
        if (wrong !== null)
            throw new KeepAbort(wrong);
        keepEnd("ok", args, host);
        return { status, abort: null };
    } catch (e) {
        if (e instanceof KeepAbort) {
            keepEnd("abort", args, host);
            return { status: 1, abort: e.reason };
        }
        const crash = host.crashed(e);
        if (isKept && crash) {
            keepEnd("abort", args, host);
            const what = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
            return { status: 1, abort: `internal error: ${what}` };
        }
        const wrong = isKept && !crash ? sharesWrong() ?? generatedWrong() : null;
        if (wrong !== null) {
            keepEnd("abort", args, host);
            return { status: 1, abort: wrong };
        }
        // a fatal stop between two passes leaves every unit closed: the state stays usable
        keepEnd(!crash && stack.length === 0 ? "ok" : "unclean", args, host);
        return { status: host.escape(e), abort: null };
    }
}

/**
 * Drops every kept unit, module and table. After it the next `djsMainKept` compiles fresh ("no kept state").
 * Cost: proportional to the kept state's size; the previous AST stays reachable from the frontend's statics until
 * their next reset (src/djs.ts `dropKeptState` runs it at once).
 */
export function dropKeptState(): void {
    unitsOf.clear();
    replayStarts.clear();
    renumbered = false;
    madeStrings = [];
    mods.clear();
    modsByKey.clear();
    fileUnits.clear();
    tds.clear();
    dormantPkgs.clear();
    pkgs.clear();
    containerMembers.clear();
    keptNames.clear();
    deferredSyms.clear();
    cShares.length = 0;
    errorMarked.clear();
    tinfos.clear();
    tinfoTypes.clear();
    rtinfoTop.clear();
    stack = [];
    stateKey = null;
    stateUnclean = "";
    pendingLoad = null;
}

/** Switches whose output depends on which modules a compile loads or analyses, or that write files. */
function refusedFlag(a: string): string | null {
    if (a === "-v") return "-v prints per-module lines";
    if (a.startsWith("-vtemplates")) return "-vtemplates counts instantiations";
    if (a === "-vcg-ast") return "-vcg-ast writes the analysed AST";
    if (/^-X/.test(a)) return "-X writes JSON";
    if (a === "-D" || a.startsWith("-Dd") || a.startsWith("-Df")) return "-D writes documentation";
    if (a.startsWith("-H")) return "-H writes headers";
    if (a.startsWith("-deps")) return "-deps writes dependencies";
    if (a.startsWith("-mixin")) return "-mixin writes mixins";
    if (a === "-verror-style=sarif") return "SARIF output is written at the end";
    if (a === "-main") return "-main adds a module";
    return null;
}

/** The options that take the next argument when nothing is attached (10 §4.2). */
const SEPARATE_VALUE = new Set(["-I", "-J", "-od", "-of", "-Dd", "-Df", "-Xf", "-Xi", "-P", "-mtriple", "-gcc",
    "--gcc"]);
const SOURCE_EXT = /\.(d|di|dd|c|i|h)$/;

/** Splits a command line into the root source files and the rest (the key a kept state belongs to). */
function splitArgs(args: readonly string[]): { roots: string[]; key: string } {
    const roots: string[] = [];
    const rest: string[] = [];
    const noObj = args.includes("-o-");
    for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (SEPARATE_VALUE.has(a) && i + 1 < args.length) {
            rest.push(a, args[++i]!);
            continue;
        }
        if (!a.startsWith("-") && SOURCE_EXT.test(a)) {
            roots.push(a);
            continue;
        }
        // with -o- the object file's name and directory reach no diagnostic (no object is written)
        if (noObj && (a.startsWith("-od") || a.startsWith("-of") || a === "-op" || a === "-oq"))
            continue;
        rest.push(a);
    }
    return { roots, key: JSON.stringify(rest) };
}

/** An instance no kept unit requests is dropped after this many compiles without a request. */
const UNUSED_COMPILES = 4;

/** RSS above which the engine stops keeping (bytes): a fresh compile of a large application peaks at ~2.1 GiB. */
const RSS_VALVE = 6 * 2 ** 30;

/**
 * Decides how the next compile of `args` with the host's `options` runs. Returns `{ kept: false, reason }` when it
 * must be fresh (the caller then drops the kept state and resets the frontend), or `{ kept: true }` after computing
 * the dead set (THE DEAD SET in the header) and removing the dead units, modules and instances from the kept state
 * and the kept tables. Cost: a stat per kept module and `-J` file, a `-J` search per string import and an import path
 * search per failed module import, a read of each changed file, a walk over the kept instances' arguments and
 * the type table.
 */
function keepPlan(args: readonly string[], options: string): { kept: boolean; reason: string } {
    const t0 = performance.now();
    stats = newStats();
    const fresh = (reason: string) => ({ kept: false, reason });
    for (const a of args) {
        const r = refusedFlag(a);
        if (r !== null)
            return fresh(`refused flag ${a}: ${r}`);
    }
    const { roots, key } = splitArgs(args);
    if (roots.some((r) => /\.(c|i|h)$/.test(r)))
        return fresh("a C source file on the command line");
    if (stateKey === null)
        return fresh(stateUnclean !== "" ? stateUnclean : "no kept state");
    if (stateUnclean !== "")
        return fresh(stateUnclean);
    if (key !== stateKey)
        return fresh("the command line changed");
    if (options !== stateOptions)
        return fresh("the host options changed");
    if (process.memoryUsage().rss > RSS_VALVE)
        return fresh(`RSS above ${RSS_VALVE / 2 ** 30} GiB`);
    const deadReason = computeDeadSet(roots);
    stats.planMs = performance.now() - t0;
    if (deadReason !== null)
        return fresh(deadReason);
    return { kept: true, reason: "" };
}

/**
 * What the dead set drops whole: a module or instance (`containerOf` of a symbol), or an AA type's TypeInfo
 * declaration, the container of its semantic3 unit (`unitContainer`), which `containerOf` never returns.
 */
type Container = Module | TemplateInstance | TypeInfoDeclaration;

/** Whether a container is in the kept state: a kept module, or an owner with units. */
function isKept(c: Container): boolean {
    const m = c.isModule();
    return m !== null ? mods.has(m) : unitsOf.has(c);
}

/** The module or (non-mixin) template instance whose analysis holds `s`. */
function containerOf(s: Dsymbol): Container | null {
    for (let p: Dsymbol | null = s; p !== null; p = p.parent) {
        const ti = p.isTemplateInstance();
        if (ti !== null && ti.isTemplateMixin() === null)
            return ti;
        const m = p.isModule();
        if (m !== null)
            return m;
    }
    return null;
}

function unitContainer(u: UnitRec): Container | null {
    const o = u.owner as Dsymbol;
    if (u.kind === KeepUnit.fsem3 || u.kind === KeepUnit.alias)
        return containerOf(o);
    return o as Container;
}

function fileChanged(path: string, size: number, mtime: number, same: () => boolean): boolean {
    let st;
    try {
        st = statSync(path);
    } catch {
        return true;
    }
    if (st.size === size && st.mtimeMs === mtime)
        return false;
    return !same();
}

function sha1(b: Uint8Array): string {
    return createHash("sha1").update(b).digest("hex");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i])
            return false;
    }
    return true;
}

/**
 * THE DEAD SET (header). Returns null when the compile can be kept, or the reason to compile fresh (nothing
 * left to keep, object.d dead, a C module's preprocessor writing).
 */
function computeDeadSet(roots: readonly string[]): string | null {
    const b = B!;
    const dead = new Set<Container>();
    const seed = (c: Container, why: string): void => {
        if (dead.has(c))
            return;
        dead.add(c);
        stats.seeds[why] = (stats.seeds[why] ?? 0) + 1;
    };
    const rootSet = new Set(roots);
    const isRootArg = (path: string): boolean => rootSet.has(path) || rootSet.has(path.replace(/\.d$/, ""));
    // 1. modules: file, role, a parse that reported
    for (const r of mods.values()) {
        const m = r.m;
        if (r.parseReported || r.clock) {
            seed(m, r.clock ? "clock" : "parse report");
            continue;
        }
        // a host's text override (`Module.djsTextOf`) is the file's content: compared by bytes, never by stat
        const changed = (): boolean => {
            const text = b.Module.djsTextOf(r.path);
            if (text !== null)
                return !bytesEqual(text, m.src ?? new Uint8Array());
            return fileChanged(r.path, r.size, r.mtime, () => {
                try {
                    return bytesEqual(readFileSync(r.path), m.src ?? new Uint8Array());
                } catch {
                    return false;
                }
            });
        };
        if (r.root) {
            if (!isRootArg(r.path))
                seed(m, "role");
            else if (changed())
                seed(m, "file");
            continue;
        }
        if (isRootArg(r.path))
            seed(m, "role");
        else if (b.resolveModule(r.packages ?? [], r.ident!) !== r.path)
            seed(m, "resolution");
        else if (/\.[ch]$/.test(r.path)) {
            // its text is the preprocessor's output, which the headers it includes decide too
            const now = b.preprocess(r.path);
            if (now.printed)
                return `the C preprocessor writes for ${r.path}`;
            if (now.text === null || !bytesEqual(now.text, m.src ?? new Uint8Array()))
                seed(m, "file");
        } else if (changed())
            seed(m, "file");
    }
    // 1b. the containers whose symbol a unit of another container marked with errors: a fresh compile starts without
    // the mark, which the next writer (dead with them, since its lookup requested their analysis) makes again
    for (const c of errorMarked) {
        if (isKept(c))
            seed(c, "errors marked");
    }
    errorMarked.clear();
    // 2. units that cannot replay; that read the clock, or the working directory if it changed; whose string
    // imports find another file or read other bytes; whose failed module imports would now find a module
    const cwdChanged = process.cwd() !== stateCwd;
    const appeared = new Map<string, boolean>();
    for (const list of unitsOf.values()) {
        for (const u of list) {
            if (u === undefined)
                continue;
            let why = (u.flags & F_ERROR) !== 0 ? "error" : (u.flags & F_CLOCK) !== 0 ? "clock"
                : (u.flags & F_CWD) !== 0 && cwdChanged ? "working directory" : "";
            for (const f of why === "" ? u.files ?? [] : []) {
                if (b.searchStringImport(f.name) !== f.resolved || (f.hash !== null
                    && fileChanged(f.resolved!, f.size, f.mtime, () => {
                        try { return sha1(readFileSync(f.resolved!)) === f.hash; } catch { return false; }
                    }))) {
                    why = "string import";
                    break;
                }
            }
            for (const x of why === "" ? u.misses ?? [] : []) {
                const k = [...x.packages, x.ident].map((i) => str(i)).join(".");
                let now = appeared.get(k);
                if (now === undefined)
                    appeared.set(k, now = b.resolveModule(x.packages, x.ident) !== null);
                if (now) {
                    why = "module appeared";
                    break;
                }
            }
            if (why !== "") {
                const c = unitContainer(u);
                if (c !== null)
                    seed(c, `${why} (${KeepUnit[u.kind]})`);
            }
        }
    }
    // 2b. instances no kept unit requests, and no compile of the last UNUSED_COMPILES did: only a live request
    // can reach them again, and it can create them anew; dropped so that the kept state does not grow with every
    // instance a root ever made (its types leave the type table with it, as a dead instance's)
    for (const [owner, list] of unitsOf) {
        const ti = (owner as Dsymbol).isTemplateInstance?.() ?? null;
        if (ti === null || dead.has(ti))
            continue;
        const units = [...list, ...[...containerMembers.get(ti) ?? []].flatMap((o) => unitsOf.get(o) ?? [])]
            .filter((u): u is UnitRec => u !== undefined);
        const used = units.some((u) => compileNo - u.gen < UNUSED_COMPILES
            || [...u.deps].some((d) => unitContainer(d) !== ti));
        if (!used)
            seed(ti, "unused");
    }
    // the instances being matched that hold a unit (a constraint's lambda, `F_EARLY`) and never had a creation (a
    // function template's deduction, a call site that matched an existing instance): once no kept unit requests their
    // units, no replay reaches them again
    for (const [c, members] of containerMembers) {
        const ti = c.isTemplateInstance();
        if (ti === null || dead.has(ti) || unitOf(ti, KeepUnit.inst) !== undefined)
            continue;
        if ([...members].every((o) => (unitsOf.get(o) ?? []).every((u) => u === undefined || u.deps.size === 0)))
            seed(ti, "unreachable");
    }
    // 3. to a fixpoint: units reporting in dead files, units requesting dead units, instances over dead symbols
    const deadFiles = new Set<string>();
    const isDeadFile = (f: string): boolean => {
        if (deadFiles.has(f))
            return true;
        const i = f.indexOf("-mixin-");
        return i > 0 && deadFiles.has(f.slice(0, i));
    };
    const deadSym = (s: Dsymbol | null): boolean => {
        if (s === null)
            return false;
        const c = containerOf(s);
        return c !== null && dead.has(c);
    };
    // every instance with units: those in the template tables, and the creations that failed gagged
    const instances: TemplateInstance[] = [];
    for (const owner of unitsOf.keys()) {
        const ti = (owner as Dsymbol).isTemplateInstance?.() ?? null;
        if (ti !== null && unitOf(ti, KeepUnit.inst) !== undefined)
            instances.push(ti);
    }
    // whether a type is built over a dead symbol, or over a type table entry a dead unit created (step 4)
    const memo = new Map<object, boolean>();
    const purged = new Set<Type>();     // the type table entries the dead units created (step 4, `keepType`)
    const deadType = (t: Type | null | undefined): boolean => {
        if (t === null || t === undefined)
            return false;
        const m = memo.get(t);
        if (m !== undefined)
            return m;
        if (purged.has(t))
            return true;
        memo.set(t, false);
        const x = t as unknown as Partial<Record<TypeField, unknown>>;
        let d = deadSym((x.sym as Dsymbol | undefined) ?? null) || deadType(x.next as Type)
            || deadType(x.index as Type) || deadType(x.basetype as Type);
        const pl = x.parameterList as { parameters?: Iterable<{ type: Type } | null> } | undefined;
        if (!d && pl?.parameters) {
            for (const p of pl.parameters) {
                if (p !== null && deadType(p.type)) {
                    d = true;
                    break;
                }
            }
        }
        const targs = x.arguments as Iterable<{ type: Type } | null> | null | undefined;
        if (!d && targs) {
            for (const p of targs) {
                if (p !== null && deadType(p.type)) {
                    d = true;
                    break;
                }
            }
        }
        if (!d && x.tempinst)
            d = deadSym(x.tempinst as Dsymbol);
        memo.set(t, d);
        return d;
    };
    // the containers a template argument names (a type, a symbol, a tuple, or an expression, walked through the
    // fields that name a symbol, a subexpression or a list of them), collected once per plan for each instance: the
    // dead set only grows, so each iteration of the fixpoint tests membership (a CTFE value can be cyclic: each
    // object is walked once)
    const DYN = b.DYNCAST;
    const collect = (o: unknown, into: Set<Container>, seen: Set<object>): void => {
        if (o === null || o === undefined || typeof (o as { dyncast?: unknown }).dyncast !== "function"
            || seen.has(o as object))
            return;
        seen.add(o as object);
        const sym = (s: unknown): void => {
            const c = s === null || s === undefined ? null : containerOf(s as Dsymbol);
            if (c !== null)
                into.add(c);
        };
        switch ((o as { dyncast(): number }).dyncast()) {
            case DYN.dsymbol:
                sym(o);
                return;
            case DYN.tuple:
                for (const x of (o as { objects: Iterable<unknown> | null }).objects ?? [])
                    collect(x, into, seen);
                return;
            case DYN.type: {
                const x = o as Partial<Record<TypeField, unknown>>;
                sym(x.sym);
                sym(x.tempinst);
                collect(x.next, into, seen);
                collect(x.index, into, seen);
                collect(x.basetype, into, seen);
                for (const p of (x.parameterList as { parameters?: Iterable<{ type: Type } | null> } | undefined)
                    ?.parameters ?? [])
                    collect(p?.type, into, seen);
                for (const p of (x.arguments as Iterable<{ type: Type } | null> | null | undefined) ?? [])
                    collect(p?.type, into, seen);
                return;
            }
            case DYN.expression: {
                const r = o as Partial<Record<ExpField, unknown>> & { type?: Type | null };
                collect(r.type, into, seen);
                for (const f of EXP_FIELDS) {
                    const v = r[f];
                    if (v === null || v === undefined)
                        continue;
                    if (f in LIST_FIELDS) {
                        for (const e of v as Iterable<unknown>)
                            collect(e, into, seen);
                    } else
                        collect(v, into, seen);
                }
                return;
            }
        }
    };
    // the modules of the scopes a unit's analysis was entered from (`callsc`, dmd/dscope.d:156: a template
    // instance's members keep the instantiating call's scope, which creation emulation does not replace): a unit
    // entered from code that is gone is analysed again, from this compile's call (its `__FUNCTION__` and `__MODULE__`
    // are that call's, and the gone code is not kept alive through it)
    const callMods = new Map<Container, Set<Module>>();
    for (const owner of unitsOf.keys()) {
        const o = owner as Dsymbol;
        if (o.isModule() !== null)
            continue;
        const c = containerOf(o);
        for (let sc = o._scope?.callsc ?? null; c !== null && sc !== null; sc = sc.callsc) {
            if (sc._module === null)
                continue;
            let set = callMods.get(c);
            if (set === undefined)
                callMods.set(c, set = new Set());
            set.add(sc._module);
        }
    }
    const argDeps = new Map<TemplateInstance, Set<Container>>();
    const argsDead = (ti: TemplateInstance): boolean => {
        let deps = argDeps.get(ti);
        if (deps === undefined) {
            argDeps.set(ti, deps = new Set());
            const seen = new Set<object>();
            for (const a of ti.tiargs ?? [])
                collect(a, deps, seen);
        }
        for (const c of deps) {
            if (dead.has(c))
                return true;
        }
        return false;
    };
    // the containers an AA TypeInfo declaration's analysis holds, collected once per plan: its type (key and value),
    // its own type (object.d's TypeInfo_AssociativeArray) and the scope its semantic3 ran with (the requesting code's
    // module, instance and root module), which must not keep a dead module alive
    const tinfoDeps = new Map<TypeInfoDeclaration, Set<Container>>();
    const tinfoDead = (ti: TypeInfoDeclaration): boolean => {
        let deps = tinfoDeps.get(ti);
        if (deps === undefined) {
            tinfoDeps.set(ti, deps = new Set());
            const seen = new Set<object>();
            collect(ti.tinfo, deps, seen);
            collect(ti.type, deps, seen);
            const u = unitOf(ti, KeepUnit.tinfo);
            const sc = u !== undefined ? tinfoRecs.get(u)!.scope : null;
            for (const s of sc === null ? [] : [sc._module, sc.minst, sc.tinst, sc.parent]) {
                const c = s === null ? null : containerOf(s as unknown as Dsymbol);
                if (c !== null)
                    deps.add(c);
            }
        }
        for (const c of deps) {
            if (dead.has(c))
                return true;
        }
        return false;
    };
    let work: Container[] = [...dead];
    for (;;) {
        while (work.length !== 0) {
            const c = work.pop()!;
            if (c.isModule() !== null)
                deadFiles.add(str(c.isModule()!.srcfile));
            for (const u of unitsOfContainer(c)) {
                for (const v of u.deps) {
                    const vc = unitContainer(v);
                    if (vc !== null && !dead.has(vc)) {
                        dead.add(vc);
                        work.push(vc);
                    }
                }
            }
        }
        // reports located in dead files
        for (const f of deadFiles) {
            for (const u of fileUnits.get(f) ?? []) {
                const c = unitContainer(u);
                if (c !== null && !dead.has(c)) {
                    dead.add(c);
                    work.push(c);
                }
            }
        }
        for (const [f, set] of fileUnits) {
            if (deadFiles.has(f) || !isDeadFile(f))
                continue;
            for (const u of set) {
                const c = unitContainer(u);
                if (c !== null && !dead.has(c)) {
                    dead.add(c);
                    work.push(c);
                }
            }
        }
        // instances over dead symbols
        for (const ti of instances) {
            if (dead.has(ti))
                continue;
            const d = deadSym(ti.tempdecl) || deadSym(ti.enclosing) || (ti.parent !== null && deadSym(ti.parent))
                || argsDead(ti);
            if (d) {
                dead.add(ti);
                work.push(ti);
            }
        }
        // AA TypeInfo declarations over dead symbols, or analysed from a dead scope
        for (const ti of tinfos.values()) {
            if (!dead.has(ti) && tinfoDead(ti)) {
                dead.add(ti);
                work.push(ti);
            }
        }
        // the modules that took a dead module's C types: their analysis holds its declarations; and the modules whose
        // C types a dead module read before their size was final: the kept declarations hold the final field lists
        for (const { m, w, early } of cShares) {
            if (dead.has(w) && !dead.has(m)) {
                dead.add(m);
                work.push(m);
            } else if (early && dead.has(m) && !dead.has(w)) {
                dead.add(w);
                work.push(w);
            }
        }
        for (const [c, ms] of callMods) {
            if (dead.has(c))
                continue;
            for (const m of ms) {
                if (dead.has(m) || !mods.has(m)) {
                    dead.add(c);
                    work.push(c);
                    break;
                }
            }
        }
        if (work.length === 0)
            break;
    }
    const objectDead = [...dead].some((c) => c.isModule() !== null && c.ident !== null && str(c.ident) === "object"
        && mods.get(c.isModule()!)?.root === false);
    if (objectDead)
        return "object.d is not kept";
    // 4. remove the dead from the kept state and the kept tables
    const typeTable = b.typeTable();
    for (const c of dead) {
        containerMembers.delete(c);
        const m = c.isModule();
        if (m !== null) {
            const r = mods.get(m);
            if (r !== undefined) {
                mods.delete(m);
                modsByKey.delete(modKey(r));
                stats.modulesDead++;
            }
        } else if (c.isTemplateInstance() !== null)
            stats.instancesDead++;
    }
    for (const [owner, list] of unitsOf) {
        const first = list.find((u) => u !== undefined);
        const c = first !== undefined ? unitContainer(first) : null;
        if (c === null || dead.has(c) || (c.isModule() !== null && !mods.has(c.isModule()!))) {
            for (const u of list) {
                if (u !== undefined) {
                    forgetUnit(u);
                    stats.unitsDead++;
                    // an entry made again after an earlier drop is not this unit's
                    for (const t of u.types ?? []) {
                        if (typeTable.get(t.deco!)?.value === t) {
                            purged.add(t);
                            typeTable.delete(t.deco!);
                        }
                    }
                }
            }
            unitsOf.delete(owner);
        } else {
            for (const u of list) {
                if (u !== undefined)
                    stats.unitsKept++;
            }
        }
    }
    for (const t of [...tds]) {
        if (deadSym(t)) {
            tds.delete(t);
            continue;
        }
        removeInstances(t, (ti) => dead.has(ti) || !unitsOf.has(ti));
    }
    for (const ti of instances) {
        if (!dead.has(ti) && unitsOf.has(ti))
            stats.instancesKept++;
    }
    // a pair with a dead module is made again by the merge of a new analysis
    for (let i = cShares.length - 1; i >= 0; i--) {
        if (dead.has(cShares[i]!.m) || dead.has(cShares[i]!.w))
            cShares.splice(i, 1);
    }
    // the types over dead symbols, and over the entries the dead units created
    for (const [k, sv] of typeTable) {
        if (sv.value !== null && deadType(sv.value))
            typeTable.delete(k);
    }
    // the AA TypeInfo declarations and `vtinfo` holders whose type left the table: a request makes a new one
    const inTable = (t: Type): boolean => t.deco !== null && typeTable.get(t.deco)?.value === t;
    for (const t of tinfoTypes) {
        if (!inTable(t))
            tinfoTypes.delete(t);
    }
    for (const [t, ti] of tinfos) {
        if (inTable(t))
            continue;
        // its type left the table through an entry a dead unit created (`keepType`), which the closure does not see:
        // the declaration is dead too (a kept request of it aborts, OP_TINFO)
        tinfos.delete(t);
        for (const u of unitsOf.get(ti) ?? []) {
            if (u !== undefined) {
                forgetUnit(u);
                stats.unitsKept--;
                stats.unitsDead++;
            }
        }
        unitsOf.delete(ti);
    }
    b.purgeLocFiles(isDeadFile);
    const keptSym = (o: object): boolean => {
        const c = containerOf(o as Dsymbol);
        return c !== null && isKept(c);
    };
    b.purgeLocCounters(isDeadFile, keptSym);
    b.dropCtfeGlobals(keptSym);
    stats.modulesKept = mods.size;
    return mods.size === 0 ? "nothing to keep" : null;
}

function modKey(r: { path: string; packages: Identifier[] | null; ident: Identifier | null }): string {
    const name = r.packages === null ? "" : [...r.packages, r.ident!].map((i) => str(i)).join(".");
    return `${r.path}\u0000${name}`;
}

function unitsOfContainer(c: Container): UnitRec[] {
    const out: UnitRec[] = [];
    for (const u of unitsOf.get(c) ?? []) {
        if (u !== undefined)
            out.push(u);
    }
    // the units of its functions and aliases
    for (const o of containerMembers.get(c) ?? []) {
        for (const u of unitsOf.get(o) ?? []) {
            if (u !== undefined)
                out.push(u);
        }
    }
    return out;
}

/** The functions and aliases with a unit, per container (for the closure over a dead container). */
const containerMembers = new Map<Container, Set<Dsymbol>>();

/** Removes a dead unit from the dependents of the units it requested and from the file index. */
function forgetUnit(u: UnitRec): void {
    const log = u.log;
    for (let i = 0; i < log.length;) {
        const op = log[i] as number;
        if (op === OP_REQ || op === OP_REQI)
            (log[i + 1] as UnitRec).deps.delete(u);
        i += opLength(op);
    }
    if (u.kind === KeepUnit.fsem3 || u.kind === KeepUnit.alias) {
        const c = containerOf(u.owner as Dsymbol);
        if (c !== null)
            containerMembers.get(c)?.delete(u.owner as Dsymbol);
    }
    for (const set of fileUnits.values())
        set.delete(u);
}

/** Drops the instances of `t` that `drop` names from its instance table (none yet: null). */
function removeInstances(t: TemplateDeclaration, drop: (ti: TemplateInstance) => boolean): void {
    (t.instances as TemplateInstanceTable | null)?.keepRemove(drop);
}

/**
 * The per-compile reset of the kept objects, after `keepPlan` answered kept and src/djs.ts reset the per-compile
 * frontend state: the module tree emptied (kept packages dormant until a registration puts them back), every
 * kept module unregistered with its appended members removed, every owner in its shadow state, every kept
 * instance uncreated. Cost: a walk over the kept modules, packages, instances and functions.
 */
function keepPrepare(): void {
    const b = B!;
    // the module tree: remember the packages, then empty every table in place. The packages to reset are those
    // of the last tree, the parents of the kept modules and those a kept log puts back in a tree (`ensure`): a
    // package no longer among them is no longer the engine's
    dormantPkgs.clear();
    pkgs.clear();
    const walk = (table: DsymbolTable): void => {
        for (const [id, s] of tableEntries(table)) {
            const p = s.isPackage();
            if (p === null || p.isModule() !== null)
                continue;
            let m = dormantPkgs.get(table);
            if (m === undefined)
                dormantPkgs.set(table, m = new Map());
            m.set(id, p);
            pkgs.add(p);
            if (p.symtab !== null)
                walk(p.symtab);
        }
    };
    walk(b.Module.modules!);
    // and the packages of every kept module, which an earlier compile's tree may hold and the last one not
    for (const r of mods.values()) {
        for (let p: Dsymbol | null = r.m.parent; p !== null; p = p.parent) {
            const pk = p.isPackage()!;
            const table = pk.parent === null ? b.Module.modules! : pk.parent.isPackage()!.symtab!;
            let m = dormantPkgs.get(table);
            if (m === undefined)
                dormantPkgs.set(table, m = new Map());
            if (!m.has(pk.ident!))
                m.set(pk.ident!, pk);
            pkgs.add(pk);
        }
        if (r.m.isPackageFile && r.m.pkg !== null)
            pkgs.add(r.m.pkg);
    }
    for (const list of unitsOf.values()) {
        for (const u of list) {
            const log = u?.log ?? [];
            for (let i = 0; i < log.length; i += opLength(log[i] as number)) {
                const op = log[i];
                const p = op === OP_TREE ? (log[i + 3] as Dsymbol).isPackage() : op === OP_PKG ? log[i + 1] as Package
                    : null;
                if (p !== null && p.isModule() === null)
                    pkgs.add(p);
            }
        }
    }
    b.clearTable(b.Module.modules!);
    for (const p of pkgs) {
        if (p.symtab !== null)
            b.clearTable(p.symtab);
        p.isPkgMod = b.PKG.unknown;
        p.mod = null;
    }
    // the object.d statics start empty, as in a fresh compile, and come back with their module (`register`): a
    // compile whose root declares its own `object` must not see the kept object.d's
    b.objectStatics(b.objectStatics().map(() => null));
    // the deferral flags of the last compile's symbols: the lists they stood for were emptied (Module.resetState),
    // and runDeferredSemantic2/3 leave a flag set past an error (dmd/dsymbolsem.d:820/:838)
    for (const x of deferredSyms) {
        x.deferred2 = false;
        x.deferred3 = false;
    }
    deferredSyms.clear();
    // the AA types' TypeInfo declarations: their types without `vtinfo`, their semantic3 pending and no scope, as in a
    // fresh compile before their first request, which gives the type its kept declaration again with the requesting
    // scope (`keepTypeInfoDecl`, OP_TINFO); the scope of the last compile's request is not kept alive past it
    for (const t of tinfoTypes)
        t.vtinfo = null;
    for (const ti of tinfos.values()) {
        ti.semanticRun = b.PASS.initial;
        ti._scope = null;
    }
    // the RTInfo the end-of-compile semantic3 made, outside every unit: no replay makes it again, its next run does
    for (const ad of rtinfoTop)
        ad.getRTInfo = null;
    rtinfoTop.clear();
    keptNames.clear();
    for (const r of mods.values())
        keptNames.set(moduleName(r.m), r.m);
    for (const r of mods.values()) {
        const m = r.m;
        m.importedFrom = null;
        // the instances this module's members got by appendToModuleMember (dmd/templatesem.d:1745) come back as this
        // compile creates them, and so do the members a unit's analysis appended (`keepAppend`: the `mixin _d_cmain!()`
        // of a D `main`), where the replay of that unit's log appends them, among the instances as a fresh compile
        // appends them; one appended outside every recording unit stays, in order
        const ms = m.members;
        if (ms !== null && ms.length > r.baseLen) {
            let n = r.baseLen;
            for (let i = r.baseLen; i < ms.length; i++) {
                const s = ms.opIndex(i)!;
                const ti = s.isTemplateInstance();
                if ((ti === null || ti.isTemplateMixin() !== null) && !appendLogged.has(s))
                    ms.opIndexAssign(s, n++);
            }
            ms.setDim(n);
        }
        const mm = m as unknown as { selfimports: number; rootimports: number };
        mm.selfimports = 0;
        mm.rootimports = 0;
        m.searchCacheIdent = null;
        m.searchCacheSymbol = null;
        m.insearch = false;
        // a module named as a package: the tree's entries come back with this compile's use, and a table no importAll
        // ran on, which holds only them, with the use that makes it (`keepModuleAsPackage`)
        const list = unitsOf.get(m);
        if (r.asPackage === "resolve" && list?.[KeepUnit.importAll] === undefined)
            m.symtab = null;
        else if (r.asPackage !== null)
            dropTreeEntries(m.symtab!);
        // the scope comes back with the importAll unit's replay (`closeFrame` noted it at the run): a compile that did
        // not load the module left it null, and a replay restoring that would let the module's next importAll run again
        if (list?.[KeepUnit.importAll] !== undefined)
            m._scope = null;
        const first = list?.find((u) => u !== undefined);
        if (first !== undefined)
            m.semanticRun = first.pre;
    }
    for (const [owner, list] of unitsOf) {
        const o = owner as Dsymbol;
        const ti = o.isTemplateInstance();
        if (ti !== null) {
            ti.memberOf = null;
            ti.tinst = null;
            ti.minst = null;
            ti.tnext = null;
            const iu = list[KeepUnit.inst];
            if (iu !== undefined && ti.inst === null)
                continue;       // a creation that failed gagged: the instance is out of every table, inert
            const s2 = list[KeepUnit.isem2] ?? list[KeepUnit.isem3];
            ti.semanticRun = s2 !== undefined ? s2.pre : iu!.post;
            setErrFlags(ti, s2 !== undefined ? s2.errPre : iu!.errPost);
            continue;
        }
        // a function keeps its error flags: they go with its type, which the analysis replaced (an inferred
        // return type that failed is `Type.terror`, dmd/semantic3.d:258-268), and which no shadow can take back
        const f = list[KeepUnit.fsem3] ?? list[KeepUnit.alias];
        if (f !== undefined)
            o.semanticRun = f.pre;
        const an = f !== undefined ? aliasNext.get(f) : undefined;
        if (an !== undefined)
            (o as AliasDeclaration).overnext = an.pre;
    }
}

/** The output written during a buffered (kept) compile, released in order at its end. */
type DiagEntry = { diag: Parameters<DiagnosticHandler>; text: string | Uint8Array | null };
type OutEntry = { s: 1 | 2; data: string | Uint8Array } | DiagEntry;
let outBuf: OutEntry[] | null = null;
let pendingDiag: DiagEntry | null = null;
let savedOut: typeof process.stdout.write | null = null;
let savedErr: typeof process.stderr.write | null = null;
let hostHandler: DiagnosticHandler | null = null;

/**
 * Starts a kept-capable compile: turns the hooks on, numbers the compile, and taps stdout and stderr (every
 * write is recorded into the innermost unit's log; in a kept compile it is also buffered, with the diagnostic
 * handler's calls, see ABORT in the header).
 */
function keepBegin(isKept: boolean, host: KeepHost): void {
    K.on = true;
    K.kept = kept = isKept;
    compileNo++;
    stack = [];
    traceDepth = reportDepth = 0;
    pendingLoad = null;
    parsing = null;
    shifted = false;
    renumbered = false;
    genReplayed = null;
    madeStrings = [];
    replayStarts.clear();
    savedOut = process.stdout.write;
    savedErr = process.stderr.write;
    outBuf = isKept ? [] : null;
    pendingDiag = null;
    const tap = (s: 1 | 2) => (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
        const data = typeof chunk === "string" ? chunk : new Uint8Array(chunk);
        if (reportDepth === 0 && traceDepth === 0)
            logEvent(OP_WRITE, s, data);
        if (outBuf !== null) {
            if (pendingDiag !== null && s === 2) {
                pendingDiag.text = data;
                pendingDiag = null;
            } else
                outBuf.push({ s, data });
            return true;
        }
        const w = s === 1 ? savedOut! : savedErr!;
        return (w as (c: unknown, ...r: unknown[]) => boolean).call(s === 1 ? process.stdout : process.stderr,
            chunk, ...rest);
    };
    process.stdout.write = tap(1) as typeof process.stdout.write;
    process.stderr.write = tap(2) as typeof process.stderr.write;
    hostHandler = host.getHandler();
    if (isKept && hostHandler !== null) {
        // printDiagnostic (dmd/errors.d:652) asks the handler, then prints when it answers false: the call is
        // buffered with the text it would print, and the host's answer decides at release (keepEnd). Its arguments
        // are copied: a DString can be a view of a buffer reused before the release (parse.ts `buf.peekChars()`)
        const snap = (x: unknown): unknown => x instanceof Uint8Array ? x.slice() : x;
        host.setHandler((loc, color, header, format, ap, p1, p2): boolean => {
            const e: DiagEntry = { diag: [loc.copy(), color, header.slice(), format.slice(), ap.map(snap),
                p1 === null ? null : p1.slice(), p2 === null ? null : p2.slice()], text: null };
            outBuf!.push(e);
            pendingDiag = e;
            return false;
        });
    }
}

/**
 * Ends a kept-capable compile. `outcome`: "ok" (the compile returned, or stopped between two passes), "abort"
 * (a KeepAbort: the buffered output is discarded and the state dropped), "unclean" (an escaped error or a fatal
 * stop inside a unit: the state is dropped and the next compile is fresh, saying why). Restores the streams and
 * the diagnostic handler, then releases the buffered output in order (unless aborted): each buffered handler
 * call is made, and the text printDiagnostic printed for it is written when the host's handler answers false.
 */
function keepEnd(outcome: "ok" | "abort" | "unclean", args: readonly string[], host: KeepHost): void {
    process.stdout.write = savedOut!;
    process.stderr.write = savedErr!;
    if (kept)
        host.setHandler(hostHandler);
    const buf = outBuf;
    outBuf = null;
    pendingDiag = null;
    K.on = K.kept = false;
    const unclean = outcome !== "ok" || stack.length !== 0;
    stack = [];
    if (unclean) {
        dropKeptState();
        stateUnclean = outcome === "abort" ? "" : "the previous compile stopped inside a pass";
    } else {
        stateKey = splitArgs(args).key;
        stateOptions = host.options;
        stateCwd = process.cwd();
        rememberStatics();
    }
    if (buf !== null && outcome !== "abort") {
        for (const e of buf) {
            if ("s" in e) {
                (e.s === 1 ? process.stdout : process.stderr).write(e.data);
                continue;
            }
            const suppressed = hostHandler !== null && hostHandler(...e.diag);
            if (!suppressed && e.text !== null)
                process.stderr.write(e.text);
        }
    }
}

// ── recording ──────────────────────────────────────────────────────────────────────────────────────────────

function opLength(op: number): number {
    switch (op) {
        case OP_REQ: return 5;          // unit, gag, inProgress, inWindow
        case OP_REQI: return 9;         // unit, gag, inProgress, inWindow, loc, tinst, minst-spec, creates
        case OP_REP: return 10;         // gag, inWindow, supplemental, loc, format, ap, kind, p1, p2
        case OP_TRACE: return 5;        // gag, ti, cl, maxShown
        case OP_CNT: return 3;          // n, the counter where the segment started
        case OP_WRITE: return 3;        // stream, data
        case OP_TREE: return 4;         // table, ident, sym
        case OP_PKG: return 3;          // package, module
        case OP_AMOD: return 3;         // module, the load's loc
        case OP_IFROM: return 4;        // module, from, the import's loc
        case OP_DEFS: return 2;         // Module.deferred (null: empty)
        case OP_TIDEFER: return 2;      // instance
        case OP_DEFER: return 3;        // pass (2 or 3), symbol
        case OP_TINFO: return 4;        // TypeInfo declaration, scope, the type requested (a table entry, or null)
        case OP_MINST: return 3;        // instance, minst-spec
        case OP_AALOC: return 3;        // AA type table entry, the merging type's loc
        case OP_APPEND: return 3;       // module or instance, member
        default: throw new Error(`keep: bad opcode ${op}`);
    }
}

/** The innermost frame that records, or null (no unit, a replay, a tail). */
function recFrame(): Frame | null {
    const f = stack.length !== 0 ? stack[stack.length - 1]! : null;
    return f !== null && !f.replay && f.u !== null ? f : null;
}

/**
 * Logs the generated identifiers made since the last event as one OP_CNT segment: their count and the counter where
 * the first was numbered (a registered module's parse in between consumes numbers of its own, `keepParse`).
 */
function flushCount(f: Frame): void {
    if (f.ids.length !== 0) {
        f.u!.log.push(OP_CNT, f.ids.length, f.idsAt);
        for (const g of f.ids)
            f.u!.ids.push(g);
        f.ids = [];
    }
}

function logEvent(op: number, ...fields: unknown[]): void {
    const f = recFrame();
    if (f === null)
        return;
    flushCount(f);
    if ((op === OP_REQ || op === OP_REQI) && !sameDeferred(f.def)) {
        // the request sees other deferred symbols than the log last knew: its replay must see them too
        f.def = deferredNow();
        f.u!.log.push(OP_DEFS, f.def);
    }
    f.u!.log.push(op, ...fields);
    // a report inside a gag window the unit opened is gagged whatever the gag at the unit's entry: it does not
    // depend on it (a trace is recorded only ungagged, dmd/dtemplate.d:943)
    if (op === OP_TRACE || op === OP_WRITE || (op === OP_REP && !(fields[1] as boolean)))
        f.u!.flags |= F_OBS;
    // printed text naming a generated identifier: right only where the counter is (see `shifted`)
    const printed = op === OP_WRITE ? [fields[1]] : op === OP_REP
        && ((fields[0] as number) === 0 || B!.global.params.v.showGaggedErrors)
        ? [...(fields[5] as unknown[]), fields[7], fields[8]] : [];
    if (printed.some((x) => (x instanceof Uint8Array || typeof x === "string") && GENERATED.test(textOf(x))))
        f.u!.flags |= F_GEN;
}

/**
 * Hook of the appends of a unit's own analysis to a module's members, or to a template instance's, other than an
 * instance's (the `mixin _d_cmain!()` of a D `main`, after dmd/funcsem.d:926; a C compound literal's `__cl`,
 * dmd/expressionsem.d:6242; an anonymous class in `typeof`, `visit(NewAnonClassExp)`, to the module or the instance):
 * logged in the running unit, whose replay appends `s` again at that point among this compile's instance appends,
 * where a fresh compile appends it; the member is dropped from a kept module before the next kept compile, and an
 * instance, which keeps its members, gets it only where it lacks it. Outside a recording unit nothing is logged, and
 * `s` stays in place.
 */
export function keepAppend(m: Module | ScopeDsymbol, s: Dsymbol): void {
    if (recFrame() === null)
        return;
    logEvent(OP_APPEND, m, s);
    appendLogged.add(s);
}

/**
 * Hook of the StringExp constructor (dmd/expression.d:954): a string this compile makes, from a literal or from a name
 * (`__traits(allMembers)` with an anonymous bit-field's `__anonBitField3`, a lambda's `.stringof`, `.mangleof`,
 * `__traits(identifier)`). One that looks like it names a generated identifier (GENERATED) is noted for the end of the
 * compile (`generatedWrong`), and kept with the recording unit, whose replays note it again: a compile that numbers
 * that identifier otherwise makes another string. A module's parse makes no value (`keepParse`). Cost: one test of a
 * regular expression per string.
 */
export function keepString(bytes: Uint8Array): void {
    if (parsing !== null)
        return;
    const text = td.decode(bytes);
    if (!GENERATED.test(text))
        return;
    madeStrings.push(text);
    const f = recFrame();
    if (f !== null)
        (f.u!.strings ??= []).push(text);
}

function textOf(x: string | Uint8Array): string {
    return typeof x === "string" ? x : td.decode(x);
}

/**
 * A request of unit `v` from the innermost recording frame: the dependency edge and the replay order. `starting`:
 * the request runs `v` now (it is not "in progress" at the request).
 */
function logRequest(v: UnitRec, starting = false): void {
    const f = recFrame();
    if (f === null || f.u === v)
        return;
    if (f.seen === null)
        f.seen = new Set();
    if (f.seen.has(v))
        return;
    f.seen.add(v);
    logEvent(OP_REQ, v, B!.global.gag, !starting && stateOf(v) === 1, f.win !== 0);
    v.deps.add(f.u!);
}

function newUnit(owner: object, kind: KeepUnit, pre: number): UnitRec {
    const g = B!.global;
    const u: UnitRec = {
        owner, kind, log: [], flags: 0, e: g.gag,
        gagged: (owner as { gagged?: boolean }).gagged ?? false,
        dep: g.params.useDeprecated, pre, post: pre, errPre: errFlags(owner), errPost: 0,
        defIn: deferredNow(), defOut: null, c0: B!.suffixCounter(), ids: [], born: compileNo,
        infers: kind === KeepUnit.fsem3 && (owner as FuncDeclaration).inferRetType
            && ((owner as FuncDeclaration).type as TypeNext | null)?.next === null,
        gen: compileNo, st: 1,
        deps: new Set(), files: null, misses: null, types: null, strings: null,
    };
    let list = unitsOf.get(owner);
    if (list === undefined)
        unitsOf.set(owner, list = []);
    const old = list[kind];
    if (old !== undefined)
        forgetUnit(old);
    list[kind] = u;
    if (kind === KeepUnit.fsem3 || kind === KeepUnit.alias) {
        const c = containerOf(owner as Dsymbol);
        if (c !== null) {
            let s = containerMembers.get(c);
            if (s === undefined)
                containerMembers.set(c, s = new Set());
            s.add(owner as Dsymbol);
        }
    }
    stats.run++;
    return u;
}

/**
 * An instance's `errors`, which its semantic2/semantic3 set when they fail (gagged: dmd/semantic2.d:174,
 * dmd/semantic3.d:165): part of its shadow state, since the match path reads it (dmd/templatesem.d:1017-1024).
 */
function errFlags(o: object): number {
    const ti = (o as Dsymbol).isTemplateInstance?.() ?? null;
    return ti !== null && ti.errors ? 1 : 0;
}

function setErrFlags(o: object, f: number): void {
    const ti = (o as Dsymbol).isTemplateInstance?.() ?? null;
    if (ti !== null)
        ti.errors = (f & 1) !== 0;
}

function openFrame(u: UnitRec): void {
    stack.push(newFrame(u, false));
}

/**
 * Hook of `addDeferredSemantic` (dmd/dsymbolsem.d:727) and of `runDeferredSemantic` (dmd/dsymbolsem.d:760, past its
 * nesting test): the running unit takes part in deferral, so its replay depends on the deferred symbols
 * (Module.deferred): it replays only where they are those of its entry, and leaves those of its exit (see
 * `replayUnit`).
 */
export function keepDeferred(): void {
    const f = recFrame();
    if (f !== null)
        f.u!.flags |= F_DEFERS;
}

/** Module.deferred now, or null when empty (the symbols are kept objects: identity is equality). */
function deferredNow(): Dsymbol[] | null {
    const d = B!.Module.deferred;
    return d.length === 0 ? null : d.opSlice().map((x) => x!);
}

function sameDeferred(a: Dsymbol[] | null): boolean {
    const d = B!.Module.deferred;
    const n = a === null ? 0 : a.length;
    if (d.length !== n)
        return false;
    for (let i = 0; i < n; i++) {
        if (d.opIndex(i) !== a![i])
            return false;
    }
    return true;
}

/** Sets Module.deferred to `a`, with each symbol's `deferred` flag (dmd/dsymbolsem.d:729-733). */
function setDeferred(a: Dsymbol[] | null): void {
    const d = B!.Module.deferred;
    for (let i = 0; i < d.length; i++)
        d.opIndex(i)!.deferred = false;
    d.setDim(0);
    for (const s of a ?? []) {
        s.deferred = true;
        d.push(s);
    }
}

/** Closes a recording frame: the unit's post state and its flags (THE DEAD SET). */
function closeFrame(f: Frame): void {
    const u = f.u;
    if (u === null || f.replay)
        return;
    flushCount(f);
    setState(u, 2);
    u.defOut = deferredNow();
    const o = u.owner as Dsymbol;
    u.post = o.semanticRun;
    u.errPost = errFlags(o);
    const an = aliasNext.get(u);
    if (an !== undefined)
        an.post = (o as AliasDeclaration).overnext;
    if (u.kind === KeepUnit.importAll) {
        const r = mods.get(o as unknown as Module);
        if (r !== undefined) {
            r.baseLen = (o as unknown as Module).members?.length ?? 0;
            r.scope = (o as unknown as Module)._scope;
        }
    }
}

/** The dispatch functions' mark (dsymbolsem.ts `dsymbolSemantic`, `importAll`, semantic2.ts, semantic3.ts). */
export function keepMark(): number {
    return stack.length;
}

/** Closes the frames a visitor opened under the dispatch call that took `mark`. */
export function keepUnwind(mark: number): void {
    while (stack.length > mark)
        closeFrame(stack.pop()!);
}

// ── the unit hooks ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Hook of a unit guard that returns (the unit already ran or is running in this compile): records the request.
 * `owner` is the module, instance or function; `kind` its unit kind.
 */
export function keepReq(owner: object, kind: KeepUnit): void {
    const u = unitOf(owner, kind);
    if (u !== undefined)
        logRequest(u);
}

/**
 * Hook of a unit guard that passes, called before the D code marks the unit in progress. Records the request,
 * then either replays the kept unit (returns true: the caller returns, the owner is in its post state) or opens
 * a recording frame for the live run (returns false). Module semantic2/semantic3 use `keepPass` instead.
 */
export function keepRun(owner: object, kind: KeepUnit): boolean {
    const u = unitOf(owner, kind);
    // an AA TypeInfo's semantic3 reads the scope of this compile's creating request and its type's `loc`
    // (dmd/semantic3.d:1669-1670; the scope set at dmd/typinf.d:187): recorded with others, it runs for real
    if (u !== undefined && kept && stateOf(u) === 0 && (kind !== KeepUnit.tinfo || tinfoSame(u))) {
        logRequest(u);
        if (kind === KeepUnit.isem2 || kind === KeepUnit.isem3) {
            const ti = owner as TemplateInstance;
            const iu = unitOf(ti, KeepUnit.inst);
            if (iu !== undefined && stateOf(iu) === 0)
                throw new KeepAbort(`${KeepUnit[kind]} of ${describe(owner)} before its creation in this compile`);
        }
        replayUnit(u);
        return true;
    }
    const nu = newUnit(owner, kind, (owner as Dsymbol).semanticRun);
    if (kind === KeepUnit.importAll) {
        nu.pre = 0;
        // run before any use of the module as a package in this compile, it makes its own table
        const r = mods.get(owner as Module);
        if (r !== undefined && r.asPackageGen !== compileNo)
            r.asPackage = null;
    }
    if (kind === KeepUnit.alias && (owner as AliasDeclaration).overnext !== null)
        aliasNext.set(nu, { pre: (owner as AliasDeclaration).overnext!, post: null });
    if (kind === KeepUnit.tinfo) {
        const ti = owner as TypeInfoDeclaration;
        tinfoRecs.set(nu, { scope: ti._scope, loc: (ti.tinfo as TypeAArray).loc });
    }
    // a function of an instance being matched, which has no creation yet (and may never have one): a lambda in a
    // template constraint, whose scope's parent is the instance (dmd/templatesem.d:3529-3530; a function template's
    // through `fd`, :3543); its replay precedes the creation, as its run did
    if (kind === KeepUnit.fsem3) {
        const c = containerOf(owner as Dsymbol);
        const ti = c !== null ? c.isTemplateInstance() : null;
        if (ti !== null && unitOf(ti, KeepUnit.inst) === undefined)
            nu.flags |= F_EARLY;
    }
    logRequest(nu, true);
    openFrame(nu);
    return false;
}

/** A pending TypeInfo semantic3 unit reads in this compile what it read when it ran (`tinfoRecs`). */
function tinfoSame(u: UnitRec): boolean {
    const ti = u.owner as TypeInfoDeclaration;
    const r = tinfoRecs.get(u)!;
    return r.scope === ti._scope && r.loc.opEquals((ti.tinfo as TypeAArray).loc);
}

/**
 * Hook of a module's semantic2/semantic3 visitor after its guard (dmd/semantic2.d:365, dmd/semantic3.d:204): replays
 * the kept loop over the parsed members and returns where the member loop goes on for real (the instances appended in
 * this compile), or opens a recording frame and returns 0. `keepMember` turns the frame into a tail at the first
 * appended member.
 */
export function keepPass(m: Module, kind: KeepUnit): number {
    const u = unitOf(m, kind);
    const r = mods.get(m);
    if (u !== undefined && r !== undefined && kept && stateOf(u) === 0) {
        logRequest(u);
        replayUnit(u, true);
        stack.push(newFrame(null, false));
        return r.baseLen;
    }
    const nu = newUnit(m, kind, m.semanticRun);
    logRequest(nu, true);
    openFrame(nu);
    return 0;
}

/** Hook at the top of a module pass's member loop: at the first appended member, the frame becomes a tail. */
export function keepMember(m: Module, i: number): void {
    const r = mods.get(m);
    if (r === undefined || i !== r.baseLen)
        return;
    const f = stack[stack.length - 1];
    if (f !== undefined && f.u !== null && f.u.owner === m && !f.replay) {
        closeFrame(f);
        stack[stack.length - 1] = newFrame(null, false);
    }
}

/**
 * Hook of the creation path after the module append (dmd/templatesem.d:1183). For an instance this request creates
 * (a new one) it records the request, with the creation fields the request gave it, and opens the creation
 * frame (the template is remembered for the dead set). For a kept instance whose creation `keepInstMatch`
 * started, it replays the kept creation instead: the creation path then skips the steps its members hold.
 */
export function keepInstOpen(ti: TemplateInstance): void {
    const ku = unitOf(ti, KeepUnit.inst);
    if (ku !== undefined && kept && stateOf(ku) === 0) {
        replayCreation(ku);
        return;
    }
    tds.add(ti.tempdecl!.isTemplateDeclaration()!);
    const u = newUnit(ti, KeepUnit.inst, ti.semanticRun);
    logInstRequest(u, ti, ti.loc, ti.tinst, ti.minst, true);
    openFrame(u);
}

/** Hook after the members' semantic1 of a new instance (dmd/templatesem.d:1308-1325): closes the creation frame. */
export function keepInstClose(ti: TemplateInstance): void {
    const f = stack[stack.length - 1];
    if (f !== undefined && f.u !== null && f.u.owner === ti && f.u.kind === KeepUnit.inst)
        closeFrame(stack.pop()!);
}

/**
 * `minst` of a request, relative to its `tinst` when it is the same and `tinst`'s creation came first in this compile
 * (it follows the creation emulation), or any root
 * module, replayed as the compile's first root (`Module.rootModule`): the module an edit replaces, which a kept scope
 * may still hold from the compile that analysed it. Under `-i` that root can stand for a compiled import or another
 * command-line root: the creation path reads only that `minst` is a root (dmd/templatesem.d:1052, :1772-1799), and
 * the two modules' `aimports` (dmd/templatesem.d:1152-1155), read by no diagnostic under `-o-`, differ.
 */
const MINST_TINST = 1, MINST_ROOT = 2;

function logInstRequest(u: UnitRec, ti: TemplateInstance, loc: Loc, tinst: TemplateInstance | null,
    minst: Module | null, starting = false): void {
    const f = recFrame();
    if (f === null || f.u === u)
        return;
    const g = B!.global.gag;
    const key = g > 0 ? u : ti;     // a gagged and an ungagged request of one instance differ (`gagged`)
    if (f.seen === null)
        f.seen = new Set();
    if (f.seen.has(key))
        return;
    f.seen.add(key);
    // relative to `tinst` only once its creation was recorded or replayed: a request made while `tinst` itself is
    // being matched (its template arguments' semantic, `Yes.useReplacementDchar` in `byUTF!(dchar, Yes...)`) comes
    // before the creation event in the log, and its replay would read the `minst` the kept `tinst` has not yet got
    const tu = tinst !== null ? unitOf(tinst, KeepUnit.inst) : undefined;
    const spec = minst === null ? null : tu !== undefined && stateOf(tu) !== 0 && minst === tinst!.minst ? MINST_TINST
        : minst.isRoot() ? MINST_ROOT : minst;
    // `creates`: the request creates the instance (a new one, or a kept one not yet created in this compile, which
    // `keepInstMatch` then creates), and not a match of one created earlier
    logEvent(OP_REQI, u, g, !starting && stateOf(u) === 1, f.win !== 0, loc, tinst, spec,
        starting || stateOf(u) === 0);
    u.deps.add(f.u!);
}

/**
 * Hook of the match path (dmd/templatesem.d:1015, "It's a match"): records the request. When the matched instance is
 * kept and not yet created in this compile, starts its CREATION EMULATION (header): it takes the creation fields
 * of `tempinst`, as a fresh compile would have created `tempinst` here, and the function returns true: the caller
 * then runs the creation path on the kept instance (templatesem.ts `keptCreate`), whose `keepInstOpen` replays
 * the kept creation and whose rest (semantic2/semantic3, which depend on the requesting scope) runs for real.
 */
export function keepInstMatch(tempinst: TemplateInstance): boolean {
    const inst = tempinst.inst!;
    const u = unitOf(inst, KeepUnit.inst);
    if (u === undefined)
        return false;
    logInstRequest(u, inst, tempinst.loc, tempinst.tinst, tempinst.minst);
    if (!kept || stateOf(u) !== 0)
        return false;
    setCreationFields(inst, tempinst.loc, tempinst.tinst, tempinst.minst, tempinst.gagged);
    return true;
}

/** The fields the creation path takes from its request (dmd/templatesem.d:920-931), and the members' scopes. */
function setCreationFields(ti: TemplateInstance, loc: Loc, tinst: TemplateInstance | null, minst: Module | null,
    gagged: boolean): void {
    ti.loc = loc;
    ti.tinst = tinst;
    ti.minst = minst;
    ti.gagged = gagged;
    B!.walkInstanceScopes(ti);
}

/** A replayed request creates kept instance `u.owner` (the whole creation path, its rest being in the log). */
function createKept(u: UnitRec, loc: Loc, tinst: TemplateInstance | null, minst: Module | null,
    gagged: boolean): void {
    const ti = u.owner as TemplateInstance;
    if (ti.inst === null) {
        // a creation that failed gagged (dmd/templatesem.d:1420-1433): its reports and requests replay, and the
        // instance stays out of every table, as D leaves it
        replayUnit(u);
        return;
    }
    setCreationFields(ti, loc, tinst, minst, gagged);
    // dmd/templatesem.d:1183 — appended before the members' semantic, as the creation path does
    B!.appendToModuleMember(ti);
    replayCreation(u);
}

/**
 * Hook of `functionSemantic`'s inference test (dmd/funcsem.d:1583, and the call's at dmd/expressionsem.d:4189): true
 * when `fd`'s kept semantic3 inferred its return type and is pending in this compile. The shadow state does not take
 * back the function's type (`keepPrepare`), which holds the inferred return type, so the test would find it inferred;
 * a fresh compile finds none and runs semantic3 there, and so does the kept compile, which replays the unit there.
 */
export function keepInfers(fd: FuncDeclaration): boolean {
    const u = unitOf(fd, KeepUnit.fsem3);
    return u !== undefined && kept && stateOf(u) === 0 && u.infers;
}

/** Replays a kept creation (the members' semantic1). */
function replayCreation(u: UnitRec): void {
    replayUnit(u);
    // the Import semantic of a fresh creation gives the instantiating module the modules the instance imports
    // (dmd/dsymbolsem.d:3523-3531), which the replay does not run
    const ti = u.owner as TemplateInstance;
    if (ti.minst !== null) {
        for (const m of ti.importedModules) {
            if (m !== null && !ti.minst.aimports.contains(m))
                ti.minst.aimports.push(m);
        }
    }
}

/**
 * Hook at the top of the two reporting workers (dmd/errors.d:472 and :600). Records the call with a snapshot of its
 * arguments (a DString argument may be a view of a buffer reused later) and makes it, so that what the call
 * prints is not also recorded as a raw write; returns true when it did (the worker returns), false for the
 * call it makes itself, for a replayed report and inside a trace (whose own record regenerates it). An
 * error-class report made ungagged marks the unit F_ERROR: it prints, or counts in the exit status, and it changes
 * what D keeps (an instance failing ungagged stays with errors); a gagged one replays, under the same gag.
 */
export function keepReport(supplemental: boolean, loc: SourceLoc, format: DString, ap: readonly unknown[],
    kind: number, p1: DString | null, p2: DString | null): boolean {
    if (traceDepth !== 0 || reportDepth !== 0)
        return false;
    if (parsing !== null)
        parsing.reported = true;
    const b = B!;
    const f = recFrame();
    if (f !== null) {
        const errorClass = kind === b.ErrorKind.error
            || (kind === b.ErrorKind.deprecation && b.global.params.useDeprecated === b.DiagnosticReporting.error)
            || (kind === b.ErrorKind.warning && b.global.params.useWarnings === b.DiagnosticReporting.error);
        if (errorClass && b.global.gag === 0 && !supplemental)
            f.u!.flags |= F_ERROR;
        const snap = (x: unknown): unknown => x instanceof Uint8Array ? x.slice() : x;
        logEvent(OP_REP, b.global.gag, f.win !== 0, supplemental, loc.copy(), format.slice(), ap.map(snap), kind,
            p1 === null ? null : p1.slice(), p2 === null ? null : p2.slice());
        const file = str(loc.filename);
        if (file !== "") {
            let set = fileUnits.get(file);
            if (set === undefined)
                fileUnits.set(file, set = new Set());
            set.add(f.u!);
        }
    }
    reportDepth++;
    try {
        b.report(supplemental, loc, format, ap, kind, p1, p2);
    } finally {
        reportDepth--;
    }
    return true;
}

/**
 * Hook at the start of `printInstantiationTrace` (dmd/dtemplate.d:940), past its gag test: records the call and
 * makes it (returns true: the method returns), so that the supplementals it prints are not recorded again;
 * false for the call it makes itself and for a replayed trace.
 */
export function keepTrace(ti: TemplateInstance, cl: number, maxShown: number): boolean {
    if (traceDepth !== 0 || reportDepth !== 0)
        return false;
    logEvent(OP_TRACE, B!.global.gag, ti, cl, maxShown);
    traceDepth++;
    try {
        B!.printInstantiationTrace(ti, cl, maxShown);
    } finally {
        traceDepth--;
    }
    return true;
}

/**
 * Hook of dmd/templatesem.d:1548-1574: the instance's semantic3 joined the deferred list of the outermost instance
 * being instantiated (`deferredTI`); a replay of this point must put it there too, or that instance's
 * creation would not run it where a fresh compile does.
 */
export function keepDeferSemantic3(ti: TemplateInstance): void {
    logEvent(OP_TIDEFER, ti);
}

/** Hook of `startGagging` (+1) and `endGagging` (-1) (dmd/globals.d:467/:481): the unit's own gag windows. */
export function keepWin(d: number): void {
    const f = recFrame();
    if (f !== null)
        f.win += d;
}

/**
 * Hook of dmd/identifier.d:161 `generateId` and :173 `generateAnonymousId`, the only callers of `newSuffix` (:199):
 * one number of the counter consumed, by the running unit or parse, and the identifier made with it, with its
 * prefix's length, for the spelling a replay gives it (`keepGeneratedNames`).
 */
export function keepGenerated(id: Identifier, prefix: number): void {
    const n = B!.suffixCounter();       // this identifier's number
    if (parsing !== null) {
        parsing.ids.push([id, prefix, n]);
        return;
    }
    const f = recFrame();
    if (f === null)
        return;
    if (f.ids.length === 0)
        f.idsAt = n - 1;
    f.ids.push([id, prefix, n]);
}

/**
 * For the AST view (src/query.ts, AST VIEW): true when the last compile replayed a unit, or registered a parse, whose
 * generated identifiers it numbered otherwise than the compile that recorded it: their names in the kept AST are not
 * those a fresh compile prints. False after a fresh compile, `djsMain` included.
 */
export function keepRenumbered(): boolean {
    return renumbered;
}

/** A generated identifier's number in a fresh compile, and the length of the prefix it follows. */
export interface FreshNumber {
    prefix: number;
    n: number;
}

/**
 * For the AST view (src/query.ts, AST VIEW): the generated identifiers (`generateId`, `generateAnonymousId`) that the
 * last compile's units of `owner` (a module with its parse, a template instance, a function or alias) made or replayed,
 * each with the number a fresh compile gives it (`FreshNumber`: its own where the unit ran in that compile). A replayed
 * segment's identifiers take the numbers from the counter where the replay consumed them, in the order they were
 * made. Empty for an owner with no unit in the last compile. An identifier is the unit's that made it, which is not
 * always the owner of the AST that holds it: a constructor's semantic3 names its `catch` variable in the requester's
 * unit (dmd/semantic3.d:1501-1560). Cost: one entry per identifier of the owner's units.
 */
export function keepGeneratedNames(owner: object): Map<Identifier, FreshNumber> {
    const names = new Map<Identifier, FreshNumber>();
    for (const u of unitsOf.get(owner) ?? []) {
        if (u !== undefined)
            unitNames(u, names);
    }
    const r = mods.get(owner as Module);
    if (r !== undefined)
        parseNames(r, names);
    return names;
}

/**
 * Every generated identifier the last compile's units and parses made or replayed (see `keepGeneratedNames`), with
 * the distinct numbers a fresh compile gives it: more than one where interned identifiers of units recorded by
 * different compiles meet. Cost: one pass over every unit.
 */
export function keepAllGeneratedNames(): Map<Identifier, FreshNumber[]> {
    const all = new Map<Identifier, FreshNumber[]>();
    const one = new Map<Identifier, FreshNumber>();
    const merge = (): void => {
        for (const [id, x] of one) {
            const list = all.get(id);
            if (list === undefined)
                all.set(id, [x]);
            else if (!list.some((y) => y.n === x.n))
                list.push(x);
        }
        one.clear();
    };
    for (const list of unitsOf.values()) {
        for (const u of list) {
            if (u !== undefined) {
                unitNames(u, one);
                merge();
            }
        }
    }
    for (const r of mods.values()) {
        parseNames(r, one);
        merge();
    }
    return all;
}

/** Adds the generated identifiers of unit `u` in the last compile to `names` (`keepGeneratedNames`). */
function unitNames(u: UnitRec, names: Map<Identifier, FreshNumber>): void {
    if (u.born === compileNo)
        freshNumbers(u.ids, null, names);
    else {
        const starts = replayStarts.get(u);
        if (starts !== undefined)
            freshNumbers(u.ids, starts, names);
    }
}

/** Adds the generated identifiers of the parse of `r` in the last compile to `names` (`keepGeneratedNames`). */
function parseNames(r: ModRec, names: Map<Identifier, FreshNumber>): void {
    if (r.parseGen === compileNo)
        freshNumbers(r.parseIds, null, names);
    else if (r.regGen === compileNo)
        freshNumbers(r.parseIds, [r.parseLive, r.parseIds.length], names);
}

/**
 * `ids` with their fresh numbers: their own when `starts` is null, else the numbers of the segments `starts` lists
 * (counter, length), in order.
 */
function freshNumbers(ids: readonly GenId[], starts: number[] | null, names: Map<Identifier, FreshNumber>): void {
    let k = -2;
    let next = 0;
    let left = 0;
    for (const [id, prefix, own] of ids) {
        if (starts === null) {
            names.set(id, { prefix, n: own });
            continue;
        }
        while (left === 0) {
            k += 2;
            next = starts[k]!;
            left = starts[k + 1]!;
        }
        left--;
        names.set(id, { prefix, n: ++next });
    }
}

/**
 * Hook of a string import's `-J` search (dmd/expressionsem.d:9471), found or not: the unit depends on what the search
 * finds (null: nothing), which a file added to an earlier `-J` path, or created, changes.
 */
export function keepStringImport(name: DString, resolved: DString | null): void {
    const f = recFrame();
    if (f !== null)
        (f.u!.files ??= []).push({ name: name.slice(), resolved: resolved === null ? null : str(resolved), size: 0,
            mtime: 0, hash: null });
}

/** Hook of that string import's read (dmd/expressionsem.d:9497): the unit depends on the file's content too. */
export function keepFile(path: DString, content: Uint8Array): void {
    const f = recFrame();
    if (f === null)
        return;
    const dep = f.u!.files![f.u!.files!.length - 1]!;
    try {
        const st = statSync(str(path));
        dep.size = st.size;
        dep.mtime = st.mtimeMs;
        dep.hash = sha1(content);
    } catch {
        f.u!.flags |= F_ERROR;
    }
}

/**
 * Hook of `Module.load` finding no file for a module (dmd/dmodule.d:508 and :519, the read failing): the unit
 * depends on the module staying absent, as a gagged probe (`__traits(compiles, { import m; })`) or a package
 * without a package.d does.
 */
export function keepMiss(packages: readonly Identifier[], ident: Identifier): void {
    const f = recFrame();
    if (f !== null)
        (f.u!.misses ??= []).push({ packages: [...packages], ident });
}

/**
 * Hook of addDeferredSemantic2/3 (dmd/dsymbolsem.d:737/:747), before their `deferred2`/`deferred3` test: the running
 * unit puts `s` on the list that main.d's runDeferredSemantic2/3 (dmd/main.d:742/:767) analyses after every module's
 * pass, outside any unit; a replay of this point must put it there too. Every call is recorded (the list
 * deduplicates), and the symbol's flag is cleared before the next compile, which starts with empty lists.
 */
export function keepDeferredPass(s: Dsymbol, pass: 2 | 3): void {
    deferredSyms.add(s);
    logEvent(OP_DEFER, pass, s);
}

/**
 * Hook of `getTypeInfoAssocArrayDeclaration` (dmd/typinf.d:177-191): the TypeInfo declaration of naked AA type `t`,
 * made by `make` for a type that has none, and in a kept compile the kept one. Its semantic3 is a unit
 * (`KeepUnit.tinfo`), and the kept compile empties its type's `vtinfo` (`keepPrepare`), so that its first request
 * in a compile creates it as a fresh compile's does, here or in a replay (OP_TINFO): the type's `vtinfo`, the
 * requesting scope, the deferral of its semantic3.
 */
export function keepTypeInfoDecl(t: Type, make: () => TypeInfoDeclaration): TypeInfoDeclaration {
    let ti = tinfos.get(t);
    if (ti === undefined)
        tinfos.set(t, ti = make());
    return ti;
}

/**
 * Hook at the end of `genTypeInfo` (dmd/typinf.d:41-108) for an AA type: a request of the TypeInfo of naked type `t`
 * (`torig`, as requested). Where `t`'s TypeInfo is its own declaration (`keepTypeInfoDecl`; a qualified AA's is of
 * another kind), the running unit records the request with its scope, once per type requested, and the type table
 * entries that now hold the declaration as `vtinfo` are noted, to be emptied before each kept compile (an AA
 * literal's `expressionSemanticDone` reads it, dmd/expressionsem.d:15689-15690).
 */
export function keepTypeInfo(t: Type, torig: Type, sc: Scope | null): void {
    const ti = t.vtinfo;
    if (tinfos.get(t) !== ti)
        return;     // a qualified AA type's TypeInfo, not a declaration with a semantic3
    const table = B!.typeTable();
    const tt = torig !== t && torig.deco !== null && table.get(torig.deco)?.value === torig ? torig : null;
    tinfoTypes.add(t);
    if (tt !== null)
        tinfoTypes.add(tt);
    const f = recFrame();
    if (f === null)
        return;
    if (f.seen === null)
        f.seen = new Set();
    if (f.seen.has(tt ?? ti))
        return;
    f.seen.add(tt ?? ti);
    logEvent(OP_TINFO, ti, sc, tt);
}

/**
 * Hook after dmd/semantic3.d:1700, :1716 and :1732: an AA TypeInfo's semantic3 sets the `minst` of an instance it
 * requested, after the instance's creation; its replay sets it again (a root module recorded as the compile's first
 * root, as `logInstRequest` records a request's).
 */
export function keepMinst(ti: TemplateInstance): void {
    const m = ti.minst;
    logEvent(OP_MINST, ti, m === null ? null : m.isRoot() ? MINST_ROOT : m);
}

/**
 * Hook after `semanticRTInfo` set `ad.getRTInfo` (dmd/semantic3.d:1896), its guard: inside a unit, the unit's replay
 * requests the `RTInfo!T` instance again and the field keeps its value; outside every unit (the end-of-compile
 * semantic3 of a library struct, dmd/semantic3.d:1637-1641 and :1865), nothing replays it, so the field is emptied
 * before the next kept compile, whose run instantiates `RTInfo!T` again where a fresh compile does.
 */
export function keepRTInfo(ad: AggregateDeclaration): void {
    if (recFrame() === null)
        rtinfoTop.add(ad);
}

/**
 * Hook of the lexer's __DATE__, __TIME__ and __TIMESTAMP__ (dmd/lexer.d:656-663): the token is this compile's
 * clock (dmd/globals.d:518-546), which a later compile does not share: the module parsed, or the unit that lexed
 * a mixin, is analysed again by every compile.
 */
export function keepClock(): void {
    if (parsing !== null) {
        parsing.clock = true;
        return;
    }
    const f = recFrame();
    if (f !== null)
        f.u!.flags |= F_CLOCK;
}

/**
 * Hook of a selective import marking the member it found with errors (dmd/dsymbolsem.d:3571-3574, a member not
 * visible): a write into the analysed state of the member's container, which it keeps into the next compile, where a
 * fresh compile starts without the mark and reports the error again. When the member is not in the running unit's
 * container (or no unit records), its container is dropped by the next plan (`computeDeadSet`, step 1b).
 */
export function keepForeignErrors(s: Dsymbol): void {
    const c = containerOf(s);
    const f = recFrame();
    if (c !== null && (f === null || unitContainer(f.u!) !== c))
        errorMarked.add(c);
}

/**
 * Hook of `__FILE_FULL_PATH__` (dmd/expressionsem.d:17134): the unit made a path absolute against the working
 * directory; a compile from another directory analyses it again.
 */
export function keepCwd(): void {
    const f = recFrame();
    if (f !== null)
        f.u!.flags |= F_CWD;
}

/** The compile in which an AA type table entry's `loc` was last set by its first merge (`aaLoc`). */
const aaLocGen = new WeakMap<Type, number>();

/**
 * An AA type table entry merged, at its insertion (`keepType`) or found (`keepMergeFound`). A fresh compile's entry is
 * the object its first merge in the compile inserted, with that type's `loc` (dmd/typesem.d:3466), which the AA
 * TypeInfo's semantic3 reports and instantiates at (dmd/semantic3.d:1669) and `semanticTypeInfo` passes on
 * (dmd/expressionsem.d:18805); a kept entry has the `loc` of the compile that inserted it. As instance creation is
 * emulated, the first merge of a kept entry in a compile, live or replayed (OP_AALOC, once per log), sets its `loc`.
 */
function aaLoc(entry: Type, loc: Loc): void {
    if (aaLocGen.get(entry) !== compileNo) {
        aaLocGen.set(entry, compileNo);
        (entry as TypeAArray).loc = loc;
    }
    const f = recFrame();
    if (f === null)
        return;
    if (f.locs === null)
        f.locs = new Set();
    if (f.locs.has(entry))
        return;
    f.locs.add(entry);
    logEvent(OP_AALOC, entry, loc);
}

/**
 * Hook of the AA merges that pass by `merge`'s insert and find: `visitAArray`'s return of a type merged already
 * (dmd/typesem.d:3461-3464; a template's `int[int]` is one object that every instance shares through `syntaxCopy`, the
 * table entry when it was inserted, whose next analysis returns there), and `merge2` putting back an entry the engine
 * dropped (`keepType`), with the entry's own `loc`, since that merge has none. For the table entry, it is a merge as
 * `aaLoc` takes it.
 */
export function keepMergedAA(t: Type, loc: Loc): void {
    if (t.deco !== null && B!.typeTable().get(t.deco)?.value === t)
        aaLoc(t, loc);
}

/**
 * Hook of `merge` (dmd/typesem.d:4813) creating a Type.stringtable entry. The first merge of a mangling decides the
 * object every later merge gets; an entry whose `next` is not the canonical type of its own mangling (`&f` of a
 * function whose type the analysis gave inferred `scope` or `@system` after merging it, dmd/funcsem.d) carries its
 * creator's analysis. The running unit keeps such an entry: when the unit dies, the entry goes with it, and the
 * new compile's first merge creates it again, from that compile's analysis, as a fresh compile would. Entries
 * built only of canonical types stay: dropping them would give kept code and new code two objects of one
 * mangling, which the frontend's identity comparisons of merged types do not expect. An entry over a symbol notes
 * the unit that created it, for `keepMergeFound`.
 */
export function keepType(t: Type): void {
    if (t.ty === B!.Taarray)
        aaLoc(t, (t as TypeAArray).loc);
    const sym = (t as { sym?: Dsymbol | null }).sym;
    if (sym !== undefined && sym !== null) {
        const f = recFrame();
        if (f !== null)
            entryCreators.set(t, f.u!);
    }
    const next = (t as Partial<Record<TypeField, unknown>>).next as Type | null | undefined;
    if (next === null || next === undefined || next.deco === null || B!.typeTable().get(next.deco)?.value === next)
        return;
    const f = recFrame();
    if (f !== null)
        (f.u!.types ??= []).push(t);
}

/**
 * Hook of `merge` (dmd/typesem.d:4870) finding the table entry of another symbol's type: two declarations of two
 * modules share a mangling, which only C types do (an ImportC struct, union or enum mangles without its module;
 * two C modules including one header share its types). Every merge of the mangling gives the first merged
 * declaration, so what the later module's analysis resolved depends on the other module being loaded, and first. A
 * kept compile finding the entry of a module it has not loaded (a kept one the edit dropped from the imports, or the
 * replaced version of an edited one) aborts; so does one finding the entry of a module loaded after the merging one
 * (whose own declaration a fresh compile may have merged first), unless the unit that created the entry ran or
 * replayed in this compile before this merge, as in a fresh one (the load order is not the merge order: a C module's
 * types merge where its declarations are analysed). Otherwise the pair is remembered (`cShares`), for `sharesWrong`
 * and the dead set (a module that took the C types of a dead one dies with it). The pair also notes whether the
 * merging analysis read the other declaration before its size was final (`early`): the later struct's semantic
 * compares the two field lists (dmd/dsymbolsem.d:4915, `isCCompatible`), and the size's finalization rebuilds the
 * other's list without its anonymous bit-fields (dmd/dsymbolsem.d:10171, :8689-8693), which the kept declaration
 * holds from then on; so the other module dies with a dead merging one, whose analysis again reads it as it was. A
 * kept compile whose merge reads a kept declaration with a final size that the unit which finalized it (`keepSized`)
 * has not yet run or replayed before, where a fresh compile's would not be final, aborts; so does one reading a size
 * no unit finalized (work outside every unit, whose place a merge cannot be ordered against; an application's C shims
 * finalize every size inside a unit).
 */
export function keepMergeFound(type: Type, found: Type): void {
    if (found.ty === B!.Taarray)
        aaLoc(found, (type as TypeAArray).loc);
    const a = (type as { sym?: Dsymbol | null }).sym;
    const b = (found as { sym?: Dsymbol | null }).sym;
    if (a === undefined || a === null || b === undefined || b === null || a === b)
        return;
    const m = a.getModule(), w = b.getModule();
    if (m === null || w === null || m === w)
        return;
    const ad = b.isAggregateDeclaration();
    if (kept) {
        const order = B!.Module.amodules.opSlice();
        const iw = order.indexOf(w);
        const creator = entryCreators.get(found);
        const mergedBefore = creator !== undefined && stateOf(creator) === 2;
        if (iw < 0 || (iw > order.indexOf(m) && !mergedBefore))
            throw new KeepAbort(`${describe(a)} of ${describe(m)} has the type of ${describe(b)} of ${describe(w)}, `
                + `${iw < 0 ? "not loaded" : "loaded after it"} (C types mangle without their module)`);
        if (ad !== null && ad.sizeok === B!.Sizeok.done && !sizedBefore(ad))
            throw new KeepAbort(`${describe(a)} of ${describe(m)} reads ${describe(b)} of ${describe(w)}, whose size `
                + "a fresh compile has not finalized here");
    }
    const early = ad !== null && ad.sizeok !== B!.Sizeok.done;
    const pair = cShares.find((p) => p.m === m && p.w === w);
    if (pair === undefined)
        cShares.push({ m, w, early });
    else
        pair.early ||= early;
}

/**
 * Whether the unit that finalized C aggregate `ad`'s size ran or replayed in this compile before this point: done, or
 * running for real (a replay in progress may finalize it at a later event).
 */
function sizedBefore(ad: Dsymbol): boolean {
    const u = sizers.get(ad);
    if (u === undefined || u === null)
        return false;
    const st = stateOf(u);
    return st === 2 || (st === 1 && !stack.some((f) => f.u === u && f.replay));
}

/**
 * Hook of `finalizeSize` (dmd/dsymbolsem.d:9862) for a C aggregate: the running unit finalizes its size, which a later
 * merge may read (`keepMergeFound`).
 */
export function keepSized(ad: Dsymbol): void {
    const f = recFrame();
    sizers.set(ad, f === null ? null : f.u);
}

/**
 * The end check of a kept compile for `cShares`: a kept module that took another module's C types loads in this
 * compile and the other does not, where a fresh compile would give them its own declarations. Returns why, or null.
 * Cost: one pass over the pairs.
 */
/**
 * At the end of a kept compile, what a fresh compile would print or compute otherwise because this compile numbered
 * generated identifiers otherwise: a unit replayed before the shift was found that printed what looks like a generated
 * name (F_GEN); a string made in this compile, by a unit run or replayed (`keepString`), that names an identifier of a
 * replayed unit or registered parse by the number it had when recorded, not the one this compile gave it
 * (`__traits(allMembers)` of a kept struct with an anonymous bit-field, a kept lambda's `.stringof`). Else null. Cost:
 * nothing without such a string or without a shift; else one pass over the replayed units' identifiers.
 */
function generatedWrong(): string | null {
    const u = genReplayed;
    if (u !== null && shifted)
        return `${KeepUnit[u.kind]} of ${describe(u.owner)} prints a generated name, numbered otherwise in this `
            + "compile";
    if (!renumbered || madeStrings.length === 0)
        return null;
    const stale = staleSpellings();
    for (const text of madeStrings) {
        for (const word of text.match(/[A-Za-z_]\w*/g) ?? []) {
            if (stale.has(word))
                return `a string made in this compile names \`${word}\`, a generated name, numbered otherwise in this `
                    + "compile";
        }
    }
    return null;
}

/**
 * The spellings, as recorded, of the generated identifiers this compile numbered otherwise: those of the units it
 * replayed and the parses it registered whose numbers moved.
 */
function staleSpellings(): Set<string> {
    const stale = new Set<string>();
    const fresh = new Map<Identifier, FreshNumber>();
    for (const [u, starts] of replayStarts) {
        freshNumbers(u.ids, starts, fresh);
        for (const [id, , own] of u.ids) {
            if (fresh.get(id)!.n !== own)
                stale.add(td.decode(id.toString()));
        }
        fresh.clear();
    }
    for (const r of mods.values()) {
        if (r.regGen === compileNo && r.parseGen !== compileNo && r.parseLive !== r.parseAt) {
            for (const [id] of r.parseIds)
                stale.add(td.decode(id.toString()));
        }
    }
    return stale;
}

function sharesWrong(): string | null {
    for (const { m, w } of cShares) {
        if (mods.get(m)?.regGen === compileNo && !B!.Module.amodules.contains(w))
            return `${describe(m)} took C types of ${describe(w)}, which this compile does not load`;
    }
    return null;
}

/**
 * Hook of `Module.search` (dmd/dsymbolsem.d:8035): a live lookup into a kept module whose semantic1 has not been
 * replayed in this compile would see its analysed symbols where a fresh compile sees them unanalysed.
 */
export function keepSearch(m: Module): void {
    if (!kept)
        return;
    const s1 = unitOf(m, KeepUnit.sem1);
    if (s1 === undefined || stateOf(s1) !== 0 || mods.get(m) === undefined)
        return;
    const top = stack[stack.length - 1];
    if (top !== undefined && top.replay)
        return;
    throw new KeepAbort(`lookup into ${describe(m)} before its semantic`);
}

// ── the module tree ────────────────────────────────────────────────────────────────────────────────────────

/** Puts `sym` under `id` in `table` unless it is there; another symbol there is a conflict (abort). */
function ensure(table: DsymbolTable, id: Identifier, sym: Dsymbol): void {
    const old = table.lookup(id);
    if (old === sym)
        return;
    if (old !== null)
        throw new KeepAbort(`module tree conflict on ${str(id)}`);
    table.insertByIdent(id, sym);
    logEvent(OP_TREE, table, id, sym);
}

/**
 * Hook of a miss in `Package.resolve` (dmd/dmodule.d:183): a kept package of the previous compile's tree goes back
 * where a fresh compile would create it, as the same object (kept symbols point to it). Returns it, or null.
 */
export function keepPackage(table: DsymbolTable, id: Identifier): Package | null {
    if (!kept)
        return null;
    const p = dormantPkgs.get(table)?.get(id);
    if (p === undefined)
        return null;
    ensure(table, id, p);
    return p;
}

/**
 * Hook of a miss in `Module.parse`'s lookup of a package.d file's wrapping package (dmd/dmodule.d:907-916): the
 * kept package of that name, if any, not yet back in `table`, which the parse then inserts. A fresh compile
 * creates a new Package there; the kept one stands for it, as `keepPackage` does for `Package.resolve`, because the
 * kept submodules registered later have it as their parent (a new one would conflict with it, an abort).
 */
export function keepWrappingPackage(table: DsymbolTable, id: Identifier): Package | null {
    return kept ? dormantPkgs.get(table)?.get(id) ?? null : null;
}

/**
 * Hook of `Package.resolve` finding module `m` where a package name goes (dmd/dmodule.d:190-212: `module a.b;` while
 * an `a.d` is loaded, an error the parse of `a.b` reports at dmd/dmodule.d:864-867). `m`'s symbol table becomes a
 * package's: made here when `m`'s importAll has not run (dmd/dmodule.d:200-201; the importAll then adds no members,
 * dmd/dsymbolsem.d:8412), and the module named gets an entry in it (dmd/dmodule.d:921, dmd/dsymbolsem.d:8540). The
 * record says who made the table (`asPackage`). Before the next kept compile the table loses the tree's entries, or
 * goes when no importAll ran on it (`keepPrepare`), and the next use puts them back; an importAll that runs for real
 * before any use makes its own table (`keepRun`), and one that ran on a table made here replays only after such a use
 * in the same compile (`replayUnit`). In a kept compile the first use must find a kept `m`'s table as a fresh compile
 * has it there: its members' exactly when its importAll has run in this compile; otherwise the compile aborts. A
 * module without a record (no file) is not kept.
 */
export function keepModuleAsPackage(m: Module): void {
    const r = mods.get(m);
    if (r === undefined || r.asPackageGen === compileNo)
        return;     // not kept, or used already in this compile (its table is then this compile's)
    const members = m.symtab !== null && r.asPackage !== "resolve";
    if (kept && keptNames.get(moduleName(m)) === m && (m._scope !== null) !== members)
        throw new KeepAbort(`${describe(m)} used as a package, its symbol table not a fresh compile's`);
    if (m.symtab === null)
        r.asPackage = "resolve";
    else
        r.asPackage ??= "importAll";
    r.asPackageGen = compileNo;
}

/** A symbol table's entries (`DsymbolTable.tab`, an AssocArray). */
function tableEntries(t: DsymbolTable): IterableIterator<[Identifier, Dsymbol]> {
    return (t as unknown as { tab: { asRange(): IterableIterator<[Identifier, Dsymbol]> } }).tab.asRange();
}

/**
 * Drops from a module's symbol table the entries the module tree put there (`keepModuleAsPackage`): the packages and
 * modules, which are never the module's own members.
 */
function dropTreeEntries(t: DsymbolTable): void {
    const rest = [...tableEntries(t)].filter(([, s]) => s.isPackage() === null);
    B!.clearTable(t);
    for (const [id, s] of rest)
        t.insertByIdent(id, s);
}

/** Hook after an insert into the module tree by `Package.resolve` (dmd/dmodule.d:186) or `load`
 * (dmd/dsymbolsem.d:8540). */
export function keepTree(table: DsymbolTable, id: Identifier, sym: Dsymbol): void {
    if (table.lookup(id) !== sym)
        return;     // the insert found the name taken (dmd/dsymbol.d:1597 returns null): nothing changed
    const p = sym.isPackage();
    if (p !== null && p.isModule() === null)
        pkgs.add(p);
    logEvent(OP_TREE, table, id, sym);
}

/** Hook of `isPkgMod = PKG.package_` (dmd/dmodule.d:277, dmd/dsymbolsem.d:8499). */
export function keepPkgMod(p: Package): void {
    logEvent(OP_PKG, p, null);
}

/**
 * Hook of `load`'s `importedFrom` (dmd/dsymbolsem.d:8544), at every load of an import: `from` is the importing
 * scope's module, or null. Recorded at every load, whether `m` was parsed here and its `importedFrom` set here or
 * not: a kept module starts every compile unregistered and with a null `importedFrom`, and the replay that reaches
 * it first (not always the unit that loaded it when recorded, when this compile imports the modules in another
 * order) registers it, if no parse event did, and sets `importedFrom`, if still null, as a fresh load would.
 */
export function keepImportedFrom(m: Module, from: Module | null, loc: Loc): void {
    logEvent(OP_IFROM, m, from, loc);
}

/**
 * Hook of `Module.load` (dmd/dmodule.d:498) once the file is found: a kept module for that file and name is
 * registered (its packages, its own entry, the module list, as a fresh parse would leave them, and `loc`, the
 * load's, as the module's) and returned; otherwise null, and the module about to be parsed is remembered with its
 * import name.
 */
export function keepLoad(packages: readonly Identifier[] | null, ident: Identifier, path: DString,
    loc: Loc): Module | null {
    const p = str(path);
    if (kept) {
        const r = modsByKey.get(modKey({ path: p, packages: packages === null ? [] : [...packages], ident }));
        if (r !== undefined && !r.root) {
            if (r.regGen === compileNo)
                throw new KeepAbort(`${describe(r.m)} loaded twice`);
            register(r, loc);
            return r.m;
        }
    }
    pendingLoad = { packages: packages === null ? [] : [...packages], ident, path: p };
    return null;
}

/**
 * Hook of `Module.parse` (dmd/dmodule.d:732). A kept compile registers a kept module instead of parsing it, from a
 * unit that runs for real (`register`) as from a replayed one (an AMOD or IFROM event), so what the parse did
 * belongs to the module, not to the unit that loaded it:
 *   - the generated-identifier numbers it consumes (a function literal's parameters, dmd/parse.d
 *     `parseParameterList`) are counted apart and added at the registration, where the parse would consume them;
 *     a parse that leaves no kept module (an early return of dmd/dmodule.d:956's, a file not on disk) gives them
 *     back to the recording unit;
 *   - a report (a syntax error or deprecation; the tree conflicts of dmd/dmodule.d:880-956, which depend on the
 *     modules parsed before) marks the module: the next kept compile drops it and parses it again (`keepPlan`).
 * A parse loads no module, so parses do not nest.
 */
export function keepParse(m: Module, parse: () => Module | null): Module | null {
    const p = parsing = { at: B!.suffixCounter(), ids: [] as GenId[], reported: false, clock: false };
    try {
        return parse();
    } finally {
        parsing = null;
        const r = mods.get(m);
        const f = recFrame();
        if (r !== undefined) {
            r.parseAt = p.at;
            r.parseIds = p.ids;
            r.parseGen = compileNo;
            r.parseReported = p.reported;
            r.clock = p.clock;
        } else if (f !== null && p.ids.length !== 0) {
            if (f.ids.length === 0)
                f.idsAt = p.at;
            for (const g of p.ids)
                f.ids.push(g);
        }
    }
}

/**
 * Registers kept module `r` as a fresh load and parse would (dmd/dmodule.d:514 and :880-956), its parse's numbers
 * included: `loc` is the load's, which a fresh load gives the new Module (the location of the module's
 * deprecation, dmd/dsymbolsem.d:2012), and its semantic the implicit `import object` made at it
 * (dmd/dsymbolsem.d:8409). Both are in the importer's file, which may be a root this compile parses again: its
 * old Loc range is dropped (`purgeLocFiles`), and the old locations would point into nothing.
 */
function register(r: ModRec, loc: Loc): void {
    const b = B!;
    const m = r.m;
    r.regGen = compileNo;
    const first = m.members !== null && m.members.length !== 0 ? m.members.opIndex(0) : null;
    const imp = first?.isImport() ?? null;
    if (imp !== null && imp.packages === null && imp.id !== null && str(imp.id) === "object"
        && imp.loc.index_ === m.loc.index_)
        imp.loc = loc.copy();
    m.loc = loc;
    // a compiled import (`-i`) is one by its name and the command line, which the kept state's key fixes: it is
    // promoted where its parse would promote it, so `compiledImports` holds the modules in a fresh compile's order
    b.checkCompiledImport(m);
    addParseCount(r);
    const chain: Package[] = [];
    for (let s: Dsymbol | null = m.parent; s !== null; s = s.parent)
        chain.unshift(s.isPackage()!);
    let table = b.Module.modules!;
    for (const p of chain) {
        ensure(table, p.ident!, p);
        table = p.symtab!;
    }
    let s: Dsymbol = m as unknown as Dsymbol;
    if (m.isPackageFile) {
        const p = m.pkg!;
        p.isPkgMod = b.PKG.module_;
        p.mod = m;
        logEvent(OP_PKG, p, m);
        s = p;
    }
    ensure(table, s.ident!, s);
    b.Module.amodules.push(m);
    logEvent(OP_AMOD, m, loc);
    restoreStatics(m);
}

/** A registration consumes the generated identifiers the module's parse consumed, as the parse would. */
function addParseCount(r: ModRec): void {
    const b = B!;
    if (r.parseIds.length !== 0 && b.suffixCounter() !== r.parseAt)
        shifted = renumbered = true;
    r.parseLive = b.suffixCounter();
    b.suffixCounter(b.suffixCounter() + r.parseIds.length);
}

/** The object.d statics that a parse of `m` (or its analysis) set come back with it. */
function restoreStatics(m: Module): void {
    const r = mods.get(m);
    if (r === undefined || r.statics.size === 0)
        return;
    const now = B!.objectStatics();
    for (const [i, v] of r.statics)
        now[i] = v;
    B!.objectStatics(now);
}

/** At the end of a compile: each object.d static is remembered by the module that holds its value. */
function rememberStatics(): void {
    B!.objectStatics().forEach((v, i) => {
        if (v === null || v === undefined)
            return;
        const c = containerOf(v);
        const r = c === null ? undefined : mods.get(c as Module);
        r?.statics.set(i, v);
    });
}

/** The full name of a module (`std.stdio`), from its package chain. */
function moduleName(m: Module): string {
    const parts: string[] = [];
    for (let p: Dsymbol | null = m as unknown as Dsymbol; p !== null; p = p.parent)
        parts.unshift(str(p.ident!));
    return parts.join(".");
}

/**
 * Hook at the end of `Module.parse` (dmd/dmodule.d:956): records the module's entry in the tree (TREE, PKG and AMOD
 * events) and makes the module kept, with the import name `keepLoad` remembered (none for a root).
 */
export function keepParsed(m: Module, table: DsymbolTable): void {
    const b = B!;
    if (m.isPackageFile && m.pkg !== null)
        logEvent(OP_PKG, m.pkg, m);
    const s: Dsymbol = m.isPackageFile && m.pkg !== null ? m.pkg : m as unknown as Dsymbol;
    if (table.lookup(s.ident!) === s)
        logEvent(OP_TREE, table, s.ident, s);
    const n = b.Module.amodules.length;
    if (n !== 0 && b.Module.amodules.opIndex(n - 1) === m)
        logEvent(OP_AMOD, m, m.loc);
    if (m.isPackageFile && m.pkg !== null)
        pkgs.add(m.pkg);
    const path = str(m.srcfile);
    const pl = pendingLoad !== null && pendingLoad.path === path ? pendingLoad : null;
    pendingLoad = null;
    let st;
    try {
        st = statSync(path);
    } catch {
        return;     // no file (a generated or virtual module): never kept
    }
    // read from a host's text override: a size no stat matches, so that the next compile compares the bytes
    const overridden = b.Module.djsTextOf(path) !== null;
    const r: ModRec = {
        m, path, packages: pl?.packages ?? null, ident: pl?.ident ?? null, root: pl === null,
        size: overridden ? -1 : st.size, mtime: st.mtimeMs, baseLen: m.members?.length ?? 0, scope: null,
        regGen: compileNo, statics: new Map(), parseIds: [], parseAt: 0, parseGen: compileNo, parseLive: 0,
        parseReported: false, clock: false, asPackage: null, asPackageGen: 0,
    };
    // a new module named as a kept one (another file) would meet the kept one's types, merged by their mangled
    // name in Type.stringtable: a fresh compile has only its own
    if (kept) {
        const other = keptNames.get(moduleName(m));
        if (other !== undefined && other !== m)
            throw new KeepAbort(`${moduleName(m)} from ${path} has the name of a kept module`);
    }
    mods.set(m, r);
    modsByKey.set(modKey(r), r);
}

/**
 * Hook of the driver after the root files are read (dmd/main.d:544): a kept root module whose file is unchanged
 * replaces, at index `i` of `modules`, the module the driver created for it; the driver's parse loop then
 * registers it (`keepRootParse`) instead of parsing it.
 */
export function keepRoot(m: Module,
    modules: { opIndex(i: number): Module | null; opIndexAssign(v: Module, i: number): void }, i: number): void {
    const path = str(m.srcfile);
    for (const r of mods.values()) {
        if (!r.root || r.path !== path)
            continue;
        if (!bytesEqual(r.m.src ?? new Uint8Array(), m.src ?? new Uint8Array()))
            throw new KeepAbort(`${path} changed while compiling`);
        modules.opIndexAssign(r.m, i);
        return;
    }
}

/** Hook of the driver's parse loop (dmd/main.d:586): registers an adopted kept root in place of its parse. */
export function keepRootParse(m: Module): boolean {
    if (!kept)
        return false;
    const r = mods.get(m);
    if (r === undefined || !r.root)
        return false;
    register(r, m.loc);
    return true;
}

// ── replay ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The current gag level for an event recorded at `a` in a unit entered at `e`, now entered at `E`. */
function mapGag(a: number, e: number, E: number): number {
    if (a === 0)
        return 0;
    return Math.max(1, E + (a - e));
}

/**
 * The first event of the unit, or of a unit it requests, that a different gag at its entry would print
 * differently (F_OBS), described for an abort's reason; null when there is none.
 */
function observable(u: UnitRec, seen = new Set<UnitRec>()): string | null {
    if (seen.has(u))
        return null;
    seen.add(u);
    const log = u.log;
    for (let i = 0; i < log.length; i += opLength(log[i] as number)) {
        const op = log[i];
        if ((u.flags & F_OBS) !== 0) {
            if (op === OP_WRITE)
                return `${describe(u.owner)} writes ${JSON.stringify(String(log[i + 2]).slice(0, 60))}`;
            if (op === OP_TRACE)
                return `${describe(u.owner)} traces ${describe(log[i + 2])}`;
            if (op === OP_REP && !(log[i + 2] as boolean)) {
                const loc = log[i + 4] as SourceLoc;
                return `${describe(u.owner)} reports \`${str(log[i + 5] as DString).slice(0, 60)}\` at `
                    + `${str(loc.filename)}(${loc.line})`;
            }
        }
        // a request made inside a gag window of this unit replays gagged whatever this unit's entry
        if ((op === OP_REQ || op === OP_REQI) && !(log[i + 4] as boolean)) {
            const r = observable(log[i + 1] as UnitRec, seen);
            if (r !== null)
                return r;
        }
    }
    return null;
}

function describe(o: unknown): string {
    try {
        return str((o as { toPrettyChars(): DString }).toPrettyChars());
    } catch {
        return "?";
    }
}

/** The guard value of a kind while its unit runs (the D in-progress mark). */
function inProgress(kind: KeepUnit): number {
    const P = B!.PASS;
    switch (kind) {
        case KeepUnit.sem1: case KeepUnit.inst: case KeepUnit.alias: return P.semantic;
        case KeepUnit.sem2: case KeepUnit.isem2: return P.semantic2;
        default: return P.semantic3;
    }
}

/**
 * Replays kept unit `u` at the current point (see THE MODEL): checks that its entry environment equals the
 * recorded one where it matters, sets the owner's in-progress state, runs the log, sets the post state (unless
 * `keepOpen`: a module pass whose live tail follows; its D visitor sets the post state).
 */
function replayUnit(u: UnitRec, keepOpen = false): void {
    const b = B!;
    const g = b.global;
    if ((u.flags & F_NOREPLAY) !== 0)
        throw new KeepAbort(`${KeepUnit[u.kind]} of ${describe(u.owner)} cannot replay`);
    const defers = (u.flags & F_DEFERS) !== 0;
    if (defers && !sameDeferred(u.defIn))
        throw new KeepAbort(`other deferred symbols at the replay of ${describe(u.owner)}, which defers or retries`);
    const E = g.gag;
    const spec = g.params.v.showGaggedErrors;
    const gagSame = spec ? E === u.e : (E === 0) === (u.e === 0);
    const owner = u.owner as Dsymbol & { gagged?: boolean };
    const envSame = gagSame && g.params.useDeprecated === u.dep
        && (u.kind < KeepUnit.isem2 || u.kind > KeepUnit.isem3 || owner.gagged === u.gagged);
    const obs = envSame ? null : observable(u);
    if (obs !== null)
        throw new KeepAbort(`${KeepUnit[u.kind]} of ${describe(u.owner)} replayed in another state (gag ${E}, `
            + `recorded ${u.e}; gagged ${owner.gagged ?? "-"}, recorded ${u.gagged}): ${obs}`);
    // the generated names in its AST, and in what it prints, were numbered from `c0`
    if (u.ids.length !== 0 && b.suffixCounter() !== u.c0)
        shifted = true;
    if ((u.flags & F_GEN) !== 0) {
        if (shifted)
            throw new KeepAbort(`${KeepUnit[u.kind]} of ${describe(u.owner)} prints a generated name, numbered `
                + "otherwise in this compile");
        genReplayed ??= u;
    }
    if (u.strings !== null) {
        for (const text of u.strings)
            madeStrings.push(text);
    }
    if (u.kind === KeepUnit.importAll) {
        // an importAll that ran on a table another module's name made (`keepModuleAsPackage`) added no members to it: a
        // fresh compile where that name is not resolved first adds them
        const r = mods.get(owner as unknown as Module)!;
        if (r.asPackage === "resolve" && r.asPackageGen !== compileNo)
            throw new KeepAbort(`importAll of ${describe(owner)} without the package use that made its symbol table`);
    }
    setState(u, 1);
    stats.replayed++;
    if (u.kind === KeepUnit.importAll)
        (owner as unknown as Module)._scope = mods.get(owner as unknown as Module)!.scope as Module["_scope"];
    else
        owner.semanticRun = inProgress(u.kind);
    stack.push(newFrame(u, true));
    try {
        runLog(u, E);
    } finally {
        stack.pop();
    }
    setState(u, 2);
    if (defers)
        setDeferred(u.defOut);
    if (u.kind === KeepUnit.inst && (owner as unknown as TemplateInstance).inst === null)
        owner.semanticRun = b.PASS.initial;     // dmd/templatesem.d:1432, a creation that failed gagged
    else if (!keepOpen && u.kind !== KeepUnit.importAll) {
        owner.semanticRun = u.post;
        setErrFlags(owner, u.errPost);
        const an = aliasNext.get(u);
        if (an !== undefined)
            (owner as unknown as AliasDeclaration).overnext = an.post;
    }
}

function runLog(u: UnitRec, E: number): void {
    const b = B!;
    const g = b.global;
    const log = u.log;
    const e = u.e;
    for (let i = 0; i < log.length; i += opLength(log[i] as number)) {
        switch (log[i] as number) {
            case OP_REQ: {
                const v = log[i + 1] as UnitRec;
                const st = stateOf(v);
                // a request of a unit running in one compile and pending in the other is an import cycle entered
                // from another side: work on the half-analysed side moves between the two units' logs (a lazy
                // analysis of the other module's symbols), so where either of them prints, the order of the
                // output would change and the replay stops; where neither prints (nor anything they request),
                // the request goes as a fresh compile's would: the pending unit replays here, the running one
                // does not. importAll's rest (its members' importAll) reads nothing of the requested one's.
                if ((log[i + 3] as boolean) !== (st === 1) && v.kind !== KeepUnit.importAll
                    && (observable(v) !== null || observable(u) !== null))
                    throw new KeepAbort(`${KeepUnit[v.kind]} of ${describe(v.owner)} requested in another state`);
                if (st !== 0)
                    break;
                const saved = g.gag;
                const ge = g.gaggedErrors;
                g.gag = mapGag(log[i + 2] as number, e, E);
                try {
                    replayRequest(v);
                } finally {
                    g.gag = saved;
                }
                if (log[i + 4] as boolean)
                    endWindow(ge);
                break;
            }
            case OP_REQI: {
                const v = log[i + 1] as UnitRec;
                const st = stateOf(v);
                if ((log[i + 3] as boolean) !== (st === 1))
                    throw new KeepAbort(`creation of ${describe(v.owner)} requested in another state`);
                const ti = v.owner as TemplateInstance;
                // a request that created the instance and is now a match, or the reverse: a creation runs the
                // instance's semantic2 at once and, inside a function, its semantic3 (dmd/templatesem.d:1369, :1381,
                // :1460-1462), whose requests follow in the creator's log; a match runs neither (dmd/templatesem.d:
                // 1013-1161). Where a pending one prints, it would print at another point than in a fresh compile
                if ((log[i + 8] as boolean) !== (st === 0)) {
                    for (const k of [KeepUnit.isem2, KeepUnit.isem3]) {
                        const w = unitOf(ti, k);
                        const obs = w !== undefined && stateOf(w) === 0 ? observable(w) : null;
                        if (obs !== null)
                            throw new KeepAbort(`creation of ${describe(ti)} requested in another state: ${obs}`);
                    }
                }
                const tinst = log[i + 6] as TemplateInstance | null;
                const spec = log[i + 7] as Module | number | null;
                const minst = spec === null ? null : spec === MINST_TINST ? tinst!.minst
                    : spec === MINST_ROOT ? b.Module.rootModule : spec as Module;
                const saved = g.gag;
                const ge = g.gaggedErrors;
                g.gag = mapGag(log[i + 2] as number, e, E);
                try {
                    if (st === 0) {
                        if (!unitsOf.has(ti))
                            throw new KeepAbort(`request of dead instance ${describe(ti)}`);
                        createKept(v, log[i + 5] as Loc, tinst, minst, g.gag > 0);
                    } else
                        b.instanceMatch(ti, minst, tinst, g.gag > 0);
                } finally {
                    g.gag = saved;
                }
                if (log[i + 4] as boolean)
                    endWindow(ge);
                break;
            }
            case OP_REP: {
                const saved = g.gag;
                const inWin = log[i + 2] as boolean;
                const ge = g.gaggedErrors;
                g.gag = mapGag(log[i + 1] as number, e, E);
                reportDepth++;
                try {
                    b.report(log[i + 3] as boolean, log[i + 4] as SourceLoc, log[i + 5] as DString,
                        log[i + 6] as unknown[], log[i + 7] as number, log[i + 8] as DString | null,
                        log[i + 9] as DString | null);
                } finally {
                    reportDepth--;
                    g.gag = saved;
                }
                if (inWin)
                    endWindow(ge);
                break;
            }
            case OP_TRACE: {
                const saved = g.gag;
                g.gag = mapGag(log[i + 1] as number, e, E);
                traceDepth++;
                try {
                    b.printInstantiationTrace(log[i + 2] as TemplateInstance, log[i + 3] as number,
                        log[i + 4] as number);
                } finally {
                    traceDepth--;
                    g.gag = saved;
                }
                break;
            }
            case OP_APPEND: {
                // a module's appended members were dropped before this compile; an instance keeps its own
                const c = log[i + 1] as Module | ScopeDsymbol;
                const ms = c.members!;
                if (c.isModule() !== null || !ms.contains(log[i + 2] as Dsymbol))
                    ms.push(log[i + 2] as Dsymbol);
                break;
            }
            case OP_CNT: {
                const n = log[i + 1] as number;
                const at = b.suffixCounter();
                if (at !== (log[i + 2] as number))
                    renumbered = true;
                let starts = replayStarts.get(u);
                if (starts === undefined)
                    replayStarts.set(u, starts = []);
                starts.push(at, n);
                b.suffixCounter(at + n);
                break;
            }
            case OP_WRITE: {
                const s = log[i + 1] as number;
                reportDepth++;
                try {
                    (s === 1 ? process.stdout : process.stderr).write(log[i + 2] as string | Uint8Array);
                } finally {
                    reportDepth--;
                }
                break;
            }
            case OP_TREE:
                ensure(log[i + 1] as DsymbolTable, log[i + 2] as Identifier, log[i + 3] as Dsymbol);
                break;
            case OP_PKG: {
                const p = log[i + 1] as Package;
                const m = log[i + 2] as Module | null;
                if (m === null)
                    p.isPkgMod = b.PKG.package_;
                else {
                    p.isPkgMod = b.PKG.module_;
                    p.mod = m;
                }
                break;
            }
            case OP_AMOD: {
                const m = log[i + 1] as Module;
                const r = mods.get(m);
                if (r === undefined)
                    throw new KeepAbort(`registration of dead module ${describe(m)}`);
                // the whole registration, its parent packages included: the recording may have found them in the
                // tree, put there by a unit this compile does not replay (an import of a sibling module by the root)
                if (r.regGen !== compileNo)
                    register(r, log[i + 2] as Loc);
                break;
            }
            case OP_DEFS:
                setDeferred(log[i + 1] as Dsymbol[] | null);
                break;
            case OP_TIDEFER:
                b.deferSemantic3(log[i + 1] as TemplateInstance);
                break;
            case OP_DEFER: {
                const s = log[i + 2] as Dsymbol;
                // a TypeInfo declaration's deferral is its creation's, which the request after it replays (OP_TINFO)
                const tid = s.isTypeInfoDeclaration();
                if (tid !== null && tinfos.get(tid.tinfo) === tid)
                    break;
                const c = containerOf(s);
                if (c !== null && !isKept(c))
                    throw new KeepAbort(`deferral of ${describe(s)}, which is not kept`);
                b.addDeferred(s, log[i + 1] as 2 | 3);
                break;
            }
            case OP_TINFO: {
                // the first request of an AA type's TypeInfo in this compile redoes the creation on the kept
                // declaration as dmd/typinf.d:185-189 does: the type's `vtinfo`, the requesting scope, the deferral
                const ti = log[i + 1] as TypeInfoDeclaration;
                const sc = log[i + 2] as Scope | null;
                const tt = log[i + 3] as Type | null;
                const t = ti.tinfo;
                if (tinfos.get(t) !== ti)
                    throw new KeepAbort(`request of ${describe(ti)}, which is not kept`);
                if (t.vtinfo === null) {
                    if (sc === null)
                        throw new KeepAbort(`${describe(ti)} first requested without a scope`);
                    t.vtinfo = ti;
                    ti._scope = sc;
                    sc.setNoFree();
                    b.addDeferred(ti, 3);
                }
                if (tt !== null && tt.vtinfo === null)
                    tt.vtinfo = ti;
                break;
            }
            case OP_MINST: {
                const spec = log[i + 2] as Module | number | null;
                (log[i + 1] as TemplateInstance).minst = spec === null ? null : spec === MINST_ROOT
                    ? b.Module.rootModule : spec as Module;
                break;
            }
            case OP_AALOC: {
                const entry = log[i + 1] as TypeAArray;
                if (aaLocGen.get(entry) !== compileNo) {
                    aaLocGen.set(entry, compileNo);
                    entry.loc = log[i + 2] as Loc;
                }
                break;
            }
            case OP_IFROM: {
                const m = log[i + 1] as Module;
                const from = log[i + 2] as Module | null;
                // the recording found `m` loaded already (no parse events in this log), but this compile may reach
                // it here first: then a fresh compile loads it here
                const r = mods.get(m);
                if (r === undefined)
                    throw new KeepAbort(`load of dead module ${describe(m)}`);
                if (r.regGen !== compileNo)
                    register(r, log[i + 3] as Loc);
                if (m.importedFrom === null)
                    m.importedFrom = from !== null ? from.importedFrom : b.Module.rootModule;
                break;
            }
            default:
                throw new Error("keep: bad log");
        }
    }
}

/**
 * The counters' part of `endGagging` (dmd/globals.d:481) for what an event made inside a gag window the replayed unit
 * opened: the window's end, which the replay does not run, takes back the gagged errors counted since `ge`.
 */
function endWindow(ge: number): void {
    const g = B!.global;
    g.errors -= g.gaggedErrors - ge;
    g.gaggedErrors = ge;
}

/** A replayed request of pending unit `v`: what its guard-passing entry would do. */
function replayRequest(v: UnitRec): void {
    const b = B!;
    switch (v.kind) {
        case KeepUnit.sem2:
            b.semantic2(v.owner as Module);
            return;
        case KeepUnit.sem3:
            b.semantic3(v.owner as Module);
            return;
        case KeepUnit.isem2:
        case KeepUnit.isem3: {
            const iu = unitOf(v.owner, KeepUnit.inst);
            if (iu !== undefined && stateOf(iu) === 0)
                throw new KeepAbort(`${KeepUnit[v.kind]} of ${describe(v.owner)} before its creation in this compile`);
            replayUnit(v);
            return;
        }
        case KeepUnit.tinfo:
            // reached only from the end-of-compile list, outside every unit (`keepRun` checks its scope and `loc`)
            throw new KeepAbort(`semantic3 of ${describe(v.owner)} requested from a unit`);
        case KeepUnit.fsem3: {
            const c = containerOf(v.owner as Dsymbol);
            const ti = c !== null ? c.isTemplateInstance() : null;
            if (ti !== null && (v.flags & F_EARLY) === 0) {
                const iu = unitOf(ti, KeepUnit.inst);
                if (iu !== undefined && stateOf(iu) === 0)
                    throw new KeepAbort(`semantic3 of ${describe(v.owner)} in an instance not created`);
            }
            replayUnit(v);
            return;
        }
        default:
            replayUnit(v);
    }
}
