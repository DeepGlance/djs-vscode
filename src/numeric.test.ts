import { describe, it, expect } from "vitest";
import { TY } from "./dmd/astenums.js";
import {
    SIZE_MAX,
    NOT_FOUND,
    toInt8,
    toUint8,
    toInt16,
    toUint16,
    toInt32,
    toUint32,
    toInt64,
    toUint64,
    maskSignedN,
    maskUnsignedN,
    wrapAddI32,
    wrapAddU32,
    wrapMulI32,
    wrapMulU32,
    normalizeInteger,
} from "./numeric.js";

describe("SIZE_MAX / NOT_FOUND sentinel (09 §1.3)", () => {
    it("is -1 and is exactly representable", () => {
        expect(SIZE_MAX).toBe(-1);
        expect(NOT_FOUND).toBe(SIZE_MAX);
    });

    it("equality test reads cleanly with === / !==", () => {
        const found: number = 5;
        const missing: number = SIZE_MAX;
        expect(found !== SIZE_MAX).toBe(true);
        expect(missing === SIZE_MAX).toBe(true);
    });
});

// All expected values below were verified against ldc2 (`ldc2 -run`) — see 09-numerics.md §2/§3
// and _probes.md §2/§3.
describe("number-domain truncation (09 §2.1) — ldc2-verified cast values", () => {
    it("toInt8 (cast(byte))", () => {
        expect(toInt8(200)).toBe(-56); // low 8 = 0xC8, bit 7 set -> signed
        expect(toInt8(0x1ff)).toBe(-1); // low 8 = 0xFF
        expect(toInt8(127)).toBe(127);
        expect(toInt8(128)).toBe(-128);
        expect(toInt8(256)).toBe(0);
    });

    it("toUint8 (cast(ubyte)/cast(char))", () => {
        expect(toUint8(-1)).toBe(255);
        expect(toUint8(256)).toBe(0); // low 8 of 0x100
        expect(toUint8(0x1ff)).toBe(255);
    });

    it("toInt16 (cast(short))", () => {
        expect(toInt16(40000)).toBe(-25536); // low 16, sign bit set
        expect(toInt16(0x1_8000 & 0xffffffff)).toBe(-32768);
        expect(toInt16(32767)).toBe(32767);
    });

    it("toUint16 (cast(ushort)/cast(wchar))", () => {
        expect(toUint16(-1)).toBe(65535);
        expect(toUint16(65536)).toBe(0);
    });

    it("toInt32 (cast(int))", () => {
        expect(toInt32(0xffffffff)).toBe(-1); // low 32 = 0xFFFFFFFF, sign set
        expect(toInt32(2147483647)).toBe(2147483647);
        expect(toInt32(2147483648)).toBe(-2147483648);
        // cast(int)0x1_0000_0001L === 1 — keep low 32 bits. The 33-bit source is a bigint;
        // the number-domain helper is fed the already-low-32-bits value.
        expect(toInt32(Number(0x1_0000_0001n & 0xffffffffn))).toBe(1);
    });

    it("toUint32 (cast(uint)/cast(dchar))", () => {
        expect(toUint32(-1)).toBe(4294967295);
        expect(toUint32(0x1_0000_0000 % 0x1_0000_0000)).toBe(0);
    });
});

describe("bigint-domain truncation (09 §2.1) — ldc2-verified 64-bit casts", () => {
    it("toInt64 (cast(long))", () => {
        expect(toInt64(0xffffffffffffffffn)).toBe(-1n); // 64-bit two's complement
        expect(toInt64(0x8000000000000000n)).toBe(-9223372036854775808n);
        expect(toInt64(0x7fffffffffffffffn)).toBe(9223372036854775807n);
    });

    it("toUint64 (cast(ulong))", () => {
        expect(toUint64(-1n)).toBe(18446744073709551615n);
        expect(toUint64(0x8000000000000000n)).toBe(9223372036854775808n);
    });

    it("int.min bit-pattern enters the signed domain (the Div min/-1 guard, 09 §3.1)", () => {
        // naive 0xffffffff80000000n is a POSITIVE bigint; toInt64 brings it into the signed
        // carrier so it matches the normalized int.min. ldc2: int.min == 0xFFFFFFFF80000000UL.
        expect(toInt64(0xffffffff80000000n)).toBe(-2147483648n);
        expect(toInt64(0x8000000000000000n)).toBe(-9223372036854775808n); // long.min
    });

    it("maskSignedN / maskUnsignedN at arbitrary widths", () => {
        expect(maskSignedN(8, 200n)).toBe(-56n);
        expect(maskUnsignedN(8, -1n)).toBe(255n);
        expect(maskSignedN(16, 40000n)).toBe(-25536n);
        expect(maskUnsignedN(32, -1n)).toBe(4294967295n);
        expect(maskSignedN(64, 0xffffffffffffffffn)).toBe(-1n);
    });
});

describe("wrapping arithmetic (09 §2.1, §3) — ldc2-verified wrap values", () => {
    it("wrapAddI32 / wrapAddU32", () => {
        expect(wrapAddI32(2147483647, 1)).toBe(-2147483648); // int.max + 1
        expect(wrapAddU32(0xffffffff, 1)).toBe(0); // uint.max + 1
    });

    it("wrapMulI32 uses Math.imul (the only correct 32-bit signed multiply)", () => {
        expect(wrapMulI32(100000, 100000)).toBe(1410065408); // int 100000*100000
        expect(wrapMulI32(-2147483648, -1)).toBe(-2147483648); // int.min * -1 wraps to int.min
    });

    it("wrapMulU32 keeps result unsigned", () => {
        expect(wrapMulU32(100000, 100000)).toBe(1410065408);
        expect(wrapMulU32(0xffffffff, 2)).toBe(4294967294);
    });
});

describe("normalizeInteger (09 §2.2) — faithful IntegerExp.normalize", () => {
    it("Tbool collapses to 0n/1n", () => {
        expect(normalizeInteger(TY.Tbool, 0n)).toBe(0n);
        expect(normalizeInteger(TY.Tbool, 1n)).toBe(1n);
        expect(normalizeInteger(TY.Tbool, 42n)).toBe(1n);
        expect(normalizeInteger(TY.Tbool, -1n)).toBe(1n);
    });

    it("8-bit types", () => {
        expect(normalizeInteger(TY.Tint8, 200n)).toBe(-56n);
        expect(normalizeInteger(TY.Tuns8, -1n)).toBe(255n);
        expect(normalizeInteger(TY.Tchar, 256n)).toBe(0n); // char shares the ubyte rule
    });

    it("16-bit types", () => {
        expect(normalizeInteger(TY.Tint16, 40000n)).toBe(-25536n);
        expect(normalizeInteger(TY.Tuns16, -1n)).toBe(65535n);
        expect(normalizeInteger(TY.Twchar, 65536n)).toBe(0n);
    });

    it("32-bit types", () => {
        expect(normalizeInteger(TY.Tint32, 0xffffffffn)).toBe(-1n);
        expect(normalizeInteger(TY.Tuns32, -1n)).toBe(4294967295n);
        expect(normalizeInteger(TY.Tdchar, 0x110000n + 0n)).toBe(0x110000n); // fits in 32 bits
        // cast(int)0x1_0000_0001L === 1 — normalize keeps low 32 bits, sign-extends
        expect(normalizeInteger(TY.Tint32, 0x1_0000_0001n)).toBe(1n);
    });

    it("64-bit types and pointer", () => {
        expect(normalizeInteger(TY.Tint64, 0xffffffffffffffffn)).toBe(-1n);
        expect(normalizeInteger(TY.Tuns64, -1n)).toBe(18446744073709551615n);
        // Tpointer normalizes as ulong on the fixed 64-bit target (target.ptrsize == 8)
        expect(normalizeInteger(TY.Tpointer, -1n)).toBe(18446744073709551615n);
    });

    it("non-integral ty passes through unchanged (D default: branch)", () => {
        expect(normalizeInteger(TY.Tarray, 12345n)).toBe(12345n);
        expect(normalizeInteger(TY.Tfloat64, -999n)).toBe(-999n);
        expect(normalizeInteger(TY.Tstruct, 0x1_0000_0001n)).toBe(0x1_0000_0001n);
    });
});
