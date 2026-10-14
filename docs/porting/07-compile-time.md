# 07 — Compile-Time Metaprogramming (resolve AT TRANSLATION TIME)

> **STOP rule.** If you meet a CT construct not covered here, or any ambiguity in
> resolving one (a `static if` whose condition you cannot evaluate, a `mixin`
> whose string you cannot compute, a `__traits` not in the table below), **STOP
> and escalate** — see `11-escalate.md`. A wrong-but-plausible CT resolution bakes
> a silent bug into the compiler. Never guess.

---

## 0. The governing idea — these constructs DISAPPEAR

Read `_ground-truth.md` §0 first. We are porting the **frontend's own source**. The
compile-time metaprogramming in that source (`version`, `static if`, `static
foreach`, `mixin`, `__traits`, `is(...)`, manifest `enum`, `__VERSION__`/`__FILE__`)
is evaluated **by the D compiler when it builds the frontend** — so it must be
evaluated **by you, the translation agent, at translation time**. The emitted
TypeScript contains **only the resulting code**, never the metaprogramming.

This is the single rule of this document:

> **You evaluate the CT construct against the fixed target world (§1 / `_config.md`)
> and emit the concrete result, plus a one-line audit comment recording what you
> resolved.** The TS output has no `version`, no `static if`, no `mixin`, no
> `__traits`. They are gone.

**Do not confuse this with the feature the frontend *implements*.** `cond.d`,
`staticcond.d`, `dtemplate.d`, `dinterpret.d`, `traits.d` contain the *logic that
evaluates `static if`/`mixin`/`__traits` in **user** code*. That logic is ported as
ordinary code (it is the algorithm — see `_config.md` §0 and `translation-order.md`
Bucket 7). This document is about the CT constructs that appear **in the frontend's
own source as build-time directives** — those you resolve away.

A worked rule of thumb to tell them apart:

| You see | In a file like | It is | Do |
|---|---|---|---|
| `static if (IN_LLVM)` | `targetcompiler.d`, `builtin.d` | frontend self-config | **resolve & emit one branch** |
| `case "compiles": ...` | `traits.d`, `staticcond.d` | feature implementation | **port as code** |
| `mixin(msgtable.generate(...))` | `id.d` | frontend self codegen | **evaluate & inline result** |
| building a `MixinExp` AST node | `expressionsem.d` | feature implementation | **port as code** |

When in doubt which one you are looking at: the **self-config** form is a directive
*you* obey to shape the frontend; the **feature** form manipulates AST nodes /
`Expression` / `Dsymbol` objects representing *user* code. If it touches AST node
types, it is feature code — port it. (Cross-ref `02-types.md` for the node classes.)

### The audit-comment convention (apply to EVERY resolution)

Every resolved CT construct leaves a one-line TS comment so the port stays diff-able
against upstream DMD:

```ts
// resolved: static if (IN_LLVM) -> true (LDC build); else branch dropped
// resolved: version(Windows) -> false (target=posix); kept else
// resolved: mixin(msgtable.generate) -> 312 Id fields inlined below
// resolved: __traits(compiles, n.bogus()) -> false (ldc2)
// dropped: debug(LOG) block (non-debug build)
```

Format: `// resolved: <construct> -> <result> (<why>)` or `// dropped: <construct>
(<why>)`. Keep it to one line. This is mandatory, not optional.

The convention extends to **statically-false RUNTIME legs**: when an ordinary `if`/`else`
leg is omitted because its condition is statically false in our fixed world (a config field
that is constant-false, a driver mode the shim never enables — e.g. the old port's omitted
`importcHdr` / `vcg_ast` legs), the omission carries the same one-line comment **at the
omission site** (`// dropped: else-leg (vcg_ast mode — shim never sets it)`). A silently
missing leg is indistinguishable from a translation gap to the next auditing agent.

It also covers a runtime leg gated on a MUTABLE field whose only writers live OUTSIDE the
port's scope: drop it with a comment naming the absent writer. `Dsymbol.llvmInternal` is no
longer such a field. The frontend-visible half of `gen.dpragma` is ported in
`src/gen/dpragma.ts`: DtoGetPragma, DtoCheckPragma, DtoCheckProfileInstrPragma, DtoIsIntrinsic
and DtoIsMagicIntrinsic, with bodies from gen/pragma.cpp, plus DtoCheckInlineIRPragma from
gen/inlineir.cpp. `gen.llvmhelpers`'s DtoSetFuncDeclIntrinsicName is ported in
`src/gen/llvmhelpers.ts`, with the LLVM type size fixed for the arm64 target. `gen.ldctraits` is
ported in `src/gen/ldctraits.ts` with gen/ldctraits.cpp's two bodies and the target machine folded:
`traitsGetTargetCPU` is `"generic"`; `traitsTargetHasFeature` answers from LLVM 22.1.8's AArch64
feature table (349 names, `ldc2 -mattr=help`) and the 8-feature default set ldc2 reports. The legs that read
the field are ported as written: builtin.d:98, expressionsem.d:549, :4627, :10380,
dsymbolsem.d:9094 and templatesem.d:1275. The D binding `LDCPragma` (dpragma.d:22) lacks the C++
enum's LLVMconvertvector and LLVMprofile_instr (gen/pragma.h:25), so the two numberings differ
from member 24 on. The port keeps both: `LDCPragma` for D readers, `LDCPragmaCpp` for the C++
bodies. As a result the weak-symbol legs never fire in ldc2 1.43.0; the one at
expression.d:325-338 stays dropped on that ground, because its value import breaks module load.
Still dropped: everything in gen/ that only codegen consumes (IR emission, LLVM types). Known
gap: 1-ULP V8-vs-libm differences in the llvm_* float evaluators, pinned with a comment and not
chased.

It also covers the two whole-DECLARATION drops the guide sanctions:
- **A dead gate constant:** `private enum LOG = false;` whose every guarded block was dropped
  is itself dropped (emitting `const LOG = false;` is a `noUnusedLocals` error) — ONE marker
  at the declaration site: `// dropped: private enum LOG = false (gate constant; all
  static-if(LOG) blocks dropped — dmd/<file>.d:<line>)`.
- **A sanctioned dropped declaration** (e.g. the deprecated C++-ABI-only overloads,
  `04-functions.md §1`): `// dropped: <decl signature> (<why> — dmd/<file>.d:<line>)` at the
  position where the declaration would appear, preserving source order for the auditor.
No other whole-declaration drop exists; anything else missing is a translation gap.

---

## 1. `version` — resolve against the fixed target world

`_config.md` is the **authoritative version table**. This section is the operational
companion: it tells you *how to emit* once `_config.md` tells you ON/OFF/CONDITIONAL.

### 1.1 The three syntactic forms

D has three `version` forms in the frontend; all resolve at translation time.

**(a) `version (Ident) { ... } else { ... }`** — block conditional.

BEFORE (D — `targetcompiler.d:23`):
```d
version (IN_LLVM)
{
    enum TargetCompiler = "LDC";
    enum SwitchPrefix = "";
}
else version (MARS)
{
    enum TargetCompiler = "DMD";
    enum SwitchPrefix = "-";
}
else
    static assert(0, "unknown compiler being built");
```

AFTER (TS — emit ONLY the IN_LLVM branch):
```ts
// resolved: version(IN_LLVM) -> true (LDC build); MARS/else dropped
const TargetCompiler = "LDC";
const SwitchPrefix = "";
```

**(b) `version (Ident) statement;`** — single-statement conditional (no braces).
Same rule: keep the statement if ON, drop it if OFF.

**(c) `version = Ident;`** — a self-set version inside the source. Resolve it to a
boolean fact and propagate. From `_config.md`: `version = CallbackAPI;` only fires
inside `version(DMDLIB)` (OFF) → `CallbackAPI` is OFF everywhere. You do **not** emit
the `version = Ident;` line; you fold its effect into how you resolve the matching
`version(Ident)` blocks elsewhere.

### 1.2 The ON / OFF resolution table (this doc OWNS it)

The fixed world (`_ground-truth.md` §6): **POSIX, 64-bit, little-endian, `real`=64-bit,
compiler identity LDC.** Every `version(X)` the frontend uses as **self-config**
resolves as follows. `ON` = emit the branch, drop the `else`. `OFF` = drop the branch,
keep the `else`. `CONDITIONAL` = not a pure constant — see the note.

| Identifier | Resolved | Emit |
|---|---|---|
| `IN_LLVM` | **ON** | the IN_LLVM branch (we are LDC). `globals.d:32 enum IN_LLVM = true`. |
| `LDC` | **ON** | LDC predefined. `rmem.d`, `timetrace.d`, `longdouble.d`, `cparse.d`. |
| `Posix` | **ON** | target OS family. `file*.d`, `filename.d`, `console.d`, `target.d`. |
| `D_Exceptions` | **ON** | normal exceptions build. `main.d:157`. |
| `all` | **ON** | D built-in, always true. Emit inner block unconditionally. |
| `MARS` | **OFF** | DMD build. `targetcompiler.d:16`. |
| `IN_GCC` / `GNU` | **OFF** | GDC build. `targetcompiler.d:21`, `ctfloat.d:47`. |
| `DigitalMars` | **OFF** | DMD host. `location.d:41`. |
| `Windows` / `Win32` / `Win64` | **OFF** | not a target. `filename.d`, `main.d:1171/1173`. |
| `FreeBSD`/`OpenBSD`/`NetBSD`/`DragonFlyBSD`/`Solaris` | **OFF** | not targets. `cli.d`, `target.d`. |
| `X86` / `X86_64` / `AArch64` / `ARM` / `PPC` | **OFF** (self-config) | only drive the dead x87 path (`ctfloat.d:314-382`, `file.d:277`). |
| `CRuntime_Microsoft` / `CRuntime_DigitalMars` / `CRuntime_Musl` | **OFF** | non-target C runtimes. `console.d`, `longdouble.d:14`. |
| `AsmX86` / `D_InlineAsm_X86` / `D_InlineAsm_X86_64` / `real_t_X87` | **OFF** | x87 soft-float, all inside dead `CRuntime_Microsoft`/x86 paths. |
| `DMDLIB` / `CallbackAPI` | **OFF** | library-build API. `compiler.d:30`, `statementsem.d:76`. |
| `NoMain` | **OFF** | keep the real `main`/`else`. `mars.d:214`. |
| `D_Coverage` | **OFF** | no coverage. `main.d:140`. |
| `D_BetterC` | **OFF** (self-config) | only a literal inside a data string at `mars.d:2220` — keep that string verbatim. |
| `Has_Bitfields` / `Debugger_friendly` | **OFF** | `bitfields.d:13` is commented out — never set. |
| `LOGSEARCH` | **OFF** | `dscope.d:47` commented out. |
| `none` | **OFF** | D built-in, always false. Drop the block (keep `else`) — and the audit comment is §1.4's `// dropped:` form, NOT `// resolved:` (this row is not authority for the verb). |
| `linux` / `OSX` / `darwin` | **CONDITIONAL** | collapse to one POSIX path; see note + FLAG. |
| `CRuntime_Glibc` | **CONDITIONAL** | substitute Node `fs.realpath`; see FLAG. |
| `unittest` | **CONDITIONAL** | ON in the Vitest test build, OFF in the shipped shim; see note. |

**CONDITIONAL note — `linux`/`OSX`/`darwin`:** Node runs on both macOS and Linux. Where
the two POSIX branches are *behaviorally identical* (the common case), collapse to one
emitted path and comment `// resolved: version(linux/OSX) -> POSIX (collapsed)`. Where
they genuinely diverge (`man.d` browser command `open` vs `xdg-open`; `filename.d`
proc/realpath; `console.d` terminal detection) this is **FLAGGED in `_config.md` §4.1 —
STOP and escalate** (the likely answer is a runtime `process.platform` switch, but it is
Paolo's call). Do not silently pick one host.

**CONDITIONAL note — `unittest`:** `version(unittest)` guards test-only helpers
(`int128.d:758`). For a **ported test file** (→ Vitest, `10-tests-diagnostics.md`),
resolve **ON**. For the shipped CLI shim, resolve **OFF**. If you cannot tell which build
you are emitting for, default ON and comment `// resolved: version(unittest) -> ON
(test build)`. The one-vs-two-builds decision is FLAGGED (`_config.md` §4.3).

**`version = X;` self-sets you may meet and their resolution:** `CallbackAPI` (OFF),
`AsmX86`/`real_t_X87` (OFF, inside dead sections), `Has_Bitfields`/`Debugger_friendly`
(OFF, commented out). None are emitted; fold into the matching `version(X)` resolution.

### 1.3 `version(IN_LLVM)` — ON, but split KEEP vs DROP by content

We are LDC, so the IN_LLVM branch is taken — but **scope is frontend-only, no codegen**
(`_ground-truth.md` §1.3). Take the IN_LLVM branch, then ask: *does this block shape
AST/sema/CTFE, or feed codegen?* AST/sema/CTFE → **KEEP**; codegen (LLVM types,
`abiret`, target machine) → **DROP** with an audit comment. The full KEEP/DROP table is
in `_config.md` §2. Example:

BEFORE (D — `statement.d:1911`, inside an IN_LLVM block):
```d
version (IN_LLVM)
{
    LabelDsymbol isBranchToLabel; // FE bookkeeping — KEEP
    void* abiret;                 // llvm::Value* — codegen payload — DROP
}
```

AFTER (TS):
```ts
// resolved: version(IN_LLVM) -> true (LDC); abiret dropped (no codegen)
isBranchToLabel: LabelDsymbol | null = null;
// dropped: IN_LLVM codegen field `abiret` (llvm::Value*, no codegen)
```

Large driver/codegen IN_LLVM blocks in `main.d`/`mars.d`/`vsoptions.d` are FLAGGED
(`_config.md` §4.2) — the CLI-shim boundary is not mechanical. STOP and escalate the big
ones.

**A BODILESS `extern(C++)` declaration under IN_LLVM is not a KEEP/DROP question at all.** A
block of `Target` members (`target.d:1080-1087`: `toArgTypes`, `isReturnOnStack`,
`preferPassByRef`, `getTargetInfo`, `isCalleeDestroyingArgs`, `supportsLinkerDirective`) are
declarations whose bodies live in LDC's C++ driver; the D bodies further down belong to the
`!IN_LLVM` arm and are resolved away. Since no future D porting produces them, they are **§2
escalations — never `11 §2.5` walls, never per-file inlines** — and LDC's `gen/*.cpp` is
legitimate ground truth for reading what they do. The full disposition, including the
const-folding test, is `11-escalate.md §2.5`. Free functions declared by an LDC `gen.*` D binding
module (`module gen.dpragma;`, `module gen.llvmhelpers;`, `module gen.ldctraits;`) are the second sanctioned case: they are
ported with their gen/*.cpp bodies in `src/gen/<name>.ts` (Rule 1.1 dotted-name mapping), keeping
diagnostics and declaration state and dropping codegen-only lines with a comment.

### 1.4 `version(all)` / `version(none)`

- `version(all)` → always true. Emit inner block, comment `// resolved: version(all) ->
  always on`. (15 frontend sites.)
- `version(none)` → always false. **Drop the block** (it is disabled/stashed code — do
  NOT revive it). Keep any `else`. Comment `// dropped: version(none) block (disabled
  upstream)` if the deletion is non-obvious. (97 frontend sites.)

**`if (0 && …)` is ORDINARY RUNTIME D — translate it VERBATIM, never resolve it away.** A
constant-false runtime guard (`clone.d:1733`) is code the D compiler emits and type-checks: it
is not `version(none)`, not `static if`, not `debug`, and this document has no authority over
it. One port resolved such a block "exactly like a `version(none)` arm" and **silently lost one
`error` plus two `errorSupplemental` strings**. Emit the guard (with §2.5's numeric-truthiness
expansion, so `if (0 && x)` becomes `if (false && …)`) and keep the body. `11 §2`'s operating
rule covers it in principle — *do not stretch a rule to a case it does not literally address* —
and this is the case common enough to name.

---

## 2. `debug` — always OFF for our build

Our port is a non-`-debug` build (`_config.md` §3). **Every `debug` condition resolves
OFF.** Drop the block; keep any `else`.

BEFORE (D — `mtype.d:3267`):
```d
debug
{
    if (arguments)
        for (size_t i = 0; i < arguments.length; i++)
            assert((*arguments)[i].type);
}
```

AFTER (TS):
```ts
// dropped: debug { } block (non-debug build)
```

Named `debug(Ident)` idents all OFF: `LOG` (82), `Debug_DtoH`/`_Checks` (60/6, and in the
excluded `dtoh.d`), `stomp` (8), `FindExistingInstance` (8), `LOGASSIGN` (3),
`SHOWPERFORMANCE` (1), bare `debug` (3). Drop them all. (`debug` is NOT the same as the
ported `assert` — frontend `assert(...)` expressions port to the runtime assert helper;
see `09-numerics.md`.)

### 2.1 Bare `printf` before `assert(0)` — drop the developer trace

A **bare `printf`** — one *not* wrapped in any `debug`/`version`/`static if` block — also
appears, but rarely. In the frontend these are internal-error **traces** placed immediately
before an `assert(0)`/`assertUnreachable` on an unreachable path: a developer breadcrumb
that fires only when an "impossible" `default:` case is hit. **Drop the bare `printf`**, keep
the following `assert(0)` (it ports to the runtime assert helper, `09-numerics.md`), and
leave a one-line comment noting the drop.

BEFORE (D — `dinterpret.d:3309`, the `default:` of an exhaustive switch):
```d
default:
    printf("be = '%s' %s at [%s]\n", EXPtoString(e.op).ptr, e.toChars(), e.loc.toChars());
    assert(0);
```

AFTER (TS — trace dropped, the unreachable assert kept):
```ts
default:
    // dropped: bare printf developer trace before assert(0) (unreachable path)
    assert(0);
```

**Do NOT confuse this with DIAGNOSTIC output.** A bare `printf` of an internal trace is a
developer breadcrumb with no observable contract — it is dropped. By contrast `error()` /
`warning()` / `deprecation()` calls, and any message the frontend writes to stderr as part
of its *diagnostic* output, are user-facing and **reproduced verbatim** (byte-for-byte) per
`10-tests-diagnostics.md`. If a bare `printf` is on a *reachable* path or its output is
asserted by a test, it is diagnostics — STOP and treat it under `10-tests-diagnostics.md`,
do not drop it.

---

## 3. `static if` — evaluate the condition, emit the taken branch

`static if (cond) { A } else { B }`: evaluate `cond` at translation time, emit `A`
(condition true) or `B` (condition false / no taken branch → emit nothing). Comment what
you resolved and **why** the condition has that value.

**The condition is evaluated against the fixed world plus any CT facts already known**
(version flags, `__VERSION__`, manifest enums, `__traits` results, `is(...)` results).
You must be able to compute it. If you cannot → STOP (§9).

**A resolved-OFF branch can leave a DECLARATION with no remaining reader** — the local that
only that branch read, whose D declaration and writes are outside the block. The declaration
and its writes stay (D emits them too); the unused-local error is suppressed with the
`void x;` idiom, and the comment names the resolved-away branch that read it
(`04-functions.md §5`, third case). Do not delete the local: that silently drops the writes
with it, and both review lenses will read the deletion as a dropped leg anyway.

### 3.1 `static if (versionFlag)` / manifest-flag conditions

BEFORE (D — `builtin.d:48`, then used at `:60`):
```d
version (IN_LLVM) enum IN_LLVM = true; else enum IN_LLVM = false;
...
else static if (IN_LLVM && e.length > 5 && e[0..5] == "llvm_")
```

AFTER: `IN_LLVM` is the manifest constant `true` (LDC). Evaluate the rest of the
condition per-iteration when you unroll the surrounding `foreach` (§4):
```ts
// resolved: IN_LLVM -> true (LDC build)
```

### 3.2 `static if (__VERSION__ < N)` — frontend-version gate

`__VERSION__` is the **compiler version building the frontend**. **Verified: `ldc2
-run` on the 1.43.0-beta1 baseline reports `__VERSION__ == 2113`** (DMD v2.113.0
frontend). So any `static if (__VERSION__ < 2092)` resolves to its **`else`** branch.

BEFORE (D — `errors.d:125`):
```d
static if (__VERSION__ < 2092)
    private extern (C++) void noop(Loc loc, const(char)* format, ...) {}
else
    pragma(printf) private extern (C++) void noop(Loc loc, const(char)* format, ...) {}
```

AFTER (TS — emit the `else`, drop `pragma(printf)` per `04-functions.md`):
```ts
// resolved: static if (__VERSION__ < 2092) -> false (__VERSION__==2113, verified ldc2 1.43.0-beta1)
function noop(loc: Loc, format: string, ...args: unknown[]): void {}
```

### 3.3 `static if (__traits(compiles, expr))` — SFINAE capability probe

`__traits(compiles, …)` is a CT bool: `true` iff `expr` compiles in context (verified —
`_probes.md` §8). Resolve to the constant the compiler computes, emit the taken branch.

BEFORE (D — `main.d:884`):
```d
static if (__traits(compiles, GC.stats))
    mem.disableGC();
```

AFTER (TS): there is no GC in the port; resolve the capability per `08-runtime-lib.md`.
If `GC.stats` exists in the ported runtime shim, emit the call; if the whole GC concept is
erased, drop:
```ts
// resolved: static if (__traits(compiles, GC.stats)) -> false (no GC in port); dropped
```

For the **generic-container** `static if (is(typeof(...)))` probes in `root/array.d`
(`:84`, `:121`, `:384`), the container stays a **TS-native generic** (`Array<T>` over a
single class — see `08-runtime-lib.md` "Container representation: TS-native Array<T>"), so
the type parameter `T` is **not** monomorphized and the probe **cannot be resolved in one
generic body**. This is the dispatch-on-a-type-parameter case — resolve it per §3.5 below,
not by picking a branch here.

### 3.4 `static if` inside a `mixin template` / template — resolve per instantiation

When a `static if` lives in a template body, its condition depends on the template
argument and is resolved **once per instantiation you emit** (templates are monomorphized
— see `02-types.md`). Example — `objc.d:926`:
```d
static if (is(T == ClassDeclaration))   // resolved per T at each instantiation
```
Emit the branch the *concrete* `T` selects at each call site, with a comment naming `T`.
A monomorphized template class or function is named `<DName>_<Arg>` per instantiation emitted
(`DoInlineAs_Statement` / `DoInlineAs_Expression`, `doInlineAs_Expression`, inline.ts;
`checkPossibleAddCatError_AddExp`, arrayop.ts), with a header comment naming the D template and `Arg`.

### 3.5 Compile-time dispatch on a generic type parameter (CANONICAL HOME)

This is the **one** `static if` shape that does *not* resolve to a single emitted branch.
It arises when **all three** hold:

1. the condition is a `static if` / `is(typeof(...))` / `__traits(compiles, ...)` probe,
2. the condition depends on the **template's own type parameter** (`T`), and
3. that type **stays generic in the port** — the template is ported as a *single*
   TS-native generic class, **not** monomorphized per element type (this is the
   container-generics decision; see `08-runtime-lib.md` "Container representation:
   TS-native Array<T>").

§3.4 above is the *opposite* case: there `T` is bound to a *concrete* type at each
instantiation you emit, so the probe collapses to one branch and you simply emit it.
Here `T` is **still a free type variable in the emitted code** (`class Array<T> { ... }`),
so there is no single concrete `T` to evaluate the probe against — you cannot pick a
branch in one generic body. **Do not** synthesize a generic default or a runtime
type-witness to fake the resolution.

**This is also distinct from an ordinary `static if` whose condition is a fixed config
predicate** (`version` flag, `__VERSION__`, a manifest enum). Those resolve once, globally,
per §1/§3.1–§3.2 and the §1.2 version table — the condition does *not* depend on a type
parameter that survives into the port. Only a probe on a still-generic `T` lands here.

**Resolution, in order:**

- **(a) Every instantiation shares the capability → translate the taken branch directly.**
  If, across all element types the frontend actually instantiates, the probe is uniformly
  `true` (or uniformly `false`), the chain has one effective branch. Emit that branch in
  the generic body and record why it is uniform.
- **(b) Instantiations differ → monomorphize THAT METHOD per-`T`, or escalate.** Keep the
  class generic, but split the *single divergent method* into per-`T` overrides/variants at
  the known element types; if the set of types or the branch logic is not mechanically
  enumerable, **STOP and escalate** (§11). Do not push the divergence into the generic body
  with a guessed default.
- **(c) Diagnostics-only methods (`toString`/`toChars`) → STOP-stub or escalate.** When the
  per-`T` probe only feeds a human-readable dump, the method carries no semantic weight in
  the GC'd port — emit a STOP-stub (`10-tests-diagnostics.md`) or escalate rather than
  reproduce the CT capability dispatch.

**Worked example — `root/array.d` `toString`.** `array.d:121` selects how to render an
element by probing the element type for a `toString`/`toDString` method:
```d
const(char)[] toString() const
{
    static if (is(typeof(T.init.toString())))      // array.d:121
        return toStringImpl!(a => a.toString)(&this);
    else static if (is(typeof(T.init.toDString())))// array.d:125
        return toStringImpl!(a => a.toDString)(&this, true);
    else
        assert(0);                                 // array.d:131
}
```
`T` stays generic (`Array<T>` is one class), so the `is(typeof(T.init.toString()))` chain
cannot be evaluated to one branch here. A `toString`/`toChars` whose bytes reach a user-visible
diagnostic is NOT diagnostics-only, so rule (b) applies: `Array!RootObject.toString` feeds the
byte-exact `__traits(parameters)` error (traits.d:2238). root/array.ts therefore carries per-`T`
variants at the element types the frontend instantiates, and no generic default:
`toStringObjects`/`toCharsObjects` (also `Tuple.toChars`, dtemplate.d:218),
`toStringExpressions`/`toCharsExpressions`, and `toStringArgumentLabels`/`toCharsArgumentLabels`,
the last being D's `static else assert(0)` (array.d:135). Rule (c) stays for a use whose text
never reaches a user.

---

## 4. `static foreach` — unroll, OR convert to a runtime loop

`static foreach` is a **compile-time** loop: the body is duplicated once per element, with
the loop variable substituted as a CT constant. **Default rule: UNROLL** — emit one
concrete copy of the body per element, with the loop variable replaced by its literal
value. This is the faithful translation (the duplicated declarations/cases genuinely exist
after CT expansion).

### 4.1 The decision rule (unroll vs runtime loop)

| The `static foreach` body... | Emit |
|---|---|
| declares symbols, generates `case`/`switch` arms, or contains `static if`/`mixin` keyed on the loop var | **UNROLL** — one literal copy per element |
| is plain runtime code over a literal numeric range, no CT-keyed content | **runtime `for`** loop (equivalent, less code) |

When unsure → **UNROLL** (always faithful). A runtime loop is a size optimization, only
valid when the body has no CT-dependent content. The `tokens.d:439` and `builtin.d:58`
cases below MUST unroll (they contain `static if` / `mixin` keyed on the element).

### 4.2 Worked example — `foreach`+`static if`+`mixin` over `__traits(allMembers)`

BEFORE (D — `builtin.d:56`; here `foreach` over a CT `__traits` tuple is a CT loop):
```d
switch (fd.builtin)
{
    foreach(e; __traits(allMembers, BUILTIN))
    {
        static if (e == "unknown")
            case BUILTIN.unknown: assert(false);
        else static if (IN_LLVM && e.length > 5 && e[0..5] == "llvm_")
            mixin("case BUILTIN."~e~": return eval_llvm"~e[5..$]~"(loc, fd, (*arguments)[]);");
        else
            mixin("case BUILTIN."~e~": return eval_"~e~"(loc, fd, (*arguments)[]);");
    }
    default: assert(0);
}
```

To resolve this you must (1) enumerate `__traits(allMembers, BUILTIN)` (read the `BUILTIN`
enum — §6.2), (2) for each member `e` evaluate the `static if` chain (`IN_LLVM` is `true`),
(3) evaluate the `mixin` string. AFTER (TS — unrolled, one case per `BUILTIN` member;
illustrative subset):
```ts
// resolved: foreach(e; __traits(allMembers, BUILTIN)) unrolled; IN_LLVM=true
// resolved: each mixin("case ...") inlined as a concrete switch arm
switch (fd.builtin) {
  case BUILTIN.unknown: assert(false); // resolved: e=="unknown" branch
  case BUILTIN.sin:    return eval_sin(loc, fd, arguments.slice());
  case BUILTIN.cos:    return eval_cos(loc, fd, arguments.slice());
  case BUILTIN.llvm_sin: return eval_llvmsin(loc, fd, arguments.slice()); // resolved: IN_LLVM llvm_ branch
  // ... one arm per BUILTIN member ...
  default: assert(0);
}
```

(`(*arguments)[]` → a slice over the dereferenced pointer — see `08-runtime-lib.md` for
`Array!T` slicing and pointer semantics.)

### 4.3 Worked example — runtime-loop conversion

A `static foreach (i; 0 .. 4)` whose body is plain runtime code with `i` used only as an
index may become a runtime `for`:
```ts
// resolved: static foreach (i; 0 .. 4) -> runtime for (body has no CT-keyed content)
for (let i = 0; i < 4; i++) { /* body with i */ }
```
Only do this when the body has **no** `static if`/`mixin`/declaration keyed on `i`.

---

## 5. `mixin("string")` — evaluate the string at translation time, inline the code

A string mixin compiles a **CT-computed string** as D source at that point. You evaluate
the string expression at translation time and **inline the resulting code** (translated to
TS). The mixin keyword and the string vanish.

**Invariant:** the string is computed by CTFE — string concatenation (`~`), CTFE function
calls, loop variables. You must reproduce that computation to know what code to emit. If
the string depends on runtime data (it cannot, by definition, but if you cannot statically
compute it) → STOP (§9).

### 5.1 Literal-ish mixin (`longdouble.d:166`)

BEFORE (D, inside an `op`-templated operator):
```d
mixin("this = this " ~ op ~ " rhs;");   // op is a template string param, e.g. "+"
```
For each instantiation, `op` is a concrete operator. AFTER (per instantiation, say `op="+"`):
```ts
// resolved: mixin("this = this " ~ op ~ " rhs") with op="+"
this.assign(this.add(rhs)); // operators are methods — see 05-operators.md
```
(`longdouble.d` is the x87 soft-float path — mostly **dead** in our world, `real`=64-bit;
see `09-numerics.md`. Shown only as the mixin pattern.)

### 5.2 Mixin generating switch arms (`statement.d:1976`, `builtin.d:63`)

`statement.d`'s `VisitStatement` mixes one `case` per `STMT` member via the CTFE helper
`visitStmtCase(handler)`. You evaluate `visitStmtCase("Return")` etc. and inline each
resulting `case`. Because `visitStmtCase` itself contains `static if (__traits(compiles,
…))`, you resolve those per concrete visitor too. This couples to the **template-mixin**
expansion of `VisitStatement` (§6) — resolve them together. Comment:
```ts
// resolved: mixin VisitStatement!void + mixin(visitStmtCase(...)) -> inlined switch arms
```

### 5.3 Mixin as a code generator (`id.d:26`, `asttypename.d:116`)

The biggest string-mixin idiom: a CTFE function returns a whole block of source, mixed in
to *generate declarations*.

BEFORE (D — `id.d:22`):
```d
extern (C++) struct Id {
    static __gshared:
    mixin(msgtable.generate(&identifier));   // generates one `static __gshared Identifier xxx;` per table entry
}
```
`msgtable.generate` (`id.d:638`) loops the `msgtable` array and concatenates a declaration
string per entry. AFTER: run that generation at translation time and inline the concrete
fields (one per `Msgtable` entry — ~300+ identifiers):
```ts
// resolved: mixin(msgtable.generate(&identifier)) -> inlined Id fields (one per msgtable entry)
class Id {
  static FILE: Identifier;     // from { "FILE", "__FILE__" }
  static LINE: Identifier;     // from { "LINE", "__LINE__" }
  static object: Identifier;   // ... one field per entry ...
}
```
Likewise `id.d:36 mixin(msgtable.generate(&initializer))` inlines the `idPool` calls inside
`initialize()`. `asttypename.d:116 mixin(mixin_string)` generates an entire visitor class —
inline the generated class. **These code-generators are the highest-value mixins to get
right; if the generated source is large, inline it fully and comment the count.**

---

## 6. `mixin Name!(...)` / `mixin Name;` — template mixin, expand in place

A **template mixin** splices a `mixin template`'s members into the current scope. Resolve
by **expanding**: inline the template body (with its template args substituted) at the
mixin site. The `mixin Name;` line vanishes; its members appear inline.

### 6.1 Empty template mixin (the common LDC case) — `declaration.d:486`

BEFORE (D): `targetcompiler.d:58` defines `mixin template VarDeclarationExtra() { }`
(empty, for IN_LLVM); `declaration.d:486` instantiates it:
```d
struct ... {
    bool dllExport;
    mixin VarDeclarationExtra;   // IN_LLVM -> empty
    bool systemInferred;
}
```
AFTER: IN_LLVM expands to nothing — emit nothing, just record it:
```ts
// resolved: mixin VarDeclarationExtra -> empty (IN_LLVM adds no fields)
dllExport: boolean = false;
systemInferred: boolean = false;
```
(The MARS branch would add `inClosure`/`inAlignSection` — those are DROPPED, we are LDC.)

**Variant: the mixin defines a FUNCTION that the next statement calls.**
`dmd/dsymbolsem.d:2026` does `mixin alignSectionVarsExtra; doAlign();` where
`targetcompiler.d:97-127` defines `doAlign()` as an **empty body under IN_LLVM** (the MARS
variant tracks over-aligned stack locals). Resolve the version first, then: if the resolved
body is empty, drop BOTH the mixin and the call, leaving a one-line provenance comment at the
call site (`// resolved: mixin alignSectionVarsExtra; doAlign() — IN_LLVM no-op,
targetcompiler.d:103`). A silent drop with no comment reads as a missed statement to the next
auditing agent.

### 6.2 Non-empty template mixin — `init.d:353`, `statementsem.d:3766`

BEFORE (D): `mixin template VisitInitializer(Result)` (`init.d:369`) defines a
`VisitInitializer` method; instantiated as:
```d
mixin VisitInitializer!Initializer visit;
```
AFTER: expand the `VisitInitializer` template with `Result = Initializer` and inline the
generated method (resolving its internal `static if (is(Result == void))` against the
concrete `Result`):
```ts
// resolved: mixin VisitInitializer!Initializer -> inlined method (Result=Initializer)
VisitInitializer(i: Initializer): Initializer { /* expanded body, static ifs resolved */ }
```
The named instance (`visit`) becomes an ordinary member. Because `VisitStatement`/
`VisitInitializer`/`ParseVisitMethods` are instantiated in several files
(`statementsem.d`, `blockexit.d`, `dinterpret.d`, `hdrgen.d`, `traits.d`,
`visitor/package.d`, `visitor/transitive.d`), **expand each instantiation independently**
with its own `Result`/AST args. This is part of the visitor-infrastructure batch
(`translation-order.md` §2.2a; visitor mechanics owned by `02-types.md`).

---

## 7. `__traits(...)` — enumerate, resolve each kind

`__traits` is a CT reflection query. Resolve each to the concrete value the local compiler
computes, emit that value (or the code it selects), comment the resolution. Below is the
**complete set the frontend uses as self-config** (counts are grep'd usages; many other
`__traits` matches are the *feature implementation* in `traits.d`/`staticcond.d` —
port those as code, §0).

| Trait | Sites | Resolution rule |
|---|---|---|
| `__traits(compiles, expr)` | 22 | CT bool (verified `_probes.md` §8). Emit `true`/`false`, then the `static if` branch it selects. |
| `__traits(allMembers, T)` | 10 | Enumerate the members of `T` (enum/aggregate) at translation time → drive `static foreach` unroll (§4). Read `T`'s definition. |
| `__traits(getMember, T, name)` | 8 | The member named `name` of `T`. For an enum value: emit the literal. Used in CT asserts (`tokens.d:442`) and field reflection (`bitfields.d`). |
| `__traits(getOverloads, T, name)` | 8 | The overload set; used by the visitor generators (`asttypename.d`). Enumerate, drive generation. |
| `__traits(classInstanceSize, C)` | many | **Object byte size — a memory concern the port ELIDES.** See §7.1. |
| `__traits(identifier, sym)` | 6 (mostly parser/feature) | The symbol's name as a string literal. Emit the string. |
| `__traits(isSame, a, b)` | 3 | CT bool: same symbol/entity. Emit `true`/`false`. |
| `__traits(getAttributes, sym)` | 2 | UDA list; rare. Resolve the concrete attribute set. |
| `__traits(getLocation, sym)` | 0 self-use | Only in `location.d:31` **doc text** — no frontend self-use. The *feature* lives in `traits.d`; port it. See §8. |
| `__traits(getTargetInfo, "x")` | 0 self-use | Only `cli.d` **doc strings**. The feature is in `traits.d`/`target.d`; port it. |

Anything not in this table → **STOP and escalate** (§9). Do not invent a resolution.

### 7.1 `__traits(classInstanceSize, C)` — elide (it is a malloc size)

This dominant trait (`expression.d:4925` `expSize` table, `mtype.d:383` `sizeTy`,
`dinterpret.d:193`, `inline.d`) computes the **byte size of a class instance** for manual
memory operations: region allocation, `memcpy` of one node over another. **In TS there is
no manual sizing — `new` allocates, the GC frees, you assign fields.** So:

BEFORE (D — `inline.d:762`):
```d
memcpy(cast(void*)vto, cast(void*)vd, __traits(classInstanceSize, VarDeclaration));
```
AFTER (TS — field-wise copy, no size):
```ts
// resolved: __traits(classInstanceSize, VarDeclaration) elided (no manual memory in port)
const vto = new VarDeclaration(vd.loc, vd.type, vd.ident!, vd._init);
Object.assign(vto, vd);                    // memcpy clone: every reference field shared
vto.visibility = vd.visibility.copy();     // each inline value struct of Dsymbol/Declaration/VarDeclaration
vto.nestedrefs = vd.nestedrefs.copy();     // gets its own copy (a byte copy duplicates it; Object.assign
vto.alignment = vd.alignment.copy();       // would alias it). Loc shared per 03 §9.1.
// precedent: inline.ts cloneVarDeclaration, mtype.ts Type.copy
```

The `expSize`/`sizeTy` *lookup tables* keyed by these sizes (`expression.d:4925`,
`mtype.d:383`) exist only to size CTFE-region allocations of AST nodes. The CTFE
interpreter's allocation model is `dinterpret.d`'s concern — under the port's GC model,
these tables are **dropped** (comment `// dropped: expSize table — no manual node sizing`),
and node allocation is plain `new`. If a *specific* CTFE path turns out to need a size for
a non-memory reason, STOP and escalate — do not fabricate a byte count.

### 7.2 CT-only `static assert` with `__traits` — emits NOTHING

`tokens.d:439` asserts at CT that `TOK` enum members are consecutive, using `foreach` +
`__traits(allMembers, TOK)` + `static if` + `__traits(getMember, TOK, enumName)`:
```d
static assert(() {
    foreach (idx, enumName; __traits(allMembers, TOK))
        static if (idx != __traits(getMember, TOK, enumName)) { pragma(msg, ...); static assert(0); }
    return true;
}());
```
This is a **compile-time-only invariant check**. You verify it holds (it does — the enum is
consecutive) and emit **nothing** but a comment:
```ts
// resolved: static assert (TOK members consecutive) -> holds at translation time; no runtime code
```
(Runtime `static assert` / `assert` policy: `09-numerics.md` / `10-tests-diagnostics.md`.)

---

## 8. `is(...)` and `typeof` in CT contexts — resolve to a type or a bool

`is(...)` and `typeof(...)` in a CT context (inside `static if`, manifest `enum`, template
constraint) are **CT type queries**. Resolve to the concrete type or the bool the compiler
computes; emit the result.

| Form | Meaning | Resolve to |
|---|---|---|
| `is(T)` | does `T` denote a valid type | bool |
| `is(T == U)` | exact type identity | bool |
| `is(T : U)` | implicit convertibility | bool |
| `is(typeof(expr))` | does `expr` type-check | bool (verified `_probes.md` §8) |
| `is(typeof(expr) == U)` | type of `expr` equals `U` | bool |
| `is(T == X, params...)` | type pattern match w/ captures | bool + captured types |
| `typeof(expr)` (as a type) | the static type of `expr` | the concrete TS type |
| `typeof(this)` | the enclosing type | the enclosing TS class/struct |

BEFORE (D — `errors.d`-style / `init.d:383`):
```d
static if (is(Result == void)) { } else { return Result.init; }
```
AFTER (per instantiation, `Result` concrete — say `Result == void`):
```ts
// resolved: static if (is(Result == void)) -> true (Result=void); empty branch
```

`typeof(this)` (e.g. `root/array.d:155 ref Array append(typeof(this)* a)`) resolves to the
enclosing type — for `Array!T` that is `Array<T>` (owned by `08-runtime-lib.md`). The
`root/array.d` template-constraint `is(...)` clauses (`:384 if (is(typeof(this.data[0].
opCmp(...)) : int))`) are a probe on the still-generic element type `T` (`Array<T>` stays
TS-native, not monomorphized): they fall under §3.5 "Compile-time dispatch on a generic
type parameter". The `opCmp`-based ordering probe specifically routes through
`05-operators.md` "Operators on a generic type parameter" — do not resolve it standalone.

**`__traits(getLocation)` / `getTargetInfo` are the FEATURE, not self-config** — they are
reflection the frontend implements for *user* code, in `traits.d`/`target.d`. Port that
logic as code (it produces a `Loc` / integer for the program being compiled). Do **not**
resolve them away. (`Loc`/source-location handling: `02-types.md`.)

---

## 9. Manifest `enum x = <CTFE expr>;` — evaluate to a literal, or flag

A manifest `enum` is a **named CT constant** (no storage). Evaluate the CTFE expression at
translation time and emit a `const` with the literal result.

| The CTFE expression is... | Emit |
|---|---|
| a literal / simple arithmetic / `~`-concat of literals | `const x = <literal>;` |
| `is(...)` / `__traits(...)` (resolved per §7/§8) | `const x = <bool/value>;` with audit comment |
| a CTFE **function call** whose result you can compute by reading the function | the computed literal + comment naming the source fn |
| anything you cannot statically compute | **STOP and escalate** (§10) |

BEFORE (D — `inline.d:177`):
```d
enum asStatements = is(Result == Statement);   // per instantiation
```
AFTER (say `Result == Statement`):
```ts
// resolved: enum asStatements = is(Result == Statement) -> true (Result=Statement)
const asStatements = true;
```

BEFORE (simple arithmetic — generic shape):
```d
enum size_t TMAX = ... ; enum N = 3 * 4 + 1;
```
AFTER:
```ts
const N = 13; // resolved: enum N = 3*4+1
```
(Manifest `enum` of `long`/`ulong` base → BigInt domain, `09-numerics.md`. Named/`enum E
{...}` blocks → TS `enum`, see `_probes.md` §7 and `02-types.md`. This section is **only**
about manifest `enum x = expr;`.)

**Note:** `enum IN_LLVM = true;` inside a function (`builtin.d:48`) is a manifest constant
you have already resolved via §1 — emit `const IN_LLVM = true;` (or just inline `true` into
the `static if` and drop the const).

---

## 10. `__VERSION__`, `__FILE__`, `__LINE__` — two distinct cases

These special tokens have **two completely different roles** — do not conflate:

### 10.1 As frontend self-config (resolve at translation time)

`__VERSION__` in a `static if` is the compiler version *building* the frontend → **`2113`**
(verified, §3.2). `__FILE__`/`__LINE__` used as a **default parameter for the frontend's
own logging/asserts** (e.g. `expressionsem.d:11044 void setResult(Expression e, int line =
__LINE__)`) are *call-site* values used by the frontend's own diagnostics. For the port:

- `__VERSION__` comparison → resolve to the literal `2113`, evaluate the `static if`.
- `__FILE__`/`__LINE__` as a default param in the frontend's own debug/log/assert helpers
  → resolve to a constant string/number, or drop with the surrounding `debug` block (§2).
  These are **not** user-facing; they identify a line in the *compiler* source. Emit a
  fixed placeholder (`"<file>.d"`, `0`) or drop, and comment. Do not wire them to JS
  runtime location APIs.

BEFORE (D — `expressionsem.d:11044`):
```d
void setResult(Expression e, int line = __LINE__) { ... }
```
AFTER (TS — the default is a compiler-source line, not load-bearing):
```ts
// resolved: __LINE__ default -> compiler-source line (placeholder; debug-only)
setResult(e: Expression, line: number = 0): void { ... }
```

### 10.2 As the FEATURE (`__FILE__`/`__LINE__`/`__MODULE__` in USER code)

The frontend **implements** D's `__FILE__`/`__LINE__`/`__MODULE__`/`__FUNCTION__`/
`__PRETTY_FUNCTION__`/`__FILE_FULL_PATH__` and `__traits(getLocation)` for the program it
compiles (`expressionsem.d:15986` resolves them to the call-site `Loc`;
`id.d:171-175`/`tokens.d:779` are the token tables). **This is feature logic — port it as
code.** It produces the *user program's* file/line, not the compiler's. Keep the `Loc`
plumbing intact (`02-types.md` owns `Loc`/source positions; diagnostics owned by
`10-tests-diagnostics.md`). Do **not** resolve these away.

The distinction, stated once: **`__VERSION__`/`__FILE__`/`__LINE__` you EVALUATE** when
they gate the frontend's *own* build (§10.1); **you PORT the logic** when the frontend
computes them for *user* code (§10.2).

---

## 11. STOP-and-escalate triggers (cross-ref `11-escalate.md`)

STOP — do not guess — when:

- A `static if`/manifest-`enum` condition you **cannot statically compute** (depends on a
  CTFE function whose result you cannot determine by reading it).
- A `mixin("...")` whose **string you cannot fully evaluate** at translation time.
- A `__traits` **not in the §7 table**.
- A `version` ident not in the §1 table **and** not in `_config.md`.
- A `version(linux)`/`version(OSX)` pair that **genuinely diverges** (`_config.md` §4.1).
- A large `main.d`/`mars.d` IN_LLVM/driver block where the **CLI-shim boundary is unclear**
  (`_config.md` §4.2).
- A `__traits(classInstanceSize)` used for a **non-memory** purpose you cannot map to
  field-wise copy (§7.1).
- Any case where you are about to **emit metaprogramming** (a `version`/`static
  if`/`mixin`/`__traits` token) into the TS output — that is always a bug; STOP.

---

## 12. Quick reference

| D self-config construct | Translation-time action | Emitted TS |
|---|---|---|
| `version(X){A}else{B}` | evaluate `X` (§1 table) | `A` or `B`, never the `version` |
| `version = X;` | fold into matching `version(X)` | nothing |
| `debug ...` | always OFF (§2) | drop block, keep `else` |
| `static if(c){A}else{B}` | evaluate `c` | `A` or `B` + audit comment |
| `static foreach(x; xs){...}` | UNROLL (default) or runtime `for` (§4) | concrete copies / loop |
| `mixin("str")` | evaluate `str`, translate result | inlined code |
| `mixin Name!(args)` | expand template body w/ `args` | inlined members |
| `__traits(compiles/allMembers/...)` | resolve per §7 | literal value / selected branch |
| `__traits(classInstanceSize, C)` | elide (no manual memory) | field-wise copy / dropped |
| `is(...)` / `typeof` (CT) | resolve to type/bool (§8) | concrete type / `true`/`false` |
| `enum x = <CTFE>;` | evaluate (§9) | `const x = <literal>;` |
| `__VERSION__` (self-config) | `2113` (verified) | literal in resolved `static if` |
| `__FILE__`/`__LINE__` (self) | placeholder/drop (§10.1) | const / dropped |
| `__FILE__`/`getLocation` (feature) | **port the logic** (§10.2) | ported code, NOT resolved |

**Every line above leaves an audit comment.** If you emitted a `version`/`static
if`/`mixin`/`__traits` keyword into TS, you made an error — go back.
