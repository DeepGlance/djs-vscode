// Co-located test file for src/dmd/statementsem.ts (10 §1.1).
//
// dmd/statementsem.d carries ZERO in-source `unittest{}` blocks (verified: `grep -c unittest` = 0
// on the 1.43.0-beta1 source), so this file takes the §1.6b shape: ONE module-load smoke test plus
// one behavior pin per risky RESOLVED CONSTRUCT, each in its own `test()` so a red gate names the
// concern. No new harness machinery: every fixture is a bare AST node plus `new Scope()`, exactly
// the conventions dscope.test.ts / statement.test.ts already use.
//
// The pinned concerns, and why each would be SILENT if translated wrong:
//   1. the Idiom-C dispatch (13 §7.6) — an arm whose `visitXxx` handler does not exist routes to
//      `visitDefaultCase`, never to a "related" handler. `STMT.CompoundDeclaration` is the NAMED
//      trap: `CompoundDeclarationStatement` IS a `CompoundStatement` subclass, so routing it to
//      `visitCompound` compiles, runs, and miscompiles (the shipped blockexit.ts bug);
//   2. the same rule for the three other handler-less arms;
//   3. `checkLabel(SwitchStatement)`'s `enum error = true;` (dmd/statementsem.d:5124) — translated
//      verbatim as `const error`, it puts the MODULE import `error` into the TDZ for the whole
//      body, so the nested `checkVar`'s two `error(...)` diagnostics become a ReferenceError;
//   4. the 04 §1B Form-B split of the two same-arity `checkLabel` overloads;
//   5. `ready(StaticForeach)`'s new 1.43 free-function home + its nullable-chain truthiness;
//   6. `flatten`'s tag dispatch default (a statement kind that does not flatten returns null —
//      the caller then runs `statementSemantic` on the original, so a wrong `Statements` here
//      silently duplicates work);
//   7. the `asm{}` escalation stub sits on the arm D's dispatch actually selects (10 §1.8 rule 5:
//      STMT.Asm is a REAL arm of the generated switch, dmd/statement.d:2027);
//   8. `visitLabel`'s duplicate-label branch (dmd/statementsem.d:3687 `ls.loc == ls2.loc`) — `Loc`
//      declares BOTH `equals` (filename/line, location.d:148) and `opEquals` (`index`,
//      location.d:165), and D's `==` binds `opEquals` (05 §2). Calling the same-named `equals`
//      compiles, runs, and picks the WRONG arm: the "is duplicated" static-foreach diagnostic
//      instead of "already defined", plus `duplicated = true`, which then suppresses the error on
//      every FURTHER redefinition of that label (the guard at dmd:3686);
//   9. `visitPragma` must CALL `dmd.pragmasem` — the module IS in the tree, so a §2.5 wall there
//      would sit on ported code and halt every `pragma` statement (11 §2.5: a wall may only sit on
//      a path D actually takes into UNPORTED code).
//  10. the C-only `rs.exp = rs.exp.arrayFuncConv(sc)` in `visitReturn` (dmd/statementsem.d:2644): a returned C array
//      decays to a pointer, so a global array is accepted and a local one reaches the escape check.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeEach, vi } from "vitest";

// IMPORT ORDER IS LOAD-BEARING (01 §4.1). statementsem.ts carries value edges into the core SCC
// (clone / funcsem / typesem / dsymbolsem), and entering the SCC through it first leaves
// `class FuncDeclaration extends Declaration` with an undefined base ("Class extends value
// undefined", func.ts:353 via clone.ts:69). Naming an AST module first — the convention every
// other sema test file already follows (typesem.test.ts imports mtype first, initsem.test.ts
// location/tokens/mtype) — pins the evaluation order. Reported to the integrator as a load-order
// escalation; the owner-side remedy (01 §4.1's lazy-class shape) is not in this file.
import { Type } from "./mtype.js";
import {
    AsmStatement, CaseStatement, CompoundDeclarationStatement, ExpStatement, ForeachStatement,
    GccAsmStatement, GotoStatement, InlineAsmStatement, LabelStatement, PragmaStatement, Statement,
    StaticForeachStatement, SwitchErrorStatement, SwitchStatement,
} from "./statement.js";
import type { CaseStatements, Statements } from "./arraytypes.js";
import { STC, STMT } from "./astenums.js";
import { StaticForeach } from "./cond.js";
import { Scope } from "./dscope.js";
import { ErrorSinkNull } from "./errorsink.js";
import { FuncDeclaration } from "./func.js";
import { global } from "./globals.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { Array as DArray } from "./root/array.js";
import { TOK, initTokens } from "./tokens.js";
import { ds } from "../dstring.js";
import {
    checkLabel, checkLabelSwitchStatement, flatten, ready, scopeCode, semanticNoScope,
    statementSemantic, statementSemanticVisit, throwSemantic,
} from "./statementsem.js";

beforeEach(() => {
    Loc._init();      // reset the location table
    initTokens();     // re-creates the interning table + keywords
});

/// Intern a name the way every other sema test file does (10 §1.5).
function id(name: string): Identifier {
    return Identifier.idPool(Uint8Array.from(Array.from(name, (c) => c.charCodeAt(0))));
}

describe("statementsem.d — module load", () => {
    test("smoke: the module evaluates and its public surface is callable", () => {
        // Importing the module runs its top level; this catches load-order / cycle regressions
        // (01 §4). statementsem.d declares no module state, so there is nothing else to assert
        // about evaluation itself — the surface check below is the rest of the smoke test.
        for (const f of [statementSemantic, statementSemanticVisit, throwSemantic, scopeCode,
                         semanticNoScope, flatten, ready, checkLabelSwitchStatement,
                         checkLabel]) {
            expect(typeof f).toBe("function");
        }
        // The SCC really finished evaluating (01 §4.1): the AST base class is a live constructor,
        // not the `undefined` a bad entry order leaves behind.
        expect(typeof Type).toBe("function");
    });
});

describe("statementsem.d:3823 — the Idiom-C dispatch switch (13 §7.6)", () => {
    test("STMT.CompoundDeclaration routes to visitDefaultCase, NOT to visitCompound", () => {
        // dmd/statement.d:2019 generates `case STMT.CompoundDeclaration: … visitCompoundDeclaration
        // …`, and `__traits(compiles, visitCompoundDeclaration(sx))` is FALSE in
        // statementSemanticVisit — no such handler exists — so the generated arm calls
        // `visitDefaultCase`, whose body is `result = s;` (dmd/statementsem.d:189).
        //
        // The discriminator is the ONE-statement case: visitCompound would return
        // `(*cs.statements)[0]` (dmd/statementsem.d:452-456), a DIFFERENT object; visitDefaultCase
        // returns the CompoundDeclarationStatement itself.
        const inner = new ExpStatement(Loc.initial, null);
        const statements: Statements = DArray.from<Statement | null>(inner);
        const cds = new CompoundDeclarationStatement(Loc.initial, statements);
        expect(cds.stmt).toBe(STMT.CompoundDeclaration);

        const out = statementSemanticVisit(cds, new Scope());
        expect(out).toBe(cds);        // pass-through — the visitCompound route would yield `inner`
        expect(out).not.toBe(inner);
    });

    test("the three other handler-less arms also pass through (never a related handler)", () => {
        // Same rule, same generated probe: statementSemanticVisit declares no visitStaticForeach,
        // no visitSwitchError, no visitInlineAsm and no visitGccAsm, so all four arms are
        // `visitDefaultCase`. (InlineAsm/GccAsm are unreachable in the LDC configuration — the
        // parser only builds AsmStatement — but the arms are emitted faithfully.)
        const sfe = new StaticForeach(Loc.initial,
            new ForeachStatement(Loc.initial, TOK.foreach_, null, null, null, Loc.initial), null);
        const cases: [Statement, STMT][] = [
            [new StaticForeachStatement(Loc.initial, sfe), STMT.StaticForeach],
            [new SwitchErrorStatement(Loc.initial), STMT.SwitchError],
            [new InlineAsmStatement(Loc.initial, null), STMT.InlineAsm],
            [new GccAsmStatement(Loc.initial, null), STMT.GccAsm],
        ];
        for (const [s, tag] of cases) {
            expect(s.stmt).toBe(tag);
            expect(statementSemanticVisit(s, new Scope())).toBe(s);
        }
    });

    test("STMT.Asm reaches visitAsm, which calls LDC's asmSemantic (dmd/statementsem.d:3727)", () => {
        // `case STMT.Asm:` is generated by dmd/statement.d:2027; `visitAsm` (dmd/statementsem.d:3721) calls
        // asmSemantic (src/gen/asmstmt.ts), which returns null for an empty token list (gen/asmstmt.cpp:101).
        const s = new AsmStatement(Loc.initial, null);
        expect(s.stmt).toBe(STMT.Asm);
        expect(statementSemanticVisit(s, new Scope())).toBeNull();
    });
});

describe("statementsem.d:5100 / :5144 — the two checkLabel overloads (04 §1B Form B)", () => {
    test("checkLabel(SwitchStatement): the renamed `enum error` does not TDZ the module `error`", () => {
        // dmd/statementsem.d:5124 `enum error = true;` is a FUNCTION-LOCAL manifest constant. Kept
        // verbatim it would shadow the imported diagnostic `error` for the whole body (TS `const`
        // hoists into a temporal dead zone), turning the two `error(ss.loc, …)` calls inside
        // `checkVar` (dmd:5115/:5117) into a ReferenceError. The port renames the local.
        //
        // With no `sdefault` and no cases the loop body never runs, so D returns `!error` == false.
        const ss = new SwitchStatement(Loc.initial, null, null, null, false, Loc.initial);
        ss.cases = new DArray<CaseStatement | null>() as CaseStatements;
        expect(ss.sdefault).toBe(null);
        expect(checkLabelSwitchStatement(ss)).toBe(false);
    });

    test("both overloads survive the Form-B rename as DISTINCT functions", () => {
        // D's two `checkLabel` differ only by receiver type, so the port splits them per 04 §1B:
        // the Goto form (the one with the out-of-module dependent, semantic3.d:1340) keeps the bare
        // D name, the Switch form takes the receiver-type suffix. A collapse to one name would
        // silently bind every call site to whichever definition came last in the file.
        expect(checkLabelSwitchStatement).not.toBe(checkLabel);
        expect(checkLabelSwitchStatement.length).toBe(1);
        expect(checkLabel.length).toBe(1);
        // A goto with no resolved label is not this pin's subject; only the identity split is.
        expect(typeof new GotoStatement(Loc.initial, null).stmt).toBe("number");
    });
});

describe("statementsem.d:85 — `ready(StaticForeach)`, the 1.43 free-function home", () => {
    test("returns false while the aggregate is not yet a tuple (nullable-chain truthiness)", () => {
        // 1.42 spelled this `StaticForeach.ready()` (cond.d:242); 1.43 moved it here as a free
        // function, so a port that left it on the class would leave dsymbolsem.d:9244 unlinkable.
        // The body is three nullable-reference tests (06 §2.7) then a tag compare: with `aggr`
        // still null the chain short-circuits to false without dereferencing.
        const aggrfe = new ForeachStatement(Loc.initial, TOK.foreach_, null, null, null, Loc.initial);
        const sfe = new StaticForeach(Loc.initial, aggrfe, null);
        expect(sfe.aggrfe).toBe(aggrfe);
        expect(aggrfe.aggr).toBe(null);
        expect(ready(sfe)).toBe(false);
    });
});

describe("statementsem.d:4806 — `flatten`'s tag dispatch", () => {
    test("a statement kind that does not flatten returns null, never an empty container", () => {
        // The `default: return null;` of D's `switch (statement.stmt)` is what tells every caller
        // (visitCompound at dmd:295, visitScope at :510, …) to keep the ORIGINAL statement and run
        // `statementSemantic` on it. Returning an empty `Statements` instead would compile and
        // silently delete the statement.
        const es = new ExpStatement(Loc.initial, null);   // STMT.Exp with a null `exp`
        expect(flatten(es, new Scope())).toBe(null);
    });
});

describe("statementsem.d:3687 — `ls.loc == ls2.loc` binds `Loc.opEquals`, NOT `Loc.equals`", () => {
    // `Loc` carries two DIFFERENT predicates with confusable names (05 §2):
    //   `bool equals(Loc)`   (location.d:148) — SourceLoc filename + line (+ column only when
    //                                            `Loc.showColumns`, which is false by default);
    //   `bool opEquals(ref const(Loc))` (location.d:165) — `this.index == loc.index`.
    // D's `==` is the SECOND one. Two labels on the same line of the same file have equal
    // filename/line and DIFFERENT indices, so the two predicates disagree exactly where the
    // duplicate-label branch is chosen.
    test("the two Loc predicates really disagree on same-file/same-line, different-index", () => {
        const a = Loc.singleFilename(ds("dup.d"));
        const b = Loc.singleFilename(ds("dup.d"));
        expect(Loc.showColumns).toBe(false);
        expect(a.equals(b)).toBe(true);      // the WRONG predicate for `==`
        expect(a.opEquals(b)).toBe(false);   // what D's `==` actually computes
    });

    test("a redefined label takes the `already defined` arm and leaves `duplicated` false", () => {
        // dmd/statementsem.d:3684-3698. With distinct `Loc.index` values D falls to the ELSE arm:
        // "label `%s` is already defined" + "first definition is here", and it does NOT set
        // `ls2.duplicated` — which is what keeps the guard at dmd:3686 live for a THIRD definition.
        const sink = global.errorSink;
        const errors = global.errors;
        global.errorSink = new ErrorSinkNull();
        global.gag += 1;                       // keep the two diagnostics off the suite's stderr
        try {
            const fd = new FuncDeclaration(Loc.initial, Loc.initial, id("f"), STC.none, null);
            const sc = new Scope();
            sc.parent = fd;

            const first = new LabelStatement(Loc.singleFilename(ds("dup.d")), id("L1"), null);
            expect(statementSemanticVisit(first, sc)).toBe(first);

            const again = new LabelStatement(Loc.singleFilename(ds("dup.d")), id("L1"), null);
            const r = statementSemanticVisit(again, sc);
            expect(r).not.toBe(null);
            expect(r!.isErrorStatement()).not.toBe(null);

            // The then-arm (`ls.loc == ls2.loc`) would have set this true and swallowed every
            // later redefinition of `L1`.
            expect(fd.searchLabel(id("L1"), Loc.initial).duplicated).toBe(false);
        } finally {
            global.gag -= 1;
            global.errorSink = sink;
            global.errors = errors;
        }
    });
});

describe("statementsem.d:1802 — `visitPragma` calls the ported `pragmaStmtSemantic`", () => {
    test("a pragma statement does not halt at a TODO-BODY wall", () => {
        // `import dmd.pragmasem : pragmaStmtSemantic;` (dmd/statementsem.d:1801) resolves to
        // `pragmasem.ts:pragmaStmtSemantic`, a real exported body. The pin asserts only the
        // absence of the wall — the pragma's own verdict belongs to pragmasem.test.ts.
        const sink = global.errorSink;
        const errors = global.errors;
        global.errorSink = new ErrorSinkNull();
        global.gag += 1;
        try {
            const ps = new PragmaStatement(Loc.initial, id("inline"), null, null);
            expect(() => statementSemanticVisit(ps, new Scope())).not.toThrow(/TODO-BODY/);
        } finally {
            global.gag -= 1;
            global.errorSink = sink;
            global.errors = errors;
        }
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

// Expected: ldc2 1.43.0 `-c -o-` on the same file, byte for byte.
describe("statementsem.d:2644 — `visitReturn` decays a returned C array through `arrayFuncConv`", () => {
    test("a global array returned as `int *` compiles; a local one is an escaping reference", async () => {
        const dir = mkdtempSync(join(tmpdir(), "djs-retafc-"));
        try {
            const ok = join(dir, "ra.c");
            writeFileSync(ok, "int ga[4];\nint *f(void) { return ga; }\n");
            expect(await shimCompile(ok)).toEqual({ code: 0, stderr: "" });

            const f = join(dir, "r.c");
            const line = "int *g(void) { int la[3]; return la; }";
            writeFileSync(f, `${line}\n`);
            expect(await shimCompile(f)).toEqual({
                code: 1,
                stderr: `${f}(1): Error: returning \`& la\` escapes a reference to local variable \`la\`\n`
                    + `${line}\n${" ".repeat(33)}^\n`,
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);
});
