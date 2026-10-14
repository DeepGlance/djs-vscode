# 09 — Numerics (D → TypeScript)

> **STOP rule:** if you meet a numeric construct not covered here, or any ambiguity about
> which numeric domain (`number` vs `bigint`) a value belongs to, STOP and escalate
> (`11-escalate.md`). Never guess. A wrong-but-plausible numeric truncation in a compiler
> silently corrupts constant folding, enum values, array sizes, hashes, and mangling — it
> is worse than a halt.

Read `_ground-truth.md` and `_probes.md` first. This doc owns **integer/float exactness**:
the `number`/`bigint` domain split, overflow/wrap, the exact cast truncation rule, bit
operations and shifts, the mixed-domain boundary, integer/float literals, `char`/`dchar`
arithmetic, and where exactness *decides a compile outcome* so `bigint` is mandatory.

**Lane boundaries — defer to the owning doc, do not duplicate:**

- *Which TS type to write per D scalar* (the `number`/`bigint`/`boolean` mapping) → `02-types.md`
  §1. This doc explains the **behavior** behind that mapping, not the type spelling.
- *Operator-overload rewrite* (`opAdd`, `opCmp`, `opEquals` on user structs like `Cent`) →
  `05-operators.md`. Here we cover only the **built-in scalar** operators.
- *`static if`/`__traits`/enum-member folding at translation time* → `07-compile-time.md`.
- *`Array!T` lengths/indices as a container API* → `08-runtime-lib.md`.
- *D `string` byte model* (`string` is `immutable(char)[]`, a UTF-8 byte array) →
  `08-runtime-lib.md`. Here: only a **scalar** `char`/`dchar` value.
- *`assert` helper* mechanics → house rules; this doc *uses* `assert(...)`.

This doc is **correctness-critical**. Every rule is grounded in `_probes.md` (machine-verified
`ldc2` output) and in the frontend's own folding code, chiefly
`dmd/constfold.d`, `dmd/expression.d` (`IntegerExp.normalize`), `dmd/ctfeexpr.d`, and
`dmd/lexer.d`. Cites are clickable.

---

## 0. The one mental model that governs everything

The frontend carries **every integer constant in a single 64-bit unsigned register** and
re-interprets the bit pattern per the value's *type* on the way out. This is not an
analogy — it is literally how the code is written:

```d
// dmd/expression.d:751 — IntegerExp's value IS a 64-bit carrier (dinteger_t == ulong)
dinteger_t value;
// dmd/globals.d:642-645 — the three carrier aliases
alias dinteger_t = ulong;     // the universal 64-bit carrier (unsigned bit pattern)
alias sinteger_t = long;      // same bits, read as signed
alias uinteger_t = ulong;     // same bits, read as unsigned
```

All CTFE integer arithmetic is done in this `ulong` carrier (wrapping at 2^64), then
**normalized** — masked to the type's width and sign-extended if the type is signed — when
stored back into an `IntegerExp`:

```d
// dmd/constfold.d:212 — Add: arithmetic in the 64-bit carrier, then ctor normalizes by type
emplaceExp!(IntegerExp)(&ue, loc, e1.toInteger() + e2.toInteger(), type);
// dmd/expression.d:829 — normalize: mask+sign-extend the 64-bit carrier to the type width
static dinteger_t normalize(TY ty, dinteger_t value) { ... cast(int)value ... cast(ubyte)value ... }
```

> `emplaceExp!(IntegerExp)(&ue, …)` → `new IntegerExp(…)`: the `UnionExp`/`emplaceExp` rewrite
> is owned by `02-types.md` "UnionExp / emplaceExp (CTFE expression construction)". This doc
> only specifies the **numeric carrier** that goes inside (`bigint`, normalized via §2).

**Consequence for the port (the decisive rule):** the carrier spans the full 64-bit range
and relies on **unsigned 64-bit wraparound** plus **per-type re-interpretation of the same
bits**. JS `number` cannot represent this (it loses precision above 2^53 and has no 64-bit
two's-complement). Therefore:

> **In CTFE / constant folding, the integer carrier is `bigint`, always.** The `number`
> domain is for *index/length/loop-counter* arithmetic that is provably within 2^53 and
> never decides a compile outcome (§8). When in doubt, use `bigint`.

---

## 1. Per-D-type decision table (which domain, why)

The TS *type* per D scalar is fixed by `02-types.md` §1. This table states the **numeric
domain** (the runtime representation in the port) and the rule that survives the mapping.

| D type | Bits | TS type | Domain | Truncate-on-store rule (§2) |
|---|---:|---|---|---|
| `bool` | 1 | `boolean` | — | `value != 0n` (when coming from an integer carrier) |
| `byte` | 8 | `number` | number | `toInt8` |
| `ubyte` | 8 | `number` | number | `toUint8` |
| `short` | 16 | `number` | number | `toInt16` |
| `ushort` | 16 | `number` | number | `toUint16` |
| `char` | 8 | `number` | number | `toUint8` (UTF-8 code unit; arithmetic → `int`, §7) |
| `wchar` | 16 | `number` | number | `toUint16` (UTF-16 code unit; arithmetic → `int`, §7) |
| `int` | 32 | `number` | number | `toInt32` (`x \| 0`) |
| `uint` | 32 | `number` | number | `toUint32` (`x >>> 0`) |
| `dchar` | 32 | `number` | number | `toUint32` (Unicode code point; arithmetic → `int`, §7) |
| `long` | 64 | `bigint` | **bigint** | `toInt64` (`BigInt.asIntN(64, x)`) |
| `ulong` | 64 | `bigint` | **bigint** | `toUint64` (`BigInt.asUintN(64, x)`) |
| `float` | 32 | `number` | number (float) | §6 — **no `Math.fround`** (CTFE keeps double precision) |
| `double` | 64 | `number` | number (float) | §6 |
| `real` | 64 | `number` | number (float) | §6 — `real == double` on this target (`_probes.md` §6) |
| `cent`/`ucent` | 128 | — | — | **obsolete, not a live variable type** (`02-types.md` §1.2) |

### 1.0 D `.init` default values — VERIFIED table (memorize the three traps)

Every D type has a `.init` the language uses for default initialization (`T x;`, `out` params,
AA-absent reads, `Array` growth in D). **Three of them are NOT zero, and guessing zero is a
silent bug.** Verified with ldc2 1.43.0-beta1 (`-run` probe, 2^N-printed):

| D type | `.init` | Port value | Trap? |
|---|---|---|---|
| `bool` | `false` | `false` | |
| `byte ubyte short ushort int uint size_t` | `0` | `0` | |
| `long ulong` | `0` | `0n` | |
| `char` | **`0xFF`** (255) | `0xff` | **YES — not 0** |
| `wchar` | **`0xFFFF`** | `0xffff` | **YES — not 0** |
| `dchar` | **`0xFFFF`** | `0xffff` | **YES — not 0** (an INVALID code point, deliberately) |
| `float double real` | **`NaN`** | `NaN` | **YES — not 0.0** |
| class reference / pointer | `null` | `null` | |
| `struct S` | each field's declared default (else its type's `.init`) | field-wise | declared initializers win (`int f = 42;` → 42) |
| `enum E { a = 5, b }` | **`E.a` — the FIRST member** | first member's value | **not 0** unless the first member is 0 |
| `T[]` slice | `null` | `null` | null slice, not an empty one (see `06-control-flow.md §2.8`) |
| `Array!T field;` (by VALUE) | an EMPTY container (non-null) | `new DArray<...>()` | **one char from the next row** — a by-value container field is born usable |
| `Array!T* field;` (by POINTER) | `null` | `null` | live precedents: func.d:247 vs statement.d:1134-1135; self-gate: grep your file's `Array!` fields for the `*` before initializing |

Rules:
- Emitting a default for a D-default-initialized slot (`T x;`, the `out`-param reset,
  `03-value-semantics.md §6.4`) uses THIS table — never a blanket `0`.
- The char-family and float `.init`s are intentional poison values ("uninitialized" markers);
  code that tests them (`if (c == char.init)`) relies on the exact value.
- A named enum's `.init` is its **first member**, whatever its value — not zero.

### 1.1 `size_t` and `ptrdiff_t`

64-bit in D (`_config.md`: pointer width 64-bit). They appear in the frontend as **indices,
lengths, and loop counters** — provably below 2^53 in any realistic compile. Map to
**`number`** (`02-types.md` §1). Do **NOT** make them `bigint`: that would force a
`number`/`bigint` boundary at every `arr[i]` and `for` loop and break the port's ergonomics
for no fidelity gain.

```d
// dmd/expression.d:126 — size_t as a plain loop counter → number
for (size_t i = 0; i < exps.length; i++)
```

> **The exception that forces `bigint`:** when `size_t`/`ptrdiff_t` is used as an *integer
> value in CTFE* (e.g. `.sizeof` folded into an `IntegerExp`, an offset stored in a
> `SymOffExp`, an alignment computed in constant folding), it is part of the §0 carrier and
> is `bigint`. The discriminator is **role, not type**: index/length/counter → `number`;
> participates in constant folding that decides a compile outcome → `bigint` (§8).

### 1.2 Pointer-as-integer

The frontend occasionally reads a pointer width into an integer (e.g. `normalize` handles
`Tpointer` by aliasing to the pointer-width unsigned type):

```d
// dmd/expression.d:875-882 — a pointer value normalizes as a width-sized unsigned integer
case Tpointer:
    if (target.ptrsize == 8) goto case Tuns64;   // our target: 64-bit → ulong → bigint
```

On our fixed 64-bit target a pointer-as-integer normalizes as `ulong` → **`bigint`** in the
carrier. Plain *pointer fields* (`Class*`, `Struct*`) are NOT integers — they map per
`02-types.md` §10. This rule applies only to the rare site that *casts a pointer to an
integer value* inside folding. Pointer arithmetic over a buffer is a STOP (`02-types.md`
§10 / `08-runtime-lib.md`).

### 1.3 `size_t.max` and the SIZE_MAX sentinel

**CANONICAL HOME.** Other docs (notably `08-runtime-lib.md` §2.4) defer the exact value of
the sentinel to this subsection.

`size_t.max` is `2^64 − 1` (`0xFFFF_FFFF_FFFF_FFFF`). In the frontend it appears almost
exclusively as a **NOT-FOUND sentinel** on a `size_t`-typed index, *never* as a number you
do arithmetic with. `Array.find` returns it when the element is absent; `FileName` returns
it from "no extension / no separator" searches:

```d
// dmd/root/array.d:292 — find returns size_t.max as the not-found sentinel
size_t find(T ptr) const { foreach (i; 0..length) if (data[i] is ptr) return i; return size_t.max; }
```

§1.1 maps `size_t` to `number`, and an index in the port is a `number`. But `2^64 − 1` is
**not exactly representable as a JS `number`** (it rounds to `2^64`), so the literal cannot
survive the round-trip. The fix is a **named sentinel**, defined once and used identically at
the producing site and at every comparison:

```ts
// dmd/root/numeric.ts — the not-found sentinel. NOT an arithmetic value (see below).
export const SIZE_MAX = -1;             // a.k.a. NOT_FOUND
export const NOT_FOUND = SIZE_MAX;      // alias: same constant, search-result spelling
```

`-1` is the canonical sentinel: it is never a valid index, it is exactly representable, and a
single `=== SIZE_MAX` / `!== SIZE_MAX` test reads cleanly. Rewrite the producing site and
**every** comparison to the same constant:

| D | TS |
|---|---|
| `return size_t.max;` (not found) | `return SIZE_MAX;` |
| `i != size_t.max` | `i !== SIZE_MAX` |
| `i == size_t.max` | `i === SIZE_MAX` |

```d
// dmd/root/array.d:292 + the matching test in contains
bool contains(T ptr) const { return find(ptr) != size_t.max; }
```
```ts
contains(v: T): boolean { return this.find(v) !== SIZE_MAX; }   // === / !== SIZE_MAX, never < 0
```

> **`SIZE_MAX` is a sentinel, not an arithmetic value.** It exists only to be *returned* and
> *compared for equality*. Never let it enter arithmetic, ordering (`<`, `>=`), or an index
> expression — `-1` would silently corrupt any such use. Compare with `===`/`!==` only.

**Arithmetic uses of `size_t.max` are a different beast — do NOT emit `-1`.** Where the
frontend uses `size_t.max` as an actual `2^64 − 1` *quantity*, it is an overflow guard on a
raw-memory allocation, e.g.:

```d
// dmd/common/smallbuffer.d:51 — guard: requested element count must not overflow the byte size
assert(length < size_t.max / Element.sizeof);
// dmd/common/smallbuffer.d:79 — same guard on the grow path
assert(length < size_t.max / Element.sizeof);
```

These asserts protect `malloc(length * Element.sizeof)` from a multiply that overflows
`size_t`. **That overflow does not exist in a GC'd JS port** — there is no manual byte-size
multiply, and a JS array grows on demand (`08-runtime-lib.md` "Container representation:
TS-native Array<T>"). **DROP the assert** with a comment explaining why, or escalate
(`11-escalate.md`) if a call site appears to *depend* on the bound for anything beyond the
malloc guard. **Never** emit `-1` (or any `number`) into the arithmetic: `SIZE_MAX = -1` is a
sentinel, and `-1 / Element.sizeof` is meaningless.

```ts
// dmd/common/smallbuffer.d:51,79 — overflow guard for raw malloc(length*sizeof): N/A in a GC'd
// port (no manual byte-size multiply; JS arrays grow on demand). Assert dropped intentionally.
```

> **Do not** reach for `SIZE_MAX` to "translate" the arithmetic guard. The two uses share a
> spelling in D and nothing else: one is a not-found marker (port → `-1` sentinel, equality
> only), the other is a `2^64 − 1` bound on a raw allocation (port → dropped, no JS analogue).

### 1.3.1 `bigint`-domain sentinels (`SIZE_INVALID`) — never transit a JS `number`

**HARD RULE (caught live in Rung 4b):** a value in the `uinteger_t`/`dinteger_t` **bigint**
domain — including its sentinels — must stay `bigint` **end-to-end**. Any function whose D
return type is `uinteger_t` returns `bigint` in TS, even when "the common value fits a
number". One `Number(...)` round-trip silently kills every downstream sentinel comparison:

```ts
// THE TRAP (real bug, found by adversarial verify in Rung 4b):
Number(SIZE_INVALID)          // 2^64 - 1 is not representable -> rounds to 2^64
BigInt(Number(SIZE_INVALID))  // 18446744073709551616n !== SIZE_INVALID (...615n)
```

**BAD** — the producing site narrows to `number`, the consumer re-widens, the guard goes dead:
```ts
function aggregateDeclSize(ad: AggregateDeclaration, loc: Loc): number {
    return ok ? ad.structsize : Number(SIZE_INVALID);   // sentinel destroyed HERE
}
// consumer: BigInt(aggregateDeclSize(...)) === SIZE_INVALID  -> ALWAYS false; the
// "size of type ... is invalid" diagnostic D emits (dsymbolsem.d:2182) can never fire.
```

**GOOD** — the sentinel never leaves the bigint domain:
```ts
function aggregateDeclSize(ad: AggregateDeclaration, loc: Loc): bigint {
    return ok ? BigInt(ad.structsize) : SIZE_INVALID;
}
```

> Relationship to §1.3: `size_t.max`-as-NOT-FOUND on an **index** lives in the `number`
> domain and ports to the `-1` sentinel. `SIZE_INVALID` on a **size/quantity** lives in the
> `bigint` domain and ports as the real `0xFFFF_FFFF_FFFF_FFFFn`. The rule is the same shape:
> pick the domain once, and the sentinel never crosses it. Widening a `uint` *field* into the
> bigint return (`BigInt(ad.structsize)`) is fine; narrowing the *sentinel* never is.

**ENFORCEMENT (mandatory per-file checklist item — the rule above shipped correct and was
still violated):**
1. After finishing a file, **grep it for `Number(`** and prove, hit by hit, that no argument
   is in the `uinteger_t`/`dinteger_t` (bigint) domain. A `Number(...)` on a bigint-domain
   value is a defect even when "the common value fits" — the sentinel does not.
2. **Ordering rule:** sentinel comparisons happen BEFORE any narrowing, never after a
   re-widen. `BigInt(narrowedValue) === SIZE_INVALID` is structurally dead code (the compare
   is against a value that was already destroyed) — if you find that shape, the narrowing
   upstream is the bug. **The one exception is a narrowing D ITSELF performs:** at
   `expressionsem.d:10944`, D writes `const uint fromSize = cast(uint)tFrom.size();` and then
   `if (fromSize == SIZE_INVALID)` — statically false in dmd too. Port both lines faithfully,
   with a comment naming the D line; the dead compare is D's, and "fixing" it would be a
   deviation. The rule stands for every narrowing the PORT introduces.
3. Any function whose D return type is `uinteger_t`/`dinteger_t`/`sinteger_t` returns
   `bigint` in TS — no per-call-site exceptions.

### 1.4 `T.sizeof` / `T.alignof` fold to the FIXED target widths

`T.sizeof` and `T.alignof` are compile-time constants whose values are fixed by our single
target (POSIX/64-bit/little-endian, `_config.md`). When the frontend uses them as a
**translation-time constant** (a width baked into the porter's own logic, not a runtime query),
fold them to the literal number for that target:

| D | TS | D | TS |
|---|--:|---|--:|
| `bool.sizeof`, `byte.sizeof`, `char.sizeof` | `1` | `int.sizeof`, `uint.sizeof`, `float.sizeof` | `4` |
| `short.sizeof`, `wchar.sizeof` | `2` | `long.sizeof`, `ulong.sizeof`, `double.sizeof`, `real.sizeof` | `8` |
| `dchar.sizeof` | `4` | `size_t.sizeof`, `ptrdiff_t.sizeof`, pointer `.sizeof` | `8` |

```d
// dmd/root/bitarray.d:22-24 — ChunkSize is size_t.sizeof folded at compile time
alias Chunk_t = size_t;
enum ChunkSize = Chunk_t.sizeof;      // == 8 on our 64-bit target
enum BitsPerChunk = ChunkSize * 8;    // == 64
```
```ts
// fold size_t.sizeof to the fixed target width — emit the literal, do not query at runtime
const ChunkSize = 8;            // size_t.sizeof on POSIX/64-bit
const BitsPerChunk = ChunkSize * 8;   // 64
```

> **Translation-time only.** This rule is for `.sizeof`/`.alignof` consumed by the porter as a
> fixed constant of *the* target. A `.sizeof` that the frontend folds into an `IntegerExp` for
> the *user's* program (i.e. it decides a compile outcome) is still part of the §0 carrier and
> stays `bigint` (§1.1 exception, §8) — but its value is the **same fixed number**, just carried
> in the bigint domain. Little-endian is assumed throughout; no byte-order branch is emitted.

---

## 2. Integer cast = mask-then-sign-extend (the exact truncation rule)

This is the rule the frontend's `normalize` (`dmd/expression.d:829`) implements, and the one
`_probes.md` §2 verified. **Memorize it; every store-into-a-narrower-type and every
`cast(IntType)` uses it.**

> **The rule (two steps, no exceptions):**
> 1. **Mask** the source value to the target width's low N bits (N ∈ {8, 16, 32, 64}).
> 2. **Reinterpret** the masked bits per the target's signedness:
>    - unsigned target → the raw masked value (`0 … 2^N − 1`)
>    - signed target → **sign-extend** from bit N−1 (`−2^(N−1) … 2^(N−1) − 1`)
> Width changes **never throw and never saturate** — they truncate/wrap silently.

Verified facts (`_probes.md` §2), stated plainly:

| D expression | Result | Why |
|---|---:|---|
| `cast(byte)200` | `-56` | low 8 bits `0xC8`, bit 7 set → signed |
| `cast(ubyte)-1` | `255` | low 8 bits `0xFF`, unsigned |
| `cast(ubyte)256` | `0` | low 8 bits of `0x100` |
| `cast(short)40000` | `-25536` | low 16 bits, sign bit set |
| `cast(int)0x1_0000_0001L` | `1` | keep low 32 bits `0x0000_0001` |
| `cast(int)0xFFFFFFFFu` | `-1` | low 32 = `0xFFFFFFFF`, sign bit set |
| `cast(uint)-1` | `4294967295` | low 32, unsigned |
| `cast(long)0xFFFFFFFFFFFFFFFFUL` | `-1` | 64-bit two's complement |
| `cast(ulong)-1L` | `18446744073709551615` | full 64-bit unsigned |
| `cast(byte)0x1FF` | `-1` | low 8 = `0xFF` |

**FLOAT → INTEGER is a different rule, and its edges are not mechanical.** The table above is
integer→integer; D also casts floats to integers (`cast(sinteger_t)rexp.toReal()`,
`expressionsem.d:201/206/227/231`). D **truncates toward zero** — it does not round — so the
body of the range is `BigInt(Math.trunc(x))` in the bigint domain, `Math.trunc(x)` in the
number domain. **The edges are a §2 escalation:** for NaN, ±Infinity, or a value outside the
target's range, D's result is target-defined, while `BigInt(NaN)` and `BigInt(Infinity)` THROW
a `RangeError` in JS. Emitting the bare conversion therefore turns a target-defined value into
a crash and silently changes the failure mode of a compile. Where the D site cannot prove its
operand finite and in range, escalate rather than picking a value.

### 2.1 TS helper signatures (the canonical truncation toolkit)

Put these in a single module `dmd/root/numeric.ts` (faithful to the `normalize` semantics).
**Always call the helper — never inline `& 0xFF` etc. at the use site** (one source of truth,
auditable, matches `IntegerExp.normalize`).

```ts
// number domain (≤ 32-bit) — mask then sign-extend, mirrors dmd/expression.d:829 normalize()
export function toInt8(x: number): number   { return (x << 24) >> 24; }
export function toUint8(x: number): number  { return x & 0xff; }
export function toInt16(x: number): number  { return (x << 16) >> 16; }
export function toUint16(x: number): number { return x & 0xffff; }
export function toInt32(x: number): number  { return x | 0; }
export function toUint32(x: number): number { return x >>> 0; }

// bigint domain (64-bit) — the carrier truncation. BigInt.asIntN/asUintN ARE mask+sign-extend.
export function toInt64(x: bigint): bigint  { return BigInt.asIntN(64, x); }
export function toUint64(x: bigint): bigint { return BigInt.asUintN(64, x); }

// generic width truncation in the bigint carrier (used by normalize port, any width)
export function maskSignedN(bits: number, x: bigint): bigint  { return BigInt.asIntN(bits, x); }
export function maskUnsignedN(bits: number, x: bigint): bigint { return BigInt.asUintN(bits, x); }

// wrapping arithmetic in the number/int32 domain (JS number does NOT wrap — see §3)
export function wrapAddI32(a: number, b: number): number { return (a + b) | 0; }
export function wrapAddU32(a: number, b: number): number { return (a + b) >>> 0; }
export function wrapMulI32(a: number, b: number): number { return Math.imul(a, b); }
export function wrapMulU32(a: number, b: number): number { return Math.imul(a, b) >>> 0; }
```

> `Math.imul(a, b)` is the **only** correct 32-bit signed multiply in the `number` domain —
> `(a * b) | 0` loses precision when `a * b` exceeds 2^53. Verified intent: `_probes.md` §3
> shows `100000*100000` (int) wraps to `1410065408`; `Math.imul(100000,100000) === 1410065408`.

### 2.2 The canonical `normalize` port (the heart of integer CTFE)

The frontend's `IntegerExp.normalize` is the single truncation gate for every folded integer.
Port it once, faithfully (carrier is `bigint`):

```ts
// faithful port of dmd/expression.d:829 IntegerExp.normalize — carrier is the 64-bit bigint
export function normalizeInteger(ty: TY, value: bigint): bigint {
  switch (ty) {
    case TY.Tbool:                       return (value !== 0n) ? 1n : 0n;
    case TY.Tint8:                       return maskSignedN(8, value);
    case TY.Tchar: case TY.Tuns8:        return maskUnsignedN(8, value);
    case TY.Tint16:                      return maskSignedN(16, value);
    case TY.Twchar: case TY.Tuns16:      return maskUnsignedN(16, value);
    case TY.Tint32:                      return maskSignedN(32, value);
    case TY.Tdchar: case TY.Tuns32:      return maskUnsignedN(32, value);
    case TY.Tint64:                      return maskSignedN(64, value);
    case TY.Tuns64:                      return maskUnsignedN(64, value);
    case TY.Tpointer:                    return maskUnsignedN(64, value); // target.ptrsize==8
    default:                             return value;
  }
}
```

**Invariant:** `IntegerExp.value` in the port is a `bigint` holding the *normalized* bit
pattern. The `IntegerExp` **constructor** runs `normalizeInteger` internally (matches the D
ctor body `dmd/expression.d:766`), and so does `setInteger` (`dmd/expression.d:826`). Because
the ctor normalizes, **fold call sites pass the raw carrier result and do NOT re-wrap it in
`normalizeInteger`** (§3, and `02-types.md` §11.1). Skipping the ctor's normalize would leave
an un-normalized value that breaks the next comparison or fold — a silent corruption.

---

## 3. Integer overflow / wraparound (two's complement, modulo 2^width)

Verified (`_probes.md` §3): all integer arithmetic — signed and unsigned — **wraps modulo
2^width** with no overflow trap. Signed overflow is deterministic two's-complement wrap at
this level (NOT treated as UB by the folder).

| D expression | Result |
|---|---:|
| `int.max + 1` | `-2147483648` |
| `uint.max + 1` | `0` |
| `long.max + 1` | `-9223372036854775808` |
| `ulong.max + 1` | `0` |
| `100000 * 100000` (int) | `1410065408` |
| `int.min * -1` | `-2147483648` (wraps back to `int.min`) |

**Port rules per domain:**

- **`number` (≤ 32-bit):** JS `number` does **NOT** wrap — `2147483647 + 1 === 2147483648`,
  which is wrong for a D `int`. After any op that can overflow 32 bits, **re-truncate**:
  signed → `| 0` (`wrapAddI32`), unsigned → `>>> 0` (`wrapAddU32`), multiply → `Math.imul`.
- **`bigint` (64-bit):** BigInt is unbounded — it does not wrap. After any 64-bit op,
  re-truncate with `toInt64`/`toUint64` (`BigInt.asIntN/asUintN(64, …)`).

**Which re-truncation, when D's local is `uinteger_t` but the file's carrier is signed?** The
naive reading — wrap with `toUint64` to match D's *declared* type — is wrong: it pushes that
one local into the unsigned domain while its neighbours (and the `IntegerExp` ctor) stay
signed-normalized, and `!==` then fails for every negative value. The settling rule:
**two's-complement `+` and `-` are the same bit operation in either interpretation, and `==` /
`!=` are interpretation-independent, so the correct re-truncation is the one that PRESERVES
THE FILE'S CARRIER DOMAIN.** `toUint64` and `toInt64` diverge only for `<`, `>`, `/` and `%` —
if the D code performs one of those on the local, the declared type decides and the operands
around it must be brought into that domain explicitly. Worked case: `visitCaseRange`'s
`for (uinteger_t i = fval; i != lval + 1; i++)` uses `+` and `!=` only, so it stays in the
file's signed-normalized carrier.

```d
// dmd/constfold.d:212 — D: carrier add; the IntegerExp ctor normalizes by type (expression.d:766)
emplaceExp!(IntegerExp)(&ue, loc, e1.toInteger() + e2.toInteger(), type);
```
```ts
// TS faithful: add in the bigint carrier and pass the raw result — the ctor normalizes (see note)
new IntegerExp(loc, e1.toInteger() + e2.toInteger(), type);
```

> **The ctor normalizes — do NOT wrap call sites in `normalizeInteger`.** The ported
> `IntegerExp` constructor runs `normalizeInteger` internally (mirroring `dmd/expression.d:766`,
> §2.2 invariant), so every fold call site passes the **raw** carrier result, exactly as
> `02-types.md` §11.1 shows (`new IntegerExp(loc, -e1.toInteger(), type)`). A second
> `normalizeInteger(…)` at the call site is redundant — normalize once, in the ctor.

> The `emplaceExp!(IntegerExp)(&ue, …)` → `new IntegerExp(…)` rewrite (the `UnionExp` carrier
> and `emplaceExp` mechanics behind every CTFE expression construction) is owned by
> `02-types.md` "UnionExp / emplaceExp (CTFE expression construction)". Do not re-improvise the
> wrapper here — this doc shows only the numeric carrier (`bigint` + `normalizeInteger`).

> **`int.min / -1` and `long.min / -1` are a HARD COMPILE ERROR**, not a wrap — the frontend
> rejects them explicitly during folding. Reproduce the error, do not wrap:
> ```d
> // dmd/constfold.d:323-337 — Div checks min/-1 and emits "integer overflow"
> if (n2 == -1 && !type.isUnsigned()) { ... error(e2.loc, "integer overflow: `int.min / -1`"); ... }
> ```
> Diagnostic text is reproduced verbatim per `_ground-truth.md` §1.5 (`10-tests-diagnostics.md`).

### 3.1 Signed vs unsigned division / modulo / comparison over the SAME bits

Division, modulo, and comparison **change result based on the operands' signedness**, reading
the *same 64-bit carrier* as signed or unsigned. This is why the carrier must be `bigint`:
you cannot recover the signed-vs-unsigned distinction once precision is lost.

```d
// dmd/constfold.d:339-342 — Div: if either operand unsigned, divide as unsigned (dinteger_t)
if (e1.type.isUnsigned() || e2.type.isUnsigned())
    n = (cast(dinteger_t)n1) / (cast(dinteger_t)n2);   // unsigned 64-bit divide
else
    n = n1 / n2;                                       // signed 64-bit divide
// dmd/constfold.d:904-907 — Cmp: pick unsigned or signed comparator by operand signedness
if (e1.type.isUnsigned() || e2.type.isUnsigned())
    n = intUnsignedCmp(op, n1, n2);
else
    n = intSignedCmp(op, n1, n2);
```

Verified (`_probes.md`-style probe, `ldc2 -run`): with `sneg = -1L` and `ubig = cast(ulong)sneg`
(same bits `0xFFFF_FFFF_FFFF_FFFF`): `sneg < 1L` is **true** (signed), `ubig < 1UL` is **false**
(unsigned). Same bits, opposite result.

```ts
// faithful: divide reads the carrier as signed or unsigned per operand signedness
function foldDiv(type: Type, e1: Expression, e2: Expression): bigint {
  const n1 = e1.toInteger(), n2 = e2.toInteger();          // bigint carrier (normalized)
  if (e1.type.isUnsigned() || e2.type.isUnsigned())
    return toUint64(n1) / toUint64(n2);                     // BigInt / truncates toward zero
  return toInt64(n1) / toInt64(n2);
}
```

> **Trap — BigInt division rounds toward zero**, same as D integer division: `(-7n) / 2n === -3n`.
> This matches D. Do NOT use `Math.floor`-style division. Modulo: BigInt `%` is the
> remainder (sign follows dividend), matching D's `%`. Verify any edge with `ldc2` if unsure.

#### Division / modulo by a zero divisor — `divide by 0` in constant folding, udiv's 0 elsewhere

Integer division or modulo by a zero divisor in the frontend's constant folding, which CTFE's integer `/`
and `%` also go through (`int k() { int z = 0; return 1 / z; } enum e = k();` is `divide by 0` in ldc2),
is the compile error `divide by 0`, as dmd's constfold emits it (`constfold.d:317`, `:382`):
`error(loc, "divide by 0")` at the site's natural loc, then the site's own failure result. Never a BigInt
`RangeError`, never a silent `0`.

Everywhere else the port follows what ldc2's arm64 division yields. ldc2 compiles D `/` to arm64
`udiv`/`sdiv`, which return 0 for a zero divisor (`24UL / 0` is `0`, `-24L / 0` is `0`, `7L % 0` is `7`:
probed with `ldc2 -run`, divisor read at run time). So a division whose divisor is the size of a zero-size
type (`int[0]`, `noreturn`) takes `divisor === 0n ? 0n : dividend / divisor` and compiles on, with no error:
- `dcast.d:1483` `tx = tbn.sarrayOf(t1b.size() / tbn.size());` in `implicitConvTo`, a match query that
  overload resolution runs ungagged on every candidate. An error there would reject overload sets ldc2
  resolves (`int foo(immutable(int[0])[]); int foo(const(int[0])[]); foo(h()[]);` compiles with ldc2).
- The CTFE sites `ctfeexpr.d:813`, `:824`, `:826` (`pointerArithmetic`) and `dinterpret.d:1908`, `:1909`,
  `:1937` (the SymOffExp pointer cast).

Probes (ldc2 compiles each and the function returns its value):
`__gshared int[0][3] ga; int k() { int[0]* p = &ga[0]; p = p + 1; p = p - 1; p -= 5; return 4; }`;
`int m() { int[0][3] a; int[0]* p = &a[0]; p = p + 1; --p; return 1; }`;
`int[0][4] v; auto p = cast(int[0][2]*)&v;` and `auto p = cast(int[0]*)&v;`.

A new zero-capable divisor outside constant folding is decided the same way: by what ldc2's arm64 division
yields, stated in a comment at the site. Only constant folding keeps `divide by 0`.

#### Equality against an unsigned-suffixed hex literal — read the literal into the signed domain

Equality has the **same trap as comparison**, and it is the one the frontend's own `Div`
overflow guard relies on: a signed carrier is compared against a `UL`-suffixed hex literal that
spells the *bit pattern* of a negative value. In D both sides are the same 64-bit `dinteger_t`,
so the comparison is a plain bit-pattern match. **VERIFIED** (`ldc2 -run`): `int.min ==
0xFFFFFFFF80000000UL` is **`true`** (and `long.min == 0x8000000000000000L` is the long-min
form). The frontend uses exactly this to detect `int.min / -1`:

```d
// dmd/constfold.d:326 — int.min detected by its 64-bit bit pattern, written as a UL hex literal
if (n1 == 0xFFFFFFFF80000000UL && type.toBasetype().ty != Tint64)
// dmd/constfold.d:332 — long.min detected the same way
else if (n1 == 0x8000000000000000L) // long.min / -1
```

The **naive port silently breaks**: a `UL` literal becomes a *positive* bigint
(`0xffffffff80000000n` === `18446744071562067968n`), so `n1 === 0xffffffff80000000n` compares a
signed-domain `-2147483648n` against a positive bigint → silently **`false`**, and the
`int.min / -1` guard never fires. The carrier in the port is signed-normalized `bigint` (§2),
so the comparand must enter the **same** signed domain.

> **Canonical:** read the unsigned-suffixed literal into the signed domain before comparing —
> `n1 === toInt64(0xffffffff80000000n)` (or compare both sides at the same width and
> signedness). Never compare a normalized signed `bigint` against a raw positive `0x…n`.

```d
// dmd/constfold.d:326,332 — D: same-bits equality, literal written as UL/L hex
if (n1 == 0xFFFFFFFF80000000UL && type.toBasetype().ty != Tint64) { /* int.min / -1 */ }
else if (n1 == 0x8000000000000000L) { /* long.min / -1L */ }
```
```ts
// TS faithful: bring the bit-pattern literal into the signed carrier domain (toInt64)
if (n1 === toInt64(0xffffffff80000000n) && type.toBasetype().ty !== TY.Tint64) { /* int.min/-1 */ }
else if (n1 === toInt64(0x8000000000000000n)) { /* long.min / -1L */ }
// toInt64(0xffffffff80000000n) === -2147483648n   — matches the normalized signed carrier
```

---

## 4. Bit operations and shifts

Verified (`_probes.md` §4):

| D expression | Result | Note |
|---|---:|---|
| `0xF0 & 0x0F` | `0` | |
| `0xF0 \| 0x0F` | `255` | |
| `0xF0 ^ 0xFF` | `15` | |
| `~0` (int) | `-1` | 32-bit one's complement |
| `~0u` (uint) | `4294967295` | 32-bit unsigned |
| `1 << 31` (int) | `-2147483648` | result type = left operand = `int` (32-bit) |
| `1L << 40` (long) | `1099511627776` | result type = left operand = `long` (64-bit) |
| `-8 >> 1` | `-4` | `>>` is **arithmetic** (sign-replicating) |
| `-8 >>> 1` | `2147483644` | `>>>` is **logical** (zero-fill) on operand width |

**Established rules:**

- `& | ^ ~` operate at the operand's **promoted** width (§7 — narrow types promote to `int`).
- `<< >> >>>` result type = the **(promoted) left operand's** type. `1 << 31` is 32-bit `int`;
  `1L << 40` is 64-bit `long`. This decides the domain (`number` vs `bigint`) of the result.
- `>>` is **arithmetic** (sign bit replicated). `>>>` is **logical** (zero-fill) over the
  operand width.

### 4.1 Port: `number` (32-bit) domain — map to JS operators directly

JS bitwise operators coerce to **int32**, which matches D's 32-bit integer ops exactly:

| D (32-bit) | TS | Caveat |
|---|---|---|
| `a & b` | `a & b` | |
| `a \| b` | `a \| b` | |
| `a ^ b` | `a ^ b` | |
| `~a` | `~a` | yields signed int32 (`~0 === -1`) — matches `int` |
| `a << n` | `(a << n) \| 0` | `\| 0` keeps it int32 (JS `<<` already int32) |
| `a >> n` (signed) | `a >> n` | arithmetic shift |
| `a >>> n` (`uint`) | `a >>> n` | logical shift — JS `>>>` gives the unsigned int32 |

> For an **unsigned** `uint` result you usually want `>>> 0` to keep the value in `0 … 2^32−1`
> (JS bitwise yields a *signed* int32 otherwise). E.g. `~0u` → `(~0) >>> 0 === 4294967295`.

### 4.2 Port: `bigint` (64-bit) domain — BigInt operators, then re-truncate

BigInt supports `& | ^ ~ << >>` but **has no `>>>`** and is unbounded, so re-truncate:

| D (64-bit `long`/`ulong`) | TS | Note |
|---|---|---|
| `a & b` | `a & b` | bigint |
| `a \| b` | `a \| b` | bigint |
| `a ^ b` | `a ^ b` | bigint |
| `~a` | `toInt64(~a)` / `toUint64(~a)` | re-truncate to 64 bits |
| `a << n` | `toInt64(a << n)` / `toUint64(a << n)` | re-truncate (BigInt `<<` is unbounded) |
| `a >> n` (signed `long`) | `a >> n` | BigInt `>>` is arithmetic — correct for `long` |
| `a >>> n` (`ulong`) | `toUint64(a) >> n` | **emulate logical shift**: operate on the unsigned value |

> **BigInt has no `>>>`.** For a `ulong` logical shift, first make the value unsigned
> (`toUint64`), then use BigInt `>>` — on a non-negative bigint, arithmetic and logical shift
> coincide. The frontend's `Ushr` masks to the operand width before shifting, which is
> exactly this pattern:
> ```d
> // dmd/constfold.d:567-570 — >>> on narrow types: mask to width, then logical shift
> case Tint32: case Tuns32: case Tdchar:
>     value = (value & 0xFFFFFFFF) >>> count;   // mask to 32 bits, then zero-fill shift
> // dmd/constfold.d:572-574 — 64-bit case: shift the full carrier
> case Tint64: case Tuns64:
>     value = value >>> count;
> ```

> **JS `>>>` and BigInt do NOT interoperate** (`1n >>> 1n` is a TypeError). Never mix.

### 4.3 Shift count ≥ width

- **Compile-time-constant count ≥ width is a HARD COMPILE ERROR in D**, not a wrap
  (`_probes.md` §4): `1 << 32` → `Error: shift by 32 is outside the range 0..31`. **The
  frontend's own source therefore never contains such a literal shift** — the port need not
  emulate any wrap for constant counts. (If the port is the one *emitting* that diagnostic for
  user code, that is folding logic in `*sem.d`, reproduced verbatim — `10-tests-diagnostics.md`.)
- **Runtime (non-constant) count ≥ width is UB per the D spec.** On this AArch64 host the
  count is masked (`1 << 32` runtime → `1`), but **do NOT rely on that mask.** Frontend code
  that shifts by a runtime amount already guarantees `count < width` by its own logic (e.g.
  `Shr`/`Ushr` assert `dcount <= 0xFFFFFFFF` and switch on the known type width,
  `dmd/constfold.d:505`). Port the logic 1:1; do not add a masking step the source lacks.
- **Declared exception: dfa/fast/structure.d's DFAPAValue shifts** (`leftShiftBy`,
  `rightShiftSignedBy`, `rightShiftUnsignedBy`, structure.d:3322-3445) shift by a count the source does
  not bound: the count can reach the width, or turn negative after a narrowing cast. There the port
  follows ldc2's arm64 codegen, the count modulo 32 / 64 (`lsl`/`asr`/`lsr`), stated in a comment at the
  site, as for a zero divisor (§3.1). A standalone ldc2 `-O3` build of the struct matched this on
  131,750 cases.

---

## 5. Mixed `number`/`bigint` is a TypeScript type error — where the boundary sits

`1n + 1` throws at runtime (`TypeError: Cannot mix BigInt and other types`) and TS flags it at
compile time. The port must **never** mix the domains in one expression. The boundary is
decided by D's *usual arithmetic conversions* (`_probes.md` §10):

| D mixed expression | Result type | Port domain |
|---|---|---|
| `byte + byte`, `ubyte + ubyte`, `short + short`, `char + char`, `char + 1` | `int` | `number` (promote to int, §7) |
| `int + long` | `long` | **bigint** |
| `int + uint` | `uint` | `number` (same width, unsigned wins) |
| `uint + long` | `long` | **bigint** (long is wider, holds all uint values) |
| `long + ulong` | `ulong` | **bigint** (same width, unsigned wins) |

**The conversion rule:** the result *width* drives the domain. Once any `long`/`ulong` enters
an expression, the whole expression is `bigint`; the narrower `number` operand must be widened
with `BigInt(x)` **at the boundary, before the op**:

```d
// dmd/constfold.d:203 — SymOffExp offset (size_t/bigint carrier) + e2.toInteger() (carrier)
emplaceExp!(SymOffExp)(&ue, loc, soe.var, soe.offset + e2.toInteger());
```
```ts
// crossing number→bigint: widen explicitly with BigInt(), never let TS coerce
const off: bigint = soe.offset + e1.toInteger();        // both bigint — fine
const widened: bigint = BigInt(numberIndex) + bigVal;   // explicit widen at the boundary
```

**Where this lives in the frontend:** the boundary is `constfold.d` and `dinterpret.d`. In the
real code the boundary is invisible because **the carrier is uniformly `dinteger_t` (ulong)** —
D silently promotes the narrow operand. In the port, `number` and `bigint` are distinct, so
**you must insert the `BigInt(...)` widen wherever D's usual-arithmetic-conversion promotes a
narrow operand into a `long`/`ulong` context.** The result type (from the AST node's `type`,
which `*sem.d` already computed) tells you which domain the fold lands in: integral-and-≤32-bit
→ `number`; integral-and-64-bit → `bigint`.

> **STOP if** you cannot determine statically whether a folded expression's result type is
> ≤ 32-bit or 64-bit (e.g. it depends on an unresolved template type). The domain choice is
> not guessable. Escalate (`11-escalate.md`).

> **Never** use JS implicit coercion across the boundary, and never use `Number(aBigInt)` to
> "downcast" a 64-bit value into the `number` domain unless you have **proven** it fits in
> 2^53 *and* fidelity does not depend on the high bits (it almost never does in CTFE). A
> silent `Number()` of a `ulong` is exactly the corruption this doc exists to prevent.

---

## 6. Floating point — `float`, `double`, `real` all → `number`

Verified (`_probes.md` §6, re-confirmed by `/tmp/numprobe2.d`, `/tmp/numprobe3.d`):

- **`real` is 64-bit IEEE-754 double on this target** (`real.sizeof == 8`, `real.mant_dig == 53`)
  — NOT x87 80-bit. `RealExp.value` is `real_t` (`dmd/expression.d:1001`) and
  `real_t = longdouble` (`dmd/root/ctfloat.d:24`), which on our target is a plain `double`.
- **CTFE / constant folding uses the same 53-bit double precision as runtime.** `0.1L + 0.2L`
  folds to `0.30000000000000004`, bit-identical to the runtime double. JS `number` reproduces
  this exactly — **no extended-precision emulation needed.**

```d
// dmd/constfold.d:120 — Add on reals: plain double add, stored at real_t precision
emplaceExp!(RealExp)(&ue, loc, e1.toReal() + e2.toReal(), type);
```
```ts
new RealExp(loc, e1.toReal() + e2.toReal(), type);   // plain JS number add — exact
```

### 6.1 `float` does NOT need `Math.fround` in CTFE — VERIFIED, and it is subtle

The frontend stores **every** floating constant in a `real_t` (double) carrier and **never
rounds to f32 during constant folding** — not even for a `float`-typed literal or a
`cast(float)`. This diverges from *runtime* behavior, where a `float` variable is f32-rounded.

Verified bit-exact (`ldc2 -run /tmp/numprobe2.d`, `/tmp/numprobe3.d`):

| Expression | Context | Result (20 sig. digits) | f32-rounded? |
|---|---|---|---|
| `cast(double)(0.1f)` | **runtime** | `0.10000000149011611938` | **yes** (f32) |
| `enum float CT = 0.1f;` | **CTFE** | `0.10000000000000000555` | **no** (double of 0.1) |
| `enum float = 0.1f + 0.2f;` | **CTFE** | `0.30000000000000004441` | **no** (= double `0.1+0.2`) |
| `enum float = cast(float)16777217.0;` | **CTFE** | `16777217` | **no** (f32 would give 16777216) |

Confirmed in code: `Cast` to a real type stores the value unchanged at `real_t` precision, with
no f32 truncation step:

```d
// dmd/constfold.d:1028-1032 — cast to a real type: keep real_t precision, NO f32 rounding
else if (tb.isReal())
{
    real_t value = e1.toReal();
    emplaceExp!(RealExp)(&ue, loc, value, type);
}
```

> **Rule (decisive):** in the ported CTFE / constant folder, treat `float` exactly like
> `double` — a plain `number`. **Do NOT call `Math.fround`.** Adding `Math.fround` would make
> the port *diverge* from the frontend we are matching (it would round where DMD does not),
> corrupting `fail_compilation`/`compilable` float-constant test parity.

> **Scope caveat:** this is the rule for the **frontend's constant folder** (our scope). The
> f32-rounding the frontend *applies to user-program runtime floats* lives in codegen, which
> is **out of scope** (`_ground-truth.md` §1.3). If you ever meet frontend code that
> explicitly rounds a constant to f32 (e.g. a range/precision check in the lexer or in
> `*sem.d` semantic checking that emits a "not representable" diagnostic), that is a real
> behavior to port — but it is a *diagnostic check*, not a change to the stored carrier. STOP
> and escalate if a fold path appears to f32-round a value.

### 6.2 NaN / Infinity

Verified (`_probes.md`-style, `ldc2 -run`): `double.nan == double.nan` is **false**;
`double.infinity` prints `inf`; `float.max` overflow yields `inf`. JS matches IEEE-754
exactly: `NaN === NaN` is `false`, `Infinity`, `-Infinity`, overflow → `Infinity`.

| D | TS |
|---|---|
| `double.nan` | `NaN` |
| `double.infinity` | `Infinity` |
| `-double.infinity` | `-Infinity` |
| `CTFloat.isNaN(x)` | `Number.isNaN(x)` |

**NaN comparison trap (the frontend handles it explicitly — match it):** `realCmp` special-cases
NaN so that `<`, `<=`, `>`, `>=` all return `false` when either operand is NaN, instead of
trusting the platform:

```d
// dmd/ctfeexpr.d:1030-1046 — realCmp: NaN is unordered → all ordered comparisons false
if (CTFloat.isNaN(r1) || CTFloat.isNaN(r2)) {
    switch (op) {
    case EXP.lessThan: case EXP.lessOrEqual: case EXP.greaterThan: case EXP.greaterOrEqual:
        return false;
    default: assert(0);
    }
}
```

JS `<`/`<=`/`>`/`>=` already return `false` for NaN operands, so a direct port is correct —
**but keep the explicit NaN guard when porting `realCmp`** for fidelity and because the
`assert(0)` on the default branch is load-bearing (it asserts equality ops never reach here).

**D `is` on FLOATING-POINT operands is bit-pattern identity, not `===`.** `-0.0 is 0.0` is
**false** in D (different bit patterns) while `-0.0 === 0.0` is true in JS, and `nan is nan` is
**true** in D while `NaN === NaN` is false. Both directions diverge, so the mapping is exact:

| D                          | TS                 |
|----------------------------|--------------------|
| `a is b` (float operands)  | `Object.is(a, b)`  |
| `a !is b` (float operands) | `!Object.is(a, b)` |

For CLASS or reference operands, `is` stays `===` (identity of the reference) — do not
generalise `Object.is` to those, and do not generalise `===` to floats.

### 6.2.1 Floating → integer casts SATURATE on our target

The `§2` rule "width changes never saturate" is about integer-to-integer casts. A cast from a floating
value to an integer type compiles to arm64 `fcvtzs`/`fcvtzu`, which SATURATE and map NaN to 0 (verified
with ldc2 1.43.0):

| D                                  | result on arm64-apple-darwin |
|------------------------------------|------------------------------|
| `cast(long)` of NaN                | `0`                          |
| `cast(long)` of `x ≥ 2^63`, `+inf` | `long.max`                   |
| `cast(long)` of `x ≤ -2^63`, `-inf`| `long.min`                   |
| `cast(ulong)` of NaN, `x < 0`, `-inf` | `0`                       |
| `cast(ulong)` of `x ≥ 2^64`, `+inf`| `ulong.max`                  |
| `cast(int)` of `x ≥ 2^31` / `x ≤ -2^31` | `int.max` / `int.min` (e.g. `3e9`, `-1e10`) |
| `cast(uint)` of NaN, `x < 0` / `x ≥ 2^32` | `0` / `uint.max` (e.g. `-1.5`, `5e9`) |

The 32-bit casts saturate at 32 bits (the conversion targets a W register), not at 64 then truncate.
Values in range truncate toward zero. The canonical helpers are `castToSinteger` / `castToUinteger` in
`src/dmd/expressionsem.ts` (the home of D's `toInteger`/`toUInteger` on `RealExp`); new code calls them
and never writes `BigInt(Math.trunc(v))`, which throws on NaN and on infinities. Instance where the
saturation decides a fold: `x ^^ 9223372036854775808.0` becomes `pow(x, 9223372036854775807L)`
(optimize.d:1095).

### 6.3 Float literal suffixes

| D literal | Meaning | Port |
|---|---|---|
| `0.1` | `double` | `number` literal `0.1` |
| `0.1f` / `0.1F` | `float` (still `number` carrier, §6.1) | `number` literal `0.1` (NO `fround`) |
| `0.1L` | `real` (= double on target) | `number` literal `0.1` |
| `1.5e10`, `0x1.8p3` (hex float) | `double`/scalar | the decimal/hex-float value as a `number` |

The lexer determines the float token kind and emits a range diagnostic on overflow:

```d
// dmd/lexer.d:3034-3054 — float literal suffix → token kind (f→float32, L→float80/real)
isOutOfRange = Port.isFloat32LiteralOutOfRange(sbufptr);   // 'f' suffix range check
...
result = TOK.float80Literal;                               // 'L' suffix
// dmd/lexer.d:3088 — the suffix string used in diagnostics: "f", "L", or ""
const char* suffix = result == TOK.float32Literal ? "f" : result == TOK.float80Literal ? "L" : "";
```

> The **type** carried by the literal differs by suffix (`float` vs `double` vs `real`), but
> the **stored value domain is `number` in all cases** (§6.1). The suffix matters for the
> AST node's `type` (which drives later type-checking and diagnostics), not for the numeric
> representation. Port the suffix→type mapping faithfully; do not f32-round the value.

---

## 7. `char` / `wchar` / `dchar` arithmetic

A single `char`/`wchar`/`dchar` value is a `number` (`02-types.md` §1). Their **arithmetic
promotes to `int`** (`_probes.md` §10), so it lives in the 32-bit `number` domain:

Verified (`ldc2 -run`): `'A' + 1` has type `int`, value `66`. `dchar '€'` is `8364`
(U+20AC). `char + char`, `char + 1`, `wchar + wchar` all → `int`.

```d
// dmd/lexer.d:1196 — dchar holds a decoded code point (a number)
dchar c = *p;
```

| D | TS | Note |
|---|---|---|
| `char c = 'A';` | `const c: number = 0x41;` | byte value 65 |
| `c + 1` | `c + 1` | result is `int` (`number`); store-back to `char` → `toUint8` |
| `dchar dc = '€';` | `const dc: number = 0x20ac;` | code point 8364 |
| `cast(char)(c + 1)` | `toUint8(c + 1)` | truncate the int result back to 8-bit (§2) |

> Promotion-to-`int` means a `char`/`wchar`/`dchar` arithmetic result is a `number` in the
> 32-bit domain, never `bigint`. Storing it back into a `char`/`wchar`/`dchar` field re-applies
> the §2 truncation (`toUint8`/`toUint16`/`toUint32`). A `char[]`/`string` is a **byte array**,
> not these scalars — that model is owned by `08-runtime-lib.md`.

---

## 8. Where exactness DECIDES a compile outcome → `bigint` is MANDATORY

The `number` domain is permitted **only** when the value is provably within 2^53 **and** an
off-by-one or high-bit error cannot change a compile result. Wherever the bits decide a
compile outcome, the value is part of the §0 carrier and is **`bigint`, no exceptions**:

| Site | Why exactness decides the outcome | Cite |
|---|---|---|
| **Constant folding** (`Add`/`Mul`/`Div`/`Shl`/`Cast`/…) | the folded `IntegerExp.value` is the program's constant; a wrong bit is a wrong program | `dmd/constfold.d:212`, `dmd/expression.d:751` |
| **CTFE** (`dinterpret.d` evaluating `enum`/`static`/array-bound exprs) | the interpreter's integer results feed `static if`, array sizes, `static assert` | `dmd/dinterpret.d` (carrier `dinteger_t`) |
| **Enum member values** (`long`/`ulong` base) | a `long`-based enum member exceeding 2^32 (e.g. `STC`) must be exact | `dmd/astenums.d` STC (`02-types.md` §4.2) |
| **Array sizes / lengths in CTFE** | a static-array length is a folded `size_t` constant; wrong size → wrong type | `IntegerExp` carrier |
| **Signed vs unsigned compare/div** in folding | same bits, different result — only `bigint` preserves the distinction | `dmd/constfold.d:339`, `:904`; `dmd/ctfeexpr.d:1018-1027` |
| **Hashes used as identity with NO equality re-check** | nothing catches a collision, so truncation silently merges two symbols | `dmd/root` hash paths |
| **Name mangling** | mangled lengths/values must be byte-exact for symbol identity & diagnostics | `dmd/mangle/package.d:887,1233` |
| **128-bit folding** (`Cent`) | two 64-bit limbs; each limb is a `ulong` → `bigint` | `dmd/common/int128.d:23-27` |

> **Hash domain — the tie-break** (this table, the cheatsheet's `toHash(): number`, and
> `08-runtime-lib.md §9.1`'s 32-bit `mixHash(a: number, b: number)` otherwise read as three
> different answers). *A hash whose collisions are resolved by an adjacent `opEquals`/`equals`
> does not decide a compile outcome by itself, so it is **domain-free**: pick the domain that
> lets you call the SAME `hash.d` function D calls* — in practice `mixHash` in the `number`
> domain, which is what the emitted `toHash` methods use, D `size_t` notwithstanding. A hash
> consumed as an identity **without** an equality re-check keeps the row above and stays
> `bigint`.

```d
// dmd/common/int128.d:23-27 — Cent is two 64-bit ulong limbs → each limb is bigint in the port
align(16) struct Cent { U lo; U hi; }   // U = ulong
```

> **`Cent`** ports as a normal value-type `struct` (`class Cent` per `02-types.md` §2, with
> `.copy()` per `03-value-semantics.md`), whose two fields `lo`/`hi` are `bigint`. Its
> arithmetic (`add`/`mul`/`shl`/…) is the `bigint`-limb algorithm in `int128.d`, ported 1:1.
> Operator rewrites for `Cent` (if any `opXxx`) → `05-operators.md`.

> **The litmus test:** *"If this integer were off by one bit, could a different program
> compile, a different diagnostic fire, or a different symbol be named?"* If yes → `bigint`.
> Indices, loop counters, and `.length` walks that only address memory and never feed a
> constant fold → `number`. When you cannot answer the litmus test, the safe default is
> `bigint`, and if the *type* is genuinely ambiguous, STOP (`11-escalate.md`).

---

## 9. Numeric truthiness

D permits a **numeric** value in a boolean context — `if (x)`, `while (x)`, `x || y`,
`x && y`, `!x`, the ternary condition. This holds for every numeric scalar (`int`, `uint`,
`long`, `ulong`, `float`, `double`, `real`, and a single `char`/`wchar`/`dchar`). The test
D applies is always the same: **`x != 0`** (for floats, `x != 0.0`, so `NaN`/`±0.0` follow
IEEE — `0.0` and `-0.0` are falsy, `NaN` is truthy because `NaN != 0` is `true`).

> **Decisive rule (scoped by where JS truthiness actually diverges):**
> - **MANDATORY explicit expansion** for: any **float** (`float`/`double`/`real`) value — the
>   live trap: D's `if (nanValue)` is TRUE (`NaN != 0` holds) while JS treats `NaN` as falsy,
>   so a bare `if (x)` on a float **inverts the branch** for NaN; any **enum-typed** value
>   (§9.1); any `&&`/`||` whose result feeds a `bool` slot (D yields `bool`, JS yields an
>   operand); and any value whose static type is not provably a plain integral.
> - **OPTIONAL** for a value provably in the plain-integer domain (`number`-domain integral or
>   `bigint`): there JS truthiness coincides with `!= 0` exactly (`0`/`0n` falsy, all else
>   truthy), so a bare `if (x)` is faithful — the expanded form is still preferred for
>   uniformity, but is not a defect.
> A blanket always-expand rule proved unenforceable in practice (it was ignored at scale, which
> trains translators to ignore it where it matters); this scoping keeps the mandatory core
> credible. When you cannot classify the operand's domain, expand — and if the domain is
> genuinely undecidable, STOP (`11-escalate.md`).

This is the same discipline as `06-control-flow.md` §2.5 (which owns the `if`/`while`/`for`
control-flow rewrite). This section owns the **numeric** rule and its per-domain spelling.

| D (numeric `x`/`a`/`b`) | TS (`number` domain) | TS (`bigint` domain) |
|---|---|---|
| `if (x)` | `if (x !== 0)` | `if (x !== 0n)` |
| `while (x)` | `while (x !== 0)` | `while (x !== 0n)` |
| `!x` | `x === 0` | `x === 0n` |
| `a \|\| b` (numeric operands; D yields `bool`) | `(a !== 0) \|\| (b !== 0)` | `(a !== 0n) \|\| (b !== 0n)` |
| `a && b` (numeric operands) | `(a !== 0) && (b !== 0)` | `(a !== 0n) && (b !== 0n)` |

> Pick the comparand by the operand's domain (§1): a `number`-domain scalar compares against
> `0`, a 64-bit `long`/`ulong` (`bigint`) compares against `0n`. Mixing them is a TS type error
> (§5) — never write `bigVal !== 0`.

> **`&&`/`||` yield `bool` in D, not the operand.** D's logical operators always produce a
> `bool` (unlike JS, where `a || b` returns one of the *operands*). When the D result feeds a
> `bool`-typed slot, the expanded `(a !== 0) || (b !== 0)` is already `boolean` — correct. Do
> **not** port `a || b` to a bare JS `a || b` that would yield a `number`.

### 9.1 Enum-typed value in a boolean context

A value whose type is an integer-backed `enum` (`enum E : int`, the default base — `02-types.md`
§4.2) used in a boolean context follows the **same `!= 0` rule**: D enums are integer-backed, the
test is against the member that equals `0`. This is exactly how the frontend tests a `MATCH`
result — `MATCH : int` with `nomatch == 0` as the first member (`dmd/astenums.d:432`):

```d
// dmd/templatesem.d:6392 — a MATCH value used directly as a boolean (falsy == MATCH.nomatch == 0)
else if (MATCH m = deduceTypeHelper(t, tt, tparam)) { ... }
```

| D (enum-typed `matchEnum`) | TS (canonical) | TS (named-zero, optional) |
|---|---|---|
| `if (matchEnum)` | `if (matchEnum !== 0)` | `if (matchEnum !== MATCH.nomatch)` |
| `x && matchEnum` | `(x !== 0) && (matchEnum !== 0)` | `(x !== 0) && (matchEnum !== MATCH.nomatch)` |
| `!matchEnum` | `matchEnum === 0` | `matchEnum === MATCH.nomatch` |

> **`!== 0` is the canonical default.** You **may** spell the named zero member
> (`matchEnum !== MATCH.nomatch`) for readability **when one exists** — it reads as intent and
> stays correct. A `≤ 32-bit`-based enum is the `number` domain, so the comparand is `0` /
> `MATCH.nomatch` (a `number`); a `long`/`ulong`-based enum (`02-types.md` §4.2, branded `bigint`)
> compares against `0n` instead — never mix the domains (§5).

**Real example** — `complex_t.opCast(T : bool)` returns the truthiness of two `real_t`
(`number`-domain) fields:

```d
// dmd/root/complex.d:97-100 — opCast to bool: numeric truthiness of two real_t fields
extern (D) bool opCast(T : bool)() const
{
    return re || im;
}
```
```ts
// re, im are real_t -> number (08 §15, §6); opCast(T:bool) -> opCastBool() (05-operators.md §10)
opCastBool(): boolean {
  return (this.re !== 0) || (this.im !== 0);
}
```

The `opCast(T : bool)` → `opCastBool()` rewrite (and the obligation to rewrite **every**
truthiness call site of such a type) is owned by `05-operators.md` §10; this section owns only
the **scalar** `!= 0` expansion. Referenced by `06-control-flow.md`.

---

## 10. `cast(void)`: value discard

`cast(void) expr;` evaluates `expr` for its **side effects** and discards the result. As an
expression, `cast(void) e` has type `void` (`undefined` in the port). It is D's idiom for
"call this, I don't want the result, and I don't want a nodiscard/unused-value warning."

> **Decisive rule:** drop the cast and keep the expression statement — `cast(void) e;` → `e;`.
> The discard is implicit in JS: an expression statement already evaluates for side effects and
> throws the value away. Do **not** invent a `void e` operator or assign to a throwaway.

**Real example** — `optional.d`'s unittest calls `.get()` purely for its throw-on-empty side
effect:

```d
// dmd/root/optional.d:28 — cast(void): call get() for its AssertError side effect, drop result
cast(void) opt.get();
```
```ts
opt.get();   // cast(void) erased — evaluated for its throw side effect, result discarded
```

> When `cast(void) e` appears as a sub-expression whose `void` *value* is used (rare — e.g. the
> branches of a ternary both `cast(void)`, or a `void`-returning comma context), the ported
> expression has type `undefined`. In statement position — which is the only form in the
> frontend's own source — the bare `e;` is the whole translation.

---

## 11. Quick reference

| Topic | Rule | Helper / form |
|---|---|---|
| Domain split | ≤32-bit → `number`; 64-bit (`long`/`ulong`) → `bigint`; CTFE carrier → `bigint` | §0, §1 |
| `size_t.max` sentinel | not-found marker → `SIZE_MAX = -1`; `==`/`!=` → `===`/`!==`; arithmetic guard → drop | §1.3 |
| Cast truncation | mask to width, then sign-extend if signed | `toIntN`/`toUintN`, `normalizeInteger` |
| 32-bit wrap | re-truncate after op (`number` does not wrap) | `\| 0`, `>>> 0`, `Math.imul` |
| 64-bit wrap | re-truncate after op (`bigint` does not wrap) | `BigInt.asIntN/asUintN(64, …)` |
| `& \| ^ ~` 32-bit | JS operators directly | `~0 >>> 0` for `~uint` |
| `& \| ^ ~ << >>` 64-bit | BigInt operators, then re-truncate | no `>>>` on bigint |
| `>>` | arithmetic (sign-replicating) | JS `>>` / BigInt `>>` |
| `>>>` | logical (zero-fill); 64-bit: `toUint64(x) >> n` | BigInt has no `>>>` |
| shift count ≥ width | const → compile error (never in frontend source); runtime → guaranteed `< width` by source | §4.3 |
| mixed number/bigint | type error — widen narrow operand with `BigInt(...)` at boundary | §5 |
| `int.min / -1` | hard compile error, not wrap | `dmd/constfold.d:323` |
| signed vs unsigned div/cmp | read carrier per operand signedness | §3.1 |
| `==` vs `UL` hex bit-pattern literal | read literal into signed domain — `n === toInt64(0x…n)` | §3.1 |
| `T.sizeof`/`T.alignof` | fold to fixed target width literal (`int`=4, `long`/`size_t`/ptr=8) | §1.4 |
| `float`/`double`/`real` | all `number`; CTFE keeps double precision | §6 |
| `Math.fround` | **never** in CTFE — DMD does not f32-round constants | §6.1 |
| NaN/Inf | `NaN`/`Infinity`; keep explicit NaN guard in `realCmp` | §6.2 |
| float suffix `f`/`L` | sets the AST `type`; value stays `number` (no round) | §6.3 |
| `char`/`wchar`/`dchar` arithmetic | promotes to `int` (`number`); store-back truncates | §7 |
| exactness decides compile | `bigint` mandatory (folding, CTFE, enum, sizes, hashes, mangling, `Cent`) | §8 |
| numeric truthiness | expand explicitly; `if (x)` → `x !== 0` (`0n` for bigint); never JS truthiness | §9 |
| enum-typed truthiness | same `!= 0` rule; `if (matchEnum)` → `matchEnum !== 0` (or `!== MATCH.nomatch`) | §9.1 |
| `cast(void) e;` | value discard — drop the cast, keep the statement `e;` | §10 |

> Repeat of the STOP rule: any numeric construct not covered here, or any case where you
> cannot decide `number` vs `bigint` from the result type, is a STOP — escalate
> (`11-escalate.md`). A wrong truncation in a compiler is silent and catastrophic.
