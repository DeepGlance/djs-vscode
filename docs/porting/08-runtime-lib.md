# 08 — Runtime Library Spec (`dmd/root/` → `djs` runtime)

> STOP rule: if you meet a `root/` construct or a member not specified here, or any
> ambiguity, STOP and escalate (`11-escalate.md`). Never guess a runtime contract.

This doc is the **contract** for the hand-written `djs` runtime that replaces
`dmd/root/` (plus `dmd/rootobject.d` and `dmd/arraytypes.d`). It is written **once**,
not per file. Every translated frontend file depends on it.

Read `_ground-truth.md` first. Cross-references:
- numeric domains (`number` vs `BigInt`), 64-bit casts, `real`=`double`: `09-numerics.md`
- value-copy `.copy()` invariant for structs: `03-value-semantics.md`
- D `string` is a byte array, NOT a JS string (`_probes.md §5`): `02-types.md`
- `longdouble`/`int128`/`strtold` numeric internals: `09-numerics.md`
- cycle handling (`import type`, lazy `import()`): `01-conventions.md`

## 0. Scope, layout, and the governing invariants

Translate-order buckets 0–4 (`translation-order.md §5`) cover these modules. They are
foundation: get them right and the rest of the port stands on solid ground.

**Where it lives.** One directory `djs/src/dmd/root/` with one file per D module, same
basename (`array.ts`, `bitarray.ts`, `stringtable.ts`, `aav.ts`, `file.ts`,
`filename.ts`, `port.ts`, `ctfloat.ts`, `complex.ts`, `utf.ts`, `string.ts`,
`speller.ts`, `hash.ts`, `optional.ts`). `RootObject`/`DYNCAST` → `djs/src/dmd/rootobject.ts`;
`arraytypes` aliases → `djs/src/dmd/arraytypes.ts`. `rmem`/`region` → see §13.

Hand-written helpers that are **not** a 1:1 port of a single `dmd/root/` D module (they
have no `.d` source basename to mirror) live one level up, at sibling `djs/src/`:
`assert.ts` (the assertion + abort + exception-hierarchy sink, §12), `dstring.ts` (the
`DString` byte-string alias, §11), `numeric.ts` (sentinels like `SIZE_MAX`, 09). Import
them from `root/` with `../../assert.js`, from `dmd/` with `../assert.js`, from `src/`
with `./assert.js`.

**Three invariants that govern the whole runtime:**

1. **No raw pointers, no manual allocation.** Every `mem.xmalloc`/`xfree`/`memcpy`/
   `memmove` in `root/` exists only because D has no GC-by-default here. JS has a GC.
   The runtime therefore stores **values in JS arrays / typed arrays**, never byte
   blobs you index with offsets. `rmem`/`region` become **no-ops** (§13).
2. **D `string`/`char[]` is a byte array (`_probes.md §5`).** In the runtime, a D
   `const(char)[]` / `char[]` / `string` is modeled as **`Uint8Array`** (see §11 for
   the canonical type alias `DString`). `.length` = byte count. `s[i]` = a byte
   (0–255). A `dchar` is a code point (`number`). Do NOT back these with JS `string`.
3. **Hash/iteration order parity is load-bearing.** `StringTable` and `aav` decide
   symbol-table iteration order, which leaks into diagnostics. The hash functions
   MUST reproduce DMD bit-for-bit. They have been probed (§9, §6) — do not re-derive.

---

## 1. `RootObject` + `DYNCAST` (`dmd/rootobject.d`)

`RootObject` is the base class of nearly every AST class (`Expression`, `Dsymbol`,
`Type`, …). `dyncast()` is DMD's hand-rolled RTTI tag used in lieu of `cast(X)` in
the `extern(C++)` subset (`rootobject.d:54`).

BEFORE (`dmd/rootobject.d:17-58`)

```d
enum DYNCAST : int { object, expression, dsymbol, type, identifier, tuple,
                     parameter, statement, condition, templateparameter, initializer }

extern (C++) class RootObject {
    this() nothrow pure @nogc @safe scope {}
    const(char)* toChars() const { assert(0); }
    extern(D) const(char)[] toString() const { auto p = this.toChars(); return p[0 .. strlen(p)]; }
    DYNCAST dyncast() const nothrow pure @nogc @safe { return DYNCAST.object; }
}
```

AFTER (`djs/src/dmd/rootobject.ts`)

```ts
export enum DYNCAST { object, expression, dsymbol, type, identifier, tuple,
                      parameter, statement, condition, templateparameter, initializer }

export class RootObject {
    // Returns a NUL-terminated C-string conceptually; in djs returns a DString (Uint8Array).
    // Base impl is unreachable — every concrete subclass overrides it.
    toChars(): DString { return assertUnreachable("RootObject.toChars: abstract"); } // assert(0)
    toString(): DString { return this.toChars(); }   // strlen-slice is implicit: DString has no NUL
    dyncast(): DYNCAST { return DYNCAST.object; }
}
```

Semantics / invariants:
- `toChars()` returns a **`DString`** (byte array), not a JS string. `toString()` in D
  slices off the trailing NUL via `strlen`; in djs the `DString` carries its own
  length and has no embedded NUL, so `toString` just returns it. Preserve the override
  chain verbatim — every subclass `toChars` is a faithful translation.
- `assert(0)` → `assertUnreachable` (throws `AssertError`, §12). It marks "must be overridden".
- `dyncast()` stays a method returning the `DYNCAST` tag. Frontend call sites compare
  `x.dyncast() == DYNCAST.expression` — keep them as-is. Do NOT replace `dyncast` with
  `instanceof`; the tag is also used in `extern(C++)` interop tables and must stay.

Consumers: essentially the entire AST + sema core (Bucket 7).

---

## 2. `Array!T` (`dmd/root/array.d`) — the growable container

This is the single most-used runtime type (123 `Array!` instantiations,
`_ground-truth.md §4`). `_probes.md §1` value-copy rules and `03-value-semantics.md`
own the *copy* discipline; this section specifies the **container API**.

**Canonical model:** `Array<T>` wraps a plain `T[]` JS array. `length` is a property
that the frontend both reads and **writes** (D `Array.length` is a public mutable
field — `array.d:32`). Writing `length` larger grows the backing array; smaller
truncates. The inline `smallarray`/`reserve`/`tdata` machinery is allocation tuning —
**drop it entirely**; a JS array already grows.

### 2.0 Container representation: TS-native `Array<T>` (CANONICAL HOME)

This section is the canonical home for the container-generics decision. `Array!T` is
instantiated over many distinct element types across the frontend (61+ distinct `T`,
123 `Array!` instantiations). It is **NOT** monomorphized per element type and it does
**NOT** carry a runtime type-witness. It is ported as a **single TS-native generic
class backed by a JS array** (`private data: T[]`). Other container/utility templates
(`StringTable!T` §5, `AssocArray!(K,V)` §6) follow the same stance.

The split between "plain ops" and "the few per-`T` ops":

- **Plain container ops are ordinary generics over `T`** — `push`/`append`/`pushSlice`,
  `opIndex` get, `opSlice`, `length`/`opDollar`, `remove`, `insert`, `pop`, `shift`,
  `setDim`, `reserve`. These compile to a single generic body that never inspects `T`.
- **Raw-memory-init ops** (`zero()`, the length-grow fill to `T.init`) exist **only**
  because D manages memory by hand. **Do NOT synthesize a generic `T.init`.** JS arrays
  are dynamic, so we grow **without pre-filling** slots and rely on the asserted
  invariant that ported frontend code never reads a slot before writing it (see 2.0a).
  Where the frontend genuinely depends on default-valued slots being readable, do NOT
  guess a generic default — escalate (`11-escalate.md`), or special-case at the one
  known `T` if it is unambiguous.
- **Per-`T` capability dispatch** (e.g. `toString` guarded by
  `static if (is(typeof(T.init.toString())))`) cannot be resolved in one generic body →
  `07-compile-time.md` "Compile-time dispatch on a generic type parameter". For `Array`
  (`toString`/`toChars`, 2.7) → per-`T` variants at the instantiated element types
  (07 §3.5(b)); no generic default.
- **Equality/ordering on `T`** (`find`/`contains` using `is`/`==`, `sort()` using
  `opCmp`) routes through `05-operators.md` "Operators on a generic type parameter".
- **Iteration:** the container carries a `[Symbol.iterator]` delegating to the backing
  array, so `foreach` over an `Array` **value** lowers to `for…of` → `06-control-flow.md`
  "foreach over a container value" (2.0b).
- **Element write through a ref-returning `opIndex`** (D `arr[i] = v` where `opIndex`
  returns `ref T`): synthesize `opIndexAssign(v, i)` → `05-operators.md` "Synthesized
  opIndexAssign for a ref-returning opIndex" (2.0c).

Rationale: this preserves the faithful 1:1 structure **and** idiomatic TS. The per-`T`
hard spots in the frontend's container usage are few, and almost all of them are either
diagnostics (`toString`) or raw-memory artifacts (`zero`/grow-fill) with no semantic
weight in a GC'd port.

#### 2.0a Grow without pre-fill — `zero()` and the `length` setter

```ts
// No generic T.init. Grow leaves new slots UNINITIALIZED (JS: `undefined`/hole);
// shrink truncates. Setting `.length` on a JS array does both — no per-slot fill.
// Invariant (asserted, not enforced): ported code WRITES every slot it later reads.
set length(n: number) { this.data.length = n; }   // grow: NO pre-fill to T.init; shrink: truncate
setDim(n: number): void { this.length = n; }          // array.d:setDim — same grow-without-fill
// zero() existed to memset the slots to T.init. With no generic default we cannot fill.
// If a call site relied on zero() to make slots READABLE as defaults -> escalate (11).
zero(): void {
    // assert: every slot in [0..length) will be written before it is read.
    // If the frontend reads a zeroed slot as a default, this is a real default-dependence
    // -> do NOT guess a generic default; escalate or special-case at the known T.
}
```

Invariant: a `zero()` / length-grow whose result is **read back as a default** is a
genuine default-dependence. Never synthesize a generic `T.init` inside the container —
but the CALL SITE has a ratified spelling, and it is not "escalate":

**`zero()` call sites — keep D's call, follow it with an explicit fill.** The element type is
known at every real site (`dedtypes`, `dedargs` and friends are `Objects`, so `.init` is
`null`):

```ts
tempinst.tdtypes.zero();                                   // dmd/templatesem.d:3092 — D memsets to T.init
for (let z = 0; z < tempinst.tdtypes.length; z++)          // T.init for Objects is null
    tempinst.tdtypes.opIndexAssign(null, z);
```

D's call stays for diff fidelity; the loop supplies what the generic container cannot. The
comment names the D line and the element's `.init`. **Without the fill a grown slot reads
`undefined`, so `if (dedtypes[i])` takes the wrong branch** — a silent miscompile that compiles
and mostly passes. Live sites: `templatesem.d:3092/:3736/:4175/:4179`, `initsem.d:1488`,
`expressionsem.d:9225/:19158` (IsExp and overload `dedtypes`; the missing fill crashed `deduceType`
on every struct `new`), and every `dedtypes`/`dedargs` user in the frontend. Escalate only where the element type has no
unambiguous `.init` at the site.

**`length--` then `length++` does NOT restore the element.** D's `Array!T` keeps `length` as a
field over separate `data` storage (`array.d:29-31`), so a shrink-then-regrow leaves the old
element in place and D's save/restore idiom works; the port's setter truncates the backing JS
array **destructively**, and the regrown slot reads `undefined`. Live at
`templatesem.d:6654/:6656`. Port such an idiom by saving the element explicitly into a local
and writing it back, never by relying on the length round-trip.

#### 2.0b `[Symbol.iterator]` — `foreach` over an `Array` value

```ts
[Symbol.iterator](): Iterator<T> { return this.data[Symbol.iterator](); }  // delegate to backing array
```

So D `foreach (e; arr)` over an `Array` **value** lowers to `for (const e of arr)`.
`06-control-flow.md` "foreach over a container value" owns the loop-form rewrite; this
doc owns the `[Symbol.iterator]` that makes the `Array` iterable.

#### 2.0c `opIndexAssign` — element write through a ref-returning `opIndex`

D's `opIndex` returns `ref T`, so `arr[i] = v` is an *lvalue* assignment through the
returned reference. JS has no ref-return. Synthesize an explicit setter:

```ts
opIndex(i: number): T { /* assert i<length */ return this.data[i]; }   // ref T read
opIndexAssign(v: T, i: number): void { /* assert i<length */ this.data[i] = v; }  // arr[i] = v
```

`05-operators.md` "Synthesized opIndexAssign for a ref-returning opIndex" owns the
call-site rewrite (`arr[i] = v` → `arr.opIndexAssign(v, i)`, value-first arg order); this
doc fixes the method shape on `Array`.

### 2.1 Methods the frontend actually calls (grounded counts)

Grep of all `.<method>` call sites across `dmd/*.d`, `visitor/`, `mangle/`, `common/`:

| Method | call sites | TS signature | Semantics |
|---|---:|---|---|
| `.length` (read) | ~2152* | `get length(): number` | element count |
| `.length` (write) | — | `set length(n: number)` | resize: grow **without pre-fill** (no `T.init`, 2.0a), shrink truncates |
| `push(v)` | 644 | `push(v: T): this` | append; **returns `this`** (chaining: `a.push(x).push(y)`) |
| `copy()` | 222 | `copy(): Array<T>` | **shallow** element copy into a NEW `Array` (see 2.3) |
| `pop()` | 176 | `pop(): T` | remove + return last; asserts non-empty |
| `insert(i, …)` | 148 | overloaded, see 2.2 | insert at index |
| `remove(i)` | 110 | `remove(i: number): void` | delete element at `i`, shift left |
| `setDim(n)` | 70 | `setDim(n: number): void` | set length to `n` (grow **without pre-fill**, 2.0a) |
| `zero()` | 61 | `zero(): void` | raw-memory init; **no generic `T.init`** — grow-without-fill, default-dependence → escalate (2.0a) |
| `reserve(n)` | 48 | `reserve(n: number): void` | **no-op** in djs (capacity hint) |
| `tdata()` | 20 | `tdata(): T[]` | the backing JS array — a **LIVE** reference; writes through it are visible on the `Array` |
| `contains(v)` | 20 | `contains(v: T): boolean` | identity search (`is`), see 2.4 |
| `find(v)` | 14 | `find(v: T): number` | identity index, or **`SIZE_MAX`** if absent (2.4) |
| `pushSlice(a)` | 13 | `pushSlice(a: T[]): this` | append all of `a`; returns `this` |
| `append(a)` | 13 | `append(a: Array<T> \| null): this` | append another Array; returns `this` |
| `opSlice()` / `opSlice(a,b)` | 12 | `opSlice(): T[]` / `opSlice(a,b): T[]` | **COPY** of `[0..length)` or `[a..b)` — D's is a live slice; mutate-through needs `tdata()` (below) |
| `shift(v)` | 9 | `shift(v: T): void` | prepend at index 0 |
| `sort!(pred)` / `sort()` | 4 | `sort(pred?: (a:T,b:T)=>number): this` | in-place qsort; returns `this` (2.5) |
| `each!(cb)` | 2 | `each(cb: (e:T)=>void\|number): number` | expansion-safe iteration (2.6) |
| `arr[i]` (read) | — | `opIndex(i: number): T` | element read (ref `T` in D, 2.0c) |
| `arr[i] = v` | — | `opIndexAssign(v: T, i: number): void` | element write through ref-returning `opIndex` (2.0c) |
| `foreach (e; arr)` | — | `[Symbol.iterator](): Iterator<T>` | delegates to backing array; lowers to `for…of` (2.0b) |

\* `.length` count is inflated (built-in JS arrays/`OutBuffer`/`string` also match);
treat it as "always present". `.toChars`/`.toString` counts (3214/244) are dominated
by `RootObject`/`Identifier`, NOT `Array` — but `Array` does have `toString`/`toChars`
(2.7).

`reserve(n)` followed by an index write past `length` asserts in the port. D's release `opIndex`
(root/array.d:321, `data.ptr[i]`) writes into capacity that `length` and `foreach` never see.
Instance: doc.d:5087, a declared divergence.

**`opSlice()` returns a COPY, `tdata()` returns the LIVE backing array — and D's slices are
live.** The frontend writes back through them routinely, so this is not an edge case:
`arrayExpressionSemantic(Expression[] exps, …)` (`expressionsem.d:1923`) mutates the slice it
is handed, and every caller passes `peekSlice()`. The faithful rendering at a mutating call
site is **`tdata()`**:

| D at the call site                            | TS                                          |
|-----------------------------------------------|---------------------------------------------|
| `arr[]` read-only (compare, format, iterate)  | `arr.opSlice()`                             |
| `arr[]` written through by the callee         | `arr.tdata()`                               |
| `peekSlice(arr)` read-only                    | `peekSlice(arr)` (§2.8 — hands back a copy) |
| `peekSlice(arr)` written through by callee    | `arr.tdata()`                               |

Live instances: `visit(GenericExp)` (`expressionsem.d:15446/:15481`) and `initsem.d:1698`,
where writes to `elems` must be visible through the returned `elements`. Do not carry this over
to OutBuffer: `buf[]` → `opSliceAll()` genuinely IS a view there (§13a.2), and `Array` has no
`opSliceAll` at all — its whole-slice read is the no-arg `opSlice()`.

### 2.2 `insert` — four overloads (`array.d:235-276`)

D has four `insert`. Translate each to a distinctly-named-but-overloaded TS method.
Disambiguate by arity/type at the **call site** during translation (the agent knows
the static type), then pick the right body:

```ts
insert(index: number, a: Array<T> | null): void;     // array.d:235  (pointer overload)
insert(index: number, a: T[]): void;                 // array.d:248  (slice overload)
insert(index: number, v: T): void;                   // array.d:258  (single element)
insert(index: number, count: number, value: T): void;// array.d:267  (count copies of value)
```

Invariant: the (index, Array) and (index, T) overloads collide when `T` is itself a
number-ish type. Resolve by the **D static type at the call site** — if the source
arg is an `Array!T*`/`Array!T`, it's the Array overload; if a single `T`, the element
overload. Emit a one-line comment recording which overload was chosen when non-obvious.

**Nullable element types make the collision silent.** When `T` includes `null`, both
`insert(index, a: Array<T> | null)` and `insert(index, v: T)` accept `null`, TS picks the
first, and the implementation **no-ops on the array form** — so `tiargs.insert(j + i, arg)`
over an `Objects` silently drops a null slot instead of inserting it. At any single-element
site over a nullable `T`, call the unambiguous named form (`insertOne` / `insertArray`) rather
than relying on overload resolution.

### 2.3 `copy()` — shallow, returns a fresh `Array` (`array.d:314`)

```ts
copy(): Array<T> {
    const a = new Array<T>();
    a.setDim(this.length);
    for (let i = 0; i < this.length; i++) a.data[i] = this.data[i]; // memcpy = shallow
    return a;
}
```

Invariant: `Array.copy()` is a **shallow** copy of the *element slots* (D does a
`memcpy` of `T.sizeof * length`). For `T` = class reference (`Dsymbol`, `Expression`,
…) it copies the references, NOT the pointees. Do NOT deep-clone elements. (Distinct
from the struct `.copy()` of `03-value-semantics.md`: that is for value-type *elements*;
this is the container clone.) Note DMD's `copy()` returns a **pointer** `Array!T*`;
call sites then do `(*p)[i]` / `p.push(...)`. In djs a class is already a reference, so
`copy()` returns `Array<T>` and call sites drop the deref.

### 2.4 `find` / `contains` — identity, sentinel `SIZE_MAX` (`array.d:287-298`)

```d
size_t find(T ptr) const { foreach (i; 0..length) if (data[i] is ptr) return i; return size_t.max; }
bool contains(T ptr) const { return find(ptr) != size_t.max; }
```

```ts
find(v: T): number { for (let i = 0; i < this.length; i++) if (this.data[i] === v) return i; return SIZE_MAX; }
contains(v: T): boolean { return this.find(v) !== SIZE_MAX; }
```

Invariants:
- Search uses D `is` (identity). For class refs → JS `===`. For value-type elements
  this is the rare case; `find`/`contains` are overwhelmingly used on `Dsymbols`/
  `Expressions` (references). The per-`T` equality is **not** inlined into a generic body:
  route the comparison through `05-operators.md` "Operators on a generic type parameter"
  (for class refs it resolves to `===`; a struct-valued element would need a decision).
  If you meet `find`/`contains` on a struct-valued `Array`, STOP — `is` on a value type
  is by-bits and needs a decision.
- Not-found sentinel is **`size_t.max`** (2^64−1). In djs use the named constant
  `SIZE_MAX` from `09-numerics.md` "size_t.max and the SIZE_MAX sentinel" (it owns the
  exact value). Frontend tests `if (i != size_t.max)` — keep the comparison against
  `SIZE_MAX`. Do NOT use `-1` (`size_t` is unsigned; `09-numerics.md`).

### 2.5 `sort` (`array.d:374-387`)

Two forms: `sort!(pred)` with an explicit comparator, and `sort()` that uses the
element's `opCmp`. Both sort **in place** and return `this`.

```ts
// sort!(pred): comparator pe1,pe2 -> int  (C qsort convention: <0, 0, >0)
sort(pred?: (a: T, b: T) => number): this {
    if (this.length < 2) return this;
    // D passes POINTERS to elements; in djs pass the elements (refs) directly.
    const cmp = pred ?? ((a: T, b: T) => (a as any).opCmp(b)); // sort() form uses opCmp
    this.data.length = this.length;          // trim view to logical length before sorting
    this.data.sort(cmp);
    return this;
}
```

Invariants:
- The D predicate receives `const T*` (pointers); in djs it receives the **element**
  (a reference for classes, the value for value types). The frontend's predicates
  deref immediately (`*e1`, `pe1.opCmp(*pe2)`) — translate the deref away.
- The default `sort()` calls `T.opCmp` (operators are methods in the port —
  `05-operators.md`). UNVERIFIED whether `Array.prototype.sort` stability matches
  C `qsort` for the 4 frontend `sort` sites; qsort is **not stable** and JS sort is
  implementation-stable. If a tie-break ever changes diagnostic order, STOP. Probe the
  specific call site if a `fail_compilation` order test diverges.

### 2.6 `each!(callable)` (`array.d:680-788`) — expansion-safe iteration

Two template overloads: callback returning `void` (iterate all) and returning `int`
(stop when non-zero, return that value). Used where the array may grow *during*
iteration (re-reads `array.length` each step — does NOT cache it).

```ts
each(cb: (e: T) => number): number;   // int form:  array.d:772 — returns last non-zero, else 0
each(cb: (e: T) => void): void;       // void form: array.d:683
each(cb: (e: T) => void | number): void | number {
    for (let i = 0; i < this.length; ++i) {   // re-read .length each iteration (expansion-safe)
        const r = cb(this.data[i]);
        if (typeof r === "number" && r !== 0) return r;
    }
    return 0;
}
```

**The INT overload is declared FIRST, and the order is load-bearing.** TS resolves overloads
top-down and a number-returning callback is assignable to a void-returning parameter, so with
the void form first it always wins and `return arr.each(cb)` does not type-check at all
(reproduced on `attribsem.d:72/:78`). D's int form is the one the frontend's `each!` sites
actually use. Keep the int declaration above the void one; do not re-alphabetize them.

Invariant: MUST re-read `this.length` each step (not a cached bound, not `for-of`),
because callers append during iteration (`array.d:732` unittest). A plain `for-of` over
the JS array would be wrong here. This is the one case where the §2.0b `[Symbol.iterator]`
path (which a `foreach`/`for…of` would use) is NOT valid — `each!` call sites stay `each`,
do not collapse them to `for…of`.

### 2.7 `toString` / `toChars` (`array.d:71-138`)

Produces `[a,b,c]` by calling each element's `toString`/`toDString`, `null` → `"null"`.
`toDString` elements are double-quoted (`["a","b"]`, seplen 3); an element type with neither
method hits `assert(0)` (array.d:135). `toChars` returns the same bytes (NUL-terminated in D;
the DString stops before the NUL). Ported as per-`T` free functions in root/array.ts
(`toStringObjects`, `toCharsObjects`, `toStringExpressions`, `toCharsExpressions`,
`toStringArgumentLabels`, `toCharsArgumentLabels`; 07 §3.5(b)), not as generic methods.

### 2.8 Free functions in `array.d` (module-scope, not methods)

| D | TS | note |
|---|---|---|
| `peekSlice(Array!T* a)` (`:500`) | `peekSlice<T>(a: Array<T>\|null): T[]` | `a ? a.opSlice() : []` |
| `split(ref Array!T, index, length)` (`:513`) | `split<T>(a: Array<T>, i, n): void` | grow + shift right |
| `reverse(T[] a)` (`:559`) | `reverse<T>(a: T[]): T[]` | in-place reverse of a **plain slice** |

The range helpers `map`/`filter`/`equal`/`walkLength`/`front`/`empty`/`popFront`
(`array.d:895-1184`) are a **mini-Phobos range API**. Port lazily: implement a given
helper only when a translated frontend file imports it. Most are used in `unittest`
blocks (→ Vitest) or rarely. Do NOT pre-build the whole range machinery. If a frontend
file uses one, port that one faithfully; flag `map`/`filter` laziness if a CTFE path
depends on lazy evaluation semantics.

### 2.9 The typesafe-variadic constructor (`this(U)(U[] args...)` with `is(U==struct||class)`)

D's `Array` has a typesafe-variadic constructor that takes a heterogeneous-arity list of
elements, constrained to `is(U == struct) || is(U == class)`. This is **per-`T` template
machinery** — it cannot live on the single generic class body as a plain constructor. Port
it as a **named static factory declaring its own type parameter `<U>`**:

```ts
// Was: this(U)(U[] args...) if (is(U == struct) || is(U == class))
static from<U>(...args: U[]): Array<U> {                 // drop the is(struct||class) constraint
    const a = new Array<U>();
    for (const v of args) a.push(v);
    return a;
}
```

Invariant: **drop the `is(U == struct) || is(U == class)` capability constraint** — it is
satisfied by every relevant frontend instantiation (the variadic ctor is only ever called
with class refs / value structs), so it carries no runtime obligation in the port. If a
call site is found that would NOT satisfy the constraint, do NOT silently widen it —
escalate (`11-escalate.md`). The factory declares its own `<U>` so the call site keeps the
element type; route any per-element equality/ordering through `05-operators.md` "Operators
on a generic type parameter" if the body ever needs it (it does not for plain construction).

Consumers: all of Bucket 7 (the AST/sema core), `arraytypes` aliases (§3).

---

## 3. `arraytypes.d` — the array aliases

Pure type aliases (`arraytypes.d:28-58`). One line each. No runtime code.

BEFORE (`dmd/arraytypes.d:28-37`)

```d
alias Strings = Array!(const(char)*);
alias Identifiers = Array!(Identifier);
alias Expressions = Array!(Expression);
alias Dsymbols = Array!(Dsymbol);
alias Objects = Array!(RootObject);
// ...
```

AFTER (`djs/src/dmd/arraytypes.ts`)

```ts
export type Strings = Array<DString>;                  // const(char)* → DString (see §11)
export type Identifiers = Array<Identifier | null>;    // class elements are NULLABLE (below)
export type Expressions = Array<Expression | null>;
export type Dsymbols = Array<Dsymbol | null>;
export type Objects = Array<RootObject | null>;
// ...
```

Invariants:
- **Class-element aliases are `Array<T | null>`, uniformly (DECIDED).** Every D class
  reference is nullable and DMD genuinely stores null slots (blockexit.d:124/:164 exist only
  to skip them; `arraySyntaxCopy` fills with nulls). The element type says so. Reads that D
  dereferences unconditionally use `!` at exactly the site where D would fault (the same
  discipline as `02-types.md §10.1` for parameters); slot-null tests are the ordinary
  explicit `=== null` of `06-control-flow.md §2.7` — no carve-out needed. Do not
  special-case "surely never null here" aliases: uniformity is what keeps parallel agents
  deterministic.
- **By-VALUE struct elements take NO `| null`.** Four aliases hold structs by value —
  `ArgumentLabels` (expression.d:2373), `Ensures` (func.d:165), `Designators`/`DesigInits`
  (init.d:233/:245) — a value slot is not a reference and cannot be null. Do not re-derive
  this: the split is exactly reference-element (nullable) vs value-element (not).
- `Array!(const(char)*)` (`Strings`) → `Array<DString>`, non-nullable. The element IS a
  pointer, but the §11 byte-buffer domain mapping overrides pointer-nullability here: a
  D null `char*` element maps to the null-vs-empty DString model of the FIELD rules, and no
  frontend site stores a null `Strings` element (verified at the flip). When you meet the
  next `T*` element type, the tie-break is: does a domain mapping (§11 strings, §13 buffers)
  replace the pointer? If yes, that mapping's nullability governs; if no, pointer rules do.
- `Array!(BaseClass*)` → `Array<BaseClass | null>` — `BaseClass` is a **struct**
  (dclass.d:36); the element is a POINTER to it, and a pointer is nullable (02 §10, 03 §7).
  Do not generalize "element written `T*` = class ref": the nullability comes from the
  pointer, whatever `T` is.
- **Construction sites must use the alias's element type — tsc will NOT catch a violation.**
  TS method-parameter bivariance lets `new DArray<Dsymbol>()` flow into a slot declared
  `Dsymbols` (= `Array<Dsymbol | null>`) silently; the narrow spelling then lurks until two
  containers meet. Rule: a container whose declared/returned type is an alias is CONSTRUCTED
  as that alias (`const a: Dsymbols = new DArray<Dsymbol | null>()`); self-gate grep:
  every `new DArray<`/`new Array<` whose target is alias-typed names the alias's element.
- This module sits in the core SCC (it imports the AST node modules); use
  `import type` for the element types per `01-conventions.md`. The aliases themselves
  emit nothing at runtime, so the cycle is type-only — safe.

Consumers: virtually every Bucket-7 module.

---

## 4. `BitArray` (`dmd/root/bitarray.d`)

A dynamic bit vector backed by `size_t` chunks. Used in flow analysis (`escape`, `ob`,
`statementsem` reachability). **Canonical model: a `Uint8Array` (or `Uint32Array`) of
bits, length tracked separately in bits.** The chunk size is an implementation detail —
choose `Uint32Array` (matches JS bit-op width; avoids BigInt).

BEFORE (`dmd/root/bitarray.d:54-71`)

```d
bool opIndex(size_t idx) const { assert(idx < len); return !!bt(ptr, idx); }
void opIndexAssign(bool val, size_t idx) { assert(idx < len); if (val) bts(ptr, idx); else btc(ptr, idx); }
```

AFTER (`djs/src/dmd/root/bitarray.ts`)

```ts
export class BitArray {
    private len = 0;                 // length in BITS
    private words = new Uint32Array(0);

    get length(): number { return this.len; }
    set length(nlen: number) { /* realloc words to ceil(nlen/32), zero new, mask tail */ }

    // Operator method names are owned by 05-operators.md (the naming + call-site-rewrite
    // authority); these match its canonical table (opIndex/opIndexAssign/opAssign/opEquals).
    opIndex(idx: number): boolean { /* assert idx<len */ return (this.words[idx>>>5] & (1 << (idx & 31))) !== 0; }
    opIndexAssign(val: boolean, idx: number): void { /* assert idx<len; NOTE arg order (value, index) */
        const w = idx>>>5, b = 1 << (idx & 31);
        if (val) this.words[w] |= b; else this.words[w] &= ~b;
    }
    opAssign(b: BitArray): void { /* opAssign: bitarray.d:46 — copy len+bits */ }
    opEquals(b: BitArray): boolean { /* opEquals: bitarray.d:73 — len==b.len && words equal */ }
    zero(): void { this.words.fill(0); }
    isZero(): boolean { return this.words.every(w => w === 0); }
    or(b: BitArray): void { /* assert same len; word-wise |= */ }
    swap(b: BitArray): void { /* assert same len; swap word contents */ }
}
```

Invariants / operator rewrites (`05-operators.md` owns the canonical method names AND the
call-site rewrite policy — the method names above match its table verbatim):
- `ba[i]` (read) → `ba.opIndex(i)`; `ba[i] = v` → `ba.opIndexAssign(v, i)` (value-first
  arg order, per `05-operators.md` §7). (`opIndex` `bitarray.d:54` / `opIndexAssign` `:62`)
- `a = b` on `BitArray` → `a.opAssign(b)` (it is `opAssign`, `bitarray.d:46`, with the
  "size to b if empty" quirk — preserve it: assigning into an empty BitArray adopts
  `b`'s length).
- `a == b` → `a.opEquals(b)` (`bitarray.d:73`).
- **druntime intrinsics → word+mask arithmetic.** DMD's `opIndex`/`opIndexAssign` bodies
  call `bt`/`bts`/`btc` (`import core.bitop`, `bitarray.d:56`/`:64`). They map directly to
  arithmetic over the `Uint32Array` (32-bit word index `i>>>5`, bit mask `1 << (i&31)`):
  - `bt(ptr, i)`  → `(words[i>>>5] & (1 << (i & 31))) !== 0`   (test bit)
  - `bts(ptr, i)` → `words[w] |= mask`                          (set bit)
  - `btc(ptr, i)` → `words[w] = (words[w] & ~mask) >>> 0`       (clear bit; `>>>0` keeps it
    an unsigned 32-bit value — `&= ~mask` already does this for the live store above).
- `length` setter MUST mask the tail word so bits beyond `len` read as 0 (the `&=` at
  `bitarray.d:42` — the frontend relies on `isZero`/`equals` not seeing stray high bits).
- `length` setter grows by **zeroing** new chunks (`bitarray.d:40`).
- The destructor (`~this`, `bitarray.d:120`) is GC cleanup + debug stomping → **drop**.

Use `Uint32Array` so `get`/`set`/`or` use JS 32-bit bit ops directly. Do NOT use
`size_t` (64-bit) chunks — that would force BigInt for no benefit; bit positions are
indices (`number` domain, `09-numerics.md`).

Consumers: `escape.d`, `ob.d`, `statementsem.d`, `func.d` (Bucket 7e/7c).

---

## 5. `StringTable!T` (`dmd/root/stringtable.d`) — string-keyed hash map

The frontend's primary symbol-name table: `Identifier` interning, module symbol
tables, etc. 277 `._init`, 142 `.insert`, 26 `.lookup` call sites. **Canonical model: a
JS `Map<string, StringValue<T>>` keyed by the UTF-8 byte sequence rendered as a key
string** — see invariant below.

BEFORE (`dmd/root/stringtable.d:130-173`)

```d
inout(StringValue!T)* lookup(scope const(char)[] str) inout { /* hash + findSlot */ }
StringValue!(T)* insert(scope const(char)[] str, T value) { /* null if already present */ }
StringValue!(T)* update(scope const(char)[] str) { /* insert-or-get with T.init */ }
```

AFTER (`djs/src/dmd/root/stringtable.ts`)

```ts
export class StringValue<T> {
    value!: T;
    private readonly bytes: Uint8Array;     // the interned key bytes (a copy)
    constructor(bytes: Uint8Array, value: T) { this.bytes = bytes; this.value = value; }
    len(): number { return this.bytes.length; }
    toDchars(): DString { return this.bytes; }     // pointer to the chars
    toString(): DString { return this.bytes; }
}

export class StringTable<T> {
    private map = new Map<string, StringValue<T>>();
    _init(_size = 0): void {}                       // capacity hint → no-op
    reset(_size = 0): void { this.map.clear(); }

    // Returns the entry or null. str is a DString (byte slice).
    lookup(str: DString): StringValue<T> | null { return this.map.get(keyOf(str)) ?? null; }

    // Returns the new entry, or null if the key was ALREADY present (insert is no-clobber).
    insert(str: DString, value: T): StringValue<T> | null {
        const k = keyOf(str);
        if (this.map.has(k)) return null;
        const sv = new StringValue<T>(copyBytes(str), value);
        this.map.set(k, sv);
        return sv;
    }

    // Insert-or-get. D inserts with T.init if absent — but there is NO generic T.init
    // in the port (container-generics decision, §2.0). Either special-case at the known
    // T (StringTable is instantiated over a small, fixed set of value types), or escalate
    // (11). Never synthesize a generic default. See invariant below.
    update(str: DString): StringValue<T> { /* getOrCreate; T-default -> special-case at known T or escalate */ }

    // Iterate all entries; cb returns non-zero to stop (returns that value).
    apply(cb: (sv: StringValue<T>) => number): number { /* foreach map, stop on non-zero */ }
    opApply(cb: (sv: StringValue<T>) => number): number { return this.apply(cb); }
}
```

Invariants — **these are contract-critical**:
- **`insert` is no-clobber**: returns `null` if the key already exists, otherwise the
  new `StringValue`. The frontend relies on the `null` return to detect "already
  interned" (`stringtable.d:162`). Do NOT overwrite on duplicate insert.
- **`update` is insert-or-get** with `T.init` (`stringtable.d:181`): never returns null.
  But the container-generics decision (§2.0) forbids a synthesized generic `T.init`. The
  `T`-default needed by `update`/`getOrCreate` MUST be resolved by **special-casing at the
  known `T`** (`StringTable` is instantiated over a small fixed set of value types) **or
  escalating** (`11-escalate.md`) — **never** by guessing a generic default. If the chosen
  `T`'s default is unambiguous (e.g. a numeric/enum value type), special-case it at that
  instantiation; otherwise STOP.
- **The key is the raw byte sequence**, compared by *bytes and length*, not by decoded
  text (`stringtable.d:292` does `memcmp`). `keyOf(bytes)` must produce a string that is
  injective over byte sequences. Use a Latin-1 decode (`String.fromCharCode(...bytes)`)
  so each byte maps to one BMP code unit and equal byte sequences ⇒ equal keys.
  Do NOT UTF-8-decode the key (two different byte sequences could collide). Flag if a
  call site keys on something other than identifier bytes.
- **`StringValue` stores a COPY of the key bytes** (`stringtable.d:268` copies; the
  caller's buffer is transient). `copyBytes` = `str.slice()`.
- `_init`/`reset` size args are capacity hints → ignore (Map grows itself).
- **Iteration order:** DMD's table uses open-addressing with quadratic probing; its
  `apply`/`opApply` order is *hash-bucket order*, NOT insertion order. JS `Map`
  iterates in **insertion order**. This is an observable difference IF a diagnostic or
  output lists table contents. The `stringtable.d:407` unittest explicitly says "Order
  of string table iteration is not specified". **Decision (FLAG for synthesis):** djs
  uses insertion order (Map default). If any `fail_compilation`/`compilable` test
  asserts a specific multi-symbol order that depends on string-table iteration, STOP
  and escalate — we may need to reproduce bucket order. Probe needed only if such a
  test surfaces.
- `StringValue.value` is mutated in place by callers (`sv.value = ...`) — keep it a
  public mutable field.
- **Substituting a JS container for a D one is a recorded act, not a silent one.** Whenever a
  reimplementation swaps the engine (Map for open-addressing here; Map for the aav table, §6;
  a JS array sort for qsort, §2.5), the module's header comment MUST (a) name the observable
  divergence (iteration order, sort stability), and (b) name every consumer that enumerates
  the container, checked at substitution time. If any consumer's output is order-sensitive,
  the divergence gets a pinned test (`10-tests-diagnostics.md`) — never discovered later by a
  corpus diff.

Consumers: `identifier.d` (interning), `dsymbol.d` symbol tables, `dmodule.d`,
`stringtable` users across Bucket 7. The `_init` call (277 sites) is mostly
construction — in djs, construction is `new StringTable<T>()`, and `_init` is a no-op
method kept for diff-fidelity.

---

## 6. `AssocArray!(K,V)` / `aav` (`dmd/root/aav.d`) — pointer-keyed map

A void*-keyed associative array (`aav.d:275`). Keys are object identities
(`Dsymbol`, `Type`, …), values arbitrary. Used for caches/dedup (template instance
cache, etc.). **Canonical model: a JS `Map<K, V>`** keyed by object identity (JS `Map`
uses SameValueZero — object identity for references; exactly D's `void*` key `==`).

BEFORE (`dmd/root/aav.d:297-313`)

```d
V* getLvalue(const(K) key) { return cast(V*)dmd_aaGet(&aa, cast(void*)key); }  // add-if-absent, addr of slot
V opIndex(const(K) key) { return cast(V)dmd_aaGetRvalue(aa, cast(void*)key); } // null if absent
@property size_t length() const { return dmd_aaLen(aa); }
```

AFTER (`djs/src/dmd/root/aav.ts`)

```ts
export class AssocArray<K, V> {
    private map = new Map<K, V>();
    get length(): number { return this.map.size; }

    // D returns the ADDRESS of the value slot (so caller can write *p = x).
    // JS has no address-of. Replace the get-then-write idiom with get/set (see invariant).
    get(key: K): V | null { return this.map.get(key) ?? null; }            // opIndex
    has(key: K): boolean { return this.map.has(key); }
    set(key: K, value: V): void { this.map.set(key, value); }              // *getLvalue(k) = v
    getOrSet(key: K, makeDefault: () => V): V {                            // getLvalue then read/write
        let v = this.map.get(key);
        if (v === undefined) { v = makeDefault(); this.map.set(key, v); }
        return v;
    }
    *asRange(): IterableIterator<[K, V]> { yield* this.map.entries(); }     // KeyValue range
}
```

Invariants — **the `getLvalue` address pattern is the trap**:
- D's `getLvalue` returns a **pointer to the value slot**; the call site then writes
  `*p = something`. JS has no pointer-to-slot. At each `getLvalue` call site the agent
  MUST rewrite the read/write pair: `auto p = aa.getLvalue(k); *p = v;` becomes
  `aa.set(k, v)`; `auto p = aa.getLvalue(k); if (!*p) *p = make();` becomes
  `aa.getOrSet(k, make)`. This is a per-call-site transform, not a mechanical method
  rename. If a `getLvalue` site does something other than a simple read/conditional-set
  through the pointer, STOP and escalate.
- `opIndex` returns the value or **null** if absent (NOT add-on-read). Map `get` → null
  coalesce.
- Keys are **identity** (D `void*` `==`). JS `Map` with object keys is identity —
  matches. Do NOT stringify keys.
- The aav hash function (`aav.d:19`) is internal to DMD's open-addressing impl; since
  djs uses `Map`, you do NOT port `aav.hash`/`dmd_aaRehash`/`AA`/`aaA`. They are
  implementation detail. (Probed parity in §0.3-style anyway: `aav.hash` matches a
  masked-BigInt JS impl exactly — but it is unneeded since `Map` replaces the engine.)
- Iteration order: same FLAG as StringTable §5 — `Map` is insertion order; DMD's is
  bucket order. The `aav.d:199` unittest checks membership, not order. STOP if an
  observable order diverges.

Consumers: `dtemplate.d` (instance cache), `dinterpret.d` (CTFE), `typesem.d`, others
in Bucket 7.

---

## 7. `utf.d` (`dmd/root/utf.d`) — UTF-8/16/32 — CRITICAL for the byte-oriented lexer

The lexer reads source as **bytes** and decodes code points on demand (`_probes.md §5`:
D strings are byte arrays). This module is the decode/encode kernel. The API is small
and **must be reproduced exactly**, including the error-message strings (they appear in
`fail_compilation` diagnostics). All inputs/outputs are byte arrays + code points
(`number`); nothing here is a JS string.

### 7.1 Exact API (`djs/src/dmd/root/utf.ts`)

| D signature | TS signature | semantics |
|---|---|---|
| `bool utf_isValidDchar(dchar c)` (`:18`) | `utf_isValidDchar(c: number): boolean` | valid if `<0xD800` or `0xDFFF<c<=0x10FFFF` |
| `int utf_codeLengthChar(dchar c)` (`:33`) | `utf_codeLengthChar(c: number): number` | 1/2/3/4 by range; `assert(false)` above 0x10FFFF |
| `int utf_codeLengthWchar(dchar c)` (`:46`) | `utf_codeLengthWchar(c: number): number` | `c<=0xFFFF ? 1 : 2` |
| `int utf_codeLength(int sz, dchar c)` (`:55`) | `utf_codeLength(sz: number, c: number): number` | dispatch on `sz` (1/2/4) |
| `void utf_encodeChar(char* s, dchar c)` (`:65`) | `utf_encodeChar(s: Uint8Array, off: number, c: number): void` | write UTF-8 bytes at `s[off..]` |
| `void utf_encodeWchar(wchar* s, dchar c)` (`:95`) | `utf_encodeWchar(s: Uint16Array, off: number, c: number): void` | write UTF-16 units |
| `void utf_encode(int sz, void* s, dchar c)` (`:110`) | (port per call site) | dispatch by `sz`; rare |
| `bool isBidiControl(dchar c)` (`:127`) | `isBidiControl(c: number): boolean` | switch over the bidi range |
| `string utf_decodeChar(const(char)[] s, ref size_t ridx, out dchar rresult)` (`:152`) | see 7.2 | UTF-8 decode, returns error msg or null |
| `string utf_decodeWchar(const(wchar)[] s, ref size_t ridx, out dchar rresult)` (`:274`) | analogous | UTF-16 decode |

### 7.2 `utf_decodeChar` — the `ref`/`out` parameter contract

D uses `ref size_t ridx` (in/out cursor) and `out dchar rresult` (decoded point), and
**returns the error message string (or `null` on success)**. JS has no `ref`/`out`.
Canonical translation: return an object; caller destructures.

BEFORE (`dmd/root/utf.d:152` signature + `:213`/`:260`-`:262`)

```d
string utf_decodeChar(const(char)[] s, ref size_t ridx, out dchar rresult) {
    // ... ridx advances by the number of code units consumed; rresult = code point ...
    return UTF8_DECODE_OK; // == null on success, else the error message
}
```

AFTER (`djs/src/dmd/root/utf.ts`)

```ts
export interface DecodeResult {
    nextIdx: number;          // updated cursor (was ref ridx)
    dchar: number;            // decoded code point (was out rresult)
    error: DString | null;    // null on success; else the EXACT error message bytes
}
// s: the source bytes; idx: starting index. Returns the consumed cursor + point + error.
export function utf_decodeChar(s: Uint8Array, idx: number): DecodeResult { ... }
```

Invariants — **must reproduce DMD exactly**:
- The six error strings are diagnostic text and MUST match verbatim (`utf.d:155-160`):
  `"Outside Unicode code space"`, `"Truncated UTF-8 sequence"`, `"Overlong UTF-8
  sequence"`, `"Invalid trailing code unit"`, `"Invalid code point decoded"`, and
  success = `null`. Carry them as `DString` constants. The lexer prints these.
- The `UTF8_STRIDE[256]` table (`utf.d:171-210`) is data — copy it byte-for-byte
  (1-byte ASCII, 0xFF for continuation/invalid leads, 2/3/4/5/6 for multibyte leads).
- On the **error path**, DMD still advances `ridx` by 1 (the `size_t i = ridx++` at
  `:213` runs before any error return) and sets `rresult = u` (the raw lead byte). So
  `nextIdx = idx+1` and `dchar = s[idx]` on most error returns; on success `nextIdx`
  is `idx + n`. Reproduce the exact cursor arithmetic — the lexer uses `ridx` to
  resync after a bad byte. Read `utf.d:213-262` and mirror the index updates precisely.
- Overlong-encoding rejection (`utf.d:248`) and the trailing-byte `(u3 & 0xC0)!=0x80`
  check (`:254`) are correctness-critical. Translate the bit logic literally; the bit
  ops are all in the 32-bit `number` domain (code points ≤ 0x10FFFF).
- `utf_decodeWchar` is rarely hit (the frontend is UTF-8) but port it for completeness;
  same `DecodeResult` shape over a `Uint16Array`.

Consumers: `lexer.d` (the big one), `utils.d`, `dmodule.d` (BOM/encoding detection),
`hdrgen.d`, anywhere source text is decoded. **This is the highest-risk runtime module
for correctness** — a wrong cursor or error string breaks many lexer diagnostics.

Cross-ref: `02-types.md` for the `dchar`/`char[]`/byte-array model; this doc owns the
decode/encode functions.

---

## 8. `string.d` (`dmd/root/string.d`) — D string helpers

Byte-string utilities. All operate on `DString` (byte arrays), not JS strings.

| D | TS | semantics |
|---|---|---|
| `toDString(const(char)* s)` (`:17`) | `toDString(s: DString \| null): DString` | slice a C-string to its NUL; in djs a `DString` already excludes NUL → identity/null-guard |
| `iequals(s1, s2)` (`:57`) | `iequals(a: DString, b: DString): boolean` | ASCII case-insensitive byte compare |
| `toCString(s)` (`:122`) | `toCString(s: DString): DString` | copy + append NUL — see invariant |
| `toCStringThen!(dg)(src)` (`:93`) | `toCStringThen<R>(src: DString, dg: (z: DString) => R): R` | NUL-terminate then call dg |
| `stripLeadingLineTerminator(str)` (`:148`) | `stripLeadingLineTerminator(s: DString): DString` | strip one leading EOL (incl `\r\n`, NEL, LS, PS) |
| `dstrcmp(s1, s2)` (`:219`) | `dstrcmp(a: DString, b: DString): number` | strcmp result (<0/0/>0), byte compare |
| `toStaticArray!(N)(literal)` (`:268`) | (resolve at translation time) | append NUL to a string literal; CT helper |
| `startsWith(p, needle)` / `startsWith(str, prefix)` (`:304`/`:320`) | `startsWith(s: DString, prefix: DString): boolean` | byte prefix test |
| `splitLines(text)` (`:350`) | `splitLines(text: DString): Iterable<DString>` | line iterator (handles all Unicode EOLs) |
| `findSplit(str, needle)` (`:471`) | `findSplit(s, needle): FindSplit` | 3-part split; truthy iff found |
| `findBetween(str, l, r)` (`:507`) | `findBetween(s, l, r): DString \| null` | substring between two needles |

Invariants:
- Everything is **byte-level** (the doc comments stress "no UTF-8 decoding",
  `string.d:46`/`:214`). `iequals`/`dstrcmp` compare raw bytes; `toupper` is the C
  ASCII one (only A–Z). Use a byte-level `toUpperAscii` (`b >= 0x61 && b <= 0x7A ?
  b - 0x20 : b`), NOT JS `.toUpperCase()`.
- `dstrcmp` has a `__ctfe` branch (`string.d:222`) that is byte-equal to the runtime
  `memcmp` branch for ASCII; collapse to one byte-compare (the CT/runtime distinction
  is a D purity artifact — resolve away, `07-compile-time.md` style). Returns
  `s1.length < s2.length ? -1 : (s1.length > s2.length)` for the equal-prefix case —
  preserve the exact `0/1/-1` shape (it feeds `qsort`/`opCmp`).
- `toCString`/`toCStringThen` exist to bridge to C APIs (NUL termination). In djs they
  mostly disappear at call sites that called C functions we replace with Node APIs
  (`file.d`/`filename.d`). Where a frontend file still uses `toCStringThen` to build a
  buffer it indexes, keep it (append a `0` byte). Flag if a call site relies on the NUL
  being *in* the slice length (it is not — the NUL is past `.length`).
- `findSplit` returns a `FindSplit` (`string.d:453`) with 3 slices and a `bool` cast
  (`opCast` → truthy when the middle slice is non-empty). Model as
  `class FindSplit { elem: [DString, DString, DString]; found(): boolean }` and rewrite
  `if (auto s = findSplit(...))` → `const s = findSplit(...); if (s.found())`
  (`05-operators.md` owns `opCast`-to-truthy rewrites).
- `splitLines` is a lazy range in D; a `function*` generator yielding `DString` line
  slices is the canonical port. Reproduce the exact EOL handling (`\v \f \n \r \r\n`,
  NEL `C2 85`, LS `E2 80 A8`, PS `E2 80 A9`) — it is byte-pattern matching, not decode.

Consumers: `lexer.d`, `filename.d`, `utils.d`, `dmodule.d`, diagnostics.

---

## 9. `hash.d` (`dmd/root/hash.d`) — MurmurHash2 + mixHash

**Used by `StringTable` and as a general hash.** Since `StringTable`/`aav` are
re-implemented over JS `Map` (§5, §6), `calcHash`/`mixHash` are only needed where the
frontend calls them **directly** (a handful of sites). When needed, parity is exact.

VERIFIED (probe `/tmp/probe_hash.d`, `/tmp/probe_aav.d` against local ldc2):

`calcHash` (32-bit MurmurHash2) reproduced bit-for-bit in JS using `Math.imul` + `>>>0`:

```ts
// djs/src/dmd/root/hash.ts — VERIFIED: matches ldc2 calcHash exactly
export function calcHash(data: Uint8Array): number {
    const m = 0x5bd1e995, r = 24;
    let h = data.length >>> 0;
    let i = 0;
    const n = data.length;
    while (n - i >= 4) {
        let k = ((data[i+3]<<24) | (data[i+2]<<16) | (data[i+1]<<8) | data[i]) >>> 0;
        k = Math.imul(k, m) >>> 0;
        k = (k ^ (k >>> r)) >>> 0;
        h = (Math.imul(h, m) ^ Math.imul(k, m)) >>> 0;
        i += 4;
    }
    switch ((n - i) & 3) {
        case 3: h = (h ^ (data[i+2] << 16)) >>> 0;   // falls through (D goto case)
        case 2: h = (h ^ (data[i+1] << 8)) >>> 0;    // falls through
        case 1: h = (h ^ data[i]) >>> 0; h = Math.imul(h, m) >>> 0; // falls through to default
        default: break;
    }
    h = (h ^ (h >>> 13)) >>> 0; h = Math.imul(h, m) >>> 0; h = (h ^ (h >>> 15)) >>> 0;
    return h >>> 0;
}
```

Probe outputs (D == JS): `calcHash("0123456789") = 439272720`, `calcHash("foo") =
2414502773`, `calcHash("") = 0`. Matches the `hash.d:67` unittest (`439_272_720`).

Invariants:
- The `switch` uses **fall-through** (D `goto case`/`goto default`). The TS `switch`
  above intentionally omits `break` in cases 3/2/1 — keep it (it is the literal
  translation). Add a `// fall through` comment per case so it is not "fixed".
- `mixHash(h, k)` (`hash.d:74`) is **64-bit** (`size_t`). VERIFIED it reproduces with
  masked BigInt: `mixHash(0xDE001540, 0xF5711A47) = 247315954704` (D == JS). It lives in
  the **BigInt domain** (`09-numerics.md`):
  ```ts
  export function mixHash(h: bigint, k: bigint): bigint {
      const M = (1n << 64n) - 1n;
      return (h ^ ((k + 0x9e3779b9n + ((h << 6n) & M) + (h >> 2n)) & M)) & M;
  }
  ```
  The `hash.d:82` unittest checks `& uint.max` because on 32-bit targets `size_t` is
  32-bit — but our target is 64-bit (`_ground-truth.md §6`), so `mixHash` is 64-bit.
- `calcHash` is the **32-bit `number`** form; `mixHash` is the **64-bit BigInt** form.
  Do not unify them. Cross-ref `09-numerics.md` for which calling sites are in which
  domain.

### 9.1 `hashOf` / `mixHash(number, number)` — the port's `toHash` helpers (CANONICAL HOME)

This subsection is the canonical home for the djs runtime hash helpers that emitted
`toHash` methods call. They are **NOT** a faithful clone of druntime `hashOf` — they are
the port's own content hash, **built on the verified `calcHash` (MurmurHash2)**. They
live in `djs/src/dmd/root/hash.ts` alongside `calcHash`/`mixHash(bigint)`.

```ts
// djs/src/dmd/root/hash.ts — VERIFIED against ldc2-1.43.0 (pinned in the co-located test)
export function hashOf(x: number | bigint | DString, seed = 0): number;  // -> unsigned 32-bit
export function mixHash(a: number, b: number): number;                   // 32-bit combine (overload)
```

`hashOf(x, seed=0)` hashes a `number`, a 64-bit `bigint`, or a `DString` (byte slice) to
an unsigned 32-bit `number`:
- `number` → its **4 little-endian bytes** through `calcHash` (`u32le(x>>>0)`).
- `bigint` → its **8 little-endian bytes** (`BigInt.asUintN(64)` masks to range) through
  `calcHash` (target `size_t` is 8 bytes, `09-numerics.md §8`).
- `DString` (`Uint8Array`) → `calcHash(x)` directly (D char-slice is bytes, §0). With
  `seed == 0`, `hashOf(bytes) === calcHash(bytes)`.
- `seed != 0` folds via `mixHash32` (`mixHash(seed, base)`), so a composite key chains:
  `h = hashOf(field2, hashOf(field1))`.

Invariants:
- **`mixHash` is OVERLOADED across two numeric domains** (resolution #1). The 32-bit
  `mixHash(a: number, b: number): number` is the runtime combiner the emitted `toHash`
  methods use (one MurmurHash2 word-mix of `b` into `a` + the final avalanche, on the
  verified `calcHash` constants). It coexists with the 64-bit `mixHash(h: bigint, k:
  bigint): bigint` boost combine documented above. The overload **signatures forbid a
  mixed call** (`number`+`bigint`); the impl dispatches on `typeof a`. Do NOT unify them
  — different algorithms, different domains, same public name only.
- **`hashOf` is the port's helper, NOT druntime `hashOf`.** VERIFIED they differ:
  druntime `hashOf("0123456789") == 1891213601` (a different SMHasher path) and druntime
  `hashOf(uint)` is the IDENTITY, whereas the port's `hashOf("0123456789") == 439272720`
  (== `calcHash`). So **do NOT** translate a frontend druntime-`hashOf` call into this
  helper expecting bit-parity with druntime. Where the original D `toHash` is pinned to a
  cheap identity (e.g. `Loc.toHash` returns `index` directly, `location.ts:204`), the port
  reproduces that identity in place and **does not** route through `hashOf`. This helper is
  for the `toHash` sites that need a real **content** hash of a key.
- Preconditions (NOT enforced — caller contract, `boundary-validation.md`): a `number`
  argument is coerced to unsigned 32-bit (`>>> 0`); a `bigint` is masked to unsigned
  64-bit. Returns an unsigned 32-bit integer.
- VERIFIED (ldc2-1.43.0, pinned): `hashOf("0123456789") == 439272720`,
  `hashOf(42) == 1483788722`, `hashOf(42n) == 3219936211`.

Consumers: direct callers of `calcHash`/`mixHash` (e.g. `dtemplate.d` instance
hashing, `mtype.d` type hashing) and emitted `toHash` methods that hash a content key.
The `StringTable`-internal use is gone (§5).

---

## 10. `optional.d` (`dmd/root/optional.d`) — `Optional!T`

A simple present/absent wrapper (`optional.d:42`). **Canonical model: a small class**
(NOT `T | null` / `T | undefined`), because `Optional!int(0)` and `Optional!T` of a
nullable `T` must distinguish "present-with-falsy-value" from "empty". Using
`null`/`undefined` would conflate `Optional!bool(false)` etc.

BEFORE (`dmd/root/optional.d:42-89`)

```d
extern (C++) struct Optional(T) {
    private T value; private bool present;
    this(T value) { this.value = value; this.present = true; }
    static Optional!T create(T val) { return Optional!T(val); }
    bool isPresent() const { return this.present; }
    bool isEmpty() const { return !this.present; }
    inout(T) get() inout { assert(present); return value; }
    bool hasValue(const T exp) const { return present && value == exp; }
}
```

AFTER (`djs/src/dmd/root/optional.ts`)

```ts
export class Optional<T> {
    private constructor(private readonly value: T | undefined, private readonly present: boolean) {}
    static empty<T>(): Optional<T> { return new Optional<T>(undefined, false); }
    static of<T>(value: T): Optional<T> { return new Optional<T>(value, true); }  // = create / this(value)
    isPresent(): boolean { return this.present; }
    isEmpty(): boolean { return !this.present; }
    get(): T { assert(this.present); return this.value as T; }                    // assert(present)
    hasValue(exp: T): boolean { return this.present && this.value === exp; }       // value == exp
}
```

Invariants:
- `Optional!T()` (default) → `Optional.empty<T>()`. `Optional!T(v)` / `.create(v)` →
  `Optional.of(v)`. Map both `this(value)` and `static create` to `of` (they are the
  same — `create` is a C++-interop ctor wrapper, `optional.d:61`).
- `get()` on empty asserts (`optional.d:81`) → throw (`assert`, §12). The
  `optional.d:16` unittest asserts that `get()` on empty throws `AssertError` — Vitest
  must see a throw.
- `hasValue` uses `==` (value equality, `optional.d:88`). For `T` a primitive →
  `===`. For `T` an object/struct it would be reference/struct equality — the frontend
  uses `Optional` mainly over `bool`/`int`/enums (e.g. `Optional!bool` alignment,
  pragma results), so `===` is right. If you meet `Optional!Struct`, STOP.
- `Optional` is a **struct** (value type) in D. As a field it is copied on struct copy
  (`03-value-semantics.md`). Because this `Optional` is **immutable after construction**
  (all fields `readonly`, no mutators), sharing the instance is safe — a value copy of
  an immutable value is indistinguishable from sharing. So `.copy()` of a struct
  containing an `Optional` may share the same `Optional` instance. (This is the one
  place a value type can be safely shared — note it explicitly.)

Consumers: `target.d` (`Optional!bool` for alignment/feature queries), `pragmasem.d`,
`func.d`, scattered. Low volume.

---

## 11. `DString` — the byte-string alias (runtime-wide)

D's `string` / `const(char)[]` / `char[]` / `immutable(char)[]` are all UTF-8
**byte arrays** (`_probes.md §5`). The runtime defines one alias and uses it everywhere
a D char-slice appears. `02-types.md` owns the *type mapping*; this doc fixes the
runtime **alias name and constructor helpers** the rest of the runtime references.

```ts
// djs/src/dstring.ts
export type DString = Uint8Array;                          // a D char-slice = bytes

// Build a DString from an ASCII/Latin-1 JS string literal (for the frontend's many
// string literals, which are ASCII). Multi-byte literals must already be UTF-8 bytes.
export function ds(literal: string): DString { ... }       // ASCII/Latin-1 fast path
export function dsUtf8(s: string): DString { return new TextEncoder().encode(s); }
export function dsToJs(s: DString): string { return new TextDecoder().decode(s); }  // for display only
export function dsEquals(a: DString, b: DString): boolean { ... }                   // byte compare
```

Invariants:
- A frontend string literal `"foo"` becomes `ds("foo")` (ASCII → one byte per char).
  Diagnostic strings with non-ASCII (rare) → `dsUtf8`.
- `DString` is `Uint8Array`, so `.length` is byte count and `s[i]` is a byte (0–255) —
  exactly D's semantics. **Never** compare `DString`s with `===` (that is reference
  equality on `Uint8Array`); use `dsEquals` / `dstrcmp`. (Cross-ref `05-operators.md`:
  D `s1 == s2` on char-slices → `dsEquals`.)
- `dsToJs` is for **display/Node-API boundaries only** (printing, fs paths). Never use
  it inside lexer/parser logic — that would re-introduce JS UTF-16 length mismatch.

Consumers: every module here and most of Bucket 7. This alias is the backbone of the
byte-oriented model; agree on it before porting any string-touching code.

---

## 12. `assert` — runtime assertion + abort + exception hierarchy

The frontend has 2428 `assert(...)` (`_ground-truth.md §4`) and many `assert(0)` /
`assert(false)` "unreachable" markers. The runtime provides the helpers AND D's
`Throwable`/`Exception`/`Error` class hierarchy (06 §8.3 mandates the classes live here);
the *policy* (crash-only, recoverability) is project-level (`crash-only-recovery.md`).

**Where it lives.** `djs/src/assert.ts` — a sibling of `src/dstring.ts` / `src/numeric.ts`,
NOT under `src/dmd/root/` (it is a hand-written helper with no single `.d` source, §0).
It is the SINGLE sink for the assert-translation rule. Do **not** invent per-file assert
helpers or a second assert module under `root/`.

```ts
// djs/src/assert.ts — exception hierarchy (06 §8.3) + assert/abort helpers
export class DThrowable extends Error { /* D Throwable; extends JS Error for stack traces */ }
export class DException extends DThrowable { /* D Exception — recoverable branch */ }
export class DError extends DThrowable { /* D Error — UNRECOVERABLE branch; NOT the JS Error */ }
export class AssertError extends DError { /* core.exception.AssertError — every failed assert */ }
export class SwitchError extends DError { /* core.exception.SwitchError — final-switch default arm */ }

export function assert(cond: unknown, msg?: string): asserts cond {
    if (!cond) throw new AssertError(msg ?? "Assertion failure");   // ldc2-verified default
}
export function assertUnreachable(msg = "Assertion failure"): never { throw new AssertError(msg); } // assert(0)
export function enforce(cond: unknown, msg = "enforce failed"): asserts cond { // boundary-validation.md
    if (!cond) throw new AssertError(msg);
}
```

Invariants:
- `assert(cond)` → `assert(cond)`. `assert(cond, "msg")` → `assert(cond, "msg")` (the
  helper keeps the D name; the `asserts cond` predicate narrows `cond` afterwards).
- `assert(0)` / `assert(false)` → `assertUnreachable()` (it is `never` — helps TS flow
  analysis treat following code as dead, mirroring D's `assert(0)` = no-return).
- Boundary checks (`boundary-validation.md`, NOT an upstream DMD construct) → `enforce()`.
- Every failed assert throws **`AssertError`** (a `DError` ⊂ `DThrowable` ⊂ JS `Error`).
  ldc2-verified messages: `assert(false)` / `assert(0)` → `"Assertion failure"`;
  `assert(false, "msg")` → `"msg"`. `final switch` default arm → `SwitchError`.
- Asserts **throw**, they do not `process.exit`. The CLI shim catches at top level.
  (`10-tests-diagnostics.md` owns how Vitest/`fail_compilation` observe throws.)
- `DError` is **NOT** the JS global `Error` — it is the unrecoverable branch of D's
  hierarchy. Confusing the two silently changes which catch arm fires.

---

## 13. `rmem.d` + `region.d` — allocators → NO-OP

DMD manages memory by hand (`Mem` struct, bump-pointer `Region`, `allocmemoryNoFree`).
**JS has a GC. All of this becomes no-op / trivial.** Translate-order Bucket 0/4.

| D construct | TS | rationale |
|---|---|---|
| `mem.xmalloc(n)` / `xcalloc` / `xrealloc` / `xmalloc_noscan` / `xrealloc_noscan` (`rmem.d:88`) | — (delete) | JS allocates via `new`/array literals; no manual alloc. `*_noscan` = "GC must not scan these bytes" (a raw byte/typed buffer) — in djs a typed array carries no GC pointers, so the distinction vanishes. A live `xrealloc_noscan` (grow a no-scan block) becomes: allocate a fresh typed array of the new size and copy the existing prefix (`const g = new Uint8Array(n); g.set(old); old = g;`) |
| `mem.xfree(p)` (`rmem.d:34`) | — (delete) | GC frees |
| `mem.xstrdup(s)` (`rmem.d:26`) | a `DString` copy (`s.slice()`) where actually needed | only if a copy is semantically required |
| `mem.isGCEnabled` / `disableGC` / `addRange` / `removeRange` | drop | GC tuning, no analog |
| `xarraydup(s)` (`rmem.d:335`) | `s.slice()` (with NUL note) where needed | array copy |
| `arraydup(T[])` (`rmem.d:368`) | `a.slice()` | array copy |
| `Region` struct (`region.d:24`) — `malloc`/`savePos`/`release`/`contains`/`size` | a no-op shim or delete | bump allocator; GC makes it irrelevant |
| `_d_allocmemory` / `_d_newclass` / `OVERRIDE_MEMALLOC` block (`rmem.d:222-293`) | drop entirely | druntime override; LDC-build-specific, codegen-adjacent |

Invariants:
- **The vast majority of `mem.x*` / `Region` calls vanish.** They appear inside the
  *implementation* of `Array`/`StringTable`/`BitArray` (which we re-implement over JS
  containers, so the alloc calls are already gone), or in `OutBuffer`/buffer code.
- **WATCH for semantic copies.** A few `mem.xmalloc` + `memcpy` pairs implement an
  intentional **copy** (e.g. `StringTable.allocValue` copies the key — captured in §5;
  `xarraydup`/`arraydup` copy arrays). When the alloc+copy is doing a *value copy that
  the frontend relies on* (the copied buffer is mutated independently), the port MUST
  preserve the copy (`s.slice()` / `[...arr]`), per `03-value-semantics.md`. Do not blind-
  delete every `memcpy` — distinguish "alloc plumbing" (delete) from "semantic copy"
  (keep as a JS copy). If unsure at a site, STOP.
- `Region.savePos`/`release` implement a CTFE/sema memory checkpoint-rollback. Because
  JS GC reclaims unreferenced objects, the checkpoint is a **no-op** — but verify the
  call site does not also rely on `release` *invalidating* still-referenced objects
  (it does not in correct DMD code: "There better not be any live pointers",
  `region.d:94`). Model `Region` as: `malloc(n)` → return a fresh object/array;
  `savePos`/`release`/`contains`/`size` → no-op/stub. Flag if a site reads `size()`
  for an observable result.
- **Declared divergence: the port runs CTFE as `ldc2 -lowmem` does.** `mem.isGCEnabled()` is
  true in the port. ldc2's default build runs with the GC off (driver/main.cpp:1129; only
  `-lowmem` turns it on), so its CTFE allocates literals in the region (dinterpret.d:189-196)
  and `copyRegionExp` copies them out at the end of `ctfeInterpret` (dinterpret.d:6712). The
  copy is observable on self-referencing CTFE objects: `is` identity and the depth at which
  `<recursion>` is printed. The port keeps the GC model and does not reproduce the copy; the
  corpus runner compares such tests against `ldmd2 -lowmem` (MATCH-LOWMEM, `10 §4.5`).

Consumers: pervasive in DMD source, almost entirely **removed** in the port.

---

## 13a. `OutBuffer` (`dmd/common/outbuffer.d`) — the expandable byte buffer

`OutBuffer` lives under `common/`, not `root/`, but it is **runtime infrastructure that
the `root/` modules in this doc already call** (`File.read` appends into it, §14.1;
diagnostics build messages in it). The code exists at `djs/src/dmd/common/outbuffer.ts`;
this section is the **observable contract** the rest of the port relies on. (It is a
root-runtime exemption, like `Array`: the faithful-1:1 rule is RELAXED — we implement the
public methods and their byte-level behavior over a `Uint8Array`, dropping the raw-memory
machinery that exists only because D has no GC here.)

**Canonical model:** a backing `Uint8Array data` + an `offset` (the logical length, = D's
`offset`). Unlike `Array!T` (§2), OutBuffer's whole contract IS byte manipulation
(memmove/memset, little-endian 16/32/64-bit stores), so `data`/`offset` and a real
`reserve` that grows the typed array are the observable semantics — NOT droppable alloc
tuning. The indent state (`doindent`/`spaces`/`level`/`notlinehead`) is kept.

**Value-vs-reference:** D's `OutBuffer` is a `struct`, but the frontend always passes it by
`ref`/pointer (`write(OutBuffer*)`, `error(..., OutBuffer*)`) and never copies it by value.
So it is ported as a **`class`** (reference) — no `.copy()` discipline applies
(`03-value-semantics.md §7`: a `Struct*` used as an alias is the class ref). It carries no
`opAssign`/`this(this)`, so the class port is faithful.

### 13a.1 The observable contract — methods the runtime + frontend rely on

| D | TS (`djs/src/dmd/common/outbuffer.ts`) | semantics |
|---|---|---|
| `length()` (`:124`) | `length(): number` | logical byte length (= `offset`) |
| `reserve(nbytes)` (`:159`) | `reserve(nbytes: number): void` | grow capacity to hold `offset + nbytes` (D's 1.5×-rounded-to-16 formula — observable-identical) |
| `reset()` (`:208`) | `reset(): void` | logical length → 0, **keeps** the allocated store |
| `setsize(size)` (`:202`) | `setsize(size: number): void` | shrink logical length; `assert(size <= capacity)` (loud, never silent-clamp) |
| `destroy()` (`:144`) | `destroy(): void` | empty the buffer (no free — GC); config flags unchanged |
| `write(buf)` (`:240`) | `write(buf: DString): void` | append `buf`'s bytes; honors indent state. `alias put = write` → the dispatcher |
| `writeBuffer(b)` (`:536`) | `writeBuffer(b: OutBuffer): void` | append another OutBuffer's contents (`write(ref const OutBuffer)`) |
| `writeByte(b)` (`:406`) | `writeByte(b: number): void` | append one byte, honoring indent. `write(ubyte)` (`:415`) folds here |
| `writeByten(b)` (`:401`) | `writeByten(b: number): void` | append one byte, **NO reserve** (caller reserved) |
| `writestring(s)` (`:304`) | `writestring(s: DString): void` | append bytes; buffer NOT zero-terminated |
| `writestringln(s)` (`:322`) | `writestringln(s: DString): void` | append bytes + newline |
| `writeStringz(s)` (`:330`) | `writeStringz(s: DString): void` | append bytes + a terminating NUL byte |
| `writenl()` (`:358`) | `writenl(): void` | strip trailing tabs/spaces, append `'\n'` (POSIX; Windows CR,LF dropped) |
| `print(u)` (`:624`) | `print(u: bigint): void` | append `u`'s decimal text. `u` is a 64-bit `ulong` → **bigint** (`09-numerics.md`) |
| `printf(fmt, …args)` (`:610`) | `printf(fmt: DString, ...args: unknown[]): void` | format + append; **delegates to `dmdformat`** — see 13a.2 |
| `vprintf(fmt, args)` (`:564`) | `vprintf(fmt: DString, args: ReadonlyArray<unknown>): void` | ditto; `args` IS the va_list (`04 §3.1` erases the ABI plumbing) |
| `write16`/`write32`/`write64` (`:281`/`:290`/`:298`) | `write16(v)`/`write32(v)`/`write64(v: bigint)` | little-endian stores; `write64` is **bigint** (64-bit) |
| `writeUTF8(c)`/`writeUTF16(c)` (`:424`/`:495`) | `writeUTF8(c)`/`writeUTF16(c)` | encode a code point as 1–4 UTF-8 / 1–2 UTF-16 LE units |
| `allocate(nbytes)` (`:557`) | `allocate(nbytes: number): DString` | reserve `nbytes` and return a writable **VIEW** (shared, fills in place — used by `File.read`, `writeHexString`) |
| `peekSlice()` (`:742`) | `peekSlice(): DString` | non-owning VIEW of `[0 .. offset]` (no copy) |
| `opSliceAll()` / `opSlice(l,u)` (`:685`/`:690`) | `opSliceAll()`, `opSlice(l,u)` | `buf[]` / `buf[l..u]` VIEWs (`05-operators.md §7`) |
| `peekChars()` (`:731`) | `peekChars(): DString` | ensure trailing NUL, return a VIEW of `[0 .. offset+1]` (the NUL at `data[offset]` is readable; buffer NOT emptied) |
| `extractChars()` (`:748`) | `extractChars(): DString` | ensure trailing NUL, **take ownership** — the returned DString INCLUDES the NUL byte |
| `extractData()` (`:131`) | `extractData(): DString` | transfer ownership of `[0 .. offset]` (a COPY) and reset to empty — **no NUL** |
| `extractSlice(nulTerm=false)` (`:713`) | `extractSlice(nullTerminate = false): DString` | extract + empty; with `true`, ensure trailing NUL (NUL past the slice if already present) |

Other byte-plumbing members (`writesLEB128`/`writeuLEB128`, `writeHexString`,
`prependstring`/`prependbyte`/`bracketChars`/`bracket`, `spread`/`insert`/`remove`,
`position`/`fill0`/`writezeros`, `writeword`/`writewchar`/`write4`) are present and
translate faithfully; port a given one when a translated file uses it.

**Dropped** (raw-memory artifacts; each carries a `// dropped:` comment at its dmd line):
`malloc`/`realloc`/`free`, the `~this`/`dtor` stomp machinery (JS GC), `buf()`/`bufptr()`
raw `ubyte*`/`ubyte**` accessors, the pointer-overload `writen`/`write(void*, n)`, and the
`FileMapping`-backed store (`moveToFile` and the file-mapping ctor are STOP-stubbed —
`common/file.ts` has no faithful JS model for mmap; the RAM `data` store is the only live
path). The `version(Windows)` newline branches (`0x0A0D`) are resolved OFF — POSIX `'\n'`.

**Trap from the dropped C-string overload:** D's `write(const(char)*)`, and `writestring(const(char)*)`
that forwards to it, return on a null pointer (`outbuffer.d:260` `if (!s) return;`). The TS
`writestring` takes a `DString` and has no such form, so a site that writes a D `const(char)*` which
can be null (`getParamError` under a gag, `typesem.d:2340`) keeps that null test inline, citing
`outbuffer.d:260`. It is D's behaviour moved to the call site, not a guard `11 §2.5` forbids.

### 13a.2 VIEW vs CONSUME — the OutBuffer read-out table (the #1 confirmed-bug trap)

**Every OutBuffer read-out method is either a non-destructive VIEW or a buffer-CONSUMING
extract. Confusing them is a confirmed live-bug class**: the old port rendered D's `idBuf[]`
(a view) as `extractData()` (a consume), so the buffer was empty on every later read and every
`generateIdWithLoc` name collapsed — it compiled, passed local tests, and miscompiled silently.

| D call site spelling | Kind | djs method | Buffer after the call |
|---|---|---|---|
| `buf[]` (opSlice, no args) | **VIEW** | `opSliceAll()` | unchanged (shared view) |
| `buf[l..u]` | **VIEW** | `opSlice(l, u)` | unchanged (shared view) |
| `buf.peekSlice()` | **VIEW** | `peekSlice()` | unchanged (shared view) |
| `buf.peekChars()` | **VIEW** (+NUL in store) | `peekChars()` | unchanged (NUL appended in store) |
| `buf.extractData()` | **CONSUME** | `extractData()` | **emptied** |
| `buf.extractSlice(…)` | **CONSUME** | `extractSlice(…)` | **emptied** |
| `buf.extractChars()` | **CONSUME** (+NUL) | `extractChars()` | **emptied** (ownership taken) |

**Mandatory audit rule:** at every translated call of an `extract*` method, the D source must
literally spell `extract…` at that site. If the D spells `buf[]` / `peekSlice` / `peekChars`,
emitting an `extract*` is a bug — no exceptions, no "it's the last read anyway". After
finishing a file, grep it for `extractData|extractChars|extractSlice` and check each hit
against the D line it cites. (Cross-ref: `05-operators.md §7` owns the `buf[]` → `opSliceAll()`
operator rewrite; it is a VIEW.)

In D these read-outs return a `char*` (C-string). In djs a `DString` carries
its own length and needs no embedded NUL, but the **NUL semantics still differ** by method:
- **`extractChars()`** ensures a trailing NUL is in the store, then takes ownership — the
  returned DString **INCLUDES** the NUL byte (its `.length` is `offset` AFTER the NUL was
  appended). Use when a caller needs a genuine NUL-terminated buffer it will index past.
- **`peekChars()`** ensures the NUL is in the store but does NOT empty the buffer, and
  returns a VIEW spanning `[0 .. offset+1]` so the terminating NUL at `data[offset]` is
  readable (empty-buffer case: `offset == 0`, NUL at `data[0]`, so `p[0] === 0`).
- **`extractData()` / `peekSlice()` / `opSliceAll()`** carry **NO** NUL — they are the raw
  `[0 .. offset]` content. `extractData` copies + empties; the other two are shared views.

`08 §11` C-string idioms apply to the readers of these: a logical C-string is the bytes
before the first NUL; `if (*p)` → `p.length>0 && p[0]!==0`. The NUL these methods append is
a terminator, not part of the logical string.

### 13a.3 `printf`/`vprintf` → `dmdformat`

`OutBuffer.printf`/`vprintf` are the **only** printf surface the frontend uses for
diagnostics. They **delegate to `dmdformat`** (the canonical format shim,
`djs/src/dmd/root/dmdformat.ts`, owned by `10-tests-diagnostics.md §3.5`): assemble the
formatted bytes via `dmdformat(fmt, args)`, then `writestring` the result (honoring indent
state). The `pragma(printf)` and `va_list`/`va_start`/`va_end` ABI plumbing erase
(`04 §3.1`/`§8`); `args` IS the va_list. The supported specifier table (`%s`, `%.*s` —
**stops at the first NUL inside the precision window**, `%d`/`%i`/`%u`, `%lld`/`%llu`,
`%x`/`%X`, `%o`/`%llo`, `%c`, `%zu`, `%%`, width/precision/flags incl `%03o`/`%-10s`/`%5d`)
and the `%f`/`%g`/`%e` STOP-stub (float display deferred to CTFloat) are owned by
`10 §3.5` — do NOT re-implement the format interpreter here, call `dmdformat`. Any specifier
outside the table is a loud STOP (`boundary-validation.md`: fail loud, never mis-format).

Consumers: `File.read` (§14.1, appends via `allocate`), every diagnostic path, `mangle/`,
`hdrgen.d`, JSON/`json.d` output — pervasive across the frontend.

---

## 14. `file.d` + `filename.d` (`dmd/root/file.d`, `dmd/root/filename.d`) — node:fs, MINIMAL

Keep only what the lex→sema→CTFE pipeline + minimal CLI shim needs. `_config.md` flag #1
(linux vs macOS) and #6 (`fs.realpath`) apply here — those need Paolo's decision before
this file is finalized. The port targets POSIX via Node (`process.platform` switch only
where macOS/Linux genuinely differ).

### 14.1 `File` — read/write (`file.d:56`)

Frontend usage (grounded): `File.read` (4), `File.write` (3), `File.remove` (5),
`File.update` (1), `File.removeDirectory` (1).

| D | TS (`djs/src/dmd/root/file.ts`) | semantics |
|---|---|---|
| `static bool read(const char[] name, ref OutBuffer buffer)` (`:87`) | `read(name: DString, buffer: OutBuffer): boolean` | append file bytes to `buffer`; **returns `true` on FAILURE** (D convention!) |
| `static bool write(const(char)[] name, const void[] data)` (`:165`) | `write(name: DString, data: Uint8Array): boolean` | `true` on success |
| `static void remove(const(char)* name)` (`:171`) | `remove(name: DString): void` | unlink, ignore error |
| `static bool update(const(char)[] name, const void[] data)` (`:244`) | `update(name: DString, data: Uint8Array): boolean` | currently just `write` (DMD's identity-check is commented out, `file.d:234`) |
| `static ulong size(const char* namez)` (`:252`) | `size(name: DString): bigint` | `ulong.max` on error (BigInt, `09-numerics.md`) |
| `removeDirectory` (`:189`, IN_LLVM) | `removeDirectory(name: DString): void` | `fs.rmdir`/`rm`; IN_LLVM-only → KEEP (we are LDC) |

Invariants:
- **`read` returns `true` on FAILURE, `false` on success** (`file.d:89` `enum Success =
  false; Failure = true`). This inverted convention is a classic trap — preserve it
  exactly and comment it at the TS signature. Implement with `node:fs`
  `readFileSync` in try/catch: success → append bytes to `OutBuffer`, return `false`;
  any error → return `true`.
- `read` appends into an `OutBuffer` via `buffer.allocate(size)` then fills. The
  `OutBuffer` contract is **§13a** (code at `common/outbuffer.ts`): `allocate(n)` returns a
  writable VIEW the caller fills in place. Reserve `size` bytes, then copy the file bytes
  into the returned view.
- The Windows branches (`file.d:124`, `:177`, `:260`) are OFF (`_config.md`) → drop;
  keep the POSIX `else` realized as Node fs. The `version (linux) version (PPC)` stat
  struct workaround (`file.d:277`) is OFF → drop.
- File bytes are read as a `Uint8Array` (NOT decoded) — the lexer wants bytes.

### 14.2 `FileName` — path manipulation (`filename.d`)

This is `filename.d` (1223 lines) but the frontend only calls a **small subset**
(grounded): `combine` (35), `equals` (29), `exists` (25), `equalsExt` (13), `free` (12),
`forceExt` (10), `ext` (8), `name` (5), `buildPath` (5), `searchPath` (4), `path` (4),
`sansExt` (3), `absolute` (3), `replaceName` (2), `defaultExt` (2), `canonicalName` (2),
`appendSplitPath` (2), and singletons (`toAbsolute`, `splitPath`, `refersToParentDir`,
`findReservedChar`, `ensurePathExists`, `addExt`).

**Port only these members.** Most are **pure string/path ops** (no I/O) and translate to
byte-slice manipulation; a handful touch the filesystem (`exists`, `canonicalName`,
`searchPath`, `ensurePathExists`, `toAbsolute`) and use `node:fs`/`node:path`.

| D member | TS | I/O? | semantics |
|---|---|---|---|
| `combine(path, name)` | `combine(path: DString, name: DString): DString` | no | join with separator |
| `equals(a, b)` | `equals(a: DString, b: DString): boolean` | no | path-equal (case rules: POSIX = exact bytes) |
| `equalsExt(name, ext)` | `equalsExt(name: DString, ext: DString): boolean` | no | extension match |
| `ext(name)` / `sansExt` / `forceExt` / `defaultExt` / `addExt` | byte-slice ops on `.` | no | extension manipulation |
| `name(path)` / `path(fullname)` / `replaceName` | byte-slice ops on separator | no | basename/dirname |
| `buildPath(...)` / `splitPath` / `appendSplitPath` | path list ops | no | build/split path lists |
| `refersToParentDir` / `findReservedChar` | predicate scans | no | `..` / invalid-char checks |
| `absolute(name)` | predicate | no | is the path absolute (leading `/`) |
| `free(str)` | — (delete) | no | frees a C-string → no-op (GC) |
| `exists(name)` | `exists(name: DString): number` | **yes** | `fs.statSync`: 0=no, 1=file, 2=dir |
| `canonicalName(name)` | `canonicalName(name: DString): DString` | **yes** | `fs.realpathSync` (flag #6) |
| `searchPath(...)` | `searchPath(...): DString \| null` | **yes** | search import dirs for a file |
| `toAbsolute(name)` | `toAbsolute(name: DString): DString` | **yes** | resolve against CWD |
| `ensurePathExists(path)` | `ensurePathExists(path: DString): ...` | **yes** | mkdir -p |

Invariants:
- **POSIX path semantics** (`_config.md §6`): separator is `/`; `equals` is exact-byte
  (no Windows case-folding). Drop all Windows path branches.
- `exists` returns an **int** code, NOT a bool (`filename.d:872`, verified): `0` =
  does not exist (or empty name), `2` = directory (`S_ISDIR`), `1` = regular file. The
  frontend tests `== 2` for directories and truthiness for "exists at all". Reproduce
  these exact codes via `fs.statSync` (catch → 0; `isDirectory()` → 2; else 1).
- `free` → delete (GC). Its 12 call sites drop the `FileName.free(x)` line.
- **Deferred fs members use `node:fs`** (`existsSync`/`statSync`/`realpathSync`/
  `mkdirSync`/…). `exists` → `fs.statSync`; `canonicalName` → `fs.realpathSync`;
  `ensurePathExists` → `fs.mkdirSync`; `toAbsolute`/`searchPath` resolve via
  `node:path`+`fs`. These remain **behavioral substitutions** (Node fs vs glibc
  `canonicalize_file_name`) — `_config.md` flag #6 (`fs.realpath`) is still the standing
  caveat for exact `realpath` semantics, but the **encoding boundary below is decided** and
  applies to every fs member now.
- **Path ↔ node:fs encoding boundary: UTF-8, NOT Latin-1 (DECIDED, resolution #15).** A
  path is a `DString` (bytes); a Node fs/path call takes/returns a JS string. Convert with
  the **UTF-8** pair: `DString → JS` is `dsToJs` (UTF-8 `TextDecoder`), and `JS → DString`
  is **`dsUtf8`** (UTF-8 `TextEncoder`), **NOT** `ds()` (Latin-1). The two MUST pair:
  `dsToJs` is UTF-8, so the inverse on the return side must also be UTF-8. Using Latin-1
  `ds()` to re-encode an fs return (e.g. `ds(fs.realpathSync(...))`) **corrupts any
  non-ASCII path** — VERIFIED: a UTF-8 path byte `C3 A9` ("é") decodes to JS `"é"` (U+00E9),
  and Latin-1 `ds("é")` collapses it back to a single byte `E9` (lossy), whereas `dsUtf8`
  round-trips to `C3 A9`. So: `combine`/`equals`/`ext`/… stay byte-only (no encode); only
  the fs members cross the boundary, and they cross it via `dsToJs` out / `dsUtf8` back.
- Use `node:path` (`posix` variant) for join/dirname/basename/extname to avoid
  re-deriving, BUT the lexer never sees these JS strings — they exist only inside the fs
  member, between the `dsToJs` in and the `dsUtf8` out.

Consumers: `dmodule.d` (import resolution), `globals.d`/`utils.d`, the CLI shim,
`file_manager.d`.

---

## 15. `ctfloat.d` (`dmd/root/ctfloat.d`) + `complex.d` — float helpers

`real_t` = `double` on this target (`_ground-truth.md §3`, `_probes.md §6`). `CTFloat`
is the compile-time float helper; **`09-numerics.md` owns the numeric mapping** (real →
`number`, `strtold` replacement, `longdouble`). This section specifies only the runtime
**API surface** of `CTFloat` and `complex_t`, deferring all precision/parse decisions to
`09-numerics.md`.

### 15.1 `CTFloat` (`ctfloat.d:41`)

Resolved config (`_config.md`): the **IN_LLVM / `is(real_t == real)` branch** is live
(generic libm, NOT x87 `yl2x` asm). So:

```ts
// djs/src/dmd/root/ctfloat.ts — real_t = number (double). See 09-numerics.md for rationale.
export type real_t = number;
export class CTFloat {
    static readonly zero: real_t = 0;
    static sin(x: real_t): real_t { return Math.sin(x); }
    static cos(x: real_t): real_t { return Math.cos(x); }
    static tan(x: real_t): real_t { return Math.tan(x); }
    static sqrt(x: real_t): real_t { return Math.sqrt(x); }
    static fabs(x: real_t): real_t { return Math.abs(x); }
    static ldexp(n: real_t, exp: number): real_t { return n * Math.pow(2, exp); }
    static round(x: real_t): real_t { ... } static floor(x) { return Math.floor(x); } // etc.
    static log(x) { return Math.log(x); } static log2(x) { return Math.log2(x); }
    static pow(x, y) { return Math.pow(x, y); } static exp(x) { return Math.exp(x); }
    // ... copysign, ceil, trunc, log10, expm1, exp2 ...
    static yl2x(x: real_t, y: real_t): real_t { return y * Math.log2(x); }    // IN_LLVM generic
    static yl2xp1(x: real_t, y: real_t): real_t { return y * Math.log2(x + 1); }
    static isFloat32LiteralOutOfRange(s: DString): boolean { ... }            // exact, see below
    static isFloat64LiteralOutOfRange(s: DString): boolean { ... }
    static parse(literal: DString): { value: real_t; isOutOfRange: boolean } { ... } // exact, see below
    static sprint(fmt: "g" | "a" | "A", x: real_t): DString { ... }            // exact, see below
    // zero/nan/infinity/etc. — member list owned by 09-numerics.md
}
```

Invariants:
- `yl2x`/`yl2xp1` take the **IN_LLVM generic** path (`ctfloat.d:57`/`:67`): `y *
  log2(x)`. The x87-asm `core.math.yl2x` path is OFF (`_config.md`). **FLAG (`_config.md`
  #5):** transcendental bit-parity (`Math.log2` vs hardware `yl2x`) is UNVERIFIED for
  CTFE constant-folding. Probe if any frontend file constant-folds `yl2x`/`log2` (rare).
- All the `static if (!is(real_t == real))` soft-double wrappers (`ctfloat.d:73-107`)
  are the **dead branch** (our `real_t == real == double`) — take the `else` branch
  (`ctfloat.d:108+`, direct libm) and map each to `Math.*`. Record
  `// resolved: real_t == real -> direct Math.* path`.
- **Literal conversion and formatting are exact** (`parse`, `isFloat32/64LiteralOutOfRange`,
  `sprint`): with `real == double` both are fully determined by ldc2 1.43.0 on arm64-apple-darwin
  (gen/ctfloat.cpp). `parse` and the range checks are LLVM APFloat's round-half-even conversion of a
  decimal or C99 hex-float literal, computed on the literal's exact BigInt value (never JS `Number()`),
  with APFloat's overflow/underflow status (underflow = inexact and subnormal or zero after rounding).
  `sprint('g')` is macOS `snprintf("%Lg")` (gdtoa, one trailing-zero quirk reproduced) plus LDC's `.0`
  on an all-digit result; `sprint('a'/'A')` is APFloat `convertToHexString` plus LDC's `+` on a
  non-negative exponent. `sprint` returns the bytes (a `DString`), not a length. Pins against ldc2:
  `root/ctfloat.test.ts`. This covers the literal forms only: C `vsnprintf`'s `%f/%g/%e` in
  `root/dmdformat.ts` remain a deferral, and transcendental parity stays the open FLAG above.
- `CTFloat`'s **remaining member list** (zero, one, nan, infinity, isNaN, isInfinity,
  isIdentical, …) is **owned by `09-numerics.md`**. This doc fixes the class location, the
  math-fn shape and the literal contract above. Do NOT duplicate the numeric decisions here.

### 15.2 `complex_t` (`complex.d:18`)

A value struct `{ re: real_t; im: real_t }` with operator overloads (`+ - * /`, unary
`-`, `opCast(bool)`, `opEquals`). Operators become **methods** (`05-operators.md`);
value-copy on assignment applies (`03-value-semantics.md`).

```ts
// djs/src/dmd/root/complex.ts — value type (struct). re/im are number (double).
export class complex_t {
    constructor(public re: real_t, public im = CTFloat.zero) {}    // this(re) / this(re,im)
    copy(): complex_t { return new complex_t(this.re, this.im); }  // value-copy (03-value-semantics)
    // Operator method names are owned by 05-operators.md (and matched by 12-worked-examples.md);
    // these are its canonical monomorphized names — do not invent local aliases.
    opAdd(y: complex_t): complex_t { return new complex_t(this.re + y.re, this.im + y.im); }  // opBinary "+" :38
    opSub(y: complex_t): complex_t { return new complex_t(this.re - y.re, this.im - y.im); }  // opBinary "-" :44
    opNeg(): complex_t { return new complex_t(-this.re, -this.im); }                          // opUnary "-" :50
    opMul(y: complex_t): complex_t { /* (re*y.re - im*y.im, im*y.re + re*y.im) */ }            // opBinary "*" :56
    opDiv(y: complex_t): complex_t { /* complex.d:80 — the fabs-branch algorithm, verbatim */ }
    opMul_real_t(y: real_t): complex_t { return this.opMul(new complex_t(y)); }               // opBinary "*"(real) :68
    toBool(): boolean { return this.re !== 0 || this.im !== 0; }                              // opCast(bool) :97
    opEquals(y: complex_t): boolean { return this.re === y.re && this.im === y.im; }          // opEquals :102
}
export function creall(x: complex_t): real_t { return x.re; }     // complex.d:108
export function cimagl(x: complex_t): real_t { return x.im; }     // complex.d:113
```

Invariants:
- **Method set is complete and lives here.** A CTFE translator (`constfold.d`,
  `dinterpret.d`) finds every `complex_t` operation in one place: the operator methods
  `opAdd`/`opSub`/`opMul`/`opDiv`/`opNeg`/`opMul_real_t`/`opEquals` (plus `opMul_r` for
  `real × complex` and `toBool` for `opCast(bool)`; canonical names owned by
  `05-operators.md`, matched by `12-worked-examples.md`), plus the **free functions**
  `creall`/`cimagl`. Do not add or rename members.
- **`creall(e)` / `cimagl(e)` are free functions, not methods.** In D they are
  `extern (C++) real_t creall/cimagl(complex_t)` (`complex.d:108`/`:113`) returning
  `.re`/`.im`; CTFE calls them as free functions — `creall(c2)`, `cimagl(c)` — not
  `c2.creall()` (see usage in `constfold.d:176`, `:235`). Keep them module-level
  `export function creall(x)/cimagl(x)`; never fold them into the class.
- `complex_t` has `this() @disable` (`complex.d:25`) — no default construction. Always
  constructed with a value. (TS: require `re` in the constructor.)
- The division algorithm (`complex.d:80-95`) picks the branch by `|y.re|` vs `|y.im|` to
  avoid overflow — translate it **verbatim** (it affects CTFE float results). Do not
  "simplify" to `(re*y.re+im*y.im)/(y.re²+y.im²)`.
- Operator rewrites at call sites (names owned by `05-operators.md`, matched by
  `12-worked-examples.md`): `a + b` → `a.opAdd(b)`; `a - b` → `a.opSub(b)`; `a * b` (both
  complex) → `a.opMul(b)`; `a / b` (both complex) → `a.opDiv(b)`; `-a` → `a.opNeg()`;
  `c * r` (complex × real, `opBinary!"*"(real_t)`, `complex.d:68`) → `c.opMul_real_t(r)`;
  `r * c` (real × complex, `opBinaryRight!"*"`, `complex.d:62`) → `c.opMul_r(r)` (method on
  the RIGHT operand — DISTINCT from `opMul_real_t`; do not conflate them, see
  `12-worked-examples.md`); `if (c)` → `if (c.toBool())`; `a == b` → `a.opEquals(b)`.
  `05-operators.md` owns the call-site rewrite catalog; this doc fixes the method names so
  they are consistent.
- Used in CTFE of complex literals (`constfold.d`, `ctfeexpr.d`, `dinterpret.d`). Low
  volume but precision-sensitive.

Consumers: `constfold.d`, `dinterpret.d`, `expression.d` (`ComplexExp`), `mtype.d`.

---

## 16. `port.d` (`dmd/root/port.d`) — platform helpers

A grab-bag `Port` struct of byte/endian/case helpers. Small; port the members the
frontend uses. All are pure (no real platform dependence after config resolution).

| D member (`port.d`) | TS | semantics |
|---|---|---|
| `memicmp(s1, s2, n)` (`:41`) | `memicmp(a: DString, b: DString, n: number): number` | case-insensitive byte compare (ASCII toupper) |
| `strupr(s)` (`:61`) | `strupr(s: DString): DString` | uppercase in place (ASCII) |
| `isFloat32LiteralOutOfRange(s)` (`:88`) | delegate to `CTFloat` | IN_LLVM branch calls `CTFloat` (`port.d:90`) |
| `isFloat64LiteralOutOfRange(s)` (`:121`) | delegate to `CTFloat` | same |
| `writelongLE` / `readlongLE` (`:155`/`:165`) | `writeLongLE(buf, off, v)` / `readLongLE(buf, off)` | 32-bit little-endian byte pack/unpack |
| `writelongBE` / `readlongBE` (`:172`/`:182`) | BE variants | big-endian (used for specific formats) |
| `readwordLE` / `readwordBE` (`:189`/`:196`) | 16-bit variants | word pack/unpack |
| `valcpy(dst, val, size)` (`:202`) | `valcpy(buf, off, val: bigint, size)` | write 1/2/4/8-byte little-endian value |

Invariants:
- **`isFloat32/64LiteralOutOfRange` take the IN_LLVM branch** (`port.d:90`/`:123`):
  they delegate to `CTFloat.isFloat*LiteralOutOfRange` (`_config.md`: IN_LLVM ON). The
  `CRuntime_DigitalMars`/`CRuntime_Microsoft`/`strtof`/`strtod` branches are OFF →
  drop. So `Port.isFloat*` is just a forwarder to `CTFloat` (§15). Record
  `// resolved: version(IN_LLVM) -> CTFloat delegate`.
- `memicmp`/`strupr` use C ASCII `toupper` (only A–Z), NOT locale/Unicode. Use the
  byte-level `toUpperAscii` (same as §8). Returns the C `memcmp`-style int.
- Endian helpers operate on a `Uint8Array` + offset (no raw pointers). `valcpy` writes a
  1/2/4/8-byte value; the 8-byte case is a 64-bit value → the `val` arg is `bigint`
  (`09-numerics.md`), split into bytes. Little-endian is the target (`_config.md §6`);
  the BE variants are still ported (used for object-format constants), as plain byte
  ordering — they are not `version`-gated.
- The `version(CRuntime_*)` private externs at `port.d:23-35` are OFF → drop.

Consumers: `lexer.d` (float literal range checks via `CTFloat`), `dmodule.d` (BOM/word
reads), `mangle/`, format/output code.

---

## 17. What is OUT of this doc (cross-references)

To avoid duplication, these adjacent runtime/foundation pieces are owned elsewhere:

- `common/outbuffer.d` (`OutBuffer`) — **owned HERE, §13a** (it is runtime infrastructure
  the `root/` modules already call; `File.read` appends into it). The other `common/`
  foundation modules — `common/smallbuffer.d`, `common/file.d`, `common/int128.d`,
  `common/bitfields.d`, `common/charactertables.d`, `common/identifiertables.d` — are
  **`common/` foundation; not `root/`** and are specified with `common/`.
- printf-format interpretation (`%s`/`%.*s`/`%d`/`%x`/`%o`/… and the `%f`/`%g`/`%e`
  STOP-stub) — **`10-tests-diagnostics.md §3.5`**, via the `root/dmdformat.ts` shim.
  `OutBuffer.printf`/`vprintf` (§13a.3) and the `errorsink` stderr path delegate to it.
- `longdouble.d`, `int128.d`, `strtold`, the full `CTFloat` numeric member list, and the
  `number` vs `BigInt` decision table — **`09-numerics.md`.**
- struct value-copy `.copy()` discipline (when to copy `complex_t`, `Optional`, array
  elements) — **`03-value-semantics.md`.**
- operator-overload call-site rewrites (`opIndex`, `opEquals`, `opCast`, `opBinary` on
  `BitArray`/`complex_t`/`FindSplit`) — **`05-operators.md`** (this doc fixes the
  method names; that doc fixes the rewrite rules).
- D `string`/`char`/`dchar` type mapping rationale — **`02-types.md`** (this doc fixes
  the `DString` alias the runtime uses).
- ESM cycle handling for `arraytypes`/`stringtable` importing core AST types —
  **`01-conventions.md`.**
- `version(IN_LLVM)`/`Posix`/`CRuntime_*` resolution for `file.d`/`filename.d`/`port.d`/
  `ctfloat.d`/`rmem.d` branches — **`_config.md`** (already resolved; cited inline).
