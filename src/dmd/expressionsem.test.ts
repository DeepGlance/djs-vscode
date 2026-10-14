// Co-located tests for src/dmd/expressionsem.ts (ported from dmd/expressionsem.d).
//
// dmd/expressionsem.d carries ZERO in-source `unittest{}` blocks, so this file is the thin test
// file of 10-tests-diagnostics.md §1.6b: ONE module-load smoke test plus one behavior pin per
// risky RESOLVED CONSTRUCT, one `test()` per CONCERN so a red gate names the right pin. It does not
// duplicate the rung-era behavioral floor (expressionsem.rung1.test.ts, sema.expr.test.ts,
// sema.var.test.ts), which stays the real regression oracle for the semantic pass itself.
//
// The pinned CONCERNS, each a construct this translation had to resolve rather than transcribe:
//   1. module load — the file sits deep in the 76-module core SCC and its import block is the
//      stitcher's own (01 §4); importing it must evaluate top-level cleanly.
//   2. the EXPORT SURFACE other ported modules import from here, including the two §1h
//      WAVE-BOUNDARY CARRY-OVERs (04 §6) that dcast.ts consumes.
//   3. `toBool`'s Idiom-B trailing dispatch switch (13 §7.5) — the arms are emitted in full, so a
//      filled arm must route to its own nested helper and the default must fall to the base.
//   4. `isLvalue`'s 18-arm Idiom-B dispatch (13 §7.5), including the four stacked AssignExp tags.
//   5. `toInteger` stays in the `bigint` domain end-to-end (09 §1.3.1).
//   6. `equals`' Idiom-B dispatch on the identity fast path.
//   7. the scalar `CmpExp` path (11 §2.5, 10 §1.8). Born as a wall pin on
//      `checkNonAssignmentArrayOp`, MOVED (rule 2) to `Target.isVectorOpSupported`
//      (dmd/target.d:816) when arrayop.ts landed, and now CONVERTED (rule 7) to a behaviour pin:
//      target.ts has landed that callee and the path runs end to end — see the describe block.
//   8. PAIRED STATE vs WALLS (11 §2.5): the gagged regions and the `inuse` counters are drained in
//      `finally`, because a wall adds an exit path D does not have. A leak here is invisible in the
//      failing test and poisons every LATER test in the same process, so it gets its own pin.
//   9. the module-private surface: D `private` free functions stay OUT of the export surface.
//  10. the -checkaction=context assert lowering (expressionsem.d:9701): `cast(EqualExp) exp.e1` is a static cast
//      over every BinExp the op list admits, so the operands are read through isBinExp(), driven through djsMain.
//  11. the ImportC calls (importc.d:83 `arrayFuncConv`, :167 `carraySemantic`) at the D sites run on D code too
//      and are the identity there: a D static array keeps its type and its D diagnostics, driven through djsMain.

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Parser } from "./parse.js";
import { moduleFromParse } from "./dmodule.js";
import { scopeCreateGlobal } from "./dsymbolsem.js";
import { DsymbolTable } from "./dsymbol.js";
import type { Dsymbol } from "./dsymbol.js";
import { Loc } from "./location.js";
import { Type } from "./mtype.js";
import { TY } from "./astenums.js";
import { global } from "./globals.js";
import { ErrorSinkNull } from "./errorsink.js";
import { Id } from "./id.js";
import { initTokens } from "./tokens.js";
import { Scope } from "./dscope.js";
import {
    AddrExp, ArrayLiteralExp, CmpExp, CommaExp, IndexExp, IntegerExp, NullExp, RealExp, StringExp, ThisExp,
    TypeExp, VarExp,
} from "./expression.js";
import { VarDeclaration } from "./declaration.js";
import { Identifier } from "./identifier.js";
import { EXP } from "./tokens.js";
import { Array as DArray } from "./root/array.js";
import { ds, dsToJs } from "../dstring.js";
import { setDiagnosticHandler } from "./errors.js";
import { dmdformat } from "./root/dmdformat.js";

import * as expressionsem from "./expressionsem.js";
import {
    addDtorHook, calledFunctionType, checkDisabled, doCopyOrMove, dotIdSemanticProp,
    equals, expressionSemantic, hasValidType, isLvalue, resolveProperties,
    symbolToExp, toBool, toBoolean, toInteger, toUInteger, trySemantic, trySemanticAliasThis, valueNoDtor,
} from "./expressionsem.js";

import type { Expressions } from "./arraytypes.js";
import type { Expression } from "./expression.js";
import { Type_init } from "./typesem.js";
import { CTFloat } from "./root/ctfloat.js";

const loc = Loc.initial;

beforeEach(() => {
    Loc._init();
    initTokens();
    Id.initialize();
    Type_init();
    global.errorSink = new ErrorSinkNull();
    global.errors = 0;
});

describe("expressionsem module shape", () => {
    // CONCERN 1 — load order. expressionsem.ts is inside the 76-module core SCC and carries three
    // top-level `extends Visitor` value reads (01 §4.1/§4.7). A cycle regression shows up here as a
    // throw at import time (`Class extends value undefined` / `Cannot access X before
    // initialization`), before any test body runs.
    it("module-load smoke: the module evaluates its top level and publishes ExpressionSemanticVisitor", () => {
        expect(typeof expressionsem).toBe("object");
        expect(typeof expressionsem.ExpressionSemanticVisitor).toBe("function");
        // The visitor extends `Visitor` at TOP LEVEL — the sanctioned load-order-root edge.
        expect(Object.getPrototypeOf(expressionsem.ExpressionSemanticVisitor)).not.toBe(Function.prototype);
    });

    // CONCERN 2 — the export surface every other ported module imports from here. Losing one of
    // these breaks a file this wave may not edit (14 §2 single writer), so it is pinned by name.
    it("export surface: every symbol the tree imports from ./expressionsem.js is present", () => {
        const surface: Record<string, unknown> = {
            addDtorHook, calledFunctionType, checkDisabled, doCopyOrMove,
            dotIdSemanticProp, expressionSemantic, hasValidType, isLvalue,
            resolveProperties, symbolToExp, toBool, toBoolean, toInteger, valueNoDtor,
        };
        for (const [name, fn] of Object.entries(surface))
            expect(typeof fn, name).toBe("function");
    });
});

describe("toBool — Idiom-B dispatch (dmd/expressionsem.d:499, switch at :526)", () => {
    // CONCERN 3. The trailing dispatch switch IS the visitor dispatch (13 §7.5 rule 1): a filled arm
    // must reach its own nested helper, and the `default` must reproduce D's fall-to-base — which
    // here returns an EMPTY Optional ("not statically known"), not `false`.
    it("EXP.int64 routes to integerToBool: 0 is false, non-zero is true", () => {
        expect(toBool(new IntegerExp(loc, 0n, Type.tint32)).get()).toBe(false);
        expect(toBool(new IntegerExp(loc, 7n, Type.tint32)).get()).toBe(true);
    });

    it("EXP.null_ routes to the null arm: `null` is statically false", () => {
        expect(toBool(new NullExp(loc, Type.tnull)).get()).toBe(false);
    });

    it("EXP.arrayLiteral routes to arrayLiteralToBool: emptiness decides", () => {
        const empty: Expressions = new DArray<Expression | null>();
        expect(toBool(new ArrayLiteralExp(loc, Type.tvoid, empty)).get()).toBe(false);
        const one: Expressions = DArray.from<Expression | null>(new IntegerExp(loc, 1n, Type.tint32));
        expect(toBool(new ArrayLiteralExp(loc, Type.tvoid, one)).get()).toBe(true);
    });

    it("EXP.float64 routes to its own arm (`!!value`), NOT to the default", () => {
        // dmd:530 `case EXP.float64: return typeof(return)(!!_this.isRealExp().value);` — a real
        // arm, so a RealExp must come back PRESENT. If the arm were dropped it would silently
        // collapse onto the default, which is exactly the 13 §7.5 rule-1 failure mode.
        const r = toBool(new RealExp(loc, 1.5, Type.tfloat64));
        expect(r.isPresent()).toBe(true);
        expect(r.get()).toBe(true);
        expect(toBool(new RealExp(loc, 0.0, Type.tfloat64)).get()).toBe(false);
    });

    it("EXP.address routes to addrToBool over isCtfeReferenceValid (ctfeexpr.d:1869)", () => {
        // dmd:519 — `&this` is a valid CTFE reference, so statically true; `&x[0]` on a plain
        // variable aggregate is not (the `EXP.index` arm wants a literal aggregate), so the result
        // is EMPTY, not false.
        expect(toBool(new AddrExp(loc, new ThisExp(loc))).get()).toBe(true);
        const x = new VarDeclaration(loc, Type.tint32, Identifier.idPool(ds("x")), null);
        const idx = new IndexExp(loc, new VarExp(loc, x), new IntegerExp(loc, 0n, Type.tint32));
        expect(toBool(new AddrExp(loc, idx)).isPresent()).toBe(false);
    });

    it("an unhandled node takes the `default` arm — an EMPTY Optional, never a fabricated false", () => {
        // A TypeExp has no arm in D's switch (dmd:526-559), so it takes `default:`, whose body is
        // `return typeof(return)();` — "no static opinion". Collapsing that to `false` would be a
        // silent miscompile, which is what emitting the switch IN FULL protects against.
        const r = toBool(new TypeExp(loc, Type.tint32));
        expect(r.isPresent()).toBe(false);
        expect(() => r.get()).toThrow();
    });
});

describe("isLvalue — Idiom-B dispatch (dmd/expressionsem.d:681, switch at :761)", () => {
    // CONCERN 4.
    it("a literal is not an lvalue (the switch's `default: return false`)", () => {
        expect(isLvalue(new IntegerExp(loc, 1n, Type.tint32))).toBe(false);
    });

    it("EXP.string_ is an lvalue only when its type is a static array", () => {
        const se = new StringExp(loc, [...ds("ab")]);
        se.type = Type.tvoid;                       // not Tsarray -> rvalue
        expect(isLvalue(se)).toBe(false);
    });

    it("EXP.comma delegates to e2 (the arm calls isLvalue on the right operand, not the left)", () => {
        const rhs = new IntegerExp(loc, 2n, Type.tint32);
        const ce = new CommaExp(loc, new IntegerExp(loc, 1n, Type.tint32), rhs);
        expect(ce.op).toBe(EXP.comma);
        expect(isLvalue(ce)).toBe(false);           // e2 is a literal -> not an lvalue
    });
});

describe("toInteger — the bigint domain (09 §1.3.1)", () => {
    // CONCERN 5. `dinteger_t` is 64-bit: the value must never transit a JS `number`, or every
    // downstream sentinel comparison dies silently.
    it("returns a bigint and preserves a value beyond 2^53", () => {
        const big = 9007199254740993n;              // 2^53 + 1, not representable as a JS number
        const e = new IntegerExp(loc, big, Type.tint64);
        const v = toInteger(e);
        expect(typeof v).toBe("bigint");
        expect(v).toBe(big);
    });

    // The RealExp arms are `cast(sinteger_t)` / `cast(uinteger_t)` of a real_t (dmd/expressionsem.d:201,
    // :227). ldc2 on arm64 lowers them to fcvtzs/fcvtzu, which SATURATE and map NaN to 0. Every value
    // below is ldc2-1.43.0 `-vcg-ast` output for the matching `cast(long)` / `cast(ulong)` of a literal
    // (constfold.d:1013/:1016 execute the same instruction), never the port's own arithmetic.
    it("a RealExp converts with the target's saturating float -> 64-bit cast", () => {
        const r = (v: number): RealExp => new RealExp(loc, v, Type.tfloat64);
        const signed: [number, bigint][] = [
            [NaN, 0n], [1.0e19, 9223372036854775807n], [Infinity, 9223372036854775807n],
            [9223372036854775808, 9223372036854775807n], [-1.0e19, -9223372036854775808n],
            [-Infinity, -9223372036854775808n], [-9223372036854775808, -9223372036854775808n], [-2.9, -2n],
        ];
        for (const [v, want] of signed)
            expect(toInteger(r(v)), String(v)).toBe(want);
        const unsigned: [number, bigint][] = [
            [NaN, 0n], [-1.0, 0n], [-1.0e30, 0n], [-0.5, 0n], [-Infinity, 0n],
            [1.0e20, 18446744073709551615n], [Infinity, 18446744073709551615n],
            [18446744073709551616, 18446744073709551615n], [18446744073709549568, 18446744073709549568n],
            [9.5e18, 9500000000000000000n],
        ];
        for (const [v, want] of unsigned)
            expect(toUInteger(r(v)), String(v)).toBe(want);
    });
});

describe("equals — Idiom-B dispatch (dmd/expressionsem.d:919, switch at :1049)", () => {
    // CONCERN 6. D's `equals` opens with the identity fast path before the switch; the port keeps
    // both, so identity must short-circuit even for a node kind with no arm.
    it("identity short-circuits ahead of the dispatch switch", () => {
        const e = new IntegerExp(loc, 3n, Type.tint32);
        expect(equals(e, e)).toBe(true);
    });

    it("two IntegerExps with different values are not equal", () => {
        expect(equals(new IntegerExp(loc, 3n, Type.tint32), new IntegerExp(loc, 4n, Type.tint32))).toBe(false);
    });
});

describe("hasValidType — Idiom-B dispatch (dmd/expressionsem.d:573, switch at :637)", () => {
    it("a typed literal has a valid type; the `default` arm reads `type !is null`", () => {
        expect(hasValidType(new IntegerExp(loc, 1n, Type.tint32))).toBe(true);
    });

    // RE-PIN (10 §1.8 rule 7), wave 11: this was a pin on expression.ts's wall over
    // `hdrgen.toChars(Expression)` (dmd/expression.d:216), reached through the real arm dmd:639
    // `case EXP.type: return visitTypeExp(e.isTypeExp());`. That call is live now (hdrgen.d:204),
    // so the arm completes: visitTypeExp reports at dmd/expressionsem.d:577 and returns false.
    // ldc2 1.43, `typeof(int) x;` (typesem.d:5838 calls hasValidType on the TypeExp):
    //   te3.d(1): Error: type `int` is not an expression
    it("EXP.type routes to visitTypeExp: reports `type int is not an expression`, returns false", () => {
        const te = new TypeExp(loc, Type.tint32);
        expect(te.op).toBe(EXP.type);
        const messages: string[] = [];
        setDiagnosticHandler((_loc, _color, _header, messageFormat, args) => {
            messages.push(dsToJs(dmdformat(messageFormat, [...args])));
            return true;
        });
        try {
            expect(hasValidType(te)).toBe(false);
        } finally {
            setDiagnosticHandler(null);
        }
        expect(messages).toEqual(["type `int` is not an expression"]);
        expect(global.errors).toBe(1);
    });
});

describe("scalar CmpExp runs end to end — Target.isVectorOpSupported (dmd/target.d:816)", () => {
    // CONCERN 7 (10 §1.8). CONVERTED, rule 7 — THE SITE WENT LIVE. History: born as a wall pin on
    // `checkNonAssignmentArrayOp` (dmd/expressionsem.d:14657/:14658, the D lines the first pin
    // cited as `:14639`); MOVED by rule 2 to `Target.isVectorOpSupported` when arrayop.ts landed;
    // target.ts has now landed that callee, so there is no next wall to move to and rule 7 applies.
    // The intervening arms (array/pointer at dmd/expressionsem.d:14668, class/class at :14699,
    // complex at :14704, function types at :14709, Taarray at :14714) are all false for `int`,
    // leaving `else if (!target.isVectorOpSupported(t1, exp.op, t2))` at :14719 — and for a
    // non-vector `t1` the callee returns `true` on its first statement (target.d:820-822), so the
    // `!` branch is not taken and `visit(CmpExp)` takes the `else` at :14724 and reaches
    // `result = exp` (:14743). The type was already set to `Type.tbool` BEFORE the predicate, at
    // :14662; what the predicate decides is whether the visit reaches `result = exp` at all, since
    // a `false` answer replaces it with `exp.incompatibleTypes()` -> `ErrorExp.get()`
    // (expressionsem.ts `incompatibleTypesFromBinExp`), which flips both `r.op` and `r.type`.
    // The expected value is ldc2's, not the port's own expression (10 §1.8 rule 8):
    // `pragma(msg, typeof(1 < 2));` prints `bool` on ldc2-1.43.0 / arm64-apple-darwin.
    it("a scalar CmpExp types as bool, with no diagnostic", () => {
        const sc = Scope.alloc();
        const before = global.errors;
        const e = new CmpExp(EXP.lessThan, loc,
            new IntegerExp(loc, 1n, Type.tint32), new IntegerExp(loc, 2n, Type.tint32));
        const r = expressionSemantic(e, sc);
        expect(r.op).toBe(EXP.lessThan);
        expect(r.type!.ty).toBe(TY.Tbool);
        expect(global.errors).toBe(before);
    });
});

describe("paired state survives a throw (11 §2.5)", () => {
    // CONCERN 8. `global.gag` is a PROCESS-GLOBAL counter (globals.ts `startGagging`/`endGagging`).
    // D needs no guard around its gagged regions because nothing on those paths throws; the port's
    // walls DO throw, so every `startGagging`/`endGagging` region in expressionsem.ts drains the
    // counter in `finally`. If it leaked, `global.gag` would stay >0 for the rest of the process and
    // silently swallow every later diagnostic — a failure that shows up far from its cause.
    //
    // The property is "a throw inside the gagged region leaves `global.gag` restored", not any one wall. Walls
    // keep going live, so the throw is INJECTED: `CTFloat.sprint` is made to throw for the test, and the carrier
    // `__traits(isSame, x => 1.5 + x, y => 1.5 + y)` reaches it deep inside the gagged semantic: visit(TraitsExp)
    // (dmd/expressionsem.d:8904) -> isSameFuncLiteral (traits.d:2311) -> SerializeVisitor writes the RealExp
    // through `toChars` (lambdacomp.d:363) -> hdrgen's float formatting -> CTFloat.sprint.
    /** `__traits(isSame, x => 1.5 + x, y => 1.5 + y)` — the carrier whose semantic reaches CTFloat.sprint. */
    const walledExp = (): [Expression, Scope] => {
        const bytes = new TextEncoder().encode("__traits(isSame, x => 1.5 + x, y => 1.5 + y)");
        const buf = new Uint8Array(bytes.length + 1); // NUL-terminated: the lexer scans to the NUL
        buf.set(bytes, 0);
        const p = new Parser(null, null, buf, false, new ErrorSinkNull(), null, false);
        p.nextToken();
        const e = p.parseExpression();
        // A lambda argument reads `sc.parent`, so the scope is a module's global scope, not a bare one.
        const m = moduleFromParse(new DArray<Dsymbol | null>(), p.md);
        m.symtab = new DsymbolTable(); // the lambda's `__lambda` name is inserted into the module's table
        return [e, scopeCreateGlobal(m, global.errorSink!)];
    };

    /** Runs `f` with `CTFloat.sprint` throwing a marked error, restoring it after. */
    const withSprintThrowing = (f: () => void): void => {
        const spy = vi.spyOn(CTFloat, "sprint").mockImplementation(() => {
            throw new Error("injected throw at CTFloat.sprint");
        });
        try {
            f();
        } finally {
            spy.mockRestore();
        }
    };

    it("trySemantic restores global.gag when a throw escapes the gagged semantic", () => {
        const [e, sc] = walledExp();
        const before = global.gag;
        withSprintThrowing(() => expect(() => trySemantic(e, sc)).toThrow("injected throw at CTFloat.sprint"));
        expect(global.gag).toBe(before);
    });

    it("trySemanticAliasThis restores global.gag when a throw escapes the gagged semantic", () => {
        const [e, sc] = walledExp();
        const before = global.gag;
        withSprintThrowing(() =>
            expect(() => trySemanticAliasThis(e, sc, [null, null])).toThrow("injected throw at CTFloat.sprint"));
        expect(global.gag).toBe(before);
    });
});

describe("module-private surface (01 §2, 04 §0.1)", () => {
    // CONCERN 9. These six are D `private` at module scope (dmd/expressionsem.d:15662, :15702,
    // :15713, :18635, :19034, :19061). TS module scope needs no `export` for sibling callers, so
    // exporting them would widen D's contract for no reason and let a later wave import across a
    // boundary D forbids. Pinned by name because the mistake compiles silently.
    it("D module-private free functions are not on the module's export surface", () => {
        for (const name of ["expressionSemanticDone", "expressionSemanticWithParent",
                            "dotIdSemanticPropX", "modifyFieldVar", "expandInitializer",
                            "needsTypeInference"])
            expect(name in expressionsem, name).toBe(false);
    });
});

describe("resolved compile-time constructs", () => {
    // The 58 `static if (LOGSEMANTIC)` blocks resolve OFF (manifest `enum LOGSEMANTIC = false`,
    // dmd:101 — 02 §4.1 / 07 §3), and `IN_LLVM` is ON with the `else` legs dropped (_config §1/§2).
    // Neither token may survive into the emitted TS (07 §11); this pin is the greppable statement of
    // that, checked against the module namespace rather than the source text.
    it("LOGSEMANTIC is a manifest constant and is NOT exported as a runtime binding", () => {
        expect("LOGSEMANTIC" in expressionsem).toBe(false);
        expect("IN_LLVM" in expressionsem).toBe(false);
    });

    // `Modifiable` / `ModifyFlags` (dmd:18540 / :18553) are real D enums with a ≤32-bit base, so
    // they become TS `enum`s (02 §4.2) and are consumed from chunks 2 and 4 — declaration order
    // matters only if a top-level read existed, and there is none (01 §4.5).
    it("Modifiable / ModifyFlags are emitted as real enums with their D member sets", () => {
        expect(expressionsem.Modifiable.no).toBe(0);
        expect(expressionsem.Modifiable.yes).toBe(1);
        expect(expressionsem.Modifiable.initialization).toBe(2);
        expect(expressionsem.ModifyFlags.none).toBe(0);
    });
});

describe("__PRETTY_FUNCTION__ (expressionsem.d:17187)", () => {
    // expressionsem.d:17187 takes `s.toDString()` of an `extractChars()` buffer: the bytes before the NUL.
    // The literal carried the NUL, one code unit too long. ldc2 1.43.0 gives `void p.foo(int x)`, 17 units
    // (`pragma(msg, __PRETTY_FUNCTION__)`); the StringExp payload readers are walled, so the pin reads `len`.
    it("is the signature text without the NUL (ldc2: 17 code units)", async () => {
        const { Parser } = await import("./parse.js");
        const { ErrorSinkCompiler } = await import("./errors.js");
        const { moduleFromParse } = await import("./dmodule.js");
        const { runSemantic } = await import("./dsymbolsem.js");
        const { initSemaHarness } = await import("../sema-harness.js");
        initSemaHarness();
        global.errorSink = new ErrorSinkCompiler();
        const text = "module p;\nvoid foo(int x) { enum s = __PRETTY_FUNCTION__; }\n";
        const src = new Uint8Array(text.length + 1); // NUL-terminated: the lexer scans to the sentinel
        for (let i = 0; i < text.length; i++) src[i] = text.charCodeAt(i);
        const p = new Parser(null, null, src, false, global.errorSink, null, false);
        p.nextToken();
        const m = moduleFromParse(p.parseModule(), p.md);
        runSemantic(m);
        const fd = m.members!.opSlice().map((d) => d!.isFuncDeclaration()).find((f) => f !== null)!;
        const es = fd.fbody!.isCompoundStatement()!.statements!.opIndex(0)!.isExpStatement()!;
        const vd = es.exp!.isDeclarationExp()!.declaration!.isVarDeclaration()!;
        const se = vd._init!.isExpInitializer()!.exp!.isStringExp()!;
        expect(se.len).toBe(17);
    });
});

describe("hex string with a `w`/`d` postfix (expressionsem.d:5912-5938)", () => {
    // D's `e.peekData()` at expressionsem.d:5938 slices `len * sz` with the widened `sz` over the lexer's
    // `len`-byte payload; setData keeps only the in-bounds `len / sz` elements. The port asserted on the
    // overread (runnable/literal.d). ldc2 1.43.0: q.d compiles with no output, exit 0; p.d prints the two
    // errors below (`ldmd2 -c -o- -verrors=simple`).
    async function compile(text: string): Promise<string[]> {
        const { ErrorSinkCompiler } = await import("./errors.js");
        const { runSemantic } = await import("./dsymbolsem.js");
        const { initSemaHarness } = await import("../sema-harness.js");
        initSemaHarness();
        global.errorSink = new ErrorSinkCompiler();
        const diags: string[] = [];
        setDiagnosticHandler((_loc, _color, header, messageFormat, args) => {
            diags.push(dsToJs(header) + dsToJs(dmdformat(messageFormat, [...args])));
            return true;
        });
        try {
            const src = new Uint8Array(text.length + 1); // NUL-terminated: the lexer scans to the sentinel
            for (let i = 0; i < text.length; i++) src[i] = text.charCodeAt(i);
            const p = new Parser(null, null, src, false, global.errorSink, null, false);
            p.nextToken();
            runSemantic(moduleFromParse(p.parseModule(), p.md));
        } finally {
            setDiagnosticHandler(null);
        }
        return diags;
    }

    it("repacks the bytes big-endian into code units (ldc2: q.d)", async () => {
        const diags = await compile("module q;\n" +
            "static immutable uint[] x = cast(immutable uint[]) x\"FFAADDEE\"d;\n" +
            "static assert(x.length == 1 && x[0] == 0xFFAADDEE);\n" +
            "enum immutable(wchar)[] w = x\"AA BB CC DD\"w;\n" +
            "static assert(w.length == 2 && w[0] == 0xAABB && w[1] == 0xCCDD);\n");
        expect(diags).toEqual([]);
    });

    it("reports a length that is not a multiple of the width (ldc2: p.d)", async () => {
        const diags = await compile("module p;\nenum immutable(wchar)[] w = x\"AABBCC\"w;\n" +
            "enum immutable(dchar)[] d = x\"AABBCCDDEE\"d;\n");
        expect(diags).toEqual([
            "Error: hex string with `wstring` type needs to be multiple of 2 bytes, not 3",
            "Error: hex string with `dstring` type needs to be multiple of 4 bytes, not 5",
        ]);
    });
});

describe("checkModify in a contract (expressionsem.d:18602-18614)", () => {
    // `Declaration.isParameter()`/`isResult()` return bool; the port compared them with `null`, which is always
    // true, so every local declared in (or visible from) a contract scope of its own function was reported as a
    // parameter, and a result as a parameter too (fail_compilation/fail329, fail330, fail9413). The expected lines
    // are ldc2 1.43.0 `-c -o-` on this text, message plus line number.
    it("reports only parameters and results, with D's wording", async () => {
        const { ErrorSinkCompiler } = await import("./errors.js");
        const { runSemantic } = await import("./dsymbolsem.js");
        const { initSemaHarness } = await import("../sema-harness.js");
        const { CHECKENABLE } = await import("./astenums.js");
        initSemaHarness();
        global.errorSink = new ErrorSinkCompiler();
        // The driver resolves `_default` to `on` without -release (main.d:1297); the harness leaves `_default`,
        // under which semantic3.d:578 sets no `returnLabel` while :1117 keeps the out contract.
        const { useIn, useOut } = global.params;
        global.params.useIn = CHECKENABLE.on;
        global.params.useOut = CHECKENABLE.on;
        const diags: string[] = [];
        setDiagnosticHandler((loc, _color, header, messageFormat, args) => {
            diags.push(`(${loc.linnum}): ` + dsToJs(header) + dsToJs(dmdformat(messageFormat, [...args])));
            return true;
        });
        try {
            const text = "module c;\n" +
                "int foo(int x)\n" +
                "in { int f; f = 1; }\n" +
                "out (r) { r = 2; }\n" +
                "do { int y; y = x; return y; }\n" +
                "void bar(int x) in { x = 3; } do {}\n" +
                "class B { void baz(int a) in { int f; f = 1; a = 2; } do {} }\n";
            const src = new Uint8Array(text.length + 1); // NUL-terminated: the lexer scans to the sentinel
            for (let i = 0; i < text.length; i++) src[i] = text.charCodeAt(i);
            const p = new Parser(null, null, src, false, global.errorSink, null, false);
            p.nextToken();
            runSemantic(moduleFromParse(p.parseModule(), p.md));
        } finally {
            setDiagnosticHandler(null);
            global.params.useIn = useIn;
            global.params.useOut = useOut;
        }
        expect(diags).toEqual([
            "(4): Error: variable `c.foo.r` cannot modify result `r` in contract",
            "(6): Error: variable `c.bar.x` cannot modify parameter `x` in contract",
            "(7): Error: variable `c.B.baz.__require.a` cannot modify parameter `a` in contract",
        ]);
    });
});

/**
 * `-checkaction=context` lowers `assert(a <op> b)` to druntime's `_d_assert_fail!"<op>"(a, b)`, so the pin runs
 * one ldc2-shaped compile through the shim (src/djs.ts `djsMain`, druntime from the shim's ldc2.conf import
 * directory) in a fresh module registry, as escape.test.ts does. ORACLE: ldc2 1.43.0 `-checkaction=context -c -o-`
 * compiles the module below silently.
 */
describe("assert lowering under -checkaction=context (expressionsem.d:9701)", () => {
    const dir = mkdtempSync(join(tmpdir(), "djs-assert-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    // `auto binExp = cast(EqualExp) exp.e1;` is a static cast over every BinExp the op list admits; the operands
    // of `<`, `>=`, `is`, `!is` and `in` are read through the BinExp base (isEqualExp() is null for them).
    it("every comparison operator in the lowering list reaches _d_assert_fail", async () => {
        const f = join(dir, "a2.d");
        writeFileSync(f, "module a2;\nvoid f(int[int] aa, int* p, int x, int y)\n{\n    assert(x < y);\n"
            + "    assert(x >= y);\n    assert(p is null);\n    assert(p !is null);\n    assert(1 in aa);\n}\n");
        vi.resetModules();
        const { djsMain } = await import("../djs.js");
        const err: string[] = [];
        const e = vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array): boolean => {
            err.push(typeof c === "string" ? c : new TextDecoder().decode(c));
            return true;
        });
        let code: number;
        try {
            code = djsMain(["-checkaction=context", "-c", "-o-", f]);
        } finally {
            e.mockRestore();
        }
        expect({ code, stderr: err.join("") }).toEqual({ code: 0, stderr: "" });
    }, 60_000);
});

/**
 * The ImportC calls at the D sites (importc.d:83 `arrayFuncConv`, :167 `carraySemantic`) run on D code too: each is
 * the identity (or null) outside a C file, so a D static array keeps its type and the D diagnostics for an array
 * used as a pointer or a boolean stand. One module reaches the calls at expressionsem.d:4073 (argument), :10490
 * (`*a`), :11387 (ArrayExp), :11497 (comma), :11652 (index), :12217 (assignment), :13667 (`<`), :13766 (`==`),
 * :15295/:15300 (`?:`) and :18376 (`if (a)`). ORACLE: ldc2 1.43.0 `ldmd2 -c -o- -verrors=simple` on this text
 * prints exactly the lines below and exits 1.
 */
describe("ImportC array/function decay is the identity on D code (importc.d:83)", () => {
    const dir = mkdtempSync(join(tmpdir(), "djs-decay-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("a D static array keeps its type through every converted site", async () => {
        const f = join(dir, "d1.d");
        writeFileSync(f, "module d1;\n"
            + "struct S { int opIndex(int i) { return i; } }\n"
            + "void g(int[3] x) {}\n"
            + "void f(bool c, int i)\n"
            + "{\n"
            + "    int[3] a, b;\n"
            + "    g(a);\n"
            + "    a = b;\n"
            + "    auto e = c ? a : b;\n"
            + "    pragma(msg, typeof(e));\n"
            + "    pragma(msg, typeof((a, b)));\n"
            + "    bool q = a == b;\n"
            + "    bool r = a < b;\n"
            + "    auto v = a[i];\n"
            + "    S s;\n"
            + "    auto w = s[1];\n"
            + "    if (a) {}\n"
            + "    auto x = *a;\n"
            + "}\n");
        vi.resetModules();
        const { djsMain } = await import("../djs.js");
        const err: string[] = [];
        const e = vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array): boolean => {
            err.push(typeof c === "string" ? c : new TextDecoder().decode(c));
            return true;
        });
        let code: number;
        try {
            code = djsMain(["-verrors=simple", "-c", "-o-", f]);
        } finally {
            e.mockRestore();
        }
        expect({ code, stderr: err.join("") }).toEqual({
            code: 1,
            stderr: "int[3]\n"
                + `${f}(11): Error: using the result of a comma expression is not allowed\n`
                + "int[3]\n"
                + `${f}(17): Error: expression \`a\` of type \`int[3]\` does not have a boolean value\n`
                + `${f}(18): Error: using \`*\` on an array is no longer supported; use \`*(a).ptr\` instead\n`,
        });
    }, 60_000);
});
