/**
 * Text macro processor for Ddoc.
 *
 * Copyright:   Copyright (C) 1999-2025 by The D Language Foundation, All Rights Reserved
 * License:     $(LINK2 https://www.boost.org/LICENSE_1_0.txt, Boost License 1.0)
 * Source:      $(LINK2 https://github.com/dlang/dmd/blob/master/compiler/src/dmd/dmacro.d, _dmacro.d)
 * Documentation:  https://dlang.org/phobos/dmd_dmacro.html
 *
 * Port of dmd/dmacro.d (Ddoc macro expansion). The macro EXPANSION logic (`MacroTable.expand`)
 * is called from doc.ts (`gendocfile`, doc.d:137), and the `MacroTable` TYPE is a field of the
 * `Module` AST node (`dmodule.d:410 MacroTable macrotable;`). A faithful 1:1 translation of the
 * whole module.
 *
 * GOVERNING TRANSLATIONS / RESOLUTIONS (per docs/porting):
 *   - `core.stdc.ctype` (`isdigit`/`isspace`/`isalpha`) → local C-locale byte predicates below.
 *   - `core.stdc.string` (`memcmp`/`memcpy`/`memdup`) → byte-slice operations over `DString`.
 *   - `mem.xmalloc`/`mem.xfree`/`memdup` (rmem) → JS GC: a COPY is `slice()`, a free is dropped
 *     (08 §13). The DDOC_UNDEFINED_MACRO `xmalloc(namelen+1+marg.length)` concat becomes a fresh
 *     `Uint8Array` filled with `name`, `','`, `marg`.
 *   - The macro table `Macro*[const(char)[]]` is a STRING-SLICE-keyed AA (byte content, like
 *     `StringTable` §5) → `Map<string, Macro>` keyed by a Latin-1 `keyOf(bytes)` (one byte → one
 *     BMP code unit, injective over byte sequences). NOT object identity (that is `aav` §6).
 *   - `Macro` is a `struct` but always held as `Macro*` (heap `new Macro`, mutated in place via
 *     `m.inuse++` / `(*table).text = text`) → `class Macro` (reference, cheatsheet `Struct*` =
 *     class ref). No `.copy()` discipline.
 *   - `const(char)[]` / `string` / `ubyte[]` → `DString` (Uint8Array). A SLICE into a buffer is a
 *     `subarray` (shared view); `memdup` is `slice()` (independent copy).
 *   - `out const(char)[] marg` → a `Ref<DString>` box, reset on entry (03 §3.3).
 *   - `OutBuffer` is passed by `ref` → the class ref (no copy). `buf[].ptr` re-read each loop
 *     iteration ("buf.data is not loop invariant") → re-call `buf.opSliceAll()` at the top of each
 *     iteration; writes through the returned shared view mutate the backing store.
 *   - resolved: version(none) printf-debug blocks (dmacro.d:50-54) → dropped (always OFF, _config).
 *   - `assert(...)` expressions → `assert` helper (10 §2).
 */

import { assert } from "../assert.js";
import type { OutBuffer } from "./common/outbuffer.js";
import type { DString } from "../dstring.js";

// ---- C-locale `core.stdc.ctype` predicates on a byte (matches lexer.ts / charactertables) ----

/// C `isdigit`: ASCII '0'..'9'.
function isdigit(c: number): boolean {
    return c >= 0x30 && c <= 0x39;
}

/// C `isspace`: space, and the standard whitespace controls (\t \n \v \f \r).
function isspace(c: number): boolean {
    return c === 0x20 || (c >= 0x09 && c <= 0x0d);
}

/// C `isalpha`: ASCII letters (C locale). Bytes >= 0x80 are not alphabetic.
function isalpha(c: number): boolean {
    return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

// `out` / `ref` single-slot box (03 §3.3 / §7). One mutable cell the callee writes back.
interface Ref<T> {
    value: T;
}

/**
 * `keyOf` — injective Latin-1 encoding of a byte slice (same scheme as `StringTable`, 08 §5).
 * `keyOf(a) === keyOf(b)` IFF `a` and `b` have identical length AND bytes — exactly the D AA's
 * `memcmp`-keyed lookup (the AA key type is `const(char)[]`, compared by bytes). Each byte
 * (0..255) maps to one BMP code unit, so the string is a faithful 1:1 of the bytes. Do NOT
 * UTF-8-decode (two byte sequences could collide).
 */
function keyOf(str: DString): string {
    let s = "";
    for (let i = 0; i < str.length; i++) s += String.fromCharCode(str[i]);
    return s;
}

/**
 * `fp_t` — the predicate type `bool function(const(char)* p)` (dmacro.d:39). In D the callback
 * receives a `const(char)*` cursor into the buffer; in the port the cursor is the buffer view
 * plus an index, so the predicate takes `(buf, p)`. The callers (`isIdStart`/`isIdTail`,
 * doc.ts's ports of doc.d:5228/:5250) inspect the byte(s) at the cursor and may look ahead.
 */
export type fp_t = (buf: DString, p: number) => boolean;

/**
 * The Ddoc macro table — `name=text` definitions plus the in-place expansion engine.
 *
 * D's `MacroTable` is a `struct` (value type) but is always held by `ref`/pointer
 * (`MacroTable macrotable;` field of `Module`, `expand(ref MacroTable, ...)`); it is never copied
 * by value. So it is ported as a `class` (reference) — no `.copy()` discipline to apply
 * (cheatsheet `Struct*` used as alias = class ref). Carries no `opAssign`/`this(this)`.
 */
export class MacroTable {
    /**
     * Define `name`=`text`. If macro `name` already exists, replace its text (dmacro.d:28).
     *
     * Preconditions: none (any byte content). Postconditions: after return, `search(name)` finds
     * a `Macro` whose `text` is `text`. Idempotent on `name` (re-define replaces text in place).
     */
    define(name: DString, text: DString): void {
        // if (auto table = name in mactab) { (*table).text = text; return; }
        const key = keyOf(name);
        const table = this.mactab.get(key);
        if (table) {
            table.text = text;
            return;
        }
        this.mactab.set(key, new Macro(name, text));
    }

    /**
     * Look for macros in `buf` and expand them in place (dmacro.d:47). Only the text from `start`
     * to `pend.value` is examined; `pend` is updated to the new end after expansion.
     *
     * `arg` is the current macro argument (for `$0`/`$+`/`$1..$9` substitution). `recursionLimit`
     * bounds recursive expansion. `isIdStart`/`isIdTail` classify macro-name characters.
     *
     * Returns `true` on success, `false` when the recursion limit was reached.
     *
     * Cost: rewrites the buffer in place (insert/remove/spread shift bytes). `buf[].ptr` is NOT
     * loop-invariant — the live view is re-fetched (`buf.opSliceAll()`) at the top of each
     * iteration, and byte writes go through that shared view into the backing store.
     */
    expand(buf: OutBuffer, start: number, pend: Ref<number>, arg: DString | null, recursionLimit: number,
        isIdStart: fp_t, isIdTail: fp_t): boolean {
        // resolved: version(none) printf-debug block (dmacro.d:50-54) -> dropped (always OFF).
        // limit recursive expansion
        recursionLimit--;
        if (recursionLimit < 0)
            return false;

        let end = pend.value;
        assert(start <= end);
        assert(end <= buf.length());
        /* First pass - replace $0
         */
        // arg = memdup(arg); — make a private copy. memdup yields a non-null DString (empty if the
        // source was null), so `arg` is non-null for the rest of the body (D's `arg` likewise).
        const argDup: DString = memdup(arg); // mem.xfree'd at the end; under GC the copy is a slice
        for (let u = start; u + 1 < end;) {
            const p = buf.opSliceAll(); // buf.data is not loop invariant
            /* Look for $0, but not $$0, and replace it with arg.
             */
            if (p[u] === 0x24 /* '$' */ && (isdigit(p[u + 1]) || p[u + 1] === 0x2b /* '+' */)) {
                if (u > start && p[u - 1] === 0x24 /* '$' */) {
                    // Don't expand $$0, but replace it with $0
                    buf.remove(u - 1, 1);
                    end--;
                    u += 1; // now u is one past the closing '1'
                    continue;
                }
                const c = p[u + 1]; // char c
                const n = c === 0x2b /* '+' */ ? -1 : c - 0x30 /* '0' */;
                let marg: DString;
                if (n === 0) {
                    marg = argDup;
                } else {
                    const margBox: Ref<DString> = { value: emptySlice() };
                    extractArgN(argDup, margBox, n);
                    marg = margBox.value;
                }
                if (marg.length === 0) {
                    // Just remove macro invocation
                    buf.remove(u, 2);
                    end -= 2;
                } else if (c === 0x2b /* '+' */) {
                    // Replace '$+' with 'arg'
                    buf.remove(u, 2);
                    buf.insert(u, marg);
                    end += marg.length - 2;
                    // Scan replaced text for further expansion
                    const mendBox: Ref<number> = { value: u + marg.length };
                    const success = this.expand(buf, u, mendBox, null, recursionLimit, isIdStart, isIdTail);
                    if (!success)
                        return false;
                    const mend = mendBox.value;
                    end += mend - (u + marg.length);
                    u = mend;
                } else {
                    // Replace '$1' with '\xFF{arg\xFF}'
                    const slice = buf.opSliceAll(); // ubyte[] slice = cast(ubyte[])buf[]
                    slice[u] = 0xff;
                    slice[u + 1] = 0x7b /* '{' */;
                    buf.insert(u + 2, marg);
                    buf.insert(u + 2 + marg.length, FF_CLOSE); // "\xFF}"
                    end += -2 + 2 + marg.length + 2;
                    // Scan replaced text for further expansion
                    const mendBox: Ref<number> = { value: u + 2 + marg.length };
                    const success = this.expand(buf, u + 2, mendBox, null, recursionLimit, isIdStart, isIdTail);
                    if (!success)
                        return false;
                    const mend = mendBox.value;
                    end += mend - (u + 2 + marg.length);
                    u = mend;
                }
                continue;
            }
            u++;
        }
        /* Second pass - replace other macros
         */
        for (let u = start; u + 4 < end;) {
            const p = buf.opSliceAll(); // buf.data is not loop invariant
            /* A valid start of macro expansion is $(c, where c is
             * an id start character, and not $$(c.
             */
            if (p[u] === 0x24 /* '$' */ && p[u + 1] === 0x28 /* '(' */ && isIdStart(p, u + 2)) {
                const nameStart = u + 2; // char* name = p + u + 2
                let namelen = 0;
                let v: number;
                /* Scan forward to find end of macro name and
                 * beginning of macro argument (marg).
                 */
                for (v = u + 2; v < end; v += utfStride(p[v])) {
                    if (!isIdTail(p, v)) {
                        // We've gone past the end of the macro name.
                        namelen = v - (u + 2);
                        break;
                    }
                }
                const margBox: Ref<DString> = { value: emptySlice() };
                v += extractArgN(p.subarray(v, end), margBox, 0);
                let marg = margBox.value;
                assert(v <= end);
                if (v < end) {
                    // v is on the closing ')'
                    if (u > start && p[u - 1] === 0x24 /* '$' */) {
                        // Don't expand $$(NAME), but replace it with $(NAME)
                        buf.remove(u - 1, 1);
                        end--;
                        u = v; // now u is one past the closing ')'
                        continue;
                    }
                    let m = this.search(p.subarray(nameStart, nameStart + namelen));
                    if (!m) {
                        const undef = DDOC_UNDEFINED_MACRO;
                        m = this.search(undef);
                        if (m) {
                            // Macro was not defined, so this is an expansion of
                            //   DDOC_UNDEFINED_MACRO. Prepend macro name to args.
                            // marg = name[ ] ~ "," ~ marg[ ];
                            if (marg.length) {
                                // char* q = mem.xmalloc(namelen + 1 + marg.length); GC: fresh buffer.
                                const q = new Uint8Array(namelen + 1 + marg.length);
                                q.set(p.subarray(nameStart, nameStart + namelen), 0); // memcpy(q, name, namelen)
                                q[namelen] = 0x2c /* ',' */;
                                q.set(marg, namelen + 1); // memcpy(q + namelen + 1, marg.ptr, marg.length)
                                marg = q.subarray(0, marg.length + namelen + 1);
                            } else {
                                marg = p.subarray(nameStart, nameStart + namelen);
                            }
                        }
                    }
                    if (m) {
                        if (m.inuse && marg.length === 0) {
                            // Remove macro invocation
                            buf.remove(u, v + 1 - u);
                            end -= v + 1 - u;
                        } else if (m.inuse && ((argDup.length === marg.length && memcmp(argDup, marg, argDup.length) === 0) ||
                            (argDup.length + 4 === marg.length && marg[0] === 0xff && marg[1] === 0x7b /* '{' */ &&
                                memcmp(argDup, marg.subarray(2), argDup.length) === 0 &&
                                marg[marg.length - 2] === 0xff && marg[marg.length - 1] === 0x7d /* '}' */))) {
                            /* Recursive expansion:
                             *   marg is same as arg (with blue paint added)
                             * Just leave in place.
                             */
                        } else {
                            marg = memdup(marg); // independent copy (D: marg = memdup(marg))
                            // Insert replacement text
                            buf.spread(v + 1, 2 + m.text.length + 2);
                            const slice = buf.opSliceAll(); // ubyte[] slice = cast(ubyte[])buf[]
                            slice[v + 1] = 0xff;
                            slice[v + 2] = 0x7b /* '{' */;
                            slice.set(m.text, v + 3); // slice[v+3 .. v+3+m.text.length] = m.text[]
                            slice[v + 3 + m.text.length] = 0xff;
                            slice[v + 3 + m.text.length + 1] = 0x7d /* '}' */;
                            end += 2 + m.text.length + 2;
                            // Scan replaced text for further expansion
                            m.inuse++;
                            const mendBox: Ref<number> = { value: v + 1 + 2 + m.text.length + 2 };
                            const success = this.expand(buf, v + 1, mendBox, marg, recursionLimit, isIdStart, isIdTail);
                            if (!success)
                                return false;
                            const mend = mendBox.value;
                            end += mend - (v + 1 + 2 + m.text.length + 2);
                            m.inuse--;
                            buf.remove(u, v + 1 - u);
                            end -= v + 1 - u;
                            u += mend - (v + 1);
                            // mem.xfree(marg) — dropped (GC).
                            continue;
                        }
                    } else {
                        // Replace $(NAME) with nothing
                        buf.remove(u, v + 1 - u);
                        end -= v + 1 - u;
                        continue;
                    }
                }
            }
            u++;
        }
        // mem.xfree(arg) — dropped (GC).
        pend.value = end;
        return true;
    }

    // private:

    // search() (dmacro.d:265). D declares it `private`, but `private` in D is MODULE-private — the
    // co-located unittest path / sibling functions may touch it. The frontend's only callers are
    // `expand`/`define`; kept non-`private` so a module-level test could exercise it (01 / 10).
    search(name: DString): Macro | null {
        // if (auto table = name in mactab) return *table;
        return this.mactab.get(keyOf(name)) ?? null;
    }

    // private Macro*[const(char)[]] mactab;  — string-slice-keyed AA → byte-content-keyed Map.
    private mactab = new Map<string, Macro>();
}

/* ************************************************************************ */

// private:

/**
 * A single `name`=`text` macro definition (dmacro.d:283).
 *
 * D's `Macro` is a `struct`, but the table holds `Macro*` (heap `new Macro`) and mutates fields in
 * place (`inuse++`, `text = ...`), so it is ported as a `class` (reference) — no `.copy()`.
 */
class Macro {
    name: DString; // macro name
    text: DString; // macro replacement text
    inuse = 0; // macro is in use (don't expand)

    constructor(name: DString, text: DString) {
        this.name = name;
        this.text = text;
    }
}

/** `immutable undef = "DDOC_UNDEFINED_MACRO"` (dmacro.d:179) — the fallback-macro name. */
const DDOC_UNDEFINED_MACRO: DString = Uint8Array.from(
    [0x44, 0x44, 0x4f, 0x43, 0x5f, 0x55, 0x4e, 0x44, 0x45, 0x46, 0x49, 0x4e, 0x45, 0x44, 0x5f,
        0x4d, 0x41, 0x43, 0x52, 0x4f], // "DDOC_UNDEFINED_MACRO"
);

/** The 2-byte "\xFF}" close-paint inserted after a `$1` argument (dmacro.d:120). */
const FF_CLOSE: DString = Uint8Array.from([0xff, 0x7d /* '}' */]);

/** A fresh empty byte slice — the `out`-param reset value before `extractArgN` fills it. */
function emptySlice(): DString {
    return new Uint8Array(0);
}

/**
 * `memdup` — make a mutable COPY of slice `p` (dmacro.d:304). D allocates with `mem.xmalloc`;
 * under GC this is just `slice()` (an independent buffer). Preserves the D null-guard:
 * `memdup(null)` would `memcpy(xmalloc(0), null, 0)` → an empty non-null slice in D; here a null
 * source yields an empty slice (the only caller passes `arg`, which `expand` may receive as null,
 * and an empty `arg` behaves identically to D's empty-slice memdup).
 */
function memdup(p: DString | null): DString {
    return p ? p.slice() : new Uint8Array(0);
}

/**
 * `memcmp` — C byte compare of the first `n` bytes of `a` and `b` (core.stdc.string). Returns
 * <0/0/>0 like C. Used only for equality tests here (`=== 0`).
 */
function memcmp(a: DString, b: DString, n: number): number {
    for (let i = 0; i < n; i++) {
        const d = a[i] - b[i];
        if (d !== 0) return d;
    }
    return 0;
}

/**
 * Given buffer `buf`, extract argument `marg` (dmacro.d:319).
 *
 * `marg` is set (an `out` param → `Ref<DString>`, reset on entry) to a slice (view) of `buf`.
 *   n =  0: get entire argument
 *        1..9: get nth argument
 *        -1: get 2nd through end
 *
 * Returns the index `v` at which scanning stopped (on the matching ')' or end). Scans forward for
 * the matching right parenthesis, nesting parens, skipping over "..."/'...' strings inside HTML
 * tags, <!-- ... --> comments, and previous macro insertions (`\xFF{ ... \xFF}`).
 */
function extractArgN(buf: DString, marg: Ref<DString>, n: number): number {
    marg.value = emptySlice(); // `out` reset on entry (D inits to .init)
    let parens = 1;
    let instring = 0; // ubyte instring (holds the quote char, or 0)
    let incomment = 0;
    let intag = 0;
    let inexp = 0;
    let argn = 0;
    let v = 0;
    const p = buf;
    const end = buf.length;
    let vstart = 0;
    // `Largstart:` is a back-jump target re-run on argument boundaries (goto Largstart); model it
    // with an outer restart loop (06 §4: goto loop-back → labeled while + continue).
    argRestart: while (true) {
        // Skip first space, if any, to find the start of the macro argument
        if (n !== 1 && v < end && isspace(p[v]))
            v++;
        vstart = v;
        // The inner `for` exits (D `break;` after the switch) on a matched ')' or n-th ','; cases
        // that `continue` advance, and a case-internal `break` means "leave switch then hit the
        // post-switch break" — i.e. exit the for (verified vs ldc2: nothing sits between the switch
        // and the post-switch `break`). So every such break becomes `break Loop;`.
        Loop: for (; v < end; v++) {
            const c = p[v]; // char c
            switch (c) {
                case 0x2c /* ',' */:
                    if (!inexp && !instring && !incomment && parens === 1) {
                        argn++;
                        if (argn === 1 && n === -1) {
                            v++;
                            continue argRestart; // goto Largstart
                        }
                        if (argn === n)
                            break Loop;
                        if (argn + 1 === n) {
                            v++;
                            continue argRestart; // goto Largstart
                        }
                    }
                    continue Loop;
                case 0x28 /* '(' */:
                    if (!inexp && !instring && !incomment)
                        parens++;
                    continue Loop;
                case 0x29 /* ')' */:
                    if (!inexp && !instring && !incomment && --parens === 0) {
                        break Loop;
                    }
                    continue Loop;
                case 0x22 /* '"' */:
                case 0x27 /* '\'' */:
                    if (!inexp && !incomment && intag) {
                        if (c === instring)
                            instring = 0;
                        else if (!instring)
                            instring = c;
                    }
                    continue Loop;
                case 0x3c /* '<' */:
                    if (!inexp && !instring && !incomment) {
                        if (v + 6 < end && p[v + 1] === 0x21 /* '!' */ && p[v + 2] === 0x2d /* '-' */ &&
                            p[v + 3] === 0x2d /* '-' */) {
                            incomment = 1;
                            v += 3;
                        } else if (v + 2 < end && isalpha(p[v + 1]))
                            intag = 1;
                    }
                    continue Loop;
                case 0x3e /* '>' */:
                    if (!inexp)
                        intag = 0;
                    continue Loop;
                case 0x2d /* '-' */:
                    if (!inexp && !instring && incomment && v + 2 < end && p[v + 1] === 0x2d /* '-' */ &&
                        p[v + 2] === 0x3e /* '>' */) {
                        incomment = 0;
                        v += 2;
                    }
                    continue Loop;
                case 0xff:
                    if (v + 1 < end) {
                        if (p[v + 1] === 0x7b /* '{' */)
                            inexp++;
                        else if (p[v + 1] === 0x7d /* '}' */)
                            inexp--;
                    }
                    continue Loop;
                default:
                    continue Loop;
            }
        }
        // Reached when the inner `for` exits (a `break Loop` or `v >= end`).
        break argRestart;
    }
    if (argn === 0 && n === -1)
        marg.value = p.subarray(v, v);
    else
        marg.value = p.subarray(vstart, v);
    return v;
}

/**
 * Get number of UTF-8 code units in the code point that starts with `c` (dmacro.d:437).
 * Returns the number of UTF-8 code units (i.e. bytes), else 1 on an invalid UTF start.
 */
export function utfStride(c: number): number {
    return (
        c < 0x80 ? 1 :
        c < 0xc0 ? 1 : // invalid UTF start
        c < 0xe0 ? 2 :
        c < 0xf0 ? 3 :
        c < 0xf8 ? 4 :
        c < 0xfc ? 5 :
        c < 0xfe ? 6 :
        1 // invalid UTF start
    );
}
