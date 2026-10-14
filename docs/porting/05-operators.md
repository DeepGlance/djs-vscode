# 05 — Operator Overloading (`opXxx`)

> **STOP rule.** If you meet an `opXxx` form not listed here, an operator applied to a
> type whose overload you cannot locate, or any ambiguity about *which* overload a call
> site resolves to — **stop and escalate** (`11-escalate.md`). Never guess. A
> wrong-but-plausible operator rewrite silently corrupts compiler output.

Read `_ground-truth.md` first. Frontend inventory: **480 `opXxx` sites** (ground-truth §4).

---

## 0. THE CRITICAL RULE (read this first, it governs everything below)

**TypeScript has NO operator overloading.** There is no `Symbol.operator`, no
`valueOf`-based `<`/`+` you can trust for our value types. Therefore every operator
overload is a **two-part** translation, and BOTH parts are mandatory:

1. **(a) Emit the method.** Translate the `opXxx` body to a normal TS method with the
   canonical name from the table in §1.
2. **(b) Rewrite EVERY call site.** Every place in the frontend that applies that
   operator (`+`, `==`, `<`, `[i]`, `foreach`, `cast`, `()`, …) to a value of that type
   MUST be rewritten into the explicit method call. The operator does not work in TS.

If you do (a) and forget (b), the TS does not compile (for `[]`, `()`, `cast`) **or — far
worse — silently does the wrong thing** (`==` on objects is reference identity in JS;
`<` coerces via `valueOf`/`toString` and gives garbage; `+` concatenates or `NaN`s).
**A missed call site is a silent miscompile.** This is the dominant failure mode of this
whole doc — treat it as such.

### The rewrite is RECURSIVE — it applies EVERYWHERE, including inside operator bodies

The call-site rewrite is not a surface pass over "user" code only. It applies
**recursively and everywhere** a value of an overloaded type meets one of its operators —
**including inside the operator-overload method bodies themselves.** An operator used in an
`opBinary`/`opUnary`/`opEquals`/… body is itself a call site and must be rewritten to the
canonical method call; do not leave a literal operator in a translated body because "it's
already inside the overload". A `*` inside an `opBinary` body is just another `*` on the
overloaded type — rewrite it.

```d
// BEFORE — dmd/root/complex.d:62 (opBinaryRight!"*" body: a "*" between two complex_t values)
complex_t opBinaryRight(string op)(real_t x) if (op == "*") { return complex_t(x) * this; }
```

```ts
// AFTER — the inner "*" is itself an operator on complex_t → rewrite it to .opMul(...)
opMul_r(x: number): complex_t { return new complex_t(x).opMul(this); }
```

### How to find every call site (do this for each overloaded type)

The overload lives on a type `T`. After you know `T` overloads operator `OP`:

1. **grep the operator against variables of type `T`.** Example for `Visibility ==`:
   `rg '\.visibility\s*(==|!=|<|>|<=|>=)'`, and `rg ': *Visibility' ` / `rg 'Visibility '`
   to find every variable/field/param of that type, then check each use.
2. **Operators on a struct are the signal.** In the frontend, `==`/`<`/`+`/`[]`/etc.
   applied to a *struct* value (not a primitive) is ALWAYS an overload — D primitives
   (`int`, `size_t`, `bool`, enums, slices) use built-in operators; structs/classes do
   not unless the overload exists. If you see `someStruct < other`, an `opCmp` is being
   called. Find it and rewrite.
3. **When unsure whether a `==`/`<` is built-in or overloaded:** check the static type
   of the operands. Primitive/enum/slice → built-in (translate per `09-numerics.md` /
   normal JS). Struct/class → overload → rewrite. If you cannot determine the type,
   **STOP** (`11-escalate.md`).

### The frontend's overloaded types (the ones you will actually hit)

Verified by grep across `dmd/*.d`. This is the working set — when you touch these types,
the operators below are method calls:

| Type | File | Overloads it defines |
|---|---|---|
| `SignExtendedNumber` | `dmd/intrange.d:56,61,78-288` | `opEquals` `opCmp` `opUnary(++ ~ -)` `opBinary(& \| ^ + - * / % << >> ^^)` |
| `IntRange` | `dmd/intrange.d:482-735` | `opUnary(~ -)` `opBinary(& \| ^ + - * / % << >> >>> ^^)` |
| `Visibility` | `dmd/dsymbol.d:152,168` | `opCmp` `opEquals` |
| `Loc` | `dmd/location.d:166,172` | `opEquals` `toHash` |
| `SourceLoc` | `dmd/location.d:281` | `opEquals` |
| `Parameter` | `dmd/mtype.d:3954` | `opEquals` |
| `ParameterList` | `dmd/mtype.d:3552,3560,3578` | `opIndex` `opApply` `opEquals` |
| `PtrVarState` | `dmd/ob.d:283` | `opEquals` |
| `complex_t` | `dmd/root/complex.d:38-102` | `opBinary` `opBinaryRight` `opUnary` `opEquals` `opCast(bool)` |
| `Array!T` | `dmd/root/array.d:300,348,353` | `opIndex` `opSlice` (`opCmp` used via element, see §8) |
| `BitArray` | `dmd/root/bitarray.d:54,62,73` | `opIndex` `opIndexAssign` `opEquals` |
| `StringTable!T` | `dmd/root/stringtable.d:227` | `opApply` |
| `OutBuffer` | `dmd/common/outbuffer.d:685,690,695` | `opSlice` `opIndex` |
| `TemplateInstanceBox` | `dmd/templatesem.d:198,192` | `opEquals` `toHash` |
| `FileName` (`Optional`-like) | `dmd/root/filename.d:1122` | `opCast` |
| `longdouble_soft` | `dmd/root/longdouble.d:135-170` | full set — **but x87 soft-float path is OFF** (`_config.md`); see §9 note |

> `longdouble.d`'s soft-float `longdouble_soft` overloads live inside the
> `CRuntime_Microsoft` section which `_config.md` resolves **OFF** (target `real` is
> 64-bit). Do **not** port `longdouble_soft`'s operators — that whole type is dead for
> our target. If a live module references it, STOP.

---

## 1. The canonical method-name table (use these names, no exceptions)

D's operator overloads are templated on a `string op` parameter. We **monomorphize** at
translation time: one named TS method per concrete operator. Use exactly these names so
parallel agents stay consistent.

| D operator(s) | D overload | Canonical TS method | Call-site rewrite of `a OP b` |
|---|---|---|---|
| `==` `!=` | `opEquals` | `opEquals(o)` | `a.opEquals(b)` / `!a.opEquals(b)` |
| `<` `<=` `>` `>=` | `opCmp` | `opCmp(o): number` | `a.opCmp(b) < 0` (etc., see §3) |
| `a = b` (assign) | `opAssign` | `opAssign(b)` | `a.opAssign(b)` (NOT `opOpAssign`; see below) |
| `+ - * / % ~ & \| ^ << >> >>> ^^` | `opBinary!"op"` | `opAdd` `opSub` `opMul` `opDiv` `opMod` `opCat` `opAnd` `opOr` `opXor` `opShl` `opShr` `opUShr` `opPow` | `a.opAdd(b)`, … |
| same, reversed | `opBinaryRight!"op"` | `opAdd_r` `opSub_r` … (suffix `_r`) | see §4 |
| `- + ~ ++ --` (prefix) | `opUnary!"op"` | `opNeg` `opPlus` `opCom` `opInc` `opDec` | `a.opNeg()`, … (see §5) |
| `+= -= *= …` | `opOpAssign!"op"` | `opAddAssign` `opSubAssign` … `opCatAssign` | `a.opAddAssign(b)` (see §6) |
| `a[i]` (read) | `opIndex` | `opIndex(i)` | `a.opIndex(i)` |
| `a[i] = v` | `opIndexAssign` | `opIndexAssign(v, i)` | `a.opIndexAssign(v, i)` |
| `a[i] += v` | `opIndexOpAssign!"op"` | `opIndexAddAssign(v, i)` … | `a.opIndexAddAssign(v, i)` |
| `a[lo..hi]` | `opSlice` | `opSlice(lo, hi)` / `opSliceAll()` | see §7 |
| `$` inside `a[…]` | `opDollar` | `opDollar()` | substitute `a.opDollar()` for `$` |
| `a(args)` | `opCall` | `opCall(args)` | `a.opCall(args)` |
| `cast(T)a` | `opCast!T` | `opCastBool()` (per target T) | `a.opCastBool()` (see §10) |
| `foreach (…; a)` | `opApply` | `opApply(dg)` | desugar — **see §11 (the hard one)** |
| `foreach_reverse` | `opApplyReverse` | `opApplyReverse(dg)` | §11 |
| `a.b` (no member `b`) | `opDispatch!"b"` | n/a — resolve at translation | §12 |
| AA-key hashing | `toHash` | `toHash(): number` | §13 |
| string conversion | `toString` | `toString()` / sink form | §14 |

**Naming detail for `opBinary` string-op map** (memorize):
`"+"→opAdd "-"→opSub "*"→opMul "/"→opDiv "%"→opMod "~"→opCat "&"→opAnd "|"→opOr`
`"^"→opXor "<<"→opShl ">>"→opShr ">>>"→opUShr "^^"→opPow`. Reversed forms add `_r`.
Compound-assign forms add `Assign`: `opAddAssign`, `opCatAssign`, etc.

**`opAssign` is plain assignment, NOT compound-assign.** `opAssign` overloads the bare `a = b`
when the type customizes copy/assignment (Source: `dmd/root/bitarray.d:46` —
`void opAssign(const ref BitArray)`). It is **distinct from `opOpAssign`** (§6), which overloads
the *compound* forms `+=`/`~=`/etc. Rewrite the call site `a = b` to `a.opAssign(b)` only when
the static type of `a` actually defines `opAssign`; an ordinary assignment to a type with no
`opAssign` stays a plain `=`. (Referenced by `03-value-semantics.md` and `cheatsheet.md`.)

---

## 1b. Operators on a generic type parameter

**Invariant:** when a *generic* body applies a comparison (`==` `!=` `<` `<=` `>` `>=`) or an
arithmetic operator to a value whose type is a **type parameter `T`**, `T`'s kind is unknown in
TS. D resolves the operator at instantiation against the concrete `T` (built-in for primitives,
the overload for structs). TS erases the parameter, so you cannot keep the operator literal and
hope it works for every `T`. **Resolve by inspecting the actual frontend instantiations** —
this section owns that resolution. Referenced by `02-types.md` and `12-worked-examples.md`.

**Why a bare `===` is dangerous here:** in JS, `===` on objects is **reference identity**. If `T`
is ever a struct (a value-type class in the port), `a === b` tests "same instance", but D `==`
on a struct is **field-wise value equality**. The two disagree silently — the TS compiles and
runs, producing wrong answers. The same trap applies to `<`/`+` (`valueOf`/`toString` coercion).
**Never emit a bare `===`/`<`/`+` on a type-parameter value without verifying case (a) below.**

**Resolution (grep the frontend's instantiations of the generic, then pick a case):**

- **(a) EVERY instantiation uses a PRIMITIVE `T`** (`int`, `size_t`, `bool`, `char`, an enum, a
  slice — verify by grepping every instantiation site, e.g. `rg 'StructName!\('`): translate the
  operator **directly** (`===` / `!==` / `<` / `<=` / `>` / `>=`, or the arithmetic operator),
  and leave a comment recording the evidence:
  `// primitive-T only: instantiated with <int, size_t>` (list the concrete types you found).
- **(b) ANY instantiation uses a struct/class `T`:** route through that type's translated method
  (`a.opEquals(b)`, `a.opCmp(b) < 0`, `a.opAdd(b)`, …). The generic does not know the method
  exists, so either pass a **comparator** (`cmp: (x: T, y: T) => number`) into the generic, or
  require `T` to expose the method via a TS interface bound (`T extends { opCmp(o: T): number }`).
  Pick the comparator form when the generic is used with mixed `T`; the interface bound when all
  struct instantiations share the method shape.
- **(c) unclear or MIXED (some primitive, some struct):** **STOP and escalate**
  (`11-escalate.md`). Do not guess a comparator or a bare operator — a mixed set means the single
  monomorphization is wrong for one of the cases.

```d
// BEFORE — generic body comparing two T values (T is a type parameter)
bool firstEquals(T)(T[] xs, T probe) {
    return xs.length && xs[0] == probe;     // == resolves per concrete T at instantiation
}
```

```ts
// AFTER (a) — verified: only ever T = int / size_t (primitive). Direct operator.
function firstEquals(xs: number[], probe: number): boolean {  // primitive-T only: int, size_t
    return xs.length > 0 && xs[0] === probe;
}

// AFTER (b) — some instantiation uses a struct T. Route through opEquals (pass/require it).
function firstEquals<T>(xs: T[], probe: T, eq: (a: T, b: T) => boolean): boolean {
    return xs.length > 0 && eq(xs[0], probe);   // caller passes the struct's .opEquals
}
```

---

## 2. `opEquals` — `==` and `!=`

**Invariant:** in D, `==` on a struct/class with `opEquals` calls it; in TS, `==`/`===`
on objects is **reference identity**. You MUST rewrite or the comparison silently tests
"same object" instead of "equal value". `!=` rewrites to the negation.

Source: `dmd/dsymbol.d:168` (`Visibility.opEquals`), call site `dmd/templatesem.d:5359`
(`fd.visibility == m.lastf.visibility`).

```d
// BEFORE — dmd/dsymbol.d:168
bool opEquals(ref const Visibility other) const @safe {
    if (this.kind == other.kind) {
        if (this.kind == Visibility.Kind.package_)
            return this.pkg == other.pkg;     // pkg is a ref → another opEquals/identity
        return true;
    }
    return false;
}
// call site — dmd/templatesem.d:5359
if (fd.visibility == m.lastf.visibility && ...)
```

```ts
// AFTER — method
opEquals(other: Visibility): boolean {
    if (this.kind === other.kind) {
        if (this.kind === Visibility.Kind.package_)
            return this.pkg === other.pkg;    // pkg is a Dsymbol ref → identity is correct here
        return true;
    }
    return false;
}
// call site
if (fd.visibility.opEquals(m.lastf.visibility) && ...)
```

**Null handling.** D `opEquals` is a member call: `a == b` where `a` could be `null`
(class ref) is a different idiom — for **classes**, `a == b` lowers to a runtime
`object.opEquals(a, b)` that null-checks both (`dmd/opover.d:710`). For our port:

- **struct `opEquals`** (the common case, value type, never null): plain
  `a.opEquals(b)`.
- **CLASS with a declared member `opEquals`** — VERIFIED by ldc2 probe: `a == b` on such a
  class calls the MEMBER opEquals, NOT reference identity (`Parameter`, mtype.d overloaded
  list). The cheatsheet's "class identity stays `===`" holds ONLY for classes with no
  declared opEquals. Check the class before translating any `==` on it.
- **class `opEquals`** (rare): rewrite to a free helper `objectEquals(a, b)` that does
  `a === b || (a !== null && b !== null && a.opEquals(b))`. Most frontend `==` on class
  refs is plain **identity** (`if (sym == null)`, `if (e1 == e2)`) and stays `===`/`!==`
  — only rewrite to `.opEquals` when the static type actually defines `opEquals` AND the
  comparison is value-equality. **If unsure whether a class `==` is identity or
  value-equality, STOP** (`11-escalate.md`).

---

## 3. `opCmp` — `<`, `<=`, `>`, `>=` (and `==` fallback)

**Invariant:** `opCmp` returns a `number`: `<0`, `0`, `>0`. The relational operator
becomes a comparison of the `opCmp` result against `0`. TS `<`/`>` on objects coerces via
`valueOf`/`toString` → garbage; you MUST rewrite.

**VERIFIED interplay (probed with `ldc2`):**
- A type with **only `opCmp`** (no `opEquals`): `==` compiles but is member-wise equality, and
  `opCmp` is not called (probe: `P(3,5) == P(3,7)` is false while `opCmp` returns 0). Translate it as
  a field-wise comparison, never `a.opCmp(b) === 0`.
- A type with **only `opEquals`** (no `opCmp`): `<`/`>` do **NOT** compile. (Probe:
  `OnlyEq` — `<` failed to compile.)

**Rule:** translate the full relational set from `opCmp`. If the type has `opEquals`,
`==` uses it (§2); if it has only `opCmp`, `==` → `a.opCmp(b) === 0`.

Source: `dmd/dsymbol.d:152` (`Visibility.opCmp`), `dmd/intrange.d:61`
(`SignExtendedNumber.opCmp`).

```d
// BEFORE — dmd/dsymbol.d:152 (+ unittest call sites :160)
int opCmp(const Visibility other) const { return this.kind - other.kind; }
// call sites:
Visibility.public_ > Visibility.private_       // dmd/dsymbol.d:160
a.visibility >= b.visibility
```

```ts
// AFTER — method (return type number, NOT bigint: a small enum diff, number domain)
opCmp(other: Visibility): number { return this.kind - other.kind; }
// call sites — rewrite the relational operator into an opCmp comparison:
pub.opCmp(priv) > 0
a.visibility.opCmp(b.visibility) >= 0
```

**The exact rewrite map (memorize):**

| D | TS |
|---|---|
| `a < b` | `a.opCmp(b) < 0` |
| `a <= b` | `a.opCmp(b) <= 0` |
| `a > b` | `a.opCmp(b) > 0` |
| `a >= b` | `a.opCmp(b) >= 0` |
| `a == b` (no `opEquals`) | `a.opCmp(b) === 0` |
| `a != b` (no `opEquals`) | `a.opCmp(b) !== 0` |

> Numeric domain of the `opCmp` return: `number` (it is a sign/difference, always small).
> The values *inside* `opCmp` may be `long`/BigInt (`SignExtendedNumber` compares
> `ulong` values) — follow `09-numerics.md` for the body; the **return** is `number`.

---

## 4. `opBinary` / `opBinaryRight` — `+ - * / % ~ & | ^ << >> >>> ^^`

**Invariant:** binary operator on a struct → method returning a new value. The arithmetic
*inside* follows `09-numerics.md` (BigInt vs number, wrap, truncate). The **rewrite** is
purely structural: replace the infix operator with the named method.

Source: `dmd/intrange.d:106-288` (`SignExtendedNumber.opBinary` for every op),
`dmd/intrange.d:494-735` (`IntRange.opBinary`), `dmd/root/complex.d:38-80`.

```d
// BEFORE — dmd/intrange.d:106 / :121
SignExtendedNumber opBinary(string op : "&")(SignExtendedNumber rhs) const {
    return SignExtendedNumber(value & rhs.value);
}
SignExtendedNumber opBinary(string op : "+")(SignExtendedNumber rhs) {
    uinteger_t sum = value + rhs.value;
    const carry = sum < value && sum < rhs.value;
    ...
}
// a call site (intrange does arithmetic on these):
auto r = a & b;     // → opBinary!"&"
auto s = a + b;     // → opBinary!"+"
```

```ts
// AFTER — one method per concrete op (monomorphized; value is bigint per 09-numerics)
opAnd(rhs: SignExtendedNumber): SignExtendedNumber {
    return new SignExtendedNumber(this.value & rhs.value);   // bigint &
}
opAdd(rhs: SignExtendedNumber): SignExtendedNumber {
    const sum = BigInt.asUintN(64, this.value + rhs.value);  // wrap per 09-numerics
    const carry = sum < this.value && sum < rhs.value;
    ...
}
// call sites:
const r = a.opAnd(b);
const s = a.opAdd(b);
```

**`opBinaryRight`** is the *reversed* form: D calls `b.opBinaryRight!"op"(a)` for `a op b`
when `a`'s type has no matching `opBinary` but `b`'s type has `opBinaryRight`. Source:
`dmd/root/complex.d:62` (`complex_t opBinaryRight(string op)(real_t x)` — handles
`real + complex`). Use the `_r` suffix and call it on the **right** operand:

```d
// BEFORE — dmd/root/complex.d:62 : enables  real_x + complex_y
complex_t opBinaryRight(string op)(real_t x) { ... }
// call site:  scalar (real) on the left, complex on the right
auto z = scalar + cplx;   // → cplx.opBinaryRight!"+"(scalar)
```

```ts
// AFTER
opAdd_r(x: number): complex_t { ... }      // reversed-add method on complex_t
// call site — note: method is on the RIGHT operand, the left operand is the argument
const z = cplx.opAdd_r(scalar);
```

> To pick `opBinary` vs `opBinaryRight` at a call site: if the **left** operand's type
> defines the matching `opBinary`, use that (`left.opAdd(right)`). Otherwise the **right**
> operand's `opBinaryRight` applies (`right.opAdd_r(left)`). The frontend's reversed uses
> are concentrated in `complex_t`. If a call site is ambiguous, **STOP**.

**`~` is concatenation, not bitwise** (it's `opCat`/`opAdd`-family naming `opCat`).
Verified: `Buf opBinary(string op:"~")` produced `[1,2]~[3,4] → [1,2,3,4]`. Keep `opCat`
distinct from `opXor` (`^`) and `opCom` (unary `~`, §5).

---

## 5. `opUnary` — prefix `- + ~ ++ --`

**Invariant:** unary operator on a struct → no-arg method. `++`/`--` mutate-and-return.
Map by op string. (`opUnary` in D covers only prefix `++`/`--`; postfix `a++` is a
separate, rarely-overloaded `opUnaryPostfix`/auto-lowering — not present in the frontend,
STOP if you see one.)

Source: `dmd/intrange.d:78,90,98` (`SignExtendedNumber.opUnary` for `++`, `~`, `-`),
`dmd/intrange.d:482,487` (`IntRange.opUnary` for `~`, `-`).

```d
// BEFORE — dmd/intrange.d:78 / :90 / :98
SignExtendedNumber opUnary(string op : "++")() {        // pre-increment, mutates
    if (value != ulong.max) ++value;
    else if (negative) { value = 0; negative = false; }
    return this;
}
SignExtendedNumber opUnary(string op : "~")() const { ... }   // bitwise complement
SignExtendedNumber opUnary(string op : "-")() const { ... }   // negate
// call sites:
++n;            // opUnary!"++"
auto m = ~x;    // opUnary!"~"
auto p = -y;    // opUnary!"-"   (used in dmd/intrange.d:139: this + (-rhs))
```

```ts
// AFTER
opInc(): SignExtendedNumber {                           // mutates this, returns a copy
    if (this.value !== 0xFFFFFFFFFFFFFFFFn) this.value += 1n;
    else if (this.negative) { this.value = 0n; this.negative = false; }
    return this.copy();                                 // D returns by value (03 §1 #3)
}
opCom(): SignExtendedNumber { ... }     // ~  (bitwise complement)
opNeg(): SignExtendedNumber { ... }     // -  (negation)
// call sites:
n.opInc();                  // ++n
const m = x.opCom();        // ~x
const p = y.opNeg();        // -y   (e.g. dmd/intrange.d:139 → this.opAdd(rhs.opNeg()))
```

**Op-string → method map:** `"-"→opNeg "+"→opPlus "~"→opCom "++"→opInc "--"→opDec`.

> `++`/`--` on a **value struct** in TS: since the struct is a class instance (reference),
> `opInc()` mutating `this` matches D's mutating pre-increment. D's `opUnary!"++"` returns
> by value, so the result is `this.copy()`, never `this`: a caller that keeps the result
> must not alias the incremented variable (`03-value-semantics.md` §1 #3).

---

## 6. `opOpAssign` — `+= -= *= … ~=`

**Invariant:** compound-assign overload mutates `this` (typically `ref`-returns it). Map
the op string with an `Assign` suffix. Verified: `a ~= 99` via
`ref Buf opOpAssign(string op:"~")(int)` appended in place.

Source: `dmd/root/longdouble.d:164` (the only frontend `opOpAssign` def, and it is in the
**OFF** soft-float path — see §0/§9). For the canonical pattern (no live frontend def),
use the probed shape:

```d
// PATTERN (probed) — append-assign
ref Buf opOpAssign(string op : "~")(int v) { xs ~= v; return this; }
// call site:
buf ~= 99;          // opOpAssign!"~"
total += delta;     // opOpAssign!"+"   (when total is an overloaded struct)
```

```ts
// AFTER
opCatAssign(v: number): Buf { this.xs.push(v); return this; }   // ~=
opAddAssign(delta: T): this  { ...; return this; }              // +=
// call sites:
buf.opCatAssign(99);     // buf ~= 99
total.opAddAssign(delta);// total += delta
```

> Distinguish `~` (concat, `opCat`/`opCatAssign`) from arithmetic. The compound-assign
> name is the binary name + `Assign`: `opAddAssign`, `opSubAssign`, `opMulAssign`,
> `opCatAssign`, `opAndAssign`, `opOrAssign`, `opXorAssign`, `opShlAssign`,
> `opShrAssign`, `opUShrAssign`, `opPowAssign`.

---

## 7. `opIndex`, `opIndexAssign`, `opIndexOpAssign`, `opSlice`, `opDollar`

**Invariant:** `[]` on a struct → method. TS `[]` only works on arrays/objects with string
keys — applying `a[i]` to a class instance does NOT call any method, so you MUST rewrite.
Verified shapes (all probed): read `a[i]`, write `a[i]=v`, `a[$-1]`, `a[lo..hi]`.

Source: `dmd/root/array.d:300` (`Array!T.opIndex`), `:348,:353` (`opSlice`),
`dmd/root/bitarray.d:54,62` (`opIndex`/`opIndexAssign`), `dmd/common/outbuffer.d:685-695`,
`dmd/mtype.d:3552` (`ParameterList.opIndex`).

```d
// BEFORE — dmd/root/array.d:300 / :348 / :353
ref inout(T) opIndex(size_t i) inout { return data.ptr[i]; }
inout(T)[] opSlice() inout { return data[0 .. length]; }          // a[]   (all)
inout(T)[] opSlice(size_t a, size_t b) inout { return data[a..b]; }// a[lo..hi]
// dmd/root/bitarray.d:62
void opIndexAssign(bool val, size_t idx) { ... }                  // a[idx] = val
// call sites:
auto x = arr[i];          // opIndex
bits[idx] = true;         // opIndexAssign
auto all = arr[];         // opSlice()    (no args)
auto sub = arr[1 .. n];   // opSlice(1, n)
auto last = arr[$ - 1];   // opDollar inside opIndex
```

```ts
// AFTER
opIndex(i: number): T { return this.data[i]; }
opSlice(): T[];                                                   // a[]      (Array!T)
opSlice(a: number, b: number): T[];                               // a[lo..hi]
opIndexAssign(val: boolean, idx: number): void { ... }            // bits[idx]=val
// call sites:
const x = arr.opIndex(i);
bits.opIndexAssign(true, idx);          // NOTE arg order: (value, index)
const all = arr.opSlice();              // arr[]  → the no-arg overload
const sub = arr.opSlice(1, n);          // arr[1..n]
const last = arr.opIndex(arr.opDollar() - 1);  // arr[$-1]
```

**`opDollar` — `$` substitution.** Inside `a[ … $ … ]`, `$` means `a.opDollar()`. In the
common single-arg case `opDollar()` returns the length. Rewrite by substituting
`a.opDollar()` for each `$` token *bound to that index expression*. The frontend's
multi-dimensional `opDollar!(dim)` (`dmd/dsymbolsem.d:6991`) is a user-program feature the
sema implements, not a frontend self-use — if you meet a literal multi-dim `$` in the
frontend's own source, **STOP**.

**Two `opSlice` forms, and the spelling is per-CONTAINER** (never collapse them): on
`OutBuffer`, no-arg `buf[]` → `opSliceAll()` and `buf[lo..hi]` → `opSlice(lo, hi)`; on
`Array!T`, both are `opSlice` — a no-arg overload and a two-arg one, with **no `opSliceAll` on
the container at all**. Read the receiver's class before picking the name.

> **`Array!T`'s `opSlice` returns a COPY, D's returns a live slice.** A call site that writes
> through the slice takes `tdata()` instead — the live backing array. `08-runtime-lib.md §2.1`
> owns the decision table; this is a silent-miscompile class, since the write simply lands
> nowhere.

> **`a[]` is a VIEW, never a consume.** On `OutBuffer` in particular, D `buf[]` maps to
> `opSliceAll()` (non-destructive); it is NEVER `extractData()`/`extractSlice()`, which empty
> the buffer. The full view-vs-consume table and the mandatory per-file audit grep live in
> `08-runtime-lib.md §13a.2` — a confirmed silent-miscompile class, treat it as such.

**`opIndexAssign` argument order is `(value, index)`** — the value comes first in D, keep
that order in TS so the body translates 1:1.

### Synthesized `opIndexAssign` for a ref-returning `opIndex` (CANONICAL HOME)

**Invariant:** when D's `opIndex` returns `ref T` (an **lvalue**) and the source declares
**no** explicit `opIndexAssign`, the assignment `arr[i] = v` is legal in D — it writes
**through the ref-return** of `opIndex` (the `[]` yields a mutable slot). TS has no
ref-returning getters: a TS `opIndex(i)` returns a **value**, so `arr.opIndex(i) = v` is
not even valid syntax and `arr[i] = v` does nothing useful on a class instance. Therefore
**you MUST synthesize an `opIndexAssign(v: T, i: number)`** (the §7 `(value, index)` order)
and rewrite every `arr[i] = v` call site to `arr.opIndexAssign(v, i)`, leaving a comment
that it is synthesized to stand in for D's ref-return write.

Source: `dmd/root/array.d:300` (`ref inout(T) opIndex(size_t i)` — returns `ref T`;
`Array!T` declares **no** `opIndexAssign`, so `arr[i] = v` writes through this ref-return).

```d
// BEFORE — dmd/root/array.d:300 : opIndex returns ref T, NO opIndexAssign declared
ref inout(T) opIndex(size_t i) inout nothrow pure { return data.ptr[i]; }
// call site — assignment writes through the ref-return of opIndex
arr[i] = v;
```

```ts
// AFTER — opIndex returns a value; synthesize opIndexAssign for the write side
opIndex(i: number): T { return this.data[i]; }
opIndexAssign(v: T, i: number): void { this.data[i] = v; }  // synthesized: D wrote via opIndex's ref-return
// call site
arr.opIndexAssign(v, i);
```

> This is the **only** sanctioned case for inventing an `opXxx` the D source did not
> declare: the write overload is implicit in D's ref-return semantics, and TS forces it to
> become explicit. It is **not** monomorphization guesswork — the body is the obvious slot
> write. (Container element write through a ref-returning `opIndex` is also referenced from
> `08-runtime-lib.md`'s "Container representation: TS-native `Array<T>`".)

**`opIndexOpAssign`** (`a[i] += v`) → `opIndexAddAssign(v, i)` etc. (same naming scheme as
§6, prefixed `opIndex`). No live frontend def found; if you meet one, follow this scheme.

---

## 8. `opSlice` on `Array!T` and the element-`opCmp` sort trick

`dmd/root/array.d:384` contains a translation-time-only construct you will skip, but note
it: `is(typeof(this.data[0].opCmp(this.data[1])) : int)` is a `static if`-style capability
probe (resolve per `07-compile-time.md`), and `:386` then *manually* calls
`pe1.opCmp(*pe2)` to sort. This is already an explicit `opCmp` call in D — keep it as a
method call in TS (`pe1.opCmp(pe2)`), it needs no operator rewrite. Listed here only so you
recognize the `opCmp` token is intentional, not a typo.

---

## 9. `complex_t` and the soft-float caveat

`dmd/root/complex.d:38-102` overloads `opBinary`/`opBinaryRight`/`opUnary`/`opEquals`/
`opCast(bool)` for complex constant folding. These ARE live (used by `constfold.d`, e.g.
`v = complex_t(r1 + r2)` at `dmd/constfold.d:170`). Translate them with the §4/§5 naming.
The component arithmetic is `real_t` = `number` (target `real` is 64-bit, ground-truth §3).

`dmd/root/longdouble.d`'s `longdouble_soft` overloads are in the **OFF** soft-float path
(`_config.md`, `CRuntime_Microsoft` section). **Do not port them.** Use `number` for
`real`/`longdouble` directly (`09-numerics.md`). If a live module appears to call a
`longdouble_soft` operator, STOP — it should have resolved to native `real`.

---

## 9b. Multiple overloads of the same operator

**Invariant:** a type may declare several `opBinary!"<op>"` (or other `opXxx`) overloads for the
**same operator**, distinguished only by the **parameter type**. The canonical name from §1 is
the *operator* name, so all of them collide on one TS method name. You must disambiguate. This
extends `04-functions.md`'s **Form B** (same arity, different param types → rename), with an
operator-specific suffix scheme so 05-operator names stay regular.

`complex_t` is the live example: it overloads `*` three ways — `complex_t * complex_t`,
`real_t * complex_t` (reversed, `opBinaryRight`), and `complex_t * real_t` — plus `/` two ways.

```d
// BEFORE — dmd/root/complex.d:56-78  (three "*" overloads, distinguished by param type)
complex_t opBinary(string op)(complex_t y) if (op == "*") { ... }   // :56  complex * complex
complex_t opBinaryRight(string op)(real_t x) if (op == "*") { ... } // :62  real * complex (reversed, §4)
complex_t opBinary(string op)(real_t y) if (op == "*") { ... }      // :68  complex * real
complex_t opBinary(string op)(real_t y) if (op == "/") { ... }      // :74  complex / real
```

```ts
// AFTER — the self-type overload keeps the bare canonical name; each other appends _<paramtype>
opMul(y: complex_t): complex_t { ... }        // self-type param (complex_t) -> bare opMul
opMul_real_t(y: number): complex_t { ... }    // complex * real_t           -> opMul_real_t
opMul_r(x: number): complex_t { ... }         // reversed (opBinaryRight, §4) keeps the _r suffix
opDiv_real_t(y: number): complex_t { ... }    // complex / real_t           -> opDiv_real_t
```

**Disambiguation rule (deterministic):**

0. Overloads that differ only in their **delegate** parameter's type (the `opApply` family) take
   `_<delegate parameter types joined by _>` on each non-bare form; the first declared keeps the bare
   name (dfa/fast/structure.d: `opApply`, `opApply_DFAVar_DFALattice`,
   `opApply_DFAVar_DFALattice_DFAScopeVar`).
1. The overload whose parameter type is the **enclosing type itself** keeps the **bare canonical
   name** (`complex_t * complex_t` → `opMul`). This is the "natural" operator.
2. **Each other** overload appends `_<D-parameter-type-identifier>` to the canonical name
   (`complex_t * real_t` → `opMul_real_t`). Use the D type name verbatim (`real_t`, not `number`)
   so the mapping is auditable against upstream.
3. The **reversed** form (`opBinaryRight`, §4) keeps its `_r` suffix and is orthogonal to this —
   it is already named by the operand side, not the param type.
4. If there is **no self-type overload**, the **first declared** overload keeps the bare name;
   the rest take the `_<paramtype>` suffix in declaration order.
5. **Call sites pick the method by the static type of the right operand** (the D compiler already
   resolved this): `cplx * cplx` → `a.opMul(b)`; `cplx * scalar` → `a.opMul_real_t(scalar)`;
   `scalar * cplx` → `cplx.opMul_r(scalar)`. Record the mapping in a one-line comment per method
   (house style §5) so each rename is auditable. If a call site's operand type is unclear, **STOP**.

> Naming note: an earlier worked example (`12-worked-examples.md`) used ad-hoc names
> (`opMulReal`, `opDivReal`) for these. The **canonical** scheme is the `_<D-parameter-type>`
> suffix above (`opMul_real_t`, `opDiv_real_t`); prefer it for new translations.

---

## 9c. `opEquals` returning `int`

**Invariant:** D may declare `int opEquals(...)` rather than `bool` — `bool` implicitly converts
to `0`/`1`, so the compiler accepts an `int`-returning `opEquals`, and the body may even `return
re == y.re && im == y.im;` (a `bool` widened to `int`). **Normalize the port to the §1 canonical
signature** `opEquals(o): boolean`: every call site uses the result as a **truth value** (`==`
rewrites to `a.opEquals(b)`, `!=` to `!a.opEquals(b)`), so a `boolean` return is faithful.

```d
// BEFORE — dmd/root/complex.d:102  (returns int, used only as a truth value)
int opEquals(complex_t y) const @safe { return re == y.re && im == y.im; }
```

```ts
// AFTER — normalized to boolean (the canonical §1 signature)
opEquals(y: complex_t): boolean { return this.re === y.re && this.im === y.im; }
```

> **Escalation:** if a call site uses the `opEquals` **numeric** value arithmetically (sums it,
> multiplies it, indexes with it — i.e. relies on the `int` 0/1 rather than truthiness), the
> `boolean` normalization is lossy. **STOP and escalate** (`11-escalate.md`). For the frontend's
> actual `int opEquals` uses (complex_t), all call sites are truth-value — `boolean` is correct.

---

## 9d. Operator-template forms (specialization vs constraint)

**Invariant:** D writes operator templates in two interchangeable forms, and they
**monomorphize identically**. Resolve each *concrete* operator to its canonical §1 method name
**regardless of which form** the declaration uses — the form is syntax, not semantics.

```d
// BEFORE — dmd/root/complex.d:38-39  (the two forms, both meaning "the + overload")
complex_t opBinary(string op : "+")(complex_t y) { ... }          // specialization form
complex_t opBinary(string op)(complex_t y) if (op == "+") { ... } // constraint form
```

```ts
// AFTER — both forms -> the same canonical method (§1). Form is irrelevant to the mapping.
opAdd(y: complex_t): complex_t { ... }   // opBinary!"+" — whichever form D used
```

- **Specialization form** `opBinary(string op : "+")(...)` — the template specializes on the
  literal `"+"`.
- **Constraint form** `opBinary(string op)(...) if (op == "+")` — the template constrains `op`.

Both produce exactly one instantiation per concrete `op`. Read off the concrete operator(s) the
declaration can match, then emit one canonical method per operator (`"+"` → `opAdd`, `"-"` →
`opSub`, …). A single constraint that admits **several** ops (`if (op == "+" || op == "-")`)
expands to **several** methods — one per op — not one method with a branch. If a constraint is
non-trivial (depends on more than the `op` string, e.g. on `is(T == …)`), **STOP** (§0).

---

## 10. `opCast` — `cast(T)a` and `if (a)`

**Invariant:** `opCast!T` is invoked by `cast(T)a` AND by any **boolean context**
(`if (a)`, `while (a)`, `a && b`, `!a`) when the type defines `opCast(T : bool)`. TS does
NOT call any method for `Boolean(obj)` (every object is truthy). You MUST rewrite both the
explicit cast and the implicit boolean context. Verified: `if (a)` and `cast(bool)empty`
both invoked `opCast(T : bool)`.

Source: `dmd/root/filename.d:1122`, `dmd/root/complex.d:97` (`opCast(T : bool)`),
`dmd/vsoptions.d:827`. (`vsoptions.d` is Windows-toolchain, mostly OFF — but the pattern
stands.)

```d
// BEFORE — dmd/root/complex.d:97
extern (D) bool opCast(T : bool)() const { return re != 0 || im != 0; }
// call sites:
if (cplx) { ... }              // implicit bool context → opCast!bool
bool b = cast(bool) cplx;      // explicit cast
```

```ts
// AFTER — name the bool cast opCastBool() (the only cast target the frontend uses)
opCastBool(): boolean { return this.re !== 0 || this.im !== 0; }
// call sites — rewrite EVERY truthiness use:
if (cplx.opCastBool()) { ... }
const b = cplx.opCastBool();
```

> The frontend's `opCast` overloads target **only `bool`** (capability/non-null checks).
> Name it `opCastBool()`. If you meet an `opCast` to a non-bool type, **STOP** — the
> rewrite (and numeric domain) is not covered here.
>
> **Numeric/primitive `cast(...)` is NOT this** — `cast(int)x`, `cast(long)x`,
> `cast(ubyte)x` etc. on primitives is value truncation, owned by `09-numerics.md`. Only
> `cast(T)structValue` where `structValue`'s type defines `opCast` is an overload. Class
> down/up-casts (`cast(ClassDeclaration)sym`) are the `isXxx()`/instanceof idiom owned by
> `02-types.md`. `opCast` here = the struct-to-bool case only.

---

## 11. `opApply` / `opApplyReverse` — `foreach` over an object (THE HARD ONE)

**This is the trickiest rewrite in the doc. Read it fully.**

**Invariant:** `foreach (vars; agg)` where `agg`'s type defines `opApply` desugars to a
call `agg.opApply(dg)`, where `dg` is a delegate carrying the loop body. The loop's
control flow (`break`, `continue`, `return`, fall-through) is encoded as the delegate's
**`int` return code**, and `opApply` propagates it. You MUST reproduce this protocol
exactly, or `break`/`return` inside such a `foreach` silently does the wrong thing.

**VERIFIED protocol (probed with `ldc2`):**
- The body becomes `dg(loopVars) -> int`.
- `dg` returns **`0`** → normal iteration, keep going.
- `dg` returns **non-zero** → `opApply` must stop and return that code immediately.
- Loop body **fall-through** (no break/return) → `dg` returns `0`.
- Loop body **`break`** → `dg` returns a sentinel; `opApply` stops. (Probed: break after
  first element stopped the loop.)
- Loop body **`continue`** → `dg` returns `0` (just ends this delegate call). (Probed:
  `continue` skipped one element, kept iterating.)
- Loop body **`return X`** from the *enclosing function* → `dg` returns a non-zero code
  carrying the intent; `opApply` returns it up; the enclosing function then returns `X`.
  (Probed: `return x*100` inside `foreach` over `opApply` produced `300`.)

Source: `dmd/root/stringtable.d:227` (`StringTable.opApply`), call site
`dmd/root/stringtable.d:397,405` (`tab.opApply(applyDeleg)` — already explicit in a
unittest), and `dmd/mtype.d:3560` (`ParameterList.opApply`). The frontend's own `opApply`
*bodies* iterate an inner container and call `dg` per element exactly as above.

### Canonical translation — the method

```d
// BEFORE — dmd/root/stringtable.d:227
int opApply(scope int delegate(const(StringValue!T)*) nothrow dg) nothrow {
    foreach (const se; table) {
        if (!se.vptr) continue;
        const sv = getValue(se.vptr);
        int result = dg(sv);          // call body; capture return code
        if (result) return result;    // non-zero → stop & propagate
    }
    return 0;                         // ran to completion
}
```

```ts
// AFTER — opApply takes a callback returning the control code (number: 0 = continue)
opApply(dg: (sv: StringValue<T>) => number): number {
    for (const se of this.table) {       // inner iteration is normal for-of
        if (!se.vptr) continue;
        const sv = this.getValue(se.vptr);
        const result = dg(sv);           // run the (translated) loop body
        if (result) return result;       // propagate break/return code
    }
    return 0;
}
```

### Canonical translation — the `foreach` CALL SITE (the part agents miss)

A `foreach` over an `opApply` type is NOT a `for-of`. It is a call to `opApply` with the
body wrapped in a callback, plus a control-flow protocol. Use **exactly** this shape:

```d
// BEFORE — a foreach over an opApply aggregate, with break / continue / return
int findValue(StringTable!int tab, int target) {
    foreach (sv; tab) {                 // → tab.opApply(dg)
        if (sv.value == target)
            return sv.value;            // return from enclosing fn
        if (sv.value < 0)
            continue;                   // skip
        if (sv.value > 1000)
            break;                      // stop iterating
        process(sv);
    }
    return -1;
}
```

```ts
// AFTER — control codes: 0 = continue/fall-through, 1 = break, 2 = return-from-enclosing.
// (The exact non-zero values don't matter to opApply — any non-zero stops it. We use a
//  small convention so the caller can distinguish "break" from "return".)
function findValue(tab: StringTable<number>, target: number): number {
    let returnValue: number;                          // holds an enclosing-return payload
    const code = tab.opApply((sv: StringValue<number>): number => {
        if (sv.value === target) { returnValue = sv.value; return 2; }  // return: code 2
        if (sv.value < 0) return 0;                                     // continue: 0
        if (sv.value > 1000) return 1;                                  // break: code 1
        process(sv);
        return 0;                                                       // fall-through: 0
    });
    if (code === 2) return returnValue!;              // enclosing-return path
    // code === 1 (break) and code === 0 (ran out) both fall through to here
    return -1;
}
```

**Rules for the call-site rewrite (apply mechanically):**

1. The loop variables become the callback parameters (same names, same `ref` semantics —
   a `ref` param is a mutation through the object, see §5/`03-value-semantics.md`).
2. **fall-through / `continue`** → `return 0;` from the callback.
3. **`break`** → `return 1;` from the callback (any reserved non-zero distinct from the
   return code).
4. **`return EXPR;` from the enclosing function** → stash `EXPR` in an outer variable,
   `return 2;` from the callback, then after `opApply` returns, `if (code === 2) return
   <stashed>;`.
5. **A bare `return;`** (void enclosing fn) → `return 2;` and `if (code === 2) return;`.
6. If the original loop had **none** of break/return (pure fall-through), the callback
   always returns `0`, `opApply` returns `0`, and no post-check is needed — emit the
   simple form (no `returnValue`, no `if (code …)`).

> **Why a callback and not a `for-of`:** the aggregate's `opApply` body may interleave
> non-trivial logic between elements (the StringTable example skips null slots). You
> CANNOT inline it as a `for-of` over the aggregate — you must call `opApply` and let it
> drive. Translating `opApply`-`foreach` as a plain `for-of` is a **miscompile**; STOP if
> tempted.

**`opApplyReverse`** (`foreach_reverse (…; agg)`) is identical with the method name
`opApplyReverse` and reverse internal iteration. Same control-code protocol.

> **Disambiguation:** most `foreach` in the frontend (1129 of them, ground-truth §4) is
> over **slices/arrays/`Array!T`/AAs/ranges**, NOT over an `opApply` object — those are
> ordinary `for-of`/indexed loops owned by `06-control-flow.md`. Only `foreach` over a
> value whose **type defines `opApply`** uses this section. Check the aggregate's type. If
> the aggregate is one of the §0 `opApply` types (`StringTable!T`, `ParameterList`),
> use this section; otherwise see `06-control-flow.md`. If you cannot tell, **STOP**.

---

## 12. `opDispatch`

`opDispatch!"name"` is forwarding for *unknown* member access — `a.b` lowers to
`a.opDispatch!"b"()` when `b` is not a real member. The frontend mentions `opDispatch` only
in **its implementation of the feature for user code** (`dmd/typesem.d:5278+`,
`dmd/expressionsem.d:1367+`) — i.e. the sema logic that *resolves* a user program's
`opDispatch`. That is algorithm to translate, NOT a frontend self-use.

**Rule:** the frontend's **own source does not use `opDispatch` on its own types.** If you
encounter what looks like a real `opDispatch` member call in the frontend source (outside
the `typesem`/`expressionsem` logic that implements the feature), **STOP** (`11-escalate.md`).
TS has no general `opDispatch` equivalent (`Proxy` exists but we never need it for the
port). Do not invent one.

---

## 13. `toHash`

**Invariant:** `toHash` provides the hash for a value used as an **associative-array key**.
D's built-in AA calls `key.toHash()` and `key.opEquals(other)` together. Returns
`size_t` → in our port a `number` hash.

Source: `dmd/location.d:172` (`Loc.toHash`, paired with `Loc.opEquals` at `:166`),
`dmd/templatesem.d:192` (`TemplateInstanceBox.toHash`, cached, paired with `opEquals` at
`:198`).

```d
// BEFORE — dmd/location.d:166,172  (Loc used as AA key)
extern (D) bool opEquals(ref const(Loc) loc) const { return this.index == loc.index; }
extern (D) size_t toHash() const { return hashOf(this.index); }
```

```ts
// AFTER
opEquals(loc: Loc): boolean { return this.index === loc.index; }
toHash(): number { return hashOf(this.index); }     // hashOf → 08-runtime-lib.md
```

**Call-site rewrite — there is no D-AA-with-struct-key in TS.** A D `V[K]` where `K` is a
struct with `opEquals`/`toHash` does NOT map to a JS `Map` (which uses SameValueZero
identity, ignoring `toHash`/`opEquals`). The container translation (custom hash map keyed
by `toHash` + `opEquals`) is owned by **`08-runtime-lib.md`**. Your job in *this* doc:
emit the `toHash()` and `opEquals()` methods so that container can use them. **If you are
translating a `K[V]` AA literal/lookup where `K` is such a struct, see `08-runtime-lib.md`
for the container; do not improvise a `Map`** (it will silently compare by identity).

---

## 14. `toString`

**Invariant:** D `toString` is the value→string conversion (distinct from the frontend's
ubiquitous C-style `toChars()`, which returns `const(char)*` and is owned by
`08-runtime-lib.md`/`09-numerics.md` string handling — NOT an operator). `toString` comes
in two shapes:

1. **Returning a string** — `string toString()` → TS `toString(): string`. Note: a D
   `string` is a byte buffer in our model (probes §5), so the return is the project's
   string type (`08-runtime-lib.md`), not necessarily a JS `string`.
2. **Sink form** — `void toString(scope void delegate(const(char)[]) sink)` → TS
   `toStringSink(sink: (s: <strtype>) => void): void`. Name the sink form
   `toStringSink` to keep it distinct (no overloading).

`dmd/json.d` calls `x.toString()` on AST nodes pervasively (e.g. `json.d:377`); those are
ordinary method calls — translate as `x.toString()`. No call-site *operator* rewrite is
needed for `toString` (D never invokes it via an operator the way `~`/`<` are invoked); it
is always an explicit `.toString(...)` call already.

> **Do not confuse `toString` with `toChars`.** `toChars()` (hundreds of frontend uses) is
> the diagnostic/printing primitive returning a C string pointer — its handling
> (`OutBuffer`, `extractChars`, byte buffers) is owned by `08-runtime-lib.md`. This doc
> only covers `toString` as the value-conversion overload.

---

## 15. Quick checklist (run this for every overloaded type you touch)

1. Found an operator (`==` `<` `+` `[]` `()` `cast` `foreach`) on a **struct/class** value?
2. Located the `opXxx` definition? (grep the type + `opXxx`.) If not → **STOP**.
3. Emitted the method with the **canonical name** from §1?
4. **Rewrote EVERY call site** of that operator on that type? (grep the operator against
   all variables of the type — §0.) A missed site is a silent miscompile.
5. For `opEquals`/`opCmp`: handled the `==`-via-`opCmp` fallback (§3) and class-null case
   (§2)?
6. For `foreach`-over-`opApply`: used the callback + control-code protocol (§11), NOT a
   `for-of`?
7. Body arithmetic follows `09-numerics.md`; container/AA-key follows `08-runtime-lib.md`.

---

## Cross-references

- **Numeric arithmetic inside `opBinary`/`opUnary`/`opOpAssign` bodies** (BigInt vs number,
  wrap, truncate, `cast(int)`/`cast(long)`): `09-numerics.md`.
- **`cast(ClassDeclaration)sym` downcast idiom, `isXxx()`/instanceof:** `02-types.md`
  (NOT `opCast`; §10 covers only struct-to-bool `opCast`).
- **Value-semantics around `++`/`--`/`opOpAssign` and struct copies:** `03-value-semantics.md`.
- **`foreach` over slices/arrays/`Array!T`/AAs (the non-`opApply` majority):**
  `06-control-flow.md`.
- **AA with struct key (`toHash`+`opEquals` container), `Array!T` container, `OutBuffer`,
  `toChars`/`hashOf`:** `08-runtime-lib.md`.
- **`static if`/`__traits(compiles, …)` capability probes seen near operator defs (e.g.
  `array.d:384`):** resolve per `07-compile-time.md`.
- **Any uncovered `opXxx`, ambiguous call site, non-bool `opCast`, real frontend
  `opDispatch`, or postfix `++` overload:** `11-escalate.md` — STOP, never guess.
