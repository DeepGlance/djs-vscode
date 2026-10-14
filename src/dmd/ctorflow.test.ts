// Tests for src/dmd/ctorflow.ts.
//
// dmd/ctorflow.d ships NO in-source `unittest{}` block, so there is nothing to port 1:1 (10 §1).
// These are GOAL tests (protect the flow-analysis achievement):
// the `mergeCallSuper` / `mergeFieldInit` truth tables and the CtorFlow value-struct semantics
// (deep `clone()` vs shallow `copy()`, `orCSX`, `OR`, `allocFieldinit`).
//
// Every merge expectation below is the EXACT output of ldc2-1.42.0 running the original D
// `mergeCallSuper`/`mergeFieldInit` (probe /tmp/ctorflow_truth.d) — the port matches the compiler
// we target byte-for-byte (00 §2). CSX numeric values: this=1 super=2 label=4 return_=8 any=16 halt=32.

import { describe, expect, test } from "vitest";
import { CSX, FieldInit, CtorFlow, mergeCallSuper, mergeFieldInit, type Ref } from "./ctorflow.js";
import { Loc } from "./location.js";

describe("CSX flag values (ctorflow.d:19)", () => {
    test("the flag bits match the upstream layout", () => {
        expect(CSX.none).toBe(0);
        expect(CSX.this_ctor).toBe(0x01);
        expect(CSX.super_ctor).toBe(0x02);
        expect(CSX.label).toBe(0x04);
        expect(CSX.return_).toBe(0x08);
        expect(CSX.any_ctor).toBe(0x10);
        expect(CSX.halt).toBe(0x20);
    });
});

describe("mergeCallSuper (ldc2-verified truth table)", () => {
    // [a0, b, expectedReturn, expectedA] — exact ldc2 output (/tmp/ctorflow_truth.d).
    const cases: [CSX, CSX, boolean, CSX][] = [
        [CSX.none, CSX.none, true, CSX.none], //                       b == a fast path
        [CSX.any_ctor | CSX.this_ctor, CSX.return_, false, CSX.any_ctor | CSX.this_ctor], // a ctor, b ret no-ctor
        [CSX.return_, CSX.any_ctor | CSX.this_ctor, false, CSX.return_], //                 symmetric
        [CSX.halt, CSX.halt, true, CSX.halt], //                       both halt -> a = halt
        [CSX.halt, CSX.any_ctor | CSX.label | CSX.this_ctor, true, 21 as CSX], // aHalt: a = b | (a & (any|label)) = 21
        [CSX.this_ctor, CSX.super_ctor, true, CSX.this_ctor], //       aAll == bAll, merge (b & (any|label)) == 0
        [CSX.this_ctor | CSX.any_ctor, CSX.none, false, CSX.this_ctor | CSX.any_ctor], //   aAll != bAll -> false
        [CSX.return_ | CSX.halt, CSX.any_ctor | CSX.label, true, CSX.any_ctor | CSX.label], // bHalt-or-bRet&bAll branch
    ];

    for (const [a0, b, expR, expA] of cases) {
        test(`a0=${a0} b=${b} -> r=${expR ? 1 : 0} a=${expA}`, () => {
            const a: Ref<CSX> = { value: a0 };
            const r = mergeCallSuper(a, b);
            expect(r).toBe(expR);
            expect(a.value).toBe(expA);
        });
    }
});

describe("mergeFieldInit (ldc2-verified truth table)", () => {
    const cases: [CSX, CSX, boolean, CSX][] = [
        [CSX.none, CSX.none, true, CSX.none], //                       b == a fast path
        [CSX.halt, CSX.halt, true, CSX.halt], //                       both halt -> a = halt, true
        [CSX.return_ | CSX.this_ctor, CSX.this_ctor, true, CSX.this_ctor], // a ret, b not -> a = b, ok = a&this
        [CSX.this_ctor, CSX.return_, false, CSX.this_ctor], //         b ret, ok = b&this (=0) -> false
        [CSX.this_ctor, CSX.super_ctor, false, CSX.this_ctor | CSX.super_ctor], // neither ret/halt: ok=!((a^b)&this); a|=b
        [CSX.halt | CSX.this_ctor, CSX.super_ctor, false, CSX.super_ctor], // aHalt: ok=b&this(=0)->false, a=b
    ];

    for (const [a0, b, expR, expA] of cases) {
        test(`a0=${a0} b=${b} -> r=${expR ? 1 : 0} a=${expA}`, () => {
            const a: Ref<CSX> = { value: a0 };
            const r = mergeFieldInit(a, b);
            expect(r).toBe(expR);
            expect(a.value).toBe(expA);
        });
    }
});

describe("FieldInit value-struct semantics (03 §2)", () => {
    test("default-init: csx = none, loc is the unset/default Loc", () => {
        const fi = new FieldInit();
        expect(fi.csx).toBe(CSX.none);
        expect(fi.loc.isValid()).toBe(false);
    });

    test("copy() is a deep, independent clone (mutating the copy leaves the source untouched)", () => {
        const fi = new FieldInit();
        fi.csx = CSX.this_ctor;
        const c = fi.copy();
        c.csx |= CSX.label;
        expect(fi.csx).toBe(CSX.this_ctor); // source unchanged
        expect(c.csx).toBe(CSX.this_ctor | CSX.label);
        expect(c.loc).not.toBe(fi.loc); // loc is a recursively-copied value struct, not shared
    });
});

describe("CtorFlow", () => {
    test("allocFieldinit creates `dim` independent zero-initialized FieldInit entries", () => {
        const cf = new CtorFlow();
        cf.allocFieldinit(3);
        expect(cf.fieldinit.length).toBe(3);
        for (const fi of cf.fieldinit) {
            expect(fi.csx).toBe(CSX.none);
            expect(fi.loc.isValid()).toBe(false);
        }
        // distinct objects (not the same FieldInit shared three times)
        expect(cf.fieldinit[0]).not.toBe(cf.fieldinit[1]);
    });

    test("freeFieldinit empties the slice (mem.xfree erased under GC)", () => {
        const cf = new CtorFlow();
        cf.allocFieldinit(2);
        cf.freeFieldinit();
        expect(cf.fieldinit.length).toBe(0);
    });

    test("orCSX sets bits on callSuper AND every fieldinit element", () => {
        const cf = new CtorFlow();
        cf.allocFieldinit(2);
        cf.orCSX(CSX.this_ctor);
        cf.orCSX(CSX.any_ctor);
        expect(cf.callSuper).toBe(CSX.this_ctor | CSX.any_ctor);
        for (const fi of cf.fieldinit) {
            expect(fi.csx).toBe(CSX.this_ctor | CSX.any_ctor);
        }
    });

    test("clone() deep-copies fieldinit (mutating the clone's elements does not touch the source)", () => {
        const cf = new CtorFlow();
        cf.allocFieldinit(2);
        cf.orCSX(CSX.this_ctor);
        cf.callSuper |= CSX.super_ctor;

        const cl = cf.clone();
        expect(cl.callSuper).toBe(cf.callSuper);
        expect(cl.fieldinit.length).toBe(2);
        // independent backing + independent elements (arraydup of value structs, verified ldc2)
        expect(cl.fieldinit).not.toBe(cf.fieldinit);
        expect(cl.fieldinit[0]).not.toBe(cf.fieldinit[0]);

        cl.fieldinit[0].csx |= CSX.label;
        expect(cf.fieldinit[0].csx).toBe(CSX.this_ctor); // source element untouched
        expect(cl.fieldinit[0].csx).toBe(CSX.this_ctor | CSX.label);
    });

    test("copy() shares the fieldinit slice (shallow struct copy, 03 §2) — distinct from clone()", () => {
        const cf = new CtorFlow();
        cf.allocFieldinit(1);
        const sh = cf.copy();
        expect(sh.fieldinit).toBe(cf.fieldinit); // slice backing SHARED on a plain struct copy
    });

    test("OR merges callSuper bits and fills unset element locs from the other path", () => {
        const a = new CtorFlow();
        a.allocFieldinit(2);
        a.callSuper = CSX.this_ctor;

        const b = new CtorFlow();
        b.allocFieldinit(2);
        b.callSuper = CSX.super_ctor;
        b.fieldinit[0].csx = CSX.label;
        // give b's element 0 a *valid* loc; a's element 0 loc is unset, so OR copies it over.
        const validLoc = Loc.singleFilename(new Uint8Array([0x66, 0x2e, 0x64])); // "f.d"
        b.fieldinit[0].loc = validLoc.copy();

        a.OR(b);

        expect(a.callSuper).toBe(CSX.this_ctor | CSX.super_ctor);
        expect(a.fieldinit[0].csx).toBe(CSX.label); // OR'd in from b
        expect(a.fieldinit[0].loc.isValid()).toBe(true); // unset a.loc filled from b.loc
        // OR copies the loc by value (03 §1#5) — not the same object reference as b's.
        expect(a.fieldinit[0].loc).not.toBe(b.fieldinit[0].loc);
    });

    test("OR is a no-op on fieldinit when either side is empty (length guard)", () => {
        const a = new CtorFlow();
        a.callSuper = CSX.this_ctor;
        const b = new CtorFlow();
        b.allocFieldinit(3);
        b.callSuper = CSX.label;
        a.OR(b); // a.fieldinit empty -> only callSuper merges
        expect(a.callSuper).toBe(CSX.this_ctor | CSX.label);
        expect(a.fieldinit.length).toBe(0);
    });
});
