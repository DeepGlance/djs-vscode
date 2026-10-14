// Ported from dmd/imphint.d (module dmd.imphint).
//
// Give import hints for common symbol names that couldn't be resolved.
// For example, prompt to `import std.stdio` when using `writeln`.
//
// This is a small static lookup table + lookup. Two tables:
//   - `hints`   : D symbol name -> the std/core module to import.
//   - `cHints`  : C symbol name -> the <header.h> to #include (ImportC path).
// Both are built once at module-construction time (D `shared static this()`), ported to the
// `initImphint()` init function per 01-conventions.md §5.1 (this very module is that doc's worked
// example). The CLI shim calls `initImphint()` once, in import-graph order, before lexing.
//
// TYPE MODEL (02-types.md §1.3/§9, 08-runtime-lib.md §0 invariant 2): D `string` / `const(char)[]`
// is a UTF-8 BYTE array (`DString`), NOT a JS string. So:
//   - the lookup KEY (`importHint`'s `const(char)[] s`) is a `DString`;
//   - the table VALUES (the module/header names) are `DString` (returned AS `const(char)[]`);
//   - `importHint` returns `DString | null` — `null` reproduces D's null-slice "not found" return
//     (verified with ldc2: a found key yields the value slice, an absent key yields `null`).
//
// BYTE-KEYED MAP (08-runtime-lib.md §5, mirrors entity.ts/stringtable.ts): a D `string[string]` AA
// compares keys by bytes (`memcmp`), but a JS `Map<DString, …>` keys by Uint8Array REFERENCE
// identity — a fresh lookup `DString` would never match a stored one. So the backing maps are keyed
// by `keyOf(bytes)`, an injective Latin-1 encoding of the key bytes (one byte -> one BMP code unit),
// exactly as `dmd/root/stringtable.ts` does. D `s in hints` -> `map.has(keyOf(s))`; D `*entry` ->
// `map.get(keyOf(s))!`. All keys/values here are ASCII, so `ds(...)` (one byte per char code) is the
// correct DString builder for the literals.

import { ds } from "../dstring.js";
import type { DString } from "../dstring.js";

/**
 * Injective Latin-1 key for a byte slice: `keyOf(a) === keyOf(b)` IFF `a` and `b` have identical
 * length AND bytes — exactly D's `memcmp`-based AA key comparison (08-runtime-lib.md §5). Each byte
 * (0..255) maps to one BMP code unit via `String.fromCharCode`, so distinct byte sequences never
 * collide. Keys here are short ASCII identifiers, so the simple per-char loop is fine. Cost: O(len).
 */
function keyOf(str: DString): string {
    let s = "";
    for (let i = 0; i < str.length; i++) s += String.fromCharCode(str[i]);
    return s;
}

/******************************************
 * Looks for undefined identifier s to see
 * if it might be undefined because an import
 * was not specified.
 * Not meant to be a comprehensive list of names in each module,
 * just the most common ones.
 *
 * Returns the module name to import (a `DString`), or `null` if `s` is not a known hint.
 * Precondition: `initImphint()` has run (the shim calls it once at startup). Reading `hints` before
 * init is a contract violation surfaced loudly as a TS error (`hints` is undefined) rather than a
 * silent empty lookup.
 */
export function importHint(s: DString): DString | null {
    // D `if (auto entry = s in hints) return *entry; return null;` — values are always present
    // DStrings, so `?? null` faithfully renders the not-found null-slice return.
    return hints.get(keyOf(s)) ?? null;
}

/**
 * Like `importHint`, but for C symbol names -> the `<header.h>` to `#include` (the ImportC path).
 * Returns the header-name `DString`, or `null` if `s` is not a known C hint. Same precondition and
 * byte-keying as `importHint`.
 */
export function cIncludeHint(s: DString): DString | null {
    return cHints.get(keyOf(s)) ?? null;
}

// D `private immutable string[string] hints;` / `cHints;` — module-private tables, declared but NOT
// initialized at load (01-conventions.md §4.5/§5.1): the `Map`s are built in `initImphint()`. They
// are byte-keyed via `keyOf` (key: Latin-1 string), values are `DString` module/header names.
let hints: Map<string, DString>;
let cHints: Map<string, DString>;

/**
 * ported: D `shared static this()` -> init function (01-conventions.md §5.1).
 * Builds both lookup tables. Idempotent: rebuilds from scratch on every call (crash-only-recovery).
 * No cross-module state is touched, so `initImphint()` has no init-order dependency on other modules.
 */
export function initImphint(): void {
    // in alphabetic order
    hints = mapOf([
        ["AliasSeq", "std.meta"],
        ["appender", "std.array"],
        ["array", "std.array"],
        ["calloc", "core.stdc.stdlib"],
        ["chdir", "std.file"],
        ["cos", "std.math"],
        ["dirEntries", "std.file"],
        ["drop", "std.range"],
        ["each", "std.algorithm"],
        ["empty", "std.range"],
        ["endsWith", "std.algorithm"],
        ["enforce", "std.exception"],
        ["enumerate", "std.range"],
        ["equal", "std.algorithm"],
        ["exists", "std.file"],
        ["fabs", "std.math"],
        ["filter", "std.algorithm"],
        ["format", "std.format"],
        ["free", "core.stdc.stdlib"],
        ["front", "std.range"],
        ["iota", "std.range"],
        ["isDir", "std.file"],
        ["isFile", "std.file"],
        ["join", "std.array"],
        ["joiner", "std.algorithm"],
        ["malloc", "core.stdc.stdlib"],
        ["map", "std.algorithm"],
        ["max", "std.algorithm"],
        ["min", "std.algorithm"],
        ["mkdir", "std.file"],
        ["popFront", "std.range"],
        ["printf", "core.stdc.stdio"],
        ["realloc", "core.stdc.stdlib"],
        ["replace", "std.array"],
        ["rmdir", "std.file"],
        ["sin", "std.math"],
        ["sort", "std.algorithm"],
        ["split", "std.array"],
        ["sqrt", "std.math"],
        ["startsWith", "std.algorithm"],
        ["take", "std.range"],
        ["text", "std.conv"],
        ["to", "std.conv"],
        ["writefln", "std.stdio"],
        ["writeln", "std.stdio"],
        ["__va_argsave_t", "core.stdc.stdarg"],
        ["__va_list_tag", "core.stdc.stdarg"],
        ["InterpolationHeader", "core.interpolation"],
        ["InterpolationFooter", "core.interpolation"],
    ]);
    cHints = mapOf([
        ["va_list", "<stdarg.h>"],

        ["bool", "<stdbool.h>"],
        ["false", "<stdbool.h>"],
        ["true", "<stdbool.h>"],

        ["NULL", "<stddef.h>"],
        ["nullptr_t", "<stddef.h>"],
        ["offsetof", "<stddef.h>"],
        ["ptrdiff_t", "<stddef.h>"],
        ["size_t", "<stddef.h>"],
        ["wchar_t", "<stddef.h>"],

        ["INT8_MAX", "<stdint.h>"],
        ["INT16_MAX", "<stdint.h>"],
        ["INT32_MAX", "<stdint.h>"],
        ["INT64_MAX", "<stdint.h>"],
        ["INTPTR_MAX", "<stdint.h>"],
        ["PTRDIFF_MAX", "<stdint.h>"],
        ["PTRDIFF_MIN", "<stdint.h>"],
        ["SIZE_MAX", "<stdint.h>"],
        ["UINT8_MAX", "<stdint.h>"],
        ["UINT16_MAX", "<stdint.h>"],
        ["UINT32_MAX", "<stdint.h>"],
        ["UINT64_MAX", "<stdint.h>"],
        ["UINTPTR_MAX", "<stdint.h>"],
        ["WINT_MAX", "<stdint.h>"],
        ["WINT_MIN", "<stdint.h>"],
        ["int8_t", "<stdint.h>"],
        ["int16_t", "<stdint.h>"],
        ["int32_t", "<stdint.h>"],
        ["int64_t", "<stdint.h>"],
        ["intptr_t", "<stdint.h>"],
        ["uint8_t", "<stdint.h>"],
        ["uint16_t", "<stdint.h>"],
        ["uint32_t", "<stdint.h>"],
        ["uint64_t", "<stdint.h>"],
        ["uintptr_t", "<stdint.h>"],

        ["EOF", "<stdio.h>"],
        ["FILE", "<stdio.h>"],
        ["fopen", "<stdio.h>"],
        ["fpos_t", "<stdio.h>"],
        ["fprintf", "<stdio.h>"],
        ["getchar", "<stdio.h>"],
        ["printf", "<stdio.h>"],
        ["snprintf", "<stdio.h>"],
        ["sprintf", "<stdio.h>"],
        ["stderr", "<stdio.h>"],
        ["stdin", "<stdio.h>"],
        ["stdout", "<stdio.h>"],

        ["EXIT_FAILURE", "<stdlib.h>"],
        ["EXIT_SUCCESS", "<stdlib.h>"],
        ["abort", "<stdlib.h>"],
        ["atexit", "<stdlib.h>"],
        ["calloc", "<stdlib.h>"],
        ["exit", "<stdlib.h>"],
        ["free", "<stdlib.h>"],
        ["getenv", "<stdlib.h>"],
        ["malloc", "<stdlib.h>"],
        ["realloc", "<stdlib.h>"],

        ["memchr", "<string.h>"],
        ["memcmp", "<string.h>"],
        ["memcpy", "<string.h>"],
        ["memmove", "<string.h>"],
        ["memset", "<string.h>"],
        ["strcat", "<string.h>"],
        ["strchr", "<string.h>"],
        ["strcmp", "<string.h>"],
        ["strcpy", "<string.h>"],
        ["strerror", "<string.h>"],
        ["strlen", "<string.h>"],
        ["strncat", "<string.h>"],
        ["strncmp", "<string.h>"],
        ["strncpy", "<string.h>"],
        ["strrchr", "<string.h>"],
        ["strspn", "<string.h>"],
        ["strstr", "<string.h>"],

        ["WCHAR_MAX", "<wchar.h>"],
        ["WCHAR_MIN", "<wchar.h>"],
    ]);
}

/**
 * Build a byte-keyed `Map` from `[name, value]` JS-string-literal pairs: the name is `keyOf(ds(name))`
 * (the Latin-1 key for the name's bytes), the value is `ds(value)` (the value's bytes as a `DString`).
 * This is the one place the D `["k": "v", …]` AA literal is constructed; both sides are ASCII here.
 */
function mapOf(pairs: readonly (readonly [string, string])[]): Map<string, DString> {
    const m = new Map<string, DString>();
    for (const [name, value] of pairs) m.set(keyOf(ds(name)), ds(value));
    return m;
}
