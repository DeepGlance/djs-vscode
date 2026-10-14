# djs

The frontend of LDC 1.43.0, the LLVM-based D compiler, ported to TypeScript. djs lexes, parses and analyses D
source in-process, in Node, and reports what ldc2 reports. It generates no code.

## What it is for

- **Diagnostics**: errors, warnings, deprecations and supplemental lines with the same text, locations, order and
  exit status as `ldmd2 -c -o-`.
- **The frontend's outputs**: `-vcg-ast` (the lowered AST as D source), `-X` (the JSON description), `-D` (Ddoc
  HTML), `-v`, `-vgc`, `-vtls`, `-vtemplates`.
- **A library for tools**: `djsMain(args)` runs one compilation in the calling process; `djsMainKept(args)`
  recompiles after an edit by replaying the analysis of the modules that did not change; the query functions
  (`queryHover`, `queryDefinition`, `querySemanticTokens`, `queryInlayHints`, `queryCompletion`, and the others
  exported by `src/djs.ts`) answer on the AST of the last compilation. These are what an editor extension needs.

## Quick start

Node 22 or later.

```sh
npm install
npx tsc --noEmit false                     # emits dist/
node --stack-size=7600 dist/djs.js -c -o- hello.d
```

The command line is ldmd2's (DMD spellings, plus the ldc2 spellings ldmd2 passes through). `-c -o-` is the mode
djs is built for; a switch djs does not support stops the run with status 2 and names the switch.

The D import tree (druntime, Phobos, LDC's own modules, LDC 1.43.0's, unmodified) is bundled in
`ldc-1.43.0/import`, so no D installation is needed. `--djs-ldc=<root>` makes djs read the import tree of an ldc2
1.43.0 install instead, and report its `ldc2.conf` as ldc2 would; the oracle tests and runners use it to compare
djs with that install's `ldmd2`.

As a library:

```ts
import { djsMain } from "./dist/djs.js";

const status = djsMain(["-c", "-o-", "app.d"]);   // 0, or 1 when an error was reported
```

`djsMain(args, onFatal)` with a handler answering `true` lets the compilation continue past a fatal error (a parse
error, a missing import), as an editor wants.

## Targets

Without `-mtriple`, the target is the host: `arm64-apple-darwin` on an Apple Silicon Mac,
`aarch64-unknown-linux-gnu` or `x86_64-unknown-linux-gnu` on Linux. Any other host needs an explicit `-mtriple`.
Accepted triples: `aarch64-linux-gnu`, `x86_64-linux-gnu` (and their `-unknown-` spellings) and the arm64 Mac's. The
triple decides what ldc2 decides from it: predefined versions, `real`'s size and format, the C ABI's argument
types, `__traits(targetCPU)`, the inline assembler rules, the C preprocessor invocation.

## Fidelity and limits

On the DMD test suite shipped with LDC 1.43.0 (`tests/dmd`, 3861 tests), every test djs runs gives ldmd2's exit
status, stdout, stderr and written files, byte for byte; the tests it does not run are those disabled for the
target, Objective-C, separate compilation, and switches djs refuses. Every module of the bundled import tree
compiles with ldmd2's output, `-vcg-ast` included, plain and with `-unittest`.

Known limits and divergences:

- **No code generation.** Object files, linking, `-run` and `-lib` are out of scope; runnable tests are compiled,
  never run.
- **Refused switches** include `-H`/`-HC` (header generation), `-m32`, `-lib`, `-mixin=`, `-deps`, `-makedeps`.
- **DMD-style inline assembler on x86_64** is not analysed: the block is kept as an opaque statement and the module
  gets one warning (shown under `-wi`/`-w`, never counted as an error). Errors inside the block, and labels or
  closures created only by it, are not reported. GCC-style `asm` is analysed as ldc2 does. See LICENSE for why.
- **DCompute** (`@compute` modules) is not supported.
- **CTFE floating point** computes `real` in the host's double, as ldc2 on an arm64 Mac does, whatever the target's
  `real` is.
- **ImportC** runs the system C preprocessor, as ldc2 does; no sysroot is passed unless the command line passes one.
- **Memory**: an application of a few hundred modules peaks around 2 GiB of RSS on a fresh compile.
- **The kept-module engine** gives a fresh compile's output, or compiles fresh and says why; its few declared
  divergences are listed in `docs/architecture.md`.

## Licence

Boost Software License 1.0, with the code ported from LDC's own C++ under LDC's three-clause BSD licence and the
bundled import tree under its own licences. `LICENSE` lists each set.
