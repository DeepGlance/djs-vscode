import { describe, it, expect, beforeEach } from "vitest";

// SEMA PHASE-4a STRUCT-DECLARATION GOAL TESTS.
//
// These protect the deliverable: a `struct` DECLARATION with scalar fields type-checks with the correct
// field layout. The full pass-1 struct visitor (visitStructDeclaration) runs end-to-end for a plain-old-
// data struct: typeSemantic(TypeStruct) interns the type, newScope + member dsymbolSemantic place each
// scalar field (STC.field + offset), determineFields collects them, and the clone.d special-member
// builders (buildDtors / buildPostBlit / buildOpAssign / buildOpEquals / buildInv / needCopyOrMoveCtor)
// each early-exit for POD, so no dtor/postblit/opAssign is generated. The layout is computed lazily on
// the first `S.type.size()` query (determineSize -> finalizeSize -> setFieldOffset -> placeField).
//
// GROUND-TRUTH (ldc2-1.42.0 on arm64, `-c -o-`, via `pragma(msg, S.sizeof / S.x.offsetof / S.alignof)`):
//   struct S{ int x; }        -> S.sizeof=4LU   S.alignof=4LU  S.x.offsetof=0LU
//   struct P{ int a; int b; } -> P.sizeof=8LU                  P.a.offsetof=0LU  P.b.offsetof=4LU
//   struct E{ }               -> E.sizeof=1LU   (zero-field struct rounded to 1 in finalizeSize)
//   struct M{ int a; long b;} -> M.sizeof=16LU                                   M.b.offsetof=8LU
// All pinned below.

import { Parser } from "./parse.js";
import { Identifier } from "./identifier.js";
import { ds } from "../dstring.js";
import { ErrorSinkNull } from "./errorsink.js";
import { TY } from "./astenums.js";
import { Sizeok } from "./astenums.js";
import { PASS } from "./dsymbol.js";
import { global } from "./globals.js";
import { Module, moduleFromParse } from "./dmodule.js";
import { runSemantic } from "./dsymbolsem.js";
import type { StructDeclaration } from "./dstruct.js";
import type { Dsymbol } from "./dsymbol.js";
import { size, alignsize } from "./typesem.js";
import { initSemaHarness } from "../sema-harness.js";

beforeEach(() => {
  initSemaHarness();
});

function srcBuf(s: string): Uint8Array {
  const b = new Uint8Array(s.length + 1);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  b[s.length] = 0;
  return b;
}

/** Parse-only build of a Module (no sema). */
function parseModule(src: string): Module {
  const p = new Parser(null, null, srcBuf(src), false, new ErrorSinkNull(), null, false);
  p.nextToken();
  const members = p.parseModule();
  return moduleFromParse(members, p.md);
}

/** lex+parse `src` into a Module, run the `runSemantic` driver (passes 0-3), return the module + error count. */
function sema(src: string): { module: Module; errors: number } {
  const m = parseModule(src);
  runSemantic(m);
  return { module: m, errors: global.errors };
}

/** Find a top-level StructDeclaration by name in the semantic'd module's symbol table. The symtab is
 * keyed by interned Identifiers, so we look up the SAME interned identifier the parser produced. */
function findStruct(m: Module, name: string): StructDeclaration {
  const sym: Dsymbol | null = m.symtab ? m.symtab.lookup(Identifier.idPool(ds(name))) : null;
  expect(sym).not.toBeNull();
  const sd = sym!.isStructDeclaration();
  expect(sd).not.toBeNull();
  return sd!;
}

describe("Phase 4a — single-field struct `struct S{ int x; }`", () => {
  it("dsymbolSemantic completes: semanticRun==semantic3done, errors 0, type is the interned TypeStruct", () => {
    const { module: m, errors } = sema("struct S{ int x; }");
    expect(errors).toBe(0);

    const sd = findStruct(m, "S");
    // GOAL: dsymbolSemantic completes (the whole visitStructDeclaration body ran to the tail).
    // `sema` runs the WHOLE driver, and pass 3 takes a module-scope aggregate to `semantic3done`
    // (semantic3.d:1659) — reaching it means the pass-1 body ran to the tail first.
    expect(sd.semanticRun).toBe(PASS.semantic3done);
    expect(sd.errors).toBe(false);

    // GOAL: S.type is the interned TypeStruct (deco set by typeSemantic(visitStruct) -> merge).
    expect(sd.type).not.toBeNull();
    expect(sd.type!.ty).toBe(TY.Tstruct);
    expect(sd.type!.isTypeStruct()).not.toBeNull();
    expect(sd.type!.isTypeStruct()!.sym).toBe(sd);
    expect(sd.type!.deco).not.toBeNull();         // interned (merge set the deco)
  });

  it("layout: S.type.size()==4, S.alignof==4, fields[0].offset==0 (ldc2: S.sizeof=4, S.x.offsetof=0)", () => {
    const { module: m, errors } = sema("struct S{ int x; }");
    expect(errors).toBe(0);
    const sd = findStruct(m, "S");

    // GOAL: S.type.size()==4 — triggers the lazy layout chain (determineSize -> finalizeSize).
    expect(size(sd.type!)).toBe(4n);
    expect(sd.sizeok).toBe(Sizeok.done);
    expect(sd.structsize).toBe(4);

    // GOAL: S.alignof == 4 (the field's natural alignment).
    expect(alignsize(sd.type!)).toBe(4);
    expect(sd.alignsize).toBe(4);

    // GOAL: S.x.offsetof == 0 — the single field placed at offset 0.
    expect(sd.fields.length).toBe(1);
    expect(sd.fields.opIndex(0)!.offset).toBe(0);
    // the field picked up STC.field during member dsymbolSemantic.
    expect(sd.fields.opIndex(0)!.isField()).toBe(true);

    // POD: no special members were generated.
    expect(sd.dtor).toBeNull();
    expect(sd.postblit).toBeNull();
    expect(sd.ctor).toBeNull();
    expect(sd.hasCopyCtor).toBe(false);
    expect(sd.hasMoveCtor).toBe(false);
    // an all-zero-int struct is zeroInit.
    expect(sd.zeroInit).toBe(true);
  });
});

describe("Phase 4a — two-field struct `struct P{ int a; int b; }`", () => {
  it("layout: P.sizeof==8, a.offsetof==0, b.offsetof==4 (ldc2-verified)", () => {
    const { module: m, errors } = sema("struct P{ int a; int b; }");
    expect(errors).toBe(0);
    const sd = findStruct(m, "P");
    expect(sd.semanticRun).toBe(PASS.semantic3done);   // whole driver: pass 3 ran (semantic3.d:1659)

    expect(size(sd.type!)).toBe(8n);
    expect(sd.structsize).toBe(8);
    expect(sd.alignsize).toBe(4);

    expect(sd.fields.length).toBe(2);
    expect(sd.fields.opIndex(0)!.offset).toBe(0); // a
    expect(sd.fields.opIndex(1)!.offset).toBe(4); // b
  });
});

describe("Phase 4a — empty struct `struct E{ }`", () => {
  it("layout: E.sizeof==1 (zero-field struct rounded up to 1; ldc2-verified)", () => {
    const { module: m, errors } = sema("struct E{ }");
    expect(errors).toBe(0);
    const sd = findStruct(m, "E");
    expect(sd.semanticRun).toBe(PASS.semantic3done);   // whole driver: pass 3 ran (semantic3.d:1659)

    expect(size(sd.type!)).toBe(1n);
    expect(sd.structsize).toBe(1);
    expect(sd.alignsize).toBe(1);
    expect(sd.hasNoFields).toBe(true);
    expect(sd.fields.length).toBe(0);
  });
});

describe("Phase 4a — mixed-width struct `struct M{ int a; long b; }`", () => {
  it("layout: M.sizeof==16, a.offsetof==0, b.offsetof==8 (long aligned to 8 on arm64; ldc2-verified)", () => {
    const { module: m, errors } = sema("struct M{ int a; long b; }");
    expect(errors).toBe(0);
    const sd = findStruct(m, "M");
    expect(sd.semanticRun).toBe(PASS.semantic3done);   // whole driver: pass 3 ran (semantic3.d:1659)

    expect(size(sd.type!)).toBe(16n); // 4 (int) + 4 pad + 8 (long), rounded to alignsize 8
    expect(sd.structsize).toBe(16);
    expect(sd.alignsize).toBe(8);

    expect(sd.fields.length).toBe(2);
    expect(sd.fields.opIndex(0)!.offset).toBe(0); // a
    expect(sd.fields.opIndex(1)!.offset).toBe(8); // b (aligned to 8)
  });
});

describe("Phase 4a — TypeStruct deco mangling (ground-truth faithfulness)", () => {
  it("the interned deco for `struct S{int x;}` in module `m` is `S1m1S` (ldc2 S.mangleof)", () => {
    const { module: m, errors } = sema("module m; struct S{ int x; }");
    expect(errors).toBe(0);
    const sd = findStruct(m, "S");
    // ldc2: S.mangleof == S1m1S (the TypeStruct deco). The qualified-name mangle ran via the Mangler.
    expect(String(sd.type!.deco)).toBe("S1m1S");
  });
});
