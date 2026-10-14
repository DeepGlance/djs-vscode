// Ported from dmd/dfa/entry.d (module dmd.dfa.entry).
//
// Entry point into the fast Data Flow Analysis engine: semantic3 calls `dfaEntry` once per function body
// (semantic3.d:1482, under `-preview=fastdfa` and no errors so far), and fastDFA builds the engine's five parts,
// wires them together and runs the single forward walk.
//
// TRANSLATION DECISIONS (the structure.ts header holds the struct, allocator and ownership decisions):
//   - The five parts are D stack locals of fastDFA (entry.d:114-118): `DFACommon`, `ExpressionWalker`,
//     `DFAAnalyzer` and `DFAReporter` are structs reached through pointers, and `StatementWalker` is a `scope`
//     class instance. All five are TS class instances created per call, as the D locals are per call; every `&x`
//     the wiring stores is the reference itself. Nothing outlives the call except what the allocator's
//     process-wide regions hold (structure.ts ALLOCATOR), which D shares across calls the same way.
//   - `version (none)` blocks (entry.d:37, :106, :154, :161, :174) are dropped; dfaEntry keeps the `else` arm, the
//     plain call. The commented-out debug filters (entry.d:98-102) are not carried.
//   - The two `dfaCommon.printIfStructure(<delegate>)` calls (entry.d:136, :181) are dropped with their delegates:
//     they run the delegate only under `static if (debugStructure)`, resolved false (structure.ts), as statement.ts
//     drops its own.
//   - `scope (failure)` (entry.d:144) runs when a Throwable leaves fastDFA after that point, i.e. out of
//     `stmtWalker.start(fd)`: a `try`/`catch` around that call writes D's ICE line to stdout and rethrows. The
//     guard `!dfaCommon.debugStructure` reads the manifest constant hoisted by structure.ts (false), so the line
//     is written. It is kept, not dropped: it is what ldc2 prints on stdout before an internal error in the
//     engine, and the port's own internal errors take the same exit. It covers internal errors only: a
//     FatalError (the shim's stand-in for D's `fatal()`, e.g. at the error limit) is rethrown without the line,
//     since D's `fatal()` exits the process (errors.d:825) and unwinds nothing.

import { ds, dsToJs } from "../../dstring.js";
import type { Scope } from "../dscope.js";
import type { FuncDeclaration } from "../func.js";
import { dmdformat } from "../root/dmdformat.js";
import { DFAAnalyzer } from "./fast/analysis.js";
import { ExpressionWalker } from "./fast/expression.js";
import { DFAReporter } from "./fast/report.js";
import { StatementWalker } from "./fast/statement.js";
import { DFACommon, debugStructure } from "./fast/structure.js";
// last: errors, globals and mangle enter the core SCC; the dfa modules above have already loaded it (01 §4.8).
import { FatalError } from "../errors.js";
import { global } from "../globals.js";
import { mangleExact } from "../mangle/index.js";

/**
 * dmd/dfa/entry.d:35 — `void dfaEntry(FuncDeclaration fd, Scope* sc)`: runs the fast DFA over `fd`'s body,
 * reporting through `global.errorSink`.
 *
 * Preconditions (checked by the caller, semantic3.d:1478): `-preview=fastdfa` is on, semantic3 of `fd` raised no
 * error, `fd.fbody` is non-null and `fd.type` is not `Terror`. `sc` is the function's semantic scope.
 * Side effects: diagnostics; the `parametersDFAInfo` facts of `fd` (created or resized) and of the variables it
 * declares.
 */
export function dfaEntry(fd: FuncDeclaration, sc: Scope): void {
    // dropped: version(none) GC-statistics wrapper (entry.d:37-49); the `else` arm follows
    fastDFA(fd, sc);
}

/***********************************************************
 * Performs the fast Data Flow Analysis on a function declaration.
 *
 * This function acts as the coordinator. It:
 * 1. Checks if the function needs analysis (skips CTFE-only code).
 * 2. Instantiates the components:
 *  - StatementWalker: Traverses statements (if, while, return).
 *  - ExpressionWalker: Traverses expressions (a + b, func()).
 *  - DFAAnalyzer: Tracks the state of variables (The Brain).
 *  - DFAReporter: Reports errors and handles inferring.
 * 3. Wires them together but separates them for separation of concerns reasons.
 * 4. Starts the single-pass walk.
 *
 * dmd/dfa/entry.d:74 — `void fastDFA(FuncDeclaration fd, Scope* sc)`. D module-private.
 */
function fastDFA(fd: FuncDeclaration, sc: Scope): void {
    // erased: the function-local imports of dmd.dfa.fast.* (entry.d:76-80), hoisted to the module top (01 §4.4)

    if (fd.skipCodegen) {
        // No point running DFA on code that'll never run but has already passed CTFE.
        // Takes into account CTFE, typeof, traits compiles, CTFE, and static if/assert.
        return;
    }
    else if (fd.isInstantiated() !== null) {
        // If its a template instantiation,
        //  we'll also check the scopes to see if it known to have a CT only access.

        if (sc.isKnownToHaveACompileTimeContext())
            return;
    }

    // dropped: version(none) @safe-only filter (entry.d:106-112)

    const dfaCommon = new DFACommon();
    const stmtWalker = new StatementWalker();
    const expWalker = new ExpressionWalker();
    const analyzer = new DFAAnalyzer();
    const reporter = new DFAReporter();

    dfaCommon.allocator.dfaCommon = dfaCommon;

    stmtWalker.dfaCommon = dfaCommon;
    expWalker.dfaCommon = dfaCommon;
    analyzer.dfaCommon = dfaCommon;
    reporter.dfaCommon = dfaCommon;

    stmtWalker.expWalker = expWalker;
    expWalker.stmtWalker = stmtWalker;

    stmtWalker.analyzer = analyzer;
    expWalker.analyzer = analyzer;

    analyzer.reporter = reporter;
    reporter.errorSink = global.errorSink;

    // dropped: dfaCommon.printIfStructure (entry.d:136), debug dump (file header)

    try {
        // dropped: version(none) trace printf and -vcg-ast dump (entry.d:154-170)

        stmtWalker.start(fd);

        // dropped: version(none) trace printf (entry.d:174-179)
    }
    catch (e) {
        // dmd/dfa/entry.d:144 — `scope (failure)`
        // errors.d:825: `fatal()` exits the process, so D unwinds nothing and this guard never runs for it; the
        // shim's FatalError is that exit (djsMain finishes it), not a failure of the walk (as mars_tryMain, main.ts).
        if (!(e instanceof FatalError) && !debugStructure) {
            // printf + fflush(stdout): one assembled stdout write (10 §4.4)
            process.stdout.write(dsToJs(dmdformat(ds("ICE: ERROR %s : %s = %s at %s\n"), [
                fd.getModule()!.ident!.toChars(), mangleExact(fd), fd.toFullSignature(), fd.loc.toChars()])));
        }
        throw e;
    }

    // dropped: dfaCommon.printIfStructure (entry.d:181), debug dump (file header)
}
