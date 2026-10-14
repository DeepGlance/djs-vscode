import { describe, test, expect, beforeEach } from "vitest";

// SEMA SMOKE TEST — prove the minimal semantic pipeline lexer -> parser -> Module -> runSemantic
// runs end-to-end on whole-module D source.
//
// This drives the Phase-0 sema spine assembled in this rung:
//   - `moduleFromParse(members, md)` (dmodule.ts): build a Module from the parser output (the
//     in-memory analogue of `Module.parse()`'s `members = p.parseModuleContent(); md = p.md` tail).
//   - `runSemantic(m)` (dsymbolsem.ts): the module driver standing in for main.d:700-770 — passes 0 to 3
//     (`importAll`, `dsymbolSemantic`, `semantic2`, `semantic3`) with their deferral drains.
//   - the deferred-semantic queues (Module.deferred / addDeferredSemantic / runDeferredSemantic).
//
// GOAL TEST (task): `sema('module m;')` and `sema('')` run with `global.errors === 0` and no throw.

import { Parser } from "./parse.js";
import { ErrorSinkNull } from "./errorsink.js";
import { global } from "./globals.js";
import { Module, moduleFromParse } from "./dmodule.js";
import { runSemantic } from "./dsymbolsem.js";
import type { Dsymbols } from "./arraytypes.js";
import { initSemaHarness } from "../sema-harness.js";

beforeEach(() => {
  initSemaHarness();
});

/** NUL-terminated byte buffer from an ASCII/Latin-1 string (the lexer scans `.ptr` to a NUL),
 *  built exactly as the lexer/parse smoke tests do. */
function srcBuf(s: string): Uint8Array {
  const b = new Uint8Array(s.length + 1);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  b[s.length] = 0;
  return b;
}

/**
 * Lex+parse `src` into a Module, run the `runSemantic` driver (passes 0-3) over it, and return the module
 * together with the resulting global error count. The Parser is constructed with a null `Module`
 * (no on-disk `srcfile` needed for an in-memory buffer — same as parse.smoke.test.ts); the parsed
 * `members`/`md` are then attached to a fresh Module via `moduleFromParse`.
 */
function sema(src: string): { module: Module; errors: number } {
  const p = new Parser(null, null, srcBuf(src), false, new ErrorSinkNull(), null, false);
  p.nextToken();
  const members: Dsymbols = p.parseModule();
  const m = moduleFromParse(members, p.md);
  runSemantic(m);
  return { module: m, errors: global.errors };
}

// The goal-test path through `runSemantic` -> `dsymbolSemantic(m)` ->
// `DsymbolSemanticVisitor.visitModule` reaches two spine methods that gate the end-to-end run:
//   1. `Scope.createGlobal` (dscope.ts) — builds the root global scope and adds the Module to it.
//      Its only missing dependency was the BASE case of `addMember` (the global-scope insert of the
//      top-level package/Module); the per-node `AddMemberVisitor` overrides are NOT needed on this
//      path and remain unported (rung work). The base case is ported as the `addMember` free function
//      in dsymbolsem.ts (faithful to dmd's `addMember(Dsymbol, ...)` base `visit(Dsymbol)`).
//   2. `Scope.pop` (dscope.ts) — `visitModule` pops the root scope twice. Ported: the load-bearing
//      ctorflow merge + freeFieldinit are kept; the freelist recycling / `this = this.init`
//      self-reset is erased to the JS GC per 03 §8 (settled by the porting guide, not a guess).
// With those two filled, the Phase-0 sema spine runs an empty/bare module end-to-end with
// `global.errors === 0` and no throw. The per-node `visitX` analysis overrides stay TODO-BODY/absent.
describe("sema.smoke (milestone: lexer -> parser -> Module -> runSemantic)", () => {
  // ── GOAL TEST case 1: a bare module declaration runs clean. ────────────────────────────────────
  test("sema('module m;') runs with global.errors === 0 and no throw", () => {
    const { module, errors } = sema("module m;");
    expect(errors).toBe(0);
    expect(module.constructor.name).toBe("Module");
  });

  // ── GOAL TEST case 2: empty source (no module decl, no members) runs clean. ────────────────────
  test("sema('') runs with global.errors === 0 and no throw", () => {
    const { module, errors } = sema("");
    expect(errors).toBe(0);
    expect(module.constructor.name).toBe("Module");
  });
});
