// Ported from gen/uda.cpp (LDC's compiler-recognized UDA handling), frontend half only.
//
// ---------------------------------------------------------------------------------------------
// TRANSLATION NOTES
// ---------------------------------------------------------------------------------------------
// * HOME (translation-order §5, the gen/uda.cpp exception). gen/uda.cpp is C++ glue with no D
//   binding module; its one function the frontend reaches is `hasComputeAttr` (gen/uda.cpp:645,
//   declared `extern(C)` at gen/semantic.d:17), called by `extraLDCSpecificSemanticAnalysis`
//   (gen/semantic.d:25, ported in src/gen/semantic.ts). It is homed here with what it calls.
// * SCOPE. Ported, as the path from `hasComputeAttr` reaches them: `isMagicModule`
//   (gen/uda.cpp:27), `isFromMagicModule` (:44), `checkStructElems` (:67), `getMagicAttribute`
//   (:90), `hasComputeAttr` (:645), and the `DComputeCompileFor` enum (gen/uda.h:35). Not ported,
//   because only codegen or DCompute reaches them: `getLdcAttributesStruct` (:49, called by
//   applyVarDeclUDAs/applyFuncDeclUDAs), `getLastMagicAttribute` (:120, hasCallingConventionUDA),
//   `callForEachMagicAttribute` (:141, getMaskFromNoSanitizeUDA), `getIntElem`/`getStringElem`/
//   `getFirstElemString` (:157-175), every `applyAttr*` (:179-383, LLVM IR attributes),
//   `parseCallingConvention` (:388), `applyVarDeclUDAs` (:473, ir/irvar.cpp), `applyFuncDeclUDAs`
//   (:514), `hasCallingConventionUDA` (:611), `hasNoSplitStackUDA` (:700) and
//   `getMaskFromNoSanitizeUDA` (:710) (all gen/functions.cpp), `hasWeakUDA` (:629, gen/tollvm.cpp),
//   `isDeviceArrayComparisonHook` (:656) and `getKernelAttr` (:683) (gen/declarations.cpp,
//   gen/semantic-dcompute.cpp, gen/abi/*: DCompute and codegen, not ported by the advisor's decision).
// * The anonymous-namespace helpers are file-local; only `hasComputeAttr` and its return enum are
//   exported. The `extern "C"` boundary between the D frontend and the C++ body is gone once both
//   sides are TypeScript: gen/semantic.d:17 declares the result as `int`, and the enum's values are
//   those ints.
// * `fatal()` (errors.ts) exits the process, throws `FatalError` under the CLI's handler, or returns under a
//   host's handler that answers true (10 §4.7); the C++ `fatal()` after each diagnostic is that call.

// IMPORT ORDER (01 §4.8): the AST-node modules first, then the `*sem` modules.
import { EXP } from "../dmd/tokens.js";
import { error, fatal } from "../dmd/errors.js";
import { global } from "../dmd/globals.js";
import { Id } from "../dmd/id.js";
import { Type } from "../dmd/mtype.js";
import { ds } from "../dstring.js";
import { toBasetype } from "../dmd/typesem.js";
import { expandTuples, toInteger } from "../dmd/expressionsem.js";
import { getAttributes } from "../dmd/attribsem.js";
import { ctfeInterpret } from "../dmd/dinterpret.js";

import type { ModuleDeclaration } from "../dmd/dmodule.js";
import type { Dsymbol } from "../dmd/dsymbol.js";
import type { Expression, StructLiteralExp } from "../dmd/expression.js";
import type { Identifier } from "../dmd/identifier.js";

/**
 * gen/uda.h:35 — `enum class DComputeCompileFor : int`. Must match `ldc.dcompute.CompileFor` + 1:
 * `hostOnly` is "no `@compute` attribute", the other two are `@compute(CompileFor.deviceOnly)` and
 * `@compute(CompileFor.hostAndDevice)`.
 */
export enum DComputeCompileFor {
    hostOnly = 0,
    deviceOnly = 1,
    hostAndDevice = 2,
}

/**
 * gen/uda.cpp:27 — whether `moduleDecl` is in the ldc package and its identifier is `id`
 * (`ldc.<id>`, exactly one package). A null `moduleDecl` (a module without a `module` declaration)
 * is not magic.
 */
function isMagicModule(moduleDecl: ModuleDeclaration | null, id: Identifier): boolean {
    if (!moduleDecl)
        return false;

    if (moduleDecl.id !== id) {
        return false;
    }

    if (moduleDecl.packages.length !== 1 || moduleDecl.packages[0] !== Id.ldc) {
        return false;
    }
    return true;
}

/**
 * gen/uda.cpp:44 — whether the type of `e` is a struct from an ldc recognised module, i.e.
 * ldc.attributes or ldc.dcompute. Precondition (C++ dereferences both): `e.sd` is set and has a
 * module, as every struct literal CTFE produces does.
 */
function isFromMagicModule(e: StructLiteralExp, id: Identifier): boolean {
    const moduleDecl = e.sd!.getModule()!.md;
    return isMagicModule(moduleDecl, id);
}

/**
 * gen/uda.cpp:67 — checks that the struct literal of a magic attribute has exactly the fields
 * `elemTypes` (compared by base type identity). A mismatch means druntime and the compiler
 * disagree on the attribute's layout: an error at the literal, then `fatal()`.
 * Precondition (C++ dereferences them): `sle.elements` and each element are non-null, as in a CTFE
 * result.
 */
function checkStructElems(sle: StructLiteralExp, elemTypes: readonly Type[]): void {
    if (sle.elements!.length !== elemTypes.length) {
        error(sle.loc, ds("unexpected field count in `%s`; does druntime not match compiler version?"),
            sle.sd!.toPrettyChars());
        fatal();
    }

    for (let i = 0; i < sle.elements!.length; ++i) {
        if (toBasetype(sle.elements!.opIndex(i)!.type!) !== elemTypes[i]) {
            error(sle.loc, ds("invalid field type in `%s`; does druntime not match compiler version?"),
                sle.sd!.toPrettyChars());
            fatal();
        }
    }
}

/**
 * gen/uda.cpp:90 — the StructLiteralExp magic attribute with identifier `id` from the ldc magic
 * module with identifier `module_id` (attributes or dcompute), if it is applied to `sym`; null
 * otherwise. The first match wins.
 *
 * Each UDA is interpreted with CTFE under a gag: one whose evaluation errors is skipped (the gagged
 * errors are discarded by `endGagging`) and the search goes on with the next.
 * Side effects: `getAttributes` runs semantic on the UDAs if their scope is still pending
 * (attribsem.ts `getAttributes`), and `expandTuples` flattens the returned container in place.
 * Cost: one CTFE per UDA until a match.
 */
function getMagicAttribute(sym: Dsymbol, id: Identifier, module_id: Identifier): StructLiteralExp | null {
    if (!sym.userAttribDecl())
        return null;

    const attrs = getAttributes(sym.userAttribDecl()!);
    expandTuples(attrs);

    // dropped: gen/uda.cpp:98 `if (!attrs) return nullptr;` — `getAttributes` returns a new
    // container, never null (dmd/attribsem.d:44 — `auto exps = new Expressions();`), and the
    // TypeScript signature carries that.
    for (const exp of attrs) {
        const prevErrors = global.startGagging();
        // WALL PROTECTION (11 §2.5, capture-in-finally), not in C++: a wall anywhere in CTFE would be
        // an exit the C++ does not have between `startGagging` and `endGagging`, and a leaked
        // `global.gag` suppresses every later diagnostic in the process.
        let gagged: boolean;
        let e: Expression;
        try {
            e = ctfeInterpret(exp!);
        } finally {
            gagged = global.endGagging(prevErrors);
        }
        if (gagged)
            continue;

        if (e.op === EXP.structLiteral) {
            const sle = e.isStructLiteralExp()!;

            if (sle.sd!.ident === id && isFromMagicModule(sle, module_id)) {
                return sle;
            }
        }
    }
    return null;
}

/**
 * gen/uda.cpp:645 — `DComputeCompileFor.hostOnly` (0) if `sym` does not have the
 * `@ldc.dcompute.compute()` UDA applied; 1 + n if it does and is `@compute(n)`.
 *
 * The attribute's literal must have one `int` field (`checkStructElems`: a druntime that disagrees
 * is a fatal error). Side effects: those of `getMagicAttribute` (semantic and gagged CTFE of the
 * UDAs of `sym`).
 */
export function hasComputeAttr(sym: Dsymbol): DComputeCompileFor {
    const sle = getMagicAttribute(sym, Id.udaCompute!, Id.dcompute!);
    if (!sle)
        return DComputeCompileFor.hostOnly;

    checkStructElems(sle, [Type.tint32]);

    // `static_cast<DComputeCompileFor>(1 + toInteger(...))`: the C++ int conversion keeps the low
    // 32 bits of the dinteger_t sum (09 §1.3.1: the value leaves the bigint domain only here).
    return Number(BigInt.asIntN(32, 1n + toInteger(sle.elements!.opIndex(0)!)));
}
