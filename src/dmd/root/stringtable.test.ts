import { describe, it, expect } from "vitest";
import { StringTable, StringValue } from "./stringtable.js";
import { ds, dsEquals } from "../../dstring.js";

// Behavioral / contract tests for the hand-written StringTable (08 §5). The engine-internal
// DMD unittests (capacity growth, slot layout) are DROPPED per the root-runtime exemption
// (00 §0.1 / 10-tests-diagnostics.md); the OBSERVABLE-contract unittests are ported here:
//   - stringtable.d:316 — same-text/different-pointer insert, no-clobber, lookup, update(null).
//   - stringtable.d:348 — 2000-entry insert/lookup stress (byte-keying over raw bytes incl NUL).
//   - stringtable.d:370 — apply/opApply summation + early-stop, order "not specified".

describe("StringTable — lookup / insert (no-clobber) — port of stringtable.d:316", () => {
    it("first insert returns the entry; the entry carries value + key bytes", () => {
        // T = const(char)* modeled as DString. D's `foo.ptr` is the value here.
        const tab = new StringTable<Uint8Array>();
        tab._init(10); // no-op capacity hint — kept for fidelity

        const fooBuffer = ds("foofoo");
        const foo = fooBuffer.subarray(0, 3); // "foo" — one buffer region
        const fooAltPtr = fooBuffer.subarray(3, 6); // "foo" — SAME text, DIFFERENT object

        // Different objects, identical bytes (the D test's `foo.ptr != fooAltPtr.ptr` premise).
        expect(foo).not.toBe(fooAltPtr);
        expect(dsEquals(foo, fooAltPtr)).toBe(true);

        const inserted = tab.insert(foo, foo);
        expect(inserted).not.toBeNull();
        expect(inserted!.value).toBe(foo); // insert returns the entry; value is what we passed
    });

    it("subsequent insert of the same TEXT returns null (no-clobber), keyed by bytes not identity", () => {
        const tab = new StringTable<Uint8Array>();
        const fooBuffer = ds("foofoo");
        const foo = fooBuffer.subarray(0, 3);
        const fooAltPtr = fooBuffer.subarray(3, 6);

        expect(tab.insert(foo, foo)).not.toBeNull();
        // Re-insert with a DIFFERENT DString object of identical bytes → null (already interned).
        expect(tab.insert(fooAltPtr, foo)).toBeNull();
        // And the original entry is untouched (no clobber): its value is still the first `foo`.
        expect(tab.lookup(ds("foo"))!.value).toBe(foo);
    });

    it("lookup finds by bytes; entry exposes len()/toString()/toDchars()", () => {
        const tab = new StringTable<Uint8Array>();
        const fooBuffer = ds("foofoo");
        const foo = fooBuffer.subarray(0, 3);
        tab.insert(foo, foo);

        const sv = tab.lookup(ds("foo")); // a fresh, independent "foo" DString
        expect(sv).not.toBeNull();
        expect(sv!.value).toBe(foo);
        expect(sv!.len()).toBe(3);
        expect(dsEquals(sv!.toString(), ds("foo"))).toBe(true);
        expect(dsEquals(sv!.toDchars(), ds("foo"))).toBe(true);
    });

    it("lookup of an absent key returns null", () => {
        const tab = new StringTable<Uint8Array>();
        tab.insert(ds("foo"), ds("foo"));
        expect(tab.lookup(ds("bar"))).toBeNull();
    });

    it("reset() empties the table (lookup → null afterwards)", () => {
        const tab = new StringTable<Uint8Array>();
        tab.insert(ds("foo"), ds("foo"));
        expect(tab.lookup(ds("foo"))).not.toBeNull();
        tab.reset(0);
        expect(tab.lookup(ds("foo"))).toBeNull();
    });
});

describe("StringTable — update (insert-or-get, T.init supplied by caller) — port of stringtable.d:316", () => {
    it("update on an ABSENT key inserts with the caller-supplied default and never returns null", () => {
        // D: `tab.update("bar")` then `tab.lookup("bar").value == null`. For T = const(char)*,
        // T.init = null (ldc2-verified). The caller supplies that default (08 §5 special-case-at-T).
        const tab = new StringTable<Uint8Array | null>();
        expect(tab.lookup(ds("bar"))).toBeNull();
        const sv = tab.update(ds("bar"), null);
        expect(sv).not.toBeNull(); // update NEVER returns null
        expect(sv.value).toBeNull(); // the inserted default
        expect(tab.lookup(ds("bar"))!.value).toBeNull();
    });

    it("update on a PRESENT key returns the existing entry and ignores `init`", () => {
        const tab = new StringTable<number>();
        const first = tab.insert(ds("x"), 7)!;
        const got = tab.update(ds("x"), 999); // 999 must be ignored — key already present
        expect(got).toBe(first);
        expect(got.value).toBe(7);
    });

    it("update default works for value-type T (int → 0, bool → false) supplied by the caller", () => {
        const ti = new StringTable<number>();
        expect(ti.update(ds("n"), 0).value).toBe(0); // int.init = 0 (ldc2-verified)
        const tb = new StringTable<boolean>();
        expect(tb.update(ds("b"), false).value).toBe(false); // bool.init = false (ldc2-verified)
    });

    it("a second update of the same key does not re-create the entry", () => {
        const tab = new StringTable<number>();
        const a = tab.update(ds("k"), 0);
        a.value = 42; // value is a public mutable field (08 §5)
        const b = tab.update(ds("k"), 0);
        expect(b).toBe(a);
        expect(b.value).toBe(42); // the in-place mutation survives
    });
});

describe("StringTable — byte keying (raw bytes, incl NUL/0xFF) — port of stringtable.d:348", () => {
    it("keys distinct 2-byte sequences (including embedded NUL and high bytes) without collision", () => {
        // Mirrors the D 2000-entry stress test: buf[i*2]=i%256, buf[i*2+1]=i/256, insert value i.
        const tab = new StringTable<number>();
        const testCount = 2000;
        const buf = new Uint8Array(2 * testCount);
        for (let i = 0; i < testCount; i++) {
            buf[i * 2 + 0] = i % 256;
            buf[i * 2 + 1] = Math.floor(i / 256);
            tab.insert(buf.subarray(i * 2, i * 2 + 2), i);
        }
        for (let i = 0; i < testCount; i++) {
            const sv = tab.lookup(buf.subarray(i * 2, i * 2 + 2));
            expect(sv).not.toBeNull();
            expect(sv!.value).toBe(i);
        }
    });

    it("a NUL byte is part of the key, not a terminator", () => {
        const tab = new StringTable<number>();
        const a = new Uint8Array([0x61, 0x00, 0x62]); // "a\0b"
        const b = new Uint8Array([0x61]); // "a"
        tab.insert(a, 1);
        tab.insert(b, 2);
        expect(tab.lookup(new Uint8Array([0x61, 0x00, 0x62]))!.value).toBe(1);
        expect(tab.lookup(new Uint8Array([0x61]))!.value).toBe(2);
        // The NUL-bearing key is NOT truncated to "a": the two are distinct entries.
        expect(tab.lookup(new Uint8Array([0x61, 0x00, 0x62]))!.value).not.toBe(2);
    });

    it("two byte sequences differing only past a NUL are distinct keys", () => {
        const tab = new StringTable<number>();
        tab.insert(new Uint8Array([0x78, 0x00, 0x01]), 10); // "x\0\x01"
        tab.insert(new Uint8Array([0x78, 0x00, 0x02]), 20); // "x\0\x02"
        expect(tab.lookup(new Uint8Array([0x78, 0x00, 0x01]))!.value).toBe(10);
        expect(tab.lookup(new Uint8Array([0x78, 0x00, 0x02]))!.value).toBe(20);
    });
});

describe("StringTable — key bytes are an independent copy (08 §5)", () => {
    it("mutating the caller's buffer after insert does NOT change the interned key", () => {
        const tab = new StringTable<number>();
        const transient = ds("abc");
        tab.insert(transient, 1);
        transient[0] = 0x7a; // mutate the source buffer to "zbc" AFTER interning
        // The original key "abc" still resolves; "zbc" was never inserted.
        expect(tab.lookup(ds("abc"))!.value).toBe(1);
        expect(tab.lookup(ds("zbc"))).toBeNull();
    });

    it("the entry's own bytes are not aliased to the caller's buffer", () => {
        const tab = new StringTable<number>();
        const transient = ds("abc");
        const sv = tab.insert(transient, 1)!;
        transient[1] = 0x7a; // "azc"
        expect(dsEquals(sv.toString(), ds("abc"))).toBe(true); // entry unchanged
    });
});

describe("StringTable — apply / opApply (sum + early stop) — port of stringtable.d:370", () => {
    it("apply and opApply both visit every entry (value sum = 10)", () => {
        const tab = new StringTable<number>();
        tab.insert(ds("foo"), 4);
        tab.insert(ds("bar"), 6);

        let sumFp = 0;
        const rFp = tab.apply((sv: StringValue<number>) => {
            sumFp += sv.value;
            return 0; // never stop
        });
        let sumDg = 0;
        const rDg = tab.opApply((sv: StringValue<number>) => {
            sumDg += sv.value;
            return 0;
        });
        expect(rFp).toBe(0);
        expect(rDg).toBe(0);
        expect(sumFp).toBe(10);
        expect(sumDg).toBe(10);
    });

    it("apply/opApply stop on the first non-zero return and return that value (14 or 16)", () => {
        // D's stringtable.d:386 — with returnImmediately the callback returns the first value seen
        // (4 or 6) and iteration stops; the running sum is 4+? but the test asserts 14 or 16 because
        // the prior full pass left it at 10. We reproduce the early-stop contract directly: the
        // RETURN value is the callback's value (truthy → stop), and only one entry was visited.
        const tab = new StringTable<number>();
        tab.insert(ds("foo"), 4);
        tab.insert(ds("bar"), 6);

        let visited = 0;
        const r = tab.apply((sv: StringValue<number>) => {
            visited++;
            return sv.value; // first non-zero stops; returns that value
        });
        expect(visited).toBe(1); // stopped after the very first entry
        // Insertion order is "foo" then "bar"; JS Map iterates insertion order → first is "foo"=4.
        expect(r).toBe(4);
    });

    it("apply returns 0 over an empty table", () => {
        const tab = new StringTable<number>();
        let called = 0;
        const r = tab.apply(() => {
            called++;
            return 1;
        });
        expect(called).toBe(0);
        expect(r).toBe(0);
    });
});

describe("StringTable — iteration order is INSERTION order (08 §5 FLAG decision)", () => {
    it("apply visits entries in insertion order (JS Map default)", () => {
        // DMD's order is bucket-order and "not specified" (stringtable.d:407); djs commits to
        // insertion order. This test pins THAT decision so a regression is visible.
        const tab = new StringTable<number>();
        const names = ["delta", "alpha", "charlie", "bravo"]; // deliberately NOT sorted
        names.forEach((n, i) => tab.insert(ds(n), i));

        const seen: number[] = [];
        tab.apply((sv: StringValue<number>) => {
            seen.push(sv.value);
            return 0;
        });
        expect(seen).toEqual([0, 1, 2, 3]); // values 0..3 in the order inserted
    });

    it("re-inserting an existing key (no-clobber) does not move it in iteration order", () => {
        const tab = new StringTable<number>();
        tab.insert(ds("a"), 0);
        tab.insert(ds("b"), 1);
        expect(tab.insert(ds("a"), 99)).toBeNull(); // no-clobber, position unchanged

        const seen: string[] = [];
        tab.apply((sv: StringValue<number>) => {
            seen.push(String.fromCharCode(...sv.toString()));
            return 0;
        });
        expect(seen).toEqual(["a", "b"]); // "a" stays first; its value stays 0
        expect(tab.lookup(ds("a"))!.value).toBe(0);
    });
});
