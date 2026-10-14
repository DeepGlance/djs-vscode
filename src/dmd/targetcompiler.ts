/**
 * Encapsulates the vagaries of which of the three D compilers (gdc, ldc or dmd) is being built
 *
 * Copyright:   Copyright (C) 1999-2025 by The D Language Foundation, All Rights Reserved
 * Authors:     $(LINK2 https://www.digitalmars.com, Walter Bright)
 * License:     $(LINK2 https://www.boost.org/LICENSE_1_0.txt, Boost License 1.0)
 * Source:      $(LINK2 https://github.com/dlang/dmd/blob/master/compiler/src/dmd/mars.d, _targetcompiler.d)
 * Documentation:  https://dlang.org/phobos/dmd_targetcompiler.html
 * Coverage:    https://codecov.io/gh/dlang/dmd/src/master/compiler/src/dmd/targetcompiler.d
 */

// module dmd.targetcompiler;

// targetcompiler.d is the compiler-identity self-config module: it is almost entirely
// `version(IN_GCC/IN_LLVM/MARS)` branches that select WHICH D source the frontend is built
// from. We are LDC, so `version(IN_LLVM)` is ON (07-compile-time §1.2 / _config.md §1) and the
// IN_GCC / MARS / `else static assert(0)` branches are dead.
//
// resolved: version(IN_GCC) {} else version(IN_LLVM) {} else version = MARS;  (targetcompiler.d:14-16)
//   -> IN_LLVM build: `version = MARS` is never set, so `MARS` is OFF everywhere below.

// `import { ds, type DString } from "../dstring.js"` — TargetCompiler / SwitchPrefix / SwitchVariadic
// are D `string` (= const(char)[]) and SwitchExceptions / SwitchScopeGuard are `const(char)*` (probed
// with ldc2); both map to DString (cheatsheet "string / const(char)*" -> DString byte buffer, 02 §1.3).
import { ds, type DString } from "../dstring.js";

/***************************
 */

// resolved: version(IN_LLVM) -> true (LDC build); IN_GCC / MARS / else static assert(0) dropped
//   (targetcompiler.d:21-46). The five compiler-identity manifest enums (02 §4.1 -> `const`):
//   TargetCompiler / SwitchPrefix / SwitchVariadic are `string`; SwitchExceptions / SwitchScopeGuard
//   are `const(char)*` (ldc2-probed). All five are DString here. Read by globals.d:502-503
//   (compileEnv.vendor/switchPrefix, both `const(char)[]`), dsymbolsem.d:2598 / safe.d:391
//   (`SwitchPrefix.ptr`), semantic3.d:427 (`SwitchVariadic.ptr`), statementsem.d:3512
//   (`SwitchScopeGuard`), statementsem.d:3785 (`SwitchExceptions` truthiness — non-null for LDC).

/// `__VENDOR__` string for this build — the compiler being built (targetcompiler.d:31).
export const TargetCompiler: DString = ds("LDC");

/// Prefix to a switch (targetcompiler.d:32). Empty for LDC.
export const SwitchPrefix: DString = ds("");

/// Switch that disables D-style variadic functions (targetcompiler.d:33).
export const SwitchVariadic: DString = ds("fno-rtti");

/// Switch that disables exceptions (targetcompiler.d:34). Non-null for LDC, so the
/// `statementsem.d:3785` `SwitchExceptions ? ... : ...` truthiness picks this string.
export const SwitchExceptions: DString = ds("fno-exceptions");

/// Switch that disables scope-guard support (targetcompiler.d:35).
export const SwitchScopeGuard: DString = ds("fno-exceptions");

// ---------------------------------------------------------------------------------------------
// MIXIN TEMPLATE DEFINITIONS — RESOLVED FOR THE IN_LLVM (LDC) BUILD
//
// targetcompiler.d:49-211 defines six `mixin template`s. A D `mixin template` is a compile-time
// SPLICE mechanism (07-compile-time §6): its members are inlined verbatim at each `mixin Name;`
// instantiation site, where the `mixin Name;` line VANISHES. The definition site itself produces
// no standalone runtime artifact — there is nothing to `new` and nothing to call here.
//
// All six are version-gated; for the LDC build each resolves to the IN_LLVM branch (the IN_GCC /
// MARS / `else static assert(0)` arms are dead). The resolved IN_LLVM content of each is recorded
// below so the BUCKET-7 instantiation-site ports (declaration.ts / func.ts / dsymbolsem.ts /
// funcsem.ts / globals.ts) inline it directly. Those sites — and the BUCKET-7 types the bodies
// reference (VarDeclaration, FuncDeclaration, Identifier, Scope, `target`, ErrorSink, Loc) — are
// NOT yet translated, so no executable TS is emitted at THIS definition site.
//
// GAP NOTE: 07-compile-time §6 documents `mixin template` resolution only from the EXPANSION
// (instantiation) side; it does not state what the DEFINITION module emits when the definition site
// has no instantiation in scope. The canonical reading (mixin templates are pure compile-time
// splices -> no definition-site artifact, only resolved content for inlining) is applied here and
// recorded as a guide gap. See structured `gaps`.
//
// ---------------------------------------------------------------------------------------------
//
// (1) mixin template VarDeclarationExtra()  (targetcompiler.d:52-67)
//     resolved: IN_LLVM -> EMPTY (LDC adds no extra VarDeclaration fields; _config.md §2,
//     07 §6.1). MARS would add `bool inClosure; bool inAlignSection;` — DROPPED (we are LDC).
//     Instantiated at declaration.d:486 (`mixin VarDeclarationExtra;`) -> expands to nothing.
//
// (2) mixin template FuncDeclarationExtra()  (targetcompiler.d:74-90)
//     resolved: IN_LLVM -> EMPTY (LDC adds no extra FuncDeclaration fields). MARS would add
//     `VarDeclarations* alignSectionVars; Symbol* salignSection;` (+ `import dmd.backend.cc`,
//     a codegen import) — DROPPED. Instantiated at func.d:292 -> expands to nothing.
//
// (3) mixin template alignSectionVarsExtra()  (targetcompiler.d:97-125)
//     resolved: IN_LLVM -> `void doAlign() { }` (empty body). The MARS body (the alignment
//     stack-section logic reading `dsym.alignment` / `target.stackAlign()` / `fd.alignSectionVars`)
//     is DROPPED. Instantiated at dsymbolsem.d:2026 (`mixin alignSectionVarsExtra; doAlign();`)
//     -> inline an empty `doAlign()` then call it (a no-op).
//
// (4) mixin template alignSectionVarsContains()  (targetcompiler.d:132-151)
//     resolved: IN_LLVM -> `bool isAlignSectionVar(VarDeclaration v) { return false; }`. The MARS
//     body (`fd.alignSectionVars && (*fd.alignSectionVars).contains(v)`) is DROPPED. Instantiated
//     at funcsem.d:3386 (`mixin alignSectionVarsContains;`) -> inline the constant-false method.
//
// (5) mixin template UseAnsiColors()  (targetcompiler.d:156-178)
//     resolved: IN_LLVM -> `bool useAnsiColors() { return detectTerminal() && detectColorPreference(); }`
//     (detectTerminal/detectColorPreference live in console.ts, already translated). The IN_GCC arm
//     returns false; both IN_LLVM and MARS arms are identical -> same body. Instantiated at
//     globals.d:505 (`mixin UseAnsiColors;`) -> inline the method; the BUCKET-6 globals.ts port
//     imports `detectTerminal`, `detectColorPreference` from "./console.js".
//
// (6) mixin template HostObjectNotFound()  (targetcompiler.d:189-211)
//     resolved: IN_LLVM -> hostObjectNotFound(loc, id, configFile, eSink) emits one error +
//     three LDC errorSupplemental lines (the MARS `errorSupplemental`s are DROPPED). Diagnostic
//     strings reproduced BYTE-FOR-BYTE (10 §3); recorded as ANSI-safe DString templates below so
//     the instantiation-site port emits identical messages. Instantiated at declaration.d:54.
//
// The resolved IN_LLVM body of (6), for the instantiation-site port to inline. `id` is a
// `const(char)*` (-> DString C-string), `configFile` a `const(char)[]` (-> DString); `eSink` is the
// ErrorSink (errorsink.ts) and `loc` a Loc (location.ts) — both BUCKET 3/4 types available now, but
// the `mixin Name;` host (declaration.d) is BUCKET 7, so the splice happens there, not here:
//
//   void hostObjectNotFound(loc, id, configFile, eSink) {
//       eSink.error(loc, ds("`%s` not found. object.d may be incorrectly installed or corrupt."), id);
//       eSink.errorSupplemental(loc, ds("ldc2 might not be correctly installed."));
//       eSink.errorSupplemental(loc, ds("Please check your ldc2.conf configuration file."));
//       eSink.errorSupplemental(loc, ds("Installation instructions can be found at http://wiki.dlang.org/LDC."));
//   }
//
// (Verbatim error strings, targetcompiler.d:193/199-201; the MARS supplementals at :205-206 are
// dropped. These are exported as DString constants below so the future inlining is mechanical and
// the byte-for-byte diagnostic parity is locked at the source of truth.)

/// Resolved IN_LLVM diagnostic strings for `hostObjectNotFound` (targetcompiler.d:189-211).
/// Exported so the declaration.ts instantiation-site port inlines byte-identical messages (10 §3).
/// The `%s` in the first string is the unresolved symbol id (a `const(char)*`).
export const hostObjectNotFoundFormat: DString =
    ds("`%s` not found. object.d may be incorrectly installed or corrupt.");
export const hostObjectNotFoundSupplemental1: DString = ds("ldc2 might not be correctly installed.");
export const hostObjectNotFoundSupplemental2: DString = ds("Please check your ldc2.conf configuration file.");
export const hostObjectNotFoundSupplemental3: DString =
    ds("Installation instructions can be found at http://wiki.dlang.org/LDC.");
