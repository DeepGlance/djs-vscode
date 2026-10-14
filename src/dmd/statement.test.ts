// Co-located test file for src/dmd/statement.ts (10 §1.1).
//
// dmd/statement.d carries ZERO in-source `unittest{}` blocks, so this file takes the §1.6b shape:
// ONE module-load smoke test plus a handful of behavior pins that are constructible with the
// EXISTING harness conventions (the §1.5 init snippet) — no new harness machinery, no fabricated
// pins for paths the harness cannot reach honestly.
//
// The pins deliberately target the two places where a plausible-but-wrong translation of this file
// would be silent:
//   - the `stmt`-tag downcast block (statement.d:275-326): the TAG decides, not the TS class
//     hierarchy — `DtorExpStatement` IS an `ExpStatement` subclass yet `isExpStatement()` is null;
//   - the Form-B constructor split (04 §1.1c): `null` satisfies the static type of BOTH D ctor
//     overloads, so a runtime `instanceof` discriminator routes every null argument to the wrong
//     branch. Both null call shapes exist in the real frontend and are pinned here: for
//     ExpStatement, parse.d:6142/:6169 select the Dsymbol overload while parse.d:6145/:6264 pass
//     `cast(AST.Expression)null` to the sibling; for CompoundStatement, parse.d:5518 passes
//     `cast(AST.Statement)null` to the variadic;
//   - the three `walkPostorder`-driven traversals (usesEH / comeFrom / hasCode), whose walls were
//     swept once `visitor/postorder.ts` landed — behaviour pins, plus this module's only exercise
//     of the value import edge into `visitor/postorder.ts` (01 §4.8).
//
// NO WALL PINS REMAIN in this file.

import { describe, test, expect, beforeEach } from "vitest";

import {
    Statement,
    ErrorStatement,
    PeelStatement,
    ExpStatement,
    DtorExpStatement,
    MixinStatement,
    CompoundStatement,
    CompoundDeclarationStatement,
    UnrolledLoopStatement,
    ScopeStatement,
    ForwardingStatement,
    WhileStatement,
    DoStatement,
    ForStatement,
    ForeachStatement,
    ForeachRangeStatement,
    IfStatement,
    ConditionalStatement,
    StaticForeachStatement,
    PragmaStatement,
    StaticAssertStatement,
    SwitchStatement,
    CaseStatement,
    CaseRangeStatement,
    DefaultStatement,
    GotoDefaultStatement,
    GotoCaseStatement,
    SwitchErrorStatement,
    ReturnStatement,
    BreakStatement,
    ContinueStatement,
    SynchronizedStatement,
    WithStatement,
    TryCatchStatement,
    Catch,
    TryFinallyStatement,
    ScopeGuardStatement,
    ThrowStatement,
    DebugStatement,
    GotoStatement,
    LabelStatement,
    LabelDsymbol,
    AsmStatement,
    InlineAsmStatement,
    GccAsmStatement,
    CompoundAsmStatement,
    ImportStatement,
} from "./statement.js";
import { STMT } from "./astenums.js";
import { STC } from "./astenums.js";
import { DYNCAST } from "./rootobject.js";
import { Loc } from "./location.js";
import { initTokens } from "./tokens.js";
import { DeclarationExp } from "./expression.js";
import { Array as DArray } from "./root/array.js";
import { global } from "./globals.js";
import type { Statements } from "./arraytypes.js";

beforeEach(() => {
    Loc._init();      // reset the location table
    initTokens();     // re-creates the interning table + keywords
});

describe("statement.d — module load", () => {
    test("every top-level class declaration is exported and constructible as a type", () => {
        // statement.d declares 47 classes + 1 nested struct + 1 mixin template + 1 CTFE helper.
        // The 47 classes are the file's whole runtime surface; the two compile-time declarations
        // emit nothing (audit comment at the bottom of statement.ts).
        const classes = [
            Statement, ErrorStatement, PeelStatement, ExpStatement, DtorExpStatement, MixinStatement,
            CompoundStatement, CompoundDeclarationStatement, UnrolledLoopStatement, ScopeStatement,
            ForwardingStatement, WhileStatement, DoStatement, ForStatement, ForeachStatement,
            ForeachRangeStatement, IfStatement, ConditionalStatement, StaticForeachStatement,
            PragmaStatement, StaticAssertStatement, SwitchStatement, CaseStatement, CaseRangeStatement,
            DefaultStatement, GotoDefaultStatement, GotoCaseStatement, SwitchErrorStatement,
            ReturnStatement, BreakStatement, ContinueStatement, SynchronizedStatement, WithStatement,
            TryCatchStatement, Catch, TryFinallyStatement, ScopeGuardStatement, ThrowStatement,
            DebugStatement, GotoStatement, LabelStatement, LabelDsymbol, AsmStatement,
            InlineAsmStatement, GccAsmStatement, CompoundAsmStatement, ImportStatement,
        ];
        expect(classes.length).toBe(47);
        for (const c of classes) expect(typeof c).toBe("function");
        expect(typeof Statement.arraySyntaxCopy).toBe("function");   // statement.d:66
    });
});

describe("statement.d — the STMT tag is the discriminant (statement.d:275-326)", () => {
    test("dyncast() is DYNCAST.statement for every node (statement.d:45)", () => {
        const s = new ExpStatement(Loc.initial, null);
        expect(s.dyncast()).toBe(DYNCAST.statement);
    });

    test("isXxx() reads the tag, NOT the TS class hierarchy", () => {
        const es = new ExpStatement(Loc.initial, null);
        expect(es.stmt).toBe(STMT.Exp);
        expect(es.isExpStatement()).toBe(es);
        expect(es.isCompoundStatement()).toBe(null);

        // DtorExpStatement EXTENDS ExpStatement but is tagged STMT.DtorExp (statement.d:427), so
        // `isExpStatement()` is null on it — the D `stmt == STMT.Exp` test, not an instanceof.
        const ds = new DtorExpStatement(Loc.initial, null, null);
        expect(ds.stmt).toBe(STMT.DtorExp);
        expect(ds.isDtorExpStatement()).toBe(ds);
        expect(ds.isExpStatement()).toBe(null);

        // Same shape one level down: CompoundDeclarationStatement extends CompoundStatement.
        const cds = new CompoundDeclarationStatement(Loc.initial, null);
        expect(cds.stmt).toBe(STMT.CompoundDeclaration);
        expect(cds.isCompoundStatement()).toBe(null);
        expect(cds.isCompoundDeclarationStatement()).toBe(cds);
    });
});

describe("statement.d — Form-B ctor split keeps the null overloads apart (04 §1.1c)", () => {
    test("ExpStatement.fromDsymbol(loc, null) still builds a DeclarationExp (parse.d:6142/:6169)", () => {
        // D's `this(Loc, Dsymbol)` (statement.d:396) wraps even a NULL declaration in a
        // DeclarationExp; the sibling `this(Loc, Expression)` stores null into `exp`. An
        // instanceof-discriminated collapse would send BOTH null calls to the Expression branch.
        const viaDsymbol = ExpStatement.fromDsymbol(Loc.initial, null);
        expect(viaDsymbol.exp).toBeInstanceOf(DeclarationExp);
        const de: DeclarationExp | null = viaDsymbol.exp instanceof DeclarationExp ? viaDsymbol.exp : null;
        expect(de).not.toBe(null);
        expect(de!.declaration).toBe(null);

        // The sibling `this(Loc, Expression)` with a null exp — parse.d:6145/:6264.
        const viaExpression = new ExpStatement(Loc.initial, null);
        expect(viaExpression.exp).toBe(null);
    });

    test("CompoundStatement: container ctor vs statement-list factory (parse.d:5518)", () => {
        // `new CompoundStatement(loc, null)` is D's `this(Loc, Statements*)` with a null container.
        const viaContainer = new CompoundStatement(Loc.initial, null);
        expect(viaContainer.statements).toBe(null);
        expect(viaContainer.stmt).toBe(STMT.Compound);

        // `CompoundStatement.fromStatementList(loc, null)` is D's variadic ctor fed the single
        // `cast(AST.Statement)null` of parse.d:5518 — a one-element array holding null, NOT a null
        // container. This is the distinction an instanceof discriminator loses.
        const viaList = CompoundStatement.fromStatementList(Loc.initial, null);
        expect(viaList.statements).not.toBe(null);
        expect(viaList.statements!.length).toBe(1);
        expect(viaList.statements!.opIndex(0)).toBe(null);

        // statement.d:516 `create(loc, s1, s2)` routes through the same variadic form.
        const s1 = new ExpStatement(Loc.initial, null);
        const s2 = new ExpStatement(Loc.initial, null);
        const created = CompoundStatement.create(Loc.initial, s1, s2);
        expect(created.statements!.length).toBe(2);
        expect(created.statements!.opIndex(0)).toBe(s1);
        expect(created.statements!.opIndex(1)).toBe(s2);
    });
});

describe("statement.d — container-field shape: value array vs pointer (09 §1.0)", () => {
    test("SwitchStatement.gotoCases is an EMPTY container, cases is null (statement.d:1134/:1135)", () => {
        // :1134 `GotoCaseStatements gotoCases;` has NO `*` — a by-value Array!T whose .init is an
        // empty container. Its neighbour :1135 `CaseStatements* cases;` HAS the `*` and inits null.
        // statementsem.d:2512 pushes into gotoCases with no allocation and no null test, so an
        // empty-non-null container is the only shape that survives the first `goto case`.
        const ss = new SwitchStatement(Loc.initial, null, null, null, false, Loc.initial);
        expect(ss.gotoCases).not.toBe(null);
        expect(ss.gotoCases.length).toBe(0);
        expect(ss.cases).toBe(null);

        // and it is usable straight away, exactly as statementsem.d:2512 assumes
        const gcs = new GotoCaseStatement(Loc.initial, null);
        ss.gotoCases.push(gcs);
        expect(ss.gotoCases.opIndex(0)).toBe(gcs);

        // two switches do not share the container
        const ss2 = new SwitchStatement(Loc.initial, null, null, null, false, Loc.initial);
        expect(ss2.gotoCases.length).toBe(0);
    });

    test("TryFinallyStatement.bodyFallsThru starts true from the CTOR (statement.d:1591)", () => {
        // The D field's .init is false (:1586 `bool bodyFallsThru;`); the ctor is what assumes true
        // until statementSemantic(). The observable post-construction value is therefore true.
        const body = new ExpStatement(Loc.initial, null);
        expect(new TryFinallyStatement(Loc.initial, body, body).bodyFallsThru).toBe(true);
    });
});

describe("statement.d — the query methods the traversals depend on", () => {
    test("hasBreak/hasContinue follow the per-node D answers", () => {
        const body = new ExpStatement(Loc.initial, null);
        expect(new ExpStatement(Loc.initial, null).hasBreak()).toBe(false);          // base, :91
        expect(new UnrolledLoopStatement(Loc.initial, null).hasBreak()).toBe(true);  // :615
        expect(new UnrolledLoopStatement(Loc.initial, null).hasContinue()).toBe(true);
        expect(new SwitchStatement(Loc.initial, null, null, body, false, Loc.initial).hasBreak()).toBe(true);
        // statement.d:1455/:1460 and :1606/:1611 — both return FALSE (the `//true;` is commented out).
        expect(new SynchronizedStatement(Loc.initial, null, body).hasBreak()).toBe(false);
        expect(new SynchronizedStatement(Loc.initial, null, body).hasContinue()).toBe(false);
        expect(new TryFinallyStatement(Loc.initial, body, body).hasBreak()).toBe(false);
        expect(new TryCatchStatement(Loc.initial, body, null).hasBreak()).toBe(false);
        // statement.d:657/:663 — ScopeStatement delegates to the wrapped statement (null -> false).
        expect(new ScopeStatement(Loc.initial, null, Loc.initial).hasBreak()).toBe(false);
        const wrapped = new ScopeStatement(Loc.initial,
            new UnrolledLoopStatement(Loc.initial, null), Loc.initial);
        expect(wrapped.hasBreak()).toBe(true);
    });

    test("endsWithReturnStatement / last walk a CompoundStatement (statement.d:526/:539)", () => {
        const es = new ExpStatement(Loc.initial, null);
        const rs = new ReturnStatement(Loc.initial, null);
        const statements: Statements = new DArray<Statement | null>();
        statements.push(es);
        statements.push(null);          // a Statements genuinely holds null slots (08 §3)
        statements.push(rs);
        const cs = new CompoundStatement(Loc.initial, statements);

        expect(cs.endsWithReturnStatement()).toBe(rs);      // ReturnStatement returns itself (:1364)
        expect(es.endsWithReturnStatement()).toBe(null);    // base returns null (:267)
        expect(cs.last()).toBe(rs);                         // walks from the end, skipping nulls
        expect(es.last()).toBe(es);                         // base returns `this` (:243)

        // An all-null compound has no last statement.
        const empties: Statements = new DArray<Statement | null>();
        empties.push(null);
        expect(new CompoundStatement(Loc.initial, empties).last()).toBe(null);
    });

    test("endsWithAsm: only a CompoundAsmStatement answers itself (IN_LLVM, statement.d:1943)", () => {
        const es = new ExpStatement(Loc.initial, null);
        expect(es.endsWithAsm()).toBe(null);                        // base (:272)

        const asmBlock = new CompoundAsmStatement(Loc.initial, null, STC.none);
        expect(asmBlock.endsWithAsm()).toBe(asmBlock);

        // statement.d:562 — a CompoundStatement lets its LAST inner statement decide.
        const statements: Statements = new DArray<Statement | null>();
        statements.push(es);
        statements.push(asmBlock);
        expect(new CompoundStatement(Loc.initial, statements).endsWithAsm()).toBe(asmBlock);

        const notAsm: Statements = new DArray<Statement | null>();
        notAsm.push(asmBlock);
        notAsm.push(es);
        expect(new CompoundStatement(Loc.initial, notAsm).endsWithAsm()).toBe(null);
    });

    test("getRelatedLabeled: ForStatement prefers its wrapper label (statement.d:835)", () => {
        const fs = new ForStatement(Loc.initial, null, null, null, null, Loc.initial);
        expect(fs.getRelatedLabeled()).toBe(fs);                    // relatedLabeled is null -> `this`
        const wrapper = new TryFinallyStatement(Loc.initial, fs, fs);
        fs.relatedLabeled = wrapper;
        expect(fs.getRelatedLabeled()).toBe(wrapper);
    });
});

describe("statement.d — syntaxCopy structure (statement.d:58/:66)", () => {
    test("the base syntaxCopy is D's assert(0) — an unreachable, not a wall", () => {
        // statement.d:58 `Statement syntaxCopy() { assert(0); }`. PeelStatement declares no
        // override, so it inherits the halt (10 §2, faithful `assert(0)`).
        const ps = new PeelStatement(new ExpStatement(Loc.initial, null));
        expect(() => ps.syntaxCopy()).toThrow("Assertion failure");
    });

    test("ErrorStatement.syntaxCopy returns itself — the one node that does NOT copy (statement.d:343)", () => {
        // statement.d:343 `override ErrorStatement syntaxCopy() { return this; }`. ErrorStatement's
        // ctor asserts `global.gaggedErrors || global.errors` (statement.d:340), which is a REAL
        // precondition, not a harness obstacle: `global.errors` is a plain mutable counter
        // (globals.ts:464), so the test establishes the state D requires and constructs the node
        // for real. Nothing in the translated body is relaxed for the test's benefit (10 §1.9).
        const savedErrors = global.errors;
        try {
            global.errors = 1;
            const es = new ErrorStatement();
            expect(es.stmt).toBe(STMT.Error);
            expect(es.syntaxCopy()).toBe(es);                       // returns ITSELF, never a copy
        } finally {
            global.errors = savedErrors;
        }
    });

    test("every other node deep-copies: ReturnStatement.syntaxCopy (statement.d:1359)", () => {
        // The contrast that makes the pin above meaningful — the ordinary override allocates.
        const rs = new ReturnStatement(Loc.initial, null);
        expect(rs.syntaxCopy()).not.toBe(rs);                       // a real deep copy (:1359)
        expect(rs.syntaxCopy().stmt).toBe(STMT.Return);
    });

    test("Statement.arraySyntaxCopy clones the container and preserves null slots", () => {
        const a: Statements = new DArray<Statement | null>();
        a.push(new ReturnStatement(Loc.initial, null));
        a.push(null);
        const b = Statement.arraySyntaxCopy(a);

        expect(b).not.toBe(a);                                      // fresh container (:71)
        expect(b!.length).toBe(2);
        expect(b!.opIndex(0)).not.toBe(a.opIndex(0));               // element deep-copied (:74)
        expect(b!.opIndex(0)!.stmt).toBe(STMT.Return);
        expect(b!.opIndex(1)).toBe(null);                           // null slot stays null
        expect(Statement.arraySyntaxCopy(null)).toBe(null);         // null container stays null
    });
});

describe("statement.d — the three walkPostorder traversals (statement.d:112/:151/:190)", () => {
    // These three methods were walled while `dmd.visitor.postorder` was unported; the walls are
    // swept and the traversals are live. The expected values come from the D visitor bodies, not
    // from re-evaluating the port's own expression (10 §1.8 rule 8): `UsesEH.visit(TryFinally)`
    // sets `stop = true` (statement.d:127), `ComeFrom.visit(DefaultStatement)` sets it
    // (statement.d:166), `HasCode.visit(Statement)` sets it (statement.d:196) while
    // `HasCode.visit(CompoundStatement)` and the `exp is null` arm of `visit(ExpStatement)` leave
    // it alone (statement.d:209/:201). They double as the module's postorder load-order check
    // (10 §1.5): a broken import edge into `visitor/postorder.ts` fails here, not silently.
    test("usesEH: a try/finally answers true, a bare ExpStatement false (statement.d:112)", () => {
        const es = new ExpStatement(Loc.initial, null);
        expect(es.usesEH()).toBe(false);
        expect(new TryFinallyStatement(Loc.initial, es, es).usesEH()).toBe(true);
    });

    test("comeFrom: a `default:` label answers true, a bare ExpStatement false (statement.d:151)", () => {
        const es = new ExpStatement(Loc.initial, null);
        expect(es.comeFrom()).toBe(false);
        expect(new DefaultStatement(Loc.initial, es).comeFrom()).toBe(true);
    });

    test("hasCode: a return has code, a compound of exp-less statements has none (statement.d:190)", () => {
        expect(new ReturnStatement(Loc.initial, null).hasCode()).toBe(true);

        const statements: Statements = new DArray<Statement | null>();
        statements.push(new ExpStatement(Loc.initial, null));
        statements.push(new ExpStatement(Loc.initial, null));
        expect(new CompoundStatement(Loc.initial, statements).hasCode()).toBe(false);
    });
});
