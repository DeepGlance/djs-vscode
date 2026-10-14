# 03 — Value Semantics (struct copy-on-assign)

> **STOP rule:** if you meet a construct not covered here, or any ambiguity about
> *when* a copy happens, **stop and escalate** (see `11-escalate.md`). Never guess.
> A silent aliasing bug in a compiler is worse than a halt.

This is the **most error-prone document** in the guide. Read it before translating
any file that declares or stores a `struct`.

The verified copy-timing facts this doc builds on are in `_probes.md` §1 (struct
assignment, by-value param, array-element read, postblit) and were re-confirmed
with the local `ldc2` for nested fields, return-by-value, `out` params,
`foreach`/`foreach(ref)`, class-field store/read, custom `opAssign`, and
address-of. Every rule below is grounded in a real frontend usage.

---

## 0. The one invariant (memorize this)

**In D, a `struct` is a value type and a `class` is a reference type. In JS/TS,
*every* object is a reference. So the naive translation `let b = a;` of a struct
assignment is a BUG: it aliases where D copies.**

| D kind | D semantics | TS backing | Copy on assign? |
|---|---|---|---|
| `struct` | **value** | `class` instance (mutable object) | **YES — you must emit `.copy()`** |
| `class` | reference | `class` instance | NO — share the reference (matches JS) |
| `enum` (named) | value (an int) | number / TS enum | trivial value move (see `_probes.md` §7) |
| primitive (`int`, `bool`, `dchar`, `real`) | value | `number`/`boolean`/BigInt | trivial value move |

D `struct` is the only hard case. Classes already match JS; primitives already
match JS. **The entire job of this doc is: emit a copy at every point where D
copies a struct, and nowhere else.**

A copy is silent if you forget it. There is no compiler error — the port just
produces wrong results when the source struct is later mutated. Treat a missing
`.copy()` as a defect of the same severity as a missing `await`.

---

## 1. Where D copies a struct (the six copy points)

D copies a struct value at exactly these points. Each one maps to an emitted
`.copy()` in TS. (Verified — `_probes.md` §1 plus the nested/return/out/foreach
probes in this doc.)

| # | D copy point | Example | TS must emit |
|---|---|---|---|
| 1 | **Assignment** `b = a` | `Outer b = a;` | `const b = a.copy();` |
| 2 | **Pass by value** (plain param) | `f(s)` where `f(S s)` | copy at the **call site** — `f(s.copy())` |
| 3 | **Return by value** | `return s;` | `return s.copy();` (see §3.3 for elision) |
| 4 | **Read array elem into a var** | `S v = arr[0];` | `const v = arr[0].copy();` |
| 5 | **Store into class field / array elem** | `h.slot = s;` | `h.slot = s.copy();` |
| 6 | **Read class field / array elem into var** | `S v = h.slot;` | `const v = h.slot.copy();` |

And the points where D does **NOT** copy (do **not** emit `.copy()`):

| D non-copy point | Example | TS |
|---|---|---|
| Plain construction | `S s = S(1);` / `Outer(Inner(5), 1)` | `new Outer(new Inner(5), 1)` — fresh object, no copy |
| `ref`/`out`/`scope ref` parameter | `void f(ref S s)` | pass the object directly (it IS an alias — §2) |
| `foreach (ref x; arr)` | mutates elements in place | iterate by reference (§4) |
| Index-assign through lvalue | `arr[0].x = 777;` | `arr[0].x = 777;` (lvalue write, in place — §4) |
| Method call on a struct var | `s.foo()` | `s.foo()` — `this` is the same object |
| Taking `&s` | `S* p = &s;` | the box/ref-cell pattern (§7) — alias, not copy |

> **Why call-site copy for pass-by-value (#2), not inside the callee?**
> D copies the argument *before* entering the function. If the callee mutates its
> parameter, the caller must not see it. Copying at the call site (`f(s.copy())`)
> is the faithful model and keeps the callee body identical to D. Do NOT copy
> inside the callee — a `ref` param would then be wrongly copied too.

---

## 1.1 In-place value-overwrite (memcpy onto an existing inline struct) — copy fields INTO, do NOT reassign (CANONICAL HOME)

There is a copy operation that is **NOT** any of §1's six points and is **NOT**
`.copy()`: D code that **overwrites the contents of an existing inline value struct**
while preserving that struct's storage identity. The canonical form is a `memcpy`
(or a field-by-field overwrite, or `*dst = src;` through a pointer) that writes *into*
a struct that **external references already alias**. The struct's *address* does not
change — only its *contents* do — so every existing alias observes the new value.

This is the **opposite** of `.copy()`. `.copy()` produces a **new** object (a fresh
identity); the in-place overwrite mutates the **same** object (preserved identity).
Translating one as the other is a silent bug:

- Using `.copy()` (reassign the reference) where D did an in-place overwrite **drops
  the external aliases**: they keep seeing the old object, never the new contents.
- Using an in-place overwrite where D copied **wrongly couples** two values that D
  kept independent.

```d
// D — overwrite the CONTENTS of an existing inline struct. `*dst` is an lvalue that
//     other code already holds the address of; memcpy/assignment writes THROUGH it.
//     Shape modeled on frontend in-place value updates (e.g. token/state overwrite).
void overwriteInPlace(S* dst, ref const S src)
{
    *dst = src;                  // overwrites dst's CONTENTS; dst's address unchanged
    // equivalently in lower-level code:  memcpy(dst, &src, S.sizeof);
    // every pointer that aliased dst now observes src's field values.
}

S target;
S* alias1 = &target;             // external reference to the SAME storage
overwriteInPlace(&target, source);
// alias1 now sees source's values — because target's identity was preserved.
```
```ts
// TS — copy source's fields INTO the existing object. Do NOT reassign the reference:
// that would create a new object and orphan alias1. Use field-by-field assignment
// (or Object.assign for a flat struct); recurse with .copy() into nested value-struct
// fields exactly as §2 does, so the overwrite is a true value-overwrite.
function overwriteInPlace(dst: S, src: S): void {
  // copy INTO dst — dst's identity (the object alias1 holds) is preserved.
  dst.tag = src.tag;                 // primitive: value copy
  dst.inner = src.inner.copy();      // nested value struct: recurse (§2)
  dst.ref = src.ref;                 // class reference: share (§2)
  // OR, for a flat all-primitive struct:  Object.assign(dst, src);  // see note below
}

const target = new S();
const alias1 = target;               // external reference to the SAME object
overwriteInPlace(target, source);
// alias1 now sees source's values — target's object identity was preserved.
```

Rules:
- **Detect the intent: identity-preserving overwrite vs. fresh copy.** If the D code
  writes *through* an existing lvalue/pointer (`*dst = src;`, `memcpy(dst, &src, ...)`,
  `dst = src;` where `dst` is an already-aliased inline field) and **other references
  hold that same storage**, it is an in-place overwrite — copy fields INTO the existing
  object. If the D code introduces a **new** variable/slot (`S b = a;`, store into a
  field/element per §1 #5), it is `.copy()` — a fresh object. The discriminator is
  *whether existing external aliases must observe the new value*.
- **Copy fields INTO the existing object** — field-by-field, applying the per-field
  rules of §2 (primitive: value; nested value struct: `.copy()`; class ref: share;
  function-pointer: share, §2.1). **Do NOT reassign the reference** (`dst = src.copy()`)
  — that allocates a new object and breaks every alias of `dst`.
- **`Object.assign(dst, src)` is acceptable ONLY for a flat all-primitive struct** (no
  nested value-struct fields). The moment a field is a nested value struct,
  `Object.assign` would *share* that nested object (shallow) where D's memcpy copied its
  bytes — emit explicit `dst.f = src.f.copy()` for those fields instead. For class-ref /
  function-pointer fields, `Object.assign`'s shallow share is correct (matches §2).
- This operation has no `copy()` method form — it is a **mutating procedure** on an
  existing object. Name it for its intent at the call site (e.g. `overwriteInto(dst, src)`)
  rather than reusing `copy()`.

> Invariant: after an in-place overwrite, `dst` is the **same object** it was before
> (`Object.is(dst, before) === true`), but its fields now equal `src`'s (by the §2
> value rules). Every reference that aliased `dst` observes the new contents. Contrast
> `.copy()`, whose result is a **new** object that no prior alias can observe. Choosing
> the wrong one is a silent aliasing defect — when unsure which D intended, check
> whether any live reference must see the write; if yes, overwrite in place.

---

## 2. The `.copy()` convention (the contract every value-struct must satisfy)

Every TS class that backs a D `struct` MUST provide a `copy(): this`-typed method.

**`.copy()` is a per-field shallow copy that recurses into nested value-struct
fields and shares class references.** Precisely:

- **Primitive field** (`number`, `boolean`, `bigint`, `string`-as-bytes): copy the
  value (trivial).
- **Nested value-struct field** (another `struct`): call its `.copy()` **recursively**.
  Verified: mutating `a.inner.n` after `b = a` leaves `b.inner.n` untouched
  (`/tmp/vsem.d` case A → `a.inner.n=999 b.inner.n=10`).
- **Class-reference field** (a D `class`): copy the **reference** (share it). D's
  struct copy is shallow w.r.t. class members — the pointer is duplicated, the
  pointee is shared. This matches JS reference assignment.
- **Array field** (`T[]` slice / `Array!T`): D slice copy shares the backing store
  (it copies ptr+length, not elements). See `08-runtime-lib.md` for slice/`Array!T`
  copy semantics — **do not deep-copy arrays here** unless the element type is a
  value struct held *by value inline*, which `Array!T` is (see §6 + `08`).
- **Function-pointer / delegate field** (a `T function(...)` / `T delegate(...)`
  field): **share the function reference** (copy the reference, like a class ref).
  D's struct copy duplicates the function-pointer *value* — both copies invoke the
  same function. In TS the field holds a function object/closure; `.copy()` assigns
  the reference verbatim (`c.fp = this.fp;`) — never wrap, clone, or re-bind it.
  See §2.1 for the full rationale.

**When the D constructor DERIVES an expensive cached field, `.copy()` bypasses the
constructor.** The contract above is field-wise; building the copy with `new` is an
implementation choice, and it is the wrong one when the ctor computes a value the copy then
overwrites on the next line. `TemplateInstanceBox` (`templatesem.d:669`) caches a recursive
`arrayObjectHash(ti.tdtypes)` in its ctor and sits on the hot path of the instance cache.
Sanctioned spelling — prototype preserved, constructor skipped, every field assigned
explicitly under the rules above:

```ts
copy(): this {
  // ctor bypassed: TemplateInstanceBox's ctor re-derives `hash` (arrayObjectHash), which this copy overwrites
  const c = Object.create(Object.getPrototypeOf(this)) as this;
  c.ti = this.ti;        // class ref — shared
  c.hash = this.hash;    // the cached value, copied not re-derived
  return c;
}
```

The comment naming the ctor-derived field is mandatory: without it the bypass reads as a
shortcut. Assign every field explicitly (nested value structs still `.copy()`) — a blanket
`Object.assign` hides the per-field decisions this section exists to make.

### 2.1 Function-pointer field in a value struct → `.copy()` shares the reference (CANONICAL HOME)

A value struct may carry a **function pointer** (`T function(Args)`) or **delegate**
(`T delegate(Args)`) field — a callback, a comparator, a visitor hook. In D this is a
value the same way a class reference is: the struct copy duplicates the *pointer*, not
the *function body*. After a struct copy, both the source and the destination field
point at the **same** function; calling either invokes the identical code.

The TS analogue is exact: a function in JS/TS is a reference to a callable object. The
`.copy()` rule is therefore the **class-reference rule** (§2 "Class-reference field"):
copy the reference, share the callee.

```d
// D — a value struct with a comparator function-pointer field.
//     Shape modeled on frontend callback-bearing structs (e.g. sort/visitor hooks).
struct Comparer
{
    int function(const void*, const void*) cmp;   // function pointer (value)
    int threshold;
}
Comparer a;
a.cmp = &byLength;
Comparer b = a;          // struct copy: b.cmp duplicates the POINTER -> same function
// b.cmp and a.cmp now invoke the identical &byLength
```
```ts
// TS — copy() SHARES the function reference, exactly like a class ref. Never clone,
// wrap, or re-bind the function: the two structs must call the same callable.
class Comparer {
  cmp!: (a: Uint8Array, b: Uint8Array) => number;   // function reference (shared)
  threshold = 0;
  copy(): Comparer {
    const c = new Comparer();
    c.cmp = this.cmp;            // SHARE the function reference (class-ref rule §2)
    c.threshold = this.threshold;
    return c;
  }
}
```

Rules:
- A function-pointer / delegate field copies as a **shared reference**, identical to a
  class-reference field (§2). Emit `c.fp = this.fp;` — a plain reference assignment.
- **Never** deep-copy, wrap, or re-bind a function field in `.copy()`. There is no
  faithful "copy of a function" — D shares the pointer, so TS shares the reference.
- A **delegate** (`T delegate(...)`, a function + captured context) is *also* a single
  shared reference in TS: a closure already binds its captured environment, so sharing
  the closure reference reproduces D's "pointer + context" pair. Do not attempt to copy
  the captured context separately.
- This is the value-semantics rule only. How a function-pointer *type* maps to a TS
  function type (signature, `extern(C)` ABI erasure) is owned by `02-types.md`; how a
  `&freeFunction` / `&method` *expression* translates is owned by `04-functions.md`.

> Invariant: after `b = a.copy()`, `b.fp === a.fp` (same callable). Mutating *which*
> function a field points at on one copy does not affect the other (it is a value field
> like any other); but while both point at the same function, invoking either runs the
> same code. This matches D exactly.

### Canonical form

```ts
// D: struct Loc { uint index = 0; }                         dmd/location.d:34
class Loc {
  index: number = 0;
  copy(): Loc {
    const c = new Loc();
    c.index = this.index;          // primitive: value copy
    return c;
  }
}
```

```ts
// D: struct Outer { Inner inner; int tag; }   (Inner is a value struct)
class Outer {
  inner: Inner;
  tag: number;
  constructor(inner: Inner, tag: number) { this.inner = inner; this.tag = tag; }
  copy(): Outer {
    const c = new Outer(this.inner.copy(), this.tag);   // recurse into nested struct
    return c;
  }
}
```

```ts
// D: struct Expression-holder { Loc loc; Type type; ... }    Type is a CLASS
class Foo {
  loc: Loc;        // value struct  -> recurse
  type: Type;      // class ref     -> share
  copy(): Foo {
    const c = new Foo();
    c.loc = this.loc.copy();   // nested value struct: deep
    c.type = this.type;        // class reference: shared (matches D)
    return c;
  }
}
```

> **Naming is fixed: the method is always `copy()`.** D's own `UnionExp.copy()`
> (`dmd/ctfeexpr.d:64`) means a different thing (materialize the union into a heap
> `Expression`) — that is a domain method, not the value-copy helper. For value
> structs whose D name collides with our `copy()` (rare), escalate (`11-escalate.md`)
> rather than overloading the name silently.

### Invariant the agent must preserve

> After `b = a.copy()`, mutating any field of `a` (or any nested value-struct field
> of `a`) MUST NOT change `b`, and vice versa. Mutating a *class object* reachable
> from both DOES affect both — that is correct (D shares class refs too).

---

## 2b. `copy()` of a generic field (CANONICAL HOME)

A field typed as a **type parameter `T`** has *unknown kind* at the template
definition site. The per-field copy rule of §2 is decided **by kind** — primitive
`T` → value copy, struct `T` → `.copy()`, class `T` → share the reference — so a
**single generic body cannot write a correct per-field copy** the way §2's
canonical form does. You do not know, looking at the template alone, which of the
three branches applies; emitting any one of them unconditionally is a silent bug
for the other two.

```d
// D — generic container holding a T BY VALUE (e.g. Optional!T's `T value;`)
struct Holder(T)
{
    T value;        // kind of T is unknown HERE
    // a hand-written copy would have to do ONE of:
    //   primitive T : c.value = this.value;        (value copy)
    //   struct T    : c.value = this.value.copy();  (recurse)
    //   class T     : c.value = this.value;          (share the reference)
}
```
```ts
// AFTER — you cannot pick a branch generically. RESOLVE by instantiation set:
// 1. grep the template's instantiations -> if T is ALWAYS primitive, value copy
//    is correct; emit it with the monomorphize comment.
class Holder<T> {
  value!: T;
  copy(): Holder<T> {
    const c = new Holder<T>();
    c.value = this.value;          // primitive-T only (instantiations verified)
    return c;
  }
}
```

**Resolution order — same monomorphize-or-escalate discipline as
`05-operators.md` "Operators on a generic type parameter":**

1. **Primitive-only instantiations.** Grep the template's instantiations (e.g.
   `grep -rn 'Optional!' dmd/`); if every `T` is a primitive (`int`, `bool`,
   `dchar`, an enum, …), a **shallow value copy** is correct. Emit it and annotate
   `// primitive-T only` so the assumption is auditable. If a later instantiation
   adds a non-primitive `T`, the comment flags the spot to revisit.
2. **Struct `T`.** If `T` is always a value struct, recurse via the field's
   `.copy()`: `c.value = this.value.copy();`.
3. **Class `T`.** If `T` is always a class reference, **share** it:
   `c.value = this.value;` (matches D — struct copy is shallow over class members).
4. **Mixed or unknown `T`.** If instantiations span more than one kind (some
   primitive, some struct, some class), a single body is wrong for at least one.
   Either **parameterize the copy** with a per-`T` copy function supplied by the
   caller —
   ```ts
   class Holder<T> {
     value!: T;
     copy(copyT: (v: T) => T): Holder<T> {   // caller supplies the per-T copy
       const c = new Holder<T>();
       c.value = copyT(this.value);
       return c;
     }
   }
   ```
   — **or STOP and escalate** (`11-escalate.md`) if the call sites can't cleanly
   supply one. Do **not** guess a single branch.

> Invariant: a generic `copy()` is only correct when the *kind* of every `T` it is
> instantiated with is known and uniform. If you cannot prove uniformity from the
> instantiation set, the per-field copy is undecidable generically — parameterize
> it or escalate. Picking one branch silently breaks the §2 copy invariant for the
> other kinds.

---

## 3. Parameter-passing mode → TS mapping

D's parameter storage classes change whether the callee sees a copy or an alias.
This is the second-most common source of aliasing bugs.

### 3.1 Plain (by-value) parameter — COPY at call site

```d
// D — dmd/dinterpret.d:3077 style: by-value Expression* is a pointer (class-like);
// by-value STRUCT param copies. Generic shape:
void mutateByValue(S s) { s.x = 999; }   // does NOT affect caller (_probes.md §1b)
```
```ts
// TS — copy at the call site; callee body unchanged
function mutateByValue(s: S): void { s.x = 999; }   // local copy
mutateByValue(arg.copy());                          // CALLER emits the copy
```
Invariant: caller's variable is unchanged after the call.

### 3.2 `ref` parameter — ALIAS, mutate in place (NO copy)

```d
// D — dmd/root/array.d:140
ref Array push(T ptr) return pure nothrow { ... }     // ref receiver/return
void deduce(Type t, out Type at) { ... }              // see 3.4
```
```ts
// TS — pass the SAME object; mutations are visible to the caller
function push(self: Array, ptr: T): Array { /* mutate self */ return self; }
```
Rule: a `ref S` parameter receives the **same object reference** as the caller's
variable. **Do NOT `.copy()`.** Mutations inside the callee are seen by the caller.
This is exactly JS default object-passing — no special handling needed beyond *not*
copying.

> **Trap:** because TS objects are references, a `ref` param "just works" by
> passing the object. The danger is the *opposite* — accidentally `.copy()`-ing a
> `ref` argument, which would silently break the by-reference contract. When the D
> signature says `ref`, pass the object verbatim.

A D `ref` bound to a field reached through a class reference that may be null (`f(x.loc)` with
`x` null) forms an address without loading through `x`, so D does not crash there. Port it as
`x !== null ? x.loc : <init>` only when the callee provably never reads the parameter on that
path, and cite the callee's early return at the site (dfa/fast/statement.d:635, :988, where
`onRead` returns before reading `loc`, analysis.d:2177).

A `ref` parameter bound to a field (`ref this.symbols`) that the callee neither reads nor writes
(cparse.d:3884/:4019) is passed by value, with an underscore-prefixed parameter; a box or accessor
pair would protect nothing.

### 3.3 `out` parameter — caller var is RESET, then filled

Verified (`/tmp/vsem.d` case C): an `out` param discards the caller's prior value
(`e.tag=100` → after `fillOut(e)` becomes `e.tag=2`); D default-initializes the
`out` param on entry, the callee writes it, the caller sees the written value.

```d
// D — dmd/dscope.d:435
Dsymbol search(Loc loc, Identifier ident, out Dsymbol pscopesym, SearchOptFlags flags);
// D — dmd/templatesem.d:5871
private MATCH deduceTypeHelper(Type t, out Type at, Type tparam);
```

Two sub-cases by the out-param's type:

- **`out` of a CLASS / pointer type** (e.g. `out Dsymbol`, `out Type`, `out Expression`):
  the common case in the frontend. Translate via a **single-slot box** so the callee
  can write back a reference the caller reads:
  ```ts
  // box pattern (see §7) — one mutable cell
  interface Ref<T> { value: T; }
  function search(loc: Loc, ident: Identifier, pscopesym: Ref<Dsymbol | null>,
                  flags: SearchOptFlags): Dsymbol | null {
    pscopesym.value = null;          // D resets `out` to .init on entry
    // ... callee writes pscopesym.value = foundScopeSym;
    return result;
  }
  // call site:
  const pscopesym: Ref<Dsymbol | null> = { value: null };
  const sym = search(loc, ident, pscopesym, flags);
  // read pscopesym.value
  ```
- **`out` of a value STRUCT** (e.g. `out ImportPathInfo` — `dmd/dmodule.d:492`):
  same box, but the cell holds a struct object; on entry set it to a fresh
  default-constructed value (`{ value: new ImportPathInfo() }`), callee assigns
  `box.value = produced.copy()` per the store rule (§1 #5).

Invariant: the caller's pre-call value of an `out` arg is **never** read by the
callee and is **always** overwritten — emit the reset on entry so the port matches.

### 3.4 `in` parameter — read-only view (treat as by-value, no mutation)

In D2 `in` means `const scope` — the callee may not mutate it and may not escape it.

```d
// D shape (in == const scope view)
int readIn(in Counter c) { return c.v; }
```
```ts
// TS — pass the object; do NOT copy (callee promises not to mutate)
function readIn(c: Counter): number { return c.v; }
readIn(arg);   // no .copy(): `in`/`const` means callee won't mutate
```
Rule: `in`/`const ref`/`const scope` params are **read-only aliases**. Pass the
object directly; **no `.copy()`** (the cost-saving is sound because the callee
contract forbids mutation). If you *observe* the callee mutating a `const`/`in`
param, that is a translation bug or an upstream `cast`-away — escalate.

> `scope` / `return scope` / `return ref` are **lifetime annotations** for D's
> escape analysis. They do **not** change copy semantics. Erase them; they have no
> runtime meaning in JS (GC handles lifetime). See §8.

### Parameter-mode cheat

| D param mode | Copy? | TS |
|---|---|---|
| `S s` (by value) | yes, **at call site** | `f(s.copy())` |
| `ref S s` | no — alias | `f(s)` (mutations visible) |
| `out S s` | no — alias + reset on entry | box / `Ref<T>`, reset then fill (§3.3) |
| `in S s` / `const ref S s` / `const scope` | no — read-only alias | `f(s)` (callee must not mutate) |
| `scope` / `return ref` / `return scope` | (lifetime only) | erase; copy rule unchanged |

---

## 4. Arrays of structs — read copies, index-write aliases

D distinguishes *reading an element into a variable* (copy) from *writing through
an index* (in place). Both verified (`_probes.md` §1c/1c2, `/tmp/vsem.d` case D).

```d
// D
S[] arr = [S(10)];
S v = arr[0];     // COPY  (_probes.md §1c)
v.x = 555;        // ... so arr[0].x stays 10
arr[0].x = 777;   // lvalue write -> mutates element IN PLACE (_probes.md §1c2)
foreach (x; arr)      { x.tag = 1; }   // value copy each iter -> no effect
foreach (ref x; arr)  { x.tag = 9; }   // ref -> mutates elements in place
```
```ts
// TS
const v = arr[0].copy();   // read into var -> COPY
v.x = 555;                 // arr[0] unchanged
arr[0].x = 777;            // index lvalue write -> in place, NO copy
for (const x of arr.map(e => e.copy())) { x.tag = 1; }   // value foreach: see note
for (const x of arr)      { x.tag = 9; }                 // ref foreach: in place
```

> **`foreach` copy note:** in D `foreach (x; arr)` copies each element into `x`. A
> faithful, decisive translation: if the loop body **never mutates `x`**, iterate
> directly (`for (const x of arr)`) — D's copy is unobservable and elidable (§3.3
> rule applies; leave the justification comment). If the body **does mutate `x`**
> and D used a non-`ref` `foreach`, you MUST copy per element to avoid aliasing:
> `for (const x of arr) { const xc = x.copy(); /* mutate xc */ }`. Control-flow doc
> `06-control-flow.md` owns the loop *shape*; this doc owns the *copy decision*
> inside it.

Invariant: writing through `arr[i].field = ...` mutates the stored element;
reading `let v = arr[i]` then mutating `v` must not touch the stored element.

> **`Array!T` (the runtime container, `dmd/root/array.d`) has the same element
> semantics**, but its storage/copy details (and the fact that many frontend
> `Array!` structs are `@disable this(this)` — non-copyable, e.g.
> `dmd/root/array.d:50`) are owned by `08-runtime-lib.md`. For value semantics:
> reading `array[i]` into a var copies; `array[i].field = x` writes in place.

---

## 5. Store into / read out of a class field — copy on both sides

Verified (`/tmp/vsem.d` case E): storing a struct into a class field copies; reading
it back into a var copies. Mutating the original after store, or the read-out copy,
leaves the field's stored value intact (`h.slot.tag=7` survives both).

```d
// D
class Holder { Outer slot; }
Outer src = Outer(Inner(7), 7);
h.slot = src;        // store: COPY
src.tag = 1234;      // ... does not change h.slot
Outer got = h.slot;  // read: COPY
got.tag = 5678;      // ... does not change h.slot
```
```ts
// TS
class Holder { slot: Outer = new Outer(new Inner(0), 0); }
const src = new Outer(new Inner(7), 7);
h.slot = src.copy();   // store -> COPY (rule §1 #5)
src.tag = 1234;        // h.slot.tag stays 7
const got = h.slot.copy();   // read -> COPY (rule §1 #6)
got.tag = 5678;        // h.slot.tag stays 7
```

> **Common real case — a value struct as a class field.** `Expression` holds
> `Loc loc;` (`dmd/expression.d:305`). Any `someExpr.loc = otherLoc;` is a struct
> store → `someExpr.loc = otherLoc.copy();`. Any `Loc l = someExpr.loc;` is a read
> → `const l = someExpr.loc.copy();`. (Construction-time field init `this.loc = loc`
> inside the constructor copies too — `someExpr.loc = loc.copy()` — unless the
> incoming `loc` is freshly constructed and never reused, in which case §3.3
> elision applies with a comment.)

---

## 6. Postblit `this(this)`, copy constructors, and `opAssign`

`.copy()` must reproduce D's *user-defined* copy behavior, not just bit-copy fields.
There are three relevant hooks, and they fire at **different** points — all verified.

### 6.1 What fires when (verified, `/tmp/vsem2.d` + `_probes.md` §1d/1d2)

| Operation | Hook that fires | Note |
|---|---|---|
| Plain construction `S(3)` | normal ctor only | no postblit, no opAssign (`_probes.md` §1d3) |
| Assignment `a = b`, **no** `opAssign` defined | **postblit** `this(this)` on the new value | `_probes.md` §1d |
| Assignment `a = b`, `opAssign` **defined** | **`opAssign(b)`** — postblit does NOT run for the assign | `/tmp/vsem2.d` E2 |
| Pass-by-value / return-by-value | **postblit** `this(this)` | runs even when `opAssign` is defined (`/tmp/vsem2.d` E3) |
| Copy constructor `this(ref S rhs)` present | replaces postblit as the copy mechanism | `dmd/clone.d:1750` style |

### 6.2 The frontend reality (important — keep it simple)

Most value structs the frontend declares are **plain** (no postblit, no opAssign,
no copy-ctor) — their `.copy()` is the per-field recursion of §2. Several are
explicitly **non-copyable**: `@disable this(this)` (e.g. `dmd/root/array.d:50`,
`dmd/root/file.d:39`, `dmd/timetrace.d:262`, `dmd/common/smallbuffer.d:35`
`@disable this(ref const ...)`). For those:

> **`@disable this(this)` (or `@disable this(ref ...)`) ⇒ the struct is never copied
> in valid D. Do NOT generate a `.copy()` for it. If your translation *needs* a copy
> of a non-copyable struct, that is a bug — escalate (`11-escalate.md`).** These
> structs are only ever passed by `ref`, constructed in place, or moved.

### 6.3 When a real hook exists, `.copy()` honors it

The one frontend value struct with a hand-written `opAssign` is `PtrVarState`
(`dmd/ob.d:223`):

```d
// D — dmd/ob.d:223
struct PtrVarState {
    BitArray deps;       // value struct (or runtime container)
    PtrState state;      // enum (value)
    void opAssign(const ref PtrVarState pvs) { state = pvs.state; deps = pvs.deps; }
}
```
```ts
// TS — assignment routes through the opAssign translation, NOT a raw field copy.
// `05-operators.md` owns opAssign call-site rewriting; this doc says: when the
// struct defines opAssign, the COPY-on-assign uses it.
class PtrVarState {
  deps: BitArray;
  state: PtrState;
  // D opAssign(const ref) -> a method; the assignment `a = b` becomes a.opAssign(b)
  opAssign(pvs: PtrVarState): void { this.state = pvs.state; this.deps = pvs.deps.copy(); }
  copy(): PtrVarState {
    const c = new PtrVarState();
    c.opAssign(this);   // honor user opAssign for the field-copy semantics
    return c;
  }
}
// assignment `a = b`  ->  a.opAssign(b)     (NOT a = b.copy())
```

Rules:
- **If the struct defines `opAssign`:** translate `a = b` to `a.opAssign(b)` (the
  rewrite is owned by `05-operators.md`). Then `.copy()` (when you genuinely need a
  fresh copy, e.g. for return-by-value) constructs a new instance and runs the same
  field logic. Do not bypass `opAssign` with a raw field copy — it may have effects
  (here, `deps = pvs.deps` copies the `BitArray`).
- **If the struct defines `this(this)` postblit:** `.copy()` does the field copy
  **then** runs the postblit body on the new instance. (Frontend postblits are
  almost all `@disable`d; a real one with effects would need its body translated
  into `.copy()` after the field copy — `_probes.md` §1d invariant.)
- **If the struct defines a copy ctor `this(ref S rhs)`:** `.copy()` = `new S(this)`
  where the copy-ctor translation initializes the new instance from `this`. See
  `clone.d:1750` for the canonical D signature shape.
- **Emission checklist (check when the class is emitted, not when a caller breaks):** every
  D `struct` for which `__traits(isCopyable, S)` holds (no `@disable this(this)`, and no field
  whose copy constructor takes a mutable `ref`, §6.6) exports a `copy()` — **including structs that
  define `opAssign`** (the §6.3 form: `copy()` routes through it). A missing `copy()` is
  invisible until the first cross-file caller hits it, which in a parallel fleet means a
  different agent's build breaks on your file; the guide's own canonical examples must
  compile against the port, so emit `copy()` with the class, always. That includes a copyable
  struct ported as a class reference because D handles it only through pointers (02 §10), such as
  dfa's DFAReporter / DFAAnalyzer: its `copy()` is a required interface even when no D site copies it.

> Cross-ref: **`05-operators.md`** owns the *call-site rewrite* of `opAssign` (and
> `opEquals`, `opCmp`, etc.). This doc owns *which copy points exist and that
> `.copy()` must honor the hook*. Do not duplicate the operator-rewrite mechanics.

### 6.4 Default construction of a value-constructor-only struct (CANONICAL HOME)

In D, `T x;` **default-initializes** — every field takes its `.init` — and runs
**no** `this(...)` ctor. `T(v)` runs `this(v)`. A struct can therefore be born two
ways: field-by-field defaulting (`T x;`) *and* value construction (`T(v)`), even
when it declares only the value ctor. `Optional!T` is the canonical case: it has
exactly one ctor `this(T value)` (`dmd/root/optional.d:53`) yet `Optional!int opt;`
is valid and yields `value == T.init`, `present == false`
(`dmd/root/optional.d:20`).

```d
// D — dmd/root/optional.d:42  (one value ctor, but default-init still works)
struct Optional(T)
{
    private T value;          // .init = T.init
    private bool present;     // .init = false
    this(T value) { this.value = value; this.present = true; }   // line 53
}
// both are legal:
Optional!int a;              // default-init: value=0, present=false  (NO ctor runs)
Optional!int b = Optional!int(1);   // value path: this(1) runs
```
```ts
// AFTER — ONE constructor supporting BOTH births. Branch on arguments.length.
// Do NOT split into two classes.
class Optional<T> {
  private value!: T;
  private present: boolean;
  constructor(value?: T) {
    if (arguments.length === 0) {
      // default-init (D `Optional!int opt;`): only the fields whose .init is
      // observable get set. present.init = false (observable; gates `value`).
      this.present = false;
      // `value` is left UNASSIGNED: T is erased, so a generic T.init literal is
      // not expressible (see 08 "Container representation: TS-native Array<T>").
      // `present === false` guarantees `value` is never read while unset.
    } else {
      // value path (D `Optional!int(1)` -> this(1)):
      this.value = value as T;
      this.present = true;
    }
  }
}
const a = new Optional<number>();     // default-init: present=false
const b = new Optional<number>(1);    // value ctor: present=true
```

Rules:
- **Keep a SINGLE constructor.** Make the value parameter(s) optional and branch on
  `arguments.length === 0` (the *no-argument* default-init path) vs the value path.
  `arguments.length` distinguishes "called with no args" from "called with an
  explicit `undefined`", which matters when `T` itself can be `undefined`.
- **Comment both modes** — one line each: the default-init branch sets the fields
  whose `.init` is observable; the value branch states it mirrors `this(v)`.
- In the default-init branch, set each field whose type is **concretely known** to
  its **D `.init`** — from the VERIFIED table in `09-numerics.md §1.0`, never from
  memory. The traps: `char` inits to `0xFF` (not 0), `wchar`/`dchar` to `0xFFFF`,
  `float`/`double`/`real` to `NaN` (not 0.0), a named enum to its FIRST member (not
  0); only `bool`→`false`, integrals→`0`, class refs→`null` match the naive guess.
  **Do NOT synthesize a `.init` for an erased type-parameter field** (e.g.
  `value: T`): for an erased `T` a generic `T.init` literal is not expressible.
  **Declare it `value!: T` and leave it UNASSIGNED**, relying on the sibling gate
  field (here `present === false`) so the unset value is never observable — exactly
  as the canonical code above. The `!` (definite-assignment assertion) is the
  faithful TS analogue of "born default, but never read until present". Cross-ref
  `08-runtime-lib.md` "Container representation: TS-native Array<T>" for why an
  erased element/value type carries no synthesizable default. Where the frontend
  genuinely depends on a default-valued `T` slot, escalate (`11-escalate.md`) or
  special-case at the known `T` — never guess a generic default.
- Do **not** split into a "default" class and a "value" class — D has one type with
  two construction paths, and TS callers expect `new Optional<T>()` and
  `new Optional<T>(v)` to produce the same type.

> Invariant: `new T()` (no args) must reproduce D's `T x;` — every field with a
> concretely-known type takes its `.init` and there are no ctor side effects; an
> erased type-parameter field stays UNASSIGNED (`value!: T`) and is never read until
> its gate makes it present. `new T(v)` must reproduce `T(v)` (the value ctor body).
> One class, one constructor, two branches.

### 6.5 `@disable this()` vs `@disable this(this)` (CANONICAL HOME)

Similar spelling, **opposite `.copy()` implications.** Read the parentheses
carefully.

| D declaration | Meaning | Copyable? | Emit `.copy()`? | Default-constructible? |
|---|---|---|---|---|
| `@disable this(this)` | postblit disabled — **non-copyable** | **NO** | **NO** (§6.2) | yes (unless also `@disable this()`) |
| `@disable this()` / `this() @disable` | no default ctor — **value-ctor required** | **YES** | **YES** (unless `this(this)` also disabled) | **NO** |

```d
// D — dmd/root/complex.d:18  : value-ctor-only, default construction FORBIDDEN,
// but the struct is STILL COPYABLE (no @disable this(this); postblit is implicit).
extern (C++) struct complex_t
{
    real_t re;
    real_t im;
    this() @disable;                 // dmd/root/complex.d:25 — no default ctor
    this(real_t re) { this(re, CTFloat.zero); }
    this(real_t re, real_t im) @safe { this.re = re; this.im = im; }
}
complex_t z;            // ERROR in D: default construction disabled
complex_t z = complex_t(1.0, 2.0);   // ok
complex_t w = z;        // ok — complex_t IS copyable (postblit not disabled)
```
```ts
// AFTER — DO emit copy() (the struct is copyable). Enforce "no default
// construction" by making the FIRST ctor parameter REQUIRED, so `new complex_t()`
// is a TS compile error (mirrors D's disabled this()).
class complex_t {
  re: number;     // real_t -> number (09-numerics §6)
  im: number;
  // re REQUIRED: no zero-arg ctor. im defaults to CTFloat.zero, mirroring D's
  // delegating `this(real_t re) { this(re, CTFloat.zero); }` (dmd/root/complex.d).
  // Prefer the ported `CTFloat.zero` constant over a bare `0` literal: it keeps
  // the default faithful to the D source (see 12-worked-examples.md).
  constructor(re: number, im: number = CTFloat.zero) {
    this.re = re;
    this.im = im;
  }
  copy(): complex_t {                          // emitted: complex_t is copyable
    return new complex_t(this.re, this.im);
  }
}
// new complex_t()           // TS type error: expected 1-2 args  (== D disabled this())
const z = new complex_t(1.0, 2.0);   // ok
const w = z.copy();                  // ok — copyable
```

Rules:
- **`@disable this(this)`** (postblit disabled) ⇒ the struct is **never copied** in
  valid D. **Do NOT emit a `.copy()`** (§6.2). If your translation needs to copy it,
  that is a bug — escalate (`11-escalate.md`).
- **`@disable this()`** (no default ctor, equivalently `this() @disable;`) ⇒ the
  struct is **still copyable**. **Emit `.copy()`** as usual (unless `this(this)` is
  *also* disabled). Enforce the no-default-construction contract by making the
  **first constructor parameter REQUIRED**, so `new T()` is a TS type error — the
  faithful analogue of D rejecting `T x;`.
- The two `@disable` forms have *opposite* copy-emission outcomes despite the
  near-identical spelling. When you see `@disable`, check whether the parentheses
  hold `this` (the postblit — non-copyable) or are empty (the default ctor — still
  copyable).

> Invariant: `@disable this(this)` removes `copy()`; `@disable this()` keeps
> `copy()` and removes the zero-argument constructor. Never conflate them.

---

### 6.6 Owning handles: a moving copy constructor plus a destructor (dfa/* only)

A declared exception to erasing destructors (§8, `11 §3.7`), ratified for `dmd/dfa/` alone. There,
`DFALatticeRef` and `DFAScopeRef` (dfa/fast/structure.d) carry a copy constructor `this(ref X other)` that
MOVES (it takes `other`'s pointer and nulls it) and a destructor that frees the lattice / scope into the
allocator's free lists. Later allocations reuse those nodes and their addresses are observable (§8.1), so
the timing of every move and destruction shows in the output. Probed with ldc2: a copy from an lvalue
steals; `a = b` copy-constructs the parameter from `b`, swaps, and destroys the old value; the callee
destroys its by-value parameters at its exit, after its own locals (locals in reverse declaration
order, then parameters left to right); `return param;` copy-constructs, and so does a delegate's
`return v;` of a variable of the enclosing function. The TS spelling, stated in the structure.ts header:

- `new X(src)` — every D copy from an lvalue (initialization, by-value argument, `return variable;`):
  steals `src`'s pointer, `src` becomes null.
- `x.opAssign(v)` — D `x = v`: swaps in `v` and destroys the old value.
- `x.__dtor()` — where D destroys: a local at its scope exit (`try`/`finally` when the scope has several
  exits), a by-value parameter by the callee at its exit, an rvalue temporary at the end of its full
  expression. A destructor on a null handle does nothing.
- `x = f(x, ...)` is `x.opAssign(this.f(new X(x), ...))`: the argument moves out first, then the result
  is assigned into the now-null `x`. A local still null at an exit needs no `__dtor()`; one that holds a
  lattice does, early returns included.
- A D variable is not in scope in its own initializer: in `X lr = f(lattice, lr);` inside a nested
  delegate, the `lr` in the initializer is the enclosing function's (probed). In TS that line would read
  the new binding in its temporal dead zone, so the inner local is renamed, with a comment.

A struct whose field has such a copy constructor (one taking a mutable `ref`) is itself non-copyable:
its generated copy constructor is disabled (`__traits(isCopyable, S)` is false) even without an explicit
`@disable`. It gets no value `copy()` (§6.2).

## 7. `&x` (address-of) and `*p` (dereference) — the box / ref-cell pattern

D takes the address of a value (local, field, element) to get a `T*` that aliases
the actual storage; writes through `*p` / `p.field` mutate the original. JS has no
pointers, so an address-of a *value* needs an explicit one-slot **box**. Verified
(`/tmp/vsem2.d` F): `Counter* p = &x; p.v = 20;` makes `x.v == 20`.

### 7.1 Address-of a CLASS object — trivial (it's already a reference)

`&someClassVar` of a class type is rare and usually just the reference itself; a
`Class*` in the frontend is almost always *already* passed as the reference. Treat
`Class*` as `Class | null`. No box needed. (Most `*` in the frontend are
`Expression*`/`Dsymbol*`/`Scope*` etc. — these are pointer-to-class and map to the
nullable class reference directly; see `02-types.md` for the pointer-type mapping.)

### 7.2 Address-of a value STRUCT (or a struct field/element) — use a box

```d
// D — dmd/dinterpret.d:4872 : a stack struct, address taken, compared, used as alias
InterState istateComma;
if (...) { istate = &istateComma; }     // istate now aliases the local struct
...
if (istate == &istateComma) { ... }     // identity compare against the same address
```
```ts
// TS — the struct object IS the box; `&local` is just the object reference,
// because TS structs are already heap objects. Address-identity becomes
// object identity (===).
const istateComma = new InterState();
if (...) { istate = istateComma; }       // alias the SAME object (no .copy())
...
if (istate === istateComma) { ... }      // identity compare == reference equality
```

> **Key simplification:** because a TS value-struct is *already* a heap object,
> `&structVar` is just the object reference, and `*p`/`p.field` is just normal field
> access on it. The "box" only becomes a distinct wrapper when you take the address
> of something that is NOT itself an object slot — a **local primitive**
> (`int* p = &i;`) or a **struct held inline that you must alias rather than copy**.
> For those, use the explicit cell:

```ts
interface Ref<T> { value: T; }          // the canonical box / ref-cell
// D: int n; int* p = &n; *p = 5;  =>
const nBox: Ref<number> = { value: 0 };
const p = nBox;                          // alias
p.value = 5;                             // *p = 5  (mutates the shared cell)
```

> `Ref<T>` has no single exported home yet, so several files declare it locally. Keep the
> shape above verbatim when you must declare it, and — inside a chunked file (`14 §6`) — bind
> the decision in the scout sheet's ALIAS TABLE, or two chunk owners will both declare it and
> collide at the stitch. Inline `{ value: T }` at the use site is the fallback when a
> declaration would collide; it is not a second convention.

Rules:
- `&structVar` → the struct object reference itself (no wrapper); `*p` / `p.field`
  → field access; pointer identity `p == &x` → `p === x` (`===`).
- `&primitiveLocal` or any address-of where the target is not already an object →
  wrap the value in a `Ref<T>` cell and pass the cell. This is the same mechanism
  as the `out` parameter box (§3.3).
- A null pointer `T* p = null` → `let p: T | null = null` (class case) or
  `Ref<T> | null` (boxed-value case).
- **Never** translate `&x` as `x.copy()` — address-of is the *opposite* of a copy;
  it deliberately aliases. Confusing the two is a silent bug.

### 7.3 Address-of a REFERENCE SLOT — `&obj.field` — use an accessor pair

§7.2 covers `&structLocal` (the object itself is the box) and `&primitiveLocal` (a `Ref<T>`
cell). Neither expresses `&obj.field` where the field holds a class REFERENCE: a `Ref` box
cannot alias a slot that already lives inside another object, so writing through the box would
update the box and leave `obj.field` untouched. The faithful rendering is a one-slot
**accessor pair**, named after the D pointer, closing over the owner:

```ts
// D — dmd/dsymbolsem.d:7834 : VarDeclaration* pvar = &ie.lengthVar;
const pvar = { get: () => ie.lengthVar, set: (v: VarDeclaration | null) => { ie.lengthVar = v; } };
pvar.set(v);                   // *pvar = v
if (pvar.get() === null) { }   // if (!*pvar)
```

`*p` → `p.get()`, `*p = v` → `p.set(v)`. The pair also expresses a pointer that WALKS a chain
of slots — the template overload-chain append at `dsymbolsem.d:1218-1229`
(`for (ptd = &pthis; *ptd; ptd = &(*ptd).overnext) {} … *ptd = td;`) — by reassigning the
cursor to a new pair built over the next owner. Do not collapse the walk into a plain
reference: the final `*ptd = td;` writes into whichever slot the cursor last named, and a bare
reference has forgotten which slot that was.

> Cross-ref: the general pointer-type → TS mapping (`T*`, `T**`, `void*`, pointer
> arithmetic, `null`) is owned by **`02-types.md`**. This doc covers only the
> *value-semantics consequence* of `&`/`*` on structs.

---

## 8. GC / `rmem` / region allocators — no-ops in JS

D's frontend allocates via the GC, the `Mem`/`rmem` wrapper (`dmd/root/rmem.d`), and
arena/`Region` allocators (`dmd/root/region.d`). None of these change *values* — they
only change *where/when memory comes from*. JS has a garbage collector and no manual
memory management.

| D allocation construct | TS translation |
|---|---|
| `new C(...)` (class) | `new C(...)` |
| `mem.xmalloc(...)` / `Mem.check` (`rmem.d:42`) | erase the allocator; allocate the object directly (`new`, array literal) |
| `Region` arena alloc (`region.d:24`) | erase; rely on the JS GC. A region "free-all" becomes dropping the references |
| `destroy(x)` / `~this` dtor | usually erase (GC reclaims). Deterministic cleanup is rare — see `04-functions.md` for `~this` handling |
| `scope` storage class on a local | erase — lifetime hint only, no value effect (§3.4) |

> **State explicitly in the emitted TS** when you erase an allocator, with the
> resolved-comment convention (`_ground-truth.md` §5):
> `// erased: rmem.xmalloc -> JS GC (no manual allocation)`.

**Crash-only safety note (cross-ref the project rule `crash-only-recovery.md`):**
because the ported frontend keeps no load-bearing manual-memory state — all objects
live on the JS heap and the only durable state is the source files / output — an
`assert` failure or crash mid-compile is safe: re-running the compiler reconstructs
everything from the inputs. This is *why* the `assert(...)`-everywhere style of the
frontend (`_ground-truth.md` §4: 2428 asserts) ports faithfully to throwing asserts
without recovery scaffolding. Allocators being no-ops does not weaken this — there is
nothing to leak or half-free.

> Cross-ref: `08-runtime-lib.md` owns `rmem.d`/`region.d`/`Array!T` as *modules to
> translate* (their public surface). This doc only states their *value-semantics
> effect*: none.

### 8.1 A region allocator whose addresses are observable (dfa/* only)

A declared exception to the table above, ratified for `dmd/dfa/` alone. The fast DFA
(dfa/fast/structure.d) keys hash buckets by pointer (`addr % 16`) and keeps each bucket sorted by
address, so the order in which it visits variables, and with it the order of its diagnostics, follows
allocation addresses. Its `DFAAllocator` is therefore kept: per-type free lists hand the same node out
again, and every node carries a simulated address. `T.sizeof` is measured with ldc2 (`pragma(msg)`), the
static region sits at its offset in the ldc2 binary (nm), and malloc'd regions follow above it in
allocation order (probed: ascending, 0x20000 apart). Only `addr mod 16` and the relative order are
observable, and both are stable across ASLR (the slide is page-aligned), so the model reproduces ldc2's
order. It is checked against ldc2 on programs written to produce several DFA diagnostics in one run, not
only on the corpus. Tables keyed by a GC-allocated AST node that D only probes, never iterates, stay
`Map`s keyed by the node. The allocator is in-memory state of one compilation, so the crash-only note
above still holds.

A test of the address model must produce diagnostics reported while a DFAScope's buckets are iterated
(loop convergence: "was required to be non-null and has become null"), in both address parities and,
for the region model, in a malloc'd region (tests/dfa m07, m11, m12). Diagnostics reported at the read
(a null dereference, a NaN read, an assert) follow the walk order and do not exercise it. Prove a test's
reach by perturbing the address function on an isolated copy: shifting every address by 8 must fail
m07/m11/m12, reversing the order m11/m12, moving the malloc'd base m12.

---

## 9. Eliding a provably-unnecessary copy (the ONLY licensed shortcut)

A faithful port emits `.copy()` at every copy point (§1). **You MAY elide a copy
only when the copied value is provably never mutated after the copy** — then the
copy is unobservable and the alias is equivalent to a copy.

**Conditions (ALL must hold) to elide a `.copy()`:**
1. The destination (and every alias of it reachable in scope) is **never mutated**
   after the assignment — neither its fields nor nested value-struct fields.
2. The source is **never mutated** for the rest of both variables' overlapping
   lifetime (or is a fresh temporary that dies immediately — e.g. a constructor
   result, a return value, a function argument used once).
3. The struct has **no `opAssign`/postblit/copy-ctor with side effects** (a hook
   with effects must run even if the value is never read again — do NOT elide).

**You MUST leave a one-line comment justifying every elision** (audit trail, per
house style), e.g.:

```ts
// D: Loc l = e.loc;  (l is only read, never mutated)
const l = e.loc;   // copy elided: l is read-only after this point (value never mutated)
```
```ts
// D: f(makeLoc());  argument is a fresh temporary, used once
f(makeLoc());      // copy elided: arg is a fresh rvalue, no aliasing possible
```

If you are **not certain** all three conditions hold, **emit the `.copy()`**. The
default is always to copy. Elision is an optimization you justify, never an
assumption you make. When in doubt between "elide" and "copy", copy — a redundant
copy is correct-but-slow; a missing copy is a silent bug.

> Read-only-after-construction fields are the most common safe elision: when a
> struct field is set once in the constructor from a fresh argument and never
> reassigned, `this.loc = loc` (no copy) is sound — annotate it.

### 9.1 The ALIAS-SAFE REGISTER — per-TYPE elision (replaces per-site justification at scale)

Experience from the first port attempt: per-site copy-or-justify does not survive a real
frontend file — `Loc` alone is read thousands of times, and translators either drown the file
in justification comments or (what actually happened) silently stop copying. The scalable form
is **per-type**: this register lists the value structs whose instances are **never mutated
after construction anywhere in the IN-SCOPE frontend**, verified. For a register member,
sharing on read is licensed with **no per-site comment** — a share of an immutable value is
indistinguishable from a copy.

| Type | Mutation surface | Why it is dead in-scope (verified) |
|------|------------------|------------------------------------|
| `Loc` | `nextLine()` (location.d:94); `index` written only in `Loc.create`/`_init`; `ref Loc` PARAMETERS rebind the slot (`expressionsem.d:3396/:3497/:3553`, rebound at `:3459`/`:3521`) | the ONLY `nextLine()` callers are `doc.d:4116`/`doc.d:4221` (verified by tree-wide grep), both on `highlightText`'s BY-VALUE `Loc loc` parameter (doc.d:4114): the port copies that parameter at entry before the first `nextLine()`, so the caller's `Loc` is never written; no other site writes a published `Loc`. A `ref Loc` rebind replaces WHICH `Loc` the slot holds — slot mutation, not object mutation — so the share-on-read licence survives |

**Entry requirements (all, verified before adding a row):**
1. Every field is primitive, a class reference, or itself a register member.
2. Every mutating method and every external field write is **dead in-scope**: its only call
   sites are in excluded modules, or provably on a private not-yet-published instance. Cite
   the grep in the row.
3. The row names the full mutation surface, so the next auditor re-checks exactly that.

**Default emission for a register member: plain share, NO comment, at EVERY §1 copy point**
(assignment, arg-pass, return, field store/read alike — not just "on read"). Adding
defensive `.copy()` calls to a register member is itself a deviation (it forks the tree's
convention); the cheatsheet's unconditional-looking copy rows are overridden by this
register for its members.

**A `.copy()` on a register member is a DEFECT TO REMOVE, never a site to normalize upward.**
When a reviewer finds a file mixing bare shares with `.copy()` calls on the same register type,
the repair is deleting the copies, not adding copies to the bare sites — the two lenses read
that mixture in opposite directions on identical sites, and the register decides which way it
resolves. (The tree census agrees: 78 files use bare `Loc.initial`, 4 carry `.copy()`.)

**Two riders that are not licences:**
- **A D `ref Loc` parameter is ported with a `Ref` box (§7.2), never as a field write on a
  shared `Loc`.** The D function rebinds the caller's SLOT; writing `loc.linnum = …` through a
  shared object would corrupt every other holder of that `Loc`.
- **The register licenses sharing on read; it says nothing about which equality predicate
  binds.** For `Loc`, D's `==` binds `opEquals` (which compares the `index`), never the
  same-named `equals` (filename/line) — picking the wrong one silently changes a compile
  outcome. Resolve the operator at the D site before emitting either.

**Hard rules:**
- A value struct with a LIVE in-scope mutator can NEVER enter the register — it takes the
  full §1 copy discipline at every copy point, no per-site elision of mutation-reachable
  instances. (§9's three conditions still allow ordinary per-site elision where they provably
  hold, and §9.2 allows callee-side elision for by-value parameters.)
- **Register maintenance is part of translation:** a wave that ports a file introducing a
  live mutation of a register type MUST remove the row and sweep the port for now-unsafe
  shares before merging. The register is this section — one home, no copies of the table.
- Non-members follow §1/§9 unchanged. When in doubt, the type is NOT in the register.

### 9.2 Callee-side elision — per-TYPE licence for by-value parameters of a non-member

A value struct with live mutators cannot join the §9.1 register, but its methods' by-value
parameters can still skip the call-site copy (§3.1) when the CALLEE makes the copy unobservable:
the method never mutates, stores, or returns that parameter uncopied. Then the caller's value and
the parameter are never both live under a mutation, and §9's conditions hold for every caller at
once.

**Form of the licence:**
1. It is stated ONCE, in the type's file header (a `COPY DISCIPLINE` block), not per call site.
2. The header names every method that DOES mutate, store, or return uncopied a by-value parameter,
   with the D lines. Callers of those methods pass `.copy()`; callers of every other method pass
   the value bare.
3. A later edit that makes a method mutate a by-value parameter updates the header and sweeps its
   callers in the same change, as for register maintenance (§9.1).

Reference example: the header of `src/dmd/intrange.ts`, where every method except `IntRange.opDiv`
takes `rhs` bare, and `opDiv` (which mutates `rhs` at intrange.d:624/:628) is named there and its
callers copy. The licence covers parameters only; the §1 copy points for assignment, field store
and return stay as they are.

---

## 10. Quick decision table (the lookup the agent uses per line)

| You see in D... | Emit in TS | Rule |
|---|---|---|
| `S b = a;` (a, b structs) | `const b = a.copy();` | §1 #1 |
| `S s = S(1, 2);` | `const s = new S(1, 2);` | construction, no copy |
| `f(s)`, `f(S s)` by value | `f(s.copy())` | §1 #2 |
| `f(s)`, `f(ref S s)` | `f(s)` | §3.2 alias |
| `f(s)`, `f(in S s)` / `const ref` | `f(s)` (callee must not mutate) | §3.4 |
| `f(o)`, `f(out S o)` | box + reset on entry (§3.3) | §3.3 |
| `return s;` | `return s.copy();` (elide if §9) | §1 #3 |
| `S v = arr[i];` | `const v = arr[i].copy();` | §1 #4 |
| `arr[i].x = v;` | `arr[i].x = v;` | in-place lvalue write |
| `foreach (x; arr)` mutating x | per-elem copy (`x.copy()`) | §4 |
| `foreach (ref x; arr)` | `for (const x of arr)` (in place) | §4 |
| `obj.field = s;` (field is struct) | `obj.field = s.copy();` | §1 #5 |
| `S v = obj.field;` (field is struct) | `const v = obj.field.copy();` | §1 #6 |
| `*dst = src;` / `memcpy(dst, &src, …)` onto an aliased inline struct | copy fields INTO `dst`; do NOT reassign | §1.1 |
| whole-object clone (`T copy()` memcpy'ing an object with inline value-struct fields) | field-wise: `.copy()` each inline struct — `Object.assign` ALIASES them (exactly backwards) | §2 |
| inline `Array!T` VALUE member in `.copy()` | duplicate the container header (`this.f.copy()`, the container clone) — sharing is wrong, D copies the header | §2, 08 §2.3 |
| AA (`V[K]`) field in `.copy()` | D `.init` is null/lazy — a copy of an unallocated AA stays independent; once allocated, copy the Map (`new Map(this.f)`) — never share | §2 |
| function-pointer / delegate field in `.copy()` | `c.fp = this.fp;` (share the reference) | §2 + §2.1 |
| `a = b;` and S has `opAssign` | `a.opAssign(b)` | §6.3 + `05-operators.md` |
| `S* p = &s;` (s a struct local) | `const p = s;` (object ref aliases) | §7.2 |
| `int* p = &n;` (n a primitive) | `Ref<number>` box | §7.2 |
| `*p` / `p.field` | `p.value` / `p.field` | §7.2 |
| `p == &s` | `p === s` | §7.2 identity |
| `@disable this(this)` struct | NO `.copy()`; escalate if copy needed | §6.2 |
| `@disable this()` / `this() @disable` struct | EMIT `.copy()`; make first ctor param required | §6.5 |
| `T x;` (value-ctor-only struct) | `new T()` no-arg branch: fields = D `.init` | §6.4 |
| `mem.xmalloc(...)` / `Region` alloc | erase (JS GC) | §8 |
| `scope` / `return ref` / lifetime kw | erase | §3.4, §8 |

---

## 11. Cross-references

- **`opAssign` / `opEquals` / `opCmp` call-site rewriting:** `05-operators.md`
  (this doc only requires `.copy()` to *honor* `opAssign`).
- **Pointer types (`T*`, `void*`, `null`, pointer arithmetic):** `02-types.md`.
- **`Array!T` / slice storage & copy details, `rmem`/`region` as modules:**
  `08-runtime-lib.md`.
- **Loop *shape* (`foreach`/`foreach_reverse` → for-of/indexed):**
  `06-control-flow.md` (this doc owns the per-element *copy decision* only).
- **`~this` destructors / deterministic cleanup:** `04-functions.md`.
- **Named enum value semantics:** `_probes.md` §7; backing-type choice in `02-types.md`.
- **Numeric domain of struct fields (`number` vs BigInt):** `09-numerics.md`.
- **Resolved/erased one-line comment convention:** `_ground-truth.md` §5.
- **Crash-only safety (why erased allocators + assert-everywhere is safe):**
  project rule `crash-only-recovery.md`.
- **STOP/escalate for uncovered copy situations:** `11-escalate.md`.
