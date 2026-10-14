# 06 — Control Flow (D → TypeScript)

> **STOP rule:** if you meet a control-flow construct not covered here, or any
> ambiguity in how to translate one, **STOP and escalate** (`11-escalate.md`).
> Never guess. A wrong-but-plausible control-flow translation in a compiler is
> worse than a halt.

Read `_ground-truth.md` first. This doc owns: every `foreach` form, `final switch`
+ string/range/`goto` switch mechanics, `scope(exit|success|failure)`, `with`,
labeled `break`/`continue`, and `try`/`catch`/`finally`/`throw`. Adjacent topics:

- `opApply` *definition* (the operator method itself) → **`05-operators.md`**. This
  doc covers only the loop-body side: how a `foreach` over an `opApply` object is
  rewritten.
- Numeric loop counters, integer-range arithmetic, BigInt-vs-`number` choice for
  loop indices → **`09-numerics.md`**.
- D `string` is a byte array (`Uint8Array`), NOT a JS string → **`02-types.md`** /
  `_probes.md §5`. `foreach(char)` vs `foreach(dchar)` decode rules below assume it.
- `Array!T` container iteration → **`08-runtime-lib.md`** for the container; the
  `foreach` form here applies once you have something array-like.
- ESM circular-import handling for any helper you introduce → `01-conventions.md`.

**Invariant that governs the whole doc:** preserve the *exact* iteration order,
the *exact* break/continue semantics, and the *exact* failure behavior (a `final
switch` that throws, a plain switch that the frontend's logic guarantees is total).
Control flow decides compile outcomes; do not "tidy" it.

---

## 1. `foreach` — the canonical forms

D `foreach` has one keyword and several lowerings depending on the aggregate.
**You must identify which form you are looking at** before translating — they map
to different TS constructs.

### 1.1 `foreach (x; arr)` over an array/slice → `for…of`

D `foreach` over an array/slice binds `x` to a **copy** of each element by default
(value semantics — see `03-value-semantics.md`). For the frontend's pervasive
pointer/class elements this copy is a reference copy (harmless). For `struct`
elements you MUST apply the value-copy rule from `03-value-semantics.md`.

| D | TS |
|---|---|
| `foreach (sx; *s.statements) { … }` | `for (const sx of s.statements!) { … }` |

Real example — `inline.d:220`:

```d
foreach (i, sx; *s.statements)   // (indexed form, see §1.2)
```

Plain (no index), `expressionsem.d` style:

```d
// D
foreach (e; *te.exps)
    e.accept(this);
```

```ts
// TS
for (const e of te.exps!) {
  e.accept(this);
}
```

**Invariant:** `for…of` iterates in ascending index order, same as D. Do not use
`forEach` (it breaks `break`/`continue`/`return` and labeled jumps — §6).

### 1.2 `foreach (i, x; arr)` — the index form → `for…of` with `.entries()`

D's two-variable form over an array binds the **0-based index** to the first
variable and the element to the second.

Real example — `expressionsem.d:944`:

```d
foreach (i, e; *ae.arguments)
{
    …
}
```

```ts
// TS — canonical: destructure entries()
for (const [i, e] of ae.arguments!.entries()) {
  …
}
```

**Decision (be decisive):** always use `.entries()` destructuring for the indexed
form, never a manual `for (let i = 0; …)` counter — unless the body *mutates the
index* (`i += 2`, skips) or needs `i` after the loop, in which case fall to §1.6.

**Container caveat:** this rule reaches only RAW TS arrays. The ported `Array!T`
(`root/array.ts`) exposes `[Symbol.iterator]`, `opIndex`, `opSlice`, `tdata` and
`each` — and **no `.entries()`**. Iterating a D `Array!T` by index therefore takes
the §1.6 index `for` (or `.tdata().entries()` where a live view is wanted, `08 §2`),
never a `.entries()` call the container does not have.

**Index type:** `i` is `size_t` in D. It is a loop index provably `< length`, so it
lives in the `number` domain (`09-numerics.md`). `.entries()` yields a `number`
index — correct.

**Invariant:** the index is the *array position*, not a running counter — they
coincide for a forward `foreach` but NOT for `foreach_reverse` (§4).

### 1.3 `foreach (i; 0 .. n)` — integer range → counter `for`

Verified (`/tmp/p_rev.d` and inspection): `foreach (i; lo .. hi)` iterates
`i = lo, lo+1, …, hi-1` (half-open, `hi` exclusive).

Real example — `expressionsem.d:18241`:

```d
foreach (i; 0 .. nfields)
{
    …
}
```

```ts
// TS — canonical: numeric for over [0, nfields)
for (let i = 0; i < nfields; i++) {
  …
}
```

**Bounds & domain:** `lo`/`hi` are evaluated **once** at loop entry in D. If `hi`
is an expression with side effects or that the body mutates, hoist it:

```d
foreach (i; 0 .. a.length)   // a.length captured once
```

```ts
const _n = a.length;        // capture once — D evaluates the bound at entry
for (let i = 0; i < _n; i++) { … }
```

The counter is `number` (it is a length-bounded index, `09-numerics.md`). If the
range bounds are `long`/`ulong` (BigInt) — rare in the frontend — STOP and escalate;
do not silently mix BigInt and `number` in the loop condition.

**D's range variable is a per-iteration COPY — if the BODY assigns to it, the plain
form is a silent miscompile.** Verified with an `ldc2 1.42` probe: `++i` inside the
body does NOT advance the loop (0,1,2,3,4 printed with and without the `++i`), while
the canonical TS `for (let i = lo; i < hi; i++)` makes that mutation persist and skip
an iteration. Live instance: `initsem.d:733` `foreach (fieldi; 0 .. nfields)`, whose
body does `++fieldi` inside a skip-overlap `while`. **When the body assigns to the
variable, the canonical form splits in two:**

```ts
for (let fieldiLoop = lo; fieldiLoop < hi; fieldiLoop++) { let fieldi = fieldiLoop; … }
```

The plain single-variable form is valid **only** when the body never assigns to it.

### 1.4 `foreach (c; str)` and `foreach (dchar c; str)` — string iteration

D `string` is a **byte array** (`immutable(char)[]`, `_probes.md §5`). The element
type of the loop variable changes the semantics:

| D | Iterates | TS |
|---|---|---|
| `foreach (char c; s)` | **code units / bytes** (no decode) | `for (const c of s) { … }` over the byte buffer |
| `foreach (c; s)` (inferred `char`) | same — bytes | same |
| `foreach (dchar c; s)` | **UTF-8 decoded code points** | decode loop (helper) |

`foreach(char)` — bytes (5 iterations for `"a€b"` per `_probes.md §5`):

```ts
// s is the byte buffer (Uint8Array / number[]); see 02-types.md
for (const c of s) { … }      // c is a byte (number 0..255)
```

`foreach(dchar)` — auto-decodes (3 iterations for `"a€b"`: 97, 8364, 98):

```ts
// TS — MUST use the UTF-8 decode iterator from the runtime lib, NOT a byte loop
for (const dc of utf8Decode(s)) { … }   // dc is a code point (number)
```

**Invariant (silent-bug class):** the byte-vs-code-point distinction changes the
iteration count and the values. Picking the wrong one is a silent mis-port. The
loop-variable type in the D source tells you which — if the D omits the type and
relies on inference, it is `char` (bytes). `utf8Decode` is owned by
`08-runtime-lib.md` / `02-types.md`; cross-reference, do not invent.

### 1.5 `foreach (kv; aa.asRange)` / associative-array iteration

The frontend does **not** use D's built-in `V[K]` associative arrays in hot
`foreach` loops; it uses the custom AA wrapper in `root/aav.d` (an `opApply`/range
adapter) and `root/stringtable.d`. So the AA-`foreach` you will actually meet is:

Real example — `root/aav.d:199`:

```d
foreach (keyValue; aa.asRange)
{
    … keyValue.key … keyValue.value …
}
```

This is a **range** `foreach` (§1.7) over `asRange`, OR an `opApply` (`stringtable.d:227`):

```d
// root/stringtable.d:227 — opApply form
int opApply(scope int delegate(const(StringValue!T)*) nothrow dg) { … }
```

**Translation:** treat `asRange` per the range rule (§1.7) and the `opApply` form
per §1.8. The *container* (`root/aav.d`, `root/stringtable.d`) is ported by
`08-runtime-lib.md`; once it exposes a JS iterator/`opApply`, this doc's range/opApply
rules apply unchanged.

**If you meet a built-in `foreach (k, v; someBuiltinAA)`** (D `V[K]` with two loop
vars = key+value; one var = value only): map to TS `Map` iteration —
`for (const [k, v] of m)` (key+value) or `for (const v of m.values())` (value only).
**Iteration order of a D built-in AA is unspecified**; if the frontend's logic
depends on order here, STOP and escalate. (Built-in-AA `foreach` is rare — verify
the type before assuming this branch.)

### 1.6 When NOT to use `for…of` — fall back to an index `for`

Use a manual counter `for` (and keep the D structure visible) when the body:

- mutates the index (`i++` inside, skip-ahead, `i += 2`),
- mutates the aggregate length while iterating,
- needs the index value *after* the loop,
- iterates two cursors in lock-step (the `idx++` pattern at `mtype.d:3590`).

```d
// mtype.d opEquals: foreach drives one cursor, idx tracks the other
foreach (_, p1; cast() this)        // opApply (§1.8), but the body mutates idx
{
    auto p2 = other[idx++];
    …
}
```

Here `idx` is loop-carried state separate from the loop variable — keep it explicit.

### 1.7 Range `foreach` (`front`/`popFront`/`empty`) → `while`

A `foreach` over a *range* (a type with `.empty`, `.front`, `.popFront()`) lowers to
a `while` loop. D does this lowering itself; you reproduce the lowering.

**Canonical lowering** (this is exactly what the D spec defines `foreach` over a
range to mean):

```d
// D — foreach over a range r
foreach (e; r) { body; }
```

```ts
// TS — canonical, mirror D's lowering
for (let _r = r; !_r.empty; _r.popFront()) {
  const e = _r.front;
  body;
}
```

Use `for(;;)` (not `while`) so a `continue` in the body still runs `popFront()`
— D's lowering puts `popFront()` in the loop-increment position, and a `continue`
must NOT skip it. **Getting this wrong is an infinite loop.**

**Invariant:** evaluate `.front` exactly once per iteration into the loop variable
(D binds it once); re-reading `.front` may be non-idempotent for some ranges.

### 1.8 `foreach` over an `opApply` object → callback-driven loop

When the aggregate defines `int opApply(scope int delegate(…) dg)`, the `foreach`
is sugar for calling `opApply` with the body as a delegate. The **protocol is
load-bearing** and verified against `mtype.d:3789` (`Parameter._foreach`):

- The delegate returns `int`. **`0` ⇒ continue** to the next element; **non-zero ⇒
  stop the loop and propagate that value as the loop's result.**
- A `break` in the `foreach` body becomes `return <non-zero>;` from the delegate.
- A `continue` becomes `return 0;` from the delegate.
- A plain fall-off-the-end of the body becomes `return 0;`.
- A `return X;` *from the enclosing function* inside the body is encoded by a
  sentinel and re-thrown after `opApply` returns (D handles this; if the frontend
  body does this, preserve it — STOP and escalate if unclear).

Real `foreach`-over-opApply site — `expressionsem.d:15487`:

```d
foreach (i, p; tf.parameterList)   // ParameterList.opApply(SemanticForeachDg)
{
    …
    if (cond) break;               // -> delegate returns non-zero
}
```

```ts
// TS — the foreach is rewritten as an opApply call with a callback.
// 0 = continue, non-zero = break.  (opApply method itself: see 05-operators.md)
tf.parameterList.opApply((i, p) => {
  …
  if (cond) return 1;   // break
  return 0;             // continue
});
```

**Decision:** for the loop body, encode `break` as `return 1`, `continue` as
`return 0`, normal end-of-body as `return 0`. The *definition* of `opApply` (the
method body, the delegate typedef like `Parameter.ForeachDg`) belongs to
`05-operators.md` — cross-reference, do not duplicate it here.

**Invariant:** never translate an `opApply` `foreach` to `for…of` — the object is
NOT a JS iterable, and the `int`-return break/continue protocol would be lost.

### 1.9 `foreach` over a container *value* (`Array!T`) → `for…of`

**This is the canonical home for the rule.** Distinguish three superficially similar
forms — they have *different* lowerings:

- **a raw slice/array** `foreach (e; *s.statements)` → §1.1 (already covered);
- **an `opApply` object** `foreach (i, p; tf.parameterList)` → §1.8 (already covered);
- **a container *value*** `foreach (e; arrayValue)` where `arrayValue` is an `Array!T`
  *struct value* (not a slice, not an `opApply` object) — **this subsection.**

`Array!T` (`dmd/root/array.d:30`) is a growable container struct. It defines **no
`opApply`** — its only iteration affordance is `opSlice` (`dmd/root/array.d:348,353`,
the `arr[]` element view, see `05-operators.md`). So D's `foreach (e; arrayValue)`
lowers through the *element view*: `foreach (e; arrayValue[])`. It binds each element
in ascending index order — identical to §1.1 over the slice.

Verified — `dmd/root/array.d:475` (the `Array!T` unittest iterates the container value
directly, no `[]`):

```d
// D — foreach directly over the Array!T struct VALUE (not arrayA[])
arrayA.zero();
foreach (e; arrayA)
    assert(e == 0);
```

In the port the container is a TS-native generic class (`08-runtime-lib.md`
"Container representation: TS-native Array<T>") that exposes a `[Symbol.iterator]`
delegating to its backing array. A class with `[Symbol.iterator]` **is** a JS iterable,
so `for…of` over the container value lowers exactly the way D lowers `foreach` over the
struct value:

```ts
// TS — for…of over the container value (its [Symbol.iterator] yields elements)
arrayA.zero();
for (const e of arrayA) {
  assert(e === 0);
}
```

**Decision (be decisive):** `foreach (e; arrayValue)` → `for (const e of arrayValue)`,
**not** `for (const e of arrayValue[])` and **not** an `opApply` callback. You do not
need to insert the `[]`/`opSlice()` call yourself — the container's `[Symbol.iterator]`
is the JS-side equivalent of D's slice lowering, so the value-level `for…of` is the
faithful, idiomatic form. (If a *site* writes the slice explicitly, `foreach (e;
arrayValue[])`, that is the §1.1 raw-slice form — translate it as written.)

**Index form** `foreach (i, e; arrayValue)`: the container's `[Symbol.iterator]` yields
*elements only*, so `.entries()` (§1.2) is not available on the iterator directly. Drive
the index off the element view: `for (const [i, e] of arrayValue[].entries())` — i.e.
fall to the §1.1/§1.2 slice form for the indexed case. Confirm the accessor name for the
element view against `08-runtime-lib.md` before using it.

**Invariants:**
- Iteration order is ascending index, same as §1.1 — `[Symbol.iterator]` walks the
  backing array in order.
- `Array!T` defines no `opApply`, so this is never the §1.8 callback form — do not
  encode `break`/`continue` as `return 1`/`return 0`; ordinary `break`/`continue` work.
- A struct *element* type still obeys the value-copy rule of `03-value-semantics.md`
  (the loop variable is a copy in D); the frontend's `Array!T` elements are
  predominantly pointers/classes (reference copy, harmless) — confirm per site.

---

## 2. `foreach_reverse` → reverse iteration

Verified (`/tmp/p_rev.d`): `foreach_reverse (i; 0..4)` yields `3 2 1 0`;
`foreach_reverse (i, v; a)` over `[10,20,30]` yields `[2]=30 [1]=20 [0]=10` — i.e.
the **index counts down through the original positions** and `v` is the element at
that position.

| D | TS |
|---|---|
| `foreach_reverse (e; a)` | `for (let _i = a.length - 1; _i >= 0; _i--) { const e = a[_i]; … }` |
| `foreach_reverse (i, e; a)` | `for (let i = a.length - 1; i >= 0; i--) { const e = a[i]; … }` |
| `foreach_reverse (i; lo .. hi)` | `for (let i = hi - 1; i >= lo; i--) { … }` |

Real example — `clone.d:1012`:

```d
foreach_reverse (userDtor; ad.userDtors[])
{
    …
}
```

```ts
const _ud = ad.userDtors;            // the slice/array
for (let _i = _ud.length - 1; _i >= 0; _i--) {
  const userDtor = _ud[_i];
  …
}
```

**Invariant:** order is reversed but the index value (in the two-var form) is still
the element's original array position — NOT a 0-based reverse counter. The frontend
uses `foreach_reverse` where order matters (e.g. running destructors LIFO in
`clone.d`); a wrong direction is a correctness bug. Capture the aggregate once.

---

## 2.5 Conditions (`if`/`while`/`for`/ternary) — numeric truthiness must be made explicit

A numeric value used in a boolean context — `if (x)`, `while (x)`, the `for (;cond;)`
condition, the ternary `x ? … : …`, and the boolean operators `x || y`, `x && y`,
`!x` — tests `x != 0` in D. **JS/TS truthiness does NOT always match**, and the
mandate is scoped by where it actually diverges (rationale + per-domain detail:
`09-numerics.md §9`):

- **MANDATORY expansion** — any `float`/`double`/`real` value (**the real trap**: D's
  `if (nanValue)` is TRUE because `NaN != 0`, while JS treats `NaN` as falsy — a bare
  `if (x)` on a float is a live divergence); any enum-typed value; any `&&`/`||` whose
  result feeds a `bool` slot (JS returns an operand, D returns `bool`); and any value
  whose static type is not provably a plain integral. A bitwise test on enum flags
  (`flags & ParseStatementFlags.scope_`, `scw & SCW.x`, `level & (LVL.a | LVL.b)`) is
  enum-typed: write `(x & F) !== 0`. parse.ts's bare `flags & ParseStatementFlags.*` sites
  (5557, 5583, 5672, ...) predate the rule and are not a precedent. Where tsc has narrowed an
  enum local to non-zero (inside `if (x != 0)`) and rejects the explicit `!== E.none` as
  TS2367, the bare operand is permitted with a comment naming the narrowing (cparse.d:2558,
  inside :2541's `if (tkwx)`).
- **OPTIONAL** (bare `if (x)` permitted, expansion still preferred) — a value provably
  in the plain-integer domain (`number`-domain integral, or `bigint`), where JS
  truthiness coincides with `!= 0` exactly.

**The canonical expanded forms:**

| D | TS |
|---|---|
| `if (x)` / `while (x)` | `if (x !== 0)` / `while (x !== 0)` |
| `!x` | `x === 0` |
| `a \|\| b` (numeric) | `(a !== 0) \|\| (b !== 0)` |
| `a && b` (numeric) | `(a !== 0) && (b !== 0)` |
| `x ? t : f` (numeric `x`) | `x !== 0 ? t : f` |

For a `bigint`-domain value (`09-numerics.md`), compare against `0n`
(`x !== 0n`, `x === 0n`). For a value already in the `boolean` domain, no expansion
is needed — leave it as is. Detail and rationale (why JS truthiness is unsafe here,
the per-type domain choice) live in **`09-numerics.md` "Numeric truthiness"**.

A value used in a condition is **not always numeric** — it may be a *nullable class
reference* (§2.7), or it may also be *declared inside the condition itself* (§2.6).
Resolve the type domain first, then apply the matching rule.

**`b |= f()` on a `bool` is NOT `b = b || f()`.** D's `|=` always evaluates its right
operand; `||` short-circuits. Where the callee emits diagnostics, the `||` spelling
**silently suppresses them once the flag is already true** — the error count stays
right and the messages disappear. **Canonical: sequence the call, then or.**

```ts
// D: errors |= tf.checkRetType(loc);
const retTypeErrors = checkRetType(tf, loc);   // called unconditionally, as D does
errors = errors || retTypeErrors;
```

Worked in the tree at `typesem.ts:4086-4090`, comment included. Live D sites:
`typesem.d:3835/:4139/:4152`, `expressionsem.d:13675/13679/13757/13761`. The `||`
spelling would have dropped a return-type diagnostic on every function whose
parameter loop had already errored.

---

## 2.6 Declaration in a condition → hoist to a `const`, then test

D (like C++) lets you **declare and assign a variable inside an `if`/`while`
condition** and test its truthiness; the declared name is scoped to the branch.
TS forbids a declaration in a condition (the condition position is an *expression*,
not a statement). **Canonical rewrite: hoist the declaration to a `const` on the
line immediately before the statement, then test that `const` in the condition.**

Real example — `dmd/constfold.d:201`:

```d
// D — declare + assign + test, soe scoped to the if-branch
else if (SymOffExp soe = e1.isSymOffExp())
{
    …use soe…
}
```

```ts
// TS — hoist to a const, then test (see §2.7 for the nullable-ref test form)
const soe = e1.isSymOffExp();
if (soe !== null) {
  …use soe…
}
```

The test form depends on the declared value's domain: a **nullable class reference**
(the common frontend case — `isXxxExp()` accessors return the class or `null`) uses
the `!== null` / `=== null` form of **§2.7**; a **numeric** declared value uses the
`!== 0` form of §2.5. Pick the rule by the declared type, exactly as you would for
any other condition.

**Chained `else if` declarations** — the load-bearing case (`dmd/constfold.d:201,206`,
two `else if (SymOffExp soe = …)` arms in sequence) — must **preserve short-circuit**:
the second declaration is evaluated *only* when the first arm's test is false. A flat
hoist of both `const`s to the top would evaluate both initializers unconditionally,
changing behavior (and, if `isSymOffExp()` had side effects, observably so). Keep the
short-circuit by **nesting the hoist into the `else` branch**:

```d
// dmd/constfold.d:201,206 — chained, second arm only reached if first is null
else if (SymOffExp soe = e1.isSymOffExp())
{
    …soe from e1…
}
else if (SymOffExp soe = e2.isSymOffExp())
{
    …soe from e2…
}
else
    …
```

```ts
// TS — nest into else so e2.isSymOffExp() runs only when the e1 arm did not match
const soe1 = e1.isSymOffExp();
if (soe1 !== null) {
  …soe1 from e1…
} else {
  const soe2 = e2.isSymOffExp();
  if (soe2 !== null) {
    …soe2 from e2…
  } else {
    …
  }
}
```

**Decision (be decisive):** never leave a declaration in the condition; always hoist
to a `const` just before the statement. For a single arm, one `const` + `if`. For a
chain, nest each subsequent declaration into the prior `else` so the short-circuit /
evaluation-order of the D source is reproduced exactly. Each declared name keeps its
branch scope naturally — the `const` lives in the block (or `else` block) that uses it.

**Invariant:** the initializer expression must run the **same number of times, in the
same order**, as in D. The branch-scoping (a name visible only inside its arm) is
preserved by placing the `const` in the arm's block. Do not widen the scope by hoisting
above the whole chain.

---

## 2.7 Truthiness of a nullable reference → explicit `!== null` / `=== null`

Distinct from numeric truthiness (§2.5, and `09-numerics.md` "Numeric truthiness"): a
**nullable class reference** in a boolean context tests *non-null*, not *non-zero*. A
non-null reference is **always truthy** in D regardless of the object's contents, so
the faithful, explicit form compares against `null`:

| D | TS |
|---|---|
| `if (ref)` / `while (ref)` | `if (ref !== null)` / `while (ref !== null)` |
| `!ref` | `ref === null` |
| `ref ? t : f` | `ref !== null ? t : f` |
| `a \|\| b` (refs) | `(a !== null) \|\| (b !== null)` |
| `a && b` (refs) | `(a !== null) && (b !== null)` |

Real example — `dmd/constfold.d:201` (`if (SymOffExp soe = e1.isSymOffExp())`): the
condition tests the class reference returned by `isSymOffExp()` — non-null ⇒ matched,
`null` ⇒ not — so it lowers to `soe !== null` (combined with the §2.6 hoist).

**Pointers and optionals follow the same shape.** A nullable *pointer* in a boolean
context is `if (p)` → `if (p !== null)`, `!p` → `p === null`; a TS `T | undefined`
optional uses `!== undefined` / `=== undefined` analogously. The principle is identical:
make the *what is being tested* explicit, never lean on JS truthiness (a valid object,
a `0`-valued field, an empty buffer are all truthy as references — JS would agree for
objects, but the explicit `!== null` documents intent and is uniform with the numeric
rule's "no implicit truthiness" stance).

**Decision (be decisive):** every nullable-reference condition is expanded to an
explicit `!== null` / `=== null` (or `undefined` for the optional shape). Do **not**
write a bare `if (ref)` even though JS would treat a non-null object as truthy — the
explicit form is the house rule and keeps reference-truthiness visually distinct from
numeric truthiness (§2.5) at every site.

**`assert(x)` IS a boolean context** — the §2.5/§2.7 expansions apply inside it exactly as in
an `if`: `assert(ref)` → `assert(ref !== null)`, `assert(!ref)` → `assert(ref === null)`,
numeric per §2.5. Two files diverged on the identical D statement before this was stated.

**Iterating / measuring a POSSIBLY-NULL slice: D does not fault — never `!`.** D's `foreach`
over a null slice runs 0 iterations and `null.length` is 0. Canonical forms:
`for (const x of s ?? [])` and `(s ?? []).length` — `s!` is the wrong reflex here (it marks a
fault site D does not have). A raw `T[]` slice FIELD's element nullability follows the same
rule as the container aliases (08 §3): reference elements nullable, value elements not.

**Container slot-null tests are ordinary §2.7 tests.** The element-nullability model is
DECIDED (`08-runtime-lib.md §3`): class-element container aliases are `Array<T | null>`, so a
slot-null check is the normal explicit `if (s === null) continue;`. (Transitional note: files
written BEFORE the aliases flipped carried TWO interim shapes, both retired at the flip: the
interim TEST `if (!s)` with a slot-null comment, and the interim STORE — a faithful null
store bridged with a cast, `(x ? x.syntaxCopy() : null) as Expression`. The cast-bridged
store is the one that hides; a sweep must grep for both. Do not imitate either in new code.)

---

## 2.8 Truthiness of a D array/slice — tests the POINTER, not the length (VERIFIED)

**VERIFIED (ldc2 1.43.0-beta1 probe):** a D array/slice in a boolean context tests
**`.ptr !is null`** — the length plays no part. An **empty-but-non-null** slice
(`full[0..0]` of a non-empty array: `.ptr` non-null, `.length == 0`) is **TRUTHY**;
only the null slice is falsy. Identical for `int[]` and `string`.

| D (slice `s`) | Meaning | TS (DString / `T[] \| null` model) |
|---|---|---|
| `if (s)` | `s.ptr !is null` | `if (s !== null)` |
| `if (!s)` | `s.ptr is null` | `if (s === null)` |
| `s \|\| t` / `s && t` | ptr tests | `(s !== null) \|\| (t !== null)` etc. |

**In the port's model** a D null slice is `null` and an empty slice is a zero-length
array/`Uint8Array` (non-null) — so the D distinction survives exactly, and the test is
a null test, never a length test.

```ts
// BAD — silently diverges: an empty-but-non-null slice is TRUTHY in D
if (s.length === 0) { /* ... this is NOT D's `if (!s)` ... */ }
// GOOD — the faithful test
if (s === null) { ... }
```

Where the D code genuinely tests emptiness it spells `s.length` — translate THAT as a
length test. Never "normalize" one into the other: `if (s)` and `if (s.length)` are
different D programs (they differ on the empty-non-null slice).

**When a KEEPER's ported field has already collapsed the distinction** (a field typed
non-nullable `DString` initialized to `ds("")` where D has a nullable slice — e.g. the
globals.ts `Output` slots): the `!== null` form does not compile and the distinction is gone
UPSTREAM of your file. Emit the closest expressible test with a comment proving equivalence
on today's writers, and file a **`dependency signature` escalation** (`11-escalate.md §1`) so
the field's model gets fixed at its owner — never silently accept the collapse as the new
model.

---

## 3. `switch` statements

### 3.1 Plain `switch` — note the no-default contract

Verified (`/tmp/p_switch2.d`): in modern D a plain `switch` **without** a `default`
is a **compile error** ("`switch` statement without a `default`…"). Therefore
**every plain `switch` in the frontend already has a `default`** (or is a `final
switch`, §3.2). Translate directly:

```ts
switch (x) {
  case 1: … break;
  case 2: … break;
  default: …; break;
}
```

**Invariant:** keep the `default`. If you ever see a plain `switch` with no
`default` in the source, that is impossible under the verified rule — STOP and
escalate (you have mis-parsed, or it is a `final switch`).

### 3.2 `final switch` → `switch` + exhaustiveness + throw on unexpected

`final switch` over an enum requires that the cases cover every enum member and
forbids a `default`. Verified (`/tmp/p_finalswitch.d`): at **runtime**, a `final
switch` reached with a value matching no case throws `core.exception.SwitchError`
("No appropriate switch clause found"). The frontend relies on this as an internal
"unreachable" assertion.

**Canonical translation:** a `switch` whose `default` is the throw, plus a
TS-compile-time exhaustiveness check via `never`:

```d
// errors.d:476
final switch (info.kind)
{
    case ErrorKind.warning:  …; break;
    case ErrorKind.deprecation: …; break;
    case ErrorKind.error: …; break;
    case ErrorKind.message: …; break;
    case ErrorKind.tip: …; break;
}
```

```ts
switch (info.kind) {
  case ErrorKind.warning:     …; break;
  case ErrorKind.deprecation: …; break;
  case ErrorKind.error:       …; break;
  case ErrorKind.message:     …; break;
  case ErrorKind.tip:         …; break;
  default: {
    // final switch: D throws SwitchError on an unhandled value
    const _exhaustive: never = info.kind; void _exhaustive;   // static exhaustiveness check
    throw new SwitchError();   // D default message: "No appropriate switch clause found"
  }
}
```

> **Do not pass the `never`-typed discriminant to the constructor** — `never` is assignable
> to `string`, so `new SwitchError(_exhaustive)` compiles and silently replaces the D message
> with garbage. The `never` const is the compile-time check; the throw uses the default
> message. **Legacy note:** rung-era files used `assertUnreachable()` in `final switch`
> defaults (~10 sites: init.ts, initsem.ts, location.ts, errors.ts, …). `SwitchError` is the
> canonical form for all NEW code; the legacy sites sweep when their files are retranslated
> (keeper files: in the W0 drift pass). Do not imitate them.

**Decisions (be decisive):**
1. The added `default` is **mandatory** and **must throw** — it reproduces D's
   runtime `SwitchError`. Do NOT silently fall through (that would change behavior).
2. Use `const _exhaustive: never = <discriminant>;` in the `default` so TS flags at
   *compile time* if a case is missing — this is the static half of D's "final"
   guarantee. If TS errors here, you dropped a case: fix it, do not cast to `never`.
3. Use a `SwitchError` class (a `RuntimeError`/`Error` subclass — see §8) so the
   message/behavior is recognizable. `SwitchError` lives in the runtime lib
   (`08-runtime-lib.md`); cross-reference for its definition.

**When the discriminant is NOT a TS-`enum`-typed value** (e.g. a numeric tag), the
`never` check can't apply — then keep the throwing `default` but add a one-line
comment `// final switch: exhaustiveness not statically checkable here`.

### 3.3 `with (Enum) final switch` → qualify case labels OR `with`-alias

The frontend frequently writes `with (EnumType) final switch (x)` so the case
labels can be bare (`case enabled:` instead of `case FeatureState.enabled:`).

Real example — `errors.d:133`:

```d
with (FeatureState) final switch (featureState)
{
    case enabled:  return &error;
    case disabled: return &noop;
    case default_: return isDeprecated ? &noop : &deprecation;
}
```

**Decision:** in TS there is no `with`-over-a-type. **Re-qualify every bare case
label with its enum name** (this is the canonical translation of `with(Enum)` in a
switch context):

```ts
// resolved: with(FeatureState) -> labels re-qualified (no TS `with` over a type)
switch (featureState) {
  case FeatureState.enabled:  return error;
  case FeatureState.disabled: return noop;
  case FeatureState.default_: return isDeprecated ? noop : deprecation;
  default: { const _e: never = featureState; void _e; throw new SwitchError(); }
}
```

(General `with(obj)` over a *value* is §5 — that one aliases members, a different
rewrite.)

### 3.4 `switch` on strings → string `switch` (D byte-string ⇒ JS string here)

D allows `switch` on a string value, matching by content. Real example —
`mangle/cpp.d:1275` (over `str.peekString()`):

```d
switch (str.peekString())
{
    case "*":   symName = "de"; goto continue_template;
    case "++":  symName = "pp"; goto continue_template;
    …
    default: …
}
```

JS/TS `switch` already compares strings by value, so the shape maps 1:1 **provided
the switched value is a JS `string`**. Note: D `string` is a byte array
(`02-types.md`), so the switched expression here is whatever the runtime-lib accessor
returns. `peekString()`/`toString()`-style accessors that yield a JS `string` make
the `switch` direct:

```ts
switch (str.peekString()) {
  case "*":  symName = "de"; /* goto continue_template — see §3.6 */
  case "++": symName = "pp";
  …
  default: …
}
```

**Invariant:** the case-label literals are ASCII operator/keyword strings — direct
string equality is correct when the switched value is already a JS `string`.

**Switching on a RAW BYTE BUFFER (`switch (const(char)[] s)`) — canonical `keyOf`, not a
STOP.** When D switches a byte slice against ASCII string labels (the common shape:
`VersionCondition.isReserved`, cond.d:345, ~110 labels), translate via the injective Latin-1
key already used by the interning layer: `switch (keyOf(s)) { case "AArch64": … }` —
`keyOf` maps each byte to one BMP code unit (imphint.ts / root/stringtable.ts precedent), so
equal byte sequences ⇔ equal keys and ASCII labels can be written as plain literals. STOP
only if a case label contains non-ASCII bytes (then the label literal must be spelled as the
Latin-1 decode of those bytes — escalate to confirm) or the labels are not compile-time
literals.

### 3.5 Case ranges `case a: .. case b:` → expand or guard

D's `case a: .. case b:` matches every value in `[a, b]` inclusive. TS has no case
ranges. Real example — `lexer.d:458`:

```d
case '1': .. case '9':
    …
```

**Decision:** for a **small, contiguous** character/integer range, expand to a
labels-stack (empty cases stacking is allowed, §3.6):

```ts
case 0x31: case 0x32: case 0x33: case 0x34: case 0x35:   // '1'..'9'
case 0x36: case 0x37: case 0x38: case 0x39:
  …
  break;
```

For a **large** range (e.g. `case '‪': .. case '‮':` at `root/utf.d:135`,
or any range too wide to enumerate cleanly), do NOT spell out every value — convert
the whole `switch` arm to an `if`/range check, or hoist the range test before the
`switch`:

```ts
// root/utf.d range: too wide to enumerate -> range guard
if (c >= 0x202A && c <= 0x202E) { … }      // was: case '‪': .. case '‮':
```

**Decision rule:** ≤ ~16 contiguous values ⇒ expand to stacked `case`s; more ⇒
range `if`. Keep the original D range in a comment so it stays diffable. **Both ends
are inclusive** in D — preserve that (`>= a && <= b`), do not off-by-one.

### 3.6 Fallthrough: D forbids implicit; `goto case` / `goto default` are explicit

Verified (`/tmp/p_fallthrough.d`): **implicit fallthrough from a non-empty case is a
compile error** in D ("switch case fallthrough - use 'goto case;' if intended").
Empty cases *stack* (multiple labels for one body) and that is allowed. Verified
(`/tmp/p_goto.d`): `goto case;` jumps to the **textually next** case; `goto case
<value>;` jumps to that labeled case; `goto default;` jumps to `default`.

| D fallthrough construct | Meaning | TS translation |
|---|---|---|
| empty `case 0:` then `case 1:` | label stacking (no body between) | stack labels: `case 0: case 1:` |
| non-empty case **without** break | **impossible** (compile error in D) | n/a — never appears |
| `goto case;` | fall to the **next** case in source order | see below |
| `goto case <value>;` | jump to the `case <value>:` | see below |
| `goto default;` | jump to the `default:` arm | see below |

**`goto case;` / `goto case <value>;` / `goto default;` have no TS equivalent.**
JS `switch` *does* fall through if you omit `break`, but it cannot jump *forward*
to an arbitrary case the way `goto case <value>;` can, nor jump backward. The
canonical, deterministic translation is to **refactor the switch into labeled
extracted blocks driven by a small dispatch loop**, OR — when the jump is simply to
the immediately-following case — rely on JS fallthrough (omit `break`).

Two sub-cases, decided:

**(a) `goto case;` to the immediately next case** ⇒ just omit `break` (JS falls
through to the next case naturally). Add a comment.

```d
case 0:
case 1:
    writeln(x, ": zero-or-one");
    goto case;          // falls to case 2
case 2:
    writeln(x, ": two");
    break;
```

```ts
case 0:
case 1:
  log(x, ": zero-or-one");
  // goto case; -> fall through to next case (JS no-break fallthrough)
case 2:
  log(x, ": two");
  break;
```

**(b) `goto case <value>;` / `goto default;` to a non-adjacent arm** ⇒ JS cannot
express a forward/backward jump. **Canonical form: extract each arm's body into a
named local function (or a `while(true)` + dispatch variable) and call/`continue` to
the target.** Because this is a structural rewrite (not a 1:1 token map) and is
error-prone, treat any non-adjacent `goto case <value>;` / backward `goto` as a
**STOP-and-escalate** unless the target is the textually next arm, or a
`goto case <value>;` whose target arm is straight-line statements ending in `break` (no
`return`, `continue` or `goto`): that one lowers like `goto default;` below — the target
body becomes a local arrow, the jump site calls it then `break`s, and the target arm calls
it (dfa/fast/expression.d:631). A non-case label sitting in a switch arm (`Lexp:` after a case
list, cparse.d:318) whose body is straight-line and ends in `break` takes the same arrow form. A
`foreach` inside that body does not disqualify it, provided the body has no `return`, `continue`
or `goto`. Many frontend uses are `goto default;` from inside a case — that one is mechanical:

```d
case EXP.foo:
    if (cond) goto default;     // common pattern
    …
    break;
default:
    handleDefault();
    break;
```

Mechanical `goto default;` lowering (extract the default body):

```ts
const _default = () => { handleDefault(); };
switch (e) {
  case EXP.foo:
    if (cond) { _default(); break; }   // goto default; -> call default body, then leave
    …
    break;
  default:
    _default();
    break;
}
```

**Decision summary:**
- `goto case;` (next arm) → omit `break`, comment it.
- **`goto default;` where `default:` is TEXTUALLY NEXT** → same as (a): omit `break`, comment
  it. Plain JS no-break fallthrough reproduces D exactly here, and the closure is ceremony that
  costs the 1:1 shape (`clone.d:1224`, `expressionsem.d:5916/:5980` are all this case).
- `goto default;` to a NON-adjacent `default:` → extract the `default` body into a closure,
  call it then `break` (signal form when that arm can return — see THE TRAP below).
- `goto case <value>;` to a non-adjacent / backward arm → STOP and escalate — **unless** it is
  the §4 SHARED-ARM shape with a **TERMINAL** target: several arms jump to one arm whose body
  ends in a `return`. Then the signal closure applies, every jump site calls it and returns,
  and the site is decidable in one read (`checkAddressable`'s `goto case EXP.cast_;`,
  `expressionsem.d:17949`). A shared target that is NOT terminal still STOPs, unless the jumps
  form a web: then the CROSS-CASE DISPATCH shape below applies.
**Invariant:** never leave a JS case body without `break`/`return`/explicit
fall-through-comment — an *accidental* JS fallthrough is a silent bug, whereas D
made it a compile error. Every intentional fallthrough carries the `// goto case;`
comment so it is auditable.

**CROSS-CASE DISPATCH.** When jumps to several non-adjacent arms of one switch, plus re-dispatches of the
switch value, form a web (doc.d:4146 highlightText), wrap the switch:
`let arm = c; Ldispatch: for (;;) { switch (arm) { … } break; }`. `goto case X` is
`arm = X; continue Ldispatch;`, `goto default` uses a value no case has (`arm = -1`), and `goto Lcont` (the
label on the switch, after the arm has updated `c`) is `arm = c; continue Ldispatch;`. A jump never writes
the switched variable itself, because D's `goto case` leaves it unchanged and the target arm reads its current
value. An arm's `break` leaves the switch and then the loop, as in D.

**THE TRAP — `break; // goto default` is a lie, not a translation.** A bare `break`
with a `// goto default` comment EXITS the switch and skips the default arm's logic
entirely; the comment then *asserts a control flow the code does not implement*.
This shipped as a real divergence (found by adversarial verify in Rung 4b):
`Type.merge`'s Tsarray/Taarray/Tfunction arms all `goto default;` into a default arm
that **conditionally early-returns** (`if (type.nextOf() && !type.nextOf().deco)
return type;`, dmd/typesem.d:3555-3557) — the `break; // goto default` rendering
silently dropped that leave-unmerged check for all three arms. When the default arm
carries a conditional `return`/`continue` (not just statements), the closure must
return a **signal** the goto site acts on:

```ts
// dmd/typesem.d:3514 merge() — the default arm early-returns conditionally, so the
// shared local returns a boolean and EVERY goto site (and default: itself) tests it.
const defaultArm = (): boolean => { const n = this.nextOf(); return n !== null && !n.deco; };
switch (this.ty) {
  case TY.Tfunction:
    if (!this.nextOf()) return this;
    if (defaultArm())   // D: goto default
      return this;
    break;
  default:
    if (defaultArm())
      return this;
    break;
}
```

> Audit rule: every `// goto default` / `// goto case` comment must sit on code that
> actually REPRODUCES the jump (fallthrough, closure call, or signal test) — a comment
> narrating a jump next to a plain `break` is exactly the false-comment fabrication the
> adversarial-verify lens exists to catch.

---

## 4. `goto <label>;` (non-switch labels) → restructure, usually escalate

The frontend uses bare `goto Label;` heavily in the expression/sema code (e.g.
`expressionsem.d:2752` `goto Leprop;`, `dcast.d` `goto case Tuns8;`). These are
**not** loop labels — they are arbitrary jumps within a function (`Lagain:`,
`Lerr:`, `L1:`), typically retry/error-bail patterns.

**TS/JS has no `goto`.** There is no mechanical 1:1 token map — but there IS a fixed
vocabulary: **one named form per goto SHAPE, with one fixed spelling each**, so the same
D shape always produces the same TS and the jump stays diffable. (The first port
invented five different encodings for the same construct; that is what this table
prevents.) Classify the `goto` by shape, then emit exactly that form:

| Shape | How to recognise | Canonical form | Spelling |
|---|---|---|---|
| **RETRY** (backward) | `Lagain:` above, `goto Lagain;` below | labeled infinite loop | `Lagain: for (;;) { … continue Lagain; … break Lagain; }` |
| **BAIL** (forward, terminal tail) | `goto Lerr;` where the `Lerr:` tail only builds a result and `return`s/`throw`s | zero-param nested arrow for the tail, declared BEFORE first use | `const LerrTail = (): R => { …tail…; };` goto site: `return LerrTail();` |
| **SKIP-FLAG** (label reached by fall-through AND by goto) | most paths fall INTO the label; one or two branches jump over the middle | the §4.1 skip flag | `let gotoLdtor = false; … if (!gotoLdtor && …)` — see §4.1 |
| **SHARED-ARM** (in-switch shared target) | several `case`s jump to one shared arm (`goto default;`-like) | signal-returning closure, every jump site tests it | the `defaultArm()` form of §3.6 |
| **OPAPPLY-BAIL** | a BAIL whose `goto` sits inside a D `foreach` the port lowers to `Container.opApply` | park the tail's value in a captured slot, break the callback, act after the loop | `let bail: R \| null = null;` … `bail = …; return 1;` … `if (bail !== null) return bail;` |
| **BLOCK-EXIT** | a forward `goto` to a label at an **enclosing block boundary** that is ALSO the fall-through continuation | labeled block, exited once | `L: { … break L; … } tail` |
| **SKIP-FLAG, if/else sub-case** | the `goto` sits inside an enclosing `if` whose remaining statements are exactly what gets skipped | invert: the skipped tail becomes the `else` arm | `if (cond) { gotoL2 = true; } else { …skipped tail… }` |
| **SHARED-ARM with a VALUED tail** | a shared forward-jump target that can also be fallen INTO, whose common tail **returns a value** | `{ returned, value }` signal closure + a ran/skip guard | see below |
| **BAIL, backward** | a `goto` BACKWARD into an earlier switch arm whose labelled tail is terminal (`return`s/`throw`s) and reads only captured state | the BAIL form: one tail arrow per label, declared before the switch | `return LessThanTail();` (dfa/fast/expression.d:2178, :2189) |
| **CROSS-CASE / mixed / loop-crossing** | `goto case <v>` non-adjacent (other than §3.6(b)'s straight-line target), backward into a loop body, shapes overlapping | — | **STOP and escalate** (`11-escalate.md`) unless the CROSS-CASE DISPATCH shape of §3.6 applies |

**Rules that apply to every form:**
- **Tail extraction NEVER takes the loop-carried locals as positional parameters.** A
  nested `const` arrow declared inside the enclosing function **captures** them (zero
  params), or — when the tail must also write several of them — a single named state
  object is passed. A positional list of loop-carried locals is forbidden: it silently
  decouples the tail from the live variables and every added local churns the
  signature. (Cross-ref `04-functions.md §5` for arrow capture, and the out-param box
  for the return channel when the tail must both write locals and return.)
- Name the artifact after the D label (`LerrTail`, `gotoLdtor`), and put
  `// goto Lxxx (dmd/<file>.d:<line>)` at every jump site.
- A `goto` that does not cleanly classify is a **STOP** — non-switch `goto` is the
  single most dangerous construct in this doc: a wrong restructuring silently changes
  which code runs. Do **not** invent a state-machine rewrite under time pressure.

```d
// expressionsem.d:2012 pattern
Lagain:
    …
    if (retry) goto Lagain;
```

```ts
// goto Lagain; -> loop-back
Lagain: for (;;) {
  …
  if (retry) continue Lagain;
  break Lagain;
}
```

**The four extended shapes, spelled out** (each has one fixed spelling for the same reason the
first four do — parallel agents must converge):

- **OPAPPLY-BAIL.** When the `goto`'s enclosing D `foreach` lowers to `Container.opApply`, a
  BAIL tail's `return` inside the callback returns from the **callback**, not the function —
  the loop simply continues and the port silently diverges. Park the tail's value in a captured
  `let bail: R | null = null`, `return 1` to break the opApply, then `if (bail !== null) return
  bail;` immediately after the loop. (`ParameterList.opEquals` in `mtype.ts` already uses this
  informally.)
- **BLOCK-EXIT.** A forward `goto` to a label sitting at an enclosing block's boundary, which
  is also where the block falls through to, is `L: { … break L; … } tail` — strictly better
  than a skip flag there, because it exits once instead of gating every intervening statement
  individually. Live: three labels in one templatesem declaration (`Lmatch:` D:4998,
  `Lvarargs:` D:4858, `L1:` D:4340).
- **SKIP-FLAG, if/else sub-case.** When the `goto` sits inside an enclosing `if` whose
  remaining statements are exactly what the jump skips (`dcast.d:2513-2519`), the faithful
  rendering is `if (cond) { gotoL2 = true; } else { …skipped tail… }`, and the flag then gates
  only the statements AFTER the enclosing block. Gating inside the `if` as well would double
  the condition.
- **SHARED-ARM with a VALUED tail.** §3.6's boolean `defaultArm()` signal is not enough when
  the shared tail RETURNS A VALUE and can also be reached by falling out of the `if`/`else`
  chain (`Los:`@3609 / `Lfd:`@3729 in `resolvePropertiesX`; `L2:`@4285 / `L1:`@4356 in
  `functionParameters`). Fixed spelling: a closure returning `{ returned: boolean; value: R }`,
  every jump site doing `const r = L2(); if (r.returned) return r.value;`, plus a `ranL2` /
  `skipL2` guard so the fall-through route does not run the tail twice.

**Label naming when D gives you none.** A RETRY `goto` inside a counting `for` whose own
`continue` must keep working needs a label on the enclosing loop that D never wrote: **reuse
the D label when the goto target IS the loop's fall-through; otherwise mint a short name after
the loop variable** (`iLoop:`), so the invented name can never be confused with a D one.

**Decision:** translate a `goto <label>;` yourself only when it classifies cleanly into one of
the named shapes above and you can point at which one. Anything that does not classify — or
that classifies two ways — ⇒ escalate. Do **not** invent a state-machine rewrite under time
pressure.

### 4.1 Forward-bail sub-pattern: a label that is BOTH goto target AND fall-through continuation

The hardest (and common) shape in the big sema visit methods: a label deep inside a
500-line method that most executions reach by **falling through**, while one or two
branches `goto` it to **skip the middle**. Neither closure-extraction nor early-return
fits — the tail must stay in place, shared by both routes, and the middle must stay in
source order. Canonical worked instance: `visitVarDeclaration`'s `goto Ldtor;`
(dmd/dsymbolsem.d:2214) jumps past `isBlit = true;` **and the entire `if (dsym._init)`
init-analysis block** (2228-2530) straight to the `Ldtor:` tail (callScopeDtor +
semanticdone + endlinnum) — which every *other* path reaches by fall-through.

**Canonical form: a skip flag.**

```ts
let gotoLdtor = false;                       // models dmd:2214 `goto Ldtor;`
// ... synthesis branch:
dsym._init = new ExpInitializer(dsym.loc, e);
gotoLdtor = true;                            // goto Ldtor; — skip the init-analysis block

// every statement between the goto site and the label is GATED:
if (!gotoLdtor && dsym._init) {
    // ... the init-analysis block (would mis-typecheck the hand-painted blit if reached)
}

// Ldtor: SKIP-FLAG tail — NOT gated; the skipped route and the fall-through route both execute it:
dsym.edtor = callScopeDtor(dsym, sc);
dsym.semanticRun = PASS.semanticdone;
```

Rules: (i) **every** statement between the goto site and the label gets the `!flag`
gate — auditing the port against D is then a line-by-line walk; (ii) the tail after
the label stays **un-gated and shared**; (iii) name the flag after the D label
(`gotoLdtor`) and cite the D line where the `goto` lives. The map phase should flag
these labels explicitly: accidental fall-through *into* the skipped block is the
single likeliest fill bug for this shape (predicted and avoided in Rung 4b).

(`goto case`/`goto default` *inside a switch* are §3.6, separate from this.)

---

## 5. `with (expr)` over a *value* → local alias

`with (obj) { … }` brings `obj`'s members into scope so `member` means `obj.member`.
(`with (EnumType)` in a switch is the *type* form — §3.3, different rewrite.)

Real example — `expressionsem.d:16510` `with (_this)`, `mtype.d:929` `with (mcache)`.

**Decision:** translate `with (expr)` to an **explicit local `const` alias plus
explicit member access** — bind the expression once, then qualify each member. TS
has no `with` (it is forbidden in strict mode / ESM anyway).

```d
// mtype.d:929
with (mcache)
switch (mod)
{
    case 0:
        if (cto) assert(cto.mod == MODFlags.const_);
        if (ito) assert(ito.mod == MODFlags.immutable_);
        …
}
```

```ts
// with (mcache) -> bind once, qualify members explicitly
const _w = mcache;
switch (_w.mod) {
  case 0:
    if (_w.cto) assert(_w.cto.mod === MODFlags.const_);
    if (_w.ito) assert(_w.ito.mod === MODFlags.immutable_);
    …
}
```

**Invariants:**
- Bind `expr` to a local **once** (`const _w = expr;`) — D evaluates the `with`
  expression a single time; re-evaluating it (if it has side effects or is a
  property getter) would diverge.
- Every identifier inside the block that resolved to a member of `expr` MUST become
  `_w.member`. If an identifier is ambiguous (could be a member *or* an outer
  variable), D's lookup prefers the `with` member — **resolve it the way the local
  `ldc2` does**; if you cannot tell, STOP and escalate. Mis-resolving a name inside
  `with` is a silent semantic change.
- If `expr` is itself a struct *value* (not a pointer/class), aliasing it to `const
  _w` does NOT copy — but mutations through `_w.member = …` must follow
  `03-value-semantics.md`. Most frontend `with` targets are pointers/classes
  (reference) — confirm before assuming.

---

## 5.5 `ref const(char)*` cursor + `scope(exit)` write-back → shared cursor box

A D function that takes a pointer **by reference** — `ref const(char)* sequence` —
uses the parameter as an *in/out cursor*: it reads from where the pointer points,
advances it, and the **advance is visible to the caller**. The frontend lexer does
this with the `scope(exit) <param> = <local>;` idiom: cache the pointer in a stack
local, advance the local, and write it back to the `ref` parameter on exit.

TS has neither raw pointers nor `ref` parameters. **Canonical translation: pass a
shared *cursor box* object `{ buf: DString; p: number }` by reference (objects are
passed by reference in JS); the callee mutates `cursor.p`, and that mutation IS the
write-back the caller observes.** The `buf` field is the byte buffer the cursor walks
(`DString`, `02-types.md §11`); `p` is the current byte offset (a `number` index, the
JS stand-in for the C pointer).

### The `ref const(char)*` parameter — `dmd/lexer.d:1311,1314`

```d
// dmd/lexer.d:1311 — `ref const(char)* sequence` is an in/out cursor
private dchar escapeSequence(Loc loc, ref const(char)* sequence, bool Ccompile, out dchar c2)
{
    const(char)* p = sequence;     // cache sequence reference on stack (lexer.d:1313)
    scope(exit) sequence = p;      // lexer.d:1314 — write the advanced local back to the ref param
    …
    p++;                           // advance the LOCAL cursor
    …
}
```

```ts
// TS — `ref const(char)* sequence` -> a shared cursor box { buf, p }; the box IS the write-back.
escapeSequence(loc: Loc, sequence: { buf: DString; p: number }, Ccompile: boolean,
               c2: { value: number }): number {
  const src = sequence.buf;
  let p = sequence.p;            // local cursor (mirrors `const(char)* p = sequence;`)
  try {
    …
    p++;                         // advance the LOCAL
    …
    return c;
  } finally {
    sequence.p = p;             // scope(exit) sequence = p  -> write the local back into the box
  }
}
```

**Two shapes, decided — pick by how the body advances the cursor:**

- **Local-cursor + explicit write-back** (above, the literal `scope(exit) sequence =
  p` site): the body works on a *local* `p` for speed, so the box and the local
  diverge during the body and you MUST realize `scope(exit) sequence = p;` as a real
  `try { … } finally { sequence.p = p; }` (§7.1). Every early `return` then still
  writes back — exactly D's `scope(exit)`. **This is not a no-op:** the local must be
  flushed to the box.
- **Mutate the box directly** (when the body advances the cursor *through the box*,
  `cursor.p++`): there is no separate local to flush, so the `scope(exit) sequence =
  p;` write-back **is a literal no-op** — the shared object already carries every
  advance. Drop it (leave a one-line comment noting the box *is* the write-back).

**Caller side** — bind the box, call, then read `cursor.p` back into the lexer's own
position (the 0-arg `escapeSequenceCurrent` wrapper at `lexer.ts`):

```ts
const seq = { buf: this.buf, p: this.p };
const r = this.escapeSequence(this.token.loc, seq, this.Ccompile, c2);
this.p = seq.p;                 // ref const(char)* sequence -> read the advanced cursor back
```

**Invariants:**
- The box is **passed by reference** — do NOT spread/clone it at the call site (a copy
  loses the write-back). One box object, mutated in place.
- `p` is a `number` byte offset, not a pointer; pointer arithmetic `p++`/`p += n`
  becomes index arithmetic on the same offset. An out-of-range read must yield `0` (a NUL,
  `02-types.md §11`): the lexer relies on the trailing-NUL sentinel. A `Uint8Array` read past
  its length is `undefined`, not 0. The lexer gets 0 through `byteAt`, and every C-string walker
  needs such a reader (doc.ts `at`); do not bounds-guard at each read site. Where D's pointer walks
  past the end of a SLICE into the bytes that follow it in the same allocation (doc.d:866), the
  cursor's buffer is the rest of the backing store, `new Uint8Array(s.buffer, s.byteOffset)`
  (doc.ts `storeOf`), not the slice.
- If the D body has *other* `scope(...)` guards alongside the write-back, fold them
  into the §7.2 LIFO stack — the cursor write-back is just one `scope(exit)` among them.

### `utf_decodeChar` — the in/out `ref` cursor at a 1:1 call site (`dmd/lexer.d:3362`)

The same `ref` in/out shape appears as D's `utf_decodeChar(const(char)[] s, ref size_t
idx, out dchar c)` — `idx` is read, advanced, and written back; `c` is an out-param;
the **return value is the error string (`null` ⇒ success)**. The djs runtime
(`dmd/root/utf.ts`) replaces all three D out-channels with **one return object**
`DecodeResult { nextIdx: number; dchar: number; error: DString | null }` — `nextIdx`
is the post-call cursor (D's written-back `idx`), `dchar` is the decoded point (D's
`out c`), `error` is `null` on success (D's `null` return) else the exact message bytes.

```d
// dmd/lexer.d:3360-3363 — idx is in/out (ref), u is out, the return is the error msg
size_t idx = 0;
dchar u;
msg = utf_decodeChar(s[0 .. len], idx, u);   // idx advanced in place; u set; msg = error|null
p += idx - 1;                                // consume what was decoded (minus the pre-read lead)
```

```ts
// TS — the three D out-channels collapse into one DecodeResult; read its fields 1:1.
const r = utf_decodeChar(this.buf.subarray(s, s + len), 0);   // idx starts at 0
const u = r.dchar;                 // out dchar u
let msg: DString | null = r.error; // string return: null == success (D's `is null`)
this.p += r.nextIdx - 1;           // idx (ref, written back) -> r.nextIdx; same `- 1`
```

**Decision (be decisive):** never try to emulate D's `ref size_t idx` with a one-field
box for `utf_decodeChar` — the runtime already returns `nextIdx`. The 1:1 adaptation is
purely mechanical: `idx` (the written-back `ref`) ⇒ `r.nextIdx`, `u` (the `out`) ⇒
`r.dchar`, the error-string return ⇒ `r.error` (`null` ⇒ success, mirroring D's `is
null`). Preserve any surrounding arithmetic on the cursor verbatim — the `p += idx - 1`
above becomes `this.p += r.nextIdx - 1`, same constant, same direction.

**Invariants:**
- `error === null` is **success** (it mirrors D's `msg is null`), `error !== null` is
  the failure path — do not invert it. On error the runtime still sets `nextIdx =
  startIdx + 1` and `dchar` = the raw lead unit (verified, `dmd/root/utf.ts` header);
  the post-decode arithmetic must run on those values exactly as D runs it on the
  written-back `idx`/`u`.
- `utf_decodeChar` is owned by `02-types.md` / `08-runtime-lib.md`; this doc only fixes
  the **call-site** adaptation of the D `ref idx`/`out c`/error-return triple into the
  one-object return. Cross-reference for the runtime's contract; do not re-derive it.

---

## 6. Labeled `break` / `continue` → TS labeled loops

D supports `break Label;` / `continue Label;` to target an enclosing labeled loop.
TS has the **same feature** — this is a direct 1:1 map.

Real examples — `semantic3.d:1894` `break LcheckAncestorsOfANestedRef;`,
`dsymbolsem.d:4627` `continue BCLoop;`, `parse.d:5814` `break Lwhile;`.

```d
// dsymbolsem.d:4627 pattern
BCLoop:
foreach (b; baseclasses)
{
    foreach (m; b.members)
    {
        if (cond)
            continue BCLoop;     // continue the OUTER loop
    }
}
```

```ts
// TS — labeled loop, direct map
BCLoop:
for (const b of baseclasses) {
  for (const m of b.members) {
    if (cond) continue BCLoop;
  }
}
```

| D | TS |
|---|---|
| `break Label;` | `break Label;` |
| `continue Label;` | `continue Label;` |

**Invariants:**
- The TS label MUST sit immediately before the loop statement it names (TS syntax
  rule). Preserve the D label name verbatim (subject only to JS-reserved-word
  escaping, `01-conventions.md`).
- A labeled `break`/`continue` only works with a real loop — **never** translate the
  loop it targets to `Array.prototype.forEach`/`.map` (those swallow labels and
  break/continue/return). This is a hard reason `for…of` is the canonical loop (§1.1).
- If the label targets a `foreach` you translated to an **`opApply` callback** (§1.8),
  a `break Label;`/`continue Label;` crossing that callback boundary cannot use a JS
  label (the callback is a function boundary). STOP and escalate — this needs the
  `opApply` `int`-return protocol extended across levels.

---

## 7. `scope(exit | success | failure)` → `try`/`finally`/`catch`

D scope guards register cleanup that runs at scope exit. Ordering is **LIFO across
all guard kinds**, verified in `_probes.md §9` (do not re-derive):

- **normal exit:** `scope(exit)` + `scope(success)` fire, LIFO;
- **exception exit:** `scope(exit)` + `scope(failure)` fire, LIFO;
- the *kind* decides *whether* a guard fires, not its *position* — position is
  strictly reverse-registration order across all kinds.

### 7.1 Single guard — the simple cases

Real example — `mtype.d:2993`:

```d
extern (D) final void check()
{
    inuse++;
    scope(exit) inuse = false;
    …body…
}
```

```ts
// scope(exit) -> finally
check(): void {
  this.inuse++;
  try {
    …body…
  } finally {
    this.inuse = false;        // scope(exit): always runs
  }
}
```

| D single guard | TS |
|---|---|
| `scope(exit) C;` | `try { rest } finally { C }` |
| `scope(success) C;` | `let _ok=false; try { rest; _ok=true } finally { if(_ok){ C } }` |
| `scope(failure) C;` | `try { rest } catch(e){ C; throw e }` |

For `scope(success)`/`scope(failure)` the body of the guard runs only on the matching
path. `scope(failure)` re-throws after running its cleanup (D propagates the
exception). Real `scope(failure)` use — `clone.d:1311` (postblit cleanup).

### 7.2 Multiple guards — the canonical LIFO-stack translation

When more than one guard is in the same scope (any mix of kinds), do **not** nest
N `try`/`finally` blocks by hand — that is error-prone and obscures LIFO. **Canonical
form: a single LIFO stack of `{kind, fn}` cleanups in one `try`/`catch`/`finally`.**

```d
// general multi-guard scope (mirrors _probes.md §9)
scope(exit)    A();
scope(success) B();
scope(failure) C();
scope(exit)    D();
…body…
```

```ts
// canonical: one LIFO stack, drained in finally; kind gates whether each runs
const _guards: Array<{ kind: "exit" | "success" | "failure"; fn: () => void }> = [];
let _failed = false;
try {
  _guards.push({ kind: "exit",    fn: () => A() });   // registration order
  _guards.push({ kind: "success", fn: () => B() });
  _guards.push({ kind: "failure", fn: () => C() });
  _guards.push({ kind: "exit",    fn: () => D() });
  …body…
} catch (e) {
  _failed = true;
  throw e;                       // re-throw after finally drains the stack
} finally {
  for (let i = _guards.length - 1; i >= 0; i--) {     // LIFO
    const g = _guards[i];
    if (g.kind === "exit") g.fn();
    else if (g.kind === "success" && !_failed) g.fn();
    else if (g.kind === "failure" && _failed) g.fn();
  }
}
```

**Decisions / invariants (LIFO is exact, do not group by kind):**
- Drain the stack **last-registered-first** (the descending `for`). This is the
  whole point — `_probes.md §9` shows interleaved kinds firing in pure registration
  order.
- A guard registered *conditionally* (inside an `if`) must `push` only when the D
  `scope(...)` would have been reached — preserve the registration point.
- `scope(exit)` always runs; `scope(success)` only if `!_failed`; `scope(failure)`
  only if `_failed`. The `_failed` flag is set in `catch` **before** re-throwing so
  the `finally` sees it.
- The exception is re-thrown from `catch` so it still propagates after cleanup — do
  NOT swallow it. (If the original D had no surrounding handler, the rethrow is
  exactly D's behavior.)
- **A single guard** uses the §7.1 simple form — only reach for the stack when ≥2
  guards (or a guard registered in a loop) make LIFO non-trivial.

**Static guards (the common frontend case):** most frontend scope guards are a
single `scope(exit) x = y;` resetting a flag (`mtype.d:2993`, `dinterpret.d:106`
`scope(exit) timeTraceEndEvent(...)`, `pragmasem.d:65`). For those, the §7.1
`try`/`finally` is enough — do not over-engineer with the stack.

---

## 8. `try` / `catch` / `finally` / `throw` and the exception hierarchy

### 8.1 Statement forms — direct map

Real example — `root/optional.d:27`:

```d
try
    cast(void) opt.get();
catch (AssertError)
    caught = true;
```

```ts
try {
  void opt.get();
} catch (e) {
  if (!(e instanceof AssertError)) throw e;   // typed catch -> instanceof + rethrow
  caught = true;
}
```

D allows brace-less single-statement `try`/`catch` bodies; TS requires braces — add
them. `finally` maps directly:

```d
try { body } finally { cleanup }      // statementsem.d:3164 pattern
```

```ts
try { body } finally { cleanup }
```

### 8.2 Typed `catch` → `instanceof` discrimination + rethrow

JS `catch` is **untyped** (one binding catches everything). D's `catch (T e)` catches
only `T` (and subclasses) and lets others propagate. **Canonical translation: a
single `catch (e)` that `instanceof`-tests and re-throws non-matches.**

```d
// multiple typed catches (D)
try { … }
catch (AssertError e) { handleAssert(e); }
catch (Exception e)   { handleExc(e); }
```

```ts
try { … }
catch (e) {
  if (e instanceof AssertError) { handleAssert(e); }
  else if (e instanceof DException) { handleExc(e); }   // Exception -> DException, see 8.3
  else throw e;                                          // unmatched: propagate (D semantics)
}
```

**Invariant:** the trailing `else throw e;` is **mandatory** — without it you would
swallow exceptions D lets propagate. Order the `instanceof` checks most-derived
first (same as D's catch order), so a base-class catch does not shadow a derived one.

### 8.3 `throw` and the `Throwable` / `Exception` / `Error` hierarchy

D's hierarchy: `Throwable` is the root; `Exception` (recoverable) and `Error`
(unrecoverable, e.g. `AssertError`, `RangeError`, `SwitchError`) both derive from it.
Real `throw` site — `funcsem.d:122` (`throw __o;`), `expressionsem.d:5931`.

**Decision — canonical name mapping** (avoid clashing with JS built-in `Error`):

| D type | TS class | Notes |
|---|---|---|
| `Throwable` | `DThrowable extends Error` | root; `extends` the JS `Error` so stacks work |
| `Exception` | `DException extends DThrowable` | recoverable |
| `Error` (D) | `DError extends DThrowable` | **NOT** the JS `Error` — rename to avoid collision |
| `AssertError` | `AssertError extends DError` | thrown by `assert` helper (`09-numerics.md`) |
| `SwitchError` | `SwitchError extends DError` | thrown by `final switch` default (§3.2) |

```d
throw new Exception("msg");
throw __o;                       // rethrow a caught Throwable
```

```ts
throw new DException("msg");
throw __o;                       // rethrow: identical
```

**Invariants:**
- D's `Error` becomes **`DError`**, never the JS global `Error`. The JS `Error` is
  used only as the *base* of `DThrowable` (for stack traces). Confusing the two
  silently changes which `catch (Error)` arms fire.
- `throw` of a non-`Throwable` value cannot happen in the frontend (D forbids it);
  if you see it, STOP and escalate.
- The concrete exception *classes* and the `assert` helper that throws `AssertError`
  are defined in the runtime lib (`08-runtime-lib.md`) / numerics doc
  (`09-numerics.md`, `assert`). This doc only mandates the *hierarchy mapping* and
  the catch/throw translation; cross-reference for the class definitions. Do not
  duplicate them.

### 8.4 `finally` interaction with `return`/`throw`

D `finally` runs even when the `try` body `return`s or `throw`s — JS `finally` has
identical semantics, so this maps directly. The one trap (shared with JS): a
`return`/`throw` **inside** the `finally` overrides the one in flight. The frontend's
generated `try { body } finally { cleanup }` cleanups do not return — preserve that;
never add a `return` inside a translated `finally`.

---

## 9. Quick lookup table

| D construct | Canonical TS | Section |
|---|---|---|
| `foreach (x; arr)` | `for (const x of arr) {}` | §1.1 |
| `foreach (i, x; arr)` | `for (const [i, x] of arr.entries()) {}` | §1.2 |
| `foreach (i; lo..hi)` | `for (let i=lo; i<hi; i++) {}` (bound captured once) | §1.3 |
| `foreach (char c; s)` | `for (const c of byteBuf) {}` (bytes) | §1.4 |
| `foreach (dchar c; s)` | `for (const dc of utf8Decode(s)) {}` | §1.4 |
| `foreach (e; range)` | `for (let r=range; !r.empty; r.popFront()) { const e=r.front; }` | §1.7 |
| `foreach (…; opApplyObj)` | `obj.opApply((…) => { …; return 0/1; })` (0=cont,≠0=break) | §1.8 |
| `foreach (e; arrayValue)` (`Array!T` value) | `for (const e of arrayValue) {}` (`[Symbol.iterator]`) | §1.9 |
| `foreach_reverse (i,x; a)` | descending counter `for`; `i`=orig position | §2 |
| `if (x)` / `!x` (numeric) | `if (x !== 0)` / `x === 0` (`0n` for bigint) | §2.5 |
| `if (T v = expr())` (decl in cond) | `const v = expr(); if (v !== null) {}` (chain → nest into `else`) | §2.6 |
| `if (ref)` / `!ref` (nullable ref) | `if (ref !== null)` / `ref === null` | §2.7 |
| plain `switch` | `switch` with `default` (always present in source) | §3.1 |
| `final switch` | `switch` + `default:{ const _e:never=…; throw new SwitchError }` | §3.2 |
| `with (Enum) switch` | re-qualify case labels with `Enum.` | §3.3 |
| `switch ("str")` | `switch` on JS string (if accessor yields a string) | §3.4 |
| `case a: .. case b:` | stacked cases (small) or range `if` (large); inclusive | §3.5 |
| implicit fallthrough | impossible in D (compile error) | §3.6 |
| `goto case;` (next) | omit `break`, `// goto case;` comment | §3.6 |
| `goto default;` | extract default body to closure; call then `break` | §3.6 |
| `goto case <v>;` non-adjacent | **STOP/escalate** | §3.6 |
| `goto Label;` (non-switch) | loop-back `while(true)` or early-return; else **escalate** | §4 |
| `with (value)` | `const _w = value;` + explicit `_w.member` | §5 |
| `ref const(char)*` cursor + `scope(exit) ref=p` | shared box `{ buf, p }`; `finally{ box.p=p }` write-back | §5.5 |
| `utf_decodeChar(s, ref idx, out u)` | `idx=r.nextIdx; u=r.dchar; msg=r.error` (`error===null`=success) | §5.5 |
| `break Label;` / `continue Label;` | same in TS (no `forEach`!) | §6 |
| `scope(exit) C;` (single) | `try{…} finally{C}` | §7.1 |
| multiple `scope(...)` | one LIFO `_guards` stack drained in `finally` | §7.2 |
| `try`/`catch (T e)`/`finally` | `try`/`catch(e){ instanceof + rethrow }`/`finally` | §8 |
| `throw new Exception(…)` | `throw new DException(…)` | §8.3 |
| D `Error` | `DError` (NOT JS `Error`) | §8.3 |

---

## 10. Cross-references

- `opApply` *method definition* + delegate typedefs → `05-operators.md`.
- Numeric domain of loop counters/ranges (`number` vs BigInt) → `09-numerics.md`.
- D `string` as byte buffer; `utf8Decode`; `char`/`dchar` → `02-types.md`, `_probes.md §5`.
- `Array!T` container + its iterator/`asRange` → `08-runtime-lib.md`.
- Exception classes (`DThrowable`/`DException`/`DError`/`AssertError`/`SwitchError`)
  and the `assert` helper → `08-runtime-lib.md`, `09-numerics.md`.
- Struct value-copy inside `foreach`/`with` → `03-value-semantics.md`, `_probes.md §1`.
- `ref const(char)*` cursor box `{ buf, p }`, the `DString` byte buffer, the
  trailing-NUL sentinel for out-of-range reads → `02-types.md §11` (§5.5 here).
- `utf_decodeChar` runtime contract + `DecodeResult { nextIdx, dchar, error }`
  (the `ref idx`/`out c`/error-string-return collapse) → `02-types.md`,
  `08-runtime-lib.md` (§5.5 adapts only its call site).
- JS-reserved-word label escaping → `01-conventions.md`.
- Any uncovered/ambiguous construct → `11-escalate.md`.
