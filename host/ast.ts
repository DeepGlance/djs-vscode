// The AST view's entries in the form they travel from the worker and are kept in by the extension, the two lookups
// the view's navigation makes on them, and the anchors that keep a place in the view across a reprint. No VS Code
// dependency, no compiler: the worker packs (host/worker.ts), the extension and the host tests look up.
//
// WHY packed: labserver.d's AST under -i has ~65,000 entries. As objects (each with nested ranges and a file string)
// their structured clone from the worker took ~0.8 s even when djs answered from its kept print in 0.1 ms, and they
// would sit in the extension host as ~65,000 small objects per open view. Packed, they are one Int32Array of
// `ENTRY_INTS` numbers per entry and one of file indexes into a short table: a clone of a few MB of buffers.
// The entries' `kind` and `name` are not carried: nothing in the view reads them.

import { resolve } from "node:path";
import type { PackedAst, Position, Range } from "./protocol.js";

/** The numbers per entry in `PackedAst.ranges`: the print's range, the source's identifier range, the extent. */
export const ENTRY_INTS = 12;

/** What `packAst` reads of one of djs's `AstEntry`. */
interface EntryShape {
    ast: Range;
    source: { file: string; range: Range } | null;
    extent: Range | null;
}

/**
 * Packs djs's AST entries (sorted by `ast.start`, a container before what it holds; the order is kept): entry `i` is
 * `ranges[i * ENTRY_INTS ...]`, the `ast` range's start line and character and end line and character, then the
 * source's identifier range and the extent the same way, -1 in all four numbers of a missing one; `files[i]` indexes
 * `fileNames`, -1 when the entry has no source. The file names are resolved (`path.resolve`): djs names druntime's
 * files as the configuration's import path does (`.../bin/../import/object.d`). Cost: one pass, ~100 bytes per entry.
 */
export function packAst(entries: readonly EntryShape[]): PackedAst {
    const ranges = new Int32Array(entries.length * ENTRY_INTS);
    const files = new Int32Array(entries.length);
    const fileNames: string[] = [];
    const fileIndex = new Map<string, number>();
    const put = (at: number, r: Range | null): void => {
        if (r === null)
            ranges.fill(-1, at, at + 4);
        else
            ranges.set([r.start.line, r.start.character, r.end.line, r.end.character], at);
    };
    entries.forEach((e, i) => {
        const at = i * ENTRY_INTS;
        put(at, e.ast);
        put(at + 4, e.source?.range ?? null);
        put(at + 8, e.extent);
        if (e.source === null) {
            files[i] = -1;
            return;
        }
        let f = fileIndex.get(e.source.file);
        if (f === undefined) {
            f = fileNames.length;
            fileNames.push(resolve(e.source.file));
            fileIndex.set(e.source.file, f);
        }
        files[i] = f;
    });
    return { count: entries.length, ranges, files, fileNames };
}

/** -1, 0, 1 as (line, character) at `ranges[at]` comes before, at, after `p`. */
function compareAt(ranges: Int32Array, at: number, p: Position): number {
    return ranges[at]! - p.line || ranges[at + 1]! - p.character;
}

function rangeAt(ranges: Int32Array, at: number): Range {
    return { start: { line: ranges[at]!, character: ranges[at + 1]! },
        end: { line: ranges[at + 2]!, character: ranges[at + 3]! } };
}

/** The index of the innermost entry with a source whose print holds `p`, -1 when none (see `astSourceAt`). */
function innermostAt(packed: PackedAst, p: Position): number {
    const { ranges, files } = packed;
    let lo = 0;
    let hi = packed.count;   // the first entry starting after p
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (compareAt(ranges, mid * ENTRY_INTS, p) <= 0)
            lo = mid + 1;
        else
            hi = mid;
    }
    for (let i = lo - 1; i >= 0; i--) {
        if (files[i] !== -1 && compareAt(ranges, i * ENTRY_INTS + 2, p) > 0)
            return i;
    }
    return -1;
}

/**
 * The source of the innermost entry printed around `p` (a position in the AST text) that has one: the declaring file
 * (resolved) and the identifier's range there; null when no such entry holds `p`. The entries are sorted by start with
 * containers first, so the innermost holding `p` is the latest-starting one: a binary search finds the last entry
 * starting at or before `p`, then a walk back stops at the first one whose print is still open at `p`. Cost: a binary
 * search plus the entries between `p` and its innermost container (labserver.d: under 0.1 ms; ~3 ms when no entry
 * holds `p` and the walk goes back to the first).
 */
export function astSourceAt(packed: PackedAst, p: Position): { file: string; range: Range } | null {
    const i = innermostAt(packed, p);
    if (i < 0)
        return null;
    return { file: packed.fileNames[packed.files[i]!]!, range: rangeAt(packed.ranges, i * ENTRY_INTS + 4) };
}

/**
 * The print (its range in the AST text) of the entry of `file` for a cursor at `p` in that file: the innermost entry
 * whose extent holds `p` (the latest-starting; its end counts, so that a cursor right after a closing brace is still
 * in), else the last entry starting at or before `p`, a start being the extent's or, without one, the identifier's;
 * an entry whose identifier range is empty (a compiler-made `RTInfo!(S)`, the implicit `import object`) is not taken
 * there. Of entries starting at the same place the first wins: a template's own print comes before its instances',
 * so a cursor in a template, a function template or a member of an aggregate template reveals the template's print,
 * not an instance's. Null when the file has no entry starting there. Only functions have an extent. `file` and the
 * entries' files are compared resolved. Cost: one pass over the entries (labserver.d's ~65,000: ~2 ms).
 */
export function astPrintFor(packed: PackedAst, file: string, p: Position): Range | null {
    const f = packed.fileNames.indexOf(resolve(file));
    if (f < 0)
        return null;
    const { ranges, files } = packed;
    // a start of an entry at `at`: the extent's, else the identifier's
    const startOf = (at: number): number => (ranges[at + 8] !== -1 ? at + 8 : at + 4);
    const after = (a: number, b: number): boolean => (ranges[a]! - ranges[b]! || ranges[a + 1]! - ranges[b + 1]!) > 0;
    let inside = -1;
    let last = -1;
    for (let i = 0; i < packed.count; i++) {
        if (files[i] !== f)
            continue;
        const at = i * ENTRY_INTS;
        const start = startOf(at);
        if (compareAt(ranges, start, p) > 0)
            continue;
        if (start === at + 8) {
            if (compareAt(ranges, at + 10, p) >= 0 && (inside < 0 || after(start, inside + 8)))
                inside = at;
        } else if (ranges[at + 4] === ranges[at + 6] && ranges[at + 5] === ranges[at + 7]) {
            continue;   // an empty identifier range: made by the compiler
        }
        if (last < 0 || after(start, startOf(last)))
            last = at;
    }
    const hit = inside >= 0 ? inside : last;
    return hit < 0 ? null : rangeAt(ranges, hit);
}

/**
 * A place in an AST view tied to the declaration printed around it, so that it can be found again in another print of
 * the same module (the view after a recompile, which VS Code replaces whole): the declaration's file (resolved), the
 * first line of its print (from the print's start: `T twice()`, `struct S`), its rank among the entries with that same
 * file and first line, and the place's offset from the start of its print, in lines, and its character. Neither the
 * declaration's position in the source nor its index among the entries survives an edit above it; its print does.
 */
export interface AstAnchor {
    file: string;
    head: string;
    rank: number;
    lines: number;
    character: number;
}

/** The first line of the print of the entry at `at`, from its start, without trailing blanks. */
function headOf(ranges: Int32Array, at: number, lineOf: (line: number) => string): string {
    return lineOf(ranges[at]!).slice(ranges[at + 1]!).trimEnd();
}

/**
 * The anchor of `p` in the AST whose entries are `packed` and whose lines `lineOf` gives (from 0, the entries'
 * numbering): its innermost entry with a source; null when none. Cost: one pass over the entries of that file
 * before it, reading the first line of each.
 */
export function astAnchorAt(packed: PackedAst, p: Position, lineOf: (line: number) => string): AstAnchor | null {
    const i = innermostAt(packed, p);
    if (i < 0)
        return null;
    const { ranges, files } = packed;
    const at = i * ENTRY_INTS;
    const head = headOf(ranges, at, lineOf);
    let rank = 0;
    for (let j = 0; j < i; j++) {
        if (files[j] === files[i] && headOf(ranges, j * ENTRY_INTS, lineOf) === head)
            rank++;
    }
    return { file: packed.fileNames[files[i]!]!, head, rank, lines: p.line - ranges[at]!, character: p.character };
}

/**
 * Where `anchor` (from another print of the module) is in the AST whose entries are `packed` and whose lines `lineOf`
 * gives: the same declaration's print start moved by the anchor's offset, not past the print's last line; null when
 * the declaration is gone. Cost: one pass over the entries of that file, reading the first line of each.
 */
export function astAnchorPosition(packed: PackedAst, anchor: AstAnchor, lineOf: (line: number) => string)
    : Position | null {
    const f = packed.fileNames.indexOf(anchor.file);
    if (f < 0)
        return null;
    const { ranges, files } = packed;
    let rank = anchor.rank;
    for (let i = 0; i < packed.count; i++) {
        const at = i * ENTRY_INTS;
        if (files[i] !== f || headOf(ranges, at, lineOf) !== anchor.head || rank-- > 0)
            continue;
        const line = Math.min(ranges[at]! + anchor.lines, ranges[at + 2]!);
        const character = line === ranges[at]! ? Math.max(ranges[at + 1]!, anchor.character) : anchor.character;
        return { line, character };
    }
    return null;
}
