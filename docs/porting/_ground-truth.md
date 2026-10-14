# DJS Porting — Ground Truth & House Style (READ FIRST)

This file is the **authoritative anchor** for the D→TypeScript porting guide.
Every agent authoring or using the guide MUST read this first. It encodes the
locked project decisions, the verified facts, the source-of-truth paths, and the
house style for the guide documents. Do not contradict anything here; if you
believe something here is wrong, STOP and flag it — do not silently diverge.

---

## 0. The mission, and the one distinction that governs everything

We are porting the **LDC/DMD compiler *frontend*** (the D language front end:
lexer → parser → semantic analysis → CTFE) from **D** to **TypeScript**.

**We are porting the compiler, not D programs.** This distinction is the single
most important thing to keep straight:

- The **frontend's own source code** uses only a *constrained subset* of D (the
  `extern(C++)` portable subset — see §4). That subset is what the porting guide
  must teach agents to translate.
- The **D language features** that the frontend *implements* (full templates,
  CTFE, mixins evaluated on user code, etc.) are **not** something we re-design
  in JS. They come along *for free* as the faithful translation of the logic in
  `dtemplate.d`, `dinterpret.d`, `dsymbolsem.d`, etc. We translate the algorithm;
  the algorithm provides the feature.

So when this guide says "how to translate `static if`", it means: how to
translate a `static if` **that appears in the frontend's own source**, not how
to make the ported compiler evaluate `static if` in user code (that is just the
translation of the relevant `*sem.d` logic).

---

## 1. Locked decisions (do not relitigate)

1. **Target language: TypeScript.** Strict mode. Emits to JS for running under
   Node.js (ESM modules). The guide targets TS syntax.
2. **Translation philosophy: faithful structural 1:1.** Mirror D's
   file/class/function structure line-for-line. Preserve D identifier names
   verbatim (subject only to JS-reserved-word escaping, §"conventions"). The
   port must remain diff-able against future upstream DMD. Correctness and
   structural fidelity outrank idiomatic-JS elegance, always.
3. **Scope: frontend only.** Translate `dmd/` + `dmd/root/`. Pipeline stops
   after semantic analysis + CTFE — **no codegen** (no `gen/`, `ir/`, LLVM,
   `driver/` glue beyond the minimal CLI shim) — except the frontend-visible LDC
   glue that D frontend modules import: `gen/dpragma.d` → `src/gen/dpragma.ts`,
   `gen/llvmhelpers.d`'s DtoSetFuncDeclIntrinsicName → `src/gen/llvmhelpers.ts`, and
   `gen/ldctraits.d` (with gen/ldctraits.cpp) → `src/gen/ldctraits.ts`, reached through
   `dmd/hooks.d` → `src/dmd/hooks.ts`.
4. **Numerics: hybrid.** BigInt for D `long`/`ulong`/`cent`/`ucent` and for all
   CTFE / constant-folding integer arithmetic where exactness decides a compile
   outcome. `number` for indices/lengths/loop counters provably within 2^53, and
   for all floating point. See `09-numerics.md` for the decision table.
5. **Diagnostics: exact message parity.** Reproduce DMD's error strings verbatim
   (location + text) so the existing `fail_compilation` `TEST_OUTPUT` assertions
   can be reused unchanged.
6. **Test runner: Vitest.** In-source `unittest` blocks port to Vitest; the DMD
   snippet corpus is driven via the CLI shim.
7. **Corpus driving: a `djs` CLI shim** that performs lex→sema→CTFE and prints
   DMD-style diagnostics, so the existing DMD/lit runners drive the thousands of
   `tests/dmd/{compilable,fail_compilation}` files almost unchanged.
8. **Excluded modules (initial port):** C++ header gen (`dtoh.d`). Ddoc (`doc.d`), `json.d`,
   ImportC (`cparse.d`, `importc.d`) and the GCC-style inline assembler (`iasm/gcc.d`, with LDC's
   `asmSemantic` dispatch, gen/asmstmt.cpp:100) were excluded at first and are now in scope,
   translated whole. LDC's x86 asm parsers (gen/asm-x86.h) are not ported (GDC-derived): on x86_64
   djs keeps a DMD-style statement unanalysed and warns (10 §4.8); `asmSemantic` is djs's own.
   **Name mangling (`dmd/mangle/`) is KEPT** — it is required for symbol
   identity, templates, and some diagnostics.

---

## 2. Source-of-truth paths

| What                              | Path                                                                                 |
|-----------------------------------|--------------------------------------------------------------------------------------|
| LDC source root                   | `/Users/pinver/Projects/Public/ldc-1.43.0`                                             |
| D frontend (translate this)       | `/Users/pinver/Projects/Public/ldc-1.43.0/dmd`                                         |
| DMD mini-runtime (translate this) | `/Users/pinver/Projects/Public/ldc-1.43.0/dmd/root`                                    |
| Test corpus (reuse)               | `/Users/pinver/Projects/Public/ldc-1.43.0/tests/dmd/{compilable,fail_compilation,unit}` |
| `ldc2` binary (verify semantics)  | `/Users/pinver/Projects/Prefix/tools/mac_a64/ldc2-1.43.0/bin/ldc2`                     |
| Drift diffs against older tags    | `git -C /Users/pinver/Projects/Public/ldc-1.43.0 diff v1.42.0..v1.43.0 -- dmd/`         |
| Target TS project                 | `/Users/pinver/Projects/DeepGlance/djs`                                                |
| The guide (write here)            | `/Users/pinver/Projects/DeepGlance/djs/docs/porting`                                   |

**`ldc2` is DMD v2.113.0-based (LDC 1.43.0 final, LLVM 22.1.8). Use `ldc2 -run probe.d` to
verify any ambiguous semantic** — this is the ground truth, preferred over memory or spec
prose. The port pins this exact tag; source tree and oracle binary MUST stay the same
version (a diagnostics oracle from a different frontend is not an oracle).

**The source root is a full git checkout** of `github.com/ldc-developers/ldc` at tag `v1.43.0`
(`dmd/` is a plain tracked directory there, not a submodule — only `runtime/phobos` is one). Its
history is what drift checks run against: there is no second tree on disk for the old baseline.

**Guide-internal citations may be 1.42-stale.** Several rule docs still carry line numbers
measured on the 1.42 tree (e.g. the old StringExp union cite). Treat every `dmd/*.d:<line>`
in a GUIDE doc as a hint: verify against the 1.43.0-beta1 tree before leaning on the exact
line; a mechanical re-cite sweep is scheduled. Citations in the PORT'S source files follow
the rule below.

**Citation anchor:** every `dmd/<file>.d:<line>` comment in the port and in these docs
anchors to the **current baseline tree (1.43.0 final)**. Files translated before a rebase
may carry older anchors until they are next touched — whoever touches a file re-anchors the
citations in the regions they touch; wholesale re-anchoring is a mechanical rebase task, not
a per-file obligation. The D spec (https://dlang.org/spec/spec.html and its chapter pages, e.g.
`/spec/struct.html`, `/spec/operatoroverloading.html`, `/spec/version.html`)
gives the conceptual model; the local `ldc2` gives exact behavior. When they
disagree, `ldc2` wins for *our* port (we match the compiler we have).

---

## 3. Verified facts (already probed — do not re-derive, build on these)

- **`real` is 64-bit on this target.** `ldc2 -run` on the M2 Mac (AArch64)
  reports `real.sizeof == 8`, `real.mant_dig == 53` — i.e. `real == double`,
  NOT x86's 80-bit extended. JS `number` (IEEE-754 double) therefore maps
  **exactly** onto the `real`/`CTFloat` precision the local compiler uses.
  Constant folding of floats needs no extended-precision emulation.
- **Integer cast = two's-complement truncation/wrap.** `cast(long)0xFFFF_FFFF_FFFF_FFFFUL == -1`;
  `cast(int)0x1_0000_0001L == 1` (keeps low 32 bits, reinterprets sign). The
  numerics doc must encode these mask-and-sign-extend rules.
- **Frontend is the `extern(C++)` portable subset** — see §4 counts.

---

## 4. Verified feature inventory (grep counts across `dmd/*.d`)

This is the *actual* surface to cover. Counts are matching-line counts, **measured on the
1.42.0 tree** and kept as the scale inventory (order of magnitude is what they are for). A
1.43.0-beta1 re-census found every comparable construct stable within ±12% — the only real
movements are `delegate` (+12%) and the additive new `dfa/` subtree (147 → **154** `.d`
files, 204,571 → **217,893** LOC, both excl. `iasm/`). Two re-baselined facts supersede
rows below: **`unittest` blocks = 82** (pattern `^\s*unittest\b`, 33 files; the old 160 was
measured with an unreconstructible broader pattern), and the file/LOC totals above.

| Feature | Count | Porting note |
|---|---:|---|
| `extern(C++)` decls | 735 | The code is the C++-portable subset → JS-friendly. |
| `class` decls | 422 | → TS classes. Visitor pattern pervasive. |
| `struct` decls | 224 | **Value semantics** — the hard part (copy-on-assign). |
| `interface` decls | 11 | → TS interfaces/abstract classes. |
| template instantiations `X!(…)` | 506 | Mostly `Array!T`; → TS generics or monomorphize. |
| `Array!` usage | 123 | Runtime container (`root/array.d`). |
| `mixin` | 361 | Resolve at translation time (string/template mixins). |
| `static if` | 366 | Resolve at translation time against fixed config. |
| `static foreach` | 60 | Unroll / convert at translation time. |
| `__traits` | 292 | Case-by-case, mostly CT reflection → resolve. |
| `is(…)` expressions | 124 | CT type queries → resolve. |
| `typeof` | 339 | CT → resolve where possible. |
| `final switch` | 73 | → switch + exhaustiveness. |
| `with` statement | 50 | → local aliasing. |
| `foreach` | 1129 | → for-of / indexed / iterator. |
| `foreach_reverse` | 18 | → reverse iteration. |
| `alias` decls | 679 | type alias vs symbol alias — distinguish. |
| `delegate` | 201 | → closures; mind `this` capture. |
| function-ptr types | 52 | → function-typed values. |
| `nothrow` | 668 | erase. |
| `@nogc` | 357 | erase. |
| `pure` | 595 | erase. |
| `scope(...)` / scope storage | 117 | `scope(exit/success/failure)` → try/finally. |
| `version(...)` | 563 | Resolve against fixed config table. |
| `unittest` blocks | 160 | → Vitest. |
| `opXxx` operator overloads | 480 | **No JS operators** — method + rewrite call sites. |
| `~this` dtors | 33 | Usually erasable (GC); rare deterministic cleanup. |
| `enum` (manifest + named) | 608 | → TS enum / const. |
| `__gshared` | 191 | module-level mutable state; mind init order. |
| `immutable` | 266 | mostly erase (optionally `readonly`). |
| `dchar` | 119 | UTF code point (number). |
| `cast(...)` | 2773 | downcast idiom + numeric truncation; crisp rules. |
| `assert(...)` | 2428 | → runtime `assert` helper (throw). |
| contracts (`in`/`out`/`do`) | 157 | → asserts or drop. |

---

## 5. House style for the guide documents

Audience: **a translation agent** (a Claude Code subagent) translating ONE D
file to TS, looking up each construct it meets. Optimize for fast lookup and
zero-ambiguity rules.

- **Every rule is a pattern → translation pair**, with a real example pulled
  from the frontend (cite `dmd/<file>.d:<line>` so it's clickable and verifiable).
- **Prefer a table or a BEFORE/AFTER code block** over prose. D on the left,
  TS on the right.
- **State the invariant the agent must preserve**, not just the syntax. (E.g.
  "struct assignment copies; you MUST emit `.copy()` or the bug is silent.")
- **Be decisive.** Give ONE canonical translation per idiom. If two are
  acceptable, pick one and say "always use this form." Faithful ports need
  determinism across agents, not options.
- **Mark every uncertainty.** If a mapping is unverified, label it explicitly
  ("UNVERIFIED — confirm with `ldc2`") rather than asserting it. Verified facts
  are stated plainly. (This mirrors the project's verification discipline.)
- **The STOP rule, repeated in every doc's header:** if a translation agent
  meets a construct not covered here, or any ambiguity, it MUST stop and escalate
  (see `11-escalate.md`) — never guess. A wrong-but-plausible translation in a
  compiler is worse than a halt.
- **Comments in emitted TS:** when a `static if`/`version`/`mixin` is resolved at
  translation time, the emitted TS keeps a one-line comment recording what was
  resolved and why (e.g. `// resolved: version(Windows) -> false (target=posix)`),
  so the port stays auditable against upstream.
- **120-char line limit** in code examples (project rule).
- **No authorship/attribution metadata** anywhere (project rule).

---

## 6. Target configuration (the fixed world the ported compiler lives in)

The ported frontend targets a **single fixed configuration** — translation-time
resolution of `version`/`static if` assumes this world. (Confirm/extend the
exact predefined-version set during authoring of `07-compile-time.md`.)

- Host & target OS family: **POSIX** (the compiler runs under Node on macOS/Linux).
- Pointer width / `size_t`: **64-bit**.
- Endianness: **little-endian**.
- `real`: **64-bit** (see §3).
- Compiler identity: **LDC** (so `version(LDC)` is ON, `version(DigitalMars)` OFF),
  DMD frontend v2.113.0 semantics (`__VERSION__ == 2113`, verified).

Any `version(...)` referencing a DIFFERENT OS/arch (Windows, OSX-specific x87,
32-bit, big-endian, GNU/DMD-specific) resolves against this fixed world. The
canonical ON/OFF table is owned by `07-compile-time.md`.

---

## 7. Document set (filenames are fixed — write to these exact names)

```
docs/porting/
  _ground-truth.md      (this file)
  translation-order.md  (Phase-1 dependency DAG / file ordering)
  FEATURES.md           (inventory + what we cover vs skip)
  00-how-to-use.md
  01-conventions.md
  02-types.md
  03-value-semantics.md
  04-functions.md
  05-operators.md
  06-control-flow.md
  07-compile-time.md
  08-runtime-lib.md
  09-numerics.md
  10-tests-diagnostics.md
  11-escalate.md
  12-worked-examples.md
  13-visitor.md
  cheatsheet.md
```
