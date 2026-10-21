# Changelog

## 0.2.0 (preview)

- `queryUnused`: the declarations the program's `main` cannot reach (functions, methods, templates, aggregates,
  enums, mutable globals) in the D modules the last compile analysed, for its target and flags. A name used in a
  branch not compiled or in a unittest not compiled keeps a declaration; a compile with errors or without a `main`
  answers none.
- Editor queries: the outline of a file (`queryDocumentSymbols`), the references of a symbol (`queryReferences`),
  rename (`queryPrepareRename`, `queryRename`, refused where a use could be missed or the new name clashes),
  signature help (`querySignatureHelp`), completion without a dot, the doc summary of the overload an operator or a
  UFCS call takes; names in a function body with errors answered by position.
- `-H`, `-Hd`, `-Hf`, `-Hkeep-all-bodies` (`.di` headers), `-mixin=` and `-deps[=<file>]` (also `--deps`): the
  frontend's own outputs, written as ldc2 writes them. `-edition[=NNNN[<file>]]`, `-noasm`; `-nogc` accepted (it acts
  only in code generation).
- `-mcpu=` (`native` on an M2, the Apple M1-M5, Cortex-A53/A72/A76/A78AE, the x86-64 levels; `avx`, `avx2`):
  `__traits(targetCPU)`, `__traits(targetHasFeature)`, `D_AVX`/`D_AVX2` and ldc2's warnings, as ldc2 gives them.
- The kept-module engine drops, at the next compile, a unit that skipped analysis because errors were already
  reported (a copy constructor not looked for, a `__traits` type not reported, a struct's `isPOD` answer cached).
- The kept-module engine keeps a save that adds or drops an import whose analysis leaves symbols deferred (`std.json`),
  where it compiled fresh: a kept unit that retries the deferred symbols without work replays under others.
- The emitted JavaScript carries no comments: a smaller module graph to load at every start.

## 0.1.0 (preview) — LDC 1.43.0 baseline

The frontend of LDC 1.43.0 in TypeScript: lexer, parser, semantic analysis, CTFE, ImportC, Ddoc, the JSON output
and `-vcg-ast`, with ldmd2's command line and diagnostics byte for byte on LDC's DMD test suite and on the bundled
import tree. Targets: the host, `aarch64-linux-gnu`, `x86_64-linux-gnu`. In-process API: `djsMain`, the kept-module
engine `djsMainKept`, and the AST queries an editor uses. The DMD-style inline assembler on x86_64 is kept
unanalysed, with a warning.
