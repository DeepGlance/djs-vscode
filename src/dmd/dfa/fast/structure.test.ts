// Tests for src/dmd/dfa/fast/structure.ts (ported from dmd/dfa/fast/structure.d, LDC 1.43.0).
//
// dmd/dfa/fast/structure.d ships no `unittest{}` block (10 §1). These pin the behaviours whose D semantics are
// not obvious from the TS text:
//   1. DFAPAValue arithmetic and lattice ops: the rows below are ldc2's own output. The D struct was compiled
//      standalone with ldc2 1.43.0 -O3 -release on arm64 (a stub Type carrying `ty` and typesem's isUnsigned) and
//      run over 131,750 (op, type, a, b) cases; the port matches every one. The pinned subset keeps the edges:
//      D's int promotions, shift counts taken modulo the width, arm64 division/remainder, pow modulo 2^64.
//   2. the allocator: bump addresses by T.sizeof from the static region, free-list reuse of the SAME node
//      (re-initialized, no bump), overflow into a malloc'd region (file header of structure.ts).
//   3. the ownership protocol of DFALatticeRef / DFAScopeRef (copy moves, opAssign destroys the old value,
//      by-value parameters destroyed by the callee), including swapLattice's null-result quirk.
//   4. scope push/pop, acquireScopeVar's copy-down, the bucket iteration order, variable identity, and the
//      join/meet write-count rules.

import { beforeEach, describe, expect, test } from "vitest";

// FIRST on purpose: this import makes structure.ts the module that enters the graph (01 §4.8).
import {
    DFAAllocator, DFACommon, DFALatticeRef, DFAPAValue, DFAScopeRef, DFAScopeVarMergable, DFAVar, Nullable,
    Truthiness, Unknown,
} from "./structure.js";
import type { Ref } from "./structure.js";
import { Type, TypeBasic } from "../../mtype.js";
import { STC, TY } from "../../astenums.js";
import { VarDeclaration } from "../../declaration.js";
import { FuncDeclaration } from "../../func.js";
import { Identifier } from "../../identifier.js";
import { Id } from "../../id.js";
import { Loc } from "../../location.js";
import { CompoundDeclarationStatement, CompoundStatement, ExpStatement, LabelStatement } from "../../statement.js";
import type { Statement } from "../../statement.js";
import { Array as DArray } from "../../root/array.js";
import { pointerTo, sarrayOf } from "../../typesem.js";
import { ds } from "../../../dstring.js";
import { initSemaHarness } from "../../../sema-harness.js";

beforeEach(() => {
    initSemaHarness();
});

/// The static region's link address in the ldc2 1.43.0 binary (nm) and the Region header size.
const STATIC_REGION = 0x1_076c_73c8;
const REGION_HEADER = 24;

function mkCommon(): DFACommon {
    const c = new DFACommon();
    c.allocator.dfaCommon = c; // entry.d:120
    return c;
}

function mkFunc(): FuncDeclaration {
    return new FuncDeclaration(Loc.initial, Loc.initial, Identifier.idPool(ds("f")), STC.none, null);
}

function mkVar(name: string, type: Type, stc: STC = STC.none,
        parent: FuncDeclaration | null = mkFunc()): VarDeclaration {
    const vd = new VarDeclaration(Loc.initial, type, Identifier.idPool(ds(name)), null, stc);
    vd.parent = parent;
    return vd;
}

describe("DFAPAValue arithmetic (structure.d:2996-3694), ldc2 rows", () => {
    // [op, type, a, b, kind, value]; kind: 0 Unknown, 1 UnknownUpperPositive, 4 Concrete.
    const rows: [string, TY, bigint, bigint, number, bigint][] = [
        ["shl", TY.Tint32, 1n, 32n, 4, 1n],                         // count modulo 32 (arm64 lsl)
        ["shl", TY.Tint32, 1n, 40n, 4, 256n],
        ["shl", TY.Tint8, 1n, 200n, 4, 256n],                       // cast(byte) 200 = -56, & 31 = 8, int result
        ["shl", TY.Tint64, 1n, 64n, 4, 1n],
        ["shl", TY.Tuns32, 1n, 31n, 4, 2147483648n],                // uint, zero-extended
        ["shl", TY.Tuns64, 1n, 63n, 4, -9223372036854775808n],      // ulong reinterpreted as long
        ["shr", TY.Tint8, -128n, 200n, 4, -1n],
        ["shr", TY.Tuns64, -1n, 1n, 4, 9223372036854775807n],       // logical for unsigned types
        ["ushr", TY.Tint32, -1n, 8n, 4, 16777215n],
        ["ushr", TY.Tint8, -1n, 1n, 4, 127n],
        ["ushr", TY.Tint64, -1n, 63n, 4, 1n],
        ["mul", TY.Tuns16, 65535n, 65535n, 4, -131071n],            // ushort * ushort computes in int
        ["mul", TY.Tint32, 2147483647n, 2n, 4, -2n],
        ["mul", TY.Tuns64, 4294967296n, 4294967296n, 1, 4294967296n],
        ["mul", TY.Tint64, 4294967296n, 4294967296n, 4, 0n],
        ["div", TY.Tint32, -2147483648n, -1n, 4, -2147483648n],    // arm64 sdiv wraps
        ["div", TY.Tint64, -9223372036854775808n, -1n, 0, -9223372036854775808n],
        ["div", TY.Tint8, 5n, 256n, 0, 5n],                         // divisor truncates to 0: Unknown
        ["div", TY.Tuns64, -1n, 2n, 4, 9223372036854775807n],
        ["mod", TY.Tint8, 5n, 256n, 4, 5n],                         // remainder by a truncated 0 = dividend
        ["mod", TY.Tint32, -2147483648n, -1n, 4, 0n],
        ["mod", TY.Tint8, -128n, 3n, 4, -2n],
        ["mod", TY.Tuns32, 7n, 4294967296n, 4, 7n],
        ["add", TY.Tuns64, 9223372036854775807n, 1n, 1, 9223372036854775807n],
        ["add", TY.Tint32, 2147483647n, 1n, 4, -2147483648n],
        ["add", TY.Tuns32, 4294967295n, 1n, 4, 0n],
        ["add", TY.Tint8, 127n, 1n, 4, 128n],                       // byte + byte computes in int
        ["add", TY.Tbool, 1n, 1n, 0, 1n],                           // unsigned, not integral in the switch
        ["add", TY.Tfloat64, 1n, 1n, 0, 1n],
        ["sub", TY.Tuns8, 1n, 2n, 0, 1n],
        ["sub", TY.Tint16, -32768n, 1n, 4, -32769n],
        ["sub", TY.Tuns32, 0n, 1n, 0, 0n],
        ["neg", TY.Tint32, -2147483648n, 0n, 4, -2147483648n],
        ["neg", TY.Tuns32, 1n, 0n, 4, 4294967295n],
        ["neg", TY.Tuns8, 200n, 0n, 4, -200n],
        ["inv", TY.Tuns32, 0n, 0n, 4, 4294967295n],
        ["inv", TY.Tuns8, 0n, 0n, 4, -1n],
        ["inv", TY.Tint16, 32767n, 0n, 4, -32768n],
        ["pow", TY.Tuns64, 3n, 40n, 1, 3n],                         // 3^40 > long.max
        ["pow", TY.Tuns64, 3n, 64n, 4, 8733086111712066817n],       // 3^64 mod 2^64
        ["pow", TY.Tint8, 2n, 7n, 4, -128n],
        ["pow", TY.Tuns16, 2n, 16n, 4, 0n],
        ["pow", TY.Tint32, 0n, 7n, 4, 0n],
        ["pow", TY.Tint32, -1n, 0n, 4, 1n],
        ["pow", TY.Tint32, 7n, 1n, 4, 7n],
        ["and", TY.Tint8, -1n, 255n, 4, -1n],
        ["or", TY.Tuns64, -9223372036854775808n, 1n, 4, -9223372036854775807n],
        ["xor", TY.Tint16, 32767n, -1n, 4, -32768n],
    ];

    for (const [op, ty, a, b, kind, value] of rows) {
        test(`${op} ${TY[ty]} ${a} ${b} -> ${kind} ${value}`, () => {
            const type = new TypeBasic(ty);
            const x = DFAPAValue.fromLong(a), y = DFAPAValue.fromLong(b);
            switch (op) {
            case "shl": x.leftShiftBy(y, type); break;
            case "shr": x.rightShiftSignedBy(y, type); break;
            case "ushr": x.rightShiftUnsignedBy(y, type); break;
            case "mul": x.multiplyFrom(y, type); break;
            case "div": x.divideFrom(y, type); break;
            case "mod": x.modulasFrom(y, type); break;
            case "add": x.addFrom(y, type); break;
            case "sub": x.subtractFrom(y, type); break;
            case "neg": x.negate(type); break;
            case "inv": x.bitwiseInvert(type); break;
            case "pow": x.powerBy(y, type); break;
            case "and": x.bitwiseAndBy(y, type); break;
            case "or": x.bitwiseOrBy(y, type); break;
            case "xor": x.bitwiseXorBy(y, type); break;
            default: throw new Error(op);
            }
            expect([x.kind, x.value]).toEqual([kind, value]);
        });
    }

    test("canFitIn: range of the integral type, false for other types (ldc2 rows)", () => {
        expect(DFAPAValue.fromLong(256n).canFitIn(new TypeBasic(TY.Tuns8))).toBe(false);
        expect(DFAPAValue.fromLong(-128n).canFitIn(new TypeBasic(TY.Tint8))).toBe(true);
        expect(DFAPAValue.fromLong(-1n).canFitIn(new TypeBasic(TY.Tuns64))).toBe(false);
        expect(DFAPAValue.fromLong(-9223372036854775808n).canFitIn(new TypeBasic(TY.Tint64))).toBe(true);
        expect(DFAPAValue.fromLong(1n).canFitIn(new TypeBasic(TY.Tbool))).toBe(false);
        const upper = DFAPAValue.fromKind(DFAPAValue.Kind.UnknownUpperPositive);
        expect(upper.canFitIn(new TypeBasic(TY.Tint64))).toBe(false);
    });
});

describe("DFAPAValue lattice (structure.d:2831-2994), ldc2 rows", () => {
    const K = DFAPAValue.Kind;
    const mk = (k: DFAPAValue.Kind, v: bigint): DFAPAValue => {
        const x = DFAPAValue.fromKind(k);
        x.value = v;
        return x;
    };

    // [a.kind, a.value, b.kind, b.value, opCmp, meet, join, eq, ne, gt (ret, this, other), ge (ret, this, other)]
    type PA = [DFAPAValue.Kind, bigint];
    const rows: [PA, PA, number, PA, PA, Truthiness, Truthiness, [Truthiness, PA, PA], [Truthiness, PA, PA]][] = [
        [[K.Concrete, 5n], [K.Concrete, -1n], 1, [K.Unknown, 0n], [K.Concrete, 5n], Truthiness.False, Truthiness.True,
            [Truthiness.True, [K.Lower, 5n], [K.Unknown, 0n]], [Truthiness.True, [K.Lower, 5n], [K.Unknown, 0n]]],
        [[K.UnknownUpperPositive, 5n], [K.Concrete, 5n], -1, [K.Unknown, 0n], [K.Concrete, 5n], Truthiness.False,
            Truthiness.Maybe, [Truthiness.Maybe, [K.Lower, 6n], [K.Unknown, 0n]],
            [Truthiness.Maybe, [K.UnknownUpperPositive, 5n], [K.Unknown, 0n]]],
        [[K.Concrete, 0n], [K.UnknownUpperPositive, 0n], 1, [K.Unknown, 0n], [K.Concrete, 0n], Truthiness.False,
            Truthiness.Maybe, [Truthiness.False, [K.Unknown, 0n], [K.Unknown, 0n]],
            [Truthiness.False, [K.Unknown, 0n], [K.Unknown, 0n]]],
        [[K.Lower, 9223372036854775807n], [K.Lower, 5n], 0, [K.Unknown, 0n], [K.Lower, 5n], Truthiness.Maybe,
            Truthiness.Maybe, [Truthiness.Maybe, [K.Lower, 5n], [K.Unknown, 0n]],
            [Truthiness.Maybe, [K.Lower, 9223372036854775807n], [K.Unknown, 0n]]],
        [[K.Unknown, -1n], [K.Unknown, -1n], 0, [K.Unknown, 0n], [K.Unknown, -1n], Truthiness.Unknown,
            Truthiness.Unknown, [Truthiness.Maybe, [K.Unknown, -1n], [K.Unknown, 0n]],
            [Truthiness.Maybe, [K.Unknown, 0n], [K.Unknown, 0n]]],
    ];

    for (const [a, b, cmp, meet, join, eq, ne, gt, ge] of rows) {
        test(`${K[a[0]]} ${a[1]} vs ${K[b[0]]} ${b[1]}`, () => {
            const x = mk(...a), y = mk(...b);
            expect(x.opCmp(y)).toBe(cmp);
            const m = x.meet(y.copy()), j = x.join(y.copy());
            expect([m.kind, m.value]).toEqual(meet);
            expect([j.kind, j.value]).toEqual(join);
            expect(x.compareEqual(y)).toBe(eq);
            expect(x.compareNotEqual(y)).toBe(ne);
            {
                const p = x.copy(), q = y.copy();
                const r = p.greaterThan(q); // `q` is a `ref` parameter: narrowed in place
                expect([r, [p.kind, p.value], [q.kind, q.value]]).toEqual(gt);
            }
            {
                const p = x.copy(), q = y.copy();
                const r = p.greaterThanOrEqual(q);
                expect([r, [p.kind, p.value], [q.kind, q.value]]).toEqual(ge);
            }
        });
    }

    test("meet/join return fresh values, never an alias of an operand or of the frozen Unknown", () => {
        const x = DFAPAValue.fromLong(5n);
        const m = x.meet(x.copy());
        expect(m).not.toBe(x);
        expect(m.kind).toBe(K.Concrete);
        const u = x.meet(DFAPAValue.fromLong(6n));
        expect(u).not.toBe(Unknown);
        u.kind = K.Lower; // a caller may mutate what it got back
        expect(Unknown.kind).toBe(K.Unknown);
        expect(() => { (Unknown as DFAPAValue).kind = K.Concrete; }).toThrow(TypeError);
    });
});

describe("DFAAllocator (structure.d:933)", () => {
    test("nodes are carved at T.sizeof steps from the static region, whatever their type", () => {
        const c = mkCommon();
        const v1 = c.allocator.makeVar(null);
        const l = c.allocator.makeLattice(c);
        const s = c.allocator.makeScope(c, null);
        const v2 = c.allocator.makeVar(null);
        expect(v1.addr).toBe(STATIC_REGION + REGION_HEADER);
        expect(l.addr).toBe(v1.addr + 264);
        expect(s.addr).toBe(l.addr + 176);
        expect(v2.addr).toBe(s.addr + 248);
        // a new allocator (the next function) starts at the static region again
        expect(mkCommon().allocator.makeVar(null).addr).toBe(STATIC_REGION + REGION_HEADER);
    });

    test("a freed node is handed out again, re-initialized, without advancing the bump pointer", () => {
        const c = mkCommon();
        const v = c.allocator.makeVar(null);
        const lr = c.makeLatticeRef();
        const lattice = lr.lattice!;
        const cons = lr.addConsequence(v)!;
        cons.truthiness = Truthiness.True;
        lr.__dtor();
        expect(lr.isNull()).toBe(true);

        const lr2 = c.makeLatticeRef();
        expect(lr2.lattice).toBe(lattice);
        expect(lattice.context).toBe(null);
        const again = c.allocator.makeConsequence(null);
        expect(again).toBe(cons);
        expect(again.truthiness).toBe(Truthiness.Unknown);
        expect(again.var).toBe(null);
        // only v, the lattice and the consequence were ever carved
        expect(c.allocator.makeVar(null).addr).toBe(v.addr + 264 + 176 + 96);
    });

    test("a full region continues in a malloc'd region, chained and reused by the next run", () => {
        const carve = (): DFAVar[] => {
            const c = mkCommon();
            const vars: DFAVar[] = [];
            for (let i = 0; i < 497; i++)
                vars.push(c.allocator.makeVar(null));
            return vars;
        };
        const first = carve();
        // (131072 - 24) / 264 -> 496 variables fit (`regionUsed + T.sizeof >= length` moves on)
        expect(first[495].addr).toBe(STATIC_REGION + REGION_HEADER + 264 * 495);
        expect(first[496].addr).toBeGreaterThan(STATIC_REGION + 131072);
        expect(first[496].addr % 16).toBe(8); // a 16-aligned malloc block plus the 24-byte header
        const second = carve();
        expect(second[496].addr).toBe(first[496].addr);
        DFAAllocator.deinitialize();
    });

    test("variables join the allocated list newest first; allocatedVariablesAllUnmodellable marks them all", () => {
        const c = mkCommon();
        const a = c.allocator.makeVar(null), b = c.allocator.makeVar(null);
        const seen: DFAVar[] = [];
        c.allocator.allVariables((v) => { seen.push(v); });
        expect(seen).toEqual([b, a]);
        c.allocatedVariablesAllUnmodellable();
        expect(a.unmodellable && b.unmodellable).toBe(true);
    });
});

describe("ownership protocol of DFALatticeRef / DFAScopeRef (structure.d:1679, :2185)", () => {
    test("a copy moves the lattice; opAssign destroys the old value; the dtor is inert the second time", () => {
        const c = mkCommon();
        const a = c.makeLatticeRef();
        const lattice = a.lattice;
        const b = new DFALatticeRef(a);
        expect(a.isNull()).toBe(true);
        expect(b.lattice).toBe(lattice);

        const x = c.makeLatticeRef();
        const old = x.lattice;
        x.opAssign(new DFALatticeRef(b)); // D `x = b;`
        expect(b.isNull()).toBe(true);
        expect(x.lattice).toBe(lattice);
        expect(c.allocator.makeLattice(c)).toBe(old); // the old value went to the free list

        x.__dtor();
        x.__dtor();
        expect(x.isNull()).toBe(true);
    });

    test("assignLattice destroys its by-value parameter when the handle is null (the lattice is freed)", () => {
        const c = mkCommon();
        const lr = c.makeLatticeRef();
        const lattice = lr.lattice;
        expect(new DFAScopeRef().assignLattice(c.allocator.makeVar(null), lr)).toBe(null);
        expect(lr.isNull()).toBe(true);
        expect(c.allocator.makeLattice(c)).toBe(lattice);
    });

    test("swapLattice moves the old lattice into the delegate; a null result leaves the scope variable null", () => {
        const c = mkCommon();
        c.pushScope();
        const v = c.findVariable(mkVar("x", Type.tint32))!;
        const scv = c.acquireScopeVar(v)!;
        const before = scv.lr.lattice;

        let nullDuring = false;
        const got = c.swapLattice(v, (lr: DFALatticeRef): DFALatticeRef => {
            try {
                nullDuring = scv.lr.isNull();
                expect(lr.lattice).toBe(before);
                return new DFALatticeRef();
            } finally {
                lr.__dtor(); // a by-value parameter is destroyed by the callee
            }
        });
        expect(got).toBe(scv);
        expect(nullDuring).toBe(true);
        expect(scv.lr.isNull()).toBe(true);

        // returning the parameter (moved) keeps the lattice (a fresh variable: acquireScopeVar asserts that a
        // scope variable it finds holds a lattice)
        const w = c.findVariable(mkVar("y", Type.tint32))!;
        const scw = c.acquireScopeVar(w)!;
        const kept = scw.lr.lattice;
        c.swapLattice(w, (lr: DFALatticeRef): DFALatticeRef => {
            try {
                return new DFALatticeRef(lr);
            } finally {
                lr.__dtor();
            }
        });
        expect(scw.lr.lattice).toBe(kept);
        expect(scw.lr.getContextVar()).toBe(w);
    });

    test("destroying a popped scope frees it and its scope variables", () => {
        const c = mkCommon();
        c.pushScope();
        c.pushScope();
        const inner = c.currentDFAScope!;
        const scv = c.acquireScopeVar(c.allocator.makeVar(null))!;
        const r = c.popScope();
        expect(r.sc).toBe(inner);
        r.__dtor();
        expect(r.isNull()).toBe(true);
        c.pushScope();
        expect(c.currentDFAScope).toBe(inner); // reused from the free list
        expect(c.allocator.makeScopeVar(c, null)).toBe(scv);
    });
});

describe("scopes (structure.d:168-217, :772)", () => {
    test("push links parent and child, inherits inConditional, counts depth; pop detaches and unwinds labels", () => {
        const c = mkCommon();
        c.pushScope();
        const s1 = c.currentDFAScope!;
        expect(s1.depth).toBe(1);
        s1.inConditional = true;
        c.pushScope();
        const s2 = c.currentDFAScope!;
        expect([s2.depth, s2.parent, s1.child, s2.inConditional]).toEqual([2, s1, s2, true]);
        c.setScopeAsLoopyLabel();
        c.setScopeAsCatch();
        expect([c.lastLoopyLabel, c.lastCatch]).toEqual([s2, s2]);

        const r = c.popScope();
        expect([r.sc, s2.parent, s1.child, c.currentDFAScope]).toEqual([s2, null, null, s1]);
        expect([c.lastLoopyLabel, c.lastCatch]).toEqual([null, null]);
    });

    test("acquireScopeVar copies the nearest enclosing state into every scope down to the current one", () => {
        const c = mkCommon();
        c.pushScope();
        const v = c.findVariable(mkVar("x", Type.tint32))!;
        const outer = c.acquireScopeVar(v)!;
        outer.lr.getContext()!.truthiness = Truthiness.True;
        outer.mergable.nullAssignWriteCount = 3;
        c.pushScope();
        c.pushScope();
        const inner = c.acquireScopeVar(v)!;
        expect(inner).not.toBe(outer);
        expect(inner.lr.lattice).not.toBe(outer.lr.lattice);
        expect(inner.lr.getContext()!.truthiness).toBe(Truthiness.True);
        expect(inner.mergable.nullAssignWriteCount).toBe(3);
        expect(inner.mergable).not.toBe(outer.mergable);
        expect(c.currentDFAScope!.parent!.findScopeVar(v)).not.toBe(null);
        // a variable declared deeper than the current scope is not visible
        v.declaredAtDepth = 9;
        expect(c.acquireScopeVar(v)).toBe(null);
    });

    test("a scope visits its variables by (address % 16, address); consumeNext drains in that order", () => {
        const c = mkCommon();
        const vars: DFAVar[] = [];
        for (let i = 0; i < 12; i++)
            vars.push(c.allocator.makeVar(null));
        c.pushScope();
        const sc = c.currentDFAScope!;
        for (const v of [...vars].reverse())
            sc.getScopeVar(v);
        const expected = [...vars].sort((a, b) => (a.addr % 16) - (b.addr % 16) || a.addr - b.addr);
        expect(new Set(vars.map((v) => v.addr % 16)).size).toBeGreaterThan(1); // DFAVar.sizeof = 264 alternates

        const seen: (DFAVar | null)[] = [];
        sc.opApply_DFAVar_DFALattice((v) => { seen.push(v); return 0; });
        expect(seen).toEqual(expected);

        const copy = sc.copy();
        const copied: (DFAVar | null)[] = [];
        copy.opApply_DFAVar_DFALattice((v) => { copied.push(v); return 0; });
        expect(copied).toEqual(expected);

        const drained: (DFAVar | null)[] = [];
        const r = c.popScope();
        const cv: Ref<DFAVar | null> = { value: null };
        const m: Ref<DFAScopeVarMergable> = { value: new DFAScopeVarMergable() };
        for (;;) {
            const lr = r.consumeNext(cv, m);
            if (cv.value === null)
                break;
            drained.push(cv.value);
            expect(lr.getContextVar()).toBe(cv.value);
            lr.__dtor();
        }
        expect(drained).toEqual(expected);
    });

    test("findScopeGivenLabel: the labelled scope, the control scope, the root control scope for a stranger", () => {
        const c = mkCommon();
        const L = Identifier.idPool(ds("L")), M = Identifier.idPool(ds("M"));
        c.pushScope();
        const s1 = c.currentDFAScope!;
        s1.controlStatement = new ExpStatement(Loc.initial, null);
        c.pushScope();
        const s2 = c.currentDFAScope!;
        s2.label = new LabelStatement(Loc.initial, L, null);
        c.pushScope();
        expect(c.findScopeGivenLabel(L)).toBe(s2);
        expect(c.findScopeGivenLabel(null)).toBe(s1);
        expect(c.findScopeGivenLabel(M)).toBe(s1);
    });

    test("findScopeHeadOfLabelStatement looks from the statement in progress on; a CompoundDeclaration faults", () => {
        const c = mkCommon();
        const L = Identifier.idPool(ds("L"));
        const stmts = new DArray<Statement | null>();
        stmts.push(new LabelStatement(Loc.initial, L, null));
        c.pushScope();
        const sc = c.currentDFAScope!;
        sc.compoundStatement = new CompoundStatement(Loc.initial, stmts);
        expect(c.findScopeHeadOfLabelStatement(L)).toBe(sc);
        sc.inProgressCompoundStatement = 1;
        expect(c.findScopeHeadOfLabelStatement(L)).toBe(null);

        // D reads a CompoundDeclaration through isCompoundStatement (null for it) and dereferences it
        const decl = new DArray<Statement | null>();
        decl.push(new CompoundDeclarationStatement(Loc.initial, new DArray<Statement | null>()));
        sc.compoundStatement = new CompoundStatement(Loc.initial, decl);
        sc.inProgressCompoundStatement = 0;
        expect(() => c.findScopeHeadOfLabelStatement(L)).toThrow(TypeError);
    });
});

describe("variables (structure.d:219-387, :3988)", () => {
    test("findVariable is unique per declaration; __dollar is unmodellable", () => {
        const c = mkCommon();
        const vd = mkVar("x", Type.tint32);
        const a = c.findVariable(vd)!;
        expect(c.findVariable(vd)).toBe(a);
        expect(c.findVariable(null)).toBe(null);
        expect(a.unmodellable).toBe(false);
        const dollar = new VarDeclaration(Loc.initial, Type.tsize_t, Id.dollar!, null);
        dollar.parent = mkFunc();
        expect(c.findVariable(dollar)!.unmodellable).toBe(true);
        // a field variable is created once per (base, field) and carries the field's offset
        const field = mkVar("f", Type.tint32);
        field.offset = 8;
        const f = c.findVariable(field, a)!;
        expect(c.findVariable(field, a)).toBe(f);
        expect([f.base1, f.offsetFromBase]).toEqual([a, 8n]);
    });

    test("findVariablePair never finds an earlier pair (base1 is never set): every call is a fresh variable", () => {
        const c = mkCommon();
        const a = c.allocator.makeVar(null), b = c.allocator.makeVar(null);
        a.haveInfiniteLifetime = true;
        const p1 = c.findVariablePair(a, b)!, p2 = c.findVariablePair(b, a)!;
        expect(p1).not.toBe(p2);
        expect([p1.base1, p1.base2, p1.haveInfiniteLifetime]).toEqual([null, null, false]);
        b.haveInfiniteLifetime = true;
        expect(c.findVariablePair(a, b)!.haveInfiniteLifetime).toBe(true);
        expect([c.findVariablePair(a, null), c.findVariablePair(null, b), c.findVariablePair(a, a)]).toEqual([a, b, a]);
    });

    test("offset variables are unique per offset and chained in ascending offset order", () => {
        const c = mkCommon();
        const base = c.allocator.makeVar(null);
        const o8 = c.findOffsetVar(8n, base)!, o0 = c.findOffsetVar(0n, base)!;
        expect(c.findOffsetVar(8n, base)).toBe(o8);
        expect([base.childOffsetVars, o0.next, o0.base1, o8.offsetFromBase]).toEqual([o0, o8, base, 8n]);
        expect(c.findDereferenceVar(base)).toBe(c.findDereferenceVar(base));
        expect(c.findIndexVar(base)!.isAnIndex).toBe(true);
        expect(c.findSliceLengthVar(base)!.isLength).toBe(true);
    });

    test("applyType: type flags, and unmodellable outside a function or for static / manifest storage", () => {
        const c = mkCommon();
        const i = c.findVariable(mkVar("i", Type.tint32))!;
        expect([i.isTruthy, i.isNullable, i.isBoolean, i.unmodellable]).toEqual([true, false, false, false]);
        expect(c.findVariable(mkVar("p", pointerTo(Type.tint32)))!.isNullable).toBe(true);
        expect(c.findVariable(mkVar("r", Type.tint32, STC.ref_))!.isNullable).toBe(true);
        expect(c.findVariable(mkVar("b", Type.tbool))!.isBoolean).toBe(true);
        expect(c.findVariable(mkVar("d", Type.tfloat64))!.isFloatingPoint).toBe(true);
        const sa = c.findVariable(mkVar("sa", sarrayOf(Type.tint32, 2n)))!;
        expect([sa.isStaticArray, sa.isTruthy]).toEqual([true, false]);
        expect(c.findVariable(mkVar("s", Type.tint32, STC.static_))!.unmodellable).toBe(true);
        expect(c.findVariable(mkVar("m", Type.tint32, STC.manifest))!.unmodellable).toBe(true);
        expect(c.findVariable(mkVar("g", Type.tint32, STC.none, null))!.unmodellable).toBe(true);
    });
});

describe("lattices (structure.d:2449)", () => {
    test("consequences iterate newest first, then the constant; copy keeps the context", () => {
        const c = mkCommon();
        const v1 = c.allocator.makeVar(null), v2 = c.allocator.makeVar(null);
        const lr = c.makeLatticeRef();
        const c1 = lr.addConsequence(v1)!, c2 = lr.addConsequence(v2)!, k = lr.addConsequence(null)!;
        expect(lr.addConsequence(v1)).toBe(c1);
        const order: (DFAVar | null)[] = [];
        lr.opApply((x) => { order.push(x.var); return 0; });
        expect(order).toEqual([v2, v1, null]);
        expect(lr.findConsequence(null)).toBe(k);
        expect(lr.haveNonContext()).toBe(true);

        lr.setContext(c1);
        const cp = lr.copy();
        expect(cp.getContextVar()).toBe(v1);
        expect(cp.getContext()).not.toBe(c1);
        const vars: (DFAVar | null)[] = [];
        cp.opApply((x) => { vars.push(x.var); return 0; });
        expect(vars).toEqual([v2, v1, null]);
        expect(c2.var).toBe(v2);
    });

    test("copyWithoutInfiniteLifetime drops those variables; a dropped context falls back to the constant", () => {
        const c = mkCommon();
        const v1 = c.allocator.makeVar(null), v2 = c.allocator.makeVar(null);
        v2.haveInfiniteLifetime = true;
        const lr = c.makeLatticeRef();
        lr.addConsequence(v1);
        lr.setContextFromDFAVar(v2);
        const cw = lr.copyWithoutInfiniteLifetime();
        expect(cw.findConsequence(v2)).toBe(null);
        expect(cw.findConsequence(v1)).not.toBe(null);
        const ctx = cw.getContext()!;
        expect([ctx.var, ctx.truthiness, ctx.nullable]).toEqual([null, Truthiness.Unknown, Nullable.Unknown]);
    });

    test("cleanupConstant frees the constant; a constant context is replaced by the REUSED node", () => {
        const c = mkCommon();
        const v = c.allocator.makeVar(null);
        const lr = c.makeLatticeRef();
        const k = lr.acquireConstantAsContextTruthiness(Truthiness.True, Nullable.NonNull, null);
        lr.cleanupConstant(v);
        expect(lr.getContext()).toBe(k);
        expect([k.var, k.truthiness]).toEqual([v, Truthiness.Unknown]);
        expect(lr.findConsequence(null)).toBe(null);
        const out: Ref<DFAVar | null> = { value: null };
        expect(lr.getContext(out)).toBe(k);
        expect(out.value).toBe(v);
    });
});

describe("join and meet of consequences (structure.d:3753, :3838)", () => {
    type Consequence = ReturnType<DFAAllocator["makeConsequence"]>;
    const setup = (): { c: DFACommon; v: DFAVar; mk: (t: Truthiness, n: Nullable, w: number) => Consequence } => {
        const c = mkCommon();
        const v = c.findVariable(mkVar("p", pointerTo(Type.tint32)))!; // truthy and nullable
        v.writeCount = 1;
        const mk = (t: Truthiness, n: Nullable, w: number) => {
            const x = c.allocator.makeConsequence(v);
            x.truthiness = t;
            x.nullable = n;
            x.writeOnVarAtThisPoint = w;
            return x;
        };
        return { c, v, mk };
    };

    test("meet takes the lower facts of two current consequences, Maybe degrading to Unknown", () => {
        const { mk } = setup();
        const r = mk(Truthiness.Unknown, Nullable.Unknown, 0);
        r.meetConsequence(mk(Truthiness.True, Nullable.NonNull, 1), mk(Truthiness.False, Nullable.Null, 1));
        expect([r.truthiness, r.nullable]).toEqual([Truthiness.False, Nullable.Null]);
        r.meetConsequence(mk(Truthiness.Maybe, Nullable.NonNull, 1), mk(Truthiness.True, Nullable.NonNull, 1));
        expect(r.truthiness).toBe(Truthiness.Unknown);
        r.meetConsequence(mk(Truthiness.True, Nullable.NonNull, 1), mk(Truthiness.True, Nullable.Null, 1), true);
        expect([r.truthiness, r.nullable]).toEqual([Truthiness.True, Nullable.Unknown]);
    });

    test("meet ignores a stale second consequence (written before the variable's write count)", () => {
        const { mk } = setup();
        const r = mk(Truthiness.Unknown, Nullable.Unknown, 0);
        r.meetConsequence(mk(Truthiness.True, Nullable.NonNull, 1), mk(Truthiness.False, Nullable.Null, 0));
        expect([r.truthiness, r.nullable, r.writeOnVarAtThisPoint]).toEqual([Truthiness.True, Nullable.NonNull, 1]);
    });

    test("join takes the current second consequence, or the higher facts when forced", () => {
        const { mk } = setup();
        const r = mk(Truthiness.Unknown, Nullable.Unknown, 0);
        r.joinConsequence(mk(Truthiness.True, Nullable.NonNull, 1), mk(Truthiness.False, Nullable.Null, 1), null,
            false);
        expect([r.truthiness, r.nullable]).toEqual([Truthiness.False, Nullable.Null]);
        r.joinConsequence(mk(Truthiness.True, Nullable.Null, 1), mk(Truthiness.False, Nullable.NonNull, 1), null, false,
            true);
        expect([r.truthiness, r.nullable]).toEqual([Truthiness.True, Nullable.NonNull]);
        r.joinConsequence(mk(Truthiness.Unknown, Nullable.Unknown, 1), mk(Truthiness.False, Nullable.Null, 1), null,
            false, true, true);
        expect([r.truthiness, r.nullable]).toEqual([Truthiness.Unknown, Nullable.Unknown]);
    });
});
