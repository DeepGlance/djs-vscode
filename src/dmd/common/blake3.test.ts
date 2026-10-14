// Ported unittest from dmd/common/blake3.d (10-tests-diagnostics.md §1).
//
// test vectors from the spec. Run blake3 on inputs of [0, 1, 2, ... 249, 250, 0, 1, 2, ...]
// (i.e. i % 251) of various lengths.
//   available here: https://github.com/oconnor663/blake3_reference_impl_c/blob/main/test_vectors.json
//
// The D `testVector!(size_t N)()` compile-time-sized helper (`ubyte[N]` filled with `i % 251`)
// becomes a runtime `testVector(n)` returning a `Uint8Array(n)` — N is a plain length here, no
// compile-time array sizing is observable.

import { describe, test, expect } from "vitest";
import { blake3 } from "./blake3.js";

function testVector(n: number): Uint8Array {
    const ret = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        ret[i] = i % 251;
    }
    return ret;
}

describe("blake3.d", () => {
    // unittest { ... assert(blake3(...) == expected...); }   (blake3.d:301)
    test("unittest#1 (test vectors from the spec)", () => {
        // todo use hex literals once DMD bootstrap version gets big enough
        const oneByte = testVector(1);
        const expectedOneByte = new Uint8Array([
            0x2d, 0x3a, 0xde, 0xdf, 0xf1, 0x1b, 0x61, 0xf1,
            0x4c, 0x88, 0x6e, 0x35, 0xaf, 0xa0, 0x36, 0x73,
            0x6d, 0xcd, 0x87, 0xa7, 0x4d, 0x27, 0xb5, 0xc1,
            0x51, 0x02, 0x25, 0xd0, 0xf5, 0x92, 0xe2, 0x13,
        ]);
        expect(Array.from(blake3(oneByte))).toEqual(Array.from(expectedOneByte));

        const expectedTwoBlocks = new Uint8Array([
            0xde, 0x1e, 0x5f, 0xa0, 0xbe, 0x70, 0xdf, 0x6d,
            0x2b, 0xe8, 0xff, 0xfd, 0x0e, 0x99, 0xce, 0xaa,
            0x8e, 0xb6, 0xe8, 0xc9, 0x3a, 0x63, 0xf2, 0xd8,
            0xd1, 0xc3, 0x0e, 0xcb, 0x6b, 0x26, 0x3d, 0xee,
        ]);
        const twoBlockInput = testVector(65);
        expect(Array.from(blake3(twoBlockInput))).toEqual(Array.from(expectedTwoBlocks));

        const expectedOneChunk = new Uint8Array([
            0x42, 0x21, 0x47, 0x39, 0xf0, 0x95, 0xa4, 0x06,
            0xf3, 0xfc, 0x83, 0xde, 0xb8, 0x89, 0x74, 0x4a,
            0xc0, 0x0d, 0xf8, 0x31, 0xc1, 0x0d, 0xaa, 0x55,
            0x18, 0x9b, 0x5d, 0x12, 0x1c, 0x85, 0x5a, 0xf7,
        ]);
        const barelyOneChunk = testVector(1024);
        expect(Array.from(blake3(barelyOneChunk))).toEqual(Array.from(expectedOneChunk));

        const expectedTwoChunks = new Uint8Array([
            0xd0, 0x02, 0x78, 0xae, 0x47, 0xeb, 0x27, 0xb3,
            0x4f, 0xae, 0xcf, 0x67, 0xb4, 0xfe, 0x26, 0x3f,
            0x82, 0xd5, 0x41, 0x29, 0x16, 0xc1, 0xff, 0xd9,
            0x7c, 0x8c, 0xb7, 0xfb, 0x81, 0x4b, 0x84, 0x44,
        ]);
        const barelyTwoChunks = testVector(1025);
        expect(Array.from(blake3(barelyTwoChunks))).toEqual(Array.from(expectedTwoChunks));

        const expectedBig = new Uint8Array([
            0x62, 0xb6, 0x96, 0x0e, 0x1a, 0x44, 0xbc, 0xc1,
            0xeb, 0x1a, 0x61, 0x1a, 0x8d, 0x62, 0x35, 0xb6,
            0xb4, 0xb7, 0x8f, 0x32, 0xe7, 0xab, 0xc4, 0xfb,
            0x4c, 0x6c, 0xdc, 0xce, 0x94, 0x89, 0x5c, 0x47,
        ]);
        const bigInput = testVector(31_744);
        expect(Array.from(blake3(bigInput))).toEqual(Array.from(expectedBig));
    });
});
