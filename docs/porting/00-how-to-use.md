# 00 — How To Use This Guide (Entry Point & Operating Manual)

> **STOP rule (read first, applies always):** if you meet a construct this guide does not
> cover, or any ambiguity about how a D semantic maps to TS, **STOP and escalate** — never
> guess. See `11-escalate.md`. A wrong-but-plausible translation in a compiler is worse than
> a halt: it produces a compiler that miscompiles silently, and the bug surfaces hundreds of
> files away. Halting is cheap; a phantom semantic is expensive.

This is the table-of-contents and the how-to-operate doc for the whole D→TypeScript porting
guide. Read `_ground-truth.md` before anything else — it holds the locked decisions, the
verified facts, the source paths, and the house style. This doc tells you **what we are
doing, how to do one file, where every rule lives, and when to stop.**

---

## 0. The mission, and the one distinction that governs everything

We are porting the **LDC/DMD compiler *frontend*** — the D language front end: lexer →
parser → semantic analysis → CTFE — from **D** to **TypeScript**.

**We are porting the compiler, not D programs.** This is the single most important framing.
Keep it straight or you will do the wrong work:

- The **frontend's own source code** uses only a *constrained subset* of D — the
  `extern(C++)` portable subset (735 `extern(C++)` decls across `dmd/*.d`). That subset is
  what this guide teaches you to translate. It is JS-friendly by construction: no
  range-based UFCS pipelines, no GC-finalizer reliance, no fancy template metaprogramming
  in hot paths — it is the C++-portable intersection.
- The **D language features** that the frontend *implements* (full templates, CTFE, mixins
  evaluated on user code, `static if` over user types) are **not** something we re-design in
  JS. They come along *for free* as the faithful translation of the algorithms in
  `dtemplate.d`, `dinterpret.d`, `dsymbolsem.d`, etc. We translate the algorithm; the
  algorithm provides the feature.

So when this guide says "how to translate `static if`", it means: how to translate a
`static if` **that appears in the frontend's own source** (resolve it at translation time
against the fixed config — see `07-compile-time.md`), **not** how to make the ported compiler
evaluate `static if` in user code. The latter is just the faithful translation of the
relevant `*sem.d` logic, and needs no special treatment here.

**Worked illustration of the distinction.** Take `dmd/expression.d:749`:

```d
extern (C++) final class IntegerExp : Expression   // dmd/expression.d:749
{
    dinteger_t value;                              // dinteger_t = ulong (globals.d:642)
    extern (D) this(dinteger_t value) {
        super(Loc.initial, EXP.int64);
        this.type = Type.tint32;
        this.value = cast(int)value;               // dmd/expression.d:773
    }
    override void accept(Visitor v) { v.visit(this); }   // dmd/expression.d:814
}
```

This single class is *frontend source* — we translate every line of it. It is an AST node
that *represents* a D integer literal in the user's program. We do **not** "implement integer
literals in JS"; we translate the class that models them. The `cast(int)value` is a real
numeric truncation we must reproduce (`09-numerics.md`); the `accept(Visitor)` is the visitor
pattern we must preserve (`02-types.md`); `dinteger_t = ulong` puts `value` in the BigInt
domain (`09-numerics.md`). That is the whole job, repeated 148 files over.

### 0.1 The root-runtime exemption (the one place the 1:1 rule is relaxed)

There is exactly **one** category of file where the faithful-1:1 structural-mirror rule does
**not** apply: the low-level runtime modules under `dmd/root/*` and their kin — `Array`,
`StringTable`, `BitArray`, `OutBuffer`, `file`, `rmem`/`region`, and the rest of the
container/allocator/IO layer. These are **not** translated line-for-line. They are written as
**hand-written replacements** that implement the same **observable contract** over idiomatic
JS primitives — JS arrays, `Map`, typed arrays, `node:fs`, and the GC — exactly as specified
in `08-runtime-lib.md`. The reason is that their bodies are *raw-memory engine internals*
(custom allocators, free-lists/pools, `nextpow2` capacity math, `findSlot` open-addressing,
manual `grow`/realloc) whose entire purpose is to manage memory that JS manages for us; a
structural mirror of that machinery would be both pointless and wrong.

For these runtime modules **only**, the per-file workflow is relaxed as follows:

- **Step 1 / Step 4 (faithful 1:1) is RELAXED.** Implement the *contract* — the public
  methods and their observable behavior — not the internal structure. **Drop** the raw-memory
  machinery (custom allocators, memory pools, `nextpow2`, `findSlot`, manual `grow`/realloc,
  capacity bookkeeping). `08-runtime-lib.md` is the authoritative method-by-method contract;
  follow it, do not re-derive it.
- **Step 5 (port every `unittest`) is RELAXED.** Per `10-tests-diagnostics.md`, **drop**
  engine-internal unittests (those that assert on capacity growth, slot layout, allocator
  behavior, or other internals that no longer exist) and **keep** the behavioral / contract
  tests (those that assert on observable container behavior — iteration order, membership,
  values, lookup results).
- **Auditable deletions.** Every dropped D construct (a method, a field, a unittest) carries a
  one-line comment mapping it to its dmd line — e.g.
  `// dropped: Array.reserve()/grow() (array.d:88) — JS array grows itself` — so each deletion
  is traceable back to upstream and the omission is deliberate, not an oversight.

This exemption is **scoped to the runtime layer**. The faithful structural 1:1 rule remains in
**full force** for every non-runtime *frontend* module — lexer, parser, the `*sem` passes,
`constfold.d`, `dinterpret.d`, and all the rest. Those carry algorithms we must reproduce
exactly; the runtime layer carries memory plumbing we replace with the platform's own.

---

## 1. The per-file translation workflow (do this for every file)

You are typically handed **one D file** to translate to its TS counterpart. Follow these
steps in order. Each step points to the doc that owns the rules; this doc owns only the
*sequence*.

### Step 1 — Locate the file in the dependency order

Open `translation-order.md` and find your file's **bucket** (0–9). Confirm every file in
lower buckets is already translated (or stubbed), because your file depends on them. If your
file is inside the **76-module core SCC** (Bucket 7), you are not translating it in isolation
— you are filling in a body within a coordinated batch whose class headers were already
stubbed. The cycle-handling mechanics (stub-first, `import type`, lazy `import()`) are owned
by `01-conventions.md`. Do **not** invent your own cycle-break.

### Step 2 — Map the D module to its TS module

Apply the naming/layout rules in `01-conventions.md`: `dmd/expression.d` →
`src/dmd/expression.ts`, `dmd/root/array.d` → `src/dmd/root/array.ts`, identifier names kept
verbatim (subject only to JS-reserved-word escaping). The port is a **faithful structural
1:1** mirror — same file structure, same class order, same method order, so the result stays
diff-able against future upstream DMD. Do not reorganize, do not "improve" the structure.

> **Exception — root-runtime modules.** If your file is a `dmd/root/*` runtime module (or
> another low-level runtime: `Array`, `StringTable`, `BitArray`, `OutBuffer`, `file`, `rmem`,
> …), the faithful 1:1 rule is **relaxed** — see §0.1 and `08-runtime-lib.md`. You implement
> the observable contract over JS primitives and drop the raw-memory internals; you do **not**
> mirror the body line-for-line.

> Note: the `djs` TS project scaffolding (`package.json`, `tsconfig.json`, `src/`, `tests/`)
> is set up by the project owner per `01-conventions.md`; if it is not present yet, escalate
> rather than improvising a layout.

### Step 3 — Resolve translation-time constructs against the fixed config

Before translating logic, resolve everything that is decided at *translation* time, not run
time:

- `version(...)` / `debug(...)` → look up the ON/OFF disposition in `07-compile-time.md` §1.2.
  Emit only the live branch, with the auditable one-line comment
  (`// resolved: version(Windows) -> false (target=posix)`). `07-compile-time.md` owns the
  rules and the table.
- `static if`, `static foreach`, `__traits`, `is(...)`, `mixin`, `typeof` → resolve against
  the fixed world and emit the concrete result with a resolved-comment
  (`07-compile-time.md`).
- Imports of **excluded modules** (`dtoh.d`) →
  strip the import and replace each call site with a STOP/throw stub
  (`translation-order.md §4`, `11-escalate.md`).

### Step 4 — Translate each construct, looking up its rule

Walk the file top to bottom. For every D construct you meet, consult the doc that owns it
(see the INDEX in §4). Do not translate from memory — the rules are decisive and there is
exactly **one** canonical translation per idiom; using a different-but-equivalent form breaks
determinism across the many parallel translation agents. The cross-cutting traps:

- **Struct value semantics** — every struct copy (assignment, by-value arg, array-element
  read into a var, return-by-value) MUST emit an explicit `.copy()` or the alias bug is
  silent (`03-value-semantics.md`). This is the most dangerous trap in the whole port.
- **Operator overloads** — JS has no operator overloading; `opXxx` becomes a method and every
  call site is rewritten (`05-operators.md`).
- **Numeric domain** — `long`/`ulong`/CTFE-exact integers → BigInt; provably-small
  indices/lengths and all floats → `number`. Casts truncate (mask-then-sign-extend);
  arithmetic wraps mod 2^width (`09-numerics.md`).

### Step 5 — Port in-source tests and preserve diagnostics

- `unittest` blocks → Vitest tests (`10-tests-diagnostics.md`).
- Any `error(...)` / diagnostic must reproduce DMD's message string **verbatim** (location +
  text) so the `fail_compilation` `TEST_OUTPUT` assertions reuse unchanged
  (`10-tests-diagnostics.md`). Example: `dmd/expression.d:762` emits
  `"integral constant must be scalar type, not \`%s\`"` — the ported message must match byte
  for byte.

### Step 6 — Compile and unit-test

Run the TypeScript compiler and the unit tests:

```
npx tsc --noEmit        # types must be clean under strict mode
npx vitest run          # ported unittest blocks must pass
```

`tsc` clean + `vitest` green is the *local* correctness bar for the file. It is necessary,
not sufficient — the corpus check in Step 7 is the real proof.

> **Isolated single-file translation (no scaffolding/deps yet).** When you translate one file
> before the project scaffolding and dependency stubs exist, the cross-module `tsc`/`vitest`
> run is not yet possible. The interim bar is a **syntax-only check** of the file alone
> (`node --experimental-strip-types --check src/dmd/<file>.ts`, or `tsc` on that file alone).
> The full strict cross-module `tsc --noEmit` + `vitest run` becomes the bar once the
> scaffolding and dependency stubs are present.

### Step 7 — Validate against the DMD corpus via the CLI shim

The end-to-end proof is the existing DMD test corpus, driven through the `djs` CLI shim
(`tests/dmd/{compilable,fail_compilation}` under the LDC source tree). The shim performs
lex→sema→CTFE and prints DMD-style diagnostics, so the existing DMD/lit runners drive
thousands of snippet files almost unchanged. A file is "done" when the corpus cases that
exercise its logic produce byte-identical diagnostics to `ldc2`. `10-tests-diagnostics.md`
owns how the shim and the corpus runner are wired.

### Step 8 — Simplify, re-test, then mark done

Per project workflow: after the file compiles and tests pass, run the code-simplifier on the
freshly-translated code, re-run `tsc` + `vitest`, and only then mark the file complete. The
simplifier must not change observable semantics — re-test confirms it didn't.

---

## 2. Verify, do not guess (the verification discipline)

When a D semantic is ambiguous, **confirm it with the local compiler** — it is the ground
truth, preferred over memory or spec prose:

```
/Users/pinver/Projects/Prefix/tools/mac_a64/ldc2-1.43.0/bin/ldc2 -run /tmp/probe.d
```

`ldc2` here is DMD v2.113.0-based, LLVM 22.1.8, on AArch64. Where the D spec and `ldc2` disagree,
**`ldc2` wins** for our port — we match the compiler we have. The most-needed probes are
already done, and their results are stated in the rule docs that apply them (struct copy
semantics in `03`, integer cast truncation, arithmetic wrap, shifts, `real` precision and integer
promotion in `09`, enum conversions in `02`, `scope` guard ordering in `06`). **Build on those — do not re-derive them.** State verified facts plainly; mark
anything you did not verify as `UNVERIFIED — confirm with ldc2`.

---

## 3. The locked decisions, in brief

These are fixed (`_ground-truth.md §1`). Do not relitigate them inside a file translation.

| # | Decision |
|---|---|
| 1 | **Target: TypeScript**, strict mode, ESM, run under Node.js. |
| 2 | **Faithful structural 1:1.** Mirror D file/class/function structure; keep identifier names verbatim; stay diff-able against upstream. Correctness + fidelity outrank idiomatic-JS elegance. *(Sole exemption: the root-runtime layer — §0.1 / `08-runtime-lib.md`.)* |
| 3 | **Frontend only.** Translate `dmd/` + `dmd/root/`. Stop after sema + CTFE — **no codegen** (no `gen/`, `ir/`, LLVM, driver glue beyond the minimal CLI shim). |
| 4 | **Hybrid numerics.** BigInt for `long`/`ulong`/`cent`/`ucent` and CTFE-exact integer math; `number` for provably-≤2^53 indices/counters and all floats. |
| 5 | **Exact diagnostic parity.** Reproduce DMD error strings verbatim so `fail_compilation` `TEST_OUTPUT` reuses unchanged. |
| 6 | **Vitest** for tests; the DMD snippet corpus driven via the CLI shim. |
| 7 | **A `djs` CLI shim** performs lex→sema→CTFE and prints DMD-style diagnostics. |
| 8 | **Excluded (initial port):** C++ header gen (`dtoh.d`). Ddoc (`doc.d`), `json.d`, ImportC (`cparse.d`, `importc.d`) and the GCC-style inline assembler (`iasm/gcc.d`) are now in scope. **Name mangling (`mangle/`) is KEPT.** |

The fixed target world (resolve `version`/`static if` against this): POSIX, 64-bit pointers,
little-endian, 64-bit `real`, compiler identity **LDC** (`version(LDC)`/`version(IN_LLVM)`
ON). Canonical ON/OFF table and rules: `07-compile-time.md` §1.2.

---

## 4. The document INDEX (consult-this-when)

Every doc in the set, with a one-line trigger. When a step above or a construct in your file
matches a trigger, open that doc. Filenames are fixed (`_ground-truth.md §7`).

### Phase-1 artifacts (already written — the inputs you consume)

| Doc | Consult this when… |
|---|---|
| `_ground-truth.md` | **Always first.** Locked decisions, verified facts, source paths, house style, fixed target world. |
| `translation-order.md` | You start a file: find its bucket, confirm dependencies, learn if it's inside the 76-module core SCC, and how excluded-module imports are stripped. |
| `FEATURES.md` | You want the full construct inventory and the authoritative cover-vs-skip list (what the guide handles vs what is out of scope). |

### Phase-2 rule docs (01–12 + cheatsheet)

| Doc | Consult this when… |
|---|---|
| `01-conventions.md` | Naming, file/module layout, identifier escaping, module-cycle handling (stub-first / `import type` / lazy `import()` / interface extraction). The "house mechanics" doc. |
| `02-types.md` | Translating `class`/`struct`/`interface`/`enum`/`alias` declarations, the visitor pattern, type aliases vs symbol aliases. |
| `03-value-semantics.md` | A `struct` is copied (assignment, by-value param, array-elem read, return-by-value), or has `this(this)`/`~this`. The `.copy()` discipline. **The silent-bug doc — read it.** |
| `04-functions.md` | Functions, methods, `delegate`/function-ptr, `this` capture, `in`/`out`/`do` contracts, attribute erasure (`nothrow`/`@nogc`/`pure`/`immutable`). |
| `05-operators.md` | Any `opXxx` operator overload — method conversion + call-site rewriting (no JS operators). |
| `06-control-flow.md` | `foreach`/`foreach_reverse`, `final switch` exhaustiveness, `with`, `scope(exit/success/failure)` → try/finally LIFO. |
| `07-compile-time.md` | `static if`/`static foreach`/`__traits`/`is(...)`/`mixin`/`typeof`/`version`/`debug` — resolve at translation time against the fixed config, with resolved-comments. |
| `08-runtime-lib.md` | `Array!T` and the rest of `dmd/root/` runtime containers/helpers (`stringtable`, `outbuffer`, `rmem`, etc.) → TS. |
| `09-numerics.md` | Any integer/float: domain choice (BigInt vs `number`), `cast(...)` truncation, arithmetic wrap, shifts, promotion, `dchar`. **The numeric-domain authority.** |
| `10-tests-diagnostics.md` | Porting `unittest` → Vitest, reproducing `error(...)` message parity, and wiring the corpus through the CLI shim. |
| `11-escalate.md` | **Anytime you're stuck or unsure.** The STOP/escalate protocol, what to write as a stub, how to flag for human decision. |
| `12-worked-examples.md` | You want a full end-to-end file translated as a model (a real `dmd/*.d` → `src/dmd/*.ts` walkthrough). |
| `13-visitor.md` | Any `Visitor`/`accept`/`ParseTimeVisitor(AST)`/visit-mixin or a `*sem` pass — rename each `visit(Node)` overload to `visitNode`, dispatch via `accept`, monomorphize the `(AST)` template. TWO idioms: grep the D module for `class .*Visitor` first (§7 census; §7.5 nested-function idiom). |
| `cheatsheet.md` | Fast one-page lookup: the most common D→TS pattern pairs at a glance, with pointers into the detailed docs. |

Not in this tree: `_probes.md` (the Phase-1 `ldc2` probe log), `_config.md` (the Phase-1 version
table) and `14-fleet-operations.md` (the operating manual of the translation fleet) were working
records of the port. Citations of them in the guide and in `src/` comments are kept as provenance:
the facts they record are stated where they are cited, and the ON/OFF table is
`07-compile-time.md` §1.2.

---

## 5. The STOP / escalate protocol (do not skip — it is the safety net)

A faithful compiler port is a domain where a plausible-looking wrong answer is the worst
outcome: it compiles, it passes the local types, and it miscompiles user programs in ways
that surface far from the cause. The discipline that prevents this is: **when in doubt,
halt.**

You MUST stop and escalate (per `11-escalate.md`) when:

- You meet a **construct this guide does not cover**, or a usage the relevant doc does not
  address.
- A D semantic is **ambiguous** and you cannot resolve it with an `ldc2` probe (or the probe
  contradicts your assumption).
- You hit a **"FLAGGED — needs a human decision"** item of `07-compile-time.md` §1 (e.g. linux-vs-macOS
  divergence, `main.d`/`mars.d` driver-glue scope, `cxxfrontend.d`/`objc.d` IN_LLVM blocks).
- An **excluded-module call site** is not a clean local strip (the branch is entangled with
  in-scope logic).
- You would have to **invent structure** (a layout, a cycle-break, a numeric-domain choice)
  not specified by a doc.

What escalation looks like (details in `11-escalate.md`): leave a STOP stub that throws with
a clear message, record the exact construct and file:line, flag it for human decision, and do
**not** proceed past it on a guess. Halting one construct is cheap; a wrong semantic baked
into the AST or CTFE interpreter is not.

> Repeat of the top-of-file rule, because it is the rule that matters most: **uncovered or
> ambiguous construct ⇒ STOP, never guess.**
