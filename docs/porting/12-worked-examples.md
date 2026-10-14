# 12 — Worked Examples (Golden References)

> **STOP rule:** these are pattern-match exemplars, not a license to improvise. If your
> file contains a construct that none of these examples (or the rule docs they cite)
> decisively covers, **STOP and escalate** (`11-escalate.md`). A wrong-but-plausible
> translation in a compiler is worse than a halt. Never guess.

Read `_ground-truth.md` first, then the rule docs (`00`–`11`). This document does **not
introduce new rules** — it applies the existing ones end-to-end on three real frontend
excerpts so you can see how the per-line lookups compose into a finished `.ts` file.
Every non-trivial choice is annotated with the **owning doc** (e.g. "copy() per
`03-value-semantics.md`"). When this doc and a rule doc appear to disagree, the rule doc
wins — tell the synthesis step.

**How these were chosen.** Each excerpt is a *focused, cohesive* slice (≈50–117 lines),
not a whole module — enough to exercise a cluster of rules without drowning in surface:

| # | Source (excerpt) | Rule clusters exercised |
|---|---|---|
| (a) | `dmd/root/optional.d` (full, 91 lines) | generic struct value type (`02`/`03`), `unittest`→Vitest (`10`), typed `catch`+`assert` (`06`/`10`), `extern(C++)` + attribute erasure (`04`) |
| (b) | `dmd/astenums.d` (excerpt: `MODFlags`, `STC`, `structalign_t`) | enum's two meanings & 64-bit base (`02 §4`), manifest/anon enum, `cast(ushort)` truncation (`09`), bit-flag boolean `!!(x & F)` (`09`/`02`), `private:`/`public:` blocks |
| (c) | `dmd/root/complex.d` (full, 117 lines) | operator overloading + monomorphization (`05`), `@disable this()` (`02`/`03`), `real_t`→`number` (`09`), default args (`04`) |

**Verification status.** All three TS translations were transpiled to JS (types erased)
and run under Node; their behavior matches the `ldc2 -run` probe outputs (default
`Optional` is empty, `cast(ushort)0x1_0008 == 8`, `STC.alias_ == 4294967296n`, complex
arithmetic, `re||im` truthiness). Facts below are stated plainly because they were
verified; nothing here is an unconfirmed guess.

---

## (a) `dmd/root/optional.d` — a generic value-struct utility

A self-contained root utility: a generic `struct Optional(T)` plus its in-source
`unittest`. It is the canonical small port: a value type, a faithful `Optional<T>` class
(NOT collapsed to `T | undefined`), and a unittest that becomes a Vitest test exercising
the assert/throw path.

### D source (`dmd/root/optional.d:11-90`)

```d
module dmd.root.optional;                                       // :11

nothrow:                                                        // :13  (attribute block — erases, 04)

///
unittest                                                        // :16
{
    import core.exception : AssertError;

    Optional!int opt;                                           // :20  default-init: empty
    assert( opt.isEmpty());
    assert(!opt.isPresent());
    assert(!opt.hasValue(1));
    assert(!opt.hasValue(2));

    bool caught;
    try
        cast(void) opt.get();                                   // :28  throws AssertError (empty)
    catch (AssertError)
        caught = true;
    assert(caught);

    opt = Optional!int(1);                                      // :33  assign a fresh rvalue
    assert(!opt.isEmpty());
    assert( opt.isPresent());
    assert( opt.get() == 1);
    assert( opt.hasValue(1));
    assert(!opt.hasValue(2));
}

/// Optional type that is either `empty` or contains a value of type `T`
extern (C++) struct Optional(T)                                 // :42
{
    private T value;                                            // :45
    private bool present;                                       // :48

  nothrow:                                                      // :50

    this(T value) { this.value = value; this.present = true; }  // :53
    static Optional!T create(T val) { return Optional!T(val); } // :61
    bool isPresent() const { return this.present; }             // :67
    bool isEmpty()   const { return !this.present; }            // :73
    inout(T) get() inout { assert(present); return value; }     // :79
    bool hasValue(const T exp) const { return present && value == exp; }  // :86
}
```

### TS translation (`src/dmd/root/optional.ts`)

```ts
// Ported from dmd/root/optional.d (module dmd.root.optional).
import { assert, AssertError } from "../../assert.js";   // 08-runtime-lib.md §12, 10-tests §2

// extern(C++) struct -> VALUE type backed by a TS class (02-types.md §2, §11).
// Kept as a faithful Optional<T> class — NOT collapsed to `T | undefined`: the frontend
// calls .isPresent()/.get()/.hasValue() explicitly, and Optional<bool> has THREE states
// (absent / true / false) a `boolean | undefined` would muddle (02-types.md §11).
export class Optional<T> {
  private value!: T;                 // uninitialized until present (matches D default-init)
  private present = false;           // D `bool present;` default-inits to false -> empty

  // D `this(T value)` (optional.d:53). The zero-arg default-construction `Optional!int opt;`
  // has no D ctor — it is the all-default value (present=false). We reproduce both with one
  // ctor using arguments.length (04-functions.md §1 Form A: arity dispatch).
  constructor(value?: T) {
    if (arguments.length) { this.value = value as T; this.present = true; }
  }

  // D static factory `create` (optional.d:61). Plain static method (04-functions.md §1).
  static create<T>(val: T): Optional<T> { return new Optional<T>(val); }

  // `const`/`inout` method qualifiers ERASE (04-functions.md §8).
  isPresent(): boolean { return this.present; }
  isEmpty(): boolean { return !this.present; }

  // D `assert(present)` -> runtime assert helper that THROWS AssertError (10-tests §2).
  // get() on an empty Optional must throw, never return undefined (02-types.md §11 invariant).
  get(): T { assert(this.present); return this.value; }

  // D `value == exp` on a generic T -> `===`. primitive-T only: Optional!T is instantiated
  // with bool/int in the frontend, so `===` is value equality (05-operators.md
  // "Operators on a generic type parameter"). Were T ever a struct with opEquals, this would
  // be a silent miscompile and must escalate (11-escalate.md).
  hasValue(exp: T): boolean { return this.present && this.value === exp; }

  // VALUE-struct copy contract (03-value-semantics.md "copy() of a generic field"): per-field
  // shallow copy. Optional is a plain struct (no postblit/opAssign/@disable) -> mechanical
  // field copy. primitive-T only: Optional!T instantiated with bool/int in the frontend, so
  // copying the `value` binding is correct. A value-struct T would need `value.copy()` and a
  // T: Copyable bound (03-value-semantics.md "copy() of a generic field").
  copy(): Optional<T> {
    const c = new Optional<T>();
    c.value = this.value;
    c.present = this.present;
    return c;
  }
}
```

### Vitest port of the `unittest` (`src/dmd/root/optional.test.ts`)

```ts
// Ported from dmd/root/optional.d unittest (optional.d:16). 10-tests-diagnostics.md §1.
import { describe, test, expect } from "vitest";
import { Optional } from "./optional.js";
import { AssertError } from "../../assert.js";

describe("optional", () => {
  test("Optional!int", () => {
    // `Optional!int opt;` (optional.d:20) -> default construction, NO copy (03 §1 non-copy).
    const opt0 = new Optional<number>();          // empty (present defaults to false)
    expect(opt0.isEmpty()).toBe(true);            // D `assert(opt.isEmpty())` -> expect (10 §1.4)
    expect(opt0.isPresent()).toBe(false);
    expect(opt0.hasValue(1)).toBe(false);
    expect(opt0.hasValue(2)).toBe(false);

    // typed `catch (AssertError)` -> single catch + instanceof + rethrow (06-control-flow.md §8.2).
    // `cast(void) opt.get();` -> the cast-to-void erases; we just call for its throw side effect.
    let caught = false;
    try {
      opt0.get();
    } catch (e) {
      if (!(e instanceof AssertError)) throw e;   // mandatory rethrow of non-matches (06 §8.2)
      caught = true;
    }
    expect(caught).toBe(true);

    // `opt = Optional!int(1);` (optional.d:33). RHS is a FRESH rvalue used once -> copy elided
    // (03-value-semantics.md §9: a fresh temporary cannot alias). Plain construction (03 §1 non-copy).
    const opt = new Optional<number>(1);          // copy elided: fresh rvalue, no aliasing possible
    expect(opt.isEmpty()).toBe(false);
    expect(opt.isPresent()).toBe(true);
    expect(opt.get()).toBe(1);
    expect(opt.hasValue(1)).toBe(true);
    expect(opt.hasValue(2)).toBe(false);
  });
});
```

### Why each non-trivial choice

- **`struct Optional(T)` → `class Optional<T>`, NOT `T | undefined`.** A D `struct` is a
  value type, represented as a TS class so it can carry a `copy()` method
  (`02-types.md §2`). `Optional` specifically must stay a class because the frontend calls
  `.isPresent()`/`.get()`/`.hasValue()` and `Optional!bool` is tri-state
  (`02-types.md §11`). Collapsing it would lose call-site fidelity.
- **Default-construction `Optional!int opt;` is the empty value.** Verified: a
  default-constructed `Optional` has `present == false` → `isEmpty()` true. The single
  `constructor(value?)` + `arguments.length` test reproduces both the D ctor and the D
  default-init in one body (`04-functions.md §1` arity dispatch).
- **`get()` throws on empty.** D `assert(present)` is a real runtime check; in the port it
  routes through the `assert` helper that throws `AssertError` (`10-tests §2`,
  `08-runtime-lib.md §12`). Returning `undefined` would be a silent miscompile of the
  `catch (AssertError)` unittest. The unittest *depends* on the throw.
- **`opt = Optional!int(1)` — copy elided.** This is an assignment of a *freshly
  constructed rvalue* used exactly once. Per `03-value-semantics.md §9`, the only licensed
  shortcut: a fresh temporary cannot alias, so no `.copy()` is needed — but the elision is
  **annotated** (audit trail). Had the RHS been an existing `Optional` variable, it would
  be `opt = src.copy()`.
- **`nothrow:` block, `const`/`inout` qualifiers → erased** (`04-functions.md §8`). Routine
  erasure carries no comment (the diff stays clean).
- **`unittest` → Vitest `describe`/`test`; `assert(x)` → `expect(...).toBe(...)`**
  (`10-tests §1.2`/`§1.4`). The typed `catch (AssertError)` becomes the single-`catch` +
  `instanceof` + mandatory rethrow form (`06-control-flow.md §8.2`).

---

## (b) `dmd/astenums.d` (excerpt) — enums (both meanings) + a value-struct

`astenums.d` is a Layer-0 pure leaf (no `dmd.*` imports — `translation-order.md §5`). This
excerpt shows the **two enum sizes** (`int` base → TS `enum`; `ulong` base → branded
`bigint` const object) and a small `extern(C++) struct` with private fields, a manifest
enum, an anonymous bit-flag enum, and a `cast(ushort)` truncation.

### D source (`dmd/astenums.d:38-49, 51-95, 475-499`)

```d
enum MODFlags : int                         // :38   <=32-bit base -> TS numeric enum (02 §4.2)
{
    none         = 0,
    const_       = 1,
    immutable_   = 4,
    shared_      = 2,
    wild         = 8,
    wildconst    = (MODFlags.wild | MODFlags.const_),   // :45  member expr -> fold at translate time
    mutable      = 0x10,
}

alias MOD = ubyte;                          // :49   type alias -> `type MOD = number;` (02 §5.1)

enum STC : ulong                            // :51   64-bit base -> branded bigint const obj (02 §4.2)
{
    none                = 0,
    static_             = 1,
    extern_             = 2,
    const_              = 4,
    final_              = 8,
    // ... (members elided) ...
    alias_              = 0x1_0000_0000,    // :95   EXCEEDS 2^32 -> bigint mandatory (09 §8)
    // ... (members continue) ...
}

extern (C++) struct structalign_t          // :475  VALUE struct -> class + copy() (02 §2, 03)
{
  private:                                  // :477
    ushort value = 0;                       // :478  default-init 0
    enum STRUCTALIGN_DEFAULT = 1234;        // :479  MANIFEST enum -> static const (02 §4.1)
    ubyte flags;                            // :480
    enum : ubyte                            // :481  ANONYMOUS enum of bit flags
    {
        PACK = 0x1,                         // :483
        ALIGNAS = 0x2,                      // :484
    }

  public:                                   // :487
  pure @safe @nogc nothrow:                 // :488  attribute block -> ERASE (04 §8)
    bool isDefault() const { return value == STRUCTALIGN_DEFAULT; }     // :489
    void setDefault()      { value = STRUCTALIGN_DEFAULT; }             // :490
    bool isUnknown() const { return value == 0; }                      // :491
    void setUnknown()      { value = 0; }                              // :492
    void set(uint value)   { this.value = cast(ushort)value; }         // :493  cast -> toUint16 (09 §2)
    uint get() const       { return value; }                           // :494
    bool isPack() const    { return !!(flags & PACK); }                // :495  bit-test bool (09 §4)
    void setPack()         { flags |= PACK; }                          // :496
    bool fromAlignas() const { return !!(flags & ALIGNAS); }           // :497
    void setAlignas()      { flags |= ALIGNAS; }                       // :498
}
```

### TS translation (`src/astenums.ts`)

```ts
// Ported from dmd/astenums.d (module dmd.astenums).
import { toUint16 } from "./root/numeric.js";   // mask-to-16-bit helper (09-numerics.md §2.1)

// MODFlags : int  ->  TS numeric enum (<=32-bit base, number domain). 02-types.md §4.2.
export enum MODFlags {
  none = 0,
  const_ = 1,
  immutable_ = 4,
  shared_ = 2,
  wild = 8,
  wildconst = 8 | 1,   // resolved: MODFlags.wild | MODFlags.const_ -> 9 (folded, 07-compile-time.md)
  mutable = 0x10,
}

// alias MOD = ubyte;  ->  type alias (02-types.md §5.1). ubyte is number domain (09-numerics.md §1).
export type MOD = number;

// STC : ulong  ->  const object + branded bigint type (02-types.md §4.2). A TS `enum` CANNOT
// hold bigint, and STC has members > 2^32 (alias_ = 0x1_0000_0000 = 4294967296n, verified),
// so the bigint domain is mandatory (09-numerics.md §8).
export type STC = bigint & { readonly __brand: "STC" };
export const STC = {
  none: 0n as STC,
  static_: 1n as STC,
  extern_: 2n as STC,
  const_: 4n as STC,
  final_: 8n as STC,
  // ... (members elided) ...
  alias_: 0x1_0000_0000n as STC,    // exceeds 2^32 -> bigint (09-numerics.md §8)
  // ... (members continue) ...
} as const;

// extern(C++) struct structalign_t  ->  VALUE-type class (02-types.md §2). Every assignment /
// by-value pass / return-by-value of a structalign_t MUST emit .copy() (03-value-semantics.md).
export class structalign_t {
  // `private:` block -> TS `private`. Fields keep their D names verbatim (01-conventions.md §2).
  private value = 0;                      // ushort, default-init 0 (matches D `= 0`)
  // manifest `enum STRUCTALIGN_DEFAULT = 1234;` -> static const (02-types.md §4.1).
  private static readonly STRUCTALIGN_DEFAULT = 1234;
  private flags = 0;                       // ubyte, default-init 0
  // anonymous `enum : ubyte { PACK, ALIGNAS }` -> static const members (02-types.md §4.1).
  private static readonly PACK = 0x1;
  private static readonly ALIGNAS = 0x2;

  // `pure @safe @nogc nothrow:` block + trailing `const` all ERASE (04-functions.md §8).
  isDefault(): boolean { return this.value === structalign_t.STRUCTALIGN_DEFAULT; }
  setDefault(): void { this.value = structalign_t.STRUCTALIGN_DEFAULT; }
  isUnknown(): boolean { return this.value === 0; }
  setUnknown(): void { this.value = 0; }

  // cast(ushort)value -> toUint16 (mask to low 16 bits). 09-numerics.md §2: NEVER inline
  // `& 0xffff` at the use site — call the helper (single source of truth, matches normalize).
  // Verified: set(0x1_0008) -> get() === 8 (low 16 bits of 65544), matching ldc2.
  set(value: number): void { this.value = toUint16(value); }

  get(): number { return this.value; }

  // `!!(flags & PACK)` -> boolean of a bit test. Operands are number-domain (ubyte), so JS
  // bitwise `&` is exact (09-numerics.md §4.1); `!== 0` reproduces the `!!` boolean coercion.
  isPack(): boolean { return (this.flags & structalign_t.PACK) !== 0; }
  setPack(): void { this.flags |= structalign_t.PACK; }
  fromAlignas(): boolean { return (this.flags & structalign_t.ALIGNAS) !== 0; }
  setAlignas(): void { this.flags |= structalign_t.ALIGNAS; }

  // VALUE-struct copy contract (03-value-semantics.md §2): per-field shallow copy of primitives.
  copy(): structalign_t {
    const c = new structalign_t();
    c.value = this.value;
    c.flags = this.flags;
    return c;
  }
}
```

### Why each non-trivial choice

- **`enum MODFlags : int` → TS numeric `enum`; `enum STC : ulong` → branded `bigint` const
  object.** The base type decides the numeric domain (`02-types.md §4.2`). A TS `enum`
  holds only `number`, so a 64-bit-based enum with members above 2^32 (`STC.alias_ ==
  4294967296n`, verified) **must** be the const-object-plus-branded-type form, with `bigint`
  values. Getting this wrong truncates flag bits silently (`09-numerics.md §8`).
- **`wildconst = (MODFlags.wild | MODFlags.const_)` folds at translation time** to `8 | 1`
  / `9`, with an audit comment (`07-compile-time.md`). The frontend's member-initializer
  expression is resolved by us, not emitted as a runtime computation.
- **`enum STRUCTALIGN_DEFAULT = 1234;` is a MANIFEST enum (no member list) → `static
  readonly` const**, not a TS `enum` (`02-types.md §4.1`). The discriminator is the `=`
  immediately after the name with no `{ … }`.
- **The anonymous `enum : ubyte { PACK, ALIGNAS }` → `static readonly` bit-flag
  constants.** They are named compile-time constants used in bit tests, so `number`-domain
  statics are the faithful form.
- **`cast(ushort)value` → `toUint16(value)`** (`09-numerics.md §2.1`). Verified: the cast
  is mask-to-16-bits (`set(0x1_0008)` stores `8`). The helper is called rather than inlined,
  matching `IntegerExp.normalize`'s single-truncation-gate discipline.
- **`!!(flags & PACK)` → `(this.flags & PACK) !== 0`.** The operands are `ubyte`
  (`number` domain), so JS `&` is exact (`09-numerics.md §4.1`); `!== 0` is the explicit,
  readable form of D's `!!` boolean coercion. (`!!(x)` and `x !== 0` are equivalent here;
  we pick the explicit comparison.)
- **`structalign_t` is a value struct → needs `copy()`** (`03-value-semantics.md §2`). It
  has no postblit/`opAssign`/`@disable`, so the copy is a mechanical per-field shallow copy
  of two primitives. Any `someField = anAlign;` store elsewhere in the frontend must become
  `someField = anAlign.copy();` (`03 §1 #5`).
- **`private:`/`public:` D access blocks → per-member TS `private`/(default public).**
  Field/method names are carried over verbatim (`01-conventions.md §2`); none collide with
  a JS reserved word here.

---

## (c) `dmd/root/complex.d` — operator overloading + value semantics

The whole module (117 lines). It is the cleanest live example of operator-overload
monomorphization (`05-operators.md`): a value `struct complex_t` with templated `opBinary`,
`opUnary`, `opBinaryRight`, `opCast(bool)`, and `opEquals`. Component arithmetic is
`real_t` = `number` on this target (`09-numerics.md §6`).

### D source (`dmd/root/complex.d:12-117`)

```d
module dmd.root.complex;                                        // :12
import dmd.root.ctfloat;                                        // :14  CTFloat + real_t (08 §15)
nothrow:                                                        // :16  attribute block -> erase

extern (C++) struct complex_t                                   // :18  VALUE struct
{
    real_t re;                                                  // :20  real_t == number (09 §6)
    real_t im;                                                  // :21
  nothrow:
    this() @disable;                                            // :25  NO default ctor (02/03 §6.2)
    this(real_t re) { this(re, CTFloat.zero); }                 // :27  default-im delegating ctor
    this(real_t re, real_t im) @safe { this.re = re; this.im = im; }   // :32

    extern (D) complex_t opBinary(string op)(complex_t y) if (op == "+")  // :38
    { return complex_t(re + y.re, im + y.im); }

    extern (D) complex_t opBinary(string op)(complex_t y) if (op == "-")  // :44
    { return complex_t(re - y.re, im - y.im); }

    extern (D) complex_t opUnary(string op)() if (op == "-")              // :50
    { return complex_t(-re, -im); }

    extern (D) complex_t opBinary(string op)(complex_t y) if (op == "*")  // :56
    { return complex_t(re * y.re - im * y.im, im * y.re + re * y.im); }

    extern (D) complex_t opBinaryRight(string op)(real_t x) if (op == "*")  // :62  real * complex
    { return complex_t(x) * this; }

    extern (D) complex_t opBinary(string op)(real_t y) if (op == "*")     // :68  complex * real
    { return this * complex_t(y); }

    extern (D) complex_t opBinary(string op)(real_t y) if (op == "/")     // :74  complex / real
    { return this / complex_t(y); }

    extern (D) complex_t opBinary(string op)(complex_t y) if (op == "/")  // :80  complex / complex
    {
        if (CTFloat.fabs(y.re) < CTFloat.fabs(y.im)) {
            const r = y.re / y.im; const den = y.im + r * y.re;
            return complex_t((re * r + im) / den, (im * r - re) / den);
        } else {
            const r = y.im / y.re; const den = y.re + r * y.im;
            return complex_t((re + r * im) / den, (im - r * re) / den);
        }
    }

    extern (D) bool opCast(T : bool)() const { return re || im; }         // :97  truthiness
    int opEquals(complex_t y) const @safe { return re == y.re && im == y.im; }  // :102
}

extern (C++) real_t creall(complex_t x) @safe { return x.re; }            // :108
extern (C++) real_t cimagl(complex_t x) @safe { return x.im; }            // :113
```

### TS translation (`src/dmd/root/complex.ts`)

```ts
// Ported from dmd/root/complex.d (module dmd.root.complex).
import { CTFloat, real_t } from "./ctfloat.js";   // real_t = number on this target (08 §15, 09 §6)

// extern(C++) struct complex_t  ->  VALUE-type class (02-types.md §2). Copy on every value-move
// (03-value-semantics.md). Component arithmetic is real_t = number (09-numerics.md §6: real is
// 64-bit double on this target, JS number is exact — no Math.fround, no extended precision).
export class complex_t {
  re: number;
  im: number;

  // D `this() @disable;` (complex.d:25) -> there is NO zero-arg construction. We model the two
  // real ctors (:27 default-im, :32 full) with ONE ctor + a default param (04-functions.md §2):
  //   complex_t(re)      -> im defaults to CTFloat.zero
  //   complex_t(re, im)  -> both set
  // The @disable means callers never write `new complex_t()` with no args (02/03 §6.2): a
  // missing `re` is a bug, not the all-zero value. (TS cannot truly forbid `new complex_t()`;
  // the contract is that the frontend never does so — see invariant note below.)
  constructor(re: number, im: number = CTFloat.zero) {
    this.re = re;
    this.im = im;
  }

  // Operator overloads -> named methods (05-operators.md §1). D templates on `string op`; we
  // MONOMORPHIZE: one method per concrete operator. opBinary!"+" -> opAdd, etc.
  // EVERY call site of `+`/`-`/`*`/`/`/`-`(unary)/`==`/`cast(bool)` on a complex_t MUST be
  // rewritten to these calls (05 §0): TS has no operator overloading.
  opAdd(y: complex_t): complex_t {                              // opBinary!"+"
    return new complex_t(this.re + y.re, this.im + y.im);
  }
  opSub(y: complex_t): complex_t {                              // opBinary!"-"
    return new complex_t(this.re - y.re, this.im - y.im);
  }
  opNeg(): complex_t {                                          // opUnary!"-"
    return new complex_t(-this.re, -this.im);
  }
  // `*` and `/` each have TWO overloads (self-type and real_t). Per 05-operators.md "Multiple
  // overloads of the same operator", the SELF-TYPE form keeps the canonical name (opMul/opDiv);
  // the real_t form is disambiguated by the operand type: opMul_real_t / opDiv_real_t.
  opMul(y: complex_t): complex_t {                             // opBinary!"*" (complex * complex)
    return new complex_t(this.re * y.re - this.im * y.im, this.im * y.re + this.re * y.im);
  }
  // opBinaryRight!"*"(real_t) (complex.d:62) -> the `_r` suffix; called on the RIGHT operand,
  // the left (real) operand is the argument (05-operators.md §4). `real * this` -> this.opMul_r(real).
  opMul_r(x: number): complex_t { return new complex_t(x).opMul(this); }
  // opBinary!"*"(real_t) (complex.d:68) / opBinary!"/"(real_t) (complex.d:74): the real_t
  // overload of `*`/`/` (05-operators.md "Multiple overloads of the same operator").
  opMul_real_t(y: number): complex_t { return this.opMul(new complex_t(y)); }
  opDiv_real_t(y: number): complex_t { return this.opDiv(new complex_t(y)); }
  opDiv(y: complex_t): complex_t {                            // opBinary!"/" (complex / complex)
    // CTFloat.fabs -> Math.abs; division is plain number division (09-numerics.md §6).
    if (CTFloat.fabs(y.re) < CTFloat.fabs(y.im)) {
      const r = y.re / y.im;
      const den = y.im + r * y.re;
      return new complex_t((this.re * r + this.im) / den, (this.im * r - this.re) / den);
    } else {
      const r = y.im / y.re;
      const den = y.re + r * y.im;
      return new complex_t((this.re + r * this.im) / den, (this.im - r * this.re) / den);
    }
  }

  // opCast(T : bool) -> opCastBool() (05-operators.md §10). EVERY truthiness use of a complex_t
  // (`if (z)`, `while (z)`, `z && ...`, `!z`, `cast(bool)z`) MUST be rewritten to .opCastBool():
  // a TS object is always truthy, so a bare `if (z)` is a silent miscompile.
  // D `return re || im;` is NUMERIC `||` (operands are real_t, not bool): each side is an
  // implicit `!= 0`, NOT a JS short-circuit on a number. Per 09-numerics.md "Numeric truthiness"
  // make the zero-test explicit: `(this.re !== 0) || (this.im !== 0)` (verified: 0+0i false,
  // 0+2i true).
  opCastBool(): boolean { return (this.re !== 0) || (this.im !== 0); }

  // D `int opEquals(complex_t y)` returns `int` (1/0); NORMALIZE to `boolean` per 05-operators.md
  // "opEquals returning int" (the D `&&` already yields a bool result here, so the body is a
  // straight `===` chain — no `? 1 : 0`). `==` on a complex_t is rewritten to a.opEquals(b),
  // `!=` to !a.opEquals(b) (05 §2): TS `===` on objects is reference identity, NOT value
  // equality. `y` is by value but only read, so the copy is elided (03 §9: read-only argument).
  opEquals(y: complex_t): boolean { return this.re === y.re && this.im === y.im; }

  // VALUE-struct copy contract (03-value-semantics.md §2): two primitive fields.
  copy(): complex_t { return new complex_t(this.re, this.im); }
}

// Free functions (UFCS-callable in D, e.g. `x.creall()`); a UFCS call site `x.creall()` becomes
// `creall(x)` (04-functions.md §6). `@safe`/`extern(C++)` erase (04 §8). `x` read-only -> no copy.
export function creall(x: complex_t): number { return x.re; }
export function cimagl(x: complex_t): number { return x.im; }
```

### Sample call-site rewrites (the half agents forget)

Per `05-operators.md §0`, emitting the method is only half the job — **every call site of
the operator must be rewritten**. `constfold.d` is the live consumer (`05-operators.md §9`).
Illustrative rewrites (the right-hand TS forms are mandatory):

| D call site | TS rewrite | Rule |
|---|---|---|
| `complex_t z = a + b;` | `const z = a.opAdd(b);` | `05 §4` |
| `complex_t z = a * b;` | `const z = a.opMul(b);` | `05 §4` |
| `complex_t z = scalar * cplx;` | `const z = cplx.opMul_r(scalar);` | `05 §4` (`opBinaryRight`, method on the RIGHT operand) |
| `complex_t z = cplx * scalar;` | `const z = cplx.opMul_real_t(scalar);` | `05` "Multiple overloads of the same operator" |
| `complex_t z = cplx / scalar;` | `const z = cplx.opDiv_real_t(scalar);` | `05` "Multiple overloads of the same operator" |
| `complex_t z = -a;` | `const z = a.opNeg();` | `05 §5` |
| `if (a == b)` | `if (a.opEquals(b))` | `05 §2` |
| `if (a != b)` | `if (!a.opEquals(b))` | `05 §2` |
| `if (cplx)` / `while (cplx)` | `if (cplx.opCastBool())` | `05 §10` (implicit bool context) |
| `bool t = cast(bool) cplx;` | `const t = cplx.opCastBool();` | `05 §10` |
| `auto r = x.creall();` (UFCS) | `const r = creall(x);` | `04 §6` |

### Why each non-trivial choice

- **`this() @disable;` → one ctor with a default param + a no-zero-arg-construction
  contract.** D forbids `complex_t()` (no default); the two real ctors (`this(re)` and
  `this(re, im)`) collapse to a single `constructor(re, im = CTFloat.zero)`
  (`04-functions.md §1` Form A / `§2` default args). The `@disable` means a value struct
  that is **never copied via a default-then-assign** and **never default-constructed**
  (`03-value-semantics.md §6.2`); the frontend always builds it with at least `re`.
  TS cannot enforce the disable, so the contract is documented, not coded.
- **Templated `opBinary(string op)` → one named method per concrete op
  (monomorphization).** `+`→`opAdd`, `-`→`opSub`, `*`→`opMul`, `/`→`opDiv`, unary `-`→
  `opNeg` (`05-operators.md §1`). D's `if (op == "+")` template constraints are resolved at
  translation time — there is exactly one method per operator, no runtime `op` string.
- **`*` and `/` each have TWO overloads — disambiguate by operand type.** `opBinary!"*"`
  exists for both `complex_t` (`:56`) and `real_t` (`:68`); `opBinary!"/"` exists for both
  `complex_t` (`:80`) and `real_t` (`:74`). Per `05-operators.md`
  "Multiple overloads of the same operator", the self-type form keeps the canonical name
  (`opMul`/`opDiv`) and the `real_t` form is suffixed with the operand type
  (`opMul_real_t`/`opDiv_real_t`). Two methods cannot share one TS name.
- **`opBinaryRight!"*"(real_t)` → `opMul_r`, called on the RIGHT operand.** For `scalar *
  cplx`, the left (`real`) has no matching `opBinary`, so D dispatches to the right
  operand's `opBinaryRight` (`05-operators.md §4`). The call-site rewrite puts the method on
  `cplx` and passes the scalar: `cplx.opMul_r(scalar)`. Mixing this up with `opMul` silently
  swaps operands.
- **`opCast(T : bool)` → `opCastBool()`, and EVERY truthiness context is rewritten.** A TS
  object is always truthy, so `if (cplx)` would always take the branch — a silent
  miscompile. `05-operators.md §10` mandates rewriting `cast(bool)`, `if`, `while`, `&&`,
  `!`. The body `return re || im;` is a NUMERIC `||` (operands are `real_t`, not bool): per
  `09-numerics.md` "Numeric truthiness" each side becomes an explicit `!= 0`, giving
  `(re !== 0) || (im !== 0)` (0+0i false, 0+2i true — verified).
- **`int opEquals` → `opEquals(): boolean`, and `==`/`!=` are rewritten.** D `==` on a
  struct calls `opEquals`; TS `===` on objects is *reference identity* (`05-operators.md
  §2`). The `int`→`boolean` return is the normalization mandated by `05-operators.md`
  "opEquals returning int" (here the body's `&&` already yields a bool, so no `? 1 : 0` is
  needed). `!=` becomes `!a.opEquals(b)`.
- **`real_t` arithmetic → plain `number`.** `real == double` on this target
  (`09-numerics.md §6`, `_probes.md §6`); JS `number` reproduces CTFE float folding exactly.
  No `Math.fround` (would diverge from DMD — `09-numerics.md §6.1`). `CTFloat.zero`→`0`,
  `CTFloat.fabs`→`Math.abs` (`08-runtime-lib.md §15`).
- **Free functions `creall`/`cimagl` are UFCS-callable** — a call `x.creall()` rewrites to
  `creall(x)` (`04-functions.md §6`); the receiver becomes the first argument.
- **Value semantics throughout.** `complex_t` is a value struct → `copy()`
  (`03-value-semantics.md §2`). By-value parameters that are only *read* (`opEquals`'s `y`,
  `creall`'s `x`) elide the copy with the §9 justification; an op that *returns* a fresh
  `new complex_t(...)` needs no copy (plain construction is a non-copy point, `03 §1`).

---

## (d) The `resolve`/`resolveHelper` out-triple — multi-`out` params threaded through two frames

`03-value-semantics.md` §3.3 gives the single-`out` box (`Ref<T>`). The type-resolution engine
(typesem.d) raises the stakes: **three** `out` params threaded through **two frames**, written
through **two different mechanisms**. Every future type-resolution rung (TypeInstance, Typeof,
Mixin) reuses exactly this shape — port it from this reference, not from scratch. (Ported live
in Rung 4b: `src/dmd/typesem.ts` `resolve`/`resolveHelper`.)

### D shape (`dmd/typesem.d:4222` calling `:156`)

```d
void resolve(Type mt, Loc loc, Scope* sc, out Expression pe, out Type pt, out Dsymbol ps,
             bool intypeid = false)
{
    void returnExp(Expression e)  { pe = e; pt = null; ps = null; }   // closure setters
    void returnType(Type t)       { pe = null; pt = t; ps = null; }   // (typesem.d:4224-4243)
    void returnSymbol(Dsymbol s)  { pe = null; pt = null; ps = s; }
    ...
    mt.resolveHelper(loc, sc, s, scopesym, pe, pt, ps, intypeid);     // SAME outs, next frame
}
private void resolveHelper(TypeQualified mt, ..., out Expression pe, out Type pt,
                           out Dsymbol ps, bool intypeid = false)
{
    ...
    pt = t.merge();   // RAW writes, no setters (typesem.d:195/267/339/343/367-371/379/384/386)
    ps = s; return;   // the symbol fallback
}
```

### TS translation (`src/dmd/typesem.ts`)

```ts
interface Ref<T> { value: T; }      // the §3.3 box, one per out slot

export function resolve(mt: Type, loc: Loc, sc: Scope, pe: Ref<Expression | null>,
    pt: Ref<Type | null>, ps: Ref<Dsymbol | null>, intypeid = false): void {
    pe.value = null; pt.value = null; ps.value = null;   // D `out` default-init, THIS frame
    function returnType(t: Type): void { pe.value = null; pt.value = t; ps.value = null; }
    // ... returnExp/returnSymbol/returnError likewise (typesem.d:4224-4248)
    resolveHelper(mt, loc, sc, s, scopesym.value, pe, pt, ps, intypeid);  // same boxes onward
}

function resolveHelper(/* ... */, pe: Ref<Expression | null>, pt: Ref<Type | null>,
    ps: Ref<Dsymbol | null>, intypeid = false): void {
    pe.value = null; pt.value = null; ps.value = null;   // callee RE-resets the SAME boxes
    // ...
    pt.value = t.merge();                                 // raw slot writes, as in D
}
```

### The two rules a port derives wrong without this example

1. **The callee re-resets the same boxes the caller already reset.** D `out` default-init
   happens **per frame** — `resolveHelper`'s `out` params null all three again on entry even
   though `resolve` just did. Skipping the inner reset looks harmless today and silently
   diverges the day a dispatch arm writes a slot before delegating.
2. **Closure setters and raw slot writes coexist on the same boxes.** `resolve` writes through
   `returnType`/`returnExp`/`returnSymbol`; `resolveHelper` writes the slots **directly**. A
   port that models only the setters misses every raw write (typesem.d:195/267/339/343/
   367-371/379/384/386) — that is most of the live ones.

Also: keep dead `out`-adjacent params **dead** — `resolveHelper`'s `scopesym` is only read in a
`version(none)` printf; keep it in the signature (1:1), do not invent uses. The not-yet-called
setters need the `void fn;` `noUnusedLocals` idiom (`04-functions.md` §5).

---

## Cross-references this doc relies on (do not duplicate them — go to the owner)

- Module/file mapping, identifier preservation, `nothrow:` blocks, imports → `01-conventions.md`.
- `struct`→class, `enum` (manifest vs named, `int` vs `ulong` base), type aliases,
  `Optional<T>` → `02-types.md`.
- `.copy()` discipline, copy points, rvalue-elision (`§9`), `@disable this(this)` → `03-value-semantics.md`.
- Constructor arity dispatch, default args, attribute erasure, UFCS → `04-functions.md`.
- Operator monomorphization, call-site rewrites (`opAdd`/`opCastBool`/`opEquals`/…) → `05-operators.md`.
- `try`/`catch`+`instanceof`+rethrow → `06-control-flow.md`.
- Member-expression folding (`wild | const_`), manifest-enum resolution → `07-compile-time.md`.
- `CTFloat`, `assert`/`AssertError`, `toUint16`/numeric helpers as a *module* → `08-runtime-lib.md`.
- `cast(ushort)` truncation, `real_t`→`number`, `bigint` for 64-bit enums → `09-numerics.md`.
- `unittest`→Vitest, `assert`→`expect`, diagnostic parity → `10-tests-diagnostics.md`.
- Any construct not decisively covered here or in the owners above → **STOP**, `11-escalate.md`.
