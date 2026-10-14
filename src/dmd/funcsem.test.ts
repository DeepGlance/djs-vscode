// Co-located tests for src/dmd/funcsem.ts.
//
// dmd/funcsem.d carries ZERO in-source `unittest{}` blocks (verified: `grep -c '^unittest'` -> 0),
// so this file is the THIN FLEET ARTIFACT of 10 §1.6b: one module-load smoke test plus one behaviour
// pin per risky RESOLVED CONSTRUCT of the translation. No new harness machinery, no fabricated pins
// for paths the harness cannot reach honestly — the sema corpus tests (sema.func.test.ts and the
// rung suites) are the oracle for `funcDeclarationSemantic`'s live spine.
//
// Harness init follows the canonical snippet (10 §1.5): Loc._init() + initTokens() + Id.initialize().
//
// SWEPT WALLS (14 §8 end-of-wave sweep) — eight walls of funcsem.ts stood over callees that have
// since landed, plus one CARRY-OVER (04 §6) re-pointed to its faithful home, taking with it the
// inner wall on `isMustUseAttribute` it contained. The faithful calls now stand at the D
// statements' positions:
//   * `checkMustUseReserved`     dmd/funcsem.d:537  (carry-over)      -> dmd/mustuse.d:58       (mustuse.ts:143)
//   * `functionResolve`          dmd/funcsem.d:1937/:2124/:2169/:2193 -> dmd/templatesem.d:5672 (templatesem.ts:6040)
//   * `computeOneMember`         dmd/funcsem.d:2209/:2240/:2323       -> dmd/templatesem.d:441  (templatesem.ts:761)
//   * `getConstraintEvalError`   dmd/funcsem.d:2332                   -> dmd/templatesem.d:3615 (templatesem.ts:3897)
// NO pin in this file moved: no test pinned any of those messages (verified by a full-suite run
// before and after the sweep — identical failing set and identical throw signatures). NOT PINNED
// HERE, and named as such per 10 §1.8 rule 9: the swept paths all need a real `Scope` (and, for
// `resolveFuncCall`, a populated overload set), which this thin artifact deliberately does not
// build. `funcDeclarationSemantic`'s spine — the swept `checkMustUseReserved` call included — is
// exercised by sema.func.test.ts, which is the named oracle for it; the `resolveFuncCall` and
// `printCandidates` legs stay uncovered until that oracle grows an overload-resolution case.

import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    FuncResolveFlag,
    LevelError,
    addPostInvariant,
    addPreInvariant,
    arrayBoundsCheck,
    checkMain,
    genCfunc,
    genCfuncFromName,
    hasNestedFrameRefs,
    isUnique,
    isVirtual,
    isVirtualMethod,
    needsFensure,
    nullDerefCheck,
    overloadApply,
} from "./funcsem.js";

import { CHECKENABLE, LINK, STC, TRUST, VarArg } from "./astenums.js";
import { DtorDeclaration, FuncDeclaration, FuncLiteralDeclaration } from "./func.js";
import { ParameterList, Type, TypeFunction } from "./mtype.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { TOK, initTokens } from "./tokens.js";
import { global } from "./globals.js";
import { ds } from "../dstring.js";
import type { Dsymbol } from "./dsymbol.js";
import { Type_init } from "./typesem.js";

beforeEach(() => {
    Loc._init();
    initTokens();
    Id.initialize();
    Type_init();
});

function id(name: string): Identifier {
    return Identifier.idPool(ds(name));
}

/** `int <name>(int a)` as a bare module-level FuncDeclaration (no semantic run). */
function makeFunc(name: string): FuncDeclaration {
    const tf = new TypeFunction(new ParameterList(null, VarArg.none), Type.tint32, LINK.d);
    return new FuncDeclaration(Loc.initial, Loc.initial, id(name), STC.none, tf);
}

describe("funcsem.ts — module-load smoke (10 §1.6b)", () => {
    test("importing the module executes its top-level and exposes the D surface", () => {
        // funcsem.d has module-level state (`genCfunc`'s __gshared DsymbolTable, `printedMain`) and
        // a long import list — a load-order/cycle regression shows up right here.
        expect(typeof isVirtual).toBe("function");
        expect(typeof overloadApply).toBe("function");
        expect(typeof checkMain).toBe("function");
    });
});

describe("funcsem.ts — resolved constructs", () => {
    // CONCERN 1 — the manifest constant `enum LevelError = -2;` (funcsem.d:3347) is a `const`, never
    // a TS enum (02 §4.1); `getLevelAndCheck`/`getLevel` compare against this exact value.
    test("LevelError is the manifest constant -2", () => {
        expect(LevelError).toBe(-2);
    });

    // CONCERN 2 — `enum FuncResolveFlag : ubyte` (funcsem.d:1882) is a ≤32-bit-based named enum, so
    // it stays a TS enum with D's literal bit values (02 §4.2); `resolveFuncCall` masks with them.
    test("FuncResolveFlag keeps D's bit values", () => {
        expect(FuncResolveFlag.standard).toBe(0);
        expect(FuncResolveFlag.quiet).toBe(1);
        expect(FuncResolveFlag.overloadOnly).toBe(2);
        expect(FuncResolveFlag.ufcs).toBe(4);
        expect(FuncResolveFlag.quiet | FuncResolveFlag.ufcs).toBe(5);
    });

    // CONCERN 3 — the `switch (_this.dsym)` RTTI-tag dispatch of `isVirtual` (funcsem.d:188) is
    // emitted IN FULL (13 §7.5 rule 1). Two arms are checked: the flat `return false` group and the
    // dtor arm, which is NOT `false` but `vtblIndex != -1` (funcsem.d:204).
    test("isVirtual's dsym dispatch: literal arm is false, dtor arm reads vtblIndex", () => {
        const tf = new TypeFunction(new ParameterList(null, VarArg.none), Type.tvoid, LINK.d);
        const fld = new FuncLiteralDeclaration(Loc.initial, Loc.initial, tf, TOK.function_, null, null);
        expect(isVirtual(fld)).toBe(false);          // DSYM.funcLiteralDeclaration arm
        expect(isVirtualMethod(fld)).toBe(false);    // funcsem.d:216 — !isVirtual -> false

        const dd = new DtorDeclaration(Loc.initial, Loc.initial);
        expect(dd.vtblIndex).toBe(-1);               // FuncDeclaration's declared default
        expect(isVirtual(dd)).toBe(false);           // dtor arm: vtblIndex === -1
        dd.vtblIndex = 3;
        expect(isVirtual(dd)).toBe(true);            // dtor arm: vtblIndex !== -1 (the extern(C++) hack)
    });

    // CONCERN 4 — `addPreInvariant`/`addPostInvariant` reach `visitFuncDeclaration` through the
    // `default:` arm of the same dispatch, and its first conjunct is `_this.isThis()` — null for a
    // module-level function, so both are false regardless of `useInvariants`.
    test("addPre/addPostInvariant default arm: no enclosing aggregate -> false", () => {
        const f = makeFunc("f");
        const saved = global.params.useInvariants;
        try {
            global.params.useInvariants = CHECKENABLE.on;
            expect(f.isThis()).toBe(null);
            expect(addPreInvariant(f)).toBe(false);
            expect(addPostInvariant(f)).toBe(false);
        } finally {
            global.params.useInvariants = saved;
        }
    });

    // CONCERN 5 — `checkMain` (funcsem.d:3245) early-returns for anything that is not a top-level
    // `main`; every path past the guard needs a resolved TypeFunction. The guard is what keeps
    // `funcDeclarationSemantic`'s live spine free of the main()-signature machinery.
    test("checkMain is a no-op for a non-`main` module-level function", () => {
        const f = makeFunc("f");
        expect(() => checkMain(f)).not.toThrow();
        expect(f.ident).not.toBe(Id.main);
    });

    // CONCERN 6 — `needsFensure` (funcsem.d:3081) recurses over `foverrides`; with no contracts and
    // no overrides it is false. The contract accessors are METHODS in the port (`fensures()`), which
    // is the shape this pin protects.
    test("needsFensure: no out-contract and no overrides -> false", () => {
        const f = makeFunc("f");
        expect(f.fensures()).toBe(null);
        expect(f.foverrides.length).toBe(0);
        expect(needsFensure(f)).toBe(false);
    });

    // CONCERN 7 — `hasNestedFrameRefs` (funcsem.d:231) reads `closureVars`, then `fdrequire`/
    // `fdensure` (accessor methods, not fields), then recurses through `foverrides`.
    test("hasNestedFrameRefs: no closure vars, no contracts, no overrides -> false", () => {
        const f = makeFunc("f");
        expect(f.closureVars.length).toBe(0);
        expect(f.fdrequire()).toBe(null);
        expect(f.fdensure()).toBe(null);
        expect(hasNestedFrameRefs(f)).toBe(false);
    });

    // CONCERN 8 — `overloadApply` (funcsem.d:4084) walks the `.overnext` chain, calls `dg` per
    // symbol, stops on a non-zero return, and pushes every visited symbol into `visited` so a cyclic
    // chain terminates. All three behaviours in one pin.
    test("overloadApply walks the overnext chain, honours dg's stop code, and survives a cycle", () => {
        const a = makeFunc("a");
        const b = makeFunc("b");
        a.overnext = b;

        const seen: string[] = [];
        expect(overloadApply(a, (s: Dsymbol): number => {
            seen.push(String(s.ident!.toString()));
            return 0;
        })).toBe(0);
        expect(seen.length).toBe(2);

        // dg's non-zero return is the function's return value and stops the walk (funcsem.d:4167).
        let count = 0;
        expect(overloadApply(a, (): number => { count++; return 7; })).toBe(7);
        expect(count).toBe(1);

        // Cyclic chain: the `visited.contains(d)` guard (funcsem.d:4094) terminates it.
        b.overnext = a;
        let n = 0;
        expect(overloadApply(a, (): number => { n++; return 0; })).toBe(0);
        expect(n).toBe(2);
    });

    // CONCERN 9 — `isUnique(FuncDeclaration)` (funcsem.d:408) rides on `overloadApply`: one function
    // is unique, two in the same overload set are not. (Its same-arity sibling
    // `isUnique(OverDeclaration)` at funcsem.d:4189 carries the 04 §1.1(b) rename.)
    test("isUnique: single function true, two-member overload set false", () => {
        const a = makeFunc("a");
        expect(isUnique(a)).toBe(true);
        a.overnext = makeFunc("a");
        expect(isUnique(a)).toBe(false);
    });

    // CONCERN 10 — `genCfunc`'s function-`static` `__gshared DsymbolTable st` (funcsem.d:272) becomes
    // module-level state in the port: the second lookup of the same name must return the SAME
    // FuncDeclaration. The pin also fixes the 04 §1.1(b) overload-pair naming (the `const(char)*`
    // form is `genCfuncFromName`, the `Identifier` form keeps the bare name).
    test("genCfunc interns by identifier; genCfuncFromName routes to the same table entry", () => {
        const ident = id("__djs_test_cfunc");
        const first = genCfunc(null, Type.tvoid, ident, STC.none);
        expect(first.ident).toBe(ident);
        expect(first._linkage).toBe(LINK.c);
        expect(genCfunc(null, Type.tvoid, ident, STC.none)).toBe(first);
        // The name form interns the same identifier, so it hits the same slot.
        expect(genCfuncFromName(null, Type.tvoid, ds("__djs_test_cfunc\0"), STC.none)).toBe(first);
    });

    // CONCERN 11 — `arrayBoundsCheck`/`nullDerefCheck` (funcsem.d:4293/:4322) are `final switch`es
    // over CHECKENABLE: off/on are constant, `safeonly` reads the function's TypeFunction trust, and
    // `_default` is D's `assert(0)` -> `assertUnreachable()` (NOT a wall).
    test("arrayBoundsCheck / nullDerefCheck: the CHECKENABLE final-switch arms", () => {
        const savedA = global.params.useArrayBounds;
        const savedN = global.params.useNullCheck;
        try {
            const safeFn = makeFunc("s");
            safeFn.type!.isTypeFunction()!.trust = TRUST.safe;
            const sysFn = makeFunc("y");
            sysFn.type!.isTypeFunction()!.trust = TRUST.system;

            global.params.useArrayBounds = CHECKENABLE.off;
            expect(arrayBoundsCheck(safeFn)).toBe(false);
            global.params.useArrayBounds = CHECKENABLE.on;
            expect(arrayBoundsCheck(null)).toBe(true);
            global.params.useArrayBounds = CHECKENABLE.safeonly;
            expect(arrayBoundsCheck(safeFn)).toBe(true);
            expect(arrayBoundsCheck(sysFn)).toBe(false);
            expect(arrayBoundsCheck(null)).toBe(false);

            global.params.useNullCheck = CHECKENABLE.safeonly;
            expect(nullDerefCheck(safeFn)).toBe(true);
            expect(nullDerefCheck(sysFn)).toBe(false);
            global.params.useNullCheck = CHECKENABLE.off;
            expect(nullDerefCheck(safeFn)).toBe(false);
        } finally {
            global.params.useArrayBounds = savedA;
            global.params.useNullCheck = savedN;
        }
    });
});

describe("printCandidates — the function-candidate line (funcsem.d:2303)", () => {
    // funcsem.d:2303 writes `parametersTypeToChars()` through `writestring(const(char)*)`, which stops at
    // the NUL. The TS result is an `extractChars()` buffer carrying one; written whole, the `%s` of the
    // supplemental stopped there and dropped the ` const` suffix. Pinned against ldc2 1.43.0 (`ldc2 -o- p.d`),
    // header included.
    test("keeps the member-function attributes after the parameter list (ldc2: p.d)", async () => {
        const { Parser } = await import("./parse.js");
        const { ErrorSinkCompiler, setDiagnosticHandler } = await import("./errors.js");
        const { moduleFromParse } = await import("./dmodule.js");
        const { runSemantic } = await import("./dsymbolsem.js");
        const { dmdformat } = await import("./root/dmdformat.js");
        const { initSemaHarness } = await import("../sema-harness.js");
        const { global } = await import("./globals.js");
        const { dsToJs } = await import("../dstring.js");
        initSemaHarness();
        global.errorSink = new ErrorSinkCompiler();
        const diags: string[] = [];
        setDiagnosticHandler((_loc, _color, header, messageFormat, args) => {
            diags.push(dsToJs(header) + dsToJs(dmdformat(messageFormat, [...args])));
            return true;
        });
        try {
            const text = "module p;\nstruct S { void f(int) const {} void f(char[]) const {} }\n" +
                "void main(){ S s; s.f(1.5); }\n";
            const src = new Uint8Array(text.length + 1); // NUL-terminated: the lexer scans to the sentinel
            for (let i = 0; i < text.length; i++) src[i] = text.charCodeAt(i);
            const p = new Parser(null, null, src, false, global.errorSink, null, false);
            p.nextToken();
            runSemantic(moduleFromParse(p.parseModule(), p.md));
        } finally {
            setDiagnosticHandler(null);
        }
        expect(diags.slice(1)).toEqual([
            "       Candidates are: `p.S.f(int __param_0) const`",
            "                       `p.S.f(char[] __param_0) const`",
        ]);
    });
});

/**
 * Pins whose D path needs druntime (`Object` for a class, the `with` temporary's construction): one ldc2-shaped
 * compile through the shim (src/djs.ts `djsMain`, druntime from the shim's ldc2.conf import directory) in a fresh
 * module registry, as escape.test.ts does. Expected text: ldc2 1.43.0 `-c -o-` on the same file, byte for byte.
 */
describe("funcsem on the driver path", () => {
    const dir = mkdtempSync(join(tmpdir(), "djs-funcsem-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    async function shim(args: string[]): Promise<{ code: number; stderr: string }> {
        vi.resetModules();
        const { djsMain } = await import("../djs.js");
        const err: string[] = [];
        const e = vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array): boolean => {
            err.push(typeof c === "string" ? c : new TextDecoder().decode(c));
            return true;
        });
        try {
            return { code: djsMain(args), stderr: err.join("") };
        } finally {
            e.mockRestore();
        }
    }

    // funcsem.d:4278 reads `(cast(AssignExp)e).e2` of the `with` temporary's initializer, a ConstructExp: the tag
    // test proves an AssignExp subclass, which isAssignExp() (EXP.assign only) cannot express.
    test("a delegate inside `with (rvalue)` checks the temporary's construction (funcsem.d:4278)", async () => {
        const f = join(dir, "w.d");
        writeFileSync(f, "module w;\nstruct S { int a; }\nS make() { return S(1); }\n"
            + "int f() { with (make()) { int delegate() dg = () => a; return dg(); } }\n");
        expect(await shim(["-c", "-o-", f])).toEqual({ code: 0, stderr: "" });
    }, 60_000);

    // funcsem.d:2465 `cast(TypeFunction)f.type` is a static cast: a base function whose signature failed has
    // `type == Type.terror`, covariant() answers `distinct`, and the override check reports the supplemental.
    test("an override of a function whose declaration has errors (fail_compilation/fail23745.d)", async () => {
        const f = join(dir, "ov.d");
        writeFileSync(f, "module ov;\nclass B : A\n{\n    override void fun() {}\n}\nclass A\n{\n"
            + "    void fun(UndefinedType);\n}\n");
        expect(await shim(["-c", "-o-", f])).toEqual({
            code: 1,
            stderr: `${f}(8): Error: undefined identifier \`UndefinedType\`\n    void fun(UndefinedType);\n`
                + `${" ".repeat(13)}^\n`
                + `${f}(4): Error: function \`fun\` does not override any function, did you mean to override `
                + `\`ov.A.fun\`?\n    override void fun() {}\n${" ".repeat(18)}^\n`
                + `${f}(8):        Function \`ov.A.fun\` contains errors in its declaration, therefore it cannot be `
                + `correctly overridden\n    void fun(UndefinedType);\n${" ".repeat(9)}^\n`,
        });
    }, 60_000);
});
