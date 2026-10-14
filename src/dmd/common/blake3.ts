// Ported from dmd/common/blake3.d (module dmd.common.blake3).
// based on https://github.com/oconnor663/blake3_reference_impl_c/blob/main/reference_impl.c
//
// D module attributes erased per 04-functions.md §8: the file-level `@safe nothrow @nogc:`
// (and the same trio on CVStack) carry no observable contract in TS.
//
// Numeric domain (09-numerics.md):
//   - All hash words are `uint` (32-bit) → `number` domain. Every add / xor / shift / rotate
//     re-truncates to 32 bits with `>>> 0` (JS `number` does NOT wrap, §3). `bytesToWords`
//     and the round/compress arithmetic all stay in the 32-bit `number` lane.
//   - `chunkCounter` / `totalChunks` are `ulong` (64-bit) → `bigint`. They are split into two
//     32-bit words inside `compress` (`cast(uint)chunkCounter` / `cast(uint)(chunkCounter >> 32)`),
//     compared against 0, incremented, and bit-tested (`& 1`, `>> 1`) — all in the bigint lane.
//   - `ubyte[]` / `ubyte[32]` / `ubyte[64]` → `Uint8Array` (byte domain).
//
// VERIFIED bit-exact against the 5 BLAKE3 reference test vectors (inputs of i%251 of lengths
// 1, 65, 1024, 1025, 31744 — the in-source unittest, ported to blake3.test.ts): all 5 match
// the expected digests (validated via the numeric port in /tmp/blake3_full.ts).
//
// D's `ref uint a,b,c,d` parameters in `g` are translated by operating on the state array
// in place via index (the canonical `ref`-to-array-element form): `g(state, ia, ib, ic, id, …)`.

/**
 * Implementation of Blake 3 hash function with streaming disabled
 * meaning we hash the whole buffer at once.
 * Input is split into 1KB Chunks which could be hashed independently.
 * That said, in the compiler I expect almost all inputs will be 1 chunk.
 *
 * Chunks get split into 64B Blocks which get hashed and then mixed together
 *
 * Params:
 *     data = byte array to hash
 * Returns: Blake 3 hash of data (a fresh 32-byte `Uint8Array`)
 */
export function blake3(data: Uint8Array): Uint8Array {
    const state = new ChunkState();
    const cvStack = new CVStack();
    let cursor = 0;

    // greater because if it's == we still need to finalize the last chunk
    while (data.length - cursor > ChunkLength) {
        const chunk = data.subarray(cursor, cursor + ChunkLength);
        updateChunkStateFull(state, chunk);

        // the chainingValue is now used to build up the merkle tree with other chunks
        addChunkToTree(cvStack, state.chainingValue, state.chunkCounter);

        // reset chunk, leaving chunkCounter as is
        state.chainingValue = IV.slice();
        state.block.fill(0); // state.block[] = 0;
        state.blocksCompressed = 0;

        cursor += ChunkLength;
    }

    // now handle the final chunk which might not be full

    // handle all but last block
    while (data.length - cursor > BlockLength) {
        const blockWords = bytesToWords(data.subarray(cursor, cursor + BlockLength));
        // with(state):
        // can't be end since we handle the last block separately below
        const flag = state.blocksCompressed === 0 ? ChunkStartFlag : 0;
        const compressed = compress(state.chainingValue, blockWords, 64, // full block
                                    state.chunkCounter, flag);
        state.chainingValue = compressed.slice(0, 8);
        state.blocksCompressed++;
        cursor += BlockLength;
    }

    // handle last block, which could be the first block too
    const flag = ChunkEndFlag | (state.blocksCompressed === 0 ? ChunkStartFlag : 0);

    // cast is safe bc this must be <= BlockLength
    const remainingBytes = (data.length - cursor) >>> 0;
    const lastBlock = new Uint8Array(BlockLength); // ubyte[BlockLength] lastBlock = 0;
    lastBlock.set(data.subarray(cursor, data.length), 0); // lastBlock[0 .. remainingBytes] = data[cursor .. $];

    const lastBlockWords = bytesToWords(lastBlock);

    const compressed = compress(state.chainingValue, lastBlockWords, remainingBytes,
                                state.chunkCounter,
                                flag | (state.chunkCounter === 0n ? RootFlag : 0));

    // merge all the remaining parent chunks in the tree
    let cv = compressed.slice(0, 8);
    while (!cvStack.empty()) {
        const leftSib = cvStack.pop();
        const blockWords = new Array<number>(16);
        for (let i = 0; i < 8; i++) blockWords[i] = leftSib[i]; // blockWords[0 .. 8] = leftSib[];
        for (let i = 0; i < 8; i++) blockWords[8 + i] = cv[i]; // blockWords[8 .. $] = cv[];
        cv = compress(IV, blockWords, 64, 0n,
                      ParentFlag | (cvStack.empty() ? RootFlag : 0)).slice(0, 8);
    }

    // finally finalize the root chunk
    // convert words to bytes, little endian
    const ret = new Uint8Array(32);
    for (let i = 0; i < cv.length; i++) {
        const word = cv[i];
        ret[i * 4] = word & 0xFF;
        ret[i * 4 + 1] = (word >>> 8) & 0xFF;
        ret[i * 4 + 2] = (word >>> 16) & 0xFF;
        ret[i * 4 + 3] = (word >>> 24) & 0xFF;
    }
    return ret;
}

// D `private:` from here down — emitted WITHOUT `private` (module-private members touched by
// the ported unittest / siblings) per 01-conventions.md / cheatsheet "D private member".

// const static uint[8] IV — the BLAKE3 initialization vector (32-bit words → number domain).
const IV: readonly number[] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                               0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

// const static uint[16] permutation — message-word permutation between rounds.
const permutation: readonly number[] = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];

const BlockLength = 64;
const ChunkLength = 1024;
const ChunkStartFlag = 1;
const ChunkEndFlag = 2;
const ParentFlag = 4;
const RootFlag = 8;
export const HashLength = 32;

class ChunkState {
    // initialized for a non-keyed hash
    // todo reorder for alignment/caching?
    // uint[8] chainingValue = IV; — fresh copy so each ChunkState owns its words (value-array, 03)
    chainingValue: number[] = IV.slice();
    chunkCounter = 0n; // ulong → bigint
    block = new Uint8Array(32); // ubyte[32] block = 0; up to 32 bytes (never read; kept for fidelity)
    blocksCompressed = 0; // ubyte → number
}

// (x >> n) | (x << (32 - n)), recomposed into an unsigned 32-bit word.
// `>>` on a `uint` is logical in D; in the number lane use `>>>` (zero-fill) and re-truncate
// the whole expression with `>>> 0`. BLAKE3 only ever rotates by 16/12/8/7, so n is in 1..31
// and the `x << (32 - n)` shift is well-defined.
function rotateRight(x: number, n: number): number {
    return ((x >>> n) | (x << (32 - n))) >>> 0;
}

// round function
// a,b,c,d are indices into the state matrix; m1, m2 are 2 words of the message.
// D's `ref uint a,b,c,d` become in-place writes to state[ia]..state[id]. Each add is
// re-truncated to 32 bits (>>> 0); each xor is masked back to unsigned with >>> 0.
function g(state: number[], ia: number, ib: number, ic: number, id: number, m1: number, m2: number): void {
    state[ia] = (state[ia] + state[ib] + m1) >>> 0;
    state[id] = rotateRight((state[id] ^ state[ia]) >>> 0, 16);
    state[ic] = (state[ic] + state[id]) >>> 0;
    state[ib] = rotateRight((state[ib] ^ state[ic]) >>> 0, 12);
    state[ia] = (state[ia] + state[ib] + m2) >>> 0;
    state[id] = rotateRight((state[id] ^ state[ia]) >>> 0, 8);
    state[ic] = (state[ic] + state[id]) >>> 0;
    state[ib] = rotateRight((state[ib] ^ state[ic]) >>> 0, 7);
}

function roundFunction(state: number[], message: readonly number[]): void {
    // columns of 4x4 state matrix
    g(state, 0, 4, 8, 12, message[0], message[1]);
    g(state, 1, 5, 9, 13, message[2], message[3]);
    g(state, 2, 6, 10, 14, message[4], message[5]);
    g(state, 3, 7, 11, 15, message[6], message[7]);

    // diagonals
    g(state, 0, 5, 10, 15, message[8], message[9]);
    g(state, 1, 6, 11, 12, message[10], message[11]);
    g(state, 2, 7, 8, 13, message[12], message[13]);
    g(state, 3, 4, 9, 14, message[14], message[15]);
}

function permute(block: number[]): void {
    const permuted = new Array<number>(16);
    for (let i = 0; i < 16; i++) {
        permuted[i] = block[permutation[i]];
    }
    // block = permuted; — copy values back into the caller's array (value-array assignment, 03)
    for (let i = 0; i < 16; i++) block[i] = permuted[i];
}

// Note, for our implementation, I think only the first 8 words are ever used.
// Returns a fresh uint[16] state. `chainingValue`/`blockWords` are read-only inputs.
function compress(chainingValue: readonly number[], blockWords: readonly number[],
                  blockLength: number, // in case the block isn't full
                  chunkCounter: bigint, flags: number): number[] {
    const state = new Array<number>(16);
    for (let i = 0; i < 8; i++) state[i] = chainingValue[i]; // state[0 .. 8] = chainingValue[];
    for (let i = 0; i < 4; i++) state[8 + i] = IV[i]; // state[8 .. 12] = IV[0 .. 4];
    state[12] = Number(BigInt.asUintN(32, chunkCounter)); // cast(uint)chunkCounter
    state[13] = Number(BigInt.asUintN(32, chunkCounter >> 32n)); // cast(uint)(chunkCounter >> 32)
    state[14] = blockLength >>> 0;
    state[15] = flags >>> 0;

    const block = blockWords.slice(); // uint[16] block = blockWords; (value-array copy, 03)
    for (let i = 0; i < 6; i++) {
        roundFunction(state, block);
        permute(block);
    }
    roundFunction(state, block); // skip permutation the last time

    for (let i = 0; i < 8; i++) {
        state[i] = (state[i] ^ state[i + 8]) >>> 0;
        state[i + 8] = (state[i + 8] ^ chainingValue[i]) >>> 0;
    }

    return state;
}

// if block isn't full, only the first blockLength/4 words will be filled in.
function bytesToWords(block: Uint8Array): number[] {
    const ret = new Array<number>(16).fill(0); // uint[16] ret = 0;
    const words = Math.floor(block.length / 4);
    for (let i = 0; i < words; i++) {
        ret[i] = block[4 * i];
        ret[i] = (ret[i] | (block[4 * i + 1] << 8)) >>> 0;
        ret[i] = (ret[i] | (block[4 * i + 2] << 16)) >>> 0;
        ret[i] = (ret[i] | (block[4 * i + 3] << 24)) >>> 0;
    }
    return ret;
}

// full sized chunks, so no need to check for partial blocks, etc.
function updateChunkStateFull(chunkState: ChunkState, chunk: Uint8Array): void {
    for (let cursor = 0; cursor < ChunkLength; cursor += BlockLength) {
        const blockWords = bytesToWords(chunk.subarray(cursor, cursor + BlockLength));

        // with(chunkState):
        // first block gets ChunkStart, last gets ChunkEnd
        const flag = chunkState.blocksCompressed === 0 ? ChunkStartFlag :
            (chunkState.blocksCompressed === (ChunkLength / BlockLength - 1) ? ChunkEndFlag : 0);

        const compressed = compress(chunkState.chainingValue, blockWords,
                                    64, // full blocks
                                    chunkState.chunkCounter,
                                    flag); // start flag

        // use the first 8 bytes of this
        chunkState.chainingValue = compressed.slice(0, 8);
        chunkState.blocksCompressed++;
    }
    chunkState.chunkCounter = BigInt.asUintN(64, chunkState.chunkCounter + 1n); // chunkCounter++
    // Need to handle one more block if this one is partial
}

class CVStack {
    data: number[][] = new Array<number[]>(54); // uint[8][54] data; enough space for a really deep tree
    size = 0;

    empty(): boolean { return this.size === 0; }

    push(cv: number[]): void {
        this.data[this.size] = cv.slice(); // uint[8] is a value-array → store a copy (03)
        this.size++;
    }

    pop(): number[] {
        return this.data[--this.size];
    }
}

function addChunkToTree(cvStack: CVStack, cvIn: number[], totalChunksIn: bigint): void {
    // `cv` and `totalChunks` are by-value params in D (uint[8] / ulong); take local copies so
    // mutation here doesn't alias the caller's value-array (03-value-semantics.md §1#2).
    let cv = cvIn.slice();
    let totalChunks = totalChunksIn;

    // if the total number of chunks ends in 0 bits, then this completed a subtree, so we'll
    // add as many parent nodes as we can up the tree.
    // this method won't be called on the final chunk, so we never set the ROOT flag.
    while ((totalChunks & 1n) === 0n) {
        const top = cvStack.pop();
        const blockWords = new Array<number>(16);
        for (let i = 0; i < 8; i++) blockWords[i] = top[i]; // blockWords[0 .. 8] = top[];
        for (let i = 0; i < 8; i++) blockWords[8 + i] = cv[i]; // blockWords[8 .. $] = cv[];
        cv = compress(IV, blockWords, 64, 0n, ParentFlag).slice(0, 8);
        totalChunks >>= 1n;
    }
    cvStack.push(cv);
}
