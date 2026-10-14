# DJS Translation Order — Dependency DAG & File Ordering (Phase 1)

> READ `_ground-truth.md` FIRST. This file is the dependency-ordering artifact the
> later translation workflow consumes. It is **grounded in the actual `import`
> graph** of `/Users/pinver/Projects/Public/ldc-1.43.0/dmd` (155 `.d` files,
> excluding `iasm/`), not in intuition. The graph was regenerated on the 1.43-beta1
> tree and cross-checked by reproducing the 1.42 numbers first; **the 76-module core
> SCC is file-identical between 1.42 and 1.43-beta1** (verified by set equality), so
> the bucket backbone below is unchanged — the 1.43 deltas are purely additive (the
> 7-file `dfa/` subtree, in scope, and a reclassified `argtypes_aarch64.d`; §3).
>
> Method: every `import dmd.*` line (top-level `^import` and function-local
> `    import`) was parsed, resolved to its declaring file, and the resulting
> directed graph was condensed with Tarjan's SCC algorithm, then layered by
> longest-path depth from the leaves. Two graphs were computed:
> 1. **Full graph** — every import counts as an edge.
> 2. **Top-level-only graph** — function-local (indented) imports treated as
>    *breakable* edges, because in ESM a `import` inside a function body becomes a
>    `await import()` / deferred reference that does NOT participate in module
>    load-order cycles.
>
> The difference between the two is the lever we use to shrink the cycles
> (see §2 and §3).

---

## 0. TL;DR — the shape of the problem

DMD's frontend is **not** a clean DAG. The import graph contains one enormous
**strongly-connected component** (the AST + semantic "ball of mud"):

- **Full graph:** a single SCC of **95 modules** (was 87 in 1.42 — the growth is the
  7 in-scope `dfa/` files plus `argtypes_aarch64.d`, all attached by function-local
  edges only).
- **Top-level-only graph:** a single SCC of **76 modules**, file-identical to 1.42
  (19 modules fall out once function-local imports are deferred — see §3).

Plus three small, genuine cycles in the foundation/runtime layers:

- `errors.d ↔ globals.d ↔ file_manager.d ↔ utils.d ↔ sarif.d` (5 modules)
- `id.d ↔ identifier.d ↔ tokens.d` (3 modules)
- `common/file.d ↔ root/file.d ↔ root/filename.d` (3 modules)

**Consequence for the translation workflow:** the foundation layers (§4 Layers
0–6) translate as a clean topological list, one file at a time. The 76-module
core (Layer 7) **cannot** be ordered as independent files — it must be translated
as a *coordinated batch* using the stub-first / interface-split pattern from
`01-conventions.md` (see §2). The recommended internal order *within* that batch
is **type-definitions first, semantic-passes second**, derived from the in/out
degree analysis in §2.2.

---

## 1. Layer summary (foundation-first)

Layers are numbered by dependency depth: **Layer 0 = leaves** (depend on nothing
inside `dmd.*`), higher layers depend on lower ones. Translate strictly in
ascending layer order. Modules inside the same layer have no ordering constraint
between them (translate in any order, or in parallel) **unless** they are marked
as belonging to a cycle.

| Layer | Role | # mods | Key contents |
|------:|------|-------:|--------------|
| 0 | Pure leaves / data tables | 17 | `astenums`, `entity`, `rootobject`, `root/utf`, `root/rmem`, `root/hash`, `root/longdouble`, `root/optional`, `common/int128`, `common/blake3`, `common/bitfields`, `common/identifiertables`, `console`, `cli`, `imphint`, `root/man`, `visitor/parsetime` |
| 1 | Low-level runtime | 8 | `root/ctfloat`, `root/stringtable`, `root/aav`, `root/bitarray`, `common/charactertables`, `targetcompiler`, `visitor/strict`, `visitor/permissive` |
| 2 | Numeric/runtime | 2 | `root/complex`, `root/port` |
| 3 | **Identity + I/O kernel** (2 cycles) | 11 | `root/array`, `root/string`, `location`, `id`, `identifier`, `tokens` (cycle), `root/file`, `root/filename`, `common/file` (cycle), `common/outbuffer`, `common/smallbuffer` |
| 4 | Diagnostics & parse support | 8 | `errorsink`, `root/region`, `root/speller`, `ctorflow`, `dmacro`, `mangle/basic`, `visitor/transitive`, `vsoptions` |
| 5 | Lexer | 1 | `lexer` |
| 6 | **Globals/errors core** (1 cycle) | 5 | `globals`, `errors`, `file_manager`, `utils`, `sarif` (all one cycle) |
| 7 | **AST + semantic CORE** (the big SCC) | 87 | see §2 — translate as a coordinated batch, type-defs first |
| 8 | Post-core consumers + fast-DFA | 11 | `asttypename`, `json`, `doc` (in scope: the `-D` output), `ldcbindings`; the 7 `dfa/*` files (IN SCOPE, breakable — §3; TRANSLATED, semantic3.d:84's function-local edge is a value import LAST in semantic3.ts, 01 §4.4/§4.8); `argtypes_aarch64` (moved to the breakable set in 1.43; TRANSLATED — on the arm64 target it answers `__argTypes`, `sd.argTypes`, NRVO and `-preview=in`) |
| 9 | (excluded) | 1 | `dtoh` — **EXCLUDED**, do not translate |
| 10 | Frontend drivers | 2 | `cxxfrontend`, `mars` |
| 11 | CLI entry | 1 | `main` |

Notes:
- `cli.d` lands in Layer 0 because it is a self-contained option-spec table with
  no `dmd.*` deps; `vsoptions.d` (Windows toolchain probing) is Layer 4 — both are
  driver-adjacent and only matter for the CLI shim, not the lex→sema→CTFE core.
- Layers 8/10/11 are mostly **out of scope** under `_ground-truth.md §1.3`
  (no codegen, only a minimal CLI shim). `doc.d` and `json.d` are translated whole (`-D`, `-X`); `cxxfrontend.d`
  / `mars.d` / `main.d` (full driver) are translated only to the extent the `djs`
  CLI shim needs them. `argtypes_x86` and `ldcbindings` are ABI/codegen glue → skip;
  `argtypes_aarch64` and `argtypes_sysv_x64` are translated (§3).

---

## 2. Strongly-connected components (the cycles)

ESM circular imports load partially-initialized; a class referenced at module-eval
time before its definition is `undefined`. The handling pattern (stub-first /
type-only `import type` / lazy `await import()` / interface extraction) is owned by
**`01-conventions.md`** — this section only *identifies* the cycles so that doc and
the translation workflow know what they are up against. **Do not solve cycles here.** The
current tree loads from every entry module under vitest and under native ESM
(`src/dmd/loadorder.test.ts`); the cycles below remain, but no entry order is required.

### 2.1 The small foundation cycles (translate each as a unit)

**Cycle A — Identity (3 modules), Layer 3**
```
id.d  →  identifier.d  →  tokens.d  →  id.d
```
`id.d` (the table of predefined `Id.xxx` identifiers) imports `identifier`;
`identifier.d` imports `tokens` (for `TOK`) and `id`; `tokens.d` imports
`identifier`. Tight, small, all type/table definitions — translate the three
together in one pass.

**Cycle B — File/path I/O (3 modules), Layer 3**
```
common/file.d  ↔  root/file.d  ↔  root/filename.d
```
`root/filename.d` ↔ `root/file.d` are mutually recursive (filename ops read files,
file ops normalize names); `common/file.d` wraps both. Translate together.

**Cycle C — Globals/errors core (5 modules), Layer 6**
```
globals.d  ↔  errors.d  ↔  file_manager.d  ↔  utils.d  ↔  sarif.d
```
`globals` holds `Global`/`Param` and pulls in `errors`, `file_manager`, `utils`;
`errors` and `sarif` (SARIF diagnostic output) reference `globals.params`;
`file_manager` and `utils` reference both. This is the diagnostics/config hub.
Translate as a batch; expect `01-conventions.md`'s interface-extraction pattern
(split the `Global`/`Param` *data* from the *error-printing* functions).

### 2.2 The CORE SCC — AST + semantic analysis (the ball of mud)

This is the dominant structural fact of the whole port.

- **Full-graph SCC: 87 modules.**
- **Top-level-only SCC: 76 modules.** The 11 modules that leave the cycle once
  function-local imports are deferred are listed in §3 (the "breakable" set).

Even after deferring every function-local import, **76 modules remain mutually
recursive at module-evaluation time.** This is intrinsic to DMD's design
(`expression.d`, `declaration.d`, `dsymbol.d`, `mtype.d`, `statement.d`,
`aggregate.d`, etc. all reference each other's class types in field declarations
and method signatures). **They MUST be translated/stubbed together** — there is no
file ordering that makes them load cleanly in isolation.

**Internal translation order within the core (recommended, from in/out-degree):**

Ranking each core module by *in-degree* (how many other core modules depend on it)
vs *out-degree* (how many it depends on), within top-level edges, reveals two
clusters:

**(a) AST node TYPE DEFINITIONS — high in-degree, low out-degree. Translate FIRST
(as mutually-recursive stubs/classes), they are what everything else needs:**

| Module | in | out | Defines |
|---|--:|--:|---|
| `expression.d` | 64 | 17 | `Expression` + all expr node classes |
| `dsymbol.d` | 57 | 20 | `Dsymbol` root + symbol table |
| `mtype.d` | 56 | 13 | `Type` + all type node classes |
| `arraytypes.d` | 54 | 10 | `Array!T` aliases (e.g. `Expressions`, `Dsymbols`) |
| `declaration.d` | 51 | 14 | `Declaration`, `VarDeclaration`, `FuncDeclaration` base |
| `func.d` | 45 | 19 | `FuncDeclaration` + friends |
| `dscope.d` | 43 | 15 | `Scope` |
| `aggregate.d` | 37 | 12 | `AggregateDeclaration` |
| `dclass.d` | 34 | 8 | `ClassDeclaration`, `InterfaceDeclaration` |
| `init.d` | 32 | 3 | `Initializer` node classes |
| `dmodule.d` | 32 | 14 | `Module`, `Package` |
| `dstruct.d` | 31 | 13 | `StructDeclaration`, `UnionDeclaration` |
| `dtemplate.d` | 32 | 23 | `TemplateDeclaration`, `TemplateInstance` |
| `statement.d` | 26 | 9 | `Statement` node classes |
| `attrib.d` | 24 | 12 | attribute decl nodes |
| `denum.d` | 14 | 6 | `EnumDeclaration`, `EnumMember` |
| `aliasthis.d` | 14 | 1 | `AliasThis` |
| `dimport.d` | 14 | 3 | `Import` |
| `nspace.d` | 7 | 3 | `Nspace` |
| `cond.d` | 11 | 13 | `Condition` (version/debug/static-if) nodes |

Also translate the visitor *infrastructure* with this group, since the node
classes carry `accept(Visitor)` methods: `visitor/package.d` (base `Visitor`),
`ast_node.d`, `astcodegen.d` — these are in the breakable set (§3) and sit at the
root of the visitor hierarchy; they should be available before the node classes'
`accept` methods are filled in.

**(b) SEMANTIC PASSES — high out-degree, lower in-degree. Translate SECOND, they
consume the node types and each other:**

| Module | in | out | Pass |
|---|--:|--:|---|
| `dsymbolsem.d` | 33 | 48 | symbol `semantic()` pass — the spine |
| `expressionsem.d` | 28 | 53 | expression `semantic()` |
| `typesem.d` | 34 | 36 | type resolution `semantic()` |
| `funcsem.d` | 23 | 34 | function semantic |
| `statementsem.d` | 4 | 36 | statement semantic |
| `enumsem.d` | 4 | 47 | enum semantic |
| `templatesem.d` | 7 | 30 | template instantiation/matching |
| `templateparamsem.d` | 5 | 9 | template-parameter semantic |
| `initsem.d` | 11 | 24 | initializer semantic |
| `semantic2.d` | 11 | 40 | pass 2 (signatures) |
| `semantic3.d` | 9 | 42 | pass 3 (bodies) |
| `attribsem.d` | 3 | 6 | attribute semantic |
| `pragmasem.d` | 1 | 9 | pragma semantic |
| `dcast.d` | 21 | 26 | implicit/explicit conversion |
| `opover.d` | 16 | 20 | operator-overload rewriting |
| `clone.d` | 5 | 20 | auto-generated `opAssign`/postblit/cmp |

**(c) CTFE + constant folding — depend on (a) and (b). Translate THIRD within the
core (they are still inside the SCC because they reference node types and are
referenced back by `*sem`):**

```
constfold.d   (compile-time constant folding of expression nodes)
ctfeexpr.d    (CTFE expression representations)
dinterpret.d  (the CTFE interpreter — 258 KB, the largest single module)
optimize.d    (expression optimizer, used by CTFE & sema)
```

**(d) Mangling — `mangle/package.d` is inside the core SCC** (it is imported by
`dsymbol`/`func`/`typesem` and imports node types back). `mangle/basic.d` is a
clean Layer-4 leaf; `mangle/cpp.d` and `mangle/cppwin.d` are *breakable* (§3) —
their cycle edges are function-local. Per `_ground-truth.md §1.8`, **mangle is
KEPT.** Translate `mangle/package.d` with the core; `mangle/cpp.d` /
`mangle/cppwin.d` after, with their lazy edges deferred.

**(e) Remaining core utilities** (analyses that ride along inside the SCC, lower
priority — translate after the type-defs + sema spine compiles): `access`,
`safe`, `nogc`, `canthrow`, `escape`, `ob` (ownership/borrowing), `sideeffect`,
`blockexit`, `ctorflow`(L4), `intrange`, `chkformat`, `builtin`, `traits`,
`inline`, `inlinecost`, `mustuse`, `staticassert`, `delegatize`, `arrayop`,
`typinf`, `objc`, `compiler`, `target`, `deps`, `dversion`, `impcnvtab`,
`hdrgen` (header gen / `.di` — used by diagnostics & `-H`), `printast`,
`stmtstate`, `timetrace`, `visitor/foreachvar`, `visitor/postorder`,
`visitor/statement_rewrite_walker`.

> **Workflow guidance:** the practical approach (detailed in `01-conventions.md`)
> is: (1) emit *all 76 class headers as stubs* (empty bodies, correct
> `extends`/field types via `import type`) so TS can resolve the type graph, then
> (2) fill bodies in the (a)→(b)→(c) order above. A class field of another core
> type uses a value reference; a same-eval-time construction of another core class
> needs the lazy/stub treatment. The cycle is unavoidable — manage it, don't fight
> it.

---

## 3. "Breakable" modules — out of the SCC via deferred (function-local) imports

These 19 modules are in the 95-module *full* SCC but **NOT** in the 76-module
*top-level* SCC: their only cycle-closing import is function-local (indented).
In ESM, that import becomes a deferred reference, so these can be translated
*after* the core type-defs are stubbed, treating their back-edge as a lazy
`import()` / `import type`:

```
ast_node.d              astcodegen.d            visitor/package.d   (visitor base hierarchy)
target.d                                                            (target info; lazy mangle.cpp + argtypes edges)
mangle/cpp.d            mangle/cppwin.d                              (C++ mangling; lazy node-type edges)
staticcond.d                                                        (static-condition eval; lazy *sem edges)
lambdacomp.d            hooks.d                                     (lambda comparison; LDC traits hook — TRANSLATED)
argtypes_x86.d                                                      (ABI arg classification, 32-bit x86 — SKIP)
argtypes_aarch64.d      argtypes_sysv_x64.d                         (arg classification, AArch64 / x86_64 — TRANSLATED)
dfa/entry.d             dfa/utils.d                                 (fast-DFA — IN SCOPE, new in 2.113)
dfa/fast/structure.d    dfa/fast/analysis.d     dfa/fast/expression.d
dfa/fast/statement.d    dfa/fast/report.d
```

`argtypes_x86.d` is ABI/codegen glue for a target no supported triple is (out of scope per
`_ground-truth.md §1.3`). `argtypes_aarch64.d` is NEW here in 1.43 and TRANSLATED, and so is
`argtypes_sysv_x64.d`: `Target.toArgTypes` (gen/target.cpp:339-342) calls one of them by the
triple's arch (10 §4.8), and through
`TargetABI::getArgTypes` (gen/abi/abi.cpp:78) its answer decides NRVO (semantic3.d:666,
funcsem.d:2801), `__traits(isReturnOnStack)` (traits.d:1495), `__argTypes`
(expressionsem.d:9147), `sd.argTypes` (dsymbolsem.d:10290) and `in` parameters under
`-preview=in` (typesem.d:4125). `target.d`'s own imports of them (target.d:1114, :1217) sit in
the `!IN_LLVM` arm and resolve away; the TS edges are module-level value imports in
`target.ts`, LAST (01 §4.4/§4.8). `ldcbindings.d` is LDC-specific glue; `hooks.d` is translated
(`src/dmd/hooks.ts`): it is the import path of `__traits(targetCPU)`/`__traits(targetHasFeature)`
(traits.d:2069-2076). The **`dfa/` subtree is IN
SCOPE** (fast-DFA preview engine, `_config.md` `FastDFA` row): its only attachment to the
core is `semantic3.d`'s function-local `version(FastDFA) import dmd.dfa.entry;`
(semantic3.d:84, call at :1482), which gets the standard deferred-edge treatment. The rest
(`ast_node`, `astcodegen`, `visitor/package`, `target`, `mangle/cpp[win]`, `staticcond`)
are in-scope and benefit directly from the deferred-import handling in
`01-conventions.md`.

---

## 4. Excluded modules — strip/stub these imports during translation

Per `_ground-truth.md §1.8`. The importer/translation agent must **strip or stub**
references to these when translating the files that import them. Verified by direct
grep against the source tree (the importer lists below are authoritative).

| Excluded module | Why excluded | Imported by (strip the edge here) |
|---|---|---|
| `dtoh.d` | C++ header gen | `cxxfrontend.d`, `mars.d`, `main.d` |

**Handling note:** these are imported by *in-scope* core modules
(`dsymbolsem`, `expressionsem`, `typesem`, `statementsem`, etc.). When translating
those files, the agent must (a) drop the `import`, and (b) at each call site to an
excluded function, either remove the branch (if the construct is excluded from the
language, e.g. `asm{}` blocks) or replace it with a STOP/throw
stub (`01-conventions.md` / `11-escalate.md`). The branches are typically guarded
so deletion is local and auditable. Record each strip with the resolved-comment
convention from `_ground-truth.md §5`.

**Also out-of-graph (no source file in this tree — LDC build provides them):**
`dmd.dmdparams` (imported by `target.d`, `mars.d`, `main.d`),
`dmd.root.strtold` (imported by `root/ctfloat.d` — a C `strtold` binding;
replace with JS `parseFloat`/`Number` per `09-numerics.md`),
`dmd.backend.cc` (codegen — out of scope).

---

## 5. The ordered file list (the buckets the translation workflow consumes)

Translate top-to-bottom. Within a bucket, order is free **except** cycle members
(marked `‹cycle X›`) which translate together. Excluded files (§4) and
codegen/driver glue are listed at the end as **DO NOT TRANSLATE**.

```
### BUCKET 0 — pure leaves
astenums.d  entity.d  rootobject.d  imphint.d
root/utf.d  root/rmem.d  root/hash.d  root/longdouble.d  root/optional.d  root/man.d
common/int128.d  common/blake3.d  common/bitfields.d  common/identifiertables.d
console.d  cli.d  visitor/parsetime.d

### BUCKET 1 — low-level runtime
root/ctfloat.d  root/stringtable.d  root/aav.d  root/bitarray.d
common/charactertables.d  targetcompiler.d  visitor/strict.d  visitor/permissive.d

### BUCKET 2 — numeric/runtime
root/complex.d  root/port.d

### BUCKET 3 — identity + I/O kernel
root/array.d  root/string.d  location.d  common/outbuffer.d  common/smallbuffer.d
‹cycle A›  id.d  identifier.d  tokens.d
‹cycle B›  root/file.d  root/filename.d  common/file.d

### BUCKET 4 — diagnostics & parse support
errorsink.d  root/region.d  root/speller.d  ctorflow.d  dmacro.d
mangle/basic.d  visitor/transitive.d  vsoptions.d

### BUCKET 5 — lexer
lexer.d

### BUCKET 6 — globals/errors core
‹cycle C›  globals.d  errors.d  file_manager.d  utils.d  sarif.d

### BUCKET 7 — AST + SEMANTIC CORE  (the 76-module SCC; translate as one batch)
# 7a — visitor base + AST node TYPE DEFINITIONS (stub all headers first)
visitor/package.d  ast_node.d  astcodegen.d  asttypename.d
arraytypes.d  mtype.d  expression.d  declaration.d  dsymbol.d  dscope.d
statement.d  init.d  aggregate.d  dstruct.d  dclass.d  denum.d  func.d
attrib.d  aliasthis.d  dimport.d  nspace.d  cond.d  dtemplate.d  dmodule.d
# 7b — parser (consumes node types; produces AST)
parse.d
# 7c — semantic passes
typesem.d  templateparamsem.d  templatesem.d  dsymbolsem.d  funcsem.d
expressionsem.d  statementsem.d  initsem.d  enumsem.d  attribsem.d  pragmasem.d
dcast.d  opover.d  clone.d  impcnvtab.d  semantic2.d  semantic3.d
# 7d — CTFE + constant folding
constfold.d  ctfeexpr.d  optimize.d  dinterpret.d
# 7e — mangling (KEPT)
mangle/package.d
# 7f — analyses & support riding in the SCC
access.d  safe.d  nogc.d  canthrow.d  escape.d  ob.d  sideeffect.d  blockexit.d
intrange.d  chkformat.d  builtin.d  traits.d  staticassert.d  staticcond.d
delegatize.d  arrayop.d  typinf.d  mustuse.d  inline.d  inlinecost.d
compiler.d  target.d  deps.d  dversion.d  hdrgen.d  printast.d  stmtstate.d
timetrace.d  lambdacomp.d  objc.d
visitor/foreachvar.d  visitor/postorder.d  visitor/statement_rewrite_walker.d

`printast.d` is NOT translated although listed in 7f: its only caller outside itself,
`expressionsem.d:9852`, sits under `static if (LOGSEMANTIC)` (OFF), and `ob.d:40` and
`visitor/foreachvar.d:34` import it without referencing a symbol; both imports are dropped with
the 07 audit comment. The remaining D caller of `foreachExpAndVar`, `dfa/fast/statement.d:1475`,
lands with the fast-DFA subtree (BUCKET 8).

`inline.d` and `inlinecost.d` are translated whole. Under ldc2 only `inlineCopy` (inline.d:92) runs
— the default-argument leg of `functionParameters` (expressionsem.d:4253) — with
`inlineCostExpression` and `DoInlineAs!Expression`. The scan (`inlineScanPragmaInline`,
`inlineScanAllFunctions` and everything they reach) is called only from main.d:777-797, the
`!IN_LLVM` arm of main.d:771; LDC runs `extraLDCSpecificSemanticAnalysis` there, driver/main.cpp
calls neither scan, and ldc2 has no `-inline` switch. The shim never calls the scan.

### BUCKET 8 — breakable post-core (deferred-import treatment)
mangle/cpp.d  mangle/cppwin.d  json.d  doc.d  cparse.d  importc.d  argtypes_aarch64.d  argtypes_sysv_x64.d
# fast-DFA subtree (IN SCOPE, new in 2.113) — internal order: leaves first, entry last
dfa/utils.d  dfa/fast/structure.d  dfa/fast/expression.d  dfa/fast/statement.d
dfa/fast/report.d  dfa/fast/analysis.d  dfa/entry.d

### BUCKET 9 — driver shim (only what the `djs` CLI needs)
cxxfrontend.d  mars.d  main.d

### DO NOT TRANSLATE — excluded (§4) and codegen/ABI/LDC glue (ground-truth §1.3/§1.8)
dtoh.d
argtypes_x86.d  ldcbindings.d
```

Exception: `gen/dpragma.d`, `gen/llvmhelpers.d`'s DtoSetFuncDeclIntrinsicName and `gen/ldctraits.d`
(with its gen/ldctraits.cpp bodies, the target machine folded to the default CPU of the triple's arch,
LLVM 22.1.8) are translated to `src/gen/` (frontend-visible pragma recognition, checks,
declaration state, intrinsic names, `__traits(targetCPU)`/`__traits(targetHasFeature)`);
`dmd/hooks.d`, the one-line forwarder into gen.ldctraits, is translated to `src/dmd/hooks.ts`. The same
treatment covers the frontend half of three more LDC files: gen/asmstmt.cpp's `asmSemantic` →
`src/gen/asmstmt.ts` (`11-escalate.md §3.2`), gen/uda.cpp's `hasComputeAttr` and the
`getMagicAttribute` it calls → `src/gen/uda.ts` (gen/semantic.d's DCompute gate, read by
`extraLDCSpecificSemanticAnalysis`, which is ported with gen/semantic.d to `src/gen/semantic.ts`, 01 Rule 1.1), and driver/cpreprocessor.cpp → `src/driver/cpreprocessor.ts`
(ImportC's C preprocessor, `FEATURES.md`).

---

## 6. Cross-references

- **Cycle handling pattern** (stub-first / `import type` / lazy `import()` /
  interface extraction): owned by `01-conventions.md`. This doc only *identifies*
  the cycles (§2).
- **STOP/escalate stubs** for stripped excluded-module call sites: `11-escalate.md`.
- **Resolved-comment convention** for stripped imports: `_ground-truth.md §5`.
- **Numerics** (`root/ctfloat.d` `strtold` replacement, `common/int128.d`,
  `root/longdouble.d`): `09-numerics.md`.
- **Runtime container** (`root/array.d` `Array!T` → TS): `08-runtime-lib.md`.
