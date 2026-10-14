// Tests for dmd/utils.ts.
//
// Ports the two in-source `unittest{}` blocks of utils.d (10 §1.2, numbered in source order):
//   #1 — utils.d:200: parseDigits across byte/ubyte/short/ushort/int/uint/long/ulong, plus the
//        overflow / non-digit / max-bound cases.
//   #2 — utils.d:265: arrayCastBigEndian byte re-ordering for sizes 8/4/2/1.
//
// parseDigits is generic in D (the type drives the accumulator width/signedness); the port takes
// the concrete `T` as a tag and writes the result into a box (the `ref T val` out param). The
// `.stringof` literals from the D source are spelled out: `ubyte.max.stringof` is the string
// "cast(ubyte)255u" (verified ldc2 — NOT "255"), `int.max.stringof` is "2147483647".

import { describe, test, expect } from "vitest";
import { ds } from "../dstring.js";
import { parseDigits, arrayCastBigEndian, type ParseDigitsBox } from "./utils.js";

/** Read `n` bytes of `data` starting at `off` as a little-endian unsigned integer (how D's
 * `cast(ulong[]/uint[]/ushort[])` reads the arrayCastBigEndian result on an LE machine). */
function leUint(data: Uint8Array, off: number, n: number): bigint {
    let v = 0n;
    for (let j = 0; j < n; j++) v |= BigInt(data[off + j]) << BigInt(j * 8);
    return v;
}

describe("utils.d", () => {
    // utils.d:200 — parseDigits matrix.
    test("unittest#1", () => {
        const box: ParseDigitsBox = { value: 0 };

        expect(parseDigits(box, ds("42"), "byte")).toBe(true);
        expect(box.value).toBe(42);
        expect(parseDigits(box, ds("42"), "ubyte")).toBe(true);
        expect(box.value).toBe(42);

        expect(parseDigits(box, ds("420"), "short")).toBe(true);
        expect(box.value).toBe(420);
        expect(parseDigits(box, ds("42000"), "ushort")).toBe(true);
        expect(box.value).toBe(42_000);

        expect(parseDigits(box, ds("420000"), "int")).toBe(true);
        expect(box.value).toBe(420_000);
        expect(parseDigits(box, ds("420000"), "uint")).toBe(true);
        expect(box.value).toBe(420_000);

        expect(parseDigits(box, ds("42000000000"), "long")).toBe(true);
        expect(box.value).toBe(42_000_000_000n);
        expect(parseDigits(box, ds("82000000000"), "ulong")).toBe(true);
        expect(box.value).toBe(82_000_000_000n);

        // ubyte.max.stringof == "cast(ubyte)255u" — not all digits, so parseDigits fails.
        expect(parseDigits(box, ds("cast(ubyte)255u"), "byte")).toBe(false);
        expect(parseDigits(box, ds("WYSIWYG"), "byte")).toBe(false);
        expect(parseDigits(box, ds("-42"), "byte")).toBe(false);
        // "200" as a byte overflows byte.max (127) -> false.
        expect(parseDigits(box, ds("200"), "byte")).toBe(false);
        // "200" as a ubyte fits (<= 255) -> true, value 200.
        expect(parseDigits(box, ds("200"), "ubyte")).toBe(true);
        expect(box.value).toBe(200);
        // int.max.stringof == "2147483647".
        expect(parseDigits(box, ds("2147483647"), "int")).toBe(true);
        expect(box.value).toBe(0x7fff_ffff);
        // explicit max bound (inclusive): 420 <= 500 -> true; 420 <= 400 -> false.
        expect(parseDigits(box, ds("420"), "int", 500n)).toBe(true);
        expect(box.value).toBe(420);
        expect(parseDigits(box, ds("420"), "int", 400n)).toBe(false);
        expect(box.value).toBe(420);
    });

    // utils.d:265 — arrayCastBigEndian.
    test("unittest#2", () => {
        const bytes = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x11, 0x22]);

        // cast(ulong[]) arrayCastBigEndian(data, 8) == [0xAABBCCDDEEFF1122]
        const r8 = arrayCastBigEndian(bytes, 8);
        expect(leUint(r8, 0, 8)).toBe(0xaabbccddeeff1122n);

        // cast(uint[]) arrayCastBigEndian(data, 4) == [0xAABBCCDD, 0xEEFF1122]
        const r4 = arrayCastBigEndian(bytes, 4);
        expect(leUint(r4, 0, 4)).toBe(0xaabbccddn);
        expect(leUint(r4, 4, 4)).toBe(0xeeff1122n);

        // cast(ushort[]) arrayCastBigEndian(data, 2) == [0xAABB, 0xCCDD, 0xEEFF, 0x1122]
        const r2 = arrayCastBigEndian(bytes, 2);
        expect(leUint(r2, 0, 2)).toBe(0xaabbn);
        expect(leUint(r2, 2, 2)).toBe(0xccddn);
        expect(leUint(r2, 4, 2)).toBe(0xeeffn);
        expect(leUint(r2, 6, 2)).toBe(0x1122n);

        // cast(ubyte[]) arrayCastBigEndian(data, 1) == data  (the identity dup)
        const r1 = arrayCastBigEndian(bytes, 1);
        expect(Array.from(r1)).toEqual(Array.from(bytes));
        expect(r1).not.toBe(bytes); // .dup is a copy, not the same buffer
    });
});
