# Changelog

## 0.1.0 (preview)

The first release, on djs 0.1.0 (the LDC 1.43.0 frontend, DMD 2.113, in TypeScript).

- Diagnostics on save and after a pause in typing, from the unsaved text of the open D files.
- Hover with the lowerings resolved, go to definition, completion after a dot.
- Semantic highlighting, inlay hints (inferred types, parameter names, template instance counts), inactive branches
  dimmed.
- Expansion peeks and code lenses, the AST view, the D Instances and D Imports explorers.
- Targets: the host (arm64 macOS, aarch64 or x86_64 Linux), `aarch64-linux-gnu`, `x86_64-linux-gnu`, arm64 macOS
  triples; LDC 1.43.0's import tree bundled.
