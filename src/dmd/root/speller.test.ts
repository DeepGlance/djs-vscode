// Ported from dmd/root/speller.d unittest (speller.d:242). 10-tests-diagnostics.md §1.
//
// Faithful port of the in-source D `unittest`: the `speller_test` search delegate plus the
// 15-case table. `string speller_test(const(char)[] s, ref int cost)` -> a `SearchFn<DString>`
// closing over `dgarg`. The `ref int cost` out-param becomes `cost: Ref<number>` (the delegate
// writes `cost.value = 0`). The expected y/n outcomes were cross-checked against the real dmd
// speller via ldc2 (/tmp/probe_speller.d): every case matches.
import { describe, test, expect } from "vitest";
import type { Ref, SearchFn } from "./speller.js";
import { speller } from "./speller.js";
import { ds, dsEquals, type DString } from "../../dstring.js";

describe("speller.d", () => {
    test("unittest#1", () => {
        // static immutable string[][] cases (speller.d:244-261)
        const cases: [string, string, string][] = [
            ["hello", "hell", "y"],
            ["hello", "hel", "y"],
            ["hello", "ello", "y"],
            ["hello", "llo", "y"],
            ["hello", "hellox", "y"],
            ["hello", "helloxy", "y"],
            ["hello", "xhello", "y"],
            ["hello", "xyhello", "y"],
            ["hello", "ehllo", "y"],
            ["hello", "helol", "y"],
            ["hello", "abcd", "n"],
            ["hello", "helxxlo", "y"],
            ["hello", "ehlxxlo", "n"],
            ["hello", "heaao", "y"],
            [
                "_123456789_123456789_123456789_123456789",
                "_123456789_123456789_123456789_12345678",
                "y",
            ],
        ];

        // `string dgarg;` — captured by the search delegate (closure, 04-functions.md §4.2).
        let dgarg: DString = ds("");

        // `string speller_test(const(char)[] s, ref int cost)` — nested function -> closure.
        // D `assert(s[$-1] != '\0')`: the trial string never ends in NUL (no terminator written).
        // `cost = 0;` then return `dgarg` on an exact byte match, else null.
        const speller_test: SearchFn<DString> = (s: DString, cost: Ref<number>): DString | null => {
            expect(s[s.length - 1]).not.toBe(0); // assert(s[$-1] != '\0')
            cost.value = 0;
            if (dsEquals(dgarg, s))
                return dgarg;
            return null;
        };

        // dgarg = "hell"; auto p = speller!speller_test("hello"); assert(p !is null);
        dgarg = ds("hell");
        const p = speller<DString>(ds("hello"), speller_test);
        expect(p).not.toBeNull(); // assert(p !is null)

        for (const testCase of cases) {
            dgarg = ds(testCase[1]);
            const p2 = speller<DString>(ds(testCase[0]), speller_test);
            if (p2)
                expect(testCase[2][0]).toBe("y"); // assert(testCase[2][0] == 'y')
            else
                expect(testCase[2][0]).toBe("n"); // assert(testCase[2][0] == 'n')
        }
    });
});
