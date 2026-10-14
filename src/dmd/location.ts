// Port of dmd/location.d — file/line/column source locations + diagnostic-prefix formatting.
//
// FAITHFUL 1:1 frontend module (NOT a root-runtime module — 00 §0.1 exemption does not apply):
// the structures and algorithms are mirrored line-for-line. `Loc`/`SourceLoc`/`BaseLoc` are D
// `struct`s -> TS `class`es with a `.copy()` (02 §2, 03 §2). The `__gshared` module-global Loc
// table (`locIndex`/`locFileTable`/`lastFileTableIndex`) is mutable module-level state, reset by
// `Loc._init()` (the D `static this`-free, runtime-resettable global table — 10 §1.5).
//
// Location formatting (`writeSourceLoc`) feeds diagnostics byte-for-byte (10 §3.2) — the worked
// example in 10 §3.2 is the contract this port reproduces exactly.
//
// GOVERNING TRANSLATIONS / RESOLUTIONS:
//   - resolved: version(DigitalMars) version(linux) version(X86) -> false (target = LDC/POSIX/
//     AArch64, _config.md). The `private uint dummy;` segfault-workaround field is DROPPED.
//   - A D `const(char)[]` / `string` / `const(char)*` is a DString (Uint8Array) byte view (02 §1.3,
//     08 §11). `filename.toDString` is the identity pass in djs (root/string.toDString), so the
//     C++ `const(char)*`-taking entry points just forward the DString.
//   - `extern (C++)` / `nothrow` / `@nogc` / `@safe` / `@trusted` / `pure` ERASE (04 §8).
//   - `BaseLoc*[] locFileTable` (array of pointers) -> a plain JS `BaseLoc[]` (a class is already a
//     reference, 02 §10); `~=` -> `.push()`. `newBaseLoc` returns the class reference (no `*`).
//   - D `assert(0)` at the end of the binary searches -> `assertUnreachable()` (10 §2.2).
//   - `cast(int)` / `cast(uint)` on the line/column arithmetic: these are <=32-bit `number`
//     truncations (09 §2). Line/column/offset are all `uint`/`int` -> `number` domain; the
//     `cast(int)` forms re-truncate via `toInt32` (09 §2.1).

import { assertUnreachable, SwitchError } from "../assert.js";
import { dsEmpty, dsEquals, dsLength } from "../dstring.js";
import type { DString } from "../dstring.js";
import { toInt32 } from "../numeric.js";
import { toDString } from "./root/string.js";
import { FileName } from "./root/filename.js";
// OutBuffer is a runtime container (common/outbuffer.ts). Used both as the `writeSourceLoc`
// parameter TYPE and as a VALUE in `SourceLoc.toChars` (constructs one). outbuffer.ts does not
// import location.ts, so this direct value import is not a load-time cycle.
import { OutBuffer } from "./common/outbuffer.js";

/// How code locations are formatted for diagnostic reporting (location.d:22).
/// `enum MessageStyle : ubyte` — a <=32-bit base, so a TS numeric `enum` (02 §4.2).
export enum MessageStyle {
    digitalmars, // filename.d(line): message
    gnu, // filename.d:line: message, see https://www.gnu.org/prep/standards/html_node/Errors.html
    sarif, // JSON SARIF output, see https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
}

/**
 * A source code location (location.d:34).
 *
 * Used for error messages, `__FILE__` and `__LINE__` tokens, `__traits(getLocation, XXX)`,
 * debug info etc.
 *
 * VALUE TYPE (D `struct`): every assignment / by-value pass / array-element-read / return copies
 * (03 §1) — emit `.copy()` at those sites. The whole value is a single `uint index` into the
 * module-global line table, so `.copy()` is a one-field clone.
 */
export class Loc {
    // resolved: version(DigitalMars)version(linux)version(X86) `private uint dummy;` (location.d:42)
    // -> false (target is LDC/POSIX/AArch64, _config.md). The segfault-workaround field is dropped.

    private index = 0; // offset into lineTable[] (location.d:36)

    /// use for default initialization of Loc's (location.d:44, `static immutable Loc initial`).
    /// A `Loc` with `index == 0` (the default) — the null/invalid location. `Loc` is in the
    /// ALIAS-SAFE REGISTER (03 §9.1): share it freely on read — a defensive `.copy()` on a
    /// register member is a deviation to remove, not a pattern to follow. Never mutate a Loc's
    /// FIELDS; D `ref Loc` parameters that REBIND the slot (`loc = …`) replace which Loc the
    /// slot holds and are ported with a Ref box — that is slot mutation, not object mutation.
    static readonly initial: Loc = new Loc();

    // location.d:46-47 — `extern (C++) __gshared` configuration, process-global. `set()` writes them.
    static showColumns = false;
    static messageStyle: MessageStyle = MessageStyle.digitalmars;

    // nothrow: (location.d:49) — ERASE (04 §8).

    /**
     * `.copy()` (03 §2): one-field clone of the value struct. `index` is a `uint` primitive.
     */
    copy(): Loc {
        const c = new Loc();
        c.index = this.index;
        return c;
    }

    /// Reset global (Base)Loc tables, invalidating every existing `Loc` out there and giving room
    /// to create new `Loc`s (location.d:53).
    static _init(): void {
        locIndex = 1;
        locFileTable = [];
        lastFileTableIndex = 0;
    }

    /*******************************
     * Configure how display is done (location.d:66).
     * Params:
     *  showColumns = when to display columns
     *  messageStyle = digitalmars or gnu style messages
     */
    static set(showColumns: boolean, messageStyle: MessageStyle): void {
        Loc.showColumns = showColumns;
        Loc.messageStyle = messageStyle;
    }

    /// Returns: a Loc that simply holds a filename, with no line / column info (location.d:73).
    /// A `const(char)*` is already a DString here, so `filename.toDString` is the identity pass.
    static singleFilename(filename: DString): Loc {
        const result = new Loc();
        locFileTable.push(new BaseLoc(toDString(filename)!, null, locIndex, 0, [0]));
        result.index = locIndex++;
        return result;
    }

    /// utf8 code unit index relative to start of line, starting from 1 (location.d:82, `charnum`).
    charnum(): number {
        return SourceLoc.fromLoc(this).column;
    }

    /// line number, starting from 1 (location.d:88, `linnum`).
    linnum(): number {
        return SourceLoc.fromLoc(this).line;
    }

    /// Advance this location to the first column of the next line (location.d:94).
    nextLine(): void {
        const i = fileTableIndex(this.index);
        const j = locFileTable[i].getLineIndex(this.index - locFileTable[i].startIndex);
        if (j + 1 < locFileTable[i].lines.length) {
            this.index = locFileTable[i].startIndex + locFileTable[i].lines[j + 1];
        }
    }

    /***
     * Returns: filename for this location, null if none (location.d:105).
     * D returns a `const(char)*`; in djs that is a DString slice (08 §11). The `.ptr` reads in D
     * are no-ops here (a DString carries its own length / has no embedded NUL).
     */
    filename(): DString | null {
        if (this.index === 0) {
            return null;
        }

        const i = fileTableIndex(this.index);
        if (locFileTable[i].substitutions.length > 0) {
            const si = locFileTable[i].getSubstitutionIndex(this.index - locFileTable[i].startIndex);
            const fname = locFileTable[i].substitutions[si].filename;
            if (fname.length > 0) {
                return fname;
            }
        }

        return locFileTable[i].filename;
    }

    /// (location.d:122) — the formatted location prefix as a display string (a `const(char)*` in D
    /// -> a DString here). Defaults read the `__gshared` config off `Loc`.
    toChars(showColumns: boolean = Loc.showColumns, messageStyle: MessageStyle = Loc.messageStyle): DString {
        return SourceLoc.fromLoc(this).toChars(showColumns, messageStyle);
    }

    /// Returns: byte offset into source file (location.d:130, `fileOffset`).
    fileOffset(): number {
        const i = fileTableIndex(this.index);
        return this.index - locFileTable[i].startIndex;
    }

    /// Returns: this location as a SourceLoc (location.d:137).
    toSourceLoc(): SourceLoc {
        return SourceLoc.fromLoc(this);
    }

    /**
     * Checks for equivalence by comparing the filename contents (not the pointer) and character
     * location (location.d:149).
     *
     * Note:
     *  - resolved: version(Windows) case-insensitive compare -> false; POSIX exact-byte compare
     *    (delegated to `FileName.equals`).
     *  - Ignores `charnum` if `Columns` is false.
     */
    equals(loc: Loc): boolean {
        const lhs = SourceLoc.fromLoc(this);
        const rhs = SourceLoc.fromLoc(loc);
        return (
            (!Loc.showColumns || lhs.column === rhs.column) &&
            lhs.line === rhs.line &&
            FileName.equals(lhs.filename, rhs.filename)
        );
    }

    /**
     * `opEquals()` / `toHash()` for AA key usage (location.d:166). 05 §13: emit the methods so an
     * AA container keyed by `Loc` can use them; no call-site operator rewrite needed beyond
     * `a == b` -> `a.opEquals(b)` (05 §2).
     *
     * Compare filename contents (case-sensitively on Windows too), not the pointer — a static
     * foreach loop repeatedly mixing in a mixin may lead to multiple equivalent filenames
     * (`foo.d-mixin-<line>`), e.g., for test/runnable/test18880.d.
     */
    opEquals(loc: Loc): boolean {
        return this.index === loc.index;
    }

    /// ditto (location.d:172, `toHash`).
    /// D does `hashOf(this.index)`; for a `uint` argument DRUNTIME `hashOf` is the IDENTITY (VERIFIED
    /// ldc2-1.42.0: `hashOf(0x12345678u) == 0x12345678`), so this returns `index` unchanged.
    /// NOTE (resolution #1, 08 §9): the djs runtime helper `root/hash.ts:hashOf` now exists, but it is
    /// the port's OWN content hash (MurmurHash2-based), NOT druntime's identity-on-uint — `hashOf(42)`
    /// there is `1483788722`, not `42`. This site is pinned to the druntime IDENTITY semantics
    /// (faithful: a Loc AA keys on `index`), so it does NOT route through `hashOf`/`mixHash`; those
    /// helpers are for emitted composite `toHash` methods that need a real content hash. Returns
    /// `size_t` -> `number` (05 §13).
    toHash(): number {
        return this.index;
    }

    /******************
     * Returns:
     *   true if Loc has been set to other than the default initialization (location.d:181).
     */
    isValid(): boolean {
        return this.index !== 0;
    }

    // Internal accessors for module-level free functions (D reads `loc.index` directly, all in
    // the same module; TS `private` blocks that, so expose a package-internal getter/setter).
    /** @internal D `loc.index` read (same-module access). */
    get index_(): number {
        return this.index;
    }
    /** @internal D `result.index = …` write (same-module access, e.g. BaseLoc.getLoc). */
    set index_(v: number) {
        this.index = v;
    }
}

/**
 * Format a source location for error messages (location.d:196).
 *
 * THE byte-for-byte diagnostic-prefix contract (10 §3.2). Reproduce every byte.
 *
 * Params:
 *   buf = buffer to write string into
 *   loc = source location to write
 *   showColumns = include column number in message
 *   messageStyle = select error message format
 */
export function writeSourceLoc(
    buf: OutBuffer,
    loc: SourceLoc,
    showColumns: boolean,
    messageStyle: MessageStyle,
): void {
    if (loc.filename.length === 0) {
        return;
    }
    buf.writestring(loc.filename);
    if (loc.line === 0) {
        return;
    }

    // `final switch` (06 §3.2): exhaustive over MessageStyle; the `default` is an unreachable guard.
    switch (messageStyle) {
        case MessageStyle.digitalmars:
            buf.writeByte(0x28); // '('
            buf.print(BigInt(loc.line)); // OutBuffer.print takes a ulong -> bigint (08, outbuffer)
            if (showColumns && loc.column) {
                buf.writeByte(0x2c); // ','
                buf.print(BigInt(loc.column));
            }
            buf.writeByte(0x29); // ')'
            break;
        case MessageStyle.gnu: // https://www.gnu.org/prep/standards/html_node/Errors.html
            buf.writeByte(0x3a); // ':'
            buf.print(BigInt(loc.line));
            if (showColumns && loc.column) {
                buf.writeByte(0x3a); // ':'
                buf.print(BigInt(loc.column));
            }
            break;
        case MessageStyle.sarif: // https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
            // No formatting needed here for SARIF
            break;
        default: {
            // final switch (location.d:207): D throws SwitchError on an unhandled value (06 §3.2)
            const _exhaustive: never = messageStyle; void _exhaustive;
            throw new SwitchError();
        }
    }
}

/**
 * Describes a location in the source code as a file + line number + column number (location.d:240).
 *
 * While `Loc` is a compact opaque location meant to be stored in the AST, this struct has simple
 * modifiable fields and is used for printing.
 *
 * VALUE TYPE (D `struct`): copies on assignment / by-value pass / return (03 §1). The
 * `this = locFileTable[i].getSourceLoc(...)` self-assignment in the from-Loc ctor is a whole-struct
 * copy (03 §1#1) — reproduced by field-wise assignment from the source's `.copy()`.
 */
export class SourceLoc {
    filename: DString; // name of source file (location.d:242)
    line: number; // line number (starts at 1) (location.d:243)
    column: number; // column number (starts at 1) (location.d:244)
    fileOffset: number; // byte index into file (location.d:245)

    /// Index `fileOffset` into this to obtain source code context of this location (location.d:248).
    fileContent: DString; // (location.d:248)

    // aliases for backwards compatibility (location.d:251-252): `alias linnum = line;`,
    // `alias charnum = column;`. These are FIELD aliases (a second name for the same field), not
    // separate storage. Exposed as getters that read the canonical field so call sites using
    // `.linnum`/`.charnum` read literally (02 §5.3; substitute() below writes `.linnum`).
    get linnum(): number {
        return this.line;
    }
    set linnum(v: number) {
        this.line = v;
    }
    get charnum(): number {
        return this.column;
    }
    set charnum(v: number) {
        this.column = v;
    }

    /**
     * Field constructor (location.d:254). The trailing defaults (`fileOffset = 0`,
     * `fileContent = null`) map to TS default params. A null `fileContent` becomes the empty
     * DString (a D `null` char-slice has `.length == 0`, matching `dsEmpty` byte-wise).
     */
    constructor(
        filename: DString,
        line: number,
        column: number,
        fileOffset = 0,
        fileContent: DString | null = null,
    ) {
        this.filename = filename;
        this.line = line;
        this.column = column;
        this.fileOffset = fileOffset;
        this.fileContent = fileContent ?? dsEmpty;
    }

    /**
     * From-Loc factory (location.d:263, `this(Loc loc)`). A same-arity-but-different-type overload
     * of the field ctor (both are arity-1: `SourceLoc(Loc)` vs `SourceLoc(const(char)[])`), so per
     * 04 §1B it is promoted to a NAMED static factory `fromLoc`. D's default-init then conditional
     * `this = ...getSourceLoc(...)` becomes: start from the empty SourceLoc and overwrite when the
     * Loc resolves to a real table entry.
     */
    static fromLoc(loc: Loc): SourceLoc {
        const result = new SourceLoc(dsEmpty, 0, 0); // default-initialized SourceLoc (filename = null)
        if (loc.index_ === 0 || locFileTable.length === 0) {
            return result;
        }

        const i = fileTableIndex(loc.index_);
        // `this = locFileTable[i].getSourceLoc(...)` — whole-struct copy (03 §1#1).
        return locFileTable[i].getSourceLoc(loc.index_ - locFileTable[i].startIndex).copy();
    }

    /// `.copy()` (03 §2): primitive fields by value; the `filename`/`fileContent` byte-slices are
    /// shared (a D slice copy shares its backing store — 03 §2, do not deep-copy).
    copy(): SourceLoc {
        return new SourceLoc(this.filename, this.line, this.column, this.fileOffset, this.fileContent);
    }

    /// (location.d:272) — the formatted location prefix as a display string. `const(char)*` -> DString.
    toChars(showColumns: boolean = Loc.showColumns, messageStyle: MessageStyle = Loc.messageStyle): DString {
        const buf = new OutBuffer();
        writeSourceLoc(buf, this, showColumns, messageStyle);
        return buf.extractChars();
    }

    /// (location.d:281, `opEquals`). 05 §2: struct `==` -> `.opEquals()`; compares the byte
    /// content of `filename` (not pointer identity) plus line/column.
    opEquals(other: SourceLoc): boolean {
        return dsEquals(this.filename, other.filename) && this.line === other.line && this.column === other.column;
    }
}

/// Given the `index` of a `Loc`, find the index in `locFileTable` of the corresponding `BaseLoc`
/// (location.d:289). `private` in D -> module-private here (not exported).
function fileTableIndex(index: number): number {
    // To speed up linear find, we cache the last hit and compare that first, since usually we stay
    // in the same file for some time when resolving source locations. If it's a different file now,
    // either scan forwards / backwards.
    let i = lastFileTableIndex;
    if (index >= locFileTable[i].startIndex) {
        while (i + 1 < locFileTable.length && index >= locFileTable[i + 1].startIndex) {
            i++;
        }
    } else {
        while (index < locFileTable[i].startIndex) {
            i--;
        }
    }

    lastFileTableIndex = i;
    return i;
}

/**
 * Create a new source location map for a file (location.d:317, `newBaseLoc`).
 * Params:
 *   filename = source file name (a `const(char)*` -> DString)
 *   fileContent = content of source file
 * Returns: new BaseLoc (the class reference — D returns a `BaseLoc*`, 02 §10).
 */
export function newBaseLoc(filename: DString, fileContent: DString): BaseLoc {
    locFileTable.push(new BaseLoc(toDString(filename)!, fileContent, locIndex, 1, [0]));
    // Careful: the endloc of a FuncDeclaration can point to 1 past the very last byte in the file,
    // so account for that.
    locIndex += dsLength(fileContent) + 1;
    return locFileTable[locFileTable.length - 1];
}

/**
 * Mapping from byte offset into source file to line/column numbers (location.d:363, `struct BaseLoc`).
 *
 * (Full algorithm doc — the byte-offset -> line/column binary search with #line/#file substitutions —
 * is preserved verbatim from location.d:326-362; see that comment for the worked example.)
 *
 * VALUE TYPE (D `struct`): but it is always held BY POINTER (`BaseLoc*[] locFileTable`,
 * `newBaseLoc` returns `BaseLoc*`), so in djs it is shared by reference (02 §10) — the table owns
 * the single instance, `getLoc`/`getSourceLoc`/the substitution searches mutate its caches in
 * place. A `.copy()` is provided for the one by-value use: `substitutions ~= BaseLoc(...)` stores
 * fresh value instances (constructed, not copied), and `addSubstitution` reads no aliasable struct.
 */
export class BaseLoc {
    // @safe nothrow: (location.d:365) — ERASE (04 §8).

    filename: DString; // Source file name (location.d:367)
    fileContents: DString; // Source file contents (location.d:368)
    startIndex: number; // Subtract this from Loc.index to get file offset (location.d:369)
    startLine = 1; // Line number at index 0 (location.d:370)
    lines: number[]; // For each line, the file offset at which it starts; index 0 is always 0 (location.d:371)
    substitutions: BaseLoc[] = []; // Substitutions from #line / #file directives (location.d:372)

    private lastLineIndex = 0; // Cache for the last line lookup (location.d:375)
    private lastSubstIndex = 0; // Cache for the last substitution lookup (location.d:377)

    /**
     * Field constructor. D's `BaseLoc(filename, contents, startIndex, startLine, lines)` is the
     * aggregate initializer used at the `~= new BaseLoc(...)` / `~= BaseLoc(...)` sites
     * (location.d:76,319,404,408). The `lines` default (`[0]`-less forms in `addSubstitution`)
     * is handled per call site; `startLine` keeps its `= 1` default for the substitution form.
     */
    constructor(
        filename: DString,
        fileContents: DString | null,
        startIndex: number,
        startLine: number,
        lines: number[] = [],
    ) {
        this.filename = filename;
        this.fileContents = fileContents ?? dsEmpty;
        this.startIndex = startIndex;
        this.startLine = startLine;
        this.lines = lines;
    }

    /// `.copy()` (03 §2): primitives by value, byte-slices shared, `lines`/`substitutions` arrays
    /// shared (a D slice copy shares the backing store — 03 §2). Used only where a value-copy of a
    /// BaseLoc is taken (none on the lex/sema path — BaseLoc is pointer-held); kept for fidelity.
    copy(): BaseLoc {
        const c = new BaseLoc(this.filename, this.fileContents, this.startIndex, this.startLine, this.lines);
        c.substitutions = this.substitutions;
        c.lastLineIndex = this.lastLineIndex;
        c.lastSubstIndex = this.lastSubstIndex;
        return c;
    }

    /// Register that a new line starts at `offset` bytes from the start of the source file
    /// (location.d:380, `newLine`).
    newLine(offset: number): void {
        this.lines.push(offset);
    }

    /// Construct a `Loc` entry for the start of the source file + `offset` bytes (location.d:386).
    getLoc(offset: number): Loc {
        const result = new Loc();
        result.index_ = this.startIndex + offset;
        return result;
    }

    /**
     * Register a new file/line mapping from #file and #line directives (location.d:400).
     * Params:
     *     offset = byte offset in the source file at which the substitution starts
     *     filename = new filename from this point on (null = unchanged) (a `const(char)*` -> DString)
     *     line = line number from this point on
     */
    addSubstitution(offset: number, filename: DString | null, line: number): void {
        let fname = toDString(filename);
        if (this.substitutions.length === 0) {
            this.substitutions.push(new BaseLoc(this.filename, null, 0, 0));
        }

        if (!fname || fname.length === 0) {
            fname = this.substitutions[this.substitutions.length - 1].filename;
        }
        // cast(int)(line - lines.length + startLine - 2): <=32-bit int arithmetic (09 §2).
        const subLine = toInt32(line - this.lines.length + this.startLine - 2);
        this.substitutions.push(new BaseLoc(fname, null, offset, subLine));
    }

    /// Returns: `loc` modified by substitutions from #file / #line directives (location.d:412).
    substitute(loc: SourceLoc): SourceLoc {
        if (this.substitutions.length === 0) {
            return loc;
        }

        const i = this.getSubstitutionIndex(loc.fileOffset);
        if (this.substitutions[i].filename.length > 0) {
            loc.filename = this.substitutions[i].filename;
        }
        loc.linnum += this.substitutions[i].startLine;
        return loc;
    }

    /// Resolve an offset into this file to a filename + line + column (location.d:425, `getSourceLoc`).
    /// `private` in D -> not exported; but `SourceLoc.fromLoc` (same module) calls it.
    getSourceLoc(offset: number): SourceLoc {
        const i = this.getLineIndex(offset);
        // cast(int)(i + startLine) / cast(int)(1 + offset - lines[i]): <=32-bit int (09 §2).
        const sl = new SourceLoc(
            this.filename,
            toInt32(i + this.startLine),
            toInt32(1 + offset - this.lines[i]),
            offset,
            this.fileContents,
        );
        return this.substitute(sl);
    }

    /// (location.d:432, `getSubstitutionIndex`). Cache-accelerated linear/binary search over
    /// `substitutions[*].startIndex` for the entry covering `offset`. `private` in D -> not
    /// exported; same-module `filename()`/`substitute()` call it.
    getSubstitutionIndex(offset: number): number {
        if (this.substitutions.length <= 1) {
            return 0;
        }

        // Check if the offset falls within the current cached substitution or the next one.
        if (this.lastSubstIndex < this.substitutions.length - 1) {
            // For the current substitution's range
            if (
                this.substitutions[this.lastSubstIndex].startIndex <= offset &&
                (this.lastSubstIndex === this.substitutions.length - 1 ||
                    this.substitutions[this.lastSubstIndex + 1].startIndex > offset)
            ) {
                return this.lastSubstIndex;
            }

            // For the next substitution's range
            if (
                this.lastSubstIndex + 1 < this.substitutions.length - 1 &&
                this.substitutions[this.lastSubstIndex + 1].startIndex <= offset &&
                this.substitutions[this.lastSubstIndex + 2].startIndex > offset
            ) {
                this.lastSubstIndex++;
                return this.lastSubstIndex;
            }

            // For the previous substitution's range
            if (
                this.lastSubstIndex > 0 &&
                this.substitutions[this.lastSubstIndex - 1].startIndex <= offset &&
                this.substitutions[this.lastSubstIndex].startIndex > offset
            ) {
                this.lastSubstIndex--;
                return this.lastSubstIndex;
            }
        } else if (
            this.lastSubstIndex === this.substitutions.length - 1 &&
            this.substitutions[this.lastSubstIndex].startIndex <= offset
        ) {
            // Last substitution case
            return this.lastSubstIndex;
        }

        // Fall back to binary search, but start near
        let lo = 0;
        let hi = this.substitutions.length - 1;

        // Adjust the range based on the offset relative to lastSubstIndex
        if (offset < this.substitutions[this.lastSubstIndex].startIndex) {
            // Search backward
            lo = 0;
            hi = this.lastSubstIndex;
        } else {
            // Search forward
            lo = this.lastSubstIndex;
            hi = this.substitutions.length - 1;
        }

        let mid = 0;
        while (lo <= hi) {
            mid = lo + ((hi - lo) >> 1); // (hi - lo) / 2 over size_t -> integer divide (09)
            if (this.substitutions[mid].startIndex <= offset) {
                if (mid === this.substitutions.length - 1 || this.substitutions[mid + 1].startIndex > offset) {
                    this.lastSubstIndex = mid; // Update cache
                    return mid;
                }

                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return assertUnreachable(); // assert(0) (location.d:508)
    }

    /// Binary search the index in `this.lines` corresponding to `offset` (location.d:513,
    /// `getLineIndex`). lastLineIndex cache to avoid full binary search when possible. `private`
    /// in D -> not exported; same-module `nextLine()`/`getSourceLoc()` call it.
    getLineIndex(offset: number): number {
        if (this.lines.length <= 1) {
            return 0;
        }

        if (this.lastLineIndex < this.lines.length - 1) {
            if (this.lines[this.lastLineIndex] <= offset && offset < this.lines[this.lastLineIndex + 1]) {
                return this.lastLineIndex;
            }

            if (
                this.lastLineIndex + 1 < this.lines.length - 1 &&
                this.lines[this.lastLineIndex + 1] <= offset &&
                offset < this.lines[this.lastLineIndex + 2]
            ) {
                this.lastLineIndex++;
                return this.lastLineIndex;
            }

            if (
                this.lastLineIndex > 0 &&
                this.lines[this.lastLineIndex - 1] <= offset &&
                offset < this.lines[this.lastLineIndex]
            ) {
                this.lastLineIndex--;
                return this.lastLineIndex;
            }
        } else if (this.lastLineIndex === this.lines.length - 1 && this.lines[this.lastLineIndex] <= offset) {
            return this.lastLineIndex;
        }

        // Fall back to binary search
        let lo = 0;
        let hi = this.lines.length - 1;

        if (offset < this.lines[this.lastLineIndex]) {
            lo = 0;
            hi = this.lastLineIndex;
        } else {
            lo = this.lastLineIndex;
            hi = this.lines.length - 1;
        }

        let mid = 0;
        while (lo <= hi) {
            mid = lo + ((hi - lo) >> 1); // (hi - lo) / 2 over size_t -> integer divide (09)
            if (this.lines[mid] <= offset) {
                if (mid === this.lines.length - 1 || this.lines[mid + 1] > offset) {
                    this.lastLineIndex = mid; // Update cache
                    return mid;
                }

                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return assertUnreachable(); // assert(0) (location.d:576)
    }
}

// ── module-global Loc table (location.d:580-587, `private __gshared`) ───────────────────────────
// These are process-global mutable state, reset by `Loc._init()` (and by the test harness between
// runs, 10 §1.5). Declared as module-level `let` (01 §4.5: mutable global, NOT a top-level
// construction across a cycle — these are self-contained primitives/arrays initialized in place).

// Whenever a new source file is parsed, start the `Loc` from this index (0 is reserved for Loc.init).
let locIndex = 1;

// Global mapping of Loc indices to source file offset/line/column, see `BaseLoc`. D: `BaseLoc*[]`
// -> a plain JS array of class references (02 §10).
let locFileTable: BaseLoc[] = [];

// Index of last found hit in locFileTable, for optimization.
let lastFileTableIndex = 0;

/**
 * No D counterpart: the kept-module engine (src/keep.ts) drops the table entries of the files a kept compile no
 * longer holds (`dead` gets the entry's file name: a module's file or its `-mixin-` name), so the table stays as
 * large as the kept files. The kept entries keep their `startIndex`; a dropped range is never looked up again
 * (no live Loc points into it), and `fileTableIndex` finds the entry at or below any index in the others.
 */
export function purgeLocFiles(dead: (filename: string) => boolean): void {
    const utf8 = new TextDecoder();
    locFileTable = locFileTable.filter((b) => !dead(utf8.decode(b.filename)));
    lastFileTableIndex = 0;
}
