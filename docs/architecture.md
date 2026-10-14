# djs — architecture and guarantees

> STATUS: LIVING — the public description of djs's layout and of what it guarantees to a caller. Owner: Paolo
> Invernizzi. Updated: 2026-10-13.

## Layout

| Path                      | What it is                                                                           |
|---------------------------|--------------------------------------------------------------------------------------|
| `src/dmd/`                | LDC 1.43.0's `dmd/` (the DMD frontend) in TypeScript, one `.ts` per `.d`             |
| `src/gen/`, `src/driver/` | The frontend parts of LDC's C++ `gen/` and `driver/`: pragmas, traits, target, cpp   |
| `src/djs.ts`              | The entry: ldc2's driver (command line, target, import tree); `djsMain`              |
| `src/keep.ts`             | The kept-module engine behind `djsMainKept`                                          |
| `src/query.ts`            | Read-only queries on the last compilation's AST (hover, definition, completion, ...) |
| `ldc-1.43.0/`             | LDC 1.43.0's import tree, unmodified, with LDC's LICENSE                             |
| `tests/corpus/`           | The runner that compares djs with `ldmd2` on LDC's `tests/dmd`                       |
| `tests/phobos/`           | The runner that compiles each module of the import tree with both compilers          |

The port keeps the D frontend's structure: the same modules, classes, functions and control flow, so that a
change in a later LDC release maps to the same place in djs. Each file cites the D or C++ lines it ports.

## Guarantees

**The command line.** djs takes ldmd2's command line. It exits 0 when no error was reported, 1 when one was, and 2
for a switch it does not support (named on stderr, before the frontend runs). An internal error prints
`Internal error:` and exits 1. Diagnostics go to stderr and `message`-kind text to stdout, in ldc2's order.

**Fidelity.** For every switch it accepts, djs's exit status, stdout, stderr and written files (`.cg`, `.json`,
`.html`) are those of `ldmd2 -c -o-` from LDC 1.43.0 on the same files and target, byte for byte. The proof is
LDC's DMD test suite and the import tree, run by the two runners above against an LDC 1.43.0 install (set the
`ORACLE CONSTANT`s in the runners and tests to yours to run them). The divergences are declared in the README.

**In-process calls.** `djsMain` may be called any number of times in one process; each call starts from a reset
frontend and compiles as a fresh process would. The last compilation's AST stays reachable until the next call.

**Editor mode.** `djsMain(args, onFatal)` with a handler answering `true` returns from every fatal error and runs
the next pass, so a module with a parse error or a failed import is still analysed. The output up to the first
fatal point is ldc2's; what follows has no oracle (some diagnostics repeat). Pass `-o-`. A failed ImportC file stops
the compile as the CLI does.

**The kept-module engine.** `djsMainKept(args, onFatal, options)` gives the status, stdout, stderr and diagnostic
handler calls of a fresh compile of the same arguments and files, byte for byte. It re-analyses what changed (a
file's content, an import's resolution, a module's role, a string import, the command line) and replays the
recorded analysis of the rest. When it cannot keep, it compiles fresh and says why. Switches that write files
(`-vcg-ast`, `-X`, `-D`, `-v`, `-vtemplates`) always compile fresh. Declared divergences: a struct with an anonymous
bit-field read through `.tupleof` before its size is final; and, in editor mode after an error, analyses a fresh
compile would skip because an error was already reported.

**Queries.** The query functions read the AST of the last compilation and change nothing: a compile after a query
gives the output it gives without it. A query on a text that differs from the compiled one answers nothing.

**Targets.** The host's triple by default (arm64 macOS, aarch64 or x86_64 Linux), or `-mtriple` for
`aarch64-linux-gnu`, `x86_64-linux-gnu` and the arm64 Mac. CTFE computes `real` in the host's double.
