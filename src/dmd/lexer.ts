/**
 * Implements the lexical analyzer, which converts source code into lexical tokens.
 *
 * Port of dmd/lexer.d (module dmd.lexer). FAITHFUL 1:1 frontend module (NOT a root-runtime
 * module — the 00 §0.1 exemption does not apply): the algorithms are mirrored line-for-line.
 *
 * THE BYTE-CURSOR MODEL (the single most load-bearing translation decision):
 *   D's lexer walks the source via a raw `const(char)* p` with pointer arithmetic (`p++`,
 *   `p[1]`, `p - base`, `*p`). JS has no pointers, so every cursor is a NUMERIC BYTE OFFSET into
 *   the shared source `DString this.buf` (08 §11, the byte model). The mapping is mechanical:
 *     `*p`        -> `this.buf[this.p]`        (a byte 0..255; past-end reads `undefined`, guarded)
 *     `p[k]`      -> `this.buf[this.p + k]`
 *     `p++`       -> `this.p++`
 *     `p - base`  -> `this.p - this.base`
 *     `t.ptr = p` -> `t.ptr = this.buf.subarray(this.p)`  (a VIEW so `t.ptr[k]` reads the buffer)
 *   The source buffer is REQUIRED to end in a NUL (0) or EOF (0x1A) sentinel byte (the ctor
 *   contract, lexer.d:120) — the scan loop relies on hitting it, exactly as D relies on `*end`.
 *   To make a one-past-the-buffer read yield that sentinel safely (D's buffer has the NUL byte
 *   physically present), `byteAt` returns 0 for an out-of-range index.
 *
 * REF/OUT pointer params (04 §7, 03 §3.3) are modeled as boxes:
 *   `ref const(char)* sequence` -> a `{ buf, p }` cursor box; `out dchar c2` -> a `{ value }` box.
 *
 * GOVERNING RESOLUTIONS:
 *   - `nothrow:` / `extern (C++)` / `pure` / `@nogc` / `@safe` / `scope` ERASE (04 §8).
 *   - resolved: version(DMDLIB) -> false (_config.md). The `whitespaceToken` paths compile to the
 *     DEAD branch and are DROPPED (the `version(DMDLIB) { if (whitespaceToken) ... }` blocks); the
 *     `whitespaceToken` field is kept (the second ctor sets it) but never observed since DMDLIB OFF.
 *   - resolved: version(IN_LLVM) -> ON (_config.md). The `inreal` `version(IN_LLVM) {} else {...}`
 *     at lexer.d:3049 takes the IN_LLVM (empty) branch — the C `long double`->`real` remap is the
 *     live behavior, so the `Ccompile && long_doublesize == 8` C-double fallback is DROPPED.
 *   - `debug { ... }` blocks (assert/printf) -> OFF (_config.md §3); dropped.
 *   - Named character entity (`\&name;`): resolved via `dmd.entity.HtmlNamedEntity` (entity.ts), the
 *     faithful ~2194-row HTML-entity table. (Previously a 4-entry stub; now de-stubbed.)
 *   - ImportC paths (`Ccompile == true`): faithfully ported (they are in-source lexer logic, NOT the
 *     excluded `cparse`/`importc` modules — those are the C *parser/sema*, reached later). The
 *     lexer's own `Ccompile` branches stay.
 *   - Numeric carriers: `t.unsvalue` is the 64-bit carrier (bigint, 09 §0; via the Token model).
 *     The local `ulong n` in `number()` is a bigint; `n & 0x8000000000000000n` etc. classify the
 *     literal exactly as D's masks do (VERIFIED ldc2). Indices/offsets (`p`, `base`, line/col) are
 *     `number` (09 §1.1). Char values (`dchar c = *p`) are `number` (09 §7).
 */

import { ds, cstr } from "../dstring.js";
import type { DString } from "../dstring.js";
import { assert, assertUnreachable } from "../assert.js";
import { toInt32, toUint8, toUint32, toUint64 } from "../numeric.js";

import { ErrorSink } from "./errorsink.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import type { BaseLoc } from "./location.js";
import { newBaseLoc } from "./location.js";
import { OutBuffer } from "./common/outbuffer.js";
import { IdentifierCharLookup, IdentifierTable, LS, PS } from "./common/charactertables.js";
import {
    isAlphaASCII,
    isidchar,
    isoctal,
    ishex,
    issinglechar,
    isZeroSecond,
    isDigitSecond,
    c_isxdigit,
} from "./common/charactertables.js";
import { CTFloat } from "./root/ctfloat.js";
import { Port } from "./root/port.js";
import { utf_decodeChar, utf_isValidDchar, isBidiControl } from "./root/utf.js";
import { mem } from "./root/rmem.js";
import { TOK, Token, FirstCKeyword, Ckeywords } from "./tokens.js";
import { K, keepClock } from "../keep.js";
import { HtmlNamedEntity } from "./entity.js";

// ── core.stdc.ctype (C-locale, byte-domain) — imported by lexer.d as `core.stdc.ctype` ──────────
// These operate on a single byte (D `char`/`dchar` passed where the value is < 0x80, except the
// few sites that explicitly mask). The default C locale is what the compiler uses (08 §16): only
// the ASCII ranges classify; high bytes never do. Inlined here (01 §3.7: a libc shim is not a
// module). `dchar` arithmetic is the `number` domain (09 §7).

/// C `isdigit`: ASCII '0'..'9'.
function isdigit(c: number): boolean {
    return c >= 0x30 && c <= 0x39;
}

/// C `isxdigit`: ASCII hex digit. (Same predicate as charactertables' `c_isxdigit`.)
function isxdigit(c: number): boolean {
    return c_isxdigit(c);
}

/// C `islower`: ASCII 'a'..'z'.
function islower(c: number): boolean {
    return c >= 0x61 && c <= 0x7a;
}

/// C `isprint`: printable ASCII [0x20, 0x7e].
function isprint(c: number): boolean {
    return c >= 0x20 && c <= 0x7e;
}

/// C `isspace`: space, and the standard whitespace controls (\t \n \v \f \r).
function isspace(c: number): boolean {
    return c === 0x20 || (c >= 0x09 && c <= 0x0d);
}

/***********************************************************
 * Values to use for various magic identifiers (lexer.d:40).
 *
 * VALUE struct (02 §2). The frontend constructs it, copies it by value into the Lexer, and reads
 * it; no `opAssign`/postblit. `.copy()` is a per-field clone (03 §2): primitives by value, the
 * `const(char)[]` date/time/etc. are byte-slices (shared, 03 §2), and the two `IdentifierCharLookup`
 * members recurse `.copy()` (they are value structs of two function refs — charactertables.ts §2).
 */
export class CompileEnv {
    versionNumber = 0; // uint versionNumber;  __VERSION__
    date: DString = ds(""); // const(char)[] date;  __DATE__
    time: DString = ds(""); // const(char)[] time;  __TIME__
    vendor: DString = ds(""); // const(char)[] vendor;  __VENDOR__
    timestamp: DString = ds(""); // const(char)[] timestamp;  __TIMESTAMP__

    previewIn = false; // bool previewIn;  `in` means `[ref] scope const`, accepts rvalues
    transitionIn = false; // bool transitionIn;  `-transition=in` is active
    ddocOutput = false; // bool ddocOutput;  collect embedded documentation comments
    masm = false; // bool masm;  use MASM inline asm syntax
    switchPrefix: DString = ds(""); // const(char)[] switchPrefix;

    // these need a default otherwise tests won't work. (lexer.d:56)
    cCharLookupTable: IdentifierCharLookup = IdentifierCharLookup.forTable(IdentifierTable.LR); // C identifier table
    dCharLookupTable: IdentifierCharLookup = IdentifierCharLookup.forTable(IdentifierTable.LR); // D identifier table

    /// `.copy()` (03 §2): primitives by value; byte-slices shared; the two lookup tables recurse.
    copy(): CompileEnv {
        const c = new CompileEnv();
        c.versionNumber = this.versionNumber;
        c.date = this.date;
        c.time = this.time;
        c.vendor = this.vendor;
        c.timestamp = this.timestamp;
        c.previewIn = this.previewIn;
        c.transitionIn = this.transitionIn;
        c.ddocOutput = this.ddocOutput;
        c.masm = this.masm;
        c.switchPrefix = this.switchPrefix;
        c.cCharLookupTable = this.cCharLookupTable.copy();
        c.dCharLookupTable = this.dCharLookupTable.copy();
        return c;
    }
}

/***********************************************************
 * The lexical analyzer (lexer.d:63, `class Lexer`).
 *
 * REFERENCE type (D `class` -> TS `class`, 02 §2). `final` methods stay plain methods. The
 * `__gshared` shared string buffers are class-static (process-global scratch — outbuffer reuse).
 */
export class Lexer {
    // private __gshared (lexer.d:65) — process-global scratch buffers reused across scans.
    private static stringbuffer: OutBuffer = new OutBuffer();
    // functions that use stringbuffer can call scan that needs this. (lexer.d:68)
    private static stringbuffersecondary: OutBuffer = new OutBuffer();

    baseLoc: BaseLoc | null = null; // BaseLoc* baseLoc; index into this generates `scanloc`
    scanloc: Loc = new Loc(); // Loc scanloc;  for error messages
    prevloc: Loc = new Loc(); // Loc prevloc;  location of token before current
    linnum = 0; // int linnum;  current line number

    // const(char)* p (lexer.d:76) — current character, modeled as a byte offset into `buf`.
    p = 0;

    token: Token = new Token(); // Token token;

    charLookup: IdentifierCharLookup; // IdentifierCharLookup charLookup;  identifiers char table

    // For ImportC (lexer.d:83)
    Ccompile = false; // bool Ccompile;  true if compiling ImportC

    // The following are valid only if (Ccompile == true) (lexer.d:86-92)
    boolsize = 1; // ubyte boolsize;  size of a C _Bool, default 1
    shortsize = 2; // ubyte shortsize;  size of a C short, default 2
    intsize = 4; // ubyte intsize;  size of a C int, default 4
    longsize = 4; // ubyte longsize;  size of C long, 4 or 8
    long_longsize = 8; // ubyte long_longsize;  size of a C long long, default 8
    long_doublesize = 8; // ubyte long_doublesize;  size of C long double
    wchar_tsize = 4; // ubyte wchar_tsize;  size of C wchar_t, 2 or 4

    eSink: ErrorSink; // ErrorSink eSink;  send error messages through this interface
    compileEnv: CompileEnv = new CompileEnv(); // CompileEnv compileEnv;  environment

    // private (lexer.d:97)
    // The shared source buffer. D holds three raw `const(char)*` (base/end/line); here they are
    // byte offsets into `buf` (which is the source `DString`, NUL/EOF-terminated per the ctor).
    private buf: DString = ds("");
    private base = 0; // const(char)* base;  pointer to start of buffer (offset 0 of `buf`)
    private end = 0; // const(char)* end;  offset of last element of buffer
    private line = 0; // const(char)* line;  start of current line (offset)

    private doDocComment = false; // bool doDocComment;  collect doc comment information
    private anyToken = false; // bool anyToken;  seen at least one token
    private commentToken = false; // bool commentToken;  comments are TOK.comment's
    private tokenizeNewlines = false; // bool tokenizeNewlines;  newlines -> TOK.endOfLine's

    private whitespaceToken = false; // bool whitespaceToken;  (only for DMDLIB; resolved OFF)

    private inTokenStringConstant = 0; // int inTokenStringConstant;  can be > 1 in nested q{} strings
    private lastDocLine = 0; // int lastDocLine;  last line of previous doc comment

    private tokenFreelist: Token | null = null; // Token* tokenFreelist;

    // nothrow: (lexer.d:116) — ERASE.

    /**
     * Read the source byte at offset `i` (lexer.d's `*p` / `p[k]`). Returns 0 (the NUL sentinel)
     * for an out-of-range index, reproducing D's guaranteed-terminated buffer: D physically has a
     * 0/0x1A byte at `end`, and the scan loop stops there, so a read at `end` yields that sentinel.
     * Modeling out-of-range as 0 makes the same `case 0:` / `*p == 0` guards fire.
     */
    private byteAt(i: number): number {
        const c = this.buf[i];
        return c === undefined ? 0 : c;
    }

    /*********************
     * Creates a Lexer for the source code base[begoffset..endoffset+1] (lexer.d:132).
     * The last character, base[endoffset], must be null (0) or EOF (0x1A).
     *
     * Form-B overloads (04 §1B): D has three ctors —
     *   (1) the full source ctor (lexer.d:132),
     *   (2) the DMDLIB whitespaceToken ctor (lexer.d:204) -> static factory `forWhitespace`,
     *   (3) the unittest mock ctor `this(ErrorSink)` (lexer.d:216) -> static factory `forMock`.
     * The full ctor is the primary; the others are named factories. `base` is the source `DString`
     * (a `const(char)*`); `begoffset`/`endoffset` are byte offsets into it.
     */
    constructor(
        filename: DString | null,
        base: DString,
        begoffset: number,
        endoffset: number,
        doDocComment: boolean,
        commentToken: boolean,
        errorSink: ErrorSink,
        compileEnv: CompileEnv | null,
    ) {
        this.token = new Token(); // token = Token.init;
        this.buf = base;
        // newBaseLoc(filename, base[0 .. endoffset]) — filename is a const(char)*; a null filename
        // becomes the empty byte-slice (location.ts handles a null/empty name).
        this.baseLoc = newBaseLoc(filename ?? ds(""), base.subarray(0, endoffset));
        this.linnum = 1;
        this.base = 0; // base offset is 0 of `buf`
        this.end = endoffset; // base + endoffset
        this.p = begoffset; // base + begoffset
        this.line = this.p;
        this.doDocComment = doDocComment;
        this.commentToken = commentToken;
        this.tokenizeNewlines = false;
        this.inTokenStringConstant = 0;
        this.lastDocLine = 0;
        this.eSink = errorSink;
        assert(errorSink);
        if (compileEnv) {
            this.compileEnv = compileEnv.copy(); // this.compileEnv = *compileEnv;
        } else {
            this.compileEnv = new CompileEnv();
            this.compileEnv.versionNumber = 1;
            this.compileEnv.vendor = ds("DLF");
            this.compileEnv.cCharLookupTable = IdentifierCharLookup.forTable(IdentifierTable.LR);
            this.compileEnv.dCharLookupTable = IdentifierCharLookup.forTable(IdentifierTable.LR);
        }
        //initKeywords();
        // If first line starts with '#!', ignore the line (lexer.d:165).
        // `if (p && p[0] == '#' && p[1] == '!')` — `p` is non-null whenever there is a buffer.
        if (this.byteAt(this.p) === 0x23 /* '#' */ && this.byteAt(this.p + 1) === 0x21 /* '!' */) {
            this.p += 2;
            for (; ; this.p++) {
                const c = this.byteAt(this.p);
                switch (c) {
                    case 0x0a /* '\n' */:
                        this.p++;
                    // goto case; (fall to the 0/0x1A break)
                    // eslint-disable-next-line no-fallthrough
                    case 0:
                    case 0x1a:
                        break;
                    default:
                        // We do allow malformed UTF-8 on shebang line; do not execute it.
                        continue;
                }
                break;
            }
            this.endOfLine();
        }

        // setup the identifier table lookup functions (lexer.d:198).
        // C tables are setup in its parser constructor.
        this.charLookup = this.compileEnv.dCharLookupTable;
    }

    /***********************
     * Alternative entry point for DMDLIB, adds `whitespaceToken` (lexer.d:204). Form-B factory.
     * resolved: version(DMDLIB) -> OFF (_config.md). Kept as a factory so the surface is faithful;
     * `whitespaceToken` is set but never observed (the DMDLIB scan branches are dropped).
     */
    static forWhitespace(
        filename: DString | null,
        base: DString,
        begoffset: number,
        endoffset: number,
        doDocComment: boolean,
        commentToken: boolean,
        whitespaceToken: boolean,
        errorSink: ErrorSink,
        compileEnv: CompileEnv | null = null,
    ): Lexer {
        const lex = new Lexer(filename, base, begoffset, endoffset, doDocComment, commentToken, errorSink, compileEnv);
        lex.whitespaceToken = whitespaceToken;
        return lex;
    }

    /******************
     * Used for unittests for a mock Lexer (lexer.d:216). Form-B factory. The mock leaves `buf`
     * empty and only wires `eSink`; the unittests then poke `escapeSequence` with their own cursor.
     */
    static forMock(errorSink: ErrorSink): Lexer {
        assert(errorSink);
        // Construct via the primary ctor over an empty (NUL-only) buffer, then null out the table
        // entries the mock never uses. The D mock ctor sets ONLY `eSink`; replicate by using an
        // empty source so no token state is meaningful.
        const lex = new Lexer(null, ds("\0"), 0, 0, false, false, errorSink, null);
        return lex;
    }

    /**************************************
     * Reset lexer to lex #define's (lexer.d:221).
     */
    resetDefineLines(slice: DString): void {
        this.buf = slice;
        this.base = 0; // slice.ptr
        this.end = slice.length; // base + slice.length
        assert(this.byteAt(this.end) === 0); // *end == 0
        this.p = this.base;
        this.line = this.p;
        this.tokenizeNewlines = true;
        this.inTokenStringConstant = 0;
        this.lastDocLine = 0;

        this.baseLoc = newBaseLoc(ds("#defines"), slice);
        this.scanloc = this.baseLoc.getLoc(0);
    }

    /**********************************
     * Set up for next #define line (lexer.d:240). p should be at start of next line.
     */
    nextDefineLine(): void {
        this.tokenizeNewlines = true;
    }

    /***************
     * Range interface (lexer.d:245).
     */

    /// (lexer.d:249) `@property empty` — `front() == TOK.endOfFile`.
    empty(): boolean {
        return this.front() === TOK.endOfFile;
    }

    /// (lexer.d:254) `@property front` — the current token's value.
    front(): TOK {
        return this.token.value;
    }

    /// (lexer.d:259) `popFront` — advance.
    popFront(): void {
        this.nextToken();
    }

    /// Returns: a newly allocated `Token` (lexer.d:265, `allocateToken`).
    allocateToken(): Token {
        if (this.tokenFreelist) {
            const t = this.tokenFreelist;
            this.tokenFreelist = t.next;
            t.next = null;
            return t;
        }
        return new Token();
    }

    /// Frees the given token by returning it to the freelist (lexer.d:278, `releaseToken`).
    private releaseToken(token: Token): void {
        if (mem.isGCEnabled()) {
            copyTokenInto(token, new Token()); // *token = Token.init;
        }
        token.next = this.tokenFreelist;
        this.tokenFreelist = token;
    }

    /// (lexer.d:286) `nextToken`.
    nextToken(): TOK {
        this.prevloc = this.token.loc;
        if (this.token.next) {
            const t = this.token.next;
            copyTokenInto(this.token, t); // memcpy(&token, t, Token.sizeof) — whole-struct copy
            this.releaseToken(t);
        } else {
            this.scan(this.token);
        }
        return this.token.value;
    }

    /***********************
     * Look ahead at next token's value (lexer.d:306, `peekNext`).
     */
    peekNext(): TOK {
        return this.peek(this.token).value;
    }

    /***********************
     * Look 2 tokens ahead at value (lexer.d:314, `peekNext2`).
     */
    peekNext2(): TOK {
        const t = this.peek(this.token);
        return this.peek(t).value;
    }

    /****************************
     * Turn next token in buffer into a token (lexer.d:325, `scan`).
     * Params:
     *  t = the token to set the resulting Token to
     */
    scan(t: Token): void {
        const lastLine = this.linnum;
        let startLoc: Loc = new Loc();
        t.blockComment = null;
        t.lineComment = null;

        while (true) {
            let startsUCN = false;
            t.ptr = this.buf.subarray(this.p); // t.ptr = p
            t.loc = this.loc();
            switch (this.byteAt(this.p)) {
                case 0:
                case 0x1a:
                    t.value = TOK.endOfFile; // end of file
                    // Intentionally not advancing `p`, so subsequent calls keep returning endOfFile.
                    return;
                case 0x20 /* ' ' */: {
                    // Skip 4 spaces at a time after aligning to a 4-byte boundary. The pointer-
                    // alignment fast path (`(cast(size_t)p) % uint.sizeof` + the `0x20202020` word
                    // read) is a raw-memory optimization with no JS analogue; the OBSERVABLE effect
                    // is "skip a run of spaces" — reproduced by the plain space-skip loop. (The fast
                    // path produces no different tokens; only speed. 00 §0.1 reasoning applies to the
                    // micro-optimization, not the module.)
                    while (this.byteAt(this.p) === 0x20) {
                        this.p++;
                    }
                    // resolved: version(DMDLIB) whitespaceToken -> OFF (dropped)
                    continue; // skip white space
                }
                case 0x09 /* '\t' */:
                case 0x0b /* '\v' */:
                case 0x0c /* '\f' */:
                    this.p++;
                    // resolved: version(DMDLIB) whitespaceToken -> OFF (dropped)
                    continue; // skip white space
                case 0x0d /* '\r' */:
                    this.p++;
                    if (this.byteAt(this.p) !== 0x0a /* '\n' */) {
                        // if CR stands by itself
                        this.endOfLine();
                        if (this.tokenizeNewlines) {
                            t.value = TOK.endOfLine;
                            this.tokenizeNewlines = false;
                            return;
                        }
                    }
                    // resolved: version(DMDLIB) whitespaceToken -> OFF (dropped)
                    continue; // skip white space
                case 0x0a /* '\n' */:
                    this.p++;
                    this.endOfLine();
                    if (this.tokenizeNewlines) {
                        t.value = TOK.endOfLine;
                        this.tokenizeNewlines = false;
                        return;
                    }
                    // resolved: version(DMDLIB) whitespaceToken -> OFF (dropped)
                    continue; // skip white space

                case 0x5c /* '\\' */:
                    if (this.Ccompile) {
                        if (this.byteAt(this.p + 1) === 0x0d || this.byteAt(this.p + 1) === 0x0a) {
                            this.p++; // ignore \ followed by new line, like VC does
                            continue;
                        } else if (this.byteAt(this.p + 1) === 0x75 /* 'u' */) {
                            // Universal Character Name (C) 2 byte: \uXXXX
                            startsUCN = true;
                            if (!this.scanIdentifier(t, startsUCN)) {
                                if (this.scanDefault(t)) continue; // goto default: its `continue` resumes the scan loop
                                return;
                            }
                            this.finishIdentifier(t);
                            return;
                        } else if (this.byteAt(this.p + 1) === 0x55 /* 'U' */) {
                            // Universal Character Name (C) 4 byte: \UXXXXXXXX
                            startsUCN = true;
                            if (!this.scanIdentifier(t, startsUCN)) {
                                if (this.scanDefault(t)) continue; // goto default: its `continue` resumes the scan loop
                                return;
                            }
                            this.finishIdentifier(t);
                            return;
                        }
                    }
                    // goto default;
                    if (this.scanDefault(t)) continue; // goto default: its `continue` resumes the scan loop
                    return;

                case 0x30 /* '0' */:
                    if (!isZeroSecond(this.byteAt(this.p + 1))) {
                        // if numeric literal does not continue
                        ++this.p;
                        t.unsvalue = 0n;
                        t.value = TOK.int32Literal;
                        return;
                    }
                    t.value = this.number(t); // goto Lnumber
                    return;

                case 0x31 /* '1' */:
                case 0x32:
                case 0x33:
                case 0x34:
                case 0x35:
                case 0x36:
                case 0x37:
                case 0x38:
                case 0x39 /* '9' */:
                    if (!isDigitSecond(this.byteAt(this.p + 1))) {
                        // if numeric literal does not continue
                        t.unsvalue = BigInt(this.byteAt(this.p) - 0x30); // *p - '0'
                        ++this.p;
                        t.value = TOK.int32Literal;
                        return;
                    }
                    t.value = this.number(t); // Lnumber
                    return;

                case 0x27 /* '\'' */:
                    if (issinglechar(this.byteAt(this.p + 1)) && this.byteAt(this.p + 2) === 0x27) {
                        t.unsvalue = BigInt(this.byteAt(this.p + 1)); // simple one character literal
                        t.value = TOK.charLiteral;
                        this.p += 3;
                    } else if (this.Ccompile) {
                        this.clexerCharConstant(t, 0);
                    } else {
                        t.value = this.charConstant(t);
                    }
                    return;

                case 0x75 /* 'u' */:
                case 0x55 /* 'U' */:
                case 0x4c /* 'L' */: {
                    if (!this.Ccompile) {
                        if (!this.scanIdentifier(t, startsUCN)) {
                            if (this.scanDefault(t)) continue; // goto default: its `continue` resumes the scan loop
                            return;
                        }
                        this.finishIdentifier(t);
                        return;
                    }
                    if (this.byteAt(this.p + 1) === 0x27 /* '\'' */) {
                        // C wide character constant
                        let c = this.byteAt(this.p);
                        if (c === 0x4c /* 'L' */) {
                            // convert L to u or U
                            c = this.wchar_tsize === 4 ? 0x75 /* 'u' */ : 0x55 /* 'U' */;
                        }
                        ++this.p;
                        this.clexerCharConstant(t, c);
                        return;
                    }
                    if (this.byteAt(this.p + 1) === 0x22 /* '"' */) {
                        // C wide string literal
                        const c = this.byteAt(this.p);
                        ++this.p;
                        this.escapeStringConstant(t);
                        t.postfix =
                            c === 0x4c /* 'L' */
                                ? this.wchar_tsize === 2
                                    ? 0x77 /* 'w' */
                                    : 0x64 /* 'd' */
                                : c === 0x75 /* 'u' */
                                  ? 0x77 /* 'w' */
                                  : 0x64 /* 'd' */;
                        return;
                    }
                    if (this.byteAt(this.p + 1) === 0x38 /* '8' */ && this.byteAt(this.p + 2) === 0x22 /* '"' */) {
                        // C UTF-8 string literal
                        this.p += 2;
                        this.escapeStringConstant(t);
                        return;
                    }
                    if (!this.scanIdentifier(t, startsUCN)) {
                        if (this.scanDefault(t)) continue; // goto default: its `continue` resumes the scan loop
                        return;
                    }
                    this.finishIdentifier(t);
                    return;
                }

                case 0x72 /* 'r' */:
                    if (this.Ccompile || this.byteAt(this.p + 1) !== 0x22 /* '"' */) {
                        if (!this.scanIdentifier(t, startsUCN)) {
                            if (this.scanDefault(t)) continue; // goto default: its `continue` resumes the scan loop
                            return;
                        }
                        this.finishIdentifier(t);
                        return;
                    }
                    this.p++;
                    // goto case '`';
                    this.wysiwygStringConstant(t);
                    return;
                case 0x60 /* '`' */:
                    if (this.Ccompile) {
                        if (this.scanDefault(t)) continue; // goto default: its `continue` resumes the scan loop
                        return;
                    }
                    this.wysiwygStringConstant(t);
                    return;
                case 0x78 /* 'x' */:
                    if (this.byteAt(this.p + 1) !== 0x22 /* '"' */) {
                        if (!this.scanIdentifier(t, startsUCN)) {
                            if (this.scanDefault(t)) continue; // goto default: its `continue` resumes the scan loop
                            return;
                        }
                        this.finishIdentifier(t);
                        return;
                    }
                    this.p++;
                    t.value = this.hexStringConstant(t);
                    return;
                case 0x71 /* 'q' */:
                    if (this.Ccompile) {
                        if (!this.scanIdentifier(t, startsUCN)) {
                            if (this.scanDefault(t)) continue; // goto default: its `continue` resumes the scan loop
                            return;
                        }
                        this.finishIdentifier(t);
                        return;
                    }
                    if (this.byteAt(this.p + 1) === 0x22 /* '"' */) {
                        this.p++;
                        this.delimitedStringConstant(t);
                        return;
                    }
                    if (this.byteAt(this.p + 1) === 0x7b /* '{' */) {
                        this.p++;
                        this.tokenStringConstant(t);
                        return;
                    }
                    if (!this.scanIdentifier(t, startsUCN)) {
                        if (this.scanDefault(t)) continue; // goto default: its `continue` resumes the scan loop
                        return;
                    }
                    this.finishIdentifier(t);
                    return;
                case 0x69 /* 'i' */:
                    if (this.Ccompile) {
                        if (!this.scanIdentifier(t, startsUCN)) {
                            if (this.scanDefault(t)) continue; // goto default: its `continue` resumes the scan loop
                            return;
                        }
                        this.finishIdentifier(t);
                        return;
                    }
                    if (this.byteAt(this.p + 1) === 0x22 /* '"' */) {
                        this.p++; // skip the i
                        this.escapeStringConstant(t, true);
                        return;
                    }
                    if (this.byteAt(this.p + 1) === 0x60 /* '`' */) {
                        this.p++; // skip the i
                        this.wysiwygStringConstant(t, true);
                        return;
                    }
                    if (this.byteAt(this.p + 1) === 0x71 /* 'q' */ && this.byteAt(this.p + 2) === 0x7b /* '{' */) {
                        this.p += 2; // skip the i and q
                        this.tokenStringConstant(t, true);
                        return;
                    }
                    if (!this.scanIdentifier(t, startsUCN)) {
                        if (this.scanDefault(t)) continue; // goto default: its `continue` resumes the scan loop
                        return;
                    }
                    this.finishIdentifier(t);
                    return;
                case 0x22 /* '"' */:
                    this.escapeStringConstant(t);
                    return;

                // case 'a'..'z' / 'A'..'Z' / '_' — identifier start (the long `case_ident` block).
                // (The few letters that have their own case above — u U L r x q i — fall through to
                // their handlers; the remaining letters land here.)
                case 0x61: case 0x62: case 0x63: case 0x64: case 0x65: case 0x66: case 0x67: case 0x68:
                /* i */ case 0x6a: case 0x6b: case 0x6c: case 0x6d: case 0x6e: case 0x6f: case 0x70:
                /* q r */ case 0x73: case 0x74: /* u */ case 0x76: case 0x77: /* x */ case 0x79: case 0x7a:
                case 0x41: case 0x42: case 0x43: case 0x44: case 0x45: case 0x46: case 0x47: case 0x48:
                case 0x49: case 0x4a: case 0x4b: /* L */ case 0x4d: case 0x4e: case 0x4f: case 0x50:
                case 0x51: case 0x52: case 0x53: case 0x54: /* U */ case 0x56: case 0x57: case 0x58:
                case 0x59: case 0x5a:
                case 0x5f /* '_' */: {
                    if (!this.scanIdentifier(t, startsUCN)) {
                        if (this.scanDefault(t)) continue; // goto default: its `continue` resumes the scan loop
                        return;
                    }
                    this.finishIdentifier(t);
                    return;
                }

                case 0x2f /* '/' */: {
                    const res = this.scanSlash(t, lastLine, startLoc);
                    if (res.returned) {
                        return;
                    }
                    startLoc = res.startLoc;
                    continue;
                }
                case 0x2e /* '.' */:
                    this.p++;
                    if (isdigit(this.byteAt(this.p))) {
                        // Note that we don't allow ._1 and ._ as valid floating point numbers.
                        this.p--;
                        t.value = this.inreal(t);
                    } else if (this.byteAt(this.p) === 0x2e /* '.' */) {
                        if (this.byteAt(this.p + 1) === 0x2e) {
                            this.p += 2;
                            t.value = TOK.dotDotDot;
                        } else {
                            this.p++;
                            t.value = TOK.slice;
                        }
                    } else {
                        t.value = TOK.dot;
                    }
                    return;
                case 0x26 /* '&' */:
                    this.p++;
                    if (this.byteAt(this.p) === 0x3d /* '=' */) {
                        this.p++;
                        t.value = TOK.andAssign;
                    } else if (this.byteAt(this.p) === 0x26 /* '&' */) {
                        this.p++;
                        t.value = TOK.andAnd;
                    } else {
                        t.value = TOK.and;
                    }
                    return;
                case 0x7c /* '|' */:
                    this.p++;
                    if (this.byteAt(this.p) === 0x3d) {
                        this.p++;
                        t.value = TOK.orAssign;
                    } else if (this.byteAt(this.p) === 0x7c /* '|' */) {
                        this.p++;
                        t.value = TOK.orOr;
                    } else {
                        t.value = TOK.or;
                    }
                    return;
                case 0x2d /* '-' */:
                    this.p++;
                    if (this.byteAt(this.p) === 0x3d) {
                        this.p++;
                        t.value = TOK.minAssign;
                    } else if (this.byteAt(this.p) === 0x2d /* '-' */) {
                        this.p++;
                        t.value = TOK.minusMinus;
                    } else if (this.byteAt(this.p) === 0x3e /* '>' */) {
                        ++this.p;
                        t.value = TOK.arrow;
                    } else {
                        t.value = TOK.min;
                    }
                    return;
                case 0x2b /* '+' */:
                    this.p++;
                    if (this.byteAt(this.p) === 0x3d) {
                        this.p++;
                        t.value = TOK.addAssign;
                    } else if (this.byteAt(this.p) === 0x2b /* '+' */) {
                        this.p++;
                        t.value = TOK.plusPlus;
                    } else {
                        t.value = TOK.add;
                    }
                    return;
                case 0x3c /* '<' */:
                    this.p++;
                    if (this.byteAt(this.p) === 0x3d /* '=' */) {
                        this.p++;
                        t.value = TOK.lessOrEqual; // <=
                    } else if (this.byteAt(this.p) === 0x3c /* '<' */) {
                        this.p++;
                        if (this.byteAt(this.p) === 0x3d) {
                            this.p++;
                            t.value = TOK.leftShiftAssign; // <<=
                        } else {
                            t.value = TOK.leftShift; // <<
                        }
                    } else if (this.byteAt(this.p) === 0x3a /* ':' */ && this.Ccompile) {
                        ++this.p;
                        t.value = TOK.leftBracket; // <:
                    } else if (this.byteAt(this.p) === 0x25 /* '%' */ && this.Ccompile) {
                        ++this.p;
                        t.value = TOK.leftCurly; // <%
                    } else {
                        t.value = TOK.lessThan; // <
                    }
                    return;
                case 0x3e /* '>' */:
                    this.p++;
                    if (this.byteAt(this.p) === 0x3d /* '=' */) {
                        this.p++;
                        t.value = TOK.greaterOrEqual; // >=
                    } else if (this.byteAt(this.p) === 0x3e /* '>' */) {
                        this.p++;
                        if (this.byteAt(this.p) === 0x3d) {
                            this.p++;
                            t.value = TOK.rightShiftAssign; // >>=
                        } else if (this.byteAt(this.p) === 0x3e /* '>' */) {
                            this.p++;
                            if (this.byteAt(this.p) === 0x3d) {
                                this.p++;
                                t.value = TOK.unsignedRightShiftAssign; // >>>=
                            } else {
                                t.value = TOK.unsignedRightShift; // >>>
                            }
                        } else {
                            t.value = TOK.rightShift; // >>
                        }
                    } else {
                        t.value = TOK.greaterThan; // >
                    }
                    return;
                case 0x21 /* '!' */:
                    this.p++;
                    if (this.byteAt(this.p) === 0x3d /* '=' */) {
                        this.p++;
                        t.value = TOK.notEqual; // !=
                    } else {
                        t.value = TOK.not; // !
                    }
                    return;
                case 0x3d /* '=' */:
                    this.p++;
                    if (this.byteAt(this.p) === 0x3d /* '=' */) {
                        this.p++;
                        t.value = TOK.equal; // ==
                    } else if (this.byteAt(this.p) === 0x3e /* '>' */) {
                        this.p++;
                        t.value = TOK.goesTo; // =>
                    } else {
                        t.value = TOK.assign; // =
                    }
                    return;
                case 0x7e /* '~' */:
                    this.p++;
                    if (this.byteAt(this.p) === 0x3d /* '=' */) {
                        this.p++;
                        t.value = TOK.concatenateAssign; // ~=
                    } else {
                        t.value = TOK.tilde; // ~
                    }
                    return;
                case 0x5e /* '^' */:
                    this.p++;
                    if (this.byteAt(this.p) === 0x5e /* '^' */) {
                        this.p++;
                        if (this.byteAt(this.p) === 0x3d) {
                            this.p++;
                            t.value = TOK.powAssign; // ^^=
                        } else {
                            t.value = TOK.pow; // ^^
                        }
                    } else if (this.byteAt(this.p) === 0x3d /* '=' */) {
                        this.p++;
                        t.value = TOK.xorAssign; // ^=
                    } else {
                        t.value = TOK.xor; // ^
                    }
                    return;
                case 0x28 /* '(' */:
                    this.p++;
                    t.value = TOK.leftParenthesis;
                    return;
                case 0x29 /* ')' */:
                    this.p++;
                    t.value = TOK.rightParenthesis;
                    return;
                case 0x5b /* '[' */:
                    this.p++;
                    t.value = TOK.leftBracket;
                    return;
                case 0x5d /* ']' */:
                    this.p++;
                    t.value = TOK.rightBracket;
                    return;
                case 0x7b /* '{' */:
                    this.p++;
                    t.value = TOK.leftCurly;
                    return;
                case 0x7d /* '}' */:
                    this.p++;
                    t.value = TOK.rightCurly;
                    return;
                case 0x3f /* '?' */:
                    this.p++;
                    t.value = TOK.question;
                    return;
                case 0x2c /* ',' */:
                    this.p++;
                    t.value = TOK.comma;
                    return;
                case 0x3b /* ';' */:
                    this.p++;
                    t.value = TOK.semicolon;
                    return;
                case 0x3a /* ':' */:
                    this.p++;
                    if (this.byteAt(this.p) === 0x3a /* ':' */) {
                        ++this.p;
                        t.value = TOK.colonColon;
                    } else if (this.byteAt(this.p) === 0x3e /* '>' */ && this.Ccompile) {
                        ++this.p;
                        t.value = TOK.rightBracket;
                    } else {
                        t.value = TOK.colon;
                    }
                    return;
                case 0x24 /* '$' */:
                    this.p++;
                    t.value = TOK.dollar;
                    return;
                case 0x40 /* '@' */:
                    this.p++;
                    t.value = TOK.at;
                    return;
                case 0x2a /* '*' */:
                    this.p++;
                    if (this.byteAt(this.p) === 0x3d /* '=' */) {
                        this.p++;
                        t.value = TOK.mulAssign;
                    } else {
                        t.value = TOK.mul;
                    }
                    return;
                case 0x25 /* '%' */:
                    this.p++;
                    if (this.byteAt(this.p) === 0x3d /* '=' */) {
                        this.p++;
                        t.value = TOK.modAssign;
                    } else if (this.byteAt(this.p) === 0x3e /* '>' */ && this.Ccompile) {
                        ++this.p;
                        t.value = TOK.rightCurly;
                    } else if (this.byteAt(this.p) === 0x3a /* ':' */ && this.Ccompile) {
                        // goto case '#';  // %: means #
                        if (this.scanPound(t)) {
                            continue;
                        }
                        return;
                    } else {
                        t.value = TOK.mod;
                    }
                    return;
                case 0x23 /* '#' */: {
                    if (this.scanPound(t)) {
                        continue;
                    }
                    return;
                }
                default: {
                    if (this.scanDefault(t)) {
                        continue;
                    }
                    return;
                }
            }
        }
    }

    /**
     * The `#`-case body (lexer.d:1182). Returns true if the special token sequence was handled and
     * the scan loop should `continue`; false if a TOK.pound token was produced (caller returns).
     * Extracted so the `%:` (Ccompile) `goto case '#';` can re-enter it (06 §3.6).
     */
    private scanPound(t: Token): boolean {
        // Special token sequences are terminated by newlines, and should not be skipped over.
        this.tokenizeNewlines = true;
        this.p++;
        if (this.parseSpecialTokenSequence()) {
            return true; // continue
        }
        t.value = TOK.pound;
        return false;
    }

    /**
     * The `default:` body of `scan` (lexer.d:1194). Returns true if the loop should `continue`
     * (whitespace-like line separator skipped, or an error recovered), false if it set `t` to an
     * identifier / produced a token and the caller should `return`. The `goto case_ident;` inside
     * (for a UTF identifier start) is realized by calling `scanIdentifier`/`finishIdentifier`.
     */
    private scanDefault(t: Token): boolean {
        let c: number = this.byteAt(this.p);
        if (c & 0x80) {
            c = this.decodeUTF();

            // Check for start of an identifier
            if (this.charLookup.isStart(c)) {
                this.p++;
                // goto case_ident;
                if (!this.scanIdentifier(t, false)) {
                    // a UTF start that fails identifier lexing falls to default again — but the D
                    // `goto default;` here would re-enter default. In practice scanIdentifier over a
                    // valid start succeeds; on the rare failure we report the invalid-token error.
                    this.reportInvalidToken(t, c);
                    this.p++;
                    return true;
                }
                this.finishIdentifier(t);
                return false;
            }
            if (c === PS || c === LS) {
                this.endOfLine();
                this.p++;
                if (this.tokenizeNewlines) {
                    t.value = TOK.endOfLine;
                    this.tokenizeNewlines = false;
                    return false;
                }
                return true; // continue
            }
        }
        this.reportInvalidToken(t, c);
        this.p++;
        return true; // continue
    }

    /// The `error(...)` arm of `scan`'s default case (lexer.d:1220-1223).
    private reportInvalidToken(t: Token, c: number): void {
        if (c < 0x80 && isprint(c)) {
            this.errorLoc(t.loc, ds("character '%c' is not a valid token"), c);
        } else {
            this.errorLoc(t.loc, ds("character 0x%02x is not a valid token"), c);
        }
    }

    /**
     * The `/`-case body (lexer.d:680). Comments (line `//`, block `/* *​/`, nesting `/+ +/`) and the
     * `/` / `/=` operators. Returns `{ returned, startLoc }`: `returned=true` -> the caller should
     * `return` (a token was set); `returned=false` -> the caller `continue`s the scan loop (a
     * comment was skipped), carrying back the possibly-updated `startLoc` for doc-comment bookkeeping.
     */
    private scanSlash(t: Token, lastLine: number, startLoc: Loc): { returned: boolean; startLoc: Loc } {
        this.p++;
        switch (this.byteAt(this.p)) {
            case 0x3d /* '=' */:
                this.p++;
                t.value = TOK.divAssign;
                return { returned: true, startLoc };
            case 0x2a /* '*' */: {
                this.p++;
                startLoc = this.loc();
                while (true) {
                    let broke = false;
                    while (true) {
                        const c = this.byteAt(this.p);
                        if (c === 0x2f /* '/' */) {
                            broke = true;
                            break;
                        } else if (c === 0x0a /* '\n' */) {
                            this.endOfLine();
                            this.p++;
                            continue;
                        } else if (c === 0x0d /* '\r' */) {
                            this.p++;
                            if (this.byteAt(this.p) !== 0x0a) {
                                this.endOfLine();
                            }
                            continue;
                        } else if (c === 0 || c === 0x1a) {
                            this.errorLoc(t.loc, ds("unterminated /* */ comment"));
                            t.loc = this.loc();
                            t.value = TOK.endOfFile;
                            return { returned: true, startLoc };
                        } else {
                            if (c & 0x80) {
                                const u = this.decodeUTF();
                                if (u === PS || u === LS) {
                                    this.endOfLine();
                                }
                            }
                            this.p++;
                            continue;
                        }
                    }
                    void broke;
                    this.p++;
                    if (this.byteAt(this.p - 2) === 0x2a /* '*' */ && this.p - 3 !== this.tokenPtrOffset(t)) {
                        break;
                    }
                }
                if (this.commentToken) {
                    t.loc = startLoc;
                    t.value = TOK.comment;
                    return { returned: true, startLoc };
                }
                if (this.doDocComment && this.tokenPtrByte(t, 2) === 0x2a /* '*' */ && this.p - 4 !== this.tokenPtrOffset(t)) {
                    // if /** but not /**/
                    this.getDocComment(t, lastLine === startLoc.linnum() ? 1 : 0, startLoc.linnum() - this.lastDocLine > 1);
                    this.lastDocLine = this.linnum;
                }
                return { returned: false, startLoc };
            }
            case 0x2f /* '/' */: {
                // do // style comments
                startLoc = this.loc();
                while (true) {
                    let broke = false;
                    const c = this.byteAt(++this.p);
                    if (c === 0x0a /* '\n' */) {
                        broke = true;
                    } else if (c === 0x0d /* '\r' */) {
                        if (this.byteAt(this.p + 1) === 0x0a) {
                            this.p++;
                        }
                        broke = true;
                    } else if (c === 0 || c === 0x1a) {
                        if (this.commentToken) {
                            this.p = this.end;
                            t.loc = startLoc;
                            t.value = TOK.comment;
                            return { returned: true, startLoc };
                        }
                        if (this.doDocComment && this.tokenPtrByte(t, 2) === 0x2f /* '/' */) {
                            this.getDocComment(
                                t,
                                lastLine === startLoc.linnum() ? 1 : 0,
                                startLoc.linnum() - this.lastDocLine > 1,
                            );
                            this.lastDocLine = this.linnum;
                        }
                        t.loc = this.loc();
                        t.value = TOK.endOfFile;
                        return { returned: true, startLoc };
                    } else {
                        if (c & 0x80) {
                            const u = this.decodeUTF();
                            if (u === PS || u === LS) {
                                broke = true;
                            }
                        }
                        if (!broke) {
                            continue;
                        }
                    }
                    void broke;
                    break;
                }
                if (this.commentToken) {
                    // resolved: version(DMDLIB) {} else { p++; endOfLine(); } -> the else branch
                    this.p++;
                    this.endOfLine();
                    t.loc = startLoc;
                    t.value = TOK.comment;
                    return { returned: true, startLoc };
                }
                if (this.doDocComment && this.tokenPtrByte(t, 2) === 0x2f /* '/' */) {
                    this.getDocComment(
                        t,
                        lastLine === startLoc.linnum() ? 1 : 0,
                        startLoc.linnum() - this.lastDocLine > 1,
                    );
                    this.lastDocLine = this.linnum;
                }
                this.p++;
                this.endOfLine();
                return { returned: false, startLoc };
            }
            case 0x2b /* '+' */:
                if (!this.Ccompile) {
                    let nest: number;
                    startLoc = this.loc();
                    this.p++;
                    nest = 1;
                    while (true) {
                        let broke = false;
                        const c = this.byteAt(this.p);
                        if (c === 0x2f /* '/' */) {
                            this.p++;
                            if (this.byteAt(this.p) === 0x2b /* '+' */) {
                                this.p++;
                                nest++;
                            }
                            continue;
                        } else if (c === 0x2b /* '+' */) {
                            this.p++;
                            if (this.byteAt(this.p) === 0x2f /* '/' */) {
                                this.p++;
                                if (--nest === 0) {
                                    broke = true;
                                }
                            }
                            if (!broke) {
                                continue;
                            }
                        } else if (c === 0x0d /* '\r' */) {
                            this.p++;
                            if (this.byteAt(this.p) !== 0x0a) {
                                this.endOfLine();
                            }
                            continue;
                        } else if (c === 0x0a /* '\n' */) {
                            this.endOfLine();
                            this.p++;
                            continue;
                        } else if (c === 0 || c === 0x1a) {
                            this.errorLoc(t.loc, ds("unterminated /+ +/ comment"));
                            t.loc = this.loc();
                            t.value = TOK.endOfFile;
                            return { returned: true, startLoc };
                        } else {
                            if (c & 0x80) {
                                const u = this.decodeUTF();
                                if (u === PS || u === LS) {
                                    this.endOfLine();
                                }
                            }
                            this.p++;
                            continue;
                        }
                        void broke;
                        break;
                    }
                    if (this.commentToken) {
                        t.loc = startLoc;
                        t.value = TOK.comment;
                        return { returned: true, startLoc };
                    }
                    if (this.doDocComment && this.tokenPtrByte(t, 2) === 0x2b /* '+' */ && this.p - 4 !== this.tokenPtrOffset(t)) {
                        // if /++ but not /++/
                        this.getDocComment(
                            t,
                            lastLine === startLoc.linnum() ? 1 : 0,
                            startLoc.linnum() - this.lastDocLine > 1,
                        );
                        this.lastDocLine = this.linnum;
                    }
                    return { returned: false, startLoc };
                }
                break;
            default:
                break;
        }
        t.value = TOK.div;
        return { returned: true, startLoc };
    }

    /// The byte offset of `t.ptr` within `buf` (D `t.ptr` as a position). `t.ptr` is a subarray view
    /// of `buf`, so its start offset is `buf.length - t.ptr.length`.
    private tokenPtrOffset(t: Token): number {
        return this.buf.length - (t.ptr ? t.ptr.length : 0);
    }

    /// `t.ptr[k]` — the byte `k` past the token start.
    private tokenPtrByte(t: Token, k: number): number {
        return t.ptr ? (t.ptr[k] === undefined ? 0 : t.ptr[k]) : 0;
    }

    /// The keyword-filtering tail of the identifier case (lexer.d:632-678): C/D keyword filtering
    /// and the `_`-special-identifier (`__DATE__` etc.) handling. Runs after `scanIdentifier`
    /// succeeds. Named `finishIdentifier`; in D it is the fall-through after `case_ident`.
    private finishIdentifier(t: Token): void {
        this.anyToken = true;

        // Different keywords for C and D
        if (this.Ccompile) {
            if (t.value !== TOK.identifier) {
                t.value = Ckeywords[t.value]; // filter out D keywords
            }
        } else if (t.value >= FirstCKeyword) {
            t.value = TOK.identifier; // filter out C keywords
        } else if (this.tokenPtrByte(t, 0) === 0x5f /* '_' */) {
            // if special identifier token
            const toToken = (s: DString): void => {
                t.value = TOK.string_;
                t.ustring = s;
                t.len = toUint32(s.length);
                t.postfix = 0;
            };

            if (K.on && (t.ident === Id.DATE || t.ident === Id.TIME || t.ident === Id.TIMESTAMP))
                keepClock();   // the kept-module engine: the token is this compile's clock
            if (t.ident === Id.DATE) {
                toToken(this.compileEnv.date);
            } else if (t.ident === Id.TIME) {
                toToken(this.compileEnv.time);
            } else if (t.ident === Id.VENDOR) {
                toToken(this.compileEnv.vendor);
            } else if (t.ident === Id.TIMESTAMP) {
                toToken(this.compileEnv.timestamp);
            } else if (t.ident === Id.VERSIONX) {
                t.value = TOK.int64Literal;
                t.unsvalue = BigInt(this.compileEnv.versionNumber);
            } else if (t.ident === Id.EOFX) {
                t.value = TOK.endOfFile;
                // Advance scanner to end of file
                while (!(this.byteAt(this.p) === 0 || this.byteAt(this.p) === 0x1a)) {
                    this.p++;
                }
            }
        }
    }

    /// (lexer.d:1232) `peek` — scan one token ahead of `ct`, caching it in `ct.next`.
    peek(ct: Token): Token {
        let t: Token;
        if (ct.next) {
            t = ct.next;
        } else {
            t = this.allocateToken();
            this.scan(t);
            ct.next = t;
        }
        return t;
    }

    /*********************************
     * tk is on the opening `(`. Look ahead and return token past the closing `)` (lexer.d:1250).
     */
    peekPastParen(tk: Token): Token {
        let parens = 1;
        let curlynest = 0;
        while (true) {
            tk = this.peek(tk);
            switch (tk.value) {
                case TOK.leftParenthesis:
                    parens++;
                    continue;
                case TOK.rightParenthesis:
                    --parens;
                    if (parens) {
                        continue;
                    }
                    tk = this.peek(tk);
                    break;
                case TOK.leftCurly:
                    curlynest++;
                    continue;
                case TOK.rightCurly:
                    if (--curlynest >= 0) {
                        continue;
                    }
                    break;
                case TOK.semicolon:
                    if (curlynest) {
                        continue;
                    }
                    break;
                case TOK.endOfFile:
                    break;
                default:
                    continue;
            }
            return tk;
        }
    }

    /*******************************************
     * Parse escape sequence (lexer.d:1293). The 0-arg form uses the lexer's own `p` and
     * `token.loc`; collapses into the static-style form below via a cursor box.
     */
    private escapeSequenceCurrent(c2: { value: number }): number {
        const seq = { buf: this.buf, p: this.p };
        const r = this.escapeSequence(this.token.loc, seq, this.Ccompile, c2);
        this.p = seq.p; // ref const(char)* sequence -> write back the advanced cursor
        return r;
    }

    /********
     * Parse the given string literal escape sequence into a single character (lexer.d:1311).
     * D https://dlang.org/spec/lex.html#escape_sequences ; C11 6.4.4.4
     *
     * `ref const(char)* sequence` is the cursor box `{ buf, p }` (advanced in place — the
     * `scope(exit) sequence = p` writes the local cursor back). `out dchar c2` is the box `{ value }`
     * (reset to `dchar.init` == 0 on entry, 03 §3.3 / 04 §7). Returns the decoded character.
     */
    escapeSequence(loc: Loc, sequence: { buf: DString; p: number }, Ccompile: boolean, c2: { value: number }): number {
        c2.value = 0; // out dchar c2 — reset on entry (dchar.init == 0)
        const src = sequence.buf;
        const byteAt = (i: number): number => {
            const b = src[i];
            return b === undefined ? 0 : b;
        };
        // const(char)* p = sequence; scope(exit) sequence = p; — work on a local cursor, write back.
        let p = sequence.p;
        try {
            let c = byteAt(p);
            let ndigits = 0;
            switch (c) {
                case 0x27 /* '\'' */:
                case 0x22 /* '"' */:
                case 0x3f /* '?' */:
                case 0x5c /* '\\' */:
                    // Lconsume:
                    p++;
                    break;
                case 0x61 /* 'a' */:
                    c = 7;
                    p++;
                    break;
                case 0x62 /* 'b' */:
                    c = 8;
                    p++;
                    break;
                case 0x66 /* 'f' */:
                    c = 12;
                    p++;
                    break;
                case 0x6e /* 'n' */:
                    c = 10;
                    p++;
                    break;
                case 0x72 /* 'r' */:
                    c = 13;
                    p++;
                    break;
                case 0x74 /* 't' */:
                    c = 9;
                    p++;
                    break;
                case 0x76 /* 'v' */:
                    c = 11;
                    p++;
                    break;
                case 0x75 /* 'u' */:
                    ndigits = 4;
                    p = this.escapeHex(loc, p, ndigits, Ccompile, (v) => (c = v), byteAt);
                    return c;
                case 0x55 /* 'U' */:
                    ndigits = 8;
                    p = this.escapeHex(loc, p, ndigits, Ccompile, (v) => (c = v), byteAt);
                    return c;
                case 0x78 /* 'x' */:
                    ndigits = 2;
                    p = this.escapeHex(loc, p, ndigits, Ccompile, (v) => (c = v), byteAt);
                    return c;
                case 0x26 /* '&' */: {
                    if (Ccompile) {
                        // goto default;
                        p = this.escapeDefault(loc, p, c, (v) => (c = v), byteAt);
                        return c;
                    }
                    // named character entity
                    const idstart = ++p;
                    for (; ; p++) {
                        if (byteAt(p) === 0x3b /* ';' */) {
                            const entity = HtmlNamedEntity(src.subarray(idstart, p));
                            c = entity[0];
                            if (entity[0] === 0 && entity[1] === 0) {
                                // entity == entity.init  (init is [0,0])
                                this.errorLoc(
                                    loc,
                                    ds("unnamed character entity &%.*s;"),
                                    p - idstart,
                                    src.subarray(idstart),
                                );
                                c = 0x3f; // '?'
                            }
                            if (entity[1] !== 0) {
                                // entity[1] != entity.init[1]
                                c2.value = entity[1];
                            }
                            p++;
                            break;
                        } else {
                            if (isAlphaASCII(byteAt(p)) || (p !== idstart && isdigit(byteAt(p)))) {
                                continue;
                            }
                            this.errorLoc(
                                loc,
                                ds("unterminated named entity &%.*s;"),
                                p - idstart + 1,
                                src.subarray(idstart),
                            );
                            c = 0x3f; // '?'
                            break;
                        }
                    }
                    return c;
                }
                case 0:
                case 0x1a:
                    // end of file
                    c = 0x5c; // '\\'
                    break;
                default:
                    p = this.escapeDefault(loc, p, c, (v) => (c = v), byteAt);
                    return c;
            }
            return c;
        } finally {
            sequence.p = p; // scope(exit) sequence = p
        }
    }

    /// The `\u`/`\U`/`\x` hex-escape body (lexer.d:1356-1414). Sets the decoded value via `setC`,
    /// returns the advanced cursor `p`.
    private escapeHex(
        loc: Loc,
        pIn: number,
        ndigits: number,
        Ccompile: boolean,
        setC: (v: number) => void,
        byteAt: (i: number) => number,
    ): number {
        let p = pIn;
        p++;
        let c = byteAt(p);
        if (ishex(toUint8(c))) {
            let v = 0;
            let n = 0;
            if (Ccompile && ndigits === 2) {
                // C11 6.4.4.4-7 one to infinity hex digits
                do {
                    if (isdigit(toUint8(c))) {
                        c -= 0x30; // '0'
                    } else if (islower(c)) {
                        c -= 0x61 - 10; // 'a' - 10
                    } else {
                        c -= 0x41 - 10; // 'A' - 10
                    }
                    v = v * 16 + c;
                    c = byteAt(++p);
                } while (ishex(toUint8(c)));
            } else {
                while (true) {
                    if (isdigit(toUint8(c))) {
                        c -= 0x30;
                    } else if (islower(c)) {
                        c -= 0x61 - 10;
                    } else {
                        c -= 0x41 - 10;
                    }
                    v = v * 16 + c;
                    c = byteAt(++p);
                    if (++n === ndigits) {
                        break;
                    }
                    if (!ishex(toUint8(c))) {
                        this.errorLoc(loc, ds("escape hex sequence has %d hex digits instead of %d"), n, ndigits);
                        break;
                    }
                }
                if (ndigits !== 2 && !utf_isValidDchar(v)) {
                    this.errorLoc(loc, ds("invalid UTF character \\U%08x"), v);
                    if (v >= 0xd800 && v <= 0xdfff) {
                        this.errorSupplemental(
                            ds("The code unit is a UTF-16 surrogate, is the escape UTF-16 not a Unicode code point?"),
                        );
                    }
                    v = 0x3f; // '?'  recover with valid UTF character
                }
            }
            c = v;
        } else {
            // error(loc, "undefined escape hex sequence \%c%c", sequence[0], c). `sequence[0]` is the
            // FIRST byte of the escape (the kind letter 'u'/'U'/'x') — `pIn` is exactly that position
            // (escapeHex is entered with `p == sequence.p`, before its own `p++`).
            this.errorLoc(loc, ds("undefined escape hex sequence \\%c%c"), byteAt(pIn), c);
            p++;
        }
        setC(c);
        return p;
    }

    /// The `default:` (octal / undefined-escape) body of escapeSequence (lexer.d:1452-1472).
    private escapeDefault(
        loc: Loc,
        pIn: number,
        cIn: number,
        setC: (v: number) => void,
        byteAt: (i: number) => number,
    ): number {
        let p = pIn;
        let c = cIn;
        if (isoctal(toUint8(c))) {
            let v = 0;
            let n = 0;
            do {
                v = v * 8 + (c - 0x30 /* '0' */);
                c = byteAt(++p);
            } while (++n < 3 && isoctal(toUint8(c)));
            c = v;
            if (c > 0xff) {
                this.errorLoc(loc, ds("escape octal sequence \\%03o is larger than \\377"), c);
            }
        } else {
            this.errorLoc(loc, ds("undefined escape sequence \\%c"), c);
            p++;
        }
        setC(c);
        return p;
    }

    /**
     * Lex an identifier (lexer.d:1485). Renamed `scanIdentifier` (D `lexIdentifier`) to avoid the
     * keyword-ish collision and read as the scan helper it is. Returns true if an identifier was set.
     */
    private scanIdentifier(t: Token, startsUCN: boolean): boolean {
        let id: Identifier;

        if (!startsUCN) {
            while (isidchar(this.byteAt(this.p))) {
                this.p++;
            }
        }

        if (!startsUCN && !(this.byteAt(this.p) & 0x80) && (!this.Ccompile || this.byteAt(this.p) !== 0x5c /* '\\' */)) {
            // Fast path for ascii identifiers: id = idPool(t.ptr[0 .. p - t.ptr])
            const start = this.tokenPtrOffset(t);
            id = Identifier.idPool(this.buf.subarray(start, this.p), false);
        } else {
            // Slow path for identifiers with UCNs and UTF8 characters
            Lexer.stringbuffer.setsize(0);
            const start = this.tokenPtrOffset(t);
            Lexer.stringbuffer.writestring(this.buf.subarray(start, this.p));

            // IdentLoop:
            let broke = false;
            while (!broke) {
                // Is this the first character of the identifier?
                const isStartCharacter = this.tokenPtrOffset(t) === this.p; // t.ptr is p
                let u = 0;

                if (isidchar(this.byteAt(this.p))) {
                    const c = this.byteAt(this.p);
                    this.p++;
                    Lexer.stringbuffer.writeByte(c);
                    continue;
                } else if (this.byteAt(this.p) & 0x80) {
                    u = this.decodeUTF();
                    this.p++;
                } else if (this.Ccompile && this.byteAt(this.p) === 0x5c /* '\\' */) {
                    let times: number;
                    if (this.byteAt(this.p + 1) === 0x75 /* 'u' */) {
                        // \uXXXX
                        times = 4;
                    } else if (this.byteAt(this.p + 1) === 0x55 /* 'U' */) {
                        // \UXXXXXXXX
                        times = 8;
                    } else {
                        break; // end of identifier
                    }

                    this.p += 2;

                    let badUcn = false;
                    for (let i = 0; i < times; i++) {
                        let c = this.byteAt(this.p + i);
                        if (c >= 0x30 /* '0' */ && c <= 0x39 /* '9' */) {
                            c -= 0x30;
                        } else if (c >= 0x61 /* 'a' */ && c <= 0x66 /* 'f' */) {
                            c -= 0x61 - 10;
                        } else if (c >= 0x41 /* 'A' */ && c <= 0x46 /* 'F' */) {
                            c -= 0x41 - 10;
                        } else {
                            // Not a valid ucn; if first character, return false now; else break IdentLoop.
                            this.p -= 2;
                            if (isStartCharacter) {
                                return false;
                            }
                            broke = true; // break IdentLoop;
                            badUcn = true;
                            break;
                        }
                        u = (u << 4) | c;
                    }
                    if (badUcn) {
                        break;
                    }
                    if (isBidiControl(u)) {
                        this.errorLoc(
                            t.loc,
                            ds(
                                "Bidirectional control characters in universal character names are disallowed for security reasons",
                            ),
                        );
                    }
                    this.p += times;
                } else {
                    break; // end of identifier
                }

                if (isStartCharacter && !this.charLookup.isStart(u)) {
                    this.errorLoc(t.loc, ds("character 0x%04x is not allowed as a start character in an identifier"), u);
                } else if (!this.charLookup.isContinue(u)) {
                    this.errorLoc(t.loc, ds("character 0x%04x is not allowed as a continue character in an identifier"), u);
                }
                Lexer.stringbuffer.writeUTF8(u);
            }

            id = Identifier.idPool(Lexer.stringbuffer.opSliceAll(), false);
        }

        t.ident = id;
        t.value = id.getValue() as TOK; // cast(TOK)id.getValue()
        return true;
    }

    /**
     * Lex a wysiwyg string (lexer.d:1596). `p` points to the first character before the contents;
     * that character is the terminator (backtick or double-quote).
     */
    private wysiwygStringConstant(result: Token, supportInterpolation = false): void {
        if (supportInterpolation) {
            result.value = TOK.interpolated;
            result.interpolatedSet = null;
        } else {
            result.value = TOK.string_;
        }

        const start = this.loc();
        const terminator = this.byteAt(this.p); // p[0]
        this.p++;
        Lexer.stringbuffer.setsize(0);
        while (true) {
            let c: number = this.byteAt(this.p); // p[0]
            this.p++;
            let handled = false;
            switch (c) {
                case 0x0a /* '\n' */:
                    this.endOfLine();
                    break;
                case 0x0d /* '\r' */:
                    if (this.byteAt(this.p) === 0x0a /* '\n' */) {
                        continue; // ignore
                    }
                    c = 0x0a; // treat EndOfLine as \n character
                    this.endOfLine();
                    break;
                case 0x24 /* '$' */:
                    if (!supportInterpolation) {
                        // goto default;
                        handled = this.wysiwygDefault(result, c, terminator, supportInterpolation);
                        if (handled) {
                            return;
                        }
                        break;
                    }
                    if (!this.handleInterpolatedSegment(result, start)) {
                        // goto default;
                        handled = this.wysiwygDefault(result, c, terminator, supportInterpolation);
                        if (handled) {
                            return;
                        }
                        break;
                    }
                    continue;
                case 0:
                case 0x1a:
                    this.error(ds("unterminated string constant starting at %s"), cstr(start.toChars()));
                    result.setStringEmpty();
                    // rewind `p` so it points to the EOF character
                    this.p--;
                    return;
                default: {
                    const res = this.wysiwygDefaultEx(result, c, terminator, supportInterpolation);
                    if (res.returned) {
                        return;
                    }
                    if (res.continued) {
                        continue;
                    }
                    c = res.c;
                    break;
                }
            }
            Lexer.stringbuffer.writeByte(toUint8(c));
        }
    }

    /// The `default:` arm of wysiwygStringConstant, the simple (non-Ex) form used when reached via
    /// `goto default;` from the `$` case (no terminator/UTF re-check needed there — those were
    /// already handled). Returns true if it set the result and the caller should return.
    private wysiwygDefault(
        result: Token,
        c: number,
        terminator: number,
        supportInterpolation: boolean,
    ): boolean {
        if (c === terminator) {
            if (supportInterpolation) {
                result.appendInterpolatedPartFromBuffer(Lexer.stringbuffer);
            } else {
                result.setStringFromBuffer(Lexer.stringbuffer);
            }
            this.stringPostfix(result);
            return true;
        }
        return false;
    }

    /// The full `default:` body of wysiwygStringConstant (lexer.d:1642-1663): terminator check,
    /// then the UTF8 / plain-byte handling. Returns `{ returned, continued, c }`.
    private wysiwygDefaultEx(
        result: Token,
        cIn: number,
        terminator: number,
        supportInterpolation: boolean,
    ): { returned: boolean; continued: boolean; c: number } {
        let c = cIn;
        if (c === terminator) {
            if (supportInterpolation) {
                result.appendInterpolatedPartFromBuffer(Lexer.stringbuffer);
            } else {
                result.setStringFromBuffer(Lexer.stringbuffer);
            }
            this.stringPostfix(result);
            return { returned: true, continued: false, c };
        } else if (c & 0x80) {
            this.p--;
            const u = this.decodeUTF();
            this.p++;
            if (u === PS || u === LS) {
                this.endOfLine();
            }
            Lexer.stringbuffer.writeUTF8(u);
            return { returned: false, continued: true, c };
        }
        return { returned: false, continued: false, c };
    }

    /**************************************
     * Lex hex strings: x"0A ae 34FE BD" (lexer.d:1673).
     */
    hexStringConstant(t: Token): TOK {
        const start = this.loc();
        let n = 0;
        let v = 0xffffffff; // ~0  dead assignment, needed to suppress warning
        this.p++;
        Lexer.stringbuffer.setsize(0);
        while (true) {
            let c: number = this.byteAt(this.p);
            this.p++;
            let isDefault = false;
            switch (c) {
                case 0x20 /* ' ' */:
                case 0x09 /* '\t' */:
                case 0x0b /* '\v' */:
                case 0x0c /* '\f' */:
                    continue; // skip white space
                case 0x0d /* '\r' */:
                    if (this.byteAt(this.p) === 0x0a /* '\n' */) {
                        continue; // ignore '\r' if followed by '\n'
                    }
                    // Treat isolated '\r' as if it were a '\n'  -> goto case '\n';
                    this.endOfLine();
                    continue;
                case 0x0a /* '\n' */:
                    this.endOfLine();
                    continue;
                case 0:
                case 0x1a:
                    this.error(ds("unterminated string constant starting at %s"), cstr(start.toChars()));
                    t.setStringEmpty();
                    // decrement `p`, because it needs to point to the next token.
                    this.p--;
                    return TOK.hexadecimalString;
                case 0x22 /* '"' */:
                    if (n & 1) {
                        this.error(ds("odd number (%d) of hex characters in hex string"), n);
                        Lexer.stringbuffer.writeByte(toUint8(v));
                    }
                    t.setStringFromBuffer(Lexer.stringbuffer);
                    this.stringPostfix(t);
                    return TOK.hexadecimalString;
                default:
                    isDefault = true;
                    break;
            }
            if (isDefault) {
                if (c >= 0x30 /* '0' */ && c <= 0x39 /* '9' */) {
                    c -= 0x30;
                } else if (c >= 0x61 /* 'a' */ && c <= 0x66 /* 'f' */) {
                    c -= 0x61 - 10;
                } else if (c >= 0x41 /* 'A' */ && c <= 0x46 /* 'F' */) {
                    c -= 0x41 - 10;
                } else if (c & 0x80) {
                    this.p--;
                    const u = this.decodeUTF();
                    this.p++;
                    if (u === PS || u === LS) {
                        this.endOfLine();
                    } else {
                        this.error(ds("non-hex character \\u%04x in hex string"), u);
                    }
                } else {
                    this.error(ds("non-hex character '%c' in hex string"), c);
                }
                if (n & 1) {
                    v = (v << 4) | c;
                    Lexer.stringbuffer.writeByte(toUint8(v));
                } else {
                    v = c;
                }
                n++;
            }
        }
    }

    /**
     * Lex a delimited string (lexer.d:1761). `p` points to the opening double-quote.
     */
    private delimitedStringConstant(result: Token): void {
        result.value = TOK.string_;
        const start = this.loc();
        let delimleft = 0;
        let delimright = 0;
        let nest = 1;
        let nestcount = 0xffffffff; // ~0  dead assignment, needed to suppress warning
        let hereid: Identifier | null = null;
        let blankrol = 0;
        let startline = 0;
        this.p++;
        Lexer.stringbuffersecondary.setsize(0);
        while (true) {
            const s = this.p;
            let c: number = this.byteAt(this.p);
            this.p++;
            let toLnextline = false;
            switch (c) {
                case 0x0a /* '\n' */:
                    toLnextline = true;
                    break;
                case 0x0d /* '\r' */:
                    if (this.byteAt(this.p) === 0x0a /* '\n' */) {
                        continue; // ignore
                    }
                    c = 0x0a; // treat EndOfLine as \n character
                    toLnextline = true; // goto Lnextline;
                    break;
                case 0:
                case 0x1a:
                    this.error(ds("unterminated delimited string constant starting at %s"), cstr(start.toChars()));
                    result.setStringEmpty();
                    this.p--;
                    return;
                default:
                    if (c & 0x80) {
                        this.p--;
                        c = this.decodeUTF();
                        this.p++;
                        if (c === PS || c === LS) {
                            toLnextline = true; // goto Lnextline;
                        }
                    }
                    break;
            }

            // Lnextline:
            if (toLnextline) {
                this.endOfLine();
                startline = 1;
                if (blankrol) {
                    blankrol = 0;
                    continue;
                }
                if (hereid) {
                    Lexer.stringbuffersecondary.writeUTF8(c);
                    continue;
                }
                // fall through to the delim-processing below (the D `break;` out of the switch)
            }

            if (delimleft === 0) {
                delimleft = c;
                nest = 1;
                nestcount = 1;
                if (c === 0x28 /* '(' */) {
                    delimright = 0x29; // ')'
                } else if (c === 0x7b /* '{' */) {
                    delimright = 0x7d; // '}'
                } else if (c === 0x5b /* '[' */) {
                    delimright = 0x5d; // ']'
                } else if (c === 0x3c /* '<' */) {
                    delimright = 0x3e; // '>'
                } else if (isAlphaASCII(c) || c === 0x5f /* '_' */ || (c >= 0x80 && this.charLookup.isStart(c))) {
                    // Start of identifier; must be a heredoc
                    const tok = new Token();
                    this.p = s;
                    this.scan(tok); // read in heredoc identifier
                    if (tok.value !== TOK.identifier) {
                        this.error(ds("identifier expected for heredoc, not %s"), cstr(tok.toChars()));
                        delimright = c;
                    } else {
                        hereid = tok.ident;
                        blankrol = 1;
                    }
                    nest = 0;
                } else {
                    delimright = c;
                    nest = 0;
                    if (isspace(c)) {
                        this.error(ds("delimiter cannot be whitespace"));
                    }
                }
            } else {
                if (blankrol) {
                    this.error(ds("heredoc rest of line should be blank"));
                    blankrol = 0;
                    continue;
                }
                if (nest === 1) {
                    if (c === delimleft) {
                        nestcount++;
                    } else if (c === delimright) {
                        nestcount--;
                        if (nestcount === 0) {
                            // goto Ldone;
                            this.delimitedStringDone(result, hereid, delimright);
                            return;
                        }
                    }
                } else if (c === delimright) {
                    // goto Ldone;
                    this.delimitedStringDone(result, hereid, delimright);
                    return;
                }

                // we're looking for a new identifier token
                if (
                    startline &&
                    (isAlphaASCII(c) || c === 0x5f /* '_' */ || (c >= 0x80 && this.charLookup.isStart(c))) &&
                    hereid
                ) {
                    const tok = new Token();
                    const psave = this.p;
                    this.p = s;
                    this.scan(tok); // read in possible heredoc identifier
                    if (tok.value === TOK.identifier && tok.ident === hereid) {
                        // should check that rest of line is blank
                        this.delimitedStringDone(result, hereid, delimright); // goto Ldone;
                        return;
                    }
                    this.p = psave;
                }
                Lexer.stringbuffersecondary.writeUTF8(c);
                startline = 0;
            }
        }
    }

    /// The `Ldone:` tail of delimitedStringConstant (lexer.d:1901).
    private delimitedStringDone(result: Token, hereid: Identifier | null, delimright: number): void {
        if (this.byteAt(this.p) === 0x22 /* '"' */) {
            this.p++;
        } else if (hereid) {
            this.error(ds('delimited string must end in `%s"`'), cstr(hereid.toChars()));
        } else if (isspace(delimright)) {
            this.error(ds('delimited string must end in `"`'));
        } else {
            this.errorLoc(this.token.loc, ds('delimited string must end in `%c"`'), delimright);
        }
        result.setStringFromBuffer(Lexer.stringbuffersecondary);
        this.stringPostfix(result);
    }

    /**
     * Lex a token string (lexer.d:1925). `p` points to the opening curly-brace.
     */
    private tokenStringConstant(result: Token, supportInterpolation = false): void {
        if (supportInterpolation) {
            result.value = TOK.interpolated;
            result.interpolatedSet = null;
        } else {
            result.value = TOK.string_;
        }

        let nest = 1;
        const start = this.loc();
        let pstart = ++this.p;
        this.inTokenStringConstant++;
        try {
            while (true) {
                const tok = new Token();
                this.scan(tok);
                switch (tok.value) {
                    case TOK.leftCurly:
                        nest++;
                        continue;
                    case TOK.rightCurly:
                        if (--nest === 0) {
                            if (supportInterpolation) {
                                result.appendInterpolatedPart(this.buf.subarray(pstart, this.p - 1));
                            } else {
                                result.setString(this.buf.subarray(pstart, this.p - 1));
                            }
                            this.stringPostfix(result);
                            return;
                        }
                        continue;
                    case TOK.dollar: {
                        if (!supportInterpolation) {
                            continue; // goto default;
                        }
                        Lexer.stringbuffer.setsize(0);
                        Lexer.stringbuffer.write(this.buf.subarray(pstart, this.p - 1));
                        if (!this.handleInterpolatedSegment(result, start)) {
                            continue; // goto default;
                        }
                        Lexer.stringbuffer.setsize(0);
                        pstart = this.p;
                        continue;
                    }
                    case TOK.endOfFile:
                        this.error(ds("unterminated token string constant starting at %s"), cstr(start.toChars()));
                        result.setStringEmpty();
                        return;
                    default:
                        continue;
                }
            }
        } finally {
            this.inTokenStringConstant--; // scope(exit) inTokenStringConstant--;
        }
    }

    /// returns true if it got special treatment as an interpolated segment (lexer.d:1989).
    private handleInterpolatedSegment(token: Token, start: Loc): boolean {
        switch (this.byteAt(this.p)) {
            case 0x28 /* '(' */: {
                // expression: scan until the closing ')'. Put the string part in first.
                token.appendInterpolatedPartFromBuffer(Lexer.stringbuffer);
                Lexer.stringbuffer.setsize(0);

                let openParenCount = 1;
                this.p++; // skip the first open paren
                const pstart = this.p;
                while (openParenCount > 0) {
                    const tok = new Token();
                    this.scan(tok);
                    if (tok.value === TOK.leftParenthesis) {
                        openParenCount++;
                    }
                    if (tok.value === TOK.rightParenthesis) {
                        openParenCount--;
                    }
                    if (tok.value === TOK.endOfFile) {
                        this.error(ds("unterminated interpolated string constant starting at %s"), cstr(start.toChars()));
                        return false;
                    }
                }

                // then put the interpolated string segment
                token.appendInterpolatedPart(this.buf.subarray(pstart, this.p - 1));
                Lexer.stringbuffer.setsize(0); // reset from the last token scan
                return true;
            }
            default:
                // nothing special
                return false;
        }
    }

    /**
     * Scan a quoted string while building the processed string value, handling escape sequences
     * (lexer.d:2044). `p` points to the opening quote.
     */
    private escapeStringConstant(t: Token, supportInterpolation = false): void {
        if (supportInterpolation) {
            t.value = TOK.interpolated;
            t.interpolatedSet = null;
        } else {
            t.value = TOK.string_;
        }

        const start = this.loc();
        const tc = this.byteAt(this.p); // opening quote
        this.p++;
        Lexer.stringbuffer.setsize(0);
        while (true) {
            let c: number = this.byteAt(this.p);
            this.p++;
            const c2 = { value: 0 };
            let appendByte = true;
            switch (c) {
                case 0x5c /* '\\' */:
                    switch (this.byteAt(this.p)) {
                        case 0x26 /* '&' */: {
                            if (this.Ccompile) {
                                // goto default;  — the OUTER switch's `default:` (UTF8/byte handler).
                                // `c` here is still '\\' (the byte already read); the default body
                                // writes/decodes it as an ordinary byte. (lexer.d:2069-2070.)
                                const r = this.escapeStringInnerDefault(t, start, c, tc);
                                if (r.returned) {
                                    return;
                                }
                                if (r.continued) {
                                    continue;
                                }
                                c = r.c;
                                appendByte = r.appendByte;
                                break;
                            }
                            c = this.escapeSequenceCurrent(c2);
                            Lexer.stringbuffer.writeUTF8(c);
                            if (c2.value !== 0) {
                                Lexer.stringbuffer.writeUTF8(c2.value);
                            }
                            continue;
                        }
                        case 0x75 /* 'u' */:
                        case 0x55 /* 'U' */:
                            c = this.escapeSequenceCurrent(c2);
                            Lexer.stringbuffer.writeUTF8(c);
                            continue;
                        case 0x24 /* '$' */:
                            if (supportInterpolation) {
                                this.p++; // skip escaped $
                                Lexer.stringbuffer.writeByte(0x24); // '$'
                                continue;
                            }
                            // else goto default
                            c = this.escapeSequenceCurrent(c2);
                            break;
                        default:
                            c = this.escapeSequenceCurrent(c2);
                            break;
                    }
                    break;
                case 0x24 /* '$' */:
                    if (!supportInterpolation) {
                        // goto default;
                        {
                            const r = this.escapeStringInnerDefault(t, start, c, tc);
                            if (r.returned) {
                                return;
                            }
                            if (r.continued) {
                                continue;
                            }
                            c = r.c;
                            appendByte = r.appendByte;
                            break;
                        }
                    }
                    if (!this.handleInterpolatedSegment(t, start)) {
                        const r = this.escapeStringInnerDefault(t, start, c, tc);
                        if (r.returned) {
                            return;
                        }
                        if (r.continued) {
                            continue;
                        }
                        c = r.c;
                        appendByte = r.appendByte;
                        break;
                    }
                    continue;
                case 0x0a /* '\n' */:
                    this.endOfLine();
                    if (this.Ccompile) {
                        // goto Lunterminated;
                        this.error(ds("unterminated string constant starting at %s"), cstr(start.toChars()));
                        t.setStringEmpty();
                        return;
                    }
                    break;
                case 0x0d /* '\r' */:
                    if (this.byteAt(this.p) === 0x0a /* '\n' */) {
                        continue; // ignore
                    }
                    c = 0x0a; // treat EndOfLine as \n character
                    this.endOfLine();
                    if (this.Ccompile) {
                        this.error(ds("unterminated string constant starting at %s"), cstr(start.toChars()));
                        t.setStringEmpty();
                        return;
                    }
                    break;
                case 0x27 /* '\'' */:
                case 0x22 /* '"' */: {
                    const r = this.escapeStringInnerDefault(t, start, c, tc);
                    if (r.returned) {
                        return;
                    }
                    if (r.continued) {
                        continue;
                    }
                    c = r.c;
                    appendByte = r.appendByte;
                    break;
                }
                case 0:
                case 0x1a:
                    // decrement `p`, because it needs to point to the next token.
                    this.p--;
                    // Lunterminated:
                    this.error(ds("unterminated string constant starting at %s"), cstr(start.toChars()));
                    t.setStringEmpty();
                    return;
                default: {
                    const r = this.escapeStringInnerDefault(t, start, c, tc);
                    if (r.returned) {
                        return;
                    }
                    if (r.continued) {
                        continue;
                    }
                    c = r.c;
                    appendByte = r.appendByte;
                    break;
                }
            }
            if (appendByte) {
                Lexer.stringbuffer.writeByte(toUint8(c));
            }
        }
    }

    /// The terminator/UTF `default:` body of escapeStringConstant (lexer.d:2117-2152). Returns
    /// `{ returned, continued, appendByte, c }`. `tc` is the opening quote; on a matching quote it
    /// terminates the string.
    private escapeStringInnerDefault(
        t: Token,
        start: Loc,
        cIn: number,
        tc: number,
    ): { returned: boolean; continued: boolean; appendByte: boolean; c: number } {
        let c = cIn;
        // case '\'' / '"' (only matters when c == tc):
        if (c === 0x27 /* '\'' */ || c === 0x22 /* '"' */) {
            if (c !== tc) {
                // goto default; (fall to the UTF/byte handling below)
            } else {
                const supportInterpolation = t.value === TOK.interpolated;
                if (supportInterpolation) {
                    t.appendInterpolatedPartFromBuffer(Lexer.stringbuffer);
                } else {
                    t.setStringFromBuffer(Lexer.stringbuffer);
                }
                if (!this.Ccompile) {
                    this.stringPostfix(t);
                }
                return { returned: true, continued: false, appendByte: false, c };
            }
        }
        // default: UTF8 / plain byte
        if (c & 0x80) {
            this.p--;
            c = this.decodeUTF();
            if (c === LS || c === PS) {
                c = 0x0a; // '\n'
                this.endOfLine();
                if (this.Ccompile) {
                    this.error(ds("unterminated string constant starting at %s"), cstr(start.toChars()));
                    t.setStringEmpty();
                    return { returned: true, continued: false, appendByte: false, c };
                }
            }
            this.p++;
            Lexer.stringbuffer.writeUTF8(c);
            return { returned: false, continued: true, appendByte: false, c };
        }
        return { returned: false, continued: false, appendByte: true, c };
    }

    /**************************************
     * Lex a character literal (lexer.d:2162).
     * https://dlang.org/spec/lex.html#characterliteral
     */
    private charConstant(t: Token): TOK {
        let tk = TOK.charLiteral;
        this.p++;
        let c: number = this.byteAt(this.p);
        this.p++;
        const c2 = { value: 0 };
        switch (c) {
            case 0x5c /* '\\' */:
                switch (this.byteAt(this.p)) {
                    case 0x75 /* 'u' */:
                        tk = TOK.wcharLiteral;
                        t.unsvalue = BigInt(this.escapeSequenceCurrent(c2));
                        break;
                    case 0x55 /* 'U' */:
                    case 0x26 /* '&' */:
                        tk = TOK.dcharLiteral;
                        t.unsvalue = BigInt(this.escapeSequenceCurrent(c2));
                        if (c2.value !== 0) {
                            this.error(ds("html entity requires 2 code units, use a string instead of a character"));
                            t.unsvalue = BigInt(0x3f); // '?'
                        }
                        break;
                    default:
                        t.unsvalue = BigInt(this.escapeSequenceCurrent(c2));
                        if (c2.value !== 0) {
                            this.error(ds("html entity requires 2 code units, use a string instead of a character"));
                            t.unsvalue = BigInt(0x3f); // '?'
                        }
                        break;
                }
                break;
            case 0x0a /* '\n' */:
                // L1:
                this.endOfLine();
                // goto case '\r'; -> goto case '\'';
                this.error(ds("unterminated character constant"));
                t.unsvalue = BigInt(0x3f); // '?'
                return tk;
            case 0x0d /* '\r' */:
                // goto case '\'';
                this.error(ds("unterminated character constant"));
                t.unsvalue = BigInt(0x3f);
                return tk;
            case 0:
            case 0x1a:
                // decrement `p`, because it needs to point to the next token.
                this.p--;
                // goto case '\'';
                this.error(ds("unterminated character constant"));
                t.unsvalue = BigInt(0x3f);
                return tk;
            case 0x27 /* '\'' */:
                this.error(ds("unterminated character constant"));
                t.unsvalue = BigInt(0x3f);
                return tk;
            default:
                if (c & 0x80) {
                    this.p--;
                    c = this.decodeUTF();
                    this.p++;
                    if (c === LS || c === PS) {
                        // goto L1;
                        this.endOfLine();
                        this.error(ds("unterminated character constant"));
                        t.unsvalue = BigInt(0x3f);
                        return tk;
                    }
                    if (c < 0xd800 || (c >= 0xe000 && c < 0xfffe)) {
                        tk = TOK.wcharLiteral;
                    } else {
                        tk = TOK.dcharLiteral;
                    }
                }
                t.unsvalue = BigInt(c);
                break;
        }
        if (this.byteAt(this.p) !== 0x27 /* '\'' */) {
            while (
                this.byteAt(this.p) !== 0x27 &&
                this.byteAt(this.p) !== 0x1a &&
                this.byteAt(this.p) !== 0 &&
                this.byteAt(this.p) !== 0x0a /* '\n' */ &&
                this.byteAt(this.p) !== 0x0d /* '\r' */ &&
                this.byteAt(this.p) !== 0x3b /* ';' */ &&
                this.byteAt(this.p) !== 0x29 /* ')' */ &&
                this.byteAt(this.p) !== 0x5d /* ']' */ &&
                this.byteAt(this.p) !== 0x7d /* '}' */
            ) {
                if (this.byteAt(this.p) & 0x80) {
                    const s = this.p;
                    c = this.decodeUTF();
                    if (c === LS || c === PS) {
                        this.p = s;
                        break;
                    }
                }
                this.p++;
            }

            if (this.byteAt(this.p) === 0x27 /* '\'' */) {
                // Scan back to the opening quote so the message can echo the offending characters.
                // The opening `'` is always found: this branch is reached only after it was consumed.
                let s = this.p - 1;
                while (this.byteAt(s) !== 0x27 /* '\'' */) {
                    s--;
                }
                s++;
                this.error(
                    ds('character constant has multiple characters - did you mean "%.*s"?'),
                    this.p - s,
                    this.buf.subarray(s),
                );
                this.p++;
            } else {
                this.error(ds("unterminated character constant"));
            }
            t.unsvalue = BigInt(0x3f); // '?'
            return tk;
        }
        this.p++;
        return tk;
    }

    /***************************************
     * Lex C character constant (lexer.d:2263). Parser is on the opening quote.
     */
    private clexerCharConstant(t: Token, prefix: number): void {
        this.escapeStringConstant(t);
        const str = t.ustring ? t.ustring.subarray(0, t.len) : ds("");
        const n = str.length;
        const loc = t.loc;
        if (n === 0) {
            this.errorLoc(loc, ds("empty character constant"));
            t.value = TOK.semicolon;
            return;
        }

        let u = 0;
        switch (prefix) {
            case 0:
                if (n === 1) {
                    // fast case
                    u = str[0];
                } else if (n > 4) {
                    this.errorLoc(loc, ds("max number of chars in character literal is 4, had %d"), toInt32(n));
                } else {
                    // foreach (i, c; str) (cast(char*)&u)[n - 1 - i] = c;  — build u big-endian-ish
                    const bytes = new Uint8Array(4);
                    for (let i = 0; i < n; i++) {
                        bytes[n - 1 - i] = str[i];
                    }
                    u = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
                }
                break;

            case 0x75 /* 'u' */: {
                let idx = 0;
                let d1 = 0;
                while (idx < n) {
                    const r = utf_decodeChar(str, idx);
                    idx = r.nextIdx;
                    d1 = r.dchar;
                    if (r.error) {
                        this.errorLoc(loc, ds("%.*s"), r.error.length, r.error);
                    }
                }
                if (d1 >= 0x1_0000) {
                    this.errorLoc(loc, ds("x%x does not fit in 16 bits"), d1);
                }
                t.unsvalue = BigInt(d1);
                t.value = TOK.wcharLiteral; // C11 6.4.4.4-9
                return;
            }

            case 0x55 /* 'U' */: {
                let idx = 0;
                const r = utf_decodeChar(str, idx);
                idx = r.nextIdx;
                const d = r.dchar;
                if (r.error) {
                    this.errorLoc(loc, ds("%.*s"), r.error.length, r.error);
                } else if (idx < n) {
                    this.errorLoc(
                        loc,
                        ds("max number of chars in 32 bit character literal is 1, had %d"),
                        toInt32((n + 3) >> 2),
                    );
                }
                t.unsvalue = BigInt(d);
                t.value = TOK.dcharLiteral; // C11 6.4.4.4-9
                return;
            }

            default:
                assertUnreachable();
        }
        t.value = n === 1 ? TOK.charLiteral : TOK.int32Literal;
        t.unsvalue = BigInt(u);
    }

    /***************************************
     * Get postfix of string literal (lexer.d:2332).
     */
    private stringPostfix(t: Token): void {
        switch (this.byteAt(this.p)) {
            case 0x63 /* 'c' */:
            case 0x77 /* 'w' */:
            case 0x64 /* 'd' */:
                t.postfix = this.byteAt(this.p);
                this.p++;
                break;
            default:
                t.postfix = 0;
                break;
        }
    }

    /**************************************
     * Read in a number (lexer.d:2358).
     *   integers can be decimal, octal or hex; handle the suffixes U, UL, LU, L, etc.
     *   doubles -> inreal.
     */
    private number(t: Token): TOK {
        let base = 10;
        const start = this.p;
        let n = 0n; // unsigned >=64 bit integer type (ulong) -> bigint carrier (09 §0)
        let d: number;
        let err = false;
        let overflow = false;
        let anyBinaryDigitsNoSingleUS = false;
        let anyHexDigitsNoSingleUS = false;
        let errorDigit = 0;
        let c: number = this.byteAt(this.p);
        if (c === 0x30 /* '0' */) {
            ++this.p;
            c = this.byteAt(this.p);
            switch (c) {
                case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35: case 0x36: case 0x37:
                    base = 8;
                    break;
                case 0x38 /* '8' */:
                case 0x39 /* '9' */:
                    errorDigit = c;
                    base = 8;
                    break;
                case 0x78 /* 'x' */:
                case 0x58 /* 'X' */:
                    ++this.p;
                    base = 16;
                    break;
                case 0x62 /* 'b' */:
                case 0x42 /* 'B' */:
                    ++this.p;
                    base = 2;
                    break;
                case 0x2e /* '.' */:
                    if (this.byteAt(this.p + 1) === 0x2e) {
                        return this.numberDone(t, base, start, n, errorDigit, overflow, err, anyBinaryDigitsNoSingleUS, anyHexDigitsNoSingleUS); // if ".."
                    }
                    if (isAlphaASCII(this.byteAt(this.p + 1)) || this.byteAt(this.p + 1) === 0x5f /* '_' */ || this.byteAt(this.p + 1) & 0x80) {
                        if (
                            this.Ccompile &&
                            (this.byteAt(this.p + 1) === 0x66 /* 'f' */ ||
                                this.byteAt(this.p + 1) === 0x46 /* 'F' */ ||
                                this.byteAt(this.p + 1) === 0x6c /* 'l' */ ||
                                this.byteAt(this.p + 1) === 0x4c) /* 'L' */
                        ) {
                            this.p = start;
                            return this.inreal(t); // if `0.f` or `0.L`  (Lreal)
                        }
                        return this.numberDone(t, base, start, n, errorDigit, overflow, err, anyBinaryDigitsNoSingleUS, anyHexDigitsNoSingleUS); // if ".identifier" or ".unicode"
                    }
                    this.p = start;
                    return this.inreal(t); // '.' is part of current token (Lreal)
                case 0x69 /* 'i' */:
                case 0x66 /* 'f' */:
                case 0x46 /* 'F' */:
                    this.p = start;
                    return this.inreal(t); // Lreal
                case 0x5f /* '_' */:
                    if (this.Ccompile) {
                        this.error(ds("embedded `_` not allowed"));
                    }
                    ++this.p;
                    base = 8;
                    break;
                case 0x4c /* 'L' */:
                    if (this.byteAt(this.p + 1) === 0x69 /* 'i' */) {
                        this.p = start;
                        return this.inreal(t); // Lreal
                    }
                    break;
                default:
                    break;
            }
        }
        let done = false;
        while (!done) {
            c = this.byteAt(this.p);
            let gotDigit = true;
            switch (c) {
                case 0x30: case 0x31: case 0x32: case 0x33: case 0x34:
                case 0x35: case 0x36: case 0x37: case 0x38: case 0x39:
                    ++this.p;
                    d = c - 0x30; // c - '0'
                    break;
                case 0x61: case 0x62: case 0x63: case 0x64: case 0x65: case 0x66:
                case 0x41: case 0x42: case 0x43: case 0x44: case 0x45: case 0x46: {
                    ++this.p;
                    if (base !== 16) {
                        if (c === 0x65 /* 'e' */ || c === 0x45 /* 'E' */ || c === 0x66 /* 'f' */ || c === 0x46 /* 'F' */) {
                            this.p = start;
                            return this.inreal(t); // Lreal
                        }
                    }
                    if (c >= 0x61 /* 'a' */) {
                        d = c + 10 - 0x61; // c + 10 - 'a'
                    } else {
                        d = c + 10 - 0x41; // c + 10 - 'A'
                    }
                    break;
                }
                case 0x4c /* 'L' */:
                    if (this.byteAt(this.p + 1) === 0x69 /* 'i' */) {
                        this.p = start;
                        return this.inreal(t); // Lreal
                    }
                    return this.numberDone(t, base, start, n, errorDigit, overflow, err, anyBinaryDigitsNoSingleUS, anyHexDigitsNoSingleUS); // Ldone
                case 0x2e /* '.' */:
                    if (this.byteAt(this.p + 1) === 0x2e) {
                        return this.numberDone(t, base, start, n, errorDigit, overflow, err, anyBinaryDigitsNoSingleUS, anyHexDigitsNoSingleUS); // ".."
                    }
                    if (
                        base <= 10 &&
                        n > 0n &&
                        (isAlphaASCII(this.byteAt(this.p + 1)) || this.byteAt(this.p + 1) === 0x5f /* '_' */ || this.byteAt(this.p + 1) & 0x80)
                    ) {
                        if (
                            this.Ccompile &&
                            base === 10 &&
                            (this.byteAt(this.p + 1) === 0x65 /* 'e' */ ||
                                this.byteAt(this.p + 1) === 0x45 /* 'E' */ ||
                                this.byteAt(this.p + 1) === 0x66 /* 'f' */ ||
                                this.byteAt(this.p + 1) === 0x46 /* 'F' */ ||
                                this.byteAt(this.p + 1) === 0x6c /* 'l' */ ||
                                this.byteAt(this.p + 1) === 0x4c) /* 'L' */
                        ) {
                            this.p = start;
                            return this.inreal(t); // `1.e6` or `1.f` or `1.L`  (Lreal)
                        }
                        return this.numberDone(t, base, start, n, errorDigit, overflow, err, anyBinaryDigitsNoSingleUS, anyHexDigitsNoSingleUS); // ".identifier" or ".unicode"
                    }
                    if (base === 16 && (!ishex(this.byteAt(this.p + 1)) || this.byteAt(this.p + 1) === 0x5f || this.byteAt(this.p + 1) & 0x80)) {
                        return this.numberDone(t, base, start, n, errorDigit, overflow, err, anyBinaryDigitsNoSingleUS, anyHexDigitsNoSingleUS); // ".identifier" or ".unicode"
                    }
                    if (base === 2) {
                        return this.numberDone(t, base, start, n, errorDigit, overflow, err, anyBinaryDigitsNoSingleUS, anyHexDigitsNoSingleUS); // ".identifier" or ".unicode"
                    }
                    this.p = start;
                    return this.inreal(t); // otherwise part of a floating point literal (Lreal)
                case 0x69 /* 'i' */:
                    if (this.Ccompile) {
                        return this.numberDone(t, base, start, n, errorDigit, overflow, err, anyBinaryDigitsNoSingleUS, anyHexDigitsNoSingleUS); // Ldone
                    }
                    this.p = start;
                    return this.inreal(t); // Lreal
                case 0x70 /* 'p' */:
                case 0x50 /* 'P' */:
                    // Lreal:
                    this.p = start;
                    return this.inreal(t);
                case 0x5f /* '_' */:
                    if (this.Ccompile) {
                        return this.numberDone(t, base, start, n, errorDigit, overflow, err, anyBinaryDigitsNoSingleUS, anyHexDigitsNoSingleUS); // goto default -> Ldone
                    }
                    ++this.p;
                    gotDigit = false;
                    break; // continue
                default:
                    return this.numberDone(t, base, start, n, errorDigit, overflow, err, anyBinaryDigitsNoSingleUS, anyHexDigitsNoSingleUS); // Ldone
            }
            if (!gotDigit) {
                continue;
            }
            // got a digit here, set any necessary flags, check for errors
            anyHexDigitsNoSingleUS = true;
            anyBinaryDigitsNoSingleUS = true;
            if (!errorDigit && d! >= base) {
                errorDigit = c;
            }
            // Avoid expensive overflow check if we aren't at risk of overflow
            if (n <= 0x0fff_ffff_ffff_ffffn) {
                n = n * BigInt(base) + BigInt(d!);
            } else {
                // import core.checkedint : mulu, addu;  — overflow-checked 64-bit mul/add
                const m = mulu(n, BigInt(base));
                n = m.value;
                overflow = overflow || m.overflow;
                const a = addu(n, BigInt(d!));
                n = a.value;
                overflow = overflow || a.overflow;
            }
        }
        void done;
        return TOK.reserved; // unreachable; loop returns from inside
    }

    /// The `Ldone:` tail of number() (lexer.d:2527) — errors + suffix parsing + literal kind.
    private numberDone(
        t: Token,
        base: number,
        start: number,
        n: bigint,
        errorDigit: number,
        overflow: boolean,
        err: boolean,
        anyBinaryDigitsNoSingleUS: boolean,
        anyHexDigitsNoSingleUS: boolean,
    ): TOK {
        if (errorDigit) {
            this.errorLoc(
                this.scanloc,
                ds("%s digit expected, not `%c`"),
                base === 2 ? ds("binary") : base === 8 ? ds("octal") : ds("decimal"),
                errorDigit,
            );
            err = true;
        }
        if (overflow && !err) {
            this.errorLoc(this.scanloc, ds("integer overflow"));
            err = true;
        }
        if ((base === 2 && !anyBinaryDigitsNoSingleUS) || (base === 16 && !anyHexDigitsNoSingleUS)) {
            this.errorLoc(
                this.scanloc,
                ds("`%.*s` isn't a valid integer literal, use `%.*s0` instead"),
                this.p - start,
                this.buf.subarray(start),
                2,
                this.buf.subarray(start),
            );
        }

        t.unsvalue = n;

        if (this.Ccompile) {
            return this.cnumber(base, n);
        }

        // enum FLAGS : int { none, decimal, unsigned, long_ }  (02 §4.1 manifest -> const)
        const FLAGS_none = 0;
        const FLAGS_decimal = 1;
        const FLAGS_unsigned = 2;
        const FLAGS_long = 4;

        let flags = base === 10 ? FLAGS_decimal : FLAGS_none;
        // Parse trailing 'u', 'U', 'l' or 'L' in any combination
        const psuffix = this.p;
        while (true) {
            let f: number;
            let brk = false;
            switch (this.byteAt(this.p)) {
                case 0x55 /* 'U' */:
                case 0x75 /* 'u' */:
                    f = FLAGS_unsigned;
                    break;
                case 0x6c /* 'l' */:
                    f = FLAGS_long;
                    this.errorLoc(this.scanloc, ds("lower case integer suffix 'l' is not allowed. Please use 'L' instead"));
                    break;
                case 0x4c /* 'L' */:
                    f = FLAGS_long;
                    break;
                default:
                    f = 0;
                    brk = true;
                    break;
            }
            if (brk) {
                break;
            }
            // L1:
            this.p++;
            if (flags & f! && !err) {
                this.errorLoc(this.scanloc, ds("repeated integer suffix `%c`"), this.byteAt(this.p - 1));
                err = true;
            }
            flags = flags | f!;
        }
        if (base === 8 && n >= 8n) {
            if (err) {
                // can't translate invalid octal value, just show a generic message
                this.errorLoc(this.scanloc, ds("octal literals larger than 7 are no longer supported"));
            } else {
                this.errorLoc(
                    this.scanloc,
                    ds('octal literals `0%llo%.*s` are no longer supported, use `std.conv.octal!"%llo%.*s"` instead'),
                    toUint64(n), // %llo — the value as a 64-bit unsigned (bigint), octal-formatted
                    this.p - psuffix,
                    this.buf.subarray(psuffix),
                    toUint64(n),
                    this.p - psuffix,
                    this.buf.subarray(psuffix),
                );
            }
        }
        let result: TOK;
        // switch (flags) — combinations of FLAGS bits
        if (flags === FLAGS_none) {
            // Octal or Hexadecimal constant. First that fits: int, uint, long, ulong
            if (n & 0x8000000000000000n) {
                result = TOK.uns64Literal;
            } else if (n & 0xffffffff00000000n) {
                result = TOK.int64Literal;
            } else if (n & 0x80000000n) {
                result = TOK.uns32Literal;
            } else {
                result = TOK.int32Literal;
            }
        } else if (flags === FLAGS_decimal) {
            // First that fits: int, long, long long
            if (n & 0x8000000000000000n) {
                result = TOK.uns64Literal;
            } else if (n & 0xffffffff80000000n) {
                result = TOK.int64Literal;
            } else {
                result = TOK.int32Literal;
            }
        } else if (flags === FLAGS_unsigned || flags === (FLAGS_decimal | FLAGS_unsigned)) {
            // First that fits: uint, ulong
            if (n & 0xffffffff00000000n) {
                result = TOK.uns64Literal;
            } else {
                result = TOK.uns32Literal;
            }
        } else if (flags === (FLAGS_decimal | FLAGS_long)) {
            if (n & 0x8000000000000000n) {
                if (!err) {
                    this.error(ds("signed integer overflow"));
                    err = true;
                }
                result = TOK.uns64Literal;
            } else {
                result = TOK.int64Literal;
            }
        } else if (flags === FLAGS_long) {
            if (n & 0x8000000000000000n) {
                result = TOK.uns64Literal;
            } else {
                result = TOK.int64Literal;
            }
        } else if (
            flags === (FLAGS_unsigned | FLAGS_long) ||
            flags === (FLAGS_decimal | FLAGS_unsigned | FLAGS_long)
        ) {
            result = TOK.uns64Literal;
        } else {
            // debug { printf("%x\n", flags); } -> OFF; assert(0)
            return assertUnreachable();
        }
        return result;
    }

    /**************************************
     * Lex C integer-suffix (lexer.d:2676). C11 6.4.4.1.
     */
    private cnumber(base: number, n: bigint): TOK {
        // enum FLAGS : uint { octalhex, decimal, unsigned, long_, llong, i8, i16, i32, i64 }
        const F_octalhex = 1;
        const F_decimal = 2;
        const F_unsigned = 4;
        const F_long = 8;
        const F_llong = 0x10;
        const F_i8 = 0x20;
        const F_i16 = 0x40;
        const F_i32 = 0x80;
        const F_i64 = 0x100;
        let flags = base === 10 ? F_decimal : F_octalhex;
        let err = false;
        // Lsuffixes:
        let suffLoop = true;
        while (suffLoop) {
            let f = 0;
            let brkSuffixes = false;
            const cs = this.byteAt(this.p);
            switch (cs) {
                case 0x55 /* 'U' */:
                case 0x75 /* 'u' */:
                    f = F_unsigned;
                    break;
                case 0x6c /* 'l' */:
                case 0x4c /* 'L' */:
                    f = F_long;
                    if (cs === this.byteAt(this.p + 1)) {
                        f = F_long | F_llong;
                        ++this.p;
                    }
                    break;
                case 0x69 /* 'i' */:
                case 0x49 /* 'I' */:
                    if (this.byteAt(this.p + 1) === 0x38 /* '8' */) {
                        f = F_i8;
                        ++this.p;
                    } else if (this.byteAt(this.p + 1) === 0x31 /* '1' */ && this.byteAt(this.p + 2) === 0x36 /* '6' */) {
                        f = F_i16;
                        this.p += 2;
                    } else if (this.byteAt(this.p + 1) === 0x33 /* '3' */ && this.byteAt(this.p + 2) === 0x32 /* '2' */) {
                        f = F_i32;
                        this.p += 2;
                    } else if (this.byteAt(this.p + 1) === 0x36 /* '6' */ && this.byteAt(this.p + 2) === 0x34 /* '4' */) {
                        f = F_i64;
                        this.p += 2;
                    } else {
                        brkSuffixes = true; // break Lsuffixes;
                        break;
                    }
                    if (this.byteAt(this.p + 1) >= 0x30 /* '0' */ && this.byteAt(this.p + 1) <= 0x39 /* '9' */ && !err) {
                        this.error(ds("invalid integer suffix"));
                        err = true;
                    }
                    break;
                default:
                    brkSuffixes = true; // break Lsuffixes;
                    break;
            }
            if (brkSuffixes) {
                break;
            }
            ++this.p;
            if (flags & f && !err) {
                this.error(ds("duplicate integer suffixes"));
                err = true;
            }
            flags = flags | f;
        }
        void suffLoop;

        let result: TOK = TOK.int32Literal; // default
        // Since D doesn't have a variable sized `long`/`unsigned long`, this deviates from C.
        if (flags === F_octalhex) {
            if (n & 0x8000000000000000n) result = TOK.uns64Literal;
            else if (n & 0xffffffff00000000n) result = TOK.int64Literal;
            else if (n & 0x80000000n) result = TOK.uns32Literal;
            else result = TOK.int32Literal;
        } else if (flags === F_decimal) {
            if (n & 0x8000000000000000n) result = TOK.uns64Literal;
            else if (n & 0xffffffff80000000n) result = TOK.int64Literal;
            else result = TOK.int32Literal;
        } else if (flags === (F_octalhex | F_unsigned) || flags === (F_decimal | F_unsigned)) {
            if (n & 0xffffffff00000000n) result = TOK.uns64Literal;
            else result = TOK.uns32Literal;
        } else if (flags === (F_decimal | F_long)) {
            if (this.longsize === 4 || this.long_longsize === 4) {
                if (n & 0xffffffff80000000n) result = TOK.int64Literal;
                else result = TOK.int32Literal;
            } else {
                result = TOK.int64Literal;
            }
        } else if (flags === (F_octalhex | F_long)) {
            if (this.longsize === 4 || this.long_longsize === 4) {
                if (n & 0x8000000000000000n) result = TOK.uns64Literal;
                else if (n & 0xffffffff00000000n) result = TOK.int64Literal;
                else if (n & 0x80000000n) result = TOK.uns32Literal;
                else result = TOK.int32Literal;
            } else {
                if (n & 0x8000000000000000n) result = TOK.uns64Literal;
                else result = TOK.int64Literal;
            }
        } else if (flags === (F_octalhex | F_unsigned | F_long) || flags === (F_decimal | F_unsigned | F_long)) {
            if (this.longsize === 4 || this.long_longsize === 4) {
                if (n & 0xffffffff00000000n) result = TOK.uns64Literal;
                else result = TOK.uns32Literal;
            } else {
                result = TOK.uns64Literal;
            }
        } else if (flags === (F_octalhex | F_long | F_llong)) {
            if (n & 0x8000000000000000n) result = TOK.uns64Literal;
            else result = TOK.int64Literal;
        } else if (flags === (F_decimal | F_long | F_llong)) {
            result = TOK.int64Literal;
        } else if (
            flags === (F_octalhex | F_long | F_unsigned | F_llong) ||
            flags === (F_decimal | F_long | F_unsigned | F_llong)
        ) {
            result = TOK.uns64Literal;
        } else if (
            flags === (F_octalhex | F_i8) ||
            flags === (F_octalhex | F_i16) ||
            flags === (F_octalhex | F_i32) ||
            flags === (F_octalhex | F_unsigned | F_i8) ||
            flags === (F_octalhex | F_unsigned | F_i16) ||
            flags === (F_octalhex | F_unsigned | F_i32) ||
            flags === (F_decimal | F_unsigned | F_i8) ||
            flags === (F_decimal | F_unsigned | F_i16) ||
            flags === (F_decimal | F_unsigned | F_i32)
        ) {
            result = TOK.uns32Literal;
        } else if (flags === (F_decimal | F_i8) || flags === (F_decimal | F_i16) || flags === (F_decimal | F_i32)) {
            result = TOK.int32Literal;
        } else if (
            flags === (F_octalhex | F_i64) ||
            flags === (F_octalhex | F_unsigned | F_i64) ||
            flags === (F_decimal | F_unsigned | F_i64)
        ) {
            result = TOK.uns64Literal;
        } else if (flags === (F_decimal | F_i64)) {
            result = TOK.int64Literal;
        } else {
            // debug printf("%x\n",flags); assert(0);
            return assertUnreachable();
        }
        return result;
    }

    /**************************************
     * Read in characters, converting them to real (lexer.d:2926).
     */
    private inreal(t: Token): TOK {
        // debug { assert(*p == '.' || isdigit(*p)); } -> OFF
        let isWellformedString = true;
        Lexer.stringbuffer.setsize(0);
        let pstart = this.p;
        let hex = false;
        let c: number = this.byteAt(this.p);
        this.p++;
        // Leading '0x'
        if (c === 0x30 /* '0' */) {
            c = this.byteAt(this.p);
            this.p++;
            if (c === 0x78 /* 'x' */ || c === 0x58 /* 'X' */) {
                hex = true;
                c = this.byteAt(this.p);
                this.p++;
            }
        }
        // Digits to left of '.'
        while (true) {
            if (c === 0x2e /* '.' */) {
                c = this.byteAt(this.p);
                this.p++;
                break;
            }
            if (isdigit(c) || (hex && isxdigit(c)) || c === 0x5f /* '_' */) {
                c = this.byteAt(this.p);
                this.p++;
                continue;
            }
            break;
        }
        // Digits to right of '.'
        while (true) {
            if (isdigit(c) || (hex && isxdigit(c)) || c === 0x5f /* '_' */) {
                c = this.byteAt(this.p);
                this.p++;
                continue;
            }
            break;
        }
        if (c === 0x65 /* 'e' */ || c === 0x45 /* 'E' */ || (hex && (c === 0x70 /* 'p' */ || c === 0x50 /* 'P' */))) {
            c = this.byteAt(this.p);
            this.p++;
            if (c === 0x2d /* '-' */ || c === 0x2b /* '+' */) {
                c = this.byteAt(this.p);
                this.p++;
            }
            let anyexp = false;
            while (true) {
                if (isdigit(c)) {
                    anyexp = true;
                    c = this.byteAt(this.p);
                    this.p++;
                    continue;
                }
                if (c === 0x5f /* '_' */) {
                    if (this.Ccompile) {
                        this.error(ds("embedded `_` in numeric literals not allowed"));
                    }
                    c = this.byteAt(this.p);
                    this.p++;
                    continue;
                }
                if (!anyexp) {
                    this.error(ds("missing exponent"));
                    isWellformedString = false;
                }
                break;
            }
        } else if (hex) {
            this.error(ds("exponent required for hex float"));
            isWellformedString = false;
        }
        --this.p;
        while (pstart < this.p) {
            if (this.byteAt(pstart) !== 0x5f /* '_' */) {
                Lexer.stringbuffer.writeByte(this.byteAt(pstart));
            }
            ++pstart;
        }
        Lexer.stringbuffer.writeByte(0);
        const sbuf = Lexer.stringbuffer.opSliceAll(); // const(char)* sbufptr = stringbuffer[].ptr
        const sbufptr = cstr(sbuf); // the C-string view (up to the trailing NUL)
        let result: TOK;
        let isOutOfRange = false;
        if (isWellformedString) {
            const parsed = CTFloat.parse(sbufptr);
            t.floatvalue = parsed.value;
            isOutOfRange = parsed.isOutOfRange;
        } else {
            t.floatvalue = CTFloat.zero;
        }

        let imaginary = false;
        if (this.byteAt(this.p) === 0x69 /* 'i' */ && this.Ccompile) {
            ++this.p;
            imaginary = true;
        }

        switch (this.byteAt(this.p)) {
            case 0x46 /* 'F' */:
            case 0x66 /* 'f' */:
                if (isWellformedString && !isOutOfRange) {
                    isOutOfRange = Port.isFloat32LiteralOutOfRange(sbufptr);
                }
                result = TOK.float32Literal;
                this.p++;
                break;
            case 0x6c /* 'l' */:
                if (!this.Ccompile) {
                    this.error(ds("use 'L' suffix instead of 'l'"));
                }
                // goto case 'L';
                ++this.p;
                // resolved: version(IN_LLVM) {} else { if (Ccompile && long_doublesize==8) goto default; }
                //   -> IN_LLVM branch is empty (always map C long double -> real). C-double fallback dropped.
                result = TOK.float80Literal;
                break;
            case 0x4c /* 'L' */:
                ++this.p;
                result = TOK.float80Literal;
                break;
            default:
                if (isWellformedString && !isOutOfRange) {
                    isOutOfRange = Port.isFloat64LiteralOutOfRange(sbufptr);
                }
                result = TOK.float64Literal;
                break;
        }

        if ((this.byteAt(this.p) === 0x69 /* 'i' */ || this.byteAt(this.p) === 0x49 /* 'I' */) && !this.Ccompile) {
            if (this.byteAt(this.p) === 0x49 /* 'I' */) {
                this.error(ds("use 'i' suffix instead of 'I'"));
            }
            this.p++;
            imaginary = true;
        }

        if (imaginary) {
            switch (result) {
                case TOK.float32Literal:
                    result = TOK.imaginary32Literal;
                    break;
                case TOK.float64Literal:
                    result = TOK.imaginary64Literal;
                    break;
                case TOK.float80Literal:
                    result = TOK.imaginary80Literal;
                    break;
                default:
                    break;
            }
        }
        const isLong = result === TOK.float80Literal || result === TOK.imaginary80Literal;
        if (isOutOfRange && !isLong && (!this.Ccompile || hex)) {
            // C11 6.4.4.2 doesn't care if not representable when not hex
            const suffix =
                result === TOK.float32Literal ? ds("f") : result === TOK.float80Literal ? ds("L") : ds("");
            const typeStr =
                result === TOK.float32Literal
                    ? ds("`float`")
                    : result === TOK.float64Literal
                      ? ds("`double`")
                      : result === TOK.float80Literal
                        ? ds("`real` for the current target")
                        : ds("");
            this.errorLoc(this.scanloc, ds("number `%s%s` is not representable as a %s"), sbufptr, suffix, typeStr);
            const extra =
                result === TOK.float64Literal
                    ? ds("`real` literals can be written using the `L` suffix. ")
                    : ds("");
            this.eSink.errorSupplemental(this.scanloc, ds("%shttps://dlang.org/spec/lex.html#floatliteral"), extra);
        }
        // debug { switch (result) { float kinds: break; default: assert(0); } } -> OFF
        return result;
    }

    /// (lexer.d:3114) `loc` — set `scanloc` to the location for the current `p`, and return it.
    loc(): Loc {
        this.scanloc = this.baseLoc!.getLoc(toUint32(this.p - this.base)); // cast(uint)(p - base)
        return this.scanloc;
    }

    /**
     * Diagnostic forwarders (lexer.d:3120-3153). D has overloaded `error(format, args...)` and
     * `error(loc, format, args...)` C-variadic templates; per 04 §1A they distinguish by the first
     * argument type. Renamed: `error(format, ...)` uses `token.loc`; `errorLoc(loc, format, ...)`
     * takes an explicit loc. `format` is byte-identical to upstream (10 §3.5).
     */
    error(format: DString, ...args: unknown[]): void {
        this.eSink.error(this.token.loc, format, ...args);
    }

    errorLoc(loc: Loc, format: DString, ...args: unknown[]): void {
        this.eSink.error(loc, format, ...args);
    }

    errorSupplemental(format: DString, ...args: unknown[]): void {
        this.eSink.errorSupplemental(this.token.loc, format, ...args);
    }

    deprecationLoc(loc: Loc, format: DString, ...args: unknown[]): void {
        this.eSink.deprecation(loc, format, ...args);
    }

    warning(loc: Loc, format: DString, ...args: unknown[]): void {
        this.eSink.warning(loc, format, ...args);
    }

    deprecation(format: DString, ...args: unknown[]): void {
        this.eSink.deprecation(this.token.loc, format, ...args);
    }

    deprecationSupplemental(format: DString, ...args: unknown[]): void {
        this.eSink.deprecationSupplemental(this.token.loc, format, ...args);
    }

    /***************************************
     * Parse special token sequence (lexer.d:3162).
     */
    parseSpecialTokenSequence(): boolean {
        const n = new Token();
        this.scan(n);
        if (n.value === TOK.identifier) {
            if (n.ident === Id.line) {
                this.poundLine(n, false);
                return true;
            } else {
                const locx = this.loc();
                // @@@DEPRECATED_2.103@@@ Turn into an error in 2.113
                if (this.inTokenStringConstant) {
                    this.deprecationLoc(locx, ds("token string requires valid D tokens, not `#%s`"), cstr(n.ident!.toChars()));
                } else {
                    this.errorLoc(locx, ds("C preprocessor directive `#%s` is not supported"), cstr(n.ident!.toChars()));
                }
            }
        } else if (n.value === TOK.if_) {
            const locx = this.loc();
            if (this.inTokenStringConstant) {
                this.errorLoc(locx, ds("token string requires valid D tokens, not `#if`"));
            } else {
                this.errorLoc(
                    locx,
                    ds("C preprocessor directive `#if` is not supported, use `version` or `static if`"),
                );
            }
        }
        return false;
    }

    /*********************************************
     * Parse line/file preprocessor directive (lexer.d:3209).
     *    #line linnum [filespec]
     */
    poundLine(tok: Token, linemarker: boolean): void {
        let filespec: DString | null = null;
        let flags = false;

        if (!linemarker) {
            this.scan(tok);
        }
        if (tok.value === TOK.int32Literal || tok.value === TOK.int64Literal) {
            const lin = toInt32(Number(tok.unsvalue)); // cast(int)(tok.unsvalue)
            if (BigInt(lin) !== toUint64(tok.unsvalue)) {
                this.errorLoc(tok.loc, ds("line number `%lld` out of range"), toUint64(tok.unsvalue));
                this.skipToNextLine();
                return;
            } else {
                this.linnum = lin;
            }
        } else if (tok.value === TOK.line) {
            // #line __LINE__
        } else {
            this.errorLoc(tok.loc, ds("positive integer argument expected following `#line`"));
            if (tok.value !== TOK.endOfLine) {
                this.skipToNextLine();
            }
            return;
        }
        while (true) {
            this.scan(tok);
            // `scan(tok)` re-sets `tok.value`; the cast defeats the narrowing TS inferred from the
            // earlier `tok.value === TOK.int32Literal/...` checks above (the value is now arbitrary).
            switch (tok.value as TOK) {
                case TOK.endOfFile:
                case TOK.endOfLine:
                    if (!this.inTokenStringConstant) {
                        this.baseLoc!.addSubstitution(toUint32(this.p - this.base), filespec, this.linnum);
                    }
                    return;
                case TOK.file:
                    if (filespec || flags) {
                        return this.poundLineErr(tok, filespec, linemarker);
                    }
                    filespec = mem.xstrdup(this.scanloc.filename());
                    continue;
                case TOK.string_:
                    if (filespec || flags) {
                        return this.poundLineErr(tok, filespec, linemarker);
                    }
                    if (this.tokenPtrByte(tok, 0) !== 0x22 /* '"' */ || tok.postfix !== 0) {
                        return this.poundLineErr(tok, filespec, linemarker);
                    }
                    filespec = tok.ustring;
                    continue;
                case TOK.int32Literal:
                    if (!filespec) {
                        return this.poundLineErr(tok, filespec, linemarker);
                    }
                    if (linemarker && tok.unsvalue >= 1n && tok.unsvalue <= 4n) {
                        flags = true; // linemarker flags seen
                        continue;
                    }
                    return this.poundLineErr(tok, filespec, linemarker);
                default:
                    return this.poundLineErr(tok, filespec, linemarker);
            }
        }
    }

    /// The `Lerr:` tail of poundLine (lexer.d:3275).
    private poundLineErr(tok: Token, filespec: DString | null, linemarker: boolean): void {
        if (filespec === null) {
            this.errorLoc(tok.loc, ds("invalid filename for `#line` directive"));
        } else if (linemarker) {
            this.errorLoc(tok.loc, ds("invalid flag for line marker directive"));
        } else if (!this.Ccompile) {
            this.errorLoc(tok.loc, ds("found `%s` when expecting new line following `#line` directive"), cstr(tok.toChars()));
        }
        if (tok.value !== TOK.endOfLine) {
            this.skipToNextLine();
        }
    }

    /***************************************
     * Scan forward to start of next line (lexer.d:3291). `defines` collects bytes when non-null.
     */
    skipToNextLine(defines: OutBuffer | null = null): void {
        while (true) {
            let brk = false;
            switch (this.byteAt(this.p)) {
                case 0:
                case 0x1a:
                    return; // do not advance p
                case 0x0a /* '\n' */:
                    ++this.p;
                    brk = true;
                    break;
                case 0x0d /* '\r' */:
                    ++this.p;
                    if (this.byteAt(this.p) === 0x0a /* '\n' */) {
                        ++this.p;
                    }
                    brk = true;
                    break;
                default:
                    if (defines) {
                        defines.writeByte(this.byteAt(this.p)); // don't care about Unicode line endings for C
                    } else if (this.byteAt(this.p) & 0x80) {
                        const u = this.decodeUTF();
                        if (u === PS || u === LS) {
                            ++this.p;
                            brk = true;
                            break;
                        }
                    }
                    ++this.p;
                    continue;
            }
            void brk;
            break;
        }
        this.endOfLine();
        this.tokenizeNewlines = false;
    }

    /********************************************
     * Decode UTF character (lexer.d:3337). Issue error messages for invalid sequences.
     * Returns decoded character, advances p to last character in UTF sequence.
     */
    private decodeUTF(): number {
        const r = this.decodeUTFpure();
        if (r.msg) {
            this.errorLoc(this.token.loc, ds("%.*s"), r.msg.length, r.msg);
        }
        return r.result;
    }

    /********************************************
     * Same as above, but stores the potential error message instead of issuing it (lexer.d:3351).
     * `out string msg` -> returned in the result object.
     */
    private decodeUTFpure(): { result: number; msg: DString | null } {
        const s = this.p;
        assert((this.byteAt(s) & 0x80) !== 0);
        // Check length of remaining string up to 4 UTF-8 characters
        let len: number;
        for (len = 1; len < 4 && this.byteAt(s + len); len++) {
            // empty
        }
        // utf_decodeChar(s[0 .. len], idx=0, out u); D's idx is in/out; the djs API returns nextIdx.
        const r = utf_decodeChar(this.buf.subarray(s, s + len), 0);
        const u = r.dchar;
        let msg: DString | null = r.error;
        this.p += r.nextIdx - 1; // p += idx - 1
        if (!msg && isBidiControl(u)) {
            msg = ds("Bidirectional control characters are disallowed for security reasons.");
        }
        return { result: u, msg };
    }

    /***************************************************
     * Parse doc comment embedded between t.ptr and p (lexer.d:3380).
     */
    private getDocComment(t: Token, lineComment: number, newParagraph: boolean): void {
        // ct tells us which kind of comment it is: '/', '*', or '+'
        const ct = this.tokenPtrByte(t, 2);
        // Start of comment text skips over / * *, / + +, or / / /
        const ptrStart = this.tokenPtrOffset(t);
        let q = ptrStart + 3; // start of comment text
        let qend = this.p;
        if (ct === 0x2a /* '*' */ || ct === 0x2b /* '+' */) {
            qend -= 2;
        }
        // Scan over initial row of ****'s or ++++'s or ////'s
        for (; q < qend; q++) {
            if (this.byteAt(q) !== ct) {
                break;
            }
        }
        // Remove leading line feed or space
        let linestart = 0;
        if (ct === 0x2f /* '/' */) {
            if (q < qend && this.byteAt(q) === 0x20 /* ' ' */) {
                ++q;
            }
        } else if (q < qend) {
            if (this.byteAt(q) === 0x0d /* '\r' */) {
                ++q;
                if (q < qend && this.byteAt(q) === 0x0a /* '\n' */) {
                    ++q;
                }
                linestart = 1;
            } else if (this.byteAt(q) === 0x0a /* '\n' */) {
                ++q;
                linestart = 1;
            }
        }
        // Remove trailing row of ****'s or ++++'s
        if (ct !== 0x2f /* '/' */) {
            for (; q < qend; qend--) {
                if (this.byteAt(qend - 1) !== ct) {
                    break;
                }
            }
        }
        // Comment is now [q .. qend]. Canonicalize into buf[].
        const buf = new OutBuffer();

        const trimTrailingWhitespace = (): void => {
            const s = buf.opSliceAll();
            let len = s.length;
            while (len && (s[len - 1] === 0x20 /* ' ' */ || s[len - 1] === 0x09 /* '\t' */)) {
                --len;
            }
            buf.setsize(len);
        };

        for (; q < qend; q++) {
            let c: number = this.byteAt(q);
            let toLnewline = false;
            switch (c) {
                case 0x2a /* '*' */:
                case 0x2b /* '+' */:
                    if (linestart && c === ct) {
                        linestart = 0;
                        // Trim preceding whitespace up to preceding \n
                        trimTrailingWhitespace();
                        continue;
                    }
                    break;
                case 0x20 /* ' ' */:
                case 0x09 /* '\t' */:
                    break;
                case 0x0d /* '\r' */:
                    if (this.byteAt(q + 1) === 0x0a /* '\n' */) {
                        continue; // skip the \r
                    }
                    toLnewline = true; // goto Lnewline;
                    break;
                default:
                    if (c === 226) {
                        // If LS or PS
                        if (this.byteAt(q + 1) === 128 && (this.byteAt(q + 2) === 168 || this.byteAt(q + 2) === 169)) {
                            q += 2;
                            toLnewline = true; // goto Lnewline;
                            break;
                        }
                    }
                    linestart = 0;
                    break;
            }
            if (toLnewline) {
                // Lnewline:
                c = 0x0a; // replace all newlines with \n -> goto case '\n';
                linestart = 1;
                trimTrailingWhitespace();
            } else if (c === 0x0a /* '\n' */) {
                linestart = 1;
                trimTrailingWhitespace();
            }
            buf.writeByte(c);
        }
        // Trim trailing whitespace (if the last line does not have newline)
        trimTrailingWhitespace();

        // Always end with a newline
        const s = buf.opSliceAll();
        if (s.length === 0 || s[s.length - 1] !== 0x0a /* '\n' */) {
            buf.writeByte(0x0a);
        }

        // It's a line comment if the doc comment comes after other non-whitespace on the same line.
        const isLineComment = lineComment && this.anyToken;
        const existing = isLineComment ? t.lineComment : t.blockComment;
        // Combine with previous doc comment, if any
        if (existing) {
            const p = Lexer.combineComments(existing, buf.opSliceAll(), newParagraph);
            const combined = p ? p : null;
            if (isLineComment) {
                t.lineComment = combined;
            } else {
                t.blockComment = combined;
            }
        } else {
            const extracted = buf.extractSlice(true);
            if (isLineComment) {
                t.lineComment = extracted;
            } else {
                t.blockComment = extracted;
            }
        }
    }

    /********************************************
     * Combine two document comments into one (lexer.d:3518), separated by an extra newline if
     * newParagraph is true. Returns the combined byte-slice (D returns a `const(char)*`).
     */
    static combineComments(c1: DString | null, c2: DString | null, newParagraph: boolean): DString | null {
        const newParagraphSize = newParagraph ? 1 : 0; // size of the combining '\n'
        if (!c1) {
            return c2;
        }
        if (!c2) {
            return c1;
        }

        let insertNewLine = 0;
        if (c1.length && c1[c1.length - 1] !== 0x0a /* '\n' */) {
            insertNewLine = 1;
        }
        const retSize = c1.length + insertNewLine + newParagraphSize + c2.length;
        // erased: mem.xmalloc_noscan -> a fresh JS-owned buffer (08 §13). NUL-terminated like D.
        const p = new Uint8Array(retSize + 1);
        p.set(c1.subarray(0, c1.length), 0); // p[0 .. c1.length] = c1[]
        if (insertNewLine) {
            p[c1.length] = 0x0a;
        }
        if (newParagraph) {
            p[c1.length + insertNewLine] = 0x0a;
        }
        p.set(c2.subarray(0, c2.length), retSize - c2.length); // p[retSize - c2.length .. retSize] = c2[]
        p[retSize] = 0;
        return p.subarray(0, retSize); // D returns the NUL-terminated string; callers slice to strlen
    }

    /**************************
     * `p` should be at start of next line (lexer.d:3545, `endOfLine`).
     */
    private endOfLine(): void {
        this.linnum += 1;
        this.line = this.p;
        this.baseLoc!.newLine(toUint32(this.p - this.base));
    }

    /****************************
     * Print the tokens from the current `token` to the end (lexer.d:3557, `printRestOfTokens`).
     * Debugging aid; prints via the host stdout. Kept for surface fidelity.
     */
    printRestOfTokens(): void {
        let tk: Token = this.token;
        while (true) {
            process.stdout.write(cstr(tk.toChars())); // lexer.d:3568 `printf("%s ")`: the bytes before the NUL
            process.stdout.write(" ");
            if (tk.value === TOK.endOfFile || tk.value === TOK.endOfLine) {
                break;
            }
            tk = this.peek(tk);
        }
        process.stdout.write("\n");
    }

    /// @internal Faithful-but-vestigial state accessors. `line` (start-of-line offset) is WRITTEN by
    /// `endOfLine` but never READ in lexer.d (it is dead in upstream too — kept for structural
    /// fidelity). `whitespaceToken` is only consumed by the `version(DMDLIB)` scan branches, which
    /// resolve OFF (_config.md) and are dropped. Exposed here so the fields are retained without
    /// tripping `noUnusedLocals`; not part of the lexer's observable contract.
    lineStartOffset_(): number {
        return this.line;
    }
    whitespaceToken_(): boolean {
        return this.whitespaceToken;
    }
}

// ── free helpers (no `this`) ────────────────────────────────────────────────────────────────────

/// Copy all value-semantics fields of `src` into `dst` in place (D `memcpy(&dst, &src, Token.sizeof)`
/// / `*token = Token.init`). The Token model holds its payload inline (the `intUnsValue` carrier,
/// float, slices, refs), so a whole-struct overwrite is a field-by-field copy from a freshly-copied
/// source.
function copyTokenInto(dst: Token, src: Token): void {
    const c = src.copy();
    dst.next = c.next;
    dst.loc = c.loc;
    dst.ptr = c.ptr;
    dst.value = c.value;
    dst.blockComment = c.blockComment;
    dst.lineComment = c.lineComment;
    dst.unsvalue = c.unsvalue; // copies the shared 64-bit carrier (and thus intvalue too)
    dst.floatvalue = c.floatvalue;
    dst.ustring = c.ustring;
    dst.interpolatedSet = c.interpolatedSet;
    dst.len = c.len;
    dst.postfix = c.postfix;
    dst.ident = c.ident;
}

// C-string `%s`-argument views use the canonical `cstr` from dstring.ts (resolution #4 / 02 §11):
// every call site passes a non-null `DString` from `.toChars()`/`opSliceAll()`, so the local
// null-guarding wrapper is gone — `cstr` returns the bytes before the first NUL (the C-string view).

// ── core.checkedint (mulu / addu) — overflow-checked 64-bit unsigned arithmetic ─────────────────
// D `import core.checkedint : mulu, addu;` (lexer.d:2521). The carrier is `ulong` -> bigint (09 §0).
// Each returns the 64-bit-truncated value and whether the operation overflowed past 2^64-1. VERIFIED
// (ldc2 /tmp/lexprobe.d): 0xFFFF...FF * 10 + 5 overflows.

/// `ulong mulu(ulong x, ulong y, ref bool overflow)` — wrapped to return value+overflow.
function mulu(x: bigint, y: bigint): { value: bigint; overflow: boolean } {
    const full = x * y;
    const value = toUint64(full);
    return { value, overflow: full > 0xffffffffffffffffn };
}

/// `ulong addu(ulong x, ulong y, ref bool overflow)`.
function addu(x: bigint, y: bigint): { value: bigint; overflow: boolean } {
    const full = x + y;
    const value = toUint64(full);
    return { value, overflow: full > 0xffffffffffffffffn };
}
