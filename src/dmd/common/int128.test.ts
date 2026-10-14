// Tests for dmd/common/int128.ts — the single in-source `unittest{}` block of int128.d (lines
// 773-921), ported per 10 §1. One D `unittest{}` -> one Vitest `test("unittest#1")`.
//
// D `==`/`!=` on `Cent` is the default struct comparison (no `opEquals` declared) -> `opEquals`
// (05 §2); `assert(a == b)` -> `expect(a.opEquals(b)).toBe(true)`, `assert(!(a==b))` ->
// `.toBe(false)` (10 §1.4). `out Cent modulus` -> a `Ref<Cent>` box (03 §3.3): one shared cell
// passed to `udivmod`/`divmod`, read back as `modulus.value`.
//
// Integer literals are the 64-bit `bigint` carrier (09 §1, §8). `I.min` (`long.min`) is
// `0x8000000000000000` = -9223372036854775808n; the `Cent` ctor `toUint64`s it into the unsigned
// limb. `U.max` (`ulong.max`) is `0xFFFF_FFFF_FFFF_FFFFn`.

import { describe, test, expect } from "vitest";
import type { Ref } from "./int128.js";
import {
    Cent,
    Ubits,
    Zero,
    One,
    neg,
    com,
    inc,
    dec,
    add,
    sub,
    mul,
    shl,
    shr,
    sar,
    shl1,
    shr1,
    sar1,
    udiv,
    udivmod,
    div,
    divmod,
    and,
    or,
    xor,
    rol,
    ror,
    rol1,
    ror1,
    ugt,
    uge,
    ult,
    ule,
    gt,
    ge,
    lt,
    le,
} from "./int128.js";

// `I.min` / `U.max` — the signed/unsigned 64-bit extremes used in the unittest literals.
const I_min = -9223372036854775808n; // long.min == 0x8000000000000000 read signed
const U_max = 0xffffffffffffffffn; // ulong.max == 2^64 - 1

describe("int128.d", () => {
    test("unittest#1", () => {
        const C0 = Zero;
        const C1 = One;
        const C2 = new Cent(2n);
        const C3 = new Cent(3n);
        const C5 = new Cent(5n);
        const C10 = new Cent(10n);
        const C20 = new Cent(20n);
        const C30 = new Cent(30n);
        const C100 = new Cent(100n);

        const Cm1 = neg(One);
        const Cm3 = neg(C3);
        const Cm10 = neg(C10);

        const C3_1 = new Cent(1n, 3n);
        const C3_2 = new Cent(2n, 3n);
        const C4_8 = new Cent(8n, 4n);
        const C5_0 = new Cent(0n, 5n);
        const C7_1 = new Cent(1n, 7n);
        const C7_9 = new Cent(9n, 7n);
        const C9_3 = new Cent(3n, 9n);
        const C10_0 = new Cent(0n, 10n);
        const C10_1 = new Cent(1n, 10n);
        const C10_3 = new Cent(3n, 10n);
        const C11_3 = new Cent(3n, 11n);
        const C20_0 = new Cent(0n, 20n);
        const C90_30 = new Cent(30n, 90n);

        const Cm10_0 = inc(com(C10_0)); // Cent(0, -10);
        const Cm10_1 = inc(com(C10_1)); // Cent(-1, -11);
        const Cm10_3 = inc(com(C10_3)); // Cent(-3, -11);
        const Cm20_0 = inc(com(C20_0)); // Cent(0, -20);

        const Cs_3 = new Cent(3n, I_min); // enum Cs_3 = Cent(3, I.min)

        const Cbig_1 = new Cent(0xa3ccac1832952398n, 0xc3ac542864f652f8n);
        const Cbig_2 = new Cent(0x5267b85f8a42fc20n, 0n);
        const Cbig_3 = new Cent(0xf0000000ffffffffn, 0n);

        /************************/

        expect(ugt(C1, C0)).toBe(true);
        expect(ult(C1, C2)).toBe(true);
        expect(uge(C1, C0)).toBe(true);
        expect(ule(C1, C2)).toBe(true);

        expect(ugt(C0, C1)).toBe(false);
        expect(ult(C2, C1)).toBe(false);
        expect(uge(C0, C1)).toBe(false);
        expect(ule(C2, C1)).toBe(false);

        expect(ugt(C1, C1)).toBe(false);
        expect(ult(C1, C1)).toBe(false);
        expect(uge(C1, C1)).toBe(true);
        expect(ule(C2, C2)).toBe(true);

        expect(ugt(C10_3, C10_1)).toBe(true);
        expect(ugt(C11_3, C10_3)).toBe(true);
        expect(ugt(C9_3, C10_3)).toBe(false);
        expect(ugt(C9_3, C9_3)).toBe(false);

        expect(gt(C2, C1)).toBe(true);
        expect(gt(C1, C2)).toBe(false);
        expect(gt(C1, C1)).toBe(false);
        expect(gt(C0, Cm1)).toBe(true);
        expect(gt(Cm1, neg(C10))).toBe(true);
        expect(gt(Cm1, Cm1)).toBe(false);
        expect(gt(Cm1, C0)).toBe(false);

        expect(lt(C2, C1)).toBe(false);
        expect(le(C2, C1)).toBe(false);
        expect(ge(C2, C1)).toBe(true);

        expect(neg(C10_0).opEquals(Cm10_0)).toBe(true);
        expect(neg(C10_1).opEquals(Cm10_1)).toBe(true);
        expect(neg(C10_3).opEquals(Cm10_3)).toBe(true);

        expect(add(C7_1, C3_2).opEquals(C10_3)).toBe(true);
        expect(sub(C1, C2).opEquals(Cm1)).toBe(true);

        expect(inc(C3_1).opEquals(C3_2)).toBe(true);
        expect(dec(C3_2).opEquals(C3_1)).toBe(true);

        expect(shl(C10, 0).opEquals(C10)).toBe(true);
        expect(shl(C10, Ubits).opEquals(C10_0)).toBe(true);
        expect(shl(C10, 1).opEquals(C20)).toBe(true);
        expect(shl(C10, Ubits * 2).opEquals(C0)).toBe(true);
        expect(shr(C10_0, 0).opEquals(C10_0)).toBe(true);
        expect(shr(C10_0, Ubits).opEquals(C10)).toBe(true);
        expect(shr(C10_0, Ubits - 1).opEquals(C20)).toBe(true);
        expect(shr(C10_0, Ubits + 1).opEquals(C5)).toBe(true);
        expect(shr(C10_0, Ubits * 2).opEquals(C0)).toBe(true);
        expect(sar(C10_0, 0).opEquals(C10_0)).toBe(true);
        expect(sar(C10_0, Ubits).opEquals(C10)).toBe(true);
        expect(sar(C10_0, Ubits - 1).opEquals(C20)).toBe(true);
        expect(sar(C10_0, Ubits + 1).opEquals(C5)).toBe(true);
        expect(sar(C10_0, Ubits * 2).opEquals(C0)).toBe(true);
        expect(sar(Cm1, Ubits * 2).opEquals(Cm1)).toBe(true);

        expect(shl1(C10).opEquals(C20)).toBe(true);
        expect(shr1(C10_0).opEquals(C5_0)).toBe(true);
        expect(sar1(C10_0).opEquals(C5_0)).toBe(true);
        expect(sar1(Cm1).opEquals(Cm1)).toBe(true);

        const modulus: Ref<Cent> = { value: new Cent() };

        expect(udiv(C10, C2).opEquals(C5)).toBe(true);
        expect(udivmod(C10, C2, modulus).opEquals(C5)).toBe(true);
        expect(modulus.value.opEquals(C0)).toBe(true);
        expect(udivmod(C10, C3, modulus).opEquals(C3)).toBe(true);
        expect(modulus.value.opEquals(C1)).toBe(true);
        expect(udivmod(C10, C0, modulus).opEquals(Cm1)).toBe(true);
        expect(modulus.value.opEquals(C0)).toBe(true);
        expect(udivmod(C2, C90_30, modulus).opEquals(C0)).toBe(true);
        expect(modulus.value.opEquals(C2)).toBe(true);
        expect(udiv(mul(C90_30, C2), C2).opEquals(C90_30)).toBe(true);
        expect(udiv(mul(C90_30, C2), C90_30).opEquals(C2)).toBe(true);

        expect(div(C10, C3).opEquals(C3)).toBe(true);
        expect(divmod(C10, C3, modulus).opEquals(C3)).toBe(true);
        expect(modulus.value.opEquals(C1)).toBe(true);
        expect(divmod(Cm10, C3, modulus).opEquals(Cm3)).toBe(true);
        expect(modulus.value.opEquals(Cm1)).toBe(true);
        expect(divmod(C10, Cm3, modulus).opEquals(Cm3)).toBe(true);
        expect(modulus.value.opEquals(C1)).toBe(true);
        expect(divmod(Cm10, Cm3, modulus).opEquals(C3)).toBe(true);
        expect(modulus.value.opEquals(Cm1)).toBe(true);
        expect(divmod(C2, C90_30, modulus).opEquals(C0)).toBe(true);
        expect(modulus.value.opEquals(C2)).toBe(true);
        expect(div(mul(C90_30, C2), C2).opEquals(C90_30)).toBe(true);
        expect(div(mul(C90_30, C2), C90_30).opEquals(C2)).toBe(true);

        expect(divmod(Cbig_1, Cbig_2, modulus).opEquals(new Cent(0x4496aa309d4d4a2fn, U_max))).toBe(true);
        expect(modulus.value.opEquals(new Cent(0xd83203d0fdc799b8n, U_max))).toBe(true);
        expect(udivmod(Cbig_1, Cbig_2, modulus).opEquals(new Cent(0x5fe0e9bace2bedadn, 2n))).toBe(true);
        expect(modulus.value.opEquals(new Cent(0x2c923125a68721f8n, 0n))).toBe(true);
        expect(div(Cbig_1, Cbig_3).opEquals(new Cent(0xbfa6c02b5aff8b86n, U_max))).toBe(true);
        expect(udiv(Cbig_1, Cbig_3).opEquals(new Cent(0xd0b7d13b48cb350fn, 0n))).toBe(true);

        expect(mul(Cm10, C1).opEquals(Cm10)).toBe(true);
        expect(mul(C1, Cm10).opEquals(Cm10)).toBe(true);
        expect(mul(C9_3, C10).opEquals(C90_30)).toBe(true);
        expect(mul(Cs_3, C10).opEquals(C30)).toBe(true);
        expect(mul(Cm10, Cm10).opEquals(C100)).toBe(true);
        expect(mul(C20_0, Cm1).opEquals(Cm20_0)).toBe(true);

        expect(or(C4_8, C3_1).opEquals(C7_9)).toBe(true);
        expect(and(C4_8, C7_9).opEquals(C4_8)).toBe(true);
        expect(xor(C4_8, C7_9).opEquals(C3_1)).toBe(true);

        expect(rol(Cm1, 1).opEquals(Cm1)).toBe(true);
        expect(ror(Cm1, 45).opEquals(Cm1)).toBe(true);
        expect(rol(ror(C7_9, 5), 5).opEquals(C7_9)).toBe(true);
        expect(rol(C7_9, 1).opEquals(rol1(C7_9))).toBe(true);
        expect(ror(C7_9, 1).opEquals(ror1(C7_9))).toBe(true);
    });
});
