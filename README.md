# djs for VS Code

D language support for VS Code, answered by the D compiler's own frontend. [djs](https://github.com/DeepGlance/djs)
is the frontend of LDC 1.43.0 (DMD 2.113) ported to TypeScript; this extension runs it in a worker thread inside VS
Code, so diagnostics, hovers, references and completions are the compiler's, for the flags and the target of your
build, with no D toolchain installed.

**Preview.** 0.1.0 is the first release: expect rough edges, and report them.

![An error typed, a hover, a completion after a dot](https://raw.githubusercontent.com/DeepGlance/djs-vscode/main/extension/media/demo.gif)

## Install

From the Extensions view (search `djs`) or with `code --install-extension deepglance.djs-vscode`, then open a folder
and a D file: no setting is needed.

## What it does

![A diagnostic on unsaved text](https://raw.githubusercontent.com/DeepGlance/djs-vscode/main/extension/media/diagnostic.png)

*A diagnostic on unsaved text*: errors, warnings and deprecations when a file is opened, on save and after a pause in
typing, exactly as ldc2 reports them.

![A hover with the UFCS call resolved](https://raw.githubusercontent.com/DeepGlance/djs-vscode/main/extension/media/hover.png)

*A hover with the UFCS call resolved*: kind, signature, doc comment, and what the compiler made of the code (lowered
operators, UFCS, `alias this`, the overload picked, implicit conversions).

![Completion after a dot](https://raw.githubusercontent.com/DeepGlance/djs-vscode/main/extension/media/completion.png)

*Completion after a dot*: members, UFCS candidates and built-in properties; while a name is typed, the names in scope.

![The AST view beside the source](https://raw.githubusercontent.com/DeepGlance/djs-vscode/main/extension/media/ast.png)

*The AST view beside the source*: the module as `-vcg-ast` prints it, with navigation back to the source.

And without a picture:

- **Go to definition** from any identifier the compile resolved.
- **Find all references** through UFCS, property calls, template instances and folded constants.
- **Rename** over those references, refused with the reason where a use could be missed.
- **Outline**, breadcrumbs and Go to Symbol from the compiled declarations, string-mixin declarations included.
- **Signature help** with the overload the compiler picked first and the argument under the cursor.
- **Inlay hints**: inferred types, parameter names at call sites, a template's instance count.
- **Inactive branches dimmed**: the `version`, `debug` and `static if` branches your target and flags do not compile.
- **Semantic highlighting** over code-d's TextMate grammar.
- **Expansion peeks** of string mixins, template instances and folded values; **explorers** of template instances and
  of the import graph.
- **Three targets**: arm64 macOS (`arm64-apple-macos15`), `aarch64-linux-gnu` and `x86_64-linux-gnu`; the host's by
  default, another from `-mtriple` in your ldc2 line or the `djs.target` setting.
- **Zero config**: with no setting, the default line `ldc2 -i -I<folder>` plus the folder's `source/` and `src/`
  (dub's layouts); your build's ldc2 command line goes in `djs.ldc2Line`.
- **Restricted Mode**: in an untrusted folder everything works with the default line and the bundled import tree; the
  folder's `djs.ldc2Line` and `djs.ldcRoot` wait for trust.

Everything answers from the last compile. The settings, the targets and the limits (memory, fresh compiles, completion
one compile behind) are on the extension's page, [`extension/README.md`](extension/README.md).

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
DJS_VSCODE_SCRATCH=<dir> npm run package    # bundle + vsce: <dir>/djs-vscode-<version>.vsix
```

Install a `.vsix` with **Extensions: Install from VSIX...**, or `code --install-extension <file>.vsix`.
`DJS_VSCODE_SCRATCH=<dir> npm run test:vscode` runs the integration tests in an installed VS Code (the fixture trusted,
then untrusted), with a user-data and extensions directory of its own under `<dir>`.

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
