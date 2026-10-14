import { describe, it, expect } from "vitest";
import {
    Edition,
    MODFlags,
    STC,
    TY,
    TMAX,
    Tarray,
    Tnoreturn,
    Ttag,
    MATCH,
    isRefReturnScope,
    structalign_t,
    DArray,
} from "./astenums.js";

// NOTE: dmd/astenums.d contains NO in-source `unittest{}` blocks (10-tests-diagnostics.md §1 has
// nothing to port). This file is a PORT-GUARD, not a translated upstream unittest: it pins the
// load-bearing, easy-to-mis-fold values and the value-semantics that the rest of the frontend
// depends on. Every expected number/bigint here was verified against ldc2-1.42.0 (/tmp/p_astenums.d,
// /tmp/p_refret.d) — they are an ABI contract (STC indexes attribute logic; TY indexes type tables).

describe("astenums.d (port-guard)", () => {
    it("TY order is the verbatim ABI contract; TMAX = TY.max + 1", () => {
        expect(TY.Tarray).toBe(0);
        expect(TY.Tnoreturn).toBe(46);
        expect(TY.Ttag).toBe(47);
        expect(TMAX).toBe(48); // resolved: TY.max(47) + 1
    });

    it("TY symbol-aliases rebind to the same enum member values", () => {
        expect(Tarray).toBe(TY.Tarray);
        expect(Tnoreturn).toBe(TY.Tnoreturn);
        expect(Ttag).toBe(TY.Ttag);
    });

    it("MODFlags.wildconst folds to wild | const_ (== 9)", () => {
        expect(MODFlags.wildconst).toBe(MODFlags.wild | MODFlags.const_);
        expect(MODFlags.wildconst).toBe(9);
    });

    it("Edition auto-increments over an explicit start", () => {
        expect(Edition.v2023).toBe(2023);
        expect(Edition.v2024).toBe(2024);
        expect(Edition.v2025).toBe(2025);
    });

    it("MATCH.nomatch is the falsy zero member (used in boolean context)", () => {
        expect(MATCH.nomatch).toBe(0);
        expect(MATCH.exact).toBe(3);
    });

    it("STC is a bigint flag set; primitive members carry their bit", () => {
        expect(STC.static_).toBe(1n);
        expect(STC.scope_).toBe(0x8_0000n);
        // member exceeding 2^32 — proves the bigint requirement (TS enum could not hold it)
        expect(STC.alias_).toBe(0x1_0000_0000n);
        expect(STC.volatile_).toBe(0x40_0000_0000_0000n);
    });

    it("STC composite members fold to the verified ldc2 values", () => {
        expect(STC.safeGroup).toBe(STC.safe | STC.trusted | STC.system);
        expect(STC.safeGroup).toBe(0xe000000000n);
        expect(STC.IOR).toBe(STC.constscoperef | STC.in_ | STC.ref_ | STC.out_);
        expect(STC.IOR).toBe(0x51800n);
        expect(STC.TYPECTOR).toBe(STC.const_ | STC.immutable_ | STC.shared_ | STC.wild);
        expect(STC.TYPECTOR).toBe(0xa02000004n);
        expect(STC.FUNCATTR).toBe(0x1040f060040000n);
        expect(STC.visibleStorageClasses).toBe(0x1c42ffea2c3f9fn);
        expect(STC.flowThruAggregate).toBe(STC.safeGroup);
        // the only complement member: ~(...) masked to 64-bit unsigned (BigInt.asUintN(64,…))
        expect(STC.flowThruFunction).toBe(0xffffff011dd3fa60n);
        expect(STC.flowThruFunction).toBe(BigInt.asUintN(64, ~0x000000fee22c059fn));
    });

    it("isRefReturnScope: true iff (scope & return) and (ref | out)", () => {
        expect(isRefReturnScope(STC.scope_ | STC.return_ | STC.ref_)).toBe(true);
        expect(isRefReturnScope(STC.scope_ | STC.return_ | STC.out_)).toBe(true);
        expect(isRefReturnScope(STC.scope_ | STC.return_)).toBe(false); // no ref/out
        expect(isRefReturnScope(STC.ref_)).toBe(false); // no scope+return
        expect(isRefReturnScope(0n)).toBe(false);
    });

    it("structalign_t: value/flags state machine + truncating set()", () => {
        const a = new structalign_t();
        expect(a.isUnknown()).toBe(true);
        expect(a.isDefault()).toBe(false);
        a.setDefault();
        expect(a.isDefault()).toBe(true);
        expect(a.get()).toBe(1234); // STRUCTALIGN_DEFAULT
        a.set(0x1_0008); // cast(ushort) -> low 16 bits == 8
        expect(a.get()).toBe(8);
        expect(a.isPack()).toBe(false);
        a.setPack();
        expect(a.isPack()).toBe(true);
        expect(a.fromAlignas()).toBe(false);
        a.setAlignas();
        expect(a.fromAlignas()).toBe(true);
        a.setUnknown();
        expect(a.isUnknown()).toBe(true);
    });

    it("structalign_t.copy(): independent value copy (value-struct semantics)", () => {
        const a = new structalign_t();
        a.set(7);
        a.setPack();
        const b = a.copy();
        a.set(99);
        a.setAlignas();
        expect(b.get()).toBe(7); // unaffected by mutating a
        expect(b.isPack()).toBe(true);
        expect(b.fromAlignas()).toBe(false); // a.setAlignas() did not reach b
    });

    it("DArray.copy(): shares the backing slice (reference-like T[])", () => {
        const a = new DArray<number>();
        a.data = [1, 2, 3];
        const b = a.copy();
        expect(b.data).toBe(a.data); // same backing store, per 03 §2 array-field rule
    });
});
