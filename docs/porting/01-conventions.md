# 01 — Project & Translation Conventions

> **STOP rule.** If you meet a construct not covered here, or any ambiguity in how to
> map a module / import / identifier / module-constructor, **STOP and escalate**
> (see `11-escalate.md`). A wrong-but-plausible mapping in a compiler is worse than a halt.
> Never guess.

Read `_ground-truth.md` first. This document owns the **mechanical, file-level**
conventions every translation agent applies to *every* file: how a `.d` file becomes a
`.ts` file, how identifiers and imports are translated, how D's free circular imports are
made to survive ESM, and how module-level `static this()` constructors become ordered init
functions. Numerics policy is **not** here — see `09-numerics.md`. Type-level mapping
(`struct`/`class`/`enum`/`alias`) is owned by `02-types.md`; value-copy semantics by
`03-value-semantics.md`.

---

## 1. File / module mapping

**Invariant:** one D module = exactly one TS ESM module. The TS file path mirrors the D
module path so the port stays diff-able against upstream DMD (`_ground-truth.md §1.2`).

### Rule 1.1 — path mapping is the dotted module name, not the filename

D's module identity is its `module dmd.…;` declaration, **not** the on-disk filename. The
canonical mapping keeps the **full dotted module name** (the `dmd.` prefix included) and turns
dots into directories directly under `src/`:

| D module declaration | D source file | TS file (write here) |
|---|---|---|
| `module dmd.expression;` (`dmd/expression.d:14`) | `dmd/expression.d` | `src/dmd/expression.ts` |
| `module dmd.root.array;` (`dmd/root/array.d:13`) | `dmd/root/array.d` | `src/dmd/root/array.ts` |
| `module dmd.root.filename;` (`dmd/root/filename.d:12`) | `dmd/root/filename.d` | `src/dmd/root/filename.ts` |
| `module dmd.common.file;` (`dmd/common/file.d:15`) | `dmd/common/file.d` | `src/dmd/common/file.ts` |
| `module dmd.mangle;` (`dmd/mangle/package.d:15`) | `dmd/mangle/package.d` | `src/dmd/mangle/index.ts` |
| `module dmd.visitor;` (`dmd/visitor/package.d:12`) | `dmd/visitor/package.d` | `src/dmd/visitor/index.ts` |
| `module gen.dpragma;` (`gen/dpragma.d:14`) | `gen/dpragma.d` | `src/gen/dpragma.ts` |
| `module gen.llvmhelpers;` (`gen/llvmhelpers.d:14`) | `gen/llvmhelpers.d` | `src/gen/llvmhelpers.ts` |
| `module gen.ldctraits;` (`gen/ldctraits.d:10`) | `gen/ldctraits.d` | `src/gen/ldctraits.ts` |

**`src/` is reserved for the port; the `dmd.` prefix is kept.** Every ported DMD module lands
under `src/dmd/…`, mirroring the dotted name 1:1 (so the tree stays diff-able against upstream
`dmd/…`). Non-DMD code — the CLI shim and hand-written runtime helpers **not** derived from
`dmd/root` — does **not** live under `src/dmd/`; it lives in **sibling** `src/` directories
(e.g. the shim's `src/init-order.ts`, runtime helpers under their own `src/` subtree). Do not
flatten or strip the prefix: `module dmd.expression;` is `src/dmd/expression.ts`, never
`src/expression.ts`. LDC `gen.*` binding modules land under `src/gen/…` by the same rule.

**A declaration is emitted in the module that declares it in D — no relocation, no convenience
exception.** A `typesem.d` free function lives in `typesem.ts` even when its natural receiver
class sits in `mtype.ts` and the method form would be handier (`04-functions.md §6`
anti-pattern); a helper is never moved "next to its callers". If a faithful placement would
create a load-time cycle, that is Rule 4.3/4.4 (deferred/typed imports) — never a move.

**Never reuse a D function's name for a different helper.** If the port needs a helper that D
does not have, its name must not collide with any D symbol in the same module family (the old
port's `visitDsymbolExp` ≠ D's `visitDsymbol` cost an audit round). Invented helpers get
clearly non-upstream names (`stubForX`, `_resetX`, house-prefixed), so a grep for a D name
finds only faithful ports of that name.

**Trap — `package.d`:** D's `package.d` declares the *package itself* as a module
(`module dmd.mangle;`, `module dmd.visitor;` — verified). It does **not** map to
`src/dmd/mangle/package.ts`. Map it to the ESM package entry point `src/dmd/mangle/index.ts` /
`src/dmd/visitor/index.ts`. An `import dmd.mangle;` then resolves to `./mangle/index.js`
(equivalently `./mangle`). Do not create a file literally named `package.ts`.

### Rule 1.2 — emit a one-line provenance comment at the top of every file

So a reviewer can find the upstream source instantly:

```ts
// Ported from dmd/expression.d (module dmd.expression).
```

No other header. **No authorship / attribution / copyright metadata** (project rule). Strip
the D file's `Copyright:` / `Authors:` doc block entirely.

### Rule 1.3 — excluded modules are never created

Per `translation-order.md §4`, do not create `.ts` files for
`dtoh.d`, `argtypes_sysv_x64.d`, `argtypes_x86.d`, `ldcbindings.d`. When an in-scope file
imports one of these, strip the import (Rule 3.6) and stub the call site
(see `11-escalate.md`).

---

## 2. Identifier preservation + JS reserved-word escaping

**Invariant:** preserve every D identifier *verbatim* (`_ground-truth.md §1.2`). Renaming a
field/method silently breaks the diff against upstream and hides bugs. The **only** permitted
mutation is escaping a name that is a legal D identifier but illegal/dangerous in TS.

### Rule 2.1 — D keywords never collide; do not "fix" already-escaped names

A name that is a **D keyword cannot be a D identifier**, so it can never reach you as a D
identifier needing escape. Verified: `int`, `in`, `out`, `default`, `function`, `delegate`,
`new`, `delete`, `typeof`, `void`, `null`, `true`, `false`, `this`, `super`, `switch`,
`case`, `with`, `class`, `interface`, `static`, `const`, `private`, `public`, `export`,
`import`, `finally`, `module`, `package`, `scope`, `body`, `version`, `align`, `struct` —
all D keywords. The frontend, when it *wants* such a name, has already escaped it in D source
using a leading or trailing underscore. Both conventions appear in the tree (verified counts):

- Trailing `_`: `scope_` (198), `out_` (69), `default_` (65), `in_` (58), `function_` (56),
  `delegate_` (51), `package_` (e.g. `Visibility.Kind.package_` `dmd/access.d:254`,
  `astenums.d:296`), `module_` (24), `new_` (23), `import_` (21), `class_` (16),
  `delete_` (11), `switch_` (10).
- Leading `_`: `_init` (356), `_body` (277), `_scope` (276), `_module`
  (`Module _module;` `dmd/dscope.d:137`), `_deprecated` (8), `_version` (3).

**These are already valid TS identifiers — carry them over byte-for-byte.** `package_`
stays `package_`; `_module` stays `_module`. Do **not** normalize or "tidy" them.

### Rule 2.2 — the only real collisions: JS-reserved names that ARE legal D identifiers

Probed with `ldc2`: the following are legal D identifiers (compile fine as struct fields)
yet are reserved or dangerous in TS/JS strict mode. These are the **only** names you escape:

| D identifier | Why it must be escaped in TS | Real frontend occurrence |
|---|---|---|
| `var` | `var` is a JS keyword | field `Declaration var;` `dmd/expression.d:2286`, `:2867`; `VarDeclaration var;` `dmd/expression.d:979`,`:1191`, `dmd/statement.d:419`,`:1543`; ~413 `.var` accesses |
| `arguments` | special object in JS function bodies; reserved as a binding name in strict mode | field `Expressions* arguments;` `dmd/expression.d:2203`,`:2257`,`:2989`,`:3018`,`:3518`; param in `dmd/builtin.d:46`,`:227` |
| `yield` | reserved in JS (generators / strict mode) | identifier uses in `dmd/aggregate.d:139` context; check at each site |
| `let` | reserved in strict mode | rare |
| `eval` | reserved as a binding name in strict mode | rare |
| `await` | reserved in modules | not currently found as an identifier — escape if met |
| `package` | bare `package` is a JS reserved word (strict). **Already `package_` in D** (Rule 2.1) — no action | — |
| `debugger`, `undefined`, `globalThis`, `Infinity`, `NaN` | JS reserved / global; shadowing is a hazard | escape only if used as an identifier |

### Rule 2.3 — the canonical escaping scheme: append exactly one `_`

**Decision (use this, no alternatives): append a single trailing underscore.** This matches
D's own escape convention (the compiler itself suggests it — verified: `ldc2` on
`int package;` prints *"`package` is a keyword, perhaps append `_` to make it an
identifier"*), so the port stays visually consistent with the already-escaped D names.

```
var        -> var_
arguments  -> arguments_
yield      -> yield_
```

**BEFORE** (`dmd/expression.d:2203`, `:2225`)

```d
class CallExp : UnaExp {
    Expressions* arguments;     // Array of Expression's
    this(...) { this.arguments = arguments; }
}
```

**AFTER**

```ts
class CallExp extends UnaExp {
  arguments_: Expressions | null;   // ported: D field `arguments` (JS-reserved) -> arguments_
  constructor(/* ... */) { super(/* ... */); this.arguments_ = arguments_; }
}
```

**Invariants to preserve:**
- Escape **consistently across all modules**: the field is `arguments_` everywhere it is
  declared *and* everywhere it is read (`ce.arguments` -> `ce.arguments_`). A single missed
  call site is a silent compile-time TS error at best, a wrong-symbol bug at worst.
- Escape **only** the colliding name; never escape its neighbours. `var` -> `var_`, but a
  sibling field `e1` stays `e1`.
- Emit the one-line `// ported: …` comment at the declaration so the rename is auditable.
- Do **not** apply this to D-keyword-derived names already carrying an underscore (Rule 2.1).

**The scheme covers one more collision class: a D identifier that collides with a
PORT-INTRODUCED runtime helper.** The trigger is *"a JS-reserved word **OR** a name bound by a
file-wide runtime-helper import"* — same single-underscore escape, same marking comment at the
declaration. The live case is D's `ds`, an extremely common D parameter name (`Dsymbol ds`,
`AliasDeclaration ds`, `DoStatement ds`, `DebugStatement ds` — four in statementsem.d, three in
dsymbolsem.d, two in expressionsem.d) against the port's file-wide `ds(...)` byte-string helper,
which every diagnostic in the body needs. Left undecided, three agents shipped three spellings
(`ds_`, `dsym`, `dsy`); the rule is `ds_`. The same applies to `assert`.

**The same escape covers a D local that collides with a D free function the port brings into
scope.** D resolves `v.type.hasPointers()` as a UFCS member call, so a local named
`hasPointers` (safe.d:90, expressionsem.d:18215) does not shadow typesem's `hasPointers` in D;
in TS the UFCS call is flattened to the imported free function `hasPointers(...)` (§6 of
`04-functions.md`), which the local would shadow. The local takes the `_` escape
(`const hasPointers_ = hasPointers(v.type!)`) with the `// ported:` comment, as `safe.ts` and
`expressionsem.ts:20409` do. The imported function keeps its name.

**Related, and NOT diagnosed as a missing import: a D symbol colliding with a TypeScript-lib or
Node AMBIENT global.** Forgetting the import does not produce "Cannot find name" — the lib
declaration silently takes over. `Parameters` becomes TS's utility type (TS2314), `TypeError`
the JS built-in (with the memorable *"Type 'TypeError' is missing the following properties from
type 'TypeError'"*), `global` Node's (39 × TS7017 in one file). **Self-gate item:** after
writing a file, grep its import block for every dmd name that shadows a lib global —
`Parameters`, `TypeError`, `Array`, `global`, `Error`, `Object`, `Map`, `Set`, `Symbol`,
`Number`, `String`, `Function`, `Date`, `RegExp`, `Proxy`, `Reflect`, `Event`, `Element`.
These are IMPORTED, never renamed: the D name is verbatim per Rule 2.1.

### Rule 2.4 — module-name segment that is a JS reserved word

A *path segment* of a module that is JS-reserved (none currently in the tree) would break an
`import './package/...'`-style path only in edge cases; since `package.d` already maps to
`index.ts` (Rule 1.1) there is no live collision. If a future segment collides, **STOP and
escalate** — do not silently rename a directory.

### Rule 2.5 — D `private` is **module-scoped**; do not blindly emit TS `private`

**Invariant (verified):** D's `private` restricts access to the **declaring module**, not the
declaring class/struct. A *sibling* module-level function, and the module's own `unittest`,
may freely read a `private` member of a type declared in the same file. Mechanically copying
every D `private` onto a TS `private` (which is **class-local**) silently *over-tightens*
visibility and breaks any such legitimate same-module access — a TS2341 compile error, or
worse a wrong refactor that hides the access.

Verified with `ldc2`: a sibling module-level `int peek(ref S s) => s.x;` and a same-module
`unittest { s.x = 7; }` both compile against `struct S { private int x; }`; a *different*
module reading `s.x` fails with `Error: no property 'x'` (cross-module access denied). So
`private` is exactly module visibility — neither fully public nor class-local.

**Decision (use this, no alternatives):** for a member the D source marks `private`, decide
by **who actually touches it in the same module**:

| Same-module access pattern | Emit in TS | Comment |
|---|---|---|
| Member touched **only** from within its own class/struct methods | `private` | — (faithful) |
| Member touched by a **sibling module-level function** OR the module's `unittest` | **no** TS `private` | `// D module-private` |

When you drop the `private`, leave the member at TS default visibility (public) **plus** the
auditable `// D module-private` marker, so a reviewer knows the looseness is faithful to D's
module scope — not an accident. Use TS `private` **only** when the access is genuinely
class-local in the original module.

**BEFORE** (`dmd/X.d` — a private field read by a sibling free function in the same module)

```d
module dmd.x;
struct Loc {
    private uint fileOffset;          // private == module-private in D
}
// sibling module-level function in the SAME module reads the private member:
uint offsetOf(ref Loc loc) { return loc.fileOffset; }
unittest { Loc l; l.fileOffset = 3; assert(offsetOf(l) == 3); }   // unittest also reads it
```

**AFTER**

```ts
export class Loc {
  fileOffset = 0;                     // D module-private (read by offsetOf / unittest below)
}
// sibling module-level function — needs to read fileOffset, so it must NOT be TS `private`:
export function offsetOf(loc: Loc): number { return loc.fileOffset; }
```

**Contrast — genuinely class-local stays `private`:**

```d
class Foo {
    private int cache;                // touched only inside Foo's own methods
    int get() { if (!cache) cache = compute(); return cache; }
}
```

```ts
export class Foo {
  private cache = 0;                  // no sibling/unittest access -> faithful TS `private`
  get(): number { if (!this.cache) this.cache = this.compute(); return this.cache; }
}
```

**Invariants:**
- The decision is **per member**, driven by the *actual* same-module call sites (including
  `unittest` blocks) — not by guessing. Grep the module for the member name before choosing.
- Never escape or rename to dodge this; the rename rules (§2.1–§2.3) are orthogonal. Visibility
  and naming are independent.
- The `// D module-private` marker is mandatory on every dropped-`private` member, so the
  loosened visibility is auditable against upstream.
- **The fix for a tsc visibility complaint is to DROP the `private` — never to invent an
  accessor.** The following shipped once and is forbidden: keeping the field `private x_` and
  adding a getter/setter pair so a sibling module can reach it. That mutates the name (breaks
  §2 verbatim-identifier fidelity), invents members D does not have, and hides that the real
  rule (module-scoped `private`) was misapplied.

```ts
// BAD — invented accessor pair to dodge TS2341 (forbidden):
private x_: number; get x() { return this.x_; } set x(v: number) { this.x_ = v; }
// GOOD — drop the TS `private`, keep the D name, mark it:
x: number = 0;   // D module-private (read by <sibling>/<name>.test.ts)
```

---

## 3. D `import` -> TS `import` / `export`

**Invariant:** an `import dmd.X;` makes module `X`'s public symbols visible in the current
module's scope. TS has no "import the whole module's names into scope" — every used symbol
must be named. The faithful translation lists exactly the symbols the file actually uses.

### Rule 3.1 — plain whole-module import -> named import of the used symbols

D's `import dmd.expression;` pulls *all* public names of `expression` into scope; the file
then uses `Expression`, `CallExp`, etc. unqualified. TS requires you to name them.

**BEFORE**

```d
module dmd.opover;
import dmd.expression;
import dmd.mtype;
// ... uses Expression, BinExp, Type, Tarray ...
```

**AFTER**

```ts
// Ported from dmd/opover.d (module dmd.opover).
import { Expression, BinExp } from "./expression.js";
import { Type, Tarray } from "./mtype.js";
```

**Decision:** list **only the symbols used in this file**, alphabetically is not required but
keep them stable. Do **not** emit a namespace import (`import * as expression`) for a plain
D import — it does not match D's flat-scope semantics and degrades the diff. Use `.js`
extensions in specifiers (Node ESM requires them for relative paths; TS keeps the source
name `.ts` but emits `.js`).

### Rule 3.2 — selective import `import x : a, b` -> named import

D's `import dmd.dsymbolsem : toAlias;` (`dmd/access.d:23`) is already the selective form.

| D | TS |
|---|---|
| `import dmd.dsymbolsem : toAlias;` (`access.d:23`) | `import { toAlias } from "./dsymbolsem.js";` |
| `import dmd.globals : dinteger_t, sinteger_t, uinteger_t;` (`ctfeexpr.d:30`) | `import { dinteger_t, sinteger_t, uinteger_t } from "./globals.js";` |
| `import dmd.canthrow : BE, checkThrow;` (`canthrow.d:20` form) | `import { BE, checkThrow } from "./canthrow.js";` |

### Rule 3.3 — renamed selective import `import x : alias = name` -> `import { name as alias }`

D's `public import dmd.root.longdouble : real_t = longdouble;` (`dmd/root/ctfloat.d:24`)
binds the local name `real_t` to the imported `longdouble`.

**BEFORE**

```d
public import dmd.root.longdouble : real_t = longdouble;
```

**AFTER**

```ts
export { longdouble as real_t } from "./root/longdouble.js";   // public import -> re-export
```

For a *private* renamed selective import (`import io = std.stdio;`-style whole-module rename —
not currently present in `dmd/*.d` but documented for completeness): map a whole-module
rename `import alias = pkg.mod;` to a namespace import `import * as alias from "./mod.js";`.
A renamed *symbol* selective import uses `import { name as alias } from "...";`. **STOP and
escalate** if you meet a whole-module rename that is then used to qualify names the file also
imports plainly — confirm there is no scope clash.

**A D module-qualified call whose name collides with a same-module function** —
`dmd.expressionsem.trySemantic(e, sc)` at `typesem.d:2388` and `:6813`, inside a module that
defines its own `trySemantic` (`typesem.d:4779`) — imports the foreign function under the alias
`<module><Name>`: the last segment of the D module name, then the function name with its first
letter capitalized.

```ts
// typesem.ts
import { trySemantic as expressionsemTrySemantic } from "./expressionsem.js";
```

The export keeps its bare name (it belongs to the owner file). The reverse direction already
follows the same spelling: `expressionsem.ts` imports typesem's as `typesemTrySemantic`.
`trySemanticType` (`templatesem.ts`) is an older spelling of the same alias and converges to
`typesemTrySemantic` when that file is next edited. The registered same-name families are in
`04 §6.1`.

### Rule 3.4 — `public import` -> `export … from` (re-export)

A `public import` re-exports the imported names from the current module (D transitive
visibility). TS expresses this with `export … from`.

| D | TS |
|---|---|
| `public import dmd.root.string: fTuple;` (`errors.d:15`) | `export { fTuple } from "./root/string.js";` |
| `public import dmd.aggregate;` (`astcodegen.d:12`) | `export * from "./aggregate.js";` |

`astcodegen.d` is the canonical re-export aggregator: a `struct ASTCodegen { public import
dmd.aggregate; … }` (`dmd/astcodegen.d:10-37`) that gathers the whole AST namespace. Its
struct-wrapping is a *namespace-aggregation* idiom — the **import translation** is `export *
from` for each member; whether `ASTCodegen` survives as a TS namespace object is a type-level
decision owned by `02-types.md`. Here, translate each inner `public import dmd.X;` to
`export * from "./X.js";` and each `public import dmd.X : Y;` to `export { Y } from "./X.js";`
(e.g. `astcodegen.d:37 public import dmd.init : Designator;` -> `export { Designator } from
"./init.js";`).

### Rule 3.5 — `static import` -> namespace import

D's `static import` requires fully-qualified use at the call site (no name injected into
scope). The faithful TS form is a namespace import, because it forces qualified access too.

| D | TS |
|---|---|
| `static import core.bitop;` (`builtin.d:27`) | `import * as core_bitop from "<core/bitop shim>";` — but `core.*` is the **D runtime**, not the frontend; resolve per `08-runtime-lib.md` (likely an inlined helper, not a real import). |
| `static import dmd.root.rmem;` (`timetrace.d:313`, function-local) | deferred — see Rule 4.4; if kept, `import * as rmem from "./root/rmem.js";` |
| `static import core.math, core.stdc.math;` (`root/ctfloat.d:14`) | `core.*` math -> JS `Math` per `09-numerics.md`; do **not** emit a real namespace import. |

**Trap:** most `static import` targets in the frontend are `core.*` / `std.*` (the D
*standard library*, not the compiler). Those are **not** ported as modules — they resolve to
runtime shims (`08-runtime-lib.md`) or numeric helpers (`09-numerics.md`). Only
`static import dmd.…` becomes a real namespace import.

### Rule 3.6 — imports of excluded modules: strip the edge

Per `translation-order.md §4`, when a file imports `dtoh`, **drop the import** and stub each
call site:

```ts
// dropped: import dmd.dtoh (C++ header generation excluded — translation-order.md §4)
```

The matching call sites are usually guarded so deletion is local. Replace a reachable call to an excluded function with a STOP/throw stub
(`11-escalate.md`). Record every strip with the resolved-comment convention
(`_ground-truth.md §5`).

### Rule 3.7 — `core.stdc.*` / `core.*` / `std.*` imports are runtime, not frontend

`import core.stdc.stdarg;` (`errors.d:14`), `import core.stdc.string : memcpy;`,
`import core.stdc.ctype : isdigit;` (`chkformat.d:14`) target the D runtime/Phobos. **Do not
create TS modules for them.** Resolve to a runtime helper (`08-runtime-lib.md`) or inline
(`isdigit(c)` -> `c >= 0x30 && c <= 0x39`). If a `core`/`std` symbol has no covered mapping,
**STOP and escalate**.

### Strict-mode imports

The port builds under strict `tsconfig` (`noUnusedLocals` on). A D `import dmd.X;` brings *all*
of `X`'s public symbols into scope (Rule 3.1), but TS forbids an imported binding that the file
never references — and **type aliases that erase to a primitive carry no runtime symbol to
import at all**. Two cases follow from this:

- **Erasing alias, otherwise unused -> DROP the binding.** A name that maps to an *erasing*
  type alias (e.g. `real_t -> number`, see `02-types.md` / `09-numerics.md`) has no runtime
  existence in TS. If the file uses it nowhere, do **not** emit an import for it; if it is used
  only as a type, see the next point. Emitting `import { real_t }` for an erased alias is both
  unused **and** a value-import of a non-value — a double `tsc --noEmit` failure.
- **Used only in type positions -> `import type { X }`.** A binding referenced solely in type
  positions (field/param/return types, generic args) must use `import type` so it is erased
  from the emitted JS and does not count as an unused value binding under `noUnusedLocals`.

**Example.** D `import dmd.root.ctfloat;` (`dmd/root/complex.d:14`) brings two names into scope:
`CTFloat` (a struct — a real runtime symbol, **keep** it as a value import where used) and
`real_t` (bound via `public import … : real_t = longdouble;` in `ctfloat.d:24`, which **erases
to `number`** on our target). In a file that calls `CTFloat.zero` but never names `real_t`, the
faithful import is value-only for `CTFloat` and `real_t` is **dropped**:

```ts
import { CTFloat } from "./root/ctfloat.js";   // runtime symbol — keep
// real_t dropped: erases to number (02-types.md / 09-numerics.md), unused here
```

Were `real_t` used only as a field/param type, it would instead be `import type { real_t }`.

This keeps `tsc --noEmit` clean. The rule is mechanical: erasing-alias-and-unused -> drop;
used-in-type-positions-only -> `import type`; used as a value -> normal `import`.

---

## 4. Circular imports (the load-order hazard)

**The problem, verified.** D allows free circular module imports; every symbol is available
regardless of import direction. ESM is stricter **for value access at module-evaluation
time**. `translation-order.md §2` identifies the cycles: three small foundation cycles
(Identity: `id`/`identifier`/`tokens`; File I/O: `common/file`/`root/file`/`root/filename`;
Globals: `globals`/`errors`/`file_manager`/`utils`/`sarif`) and one 76-module core SCC
(AST + semantic analysis). This section owns the **handling pattern**.

### Rule 4.1 — what actually breaks (probed with Node)

Verified by reproducer (`/tmp/esmcyc`): in a cycle `a.ts <-> b.ts`, the **only** thing that
throws is **reading a binding from the other module at module-evaluation time before that
module has finished evaluating**:

```
ReferenceError: Cannot access 'Foo' before initialization
```

This fires for both `export const earlyFoo = new Foo();` (top-level construction) and
`export const derivedB = tableA.name + '+B';` (top-level value read) across a cycle. Verified
**safe** across the same cycle:

- `class Foo extends Bar {}` — `extends` across a cycle works.
- `field: Bar | null;` — a class field *typed* as a cyclic class is fine (no value read at
  load time).
- `makeBar() { return new Bar(); }` — construction/value-read **inside a method** is fine
  (runs after all modules finished loading).

**Rule of thumb:** *types and declarations cross cycles freely; **values read/constructed at
top level** do not — and `class X extends Y` IS a top-level value read of `Y`.* The small-
cycle probe above showed `extends` working because the probe's evaluation order happened to
put the base first; in the 76-module core SCC that guarantee does not exist. W2 measured the
real failure mode: `TypeError: Class extends value undefined` (the vitest spelling; under native
Node ESM the same break is `ReferenceError: Cannot access '<Class>' before initialization`), triggerable by a THIRD
module's top-level `extends` when a mere import edge reorders evaluation (dtemplate.ts's
`class TypeDeduced extends Type` broke 20-33 test files when new value edges reached it).
Consequences, all mandatory in the core SCC:
- §4.3's "value import is safe if not read at top level" holds ONLY for modules containing
  no top-level `extends`/value-read reaching back into the SCC; adding ANY new cross-core
  value import is validated by running the FULL suite, never by inspecting one file.
- **The RATIFIED lazy-class shape** for a top-level `extends` that must live inside the
  cycle: declare the binding, define the class in the module's init function —
  `export let TypeDeduced: TypeDeducedCtor; export function initDtemplate(): void {
  TypeDeduced = class TypeDeduced extends Type { ... }; }` — consumers construct at runtime
  as usual.

  **The shape is THREE declarations, not one** — a `let` binding carries no instance type, so
  the name has to be re-supplied as an interface:

  ```ts
  export interface TypeDeduced extends Type { tded: Type[]; }   // the INSTANCE type
  export interface TypeDeducedCtor { new (tt: Type): TypeDeduced; }
  export let TypeDeduced: TypeDeducedCtor;
  ```

  Extending the base in the instance interface keeps every inherited member visible, and —
  because the base's private members originate from that same declaration — the class
  expression stays assignable to the interface. **The split is invisible at use sites:**
  `new TypeDeduced(…)` and `x: TypeDeduced` read exactly as against a plain class.

  Three rules come with it:
  - **A lazy-class fix unblocks only the edges whose failure trace names THAT class.** It is
    not a general licence for cross-core value imports: one such fix unblocked `expression.ts`
    (4 sites), `declaration.ts` (2) and `parse.ts`, while the `dmodule → parse` edge still died
    on `func.ts:353` and `denum.ts:174` — two OTHER top-level `extends` in the same SCC (it now loads
    in first and in last position; `loadorder.test.ts` measures every entry). Every further
    candidate edge is a separate experiment, validated by a full-suite run, and its failure trace
    names the next module to convert. A registration slot is always `var` with no initializer:
    a `let … = null` slot reproduced a TDZ when its registrar ran before the module body.
  - **The init function is a ONE-SHOT LATCH, not an idempotent rebuild.** §5.2's "idempotent or
    called exactly once" is written for inits that rebuild TABLES; here the state IS a class
    object, and reconstructing it is actively harmful — a second call installs a SECOND class,
    and every instance built earlier silently fails `instanceof`. Latch on first call and
    return (`dtemplate.ts:475-478/511-513` carries the worked form, including why a
    `Binding === undefined` guard does not typecheck against a non-optional declared type).
  - **Registration in the §5 init order is DEFERRED to W6 and is the integrator's to close** —
    `src/init-order.ts` / `runModuleConstructors()` (the §5.2 worked example) does not exist
    before then, so a translator cannot execute an instruction to register there. Until W6, a
    port-only init records its required position as an **ORDER CONTRACT** paragraph in its own
    docstring (what must be evaluated before it, and what must not) plus an escalation record;
    the file owner does not invent a registry.

### Rule 4.7 — LOAD-ORDER ROOTS carry no runtime edges into the SCC

A module that many core modules `extends` from at top level (visitor/index.ts is THE case:
dsymbol/mangle/typesem/dsymbolsem/expressionsem/semantic3 all extend `Visitor` at top level)
is a LOAD-ORDER ROOT: it evaluates before the SCC, in every entry order. A root may use
`import type` freely but may carry **zero runtime import edges** into the SCC — any such
edge makes the whole graph unloadable. A root method needing an SCC value (a dyncast
dispatcher, an enum VALUE) stubs that method with a one-marker-line STOP stub; the root's
header records the invariant. (Dynamic `import()` is not an escape here — it would make a
synchronous visitor method async.)

### Rule 4.2 — canonical pattern: type-only imports for type positions

When a cyclic import is used **only in type positions** (field types, parameter/return types,
`extends`/`implements`, generic args), import it with `import type`. TypeScript erases
`import type` from the emitted JS, so it contributes **zero** to the ESM load cycle.

**BEFORE** (`expression.d` references `Type` from `mtype.d`, which references back)

```d
module dmd.expression;
import dmd.mtype;          // Type used as field type
class Expression { Type type; }
```

**AFTER**

```ts
// Ported from dmd/expression.d (module dmd.expression).
import type { Type } from "./mtype.js";   // type-only: erased, breaks the value cycle
export class Expression {
  type: Type | null = null;               // type position only — safe across the cycle
}
```

**Decision:** if a symbol from a cyclic module is used **only** in type positions in this
file, **always** import it with `import type`. If it is *also* constructed/called as a value,
use a normal `import` (Rule 4.3) — do not split one symbol across both.

**The one exception: a `const enum` whose value import is forbidden for load order.** Under
`verbatimModuleSyntax` a value import of a `const enum` stays in the emitted JS and is a load edge
like any other. When that edge is measured to break load (Rule 4.4's module-level inversion:
`hdrgen.ts` may import `PREC` from `parse.ts` only as a type), the enum is imported with
`import type` and member access does not compile (`PREC.assign`: TS1361, "cannot be used as a
value because it was imported using 'import type'"). The members the file needs are then local
constants typed as the enum, under a comment citing the D enum line:

```ts
// parse.d:9737 `enum PREC : int` — zero, expr, assign, cond, oror, andand, or, xor, and, equal, rel, …
const PREC_zero: PREC = 0;
const PREC_assign: PREC = 2;
```

tsc checks MEMBERSHIP, not WHICH member: `const PREC_assign: PREC = 7` fails (TS2322), while `= 1`
compiles and is `PREC.expr`. Each value is therefore verified against the D enum's member order and
initializers, never taken from memory or from the TS mirror alone.

### Rule 4.3 — value uses across a cycle: normal import + defer construction into runtime

A normal value `import` across a cycle is **safe as long as the imported binding is not read
at the top level of this module**. Construction inside constructors/methods runs after load.

**BEFORE**

```d
class CallExp : Expression {
    this(Loc loc, Expression e) { super(loc); /* e.g. new VarExp(...) elsewhere */ }
}
```

**AFTER**

```ts
import { Expression } from "./expression.js";   // value import; used only at runtime
export class CallExp extends Expression {
  constructor(loc: Loc, e: Expression) { super(loc); /* new VarExp(...) runs post-load */ }
}
```

This is verified safe. The **forbidden** form is a top-level `new`/value-read of a cyclic
import (Rule 4.5).

### Rule 4.4 — function-local (deferred) imports -> hoist, dynamic `import()`, or registration-slot inversion

D function-local imports (indented `import` inside a function body) are the lever
`translation-order.md` uses to break cycles (the 11 "breakable" modules, §3 there). A
function-local D import is only needed when the function runs, not at load. Two canonical
forms:

- **Preferred (covered case):** if the symbol is a *type*, hoist it to a top-level
  `import type` (still erased). If it is a *value* used only at call time and its module is
  **not** in this file's load cycle, hoist it to a normal top-level `import` (simpler, and
  load order is fine).
- **Only when a top-level value import would re-introduce a load-time cycle:** use a dynamic
  `import()` inside the function, awaited or `.then`-chained:

```ts
async function needsLater(/* ... */) {
  const { someFn } = await import("./dsymbolsem.js");   // deferred: not in load cycle
  return someFn(/* ... */);
}
```

- **Third form — REGISTRATION-SLOT INVERSION, the only synchronous cycle-free one.** For a D
  function-local import into the core SCC (`declaration.d:725 import dmd.mangle;`), hoisting
  creates the load edge and dynamic `import()` async-contaminates every caller. Invert the
  edge instead: the IMPORTED module registers itself with the importing one, which reads the
  slot at call time.

  ```ts
  // declaration.ts — the consumer owns the slot and never imports mangle
  let mangleToBuffer: ((s: Dsymbol, buf: OutBuffer) => void) | null = null;
  export function registerMangleToBuffer(fn: (s: Dsymbol, buf: OutBuffer) => void): void { mangleToBuffer = fn; }
  // at the D call site:
  if (mangleToBuffer === null) throw new Error("mangle not registered (dmd/declaration.d:725)");
  mangleToBuffer(this, buf);
  ```

  Two invariants, both load-bearing: **the registrar must be a hoisted FUNCTION DECLARATION**
  (it is called while the importing module is still mid-evaluation, and a `let`/`const` slot
  would be in TDZ), and **the consuming site fails LOUDLY on an empty slot** — never a
  fallback, which would silently substitute different behaviour for the D call.

  Instance where no inversion was needed: semantic3.d:84 `version(FastDFA) import dmd.dfa.entry;`
  is a plain value import LAST in semantic3.ts; both loaders stay green (loadorder.test.ts).

  **The same inversion covers a D MODULE-LEVEL import** when the faithful value import is
  measured to break module load even at the LAST position (§4.8). Last position is tried first;
  the inversion is used only after the full-suite collect fails with the import there. Instance:
  `hdrgen.d:42/:43` `import dmd.optimize; import dmd.parse;` — a value import of either module
  from `hdrgen.ts`, even last, killed 14 test files at collect. `hdrgen.ts` owns the slots as
  `var` with no initializer (a provider whose body runs before the consumer's neither hits a TDZ
  nor has its registration reset when the consumer's body runs) and the hoisted registrars
  `registerPrecedence` / `registerOptimize`; each provider hands its value over from its own
  module body — `registerPrecedence(precedence);` at the end of `parse.ts`'s precedence table,
  `registerOptimize(optimize);` at the end of `optimize.ts`. Two obligations on top of the
  invariants above:
  - the consumer's header **records the measurement** (the position tried, the failing count,
    the error and the chain it enters) and an **ORDER CONTRACT** naming which entries leave the
    slots empty: every entry whose module graph does not contain the provider;
  - every consuming site **fails loudly when its slot is empty**, naming the registrar and the D
    definition it stands for: `throw new Error("hdrgen.expPrecedence: registerPrecedence not
    called (dmd/parse.d:9763)")`.

  Instance: hdrgen.d:30 `import dmd.doc;`. A last-position value import of doc.js from hdrgen.ts
  failed 56 rows of loadorder.test.ts. hdrgen.ts owns `escapeDdocStringSlot`/`registerEscapeDdocString`,
  doc.ts registers at the end of its body, and main.ts imports doc.js last among its `dmd/` imports.
  Instance: `dmodule.d:26` and `iasm/gcc.d:27` `import dmd.cparse;`: a value import of cparse.js from
  dmodule.ts or gcc.ts fails at any position with parse.ts as entry (`class CParser extends Parser` runs
  before parse.ts has finished). Inverted twice: dmodule.ts owns `registerCParser`, gcc.ts owns
  `registerGccAsmCParser`, cparse.ts calls both from its body, and src/djs.ts imports cparse.js so the
  provider is always loaded.

**Decision:** prefer hoisting to a top-level (typed or value) import. Reach for dynamic
`import()` **only** to break an otherwise-unavoidable load-time value cycle, and note it:
`// deferred import: breaks load-time cycle with dsymbolsem`. If turning a synchronous D
function `async` to accommodate `await import()` would ripple through call sites, **STOP and
escalate** — async contagion is a design decision, not a mechanical rewrite. Inversion is the
form to reach for when the cycle is real and the call must stay synchronous.

**Look for the cheaper remedy FIRST: a single body-phase VALUE import at the top level of a
widely-imported node file.** One `import { … } from "./mangle/index.js"` at `declaration.ts:54`,
serving ONE call at `declaration.ts:800`, dragged mangle + mtype + the whole sema world into the
middle of `declaration.ts`'s evaluation and broke 45 test files. Removing or inverting that one
edge is cheaper than converting a class. When the suite goes red and the remedy is in another
agent's file: (a) escalate `category: dependency signature`, naming the break chain and the
remedy; (b) do **NOT** fabricate walls, or `import type` plus a stub, to make the suite green —
that trades a visible load-order defect for an invisible capability loss; (c) keep the faithful
value import in your own file.

**Diagnostic recipe** for `TypeError: Class extends value undefined is not a constructor or
null`: instrument the failing `extends` line with `Error.stackTraceLimit = 300` and print a
stack filtered to `src/` — the whole import chain, from entry module to the half-evaluated one,
comes out in a single run.

### Rule 4.8 — import ORDER inside a module is load-bearing

ESM evaluates a module's imports **in source order**, so the first import of a `*sem` file
chooses which module becomes the entry point of the core SCC — **import order is part of the
port, not formatting.** Reproduced in both directions on a settled tree: adding
`import { needOpEquals } from "./clone.js"` at its ALPHABETICAL position in `opover.ts` made
opover the entry point of `clone → func → declaration`, and the whole suite died at collect
with `TypeError: Class extends value undefined is not a constructor or null`; the SAME import
moved to LAST position is green (early: fail; last: 11/11 pass). Independently, a draft that
listed imports alphabetically put `dsymbolsem.js` ahead of `expression.js` and failed at load
in `func.ts:353` via `funcsem.ts:44`, while `declaration.ts` was still evaluating.

- **In a `*sem` module, name an AST-node module (`expression.js`, `mtype.js`) BEFORE any
  `*sem` / `aggregate` / `dsymbol` module.** On the tree `loadorder.test.ts` measures, every entry
  loads on both loaders; the ordering rules still govern NEW edges, and that suite is the gate.
- **The canonical remedy for a value import into a cycle-heavy module is LAST position**, with
  a comment naming the chain it would otherwise enter (`// last: entering the SCC here makes
  this module the entry of clone → func → declaration`).
- Rule 4.2 covers type-only use and Rule 4.5 covers top-level value reads; this rule covers the
  case neither does — **a plain function import whose only sin is being evaluated too early.**
- **`src/dmd/loadorder.test.ts` is what catches it**, on both loaders: every non-test module under
  `src/` is imported as the first module of an empty registry, once under vitest
  (`vi.resetModules()` + `import()`) and once under native Node ESM over the tsc emit (one
  `worker_threads` Worker per entry). A red row names the entry and the import chain. The native
  leg is the one that catches a top-level read that only stores a cyclic binding: vitest hands it
  back as `undefined`, native ESM throws `ReferenceError: Cannot access 'X' before initialization`.

### Rule 4.5 — the 76-module core SCC: stub-headers-first batch

For the core SCC (`translation-order.md §2.2`) there is **no file order** that loads cleanly
in isolation. Translate it as a coordinated batch:

1. **Emit all class headers as stubs first** — class name, `extends`/`implements`, and field
   declarations with correct types via `import type` (Rule 4.2). Empty method bodies. This
   lets TS resolve the entire type graph with **zero** load-time value cycle (everything is a
   type or an erased import).
2. **Fill method bodies second**, in the `translation-order.md §2.2` order: AST node type-defs
   (a) -> semantic passes (b) -> CTFE (c). Bodies use value imports (Rule 4.3); their
   construction runs at runtime, after load.
3. **Never** write a top-level `const X = new SomeCoreClass()` or a top-level read of another
   core module's binding. If the D source has a module-level value that depends on another
   core module, it is a `static this()` — handle it per §5 (init function), **not** as a
   top-level const.

**The forbidden pattern (will throw `ReferenceError` at load):**

```ts
// BAD — top-level construction across a cycle:
export const TVOID = new TypeBasic(TY.Tvoid);   // throws if mtype not yet evaluated
```

**The required pattern:** declare the binding, initialize it in an init function (§5):

```ts
export let TVOID: TypeBasic;                     // declared, not constructed at load
export function initMtype(): void { TVOID = new TypeBasic(TY.Tvoid); }
```

### Rule 4.6 — interface extraction for the foundation cycles

For the small foundation cycles where the dependency is a *data hub* (e.g. cycle C:
`globals`/`errors`/… — `Global`/`Param` data vs error-printing functions), prefer **splitting
the type from the behavior**: put the shared data interface in its own module imported with
`import type` by both sides, so neither side value-depends on the other at load. This is the
same lever as Rule 4.2, applied to break a data/behavior cycle. Coordinate the split when
translating the batch; record it with a `// cycle-split: …` comment.

---

## 5. Module-level `static this()` / `shared static this()` -> ordered init functions

**Invariant:** D runs module constructors (`static this()` per-thread, `shared static this()`
once) **after** all module *static initializers* and **before** `main`, in an order DMD
computes from the import graph (a module's ctor runs after the ctors of modules it imports).
ESM has no equivalent ordered hook, and (per §4) a top-level statement that reads another
module's not-yet-evaluated binding throws. So a `shared static this()` that touches another
module's state **cannot** become a top-level TS statement.

**Decision (use this, no alternatives):** every module-level `static this()` /
`shared static this()` becomes an **exported init function** `init<Module>()` whose body is
the constructor body, and the CLI shim calls all init functions **explicitly, in import-graph
order**, once, before lexing begins.

### Rule 5.1 — the transformation

Live frontend module constructors (after `_config.md` resolution): `imphint.d:39`,
`tokens.d:601`. (`root/longdouble.d:75` is gated `version(unittest) version(CRuntime_Microsoft)`
— both OFF, so **dropped**; `templatesem.d:227/1436` are `shared static ~this()` destructors —
see Rule 5.3.)

**BEFORE** (`dmd/imphint.d:36-39` — builds a static lookup table)

```d
private immutable string[string] hints;
private immutable string[string] cHints;

shared static this()
{
    hints = [ "AliasSeq": "std.meta", "appender": "std.array", /* ... */ ];
}
```

**AFTER**

```ts
// Ported from dmd/imphint.d (module dmd.imphint).
let hints: Map<string, string>;          // declared, NOT initialized at load (cf. §4.5)
let cHints: Map<string, string>;

export function initImphint(): void {    // ported: shared static this() -> init function
  hints = new Map([["AliasSeq", "std.meta"], ["appender", "std.array"], /* ... */]);
  cHints = new Map([/* ... */]);
}
```

**Why not a top-level `const`?** A top-level `const hints = new Map([...])` *would* work for
`imphint` alone (it reads no other module). But the **uniform rule** is "init function",
because some constructors *do* cross modules (Rule 5.2) and a mix of "sometimes top-level,
sometimes init function" is exactly the per-file ambiguity this guide forbids. One canonical
form, every time.

### Rule 5.2 — cross-module init order is load-bearing

`tokens.d:601`'s `shared static this()` calls `Identifier.initTable()` and `Identifier.idPool`
(defined in `identifier.d`) — so the **identifier** module's init must run **before** the
**tokens** module's init.

**BEFORE** (`dmd/tokens.d:601-609`)

```d
shared static this() nothrow
{
    Identifier.initTable();
    foreach (kw; keywords)
        Identifier.idPool(Token.tochars[kw], kw);
}
```

**AFTER** (`src/dmd/tokens.ts`)

```ts
import { Identifier } from "./identifier.js";

export function initTokens(): void {    // ported: shared static this() -> init function
  Identifier.initTable();               // requires identifier module state ready first
  for (const kw of keywords) Identifier.idPool(Token.tochars[kw], kw);
}
```

**The ordering is encoded in the shim's init sequence, not inferred at runtime.** The shim
calls inits in dependency order (a module's init after the inits of modules it depends on):

```ts
// src/init-order.ts — shim (non-DMD, sibling of src/dmd/); explicit, ordered; mirrors DMD's module-ctor ordering.
import { initIdentifier } from "./dmd/identifier.js";   // (if identifier has its own init)
import { initTokens }     from "./dmd/tokens.js";
import { initImphint }    from "./dmd/imphint.js";

export function runModuleConstructors(): void {
  initIdentifier?.();   // before initTokens — tokens' ctor calls Identifier.*
  initTokens();
  initImphint();
  // ... every ported module that had a `static this()`, in import-graph order ...
}
```

**Invariants:**
- The init order **must** respect the import graph: if module B's `static this()` uses
  symbols/state initialized by module A's `static this()`, `initA()` precedes `initB()`.
  Derive the order from `translation-order.md`'s layering (lower layer = earlier init).
- **Identity-based singletons die SILENTLY under a wrong init order — this is a confirmed
  bug class, not a theory.** The 4c incident: calling `Id.initialize()` before `initTokens()`
  orphaned every `Id.*` singleton, because `initTokens` re-creates the interning table
  (D ctor order runs tokens.d's ctor first); every `ident === Id.x` comparison went
  permanently false with no error anywhere. Consequences, all mandatory: (a) any init
  function whose relative order is load-bearing carries an **ORDER CONTRACT line in its
  docstring** naming what must run before/after it and why; (b) every test harness that
  initializes modules manually mirrors the D module-ctor order exactly — harnesses are the
  main place the order gets re-typed and broken; (c) identity-based singleton wiring gets a
  regression pin (`identifier === Id.x` asserted in a test) so an order break is loud.
- Each init function is **idempotent or called exactly once** (`crash-only-recovery.md`):
  the shim calls `runModuleConstructors()` once at startup; on a crash-restart it re-runs
  cleanly because init functions rebuild state from scratch.
- If you cannot determine the correct relative order of two module constructors from the
  import graph, **STOP and escalate** — guessing init order produces non-deterministic,
  hard-to-debug failures.

### Rule 5.3 — `static ~this()` / `shared static ~this()` destructors -> usually drop

Module destructors free resources at program shutdown. With GC erased (`_ground-truth.md §4`,
33 `~this` dtors mostly erasable) and the shim being short-lived, **drop** module destructors
unless they perform an externally-visible side effect (flush a file, emit a report). Record
the drop: `// dropped: shared static ~this() (no deterministic cleanup needed)`. If a
destructor *does* flush/close something the shim relies on, **STOP and escalate** — destructor
ordering at shutdown is its own decision.

---

## 5.5 Cached `__gshared` AST singletons — identity-shared, never mutated, harness-resettable

Some AST nodes are **per-value cached singletons** behind a static accessor: D's
`IntegerExp.literal!v` (`dmd/expression.d:904-910` — each template instantiation carries its
own `__gshared` instance), `IntegerExp.createBool`, `ErrorExp.errorexp`. Three rules:

1. **Identity sharing is load-bearing — replicate it.** Every caller for the same value gets
   the SAME object (TS: a `static Map<number, IntegerExp>` cache or per-value static field).
   Downstream code may compare by identity, and the synthesized-AST goal tests pin it
   (e.g. two `S a; S b;` locals share ONE `literal(0)` instance).
2. **The singleton is immutable — paint parents, never the literal.** Consumers that need a
   type/loc on the result set it on the PARENT node (the zeroInit `BlitExp` gets
   `e.type = dsym.type`, dmd/dsymbolsem.d:2212 — the literal stays `loc=Loc.initial`,
   `type=tint32`). State this in the accessor's interface comment; a mutation would corrupt
   every other tree sharing the instance.
3. **Harness and in-process driver: reset the cache alongside `Type._init`.** D is a one-shot
   process; the vitest harness re-runs `Type._init()` per test, and an in-process host calls
   `djsMain` once per compile, so a surviving cache would hand the next run a literal typed with
   a STALE `tint32` — a state impossible in D. The canonical fix is a reset static
   (`IntegerExp._resetLiteralCache()`, documented "no D counterpart") invoked in `beforeEach` next
   to `Type._init()` and by the driver's `deinitializeFrontend` (src/djs.ts, 10 §4.7), never by
   frontend code. The same holds for a function-local `__gshared` recursion counter that a
   `fatal()` stop leaves raised; one whose D read was dropped upstream (`old_loc`, errors.d) needs
   no reset for correctness, and its reset comment must not invent one. Do NOT encode
   describe-ordering constraints in test files instead — they are unenforced and break under
   `-t` filtering/`.only`. (Asymmetry worth knowing: `Loc.initial` is `static readonly`, never
   reassigned by `Loc._init`, so identity pins against it are order-independent already.)

**A FUNCTION-LOCAL `__gshared` is module state, not a local.** §5's rules are written for
module-level declarations, but D also allows the cache to be declared inside the function that
fills it — `clone.d:822` `__gshared TypeFunction tftohash;` inside `buildXtoHash`. It has
program lifetime and is shared across calls, so a body-local `let` is a silent semantic change:
it resets on every call and the cache never caches. The faithful form is **module state hoisted
above the function**, with a comment naming the D function it is declared inside — the same
rules 1-3 above then apply to it unchanged.

---

## 5.6 `static immutable` VALUE singletons → deep-freeze at construction (DECIDED)

A D `static immutable` struct value (`static immutable Loc x = …;`, immutable tables of value
structs) is genuinely immutable — D enforces it. Its naive TS translation is a **shared mutable
object**: every reader can silently corrupt every other reader, which is a strictly worse
contract than either D behavior. `readonly` on the TS fields is NOT sufficient — it stops
`obj.field = x` at compile time only where the static type says `readonly`, and does nothing
against writes through a wider-typed alias.

**Decision (one canonical form, no per-site choice): deep-`Object.freeze` the value at
construction and hand it out SHARED.**

```ts
// D: static immutable ModRefInfo initTable = ModRefInfo(...);
static readonly initTable: ModRefInfo = Object.freeze(new ModRefInfo(/* ... */));
```

- Freeze at the single construction site (recursively, if the value nests value structs —
  freeze each level). Under ESM strict mode a later write THROWS `TypeError`, so a violation
  is loud, exactly matching the spirit of D's immutability instead of silently diverging.
- **Typed-array carve-out:** `Object.freeze` on a `Uint8Array` with elements throws
  `TypeError` in V8 (integer-indexed elements cannot be frozen), so a `DString`-backed
  immutable (`static immutable name = "literal";`) CANNOT freeze. Canonical form there:
  `static readonly <name>: DString = ds("literal"); // D static immutable — do not mutate
  (typed arrays cannot freeze)`. The `readonly` guards the slot; the comment carries the
  element-immutability contract.
- Sharing is then sound with no `.copy()` at readers — a frozen value is the one case where
  share ≡ copy by construction (same argument as the `Optional` note in `08-runtime-lib.md
  §10` and the alias-safe register, `03-value-semantics.md §9.1`).
- Do NOT choose per-site between freeze and copy-on-read; freeze-at-construction is the only
  sanctioned form. A `static immutable` whose members hold CLASS references freezes the
  struct's own slots only (the pointees follow their own rules) — if a reader needs to mutate
  a copy, it takes an explicit `.copy()` first, which un-freezes by constructing fresh.

(Distinct from §5.5: those are deliberately-shared MUTABLE-class caches with a "paint parents,
never the literal" discipline. This section is for values D itself declared immutable.)

---

## 6. Numerics — out of scope here

All integer-width, signed/unsigned, BigInt-vs-`number`, cast/truncation, and float-precision
rules live in **`09-numerics.md`**. When a field or identifier you escape (§2) or a
module-constructor table you build (§5) involves `long`/`ulong`/`cent`/`ucent` or CTFE integer
math, apply the numeric domain rules from `09-numerics.md` — this document only governs the
*name* and the *module/init mechanics*, not the value representation.

---

## 7. Translation order is **strict bucket order**; data tables are an early Bucket-0 step

**Invariant:** the 2c translation workflow translates files in the **bucket order** fixed by
`translation-order.md §5` (Bucket 0 -> 9), top-to-bottom. Bucket order is **not** advisory:
each bucket may value-depend on lower buckets at load time (the init/cycle mechanics of §4–§5
assume lower layers are already present), so translating out of order re-introduces exactly the
load-time `ReferenceError` cycle §4 exists to prevent. **Do not pull a higher-bucket file
forward** because it "looks ready"; **do not defer a lower-bucket file** because it is tedious.
Within a single bucket, file order is free **except** marked cycle members (`‹cycle X›`), which
translate together as a batch.

### Rule 7.1 — large auto-generated data tables are transliterated mechanically, early

Two Bucket-0 modules are **machine-generated Unicode/HTML data tables**, not hand-written
logic:

| D module | What it is | Size |
|---|---|---|
| `dmd.common.identifiertables` (`dmd/common/identifiertables.d:1`) | UAX31 codepoint range tables (`UAX31_Start`/`UAX31_Continue`, `static immutable dchar[2][]`), header says *"Generated by compiler/tools/unicode_tables.d DO NOT MODIFY!!!"* | ~4 200 lines |
| `dmd.entity` (`dmd/entity.d:14`) | HTML named-entity name->codepoint table (`namesTable`) plus a small `HtmlNamedEntity` lookup | ~2 360 lines |

These are **Bucket-0 items** (pure leaves, no cyclic deps) and must be done as an **early,
dedicated step** — other modules' lexing/identifier logic depends on them. Because the bulk is
**pure data**, do **not** hand-transcribe thousands of literal rows: run a **small generation
script over the D data arrays** to emit the TS literal (`readonly` arrays / a `Map`),
mechanically and 1:1.

**Decision (use this, no alternatives):**
- Transliterate the data **arrays** mechanically (script-generated TS literals), preserving the
  exact values and row order so the result stays diff-able against the D source.
- Translate the **logic** that rides alongside the table (e.g. `entity.d`'s `HtmlNamedEntity`
  linear-search function) by hand, per the normal rules of this guide.
- Apply numerics policy from `09-numerics.md` to the literal element type (codepoints are plain
  `number`; no element here needs `bigint`).
- Keep the generated-banner provenance: emit the Rule 1.2 provenance line plus a note that the
  data rows were script-transliterated from the upstream generated table (so a reviewer does not
  expect them to be hand-maintained).

```ts
// Ported from dmd/common/identifiertables.d (module dmd.common.identifiertables).
// Data rows script-transliterated 1:1 from the upstream generated table (DO NOT hand-edit).
export const UAX31_Start: readonly (readonly [number, number])[] = [
  [0xAA, 0xAA], [0xB5, 0xB5], [0xBA, 0xBA], [0xC0, 0xD6], /* ...generated... */
];
```

**Invariants:**
- The generation script is a build-time aid, **not** a runtime dependency: its output is the
  committed `.ts` literal; the script itself is not part of the port's load path.
- Row order and values are byte-faithful to the D arrays — a reviewer diffs the generated TS
  against the D data and sees a 1:1 correspondence.
- This is the **only** sanctioned deviation from "translate constructs by hand": it is limited
  to **large machine-generated data tables**. Ordinary `static immutable` arrays small enough to
  read are translated inline by the normal rules — do not invoke a script for them.

---

## Cross-references

- Type-level mapping of `struct`/`class`/`enum`/`alias`, and the `ASTCodegen` namespace
  aggregation: `02-types.md`.
- Value-copy `.copy()` discipline (why struct fields you rename in §2 still need copy
  semantics): `03-value-semantics.md`.
- Which cycles exist and the per-bucket file order the batch in §4.5 consumes:
  `translation-order.md`.
- Resolved/dropped-comment convention used throughout (§3.6, §5.3): `_ground-truth.md §5`.
- STOP/throw stubs for stripped excluded-module call sites (§3.6): `11-escalate.md`.
- Runtime-library mapping for `core.*` / `std.*` imports (§3.5, §3.7): `08-runtime-lib.md`.
- Numeric domain & representation (§6): `09-numerics.md`.
