// Ported from dmd/compiler.d (module dmd.compiler).
//
// Describes a back-end compiler and implements compiler-specific actions.
//
// WHOLE FILE (P5.0 wave 16). Top-level D declarations, in source order: the `__gshared` block
// (`includeImports`, `includeModulePatterns`, `compiledImports`, :36-42), `struct Compiler` (:49), the
// private `ModuleComponentRange` (:183), `includeImportedModuleCheck` (:208), `MatcherNode` (:244),
// `includeByDefault` / `matchNodes` (:280-281), `createMatchNodes` (:287), `parseModulePatternDepth`
// (:343) with its unittest (:357), and `parseModulePattern` (:375). All translated; the one
// version-gated block is resolved away (below).
//
// RESOLUTIONS applied (docs/porting):
//   - resolved: version(DMDLIB) OFF (_config.md §1) -> `version = CallbackAPI` (compiler.d:31-34) is
//     never set, so CallbackAPI is OFF too (_config.md §1): compiler.d:156 — `version (CallbackAPI)`, the
//     block inside `Compiler` through :176 holding `onStatementSemanticStart` / `onStatementSemanticDone`
//     and their aliases, is dropped (07 §1.4).
//   - IN_LLVM: compiler.d carries no `version (IN_LLVM)` block in 1.43.0. Its one LDC-specific line is
//     the `MatcherNode(Id.ldc)` default exclusion (compiler.d:325, commented `// IN_LLVM`), which is
//     unconditional source and is kept.
//   - `__gshared` module state -> module-scope bindings (01 §5). `includeImports` is a scalar the driver
//     sets, so it is an exported `let` with a setter (a TS `let` export cannot be reassigned by its
//     importers; the errors.ts `diagnosticHandler` precedent). The two containers are exported `const`
//     references, mutated in place as D mutates them.
//   - `private` declarations stay module-private (01 §2.5), except `parseModulePatternDepth`, exported
//     for its ported unittest in compiler.test.ts (10 §1.7).
//
// No driver-only part of compiler.d is dropped: the `-i` machinery (`onImport` and its private helpers)
// is reached from `Module.parseModule` (dmodule.d:785) and is frontend logic; the shim only has to fill
// `includeImports` / `includeModulePatterns` from its command line.

import { FileType, Tfloat32, Tfloat64, Tfloat80, Tint32, Tint64, Tuns32, Tuns64 } from "./astenums.js";
import { IntegerExp, RealExp } from "./expression.js";
import { messageNoLoc } from "./errors.js";
import { global } from "./globals.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { Array as DArray, split } from "./root/array.js";
import { assert, assertUnreachable } from "../assert.js";
import { cstrlen, ds, dsSubslice } from "../dstring.js";
import type { DString } from "../dstring.js";
// last: 01 §4.8 — value imports into the sema half of the core SCC; the AST-node module
// `expression.js` above is the entry, as in every `*sem`-reaching module.
import { toInteger, toReal } from "./expressionsem.js";
import { size } from "./typesem.js";

import type { Modules } from "./arraytypes.js";
import type { UnionExp } from "./ctfeexpr.js";
import type { Module } from "./dmodule.js";
import type { Expression } from "./expression.js";
import type { Type } from "./mtype.js";

// dropped: import core.stdc.string (compiler.d:14) — its one use, `strlen` (compiler.d:306), is the
//          DString `cstrlen` (02 §11).
// dropped: import dmd.ctfeexpr (compiler.d:18) as a value — `UnionExp` names a parameter type only, and
//          `emplaceExp!(T)(pue, …)` is `pue.emplace(new T(…))` (02 §11.1).
// dropped: import dmd.root.ctfloat (compiler.d:29) — `real_t` is `number` on this target (09).

// compiler.d:36 — `extern (C++) __gshared`, the block through :42.

/// compiler.d:38 — whether `-i` was given: imported modules matching `includeModulePatterns` are compiled.
export let includeImports = false;

/// Setter for the `__gshared includeImports` (a TS `let` export cannot be reassigned by importers).
/// No D counterpart: D's driver assigns the global directly.
export function setIncludeImports(v: boolean): void {
    includeImports = v;
}

/// compiler.d:40 — array of module patterns used to include/exclude imported modules. Each element is a
/// `const(char)*` module pattern from `-i=<pattern>,...`; a DString, its logical end at its first NUL or
/// its `.length` (02 §11, `cstrlen`).
export const includeModulePatterns = new DArray<DString>();

/// compiler.d:41 — the imported modules `Compiler.onImport` promoted to compiled modules.
export const compiledImports: Modules = new DArray<Module | null>();

/**
 * A data structure that describes a back-end compiler and implements
 * compiler-specific actions.
 *
 * dmd/compiler.d:49 — `extern (C++) struct Compiler`. Stateless: every member is `static`, so the
 * struct is never instantiated and carries no `copy()` (03 §2 applies to struct VALUES; there are none).
 */
export class Compiler {
    /******************************
     * Encode the given expression, which is assumed to be an rvalue literal
     * as another type for use in CTFE.
     * This corresponds roughly to the idiom *(Type *)&e.
     *
     * dmd/compiler.d:56 — `extern (C++) static Expression paintAsType(UnionExp* pue, Expression e, Type type)`.
     * Precondition: `e.type` and `type` have the same size (asserted), each one of int32/uns32/int64/
     * uns64/float32/float64 (float80 is 8 bytes on this target and takes the float64 path).
     * Postcondition: `pue` holds a fresh IntegerExp/RealExp of `type` at `e.loc`; the return is `pue.exp()`.
     *
     * The local `union U` (compiler.d:58) is a bit-punned carrier (02 §11.3 case 1): one member is written,
     * a different member of the same size is read. It becomes ONE 8-byte little-endian `DataView` (the
     * target is little-endian, _ground-truth), written and read through the typed accessors; the
     * `assert(size == size)` above keeps every read inside the bytes the write filled.
     */
    static paintAsType(pue: UnionExp, e: Expression, type: Type): Expression {
        const u = new DataView(new ArrayBuffer(8));   // `U u = void;`

        assert(size(e.type!) === size(type));

        // compiler.d:69 — the source switch. `case Tfloat80: ... goto case Tfloat64;` becomes a shared
        // arm: the float80 case falls into the float64 body after its own assert (06 §4 SHARED-ARM).
        const sty = e.type!.ty;
        switch (sty) {
            case Tint32:
            case Tuns32:
                // `cast(int) e.toInteger()`: asIntN(32) is the truncation (09); the result is exact in a number.
                u.setInt32(0, Number(BigInt.asIntN(32, toInteger(e))), true);
                break;
            case Tint64:
            case Tuns64:
                u.setBigInt64(0, BigInt.asIntN(64, toInteger(e)), true);        // `cast(long) e.toInteger()`
                break;
            case Tfloat32:
                u.setFloat32(0, Math.fround(toReal(e)), true);                 // `cast(float) e.toReal()`
                break;
            case Tfloat80:
            case Tfloat64:
                if (sty === Tfloat80)
                    assert(size(e.type!) === 8n); // 64-bit target `real`
                u.setFloat64(0, toReal(e), true);                              // `cast(double) e.toReal()`
                break;
            default:
                assertUnreachable("Unsupported source type");
        }

        let r: number;   // `real_t r = void;`
        const tty = type.ty;
        switch (tty) {
            case Tint32:
            case Tuns32:
                // `u.int32value` is an `int` widened to `dinteger_t` (ulong): sign-extend, then wrap.
                pue.emplace(new IntegerExp(e.loc, BigInt.asUintN(64, BigInt(u.getInt32(0, true))), type));
                break;

            case Tint64:
            case Tuns64:
                pue.emplace(new IntegerExp(e.loc, BigInt.asUintN(64, u.getBigInt64(0, true)), type));
                break;

            case Tfloat32:
                r = u.getFloat32(0, true);
                pue.emplace(new RealExp(e.loc, r, type));
                break;

            case Tfloat80:
            case Tfloat64:
                if (tty === Tfloat80)
                    assert(size(type) === 8n); // 64-bit target `real`
                r = u.getFloat64(0, true);
                pue.emplace(new RealExp(e.loc, r, type));
                break;

            default:
                assertUnreachable("Unsupported target type");
        }
        return pue.exp();
    }

    /******************************
     * For the given module, perform any post parsing analysis.
     * Certain compiler backends (ie: GDC) have special placeholder
     * modules whose source are empty, but code gets injected
     * immediately after loading.
     *
     * dmd/compiler.d:131 — `extern (C++) static void onParseModule(Module m)`. Empty in LDC's frontend.
     */
    static onParseModule(_m: Module): void {
    }

    /**
     * A callback function that is called once an imported module is
     * parsed. If the callback returns true, then it tells the
     * frontend that the driver intends on compiling the import.
     *
     * dmd/compiler.d:140 — `extern(C++) static bool onImport(Module m)`. Side effect when it returns
     * true: `m` is appended to `compiledImports` (and, with `-v`, a `compileimport` line is printed).
     */
    static onImport(m: Module): boolean {
        if (includeImports && (m.filetype === FileType.d || m.filetype === FileType.c)) {
            if (includeImportedModuleCheck(new ModuleComponentRange(
                m.md ? m.md.packages : [], m.ident!, m.isPackageFile))) {
                if (global.params.v.verbose)
                    messageNoLoc(ds("compileimport (%s)"), m.srcfile.toChars());
                compiledImports.push(m);
                return true; // this import will be compiled
            }
        }
        return false; // this import will not be compiled
    }

    // dropped: the `version (CallbackAPI)` block (compiler.d:156-176) — CallbackAPI OFF (header).
}

/******************************
 * Private helpers for Compiler::onImport.
 */
// A range of component identifiers for a module
//
// compiler.d:183 — `private struct ModuleComponentRange`. A value struct (03): passed by value to
// `includeImportedModuleCheck` and copied into the loop's `range`, so each copy point calls `copy()`.
// `packages` is a D slice: the copy shares the elements, as D's slice copy does.
class ModuleComponentRange {
    packages: Identifier[];
    name: Identifier;
    isPackageFile: boolean;
    index = 0;

    /// The D struct literal `ModuleComponentRange(packages, name, isPackageFile)` (compiler.d:144):
    /// positional field initialisation, `index` left at its `.init` 0.
    constructor(packages: Identifier[], name: Identifier, isPackageFile: boolean, index = 0) {
        this.packages = packages;
        this.name = name;
        this.isPackageFile = isPackageFile;
        this.index = index;
    }

    copy(): ModuleComponentRange {
        return new ModuleComponentRange(this.packages, this.name, this.isPackageFile, this.index);
    }

    /// compiler.d:189 — `@property auto totalLength() const`.
    get totalLength(): number {
        return this.packages.length + 1 + (this.isPackageFile ? 1 : 0);
    }

    /// compiler.d:191 — `@property auto empty()`.
    get empty(): boolean {
        return this.index >= this.totalLength;
    }

    /// compiler.d:192 — `@property auto front() const`.
    get front(): Identifier {
        if (this.index < this.packages.length)
            return this.packages[this.index]!;
        if (this.index === this.packages.length)
            return this.name;
        return Identifier.idPool(ds("package"));
    }

    /// compiler.d:200 — `void popFront() @safe`.
    popFront(): void {
        this.index++;
    }
}

/*
 * Determines if the given module should be included in the compilation.
 * Returns:
 *  True if the given module should be included in the compilation.
 *
 * compiler.d:208 — `private bool includeImportedModuleCheck(ModuleComponentRange components)`.
 * Precondition (the `in` contract, compiler.d:209): `includeImports` is set.
 */
function includeImportedModuleCheck(components: ModuleComponentRange): boolean {
    assert(includeImports);   // compiler.d:209 `in { assert(includeImports); }`

    createMatchNodes();
    let nodeIndex = 0;
    while (nodeIndex < matchNodes.length) {
        //printf("matcher ");printMatcher(nodeIndex);printf("\n");
        const info = matchNodes.opIndex(nodeIndex++).copy();
        if (info.depth <= components.totalLength) {
            let nodeOffset = 0;
            for (const range = components.copy(); ; range.popFront()) {
                if (range.empty || nodeOffset >= info.depth) {
                    // MATCH
                    return !info.isExclude;
                }
                if (!(range.front === matchNodes.opIndex(nodeIndex + nodeOffset).id)) {
                    break;
                }
                nodeOffset++;
            }
        }
        nodeIndex += info.depth;
    }
    assert(nodeIndex === matchNodes.length, "code bug");
    return includeByDefault;
}

// Matching module names is done with an array of matcher nodes.
// The nodes are sorted by "component depth" from largest to smallest
// so that the first match is always the longest (best) match.
//
// compiler.d:244 — `private struct MatcherNode`. The anonymous `union { struct { depth; isExclude; } id; }`
// is a tag-selected variant (02 §11.3 case 2): a node is either a pattern HEADER (`depth`, `isExclude`)
// or a COMPONENT (`id`), selected by its position in `matchNodes` (a header followed by `depth`
// components), and never read through the other member. Separate fields; each constructor writes one
// member and leaves the others at `.init`, and a node is only ever replaced whole (`*dst = MatcherNode(…)`),
// never written member-wise — so construction IS the invalidation step 02 §11.3 requires.
//
// Constructors: `this(Identifier id)` (:255) and `this(bool isExclude, ushort depth)` (:256) differ in
// both arity and parameter types, so neither is a prefix of the other (04 §1 Form A does not apply). The
// two-argument form keeps the constructor; the one-argument form is the static factory `fromIdentifier`
// (the 04 §1.1(c) one-constructor-plus-one-factory shape).
class MatcherNode {
    depth = 0;           // `ushort`
    isExclude = false;
    id: Identifier | null = null;

    /// compiler.d:256 — `this(bool isExclude, ushort depth)`.
    constructor(isExclude = false, depth = 0) {
        this.depth = depth;
        this.isExclude = isExclude;
    }

    /// compiler.d:255 — `this(Identifier id)`.
    static fromIdentifier(id: Identifier): MatcherNode {
        const n = new MatcherNode();
        n.id = id;
        return n;
    }

    copy(): MatcherNode {
        const n = new MatcherNode(this.isExclude, this.depth);
        n.id = this.id;
        return n;
    }
}

/*
 * $(D includeByDefault) determines whether to include/exclude modules when they don't
 * match any pattern. This setting changes depending on if the user provided any "inclusive" module
 * patterns. When a single "inclusive" module pattern is given, it likely means the user only
 * intends to include modules they've "included", however, if no module patterns are given or they
 * are all "exclusive", then it is likely they intend to include everything except modules
 * that have been excluded. i.e.
 * ---
 * -i=-foo // include everything except modules that match "foo*"
 * -i=foo  // only include modules that match "foo*" (exclude everything else)
 * ---
 * Note that this default behavior can be overridden using the '.' module pattern. i.e.
 * ---
 * -i=-foo,-.  // this excludes everything
 * -i=foo,.    // this includes everything except the default exclusions (-std,-core,-etc.-object)
 * ---
*/
let includeByDefault = true;                   // compiler.d:280
const matchNodes = new DArray<MatcherNode>();  // compiler.d:281

/**
 * No D counterpart: the djs driver's reset between two compiles in one process (src/djs.ts
 * `deinitializeFrontend`). The `-i` patterns the driver appends, the imports `-i` compiled, and the matcher
 * built from the patterns on first use (`createMatchNodes` fills `matchNodes` once) all belong to one command
 * line, as does `includeImports` (a call refused before the driver sets it would otherwise keep the last value).
 */
export function resetCompilerState(): void {
    includeImports = false;
    includeModulePatterns.setDim(0);
    compiledImports.setDim(0);
    matchNodes.setDim(0);
    includeByDefault = true;
}

/*
 * Creates the global list of match nodes used to match module names
 * given strings provided by the -i commmand line option.
 *
 * compiler.d:287 — `private void createMatchNodes()`. Idempotent: fills `matchNodes` on the first call only.
 */
function createMatchNodes(): void {
    // compiler.d:289 — nested `static size_t findSortedIndexToAddForDepth(size_t depth)` -> inner arrow
    // (04 §5); `static` means it captures no frame, and it reads only module state.
    const findSortedIndexToAddForDepth = (depth: number): number => {
        let index = 0;
        while (index < matchNodes.length) {
            const info = matchNodes.opIndex(index).copy();
            if (depth > info.depth)
                break;
            index += 1 + info.depth;
        }
        return index;
    };

    if (matchNodes.length !== 0)
        return;
    for (const modulePattern of includeModulePatterns) {
        // `modulePattern[0 .. strlen(modulePattern)]` — the C string's logical bytes (02 §11 `cstrlen`).
        const depth = parseModulePatternDepth(dsSubslice(modulePattern, 0, cstrlen(modulePattern)));
        const entryIndex = findSortedIndexToAddForDepth(depth);
        split(matchNodes, entryIndex, depth + 1);
        parseModulePattern(modulePattern, entryIndex, depth);
        // if at least 1 "include pattern" is given, then it is assumed the
        // user only wants to include modules that were explicitly given, which
        // changes the default behavior from inclusion to exclusion.
        if (includeByDefault && !matchNodes.opIndex(entryIndex).isExclude) {
             //printf("Matcher: found 'include pattern', switching default behavior to exclusion\n");
            includeByDefault = false;
        }
    }

    // Add the default 1 depth matchers
    const defaultDepth1MatchNodes: MatcherNode[] = [
         new MatcherNode(true, 1), MatcherNode.fromIdentifier(Id.std!),
        new MatcherNode(true, 1), MatcherNode.fromIdentifier(Id.core!),
        new MatcherNode(true, 1), MatcherNode.fromIdentifier(Id.etc!),
        new MatcherNode(true, 1), MatcherNode.fromIdentifier(Id.ldc!), // IN_LLVM
        new MatcherNode(true, 1), MatcherNode.fromIdentifier(Id.object!),
    ];

    const index = findSortedIndexToAddForDepth(1);
    split(matchNodes, index, defaultDepth1MatchNodes.length);
    // `slice[index .. index + n] = defaultDepth1MatchNodes[];` — element-wise struct copy (03 §1).
    for (let i = 0; i < defaultDepth1MatchNodes.length; i++)
        matchNodes.opIndexAssign(defaultDepth1MatchNodes[i]!.copy(), index + i);
}

/// `*p` for a `const(char)*` held as (DString, offset): the byte there, or the terminating NUL at the
/// DString's logical end (the same end `cstrlen` uses (02 §11)).
function charAt(p: DString, i: number): number {
    return i < p.length ? p[i]! : 0;
}

/*
 * Determines the depth of the given module pattern.
 * Params:
 *  modulePattern = The module pattern to determine the depth of.
 * Returns:
 *  The component depth of the given module pattern.
 *
 * compiler.d:343 — `private ushort parseModulePatternDepth(const char[] modulePattern)` (`pure @safe` on :342).
 * D module-private; exported so compiler.test.ts can run its ported unittest (10 §1.7, 01 §2.5).
 */
export function parseModulePatternDepth(modulePattern: DString): number {
    const length = modulePattern.length;
    let i = length && modulePattern[0] === 0x2d /* '-' */ ? 1 : 0; // skip past leading '-'

    // handle special case
    if (i + 1 === length && modulePattern[i] === 0x2e /* '.' */)
        return 0;

    let depth = 1;
    for (; i < length; i++)
        depth += modulePattern[i] === 0x2e /* '.' */ ? 1 : 0;
    return depth & 0xffff;   // `cast(ushort)depth`
}

/*
 * Parses a 'module pattern', which is the "include import" components
 * given on the command line, i.e. "-i=<module_pattern>,<module_pattern>,...".
 * Params:
 *  modulePattern = The module pattern to parse.
 *  dst = the data structure to save the parsed module pattern to.
 *  depth = the depth of the module pattern previously retrieved from $(D parseModulePatternDepth).
 *
 * compiler.d:375 — `private void parseModulePattern(const(char)* modulePattern, MatcherNode* dst, ushort depth)`.
 * Both pointers become (base, offset) pairs: `modulePattern` walks the DString by index `mp`, and `dst`
 * is the index `di` into `matchNodes`, the one array every D caller points into (compiler.d:309).
 */
function parseModulePattern(modulePattern: DString, dstIndex: number, depth: number): void {
    let mp = 0;
    let di = dstIndex;
    let isExclude = false;
    if (charAt(modulePattern, mp) === 0x2d /* '-' */) {
        isExclude = true;
        mp++;
    }

    matchNodes.opIndexAssign(new MatcherNode(isExclude, depth), di);
    di++;

    // Create and add identifiers for each component in the modulePattern
    if (depth > 0) {
        let idStart = mp;
        const lastNode = di + depth - 1;
        for (; di < lastNode; di++) {
            for (;; mp++) {
                if (charAt(modulePattern, mp) === 0x2e /* '.' */) {
                    assert(mp > idStart, "empty module pattern");
                    matchNodes.opIndexAssign(
                        MatcherNode.fromIdentifier(Identifier.idPool(dsSubslice(modulePattern, idStart, mp))), di);
                    mp++;
                    idStart = mp;
                    break;
                }
            }
        }
        for (;; mp++) {
            if (charAt(modulePattern, mp) === 0) {
                assert(mp > idStart, "empty module pattern");
                matchNodes.opIndexAssign(
                    MatcherNode.fromIdentifier(Identifier.idPool(dsSubslice(modulePattern, idStart, mp))), lastNode);
                break;
            }
        }
    }
}
