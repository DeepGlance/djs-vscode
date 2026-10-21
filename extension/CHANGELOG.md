# Changelog

## 0.2.0 (preview)

On djs 0.2.0.

- Unused code: the declarations the program's `main` cannot reach (functions, methods, templates, aggregates, enums,
  mutable globals) shown as greyed hints in the modules the last compile analysed, for its target and flags, the
  reason on hover ("unused in this build: <kind> <name>, <why>"). Asked after the compile of a save or an opening; a
  compile with errors, or without a `main`, gives none. Setting `djs.unusedCode` (on by default); command
  **djs: Show Unused Code** lists them in a quick pick.

## 0.1.0 (preview)

The first release, on djs 0.1.0 (the LDC 1.43.0 frontend, DMD 2.113, in TypeScript).

- Diagnostics when a file is opened, on save and after a pause in typing, from the unsaved text of the open D files.
- No setting needed: with `djs.ldc2Line` empty, the line `ldc2 -i -I<folder>` plus the folder's `source/` and `src/`.
- Restricted Mode: limited support in an untrusted folder, the default line and the bundled import tree, the folder's
  `djs.ldc2Line` and `djs.ldcRoot` ignored until it is trusted.
- Hover with the lowerings resolved, go to definition, completion after a dot and of the names in scope.
- Outline (outline view, breadcrumbs, Go to Symbol in Editor), find all references, rename, signature help.
- The doc summary of the overload an operator calls on its hover, and of the overload a UFCS completion takes.
- Semantic highlighting, inlay hints (inferred types, parameter names, template instance counts), inactive branches
  dimmed.
- Expansion peeks and code lenses, the AST view, the D Instances and D Imports explorers.
- Targets: the host (arm64 macOS, aarch64 or x86_64 Linux), `aarch64-linux-gnu`, `x86_64-linux-gnu`, arm64 macOS
  triples; LDC 1.43.0's import tree bundled.

### Known limitations

- On some large codebases (the DMD frontend in LDC's sources, for one) the kept engine does not keep: every compile
  is fresh, 2-3 s.
- Member completion lists the compiler-generated `_init` first.
- `djs.ldc2Line` accepts ldmd2's spellings, `-version=X` among them, which ldc2 itself refuses.
