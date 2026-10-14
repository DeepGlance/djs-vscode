# 02 — Type-System Mapping (D → TypeScript)

> **STOP rule:** if you meet a type construct not covered here, or any ambiguity about
> which TS form to emit, STOP and escalate (`11-escalate.md`). Never guess. A
> wrong-but-plausible type in a compiler is worse than a halt.

Read `_ground-truth.md` first. This doc owns the **D type → TS type** mapping for the
frontend's own source: primitives, aggregates (struct/class/interface), enums, aliases,
tuples, arrays, associative arrays, pointers, and `Optional`. It gives **one canonical TS
form per D type** — faithful ports need determinism across parallel agents.

**Lane boundaries — defer to the owning doc, do not duplicate:**

- *Copy mechanics* of structs/static arrays (when to emit `.copy()`, postblit) → `03-value-semantics.md`.
- *Numeric domain rules* (`number` vs `bigint`, cast truncation, overflow wrap) → `09-numerics.md`.
- *Runtime containers* — `Array!T` API, dynamic-array/slice ops, AA ops, D `string` byte
  model → `08-runtime-lib.md`.
- *Function/delegate/function-pointer values* (closures, `this` capture) → `04-functions.md`.
- *Operator overloads* (`opXxx`) → `05-operators.md`.
- *`alias` that is part of a `static if`/`mixin`/`__traits` resolution* → `07-compile-time.md`.
- *Identifier escaping / cycle-handling / `import type`* → `01-conventions.md`.

This doc states **what TS type to write**. The behavioral invariants behind those types
(copy, truncate, share-backing) are stated here as one-liners with a cross-reference; the
full rule lives in the owning doc.

---

## 1. Primitive types

The frontend uses only the `extern(C++)` portable scalar subset. Map each D scalar to
**exactly one** TS type. The third column states the invariant that survives the mapping;
where it is a numeric-domain decision, `09-numerics.md` is authoritative.

| D type | TS type | Invariant / note (owner) |
|---|---|---|
| `void` | `void` | Return-only. Never a variable type. |
| `bool` | `boolean` | Direct. |
| `byte` (i8) | `number` | Truncate-on-store to 8-bit signed (`09`). |
| `ubyte` (u8) | `number` | Truncate-on-store to 8-bit unsigned (`09`). |
| `short` (i16) | `number` | 16-bit signed wrap (`09`). |
| `ushort` (u16) | `number` | 16-bit unsigned wrap (`09`). |
| `int` (i32) | `number` | 32-bit signed; re-truncate after overflowing ops via `\| 0` (`09`). |
| `uint` (u32) | `number` | 32-bit unsigned; re-truncate via `>>> 0` (`09`). |
| `long` (i64) | `bigint` | 64-bit signed. `BigInt.asIntN(64, …)` on overflow (`09`). |
| `ulong` (u64) | `bigint` | 64-bit unsigned. `BigInt.asUintN(64, …)` (`09`). |
| `cent` / `ucent` (i128/u128) | — | **NOT a live variable type in the frontend** — obsolete, see §1.2. |
| `char` (UTF-8 code unit) | `number` | One byte (0–255). Arithmetic promotes to `int` (`09` §10). |
| `wchar` (UTF-16 code unit) | `number` | One 16-bit unit. Promotes to `int` in arithmetic. |
| `dchar` (UTF-32 code point) | `number` | One Unicode code point (e.g. `8364` for `€`). |
| `float` (f32) | `number` | All floating point is `number` (IEEE-754 double). |
| `double` (f64) | `number` | Maps exactly; `real == double` on this target (`_probes.md` §6). |
| `real` | `number` | **64-bit on this target** (`real.sizeof == 8`) — no x87 emulation (`_probes.md` §6). |
| `size_t` | `number` | 64-bit unsigned in D, but provably < 2^53 as an index/length → `number` (`09`). |
| `ptrdiff_t` | `number` | 64-bit signed; index-domain → `number` (`09`). |

**Verified (`_probes.md` §6):** `real.sizeof == 8`, `real.mant_dig == 53` on this AArch64 host
— `real` is IEEE-754 double, so a straight JS `number` op reproduces the compiler's CTFE
float result with no extended-precision emulation. State this as fact, do not re-probe.

### 1.1 The integer-domain split (the one rule you cannot get wrong)

D's `int`/`uint` and all narrower integers, plus `size_t`/`ptrdiff_t` used as
indices/lengths, live in the **`number` domain**. D's `long`/`ulong` live in the
**`bigint` domain**. **`number` and `bigint` do not mix** in JS (`1n + 1` throws). The
*decision table* for which domain a given declaration/expression lands in — and the
mask/wrap helpers — is owned by `09-numerics.md`. This doc only fixes the per-type default
above; when an expression mixes widths, `09` §10 (usual arithmetic conversions) governs the
result domain.

Frontend examples of each domain:

```d
// dmd/dsymbol.d:195
alias SearchOptFlags = uint;          // → number (32-bit unsigned flags)
// dmd/astenums.d:150
alias StorageClass = ulong;           // → bigint (64-bit flag set; STC enum is ulong)
```

### 1.2 `cent` / `ucent` — obsolete, do not introduce a 128-bit scalar

**Verified by grep:** `cent`/`ucent` as D language types appear in the frontend *only* as
token spellings and error strings, never as a variable type:

```d
// dmd/tokens.d:701-702 — just the spelling table
TOK.int128: "cent",
TOK.uns128: "ucent",
// dmd/typesem.d:1934 — the frontend rejects them
.error(loc, "`cent` and `ucent` types are obsolete, use `core.int128.Cent` instead");
```

So **do not** map a TS type for `cent`/`ucent`. The 128-bit arithmetic the frontend
actually performs (constant folding) is done through the **`Cent` struct** in
`dmd/common/int128.d` (two 64-bit halves), which is a normal struct port — its numeric
internals are owned by `09-numerics.md`. If you meet `cent`/`ucent` as a *value* type
declaration, that is a STOP (it should not exist).

### 1.3 `char` / `dchar` and the string model

A single `char`/`wchar`/`dchar` value is a `number` (per the table). A `char[]` /
`string` is **not** a JS `string` — D `string` is `immutable(char)[]`, a UTF-8 **byte
array**, with byte-count `.length` and byte indexing (`_probes.md` §5). The full string
model (`Uint8Array`/byte buffer backing, byte iteration vs `dchar` auto-decode) is owned by
`08-runtime-lib.md`. Here: a *scalar* `dchar` is just a code-point `number`. A
NUL-terminated **C string** (`const(char)*`) has a distinct logical-length rule — see §11.2.

```d
// dmd/lexer.d:1196 — dchar holds a decoded code point
dchar c = *p;
```

---

## 2. Aggregate types: `struct` vs `class` (the value-vs-reference rule)

This is the single most consequential mapping in the port. State the rule here; the **copy
mechanics** (where `.copy()` must be emitted, postblit/copy-ctor reproduction) are owned by
`03-value-semantics.md`.

| D aggregate | TS form | Semantics rule (this doc fixes the rule; `03` fixes the mechanics) |
|---|---|---|
| `struct S` | `class S` (TS class) | **VALUE type.** Assignment, by-value arg, array-element read into a var, and return-by-value all **copy** (`_probes.md` §1). Emit `.copy()` at every such site (`03`). |
| `class C` | `class C` (TS class) | **REFERENCE type.** Assignment shares the reference, exactly like JS objects. No copy. |
| `extern(C++) class C : Base` | `class C extends Base` | Reference type; single inheritance maps directly. |
| `extern(C++) abstract class C` | `abstract class C` | Abstract base; cannot be `new`-ed directly. |

**Why both `struct` and `class` become a TS `class`:** TS has only reference objects, so a
D `struct` is represented by a TS `class`; the *difference* is enforced not by the type but
by emitting copies on every struct value-move. **The type alone does not carry the
value/reference distinction in TS — `03-value-semantics.md` does, via `.copy()`.** Do not
try to model a struct as a TS object literal or `interface`; it must be a class so it can
carry a `copy()` method.

```d
// dmd/location.d:34 — a struct: VALUE type, copies on assignment
struct Loc
{
    private uint index = 0;
    ...
}
// dmd/dsymbol.d:322 — a class: REFERENCE type, shares on assignment
extern (C++) class Dsymbol : ASTNode
{
    ...
}
// dmd/declaration.d:71 — abstract base
extern (C++) abstract class Declaration : Dsymbol { ... }
```

**Bodyless method declarations inside a D abstract class → TS `abstract` methods.** A
method *declaration with no body* in an `abstract class` is D's pure-virtual: subclasses must
override it. Map it to a TS **`abstract` method** (signature only, no body) — TS enforces the
same "subclass must implement" obligation. Do **not** emit an empty `{ }` body (that would
make it concrete and silently satisfy the override) and do **not** throw "not implemented"
(that defers a compile-time guarantee to runtime).

```d
// dmd/ast_node.d (illustrative) — bodyless decl in an abstract class = pure virtual
extern (C++) abstract class ASTNode : RootObject
{
    abstract void accept(Visitor v);     // no body → subclasses MUST override
}
```

→

```ts
export abstract class ASTNode extends RootObject {
  abstract accept(v: Visitor): void;     // bodyless → TS abstract; subclasses must implement
}
```

> A bodyless decl outside an `abstract class` (a plain `class` with an un-bodied method) is
> not valid D and should not appear; if it does, that is a STOP. The bodyless-→-`abstract`
> rule applies **only** within an `abstract class`. A method that *has* a body in the
> abstract base maps to an ordinary (non-`abstract`) concrete method.

**Invariant the agent must preserve:** if the D declaration is `struct`, every assignment /
pass-by-value / element-read-into-var / return-by-value of it is a deep copy. Getting this
wrong produces a *silent* aliasing bug (two names sharing one object where D would have two
independent values). When you emit a TS `class` for a D `struct`, immediately consult
`03-value-semantics.md` for where the `.copy()` calls go. Field *types* of either kind map
recursively through this whole doc.

> A struct carrying a `union` of overlapping fields is **not** a blanket escalation — two
> carve-outs are ported by their own canonical mappings: `UnionExp` (§11.1) and the **`Token`
> int/uint payload union** (`tokens.d`), both owned by `11-escalate.md`. The Token carve-out
> models only the `int`↔`uint` bit-share via one raw slot; the full mapping lives in `11`.

---

## 3. `interface`

The frontend has only ~11 `interface` declarations (`_ground-truth.md` §4). D interfaces are
reference types with method signatures (and may carry `static`/`final` bodies and
`nothrow:` blocks). Canonical mapping:

| D `interface` shape | TS form |
|---|---|
| Pure method signatures, no bodies | **`interface I`** (TS interface) |
| Has any `final`/`static` method body or field | **`abstract class I`** (TS) |

**Rule:** default to a TS `interface`. Switch to `abstract class` **only** if the D
interface carries an implementation (a non-abstract method body or a data member) that
TS `interface` cannot express. Be decisive: do not emit both.

```d
// dmd/console.d:57 — pure signatures → TS interface
interface Console
{
  nothrow:
    @property FILE* fp();
    void setColorBright(bool bright);
    void setColor(Color color);
    void resetColor();
}
```

→

```ts
export interface Console {
  fp(): FILE;                  // @property erased (see 04-functions.md)
  setColorBright(bright: boolean): void;
  setColor(color: Color): void;
  resetColor(): void;
}
```

`nothrow:`, `@property`, and `@nogc`/`pure` attributes erase — see `04-functions.md`.
A class implementing the interface uses `class WindowsConsole implements Console` (or
`extends` for the abstract-class form). `implements`/`extends` choice follows the
TS-form choice above.

> Note: `ASTNode` (`dmd/ast_node.d:17`) and `Visitor` (`dmd/visitor/package.d:26`) are
> declared as `extern(C++) abstract class`, **not** `interface` — so they map per §2 as
> `abstract class`, even though they act as the visitor "interface." Follow the D keyword,
> not the conceptual role.

---

## 4. `enum`

D's `enum` keyword has **two completely different meanings**. You MUST distinguish them by
syntax — they translate differently.

### 4.1 Manifest constant — `enum NAME = value;` (no braces, no member list)

This is **not** an enumeration; it is a named compile-time constant (a `#define`/`const`).
Canonical TS form: a `const`.

| D | TS |
|---|---|
| `enum recursionLimit = 500;` | `const recursionLimit = 500;` |
| `enum int recursionLimit = 500;` | `const recursionLimit: number = 500;` |
| `enum mars_ext = "d";` | `const mars_ext = "d";` |

```d
// dmd/globals.d:431
enum recursionLimit = 500; /// number of recursive template expansions before abort
// dmd/globals.d:361
enum mars_ext = "d";        // for D source files
```

**Verified (`/tmp/probe_types.d`):** `enum mars_ext = "d"` has type `string`; the value is
exactly `"d"`. A typed manifest enum (`enum int x = 500`) keeps the explicit TS type
annotation; an untyped one lets TS infer.

**Special manifest case — `enum IN_LLVM = true;`:** this is a *config flag*, kept as
`const IN_LLVM = true;` so `static if (IN_LLVM)` resolves at translation time (`_config.md`
§2). Do not treat it as a generic constant; follow `07-compile-time.md`.

> A manifest enum is **always `const`** (a value), never a TS `enum`. The presence of an
> `=` directly after the name with no `{ … }` is the discriminator.

**Manifest / anonymous enum *inside a struct or class body*.** A `enum NAME = value;` (or an
anonymous member-list enum `enum { a, b }`) declared **inside** a D aggregate is **not** an
instance member — in D it is a compile-time constant scoped to the aggregate. TS classes
cannot carry a bare `const` member, and `static readonly` would change the access spelling
(`S.NAME` works in D but the value is module-resolvable, not an instance fact). Canonical
form: **hoist it to a file-private module-scope `const`** (a top-level `const` in the same
`.ts` file, *not* exported), so internal references compile and the value folds at
translation time. Add a `// D <aggregate>-scoped manifest enum` comment.

```d
// dmd/lexer.d (illustrative shape) — manifest enum inside the struct body
struct Lexer
{
    enum LookaheadDepth = 4;          // compile-time const, struct-scoped
    enum { tabSize = 8, eof = 0x1A }  // anonymous member-list enum, struct-scoped
    ...
}
```

→

```ts
// src/dmd/lexer.ts — manifest/anonymous enums hoisted to file-private module consts.
// D Lexer-scoped manifest enum
const LookaheadDepth = 4;
// D Lexer-scoped anonymous enum
const tabSize = 8;
const eof = 0x1a;

export class Lexer {
  // ... no const members; references use the module-scope consts above ...
}
```

> A struct-scoped manifest enum that is **read from another module** (`Lexer.LookaheadDepth`
> at a foreign call site) loses its `S.`-qualified spelling. Re-export the module const
> (`export const LookaheadDepth = …;`) and rewrite the foreign reference to the bare name —
> the §4.1 manifest-enum rule still governs the *value*; only the *scope* changed.

A FUNCTION-local named D `enum` is hoisted the same way (file-private module `enum`, D name kept,
comment naming the enclosing function and D line): a TS `enum` inside a function body is re-created
on every call.

### 4.2 Named enumeration — `enum E { a, b, c }` (with member list)

A real enumeration with members. Canonical TS form: a **TS `enum`**.

```d
// dmd/console.d:36
enum Color : int
{
    black = 0, red = 1, green = 2, blue = 4,
    yellow = red | green,            // member expression: fold at translation time
    ...
}
```

→

```ts
export enum Color {
  black = 0, red = 1, green = 2, blue = 4,
  yellow = 1 | 2,                    // = 3  (resolved member expr; see 07-compile-time.md)
  ...
}
```

Verified enum facts (`_probes.md` §7):

- Default base is **`int`**; first member defaults to `0`, successors auto-increment.
- `enum → base integer` is **implicit** (`const i: number = Color.green` is fine — TS
  numeric enums coerce to `number`).
- `base integer → enum` requires an **explicit cast** in D and is **unchecked**
  (`cast(Color)99` yields a `Color` holding 99). In TS, emit `99 as Color` — **add NO
  range validation the frontend does not have.**
- enum values are **value-typed** (copying copies the integer).

**Base-type variants — this decides the numeric domain of the enum's values:**

| D base | TS form | Domain |
|---|---|---|
| `enum E : int` / `: ubyte` / `: ushort` (≤ 32-bit) | TS numeric `enum` | `number` |
| `enum E : long` / `: ulong` (64-bit) | **plain `const` object of `bigint` + `type = bigint`** (NO brand), NOT TS `enum` | `bigint` |

TS numeric `enum` members are `number`-only; a `long`/`ulong`-based enum needs `bigint`
values, which a TS `enum` cannot hold. **Canonical form: a plain `const` object of `bigint`
literals plus a bare `type E = bigint;`** — *no* branded intersection type. A 64-bit D enum
is almost always a **flag set** whose members must OR together (`a | b`, `(x & MASK) !== 0n`),
and a brand (`bigint & { __brand }`) makes every bitwise combination fail to typecheck — `a |
b` is plain `bigint`, not `E`, so the brand fights the dominant usage. Drop it.

```d
// dmd/astenums.d:51 — 64-bit flag set
enum STC : ulong
{
    none                = 0,
    ...
    // members up to 0x.... (exceeds 2^32)
}
```

→

```ts
// long/ulong-based enum: plain const object of bigint values + bare type alias (no brand).
export type STC = bigint;
export const STC = {
  none: 0n,
  ...
} as const;
```

Members OR cleanly (`STC.static_ | STC.const_`), and membership tests read
`(stc & STC.const_) !== 0n`. A value typed `STC` is interchangeable with any other
`bigint` — that is intentional for a flag set.

> An **existing** branded flag-enum in the tree (`astenums.ts` already ships the branded
> form) is **acceptable as-is** — do not churn it. The plain-`bigint` rule above governs all
> **future** `long`/`ulong` enums; do not introduce new brands.

**Verified (`/tmp/probe_types.d`):** `STC.x == 0x1_0000_0000` (4294967296) — exceeds 32 bits,
confirming the `bigint` requirement. Bit-OR of members (`red | green`) for a `< 32-bit`
enum folds with JS `|`; for a `long`/`ulong` enum it folds with BigInt `|` then
`BigInt.asUintN(64, …)` (`09-numerics.md`). The folding of member initializer expressions
themselves happens at **translation time** (`07-compile-time.md`).

> **STOP if** a named enum has a member whose initializer you cannot fold at translation
> time (depends on a non-resolvable `static`/`__traits`). Escalate per `11-escalate.md`.

---

## 5. `alias` — distinguish TYPE alias from SYMBOL / OVERLOAD-SET alias

The frontend has 679 `alias` declarations (`_ground-truth.md` §4). They split into three
kinds that translate **differently**. Classify by what is on the right of the `=`.

### 5.1 Type alias — `alias Name = <a type>;`

A new name for an existing type. Canonical TS form: **`type Name = …;`** (or `import type`
across files — `01-conventions.md`).

```d
// dmd/globals.d:642-645
alias dinteger_t = ulong;        // → type dinteger_t = bigint;
alias sinteger_t = long;         // → type sinteger_t = bigint;
// dmd/dsymbol.d:195
alias SearchOptFlags = uint;     // → type SearchOptFlags = number;
// dmd/arraytypes.d:31
alias Expressions = Array!(Expression);   // → type Expressions = Array<Expression>; (08)
```

→

```ts
export type dinteger_t = bigint;
export type sinteger_t = bigint;
export type SearchOptFlags = number;
export type Expressions = Array_<Expression | null>;   // container per 08 §3 — class elements
                                                       // are NULLABLE, uniformly (decided)
```

The `Array!T` aliases in `arraytypes.d` (`Expressions`, `Dsymbols`, …) are type aliases over
the runtime container; the container itself is owned by `08-runtime-lib.md`, but the
**alias** is a `type` declaration here.

### 5.2 Function-pointer / delegate type alias — `alias Name = … delegate(…);`

Still a type alias, but the aliased type is a callable. Canonical TS form: a **function
type** `type Name = (args) => ret;`. The `delegate` vs function-pointer / `this`-capture
detail is owned by `04-functions.md`; here just emit the function-type alias.

```d
// dmd/mtype.d:3775
alias ForeachDg = extern (D) int delegate(size_t paramidx, Parameter param);
```

→

```ts
export type ForeachDg = (paramidx: number, param: Parameter) => number;
```

### 5.3 Symbol / overload-set alias — `alias name = <a symbol>;`

The right-hand side is a **value/symbol**, not a type. The dominant frontend case is
re-exposing a hidden base-class overload set:

```d
// dmd/statement.d:116, expressionsem.d:1381, sideeffect.d:42, inline.d:2456, … (pervasive)
alias visit = typeof(super).visit;
```

**Verified (`/tmp/probe_alias.d`):** in D, overriding *one* overload of `visit` in a derived
class **hides** the base's other `visit` overloads; `alias visit = typeof(super).visit;`
re-exposes them so `d.visit("str")` reaches the base. **TS has no such name-hiding** —
declaring `visit(x: number)` in a subclass does not hide an inherited `visit(s: string)`.
Therefore:

| D | TS | Reason |
|---|---|---|
| `alias visit = typeof(super).visit;` | **(drop it)** | TS does not hide overloads; the alias is a no-op. |

Emit nothing, with an auditable comment per house style:

```ts
// resolved: `alias visit = typeof(super).visit;` dropped — TS has no overload hiding
```

> Other symbol-alias forms (`alias x = someModule.thing;` re-export, `alias add = adds;`
> at `dmd/utils.d:169` giving a second name to a function) → emit a TS `const x = thing;`
> re-binding, or a re-export `export { thing as x }`. Pick the re-export form when crossing
> module boundaries, the `const` rebind when local. An alias of an enum used as both type and
> value (`alias Fact = ParameterDFAInfo.Fact;`, dfa/fast/report.d:26) in a module that is, or will
> be, inside the core SCC becomes `export type Fact = ...` only: value uses spell the full path
> inside function bodies, never a top-level `const` rebind (01 Rule 4.5). **`alias this`** (subtyping via a
> member) does **not** occur as a live construct in the frontend's portable subset; if you
> meet one, STOP and escalate.

**Discriminator summary:** RHS is a *type* → §5.1/§5.2 (`type`/function-type). RHS is a
*symbol/value/overload set* → §5.3 (drop, rebind, or re-export). If you cannot tell whether
the RHS names a type or a symbol, STOP — the two ports are not interchangeable.

---

## 6. Tuples — `AliasSeq` / `Tuple` / type sequences

In the frontend's *own portable source*, value tuples (`std.typecons.Tuple`) and `AliasSeq`
type sequences appear almost exclusively **inside templates, `static foreach`, and mixins**,
which are resolved at **translation time** (`07-compile-time.md`). Examples are
template/CTFE machinery the frontend *implements* on user code, e.g.:

```d
// dmd/dtemplate.d:330-331 — recognizing the AliasSeq template pattern (this is FRONTEND
//   LOGIC about user code, ported as the algorithm, not a tuple we instantiate)
//   template AliasSeq(T...) { alias AliasSeq = T; }
// dmd/expressionsem.d:18574 — appears in a doc/static-foreach context
//   static foreach (x; AliasSeq!(1, 2, 3, 4)) { ... }
```

**Canonical handling:**

- An `AliasSeq!(…)` / type-sequence used to drive a `static foreach` in the frontend's own
  source → **unroll at translation time** into the concrete repeated statements
  (`07-compile-time.md`). No TS tuple is emitted.
- A genuine fixed-arity value `Tuple!(A, B)` used as a runtime value (rare) → TS **tuple
  type** `[A, B]`, accessed positionally. Use this **only** when the tuple survives as a
  runtime value after CT resolution.
- `AliasSeq` appearing *as data the frontend reasons about* (e.g. `dtemplate.d` detecting
  the `AliasSeq` user-template pattern) is **frontend logic**, ported as ordinary
  algorithm — it is not a tuple *we* instantiate. Do not "resolve" it away.

> **STOP if** you meet a value `Tuple!`/`tuple()` whose arity or element types you cannot
> determine statically, or an `AliasSeq` that is not part of a CT construct you can unroll.
> Escalate — tuples are a known thin spot.

---

## 7. Static arrays — `T[N]` (fixed length, VALUE type)

A fixed-length array embedded by value. **Verified value semantics (`/tmp/probe_types.d`):**

- `int[3] b = a;` **copies** the whole array (mutating `a` does not change `b`).
- Embedded in a struct, it copies with the struct.
- Default-initializes to all-zero (`int[3] z;` → `[0,0,0]`).
- `.length` is a **compile-time constant** of type `size_t`.

Canonical TS form: a **`number[]` (or `T[]`) of fixed conceptual length**, treated as a
value — every assignment/copy site emits a clone (`03-value-semantics.md` owns the clone).

```d
// dmd/globals.d:398
char[26] datetime;            // string returned by ctime()
// dmd/mtype.d:378
extern (C++) __gshared Type[TMAX] basic;
// dmd/mtype.d:3990
immutable ubyte[4] modsArr = [MODFlags.const_, MODFlags.immutable_, MODFlags.wild, MODFlags.shared_];
```

→

```ts
datetime: number[] = new Array(26).fill(0);   // char[26], byte buffer of fixed len 26
basic: Type[] = new Array(TMAX);              // Type[TMAX]  (TMAX resolved at CT, see 07)
const modsArr: number[] = [MODFlags.const_, MODFlags.immutable_, MODFlags.wild, MODFlags.shared_];
```

**Invariant:** `T[N]` is a **value** — copy on assign/pass/return (`03`). This is the same
copy obligation as a struct. Contrast with §8 (dynamic arrays, which share). The length `N`
(possibly a CT constant like `TMAX`, `dmd/astenums.d:231`) resolves at translation time
(`07-compile-time.md`); element-type maps recursively. Runtime ops on the array (indexing,
`.length`) follow `08-runtime-lib.md`.

> Backing a `char[N]` static array: it is a **byte buffer** (`number[]` of bytes), not a JS
> string — same model as `08-runtime-lib.md` for strings.

---

## 8. Dynamic arrays / slices — `T[]` (REFERENCE-like)

A D dynamic array is a **slice**: a (pointer, length) view onto a backing buffer.
**Verified (`/tmp/probe_arr.d`):** `int[] dyn2 = dyn;` **shares the same backing store** —
mutating `dyn[0]` changes `dyn2[0]`. This is the opposite of a static array.

Canonical TS form: **`T[]`** (a JS array), or the runtime slice type from
`08-runtime-lib.md` where slice identity/aliasing or `Array!T` interop matters.

```d
// dmd/dsymbol.d:1087-1092 (these are pointers-to-Array; the element type T[] form below
//   is the plain slice case)
int[] dyn = [1, 2, 3];        // → const dyn: number[] = [1, 2, 3];
```

**Invariant:** a `T[]` is **reference-like** (assignment shares the backing store — no
copy). Do NOT emit `.copy()` for a `T[]` assignment (that would be the §7 static-array
rule, which is wrong here). The **model** (slice = view, append/`~=` reallocation,
`.ptr`/`.length`, `Array!T` container) is owned by `08-runtime-lib.md`; this doc fixes only
that the **TS type is `T[]`** and the **semantics are share-not-copy**.

> The pervasive `Array!T` container (`dmd/root/array.d`, 123 uses) and its aliases
> (`Expressions`, `Dsymbols`, … from `arraytypes.d`, see §5.1) are the frontend's primary
> growable collection. The container API is `08-runtime-lib.md`; the *alias* is a §5.1
> `type` declaration.

---

## 9. Associative arrays — `V[K]`

A D AA is a hash map. Canonical TS form: **`Map<K, V>`** (not a plain object — D AA keys may
be non-string, and `Map` preserves key type and gives `.has`/`.get`/`.set`).

```d
// dmd/dmodule.d:1080
uint[uint] ctfe_cov;          // coverage: execution_count keyed by line
// dmd/func.d:248
bool[size_t] isTypeIsolatedCache;   // cache keyed by size_t
```

→

```ts
ctfe_cov: Map<number, number> = new Map();          // uint[uint]
isTypeIsolatedCache: Map<number, boolean> = new Map();   // bool[size_t]
```

**Invariant:** AA semantics — value `V[K]` where `V` and `K` map recursively through this
doc. Key-domain note: a `long`/`ulong` key is a `bigint`; `Map` handles `bigint` keys
correctly (unlike a plain object). The **AA runtime behavior** (lookup-or-default,
`in`/`!in`, `.get(key, default)`, `remove`, iteration order) is owned by
`08-runtime-lib.md`. This doc fixes only the **`Map<K, V>` type**.

> AA *value-read of an absent key* in D returns `V.init`, not `undefined` — that behavioral
> rule (and whether to use `.get()` + default) is `08-runtime-lib.md`. Do not assume JS
> `Map.get` semantics match; cross-reference.

---

## 10. Pointers — `T*`

Pointers appear in the frontend in three roles. Map each by role, not blindly.

| D pointer role | Example (`dmd/…`) | TS form |
|---|---|---|
| Pointer to a **class** (reference type) | `Dsymbols* members;` (`dsymbol.d:1087`) | The reference itself: `members: Dsymbols` — drop the `*` (a class is already a reference). |
| Pointer to a **struct** (by-ref to a value type) | `DsymbolAttributes* atts;` (`dsymbol.d:336`) | The struct *as a reference* (no `.copy()`): `atts: DsymbolAttributes \| null`. See `03` for ref-vs-value. |
| Pointer to a **primitive** / C buffer | `ulong* lstring;` (`expression.d:1297`), `const(char)* path` (`globals.d:188`) | Depends: C string/buffer → byte-buffer/cursor per `08`; single out-param → boxed/`{value}` per `04`. |

**Canonical rule:**

1. **`Class*` → just the class reference.** A D class is already a reference type; `T*`
   where `T` is a class adds nothing in TS. Emit `T` (nullable as needed). This is the most
   common case (`Dsymbols*`, `Expressions*`, `Expression*` fields throughout `expression.d`,
   e.g. `Expressions* exps;` at `expression.d:1693`).
2. **`Struct*` → the struct as a TS reference, NOT copied.** Taking `&aStruct` and storing
   `Struct*` is an intentional *reference* to a value type. The TS class instance is already
   a reference — store it directly and DO NOT emit `.copy()` (the pointer expressly aliases).
   This is the one place a `struct` is *not* copied; getting it wrong (copying) breaks
   aliasing the frontend relies on. Cross-reference `03-value-semantics.md` for the
   value-vs-reference decision at each `Struct*` site.
3. **`Primitive*` / `char*` → context-specific.** A `const(char)*` is a C string cursor →
   byte buffer / cursor (`08-runtime-lib.md`); its NUL-view contract (`cstrlen`/`cstr`, the
   `*p` truthiness idioms) is §11.2. A `ulong*`/`int*` used as an out-parameter →
   a boxed cell or out-param convention (`04-functions.md`). A `void*` opaque handle (e.g.
   `void* console;`, `globals.d:409`) → `unknown`/`object` opaque ref.

> **STOP if** a pointer is used for **pointer arithmetic** (`p++`, `p + n`, `*p` cursor
> walking) over a buffer in a way not covered by the `08` byte-cursor model, or if it is a
> pointer-to-pointer (`T**`). These need the runtime-lib cursor design or escalation
> (`11-escalate.md`). Plain field-holding pointers (cases 1–2) are mechanical.

**Read-only `T*` into a static array of structs → the array plus an offset parameter.** When a
`T*` points into a static array of structs and the body only reads elements through it, at
constant offsets (`numbers[0]`, `numbers[1]`, `numbers + 2` passed on), translate the parameter as
`(numbers: T[], off = 0)` and every read `numbers[i]` as `numbers[off + i]`; a `p + k` argument
becomes `(numbers, off + k)`. Instance: intrange.d:317/:325 `fromNumbers2`/`fromNumbers4` over a
`SignExtendedNumber[4]`. The shape is allowed only when no element is written through the pointer
and the pointer is never stored or returned; any other use stays an escalation (11 §3.4).

### 10.1 Bare class-typed PARAMETERS: `T` vs `T | null` — the body decides (decisive)

Every D class reference is nullable, so a bare `Module mod` parameter is as nullable as a
`Module*`. The TS spelling is decided by **the body's own behavior**, not by call sites:

- Body **dereferences it unconditionally** → type it **non-null `T`**. Call sites assert with
  `!` exactly where D would fault on null — the `!` marks the same crash point D has.
- Body **null-tests it** (`if (!mod)`, `mod && …`) → type it **`T | null`**.
- Body **neither dereferences nor null-tests it**, only compares it by identity or forwards it →
  it takes the nullability of the parameter it is forwarded to. Instance: delegatize.d:284
  `ensureStaticLinkTo(s, p)` compares `p` with `s == p` and forwards it to `toParentP`
  (dsymbolsem.d:6675), whose `p1` is `Dsymbol | null`, so `p` is `Dsymbol | null`.

**Reassignment cursors:** D freely reassigns a parameter to null while walking a chain
(`for (; s; s = s.parent)`). A TS parameter keeps its declared type, so the walk needs a
widened local. **Canonical spelling — the cursor is named `cur`** (or `curX` when a body walks
more than one chain):

```ts
let cur: Dsymbol | null = s;            // D: for (; s; s = s.parent)
for (; cur !== null; cur = cur.parent) { ... }
```

`cur` is the ONE sanctioned invented identifier for this shape (01 §2 verbatim-name carve-out)
— do not mint per-file variants.

**A PAIRED CALL is a sanctioned justification for `!` on a nullable RETURN.**
`Scope.endCTFE(): Scope | null` (`dscope.ts:697`) is faithful to D's `pop()` return, so every
`sc = sc.endCTFE()!` needs the assertion even though the `startCTFE()` immediately above makes
null unreachable. Write the `!` with the one-line justification naming the paired call —
`// non-null: paired with sc.startCTFE() above` — and do NOT widen the cursor to
`let cur: Scope` to dodge it, which loses the nullability D's signature carries. This recurs in
every CTFE-bracketing body, so the wording is fixed here rather than reinvented per file.

**Delegate/function-typed parameters: the UNION of all bodies decides.** When one delegate
type serves many call-site bodies (`foreachDsymbol`'s `dg`, `ForeachDg`, the `&symbolDg`
family), type its parameter by the union of every D body bound to it: **if ANY body
null-tests the parameter, the delegate parameter is `T | null`**, and the dereferencing
bodies carry the `!` inside themselves — the fault site is the body, not the forward.
Verified instance: dsymbol.d's `int`-overload `foreachDsymbol` has null-testing delegates
(dsymbolsem.d:7204/:7208/:7215) → `dg: (s: Dsymbol | null) => number`; the `void` overload
has only dereferencing bodies → non-null. Enumerate the bodies (grep the delegate's call
sites) before typing the parameter; when new bodies arrive in later waves and one
null-tests, widening the delegate type is the owner-file fix, not per-caller casts.

---

## 11. `Nullable` / `Optional`

The frontend's optional type is `dmd.root.optional.Optional!T` (`dmd/root/optional.d`),
used e.g. for tri-state booleans:

```d
// dmd/expression.d:583, 808, 1041, … (override Optional!bool toBool())
Optional!bool toBool() { ... }
```

`Optional!T` is a **struct** with `value: T` + `present: bool`, and methods `isPresent()`,
`isEmpty()`, `get()` (asserts present), `hasValue(x)`, `create(x)` (`optional.d:44-90`).

**Canonical mapping: port `Optional<T>` as a faithful generic class** (it is a small
`struct`, value-typed — §2 copy rules apply if copied). Do **not** collapse it to TS
`T | undefined` / `T | null` — the frontend calls `.isPresent()`/`.get()`/`.hasValue()`
explicitly, and `Optional!bool` has **three** states (absent, `true`, `false`) that
`boolean | undefined` would muddle at call sites. Keeping the class preserves the call sites
1:1 (faithful-port priority, `_ground-truth.md` §1.2).

```ts
// faithful 1:1 port of dmd/root/optional.d
export class Optional<T> {
  private value!: T;
  private present = false;
  // value-constructor-only struct: `Optional!int opt;` (no arg) is the empty/default state.
  // The arg-presence check reproduces D's "default-construct vs value-construct" split —
  // see 03-value-semantics.md "Default construction of a value-constructor-only struct".
  constructor(value?: T) { if (arguments.length) { this.value = value as T; this.present = true; } }
  // static factory parameterized by the type variable — see 04-functions.md "Static factory on a generic type".
  static create<T>(val: T): Optional<T> { return new Optional<T>(val); }
  isPresent(): boolean { return this.present; }
  isEmpty(): boolean { return !this.present; }
  get(): T { assert(this.present); return this.value; }       // assert helper per 09/house rules
  // `===` is correct ONLY because the frontend instantiates Optional with primitive T (bool/int).
  // For a struct T this would be silently wrong — see caveat below + 05-operators.md
  // "Operators on a generic type parameter".
  hasValue(exp: T): boolean { return this.present && this.value === exp; }
  // shallow copy: correct because T is primitive here (bool/int) — see 03-value-semantics.md
  // "copy() of a generic field". A struct T would require deep-copying value.
  copy(): Optional<T> { const o = new Optional<T>(); o.value = this.value; o.present = this.present; return o; }
}
```

> **Caveat — the `===` in `hasValue` is NOT universally safe on a generic `T`.** It is
> correct *here* only because the frontend instantiates `Optional` with **primitive `T`**
> (`Optional!bool`, `Optional!int`), where D `==` and JS `===` agree. If `T` were a struct,
> D `==` is **field-wise** while `===` is reference identity — `===` would be silently
> wrong. Likewise `copy()` is a **shallow** copy of `value`, valid only for primitive `T`.
> Before reusing this shape for any non-primitive instantiation, see `05-operators.md`
> "Operators on a generic type parameter" (for the equality dispatch) and
> `03-value-semantics.md` "copy() of a generic field" (for the field copy).

**Invariant:** `get()` on an empty `Optional` **asserts/throws** (`optional.d:81`,
verified by the module's own unittest catching `AssertError`) — preserve the throw; do not
return `undefined`. `Optional!T` is itself a `struct` → if copied, follow §2 / `03`.

> Where the frontend uses a raw nullable class reference (e.g. a `Dsymbol` field that may be
> `null`) — that is NOT `Optional`; it is a plain reference typed `T | null`. Use `Optional`
> **only** where the D source uses `Optional!T`.

---

## 11.1 UnionExp / emplaceExp (CTFE expression construction)

**Verified (`dmd/ctfeexpr.d:45-117`).** `UnionExp` is a `struct` wrapping a **private
`align(8)` union** whose members are `char[__traits(classInstanceSize, X)]` arrays — one per
`Expression` subclass (`IntegerExp`, `RealExp`, `StringExp`, …). The union is sized to hold
**any** `Expression` subclass **in place**, so CTFE constant-folding can return an expression
**without a GC allocation**: the value sits on the stack inside the `UnionExp`. This is a
**value-storage optimization**, *not* a semantic / layout-dependent union.

> **This is NOT an escalation case.** The union here has nothing to do with overlapping
> fields whose layout matters; it is purely a sizing trick to avoid an allocation. `11-escalate.md`
> **carves it out** explicitly: `UnionExp` is ported by the canonical mapping below, never
> escalated as a "layout-dependent union."

**What vanishes:** the private `union u` and *all* its `__traits(classInstanceSize, …)`
members **disappear**. Under GC, sizing an expression to embed it in a stack buffer is
meaningless — we hold a single `Expression` **reference** instead.

| D construct (`ctfeexpr.d`) | TS form |
|---|---|
| `struct UnionExp { ... private union u; }` | `class UnionExp` holding **one** `Expression` reference |
| `this(Expression e) { memcpy(&this, e, e.size); }` | `this.e = e.copy();` (the memcpy is a shallow clone) |
| `emplaceExp!(SomeExp)(&ue, args...)` | `ue.emplace(new SomeExp(args...));` |
| `ue.exp()` (`cast(Expression)&u`) | `return this.e;` (no pointer reinterpret) |
| `ue.copy()` | sentinel switch (below) |

**Canonical port of the type:**

```ts
// faithful port of dmd/ctfeexpr.d:45-102 — value-storage optimization collapses to a
// single reference (the in-place/stack aspect is irrelevant under GC).
export class UnionExp {
  // The D private `union u` (char[classInstanceSize(...)] members) VANISHES — sizing is
  // meaningless under GC. We hold one Expression reference.
  private e!: Expression;

  // emplaceExp!(T)(&ue, args...) -> ue.emplace(new T(args...))
  emplace(x: Expression): void { this.e = x; }

  // D this(Expression e) { memcpy(...) } and emplaceExp!(UnionExp)(&ue, e) copy the bytes of `e`:
  // a shallow clone, so the call site is ue.emplace(e.copy()), never ue.emplace(e)

  // ue.exp(): D returns cast(Expression)&u — here just the stored reference.
  exp(): Expression { return this.e; }

  // ue.copy(): KEEP the sentinel switch faithfully (ctfeexpr.d:62-76).
  copy(): Expression {
    const e = this.exp();
    // D `assert(e.size <= u.sizeof)` is a storage-size check — DROPS (no fixed buffer).
    switch (e.op) {
      case EXP.cantExpression: return CTFEExp.cantexp;
      case EXP.voidExpression: return CTFEExp.voidexp;
      case EXP.break_:         return CTFEExp.breakexp;
      case EXP.continue_:      return CTFEExp.continueexp;
      case EXP.goto_:          return CTFEExp.gotoexp;
      default:                 return e.copy();   // ported Expression.copy() shallow-clone
    }
  }
}
```

**`emplaceExp` reproduction.** The free template `emplaceExp!(T : Expression, Args...)(void* p, args)`
(`ctfeexpr.d:104-112`) blits `T.init` into the buffer then runs `T.__ctor(args)` in place;
the `emplaceExp!(T : UnionExp)(T* p, Expression e)` overload (`ctfeexpr.d:114-117`) `memcpy`s
an existing expression in. The constructor form collapses to **construct on the GC heap, store the
reference**; the memcpy form is a **shallow clone** (byte-identical to `Expression.copy()`,
expression.d:178-195), so it stores a copy:

```ts
// emplaceExp!(SomeExp)(&ue, args...)
ue.emplace(new SomeExp(args...));   // construct on GC heap; in-place/stack aspect irrelevant
// emplaceExp!(UnionExp)(&ue, e)
ue.emplace(e.copy());               // D copied the bytes: later writes to ue.exp() must not reach e
```

Storing `e` itself is wrong: D code mutates `ue.exp()` after the memcpy (constfold.d:937-938 `Cast`
repaints `.type`; ctfeexpr.d:406-407 and :442-444 do the same), and `e` may be a shared singleton
such as `IntegerExp.literal!0`.

**`copy()` faithfulness — keep the sentinel switch.** The five sentinel `EXP` ops
(`cantExpression`, `voidExpression`, `break_`, `continue_`, `goto_`) must return the matching
**`CTFEExp` singleton** (`CTFEExp.cantexp`, `.voidexp`, `.breakexp`, `.continueexp`, `.gotoexp`
— `ctfeexpr.d:69-73`), not a copy. Every other op returns `this.e.copy()` (the ported
`Expression.copy()` shallow-clone). The D `assert(e.size <= u.sizeof)` (`ctfeexpr.d:66`) is a
**storage check** against the fixed union buffer — it **DROPS** (leave a `// dropped: storage
size check, no fixed buffer` comment).

**No stack-dangling defensive copy.** D's `copy()` exists partly because the embedded
expression lives on the stack inside `UnionExp` and would dangle once `ue` leaves scope. In
TS, `Expression`s are **classes (reference types)** living on the GC heap — that concern does
not exist. Keep `e.copy()` **only where D copies** — an explicit `.copy()`, or a memcpy of `e.size`
bytes such as `emplaceExp!(UnionExp)` (faithful); do **not** add any extra defensive copy. Where D returns the stored reference (`exp()`), the TS returns the same
reference.

**Signatures and call sites are unchanged in shape.** Functions returning `UnionExp` keep
that return type; call sites doing `ue.exp()` / `ue.copy()` are identical in shape.

**Write-through into caller storage — `*pue = <call>` (`dmd/dinterpret.d:3166`).** The CTFE
interpreter receives a `UnionExp* pue` and stores a fold result into the caller's slot:

| D construct (`dinterpret.d:3166`) | TS form |
|---|---|
| `*pue = evaluate(loc, type, e1, e2);` | `pue.emplace(evaluate(loc, type, e1, e2).exp());` |

This write-through stores the returned reference without a copy. It is sound because the content of a
returned `UnionExp` is always fresh: every producer either constructs a new node or clones through
`emplace(e.copy())`.

**Interior aliases into a `UnionExp`.** D code may keep `Expression v = uv.exp();` and later overwrite
`uv` in place (`uv = Mul(loc, v.type, v, r);`): `v` points into `uv`'s storage and sees the new node. With
`UnionExp` reduced to one reference nothing can make `v` follow, so every overwrite is followed by the
re-derivation `v = uv.exp();` (03 §1.1). Instance: constfold.d:451-469 (`Pow`), pinned against ldc2.

**`out UnionExp` parameters** (`cantExp(out UnionExp ue)`, constfold.d:59) pass the class instance
unboxed: `emplace` overwrites the only slot, which is exactly the `out` reset.

```d
// dmd/dinterpret.d:3166 — write-through: store a UnionExp-returning call into *pue
*pue = evaluate(e.loc, e.type, e1, e2);
result = (*pue).exp();
```

→

```ts
// src/dmd/dinterpret.ts — copy the SINGLE stored reference into the caller's UnionExp.
// `UnionExp` is now a class (reference); a naive `this.pue = evaluate(...)` would ALIAS
// the callee's wrapper. Faithful to D's by-value struct copy-through-pointer, we copy the
// contained Expression reference via emplace.
pue.emplace(evaluate(e.loc, e.type, e1, e2).exp());
const result = pue.exp();
```

**`UnionExp*` as a parameter / `&ue` as argument (`dmd/dinterpret.d:3034,6286`).** A function
taking `UnionExp* pue` becomes one taking `pue: UnionExp` (the class reference); the call site
`interpret(&ue, …)` drops the `&` — address-of a class-mapped value is just the object
reference (cross-ref `03-value-semantics.md` §7.1 *Address-of a CLASS object — trivial (it's
already a reference)*).

| D construct (`dinterpret.d`) | TS form |
|---|---|
| `interpret(UnionExp* pue, …)` (`:6286`) | `interpret(pue: UnionExp, …)` |
| `interpret(&ue, …)` (`:3034`) | `interpret(ue, …)` |

```d
// dmd/dinterpret.d:6286 — signature ; dinterpret.d:3034 — call site
Expression interpret(UnionExp* pue, Expression e, InterState* istate, ...) { ... }
...
UnionExp ue1 = void;
Expression e1 = interpret(&ue1, e.e1, istate);
```

→

```ts
// src/dmd/dinterpret.ts — UnionExp* -> the class reference; `&ue1` -> just `ue1`.
function interpret(pue: UnionExp, e: Expression, istate: InterState, ...): Expression { ... }
...
const ue1 = new UnionExp();          // `UnionExp ue1 = void;` -> allocate the wrapper
const e1 = interpret(ue1, e.e1, istate);
```

**BEFORE / AFTER (`dmd/constfold.d:69-89`, the `Neg` fold):**

```d
// dmd/constfold.d:69-89
UnionExp Neg(Type type, Expression e1)
{
    UnionExp ue = void;
    Loc loc = e1.loc;
    if (e1.type.isReal())        { emplaceExp!(RealExp)(&ue, loc, -e1.toReal(), type); }
    else if (e1.type.isImaginary()) { emplaceExp!(RealExp)(&ue, loc, -e1.toImaginary(), type); }
    else if (e1.type.isComplex())   { emplaceExp!(ComplexExp)(&ue, loc, -e1.toComplex(), type); }
    else                            { emplaceExp!(IntegerExp)(&ue, loc, -e1.toInteger(), type); }
    return ue;
}
```

→

```ts
// src/dmd/constfold.ts
function Neg(type: Type, e1: Expression): UnionExp {
  const ue = new UnionExp();           // `UnionExp ue = void;` -> just allocate the wrapper
  const loc = e1.loc;
  if (e1.type.isReal())            { ue.emplace(new RealExp(loc, -e1.toReal(), type)); }
  else if (e1.type.isImaginary())  { ue.emplace(new RealExp(loc, -e1.toImaginary(), type)); }
  else if (e1.type.isComplex())    { ue.emplace(new ComplexExp(loc, -e1.toComplex(), type)); }
  else                             { ue.emplace(new IntegerExp(loc, -e1.toInteger(), type)); }
  return ue;
}
```

> This pattern recurs **pervasively**: `dmd/constfold.d` (the fold functions all build a
> `UnionExp` and `emplaceExp` the result), `dmd/dinterpret.d` (the CTFE interpreter), and
> `dmd/ctfeexpr.d` itself. Apply this one mapping everywhere; do not re-derive per site.
> Numeric domain of the folded operands (`number` vs `bigint`, wrap/truncate) is owned by
> `09-numerics.md`; the union-vs-escalate carve-out is owned by `11-escalate.md`.

---

## 11.2 C-string / NUL view over a `DString`

A `const(char)*` (and the buffers returned by `toChars()` / `peekChars()` / `extractChars()`)
is a **C string**: a byte sequence terminated by a `0x00` NUL. The frontend port represents
the underlying bytes as a `DString` (the UTF-8 byte buffer — full model in
`08-runtime-lib.md`), but a C string's **logical length is the bytes *before* the first NUL**,
not `ds.length`. The two differ: the conversion helpers append a trailing NUL, so the returned
`DString` *includes* it (`extractChars()` etc. return a NUL-terminated `DString`, trailing
`0x00` present), while the C-string value is everything up to — and excluding — that NUL.

**Canonical helpers (`src/dstring.ts`):**

| D idiom | TS form |
|---|---|
| `strlen(p)` over a `const(char)*` | `cstrlen(p)` → `number` (count of bytes before first NUL) |
| `p[0 .. strlen(p)]` (the logical C string) | `cstr(p)` → `DString` (slice up to first NUL, NUL excluded) |

```ts
// src/dstring.ts
// Logical length of a C string: bytes before the first NUL (0x00). NOT p.length.
export function cstrlen(p: DString): number {
  let n = 0;
  while (n < p.length && p[n] !== 0) n++;
  return n;
}
// The logical C string as a DString view: bytes up to (excluding) the first NUL.
export function cstr(p: DString): DString { return p.subarray(0, cstrlen(p)); }
```

**Pointer-truthiness / NUL idioms** (the C-string `*p` tests):

| D | TS |
|---|---|
| `if (*p)` (non-NUL byte at cursor) | `p.length > 0 && p[0] !== 0` |
| `if (!*p)` / `*p == 0` (at NUL / end) | `p[0] === 0` |
| `*p++` consume one byte then advance | read `p[i]`, then `i++` (cursor per `08` / §10 case 3) |

> A `%.*s` format with an explicit precision **stops at the first NUL inside the precision
> window** — the precision bounds the scan, but a NUL still terminates early (owned by the
> `dmdformat` runtime, `10 §3.5`). When porting a `printf("%.*s", n, p)` over a C string,
> the emitted bytes are `cstr(p.subarray(0, n))`-equivalent, not a blind `n`-byte slice.

The byte-buffer backing, `ds()`/`dsUtf8()` encoding boundary, and slice/cursor mechanics are
owned by `08-runtime-lib.md`; this section fixes only the **NUL-view contract** (`cstrlen` /
`cstr`) and the `*p` truthiness idioms so a C-string read ports 1:1.

**A STORED `const(char)*` field is an explicit offset, never a derived view.** When a class or
struct *field* holds a C-string cursor into a larger buffer, model it as `{ buf: DString;
offset: number }` (or a bare `offset: number` when the buffer is contextually fixed and named
in the field's interface comment). Do **NOT** model it as a suffix `subarray` view whose
position must later be reverse-engineered by length subtraction (`base.length - view.length`)
— that arithmetic is fragile, breaks the moment two views share a base, and reads as magic to
the auditor. The transient parameter-cursor case (`{ buf, p }`) is `06-control-flow.md §5.5`;
this rule extends the same shape to **stored** fields.

A `const(char)[]` FIELD whose null `.init` is observable (json.d `requiredProperty` prints `null`,
`property` skips) is `DString | null = null`, as `Output.name` is. `ds("")` is correct only where
every reader tests `.length`.

---

## 11.3 D `union` — the decision procedure (bit-punned carrier vs tag-selected variant)

`11-escalate.md §3.5` owns the escalate-vs-carve-out list; this section owns the **decision
procedure** an agent runs when meeting any `union` (named or anonymous, top-level or nested):

1. **Is any member READ through a DIFFERENT member's type on a live in-scope path?**
   (Write `unsvalue`, read `intvalue`; write bytes, read a float.) → **bit-punned carrier.**
   Model the aliasing members as ONE raw storage slot + accessors that reinterpret
   (`toInt64`/`toUint64` etc., the `Token` carve-out shape in `11-escalate.md §3.5`). If the
   pun is anything beyond an int↔uint bit-share you can prove, STOP (`category: union
   value-layout`).
2. **Are the members mutually exclusive, selected by an existing discriminant** (a tag field,
   the node's `op`/`ty`), never read through each other? → **tag-selected variant.** Emit the
   members as separate fields, and apply the **mandatory invalidation step**: every write to
   one member RESETS the members it shadows to their `.init` (`09-numerics.md §1.0`). D's
   write physically clobbers the other members; a TS object without invalidation keeps the
   STALE previous value alive, and a buggy stale read then returns something plausible where
   D would return garbage — the invalidation makes that divergence loud and deterministic
   instead of silently wrong. One `resetPayload()`-style private helper per union, called by
   every member setter; do not scatter per-field resets.
3. **Does the union exist only to SIZE a buffer** (one member live ever, read back through the
   same type — `UnionExp`)? → the §11.1 collapse (single reference), no invalidation needed.
4. **Anything else** — members whose layout/alignment is itself the semantics, punning you
   cannot prove narrow — **STOP and escalate** (`11-escalate.md §3.5`).

---

## 11.4 TypeScript narrowing vs MUTABLE frontend state — the canonical remedies

TS control-flow narrowing assumes a tested value does not change behind the test. Frontend
state is pervasively mutable (`this.token.value` changes on every `nextToken()`), so a naive
translation accumulates spurious narrowing errors, and the first port "fixed" them with
blanket `as TOK` assertions (which also suppress REAL errors) and invented accessor helpers
(which add non-upstream members). Both are forbidden. **The base remedy: re-read the
discriminant into a freshly-declared `const`, immediately before each test group, and test the
local.**

```ts
// BAD — narrowing goes stale across the mutating call; the `as` papers over it:
if (this.token.value === TOK.leftParen) { this.nextToken();
  if ((this.token.value as TOK) === TOK.rightParen) { ... } }   // forbidden blanket assertion
// GOOD — fresh const per test group, re-read AFTER the mutation:
const tv: TOK = this.token.value;      // re-read AFTER the mutation, before the tests
if (tv === TOK.rightParen) { ... }
```

Rules: the local is `const`, named tersely (`tv`, `ty`), and scoped to one test group — after
the next mutating call, read a fresh one. Never `as`-assert the field inline; never add an
accessor to defeat narrowing.

**The annotation is not what widens the local — and nothing does.** A declaration takes its
flow type from the INITIALIZER, not from its annotation: where `obj.f` is already narrowed to
`null`, `const x: T | null = obj.f` is still `null`, and the following `if (x !== null)`
collapses to `never`. `let` behaves identically. So the base remedy works only where the
re-read happens before any narrowing of the field. Four further shapes cover the cases where
it does not:

- **The FIELD is already narrowed at the test site** → alias the OBJECT, not the discriminant:
  `const dim2: Expression = mtype.dim; if (dim2.op === EXP.error)`. Better where you can: do the
  re-read at the ORIGINAL test site, so the field is never narrowed in the first place.
- **The local is written from inside a CLOSURE** → a one-slot box. TS control-flow analysis
  ignores closure writes, so a plain local keeps its initial type after the callback has run.
  Canonical: `const fd: { best: FuncDeclaration | null; ambig: FuncDeclaration | null } =
  { best: null, ambig: null }`, or `Ref<T | null>`; tree precedents `funcsem.ts:2369`,
  `enumsem.ts:723`. This is not a one-off — D accumulates state through `foreachDsymbol` /
  `each!` / `overloadApply` callbacks constantly.
- **The narrowing comes from an ASSIGNMENT you must emit** (a D `out`-parameter reset) → write
  through a freshly-declared alias of the box and keep reading through the original:
  `const psReset: { value: Dsymbol | null } = ps; psReset.value = null;`, then go on reading
  `ps.value`.
- **A loop condition that tests the field** (`while (token.value == X)`) narrows the whole body.
  Canonical: `while (true) { const tv: TOK = this.token.value; if (tv !== X) break; … }`.

**Two adjacent D tests of the same mutable field are TWO test groups.** Sharing one local makes
the second test a TS2367 ("this comparison appears to be unintentional"), and the tempting fix
is to delete D's second guard — which deletes a check D performs. Give each D test its own
re-read. If a site cannot be expressed by any of these shapes, STOP.

**The uninitialized-non-nullable-static probe** is the ONE other sanctioned `as` shape: a
ported static declared non-null but left unassigned until an init function runs (e.g.
`Type.dtypeinfo`, mtype.ts:600) cannot be truth-tested directly (TS trusts the declared
type). Canonical form, comment mandatory:

```ts
// probe: Type.dtypeinfo is declared non-null but unset until <init>; D tests `if (Type.dtypeinfo)`
if ((Type as { dtypeinfo?: unknown }).dtypeinfo) { ... }
```

Reviewers accept exactly this spelling with its comment; any other inline `as` remains a
finding. **The probe comment is repeated at every occurrence** — the audit is per-line, so a
cross-reference to an earlier one ("probe: as above") fails it.

---

## 11.5 D field SHADOWING vs TS structural checks — the audited upcast cascade

D allows a subclass field to shadow a base field of a DIFFERENT type
(`AggregateDeclaration.deferred: Dsymbol` over `Dsymbol.deferred: bool`;
`Module.errors: uint` over `Dsymbol.errors: bool`). The names are verbatim-fidelity (01 §2),
so the port keeps the shadowing — and TS's structural checks then reject perfectly-sound
upcasts (`ClassDeclaration` where `AggregateDeclaration` is expected) and identity compares
across the hierarchy (`sc._module === p` → "no overlap").

**Canonical form: the audited upcast cascade** — `x as unknown as Base`, with a comment
naming the shadowed field:

```ts
checkAccessAggregate(cd as unknown as AggregateDeclaration, ...)
// upcast cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool)
```

Rules: (a) the comment names the shadowing field pair — an uncommented cascade is a review
finding; (b) the cascade appears at the USE site, never baked into a helper; (c) this is a
TS-typing artifact only — the runtime object IS the subclass, nothing is reinterpreted; (d)
tree precedents: dclass.ts:258, dscope.ts:265, dimport.ts:127. Reviewers verify the named
field pair actually shadows; then the cascade is accepted, not re-litigated.

### 11.5b SHADOW-SPLIT (RULED): a redeclared field with TWO LIVE SLOTS — rename the DERIVED one

Distinct from §11.5's typing-only case: when D redeclares a base field name and BOTH slots
are live at runtime with different values (D selects by the reference's STATIC type; one JS
property cannot hold two values), the ruling is: **the BASE field keeps the verbatim D name;
the DERIVED redeclaration takes a registered rename**, marked at the declaration:
`// shadow-split: D redeclares <Base>.<name>; this is the DERIVED slot (02 §11.5b registry)`.
Because D's static-type selection is decidable at every use site, the translator rewrites
derived-slot accesses to the renamed field and leaves base-slot accesses (isAnonymous,
addMember anonymity gates, hdrgen) on the verbatim name — both D behaviors survive.

REGISTRY (grows by docFeedback; names are ratified once listed):

| D site                                         | derived slot renamed to | status   |
|------------------------------------------------|-------------------------|----------|
| declaration.d:706 `SymbolDeclaration.dsym`     | `dsymAgg`               | shipped  |
| dsymbol.d:1511 `AliasAssign.ident`             | `identAssign`           | shipped  |
| aliasthis.d:28 `AliasThis.ident`               | `identAlias`            | shipped  |
| aggregate.d:94 `AggregateDeclaration.deferred` | `deferredTI`            | shipped  |
| dtemplate.d:807 `TemplateInstance.deferred`    | `deferredTI`            | shipped  |
| mtype.d:2145 `TypeTag.mod`                     | `modTag`                | shipped  |
| attrib.d:706 `UserAttributeDeclaration.atts`   | `attsUda`               | shipped  |

**Read the status before you write the name.** `ratified` means the name is DECIDED, not
applied: the owner file still spells the verbatim D name, so a consumer emitting the new name
before the owner applies it does not compile. A ratified row is **binding on the owner
file** — whoever next owns it applies the rename — and until it is applied, consumers use the
§11.5 cascade as the sanctioned interim form. Those cascades are the rule working, not
sloppiness, and are not re-litigated file by file.

A consumer of a registered-but-unapplied row writes the cascade **and** files a
`dependency signature` record (`11 §1`), because §11.5's clause (c) does not hold here: the
cascade reinterprets nothing, but the underlying slot really is two D slots merged into one JS
property. Clause (c) alone would certify a live storage bug as a typing artifact.

**Second symptom, easy to misread.** An unapplied rename can surface as a VISIBILITY error
rather than a type mismatch — `Property 'atts' is private in type 'Dsymbol' but not in type
'UserAttributeDeclaration'` — because the base field is emitted TS-private while the derived
redeclaration is not. That is this rule's symptom; do not "fix" it by widening the base field's
visibility (`10 §1.7`).

**Third symptom, on applying a split.** Removing an incompatible instance-side shadow unmasks TS2417
on the class's static side wherever a subclass hides a base static of another signature (`create`,
`arraySyntaxCopy`). It is the D non-virtual static hiding already handled at attrib.ts:263 /
declaration.ts:460: one `@ts-expect-error` on the class line naming the hidden static.

A site not yet in the registry: pick a name by the same scheme (verbatim + short semantic
tag naming the derived content), mark it, and file docFeedback so the row lands here.

### 11.5c The audited-`as` WHITELIST (mirror of 14 §3 item 4)

These `as` shapes pass review, each with its mandatory adjacent proof/comment. Anything else
spelled `as` on a code line is a finding.

1. the §11.5 upcast cascade (`x as unknown as Base` + shadowed-pair comment);
2. the §11.4 uninitialized-static probe (`(C as { f?: unknown }).f` + probe comment);
3. **the tag-proved RTTI downcast** — the literal TS form of D's `cast(typeof(return))this`
   in every `isXxx()` family: `return this.dsym === DSYM.varDeclaration ? (this as unknown
   as VarDeclaration) : null;` — the tag/DYNCAST compare immediately adjacent IS the proof,
   exactly as in D; `instanceof` remains forbidden as a substitute. The proof may take five
   wider forms, each of which the comment must spell out:
   - **a SET of tags** established by an adjacent test, where no single `isXxx()` expresses the
     target class: `cast(CatAssignExp)` (`expressionsem.d:13543/:13548`) covers
     `concatenateAssign`, `concatenateElemAssign` and `concatenateDcharAssign`, so op-keyed
     `isCatAssignExp()` cannot be the proof. The comment names the tag set. Recurs for
     `cast(BinAssignExp)` and `cast(DefaultInitExp)`;
   - **a tag test proving a SUPERCLASS** the `isXxx()` family cannot express: at
     `initsem.d:1568`, `op == EXP.construct || op == EXP.blit` proves an `AssignExp` subclass
     while `isAssignExp()` tests `EXP.assign` alone;
   - **the enclosing `case` label of a `dyncast` switch** (`expressionsem.d:9930-9952`),
     provided the comment names it;
   - **an adjacent `assert` naming a tag set**, for a D `cast(TypeNext)` (or any static
     downcast) with no tag test in the source, walking a chain the same function built
     (cparse.d:2870): the `assert` names the tag set of the constructors that built the chain;
   - **a constructor-set flag** proving the class: `p.Ccompile` is set only by the CParser
     constructor (cparse.d:87 `Ccompile = true;`), so `if (p.Ccompile) (p as unknown as CParser)`
     ports D's `cast(CParser!ASTCodegen)p` (iasm/gcc.d:217); the comment names the constructor that
     sets the flag;
4. **the branded flag-enum re-cast** after a bitwise op (`(a | b) as STC`, `v as E`) —
   D's `cast(STC)`, sanctioned by §4.2;
5. **the same-class `copy()` re-cast** — `x.copy() as unknown as <x's own class>` for D's
   `cast(T)x.copy()` (`opover.d:147/:169`; precedents `expression.ts:2046/:2086`), with the
   comment quoting D's cast and the `copy()`-preserves-the-prototype contract;
6. **opaque-slot re-typing** — ONE cast, inside ONE accessor function, with a comment naming
   the owner `file:line` that left the slot `unknown` and why (`templatesem.ts:370`
   `td.instances as TemplateInstanceTable`, over `dtemplate.ts`'s deliberately-opaque
   `instances: unknown`). Where the owner can instead type the slot at its declaration via
   `import type`, that is preferred and the cast disappears;
7. **the re-widening** `(x.value as TOK)` after a call that mutates a field TS has narrowed
   (`nextToken()` after a `this.token.value === TOK.x` test): the parse.ts idiom, comment optional.

**Two inverse rules — the `as` that should not be there at all.** Both cost more audit time
than the gaps above:

- **An upcast to a base class needs NO cast.** The class hierarchy is nominal:
  `FuncDeclaration` IS a `Dsymbol`. Before commenting a cascade, **delete it and re-run tsc —
  a cascade that compiles away was never a cascade.** One file started with ~45 of them on
  plain upcasts, and a test file carried six on `FuncDeclaration → Dsymbol`; the tempting
  remedy (add a shadowed-pair comment) would have written a false claim into the file. A
  needless cascade silently disables real type checking at that argument.
- **A D `cast(Container!Derived*)` to `Container!Base*` is a PLAIN assignment.** TS accepts
  `Array<Expression | null>` where `Array<RootObject | null>` is expected, because the
  container's methods are declared with method syntax and therefore checked bivariantly. If
  tsc rejects such an assignment, the cause is field shadowing and rule 1 applies — never add
  an `as` here reflexively.

**Comment scale.** Where one file carries MANY cascades from FEW shadowing pairs (79 from
three pairs in a single fragment), a **file- or class-level cascade note** listing the pairs
replaces the per-site comment, which would otherwise add ~160 lines of identical noise; the
per-site comment is then reserved for a pair the note does not list. This concession is for
the cascade only — the §11.4 probe comment is repeated at every occurrence.

---

## 12. Quick reference (one canonical TS form per D type)

| D | TS | Section |
|---|---|---|
| `void` | `void` | §1 |
| `bool` | `boolean` | §1 |
| `byte ubyte short ushort int uint` | `number` | §1 / `09` |
| `long ulong` | `bigint` | §1 / `09` |
| `cent ucent` | — (obsolete, STOP) | §1.2 |
| `char wchar dchar` | `number` | §1 / `08` (strings) |
| `float double real` | `number` | §1 |
| `size_t ptrdiff_t` | `number` | §1 / `09` |
| `struct S` | `class S` (value — copy on move) | §2 / `03` |
| `class C` | `class C` (reference) | §2 |
| `interface I` (sig-only) | `interface I` | §3 |
| `interface I` (with body) | `abstract class I` | §3 |
| `enum X = v;` | `const X = v;` | §4.1 |
| `enum E { … }` (≤32-bit base) | TS `enum E` | §4.2 |
| `enum E : long/ulong { … }` | plain `const` object of `bigint` + `type E = bigint` (no brand) | §4.2 |
| `alias N = Type;` | `type N = …;` | §5.1 |
| `alias N = … delegate(…);` | `type N = (…) => ret;` | §5.2 |
| `alias visit = typeof(super).visit;` | (drop — no TS overload hiding) | §5.3 |
| `AliasSeq!(…)` in CT context | unroll at translation time | §6 / `07` |
| runtime `Tuple!(A,B)` | `[A, B]` | §6 |
| `T[N]` (static array) | `T[]` (value — copy on move) | §7 / `03` |
| `T[]` (dynamic array/slice) | `T[]` (reference — shares) | §8 / `08` |
| `V[K]` (assoc array) | `Map<K, V>` | §9 / `08` |
| `Class*` | the class reference (drop `*`) | §10 |
| `Struct*` | struct as reference (no copy) | §10 / `03` |
| `char*` / `void*` / `prim*` | byte cursor / boxed out / opaque | §10 / `08` / `04` |
| `Optional!T` | `class Optional<T>` (faithful) | §11 |
| `UnionExp` / `emplaceExp!(T)(&ue, …)` | `class UnionExp` (one ref) / `ue.emplace(new T(…))` | §11.1 |
