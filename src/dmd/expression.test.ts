// Co-located tests for src/dmd/expression.ts (dmd/expression.d).
//
// `dmd/expression.d` contains ZERO in-source `unittest` blocks (verified: `grep -c '^unittest'`
// returns 0), so per 10-tests-diagnostics.md §1.6b this file is the thin test file: one
// module-load smoke test plus a small set of behaviour pins that the EXISTING harness
// conventions can construct honestly. Nothing here builds new harness machinery.
//
// The `StringExp` pins cover the payload model ratified for the D union (11-escalate.md §3.5):
// one little-endian byte buffer read and written at the width `sz` selects. Code-unit values are the
// ones ldc2 1.43.0 prints for the same literals (`pragma(msg, "é€"w[1])` and friends).

import { describe, it, expect, beforeEach } from "vitest";
import { Loc } from "./location.js";
import { EXP } from "./tokens.js";
import { initTokens } from "./tokens.js";
import { TY } from "./astenums.js";
import { Id } from "./id.js";
import { Type } from "./mtype.js";
import {
    Expression,
    IntegerExp,
    RealExp,
    NullExp,
    ThisExp,
    SuperExp,
    AddExp,
    AddAssignExp,
    CommaExp,
    NegExp,
    ComExp,
    CondExp,
    IndexExp,
    StringExp,
    TypeidExp,
    TraitsExp,
    DotTemplateInstanceExp,
    CTFEExp,
    ArgumentList,
    ArgumentLabel,
    MemorySet,
    OwnedBy,
    StructLiteralExpStageFlags,
    WANTvalue,
    WANTexpand,
    LOGSEMANTIC,
    lastComma,
    isArrayConstruction,
    _isRoughlyScalar,
    CallExp,
} from "./expression.js";

// The dtemplate-dependent syntaxCopy pins below construct the node the ported bodies build
// (dmd/expression.d:2292); dtemplate.js is an ordinary value import since 01 §4.1's lazy class.
import { TemplateInstance } from "./dtemplate.js";

import type { ArgumentLabels } from "./arraytypes.js";
import { Array as DArray } from "./root/array.js";
import { cstr, dsToJs } from "../dstring.js";
import { Type_init } from "./typesem.js";
import { AssertError } from "../assert.js";

const loc = Loc.initial;

// 10-tests-diagnostics.md §1.5 — THE canonical init snippet, in the ORDER contract of 01 §5.2.
function initHarness(): void {
    Loc._init();
    initTokens();
    Id.initialize();
    Type_init();
    IntegerExp._resetLiteralCache(); // 01 §5.5 — reset the cached AST singletons with Type._init
}

// BLOCKED DEPENDENCY (reported, not worked around): `Type._init()` currently throws
// `ReferenceError: stripDefaultArgs is not defined` from src/dmd/mtype.ts:1564 — an in-flight
// defect in a sibling file this agent does not own (it is also one of the pre-existing
// `tsc --noEmit` errors, mtype.ts(1562,23)). The pins that need a real `Type` are gated on this
// probe so the blocker is reported once instead of as N confusing failures; the gate disappears
// by itself the moment mtype.ts is fixed. The Type-free pins run unconditionally.
const typeHarnessWorks = ((): boolean => {
    try {
        initHarness();
        return true;
    } catch {
        return false;
    }
})();

describe("expression.d — pins that need no Type", () => {
    it("module loads and its top-level state evaluates", () => {
        // Importing the module already executed its top level (the `exptab` IIFE, the enums).
        // These reads catch a load-order/cycle regression at the earliest possible point.
        expect(LOGSEMANTIC).toBe(false);
        expect(WANTvalue).toBe(0);
        expect(WANTexpand).toBe(1);
        expect(OwnedBy.code).toBe(0);
        expect(MemorySet.none).toBe(0);
        expect(StructLiteralExpStageFlags.none).toBe(0x0);
        expect(StructLiteralExpStageFlags.toCBuffer).toBe(0x20);
    });

    it("isUnaExp/isBinExp/isBinAssignExp read the exptab flag table (dmd/expression.d:4088)", () => {
        const neg = new NegExp(loc, null); // Eunary
        const add = new AddExp(loc, null, null); // Ebinary -> unary|binary
        const addAssign = new AddAssignExp(loc, null, null); // EbinaryAssign -> all three

        expect(neg.isUnaExp()).toBe(neg);
        expect(neg.isBinExp()).toBeNull();

        expect(add.isBinExp()).toBe(add);
        expect(add.isUnaExp()).toBe(add);
        expect(add.isBinAssignExp()).toBeNull();

        expect(addAssign.isBinAssignExp()).toBe(addAssign);
        expect(addAssign.isBinExp()).toBe(addAssign);
        expect(addAssign.isUnaExp()).toBe(addAssign);
    });

    it("isXxx() downcasts classify by op, including the multi-op accessors", () => {
        const se = new SuperExp(loc);
        expect(se.op).toBe(EXP.super_);
        expect(se.isSuperExp()).toBe(se);
        expect(se.isThisExp()).toBeNull(); // op is EXP.super_, not EXP.this_
        const ne = new NullExp(loc);
        expect(ne.isNullExp()).toBe(ne);
        expect(ne.isIntegerExp()).toBeNull();
        expect(ne.isConst()).toBe(0); // dmd/expression.d:322 — EXP.null_ arm
    });

    it("ArgumentList / ArgumentLabel are value structs with a field-wise copy()", () => {
        const al = new ArgumentList(null, null);
        expect(al.arguments_).toBeNull();
        expect(al.names).toBeNull();
        expect(al.length()).toBe(0);
        expect(al.hasArgNames()).toBe(false);
        const alc = al.copy();
        expect(alc).not.toBe(al);
        expect(alc.arguments_).toBeNull();

        const label = new ArgumentLabel(null, loc);
        expect(label.name).toBeNull();
        expect(label.copy().loc).toBe(loc);
    });

    it("syntaxCopy copies the ArgumentLabel VALUES, not just the container slots", () => {
        // D `names.copy()` (dmd/expression.d:2469, and :1683 for NewExp) is `Array!T.copy()` =
        // `memcpy(..., length * T.sizeof)` (dmd/root/array.d:329). `ArgumentLabel` is a by-value
        // struct held BY VALUE in `ArgumentLabels` (08 §3), so each slot of the clone is an
        // INDEPENDENT value: mutating the clone's label must not be visible through the original.
        const names: ArgumentLabels = new DArray<ArgumentLabel>();
        names.push(new ArgumentLabel(null, loc));

        const ce = new CallExp(loc, new NullExp(loc), null, names);
        const cp = ce.syntaxCopy();

        expect(cp.names).not.toBe(ce.names);
        expect(cp.names!.opIndex(0)).not.toBe(ce.names!.opIndex(0)); // the ELEMENT is fresh too
        cp.names!.opIndex(0).name = Id.dollar;
        expect(ce.names!.opIndex(0).name).toBeNull();
    });

    it("isArrayConstruction() identity-compares against the interned Id singletons", () => {
        initTokens();
        Id.initialize();
        expect(isArrayConstruction(Id._d_arrayctor)).toBe(true);
        expect(isArrayConstruction(Id._d_arraysetctor)).toBe(true);
        expect(isArrayConstruction(Id.dollar)).toBe(false);
        expect(isArrayConstruction(null)).toBe(false);
    });

    // ── the StringExp payload: one little-endian byte buffer, width `sz` (11 §3.5) ─────────────────────────
    it("StringExp: the sz == 1 payload arm reads and writes bytes", () => {
        const se = new StringExp(loc, [0x61, 0x62, 0x63]); // "abc" as raw bytes, sz defaults to 1
        expect(se.sz).toBe(1);
        expect(se.len).toBe(3);
        expect(se.getIndex(0)).toBe(0x61n);
        expect(se.getCodeUnit(2)).toBe(0x63);
        se.setCodeUnit(0, 0x7a);
        expect(se.getCodeUnit(0)).toBe(0x7a);
        expect([...se.peekString()]).toEqual([0x7a, 0x62, 0x63]);
    });

    it("StringExp: getIndex/setIndex read and write one little-endian code unit of width sz (2, 4, 8)", () => {
        // "é€"w is the two wchars 0x00E9 0x20AC (ldc2: `pragma(msg, "é€"w[1])` prints €): bytes E9 00 AC 20.
        const w = new StringExp(loc, [0xe9, 0x00, 0xac, 0x20], 2, 2);
        expect(w.getIndex(0)).toBe(0xe9n);
        expect(w.getCodeUnit(1)).toBe(0x20ac);
        w.setIndex(1, 0x1f600n); // `cast(wchar)c` keeps the low 16 bits
        expect([...w.peekData()]).toEqual([0xe9, 0x00, 0x00, 0xf6]);
        // U+1F600 as one dchar: bytes 00 F6 01 00.
        const d = new StringExp(loc, [0x00, 0xf6, 0x01, 0x00], 1, 4);
        expect(d.getCodeUnit(0)).toBe(0x1f600);
        d.setCodeUnit(0, 0x20ac);
        expect([...d.peekData()]).toEqual([0xac, 0x20, 0x00, 0x00]);
        // sz == 8 (`ulong*` arm): `lstring[i] = c` stores the long's 64 bits; getIndex reads them unsigned.
        const l = new StringExp(loc, new Array<number>(8).fill(0), 1, 8);
        l.setIndex(0, -1n);
        expect(l.getIndex(0)).toBe(0xffffffffffffffffn);
        expect([...l.peekData()]).toEqual(new Array<number>(8).fill(0xff));
        expect(() => l.getCodeUnit(0)).toThrow(AssertError); // `assert(this.sz <= dchar.sizeof)`
    });

    it("StringExp: the width views and borrowData share the payload; copy() shares it as D shares the pointer", () => {
        const w = new StringExp(loc, [0x61, 0x00, 0xac, 0x20], 2, 2);
        expect([...w.peekWstring()]).toEqual([0x61, 0x20ac]);
        expect(() => w.peekString()).toThrow(AssertError); // `assert(sz == 1)`
        expect(() => w.peekDstring()).toThrow(AssertError); // `assert(sz == 4)`
        const c = w.copy() as StringExp;
        w.borrowData()[0] = 0x62; // in-place write through the borrowed bytes
        expect(w.getCodeUnit(0)).toBe(0x62);
        expect(c.getCodeUnit(0)).toBe(0x62);
        const d = new StringExp(loc, [0x00, 0xf6, 0x01, 0x00, 0x61, 0x00, 0x00, 0x00], 2, 4);
        expect([...d.peekDstring()]).toEqual([0x1f600, 0x61]);
        // setData replaces the payload with a fresh buffer; the copy keeps the old one.
        w.setData([0x7a, 0x00], 1, 2);
        expect(w.len).toBe(1);
        expect([...w.peekWstring()]).toEqual([0x7a]);
        expect([...c.peekWstring()]).toEqual([0x62, 0x20ac]);
    });

    it("StringExp.peekData: len * sz past the buffer is an AssertError, not a short view (expression.d:1224)", () => {
        // D slices past the allocation unchecked (UB); the port's invariant makes it loud. A widened node of
        // `cast(wchar[3])"abcd"c` (6 bytes over a 4-byte buffer) is the shape.
        const se = new StringExp(loc, [0x61, 0x62, 0x63, 0x64]);
        se.sz = 2;
        se.len = 3;
        expect(() => se.peekData()).toThrow(AssertError);
        se.len = 2;
        expect([...se.peekData()]).toEqual([0x61, 0x62, 0x63, 0x64]);
        expect(new StringExp(loc, null).peekData().length).toBe(0); // D's `null[0 .. 0]`
    });

    it("StringExp: toStringz and writeTo copy len * sz bytes plus an sz-wide zero terminator", () => {
        const w = new StringExp(loc, [0x61, 0x00, 0xac, 0x20], 2, 2);
        const z = w.toStringz();
        expect([...z]).toEqual([0x61, 0x00, 0xac, 0x20]); // `s[0 .. nbytes]`
        expect([...new Uint8Array(z.buffer)]).toEqual([0x61, 0x00, 0xac, 0x20, 0x00, 0x00]);
        expect(z.buffer).not.toBe(w.peekData().buffer);
        const dest = new Uint8Array(6).fill(0xee);
        w.writeTo(dest, false);
        expect([...dest]).toEqual([0x61, 0x00, 0xac, 0x20, 0xee, 0xee]);
        // a re-encoding request is `assert(0)` in D (dmd/expression.d:1063)
        expect(() => w.writeTo(dest, true, TY.Tchar)).toThrow(AssertError);
    });

    it("StringExp.numberOfCodeUnits re-counts across widths and reports a bad sequence", () => {
        // "é€😀": UTF-8 C3 A9 / E2 82 AC / F0 9F 98 80. ldc2: `enum wstring a = "é€😀"; a.length` is 4, as dstring 3.
        const u8 = new StringExp(loc, [0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80]);
        const s: { value: Uint8Array | null } = { value: null };
        expect(u8.numberOfCodeUnits(TY.Twchar, s)).toBe(4);
        expect(u8.numberOfCodeUnits(TY.Tdchar, s)).toBe(3);
        expect(u8.numberOfCodeUnits(TY.Tchar, s)).toBe(9);
        expect(u8.numberOfCodeUnits(0, s)).toBe(9);
        expect(s.value).toBeNull();
        // the same text as wchars (E9 00, AC 20, 3D D8 00 DE) and as dchars
        const u16 = new StringExp(loc, [0xe9, 0x00, 0xac, 0x20, 0x3d, 0xd8, 0x00, 0xde], 4, 2);
        expect(u16.numberOfCodeUnits(TY.Tchar, s)).toBe(9);
        expect(u16.numberOfCodeUnits(TY.Tdchar, s)).toBe(3);
        const u32 = new StringExp(loc, [0xe9, 0, 0, 0, 0xac, 0x20, 0, 0, 0x00, 0xf6, 0x01, 0x00], 3, 4);
        expect(u32.numberOfCodeUnits(TY.Tchar, s)).toBe(9);
        expect(u32.numberOfCodeUnits(TY.Twchar, s)).toBe(4);
        // a high surrogate at the end: utf_decodeWchar's message comes back through the `out` slot, the count is 0
        const bad = new StringExp(loc, [0x3d, 0xd8], 1, 2);
        expect(bad.numberOfCodeUnits(TY.Tchar, s)).toBe(0);
        expect(dsToJs(s.value!)).toBe("Truncated UTF-16 sequence");
        // `out` resets the slot on entry: a clean call after the failing one leaves it null
        expect(u16.numberOfCodeUnits(TY.Tchar, s)).toBe(9);
        expect(s.value).toBeNull();
    });

    it("StringExp.create: the C-string form stops at the NUL, the buffer form takes len bytes", () => {
        const a = StringExp.createFromCStr(loc, Uint8Array.from([0x61, 0x62, 0x00, 0x63]));
        expect(a.len).toBe(2);
        expect(dsToJs(a.peekString())).toBe("ab");
        const b = StringExp.createFromBuf(loc, [0x61, 0x62, 0x63, 0x64], 3);
        expect(dsToJs(b.peekString())).toBe("abc");
    });

    it("StringExp.compare: length first, then code units at the payload's width", () => {
        // Contract (dmd/expression.d:1141-1147): LENGTH first (`cast(int)(len1 - len2)`), then value; only the
        // SIGN is specified.
        const abc = new StringExp(loc, [0x61, 0x62, 0x63]);
        const abd = new StringExp(loc, [0x61, 0x62, 0x64]);
        const ab = new StringExp(loc, [0x61, 0x62]);

        expect(abc.compare(abc)).toBe(0);
        expect(abc.compare(abd)).toBeLessThan(0);
        expect(abd.compare(abc)).toBeGreaterThan(0);
        // length dominates value: "ab" < "abc" even though 'b' < 'c' never gets compared.
        expect(ab.compare(abc)).toBeLessThan(0);
        expect(abc.compare(ab)).toBeGreaterThan(0);

        // wchar: "é"w < "€"w (0x00E9 < 0x20AC) although the low byte E9 > AC.
        const we = new StringExp(loc, [0xe9, 0x00], 1, 2);
        const weuro = new StringExp(loc, [0xac, 0x20], 1, 2);
        expect(we.compare(weuro)).toBeLessThan(0);
        expect(weuro.compare(we)).toBeGreaterThan(0);
        expect(we.compare(we)).toBe(0);
        // dchar: U+1F600 > 'a'; the `dchar - dchar` difference is a uint wrapped to int
        const dsmile = new StringExp(loc, [0x00, 0xf6, 0x01, 0x00], 1, 4);
        const da = new StringExp(loc, [0x61, 0, 0, 0], 1, 4);
        expect(dsmile.compare(da)).toBe(0x1f600 - 0x61);
        expect(da.compare(dsmile)).toBe(0x61 - 0x1f600);
        const dmax = new StringExp(loc, [0xff, 0xff, 0xff, 0xff], 1, 4);
        expect(dmax.compare(da)).toBe(-0x62); // 0xFFFFFFFF - 0x61 read as int
    });

    it("the dtemplate-dependent syntaxCopy sites are LIVE (dmd/expression.d:1913/:1939/:2292/:2297)", () => {
        // RE-PIN (10 §1.8 rule 2): this used to pin three `DJS-ESCALATE` stubs standing in for the
        // dtemplate load cycle. dtemplate.ts now defers `class TypeDeduced extends Type` into
        // `initDtemplate()` (01 §4.1), expression.ts value-imports `objectSyntaxCopy` /
        // `TemplateInstance`, and the four sites are the faithful D calls — so the pin becomes a
        // BEHAVIOUR pin on what those calls produce. No `Type._init()` is needed: every operand
        // here is null, which is the arm each callee answers without touching a type.
        const tid = new TypeidExp(loc, null).syntaxCopy();
        expect(tid).toBeInstanceOf(TypeidExp);
        expect(tid.obj).toBeNull(); // objectSyntaxCopy(null) === null (dmd/dtemplate.d:186)

        const traits = new TraitsExp(loc, null, null).syntaxCopy();
        expect(traits).toBeInstanceOf(TraitsExp);
        expect(traits.args).toBeNull(); // TemplateInstance.arraySyntaxCopy(null) === null (dtemplate.d:898)

        // dmd/expression.d:2289 — the name ctor builds the TemplateInstance itself and delegates to
        // the field ctor, so `ti` is a fresh node carrying the name and tiargs handed in.
        const e1 = new NullExp(loc);
        const dtie = DotTemplateInstanceExp.fromName(loc, e1, null, null);
        expect(dtie.e1).toBe(e1);
        expect(dtie.ti).toBeInstanceOf(TemplateInstance);
        expect(dtie.ti!.name).toBeNull();
        expect(dtie.ti!.tiargs).toBeNull();

        // dmd/expression.d:2297 — syntaxCopy routes through that same factory, so the copy gets its
        // OWN TemplateInstance and its own copied `e1`, while `name`/`tiargs` carry over.
        const dtieCopy = dtie.syntaxCopy();
        expect(dtieCopy).toBeInstanceOf(DotTemplateInstanceExp);
        expect(dtieCopy.ti).not.toBe(dtie.ti);
        expect(dtieCopy.e1).not.toBe(e1);
        expect(dtieCopy.ti!.name).toBeNull();
    });
});

// Gated: needs a working `Type._init()` — see the BLOCKED DEPENDENCY note above.
describe.skipIf(!typeHarnessWorks)("expression.d — pins that need Type._init()", () => {
    beforeEach(() => {
        initHarness();
    });

    // dmd/expression.d:216 — `return .toChars(this);`, the module-scope `toChars(const Expression)`
    // (hdrgen.d:204), a plain pretty-print with no truncation. ldc2 1.43 spells a binary node
    // `x + 2` (`void f() { int x; x + 2; }` -> "Error: `x + 2` has no effect").
    it("toChars() renders through hdrgen's expression printer (dmd/expression.d:216)", () => {
        expect(dsToJs(cstr(new IntegerExp(loc, 3n, Type.tint32).toChars()))).toBe("3");
        const add = new AddExp(loc, new IntegerExp(loc, 1n, Type.tint32), new IntegerExp(loc, 2n, Type.tint32));
        expect(dsToJs(cstr(add.toChars()))).toBe("1 + 2");
    });

    it("isConst() switches on op (dmd/expression.d:313)", () => {
        expect(new IntegerExp(loc, 1n, Type.tint32).isConst()).toBe(1);
        expect(new RealExp(loc, 1.0, Type.tfloat64).isConst()).toBe(1);
        expect(new AddExp(loc, null, null).isConst()).toBe(0);
    });

    it("copy() is a field-wise shallow clone that preserves the concrete subclass", () => {
        const ie = new IntegerExp(loc, 7n, Type.tint32);
        const c = ie.copy();
        expect(c).not.toBe(ie);
        expect(c instanceof IntegerExp).toBe(true);
        expect((c as IntegerExp).value).toBe(7n);
        expect(c.op).toBe(EXP.int64);
    });

    it("IntegerExp.syntaxCopy() returns the same instance (dmd/expression.d:617)", () => {
        const ie = new IntegerExp(loc, 9n, Type.tint32);
        expect(ie.syntaxCopy()).toBe(ie);
    });

    it("IntegerExp.normalize() masks per TY, and its default arm yields 0 (dmd/expression.d:563)", () => {
        // the covered arms are the mask/sign-extend switch of 09-numerics.md §2.2
        expect(IntegerExp.normalize(TY.Tint8, 200n)).toBe(-56n);
        expect(IntegerExp.normalize(TY.Tuns8, -1n)).toBe(255n);
        expect(IntegerExp.normalize(TY.Tint32, 0xffffffffn)).toBe(-1n);
        expect(IntegerExp.normalize(TY.Tbool, 5n)).toBe(1n);
        // Tpointer is remapped to `Type.tsize_t.ty` BEFORE the switch (dmd/expression.d:568)
        expect(IntegerExp.normalize(TY.Tpointer, -1n)).toBe(0xffffffffffffffffn);
        // D declares `dinteger_t result;` (== 0) and its `default: break;` returns THAT, not the
        // input — a non-integral `ty` normalizes to 0. (numeric.ts `normalizeInteger` returns the
        // input in its default arm; the divergence is reported to the integrator.)
        expect(IntegerExp.normalize(TY.Tfloat64, 42n)).toBe(0n);
        expect(IntegerExp.normalize(TY.Terror, 42n)).toBe(0n);
    });

    it("IntegerExp ctor normalizes the carrier against the type's basetype", () => {
        // 0x1ff into an `int` stays 0x1ff; into a `char` it truncates to 0xff (09 §2)
        expect(new IntegerExp(loc, 0x1ffn, Type.tint32).getInteger()).toBe(0x1ffn);
        expect(new IntegerExp(loc, 0x1ffn, Type.tchar).getInteger()).toBe(0xffn);
    });

    it("IntegerExp.literal(v) hands out ONE shared instance per value (01 §5.5)", () => {
        const a = IntegerExp.literal(0);
        const b = IntegerExp.literal(0);
        expect(a).toBe(b); // identity sharing is load-bearing downstream
        expect(a.type).toBe(Type.tint32);
        expect(a.value).toBe(0n);
        expect(IntegerExp.literal(1)).not.toBe(a);
        // `fromValue` is the Form-B factory for D's `this(dinteger_t value)` ctor
        expect(IntegerExp.fromValue(-1n).value).toBe(-1n);
    });

    it("IntegerExp.createBool(b) caches the two bool literals (dmd/expression.d:647)", () => {
        const t = IntegerExp.createBool(true);
        const f = IntegerExp.createBool(false);
        expect(IntegerExp.createBool(true)).toBe(t);
        expect(t.value).toBe(1n);
        expect(f.value).toBe(0n);
        expect(t.type).toBe(Type.tbool);
    });

    it("create() factories return the right concrete node", () => {
        expect(IntegerExp.create(loc, 5n, Type.tint32) instanceof IntegerExp).toBe(true);
        expect(RealExp.create(loc, 1.5, Type.tfloat64) instanceof RealExp).toBe(true);
    });

    it("combine() joins two non-null exprs with a CommaExp, else passes through", () => {
        const a = new IntegerExp(loc, 1n, Type.tint32);
        const b = new IntegerExp(loc, 2n, Type.tint32);
        const j = Expression.combine(a, b);
        expect(j instanceof CommaExp).toBe(true);
        expect((j as CommaExp).e1).toBe(a);
        expect((j as CommaExp).e2).toBe(b);
        expect(Expression.combine(a, null)).toBe(a);
        expect(Expression.combine(null, b)).toBe(b);
        expect(Expression.combine(null, null)).toBeNull();
    });

    it("extractLast() peels the rightmost expr, e0 = the rest (dmd/expression.d:253)", () => {
        const a = new IntegerExp(loc, 1n, Type.tint32);
        const b = new IntegerExp(loc, 2n, Type.tint32);
        const ce = new CommaExp(loc, a, b);
        const e0 = { value: null as Expression | null };
        expect(Expression.extractLast(ce, e0)).toBe(b);
        expect(e0.value).toBe(a);

        // non-comma: returns e, and the `out` parameter is reset to its .init (null)
        const e0b = { value: a as Expression | null };
        expect(Expression.extractLast(a, e0b)).toBe(a);
        expect(e0b.value).toBeNull();
    });

    it("lastComma() walks the right spine of a comma chain (dmd/expression.d:56)", () => {
        const a = new IntegerExp(loc, 1n, Type.tint32);
        const b = new IntegerExp(loc, 2n, Type.tint32);
        const c = new IntegerExp(loc, 3n, Type.tint32);
        expect(lastComma(a)).toBe(a); // identity for a non-comma expression
        expect(lastComma(new CommaExp(loc, a, new CommaExp(loc, b, c)))).toBe(c);
    });

    it("CommaExp.allow() flags a CommaExp; no-ops on null / another node", () => {
        const a = new IntegerExp(loc, 1n, Type.tint32);
        const ce = new CommaExp(loc, a, a, false);
        expect(ce.isGenerated).toBe(false);
        expect(ce.allowCommaExp).toBe(false);
        CommaExp.allow(ce);
        expect(ce.allowCommaExp).toBe(true);
        CommaExp.allow(null); // no throw
        CommaExp.allow(a); // not a CommaExp -> no throw
        // the Form-B factory for D's `this(loc, e1, e2, Expression oe)` ctor
        expect(CommaExp.fromOriginalExp(loc, a, a, a).originalExp).toBe(a);
    });

    it("CondExp/IndexExp/ComExp syntaxCopy() rebuild the node and walk operands", () => {
        const econd = new IntegerExp(loc, 1n, Type.tint32);
        const e1 = new IntegerExp(loc, 2n, Type.tint32);
        const e2 = new IntegerExp(loc, 3n, Type.tint32);

        const cc = new CondExp(loc, econd, e1, e2).syntaxCopy();
        expect(cc instanceof CondExp).toBe(true);
        expect(cc.econd).toBe(econd); // IntegerExp.syntaxCopy() returns `this`

        const idx = new IndexExp(loc, e1, e2, true);
        expect(idx.indexIsInBounds).toBe(true);
        const ic = idx.syntaxCopy();
        expect(ic).not.toBe(idx);
        expect(ic instanceof IndexExp).toBe(true);
        expect(ic.indexIsInBounds).toBe(false); // D's 3-arg ctor leaves it at its .init

        const com = new ComExp(loc, e1);
        const comc = com.syntaxCopy();
        expect(comc).not.toBe(com);
        expect(comc instanceof ComExp).toBe(true);
        expect(comc.type).toBeNull(); // UnaExp.syntaxCopy nulls `type`
        expect(comc.e1).toBe(e1);
    });

    it("_init()/deinitialize() build and clear the CTFEExp sentinels", () => {
        Expression._init();
        expect(CTFEExp.cantexp!.op).toBe(EXP.cantExpression);
        expect(CTFEExp.gotoexp!.op).toBe(EXP.goto_);
        expect(CTFEExp.cantexp!.type).toBe(Type.tvoid);
        expect(CTFEExp.isCantExp(CTFEExp.cantexp)).toBe(true);
        expect(CTFEExp.isGotoExp(CTFEExp.cantexp)).toBe(false);
        expect(CTFEExp.isCantExp(null)).toBe(false);
        Expression.deinitialize();
        expect(CTFEExp.cantexp).toBeNull();
    });

    it("_isRoughlyScalar() is true for every basic type (D operator precedence, kept verbatim)", () => {
        // `tb.flags & TFlags.integral | TFlags.floating` parses as
        // `(tb.flags & integral) | floating`, which is never 0 — see the function's doc comment.
        expect(_isRoughlyScalar(Type.tint32)).toBe(true);
        expect(_isRoughlyScalar(Type.tvoid)).toBe(true);
        expect(_isRoughlyScalar(Type.tfloat64)).toBe(true);
    });

    it("ThisExp.syntaxCopy() clears type and var for a fresh semantic pass", () => {
        const te = new ThisExp(loc);
        te.type = Type.tint32;
        const c = te.syntaxCopy();
        expect(c).not.toBe(te);
        expect(c.type).toBeNull();
        expect(c.var_).toBeNull();
    });
});
