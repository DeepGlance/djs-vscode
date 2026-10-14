import "./parse.js"; // module-graph ROOT — first import of any core-SCC test file (10 §1.5)
import { describe, test, expect, vi } from "vitest";

import {
    argExpTypesToCBuffer,
    arrayObjectsToBuffer,
    EXPtoString,
    parameterToChars,
    parametersTypeToChars,
} from "./hdrgen.js";
import { EXP } from "./tokens.js";
import { VarArg } from "./astenums.js";
import { Parameter, ParameterList, TypeFunction } from "./mtype.js";
import { Identifier } from "./identifier.js";
import { Array as Array_ } from "./root/array.js";
import type { Expression } from "./expression.js";
import type { RootObject } from "./rootobject.js";
import type { Objects } from "./arraytypes.js";
import { cstr, ds, dsToJs } from "../dstring.js";
import type { DString } from "../dstring.js";

// dmd/hdrgen.d has NO in-source `unittest {}` blocks (verified: the only `unittest` tokens in the
// file are `buf.put("unittest")` at hdrgen.d:1982 and a doc comment at :4172). Per
// 10-tests-diagnostics.md §1 there is nothing to port 1:1. This file is a PORT-GUARD for
// `EXPtoString` (hdrgen.d:4602).
//
// WHY A GUARD AND NOT A SAMPLE: every string below is compared BYTE-EXACT by the DMD
// `fail_compilation` corpus once it reaches a diagnostic (`cannot overload ... `%s``,
// `incompatible types for ... `%s``, ...). A single wrong spelling here is a real defect that no
// type check can see, so the table is pinned entry by entry, transcribed from hdrgen.d:4606-4747
// in D order — NOT inferred from the enum member names, several of which differ from their
// spelling (`EXP.int64` -> `long`, `EXP.tuple` -> `sequence`, `EXP.dSymbol` -> `symbol`).

/// The 124 entries of `strings` (hdrgen.d:4604-4748), in D source order.
const EXP_STRINGS: ReadonlyArray<readonly [EXP, string]> = [
    [EXP.type, "type"],
    [EXP.error, "error"],
    [EXP.objcClassReference, "class"],
    [EXP.mixin_, "mixin"],
    [EXP.import_, "import"],
    [EXP.dotVariable, "dotvar"],
    [EXP.scope_, "scope"],
    [EXP.identifier, "identifier"],
    [EXP.this_, "this"],
    [EXP.super_, "super"],
    [EXP.int64, "long"],
    [EXP.float64, "double"],
    [EXP.complex80, "creal"],
    [EXP.null_, "null"],
    [EXP.string_, "string"],
    [EXP.arrayLiteral, "arrayliteral"],
    [EXP.assocArrayLiteral, "assocarrayliteral"],
    [EXP.classReference, "classreference"],
    [EXP.file, "__FILE__"],
    [EXP.fileFullPath, "__FILE_FULL_PATH__"],
    [EXP.line, "__LINE__"],
    [EXP.moduleString, "__MODULE__"],
    [EXP.functionString, "__FUNCTION__"],
    [EXP.prettyFunction, "__PRETTY_FUNCTION__"],
    [EXP.typeid_, "typeid"],
    [EXP.is_, "is"],
    [EXP.assert_, "assert"],
    [EXP.halt, "halt"],
    [EXP.template_, "template"],
    [EXP.dSymbol, "symbol"],
    [EXP.function_, "function"],
    [EXP.variable, "var"],
    [EXP.symbolOffset, "symoff"],
    [EXP.structLiteral, "structLiteral"],
    [EXP.compoundLiteral, "compoundliteral"],
    [EXP.arrayLength, "arraylength"],
    [EXP.delegatePointer, "delegateptr"],
    [EXP.delegateFunctionPointer, "delegatefuncptr"],
    [EXP.remove, "remove"],
    [EXP.tuple, "sequence"],
    [EXP.traits, "__traits"],
    [EXP.overloadSet, "__overloadset"],
    [EXP.void_, "void"],
    [EXP.vectorArray, "vectorarray"],
    [EXP._Generic, "_Generic"],
    [EXP.dotTemplateInstance, "dotti"],
    [EXP.dotIdentifier, "dotid"],
    [EXP.dotTemplateDeclaration, "dottd"],
    [EXP.dot, "."],
    [EXP.dotType, "dottype"],
    [EXP.plusPlus, "++"],
    [EXP.minusMinus, "--"],
    [EXP.prePlusPlus, "++"],
    [EXP.preMinusMinus, "--"],
    [EXP.call, "call"],
    [EXP.slice, ".."],
    [EXP.array, "[]"],
    [EXP.index, "[i]"],
    [EXP.delegate_, "delegate"],
    [EXP.address, "&"],
    [EXP.star, "*"],
    [EXP.negate, "-"],
    [EXP.uadd, "+"],
    [EXP.not, "!"],
    [EXP.tilde, "~"],
    [EXP.delete_, "delete"],
    [EXP.new_, "new"],
    [EXP.newAnonymousClass, "newanonclass"],
    [EXP.cast_, "cast"],
    [EXP.vector, "__vector"],
    [EXP.pow, "^^"],
    [EXP.mul, "*"],
    [EXP.div, "/"],
    [EXP.mod, "%"],
    [EXP.add, "+"],
    [EXP.min, "-"],
    [EXP.concatenate, "~"],
    [EXP.leftShift, "<<"],
    [EXP.rightShift, ">>"],
    [EXP.unsignedRightShift, ">>>"],
    [EXP.lessThan, "<"],
    [EXP.lessOrEqual, "<="],
    [EXP.greaterThan, ">"],
    [EXP.greaterOrEqual, ">="],
    [EXP.in_, "in"],
    [EXP.equal, "=="],
    [EXP.notEqual, "!="],
    [EXP.identity, "is"],
    [EXP.notIdentity, "!is"],
    [EXP.and, "&"],
    [EXP.xor, "^"],
    [EXP.or, "|"],
    [EXP.andAnd, "&&"],
    [EXP.orOr, "||"],
    [EXP.question, "?"],
    [EXP.assign, "="],
    [EXP.construct, "="],
    [EXP.blit, "="],
    [EXP.addAssign, "+="],
    [EXP.minAssign, "-="],
    [EXP.concatenateAssign, "~="],
    [EXP.concatenateElemAssign, "~="],
    [EXP.concatenateDcharAssign, "~="],
    [EXP.mulAssign, "*="],
    [EXP.divAssign, "/="],
    [EXP.modAssign, "%="],
    [EXP.powAssign, "^^="],
    [EXP.leftShiftAssign, "<<="],
    [EXP.rightShiftAssign, ">>="],
    [EXP.unsignedRightShiftAssign, ">>>="],
    [EXP.andAssign, "&="],
    [EXP.orAssign, "|="],
    [EXP.xorAssign, "^="],
    [EXP.comma, ","],
    [EXP.declaration, "declaration"],
    [EXP.interval, "interval"],
    [EXP.loweredAssignExp, "="],
    [EXP.thrownException, "CTFE ThrownException"],
    [EXP.cantExpression, "<cant>"],
    [EXP.voidExpression, "cast(void)0"],
    [EXP.showCtfeContext, "<error>"],
    [EXP.break_, "<break>"],
    [EXP.continue_, "<continue>"],
    [EXP.goto_, "<goto>"],
];

/// The five `EXP` members the D initializer never names, so D leaves their `char*` slot `null`
/// and they take the `if (!p)` leg at hdrgen.d:4750.
const EXP_WITHOUT_STRING: readonly EXP[] = [
    EXP.reserved,
    EXP.throw_,
    EXP.dollar,
    EXP.interpolated,
    EXP.rvalue,
];

describe("hdrgen.d — EXPtoString (port-guard)", () => {
    test("every table entry renders its D spelling byte-exactly", () => {
        for (const [op, expected] of EXP_STRINGS) {
            expect(dsToJs(EXPtoString(op))).toBe(expected);
        }
    });

    test("the table covers 124 of the 129 EXP members, and nothing is listed twice", () => {
        expect(EXP_STRINGS.length).toBe(124);
        expect(new Set(EXP_STRINGS.map(([op]) => op)).size).toBe(124);
        // EXP.max is EXP.rvalue (the enum auto-increments from `reserved` = 0).
        expect(EXP.rvalue + 1).toBe(129);
    });

    test("every EXP member is either in the table or in the known no-string set", () => {
        const covered = new Set<number>(EXP_STRINGS.map(([op]) => op));
        const missing: number[] = [];
        for (let op = 0; op <= EXP.rvalue; op++) {
            if (!covered.has(op)) missing.push(op);
        }
        expect(missing.sort((a, b) => a - b)).toEqual([...EXP_WITHOUT_STRING].sort((a, b) => a - b));
    });

    test("an EXP with no string prints the error line and returns `XXXXX` (hdrgen.d:4750-4753)", () => {
        const written: string[] = [];
        const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown): boolean => {
            written.push(String(chunk));
            return true;
        });
        try {
            for (const op of EXP_WITHOUT_STRING) {
                expect(dsToJs(EXPtoString(op))).toBe("XXXXX");
            }
        } finally {
            spy.mockRestore();
        }
        expect(written).toEqual(EXP_WITHOUT_STRING.map((op) => `error: EXP ${op} has no string\n`));
    });

    test("the shared entries D really does duplicate stay duplicated", () => {
        // Not transcription slips — hdrgen.d assigns the same spelling to each of these.
        for (const op of [EXP.assign, EXP.construct, EXP.blit, EXP.loweredAssignExp])
            expect(dsToJs(EXPtoString(op))).toBe("=");
        expect(dsToJs(EXPtoString(EXP.plusPlus))).toBe(dsToJs(EXPtoString(EXP.prePlusPlus)));
        expect(dsToJs(EXPtoString(EXP.is_))).toBe("is");
        expect(dsToJs(EXPtoString(EXP.identity))).toBe("is");
    });

    test("the returned slice is the shared table entry, not a fresh copy (hdrgen.d:4757)", () => {
        expect(EXPtoString(EXP.type)).toBe(EXPtoString(EXP.type));
    });
});

// ── PORT-GUARD 2: the LIVE printer slice ────────────────────────────────────────────────────────
// `EXPtoString` above is self-contained; everything below pins the OTHER live exports of this file
// (10 §1.6b: one pin per risky construct, expectations written as the literal D produces — never
// re-evaluated from the implementation):
//   1. `typeToChars` (hdrgen.d:220) over the basic and dynamic-array `typeToBufferx` arms (visitBasic
//      :4327, visitDArray :4355 in both its alias and general forms) and over `visitWithMask`'s
//      mod-wrapping arm (:3929), which is what renders `const(int)` in a conversion diagnostic;
//   2. the typeToBufferx dispatch (:4566) routing a TypeInstance to ITS OWN arm, which prints through
//      the Dsymbol printer (13 §7.5 rule 1/2);
//   3. `toErrMsg(Expression)` (:126) over `visitString` (:2391) and `truncateForError` (:162) —
//      backtick doubling and the `maxLength - 3` + `...` cap are compared byte-exact by every
//      fail_compilation case that hits a long or backticked expression;
//   4. the `__rvalue(` … `)` wrapper (:3072-3077), straight-line code on EVERY expression print;
//   5. `stcToBuffer` (:3369) / `stcToString` (:3435) — the `auto ref` adjacency, the scope/ref/
//      return phrase built through the shared `L1` arm, and the flat-table order;
//   6. `linkageToChars` (:3505) / `visibilityToChars` (:3542), including the unnamed slot D leaves
//      `null` and the port leaves empty.

import { beforeEach } from "vitest";
import { Loc } from "./location.js";
import { Id } from "./id.js";
import { global } from "./globals.js";
import { ErrorSinkNull } from "./errorsink.js";
import { initTokens } from "./tokens.js";
import { Type_init, constOf } from "./typesem.js";
import { Type, TypeAArray, TypeDArray, TypeDelegate, TypeInstance, TypePointer } from "./mtype.js";
import { RealExp, StringExp } from "./expression.js";
import { LINK } from "./astenums.js";
import { Visibility } from "./dsymbol.js";
import { OutBuffer } from "./common/outbuffer.js";
import { STC } from "./astenums.js";
import {
    linkageToChars,
    stcToBuffer,
    toErrMsg,
    typeToChars,
    visibilityToChars,
} from "./hdrgen.js";

/**
 * Read back a `const(char)*` the way a C caller does: `OutBuffer.extractChars` NUL-terminates
 * (dmd/common/outbuffer.d:748), so the D-visible text is the bytes BEFORE that NUL.
 */
function chars(d: DString): string {
    return dsToJs(cstr(d));
}

/** A `StringExp` over ASCII `s` — a literal whose printed form (`"s"`) needs no type or symbol. */
function strExp(s: string): StringExp {
    return new StringExp(Loc.initial, Array.from(s, (c) => c.charCodeAt(0)));
}

describe("hdrgen.d — the live printer slice (port-guard)", () => {
    beforeEach(() => {
        initTokens(); // also runs Identifier.initTable
        Id.initialize();
        Loc._init();
        Type_init(); // dmd/typesem.d:1224 — the basic-type singletons these pins print
        global.errorSink = new ErrorSinkNull();
        global.errors = 0;
    });

    test("typeToChars renders the basic and dynamic-array typeToBufferx arms (hdrgen.d:4327/:4355)", () => {
        expect(chars(typeToChars(Type.tint32))).toBe("int");            // visitBasic
        expect(chars(typeToChars(Type.tstring))).toBe("string");        // visitDArray alias arm
        expect(chars(typeToChars(new TypeDArray(Type.tint32)))).toBe("int[]"); // visitDArray L1 arm
    });

    test("typeToChars wraps head mod bits through visitWithMask (hdrgen.d:3929-3953)", () => {
        // The `const(int)` operand of `cannot implicitly convert expression ... of type `const(int)`
        // to `int`` — the single most common shape in fail_compilation.
        expect(chars(typeToChars(constOf(Type.tint32)))).toBe("const(int)");
    });

    // RE-PIN (10 §1.8 rule 7): this used to pin `visitPointer (dmd/hdrgen.d:4382)`, then
    // `visitAArray (dmd/hdrgen.d:4374)`, then the Dsymbol-printer wall at hdrgen.d:4448 (dsymbolToBuffer,
    // :975). The Dsymbol printer is live since wave 13, so the pin is now the behaviour: typeToBufferx's
    // `case Tinstance` (hdrgen.d:4580) -> visitInstance -> dsymbolToBuffer -> visitTemplateInstance
    // (hdrgen.d:1588): the name, then `!()` for an instance with no argument list (hdrgen.d:3989).
    // DERIVED from the D source.
    test("a TypeInstance prints through the Dsymbol printer inside its own arm (13 §7.5 rule 2)", () => {
        const ti = new TemplateInstance(Loc.initial, Identifier.idPool(ds("V")), null);
        expect(chars(typeToChars(new TypeInstance(Loc.initial, ti)))).toBe("V!()");
    });

    test("toErrMsg quotes a string literal through visitString (hdrgen.d:2391-2415)", () => {
        expect(chars(toErrMsg(strExp("ab")))).toBe('"ab"');
    });

    test("truncateForError doubles backticks and caps at maxLength - 3 + `...` (hdrgen.d:162-185)", () => {
        // Backtick doubling: the message is rendered BETWEEN backticks, so each one is escaped.
        expect(chars(toErrMsg(strExp("a`b")))).toBe('"a``b"');
        // Cap: the printed form is `"` + 80 x + `"` = 82 bytes > 60, so setsize(57) + "..." = 60.
        const long = chars(toErrMsg(strExp("x".repeat(80))));
        expect(long).toBe('"' + "x".repeat(56) + "...");
        expect(long.length).toBe(60);
    });

    test("expressionPrettyPrint wraps an rvalue-marked expression in `__rvalue(` … `)` (hdrgen.d:3072)", () => {
        const e = strExp("ab");
        e.rvalue = true;
        expect(chars(toErrMsg(e))).toBe('__rvalue("ab")');
    });

    test("stcToBuffer writes D's canonical storage-class order (hdrgen.d:3369-3428)", () => {
        const spell = (stc: STC): string => {
            const buf = new OutBuffer();
            const wrote = stcToBuffer(buf, stc);
            return (wrote ? "" : "!") + chars(buf.extractChars());
        };
        // (`(a | b) as STC` is the branded flag-enum re-cast, 02 §11.5c item 4.)
        // `auto` is emitted first, with its own trailing space, so `auto ref` stays adjacent
        // (hdrgen.d:3385) — and `auto` alone does NOT set `result` (D's own asymmetry).
        expect(spell((STC.auto_ | STC.ref_) as STC)).toBe("auto ref");
        // the scope/ref/return phrase, built through the shared `L1` arm (hdrgen.d:3409)
        expect(spell((STC.ref_ | STC.return_) as STC)).toBe("return ref");
        expect(spell((STC.out_ | STC.return_) as STC)).toBe("return out");
        expect(spell((STC.ref_ | STC.scope_) as STC)).toBe("ref scope");
        // the flat table (hdrgen.d:3445), picked in TABLE order, space-separated
        expect(spell((STC.static_ | STC.const_) as STC)).toBe("static const");
        expect(spell((STC.nogc | STC.safe) as STC)).toBe("@nogc @safe");
        // nothing visible written -> false, empty buffer
        expect(spell(STC.none)).toBe("!");
    });

    test("linkageToChars / visibilityToChars, including D's unnamed slots (hdrgen.d:3511/:3549)", () => {
        expect(chars(linkageToChars(LINK.d))).toBe("D");
        expect(chars(linkageToChars(LINK.cpp))).toBe("C++");
        expect(chars(linkageToChars(LINK.objc))).toBe("Objective-C");
        // D leaves `default_` at `null`; the port stores an empty slice (same `.length`).
        expect(chars(linkageToChars(LINK.default_))).toBe("");

        expect(chars(visibilityToChars(Visibility.Kind.private_))).toBe("private");
        expect(chars(visibilityToChars(Visibility.Kind.export_))).toBe("export");
        expect(chars(visibilityToChars(Visibility.Kind.undefined))).toBe("");
    });
});

// ---------------------------------------------------------------------------------------------
// PORT-GUARD for the argument/parameter printer slice filled at hdrgen.d:3586-3760:
// `argExpTypesToCBuffer` (:3586), `arrayObjectsToBuffer` (:3599), `parametersTypeToChars` (:3618)
// and the two module-private helpers they need (`parametersToBuffer` :3658,
// `parameterToBuffer` :3696).
//
// dmd/hdrgen.d still has NO in-source `unittest {}` block (10 §1: nothing to port 1:1), so these
// are behaviour pins on strings the `fail_compilation` corpus compares byte-exact, plus ONE
// pinned wall (10 §1.8). Every expected value below is D's own output read off the source lines
// cited next to it — never the port's expression re-evaluated (10 §1.8 rule 8).
//
// The typed legs of this slice and `parameterToBuffer`'s UDA (`argsToBuffer` :3706) and default-
// argument (`expToBuffer` :3755) legs are pinned in the wave-8 block below. NOT PINNED: the `__T`
// special case (:3740-3745), and `argExpTypesToCBuffer`'s typed loop (:3595).
// The `alias` leg (:3735-3737), which prints only the ident, looks Type-free but is NOT reachable
// without one either: `ParameterList.length()` -> `Parameter.dim` dereferences `p.type`
// (dmd/mtype.d:2351), so a parameter with a null type cannot be counted. Not pinned.

describe("hdrgen.d:3586 argExpTypesToCBuffer — the guard legs", () => {
    test("a null argument list writes nothing (hdrgen.d:3588)", () => {
        const buf = new OutBuffer();
        argExpTypesToCBuffer(buf, null);
        expect(dsToJs(buf.extractSlice())).toBe("");
    });

    test("an empty argument list writes nothing (hdrgen.d:3588)", () => {
        const buf = new OutBuffer();
        argExpTypesToCBuffer(buf, new Array_<Expression | null>());
        expect(dsToJs(buf.extractSlice())).toBe("");
    });
});

describe("hdrgen.d:3599 arrayObjectsToBuffer", () => {
    test("a null object list writes nothing (hdrgen.d:3601)", () => {
        const buf = new OutBuffer();
        arrayObjectsToBuffer(buf, null);
        expect(dsToJs(buf.extractSlice())).toBe("");
    });

    test("an empty object list writes nothing (hdrgen.d:3601)", () => {
        const buf = new OutBuffer();
        arrayObjectsToBuffer(buf, new Array_<RootObject | null>());
        expect(dsToJs(buf.extractSlice())).toBe("");
    });

    // RE-PIN (10 §1.8 rule 7). This test used to pin the wall
    // `objectToBuffer (dmd/hdrgen.d:4033) at dmd/hdrgen.d:3608`; objectToBuffer is now live, so the
    // null element prints what D writes for it: `buf.put("NULL")` (hdrgen.d:4073-4075).
    test("a null element prints `NULL` through objectToBuffer (hdrgen.d:4075)", () => {
        const objects: Objects = new Array_<RootObject | null>(1);
        objects.opIndexAssign(null, 0);
        const buf = new OutBuffer();
        arrayObjectsToBuffer(buf, objects);
        expect(dsToJs(buf.extractSlice())).toBe("NULL");
    });
});

describe("hdrgen.d:3618 parametersTypeToChars", () => {
    test("no parameters -> `()` (hdrgen.d:3660/:3686)", () => {
        expect(chars(parametersTypeToChars(new ParameterList(null)))).toBe("()");
    });

    test("C-style `...` with no parameters -> `(...)` (VarArg.variadic, hdrgen.d:3673-3683)", () => {
        // pl.length == 0, so the `, ` at :3674 is skipped and pl.stc is STC.none, so
        // stcToBuffer writes nothing; the `goto case VarArg.typesafe` lands on `...` (:3683).
        expect(chars(parametersTypeToChars(new ParameterList(null, VarArg.variadic)))).toBe("(...)");
    });

    test("typesafe variadic with no parameters -> `(...)` (hdrgen.d:3682-3683)", () => {
        expect(chars(parametersTypeToChars(new ParameterList(null, VarArg.typesafe)))).toBe("(...)");
    });

    test("KR variadic prints like `none` -> `()` (hdrgen.d:3669-3671 share one arm)", () => {
        expect(chars(parametersTypeToChars(new ParameterList(null, VarArg.KRvariadic)))).toBe("()");
    });
});

describe("hdrgen.d:3634 parameterToChars", () => {
    // `Identifier.idPool` needs the identifier table (initTokens also runs Identifier.initTable).
    beforeEach(() => { initTokens(); });

    // The `alias` leg (hdrgen.d:3735-3737) is the one leg reachable with a null `type`: D's own
    // `p.type && p.type.mod` test at :3727 is null-safe, and parameterToChars calls
    // parameterToBuffer DIRECTLY, so `ParameterList.length()` (which would deref `p.type` via
    // `Parameter.dim`, mtype.d:2351) is never reached. With `varargs != typesafe` the `&&` at
    // hdrgen.d:3642 short-circuits before `tf.parameterList[...]`.
    test("an `alias` parameter prints `alias <ident>` (hdrgen.d:3724/:3737)", () => {
        const ident = Identifier.idPool(ds("T"));
        const p = new Parameter(Loc.initial, STC.alias_, null, ident, null, null);
        const tf = new TypeFunction(new ParameterList(null), null, LINK.d);
        expect(chars(parameterToChars(p, tf, false))).toBe("alias T");
    });

    // Not a typesafe-variadic list, so no `...` tail is appended (hdrgen.d:3642 is false).
    test("no `...` tail when the list is not typesafe-variadic (hdrgen.d:3642)", () => {
        const p = new Parameter(Loc.initial, STC.alias_, null, Identifier.idPool(ds("T")), null, null);
        const tf = new TypeFunction(new ParameterList(null, VarArg.variadic), null, LINK.d);
        expect(chars(parameterToChars(p, tf, false))).toBe("alias T");
    });
});

// ---------------------------------------------------------------------------------------------
// PORT-GUARD for the function / argument printer region (TARGETED FILL, wave 8):
// `functionToBufferFull` (:3565), `functionToBufferWithIdent` (:3572), `visitFuncIdentWithPostfix`
// (:4088), `visitFuncIdentWithPrefix` (:4134), `linkageToBuffer` (:3494), `argsToBuffer` (:3769),
// `expToBuffer` (:3871), `objectToBuffer` (:4033), `toCharsMaybeConstraints` (:2067) and
// `templateParameterToCBuffer` / `TemplateParameterPrettyPrintVisitor` (:3218/:3224), plus the two
// scope additions `rootObjectToErrMsg` (:112) and `toCBufferInstance` (:3355, over `tiargsToBuffer`).
//
// Every expected string is ldc2 1.43.0 output (`ldc2 -c -o-` on the probe named next to it; the
// probes live in the wave-8 scratchpad, not in the repo), or, for `-H`, the generated `.di` text.
// The fixtures build the AST node the D diagnostic prints (a TypeFunction / TemplateDeclaration
// with the probe's parameters) and call the SAME hdrgen entry the D call site calls, with the
// `HdrGenState` that site sets up. Where a probe's type would route through a still-walled
// `typeToBufferx` arm (a pointer return type, a `T x` parameter), the probe was re-shaped in D
// until every printed type is basic, `string` or `T[]`, and re-run: no expectation is edited by hand.
//
// NOT PINNED here: `dumpTemplateInstance` (pinned by the wave-13 suite, through the Dsymbol printer's
// visitTemplateInstance in full-dump mode). The paren arm of `expToBuffer` (hdrgen.d:3889), `sizeToBuffer` and
// `visitTemplateParameters` became reachable with the wave-10 expression printer and are pinned in
// the wave-10 block at the end of this file.

import {
    functionToBufferFull,
    functionToBufferWithIdent,
    HdrGenState,
    rootObjectToErrMsg,
    templateParameterToCBuffer,
    toCBufferInstance,
    toCharsMaybeConstraints,
} from "./hdrgen.js";
import { MODFlags } from "./astenums.js";
import { TOK } from "./tokens.js";
import {
    TemplateAliasParameter,
    TemplateDeclaration,
    TemplateInstance,
    TemplateThisParameter,
    TemplateTupleParameter,
    TemplateTypeParameter,
    TemplateValueParameter,
    Tuple,
} from "./dtemplate.js";
import type { TemplateParameter } from "./dtemplate.js";
import { FuncDeclaration } from "./func.js";
import { UserAttributeDeclaration } from "./attrib.js";
import { AssertError } from "../assert.js";
import { CTFloat } from "./root/ctfloat.js";
import type { Parameters, TemplateParameters, Expressions } from "./arraytypes.js";

/**
 * The paired-state tests below need an exit D does not have. They open one by making `CTFloat.sprint`
 * (root/ctfloat.d, reached at hdrgen.d:3180 by `floatToBuffer`) throw for the duration of `f`: a float
 * literal is the deepest point a printer reaches with every region open.
 */
const SPRINT_THROW = "injected throw at CTFloat.sprint";
function withSprintThrowing(f: () => void): void {
    const spy = vi.spyOn(CTFloat, "sprint").mockImplementation(() => {
        throw new Error(SPRINT_THROW);
    });
    try {
        f();
    } finally {
        spy.mockRestore();
    }
}

describe("hdrgen.d — the function / argument printer region (wave 8 port-guard)", () => {
    beforeEach(() => {
        initTokens(); // also runs Identifier.initTable
        Id.initialize();
        Loc._init();
        Type_init();
        global.errorSink = new ErrorSinkNull();
        global.errors = 0;
    });

    const id = (s: string): Identifier => Identifier.idPool(ds(s));
    /** A fresh, NON-interned identifier — what funcsem.d:1352 builds from `toPrettyChars()`. */
    const prettyId = (s: string): Identifier => new Identifier(ds(s), TOK.identifier);
    const param = (stc: STC, t: Type, name: string, defaultArg: Expression | null = null,
        uda: UserAttributeDeclaration | null = null): Parameter =>
        new Parameter(Loc.initial, stc, t, id(name), defaultArg, uda);
    const params = (...ps: Parameter[]): Parameters => {
        const a = new Array_<Parameter | null>();
        for (const p of ps) a.push(p);
        return a;
    };
    const tfOf = (ps: Parameters | null, ret: Type | null, link: LINK = LINK.d, stc: STC = STC.none,
        varargs: VarArg = VarArg.none): TypeFunction =>
        new TypeFunction(new ParameterList(ps, varargs), ret, link, stc);
    const withIdent = (tf: TypeFunction, ident: string | null, isStatic = false): string => {
        const buf = new OutBuffer();
        functionToBufferWithIdent(tf, buf, ident === null ? null : ds(ident), isStatic);
        return dsToJs(buf.extractSlice());
    };
    const full = (tf: TypeFunction, ident: Identifier | null, hgs: HdrGenState = new HdrGenState()): string => {
        const buf = new OutBuffer();
        functionToBufferFull(tf, buf, ident, hgs, null);
        return dsToJs(buf.extractSlice());
    };

    // ── functionToBufferWithIdent: the POSTFIX form (probe pf.d, `pragma(msg, __PRETTY_FUNCTION__)`,
    //    which is expressionsem.d:17179's call; plus pf.d's `int function(int) fp = 3;`) ──────────

    test("postfix form: return type, name, parameters, then the attributes (hdrgen.d:4103-4129)", () => {
        // pf.d: `int foo(int a, string b) nothrow @safe` -> `int pf.foo(int a, string b) nothrow @safe`
        const tf = tfOf(params(param(STC.none, Type.tint32, "a"), param(STC.none, Type.tstring, "b")),
            Type.tint32, LINK.d, (STC.nothrow_ | STC.safe) as STC);
        expect(withIdent(tf, "pf.foo")).toBe("int pf.foo(int a, string b) nothrow @safe");
    });

    test("a non-D linkage prints `extern (L) ` first (hdrgen.d:4096, linkageToBuffer :3494)", () => {
        // pf.d: `extern(C) void bar(int a)` -> `extern (C) void pf.bar(int a)`
        const tf = tfOf(params(param(STC.none, Type.tint32, "a")), Type.tvoid, LINK.c);
        expect(withIdent(tf, "pf.bar")).toBe("extern (C) void pf.bar(int a)");
    });

    test("`static ` follows the linkage only for extern (Objective-C) (hdrgen.d:4101)", () => {
        // pf.d: `extern(Objective-C) class O { static void so() }` -> `extern (Objective-C) static void pf.O.so()`
        expect(withIdent(tfOf(null, Type.tvoid, LINK.objc), "pf.O.so", true))
            .toBe("extern (Objective-C) static void pf.O.so()");
        // pf.d: `class K { static void sk() }` (D linkage) -> `void pf.K.sk()`, no `static`
        expect(withIdent(tfOf(null, Type.tvoid, LINK.d), "pf.K.sk", true)).toBe("void pf.K.sk()");
    });

    test("no return type yet (`auto`, not inferred) prints the name with no space (hdrgen.d:4111)", () => {
        // pf.d: `auto inf(int a)` inside its own body -> `pf.inf(int a)`
        expect(withIdent(tfOf(params(param(STC.none, Type.tint32, "a")), null), "pf.inf")).toBe("pf.inf(int a)");
    });

    test("C-style variadic and a `ref` return (hdrgen.d:4115/:4129)", () => {
        // pf.d: `void va(int a, ...)` -> `void pf.va(int a, ...)`
        const va = tfOf(params(param(STC.none, Type.tint32, "a")), Type.tvoid, LINK.d, STC.none, VarArg.variadic);
        expect(withIdent(va, "pf.va")).toBe("void pf.va(int a, ...)");
        // pf.d: `ref int r(return ref int a)` -> `int pf.r(return ref int a) ref`
        const r = tfOf(params(param((STC.return_ | STC.ref_) as STC, Type.tint32, "a")), Type.tint32, LINK.d, STC.ref_);
        expect(withIdent(r, "pf.r")).toBe("int pf.r(return ref int a) ref");
    });

    test("the `function` keyword as ident is the function-pointer spelling (hdrgen.d:4088)", () => {
        // pf.d: `int function(int) fp = 3;` -> "cannot implicitly convert expression `3` of type `int`
        // to `int function(int)`". D's visitPointer (hdrgen.d:4382) reaches exactly
        // this leaf: `visitFuncIdentWithPostfix(tf, "function", buf, hgs, false)`.
        const tf = tfOf(params(new Parameter(Loc.initial, STC.none, Type.tint32, null, null, null)), Type.tint32);
        expect(withIdent(tf, "function")).toBe("int function(int)");
    });

    test("recursion guard: a TypeFunction already in use writes nothing and is flagged (hdrgen.d:4090)", () => {
        const tf = tfOf(null, Type.tint32);
        tf.inuse = 1;
        expect(withIdent(tf, "f")).toBe("");
        expect(tf.inuse).toBe(2); // `t.inuse = 2; // flag error to caller`
    });

    test("paired state: a throw under the return type leaves `inuse` and `inFuncReturn` restored (11 §2.5)", () => {
        // `V!(1.5)` prints its argument through visitReal -> floatToBuffer -> `CTFloat.sprint`
        // (hdrgen.d:3180), where the throw is injected. D has no such exit; the port must not leak `inuse`
        // (a later print of the same type would otherwise silently print NOTHING through the recursion
        // guard) or the caller's `inFuncReturn`.
        const tiargs = new Array_<RootObject | null>();
        tiargs.push(new RealExp(Loc.initial, 1.5, Type.tfloat64));
        const tf = tfOf(null, new TypeInstance(Loc.initial, new TemplateInstance(Loc.initial, id("V"), tiargs)));
        const hgs = new HdrGenState();
        withSprintThrowing(() => expect(() => full(tf, prettyId("m.f"), hgs)).toThrow(SPRINT_THROW));
        expect(tf.inuse).toBe(0);
        expect(hgs.inFuncReturn).toBe(false);
        withSprintThrowing(() => expect(() => withIdent(tf, "m.f")).toThrow(SPRINT_THROW));
        expect(tf.inuse).toBe(0);
    });

    // ── functionToBufferFull: the PREFIX form (probes ov.d / ov2.d, funcsem.d:1352/:1415's "does not
    //    override any function" pair; hc.d `-H` for the header-generation mode) ───────────────────

    test("prefix form over a non-interned pretty name (funcsem.d:1352)", () => {
        // ov.d: `function `void ov.C.foo(int a)` does not override any function`
        //       `did you mean to override `void ov.B.foo(string a)`?`
        expect(full(tfOf(params(param(STC.none, Type.tint32, "a")), Type.tvoid), prettyId("ov.C.foo")))
            .toBe("void ov.C.foo(int a)");
        const hgs = new HdrGenState();
        hgs.fullQual = true; // funcsem.d:1360 — `fd.ident == funcdecl.ident`
        expect(full(tfOf(params(param(STC.none, Type.tstring, "a")), Type.tvoid), prettyId("ov.B.foo"), hgs))
            .toBe("void ov.B.foo(string a)");
    });

    test("prefix form puts the mod and the attributes BEFORE the return type (hdrgen.d:4146-4163)", () => {
        // ov2.d: `int bar(ref int x, lazy string s, int[] y...) const nothrow @safe` ->
        //   `did you mean to override `const nothrow @safe int ov2.D2.bar(ref int x, lazy string s, int[] y...)`?`
        const tf = tfOf(params(param(STC.ref_, Type.tint32, "x"), param(STC.lazy_, Type.tstring, "s"),
            param(STC.none, new TypeDArray(Type.tint32), "y")), Type.tint32, LINK.d,
            (STC.nothrow_ | STC.safe) as STC, VarArg.typesafe);
        tf.mod = MODFlags.const_;
        const hgs = new HdrGenState();
        hgs.fullQual = true;
        expect(full(tf, prettyId("ov2.D2.bar"), hgs))
            .toBe("const nothrow @safe int ov2.D2.bar(ref int x, lazy string s, int[] y...)");
    });

    test("header mode: a ctor prints `this`, no return type, no `ref`, mod postfix (hdrgen.d:4157/:4170/:4199)", () => {
        // hc.d `-H`: `struct S { this(int a) const {} ~this() {} int m(int a) const return scope {} }`
        //   -> `this(int a) const;` / `~this();` / `int m(int a) const return scope;`
        const hgs = new HdrGenState();
        hgs.hdrgen = true;
        const ctor = tfOf(params(param(STC.none, Type.tint32, "a")), Type.tvoid, LINK.d, STC.ref_);
        ctor.mod = MODFlags.const_;
        expect(full(ctor, Id.ctor, hgs)).toBe("this(int a) const");
        expect(full(tfOf(null, Type.tvoid), Id.dtor, hgs)).toBe("~this()");
        const m = tfOf(params(param(STC.none, Type.tint32, "a")), Type.tint32);
        m.mod = MODFlags.const_;
        m.isScopeQual = true;
        m.isReturnScope = true;
        expect(full(m, id("m"), hgs)).toBe("int m(int a) const return scope");
    });

    // ── parameterToBuffer's two formerly-walled legs, now through argsToBuffer / expToBuffer
    //    (probe da.d: the "cannot pass argument ... to parameter `%s`" supplemental) ────────────────

    test("a default argument prints ` = <exp>` at PREC.assign (hdrgen.d:3752-3755, expToBuffer :3871)", () => {
        // da.d: `void f(string a = "x")` -> "... to parameter `string a = "x"`"
        const p = param(STC.none, Type.tstring, "a", strExp("x"));
        const tf = tfOf(params(p), Type.tvoid);
        expect(chars(parameterToChars(p, tf, false))).toBe('string a = "x"');
    });

    test("a UDA prints `@(<args>) ` before the parameter (hdrgen.d:3698-3710, argsToBuffer :3769)", () => {
        // da.d: `void g(@("u") int a, @("v", "w") int b)` -> "... to parameter `@("u") int a`",
        // and the declared-here line spells the second one `@("v", "w") int b`.
        const uda = (...ss: string[]): UserAttributeDeclaration => {
            const atts: Expressions = new Array_<Expression | null>();
            for (const s of ss) atts.push(strExp(s));
            return new UserAttributeDeclaration(atts, null);
        };
        const a = param(STC.none, Type.tint32, "a", null, uda("u"));
        const b = param(STC.none, Type.tint32, "b", null, uda("v", "w"));
        const tf = tfOf(params(a, b), Type.tvoid);
        expect(chars(parameterToChars(a, tf, false))).toBe('@("u") int a');
        expect(chars(parameterToChars(b, tf, false))).toBe('@("v", "w") int b');
    });

    test("the `...` tail compares parameters with Parameter.opEquals, not identity (hdrgen.d:3642)", () => {
        // peq2.d: `void f(int a, int b...)` called as `f("x", 1)` -> "cannot pass argument `"x"` of
        // type `string` to parameter `int a...`": `a` equals the typesafe tail `b` (same storage
        // class, same type object, mtype.d:2581), so D appends `...` to `a` as well.
        const a = param(STC.none, Type.tint32, "a");
        const b = param(STC.none, Type.tint32, "b");
        const tf = tfOf(params(a, b), Type.tvoid, LINK.d, STC.none, VarArg.typesafe);
        expect(chars(parameterToChars(a, tf, false))).toBe("int a...");
        expect(chars(parameterToChars(b, tf, false))).toBe("int b...");
    });

    // ── objectToBuffer through arrayObjectsToBuffer (probe t4.d: funcsem.d:1977's `!(...)` list) ──

    test("types, tuples and nulls in a template-argument list (hdrgen.d:4041/:4059/:4073)", () => {
        // t4.d: `h!(int)("a")` -> "argument types `!(int)(string)`"; `h!(int, string)` lists both.
        const objs = (...os: (RootObject | null)[]): Objects => {
            const a = new Array_<RootObject | null>();
            for (const o of os) a.push(o);
            return a;
        };
        const render = (o: Objects): string => {
            const buf = new OutBuffer();
            arrayObjectsToBuffer(buf, o);
            return dsToJs(buf.extractSlice());
        };
        expect(render(objs(Type.tint32))).toBe("int");
        expect(render(objs(Type.tint32, Type.tstring))).toBe("int, string");
        // A Tuple prints its elements comma-separated, in place (hdrgen.d:4061-4067); `NULL` is D's
        // literal for a null slot (hdrgen.d:4075).
        const tup = new Tuple();
        tup.objects.push(Type.tint32);
        tup.objects.push(null);
        expect(render(objs(tup, Type.tstring))).toBe("int, NULL, string");
    });

    // ── toCharsMaybeConstraints + the template-parameter visitor (probes td.d / t3.d: the
    //    "Candidate is" / "does not match template declaration" lines) ─────────────────────────────

    const tparams = (...ps: TemplateParameter[]): TemplateParameters => {
        const a = new Array_<TemplateParameter | null>();
        for (const p of ps) a.push(p);
        return a;
    };
    /** `name(<tps>)(<fn params>)`: a template whose one member is a function over `fnParams`. */
    const tdecl = (ident: Identifier, tps: TemplateParameters, fnParams: Parameters | null): TemplateDeclaration => {
        const td = new TemplateDeclaration(Loc.initial, ident, tps, null, null);
        td.onemember = new FuncDeclaration(Loc.initial, Loc.initial, ident, STC.none, tfOf(fnParams, Type.tvoid));
        return td;
    };
    const candidate = (td: TemplateDeclaration, hgs: HdrGenState = new HdrGenState()): string => {
        const buf = new OutBuffer();
        toCharsMaybeConstraints(td, buf, hgs);
        return dsToJs(buf.extractSlice());
    };

    test("every template-parameter kind, then the one member's parameters (hdrgen.d:2067-2093)", () => {
        // td.d: `void foo(T, alias A, int N, Args...)(int x)` ->
        //   "Candidate is: `foo(T, alias A, int N, Args...)(int x)`"
        const td = tdecl(id("foo"), tparams(
            new TemplateTypeParameter(Loc.initial, id("T"), null, null),
            new TemplateAliasParameter(Loc.initial, id("A"), null, null, null),
            new TemplateValueParameter(Loc.initial, id("N"), Type.tint32, null, null),
            new TemplateTupleParameter(Loc.initial, id("Args")),
        ), params(param(STC.none, Type.tint32, "x")));
        expect(candidate(td)).toBe("foo(T, alias A, int N, Args...)(int x)");
    });

    test("a type parameter's specialization and default (hdrgen.d:3240-3249)", () => {
        // td.d: `void bar(T : int = long)(int x)` -> "does not match template declaration `bar(T : int = long)(int x)`"
        const td = tdecl(id("bar"), tparams(new TemplateTypeParameter(Loc.initial, id("T"), Type.tint32, Type.tint64)),
            params(param(STC.none, Type.tint32, "x")));
        expect(candidate(td)).toBe("bar(T : int = long)(int x)");
    });

    test("`this T` and the ctor spelling `this(...)` (hdrgen.d:3252-3255, :2069)", () => {
        // t3.d: `void f(this T)(int a)` -> "Candidate is: `f(this T)(int a)`"
        const f = tdecl(id("f"), tparams(new TemplateThisParameter(Loc.initial, id("T"), null, null)),
            params(param(STC.none, Type.tint32, "a")));
        expect(candidate(f)).toBe("f(this T)(int a)");
        // t3.d: `this(T)(int a) if (is(T == int))` -> "Candidate is: `this(T)(int a)`" — funcsem.d:2328
        // sets `skipConstraints`, so the constraint is not printed here.
        const ctor = tdecl(Id.ctor!, tparams(new TemplateTypeParameter(Loc.initial, id("T"), null, null)),
            params(param(STC.none, Type.tint32, "a")));
        ctor.constraint = strExp("never printed");
        const hgs = new HdrGenState();
        hgs.skipConstraints = true;
        expect(candidate(ctor, hgs)).toBe("this(T)(int a)");
    });

    test("showOneMember off: only the template parameter list (hdrgen.d:2079)", () => {
        // funcsem.d:2329 clears showOneMember when the member is not a lone function (`recurse`).
        const td = tdecl(id("foo"), tparams(new TemplateTypeParameter(Loc.initial, id("T"), null, null)),
            params(param(STC.none, Type.tint32, "x")));
        const hgs = new HdrGenState();
        hgs.showOneMember = false;
        expect(candidate(td, hgs)).toBe("foo(T)");
    });

    test("templateParameterToCBuffer dispatches through each parameter's own accept (13 §2)", () => {
        const one = (tp: TemplateParameter): string => {
            const buf = new OutBuffer();
            templateParameterToCBuffer(tp, buf, new HdrGenState());
            return dsToJs(buf.extractSlice());
        };
        // t5.d: `void k(alias int A)(int x)` -> "does not match template declaration `k(alias int A)(int x)`":
        // an `alias` parameter with a type prints `alias <type> <ident>` (hdrgen.d:3261-3262).
        expect(one(new TemplateAliasParameter(Loc.initial, id("A"), Type.tint32, null, null))).toBe("alias int A");
        const k = tdecl(id("k"), tparams(new TemplateAliasParameter(Loc.initial, id("A"), Type.tint32, null, null)),
            params(param(STC.none, Type.tint32, "x")));
        expect(candidate(k)).toBe("k(alias int A)(int x)");
        // NOT pinned: an alias specialization / default (hdrgen.d:3265-3274). ldc2 prints
        // `g(alias A : (int) = string, T)(T x)` (probe t6.d) — by then the specialization is an
        // expression whose printer arm still walls here, so no honest fixture exists yet.
    });
    // ── rootObjectToErrMsg (hdrgen.d:112): the RootObject dispatcher over the toErrMsg forms ────────
    test("rootObjectToErrMsg dispatches on the object's kind (hdrgen.d:114-121)", () => {
        // Expression -> toErrMsg(Expression) (hdrgen.d:126): errorMsg-mode + truncateForError.
        expect(chars(rootObjectToErrMsg(strExp("ab")))).toBe('"ab"');
        // Type -> `t.toChars()` (hdrgen.d:119).
        expect(chars(rootObjectToErrMsg(Type.tint32))).toBe("int");
        // Identifier -> `id.toChars()` (hdrgen.d:121).
        expect(chars(rootObjectToErrMsg(id("x")))).toBe("x");
        // Dsymbol -> toErrMsg(Dsymbol) (hdrgen.d:138): a name with no `__` prefix is `d.toChars()`
        // (hdrgen.d:153), which for a plain function is its identifier (hdrgen.d:264).
        const fd = new FuncDeclaration(Loc.initial, Loc.initial, id("foo"), STC.none, tfOf(null, Type.tvoid));
        expect(chars(rootObjectToErrMsg(fd))).toBe("foo");
        // D's `assert(0)` (hdrgen.d:122) for anything else — a Tuple is none of the four kinds.
        // `assertUnreachable()` raises an AssertError carrying its default message.
        expect(() => rootObjectToErrMsg(new Tuple())).toThrow(AssertError);
        expect(() => rootObjectToErrMsg(new Tuple())).toThrow("Assertion failure");
    });
    // ── toCBufferInstance (hdrgen.d:3355) → tiargsToBuffer (:3981): the instance's pretty name ─────
    test("an instance prints `name!arg` for one simple type, `name!(a, b)` otherwise (hdrgen.d:3994-4026)", () => {
        const inst = (name: string, ...os: RootObject[]): string => {
            const tiargs = new Array_<RootObject | null>();
            for (const o of os) tiargs.push(o);
            const ti = new TemplateInstance(Loc.initial, id(name), tiargs);
            const buf = new OutBuffer();
            toCBufferInstance(ti, buf);
            expect(ti.nest).toBe(0); // nestUp/nestDown stay paired (hdrgen.d:4018/:4025)
            return dsToJs(buf.extractSlice());
        };
        // td.d: "template instance `bar!string` does not match template declaration ..."
        expect(inst("bar", Type.tstring)).toBe("bar!string");
        // t4.d: "template instance `t4.h!(int, string)` does not match ..." (the `t4.` prefix is
        // toPrettyChars' parent walk, not this printer).
        expect(inst("h", Type.tint32, Type.tstring)).toBe("h!(int, string)");
        // hdrgen.d:3989-3992 — no argument list at all prints `!()`.
        const bare = new TemplateInstance(Loc.initial, id("h"), null);
        const buf = new OutBuffer();
        toCBufferInstance(bare, buf);
        expect(dsToJs(buf.extractSlice())).toBe("h!()");
    });
    // ── typeToBufferx arms visitPointer / visitDelegate (hdrgen.d:4382-4409), via typeToChars ─────────
    test("pointer and delegate types (probe ptr.d, `cannot implicitly convert ... to `%s``)", () => {
        const fnInt = (): TypeFunction =>
            tfOf(params(new Parameter(Loc.initial, STC.none, Type.tint32, null, null, null)), Type.tint32);
        // ptr.d: `int* a = 1;` -> `int*`
        expect(chars(typeToChars(new TypePointer(Type.tint32)))).toBe("int*");
        // ptr.d: `const(int)* b = 2;` -> `const(int)*` (the target's mod is wrapped, hdrgen.d:4389)
        expect(chars(typeToChars(new TypePointer(constOf(Type.tint32))))).toBe("const(int)*");
        // ptr.d: `int function(int) c = 3;` -> `int function(int)` (hdrgen.d:4386)
        expect(chars(typeToChars(new TypePointer(fnInt())))).toBe("int function(int)");
        // ptr.d: `int function(int)* f = 6;` -> `int function(int)*`
        expect(chars(typeToChars(new TypePointer(new TypePointer(fnInt()))))).toBe("int function(int)*");
        // ptr.d: `int delegate(int) nothrow d = 4;` -> `int delegate(int) nothrow` (hdrgen.d:4408)
        const dgFn = tfOf(params(new Parameter(Loc.initial, STC.none, Type.tint32, null, null, null)), Type.tint32,
            LINK.d, STC.nothrow_);
        expect(chars(typeToChars(new TypeDelegate(dgFn)))).toBe("int delegate(int) nothrow");
    });
});

// ---------------------------------------------------------------------------------------------
// PORT-GUARD for the wave-10 TARGETED FILL: the whole expression printer `expressionPrettyPrint`
// (hdrgen.d:2207, with `visitVarDecl` :2125 / `isSpecialCName` :2190), the remaining `typeToBufferx`
// arms (:4314), `initializerToBuffer` (:4220), and the public `toChars` family — `expressionToChars`
// (:204), `initializerToChars` (:212), `dsymbolToChars` (:231), `initializerToString` (:267),
// `initializerToCBuffer` (:3364) — plus `floatToBuffer` (:3172) and `visibilityToBuffer` (:3527).
//
// dmd/hdrgen.d has no `unittest {}` (10 §1: nothing to port 1:1). One pin per risky construct. The
// fixture builds the node the D diagnostic prints and calls the entry the D call site calls.
// PROVENANCE, per pin:
//   - ldc2 1.43.0 output (`ldc2 -c -o-` probes): every expression pin, printed through `int* p = <expr>;`
//     ("cannot implicitly convert expression `%s`") or a sibling diagnostic; every type pin, through
//     that line's "of type `%s`" or `pragma(msg, T)`; the initializers `{a:1, b:2}` and `[]` (initsem.d:65's
//     "invalid value" / "invalid associative array initializer" lines); the symbols `foo(T)`,
//     `bar!string` and `this`; the visibilities `private` and `package(q)` (dsymbolsem.d:6387's "does
//     not bind to one of ancestor packages" line).
//   - DERIVED from the D source, not printed by any ldc2 probe: the `expressionToChars` vs `toErrMsg`
//     contrast (hdrgen.d:204 vs :126-131), the `[1, 2:3]` and `void` initializers (ldc2 only ever
//     prints single elements of such a list), and `__anonymous` (hdrgen.d:264).
//
// NOT PINNED here, and why: a float literal's text (visitReal / visitComplex / floatToBuffer) is pinned
// against ldc2 at `CTFloat.sprint` itself (root/ctfloat.test.ts); the Ddoc legs (escapeDdocString under
// `hgs.ddoc`, hdrgen.d:2251/:2411/:2441) run through gendocfile in doc.test.ts and the corpus -D tests.
// The five `dsymbolToBuffer` call positions of the expression printer are pinned by the wave-13
// suite at the end of this file: visitScope (:2512), visitNewAnonClass (:2587),
// visitFunc (:2630) and visitDotTemplateInstance (:2852) inside its ldc2 `-H` hattr pin, the
// non-variable visitDeclaration (:2655) by a DERIVED pin; so are the `-vcg-ast` / `-H` module legs.

import { EnumDeclaration, EnumMember } from "./denum.js";
import { Dsymbol } from "./dsymbol.js";
import { Package } from "./dmodule.js";
import { VarDeclaration } from "./declaration.js";
import {
    AddAssignExp,
    AddExp,
    ArrayLengthExp,
    ArrayLiteralExp,
    AssignExp,
    CallExp,
    CastExp,
    CmpExp,
    CondExp,
    IndexExp,
    IntegerExp,
    LogicalExp,
    MulExp,
    NegExp,
    NotExp,
    OrExp,
    PostExp,
    ShlExp,
    SliceExp,
    TupleExp,
    TypeidExp,
    VarExp,
    XorExp,
} from "./expression.js";
import { ArrayInitializer, ExpInitializer, StructInitializer, VoidInitializer } from "./init.js";
import type { Initializer } from "./init.js";
import { TypeEnum, TypeNoreturn, TypeNull, TypeSArray, TypeTuple } from "./mtype.js";
import {
    dsymbolToChars,
    expressionToChars,
    initializerToChars,
    initializerToString,
    visibilityToBuffer,
} from "./hdrgen.js";

describe("hdrgen.d — the wave-10 expression / type / initializer printers (port-guard)", () => {
    beforeEach(() => {
        initTokens(); // also runs Identifier.initTable
        Id.initialize();
        Loc._init();
        Type_init();
        global.errorSink = new ErrorSinkNull();
        global.errors = 0;
    });

    const id = (s: string): Identifier => Identifier.idPool(ds(s));
    const int = (v: bigint, t: Type = Type.tint32): IntegerExp => new IntegerExp(Loc.initial, v, t);
    const local = (name: string, t: Type = Type.tint32): VarExp =>
        new VarExp(Loc.initial, new VarDeclaration(Loc.initial, t, id(name), null));
    /** The "cannot implicitly convert expression `%s`" operand: `toErrMsg` (hdrgen.d:126). */
    const msg = (e: Expression): string => chars(toErrMsg(e));

    test("visitInteger spells each literal for its type (hdrgen.d:2214-2318)", () => {
        expect(msg(int(0x61n, Type.tchar))).toBe("'a'");                   // Tchar, writeSingleCharLiteral
        expect(msg(int(5n, Type.tint64))).toBe("5L");                        // %lldL
        expect(msg(int(5n, Type.tuns64))).toBe("5LU");                       // %lluLU
        expect(msg(int(1n, Type.tbool))).toBe("true");
        expect(msg(int(3n, Type.tint8))).toBe("cast(byte)3");               // goto L2
        expect(msg(int(4n, Type.tuns16))).toBe("cast(ushort)4u");           // goto case Tuns32
        expect(msg(int(-1n))).toBe("-1");                                    // cast(int) of the ulong view
        // bug 23173: `long.min` has no literal spelling (hdrgen.d:2274)
        expect(msg(int(-0x8000_0000_0000_0000n, Type.tint64))).toBe("cast(long)-9223372036854775808");
        expect(msg(int(0xFFFF_FFFF_FFFF_FFFFn, Type.tuns64))).toBe("18446744073709551615LU");
    });

    test("visitInteger names an enum member, else casts and retries on the base type (goto L1)", () => {
        // probe: `enum E { a = 1, b = 2 }` -> `E.b`; `cast(E)7` -> `cast(E)7`
        const ed = new EnumDeclaration(Loc.initial, id("E"), Type.tint32);
        const te = new TypeEnum(ed);
        expect(msg(int(7n, te))).toBe("cast(E)7"); // no members: `cast(E)` then the Tint32 retry
        ed.members = new Array_<Dsymbol | null>();
        ed.members.push(new EnumMember(Loc.initial, id("a"), int(1n), null));
        ed.members.push(new EnumMember(Loc.initial, id("b"), int(2n), null));
        expect(msg(int(2n, te))).toBe("E.b");
    });

    test("operands are parenthesised by precedence, and a<b<c never chains (ldc2 probes, hdrgen.d:3889)", () => {
        const x = local("x");
        expect(msg(new AddExp(Loc.initial, x, new MulExp(Loc.initial, int(2n), x)))).toBe("x + 2 * x");
        expect(msg(new MulExp(Loc.initial, new AddExp(Loc.initial, x, int(2n)), x))).toBe("(x + 2) * x");
        // `&&` puts its right operand at PREC.or, which forces the `rel` operand into parens.
        const lt = new CmpExp(EXP.lessThan, Loc.initial, x, int(1n));
        const gt = new CmpExp(EXP.greaterThan, Loc.initial, x, int(2n));
        expect(msg(new LogicalExp(Loc.initial, EXP.andAnd, lt, gt))).toBe("x < 1 && (x > 2)");
        expect(msg(new OrExp(Loc.initial, new XorExp(Loc.initial, x, int(2n)), int(1n)))).toBe("x ^ 2 | 1");
        expect(msg(new ShlExp(Loc.initial, x, int(3n)))).toBe("x << 3");
        // probe: `(x += 2) ? x : -x` — the condition prints at PREC.oror, so an assignment is wrapped.
        const cond = new CondExp(Loc.initial, new AddAssignExp(Loc.initial, x, int(2n)), x, new NegExp(Loc.initial, x));
        expect(msg(cond)).toBe("(x += 2) ? x : -x");
        expect(msg(new AssignExp(Loc.initial, x, int(3n)))).toBe("x = 3");
    });

    test("unary, postfix, cast, index, slice and length forms (ldc2 probe)", () => {
        const x = local("x");
        const arr = local("arr", new TypeDArray(Type.tint32));
        expect(msg(new NotExp(Loc.initial, x))).toBe("!x");
        expect(msg(new PostExp(EXP.plusPlus, Loc.initial, x))).toBe("x++");
        expect(msg(new CastExp(Loc.initial, x, Type.tint64))).toBe("cast(long)x");
        expect(msg(new IndexExp(Loc.initial, arr, int(1n)))).toBe("arr[1]");
        expect(msg(new SliceExp(Loc.initial, arr, int(1n), int(2n)))).toBe("arr[1..2]");
        expect(msg(new ArrayLengthExp(Loc.initial, arr))).toBe("arr.length");
    });

    test("literals, calls, typeid and AliasSeq (ldc2 probes)", () => {
        const elems = new Array_<Expression | null>();
        elems.push(int(1n));
        elems.push(int(2n));
        expect(msg(new ArrayLiteralExp(Loc.initial, null, elems))).toBe("[1, 2]");
        expect(msg(new TypeidExp(Loc.initial, Type.tint32))).toBe("typeid(int)");
        // probe: `auto v = f();` -> "... is inferred from initializer `f()`"
        const fd = new FuncDeclaration(Loc.initial, Loc.initial, id("f"), STC.none,
            new TypeFunction(new ParameterList(null), Type.tvoid, LINK.d, STC.none));
        expect(msg(new CallExp(Loc.initial, new VarExp(Loc.initial, fd)))).toBe("f()");
        // probe: a parameter tuple -> `AliasSeq!(__param_0, __param_1)`
        const exps = new Array_<Expression | null>();
        exps.push(local("__param_0"));
        exps.push(local("__param_1", Type.tstring));
        expect(msg(new TupleExp(Loc.initial, null, exps))).toBe("AliasSeq!(__param_0, __param_1)");
    });

    test("expressionToChars is D's plain toChars: no errorMsg mode, no 60-char truncation (hdrgen.d:204)", () => {
        const x = local("x");
        let e: Expression = x;
        for (let i = 0; i < 20; i++)
            e = new AddExp(Loc.initial, e, x);
        const full = "x" + " + x".repeat(20); // 81 bytes
        expect(chars(expressionToChars(e))).toBe(full);
        expect(msg(e)).toBe(full.slice(0, 57) + "...");
    });

    test("the remaining typeToBufferx arms (ldc2 probes, hdrgen.d:4322-4558)", () => {
        expect(chars(typeToChars(new TypeAArray(Type.tint32, Type.tstring)))).toBe("int[string]");
        expect(chars(typeToChars(new TypeAArray(constOf(Type.tint32), Type.tstring)))).toBe("const(int)[string]");
        const sa = new TypeSArray(Type.tint32, int(3n, Type.tsize_t)); // a semantic'd dimension is size_t
        expect(chars(typeToChars(sa))).toBe("int[3]");
        expect(chars(typeToChars(new TypeDArray(sa)))).toBe("int[3][]");
        expect(chars(typeToChars(new TypeEnum(new EnumDeclaration(Loc.initial, id("E"), Type.tint32))))).toBe("E");
        expect(chars(typeToChars(new TypeNull()))).toBe("typeof(null)");
        expect(chars(typeToChars(new TypeNoreturn()))).toBe("noreturn");
        const ps = new Array_<Parameter | null>();
        ps.push(new Parameter(Loc.initial, STC.none, Type.tint32, null, null, null));
        ps.push(new Parameter(Loc.initial, STC.none, Type.tstring, null, null, null));
        expect(chars(typeToChars(new TypeTuple(ps)))).toBe("(int, string)");
    });

    test("initializerToChars / initializerToString over the four common kinds (hdrgen.d:4220)", () => {
        const ini = (i: Initializer): string => chars(initializerToChars(i));
        // probe: `S[int] bb = [1:{a:1, b:2}, {3}];` -> "invalid value `{a:1, b:2}` in initializer"
        const si = new StructInitializer(Loc.initial);
        si.addInit(id("a"), new ExpInitializer(Loc.initial, int(1n)));
        si.addInit(id("b"), new ExpInitializer(Loc.initial, int(2n)));
        expect(ini(si)).toBe("{a:1, b:2}");
        // probe: `int[int] cc = [];` -> "invalid associative array initializer `[]`, use `null` instead"
        expect(ini(new ArrayInitializer(Loc.initial))).toBe("[]");
        // DERIVED from hdrgen.d:4256-4272 (ldc2 prints only one element of such a list, e.g. "missing key
        // for value `1` in initializer" for `int[int] aa = [1, 2:3];`)
        const ai = new ArrayInitializer(Loc.initial);
        ai.addInit(null, new ExpInitializer(Loc.initial, int(1n)));
        ai.addInit(int(2n), new ExpInitializer(Loc.initial, int(3n)));
        expect(ini(ai)).toBe("[1, 2:3]");
        expect(ini(new VoidInitializer(Loc.initial))).toBe("void");
        // toString(Initializer) (hdrgen.d:267) is the same text as a slice, with no NUL terminator.
        expect(dsToJs(initializerToString(si))).toBe("{a:1, b:2}");
    });

    test("dsymbolToChars: template signature, instance, `toHChars2` name, `__anonymous` (hdrgen.d:231)", () => {
        const T = new TemplateTypeParameter(Loc.initial, id("T"), null, null);
        const tps = new Array_<TemplateParameter | null>();
        tps.push(T);
        const td = new TemplateDeclaration(Loc.initial, id("foo"), tps, null, null);
        expect(chars(dsymbolToChars(td))).toBe("foo(T)");
        const tiargs = new Array_<RootObject | null>();
        tiargs.push(Type.tstring);
        const ti = new TemplateInstance(Loc.initial, id("bar"), tiargs);
        expect(chars(dsymbolToChars(ti))).toBe("bar!string");
        const tfv = new TypeFunction(new ParameterList(null), Type.tvoid, LINK.d, STC.none);
        expect(chars(dsymbolToChars(new FuncDeclaration(Loc.initial, Loc.initial, Id.ctor!, STC.none, tfv))))
            .toBe("this");
        const anon = Dsymbol.create(id("x"));
        anon.ident = null; // an anonymous symbol (e.g. an unnamed union) has no identifier
        expect(chars(dsymbolToChars(anon))).toBe("__anonymous");
    });

    test("Dsymbol.toChars reaches dsymbolToChars through the slot this module fills (dsymbol.d:453)", () => {
        // hdrgen.ts ends with `registerDsymbolToChars(dsymbolToChars);` (01 §4.4 inversion), so the
        // method answers with this module's printer on the template arms too (hdrgen.d:237/:244).
        const T = new TemplateTypeParameter(Loc.initial, id("T"), null, null);
        const tps = new Array_<TemplateParameter | null>();
        tps.push(T);
        expect(chars(new TemplateDeclaration(Loc.initial, id("foo"), tps, null, null).toChars())).toBe("foo(T)");
        const tiargs = new Array_<RootObject | null>();
        tiargs.push(Type.tstring);
        expect(chars(new TemplateInstance(Loc.initial, id("bar"), tiargs).toChars())).toBe("bar!string");
    });

    test("visibilityToBuffer adds `(pkg)` only to a `package` visibility with a package (hdrgen.d:3527)", () => {
        const vis = (v: Visibility): string => {
            const buf = new OutBuffer();
            visibilityToBuffer(buf, v);
            return dsToJs(buf.extractSlice());
        };
        expect(vis(new Visibility(Visibility.Kind.private_))).toBe("private");
        // probe: `module a.b.m; package(q) int y;` -> "visibility attribute `package(q)` does not bind
        // to one of ancestor packages of module `a.b.m`" (hdrgen.d:3530-3534, `toPrettyChars(true)`)
        expect(vis(new Visibility(Visibility.Kind.package_, new Package(Loc.initial, id("q"))))).toBe("package(q)");
        expect(vis(new Visibility(Visibility.Kind.package_))).toBe("package"); // no pkg: no parens
    });
});

// ── wave 13: the statement / Dsymbol / condition printers (hdrgen.d:88, :195, :282-2062, :3299-3347) ──
//
// PROVENANCE. The whole-module pins are the byte-exact output of ldc2 1.43.0 on the source shown:
//   - `ldc2 -o- -H [--Hkeep-all-bodies] --Hf=<m>.di <m>.d`: `genhdrfile` (hdrgen.d:88) is the entry the
//     driver calls, BEFORE semantic (main.d:670-691), so the parse AST is exactly what ldc2 printed.
//     `--Hkeep-all-bodies` is `doFuncBodies` (`params.dihdr.fullOutput`, main.d:684).
//   - `ldc2 -c -o- -vcg-ast <m>.d`: `moduleToBuffer` (hdrgen.d:282, main.d:864) in full-dump mode, over a
//     module whose semantic pass changes nothing the printer shows (no struct -> no RTInfo instance,
//     no template instantiation, no `while`/`foreach`/`for`-init lowering, an explicit `import object;`),
//     so the parse AST prints what ldc2 printed after semantic.
// One source per risky area: statement bodies (hbody), header elision (hdecl), attributes /
// aggregates / templates / function literals (hattr), the module declaration (hmod), full-dump
// mode (vcg). The other pins quote one ldc2 diagnostic or are DERIVED from the D source, as each says.


import { Parser } from "./parse.js";
import { Module } from "./dmodule.js";
import { PASS } from "./dsymbol.js";
import { StructDeclaration } from "./dstruct.js";
import { TypeStruct } from "./mtype.js";
import { ExpStatement, PeelStatement } from "./statement.js";
import { DeclarationExp } from "./expression.js";
import { STMT } from "./astenums.js";
import type { FuncDeclaration as FuncDeclarationT } from "./func.js";
import { initSemaHarness } from "../sema-harness.js";
import {
    dsymbolToCBuffer,
    dsymbolToErrMsg,
    genhdrfile,
    moduleToBuffer,
    statementToCBuffer,
    statementToChars,
    TEST_EMIT_ALL,
} from "./hdrgen.js";

const SRC_HBODY = `module hbody;
import core.stdc.stdio : printf, puts = puts;
static import std_c = core.stdc.string;
int g = 3;
enum E : ubyte { a = 1, b }
alias IntArr = int[];
struct S { int x; void foo() const {} }
class C : Object { this() {} ~this() {} }
T tmax(T)(T a, T b) if (is(T : int)) { return a > b ? a : b; }
template Tp(int N) { enum Tp = N * 2; }
version (Posix) { int posixOnly; } else { int other; }
static if (is(int == int)) int si; else int sn;
debug int dbg;
int f(int x)
in (x > 0)
out (r; r >= 0)
{
    int y = x;
    if (y > 2)
        y = 2;
    else if (y < 0) { y = 0; }
    else
        y++;
    for (int i = 0; i < 3; i++) { y += i; }
    foreach (i; 0 .. 4) y += i;
    foreach (ref v, w; [1, 2]) { y += w; }
    while (y > 100) y--;
    do { y--; } while (y > 50);
    switch (y) {
        case 1: y = 3; break;
        case 2: .. case 4: goto default;
        default: break;
    }
    final switch (E.a) { case E.a: break; case E.b: break; }
    try { y = 1; } catch (Exception e) { y = 2; } finally { y = 3; }
    scope(exit) y = 4;
    L1: while (true) { continue L1; }
    synchronized { y = 5; }
    with (S()) { }
    return y;
}
unittest { assert(1); }
`;

const EXP_HBODY = `// D import file generated from 'hbody.d'
module hbody;
import core.stdc.stdio : printf, puts = puts;
static import std_c = core.stdc.string;
extern int g;
enum E : ubyte
{
\ta = 1,
\tb,
}
alias IntArr = int[];
struct S
{
\tint x;
\tvoid foo() const
\t{
\t}
}
class C : Object
{
\tthis()
\t{
\t}
\t~this()
\t{
\t}
}
T tmax(T)(T a, T b) if (is(T : int))
{
\treturn a > b ? a : b;
}
enum Tp(int N) = N * 2;
version (Posix)
{
\textern int posixOnly;
}
else
{
\textern int other;
}
static if (is(int == int))
{
\textern int si;
}
else
{
\textern int sn;
}
debug
{
\textern int dbg;
}
int f(int x)
in (x > 0)
out (r; r >= 0)
{
\tint y = x;
\tif (y > 2)
\t\ty = 2;
\telse if (y < 0)
\t{
\t\ty = 0;
\t}
\telse
\t\ty++;
\tfor (int i = 0;
\t i < 3; i++)
\t{
\t\t{
\t\t\ty += i;
\t\t}
\t}
\tforeach (i; 0 .. 4)
\t{
\t\ty += i;
\t}
\tforeach (ref v, w; [1, 2])
\t{
\t\ty += w;
\t}
\twhile (y > 100)
\ty--;
\tdo
\t{
\t\ty--;
\t}
\twhile (y > 50);
\tswitch (y)
\t{
\t\tcase 1:
\t\t{
\t\t\ty = 3;
\t\t\tbreak;
\t\t}
\t\tcase 2: .. case 4:
\t\t{
\t\t\tgoto default;
\t\t}
\t\tdefault:
\t\t{
\t\t\tbreak;
\t\t}
\t}
\tfinal switch (E.a)
\t{
\t\tcase E.a:
\t\t{
\t\t\tbreak;
\t\t}
\t\tcase E.b:
\t\t{
\t\t\tbreak;
\t\t}
\t}
\ttry
\t{
\t\ttry
\t\t{
\t\t\ty = 1;
\t\t}
\t\tcatch(Exception e)
\t\t{
\t\t\ty = 2;
\t\t}
\t}
\tfinally
\t{
\t\ty = 3;
\t}
\tscope(exit) y = 4;
\tL1:
\twhile (true)
\t{
\t\tcontinue L1;
\t}
\tsynchronized {
\t\ty = 5;
\t}
\twith (S())
\t{
\t}
\treturn y;
}
`;

const SRC_HDECL = `module hdecl;
int g = 1;
int f(int x) { return x; }
auto a() { return 1; }
T t(T)(T v) { return v; }
struct S { int m() { return 1; } static int s; void n(); }
class C { this() { } ~this() {} int k() in (true) out(r; r > 0) { return 1; } }
void nested() { int inner() { return 2; } }
`;

const EXP_HDECL = `// D import file generated from 'hdecl.d'
module hdecl;
extern int g;
int f(int x);
auto a()
{
\treturn 1;
}
T t(T)(T v)
{
\treturn v;
}
struct S
{
\tint m();
\tstatic int s;
\tvoid n();
}
class C
{
\tthis();
\t~this();
\tint k();
}
void nested();
`;

const SRC_HATTR = `module hattr;
version = MyVer;
debug = MyDbg;
public:
private int priv;
package int pk;
extern (C) int cfun(int);
extern (C++, class) struct CppS { int a; }
extern (C++, ns1) { void inns(); }
align(4) struct Al { align(8) int a; byte b; }
align struct Al2 { int q; }
deprecated("old") int dep;
deprecated void depf() {}
pragma(inline, true) int inl(int x) { return x; }
pragma(msg, "hi");
@(1, "two") int uda;
@nogc nothrow pure @safe int attrs() { return 1; }
static foreach (i; 0 .. 2) { mixin("int sf", i, ";"); }
static foreach (x; [1, 2]) {}
mixin("int mx;");
union U { int i; float f; }
struct B { int a : 3; int : 5; uint c : 2; }
struct W { struct { int x; int y; } union { long l; double d; } }
mixin template MT(T) { T mtv; }
mixin MT!int;
mixin MT!(long) named;
class K { int v; alias v this; invariant (v >= 0); invariant { assert(v < 10); } }
struct P { this(this) {} int q; }
static this() { }
shared static this() { }
static ~this() { }
shared static ~this() { }
interface I { void im(); int ic() in (true); }
abstract class AC : I { abstract void am(); void im() {} int ic() { return 0; } }
auto autof() { return 3; }
ref int reff(ref int a) { return a; }
const(int)* cptr;
immutable int[3] sarr = [1, 2, 3];
int[string] aa;
int function(int) fp;
int delegate(int) dg;
alias F = int function(int);
alias FD = int delegate();
alias Seq(T...) = T;
alias sym = cfun;
enum { A1, A2 = 5 }
enum En2;
enum int manifest = 42;
static assert(manifest == 42);
static assert(1 == 1, "m", 2);
@safe unittest {}
template TT(T) { alias TT = T; }
struct TS(T) if (is(T)) { T t; }
class TC(T) : Object {}
T[] tf(T)(T[] a...) { return a; }
T id1(T)(T a) { return a; }
void lit() {
    auto l = (int a) => a + 1;
    auto d = delegate int(int b) { return b; };
    auto f = function(int c) { return c; };
    int[] arr = [1, 2];
    auto ti = TT!int.init;
    auto dti = 1.id1!int;
    auto ac = new class Object { int q; };
    foreach_reverse (e; arr) {}
    foreach (i, ref e; arr) { e = cast(int) i; }
    static foreach (k; 0 .. 2) { }
    version (Posix) { int vp; } else { int vo; }
    debug { int dd; }
    debug (MyDbg) int dm;
    static if (true) int st;
    static assert(true);
    static assert(true, "x");
    import core.stdc.stdio;
    goto L2;
    L2:
    switch (arr.length) { case 0: goto case; case 1: goto case 0; default: }
    pragma(msg, "x");
    pragma(inline, false);
    { int scoped; }
    scope(failure) {}
    scope(success) arr = null;
    int x, y = 2, z;
    mixin("int mm;");
    throw new Exception("e");
}
`;

const EXP_HATTR = `// D import file generated from 'hattr.d'
module hattr;
version = MyVer;
debug = MyDbg;
public
{
\tprivate extern int priv;
\tpackage extern int pk;
\textern (C) int cfun(int);
\textern (C++, class) struct CppS
\t{
\t\tint a;
\t}
\textern (C++, ns1)
\t{
\t\tvoid inns();
\t}
\talign (4) struct Al
\t{
\t\talign (8) int a;
\t\tbyte b;
\t}
\talign struct Al2
\t{
\t\tint q;
\t}
\tdeprecated("old") deprecated extern int dep;
\tdeprecated void depf()
\t{
\t}
\tpragma (inline, true)int inl(int x)
\t{
\t\treturn x;
\t}
\tpragma (msg, "hi");
\t@(1, "two")extern int uda;
\tpure nothrow @nogc @safe int attrs()
\t{
\t\treturn 1;
\t}
\tstatic foreach (i; 0 .. 2)
\t{
\t\tmixin("int sf", i, ";");
\t}
\tstatic foreach (x; [1, 2])
\t{
\t\t{}
\t}
\tmixin("int mx;");
\tunion U
\t{
\t\tint i;
\t\tfloat f;
\t}
\tstruct B
\t{
\t\tint a : 3;
\t\tint : 5;
\t\tuint c : 2;
\t}
\tstruct W
\t{
\t\tstruct
\t\t{
\t\t\tint x;
\t\t\tint y;
\t\t}
\t\tunion
\t\t{
\t\t\tlong l;
\t\t\tdouble d;
\t\t}
\t}
\ttemplate MT(T)
\t{
\t\tT mtv;
\t}
\tmixin MT!int;
\tmixin MT!long named;
\tclass K
\t{
\t\tint v;
\t\talias v this;
}
\tstruct P
\t{
\t\tthis(this)
\t\t{
\t\t}
\t\tint q;
\t}
\tstatic this();
\tshared static this();
\tstatic ~this();
\tshared static ~this();
\tinterface I
\t{
\t\tvoid im();
\t\tint ic()
\t\tin (true)
\t\t;
\t}
\tabstract class AC : I
\t{
\t\tabstract void am();
\t\tvoid im()
\t\t{
\t\t}
\t\tint ic()
\t\t{
\t\t\treturn 0;
\t\t}
\t}
\tauto autof()
\t{
\t\treturn 3;
\t}
\tref int reff(ref int a)
\t{
\t\treturn a;
\t}
\textern const(int)* cptr;
\textern immutable int[3] sarr;
\textern int[string] aa;
\textern int function(int) fp;
\textern int delegate(int) dg;
\talias F = int function(int);
\talias FD = int delegate();
\ttemplate Seq(T...)
\t{
\t\talias Seq = T;
\t}
\talias sym = cfun;
\tenum
\t{
\t\tA1,
\t\tA2 = 5,
\t}
\tenum En2;
\tenum int manifest = 42;
\tstatic assert(manifest == 42);
\tstatic assert(1 == 1, "m", 2);
\ttemplate TT(T)
\t{
\t\talias TT = T;
\t}
\tstruct TS(T) if (is(T))
\t{
\t\tT t;
\t}
\tclass TC(T) : Object
\t{
\t}
\tT[] tf(T)(T[] a...)
\t{
\t\treturn a;
\t}
\tT id1(T)(T a)
\t{
\t\treturn a;
\t}
\tvoid lit()
\t{
\t\tauto l = (int a) => a + 1;
\t\tauto d = delegate int(int b)
\t\t{
\t\t\treturn b;
\t\t}
\t\t;
\t\tauto f = function (int c)
\t\t{
\t\t\treturn c;
\t\t}
\t\t;
\t\tint[] arr = [1, 2];
\t\tauto ti = TT!int.init;
\t\tauto dti = 1.id1!int;
\t\tauto ac = new class Object
\t\t{
\t\t\tint q;
\t\t}
\t\t;
\t\tforeach_reverse (e; arr)
\t\t{
\t\t}
\t\tforeach (i, ref e; arr)
\t\t{
\t\t\te = cast(int)i;
\t\t}
\t\tstatic foreach (k; 0 .. 2)
\t\t{
\t\t}
\t\tversion (Posix)
\t\t{
\t\t\tint vp;
\t\t}
\t\telse
\t\t{
\t\t\tint vo;
\t\t}
\t\tdebug
\t\t{
\t\t\tint dd;
\t\t}

\t\tdebug (MyDbg)
\t\t{
\t\t\tint dm;
\t\t}

\t\tstatic if (true)
\t\t{
\t\t\tint st;
\t\t}

\t\tstatic assert(true);
\t\tstatic assert(true, "x");
\t\timport core.stdc.stdio;
\t\tgoto L2;
\t\tL2:
\t\tswitch (arr.length)
\t\t{
\t\t\tcase 0:
\t\t\t{
\t\t\t\tgoto case;
\t\t\t}
\t\t\tcase 1:
\t\t\t{
\t\t\t\tgoto case 0;
\t\t\t}
\t\t\tdefault:
\t\t\t{
\t\t\t}
\t\t}
\t\tpragma (msg, "x");
\t\tpragma (inline, false);
\t\t{
\t\t\tint scoped;
\t\t}
\t\tscope(failure) {
\t\t}
\t\tscope(success) arr = null;
\t\tint x, y = 2, z;
\t\tmixin("int mm;");
\t\tthrow new Exception("e");
\t}
}
`;

const SRC_HMOD = `@(1, "u") deprecated("gone") module hmod;
int x;
`;

const EXP_HMOD = `// D import file generated from 'hmod.d'
@(1, "u")
deprecated("gone") module hmod;
extern int x;
`;

const SRC_VCG = `module vcg;
import object;
int g = 3;
alias IA = int[];
version (Posix) int vp; else int vo;
static if (is(int == int)) int si;
debug (Dbg) int dg;
T tmax(T)(T a, T b) if (is(T : long)) { return a > b ? a : b; }
int f(int x)
{
    int y = x;
    if (y > 2)
        y = 2;
    else if (y < 0)
        y = 0;
    else
        y++;
    do { y--; } while (y > 50);
    {
        int i = 0;
        for (; i < 3; i++)
            y += i;
    }
    switch (y)
    {
        case 1: y = 3; break;
        default: break;
    }
    return y;
}
`;

const EXP_VCG = `module vcg;
import object;
int g = 3;
alias IA = int[];
version (Posix)
{
\tint vp;
}
else
{
\tint vo;
}
static if (is(int == int))
{
\tint si;
}
debug (Dbg)
{
\tint dg;
}
T tmax(T)(T a, T b) if (is(T : long))
{
\treturn a > b ? a : b;
}
int f(int x)
{
\tint y = x;
\tif (y > 2)
\t\ty = 2;
\telse if (y < 0)
\t\ty = 0;
\telse
\t\ty++;
\tdo
\t{
\t\ty--;
\t}
\twhile (y > 50);
\t{
\t\tint i = 0;
\t\tfor (; i < 3; i++)
\t\t{
\t\t\ty += i;
\t\t}
\t}
\tswitch (y)
\t{
\t\tcase 1:
\t\t{
\t\t\ty = 3;
\t\t\tbreak;
\t\t}
\t\tdefault:
\t\t{
\t\t\tbreak;
\t\t}
\t}
\treturn y;
}
`;

describe("hdrgen.d — the wave-13 statement / Dsymbol / condition printers (ldc2 -H / -vcg-ast pins)", () => {
    beforeEach(() => {
        initSemaHarness();
    });

    /**
     * Parse `src` as the file `<name>.d` the way the driver does before `-H` (dmodule.d:822-837: the
     * members, `md`, and the module ident from `md`). The parser needs its Module: a `@(…) module`
     * declaration stores its UDAs on it (parse.d `parseModuleAttributes`). The module is a ROOT
     * (`importedFrom = m`, as the driver's command-line modules are) and `doUnittests` is D's
     * `global.params.parsingUnittestsRequired()` (dmodule.d:818), true under `-H` (globals.d:361),
     * so the parser keeps `unittest` blocks exactly as ldc2 does (parse.d:528's
     * `doUnittests && mod.isRoot()`).
     */
    const parseModule = (name: string, src: string): Module => {
        const input = new Uint8Array(src.length + 1); // NUL-terminated, as the lexer expects
        for (let i = 0; i < src.length; i++) input[i] = src.charCodeAt(i) & 0xff;
        const m = new Module(Loc.initial, ds(name + ".d"), null, 0, 0);
        m.importedFrom = m;
        const p = new Parser(null, m, input, false, new ErrorSinkNull(), null, true);
        p.nextToken();
        m.members = p.parseModule();
        m.md = p.md;
        if (p.md) m.ident = p.md.id;
        return m;
    };
    /** `ldc2 -H` (`doFuncBodies` = `--Hkeep-all-bodies`): genhdrfile over the parsed module. */
    const header = (name: string, src: string, doFuncBodies: boolean): string => {
        const buf = new OutBuffer();
        genhdrfile(parseModule(name, src), doFuncBodies, buf);
        return dsToJs(buf.extractSlice());
    };
    /** `ldc2 -vcg-ast` (main.d:861-864): tab indentation on, then moduleToBuffer in codegen-AST mode. */
    const vcgAst = (name: string, src: string): string => {
        const buf = new OutBuffer();
        buf.doindent = true;
        moduleToBuffer(buf, true, parseModule(name, src));
        return dsToJs(buf.extractSlice());
    };
    /** The one member of a parsed `auto <v> = <function literal>;` — the literal's declaration. */
    const literalOf = (src: string): FuncDeclarationT => {
        const vd = parseModule("lit", src).members!.opIndex(0)!.isVarDeclaration()!;
        return vd._init!.isExpInitializer()!.exp!.isFuncExp()!.fd!;
    };

    test("-H --Hkeep-all-bodies: every statement form a function body prints (hdrgen.d:324-973)", () => {
        // Includes the `for (int i = 0;\n i < 3; …)` quirk: the init is a declaration, printed through
        // the Dsymbol printer, whose `;` + newline ignores `forStmtInit` (hdrgen.d:344 vs :350), and the
        // parser's case-body scopes, `try`/`catch` nested in `try`/`finally`, contracts (hdrgen.d:1351).
        expect(header("hbody", SRC_HBODY, true)).toBe(EXP_HBODY);
    });

    test("-H: header elision — extern variables, `;` bodies, auto/template bodies kept (hdrgen.d:1815-1855)", () => {
        expect(header("hdecl", SRC_HDECL, false)).toBe(EXP_HDECL);
    });

    test("-H --Hkeep-all-bodies: attributes, aggregates, templates, literals, conditions (hdrgen.d:980-2062)", () => {
        // The attribute printer's quirks included: `alias v this;` ends in a raw `\n` (hdrgen.d:1072), so
        // the class's `}` is not indented; `pragma (inline, true)int` has no space (hdrgen.d:1216); a
        // nested `private` goes through the attribute printer, not the visibility one (hdrgen.d:1162).
        // `static assert` with messages prints them (hdrgen.d:992-999); `@safe unittest {}` prints
        // nothing in a header (hdrgen.d:1978). Inside `lit()`, the expression printer's Dsymbol-printer
        // calls: `TT!int` (visitScope, :2512), `1.id1!int` (visitDotTemplateInstance, :2852),
        // `new class Object {…}` (visitNewAnonClass, :2587) and the function literals (visitFunc, :2630).
        expect(header("hattr", SRC_HATTR, true)).toBe(EXP_HATTR);
    });

    test("-H: the module declaration with UDAs and `deprecated(msg)` (moduleToBuffer2, hdrgen.d:290-316)", () => {
        expect(header("hmod", SRC_HMOD, false)).toBe(EXP_HMOD);
    });

    test("-vcg-ast: full-dump mode prints bodies, no `extern`, the eponymous template form (hdrgen.d:282)", () => {
        expect(vcgAst("vcg", SRC_VCG)).toBe(EXP_VCG);
    });

    test("-vcg-ast: a template instance dumps its aliasdecl, then a blank line (hdrgen.d:1588, :3958)", () => {
        // ldc2 -vcg-ast on `struct S {}`: the RTInfo instance appended to the module prints as below.
        // Built by hand: the instance `RTInfo!(S)` whose one member (and aliasdecl) is the parsed
        // `enum immutable(void)* RTInfo = null;`.
        const rt = parseModule("rt", "enum immutable(void)* RTInfo = null;").members!.opIndex(0)!;
        const tiargs = new Array_<RootObject | null>();
        tiargs.push(new TypeStruct(new StructDeclaration(Loc.initial, Identifier.idPool(ds("S")), false)));
        const ti = new TemplateInstance(Loc.initial, Identifier.idPool(ds("RTInfo")), tiargs);
        ti.members = new Array_<Dsymbol | null>();
        ti.members.push(rt);
        ti.aliasdecl = rt;
        const hgs = new HdrGenState();
        hgs.fullDump = true;
        hgs.vcg_ast = true;
        const buf = new OutBuffer();
        buf.doindent = true;
        dsymbolToCBuffer(ti, buf, hgs);
        expect(dsToJs(buf.extractSlice())).toBe("RTInfo!(S)\n{\n\tenum immutable(void)* RTInfo = null;\n\n}\n");
    });

    test("dsymbolToErrMsg prints a compiler-named function literal in errorMsg mode (hdrgen.d:138-150, :1857)", () => {
        // probe e1.d:3 `(int a) { return a + x; }();` -> "function literal `(int a) => a + x` is not
        // callable using argument types `()`". The post-semantic state the message sees is set by hand:
        // the `__lambda…` name (dsymbolToErrMsg's `__` gate, hdrgen.d:142) and `semantic3done`, which
        // makes the last body statement the `=>` candidate (hdrgen.d:1887). No keyword, no attributes.
        const fd = literalOf("auto g = (int a) { return a + x; };");
        fd.ident = Identifier.idPool(ds("__lambda_L3_C5"));
        fd.semanticRun = PASS.semantic3done;
        expect(chars(dsymbolToErrMsg(fd))).toBe("(int a) => a + x");
        // DERIVED: a body printed in full is flattened to one line and cut at 80 (hdrgen.d:148).
        const long = literalOf("auto h = () { int aaaaaaaaaa; int bbbbbbbbbb; int cccccccccc; "
            + "int dddddddddd; int eeeeeeeeee; };");
        long.ident = Identifier.idPool(ds("__lambda_L4_C10"));
        expect(chars(dsymbolToErrMsg(long)))
            .toBe("() { int aaaaaaaaaa; int bbbbbbbbbb; int cccccccccc; int dddddddddd; int eeee...");
    });

    test("a non-variable DeclarationExp prints through the Dsymbol printer (visitDeclaration, hdrgen.d:2655)", () => {
        // DERIVED: D reaches this only when printing a DeclarationExp directly (hdrgen.d:2636-2638); a
        // struct with no members is `struct S;` plus the Dsymbol printer's newline (hdrgen.d:1699-1702).
        const sd = new StructDeclaration(Loc.initial, Identifier.idPool(ds("S")), false);
        expect(chars(expressionToChars(new DeclarationExp(Loc.initial, sd)))).toBe("struct S;\n");
    });

    test("statementToChars: default mode, NUL-terminated by its own `put(0)` (hdrgen.d:195-201)", () => {
        // DERIVED: no header / dump flags and no `doindent`, so no tabs.
        const fd = parseModule("sc", "void f() { if (a) b(); }").members!.opIndex(0)!.isFuncDeclaration()!;
        const text = statementToChars(fd.fbody!);
        expect(text[text.length - 1]).toBe(0);
        expect(dsToJs(text.subarray(0, text.length - 1))).toBe("if (a)\nb();\n");
    });

    test("a Peel statement routes to visitDefaultCase: stdout line, then D's assert (hdrgen.d:326-330)", () => {
        // DERIVED: the VisitStatement dispatch (statement.d:1981) finds no `visitPeel` in
        // statementToBuffer, so `STMT.Peel` (= 1, astenums.d:350) takes visitDefaultCase.
        const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        try {
            const peel = new PeelStatement(new ExpStatement(Loc.initial, null));
            expect(() => statementToCBuffer(peel, new OutBuffer(), new HdrGenState()))
                .toThrow("unrecognized statement in statementToBuffer()");
            expect(STMT.Peel).toBe(1);
            expect(write).toHaveBeenCalledWith("Statement::toCBuffer() 1\n");
        } finally {
            write.mockRestore();
        }
    });

    test("paired state: a throw deep inside leaves buf.level and every hgs counter restored (11 §2.5)", () => {
        // D has no exit there; the throw is injected at `CTFloat.sprint`, reached by a float literal
        // (visitReal -> floatToBuffer, hdrgen.d:3180). At the throw the template, struct and function-body
        // regions are open, `forStmtInit` is up, `tpltMember` is saved-and-zeroed.
        const m = parseModule("ps",
            "template T(X) { struct S { int f() { for (double d = 2.5; ; ) { } return 0; } } }\nenum E { a = 1.5 }");
        const hgs = new HdrGenState();
        hgs.hdrgen = true;
        hgs.doFuncBodies = true;
        const buf = new OutBuffer();
        buf.doindent = true;
        for (let i = 0; i < m.members!.length; i++) {
            withSprintThrowing(() =>
                expect(() => dsymbolToCBuffer(m.members!.opIndex(i)!, buf, hgs)).toThrow(SPRINT_THROW));
            expect(buf.level).toBe(0);
            expect(hgs.tpltMember).toBe(0);
            expect(hgs.autoMember).toBe(0);
            expect(hgs.insideFuncBody).toBe(0);
            expect(hgs.insideAggregate).toBe(0);
            expect(hgs.forStmtInit).toBe(0);
            expect(hgs.inEnumDecl).toBeNull();
        }
    });

    test("TEST_EMIT_ALL is D's 0 (hdrgen.d:79)", () => {
        expect(TEST_EMIT_ALL).toBe(0);
    });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("hdrgen.d — contractsToBuffer after semantic3 (ldmd2 -vcg-ast pin, the 11 §2.6 divergence)", () => {
    // ORACLE: `ldmd2 -c -o- -vcg-ast -checkaction=context contractpin.d` (ldc2 1.43.0) on SRC below; the
    // expected text is its .cg byte for byte up to the first template-instance dump. WHY the cut: the rest of the
    // file (4613 bytes in all, identical to ldmd2's when this pin was written) is druntime's core.internal.dassert
    // source re-printed by the instance printer, which the Phobos and corpus runners compare whole-file; this pin
    // isolates what contractsToBuffer writes, so a druntime-side change cannot redden it. The contracts cover
    // every shape the statement can hold: an AssertExp with a message (no lowering), a CommaExp over one
    // temporary, a CommaExp whose `e1` is itself the CommaExp of two temporaries, and the `out` legs with and
    // without an identifier. hdrgen.d:1362's assert fails on all but the second; ldc2's release build prints
    // `CommaExp.e1` there, and so does the port.
    const SRC = "module contractpin;\nbool g(int x) { return x > 0; }\nint f(int x)\nin (g(x))\n"
        + "in (g(x) == g(x + 1), \"m\")\nin (g(x) != g(x + 1))\nout (r; g(r))\nout (; g(x))\n{\n    return x + 1;\n}\n";
    const EXPECTED = "module contractpin;\nimport object;\nbool g(int x)\n{\n\treturn x > 0;\n}\nint f(int x)\n"
        + "in ((bool __assertOp3 = g(x);))\n"
        + "in (cast(int)g(x) == cast(int)g(x + 1))\n"
        + "in ((bool __assertOp9 = g(x);) , ((bool __assertOp10 = g(x + 1);)))\n"
        + "out (r; (bool __assertOp17 = g(r);))\n"
        + "out (; (bool __assertOp18 = g(x);))\n"
        + "{\n\t{\n\t\t(bool __assertOp3 = g(x);) , assert(__assertOp3, _d_assert_fail(\"\", __assertOp3));\n\t}\n"
        + "\t{\n\t\tassert(cast(int)g(x) == cast(int)g(x + 1), \"m\");\n\t}\n"
        + "\t{\n\t\t(bool __assertOp9 = g(x);) , ((bool __assertOp10 = g(x + 1);)) , "
        + "assert(cast(int)__assertOp9 != cast(int)__assertOp10, _d_assert_fail(\"!=\", __assertOp9, __assertOp10));\n"
        + "\t}\n\t__result = x + 1 , __result;\n\tgoto __returnLabel;\n\t__returnLabel:\n"
        + "\t{\n\t\tref const const(int) r = __result;\n"
        + "\t\t(bool __assertOp17 = g(r);) , assert(__assertOp17, _d_assert_fail(\"\", __assertOp17));\n\t}\n"
        + "\t(bool __assertOp18 = g(x);) , assert(__assertOp18, _d_assert_fail(\"\", __assertOp18));\n"
        + "\treturn __result;\n}\n";

    test("-checkaction=context: a lowered contract prints the lowering's CommaExp.e1, as ldc2 does", async () => {
        const dir = mkdtempSync(join(tmpdir(), "djs-contract-"));
        const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        const ewrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            const file = join(dir, "contractpin.d");
            writeFileSync(file, SRC);
            // A fresh module registry, as a new ldmd2 process starts from load-time globals (djs.test.ts).
            vi.resetModules();
            const { djsMain } = await import("../djs.js");
            expect(djsMain(["-c", "-o-", "-vcg-ast", "-checkaction=context", file])).toBe(0);
            expect(write).not.toHaveBeenCalled();
            expect(ewrite).not.toHaveBeenCalled();
            const cg = readFileSync(`${file}.cg`, "utf8");
            const cut = cg.indexOf("_d_assert_fail!bool\n");
            expect(cut).toBeGreaterThan(0);
            expect(cg.slice(0, cut)).toBe(EXPECTED);
        } finally {
            write.mockRestore();
            ewrite.mockRestore();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ── hdrgen.d:4498-4526 visitTag over the TypeTag shadow-split slot (02 §11.5b) ──────────────────
// visitTag reads TypeTag's own `mod` (mtype.d:2145, `modTag` in the port); visitWithMask (hdrgen.d:3924)
// reads Type.mod of the same object first. A parsed `const struct S` carries const in TypeTag's slot only
// (cparse.d:4943), so ldc2's `-H` prints `const(S)` (probe tag1.c: `extern __gshared const(S) cs;`). With
// the two slots merged, both printers fired and the header read `const(const(S))`. The ImportC-header
// strings are ldc2 1.43.0 `-H` output (probes tag1.c, tag4.c); the non-header D forms (`const struct S`,
// `const(struct S)`, `const enum E : short`) are read off hdrgen.d:3924-3953 and :4514-4525, since no ldc2
// output prints an unresolved tag outside a header.
import { TypeTag } from "./mtype.js";
import { structalign_t } from "./astenums.js";
import { typeToCBuffer } from "./hdrgen.js";

describe("hdrgen.d:4498 visitTag — reads TypeTag's own mod slot", () => {
    beforeEach(() => {
        initTokens(); // also runs Identifier.initTable
        Id.initialize();
        Loc._init();
        Type_init();
        global.errorSink = new ErrorSinkNull();
        global.errors = 0;
    });

    /** A tag as cparse.d:4097/:3992 builds it, with const ORed in as toConst does (cparse.d:4943). */
    const constTag = (tok: TOK, name: string, base: Type | null = null): TypeTag => {
        const tt = new TypeTag(Loc.initial, tok, Identifier.idPool(ds(name)), new structalign_t(), null, base, null);
        tt.modTag |= MODFlags.const_;
        return tt;
    };
    const print = (t: Type, importcHdr: boolean): string => {
        const hgs = new HdrGenState();
        hgs.importcHdr = importcHdr;
        const buf = new OutBuffer();
        typeToCBuffer(t, buf, null, hgs);
        return dsToJs(buf.extractSlice());
    };

    test("ImportC header: a const tag prints `const(S)` once (hdrgen.d:4504-4511)", () => {
        expect(print(constTag(TOK.struct_, "S"), true)).toBe("const(S)");
        expect(print(constTag(TOK.union_, "U"), true)).toBe("const(U)");
    });

    test("ImportC header: a pointer to a const tag prints `const(S)*` (tag1.c `cp`)", () => {
        expect(print(new TypePointer(constTag(TOK.struct_, "S")), true)).toBe("const(S)*");
    });

    test("Type.mod alone is printed by visitWithMask, not by visitTag", () => {
        const tt = new TypeTag(Loc.initial, TOK.struct_, Identifier.idPool(ds("S")), new structalign_t(), null, null,
            null);
        tt.mod = MODFlags.const_;
        expect(print(tt, true)).toBe("const(S)");
        expect(print(tt, false)).toBe("const(struct S)");
    });

    test("D form: `const enum E : short`, the base printed under TypeTag's mod as mask (hdrgen.d:4515-4524)", () => {
        expect(print(constTag(TOK.struct_, "S"), false)).toBe("const struct S");
        expect(print(constTag(TOK.enum_, "E", Type.tint16), false)).toBe("const enum E : short");
    });
});
