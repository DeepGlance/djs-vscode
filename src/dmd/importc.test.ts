// Co-located tests for src/dmd/importc.ts (dmd/importc.d).
//
// importc.d has no `unittest` block, so these are 10 §1.6b behaviour pins, one `test()` per concern. They are
// unit pins: each builds the node the function receives, by hand or through the D parser plus `runSemantic`, and
// calls the function with a Scope whose `inCfile` is set. A C source driven end to end through the shim is measured
// by the corpus runner's `.c`/`.i` tests. Expected texts and verdicts come from ldc2 1.43.0 (arm64-apple-darwin) on
// preprocessed C (`ldc2 -c -o- x.i`); each pin quotes its probe.

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
    addDefaultCInitializer, arrayFuncConv, cAdjustParamType, carraySemantic, cEnumSemantic, cFuncEquivalence,
    cTypeEquivalence, fieldLookup, handleSymbolRedeclarations, handleTagSymbols,
} from "./importc.js";
import { AliasDeclaration, VarDeclaration } from "./declaration.js";
import { Module, moduleFromParse } from "./dmodule.js";
import { DsymbolTable, PASS } from "./dsymbol.js";
import type { Dsymbol, ScopeDsymbol } from "./dsymbol.js";
import { EnumDeclaration, EnumMember } from "./denum.js";
import { StructDeclaration, UnionDeclaration } from "./dstruct.js";
import { FuncDeclaration } from "./func.js";
import { Scope } from "./dscope.js";
import { ExpInitializer, VoidInitializer } from "./init.js";
import { Identifier } from "./identifier.js";
import { ArrayExp, IntegerExp } from "./expression.js";
import type { Expression } from "./expression.js";
import { ExpStatement } from "./statement.js";
import { Loc } from "./location.js";
import { LINK, STC, TY, VarArg } from "./astenums.js";
import { Parameter, ParameterList, Type, TypeFunction } from "./mtype.js";
import { global } from "./globals.js";
import { setDiagnosticHandler } from "./errors.js";
import { ErrorSinkNull } from "./errorsink.js";
import { Parser } from "./parse.js";
import { arrayOf, constOf, nextOf, pointerTo, sarrayOf } from "./typesem.js";
import { runSemantic, scopeCreateGlobal } from "./dsymbolsem.js";
import { expressionSemantic } from "./expressionsem.js";
import { dmdformat } from "./root/dmdformat.js";
import { Array as DArray } from "./root/array.js";
import { initSemaHarness } from "../sema-harness.js";
import { ds, dsToJs } from "../dstring.js";

const loc = Loc.initial;
let diags: string[] = [];

beforeEach(() => {
    initSemaHarness();
    diags = [];
    setDiagnosticHandler((_loc, _color, header, messageFormat, args) => {
        diags.push(dsToJs(header) + dsToJs(dmdformat(messageFormat, [...args])));
        return true;
    });
});

afterEach(() => {
    setDiagnosticHandler(null);
});

function id(name: string): Identifier {
    return Identifier.idPool(ds(name));
}

/** A module named `name` with an empty symbol table, and a Scope over it with `inCfile` set. `sds` is the module
 *  as the `ScopeDsymbol` symbol table the handlers take: an audited upcast cascade (02 §11.5), `Module.errors`
 *  (`uint`) shadows `Dsymbol.errors` (`bool`), so Module is not a nominal subtype in TS though it is one in D. */
function cScope(name = "r"): { sc: Scope; m: Module; sds: ScopeDsymbol } {
    const m = new Module(loc, ds(name + ".i"), id(name), 0, 0);
    m.members = new DArray<Dsymbol | null>();
    m.symtab = new DsymbolTable();
    const sc = Scope.alloc();
    sc._module = m;
    sc.inCfile = true;
    return { sc, m, sds: m as unknown as ScopeDsymbol };
}

/** A tag declaration; `defined` gives it a (possibly empty) member list, as a definition `{ ... }` has. */
function struct_(name: string, defined: boolean): StructDeclaration {
    const sd = new StructDeclaration(loc, id(name), false);
    sd.members = defined ? new DArray<Dsymbol | null>() : null;
    return sd;
}

function srcBuf(s: string): Uint8Array {
    const b = new Uint8Array(s.length + 1);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    b[s.length] = 0;
    return b;
}

function parseExp(src: string): Expression {
    const p = new Parser(null, null, srcBuf(src), false, new ErrorSinkNull(), null, false);
    p.nextToken();
    return p.parseExpression();
}

/** `src` parsed and run through passes 0-3 as D, plus a global Scope over it with `inCfile` set. */
function semaScope(src: string): Scope {
    const p = new Parser(null, null, srcBuf(src), false, new ErrorSinkNull(), null, false);
    p.nextToken();
    const m = moduleFromParse(p.parseModule(), p.md);
    runSemantic(m);
    expect(global.errors).toBe(0);
    const sc = scopeCreateGlobal(m, global.errorSink!);
    sc.inCfile = true;
    return sc;
}

function fn(ret: Type, params: Type[], varargs = VarArg.none, linkage = LINK.c): TypeFunction {
    const ps = new DArray<Parameter | null>();
    for (const t of params)
        ps.push(new Parameter(loc, STC.none, t, null, null, null));
    return new TypeFunction(new ParameterList(ps, varargs), ret, linkage);
}

/** A member `name = value` (or without initializer) appended to `ed`, as the parser and addMember leave it. */
function enumMember(ed: EnumDeclaration, name: string, value: Expression | null): EnumMember {
    const em = new EnumMember(loc, id(name), value, null);
    em.ed = ed;
    em.parent = ed;
    ed.members!.push(em);
    return em;
}

describe("importc.ts module load (10 §1.6b smoke)", () => {
    test("the module loads and exports its ten functions", () => {
        for (const f of [cAdjustParamType, arrayFuncConv, fieldLookup, carraySemantic, addDefaultCInitializer,
            cFuncEquivalence, cTypeEquivalence, handleTagSymbols, handleSymbolRedeclarations, cEnumSemantic])
            expect(typeof f).toBe("function");
    });
});

describe("importc.d:48 — cAdjustParamType", () => {
    // ldc2, u3.i: `int h(int a[3]) { _Static_assert(sizeof(a) == 8, ""); ... }` and
    // `int k(int fn(int)) { _Static_assert(sizeof(fn) == 8, ""); ... }` compile: both parameters are pointers.
    test("C11 6.7.6.3-7/-8: array parameters become `T*`, function parameters a function pointer", () => {
        const { sc } = cScope();
        expect(cAdjustParamType(sarrayOf(Type.tint32, 3n), sc).ty).toBe(TY.Tpointer);
        expect(nextOf(cAdjustParamType(sarrayOf(Type.tint32, 3n), sc))).toBe(Type.tint32);
        expect(nextOf(cAdjustParamType(arrayOf(Type.tint32), sc))).toBe(Type.tint32);
        const tf = fn(Type.tint32, [Type.tint32]);
        const r = cAdjustParamType(tf, sc);
        expect(r.ty).toBe(TY.Tpointer);
        expect(nextOf(r)).toBe(tf);
    });

    test("the identity outside a C file and for a scalar", () => {
        const sa = sarrayOf(Type.tint32, 3n);
        expect(cAdjustParamType(sa, Scope.alloc())).toBe(sa);
        expect(cAdjustParamType(Type.tint32, cScope().sc)).toBe(Type.tint32);
    });
});

describe("importc.d:83/:167 — arrayFuncConv, carraySemantic", () => {
    test("arrayFuncConv: the identity outside a C file and for a non-array, non-function operand", () => {
        const e = new IntegerExp(loc, 1n, Type.tint32);
        expect(arrayFuncConv(e, Scope.alloc())).toBe(e);
        expect(arrayFuncConv(e, cScope().sc)).toBe(e);
    });

    test("arrayFuncConv: a static array decays to a pointer to its element", () => {
        const sc = semaScope("int[4] arr;");
        const e = arrayFuncConv(expressionSemantic(parseExp("arr"), sc), sc);
        expect(e.isErrorExp()).toBeNull();
        expect(e.type!.ty).toBe(TY.Tpointer);
        expect(nextOf(e.type!)).toBe(Type.tint32);
    });

    test("carraySemantic: null outside a C file (D's `E[I]` semantic then runs)", () => {
        const ae = new ArrayExp(loc, new IntegerExp(loc, 1n, Type.tint32), new IntegerExp(loc, 0n, Type.tint32));
        expect(carraySemantic(ae, Scope.alloc())).toBeNull();
    });
});

describe("importc.d:124 — fieldLookup", () => {
    // ldc2, t9.i: `int g(struct S s) { return s.b; }` -> `t9.i(3): Error: `b` is not a member of `S``.
    // The pointer leg (t9.i(2): "since `p` is a pointer, use `p->a` instead of `p.a`") runs the semantic of the
    // `PtrExp` it builds, whose ImportC operand decay is still a wall of expressionsem.ts (expressionsem.d:10490),
    // so it is pinned once that call site reaches `arrayFuncConv`.
    test("a member is found on the struct type; a missing one is diagnosed and yields ErrorExp", () => {
        const sc = semaScope("struct S { int a; } S s;");
        const r1 = fieldLookup(parseExp("s"), sc, id("a"), false);
        expect(r1.isDotVarExp()).not.toBeNull();
        expect(r1.type).toBe(Type.tint32);
        expect(diags).toEqual([]);

        const r2 = fieldLookup(parseExp("s"), sc, id("b"), false);
        expect(diags).toEqual(["Error: `b` is not a member of `S`"]);
        expect(r2.isErrorExp()).not.toBeNull();
    });
});

describe("importc.d:204 — addDefaultCInitializer", () => {
    // ldc2, u4.i: `const int ci; static const int sci; int use(void) { return ci + sci; }` compiles.
    test("a static const gets its default initializer; mutable, extern and non-static are left alone", () => {
        const v = new VarDeclaration(loc, constOf(Type.tint32), id("x"), null, (STC.static_ | STC.const_) as STC);
        addDefaultCInitializer(v);
        expect(v._init!.isExpInitializer()!.exp!.isIntegerExp()!.value).toBe(0n);

        const cases: [Type, STC][] = [[Type.tint32, STC.static_], [constOf(Type.tint32), STC.none],
            [constOf(Type.tint32), (STC.static_ | STC.extern_) as STC]];
        for (const [t, stc] of cases) {
            const w = new VarDeclaration(loc, t, id("y"), null, stc);
            addDefaultCInitializer(w);
            expect(w._init).toBeNull();
        }
    });

    test("an incomplete static array gets a VoidInitializer", () => {
        const tsa = sarrayOf(Type.tint32, 0n);
        expect(tsa.isTypeSArray()!.isIncomplete()).toBe(true);
        const v = new VarDeclaration(loc, tsa, id("a"), null, STC.gshared);
        addDefaultCInitializer(v);
        expect(v._init).toBeInstanceOf(VoidInitializer);
    });
});

describe("importc.d:237/:294 — cFuncEquivalence, cTypeEquivalence", () => {
    test("parameters compare with head const stripped; linkage, arity, return type and varargs count", () => {
        const i = Type.tint32;
        expect(cFuncEquivalence(fn(i, [i]), fn(i, [constOf(i)]))).toBe(true);
        expect(cFuncEquivalence(fn(i, [i]), fn(i, [Type.tint64]))).toBe(false);
        expect(cFuncEquivalence(fn(i, []), fn(Type.tint64, []))).toBe(true);    // func(void) matches func()
        expect(cFuncEquivalence(fn(i, [i]), fn(Type.tint64, [i]))).toBe(false);
        expect(cFuncEquivalence(fn(i, [i]), fn(i, [i, i]))).toBe(false);
        expect(cFuncEquivalence(fn(i, [i]), fn(i, [i], VarArg.variadic))).toBe(false);
        expect(cFuncEquivalence(fn(i, [i]), fn(i, [i], VarArg.none, LINK.d))).toBe(false);
        const kr = fn(i, [i], VarArg.variadic);
        kr.parameterList.hasIdentifierList = true;                              // K&R: varargs not compared
        expect(cFuncEquivalence(fn(i, [i]), kr)).toBe(true);
    });

    test("pointers recurse, head const differs, structs compare by symbol", () => {
        expect(cTypeEquivalence(pointerTo(Type.tint32), pointerTo(Type.tint32))).toBe(true);
        expect(cTypeEquivalence(pointerTo(Type.tint32), pointerTo(Type.tint64))).toBe(false);
        expect(cTypeEquivalence(constOf(Type.tint32), Type.tint32)).toBe(false);
        const sd = struct_("S", true);
        expect(cTypeEquivalence(sd.type!, struct_("S", true).type!)).toBe(false);
    });

    // ldc2, u1.i/u2.i: `extern int (*fp)(int); int (*fp)(long);` and `extern int (*fq)(int); long (*fq)(int);`
    // both compile without a diagnostic: importc.d:316 compares the first function type with itself.
    test("two function types of the same `ty`/`mod` are equivalent whatever their signatures", () => {
        const a = fn(Type.tint32, [Type.tint32]);
        const b = fn(Type.tint64, [Type.tint64, Type.tint64]);
        expect(cFuncEquivalence(a, b)).toBe(false);
        expect(cTypeEquivalence(a, b)).toBe(true);
        expect(cTypeEquivalence(pointerTo(a), pointerTo(b))).toBe(true);
    });
});

describe("importc.d:353 — handleTagSymbols", () => {
    // ldc2, t1.i: `struct S; struct S { int x; };` compiles. The kinds are compared by content: a `!==` on the two
    // `kind()` DStrings would refuse every such merge.
    test("a forward declaration takes the definition's members", () => {
        const { sc, sds } = cScope();
        const fwd = struct_("S", false);
        const def = struct_("S", true);
        const members = def.members;
        expect(handleTagSymbols(sc, def, fwd, sds)).toBe(fwd);
        expect(fwd.members).toBe(members);
        expect(def.members).toBeNull();
        // a later forward declaration is ignored in favour of the definition
        expect(handleTagSymbols(sc, struct_("S", false), fwd, sds)).toBe(fwd);
    });

    // ldc2, v1.i: `struct S { int x; }; struct S { int y; };` -> `struct `v1.S` conflicts with struct `v1.S``, the
    // caller's diagnostic for a null return: with members on both sides no arm of importc.d:393-422 returns.
    test("a second definition conflicts", () => {
        const { sc, sds } = cScope();
        expect(handleTagSymbols(sc, struct_("S", true), struct_("S", true), sds)).toBeNull();
    });

    // ldc2, t2.i: `struct S; union S { int x; };` -> `union `t2.S` conflicts with struct `t2.S``, the caller's
    // diagnostic for a null return.
    test("a struct and a union of the same name conflict", () => {
        const { sc, sds } = cScope();
        const ud = new UnionDeclaration(loc, id("S"));
        ud.members = new DArray<Dsymbol | null>();
        expect(handleTagSymbols(sc, ud, struct_("S", false), sds)).toBeNull();
    });

    test("a forward enum takes the definition's members, rebound to it", () => {
        const { sc, sds } = cScope();
        const fwd = new EnumDeclaration(loc, id("E"), Type.tint32);
        const def = new EnumDeclaration(loc, id("E"), Type.tint32);
        def.members = new DArray<Dsymbol | null>();
        const member = enumMember(def, "a", null);
        fwd.added = true;
        expect(handleTagSymbols(sc, def, fwd, sds)).toBe(fwd);
        expect(member.ed).toBe(fwd);
        expect(fwd.type).toBe(def.type);
        expect(fwd.added).toBe(false);

        const other = new EnumDeclaration(loc, id("F"), Type.tint64);
        other.members = new DArray<Dsymbol | null>();
        expect(handleTagSymbols(sc, other, new EnumDeclaration(loc, id("F"), Type.tint32), sds)).toBeNull();
    });

    // ldc2, u7.i: `struct S { int a; }; int S; struct S s;` compiles: the tag moves to the tag table.
    test("a tag and an ordinary symbol share the name through tagSymTab, in both orders", () => {
        const { sc, m, sds } = cScope();
        const v = new VarDeclaration(loc, Type.tint32, id("S"), null);
        m.symtab!.insert(v);
        const sd = struct_("S", true);
        expect(handleTagSymbols(sc, sd, v, sds)).toBe(sd);
        expect(m.tagSymTab.get(v)).toBe(sd);
        // a redeclaration of the tag finds it through the table, keyed by the ordinary symbol
        expect(handleTagSymbols(sc, struct_("S", false), v, sds)).toBe(sd);

        const { sc: sc2, m: m2, sds: sds2 } = cScope();
        const sd2 = struct_("T", true);
        m2.symtab!.insert(sd2);
        const w = new VarDeclaration(loc, Type.tint32, id("T"), null);
        expect(handleTagSymbols(sc2, w, sd2, sds2)).toBe(w);
        expect(m2.symtab!.lookup(id("T"))).toBe(w);
        expect(m2.tagSymTab.get(w)).toBe(sd2);
    });

    test("two ordinary symbols collide", () => {
        const { sc, sds } = cScope();
        const a = new VarDeclaration(loc, Type.tint32, id("q"), null);
        expect(handleTagSymbols(sc, new VarDeclaration(loc, Type.tint32, id("q"), null), a, sds)).toBeNull();
    });
});

describe("importc.d:465 — handleSymbolRedeclarations", () => {
    test("`extern int x; int x = 3;`: the definition replaces the declaration, which becomes extern", () => {
        const { sc, m, sds } = cScope();
        const vd2 = new VarDeclaration(loc, Type.tint32, id("x"), null, STC.extern_);
        m.symtab!.insert(vd2);
        const vd = new VarDeclaration(loc, Type.tint32, id("x"), new ExpInitializer(loc, new IntegerExp(loc, 3n,
            Type.tint32)));
        vd2.mangleOverride = ds("_x");
        expect(handleSymbolRedeclarations(sc, vd, vd2, sds)).toBe(vd);
        expect(m.symtab!.lookup(id("x"))).toBe(vd);
        expect((vd2.storage_class & STC.extern_) !== 0n).toBe(true);
        expect(dsToJs(vd.mangleOverride!)).toBe("_x");
    });

    test("`int x; extern int x;`: the incoming declaration becomes extern and the existing one stays", () => {
        const { sc, sds } = cScope();
        const vd2 = new VarDeclaration(loc, Type.tint32, id("x"), null);
        const vd = new VarDeclaration(loc, Type.tint32, id("x"), null);
        expect(handleSymbolRedeclarations(sc, vd, vd2, sds)).toBe(vd2);
        expect((vd.storage_class & STC.extern_) !== 0n).toBe(true);
        expect(diags).toEqual([]);
    });

    // ldc2, t7.i: `t7.i(2): Error: redefinition of `x` with different type: `int` vs `long``
    test("a different variable type is diagnosed, the existing declaration kept", () => {
        const { sc, sds } = cScope();
        const vd2 = new VarDeclaration(loc, Type.tint32, id("x"), null, STC.extern_);
        const vd = new VarDeclaration(loc, Type.tint64, id("x"), null);
        expect(handleSymbolRedeclarations(sc, vd, vd2, sds)).toBe(vd2);
        expect(diags).toEqual(["Error: redefinition of `x` with different type: `int` vs `long`"]);
    });

    // ldc2, t8.i: `static int y; int y;` -> `variable `t8.y` conflicts with variable `t8.y``, the caller's
    // diagnostic for a null return.
    test("collisions: `static` on one side only, two initializers, unrelated kinds", () => {
        const { sc, sds } = cScope();
        const init = (): ExpInitializer => new ExpInitializer(loc, new IntegerExp(loc, 1n, Type.tint32));
        expect(handleSymbolRedeclarations(sc, new VarDeclaration(loc, Type.tint32, id("y"), null),
            new VarDeclaration(loc, Type.tint32, id("y"), null, STC.static_), sds)).toBeNull();
        expect(handleSymbolRedeclarations(sc, new VarDeclaration(loc, Type.tint32, id("y"), init()),
            new VarDeclaration(loc, Type.tint32, id("y"), init()), sds)).toBeNull();
        expect(handleSymbolRedeclarations(sc, new VarDeclaration(loc, Type.tint32, id("y"), null),
            struct_("y", true), sds)).toBeNull();
    });

    test("a C macro never shadows a real symbol", () => {
        const { sc, sds } = cScope();
        const real = new VarDeclaration(loc, Type.tint32, id("M"), null);
        const macro = new VarDeclaration(loc, Type.tint32, id("M"), null);
        macro.isCmacro = true;
        expect(handleSymbolRedeclarations(sc, macro, real, sds)).toBe(real);
    });

    test("`typedef` redeclarations keep the first", () => {
        const { sc, sds } = cScope();
        const a = AliasDeclaration.fromType(loc, id("T"), Type.tint32);
        const b = AliasDeclaration.fromType(loc, id("T"), Type.tint32);
        expect(handleSymbolRedeclarations(sc, b, a, sds)).toBe(a);
    });

    // ldc2, u8.i: `void f(); void f() { }` and `static int sun1(); int sun1() {...}` compile;
    // `int sun3(); static int sun3() {...}` -> `function `u8.sun3` conflicts with function `u8.sun3``.
    test("functions: the definition replaces the prototype; adding `static` or a second body collides", () => {
        const { sc, m, sds } = cScope();
        const proto = new FuncDeclaration(loc, loc, id("f"), STC.none, fn(Type.tvoid, []));
        m.symtab!.insert(proto);
        const tag = struct_("f", true);
        m.tagSymTab.set(proto, tag);
        const def = new FuncDeclaration(loc, loc, id("f"), STC.none, fn(Type.tvoid, []));
        def.fbody = new ExpStatement(loc, new IntegerExp(loc, 0n, Type.tint32));
        expect(handleSymbolRedeclarations(sc, def, proto, sds)).toBe(def);
        expect(m.symtab!.lookup(id("f"))).toBe(def);
        expect(def.overnext).toBe(proto);
        expect(m.tagSymTab.get(def)).toBe(tag);

        const sproto = new FuncDeclaration(loc, loc, id("g"), STC.none, fn(Type.tint32, []));
        const sdef = new FuncDeclaration(loc, loc, id("g"), STC.static_, fn(Type.tint32, []));
        sdef.fbody = def.fbody;
        expect(handleSymbolRedeclarations(sc, sdef, sproto, sds)).toBeNull();

        const b1 = new FuncDeclaration(loc, loc, id("h"), STC.none, fn(Type.tint32, []));
        const b2 = new FuncDeclaration(loc, loc, id("h"), STC.none, fn(Type.tint32, []));
        b1.fbody = b2.fbody = def.fbody;
        expect(handleSymbolRedeclarations(sc, b2, b1, sds)).toBeNull();
    });

    test("two prototypes overload; inside a function a different return type is diagnosed", () => {
        const { sc, sds } = cScope();
        const p1 = new FuncDeclaration(loc, loc, id("k"), STC.none, fn(Type.tint32, []));
        p1.parent = sds;
        const p2 = new FuncDeclaration(loc, loc, id("k"), STC.none, fn(Type.tint64, []));
        p2.parent = sds;
        expect(handleSymbolRedeclarations(sc, p2, p1, sds)).toBe(p1);
        expect(p1.overnext).toBe(p2);
        expect(diags).toEqual([]);

        sc.func = p1;
        const p3 = new FuncDeclaration(loc, loc, id("k"), STC.none, fn(Type.tint64, []));
        p3.parent = sds;
        expect(handleSymbolRedeclarations(sc, p3, p1, sds)).toBe(p1);
        expect(diags).toEqual(["Error: function `r.k` redeclaration with different type"]);
    });
});

describe("importc.d:623 — cEnumSemantic", () => {
    /** An enum `E` of module `name`, members `[ident, value-or-null]`, memtype `memtype`. */
    function cEnum(name: string, memtype: Type | null, members: [string, Expression | null][]):
        { ed: EnumDeclaration; ems: EnumMember[]; sc: Scope } {
        const { sc, sds } = cScope(name);
        const ed = new EnumDeclaration(loc, id("E"), memtype);
        ed.parent = sds;
        ed.members = new DArray<Dsymbol | null>();
        const ems = members.map(([n, v]) => enumMember(ed, n, v));
        // The scope runs D semantic (`inCfile` off): under `inCfile` the `+` of the common-type merge reaches the
        // ImportC operand-decay wall of expressionsem.ts (expressionsem.d:13667), and the `arrayFuncConv` it defers
        // is the identity on these integer operands.
        sc.inCfile = false;
        return { ed, ems, sc };
    }

    test("values count up from the previous member; the enum is complete afterwards", () => {
        const { ed, ems, sc } = cEnum("u6", null, [["a", parseExp("-1")], ["b", null], ["c", parseExp("5")],
            ["d", null]]);
        cEnumSemantic(sc, ed);
        expect(ems.map((em) => em.value!.isIntegerExp()!.getInteger())).toEqual([-1n, 0n, 5n, 6n]);
        expect(ems.every((em) => em.type === Type.tint32 && em.semanticRun === PASS.semanticdone)).toBe(true);
        expect(ed.memtype).toBe(Type.tint32);
        expect(ed.semanticRun).toBe(PASS.semantic2done);
        expect(diags).toEqual([]);
    });

    // ldc2, t3.i: `enum E { a = 0x7fffffff, b };`
    //   -> `enum member `t3.E.b` initialization with `2147483647+1` causes overflow for type `int``
    // ldc2, t4.i: `enum E { a = 0xffffffff, b };`
    //   -> `enum member `t4.E.b` initialization with `4294967295u+1` causes overflow for type `uint``
    test("the member after the type's maximum overflows", () => {
        const t3 = cEnum("t3", null, [["a", parseExp("0x7fffffff")], ["b", null]]);
        cEnumSemantic(t3.sc, t3.ed);
        const t4 = cEnum("t4", null, [["a", parseExp("0xffffffff")], ["b", null]]);
        cEnumSemantic(t4.sc, t4.ed);
        expect(diags).toEqual([
            "Error: enum member `t3.E.b` initialization with `2147483647+1` causes overflow for type `int`",
            "Error: enum member `t4.E.b` initialization with `4294967295u+1` causes overflow for type `uint`",
        ]);
        expect(t3.ems[1]!.errors).toBe(true);
        expect(t3.ems[1]!.value!.isErrorExp()).not.toBeNull();
        expect(t4.ed.memtype).toBe(Type.tuns32);
    });

    // ldc2, t5.i: `enum E : unsigned char { a = 256 };`
    //   -> `enum member `t5.E.a` enum member value `256` does not fit in `ubyte``
    // ldc2, t6.i: `enum E { a = 1.5 };`
    //   -> `enum member `t6.E.a` enum member must be an integral constant expression, not `1.5` of type `double``
    test("a value out of the declared type's range, and a non-integral value, are diagnosed", () => {
        const t5 = cEnum("t5", Type.tuns8, [["a", parseExp("256")]]);
        cEnumSemantic(t5.sc, t5.ed);
        const t6 = cEnum("t6", null, [["a", parseExp("1.5")]]);
        cEnumSemantic(t6.sc, t6.ed);
        expect(diags).toEqual([
            "Error: enum member `t5.E.a` enum member value `256` does not fit in `ubyte`",
            "Error: enum member `t6.E.a` enum member must be an integral constant expression, not `1.5` of type " +
                "`double`",
        ]);
    });
});
