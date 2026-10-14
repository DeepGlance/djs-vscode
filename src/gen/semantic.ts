// Ported from gen/semantic.d (module gen.semantic): LDC's additional semantic analysis, run after semantic3.
//
// ---------------------------------------------------------------------------------------------
// TRANSLATION NOTES
// ---------------------------------------------------------------------------------------------
// * HOME (01 Rule 1.1). `gen/semantic.d` is a D module (`module gen.semantic;`) defining
//   `extraLDCSpecificSemanticAnalysis` and declaring the three `extern` functions it calls; the
//   dotted name maps to `src/gen/semantic.ts`, and main.d:78 `import gen.semantic :
//   extraLDCSpecificSemanticAnalysis;` resolves here, as gen.dpragma and gen.ldctraits do.
// * The three declarations (gen/semantic.d:16-18) have C++ bodies:
//   - `hasComputeAttr` (gen/uda.cpp:645) is ported in src/gen/uda.ts and imported from there.
//   - `dcomputeSemanticAnalysis` (gen/semantic-dcompute.cpp:295) is DCompute's semantic, which the
//     port does not carry (advisor's decision): a module that really carries `@compute` stops at
//     the call, with the excluded-module stop of 11 §2.
//   - `runAllSemanticAnalysisPlugins` (driver/plugins.cpp:120) runs every loaded semantic-analysis
//     plugin; `sema_plugins` is filled only by `loadAllPlugins` from `-plugin=` files, and the shim
//     has no `-plugin` switch (src/djs.ts, its `loadAllPlugins` note), so the loop calls nothing.

import { hasComputeAttr } from "./uda.js";

import type { Modules } from "../dmd/arraytypes.js";
import type { Module } from "../dmd/dmodule.js";
import type { Dsymbol } from "../dmd/dsymbol.js";

/**
 * gen/semantic.d:20 — LDC's semantic analysis after semantic3, over the root modules: DCompute's
 * semantic for every module carrying `@ldc.dcompute.compute`, then the semantic-analysis plugins.
 *
 * Side effects: `hasComputeAttr` on each module (semantic and gagged CTFE of its module UDAs).
 * A module whose `hasComputeAttr` is not `hostOnly` throws the DCompute stop (not ported).
 */
export function extraLDCSpecificSemanticAnalysis(modules: Modules): void {
    // First finish DCompute SemA for all modules, before calling plugins.
    for (const m of modules) {
        if (hasComputeAttr(asDsymbol(m!))) {
            throw new Error("DJS-ESCALATE(excluded): dcompute — dcomputeSemanticAnalysis (gen/semantic-dcompute.cpp:295) at gen/semantic.d:26");
        }
    }

    // dropped: gen/semantic.d:30-33 — `runAllSemanticAnalysisPlugins(m)` for each module
    // (driver/plugins.cpp:120) iterates no plugin: the shim loads none (see header).
}

/**
 * `m` as the Dsymbol `hasComputeAttr` takes. Module IS-A Dsymbol; the cast is needed only because
 * Module.errors (uint) is an audited field-shadow of Dsymbol.errors (bool) (dmodule.ts), which breaks
 * structural subtyping (the main.ts `asDsymbol` precedent).
 */
function asDsymbol(m: Module): Dsymbol {
    // upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool)
    return m as unknown as Dsymbol;
}
