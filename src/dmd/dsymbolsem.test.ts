// Tests for src/dmd/dsymbolsem.ts (ported from dmd/dsymbolsem.d, LDC 1.43.0-beta1 / DMD 2.113).
//
// dmd/dsymbolsem.d carries ZERO upstream `unittest{}` blocks (verified: the only `unittest` token in
// the file is inside a diagnostic string at dsymbolsem.d:4646). So per 10 §1.6b this file is a THIN
// FLEET ARTIFACT, not a port of upstream tests: one module-load smoke test plus ONE behaviour pin per
// risky RESOLVED construct, so a red gate names the construct that broke.
//
// The heavy end-to-end behaviour of this module (the whole `DsymbolSemanticVisitor`, add-member,
// field layout, deferral queues) is already pinned by the sema.* suites, which drive it through
// `runSemantic`: sema.smoke / sema.decl / sema.var / sema.struct / sema.structlocal / sema.func /
// sema.assign / sema.fieldaccess / sema.callexp / sema.rung3 / sema.corpus. Nothing here duplicates
// them; the pins below cover the free functions those suites do NOT reach, and the ImportC call sites into
// dmd/importc.d (driven end to end through the shim on `.c` files).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeEach, vi } from "vitest";

import { Parser } from "./parse.js";
import { TOK, Token } from "./tokens.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { ErrorSinkNull } from "./errorsink.js";
import { Type } from "./mtype.js";
import { global } from "./globals.js";
import { Module, moduleFromParse } from "./dmodule.js";
import { Scope } from "./dscope.js";
import { CAsmDeclaration, Dsymbol, DSYM, ScopeDsymbol } from "./dsymbol.js";
import { BitFieldDeclaration } from "./declaration.js";
import { IntegerExp } from "./expression.js";
import { setDiagnosticHandler } from "./errors.js";
import { dmdformat } from "./root/dmdformat.js";
import { ds, dsToJs } from "../dstring.js";
import type { Dsymbols } from "./arraytypes.js";

import {
    // the driver spine (djs-local `runSemantic` + the D entry points)
    runSemantic, dsymbolSemantic, addMember, setScope, importAll,
    // the free functions the sema.* suites do not reach directly
    getMinMax, search_correct_C, alignmentScope, Ungag, ungagSpeculative,
    // the exports SIBLING modules import from here (typesem/funcsem/initsem/expressionsem)
    checkDeprecated, checkDeprecatedType, determineFields, determineSize, finalizeSize,
    getType, hasPointersDsymbol, sizeDsymbol, isOverlappedWith, makeNested, toParentP,
    followInstantiationContext, allowsContractWithoutBody, checkGNUABITag,
    search, search_correct, apply, callScopeDtor, overloadInsert, toAlias, resolveAliasThis,
    addDeferredSemantic, addDeferredSemantic2, addDeferredSemantic3,
    runDeferredSemantic, runDeferredSemantic2, runDeferredSemantic3, loadStdMath, adjustLocForMixin,
} from "./dsymbolsem.js";
import { initSemaHarness, sourceMembers } from "../sema-harness.js";

/** Compiler-startup state, identical to the sema.* suites (10 §1.5). */
beforeEach(() => {
    initSemaHarness();
});

/** NUL-terminated source buffer (the lexer scans `.ptr` up to a NUL). */
function srcBuf(text: string): Uint8Array {
    const raw = new TextEncoder().encode(text);
    const b = new Uint8Array(raw.length + 1);
    b.set(raw, 0);
    b[raw.length] = 0;
    return b;
}

/** The djs-local module driver: lex -> parse -> moduleFromParse -> runSemantic. Returns global.errors. */
function sema(text: string): number {
    const p = new Parser(null, null, srcBuf(text), false, new ErrorSinkNull(), null, false);
    p.nextToken();
    const members: Dsymbols = p.parseModule();
    const m = moduleFromParse(members, p.md);
    runSemantic(m);
    return global.errors;
}

/** Runs the module driver on `text` and returns the formatted diagnostic messages it reported. */
function semaMessages(text: string): string[] {
    const messages: string[] = [];
    setDiagnosticHandler((_loc, _color, _header, messageFormat, args) => {
        messages.push(dsToJs(dmdformat(messageFormat, [...args])));
        return true;
    });
    try {
        sema(text);
    } finally {
        setDiagnosticHandler(null);
    }
    return messages;
}

describe("dsymbolsem — module shape", () => {
    // CONCERN: module load order. dsymbolsem sits in the 76-module core SCC and `extends Visitor` at
    // module-eval time in 13 classes; importing it must execute its whole top level without a
    // partially-initialised cycle edge (01 §4.2/§4.5). A regression here shows up as
    // "Class extends value undefined", not as a failing assertion — so the import itself is the test.
    test("the module loads and every export siblings depend on is defined", () => {
        // typesem.ts imports these six by exactly these names — the spellings are load-bearing.
        for (const fn of [checkDeprecated, checkDeprecatedType, determineFields, determineSize,
                          dsymbolSemantic, getType, hasPointersDsymbol, finalizeSize]) {
            expect(typeof fn).toBe("function");
        }
        // initsem.ts / funcsem.ts / expressionsem.ts import these.
        for (const fn of [isOverlappedWith, sizeDsymbol, makeNested, toParentP,
                          followInstantiationContext, allowsContractWithoutBody, checkGNUABITag]) {
            expect(typeof fn).toBe("function");
        }
        // The visitor drivers and the deferral queues.
        for (const fn of [addMember, setScope, importAll, search, search_correct, apply,
                          callScopeDtor, overloadInsert, toAlias, resolveAliasThis,
                          addDeferredSemantic, addDeferredSemantic2, addDeferredSemantic3,
                          runDeferredSemantic, runDeferredSemantic2, runDeferredSemantic3]) {
            expect(typeof fn).toBe("function");
        }
    });

    // CONCERN: `runSemantic` is a djs-local driver with NO D counterpart (it stands in for main.d's
    // four-pass sequence) and the sema.* suites import it. A module with no analyzable member must run
    // the whole spine clean.
    test("runSemantic drives a member-less module to completion with no errors", () => {
        expect(sema("module m;")).toBe(0);
        expect(Module.deferred.length).toBe(0);
    });

    // CONCERN: the driver stops where main.d stops: after pass 0 (main.d:707) and after pass 2
    // (main.d:743) on errors, never after pass 1 (main.d:722 is commented out upstream). ldc2 1.43
    // `-c -o-` reports exactly these lines and nothing from the function bodies:
    //   `module q2; int x=1; int x=2; int z = "s"; void f() { int y = "s"; }`
    //       Error: variable `q2.x` conflicts with variable `q2.x` at q2.d(1)
    //   `struct S { Undef x; } int z = "s"; void f() { int y = "s"; }`
    //       Error: undefined identifier `Undef`
    //       Error: cannot implicitly convert expression `"s"` of type `string` to `int`
    test("runSemantic stops after pass 0 and after pass 2 on errors, and not after pass 1", () => {
        const messages: string[] = [];
        setDiagnosticHandler((_loc, _color, _header, messageFormat, args) => {
            messages.push(dsToJs(dmdformat(messageFormat, [...args])));
            return true;
        });
        try {
            expect(sema('module q2; int x=1; int x=2; int z = "s"; void f() { int y = "s"; }')).toBe(1);
            // The trailing loc is empty, not `q2.d(1)`: the in-memory buffer has no filename, and
            // `writeSourceLoc` writes nothing for an empty filename (location.d:201).
            expect(messages).toEqual(["variable `q2.x` conflicts with variable `q2.x` at "]);
            messages.length = 0;
            initSemaHarness();
            expect(sema('struct S { Undef x; } int z = "s"; void f() { int y = "s"; }')).toBe(2);
            expect(messages).toEqual([
                "undefined identifier `Undef`",
                "cannot implicitly convert expression `\"s\"` of type `string` to `int`",
            ]);
        } finally {
            setDiagnosticHandler(null);
        }
    });
});

describe("dsymbolsem — resolved-construct pins", () => {
    // CONCERN (09 §1/§8): `ulong getMinMax` (dmd/dsymbolsem.d:279) is a BIGINT-domain fold —
    // `1L << width`, `long.min`, `ulong.max` — and every result is stored into a D `ulong`, so the
    // signed cases come back re-read through `BigInt.asUintN(64, ...)`. Off-by-one-bit here is exactly
    // the failure the bigint domain exists to prevent, and no sema.* suite reaches bit-fields.
    test("getMinMax folds bit-field bounds in the bigint domain (09 §1/§8)", () => {
        const bf = (width: number, type: Type): BitFieldDeclaration => {
            const b = new BitFieldDeclaration(Loc.initial, type, Id.min!,
                                              new IntegerExp(Loc.initial, BigInt(width), Type.tint32));
            b.fieldWidth = width;
            return b;
        };
        // 3-bit signed field: min = -(1<<2) = -4 -> stored into ulong; max = (1<<2)-1 = 3.
        expect(getMinMax(bf(3, Type.tint32), Id.min!)).toBe(BigInt.asUintN(64, -4n));
        expect(getMinMax(bf(3, Type.tint32), Id.max!)).toBe(3n);
        // 3-bit unsigned field: min = 0, max = (1<<3)-1 = 7.
        expect(getMinMax(bf(3, Type.tuns32), Id.min!)).toBe(0n);
        expect(getMinMax(bf(3, Type.tuns32), Id.max!)).toBe(7n);
        // width == ulong.sizeof*8 takes the folded 64-bit arm (D's `ulong.sizeof * 8` is a CT constant).
        expect(getMinMax(bf(64, Type.tuns64), Id.max!)).toBe(0xFFFF_FFFF_FFFF_FFFFn);
        expect(getMinMax(bf(64, Type.tint64), Id.min!)).toBe(BigInt.asUintN(64, -0x8000_0000_0000_0000n));
        expect(getMinMax(bf(64, Type.tint64), Id.max!)).toBe(0x7FFF_FFFF_FFFF_FFFFn);
    });

    // CONCERN: `search_correct_C` (dmd/dsymbolsem.d:168) maps a C keyword spelling back to its D token
    // — a chain of identifier-identity tests whose fall-through returns null. It is only reachable from
    // ImportC name lookup, which no sema.* suite exercises.
    test("search_correct_C maps the C spellings to their D tokens, else null", () => {
        expect(dsToJs(search_correct_C(Id.NULL!)!)).toBe(dsToJs(Token.toCharsValue(TOK.null_)));
        expect(dsToJs(search_correct_C(Id.TRUE!)!)).toBe(dsToJs(Token.toCharsValue(TOK.true_)));
        expect(dsToJs(search_correct_C(Id.FALSE!)!)).toBe(dsToJs(Token.toCharsValue(TOK.false_)));
        expect(dsToJs(search_correct_C(Id.unsigned!)!)).toBe(dsToJs(Token.toCharsValue(TOK.uns32)));
        // the `else return null;` fall-through (dsymbolsem.d:178)
        expect(search_correct_C(Identifier.idPool(ds("notAKeyword")))).toBe(null);
    });

    // The `wchar_t` arm (dsymbolsem.d:176) reads `target.c.wchar_tsize`: 4 on arm64-apple-darwin
    // (gen/target.cpp, pinned in target.test.ts), so the arm picks TOK.dchar_ — the `wchar_tsize == 2`
    // arm (TOK.wchar_) is the MSVC one and is not reachable on this target.
    test("search_correct_C's wchar_t arm maps to dchar on the 4-byte wchar_t target", () => {
        expect(dsToJs(search_correct_C(Id.wchar_t!)!)).toBe(dsToJs(Token.toCharsValue(TOK.dchar_)));
    });

    // CONCERN (09 §2, uint arithmetic): bit-field placement (dsymbolsem.d:8709-8845) runs the
    // Gcc_Clang arm on this target (target.c.bitFieldStyle), with `uint` masks and divisions. ldc2
    // 1.43.0 ground truth (`-c -o-`, pragma(msg) of offsetof/bitoffsetof/sizeof/alignof):
    //   a 0/0, b 0/3, c 4/0 (30 bits would cross the int boundary), d 8, e 16/0 (40-bit field aligns
    //   to its 8-byte type), S.sizeof 24, S.alignof 8.
    test("bit-field placement matches ldc2's Gcc_Clang layout", () => {
        const p = new Parser(null, null,
            srcBuf("struct S { int a : 3; int b : 5; uint c : 30; ubyte d; long e : 40; }"),
            false, new ErrorSinkNull(), null, false);
        p.nextToken();
        const m = moduleFromParse(p.parseModule(), p.md);
        runSemantic(m);
        const sd = sourceMembers(m)[0].isStructDeclaration()!;
        determineSize(sd, Loc.initial);
        const layout: [number, number][] = [];
        for (let i = 0; i < sd.fields.length; i++) {
            const f = sd.fields.opIndex(i)!;
            const bf = f.isBitFieldDeclaration();
            layout.push([f.offset, bf !== null ? bf.bitOffset : -1]);
        }
        expect(global.errors).toBe(0);
        expect(layout).toEqual([[0, 0], [0, 3], [4, 0], [8, -1], [16, 0]]);
        expect([sd.structsize, sd.alignsize]).toEqual([24, 8]);
    });

    // CONCERN (04 §1B): D has TWO `alignment` free functions — `alignment(Type)` in typesem.d and
    // `alignment(Scope*)` here (dsymbolsem.d:659). The port renames ours `alignmentScope`; this pin
    // holds the rename AND the 03 §1#3 value-return (a fresh `structalign_t`, never an alias into the
    // AlignDeclaration's own slot, because structalign_t has live mutators).
    test("alignmentScope returns a fresh DEFAULT structalign_t when the scope has no aligndecl", () => {
        const sc = Scope.alloc();
        const a = alignmentScope(sc);
        expect(a.isDefault()).toBe(true);
        const b = alignmentScope(sc);
        expect(b).not.toBe(a);        // distinct objects: mutating one must not move the other
        b.set(16);
        expect(a.isDefault()).toBe(true);
    });

    // CONCERN (06 §7.1): D's `struct Ungag` (dsymbolsem.d:1965) is RAII — its `~this()` restores
    // `global.gag`. TS has no destructor, so the port keeps the value class carrying `oldgag` and every
    // user wraps the region in `try { ... } finally { global.gag = ungag.oldgag; }`. This pins the
    // saved level, which is what the finally blocks read.
    test("ungagSpeculative captures the gag level the caller's finally restores", () => {
        // The value class is the whole port of the D struct: it carries `oldgag`, and each of the four
        // D users (dsymbolsem.d:4740/5262/5927/6755) restores it in a `finally`.
        expect(new Ungag(7).oldgag).toBe(7);
        expect(new Ungag(7).copy().oldgag).toBe(7);

        // The `global.gag &&` short-circuit (dsymbolsem.d:1986): with gagging off the function returns
        // the saved level and touches nothing — the ONLY arm reachable without a parented symbol
        // (D's `s.toParent2().isFuncDeclaration()` faults on a parentless one, so no test builds one).
        global.gag = 0;
        const ug = ungagSpeculative(new Dsymbol(DSYM.dsymbol));
        expect(ug.oldgag).toBe(0);
        expect(global.gag).toBe(0);
        global.gag = ug.oldgag;       // what the caller's `finally` does
        expect(global.gag).toBe(0);
    });
});

describe("dsymbolsem — paired-state guards the walls make necessary (11 §2.5)", () => {
    /**
     * A well-formed ImportC `CAsmDeclaration`. Its pass-1 visitor calls gccAsmSemantic (dmd/dsymbolsem.d:3378)
     * with the drain's `sc = null` (runDeferredSemantic's `s.dsymbolSemantic(null)`, dmd/dsymbolsem.d:795), and
     * `semanticString` dereferences it, as D does: a TypeError used here purely as a THROW SOURCE for the guard
     * pins below. The pin rests on that null dereference; a change that makes this path stop throwing turns the
     * guard pin vacuous, so it then needs another throw source.
     */
    function symbolThatHitsAWall(): CAsmDeclaration {
        const asm = new CAsmDeclaration(new IntegerExp(Loc.initial, 1n, Type.tint32));
        asm._scope = Scope.alloc();
        return asm;
    }

    // CONCERN (11 §2.5, confirmed bug class): `runDeferredSemantic` guards re-entrancy with a
    // module-global `nested` counter that D increments and decrements straight-line. The port's
    // drain calls `dsymbolSemantic`, which reaches this file's deferral walls — so without a
    // `try/finally` the FIRST wall throw latches the counter and every later drain in the process
    // becomes a silent no-op (deferred symbols never complete, and the failure surfaces far away
    // as missing sizes/diagnostics in unrelated suites). This pins the counter, not the throw.
    test("a wall throw inside the drain does not latch runDeferredSemantic's nest guard", () => {
        addDeferredSemantic(symbolThatHitsAWall());
        expect(() => runDeferredSemantic())
            .toThrow(TypeError);

        // A second, independent drain must still run: queue a symbol whose pass-1 is the empty
        // `visit(ScopeDsymbol)` (dmd/dsymbolsem.d:2032) and check it is actually dequeued.
        const benign = new ScopeDsymbol();
        addDeferredSemantic(benign);
        expect([Module.deferred.length, benign.deferred]).toEqual([1, true]);
        runDeferredSemantic();
        expect([Module.deferred.length, benign.deferred]).toEqual([0, false]);
    });

    // CONCERN (11 §2.5): `global.gag` is PROCESS state. Three regions in this file bracket it with
    // `startGagging`/`endGagging` around calls that can hit a wall; a throw that skipped the
    // `endGagging` would silently swallow every later diagnostic in the run — a red gate would then
    // present as "no diagnostic" instead of a halt. `loadStdMath` is the cheapest of the three to
    // drive; the pin is the BALANCE, so it holds whether the load halts or (once dmodule's `load`
    // is finished) succeeds.
    test("the gagged module-load region balances global.gag even when it exits abnormally", () => {
        const before = global.gag;
        try {
            loadStdMath();
        } catch {
            // The port's `load`/`importAll` path is unfinished; either exit must balance the counter.
        }
        expect(global.gag).toBe(before);
    });
});

describe("adjustLocForMixin — the -mixin= output leg (dsymbolsem.d:7458, writeMixin :7488)", () => {
    // dsymbolsem.d:7491 writes `loc.toChars()` through `writestring(const(char)*)`, which stops at the NUL.
    // The TS toChars is an `extractChars()` buffer carrying one; the expansion header must not contain it.
    test("the expansion header carries the location and no NUL", async () => {
        const { Output } = await import("./globals.js");
        const { OutBuffer } = await import("./common/outbuffer.js");
        const { BaseLoc } = await import("./location.js");
        const out = new Output();
        out.doOutput = true;
        out.name = ds("m.mixin");
        out.buffer = new OutBuffer();
        const baseLoc = new BaseLoc(ds(""), null, 0, 0, [0]);
        adjustLocForMixin(ds("int x;"), Loc.singleFilename(ds("m.d")), baseLoc, out);
        expect(dsToJs(out.buffer.extractSlice())).toBe("// expansion at m.d\nint x;\n\n");
        expect(out.bufferLines).toBe(3);
        expect(baseLoc.startLine).toBe(2);
    });
});

describe("dsymbolsem — shadow-split slots (02 §11.5b)", () => {
    // CONCERN: `AliasThis.ident` (aliasthis.d:28) redeclares `Dsymbol.ident`; the base slot stays null,
    // so `addMember` skips the symbol-table insert (dsymbolsem.d:6238-6239) and the aliased member does
    // not collide with the `alias this`. ldc2 1.43 `-c -o-` compiles this module clean.
    test("alias this to a field, to a function and in a class: no false conflict", () => {
        expect(semaMessages("module m; struct S { int a; alias a this; } "
            + "struct F { int f() { return 3; } alias f this; } class C { int x; alias x this; } "
            + "int use(S s, F f, C c) { int i = s; int j = f; int k = c; return i + j + k; } "
            + "static assert(__traits(getAliasThis, S)[0] == \"a\"); "
            + "static assert(__traits(getAliasThis, F)[0] == \"f\");")).toEqual([]);
    });

    // CONCERN: a real duplicate is still reported, and between the two VARIABLES: ldc2 1.43 prints
    //   m.d(1): Error: variable `m.S.a` conflicts with variable `m.S.a` at m.d(1)
    // (the trailing loc is empty here: the in-memory buffer has no filename, location.d:201).
    test("a duplicated field next to an alias this conflicts with the field, not the alias this", () => {
        expect(semaMessages("module m; struct S { int a; alias a this; int a; }"))
            .toEqual(["variable `m.S.a` conflicts with variable `m.S.a` at "]);
    });

    // CONCERN: `AggregateDeclaration.deferred` (aggregate.d:94) is `deferredTI`, apart from the queue
    // flag `Dsymbol.deferred` that `addDeferredSemantic` sets on the forward-referenced struct. Sharing
    // one property, the struct visitor read `true` as a template instance and crashed in semantic2.
    // ldc2 1.43 `-c -o-`: m.d(1): Error: struct `m.Qwert` no size because of forward reference
    test("a struct deferred by a forward reference reports it and runs no semantic2 on the queue flag", () => {
        expect(semaMessages("module m; struct Qwert { Yuiop asdfg; } struct Yuiop { Qwert hjkl; }"))
            .toEqual(["struct `m.Qwert` no size because of forward reference"]);
    });

    // CONCERN: the template-class shape of the same collision: `C!int` is deferred while `D!int`
    // (whose base is `C!int`) is analysed, and the class visitor ran semantic2 on the queue flag
    // ("dsym.accept is not a function"). ldc2 1.43 `-c -o-` compiles this module clean.
    test("a template class deferred behind its derived instance compiles clean", () => {
        expect(semaMessages("module m; class C(T) { D!T d; } class D(T) : C!T { } C!int c;")).toEqual([]);
    });

    // CONCERN: the template-struct shape: `C!int` is deferred behind its member instance `D!int`, so
    // `sd.deferredTI` is set and the struct visitor runs semantic2/semantic3 on it (dsymbolsem.d:4948-4951);
    // on the queue flag this crashed ("dsym.accept is not a function"). ldc2 1.43 `-c -o-` compiles it clean.
    test("a template struct deferred behind its member instance compiles clean", () => {
        expect(semaMessages("module m; struct C(T) { D!T* d; } struct D(T) { C!T c; } C!int c;")).toEqual([]);
    });

    // CONCERN: an AliasAssign is anonymous (base `Dsymbol.ident` null), so `addMember` (dsymbolsem.d:6238) keeps it out
    // of the symbol table; with one collapsed slot it collided with the alias of the same name ("alias assignment
    // `A` conflicts with alias `A`"). ldc2 1.43 `-c -o-` compiles this module clean (and `static assert(x == 8)`
    // holds).
    test("an alias assignment inside a template compiles clean (dsymbol.d:1511 identAssign)", () => {
        expect(semaMessages(
            "module m; template T() { alias A = int; A = long; enum sz = A.sizeof; } enum x = T!().sz;")).toEqual([]);
    });

    // CONCERN: the `static foreach` accumulation of druntime's `core.lifetime.forward` (lifetime.d:1599-1601), which
    // `emplace` probes gagged with `is(typeof(chunk.__ctor(forward!args1)))` (lifetime.d:124). With one collapsed slot
    // each iteration's AliasAssign conflicted with the alias it assigns, the probe answered false, and every
    // `final switch` failed on "Don't know how to initialize an object of type SwitchError". ldc2 1.43 `-c -o-`
    // compiles this module clean.
    test("an alias accumulated through static foreach compiles clean, also under a gagged probe", () => {
        expect(semaMessages("module m; template S(T...) { alias S = T; } template F(args...) { alias R = S!(); "
            + "static foreach (a; args) R = S!(R, a); alias F = R; } static assert(is(typeof(F!(1, 2)))); "
            + "static assert(F!(1, 2).length == 2 && F!(1, 2)[1] == 2);")).toEqual([]);
    });

    // CONCERN: one diagnostic reads both slots: `toPrettyChars` sees the null base `ident` (`__anonymous`), the
    // message argument reads `identAssign` (dsymbolsem.d:6896). ldc2 1.43 `-c -o-`:
    //   m.d(1): Error: alias assignment `m.T!().__anonymous` undefined identifier `B`
    test("an alias assignment to an undeclared name reports it as anonymous, naming the target", () => {
        expect(semaMessages("module m; template T() { B = long; } alias U = T!();")).toEqual([
            "alias assignment `m.T!().__anonymous` undefined identifier `B`",
            "template instance `m.T!()` error instantiating",
        ]);
    });
});

describe("dsymbolsem — funcDeclarationSemantic reached from the module driver", () => {
    // CONCERN: `tf.isNaked` (funcsem.d:677) is the `Type.isNaked()` method (mtype.d), not a field: the negated
    // uncalled reference was always false and the check never fired. ldc2 1.43 `-c -o-` prints exactly these,
    // and nothing for the member function `foo` or the nested function `n` (isThis / isNested hold).
    test("a qualified function without `this` is rejected, with the return-type hint on a single qualifier", () => {
        expect(semaMessages("module m; const int baz(); "
            + "struct S { void foo() const {} static void bar() shared const {} } "
            + "class C { static void fw() inout {} } void fs() shared {} const f2() {} "
            + "int g() { int n() const { return 0; } return 1; }")).toEqual([
            "function `m.baz` without `this` cannot be `const`",
            "did you mean to use `const(int)` as the return type?",
            "function `m.S.bar` without `this` cannot be `shared const`",
            "function `m.C.fw` without `this` cannot be `inout`",
            "function `m.fs` without `this` cannot be `shared`",
            "function `m.f2` without `this` cannot be `const`",
        ]);
    });
});

describe("dsymbolsem — initializerSemantic reached from the module driver", () => {
    // CONCERN: initsem.d:264 reads the index as `uinteger_t`, so `-1` is 2^64-1 and overflows `amax`; the port
    // compared the signed carrier, and the "array index ... overflow" error never fired. ldc2 1.43 `-c -o-`:
    test("a negative array-literal index overflows as an unsigned index", () => {
        expect(semaMessages("module m; enum int[] a = [-1: 1];")).toEqual([
            "array index 18446744073709551615 overflow",
            "array dimension overflow",
        ]);
    });
});

describe("dsymbolsem — setScope carries the enclosing UDA into a nested UserAttributeDeclaration", () => {
    // CONCERN: SetScopeVisitor.visit(Dsymbol) (dsymbolsem.d:8200) runs `if (!d.userAttribDecl) d.userAttribDecl =
    // sc.userAttribDecl` on the inner UserAttributeDeclaration, reading the BASE `Dsymbol.atts` slot. With the
    // derived `atts` merged into that slot the getter read `undefined` off the Expressions array, the store was
    // skipped, and the outer `@(1)` was lost. ldc2 1.43 `-c -o-` compiles this module clean.
    test("the block and colon forms keep the outer attribute", () => {
        expect(sema("module m; @(1) { @(2) int baz; } @(1): @(2) int q2; "
            + "static assert(__traits(getAttributes, baz).length == 2 && __traits(getAttributes, baz)[0] == 1); "
            + "static assert(__traits(getAttributes, q2).length == 2 && __traits(getAttributes, q2)[1] == 2);"))
            .toBe(0);
    });
});

/** One ldc2-shaped compile (`-c -o-` plus `extra`) through the shim in a fresh module registry (a new ldmd2 process
 * starts from load-time globals, djs.test.ts); returns the exit code and everything written to stderr. */
async function shimCompile(file: string, extra: string[] = []): Promise<{ code: number; stderr: string }> {
    vi.resetModules();
    const { djsMain } = await import("../djs.js");
    const err: string[] = [];
    const e = vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array): boolean => {
        err.push(typeof c === "string" ? c : new TextDecoder().decode(c));
        return true;
    });
    try {
        return { code: djsMain(["-c", "-o-", ...extra, file]), stderr: err.join("") };
    } finally {
        e.mockRestore();
    }
}

/** Compiles `src` as `m.c` in a fresh temporary directory (the module name is the file basename) and hands the path
 * and the shim's verdict to `check`; the directory is removed afterwards. */
async function compileC(src: string, check: (f: string, r: { code: number; stderr: string }) => void,
    extra: string[] = []): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "djs-dsymc-"));
    try {
        const f = join(dir, "m.c");
        writeFileSync(f, src);
        check(f, await shimCompile(f, extra));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// The ImportC call sites into dmd/importc.d. Expected: ldc2 1.43.0 `-c -o-` (or `-c -o- -vcg-ast`) on the same file,
// byte for byte.
describe("dsymbolsem.d — the ImportC redeclaration and default-initializer call sites", () => {
    test("AddMember :6272 — neither handler merges, so `multiplyDefined` reports the conflict", async () => {
        await compileC("int a = 1;\nint a = 2;\n", (f, r) => expect(r).toEqual({
            code: 1,
            stderr: `${f}(2): Error: variable \`m.a\` conflicts with variable \`m.a\` at ${f}(1)\nint a = 2;\n    ^\n`,
        }));
    }, 60_000);

    test("AddMember :6267 — `handleTagSymbols` rejects a tag redeclared with another kind", async () => {
        await compileC("struct K { int a; };\nunion K { int b; };\n", (f, r) => expect(r).toEqual({
            code: 1,
            stderr: `${f}(2): Error: union \`m.K\` conflicts with struct \`m.K\` at ${f}(1)\nunion K { int b; };\n^\n`,
        }));
    }, 60_000);

    test("AddMember :6269 — `handleSymbolRedeclarations` checks the redeclared type", async () => {
        await compileC("extern int b;\nlong b;\n", (f, r) => expect(r).toEqual({
            code: 1,
            stderr: `${f}(2): Error: redefinition of \`b\` with different type: \`int\` vs \`long\`\nlong b;\n     ^\n`,
        }));
    }, 60_000);

    test("AddMember :6267/:6269 — a completed forward tag and ordinary symbols beside tags are merged", async () => {
        const src = "struct S;\nstruct S { int a; };\nint S;\nstruct T { int b; };\nint T(void) { return 1; }\n";
        await compileC(src, (_f, r) => expect(r).toEqual({ code: 0, stderr: "" }));
    }, 60_000);

    test("insert :232/:228 — tag and extern redeclarations in function scope", async () => {
        const src = "int m2(void) {\n    struct L { int a; };\n    union L { int b; };\n    extern int e2;\n"
            + "    extern long e2;\n    return 0;\n}\n";
        await compileC(src, (f, r) => expect(r).toEqual({
            code: 1,
            stderr: `${f}(3): Error: declaration \`L\` is already defined\n    union L { int b; };\n    ^\n`
                + `${f}(2):        \`struct\` \`L\` is defined here\n    struct L { int a; };\n    ^\n`
                + `${f}(5): Error: redefinition of \`e2\` with different type: \`int\` vs \`long\`\n`
                + `    extern long e2;\n${" ".repeat(16)}^\n`,
        }));
    }, 60_000);

    test(":2963 — `addDefaultCInitializer` gives an uninitialized C const global its zero initializer", async () => {
        await compileC("const int gci;\nint r(void) { return gci; }\n", (f, r) => {
            expect(r).toEqual({ code: 0, stderr: "" });
            // The .cg also holds every predefined macro enum after these lines, hence toContain.
            expect(readFileSync(`${f}.cg`, "utf8"))
                .toContain("\tconst __gshared const(int) gci = 0;\n\textern (C) int r()\n\t{\n\t\treturn 0;\n\t}\n");
        }, ["-vcg-ast"]);
    }, 60_000);
});
