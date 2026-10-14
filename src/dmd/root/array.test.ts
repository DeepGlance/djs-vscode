// Contract tests for the Array!T port (docs/porting/08-runtime-lib.md §2).
// Behavioural expectations mirror the array.d unittest blocks (array.d:392-435, :695-788) which
// run against ldc2-1.42.0 (DMD 2.112.1); edge cases (SIZE_MAX sentinel, grow-without-prefill,
// expansion-safe each!) come from 08 §2.0a/§2.4/§2.6.

import { describe, it, expect } from "vitest";

import { DError } from "../../assert.js";
import { SIZE_MAX } from "../../numeric.js";
import { ds, dsToJs } from "../../dstring.js";
// The harness imports ./dmd/parse.js first: the module-graph root (10 §1.5).
import { initSemaHarness } from "../../sema-harness.js";
import { IntegerExp, ArgumentLabel } from "../expression.js";
import type { Expression } from "../expression.js";
import { Loc } from "../location.js";
import { Type } from "../mtype.js";
import { RootObject } from "../rootobject.js";
import {
    Array, toCharsArgumentLabels, toStringArgumentLabels, toCharsExpressions, toStringExpressions, toCharsObjects,
    toStringObjects, peekSlice, split, reverse,
} from "./array.js";

describe("Array — length / opDollar / grow-without-prefill (08 §2.0a)", () => {
    it("empty by default; push grows length", () => {
        const a = new Array<number>();
        expect(a.length).toBe(0);
        a.push(10).push(20);
        expect(a.length).toBe(2);
    });

    it("pre-sized ctor grows length without pre-filling slots (no generic T.init)", () => {
        const a = new Array<number>(3);
        expect(a.length).toBe(3);
        // Slots are JS holes — undefined, NOT a synthesized default (08 §2.0a).
        expect(a.opIndex(0)).toBeUndefined();
    });

    it("setDim / length setter grow without prefill and shrink by truncation", () => {
        const a = new Array<number>();
        a.push(1).push(2).push(3);
        a.setDim(5); // grow
        expect(a.length).toBe(5);
        expect(a.opIndex(4)).toBeUndefined(); // new slot is a hole
        a.length = 2; // shrink
        expect(a.length).toBe(2);
        expect(a.opSlice()).toEqual([1, 2]);
    });

    it("opDollar equals length", () => {
        const a = Array.from(1, 2, 3, 4);
        expect(a.opDollar()).toBe(4);
        expect(a.opDollar()).toBe(a.length);
    });

    it("negative dim / length / count are rejected loudly (boundary-validation.md)", () => {
        expect(() => new Array<number>(-1)).toThrow(DError);
        const a = new Array<number>();
        expect(() => (a.length = -1)).toThrow(DError);
        expect(() => a.insert(0, -2, 9)).toThrow(DError);
    });
});

describe("Array — opIndex / opIndexAssign with bounds asserts (08 §2.0c)", () => {
    it("reads and writes through value-first opIndexAssign(v, i)", () => {
        const a = Array.from(0, 0, 0);
        a.opIndexAssign(15, 2); // arr[2] = 15
        expect(a.opIndex(2)).toBe(15);
    });

    it("out-of-range index throws (loud, not silent)", () => {
        const a = Array.from(1, 2);
        expect(() => a.opIndex(2)).toThrow(DError);
        expect(() => a.opIndex(-1)).toThrow(DError);
        expect(() => a.opIndexAssign(9, 5)).toThrow(DError);
    });
});

describe("Array — push / pushSlice / append / shift chaining (08 §2.1)", () => {
    it("push returns this for chaining", () => {
        const a = new Array<number>();
        const r = a.push(1).push(2).push(3);
        expect(r).toBe(a);
        expect(a.opSlice()).toEqual([1, 2, 3]);
    });

    it("pushSlice appends a plain slice and returns this", () => {
        const a = new Array<number>();
        const r = a.pushSlice([10, 15, 20]);
        expect(r).toBe(a);
        expect(a.opSlice()).toEqual([10, 15, 20]);
    });

    it("append concatenates another Array; null is a no-op", () => {
        const a = Array.from(1, 2);
        const b = Array.from(3, 4);
        a.append(b).append(null);
        expect(a.opSlice()).toEqual([1, 2, 3, 4]);
    });

    it("shift prepends at index 0", () => {
        const a = Array.from(2, 3);
        a.shift(1);
        expect(a.opSlice()).toEqual([1, 2, 3]);
    });
});

describe("Array — remove / pop (08 §2.1)", () => {
    // Mirrors array.d:392-435 (double-array unittest), adapted: shift+push then mutate.
    it("remove deletes at index, shifting tail left", () => {
        const a = Array.from(10, 99, 15, 20);
        a.remove(1);
        expect(a.length).toBe(3);
        expect(a.opSlice()).toEqual([10, 15, 20]);
    });

    it("pop removes and returns the last element", () => {
        const a = Array.from(10, 15, 20);
        expect(a.pop()).toBe(20);
        expect(a.length).toBe(2);
    });

    it("pop on empty throws (asserts non-empty)", () => {
        expect(() => new Array<number>().pop()).toThrow(DError);
    });

    it("remove out of range throws", () => {
        expect(() => Array.from(1).remove(1)).toThrow(DError);
    });
});

describe("Array — insert four overloads (08 §2.2, array.d:695-731)", () => {
    it("(index, T) single element", () => {
        const a = Array.from(10, 15, 20);
        a.insert(1, 30 as number); // single element overload
        expect(a.opIndex(1)).toBe(30);
        expect(a.opIndex(2)).toBe(15);
    });

    it("(index, T[]) slice — exact array.d:725-731 sequence", () => {
        const a = new Array<number>();
        a.pushSlice([5, 6]);
        a.insert(1, [1, 2]);
        expect(a.opSlice()).toEqual([5, 1, 2, 6]);
        a.insert(0, [7, 8]);
        expect(a.opSlice()).toEqual([7, 8, 5, 1, 2, 6]);
        a.insert(a.length, [0, 9]);
        expect(a.opSlice()).toEqual([7, 8, 5, 1, 2, 6, 0, 9]);
    });

    it("(index, Array) — splices another Array's elements (array.d:712)", () => {
        const a = Array.from(10, 15, 20);
        const b = Array.from(100, 200);
        a.insert(0, b);
        expect(a.opSlice()).toEqual([100, 200, 10, 15, 20]);
    });

    it("(index, count, value) — count copies, exact array.d:732-739 sequence", () => {
        const a = Array.from(7, 8, 5, 1, 2, 6, 0, 9);
        a.insert(4, 3, 8); // 3 copies of 8 at index 4
        expect(a.opSlice()).toEqual([7, 8, 5, 1, 8, 8, 8, 2, 6, 0, 9]);
        a.insert(0, 3, 8);
        expect(a.opSlice()).toEqual([8, 8, 8, 7, 8, 5, 1, 8, 8, 8, 2, 6, 0, 9]);
        a.insert(a.length, 3, 8);
        expect(a.opSlice()).toEqual([8, 8, 8, 7, 8, 5, 1, 8, 8, 8, 2, 6, 0, 9, 8, 8, 8]);
    });

    it("(index, count=0, value) is a no-op (array.d:269)", () => {
        const a = Array.from(1, 2);
        a.insert(1, 0, 9);
        expect(a.opSlice()).toEqual([1, 2]);
    });

    it("(index, null) is a no-op (array.d:236)", () => {
        const a = Array.from(1, 2);
        a.insert(1, null);
        expect(a.opSlice()).toEqual([1, 2]);
    });

    it("insert index out of range throws", () => {
        expect(() => Array.from(1).insert(5, 9 as number)).toThrow(DError);
    });
});

describe("Array — copy is shallow into a fresh Array (08 §2.3)", () => {
    it("copies element slots into a new container (distinct backing data)", () => {
        const a = Array.from(10, 15, 20);
        const b = a.copy();
        expect(b).not.toBe(a);
        expect(b.opSlice()).toEqual(a.opSlice());
        expect(b.tdata()).not.toBe(a.tdata()); // array.d:704 `arrayPtr.tdata != arrayA.tdata`
        // Mutating the copy does not affect the original.
        b.opIndexAssign(99, 0);
        expect(a.opIndex(0)).toBe(10);
    });

    it("for class refs copies the REFERENCE, not the pointee (shallow)", () => {
        const o1 = { tag: 1 };
        const o2 = { tag: 2 };
        const a = Array.from(o1, o2);
        const b = a.copy();
        expect(b.opIndex(0)).toBe(o1); // same object reference, not a clone
        b.opIndex(0).tag = 7; // mutation visible through both — confirms shallow
        expect(a.opIndex(0).tag).toBe(7);
    });
});

describe("Array — find / contains identity + SIZE_MAX sentinel (08 §2.4)", () => {
    it("find returns the index of an identity match", () => {
        const a = Array.from(10, 15, 20);
        expect(a.find(15)).toBe(1);
        expect(a.find(10)).toBe(0);
    });

    it("find returns SIZE_MAX (not -1-as-index) when absent", () => {
        const a = Array.from(10, 15, 20);
        expect(a.find(99)).toBe(SIZE_MAX);
        // The contract test is the equality comparison the frontend uses (`i != size_t.max`).
        expect(a.find(99) === SIZE_MAX).toBe(true);
        expect(a.find(15) !== SIZE_MAX).toBe(true);
    });

    it("find uses identity (===) for class refs, not structural equality", () => {
        const o1 = { v: 1 };
        const o1bis = { v: 1 }; // equal-by-value but a DIFFERENT object
        const a = Array.from(o1);
        expect(a.find(o1)).toBe(0);
        expect(a.find(o1bis)).toBe(SIZE_MAX); // distinct identity → not found
    });

    it("contains is find(v) !== SIZE_MAX", () => {
        const a = Array.from(10, 15, 20);
        expect(a.contains(15)).toBe(true);
        expect(a.contains(99)).toBe(false);
    });
});

describe("Array — opSlice / tdata (08 §2.1, §2.8)", () => {
    it("opSlice() views the whole array; opSlice(a,b) views a sub-range", () => {
        const a = Array.from(7, 8, 5, 1, 2, 6, 0, 9);
        expect(a.opSlice()).toEqual([7, 8, 5, 1, 2, 6, 0, 9]);
        expect(a.opSlice(3, 6)).toEqual([1, 2, 6]); // arrayA[3..6]
    });

    it("opSlice(a,b) asserts 0 <= a <= b <= length (array.d:346)", () => {
        const a = Array.from(1, 2, 3);
        expect(() => a.opSlice(2, 1)).toThrow(DError);
        expect(() => a.opSlice(0, 4)).toThrow(DError);
    });

    it("tdata returns the live backing array (a reference, not a copy)", () => {
        const a = Array.from(1, 2, 3);
        const d = a.tdata();
        d[0] = 99; // mutation visible on the Array (matches D `data.ptr`)
        expect(a.opIndex(0)).toBe(99);
    });
});

describe("Array — sort (08 §2.5)", () => {
    it("sort(pred) sorts in place with a C-qsort-convention comparator; returns this", () => {
        const a = Array.from(3, 1, 2);
        const r = a.sort((x, y) => x - y);
        expect(r).toBe(a);
        expect(a.opSlice()).toEqual([1, 2, 3]);
    });

    it("sort() with no predicate uses each element's opCmp", () => {
        class K {
            constructor(public k: number) {}
            opCmp(o: K): number {
                return this.k - o.k;
            }
        }
        const a = Array.from(new K(3), new K(1), new K(2));
        a.sort();
        expect(a.opSlice().map((e) => e.k)).toEqual([1, 2, 3]);
    });

    it("sort on length < 2 is a no-op returning this (array.d:375)", () => {
        const a = Array.from(42);
        expect(a.sort((x, y) => x - y)).toBe(a);
        expect(a.opSlice()).toEqual([42]);
    });
});

describe("Array — each! expansion-safe iteration (08 §2.6, array.d:695-788)", () => {
    it("void form iterates every element", () => {
        const a = Array.from(2, 3, 4, 5);
        const seen: number[] = [];
        a.each((e) => {
            seen.push(e);
        });
        expect(seen).toEqual([2, 3, 4, 5]);
    });

    it("re-reads length each step so callers may append during iteration (array.d:744)", () => {
        // Port of the "iterate while appending" unittest: start [2,3,4], push 5 when e==2.
        const a = Array.from(2, 3, 4);
        const seen: number[] = [];
        a.each((e) => {
            if (e === 2) a.push(5);
            seen.push(e);
        });
        expect(a.opSlice()).toEqual([2, 3, 4, 5]);
        expect(seen).toEqual([2, 3, 4, 5]); // the appended 5 IS visited (not a cached bound)
    });

    it("int form stops at the first non-zero result and returns it", () => {
        const a = Array.from(2, 3, 4, 5);
        const seen: number[] = [];
        const rv = a.each((e) => {
            seen.push(e);
            return e === 4 ? e : 0; // stop on 4
        });
        expect(rv).toBe(4);
        expect(seen).toEqual([2, 3, 4]); // 5 never visited
    });

    it("int form returns 0 when no callback returns non-zero", () => {
        const a = Array.from(2, 3, 4, 5);
        const rv = a.each((_e) => 0);
        expect(rv).toBe(0);
    });
});

describe("Array — [Symbol.iterator] foreach over a value (08 §2.0b)", () => {
    it("is iterable via for…of, delegating to the backing array", () => {
        const a = Array.from(2, 3, 4, 5);
        const seen: number[] = [];
        for (const e of a) seen.push(e);
        expect(seen).toEqual([2, 3, 4, 5]);
    });

    it("spreads into a plain array", () => {
        const a = Array.from(1, 2, 3);
        expect([...a]).toEqual([1, 2, 3]);
    });
});

describe("Array — from factory (08 §2.9)", () => {
    it("builds an Array from a variadic element list, preserving element type", () => {
        const a = Array.from("x", "y", "z");
        expect(a.length).toBe(3);
        expect(a.opSlice()).toEqual(["x", "y", "z"]);
    });

    it("empty from() yields an empty Array", () => {
        const a = Array.from<number>();
        expect(a.length).toBe(0);
    });
});

describe("array.d free functions (08 §2.8)", () => {
    it("peekSlice exposes an Array as a plain slice; null → []", () => {
        const a = Array.from(1, 2, 3);
        expect(peekSlice(a)).toEqual([1, 2, 3]);
        expect(peekSlice<number>(null)).toEqual([]);
    });

    it("split grows + shifts right to make room — exact array.d:526-551 sequence", () => {
        const a = new Array<number>();
        split(a, 0, 0);
        expect(a.opSlice()).toEqual([]);
        a.push(1).push(3);
        split(a, 1, 1);
        a.opIndexAssign(2, 1);
        expect(a.opSlice()).toEqual([1, 2, 3]);
        split(a, 2, 3);
        a.opIndexAssign(8, 2);
        a.opIndexAssign(20, 3);
        a.opIndexAssign(4, 4);
        expect(a.opSlice()).toEqual([1, 2, 8, 20, 4, 3]);
        split(a, 0, 0);
        expect(a.opSlice()).toEqual([1, 2, 8, 20, 4, 3]);
        split(a, 0, 1);
        a.opIndexAssign(123, 0);
        expect(a.opSlice()).toEqual([123, 1, 2, 8, 20, 4, 3]);
    });

    it("reverse reverses a plain slice in place and returns it", () => {
        const s = [1, 2, 3, 4];
        const r = reverse(s);
        expect(r).toBe(s);
        expect(s).toEqual([4, 3, 2, 1]);
    });
});

// Array!T.toString / toChars per element type (array.d:74-140, 07 §3.5(b)). Expected strings follow
// toStringImpl: `[` + elements joined by `,` + `]`, a null element as `null`; the `Objects` shape is
// cross-checked end to end against ldc2 1.43.0 in traits.test.ts (`__traits(parameters, 1, int, [1,2])`).
describe("Array.toString / toChars per element type (array.d:74-140, 07 §3.5(b))", () => {
    class Named extends RootObject {
        constructor(private readonly name: string) {
            super();
        }
        override toChars() {
            return ds(this.name);
        }
    }
    const objects = (...xs: (RootObject | null)[]) => Array.from<RootObject | null>(...xs);
    const exps = (...xs: (Expression | null)[]) => Array.from<Expression | null>(...xs);
    const int = (v: bigint) => new IntegerExp(Loc.initial, v, Type.tint32);

    it("Objects: empty, one, several, and a null element", () => {
        initSemaHarness();
        expect(dsToJs(toStringObjects(objects()))).toBe("[]");
        expect(dsToJs(toStringObjects(objects(new Named("a"))))).toBe("[a]");
        expect(dsToJs(toStringObjects(objects(new Named("a"), new Named("b"), new Named("c"))))).toBe("[a,b,c]");
        expect(dsToJs(toStringObjects(objects(new Named("a"), null)))).toBe("[a,null]");
        expect(dsToJs(toCharsObjects(objects(null)))).toBe("[null]");
    });

    it("Expressions: elements print through Expression.toString, null as `null`", () => {
        initSemaHarness();
        expect(dsToJs(toStringExpressions(exps()))).toBe("[]");
        expect(dsToJs(toStringExpressions(exps(int(1n))))).toBe("[1]");
        expect(dsToJs(toStringExpressions(exps(int(1n), null, int(2n))))).toBe("[1,null,2]");
        expect(dsToJs(toCharsExpressions(exps(int(7n), int(8n))))).toBe("[7,8]");
    });

    it("ArgumentLabels: the element has no toString/toDString, so D's `static else assert(0)` fires", () => {
        const labels = Array.from<ArgumentLabel>(new ArgumentLabel(null, Loc.initial));
        expect(() => toStringArgumentLabels(labels)).toThrow(DError);
        expect(() => toCharsArgumentLabels(new Array<ArgumentLabel>())).toThrow(DError);
    });
});
