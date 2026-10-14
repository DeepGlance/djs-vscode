import { describe, test, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

// SEMA CORPUS ON-RAMP (LIGHT) — run a handful of REAL DMD test files from the LDC 1.43.0 corpus through
// the `sema(src)` MODULE driver (lex -> parse -> moduleFromParse -> runSemantic) and assert the
// accept/reject outcome. This is the on-ramp, NOT the full lit/TEST_OUTPUT runner: a fixed, documented
// file list with a hand-checked expected outcome per file, ground-truthed against ldc2.
//
// CORPUS ROOTS (LDC 1.43.0 = DMD frontend test suite):
//   compilable/      -> files that ldc2 COMPILES CLEAN  (expected: errors === 0)
//   fail_compilation/-> files that ldc2 REJECTS         (expected: errors  >  0)
//
// GROUND-TRUTH (each file run through
//   <ldc2-1.43.0>/bin/ldc2 -c -o- <file>):
//   compilable/empty_file.d     -> COMPILES CLEAN (the file is empty).
//   compilable/test12567e.d     -> COMPILES CLEAN (`deprecated("a"~"b") module fail12567;` — a deprecated
//                                  module declaration; no analyzable member).
//   compilable/test14198.d      -> COMPILES CLEAN (`module compilable.test14198;` — a module declaration
//                                  only; the REQUIRED_ARGS/extra source in the header is for the full lit
//                                  runner, not needed for the bare module-decl this on-ramp exercises).
//   compilable/ddocYear.d       -> COMPILES CLEAN (`int year;` — a basic module-scope variable). Now a
//                                  genuine end-to-end ACCEPT (the var-decl body is ported — see below).
//   fail_compilation/test21304.d-> REJECTED: undefined identifier `unknown` (`int[unknown] values=...;`).
//   fail_compilation/fail256.d  -> REJECTED: incompatible types `dstring` and `string` (`"foo"d ~ "bar"c`).
//
// WHAT THE djs RUNG REACHES (verified empirically through `sema()`, NOT guessed — same boundaries as
// sema.decl.test.ts / sema.var.test.ts):
//   - A module with NO analyzable member (empty / module-decl-only / deprecated-module-decl) runs the
//     full driver to completion with `errors === 0`. -> the three ACCEPT files below land green, end-to-end.
//   - A module with a plainly-typed module-scope `VarDeclaration` (e.g. `int year;`) now runs the WHOLE
//     `visitVarDeclaration` body to completion -> `ddocYear.d` is a genuine end-to-end ACCEPT (errors === 0).
//   - `test21304.d` reaches its undefined-identifier diagnostic and rejects; `fail256.d` rejects with ldc2's
//     incompatible-types diagnostic.
//
// HONEST POSTURE (the task's "leave it honest"): we do NOT implement the still-unported siblings, and we do
// NOT fake a pass. We land the three no-member compilable files AND the basic-var `ddocYear.d` as genuine
// end-to-end ACCEPTs (`errors === 0`), and PIN the two REJECTs on their real (pre-diagnostic) unported
// boundary with `.toThrow(...)`, recording the ldc2 ground-truth as the ACHIEVEMENT TARGET inline.

import { Parser } from "./parse.js";
import { ErrorSinkNull } from "./errorsink.js";
import { global } from "./globals.js";
import { moduleFromParse } from "./dmodule.js";
import { runSemantic } from "./dsymbolsem.js";
import type { Dsymbols } from "./arraytypes.js";
import { initSemaHarness } from "../sema-harness.js";

// ORACLE CONSTANT: a checkout of LDC v1.43.0's sources (tests/dmd); set it to yours to run the oracle tests.
const CORPUS = "/Users/pinver/Projects/Public/ldc-1.43.0/tests/dmd";

beforeEach(() => {
  initSemaHarness();
});

/** NUL-terminated byte buffer of a corpus file on disk (the lexer scans `.ptr` to a NUL). D source is
 *  read verbatim — the DMD test-suite header block comments lex fine and contribute no members. */
function fileBuf(relPath: string): Uint8Array {
  const raw = readFileSync(`${CORPUS}/${relPath}`);
  const b = new Uint8Array(raw.length + 1);
  b.set(raw, 0);
  b[raw.length] = 0;
  return b;
}

/** The `sema(src)` MODULE driver applied to a corpus file: lex+parse -> moduleFromParse -> runSemantic.
 *  Returns the resulting `global.errors`; throws verbatim if the pass reaches a deferred sibling. */
function semaFile(relPath: string): number {
  const p = new Parser(null, null, fileBuf(relPath), false, new ErrorSinkNull(), null, false);
  p.nextToken();
  const members: Dsymbols = p.parseModule();
  const m = moduleFromParse(members, p.md);
  runSemantic(m);
  return global.errors;
}

describe("sema.corpus on-ramp — real LDC 1.43.0 DMD test files through the sema() module driver", () => {
  // ── ACCEPT (compilable -> errors === 0), reachable END-TO-END (no analyzable member). ─────────────
  test("compilable/empty_file.d -> errors 0 (ldc2: compiles clean — empty module)", () => {
    expect(semaFile("compilable/empty_file.d")).toBe(0);
  });

  // `deprecated("a"~"b") module fail12567;`: the deprecation message's `CatExp` folds through optimize's
  // visitCat into constfold's `Cat` (constfold.d:1400) and its string/string arm (constfold.d:1479).
  test("compilable/test12567e.d -> errors 0 (ldc2: compiles clean — deprecated module declaration)", () => {
    expect(semaFile("compilable/test12567e.d")).toBe(0);
  });

  test("compilable/test14198.d -> errors 0 (ldc2: compiles clean — module declaration only)", () => {
    expect(semaFile("compilable/test14198.d")).toBe(0);
  });

  // ── ACCEPT a BASIC VAR DECL — the var-decl body past the type is now ported; runs to completion. ──
  // ldc2 GROUND-TRUTH: `int year;` compiles clean (ACCEPT). The whole `visitVarDeclaration` body now runs
  // for this plainly-typed, no-init, module-level var (checkDeprecatedType / alignment defaulting /
  // checkComplexTransition / placement+validity checks / addStorageClass / callScopeDtor / semanticdone),
  // so the corpus file reaches errors === 0 end-to-end — the genuine ldc2 ACCEPT.
  test("compilable/ddocYear.d (basic var `int year;`) -> errors 0 (ldc2: compiles clean)", () => {
    expect(semaFile("compilable/ddocYear.d")).toBe(0);
  });

  // ── REJECT (fail_compilation -> errors > 0). ────────────────────────────────────────────────────────
  // test21304.d and fail256.d reject as ldc2 does.
  test("fail_compilation/test21304.d (undefined id `unknown`) -> errors > 0 (ldc2: rejects)", () => {
    // ldc2 GROUND-TRUTH: Error: undefined identifier `unknown` (REJECT). The pass walks visitAArray -> resolve ->
    // visitIdentifier -> resolveHelper (dmd/typesem.d:1508-1526) and emits that diagnostic.
    expect(semaFile("fail_compilation/test21304.d")).toBeGreaterThan(0);
  });

  test("fail_compilation/fail256.d (type mismatch dstring~string) -> errors > 0 (ldc2: rejects)", () => {
    // ldc2 GROUND-TRUTH: Error: incompatible types for `("foo"d) ~ ("bar"c)`: `dstring` and `string` (REJECT).
    expect(semaFile("fail_compilation/fail256.d")).toBeGreaterThan(0);
  });
});
