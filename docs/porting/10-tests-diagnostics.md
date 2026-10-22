# 10 — Tests & Diagnostic Fidelity

> STOP rule: if you meet a construct not covered here, or any ambiguity, STOP and
> escalate (see `11-escalate.md`). Never guess. A wrong-but-plausible diagnostic
> string silently breaks thousands of corpus tests — a halt is cheaper than a
> miscompile.

Read `_ground-truth.md` first. This doc is owned by the **tests + diagnostics**
slice of the port. It covers five things:

1. In-source `unittest{}` → Vitest.
2. `assert` / `enforce` runtime helpers (crash-only design).
3. DMD diagnostic **exact byte-for-byte parity** (`error`/`warning`/`deprecation`,
   `Loc` formatting, format-string translation, gagging).
4. The `djs` CLI shim contract (how the corpus is driven).
5. The `TEST_OUTPUT` block format and how the runner compares it.

Adjacent topics are owned elsewhere — cross-reference, do not duplicate:
- Numeric domains (`number` vs BigInt), `%d`/`%llu` argument values, integer
  truncation feeding a format arg → `09-numerics.md`.
- `Array!T`, `OutBuffer`, `toChars()` containers → `08-runtime-lib.md`.
- `version(unittest)` / `static if` resolution → `07-compile-time.md`.
- D `string` is a byte array, not a JS string → `02-types.md` / `_probes.md §5`.
- STOP/throw stubs for excluded modules → `11-escalate.md`.

---

## 0. The one invariant that governs this entire document

**Diagnostic output is a public, byte-exact contract.** The DMD `fail_compilation`
corpus asserts the compiler's stderr *verbatim* (after three mechanical
normalizations, §5.2). A single wrong space, a `:` where DMD prints `(`, a missing
backtick, or US-style digit grouping in a `%d` breaks the comparison. Treat every
character emitted on a diagnostic path as load-bearing.

The mechanism that makes this safe to port (crash on `assert`, restart clean) is
the project's crash-only design (`.claude/rules/crash-only-recovery.md`) — D
`assert` throwing `AssertError` maps directly onto it (§2).

---

## 1. In-source `unittest{}` → Vitest

### 1.1 File mapping convention (decisive)

**Canonical rule: one D source file → one co-located Vitest file.** For
`dmd/<name>.d`, all of its in-source `unittest{}` blocks port to
`src/dmd/<name>.test.ts`, sitting next to `src/dmd/<name>.ts`. Do **not** invent a
separate `tests/` tree for unit tests; co-location keeps the port diff-able
against upstream (a unittest moving in `<name>.d` moves in `<name>.test.ts`).

> Goal tests (`tests/goals/...`, per project CLAUDE.md) are a *different* artifact
> — they protect achievements, not translate upstream unittests. This doc is only
> about the 160 upstream `unittest{}` blocks (ground-truth §4).

Each ported file imports the symbols under test from its sibling module and wraps
each upstream `unittest{}` in one Vitest `test(...)`.

### 1.2 Block-to-`test` mapping

A bare `unittest{}` has no name in D. Number them per file in source order so the
mapping is mechanical and stable:

**BEFORE** — `dmd/errors.d:892` (real block, the `unescapeBackticks` test):
```d
unittest
{
    OutBuffer buf;
    buf.writestring("x````");
    unescapeBackticks(buf);
    assert(buf.extractSlice() == "x``");
}
```

**AFTER** — `src/dmd/errors.test.ts`:
```ts
import { describe, test, expect } from "vitest";
import { OutBuffer } from "./common/outbuffer";
import { unescapeBackticks } from "./errors";

describe("errors.d", () => {
  test("unittest#1", () => {                       // 1-based, source order
    const buf = new OutBuffer();
    buf.writestring("x````");
    unescapeBackticks(buf);
    expect(buf.extractSlice()).toBe("x``");        // D `==` on byte slices -> toBe
  });
});
```

**Invariant:** the `describe` label is the source filename; the `test` name is
`unittest#N` where N is the 1-based source-order index of the block in that file.
This makes a failing Vitest report point unambiguously at the upstream block.

### 1.3 UDA-named unittests → use the UDA as the test name

DMD's runner already names some unittests with a string UDA
(`@("name") unittest`), e.g. `dmd/root/array.d:698` and `dmd/chkformat.d:1092`.
When the upstream block carries `@("...")`, **use that string as the `test` name**
instead of `unittest#N`:

**BEFORE** — `dmd/root/array.d:698`:
```d
@("iterate over an Array") unittest
{
    auto arr = Array!int(0, 1, 2, 3);
    int[] values = [0, 1, 2, 3];
    foreach (i, v; arr) assert(v == values[i]);
}
```

**AFTER** — `src/dmd/root/array.test.ts`:
```ts
test("iterate over an Array", () => {
  const arr = Array_int.of(0, 1, 2, 3);            // Array!int -> see 08-runtime-lib.md
  const values = [0, 1, 2, 3];
  arr.forEach((v, i) => expect(v).toBe(values[i]));
});
```

### 1.4 `assert` inside a unittest → `expect`

Inside a `unittest{}` block ONLY, rewrite D `assert` to a Vitest `expect`. (In
non-test code, `assert` is the runtime helper of §2 — do **not** use `expect`
there.)

| D form (in unittest) | Vitest translation |
|---|---|
| `assert(x == y)` | `expect(x).toBe(y)` (primitives, identity) |
| `assert(byteSlice == "abc")` | `expect(byteSlice).toBe("abc")` if both are the same TS type; for D `string` (byte array) compare via the runtime-lib equality helper, see `08-runtime-lib.md` |
| `assert(cond)` (non-comparison) | `expect(cond).toBe(true)` |
| `assert(!cond)` | `expect(cond).toBe(false)` |
| `assert(x == y, "msg")` | `expect(x, "msg").toBe(y)` — Vitest takes the message as the second arg to `expect` |
| `assert(0)` / `assert(false)` (unreachable) | `expect.unreachable("...")` — should never run; if it does the test fails loudly |

**Decisive choice:** prefer `toBe` (Object.is / strict identity) over `toEqual`
for primitives and BigInt; use `toEqual` only for structural array/object
comparison. Picking one per value-kind keeps parallel agents deterministic. When
the operands are D structs (value semantics), compare via the struct's `opEquals`
(see `05-operators.md` §1, the canonical method-name table) — `toBe` on two distinct
struct objects is wrong.

**`bool` operand compared to an `int` literal.** D implicitly converts `bool`↔`int`
(`false == 0`, `true == 1`), so a unittest may compare a `bool`-returning method (e.g.
`opIndex`, or any `bool` method) against `0`/`1`. TS has no such coercion — map the int
literal to the boolean it represents when the other operand is `bool`:

```ts
// BEFORE (dmd/root/bitarray.d:161) — bool opIndex compared to int literal
assert(array[19] == 0);                              // BitArray.opIndex returns bool
array[10] = 1;
assert(array[10] == 1);

// AFTER — int literal mapped to the boolean it stands for
expect(array.opIndex(19)).toBe(false);               // 0 → false
array.opIndexAssign(true, 10);
expect(array.opIndex(10)).toBe(true);                // 1 → true
```

**Rule:** when one operand is `bool`, rewrite the int literal as the boolean it
represents (`0` → `false`, `1` → `true`); do not emit `expect(...).toBe(0)`.

### 1.5 Module-level setup

Some frontend unittests assume global tables are initialized (`Loc._init()`,
`Id.initialize()`, an `ErrorSink` plugged into `global`). When a block touches
those globals, emit a Vitest `beforeEach` (or `beforeAll` if idempotent) that runs
the same initialization the D `unittest` runner does:

**THE canonical init snippet (copy this, never re-derive the order — 01 §5.2 ORDER
CONTRACT; a wrong order silently orphans every `Id.*` singleton):**

```ts
import { beforeEach } from "vitest";
import "./parse.js";  // historical first import, not load-bearing (see below)
import { Loc } from "./location.js";
import { initTokens } from "./tokens.js";

beforeEach(() => {
  Loc._init();      // reset the location table
  initTokens();     // FIRST of the module ctors: re-creates the interning table + keywords
  // then, only if the test touches them, in this order:
  // Id.initialize();   // predefined identifiers (AFTER initTokens, never before)
  // global._init();    // ErrorSinkCompiler, fileManager
  // Type._init();      // basic types (+ any harness cache resets, 01 §5.5)
  // <port-only inits>  // LAST, and only if this harness constructs the deferred class
});
```

This snippet is the single source for harness init order; other docs and test files point
here instead of restating it.

**The sema-driver suites do NOT copy it.** The suites that call `runSemantic` (which runs
passes 0-3 and stops where main.d stops; `sema.*.test.ts`, `dsymbolsem.test.ts` and the unit
suites that analyse a parsed source) share `initSemaHarness()` from `src/sema-harness.ts`,
which runs this order and then the two things pass 0 requires: `Module._init()` and an empty
module named `object` registered in `Module.modules` (pass 0 injects an implicit `import object;`
into every module, and the suites have no druntime on disk). Add a new sema suite by calling that
helper, not by hand-copying; harnesses that init only what they touch still follow the snippet
above. The things it does NOT say out loud, each of which has cost an
agent a debug cycle:

- **Any module may be the first import.** `loadorder.test.ts` proves it for every module under
  `src/`, under vitest and under native Node ESM. The `import "./parse.js";` first line in older
  suites is not load-bearing: leave it, do not copy it. If a load-order row goes red, fix the edge
  it names (`01-conventions.md` Rule 4.4/4.8); do not add a root import to suites.
- **The DRIVER PATH is `src/dmd/main.ts` `mars_tryMain`, entered through `src/djs.ts` `djsMain`**:
  `global._init()`, the command line, ldc2's predefined versions, `printErrorContext`,
  `reconcileCommands`, main.d:436-442's inits then `initDtemplate()` last, `-I` then ldc2.conf's import
  dir, `createModules`/`read`/`parse`/passes 0-3. Suites that need an ldc2-shaped run call `djsMain` in a
  fresh registry (`dmodule.test.ts` `compile()`).
- **Identifier interning is MANDATORY for any name-comparison test**, so `initTokens()` is not
  optional there. D's `Identifier.equals` is pointer identity, so
  `new Identifier(ds("T"), TOK.identifier)` twice yields two identifiers D would never consider
  equal, and every `tp.ident.equals(t.ident)` silently answers false. Tests that compare
  identifiers intern through `Identifier.idPool`, which requires `initTokens()`.
- **`Type._init()` is not a terminator, and it is not what makes `mtype` usable.** `Type`'s
  constructor (`mtype.ts:809`) reads no `_init` table, so a class that merely `extends Type`
  needs the mtype **module evaluated** — which any ESM value import already does — and nothing
  more. `Type._init()` BUILDS THE BASIC-TYPE TABLE and is needed only when a test touches a
  basic type (`Type.tint32`, …). Conflating the two produced two wrong contract lines in one
  file.
- **A hand-built `StructDeclaration` needs both slots:**
  `sd.members = new DArray<Dsymbol|null>(); sd.symtab = new DsymbolTable();`. Any test reaching
  a builder through `search()` otherwise trips dsymbolsem's SearchVisitor struct arm
  (`dsymbolsem.ts:344`) — which also makes the test accidentally pin ANOTHER file's wall,
  forbidden by §1.8 rule 5.
- **Port-only inits go LAST, after `Type._init()`, and only in harnesses that construct the
  deferred class.** `initDtemplate()` is the first of them (a function with no D counterpart,
  existing purely to carry a `01 §4.1` lazy class) and will not be the last. Do NOT add them to
  every harness: §5.2(b) says harnesses mirror the D module-ctor order, and D has no module
  ctor for these.
- **`initSemaHarness` installs `ErrorSinkNull` as `global.errorSink`.** Code that reports through
  it (a parser built with `global.errorSink`, as iasm/gcc.d:48-49 builds one) neither prints nor
  counts errors; a suite that needs them installs `new ErrorSinkCompiler()` after the harness call.

**Invariant:** the global `Loc`/diagnostic tables are `__gshared` (process-global)
in D and are *reset between test runs by the D runner*. Vitest runs tests in one
process — without an explicit reset, location/error state leaks across tests and
produces false passes/failures. If a unittest needs globals and you cannot tell
which `_init` it relies on, STOP (`11-escalate.md`).

### 1.6 Unittests in reimplemented runtime modules — drop engine-internal tests, port contract tests

A handful of `dmd/root/` modules are **not** translated line-for-line: they are
**hand-written replacements** that re-express the D engine over a JS data structure
(`StringTable!T` and `aav` over a JS `Map`, `rmem`/`region` as no-ops — see
`08-runtime-lib.md §0`, §5, §6, §13). The `djs` runtime is the *contract* port of
`dmd/root/`, not a structural port of it (`08-runtime-lib.md` intro;
`00-how-to-use.md` decision #3 scopes the port to `dmd/` + `dmd/root/`). This makes a
special unittest rule necessary **only for those reimplemented runtime modules**.

When a runtime module is reimplemented, classify each in-source `unittest{}` block by
**what it tests**, not by where it lives:

| Upstream unittest tests… | Action |
|---|---|
| a **deleted engine internal** — a private helper that exists only to drive the D implementation and has **no counterpart** in the JS reimplementation (e.g. `nextpow2`, the hash-bucket sizing helper) | **DROP** it. Do not invent a TS test for a symbol that no longer exists. Leave a one-line comment in the `.test.ts` naming the dropped symbol and why. |
| **observable contract behavior** — insert / lookup / update results, return values, null-vs-found, iteration semantics the rest of the frontend depends on | **PORT** it to Vitest normally (§1.2–§1.5), against the reimplemented public API. The contract is identical even though the engine changed. |

**BEFORE** — `dmd/root/stringtable.d:33-39` (the `nextpow2` unittest; `nextpow2` is the
power-of-two bucket-sizing helper of the open-addressing table, `stringtable.d:25`):
```d
unittest
{
    assert(nextpow2(0) == 1);
    assert(nextpow2(0xFFFF) == (1 << 16));
    assert(nextpow2(size_t.max / 2) == size_t.max / 2 + 1);
    // note: nextpow2((1UL << 63) + 1) results in an endless loop
}
```

**AFTER** — `src/dmd/root/stringtable.test.ts` (the engine internal is gone, so the test is dropped):
```ts
// DROPPED: dmd/root/stringtable.d:33-39 — nextpow2 unittest. nextpow2 sized the D
// open-addressing buckets; the djs StringTable is reimplemented over a JS Map
// (08-runtime-lib.md §5), so the symbol and its test have no counterpart here.
```

The **contract** unittest in the same module — the one that asserts insert/lookup
results and notes iteration is hash-bucket order, not insertion order
(`stringtable.d:407`, see `08-runtime-lib.md §5`) — **is** ported: it exercises the
public `insert`/`lookup`/`update` behavior, which the reimplementation must match.

**Scope of this exemption (decisive):** dropping a unittest is allowed **only** for an
engine internal of a reimplemented runtime module (the `08-runtime-lib.md`
hand-written set). For **every other frontend unittest** — including contract tests in
those same reimplemented modules, and all unittests in line-for-line-translated `dmd/`
files — the normal rule of §1.1–§1.5 applies: port it. When unsure whether a helper is
a "deleted engine internal" or part of the observable contract, treat it as contract
(port it); if still unclear, STOP (`11-escalate.md`).

### 1.6b Files with ZERO `unittest` blocks — the COMMON case (≈2/3 of the frontend)

Only 33 of 154 files carry upstream unittests. For the rest, the co-located `.test.ts` is a
**thin fleet artifact**, not a porting obligation:

- **Canonical shape:** one module-load smoke test (importing the module executes its
  top-level, catching load-order/cycle regressions) plus behavior pins — a BUDGET HINT of
  roughly one pin per risky resolved CONSTRUCT, not a cap: a file resolving five independent
  risky constructs takes five pins (one `test()` per CONCERN, so a red gate names the right
  pin); never delete an honest green pin to fit a number; files WITH upstream unittests may
  add supplemental pins under the same per-concern rule. Pins only where constructible with
  the EXISTING harness conventions (the §1.5 init snippet).
- **Sizing, for a large file:** "roughly one pin per risky resolved CONSTRUCT" reads as either
  1 or 60 on a 4341-line file. The worked answer for one such file was **11 pins + 1 smoke
  test** — count the constructs you actually resolved by judgment, not the declarations.
- **Never** build new harness machinery for these files, and **never** fabricate pins for
  paths the harness cannot reach honestly — the corpus (§5) is the real oracle for those.
- If not even a smoke test is meaningful (pure type/data modules), a `.test.ts` may be
  omitted entirely; say so in the translation report.
- **Expected values without D unittests: a standalone `ldc2` harness.** Compile the D module
  alone, its dmd imports replaced by minimal aliases (`alias uinteger_t = ulong;`), and print
  the values the pins need; that is a valid source of the literal expected values §1.8 rule 8
  requires. Only the literal values enter the test file, never the harness. Digest or fold
  machinery (a hash over many outputs checked against a stored number) whose generator is not
  in the repo is not allowed: a reader cannot re-derive the expected value.
- A parser module with no unittests is pinned through `genhdrfile` against
  `ldc2 -o- -H --Hkeep-all-bodies` (written before semantic, main.d:668-691), not `-vcg-ast`, which is
  post-semantic. Run each case in a fresh registry (`vi.resetModules()`): `__tag<n>` (identifier.d:199)
  and `global.errors` with its error limit are process-global.

### 1.7 A ported unittest that reaches a module-private member → emit the member non-private

D `private` is **module-scoped**, not class-scoped: an in-source `unittest{}` block in
the same `.d` file can freely touch a `private` field or method (and so can a sibling
module-level function). TS has no module-level visibility — `private` there means
*class-local*, which a co-located `.test.ts` (a separate module) cannot reach. So a
faithful port of such a unittest would fail to compile if the member kept `private`.

**Decisive rule** (the module-private convention, `01-conventions.md` + this doc): if a
D-`private` member is touched by **the module's own `unittest{}`** — or by a sibling
module-level function — emit it **without** `private`, with a `// D module-private`
comment. Reserve TS `private` for members that are *truly* class-local (no unittest, no
sibling-function access). This keeps the ported unittest able to exercise the member
exactly as the D one did, without widening real encapsulation gratuitously.

**BEFORE** — `dmd/<name>.d` (a `private` helper the file's own unittest drives):
```d
private uint nbits() const { ... }       // module-private: only this file uses it

unittest
{
    auto b = BitArray(...);
    assert(b.nbits == 40);               // the unittest reaches the private member
}
```
**AFTER** — `src/dmd/<name>.ts` (member de-privatized so `<name>.test.ts` can call it):
```ts
nbits(): number { ... }                  // D module-private (touched by <name>.test.ts)
```
```ts
// src/dmd/<name>.test.ts
test("unittest#1", () => {
  const b = new BitArray(...);
  expect(b.nbits()).toBe(40);            // reachable: member is non-private in the port
});
```

**Invariant:** the trigger is *module-level reachability in D*, not the unittest alone —
if either the file's `unittest` or a sibling module-level function touches a `private`
member, drop `private` (+ comment). Only members with neither use stay TS-`private`. Do
not invent a `@ts-expect-error`/bracket-access escape hatch in the test to poke a still-
`private` member; de-privatize at the source per this rule.

**The same rule covers D-`private` FREE FUNCTIONS, which map to "not exported".** A D-private
free function is module-visible in D — its own `unittest` and its siblings call it — but a
non-exported TS function is unreachable from the co-located `.test.ts`. **Export it, with the
same `// D module-private` comment.** These are routinely a file's highest-value pins:
`opover.d`'s four private free functions (`hasOpBinary`, `stripAssignOp`, `reverseRelation`)
are hand-transcribed 13- and 14-arm `EXP` switches where one dropped case is a silent
miscompile, and they are exactly what a pin should cover.

### 1.8 Pinned-wall tests — pinning a guarded TODO-BODY honestly, and re-pinning when it MOVES

The stub-first sema build produces a third test kind besides accept/reject: a **pinned wall** —
a test asserting that a known-unported case halts at a SPECIFIC guarded `TODO-BODY` throw
(`expect(...).toThrow("TODO-BODY: ...")`). Pins keep deferred work honest: the case neither
silently passes nor fails mysteriously.

Conventions (learned the working way in Rungs 3-4b):

1. **The pinned message must cite the dmd file:line of the guarded branch.** That citation is
   what makes rule 2 checkable.
2. **Walls MOVE when fills land.** A fill that ports a guarded branch live legitimately shifts
   a *different* test file's pin to the next D branch downstream (Rung 4b: the `int x;` no-init
   pin moved from the whole-synthesis-block throw, dmd:2172, to the scalar `defaultInit` arm,
   dmd:2220). The filling agent must (a) verify the new wall is the **textually-next D branch**
   on that path — anything else is a masked regression — and (b) re-pin with a comment
   explaining the move. Never weaken the pin to a substring that matches both walls.
3. **Verifier sweep:** after a fill, grep ALL test files for the OLD wall messages the diff
   replaced — a stale pin on a renamed wall passes silently if the new message keeps the prefix.
4. **Guard placement honesty:** when a D off-path branch has NESTED conditions, the TODO throw
   belongs at the INNERMOST condition D acts on; if hoisted to the outer condition for
   simplicity, the message must name BOTH the blocked sub-case and the D fall-through it
   swallows (Rung 4b: the mixin-retry guard also walls the undefined-identifier reject path —
   its message says so). Otherwise the wall message misleads the next rung's mapper.

5. **A pin is valid only on a path D actually takes.** Before pinning a throw, prove the wall
   sits on the arm the D dispatch selects for that input: grep the D dispatch switch (or the
   visitor routing) for the node's `EXP`/`TY` tag and cite the D dispatch line in the pin
   comment. **Pinning a wall that is reached only because a dispatch arm is missing is
   forbidden** — that pin certifies a divergence as expected behavior (this shipped once: a
   rung test pinned a base-`visit` wall that D never routes to, with a wrong justification).
   Cross-ref `13-visitor.md §7.5` (Idiom-B dispatch switches are emitted in full precisely so
   walls land on real arms).

6. **A pin can go stale because the UPSTREAM DELTA deleted the D code it pinned.** Rule 2's
   verification step ("the new wall is the textually-next D branch") cannot be applied when the
   branch no longer exists: one rung test pins `visit(RealExp)` throwing into an "imaginary
   path" that 1.43 removed outright (`expressionsem.d:5404-5412` is now three statements), and
   the red looks exactly like a translation regression. **Before treating a newly-red pin as a
   regression, diff the pinned D function across the 1.42/1.43 boundary; a pin whose D
   construct no longer exists is RETIRED, not re-pointed.** The guide's warning about
   1.42-stale cites applies to the TESTS, not only to the doc text.
7. **An escalation-stub pin whose site goes LIVE is CONVERTED, not deleted.** When the old
   `expect(…).toThrow('DJS-ESCALATE: …')` fails because the body landed, the honest repair is a
   **behaviour pin** on what the now-live body produces, carrying a RE-PIN comment naming the
   escalation it replaces, and staying inside whatever harness tier the old pin lived in.
   Deleting it silently drops the coverage the escalation bought.
8. **The VACUOUS pin — a pin that cannot fail is not a pin.** One shipped example asserted
   `expect(ri.imin.value).toBe(~(0xFFFFFFFFn >> 1n))`: a verbatim copy of the production
   expression, green by construction, and it locked in a real numeric-domain divergence. **A
   behaviour pin states the value D produces — a literal, or an `ldc2`-verified constant —
   never the implementation's own expression re-evaluated. If you cannot write the expected
   value without running the port, you do not have a pin.** (§1.9 covers "tests adapt to the
   code", but not this.)
9. **When the D path crosses ANOTHER file's wall first, pin THAT message** — and name your own
   downstream wall plus the move it will make when the other file fills. **Never pin a wall you
   have not PROVEN is reached**: one such pin was caught only because it failed on first run,
   and a translator writing it without running would have shipped a green-looking lie. Where a
   fix makes a path live but an earlier statement still stops on someone else's wall, the
   sanctioned form is a **negative pin** naming only the callee the fix removed —
   `expect(...).not.toThrow(/needOpEquals/)` — which survives the other file's next move.
   **When the foreign wall carries no dmd file:line** (so rule 1 cannot hold), the pin still
   quotes the wall's message verbatim; do not invent a cite in the pin. Report the missing cite
   as a defect of the foreign wall, to be fixed by that file's owner or by the wave reconciler
   (`14 §1`); rule 3's sweep then finds the pin when the wall message changes.

**Who re-pins a MOVED pin.** Rule 2 assigns the duty to "the filling agent", but `14 §2` rule 1
gives each FILE one writer, and moved pins routinely live in **shared rung-era oracles owned by
nobody** (`sema.corpus`, `sema.expr`, `sema.assign`, `sema.rung3`, `sema.decl`, `sema.var`,
`dcast.rung1`). In that case the duty falls to the **wave reconciler** (`14 §1`), who has
tree-wide write access; the filling agent supplies the exact new wall messages in its report so
the re-pin is mechanical.

**Call-site copies are owed to WALLED callees too.** A `.copy()` the D call site performs
(`03 §1`) is emitted even when the callee is a wall: the fill inherits the copy point, and until
then the omission is inert and therefore invisible to every gate — both missed copy sites in one
audited file were arguments to walled callees.

**Goal-test traversal trap** (bit Rung 4b): post-sema, a ONE-statement function body is NOT a
`CompoundStatement` — `compoundStatementSemantic` returns `(*cs.statements)[0]` when length==1
(dmd/statementsem.d:452-456), so `fbody` IS the lone `ExpStatement`. Goal-test helpers that
walk `fbody` must handle both shapes.

### 1.9 Tests adapt to the code — NEVER the reverse (inviolable)

A test's needs never justify changing translated production code. Concretely:

- **No `assert`/diagnostic/guard may be removed or weakened in a translated body for a test's
  benefit.** If a test cannot construct the state a body requires, the test is wrong or missing
  harness support — the body is not.
- A test that needs an **invalid or half-built AST node** builds it through a clearly-named
  harness-only factory (the `IntegerExp._resetLiteralCache` pattern, `01-conventions.md §5.5`:
  documented "no D counterpart, never called by compiler code"). Never relax a constructor or
  add a permissive parameter to production code for the harness.
- D **constructor overload sets** the harness must exercise get named static factories per
  `04-functions.md §1.1(c)` — never a runtime `typeof` discriminator inside the constructor,
  and never `undefined as unknown as T` placeholder arguments (forbidden outright; they
  fabricate a value the type system then stops checking).
- **When the argument is a `Scope` the arm provably never dereferences**, the sanctioned
  spelling is the tree's `globalScope()` helper (used by `sema.var.test.ts` /
  `sema.expr.test.ts`) — not the banned cast, and not a hand-built Scope as pure ceremony.
  Building a real `Scope` remains correct whenever the arm might read it.

---

## 2. `assert` / `enforce` runtime helpers (crash-only)

### 2.1 What D `assert` does — verified

Probed with `ldc2 -run` (`/tmp/passert.d`):

```
core.exception.AssertError@/tmp/passert.d(7): x must be six   // assert(cond, "msg")
core.exception.AssertError@/tmp/passert2.d(1): Assertion failure   // assert(cond)  (no msg)
```
Both terminate with **exit code 1** and unwind the stack (it is a `Throwable`).

**Rules established:**
- `assert(cond)` with a false `cond` throws `AssertError` with text
  `Assertion failure`.
- `assert(cond, msg)` throws `AssertError` with `msg` as the text.
- `assert(0)` / `assert(false)` is the **unconditional halt** idiom (319 sites in
  the frontend, e.g. `dmd/mtype.d:430`). It marks an unreachable / internal-error
  point. `dmd/errors.d:836 halt()` is literally `assert(0)`.
- A bare developer-trace `printf(...)` immediately preceding an `assert(0)` is **dropped**
  and the halt kept — with the discriminant folded into the `assertUnreachable("...")`
  message where useful (tree precedent: dsymbol.ts for dsymbol.d:802). Owned by
  `07-compile-time.md §2.1`; noted here because the pattern recurs next to §2 halts.

### 2.2 The TS `assert` helper (decisive contract)

Provide ONE helper in `src/assert.ts` (a sibling of `src/dstring.ts` / `src/numeric.ts`,
NOT under `src/dmd/root/` — it is a hand-written helper with no single `.d` source; see
08 §0/§12). The frontend uses **bare `assert` only** — it does NOT use
`std.exception.enforce` (grep confirms: the only "enforce" tokens in `dmd/*.d` are in
comments/identifiers, e.g. `expression.d:3023 ignoreAttributes`). So `enforce` below is
the *project* convention for boundary checks (CLI shim ingress), not an upstream construct.

`AssertError` is the assertion-failure leaf of D's exception hierarchy (06 §8.3), which
`src/assert.ts` also owns: `AssertError extends DError extends DThrowable extends` JS
`Error` (siblings: `DException`, `SwitchError`). It is NOT a direct subclass of the JS
`Error`. See 08 §12 for the full hierarchy.

```ts
// src/assert.ts — see 08 §12 for the full DThrowable/DException/DError/SwitchError hierarchy
export class AssertError extends DError { /* extends DError extends DThrowable extends Error */ }

/** D `assert(cond)` / `assert(cond, msg)`. Throws AssertError on falsy cond.
 *  Crash-only: a thrown AssertError unwinds to the shim's top-level handler,
 *  which exits non-zero (see §4). Mirrors D AssertError semantics. */
export function assert(cond: unknown, msg?: string): asserts cond {
  if (!cond) throw new AssertError(msg ?? "Assertion failure");
}

/** D `assert(0)` / `assert(false)` — unconditional halt / internal error. */
export function assertUnreachable(msg = "Assertion failure"): never {
  throw new AssertError(msg);
}

/** Project boundary check (boundary-validation.md). Same throw class as `assert`. */
export function enforce(cond: unknown, msg = "enforce failed"): asserts cond {
  if (!cond) throw new AssertError(msg);
}
```

**Translation rules (in non-test code):**

| D | TS |
|---|---|
| `assert(cond);` | `assert(cond);` |
| `assert(cond, "msg");` | `assert(cond, "msg");` |
| `assert(0);` / `assert(false);` | `assertUnreachable();` |
| `assert(0, "internal error: ...");` | `assertUnreachable("internal error: ...");` |
| `enforce(cond, "msg");` (boundary check only) | `enforce(cond, "msg");` — throws `AssertError` (same throw class as `assert`); **never** a silent `return`, per `.claude/rules/boundary-validation.md` |

**Invariants:**
- `assert` is `asserts cond` so TS narrows the type afterwards (matches D, where
  code after `assert(x !is null)` may dereference `x`).
- Use the `asserts cond` type predicate, NOT a runtime `=== undefined` check — the
  point is to crash, not recover.
- Do **not** elide asserts in a "release" build of the port. The project relies on
  loud crashes (crash-only design); a silenced assert hides corruption. Reproducing what
  ldc2's release build reads past an assert it drops is governed by `11 §2.6`, not by this
  bullet.
- `AssertError` is the marker the CLI shim distinguishes from a *diagnostic* (§4):
  a diagnostic is expected program output; an `AssertError` escaping to the top
  level is an **Internal Compiler Error** and must be reported as such (the corpus
  runner explicitly fails on `Internal error:` / `core.exception.AssertError@dmd`
  in output — `d_do_test.d:1997-2000`).

### 2.3 Why `AssertError`, not plain `Error`

D's `AssertError` is distinguishable from a regular exception. The CTFE
interpreter (`dinterpret.d`) and `__traits(compiles, …)` machinery catch *normal*
errors but must let assertion failures / fatal errors through differently. Using a
dedicated `AssertError` subclass preserves the ability to do that
`instanceof`-based discrimination later. **Always throw `AssertError`** from the
helper, never a bare `Error`.

---

## 3. DMD diagnostic EXACT parity

This is the heart of the doc. The corpus reuse decision (ground-truth §1.5)
requires the ported diagnostics to be **byte-identical** to DMD's.

### 3.1 The anchor: real `ldc2` stderr (verified)

Source `/tmp/fail1.d`:
```d
void main() { int x = "hello"; }   // line 3
```

Default (`MessageStyle.digitalmars`, columns OFF):
```
/tmp/fail1.d(3): Error: cannot implicitly convert expression `"hello"` of type `string` to `int`
    int x = "hello";
            ^
```
Exit code **1**.

With `-vcolumns` (columns ON):
```
/tmp/fail1.d(3,13): Error: cannot implicitly convert expression `"hello"` of type `string` to `int`
```

With `-verror-style=gnu`:
```
/tmp/fail1.d:3: Error: cannot implicitly convert expression `"hello"` of type `string` to `int`
```

**The exact diagnostic line shape is:**
```
<location>: <header><message>\n
```
followed (in `printErrorContext` mode, the default) by the **source line** and a
**caret line**. Reproduce all of it.

### 3.2 Location formatting — `writeSourceLoc` (`dmd/location.d:196`)

Port `writeSourceLoc` faithfully. It is the single source of the location prefix.

| Condition | Output | Cite |
|---|---|---|
| `loc.filename.length == 0` | (nothing — no prefix at all) | `location.d:201` |
| filename only, `line == 0` | `<filename>` | `location.d:204` |
| `digitalmars`, no columns | `<filename>(<line>)` | `location.d:209-218` |
| `digitalmars`, columns ON & `column != 0` | `<filename>(<line>,<column>)` | `location.d:212-216` |
| `gnu`, no columns | `<filename>:<line>` | `location.d:219-227` |
| `gnu`, columns ON & `column != 0` | `<filename>:<line>:<column>` | `location.d:222-226` |
| `sarif` | (no text; JSON path, out of scope) | `location.d:228-230` |

**BEFORE** — `dmd/location.d:207`:
```d
final switch (messageStyle)
{
    case MessageStyle.digitalmars:
        buf.writeByte('(');
        buf.print(loc.line);
        if (showColumns && loc.column)
        {
            buf.writeByte(',');
            buf.print(loc.column);
        }
        buf.writeByte(')');
        break;
    case MessageStyle.gnu:
        buf.writeByte(':');
        buf.print(loc.line);
        if (showColumns && loc.column) { buf.writeByte(':'); buf.print(loc.column); }
        break;
    case MessageStyle.sarif: break;
}
```

**AFTER** — `src/dmd/location.ts`:
```ts
export function writeSourceLoc(buf: OutBuffer, loc: SourceLoc,
                               showColumns: boolean, messageStyle: MessageStyle): void {
  if (loc.filename.length === 0) return;
  buf.writestring(loc.filename);
  if (loc.line === 0) return;
  switch (messageStyle) {
    case MessageStyle.digitalmars:
      buf.writeByte("(".charCodeAt(0));
      buf.print(loc.line);
      if (showColumns && loc.column !== 0) { buf.writeByte(0x2c); buf.print(loc.column); } // ','
      buf.writeByte(")".charCodeAt(0));
      break;
    case MessageStyle.gnu:
      buf.writeByte(":".charCodeAt(0));
      buf.print(loc.line);
      if (showColumns && loc.column !== 0) { buf.writeByte(0x3a); buf.print(loc.column); } // ':'
      break;
    case MessageStyle.sarif: break; // STOP if reached: out of scope (ground-truth §1.3)
  }
}
```

**Invariants:**
- `loc.column` is the **UTF-8 code-unit (byte) column, 1-based** (`location.d:81`,
  and `_probes.md §5`: D strings are byte arrays). Do NOT compute a JS-UTF-16
  column. Column/line come from the `BaseLoc` line table (`location.d:425`).
- The default is **columns OFF** (`Loc.showColumns` defaults false) and
  **`digitalmars` style**. A test only shows `(line,col)` if it passes
  `-vcolumns` (e.g. `tests/dmd/fail_compilation/aa_init.d:2 REQUIRED_ARGS: -vcolumns`).
- `column == 0` suppresses the column even when `showColumns` is true — match the
  `&& loc.column` guard exactly.

### 3.3 The header strings — `printDiagnostic` (`dmd/errors.d:652`)

Exact header text per kind. Reproduce verbatim, including trailing spaces.

| Kind | Header (verbatim, note spaces) | Cite |
|---|---|---|
| error | `"Error: "` | `errors.d:661` |
| deprecation | `"Deprecation: "` | `errors.d:662` |
| warning | `"Warning: "` | `errors.d:663` |
| tip | `"  Tip: "` (two leading spaces) | `errors.d:664` |
| message | (none — `assert(0)`, never headered) | `errors.d:665` |
| **supplemental** (any kind) | `"       "` (7 spaces, no word) | `errors.d:656` |

**Name the no-location form: `messageNoLoc`.** D's `message` family has a location-less
overload, and the obvious rendering `message(Loc.initial, …)` **prefixes a location D does not
print** — a byte-level corpus divergence in the one diagnostic kind that carries no header to
absorb it. Port the two D overloads as `message` and `messageNoLoc` (`04 §1B`), and pick by
which one the D call site uses.

**Assembly order** (`printDiagnostic`, `errors.d:679-717`), reproduce exactly:
1. Write location via `writeSourceLoc`; if non-empty, emit `<loc>: ` (the location
   then `": "` — `errors.d:686`).
2. Emit the `header` (`errors.d:690`).
3. Emit optional prefixes `p1` then `p2` (each followed by a space) — used by a few
   call sites (`errors.d:695-704`).
4. Emit the formatted message (the `vprintf(format, ap)` result — §3.5).
5. Emit `\n` (`errors.d:717`).
6. Then (unless `simpleError` mode) emit the source-line context + caret (§3.6).

**Supplemental line shape** (e.g. the `which calls` lines in
`tests/dmd/fail_compilation/attributediagnostic.d` TEST_OUTPUT):
```
<loc>:        <message>
```
i.e. `<loc>: ` + `"       "` (7-space header) + message. Note that in the corpus
the visible indent after the colon-space is 8 columns total (`": "` consumes one
of them visually only if loc present; the literal bytes are `": "` then 7 spaces).
**Copy the byte sequence from `printDiagnostic`, do not eyeball the indent.**

### 3.4 Gagging (`global.gag` / `gaggedErrors`) — `dmd/globals.d` + `dmd/errors.d`

Gagging is how the frontend does speculative compilation (`__traits(compiles)`,
`is(typeof(...))`, `alias this` trial rewrites). It must be ported as **runtime
counters**, not resolved away — these are real control flow.

State on `global` (`globals.d:402-407`):
```
uint errors;            // total errors reported
uint gag;               // != 0 means gag (suppress) reporting
uint gaggedErrors;      // errors seen while gagged
uint deprecations; uint warnings; uint gaggedDeprecations;
```

The stack discipline (`globals.d:459-482`), port verbatim:

**BEFORE** — `dmd/globals.d:459`:
```d
extern (C++) uint startGagging() @safe {
    ++gag;
    gaggedDeprecations = 0;
    return gaggedErrors;
}
extern (C++) bool endGagging(uint oldGagged) @safe {
    bool anyErrs = (gaggedErrors != oldGagged);
    --gag;
    errors -= (gaggedErrors - oldGagged);
    gaggedErrors = oldGagged;
    return anyErrs;
}
extern (C++) void increaseErrorCount() @safe {
    if (gag) ++gaggedErrors;
    ++errors;
}
```

**AFTER** — `src/dmd/globals.ts` (methods on the `Global` class):
```ts
startGagging(): number {           // returns count to pass back to endGagging
  ++this.gag;
  this.gaggedDeprecations = 0;
  return this.gaggedErrors;
}
endGagging(oldGagged: number): boolean {
  const anyErrs = this.gaggedErrors !== oldGagged;
  --this.gag;
  this.errors -= (this.gaggedErrors - oldGagged);
  this.gaggedErrors = oldGagged;
  return anyErrs;
}
increaseErrorCount(): void {
  if (this.gag) ++this.gaggedErrors;
  ++this.errors;
}
```

The reporting decision in `vreportDiagnostic` (`errors.d:476-504`), port the
branching exactly:
- `error`: `++global.errors`. If `!global.gag` → actually print. If gagged →
  print only if `params.v.showGaggedErrors` (with the `gagged` blue color), and
  always `++global.gaggedErrors`.
- After printing an ungagged error, if `errorLimit` reached, print
  `error limit (%d) reached, use \`-verrors=0\` to show all\n` to **stderr** and
  call `fatal()` (`errors.d:489-493`).
- `warning`: only if `params.useWarnings != off`; gated by gag.
- `deprecation`: depends on `params.useDeprecated` (`error` → treat as error,
  `inform` → print, `off`-ish → drop).

**Invariants:**
- `gag`/`gaggedErrors`/`errors` are `number` (counters provably small; `09-numerics.md`).
- `startGagging`/`endGagging` are a **balanced stack** — N starts pair with N ends.
  Port them as plain methods; do NOT model with a JS array unless you also keep the
  exact `errors -= (gaggedErrors - oldGagged)` arithmetic.
- A gagged error produces **no stderr output** (unless `showGaggedErrors`). Tests
  that exercise `__traits(compiles)` rely on this silence. If your port leaks a
  gagged error to stderr, the corpus comparison fails.
- **A `.test.ts` cannot observe diagnostic TEXT through `global.errorSink`.** `error()` goes
  through `vreportDiagnosticSourceLoc` → `printDiagnostic`, which writes to **stderr**
  (`errors.ts:358-368`) — an `ErrorSink` subclass installed on `global` never sees the message
  and collects empty arrays. **The house convention for a test that must observe a diagnostic
  is `global.gag = 1` plus an assertion on `global.errors`** (worked in
  `typesem.basic.test.ts:43-45`). Diagnostic TEXT is the corpus runner's oracle (§5), not
  vitest's. A sink subclass compiles clean and collects empty arrays — the failure mode looks
  like broken pins, not a wrong observation channel.

### 3.5 Format-string translation — `dmdformat` is the one printf owner

DMD's diagnostic format strings go through C `vsnprintf` (`outbuffer.d:584`,
`vprintf`). The faithful port routes **every** printf-family rendering — diagnostic
messages, `OutBuffer.printf`/`vprintf`, and the stderr FFI of §4.4 — through **one**
runtime module: `src/dmd/root/dmdformat.ts`. There is no second formatter; call sites
keep the upstream literal `"...%s..."` strings and hand them to `dmdformat`.

**Signature (decisive):**
```ts
// src/dmd/root/dmdformat.ts — the single printf engine for the port. Bytes in, bytes out.
// fmt: a Latin-1 DString or a JS string; args are pre-converted by the call site
// (e.g. type.toChars() -> DString). Returns a DString (a Uint8Array of bytes), never a
// JS string — diagnostics are byte-exact (§0) and may carry non-ASCII. STOP (11-escalate.md)
// on any specifier not in the table below.
export function dmdformat(fmt: Uint8Array | string, args: unknown[]): Uint8Array { /* ... */ }
```
`OutBuffer.printf`/`vprintf` delegate to `dmdformat` (08 §3.5); they do not
re-implement it.

**Specifier table** — the full set `dmdformat` supports. The first group is what
real *diagnostic* format strings actually use; the remainder (octal, the integer
aliases, `%zu`, width/precision/flags) is supported because `OutBuffer.printf` and
ported C-`printf` call sites elsewhere in the frontend reach them.

| Specifier | Meaning | TS rendering |
|---|---|---|
| `%s` | `DString`/string/C-string — **almost always a `toChars()` result**; NUL-aware (stops at first NUL) | insert the bytes verbatim, up to the first NUL |
| `%.*s` | length-prefixed slice — **TWO arguments**, `(cast(int)len, ptr)` | insert up to `len` bytes; **STOPS at the first NUL inside that precision window** (verified) |
| `%d` / `%i` | signed 32-bit decimal, **no thousands separators** | `String(n)` |
| `%u` | unsigned 32-bit decimal | `String(n >>> 0)` |
| `%lld` | signed 64-bit decimal | `String(bigint)` (`09-numerics.md`) |
| `%llu` | unsigned 64-bit decimal | `String(asUintN(64, bigint))` |
| `%x` / `%X` / `%llx` | hex, lower (`x`) / upper (`X`) (32 / 64) | `n.toString(16)` (`.toUpperCase()` for `%X`) |
| `%o` / `%llo` | octal (32 / 64) | `n.toString(8)` |
| `%c` | single char (byte) | `String.fromCharCode(byte)` |
| `%zu` | `size_t` decimal | `String(n)` |
| `%%` | literal `%` | `%` |
| width / precision / flags | e.g. `%03o`, `%-10s`, `%5d`, `%08x`, `%02x` | pad/align per the flag (`padStart`/`padEnd`, fill `0` or space) |
| `%f` / `%g` / `%e` | float | **STOP-stub** — C's float conversions, a documented deferral (see below) |

Verified rendering (`/tmp/pfmt.d`):
```
symbol `foo` count 1234567               // %s, %d  (NO 1,234,567 grouping)
slice `hello world`                      // %.*s
hex ff oct 377 unsigned 18446744073709551615   // %llx lowercase, %llo octal, %llu full 64-bit
```

**Three call-site rules that keep being re-litigated:**

- **`%.*s` takes a PAIR** — the precision and the pointer are two separate arguments, so the
  ported call site passes two (`…, s.length, s`), never one slice object.
- **The `cast(int)` on that precision argument is a C-varargs width adapter, NOT a `09 §2`
  mask — drop it.** The tree already emits the bare `.length` at ten sites, and each one gets
  reported as a dropped truncation. It is not: there is no varargs promotion to adapt in TS.
- **A ported signature taking `DString` needs `ds(…)` around its string literals**, and D's
  compile-time `~` folding happens INSIDE the `ds(…)` — `ds("a" + "b")`, not
  `ds("a") + ds("b")`, which is not a `DString` operation at all.

**Two `dmdformat` gaps to know before you rely on it.** `%p` is **not implemented**, and
`dsymbolsem.d:2029` needs it. And `dmdformat` **skips the `l` / `ll` LENGTH MODIFIER**
(`root/dmdformat.ts:229-239`), so `%d` reads the bigint's own sign — whereas D hands C printf a
raw `ulong` whose bits `%lld` **reinterprets as signed**. Any D site passing a
`uinteger_t`-carried value to `%lld` needs an explicit `BigInt.asIntN(64, …)` at the call site,
or the diagnostic prints `18446744073709551488..127` where D prints `-128..127`. It is
diagnostic-only, silent, and invisible to tsc — which is why it belongs at the call site and
not in a mental note.

> **Float specifiers are a documented deferral.** `%f`/`%g`/`%e` are C `vsnprintf`'s own
> float conversions. `CTFloat.sprint` does not cover them: it is the exact float-literal text
> LDC prints (`'g'`/`'a'`/`'A'` with gen/ctfloat.cpp's `.0` and `+` fixups, 08 §15.1), which is
> what a diagnostic echoing a `real` constant uses. `dmdformat` MUST STOP (`11-escalate.md`) if
> a live diagnostic reaches `%f`/`%g`/`%e`; none in the sampled `fail_compilation` corpus do.
> Do not hand-roll a float formatter to fill the gap.

> The exotic specifiers from the grep (`%j`, `%z`, `%t`, `%lp`, `%llp`, `%K`, …)
> are **NOT** diagnostic format strings — they live in `dmd/chkformat.d`, which is
> the frontend's *implementation* of `printf`-format **checking for user code**
> (data tables / test strings). They are ported as algorithm data, never as
> diagnostic format strings. Do not build a formatter that handles them.

**The `%s` convention is the load-bearing rule:** in the frontend, `%s` arguments
are produced by `.toChars()` on AST nodes/types/symbols (`08-runtime-lib.md`),
which returns a fully-formed display string (e.g. `` `"hello"` ``, `string`,
`int`). The faithful port computes the same `toChars()` string and substitutes it.
Because `toChars()`/`extractChars()` return a **NUL-terminated** `DString` (the
trailing `0x00` is part of the buffer — 08 §9, §14.1), the `%s` and `%.*s` NUL-stop
in the table above is what trims that terminator: the formatter emits the logical
C-string (bytes before the first NUL), never the terminator. Pass the raw
`extractChars()` result straight in — do not pre-strip the NUL at the call site.

**Decisive porting form** — hand the upstream literal to `dmdformat`, NOT JS template
literals at call sites (call sites must stay diff-able with upstream `"...%s..."`
strings):

**BEFORE** — `dmd/typesem.d` (real, `.error(loc, "...%s...")`):
```d
.error(loc, "vector type `%s` is not supported on this platform", t.toChars());
```
**AFTER**:
```ts
sink.error(loc, "vector type `%s` is not supported on this platform", t.toChars());
// where sink.error does: printDiagnostic(dmdformat(fmt, args), ...)
```

**Invariants:**
- Keep the format string **byte-identical** to upstream (backticks, articles,
  punctuation, trailing/leading spaces). Translators MUST copy the literal, never
  paraphrase. The message text is the contract.
- Backticks in the message are NOT decoration — `printDiagnostic` syntax-highlights
  text inside `` `...` `` when a console is attached (`errors.d:707`), and
  `unescapeBackticks` collapses `` `` `` → `` ` `` when not (`errors.d:714`,
  `errors.d:892`). For the **non-TTY corpus path** (the shim writes to a pipe), the
  console is null, so the output keeps single backticks and only `` `` `` →
  `` ` `` collapsing applies. Port `unescapeBackticks` (`errors.d:892`) and apply
  it; do NOT port the ANSI color path for the shim (no TTY → never taken).
- `%d`/`%u` print the value with no locale grouping. If a numeric arg arrived via
  a 32-bit truncation, that truncation already happened upstream of the format —
  see `09-numerics.md`; the formatter just stringifies.

### 3.6 Source-line + caret context — `printErrorLineContext` (`dmd/errors.d:740`)

The default error mode (`printErrorContext`, `globals.d:104`) prints the offending
source line then a caret. Port `printErrorLineContext` faithfully — the corpus
includes these lines (e.g. `aa_assign.d`'s expected output is loc+message only, but
many tests *also* match the source/caret lines, and the live `ldc2` always emits
them in the default mode).

Verified output for `/tmp/fail1.d`:
```
    int x = "hello";
            ^
```

**Algorithm to preserve (`errors.d:740-792`):**
- Scan back from `offset` to the start of line (`text[s-1] != '\n'`).
- Expand tabs to the next multiple of `tabWidth = 4` **spaces** (`errors.d:754`,
  `errors.d:767-773`).
- Stop the printed line at `\r` or `\n` (`errors.d:775`).
- The caret column is the **display column** (tab- and Unicode-aware), not the byte
  column (`errors.d:759-784`) — decode UTF-8 char by char, count display columns.
- Emit the line, `\n`, `caretColumn` spaces, `^`, `\n`.

**Invariant:** tabs become 4-space stops and non-ASCII counts as one display
column — this is why the caret column ≠ the byte column reported in the location.
This routine has its own upstream unittest (`errors.d:794`) — port it and keep that
test (it asserts the exact caret placement for `int ɷ = 3;`).

The context line is **suppressed** for: out-of-bounds offset, mixin pseudo-files
(`loc.filename.startsWith(".d-mixin-")`), `simpleError` mode, and repeated
same-loc supplementals (`errors.d:721-728`). Reproduce these guards exactly.

---

## 4. The `djs` CLI shim contract

The shim is three files. `src/djs.ts` is the process entry: the port of what ldc2's C++ driver does
before `mars_tryMain` (driver/main.cpp `cppmain` and `parseCommandLine`, and cl_options.cpp's `Param`
bindings, with ldmd2's DMD-spelling translation). It plays ldc2.conf's import directory: the LDC 1.43.0 import
tree bundled in the repository, `ldc-1.43.0/import` (LDC's LICENSE beside it), or the one of the ldc2 install that
`--djs-ldc=<root>` names (§4.2). djs never runs ldc2 and reads nothing else from an install.
`src/dmd/main.ts` is main.d: `mars_tryMain`, `reconcileCommands`, `reconcileLinkRunLib`.
`src/dmd/mars.ts` is the IN_LLVM part of mars.d. Run it as
`node --stack-size=7600 <tsc emit of src>/djs.js <args>`. Imported as a module, it does nothing until
`djsMain(args)`. `src/djs.ts` is the only entry: there is no `bin/` wrapper. The oracle for the
dmd corpus is `ldmd2`: the headers spell switches the DMD way, and ldc2 rejects those spellings.
The process entry sets its stdout and stderr handles blocking, so the two streams interleave in
write order as ldc2's C stdio does (§4.4).

### 4.1 Invocation and exit codes (decisive)

The corpus runner (`d_do_test.d`) invokes the compiler roughly as (paraphrase of
`d_do_test.d:1900`):
```
djs -conf= -m64 -I<input_dir> <REQUIRED_ARGS> <permuted_args> -od<out> -c <sources...>
```
and asserts the exit code (`execute`, `d_do_test.d:1048-1064`):

| Test dir | `TestMode` | Expected exit code | Cite |
|---|---|---:|---|
| `fail_compilation/` | FAIL_COMPILE | **1** | `d_do_test.d:738`, `:1060`, `:1910` |
| `compilable/` | COMPILE | **0** | `d_do_test.d:1048` (`expectedRc=0`) |
| `runnable/` | RUN | 0 to compile (then runs binary) | out of scope (no codegen) |

**The shim's exit-code contract:**
- Any reported (ungagged) error ⇒ `global.errors > 0` at the end ⇒ exit **1**.
- No errors ⇒ exit **0**.
- An escaped `AssertError` (internal compiler error, §2) ⇒ the shim catches it at
  top level, prints `Internal error: ...` (matching DMD), and exits non-zero. The
  corpus runner explicitly fails if the output contains `Internal error:` or
  `core.exception.AssertError@dmd` (`d_do_test.d:1997-2000`) — so an ICE always
  fails the test, which is correct.
- A switch outside §4.2's list exits 2, with `djs: unsupported flag \`<flag>\` (<reason>)` on
  stderr, before the frontend runs.
- An escaped JS error of any kind prints `Internal error: ` followed by its stack, and exits 1.
- `fatal()` (`errors.d:818`) is `void`, as in D: with no handler (or one answering false) it plugs the
  sinks and exits 1; with a `fatalErrorHandler` answering true it RETURNS (`errors.d:820-821`) and the
  caller goes on with the code that follows the call. The CLI installs `throwFatalError` (errors.ts), a
  handler that never answers: it throws `FatalError`, which `djsMain` finishes (`plugErrorSinks`, return 1),
  never `process.exit`. Tests that pin a fatal stop install the same handler. A host that wants the passes
  past a fatal point passes its own handler to `djsMain` (§4.7). Every caller of `fatal()` ports what D or
  LDC's C++ does after the call; where that is undefined behaviour in C++ (an indeterminate local, the end of
  a non-void function, a null `const char *` into a `std::string`) the port stops with an `AssertError`
  carrying the C++ cite.

**Decisive:** the shim must write all diagnostics to **stderr** (DMD does:
`fprintf(stderr, ...)` throughout `printDiagnostic`), and `message`-kind text to
**stdout** (`errors.d:567-573`). The runner captures **both** stdout and stderr for
comparison (`README` "Both stderr and stdout of the DMD are captured"). Get the
stream right or the byte order differs.

### 4.2 Flags the shim must understand (minimum)

Accepted (DMD spelling → what ldc2 sets): `-c`, `-o-`, `-od`, `-of`, `-op`, `-oq`, `-I`, `-J`, `-mv=`,
`-i[=p]`, `-version=`, `-debug[=x]`, `-de/-d/-dw`, `-w/-wi`, `-v`, `-vcolumns`, `-vgc`, `-vcg-ast`
(cl_options.cpp:144, ldmd2 passes it through: writes `<srcfile>.cg` next to each root module, main.d:857),
`-D`, `-Dd<dir>`, `-Df<file>`, `-X`, `-Xf<file>` (`-Xf-`/`-Xf=-`: stdout), `-Xi=<field>` / `-Xi <field>`
(ldmd.cpp:655-668 passes them through, `-Xi` by its pass-through arm at :760; cl_options.cpp:295-317;
main.cpp:356-363 sets `ddoc.dir/name/doOutput` and `json.name/doOutput`, and the loop at :403 reports
``Error: unknown JSON field `-Xi=<field>` `` for every unknown field, then the run is fatal), `-H`, `-Hd<dir>`,
`-Hf<file>`, `-Hkeep-all-bodies` (ldmd.cpp:661-663 passes the first three through, `-inline` sets the last;
cl_options.cpp:321-333; main.cpp:366-369 sets `dihdr.dir/name/doOutput`, :569 `dihdr.fullOutput`; main.d writes
the `.di` files), `-mixin=<file>` / `-mixin <file>` (cl_options.cpp:375, ldmd.cpp:575; main.cpp:376 sets
`mixinOut`, and main.d's scope exit writes the file), `-deps` / `-deps=<file>` (cl_options.cpp:452, ValueOptional:
never the next argument; main.cpp:379 sets `moduleDeps` with a buffer, written to the file or, without one, to
stdout), `-noasm` (cl_options.cpp:254, `useInlineAsm` off), `-vtls`,
`-vtemplates[=list-instances]`, `-verrors=N|spec|simple|context`, `-verror-style=`,
`-verror-supplements=`, `-unittest`, `-release`, `-betterC`, `-allinst`, `-main`, `-ignore`, `-shared`,
`-nothrow`, `-O*`, `-inline`, `-dip25/-dip1000/-dip1008`, `-cov[=N|ctfe]`, `-profile`, `-checkaction=`,
`-edition[=NNNN[<file>]]` (main.cpp:107, ldcbindings.d:87 `parseEditionOption`; ldmd.cpp:525 makes a bare
`-edition` `-edition=`, the default edition; a bad value is `Error: Invalid argument for '-edition': <v>`),
`-check=`, `-boundscheck=`, `-noboundscheck`, `-extern-std=`, `-identifiers[-importc]=`,
`-transition=/-preview=/-revert=` (comma lists), `-P<flag>` / `-P=<flag>` / `-P <flag>` (cl_options.cpp:449
`cppSwitches`, passed through by ldmd2, ldmd.cpp:743; each value goes to the C preprocessor in order,
cpreprocessor.cpp:85).
ldc2's own spellings, which ldmd2 passes through unchanged (ldmd.cpp:760; ldc2's LLVM cl reads `--<name>` as
`-<name>`): `--checkaction=`, `--i`, `--preview=`, `--release`, `--revert=`, `--transition=`, `--unittest`,
`--vcolumns`, `--deps[=<file>]` (the same options as their one-dash forms), `-d-version=`/`--d-version=` (as
`-version=`), `-d-debug[=x]`/`--d-debug[=x]` (as `-debug[=x]`), and `-gcc=<cc>`/`-gcc <cc>`/`--gcc…` (tool.cpp:41,
the last occurrence winning): the C compiler ImportC's preprocessor runs, found on the PATH (tool.cpp:164
getCCImpl; an unknown one is `Error: cannot find program`, then fatal). Any other `--<name>` stops the run:
`--version` is LLVM's own option, not ldmd2's `-version=`. These are the spellings of yab's ldc2 lines (yab
melkor.d, adhoc.d).
djs's own switch, no ldc2 option: `--djs-ldc=<root>`, an absolute path to an ldc2 1.43.0 install laid out as LDC's
release archives (a root without `import/object.d` stops the run). The import directory is then
`<root>/bin/../import` and the config file `<root>/etc/ldc2.conf`, spelled as that ldc2 prints them; without it, the
bundled `ldc-1.43.0/import`, found in the directory above src/djs.ts's or the one above that (an emit in dist/src/),
which `-v` and `-X` report as the config file; with neither, `Error: djs: no import tree`, then fatal. The tests and
the runners that compare with ldmd2 pass it with the oracle's install.
`-mtriple=<t>` / `-mtriple <t>` for `t` one of `aarch64-linux-gnu`, `x86_64-linux-gnu` (or their `-unknown-`
spellings), or an arm64 Mac triple (`arm64-apple-darwin24.0.0`, `aarch64-apple-macos`, ...): the target of §4.8;
any other triple stops the run, and `-m64` beside `-mtriple` is ldc2's error
(main.cpp:1205), then fatal.
`-mcpu=<v>` as ldmd2 translates it (ldmd.cpp:619-634): `baseline` is dropped; `avx` and `avx2` are `-mattr=+avx` and
`-mattr=+avx2`, accumulated in order; `native` and any other value (the Lerror pass-through) set ldc2's CPU, the last
occurrence winning, an empty value meaning the triple's default. `native` is LLVM's `getHostCPUName()`: `sysctl
hw.cpufamily` on an arm64 Mac, of which only the M2 family (0xda33d83d, `apple-m2`) is modelled, with no host
features (probed); on any other host `-mcpu=native` stops the run. The resulting CPU and features make the target
machine of gen/ldctraits.ts `createTargetMachine` (targetmachine.cpp:441 with LDC's `+cx16` for `x86-64`, LLVM's CPU
lookup and feature flags): `__traits(targetCPU)` answers the CPU name, `__traits(targetHasFeature)` its feature bits,
`D_AVX`/`D_AVX2` follow them on x86_64 (main.cpp:805-808), and LLVM's warnings go to stderr before the frontend runs,
as ldc2 prints them (an unrecognised CPU name before and after the feature flags, an unrecognised feature once). The
CPUs with ldc2-probed tables: on AArch64 `generic`, `apple-m1` to `apple-m5`, `cortex-a53`, `-a72`, `-a76`, `-a78ae`;
on x86_64 `x86-64`, `x86-64-v2`, `-v3`, `-v4`; and, as names that backend does not recognise, the other arch's
(`-mcpu=native` under x86_64-linux-gnu is `apple-m2`, unrecognised there). Any other CPU name stops the run, since
LLVM recognises names its `-mcpu=help` list omits (`apple-latest`); `-mcpu=help`, `?` and `h` stop it too.
Accepted without effect: `-m64` (without `-mtriple`), `-fPIC`, `-lowmem`, `-quiet`, `-mcpu=baseline`, `-L*`,
`-defaultlib=`, `-debuglib=`, `-disable-linker-strip-dead`, `-g/-gc/-gf/-gs`, `-color=off`, `-conf=`, `-nogc`
(gen/runtime.cpp:45, read only while generating code, which the shim never does).
Every other switch stops the run (§4.1), among them the C++ headers (`-HC`, `-HCd`, `-HCf`: dtoh.d), `-makedeps`,
`-lib` and `-m32`. `-I`, `-J`, `-od`, `-of`, `-Dd`, `-Df`, `-Xf`, `-Xi`, `-Hd`, `-Hf` and `-mixin` with nothing
attached take the next argument, as LLVM does. An empty `-od=`/`-of=`/`-Dd=`/`-Df=`/`-Xf=`/`-Hd=`/`-Hf=`/`-mixin=`
is `Error: Expected argument to '-<name>'` (cl_helpers.cpp `fromPathString`), in main.cpp's order; an empty
`-deps=` is a `-deps` to stdout. `-D=<bool>`, `-X=<bool>` and `-Xi<field>` (an unknown argument to ldc2) stop the
run. The last `-O<level>` wins, and `-O0` leaves `D_Optimized` off. A response file (`@file`) stops the run.

### 4.3 Diagnostic plumbing in the shim

Install `ErrorSinkCompiler` (the verbatim port of `errors.d:57`) as
`global.errorSink`. It routes `verror`/`vwarning`/`vdeprecation`/`vmessage` into
`vreportDiagnostic` (§3.4) → `printDiagnostic` (§3.3). Do **not** use the simpler
`ErrorSinkStderr` (`errorsink.d:142`) for the shim — its format differs
(`"Error: "` printed *before* the location, `errorsink.d:153-157`) and would break
parity. `ErrorSinkStderr`/`ErrorSinkNull`/`ErrorSinkLatch` are still ported (used
internally, e.g. gagged speculative paths use the null sink).

### 4.4 Raw stderr FFI — `fputs` / `fprintf(stderr, …)` / `vfprintf`

A handful of frontend paths bypass the diagnostic sinks and write **directly** to
`stderr` via C stdio — the error-limit message (`errors.d:489-493`,
`fprintf(stderr, ...)`), `ErrorSinkStderr` (`errorsink.d:153-157`), and a few
`fputs(..., stderr)` sites. These are *not* `printDiagnostic` paths and do not flow
through `vreportDiagnostic`; they are bare C output. Port them with **one** rule:

**Pattern → translation.** Assemble the complete message via `dmdformat` (§3.5),
then emit it with a **single** `process.stderr.write(dsToJs(msg))`. One format, one
write — never a `process.stderr.write` per fragment, and never a JS template literal
(the format string must stay the upstream literal, diff-able).

| D call | TS |
|---|---|
| `fputs(s, stderr);` (already-formatted C string) | `process.stderr.write(dsToJs(cstr(s)));` — `s` is a NUL-terminated `DString`; `cstr` trims at the first NUL (02 §11) |
| `fprintf(stderr, fmt, args…);` | `process.stderr.write(dsToJs(dmdformat(fmt, [args…])));` |
| `vfprintf(stderr, fmt, ap);` | `process.stderr.write(dsToJs(dmdformat(fmt, ap)));` — `ap` is the already-collected arg list |

**BEFORE** — `dmd/errors.d:489` (the error-limit message; `fmt` is the upstream literal):
```d
fprintf(stderr, "error limit (%d) reached, use `-verrors=0` to show all\n", errorLimit);
```
**AFTER** — `src/dmd/errors.ts`:
```ts
process.stderr.write(dsToJs(dmdformat("error limit (%d) reached, use `-verrors=0` to show all\n",
                                      [errorLimit])));
```

**Invariants:**
- `dmdformat` returns a `DString` (bytes); `dsToJs` decodes them as UTF-8 (`src/dstring.ts`,
  `new TextDecoder()`) and Node re-encodes the string as UTF-8, with no `String(...)`
  interpolation in between. For valid UTF-8 the bytes on stderr are exactly what `vsnprintf`
  would have produced. They are NOT for invalid or truncated UTF-8 (a raw 0xE9, a multibyte
  sequence cut by `%.*s`), which becomes U+FFFD, or a leading BOM, which the decoder drops.
  Byte-exact output for those cases needs `process.stderr.write(bytes)` with the `Uint8Array`;
  the shim decides when it is built.
- This is the *only* place the shim talks to `stderr` outside `printDiagnostic`;
  both ultimately go to the same stream, so ordering with sink diagnostics is the
  natural write order. Keep these writes synchronous (no buffering) so they
  interleave with `printDiagnostic` output exactly as DMD's `fprintf` does.
- `fputs` carries no format — still route the (NUL-trimmed) bytes through one
  `process.stderr.write`; do not add a spurious `\n` (the source already includes
  any terminator).
- LLVM `raw_ostream` output ported with its C++ body (`errs() << …`, e.g. gen/ldctraits.ts's
  unrecognised-feature line) is not C stdio: it writes each `StringRef` whole (embedded NULs,
  invalid UTF-8, a leading BOM). Assemble it by byte concatenation (`dsConcat`) and write the
  `Uint8Array` in one `process.stderr.write`, with no `dmdformat` and no `dsToJs`. A test spy on
  `process.stderr.write` must accept `Uint8Array` chunks as well as strings.
- A D `scope (failure)` or `scope (exit)` that the port turns into `catch`/`finally` lets
  `FatalError` through untouched: D's `fatal()` exits without unwinding (errors.d:825), so D never
  runs that scope on it. Precedents: main.ts `mars_tryMain`, dfa/entry.ts `fastDFA` (whose ICE line
  prints for internal errors only).

---

### 4.5 The corpus runner

`tests/corpus/run.ts` builds d_do_test's command for each test (d_do_test.d:1900; header parsing as
:263/:496/:611) and runs the shim and ldmd2 from a temporary copy of the git-tracked files of tests/dmd,
never from the clone: each compiler runs each test in its own working directory of symlinks into the copy,
with its own `${RESULTS_DIR}`, both removed after the test. Each compiler's stdout and stderr go to
one file, never a pipe. Departures from d_do_test: no `-conf=`; no environment REQUIRED_ARGS; only
the no-permutation run and the first ARG_SET; `-c -o-` for every test; COMPILE_SEPARATELY skipped;
`.c` and `.i` tests measured as `.d` tests, with d_do_test's LDC `-defaultlib=` suffix
(d_do_test.d:741-751), both compilers running the system C preprocessor; TEST_OUTPUT not checked; the files the two compilers write (under `${RESULTS_DIR}` and in the working
directory) are compared with each other. Classes: MATCH / MATCH-LOWMEM / MISMATCH-EXIT / MISMATCH-OUTPUT /
MISMATCH-CG / MISMATCH-FILE / CRASH (`Internal error:`, an uncaught Node error, a signal, or an exit status
other than 0/1/2) / UNSUPPORTED-FLAG / TIMEOUT (confirmed by a re-run alone) / SKIP-*. Output is compared
after normalizing paths, a leading compiler name and ldc2's `GC stats` line. MATCH-LOWMEM is the
declared divergence of `08 §13` (CTFE with the GC on): a test listed in the runner's `LOWMEM_TESTS`
(today runnable/xtest46.d) that differs from ldmd2 and matches `ldmd2 -lowmem`. A test whose arguments
carry `-vcg-ast` makes both compilers write `<test>.d.cg` next to the source: the runner takes each
compiler's file out of the test tree after its run and compares the two (MISMATCH-CG: same exit and
text, different `.cg`, a file written by one compiler only included). MISMATCH-FILE: same exit and text,
different written files (a file written by one compiler only included), compared after removing what
ddocAny-postscript.sh removes from a `.html` file and the `cwd`/`argv0` values from any other; the summary
buckets it by the file's extension. The runner refuses a tree that does not type-check and records HEAD
and the dirty paths. It writes a JSON file and a summary to the path given, and commits nothing.
`--in-process` runs each lane's tests through one long-lived Node child calling `djsMain` per test
(§4.7), over IPC, `chdir` into the test's directory; the child's `write` taps go synchronously to its fd 1,
the lane's file that is also its fd 2, so what `cc` writes keeps its place in the test's output, and a
timeout or crash replaces the child. The classes are the same. `--in-process --keep` makes the child call
`djsMainKept` (the kept-module engine, §4.7) instead, and the lanes take the tests grouped by their switches, so
that most compiles follow one with the same command line: each record carries the compile's mode and, when it was
fresh, the reason, and the summary opens with the number of kept compiles, the fresh ones by reason, the kept
compiles that are not MATCH, and the compiles that left no record (a child that died or was replaced on a timeout,
whichever mode it was in). `--recompile` (with `--keep`) then compiles each test a second time in the same child,
from the same directory and on unchanged files, as an editor's re-save of an unchanged file does: the second
compile's exit status and text must be the first's, byte for byte; the record carries the comparison and the
second compile's mode, and the summary counts the second compiles, the kept ones, and lists every test where the two
differ, kept or fresh. `--editor` (with `--in-process`) makes the child call as djs-vscode's worker does: a fatal
handler answering true (editor mode, §4.7) and the doc-comment knob on; past a test's first error the output has no
oracle (the editor analyses on where the CLI skips, and runs past the fatal points), so such a test is a MISMATCH by
construction, and the switch serves `--recompile`, whose comparison is between the child's own two compiles.
`--mtriple <t>` measures a target of §4.8: both compilers get `-mtriple=<t>` where d_do_test puts `-m64`, and the
headers are read as a native run on that target.

### 4.6 The Phobos runner

`tests/phobos/run.ts` compiles every module of ldc2's shipped import tree (object.d, core/, std/,
etc/, ldc/; `.d`, `.di` and the C header importc.h, through ImportC; ldc/opencl.di, and any module under a directory
whose name starts with `ldc/dcompute`, is SKIP-DCOMPUTE, since DCompute semantic (gen/semantic.d:20) is not
ported, and the summary's Notes section gives one line per skip class) as a root module with
`-c -o- -vcg-ast`, through
the shim and ldmd2 with identical arguments, from a temporary copy of the tree under `$TMPDIR` (the
`.cg` files are written next to the sources), deleted when the run ends. `--unittest --flags "..."`
adds `-unittest` and LDC's runtime unittest flags (runtime/CMakeLists.txt:36/:51/:53). It classifies as
§4.5 does, MISMATCH-CG included (the `.cg` texts normalized for paths only). Every run goes through
`/usr/bin/time -l`: records keep wall seconds and peak RSS per compiler, and the summary gives median,
p90 and max per compiler and the shim/ldmd2 ratio. Under `--unittest`, the modules of the runner's
`NO_VCG_UNITTEST` table (std/traits.d, std/meta.d) are compiled without `-vcg-ast`, since ldc2 itself never
finishes their `.cg` dump; only exit status and diagnostics are compared, and the summary's Notes give each one a
line with the ldc2 cause. `--probe-program` times a one-file program
importing std.stdio, std.algorithm and std.range; `--sequence <entry,...>` (repeatable, one child process
per list) calls `djsMain` for each entry in one process and compares every call with a fresh process
(exit, merged output, `.cg`); an entry `path=file` copies `file` over `path` first, so one path can alternate
clean and broken text, and a list may not name a path both bare and installed. Its table gives ms, RSS and
heap after GC per call, then `cold call 1: X ms; calls 2-N: median Y ms, p90 Z ms` (nearest rank: with fewer
than 10 calls after the first, p90 is the slowest of them). With `--keep` (only with `--sequence`) the child calls
`djsMainKept` (§4.7) and the calls and their fresh references drop `-vcg-ast`, which the engine refuses: each call
is compared on exit status and merged output, and the table adds its mode and, when fresh, the reason. Timings are
usable only at load under 4 (`uptime` before each list). An edit list for an in-process probe includes an edit after
a parse error, a line removed then restored, an import added then removed, and a gagged, clean, ungagged library
error: those are the sequences where reuse of state goes wrong. It records HEAD and the dirty paths, writes a JSON
file and a summary, and commits nothing.

### 4.7 The in-process host contract

`djsMain` may be called any number of times in one process: each call starts with
`deinitializeFrontend` (src/djs.ts), which runs the D deinitialize/reset methods of the 1.43.0 tree
(upstream frontend.d `deinitializeDMD` is their caller, not in LDC's tree), then resets every
`__gshared` slot and module-level port state no D method covers; module-private state through a reset
function of its owning module, public statics inline. State refilled on every call stays with the code that
refills it: the identifier table (`initTokens`), the Loc file table (`Loc._init`), the C preprocessor's
switches and tool caches (`configureCPreprocessor` in `cppmain`). A call compiles byte-identically to a
fresh process (exit, output, written files); the proofs are `--sequence` (§4.6), `--in-process` (§4.5) and
the "called again" test in src/djs.test.ts. A new `__gshared` or module-level mutable slot ported later
needs a reset there: the test catches only the slots its calls exercise. The last compile's AST stays reachable
until the next call.

**Editor mode.** `djsMain(args, onFatal)` installs `onFatal` as the `fatalErrorHandler` for that call; the
default is the CLI's `throwFatalError` (§4.1). A host that passes a handler answering true (`() => true`, or one
that counts the calls) gets D's behaviour: every `fatal()` returns and the driver runs the next pass, except past
a failed ImportC file (below), so a module with parse errors, a failed import or a semantic2 stop still reaches
semantic3 (the 15 recovery modules of src/djs.test.ts: root module at `semantic3done`, the declarations after the
defect analysed). The host's contract:
- **The status is 0 with errors.** A compile that reaches the end of `mars_tryMain` returns EXIT_SUCCESS
  (`main.d:930`, after the `fatal()` on `global.errors` returns). The host reads `global.errors` and
  `global.warnings` (dmd/globals.ts), never the status; status 1 still means an escaped error (`Internal
  error:`), a handler that threw `FatalError`, or a failed ImportC file (below).
- **The output up to the first error is ldc2's; what follows has no oracle.** An error reported to the editor does not
  switch analysis off elsewhere. The frontend tests that skip analysis or a report when any error was reported (`if
  (global.errors)`: `needCopyOrMoveCtor`, `clone.d:1688`, also reached by `isPOD`, `dsymbolsem.d:1696`; the deferred
  semantic2 and semantic3 loops, `dsymbolsem.d:819`, `:837`; `templatesem.d:3001` under gag; `typesem.d:4405`) read in
  editor mode only the gagged errors of the gag windows open now (dmd/errors.ts `analysisSeesErrors`, over djs's
  `Global.windowErrors`, which `endGagging` restores and which, unlike D's `gaggedErrors`, an instance with errors
  matched ungagged does not raise, `templatesem.d:1021-1022`), as a compile without the errors reported to the editor
  does; the CLI reads `global.errors`, as ldc2. In a compile without ungagged errors the two readings are equal, so the
  outputs agree up to the first error; past it the editor analyses what ldc2 skips: after a parse error in the root a
  library struct still gets its copy constructor, with its postblit's deprecation and its errors, `__traits(isPOD)` and
  `__traits(hasCopyConstructor)` answer as without the error, the end-of-compile semantic2/semantic3 lists are analysed
  whole (a cost where they are long: corpus fail12255.d, fresh, about 5x the CLI reading's time), an independent
  `__traits` that gives no type is reported (corpus e7804_2.d: its second line). `templatesem.d:3001` at gag level 0
  keeps D's reading: there a parentless symbol is the trace of an error and the report would be its cascade (corpus
  fail86.d). A struct whose `__ctor` chain holds a symbol that is neither a constructor nor a template (first,
  `searchCtor`'s "`__ctor` is not allowed", `expressionsem.d:19610`; after a constructor, where the search asserts)
  looks for no copy constructor (clone.ts `ctorChainHoldsOther`). Past the fatal points djs also prints diagnostics ldc2
  never reaches, and some repeat: a failed import is reported once by the import's importAll and again by its semantic
  (`dsymbolsem.d:8348`, `:3498`), "unable to read module" twice; past the error limit every error prints and is followed
  by the `error limit (N) reached` line again (`errors.d:489-492`), so a host passes `-verrors=0`. Tests pin such text
  only as djs's own, never as oracle output (§1.9, §5.4). The mode is the handler's: any handler but the CLI's
  `throwFatalError` (none is the tests' harness, read as the CLI) is editor mode from the compile's start, before any
  `fatal()`.
- **Pass `-o-`.** Past a fatal point an object file would reach the codegen wall (`Internal error`).
- **A failed ImportC file stops as the CLI does**: an imported `.c`/`.h` or one on the command line gives status
  1 and the CLI's output. Its first `fatal()` (`driver/cpreprocessor.cpp:22`, `:42`, `:167`, `driver/tool.cpp:133`,
  `:155`) ends the compile in editor mode too (cpreprocessor.ts `stopAtFatal`).
- **Known non-returns.** The diagnostics up to the stop are printed; the list holds both kinds, and each entry
  has a probe:
  - LDC continuations that are undefined behaviour in C++, or that run past a D `assert` or `in` contract which
    LDC's release build compiles out (`-release`, CMakeLists.txt:131), stop with an `AssertError` (`Internal
    error`, status 1): the crt priority of `pragma(crt_constructor, <non-integer>)`, an `LDC_intrinsic` template
    argument that is neither integral nor floating. An anonymous enum member with a type and no initializer
    (`int x y`, fail_compilation/fail10285.d): `parse.d:3279-3282` gives it a null value, and `enumsem.d:406`
    asserts one; the release build takes the auto-increment branch (`enumsem.d:531`) and gives it the previous
    member's value plus 1. A `foreach` parameter with a type and no name (`foreach (char; bug)`, `foreach (uint in;
    [])`; fail22.d, test21062.d): `parse.d:5695` reports and keeps the null name, and `statementsem.d:1103`
    constructs the value's `VarDeclaration` with it against the `in { assert(ident); }` at `declaration.d:492`;
    the release build makes a variable without a name, which `DeclarationExp`'s semantic does not insert in a
    symbol table (`expressionsem.d:8678`). A C `__declspec(align(N))` with N not a power of 2 (test23789.c):
    `cparse.d:3416-3417` keeps N as a pack alignment after its error, and `alignmember` asserts a power of 2
    (`aggregate.d:254`); the release build rounds the field's offset with a mask that is not one. The corpus test
    named is the entry's probe.
  - Crashes faithful to LDC, which segfaults at the same points (`Internal error`, status 1): a root file that
    cannot be read: the `fatal()` at `dmodule.d:668` returns, parse returns null at `dmodule.d:751`, and importAll
    reads the null `members` at `dsymbolsem.d:8405`. `pragma(LDC_intrinsic, <not a string>)` takes `strlen` of a
    null name (`gen/pragma.cpp:141`). An `LDC_inline_ir` template without exactly one member dereferences a null
    `onemember` (`gen/inlineir.cpp:63`). A template recursion past `global.recursionLimit` reports and recurses
    again until the stack overflows. A C `goto *p` (fail_compilation/compgoto.i): `cparse.d:660` leaves the label
    null, and `fixupLabelName` calls its `toString` (`statementsem.d:103`, from `:3636`). A `static if` without a
    condition (ice18803b.d): `parse.d:2489` makes the condition null, and `evalStaticCondition` reads its `op`
    through `isNotExp` (`expressionsem.d:18446`). A `typeid` without `object.TypeInfo` (no_TypeInfo.d): the
    `fatal()` at `typinf.d:68` returns, and the `TypeInfoDeclaration` constructor reads the null
    `Type.dtypeinfo` (`declaration.d:778`). A constructor with parameters declared `static` (parseStc5.d): the
    parser reports it (`parse.d:2557`) and keeps `static`, `isThis()` answers null for a static function
    (`func.d:679`), and `funcsem.d:645` calls `handleType` on it. The corpus test named is the entry's probe.
  - An `LDC_intrinsic` name with a `#` not preceded by the instance's `i`/`f` prefix (a wrong letter, another
    character, or the start of the name) loops without end, as LDC's `DtoOverloadedIntrinsicName` does past a
    returning `fatal()` (`gen/llvmhelpers.cpp:1269-1285`: both error branches retry the same `#`).
- **The handler answers true or throws `FatalError`.** A handler answering false gives D's exit path
  (`errors.d:823-825`): `process.exit(1)` ends the host process.

**The host-visible surface and its upgrade notes.** What an in-process host reads in the compiler; djs-vscode
(`host/worker.ts`) uses exactly this, and a change to any item is a change to the host. On a merge or a re-baseline,
check each item and add a line under its baseline below; `npx tsc -p host/tsconfig.json` in djs-vscode fails where a
field it uses changed.
- `djsMain(args, onFatal, options)` (src/djs.ts) and the editor-mode contract above; `FatalErrorHandler`
  (dmd/errors.ts); `DjsOptions`: the doc-comment knob ("Queries" below) and `texts`, the text override (below).
- `djsMainKept(args, onFatal, options)`, `KeptCompile`, `dropKeptState()` (src/djs.ts; the kept-module engine below).
- `queryHover`, `queryDefinition`, `querySemanticTokens`, `queryInlayHints`, `queryInactiveRanges`, `STALE_REASON`,
  `INACTIVE_REASON`, the legend `SEMANTIC_TOKEN_TYPES` and `SEMANTIC_TOKEN_MODIFIERS`, and their answer types
  (src/query.ts, exported by src/djs.ts; "Queries" below).
- `queryAst(file, text)` and `AstAnswer`, `AstResult`, `AstEntry`, `DeclarationSite`: the AST view ("Queries" below),
  which reads the engine's record of generated identifiers (src/keep.ts `keepGeneratedNames`).
- `queryInstances(files)` and `InstancesAnswer`, `InstancesResult`, `TemplateInstances`, `InstanceSite`.
- `queryImports()` and `ImportsAnswer`, `ImportsResult`, `ImportModule`.
- `queryCompletion(file, text, position)` and `CompletionAnswer`, `CompletionResult`, `CompletionItem`,
  `CompletionKind`, `CompletionGroup`: the names after a `.`, and in scope where no `.` precedes ("Queries" below).
- `queryDocumentSymbols(file, text)` and `DocumentSymbolsAnswer`, `DocumentSymbolsResult`, `DocumentSymbol`,
  `SymbolKindName`: the outline ("Queries" below).
- `queryReferences(file, line, character, text)` and `ReferencesAnswer`, `ReferencesResult`, `ReferenceSite`.
- `queryPrepareRename(file, line, character, text)`, `queryRename(file, line, character, text, newName)` and
  `PrepareRenameAnswer`, `PrepareRenameResult`, `RenameAnswer`, `RenameResult`.
- `querySignatureHelp(file, line, character, text)` and `SignatureHelpAnswer`, `SignatureHelpResult`,
  `SignatureInformation`.
- `queryUnused()` and `UnusedAnswer`, `UnusedResult`, `UnusedDeclaration`, `UnusedKind`, `UnusedWhy`: the
  declarations the program's entry cannot reach ("Queries" below).
- `setDiagnosticHandler` and the `DiagnosticHandler` signature (dmd/errors.ts, `errors.d:401-408`): called by
  `printDiagnostic` with the header `Error: `, `Warning: `, `Deprecation: `, `  Tip: `, or seven spaces for a
  supplemental line; answering true suppresses the print and the source-line context. The handler is not reset by
  `deinitializeFrontend`: it is installed once per process.
- The message text as `printDiagnostic` builds it: `OutBuffer.writestring`, `OutBuffer.vprintf`, `peekChars`,
  `unescapeBackticks` (dmd/errors.ts), `cstr`/`ds`/`dsToJs` (src/dstring.ts).
- `SourceLoc.filename`, `line`, `column` (UTF-8 byte column from 1), `fileOffset`, `fileContent` (dmd/location.ts).
- `global.errors`, `global.warnings` (dmd/globals.ts), read after the call.
- The flag table of §4.2, in particular ldc2's own spellings that yab's lines use, and the targets of §4.8.
- The import tree: the bundled `ldc-1.43.0/import`, found above the module holding `djsMain` (src/ or dist/src/), so a
  host that ships djs keeps that layout, or passes `--djs-ldc=<root>` (§4.2).

Changes per baseline:
- LDC 1.43.0: the surface as listed (the first baseline of djs-vscode). Then, within the baseline: a failed ImportC
  file stops the compile in editor mode too (status 1, the CLI's output), where it used to run on; the queries and
  `DjsOptions` (a third parameter of `djsMain` and `djsMainKept`, default off); the semantic-tokens query and its
  legend (djs-vscode's `semanticTokens` request); the inlay-hints and inactive-ranges queries (its `inlayHints` and
  `inactiveRanges` requests); the AST view, the template instances and the imports queries (its AST view and
  explorers); the text override `DjsOptions.texts` and the completion query (its compile on pause and its
  `completion` request); the import tree bundled with djs in place of the Prefix install's, and `--djs-ldc=<root>`
  (the extension's `djs.ldcRoot`); the host's triple from Node's platform and arch, with an unsupported host refused
  without `-mtriple`, and the arm64 Mac accepted as a `-mtriple` (§4.8; the extension's `djs.target`); the completion
  without a dot (the same `completion` request answers with the names in scope, `CompletionItem.group` 3 added); editor
  mode's analysis past the first error (the tests of the error count read gagged errors only, `analysisSeesErrors`:
  the output past the first error is no longer the CLI's continued); the hover, the definition, the signature help, the
  references and the rename miss in an inactive branch with `INACTIVE_REASON` (the extension shows nothing there; a
  rename's refusal shows its reason); the completion items' order in a group, by label ignoring case and a name with a
  leading `_` last (the extension keeps djs's order: its `sortText` is the item's index).

**The text override.** `DjsOptions.texts` (src/djs.ts), a map from absolute path to a D source's text (an editor's
buffer, no byte order mark), replaces those files' contents for one call of `djsMain` or `djsMainKept`: a module whose
source file is a key's file is read from the text (`Module.read`, dmodule.ts, through `Module.djsTextOf`; the bytes
UTF-8 with the four zero bytes past the end that `FileManager.getFileContents` leaves), the root and the modules `-i`
and the import paths reach alike. Keys and source paths are compared by their real paths, resolved against the working
directory with symbolic links followed (`/tmp/a.d` and `/private/tmp/a.d` are one file; one `realpath` per path and
call). Module resolution is the file system's (the file must exist: `FileName.exists`, the kept engine's record; a key
whose file does not exist is ignored), string imports (`-J`) and C files (`.c`, `.h`, `.i`, whose text is the
preprocessor's) are never overridden, a key that is not absolute throws. The table is set by src/djs.ts for the
call and emptied at its end and by `deinitializeFrontend`, so a call without texts reads the disk. Not part of the kept
state's key: a compile from a buffer and one from the disk with the same flags share the kept state (the kept engine
below, "Invalidation"). The proofs: src/keep.test.ts (each compile against `djsMain` with the same texts: the
override's errors and the handler's calls, override then the saved file with the same bytes kept, another override
analysed again, a call without texts reading the disk, a key and a command line spelled through a symbolic link, a kept
imported module overridden and then read from disk).

#### The kept-module engine

`djsMainKept(args, onFatal)` (src/djs.ts) compiles as `djsMain(args, onFatal)` does and keeps what the compile
parsed and analysed for the next call: the next call with the same command line (the root source files excepted;
under `-o-` also `-od`/`-of`/`-op`/`-oq`, which reach no diagnostic) re-analyses only what changed and replays the
rest. It returns `KeptCompile`: `status` (as `djsMain`'s), `mode` (`"kept"` or `"fresh"`), `reason` (why fresh), and
`stats` of the compile that produced the output (units replayed and run, modules and instances kept and dropped,
what started the dead set, wall milliseconds, RSS after the call; after an abort, the fresh compile's counts with
the plan's `planMs` and `seeds`). `djsMain` never keeps and drops what `djsMainKept` kept; `dropKeptState()` drops it
too and resets the frontend's statics, so its memory can be collected at once. In a kept compile the diagnostic
handler is called when the compile ends, in order, with copies of its arguments (the output is buffered so that an
abort can discard it); `onFatal` is called where the fatal stop is, unbuffered, and again by the fresh compile that
follows an abort. The engine is src/keep.ts (its header is the design; the one entry is `keepCompile`, given the
driver's part of a compile by src/djs.ts). The hooks in dmd/ files are marked "the kept-module engine" and guarded
by `K.on`, false outside `djsMainKept`; besides one-line calls they are the creation-path changes in templatesem.ts
(`keptCreate`, `keptInstanceMatch`, the hoisted `InstMemberWalker`, the extracted `deferSemantic3`), the six table
inits main.ts skips in a kept compile, `Identifier.purgeLocCounters`, `TemplateInstanceTable.keepRemove`,
`purgeLocFiles`, cpreprocessor.ts's `lastRun`, set on every preprocessor run, and typinf.ts's
`getTypeInfoAssocArrayDeclaration`, which takes the kept declaration of the type when there is one.

Guarantees, the merge gate (ruling of Paolo 9/10):
- **Output.** A kept compile's status, stdout and stderr, and the diagnostic handler's calls, are those of a fresh
  compile of the same arguments and files, byte for byte and in order: deprecations, warnings, supplementals, source
  lines, instantiation traces (re-rendered from the instance's chain of this compile), gagged prints under
  `-verrors=spec`, `pragma(msg)`, and what the end-of-compile semantic2/semantic3 lists analyse (a library
  struct's TypeInfo members).
- **dip1000.** `EscapeState.scopeInferReason` is keyed by the variable (escape.ts): a kept variable keeps its reason,
  a new one never gets another's; `global.varSequenceNumber` goes on across kept compiles.
- **Invalidation.** A module whose file changed on disk (by content: stat, then bytes; a C module preprocessed again;
  a file the host overrides, `DjsOptions.texts`, by the text's bytes against the kept module's `src`; a module read
  from an override by its bytes at every compile until it is parsed again, override or disk, its record matching no
  stat: one read of the file per compile; keep.ts `computeDeadSet`, `keepParsed`),
  whose resolution through the import paths changed, whose role changed (root and imported), a string import whose
  `-J` search finds another file, finds one where it found none, or reads other bytes, a module import that found
  no file and now finds one, `__DATE__`/`__TIME__`/`__TIMESTAMP__` (re-analysed by every compile),
  `__FILE_FULL_PATH__` from another working directory, a changed command line: analysed again as in a fresh
  compile. A kept module the compile does not reach stays out of the module tree (an import added then dropped is
  "undefined identifier" again).
- **Dropped where another module's analysis wrote into it.** Three writes of one module's analysis into another
  module's analysed state cannot be taken back, so the module written is dropped and analysed again: a member a
  selective import marked with errors (not visible, `dsymbolsem.d:3571-3574`: a fresh compile starts without the mark
  and reports the error again), in the next compile, with the modules that requested its analysis; a C struct that
  another C module's struct compared with itself before its size was final (`dsymbolsem.d:4915`, the field list that
  `finalizeSize` then rebuilds without the anonymous bit-fields, `dsymbolsem.d:10171` and `:8689-8693`), in every
  compile that analyses that module again; and a member that another container's unit found before the module's
  semantic1 (`dsymbolsem.d:8035`, a lookup above the `import`, where importAll made the module searchable) and analysed
  by its use, in every compile that analyses that unit again: its live lookup then finds the member unanalysed, as a
  fresh compile does (keep.ts `keepFound`).
- **Known divergence: a D struct's anonymous bit-field.** `determineFields` (`dsymbolsem.d`) lists an anonymous
  bit-field among the fields, and `finalizeSize` rebuilds the list without it (`setFieldOffset`). A fresh compile
  where a live unit reads the struct's fields before its size is final (`S.tupleof` in a root edited since) sees the
  bit-field; a kept compile keeps the struct with its size final and the shorter list, and that unit sees one field
  fewer (`int a : 3; int : 5; int b;`: `S.tupleof[2]` is out of bounds kept, not fresh). Finalizing a D aggregate's
  size is not a unit, so nothing takes it back; a fix needs shadow state for `sizeok` and `fields` and finalization
  run again where a fresh compile runs it. An unchanged recompile is unaffected (the reading unit replays).
- **Dropped where it skipped analysis after an error: the CLI's path.** Some frontend tests read whether any error was
  reported and skip analysis when one was (dmd/errors.ts `analysisSeesErrors`; "Editor mode" above). A unit that ran
  where the count was above zero only from errors reported ungagged before it, and whose skipped analysis had a
  result, is dropped by the next compile and runs again (keep.ts `keepErrorState`): an instance made after the root's
  error looked for no copy constructor (`clone.d:1688`, where the struct has a constructor or a field with a copy or
  move constructor, clone.ts `keptCtorsSkipped`; none generated, the postblit's deprecation not printed), did not
  report a `__traits` that gives no type (`typesem.d:4405`) or returned silently at `templatesem.d:3001`. A library
  struct whose `isPOD` answer another module's analysis cached after an error (`dsymbolsem.d:1696`, the same test)
  drops its module, also where the errors were gagged ones of an open window, in either mode. Ungagged errors reach
  these tests in the CLI (a kept compile with the CLI's handler, the corpus `--recompile` lane: a compile stopped by a
  semantic error, then the root fixed) and, in editor mode, only `templatesem.d:3001` at gag level 0, an
  error-recovery path; so the editor's fresh compile of a broken buffer costs the next compile no drop.
- **Gagged errors at a unit's entry.** The same tests read the gagged errors of the open windows, in both modes: an
  instance first made inside `__traits(compiles, { undefinedY(); Box!int b; })` after the gagged error looks for no
  copy constructor, one made outside it does. A unit records whether such errors were counted at its entry and
  whether it read one of the tests where only they could make the answer true (`keepReadErrors`: a struct whose
  search may set a flag, a deferred loop with entries left, `templatesem.d:3001` under gag, `typesem.d:4405`); such a
  unit replayed under the other state aborts (keep.ts `replayUnit`, "replayed with gagged errors before it, recorded
  otherwise"), one that read none replays under either, and the units it requested check their own entry. A
  replayed unit puts back, before each request inside the gag windows it opened, the gagged errors those windows held
  when recorded (`enterWindow`), and a replayed match counts the instance's errors again as the live match path does
  (`keptInstanceMatch`), so an unchanged recompile, and a request that did not move, reads its recording's state; the
  abort needs a reading unit's first request moved between such contexts.
- **Known divergence: the error state of the CLI's kept compiles.** The reverse of the drop above: a unit recorded
  where the count was zero replays as it ran in a compile that has already reported an ungagged error, where a fresh
  CLI compile skips that analysis, and a struct's `isPOD` answer cached by a compile without errors answers one with
  errors. An instance kept from a good compile and first requested after the root's semantic error prints the
  postblit's deprecation, which ldc2 does not, and `__traits(isPOD, S)` of a struct with a copy constructor, asked
  after the error, answers `false`, where ldc2 answers `true`; the end-of-compile semantic3 loop (`dsymbolsem.d:837`),
  outside every unit, stops at its first entry after an error, and the kept instances it skips keep their analysed
  bodies. Editor mode does not reach it: there the tests read what the recording read. Rejected fixes: dropping the
  units that cross those tests sent a kept labserver compile after a semantic error in the root fresh (48-53 s);
  analysing past a returned `fatal()` as without errors hid gagged errors and asserted in
  `findMoveAndCopyConstructors` on a struct with a member named `__ctor`.
- **Known divergence, no reproducer: `ErrorExp.get` under gag.** In a compile without errors it reports "unknown,
  please file report" gagged (`expression.d:677`, D's reading kept: ungagged, the editor's would print it after
  every error); a unit recorded so and replayed into an editor compile with ungagged errors replays that gagged
  report, where a fresh compile makes none, and the window's gagged count differs.
- **A visible fallback.** Whenever the call compiles fresh it says why (`reason`): the first call, `the command line
  changed`, `the host options changed` (`DjsOptions.docComments`, or editor mode against the CLI's handler; not
  `texts`), `refused flag <f>: <why>`, `a C source file on the command line`, `the C preprocessor writes for <file>`
  (its output goes to the inherited stderr, which only a fresh compile's run gives), `the previous compile stopped
  inside a pass` (a FatalError or an escaped error inside a unit), `nothing to keep`, `object.d is not kept`, `RSS
  above 6 GiB`, or `abort: <what>` (below).
- **Memory.** Flat across edits of one file: dropped objects leave the instance tables, the type table, the Loc file
  table, the generated-name counters (those of a dead file or a dead parent) and the CTFE global values; an
  instance that no kept unit and no compile of the last four requested is dropped.

Refused, always fresh: `-v`, `-vtemplates`, `-vcg-ast`, `-X*`, `-D`/`-Dd`/`-Df`, `-H*`, `-deps`, `-mixin=`,
`-verror-style=sarif`, `-main`, and a `.c`/`.i`/`.h` root (its preprocessor writes to the inherited stderr, outside the
buffer). `-vcg-ast` writes the analysed AST to a file (keep.test.ts pins the refusal); the module members it dumps are
not part of the guarantee: a kept module keeps the members its own analysis appended (a C compound literal's `__cl`) in
place when no recording unit appended it, ahead of the instances this compile appends again, where a fresh compile
interleaves them (one a unit appended, `main`'s `mixin _d_cmain!()`, comes back where that unit's replay appends it,
`keepAppend`; an anonymous class a unit appends to a kept instance is appended again only where the instance lacks it),
and the generated identifiers of a replayed unit (`__r12`) keep the numbers of the compile that
recorded it. The AST view ("Queries") spells those as a fresh compile numbers them. An AA type's
`TypeInfo_AssociativeArray` declaration is kept and reused: its first request in each compile redoes the creation, and
its semantic3, run from the end-of-compile list (`runDeferredSemantic3`), is a unit (below): the instances it makes
(`TypeInfo_AssociativeArray.Entry!(K, V)`, `.aaGetHash!(K, V)`, `.aaOpEqual!(K, V)` and those they make) are appended to
the module members where a fresh compile appends them; so are the `object.RTInfo!(T)` instances that the end-of-compile
semantic3 of a library struct makes (`semantic3.d:1865`), outside every unit: the struct's `getRTInfo`, their guard, is
emptied before the next kept compile. The queries' instance table (the `instances` hints below) counts them all. An
imported C module is kept and checked by preprocessing it again before each kept compile; when that run writes anything,
the compile is fresh. A C module a kept compile reads (changed, or imported for the first time) is preprocessed with the
C compiler's stdout and stderr piped (cpreprocessor.ts `runCPreprocessor`); when that run writes anything, the kept
compile aborts. C types mangle without their module, so two C modules declaring one (two shims including one header)
share a `Type.stringtable` entry, the first merged one's declaration (keep.ts `keepMergeFound`). A kept compile that
merges into the entry of a module it has not loaded (one the edit dropped from the imports, or the replaced version of
an edited one), or loaded after the merging one, aborts, and so does, at its end, a kept compile that loads a module
which took another's C types without loading that one: a shim edited after the one whose header types it shares keeps,
the reverse aborts. A kept compile whose merge reads a kept C struct with a final size where a fresh compile's is not
final yet (the unit that finalized it, `keepSized`, has not run or replayed before it in this compile: a second C import
added by an edit) aborts, and so does one reading a kept C struct whose size no unit finalized (work outside every unit,
which a merge cannot be ordered against; dgpro07's two C shims finalize every size inside a unit).

`-i` (and `-i=<patterns>`) is kept: a compiled import is a module the command line and its name make one, so the kept
state's key fixes its role. Its registration, which stands for its parse in a kept compile, promotes it as the parse's
`checkCompiledImport` does (`dmodule.d:783-787`: `Compiler.onImport` pushes it on `compiledImports`,
`compiler.d:140-153`, and it becomes a root), at the point of its load, so `compiledImports` has a fresh compile's
order; its semantic3, run by `main.d:753-764` after the roots', is a unit like a root's (the parsed members replay, the
instances appended in this compile run), and the instances whose `minst` is a compiled import are appended by the real
creation path, where a fresh compile appends them. A replayed instance request whose `minst` is a root names the
compile's first root (`Module.rootModule`): a kept scope can hold a root module an edit has replaced. One whose `minst`
was its `tinst`'s is replayed with the `tinst`'s `minst` of this compile only when the `tinst`'s creation came first in
the log; a request made while the `tinst` itself is matched (a template argument's default, `Yes.useReplacementDchar` of
`byUTF!dchar`) names the module itself, where the kept `tinst`, not created yet, has no `minst` (null, which would
append the instance to the root's members, where a fresh compile appends it to std.utf's). A compiled import's request
then has another root as `minst` than in a fresh compile; the creation path reads only that it is a root, and the two
modules' `aimports`, which no diagnostic reads under `-o-`, differ.

How it works (src/keep.ts header): a unit is work D runs once behind a guard (a module's importAll, semantic1/2/3; an
instance's creation, semantic2/3; a function's semantic3; an alias of a non-root module, analysed at its first use; an
AA type's `TypeInfo_AssociativeArray` declaration's semantic3, run from the end-of-compile list, which reads the scope
of the request that created the declaration and its type's `loc`, and runs for real when either is not what it ran
with). A running unit logs the requests it makes, its report calls, traces, raw writes, generated-name counts, module
tree changes and deferrals (to Module.deferred and to the end-of-compile semantic2/3 lists), its requests of an AA
type's TypeInfo, the `minst` an AA TypeInfo's semantic3 sets on its instances (`semantic3.d:1700`, `:1716`, `:1732`),
its first merge of each AA type table entry with the merging type's `loc`, and notes what else its result depends on:
its string imports' searches and files, its failed module imports, the clock, the working directory, the
generated-identifier counter at its entry; and the type table entries it creates over a non-canonical type (`&f` of a
function whose type the analysis changed after merging it), which leave the table with it. A unit that retries the
deferred symbols (`runDeferredSemantic`, `dsymbolsem.d:760`) and whose own work leaves them as they are (each retry it
ran did no work, and it deferred nothing itself) holds nothing of them in its log: it replays under other deferred
symbols than recorded (an import added whose struct waits for another's size while a kept instance is first requested,
or dropped again), and retries this compile's ones at the end of its replay, where a retry that does no work proves that
the fresh compile's retries inside the unit did none, since a deferred symbol's analysis only gets further as the work
around it goes on (keep.ts `probeRetry`); its record then names this compile's symbols, and the unit remembers that list
and the recorded one as proved (`prove`): a later replay entered with one of them holds without the retry. The retry of
a list seen before can refuse what a fresh compile does: an import dropped and added again, whose kept analysis puts
back among the deferred symbols a struct of a kept instance analysed already (no shadow state takes a struct's guard
back), where a fresh compile's is still deferred, and the retry finds it done (`std.json` added again to the edit list's
program, at load 4-5: kept in 65-85 ms, against 3.5-3.7 s for the abort and the fresh compile). The later replay does
not repeat the proof: it takes the list's symbols to be where they were when a retry of them did no work, at a unit
whose log does not depend on them. A retry made inside an outer one returns at once, a fresh compile's inside the unit
too: it proves nothing, and the list is neither noted nor recorded as the unit's; no list is proved, nor a proved one
used, while open gag windows hold gagged errors, which a retry's work may read. A unit keeps the last four lists, the
one a replay matched moved last; a list naming a symbol of a module or instance a compile drops goes at that compile's
end (`dropStaleProofs`), so no list keeps an edited module's AST alive: the cost is those arrays, few symbols each (the
`std.json` toggle: about 20 units, lists of three at most). Whether a unit runs inside a retry (`dsymbolsem.d:762`
`nested`: its own retries return at once, its log holds none) is a replay condition both ways (keep.ts
`UnitRec.nested`): a unit whose work changes the deferred symbols, replayed in the other state, aborts; another,
recorded inside one and replayed outside one with deferred symbols or symbols it defers, is probed the same way, since a
fresh compile's retries inside it run. A replay runs no retry: the requests a recorded retry made replay in the state
their log recorded (each request event carries it, keep.ts `nestedNow`).
The next compile resets each
kept unit's guard to its value before the unit (the shadow state), so every caller that would run it reaches it, and its
first request replays the log there. A function's semantic3 that inferred its return type has a second guard, the return
type itself, which the shadow state does not take back (the function's type keeps what its analysis set): while that
unit is pending, the inference tests of `functionSemantic` and of a call (`funcsem.d:1583`, `expressionsem.d:4189`) read
the return type as missing (keep.ts `keepInfers`), so the first request replays the unit where a fresh compile runs it.
An alias's shadow state also takes back its overloads before its analysis (`overnext`, which the analysis moves into the
aliasee, `dsymbolsem.d:6695-6700`, and which `mostVisibleOverload` reads on a pending alias, `access.d:341`). A kept
instance's first request creates it anew from that request (loc, tinst, minst, gagged, its members' scopes, the module
append) and replays its creation; the rest of the creation path runs for real. An AA type's TypeInfo declaration gets
the same creation emulation: before a kept compile the `vtinfo` of the AA types in the type table and the declarations'
scope are emptied, and the first request in the compile, replayed or live, gives the type its kept declaration, reused,
with the requesting scope and defers its semantic3 (`typinf.d:185-189`). The type's `loc`, which that semantic3 reports
and instantiates at, is the type table entry's: a fresh compile's entry is the object its first merge in the compile
inserted, with that type's `loc` (`typesem.d:3466`), and the first merge of a kept AA entry in each compile, live or
replayed, sets it (keep.ts `aaLoc`), also where it returns a type merged already (`typesem.d:3461-3464`: a template's
`int[int]`, one object for all its instances, `keepMergedAA`). Before a kept compile the dead set drops what cannot
replay: changed modules, modules whose parse reported or read the clock, the units of the Invalidation list, ungagged
errors, reports in changed files, and to a fixpoint every unit that requested a dropped one, every instance over a
dropped symbol, every AA TypeInfo declaration over one (key and value types, object.d's `TypeInfo_AssociativeArray`) or
analysed from a dropped scope (the requesting code's module, instance and root module, which the declaration must not
keep alive), every unit entered from a dropped module's scope (an instance's members keep the instantiating call's
scope, `callsc`), and every module whose own member a dropped container's unit found before the module's semantic1
(keep.ts `peeks`: a lookup above the import of a widely imported module drops that module, and what it brings down,
with every edit of the finder: a 31-module hub, ~2.2 s kept against 0.4 s with the line below the imports, at load
6-7); then every AA TypeInfo declaration whose type left the table through an entry a dropped unit created.
A dropped AA TypeInfo declaration whose type stays is not replaced: its semantic3 runs for real again. What a parse does
belongs to its module, not to the unit that loaded it: a kept module is registered, not parsed, at its first load in a
compile, from a unit that runs or one that replays, and the registration adds the generated-identifier numbers its parse
consumed. A module that another module's name uses as its package (`module a.b;` with an `a.d`, an error) lends its
symbol table to the module tree (`dmodule.d:190-212`; made there when its importAll has not run, which then adds no
members, `dsymbolsem.d:8412`): before a kept compile the table loses the tree's entries, or goes when no importAll ran
on it, and the next use puts them back. Work outside every unit is not replayed, it runs again: so a guard it leaves on
a kept object is emptied before the next kept compile (an aggregate's `getRTInfo` set by the end-of-compile semantic3,
keep.ts `keepRTInfo`; the pass guard of `main`'s `mixin _d_cmain!()`, whose passes 2 and 3 run in the module passes'
tails after the parsed members, back to its first pass done, so those tails request its functions' kept units again: C
`main`'s semantic3, which names `_Dmain`; left at its last pass, the functions stayed in their shadow state and
`queryUnused` reported `_Dmain` after an unchanged recompile).

Abort: a kept compile buffers stdout, stderr and the handler's calls. A replay that finds the kept state wrong for this
compile (a request in another state than recorded: an import cycle entered from the other side, with output; a gag or
`-de` state or an instance's `gagged` other than recorded, with output; gagged errors counted at the entry of a unit
that read a test of the error count by them where its recording had none, or the reverse; other deferred symbols than
recorded at a unit whose own work changes them, or whose retry of this compile's ones, at the end of its replay, does
work (a symbol analysed already that a kept module's replay puts back among them, where a fresh compile's is still
deferred, in a list not proved for the unit); a printed generated name (`__r3`) while the generated-identifier counter
differs from the recording's at a replayed unit or registered parse that consumed some, found at that unit's replay or,
when the difference comes later, at the end of the compile; at the end of the compile, a string this compile made, by a
unit run or replayed, that names a generated identifier by the number its recording gave it where this compile gave it
another (`__traits(allMembers)` of a kept struct with an anonymous bit-field, `__anonBitField3`; a kept lambda's
`.stringof` with its `__T4`: the StringExp constructor's hook keeps the strings that look generated, `keepString`, and
their words are looked up among the spellings of the identifiers this compile numbered otherwise, so an instance's
mangle, a lambda's location name or a CTFE-built `__x1` do not count); an instance's semantic2/3 before its creation in
this compile; a request that created an instance when recorded and matches it in this compile, or the reverse, while the
instance's pending semantic2/3 prints (a creation runs them at once, `templatesem.d:1369`, `:1381`, a match does not); a
C type merged into the entry of a module not loaded or loaded after its own, or a module that took another's C types
loaded without it; a merge reading a kept C struct whose size a fresh compile has not finalized there, or that no unit
finalized; a deferral of a symbol not kept; a request of an AA TypeInfo declaration not kept, or first requested without
a scope, or of its semantic3 from a unit; a lookup into a kept module before its semantic that finds its own member or a
symbol through imports its semantic changed (one that finds nothing goes on: a fresh compile's misses too); a
package-qualified name checked through a kept module before its semantic whose imports or package access are not its
importAll's; a module tree conflict; a kept module used as a package whose symbol table is not a fresh compile's there
(its members' exactly when its importAll has run in this compile), or whose importAll replays without the use that made
its table; a new module named as a kept one; a C preprocessor run that writes), and any crash during a kept compile,
throws: the buffer is dropped, the call compiles fresh and its `reason` is `abort: <what>`. Two differences go on, since
they change nothing printed: a request in another state where neither unit nor what it requests prints (it goes as in a
fresh compile: the pending unit replays, the running one does not), and a replay under another gag state whose log
prints nothing the gag would change.

What a kept compile keeps, against `deinitializeFrontend` (each justified at `resetForKeptCompile`, src/djs.ts): the
identifier table, `Id`, `Type.stringtable`, the Loc file table, `Package.packageTag`, the CTFE stack's global values,
`EscapeState`, the instance tables' object ids, generateIdWithLoc's counters, the object.d statics (emptied, and put
back as object.d is registered), `Dsymbol.commentHashTable` (a kept module is not parsed again, so its doc comments are
its parse's; a WeakMap, so an entry goes with its dropped symbol; only -D and -X read it, both refused). Everything else
is reset as for a fresh compile.

The proofs: src/keep.test.ts (each kept compile against `djsMain`: a library deprecation with its trace after the root
moved, the four edit patterns of §4.6, an instance made after an error in the root and made again once it is fixed
(`clone.d:1688`, `typesem.d:4405`) and a library struct's `isPOD` answered after an error, in editor mode a parse error
after a good compile, semantic errors under `-verrors=2` and in another root, a root parse error with a semantic error
in an imported and in a locally imported module, an instance with errors requested twice ungagged, a gagged error then a
kept instance requested in the same window recompiled unchanged in both modes, gagged errors that still skip, a struct
with a function named `__ctor`, a mixin's copy constructor under each attribute and a `std.traits` instance through a
semantic error and its fix, a root changed to a module importing it, a kept module edited, dip1000, the parse's
generated names, a module first reached through another import, a package.d after its submodules, a kept module's import
whose package another import had put in the tree, a module's location, a function pointer type of the previous root,
deferred semantic3, a module appearing, an import added whose struct is deferred where a kept instance that retries the
deferred symbols is first requested, then dropped, a struct an instance's creation deferred and the module's retry
completed before the next instance that retries them, the same through a library's alias analysed at its first use,
a lookup that passes through a kept module before its semantic and finds nothing there (another import has the name),
one through its importAll's public import where its semantic added a private one, a library struct the root
analysed before the library's semantic and a private selective import's alias found before its module's semantic,
each dropped with the root edited, an edited root still calling an imported `auto` function, `-i` (a
compiled import's bodies with the root and then the compiled import edited, an import added then dropped, `-i=`
patterns, the root inferring a compiled import's `auto` function and method before its semantic3), string imports, the
clock, the working directory, a C module edited and one imported for the first time, the diagnostic handler's calls, an
unchanged recompile of seven dmd corpus cases (a root that is its own `object` with an AA type and a
`TypeInfo_AssociativeArray` without the hooks, two; a selective import of members not visible under `-de`; an overload
set across two imports; C structs of one name from two imports, a bit-field's name differing; a root module whose name
another root uses as a package, two), what the end-of-compile semantic3 analyses (an AA type's TypeInfo after lines
inserted above the type, after the module that first named the type was dropped, after the type's first merge moved to
another kept module or into a template's body merged already, and with its creating request moved to an edited module; a
library struct's RTInfo), and the fresh cases: a refused flag, a changed command line, a root whose parse reported,
a lookup through an import that a kept module's semantic added or made public, before that semantic, and a
package-qualified name checked through a kept module whose semantic opened the package, before it, a
printed generated name moved, a value made of one (`__traits(allMembers)` of an anonymous bit-field), the same made by a
live unit from a kept module's names, strings that only look generated keeping the compile kept, an unchanged recompile
renumbering nothing with a parse inside a unit's numbers, a kept C module whose preprocessor writes, a C module read by
a kept compile whose preprocessor writes, an instance created by a request in one compile and matched by it in the next
or the reverse, under `-i` and with two command-line roots, two C modules' types of one name, two C shims including one
header, a C struct merged with a kept one whose size a fresh compile has not finalized there, a root added that names a
kept root as its package, an imported module named as a package after its importAll, that import added again, whose kept
module puts back a deferred symbol analysed already, an instance replayed with gagged errors before it where its
recording had none, editor mode against the CLI's handler, the abort path); the corpus `--in-process --keep` (§4.5),
which also exercises what has no test of its own (a module's resolution changed, the lazy alias unit, the `minst` writes
an AA TypeInfo's replay makes, the deferral its creation's replay skips; a crash during a kept compile has no
reproducer), and its `--recompile` lane, alone and with `--editor`, which compiles every test again unchanged in the
same child: every kept second compile prints what the first printed (under `--editor`, four tests that stop at a known
non-return of editor mode, above, differ between two fresh compiles); the edit list of tests/phobos/editloop.ts through
`--sequence ... --keep` (§4.6); and the dgpro07 labserver probe (a fresh compile ~29-31 s, 2.2-2.3 GiB RSS; kept, the
root unchanged 0.33-0.41 s, the root edited 0.83-0.84 s back to back and 1.07-1.13 s after a forced full GC; heap after
GC flat over 100 saves; under `-i`, at load under 4, a fresh compile ~35 s, kept 0.44-0.51 s with the root unchanged and
0.58-1.25 s with the root, a compiled import or the C shim edited, 2.2-2.6 GiB RSS; without `-i` an edit of the C shim's
code, read again by the kept compile, 0.92-1.02 s; the record of each unit's generated identifiers for the AST view,
`keepGenerated`, +5-6 MiB of heap after GC under `-i` (1193 to 1198 MiB after a fresh compile), save times within 2%
(six alternating saves, 862-1161 ms against 877-1182 ms); labsensor's C shim shares header types with a C module loaded
after it, so its edit aborts, `keepMergeFound`). The corpus's nine `-i` tests run with other command lines than their
neighbours, so the corpus run keeps none of them; a one-off probe compiled each twice in one process, the second call
kept and equal to fresh, which covers only a recompile of unchanged files: the edits under `-i` are keep.test.ts's and
the five modules'.

#### Queries

`queryHover(file, line, character, text)`, `queryDefinition(file, line, character, text)`, `querySemanticTokens(file,
text)`, `queryInlayHints(file, text, range)`, `queryInactiveRanges(file, text)`, `queryExpansionSites(file, text)`,
`queryExpansion(file, range, text)`, `queryAst(file, text)`, `queryInstances(files)`, `queryImports()`,
`queryCompletion(file, text, position)`, `queryDocumentSymbols(file, text)`, `queryReferences(file, line, character,
text)`, `queryPrepareRename(file, line, character, text)`, `queryRename(file, line, character, text, newName)`,
`querySignatureHelp(file, line, character, text)` and `queryUnused()` (src/query.ts, exported by src/djs.ts) answer on the analysed AST the last
compile left, whatever it was (`djsMain` or `djsMainKept`, fresh or kept, from the disk or a host's texts), between
compiles. That is what "the last good index" means for a host: the queries answer from the last compile that analysed
the file, and a compile never leaves an older one behind. In editor mode a compile of a half-typed buffer analyses the
file past its parse errors, so its index holds every declaration the parser kept; no older module's AST is kept beside
it (it would double the memory of a large compile, and the kept engine replays the same objects). Positions are an
editor's (line from 0, UTF-16 character from 0), `file` is matched against the source files of the last compile's
modules (both resolved against the working directory). A query is read-only: no semantic call, no generated identifier,
no write to frontend state, so the next compile, kept or not, is what it would be without it. Printing goes through
hdrgen.ts as diagnostics do, with its `optimize` slot set to the identity for the query: hdrgen folds a variable
template argument and a `size_t` expression with `optimize` (hdrgen.d:3825, :4049), which on a variable whose
initializer the analysis has not run runs it; such an argument prints as the analysis left it (by name). After a kept
compile that numbered generated identifiers otherwise (`__r12`), every query prints them as a fresh compile numbers them
(`spellFresh`, the AST view's paragraph below): the hover's text and its Resolved section, a peek, a definition's name,
a hint's types; the semantic tokens and the inactive ranges print no name. The answer is `{ result }` or a miss `{
result: null, stale, reason }`: the file is not in the last compile; `stale`, with `STALE_REASON`, when `text` is not
the text that compile read (`Module.src` less a UTF-8 byte order mark: every position would be wrong; not a
completion's, below); no identifier, or no symbol, at the position; for the hover, the definition, the signature help,
the references and the rename, the position in an inactive branch (`INACTIVE_REASON`, below). A hover carries dmd's kind
(`parameter`, `field`, `local variable` for variables), the qualified name (`toPrettyChars`), the identifier's range and
Markdown: the signature or type in a ` ```d ` block, the template instance the symbol belongs to (and, at a position
inside a template, how many instances answer there: the first one does), the deprecation and its message, the doc
comment split by `DocComment.parse` (dmd/doc.d:234) and rendered (summary, description, Params as a list, Returns,
Throws, See_Also and other sections by name; `$(D x)`, `$(D_PARAM x)`, `$(REF x, ...)`, `$(LREF x)` as code, other
macros as their arguments' text); a member of a template instance, whose copy carries no comment, shows its template's;
a `ditto` comment shows the previous documented declaration's in the same scope. A definition carries the declaring file
as the compiler names it and the declaration's identifier; a module, its file's start; a symbol declared in a string
mixin, its name inside the mixin's literal when that literal is the mixin's whole argument and holds no escape sequence
(the bytes the mixin parsed), else the `mixin` keyword when its line has one; a symbol without a location, or one of a
string built elsewhere on a line of several mixins, no answer.

A hover's last section, after a `---` line, headed `**Resolved**`, says what the analysis made of the code at the
token, each part a label and a ` ```d ` block printed by hdrgen from the analysed nodes, never rebuilt from the text,
for one analysed copy (the first instance's in a template): `Lowered:`, an operator overload's call at its operator
(`a + b` as `a.opBinary!"+"(b)`, `a < b` as `a.opCmp(b) < 0`, `a != b` as `!a.opEquals(b)`, `opIndex` at `[`,
`opBinaryRight!"in"` at `in`, `opOpAssign`, `opIndexAssign` at `=`; `opUnary`, `opCast`, `opIndexUnary`,
`opSliceUnary`, `opIndexOpAssign` and `opSliceOpAssign`, which opover.d locates at their object, at the token found from
it: `-a`, `++a`, `-*p` as `(*p).opUnary!"-"()`, `cast` of `cast(int) a`, `+=` of `a[i] += x`, none when the text there
is not that operator), a `foreach` at its keyword lowered to a `for` over a range (the range's copy, the head, the loop
variables, the body elided) or to an `opApply` call (the delegate by its signature); `Property call:`, a function called
without parentheses (`a.twice()`, a setter `a.twice(4)`); `UFCS:`, a free function called as a member (`ufcs(a, 5)`);
``Through `alias this`:``, a member reached through `alias this` to a field or a function (`o.inner.deep`,
`bf.get().deep`); `Overload picked among N candidates:`, the signature of the function the call resolved to when its
overload set declares more than one function or template (counted read-only along `overnext`, a template's
`funcroot` and the overload aliases; a set merged across modules at lookup is not seen); `Implicit conversion:`, a cast
the analysis inserted around the expression starting at the token, between types that differ past their modifiers (not
to `void`, not of a literal, not one written). A call prints through its instance, the outermost of nested eponymous
ones (`to!string`, not the `to!uint` it holds; `apply!(x => x + k)`, whose inner instance's parent is the function of
the local argument), a prefixed object in parentheses, its arguments through hdrgen. A part whose text names a
compiler's temporary (`cast(int)__r12.length` at an array's `foreach`) is not shown, but for a lowered `foreach`. The
first part of the hover is unchanged; a call to the only overload as written gets no section. A `Lowered:` part that
calls a function (an operator's overload, `opApply`) is followed by its doc comment's summary. A token where a lowering
sits and no identifier (an operator, also right after one, `a+b`, `a[1]`: tried before the step back to the identifier)
or no symbol (`foreach`, `new`, `cast`) answers with the section alone, kind `operator`, `statement` for `foreach`,
`expression` for another word, the token's range. Not
covered: an expression mixin, `opDispatch` and `opCall` at their names, a lowering to a druntime hook (`__equals`,
`_d_arrayappendT`), an array `foreach` (a plain index loop). Dgpro07 labserver.d under `-i`: 671 of the 9224 identifier
hovers answered carry a section (overloads the most, then conversions, property calls, UFCS), and 83 of its 7047
operator and `foreach` tokens answer with the section alone; the whole sweep with the sites and peeks ~210-450 ms at a
load under 4.

The semantic tokens of a file, `querySemanticTokens(file, text)`: `{ result: { data } }` or the same misses (not in
the last compile; `stale`). `data` is a `Uint32Array` of 5-tuples `[line, character, length, type, modifiers]`,
absolute (line from 0, UTF-16 character and length), sorted by position, never overlapping; the host encodes them
relatively (VS Code's `SemanticTokensBuilder`). `type` indexes `SEMANTIC_TOKEN_TYPES` (`namespace`, `type`, `class`,
`struct`, `interface`, `enum`, `enumMember`, `typeParameter`, `function`, `method`, `variable`, `parameter`,
`property`), `modifiers` is a bit set over `SEMANTIC_TOKEN_MODIFIERS` (`declaration`, `readonly`, `static`,
`deprecated`, `defaultLibrary`): standard LSP names only, so a theme colours them without a contribution. One pass
over the file's identifiers gives each the symbol the hover would show, through the same index; the kind table and
the modifier rules are src/query.ts's header (SEMANTIC TOKENS). In short: a module, package or scoped import is a
`namespace`; an aggregate its kind (a union a `struct`), a constructor at `new S`/`S(...)` its aggregate's; a field, a
static member variable and an `@property` function a `property`, a member function (a member template's instances
too) a `method`; an alias the kind of what it names, `type` for an alias of a non-aggregate type; a template the kind
of its eponymous member; template type and alias parameters `typeParameter`, value parameters `parameter` `readonly`,
in an instance's code too (looked up in the instance's argument table, where the hover and the definition answer with
the argument). `defaultLibrary` is the symbol's outermost package being `core`, `std`, `etc` or `ldc`, or the module
`object`; an alias has its own, except a selective import's, which has its target's. Not tokenised: keywords and basic
types, and object.d's `string`, `wstring`, `dstring`, `size_t`, `ptrdiff_t`, `noreturn` (the TextMate grammar colours
them), compiler-made names, identifiers with no symbol, and the inactive ranges below. An unnamed hit (a node whose symbol's name is not the token's) answers only
when it is a function, a template or an instance (a call through an alias of another name); another is a value folded
at the token. The hover's read-only fallback fills the identifiers the analysis folded away (enum members, manifest
constants), except after `@`, after `goto`/`break`/`continue`, and as the first word of `scope(...)`, `extern(...)`,
`pragma(...)`, `version(...)`, `debug(...)`, `__traits(...)`, `align(...)`, which are never symbols. Cost, dgpro07
labserver.d under `-i`: 8998 tokens, ~25 ms with the index built, ~95 ms when the query builds it; ops net/bundle.d:
507 tokens, ~4 ms and ~13 ms.

The inactive ranges of a file, `queryInactiveRanges(file, text)`: `{ result: { ranges } }` or the same misses. The
ranges are the branches of the `version`, `debug` and `static if` declarations and statements the analysis did not
choose, for the compile's target and flags (the same file differs between the host and an `-mtriple` line), sorted,
disjoint, outermost only: from after the condition (after the `:` of `version (X):`, to the end of the enclosing
block; after the `else` for an `else` branch) to the branch's end. Which branch was chosen comes from the analysed
AST: a declaration's condition stays there (`ConditionalDeclaration.condition.inc`); a statement's does not, semantic
replacing it by its chosen branch (statementsem.d:1769, `flatten` :4893), so the frontend notes each conditional
statement it decides on the function being analysed, `FuncDeclaration.djsConditionals` (no D counterpart, read by
nothing else of the frontend). Every analysed copy counts: a branch is inactive when some copy decided its condition
and none chose it, so a template whose instances choose differently has none (speculative instances do not count),
and a conditional no analysis decided (a template without instances, a function whose semantic3 did not run) has
none, nor one whose copies are not all known (a mixin template, which other modules may mix in; a function of which
an instance's copy was not analysed). The extent is found on the text from
the conditional's keyword: a `{ ... }` block, or one statement or declaration, D binding an `else` to the innermost
`if` or condition (a brace-less `if ... else`, a loop, `static foreach`, `try ... catch`, `do ... while` are one
statement; dmd reports an `if ... else` directly under a brace-less condition as a dangling `else`; `private:` and the
like reach the end of the block), comments and literals skipped, delimited and token strings included. The semantic
tokens give no token there.

The inlay hints of a range of a file, `queryInlayHints(file, text, range)`: `{ result: { hints } }` or the same misses;
a hint is `{ position, kind, label, tooltip }`, sorted by position, the label shown before the position's character.
`type`: `: T` after the name of a variable declared without a type (`auto`, a storage class alone, `enum x = ...`, a
`foreach` variable without one, the later names of `auto a = 1, b = 2`; found on the text, since the analysed
variable has a type either way), `-> T` after the last parameter list of a function whose return type is inferred;
T as dmd prints the analysed type, cut at 60 characters, a template's instances' distinct types joined by ` | `.
`parameter`: `name:` before each argument of a call written with parentheses whose function the analysis resolved,
the overload it picked, `new C(...)` included; a UFCS receiver is the first parameter; none for an argument that is
the parameter's name, a parameter without its own name (a tuple's expansion), the arguments past a variadic
function's last parameter, and from the first named argument, or the first written argument that is not exactly one
analysed argument (a tuple expanded), on. `instances`: after the name of a template declared in the file, how many
instances the compile created (every module's, not speculative ones; a mixin template's mixins are not counted), none
when zero. A tooltip is the hover's code block of the symbol the hint is about, or the first five instances. Cost,
dgpro07 labserver.d under `-i`, the whole file: 1789 hints (437 type, 1352 parameter; the file declares no template),
~75 ms in djs-vscode's worker when the query builds the file's index, ~27 ms after, most of it printing types and
signatures; its 23 inactive ranges ~2 ms with the index built, then kept with it; ops net/bundle.d: 23 hints, ~6 ms
and ~1 ms.

The expansion peeks of a file, `queryExpansionSites(file, text)`: `{ result: { sites } }` or the same misses; a site is
`{ kind, range, title }`, sorted by start, never overlapping (of nested ones, the outermost), one code lens each; and
`queryExpansion(file, range, text)`: of the sites containing the range, the innermost (of equal ones, the one the list
shows), with `text`, D source as hdrgen prints it ending with a newline, and `instances`, how many analysed copies
answer there (a template's instances, `static foreach` iterations; the first is shown), or a miss (`no expansion at the
range`, `the range is outside the text`). A cursor passes an empty range, the innermost site at the point; a lens passes
its site's range and gets that site (`enum n = Foo!int.sizeof;`: the value, not the instance inside); a selection, the
innermost site around it. Three kinds:
`mixin`, a string mixin from its keyword to its `)`, its declarations as parsed and analysed (`MixinDeclaration.decl`)
or its statements, which semantic put in place of the mixin statement (statementsem.d `flatten`), recognised by their
locations' file `<file>-mixin-<line>` (dsymbolsem.d `adjustLocForMixin`, one name per mixin parsed) and matched to the
`mixin (` keywords of that line that start a statement (after `;`, a brace, `)`, `:`, `else`, `do`): by the string a
keyword's lone literal argument mixes in, else by parse order, each copy's runs taking the keywords in turn (`static
foreach` parses the line's mixins once per iteration); a mixin in an expression or a type is not one;
`instance`, a template instance written with `!` (`Foo!(args)`, `Foo!arg`, a template mixin at its template's name;
not an IFTI call), found through the hits at its name (the instance or a member of it), else as an instance made at
that location (`Twice!3`, folded to its value), printed by hdrgen as `-vcg-ast` prints it (`fullDump` and `vcg_ast`,
`dumpTemplateInstance`: the instantiated members, arguments substituted; the vcg path calls no semantic and no
`optimize` of its own), an instance met again inside its own dump by name only (`alias Self = Traits!T;` recursed until
the stack ended: the query guards it in hdrgen's print hook, removed after the print); `value`, a folded value
where it differs from the source (whitespace, a leading `cast(T)`, a number's suffix and digit separators ignored; a
source that is one literal, `0xFF`, `2.5f`, `true`, a string, is never one; a value printed empty, an error's, neither):
a manifest constant's or an enum member's initializer as the analysis
left it (`15.seconds` holds `Duration(150000000L)`), a `static if` condition (`true` or `false`), a value argument of an
instance whose analysed argument is a literal (`K2 + 1` holds 4, inside the instance's site). Titles: `mixin: 2
declarations`, `Box!(int, 4)`, `mixin Adder!int`, `= 16`, cut at 60 characters. Dgpro07 labserver.d under `-i`: 41 sites
(34 instances, 7 values, no mixin), the index and the sites ~55 ms, the 41 peeks ~50 ms (238 KB of text, the
instances of the server templates the most); ops net/bundle.d: 2 sites, ~5 ms.

The AST view of a compiled module, `queryAst(file, text)`: `{ result: { text, entries } }` or the misses of the file
queries (not in the last compile; `stale`), `the module is imported, not compiled: -vcg-ast prints no AST for it`, and
`-vcg-ast's print fails on this module: <error>` where hdrgen faults as ldc2 does (an enum member whose initializer
failed, `EnumMember.value` of an `ErrorInitializer`: -vcg-ast in editor mode stops there with an internal error).
`text` is what `-vcg-ast` writes in `<file>.cg` (main.d:863, `moduleToBuffer` with `fullDump` and `vcg_ast`, tab
indents), printed from the AST the last compile left, kept or fresh, at the first request after a compile and kept
until the next. `entries` are the declarations hdrgen's symbol printer printed (members, locals, instance members,
imports; not the attribute blocks, not the variables of `int a, b;` in a function, which it prints without its
symbol dispatch), sorted by start, a container before what it holds: `ast`, the print's range in `text`, from its first
character to past its last; `kind`, as the hover's; `name`, `toPrettyChars` (an import's: the imported module's, as
written where the import resolved none); `source`, the identifier of its declaration in a source file, found from the
location the compiler gave it as `queryDefinition` finds it (an instance's location is where it was instantiated),
null where that location is not at an identifier of its name (no location, a string mixin, or a symbol the compiler
made: the implicit `import object`, `RTInfo!(S)` at its struct, a `foreach`'s `__r3`); `extent`, a function's, from
its location (its identifier; a destructor's `~`, a literal's first token) past its last character at its `endloc` (a
`}` or `;`; else, an expression body's or an invariant's `endloc` being past the end, to the last character before it),
null for the others (the frontend keeps no end for an aggregate). The ranges are the print's own: hdrgen's
print hook (`registerDsymbolPrintHook`, at `dsymbolToCBuffer`'s one `accept`) gives each symbol's print and its buffer,
a symbol's range being the buffer's growth across it; the same hook guards an instance's dump against itself. Two
departures from the identity `optimize` of the
other queries, both read-only. hdrgen folds a variable that is a template argument or an array dimension with
`optimize` (hdrgen.d:3825, :4049: `count!(param, 3)` for `count!(param, width)`); the view folds a variable whose
initializer is a constant, or one not yet analysed that its semantic would leave as it is (`foldVariable`), and prints
the name where `optimize` would analyse an initializer that is not a constant yet (as -vcg-ast's own print does), the
one place its text can differ from the `.cg` file. And after a kept compile the generated identifiers of the replayed
units (`__r12`, `__key13`, a constructor's `catch` variable `__o3`) carry the numbers of the compile that recorded them,
where a fresh compile numbers them from where this compile's counter is: the engine records each unit's and parse's
generated identifiers in the order of its counts, and the counter at which each replayed segment of its log started
(src/keep.ts `keepGenerated`, `keepGeneratedNames`), and the view spells each identifier as a fresh compile numbers it,
decided by the one number all the compile's units that made it agree on, else by the innermost symbol being printed
whose units made it (`Identifier.toChars` and `toString` wrapped for the print; an identifier no unit made is left at
once); one neither decides keeps its name (`queryAmbiguousNames` counts them for the tests: none in the pinned cases).
Every query's print is spelled the same way (`printing`). An instance met again inside its own dump prints by
name. Oracle: the text equals the `.cg` that djs's CLI writes (ldc2's, for the test module) for every module
of dgpro07 labserver.d under `-i` (165, the 3 C modules excepted: their compiled text is the preprocessor's, `stale`)
and of ops net/bundle.d (2), and for every root of the dmd tests of compilable/ and runnable/ that compiles alone
(1555; 6 `stale` by a byte order mark or an encoding the test reads differently); after a kept compile of labserver.d
with two `foreach` added at its top, which renumbers 71 of its modules' views, and after an unchanged kept recompile,
every view equals a fresh compile's. Cost, labserver.d under `-i`: 5.8 MB of text, 229258 lines, 64673 entries, ~1.5
s at the first request (hdrgen's print ~1.0-1.3 s of it; the entries' names computed for the entries only, each
parent's qualified part once), the same after a kept compile that renumbered, then under 0.1 ms; RSS +25 MiB; ops
net/bundle.d: 184 KB, 9162 lines, 2828 entries, ~90 ms.

The template instances, `queryInstances(files)`: `{ result: { templates } }`, or `no compile to read`. Each template
declared in one of the files (absolute, or against the working directory; a file not in the last compile is skipped,
and no text is compared) that the compile instantiated, sorted by file and position: `name` (`toPrettyChars`; a member
template of an instance names the instance), `kind`, dmd's kind of the template (`template`, or its eponymous
member's when that is an aggregate: `struct` for `struct Box(T)`), its `file` and identifier `range`, and
`instances`, every primary, non-speculative instance of the `instances` hints' table (`instancesOf`), sorted by site
then title: `title`, the instance's `toChars` printed as the AST view prints (`count!(param, 3)`, generated names
spelled as a fresh compile numbers them), and the `file` and `range` of the
template's name where it was instantiated (its `loc`; both null outside a source file). Cost: the instance table, one
pass over every module's members shared with the hints, then the titles: labserver.d's 168 compiled files, 126
templates and 823 instances, ~200 ms (~170 ms with the table built); bundle.d's, none, ~1.5 ms.

The modules loaded, `queryImports()`: `{ result: { modules } }`, or `no compile to read`. Each module of
`Module.amodules`: `name`, `file`, `kind` (`root` on the command line, `included` through `-i`, `imported`), `size`
(its source's bytes), `imports` (indexes into the list, in source order, no duplicates, not itself), `cycle` (its
strongly connected component's number when that holds more than one module, else null). The imports are those its own
`import` declarations name outside functions and templates: in the branch a condition chose, `static foreach`
expansions, mixins, aggregates; not the frontend's `aimports`, which also takes the imports of the instances a module
requests and which a kept module carries from compile to compile (after a kept compile of labserver.d, its own list
held 10 modules more than a fresh compile's, object.d's other ones). The list: the command-line roots first, then
breadth-first along the imports, then, breadth-first again, each module no root reaches, by name. No per-module
analysis time: the compile measures none. Cost: labserver.d under `-i`, 349 modules (64 in cycles, object.d and
druntime's among them), ~7 ms; bundle.d, 105, ~3.5 ms.

The names after a `.`, `queryCompletion(file, text, position)`: `{ result: { range, items, moved } }` or a miss. Unlike
the other file queries a `text` other than the compiled one is not `stale`: the user typed the dot after the compile.
The expression before the dot is read from `text`, backwards, across whitespace, newlines and comments, up to the
statement's start (a `;`, `{` or `}`): an identifier chain `a.b.c` (`p` on one line, `.q.` on the next), with `this` or
`super` first or a leading `.` (the module scope: a `.` with no identifier, `)`, `]` or literal before it), a link
ending in `()` with no arguments or in `[...]`; anything else is a miss. Its scope is found in the compiled text at the
dot moved through the two texts' common prefix and suffix (inside the changed span, at the span's start; the move
djs-vscode's hints use, `editMover`): the innermost analysed function there, else the module. In a function template's
body every analysed instance's copy resolves the chain, and the answer is theirs only when they agree on its type
(`show(T)(T v)` instantiated with a struct and with `int`: a miss). The first link: the symbol the analysis resolved at
that identifier, when it is in the text the compile read, before the edit or in its unchanged end (the index's: of two
locals of one name in disjoint blocks, the one in scope there; a global used before a local of its name is declared);
else, read-only, the tables from the scope (an aggregate's base classes and template mixins; an import declared earlier
in an enclosing function body; a function's parameters and locals by position: one declared after the dot is not in
scope, and a name that several locals of the function declare is a miss, since the function's table holds only the
first; in a body with errors, which the walk sees as an `ErrorStatement` and the editor's usual case, a local the walk
did not meet takes its own location's position, and a name the body's text declares more than once is a miss; an
expression statement such as `if (c) t.x = 1;` is never counted as a declaration). Each next link is a member of the
previous (a module's members and its public imports', a package's submodules and its package.d's members). A variable
gives its type's value (a field of a `const` or `immutable` value takes the qualifier), a function its return type (`()`
written or not, when every overload is callable with no arguments: no parameters, all defaulted, or `@property`; one
return type, not `void`; no template), an aggregate, enum or type alias a type, an import, module or package a scope,
`[...]` an element type. `range` is the identifier being typed after the dot, in `text`; `moved`, whether `text` differs
from the compiled one. `items`, one per name, sorted by group then label (in a group, here and without a dot: the names
without a leading `_` first, then by the label ignoring case, then by UTF-16 code unit, so that dmd's
`Expression._init()` comes last among the members of an `Expression`): `{ label, kind, detail, documentation, group }`,
`kind` an LSP name (`method`, `function`, `field`, `property`, `variable`, `constant`, `enumMember`, `enum`,
`struct`, `class`, `interface`, `module`, `typeParameter`), `detail` the hover's signature on one line (`(+N overloads)`
after a member function's first overload), `documentation` the doc comment's summary as `DocComment.parse` splits it
(the hover's), on one line: of the overload the item shows (a UFCS candidate's, the one taking the receiver), else of
the name. Group 0, the members: a value of aggregate type (through a pointer; an enum value as its
base type) every member of its table, its template mixins' and base classes' (object.Object's for a class) and, one
level, its `alias this`'s, and of its methods only those callable on it, mutable or not (static, or declared with a
`this` qualifier the value's converts to: no `immutable` method on a mutable value); a type its static members, an enum
its members; a module its members and its public imports'; a package its modules and subpackages the compile loaded and
its package.d's members (`std.algorithm.` gives `map`); not constructors, destructors, postblits, invariants, unittests,
compiler-made names, imports. Visibility is approximated: `private` from its own module, `package` from a module of its
package, `protected` from its module or a class derived from its own. Group 1, for a value, the UFCS candidates the
index knows: the module-level functions of the file's module, of the modules it imports (their public imports followed),
of its selective imports and of the function-local imports before the dot, whose first parameter takes the receiver as D
passes it: the same type with its qualifiers converted as D converts them (mutable to mutable, `const` or `inout`;
`const` to `const` or `inout`; `immutable` to `immutable`, `const` or `inout`; `shared` only to `shared` forms; through
a slice's or a pointer's target, `int[]` to `const(int)[]`), a derived class by value, the qualifier dropped by a copy
of a type without mutable indirections (decided from the analysed fields: a `const` struct of an `int` and a `string`
passes to a by-value parameter of the struct, one holding an `int*` does not), a `ref` parameter the same type with its
head qualifier converted; and the function templates of which the last compile made an instance with such a first
parameter. No other conversion, no template constraint: object.d's `setSameMutex(shared Object, ...)` is not offered for
a plain class value. Group 2, the built-in properties of the spec's fixed lists: every type's `init`, `sizeof`,
`alignof`, `mangleof`, `stringof`; an array's `length`, `ptr`, `dup`, `idup`; an associative array's `length`, `keys`,
`values`, `byKey`, `byValue`, `byKeyValue`, `get`, `remove`, `clear`, `dup`; an enum's and an integral type's `min`,
`max` (an enum value's typed as the enum); a floating type's `infinity`, `nan`, `dig`, `epsilon`, `mant_dig`,
`max_10_exp`, `max_exp`, `min_10_exp`, `min_exp`, `max`, `min_normal`, `re`, `im`; a class's `classinfo`; an aggregate's
`tupleof`; the detail the type where the spec fixes it. Misses: the file is not in the last compile; the position is
outside the text; the dot in a comment or a literal, or after a number; the function at the moved position not
analysed; the expression not resolved (``the expression before the `.` is not resolved: <the link and why>``), or
resolved to different types by a template's instances: never a guess.
Not covered: a template instance (`Box!int.`), a call with arguments, a basic type's keyword (`int.`), a builtin
property as a link (`a.length.`), a bare leading `.` (no link after it). Cost, dgpro07 labserver.d under `-i`, at a load
of 4: ~50 ms when the request builds the file's index; after it a struct value's 35 items (28 members) ~3 ms, std.file's
44 members ~2 ms, an enum's 10 items ~0.1 ms, a string's 71 (64 UFCS candidates, `const(char)[]` parameters among them)
~5 ms; with the dot typed after the compile (the request's text scanned, ~2 ms) the struct's ~4.4 ms, an unresolved name
~1.8 ms; RSS +5 MiB over them all. In a template's body the chain is resolved in every analysed instance's copy (a few
table lookups per link each, stopping at the first disagreement; what the copies share is found once):
std/format/internal/write.d's every `.`, 1757 requests, ~0.5 ms mean, ~12 ms the slowest after the index build
(`getNth`'s body ~5 ms); every `.` of the compile's 349 files, 138767 requests, none over 71 ms (an index build), and
the kept compile after them equal to the one before.

The names in scope, the same `queryCompletion(file, text, position)` where no `.` precedes the identifier being typed (a
`..` is a slice's, not a member access) or nothing is typed: `{ result: { range, items, moved } }`, `range` the
identifier typed up to the position (empty with nothing typed). The scope is found as after a dot, at the position moved
through the two texts (of a template's instances, the first analysed copy), and the answer is the last compile's: a
local typed since is offered after the next one. One item per name, the innermost declaration winning, sorted by group
then label. Group 0, the locals and parameters of the functions holding the position, a nested function's then its
enclosing ones' (those the walk met and, at their own locations, those of the function's table it did not: a body with
errors, nested functions and aggregates), declared before the position in a block still open there (on the text: no `}`
closing it in between) or, declared in a statement's parentheses (`foreach (x; ...)`, `if (auto x = ...)`,
`catch (E e)`), within that statement; a template instance's parameters (`T`); a function-local renamed import's name
(`io` of `import io = ...;` before the position). Group 1, the members of the aggregate whose member function holds the
position: `this`'s as `this.` gives them (the methods its qualifier may call, its `alias this`'s), a static member
function's static members. Group 2, the module's own members, private ones included, and the names its imports declare
(`std` of `import std.stdio;`, `io` of a renamed import, a selective import's name). Group 3, the members of the modules
it imports visible from it (visibility as after a dot), their public imports followed, object.d's included, and of the
function-local imports before the position (a selective one's names). Not the keywords (the grammar's), nor the
compiler's names. Each item as after a dot: kind, the hover's signature on one line with `(+N overloads)` after a
function's, the doc summary. Misses: the position in a comment or a literal, or in a number; the function at the moved
position not analysed. Cost, dgpro07 labserver.d under `-i`, at a load of 25 to 45: ~1520 items (3 to 9 locals, 146
module names, ~1375 imported); the first request after a compile ~80-115 ms besides the index build (~130-165 ms at that
load), each module's entries listed once per compile and an item printed at its first need; later requests ~2-10 ms in
djs-vscode's worker, ~5-45 ms round trip (the items copied back); RSS +5 MiB.

The outline of a file, `queryDocumentSymbols(file, text)`: `{ result: { symbols } }` or the misses of the whole-file
queries (not in the last compile; `stale`). A symbol is `{ name, kind, detail, range, selectionRange, children }`,
each level sorted by position; `kind` is LSP's name (`module`, `namespace`, `class`, `struct`, `interface`, `enum`,
`enumMember`, `function`, `method`, `constructor`, `property`, `field`, `variable`, `constant`, `typeParameter`), the
selection the declaration's name, the range from the first token of its line (back to a `;` or a brace) to the end of
its block or its `;`. The tree comes from the module's members as the compile left them: the module declaration, one
`imports` node per scope, aggregates, enums, templates and template mixins with their members, functions with the
functions, aggregates, enums and templates their bodies declare (from the index: of every analysed copy, none in a body
no analysis ran), variables, aliases, enum members, and the special functions by their D spelling (`this`, `~this`,
`this(this)`, `static this`, `invariant`, `unittest`). A template with an eponymous member is one node of the member's
kind, its parameters before the member's detail; another template is a `namespace`. Attributes are transparent; of a
`version`, `debug` or `static if` only the branch the analysis chose (both when none was decided, as in a template's
members): a declaration in a branch not chosen is absent, as it has no semantic tokens. A `static foreach` gives its
expanded members, a string mixin its declarations at its own range with `(mixin) ` before their detail, a template
mixin its members at its range. The detail, cut at 60 characters: a function's type, a variable's, an enum's base
type, an enum member's initializer as written, an aggregate's bases, an alias's target, a template's parameters. The
compiler's names and the functions it generates (a struct's `opAssign`) are not shown.

The references of the symbol at a position, `queryReferences(file, line, character, text)`: `{ result: { name,
references } }` or the hover's misses; a reference is `{ file, range, declaration }` (the file as the compiler names
it, the identifier, whether it is the declaration's own name), sorted by file and position. The modules searched are
those the last compile analysed: its roots and the modules `-i` compiled, not those only imported, whose function bodies
no analysis ran. The target is the token's symbol as the semantic tokens find it (the index's hit, else the read-only
fallback: a folded enum member or manifest constant is found), a template instance standing for its template, a
constructor named by its aggregate's name (`S(1)`, `new S`) for the aggregate; or a template's parameter, when the token
is in the extent of a template declared in the file that declares that name and is not after a `.`. A symbol is
identified by its declaration's identifier, so a template's member and its copies in every instance, a function
template and its instances' functions, are one; one without a location (or declared in a string mixin) by itself, a
string mixin's declaration listed at its name inside the literal where the definition finds it there. Every
occurrence of the name in code is a reference when a hit there, or the token's symbol, has the target's identity (or
is a constructor of the target's aggregate): a call through UFCS, a property call, a member of an instance, a selective
import's name, the target of an alias as written. A template parameter's references are the occurrences of its name in
the template, outside a nested template that declares the same name. Not found: uses in a module only imported, in a
branch not chosen, in a body no analysis ran (a template without instances), names spelled by a string mixin's text,
and implicit uses with no token of the name (an operator's `opBinary` at `+`, a `foreach` range's `front`). Cost: the
index of each analysed module whose text holds the name (built by the first query on it after a compile), then one
lookup per occurrence.

A rename, `queryPrepareRename(file, line, character, text)`: `{ result: { range, placeholder } }`, the identifier and
its text, or a miss whose reason says why it cannot be renamed; `queryRename(file, line, character, text, newName)`: `{
result: { newName, edits } }`, an edit `{ file, range }` per reference of `queryReferences` (the declaration's name
included), each replaced by the new name. Refused, so that no use is left behind: a module or package (renamed with its
file); a constructor or another special function; a name D calls with no token of its own (the `op` names, a range's
`front`, `back`, `empty`, `popFront`, `popBack`, `save`, `length`, `toString`, `toHash`); a symbol declared in a string
mixin or without a declaration; one declared in a module the last compile only imports (the bundled import tree, a
module outside `-i`), whose other users no analysis saw; a name that a string mixin's text spells as a word in a
searched module (a token string, or a literal in a `mixin (...)`'s arguments: a string built elsewhere and mixed in is
not seen); a symbol whose name is spelled as a word in an inactive branch of a searched module (the references do not
look there, and a build for a target that compiles the branch would break; a template parameter's references are textual
and include them). Not checked: a function body no analysis ran (a template without instances), whose uses the
references miss too. The new name must be a D identifier, not a keyword, not starting with `__`, and not one the
symbol's scope already declares (a template parameter's: not spelled in the template); a clash among a function's locals
is not checked, and the next compile reports it.

The signatures of a call, `querySignatureHelp(file, line, character, text)`: `{ result: { signatures, activeSignature,
activeParameter } }` or the hover's misses, `not inside a call's parentheses`, `no function at the call`. The call is
the innermost `(` open at the position (found backwards over the code, up to the statement's start), its callee the
identifier before it (past `!arg` or `!(...)`). The signatures: the function the compile resolved the call to first
(an instance's function when it instantiated a template: its types substituted), then the rest of the name's overload
set, a template not instantiated for the call as its eponymous function with its parameters as written; with no
resolved call (a call being typed, compiled past the parse error in editor mode) the overload set of the symbol at the
callee; an aggregate's name gives its constructors. A signature is `{ label, parameters, documentation }`: `ret
name(params)` (a constructor's `S(params)`, a template's parameters after the name), each parameter as hdrgen prints it
with its span in the label, the doc comment's summary. The active parameter counts the commas at the call's depth
before the position, plus one for a UFCS receiver.

The unused code, `queryUnused()`: `{ result: { entry, declarations } }`, the entry's name and the declarations of the
program that the entry cannot reach, for the compile's target and flags, each `{ file, range, kind, name, why }` (the
identifier; `function`, `method`, `constructor`, `template`, `struct`, `union`, `class`, `interface`, `enum`,
`variable`; the qualified name, a template's member through the template; `unreferenced`, `only self-referenced`, `only
referenced from unreachable code`), sorted by file and position. Misses: no module of the compile declares a `main` (a
library: what is unused depends on its users), the compile reported errors. The program is the modules the compile
analysed (its roots and those `-i` compiled), D modules only (not a C module, whose headers declare the system's
code, nor a .di), never druntime's and Phobos's. From the roots (the entry, module
constructors and destructors, `crt_constructor`, unittests under `-unittest`, definitions with a foreign linkage,
`export` or `pragma(mangle)`, what module-level code names), liveness spreads along what the analysed code names
(lowered calls and string mixins' code included, and the template instances the program reaches, Phobos's among them),
along the tokens of the user's modules resolved as the semantic tokens resolve them (what CTFE, `typeof`, `is`,
`__traits(compiles)` and constraints folded away), and along the names written where no analysis ran: a branch not
chosen, a unittest without `-unittest`, a body not analysed, and, where a module spells `mixin(` or `__traits(`, string
literals. Precision before recall: a name in doubt keeps every declaration so named live. A live aggregate keeps the
members the compiler and druntime call (destructor, postblit, copy constructor, `opAssign`, `opEquals`, `opCmp`,
`toHash`, `toString`, invariant, `alias this`); a virtual function is live when its class is and a member of its
override family is named, or the family reaches a function outside the user's modules (`Object.toString`). Reported:
functions, templates, aggregates, enums, mutable module and static variables (not `extern`), the outermost unused one
only; not
fields, locals, parameters, enum members, manifest constants, `const` or `immutable` variables, aliases, string mixins'
declarations, unittests, imports. A declaration only a module the compile does not import uses is reported (unused in
this program). Cost (src/query.ts header): a walk of the user's modules and the reached instances, and every token of
the user's modules resolved; a large application under `-i` (165 D modules), ~0.8 s right after a compile, ~0.45 s once the indexes are built.

How the symbol is found (src/query.ts header): per file and per compile an index, built at the first query on the file
and dropped when the next compile starts, from a walk of the module's analysed AST and of the members of the template
instances and mixins whose template is in the file, maps each identifier token to the symbols of the nodes there. A
node's location is moved to its identifier on the file's bytes: a member access is at its `.` (dmd/parse.d parsePostExp)
or, after analysis, at its chain's leftmost operand or at the `(` of the call it applies to, and is then keyed at its
own `.name` along the chain (`a.x.x`: each `x` its own member); a call is at its `(`, an aggregate or a template at its
keyword, a parameter at its type. At one token, a symbol whose name is the token's text wins over a lowered one
(`__r12`, a `__ctor` call at a struct's name, the implicit `this`), and a compiler-made name never answers. Where the
analysis leaves no node (an enum member or a manifest constant folded to its value, `S` in `S.f()`, a selective import's
name), a read-only lookup in the symbol tables (`DsymbolTable.lookup`: the enclosing function's, the enclosing scopes',
the module's and the modules it imports; after a `.`, the scope of the symbol before it) answers. The hover, the
definition, the signature help, the references and the rename answer nothing in an inactive branch (the inactive ranges
above; `INACTIVE_REASON`, "in a branch not compiled for this target and flags"), as the semantic tokens and the hints
give nothing there: no analysis ran in it, and the tables around it are the chosen branch's scope, not the one the
branch would see. Completion still answers there, with the names of the compiled scope at the position: a typing aid,
not a statement about the branch's code. The lookup does not answer either where the tables around the position hold
other names: in a function body the analysis did not run (a template's own members, semantic3 not run, a unittest's body
without `-unittest`, which the parser skips), and with a runtime variable or parameter, which no analysis folds away,
except in the body of a function whose analysis reported errors (`hasSemantic3Errors`): an expression with an error
becomes an `ErrorExp` and a statement with one an `ErrorStatement`, which its block becomes, so the index holds none of
their names, and the editor's function being typed is that case. There a name is looked up by position as completion's
first link is (the function's locals declared before it, then the enclosing scopes), outside the inactive branches; a
name found outside the function's locals is not answered when the body's text declares that name, names it as an untyped
lambda parameter, or holds a `with` statement (scopes no table shows). The lookup takes the imports declared in the
function bodies holding the name first (a renamed import's name, a selective one's, a plain one's module), and at a
module what its imports give as dmd's `search` finds it: an imported module's own member, else, recursively, what its
imports that are not private give (`import std.datetime;` gives `Clock`), the symbols not visible from the module left
out; after a `.`, a module's or package's members through its imports and package.d. Where two imports give different
symbols (ldc2 reports an ambiguity, or merges functions into an overload set across modules) it answers nothing: the
hover has one symbol to show, and picking the first would be a guess. A plain import's name answers as its first package
(`std` of `std.file.exists`, as the analysis resolves it), a renamed import's as the import. A runtime variable answers
where the analysis left a node of it under another name, at the token or along the chain before it (`cstdio.stdout`, an
alias of `__stdoutp`; a Tuple's named field `st.terminated`, its `__expand_field_0`). It never answers the words that
are no symbol (`exit` in `scope(exit)`). A runtime variable before `.sizeof`, `.alignof`, `.mangleof`, `.stringof`, or
inside `typeof(...)` (`is(typeof(cl.flag) : bool)`), answers (they keep no node of it), and so does a member after it,
through a pointer too. A template's parameter with no node (its declaration in the parameter list, a constraint, a
`static if` condition, a template's argument) answers with the argument of the instance whose analysed function holds
it, else of the first, the count of instances shown. Two names with no symbol answer the hover alone: a built-in
property of the operand's type (completion's list: kind `property`, its type and the operand's; the operand a basic
type's keyword, a string literal, or the identifier ending it past calls, indexes and template arguments, or a
parenthesised name dereferenced, `(*p).length`; the definition misses with `a built-in property has no declaration`),
and a parameter named in a function or delegate type written in a declaration (`void delegate(int code) cb;`: kind
`parameter`, the definition its own name). Not answered either: a function of a non-root module without `-i` (semantic3
not run), a `catch` the analysis removed (a body that cannot throw: statementsem.d drops its `catch (Exception e)` and
the handler), a parenthesised operand other than a name dereferenced before a built-in property (`(a + b).length`),
symbols inside string mixins. A member of a parenthesised operand answers (`(cast(C) o).f`, `(c).f`): the analysis
locates the access inside the parentheses, and its key is the chain after the `)`. Dgpro07 labserver.d under `-i`, every
identifier token outside keywords, comments and literals (10093): the 779 tokens of inactive branches answer nothing
(`INACTIVE_REASON`); of the 9314 outside them, 9269 hovers answer (99.5%); of the misses, the words that are no symbol
(`version (X)`, `scope(exit)`, `@nogc`), 31, the removed `catch` handlers, 13, and a pointer to an array's `.length`
(`p.length`), 1; counted over all 10093 tokens when the inactive branches still answered, the definition misses where a
hover answered were packages (213, no declaration) and built-in properties (130). Ops net/node.d's 2567 tokens in
unittest bodies, which the compile skipped, answer nothing (695 answered from the module's tables before). Cost: the
index 50-100 ms, a later query under 0.1 ms median (~0.5 ms through the djs-vscode worker).

The doc-comment knob, `DjsOptions.docComments` (default off): `Module.parse` hands the D parser `doDocComment` as `-D`
does (`cast(bool) docfile`, dmodule.d:819), through `Module.djsDocComments`, which the driver sets on every call; the
lexer collects doc comments (lexer.d:738-870) and the parser attaches them (`Dsymbol.comment`). `-D` itself is not the
switch: it adds the `D_Ddoc` version, parses unittest blocks (globals.d:361) and changes templatesem.d:795 and
target.d:130. The knob changes no output: the corpus `--in-process --keep` with it forced on in every compile is every
test in its class against the a28123d measurement, 2669 kept, 0 kept not MATCH; under `-X` it does nothing (the JSON
output prints the comments it finds, and ldc2 without -D collects none). It costs the comments' memory: dgpro07
labserver under `-i`, heap after a full GC 1106 MiB off, 1109 MiB on; RSS 2315-2398 MiB off, 2504-2636 MiB on (two fresh
compiles each, under load). It is part of the kept state's key (`the host options changed`). The proofs:
src/query.test.ts (hovers and definitions after `djsMainKept` and `djsMain`: a local, a parameter, a call, a method
through `.`, a struct type, an imported function and module, a template instance's member and its count, a doc comment's
sections, a `ditto` and an Examples block, a deprecated symbol, a stale text, a file with an error, code the analysis
skipped, a chain of two members of one name, the knob off and flipped, built-in properties (a type's, a value's, a
call's, a string literal's; a `.sizeof` operand), names through a public import and a function's renamed and selective
imports, a template's parameters with no node, a delegate type's parameters, no answer in a unittest body the parser
skipped and the local there with `-unittest`, a plain import's name as its package, a name two imports declare (none)
and a module's own member before its public imports', a parenthesised operand's member and variable, `(*q).length`, an
alias to a runtime variable after a renamed import, a Tuple's named field, a parameter and its member in `typeof`, and
the same hovers and definitions at
every character between two kept compiles; the semantic tokens of each type and modifier, a
member template's calls, a templated constructor and static `opCall`, a user's alias of a library class, the module in a
qualified name, the branches not chosen, a stale text, a file outside the compile, the hover and the definition at a
template parameter in an instance; the inlay hints of each kind and the inactive ranges of declarations, statements, the
`:` form and `else` branches, a chosen branch whose names were folded away keeping its tokens, a tuple expanded in a
call, a speculative instance, a statement after a dimmed function, delimited and token strings, a mixin template; the
expansion sites of each kind, nested ones, two mixins on one line, the peek of each kind, an instance's value argument,
a `static if` of two instances, a lens's range, a self-referential alias in an instance, an expression mixin beside a
`static foreach` one, strings and a float in ranges, literal sources; the Resolved section of each label and its quiet
cases, operators right after an identifier, the unary lowerings at their token, `alias this` to a function, a temporary
left out; the AST view against the `.cg` of -vcg-ast with a variable template argument folded, after a kept compile that
renumbered generated names against a fresh compile, its map both ways, the instances of a file's templates, the imports
with a cycle, an `-i` module and an imported one, the misses of the three, a parse's `__T`, a constructor's `catch`
variable and an anonymous class renumbered, `main`'s `mixin _d_cmain!()` in place after an unchanged kept recompile, an
anonymous class in an instance kept and replayed, the extents of destructors, postblits, literals, static constructors
and invariants, a variable folded and others as written, the imports of a chosen branch, `static foreach`, mixins and an
aggregate, not a function's, the unreached ones by name; the completions of a struct value with a UFCS function and a
template's instance (a non-candidate left out), a class with its base classes', `this.`, `super.`, a type's static
members, a module through a renamed import, an enum's members, a `()` and a `[...]` link, an array's built-in
properties, the misses (an unresolved name, a comment, a number, no dot, a file outside the compile), a request whose
text has the dot typed after the compile, a buffer half-typed before its block's last `}`, locals by position (two of
one name in disjoint blocks, a global shadowed by a later local), a chain across lines and comments, a literal before
the dot, a leading dot after a statement, UFCS qualifier conversions (`ref`, `const`, a slice's target, a basic type's
copy), a function template's instances agreeing or not, locals in a body with errors (two of one name, `foreach`
variables), an `out` parameter used after `if (c) t.x = ...` in a clean body and in one with errors, with a line
inserted above, a qualified copy without mutable indirections, methods by their `this` qualifier, function links needing
arguments or returning `void`, a package.d's members, an enum value's `min` and `max`, a `const` receiver's methods; the
names in scope without a dot (locals by position and block, a `foreach`'s and an `if`'s variable within their
statement, a nested function's and a template instance's parameters, the module's names and its imports', a public
import's, a function-local selective import's, `this`'s members by its qualifier, a static member function's, a
class's with its bases', a body with errors, a name typed after the compile, the misses); a
global a string mixin declares, at its use (the hover, its name in the literal, the references) and in a `return`
with an error; the names of an expression with an error by position, none beside a `with` or a lambda's parameter; the
read-only contract: no `optimize` and no diagnostic during queries (`__ctfe`; hovers at every token, the peeks of an
instance whose code holds an unanalysed manifest constant), a kept module queried after a kept compile parsed its
importer again, and queries, tokens, hints and inactive ranges included, between two kept compiles leaving the second
equal to a fresh compile, the same with the peeks and a hover at every character, with completions, and with the three
queries above, every swap they make undone); djs-vscode's host/query.private.test.ts, host/tokens.private.test.ts
and host/hints.private.test.ts (on private programs, skipped where they are absent), host/fixture.test.ts (its public
fixture), and its integration test.

### 4.8 Targets

ldc2 answers every target question from its target machine's triple (`global.params.targetTriple`,
driver/main.cpp:1239). The shim sets it in `cppmain`: the host's triple with no `-mtriple`, the `-mtriple` one
otherwise, modelled by target.ts `Triple`. The host's triple comes from Node's platform and arch (target.ts
`hostTripleOf`): `arm64-apple-darwin<release>` on an arm64 Mac, `aarch64-unknown-linux-gnu` and
`x86_64-unknown-linux-gnu` on Linux (LLVM's default triples there, not probed: no Linux ldc2 runs here); on any other
host (an Intel Mac, Windows) a run without `-mtriple` is refused, `Error: djs: unsupported host <platform>/<arch>`,
then fatal. Accepted `-mtriple` values: the two Linux triples yab cross-builds for (yab/src/yab/melkor.d:665, :696),
and the arm64 Mac as `arm64|aarch64-apple-darwin|macos|macosx[<version>]`, kept as spelled (LLVM's normalization
leaves these unchanged), its OS major the version's first number, 0 without one; its output is the host's but for the
`-v` config line and the C preprocessor's `-target`, which carry the spelling (probed with ldmd2 on
`arm64-apple-darwin24.0.0` and `aarch64-apple-macos`). x86_64 Darwin is not modelled. The triple decides, each at
the LDC C++ line it ports:
- the predefined versions (`registerPredefinedTargetVersions`, src/djs.ts) and the `-v` config line;
- `Target._init` (gen/target.cpp:129): OS, `real`'s LLVM type (double | IEEE quad | x87 80-bit: `real.sizeof`
  8 | 16 | 16, `realKind`), `RealProperties`, `c.long_doublesize`, `objc.supported` (Darwin only), the
  architecture name, `dll_ext`;
- `va_listType` (`char*` | `__va_list` | `__va_list_tag*`), the ABI trio `toArgTypes`/`isReturnOnStack`/
  `preferPassByRef` (argtypes_aarch64.ts or argtypes_sysv_x64.ts, gen/abi/aarch64.cpp or gen/abi/x86-64.cpp),
  `getTargetInfo("objectFormat")`, `supportsLinkerDirective` (Mach-O only), the bit-field alignment rule;
- `__traits(targetCPU)` / `targetHasFeature` and `D_AVX`/`D_AVX2` (gen/ldctraits.ts, the feature names and CPU tables
  of each arch, with `-mcpu=` as §4.2 says), DMD-style `asm`
  (rejected on aarch64, with LDC's error; kept unanalysed on x86_64, below), `llvmBits` of `real` for
  `LDC_intrinsic` names;
- the C preprocessor (src/driver/cpreprocessor.ts): a cross build looks for `<mtriple>-gcc`, `<mtriple>-clang`,
  then `clang --target=<triple>`; `-m64` on x86_64; `-fno-blocks` on Darwin only. No sysroot is passed, so a
  system header fails to preprocess in both compilers alike unless the command line passes one. `-P=--sysroot=<dir>`
  alone is enough for `#include <stdio.h>` to resolve against `<dir>/usr/include`; on yab's full line, which also
  passes `-P=-isystem` for both include directories, it changes nothing (the same `.i` bytes and search list,
  probed on the debian_13 aarch64 sysroot). `-gcc=clang` drops the fallback's `--target=<triple>`: clang then
  preprocesses for the Mac unless `-P=--target=<triple>` follows, as yab's lines pass it.

DMD-style `asm` on x86_64 is a declared divergence. LDC analyses each instruction with its x86 parser
(gen/asm-x86.h, gen/asmstmt.cpp), which is GDC-derived under the Artistic license or the GPL and is not part of djs
(LICENSE). djs's own `asmSemantic` (src/gen/asmstmt.ts) keeps the statement as an opaque `InlineAsmStatement`: the
parser has already delimited the block on tokens (nested braces, string and character literals), labels inside it
are declared by `visitCompoundAsm`, and `naked` still marks the function naked; no operand is analysed. The module
gets one warning, `inline assembly is not checked by djs (x86 DMD-style asm parser not included, see LICENSE)`, at
its first ungagged DMD-style instruction, through `warning()`: silent by default, printed under `-wi` and `-w`, and
never counted as an error (under `-w` ldc2 compiles the module). What a reader loses: no error inside an instruction
(ldc2's fail_compilation asm tests are MISMATCH on the x86_64 lane), no label created by an instruction alone, no
closure made by a local used only in asm (`-vgc`, `@nogc`), no deprecation or visibility diagnostic for a symbol
used only in asm. A clean module's output under the default switches, `-vcg-ast` included, is ldc2's. The
one-per-module set is keyed on the `Module` object: a fresh compile starts empty, and a kept module, whose warning
the engine replays, does not warn again for a live instance.

What stays the HOST's: CTFE computes `real` in ldc2's `real_t`, the Mac's double (root/ctfloat.ts), whatever the
target's `real` is, and on a Linux host too (where that host's ldc2 would differ on x86_64, its `real_t` x87). So
under a Linux triple `real.max` is `inf` and `real.min_normal` is `0`: gen/target.cpp parses the target's limits
into the host double, which overflows and underflows (probed). Host arithmetic also
decides CTFE integer and float conversions (arm64 semantics, 09 §6.2.1), and paths, the import tree and ldc2.conf
are the host's.

The oracle is `ldmd2 -mtriple=<t> -c -o-` from the same install, frontend only (no sysroot). The corpus runner's
`--mtriple <t>` (§4.5) passes `-mtriple=<t>` to both compilers where d_do_test puts `-m64`, and reads the headers
as a native run on that target (OS=linux).

## 5. `TEST_OUTPUT` block format & the comparison contract

### 5.1 The block format (real example)

`tests/dmd/fail_compilation/aa_assign.d`:
```d
/* TEST_OUTPUT:
---
fail_compilation\aa_assign.d(11): Error: associative arrays can only be assigned values with immutable keys, not `char[]`
---
*/
```
- Delimited by `---` lines inside a comment.
- The path uses `\` (Windows separator) in the source — the runner normalizes
  separators (§5.2), so on POSIX it compares against `fail_compilation/aa_assign.d`.
- Multi-line blocks list every expected diagnostic in order, including supplemental
  `       ` lines (`attributediagnostic.d`).

Directives that accompany it (corpus headers):
- `REQUIRED_ARGS:` — extra compiler flags (e.g. `-vcolumns`, `-verrors=...`).
- `TEST_OUTPUT_FILE:` — expected output stored in a separate file.
- `EXTRA_FILES:` / `EXTRA_SOURCES:` — additional inputs.
- `TEST_OUTPUT(linux):` etc. — platform-specific expected output.

### 5.2 How the runner compares (decisive — this defines "byte-for-byte")

From `d_do_test.d`, the comparison is **whole-output equality** with escapes, after
three normalizations on each side:

**On the captured compiler output** (`prepare`, `d_do_test.d:1942`):
1. `unifyNewLine()` — `\r\r\n|\r\n|\r|\n` all → `\n` (`d_do_test.d:1081`).
2. Strip the DMD debug banner line `^DMD v2\.[0-9]+.*\n? DEBUG$` (`d_do_test.d:1948`).
3. `strip()` leading/trailing whitespace.
4. Replace the results-dir path with `{{RESULTS_DIR}}` (`d_do_test.d:1951-1953`).

**On the expected `TEST_OUTPUT`** (`findOutputParameter`, `d_do_test.d:420`):
- `unifyNewLine().unifyDirSep(envData.sep)` — path separators normalized to the
  host's, restricted to words ending in `.d`/`.di`/`.mixin`/`.c`/`.i`/`.h`.

**Then `compareOutput(captured, expected)` (`d_do_test.d:1420`):**
- If expected is empty → pass iff captured is empty.
- Otherwise scan expected for special sequences; between sequences it is a literal
  **`refoutput == output`** equality check (`d_do_test.d:1436`). **The whole output
  must match — it is NOT a substring search.**

Special sequences (escapes) in `TEST_OUTPUT` (`d_do_test.d:1397`):

| Sequence | Matches |
|---|---|
| `$n$` | any run of digits (compiler-generated ids, line numbers that vary) |
| `$p:<tail>$` | a real path ending in `<tail>` (must exist on disk) |
| `$r:<regex>$` | text matching `<regex>` (no `$` allowed inside) |
| `$?:<cond>=<text>\|<default>$` | environment-conditional (OS: `posix`/`windows`; Model: `32`/`64`) |

### 5.3 What this means for the port (the actionable contract)

To pass an existing `fail_compilation` test **unchanged**, the shim's combined
stdout+stderr — after `unifyNewLine` + DEBUG-strip + `strip` + RESULTS_DIR
substitution — must equal the test's `TEST_OUTPUT` (after separator unification),
modulo the `$n$`/`$p:`/`$r:`/`$?:` escapes.

Concretely, the port MUST reproduce:
1. **Exact location prefix** (§3.2) — including columns-only-with-`-vcolumns`.
2. **Exact header** (§3.3) — `Error: `, `Warning: `, supplemental `       `.
3. **Exact message bytes** (§3.5) — verbatim format string + `toChars()` args + no
   digit grouping + backtick handling.
4. **Source-line + caret** (§3.6) when in default `printErrorContext` mode.
5. **Diagnostic ordering** — diagnostics appear in the order the frontend reports
   them; the SCC translation order (`translation-order.md`) does not change report
   order, but a wrong sema traversal does. If your port reorders two errors, the
   whole-output equality fails even though both lines are present.
6. **Nothing extra** — no stray debug prints, no trailing diagnostics. `strip()`
   removes leading/trailing whitespace but not interior noise.

**Invariant:** because the comparison is whole-output equality, an *extra* correct
line is as fatal as a *missing* one. The shim must emit exactly the diagnostics the
frontend logic produces — no more, no less. When in doubt about whether a branch
emits a diagnostic, port the branch faithfully rather than adding or removing one.

### 5.4 Generating new `TEST_OUTPUT` for ported unit tests — don't

`AUTO_UPDATE=1` regenerates `TEST_OUTPUT` from the *current compiler's* output. The
port must **match the existing** upstream `TEST_OUTPUT`, never regenerate it from
`djs`. If `djs` output and the existing `TEST_OUTPUT` disagree, that is a port bug
(or a flagged platform difference) — STOP and investigate, do not `AUTO_UPDATE`.

---

## 6. Quick reference

| Task | Rule | Cite / source |
|---|---|---|
| `dmd/x.d` unittests | → `src/dmd/x.test.ts`, co-located | house style |
| bare `unittest{}` name | `test("unittest#N")` (1-based, source order) | — |
| `@("name") unittest` | `test("name")` | `array.d:698` |
| unittest of deleted engine internal (reimplemented runtime module) | DROP + comment naming the symbol | `stringtable.d:33-39` (`nextpow2`); `08-runtime-lib.md §5` |
| unittest of observable contract (reimplemented runtime module) | port normally | `stringtable.d:407` |
| unittest reaches a D module-private member | emit member non-private + `// D module-private` | §1.7, `01-conventions.md` |
| `assert(c)` in unittest | `expect(c).toBe(true)` | — |
| `assert(a==b,"m")` in unittest | `expect(a,"m").toBe(b)` | — |
| `assert(c)` in code | `assert(c)` helper, throws `AssertError` | `/tmp/passert.d` |
| `assert(0)` | `assertUnreachable()` | `mtype.d:430`, `errors.d:836` |
| location prefix | `writeSourceLoc` | `location.d:196` |
| default style | digitalmars, columns OFF | `ldc2` probe |
| `(line,col)` only with | `-vcolumns` | `aa_init.d:2` |
| error header | `"Error: "` | `errors.d:661` |
| supplemental header | `"       "` (7 spaces) | `errors.d:656` |
| printf owner | `dmdformat(fmt, args)` → `DString` | `src/dmd/root/dmdformat.ts` |
| format specifiers | `%s %.*s %d %i %u %lld %llu %x %X %llx %o %llo %c %zu %%` + width/precision/flags | `outbuffer.d:584`, `/tmp/pfmt.d` |
| `%f`/`%g`/`%e` | STOP-stub (C float conversions deferred) | §3.5 |
| `%s` / `%.*s` NUL | stops at first NUL (trims `extractChars` terminator) | §3.5, 08 §9 |
| `%s` argument | a `.toChars()` display string | `typesem.d`, `08-runtime-lib.md` |
| `%d` grouping | none | `/tmp/pfmt.d` |
| stderr FFI (`fputs`/`fprintf`/`vfprintf`) | one `process.stderr.write(dsToJs(dmdformat(...)))` | §4.4, `errors.d:489` |
| gag counters | `startGagging`/`endGagging`/`increaseErrorCount` | `globals.d:459-494` |
| caret column | display column (tab=4, unicode=1) | `errors.d:740` |
| `fail_compilation` exit code | 1 | `d_do_test.d:738,1060` |
| `compilable` exit code | 0 | `d_do_test.d:1048` |
| TEST_OUTPUT compare | whole-output equality + `$n$`/`$p:`/`$r:`/`$?:` | `d_do_test.d:1420` |
| output normalizations | unifyNewLine, DEBUG-strip, strip, RESULTS_DIR | `d_do_test.d:1942` |

---

## 7. Open items for synthesis (flagged)

- **`version(unittest)` build duality** (`_config.md` flag #3): whether the shipped
  shim carries test-only helpers. This doc assumes Vitest builds with
  `version(unittest)` ON (test files always present). If a two-build decision is
  made, the co-location convention is unaffected but tree-shaking of `.test.ts`
  imports must be confirmed.
- **`message`-kind to stdout vs stderr ordering** (§4.1): the runner captures both
  and concatenates per process buffering; if a test interleaves a `message` (stdout)
  with errors (stderr), the captured interleaving may be buffer-order-dependent. Not
  observed in the sampled corpus, but flag if a CTFE `pragma(msg)` test mixes
  streams.
- **CTFE `assert` inside user code**: this doc covers the *frontend's own* `assert`.
  The frontend *implements* `assert` evaluation for user code in `dinterpret.d`
  (CTFE) — that is ported as the interpreter algorithm (core SCC,
  `translation-order.md §2.2c`), not via this doc's `assert` helper. Don't conflate.
- **Syntax-highlight color path** (`errors.d:848-1046`, `colorSyntaxHighlight` /
  `writeHighlights`): only taken when a TTY console is attached. The shim writes to
  a pipe (no TTY) so this path is dead for the corpus. Port `unescapeBackticks`
  (always taken on the non-TTY path); the ANSI/`Console` color machinery is
  lower-priority and can be stubbed — STOP if a test asserts colored output (none
  observed in `fail_compilation`).
