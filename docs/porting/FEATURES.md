# FEATURES — Inventory & Scope Reference (what we cover vs what we skip)

> READ `_ground-truth.md` FIRST. This doc is the authoritative **in-scope / out-of-scope**
> reference for the D→TypeScript porting guide. It answers three questions:
> 1. **What D feature subset does the frontend actually use?** (the surface we must translate,
>    with verified counts from `_ground-truth.md §4`).
> 2. **What does this guide COVER?** (which rule doc owns each construct).
> 3. **What do we SKIP, and WHY?** (excluded modules, erased attributes, codegen, plus the
>    notable judgment calls).
>
> When you need the *rule* for a construct, this doc points you to the owning doc (01–14). When
> you need to know whether something is even in scope, this doc decides it. If a construct is
> neither covered nor explicitly skipped here, that is itself a STOP-and-escalate trigger
> (`11-escalate.md`).

---

## 0. The framing that determines scope (do not lose this)

We are porting the **compiler frontend**, not D programs. Two layers, never conflate them:

- **Frontend source code** — the `dmd/*.d` files — is written in a *constrained subset* of D:
  the `extern(C++)` portable subset (735 decls). **That subset is the surface this guide
  teaches you to translate.** It is JS-friendly by construction (no range-UFCS pipelines, no
  GC-finalizer reliance, no heavy template metaprogramming in hot paths).
- **D language features the frontend *implements*** (full templates, CTFE over user code,
  `static if` over user types, mixins on user input) are **not** re-designed in JS. They arrive
  *for free* as the faithful translation of the algorithms in `dtemplate.d`, `dinterpret.d`,
  `dsymbolsem.d`, etc. We translate the algorithm; the algorithm provides the feature.

So "translate `static if`" in this guide means: resolve a `static if` **in the frontend's own
source** at translation time (`07-compile-time.md`) — NOT make the ported compiler evaluate
`static if` in user code (that is just the faithful port of `*sem.d`).

---

## 1. The D feature SUBSET the frontend uses (verified counts)

Counts are matching-line greps across `dmd/*.d` (`_ground-truth.md §4`). They are the *actual*
surface to cover — already probed, build on them, do not re-derive. Each row maps to the guide
doc that owns the translation rule.

### 1.1 Declarations & aggregates

| Feature | Count | Disposition | Owning doc |
|---|---:|---|---|
| `extern(C++)` decls | 735 | Linkage erased; the *subset marker* — confirms JS-friendly source | `04` §8 |
| `class` decls | 422 | → TS classes; visitor pattern pervasive | `02` §2 |
| `struct` decls | 224 | → TS classes with **value semantics** (`.copy()`) — the hard part | `02` §2, `03` |
| `interface` decls | 11 | → TS interfaces / abstract classes | `02` §3 |
| `enum` (manifest + named) | 608 | manifest → `const`; named → TS enum | `02` §4 |
| `alias` decls | 679 | distinguish **type** alias vs **symbol/overload-set** alias | `02` §5 |

### 1.2 Generics / templates / containers

| Feature | Count | Disposition | Owning doc |
|---|---:|---|---|
| template instantiations `X!(…)` | 506 | mostly `Array!T` → TS generics or monomorphize | `02`, `08` |
| `Array!` usage | 123 | runtime container (`root/array.d`) → TS class | `08` §2 |
| `mixin` | 361 | resolve at translation time (string / template mixins) | `07` §5–6 |
| `static if` | 366 | resolve at translation time against fixed config | `07` §3 |
| `static foreach` | 60 | unroll, or convert to runtime loop | `07` §4 |
| `__traits` | 292 | case-by-case CT reflection → resolve | `07` §7 |
| `is(…)` expressions | 124 | CT type queries → resolve | `07` §8 |
| `typeof` | 339 | CT → resolve where possible | `07` §8 |

### 1.3 Functions & callables

| Feature | Count | Disposition | Owning doc |
|---|---:|---|---|
| `delegate` | 201 | → closures; mind `this` capture | `04` §4 |
| function-ptr types | 52 | → function-typed values | `04` §4.4 |
| contracts (`in`/`out`/`do`) | 157 | → asserts, or drop | `04` §7 |
| `opXxx` operator overloads | 480 | **no JS operators** — method + rewrite every call site | `05` |

### 1.4 Control flow

| Feature | Count | Disposition | Owning doc |
|---|---:|---|---|
| `foreach` | 1129 | → `for…of` / indexed / iterator | `06` §1 |
| `foreach_reverse` | 18 | → reverse iteration | `06` §2 |
| `final switch` | 73 | → `switch` + exhaustiveness throw | `06` §3.2 |
| `with` statement | 50 | → local aliasing | `06` §5 |
| `scope(exit/success/failure)` | 117 | → `try`/`finally` LIFO | `06` §7 |

### 1.5 Numerics & casts

| Feature | Count | Disposition | Owning doc |
|---|---:|---|---|
| `cast(...)` | 2773 | downcast idiom + numeric mask-then-sign-extend | `09` §2, `02` |
| `dchar` | 119 | UTF code point (number) | `09` §7 |
| `assert(...)` | 2428 | → runtime `assert` helper (throw) | `10` §2 |

### 1.6 Attributes & qualifiers (mostly erased — see §3.2)

| Feature | Count | Disposition | Owning doc |
|---|---:|---|---|
| `nothrow` | 668 | **erase** | `04` §8 |
| `@nogc` | 357 | **erase** | `04` §8 |
| `pure` | 595 | **erase** | `04` §8 |
| `immutable` | 266 | mostly erase (optionally `readonly`) | `04` §8, `02` |
| `version(...)` | 563 | resolve against fixed config table | `07` §1.2 |

### 1.7 State, lifetime, tests

| Feature | Count | Disposition | Owning doc |
|---|---:|---|---|
| `__gshared` | 191 | module-level mutable state; mind init order | `01` §5 |
| `~this` dtors | 33 | usually erasable (GC); rare deterministic cleanup escalates | `04` §8, `03`, `11` §3.7 |
| `unittest` blocks | 82 | → Vitest (re-baselined on 1.43-beta1, pattern `^\s*unittest\b`, 33 files; supersedes the old 160 whose pattern was unreconstructible) | `10` §1 |

---

## 2. What this guide COVERS (the rule-doc map)

Every covered construct has exactly **one** canonical translation, owned by one doc. The
per-file workflow is in `00-how-to-use.md §1`; this is the construct→doc index.

| Doc | Covers |
|---|---|
| `01-conventions.md` | file/module mapping, identifier preservation + JS-reserved escaping, `import`/`export`, module-cycle handling (stub-first / `import type` / lazy `import()` / interface extraction), `static this()` init ordering |
| `02-types.md` | `class`/`struct`/`interface`/`enum`/`alias`, visitor pattern, tuples, static/dynamic/associative arrays, pointers-as-reference, `Nullable`/`Optional` |
| `03-value-semantics.md` | the `.copy()` discipline — the six struct copy points, `ref`/`out`/`in` params, struct arrays, struct class-fields, postblit/copy-ctor/`opAssign`, address-of via box |
| `04-functions.md` | overloading, default args, the three variadic kinds, delegates/closures/fn-ptrs + `this`-capture, nested fns, UFCS, `in`/`out`/`do` contracts, **attribute erasure**, `@property` getters |
| `05-operators.md` | every `opXxx` → method + call-site rewrite (`opEquals`, `opCmp`, `opBinary[Right]`, `opUnary`, `opOpAssign`, `opIndex*`/`opSlice`/`opDollar`, `opCast`, `opApply`, `opDispatch`, `toHash`, `toString`) |
| `06-control-flow.md` | `foreach`/`foreach_reverse`, `switch`/`final switch`/string switch/case ranges/`goto case`, `goto` labels, `with`, labeled break/continue, `scope(...)` guards, exception hierarchy |
| `07-compile-time.md` | `version`/`debug`, `static if`/`static foreach`, `mixin("…")` and `mixin Name!()`, `__traits`, `is(…)`/`typeof` in CT, manifest-enum CTFE, `__VERSION__`/`__FILE__`/`__LINE__` — all resolved at translation time with audit-comments |
| `08-runtime-lib.md` | `dmd/root/` runtime: `RootObject`/`DYNCAST`, `Array!T`, `arraytypes`, `BitArray`, `StringTable`, `AssocArray`/`aav`, `utf`, `string`, `hash`, `optional`, `DString`, `assert`/`DError`, `rmem`/`region` no-ops, `file`/`filename`, `CTFloat`/`complex_t`, `port` |
| `09-numerics.md` | BigInt-vs-`number` domain split, `cast` mask-then-sign-extend, two's-complement wrap, signed/unsigned division & comparison, shifts, float (`float`/`double`/`real` → `number`), `char`/`wchar`/`dchar` arithmetic, where exactness mandates BigInt |
| `10-tests-diagnostics.md` | `unittest` → Vitest, `assert`/`enforce` runtime helpers, **exact DMD diagnostic parity** (location format, headers, gagging, printf format strings, caret context), the `djs` CLI shim contract, `TEST_OUTPUT` comparison |
| `11-escalate.md` | the STOP/escalate protocol, wall-placement contract, + the known-hard / out-of-scope list (the safety net) |
| `12-worked-examples.md` | full end-to-end `dmd/*.d` → `src/dmd/*.ts` walkthroughs |
| `13-visitor.md` | the Visitor pattern — the `visit` overload set → named `visitX` methods, `accept` double-dispatch, the `(AST)` monomorphization, visit-mixins, AND the nested-function+dispatch-switch idiom of typesem/dcast/funcsem/initsem/enumsem |
| `cheatsheet.md` | one-page fast-lookup of the common pattern pairs |

The Phase-1 artifact `translation-order.md` (dependency DAG / bucket order) feeds these; the
probe log and the version table of Phase 1 are not in this tree (`00-how-to-use.md` §4).

---

## 3. What we SKIP, and WHY

Three categories of skip: **excluded modules** (not translated at all), **erased attributes**
(deleted from each file), and **codegen / driver glue** (out of the pipeline). Each has a
*why* that traces back to a locked decision in `_ground-truth.md §1`.

### 3.1 Excluded modules — never translated; strip/stub the import edge

Per `_ground-truth.md §1.8` and `translation-order.md §4`. When an in-scope file imports or
calls one of these, drop the import and either delete the guarded dead branch (when the
*language feature itself* is excluded) or leave a STOP/throw stub — recorded with the
resolved-comment convention (`_ground-truth.md §5`, `11-escalate.md`).

| Excluded module | What it is | WHY skipped | Reached from (in-scope) |
|---|---|---|---|
| `dtoh.d` | C++ header generation | an output backend (`.h` emission), not the frontend result we compute | `cxxfrontend`, `mars`, `main` |

**KEPT despite looking peripheral: `dmd/mangle/`** — name mangling is required for symbol
identity, template instantiation keys, and some diagnostics. It is NOT skipped
(`_ground-truth.md §1.8`, `translation-order.md §2.2d`). `mangle/package.d` translates with the
core SCC; `mangle/cpp.d` / `mangle/cppwin.d` follow with deferred-import treatment.

**KEPT: `dmd/dfa/` (fast-DFA preview engine, new in 2.113 — 7 files).** In scope by decision
(`_config.md` `FastDFA` row): a data-flow analysis pass behind `-preview=fastdfa`
(`params.useFastDFA`, default OFF), invoked from `semantic3.d:1482`. Translated as breakable
post-core modules (`translation-order.md §3` / Bucket 8); the shim accepts `-preview=fastdfa`
(`10-tests-diagnostics.md §4.2`).

**KEPT: the GCC-style inline assembler semantic** (`iasm/gcc.d`, and LDC's `asmSemantic`
dispatch from gen/asmstmt.cpp:100 in `src/gen/asmstmt.ts`). ldc2 runs it on every target, and
druntime and Phobos reach it on arm64 (core.internal.atomic, core.thread.osthread,
std.math.hardware). A DMD-style asm block errors as ldc2 does on aarch64; the x86 asm parsers
and all asm codegen stay out (`11-escalate.md §3.2`).

**Also out-of-graph** (no source file in this tree — LDC build provides them): `dmd.dmdparams`,
`dmd.root.strtold` (C binding → replace with JS `parseFloat`/`Number`, `09-numerics.md`),
`dmd.backend.cc` (codegen).

### 3.2 Erased attributes — deleted from every file, uniformly

Per `04-functions.md §8`. These are compile-time guarantees with **no JS-visible runtime
effect** and no effect on the lex→sema→CTFE *result*. Erasing them is **always correct** for
this port. Do not comment routine erasure — the diff stays clean (comment only when an
attribute drove a `static if`/`version` choice).

| Erased | WHY (no JS-visible effect) |
|---|---|
| `pure` | purity is a CT constraint; JS has no purity tracking |
| `nothrow` | JS has no checked exceptions |
| `@nogc` | JS is GC'd; allocation is implicit |
| `@safe` / `@trusted` / `@system` | memory-safety category, CT-only |
| trailing `const` / `immutable` / `inout` on methods | no runtime effect (optionally `readonly` on fields, `02-types.md`) |
| `scope` (storage class on a param) | escape analysis only — consumed by D's own compilation |
| `return` / `return scope` | lifetime annotation, CT-only |
| `@live` | on the frontend's own functions: ownership/borrow checking, CT-only. The checker for USER code (`ob.d`, called at semantic3.d:1473 under `-preview=dip1021`) is ported as code in `src/dmd/ob.ts` |
| `extern(C++)` / `extern(D)` | ABI/linkage; mangling logic is ported as code in `mangle/`, not as a linkage attribute |

**NOT erased — observable, so kept:** `ref` / `out` (pass-by-reference, `03-value-semantics.md`),
`static` on a method (no `this`), `final` / `override` / `abstract` (virtuality). Do not confuse
the erased `scope` *storage class* with the kept `scope(exit/success/failure)` *statement*
(`06-control-flow.md`).

### 3.3 Codegen, ABI, and driver glue — out of the pipeline

Per `_ground-truth.md §1.3`: **frontend only.** The pipeline stops after semantic analysis +
CTFE. WHY: codegen targets LLVM/native and has no JS analogue; reproducing it would multiply
scope without serving the goal (a faithful frontend that lexes, parses, runs semantics, and
folds constants with exact diagnostics).

Skipped: `gen/`, `ir/`, LLVM bindings, `dmd.backend.*`, the ABI arg-classification modules of
other targets (`argtypes_sysv_x64.d`, `argtypes_x86.d`; `argtypes_aarch64.d` is translated, its
answer being frontend-visible on arm64: NRVO, `__argTypes`, `__traits(isReturnOnStack)`,
`-preview=in`), and LDC glue (`ldcbindings.d`). The driver (`cxxfrontend.d`, `mars.d`, `main.d`) is translated **only** to the
extent the `djs` CLI shim needs to drive lex→sema→CTFE and print diagnostics
(`translation-order.md §1, §5 Bucket 9`); `doc.d` (Ddoc, `-D`) and `json.d` (`-X`) are
translated whole: their outputs are compared byte for byte with ldc2's in the corpus. ImportC
(`cparse.d`, `importc.d`) is translated whole too, the C preprocessor run as ldc2's
`driver/cpreprocessor.cpp` runs it (the system C compiler with druntime's `importc.h`).

---

## 4. Notable judgment calls

These are the decisions that are *not* mechanical — where the guide deliberately chose a stance,
or where a construct is in scope but requires a human decision per occurrence. They are the
places an agent is most likely to go wrong.

1. **Struct value semantics is the single most dangerous trap.** D copies a struct at six
   points (assignment, by-value param, array-element read into a var, return-by-value, etc.).
   The port MUST emit an explicit `.copy()` at each, or the alias bug is **silent** — it
   compiles, passes local types, and miscompiles far from the cause. Owned by
   `03-value-semantics.md`; the only licensed shortcut is eliding a *provably* unnecessary copy.

2. **Operators have no JS equivalent — every call site is rewritten.** `opXxx` (480 of them)
   becomes a named method, and the guide's hardest sub-case is `opApply` (`foreach` over an
   object → callback-driven loop, including the `foreach`-call-site rewrite agents miss).
   `05-operators.md`.

3. **Numerics are hybrid, and the boundary is a TS type error on purpose.** BigInt for
   `long`/`ulong`/`cent`/`ucent` and all CTFE-exact integer math; `number` for provably-≤2^53
   indices/counters and all floats. Mixing `number` and `bigint` is a compile error — the type
   checker enforces the domain split. Casts mask-then-sign-extend; arithmetic wraps mod 2^width.
   `real` is 64-bit on this target (verified), so floats map exactly onto `number` with no
   extended-precision emulation. `09-numerics.md`.

4. **Diagnostics must be byte-for-byte identical to `ldc2`.** The whole `fail_compilation`
   corpus is reused unchanged by reproducing DMD's message strings verbatim (location + text).
   This constrains the port of every `error(...)` call site. `10-tests-diagnostics.md`.

5. **The 76-module core SCC cannot be ordered as independent files.** AST + semantic analysis
   is one mutually-recursive ball of mud. It is translated as a coordinated batch: stub all 76
   class headers first (type-defs before semantic passes), then fill bodies. Agents must NOT
   invent their own cycle-break; the stub-first / `import type` / lazy `import()` pattern is
   owned by `01-conventions.md §4` and the cycle inventory by `translation-order.md §2`.

6. **`~this` destructors usually erase — but finalization *order/timing* escalates.** 33 dtors;
   most have no deterministic-cleanup contract and the GC reclaims memory, so they erase
   (`04-functions.md`). Only a dtor (or `scope`-guarded cleanup, or weak ref) that relies on
   finalization *order* relative to other objects must escalate — JS GC is non-deterministic.
   `11-escalate.md §3.7`.

7. **`__gshared` module state must respect init order.** 191 module-level mutable globals →
   ordered init functions; cross-module init order is load-bearing (`01-conventions.md §5`).

8. **Constructs that are in scope but escalate per occurrence** (`11-escalate.md §3`): real
   value-layout **unions** — the naive "object with every field" loses overlap; the three frontend
   ones are closed in `11-escalate.md §3.5` (`tokens.d:652` Token payload and `ctfeexpr.d:82`
   emplace buffer as carve-outs, `expression.d:919` StringExp as bytes with element size);
   **pointer arithmetic** beyond a simple ref; **SIMD / `__vector`** semantic/CTFE computation
   (node shells are carried, value computation is out of scope); **bitfields** when code reads
   the packed integer / its size / the bit layout (otherwise resolved to getters/setters via
   `07-compile-time.md`); **dynamic `mixin` / `__traits`** not statically resolvable for our
   fixed world.

9. **Translation-time resolution against a single fixed world.** All `version`/`static if`/
   `__traits`/`is`/`typeof`/`mixin` in frontend source are resolved at translation time against
   the fixed config: POSIX, 64-bit pointers, little-endian, 64-bit `real`, compiler identity
   **LDC** (`version(LDC)`/`version(IN_LLVM)` ON, `version(DigitalMars)`/Windows OFF). Every
   resolution emits a one-line audit-comment recording what was resolved and why, so the port
   stays diff-able against upstream DMD. Canonical ON/OFF table and rules:
   `07-compile-time.md` §1.2.

10. **The STOP rule is the backstop for everything not above.** A construct neither covered by a
    rule doc nor explicitly skipped here is, by definition, uncovered → STOP and escalate. A
    wrong-but-plausible translation in a compiler is worse than a halt (`00-how-to-use.md §5`,
    `11-escalate.md`).
