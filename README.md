# djs for VS Code

D language support for VS Code, answered by the D compiler's own frontend. [djs](https://github.com/DeepGlance/djs)
is the frontend of LDC 1.43.0 (DMD 2.113) ported to TypeScript; this extension runs it in a worker thread inside VS
Code, so diagnostics, hovers, references and completions are the compiler's, for the flags and the target of your
build, with no D toolchain installed.

**Preview.** 0.1.0 is the first release.

## Features

Diagnostics on save and after a pause in typing, exactly as ldc2 reports them; hover with what the compiler made of
the code (lowered operators, UFCS, `alias this`, the overload picked); go to definition; outline; find all
references and rename; signature help; completion after a dot; semantic highlighting over code-d's TextMate grammar;
inlay hints; the `version`/`debug`/`static if` branches your target does not compile, dimmed; peeks at string mixins,
template instances and folded values; the module's AST as `-vcg-ast` prints it; explorers for template instances and
the import graph. Everything answers from the last compile. The extension's page, with the settings, the targets and
the limits, is [`extension/README.md`](extension/README.md).

## Requirements

VS Code 1.140 or later on an arm64 Mac or on Linux (aarch64 or x86_64). No LDC, DMD or DUB install: djs runs on the
Node.js inside VS Code and ships LDC 1.43.0's druntime and Phobos import tree. ImportC needs a C compiler for the
preprocessor (`$CC` or `cc`).

## Building from source

Node 22 or later.

```sh
npm ci
npm run build                  # dist/: the compiler, the worker, the extension
npx tsc -p host/tsconfig.json  # type-checks the host and the integration test
npm run test:host              # the worker and the queries on the fixture in host/fixture/
npm test                       # the compiler's own suite
DJS_VSCODE_SCRATCH=<dir> npm run package    # bundle + vsce: <dir>/djs-<version>.vsix
```

Install the `.vsix` with **Extensions: Install from VSIX...**, or `code --install-extension <file>.vsix`.
`DJS_VSCODE_SCRATCH=<dir> npm run test:vscode` runs the integration test in an installed VS Code, with a user-data and
extensions directory of its own under `<dir>`.

## Repository layout

- `src/`, `docs/`, `ldc-1.43.0/` and `tests/` except `tests/vscode/`: the compiler, from
  [DeepGlance/djs](https://github.com/DeepGlance/djs), whose README says what it does and does not do.
- `host/`: the worker thread and everything that runs without VS Code (the command-line plan, positions, the queue).
- `extension/`: the VS Code side, with the package's README, CHANGELOG and icon.
- `tests/vscode/`: the integration test.
- `syntaxes/`: code-d's TextMate grammar, unmodified (MIT, notice in `syntaxes/LICENSE-code-d`).

## Licence

BSL-1.0, with the derived sets (DMD, LDC, LLVM behaviour models, code-d's grammar, LDC's import tree) named in
`LICENSE`.
