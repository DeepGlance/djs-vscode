// Ported from dmd/pragmasem.d (module dmd.pragmasem) — WHOLE-FILE faithful translation (W3/S2).
//
// Does semantic analysis for pragmas.
// Specification: https://dlang.org/spec/pragma.html
//
// ---------------------------------------------------------------------------------------------
// TRANSLATION NOTES (the decisions a reader/reviewer needs, keyed to the guide)
// ---------------------------------------------------------------------------------------------
// * IDIOM CHECK (13 §7, mandatory precondition): `grep -c 'class .*Visitor' dmd/pragmasem.d` -> 0,
//   and the file carries NO node-tag dispatch `switch` either (no `switch (e.op)` / `switch (t.ty)`).
//   It is a flat set of SEVEN free functions whose bodies declare nested helper functions
//   (`declarations`, `noDeclarations`, `recurse`, `verifyMangleString`, `applyPragmaMangle`,
//   `expectedString`, `expectedType`). Those become inner `const` arrows (04 §5), declared before
//   first use. No visitor class is invented (13 §7.5 rule 5).
// * D free functions are emitted AS FREE FUNCTIONS in the TS module mirroring their D module
//   (04 §6 anti-pattern) — nothing here is re-homed onto a receiver class.
// * UFCS resolution (04 §6/§6.1), decided per call site by the receiver type + this module's
//   imports (module-level AND function-local) — never by repo-wide grep:
//     - `s.dsymbolSemantic(sc2)`        -> dsymbolsem.d free fn      -> `dsymbolSemantic(s, sc2)`
//     - `s.setPragmaPrintf(b)`          -> THIS module's private free fn (pragmasem.d:498)
//     - `pd.newScope(sc)`               -> dsymbolsem.d:8980 `newScope(Dsymbol, Scope*)` — NOT the
//       `newScope(AggregateDeclaration, Scope*)` (dsymbolsem.d:90) the tree exports: `pd` is a
//       PragmaDeclaration (04 §6.1 first-parameter-type rule) -> Form B `newScopeDsymbol`.
//     - `ad.include(null)`              -> dsymbolsem.d:9137 `include(Dsymbol, Scope*)` (the
//       module-level selective import at pragmasem.d:25 names it) -> `include(ad, null)`.
//     - `e.expressionSemantic(sc)` / `resolveProperties` / `e.toBoolean(sc)` / `e.toBool()`
//                                       -> expressionsem.d free fns
//     - `se.peekString()` / `se.toStringz()` / `e.toChars()` / `pd.kind` / `pd.toPrettyChars`
//                                       -> METHODS on StringExp / Expression / Dsymbol
//     - `x.foreachDsymbol(dg)`          -> dsymbol.d free fn; the delegate at pragmasem.d:508 has
//       NO return, so it binds the `void delegate` overload -> `foreachDsymbolVoid` (04 §1B)
//     - `buf.arrayObjectsToBuffer(objs)`-> hdrgen.d:3599 free fn -> `arrayObjectsToBuffer(buf, objs)`
//     - `se.peekString().xarraydup`     -> root/rmem.d free fn -> `xarraydup(se.peekString())`
//     - `escapePath(ob, …)`             -> utils.d free fn, already in free form
//     - `ps._body.statementSemantic(sc)`-> statementsem.d free fn
// * `version (IN_LLVM)` -> ON (_config.md §1): every IN_LLVM block here is LIVE and the one
//   `else // !IN_LLVM` arm (pragmasem.d:120-133) is dropped. `version (all)` (pragmasem.d:310) ->
//   ON (built-in), so its block is emitted unconditionally and its `else` dropped (07 §1/_config §3).
// * gen.dpragma (pragmasem.d:53, :350) is LDC's pragma layer: `gen/dpragma.d` declares it and
//   gen/pragma.cpp implements it. Its frontend-visible part is ported in src/gen/dpragma.ts (07's llvmInternal
//   ruling, reopened), so `DtoGetPragma` (pragmasem.d:196), `DtoCheckPragma` (:82) and
//   `DtoCheckProfileInstrPragma` (:353) are D's own calls. The `llvm_internal` local holds the C++
//   enum value DtoGetPragma returns (`LDCPragmaCpp`; see dpragma.ts on the two numberings).
// * `target.supportsLinkerDirective()` (pragmasem.d:99) is the live `Target` member in target.ts
//   (LDC's gen/target.cpp:429 body: true on a Mach-O triple, false on an ELF one); the call is D's own.
// * GAG PAIRING (11 §2.5, last bullet): `global.gag` is a process-global counter and walls reached
//   transitively (through `ctfeInterpret`) are exit paths D does not have, so the one
//   `startGagging`/`endGagging` region here (pragmasem.d:261-278) is wrapped
//   `try { … } finally { global.endGagging(errors_save); }`. Every `startCTFE`/`endCTFE` pair in this
//   file closes BEFORE its adjacent `ctfeInterpret` call, so no other pairing needs a guard.
// * `ref` parameters that REASSIGN the caller's slot (`ref Expression e` at pragmasem.d:577,
//   `ref uint count` / `ref bool ignored` at :602) become `Ref<T>` boxes (03 §3.2/§7.2). The
//   `foreach (ref Expression e; (*args)[])` at :633 aliases the CONTAINER element, and
//   `DArray.opSlice()` returns a COPY (08 §2), so that loop is indexed and `e` is a Ref box whose
//   getter/setter go through `opIndex`/`opIndexAssign` — writes land in `args`, exactly as in D.
// * `Loc` is an ALIAS-SAFE REGISTER member (03 §9.1): shared, never `.copy()`-ed, no per-site
//   comment. No other value struct is copied in this file.
// * dropped: `import core.stdc.stdio;` / `import core.stdc.string;` (pragmasem.d:16-17) — the
//   only users are `fprintf(stderr, …)` (routed through `dmdformat` + one `process.stderr.write`,
//   10 §4.4) and `strlen` (-> `cstrlen`, 02 §11.2). No runtime shim module is needed (01 §3.7).
// * D `private` on a top-level declaration is MODULE scope (01 §2.5). The four private functions
//   here are emitted WITHOUT `private` (TS has no module visibility) and EXPORTED so the
//   co-located `pragmasem.test.ts` can drive them — the dmodule.ts:122/:1302 precedent — each
//   marked `// D module-private`.

// IMPORT ORDER (01 §4): the AST-node modules are listed BEFORE the `*sem` modules. This is
// load-bearing, not cosmetic — entering the core SCC through `dsymbolsem.js` first reaches
// `funcsem.ts` -> `func.ts` while `declaration.ts` is still mid-evaluation ("Class extends value
// undefined"). Naming `expression.js` (or `mtype.js`) ahead of it orders the cycle the way every
// working sibling does (enumsem.ts). Verified by probe, not assumed.
import { ErrorExp, type Expression, type StringExp } from "./expression.js";
import { AggregateDeclaration, MangleOverride } from "./aggregate.js";
import { PINLINE } from "./astenums.js";
import { OutBuffer } from "./common/outbuffer.js";
import { foreachDsymbolVoid, type Dsymbol } from "./dsymbol.js";
import { error, errorSupplemental, messageNoLoc } from "./errors.js";
import { global } from "./globals.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { dsymbolSemantic, include, newScopeDsymbol } from "./dsymbolsem.js";
import {
    expressionSemantic, expressionsToString, getDsymbol, resolveProperties, semanticString, toBool, toBoolean,
} from "./expressionsem.js";
import { statementSemantic } from "./statementsem.js";
import { escapePath } from "./utils.js";
import { Array as DArray } from "./root/array.js"; // runtime growable container (08-runtime-lib.md)
import { dmdformat } from "./root/dmdformat.js";
import { xarraydup } from "./root/rmem.js";
import { assert, assertUnreachable } from "../assert.js";
// last value import (01 §4.8): hdrgen.js enters mtype/dtemplate, so it must not open the SCC here.
import { arrayObjectsToBuffer } from "./hdrgen.js";
import { cstr, cstrlen, ds, dsToJs, type DString } from "../dstring.js";
// dmd/pragmasem.d:48 (`import dmd.target;`, function-local in pragmaDeclSemantic, hoisted per 01 §4) and
// dmd/pragmasem.d:22 (`import dmd.dinterpret;`) — added by the wave-14 sweep. LAST (01 §4.8): target.js
// enters typesem/mtype and dinterpret.js enters the core SCC, so neither may open the cycle here.
import { target } from "./target.js";
import { ctfeInterpret } from "./dinterpret.js";
// dmd/pragmasem.d:53 and :350 (`import gen.dpragma : …`, function-local, hoisted per 01 §4). LAST (01 §4.8): it
// imports expressionsem.js.
import { DtoCheckPragma, DtoCheckProfileInstrPragma, DtoGetPragma, LDCPragmaCpp } from "../gen/dpragma.js";

import type { Dsymbols, Expressions } from "./arraytypes.js";
import type { PragmaDeclaration } from "./attrib.js";
import type { Module } from "./dmodule.js";
import type { Scope } from "./dscope.js";
import type { Loc } from "./location.js";
import type { PragmaStatement } from "./statement.js";

/**
 * A D `ref T` parameter that the callee REASSIGNS (as opposed to mutating through) — one mutable
 * cell (03 §3.2/§7.2). Declared per file, as elsewhere in the tree (dcast.ts:172, dclass.ts:44).
 */
interface Ref<T> {
    value: T;
}

/**
 * dmd/pragmasem.d:41 — `void pragmaDeclSemantic(PragmaDeclaration pd, Scope* sc)`.
 * Run semantic on `pragma` declaration.
 *
 * Params:
 *  pd = pragma declaration or statement to evaluate
 *  sc = enclosing scope
 *
 * Preconditions: `pd` and `sc` are non-null — every body path dereferences them without a null
 * test, so callers assert with `!` at exactly the site where D would fault (02 §10.1). `sc` is
 * REASSIGNED across the CTFE round trip below, exactly as D reassigns its parameter.
 */
export function pragmaDeclSemantic(pd: PragmaDeclaration, sc: Scope): void {
    // dropped: the seven function-local imports at pragmasem.d:43-49 — TS imports are module-level
    // (01 §3), and every symbol they bring in is already imported at the top of this file.

    // resolved: `version (IN_LLVM)` -> ON (_config.md §1), so the block at pragmasem.d:51-57 is
    // LIVE; its `import gen.dpragma` (:53) is the module-level import of this file.
    let llvm_internal: LDCPragmaCpp = LDCPragmaCpp.LLVMnone; // D type `LDCPragma`: see the file header
    const arg1str: Ref<DString | null> = { value: null }; // `const(char)*`, reassigned by DtoGetPragma

    // pragmasem.d:59 — nested `void declarations()` -> inner `const` arrow (04 §5).
    const declarations = (): void => {
        if (pd.decl === null) // `if (!pd.decl)` — nullable reference (06 §2.7)
            return;

        // pragmasem.d:64 — `Scope* sc2 = pd.newScope(sc);`. UFCS onto `extern(D) Scope*
        // newScope(Dsymbol d, Scope* sc)` (dsymbolsem.d:8980) -> Form B `newScopeDsymbol` (04 §1B).
        const sc2 = newScopeDsymbol(pd, sc)!; // `!`: the visitor starts from the non-null `sc` it is handed

        // pragmasem.d:65 — `scope(exit) if (sc2 != sc) sc2.pop();` -> try/finally (06 §7.1).
        try {
            for (const s of pd.decl.opSlice()) {
                if (pd.ident === Id.printf || pd.ident === Id.scanf) {
                    setPragmaPrintf(s!, pd.ident === Id.printf);
                    dsymbolSemantic(s!, sc2);
                    continue;
                }

                dsymbolSemantic(s!, sc2);

                // resolved: `version (IN_LLVM)` -> ON, so pragmasem.d:80-83 is live.
                DtoCheckPragma(pd, s!, llvm_internal, arg1str.value);
            }
        } finally {
            if (sc2 !== sc)
                sc2.pop();
        }
    };

    // pragmasem.d:87 — nested `void noDeclarations()`.
    const noDeclarations = (): void => {
        if (pd.decl !== null) {
            error(pd.loc, ds("%s `%s` is missing a terminating `;`"), pd.kind(), pd.toPrettyChars());
            declarations();
            // do them anyway, to avoid segfaults.
        }
    };

    // Should be merged with PragmaStatement
    // dropped: `//printf("\tpragmaDeclSemantic '%s'\n", pd.toChars());` (dmd/pragmasem.d:98)

    if (target.supportsLinkerDirective()) {
        if (pd.ident === Id.linkerDirective) {
            // resolved: `version (IN_LLVM)` -> ON (_config.md §1) — the "not restricted to a single
            // string arg" form is emitted; dropped: the `else // !IN_LLVM` single-arg arm
            // (dmd/pragmasem.d:120-133), including its distinct diagnostic text (07 §1).
            if (pd.args === null || pd.args.length === 0) {
                error(pd.loc, ds("%s `%s` one or more string arguments expected for pragma(linkerDirective)"),
                    pd.kind(), pd.toPrettyChars());
            } else {
                for (let i = 0; i < pd.args.length; ++i) {
                    const se = semanticString(sc, pd.args.opIndex(i)!, ds("linker directive")); // pragmasem.d:111
                    if (se === null)
                        break;
                    pd.args.opIndexAssign(se, i);
                    if (global.params.v.verbose)
                        messageNoLoc(ds("linkopt   %.*s"), se.len, se.peekString());
                }
            }
            noDeclarations(); // D: `return noDeclarations();` — a void-expression return
            return;
        }
    }
    if (pd.ident === Id.msg) {
        if (pd.args === null) {
            noDeclarations();
            return;
        }

        if (!pragmaMsgSemantic(pd.loc, sc, pd.args))
            return;

        noDeclarations();
        return;
    } else if (pd.ident === Id.lib) {
        if (pd.args === null || pd.args.length !== 1) {
            error(pd.loc, ds("%s `%s` string expected for library name"), pd.kind(), pd.toPrettyChars());
        } else {
            const se = semanticString(sc, pd.args.opIndex(0)!, ds("library name")); // pragmasem.d:153
            if (se === null) {
                noDeclarations();
                return;
            }
            pd.args.opIndexAssign(se, 0);

            // `xarraydup`'s signature is nullable-in/nullable-out; `peekString()` returns a
            // non-null slice, so the `!`s below are narrowing artifacts, not D fault sites.
            const name = xarraydup(se.peekString());
            if (global.params.v.verbose)
                messageNoLoc(ds("library   %s"), name!);
            // `moduleDeps.buffer` is a nullable reference and `moduleDeps.name` a nullable SLICE —
            // D's `!global.params.moduleDeps.name` tests the slice POINTER (06 §2.8), which the
            // globals.ts `DString | null` model reproduces exactly.
            if (global.params.moduleDeps.buffer !== null && global.params.moduleDeps.name === null) {
                const ob: OutBuffer = global.params.moduleDeps.buffer;
                const imod: Module = sc._module!; // D dereferences `sc._module` with no null test
                ob.writestring(ds("depsLib "));
                ob.writestring(imod.toPrettyChars());
                ob.writestring(ds(" ("));
                escapePath(ob, imod.srcfile.toChars());
                ob.writestring(ds(") : "));
                ob.writestring(name!);
                ob.writenl();
            }
            // dropped: `mem.xfree(name.ptr);` (dmd/pragmasem.d:173) — JS GC (03 §8, 08 §13).
        }
        noDeclarations();
        return;
    } else if (pd.ident === Id.startaddress) {
        pragmaStartAddressSemantic(pd.loc, sc, pd.args);
        noDeclarations();
        return;
    } else if (pd.ident === Id.Pinline) {
        // this pragma now gets evaluated on demand in function semantic

        declarations();
        return;
    } else if (pd.ident === Id.mangle) {
        // pragmasem.d:190 — the same `newScope(Dsymbol, Scope*)` overload as at :64.
        const sc2 = newScopeDsymbol(pd, sc)!; // `!`: the visitor starts from the non-null `sc` it is handed
        pragmaMangleSemantic(pd.loc, sc2, pd.args, pd.decl);
        if (sc2 !== sc)
            sc2.pop();
        return;
    } else if ((llvm_internal = DtoGetPragma(sc, pd, arg1str)) !== LDCPragmaCpp.LLVMnone) {
        // resolved: `IN_LLVM &&` (pragmasem.d:196) is the manifest `true` (_config.md §1).
        declarations();
        return;
    } else if (pd.ident === Id.crt_constructor || pd.ident === Id.crt_destructor) {
        // Unreachable in LDC, as in ldc2: DtoGetPragma claims both idents (gen/pragma.cpp:166-187) at the arm above.
        if (pd.args !== null && pd.args.length !== 0) {
            error(pd.loc, ds("%s `%s` takes no argument"), pd.kind(), pd.toPrettyChars());
        } else {
            const isCtor = pd.ident === Id.crt_constructor; // `immutable` -> `const` (04 §8)

            // pragmasem.d:208 — nested `static uint recurse(Dsymbol s, bool isCtor)`. `static` means
            // it captures nothing; the arrow's own `isCtor` parameter shadows the enclosing `const`
            // exactly as D's static nested function does. Recursive, so the return type is written.
            const recurse = (s: Dsymbol, isCtor: boolean): number => {
                const ad = s.isAttribDeclaration();
                if (ad !== null) {
                    let nestedCount = 0; // `uint nestedCount;` -> `.init` 0 (09 §1.0)
                    const decls = include(ad, null); // pragmasem.d:213 — UFCS `ad.include(null)`
                    if (decls !== null) {
                        for (let i = 0; i < decls.length; ++i)
                            nestedCount += recurse(decls.opIndex(i)!, isCtor);
                    }
                    return nestedCount;
                } else {
                    const f = s.isFuncDeclaration();
                    if (f !== null) {
                        if (isCtor)
                            f.isCrtCtor = true;
                        else
                            f.isCrtDtor = true;

                        return 1;
                    } else {
                        return 0;
                    }
                }
                assertUnreachable(); // dmd/pragmasem.d:232 — `assert(0);`
            };

            if (recurse(pd, isCtor) > 1)
                error(pd.loc, ds("%s `%s` can only apply to a single declaration"), pd.kind(), pd.toPrettyChars());
        }
        declarations();
        return;
    } else if (pd.ident === Id.printf || pd.ident === Id.scanf) {
        if (pd.args !== null && pd.args.length !== 0)
            error(pd.loc, ds("%s `%s` takes no argument"), pd.kind(), pd.toPrettyChars());
        declarations();
        return;
    } else if (!global.params.ignoreUnsupportedPragmas) {
        error(pd.loc, ds("unrecognized `pragma(%s)`"), pd.ident!.toChars());
        declarations();
        return;
    }

    if (!global.params.v.verbose) {
        declarations();
        return;
    }

    /* Print unrecognized pragmas
     */
    const buf = new OutBuffer();
    buf.writestring(pd.ident!.toString());
    if (pd.args !== null) {
        const errors_save = global.startGagging();
        // GAG PAIRING (11 §2.5, last bullet): a wall reached transitively through `ctfeInterpret`
        // (dinterpret.ts) is an exit path D does not have; without the guard a throw would leave
        // `global.gag` incremented for the life of the process and silently gag every later
        // diagnostic. D needs no such guard. The guide prescribes `finally` specifically (not
        // catch-rethrow): `finally` also covers a `return` or `break` that a later fill may
        // introduce inside the region.
        try {
            for (let i = 0; i < pd.args.length; i++) {
                let e: Expression = pd.args.opIndex(i)!;
                sc = sc.startCTFE();
                e = expressionSemantic(e, sc);
                e = resolveProperties(sc, e);
                // The `!` is a NARROWING artifact, not a D fault site: `endCTFE()`/`pop()` return
                // the scope the matching push came from, which is non-null here (typesem.ts:9864).
                sc = sc.endCTFE()!;
                e = ctfeInterpret(e);
                if (i === 0)
                    buf.writestring(ds(" ("));
                else
                    buf.writeByte(0x2c); // ','
                // pragmasem.d:274 `writestring(const(char)*)`: the bytes before the NUL
                buf.writestring(cstr(e.toChars()));
            }
            if (pd.args.length !== 0) // `if (pd.args.length)` — numeric truthiness (06 §2.5)
                buf.writeByte(0x29); // ')'
        } finally {
            // pragmasem.d:278 — `global.endGagging(errors_save);`
            global.endGagging(errors_save);
        }
    }
    messageNoLoc(ds("pragma    %s"), buf.peekChars());
    declarations();
}

/**
 * dmd/pragmasem.d:293 — `bool pragmaStmtSemantic(PragmaStatement ps, Scope* sc)`.
 * Run semantic on `pragma` statement.
 *
 * Params:
 *  ps = pragma statement to evaluate
 *  sc = enclosing scope
 *
 * Returns : true if `pragma` is valid, or false if an error was found
 */
export function pragmaStmtSemantic(ps: PragmaStatement, sc: Scope): boolean {
    // dropped: `import dmd.statementsem;` (dmd/pragmasem.d:295) — module-level in TS (01 §3).

    /* https://dlang.org/spec/statement.html#pragma-statement
     */
    // Should be merged with PragmaDeclaration

    // dropped: `//printf("pragmaStmtSemantic() %s\n", ps.toChars());` (dmd/pragmasem.d:301)
    // dropped: `//printf("body = %p\n", ps._body);` (dmd/pragmasem.d:302)
    if (ps.ident === Id.msg) {
        if (!pragmaMsgSemantic(ps.loc, sc, ps.args))
            return false;
    } else if (ps.ident === Id.lib) {
        // resolved: `version (all)` -> always ON (built-in, _config.md §3); dropped: the `else`
        // arm (dmd/pragmasem.d:317-335, the never-compiled `pragma(lib)`-as-statement handling).
        /* Should this be allowed?
         */
        error(ps.loc, ds("`pragma(lib)` not allowed as statement"));
        return false;
    }
    // IN_LLVM. FIXME Move to pragma.cpp
    else if (ps.ident === Id.LDC_allow_inline) {
        sc.func!.allowInlining = true; // D dereferences `sc.func` with no null test
    }
    // IN_LLVM. FIXME Move to pragma.cpp
    else if (ps.ident === Id.LDC_never_inline) {
        sc.func!.neverInline = true;
    }
    // IN_LLVM. FIXME Move to pragma.cpp
    else if (ps.ident === Id.LDC_profile_instr) {
        // dropped: `import gen.dpragma : DtoCheckProfileInstrPragma;` (dmd/pragmasem.d:350) —
        // module-level in TS (01 §3).

        const emitInstr: Ref<boolean> = { value: true }; // `ref bool value` param -> box (03 §3.2)
        if (ps.args === null || ps.args.length !== 1 || !DtoCheckProfileInstrPragma(ps.args.opIndex(0)!, emitInstr)) {
            error(ps.loc, ds("pragma(LDC_profile_instr, true or false) expected"));
            return false;
        } else {
            const fd = sc.func;
            if (fd === null) {
                error(ps.loc, ds("pragma(LDC_profile_instr, ...) is not inside a function"));
                return false;
            }
            fd.emitInstrumentation = emitInstr.value;
        }
    } else if (ps.ident === Id.linkerDirective) {
        /* Should this be allowed?
         */
        error(ps.loc, ds("`pragma(linkerDirective)` not allowed as statement"));
        return false;
    } else if (ps.ident === Id.startaddress) {
        if (!pragmaStartAddressSemantic(ps.loc, sc, ps.args))
            return false;
    } else if (ps.ident === Id.Pinline) {
        // `if (auto fd = sc.func)` — declaration in a condition, hoisted (06 §2.6 + §2.7).
        const fd = sc.func;
        if (fd !== null) {
            fd.inlining = evalPragmaInline(ps.loc, sc, ps.args);
        } else {
            error(ps.loc, ds("`pragma(inline)` is not inside a function"));
            return false;
        }
    } else if (ps.ident === Id.mangle) {
        const es = ps._body !== null ? ps._body.isExpStatement() : null;
        const de = es !== null ? es.exp!.isDeclarationExp() : null;
        // `Dsymbols decls = de ? Dsymbols(de.declaration) : Dsymbols();` — the `Array!T` typesafe
        // variadic ctor (array.d:60) vs the default ctor. Constructed AS the `Dsymbols` alias, so
        // the element type is `Dsymbol | null` (08 §3).
        const decls: Dsymbols = de !== null
            ? DArray.from<Dsymbol | null>(de.declaration)
            : new DArray<Dsymbol | null>();
        // `decls.length ? &decls : null` — `&decls` on a value struct local is the object
        // reference itself (03 §7.2); `decls.length` is numeric truthiness (06 §2.5).
        if (!pragmaMangleSemantic(ps.loc, sc, ps.args, decls.length !== 0 ? decls : null))
            return false;
    } else if (!global.params.ignoreUnsupportedPragmas) {
        error(ps.loc, ds("unrecognized `pragma(%s)`"), ps.ident!.toChars());
        return false;
    }

    if (ps._body !== null) {
        if (ps.ident === Id.msg || ps.ident === Id.startaddress) {
            error(ps.loc, ds("`pragma(%s)` is missing a terminating `;`"), ps.ident!.toChars());
            return false;
        }
        ps._body = statementSemantic(ps._body, sc);
    }
    return true;
}

/***************************************
 * dmd/pragmasem.d:428 — `package PINLINE evalPragmaInline(Loc loc, Scope* sc, Expressions* args)`.
 * Interpret a `pragma(inline, x)`.
 *
 * D `package` visibility has no TS counterpart; the function is exported (its cross-module
 * consumer is `funcDeclarationSemantic`, dmd/funcsem.d:532).
 *
 * Params:
 *   loc = location for error messages
 *   sc = scope for evaluation of argument
 *   args = pragma arguments
 * Returns: corresponding `PINLINE` state
 */
export function evalPragmaInline(loc: Loc, sc: Scope, args: Expressions | null): PINLINE {
    if (args === null || args.length === 0)
        return PINLINE.default_;

    if (args !== null && args.length > 1) {
        // `cast(ulong) args.length` feeding `%llu` -> the bigint domain (09 §1/§5).
        error(loc, ds("one boolean expression expected for `pragma(inline)`, not %llu"), BigInt(args.length));
        args.setDim(1);
        args.opIndexAssign(ErrorExp.get(), 0);
    }

    let e: Expression = args.opIndex(0)!;
    if (e.type === null) { // `if (!e.type)` — nullable reference (06 §2.7)
        sc = sc.startCTFE();
        e = expressionSemantic(e, sc);
        e = resolveProperties(sc, e);
        // `!`: narrowing artifact — `endCTFE()` returns the scope `startCTFE()` pushed from.
        sc = sc.endCTFE()!;
        e = ctfeInterpret(e);
        e = toBoolean(e, sc);
        if (e.isErrorExp() !== null)
            error(loc, ds("pragma(`inline`, `true` or `false`) expected, not `%s`"), args.opIndex(0)!.toChars());
        args.opIndexAssign(e, 0);
    }

    const opt = toBool(e); // copy elided: fresh rvalue, read-only (03 §9)
    if (opt.isEmpty())
        return PINLINE.default_;
    if (opt.get())
        return PINLINE.always;
    return PINLINE.never;
}

/***********************************************************
 * dmd/pragmasem.d:472 — `private bool pragmaMsgSemantic(Loc loc, Scope* sc, Expressions* args)`.
 * Evaluate and print a `pragma(msg, args)`.
 *
 * D module-private (pragmasem.d:472); emitted non-`private` (TS has no module visibility, 01 §2.5)
 * and exported so the co-located `pragmasem.test.ts` can drive it (dmodule.ts:122 precedent).
 *
 * Params:
 *    loc = location for error messages
 *    sc = scope for argument interpretation
 *    args = expressions to print
 * Returns:
 *    `true` on success
 */
export function pragmaMsgSemantic(loc: Loc, sc: Scope, args: Expressions | null): boolean {
    // dropped: `import dmd.tokens;` / `import dmd.common.outbuffer;` (dmd/pragmasem.d:474-475) —
    // module-level in TS; nothing in this body names a `dmd.tokens` symbol.

    if (args === null)
        return true;

    const buf = new OutBuffer();
    if (expressionsToString(buf, sc, args, loc, ds("while evaluating `pragma(msg, %s)`"), false)) // pragmasem.d:481
        return false;

    buf.writestring(ds("\n"));
    // `fprintf(stderr, "%s", buf.extractChars)` -> assemble once, ONE raw stderr write (10 §4.4).
    // `extractChars` CONSUMES the buffer here exactly as it does in D (08 §13a.2).
    process.stderr.write(dsToJs(dmdformat(ds("%s"), [buf.extractChars()])));
    return true;
}

/**
 * dmd/pragmasem.d:498 — `private void setPragmaPrintf(Dsymbol s, bool printf)`.
 * Apply pragma printf/scanf to FuncDeclarations under `s`, poking through attribute declarations
 * such as `extern(C)` but not through aggregates or function bodies.
 *
 * D module-private (pragmasem.d:498); emitted non-`private` and exported so `pragmasem.test.ts`
 * can drive it (01 §2.5, 10 §1.7).
 *
 * Params:
 *    s = symbol to apply
 *    printf = `true` for printf, `false` for scanf
 */
export function setPragmaPrintf(s: Dsymbol, printf: boolean): void {
    const fd = s.isFuncDeclaration();
    if (fd !== null) {
        fd.printf = printf;
        fd.scanf = !printf;
    }

    const ad = s.isAttribDeclaration();
    if (ad !== null) {
        // pragmasem.d:508 — `ad.include(null)`. The `.foreachDsymbol(dg)` that consumes it is
        // dsymbol.d's `void delegate` overload (the lambda has no return) -> `foreachDsymbolVoid` (04 §1B).
        foreachDsymbolVoid(include(ad, null), (s) => {
            setPragmaPrintf(s, printf);
        });
    }
}

/***********************************************************
 * dmd/pragmasem.d:522 — `private bool pragmaStartAddressSemantic(Loc loc, Scope* sc,
 * Expressions* args)`. Evaluate `pragma(startAddress, func)` and store the resolved symbol in
 * `args`.
 *
 * D module-private (pragmasem.d:522); emitted non-`private` and exported so `pragmasem.test.ts`
 * can drive it (01 §2.5, 10 §1.7).
 *
 * Params:
 *    loc = location for error messages
 *    sc = scope for argument interpretation
 *    args = pragma arguments
 * Returns:
 *    `true` on success
 */
export function pragmaStartAddressSemantic(loc: Loc, sc: Scope, args: Expressions | null): boolean {
    // dropped: `import dmd.dtemplate;` (dmd/pragmasem.d:524) — no symbol of `dmd.dtemplate` is
    // named in this body (an upstream dead import); nothing to emit.

    if (args === null || args.length !== 1) {
        error(loc, ds("function name expected for start address"));
        return false;
    } else {
        /* https://issues.dlang.org/show_bug.cgi?id=11980
         * resolveProperties and ctfeInterpret call are not necessary.
         */
        let e: Expression = args.opIndex(0)!;
        sc = sc.startCTFE();
        e = expressionSemantic(e, sc);
        // dropped (upstream comment, kept verbatim): `// e = resolveProperties(sc, e);`
        // `!`: narrowing artifact — `endCTFE()` returns the scope `startCTFE()` pushed from.
        sc = sc.endCTFE()!;

        // dropped (upstream comment, kept verbatim): `// e = e.ctfeInterpret();`
        args.opIndexAssign(e, 0);
        const sa = getDsymbol(e); // pragmasem.d:544
        if (sa === null || sa.isFuncDeclaration() === null) {
            error(loc, ds("function name expected for start address, not `%s`"), e.toChars());
            return false;
        }
    }
    return true;
}

/***********************************************************
 * dmd/pragmasem.d:573 — `private bool pragmaMangleSemantic(Loc loc, Scope* sc, Expressions* args,
 * Dsymbols* decls)`. Evaluate `pragma(mangle)` and store the mangled string in `decls`.
 * This accepts any of the following variants.
 *
 *      pragma(mangle, StringExp) AggregateDeclaration
 *      pragma(mangle, StringExp) VarDeclaration
 *      pragma(mangle, StringExp) FuncDeclaration
 *      pragma(mangle, TypeExp) AggregateDeclaration
 *      pragma(mangle, TypeExp, StringExp) AggregateDeclaration
 *      pragma(mangle, StringExp, TypeExp) AggregateDeclaration
 *
 * D module-private (pragmasem.d:573); emitted non-`private` and exported so `pragmasem.test.ts`
 * can drive it (01 §2.5, 10 §1.7).
 *
 * Params:
 *    loc = location for error messages
 *    sc = scope for argument interpretation
 *    args = pragma arguments
 *    decls = declarations to set mangled string to
 * Returns:
 *    `true` on success
 */
export function pragmaMangleSemantic(loc: Loc, sc: Scope, args: Expressions | null,
                                     decls: Dsymbols | null): boolean {
    // dropped: `import dmd.root.rmem;` (dmd/pragmasem.d:575) — its only uses are `mem.xfree`
    // calls, erased under JS GC (03 §8); `xarraydup` is imported at module level.

    // pragmasem.d:577 — nested `StringExp verifyMangleString(ref Expression e)`. The `ref` slot is
    // REASSIGNED (`e = se;`), so it is a `Ref<Expression>` box (03 §3.2/§7.2). The arrow reads the
    // ENCLOSING `sc`, which `applyPragmaMangle` reassigns across its CTFE round trips — the same
    // shared-variable capture D's nested function has.
    const verifyMangleString = (e: Ref<Expression>): StringExp | null => {
        // dropped: `import dmd.mangle : isValidMangling;` (dmd/pragmasem.d:579) and
        // `import dmd.root.utf : utf_decodeChar;` (:580) — neither symbol is referenced anywhere in
        // this body (upstream dead imports); nothing to emit.
        const se = semanticString(sc, e.value, ds("pragma mangle argument")); // pragmasem.d:581
        if (se === null)
            return null;
        e.value = se;
        if (se.len === 0) { // `if (!se.len)` — numeric truthiness (06 §2.5)
            error(loc, ds("`pragma(mangle)` zero-length string not allowed for mangled name"));
            return null;
        }
        if (se.sz !== 1) {
            error(loc, ds("`pragma(mangle)` mangled name characters can only be of type `char`"));
            return null;
        }
        const slice = se.toStringz();
        if (cstrlen(slice) !== se.len) // `strlen(slice.ptr)` -> `cstrlen` (02 §11.2)
            error(loc, ds("pragma `mangle` null character not allowed in mangled name"));
        // dropped: `mem.xfree(cast(void*)slice.ptr);` (dmd/pragmasem.d:598) — JS GC (03 §8).
        return se;
    };

    // pragmasem.d:602 — nested `bool applyPragmaMangle(Dsymbols* decls, ref uint count,
    // ref bool ignored)`. Both `ref` scalars are REASSIGNED by the callee -> `Ref<T>` boxes.
    // The parameter `decls` shadows the enclosing one, exactly as in D.
    const applyPragmaMangle = (decls: Dsymbols | null, count: Ref<number>, ignored: Ref<boolean>): boolean => {
        if (decls === null)
            return true;

        for (const s of decls.opSlice()) {
            // dropped: the five function-local imports at dmd/pragmasem.d:609-613 — module-level
            // in TS (01 §3).

            dsymbolSemantic(s!, sc);

            const ad = s!.isAggregateDeclaration();
            if (ad !== null) {
                /* pragma(mangle) AggregateDeclaration;
                   For aggregates there may be one or two AssignExpressions:
                   - one of which must evaluate at compile time to a string literal
                   - one which must evaluate to a symbol
                   The spec does not specify which order these should be in, so we
                   allow any of:
                   pragma(mangle, "name") struct { ... }
                   pragma(mangle, T)      struct { ... }
                   pragma(mangle, "name", T) struct { ... }
                   pragma(mangle, T, "name") struct { ... }
                 */
                let symbol: AggregateDeclaration | null = null;
                let literal: StringExp | null = null;

                // `foreach (ref Expression e; (*args)[])` — the `ref` aliases the CONTAINER slot
                // (D's `[]` is a view onto `args`' storage), so `e = …` writes back into `args`.
                // `DArray.opSlice()` returns a COPY, so the loop is indexed and `e` is a Ref box
                // over the slot. `args!`: `args` is null-checked below, but a parameter's narrowing
                // does not reach into this closure.
                // `[]` yields a SLICE whose length is fixed when the foreach begins, so the bound is
                // captured ONCE (06 §1.3) — re-reading `args.length` per iteration would follow a
                // container a callee grew, which D's snapshot cannot see.
                const argsDim = args!.length;
                for (let i = 0; i < argsDim; i++) {
                    const e: Ref<Expression> = {
                        get value(): Expression { return args!.opIndex(i)!; },
                        set value(v: Expression) { args!.opIndexAssign(v, i); },
                    };
                    sc = sc.startCTFE();
                    e.value = expressionSemantic(e.value, sc);
                    e.value = resolveProperties(sc, e.value);
                    // `!`: narrowing artifact — `endCTFE()` returns the pushed-from scope.
                    sc = sc.endCTFE()!;

                    // pragmasem.d:640 — nested `bool expectedString()`.
                    const expectedString = (): boolean => {
                        error(e.value.loc,
                            ds("`string` expected for pragma mangle argument, not `%s` of type `%s`"),
                            e.value.toChars(), e.value.type!.toChars());
                        return false;
                    };

                    // pragmasem.d:647 — nested `bool expectedType()`.
                    const expectedType = (): boolean => {
                        error(e.value.loc,
                            ds("`class` or `struct` type expected for pragma mangle argument, not `%s` of type `%s`"),
                            e.value.toChars(), e.value.type!.toChars());
                        return false;
                    };

                    // Validate arguments to pragma(mangle)
                    if (e.value.isTypeExp() !== null) {
                        /* Check for and reject:
                           pragma(mangle, TypeExp, TypeExp)
                           where the first TypeExp already resolved to a symbol. */
                        if (symbol !== null)
                            return expectedString();

                        /* Type must be a class or struct symbol. */
                        const tc = e.value.type!.isTypeClass();
                        if (tc !== null) {
                            // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows
                            // Dsymbol.deferred (bool) — aggregate.d:94 vs dsymbol.d, so TS rejects
                            // the sound ClassDeclaration -> AggregateDeclaration upcast (02 §11.5).
                            symbol = tc.sym as unknown as AggregateDeclaration | null;
                        } else {
                            const ts = e.value.type!.isTypeStruct();
                            if (ts !== null)
                                // upcast cascade: same shadowed pair as above (02 §11.5).
                                symbol = ts.sym as unknown as AggregateDeclaration | null;
                            else
                                return expectedType();
                        }
                    } else {
                        /* Check for and reject:
                           pragma(mangle, StringExp, AssignExpression)
                           where AssignExpression did not resolve to a symbol. */
                        if (literal !== null)
                            return expectedType();

                        /* Must evaluate to a compile time string literal. */
                        const se = verifyMangleString(e);
                        if (se === null)
                            return false;
                        literal = se;
                    }
                }

                ad.pMangleOverride = new MangleOverride(); // `new MangleOverride` on a struct

                if (symbol !== null) {
                    // upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows
                    // Dsymbol.deferred (bool) — aggregate.d:94 vs dsymbol.d (02 §11.5).
                    ad.pMangleOverride.agg = symbol as unknown as Dsymbol;
                    /* The identifier of the symbol is used when no string is supplied. */
                    if (literal === null) {
                        ad.pMangleOverride.id = symbol.ident;
                        count.value += 1;
                        continue;
                    }
                }

                assert(literal !== null); // `assert(literal)` — nullable ref in a bool context (06 §2.7)
                // `xarraydup` is nullable-in/nullable-out; `peekString()` is non-null, so the `!`
                // is a narrowing artifact, not a D fault site.
                const name = xarraydup(literal.peekString());
                ad.pMangleOverride.id = Identifier.idPool(name!);
                count.value += 1;
            } else {
                const td = s!.isTemplateDeclaration();
                if (td !== null) {
                    /* pragma(mangle) TemplateDeclaration
                       Give an informative error message to avoid pragma(mangle)
                       silently ignoring the template symbol. */
                    error(loc, ds("`pragma(mangle)` cannot apply to a template declaration"));
                    const buf = new OutBuffer();
                    // pragmasem.d:713 — `buf.arrayObjectsToBuffer(cast(Objects*)args)`, UFCS. The
                    // cast reinterprets the `Expressions*` container as an `Objects*`; `Expression` IS
                    // a `RootObject`, so this is a container-level upcast with nothing reinterpreted
                    // at runtime.
                    arrayObjectsToBuffer(buf, args);
                    errorSupplemental(loc, ds("use `template %s(Args...) { pragma(mangle, %s) ... }`"),
                        td.ident!.toChars(), buf.peekChars());
                    return false;
                } else {
                    const ad = s!.isAttribDeclaration();
                    if (ad !== null) {
                        /* pragma(mangle) AttribDeclaration
                           Poke through the attribute to get to the underlying declaration. */
                        // pragmasem.d:721 — UFCS `ad.include(null)`.
                        if (!applyPragmaMangle(include(ad, null), count, ignored))
                            return false;
                    } else if (s!.isFuncDeclaration() !== null || s!.isVarDeclaration() !== null) {
                        /* pragma(mangle) Declaration;
                           For all other symbols, there must be one AssignExpression and it
                           must evaluate at compile time to a string literal. */
                        if (args!.length !== 1) {
                            error(loc, ds("`pragma(mangle)` takes a single argument that must be a string literal"));
                            return false;
                        }
                        // `verifyMangleString((*args)[0])` passes the container SLOT by ref.
                        const e0: Ref<Expression> = {
                            get value(): Expression { return args!.opIndex(0)!; },
                            set value(v: Expression) { args!.opIndexAssign(v, 0); },
                        };
                        const se = verifyMangleString(e0);
                        if (se === null)
                            return false;

                        const name = xarraydup(se.peekString());
                        s!.isDeclaration()!.mangleOverride = name;
                        count.value += 1;
                    } else {
                        /* pragma(mangle) only applies to function and variable
                           symbols. Other symbols are ignored. */
                        ignored.value = true;
                    }
                }
            }
        }
        return true;
    };

    if (args === null) {
        error(loc, ds("`pragma(mangle)` expects string literal argument for mangled name"));
        return false;
    }
    if (args.length > 2) {
        error(loc, ds("`pragma(mangle)` expects 1 or 2 arguments"));
        return false;
    }

    const count: Ref<number> = { value: 0 };
    const ignored: Ref<boolean> = { value: false };
    if (!applyPragmaMangle(decls, count, ignored))
        return false;

    if (count.value === 0 && !ignored.value) {
        error(loc, ds("`pragma(mangle)` must be attached to a declaration"));
        return false;
    }
    if (count.value > 1) {
        error(loc, ds("`pragma(mangle)` can only apply to a single declaration"));
        return false;
    }
    return true;
}
