// Co-located tests for src/dmd/pragmasem.ts (dmd/pragmasem.d).
//
// `dmd/pragmasem.d` contains ZERO in-source `unittest{}` blocks (verified: `grep -c unittest` -> 0),
// so per 10-tests-diagnostics.md §1.6b this file is the thin test file: one module-load smoke
// test plus behavior pins — roughly one per risky RESOLVED construct, and one per wall/escalation
// that sits on a path D actually takes (§1.8). No new harness machinery; every pin is built with
// the §1.5 canonical init snippet and the constructors the tree already exercises.
//
// Concerns pinned here (each its own `test()` so a red gate names the right one):
//   - `evalPragmaInline`'s two early returns and the `%llu` bigint-domain diagnostic (09 §1/§5)
//   - `setPragmaPrintf`'s FuncDeclaration leg (both directions)
//   - the `version (all)` resolution in `pragmaStmtSemantic`'s `pragma(lib)` arm (07 §1/_config §3)
//   - the declaration-in-condition hoist for `pragma(inline)` outside a function (06 §2.6)
//   - the `LDC_profile_instr` arm's rejection of a non-bool argument (gen.dpragma, DtoCheckProfileInstrPragma)
//   - the argument-count rejections of `pragmaStartAddressSemantic` / `pragmaMangleSemantic`
//   - the swept callee sites (include / expressionsToString / semanticString / newScope) and the
//     remaining walls, pinned on their real arms (§1.8); the chain past DtoGetPragma (d:196)

import { beforeEach, describe, expect, test } from "vitest";
import {
    evalPragmaInline,
    pragmaDeclSemantic,
    pragmaMangleSemantic,
    pragmaMsgSemantic,
    pragmaStartAddressSemantic,
    pragmaStmtSemantic,
    setPragmaPrintf,
} from "./pragmasem.js";
import { PragmaDeclaration } from "./attrib.js";
import { PINLINE, STC } from "./astenums.js";
import { Scope } from "./dscope.js";
import { ErrorSinkNull } from "./errorsink.js";
import { ErrorExp, type Expression } from "./expression.js";
import { FuncDeclaration } from "./func.js";
import { global } from "./globals.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { PragmaStatement } from "./statement.js";
import { initTokens } from "./tokens.js";
import { EXP } from "./tokens.js";
import { Array as DArray } from "./root/array.js";
import type { Expressions } from "./arraytypes.js";
import type { Dsymbol } from "./dsymbol.js";
import { Type_init } from "./typesem.js";

beforeEach(() => {
    // The 10 §1.5 canonical init snippet, in the 01 §5.2 ORDER contract.
    Loc._init();
    initTokens(); // FIRST of the module ctors: re-creates the interning table + keywords
    Id.initialize(); // predefined identifiers (AFTER initTokens, never before)
    Type_init(); // `ErrorExp`'s ctor reads `Type.terror`
    // `error(...)` reads global.errorSink and bumps global.errors (templateparamsem.test.ts).
    global.errorSink = new ErrorSinkNull();
    global.errors = 0;
    global.gag = 0;
});

function id(name: string): Identifier {
    return Identifier.idPool(Uint8Array.from(Array.from(name, (c) => c.charCodeAt(0))));
}

function exprs(...es: Expression[]): Expressions {
    // Constructed AS the `Expressions` alias — element type `Expression | null` (08 §3).
    const a = new DArray<Expression | null>();
    for (const e of es) a.push(e);
    return a;
}

/**
 * `ErrorExp.get()` emits "unknown, please file report at …" whenever `global.errors` is still 0
 * (expression.d:672) — a real D emission, but noise for a test that only wants an argument node.
 * Gag that one line and restore the counter the tests assert on.
 */
function errExp(): Expression {
    const errors = global.errors;
    const gaggedErrors = global.gaggedErrors;
    global.gag += 1;
    try {
        return ErrorExp.get();
    } finally {
        global.gag -= 1;
        global.errors = errors;
        global.gaggedErrors = gaggedErrors;
    }
}

function fn(name: string): FuncDeclaration {
    return new FuncDeclaration(Loc.initial, Loc.initial, id(name), STC.none, null);
}

describe("module load smoke (§1.6b)", () => {
    test("importing dmd/pragmasem.ts executes its top level and exports all seven D functions", () => {
        // A load-order/cycle regression in this sema module surfaces here as a
        // "cannot access before initialization" at import time.
        expect(typeof pragmaDeclSemantic).toBe("function");
        expect(typeof pragmaStmtSemantic).toBe("function");
        expect(typeof evalPragmaInline).toBe("function");
        expect(typeof pragmaMsgSemantic).toBe("function");
        expect(typeof setPragmaPrintf).toBe("function");
        expect(typeof pragmaStartAddressSemantic).toBe("function");
        expect(typeof pragmaMangleSemantic).toBe("function");
    });
});

describe("evalPragmaInline (dmd/pragmasem.d:428)", () => {
    test("no arguments -> PINLINE.default_ (d:430-431), for both null and empty", () => {
        expect(evalPragmaInline(Loc.initial, new Scope(), null)).toBe(PINLINE.default_);
        expect(evalPragmaInline(Loc.initial, new Scope(), exprs())).toBe(PINLINE.default_);
        expect(global.errors).toBe(0);
    });

    test("more than one argument -> diagnostic, args truncated to one ErrorExp, default_ (d:433-438)", () => {
        // D: `.error(loc, "one boolean expression expected …, not %llu", cast(ulong) args.length);`
        // then `args.setDim(1); (*args)[0] = ErrorExp.get();`. `ErrorExp` carries `Type.terror`, so
        // the `if (!e.type)` block at d:441 is skipped and no wall is on this path; `toBool` of an
        // `EXP.error` falls to its `default:` arm -> empty Optional -> `PINLINE.default_` (d:455).
        const args = exprs(errExp(), errExp(), errExp());
        global.gag = 1; // gag the byte-exact stderr print; the emission still bumps global.errors
        try {
            expect(evalPragmaInline(Loc.initial, new Scope(), args)).toBe(PINLINE.default_);
        } finally {
            global.gag = 0;
        }
        expect(global.errors).toBe(1);
        expect(args.length).toBe(1);
        expect(args.opIndex(0)!.op).toBe(EXP.error);
    });
});

describe("setPragmaPrintf (dmd/pragmasem.d:498)", () => {
    test("printf=true sets FuncDeclaration.printf and CLEARS scanf (d:500-504)", () => {
        const f = fn("myprintf");
        f.scanf = true; // prove the `fd.scanf = !printf;` write actually clears it
        setPragmaPrintf(f, true);
        expect(f.printf).toBe(true);
        expect(f.scanf).toBe(false);
    });

    test("printf=false sets scanf and clears printf (d:500-504)", () => {
        const f = fn("myscanf");
        f.printf = true;
        setPragmaPrintf(f, false);
        expect(f.printf).toBe(false);
        expect(f.scanf).toBe(true);
    });
});

describe("pragmaMsgSemantic (dmd/pragmasem.d:472)", () => {
    test("null args -> true with no output (d:477-478)", () => {
        expect(pragmaMsgSemantic(Loc.initial, new Scope(), null)).toBe(true);
        expect(global.errors).toBe(0);
    });
});

describe("pragmaStartAddressSemantic (dmd/pragmasem.d:522)", () => {
    test("null args -> `function name expected for start address`, false (d:526-530)", () => {
        global.gag = 1;
        try {
            expect(pragmaStartAddressSemantic(Loc.initial, new Scope(), null)).toBe(false);
        } finally {
            global.gag = 0;
        }
        expect(global.errors).toBe(1);
    });

    test("two arguments -> same rejection (`args.length != 1`, d:526)", () => {
        const args = exprs(errExp(), errExp());
        global.gag = 1;
        try {
            expect(pragmaStartAddressSemantic(Loc.initial, new Scope(), args)).toBe(false);
        } finally {
            global.gag = 0;
        }
        expect(global.errors).toBe(1);
    });
});

describe("pragmaMangleSemantic (dmd/pragmasem.d:573)", () => {
    test("null args -> `expects string literal argument`, false (d:752-756)", () => {
        global.gag = 1;
        try {
            expect(pragmaMangleSemantic(Loc.initial, new Scope(), null, null)).toBe(false);
        } finally {
            global.gag = 0;
        }
        expect(global.errors).toBe(1);
    });

    test("three arguments -> `expects 1 or 2 arguments`, false (d:757-761)", () => {
        const args = exprs(errExp(), errExp(), errExp());
        global.gag = 1;
        try {
            expect(pragmaMangleSemantic(Loc.initial, new Scope(), args, null)).toBe(false);
        } finally {
            global.gag = 0;
        }
        expect(global.errors).toBe(1);
    });

    test("one argument but no declarations -> `must be attached to a declaration`, false (d:768-772)", () => {
        // `applyPragmaMangle(null, …)` returns true immediately (d:604-605), so `count` stays 0 and
        // `ignored` stays false — the two-condition rejection at d:768. No wall on this path.
        const args = exprs(errExp());
        global.gag = 1;
        try {
            expect(pragmaMangleSemantic(Loc.initial, new Scope(), args, null)).toBe(false);
        } finally {
            global.gag = 0;
        }
        expect(global.errors).toBe(1);
    });
});

describe("pragmaStmtSemantic (dmd/pragmasem.d:293)", () => {
    test("`pragma(lib)` as a statement is rejected — the version(all) arm (d:310-316)", () => {
        // resolved: `version (all)` -> always ON, so the `else` arm (d:317-335) never compiles and
        // the statement form is unconditionally an error. This pin is what would go red if the
        // resolution were ever flipped to the dead `else`.
        const ps = new PragmaStatement(Loc.initial, Id.lib, null, null);
        global.gag = 1;
        try {
            expect(pragmaStmtSemantic(ps, new Scope())).toBe(false);
        } finally {
            global.gag = 0;
        }
        expect(global.errors).toBe(1);
    });

    test("`pragma(linkerDirective)` as a statement is rejected (d:369-375)", () => {
        const ps = new PragmaStatement(Loc.initial, Id.linkerDirective, null, null);
        global.gag = 1;
        try {
            expect(pragmaStmtSemantic(ps, new Scope())).toBe(false);
        } finally {
            global.gag = 0;
        }
        expect(global.errors).toBe(1);
    });

    test("`pragma(inline)` outside a function -> `is not inside a function`, false (d:381-391)", () => {
        // `if (auto fd = sc.func)` hoisted to a const + `!== null` test (06 §2.6/§2.7); a bare
        // `new Scope()` has `func === null`, so D takes the `else` arm.
        const ps = new PragmaStatement(Loc.initial, Id.Pinline, null, null);
        global.gag = 1;
        try {
            expect(pragmaStmtSemantic(ps, new Scope())).toBe(false);
        } finally {
            global.gag = 0;
        }
        expect(global.errors).toBe(1);
    });

    test("`pragma(LDC_profile_instr)` with no args is rejected by `!ps.args`, the first operand (d:353)", () => {
        // `DtoCheckProfileInstrPragma` is the THIRD operand of D's `||`, so D never evaluates it here.
        const ps = new PragmaStatement(Loc.initial, Id.LDC_profile_instr, null, null);
        global.gag = 1;
        try {
            expect(pragmaStmtSemantic(ps, new Scope())).toBe(false);
        } finally {
            global.gag = 0;
        }
        expect(global.errors).toBe(1);
    });

    test("an unrecognized pragma statement is accepted when ignoreUnsupportedPragmas (d:401-405)", () => {
        // `global.params.ignoreUnsupportedPragmas` defaults to true (globals.ts:270), so the final
        // `else if` is not taken; with a null `_body` the function falls through to `return true`.
        const ps = new PragmaStatement(Loc.initial, id("totally_unknown_pragma"), null, null);
        expect(pragmaStmtSemantic(ps, new Scope())).toBe(true);
        expect(global.errors).toBe(0);
    });
});

describe("pragmaDeclSemantic (dmd/pragmasem.d:41)", () => {
    test("`pragma(inline)` with no declarations returns without touching anything (d:182-187)", () => {
        // The `Id.Pinline` arm is `return declarations();`, and `declarations()` returns at once
        // when `pd.decl` is null (d:61-62) — so this whole path is wall-free.
        const pd = new PragmaDeclaration(Loc.initial, Id.Pinline, null, null);
        expect(() => pragmaDeclSemantic(pd, new Scope())).not.toThrow();
        expect(global.errors).toBe(0);
    });
});

describe("deferred-callee walls, and the chain past DtoGetPragma — pinned on the arms D takes", () => {
    test("setPragmaPrintf on an AttribDeclaration recurses through `include` (d:506-509)", () => {
        // D's second `if` at d:506 matches any AttribDeclaration; `PragmaDeclaration` is one
        // (dsymbol.ts isAttribDeclaration lists DSYM.pragmaDeclaration), and its `include(null)` is
        // its `decl` list, so the nested function is marked (ldc2: `pragma(printf) { extern(C) int
        // p(const(char)* f, ...); }` compiles clean).
        const inner = fn("p");
        const decl = new DArray<Dsymbol | null>();
        decl.push(inner);
        const ad = new PragmaDeclaration(Loc.initial, Id.printf, null, decl);
        setPragmaPrintf(ad, true);
        expect(inner.printf).toBe(true);
        expect(inner.scanf).toBe(false);
    });

    test("pragmaMsgSemantic with an error argument returns false (expressionsem.d:1190-1192)", () => {
        // expressionsToString (d:481) is live, and so is ctfeInterpretForPragmaMsg (dinterpret.d:135:
        // an `EXP.error` comes back unchanged). expressionsem.d:1191 then takes `return error()`, whose
        // supplemental is skipped for `Loc.initial`, so d:482 returns false and nothing is printed.
        // ldc2 on `pragma(msg, nope);` prints the argument's own error plus the supplemental
        // "while evaluating `pragma(msg, nope)`" at a real loc; a pre-built ErrorExp carries no
        // error of its own, and `Loc.initial` suppresses the supplemental.
        const args = exprs(errExp());
        expect(pragmaMsgSemantic(Loc.initial, new Scope(), args)).toBe(false);
        expect(global.errors).toBe(0);
    });

    test("pragmaDeclSemantic on a one-arg `pragma(lib)` with an error argument stops quietly (d:153-158)", () => {
        // semanticString returns null for an `EXP.error` argument without a diagnostic of its own,
        // so the arm returns through noDeclarations(): ldc2 on `pragma(lib, <undefined>)` prints only
        // the argument's own error, and a pre-built ErrorExp carries none.
        const args = exprs(errExp());
        const arg0 = args.opIndex(0);
        const pd = new PragmaDeclaration(Loc.initial, Id.lib, args, null);
        expect(() => pragmaDeclSemantic(pd, new Scope())).not.toThrow();
        expect(global.errors).toBe(0);
        expect(args.opIndex(0)).toBe(arg0); // d:159 `(*pd.args)[0] = se` not reached
    });

    test("pragmaDeclSemantic on `pragma(mangle)` with no arguments -> one diagnostic (d:190-193)", () => {
        // newScope(Dsymbol, Scope*) (d:190) is live; pragmaMangleSemantic then rejects the null args
        // (d:752-756). ldc2 on `pragma(mangle);`: "`pragma(mangle)` expects string literal argument
        // for mangled name", one error.
        const pd = new PragmaDeclaration(Loc.initial, Id.mangle, null, null);
        global.gag = 1;
        try {
            expect(() => pragmaDeclSemantic(pd, new Scope())).not.toThrow();
        } finally {
            global.gag = 0;
        }
        expect(global.errors).toBe(1);
    });

    test("an unrecognized pragma passes DtoGetPragma (LLVMnone) and reaches the chain's tail (d:196-252)", () => {
        // DtoGetPragma (gen/pragma.cpp:341) answers LLVMnone for an ident outside its set, so the chain goes on
        // to the unrecognized-pragma arm. ignoreUnsupportedPragmas defaults to true (globals.d:210), so ldc2
        // accepts `pragma(some_unknown_pragma);` silently; with it off the diagnostic is dmd's own.
        const pd = new PragmaDeclaration(Loc.initial, id("some_unknown_pragma"), null, null);
        expect(() => pragmaDeclSemantic(pd, new Scope())).not.toThrow();
        expect(global.errors).toBe(0);
        const saved = global.params.ignoreUnsupportedPragmas;
        global.params.ignoreUnsupportedPragmas = false;
        global.gag = 1;
        try {
            pragmaDeclSemantic(pd, new Scope());
        } finally {
            global.gag = 0;
            global.params.ignoreUnsupportedPragmas = saved;
        }
        expect(global.errors).toBe(1);
    });

    test("`pragma(LDC_profile_instr, e)` with a non-bool argument is rejected (d:351-356)", () => {
        // DtoCheckProfileInstrPragma (gen/pragma.cpp:610) is parseBoolExp: an ErrorExp is no bool constant,
        // so it returns false and the arm reports "pragma(LDC_profile_instr, true or false) expected".
        const ps = new PragmaStatement(Loc.initial, Id.LDC_profile_instr, exprs(errExp()), null);
        global.gag = 1;
        try {
            expect(pragmaStmtSemantic(ps, new Scope())).toBe(false);
        } finally {
            global.gag = 0;
        }
        expect(global.errors).toBe(1);
    });
});
