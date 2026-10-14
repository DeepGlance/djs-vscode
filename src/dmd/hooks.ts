// Ported from dmd/hooks.d (module dmd.hooks).
//
// LDC's frontend hook for `__traits`: `semanticTraits` (traits.d:2069-2076, under `version (IN_LLVM)`)
// asks it for the traits DMD does not know, before its own remaining arms. It is translated, not
// stubbed, because it is on the import path of two frontend-visible traits, `__traits(targetCPU)`
// and `__traits(targetHasFeature)`.

import { semanticTraitsLDC } from "../gen/ldctraits.js";

import type { Expression, TraitsExp } from "./expression.js";
import type { Scope } from "./dscope.js";

/**
 * dmd/hooks.d:16 — the LDC-specific `__traits` hook.
 *
 * Returns the analysed result for a trait LDC recognises (`targetCPU`, `targetHasFeature`), or
 * `null` when the __trait was not recognized, so `semanticTraits` carries on with its own arms.
 */
export function semanticTraitsHook(e: TraitsExp, sc: Scope): Expression | null {
    return semanticTraitsLDC(e, sc);
}
