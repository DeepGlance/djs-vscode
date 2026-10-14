// Ported from dmd/identifier.d (module dmd.identifier).
//
// Defines `Identifier`: the interned name of a `Dsymbol`. Identifiers are INTERNED — every distinct
// name maps to exactly one `Identifier` object via the module-global `StringTable` (`stringtable`),
// so `equals` is reference identity (`this is i`). Keyword and predefined-symbol identifiers carry a
// non-`TOK.identifier` `value` (set by `tokens.d`'s keyword pool and `id.d`'s `Id.initialize`).
//
// CYCLE A (id <-> identifier <-> tokens): `Id` is value-imported (used only inside `toHChars2`, a
// method that runs post-load — safe per 01 §4.3); `TOK` is value-imported (used at runtime in
// `idPool`/the ctor). Nothing is read/constructed at this module's top level across the cycle.

import { Id } from "./id.js"; // value import (used in toHChars2; runs post-load — 01 §4.3)
import type { Loc } from "./location.js";
import { SourceLoc } from "./location.js";
import { OutBuffer } from "./common/outbuffer.js";
import { RootObject, DYNCAST } from "./rootobject.js";
// import dmd.root.string (identifier.d:21): only the `const(char)*` ctor used `toDString`; those
// pointer-ctor overloads collapse into the slice forms here (a DString carries its length), so the
// file references no symbol from root/string -> the import is DROPPED (01 strict-mode imports).
import { StringTable } from "./root/stringtable.js";
import { utf_decodeChar } from "./root/utf.js";
import { isidchar, isAnyStart, isAnyContinue } from "./common/charactertables.js";
import { TOK } from "./tokens.js";
import { ds, dsConcat } from "../dstring.js";
import type { DString } from "../dstring.js";
import { assert } from "../assert.js";
import { K, keepGenerated } from "../keep.js";

/***********************************************************
 * dmd/identifier.d:29 — `extern (C++) final class Identifier : RootObject`.
 *
 * REFERENCE type (02 §2): a `class`. Interned, so two `Identifier`s are equal iff they are the same
 * object. `nothrow:` (identifier.d:38) erases (04 §8). The fields are `const` in D (set once in the
 * ctor); kept as `readonly` to carry that contract.
 */
export class Identifier extends RootObject {
    private readonly value: number; // private const int value;  (TOK.xxx or TOK.identifier) -> number

    // Indicates if this is an identifier used for an anonymous symbol (identifier.d:34).
    private readonly isAnonymous_: boolean;

    private readonly name: DString; // private const char[] name;  (the interned key bytes, 08 §11)

    /**
     * The single full constructor (identifier.d:73, `this(const(char)[] name, int value, bool
     * isAnonymous)`). D's several ctors (`const(char)*`, `const(char)* + length + value`,
     * `const(char)[] + value`) are arity/Form-B overloads (04 §1B) -> the static factories below
     * (`create`, the `idPool` paths). This constructor takes the fully-resolved `(name, value,
     * isAnonymous)` triple; callers use the factories.
     *
     * `name` is a `DString` byte-slice (the interned key — typically the StringTable entry's own
     * bytes, which already own their storage).
     */
    constructor(name: DString, value: number, isAnonymous = false) {
        super();
        this.name = name;
        this.value = value;
        this.isAnonymous_ = isAnonymous;
    }

    /** dmd/identifier.d:81 — interned equality is reference identity (`this is i`). */
    equals(i: Identifier | null): boolean {
        return (this as Identifier) === i;
    }

    /** dmd/identifier.d:86 — `static Identifier create(const(char)* name)`. */
    static create(name: DString): Identifier {
        // `new Identifier(name)` (the const(char)* ctor) interns via TOK.identifier (identifier.d:41).
        return new Identifier(name, TOK.identifier);
    }

    /** dmd/identifier.d:91 — `override const(char)* toChars()`. The interned name bytes. */
    override toChars(): DString {
        return this.name;
    }

    /** dmd/identifier.d:96 — `override const(char)[] toString()`. Same bytes (no NUL slice needed). */
    override toString(): DString {
        return this.name;
    }

    /** dmd/identifier.d:101 — `int getValue()`. The TOK/Id value carried by this identifier. */
    getValue(): number {
        return this.value;
    }

    /** dmd/identifier.d:106 — `bool isAnonymous()`. */
    isAnonymous(): boolean {
        return this.isAnonymous_;
    }

    /**
     * dmd/identifier.d:111 — `const(char)* toHChars2()`. The "header" spelling: maps the special
     * compiler-internal identifiers (`__ctor`, `__dtor`, `$`, …) back to their user-facing keyword
     * form for diagnostics/header generation.
     *
     * Compares against the predefined `Id.*` identifiers (interned, so `===` identity via `equals`).
     * `Id` is value-used here; this method runs post-load so the cyclic value import is safe.
     */
    toHChars2(): DString {
        let p: DString;
        if (this.equals(Id.ctor)) {
            p = ds("this");
        } else if (
            this.equals(Id.dtor) ||
            this.equals(Id.__xdtor) ||
            this.equals(Id.__fieldDtor) ||
            this.equals(Id.__aggrDtor) ||
            this.equals(Id.cppdtor) ||
            this.equals(Id.ticppdtor)
        ) {
            p = ds("~this");
        } else if (this.equals(Id.unitTest)) {
            p = ds("unittest");
        } else if (this.equals(Id.dollar)) {
            p = ds("$");
        } else if (this.equals(Id.withSym)) {
            p = ds("with");
        } else if (this.equals(Id.result)) {
            p = ds("result");
        } else if (this.equals(Id.returnLabel)) {
            p = ds("return");
        } else if (this.equals(Id.postblit)) {
            p = ds("this(this)");
        } else {
            p = this.toChars();
            // `if (*p == '_')` — first byte is '_'; then a few prefix matches (strncmp, 11 bytes).
            if (p.length > 0 && p[0] === 0x5f /* '_' */) {
                if (strncmpEq(p, "_staticCtor", 11)) {
                    p = ds("static this");
                } else if (strncmpEq(p, "_staticDtor", 11)) {
                    p = ds("static ~this");
                } else if (strncmpEq(p, "__invariant", 11)) {
                    p = ds("invariant");
                }
            }
        }
        return p;
    }

    /** dmd/identifier.d:147 — `override DYNCAST dyncast()`. */
    override dyncast(): DYNCAST {
        return DYNCAST.identifier;
    }

    // dmd/identifier.d:152 — `private extern (D) __gshared StringTable!Identifier stringtable;`.
    // Process-global interning table. `__gshared` -> a class-static field; `initTable()` (re)inits it.
    private static stringtable: StringTable<Identifier | null> = new StringTable<Identifier | null>();

    /**
     * dmd/identifier.d:161 — `static Identifier generateId(const(char)[] prefix)`. Generate a fresh
     * unique identifier with the given prefix.
     */
    static generateId(prefix: DString): Identifier {
        const id = Identifier.generateIdSuffix(prefix, Identifier.newSuffix(), false);
        if (K.on) keepGenerated(id, prefix.length);   // the kept-module engine: the identifier of that number
        return id;
    }

    /**
     * dmd/identifier.d:173 — `static Identifier generateAnonymousId(const(char)[] name)`. Generate a
     * fresh unique anonymous identifier (`__anon<name><suffix>`).
     */
    static generateAnonymousId(name: DString): Identifier {
        const prefix = dsConcat(ds("__anon"), name);
        const id = Identifier.generateIdSuffix(prefix, Identifier.newSuffix(), true);
        if (K.on) keepGenerated(id, prefix.length);   // the kept-module engine: the identifier of that number
        return id;
    }

    /**
     * dmd/identifier.d:187 — `static Identifier generateId(const(char)[] prefix, size_t suffix)`.
     * (Form-B sibling of the ptr+length overload, identifier.d:193 — collapsed: a DString carries its
     * length, so `generateId(prefix, length, suffix)` is just this with a pre-sliced prefix.)
     */
    static generateIdWithSuffix(prefix: DString, suffix: number): Identifier {
        return Identifier.generateIdSuffix(prefix, suffix, false);
    }

    // dmd/identifier.d:199 — `private static size_t newSuffix()`. A monotonically-increasing counter;
    // `__gshared size_t i` -> a class-static. `++i` (pre-increment) returns the new value.
    private static suffixCounter = 0;
    private static newSuffix(): number {
        return ++Identifier.suffixCounter;
    }

    /**
     * No D counterpart: the kept-module engine (src/keep.ts) reads `newSuffix`'s counter and, with `n`, sets it:
     * a kept compile starts it at 0 and adds the numbers each replayed unit consumed when it ran.
     */
    static keepSuffixCounter(n?: number): number {
        if (n !== undefined)
            Identifier.suffixCounter = n;
        return Identifier.suffixCounter;
    }

    /**
     * No D counterpart: the kept-module engine (src/keep.ts) drops the generateIdWithLoc counters of the files
     * a kept compile no longer holds (`dead` gets the file name), as a fresh process starts without them, and
     * those whose parent object it no longer keeps (`kept` says false): a parent made again is a new object, with
     * a new key. The parents of the remaining keys are the only ones remembered.
     */
    static purgeLocCounters(dead: (filename: string) => boolean, kept: (parent: object) => boolean): void {
        const utf8 = new TextDecoder();
        const verdicts = new Map<string, boolean>();   // per latin1 file name: most keys share a few files
        const gone = new Map<string, boolean>();       // per parent part `p:<id>`
        const live = new Set<number>();
        for (const k of [...Identifier.locCounters.keys()]) {
            const p = k.slice(k.lastIndexOf("|") + 1);
            const id = p.startsWith("p:") ? Number(p.slice(2)) : 0;
            if (id !== 0) {
                let g = gone.get(p);
                if (g === undefined) {
                    const o = parentObjs.get(id);
                    gone.set(p, g = o !== undefined && !kept(o));
                }
                if (g) {
                    Identifier.locCounters.delete(k);
                    continue;
                }
            }
            // makeLocCounterKey's layout: `<n>:<locKey>|<m>:<prefix>|<parent>`, locKey = filename ~ prefix_L.._C..
            const c = k.indexOf(":");
            const n = Number(k.slice(0, c));
            const locKey = k.slice(c + 1, c + 1 + n);
            const rest = k.slice(c + 2 + n);
            const c2 = rest.indexOf(":");
            const prefix = rest.slice(c2 + 1, c2 + 1 + Number(rest.slice(0, c2)));
            const name = locKey.slice(0, locKey.lastIndexOf(prefix + "_L"));
            let d = verdicts.get(name);
            if (d === undefined)
                verdicts.set(name, d = dead(utf8.decode(Uint8Array.from(name, (ch) => ch.charCodeAt(0)))));
            if (d)
                Identifier.locCounters.delete(k);
            else if (id !== 0)
                live.add(id);
        }
        for (const id of [...parentObjs.keys()]) {
            if (!live.has(id))
                parentObjs.delete(id);
        }
    }

    // dmd/identifier.d:205 — `private static Identifier generateId(prefix, suffix, isAnonymous)`.
    private static generateIdSuffix(prefix: DString, suffix: number, isAnonymous: boolean): Identifier {
        const buf = new OutBuffer();
        buf.write(prefix);
        buf.print(BigInt(suffix)); // buf.print(size_t) -> bigint domain (08 OutBuffer.print)
        return Identifier.idPool(buf.extractData(), isAnonymous);
    }

    /***************************************
     * dmd/identifier.d:229 — `static Identifier generateIdWithLoc(string prefix, Loc loc, const void*
     * parent = null)`. Generate a deterministic name based on a source location, consistent across
     * compilations. If `(prefix, loc, parent)` was already seen, an extra `_N` suffix disambiguates.
     *
     * The keyed counter map is keyed by `(locKey, prefix, parent)` where `locKey = filename ~
     * "<prefix>_L<line>_C<col>"`. `parent` is an opaque pointer used only for identity in the key — a
     * `const void*` -> an opaque object reference (`unknown`), compared by identity via the Map key.
     *
     * The `static if (__traits(compiles, counters.update(...)))` (identifier.d:261) probes for the
     * 2.082+ AA `.update` overload; __VERSION__==2113 (07 §3.2), so it resolves TRUE -> the `.update`
     * branch. We port the insert-or-bump behavior directly over a JS `Map`.
     */
    static generateIdWithLoc(prefix: DString, loc: Loc, parent: unknown = null): Identifier {
        // generate `<prefix>_L<line>_C<col>`
        const sl = SourceLoc.fromLoc(loc);
        const idBuf = new OutBuffer();
        idBuf.writestring(prefix);
        idBuf.writestring(ds("_L"));
        idBuf.print(BigInt(sl.line));
        idBuf.writestring(ds("_C"));
        idBuf.print(BigInt(sl.column));

        // Make identifiers unique per filename (module/mixin) and, for lambdas, per `parent` context.
        // `static struct Key { string locKey; string prefix; const(void)* parent; }` +
        // `__gshared uint[Key] counters;` -> a process-global Map keyed by the composite key.
        // cast(string)(sl.filename ~ idBuf[]) — idBuf[] is a VIEW (opSliceAll, 08 §13a.2); the
        // buffer stays live: the counter branch below appends to it and the final idPool reads it.
        const locKey = dsConcat(sl.filename, idBuf.opSliceAll());
        const key = makeLocCounterKey(locKey, prefix, parent);

        // resolved: static if(__traits(compiles, counters.update(...))) -> true (__VERSION__==2113,
        //   07 §3.2); emit the `.update` (insert-or-bump) branch.
        const counter = Identifier.locCounters.get(key);
        if (counter === undefined) {
            Identifier.locCounters.set(key, 1); // insertion: () => 1u
        } else {
            // update: append `_<counter>` and bump the stored value (counter + 1).
            idBuf.writestring(ds("_"));
            idBuf.print(BigInt(counter));
            Identifier.locCounters.set(key, counter + 1);
        }

        return Identifier.idPool(idBuf.opSliceAll()); // idPool(idBuf[]) — view; idPool copies the key bytes
    }

    // The `__gshared uint[Key] counters` of generateIdWithLoc (identifier.d:257). String key built by
    // `makeLocCounterKey` (parent identity folded in via a per-object id) -> a JS Map.
    private static locCounters = new Map<string, number>();

    /**
     * No D counterpart: the djs driver's reset between two compiles in one process (src/djs.ts
     * `deinitializeFrontend`). Restarts the generated-identifier numbering (`newSuffix`'s `__gshared size_t i`,
     * dmd/identifier.d:199, and generateIdWithLoc's `counters`, :257) and the per-parent key ids, as in a fresh
     * process: the generated names (`__lambda1`, `__dgliteral2`) print in `-vcg-ast` and in diagnostics.
     */
    static resetGenerators(): void {
        Identifier.suffixCounter = 0;
        Identifier.locCounters.clear();
        parentIds = new WeakMap<object, number>();
        parentObjs.clear();
        nextParentId = 1;
    }

    /********************************************
     * dmd/identifier.d:291 — `static Identifier idPool(scope const(char)* s, uint len)`. Intern the
     * slice `s[0..len]`. A DString carries its own length, so this slices then forwards to the
     * canonical `idPool` (slice form) below.
     */
    static idPoolLen(s: DString, len: number): Identifier {
        return Identifier.idPool(s.subarray(0, len));
    }

    /**
     * dmd/identifier.d:296 — `static Identifier idPool(const(char)[] s, bool isAnonymous = false)`.
     * The canonical interning path: update the table (insert-or-get), and if the slot has no
     * Identifier yet, create one with `TOK.identifier`. This is the primary `idPool` name (the D
     * ptr+len overload above is the secondary form, renamed `idPoolLen` per 04 §1B).
     */
    static idPool(s: DString, isAnonymous = false): Identifier {
        const sv = Identifier.stringtable.update(s, null); // T.init for `Identifier` ref is null (08 §5)
        let id = sv.value;
        if (!id) {
            id = new Identifier(sv.toString(), TOK.identifier, isAnonymous);
            sv.value = id;
        }
        return id;
    }

    /******************************************
     * dmd/identifier.d:314 — `static void idPool(const(char)[] s, TOK value)`. Used for inserting
     * KEYWORDS into the string table: insert (no-clobber) a new Identifier carrying the keyword's
     * `TOK value`. Same D name `idPool`, different 2nd-param TYPE (`TOK value` vs the `bool
     * isAnonymous` above) -> renamed `idPoolKeyword` per 04 §1B. The `assert(sv)` enforces the slot
     * was newly inserted (keywords are unique).
     */
    static idPoolKeyword(s: DString, value: TOK): void {
        const sv = Identifier.stringtable.insert(s, null);
        assert(sv); // keyword must not already be present (identifier.d:317)
        const id = new Identifier(sv!.toString(), value);
        sv!.value = id;
    }

    /**********************************
     * dmd/identifier.d:329 / :337 — `static bool isValidIdentifier(...)`. True iff `str` is a
     * lexically-valid D identifier. The `const(char)*` overload (identifier.d:329) collapses into the
     * slice form (a DString carries its length); a null/empty slice is invalid.
     */
    static isValidIdentifier(str: DString | null): boolean {
        if (str === null) {
            return false; // D: `return str && isValidIdentifier(str.toDString)` — null -> false
        }

        // import dmd.common.charactertables; (function-local D import -> top-level here, 01 §4.4)
        if (str.length === 0 || (str[0] >= 0x30 && str[0] <= 0x39)) {
            // beware of isdigit() on signed chars — a leading ASCII digit is invalid
            return false;
        }

        // Lexer-style validation (identifier.d:351): walk bytes; ASCII id-chars advance one byte,
        // bytes with the high bit set are UTF-8 decoded and checked against the start/continue tables.
        let p = 0;
        const pEnd = str.length;

        // handle start characters
        {
            const c = str[p];
            if (isidchar(c)) {
                p++;
            } else if (c & 0x80) {
                // utf_decodeChar over the remaining slice; in djs `error === null` means SUCCESS
                // (D's `utf_decodeChar(...) is null`), `nextIdx` is `countDecoded` for the idx-0 call.
                const r = utf_decodeChar(str.subarray(p, pEnd), 0);
                if (r.error === null || isAnyStart(r.dchar)) {
                    p += r.nextIdx; // p += countDecoded
                } else {
                    return false;
                }
            } else {
                return false;
            }
        }

        // handle continue characters
        while (p !== pEnd) {
            const c = str[p];
            if (isidchar(c)) {
                // handles ASCII subset
                p++;
                continue;
            } else if (c & 0x80) {
                const r = utf_decodeChar(str.subarray(p, pEnd), 0);
                if (r.error === null || isAnyContinue(r.dchar)) {
                    p += r.nextIdx; // p += countDecoded
                    continue;
                } else {
                    return false;
                }
            } else {
                return false;
            }
        }

        return true;
    }

    /**
     * dmd/identifier.d:414 / :419 — `static Identifier lookup(...)`. Look up an already-interned
     * identifier; returns `null` if absent. The ptr+len overload collapses into the slice form.
     */
    static lookup(s: DString): Identifier | null {
        const sv = Identifier.stringtable.lookup(s);
        if (!sv) {
            return null;
        }
        return sv.value;
    }

    /** dmd/identifier.d:427 — `static void initTable()`. (Re)initialize the interning table. */
    static initTable(): void {
        // _init(28_000) is a capacity hint; the djs StringTable grows itself (08 §5). Reset to empty
        // so a crash-restart rebuilds the pool from scratch (crash-only).
        Identifier.stringtable = new StringTable<Identifier | null>();
        Identifier.stringtable._init(28_000);
    }
}

/// `strncmp(p, lit, n) == 0` over the first `n` bytes (identifier.d:136 et al). `lit` is an ASCII
/// literal; compares byte-for-byte up to `n` (and requires `p` to have at least `n` bytes).
function strncmpEq(p: DString, lit: string, n: number): boolean {
    if (p.length < n) {
        return false;
    }
    const l = ds(lit);
    for (let i = 0; i < n; i++) {
        if (p[i] !== l[i]) {
            return false;
        }
    }
    return true;
}

// --- generateIdWithLoc key plumbing (identifier.d:256) ---
//
// D's key is `struct Key { string locKey; string prefix; const(void)* parent; }`, an AA key compared
// field-wise (byte content for the strings, pointer identity for `parent`). A JS Map needs a string
// key, so we build an injective composite: Latin-1 image of `locKey` and `prefix` bytes (length-
// prefixed so the boundary is unambiguous) plus a stable per-object id for `parent`. Equal keys IFF
// equal byte content AND same `parent` object — exactly D's field-wise compare.

let parentIds = new WeakMap<object, number>();
let nextParentId = 1;
/**
 * No D counterpart: each parent id's object, for `purgeLocCounters` (the kept-module engine only). Held strongly
 * and pruned there to the parents of live keys: a WeakRef would hold its target to the end of the current job,
 * which for a host compiling in one synchronous loop is never.
 */
const parentObjs = new Map<number, object>();
function parentKeyPart(parent: unknown): string {
    if (parent === null || parent === undefined) {
        return "0"; // the null pointer
    }
    if (typeof parent !== "object" && typeof parent !== "function") {
        // a non-object opaque value (shouldn't happen for a `const void*`); use its string form.
        return "v:" + String(parent);
    }
    const obj = parent as object;
    let id = parentIds.get(obj);
    if (id === undefined) {
        id = nextParentId++;
        parentIds.set(obj, id);
        if (K.on) parentObjs.set(id, obj);   // the kept-module engine: a parent it may drop
    }
    return "p:" + id;
}

function latin1(bytes: DString): string {
    let s = "";
    for (let i = 0; i < bytes.length; i++) {
        s += String.fromCharCode(bytes[i]);
    }
    return s;
}

function makeLocCounterKey(locKey: DString, prefix: DString, parent: unknown): string {
    // length-prefix each byte-string so distinct (locKey, prefix) splits never collide.
    return locKey.length + ":" + latin1(locKey) + "|" + prefix.length + ":" + latin1(prefix) + "|" + parentKeyPart(parent);
}
