# 11 — STOP-and-Escalate Protocol & Not-Covered List

> **STOP rule (read this first):** if you meet ANY construct not documented in this
> guide, ANY ambiguous mapping, or ANY case where you would have to GUESS — you MUST
> STOP and emit a structured escalation (§2). Never produce a plausible-but-unverified
> translation. A wrong-but-compiling compiler translation is far worse than a halt.

This document is referenced by every other doc in the guide. Read `_ground-truth.md`
first. Cross-references: cycle/stub handling `01-conventions.md`; type mapping
`02-types.md`; value semantics `03-value-semantics.md`; numerics `09-numerics.md`;
compile-time resolution (`static if`/`version`/`mixin`/`__traits`) `07-compile-time.md`;
runtime containers `08-runtime-lib.md`; excluded-module strip list `translation-order.md §4`.

---

## 0. Why this protocol exists (the cost asymmetry)

You are one of many parallel agents producing a **faithful structural port of a
compiler**. The output of a compiler is read by *every downstream program*. A
translation error does not announce itself: the ported frontend keeps compiling,
the test suite keeps passing on the cases that happen to exercise the correct paths,
and the bug surfaces only as a *silently wrong compile outcome* — a type that
resolves differently, a CTFE fold off by one bit, an overload chosen wrong, a
diagnostic emitted (or suppressed) when it should not be.

This is the worst possible failure mode for this project:

- **A halt is cheap and visible.** An escalation costs Paolo two minutes to adjudicate,
  and the decision is recorded once and reused by every future agent.
- **A wrong translation is expensive and invisible.** It corrupts the output of the
  tool whose entire job is to be correct, it passes some tests while breaking others,
  and it is discovered (if ever) far from its cause, after hours of misdirected debugging.

Therefore the rule is **asymmetric on purpose**: when in doubt, STOP. Guessing is never
the lower-risk option here. "It looked right and it compiled" is not evidence of
correctness for a compiler port — it is exactly the trap this protocol exists to prevent.

This mirrors the project's verification discipline: an assertion stated plainly means
it was verified; anything unverified is marked or escalated, never asserted as fact.

---

## 1. STOP triggers — escalate on ANY of these

You MUST stop and escalate (do **not** emit a translation) when the file you are
porting contains any of the following. Each row says *why* it is a trap and *which doc
owns it* if it is in fact covered elsewhere — if it is covered there, follow that doc;
if that doc also defers or the case is outside what it documents, escalate here.

| Trigger | Why it is a trap (escalate unless the owning doc resolves it) | Owner doc |
|---|---|---|
| **Construct not documented in the guide** | No canonical translation exists yet → any choice is a guess. | — escalate |
| **Ambiguous mapping** (two plausible translations, none stated canonical) | Parallel agents would diverge; the port must be deterministic. | — escalate |
| **`mixin` too dynamic to resolve statically** | If the mixed-in string is not computable at translation time against the fixed config, you cannot emit faithful TS. | `07-compile-time.md` resolves the static ones; if it can't, escalate |
| **`__traits` not statically resolvable** | A reflection query whose result depends on data not fixed at translation time. | `07-compile-time.md`; else escalate |
| **Exotic template constraint** (`if (...)` on a template you cannot evaluate, recursive/variadic CT logic, SFINAE chains) | Monomorphization requires knowing the instantiation set; if you can't enumerate it, you'll guess. | `02-types.md`/`07-compile-time.md`; else escalate |
| **Inline assembler** `asm { ... }` (`AsmStatement`, `InlineAsmStatement`, `GccAsmStatement`) | Its semantic is ported (`iasm/gcc.d`, LDC's `asmSemantic`); its codegen is not. | §3.2 |
| **SIMD / `__vector(T)`** (vector types, `VectorExp`) | No portable JS semantics; layout + lane ops are codegen-level. | §3 (out of scope) |
| **Pointer arithmetic beyond a simple ref** (`p + n`, `p[i]` on a raw `T*`, `&arr[i]`, pointer diff, `cast(T*)`) | JS has no pointers; a single object-ref translation silently loses address arithmetic. | §3 + escalate the specific site |
| **`union` value-layout that matters** (overlapping fields read/written through different members; type-punning) | A naive "object with all fields" loses the aliasing — writing `intvalue` MUST be visible through `unsvalue`. | §3 + escalate |
| **Anonymous `union`/`struct` whose layout is load-bearing** | Same as above; nested anon aggregates used for memory reinterpretation. | §3 + escalate |
| **Alignment that affects observable behavior** (`align(N)` used for layout/punning, not decoration) | If alignment changes a size/offset the code reads, dropping it corrupts results. | §3 |
| **Bitfields** (`mixin(generateBitFields!(...))`, C `int x : 3;`) | Packed bits accessed via shift/mask; a per-field translation must reproduce the exact bit layout or storage size queries break. | §3 + escalate |
| **GC finalization ordering** (`~this` whose *order* or *timing* relative to other dtors is relied upon) | JS GC is non-deterministic and unordered; any logic depending on finalization order is unportable as-is. | §3 |
| **Weak references / `core.memory` GC hooks** | No portable JS weak-ref-with-finalizer matching D's semantics for our needs. | §3 |
| **A previously-ported dependency's signature is not D-faithful** (a re-homed free function, a collapsed nullable field, a missing export) so the faithful call site cannot be written | The defect is in ANOTHER agent's file and the single-writer rule forbids fixing it there. Emit the closest expressible form with an audited comment at the site, and file `category: dependency signature` — these batch for ONE integrator adjudication and sweep when the owner file is retranslated. | — escalate (`dependency signature`) |
| **A deferred symbol in a SELECTING condition** (the unported value chooses among two or more live arms you would have to guess at) | A wall on one arm decides which arm D takes; a wall on the whole condition blocks paths D lets pass. Either shape encodes a guess about control flow. | §2.5 splits this case — escalate here (`selecting condition`) only for the selecting half |
| **A bodiless `extern(C++)` declaration under an ON `version`** (the body lives outside D — LDC's `gen/*.cpp`) | The §2.5 test gives the wrong answer if you read only the D declaration: no amount of future D porting ever produces the body, so a wall would never sweep. | §2.5 (bodiless-`extern(C++)` bullet) — escalate (`external implementation`) |
| **ANY case where you would GUESS** | Catch-all. If you cannot cite the rule you are applying, you are guessing. | — escalate |

**Operating rule:** if a trigger's owner doc gives you an explicit, decisive rule that
covers your exact site, apply it. If it does not — if your site is a variant the doc
didn't anticipate, or the doc itself says "escalate" — STOP and emit the escalation below.
Do not stretch a rule to cover a case it does not literally address.

---

## 2. The structured escalation format

When you stop, do **two** things:

1. **In the emitted TS**, at the exact translation site, leave a STOP stub so the port
   does not silently compile past the unresolved construct, and so it is greppable:

   ```ts
   // DJS-ESCALATE: <one-line construct summary>  (dmd/<file>.d:<line>)
   throw new Error("DJS-ESCALATE: <construct> (dmd/<owner>.d:<n>) at dmd/<f>.d:<n>");
   ```

   **The thrown message identifies the SITE, exactly as a wall message does.** A
   site-anonymous string ("not translated — see escalation report") is thrown identically by
   dozens of files, so a test pin landing on one cannot say which escalation fired. `<owner>.d:<n>`
   is where the blocking construct is DEFINED; `<f>.d:<n>` is the translation site (they coincide
   when the blocker is in the file you are porting). Anonymous stubs predating this rule are
   upgraded opportunistically, when their file is next owned.

   For a stripped excluded-module call site (§3), use the same stub but tag it
   `// DJS-ESCALATE(excluded): <module> — <construct>` so the two categories are
   distinguishable by grep.

2. **Return** (as your agent's final message to the orchestrator) the escalation
   record in this exact field set. One record per blocking construct. Be terse and
   factual — this is data Paolo adjudicates, not prose.

```
ESCALATION
  file:       dmd/<file>.d
  line:       <line>  (or <start>-<end> for a block)
  construct:  <the D construct, verbatim or a tight excerpt — keep it short>
  category:   <one trigger name from §1: e.g. "union value-layout", "inline asm",
               "dynamic mixin", "pointer arithmetic", "bitfields", "exotic template
               constraint", "selecting condition", "external implementation",
               "dependency signature", "undocumented construct", "ambiguous mapping">
  why_blocked: <one or two sentences: the specific reason a faithful translation
               cannot be produced without a decision — name the invariant at risk>
  tried:      <what you considered and why each option is unsafe/ambiguous; cite the
               guide doc you consulted and why it did not resolve this site. If you
               ran an ldc2 probe, give the probe and its result.>
  blast_radius: <what depends on this site if guessed wrong — e.g. "all CTFE of struct
               literals", "every token's literal value", "only -vtemplates diagnostic">
```

**Marker mechanics (greppable by construction):**

- The `DJS-ESCALATE` marker line MUST carry the D `file:line` **on the marker line itself** —
  that is what separates a real stub from prose. Text elsewhere (headers, reports, comments)
  never repeats the token; refer to "the escalation for X" instead.
- **The marker table** (also in the cheatsheet): §2 blocker ⇒ `DJS-ESCALATE`; §2.5 deferred
  callee ⇒ `TODO-BODY`; faithful D `assert(0)` ⇒ `assertUnreachable()` and NEITHER token;
  **callee ported but UNREACHABLE** (not exported, or re-protocoled so the faithful call cannot
  be written) ⇒ §2 `dependency signature`, **never** `TODO-BODY` — no future porting event
  repairs it, because its owner is already ported. Reviewers check the categorization by grep;
  a wall dressed as an escalation (or vice versa) is a finding.
- **A `dependency signature` escalation carries NO throw and NO marker at the site.** Its
  artifacts are the closest expressible call + an audited comment naming the defect, and the
  record. A reviewer grepping for markers must not read a comment-only site as an unrecorded
  deviation, and a translator must not add a token to make one greppable.
- **`allowUnreachableCode` is unset, and its default is an editor suggestion — never a `tsc`
  error.** It can never justify dropping a D statement: a D `assert(0)` after a `return` is
  still emitted as `assertUnreachable()`. A comment claiming tsc rejects unreachable code
  writes a false fact into the file, which is worse than the dropped statement.
- **Blocked CLASS-BODY expansion** (a mixin the class body cannot emit — no statement position
  for a single throw): the canonical shape is **one stub per generated method**, all citing the
  same D lines, batched under ONE §2 record. Never an empty class body (compiles past
  silently), and never a constructor throw (it falsifies verified inherited behavior —
  `13-visitor.md §5`).
- **A blocker whose site is a FIELD DECLARATION** (no statement position; a ctor throw is
  separately forbidden) takes the sanctioned **marker-only form**: the `DJS-ESCALATE` marker
  line (with its D file:line) on the field, NO throw. When prose elsewhere must reference
  it, write "the escalation on <field>" — never repeat the token.
- **Wall position vs TS narrowing:** an always-throwing IIFE (and any wall as the FIRST
  statement of a block) makes everything after it unreachable and kills control-flow
  narrowing for the rest of the method (~30 spurious null errors in one W2 file). The
  canonical shape for a wall that must sit mid-flow: a SINGLE-USE named local arrow declared
  immediately above its one call site, annotated with the REAL return type (`(): T`, not
  `(): never`), name derived from the D construct. This is explicitly NOT the forbidden
  helper family of §2.5 (one wall, one use, adjacent).
- A wall needed in EXPRESSION position uses the never-returning IIFE
  `((): never => { throw new Error("TODO-BODY: … (dmd/<f>.d:<n>)"); })()` — same message
  rules; prefer hoisting to a statement when the expression allows it.

**Rules for the record:**

- **Never** fabricate the `tried` field. If you tried nothing, say "no safe option
  identified". The honest "I don't know how to do this faithfully" is the correct
  output — that is the whole point of the protocol.
- **One escalation may unblock many sites.** If the same construct recurs (e.g. the
  bitfields mixin appears in eight structs), escalate it once with all the line cites
  in `file`/`line`, note the pattern, and STOP the whole batch rather than guessing the
  rest.
- **Do not partially translate the surrounding file and hope.** If the blocking
  construct is load-bearing for the file's logic, escalate before emitting the rest, so
  a downstream agent does not build on a half-ported file. If the construct is isolated
  (one dead branch, one diagnostic), you may translate the rest and leave only the stub —
  state which case it is in `blast_radius`.

---

## 2.5 How a partial translation records a deferral (walls) — placement is the contract

**The §2-vs-§2.5 decision test (apply it at the site, it is one line):** *if the blocker
disappears the moment some other D code gets ported, it is a §2.5 WALL (a deferred callee) —
a §2 ESCALATION is only for a decision that no amount of future porting resolves by itself*
(an undocumented construct, an ambiguous mapping, a model choice, a `dependency signature`
defect needing an owner-side fix). The pilot's one mis-filed record confused exactly these
two; the test would have prevented it.

**Accounting rule:** an `assertUnreachable()` that FAITHFULLY ports a D `assert(0)` is normal
translated code — it is **not** a wall, never counts in `wallCount`, and is never dressed up
as a TODO-BODY. Walls are throws D does *not* have. The mirror case is the same: a D
`assert(cond)` inside a translated body is ordinary translated code too, whatever it throws —
port it per `06-control-flow.md §2.7` (which owns `assert(x)` in a boolean context) and do not
count it.

When a translation legitimately defers a D branch (an unported callee, a construct scheduled for a
later wave), the deferral is recorded as a **wall**: a throw at the untranslated site. Walls are
part of the port's audit structure, and their PLACEMENT carries the correctness:

- **Walls are INLINE, at the D statement's position — one wall per D branch — and the message
  carries the D `file:line`.** The whole port is built on positional correspondence with the D
  source; a wall is auditable only where the deferred statement lives. **The cite names where
  the deferred callee is DEFINED, not where it is called** — a cite pointing at the call site
  (`dmd/dcast.d:143` for a callee defined at `typesem.d:9225/:9272`) is invisible to the owner's
  end-of-wave sweep grep, which searches by definition.
- **A wall message asserting "not exported" or "module missing" is a VERIFIABLE claim — verify
  it the moment you write it, and re-verify at self-gate**, because the owner file may have
  landed mid-wave. A wall standing over an available faithful export is a **CRITICAL** finding,
  not a cosmetic one: it converts live behaviour into a throw, on unconditional paths as often as
  not. Never write a comment positively asserting a callee "is NOT exported" before running the
  grep — such a comment reads as verified fact to the next auditor, and one wave shipped whole
  files where a third of the walls named callees the tree already exported with a full body.
  `14 §3` item 5 gives the copy-pasteable check; for a wall naming a MODULE as missing, `ls
  src/dmd/<module>.ts` before shipping.
- **Sweeping a wall cites the D line that AUTHORISES the now-live callee**, exactly as the wall
  had to cite the deferred one. A sweep with no cite is indistinguishable from a guess that the
  callee is now good enough.
- **Never factor walls into helper functions.** An invented `guardXxx(...)` family woven through
  translated bodies destroys the positional correspondence, makes every call site something a
  later agent must prove inert, and turns a mechanical fill into an archaeology job. (This
  shipped once: 7 `guardXxx` helpers with 12 call sites; the file was judged cheaper to
  re-translate than to audit.)
- **A deferred callee is replaced by a WALL, never by a narrower stand-in.** Silently
  substituting a hand-picked partial implementation is a silent skip in disguise. If a stand-in
  is genuinely required to keep a phase runnable, it MUST be named `stubFor<DName>`, its
  doc-comment MUST enumerate every effect of the real callee it does NOT reproduce, and the
  omission is a §2 escalation record, not a code comment.
- **A deferred callee with NO semantic effect on the ported subset is DROPPED, not walled.**
  Profiling, tracing and timing callees (`dmd.timetrace`'s `timeTraceBeginEvent` /
  `timeTraceEndEvent`) change nothing a ported program can observe (`deps` is NOT one: `-deps` and
  `-makedeps` output is observable, and deps.ts is ported), so a wall there turns
  an inert call into an unconditional throw — at a module's entry points it takes the whole
  file's tests red. Record the drop with a `// dropped:` comment naming the D file:line, and
  **drop the begin/end pair TOGETHER** so the `scope(exit)` stays balanced and no try/finally is
  needed. Before walling any callee, check whether it is a no-op under `_config.md`.
- **Report a wall's BLAST RADIUS, and never wall an entry point silently.** A walled call at the
  top of a module's primary entry points darkens everything downstream of it: that is a §2
  escalation, not a silent §2.5 record.
- **A bodiless `extern(C++)` declaration under an ON `version` is a §2 escalation, never a wall
  and never a per-file inline.** Under `version(IN_LLVM)` a block of `Target` members are
  bodiless `extern(C++)` declarations (`target.d:1080-1087`: `toArgTypes`, `isReturnOnStack`,
  `preferPassByRef`, `getTargetInfo`, `isCalleeDestroyingArgs`, `supportsLinkerDirective`) whose
  implementations live in LDC's C++ driver; the D bodies further down belong to the `!IN_LLVM`
  arm and are resolved away, so **no amount of future D porting ever produces them** and the wall
  would never sweep. One file inlining what another walls diverges inside a single wave, which is
  why the disposition is ratified once, here. **LDC's `gen/*.cpp` IS in the source tree and is
  legitimate ground truth**: read the live implementation there (`gen/target.cpp:423` settles
  `isCalleeDestroyingArgs`, `:429` settles `supportsLinkerDirective`), and const-fold it for the
  fixed target **only when the result is fixed at TRANSLATION time and the callee is
  side-effect-free on the folded path**. A callee that branches on runtime data is never
  foldable, and re-deriving its branch set is precisely the forbidden narrower stand-in. File the
  record either way; the integrator homes the answer in the owner file, as
  `Target.isCalleeDestroyingArgs` now is in `target.ts`. A C++ body that keeps process state and
  reports (gen/modules.cpp:71 `checkAndAddOutputFile`) is neither foldable nor a codegen drop. The
  record proposes porting the body in the owner file, and the call site stays comment-only until the
  owner lands it. The one sanctioned exception is the ABI
  trio `toArgTypes`/`isReturnOnStack`/`preferPassByRef`: their C++ (gen/target.cpp:342/:347/:350
  → gen/abi/aarch64.cpp:64-87, gen/abi/abi.cpp:78-86) branches on the type and is PORTED AS CODE
  in `target.ts`, the triple folded and every type branch kept, on top of the translated
  `argtypes_aarch64.ts`. A complete transliteration is not a narrower stand-in. Free functions
  declared by an LDC `gen.*` D binding module (`module gen.dpragma;`, `module gen.llvmhelpers;`, `module gen.ldctraits;`)
  are the second sanctioned case: they are ported with their gen/*.cpp bodies in
  `src/gen/<name>.ts` (`01 Rule 1.1`), keeping diagnostics and declaration state and dropping
  codegen-only lines with a comment.
- **A wall may only sit on a path D actually takes into the unported code** — and the guard that
  decides which paths those are may live in the CALLEE, not at your call site. Two shapes recur:
  a callee whose own first statement is a cheap early-out (`deps.d:175` `addImportDep`, now ported) — hoist
  that guard inline and wall only the branch that does work, or the bare wall halts every path,
  including the one D returns from immediately; and an unported function that is the
  IDENTITY outside its feature (historical instance, swept once ImportC entered scope: `importc.d:48`
  `cAdjustParamType`: `if (!sc.inCfile) return t;`) — the D call site is unconditional, so the trap is to wall unconditionally and
  block the path D lets pass. Emit the behaviour D takes and wall only the excluded branch.
- **An unported symbol in a CONDITION splits into two cases, decidable at the site:**
  - **(a) the condition IS the unported call** — alone, or combined with live operands that D
    evaluates in its own order (`if (unportedCall(x))`, `if (live(x) && unportedCall(y))`) →
    **WALL at the call position**, inside the operand D evaluates there. This is precise by
    construction: the wall stands exactly where D would have entered the unported code, and the
    live operands keep their own evaluation and order.
  - **(b) the unported value would SELECT among live arms you would have to guess at** → **STOP
    and escalate** (`category: selecting condition`). Walling either arm decides which arm D
    takes; walling the whole condition blocks the arms D still reaches.
  Reachability test for the (b) call: escalate only if EVERY path D lets pass would hit the
  wall; if a preceding `&&`/`||` operand preserves a fall-through D takes, the wall is legal and
  that fall-through must be pinned. Never widen a wall to a shape test that also blocks paths D
  lets pass. (Nested-condition placement detail: `10-tests-diagnostics.md §1.8` rule 4;
  dispatch-arm walls: `13-visitor.md §7.5`.)
- **Dead state is marked.** If a ported field/visitor slot has D entry points that are not yet
  ported, leave a `// gap:` note at the declaration naming the omitted D file:line — an
  unmarked dead field reads as complete and hides the missing entry points from the next wave.
- **Walls add exit paths D does not have — protect paired state.** A region that acquires state
  and releases it on the way out breaks the pairing the moment a wall inside the region throws,
  even though the D source needs no protection (confirmed bug class: the `noMember` nest counter
  leaked on a wall throw and poisoned every later test in the process). **The port shape is
  chosen by D's OWN release shape** — a plain `finally` is wrong for the dominant instance,
  `global.startGagging()` / `global.endGagging(errors)` (`globals.d:463/:473`), because D already
  calls the release on the normal path (`if (global.endGagging(errors))`), so `finally`
  double-releases, and because `endGagging` returns a value the normal path consumes, which
  `finally` swallows. The three canonical forms:
  - **D consumes the release's return on the normal path at region end → capture-in-finally.**
    `let gagged: boolean;` before the `try`; `gagged = global.endGagging(errors);` INSIDE the
    `finally`; test `gagged` after. TS treats a `finally` assignment as definite assignment, so
    no `= false` initializer is needed (adding one hides a missed path).
  - **D releases via `scope(exit)` → plain `try { … } finally { <release> }`.** The same form
    serves a release at one normal-path line whose result nothing uses (inline.ts `inlineNest`,
    `inlinecopy`, `stageflags`).
  - **Normal-path exits consume the release at DIFFERENT D lines → catch-repair-rethrow.**
    `try { … } catch (ex) { <undo>; throw ex; }`, keeping D's text verbatim at each of those
    lines. Permitted only for that shape. When the region also nests further pairs (a
    `startCTFE`/`endCTFE` inside a `push`/`pop`), the catch unwinds all of them back to the saved
    outer scope, `while (sc !== scx) sc = sc.pop();`: each pair is released and D's normal-path
    text is untouched.
  - **A conditional acquire** (`sc2 = sc.push()` under an `if`, released by `if (sc2 != sc)
    sc2.pop()`) takes the plain `try`/`finally` opened right after `let sc2 = sc`, with D's own
    condition in the `finally`.

  Protection is **mandatory even when the region provably has no early exit today** — any callee
  may acquire a wall later, and the shape is required for the shape, not for today's control
  flow. Four scope rules, each of them a shipped defect:
  - **(a) A wall in a TRANSITIVELY-called module counts.** Grep the callee, not only your own
    region: a region containing no wall of its own still throws if what it calls does.
  - **(b) Protection is per-PAIR, not per-region.** A second counter incremented three lines
    inside an already-protected block is a second pair and needs its own protection.
  - **(c) The guard opens on the FIRST statement of the D region**, not at the first wall. A
    guard opened late satisfies a `startGagging`-plus-`try` grep and still leaks every statement
    above it.
  - **(d) The invariant is "state that outlives the throw", not "module-global state".**
    Enclosing-object state counts: at `templateparamsem.d:163` it is `Scope.pop` →
    `enclosing.ctorflow.OR` plus a dangling by-ref binding. State of an object that is discarded
    by the throw (a `scope` parser instance, dmodule.d:802) does not outlive it, so it needs no
    protection. Say so in a comment at the site.

**Wall shape by position.** The canonical shape (§2, marker mechanics) is a SINGLE-USE named
local arrow declared immediately above its ONE call site, annotated with the REAL return type.
Four positions it does not express, each settled here so parallel agents converge:

- **Expression position WITH ARGUMENTS.** Declare the wall arrow with **D's own parameter list,
  underscore-prefixed**, and call it with the real arguments — call shape and argument evaluation
  order both survive. An argument-less wall arrow silently DELETES the argument expressions (one
  file lost a constructed `ArgumentList` and was caught only by the unused import it left behind)
  and, under `noUnusedParameters`, orphans the enclosing function's own parameters, which is a
  real tsc error. Parameter TYPES are the **D declaration's** (`getDsymbol(RootObject oarg)` is
  walled `(_oarg: RootObject)`, not narrowed to the argument's type at one call site); a stub
  already narrowed is widened by whoever fills it.
- **The same callee at several sites in one function.** One local per (function, deferred
  callee), carrying the D callee's varying parameters, called at each D site with D's own
  arguments. For two calls in ONE statement: two adjacent single-use locals named for their D
  lines, never one shared local.
- **An `else if` CONDITION** — TypeScript offers no statement position above it, so hoisting is
  mandatory here: declare the named local at the **nearest preceding statement position** with
  the REAL return type, plus a one-line PLACEMENT note saying which `else if` it serves. **Never
  the `((): never => { throw … })()` IIFE in this position** — it kills control-flow narrowing
  for the rest of the function (measured: five spurious TS18047 in arms *below* the throw).
- **A DISCARDED return value** (`sd.size(e.loc);`, called purely to force `sizeok`) — annotate
  the D return type anyway. Never `(): void`, never `(): never`.

**Message literals are exempt from the 120-column limit.** The `TODO-BODY:` / `DJS-ESCALATE:`
token and its `(dmd/<f>.d:<n>)` cite MUST stay on ONE source line: splitting the string across
two lines is natural at 120 columns and deep indentation, and it silently defeats the audit
grep. Where the two rules collide the one-line message wins — the carve-out covers the message
literal and its cite, and nothing else on that line.

### 2.6 Declared divergence: the D source reads through a null, or an object of the wrong class

When D dereferences an unchecked `isXxx()` downcast that is null on a reachable path (a node
still of another class at that phase), the source has no defined behaviour there, and ldc2's
optimised build reads the field at that offset in whatever object it actually has. The same
holds when a D `assert` that ldc2's release build drops is followed by a `cast(C)` that
reinterprets a reachable object of another class: port the read the binary makes, and keep the
assert as tight as the observed shape allows (exactly the shape the lowering builds). Port what the
binary does: establish with `.offsetof` on the frontend sources (the `_probes.md` -I/-J recipe)
which field of the actual class sits at the dereferenced field's offset, pin ldc2's output, read
that field by its own name on the actual class, and fail any other class with an `assert`, never
a silent `null`. The site carries an interface comment stating the D defect, the offset proof and
that the port reproduces the binary; the file header lists it as a declared divergence. When the
defect is in frontend source (not LDC-specific), it is also reported upstream to dlang/dmd.
Instance: mangle/cpp.d:2439 `ABITagContainer.forSymbol` — before semantic2 a `@gnuAbiTag` UDA is
still the constructor `CallExp`, `StructLiteralExp.elements` and `CallExp.arguments` both sit at
offset 32, so ldc2 reads `(*callExp.arguments)[0].isArrayLiteralExp()`. Instance: hdrgen.d:1362/:1385
`contractsToBuffer` — under `-checkaction=context` a contract whose condition has side effects is
rewritten in place to `CommaExp(temporaries, AssertExp)` (expressionsem.d:9833, the statements reused
by funcsem.d:2946/:2972), D's `assert(es.exp.op == EXP.assert_)` fails, and since `UnaExp.e1` and
`BinExp.e1` both sit at offset 24, release ldc2 prints `CommaExp.e1`. Instance without a cast:
hdrgen.d:3884 `assert(prec != PREC.zero)` in `expToBuffer`. parse.d's precedence table has no
`EXP.interpolated` entry, release ldc2 drops the assert, and zero < pr parenthesises the `i"..."`
operand. The port widens the assert by exactly that op.

---

## 3. Known-hard / out-of-scope list (with real frontend sites)

These are the constructs known up front to require either exclusion, a human decision,
or special handling beyond a mechanical port. Every one is grounded in a real site in
`/Users/pinver/Projects/Public/ldc-1.43.0/dmd`. **If you reach one of these, do not
improvise — apply the disposition below; where it says "escalate", escalate per §2.**

### 3.1 Excluded modules — never translate; strip or stub the call site

Per `_ground-truth.md §1.8` and `translation-order.md §4`. If you are translating an
in-scope file that *imports* or *calls into* one of these, drop the import and replace
the call site with a STOP stub (or delete the guarded dead branch, when it is the
language feature itself being excluded — record it with the resolved-comment convention).

| Excluded module | What it is | Reached from (in-scope) |
|---|---|---|
| `dtoh.d` | C++ header gen | `cxxfrontend.d`, `mars.d`, `main.d` |

### 3.2 Inline assembler — `asm { ... }`

- **In scope (decision of the advisor, 2026-10-01): the asm semantic ldc2 runs on our arm64 target.**
  `statementsem.d:3727` calls LDC's `asmSemantic` (gen/asmstmt.cpp:100, C++, GDC-derived), written anew as
  djs's own `src/gen/asmstmt.ts`: a GCC-style statement (first token a string literal or `(`) becomes a
  `GccAsmStatement` and goes to `gccAsmSemantic` (`iasm/gcc.d`, translated whole as
  `src/dmd/iasm/gcc.ts`); a DMD-style one errors as ldc2 does on aarch64 ("DMD-style `asm { op; }`
  statements are not supported ...") and stops with `fatal()` unless gagged. ImportC's
  `CAsmDeclaration` reaches `gccAsmSemantic` from `dsymbolsem.d:3378`.
- **Not ported:** LDC's x86 asm parsers (gen/asm-x86.h, the `asmparser->run` leg; GDC-derived, kept out
  by LICENSE: on x86_64 djs keeps the statement unanalysed and warns, 10 §4.8), and every codegen half
  (`AsmStatement_toIR`, gen/asm-gcc.cpp). `ldcbindings.d`'s
  `createGccAsmStatement`/`createInlineAsmStatement` are one-line `new`s, written inline at the
  call site with a cite.

### 3.3 SIMD / `__vector(T)`

- `__vector` is a *language feature the frontend implements* (parse:
  `parse.d:2205`; type check: `typesem.d:1961`; CTFE: `dinterpret.d:5001`,
  `dinterpret.d:5809`; cast: `dcast.d:2168`; `hdrgen.d:4336`). There is **no codegen** in
  the port, and no portable JS vector semantics.
- **Disposition:** the `TOK.vector`/`EXP.vector` constants and the `VectorExp` node
  shell are carried as ordinary AST nodes. Any *semantic/CTFE logic that computes a
  vector value* (lane arithmetic, `__vector` constant folding) is **out of scope** →
  STOP stub at the site, escalate with `category: SIMD/__vector` so Paolo decides whether
  the relevant corpus tests need it at all.

### 3.4 Pointer arithmetic beyond a simple ref

- A `T*` used purely as a nullable reference (assigned, compared to `null`, dereferenced
  to one object) maps to a TS reference — that is covered by `02-types.md`.
- **Everything else escalates**: `p + n`, `p - n`, `p[i]` on a raw pointer, `&arr[i]`
  taken as a pointer, pointer subtraction (`p2 - p1`), `cast(T*)` reinterpretation,
  storing a pointer-as-integer. JS has no addressable memory; a ref translation silently
  drops the arithmetic. Escalate the specific expression (`category: pointer arithmetic`)
  with the surrounding code so a memory model can be decided once. The one exception is a
  read-only `T*` into a static array of structs at constant offsets, which `02-types.md` §10
  maps to the array plus an offset parameter.

### 3.5 `union` value-layout & anonymous unions/structs that matter

These are **real, in-scope, and load-bearing** — the naive "TS object with every field"
translation is WRONG because it loses overlap (writing one member must be observable
through the others). Confirmed frontend sites:

- **`expression.d:919-925`** — `StringExp`'s private union `char* string` / `wchar* wstring` /
  `dchar* dstring` / `ulong* lstring` — RATIFIED: one byte buffer of `len * sz` bytes, code units
  little-endian (arm64), plus the terminator where D allocates one; `sz` (1/2/4/8) selects the width
  at every access (a write through `cast(wchar*)` is a width-2 write into the bytes);
  `peekData`/`borrowData` are views of the bytes, `peekString`/`peekWstring`/`peekDstring` the width
  views; the buffer is shared where D shares the pointer (`copy()`), so `peekString().ptr ==` is
  buffer identity. `peekData` asserts `len * sz` ≤ the buffer's length (D's unchecked read past the
  allocation is an AssertError); dcast.d:2459-2479's widened-node read goes through the source node,
  which D's `.ptr` names. `peekString` keeps D's `assert(sz == 1)`: `ctfeexpr.d:756` over two w/d
  string nodes is an AssertError where ldc2's release build returns the difference (known gap).
  Applied in `src/dmd/expression.ts`.
- **StructLiteralExp's union (expression.d:1467 in 1.43)** — RATIFIED CLOSED: under our
  config it is not a union at all. `version(IN_LLVM)` removes the `sym` arm; the surviving
  `void* inProgressMemory` is codegen payload (dropped); exactly ONE live member
  (`inlinecopy`) remains → plain field, no escalation. (The 1.42-era text listed it as an
  escalate case; superseded.)

**Carve-out — the `Token` payload union (`tokens.d:652`) is NOT a blanket-escalate
case.** The payload union inside `extern (C++) struct Token` (`tokens.d:652`) *looks* like
the genuinely-overlapping unions above, but its overlap is not uniform: only `intvalue`
and `unsvalue` actually share storage as a single bit-punned carrier. The real frontend
pun is narrow and verified — the lexer writes `t.unsvalue` (`lexer.d:461`) and the parser
reads `token.intvalue` (`parse.d:8184`) of the **same 64 bits**, signed vs unsigned. That
is one carrier read two ways, not N members aliasing one buffer. Every other arm of the
union is selected by `Token.value` (the `TOK`) and is never read through a *different*
arm's type: `floatvalue` (a distinct bit-interpretation), the nested
`struct { union { ustring; interpolatedSet } len; postfix }`, and `ident` are
discriminated, mutually exclusive, and never type-punned against the integers in the
frontend's own code. So this is **not** the "byte layout IS the semantics" case that the
list above escalates — it is a targeted carve-out exactly parallel to the `UnionExp` one
below.

**Disposition (do NOT escalate — translate per this model):** model `Token` with a single
raw carrier `intUnsValue: bigint` holding the 64 bits, exposed through two accessors:
`get intvalue(): bigint = toInt64(carrier)` and `get unsvalue(): bigint = toUint64(carrier)`;
writing **either** setter stores the (unsigned-normalized) bit pattern into the one
carrier, so the int↔uint alias is reproduced exactly (`09-numerics.md §1`). `floatvalue:
number` is a **separate slot**, not part of the carrier; the string-literal arm
(`ustring` / `interpolatedSet` / `len` / `postfix`) and `ident` are **separate fields**.
Exactly one group is meaningful per token, chosen by `value` (the `TOK`) — the
discriminant is already present, so no new tag is needed. This is the same TARGETED
carve-out shape as `UnionExp`: a real union where only a known, narrow subset (`int`↔`uint`)
shares bits, the rest being discriminated value-storage. The general union-layout
escalation in this section still applies to any genuinely-overlapping union where members ARE
read through each other's type; StringExp's (`expression.d:919`) is closed by the byte model
above. Doc home for the resolution: **§11 carve-out (here), referenced from `02-types.md`.**
Already applied to `src/dmd/tokens.ts`.

**Carve-out — `UnionExp` / `emplaceExp` is NOT an escalate case.** The `align(8) union
_AnonStruct_u` of `char[classInstanceSize!X]` buffers at **`ctfeexpr.d:82`** (inside
`struct UnionExp`, `ctfeexpr.d:47`) is **not** a genuine layout-dependent union and does
**not** belong in this list. Despite the `union` keyword and `align(8)`, no two members
are ever live at once and no member is read through a *different* member's type: the union
is a stack-resident `Variant`-sized buffer (just large enough to hold the biggest
Expression subtype) into which exactly one node is `emplace`d, then read back through the
same type via `exp()` (`ctfeexpr.d:57`). The overlap exists only to size a single buffer,
not to alias bits — there is no type-punning to preserve. This is a value-storage
optimization, **fully covered by `02-types.md` "UnionExp / emplaceExp (CTFE expression
construction)"** — translate it per that section, do **not** escalate it. The
union-layout escalation in this row applies ONLY to genuine layout-dependent /
overlapping-field unions where the byte layout IS the semantics (the `expression.d`
cases above; the `tokens.d:652` payload union is carved out separately and does NOT
escalate — see the Token carve-out above).

**Disposition:** STOP and escalate (`category: union value-layout`). A correct mapping
likely needs a tagged-union/discriminant model or an explicit overlap accessor, and the
choice must be made once and applied uniformly — exactly the kind of decision an agent
must not make unilaterally. Cite the site and what reads vs writes which member.

### 3.6 Alignment & bitfields

- **`align(N)` as decoration** (does not change a value the code observes, e.g.
  `align(16) struct Cent` in `common/int128.d:23` — and `Cent`/`Int128` is ported to
  BigInt per `09-numerics.md`, so the alignment is moot) → drop it, record
  `// dropped: align(16) (no observable effect; Int128 -> BigInt)`.
- **`align(N)` that the code reads back** (size/offset queries that depend on it, or an
  `align(8) union` whose alignment is part of a genuine punning scheme) → escalate with
  the union (§3.5). Note: the `align(8) union` at `ctfeexpr.d:82` is **not** such a case —
  its alignment merely sizes the `UnionExp` value-storage buffer (see the carve-out in
  §3.5); it is decoration, not an observable punning scheme, and does not escalate.
- **Bitfields** via `mixin(generateBitFields!(BitFields, T))` — confirmed in-scope at
  `dstruct.d:90`, `mtype.d:2457`, `declaration.d:92`, `declaration.d:491`,
  `dsymbol.d:350`, `dscope.d:111+`, `statement.d:1802`. The mixin
  (`common/bitfields.d:26`) packs a set of boolean members into one `ubyte`/`ushort`/
  `uint` with generated shift/mask getters and setters. `version = Has_Bitfields` is
  **commented out** (`bitfields.d:13`) so the *getter/setter* form is what's emitted.

  **Disposition:** the bitfields mixin is a CTFE-string mixin → `07-compile-time.md`
  owns resolving it to the concrete generated getters/setters. If `07` gives you the
  resolved getter/setter pattern, apply it (booleans become plain fields/accessors; the
  packed storage is an implementation detail you may discard *if and only if* nothing
  reads the packed integer or its `sizeof`). **Escalate** (`category: bitfields`) if any
  code reads the backing integer directly, takes its size, or relies on the bit layout —
  because then the packing is observable, not just an optimization.

### 3.7 GC finalization ordering & weak references

- **`~this` destructors** (`_ground-truth.md §4`: 33 of them) are *usually erasable* —
  the GC reclaims memory and most dtors have no deterministic-cleanup contract. That
  erasure is covered by `04-functions.md`/`03-value-semantics.md`. The one ratified exception is the
  owning handles of `dmd/dfa/` (`03 §6.6`), whose destruction timing is observable through `03 §8.1`.
- **Escalate** only when a `~this` (or a `scope`-guarded cleanup, or `core.memory`
  interaction) relies on **finalization *order* or *timing*** relative to other objects —
  JS GC is non-deterministic and runs finalizers (if any) unordered, so such logic cannot
  be ported as-is. Same for any **weak reference** with a finalizer/resurrection contract.
  `category: finalization order` / `weak ref`, with what the ordering guarantees.

### 3.8 Dynamic `mixin` / `__traits` not statically resolvable

`07-compile-time.md` owns resolving the *static* string/template mixins and `__traits`
against the fixed config (most are: e.g. `id.d:26 mixin(msgtable.generate(...))`,
`statement.d:1976+ mixin(visitStmtCase("..."))`, `asttypename.d:116 mixin(mixin_string)`).

**Escalate here** only when the mixed-in string or the `__traits` result is **not
computable at translation time** for our fixed world — i.e. it depends on data that is
not fixed, or it is generated from input the agent cannot enumerate. Then a faithful
static emission is impossible without a decision. `category: dynamic mixin` /
`unresolvable __traits`, with the exact mixin expression and what makes it non-constant.

---

## 4. What this protocol is NOT

- It is **not** a license to escalate routine work. If a construct *is* covered by a
  guide doc with a decisive rule, apply the rule — do not escalate to avoid effort.
- It is **not** a place to make the decision yourself and "note it for review". A STOP
  means STOP: emit the stub + the record and move on. Do not emit your guessed
  translation alongside the escalation "in case it's right".
- It is **not** about code that is merely *ugly* or *hard to read*. Hard-but-determined
  (a long `final switch`, a deep visitor) is normal porting work, not an escalation.
  Escalate ambiguity and undocumented/unportable semantics, not tedium.

---

## 5. One-line summary for every other doc to embed

> If you hit anything this guide doesn't decisively cover, or anything you'd have to
> guess — STOP, emit the `DJS-ESCALATE` stub at the site, and return the structured
> escalation record (§2 of `11-escalate.md`). A wrong compiler translation is worse
> than a halt.
