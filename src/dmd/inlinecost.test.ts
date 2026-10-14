// Co-located tests for src/dmd/inlinecost.ts (dmd/inlinecost.d).
//
// dmd/inlinecost.d carries NO `unittest` block, so these are 10 §1.6b behaviour pins of the cost model.
// Each builds its AST the sema way (lex -> parse -> runSemantic over a D source, ldc2 1.43.0 accepts every
// source here with `-c -o-`, exit 0) and pins the cost the D visitor computes on it. The expected numbers
// are derived by hand from the D visitor, one step per node, in the comment of each test; ldc2 does not
// print costs, so the derivation is the oracle. The IN_LLVM `CallExp` arm (inlinecost.d:495, `cost++`) is
// pinned directly: a call costs 1, whatever its callee.

import "./parse.js"; // module-graph ROOT for a core-SCC test file (10 §1.5)

import { beforeEach, describe, expect, test } from "vitest";

import {
    COST_MAX, inlineCostExpression, inlineCostFunction, isInlinableNestedAggregate, tooCostly,
} from "./inlinecost.js";
import { Parser } from "./parse.js";
import { ErrorSinkNull } from "./errorsink.js";
import { global } from "./globals.js";
import { moduleFromParse } from "./dmodule.js";
import { runSemantic } from "./dsymbolsem.js";
import { initSemaHarness, sourceMembers, userBody } from "../sema-harness.js";
import { dsToJs } from "../dstring.js";

import type { Module } from "./dmodule.js";
import type { Expression } from "./expression.js";
import type { FuncDeclaration } from "./func.js";

beforeEach(() => {
    initSemaHarness();
});

/** NUL-terminated byte buffer (the lexer scans to the NUL sentinel). */
function srcBuf(text: string): Uint8Array {
    const b = new Uint8Array(text.length + 1);
    for (let i = 0; i < text.length; i++) b[i] = text.charCodeAt(i) & 0xff;
    b[text.length] = 0;
    return b;
}

/** lex + parse + runSemantic over `text`, asserting the clean accept ldc2 gives. */
function sema(text: string): Module {
    const p = new Parser(null, null, srcBuf(text), false, new ErrorSinkNull(), null, false);
    p.nextToken();
    const m = moduleFromParse(p.parseModule(), p.md);
    runSemantic(m);
    expect(global.errors).toBe(0);
    return m;
}

function func(m: Module, name: string): FuncDeclaration {
    for (const s of sourceMembers(m)) {
        const fd = s.isFuncDeclaration();
        if (fd !== null && dsToJs(fd.ident!.toString()) === name)
            return fd;
    }
    throw new Error(`no function ${name}`);
}

/** The expression of `return <exp>;`, the lone statement of `fd`'s body. */
function returnExp(fd: FuncDeclaration): Expression {
    return userBody(fd).isReturnStatement()!.exp!;
}

describe("inlinecost.d:41-59 — COST_MAX and tooCostly", () => {
    test("COST_MAX is 250", () => {
        expect(COST_MAX).toBe(250);
    });

    test("only the expression bits below STATEMENT_COST (0x1000) are compared to COST_MAX", () => {
        expect(tooCostly(0)).toBe(false);
        expect(tooCostly(249)).toBe(false);
        expect(tooCostly(250)).toBe(true);
        expect(tooCostly(0x1000)).toBe(false);           // one loop, no expression cost
        expect(tooCostly(0x1000 + 249)).toBe(false);
        expect(tooCostly(3 * 0x1000 + 250)).toBe(true);
        expect(tooCostly(0x1000 - 1)).toBe(true);         // 4095 & 4095 = 4095 >= 250
    });
});

describe("inlinecost.d:69 — inlineCostExpression (callerCopy = true, hasThis = false)", () => {
    test("`a + 1`: VarExp 1 + IntegerExp 1 + AddExp 1 = 3", () => {
        const m = sema("int f(int a) { return a + 1; }");
        expect(inlineCostExpression(returnExp(func(m, "f")))).toBe(3);
    });

    test("`k()`: VarExp of a non-nested function 1 + the IN_LLVM CallExp arm 1 = 2", () => {
        const m = sema("int k() { return 1; } int f() { return k(); }");
        expect(inlineCostExpression(returnExp(func(m, "f")))).toBe(2);
    });

    test("a function literal call reaches visitFuncExp: the cost is pinned at COST_MAX and the walk stops", () => {
        // `(() => 2)()`: postorder visits the FuncExp first -> cost = COST_MAX, `stop` set (inlinecost.d:351).
        const m = sema("int f() { return (() => 2)(); }");
        expect(inlineCostExpression(returnExp(func(m, "f")))).toBe(COST_MAX);
    });

    test("`this` without hasThis costs COST_MAX (inlinecost.d:395)", () => {
        const m = sema("class C { int x; int f() { return this.x; } }");
        const cd = sourceMembers(m)[0]!.isClassDeclaration()!;
        let fd: FuncDeclaration | null = null;
        for (const s of cd.members!) {
            const f = s!.isFuncDeclaration();
            if (f !== null && dsToJs(f.ident!.toString()) === "f") fd = f;
        }
        // Postorder visits the ThisExp first: cost = COST_MAX, `stop` set (:351), the DotVarExp is never visited.
        expect(inlineCostExpression(returnExp(fd!))).toBe(COST_MAX);
    });
});

describe("inlinecost.d:85 — inlineCostFunction", () => {
    test("`{ return a + 1; }`: the merge wrapper and the body cost only their expression, 3", () => {
        // fbody = CompoundStatement([ReturnStatement]) (semantic3.d:1240): visitCompoundStatement copies
        // the visitor, the ReturnStatement adds expressionInlineCost(a + 1) = 3, nested == 0.
        const m = sema("int f(int a) { return a + 1; }");
        expect(inlineCostFunction(func(m, "f"), false)).toBe(3);
    });

    test("a `for` loop adds STATEMENT_COST, which tooCostly ignores", () => {
        const m = sema("void f() { for (;;) { break; } }");
        const cost = inlineCostFunction(func(m, "f"), false);
        // ForStatement STATEMENT_COST (:308) + the ScopeStatement body 1 (:245) + the lone `break` reaching
        // visit(Statement) COST_MAX (:181), inside the CompoundStatement copy (:189).
        expect(cost).toBe(0x1000 + 1 + COST_MAX);
        expect(tooCostly(cost)).toBe(true);   // the `break` in the body reaches visitStatement: += COST_MAX
    });

    test("`if (a) return 1; else return 2;` is the allowed both-arms-return shape", () => {
        // visitIfStatement (inlinecost.d:252): condition `a` 1, both arms end with return: 1 + 1 = 3.
        const m = sema("int f(int a) { if (a) return 1; else return 2; }");
        expect(inlineCostFunction(func(m, "f"), false)).toBe(3);
    });

    test("a `return` nested in a one-armed `if` costs COST_MAX", () => {
        // `if (a) { return 1; } a = 2; return a;` — the if is followed by a non-return statement, so the
        // compound shortcut (inlinecost.d:196) does not apply and the ReturnStatement is visited with
        // nested == 1 (inlinecost.d:289).
        const m = sema("int f(int a) { if (a) { return 1; } a = 2; return a; }");
        expect(tooCostly(inlineCostFunction(func(m, "f"), false))).toBe(true);
    });
});

describe("inlinecost.d:103 — isInlinableNestedAggregate", () => {
    test("a local static struct without a dtor is inlinable; a local class is not", () => {
        const m = sema("void f() { static struct S { int x; } } void g() { class C {} }");
        const declOf = (name: string) => {
            const body = userBody(func(m, name));
            const es = body.isExpStatement();
            return es!.exp!.isDeclarationExp()!;
        };
        expect(isInlinableNestedAggregate(declOf("f"))).not.toBeNull();
        expect(isInlinableNestedAggregate(declOf("g"))).toBeNull();
    });
});
