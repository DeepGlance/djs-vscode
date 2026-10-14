# Changelog

## 0.1.0 (preview) — LDC 1.43.0 baseline

The frontend of LDC 1.43.0 in TypeScript: lexer, parser, semantic analysis, CTFE, ImportC, Ddoc, the JSON output
and `-vcg-ast`, with ldmd2's command line and diagnostics byte for byte on LDC's DMD test suite and on the bundled
import tree. Targets: the host, `aarch64-linux-gnu`, `x86_64-linux-gnu`. In-process API: `djsMain`, the kept-module
engine `djsMainKept`, and the AST queries an editor uses. The DMD-style inline assembler on x86_64 is kept
unanalysed, with a warning.
