import { initSemaHarness } from "../../sema-harness.js"; // module-graph root first (10 §1.5)
import { describe, test, expect, beforeEach } from "vitest";

// Tests for mangle/index.ts (dmd/mangle/package.d): the ported D unittests (package.d:86, :96) and
// ldc2 pins of the symbol mangler.
//
// GROUND TRUTH: ldc2 1.43.0 (arm64-apple-darwin), `ldc2 -c -o- m.d` with `pragma(msg, X.mangleof)`
// over the declarations of `SRC` below (plus `pragma(msg, V!5.mangleof)` etc. for the template
// types). Each expected string in this file is that output verbatim.
//
// HOW THE PINS ARE TAKEN. Each test runs sema over `SRC`, finds the declaration, and calls the mangler
// entry point D's `.mangleof` would reach: `mangleExact` for a
// function, `mangleToBufferDsymbol` for any other symbol, the interned `deco` for a type.

import { Parser } from "../parse.js";
import { Identifier } from "../identifier.js";
import { ds, dsToJs, dsUtf8 } from "../../dstring.js";
import { ErrorSinkNull } from "../errorsink.js";
import { global } from "../globals.js";
import { moduleFromParse } from "../dmodule.js";
import type { Module } from "../dmodule.js";
import { runSemantic, toAlias } from "../dsymbolsem.js";
import { OutBuffer } from "../common/outbuffer.js";
import { IntegerExp, NullExp, RealExp, StringExp } from "../expression.js";
import type { Expression } from "../expression.js";
import { Loc } from "../location.js";
import { Type } from "../mtype.js";
import type { Dsymbol, ScopeDsymbol } from "../dsymbol.js";
import type { FuncDeclaration } from "../func.js";
import type { Statement } from "../statement.js";
import {
    isValidMangling,
    mangleExact,
    mangleToBufferDsymbol,
    mangleToBufferExpression,
    mangleToBuffer,
} from "./index.js";

// ── D unittests (package.d:86 / :96) ──────────────────────────────────────────────────────────────

describe("isValidMangling (package.d unittests)", () => {
    // package.d:86 — valid mangled characters
    test("unittest#1: valid mangled characters", () => {
        expect(isValidMangling(0x61 /* 'a' */)).toBe(true);
        expect(isValidMangling(0x42 /* 'B' */)).toBe(true);
        expect(isValidMangling(0x32 /* '2' */)).toBe(true);
        expect(isValidMangling(0x40 /* '@' */)).toBe(true);
        expect(isValidMangling(0x5f /* '_' */)).toBe(true);
    });

    // package.d:96 — invalid mangled characters
    test("unittest#2: invalid mangled characters", () => {
        expect(isValidMangling(0x2d /* '-' */)).toBe(false);
        expect(isValidMangling(0)).toBe(false);
        expect(isValidMangling(0x2f /* '/' */)).toBe(false);
        expect(isValidMangling(0x5c /* '\\' */)).toBe(false);
    });
});

// ── ldc2 pins ─────────────────────────────────────────────────────────────────────────────────────

const SRC = `module m;
void foo(int a, long b) {}
int bar;
struct S { int x; static int sv; }
void outer() { void inner(int) {} static int loc; }
extern(C) void cfun(int);
extern(C) int cvar;
void main() {}
void pm() {}
int pv;
void ov(int) {}
void ov(long) {}
void lf() { { static int q; } { static int q; } }
struct V(int n) {}
struct NN(long v) {}
int gfun() { return 1; }
struct X(alias f) {}
template T(int N, alias A, U) { int T = N; }
struct Z(int[] a) {}
struct P { int a; int b; }
struct Q(P p) {}
struct UU(uint u) {}
struct BB(bool b) {}
struct CC(char c) {}
struct Y(double d) {}
mixin template MT() { int mv; }
struct H { mixin MT!() mm; }
V!5 v5;
V!(-5) vm5;
NN!(long.min) nn;
X!gfun xg;
Z!([1,2]) z;
Q!(P(1,2)) qp;
UU!(4000000000u) uu;
BB!true bb;
CC!'a' cc;
Y!(double.nan) ynan;
Y!(-double.infinity) yninf;
Y!(double.infinity) yinf;
alias TT = T!(3, bar, int);
struct SP(T : int) {}
struct HV(int n : 3) {}
extern(C) void cf();
struct VT(A...) {}
SP!int sp;
HV!3 hv;
X!cf xc;
VT!(int, 3, bar) vt;
void f1(int) {}
void f2(long) {}
alias fo = f1;
alias fo = f2;
void twof(void function(int) a, void function(int) b) {}
ref int rr(return ref int x) @safe { return x; }
int* rsf(return scope int* p) @safe { return p; }
void scf(scope int* p) {}
void shf(shared(int)* a, immutable(char)[] s, shared(const int)* b, shared(shared(const int)[]) c) {}
inout(int)* iwf(inout(int)* p) { return p; }
struct é {} é we;
struct Ω {} Ω wo;
`;

/// UTF-8 source bytes plus the NUL terminator the lexer expects.
function srcBuf(s: string): Uint8Array {
    const u = dsUtf8(s);
    const b = new Uint8Array(u.length + 1);
    b.set(u);
    return b;
}

function sema(src: string): Module {
    const p = new Parser(null, null, srcBuf(src), false, new ErrorSinkNull(), null, false);
    p.nextToken();
    const members = p.parseModule();
    const m = moduleFromParse(members, p.md);
    runSemantic(m);
    return m;
}

/// `sd` is structural: Module and AggregateDeclaration shadow Dsymbol fields with other types (the
/// audited `errors`/`deferred` shadows), so neither is assignable to ScopeDsymbol by name.
function lookup(sd: Pick<ScopeDsymbol, "symtab">, name: string): Dsymbol {
    const s = sd.symtab ? sd.symtab.lookup(Identifier.idPool(ds(name))) : null;
    expect(s, name).not.toBeNull();
    return s!;
}

/// The first declaration named `name` (or the `nth` of that name) inside a function body.
function localDecl(fd: FuncDeclaration, name: string, nth = 0): Dsymbol {
    const found: Dsymbol[] = [];
    const walk = (st: Statement | null): void => {
        if (st === null) return;
        const cs = st.isCompoundStatement();
        if (cs) { for (const s of cs.statements!) walk(s); return; }
        const ss = st.isScopeStatement();
        if (ss) { walk(ss.statement); return; }
        const es = st.isExpStatement();
        const de = es?.exp?.isDeclarationExp();
        if (de && de.declaration && de.declaration.ident && dsToJs(de.declaration.ident.toString()) === name)
            found.push(de.declaration);
    };
    walk(fd.fbody);
    expect(found.length, name).toBeGreaterThan(nth);
    return found[nth]!;
}

function symMangle(s: Dsymbol): string {
    const buf = new OutBuffer();
    mangleToBufferDsymbol(s, buf);
    return dsToJs(buf.peekSlice());
}

/// `mangleExact` returns the NUL-terminated bytes (D `const(char)*`); the pin compares the text.
function exact(fd: FuncDeclaration): string {
    const me = mangleExact(fd);
    expect(me[me.length - 1]).toBe(0);
    return dsToJs(me.subarray(0, me.length - 1));
}

function func(m: Module, name: string): FuncDeclaration {
    const fd = lookup(m, name).isFuncDeclaration();
    expect(fd, name).not.toBeNull();
    return fd!;
}

function deco(m: Module, varName: string): string {
    const vd = lookup(m, varName).isVarDeclaration()!;
    return String(vd.type!.deco);
}

describe("Mangler — declarations and template instances (ldc2 1.43.0 pins)", () => {
    let m: Module;

    beforeEach(() => {
        initSemaHarness();
        m = sema(SRC);
    });

    test("sema of the pin module is clean", () => {
        expect(global.errors).toBe(0);
    });

    test("module-level function and variable: `_D` + qualified name + type", () => {
        expect(exact(func(m, "foo"))).toBe("_D1m3fooFilZv");
        expect(symMangle(lookup(m, "bar"))).toBe("_D1m3bari");
    });

    test("mangleExact memoizes in fd.mangleString", () => {
        const fd = func(m, "foo");
        const a = mangleExact(fd);
        expect(mangleExact(fd)).toBe(a);
    });

    test("static member variable: the aggregate is a parent", () => {
        const s = lookup(m, "S").isStructDeclaration()!;
        expect(symMangle(lookup(s, "sv"))).toBe("_D1m1S2svi");
    });

    test("nested function and static local: the function parent carries its type without return", () => {
        const outer = func(m, "outer");
        expect(exact(outer)).toBe("_D1m5outerFZv");
        expect(exact(localDecl(outer, "inner").isFuncDeclaration()!)).toBe("_D1m5outerFZ5innerMFNaNbNiNfiZv");
        expect(symMangle(localDecl(outer, "loc"))).toBe("_D1m5outerFZ3loci");
    });

    test("same-named locals in one function: the second gets the `__S1` fake parent (localNum)", () => {
        const lf = func(m, "lf");
        expect(symMangle(localDecl(lf, "q", 0))).toBe("_D1m2lfFZ1qi");
        expect(symMangle(localDecl(lf, "q", 1))).toBe("_D1m2lfFZ4__S11qi");
    });

    test("extern(C) at module scope mangles to the bare identifier", () => {
        expect(exact(func(m, "cfun"))).toBe("cfun");
        expect(symMangle(lookup(m, "cvar"))).toBe("cvar");
    });

    test("main is `_Dmain`; a mangle override replaces the function and variable mangle", () => {
        expect(exact(func(m, "main"))).toBe("_Dmain");
        // `pragma(mangle, "...")` cannot run in the port yet (pragmasem reads the argument through
        // the escalated StringExp payload), so the test sets the field that pragma sets
        // (`mangleOverride`, pragmasem.d `applyPragmaMangle`). ldc2 with the pragma: the override text.
        const pm = func(m, "pm");
        pm.mangleOverride = ds("custom_name");
        expect(exact(pm)).toBe("custom_name");
        const pv = lookup(m, "pv").isVarDeclaration()!;
        pv.mangleOverride = ds("custom_var");
        expect(symMangle(pv)).toBe("custom_var");
    });

    test("an overloaded function's symbol mangle is the qualified name only (visit(FuncDeclaration))", () => {
        // ldc2: `ov.mangleof` == "1m2ov" — isUnique is false, so visit(Dsymbol) runs.
        expect(symMangle(lookup(m, "ov"))).toBe("1m2ov");
        expect(exact(func(m, "ov"))).toBe("_D1m2ovFiZv");
    });

    test("template value arguments: int, negative int, long.min, uint, bool, char", () => {
        expect(deco(m, "v5")).toBe("S1m__T1VVii5ZQh");
        expect(deco(m, "vm5")).toBe("S1m__T1VViN5ZQh");
        expect(deco(m, "nn")).toBe("S1m__T2NNVlN9223372036854775808ZQBa");
        expect(deco(m, "uu")).toBe("S1m__T2UUVki4000000000ZQr");
        expect(deco(m, "bb")).toBe("S1m__T2BBVbi1ZQi");
        expect(deco(m, "cc")).toBe("S1m__T2CCVai97ZQj");
    });

    test("template value arguments: floating NaN and infinities (realToMangleBuffer, package.d:1291)", () => {
        expect(deco(m, "ynan")).toBe("S1m__T1YVdeNANZQj");
        expect(deco(m, "yninf")).toBe("S1m__T1YVdeNINFZQk");
        expect(deco(m, "yinf")).toBe("S1m__T1YVdeINFZQj");
    });

    test("template value arguments: array literal, struct literal", () => {
        expect(deco(m, "z")).toBe("S1m__T1ZVAiA2i1i2ZQm");
        expect(deco(m, "qp")).toBe("S1m__T1QVSQj1PS2i1i2ZQp");
    });

    test("alias template argument (a function symbol, with back-reference to the module)", () => {
        expect(deco(m, "xg")).toBe("S1m__T1XS_DQk4gfunFZiZQq");
    });

    test("eponymous variable inside an instance with value, alias and type arguments", () => {
        const v = toAlias(lookup(m, "TT"));
        expect(symMangle(v)).toBe("_D1m__T1TVii3S_DQo3bariTiZQti");
    });

    test("specialized parameters (`H`), extern(C) alias argument (`X`), variadic arguments", () => {
        expect(symMangle(lookup(m, "sp"))).toBe("_D1m2spSQg__T2SPHTiZQh");
        expect(symMangle(lookup(m, "hv"))).toBe("_D1m2hvSQg__T2HVHVii3ZQj");
        expect(symMangle(lookup(m, "xc"))).toBe("_D1m2xcSQg__T1XX2cfZQh");
        expect(symMangle(lookup(m, "vt"))).toBe("_D1m2vtSQg__T2VTTiVii3S_DQx3bariZQu");
    });

    test("two-alias overload set: visit(FuncAliasDeclaration) with overloads gives the qualified name", () => {
        // `fo` in the symbol table is the first AliasDeclaration; `.mangleof` resolves it (toAlias) to
        // the FuncAliasDeclaration aliasSemantic builds over the chained overloads (hasOverloads set).
        const fa = toAlias(lookup(m, "fo")).isFuncAliasDeclaration();
        expect(fa).not.toBeNull();
        expect(symMangle(fa!)).toBe("1m2fo");
    });

    test("function types: back-referenced parameter type, ref/return/scope, shared, inout", () => {
        expect(exact(func(m, "twof"))).toBe("_D1m4twofFPFiZvQfZv");
        expect(exact(func(m, "rr"))).toBe("_D1m2rrFNcNfNkKiZi");
        expect(exact(func(m, "rsf"))).toBe("_D1m3rsfFNfNkMPiZQd");
        expect(exact(func(m, "scf"))).toBe("_D1m3scfFMPiZv");
        expect(exact(func(m, "shf"))).toBe("_D1m3shfFPOiAyaPOxiOAOxiZv");
        expect(exact(func(m, "iwf"))).toBe("_D1m3iwfFPNgiZQf");
    });

    test("mangleToBuffer(Type) writes a non-ASCII deco as its UTF-8 bytes (package.d:39)", () => {
        const hex = (name: string): string => {
            const buf = new OutBuffer();
            mangleToBuffer(lookup(m, name).isVarDeclaration()!.type!, buf);
            return Buffer.from(buf.peekSlice()).toString("hex");
        };
        expect(hex("we")).toBe("53316d32c3a9"); // ldc2: `é.mangleof` bytes, S1m2é
        expect(hex("wo")).toBe("53316d32cea9"); // ldc2: `Ω.mangleof` bytes, S1m2Ω
    });

    test("a named mixin is mangled by its identifier, not as a template instance", () => {
        const h = lookup(m, "H").isStructDeclaration()!;
        const mm = lookup(h, "mm").isTemplateMixin()!;
        expect(symMangle(lookup(mm, "mv"))).toBe("_D1m1H2mm2mvi");
    });
});

describe("mangleToBufferExpression — value manglings", () => {
    beforeEach(() => {
        initSemaHarness();
    });

    const exprMangle = (e: Expression): string => {
        const buf = new OutBuffer();
        mangleToBufferExpression(e, buf);
        return dsToJs(buf.peekSlice());
    };

    test("IntegerExp: `i` + value, `N` + magnitude when negative as sinteger_t (package.d:518)", () => {
        expect(exprMangle(new IntegerExp(Loc.initial, 5n, Type.tint32))).toBe("i5");
        expect(exprMangle(new IntegerExp(Loc.initial, -5n, Type.tint32))).toBe("N5");
        // ulong.max is negative as sinteger_t: D mangles it `N1` (verified: `V!(ulong.max)` for
        // `struct V(ulong u)` gives `...VmN1Z...` in ldc2).
        expect(exprMangle(new IntegerExp(Loc.initial, 0xffffffffffffffffn, Type.tuns64))).toBe("N1");
    });

    test("NullExp: `n`", () => {
        expect(exprMangle(new NullExp(Loc.initial, Type.tnull))).toBe("n");
    });

    // ldc2 1.43.0 `struct S(real d)`: S!(1.5) -> `Vee18P0`, S!(-1.5) -> `VeeN18P0`, S!(-0.0) -> `VeeX0P0`,
    // S!(0.1) -> `Vee1999999999999APN4`.
    test("RealExp: the 'A' hex digits without `0X`, `.` and `+`, `N` for a negative value (package.d:1296)", () => {
        expect(exprMangle(new RealExp(Loc.initial, 1.5, Type.tfloat64))).toBe("e18P0");
        expect(exprMangle(new RealExp(Loc.initial, -1.5, Type.tfloat64))).toBe("eN18P0");
        expect(exprMangle(new RealExp(Loc.initial, -0.0, Type.tfloat64))).toBe("eX0P0");
        expect(exprMangle(new RealExp(Loc.initial, 0.1, Type.tfloat64))).toBe("e1999999999999APN4");
    });

    test("StringExp: `a`/`w`/`d` + UTF-8 byte count + `_` + hex (mangle/package.d:978)", () => {
        // ldc2: `S!"hi"` -> `VAyaa2_6869`, `S!"é€"w` -> `VAyuw5_c3a9e282ac`, `S!"😀"d` -> `VAywd4_f09f9880`.
        expect(exprMangle(new StringExp(Loc.initial, [0x68, 0x69]))).toBe("a2_6869");
        expect(exprMangle(new StringExp(Loc.initial, [0xe9, 0x00, 0xac, 0x20], 2, 2))).toBe("w5_c3a9e282ac");
        expect(exprMangle(new StringExp(Loc.initial, [0x00, 0xf6, 0x01, 0x00], 1, 4))).toBe("d4_f09f9880");
    });
});
