# Changelog

## 0.3.0 (preview)

- Editor mode (a host's fatal handler answering true): an error reported to the host no longer switches analysis off
  elsewhere: the frontend tests that skip analysis once any error was reported (`needCopyOrMoveCtor`, the deferred
  semantic2/semantic3 loops, `templatesem.d:3001` under gag, `typesem.d:4405`) read the gagged errors of the open gag
  windows, as a compile without the reported errors does. A kept compile after a parse or a semantic error prints and
  analyses what a fresh one does; the editor's output is ldc2's up to the first error. The CLI reads `global.errors`,
  as ldc2.
- `queryHover`, `queryDefinition`, `querySignatureHelp`, `queryReferences` and `queryPrepareRename`/`queryRename`
  answer nothing in a branch not compiled (`INACTIVE_REASON`), as the semantic tokens and the inlay hints: some
  answered a type's or a function's name from the chosen branch's scope. Completion still answers there. A rename of a
  name spelled in a branch not compiled is refused (the references miss those uses).
- `queryCompletion` orders a group's names by label ignoring case, a name with a leading `_` last (dmd's
  `Expression._init()` came first among an `Expression`'s members).
- The kept-module engine runs passes 2 and 3 of `main`'s `mixin _d_cmain!()` again in a kept compile, as a fresh one
  does: after an unchanged recompile `queryUnused` reported the `_Dmain` it declares.
- The kept-module engine takes whether a unit ran inside a retry of the deferred symbols as a replay condition both
  ways: a unit whose work changes them replayed in the other state aborts, and one recorded inside a retry and
  replayed outside one with deferred symbols, or symbols it defers, is probed: it printed in another order.
- The kept-module engine keeps a save that adds an import again whose analysis leaves symbols deferred (`std.json`):
  a list of deferred symbols a replay was proved under is remembered with the unit (the last four).
- The kept-module engine logs the deferred symbols a requester's own work changes between two requests (a struct an
  instance deferred, completed by the module's retry): an unchanged recompile of LDC's dmd sources keeps, where every
  one aborted.
- A lookup that passes through a kept module before its semantic and finds nothing there no longer aborts a kept compile
  (an edit of LDC's `dmd/expressionsem.d`); one that finds the module's own member, or a symbol through an import its
  semantic added or made public, still aborts.
- A module whose member another module's code found before the module's semantic is analysed again with that code (a
  lookup above the `import`): an edit of LDC's `dmd/expressionsem.d` keeps, about two thirds of a fresh compile (88 of
  its 216 modules are in the root's import cycle).
- A package-qualified name checked through a kept module whose semantic opened the package (a `static if` public import)
  aborts the kept compile, which printed the name's value where a fresh one reports it undefined.

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
